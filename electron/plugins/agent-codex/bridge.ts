import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  AgentEvent,
  ChatBlock,
  ChatMessage,
  ChatMode,
  ChatStepItem,
  PermissionPrompt,
  QuestionItem,
  SessionMetrics,
  SessionSummary,
  ToolCallItem,
  ToolDeltaSummary,
  TurnHistoryItem,
} from '../../../src/shared/types';
import {
  type AgentModelOption,
  type AgentSendPromptRequest,
  safeTruncateUtf16,
} from '../../../src/shared/agentProtocol';
import { FALLBACK_CODEX_MODELS, type CodexPluginConfig } from '../../../src/plugins/agent-codex/types';
import { TextDeltaCoalescer } from '../agent-core/textDeltaCoalescer';
import type { CodexQuotaService } from './quota';
import {
  buildCodexSpawnEnv,
  CodexAppServerClient,
  CodexRpcError,
  detectCodexCliVersion,
  resolveCodexBinary,
  resolveCodexHome,
} from './rpcClient';

const ADAPTER_ID = 'agent-codex';
const CODEX_AUTH_RE = /authentication required|not logged in|please log in|sign in|unauthorized|missing.*token|auth.*expired/i;
const CODEX_AUTH_METHODS = [
  { id: 'codex-login', label: 'ChatGPT · OpenAI 계정으로 Codex CLI 로그인', description: '브라우저에서 공식 `codex login` 완료' },
];

const CODEX_THREAD_CONFIG: Record<string, unknown> = {
  'tools.update_plan.enabled': true,
  mcp_optional_startup_grace_ms: 10_000,
  'features.concurrent_reasoning_summaries': true,
};

interface CodexPolicyMapping {
  approvalPolicy: unknown;
  approvalsReviewer: string;
  sandbox: string;
  sandboxPolicy: Record<string, unknown>;
}

/**
 * Ported from t3code `CodexAdapterV2.ts:851-899`:
 * NEVER uses `approvalPolicy: "never"` in full-access because Codex silently auto-denies
 * MCP elicitations before reaching the client; uses granular policy instead.
 */
function mapChatModeToCodexPolicies(mode: ChatMode, cwd: string, addDirs?: string[]): CodexPolicyMapping {
  const writableRoots = [cwd, ...(addDirs || []).filter((d) => d && fs.existsSync(d))];
  switch (mode) {
    case 'turbo':
      return {
        approvalPolicy: {
          granular: {
            mcp_elicitations: true,
            request_permissions: false,
            rules: false,
            sandbox_approval: false,
            skill_approval: false,
          },
        },
        approvalsReviewer: 'user',
        sandbox: 'danger-full-access',
        sandboxPolicy: { type: 'dangerFullAccess' },
      };
    case 'auto':
      return {
        approvalPolicy: 'on-request',
        approvalsReviewer: 'auto_review',
        sandbox: 'workspace-write',
        sandboxPolicy: { type: 'workspaceWrite', writableRoots },
      };
    case 'accept-edits':
      return {
        approvalPolicy: 'on-request',
        approvalsReviewer: 'user',
        sandbox: 'workspace-write',
        sandboxPolicy: { type: 'workspaceWrite', writableRoots },
      };
    case 'plan':
    case 'strict':
    default:
      return {
        approvalPolicy: 'untrusted',
        approvalsReviewer: 'user',
        sandbox: 'read-only',
        sandboxPolicy: { type: 'readOnly' },
      };
  }
}

interface RawFileChange {
  path?: string;
  diff?: string;
  kind?: { type?: string; move_path?: string | null };
}

/**
 * Ported from t3code `CodexAdapterV2.ts:184-210`:
 * For `add` and `delete` fileChanges, Codex sends raw file content rather than unified diff.
 */
function formatFileChangesPreview(changes: RawFileChange[]): string {
  const chunks: string[] = [];
  for (const ch of changes) {
    const filePath = ch.path || 'unknown';
    const kindType = ch.kind?.type || 'update';
    const raw = ch.diff || '';
    if (kindType === 'add' && raw && !raw.startsWith('---') && !raw.startsWith('diff --git')) {
      const lines = raw.split('\n');
      chunks.push(
        `diff --git a/${filePath} b/${filePath}\n--- /dev/null\n+++ b/${filePath}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join('\n')}`
      );
    } else if (kindType === 'delete' && raw && !raw.startsWith('---') && !raw.startsWith('diff --git')) {
      const lines = raw.split('\n');
      chunks.push(
        `diff --git a/${filePath} b/${filePath}\n--- a/${filePath}\n+++ /dev/null\n@@ -1,${lines.length} +0,0 @@\n${lines.map((l) => `-${l}`).join('\n')}`
      );
    } else {
      chunks.push(raw ? `${filePath} (${kindType})\n${raw}` : `${filePath} (${kindType})`);
    }
  }
  return safeTruncateUtf16(chunks.join('\n\n'), 1500);
}

interface TokenBaseline {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

interface ActiveThreadState {
  tabSessionId: string;
  threadId: string;
  cwd: string;
  mode: ChatMode;
  model: string;
  activeTurnId: string | null;
  pendingTurnStart: boolean;
  interrupting: boolean;
  overloadRetries: number;
  emittedFinalTexts: Set<string>;
  activeToolIds: Set<string>;
  fileChangeCache: Map<string, RawFileChange[]>; // itemId -> changes (needed by requestApproval!)
  sessionAllowance: Set<string>;
  latestErrorText: string | null;
  tokenBaseline: TokenBaseline | null;
  invocations: number;
  sessionCumulative: number;
  totalInputForCache: number;
  totalCacheRead: number;
  contextWindow: number;
  lastContextUsed: number;
  pendingToolNames: string[];
  toolDeltaMap: Map<string, { count: number; deltaTokens: number }>;
  recentTurns: TurnHistoryItem[];
  turnStartedAt: number;
}

interface PendingPermission {
  resolve: (optionId: string | null) => void;
}

interface PendingQuestion {
  resolve: (answers: Record<string, string | string[]> | null) => void;
}

/**
 * Clean Pure-TS L2 harness bridge for OpenAI Codex (`codex app-server --stdio`).
 * Ported from t3code `CodexAdapterV2` + `CodexTurnTokenUsage` + `CodexMcpElicitation`
 * with ZERO Effect-TS and ZERO T3 telemetry/cloud calls.
 */
export class CodexPluginBridge {
  private readonly getConfig: () => Readonly<CodexPluginConfig>;
  private readonly emit: (ev: AgentEvent) => void;
  private quota: CodexQuotaService | null = null;

  private client: CodexAppServerClient | null = null;
  private clientConfigKey = '';
  private cachedSummarySetting: string | null = null;
  private cachedDefaultModel: string | null = null;
  private cachedVersion: string | null = null;
  private cachedModels: { items: AgentModelOption[]; fetchedAt: number } | null = null;
  private activeLoginProc: ChildProcess | null = null;
  private activeLoginPromise: Promise<{ ok: boolean; error?: string }> | null = null;

