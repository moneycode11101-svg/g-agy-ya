import { type ChildProcess, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  AgentEvent,
  ChatMode,
  ChatStepItem,
  PermissionPrompt,
  QuestionItem,
  SessionMetrics,
  ToolCallItem,
} from '../../../src/shared/types';
import {
  type AgentModelOption,
  type AgentSendPromptRequest,
  safeTruncateUtf16,
  stripAnsi,
} from '../../../src/shared/agentProtocol';
import { FALLBACK_CLAUDE_MODELS, type ClaudePluginConfig } from '../../../src/plugins/agent-claude/types';
import { TextDeltaCoalescer } from '../agent-core/textDeltaCoalescer';
import {
  buildClaudeSpawnEnv,
  detectClaudeCliVersion,
  loadClaudeAgentSdk,
  resolveClaudeBinary,
  suppressClaudeShadowedWarning,
} from './env';
import type { ClaudeQuotaService } from './quota';

const ADAPTER_ID = 'agent-claude';
const CLAUDE_AUTH_RE = /not logged in|please run.*login|authentication|unauthenticated|unauthorized|invalid api key|oauth.*expired|login required/i;
const CLAUDE_AUTH_METHODS = [
  { id: 'claudeai', label: 'Claude 계정으로 CLI 로그인', description: '브라우저에서 Anthropic 구독 계정 로그인' },
  { id: 'console', label: 'Anthropic Console 로그인', description: 'API 사용량 과금 계정' },
];

// Dangerous rm safety patterns blocked automatically in bypass mode (ported from t3code ClaudeAdapterV2)
const DANGEROUS_RM_PATTERNS = [
  /^Dangerous rm(?:dir)?\b/i,
  /\bdangerous removal\b/i,
  /This shell -c script runs rm and could not be checked/i,
  /A permission rule denies a command in this shell -c script/i,
];

function mapChatModeToClaudePermissionMode(mode: ChatMode): string {
  switch (mode) {
    case 'turbo':
      return 'bypassPermissions';
    case 'auto':
      return 'auto';
    case 'accept-edits':
      return 'acceptEdits';
    case 'plan':
      return 'plan';
    case 'strict':
    default:
      return 'default';
  }
}

function inferToolKind(name: string): string {
  const n = name.toLowerCase();
  if (n === 'bash' || n.includes('shell') || n.includes('command')) return 'execute';
  if (n === 'read' || n === 'glob' || n.includes('view')) return 'read';
  if (n === 'edit' || n === 'multiedit' || n === 'write' || n === 'notebookedit') return 'edit';
  if (n === 'grep' || n === 'websearch' || n === 'webfetch' || n.includes('search')) return 'search';
  return 'other';
}

function summarizeToolInput(name: string, input: unknown): string {
  if (!input || typeof input !== 'object') return name;
  const o = input as Record<string, unknown>;
  const cand =
    o.command ??
    o.file_path ??
    o.path ??
    o.pattern ??
    o.query ??
    o.url ??
    o.description ??
    o.prompt ??
    '';
  const s = String(cand).replace(/\s+/g, ' ').trim();
  if (!s) return name;
  if (s.includes('/') && !s.includes(' ')) return path.basename(s);
  return safeTruncateUtf16(s, 72);
}

function formatStructuredToolResult(toolUseResult: unknown, content: unknown): string {
  if (toolUseResult && typeof toolUseResult === 'object') {
    const r = toolUseResult as Record<string, unknown>;
    if (typeof r.stdout === 'string' || typeof r.stderr === 'string') {
      const out = [r.stdout, r.stderr].filter((x) => typeof x === 'string' && x.trim()).join('\n');
      if (out) return out;
    }
    if (Array.isArray(r.structuredPatch) && r.structuredPatch.length > 0) {
      const lines: string[] = [];
      for (const hunk of r.structuredPatch as Array<Record<string, unknown>>) {
        if (typeof hunk.oldStart === 'number' && typeof hunk.newStart === 'number') {
          lines.push(`@@ -${hunk.oldStart},${hunk.oldLines ?? 0} +${hunk.newStart},${hunk.newLines ?? 0} @@`);
        }
        if (Array.isArray(hunk.lines)) {
          for (const l of hunk.lines) lines.push(String(l));
        }
      }
      if (lines.length > 0) return lines.join('\n');
    }
  }
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (c && typeof c === 'object' && typeof (c as Record<string, unknown>).text === 'string' ? (c as Record<string, unknown>).text : ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

function inferContextWindow(model: string, reported?: Map<string, number>): number {
  if (reported && reported.has(model)) return reported.get(model)!;
  const m = model.toLowerCase();
  if (m.includes('[1m]') || m.includes('1m') || m.includes('opus-5') || m.includes('sonnet-5') || m.includes('opus-4-6') || m.includes('sonnet-4-6')) {
    return 1_000_000;
  }
  return 200_000;
}

/** Async push queue feeding `AsyncIterable<SDKUserMessage>` for persistent multi-turn Claude sessions. */
class AsyncMessageQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiters: Array<(res: IteratorResult<T>) => void> = [];
  private closed = false;

  push(item: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value: item, done: false });
    } else {
      this.items.push(item);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.waiters.length > 0) {
      const w = this.waiters.shift()!;
      w({ value: undefined as unknown as T, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.items.length > 0) {
          return Promise.resolve({ value: this.items.shift()!, done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined as unknown as T, done: true });
        }
        return new Promise<IteratorResult<T>>((resolve) => {
          this.waiters.push(resolve);
        });
      },
    };
  }
}

interface PendingPermission {
  resolve: (optionId: string | null) => void;
}

interface PendingQuestion {
  resolve: (answers: Record<string, string | string[]> | null) => void;
}

interface ClaudeWorkerSession {
  readonly gen: number;
  readonly tabSessionId: string;
  readonly cwd: string;
  readonly configKey: string;
  sessionId: string;
  hasCommittedTurn: boolean;
  openedPermissionMode: string;
  currentPermissionMode: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  queryRuntime: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  inputQueue: AsyncMessageQueue<any>;
  abortController: AbortController;
  inTurn: boolean;
  currentTurnId: string;
  emittedAnyAssistantText: boolean;
  streamedTextBlockIds: Set<string>;
  streamedThinkingBlockIds: Set<string>;
  emittedToolIds: Set<string>;
  blockIndexToItemId: Map<number, { kind: 'text' | 'thinking'; itemId: string }>;
  currentMessageId: string;
  noticeTexts: Set<string>;
  streamUsage: {
    inputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
    outputTokens: number;
    requestedAt: number;
  } | null;
  reportedContextWindows: Map<string, number>;
  model: string;
  invocations: number;
  sessionCumulative: number;
  totalInputForCache: number;
  totalCacheRead: number;
  activeBashTails: Map<string, { timer: ReturnType<typeof setInterval>; offset: number; toolId: string }>;
  closed: boolean;
}

