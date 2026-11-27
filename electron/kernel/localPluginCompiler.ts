import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { protocol } from 'electron';
import * as esbuild from 'esbuild';
import type {
  Disposer,
  HostPluginModule,
  PluginErrorRecord,
  PluginManifest,
} from '../../src/kernel/shared/types';

export const DESK_APP_SCHEME = 'desk-app';
export const DESK_PLUGIN_SCHEME = 'desk-plugin';

export const SHARED_HOST_SPECIFIERS = new Set([
  'react',
  'react-dom',
  'react-dom/client',
  'react/jsx-runtime',
  'react/jsx-dev-runtime',
  'zustand',
  'lucide-react',
  '@agy-desk/kernel',
]);

/** Static fallback named export lists until Renderer pushes live `Object.keys(__DESK_SHARED__[pkg])` */
const FALLBACK_SHARED_EXPORTS: Record<string, string[]> = {
  react: [
    'Children',
    'Component',
    'Fragment',
    'Profiler',
    'PureComponent',
    'StrictMode',
    'Suspense',
    'act',
    'cache',
    'cloneElement',
    'createContext',
    'createElement',
    'createRef',
    'forwardRef',
    'isValidElement',
    'lazy',
    'memo',
    'startTransition',
    'use',
    'useActionState',
    'useCallback',
    'useContext',
    'useDebugValue',
    'useDeferredValue',
    'useEffect',
    'useId',
    'useImperativeHandle',
    'useInsertionEffect',
    'useLayoutEffect',
    'useMemo',
    'useOptimistic',
    'useReducer',
    'useRef',
    'useState',
    'useSyncExternalStore',
    'useTransition',
    'version',
  ],
  'react/jsx-runtime': ['Fragment', 'jsx', 'jsxs'],
  'react/jsx-dev-runtime': ['Fragment', 'jsxDEV'],
  'react-dom': ['createPortal', 'flushSync', 'preconnect', 'prefetchDNS', 'preinit', 'preload', 'version'],
  'react-dom/client': ['createRoot', 'hydrateRoot'],
  zustand: ['create', 'createStore', 'useStore'],
  'lucide-react': [],
  '@agy-desk/kernel': [
    'SlotOutlet',
    'PluginErrorBoundary',
    'SchemaSettingsForm',
    'useLayoutStore',
    'useSlotRegistry',
    'useIntrospectionStore',
    'BUILTIN_PLUGIN_IDS',
    'PANE_WIDGET_ANCHORS',
  ],
};

const VALID_JS_IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const RESERVED_JS_WORDS = new Set([
  'default',
  'delete',
  'export',
  'import',
  'class',
  'function',
  'return',
  'var',
  'let',
  'const',
  'new',
  'switch',
  'case',
  'break',
  'continue',
  'try',
  'catch',
  'finally',
  'throw',
  'in',
  'instanceof',
  'typeof',
  'void',
  'with',
  'yield',
  'await',
]);

const LOCAL_IMAGE_MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
};

const MAX_LOCAL_IMAGE_BYTES = 50 * 1024 * 1024;

function serveLocalImageRequest(urlObj: URL, corsHeaders: Record<string, string>): Response {
  const rawPath = urlObj.searchParams.get('path') || '';
  const trimmed = rawPath.trim();
  if (!trimmed || trimmed.includes('\0')) {
    return new Response('Invalid image path', { status: 400, headers: corsHeaders });
  }
  const expanded = trimmed.startsWith('~/')
    ? path.join(os.homedir(), trimmed.slice(2))
    : trimmed;
  if (!path.isAbsolute(expanded)) {
    return new Response('Absolute path required', { status: 400, headers: corsHeaders });
  }
  const resolved = path.resolve(expanded);
  const ext = path.extname(resolved).toLowerCase();
  const mime = LOCAL_IMAGE_MIME_BY_EXT[ext];
  if (!mime) {
    return new Response('Unsupported media type', { status: 403, headers: corsHeaders });
  }
  try {
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) {
      return new Response('Not a file', { status: 404, headers: corsHeaders });
    }
    if (stat.size > MAX_LOCAL_IMAGE_BYTES) {
      return new Response('Image too large', { status: 413, headers: corsHeaders });
    }
    const bytes = fs.readFileSync(resolved);
    return new Response(bytes, {
      status: 200,
      headers: {
        ...corsHeaders,
        'Content-Type': mime,
        'Cache-Control': 'private, max-age=60',
      },
    });
  } catch {
    return new Response('Not found', { status: 404, headers: corsHeaders });
  }
}