  private readonly tabToThread = new Map<string, ActiveThreadState>();
  private readonly threadToTab = new Map<string, string>();
  private readonly closedThreadWaiters = new Map<string, Array<() => void>>();
  private readonly pendingPermissions = new Map<string, PendingPermission>();
  private readonly pendingQuestions = new Map<string, PendingQuestion>();
  private readonly textCoalescer: TextDeltaCoalescer;
  private readonly thinkingCoalescer: TextDeltaCoalescer;

  constructor(opts: {
    getConfig: () => Readonly<CodexPluginConfig>;
    emit: (ev: AgentEvent) => void;
  }) {
    this.getConfig = opts.getConfig;
    this.emit = opts.emit;

    this.textCoalescer = new TextDeltaCoalescer({
      flushIntervalMs: 50,
      onFlush: ({ turnId, delta }) => {
        const tabSessionId = turnId.split('::')[0];
        if (tabSessionId && delta) {
          this.emit({ type: 'text_delta', adapterId: ADAPTER_ID, tabSessionId, delta });
        }
      },
    });
    this.thinkingCoalescer = new TextDeltaCoalescer({
      flushIntervalMs: 50,
      onFlush: ({ turnId, delta }) => {
        const tabSessionId = turnId.split('::')[0];
        if (tabSessionId && delta) {
          this.emit({ type: 'thinking_delta', adapterId: ADAPTER_ID, tabSessionId, delta });
        }
      },
    });
  }

  attachQuotaService(quota: CodexQuotaService): void {
    this.quota = quota;
  }

  private emitAuthRequired(tabSessionId: string): void {
    this.emit({
      type: 'auth_required',
      adapterId: ADAPTER_ID,
      tabSessionId,
      title: 'Codex CLI 로그인 필요',
      mode: 'acp',
      message:
        '로컬 Codex CLI 로그인이 필요합니다. 아래 버튼을 누르면 브라우저에서 공식 `codex login`을 바로 완료할 수 있습니다.',
      methods: CODEX_AUTH_METHODS,
    });
  }

