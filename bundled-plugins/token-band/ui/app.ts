import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
} from '@modelcontextprotocol/ext-apps';

type ToolStat = {
  name: string;
  count: number;
  totalDelta: number;
  avgDelta: number;
  maxDelta: number;
  sharePct: number;
  hasEstimated?: boolean;
};

type ToolEvent = {
  plannerStepIndex: number;
  callIndex: number;
  name: string;
  target: string;
  deltaTokens: number;
  chars: number;
  estimated: boolean;
  apportioned: boolean;
  createdAt: string | null;
};

type TimelineItem = {
  invocation: number;
  stepIndex: number;
  createdAt: string | null;
  model: string;
  inputTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  durationSec?: number | null;
  tokPerSec?: number | null;
  contextAtCall: number;
  contextDelta: number;
  cacheHitPct: number;
  toolCalls: string[];
  toolDeltas: ToolEvent[];
};

type QuotaBucket = {
  id: string;
  remaining_fraction?: number;
  remaining_amount?: number;
  reset_time?: string;
  reset_in_seconds?: number;
  disabled?: boolean;
};

type LiveQuota = {
  source?: string;
  updatedAt?: string;
  modelId?: string;
  contextWindowSize?: number;
  planTier?: string | null;
  email?: string | null;
  quota?: Record<string, QuotaBucket> | null;
  cost?: { total_usd?: number; subagent_usd?: number; estimated?: boolean } | null;
};

type Settings = {
  hudEnabled: boolean;
  hudMode: string;
  showOnEveryInvocation: boolean;
  dailyTokenBudget: number;
  sessionTokenBudget: number;
  contextWindowOverride: number;
};

type ConversationSummary = {
  conversationId: string;
  source: string;
  transcriptPath: string;
  updatedAt: string;
  title: string;
};

type Rollup = {
  todayTotal: number;
  todayUncached: number;
  todayCacheRead: number;
  todayOutput: number;
  todayConversations: number;
  weekTotal: number;
  computedAt: string;
};

type Analysis = {
  ok: boolean;
  error?: string;
  conversationId?: string;
  title?: string;
  model?: string;
  invocations?: number;
  currentContext?: number;
  exactLastContext?: number;
  pendingDeltaTotal?: number;
  contextWindowSize?: number;
  usedPct?: number;
  latest?: {
    inputTokens: number;
    cacheReadTokens: number;
    outputTokens: number;
    cacheHitPct: number;
    durationSec?: number | null;
    tokPerSec?: number | null;
  };
  cumulative?: {
    inputTokens: number;
    cacheReadTokens: number;
    outputTokens: number;
    totalTokens: number;
    uncachedPlusOutput: number;
    overallCacheHitPct: number;
    totalToolDelta: number;
    avgTokPerSec?: number | null;
    peakTokPerSec?: number | null;
    timedDurationSec?: number;
  };
  byTool?: ToolStat[];
  recentToolBatch?: ToolEvent[];
  toolEvents?: ToolEvent[];
  timeline?: TimelineItem[];
  liveQuota?: LiveQuota | null;
  settings?: Settings;
};

type DashboardPayload = {
  analysis: Analysis;
  rollup: Rollup;
  conversations: ConversationSummary[];
  settings: Settings;
};

let state: DashboardPayload | null = null;
let selectedConversationId = '';
let activeTab: 'tools' | 'events' | 'timeline' | 'settings' = 'tools';
let autoRefresh = true;
let refreshTimer: number | null = null;
let isFetching = false;
let lastError = '';

const app = new App({ name: 'Token Band', version: '1.0.0' }, {});

