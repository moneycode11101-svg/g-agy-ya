import fs from 'node:fs';
import path from 'node:path';
import type {
  AccountQuotaSnapshot,
  ChatBlock,
  ChatMessage,
  SessionMetrics,
  SessionSummary,
  ToolCallItem,
} from '../../../src/shared/types';
import { safeTruncateUtf16 } from '../../../src/shared/agentProtocol';
import { resolveClaudeConfigDir } from './env';

interface ClaudeSessionEntry {
  sessionId: string;
  filePath: string;
  cwd: string;
  title: string;
  updatedAt: number;
  model: string;
  currentContext: number;
}

function inferClaudeContextWindow(model: string): number {
  const m = model.toLowerCase();
  if (m.includes('[1m]') || m.includes('1m') || m.includes('opus-5') || m.includes('sonnet-5') || m.includes('opus-4-6') || m.includes('sonnet-4-6')) {
    return 1_000_000;
  }
  return 200_000;
}

function summarizeToolInput(name: string, input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const o = input as Record<string, unknown>;
  const cand =
    o.command ??
    o.file_path ??
    o.path ??
    o.pattern ??
    o.query ??
    o.url ??
    o.description ??
    '';
  const s = String(cand).replace(/\s+/g, ' ').trim();
  if (!s) return name;
  if (s.includes('/') && !s.includes(' ')) return path.basename(s);
  return safeTruncateUtf16(s, 64);
}

function extractTextFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    if (obj.type === 'text' && typeof obj.text === 'string') {
      parts.push(obj.text);
    }
  }
  return parts.join('\n').trim();
}

function readHeadAndTailSummary(filePath: string): {
  title: string;
  cwd: string;
  model: string;
  currentContext: number;
} {
  let title = '';
  let cwd = '';
  let model = '';
  let currentContext = 0;

  try {
    const fd = fs.openSync(filePath, 'r');
    const st = fs.fstatSync(fd);
    const headLen = Math.min(st.size, 32_768);
    const headBuf = Buffer.alloc(headLen);
    fs.readSync(fd, headBuf, 0, headLen, 0);

    for (const line of headBuf.toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line) as Record<string, unknown>;
        if (!cwd && typeof obj.cwd === 'string' && obj.cwd) {
          cwd = obj.cwd;
        }
        if (obj.type === 'user' && !obj.isMeta && !title) {
          const msg = obj.message as Record<string, unknown> | undefined;
          const txt = extractTextFromContent(msg?.content).replace(/\s+/g, ' ').trim();
          if (txt && !txt.startsWith('<local-command') && !txt.startsWith('<command-name>')) {
            title = safeTruncateUtf16(txt, 48);
          }
        }
        if (title && cwd) break;
      } catch {
        // ignore truncated last line of head chunk
      }
    }

    const tailLen = Math.min(st.size, 65_536);
    const tailBuf = Buffer.alloc(tailLen);
    fs.readSync(fd, tailBuf, 0, tailLen, Math.max(0, st.size - tailLen));
    fs.closeSync(fd);

    for (const line of tailBuf.toString('utf8').split('\n').reverse()) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line) as Record<string, unknown>;
        if (!cwd && typeof obj.cwd === 'string' && obj.cwd) cwd = obj.cwd;
        if (obj.type === 'custom-title' && typeof obj.customTitle === 'string' && obj.customTitle.trim()) {
          title = obj.customTitle.trim();
        }
        if (obj.type === 'assistant') {
          const msg = obj.message as Record<string, unknown> | undefined;
          const m = typeof msg?.model === 'string' ? msg.model : '';
          if (m && m !== '<synthetic>') {
            if (!model) model = m;
            const u = msg?.usage as Record<string, unknown> | undefined;
            if (u && !currentContext) {
              const inp =
                Number(u.input_tokens || 0) +
                Number(u.cache_creation_input_tokens || 0) +
                Number(u.cache_read_input_tokens || 0);
              if (inp > 0) currentContext = inp + Number(u.output_tokens || 0);
            }
          }
        }
        if (model && currentContext > 0) break;
      } catch {
        // ignore partial line
      }
    }
  } catch {
    // ignore unreadable file
  }

  return { title, cwd, model, currentContext };
}

