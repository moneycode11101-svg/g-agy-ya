import { ChildProcess, execFile, execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgyEvent, ChatMode, SessionMetrics } from '../../../src/shared/types';
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

const CLI_ONLY_SLASH_RE = /^\/(model|usage|help|changelog|agents?|mcp|plugins?)\b/i;

function summarizeInput(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const o = input as Record<string, unknown>;
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
  return s.length > 48 ? s.slice(0, 48) + '…' : s;
}

interface TurnState {
  prompt: string;
  requestedModel: string;
  cwd: string;
  emittedAnyText: boolean;
  sawCheckpoint: boolean;
  resultError: string | null;
  emittedToolIds: Set<string>;
}

interface PersistentWorker {
  tabSessionId: string;
  proc: ChildProcess;
  configKey: string;
  conversationId: string | null;
  cwd: string;
  hasActiveWatcher: boolean;
  inTurn: boolean;
  authEmitted: boolean;
  lineBuf: string;
  stderrBuf: string;
  turn: TurnState | null;
  closed: boolean;
  superseded: boolean;
}

/**
 * Isolated `agent-agy` process bridge (no Git Diff, no global settingsStore coupling).
 * Supports persistent `stream-json` workers with automatic restart on config or Layer 2 asset mutation.
 */
export class AgyPluginBridge {
  private workers = new Map<string, PersistentWorker>();
  private oneShotProcs = new Map<string, ChildProcess>();
  private sessionWatchers = new Map<string, () => void>();
  private readonly getConfig: () => Readonly<AgyPluginConfig>;
  private readonly quota: AgyQuotaService;
  private readonly emit: (ev: AgyEvent) => void;
  private assetRevision = 0;
  private cachedVersion: string | null = null;
  private cachedModels: { items: AgyModelOption[]; fetchedAt: number } | null = null;

  constructor(opts: {
    getConfig: () => Readonly<AgyPluginConfig>;
    quota: AgyQuotaService;
    emit: (ev: AgyEvent) => void;
  }) {
    this.getConfig = opts.getConfig;
    this.quota = opts.quota;
    this.emit = opts.emit;
  }

  /** Bumping assetRevision forces idle/next-turn workers to respawn with fresh plugins/MCP */
  bumpAssetRevision(): void {
    this.assetRevision += 1;
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
          // Strip ANSI escape sequences and handle both TTY spaces (`  `) and non-TTY single tab (`\t`)
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
    this.closeWorker(tabSessionId, false);
  }

  submitAuthCode(tabSessionId: string, code: string): boolean {
    const w = this.workers.get(tabSessionId);
    const proc = w && !w.closed ? w.proc : this.oneShotProcs.get(tabSessionId);
    if (!proc || proc.killed || !proc.stdin || !proc.stdin.writable) return false;
    proc.stdin.write(code.trim() + '\n');
    return true;
  }

  sendPrompt(req: AgySendPromptRequest): { ok: boolean; error?: string } {
    this.killOneShot(req.tabSessionId);

    const { flags, cwd } = this.buildCommonFlags(req);
    const finalPrompt = this.formatFinalPrompt(req);

    if (CLI_ONLY_SLASH_RE.test(req.prompt.trim())) {
      return this.sendOneShotCommand(req, flags, cwd, finalPrompt);
    }

    const configKey = JSON.stringify({ cwd, flags, assetRev: this.assetRevision });
    const existing = this.workers.get(req.tabSessionId);
    const convMatches =
      !req.agyConversationId ||
      !existing?.conversationId ||
      existing.conversationId === req.agyConversationId;

    let worker: PersistentWorker;
    if (
      existing &&
      !existing.closed &&
      !existing.superseded &&
      !existing.inTurn &&
      !existing.proc.killed &&
      existing.proc.stdin?.writable &&
      existing.configKey === configKey &&
      convMatches
    ) {
      worker = existing;
    } else {
      this.closeWorker(req.tabSessionId, false);
      const spawned = this.spawnPersistentWorker(req, flags, cwd, configKey);
      if (!spawned.ok) return { ok: false, error: spawned.error };
      worker = spawned.worker;
    }

    worker.inTurn = true;
    worker.stderrBuf = '';
    worker.turn = {
      prompt: req.prompt,
      requestedModel: req.model,
      cwd,
      emittedAnyText: false,
      sawCheckpoint: false,
      resultError: null,
      emittedToolIds: new Set<string>(),
    };

    const payload = JSON.stringify({ event: 'user', message: { content: finalPrompt } }) + '\n';
    try {
      worker.proc.stdin?.write(payload);
    } catch (err) {
      this.closeWorker(req.tabSessionId, false);
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }

    return { ok: true };
  }

