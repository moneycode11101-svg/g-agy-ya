import { ChildProcess, execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stripAnsi } from '../../../src/shared/agentProtocol';

const MAX_INCOMING_LINE_BYTES = 128 * 1024 * 1024; // 128 MiB guard (t3code)
const STDERR_RING_MAX_CHARS = 8192;
const EXIT_STATUS_GRACE_MS = 250;
const MAX_CONCURRENT_SERVER_REQUESTS = 32;

export interface RpcErrorShape {
  code: number;
  message: string;
  data?: unknown;
}

export class CodexRpcError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = 'CodexRpcError';
    this.code = code;
    this.data = data;
  }
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

export function resolveCodexHome(configured?: string): string {
  const custom = configured ? expandTilde(configured) : '';
  if (custom) return path.resolve(custom);
  const envHome = process.env.CODEX_HOME ? expandTilde(process.env.CODEX_HOME) : '';
  if (envHome) return path.resolve(envHome);
  return path.join(os.homedir(), '.codex');
}

export function resolveCodexBinary(configured?: string): string {
  const custom = configured ? expandTilde(configured) : '';
  if (custom && fs.existsSync(custom)) return custom;

  const home = os.homedir();
  const candidates = [
    '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex',
    '/Applications/Codex.app/Contents/Resources/codex-cli/bin/codex',
    path.join(home, '.local', 'bin', 'codex'),
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex',
    path.join(home, '.cargo', 'bin', 'codex'),
  ];
  for (const cand of candidates) {
    try {
      if (fs.existsSync(cand)) return cand;
    } catch {
      // continue
    }
  }
  return 'codex';
}

export function buildCodexSpawnEnv(opts: { codexHome?: string }): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;

  // CRITICAL (t3code gotcha): expand ~ explicitly and set originator BEFORE initialize
  // so Codex doesn't overwrite models_cache.json with a bare CLI catalog.
  env.CODEX_HOME = resolveCodexHome(opts.codexHome);
  env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE = 'agy-desk';

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

  return env;
}

export function detectCodexCliVersion(cliPath?: string, codexHome?: string): string {
  try {
    return (
      execFileSync(resolveCodexBinary(cliPath), ['--version'], {
        encoding: 'utf8',
        timeout: 2500,
        env: buildCodexSpawnEnv({ codexHome }),
      }).trim() || '미설치'
    );
  } catch {
    return '미설치';
  }
}

export interface CodexInitializeResult {
  userAgent?: string;
  codexHome?: string;
  platformFamily?: string;
  platformOs?: string;
}

export type ServerRequestHandler = (
  method: string,
  params: Record<string, unknown>,
  requestId: string | number,
  signal: AbortSignal
) => Promise<unknown>;

export type NotificationHandler = (method: string, params: Record<string, unknown>) => void;

interface PendingOutbound {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Pure TypeScript stdio JSONL transport for `codex app-server` ported from
 * t3code `packages/effect-codex-app-server` (zero Effect-TS, zero telemetry).
 *
 * Key protocol invariants preserved:
 * 1. Frames omit `"jsonrpc": "2.0"` (raw `{ id, method, params }` / `{ method, params }` / `{ id, result | error }`).
 * 2. Streaming UTF-8 decoder with 128 MiB line cap and trailing `\r` trim.
 * 3. `stdout` EOF waits up to 250ms for exit code + stderr tail before rejecting pending calls.
 * 4. Server-to-client request handlers always reply (`-32603` on error, `-32001` if >32 concurrent)
 *    and cancel promptly on `serverRequest/resolved`.
 */
export class CodexAppServerClient {
  private readonly cliPath?: string;
  private readonly codexHome?: string;
  private readonly onNotification: NotificationHandler;
  private readonly onServerRequest: ServerRequestHandler;
  private readonly onUnexpectedClose?: (reason: string) => void;

  private proc: ChildProcess | null = null;
  private initPromise: Promise<CodexInitializeResult> | null = null;
  private initResult: CodexInitializeResult | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingOutbound>();
  private activeServerRequests = new Map<string, AbortController>();
  private decoder = new TextDecoder('utf-8');
  private lineBuf = '';
  private stderrRing = '';
  private exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  private closed = false;

  constructor(opts: {
    cliPath?: string;
    codexHome?: string;
    onNotification: NotificationHandler;
    onServerRequest: ServerRequestHandler;
    onUnexpectedClose?: (reason: string) => void;
  }) {
    this.cliPath = opts.cliPath;
    this.codexHome = opts.codexHome;
    this.onNotification = opts.onNotification;
    this.onServerRequest = opts.onServerRequest;
    this.onUnexpectedClose = opts.onUnexpectedClose;
  }

  get isAlive(): boolean {
    return Boolean(this.proc && !this.proc.killed && !this.closed);
  }

