import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Host Claude session environment variables stripped so child sessions never attach
 * to an outer Claude Code session (ported from t3code `ClaudeHome.ts` / `ClaudeAdapterV2.ts`).
 */
const STRIPPED_HOST_CLAUDE_ENV = [
  'CLAUDECODE',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_HOST_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_DESKTOP_APP_VERSION',
  'CLAUDE_EFFORT',
  'CLAUDE_PID',
  'CLAUDE_AGENT_SDK_VERSION',
  // Crucial inside Electron: prevent child Node/Electron processes from misbehaving
  'ELECTRON_RUN_AS_NODE',
] as const;

let warningPatched = false;

/**
 * Suppresses noisy `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` warning emitted by the SDK
 * whenever `canUseTool` is installed alongside `bypassPermissions` or `allowedTools`.
 */
export function suppressClaudeShadowedWarning(): void {
  if (warningPatched) return;
  warningPatched = true;
  const origEmitWarning = process.emitWarning.bind(process);
  (process as { emitWarning: typeof process.emitWarning }).emitWarning = ((
    warning: string | Error,
    ...rest: unknown[]
  ) => {
    const second = rest[0];
    const code =
      typeof rest[1] === 'string'
        ? rest[1]
        : second && typeof second === 'object' && 'code' in (second as Record<string, unknown>)
          ? String((second as Record<string, unknown>).code)
          : '';
    if (code === 'CLAUDE_SDK_CAN_USE_TOOL_SHADOWED') return;
    return (origEmitWarning as (...a: unknown[]) => void)(warning, ...rest);
  }) as typeof process.emitWarning;
}

export function expandTilde(p: string): string {
  const trimmed = p.trim();
  if (!trimmed) return '';
  if (trimmed === '~') return os.homedir();
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return path.join(os.homedir(), trimmed.slice(2));
  }
  return trimmed;
}

/**
 * Resolves the effective Claude config directory without calling `realpathSync`
 * (macOS Keychain entries are keyed by the literal path).
 */
export function resolveClaudeConfigDir(configured?: string): string {
  const custom = configured ? expandTilde(configured) : '';
  if (custom) return path.resolve(custom);
  const envDir = process.env.CLAUDE_CONFIG_DIR?.trim();
  if (envDir) return path.resolve(envDir);
  return path.join(os.homedir(), '.claude');
}

export function resolveClaudeBinary(configured?: string): string {
  const custom = configured ? expandTilde(configured) : '';
  if (custom && fs.existsSync(custom)) return custom;

  const home = os.homedir();
  const candidates = [
    path.join(home, '.local', 'bin', 'claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    path.join(home, '.npm-global', 'bin', 'claude'),
  ];
  for (const cand of candidates) {
    try {
      if (fs.existsSync(cand)) return cand;
    } catch {
      // continue
    }
  }
  return 'claude';
}

export function detectClaudeCliVersion(cliPath?: string): string {
  try {
    const out = execFileSync(resolveClaudeBinary(cliPath), ['--version'], {
      encoding: 'utf8',
      timeout: 2500,
      env: buildClaudeSpawnEnv({}),
    }).trim();
    return out || '미설치';
  } catch {
    return '미설치';
  }
}

export function hasManagedMcpJson(): boolean {
  const managedPath =
    process.platform === 'darwin'
      ? '/Library/Application Support/ClaudeCode/managed-mcp.json'
      : process.platform === 'win32'
        ? 'C:\\Program Files\\ClaudeCode\\managed-mcp.json'
        : '/etc/claude-code/managed-mcp.json';
  try {
    return fs.existsSync(managedPath);
  } catch {
    return false;
  }
}

function readSettingsEntrypoint(configDir: string): string | undefined {
  try {
    const raw = fs.readFileSync(path.join(configDir, 'settings.json'), 'utf8');
    const parsed = JSON.parse(raw) as { env?: Record<string, unknown> };
    const ep = parsed?.env?.CLAUDE_CODE_ENTRYPOINT;
    return typeof ep === 'string' && ep.trim() ? ep.trim() : undefined;
  } catch {
    return undefined;
  }
}

export function buildClaudeSpawnEnv(opts: {
  configDir?: string;
  isResume?: boolean;
  isProbe?: boolean;
}): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const key of STRIPPED_HOST_CLAUDE_ENV) {
    delete env[key];
  }

  const home = os.homedir();
  const extraPaths = [
    path.join(home, '.local', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
  ];
  const existingPath = env.PATH || '';
  env.PATH = [...extraPaths, ...existingPath.split(':').filter(Boolean)]
    .filter((v, i, arr) => arr.indexOf(v) === i)
    .join(':');

  // Preserve macOS Keychain visibility by NEVER mutating HOME; only set CLAUDE_CONFIG_DIR when custom.
  const customDir = opts.configDir ? path.resolve(expandTilde(opts.configDir)) : '';
  if (customDir) {
    env.CLAUDE_CONFIG_DIR = customDir;
  }

  const effectiveDir = resolveClaudeConfigDir(opts.configDir);
  const settingsEntrypoint = readSettingsEntrypoint(effectiveDir);
  if (settingsEntrypoint) {
    env.CLAUDE_CODE_ENTRYPOINT = settingsEntrypoint;
  } else {
    env.CLAUDE_CODE_ENTRYPOINT = 'agy-desk';
  }

  if (opts.isResume) {
    env.MCP_CONNECTION_NONBLOCKING = '0';
  }

  if (opts.isProbe) {
    env.ENABLE_CLAUDEAI_MCP_SERVERS = 'false';
    delete env.FORCE_CODE_TERMINAL;
    env.CLAUDE_CODE_AUTO_CONNECT_IDE = '0';
    env.CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL = '1';
  }

  return env;
}

/**
 * Dynamic ESM loader that survives esbuild CJS bundling without turning `import()` into `require()`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let cachedSdkPromise: Promise<any> | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function loadClaudeAgentSdk(): Promise<any> {
  if (!cachedSdkPromise) {
    const dynamicImport = new Function('spec', 'return import(spec)') as (spec: string) => Promise<unknown>;
    let specifier = '@anthropic-ai/claude-agent-sdk';
    try {
      const req = typeof require === 'function' ? require : createRequire(path.join(process.cwd(), 'package.json'));
      const resolved = req.resolve('@anthropic-ai/claude-agent-sdk');
      if (resolved) {
        specifier = pathToFileURL(resolved).href;
      }
    } catch {
      // Fallback to bare ESM specifier
    }
    cachedSdkPromise = dynamicImport(specifier).catch((err) => {
      cachedSdkPromise = null;
      throw err;
    });
  }
  return cachedSdkPromise;
}
