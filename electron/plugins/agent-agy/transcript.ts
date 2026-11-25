import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  AccountQuotaSnapshot,
  ChatBlock,
  ChatMessage,
  ChatStepItem,
  SessionMetrics,
  SessionSummary,
  ToolCallItem,
  ToolDeltaSummary,
  TurnHistoryItem,
} from '../../../src/shared/types';

const HOME = os.homedir();
const APP_DATA_DIR = path.join(HOME, '.gemini', 'antigravity');
const APP_DB_PATH = path.join(APP_DATA_DIR, 'conversation_summaries.db');
const OWN_SESSIONS_PATH = path.join(APP_DATA_DIR, 'agy-desk-sessions.json');
const BRAIN_ROOTS: Array<{ source: 'app' | 'cli'; root: string }> = [
  { source: 'app', root: path.join(APP_DATA_DIR, 'brain') },
  { source: 'cli', root: path.join(HOME, '.gemini', 'antigravity-cli', 'brain') },
];
const STEP_TIMINGS_PATH = path.join(APP_DATA_DIR, 'token-band', 'step-timings.json');

interface RawStep {
  step_index?: number;
  type?: string;
  source?: string;
  content?: string;
  thinking?: string;
  model?: string;
  created_at?: string;
  input_tokens?: number;
  cache_read_tokens?: number;
  output_tokens?: number;
  tool_calls?: Array<{ id?: string; name?: string; args?: Record<string, unknown> }>;
}

export function formatProjectLabel(projectId: string): string {
  if (!projectId || projectId === 'outside-of-project') return '';
  if (projectId === 'default-cli-project') return 'CLI Project';
  return projectId;
}

