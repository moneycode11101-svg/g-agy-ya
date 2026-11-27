import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  nativeImage,
  Notification,
  powerSaveBlocker,
  session,
  shell,
  Tray,
  type MenuItemConstructorOptions,
} from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KernelServiceRegistry } from '../../src/kernel/shared/serviceRegistry';
import type {
  BootMode,
  BuiltinPluginPackage,
  ConfigNamespace,
  DeskHostContext,
  Disposer,
  HostPluginModule,
  KernelPluginLifecycleEvent,
  LocalPluginMount,
  PluginBootstrapBundle,
  PluginBootstrapItem,
  PluginCapability,
  PluginErrorRecord,
  PluginLifecycleState,
  PluginManifest,
  PluginNodeSnapshot,
  PluginOrigin,
  RuntimeAssetProvider,
  RuntimeAssetsProjection,
  SlotKind,
  TrayItemContribution,
} from '../../src/kernel/shared/types';
import { KernelConfigStore } from './configStore';
import { KernelEffectScope } from './effectScope';
import { KernelEventBus } from './eventBus';
import { LocalPluginCompiler } from './localPluginCompiler';
import { KernelRpcRouter } from './rpcRouter';
import { KernelWebviewSecurity } from './webviewSecurity';

const HOME = os.homedir();
const DATA_ROOT = path.join(HOME, '.gemini', 'antigravity', 'plugin-data');
const SENTINEL_PATH = path.join(HOME, '.gemini', 'antigravity', 'agy-desk-boot-sentinel.json');

interface BootSentinel {
  consecutiveFailedBoots: number;
  lastBootAt: number;
  suspectedPluginId: string | null;
}

interface HostPluginRecord {
  id: string;
  manifest: PluginManifest;
  origin: PluginOrigin;
  sourcePath: string | null;
  hostModule: HostPluginModule | null;
  hasClientHalf: boolean;
  lifecycleState: PluginLifecycleState;
  scope: KernelEffectScope | null;
  hostActive: boolean;
  clientActive: boolean;
  revHash: string;
  watchActive: boolean;
  watchDisposer: Disposer | null;
  activationMs: number | null;
  lastReloadMs: number | null;
  errorCount: number;
  crashTimestamps: number[];
  lastError: PluginErrorRecord | null;
  recentErrors: PluginErrorRecord[];
  activeOpenTabsCount: number;
  hiddenPreservedTabsCount: number;
  clientDisposableCount: number;
  occupiedSlots: Array<{ slotId: SlotKind; contributionId: string }>;
}