function fmtTok(n: number | undefined | null): string {
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

function fmtDur(seconds?: number | null): string {
  if (!seconds || seconds <= 0) return '';
  const s = Math.floor(seconds);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${Math.max(1, m)}m`;
}

function fmtAgo(iso?: string): string {
  if (!iso) return '';
  const diffSec = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000));
  if (diffSec < 60) return `${diffSec}초 전`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}분 전`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}시간 전`;
  return `${Math.floor(diffSec / 86400)}일 전`;
}

function esc(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function getQuotaBuckets(liveQuota?: LiveQuota | null): Array<{ id: string } & QuotaBucket> {
  if (!liveQuota?.quota) return [];
  return Object.entries(liveQuota.quota)
    .filter(([, v]) => v && !v.disabled)
    .map(([id, v]) => ({ id, ...v }))
    .sort((a, b) => (a.remaining_fraction ?? 1) - (b.remaining_fraction ?? 1));
}

function renderSparkline(timeline: TimelineItem[]): string {
  if (!timeline || timeline.length < 2) {
    return '<div class="empty-hint">스텝이 2개 이상 쌓이면 컨텍스트 추이 그래프가 표시됩니다.</div>';
  }
  const w = 520;
  const h = 92;
  const pad = 10;
  const maxVal = Math.max(1, ...timeline.map((t) => t.contextAtCall));
  const stepX = (w - pad * 2) / Math.max(1, timeline.length - 1);

  const ctxPts = timeline
    .map((t, i) => `${(pad + i * stepX).toFixed(1)},${(h - pad - (t.contextAtCall / maxVal) * (h - pad * 2)).toFixed(1)}`)
    .join(' ');

  const cachePts = timeline
    .map((t, i) => `${(pad + i * stepX).toFixed(1)},${(h - pad - (t.cacheReadTokens / maxVal) * (h - pad * 2)).toFixed(1)}`)
    .join(' ');

  const areaPts = `${pad},${h - pad} ${ctxPts} ${(pad + (timeline.length - 1) * stepX).toFixed(1)},${h - pad}`;

  return `
    <svg class="sparkline" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
      <polygon points="${areaPts}" fill="var(--tb-accent-soft)" />
      <polyline points="${cachePts}" fill="none" stroke="var(--tb-cache-read)" stroke-width="1.8" stroke-dasharray="3 2" />
      <polyline points="${ctxPts}" fill="none" stroke="var(--tb-accent)" stroke-width="2.2" />
    </svg>
    <div class="spark-legend">
      <span><i class="dot dot-ctx"></i>누적 컨텍스트 (최대 ${fmtTok(maxVal)})</span>
      <span><i class="dot dot-cr"></i>캐시 읽기 (Cache Read)</span>
    </div>
  `;
}

function render() {
  const root = document.getElementById('app');
  if (!root) return;

  if (!state) {
    root.innerHTML = `<div class="loading">Token Band 데이터를 불러오는 중...</div>`;
    return;
  }

  const { analysis, rollup, conversations, settings } = state;
  const hasData = analysis && analysis.ok;
  const ctx = analysis.currentContext ?? 0;
  const win = analysis.contextWindowSize ?? 1_048_576;
  const usedPct = analysis.usedPct ?? 0;
  const cr = analysis.latest?.cacheReadTokens ?? 0;
  const cw = analysis.latest?.inputTokens ?? 0;
  const pending = analysis.pendingDeltaTotal ?? 0;
  const hitPct = analysis.latest?.cacheHitPct ?? 0;
  const overallHitPct = analysis.cumulative?.overallCacheHitPct ?? 0;
  const totalToolDelta = analysis.cumulative?.totalToolDelta ?? 0;
  const byTool = analysis.byTool ?? [];
  const toolEvents = [...(analysis.toolEvents ?? [])].reverse();
  const timeline = analysis.timeline ?? [];

  const crBarPct = win > 0 ? Math.min(100, (cr / win) * 100) : 0;
  const cwBarPct = win > 0 ? Math.min(100 - crBarPct, (cw / win) * 100) : 0;
  const pendBarPct = win > 0 ? Math.min(100 - crBarPct - cwBarPct, (pending / win) * 100) : 0;

  const quotaBuckets = getQuotaBuckets(analysis.liveQuota);
  const primaryQuota = quotaBuckets[0] || null;
  const dailyBudget = settings.dailyTokenBudget || 2_000_000;
  const dailyPct = Math.min(100, Math.round(((rollup?.todayUncached || 0) / Math.max(1, dailyBudget)) * 100));

  const convOptions = [
    `<option value="" ${!selectedConversationId ? 'selected' : ''}>🔄 자동 (최신 활성 세션)</option>`,
    ...(conversations || []).map((c) => {
      const sel = c.conversationId === selectedConversationId ? 'selected' : '';
      const tag = c.source === 'cli' ? '[CLI]' : c.source === 'ide' ? '[IDE]' : '[App]';
      return `<option value="${esc(c.conversationId)}" ${sel}>${tag} ${esc(c.title)} (${fmtAgo(c.updatedAt)})</option>`;
    }),
  ].join('');

  let tabBody = '';
  if (activeTab === 'tools') {
    if (byTool.length === 0) {
      tabBody = `<div class="empty-hint">아직 이 대화에서 측정된 도구 호출이 없습니다.</div>`;
    } else {
      const maxTool = Math.max(1, ...byTool.map((t) => t.totalDelta));
      tabBody = `
        <div class="tool-list">
          ${byTool
            .map((t) => {
              const barW = Math.max(2, Math.round((t.totalDelta / maxTool) * 100));
              return `
                <div class="tool-row">
                  <div class="tool-head">
                    <span class="tool-name"><code>${esc(t.name)}</code> <span class="muted">×${t.count}</span></span>
                    <span class="tool-val"><strong>+${fmtTok(t.totalDelta)}</strong> <span class="muted">(${t.sharePct}% · avg +${fmtTok(t.avgDelta)})</span></span>
                  </div>
                  <div class="mini-bar"><div class="mini-fill" style="width:${barW}%"></div></div>
                </div>
              `;
            })
            .join('')}
        </div>
      `;
    }
  } else if (activeTab === 'events') {
    if (toolEvents.length === 0) {
      tabBody = `<div class="empty-hint">도구 호출 기록이 없습니다.</div>`;
    } else {
      tabBody = `
        <div class="table-wrap">
          <table>
            <thead>
              <tr><th>Step</th><th>도구</th><th>대상</th><th class="num">+토큰</th></tr>
            </thead>
            <tbody>
              ${toolEvents
                .slice(0, 40)
                .map(
                  (e) => `
                <tr>
                  <td class="muted">#${e.plannerStepIndex}</td>
                  <td><code>${esc(e.name)}</code></td>
                  <td class="target-cell" title="${esc(e.target)}">${esc(e.target || '-')}</td>
                  <td class="num ${e.estimated ? 'est' : 'exact'}">${e.estimated ? '~+' : '+'}${fmtTok(e.deltaTokens)}</td>
                </tr>
              `
                )
                .join('')}
            </tbody>
          </table>
        </div>
      `;
    }
  } else if (activeTab === 'timeline') {
    tabBody = `
      ${renderSparkline(timeline)}
      <div class="table-wrap">
        <table>
          <thead>
            <tr><th>#</th><th class="num">컨텍스트</th><th class="num">증분</th><th class="num">Cache R</th><th class="num">Cache W</th><th class="num">Hit</th><th class="num">Out</th><th class="num">tok/s</th></tr>
          </thead>
          <tbody>
            ${[...timeline]
              .reverse()
              .slice(0, 30)
              .map(
                (t) => `
              <tr>
                <td class="muted">${t.invocation}</td>
                <td class="num"><strong>${fmtTok(t.contextAtCall)}</strong></td>
                <td class="num delta">+${fmtTok(t.contextDelta)}</td>
                <td class="num cr">${fmtTok(t.cacheReadTokens)}</td>
                <td class="num cw">${fmtTok(t.inputTokens)}</td>
                <td class="num">${t.cacheHitPct}%</td>
                <td class="num muted">${fmtTok(t.outputTokens)}</td>
                <td class="num exact">${t.tokPerSec != null ? t.tokPerSec.toFixed(1) : '-'}</td>
              </tr>
            `
              )
              .join('')}
          </tbody>
        </table>
      </div>
    `;
  } else {
    tabBody = `
      <div class="settings-box">
        <label class="toggle-row">
          <span>
            <strong>채팅 인라인 1줄 HUD 활성화</strong>
            <small>매 턴 채팅창에 1줄 토큰밴드를 표시합니다 (모델 컨텍스트 0 토큰 소모)</small>
          </span>
          <input type="checkbox" id="set-hud-enabled" ${settings.hudEnabled ? 'checked' : ''} />
        </label>
        <label class="toggle-row">
          <span>
            <strong>도구 호출마다 중간 HUD 표시</strong>
            <small>끄면 최종 답변 시에만 1줄 HUD를 표시합니다</small>
          </span>
          <input type="checkbox" id="set-every-inv" ${settings.showOnEveryInvocation ? 'checked' : ''} />
        </label>
        <div class="field-row">
          <label for="set-daily-budget">
            <strong>일간 신규 토큰 예산 (App 로컬 게이지)</strong>
            <small>공식 계정 쿼타는 <code>agy</code> CLI 실행 시 자동 동기화됩니다</small>
          </label>
          <input type="number" id="set-daily-budget" step="100000" min="100000" value="${dailyBudget}" />
        </div>
        <button id="btn-save-settings" class="primary-btn">설정 저장</button>
        <div id="save-status" class="muted"></div>
      </div>
    `;
  }

  const latestTps = analysis.latest?.tokPerSec ?? null;
  const avgTps = analysis.cumulative?.avgTokPerSec ?? null;
  const peakTps = analysis.cumulative?.peakTokPerSec ?? null;
  const shortSessionId = analysis.conversationId ? analysis.conversationId.slice(0, 8) : '-';

  const quotaCardBody = primaryQuota
    ? `
      <div class="kpi-val">${Math.round((primaryQuota.remaining_fraction ?? 0) * 100)}% <span class="kpi-sub">${fmtDur(primaryQuota.reset_in_seconds) ? `리셋 ${fmtDur(primaryQuota.reset_in_seconds)}` : ''}</span></div>
      <div class="kpi-meta">${esc(primaryQuota.id)} · CLI 동기화 ${fmtAgo(analysis.liveQuota?.updatedAt)}</div>
      ${
        quotaBuckets.length > 1
          ? `<div class="quota-mini">${quotaBuckets
              .slice(0, 3)
              .map((b) => `<span>${esc(b.id)}: <b>${Math.round((b.remaining_fraction ?? 0) * 100)}%</b></span>`)
              .join('')}</div>`
          : ''
      }
    `
    : `
      <div class="kpi-val">${fmtTok(rollup?.todayUncached || 0)} <span class="kpi-sub">/ ${fmtTok(dailyBudget)} (${dailyPct}%)</span></div>
      <div class="kpi-meta">오늘 전체 ${rollup?.todayConversations || 0}개 세션 합산 · 7일 ${fmtTok(rollup?.weekTotal || 0)}</div>
      <div class="kpi-note">공식 쿼타 %는 <code>agy</code> CLI 사용 시 자동 동기화</div>
    `;

  root.innerHTML = `
    <div class="wrap">
      <header class="topbar">
        <div class="title-row">
          <span class="brand">⚡ Token Band</span>
          <span class="pill">${esc(analysis.model || '대기 중')}</span>
          <span class="pill muted">${analysis.invocations ?? 0} calls</span>
          ${latestTps != null || avgTps != null ? `<span class="pill">🚀 ${(latestTps ?? avgTps)!.toFixed(1)} tok/s</span>` : ''}
          <span class="pill muted" title="${esc(analysis.conversationId || '')}">#${esc(shortSessionId)}</span>
        </div>
        <div class="controls">
          <select id="conv-select" title="대화 선택">${convOptions}</select>
          <button id="btn-auto" class="icon-btn ${autoRefresh ? 'active' : ''}" title="2.5초 자동 새로고침">${autoRefresh ? '● Live' : '○ Pause'}</button>
          <button id="btn-refresh" class="icon-btn" title="지금 새로고침">↻</button>
        </div>
      </header>

      ${lastError ? `<div class="err-banner">${esc(lastError)}</div>` : ''}
      ${!hasData ? `<div class="empty-hint">${esc(analysis.error || '표시할 대화 기록이 없습니다.')}</div>` : ''}

      <section class="hero-band">
        <div class="hero-top">
          <span><strong>세션 누적 컨텍스트</strong> <span class="mono">${fmtTok(ctx)} / ${fmtTok(win)}</span></span>
          <span class="pct-badge ${usedPct >= 75 ? 'danger' : usedPct >= 45 ? 'warn' : ''}">${usedPct.toFixed(2)}%</span>
        </div>
        <div class="seg-bar" title="Cache Read / Cache Write(Fresh) / Pending">
          <div class="seg seg-cr" style="width:${crBarPct.toFixed(2)}%"></div>
          <div class="seg seg-cw" style="width:${cwBarPct.toFixed(2)}%"></div>
          <div class="seg seg-pend" style="width:${pendBarPct.toFixed(2)}%"></div>
        </div>
        <div class="seg-legend">
          <span><i class="dot dot-cr"></i>Cache Read ${fmtTok(cr)}</span>
          <span><i class="dot dot-cw"></i>Cache Write/신규 ${fmtTok(cw)}</span>
          ${pending > 0 ? `<span><i class="dot dot-pend"></i>진행중 ~+${fmtTok(pending)}</span>` : ''}
          <span class="right">Hit <strong>${hitPct.toFixed(1)}%</strong></span>
        </div>
      </section>

      <section class="kpi-grid">
        <div class="kpi-card">
          <div class="kpi-label">캐시 읽기 / 쓰기 (이 세션)</div>
          <div class="kpi-val"><span class="cr">R ${fmtTok(cr)}</span> <span class="muted">/</span> <span class="cw">W ${fmtTok(cw)}</span></div>
          <div class="kpi-meta">세션 전체 캐시율 <strong>${overallHitPct}%</strong> · 누적 R ${fmtTok(analysis.cumulative?.cacheReadTokens)}</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">생성 속도 (tok/s)</div>
          <div class="kpi-val">${latestTps != null ? `${latestTps.toFixed(1)}` : avgTps != null ? `${avgTps.toFixed(1)}` : '-'} <span class="kpi-sub">tok/s</span></div>
          <div class="kpi-meta">평균 <strong>${avgTps != null ? `${avgTps.toFixed(1)}` : '-'}</strong> · 최고 <strong>${peakTps != null ? `${peakTps.toFixed(1)}` : '-'}</strong> · 출력 ${fmtTok(analysis.cumulative?.outputTokens)}</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">도구 누적 +토큰 (이 세션)</div>
          <div class="kpi-val">+${fmtTok(totalToolDelta)} <span class="kpi-sub">(${toolEvents.length}회)</span></div>
          <div class="kpi-meta">${byTool[0] ? `최다: <code>${esc(byTool[0].name)}</code> +${fmtTok(byTool[0].totalDelta)}` : '도구 호출 없음'}</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">${primaryQuota ? '계정 쿼타 (CLI 동기화)' : '전체 세션 일간 사용량'}</div>
          ${quotaCardBody}
        </div>
      </section>

      <nav class="tabs">
        <button class="tab ${activeTab === 'tools' ? 'active' : ''}" data-tab="tools">도구별 +토큰</button>
        <button class="tab ${activeTab === 'events' ? 'active' : ''}" data-tab="events">호출 로그</button>
        <button class="tab ${activeTab === 'timeline' ? 'active' : ''}" data-tab="timeline">스텝 추이</button>
        <button class="tab ${activeTab === 'settings' ? 'active' : ''}" data-tab="settings">HUD 설정</button>
      </nav>

      <section class="tab-panel">${tabBody}</section>
    </div>
  `;

  bindEvents();
}

function bindEvents() {
  const sel = document.getElementById('conv-select') as HTMLSelectElement | null;
  if (sel) {
    sel.onchange = () => {
      selectedConversationId = sel.value;
      void fetchState();
    };
  }
  const btnRefresh = document.getElementById('btn-refresh');
  if (btnRefresh) btnRefresh.onclick = () => void fetchState();

  const btnAuto = document.getElementById('btn-auto');
  if (btnAuto) {
    btnAuto.onclick = () => {
      autoRefresh = !autoRefresh;
      setupPolling();
      render();
    };
  }

  document.querySelectorAll<HTMLButtonElement>('.tab').forEach((btn) => {
    btn.onclick = () => {
      const t = btn.dataset.tab as typeof activeTab;
      if (t) {
        activeTab = t;
        render();
      }
    };
  });

  const btnSave = document.getElementById('btn-save-settings');
  if (btnSave) {
    btnSave.onclick = async () => {
      const hudEnabled = (document.getElementById('set-hud-enabled') as HTMLInputElement)?.checked ?? true;
      const showOnEveryInvocation = (document.getElementById('set-every-inv') as HTMLInputElement)?.checked ?? true;
      const dailyTokenBudget = Number((document.getElementById('set-daily-budget') as HTMLInputElement)?.value || 2000000);
      const statusEl = document.getElementById('save-status');
      if (statusEl) statusEl.textContent = '저장 중...';
      try {
        const res = await app.callServerTool({
          name: 'tb_save_settings',
          arguments: { hudEnabled, showOnEveryInvocation, dailyTokenBudget },
        });
        const sc = (res as { structuredContent?: { settings?: Settings } }).structuredContent;
        if (sc?.settings && state) {
          state.settings = sc.settings;
        }
        if (statusEl) statusEl.textContent = '저장 완료! 다음 턴부터 바로 적용됩니다.';
      } catch (err) {
        if (statusEl) statusEl.textContent = `저장 실패: ${err instanceof Error ? err.message : String(err)}`;
      }
    };
  }
}

async function fetchState() {
  if (isFetching) return;
  isFetching = true;
  try {
    const res = await app.callServerTool({
      name: 'tb_get_state',
      arguments: selectedConversationId ? { conversationId: selectedConversationId } : {},
    });
    const sc = (res as { structuredContent?: DashboardPayload }).structuredContent;
    if (sc) {
      state = sc;
      lastError = '';
      render();
    }
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    render();
  } finally {
    isFetching = false;
  }
}

function setupPolling() {
  if (refreshTimer !== null) {
    window.clearInterval(refreshTimer);
    refreshTimer = null;
  }
  if (autoRefresh) {
    refreshTimer = window.setInterval(() => {
      void fetchState();
    }, 2500);
  }
}

// Register handlers BEFORE connect()
app.ontoolinput = ({ arguments: args }) => {
  const explicitId = (args as { conversationId?: string } | undefined)?.conversationId;
  if (explicitId) {
    selectedConversationId = explicitId;
  }
  if (!state) render();
};

app.ontoolresult = (result) => {
  const sc = (result as { structuredContent?: DashboardPayload }).structuredContent;
  if (sc) {
    state = sc;
    render();
  }
};

app.onhostcontextchanged = (ctx) => {
  if (ctx.theme) applyDocumentTheme(ctx.theme);
  if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
};

async function init() {
  await app.connect();
  const ctx = app.getHostContext();
  if (ctx?.theme) applyDocumentTheme(ctx.theme);
  if (ctx?.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
  if (!state) {
    await fetchState();
  }
  setupPolling();
}

void init();