  dispose(): void {
    for (const id of [...this.oneShotProcs.keys()]) {
      this.killOneShot(id);
    }
    for (const id of [...this.workers.keys()]) {
      this.closeWorker(id, false);
    }
    for (const id of [...this.sessionWatchers.keys()]) {
      this.unwatchSession(id);
    }
  }

  private closeWorker(tabSessionId: string, graceful = false): void {
    const w = this.workers.get(tabSessionId);
    if (!w) return;
    w.superseded = true;
    this.workers.delete(tabSessionId);
    try {
      if (graceful && !w.inTurn && w.proc.stdin && !w.proc.stdin.destroyed) {
        w.proc.stdin.end();
      } else if (!w.proc.killed) {
        w.proc.kill('SIGTERM');
      }
    } catch {
      // ignore
    }
  }

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

  private buildCommonFlags(req: AgySendPromptRequest): { flags: string[]; cwd: string } {
    const cfg = this.getConfig();
    const flags: string[] = [];

    const effectiveModel = req.model && req.model !== 'default' ? req.model : cfg.defaultModel;
    const modelHasEmbeddedTier = Boolean(
      req.model &&
        req.model !== 'default' &&
        /-(low|medium|high|xhigh|max)$/i.test(req.model)
    );
    const effectiveEffort =
      req.effort && req.effort !== 'default'
        ? req.effort
        : modelHasEmbeddedTier
          ? 'default'
          : cfg.defaultEffort;
    const hasExplicitEffort = Boolean(effectiveEffort && effectiveEffort !== 'default');

    if (effectiveModel && effectiveModel !== 'default') {
      const modelArg = hasExplicitEffort
        ? effectiveModel.replace(/-(low|medium|high|xhigh|max)$/, '')
        : effectiveModel;
      flags.push('--model', modelArg);
    }
    if (hasExplicitEffort) {
      flags.push('--effort', effectiveEffort);
    }

    const effectiveMode: ChatMode = req.mode || cfg.localPermission || 'turbo';
    if (effectiveMode === 'turbo') {
      flags.push('--dangerously-skip-permissions');
    } else if (effectiveMode === 'strict') {
      flags.push('--sandbox');
    } else if (effectiveMode === 'plan' || effectiveMode === 'accept-edits' || effectiveMode === 'auto') {
      flags.push('--mode', effectiveMode);
    }

    const allowedCommands = Array.isArray(cfg.allowedCommands) ? cfg.allowedCommands : [];
    if (allowedCommands.length > 0) {
      const allowRules = allowedCommands.map((cmd) => (cmd.includes('(') ? cmd : `command(${cmd})`));
      flags.push('--settings', JSON.stringify({ permissions: { allow: allowRules } }));
    }

    const addDirs = Array.isArray(req.addDirs) ? req.addDirs : [];
    for (const dir of addDirs) {
      if (dir && fs.existsSync(dir)) {
        flags.push('--add-dir', dir);
      }
    }

    const cwd = req.cwd && fs.existsSync(req.cwd) ? req.cwd : os.homedir();
    return { flags, cwd };
  }

  private formatFinalPrompt(req: AgySendPromptRequest): string {
    if (req.images && req.images.length > 0) {
      const refs = req.images.map((img) => `[첨부 파일: ${img}]`).join('\n');
      return `${refs}\n\n${req.prompt}`;
    }
    return req.prompt;
  }

  private ensureWorkerWatcher(worker: PersistentWorker, convId: string): void {
    if (worker.hasActiveWatcher) return;
    if (resolveTranscriptPath(convId)) {
      const initial = this.watchSession(worker.tabSessionId, convId);
      worker.hasActiveWatcher = true;
      if (initial) {
        this.emit({ type: 'metrics', tabSessionId: worker.tabSessionId, metrics: initial });
      }
    }
  }

