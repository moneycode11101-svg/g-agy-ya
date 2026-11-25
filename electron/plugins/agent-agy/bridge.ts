import { ChildProcess, execFile, execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  AgyEvent,
  ChatMode,
  ChatStepItem,
  PermissionOption,
  SessionMetrics,
} from '../../../src/shared/types';
import {
  FALLBACK_AGY_MODELS,
  type AgyModelOption,
  type AgyPluginConfig,
  type AgySendPromptRequest,
} from '../../../src/plugins/agent-agy/types';
import { AgyQuotaService, buildAgySpawnEnv, resolveAgyBinary } from './quota';
import {
  analyzeSingleSession,
  registerOwnSession,
  resolveTranscriptPath,
  watchSingleSession,
} from './transcript';

const CLI_ONLY_SLASH_RE = /^\/(usage|help|changelog)\b/i;

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

const MAX_INLINE_IMAGE_BYTES = 15 * 1024 * 1024;

function summarizeToolArgs(name: string, title?: string, input?: unknown): string {
  const o = input && typeof input === 'object' ? (input as Record<string, unknown>) : null;
  if (o && typeof o.toolSummary === 'string' && o.toolSummary.trim()) {
    return o.toolSummary.trim();
  }
  if (title && title.trim() && title.trim() !== name) {
    const t = title.replace(/\s+/g, ' ').trim();
    return t.length > 72 ? t.slice(0, 72) + '…' : t;
  }
  if (!o) return '';
  const cand =
    o.Path ??
    o.path ??
    o.AbsolutePath ??
    o.TargetFile ??
    o.DirectoryPath ??
    o.SearchPath ??
    o.CommandLine ??
    o.command ??
    o.Query ??
    o.query ??
    o.Url ??
    o.url ??
    o.file_path ??
    '';
  const s = String(cand).replace(/\s+/g, ' ').trim();
  if (!s) return '';
  if (s.includes('/') && !s.includes(' ')) return path.basename(s);
  return s.length > 64 ? s.slice(0, 64) + '…' : s;
}

function formatToolOutput(rawOutput: unknown, content?: unknown): string {
  if (typeof rawOutput === 'string') return rawOutput.slice(0, 1200);
  if (rawOutput && typeof rawOutput === 'object') {
    const r = rawOutput as Record<string, unknown>;
    if (typeof r.output === 'string') return r.output.slice(0, 1200);
    if (typeof r.content === 'string') return r.content.slice(0, 1200);
    if (typeof r.stdout === 'string') return r.stdout.slice(0, 1200);
    if (typeof r.error === 'string') return r.error.slice(0, 1200);
    try {
      return JSON.stringify(rawOutput, null, 2).slice(0, 1200);
    } catch {
      return '';
    }
  }
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      if (!item || typeof item !== 'object') continue;
      const rec = item as Record<string, unknown>;
      if (rec.type === 'content' && rec.content && typeof rec.content === 'object') {
        const inner = rec.content as Record<string, unknown>;
        if (typeof inner.text === 'string') parts.push(inner.text);
      } else if (typeof rec.text === 'string') {
        parts.push(rec.text);
      }
    }
    return parts.join('\n').slice(0, 1200);
  }
  return '';
}

function parseStepsPayload(args: unknown): ChatStepItem[] | null {
  if (!args || typeof args !== 'object') return null;
  const rawSteps = (args as Record<string, unknown>).steps;
  if (!Array.isArray(rawSteps)) return null;
  const out: ChatStepItem[] = [];
  for (const s of rawSteps) {
    if (!s || typeof s !== 'object') continue;
    const rec = s as Record<string, unknown>;
    const title = typeof rec.title === 'string' ? rec.title.trim() : '';
    const st = typeof rec.status === 'string' ? rec.status : 'pending';
    if (!title) continue;
    const status: ChatStepItem['status'] =
      st === 'in_progress' || st === 'done' || st === 'skipped' || st === 'failed' ? st : 'pending';
    out.push({ title, status });
  }
  return out.length > 0 ? out : null;
}

function resolveModelWithEffort(
  reqModel: string,
  reqEffort: string,
  cfg: Readonly<AgyPluginConfig>
): string {
  const effectiveModel = reqModel && reqModel !== 'default' ? reqModel : cfg.defaultModel || '';
  if (!effectiveModel || effectiveModel === 'default') return '';

  const modelHasEmbeddedTier = /-(low|medium|high|xhigh|max)$/i.test(effectiveModel);
  const effectiveEffort =
    reqEffort && reqEffort !== 'default'
      ? reqEffort
      : modelHasEmbeddedTier
        ? 'default'
        : cfg.defaultEffort || 'default';

  if (effectiveEffort && effectiveEffort !== 'default') {
    const base = effectiveModel.replace(/-(low|medium|high|xhigh|max)$/i, '');
    return `${base}-${effectiveEffort}`;
  }
  return effectiveModel;
}

function mapChatModeToAcpMode(mode: ChatMode): string {
  switch (mode) {
    case 'turbo':
      return 'auto';
    case 'auto':
      return 'auto';
    case 'accept-edits':
      return 'accept-edits';
    case 'plan':
      return 'plan';
    case 'strict':
      return 'default';
    default:
      return 'auto';
  }
}

type DaemonKey = 'default' | 'sandbox';

interface PendingRpc {
  resolve: (res: unknown) => void;
  reject: (err: Error) => void;
}