const MIME_BY_EXT: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
};

export interface CompiledClientBundle {
  readonly revHash: string;
  readonly code: string;
  readonly cssText: string;
  readonly compiledAt: number;
  readonly durationMs: number;
}

export interface CompiledHostBundle {
  readonly revHash: string;
  readonly code: string;
  readonly compiledAt: number;
  readonly durationMs: number;
}

interface MountedPluginCompileState {
  pluginId: string;
  rootPath: string;
  realRootPath: string;
  manifest: PluginManifest;
  currentClient: CompiledClientBundle | null;
  lastGoodClient: CompiledClientBundle | null;
  currentHost: CompiledHostBundle | null;
  lastGoodHost: CompiledHostBundle | null;
  watcher: fs.FSWatcher | null;
  watchTimer: ReturnType<typeof setTimeout> | null;
}

/**
 * Must be called BEFORE `app.whenReady()` in Electron Main!
 * Registers privileged schemes so dynamic ESM `import('desk-plugin://...')` works
 * cleanly under `sandbox: true` + `contextIsolation: true` without `unsafe-eval`.
 */
export function registerKernelProtocolSchemes(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: DESK_APP_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
    },
    {
      scheme: DESK_PLUGIN_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
    },
  ]);
}

function isInsideRoot(realRoot: string, candidatePath: string): string | null {
  try {
    const realTarget = fs.realpathSync(candidatePath);
    const rel = path.relative(realRoot, realTarget);
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
      return realTarget;
    }
    return null;
  } catch {
    return null;
  }
}