  private handleWorkerJsonEvent(worker: PersistentWorker, obj: Record<string, unknown>): void {
    if (worker.superseded || this.workers.get(worker.tabSessionId) !== worker) return;

    const initObj =
      obj.init && typeof obj.init === 'object' ? (obj.init as Record<string, unknown>) : undefined;
    const stepObj =
      obj.step_update && typeof obj.step_update === 'object'
        ? (obj.step_update as Record<string, unknown>)
        : undefined;
    const resultObj =
      obj.result && typeof obj.result === 'object'
        ? (obj.result as Record<string, unknown>)
        : undefined;

    const convId =
      (typeof obj.conversation_id === 'string' && obj.conversation_id) ||
      (typeof stepObj?.conversation_id === 'string' && stepObj.conversation_id) ||
      (typeof resultObj?.conversation_id === 'string' && resultObj.conversation_id) ||
      (typeof obj.session_id === 'string' && obj.session_id) ||
      (typeof obj.conversationId === 'string' && obj.conversationId) ||
      null;

    if (convId && convId !== worker.conversationId) {
      worker.conversationId = convId;
      registerOwnSession({
        conversationId: convId,
        title: (worker.turn?.prompt || '').replace(/\s+/g, ' ').trim().slice(0, 40),
        cwd: worker.cwd,
      });
      const initModel =
        worker.turn?.requestedModel === 'default'
          ? (typeof initObj?.model === 'string' && initObj.model) ||
            (typeof obj.model === 'string' && obj.model) ||
            undefined
          : undefined;
      this.emit({
        type: 'session_init',
        tabSessionId: worker.tabSessionId,
        agyConversationId: convId,
        model: initModel,
      });
      this.ensureWorkerWatcher(worker, convId);
    } else if (worker.conversationId && !worker.hasActiveWatcher) {
      this.ensureWorkerWatcher(worker, worker.conversationId);
    }

    const agyEvent = typeof obj.event === 'string' ? obj.event : '';
    const turn = worker.turn;

    if (agyEvent === 'init') return;

    if (agyEvent === 'step_update' && stepObj) {
      const thinkingDelta =
        typeof stepObj.thinking_delta === 'string'
          ? stepObj.thinking_delta
          : typeof stepObj.thinking === 'string'
            ? stepObj.thinking
            : '';
      if (thinkingDelta) {
        this.emit({ type: 'thinking_delta', tabSessionId: worker.tabSessionId, delta: thinkingDelta });
      }

      if (typeof stepObj.text_delta === 'string' && stepObj.text_delta) {
        if (turn) turn.emittedAnyText = true;
        this.emit({ type: 'text_delta', tabSessionId: worker.tabSessionId, delta: stepObj.text_delta });
      }

      const stepType = String(stepObj.step_type || '');
      const stepState = String(stepObj.state || '');
      if (stepType === 'checkpoint' && turn) {
        turn.sawCheckpoint = true;
      }

      const toolInfo =
        stepObj.tool_info && typeof stepObj.tool_info === 'object'
          ? (stepObj.tool_info as Record<string, unknown>)
          : undefined;
      const subagentInfo =
        stepObj.subagent_info && typeof stepObj.subagent_info === 'object'
          ? (stepObj.subagent_info as Record<string, unknown>)
          : undefined;

      if (stepType === 'tool' || toolInfo) {
        const toolId =
          typeof stepObj.step_index === 'number'
            ? `step-${stepObj.step_index}`
            : `tool-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
        const toolName = String(toolInfo?.name || stepObj.tool_name || 'tool');
        const params = toolInfo?.parameters ?? toolInfo?.input ?? toolInfo?.args;

        if (turn && !turn.emittedToolIds.has(toolId)) {
          turn.emittedToolIds.add(toolId);
          this.emit({
            type: 'tool_use',
            tabSessionId: worker.tabSessionId,
            tool: {
              id: toolId,
              name: toolName,
              argsSummary: summarizeInput(params),
              status: 'running',
            },
          });
        }

        const hasToolError = Boolean(toolInfo?.error);
        const hasToolOutput = toolInfo?.output !== undefined;
        if (stepState === 'DONE' || stepState === 'ERROR' || hasToolError || hasToolOutput) {
          const errObj =
            toolInfo?.error && typeof toolInfo.error === 'object'
              ? (toolInfo.error as Record<string, unknown>)
              : undefined;
          const outStr = errObj
            ? typeof errObj.message === 'string'
              ? errObj.message
              : JSON.stringify(errObj)
            : typeof toolInfo?.output === 'string'
              ? toolInfo.output
              : toolInfo?.output != null
                ? JSON.stringify(toolInfo.output)
                : '';
          this.emit({
            type: 'tool_result',
            tabSessionId: worker.tabSessionId,
            toolId,
            output: outStr.slice(0, 600),
            isError: hasToolError || stepState === 'ERROR',
          });
        }
      } else if (subagentInfo) {
        const toolId =
          typeof stepObj.step_index === 'number'
            ? `subagent-${stepObj.step_index}`
            : `subagent-${Date.now()}`;
        const subs = Array.isArray(subagentInfo.subagents)
          ? (subagentInfo.subagents as Array<Record<string, unknown>>)
          : [];
        const summary = subs
          .map((s) => String(s.role || s.type_name || 'subagent'))
          .filter(Boolean)
          .join(', ');
        if (turn && !turn.emittedToolIds.has(toolId)) {
          turn.emittedToolIds.add(toolId);
          this.emit({
            type: 'tool_use',
            tabSessionId: worker.tabSessionId,
            tool: {
              id: toolId,
              name: String(stepObj.tool_name || 'subagent'),
              argsSummary: summary.slice(0, 48),
              status: 'running',
            },
          });
        }
        if (stepState === 'DONE' || stepState === 'ERROR') {
          this.emit({
            type: 'tool_result',
            tabSessionId: worker.tabSessionId,
            toolId,
            output: summary,
            isError: stepState === 'ERROR',
          });
        }
      }

      if (stepState === 'DONE' && worker.conversationId) {
        this.ensureWorkerWatcher(worker, worker.conversationId);
        const metrics = analyzeSingleSession(worker.conversationId, this.quota.getCachedSnapshot());
        if (metrics) this.emit({ type: 'metrics', tabSessionId: worker.tabSessionId, metrics });
      }
      return;
    }

    if (agyEvent === 'result') {
      const res = resultObj || obj;
      const status = typeof res.status === 'string' ? res.status : '';
      let errText: string | undefined;
      if (status && status !== 'SUCCESS') {
        errText =
          (typeof res.error === 'string' && res.error) || `agy exited with status ${status}`;
        if (turn) turn.resultError = errText;
      }

      if (turn && !turn.emittedAnyText) {
        const outText =
          typeof res.response === 'string'
            ? res.response
            : typeof res.output === 'string'
              ? res.output
              : '';
        if (outText) {
          turn.emittedAnyText = true;
          this.emit({ type: 'text_delta', tabSessionId: worker.tabSessionId, delta: outText });
        } else if (!errText && (turn.sawCheckpoint || turn.prompt.trim().startsWith('/compact'))) {
          turn.emittedAnyText = true;
          this.emit({
            type: 'text_delta',
            tabSessionId: worker.tabSessionId,
            delta: '컨텍스트가 압축되었습니다.',
          });
        }
      }

      if (worker.conversationId) {
        registerOwnSession({ conversationId: worker.conversationId, cwd: worker.cwd });
        this.ensureWorkerWatcher(worker, worker.conversationId);
        const metrics = analyzeSingleSession(worker.conversationId, this.quota.getCachedSnapshot());
        if (metrics) this.emit({ type: 'metrics', tabSessionId: worker.tabSessionId, metrics });
      }

      if (worker.inTurn) {
        worker.inTurn = false;
        worker.turn = null;
        worker.stderrBuf = '';
        this.emit({
          type: 'done',
          tabSessionId: worker.tabSessionId,
          exitCode: errText ? 1 : 0,
          error: worker.authEmitted ? undefined : errText,
        });
      }
    }
  }

  private spawnPersistentWorker(
    req: AgySendPromptRequest,
    flags: string[],
    cwd: string,
    configKey: string
  ): { ok: true; worker: PersistentWorker } | { ok: false; error: string } {
    const agyBin = resolveAgyBinary();
    const args = ['--input-format', 'stream-json', '--output-format', 'stream-json', ...flags];
    if (req.agyConversationId) {
      args.push('--conversation', req.agyConversationId);
    }

    let proc: ChildProcess;
    try {
      proc = spawn(agyBin, args, {
        cwd,
        env: buildAgySpawnEnv(),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }

    proc.stdin?.on('error', () => {
      // ignore EPIPE
    });

    const worker: PersistentWorker = {
      tabSessionId: req.tabSessionId,
      proc,
      configKey,
      conversationId: req.agyConversationId,
      cwd,
      hasActiveWatcher: Boolean(req.agyConversationId && resolveTranscriptPath(req.agyConversationId)),
      inTurn: false,
      authEmitted: false,
      lineBuf: '',
      stderrBuf: '',
      turn: null,
      closed: false,
      superseded: false,
    };

    this.workers.set(req.tabSessionId, worker);

    const checkAuth = (chunk: string) => {
      if (worker.authEmitted) return;
      const urlMatch = chunk.match(/https:\/\/accounts\.google\.com\/o\/oauth2\/auth[^\s]+/);
      if (urlMatch) {
        worker.authEmitted = true;
        this.emit({
          type: 'auth_required',
          tabSessionId: worker.tabSessionId,
          url: urlMatch[0],
          message: 'agy CLI Google 로그인이 필요합니다. 브라우저에서 인증 후 코드를 붙여넣으세요.',
        });
      }
    };

    const flushLineBuf = () => {
      const rem = worker.lineBuf.trim();
      worker.lineBuf = '';
      if (rem && rem.startsWith('{')) {
        try {
          this.handleWorkerJsonEvent(worker, JSON.parse(rem) as Record<string, unknown>);
        } catch {
          // ignore non-JSON debug line
        }
      }
    };

    const handleWorkerExit = (code: number, spawnErr?: string) => {
      if (worker.closed) return;
      worker.closed = true;
      if (worker.superseded) return;
      flushLineBuf();
      if (this.workers.get(worker.tabSessionId) === worker) {
        this.workers.delete(worker.tabSessionId);
      }
      if (!worker.inTurn) return;

      const lastErr = worker.turn?.resultError || null;
      worker.inTurn = false;
      worker.turn = null;

      if (worker.conversationId) {
        registerOwnSession({ conversationId: worker.conversationId, cwd: worker.cwd });
        this.ensureWorkerWatcher(worker, worker.conversationId);
        const metrics = analyzeSingleSession(worker.conversationId, this.quota.getCachedSnapshot());
        if (metrics) this.emit({ type: 'metrics', tabSessionId: worker.tabSessionId, metrics });
      }

      let errText: string | undefined;
      if (spawnErr) {
        errText = spawnErr;
      } else if (lastErr && !worker.authEmitted) {
        errText = lastErr;
      } else if (code !== 0 && !worker.authEmitted) {
        const filtered = worker.stderrBuf
          .trim()
          .split('\n')
          .filter((l) => l.trim() && !l.trim().startsWith('warning:'));
        errText =
          filtered.slice(-4).join('\n') ||
          worker.stderrBuf.trim().split('\n').slice(-4).join('\n') ||
          `agy exited with code ${code}`;
      }

      this.emit({
        type: 'done',
        tabSessionId: worker.tabSessionId,
        exitCode: code,
        error: errText,
      });
    };

    proc.stdout?.on('data', (buf: Buffer) => {
      const chunk = buf.toString('utf8');
      checkAuth(chunk);
      worker.lineBuf += chunk;
      let nl = worker.lineBuf.indexOf('\n');
      while (nl !== -1) {
        const line = worker.lineBuf.slice(0, nl).trim();
        worker.lineBuf = worker.lineBuf.slice(nl + 1);
        if (line && line.startsWith('{')) {
          try {
            this.handleWorkerJsonEvent(worker, JSON.parse(line) as Record<string, unknown>);
          } catch {
            // ignore non-JSON debug line
          }
        }
        nl = worker.lineBuf.indexOf('\n');
      }
    });

    proc.stderr?.on('data', (buf: Buffer) => {
      const chunk = buf.toString('utf8');
      worker.stderrBuf += chunk;
      checkAuth(chunk);
    });

    proc.on('error', (err) => {
      handleWorkerExit(1, err instanceof Error ? err.message : String(err));
    });

    proc.on('close', (code) => {
      handleWorkerExit(code ?? 0);
    });

    return { ok: true, worker };
  }

  private sendOneShotCommand(
    req: AgySendPromptRequest,
    flags: string[],
    cwd: string,
    finalPrompt: string
  ): { ok: boolean; error?: string } {
    this.cancelTurn(req.tabSessionId);

    const agyBin = resolveAgyBinary();
    const args = ['--output-format', 'stream-json', ...flags];
    if (req.agyConversationId) {
      args.push('--conversation', req.agyConversationId);
    }
    args.push(`-p=${finalPrompt}`);

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
        if (obj.event === 'step_update' && typeof stepObj?.text_delta === 'string' && stepObj.text_delta) {
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
