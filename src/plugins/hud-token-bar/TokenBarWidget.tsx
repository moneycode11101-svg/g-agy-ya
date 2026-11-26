import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, RefreshCw } from 'lucide-react';
import {
  BUILTIN_PLUGIN_IDS,
  useLayoutStore,
  usePluginConfigStore,
  type DeskClientContext,
  type PaneTabRecord,
} from '../../kernel/client';
import type { QuotaBucket, QuotaGroupKey, QuotaWindow } from '../../shared/types';
import { computePaceTickPct, fmtAgo, fmtKo, fmtReset } from '../../utils/formatKo';
import type { AgyPluginConfig } from '../agent-agy/types';
import { useChatSessionStore, type ChatTabState } from '../pane-chat/chatStore';
import type { HudTokenBarConfig } from './manifest';

function inferModelGroup(model?: string, adapterId?: string): QuotaGroupKey {
  if (adapterId === 'agent-codex') return 'codex';
  if (adapterId === 'agent-claude') return 'claude';
  const m = String(model || '').toLowerCase();
  if (m.includes('claude') || m.includes('gpt') || m.includes('o1') || m.includes('o3') || m.includes('o4')) {
    return 'claude';
  }
  return 'gemini';
}

function inferBucketGroup(b: QuotaBucket): QuotaGroupKey {
  if (b.group === 'gemini' || b.group === 'claude' || b.group === 'codex') return b.group;
  const hay = `${b.id} ${b.groupName || ''}`.toLowerCase();
  if (hay.includes('codex')) return 'codex';
  return hay.includes('gemini') ? 'gemini' : 'claude';
}

function inferBucketWindow(b: QuotaBucket): QuotaWindow | undefined {
  if (b.window === '5h' || b.window === 'weekly' || b.window === 'monthly') return b.window;
  const s = b.id.toLowerCase();
  if (s.includes('5h') || s.includes('five')) return '5h';
  if (s.includes('week')) return 'weekly';
  if (s.includes('month') || s.includes('credit')) return 'monthly';
  return undefined;
}

function sortGroupBuckets(list: QuotaBucket[]): QuotaBucket[] {
  const rank = (b: QuotaBucket) => {
    const w = inferBucketWindow(b);
    if (w === '5h') return 0;
    if (w === 'weekly') {
      return /^claude-weekly-.+/.test(b.id) ? 1.5 : 1;
    }
    return 2;
  };
  return [...list].sort((a, b) => rank(a) - rank(b));
}

function bucketUsedPct(b: QuotaBucket): number {
  if (b.remainingFraction == null) return 0;
  return Math.min(100, Math.max(0, Math.round((1 - b.remainingFraction) * 100)));
}