function formatEsbuildError(err: unknown, phase: PluginErrorRecord['phase']): PluginErrorRecord {
  const anyErr = err as {
    message?: string;
    stack?: string;
    errors?: Array<{ text?: string; location?: { file?: string; line?: number; column?: number } | null }>;
  };
  const first = anyErr?.errors?.[0];
  const fileLocation = first?.location?.file
    ? `${path.basename(first.location.file)}:${first.location.line ?? 0}:${first.location.column ?? 0}`
    : undefined;
  return {
    id: `err-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    timestamp: Date.now(),
    phase,
    message: first?.text || anyErr?.message || String(err),
    fileLocation,
    stack: anyErr?.stack,
  };
}

function shortHash(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 10);
}

/**
 * On-demand esbuild compiler + `desk-plugin://` & `desk-app://` protocol server
 * + Compile-Before-Swap local plugin watcher.
 *
 * Implements critic #12-4, #12-7, #12-8, #13-5:
 * - Rewrites bare shared specifiers (React 19, Zustand, Lucide, @agy-desk/kernel) to
 *   `desk-plugin://__host__/<pkg>.mjs` with explicit named exports (zero duplicate React / SyntaxError).
 * - Host bundles compile to CJS in memory and execute via `vm.Script` (zero Node ESM cache leak!).
 * - Strict `fs.realpathSync` + `path.relative` jail prevents path traversal & symlink escapes.
 * - Compile-Before-Swap keeps running plugins alive if edited source has syntax/type errors.
 */
export class LocalPluginCompiler {
  private mounted = new Map<string, MountedPluginCompileState>();
  private sharedExportMap: Record<string, string[]> = { ...FALLBACK_SHARED_EXPORTS };
  private protocolAttached = false;

  /** Renderer reports live `Object.keys(window.__DESK_SHARED__[pkg])` on boot so all named exports match 100% */
  updateSharedExportMap(map: Record<string, string[]>): void {
    for (const [spec, keys] of Object.entries(map)) {
      if (!SHARED_HOST_SPECIFIERS.has(spec) || !Array.isArray(keys)) continue;
      this.sharedExportMap[spec] = keys.filter(
        (k) => typeof k === 'string' && VALID_JS_IDENT_RE.test(k) && !RESERVED_JS_WORDS.has(k)
      );
    }
  }

  /** Inspect a directory (following symlinks per critic #13-5) and parse `desk-plugin.json` */
  readLocalManifest(dirPath: string): { ok: true; manifest: PluginManifest; realRoot: string } | { ok: false; error: string } {
    try {
      const resolved = path.resolve(dirPath.replace(/^~(?=\/|$)/, process.env.HOME || ''));
      const stat = fs.statSync(resolved); // follows symlinks
      if (!stat.isDirectory()) {
        return { ok: false, error: `Not a directory: ${resolved}` };
      }
      const realRoot = fs.realpathSync(resolved);
      const deskManifestPath = path.join(realRoot, 'desk-plugin.json');
      const fallbackManifestPath = path.join(realRoot, 'manifest.json');
      const manifestPath = fs.existsSync(deskManifestPath)
        ? deskManifestPath
        : fs.existsSync(fallbackManifestPath)
          ? fallbackManifestPath
          : null;
      if (!manifestPath) {
        return { ok: false, error: `desk-plugin.json (or manifest.json) not found in ${resolved}` };
      }
      const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Partial<PluginManifest>;
      if (!raw.id || !raw.name || !raw.version || !raw.entry) {
        return { ok: false, error: 'desk-plugin.json missing required fields (id, name, version, entry)' };
      }
      if (!/^[a-z0-9][a-z0-9-_]{1,48}$/.test(raw.id)) {
        return { ok: false, error: `Invalid plugin id "${raw.id}" (use lowercase kebab-case)` };
      }
      const manifest: PluginManifest = {
        id: raw.id,
        name: raw.name,
        version: raw.version,
        apiVersion: raw.apiVersion || '^1.0.0',
        description: raw.description || '',
        layer: raw.layer || 'app',
        category: raw.category || 'local-dev',
        icon: raw.icon,
        impactClass: raw.impactClass || 'instant',
        defaultEnabled: raw.defaultEnabled ?? true,
        locked: false,
        entry: raw.entry,
        requires: raw.requires || [],
        optionalRequires: raw.optionalRequires || [],
        provides: raw.provides || [],
        capabilities: raw.capabilities || [],
        configSchema: raw.configSchema || [],
        contributes: raw.contributes,
      };
      return { ok: true, manifest, realRoot };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  registerMount(pluginId: string, rootPath: string, realRootPath: string, manifest: PluginManifest): void {
    const existing = this.mounted.get(pluginId);
    if (existing) {
      existing.rootPath = rootPath;
      existing.realRootPath = realRootPath;
      existing.manifest = manifest;
      return;
    }
    this.mounted.set(pluginId, {
      pluginId,
      rootPath,
      realRootPath,
      manifest,
      currentClient: null,
      lastGoodClient: null,
      currentHost: null,
      lastGoodHost: null,
      watcher: null,
      watchTimer: null,
    });
  }

  unregisterMount(pluginId: string): void {
    const st = this.mounted.get(pluginId);
    if (!st) return;
    if (st.watchTimer) clearTimeout(st.watchTimer);
    st.watcher?.close();
    this.mounted.delete(pluginId);
  }

  hasLastGood(pluginId: string): boolean {
    const st = this.mounted.get(pluginId);
    return Boolean(st?.lastGoodClient || st?.lastGoodHost);
  }

  getClientModuleUrl(pluginId: string): string | null {
    const st = this.mounted.get(pluginId);
    if (!st || !st.currentClient) return null;
    return `${DESK_PLUGIN_SCHEME}://${encodeURIComponent(pluginId)}/client.mjs?rev=${st.currentClient.revHash}`;
  }

  /** Compile Client entry (.tsx/.ts/.jsx/.js) to browser ESM rewriting shared packages to `desk-plugin://__host__/*` */
  async compileClient(
    pluginId: string
  ): Promise<{ ok: true; bundle: CompiledClientBundle } | { ok: false; error: PluginErrorRecord }> {
    const st = this.mounted.get(pluginId);
    if (!st || !st.manifest.entry.client) {
      return {
        ok: false,
        error: formatEsbuildError(new Error(`No client entry for plugin "${pluginId}"`), 'compile'),
      };
    }

    const entryCandidate = path.resolve(st.realRootPath, st.manifest.entry.client);
    const safeEntry = isInsideRoot(st.realRootPath, entryCandidate);
    if (!safeEntry) {
      return {
        ok: false,
        error: formatEsbuildError(new Error(`Client entry escapes mount root: ${st.manifest.entry.client}`), 'compile'),
      };
    }

    const t0 = Date.now();
    try {
      let collectedCss = '';
      // Optional standalone stylesheet declared in manifest.entry.styles
      if (st.manifest.entry.styles) {
        const cssPath = isInsideRoot(st.realRootPath, path.resolve(st.realRootPath, st.manifest.entry.styles));
        if (cssPath && fs.existsSync(cssPath)) {
          collectedCss += fs.readFileSync(cssPath, 'utf8') + '\n';
        }
      }

      const hostExternalsPlugin: esbuild.Plugin = {
        name: 'desk-host-externals',
        setup(build) {
          build.onResolve({ filter: /^[^./]/ }, (args) => {
            if (SHARED_HOST_SPECIFIERS.has(args.path)) {
              return {
                path: `${DESK_PLUGIN_SCHEME}://__host__/${encodeURIComponent(args.path)}.mjs`,
                external: true,
              };
            }
            return undefined;
          });
          // Capture local `.css` imports so Tailwind v4 purging never strips external plugin styles
          build.onLoad({ filter: /\.css$/ }, (args) => {
            const safeCss = isInsideRoot(st.realRootPath, args.path);
            if (!safeCss) return { contents: '', loader: 'js' };
            const cssRaw = fs.readFileSync(safeCss, 'utf8');
            collectedCss += cssRaw + '\n';
            return { contents: 'export default undefined;', loader: 'js' };
          });
        },
      };

      const result = await esbuild.build({
        entryPoints: [safeEntry],
        bundle: true,
        write: false,
        format: 'esm',
        platform: 'browser',
        target: ['es2022', 'chrome126'],
        jsx: 'automatic',
        sourcemap: 'inline',
        plugins: [hostExternalsPlugin],
      });

      const jsOut = result.outputFiles.find((f) => !f.path.endsWith('.css'));
      if (!jsOut) {
        throw new Error('esbuild produced no JavaScript output');
      }

      // Wrap activate() so bundled CSS is injected & auto-cleaned via ctx.ui.injectStyle
      let code = jsOut.text;
      if (collectedCss.trim().length > 0) {
        code += `\nexport const __deskPluginCss = ${JSON.stringify(collectedCss)};\n`;
      }

      const revHash = shortHash(code);
      const bundle: CompiledClientBundle = {
        revHash,
        code,
        cssText: collectedCss,
        compiledAt: Date.now(),
        durationMs: Date.now() - t0,
      };

      if (st.currentClient) {
        st.lastGoodClient = st.currentClient;
      }
      st.currentClient = bundle;
      return { ok: true, bundle };
    } catch (err) {
      return { ok: false, error: formatEsbuildError(err, 'compile') };
    }
  }

  /**
   * Compile Host entry (.ts/.js) to Node CJS in memory and execute in an isolated module wrapper
   * (critic #12-8: avoids Node ESM `?rev=` permanent module-map memory leak!).
   */
  async compileAndLoadHost(
    pluginId: string
  ): Promise<{ ok: true; mod: HostPluginModule; bundle: CompiledHostBundle } | { ok: false; error: PluginErrorRecord }> {
    const st = this.mounted.get(pluginId);
    if (!st || !st.manifest.entry.host) {
      return {
        ok: false,
        error: formatEsbuildError(new Error(`No host entry for plugin "${pluginId}"`), 'compile'),
      };
    }

    const entryCandidate = path.resolve(st.realRootPath, st.manifest.entry.host);
    const safeEntry = isInsideRoot(st.realRootPath, entryCandidate);
    if (!safeEntry) {
      return {
        ok: false,
        error: formatEsbuildError(new Error(`Host entry escapes mount root: ${st.manifest.entry.host}`), 'compile'),
      };
    }

    const t0 = Date.now();
    try {
      const result = await esbuild.build({
        entryPoints: [safeEntry],
        bundle: true,
        write: false,
        format: 'cjs',
        platform: 'node',
        target: 'node22',
        external: ['electron', 'esbuild'],
        sourcemap: 'inline',
      });

      const jsOut = result.outputFiles[0];
      if (!jsOut) throw new Error('esbuild produced no host output');

      const bundle: CompiledHostBundle = {
        revHash: shortHash(jsOut.text),
        code: jsOut.text,
        compiledAt: Date.now(),
        durationMs: Date.now() - t0,
      };

      const mod = this.evaluateHostCjs(st.realRootPath, safeEntry, bundle.code);
      if (typeof mod.activate !== 'function') {
        throw new Error('Host plugin module must export an `activate(ctx)` function');
      }

      if (st.currentHost) {
        st.lastGoodHost = st.currentHost;
      }
      st.currentHost = bundle;
      return { ok: true, mod, bundle };
    } catch (err) {
      return { ok: false, error: formatEsbuildError(err, 'compile') };
    }
  }

  /** Roll back to previous known-good compiled client/host bundle */
  rollback(pluginId: string): { ok: boolean; hostMod?: HostPluginModule; clientRev?: string } {
    const st = this.mounted.get(pluginId);
    if (!st || (!st.lastGoodClient && !st.lastGoodHost)) return { ok: false };

    let hostMod: HostPluginModule | undefined;
    if (st.lastGoodHost && st.manifest.entry.host) {
      const safeEntry = path.resolve(st.realRootPath, st.manifest.entry.host);
      hostMod = this.evaluateHostCjs(st.realRootPath, safeEntry, st.lastGoodHost.code);
      st.currentHost = st.lastGoodHost;
      st.lastGoodHost = null;
    }
    if (st.lastGoodClient) {
      st.currentClient = st.lastGoodClient;
      st.lastGoodClient = null;
    }
    return { ok: true, hostMod, clientRev: st.currentClient?.revHash };
  }

  /** Watch mounted local plugin folder with 120ms debounce for Compile-Before-Swap HMR */
  startWatching(
    pluginId: string,
    onFileChanged: (info: { pluginId: string; changedFile: string; target: 'client' | 'host' | 'both' }) => void
  ): Disposer {
    const st = this.mounted.get(pluginId);
    if (!st) return () => {};

    if (st.watcher) {
      st.watcher.close();
      st.watcher = null;
    }

    try {
      st.watcher = fs.watch(st.realRootPath, { recursive: true }, (_eventType, filename) => {
        if (!filename) return;
        if (filename.includes('node_modules') || filename.startsWith('.git')) return;
        if (st.watchTimer) clearTimeout(st.watchTimer);
        st.watchTimer = setTimeout(() => {
          const lower = filename.toLowerCase();
          let target: 'client' | 'host' | 'both' = 'both';
          const hostEntry = st.manifest.entry.host?.replace(/^\.\//, '');
          const clientEntry = st.manifest.entry.client?.replace(/^\.\//, '');
          if (lower.endsWith('.css') || (clientEntry && filename.endsWith(clientEntry))) {
            target = 'client';
          } else if (hostEntry && filename.endsWith(hostEntry)) {
            target = 'host';
          } else if (!st.manifest.entry.host) {
            target = 'client';
          } else if (!st.manifest.entry.client) {
            target = 'host';
          }
          onFileChanged({ pluginId, changedFile: filename, target });
        }, 120);
      });
    } catch (err) {
      console.warn(`[LocalPluginCompiler] Failed to watch ${st.realRootPath}:`, err);
    }

    return () => {
      if (st.watchTimer) {
        clearTimeout(st.watchTimer);
        st.watchTimer = null;
      }
      st.watcher?.close();
      st.watcher = null;
    };
  }

  /** Attach `desk-plugin://` (and optional `desk-app://`) Electron protocol handlers after `app.whenReady()` */
  attachProtocolHandlers(opts?: { appDistDir?: string }): void {
    if (this.protocolAttached) return;
    this.protocolAttached = true;

    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Cache-Control': 'no-store',
    };

    protocol.handle(DESK_PLUGIN_SCHEME, (request) => {
      try {
        const u = new URL(request.url);
        const host = decodeURIComponent(u.hostname);
        const pathname = decodeURIComponent(u.pathname);

        // 1) Host-shared singleton ESM proxy: desk-plugin://__host__/<pkg>.mjs
        if (host === '__host__') {
          const rawPkg = pathname.replace(/^\//, '').replace(/\.mjs$/, '');
          const pkg = decodeURIComponent(rawPkg);
          if (!SHARED_HOST_SPECIFIERS.has(pkg)) {
            return new Response(`// Unknown shared host module: ${pkg}`, { status: 404, headers: corsHeaders });
          }
          const code = this.buildHostProxyModule(pkg);
          return new Response(code, {
            status: 200,
            headers: { ...corsHeaders, 'Content-Type': 'text/javascript; charset=utf-8' },
          });
        }

        // 2) Mounted plugin compiled bundle or static asset (path-jailed!)
        const st = this.mounted.get(host);
        if (!st) {
          return new Response(`// Plugin not mounted: ${host}`, { status: 404, headers: corsHeaders });
        }

        if (pathname === '/client.mjs') {
          if (!st.currentClient) {
            return new Response('// Client bundle not compiled yet', { status: 404, headers: corsHeaders });
          }
          return new Response(st.currentClient.code, {
            status: 200,
            headers: { ...corsHeaders, 'Content-Type': 'text/javascript; charset=utf-8' },
          });
        }

        // Serve static asset strictly inside mount realRootPath (blocks `..` & symlink escape)
        const relAsset = pathname.replace(/^\/+/, '');
        const safePath = isInsideRoot(st.realRootPath, path.resolve(st.realRootPath, relAsset));
        if (!safePath || !fs.existsSync(safePath) || !fs.statSync(safePath).isFile()) {
          return new Response('Not found', { status: 404, headers: corsHeaders });
        }
        const ext = path.extname(safePath).toLowerCase();
        const bytes = fs.readFileSync(safePath);
        return new Response(bytes, {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': MIME_BY_EXT[ext] || 'application/octet-stream' },
        });
      } catch (err) {
        return new Response(`// Protocol error: ${String(err)}`, { status: 500, headers: corsHeaders });
      }
    });

    // App origin (`desk-app://app/...`) + safe local image streaming (`desk-app://local-media?path=...`)
    const distRealRoot =
      opts?.appDistDir && fs.existsSync(opts.appDistDir)
        ? fs.realpathSync(opts.appDistDir)
        : opts?.appDistDir || null;

    protocol.handle(DESK_APP_SCHEME, (request) => {
      try {
        const u = new URL(request.url);
        if (u.hostname === 'local-media') {
          return serveLocalImageRequest(u, corsHeaders);
        }
        if (!distRealRoot) {
          return new Response('Not found', { status: 404 });
        }
        const relPath = decodeURIComponent(u.pathname).replace(/^\/+/, '') || 'index.html';
        const safePath = isInsideRoot(distRealRoot, path.resolve(distRealRoot, relPath));
        if (!safePath || !fs.existsSync(safePath) || !fs.statSync(safePath).isFile()) {
          return new Response('Not found', { status: 404 });
        }
        const ext = path.extname(safePath).toLowerCase();
        return new Response(fs.readFileSync(safePath), {
          status: 200,
          headers: { 'Content-Type': MIME_BY_EXT[ext] || 'application/octet-stream' },
        });
      } catch (err) {
        return new Response(`App asset error: ${String(err)}`, { status: 500 });
      }
    });
  }

  private buildHostProxyModule(pkg: string): string {
    const keys = this.sharedExportMap[pkg] || FALLBACK_SHARED_EXPORTS[pkg] || [];
    const lines = [
      `const __m = globalThis.__DESK_SHARED__?.[${JSON.stringify(pkg)}];`,
      `if (!__m) throw new Error('[desk-plugin] Shared host module not initialized: ${pkg}');`,
      `export default __m.default ?? __m;`,
    ];
    for (const key of keys) {
      lines.push(`export const ${key} = __m[${JSON.stringify(key)}];`);
    }
    return lines.join('\n') + '\n';
  }

  private evaluateHostCjs(realRootPath: string, entryFile: string, code: string): HostPluginModule {
    const localRequire = createRequire(entryFile);
    const modObj: { exports: Record<string, unknown> } = { exports: {} };
    const wrapped = `(function(exports, require, module, __filename, __dirname) {\n${code}\n})`;
    const script = new vm.Script(wrapped, { filename: entryFile });
    const fn = script.runInThisContext() as (
      exports: Record<string, unknown>,
      require: NodeRequire,
      module: { exports: Record<string, unknown> },
      filename: string,
      dirname: string
    ) => void;
    fn(modObj.exports, localRequire, modObj, entryFile, realRootPath);

    const exported = modObj.exports as { default?: HostPluginModule } & Partial<HostPluginModule>;
    if (typeof exported.activate === 'function') {
      return exported as HostPluginModule;
    }
    if (exported.default && typeof exported.default.activate === 'function') {
      return exported.default;
    }
    return exported as HostPluginModule;
  }
}
