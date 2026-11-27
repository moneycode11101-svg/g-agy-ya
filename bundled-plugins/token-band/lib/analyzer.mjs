import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const STATE_DIR = path.join(os.homedir(), '.gemini', 'antigravity', 'token-band');
export const SETTINGS_PATH = path.join(STATE_DIR, 'settings.json');
export const LIVE_QUOTA_PATH = path.join(STATE_DIR, 'live-quota.json');
export const STEP_TIMINGS_PATH = path.join(STATE_DIR, 'step-timings.json');

export const DEFAULT_SETTINGS = {
  hudEnabled: true,
  hudMode: 'hud', // 'hud' | 'compact' | 'off'
  showOnEveryInvocation: false,
  dailyTokenBudget: 2_000_000,
  sessionTokenBudget: 500_000,
  contextWindowOverride: 0,
};

export function ensureStateDir() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
}

export function loadSettings() {
  try {
    const raw = fs.readFileSync(SETTINGS_PATH, 'utf8');
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(partial) {
  ensureStateDir();
  const next = { ...loadSettings(), ...partial };
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(next, null, 2) + '\n', 'utf8');
  return next;
}

export function loadLiveQuota() {
  try {
    const raw = fs.readFileSync(LIVE_QUOTA_PATH, 'utf8');
    const data = JSON.parse(raw);
    return data && typeof data === 'object' ? data : null;
  } catch {
    return null;
  }
}

export function saveLiveQuota(snapshot) {
  try {
    ensureStateDir();
    fs.writeFileSync(LIVE_QUOTA_PATH, JSON.stringify(snapshot, null, 2) + '\n', 'utf8');
  } catch {
    // non-fatal
  }
}

export function loadStepTimings(conversationId) {
  if (!conversationId) return {};
  try {
    const raw = fs.readFileSync(STEP_TIMINGS_PATH, 'utf8');
    const all = JSON.parse(raw);
    const entry = all && typeof all === 'object' ? all[conversationId] : null;
    return entry && typeof entry === 'object' ? entry : {};
  } catch {
    return {};
  }
}

export function recordStepTiming(conversationId, stepIndex, completedAtMs = Date.now()) {
  if (!conversationId || stepIndex == null) return;
  try {
    ensureStateDir();
    let all = {};
    try {
      const raw = fs.readFileSync(STEP_TIMINGS_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') all = parsed;
    } catch {
      all = {};
    }
    const prev = all[conversationId] && typeof all[conversationId] === 'object' ? all[conversationId] : {};
    const key = String(stepIndex);
    if (!prev[key]) {
      prev[key] = completedAtMs;
      prev._updatedAt = completedAtMs;
      all[conversationId] = prev;
      // Keep only the 30 most recently updated conversations
      const keys = Object.keys(all);
      if (keys.length > 30) {
        keys
          .sort((a, b) => Number(all[b]?._updatedAt || 0) - Number(all[a]?._updatedAt || 0))
          .slice(30)
          .forEach((k) => delete all[k]);
      }
      fs.writeFileSync(STEP_TIMINGS_PATH, JSON.stringify(all) + '\n', 'utf8');
    }
  } catch {
    // non-fatal
  }
}

export function inferContextWindowSize(modelName, override = 0) {
  if (override && override > 0) return override;
  const m = String(modelName || '').toLowerCase();
  if (m.includes('gemini')) return 1_048_576;
  if (m.includes('claude')) {
    if (m.includes('1m')) return 1_000_000;
    return 200_000;
  }
  if (m.includes('gpt-5') || m.includes('gpt-4.1')) return 1_000_000;
  if (m.includes('gpt') || m.includes('o1') || m.includes('o3') || m.includes('o4')) return 200_000;
  return 1_048_576;
}

export function formatTokens(n) {
  if (n == null || Number.isNaN(n)) return '0';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1_000_000) {
    const v = abs / 1_000_000;
    return `${sign}${v >= 10 ? v.toFixed(1) : v.toFixed(2)}M`;
  }
  if (abs >= 1_000) {
    const v = abs / 1_000;
    return `${sign}${v >= 100 ? Math.round(v) : v.toFixed(1)}k`;
  }
  return `${sign}${Math.round(abs)}`;
}

export function formatTokensKo(n) {
  if (n == null || Number.isNaN(n)) return '0';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 100_000_000) {
    return `${sign}${(abs / 100_000_000).toFixed(1)}억`;
  }
  if (abs >= 10_000) {
    const v = abs / 10_000;
    return `${sign}${v >= 100 ? Math.round(v) : v.toFixed(1)}만`;
  }
  if (abs >= 1_000) {
    return `${sign}${(abs / 1_000).toFixed(1)}천`;
  }
  return `${sign}${Math.round(abs)}`;
}