  async startCliLogin(): Promise<{ ok: boolean; error?: string }> {
    if (this.activeLoginPromise) return this.activeLoginPromise;

    const cfg = this.getConfig();
    const bin = resolveCodexBinary(cfg.cliPath);

    this.activeLoginPromise = new Promise<{ ok: boolean; error?: string }>((resolve) => {
      let settled = false;
      let errBuf = '';
      const finish = (res: { ok: boolean; error?: string }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.activeLoginProc = null;
        this.activeLoginPromise = null;
        resolve(res);
      };

      let proc: ChildProcess;
      try {
        proc = spawn(bin, ['login'], {
          cwd: os.homedir(),
          env: buildCodexSpawnEnv({ codexHome: cfg.codexHome }),
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (err) {
        finish({
          ok: false,
          error:
            err instanceof Error && /ENOENT/i.test(err.message)
              ? 'Codex CLI(`codex`)가 설치되어 있지 않습니다. `npm install -g @openai/codex` 또는 ChatGPT 앱 설치 후 다시 시도해 주세요.'
              : err instanceof Error
                ? err.message
                : 'codex login 실행에 실패했습니다.',
        });
        return;
      }

      this.activeLoginProc = proc;
      const timer = setTimeout(() => {
        try {
          proc.kill('SIGTERM');
        } catch {
          // ignore
        }
        finish({ ok: false, error: '로그인 대기 시간이 초과되었습니다 (3분). 다시 시도해 주세요.' });
      }, 180_000);

      proc.stderr?.on('data', (chunk: Buffer) => {
        errBuf = (errBuf + chunk.toString('utf8')).slice(-2048);
      });
      proc.on('error', (err) => {
        const msg = /ENOENT/i.test(err.message)
          ? 'Codex CLI(`codex`)가 설치되어 있지 않습니다. `npm install -g @openai/codex` 또는 ChatGPT 앱 설치 후 다시 시도해 주세요.'
          : err.message;
        finish({ ok: false, error: msg });
      });
      proc.on('close', (code) => {
        if (code === 0) {
          this.cachedVersion = null;
          this.cachedModels = null;
          this.client?.dispose();
          this.client = null;
          void this.quota?.fetchLiveQuota(true);
          this.emit({ type: 'auth_cleared', adapterId: ADAPTER_ID, tabSessionId: '' });
          finish({ ok: true });
        } else {
          const cleanErr = errBuf.trim().split('\n').slice(-2).join(' ');
          finish({ ok: false, error: cleanErr || `Codex CLI 로그인이 완료되지 않았습니다 (code ${code ?? 1}).` });
        }
      });
    });

    return this.activeLoginPromise;
  }

  cancelCliLogin(): boolean {
    if (!this.activeLoginProc) return false;
    try {
      this.activeLoginProc.kill('SIGTERM');
    } catch {
      // ignore
    }
    return true;
  }

  getClient(): CodexAppServerClient {
    const cfg = this.getConfig();
    const key = `${cfg.cliPath || ''}\0${cfg.codexHome || ''}`;
    if (this.client && this.clientConfigKey === key) {
      return this.client;
    }
    this.client?.dispose();
    this.clientConfigKey = key;
    this.cachedSummarySetting = null;
    this.cachedDefaultModel = null;
    this.client = new CodexAppServerClient({
      cliPath: cfg.cliPath || undefined,
      codexHome: cfg.codexHome || undefined,
      onNotification: (method, params) => this.handleNotification(method, params),
      onServerRequest: (method, params, reqId, signal) =>
        this.handleServerRequest(method, params, reqId, signal),
      onUnexpectedClose: (reason) => {
        for (const state of this.tabToThread.values()) {
          if (state.activeTurnId || state.pendingTurnStart) {
            state.activeTurnId = null;
            state.pendingTurnStart = false;
            this.emit({
              type: 'done',
              adapterId: ADAPTER_ID,
              tabSessionId: state.tabSessionId,
              exitCode: 1,
              error: reason,
            });
          }
        }
      },
    });
    return this.client;
  }

  detectVersion(): string {
    if (this.cachedVersion !== null) return this.cachedVersion;
    const cfg = this.getConfig();
    this.cachedVersion = detectCodexCliVersion(cfg.cliPath, cfg.codexHome);
    return this.cachedVersion;
  }

  async listModels(force = false): Promise<AgentModelOption[]> {
    if (!force && this.cachedModels && Date.now() - this.cachedModels.fetchedAt < 300_000) {
      return this.cachedModels.items;
    }
    try {
      const client = this.getClient();
      await client.ensureStarted();
      const collected: AgentModelOption[] = [{ value: 'default', label: '기본 모델 (Codex)' }];
      const seen = new Set<string>(['default']);
      let cursor: string | undefined;

      for (let page = 0; page < 4; page++) {
        const resp = (await client.request(
          'model/list',
          cursor ? { cursor } : {},
          10_000
        )) as {
          data?: Array<{
            id?: string;
            slug?: string;
            displayName?: string;
            name?: string;
            description?: string;
            hidden?: boolean;
            isDefault?: boolean;
            supportedReasoningEfforts?: Array<string | { effort?: string; reasoningEffort?: string }>;
            defaultReasoningEffort?: string;
          }>;
          nextCursor?: string | null;
        };

        for (const m of resp?.data || []) {
          if (m.hidden === true) continue;
          const val = String(m.slug || m.id || '').trim();
          if (!val || seen.has(val)) continue;
          seen.add(val);
          const efforts = Array.isArray(m.supportedReasoningEfforts)
            ? m.supportedReasoningEfforts
                .map((e) => (typeof e === 'string' ? e : String(e?.reasoningEffort || e?.effort || '')))
                .filter(Boolean)
            : undefined;
          const displayLabel = String(m.displayName || m.name || val);
          if (m.isDefault) {
            collected[0] = {
              value: 'default',
              label: `기본 모델 (${displayLabel})`,
              resolvedModel: val,
              badge: { label: '추천', tone: 'new' },
              supportedEfforts: efforts && efforts.length > 0 ? efforts : undefined,
              defaultEffort: m.defaultReasoningEffort || undefined,
            };
          }
          collected.push({
            value: val,
            label: displayLabel,
            description: m.description || undefined,
            supportedEfforts: efforts && efforts.length > 0 ? efforts : undefined,
            defaultEffort: m.defaultReasoningEffort || undefined,
          });
        }
        if (!resp?.nextCursor) break;
        cursor = resp.nextCursor;
      }

      if (collected.length > 1) {
        this.cachedModels = { items: collected, fetchedAt: Date.now() };
        return collected;
      }
    } catch {
      // Fallback to local models_cache.json
      const fromCache = this.readModelsCacheFallback();
      if (fromCache.length > 1) {
        this.cachedModels = { items: fromCache, fetchedAt: Date.now() };
        return fromCache;
      }
    }
    return FALLBACK_CODEX_MODELS;
  }

  private readModelsCacheFallback(): AgentModelOption[] {
    const out: AgentModelOption[] = [{ value: 'default', label: '기본 모델 (Codex)' }];
    try {
      const cachePath = path.join(resolveCodexHome(this.getConfig().codexHome), 'models_cache.json');
      if (!fs.existsSync(cachePath)) return out;
      const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as {
        models?: Array<{
          slug?: string;
          display_name?: string;
          visibility?: string;
          default_reasoning_level?: string;
          supported_reasoning_levels?: Array<string | { effort?: string; reasoningEffort?: string }>;
        }>;
      };
      const seen = new Set<string>(['default']);
      for (const m of parsed?.models || []) {
        if (m.visibility === 'hide') continue;
        const slug = String(m.slug || '').trim();
        if (!slug || seen.has(slug)) continue;
        seen.add(slug);
        const efforts = Array.isArray(m.supported_reasoning_levels)
          ? m.supported_reasoning_levels
              .map((e) => (typeof e === 'string' ? e : String(e?.reasoningEffort || e?.effort || '')))
              .filter(Boolean)
          : undefined;
        out.push({
          value: slug,
          label: String(m.display_name || slug),
          supportedEfforts: efforts && efforts.length > 0 ? efforts : undefined,
          defaultEffort: m.default_reasoning_level || undefined,
        });
      }
    } catch {
      // ignore
    }
    return out;
  }

  async listSessions(limit = 30): Promise<SessionSummary[]> {
    try {
      const client = this.getClient();
      await client.ensureStarted();
      const resp = (await client.request(
        'thread/list',
        { limit: Math.min(limit, 60), sortKey: 'updated_at', sortDirection: 'desc' },
        10_000
      )) as {
        data?: Array<{
          id?: string;
          name?: string | null;
          preview?: string | null;
          cwd?: string | null;
          updatedAt?: number | string | null;
          model?: string | null;
        }>;
      };
      const items: SessionSummary[] = [];
      for (const t of resp?.data || []) {
        if (!t.id) continue;
        const rawUpdated = t.updatedAt;
        const ts =
          typeof rawUpdated === 'number'
            ? rawUpdated > 1e12
              ? rawUpdated
              : rawUpdated * 1000
            : typeof rawUpdated === 'string'
              ? Date.parse(rawUpdated)
              : Date.now();
        const cwd = t.cwd || '';
        const title = (t.name || t.preview || t.id.slice(0, 8)).replace(/\s+/g, ' ').trim();
        items.push({
          adapterId: ADAPTER_ID,
          conversationId: t.id,
          source: 'cli',
          title: safeTruncateUtf16(title, 48),
          projectId: cwd || 'codex',
          projectLabel: cwd ? path.basename(cwd).normalize('NFC') : 'Codex',
          cwd: cwd || undefined,
          updatedAt: Number.isNaN(ts) ? Date.now() : ts,
          currentContext: 0,
          model: t.model || 'codex',
        });
      }
      return items;
    } catch {
      return [];
    }
  }

  async loadSession(threadId: string): Promise<{ messages: ChatMessage[]; metrics: SessionMetrics | null }> {
    try {
      const client = this.getClient();
      await client.ensureStarted();
      const resp = (await client.request(
        'thread/read',
        { threadId, includeTurns: true },
        15_000
      )) as {
        thread?: {
          id?: string;
          model?: string;
          turns?: Array<{
            id?: string;
            startedAt?: number;
            items?: Array<Record<string, unknown>>;
          }>;
        };
      };
      const messages: ChatMessage[] = [];
      for (const turn of resp?.thread?.turns || []) {
        const ts = typeof turn.startedAt === 'number' ? (turn.startedAt > 1e12 ? turn.startedAt : turn.startedAt * 1000) : Date.now();
        const blocks: ChatBlock[] = [];
        const tools: ToolCallItem[] = [];
        let assistantText = '';
        let thinkingText = '';

        for (const item of turn.items || []) {
          const iType = String(item.type || '');
          if (iType === 'userMessage') {
            const content = Array.isArray(item.content) ? (item.content as Array<Record<string, unknown>>) : [];
            const txt = content
              .map((c) => (typeof c.text === 'string' ? c.text : ''))
              .filter(Boolean)
              .join('\n')
              .trim();
            if (txt) {
              messages.push({
                id: String(item.id || `u-${messages.length}`),
                role: 'user',
                text: txt,
                createdAt: ts,
              });
            }
          } else if (iType === 'agentMessage' && typeof item.text === 'string' && item.text) {
            assistantText = assistantText ? `${assistantText}\n\n${item.text}` : item.text;
            blocks.push({ id: String(item.id || `tx-${blocks.length}`), type: 'text', text: item.text });
          } else if (iType === 'reasoning') {
            const sum = Array.isArray(item.summary) ? item.summary.join('\n') : '';
            const cont = Array.isArray(item.content) ? item.content.join('\n') : '';
            const txt = (sum || cont).trim();
            if (txt) {
              thinkingText += txt;
              blocks.push({ id: String(item.id || `th-${blocks.length}`), type: 'thinking', text: txt, startedAt: ts, endedAt: ts });
            }
          } else if (iType === 'commandExecution' || iType === 'fileChange' || iType === 'mcpToolCall' || iType === 'webSearch') {
            const tc = this.buildToolCallItem(item, 'done');
            tools.push(tc);
            blocks.push({ id: `tb-${tc.id}`, type: 'tool', tool: tc });
          }
        }

        if (blocks.length > 0) {
          messages.push({
            id: String(turn.id || `a-${messages.length}`),
            role: 'assistant',
            text: assistantText,
            thinking: thinkingText || undefined,
            tools: tools.length > 0 ? tools : undefined,
            blocks,
            createdAt: ts,
            endedAt: ts,
          });
        }
      }
      return { messages: messages.slice(-80), metrics: null };
    } catch {
      return { messages: [], metrics: null };
    }
  }

  respondPermission(_tabSessionId: string, requestId: string, optionId: string | null): boolean {
    const p = this.pendingPermissions.get(requestId);
    if (!p) return false;
    this.pendingPermissions.delete(requestId);
    p.resolve(optionId);
    return true;
  }

  respondQuestion(_tabSessionId: string, requestId: string, answers: Record<string, string | string[]> | null): boolean {
    const q = this.pendingQuestions.get(requestId);
    if (!q) return false;
    this.pendingQuestions.delete(requestId);
    q.resolve(answers);
    return true;
  }

  async cancelTurn(tabSessionId: string): Promise<void> {
    const state = this.tabToThread.get(tabSessionId);
    if (!state || !state.activeTurnId) return;
    state.interrupting = true;
    const turnKey = `${tabSessionId}::${state.activeTurnId}`;
    this.textCoalescer.flushTurn(turnKey);
    this.thinkingCoalescer.flushTurn(turnKey);
    try {
      const client = this.getClient();
      if (client.isAlive) {
        await client.request('turn/interrupt', { threadId: state.threadId, turnId: state.activeTurnId }, 10_000);
      }
    } catch {
      // ignore interrupt errors
    }
  }

  async sendPrompt(req: AgentSendPromptRequest): Promise<{ ok: boolean; error?: string; authRequired?: boolean }> {
    const cfg = this.getConfig();
    const cwd = req.cwd && fs.existsSync(req.cwd) ? req.cwd : os.homedir();
    const effectiveModel = req.model && req.model !== 'default' ? req.model : cfg.defaultModel || 'default';
    const effectiveEffort = req.effort && req.effort !== 'default' ? req.effort : cfg.defaultEffort || 'xhigh';
    const effectiveMode: ChatMode = req.mode || cfg.localPermission || 'auto';
    const policies = mapChatModeToCodexPolicies(effectiveMode, cwd, req.addDirs);

    try {
      const client = this.getClient();
      await client.ensureStarted();

      // Read reasoning summary & default model once (never hardcode "detailed" — Bedrock rejects it)
      if (this.cachedSummarySetting === null) {
        try {
          const conf = (await client.request('config/read', { includeLayers: false }, 10_000)) as {
            config?: { model_reasoning_summary?: string; model?: string };
          };
          this.cachedSummarySetting = conf?.config?.model_reasoning_summary || 'auto';
          if (conf?.config?.model) {
            this.cachedDefaultModel = conf.config.model;
          }
        } catch {
          this.cachedSummarySetting = 'auto';
        }
      }

      const requestedThreadId = req.externalSessionId ?? req.agyConversationId ?? null;
      let state = this.tabToThread.get(req.tabSessionId);

      // Steer active turn if user sent message while already running
      if (state && state.activeTurnId && !state.interrupting) {
        const input = this.buildUserInput(req);
        await client.request(
          'turn/steer',
          { threadId: state.threadId, expectedTurnId: state.activeTurnId, input },
          30_000
        );
        return { ok: true };
      }

      // Start or resume thread
      if (!state || (requestedThreadId && state.threadId !== requestedThreadId)) {
        const threadParams: Record<string, unknown> = {
          cwd,
          config: CODEX_THREAD_CONFIG,
          approvalPolicy: policies.approvalPolicy,
          approvalsReviewer: policies.approvalsReviewer,
          sandbox: policies.sandbox,
          ...(effectiveModel && effectiveModel !== 'default' ? { model: effectiveModel } : {}),
        };

        let threadId: string;
        let resolvedModel = effectiveModel;
        if (requestedThreadId) {
          const resumed = await this.resumeThreadWithRecovery(client, requestedThreadId, threadParams);
          threadId = resumed.threadId;
          if (resumed.model && effectiveModel === 'default') resolvedModel = resumed.model;
        } else {
          const started = (await client.request('thread/start', threadParams, 60_000)) as {
            thread?: { id?: string };
            model?: string;
          };
          if (!started?.thread?.id) {
            throw new Error('codex thread/start 응답에 thread.id가 없습니다.');
          }
          threadId = started.thread.id;
          if (started.model && effectiveModel === 'default') resolvedModel = started.model;
        }

        state = {
          tabSessionId: req.tabSessionId,
          threadId,
          cwd,
          mode: effectiveMode,
          model: resolvedModel,
          activeTurnId: null,
          pendingTurnStart: false,
          interrupting: false,
          overloadRetries: 0,
          emittedFinalTexts: new Set(),
          activeToolIds: new Set(),
          fileChangeCache: new Map(),
          sessionAllowance: new Set(),
          latestErrorText: null,
          tokenBaseline: null,
          invocations: 0,
          sessionCumulative: 0,
          totalInputForCache: 0,
          totalCacheRead: 0,
          contextWindow: 400_000,
          lastContextUsed: 0,
          pendingToolNames: [],
          toolDeltaMap: new Map(),
          recentTurns: [],
          turnStartedAt: 0,
        };
        this.tabToThread.set(req.tabSessionId, state);
        this.threadToTab.set(threadId, req.tabSessionId);

        this.emit({
          type: 'session_init',
          adapterId: ADAPTER_ID,
          tabSessionId: req.tabSessionId,
          agyConversationId: threadId,
          model: resolvedModel !== 'default' ? resolvedModel : undefined,
        });
      } else {
        if (state.mode !== effectiveMode) {
          state.sessionAllowance.clear();
          state.mode = effectiveMode;
        }
        if (effectiveModel !== 'default') state.model = effectiveModel;
      }

      // Register pendingTurnStart BEFORE turn/start RPC to eliminate turn/started arrival race!
      state.pendingTurnStart = true;
      state.turnStartedAt = Date.now();
      state.pendingToolNames = [];
      state.interrupting = false;
      state.overloadRetries = 0;
      state.emittedFinalTexts.clear();
      state.activeToolIds.clear();
      state.latestErrorText = null;

      const input = this.buildUserInput(req);
      const turnModel =
        effectiveModel && effectiveModel !== 'default'
          ? effectiveModel
          : state.model && state.model !== 'default'
            ? state.model
            : this.cachedDefaultModel || undefined;
      const turnParams: Record<string, unknown> = {
        threadId: state.threadId,
        input,
        cwd,
        approvalPolicy: policies.approvalPolicy,
        approvalsReviewer: policies.approvalsReviewer,
        sandboxPolicy: policies.sandboxPolicy,
        summary: this.cachedSummarySetting || 'auto',
        ...(turnModel ? { model: turnModel } : {}),
        ...(effectiveEffort && effectiveEffort !== 'default' ? { effort: effectiveEffort } : {}),
        // Always explicitly set collaborationMode when model is resolved so plan mode doesn't leak into subsequent turns
        ...(turnModel
          ? {
              collaborationMode: {
                mode: effectiveMode === 'plan' ? 'plan' : 'default',
                settings: {
                  model: turnModel,
                  ...(effectiveEffort && effectiveEffort !== 'default'
                    ? { reasoning_effort: effectiveEffort }
                    : {}),
                },
              },
            }
          : {}),
      };

      const turnRes = (await client.request('turn/start', turnParams, 120_000)) as {
        turn?: { id?: string };
      };
      if (turnRes?.turn?.id && !state.activeTurnId) {
        state.activeTurnId = turnRes.turn.id;
      }
      return { ok: true };
    } catch (err) {
      const msg = this.formatFriendlyCodexError(err);
      const st = this.tabToThread.get(req.tabSessionId);
      if (st) st.pendingTurnStart = false;
      if (CODEX_AUTH_RE.test(msg)) {
        this.emitAuthRequired(req.tabSessionId);
        return { ok: false, authRequired: true, error: 'Codex CLI 로그인이 필요합니다.' };
      }
      if (/ENOENT|spawn .*codex/i.test(msg)) {
        return {
          ok: false,
          error:
            'Codex CLI(`codex`)가 설치되어 있지 않습니다. 터미널에서 `npm install -g @openai/codex` 후 `codex login`을 실행해 주세요.',
        };
      }
      return { ok: false, error: msg };
    }
  }

  private async resumeThreadWithRecovery(
    client: CodexAppServerClient,
    threadId: string,
    baseParams: Record<string, unknown>
  ): Promise<{ threadId: string; model?: string }> {
    const callResume = () =>
      client.request<{ thread?: { id?: string }; model?: string }>(
        'thread/resume',
        { ...baseParams, threadId, excludeTurns: true },
        60_000
      );

    try {
      const res = await callResume();
      return { threadId: res?.thread?.id || threadId, model: res?.model };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Auto-recover archived thread (`session <id> is archived` / `codex unarchive`)
      if (msg.includes('is archived') || msg.includes('codex unarchive')) {
        await client.request('thread/unarchive', { threadId }, 15_000);
        const res = await callResume();
        return { threadId: res?.thread?.id || threadId, model: res?.model };
      }
      // Auto-recover closing thread (`thread <id> is closing`)
      if (msg.includes('is closing')) {
        await this.waitForThreadClosed(threadId, 5000);
        const res = await callResume();
        return { threadId: res?.thread?.id || threadId, model: res?.model };
      }
      throw err;
    }
  }

  private waitForThreadClosed(threadId: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      const list = this.closedThreadWaiters.get(threadId) || [];
      list.push(() => {
        clearTimeout(timer);
        resolve();
      });
      this.closedThreadWaiters.set(threadId, list);
    });
  }

  private buildUserInput(req: AgentSendPromptRequest): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = [];
    if (req.images && req.images.length > 0) {
      for (const imgPath of req.images) {
        if (/\.(png|jpe?g|webp|gif|bmp)$/i.test(imgPath)) {
          out.push({ type: 'localImage', path: imgPath });
        } else {
          out.push({ type: 'text', text: `[첨부 파일: ${imgPath}]` });
        }
      }
    }
    out.push({ type: 'text', text: req.prompt });
    return out;
  }