  get serverInfo(): CodexInitializeResult | null {
    return this.initResult;
  }

  async ensureStarted(): Promise<CodexInitializeResult> {
    if (this.initResult && this.isAlive) return this.initResult;
    if (this.initPromise) return this.initPromise;

    this.initPromise = this.spawnAndHandshake().catch((err) => {
      this.initPromise = null;
      this.dispose();
      throw err;
    });
    return this.initPromise;
  }

  private async spawnAndHandshake(): Promise<CodexInitializeResult> {
    this.closed = false;
    this.exitInfo = null;
    this.stderrRing = '';
    this.lineBuf = '';
    this.decoder = new TextDecoder('utf-8');

    const bin = resolveCodexBinary(this.cliPath);
    const args = ['app-server', '-c', 'thread_unload_delay_secs=0'];
    const proc = spawn(bin, args, {
      cwd: os.homedir(),
      env: buildCodexSpawnEnv({ codexHome: this.codexHome }),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc = proc;

    proc.stdin?.on('error', () => {
      // ignore EPIPE; close/eof handler rejects pending calls with stderr context
    });

    proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      this.stderrRing = (this.stderrRing + text).slice(-STDERR_RING_MAX_CHARS);
    });

    proc.stdout?.on('data', (chunk: Buffer) => {
      const decoded = this.decoder.decode(chunk, { stream: true });
      this.lineBuf += decoded;
      if (Buffer.byteLength(this.lineBuf, 'utf8') > MAX_INCOMING_LINE_BYTES) {
        this.failAllPending('codex app-server 단일 메시지 128MiB 한도 초과');
        this.dispose();
        return;
      }
      let nl = this.lineBuf.indexOf('\n');
      while (nl !== -1) {
        const rawLine = this.lineBuf.slice(0, nl).replace(/\r$/, '').trim();
        this.lineBuf = this.lineBuf.slice(nl + 1);
        if (rawLine) {
          this.handleIncomingLine(rawLine);
        }
        nl = this.lineBuf.indexOf('\n');
      }
    });

    let eofHandled = false;
    const handleStreamEnd = (spawnErr?: Error) => {
      if (eofHandled) return;
      eofHandled = true;
      const tail = this.lineBuf.replace(/\r$/, '').trim();
      this.lineBuf = '';
      if (tail) this.handleIncomingLine(tail);

      const finalize = () => {
        if (this.closed) return;
        this.closed = true;
        this.initResult = null;
        this.initPromise = null;
        const cleanStderr = stripAnsi(this.stderrRing).trim().split('\n').filter(Boolean).slice(-3).join(' | ').slice(-512);
        const reason = spawnErr
          ? spawnErr.message
          : this.exitInfo
            ? `codex app-server 종료 (code=${this.exitInfo.code ?? 'null'}, signal=${this.exitInfo.signal ?? 'none'})${cleanStderr ? `: ${cleanStderr}` : ''}`
            : cleanStderr || 'codex app-server 연결이 예기치 않게 종료되었습니다.';
        this.failAllPending(reason);
        this.abortAllServerRequests();
        this.onUnexpectedClose?.(reason);
      };

      // Wait up to 250ms for `exit` event so we report actual exit code + stderr instead of bare EOF
      if (this.exitInfo || spawnErr) {
        finalize();
      } else {
        setTimeout(finalize, EXIT_STATUS_GRACE_MS);
      }
    };

    proc.on('exit', (code, signal) => {
      this.exitInfo = { code, signal };
    });
    proc.on('error', (err) => handleStreamEnd(err));
    proc.stdout?.on('end', () => handleStreamEnd());
    proc.on('close', () => handleStreamEnd());

    // Handshake: initialize (30s) -> initialized notification
    let res: CodexInitializeResult;
    try {
      res = await this.request<CodexInitializeResult>(
        'initialize',
        {
          clientInfo: {
            name: 'agy-desk',
            title: 'agy-desk',
            version: '0.1.0',
          },
          capabilities: {
            experimentalApi: true,
            optOutNotificationMethods: ['turn/diff/updated'],
          },
        },
        30_000
      );
    } catch (err) {
      if (err instanceof CodexRpcError && err.code === -32600 && err.message === 'Already initialized') {
        res = {};
      } else {
        throw err;
      }
    }

    this.notify('initialized');
    this.initResult = res;
    return res;
  }

  request<T = unknown>(method: string, params?: unknown, timeoutMs = 120_000): Promise<T> {
    if (!this.proc || !this.proc.stdin || this.proc.stdin.destroyed || this.closed) {
      return Promise.reject(new Error('codex app-server가 실행 중이 아닙니다.'));
    }
    const id = this.nextId++;
    const frame: Record<string, unknown> = { id, method };
    if (params !== undefined) frame.params = params;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`codex RPC 시간 초과 (${method}, ${timeoutMs}ms)`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });

