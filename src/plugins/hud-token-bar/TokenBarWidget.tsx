import React, { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, ChevronDown, ChevronUp, RefreshCw } from 'lucide-react';
import {
  BUILTIN_PLUGIN_IDS,
  useLayoutStore,
  usePluginConfigStore,
  type DeskClientContext,
  type PaneTabRecord,
} from '../../kernel/client';
import type { QuotaBucket } from '../../shared/types';
import { computePaceTickPct, fmtAgo, fmtKo, fmtReset } from '../../utils/formatKo';
import type { AgyPluginConfig } from '../agent-agy/types';
import { useChatSessionStore, type ChatTabState } from '../pane-chat/chatStore';
import type { HudTokenBarConfig } from './manifest';
import {
  bucketUsedPct,
  bucketWindowLabel,
  inferBucketWindow,
  inferDefaultContextWindow,
  openGlobalTokenBandPane,
  selectHudQuotaView,
} from './quotaModel';

export interface TokenBarWidgetProps {
  groupId: string;
  tab: PaneTabRecord;
  ctx: DeskClientContext<HudTokenBarConfig>;
}

export const TokenBarWidget: React.FC<TokenBarWidgetProps> = ({ groupId, tab, ctx }) => {
  const state = tab.state as ChatTabState;
  const sessionId = state?.sessionId || '';
  const adapterId = state?.adapterId || BUILTIN_PLUGIN_IDS.AGENT_AGY;
  const cfg = ctx.config.useConfig();
  const warnPct = typeof cfg.newRoomWarnPct === 'number' ? cfg.newRoomWarnPct : 35;

  const metrics = useChatSessionStore((s) => s.metricsBySession[sessionId]);
  const accountQuotaByAdapter = useChatSessionStore((s) => s.accountQuotaByAdapter);
  const legacyAgyQuota = useChatSessionStore((s) => s.accountQuota);
  const loadingThisQuota = useChatSessionStore((s) => Boolean(s.loadingQuotaByAdapter[adapterId]));
  const refreshAccountQuota = useChatSessionStore((s) => s.refreshAccountQuota);
  const groups = useLayoutStore((s) => s.groups);
  const adapterDefaultModel = usePluginConfigStore(
    (s) => (s.configsByPlugin[adapterId] as Partial<AgyPluginConfig> | undefined)?.defaultModel
  );

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerTab, setDrawerTab] = useState<'tools' | 'turns' | 'quota'>('tools');
  const [quotaDisplayMode, setQuotaDisplayMode] = useState<'used' | 'remaining'>('used');
  const [agyPoolOverride, setAgyPoolOverride] = useState<'gemini' | 'claude' | null>(null);
  const [, setNowTick] = useState(0);
  const [boxWidth, setBoxWidth] = useState(720);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const id = window.setInterval(() => setNowTick((n) => n + 1), 30_000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const sync = () => setBoxWidth(el.clientWidth || 720);
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const effectiveModel =
    state?.model && state.model !== 'default' ? state.model : metrics?.model || adapterDefaultModel || '';

  // Reset manual Antigravity pool toggle whenever model or adapter changes
  useEffect(() => {
    setAgyPoolOverride(null);
  }, [adapterId, effectiveModel]);

  // Strict 1:1 provider/model quota mapping (Gemini -> Gemini, Codex -> Codex, Claude -> Claude Code)
  const quotaView = selectHudQuotaView({
    adapterId,
    model: effectiveModel,
    accountQuotaByAdapter,
    legacyAgyQuota,
    metrics,
    agyPoolOverride,
  });
  const activeBuckets = quotaView.buckets;
  const hasQuota = activeBuckets.length > 0;

  const ctxTokens = metrics?.currentContext ?? 0;
  const win = metrics?.contextWindow || inferDefaultContextWindow(adapterId, effectiveModel);
  const usedPct =
    metrics?.usedPct != null
      ? metrics.usedPct
      : win > 0
        ? Number(((ctxTokens / win) * 100).toFixed(1))
        : 0;
  const hitPct = Math.round(metrics?.lastCacheHitPct ?? 0);
  const invocations = metrics?.invocations ?? 0;
  const cacheBroken = invocations > 1 && ctxTokens > 5000 && hitPct < 20;
  const heavySession = usedPct >= warnPct;
  const ago = fmtAgo(metrics?.lastCallAt);

  const turnTokens = metrics?.lastTurnTokens ?? 0;
  const turnCalls = metrics?.lastTurnCalls ?? 0;
  const tps = metrics?.tokPerSec;
  const cum = metrics?.sessionCumulative ?? 0;
  const overallHit = Math.round(metrics?.overallCacheHitPct ?? 0);

  const totalGroups = Object.keys(groups).length;
  const compact = Boolean(cfg.forceCompact) || boxWidth < 580 || (totalGroups > 1 && invocations === 0);

  const compactQuotaText = (() => {
    if (!hasQuota) return '';
    const pctOf = (b: QuotaBucket) => (quotaDisplayMode === 'used' ? bucketUsedPct(b) : 100 - bucketUsedPct(b));
    const h5 = activeBuckets.find((b) => inferBucketWindow(b) === '5h');
    const wk = activeBuckets.find((b) => inferBucketWindow(b) === 'weekly');
    const shortLbl = quotaView.title.replace(/\s*한도$/, '');
    if (h5 && wk) return `${shortLbl} ${pctOf(h5)}%·${pctOf(wk)}%`;
    return `${shortLbl} ${pctOf(activeBuckets[0])}%`;
  })();

  const handleOpenGlobalBand = (e?: React.MouseEvent) => {
    e?.stopPropagation();
    setDrawerOpen(false);
    openGlobalTokenBandPane({ splitIfMissing: false });
  };

  const handleCompactClick = () => {
    setDrawerOpen(false);
    void ctx.commands.execute('pane-chat:send-prompt', { groupId, tabId: tab.id, prompt: '/compact' });
  };

  const handleNewRoomClick = () => {
    setDrawerOpen(false);
    ctx.workspace.openTab('chat', { cwd: state?.cwd, adapterId }, { groupId });
  };

  const renderQuotaRow = (b: QuotaBucket, wideReset = false) => {
    const unused = b.remainingFraction != null && b.remainingFraction >= 0.9999;
    const used = bucketUsedPct(b);
    const rem = 100 - used;
    const displayPct = quotaDisplayMode === 'used' ? used : rem;
    const w = inferBucketWindow(b);
    const tickPct = unused ? null : computePaceTickPct(w, b.resetTime, b.resetInSeconds);
    const reset = unused ? '대기' : fmtReset(b.resetInSeconds, b.resetTime);
    const nearLimit = used >= 85;
    const overPace = tickPct != null && used > tickPct + 10;
    const barColor = nearLimit ? 'var(--danger)' : overPace ? 'var(--warn)' : quotaView.accent;
    const lbl = bucketWindowLabel(b);

    return (
      <div
        key={b.id}
        className={`grid ${wideReset ? 'grid-cols-[44px_1fr_36px_44px]' : 'grid-cols-[36px_1fr_30px_36px]'} items-center gap-1.5 text-[11px]`}
        title={
          unused
            ? `${lbl}: 미사용 (100% 남음)`
            : `${lbl}: ${used}% 사용 (${rem}% 남음)${reset ? ` · ${reset} 초기화` : ''}`
        }
      >
        <span className="truncate" style={{ color: 'var(--muted)' }}>
          {lbl}
        </span>
        <div className="track">
          <div
            className="track-fill"
            style={{
              width: displayPct === 0 ? '0%' : `${displayPct}%`,
              minWidth: displayPct > 0 ? '3px' : '0px',
              background: barColor,
            }}
          />
          {quotaDisplayMode === 'used' && tickPct != null && (
            <div className="track-tick" style={{ left: `${tickPct}%` }} />
          )}
        </div>
        <span
          className="num text-right font-semibold"
          style={{ color: nearLimit ? 'var(--danger)' : overPace ? 'var(--warn)' : 'var(--fg)' }}
        >
          {displayPct}%
        </span>
        <span className="num text-right truncate" style={{ color: 'var(--muted)' }}>
          {reset}
        </span>
      </div>
    );
  };

  const renderDrawer = () => (
    <div
      className="rounded-2xl border px-4 py-3 text-xs space-y-2.5"
      style={{
        background: 'var(--card)',
        borderColor: 'var(--border)',
        boxShadow: 'var(--shadow-popover)',
      }}
    >
      {compact && (
        <div className="grid grid-cols-2 gap-2 pb-2.5 border-b text-[11px]" style={{ borderColor: 'var(--border)' }}>
          <div>
            <div style={{ color: 'var(--muted)' }}>지금 보내면</div>
            <div className="num font-bold text-[14px]" style={{ color: cacheBroken ? 'var(--danger)' : 'var(--fg)' }}>
              {fmtKo(ctxTokens)}{' '}
              <span className="font-normal text-[11px]" style={{ color: 'var(--muted)' }}>
                / {fmtKo(win)} ({usedPct}%)
              </span>
            </div>
          </div>
          <div>
            <div style={{ color: 'var(--muted)' }}>직전 메시지</div>
            <div className="num font-bold text-[14px]">
              {fmtKo(turnTokens)}{' '}
              <span className="font-normal text-[11px]" style={{ color: 'var(--muted)' }}>
                {tps != null ? `${Math.round(tps)} tok/s` : `요청 ${turnCalls}회`}
              </span>
            </div>
          </div>
          <div>
            <div style={{ color: 'var(--muted)' }}>이 채팅 누적</div>
            <div className="num font-bold text-[14px]">{fmtKo(cum)}</div>
          </div>
          <div>
            <div style={{ color: 'var(--muted)' }}>캐시 절약</div>
            <div className="num font-bold text-[14px]">
              {overallHit}%{' '}
              <span className="font-normal text-[11px]" style={{ color: 'var(--muted)' }}>
                평균
              </span>
            </div>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between gap-2 pb-2 border-b" style={{ borderColor: 'var(--border)' }}>
        <div className="flex items-center gap-4">
          {([
            ['tools', '도구별 증가'],
            ['turns', '최근 턴 기록'],
            ['quota', quotaView.title],
          ] as const).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setDrawerTab(key)}
              className="cursor-pointer pb-1 text-[12px] font-medium transition-colors"
              style={{
                color: drawerTab === key ? 'var(--fg)' : 'var(--muted)',
                borderBottom: drawerTab === key ? '1.5px solid var(--fg)' : '1.5px solid transparent',
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1">
          {drawerTab === 'quota' && (
            <button
              type="button"
              onClick={() => void refreshAccountQuota(true, adapterId)}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] cursor-pointer hover:bg-[var(--surface)]"
              style={{ color: 'var(--muted)' }}
              title={`${quotaView.title} 새로고침`}
            >
              <RefreshCw size={11} className={loadingThisQuota ? 'animate-spin' : ''} />
              <span>갱신</span>
            </button>
          )}
          <button
            type="button"
            onClick={handleOpenGlobalBand}
            className="inline-flex items-center gap-0.5 px-2 py-0.5 rounded-md text-[11px] font-medium cursor-pointer hover:bg-[var(--surface)]"
            style={{ color: 'var(--accent)' }}
            title="3사 통합 토큰 밴드 페이지 열기 (⌘⇧U)"
          >
            <span>전체 보드</span>
            <ArrowUpRight size={11} />
          </button>
          <button
            type="button"
            onClick={handleCompactClick}
            className="px-2 py-0.5 rounded-md text-[11px] cursor-pointer hover:bg-[var(--surface)]"
            style={{ color: 'var(--muted)' }}
          >
            /compact
          </button>
          <button
            type="button"
            onClick={handleNewRoomClick}
            className="px-2 py-0.5 rounded-md text-[11px] cursor-pointer hover:bg-[var(--surface)]"
            style={{ color: 'var(--muted)' }}
          >
            새 대화
          </button>
          <button
            type="button"
            onClick={() => setDrawerOpen(false)}
            className="px-1.5 py-0.5 rounded-md text-[11px] cursor-pointer hover:bg-[var(--surface)]"
            style={{ color: 'var(--muted)' }}
          >
            ✕
          </button>
        </div>
      </div>

      {drawerTab === 'tools' ? (
        metrics?.toolDeltas && metrics.toolDeltas.length > 0 ? (
          <div className="space-y-2 max-h-36 overflow-y-auto scroll-thin">
            {metrics.toolDeltas.slice(0, 8).map((t) => (
              <div key={t.name} className="flex items-center gap-2.5">
                <code className="w-28 truncate text-[11.5px]">{t.name}</code>
                <span className="w-9 text-[11px] num" style={{ color: 'var(--muted)' }}>
                  {t.count}회
                </span>
                <div className="flex-1 track">
                  <div
                    className="track-fill"
                    style={{ width: `${Math.max(4, t.sharePct)}%`, background: quotaView.accent }}
                  />
                </div>
                <span className="w-14 text-right font-semibold num">+{fmtKo(t.deltaTokens)}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="py-1 text-[11.5px]" style={{ color: 'var(--muted)' }}>
            이 대화에서 측정된 도구 호출이 아직 없습니다.
          </div>
        )
      ) : drawerTab === 'turns' ? (
        metrics?.recentTurns && metrics.recentTurns.length > 0 ? (
          <div className="divide-y max-h-36 overflow-y-auto scroll-thin" style={{ borderColor: 'var(--border)' }}>
            {metrics.recentTurns.slice(0, 12).map((t) => (
              <div key={t.invocation} className="flex items-center justify-between py-1.5 text-[11.5px]">
                <span className="w-10 font-mono" style={{ color: 'var(--muted)' }}>
                  #{t.invocation}
                </span>
                <span className="w-16 font-semibold num">{fmtKo(t.contextAtCall)}</span>
                <span
                  className="w-28 num"
                  style={{
                    color: t.cacheMiss ? 'var(--danger)' : t.compacted ? 'var(--accent)' : 'var(--muted)',
                    fontWeight: t.cacheMiss || t.compacted ? 600 : 400,
                  }}
                >
                  {t.compacted
                    ? '압축됨'
                    : t.cacheMiss
                      ? `캐시 깨짐 ${Math.round(t.cacheHitPct)}%`
                      : `캐시 ${Math.round(t.cacheHitPct)}%`}
                </span>
                <span className="flex-1 text-right num" style={{ color: 'var(--muted)' }}>
                  {t.tokPerSec != null ? `${Math.round(t.tokPerSec)} tok/s` : '-'}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <div className="py-1 text-[11.5px]" style={{ color: 'var(--muted)' }}>
            아직 호출 기록이 없습니다.
          </div>
        )
      ) : hasQuota ? (
        <div className="space-y-2.5">
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-[11.5px]">
              <span className="inline-flex items-center gap-1.5 font-semibold" style={{ color: 'var(--fg)' }}>
                <span className="w-2 h-2 rounded-full" style={{ background: quotaView.accent }} />
                <span>{quotaView.title}</span>
              </span>
              <span style={{ color: 'var(--muted)' }}>
                {quotaDisplayMode === 'used' ? '사용량 % · │ 균등' : '남은량 %'}
              </span>
            </div>
            {activeBuckets.map((b) => renderQuotaRow(b, true))}
          </div>
          <div className="flex items-center justify-between text-[11px]" style={{ color: 'var(--muted)' }}>
            <span>
              {quotaView.updatedAt
                ? `${quotaView.sourceLabel} · ${fmtAgo(Date.parse(quotaView.updatedAt)) || '방금'}`
                : quotaView.sourceLabel}
            </span>
            <div className="flex items-center gap-1.5">
              {quotaView.canToggleAgyPool && (
                <button
                  type="button"
                  onClick={() =>
                    setAgyPoolOverride(quotaView.activeAgyPool === 'gemini' ? 'claude' : 'gemini')
                  }
                  className="px-2 py-0.5 rounded-md border cursor-pointer hover:bg-[var(--surface)]"
                  style={{ borderColor: 'var(--border)', color: 'var(--fg-soft)' }}
                >
                  {quotaView.activeAgyPool === 'gemini' ? 'Claude·GPT 풀 보기' : 'Gemini 풀 보기'}
                </button>
              )}
              <button
                type="button"
                onClick={() => setQuotaDisplayMode((m) => (m === 'used' ? 'remaining' : 'used'))}
                className="px-2 py-0.5 rounded-md border cursor-pointer hover:bg-[var(--surface)]"
                style={{ borderColor: 'var(--border)', color: 'var(--fg-soft)' }}
              >
                {quotaDisplayMode === 'used' ? '남은량 %' : '사용량 %'}
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="flex items-center justify-between gap-2 py-1 text-[11.5px]" style={{ color: 'var(--muted)' }}>
          <span>
            {loadingThisQuota
              ? `${quotaView.sourceLabel} 한도를 불러오는 중…`
              : quotaView.error || `${quotaView.title}를 아직 불러오지 못했습니다.`}
          </span>
          <button
            type="button"
            onClick={() => void refreshAccountQuota(true, adapterId)}
            className="px-2 py-0.5 rounded-md border cursor-pointer hover:bg-[var(--surface)] shrink-0"
            style={{ borderColor: 'var(--border)', color: 'var(--fg-soft)' }}
          >
            다시 조회
          </button>
        </div>
      )}
    </div>
  );

  // Show up to 3 compact rows inside the wide card if Claude has 5h + weekly + model-scoped weekly
  const visibleCardBuckets = activeBuckets.slice(0, 3);

  return (
    <div ref={wrapRef} className="space-y-1.5 relative @container">
      {drawerOpen && <div className="mb-1">{renderDrawer()}</div>}

      {compact ? (
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setDrawerOpen((v) => !v)}
            className="flex-1 min-w-0 h-7 px-3 rounded-xl border flex items-center justify-between gap-2 text-[11.5px] cursor-pointer transition-colors hover:bg-[var(--surface)]"
            style={{
              background: 'var(--card)',
              borderColor: 'var(--border)',
              color: 'var(--muted)',
            }}
            title="클릭해서 상세 토큰·도구별 증가·사용 한도 보기"
          >
            <div className="flex items-center gap-2 min-w-0 truncate num">
              <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: quotaView.accent }} />
              {invocations === 0 ? (
                <>
                  <span>새 대화 · 0 / {fmtKo(win)}</span>
                  {compactQuotaText && (
                    <>
                      <span style={{ color: 'var(--border-strong)' }}>·</span>
                      <span style={{ color: 'var(--fg-soft)' }}>{compactQuotaText}</span>
                    </>
                  )}
                </>
              ) : (
                <>
                  <span className="font-semibold" style={{ color: cacheBroken ? 'var(--danger)' : 'var(--fg)' }}>
                    ctx {fmtKo(ctxTokens)}
                  </span>
                  <span>({usedPct}%)</span>
                  <span style={{ color: 'var(--border-strong)' }}>·</span>
                  <span style={{ color: cacheBroken ? 'var(--danger)' : undefined }}>캐시 {hitPct}%</span>
                  {compactQuotaText && (
                    <>
                      <span className="hidden @[340px]:inline" style={{ color: 'var(--border-strong)' }}>
                        ·
                      </span>
                      <span className="hidden @[340px]:inline" style={{ color: 'var(--fg-soft)' }}>
                        {compactQuotaText}
                      </span>
                    </>
                  )}
                  {tps != null && (
                    <>
                      <span className="hidden @[450px]:inline" style={{ color: 'var(--border-strong)' }}>
                        ·
                      </span>
                      <span className="hidden @[450px]:inline">{Math.round(tps)} tok/s</span>
                    </>
                  )}
                  <span className="hidden @[530px]:inline" style={{ color: 'var(--border-strong)' }}>
                    ·
                  </span>
                  <span
                    className="hidden @[530px]:inline"
                    style={{ color: heavySession ? 'var(--warn)' : undefined, fontWeight: heavySession ? 600 : 400 }}
                  >
                    {heavySession ? '새 방 권장' : `누적 ${fmtKo(cum)}`}
                  </span>
                </>
              )}
            </div>
            <span className="shrink-0 opacity-70">{drawerOpen ? <ChevronDown size={13} /> : <ChevronUp size={13} />}</span>
          </button>
          <button
            type="button"
            onClick={handleOpenGlobalBand}
            className="h-7 px-2 rounded-xl border inline-flex items-center gap-1 text-[11px] font-medium cursor-pointer shrink-0 transition-colors hover:bg-[var(--surface)]"
            style={{
              background: 'var(--card)',
              borderColor: 'var(--border)',
              color: 'var(--fg-soft)',
            }}
            title="3사 통합 토큰 밴드 보드 열기 (⌘⇧U)"
          >
            <span>전체</span>
            <ArrowUpRight size={11} />
          </button>
        </div>
      ) : (
        <div className="rounded-[18px] p-1.5" style={{ background: 'var(--surface)' }}>
          <div
            role="button"
            tabIndex={0}
            onClick={() => setDrawerOpen((v) => !v)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                setDrawerOpen((v) => !v);
              }
            }}
            title="클릭해서 도구별 +토큰 · 최근 턴 · 사용 한도 보기"
            className="rounded-[13px] border cursor-pointer transition-colors overflow-hidden"
            style={{
              background: 'var(--card)',
              borderColor: 'var(--border)',
              boxShadow: 'var(--shadow-sm)',
            }}
          >
            <div className="grid grid-cols-[1fr_1fr_1fr_1.52fr]">
              <div className="px-3.5 py-2.5 min-w-0">
                <div className="flex items-center justify-between gap-1 text-[11px]" style={{ color: 'var(--muted)' }}>
                  <span className="truncate">지금 보내면</span>
                  <span className="num shrink-0 opacity-75">/ {fmtKo(win)}</span>
                </div>
                <div
                  className="num text-[20px] font-bold leading-tight mt-0.5"
                  style={{ color: cacheBroken ? 'var(--danger)' : 'var(--fg)' }}
                >
                  {fmtKo(ctxTokens)}
                </div>
                <div
                  className="text-[11px] mt-0.5 truncate"
                  style={{
                    color: cacheBroken ? 'var(--danger)' : 'var(--muted)',
                    fontWeight: cacheBroken ? 600 : 400,
                  }}
                >
                  {invocations === 0
                    ? '새 대화 대기 중'
                    : cacheBroken
                      ? '캐시 깨짐 · 다시 읽음'
                      : `캐시 ${hitPct}% 적중${ago ? ` · ${ago}` : ''}`}
                </div>
              </div>

              <div className="px-3.5 py-2.5 min-w-0 border-l" style={{ borderColor: 'var(--border)' }}>
                <div className="flex items-center justify-between gap-1 text-[11px]" style={{ color: 'var(--muted)' }}>
                  <span className="truncate">직전 메시지</span>
                  {tps != null && <span className="num shrink-0">{Math.round(tps)} tok/s</span>}
                </div>
                <div className="num text-[20px] font-bold leading-tight mt-0.5">{fmtKo(turnTokens)}</div>
                <div className="text-[11px] mt-0.5 truncate" style={{ color: 'var(--muted)' }}>
                  요청 {turnCalls}회
                </div>
              </div>

              <div className="px-3.5 py-2.5 min-w-0 border-l" style={{ borderColor: 'var(--border)' }}>
                <div className="text-[11px]" style={{ color: 'var(--muted)' }}>
                  이 채팅 누적
                </div>
                <div className="num text-[20px] font-bold leading-tight mt-0.5">{fmtKo(cum)}</div>
                <div
                  className="text-[11px] mt-0.5 truncate"
                  style={{
                    color: heavySession ? 'var(--warn)' : 'var(--muted)',
                    fontWeight: heavySession ? 600 : 400,
                  }}
                >
                  {invocations === 0
                    ? '이 대화 단독'
                    : heavySession
                      ? `새 방 권장 · ${usedPct}%`
                      : `여유 · 전체 ${usedPct}%`}
                </div>
              </div>

              <div
                className="px-3.5 py-2.5 min-w-0 border-l flex flex-col justify-between"
                style={{ borderColor: 'var(--border)' }}
              >
                {hasQuota ? (
                  <>
                    <div
                      className="flex items-center justify-between gap-1 text-[11px] mb-1"
                      style={{ color: 'var(--muted)' }}
                    >
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          if (quotaView.canToggleAgyPool) {
                            setAgyPoolOverride(quotaView.activeAgyPool === 'gemini' ? 'claude' : 'gemini');
                          }
                        }}
                        className={`inline-flex items-center gap-1.5 truncate text-left font-medium ${quotaView.canToggleAgyPool ? 'cursor-pointer hover:underline' : ''}`}
                        style={{ color: 'var(--fg-soft)' }}
                        title={
                          quotaView.canToggleAgyPool
                            ? '클릭해서 반중력 Gemini ↔ Claude·GPT 풀 전환'
                            : quotaView.title
                        }
                      >
                        <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: quotaView.accent }} />
                        <span className="truncate">{quotaView.title}</span>
                      </button>
                      <div className="flex items-center gap-1.5 shrink-0">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setQuotaDisplayMode((m) => (m === 'used' ? 'remaining' : 'used'));
                          }}
                          className="opacity-80 hover:opacity-100 cursor-pointer"
                          title="클릭해서 사용량 % ↔ 남은량 % 전환"
                        >
                          {quotaDisplayMode === 'used' ? '사용│균등' : '남음%'}
                        </button>
                        <button
                          type="button"
                          onClick={handleOpenGlobalBand}
                          className="inline-flex items-center opacity-75 hover:opacity-100 cursor-pointer"
                          style={{ color: 'var(--accent)' }}
                          title="3사 통합 토큰 밴드 보드 열기 (⌘⇧U)"
                        >
                          <ArrowUpRight size={12} />
                        </button>
                      </div>
                    </div>
                    <div className={visibleCardBuckets.length > 2 ? 'space-y-1' : 'space-y-1.5'}>
                      {visibleCardBuckets.map((b) => renderQuotaRow(b, false))}
                    </div>
                  </>
                ) : (
                  <>
                    <div className="flex items-center justify-between text-[11px] mb-1.5" style={{ color: 'var(--muted)' }}>
                      <span className="inline-flex items-center gap-1.5 truncate">
                        <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: quotaView.accent }} />
                        <span className="truncate">{quotaView.title}</span>
                      </span>
                      <div className="flex items-center gap-1.5 shrink-0">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            void refreshAccountQuota(true, adapterId);
                          }}
                          className="inline-flex items-center gap-0.5 opacity-80 hover:opacity-100 cursor-pointer"
                          title={`${quotaView.title} 불러오기`}
                        >
                          <RefreshCw size={10} className={loadingThisQuota ? 'animate-spin' : ''} />
                          <span>{loadingThisQuota ? '조회중' : '조회'}</span>
                        </button>
                        <button
                          type="button"
                          onClick={handleOpenGlobalBand}
                          className="inline-flex items-center opacity-75 hover:opacity-100 cursor-pointer"
                          style={{ color: 'var(--accent)' }}
                          title="3사 통합 토큰 밴드 보드 열기 (⌘⇧U)"
                        >
                          <ArrowUpRight size={12} />
                        </button>
                      </div>
                    </div>
                    <div className="space-y-1.5">
                      <div className="grid grid-cols-[42px_1fr_28px_34px] items-center gap-1 text-[11px]">
                        <span className="truncate" style={{ color: 'var(--muted)' }}>
                          컨텍스트
                        </span>
                        <div className="track">
                          <div
                            className="track-fill"
                            style={{ width: `${Math.min(100, usedPct)}%`, background: quotaView.accent }}
                          />
                          <div className="track-tick" style={{ left: '50%' }} />
                        </div>
                        <span className="num text-right font-semibold">{Math.round(usedPct)}%</span>
                        <span className="num text-right truncate" style={{ color: 'var(--muted)' }}>
                          {fmtKo(win)}
                        </span>
                      </div>
                      <div className="grid grid-cols-[42px_1fr_28px_34px] items-center gap-1 text-[11px]">
                        <span className="truncate" style={{ color: 'var(--muted)' }}>
                          캐시 절약
                        </span>
                        <div className="track">
                          <div className="track-fill" style={{ width: `${Math.min(100, overallHit)}%` }} />
                        </div>
                        <span className="num text-right font-semibold">{overallHit}%</span>
                        <span className="text-right truncate" style={{ color: 'var(--muted)' }}>
                          평균
                        </span>
                      </div>
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