  private formatFriendlyCodexError(err: unknown): string {
    if (err instanceof CodexRpcError && err.code === -32600 && err.message.includes('already has an active writer')) {
      return '이 Codex 스레드는 다른 클라이언트(Codex 앱/CLI/IDE)가 이미 사용 중입니다. 해당 창을 닫거나 새 채팅을 시작하세요.';
    }
    return err instanceof Error ? err.message : String(err);
  }

  private getStateByThread(threadId: unknown): ActiveThreadState | null {
    if (typeof threadId !== 'string' || !threadId) return null;
    const tabId = this.threadToTab.get(threadId);
    if (!tabId) return null;
    return this.tabToThread.get(tabId) || null;
  }

  private handleNotification(method: string, params: Record<string, unknown>): void {
    if (method === 'account/rateLimits/updated') {
      const rl = params.rateLimits as Record<string, unknown> | undefined;
      if (rl) this.quota?.applySparseUpdate(rl);
      return;
    }

    if (method === 'thread/closed') {
      const tid = typeof params.threadId === 'string' ? params.threadId : '';
      const waiters = this.closedThreadWaiters.get(tid);
      if (waiters) {
        this.closedThreadWaiters.delete(tid);
        for (const w of waiters) w();
      }
      return;
    }

    const state = this.getStateByThread(params.threadId);
    if (!state) return;
    const turnId = String(params.turnId || state.activeTurnId || 'turn');
    const turnKey = `${state.tabSessionId}::${turnId}`;

    if (method === 'turn/started') {
      const turn = params.turn as Record<string, unknown> | undefined;
      if (typeof turn?.id === 'string' && turn.id) {
        state.activeTurnId = turn.id;
      }
      state.pendingTurnStart = false;
      return;
    }

    if (method === 'item/agentMessage/delta') {
      const delta = typeof params.delta === 'string' ? params.delta : '';
      const itemId = String(params.itemId || 'msg');
      if (delta) this.textCoalescer.append(turnKey, itemId, delta);
      return;
    }

    if (method === 'item/reasoning/summaryTextDelta' || method === 'item/reasoning/textDelta') {
      const delta = typeof params.delta === 'string' ? params.delta : '';
      const idx = params.summaryIndex ?? params.contentIndex ?? 0;
      const itemId = `${String(params.itemId || 'r')}:${method.includes('summary') ? 's' : 'c'}:${String(idx)}`;
      if (delta) this.thinkingCoalescer.append(turnKey, itemId, delta);
      return;
    }

    if (method === 'item/commandExecution/outputDelta' || method === 'item/fileChange/outputDelta') {
      const delta = typeof params.delta === 'string' ? params.delta : '';
      const itemId = String(params.itemId || '');
      if (delta && itemId) {
        this.emit({
          type: 'tool_delta',
          adapterId: ADAPTER_ID,
          tabSessionId: state.tabSessionId,
          toolId: itemId,
          delta,
        });
      }
      return;
    }

    if (method === 'turn/plan/updated') {
      const plan = Array.isArray(params.plan) ? (params.plan as Array<Record<string, unknown>>) : [];
      const steps: ChatStepItem[] = plan.map((p) => {
        const st = String(p.status || 'pending');
        return {
          title: String(p.step || ''),
          status: st === 'completed' ? 'done' : st === 'inProgress' ? 'in_progress' : 'pending',
        };
      });
      if (steps.length > 0) {
        this.emit({ type: 'steps_update', adapterId: ADAPTER_ID, tabSessionId: state.tabSessionId, steps });
      }
      return;
    }

    if (method === 'item/fileChange/patchUpdated') {
      const itemId = String(params.itemId || '');
      if (itemId && Array.isArray(params.changes)) {
        state.fileChangeCache.set(itemId, params.changes as RawFileChange[]);
      }
      return;
    }

    if (method === 'item/started') {
      const item = params.item as Record<string, unknown> | undefined;
      if (!item) return;
      const iType = String(item.type || '');
      const itemId = String(item.id || `item-${Date.now()}`);

      if (iType === 'fileChange' && Array.isArray(item.changes)) {
        state.fileChangeCache.set(itemId, item.changes as RawFileChange[]);
      }

      if (
        iType === 'commandExecution' ||
        iType === 'fileChange' ||
        iType === 'mcpToolCall' ||
        iType === 'dynamicToolCall' ||
        iType === 'webSearch'
      ) {
        this.textCoalescer.flushTurn(turnKey);
        this.thinkingCoalescer.flushTurn(turnKey);
        state.activeToolIds.add(itemId);
        this.emit({
          type: 'tool_use',
          adapterId: ADAPTER_ID,
          tabSessionId: state.tabSessionId,
          tool: this.buildToolCallItem(item, 'running'),
        });
      } else if (iType === 'contextCompaction') {
        this.emit({
          type: 'focus_update',
          adapterId: ADAPTER_ID,
          tabSessionId: state.tabSessionId,
          focus: '컨텍스트 자동 압축 중…',
        });
      }
      return;
    }

    if (method === 'item/completed') {
      const item = params.item as Record<string, unknown> | undefined;
      if (!item) return;
      const iType = String(item.type || '');
      const itemId = String(item.id || '');

      if (iType === 'agentMessage') {
        this.textCoalescer.complete(turnKey, itemId);
        return;
      }

      if (iType === 'plan' && typeof item.text === 'string' && item.text.trim()) {
        this.emit({
          type: 'plan_proposed',
          adapterId: ADAPTER_ID,
          tabSessionId: state.tabSessionId,
          plan: item.text,
        });
        return;
      }

      if (
        iType === 'commandExecution' ||
        iType === 'fileChange' ||
        iType === 'mcpToolCall' ||
        iType === 'dynamicToolCall' ||
        iType === 'webSearch'
      ) {
        state.activeToolIds.delete(itemId);
        const toolLabel =
          iType === 'commandExecution'
            ? 'Bash'
            : iType === 'fileChange'
              ? 'Edit'
              : iType === 'webSearch'
                ? 'WebSearch'
                : String(item.tool || item.name || iType);
        state.pendingToolNames.push(toolLabel);
        const status = String(item.status || 'completed');
        const isError = status === 'failed' || status === 'declined' || Boolean(item.error);
        let output = '';
        if (iType === 'commandExecution') {
          const exitCode = typeof item.exitCode === 'number' ? `[exit ${item.exitCode}]\n` : '';
          output = `${exitCode}${String(item.aggregatedOutput || '')}`.trim();
        } else if (iType === 'fileChange') {
          const chs = Array.isArray(item.changes)
            ? (item.changes as RawFileChange[])
            : state.fileChangeCache.get(itemId) || [];
          output = formatFileChangesPreview(chs);
        } else if (iType === 'mcpToolCall') {
          const res = item.result as Record<string, unknown> | undefined;
          const err = item.error as Record<string, unknown> | undefined;
          output = err?.message
            ? String(err.message)
            : typeof res?.content === 'string'
              ? res.content
              : res
                ? JSON.stringify(res).slice(0, 800)
                : '';
        } else if (iType === 'webSearch') {
          output = String(item.query || '');
        }
        this.emit({
          type: 'tool_result',
          adapterId: ADAPTER_ID,
          tabSessionId: state.tabSessionId,
          toolId: itemId,
          output: safeTruncateUtf16(output, 1500),
          isError,
        });
      }
      return;
    }

    if (method === 'thread/tokenUsage/updated') {
      this.handleTokenUsageUpdate(state, params);
      return;
    }

    if (method === 'error') {
      const errObj = params.error as Record<string, unknown> | undefined;
      const errMsg = typeof errObj?.message === 'string' ? errObj.message : 'Codex 오류';
      if (params.willRetry === true) {
        this.emit({
          type: 'focus_update',
          adapterId: ADAPTER_ID,
          tabSessionId: state.tabSessionId,
          focus: `재시도 중: ${safeTruncateUtf16(errMsg, 60)}`,
        });
      } else {
        state.latestErrorText = errMsg;
      }
      return;
    }

    if (method === 'turn/completed') {
      const turn = params.turn as Record<string, unknown> | undefined;
      const status = String(turn?.status || 'completed');
      const errObj = turn?.error as Record<string, unknown> | undefined;
      const codexErrInfo = errObj?.codexErrorInfo;

      // Auto-retry serverOverloaded with exponential backoff (t3code resilience)
      if (status === 'failed' && codexErrInfo === 'serverOverloaded' && state.overloadRetries < 3) {
        state.overloadRetries += 1;
        const delayMs = Math.min(30_000, 2000 * 2 ** (state.overloadRetries - 1));
        this.emit({
          type: 'focus_update',
          adapterId: ADAPTER_ID,
          tabSessionId: state.tabSessionId,
          focus: `서버 과부하 재시도 대기 (${state.overloadRetries}/3)…`,
        });
        // Never await inside notification loop -> fire-and-forget timer
        setTimeout(() => {
          const client = this.getClient();
          if (!client.isAlive) return;
          void client.request('turn/start', { threadId: state.threadId, input: [] }, 120_000).catch(() => {});
        }, delayMs);
        return;
      }

      this.textCoalescer.flushTurn(turnKey);
      this.thinkingCoalescer.flushTurn(turnKey);

      // Force-close any running tool items omitted by Codex on interrupted/failed turns (t3code gotcha)
      if (status !== 'completed') {
        for (const tid of state.activeToolIds) {
          this.emit({
            type: 'tool_result',
            adapterId: ADAPTER_ID,
            tabSessionId: state.tabSessionId,
            toolId: tid,
            output: status === 'interrupted' ? '중단됨' : '실패로 종료됨',
            isError: status === 'failed',
          });
        }
      }
      state.activeToolIds.clear();
      state.activeTurnId = null;
      state.pendingTurnStart = false;

      const isFailed = status === 'failed';
      const errText = isFailed
        ? (typeof errObj?.message === 'string' && errObj.message) || state.latestErrorText || 'Codex 턴 실행 실패'
        : undefined;

      // Refresh quota asynchronously on completion or rate limit (never await in notification loop!)
      void this.quota?.fetchLiveQuota(false);

      this.emit({
        type: 'done',
        adapterId: ADAPTER_ID,
        tabSessionId: state.tabSessionId,
        exitCode: isFailed ? 1 : 0,
        error: state.interrupting ? undefined : errText,
      });
      state.interrupting = false;
    }
  }