export function registerOwnSession(entry: { conversationId: string; title?: string; cwd?: string }): void {
  try {
    let list: Array<{ conversationId: string; title: string; cwd?: string; updatedAt: number }> = [];
    if (fs.existsSync(OWN_SESSIONS_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(OWN_SESSIONS_PATH, 'utf8'));
      if (Array.isArray(parsed)) list = parsed;
    }
    const idx = list.findIndex((x) => x.conversationId === entry.conversationId);
    const now = Date.now();
    if (idx >= 0) {
      const prev = list[idx];
      const updated = {
        ...prev,
        title: prev.title || entry.title || entry.conversationId.slice(0, 8),
        cwd: entry.cwd || prev.cwd,
        updatedAt: now,
      };
      list.splice(idx, 1);
      list.unshift(updated);
    } else {
      list.unshift({
        conversationId: entry.conversationId,
        title: entry.title || entry.conversationId.slice(0, 8),
        cwd: entry.cwd,
        updatedAt: now,
      });
    }
    fs.mkdirSync(path.dirname(OWN_SESSIONS_PATH), { recursive: true });
    const tmp = `${OWN_SESSIONS_PATH}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(list.slice(0, 100), null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, OWN_SESSIONS_PATH);
  } catch {
    // non-fatal
  }
}

export function inferContextWindow(modelName: string): number {
  const m = String(modelName || '').toLowerCase();
  if (m.includes('gemini')) return 1_048_576;
  if (m.includes('claude')) return m.includes('1m') ? 1_000_000 : 200_000;
  if (m.includes('gpt-5') || m.includes('gpt-4.1')) return 1_000_000;
  if (m.includes('gpt') || m.includes('o1') || m.includes('o3') || m.includes('o4')) return 200_000;
  return 1_048_576;
}

export function resolveTranscriptPath(conversationId: string): string | null {
  if (!conversationId) return null;
  for (const { root } of BRAIN_ROOTS) {
    const dir = path.join(root, conversationId, '.system_generated', 'logs');
    const full = path.join(dir, 'transcript_full.jsonl');
    const compact = path.join(dir, 'transcript.jsonl');
    if (fs.existsSync(full)) return full;
    if (fs.existsSync(compact)) return compact;
  }
  return null;
}

function safeReadSteps(filePath: string): RawStep[] {
  let raw = '';
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }
  const out: RawStep[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as RawStep);
    } catch {
      // ignore partial line mid-write
    }
  }
  return out;
}

function loadTimings(conversationId: string): Record<string, number> {
  try {
    const raw = fs.readFileSync(STEP_TIMINGS_PATH, 'utf8');
    const all = JSON.parse(raw) as Record<string, Record<string, number>>;
    return all?.[conversationId] || {};
  } catch {
    return {};
  }
}

function summarizeArgs(args?: Record<string, unknown>): string {
  if (!args || typeof args !== 'object') return '';
  const cand =
    args.toolSummary ??
    args.Path ??
    args.path ??
    args.CommandLine ??
    args.command ??
    args.query ??
    args.url ??
    '';
  const s = String(cand).replace(/\s+/g, ' ').trim();
  if (!s) return '';
  if (s.includes('/') && !s.includes(' ')) return path.basename(s);
  return s.length > 56 ? s.slice(0, 56) + '…' : s;
}

function parseStepsFromArgs(args?: Record<string, unknown>): ChatStepItem[] | null {
  if (!args || !Array.isArray(args.steps)) return null;
  const out: ChatStepItem[] = [];
  for (const item of args.steps) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const title = typeof rec.title === 'string' ? rec.title.trim() : '';
    const statusRaw = typeof rec.status === 'string' ? rec.status : 'pending';
    if (!title) continue;
    const status: ChatStepItem['status'] =
      statusRaw === 'in_progress' ||
      statusRaw === 'done' ||
      statusRaw === 'skipped' ||
      statusRaw === 'failed'
        ? statusRaw
        : 'pending';
    out.push({ title, status });
  }
  return out.length > 0 ? out : null;
}

export function analyzeSingleSession(
  conversationId: string,
  quotaSnapshot?: AccountQuotaSnapshot
): SessionMetrics | null {
  const transcriptPath = resolveTranscriptPath(conversationId);
  if (!transcriptPath) return null;

  const steps = safeReadSteps(transcriptPath);
  const timings = loadTimings(conversationId);
  let fileMtimeMs = 0;
  try {
    fileMtimeMs = fs.statSync(transcriptPath).mtimeMs;
  } catch {
    fileMtimeMs = 0;
  }

  const plannerIndices: number[] = [];
  for (let i = 0; i < steps.length; i++) {
    if (steps[i].type === 'PLANNER_RESPONSE') plannerIndices.push(i);
  }

  const quota = quotaSnapshot || { buckets: [], updatedAt: null };
  if (plannerIndices.length === 0) {
    return {
      conversationId,
      model: 'unknown',
      invocations: 0,
      currentContext: 0,
      contextWindow: 1_048_576,
      usedPct: 0,
      lastCacheRead: 0,
      lastInputTokens: 0,
      lastCacheHitPct: 0,
      lastCallAt: null,
      lastTurnTokens: 0,
      lastTurnCalls: 0,
      lastTurnOutput: 0,
      tokPerSec: null,
      sessionCumulative: 0,
      overallCacheHitPct: 0,
      toolDeltas: [],
      recentTurns: [],
      quotaBuckets: quota.buckets,
      quotaUpdatedAt: quota.updatedAt,
    };
  }

  let totalInput = 0;
  let totalCacheRead = 0;
  let totalOutput = 0;
  let latestModel = '';
  let latestCtx = 0;
  let latestInput = 0;
  let latestCacheRead = 0;
  let latestCallAt: number | null = null;
  let prevCtx = 0;

  const byTool = new Map<string, { name: string; count: number; deltaTokens: number }>();
  let totalToolDelta = 0;
  const turns: TurnHistoryItem[] = [];

  let lastUserStepIdx = -1;
  for (let i = steps.length - 1; i >= 0; i--) {
    if (steps[i].type === 'USER_INPUT') {
      lastUserStepIdx = Number(steps[i].step_index ?? i);
      break;
    }
  }

  let lastTurnInput = 0;
  let lastTurnOutput = 0;
  let lastTurnCalls = 0;
  let lastTurnTimedOut = 0;
  let lastTurnTimedSec = 0;
  let latestTps: number | null = null;

  for (let p = 0; p < plannerIndices.length; p++) {
    const idx = plannerIndices[p];
    const s = steps[idx];
    const inp = Number(s.input_tokens || 0);
    const cr = Number(s.cache_read_tokens || 0);
    const out = Number(s.output_tokens || 0);
    const ctx = inp + cr;
    const hitPct = ctx > 0 ? Number(((cr / ctx) * 100).toFixed(1)) : 0;
    const compacted = p > 0 && prevCtx > 5000 && ctx < prevCtx * 0.72;
    const cacheMiss = p > 0 && ctx > 5000 && hitPct < 20;

    if (s.model) latestModel = s.model;
    totalInput += inp;
    totalCacheRead += cr;
    totalOutput += out;
    latestCtx = ctx;
    latestInput = inp;
    latestCacheRead = cr;

    const startMs = s.created_at ? Date.parse(s.created_at) : NaN;
    if (!Number.isNaN(startMs)) latestCallAt = startMs;

    const savedEnd = Number(timings[String(s.step_index)] || 0);
    const immediateNext = steps[idx + 1];
    const nextMs =
      immediateNext && immediateNext.type !== 'USER_INPUT' && immediateNext.created_at
        ? Date.parse(immediateNext.created_at)
        : NaN;
    let endMs = NaN;
    if (!Number.isNaN(startMs)) {
      if (savedEnd > startMs) endMs = savedEnd;
      else if (!Number.isNaN(nextMs) && nextMs > startMs) endMs = nextMs;
      else if (p === plannerIndices.length - 1 && fileMtimeMs > startMs && fileMtimeMs - startMs <= 600_000) {
        endMs = fileMtimeMs;
      }
    }
    const durSec =
      !Number.isNaN(startMs) && !Number.isNaN(endMs) && endMs - startMs >= 150 && endMs - startMs <= 600_000
        ? (endMs - startMs) / 1000
        : null;
    const tps = durSec && out > 0 ? Number((out / durSec).toFixed(1)) : null;
    if (tps != null) latestTps = tps;

    const stepIdxNum = Number(s.step_index ?? idx);
    if (stepIdxNum > lastUserStepIdx) {
      lastTurnInput += inp;
      lastTurnOutput += out;
      lastTurnCalls += 1;
      if (durSec && out > 0) {
        lastTurnTimedOut += out;
        lastTurnTimedSec += durSec;
      }
    }

    const toolCalls = Array.isArray(s.tool_calls) ? s.tool_calls : [];
    if (toolCalls.length > 0 && p + 1 < plannerIndices.length) {
      const nextStep = steps[plannerIndices[p + 1]];
      const nextCtx = Number(nextStep.input_tokens || 0) + Number(nextStep.cache_read_tokens || 0);
      const rawDelta = Math.max(0, nextCtx - ctx);
      const between = steps.slice(idx + 1, plannerIndices[p + 1]);
      const results = between.filter((b) => b.type !== 'USER_INPUT' && b.type !== 'SYSTEM_MESSAGE' && b.source !== 'SYSTEM');
      const weights = toolCalls.map((tc, j) => {
        const resLen = results[j] ? String(results[j].content || '').length : 0;
        const argLen = JSON.stringify(tc.args || {}).length;
        return Math.max(40, resLen + argLen);
      });
      const weightSum = weights.reduce((a, b) => a + b, 0);
      let assigned = 0;
      for (let j = 0; j < toolCalls.length; j++) {
        const name = toolCalls[j].name || 'tool';
        const isLast = j === toolCalls.length - 1;
        const delta =
          toolCalls.length === 1
            ? rawDelta
            : isLast
              ? Math.max(0, rawDelta - assigned)
              : Math.round((rawDelta * weights[j]) / Math.max(1, weightSum));
        assigned += delta;
        totalToolDelta += delta;
        const prev = byTool.get(name) || { name, count: 0, deltaTokens: 0 };
        prev.count += 1;
        prev.deltaTokens += delta;
        byTool.set(name, prev);
      }
    }

    turns.push({
      invocation: p + 1,
      contextAtCall: ctx,
      cacheHitPct: hitPct,
      outputTokens: out,
      tokPerSec: tps,
      compacted,
      cacheMiss,
    });
    prevCtx = ctx;
  }

  const contextWindow = inferContextWindow(latestModel);
  const usedPct = contextWindow > 0 ? Number(((latestCtx / contextWindow) * 100).toFixed(1)) : 0;
  const totalBilledInput = totalInput + totalCacheRead;
  const overallCacheHitPct = totalBilledInput > 0 ? Number(((totalCacheRead / totalBilledInput) * 100).toFixed(1)) : 0;
  const lastCacheHitPct = latestCtx > 0 ? Number(((latestCacheRead / latestCtx) * 100).toFixed(1)) : 0;
  const turnTps =
    lastTurnTimedSec > 0 && lastTurnTimedOut > 0
      ? Number((lastTurnTimedOut / lastTurnTimedSec).toFixed(1))
      : latestTps;

  const toolDeltas: ToolDeltaSummary[] = Array.from(byTool.values())
    .map((t) => ({
      ...t,
      sharePct: totalToolDelta > 0 ? Math.round((t.deltaTokens / totalToolDelta) * 100) : 0,
    }))
    .sort((a, b) => b.deltaTokens - a.deltaTokens);

  return {
    conversationId,
    model: latestModel || 'unknown',
    invocations: plannerIndices.length,
    currentContext: latestCtx,
    contextWindow,
    usedPct,
    lastCacheRead: latestCacheRead,
    lastInputTokens: latestInput,
    lastCacheHitPct,
    lastCallAt: latestCallAt,
    lastTurnTokens: lastTurnInput + lastTurnOutput,
    lastTurnCalls: Math.max(1, lastTurnCalls),
    lastTurnOutput,
    tokPerSec: turnTps,
    sessionCumulative: totalInput + totalOutput,
    overallCacheHitPct,
    toolDeltas,
    recentTurns: turns.slice(-20).reverse(),
    quotaBuckets: quota.buckets,
    quotaUpdatedAt: quota.updatedAt,
  };
}

export function loadTranscriptMessages(conversationId: string): ChatMessage[] {
  const transcriptPath = resolveTranscriptPath(conversationId);
  if (!transcriptPath) return [];

  const steps = safeReadSteps(transcriptPath);
  const messages: ChatMessage[] = [];

  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const ts = s.created_at ? Date.parse(s.created_at) : Date.now();
    if (s.type === 'USER_INPUT' && s.content) {
      const text = s.content
        .replace(/<USER_REQUEST>\s*/gi, '')
        .replace(/\s*<\/USER_REQUEST>/gi, '')
        .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, '')
        .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/gi, '')
        .replace(/<SYSTEM_MESSAGE>[\s\S]*?<\/SYSTEM_MESSAGE>/gi, '')
        .trim();
      if (!text) continue;
      messages.push({
        id: `u-${s.step_index ?? i}`,
        role: 'user',
        text,
        createdAt: Number.isNaN(ts) ? Date.now() : ts,
      });
    } else if (s.type === 'PLANNER_RESPONSE') {
      const stepBlocks: ChatBlock[] = [];
      const thinkingText = (s.thinking || '').trim();
      const stepTs = Number.isNaN(ts) ? Date.now() : ts;

      if (thinkingText) {
        stepBlocks.push({
          id: `th-${s.step_index ?? i}`,
          type: 'thinking',
          text: thinkingText,
          startedAt: stepTs,
          endedAt: stepTs,
        });
      }

      const tools: ToolCallItem[] = [];
      let latestSteps: ChatStepItem[] | null = null;
      for (let j = 0; j < (s.tool_calls || []).length; j++) {
        const tc = s.tool_calls![j];
        const name = tc.name || 'tool';
        if (name === 'update_focus') continue;
        if (name === 'update_steps') {
          const parsed = parseStepsFromArgs(tc.args);
          if (parsed) latestSteps = parsed;
          continue;
        }
        const toolItem: ToolCallItem = {
          id: tc.id || `tc-${s.step_index ?? i}-${j}`,
          name,
          title: typeof tc.args?.toolSummary === 'string' ? tc.args.toolSummary : undefined,
          argsSummary: summarizeArgs(tc.args),
          status: 'done',
        };
        tools.push(toolItem);
        stepBlocks.push({ id: `tb-${toolItem.id}`, type: 'tool', tool: toolItem });
      }

      if (latestSteps) {
        stepBlocks.push({
          id: `st-${s.step_index ?? i}`,
          type: 'steps',
          items: latestSteps,
        });
      }

      const text = (s.content || '').trim();
      if (text) {
        stepBlocks.push({
          id: `tx-${s.step_index ?? i}`,
          type: 'text',
          text,
        });
      }

      if (stepBlocks.length === 0) continue;

      const prev = messages[messages.length - 1];
      if (prev && prev.role === 'assistant') {
        if (tools.length > 0) prev.tools = [...(prev.tools || []), ...tools];
        if (text) prev.text = prev.text ? `${prev.text}\n\n${text}` : text;
        if (thinkingText) prev.thinking = prev.thinking ? `${prev.thinking}\n\n${thinkingText}` : thinkingText;
        prev.blocks = [...(prev.blocks || []), ...stepBlocks];
        prev.endedAt = stepTs;
      } else {
        messages.push({
          id: `a-${s.step_index ?? i}`,
          role: 'assistant',
          text,
          thinking: thinkingText || undefined,
          tools: tools.length > 0 ? tools : undefined,
          blocks: stepBlocks,
          createdAt: stepTs,
          endedAt: stepTs,
        });
      }
    }
  }
  return messages.slice(-80);
}

function readTailMetrics(transcriptPath: string): { currentContext: number; model: string } {
  try {
    const fd = fs.openSync(transcriptPath, 'r');
    const st = fs.fstatSync(fd);
    const tailLen = Math.min(st.size, 32768);
    const tailBuf = Buffer.alloc(tailLen);
    fs.readSync(fd, tailBuf, 0, tailLen, Math.max(0, st.size - tailLen));
    fs.closeSync(fd);
    for (const line of tailBuf.toString('utf8').split('\n').reverse()) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line) as RawStep;
        if (obj.type === 'PLANNER_RESPONSE') {
          return {
            currentContext: Number(obj.input_tokens || 0) + Number(obj.cache_read_tokens || 0),
            model: obj.model || '',
          };
        }
      } catch {
        // ignore partial line
      }
    }
  } catch {
    // ignore
  }
  return { currentContext: 0, model: '' };
}

export function listRecentSessions(limit = 40): SessionSummary[] {
  const byId = new Map<string, SessionSummary>();

  if (fs.existsSync(APP_DB_PATH)) {
    try {
      const sql = `
        SELECT conversation_id, title, project_id, last_modified_time
        FROM conversation_summaries
        WHERE parent_conversation_id = ''
          AND nesting_depth = 0
          AND source != 'CORTEX_TRAJECTORY_SOURCE_CLI'
          AND title != ''
          AND killed = 0
        ORDER BY last_modified_time DESC
        LIMIT ${Math.max(1, Math.min(100, limit))};
      `;
      const out = execFileSync('sqlite3', ['-json', APP_DB_PATH, sql], {
        encoding: 'utf8',
        timeout: 2500,
      }).trim();
      const rows = out
        ? (JSON.parse(out) as Array<{
            conversation_id: string;
            title: string;
            project_id: string;
            last_modified_time: string;
          }>)
        : [];

      for (const r of rows) {
        const ts = Date.parse(r.last_modified_time.replace(' ', 'T'));
        const tPath = resolveTranscriptPath(r.conversation_id);
        const tail = tPath ? readTailMetrics(tPath) : { currentContext: 0, model: '' };
        byId.set(r.conversation_id, {
          conversationId: r.conversation_id,
          source: 'app',
          title: r.title,
          projectId: r.project_id || 'outside-of-project',
          projectLabel: formatProjectLabel(r.project_id || ''),
          updatedAt: Number.isNaN(ts) ? Date.now() : ts,
          currentContext: tail.currentContext,
          model: tail.model,
        });
      }
    } catch {
      // sqlite3 unavailable or db busy
    }
  }

  if (fs.existsSync(OWN_SESSIONS_PATH)) {
    try {
      const own = JSON.parse(fs.readFileSync(OWN_SESSIONS_PATH, 'utf8')) as Array<{
        conversationId: string;
        title: string;
        cwd?: string;
        updatedAt: number;
      }>;
      if (Array.isArray(own)) {
        for (const o of own) {
          if (!o.conversationId || byId.has(o.conversationId)) continue;
          const tPath = resolveTranscriptPath(o.conversationId);
          const tail = tPath ? readTailMetrics(tPath) : { currentContext: 0, model: '' };
          let fileMtime = 0;
          if (tPath) {
            try {
              fileMtime = fs.statSync(tPath).mtimeMs;
            } catch {
              fileMtime = 0;
            }
          }
          const projectLabel = o.cwd ? path.basename(o.cwd) : 'agy Desk';
          byId.set(o.conversationId, {
            conversationId: o.conversationId,
            source: 'cli',
            title: o.title || o.conversationId.slice(0, 8),
            projectId: o.cwd || 'agy-desk',
            projectLabel,
            updatedAt: Math.max(o.updatedAt || 0, fileMtime) || Date.now(),
            currentContext: tail.currentContext,
            model: tail.model,
          });
        }
      }
    } catch {
      // ignore
    }
  }

  return Array.from(byId.values())
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, limit);
}

export function watchSingleSession(
  conversationId: string,
  getQuotaSnapshot: () => AccountQuotaSnapshot,
  onChange: (metrics: SessionMetrics) => void
): () => void {
  const transcriptPath = resolveTranscriptPath(conversationId);
  if (!transcriptPath) return () => {};

  const watchDir = path.dirname(transcriptPath);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  const trigger = () => {
    if (closed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      if (closed) return;
      const m = analyzeSingleSession(conversationId, getQuotaSnapshot());
      if (m) onChange(m);
    }, 100);
  };

  let watcher: fs.FSWatcher | null = null;
  try {
    watcher = fs.watch(watchDir, (_eventType, filename) => {
      if (!filename || filename.includes('transcript')) {
        trigger();
      }
    });
  } catch {
    watcher = null;
  }

  return () => {
    closed = true;
    if (timer) clearTimeout(timer);
    try {
      watcher?.close();
    } catch {
      // ignore
    }
  };
}
