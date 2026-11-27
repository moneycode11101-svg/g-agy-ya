import fs from 'node:fs';
import {
  analyzeTranscript,
  extractPrimaryQuota,
  formatDuration,
  formatTokens,
  inferContextWindowSize,
  saveLiveQuota,
  summarizeRecentToolsText,
} from '../lib/analyzer.mjs';

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const MAGENTA = '\x1b[35m';
const BLUE = '\x1b[34m';

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function progressBar(pct, width = 8) {
  const clamped = Math.max(0, Math.min(100, pct || 0));
  const filled = Math.round((clamped / 100) * width);
  const bar = '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled));
  const color = clamped >= 80 ? RED : clamped >= 50 ? YELLOW : GREEN;
  return `${color}${bar}${RESET}`;
}

function quotaColor(frac) {
  if (frac <= 0.15) return RED;
  if (frac <= 0.4) return YELLOW;
  return GREEN;
}

function main() {
  const raw = readStdin().trim();
  if (!raw) return;

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return;
  }

  const cw = payload.context_window || {};
  const cur = cw.current_usage || {};
  const modelName = payload.model?.display_name || payload.model?.id || 'model';
  const windowSize =
    Number(cw.context_window_size || 0) || inferContextWindowSize(modelName);

  // Sync official CLI quota & cost snapshot to shared state so Antigravity App can display it too!
  if (payload.quota || payload.cost || cw.context_window_size) {
    saveLiveQuota({
      source: 'antigravity-cli',
      updatedAt: new Date().toISOString(),
      modelId: payload.model?.id || modelName,
      contextWindowSize: windowSize,
      planTier: payload.plan_tier || null,
      email: payload.email || null,
      quota: payload.quota || null,
      cost: payload.cost || null,
    });
  }

  // Analyze transcript for per-tool +token deltas if available
  let analysis = null;
  if (payload.transcript_path && fs.existsSync(payload.transcript_path)) {
    analysis = analyzeTranscript(payload.transcript_path, {
      conversationId: payload.conversation_id,
    });
  }

  const curInput = Number(cur.input_tokens || 0);
  const curCacheRead = Number(cur.cache_read_input_tokens || 0);
  const curCacheWrite = Number(cur.cache_creation_input_tokens || 0);

  // Active context = cache_read + cache_creation + input_tokens (or fallback to transcript)
  let ctxTokens = curInput + curCacheRead + curCacheWrite;
  if (ctxTokens === 0 && analysis?.ok) {
    ctxTokens = analysis.currentContext;
  }
  const usedPct =
    typeof cw.used_percentage === 'number' && cw.used_percentage > 0
      ? cw.used_percentage
      : windowSize > 0
        ? (ctxTokens / windowSize) * 100
        : 0;

  // Cache stats: prefer exact CLI payload fields; fallback to transcript
  const cacheRead = curCacheRead > 0 || curInput > 0 ? curCacheRead : analysis?.latest?.cacheReadTokens || 0;
  // In Gemini/CLI, cache_creation_input_tokens may be 0 while uncached input_tokens represents fresh input
  const cacheWrite = curCacheWrite > 0 ? curCacheWrite : curInput > 0 ? curInput : analysis?.latest?.inputTokens || 0;
  const cacheWriteLabel = curCacheWrite > 0 ? 'CW' : 'W';
  const cacheDenom = cacheRead + cacheWrite + (curCacheWrite > 0 ? curInput : 0);
  const cacheHitPct = cacheDenom > 0 ? Math.round((cacheRead / cacheDenom) * 100) : 0;

  const segments = [];

  // 1. Context bar + accumulated tokens
  segments.push(
    `${progressBar(usedPct, 8)} ${BOLD}${formatTokens(ctxTokens)}${RESET}${DIM}/${formatTokens(windowSize)}${RESET} ${CYAN}${usedPct.toFixed(1)}%${RESET}`
  );

  // 2. Cache Read / Write + Hit %
  const hitColor = cacheHitPct >= 75 ? GREEN : cacheHitPct >= 40 ? YELLOW : DIM;
  segments.push(
    `${DIM}Cache${RESET} ${BLUE}R:${formatTokens(cacheRead)}${RESET} ${MAGENTA}${cacheWriteLabel}:${formatTokens(cacheWrite)}${RESET} ${hitColor}(${cacheHitPct}%)${RESET}`
  );

  // 2.5 Output speed (tok/s) from transcript
  const tps = analysis?.ok ? (analysis.latest?.tokPerSec ?? analysis.cumulative?.avgTokPerSec) : null;
  if (tps != null) {
    segments.push(`${CYAN}${tps.toFixed(1)}t/s${RESET}`);
  }

  // 3. Per-tool +token delta from transcript
  const recentTools = analysis?.ok ? summarizeRecentToolsText(analysis.recentToolBatch, 2) : '';
  if (recentTools) {
    segments.push(`${YELLOW}${recentTools}${RESET}`);
  }

  // 4. Official Quota
  const q = extractPrimaryQuota(payload.quota);
  if (q && q.remainingFraction != null) {
    const pct = Math.round(q.remainingFraction * 100);
    const reset = formatDuration(q.resetInSeconds);
    segments.push(
      `${DIM}Q${RESET} ${quotaColor(q.remainingFraction)}${BOLD}${pct}%${RESET}${reset ? `${DIM}(${reset})${RESET}` : ''}`
    );
  }

  // 5. Cost (if present & terminal is wide enough)
  const termWidth = Number(payload.terminal_width || 120);
  if (termWidth >= 100 && payload.cost && typeof payload.cost.total_usd === 'number') {
    segments.push(`${DIM}$${payload.cost.total_usd.toFixed(3)}${RESET}`);
  }

  // Trim if terminal is narrow
  const sep = ` ${DIM}│${RESET} `;
  const output = termWidth < 85 ? segments.slice(0, 3).join(sep) : segments.join(sep);
  process.stdout.write(output + '\n');
}

try {
  main();
} catch {
  // never break CLI statusline
}