/**
 * Clean Pure-TS L2 harness bridge for Claude Code via `@anthropic-ai/claude-agent-sdk`.
 * Ported directly from t3code `ClaudeAdapterV2` + `ClaudeTurnTokenUsage` + `ClaudeTaskOutputTail`
 * with ZERO Effect-TS and ZERO T3 telemetry/cloud calls.
 */
export class ClaudePluginBridge {
  private readonly getConfig: () => Readonly<ClaudePluginConfig>;
  private readonly quota: ClaudeQuotaService;
  private readonly emit: (ev: AgentEvent) => void;
  private readonly workers = new Map<string, ClaudeWorkerSession>();
  private readonly pendingPermissions = new Map<string, PendingPermission>();
  private readonly pendingQuestions = new Map<string, PendingQuestion>();
  private readonly textCoalescer: TextDeltaCoalescer;
  private readonly thinkingCoalescer: TextDeltaCoalescer;
  private nextGen = 1;
  private cachedVersion: string | null = null;
  private cachedModels: { items: AgentModelOption[]; fetchedAt: number } | null = null;
  private activeLoginProc: ChildProcess | null = null;
  private activeLoginPromise: Promise<{ ok: boolean; error?: string }> | null = null;

  constructor(opts: {
    getConfig: () => Readonly<ClaudePluginConfig>;
    quota: ClaudeQuotaService;
    emit: (ev: AgentEvent) => void;
  }) {
    this.getConfig = opts.getConfig;
    this.quota = opts.quota;
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

  detectVersion(): string {
    if (this.cachedVersion !== null) return this.cachedVersion;
    this.cachedVersion = detectClaudeCliVersion(this.getConfig().cliPath);
    return this.cachedVersion;
  }

  private emitAuthRequired(tabSessionId: string): void {
    this.emit({
      type: 'auth_required',
      adapterId: ADAPTER_ID,
      tabSessionId,
      title: 'Claude Code CLI 로그인 필요',
      mode: 'acp',
      message:
        '로컬 Claude Code CLI 로그인이 필요합니다. 아래 버튼을 누르면 브라우저에서 공식 `claude auth login`을 완료할 수 있습니다.',
      methods: CLAUDE_AUTH_METHODS,
    });
  }

  async startCliLogin(methodId = 'claudeai'): Promise<{ ok: boolean; error?: string }> {
    if (this.activeLoginPromise) return this.activeLoginPromise;

    const cfg = this.getConfig();
    const bin = resolveClaudeBinary(cfg.cliPath);
    const args = ['auth', 'login', ...(methodId === 'console' ? ['--console'] : ['--claudeai'])];

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
        proc = spawn(bin, args, {
          cwd: os.homedir(),
          env: buildClaudeSpawnEnv({ configDir: cfg.configDir }),
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (err) {
        finish({
          ok: false,
          error:
            err instanceof Error && /ENOENT/i.test(err.message)
              ? 'Claude Code CLI(`claude`)가 설치되어 있지 않습니다. `npm install -g @anthropic-ai/claude-code`로 설치해 주세요.'
              : err instanceof Error
                ? err.message
                : 'claude auth login 실행에 실패했습니다.',
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
          ? 'Claude Code CLI(`claude`)가 설치되어 있지 않습니다. `npm install -g @anthropic-ai/claude-code`로 설치해 주세요.'
          : err.message;
        finish({ ok: false, error: msg });
      });
      proc.on('close', (code) => {
        if (code === 0) {
          this.cachedVersion = null;
          this.cachedModels = null;
          for (const sid of [...this.workers.keys()]) this.closeWorker(sid);
          void this.quota.fetchLiveQuota(true);
          this.emit({ type: 'auth_cleared', adapterId: ADAPTER_ID, tabSessionId: '' });
          finish({ ok: true });
        } else {
          const cleanErr = stripAnsi(errBuf).trim().split('\n').slice(-2).join(' ');
          finish({ ok: false, error: cleanErr || `Claude CLI 로그인이 완료되지 않았습니다 (code ${code ?? 1}).` });
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

  async listModels(force = false): Promise<AgentModelOption[]> {
    if (!force && this.cachedModels && Date.now() - this.cachedModels.fetchedAt < 300_000) {
      return this.cachedModels.items;
    }
    this.cachedModels = { items: FALLBACK_CLAUDE_MODELS, fetchedAt: Date.now() };
    return FALLBACK_CLAUDE_MODELS;
  }

  respondPermission(_tabSessionId: string, requestId: string, optionId: string | null): boolean {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) return false;
    this.pendingPermissions.delete(requestId);
    pending.resolve(optionId);
    return true;
  }

  respondQuestion(_tabSessionId: string, requestId: string, answers: Record<string, string | string[]> | null): boolean {
    const pending = this.pendingQuestions.get(requestId);
    if (!pending) return false;
    this.pendingQuestions.delete(requestId);
    pending.resolve(answers);
    return true;
  }

  async cancelTurn(tabSessionId: string): Promise<void> {
    const w = this.workers.get(tabSessionId);
    if (!w || w.closed) return;
    this.clearWorkerBashTails(w);
    this.textCoalescer.flushTurn(w.currentTurnId);
    this.thinkingCoalescer.flushTurn(w.currentTurnId);
    try {
      await Promise.race([
        w.queryRuntime?.interrupt?.(),
        new Promise((r) => setTimeout(r, 4000)),
      ]);
    } catch {
      this.closeWorker(tabSessionId);
    }
  }

  async sendPrompt(req: AgentSendPromptRequest): Promise<{ ok: boolean; error?: string; authRequired?: boolean }> {
    suppressClaudeShadowedWarning();
    const cfg = this.getConfig();
    const cwd = req.cwd && fs.existsSync(req.cwd) ? req.cwd : os.homedir();
    const effectiveModel = req.model && req.model !== 'default' ? req.model : cfg.defaultModel || 'default';
    const effectiveEffort = req.effort && req.effort !== 'default' ? req.effort : cfg.defaultEffort || 'default';
    const effectiveMode: ChatMode = req.mode || cfg.localPermission || 'auto';
    const permMode = mapChatModeToClaudePermissionMode(effectiveMode);
    const requestedSessionId = req.externalSessionId ?? req.agyConversationId ?? null;

    // Config key that determines whether an existing live worker can be reused
    const configKey = JSON.stringify({
      cwd,
      addDirs: req.addDirs || [],
      permMode,
      configDir: cfg.configDir || '',
      cliPath: cfg.cliPath || '',
    });

    let worker = this.workers.get(req.tabSessionId);
    const sessionMatches =
      !requestedSessionId || !worker || worker.sessionId === requestedSessionId;
    const canReuse =
      worker &&
      !worker.closed &&
      worker.configKey === configKey &&
      sessionMatches;

    if (canReuse && worker) {
      // Live model/effort/plan-mode recovery without respawning process!
      try {
        if (worker.currentPermissionMode === 'plan' && worker.openedPermissionMode !== 'plan') {
          await worker.queryRuntime?.setPermissionMode?.(worker.openedPermissionMode).catch(async () => {
            await worker!.queryRuntime?.setPermissionMode?.('default').catch(() => {});
          });
          worker.currentPermissionMode = worker.openedPermissionMode;
        }
        if (effectiveModel && effectiveModel !== 'default' && effectiveModel !== worker.model) {
          await worker.queryRuntime?.setModel?.(effectiveModel).catch(() => {});
          worker.model = effectiveModel;
        }
        if (effectiveEffort && effectiveEffort !== 'default') {
          await worker.queryRuntime?.applyFlagSettings?.({ effortLevel: effectiveEffort }).catch(() => {});
        }
      } catch {
        // fallback to fresh worker if live mutation fails
        this.closeWorker(req.tabSessionId);
        worker = undefined;
      }
    } else if (worker) {
      this.closeWorker(req.tabSessionId);
      worker = undefined;
    }

    if (!worker) {
      const opened = await this.openWorker({
        tabSessionId: req.tabSessionId,
        cwd,
        addDirs: req.addDirs || [],
        model: effectiveModel,
        effort: effectiveEffort,
        permMode,
        resumeSessionId: requestedSessionId,
        configKey,
      });
      if (!opened.ok) {
        if (CLAUDE_AUTH_RE.test(opened.error)) {
          this.emitAuthRequired(req.tabSessionId);
          return { ok: false, authRequired: true, error: 'Claude Code CLI 로그인이 필요합니다.' };
        }
        const friendly = /ENOENT|spawn .*claude/i.test(opened.error)
          ? 'Claude Code CLI(`claude`)가 설치되어 있지 않습니다. 터미널에서 `npm install -g @anthropic-ai/claude-code` 후 `claude auth login`을 실행해 주세요.'
          : opened.error;
        return { ok: false, error: friendly };
      }
      worker = opened.worker;
    }

    // Prepare turn state (always fresh UUID per turn to avoid CLI dedup-skipping)
    const turnUuid = crypto.randomUUID();
    worker.inTurn = true;
    worker.currentTurnId = `${req.tabSessionId}::${turnUuid}`;
    worker.emittedAnyAssistantText = false;
    worker.streamedTextBlockIds.clear();
    worker.streamedThinkingBlockIds.clear();
    worker.emittedToolIds.clear();
    worker.blockIndexToItemId.clear();
    worker.noticeTexts.clear();

    const finalText = this.formatPrompt(req);
    // Construct SDKUserMessage content blocks (skill slash commands at start of final text block)
    const contentBlocks: Array<Record<string, unknown>> = [{ type: 'text', text: finalText }];
    worker.inputQueue.push({
      type: 'user',
      uuid: turnUuid,
      session_id: worker.sessionId,
      parent_tool_use_id: null,
      message: {
        role: 'user',
        content: contentBlocks,
      },
    });

    return { ok: true };
  }

  private formatPrompt(req: AgentSendPromptRequest): string {
    if (req.images && req.images.length > 0) {
      const refs = req.images.map((img) => `[첨부 파일: ${img}]`).join('\n');
      return `${refs}\n\n${req.prompt}`;
    }
    return req.prompt;
  }

  private async openWorker(opts: {
    tabSessionId: string;
    cwd: string;
    addDirs: string[];
    model: string;
    effort: string;
    permMode: string;
    resumeSessionId: string | null;
    configKey: string;
  }): Promise<{ ok: true; worker: ClaudeWorkerSession } | { ok: false; error: string }> {
    const cfg = this.getConfig();
    const gen = this.nextGen++;
    const sessionId = opts.resumeSessionId || crypto.randomUUID();
    const isResume = Boolean(opts.resumeSessionId);
    const inputQueue = new AsyncMessageQueue<Record<string, unknown>>();
    const abortController = new AbortController();

    const worker: ClaudeWorkerSession = {
      gen,
      tabSessionId: opts.tabSessionId,
      cwd: opts.cwd,
      configKey: opts.configKey,
      sessionId,
      hasCommittedTurn: isResume,
      openedPermissionMode: opts.permMode,
      currentPermissionMode: opts.permMode,
      queryRuntime: null,
      inputQueue,
      abortController,
      inTurn: false,
      currentTurnId: `${opts.tabSessionId}::init`,
      emittedAnyAssistantText: false,
      streamedTextBlockIds: new Set(),
      streamedThinkingBlockIds: new Set(),
      emittedToolIds: new Set(),
      blockIndexToItemId: new Map(),
      currentMessageId: '',
      noticeTexts: new Set(),
      streamUsage: null,
      reportedContextWindows: new Map(),
      model: opts.model,
      invocations: 0,
      sessionCumulative: 0,
      totalInputForCache: 0,
      totalCacheRead: 0,
      activeBashTails: new Map(),
      closed: false,
    };

    try {
      const sdk = await loadClaudeAgentSdk();
      const stderrLines: string[] = [];

      const validAddDirs = [
        opts.cwd,
        ...opts.addDirs.filter((d) => d && fs.existsSync(d)),
      ];

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const queryOptions: Record<string, any> = {
        cwd: opts.cwd,
        additionalDirectories: validAddDirs,
        pathToClaudeCodeExecutable: resolveClaudeBinary(cfg.cliPath),
        env: buildClaudeSpawnEnv({ configDir: cfg.configDir, isResume }),
        includePartialMessages: true,
        thinking: { type: 'adaptive', display: 'summarized' },
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        tools: { type: 'preset', preset: 'claude_code' },
        permissionMode: opts.permMode,
        ...(opts.permMode === 'bypassPermissions' ? { allowDangerouslySkipPermissions: true } : {}),
        ...(isResume ? { resume: sessionId } : { sessionId }),
        ...(opts.model && opts.model !== 'default' ? { model: opts.model } : {}),
        ...(opts.effort && opts.effort !== 'default' ? { effort: opts.effort } : {}),
        settings: { showThinkingSummaries: true },
        abortController,
        stderr: (chunk: string) => {
          stderrLines.push(chunk);
          if (stderrLines.length > 40) stderrLines.shift();
        },
        canUseTool: async (
          toolName: string,
          toolInput: Record<string, unknown>,
          callbackOptions: {
            signal: AbortSignal;
            toolUseID: string;
            title?: string;
            description?: string;
            decisionReason?: string;
            suggestions?: Array<Record<string, unknown>>;
            matchedAskRule?: unknown;
            suppressAlwaysAllowRule?: boolean;
          }
        ) => this.handleCanUseTool(worker, toolName, toolInput, callbackOptions),
      };

      const q = sdk.query({ prompt: inputQueue, options: queryOptions });
      worker.queryRuntime = q;
      this.workers.set(opts.tabSessionId, worker);

      // Consume stream in background loop (never call raw generator.return())
      void this.consumeWorkerStream(worker, q, stderrLines);

      // Wait for initializationResult (up to 30s)
      await Promise.race([
        q.initializationResult?.(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Claude Code 초기화 시간 초과(30s)')), 30_000)),
      ]);

      return { ok: true, worker };
    } catch (err) {
      worker.closed = true;
      inputQueue.close();
      abortController.abort();
      if (this.workers.get(opts.tabSessionId) === worker) {
        this.workers.delete(opts.tabSessionId);
      }
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async handleCanUseTool(
    worker: ClaudeWorkerSession,
    toolName: string,
    toolInput: Record<string, unknown>,
    callbackOptions: {
      signal: AbortSignal;
      toolUseID: string;
      title?: string;
      description?: string;
      decisionReason?: string;
      suggestions?: Array<Record<string, unknown>>;
      matchedAskRule?: unknown;
      suppressAlwaysAllowRule?: boolean;
    }
  ): Promise<Record<string, unknown>> {
    const toolUseID = callbackOptions.toolUseID;
    if (worker.closed || !worker.inTurn) {
      return { behavior: 'deny', message: '세션이 종료되었거나 활성 턴이 없습니다.', toolUseID };
    }

    // 1. ExitPlanMode -> capture proposed plan & always deny so user can review first (t3code pattern)
    if (toolName === 'ExitPlanMode') {
      const planText = typeof toolInput.plan === 'string' ? toolInput.plan : '';
      if (planText.trim()) {
        this.emit({
          type: 'plan_proposed',
          adapterId: ADAPTER_ID,
          tabSessionId: worker.tabSessionId,
          plan: planText,
        });
      }
      worker.currentPermissionMode = 'plan';
      return {
        behavior: 'deny',
        message:
          'The client captured your proposed plan. Stop here and wait for the user feedback or implementation request in a later turn.',
        toolUseID,
      };
    }

    // 2. AskUserQuestion -> interactive multi-choice question card
    if (toolName === 'AskUserQuestion') {
      const rawQuestions = Array.isArray(toolInput.questions)
        ? (toolInput.questions as Array<Record<string, unknown>>)
        : [];
      const questions: QuestionItem[] = rawQuestions.map((q, idx) => ({
        id: String(q.question || `q-${idx}`),
        header: String(q.header || `질문 ${idx + 1}`),
        question: String(q.question || ''),
        multiSelect: Boolean(q.multiSelect),
        options: Array.isArray(q.options)
          ? (q.options as Array<Record<string, unknown>>).map((o) => ({
              label: String(o.label || ''),
              description: typeof o.description === 'string' ? o.description : undefined,
            }))
          : undefined,
      }));

      const requestId = `claude-q-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 6)}`;
      this.emit({
        type: 'question_request',
        adapterId: ADAPTER_ID,
        tabSessionId: worker.tabSessionId,
        request: { requestId, questions },
      });

      const answers = await this.awaitWithAbort(
        (resolve) => {
          this.pendingQuestions.set(requestId, { resolve });
        },
        () => {
          this.pendingQuestions.delete(requestId);
          this.emit({ type: 'question_cleared', adapterId: ADAPTER_ID, tabSessionId: worker.tabSessionId, requestId });
        },
        callbackOptions.signal
      );

      this.emit({ type: 'question_cleared', adapterId: ADAPTER_ID, tabSessionId: worker.tabSessionId, requestId });
      if (!answers) {
        return { behavior: 'deny', message: '사용자가 질문을 취소했습니다.', toolUseID };
      }
      const flatAnswers: Record<string, string> = {};
      for (const [k, v] of Object.entries(answers)) {
        flatAnswers[k] = Array.isArray(v) ? v.join(', ') : String(v ?? '');
      }
      return {
        behavior: 'allow',
        updatedInput: { questions: toolInput.questions, answers: flatAnswers },
        toolUseID,
      };
    }

    // 3. Dangerous rm auto-block in bypassPermissions mode (t3code safety guard)
    const cleanReason = callbackOptions.decisionReason ? stripAnsi(callbackOptions.decisionReason) : '';
    if (
      toolName === 'Bash' &&
      worker.currentPermissionMode === 'bypassPermissions' &&
      callbackOptions.matchedAskRule === undefined &&
      DANGEROUS_RM_PATTERNS.some((re) => re.test(cleanReason))
    ) {
      this.emit({
        type: 'notice',
        adapterId: ADAPTER_ID,
        tabSessionId: worker.tabSessionId,
        level: 'warn',
        text: `위험한 삭제 명령이 자동 차단되었습니다: ${summarizeToolInput(toolName, toolInput)}`,
      });
      return {
        behavior: 'deny',
        message: 'Dangerous removal blocked by host safety guard.',
        toolUseID,
      };
    }

    // 4. Interactive permission prompt card (reuses agy-desk PermissionPrompt UI)
    const requestId = `claude-perm-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 6)}`;
    const primaryLabel =
      (typeof toolInput.command === 'string' && toolInput.command.trim()) ||
      callbackOptions.title ||
      callbackOptions.description ||
      cleanReason ||
      summarizeToolInput(toolName, toolInput);

    const options: PermissionPrompt['options'] = [
      { optionId: 'accept', name: '허용', kind: 'allow_once' },
      ...(callbackOptions.suppressAlwaysAllowRule
        ? []
        : [{ optionId: 'acceptForSession', name: '이 세션에서 항상 허용', kind: 'allow_always' }]),
      { optionId: 'decline', name: '거절', kind: 'reject_once' },
      { optionId: 'cancel', name: '거절 후 중단', kind: 'reject_always' },
    ];

    let rawInput: string | undefined;
    try {
      rawInput = safeTruncateUtf16(JSON.stringify(toolInput, null, 2), 1200);
    } catch {
      rawInput = undefined;
    }

    this.emit({
      type: 'permission_request',
      adapterId: ADAPTER_ID,
      tabSessionId: worker.tabSessionId,
      request: {
        requestId,
        toolName,
        title: callbackOptions.title || toolName,
        argsSummary: safeTruncateUtf16(primaryLabel, 180),
        rawInput,
        options,
      },
    });

    const chosen = await this.awaitWithAbort<string | null>(
      (resolve) => {
        this.pendingPermissions.set(requestId, { resolve });
      },
      () => {
        this.pendingPermissions.delete(requestId);
        this.emit({ type: 'permission_cleared', adapterId: ADAPTER_ID, tabSessionId: worker.tabSessionId, requestId });
      },
      callbackOptions.signal
    );

    this.emit({ type: 'permission_cleared', adapterId: ADAPTER_ID, tabSessionId: worker.tabSessionId, requestId });

    if (chosen === 'accept') {
      return {
        behavior: 'allow',
        updatedInput: toolInput,
        toolUseID,
        decisionClassification: 'user_temporary',
      };
    }

    if (chosen === 'acceptForSession') {
      const updatedPermissions =
        Array.isArray(callbackOptions.suggestions) && callbackOptions.suggestions.length > 0
          ? callbackOptions.suggestions.map((s) => ({ ...s, destination: 'session' }))
          : [{ type: 'addRules', rules: [{ toolName }], behavior: 'allow', destination: 'session' }];
      return {
        behavior: 'allow',
        updatedInput: toolInput,
        toolUseID,
        decisionClassification: 'user_permanent',
        updatedPermissions,
      };
    }

    return {
      behavior: 'deny',
      message: chosen === 'cancel' ? '사용자가 도구 실행을 중단했습니다.' : '사용자가 도구 실행을 거절했습니다.',
      toolUseID,
      decisionClassification: 'user_reject',
      ...(chosen === 'cancel' || chosen === null ? { interrupt: true } : {}),
    };
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async consumeWorkerStream(worker: ClaudeWorkerSession, q: any, stderrLines: string[]): Promise<void> {
    try {
      for await (const msg of q) {
        if (worker.closed || this.workers.get(worker.tabSessionId) !== worker) break;
        this.handleSdkMessage(worker, msg as Record<string, unknown>);
      }
    } catch (err) {
      if (!worker.closed && this.workers.get(worker.tabSessionId) === worker && worker.inTurn) {
        const rawErr = err instanceof Error ? err.message : String(err);
        const tail = stderrLines.join('').trim();
        const combined = `${rawErr}\n${tail}`;
        if (CLAUDE_AUTH_RE.test(combined)) {
          this.finishTurn(worker, 1);
          this.emitAuthRequired(worker.tabSessionId);
        } else {
          const isNoSession = tail.includes('No conversation found with session ID');
          const friendly = isNoSession
            ? '이전 Claude 세션을 찾을 수 없어 새 세션으로 시작해야 합니다.'
            : rawErr || tail.slice(-300) || 'Claude Code 프로세스가 종료되었습니다.';
          this.finishTurn(worker, 1, friendly);
        }
      }
    } finally {
      this.clearWorkerBashTails(worker);
      worker.closed = true;
      worker.inputQueue.close();
      if (this.workers.get(worker.tabSessionId) === worker) {
        this.workers.delete(worker.tabSessionId);
      }
      if (worker.inTurn) {
        this.finishTurn(worker, 0);
      }
    }
  }

  private handleSdkMessage(worker: ClaudeWorkerSession, msg: Record<string, unknown>): void {
    const type = String(msg.type || '');
    const isSubagent = msg.parent_tool_use_id != null;

    if (type === 'system') {
      this.handleSystemMessage(worker, msg);
      return;
    }

    if (type === 'rate_limit_event') {
      const info = msg.rate_limit_info;
      if (info && typeof info === 'object') {
        this.quota.applyStreamRateLimitEvent(info as Record<string, unknown>);
      }
      return;
    }

    if (type === 'conversation_reset') {
      worker.streamUsage = null;
      this.emit({
        type: 'usage_delta',
        adapterId: ADAPTER_ID,
        tabSessionId: worker.tabSessionId,
        used: 0,
        size: inferContextWindow(worker.model, worker.reportedContextWindows),
      });
      return;
    }

    if (type === 'stream_event' && !isSubagent) {
      this.handleStreamEvent(worker, msg.event as Record<string, unknown> | undefined);
      return;
    }

    if (type === 'assistant') {
      this.handleAssistantMessage(worker, msg, isSubagent);
      return;
    }

    if (type === 'user') {
      this.handleUserMessage(worker, msg);
      return;
    }

    if (type === 'result') {
      this.handleResultMessage(worker, msg);
    }
  }

  private handleSystemMessage(worker: ClaudeWorkerSession, msg: Record<string, unknown>): void {
    const subtype = String(msg.subtype || '');
    if (subtype === 'init') {
      const sid = typeof msg.session_id === 'string' && msg.session_id ? msg.session_id : worker.sessionId;
      worker.sessionId = sid;
      if (typeof msg.permissionMode === 'string') {
        worker.currentPermissionMode = msg.permissionMode;
      }
      const model = typeof msg.model === 'string' && msg.model ? msg.model : undefined;
      if (model) worker.model = model;
      this.emit({
        type: 'session_init',
        adapterId: ADAPTER_ID,
        tabSessionId: worker.tabSessionId,
        agyConversationId: sid,
        model,
      });
      return;
    }

    if (subtype === 'status') {
      const status = msg.status;
      if (typeof msg.permissionMode === 'string') {
        worker.currentPermissionMode = msg.permissionMode;
      }
      if (status === 'compacting') {
        this.emit({
          type: 'focus_update',
          adapterId: ADAPTER_ID,
          tabSessionId: worker.tabSessionId,
          focus: '컨텍스트 자동 압축 중…',
        });
      }
      return;
    }

    if (subtype === 'compact_boundary') {
      worker.streamUsage = null;
      const meta = msg.compact_metadata as Record<string, unknown> | undefined;
      const postTokens = typeof meta?.post_tokens === 'number' ? meta.post_tokens : 0;
      if (postTokens > 0) {
        this.emit({
          type: 'usage_delta',
          adapterId: ADAPTER_ID,
          tabSessionId: worker.tabSessionId,
          used: postTokens,
          size: inferContextWindow(worker.model, worker.reportedContextWindows),
        });
      }
      this.emit({
        type: 'notice',
        adapterId: ADAPTER_ID,
        tabSessionId: worker.tabSessionId,
        level: 'info',
        text: '컨텍스트가 압축되었습니다.',
      });
      return;
    }

    if (subtype === 'task_started') {
      const taskType = String(msg.task_type || '');
      const taskId = String(msg.task_id || '');
      const toolUseId = typeof msg.tool_use_id === 'string' ? msg.tool_use_id : '';
      const desc = typeof msg.description === 'string' ? msg.description : '';
      if (taskType === 'local_bash' && msg.is_backgrounded !== true && taskId && toolUseId) {
        this.startBashOutputTail(worker, taskId, toolUseId);
      } else if (desc) {
        this.emit({
          type: 'focus_update',
          adapterId: ADAPTER_ID,
          tabSessionId: worker.tabSessionId,
          focus: `서브에이전트 작업 중: ${safeTruncateUtf16(desc, 48)}`,
        });
      }
      return;
    }

    if (subtype === 'task_notification') {
      const taskId = String(msg.task_id || '');
      const tail = worker.activeBashTails.get(taskId);
      if (tail) {
        clearInterval(tail.timer);
        worker.activeBashTails.delete(taskId);
      }
      return;
    }

    if (subtype === 'api_retry') {
      const attempt = Number(msg.attempt || 1);
      const max = Number(msg.max_retries || 3);
      this.emit({
        type: 'focus_update',
        adapterId: ADAPTER_ID,
        tabSessionId: worker.tabSessionId,
        focus: `API 일시 오류 재시도 중 (${attempt}/${max})…`,
      });
      return;
    }

    if (subtype === 'session_title_changed' && typeof msg.title === 'string' && msg.title.trim()) {
      this.emit({
        type: 'session_title',
        adapterId: ADAPTER_ID,
        tabSessionId: worker.tabSessionId,
        title: msg.title.trim(),
      });
      return;
    }

    if (subtype === 'informational' || subtype === 'model_refusal_fallback') {
      const content = typeof msg.content === 'string' ? msg.content.trim() : '';
      if (content) worker.noticeTexts.add(content);
      const level = String(msg.level || 'info');
      if (content && level !== 'info' && !(level === 'notice' && content.startsWith('Stop says: ') && msg.prevent_continuation !== true)) {
        this.emit({
          type: 'notice',
          adapterId: ADAPTER_ID,
          tabSessionId: worker.tabSessionId,
          level: level === 'error' ? 'error' : 'warn',
          text: content,
        });
      }
    }
  }

  /**
   * Ported from t3code `ClaudeTaskOutputTail.ts`: macOS Claude CLI writes live Bash output
   * under `/tmp/claude-<uid>/<project>/<sessionId>/tasks/<taskId>.output` (ignoring launchd TMPDIR).
   */
  private startBashOutputTail(worker: ClaudeWorkerSession, taskId: string, toolId: string): void {
    const uid = typeof process.getuid === 'function' ? process.getuid() : 501;
    const baseTmp = process.env.CLAUDE_CODE_TMPDIR || (process.platform === 'darwin' ? '/tmp' : os.tmpdir());
    const projSlug = worker.cwd.replace(/[^a-zA-Z0-9]/g, '-');
    const outPath = path.join(baseTmp, `claude-${uid}`, projSlug, worker.sessionId, 'tasks', `${taskId}.output`);

    const entry = {
      offset: 0,
      toolId,
      timer: setInterval(() => {
        try {
          if (!fs.existsSync(outPath)) return;
          const st = fs.statSync(outPath);
          if (st.size <= entry.offset) return;
          const toRead = Math.min(st.size - entry.offset, 32_768);
          const buf = Buffer.alloc(toRead);
          const fd = fs.openSync(outPath, 'r');
          fs.readSync(fd, buf, 0, toRead, entry.offset);
          fs.closeSync(fd);
          entry.offset += toRead;
          const chunk = buf.toString('utf8');
          if (chunk) {
            this.emit({
              type: 'tool_delta',
              adapterId: ADAPTER_ID,
              tabSessionId: worker.tabSessionId,
              toolId: entry.toolId,
              delta: chunk,
            });
          }
        } catch {
          // ignore transient file read errors
        }
      }, 250),
    };
    worker.activeBashTails.set(taskId, entry);
  }

  private clearWorkerBashTails(worker: ClaudeWorkerSession): void {
    for (const tail of worker.activeBashTails.values()) {
      clearInterval(tail.timer);
    }
    worker.activeBashTails.clear();
  }

  private handleStreamEvent(worker: ClaudeWorkerSession, ev?: Record<string, unknown>): void {
    if (!ev) return;
    const evType = String(ev.type || '');

    if (evType === 'message_start') {
      const m = ev.message as Record<string, unknown> | undefined;
      worker.currentMessageId = String(m?.id || `msg-${Date.now()}`);
      worker.blockIndexToItemId.clear();
      const u = m?.usage as Record<string, unknown> | undefined;
      if (u) {
        worker.streamUsage = {
          inputTokens: Number(u.input_tokens || 0),
          cacheCreationTokens: Number(u.cache_creation_input_tokens || 0),
          cacheReadTokens: Number(u.cache_read_input_tokens || 0),
          outputTokens: Number(u.output_tokens || 0),
          requestedAt: Date.now(),
        };
        this.emitContextUsage(worker);
      }
      return;
    }

    if (evType === 'message_delta') {
      const u = ev.usage as Record<string, unknown> | undefined;
      if (u && worker.streamUsage) {
        if (typeof u.input_tokens === 'number') worker.streamUsage.inputTokens = u.input_tokens;
        if (typeof u.cache_creation_input_tokens === 'number') {
          worker.streamUsage.cacheCreationTokens = u.cache_creation_input_tokens;
        }
        if (typeof u.cache_read_input_tokens === 'number') {
          worker.streamUsage.cacheReadTokens = u.cache_read_input_tokens;
        }
        if (typeof u.output_tokens === 'number') worker.streamUsage.outputTokens = u.output_tokens;
        this.emitContextUsage(worker);
      }
      return;
    }

    if (evType === 'content_block_start') {
      const idx = typeof ev.index === 'number' ? ev.index : -1;
      const block = ev.content_block as Record<string, unknown> | undefined;
      if (!block || idx < 0) return;
      const bType = String(block.type || '');
      if (bType === 'text') {
        const itemId = `${worker.currentMessageId}:text:${idx}`;
        worker.blockIndexToItemId.set(idx, { kind: 'text', itemId });
        worker.streamedTextBlockIds.add(itemId);
        if (typeof block.text === 'string' && block.text) {
          worker.emittedAnyAssistantText = true;
          this.textCoalescer.append(worker.currentTurnId, itemId, block.text);
        }
      } else if (bType === 'thinking') {
        const itemId = `${worker.currentMessageId}:thinking:${idx}`;
        worker.blockIndexToItemId.set(idx, { kind: 'thinking', itemId });
        worker.streamedThinkingBlockIds.add(itemId);
        if (typeof block.thinking === 'string' && block.thinking) {
          this.thinkingCoalescer.append(worker.currentTurnId, itemId, block.thinking);
        }
      }
      return;
    }

    if (evType === 'content_block_delta') {
      const idx = typeof ev.index === 'number' ? ev.index : -1;
      const delta = ev.delta as Record<string, unknown> | undefined;
      const mapped = worker.blockIndexToItemId.get(idx);
      if (!delta || !mapped) return;
      if (delta.type === 'text_delta' && typeof delta.text === 'string' && delta.text) {
        worker.emittedAnyAssistantText = true;
        this.textCoalescer.append(worker.currentTurnId, mapped.itemId, delta.text);
      } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string' && delta.thinking) {
        this.thinkingCoalescer.append(worker.currentTurnId, mapped.itemId, delta.thinking);
      }
      return;
    }

    if (evType === 'content_block_stop') {
      const idx = typeof ev.index === 'number' ? ev.index : -1;
      const mapped = worker.blockIndexToItemId.get(idx);
      if (!mapped) return;
      worker.blockIndexToItemId.delete(idx);
      if (mapped.kind === 'text') this.textCoalescer.complete(worker.currentTurnId, mapped.itemId);
      else this.thinkingCoalescer.complete(worker.currentTurnId, mapped.itemId);
    }
  }

  private handleAssistantMessage(worker: ClaudeWorkerSession, msg: Record<string, unknown>, isSubagent: boolean): void {
    const inner = msg.message as Record<string, unknown> | undefined;
    if (!inner) return;
    const model = typeof inner.model === 'string' ? inner.model : '';
    // Skip `<synthetic>` CLI placeholder messages for model/usage tracking
    if (model && model !== '<synthetic>' && !isSubagent) {
      worker.model = model;
    }

    const msgId = String(inner.id || '');
    const content = Array.isArray(inner.content) ? (inner.content as Array<Record<string, unknown>>) : [];

    content.forEach((b, idx) => {
      const bType = String(b.type || '');
      if (bType === 'text' && !isSubagent && typeof b.text === 'string' && b.text) {
        const key = `${msgId}:text:${idx}`;
        if (!worker.streamedTextBlockIds.has(key)) {
          worker.streamedTextBlockIds.add(key);
          worker.emittedAnyAssistantText = true;
          this.textCoalescer.complete(worker.currentTurnId, key, b.text);
        }
      } else if (bType === 'thinking' && !isSubagent && typeof b.thinking === 'string' && b.thinking) {
        const key = `${msgId}:thinking:${idx}`;
        if (!worker.streamedThinkingBlockIds.has(key)) {
          worker.streamedThinkingBlockIds.add(key);
          this.thinkingCoalescer.complete(worker.currentTurnId, key, b.thinking);
        }
      } else if (bType === 'tool_use') {
        const toolId = String(b.id || `tc-${Date.now()}-${idx}`);
        const name = String(b.name || 'tool');
        const input = b.input;

        // TodoWrite -> steps_update checklist
        if (name === 'TodoWrite' && !isSubagent && input && typeof input === 'object') {
          const todos = (input as Record<string, unknown>).todos;
          if (Array.isArray(todos)) {
            const steps: ChatStepItem[] = todos.map((t) => {
              const obj = t as Record<string, unknown>;
              const st = String(obj.status || 'pending');
              return {
                title: String(obj.content || obj.title || ''),
                status: st === 'completed' ? 'done' : st === 'in_progress' ? 'in_progress' : 'pending',
              };
            });
            this.emit({
              type: 'steps_update',
              adapterId: ADAPTER_ID,
              tabSessionId: worker.tabSessionId,
              steps,
            });
          }
          return;
        }

        if (!worker.emittedToolIds.has(toolId)) {
          worker.emittedToolIds.add(toolId);
          this.textCoalescer.flushTurn(worker.currentTurnId);
          this.thinkingCoalescer.flushTurn(worker.currentTurnId);
          const item: ToolCallItem = {
            id: toolId,
            name: isSubagent ? `sub:${name}` : name,
            kind: inferToolKind(name),
            argsSummary: summarizeToolInput(name, input),
            status: 'running',
            startedAt: Date.now(),
          };
          this.emit({
            type: 'tool_use',
            adapterId: ADAPTER_ID,
            tabSessionId: worker.tabSessionId,
            tool: item,
          });
        }
      }
    });
  }

  private handleUserMessage(worker: ClaudeWorkerSession, msg: Record<string, unknown>): void {
    const inner = msg.message as Record<string, unknown> | undefined;
    const content = Array.isArray(inner?.content) ? (inner.content as Array<Record<string, unknown>>) : [];
    const results = content.filter((b) => b.type === 'tool_result' && typeof b.tool_use_id === 'string');

    for (const r of results) {
      const toolId = String(r.tool_use_id);
      const output = formatStructuredToolResult(results.length === 1 ? msg.tool_use_result : undefined, r.content);
      this.emit({
        type: 'tool_result',
        adapterId: ADAPTER_ID,
        tabSessionId: worker.tabSessionId,
        toolId,
        output: safeTruncateUtf16(output, 1200),
        isError: r.is_error === true,
      });
    }
  }

  private handleResultMessage(worker: ClaudeWorkerSession, msg: Record<string, unknown>): void {
    // Ignore background task-notification lifecycle empty results (t3code gotcha)
    const origin = msg.origin as Record<string, unknown> | undefined;
    if (origin?.kind === 'task-notification' && Number(msg.num_turns || 0) === 0 && msg.is_error !== true) {
      return;
    }

    worker.hasCommittedTurn = true;
    this.textCoalescer.flushTurn(worker.currentTurnId);
    this.thinkingCoalescer.flushTurn(worker.currentTurnId);
    this.clearWorkerBashTails(worker);

    // Harvest dynamic context windows from result.modelUsage
    const modelUsage = msg.modelUsage as Record<string, Record<string, unknown>> | undefined;
    if (modelUsage && typeof modelUsage === 'object') {
      for (const [mName, mData] of Object.entries(modelUsage)) {
        if (typeof mData?.contextWindow === 'number' && mData.contextWindow > 0) {
          worker.reportedContextWindows.set(mName, mData.contextWindow);
        }
      }
    }

    const usage = msg.usage as Record<string, unknown> | undefined;
    if (usage) {
      const inp = Number(usage.input_tokens || 0);
      const cw = Number(usage.cache_creation_input_tokens || 0);
      const cr = Number(usage.cache_read_input_tokens || 0);
      const out = Number(usage.output_tokens || 0);
      worker.invocations += Number(msg.num_turns || 1);
      worker.sessionCumulative += inp + cw + out;
      worker.totalInputForCache += inp + cw;
      worker.totalCacheRead += cr;
      const latestCtx = worker.streamUsage
        ? worker.streamUsage.inputTokens +
          worker.streamUsage.cacheCreationTokens +
          worker.streamUsage.cacheReadTokens +
          worker.streamUsage.outputTokens
        : inp + cw + cr + out;
      const ctxWin = inferContextWindow(worker.model, worker.reportedContextWindows);
      const denom = inp + cw + cr;
      const overallDenom = worker.totalInputForCache + worker.totalCacheRead;
      const qSnap = this.quota.getCachedSnapshot();
      const metrics: SessionMetrics = {
        conversationId: worker.sessionId,
        model: worker.model || 'claude',
        invocations: worker.invocations,
        currentContext: latestCtx,
        contextWindow: ctxWin,
        usedPct: ctxWin > 0 ? Number(((latestCtx / ctxWin) * 100).toFixed(1)) : 0,
        lastCacheRead: cr,
        lastInputTokens: inp + cw,
        lastCacheHitPct: denom > 0 ? Number(((cr / denom) * 100).toFixed(1)) : 0,
        lastCallAt: Date.now(),
        lastTurnTokens: inp + cw + out,
        lastTurnCalls: Number(msg.num_turns || 1),
        lastTurnOutput: out,
        tokPerSec: null,
        sessionCumulative: worker.sessionCumulative,
        overallCacheHitPct: overallDenom > 0 ? Number(((worker.totalCacheRead / overallDenom) * 100).toFixed(1)) : 0,
        toolDeltas: [],
        recentTurns: [],
        quotaBuckets: qSnap.buckets,
        quotaUpdatedAt: qSnap.updatedAt,
      };
      this.emit({ type: 'metrics', adapterId: ADAPTER_ID, tabSessionId: worker.tabSessionId, metrics });
    }

    const isError = msg.is_error === true || (typeof msg.subtype === 'string' && msg.subtype !== 'success');
    const resultText = typeof msg.result === 'string' ? msg.result.trim() : '';
    const errors = Array.isArray(msg.errors)
      ? (msg.errors as unknown[]).map(String).filter((e) => !e.startsWith('[ede_diagnostic]'))
      : [];

    if (!isError && !worker.emittedAnyAssistantText && resultText && !worker.noticeTexts.has(resultText)) {
      worker.emittedAnyAssistantText = true;
      this.emit({ type: 'text_delta', adapterId: ADAPTER_ID, tabSessionId: worker.tabSessionId, delta: resultText });
    }

    const errText = isError
      ? errors.join('\n') || resultText || `Claude 종료 (${String(msg.subtype || msg.terminal_reason || 'error')})`
      : undefined;

    this.finishTurn(worker, isError ? 1 : 0, errText);
  }

  private emitContextUsage(worker: ClaudeWorkerSession): void {
    const u = worker.streamUsage;
    if (!u) return;
    const totalInput = u.inputTokens + u.cacheCreationTokens + u.cacheReadTokens;
    if (totalInput <= 0) return;
    const used = totalInput + u.outputTokens;
    const size = inferContextWindow(worker.model, worker.reportedContextWindows);
    this.emit({ type: 'usage_delta', adapterId: ADAPTER_ID, tabSessionId: worker.tabSessionId, used, size });
  }

  private finishTurn(worker: ClaudeWorkerSession, exitCode: number, error?: string): void {
    if (!worker.inTurn) return;
    worker.inTurn = false;
    this.emit({
      type: 'done',
      adapterId: ADAPTER_ID,
      tabSessionId: worker.tabSessionId,
      exitCode,
      error,
    });
  }

  closeWorker(tabSessionId: string): void {
    const w = this.workers.get(tabSessionId);
    if (!w) return;
    w.closed = true;
    this.workers.delete(tabSessionId);
    this.clearWorkerBashTails(w);
    w.inputQueue.close();
    w.abortController.abort();
    try {
      w.queryRuntime?.close?.();
    } catch {
      // ignore
    }
  }

  dispose(): void {
    this.cancelCliLogin();
    for (const sid of [...this.workers.keys()]) {
      this.closeWorker(sid);
    }
    for (const p of this.pendingPermissions.values()) p.resolve(null);
    this.pendingPermissions.clear();
    for (const q of this.pendingQuestions.values()) q.resolve(null);
    this.pendingQuestions.clear();
    this.textCoalescer.dispose();
    this.thinkingCoalescer.dispose();
  }
}