  private handleTokenUsageUpdate(state: ActiveThreadState, params: Record<string, unknown>): void {
    const tu = params.tokenUsage as Record<string, unknown> | undefined;
    if (!tu) return;
    const total = tu.total as Record<string, unknown> | undefined;
    const last = tu.last as Record<string, unknown> | undefined;
    const win = typeof tu.modelContextWindow === 'number' && tu.modelContextWindow > 0 ? tu.modelContextWindow : state.contextWindow;
    state.contextWindow = win;

    const lastTotal = Number(last?.totalTokens || 0);
    const curTotal: TokenBaseline = {
      inputTokens: Number(total?.inputTokens || 0),
      cachedInputTokens: Number(total?.cachedInputTokens || 0),
      outputTokens: Number(total?.outputTokens || 0),
      totalTokens: Number(total?.totalTokens || 0),
    };

    // Guard against stale late updates for inactive turns: only update baseline
    if (params.turnId && state.activeTurnId && String(params.turnId) !== state.activeTurnId) {
      state.tokenBaseline = curTotal;
      return;
    }

    const prev = state.tokenBaseline;
    const deltaInput =
      prev && curTotal.inputTokens >= prev.inputTokens
        ? curTotal.inputTokens - prev.inputTokens
        : Number(last?.inputTokens || 0);
    const deltaCached =
      prev && curTotal.cachedInputTokens >= prev.cachedInputTokens
        ? curTotal.cachedInputTokens - prev.cachedInputTokens
        : Number(last?.cachedInputTokens || 0);
    const deltaOutput =
      prev && curTotal.outputTokens >= prev.outputTokens
        ? curTotal.outputTokens - prev.outputTokens
        : Number(last?.outputTokens || 0);
    state.tokenBaseline = curTotal;

    const prevCtx = state.lastContextUsed;
    // Codex reports cachedInputTokens INSIDE inputTokens! (t3code CodexTurnTokenUsage invariant)
    const clampedCached = Math.min(deltaInput, deltaCached);
    const uncachedInput = Math.max(0, deltaInput - clampedCached);
    state.invocations += 1;
    state.sessionCumulative += uncachedInput + deltaOutput;
    state.totalInputForCache += uncachedInput;
    state.totalCacheRead += clampedCached;
    if (lastTotal > 0) state.lastContextUsed = lastTotal;

    const used = state.lastContextUsed;
    if (state.pendingToolNames.length > 0) {
      const delta = prevCtx > 0 ? Math.max(0, used - prevCtx) : Math.max(0, uncachedInput);
      const perTool = Math.round(delta / state.pendingToolNames.length);
      for (const tName of state.pendingToolNames) {
        const cur = state.toolDeltaMap.get(tName) || { count: 0, deltaTokens: 0 };
        cur.count += 1;
        cur.deltaTokens += perTool;
        state.toolDeltaMap.set(tName, cur);
      }
      state.pendingToolNames = [];
    }

    const hitPct = deltaInput > 0 ? Number(((clampedCached / deltaInput) * 100).toFixed(1)) : 0;
    const overallDenom = state.totalInputForCache + state.totalCacheRead;
    const elapsedSec = state.turnStartedAt > 0 ? (Date.now() - state.turnStartedAt) / 1000 : 0;
    const tokPerSec = deltaOutput > 0 && elapsedSec >= 0.2 ? Number((deltaOutput / elapsedSec).toFixed(1)) : null;
    const compacted = prevCtx > 20_000 && used > 0 && used < prevCtx * 0.65;
    const cacheMiss = state.invocations > 1 && used > 5000 && hitPct < 20;
    state.recentTurns = [
      {
        invocation: state.invocations,
        contextAtCall: used,
        cacheHitPct: hitPct,
        outputTokens: deltaOutput,
        tokPerSec,
        compacted,
        cacheMiss,
      },
      ...state.recentTurns,
    ].slice(0, 20);
    state.turnStartedAt = Date.now();

    const totalToolDelta = Array.from(state.toolDeltaMap.values()).reduce((sum, x) => sum + x.deltaTokens, 0);
    const toolDeltas: ToolDeltaSummary[] = Array.from(state.toolDeltaMap.entries())
      .map(([name, v]) => ({
        name,
        count: v.count,
        deltaTokens: v.deltaTokens,
        sharePct: totalToolDelta > 0 ? Math.round((v.deltaTokens / totalToolDelta) * 100) : 0,
      }))
      .sort((a, b) => b.deltaTokens - a.deltaTokens || b.count - a.count);

    const qSnap = this.quota?.getCachedSnapshot() || { buckets: [], updatedAt: null };

    const metrics: SessionMetrics = {
      conversationId: state.threadId,
      model: state.model || 'codex',
      invocations: state.invocations,
      currentContext: used,
      contextWindow: win,
      usedPct: win > 0 ? Number(((used / win) * 100).toFixed(1)) : 0,
      lastCacheRead: clampedCached,
      lastInputTokens: uncachedInput,
      lastCacheHitPct: hitPct,
      lastCallAt: Date.now(),
      lastTurnTokens: uncachedInput + deltaOutput,
      lastTurnCalls: 1,
      lastTurnOutput: deltaOutput,
      tokPerSec,
      sessionCumulative: state.sessionCumulative,
      overallCacheHitPct: overallDenom > 0 ? Number(((state.totalCacheRead / overallDenom) * 100).toFixed(1)) : 0,
      toolDeltas,
      recentTurns: state.recentTurns,
      quotaBuckets: qSnap.buckets,
      quotaUpdatedAt: qSnap.updatedAt,
    };
    this.emit({ type: 'metrics', adapterId: ADAPTER_ID, tabSessionId: state.tabSessionId, metrics });
  }