function makeErrorRecord(phase: PluginErrorRecord['phase'], err: unknown, slotId?: string): PluginErrorRecord {
  return {
    id: `err-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    timestamp: Date.now(),
    phase,
    message: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
    slotId,
  };
}

function buildDefaultTrayIcon() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><path d="M3.1 11.8 C4.6 9.3 6.0 2.7 8.0 2.7 C10.0 2.7 11.4 9.3 12.9 11.8 C13.2 12.3 12.5 12.6 12.0 12.2 C10.8 10.9 9.5 8.1 8.0 8.1 C6.5 8.1 5.2 10.9 4.0 12.2 C3.5 12.6 2.8 12.3 3.1 11.8 Z" fill="black"/><rect x="3.5" y="13.5" width="9" height="1.4" rx="0.7" fill="black"/></svg>`;
  const img = nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`);
  img.setTemplateImage(true);
  return img;
}

export interface HostPluginManagerDeps {
  readonly bus: KernelEventBus;
  readonly rpc: KernelRpcRouter;
  readonly config: KernelConfigStore;
  readonly webviewSecurity: KernelWebviewSecurity;
  readonly compiler: LocalPluginCompiler;
  readonly services: KernelServiceRegistry;
  readonly appDisplayName?: string;
  readonly getMainWindow: () => BrowserWindow | null;
  readonly createOrShowWindow?: () => void;
  readonly requestQuit?: () => void;
}

/**
 * Unified Host Plugin Manager for both Built-in & External Local Plugins.
 * Handles DAG dependency activation, reverse cascade suspension, EffectScope cleanup,
 * Safe Mode boot sentinel, 3-in-10s circuit breaker, RuntimeAssetProvider registry,
 * and Compile-Before-Swap local hot reload.
 */
export class HostPluginManager {
  readonly bootMode: BootMode;
  readonly safeModeContext?: {
    reason: 'boot-crash-loop' | 'cli-flag' | 'env-var' | 'manual';
    suspectedPluginId: string | null;
    crashCount: number;
  };

  private readonly deps: HostPluginManagerDeps;
  private readonly records = new Map<string, HostPluginRecord>();
  private readonly lifecycleListeners = new Set<(ev: KernelPluginLifecycleEvent) => void>();
  private readonly stateChangeListeners = new Set<(pluginId: string) => void>();
  private readonly runtimeAssetProviders = new Map<string, RuntimeAssetProvider>();
  private readonly runtimeAssetListeners = new Set<(adapterId: string, projection: RuntimeAssetsProjection) => void>();

  // Security gate: only paths explicitly picked via Main native dialog (or already in disk config) can mount
  private readonly approvedDialogPaths = new Set<string>();

  // Ref-counted OS primitives
  private powerSaveReasons = new Set<string>();
  private powerBlockerId: number | null = null;
  private tray: Tray | null = null;
  private trayEnabled = false;
  private trayItems = new Map<string, TrayItemContribution>();
  private windowFocusListeners = new Set<() => void>();
  private windowBeforeCloseListeners = new Set<(ev: { preventDefault: () => void; hideWindow: () => void }) => void>();
  private bootHealthyTimer: ReturnType<typeof setTimeout> | null = null;
  private quitting = false;

  markQuitting(): void {
    this.quitting = true;
  }

  constructor(deps: HostPluginManagerDeps) {
    this.deps = deps;

    const sentinel = this.readAndBumpSentinel();
    const cliSafe = process.argv.includes('--safe-mode');
    const envSafe = process.env.AGY_SAFE_MODE === '1';
    const cfgSafe = Boolean(this.deps.config.getDocument().safeMode);

    if (cliSafe || envSafe || cfgSafe || sentinel.consecutiveFailedBoots >= 2) {
      this.bootMode = 'safe-mode';
      this.safeModeContext = {
        reason: cliSafe ? 'cli-flag' : envSafe ? 'env-var' : cfgSafe ? 'manual' : 'boot-crash-loop',
        suspectedPluginId: sentinel.suspectedPluginId,
        crashCount: sentinel.consecutiveFailedBoots,
      };
    } else {
      this.bootMode = 'normal';
    }

    // Mark boot healthy after 4s of stable operation
    this.bootHealthyTimer = setTimeout(() => {
      this.clearBootSentinel();
    }, 4000);
  }

  onLifecycleEvent(cb: (ev: KernelPluginLifecycleEvent) => void): Disposer {
    this.lifecycleListeners.add(cb);
    return () => {
      this.lifecycleListeners.delete(cb);
    };
  }

  onPluginStateChange(cb: (pluginId: string) => void): Disposer {
    this.stateChangeListeners.add(cb);
    return () => {
      this.stateChangeListeners.delete(cb);
    };
  }

  onRuntimeAssetsUpdated(cb: (adapterId: string, projection: RuntimeAssetsProjection) => void): Disposer {
    this.runtimeAssetListeners.add(cb);
    return () => {
      this.runtimeAssetListeners.delete(cb);
    };
  }

  /** Hook BrowserWindow focus & before-close into plugin delegates */
  attachWindowEvents(win: BrowserWindow): Disposer {
    const onFocus = () => {
      for (const cb of this.windowFocusListeners) {
        try {
          cb();
        } catch (err) {
          console.error('[HostPluginManager] window focus listener error:', err);
        }
      }
    };
    const onClose = (ev: Electron.Event) => {
      if (this.quitting) return;
      for (const cb of this.windowBeforeCloseListeners) {
        try {
          cb({
            preventDefault: () => ev.preventDefault(),
            hideWindow: () => {
              if (!win.isDestroyed()) win.hide();
            },
          });
        } catch (err) {
          console.error('[HostPluginManager] window close listener error:', err);
        }
      }
    };
    win.on('focus', onFocus);
    win.on('close', onClose);
    return () => {
      if (!win.isDestroyed()) {
        win.removeListener('focus', onFocus);
        win.removeListener('close', onClose);
      }
    };
  }

  /** Register a built-in plugin using the exact same HostPluginRecord contract as external local plugins */
  registerBuiltin(pkg: BuiltinPluginPackage): void {
    this.deps.config.registerPluginSchema(pkg.manifest.id, pkg.manifest.configSchema);
    const rec: HostPluginRecord = {
      id: pkg.manifest.id,
      manifest: pkg.manifest,
      origin: 'builtin',
      sourcePath: null,
      hostModule: pkg.host || null,
      hasClientHalf: Boolean(pkg.client || pkg.manifest.entry.client),
      lifecycleState: 'discovered',
      scope: null,
      hostActive: false,
      clientActive: false,
      revHash: 'builtin',
      watchActive: false,
      watchDisposer: null,
      activationMs: null,
      lastReloadMs: null,
      errorCount: 0,
      crashTimestamps: [],
      lastError: null,
      recentErrors: [],
      activeOpenTabsCount: 0,
      hiddenPreservedTabsCount: 0,
      clientDisposableCount: 0,
      occupiedSlots: [],
    };
    this.records.set(pkg.manifest.id, rec);
  }

  /** Discover configured local mounts and activate all enabled plugins in topological DAG order */
  async bootAll(): Promise<void> {
    const doc = this.deps.config.getDocument();

    // Register local mounts from declarative config
    for (const mount of doc.mounts) {
      await this.registerLocalMountInternal(mount);
    }

    // Topological activation order
    const ordered = this.resolveTopologicalOrder(Array.from(this.records.keys()));
    for (const pluginId of ordered) {
      const rec = this.records.get(pluginId);
      if (!rec) continue;
      if (this.bootMode === 'safe-mode' && rec.origin !== 'builtin') {
        rec.lifecycleState = 'disabled';
        continue;
      }
      const enabled = this.deps.config.isPluginEnabled(pluginId, rec.manifest.defaultEnabled ?? true);
      if (!enabled && !rec.manifest.locked) {
        rec.lifecycleState = 'disabled';
        continue;
      }
      await this.activatePlugin(pluginId);
    }
  }

  /** Dynamically activate a plugin (plus any suspended dependents whose requires are now satisfied) */
  async activatePlugin(pluginId: string): Promise<{ ok: boolean; error?: string }> {
    const rec = this.records.get(pluginId);
    if (!rec) return { ok: false, error: `Unknown plugin: ${pluginId}` };
    if (rec.lifecycleState === 'active') return { ok: true };

    const missing = this.findUnsatisfiedRequires(rec.manifest);
    if (missing.length > 0) {
      rec.lifecycleState = 'suspended-dep';
      this.notifyStateChange(pluginId);
      return { ok: false, error: `Missing dependencies: ${missing.join(', ')}` };
    }

    rec.lifecycleState = 'loading';
    this.notifyStateChange(pluginId);

    // Compile external local plugin halves on demand
    if (rec.origin !== 'builtin') {
      if (rec.manifest.entry.host) {
        const hostRes = await this.deps.compiler.compileAndLoadHost(pluginId);
        if (!hostRes.ok) {
          this.recordPluginError(rec, hostRes.error);
          return { ok: false, error: hostRes.error.message };
        }
        rec.hostModule = hostRes.mod;
        rec.revHash = hostRes.bundle.revHash;
      }
      if (rec.manifest.entry.client) {
        const clientRes = await this.deps.compiler.compileClient(pluginId);
        if (!clientRes.ok) {
          this.recordPluginError(rec, clientRes.error);
          return { ok: false, error: clientRes.error.message };
        }
        rec.revHash = clientRes.bundle.revHash;
      }
    }

    rec.lifecycleState = 'activating';
    const scope = new KernelEffectScope(pluginId, (label, err) => {
      console.error(`[EffectScope:${pluginId}] dispose "${label}" failed:`, err);
    });
    rec.scope = scope;

    const t0 = Date.now();
    try {
      this.markSentinelSuspect(pluginId);
      if (rec.hostModule) {
        const ctx = this.createHostContext(rec, scope);
        await rec.hostModule.activate(ctx);
        rec.hostActive = true;
      }
      rec.activationMs = Date.now() - t0;
      rec.lifecycleState = 'active';
      rec.lastError = null;
      this.markSentinelSuspect(null);

      // Start fs.watch if configured on local mount
      if (rec.origin !== 'builtin') {
        const mount = this.deps.config.getDocument().mounts.find((m) => m.id === pluginId);
        if (mount?.watch && !rec.watchDisposer) {
          rec.watchActive = true;
          rec.watchDisposer = this.deps.compiler.startWatching(pluginId, (ev) => {
            void this.handleLocalFileChange(ev.pluginId, ev.target);
          });
        }
      }

      this.emitLifecycle({ type: 'plugin-activated', plugin: this.toBootstrapItem(rec) });
      this.notifyStateChange(pluginId);
      this.deps.bus.publish('kernel:plugin.activated', { pluginId, revHash: rec.revHash }, 'kernel');

      // Auto-resume any plugins that were waiting on this plugin / provided services
      for (const other of this.records.values()) {
        if (other.lifecycleState === 'suspended-dep' && this.findUnsatisfiedRequires(other.manifest).length === 0) {
          if (this.deps.config.isPluginEnabled(other.id, other.manifest.defaultEnabled ?? true)) {
            void this.activatePlugin(other.id);
          }
        }
      }

      return { ok: true };
    } catch (err) {
      await scope.disposeAll();
      rec.scope = null;
      rec.hostActive = false;
      const errRec = makeErrorRecord('activate', err);
      this.recordPluginError(rec, errRec);
      return { ok: false, error: errRec.message };
    }
  }

  /** Dynamically deactivate a plugin (reverse cascade suspension of dependents, then dispose EffectScope) */
  async deactivatePlugin(
    pluginId: string,
    reason: 'disabled' | 'suspended-dep' | 'unmounted' | 'error' = 'disabled'
  ): Promise<{ ok: boolean; error?: string }> {
    const rec = this.records.get(pluginId);
    if (!rec) return { ok: false, error: `Unknown plugin: ${pluginId}` };
    if (rec.manifest.locked && reason === 'disabled') {
      return { ok: false, error: `Plugin "${pluginId}" is locked` };
    }

    // Cascade suspend dependents first
    for (const depId of this.findDirectDependents(pluginId)) {
      const depRec = this.records.get(depId);
      if (depRec && depRec.lifecycleState === 'active') {
        await this.deactivatePlugin(depId, 'suspended-dep');
      }
    }

    rec.lifecycleState = 'deactivating';
    this.notifyStateChange(pluginId);

    // Notify client first so UI unmounts before Host tears down RPC/services
    this.emitLifecycle({ type: 'plugin-deactivated', pluginId, reason });
    rec.clientActive = false;
    rec.occupiedSlots = [];
    rec.clientDisposableCount = 0;

    try {
      if (rec.hostModule?.deactivate) {
        await rec.hostModule.deactivate();
      }
    } catch (err) {
      this.recordPluginError(rec, makeErrorRecord('deactivate', err));
    }

    if (rec.scope) {
      await rec.scope.disposeAll();
      rec.scope = null;
    }
    if (reason === 'unmounted' && rec.watchDisposer) {
      void rec.watchDisposer();
      rec.watchDisposer = null;
      rec.watchActive = false;
    }

    rec.hostActive = false;
    rec.lifecycleState =
      reason === 'suspended-dep' ? 'suspended-dep' : reason === 'error' ? 'error' : 'disabled';
    this.notifyStateChange(pluginId);
    this.deps.bus.publish('kernel:plugin.deactivated', { pluginId, reason }, 'kernel');
    return { ok: true };
  }

  async togglePlugin(pluginId: string, enabled: boolean): Promise<{ ok: boolean; error?: string }> {
    const rec = this.records.get(pluginId);
    if (!rec) return { ok: false, error: `Unknown plugin: ${pluginId}` };
    if (rec.manifest.locked && !enabled) {
      return { ok: false, error: `Plugin "${pluginId}" is locked and cannot be disabled` };
    }
    await this.deps.config.setPluginEnabled(pluginId, enabled);
    if (enabled) {
      // Clear quarantine on explicit manual re-enable
      rec.crashTimestamps = [];
      return this.activatePlugin(pluginId);
    }
    return this.deactivatePlugin(pluginId, 'disabled');
  }

  async updatePluginConfig(pluginId: string, patch: Record<string, unknown>): Promise<Record<string, unknown>> {
    const next = await this.deps.config.updatePluginConfig(pluginId, patch);
    this.emitLifecycle({ type: 'plugin-config-changed', pluginId, config: { ...next } });
    this.notifyStateChange(pluginId);
    return { ...next };
  }

  /** Compile-Before-Swap hot reload (preserves live plugin if edited code fails compilation!) */
  async reloadPlugin(pluginId: string, target: 'client' | 'host' | 'both' = 'both'): Promise<{ ok: boolean; error?: string }> {
    const rec = this.records.get(pluginId);
    if (!rec) return { ok: false, error: `Unknown plugin: ${pluginId}` };

    const t0 = Date.now();
    if (rec.origin === 'builtin') {
      // Re-run activate lifecycle cleanly for built-ins
      await this.deactivatePlugin(pluginId, 'disabled');
      const res = await this.activatePlugin(pluginId);
      rec.lastReloadMs = Date.now() - t0;
      this.notifyStateChange(pluginId);
      return res;
    }

    // Reload manifest in case configSchema or contributes changed
    if (rec.sourcePath) {
      const reRead = this.deps.compiler.readLocalManifest(rec.sourcePath);
      if (reRead.ok) {
        rec.manifest = reRead.manifest;
        this.deps.config.registerPluginSchema(pluginId, reRead.manifest.configSchema);
        this.deps.compiler.registerMount(pluginId, rec.sourcePath, reRead.realRoot, reRead.manifest);
      }
    }

    // 1) Client-only HMR: Host stays untouched (PTYs / agent sessions stay alive!)
    if (target === 'client' && rec.manifest.entry.client) {
      const compiled = await this.deps.compiler.compileClient(pluginId);
      if (!compiled.ok) {
        // Compile-Before-Swap: keep existing running plugin alive, surface compile error only
        this.recordPluginError(rec, compiled.error, true);
        return { ok: false, error: compiled.error.message };
      }
      rec.revHash = compiled.bundle.revHash;
      rec.lastReloadMs = Date.now() - t0;
      rec.lastError = null;
      this.emitLifecycle({
        type: 'plugin-reload-client',
        pluginId,
        revHash: compiled.bundle.revHash,
        clientModuleUrl: this.deps.compiler.getClientModuleUrl(pluginId),
        config: { ...this.deps.config.getPluginConfig(pluginId) },
      });
      this.notifyStateChange(pluginId);
      return { ok: true };
    }

    // 2) Host or Both reload: Pre-compile BEFORE tearing down live plugin!
    let nextHostMod: HostPluginModule | null = rec.hostModule;
    if (rec.manifest.entry.host && (target === 'host' || target === 'both')) {
      const hostRes = await this.deps.compiler.compileAndLoadHost(pluginId);
      if (!hostRes.ok) {
        this.recordPluginError(rec, hostRes.error, true);
        return { ok: false, error: hostRes.error.message };
      }
      nextHostMod = hostRes.mod;
      rec.revHash = hostRes.bundle.revHash;
    }

    if (rec.manifest.entry.client && target === 'both') {
      const clientRes = await this.deps.compiler.compileClient(pluginId);
      if (!clientRes.ok) {
        this.recordPluginError(rec, clientRes.error, true);
        return { ok: false, error: clientRes.error.message };
      }
      rec.revHash = clientRes.bundle.revHash;
    }

    // Compilation passed -> swap cleanly
    rec.lifecycleState = 'reloading';
    this.notifyStateChange(pluginId);
    await this.deactivatePlugin(pluginId, 'disabled');
    rec.hostModule = nextHostMod;
    const actRes = await this.activatePlugin(pluginId);
    rec.lastReloadMs = Date.now() - t0;
    this.notifyStateChange(pluginId);
    return actRes;
  }

  async rollbackPlugin(pluginId: string): Promise<{ ok: boolean; error?: string }> {
    const rec = this.records.get(pluginId);
    if (!rec || rec.origin === 'builtin') return { ok: false, error: 'Rollback unavailable' };
    const rb = this.deps.compiler.rollback(pluginId);
    if (!rb.ok) return { ok: false, error: 'No previous good version available' };

    if (rb.hostMod) {
      await this.deactivatePlugin(pluginId, 'disabled');
      rec.hostModule = rb.hostMod;
      if (rb.clientRev) rec.revHash = rb.clientRev;
      return this.activatePlugin(pluginId);
    }
    if (rb.clientRev) {
      rec.revHash = rb.clientRev;
      rec.lastError = null;
      this.emitLifecycle({
        type: 'plugin-reload-client',
        pluginId,
        revHash: rb.clientRev,
        clientModuleUrl: this.deps.compiler.getClientModuleUrl(pluginId),
        config: { ...this.deps.config.getPluginConfig(pluginId) },
      });
      this.notifyStateChange(pluginId);
      return { ok: true };
    }
    return { ok: false, error: 'Rollback had no target' };
  }

  /** Security-gated interactive picker (critic #12-7: prevents XSS RCE via arbitrary path mount) */
  async mountLocalPluginViaDialog(watch = true): Promise<{ ok: boolean; pluginId?: string; error?: string }> {
    const win = this.deps.getMainWindow();
    const res = win
      ? await dialog.showOpenDialog(win, {
          title: '로컬 플러그인 폴더 선택 (desk-plugin.json 포함)',
          properties: ['openDirectory'],
        })
      : await dialog.showOpenDialog({ properties: ['openDirectory'] });

    if (res.canceled || res.filePaths.length === 0) {
      return { ok: false, error: 'cancelled' };
    }
    const chosen = path.resolve(res.filePaths[0]);
    this.approvedDialogPaths.add(chosen);
    return this.mountLocalPlugin(chosen, watch, true);
  }

  async mountLocalPlugin(
    dirPath: string,
    watch = true,
    bypassDialogCheck = false
  ): Promise<{ ok: boolean; pluginId?: string; error?: string }> {
    const resolved = path.resolve(dirPath.replace(/^~(?=\/|$)/, HOME));
    const alreadyInConfig = this.deps.config
      .getDocument()
      .mounts.some((m) => path.resolve(m.path.replace(/^~(?=\/|$)/, HOME)) === resolved);

    if (!bypassDialogCheck && !alreadyInConfig && !this.approvedDialogPaths.has(resolved)) {
      return {
        ok: false,
        error: 'Security gate: external local plugin paths must be selected via native directory picker.',
      };
    }

    const parsed = this.deps.compiler.readLocalManifest(resolved);
    if (!parsed.ok) {
      return { ok: false, error: parsed.error };
    }

    const mount: LocalPluginMount = {
      id: parsed.manifest.id,
      path: resolved,
      enabled: true,
      watch,
      trust: 'local-dev',
      approvedCapabilities: parsed.manifest.capabilities || [],
    };
    await this.deps.config.upsertMount(mount);
    await this.registerLocalMountInternal(mount);
    const actRes = await this.activatePlugin(mount.id);
    return actRes.ok ? { ok: true, pluginId: mount.id } : { ok: false, pluginId: mount.id, error: actRes.error };
  }

  async unmountLocalPlugin(pluginId: string): Promise<{ ok: boolean; error?: string }> {
    const rec = this.records.get(pluginId);
    if (!rec) return { ok: false, error: `Unknown plugin: ${pluginId}` };
    if (rec.origin === 'builtin') return { ok: false, error: 'Cannot unmount a built-in plugin' };

    await this.deactivatePlugin(pluginId, 'unmounted');
    this.deps.compiler.unregisterMount(pluginId);
    this.records.delete(pluginId);
    await this.deps.config.removeMount(pluginId);
    this.notifyStateChange(pluginId);
    return { ok: true };
  }

  /** Renderer reports client-side render/activate errors, active tabs & mounted slots */
  reportClientStatus(
    pluginId: string,
    update: {
      clientActive?: boolean;
      error?: PluginErrorRecord;
      occupiedSlots?: Array<{ slotId: SlotKind; contributionId: string }>;
      activeOpenTabsCount?: number;
      hiddenPreservedTabsCount?: number;
      clientDisposableCount?: number;
    }
  ): void {
    const rec = this.records.get(pluginId);
    if (!rec) return;
    if (typeof update.clientActive === 'boolean') rec.clientActive = update.clientActive;
    if (update.occupiedSlots) rec.occupiedSlots = update.occupiedSlots;
    if (typeof update.activeOpenTabsCount === 'number') rec.activeOpenTabsCount = update.activeOpenTabsCount;
    if (typeof update.hiddenPreservedTabsCount === 'number') {
      rec.hiddenPreservedTabsCount = update.hiddenPreservedTabsCount;
    }
    if (typeof update.clientDisposableCount === 'number') rec.clientDisposableCount = update.clientDisposableCount;
    if (update.error) {
      this.recordPluginError(rec, update.error, true);
    } else {
      this.notifyStateChange(pluginId);
    }
  }

  getBootstrapBundle(): PluginBootstrapBundle {
    const doc = this.deps.config.getDocument();
    const ordered = this.resolveTopologicalOrder(Array.from(this.records.keys()));
    return {
      bootMode: this.bootMode,
      configFilePath: this.deps.config.configFilePath,
      slotOverrides: doc.slots,
      plugins: ordered.map((id) => this.toBootstrapItem(this.records.get(id)!)),
    };
  }

  getNodeSnapshot(pluginId: string): PluginNodeSnapshot | null {
    const rec = this.records.get(pluginId);
    if (!rec) return null;
    return this.toNodeSnapshot(rec);
  }

  getAllNodeSnapshots(): Record<string, PluginNodeSnapshot> {
    const out: Record<string, PluginNodeSnapshot> = {};
    for (const [id, rec] of this.records.entries()) {
      out[id] = this.toNodeSnapshot(rec);
    }
    return out;
  }

  getRuntimeAssetProviders(): RuntimeAssetProvider[] {
    return Array.from(this.runtimeAssetProviders.values());
  }

  getRuntimeAssetProvider(adapterPluginId: string): RuntimeAssetProvider | undefined {
    return this.runtimeAssetProviders.get(adapterPluginId);
  }

  revealPluginSource(pluginId: string): boolean {
    const rec = this.records.get(pluginId);
    if (!rec?.sourcePath) return false;
    shell.showItemInFolder(rec.sourcePath);
    return true;
  }

  async disposeAll(): Promise<void> {
    if (this.bootHealthyTimer) {
      clearTimeout(this.bootHealthyTimer);
      this.bootHealthyTimer = null;
    }
    this.clearBootSentinel();

    const reverseOrder = this.resolveTopologicalOrder(Array.from(this.records.keys())).reverse();
    for (const id of reverseOrder) {
      const rec = this.records.get(id);
      if (rec?.watchDisposer) {
        void rec.watchDisposer();
        rec.watchDisposer = null;
      }
      if (rec?.lifecycleState === 'active') {
        await this.deactivatePlugin(id, 'disabled');
      }
    }

    if (this.powerBlockerId !== null && powerSaveBlocker.isStarted(this.powerBlockerId)) {
      powerSaveBlocker.stop(this.powerBlockerId);
      this.powerBlockerId = null;
    }
    if (this.tray) {
      this.tray.destroy();
      this.tray = null;
    }
  }

  // --------------------------------------------------------------------------
  // Internals
  // --------------------------------------------------------------------------

  private async registerLocalMountInternal(mount: LocalPluginMount): Promise<void> {
    const parsed = this.deps.compiler.readLocalManifest(mount.path);
    if (!parsed.ok) {
      const errRec = makeErrorRecord('manifest', new Error(parsed.error));
      const fallbackManifest: PluginManifest = {
        id: mount.id,
        name: mount.id,
        version: '0.0.0',
        apiVersion: '^1.0.0',
        description: `마운트 오류: ${parsed.error}`,
        layer: 'app',
        category: 'local-dev',
        entry: {},
      };
      this.records.set(mount.id, {
        id: mount.id,
        manifest: fallbackManifest,
        origin: 'local-dev',
        sourcePath: mount.path,
        hostModule: null,
        hasClientHalf: false,
        lifecycleState: 'error',
        scope: null,
        hostActive: false,
        clientActive: false,
        revHash: 'error',
        watchActive: false,
        watchDisposer: null,
        activationMs: null,
        lastReloadMs: null,
        errorCount: 1,
        crashTimestamps: [Date.now()],
        lastError: errRec,
        recentErrors: [errRec],
        activeOpenTabsCount: 0,
        hiddenPreservedTabsCount: 0,
        clientDisposableCount: 0,
        occupiedSlots: [],
      });
      return;
    }

    this.deps.config.registerPluginSchema(parsed.manifest.id, parsed.manifest.configSchema);
    this.deps.compiler.registerMount(parsed.manifest.id, mount.path, parsed.realRoot, parsed.manifest);

    const existing = this.records.get(parsed.manifest.id);
    if (existing) {
      existing.manifest = parsed.manifest;
      existing.sourcePath = mount.path;
      existing.hasClientHalf = Boolean(parsed.manifest.entry.client);
      return;
    }

    this.records.set(parsed.manifest.id, {
      id: parsed.manifest.id,
      manifest: parsed.manifest,
      origin: 'local-dev',
      sourcePath: mount.path,
      hostModule: null,
      hasClientHalf: Boolean(parsed.manifest.entry.client),
      lifecycleState: 'discovered',
      scope: null,
      hostActive: false,
      clientActive: false,
      revHash: 'pending',
      watchActive: false,
      watchDisposer: null,
      activationMs: null,
      lastReloadMs: null,
      errorCount: 0,
      crashTimestamps: [],
      lastError: null,
      recentErrors: [],
      activeOpenTabsCount: 0,
      hiddenPreservedTabsCount: 0,
      clientDisposableCount: 0,
      occupiedSlots: [],
    });
  }

  private async handleLocalFileChange(pluginId: string, target: 'client' | 'host' | 'both'): Promise<void> {
    const rec = this.records.get(pluginId);
    if (!rec || rec.lifecycleState === 'disabled' || rec.lifecycleState === 'quarantined') return;
    await this.reloadPlugin(pluginId, target);
  }

  private createHostContext(rec: HostPluginRecord, scope: KernelEffectScope): DeskHostContext {
    const pluginId = rec.id;
    const caps = new Set<PluginCapability>(rec.manifest.capabilities || []);
    const hasCap = (c: PluginCapability) => rec.origin === 'builtin' || caps.has(c);

    const configNs: ConfigNamespace = {
      get: () => this.deps.config.getPluginConfig(pluginId),
      getKey: (k) => this.deps.config.getPluginConfig(pluginId)[k],
      set: async (partial) => this.updatePluginConfig(pluginId, partial as Record<string, unknown>),
      onChange: (cb) => scope.onDispose(this.deps.config.onPluginConfigChange(pluginId, cb), `config:watch:${pluginId}`),
    };

    const dataDir = path.join(DATA_ROOT, pluginId);

    return {
      pluginId,
      manifest: rec.manifest,
      scope,
      config: configNs,
      services: this.deps.services.createScopedView(pluginId, (d, label) => scope.onDispose(d, label)),
      bus: {
        publish: (topic, payload) => {
          this.deps.bus.publish(topic, payload, pluginId);
        },
        subscribe: (pattern, handler) =>
          scope.onDispose(this.deps.bus.subscribe(pattern, handler, pluginId), `bus:sub:${pattern}`),
      },
      rpc: {
        handle: (method, handler) =>
          scope.onDispose(this.deps.rpc.handle(pluginId, method, handler), `rpc:handle:${method}`),
        onNotify: (method, handler) =>
          scope.onDispose(this.deps.rpc.onNotify(pluginId, method, handler), `rpc:notify:${method}`),
      },
      host: {
        dataDir,
        homeDir: HOME,
        appVersion: app.getVersion(),
        pickDirectory: async () => {
          const win = this.deps.getMainWindow();
          if (!win) return null;
          const res = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
          return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0];
        },
        openExternal: async (url: string) => {
          if (/^https?:\/\//i.test(url)) {
            await shell.openExternal(url);
          }
        },
        showInFolder: (targetPath: string) => {
          if (targetPath) shell.showItemInFolder(targetPath);
        },
        notify: (opts) => {
          if (!hasCap('os:notify') || !Notification.isSupported()) return;
          const n = new Notification({
            title: opts.title,
            body: opts.body,
            silent: opts.silent ?? true,
          });
          if (opts.onClick) n.on('click', opts.onClick);
          n.show();
        },
        acquirePowerSave: (reason: string) => {
          if (!hasCap('os:power-save')) return () => {};
          const key = `${pluginId}:${reason}:${Date.now()}`;
          this.powerSaveReasons.add(key);
          this.syncPowerSaveBlocker();
          return scope.onDispose(() => {
            this.powerSaveReasons.delete(key);
            this.syncPowerSaveBlocker();
          }, `power-save:${reason}`);
        },
        setTrayEnabled: (enabled: boolean) => {
          if (!hasCap('electron:tray')) return;
          this.trayEnabled = enabled;
          this.syncTray();
        },
        contributeTrayItem: (item: TrayItemContribution) => {
          if (!hasCap('electron:tray')) return () => {};
          const fullId = `${pluginId}:${item.id}`;
          this.trayItems.set(fullId, item);
          this.syncTray();
          return scope.onDispose(() => {
            this.trayItems.delete(fullId);
            this.syncTray();
          }, `tray-item:${item.id}`);
        },
        registerWebviewHooks: (hooks) => {
          if (!hasCap('electron:webview')) {
            throw new Error(`Plugin "${pluginId}" lacks required capability "electron:webview"`);
          }
          return scope.onDispose(
            this.deps.webviewSecurity.registerPluginHooks(pluginId, hooks),
            `webview:hooks:${pluginId}`
          );
        },
        registerRuntimeAssetProvider: (provider) => {
          this.runtimeAssetProviders.set(provider.adapterPluginId, provider);
          let watchStop: Disposer | null = null;
          if (provider.watch) {
            watchStop = provider.watch((projection) => {
              for (const l of this.runtimeAssetListeners) {
                try {
                  l(provider.adapterPluginId, projection);
                } catch {
                  // isolate
                }
              }
            });
          }
          return scope.onDispose(() => {
            void watchStop?.();
            if (this.runtimeAssetProviders.get(provider.adapterPluginId) === provider) {
              this.runtimeAssetProviders.delete(provider.adapterPluginId);
            }
          }, `runtime-assets:${provider.adapterPluginId}`);
        },
        onWindowFocus: (cb) => {
          this.windowFocusListeners.add(cb);
          return scope.onDispose(() => {
            this.windowFocusListeners.delete(cb);
          }, `window:focus:${pluginId}`);
        },
        onWindowBeforeClose: (cb) => {
          this.windowBeforeCloseListeners.add(cb);
          return scope.onDispose(() => {
            this.windowBeforeCloseListeners.delete(cb);
          }, `window:before-close:${pluginId}`);
        },
        clearBrowserPartitionData: async (partition = 'persist:agy-desk-browser') => {
          try {
            if (!partition.startsWith('persist:agy-desk-')) return false;
            const ses = session.fromPartition(partition);
            await ses.clearCache();
            await ses.clearStorageData({ storages: ['cachestorage', 'serviceworkers'] });
            return true;
          } catch {
            return false;
          }
        },
        openOsNotificationSettings: async () => {
          if (process.platform === 'darwin') {
            await shell.openExternal('x-apple.systempreferences:com.apple.Notifications-Settings.extension');
          }
        },
      },
      logger: {
        debug: (msg, data) => console.debug(`[plugin:${pluginId}] ${msg}`, data ?? ''),
        info: (msg, data) => console.info(`[plugin:${pluginId}] ${msg}`, data ?? ''),
        warn: (msg, data) => console.warn(`[plugin:${pluginId}] ${msg}`, data ?? ''),
        error: (msg, err) => {
          console.error(`[plugin:${pluginId}] ${msg}`, err ?? '');
          this.deps.bus.publish('kernel:plugin.log-error', { pluginId, message: msg }, pluginId, true);
        },
      },
    };
  }

  private syncPowerSaveBlocker(): void {
    if (this.powerSaveReasons.size > 0) {
      if (this.powerBlockerId === null || !powerSaveBlocker.isStarted(this.powerBlockerId)) {
        this.powerBlockerId = powerSaveBlocker.start('prevent-app-suspension');
      }
    } else if (this.powerBlockerId !== null) {
      if (powerSaveBlocker.isStarted(this.powerBlockerId)) {
        powerSaveBlocker.stop(this.powerBlockerId);
      }
      this.powerBlockerId = null;
    }
  }

  private syncTray(): void {
    const appName = this.deps.appDisplayName || '제제이야';
    if (this.trayEnabled) {
      if (!this.tray) {
        this.tray = new Tray(buildDefaultTrayIcon());
        this.tray.setToolTip(appName);
        this.tray.on('click', () => {
          const win = this.deps.getMainWindow();
          if (!win) this.deps.createOrShowWindow?.();
          else if (win.isVisible()) win.focus();
          else win.show();
        });
      }
      const extraItems = Array.from(this.trayItems.values())
        .sort((a, b) => (a.order ?? 100) - (b.order ?? 100))
        .map<MenuItemConstructorOptions>((item) => ({
          label: item.label,
          click: item.click,
        }));

      const template: MenuItemConstructorOptions[] = [
        {
          label: `${appName} 열기`,
          click: () => {
            const win = this.deps.getMainWindow();
            if (!win) this.deps.createOrShowWindow?.();
            else {
              win.show();
              win.focus();
            }
          },
        },
        ...(extraItems.length > 0 ? [{ type: 'separator' as const }, ...extraItems] : []),
        { type: 'separator' },
        {
          label: '종료',
          click: () => {
            if (this.deps.requestQuit) this.deps.requestQuit();
            else app.quit();
          },
        },
      ];
      this.tray.setContextMenu(Menu.buildFromTemplate(template));
    } else if (this.tray) {
      this.tray.destroy();
      this.tray = null;
    }
  }

  private recordPluginError(rec: HostPluginRecord, err: PluginErrorRecord, keepLiveIfRunning = false): void {
    const now = Date.now();
    rec.errorCount += 1;
    rec.lastError = err;
    rec.recentErrors = [err, ...rec.recentErrors].slice(0, 10);
    rec.crashTimestamps = [...rec.crashTimestamps.filter((ts) => now - ts < 10_000), now];

    // Circuit breaker: 3 crashes within 10 seconds -> quarantine automatically
    if (rec.crashTimestamps.length >= 3 && !rec.manifest.locked) {
      rec.lifecycleState = 'quarantined';
      if (rec.scope) {
        void rec.scope.disposeAll();
        rec.scope = null;
      }
      rec.hostActive = false;
      this.emitLifecycle({ type: 'plugin-deactivated', pluginId: rec.id, reason: 'error' });
    } else if (!keepLiveIfRunning) {
      rec.lifecycleState = 'error';
    } else if (rec.lifecycleState === 'active') {
      rec.lifecycleState = 'degraded';
    }

    this.emitLifecycle({ type: 'plugin-error', pluginId: rec.id, error: err });
    this.notifyStateChange(rec.id);
    this.deps.bus.publish('kernel:plugin.error', { pluginId: rec.id, error: err }, rec.id, true);
  }

  private findUnsatisfiedRequires(manifest: PluginManifest): string[] {
    const missing: string[] = [];
    for (const req of manifest.requires || []) {
      if (req.startsWith('service:')) {
        const token = req.slice('service:'.length);
        if (!this.deps.services.get(token)) missing.push(req);
      } else {
        const dep = this.records.get(req);
        if (!dep || dep.lifecycleState !== 'active') missing.push(req);
      }
    }
    return missing;
  }

  private findDirectDependents(pluginId: string): string[] {
    const rec = this.records.get(pluginId);
    const providedTokens = new Set((rec?.manifest.provides || []).map((t) => `service:${t}`));
    const deps: string[] = [];
    for (const other of this.records.values()) {
      if (other.id === pluginId) continue;
      const reqs = other.manifest.requires || [];
      if (reqs.includes(pluginId) || reqs.some((r) => providedTokens.has(r))) {
        deps.push(other.id);
      }
    }
    return deps;
  }

  private resolveTopologicalOrder(ids: string[]): string[] {
    const visited = new Set<string>();
    const visiting = new Set<string>();
    const result: string[] = [];

    const serviceProviderIndex = new Map<string, string[]>();
    for (const rec of this.records.values()) {
      for (const token of rec.manifest.provides || []) {
        const list = serviceProviderIndex.get(token) || [];
        list.push(rec.id);
        serviceProviderIndex.set(token, list);
      }
    }

    const visit = (id: string) => {
      if (visited.has(id) || visiting.has(id)) return;
      visiting.add(id);
      const rec = this.records.get(id);
      if (rec) {
        for (const req of rec.manifest.requires || []) {
          if (req.startsWith('service:')) {
            for (const provId of serviceProviderIndex.get(req.slice('service:'.length)) || []) {
              visit(provId);
            }
          } else if (this.records.has(req)) {
            visit(req);
          }
        }
      }
      visiting.delete(id);
      visited.add(id);
      result.push(id);
    };

    for (const id of ids) visit(id);
    return result;
  }

  private toBootstrapItem(rec: HostPluginRecord): PluginBootstrapItem {
    return {
      id: rec.id,
      manifest: rec.manifest,
      origin: rec.origin,
      sourcePath: rec.sourcePath,
      enabled: this.deps.config.isPluginEnabled(rec.id, rec.manifest.defaultEnabled ?? true),
      lifecycleState: rec.lifecycleState,
      revHash: rec.revHash,
      clientModuleUrl: rec.origin === 'builtin' ? null : this.deps.compiler.getClientModuleUrl(rec.id),
      config: { ...this.deps.config.getPluginConfig(rec.id) },
      lastError: rec.lastError,
    };
  }

  private toNodeSnapshot(rec: HostPluginRecord): PluginNodeSnapshot {
    return {
      id: rec.id,
      manifest: rec.manifest,
      origin: rec.origin,
      sourcePath: rec.sourcePath,
      lifecycleState: rec.lifecycleState,
      impactClass: rec.manifest.impactClass || 'instant',
      enabledInConfig: this.deps.config.isPluginEnabled(rec.id, rec.manifest.defaultEnabled ?? true),
      locked: Boolean(rec.manifest.locked),
      hostActive: rec.hostActive,
      clientActive: rec.clientActive,
      revHash: rec.revHash,
      watchActive: rec.watchActive,
      hasLastGoodVersion: rec.origin !== 'builtin' && this.deps.compiler.hasLastGood(rec.id),
      activeOpenTabsCount: rec.activeOpenTabsCount,
      hiddenPreservedTabsCount: rec.hiddenPreservedTabsCount,
      requires: [...(rec.manifest.requires || [])],
      optionalRequires: [...(rec.manifest.optionalRequires || [])],
      provides: [...(rec.manifest.provides || [])],
      dependents: this.findDirectDependents(rec.id),
      occupiedSlots: [...rec.occupiedSlots],
      currentConfig: { ...this.deps.config.getPluginConfig(rec.id) },
      disposableCount: {
        host: rec.scope?.size() ?? 0,
        client: rec.clientDisposableCount,
      },
      health: {
        activationMs: rec.activationMs,
        lastReloadMs: rec.lastReloadMs,
        errorCount: rec.errorCount,
        lastError: rec.lastError,
        recentErrors: [...rec.recentErrors],
      },
    };
  }

  private emitLifecycle(ev: KernelPluginLifecycleEvent): void {
    for (const cb of this.lifecycleListeners) {
      try {
        cb(ev);
      } catch {
        // isolate
      }
    }
  }

  private notifyStateChange(pluginId: string): void {
    for (const cb of this.stateChangeListeners) {
      try {
        cb(pluginId);
      } catch {
        // isolate
      }
    }
  }

  private readAndBumpSentinel(): BootSentinel {
    try {
      let prev: BootSentinel = { consecutiveFailedBoots: 0, lastBootAt: 0, suspectedPluginId: null };
      if (fs.existsSync(SENTINEL_PATH)) {
        const parsed = JSON.parse(fs.readFileSync(SENTINEL_PATH, 'utf8')) as Partial<BootSentinel>;
        // Only count crash loops within the last 5 minutes
        if (parsed.lastBootAt && Date.now() - parsed.lastBootAt < 300_000) {
          prev = {
            consecutiveFailedBoots: Number(parsed.consecutiveFailedBoots || 0),
            lastBootAt: parsed.lastBootAt,
            suspectedPluginId: parsed.suspectedPluginId || null,
          };
        }
      }
      const next: BootSentinel = {
        consecutiveFailedBoots: prev.consecutiveFailedBoots + 1,
        lastBootAt: Date.now(),
        suspectedPluginId: prev.suspectedPluginId,
      };
      fs.mkdirSync(path.dirname(SENTINEL_PATH), { recursive: true });
      fs.writeFileSync(SENTINEL_PATH, JSON.stringify(next, null, 2), 'utf8');
      return prev;
    } catch {
      return { consecutiveFailedBoots: 0, lastBootAt: Date.now(), suspectedPluginId: null };
    }
  }

  private markSentinelSuspect(pluginId: string | null): void {
    try {
      if (!fs.existsSync(SENTINEL_PATH)) return;
      const cur = JSON.parse(fs.readFileSync(SENTINEL_PATH, 'utf8')) as BootSentinel;
      cur.suspectedPluginId = pluginId;
      fs.writeFileSync(SENTINEL_PATH, JSON.stringify(cur, null, 2), 'utf8');
    } catch {
      // ignore
    }
  }

  private clearBootSentinel(): void {
    try {
      if (fs.existsSync(SENTINEL_PATH)) {
        fs.unlinkSync(SENTINEL_PATH);
      }
    } catch {
      // ignore
    }
  }
}