export function formatDuration(seconds) {
  if (seconds == null || seconds <= 0 || Number.isNaN(seconds)) return '';
  const s = Math.floor(seconds);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d${h > 0 ? `${h}h` : ''}`;
  if (h > 0) return `${h}h${m > 0 ? `${m}m` : ''}`;
  return `${Math.max(1, m)}m`;
}

export function getBrainRoots() {
  const home = os.homedir();
  return [
    { source: 'app', root: path.join(home, '.gemini', 'antigravity', 'brain') },
    { source: 'cli', root: path.join(home, '.gemini', 'antigravity-cli', 'brain') },
    { source: 'ide', root: path.join(home, '.gemini', 'antigravity-ide', 'brain') },
  ];
}

function readFirstUserTitle(transcriptPath) {
  try {
    const fd = fs.openSync(transcriptPath, 'r');
    const buf = Buffer.alloc(4096);
    const bytes = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const chunk = buf.toString('utf8', 0, bytes);
    for (const line of chunk.split('\n')) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.type === 'USER_INPUT' && obj.content) {
          const clean = String(obj.content).replace(/\s+/g, ' ').trim();
          return clean.length > 56 ? clean.slice(0, 56) + '…' : clean;
        }
      } catch {
        // partial line
      }
    }
  } catch {
    // ignore
  }
  return '';
}

export function listRecentConversations(limit = 20) {
  const found = [];
  for (const { source, root } of getBrainRoots()) {
    if (!fs.existsSync(root)) continue;
    let entries;
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const logDir = path.join(root, ent.name, '.system_generated', 'logs');
      const fullPath = path.join(logDir, 'transcript_full.jsonl');
      const compactPath = path.join(logDir, 'transcript.jsonl');
      const target = fs.existsSync(fullPath) ? fullPath : fs.existsSync(compactPath) ? compactPath : null;
      if (!target) continue;
      try {
        const st = fs.statSync(target);
        found.push({
          conversationId: ent.name,
          source,
          transcriptPath: target,
          updatedAt: st.mtime.toISOString(),
          mtimeMs: st.mtimeMs,
          sizeBytes: st.size,
        });
      } catch {
        // skip
      }
    }
  }
  found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return found.slice(0, limit).map((item) => ({
    ...item,
    title: readFirstUserTitle(item.transcriptPath) || item.conversationId.slice(0, 8),
  }));
}

export function resolveTranscriptPath(conversationId, explicitPath) {
  if (explicitPath) {
    const dir = path.dirname(explicitPath);
    const full = path.join(dir, 'transcript_full.jsonl');
    if (fs.existsSync(full)) return full;
    if (fs.existsSync(explicitPath)) return explicitPath;
  }
  if (conversationId) {
    for (const { root } of getBrainRoots()) {
      const logDir = path.join(root, conversationId, '.system_generated', 'logs');
      const full = path.join(logDir, 'transcript_full.jsonl');
      const compact = path.join(logDir, 'transcript.jsonl');
      if (fs.existsSync(full)) return full;
      if (fs.existsSync(compact)) return compact;
    }
  }
  const recent = listRecentConversations(1);
  return recent[0]?.transcriptPath || null;
}

function safeParseLines(filePath) {
  let text = '';
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }
  const steps = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      steps.push(JSON.parse(trimmed));
    } catch {
      // ignore truncated trailing line during live write
    }
  }
  return steps;
}

function toolArgSummary(toolCall) {
  if (!toolCall || !toolCall.args || typeof toolCall.args !== 'object') return '';
  const a = toolCall.args;
  const candidate =
    a.Path || a.path || a.CommandLine || a.command || a.query || a.Query || a.url || a.Url || a.Role || '';
  const cleaned = String(candidate).replace(/^"|"$/g, '').replace(/\s+/g, ' ').trim();
  if (!cleaned) return '';
  if (cleaned.includes('/') && !cleaned.includes(' ')) {
    const base = path.basename(cleaned);
    return base.length > 28 ? base.slice(0, 28) + '…' : base;
  }
  return cleaned.length > 34 ? cleaned.slice(0, 34) + '…' : cleaned;
}

function estimateCallArgsLen(toolCall) {
  try {
    return JSON.stringify(toolCall?.args || {}).length + (toolCall?.name?.length || 0);
  } catch {
    return 40;
  }
}

export function analyzeTranscript(transcriptPath, opts = {}) {
  const settings = opts.settings || loadSettings();
  const liveQuota = opts.liveQuota !== undefined ? opts.liveQuota : loadLiveQuota();

  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    return {
      ok: false,
      error: '트랜스크립트 파일을 찾을 수 없습니다.',
      transcriptPath: transcriptPath || null,
      liveQuota,
      settings,
    };
  }

  // Always prefer transcript_full.jsonl in same dir for accurate per-tool proportional weights
  const fullCandidate = path.join(path.dirname(transcriptPath), 'transcript_full.jsonl');
  const readPath = fs.existsSync(fullCandidate) ? fullCandidate : transcriptPath;
  const steps = safeParseLines(readPath);
  let fileMtimeMs = 0;
  try {
    fileMtimeMs = fs.statSync(readPath).mtimeMs;
  } catch {
    fileMtimeMs = 0;
  }

  // Extract conversation ID from path if possible
  const matchId = readPath.match(/brain\/([^/]+)\/\.system_generated/);
  const conversationId = opts.conversationId || (matchId ? matchId[1] : path.basename(path.dirname(readPath)));
  const stepTimings = loadStepTimings(conversationId);

  // Identify all PLANNER_RESPONSE indices
  const plannerIndices = [];
  for (let i = 0; i < steps.length; i++) {
    if (steps[i].type === 'PLANNER_RESPONSE') {
      plannerIndices.push(i);
    }
  }

  let totalInputTokens = 0;
  let totalCacheReadTokens = 0;
  let totalOutputTokens = 0;
  let latestModel = '';
  let latestContextAtCall = 0;
  let latestInputTokens = 0;
  let latestCacheReadTokens = 0;
  let latestOutputTokens = 0;
  let latestDurationSec = null;
  let latestTokPerSec = null;
  let timedOutputTokens = 0;
  let timedDurationSec = 0;
  let peakTokPerSec = null;

  let calibChars = 0;
  let calibTokens = 0;

  const toolEvents = [];
  const timeline = [];

  for (let p = 0; p < plannerIndices.length; p++) {
    const idx = plannerIndices[p];
    const step = steps[idx];
    const input = Number(step.input_tokens || 0);
    const cacheRead = Number(step.cache_read_tokens || 0);
    const output = Number(step.output_tokens || 0);
    const ctxAtCall = input + cacheRead;
    const hitPct = ctxAtCall > 0 ? (cacheRead / ctxAtCall) * 100 : 0;

    if (step.model) latestModel = step.model;
    totalInputTokens += input;
    totalCacheReadTokens += cacheRead;
    totalOutputTokens += output;
    latestContextAtCall = ctxAtCall;
    latestInputTokens = input;
    latestCacheReadTokens = cacheRead;
    latestOutputTokens = output;

    const prevCtx = p > 0 ? timeline[p - 1].contextAtCall : 0;
    const stepDelta = p > 0 ? ctxAtCall - prevCtx : ctxAtCall;

    const toolCalls = Array.isArray(step.tool_calls) ? step.tool_calls : [];

    // Find intermediate steps between this planner step and the next planner step (or end)
    const nextIdx = p + 1 < plannerIndices.length ? plannerIndices[p + 1] : steps.length;
    const betweenSteps = steps.slice(idx + 1, nextIdx);

    // Tool result steps are GENERIC / MODEL steps (exclude USER_INPUT / SYSTEM_MESSAGE)
    const resultSteps = betweenSteps.filter(
      (s) => s.type !== 'USER_INPUT' && s.type !== 'SYSTEM_MESSAGE' && s.source !== 'SYSTEM'
    );
    const userStepsBetween = betweenSteps.filter((s) => s.type === 'USER_INPUT');

    const batchItems = [];
    if (toolCalls.length > 0 && p + 1 < plannerIndices.length) {
      const nextStep = steps[plannerIndices[p + 1]];
      const nextCtx = Number(nextStep.input_tokens || 0) + Number(nextStep.cache_read_tokens || 0);
      const rawBatchDelta = Math.max(0, nextCtx - ctxAtCall);

      // Subtract user input chars if a user turn occurred between tool calls (rare)
      const userChars = userStepsBetween.reduce((acc, s) => acc + String(s.content || '').length, 0);
      const weights = toolCalls.map((tc, j) => {
        const res = resultSteps[j];
        const resLen = res ? String(res.content || '').length : 0;
        const argLen = estimateCallArgsLen(tc);
        return Math.max(40, resLen + argLen);
      });
      const toolWeightSum = weights.reduce((a, b) => a + b, 0);
      const totalWeight = toolWeightSum + userChars;

      // Calibrate chars-per-token when no user message interfered and delta is meaningful
      if (userChars === 0 && rawBatchDelta > 50 && toolWeightSum > 100) {
        calibChars += toolWeightSum;
        calibTokens += rawBatchDelta;
      }

      const toolBudgetDelta =
        totalWeight > 0 ? Math.round((rawBatchDelta * toolWeightSum) / totalWeight) : rawBatchDelta;

      let assigned = 0;
      for (let j = 0; j < toolCalls.length; j++) {
        const tc = toolCalls[j];
        const isLast = j === toolCalls.length - 1;
        const delta =
          toolCalls.length === 1
            ? toolBudgetDelta
            : isLast
              ? Math.max(0, toolBudgetDelta - assigned)
              : Math.round((toolBudgetDelta * weights[j]) / toolWeightSum);
        assigned += delta;
        const ev = {
          plannerStepIndex: step.step_index,
          callIndex: j,
          name: tc.name || 'unknown',
          target: toolArgSummary(tc),
          deltaTokens: delta,
          chars: weights[j],
          estimated: false,
          apportioned: toolCalls.length > 1,
          createdAt: step.created_at || null,
        };
        toolEvents.push(ev);
        batchItems.push(ev);
      }
    } else if (toolCalls.length > 0 && p + 1 === plannerIndices.length && resultSteps.length > 0) {
      // Pending tools that just executed after the latest PLANNER_RESPONSE (for PostInvocation!)
      const ratio = calibTokens > 0 ? Math.min(5.5, Math.max(1.8, calibChars / calibTokens)) : 3.2;
      for (let j = 0; j < toolCalls.length; j++) {
        const tc = toolCalls[j];
        const res = resultSteps[j];
        if (!res) continue;
        const weight = Math.max(40, String(res.content || '').length + estimateCallArgsLen(tc));
        const estDelta = Math.max(1, Math.round(weight / ratio));
        const ev = {
          plannerStepIndex: step.step_index,
          callIndex: j,
          name: tc.name || 'unknown',
          target: toolArgSummary(tc),
          deltaTokens: estDelta,
          chars: weight,
          estimated: true,
          apportioned: false,
          createdAt: res.created_at || step.created_at || null,
        };
        toolEvents.push(ev);
        batchItems.push(ev);
      }
    }

    const startMs = step.created_at ? Date.parse(step.created_at) : NaN;
    const savedEndMs = Number(stepTimings[String(step.step_index)] || 0);
    const immediateNext = steps[idx + 1];
    const nextNonUserMs =
      immediateNext && immediateNext.type !== 'USER_INPUT' && immediateNext.created_at
        ? Date.parse(immediateNext.created_at)
        : NaN;
    const isLastPlanner = p === plannerIndices.length - 1;
    let endMs = NaN;
    if (!Number.isNaN(startMs)) {
      if (savedEndMs > startMs) {
        endMs = savedEndMs;
      } else if (!Number.isNaN(nextNonUserMs) && nextNonUserMs > startMs) {
        endMs = nextNonUserMs;
      } else if (isLastPlanner && fileMtimeMs > startMs && fileMtimeMs - startMs <= 600_000) {
        endMs = fileMtimeMs;
      }
    }
    const rawDurationSec =
      !Number.isNaN(startMs) && !Number.isNaN(endMs) && endMs > startMs ? (endMs - startMs) / 1000 : null;
    const durationSec =
      rawDurationSec != null && rawDurationSec >= 0.15 && rawDurationSec <= 600
        ? Number(rawDurationSec.toFixed(2))
        : null;
    const tokPerSec =
      durationSec != null && output > 0 ? Number((output / durationSec).toFixed(1)) : null;

    if (durationSec != null && output > 0) {
      timedOutputTokens += output;
      timedDurationSec += durationSec;
      if (peakTokPerSec == null || tokPerSec > peakTokPerSec) {
        peakTokPerSec = tokPerSec;
      }
      latestDurationSec = durationSec;
      latestTokPerSec = tokPerSec;
    }

    timeline.push({
      invocation: p + 1,
      stepIndex: step.step_index,
      createdAt: step.created_at || null,
      model: step.model || latestModel,
      inputTokens: input,
      cacheReadTokens: cacheRead,
      outputTokens: output,
      durationSec,
      tokPerSec,
      contextAtCall: ctxAtCall,
      contextDelta: stepDelta,
      cacheHitPct: Number(hitPct.toFixed(1)),
      toolCalls: toolCalls.map((t) => t.name || 'unknown'),
      toolDeltas: batchItems,
    });
  }

  const pendingTools = toolEvents.filter((e) => e.estimated);
  const pendingDeltaTotal = pendingTools.reduce((a, b) => a + b.deltaTokens, 0);
  const currentContext = latestContextAtCall + (pendingDeltaTotal > 0 ? pendingDeltaTotal + latestOutputTokens : 0);

  // Use CLI context window size only if model matches or override is set
  const cliWindow =
    liveQuota?.contextWindowSize && liveQuota?.modelId && latestModel && liveQuota.modelId.toLowerCase().includes(latestModel.split('-')[0])
      ? liveQuota.contextWindowSize
      : 0;
  const contextWindowSize = inferContextWindowSize(latestModel, settings.contextWindowOverride || cliWindow);
  const usedPct = contextWindowSize > 0 ? Number(((currentContext / contextWindowSize) * 100).toFixed(2)) : 0;

  // Aggregate per-tool stats
  const byToolMap = new Map();
  let totalToolDelta = 0;
  for (const ev of toolEvents) {
    totalToolDelta += ev.deltaTokens;
    const prev = byToolMap.get(ev.name) || {
      name: ev.name,
      count: 0,
      totalDelta: 0,
      maxDelta: 0,
      hasEstimated: false,
    };
    prev.count += 1;
    prev.totalDelta += ev.deltaTokens;
    if (ev.deltaTokens > prev.maxDelta) prev.maxDelta = ev.deltaTokens;
    if (ev.estimated) prev.hasEstimated = true;
    byToolMap.set(ev.name, prev);
  }
  const byTool = Array.from(byToolMap.values())
    .map((t) => ({
      ...t,
      avgDelta: Math.round(t.totalDelta / Math.max(1, t.count)),
      sharePct: totalToolDelta > 0 ? Number(((t.totalDelta / totalToolDelta) * 100).toFixed(1)) : 0,
    }))
    .sort((a, b) => b.totalDelta - a.totalDelta);

  // Recent tool batch (last step with tools) & current turn tools (since last USER_INPUT)
  let lastUserStepIndex = -1;
  for (let i = steps.length - 1; i >= 0; i--) {
    if (steps[i].type === 'USER_INPUT') {
      lastUserStepIndex = Number(steps[i].step_index ?? i);
      break;
    }
  }
  const currentTurnTools = toolEvents.filter((ev) => ev.plannerStepIndex > lastUserStepIndex);
  const lastTurnTimeline = timeline.filter((t) => Number(t.stepIndex ?? 0) > lastUserStepIndex);
  const effectiveTurnSteps = lastTurnTimeline.length > 0 ? lastTurnTimeline : timeline.slice(-1);
  let lastTurnInput = 0;
  let lastTurnCacheRead = 0;
  let lastTurnOutput = 0;
  let lastTurnTimedOut = 0;
  let lastTurnTimedSec = 0;
  for (const t of effectiveTurnSteps) {
    lastTurnInput += t.inputTokens;
    lastTurnCacheRead += t.cacheReadTokens;
    lastTurnOutput += t.outputTokens;
    if (t.durationSec != null && t.outputTokens > 0) {
      lastTurnTimedOut += t.outputTokens;
      lastTurnTimedSec += t.durationSec;
    }
  }
  const lastTurnTokPerSec =
    lastTurnTimedSec > 0 && lastTurnTimedOut > 0
      ? Number((lastTurnTimedOut / lastTurnTimedSec).toFixed(1))
      : latestTokPerSec;
  const lastTimelineItem = timeline[timeline.length - 1] || null;
  const lastTurn = {
    calls: effectiveTurnSteps.length,
    inputTokens: lastTurnInput,
    cacheReadTokens: lastTurnCacheRead,
    outputTokens: lastTurnOutput,
    effectiveTokens: lastTurnInput + lastTurnOutput,
    totalTokens: lastTurnInput + lastTurnCacheRead + lastTurnOutput,
    tokPerSec: lastTurnTokPerSec,
  };

  let recentToolBatch = [];
  for (let i = timeline.length - 1; i >= 0; i--) {
    if (timeline[i].toolDeltas && timeline[i].toolDeltas.length > 0) {
      recentToolBatch = timeline[i].toolDeltas;
      break;
    }
  }

  const totalBilledInput = totalInputTokens + totalCacheReadTokens;
  const overallCacheHitPct = totalBilledInput > 0 ? Number(((totalCacheReadTokens / totalBilledInput) * 100).toFixed(1)) : 0;
  const latestCacheHitPct =
    latestContextAtCall > 0 ? Number(((latestCacheReadTokens / latestContextAtCall) * 100).toFixed(1)) : 0;

  const firstUser = steps.find((s) => s.type === 'USER_INPUT');
  const title = firstUser?.content
    ? String(firstUser.content).replace(/\s+/g, ' ').trim().slice(0, 64)
    : conversationId.slice(0, 8);

  const avgTokPerSec =
    timedDurationSec > 0 && timedOutputTokens > 0
      ? Number((timedOutputTokens / timedDurationSec).toFixed(1))
      : null;

  return {
    ok: true,
    conversationId,
    title,
    transcriptPath: readPath,
    model: latestModel || 'unknown',
    invocations: plannerIndices.length,
    currentContext,
    exactLastContext: latestContextAtCall,
    pendingDeltaTotal,
    contextWindowSize,
    usedPct,
    latest: {
      inputTokens: latestInputTokens, // cache write / fresh input
      cacheReadTokens: latestCacheReadTokens,
      outputTokens: latestOutputTokens,
      cacheHitPct: latestCacheHitPct,
      durationSec: latestDurationSec,
      tokPerSec: latestTokPerSec,
      createdAt: lastTimelineItem?.createdAt || null,
    },
    lastTurn,
    cumulative: {
      inputTokens: totalInputTokens,
      cacheReadTokens: totalCacheReadTokens,
      outputTokens: totalOutputTokens,
      totalTokens: totalInputTokens + totalCacheReadTokens + totalOutputTokens,
      uncachedPlusOutput: totalInputTokens + totalOutputTokens,
      overallCacheHitPct,
      totalToolDelta,
      avgTokPerSec,
      peakTokPerSec,
      timedDurationSec: Number(timedDurationSec.toFixed(2)),
    },
    byTool,
    recentToolBatch,
    currentTurnTools,
    toolEvents: toolEvents.slice(-80),
    timeline,
    liveQuota,
    settings,
  };
}

let cachedUsageRollup = null;
let cachedUsageAt = 0;

export function computeLocalUsageRollup(force = false) {
  const now = Date.now();
  if (!force && cachedUsageRollup && now - cachedUsageAt < 10_000) {
    return cachedUsageRollup;
  }
  const dayMs = 24 * 60 * 60 * 1000;
  const weekMs = 7 * dayMs;
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const todayCutoff = startOfToday.getTime();
  const weekCutoff = now - weekMs;

  let todayTotal = 0;
  let todayUncached = 0;
  let todayCacheRead = 0;
  let todayOutput = 0;
  let weekTotal = 0;
  let todayConversations = 0;

  const recent = listRecentConversations(60);
  for (const conv of recent) {
    if (conv.mtimeMs < weekCutoff) continue;
    const steps = safeParseLines(conv.transcriptPath);
    let convHasToday = false;
    for (const s of steps) {
      if (s.type !== 'PLANNER_RESPONSE') continue;
      const ts = s.created_at ? Date.parse(s.created_at) : conv.mtimeMs;
      const inp = Number(s.input_tokens || 0);
      const cr = Number(s.cache_read_tokens || 0);
      const out = Number(s.output_tokens || 0);
      const sum = inp + cr + out;
      if (ts >= weekCutoff) {
        weekTotal += sum;
      }
      if (ts >= todayCutoff) {
        convHasToday = true;
        todayTotal += sum;
        todayUncached += inp;
        todayCacheRead += cr;
        todayOutput += out;
      }
    }
    if (convHasToday) todayConversations += 1;
  }

  cachedUsageRollup = {
    todayTotal,
    todayUncached,
    todayCacheRead,
    todayOutput,
    todayConversations,
    weekTotal,
    computedAt: new Date(now).toISOString(),
  };
  cachedUsageAt = now;
  return cachedUsageRollup;
}

export function extractPrimaryQuota(quotaObj) {
  if (!quotaObj || typeof quotaObj !== 'object') return null;
  const entries = Object.entries(quotaObj).filter(([, v]) => v && typeof v === 'object' && !v.disabled);
  if (entries.length === 0) return null;
  // Prefer lowest remaining_fraction (most urgent quota bucket)
  entries.sort((a, b) => {
    const fa = typeof a[1].remaining_fraction === 'number' ? a[1].remaining_fraction : 1;
    const fb = typeof b[1].remaining_fraction === 'number' ? b[1].remaining_fraction : 1;
    return fa - fb;
  });
  const [bucketId, info] = entries[0];
  return {
    bucketId,
    remainingFraction: typeof info.remaining_fraction === 'number' ? info.remaining_fraction : null,
    remainingAmount: typeof info.remaining_amount === 'number' ? info.remaining_amount : null,
    resetTime: info.reset_time || null,
    resetInSeconds: typeof info.reset_in_seconds === 'number' ? info.reset_in_seconds : null,
    allBuckets: entries.map(([id, v]) => ({ id, ...v })),
  };
}

export function summarizeRecentToolsText(recentToolBatch, maxItems = 3) {
  if (!recentToolBatch || recentToolBatch.length === 0) return '';
  // Group identical tool names in the same batch for ultra-compact HUD
  const grouped = new Map();
  for (const item of recentToolBatch) {
    const prev = grouped.get(item.name) || { name: item.name, delta: 0, count: 0, estimated: false };
    prev.delta += item.deltaTokens;
    prev.count += 1;
    prev.estimated = prev.estimated || item.estimated;
    grouped.set(item.name, prev);
  }
  const sorted = Array.from(grouped.values()).sort((a, b) => b.delta - a.delta);
  const shown = sorted.slice(0, maxItems).map((g) => {
    const prefix = g.estimated ? '~+' : '+';
    const mult = g.count > 1 ? `×${g.count}` : '';
    return `${g.name}${mult} ${prefix}${formatTokens(g.delta)}`;
  });
  if (sorted.length > maxItems) {
    shown.push(`외 ${sorted.length - maxItems}`);
  }
  return shown.join(' · ');
}

export function formatAppInlineHud(analysis, _rollup = null, opts = {}) {
  if (!analysis || !analysis.ok || analysis.invocations === 0) return '';

  const ctxStr = `${formatTokensKo(analysis.currentContext)}/${formatTokensKo(analysis.contextWindowSize)} (${analysis.usedPct.toFixed(1)}%)`;
  const hitPct = Math.round(analysis.latest.cacheHitPct);
  const cacheLabel = analysis.invocations > 1 && hitPct < 20 ? `캐시 깨짐 ${hitPct}%` : `캐시 ${hitPct}%`;

  const tps = analysis.lastTurn?.tokPerSec ?? analysis.latest?.tokPerSec ?? analysis.cumulative?.avgTokPerSec;
  const speedPart = tps != null ? ` │ ${Math.round(tps)} tok/s` : '';

  const turnCalls = analysis.lastTurn?.calls || 1;
  const turnEff = formatTokensKo(analysis.lastTurn?.effectiveTokens ?? analysis.latest.inputTokens + analysis.latest.outputTokens);
  const turnPart = ` │ 직전 **${turnEff}** (${turnCalls}회)`;

  const toolSource = opts.useTurnTools ? analysis.currentTurnTools : analysis.recentToolBatch;
  const toolsStr = summarizeRecentToolsText(toolSource, 2);
  const toolsPart = toolsStr ? ` │ 🔧 \`${toolsStr}\`` : '';

  // Strictly per-session cumulative (+ CLI official quota only if actually present & fresh)
  let tailPart = ` │ 이 채팅 누적 **${formatTokensKo(analysis.cumulative.uncachedPlusOutput)}**`;
  const q = extractPrimaryQuota(analysis.liveQuota?.quota);
  const qAgeMs = analysis.liveQuota?.updatedAt ? Date.now() - Date.parse(analysis.liveQuota.updatedAt) : Infinity;
  if (q && q.remainingFraction != null && qAgeMs < 6 * 60 * 60 * 1000) {
    const pct = Math.round(q.remainingFraction * 100);
    const reset = formatDuration(q.resetInSeconds);
    tailPart += ` │ 한도 **${pct}%**${reset ? ` (${reset})` : ''}`;
  }

  return `⚡ 컨텍스트 **${ctxStr}** │ ${cacheLabel}${turnPart}${speedPart}${toolsPart}${tailPart}`;
}