  private buildToolCallItem(item: Record<string, unknown>, status: 'running' | 'done' | 'error'): ToolCallItem {
    const iType = String(item.type || 'tool');
    const id = String(item.id || `tc-${Date.now()}`);
    if (iType === 'commandExecution') {
      return {
        id,
        name: 'Bash',
        kind: 'execute',
        argsSummary: safeTruncateUtf16(String(item.command || '명령 실행'), 80),
        status,
        startedAt: Date.now(),
      };
    }
    if (iType === 'fileChange') {
      const chs = Array.isArray(item.changes) ? (item.changes as RawFileChange[]) : [];
      const summary = chs.map((c) => path.basename(String(c.path || 'file'))).join(', ') || '파일 편집';
      return {
        id,
        name: 'Edit',
        kind: 'edit',
        argsSummary: safeTruncateUtf16(summary, 80),
        status,
        startedAt: Date.now(),
      };
    }
    if (iType === 'mcpToolCall') {
      return {
        id,
        name: `${String(item.server || 'mcp')}:${String(item.tool || 'call')}`,
        kind: 'other',
        argsSummary: safeTruncateUtf16(JSON.stringify(item.arguments || {}), 72),
        status,
        startedAt: Date.now(),
      };
    }
    if (iType === 'webSearch') {
      return {
        id,
        name: 'WebSearch',
        kind: 'search',
        argsSummary: safeTruncateUtf16(String(item.query || ''), 72),
        status,
        startedAt: Date.now(),
      };
    }
    return {
      id,
      name: String(item.tool || iType),
      kind: 'other',
      argsSummary: safeTruncateUtf16(JSON.stringify(item.arguments || {}), 72),
      status,
      startedAt: Date.now(),
    };
  }

