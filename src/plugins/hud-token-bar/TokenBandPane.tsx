import React, { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  ArrowUpRight,
  Gauge,
  MessageSquarePlus,
  RefreshCw,
  Settings2,
  Wrench,
} from 'lucide-react';
import {
  BUILTIN_PLUGIN_IDS,
  useLayoutStore,
  usePluginConfigStore,
  type DeskClientContext,
  type PaneComponentProps,
} from '../../kernel/client';
import type { QuotaBucket } from '../../shared/types';
import { computePaceTickPct, fmtAgo, fmtKo, fmtReset } from '../../utils/formatKo';
import type { AgyPluginConfig } from '../agent-agy/types';
import { useChatSessionStore, type ChatTabState } from '../pane-chat/chatStore';
import type { HudTokenBarConfig } from './manifest';
import {
  bucketUsedPct,
  bucketWindowLabel,
  buildGlobalProviderSummaries,
  getProviderMeta,
  inferBucketWindow,
  inferDefaultContextWindow,
} from './quotaModel';

interface OpenChatSessionRow {
  groupId: string;
  tabId: string;
  sessionId: string;
  adapterId: string;
  title: string;
  model: string;
  cwd: string;
  running: boolean;
  ctxTokens: number;
  ctxWin: number;
  usedPct: number;
  hitPct: number;
  cacheBroken: boolean;
  cumTokens: number;
  tokPerSec: number | null;
  invocations: number;
}