function windowLabel(b: QuotaBucket): string {
  const scopedMatch = /^claude-weekly-(.+)$/.exec(b.id);
  if (scopedMatch) {
    const raw = b.groupName?.includes('·') ? b.groupName.split('·').pop()?.trim() : scopedMatch[1];
    const clean = (raw || scopedMatch[1]).slice(0, 6);
    return clean.charAt(0).toUpperCase() + clean.slice(1);
  }
  const w = inferBucketWindow(b);
  if (w === '5h') return '5시간';
  if (w === 'weekly') return '주간';
  if (w === 'monthly') return '월간';
  return b.id.length > 6 ? b.id.slice(0, 6) : b.id;
}

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
  const accountQuota = useChatSessionStore(
    (s) => s.accountQuotaByAdapter[adapterId] ?? (adapterId === 'agent-agy' ? s.accountQuota : null)
  );
  const loadingQuota = useChatSessionStore((s) => s.loadingQuota);
  const refreshAccountQuota = useChatSessionStore((s) => s.refreshAccountQuota);
  const groups = useLayoutStore((s) => s.groups);
  const agyDefaultModel = usePluginConfigStore(
    (s) => (s.configsByPlugin[adapterId] as Partial<AgyPluginConfig> | undefined)?.defaultModel
  );

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerTab, setDrawerTab] = useState<'tools' | 'turns' | 'quota'>('tools');
  const [quotaDisplayMode, setQuotaDisplayMode] = useState<'used' | 'remaining'>('used');
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
    state?.model && state.model !== 'default' ? state.model : metrics?.model || agyDefaultModel || '';
  const inferredGroup = inferModelGroup(effectiveModel, adapterId);
  const [groupOverride, setGroupOverride] = useState<QuotaGroupKey | null>(null);

  useEffect(() => {
    setGroupOverride(null);
  }, [inferredGroup]);

  const ctxTokens = metrics?.currentContext ?? 0;
  const win = metrics?.contextWindow ?? 1_048_576;
  const usedPct = metrics?.usedPct ?? 0;
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

  const allQuotas =
    accountQuota && accountQuota.buckets.length > 0 ? accountQuota.buckets : (metrics?.quotaBuckets ?? []);
  const hasQuota = allQuotas.length > 0;
  const quotaUpdatedAt = accountQuota?.updatedAt || metrics?.quotaUpdatedAt || null;

  const geminiBuckets = sortGroupBuckets(allQuotas.filter((b) => inferBucketGroup(b) === 'gemini'));
  const claudeBuckets = sortGroupBuckets(allQuotas.filter((b) => inferBucketGroup(b) === 'claude'));
  const codexBuckets = sortGroupBuckets(allQuotas.filter((b) => inferBucketGroup(b) === 'codex'));
  const hasBothGroups = adapterId === 'agent-agy' && geminiBuckets.length > 0 && claudeBuckets.length > 0;

  const desiredGroup = groupOverride ?? inferredGroup;
  const activeGroup: QuotaGroupKey =
    adapterId === 'agent-codex' && codexBuckets.length > 0
      ? 'codex'
      : desiredGroup === 'claude'
        ? claudeBuckets.length > 0
          ? 'claude'
          : 'gemini'
        : geminiBuckets.length > 0
          ? 'gemini'
          : claudeBuckets.length > 0
            ? 'claude'
            : 'codex';
  const activeBuckets =
    activeGroup === 'codex' ? codexBuckets : activeGroup === 'gemini' ? geminiBuckets : claudeBuckets;
  const activeTitle =
    activeGroup === 'codex'
      ? 'Codex 한도'
      : activeGroup === 'gemini'
        ? 'Gemini 사용 한도'
        : adapterId === 'agent-claude'
          ? 'Claude Code 한도'
          : 'Claude·GPT 한도';

  const totalGroups = Object.keys(groups).length;
  const compact = Boolean(cfg.forceCompact) || boxWidth < 580 || (totalGroups > 1 && invocations === 0);

  const compactQuotaText = (() => {
    if (!hasQuota || activeBuckets.length === 0) return '';
    const pctOf = (b: QuotaBucket) => (quotaDisplayMode === 'used' ? bucketUsedPct(b) : 100 - bucketUsedPct(b));
    const h5 = activeBuckets.find((b) => inferBucketWindow(b) === '5h');
    const wk = activeBuckets.find((b) => inferBucketWindow(b) === 'weekly');
    const prefix = quotaDisplayMode === 'used' ? '사용' : '남음';
    if (h5 && wk) return `${prefix} ${pctOf(h5)}%·${pctOf(wk)}%`;
    return `${prefix} ${pctOf(activeBuckets[0])}%`;
  })();

  const handleCompactClick = () => {
    setDrawerOpen(false);
    void ctx.commands.execute('pane-chat:send-prompt', { groupId, tabId: tab.id, prompt: '/compact' });
  };

  const handleNewRoomClick = () => {
    setDrawerOpen(false);
    ctx.workspace.openTab('chat', { cwd: state?.cwd }, { groupId });
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
    const barColor = nearLimit ? 'var(--danger)' : overPace ? 'var(--warn)' : undefined;
    const lbl = windowLabel(b);

    return (
      <div
        key={b.id}
        className={`grid ${wideReset ? 'grid-cols-[34px_1fr_36px_42px]' : 'grid-cols-[32px_1fr_30px_36px]'} items-center gap-1.5 text-[11px]`}
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
                ({usedPct}%)
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
            ['quota', '사용 한도'],
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
        <div className="flex items-center gap-1.5">
          {drawerTab === 'quota' && (
            <button
              type="button"
              onClick={() => void refreshAccountQuota(true, adapterId)}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] cursor-pointer hover:bg-[var(--surface)]"
              style={{ color: 'var(--muted)' }}
              title={`${adapterId} 사용 한도 새로고침`}
            >
              <RefreshCw size={11} className={loadingQuota ? 'animate-spin' : ''} />
              <span>갱신</span>
            </button>
          )}
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
                  <div className="track-fill" style={{ width: `${Math.max(4, t.sharePct)}%` }} />
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
          <div className="grid grid-cols-1 @[480px]:grid-cols-2 gap-3.5">
            {geminiBuckets.length > 0 && (
              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-[11.5px]">
                  <span className="font-semibold" style={{ color: 'var(--fg)' }}>
                    Gemini Models
                  </span>
                  <span style={{ color: 'var(--muted)' }}>
                    {quotaDisplayMode === 'used' ? '사용량 % · │ 균등' : '남은량 %'}
                  </span>
                </div>
                {geminiBuckets.map((b) => renderQuotaRow(b, true))}
              </div>
            )}
            {claudeBuckets.length > 0 && (
              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-[11.5px]">
                  <span className="font-semibold" style={{ color: 'var(--fg)' }}>
                    {adapterId === 'agent-claude' ? 'Claude Code' : 'Claude · GPT'}
                  </span>
                  <span style={{ color: 'var(--muted)' }}>
                    {quotaDisplayMode === 'used' ? '사용량 % · │ 균등' : '남은량 %'}
                  </span>
                </div>
                {claudeBuckets.map((b) => renderQuotaRow(b, true))}
              </div>
            )}
            {codexBuckets.length > 0 && (
              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-[11.5px]">
                  <span className="font-semibold" style={{ color: 'var(--fg)' }}>
                    Codex (GPT)
                  </span>
                  <span style={{ color: 'var(--muted)' }}>
                    {quotaDisplayMode === 'used' ? '사용량 % · │ 균등' : '남은량 %'}
                  </span>
                </div>
                {codexBuckets.map((b) => renderQuotaRow(b, true))}
              </div>
            )}
          </div>
          <div className="flex items-center justify-between text-[11px]" style={{ color: 'var(--muted)' }}>
            <span>
              {(() => {
                const sourceLabel =
                  adapterId === 'agent-claude'
                    ? 'Claude SDK 실시간 동기화'
                    : adapterId === 'agent-codex'
                      ? 'Codex app-server 실시간 동기화'
                      : 'agy /usage 실시간 동기화';
                return quotaUpdatedAt
                  ? `${sourceLabel} · ${fmtAgo(Date.parse(quotaUpdatedAt)) || '방금'}`
                  : sourceLabel;
              })()}
            </span>
            <button
              type="button"
              onClick={() => setQuotaDisplayMode((m) => (m === 'used' ? 'remaining' : 'used'))}
              className="px-2 py-0.5 rounded-md border cursor-pointer hover:bg-[var(--surface)]"
              style={{ borderColor: 'var(--border)', color: 'var(--fg-soft)' }}
            >
              {quotaDisplayMode === 'used' ? '남은량 %로 보기' : '사용량 %로 보기'}
            </button>
          </div>
        </div>
      ) : (
        <div className="py-1 text-[11.5px]" style={{ color: 'var(--muted)' }}>
          {loadingQuota
            ? `${adapterId === 'agent-claude' ? 'Claude' : adapterId === 'agent-codex' ? 'Codex' : 'agy /usage'} 사용 한도를 불러오는 중…`
            : '계정 사용 한도를 아직 불러오지 못했습니다.'}
        </div>
      )}
    </div>
  );

  return (
    <div ref={wrapRef} className="space-y-1.5 relative @container">
      {drawerOpen && <div className="mb-1">{renderDrawer()}</div>}

      {compact ? (
        <button
          type="button"
          onClick={() => setDrawerOpen((v) => !v)}
          className="w-full h-7 px-3 rounded-xl border flex items-center justify-between gap-2 text-[11.5px] cursor-pointer transition-colors hover:bg-[var(--surface)]"
          style={{
            background: 'var(--card)',
            borderColor: 'var(--border)',
            color: 'var(--muted)',
          }}
          title="클릭해서 상세 토큰·도구별 증가·사용 한도 보기"
        >
          <div className="flex items-center gap-2 min-w-0 truncate num">
            {invocations === 0 ? (
              <>
                <span>새 대화 · 컨텍스트 0 / {fmtKo(win)}</span>
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
            title="클릭해서 도구별 +토큰 · 최근 턴 · 전체 사용 한도 보기"
            className="rounded-[13px] border cursor-pointer transition-colors overflow-hidden"
            style={{
              background: 'var(--card)',
              borderColor: 'var(--border)',
              boxShadow: 'var(--shadow-sm)',
            }}
          >
            <div className="grid grid-cols-[1fr_1fr_1fr_1.45fr]">
              <div className="px-3.5 py-2.5 min-w-0">
                <div className="text-[11px]" style={{ color: 'var(--muted)' }}>
                  지금 보내면
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
                {hasQuota && activeBuckets.length > 0 ? (
                  <>
                    <div
                      className="flex items-center justify-between gap-1 text-[11px] mb-1.5"
                      style={{ color: 'var(--muted)' }}
                    >
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          if (hasBothGroups) {
                            setGroupOverride(activeGroup === 'gemini' ? 'claude' : 'gemini');
                          }
                        }}
                        className={`truncate text-left font-medium ${hasBothGroups ? 'cursor-pointer hover:underline' : ''}`}
                        style={{ color: 'var(--fg-soft)' }}
                        title={hasBothGroups ? '클릭해서 Gemini ↔ Claude·GPT 한도 전환' : activeTitle}
                      >
                        {activeTitle}
                      </button>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setQuotaDisplayMode((m) => (m === 'used' ? 'remaining' : 'used'));
                        }}
                        className="shrink-0 opacity-85 hover:opacity-100 cursor-pointer"
                        title="클릭해서 사용량 % ↔ 남은량 % 전환"
                      >
                        {quotaDisplayMode === 'used' ? '사용 │ 균등' : '남은량 %'}
                      </button>
                    </div>
                    <div className="space-y-1.5">{activeBuckets.slice(0, 2).map((b) => renderQuotaRow(b, false))}</div>
                  </>
                ) : (
                  <>
                    <div className="flex items-center justify-between text-[11px] mb-1.5" style={{ color: 'var(--muted)' }}>
                      <span>{loadingQuota ? '사용 한도' : '세션 상태'}</span>
                      <span>{loadingQuota ? '불러오는 중' : '단독'}</span>
                    </div>
                    <div className="space-y-1.5">
                      <div className="grid grid-cols-[42px_1fr_28px_34px] items-center gap-1 text-[11px]">
                        <span className="truncate" style={{ color: 'var(--muted)' }}>
                          컨텍스트
                        </span>
                        <div className="track">
                          <div className="track-fill" style={{ width: `${Math.min(100, usedPct)}%` }} />
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