  private async handleServerRequest(
    method: string,
    params: Record<string, unknown>,
    reqId: string | number,
    signal: AbortSignal
  ): Promise<unknown> {
    const state = this.getStateByThread(params.threadId || params.conversationId);

    // 1. MCP Elicitation: return `"cancel"` when unsupported (NEVER `"decline"` — prevents permanent site block!)
    if (method === 'mcpServer/elicitation/request') {
      return { action: 'cancel' };
    }

    // 2. Interactive User Input Questions (`item/tool/requestUserInput`)
    if (method === 'item/tool/requestUserInput' && state) {
      const rawQs = Array.isArray(params.questions) ? (params.questions as Array<Record<string, unknown>>) : [];
      const questions: QuestionItem[] = rawQs.map((q, idx) => ({
        id: String(q.id || `q-${idx}`),
        header: String(q.header || `질문 ${idx + 1}`),
        question: String(q.question || ''),
        isSecret: Boolean(q.isSecret),
        options: Array.isArray(q.options)
          ? (q.options as Array<Record<string, unknown>>).map((o) => ({
              label: String(o.label || ''),
              description: typeof o.description === 'string' ? o.description : undefined,
            }))
          : undefined,
      }));
      const requestId = `codex-q-${String(reqId)}`;
      this.emit({
        type: 'question_request',
        adapterId: ADAPTER_ID,
        tabSessionId: state.tabSessionId,
        request: { requestId, questions },
      });

      const answers = await this.awaitWithAbort<Record<string, string | string[]>>(
        (resolve) => this.pendingQuestions.set(requestId, { resolve }),
        () => {
          this.pendingQuestions.delete(requestId);
          this.emit({ type: 'question_cleared', adapterId: ADAPTER_ID, tabSessionId: state.tabSessionId, requestId });
        },
        signal
      );
      this.emit({ type: 'question_cleared', adapterId: ADAPTER_ID, tabSessionId: state.tabSessionId, requestId });

      const formatted: Record<string, { answers: string[] }> = {};
      if (answers) {
        for (const [k, v] of Object.entries(answers)) {
          formatted[k] = { answers: Array.isArray(v) ? v : [String(v)] };
        }
      }
      return { answers: formatted };
    }

    // 3. Command / FileChange / Permissions Approval Requests
    if (
      state &&
      (method === 'item/commandExecution/requestApproval' ||
        method === 'item/fileChange/requestApproval' ||
        method === 'item/permissions/requestApproval' ||
        method === 'execCommandApproval' ||
        method === 'applyPatchApproval')
    ) {
      // Auto-accept in turbo mode (unless network allowlist approval)
      if (state.mode === 'turbo' && !params.networkApprovalContext) {
        if (method === 'item/permissions/requestApproval') {
          return { permissions: params.permissions || {}, scope: 'session' };
        }
        if (method === 'execCommandApproval' || method === 'applyPatchApproval') {
          return { decision: 'approved_for_session' };
        }
        return { decision: 'accept' };
      }

      // Check session-level allowance maintained by adapter (Codex's acceptForSession is per-command only)
      const allowKey = method.includes('command') || method.includes('Command') ? 'command' : 'file';
      if (state.sessionAllowance.has(allowKey)) {
        if (method === 'item/permissions/requestApproval') {
          return { permissions: params.permissions || {}, scope: 'session' };
        }
        if (method === 'execCommandApproval' || method === 'applyPatchApproval') {
          return { decision: 'approved_for_session' };
        }
        return { decision: 'acceptForSession' };
      }

      const requestId = `codex-perm-${String(reqId)}`;
      let toolName = 'Codex';
      let summary = '';
      let rawInput: string | undefined;

      if (method === 'item/commandExecution/requestApproval' || method === 'execCommandApproval') {
        toolName = 'Bash';
        const cmd = Array.isArray(params.command) ? params.command.join(' ') : String(params.command || '');
        summary = cmd || String(params.reason || '명령 실행 승인');
        rawInput = safeTruncateUtf16(
          [cmd ? `$ ${cmd}` : '', params.cwd ? `cwd: ${String(params.cwd)}` : '', params.reason ? `사유: ${String(params.reason)}` : '']
            .filter(Boolean)
            .join('\n'),
          1200
        );
      } else if (method === 'item/fileChange/requestApproval' || method === 'applyPatchApproval') {
        toolName = 'Edit';
        const cachedChanges = state.fileChangeCache.get(String(params.itemId || '')) || [];
        const fileList = cachedChanges.map((c) => c.path).filter(Boolean).join(', ');
        summary = fileList || String(params.grantRoot || params.reason || '파일 변경 승인');
        rawInput = cachedChanges.length > 0 ? formatFileChangesPreview(cachedChanges) : undefined;
      } else {
        toolName = 'Permissions';
        summary = String(params.reason || '추가 권한 요청');
        rawInput = safeTruncateUtf16(JSON.stringify(params.permissions || {}, null, 2), 1200);
      }

      const prompt: PermissionPrompt = {
        requestId,
        toolName,
        title: `${toolName} 승인 요청`,
        argsSummary: safeTruncateUtf16(summary, 180),
        rawInput,
        options: [
          { optionId: 'accept', name: '허용', kind: 'allow_once' },
          { optionId: 'acceptForSession', name: '이 세션에서 항상 허용', kind: 'allow_always' },
          { optionId: 'decline', name: '거절', kind: 'reject_once' },
          { optionId: 'cancel', name: '거절 후 중단', kind: 'reject_always' },
        ],
      };

      this.emit({
        type: 'permission_request',
        adapterId: ADAPTER_ID,
        tabSessionId: state.tabSessionId,
        request: prompt,
      });

      const decision = await this.awaitWithAbort<string>(
        (resolve) => this.pendingPermissions.set(requestId, { resolve }),
        () => {
          this.pendingPermissions.delete(requestId);
          this.emit({ type: 'permission_cleared', adapterId: ADAPTER_ID, tabSessionId: state.tabSessionId, requestId });
        },
        signal
      );
      this.emit({ type: 'permission_cleared', adapterId: ADAPTER_ID, tabSessionId: state.tabSessionId, requestId });

      if (decision === 'acceptForSession') {
        state.sessionAllowance.add(allowKey);
      }

      if (method === 'item/permissions/requestApproval') {
        if (decision === 'accept') return { permissions: params.permissions || {}, scope: 'turn' };
        if (decision === 'acceptForSession') return { permissions: params.permissions || {}, scope: 'session' };
        return { permissions: {}, scope: 'turn' };
      }

      if (method === 'execCommandApproval' || method === 'applyPatchApproval') {
        if (decision === 'accept') return { decision: 'approved' };
        if (decision === 'acceptForSession') return { decision: 'approved_for_session' };
        if (decision === 'decline') return { decision: { denied: { rejection: 'User declined the request.' } } };
        return { decision: 'abort' };
      }

      if (decision === 'accept' || decision === 'acceptForSession' || decision === 'decline' || decision === 'cancel') {
        return { decision };
      }
      return { decision: 'cancel' };
    }

    return {};
  }

  private awaitWithAbort<T>(
    register: (resolve: (val: T | null) => void) => void,
    cleanup: () => void,
    signal: AbortSignal
  ): Promise<T | null> {
    if (signal.aborted) return Promise.resolve(null);
    return new Promise<T | null>((resolve) => {
      let settled = false;
      const done = (val: T | null) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        resolve(val);
      };
      const onAbort = () => {
        cleanup();
        done(null);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      register((val) => done(val));
    });
  }

  dispose(): void {
    this.cancelCliLogin();
    for (const p of this.pendingPermissions.values()) p.resolve(null);
    this.pendingPermissions.clear();
    for (const q of this.pendingQuestions.values()) q.resolve(null);
    this.pendingQuestions.clear();
    this.tabToThread.clear();
    this.threadToTab.clear();
    this.client?.dispose();
    this.client = null;
    this.textCoalescer.dispose();
    this.thinkingCoalescer.dispose();
  }
}