export const TokenBandPane: React.FC<PaneComponentProps & { ctx: DeskClientContext<HudTokenBarConfig> }> = ({
  ctx,
}) => {
  const cfg = ctx.config.useConfig();
  const warnPct = typeof cfg.newRoomWarnPct === 'number' ? cfg.newRoomWarnPct : 35;

  const availableAdapters = useChatSessionStore((s) => s.availableAdapters);
  const accountQuotaByAdapter = useChatSessionStore((s) => s.accountQuotaByAdapter);
  const legacyAgyQuota = useChatSessionStore((s) => s.accountQuota);
  const loadingQuotaByAdapter = useChatSessionStore((s) => s.loadingQuotaByAdapter);
  const loadingAny = useChatSessionStore((s) => s.loadingQuota);
  const refreshAccountQuota = useChatSessionStore((s) => s.refreshAccountQuota);
  const refreshAllAccountQuotas = useChatSessionStore((s) => s.refreshAllAccountQuotas);
  const metricsBySession = useChatSessionStore((s) => s.metricsBySession);
  const runningSessions = useChatSessionStore((s) => s.runningSessions);

  const groups = useLayoutStore((s) => s.groups);
  const setActiveTab = useLayoutStore((s) => s.setActiveTab);
  const configsByPlugin = usePluginConfigStore((s) => s.configsByPlugin);

  const [displayMode, setDisplayMode] = useState<'used' | 'remaining'>('used');
  const [, setNowTick] = useState(0);

  // Periodic relative timestamp tick + soft initial refresh when opening the board
  useEffect(() => {
    void refreshAllAccountQuotas(false);
    const id = window.setInterval(() => setNowTick((n) => n + 1), 30_000);
    return () => window.clearInterval(id);
  }, [refreshAllAccountQuotas]);

  const providers = useMemo(
    () => buildGlobalProviderSummaries(availableAdapters, accountQuotaByAdapter, legacyAgyQuota),
    [availableAdapters, accountQuotaByAdapter, legacyAgyQuota]
  );

  // Collect all open chat tabs across all split pane groups
  const openSessions = useMemo<OpenChatSessionRow[]>(() => {
    const rows: OpenChatSessionRow[] = [];
    for (const [groupId, group] of Object.entries(groups)) {
      for (const tab of group.tabs) {
        if (tab.paneType !== 'chat') continue;
        const st = (tab.state || {}) as Partial<ChatTabState>;
        const sessionId = String(st.sessionId || tab.id);
        const adapterId = String(st.adapterId || BUILTIN_PLUGIN_IDS.AGENT_AGY);
        const metrics = metricsBySession[sessionId];
        const defaultModel = (configsByPlugin[adapterId] as Partial<AgyPluginConfig> | undefined)?.defaultModel || '';
        const model =
          st.model && st.model !== 'default' ? String(st.model) : metrics?.model || defaultModel || '기본 모델';
        const ctxTokens = metrics?.currentContext ?? 0;
        const ctxWin = metrics?.contextWindow || inferDefaultContextWindow(adapterId, model);
        const usedPct =
          metrics?.usedPct != null
            ? metrics.usedPct
            : ctxWin > 0
              ? Number(((ctxTokens / ctxWin) * 100).toFixed(1))
              : 0;
        const invocations = metrics?.invocations ?? 0;
        const hitPct = Math.round(metrics?.lastCacheHitPct ?? 0);
        const cacheBroken = invocations > 1 && ctxTokens > 5000 && hitPct < 20;

        rows.push({
          groupId,
          tabId: tab.id,
          sessionId,
          adapterId,
          title: tab.title || '새 채팅',
          model,
          cwd: String(st.cwd || ''),
          running: Boolean(runningSessions[sessionId]),
          ctxTokens,
          ctxWin,
          usedPct,
          hitPct,
          cacheBroken,
          cumTokens: metrics?.sessionCumulative ?? 0,
          tokPerSec: metrics?.tokPerSec ?? null,
          invocations,
        });
      }
    }
    return rows.sort((a, b) => Number(b.running) - Number(a.running) || b.ctxTokens - a.ctxTokens);
  }, [groups, metricsBySession, runningSessions, configsByPlugin]);

  // Aggregate workspace KPIs & tool deltas across all open sessions
  const workspaceTotals = useMemo(() => {
    let totalCum = 0;
    let runningCount = 0;
    let hitSum = 0;
    let hitCount = 0;
    let maxPct = 0;
    const toolMap = new Map<string, { count: number; deltaTokens: number }>();

    for (const s of openSessions) {
      totalCum += s.cumTokens;
      if (s.running) runningCount += 1;
      if (s.usedPct > maxPct) maxPct = s.usedPct;
      const m = metricsBySession[s.sessionId];
      if (m && m.invocations > 0) {
        hitSum += m.overallCacheHitPct;
        hitCount += 1;
      }
      if (m?.toolDeltas) {
        for (const t of m.toolDeltas) {
          const cur = toolMap.get(t.name) || { count: 0, deltaTokens: 0 };
          cur.count += t.count;
          cur.deltaTokens += t.deltaTokens;
          toolMap.set(t.name, cur);
        }
      }
    }

    const totalToolTokens = Array.from(toolMap.values()).reduce((sum, x) => sum + x.deltaTokens, 0);
    const toolRank = Array.from(toolMap.entries())
      .map(([name, v]) => ({
        name,
        count: v.count,
        deltaTokens: v.deltaTokens,
        sharePct: totalToolTokens > 0 ? Math.round((v.deltaTokens / totalToolTokens) * 100) : 0,
      }))
      .sort((a, b) => b.deltaTokens - a.deltaTokens || b.count - a.count)
      .slice(0, 10);

    return {
      totalCum,
      runningCount,
      avgHitPct: hitCount > 0 ? Math.round(hitSum / hitCount) : 0,
      maxPct: Number(maxPct.toFixed(1)),
      toolRank,
    };
  }, [openSessions, metricsBySession]);

  const renderBucketRow = (b: QuotaBucket, accent: string) => {
    const unused = b.remainingFraction != null && b.remainingFraction >= 0.9999;
    const used = bucketUsedPct(b);
    const rem = 100 - used;
    const displayPct = displayMode === 'used' ? used : rem;
    const w = inferBucketWindow(b);
    const tickPct = unused ? null : computePaceTickPct(w, b.resetTime, b.resetInSeconds);
    const reset = unused ? '대기' : fmtReset(b.resetInSeconds, b.resetTime);
    const nearLimit = used >= 85;
    const overPace = tickPct != null && used > tickPct + 10;
    const barColor = nearLimit ? 'var(--danger)' : overPace ? 'var(--warn)' : accent;
    const lbl = bucketWindowLabel(b);

    return (
      <div
        key={b.id}
        className="grid grid-cols-[54px_1fr_40px_48px] items-center gap-2 text-[12px]"
        title={
          unused
            ? `${lbl}: 미사용 (100% 남음)`
            : `${lbl}: ${used}% 사용 (${rem}% 남음)${reset ? ` · ${reset} 초기화` : ''}`
        }
      >
        <span className="truncate font-medium" style={{ color: 'var(--fg-soft)' }}>
          {lbl}
        </span>
        <div className="track h-[7px]">
          <div
            className="track-fill"
            style={{
              width: displayPct === 0 ? '0%' : `${displayPct}%`,
              minWidth: displayPct > 0 ? '4px' : '0px',
              background: barColor,
            }}
          />
          {displayMode === 'used' && tickPct != null && (
            <div className="track-tick" style={{ left: `${tickPct}%` }} />
          )}
        </div>
        <span
          className="num text-right font-semibold"
          style={{ color: nearLimit ? 'var(--danger)' : overPace ? 'var(--warn)' : 'var(--fg)' }}
        >
          {displayPct}%
        </span>
        <span className="num text-right text-[11px] truncate" style={{ color: 'var(--muted)' }}>
          {reset}
        </span>
      </div>
    );
  };

  return (
    <div className="h-full flex flex-col overflow-hidden @container" style={{ background: 'var(--bg)', color: 'var(--fg)' }}>
      {/* Top Toolbar */}
      <div
        className="shrink-0 px-5 py-3 border-b flex items-center justify-between gap-3 flex-wrap"
        style={{ borderColor: 'var(--border)', background: 'var(--card)' }}
      >
        <div className="flex items-center gap-2.5 min-w-0">
          <div
            className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0"
            style={{ background: 'color-mix(in srgb, var(--accent) 14%, transparent)', color: 'var(--accent)' }}
          >
            <Gauge size={15} />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="text-[14px] font-bold truncate">토큰 밴드</h1>
              <span
                className="px-2 py-0.5 rounded-full text-[11px] font-medium num"
                style={{ background: 'var(--surface)', color: 'var(--muted)' }}
              >
                {providers.length}개 엔진 · 채팅 {openSessions.length}개
              </span>
            </div>
            <p className="text-[11.5px] truncate" style={{ color: 'var(--muted)' }}>
              반중력 · Claude Code · Codex 구독 한도와 열린 세션 컨텍스트를 한 화면에서 비교합니다.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <div
            className="inline-flex items-center p-0.5 rounded-lg border text-[11.5px]"
            style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}
          >
            <button
              type="button"
              onClick={() => setDisplayMode('used')}
              className="px-2.5 py-1 rounded-md cursor-pointer transition-colors"
              style={{
                background: displayMode === 'used' ? 'var(--card)' : 'transparent',
                color: displayMode === 'used' ? 'var(--fg)' : 'var(--muted)',
                fontWeight: displayMode === 'used' ? 600 : 400,
              }}
            >
              사용량 %
            </button>
            <button
              type="button"
              onClick={() => setDisplayMode('remaining')}
              className="px-2.5 py-1 rounded-md cursor-pointer transition-colors"
              style={{
                background: displayMode === 'remaining' ? 'var(--card)' : 'transparent',
                color: displayMode === 'remaining' ? 'var(--fg)' : 'var(--muted)',
                fontWeight: displayMode === 'remaining' ? 600 : 400,
              }}
            >
              남은량 %
            </button>
          </div>

          <button
            type="button"
            onClick={() => void refreshAllAccountQuotas(true)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-[12px] font-medium cursor-pointer transition-colors hover:bg-[var(--surface)]"
            style={{ background: 'var(--card)', borderColor: 'var(--border)', color: 'var(--fg)' }}
          >
            <RefreshCw size={12} className={loadingAny ? 'animate-spin' : ''} />
            <span>전체 갱신</span>
          </button>
        </div>
      </div>

      {/* Scrollable Body */}
      <div className="flex-1 overflow-y-auto scroll-thin p-5 space-y-6">
        {/* Section 1: 3-Provider Global Subscription Quota Grid */}
        <section className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-[12px] font-semibold tracking-wide uppercase" style={{ color: 'var(--muted)' }}>
              구독 한도 통합 보드 (Provider → Pool)
            </h2>
            <span className="text-[11px]" style={{ color: 'var(--muted)' }}>
              {displayMode === 'used' ? '│ 세로선은 시간 대비 균등 페이스 기준' : '초기화까지 남은 여유 비율'}
            </span>
          </div>

          <div className="grid grid-cols-1 @[760px]:grid-cols-3 gap-3.5">
            {providers.map((p) => {
              const isLoading = Boolean(loadingQuotaByAdapter[p.adapterId]);
              const statusBadge = p.allBuckets.length === 0
                ? { label: isLoading ? '조회 중' : '미조회', bg: 'var(--surface)', color: 'var(--muted)' }
                : p.hasDanger
                  ? { label: '한도 임박', bg: 'color-mix(in srgb, var(--danger) 14%, transparent)', color: 'var(--danger)' }
                  : p.hasWarning
                    ? { label: '페이스 주의', bg: 'color-mix(in srgb, var(--warn) 14%, transparent)', color: 'var(--warn)' }
                    : { label: '여유', bg: 'color-mix(in srgb, #10b981 14%, transparent)', color: '#10b981' };

              return (
                <div
                  key={p.adapterId}
                  className="rounded-2xl border p-4 flex flex-col justify-between gap-3.5"
                  style={{ background: 'var(--card)', borderColor: 'var(--border)', boxShadow: 'var(--shadow-sm)' }}
                >
                  <div className="space-y-3">
                    {/* Card Header */}
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: p.meta.accent }} />
                          <span className="text-[13.5px] font-bold truncate">{p.meta.name}</span>
                        </div>
                        <div className="text-[11px] mt-0.5 truncate" style={{ color: 'var(--muted)' }}>
                          {p.meta.sourceLabel}
                          {p.updatedAt ? ` · ${fmtAgo(Date.parse(p.updatedAt)) || '방금'}` : ''}
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        <span
                          className="px-2 py-0.5 rounded-full text-[10.5px] font-semibold"
                          style={{ background: statusBadge.bg, color: statusBadge.color }}
                        >
                          {statusBadge.label}
                        </span>
                        <button
                          type="button"
                          onClick={() => void refreshAccountQuota(true, p.adapterId)}
                          className="p-1 rounded-md cursor-pointer hover:bg-[var(--surface)]"
                          style={{ color: 'var(--muted)' }}
                          title={`${p.meta.name} 한도 새로고침`}
                        >
                          <RefreshCw size={12} className={isLoading ? 'animate-spin' : ''} />
                        </button>
                      </div>
                    </div>

                    {/* Pools */}
                    {p.pools.length > 0 ? (
                      <div className="space-y-3">
                        {p.pools.map((pool) => (
                          <div key={pool.id} className="space-y-1.5">
                            <div className="flex items-center justify-between text-[11px]">
                              <span className="font-semibold" style={{ color: 'var(--fg-soft)' }}>
                                {pool.label}
                              </span>
                            </div>
                            <div className="space-y-1.5">
                              {pool.buckets.map((b) => renderBucketRow(b, pool.accent))}
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div
                        className="rounded-xl border border-dashed px-3 py-4 text-[11.5px] leading-relaxed"
                        style={{ borderColor: 'var(--border)', color: 'var(--muted)' }}
                      >
                        {isLoading
                          ? `${p.meta.sourceLabel}에서 공식 한도를 불러오는 중입니다…`
                          : p.error || '아직 동기화된 구독 한도가 없습니다. 조회를 누르거나 로그인 상태를 확인해 주세요.'}
                      </div>
                    )}
                  </div>

                  {/* Card Footer Actions */}
                  <div
                    className="pt-2.5 border-t flex items-center justify-between gap-2"
                    style={{ borderColor: 'var(--border)' }}
                  >
                    <button
                      type="button"
                      onClick={() => void ctx.commands.execute('settings:open', p.meta.settingsSectionId)}
                      className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11.5px] cursor-pointer hover:bg-[var(--surface)]"
                      style={{ color: 'var(--muted)' }}
                    >
                      <Settings2 size={12} />
                      <span>설정·로그인</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => ctx.workspace.openTab('chat', { adapterId: p.adapterId })}
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11.5px] font-medium cursor-pointer transition-colors hover:opacity-90"
                      style={{
                        background: `color-mix(in srgb, ${p.meta.accent} 14%, transparent)`,
                        color: p.meta.accent,
                      }}
                    >
                      <MessageSquarePlus size={12} />
                      <span>새 채팅</span>
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        {/* Section 2: Active Workspace Chat Sessions */}
        <section className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-[12px] font-semibold tracking-wide uppercase flex items-center gap-1.5" style={{ color: 'var(--muted)' }}>
              <Activity size={13} />
              <span>열린 채팅 세션 실시간 컨텍스트</span>
            </h2>
            <span className="text-[11px]" style={{ color: 'var(--muted)' }}>
              행 클릭 시 해당 채팅 탭으로 즉시 이동
            </span>
          </div>

          {/* 4 KPI Summary Strip */}
          <div className="grid grid-cols-2 @[640px]:grid-cols-4 gap-3">
            <div className="rounded-xl border px-3.5 py-2.5" style={{ background: 'var(--card)', borderColor: 'var(--border)' }}>
              <div className="text-[11px]" style={{ color: 'var(--muted)' }}>열린 채팅</div>
              <div className="num text-[18px] font-bold mt-0.5">
                {openSessions.length}개
                {workspaceTotals.runningCount > 0 && (
                  <span className="ml-1.5 text-[11px] font-semibold" style={{ color: 'var(--accent)' }}>
                    ({workspaceTotals.runningCount} 실행 중)
                  </span>
                )}
              </div>
            </div>
            <div className="rounded-xl border px-3.5 py-2.5" style={{ background: 'var(--card)', borderColor: 'var(--border)' }}>
              <div className="text-[11px]" style={{ color: 'var(--muted)' }}>합산 누적 토큰</div>
              <div className="num text-[18px] font-bold mt-0.5">{fmtKo(workspaceTotals.totalCum)}</div>
            </div>
            <div className="rounded-xl border px-3.5 py-2.5" style={{ background: 'var(--card)', borderColor: 'var(--border)' }}>
              <div className="text-[11px]" style={{ color: 'var(--muted)' }}>평균 캐시 적중률</div>
              <div className="num text-[18px] font-bold mt-0.5">{workspaceTotals.avgHitPct}%</div>
            </div>
            <div className="rounded-xl border px-3.5 py-2.5" style={{ background: 'var(--card)', borderColor: 'var(--border)' }}>
              <div className="text-[11px]" style={{ color: 'var(--muted)' }}>최고 컨텍스트 점유</div>
              <div
                className="num text-[18px] font-bold mt-0.5"
                style={{ color: workspaceTotals.maxPct >= warnPct ? 'var(--warn)' : 'var(--fg)' }}
              >
                {workspaceTotals.maxPct}%
              </div>
            </div>
          </div>

          {openSessions.length > 0 ? (
            <div
              className="rounded-2xl border overflow-hidden"
              style={{ background: 'var(--card)', borderColor: 'var(--border)' }}
            >
              {openSessions.map((row, idx) => {
                const meta = getProviderMeta(row.adapterId);
                const heavy = row.usedPct >= warnPct;
                return (
                  <button
                    key={`${row.groupId}:${row.tabId}`}
                    type="button"
                    onClick={() => setActiveTab(row.groupId, row.tabId)}
                    className={`w-full px-4 py-3 text-left flex items-center justify-between gap-4 cursor-pointer transition-colors hover:bg-[var(--surface)] ${idx > 0 ? 'border-t' : ''}`}
                    style={idx > 0 ? { borderColor: 'var(--border)' } : undefined}
                  >
                    <div className="flex items-center gap-3 min-w-0 flex-1">
                      <span
                        className={`w-2 h-2 rounded-full shrink-0 ${row.running ? 'animate-pulse' : ''}`}
                        style={{ background: meta.accent }}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 min-w-0">
                          <span
                            className="px-1.5 py-0.2 rounded text-[10.5px] font-semibold shrink-0"
                            style={{
                              background: `color-mix(in srgb, ${meta.accent} 14%, transparent)`,
                              color: meta.accent,
                            }}
                          >
                            {meta.shortName}
                          </span>
                          <span className="text-[13px] font-semibold truncate">{row.title}</span>
                          <span className="text-[11px] truncate hidden @[600px]:inline" style={{ color: 'var(--muted)' }}>
                            {row.model}
                          </span>
                        </div>
                        <div className="flex items-center gap-3 mt-1.5">
                          <div className="w-36 @[680px]:w-48 track h-[6px]">
                            <div
                              className="track-fill"
                              style={{
                                width: `${Math.min(100, row.usedPct)}%`,
                                background: row.cacheBroken
                                  ? 'var(--danger)'
                                  : heavy
                                    ? 'var(--warn)'
                                    : meta.accent,
                              }}
                            />
                          </div>
                          <span className="num text-[11.5px] font-medium" style={{ color: heavy ? 'var(--warn)' : 'var(--fg-soft)' }}>
                            {fmtKo(row.ctxTokens)} / {fmtKo(row.ctxWin)} ({row.usedPct}%)
                          </span>
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-4 shrink-0 text-[11.5px] num">
                      <div className="text-right hidden @[520px]:block">
                        <div style={{ color: row.cacheBroken ? 'var(--danger)' : 'var(--fg-soft)', fontWeight: row.cacheBroken ? 600 : 500 }}>
                          {row.invocations === 0 ? '대기' : row.cacheBroken ? `캐시 깨짐 ${row.hitPct}%` : `캐시 ${row.hitPct}%`}
                        </div>
                        <div className="text-[10.5px]" style={{ color: 'var(--muted)' }}>
                          {row.tokPerSec != null ? `${Math.round(row.tokPerSec)} tok/s` : `누적 ${fmtKo(row.cumTokens)}`}
                        </div>
                      </div>
                      <ArrowUpRight size={14} style={{ color: 'var(--muted)' }} />
                    </div>
                  </button>
                );
              })}
            </div>
          ) : (
            <div
              className="rounded-2xl border border-dashed px-4 py-6 text-center text-[12px]"
              style={{ borderColor: 'var(--border)', color: 'var(--muted)' }}
            >
              현재 열려 있는 채팅 세션이 없습니다. 위 카드의 <strong>새 채팅</strong> 버튼으로 바로 시작할 수 있습니다.
            </div>
          )}
        </section>

        {/* Section 3: Aggregated Tool Token Delta Ranking */}
        <section className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-[12px] font-semibold tracking-wide uppercase flex items-center gap-1.5" style={{ color: 'var(--muted)' }}>
              <Wrench size={13} />
              <span>워크스페이스 도구별 +토큰 소비 TOP 10</span>
            </h2>
            <span className="text-[11px]" style={{ color: 'var(--muted)' }}>
              반중력 · Claude · Codex 합산
            </span>
          </div>

          <div
            className="rounded-2xl border p-4"
            style={{ background: 'var(--card)', borderColor: 'var(--border)' }}
          >
            {workspaceTotals.toolRank.length > 0 ? (
              <div className="space-y-2.5">
                {workspaceTotals.toolRank.map((t) => (
                  <div key={t.name} className="grid grid-cols-[136px_46px_1fr_68px] items-center gap-3 text-[12px]">
                    <code className="truncate font-mono text-[11.5px]">{t.name}</code>
                    <span className="num text-[11px]" style={{ color: 'var(--muted)' }}>
                      {t.count}회
                    </span>
                    <div className="track h-[7px]">
                      <div className="track-fill" style={{ width: `${Math.max(4, t.sharePct)}%` }} />
                    </div>
                    <span className="num text-right font-semibold">+{fmtKo(t.deltaTokens)}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="py-2 text-[12px]" style={{ color: 'var(--muted)' }}>
                아직 도구 호출로 누적된 토큰 증분이 없습니다. 반중력·Claude·Codex 채팅에서 도구가 실행되면 실시간으로 집계됩니다.
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
};