interface AcpDaemon {
  key: DaemonKey;
  proc: ChildProcess;
  assetRevision: number;
  lineBuf: string;
  stderrBuf: string;
  nextId: number;
  pending: Map<number, PendingRpc>;
  initPromise: Promise<void>;
  closed: boolean;
  stale: boolean;
}

interface TabSessionBinding {
  tabSessionId: string;
  daemonKey: DaemonKey;
  sessionId: string;
  cwd: string;
  addDirsKey: string;
  model: string;
  mode: ChatMode;
  acpMode: string;
  inTurn: boolean;
  turnToken: number;
  activePromptPromise: Promise<void> | null;
  cancelledByUser: boolean;
  hasActiveWatcher: boolean;
  emittedToolIds: Set<string>;
}

interface PendingPermission {
  requestId: string;
  rpcId: number | string;
  daemon: AcpDaemon;
  tabSessionId: string;
  sessionId: string;
}

/**
 * Official Antigravity ACP (`agy acp --stdio`) persistent bridge.
 *
 * Mirrors vanilla Antigravity Hub architecture:
 * - One persistent ACP daemon shared across tabs (zero cold-start on follow-ups or model/mode switches)
 * - Live streaming `agent_thought_chunk`, `agent_message_chunk`, `tool_call`/`tool_call_update`
 * - Native `update_focus`, `update_steps`, `session_info_update` (AI auto-title), `available_commands_update`
 * - Interactive `session/request_permission` approvals (auto-approved in turbo mode, inline cards in other modes)
 * - Native multimodal `{ type: 'image', mimeType, data }` content blocks
 * - Clean `session/cancel` without killing the session or causing `[Notice] server restart`
 */
export class AgyPluginBridge {
  private daemons = new Map<DaemonKey, AcpDaemon>();
  private tabBindings = new Map<string, TabSessionBinding>();
  private sessionToTab = new Map<string, string>();
  private pendingPermissions = new Map<string, PendingPermission>();
  private oneShotProcs = new Map<string, ChildProcess>();
  private sessionWatchers = new Map<string, () => void>();
  private readonly getConfig: () => Readonly<AgyPluginConfig>;
  private readonly quota: AgyQuotaService;
  private readonly emit: (ev: AgyEvent) => void;
  private assetRevision = 0;
  private cachedVersion: string | null = null;
  private cachedModels: { items: AgyModelOption[]; fetchedAt: number } | null = null;
  private cachedCommands: Array<{ name: string; description: string }> = [];
  private disposed = false;

  constructor(opts: {
    getConfig: () => Readonly<AgyPluginConfig>;
    quota: AgyQuotaService;
    emit: (ev: AgyEvent) => void;
  }) {
    this.getConfig = opts.getConfig;
    this.quota = opts.quota;
    this.emit = opts.emit;
  }

  /** Pre-warm the default ACP daemon silently so the first prompt has near-zero startup lag */
  warmup(): void {
    if (this.disposed) return;
    void this.ensureDaemon('default').catch(() => {
      // ignore if agy CLI is unavailable or not yet authenticated
    });
  }

  /** Bumping assetRevision marks active ACP daemons stale so idle ones reload new plugins/MCP */
  bumpAssetRevision(): void {
    this.assetRevision += 1;
    for (const daemon of this.daemons.values()) {
      daemon.stale = true;
      const hasBusyTab = Array.from(this.tabBindings.values()).some(
        (b) => b.daemonKey === daemon.key && b.inTurn
      );
      if (!hasBusyTab) {
        this.shutdownDaemon(daemon.key);
      }
    }
  }

  detectVersion(): string {
    if (this.cachedVersion !== null) return this.cachedVersion;
    try {
      this.cachedVersion = execFileSync(resolveAgyBinary(), ['--version'], {
        encoding: 'utf8',
        timeout: 2000,
        env: buildAgySpawnEnv(),
      }).trim();
    } catch {
      this.cachedVersion = '미설치';
    }
    return this.cachedVersion;
  }