export function findClaudeTranscriptPath(sessionId: string, configDir?: string): string | null {
  if (!sessionId) return null;
  const projectsRoot = path.join(resolveClaudeConfigDir(configDir), 'projects');
  if (!fs.existsSync(projectsRoot)) return null;
  try {
    for (const proj of fs.readdirSync(projectsRoot)) {
      const candidate = path.join(projectsRoot, proj, `${sessionId}.jsonl`);
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch {
    // ignore
  }
  return null;
}

export function listRecentClaudeSessions(limit = 30, configDir?: string): SessionSummary[] {
  const projectsRoot = path.join(resolveClaudeConfigDir(configDir), 'projects');
  if (!fs.existsSync(projectsRoot)) return [];

  const files: Array<{ sessionId: string; filePath: string; mtimeMs: number }> = [];
  try {
    for (const proj of fs.readdirSync(projectsRoot)) {
      if (proj.startsWith('.')) continue;
      const projDir = path.join(projectsRoot, proj);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(projDir);
      } catch {
        continue;
      }
      if (!stat.isDirectory()) continue;
      let entries: string[];
      try {
        entries = fs.readdirSync(projDir);
      } catch {
        continue;
      }
      for (const f of entries) {
        if (!f.endsWith('.jsonl')) continue;
        const full = path.join(projDir, f);
        try {
          const fst = fs.statSync(full);
          if (fst.size < 20) continue;
          files.push({
            sessionId: f.slice(0, -'.jsonl'.length),
            filePath: full,
            mtimeMs: fst.mtimeMs,
          });
        } catch {
          // ignore
        }
      }
    }
  } catch {
    return [];
  }

  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const seenIds = new Set<string>();
  const out: SessionSummary[] = [];

  for (const item of files.slice(0, Math.min(limit * 3, 180))) {
    if (out.length >= limit) break;
    if (seenIds.has(item.sessionId)) continue;
    const summary = readHeadAndTailSummary(item.filePath);
    if (!summary.title) continue;
    // Skip internal scratchpad / temp probe sessions
    if (summary.cwd.includes('/private/tmp/') || summary.cwd.includes('/var/folders/')) continue;
    seenIds.add(item.sessionId);
    const entry: ClaudeSessionEntry = {
      sessionId: item.sessionId,
      filePath: item.filePath,
      cwd: summary.cwd,
      title: summary.title,
      updatedAt: item.mtimeMs,
      model: summary.model || 'claude',
      currentContext: summary.currentContext,
    };
    out.push({
      adapterId: 'agent-claude',
      conversationId: entry.sessionId,
      source: 'cli',
      title: entry.title,
      projectId: entry.cwd || 'claude',
      projectLabel: entry.cwd ? path.basename(entry.cwd) : 'Claude',
      cwd: entry.cwd || undefined,
      updatedAt: entry.updatedAt,
      currentContext: entry.currentContext,
      model: entry.model,
    });
  }

  return out;
}

export function loadClaudeTranscript(
  sessionId: string,
  quotaSnapshot?: AccountQuotaSnapshot,
  configDir?: string
): { messages: ChatMessage[]; metrics: SessionMetrics | null } {
  const filePath = findClaudeTranscriptPath(sessionId, configDir);
  if (!filePath) return { messages: [], metrics: null };

  let raw = '';
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return { messages: [], metrics: null };
  }

  const messages: ChatMessage[] = [];
  const toolIndex = new Map<string, ToolCallItem>();
  let latestModel = '';
  let invocations = 0;
  let totalInput = 0;
  let totalCacheRead = 0;
  let totalOutput = 0;
  let latestCtx = 0;
  let latestInput = 0;
  let latestCacheRead = 0;
  let latestCallAt: number | null = null;
  let lastTurnTokens = 0;
  let lastTurnOutput = 0;

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }

    if (obj.isSidechain === true) continue;
    const ts = typeof obj.timestamp === 'string' ? Date.parse(obj.timestamp) : Date.now();
    const safeTs = Number.isNaN(ts) ? Date.now() : ts;

    if (obj.type === 'user' && !obj.isMeta) {
      const msg = obj.message as Record<string, unknown> | undefined;
      const content = msg?.content;

      // Match tool_result blocks back to prior tool calls
      if (Array.isArray(content)) {
        let hasNonToolText = false;
        for (const item of content) {
          if (!item || typeof item !== 'object') continue;
          const b = item as Record<string, unknown>;
          if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
            const target = toolIndex.get(b.tool_use_id);
            if (target) {
              const resTxt =
                typeof b.content === 'string'
                  ? b.content
                  : extractTextFromContent(b.content);
              target.outputPreview = safeTruncateUtf16(resTxt, 600);
              target.status = b.is_error === true ? 'error' : 'done';
              target.endedAt = safeTs;
            }
          } else if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
            hasNonToolText = true;
          }
        }
        if (!hasNonToolText) continue;
      }

      const txt = extractTextFromContent(content).trim();
      if (!txt || txt.startsWith('<local-command-stdout>')) continue;
      messages.push({
        id: String(obj.uuid || `u-${messages.length}`),
        role: 'user',
        text: txt,
        createdAt: safeTs,
      });
    } else if (obj.type === 'assistant') {
      const msg = obj.message as Record<string, unknown> | undefined;
      const model = typeof msg?.model === 'string' ? msg.model : '';
      if (model === '<synthetic>') continue;
      if (model) latestModel = model;

      const u = msg?.usage as Record<string, unknown> | undefined;
      if (u) {
        const inp = Number(u.input_tokens || 0);
        const cw = Number(u.cache_creation_input_tokens || 0);
        const cr = Number(u.cache_read_input_tokens || 0);
        const out = Number(u.output_tokens || 0);
        const ctx = inp + cw + cr;
        if (ctx > 0) {
          invocations += 1;
          totalInput += inp + cw;
          totalCacheRead += cr;
          totalOutput += out;
          latestCtx = ctx + out;
          latestInput = inp + cw;
          latestCacheRead = cr;
          latestCallAt = safeTs;
          lastTurnTokens = inp + cw + out;
          lastTurnOutput = out;
        }
      }

      const content = Array.isArray(msg?.content) ? (msg.content as Array<Record<string, unknown>>) : [];
      const blocks: ChatBlock[] = [];
      const tools: ToolCallItem[] = [];
      let textAccum = '';
      let thinkingAccum = '';

      for (const b of content) {
        if (b.type === 'thinking' && typeof b.thinking === 'string' && b.thinking.trim()) {
          thinkingAccum += b.thinking;
          blocks.push({
            id: `th-${safeTs}-${blocks.length}`,
            type: 'thinking',
            text: b.thinking,
            startedAt: safeTs,
            endedAt: safeTs,
          });
        } else if (b.type === 'text' && typeof b.text === 'string' && b.text) {
          textAccum += b.text;
          blocks.push({
            id: `tx-${safeTs}-${blocks.length}`,
            type: 'text',
            text: b.text,
          });
        } else if (b.type === 'tool_use') {
          const id = String(b.id || `tc-${safeTs}-${blocks.length}`);
          const name = String(b.name || 'tool');
          const item: ToolCallItem = {
            id,
            name,
            argsSummary: summarizeToolInput(name, b.input),
            status: 'done',
            startedAt: safeTs,
            endedAt: safeTs,
          };
          toolIndex.set(id, item);
          tools.push(item);
          blocks.push({ id: `tb-${id}`, type: 'tool', tool: item });
        }
      }

      if (blocks.length === 0) continue;
      const prev = messages[messages.length - 1];
      if (prev && prev.role === 'assistant') {
        prev.blocks = [...(prev.blocks || []), ...blocks];
        prev.tools = [...(prev.tools || []), ...tools];
        if (textAccum) prev.text = prev.text ? `${prev.text}\n\n${textAccum}` : textAccum;
        if (thinkingAccum) prev.thinking = prev.thinking ? `${prev.thinking}\n${thinkingAccum}` : thinkingAccum;
        prev.endedAt = safeTs;
      } else {
        messages.push({
          id: String(obj.uuid || `a-${messages.length}`),
          role: 'assistant',
          text: textAccum,
          thinking: thinkingAccum || undefined,
          tools: tools.length > 0 ? tools : undefined,
          blocks,
          createdAt: safeTs,
          endedAt: safeTs,
        });
      }
    }
  }

  const contextWindow = inferClaudeContextWindow(latestModel || 'claude');
  const usedPct = contextWindow > 0 ? Number(((latestCtx / contextWindow) * 100).toFixed(1)) : 0;
  const denom = latestInput + latestCacheRead;
  const lastCacheHitPct = denom > 0 ? Number(((latestCacheRead / denom) * 100).toFixed(1)) : 0;
  const totalDenom = totalInput + totalCacheRead;
  const overallCacheHitPct = totalDenom > 0 ? Number(((totalCacheRead / totalDenom) * 100).toFixed(1)) : 0;
  const quota = quotaSnapshot || { buckets: [], updatedAt: null };

  const metrics: SessionMetrics = {
    conversationId: sessionId,
    model: latestModel || 'claude',
    invocations,
    currentContext: latestCtx,
    contextWindow,
    usedPct,
    lastCacheRead: latestCacheRead,
    lastInputTokens: latestInput,
    lastCacheHitPct,
    lastCallAt: latestCallAt,
    lastTurnTokens,
    lastTurnCalls: Math.max(1, invocations > 0 ? 1 : 0),
    lastTurnOutput,
    tokPerSec: null,
    sessionCumulative: totalInput + totalOutput,
    overallCacheHitPct,
    toolDeltas: [],
    recentTurns: [],
    quotaBuckets: quota.buckets,
    quotaUpdatedAt: quota.updatedAt,
  };

  return { messages: messages.slice(-80), metrics };
}