      try {
        this.proc!.stdin!.write(`${JSON.stringify(frame)}\n`);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  notify(method: string, params?: unknown): void {
    if (!this.proc || !this.proc.stdin || this.proc.stdin.destroyed || this.closed) return;
    const frame: Record<string, unknown> = { method };
    if (params !== undefined) frame.params = params;
    try {
      this.proc.stdin.write(`${JSON.stringify(frame)}\n`);
    } catch {
      // ignore
    }
  }

  private sendResponse(id: string | number, payload: { result: unknown } | { error: RpcErrorShape }): void {
    if (!this.proc || !this.proc.stdin || this.proc.stdin.destroyed || this.closed) return;
    try {
      this.proc.stdin.write(`${JSON.stringify({ id, ...payload })}\n`);
    } catch {
      // ignore
    }
  }

  private handleIncomingLine(line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return; // schema/noise tolerance: never crash session on non-JSON stdout line
    }

    const hasId = msg.id !== undefined && msg.id !== null;
    const hasMethod = typeof msg.method === 'string' && msg.method.length > 0;

    // 1. Response to our outbound request
    if (hasId && !hasMethod) {
      const numId = typeof msg.id === 'number' ? msg.id : Number(msg.id);
      const pending = this.pending.get(numId);
      if (!pending) return;
      this.pending.delete(numId);
      clearTimeout(pending.timer);

      if (msg.error && typeof msg.error === 'object') {
        const e = msg.error as Record<string, unknown>;
        pending.reject(
          new CodexRpcError(
            typeof e.code === 'number' ? e.code : -32000,
            typeof e.message === 'string' ? e.message : 'Codex RPC error',
            e.data
          )
        );
      } else {
        pending.resolve(msg.result);
      }
      return;
    }

    // 2. Server -> Client Request (needs response!)
    if (hasId && hasMethod) {
      const reqId = msg.id as string | number;
      const reqKey = String(reqId);
      const method = String(msg.method);
      const params =
        msg.params && typeof msg.params === 'object' ? (msg.params as Record<string, unknown>) : {};

      if (this.activeServerRequests.size >= MAX_CONCURRENT_SERVER_REQUESTS) {
        this.sendResponse(reqId, { error: { code: -32001, message: 'Client request handler overloaded' } });
        return;
      }

      const ac = new AbortController();
      this.activeServerRequests.set(reqKey, ac);

      // Always execute asynchronously so stdout reader loop never blocks/deadlocks!
      void Promise.resolve()
        .then(() => this.onServerRequest(method, params, reqId, ac.signal))
        .then(
          (result) => {
            this.activeServerRequests.delete(reqKey);
            if (!ac.signal.aborted) {
              this.sendResponse(reqId, { result: result ?? {} });
            }
          },
          (err) => {
            this.activeServerRequests.delete(reqKey);
            if (!ac.signal.aborted) {
              this.sendResponse(reqId, {
                error: {
                  code: -32603,
                  message: err instanceof Error ? err.message : String(err),
                },
              });
            }
          }
        );
      return;
    }

    // 3. Server -> Client Notification
    if (hasMethod) {
      const method = String(msg.method);
      const params =
        msg.params && typeof msg.params === 'object' ? (msg.params as Record<string, unknown>) : {};

      // Clean up server-resolved pending requests immediately to avoid slot leaks
      if (method === 'serverRequest/resolved') {
        const resolvedId = params.requestId;
        if (resolvedId !== undefined && resolvedId !== null) {
          const ac = this.activeServerRequests.get(String(resolvedId));
          if (ac) {
            this.activeServerRequests.delete(String(resolvedId));
            ac.abort();
          }
        }
      }

      // Isolate notification callback errors (never kill transport on schema drift)
      try {
        this.onNotification(method, params);
      } catch {
        // swallow isolated handler error
      }
    }
  }

  private failAllPending(reason: string): void {
    const err = new Error(reason);
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  private abortAllServerRequests(): void {
    for (const ac of this.activeServerRequests.values()) {
      ac.abort();
    }
    this.activeServerRequests.clear();
  }

  dispose(): void {
    this.closed = true;
    this.initResult = null;
    this.initPromise = null;
    this.failAllPending('codex app-server 종료됨');
    this.abortAllServerRequests();

    const proc = this.proc;
    this.proc = null;
    if (!proc || proc.killed) return;
    try {
      proc.stdin?.end();
      proc.kill('SIGTERM');
      const forceKill = setTimeout(() => {
        try {
          if (!proc.killed) proc.kill('SIGKILL');
        } catch {
          // ignore
        }
      }, 2000);
      forceKill.unref?.();
    } catch {
      // ignore
    }
  }
}