  listModels(force = false): Promise<AgyModelOption[]> {
    if (!force && this.cachedModels && Date.now() - this.cachedModels.fetchedAt < 300_000) {
      return Promise.resolve(this.cachedModels.items);
    }
    return new Promise((resolve) => {
      execFile(
        resolveAgyBinary(),
        ['models'],
        { cwd: os.homedir(), timeout: 12_000, maxBuffer: 256 * 1024, env: buildAgySpawnEnv() },
        (err, stdout) => {
          if (err || !stdout) {
            resolve(this.cachedModels?.items || FALLBACK_AGY_MODELS);
            return;
          }
          const parsed: AgyModelOption[] = [];
          const seen = new Set<string>();
          const clean = stdout.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\r/g, '\n');
          for (const rawLine of clean.split('\n')) {
            const line = rawLine.trim();
            if (!line || line.includes('Fetching available models')) continue;
            const m = line.match(/^([a-z0-9][a-z0-9._-]+)(?:\t+|\s{2,})(.+)$/i);
            if (m) {
              const value = m[1].trim();
              const label = m[2].trim();
              if (!seen.has(value)) {
                seen.add(value);
                parsed.push({ value, label });
              }
            }
          }
          const items = parsed.length > 0 ? parsed : FALLBACK_AGY_MODELS;
          this.cachedModels = { items, fetchedAt: Date.now() };
          resolve(items);
        }
      );
    });
  }

  watchSession(tabSessionId: string, conversationId: string): SessionMetrics | null {
    this.unwatchSession(tabSessionId);
    const initial = analyzeSingleSession(conversationId, this.quota.getCachedSnapshot());
    const stop = watchSingleSession(
      conversationId,
      () => this.quota.getCachedSnapshot(),
      (metrics) => {
        this.emit({ type: 'metrics', tabSessionId, metrics });
      }
    );
    this.sessionWatchers.set(tabSessionId, stop);
    return initial;
  }

  unwatchSession(tabSessionId: string): void {
    const prev = this.sessionWatchers.get(tabSessionId);
    if (prev) {
      prev();
      this.sessionWatchers.delete(tabSessionId);
    }
  }

  cancelTurn(tabSessionId: string): void {
    this.killOneShot(tabSessionId);
    this.cancelPendingPermissionsForTab(tabSessionId);

    const binding = this.tabBindings.get(tabSessionId);
    if (!binding || !binding.inTurn) return;
    binding.cancelledByUser = true;

    const daemon = this.daemons.get(binding.daemonKey);
    if (daemon && !daemon.closed) {
      this.sendNotification(daemon, 'session/cancel', { sessionId: binding.sessionId });
    }
  }

  submitAuthCode(tabSessionId: string, code: string): boolean {
    const oneShot = this.oneShotProcs.get(tabSessionId);
    if (oneShot && !oneShot.killed && oneShot.stdin?.writable) {
      oneShot.stdin.write(code.trim() + '\n');
      return true;
    }
    return false;
  }

  respondPermission(tabSessionId: string, requestId: string, optionId: string | null): boolean {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending || pending.tabSessionId !== tabSessionId) return false;
    this.pendingPermissions.delete(requestId);

    if (!pending.daemon.closed) {
      const result = optionId
        ? { outcome: { outcome: 'selected', optionId } }
        : { outcome: { outcome: 'cancelled' } };
      this.sendJsonRpcResponse(pending.daemon, pending.rpcId, result);
    }
    this.emit({ type: 'permission_cleared', tabSessionId, requestId });
    return true;
  }

  async sendPrompt(req: AgySendPromptRequest): Promise<{ ok: boolean; error?: string }> {
    this.killOneShot(req.tabSessionId);

    const trimmed = req.prompt.trim();
    if (!trimmed) return { ok: false, error: '빈 메시지입니다.' };

    // CLI-only meta commands (`/usage`, `/help`, `/changelog`)
    if (CLI_ONLY_SLASH_RE.test(trimmed)) {
      return this.sendOneShotCommand(req);
    }

    const cfg = this.getConfig();
    const effectiveMode: ChatMode = req.mode || cfg.localPermission || 'turbo';
    const daemonKey: DaemonKey = effectiveMode === 'strict' ? 'sandbox' : 'default';
    const cwd = req.cwd && fs.existsSync(req.cwd) ? req.cwd : os.homedir();
    const addDirs = Array.isArray(req.addDirs)
      ? Array.from(new Set(req.addDirs.filter((d) => d && d !== cwd && fs.existsSync(d))))
      : [];
    const addDirsKey = addDirs.join('|');
    const desiredModel = resolveModelWithEffort(req.model, req.effort, cfg);
    const desiredAcpMode = mapChatModeToAcpMode(effectiveMode);

    let daemon: AcpDaemon;
    try {
      // If daemon was marked stale by Layer 2 asset toggle and idle, respawn fresh
      const existingDaemon = this.daemons.get(daemonKey);
      if (existingDaemon?.stale) {
        const hasBusyTab = Array.from(this.tabBindings.values()).some(
          (b) => b.daemonKey === daemonKey && b.inTurn
        );
        if (!hasBusyTab) this.shutdownDaemon(daemonKey);
      }
      daemon = await this.ensureDaemon(daemonKey);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }

    let binding = this.tabBindings.get(req.tabSessionId);
    const canReuseBinding = Boolean(
      binding &&
        binding.daemonKey === daemonKey &&
        binding.sessionId &&
        (!req.agyConversationId || binding.sessionId === req.agyConversationId) &&
        binding.cwd === cwd &&
        binding.addDirsKey === addDirsKey
    );

    if (!canReuseBinding || !binding) {
      if (binding) {
        this.sessionToTab.delete(binding.sessionId);
      }

      let sessionId: string | null = null;
      let resumedModels: AgyModelOption[] | null = null;

      if (req.agyConversationId) {
        try {
          const res = (await this.sendRequest(daemon, 'session/resume', {
            sessionId: req.agyConversationId,
            cwd,
            ...(addDirs.length > 0 ? { additionalDirectories: addDirs } : {}),
            mcpServers: [],
          })) as Record<string, unknown>;
          sessionId =
            (typeof res?.sessionId === 'string' && res.sessionId) || req.agyConversationId;
          resumedModels = this.extractAvailableModels(res);
        } catch {
          // Fall back to starting a fresh session if conversation cannot be resumed
          sessionId = null;
        }
      }

      if (!sessionId) {
        try {
          const res = (await this.sendRequest(daemon, 'session/new', {
            cwd,
            ...(addDirs.length > 0 ? { additionalDirectories: addDirs } : {}),
            mcpServers: [],
          })) as Record<string, unknown>;
          sessionId = typeof res?.sessionId === 'string' ? res.sessionId : '';
          resumedModels = this.extractAvailableModels(res);
        } catch (err) {
          return {
            ok: false,
            error: err instanceof Error ? err.message : 'ACP 세션 생성에 실패했습니다.',
          };
        }
      }

      if (!sessionId) {
        return { ok: false, error: 'ACP 세션 ID를 받지 못했습니다.' };
      }

      if (resumedModels && resumedModels.length > 0) {
        this.cachedModels = { items: resumedModels, fetchedAt: Date.now() };
      }

      binding = {
        tabSessionId: req.tabSessionId,
        daemonKey,
        sessionId,
        cwd,
        addDirsKey,
        model: '',
        mode: effectiveMode,
        acpMode: '',
        inTurn: false,
        turnToken: 0,
        activePromptPromise: null,
        cancelledByUser: false,
        hasActiveWatcher: false,
        emittedToolIds: new Set<string>(),
      };

      this.tabBindings.set(req.tabSessionId, binding);
      this.sessionToTab.set(sessionId, req.tabSessionId);

      registerOwnSession({
        conversationId: sessionId,
        title: trimmed.replace(/\s+/g, ' ').slice(0, 40),
        cwd,
      });

      this.emit({
        type: 'session_init',
        tabSessionId: req.tabSessionId,
        agyConversationId: sessionId,
      });
      this.ensureWatcher(binding);

      if (this.cachedCommands.length > 0) {
        this.emit({ type: 'commands_update', commands: this.cachedCommands });
      }
    }

    // Wait briefly for any previously cancelled in-flight `session/prompt` to settle on ACP before starting the new turn
    if (binding.activePromptPromise) {
      if (!binding.cancelledByUser) {
        binding.cancelledByUser = true;
        this.sendNotification(daemon, 'session/cancel', { sessionId: binding.sessionId });
      }
      await Promise.race([
        binding.activePromptPromise,
        new Promise<void>((resolve) => setTimeout(resolve, 1500)),
      ]);
    }

    const myTurnToken = binding.turnToken + 1;
    binding.turnToken = myTurnToken;
    binding.mode = effectiveMode;
    binding.inTurn = true;
    binding.cancelledByUser = false;
    binding.emittedToolIds.clear();

    // Live model switch with ZERO worker restart
    if (desiredModel && binding.model !== desiredModel) {
      try {
        await this.sendRequest(daemon, 'session/set_model', {
          sessionId: binding.sessionId,
          modelId: desiredModel,
        });
        binding.model = desiredModel;
      } catch {
        // Non-fatal: continue with server default if model alias unsupported
      }
    }

    // Live mode switch with ZERO worker restart
    if (binding.acpMode !== desiredAcpMode) {
      try {
        await this.sendRequest(daemon, 'session/set_mode', {
          sessionId: binding.sessionId,
          modeId: desiredAcpMode,
        });
        binding.acpMode = desiredAcpMode;
      } catch {
        // Non-fatal
      }
    }

    // Build native multimodal prompt content blocks
    const contentBlocks = this.buildPromptBlocks(trimmed, req.images);

    // Fire `session/prompt` asynchronously — return `{ ok: true }` right away so UI streams live!
    const activeBinding = binding;
    const promptPromise = this.sendRequest(daemon, 'session/prompt', {
      sessionId: activeBinding.sessionId,
      prompt: contentBlocks,
    })
      .then((res) => {
        if (activeBinding.turnToken !== myTurnToken || !activeBinding.inTurn) return;
        activeBinding.inTurn = false;
        this.cancelPendingPermissionsForTab(activeBinding.tabSessionId);

        const rec = res && typeof res === 'object' ? (res as Record<string, unknown>) : {};
        const stopReason = typeof rec.stopReason === 'string' ? rec.stopReason : '';

        registerOwnSession({ conversationId: activeBinding.sessionId, cwd: activeBinding.cwd });
        this.ensureWatcher(activeBinding);
        const metrics = analyzeSingleSession(
          activeBinding.sessionId,
          this.quota.getCachedSnapshot()
        );
        if (metrics) {
          this.emit({ type: 'metrics', tabSessionId: activeBinding.tabSessionId, metrics });
        }

        const isCancelled = activeBinding.cancelledByUser || stopReason === 'cancelled';
        this.emit({
          type: 'done',
          tabSessionId: activeBinding.tabSessionId,
          exitCode: 0,
          error: isCancelled ? undefined : undefined,
        });
      })
      .catch((err) => {
        if (activeBinding.turnToken !== myTurnToken || !activeBinding.inTurn) return;
        activeBinding.inTurn = false;
        this.cancelPendingPermissionsForTab(activeBinding.tabSessionId);

        const msg = err instanceof Error ? err.message : String(err);
        const isCancelled =
          activeBinding.cancelledByUser || /cancel/i.test(msg);

        const metrics = analyzeSingleSession(
          activeBinding.sessionId,
          this.quota.getCachedSnapshot()
        );
        if (metrics) {
          this.emit({ type: 'metrics', tabSessionId: activeBinding.tabSessionId, metrics });
        }

        this.emit({
          type: 'done',
          tabSessionId: activeBinding.tabSessionId,
          exitCode: isCancelled ? 0 : 1,
          error: isCancelled ? undefined : msg,
        });
      })
      .finally(() => {
        if (activeBinding.turnToken === myTurnToken) {
          activeBinding.activePromptPromise = null;
        }
      });

    activeBinding.activePromptPromise = promptPromise;
    return { ok: true };
  }

  dispose(): void {
    this.disposed = true;
    for (const id of [...this.oneShotProcs.keys()]) {
      this.killOneShot(id);
    }
    for (const key of [...this.daemons.keys()]) {
      this.shutdownDaemon(key);
    }
    for (const id of [...this.sessionWatchers.keys()]) {
      this.unwatchSession(id);
    }
    this.tabBindings.clear();
    this.sessionToTab.clear();
    this.pendingPermissions.clear();
  }

  // ---------------------------------------------------------------------------
  // Persistent ACP Daemon Lifecycle & JSON-RPC Transport
  // ---------------------------------------------------------------------------

  private async ensureDaemon(key: DaemonKey): Promise<AcpDaemon> {
    const existing = this.daemons.get(key);
    if (existing && !existing.closed && !existing.proc.killed) {
      await existing.initPromise;
      return existing;
    }

    const agyBin = resolveAgyBinary();
    const args = ['acp', '--stdio'];
    if (key === 'sandbox') {
      args.push('--sandbox');
    }

    const proc = spawn(agyBin, args, {
      cwd: os.homedir(),
      env: buildAgySpawnEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    proc.stdin?.on('error', () => {
      // ignore EPIPE on shutdown
    });

    let resolveInit!: () => void;
    let rejectInit!: (err: Error) => void;
    const initPromise = new Promise<void>((res, rej) => {
      resolveInit = res;
      rejectInit = rej;
    });

    const daemon: AcpDaemon = {
      key,
      proc,
      assetRevision: this.assetRevision,
      lineBuf: '',
      stderrBuf: '',
      nextId: 1,
      pending: new Map(),
      initPromise,
      closed: false,
      stale: false,
    };

    this.daemons.set(key, daemon);

    proc.stdout?.on('data', (buf: Buffer) => {
      daemon.lineBuf += buf.toString('utf8');
      let nl = daemon.lineBuf.indexOf('\n');
      while (nl !== -1) {
        const line = daemon.lineBuf.slice(0, nl).trim();
        daemon.lineBuf = daemon.lineBuf.slice(nl + 1);
        if (line && line.startsWith('{')) {
          try {
            const msg = JSON.parse(line) as Record<string, unknown>;
            this.handleAcpMessage(daemon, msg);
          } catch {
            // ignore non-JSON log line
          }
        }
        nl = daemon.lineBuf.indexOf('\n');
      }
    });

    proc.stderr?.on('data', (buf: Buffer) => {
      const chunk = buf.toString('utf8');
      daemon.stderrBuf = (daemon.stderrBuf + chunk).slice(-8192);
      const urlMatch = chunk.match(/https:\/\/accounts\.google\.com\/o\/oauth2\/auth[^\s]+/);
      if (urlMatch) {
        for (const binding of this.tabBindings.values()) {
          if (binding.daemonKey === key && binding.inTurn) {
            this.emit({
              type: 'auth_required',
              tabSessionId: binding.tabSessionId,
              url: urlMatch[0],
              message: 'agy CLI Google 로그인이 필요합니다. 브라우저에서 인증 후 코드를 붙여넣으세요.',
            });
          }
        }
      }
    });

    const handleClose = (reason: string) => {
      if (daemon.closed) return;
      daemon.closed = true;
      if (this.daemons.get(key) === daemon) {
        this.daemons.delete(key);
      }

      const err = new Error(reason);
      rejectInit(err);
      for (const p of daemon.pending.values()) {
        p.reject(err);
      }
      daemon.pending.clear();

      // Clear bindings associated with this dead daemon
      for (const [tabId, binding] of [...this.tabBindings.entries()]) {
        if (binding.daemonKey !== key) continue;
        this.cancelPendingPermissionsForTab(tabId);
        if (binding.inTurn) {
          binding.inTurn = false;
          this.emit({
            type: 'done',
            tabSessionId: tabId,
            exitCode: 1,
            error: binding.cancelledByUser ? undefined : reason,
          });
        }
        this.sessionToTab.delete(binding.sessionId);
        this.tabBindings.delete(tabId);
      }
    };

    proc.on('error', (err) => {
      handleClose(err instanceof Error ? err.message : String(err));
    });
    proc.on('close', (code) => {
      const tail = daemon.stderrBuf
        .trim()
        .split('\n')
        .filter((l) => l.trim() && !l.trim().startsWith('warning:'))
        .slice(-3)
        .join('\n');
      handleClose(tail || `agy acp 종료됨 (code ${code ?? 0})`);
    });

    // Perform JSON-RPC `initialize` handshake
    void this.sendRequest(daemon, 'initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: 'agy-desk', version: '0.1.0' },
    })
      .then(() => resolveInit())
      .catch((err) => {
        const e = err instanceof Error ? err : new Error(String(err));
        rejectInit(e);
        this.shutdownDaemon(key);
      });

    await initPromise;
    return daemon;
  }

  private shutdownDaemon(key: DaemonKey): void {
    const daemon = this.daemons.get(key);
    if (!daemon) return;
    this.daemons.delete(key);
    daemon.closed = true;
    try {
      if (!daemon.proc.killed) daemon.proc.kill('SIGTERM');
    } catch {
      // ignore
    }
    for (const [tabId, binding] of [...this.tabBindings.entries()]) {
      if (binding.daemonKey !== key) continue;
      this.sessionToTab.delete(binding.sessionId);
      this.tabBindings.delete(tabId);
    }
  }

  private sendRequest(
    daemon: AcpDaemon,
    method: string,
    params: Record<string, unknown>
  ): Promise<unknown> {
    if (daemon.closed || !daemon.proc.stdin?.writable) {
      return Promise.reject(new Error('agy acp 프로세스가 연결되어 있지 않습니다.'));
    }
    const id = daemon.nextId++;
    return new Promise((resolve, reject) => {
      daemon.pending.set(id, { resolve, reject });
      const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
      try {
        daemon.proc.stdin!.write(payload);
      } catch (err) {
        daemon.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private sendNotification(
    daemon: AcpDaemon,
    method: string,
    params: Record<string, unknown>
  ): void {
    if (daemon.closed || !daemon.proc.stdin?.writable) return;
    try {
      daemon.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
    } catch {
      // ignore
    }
  }

  private sendJsonRpcResponse(daemon: AcpDaemon, id: number | string, result: unknown): void {
    if (daemon.closed || !daemon.proc.stdin?.writable) return;
    try {
      daemon.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
    } catch {
      // ignore
    }
  }

  private sendJsonRpcError(
    daemon: AcpDaemon,
    id: number | string,
    code: number,
    message: string
  ): void {
    if (daemon.closed || !daemon.proc.stdin?.writable) return;
    try {
      daemon.proc.stdin.write(
        JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n'
      );
    } catch {
      // ignore
    }
  }

  private handleAcpMessage(daemon: AcpDaemon, msg: Record<string, unknown>): void {
    const hasId = msg.id !== undefined && msg.id !== null;
    const method = typeof msg.method === 'string' ? msg.method : '';

    // 1. JSON-RPC Response to our request
    if (hasId && !method) {
      const idNum = Number(msg.id);
      const pending = daemon.pending.get(idNum);
      if (!pending) return;
      daemon.pending.delete(idNum);
      if (msg.error && typeof msg.error === 'object') {
        const errObj = msg.error as Record<string, unknown>;
        const errMsg =
          typeof errObj.message === 'string' ? errObj.message : JSON.stringify(errObj);
        pending.reject(new Error(errMsg));
      } else {
        pending.resolve(msg.result);
      }
      return;
    }

    // 2. Server -> Client Request (e.g., `session/request_permission`)
    if (hasId && method) {
      if (method === 'session/request_permission') {
        this.handlePermissionRequest(
          daemon,
          msg.id as number | string,
          (msg.params || {}) as Record<string, unknown>
        );
        return;
      }
      this.sendJsonRpcError(daemon, msg.id as number | string, -32601, `Unsupported method: ${method}`);
      return;
    }

    // 3. Server Notification (`session/update`)
    if (method === 'session/update') {
      const params = (msg.params || {}) as Record<string, unknown>;
      const sessionId = typeof params.sessionId === 'string' ? params.sessionId : '';
      const update =
        params.update && typeof params.update === 'object'
          ? (params.update as Record<string, unknown>)
          : null;
      if (update) {
        this.handleSessionUpdate(sessionId, update);
      }
    }
  }

  private handlePermissionRequest(
    daemon: AcpDaemon,
    rpcId: number | string,
    params: Record<string, unknown>
  ): void {
    const sessionId = typeof params.sessionId === 'string' ? params.sessionId : '';
    const tabSessionId = this.sessionToTab.get(sessionId);
    const binding = tabSessionId ? this.tabBindings.get(tabSessionId) : undefined;

    const rawOptions = Array.isArray(params.options) ? params.options : [];
    const options: PermissionOption[] = rawOptions
      .filter((o): o is Record<string, unknown> => Boolean(o && typeof o === 'object'))
      .map((o) => ({
        optionId: String(o.optionId || ''),
        name: String(o.name || o.optionId || '허용'),
        kind: typeof o.kind === 'string' ? o.kind : undefined,
      }))
      .filter((o) => Boolean(o.optionId));

    // In `turbo` mode, auto-approve seamlessly without interrupting the user
    if (!binding || binding.mode === 'turbo') {
      const allowOpt =
        options.find((o) => o.kind === 'allow_once' || o.optionId === 'allow') ||
        options.find((o) => o.kind === 'allow_always') ||
        options[0];
      if (allowOpt) {
        this.sendJsonRpcResponse(daemon, rpcId, {
          outcome: { outcome: 'selected', optionId: allowOpt.optionId },
        });
      } else {
        this.sendJsonRpcResponse(daemon, rpcId, { outcome: { outcome: 'cancelled' } });
      }
      return;
    }

    const tc =
      params.toolCall && typeof params.toolCall === 'object'
        ? (params.toolCall as Record<string, unknown>)
        : {};
    const toolName = String(tc.name || 'tool');
    const title = String(tc.title || toolName);
    const rawInputObj = tc.rawInput ?? tc.args;
    const argsSummary = summarizeToolArgs(toolName, title, rawInputObj);
    let rawInput: string | undefined;
    if (rawInputObj && typeof rawInputObj === 'object') {
      try {
        rawInput = JSON.stringify(rawInputObj, null, 2).slice(0, 1200);
      } catch {
        rawInput = undefined;
      }
    }

    const requestId = `perm-${rpcId}-${Date.now().toString(36)}`;
    this.pendingPermissions.set(requestId, {
      requestId,
      rpcId,
      daemon,
      tabSessionId: binding.tabSessionId,
      sessionId,
    });

    this.emit({
      type: 'permission_request',
      tabSessionId: binding.tabSessionId,
      request: {
        requestId,
        toolName,
        title,
        argsSummary,
        rawInput,
        options,
      },
    });
  }

  private handleSessionUpdate(sessionId: string, update: Record<string, unknown>): void {
    const updateType = typeof update.sessionUpdate === 'string' ? update.sessionUpdate : '';

    // Available slash commands & active skills apply globally to all chat panes
    if (updateType === 'available_commands_update') {
      const rawCmds = Array.isArray(update.availableCommands) ? update.availableCommands : [];
      const parsed = rawCmds
        .filter((c): c is Record<string, unknown> => Boolean(c && typeof c === 'object'))
        .map((c) => ({
          name: String(c.name || '').trim(),
          description: String(c.description || '').trim(),
        }))
        .filter((c) => Boolean(c.name));
      if (parsed.length > 0) {
        this.cachedCommands = parsed;
        this.emit({ type: 'commands_update', commands: parsed });
      }
      return;
    }

    const tabSessionId = this.sessionToTab.get(sessionId);
    if (!tabSessionId) return;
    const binding = this.tabBindings.get(tabSessionId);
    if (!binding) return;

    if (updateType === 'session_info_update') {
      const title = typeof update.title === 'string' ? update.title.trim() : '';
      if (title) {
        registerOwnSession({ conversationId: sessionId, title, cwd: binding.cwd });
        this.emit({ type: 'session_title', tabSessionId, title });
      }
      return;
    }

    if (updateType === 'usage_update') {
      const used = Number(update.used || 0);
      const size = Number(update.size || 0);
      if (used > 0 || size > 0) {
        this.emit({ type: 'usage_delta', tabSessionId, used, size });
      }
      return;
    }

    if (binding.cancelledByUser || !binding.inTurn) return;

    if (updateType === 'agent_thought_chunk') {
      const content =
        update.content && typeof update.content === 'object'
          ? (update.content as Record<string, unknown>)
          : null;
      const text = typeof content?.text === 'string' ? content.text : '';
      if (text) {
        this.emit({ type: 'thinking_delta', tabSessionId, delta: text });
      }
      return;
    }

    if (updateType === 'agent_message_chunk') {
      const content =
        update.content && typeof update.content === 'object'
          ? (update.content as Record<string, unknown>)
          : null;
      const text = typeof content?.text === 'string' ? content.text : '';
      if (text) {
        this.emit({ type: 'text_delta', tabSessionId, delta: text });
      }
      return;
    }

    if (updateType === 'tool_call' || updateType === 'tool_call_update') {
      const toolId = String(update.toolCallId || `tool-${Date.now()}`);
      const toolName = String(update.name || 'tool');
      const title = typeof update.title === 'string' ? update.title : undefined;
      const kind = typeof update.kind === 'string' ? update.kind : undefined;
      const status = typeof update.status === 'string' ? update.status : '';
      const rawArgs = update.args ?? update.rawInput;

      // Special native Antigravity meta-tools: live focus & step checklist!
      if (toolName === 'update_focus') {
        const focusText =
          rawArgs && typeof rawArgs === 'object'
            ? String((rawArgs as Record<string, unknown>).focus || '').trim()
            : '';
        if (focusText) {
          this.emit({ type: 'focus_update', tabSessionId, focus: focusText });
        }
        return;
      }

      if (toolName === 'update_steps') {
        const steps = parseStepsPayload(rawArgs);
        if (steps) {
          this.emit({ type: 'steps_update', tabSessionId, steps });
        }
        return;
      }

      if (!binding.emittedToolIds.has(toolId)) {
        binding.emittedToolIds.add(toolId);
        this.emit({
          type: 'tool_use',
          tabSessionId,
          tool: {
            id: toolId,
            name: toolName,
            title,
            kind,
            argsSummary: summarizeToolArgs(toolName, title, rawArgs),
            status: 'running',
            startedAt: Date.now(),
          },
        });
      }

      if (status === 'completed' || status === 'failed' || update.rawOutput !== undefined) {
        const outStr = formatToolOutput(update.rawOutput, update.content);
        this.emit({
          type: 'tool_result',
          tabSessionId,
          toolId,
          output: outStr,
          isError: status === 'failed',
        });

        this.ensureWatcher(binding);
        const metrics = analyzeSingleSession(sessionId, this.quota.getCachedSnapshot());
        if (metrics) {
          this.emit({ type: 'metrics', tabSessionId, metrics });
        }
      }
    }
  }

  private extractAvailableModels(res: Record<string, unknown>): AgyModelOption[] | null {
    const modelsObj =
      res?.models && typeof res.models === 'object'
        ? (res.models as Record<string, unknown>)
        : null;
    const raw = Array.isArray(modelsObj?.availableModels) ? modelsObj!.availableModels : null;
    if (!raw || raw.length === 0) return null;
    const out: AgyModelOption[] = [];
    const seen = new Set<string>();
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      const rec = item as Record<string, unknown>;
      const value = typeof rec.modelId === 'string' ? rec.modelId.trim() : '';
      const label = typeof rec.name === 'string' ? rec.name.trim() : value;
      if (value && !seen.has(value)) {
        seen.add(value);
        out.push({ value, label });
      }
    }
    return out.length > 0 ? out : null;
  }

  private buildPromptBlocks(
    prompt: string,
    attachments?: string[]
  ): Array<Record<string, unknown>> {
    const blocks: Array<Record<string, unknown>> = [];
    const nonImageRefs: string[] = [];

    for (const filePath of attachments || []) {
      if (!filePath) continue;
      const ext = path.extname(filePath).toLowerCase();
      const mimeType = IMAGE_MIME_BY_EXT[ext];
      if (mimeType) {
        try {
          const stat = fs.statSync(filePath);
          if (stat.isFile() && stat.size > 0 && stat.size <= MAX_INLINE_IMAGE_BYTES) {
            const b64 = fs.readFileSync(filePath).toString('base64');
            blocks.push({ type: 'image', mimeType, data: b64 });
            continue;
          }
        } catch {
          // fall back to path reference
        }
      }
      nonImageRefs.push(`[첨부 파일: ${filePath}]`);
    }

    const finalText =
      nonImageRefs.length > 0 ? `${nonImageRefs.join('\n')}\n\n${prompt}` : prompt;
    blocks.push({ type: 'text', text: finalText });
    return blocks;
  }

  private cancelPendingPermissionsForTab(tabSessionId: string): void {
    let clearedAny = false;
    for (const [reqId, pending] of [...this.pendingPermissions.entries()]) {
      if (pending.tabSessionId !== tabSessionId) continue;
      this.pendingPermissions.delete(reqId);
      clearedAny = true;
      if (!pending.daemon.closed) {
        this.sendJsonRpcResponse(pending.daemon, pending.rpcId, {
          outcome: { outcome: 'cancelled' },
        });
      }
    }
    if (clearedAny) {
      this.emit({ type: 'permission_cleared', tabSessionId });
    }
  }

  private ensureWatcher(binding: TabSessionBinding): void {
    if (binding.hasActiveWatcher) return;
    if (resolveTranscriptPath(binding.sessionId)) {
      const initial = this.watchSession(binding.tabSessionId, binding.sessionId);
      binding.hasActiveWatcher = true;
      if (initial) {
        this.emit({ type: 'metrics', tabSessionId: binding.tabSessionId, metrics: initial });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // One-Shot Fallback (CLI-only meta commands: /usage, /help, /changelog)
  // ---------------------------------------------------------------------------

  private killOneShot(tabSessionId: string): void {
    const proc = this.oneShotProcs.get(tabSessionId);
    if (proc) {
      this.oneShotProcs.delete(tabSessionId);
      if (!proc.killed) {
        try {
          proc.kill('SIGTERM');
        } catch {
          // ignore
        }
      }
    }
  }

  private sendOneShotCommand(req: AgySendPromptRequest): { ok: boolean; error?: string } {
    this.killOneShot(req.tabSessionId);
    const agyBin = resolveAgyBinary();
    const cwd = req.cwd && fs.existsSync(req.cwd) ? req.cwd : os.homedir();
    const args = ['--output-format', 'stream-json'];
    if (req.agyConversationId) {
      args.push('--conversation', req.agyConversationId);
    }
    args.push(`-p=${req.prompt.trim()}`);

    let child: ChildProcess;
    try {
      child = spawn(agyBin, args, {
        cwd,
        env: buildAgySpawnEnv(),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }

    this.oneShotProcs.set(req.tabSessionId, child);
    let lineBuf = '';
    let stderrBuf = '';
    let emittedAnyText = false;
    let resultError: string | null = null;
    let finished = false;

    const handleLine = (line: string) => {
      if (!line.startsWith('{')) return;
      try {
        const obj = JSON.parse(line) as Record<string, unknown>;
        const stepObj =
          obj.step_update && typeof obj.step_update === 'object'
            ? (obj.step_update as Record<string, unknown>)
            : undefined;
        const resultObj =
          obj.result && typeof obj.result === 'object'
            ? (obj.result as Record<string, unknown>)
            : undefined;
        if (
          obj.event === 'step_update' &&
          typeof stepObj?.text_delta === 'string' &&
          stepObj.text_delta
        ) {
          emittedAnyText = true;
          this.emit({ type: 'text_delta', tabSessionId: req.tabSessionId, delta: stepObj.text_delta });
        } else if (obj.event === 'result' && resultObj) {
          if (typeof resultObj.status === 'string' && resultObj.status !== 'SUCCESS') {
            resultError =
              (typeof resultObj.error === 'string' && resultObj.error) ||
              `agy exited with status ${resultObj.status}`;
          }
          if (!emittedAnyText && typeof resultObj.response === 'string' && resultObj.response) {
            emittedAnyText = true;
            this.emit({ type: 'text_delta', tabSessionId: req.tabSessionId, delta: resultObj.response });
          }
        } else if (!obj.event && typeof obj.response === 'string' && obj.response && !emittedAnyText) {
          emittedAnyText = true;
          this.emit({ type: 'text_delta', tabSessionId: req.tabSessionId, delta: obj.response });
        }
      } catch {
        // ignore non-JSON line
      }
    };

    const finish = (code: number, spawnErr?: string) => {
      if (finished) return;
      finished = true;
      if (this.oneShotProcs.get(req.tabSessionId) !== child) return;
      if (lineBuf.trim()) handleLine(lineBuf.trim());
      this.oneShotProcs.delete(req.tabSessionId);
      const errText =
        spawnErr ||
        resultError ||
        (code !== 0
          ? stderrBuf
              .trim()
              .split('\n')
              .filter((l) => l.trim() && !l.trim().startsWith('warning:'))
              .slice(-4)
              .join('\n') || `agy exited with code ${code}`
          : undefined);
      this.emit({
        type: 'done',
        tabSessionId: req.tabSessionId,
        exitCode: code,
        error: errText,
      });
    };

    child.stdout?.on('data', (buf: Buffer) => {
      lineBuf += buf.toString('utf8');
      let nl = lineBuf.indexOf('\n');
      while (nl !== -1) {
        const line = lineBuf.slice(0, nl).trim();
        lineBuf = lineBuf.slice(nl + 1);
        if (line) handleLine(line);
        nl = lineBuf.indexOf('\n');
      }
    });

    child.stderr?.on('data', (buf: Buffer) => {
      stderrBuf += buf.toString('utf8');
    });

    child.on('error', (err) => finish(1, err instanceof Error ? err.message : String(err)));
    child.on('close', (code) => finish(code ?? 0));
    return { ok: true };
  }
}
