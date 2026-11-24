import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Globe,
  Layers,
  Link2,
  Lock,
  RefreshCw,
  Search,
} from 'lucide-react';
import {
  BUILTIN_PLUGIN_IDS,
  useIntrospectionStore,
  useLayoutStore,
  type DeskClientContext,
  type RuntimeAssetControlMode,
  type RuntimeAssetKind,
  type RuntimeAssetsProjection,
  type RuntimeContextAsset,
} from '../../kernel/client';
import { fmtKo } from '../../utils/formatKo';
import { AGY_BUS, AGY_RPC } from '../agent-agy/types';
import type { RuntimeContextInspectorConfig } from './manifest';

const CONTROL_MODE_META: Record<
  RuntimeAssetControlMode,
  { label: string; color: string; bg: string; toggleable: boolean }
> = {
  'live-toggle': {
    label: '실시간 토글',
    color: '#16a34a',
    bg: 'color-mix(in srgb, #16a34a 14%, transparent)',
    toggleable: true,
  },
  'next-turn': {
    label: '다음 턴 반영',
    color: '#2563eb',
    bg: 'color-mix(in srgb, #2563eb 14%, transparent)',
    toggleable: true,
  },
  'new-session': {
    label: '새 세션 반영',
    color: '#0891b2',
    bg: 'color-mix(in srgb, #0891b2 14%, transparent)',
    toggleable: true,
  },
  'global-only': {
    label: '전역 제어 (CLI)',
    color: '#b45309',
    bg: 'color-mix(in srgb, #f59e0b 16%, transparent)',
    toggleable: true,
  },
  'read-only-cli': {
    label: 'CLI 읽기 전용',
    color: 'var(--muted)',
    bg: 'var(--surface)',
    toggleable: false,
  },
};

const SCOPE_LABELS: Record<RuntimeContextAsset['scope'], string> = {
  plugin: '플러그인',
  global: '전역',
  workspace: '워크스페이스',
  builtin: '내장',
  'session-overlay': '세션',
  preset: '프리셋',
};

const KIND_TABS: Array<{ id: 'all' | RuntimeAssetKind; label: string }> = [
  { id: 'all', label: '전체' },
  { id: 'plugin-bundle', label: '플러그인 번들' },
  { id: 'skill', label: '스킬' },
  { id: 'rule', label: '규칙' },
  { id: 'mcp', label: 'MCP' },
  { id: 'hook', label: '훅' },
];

export interface RuntimeContextInspectorViewProps {
  ctx: DeskClientContext<RuntimeContextInspectorConfig>;
  cwdOverride?: string;
  compact?: boolean;
}

export const RuntimeContextInspectorView: React.FC<RuntimeContextInspectorViewProps> = ({
  ctx,
  cwdOverride,
  compact = false,
}) => {
  const cfg = ctx.config.useConfig();
  const showBuiltinSkills = cfg.showBuiltinSkills !== false;

  const snapshot = useIntrospectionStore((s) => s.snapshot);
  const acquireLive = useIntrospectionStore((s) => s.acquireLiveSubscription);
  const sendCommand = useIntrospectionStore((s) => s.sendCommand);

  const groups = useLayoutStore((s) => s.groups);
  const focusedGroupId = useLayoutStore((s) => s.focusedGroupId);

  const focusedCwd = useMemo(() => {
    if (cwdOverride) return cwdOverride;
    const grp = groups[focusedGroupId];
    const activeTab = grp?.tabs.find((t) => t.id === grp.activeTabId);
    const cwd = activeTab?.state?.cwd;
    return typeof cwd === 'string' && cwd ? cwd : undefined;
  }, [cwdOverride, focusedGroupId, groups]);

  const [selectedAdapterId, setSelectedAdapterId] = useState<string>(BUILTIN_PLUGIN_IDS.AGENT_AGY);
  const [cwdProjection, setCwdProjection] = useState<RuntimeAssetsProjection | null>(null);
  const [kindFilter, setKindFilter] = useState<'all' | RuntimeAssetKind>('all');
  const [query, setQuery] = useState('');
  const [busyAssetId, setBusyAssetId] = useState<string | null>(null);
  const [rescanning, setRescanning] = useState(false);

  useEffect(() => {
    const release = acquireLive();
    return () => release();
  }, [acquireLive]);

  const scanForCwd = useCallback(
    async (cwd?: string) => {
      setRescanning(true);
      try {
        if (selectedAdapterId === BUILTIN_PLUGIN_IDS.AGENT_AGY) {
          const proj = await ctx.rpc.invoke<RuntimeAssetsProjection>(AGY_RPC.ASSETS_SCAN, { cwd });
          if (proj) setCwdProjection(proj);
        } else {
          await sendCommand({ type: 'runtime-asset:rescan', adapterPluginId: selectedAdapterId });
        }
      } catch {
        // fallback to introspection snapshot
      } finally {
        setRescanning(false);
      }
    },
    [ctx.rpc, selectedAdapterId, sendCommand]
  );

  useEffect(() => {
    void scanForCwd(focusedCwd);
  }, [focusedCwd, scanForCwd]);

  useEffect(() => {
    const unsub = ctx.bus.subscribe<RuntimeAssetsProjection>(AGY_BUS.ASSETS_UPDATED, (env) => {
      if (env.payload) setCwdProjection(env.payload);
    });
    return () => {
      void unsub();
    };
  }, [ctx.bus]);

  const adapters = useMemo(() => {
    const map = snapshot?.runtimeAssetsByAdapter || {};
    const list = Object.values(map);
    if (list.length === 0 && cwdProjection) return [cwdProjection];
    return list;
  }, [cwdProjection, snapshot?.runtimeAssetsByAdapter]);

  const projection: RuntimeAssetsProjection | null = useMemo(() => {
    if (selectedAdapterId === BUILTIN_PLUGIN_IDS.AGENT_AGY && cwdProjection) {
      return cwdProjection;
    }
    return snapshot?.runtimeAssetsByAdapter?.[selectedAdapterId] || adapters[0] || null;
  }, [adapters, cwdProjection, selectedAdapterId, snapshot?.runtimeAssetsByAdapter]);

  const assets = projection?.assets || [];
  const symlinkCount = useMemo(() => assets.filter((a) => a.isSymlink).length, [assets]);

  const filteredAssets = useMemo(() => {
    const q = query.trim().toLowerCase();
    return assets.filter((a) => {
      if (!showBuiltinSkills && a.kind === 'skill' && a.scope === 'builtin') return false;
      if (kindFilter !== 'all' && a.kind !== kindFilter) return false;
      if (!q) return true;
      return `${a.name} ${a.description} ${a.parentPluginName || ''} ${a.sourcePath} ${a.scope}`
        .toLowerCase()
        .includes(q);
    });
  }, [assets, kindFilter, query, showBuiltinSkills]);

  const handleToggle = async (asset: RuntimeContextAsset) => {
    if (busyAssetId) return;
    if (asset.controlMode === 'global-only') {
      const nextLabel = asset.enabled ? '비활성화' : '활성화';
      const warning = [
        `"${asset.name}"을(를) 전역 ${nextLabel}하시겠습니까?`,
        '',
        '• ~/.gemini/config/config.json이 변경되어 다른 agy CLI · 앱에도 동일하게 적용됩니다.',
        '• 실행 중인 채팅 세션은 다음 턴에서 워커가 재기동되며 프롬프트 캐시가 초기화될 수 있습니다.',
      ].join('\n');
      const ok = await ctx.ui.confirm(warning);
      if (!ok) return;
    }

    setBusyAssetId(asset.id);
    try {
      const res = await sendCommand({
        type: 'runtime-asset:toggle',
        adapterPluginId: projection?.adapterPluginId || selectedAdapterId,
        assetId: asset.id,
        enabled: !asset.enabled,
        scope: 'global',
      });
      if (!res.ok) {
        ctx.ui.toast(res.error || '자산 전환에 실패했습니다.', 'error');
      } else {
        ctx.ui.toast(
          `${asset.name} ${!asset.enabled ? '활성화됨' : '비활성화됨'} (다음 턴부터 반영)`,
          'info'
        );
        await scanForCwd(focusedCwd);
      }
    } finally {
      setBusyAssetId(null);
    }
  };

  const budget = projection?.tokenBudgetMax || 20_000;
  const ruleTokens = projection?.totals.ruleTokens ?? 0;
  const skillTokens = projection?.totals.skillTokens ?? 0;
  const mcpTokens = projection?.totals.mcpTokens ?? 0;
  const otherTokens = skillTokens + mcpTokens;
  const rulePct = Math.min(100, Number(((ruleTokens / budget) * 100).toFixed(1)));
  const skillPct = Math.min(100, Number(((skillTokens / budget) * 100).toFixed(1)));
  const mcpPct = Math.min(100, Number(((mcpTokens / budget) * 100).toFixed(1)));
  const otherPct = Math.min(100, Number(((otherTokens / budget) * 100).toFixed(1)));

  const pluginBundles = assets.filter((a) => a.kind === 'plugin-bundle');
  const activeSkills = assets.filter((a) => a.kind === 'skill' && a.enabled);
  const activeMcps = assets.filter((a) => a.kind === 'mcp' && a.enabled);
  const activeRules = assets.filter((a) => a.kind === 'rule' && a.enabled);

  return (
    <div className={compact ? 'space-y-4' : 'space-y-5'}>
      {/* 어댑터 헤더 & 재스캔 */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <Layers size={15} style={{ color: 'var(--accent)' }} className="shrink-0" />
          <div className="min-w-0">
            <div className="text-[13.5px] font-semibold truncate">
              {projection?.adapterLabel || '에이전트 런타임 자산'}
            </div>
            <div className="text-[11px] font-mono truncate" style={{ color: 'var(--muted)' }}>
              {focusedCwd ? `기준 워크스페이스: ${focusedCwd}` : '전역 ~/.gemini/config 기준'}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          {adapters.length > 1 && (
            <select
              value={selectedAdapterId}
              onChange={(e) => setSelectedAdapterId(e.target.value)}
              className="px-2 py-1 rounded-lg border text-[11.5px] outline-none cursor-pointer"
              style={{ background: 'var(--surface)', borderColor: 'var(--border)', color: 'var(--fg)' }}
            >
              {adapters.map((ad) => (
                <option key={ad.adapterPluginId} value={ad.adapterPluginId}>
                  {ad.adapterLabel}
                </option>
              ))}
            </select>
          )}
          <button
            type="button"
            onClick={() => void scanForCwd(focusedCwd)}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border text-[11.5px] cursor-pointer hover:bg-[var(--surface)]"
            style={{ background: 'var(--card)', borderColor: 'var(--border)', color: 'var(--fg-soft)' }}
            title="디스크 및 MCP 스키마 캐시 다시 스캔"
          >
            <RefreshCw size={11} className={rescanning ? 'animate-spin' : ''} />
            <span>다시 스캔</span>
          </button>
        </div>
      </div>

      {/* 정직한 토큰 예산 요약 카드 */}
      <div
        className="rounded-2xl border p-4 space-y-3 text-[12.5px]"
        style={{ background: 'var(--card)', borderColor: 'var(--border)' }}
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="font-semibold">Layer 2 프롬프트 컨텍스트 예산 (실측 캐시 + 파일 분석)</div>
          {symlinkCount > 0 && (
            <span
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10.5px] font-medium"
              style={{
                background: 'color-mix(in srgb, var(--accent) 12%, transparent)',
                color: 'var(--accent)',
              }}
            >
              <Link2 size={10} />
              <span>심볼릭 링크 {symlinkCount}개 추적됨</span>
            </span>
          )}
        </div>

        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="font-medium">규칙 ({activeRules.length}개 활성 · 파일당 24KB 상한)</span>
            <span className="num text-[12px]" style={{ color: 'var(--muted)' }}>
              {ruleTokens.toLocaleString()} / {budget.toLocaleString()} tokens ({rulePct}%)
            </span>
          </div>
          <div className="h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--surface)' }}>
            <div className="h-full rounded-full" style={{ width: `${Math.max(ruleTokens > 0 ? 1 : 0, rulePct)}%`, background: '#3b82f6' }} />
          </div>
        </div>

        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="font-medium">
              스킬 헤더 ({activeSkills.length}개) · MCP 스키마 ({activeMcps.length}개)
            </span>
            <span className="num text-[12px]" style={{ color: 'var(--muted)' }}>
              {otherTokens.toLocaleString()} / {budget.toLocaleString()} tokens ({otherPct}%)
            </span>
          </div>
          <div className="h-1.5 rounded-full overflow-hidden flex" style={{ background: 'var(--surface)' }}>
            <div className="h-full" style={{ width: `${skillPct}%`, background: '#22c55e' }} />
            <div className="h-full" style={{ width: `${mcpPct}%`, background: '#9333ea' }} />
          </div>
        </div>

        <div className="grid grid-cols-3 gap-2 pt-1 text-[11.5px]">
          <div className="rounded-xl px-2.5 py-2" style={{ background: 'var(--surface)' }}>
            <div className="flex items-center gap-1.5" style={{ color: 'var(--muted)' }}>
              <span className="w-2 h-2 rounded-full" style={{ background: '#3b82f6' }} />
              <span>규칙</span>
            </div>
            <div className="num font-semibold mt-0.5">{fmtKo(ruleTokens)} tok</div>
          </div>
          <div className="rounded-xl px-2.5 py-2" style={{ background: 'var(--surface)' }}>
            <div className="flex items-center gap-1.5" style={{ color: 'var(--muted)' }}>
              <span className="w-2 h-2 rounded-full" style={{ background: '#22c55e' }} />
              <span>스킬 헤더</span>
            </div>
            <div className="num font-semibold mt-0.5">{fmtKo(skillTokens)} tok</div>
          </div>
          <div className="rounded-xl px-2.5 py-2" style={{ background: 'var(--surface)' }}>
            <div className="flex items-center gap-1.5" style={{ color: 'var(--muted)' }}>
              <span className="w-2 h-2 rounded-full" style={{ background: '#9333ea' }} />
              <span>MCP 실측</span>
            </div>
            <div className="num font-semibold mt-0.5">{fmtKo(mcpTokens)} tok</div>
          </div>
        </div>

        <div
          className="rounded-xl px-3 py-2 flex items-start gap-2 text-[11.5px] leading-relaxed"
          style={{
            background: 'color-mix(in srgb, var(--warn) 8%, var(--surface))',
            color: 'var(--fg-soft)',
          }}
        >
          <AlertTriangle size={13} style={{ color: 'var(--warn)' }} className="shrink-0 mt-0.5" />
          <span>
            <strong>agy CLI 제어 경계</strong>: 플러그인 번들({pluginBundles.length}개)과 전역 MCP는{' '}
            <code>agy plugin/mcp enable|disable</code>로 <strong>전역 제어</strong>되며, 개별 스킬·워크스페이스 규칙은 CLI
            제약상 읽기 전용(부모 플러그인 단위로 토글)입니다.
          </span>
        </div>
      </div>

      {/* 필터 바 + 검색 */}
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-1">
          {KIND_TABS.map((t) => {
            const active = kindFilter === t.id;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setKindFilter(t.id)}
                className="px-2.5 py-1 rounded-full text-[11.5px] cursor-pointer transition-colors border"
                style={{
                  background: active ? 'var(--fg)' : 'var(--card)',
                  color: active ? 'var(--bg)' : 'var(--fg-soft)',
                  borderColor: active ? 'var(--fg)' : 'var(--border)',
                  fontWeight: active ? 600 : 400,
                }}
              >
                {t.label}
              </button>
            );
          })}
        </div>

        <div
          className="flex items-center gap-2 px-3 py-1.5 rounded-xl border text-xs"
          style={{ background: 'var(--card)', borderColor: 'var(--border)' }}
        >
          <Search size={13} style={{ color: 'var(--muted)' }} />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="스킬 · 규칙 · MCP · 플러그인 검색..."
            className="flex-1 bg-transparent outline-none text-[12.5px]"
            style={{ color: 'var(--fg)' }}
          />
          {query && (
            <button type="button" onClick={() => setQuery('')} className="cursor-pointer opacity-60 hover:opacity-100">
              ✕
            </button>
          )}
        </div>
      </div>

      {/* 자산 목록 */}
      <div className="space-y-2">
        {filteredAssets.length === 0 ? (
          <div
            className="rounded-xl border px-4 py-8 text-center text-[12px]"
            style={{ background: 'var(--card)', borderColor: 'var(--border)', color: 'var(--muted)' }}
          >
            {projection ? '조건에 일치하는 런타임 자산이 없습니다.' : '활성 에이전트 어댑터(agent-agy)를 찾는 중...'}
          </div>
        ) : (
          filteredAssets.map((asset) => {
            const modeMeta = CONTROL_MODE_META[asset.controlMode] || CONTROL_MODE_META['read-only-cli'];
            const isBusy = busyAssetId === asset.id;
            const basisLabel =
              asset.tokenCost.basis === 'measured-cache'
                ? '실측 캐시'
                : asset.tokenCost.basis === 'unmeasured'
                  ? '미측정'
                  : '파일 추정';

            return (
              <div
                key={asset.id}
                className="rounded-xl border px-3.5 py-2.5 transition-opacity"
                style={{
                  background: 'var(--card)',
                  borderColor: 'var(--border)',
                  opacity: asset.enabled ? 1 : 0.62,
                }}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-[13px] font-semibold truncate">{asset.name}</span>
                      <span
                        className="px-1.5 py-0.5 rounded text-[10px] font-medium"
                        style={{ background: 'var(--surface)', color: 'var(--muted)' }}
                      >
                        {SCOPE_LABELS[asset.scope]}
                        {asset.parentPluginName ? `: ${asset.parentPluginName}` : ''}
                      </span>
                      <span
                        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium"
                        style={{ background: modeMeta.bg, color: modeMeta.color }}
                        title={asset.controlReason || modeMeta.label}
                      >
                        {modeMeta.toggleable ? <Globe size={9} /> : <Lock size={9} />}
                        <span>{modeMeta.label}</span>
                      </span>
                      {asset.isSymlink && (
                        <span
                          className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-mono"
                          style={{
                            background: 'color-mix(in srgb, var(--accent) 10%, transparent)',
                            color: 'var(--accent)',
                          }}
                          title={asset.realPath ? `원본: ${asset.realPath}` : '심볼릭 링크'}
                        >
                          <Link2 size={9} />
                          <span>symlink</span>
                        </span>
                      )}
                    </div>

                    <div className="text-[11.5px] line-clamp-2 leading-relaxed" style={{ color: 'var(--muted)' }}>
                      {asset.description}
                    </div>

                    <div className="flex flex-wrap items-center gap-2 text-[10.5px] font-mono" style={{ color: 'var(--muted)' }}>
                      <span className="num" style={{ color: 'var(--fg-soft)' }}>
                        {asset.tokenCost.basis === 'unmeasured'
                          ? '토큰 미측정'
                          : `${asset.promptTokens.toLocaleString()} tok (${basisLabel})`}
                      </span>
                      {asset.lazyBodyTokens ? (
                        <span>· 본문 {fmtKo(asset.lazyBodyTokens)} tok (호출 시 로드)</span>
                      ) : null}
                      <span className="truncate max-w-[280px]" title={asset.realPath || asset.sourcePath}>
                        · {asset.sourcePath.replace(/^\/Users\/[^/]+/, '~')}
                      </span>
                    </div>
                  </div>

                  {/* 정직한 토글 컨트롤 */}
                  <div className="shrink-0 pt-0.5">
                    {modeMeta.toggleable ? (
                      <button
                        type="button"
                        role="switch"
                        aria-checked={asset.enabled}
                        disabled={isBusy}
                        onClick={() => void handleToggle(asset)}
                        className="relative inline-flex h-[22px] w-[38px] items-center rounded-full transition-colors cursor-pointer disabled:opacity-50"
                        style={{
                          background: asset.enabled
                            ? 'var(--accent)'
                            : 'color-mix(in srgb, var(--fg) 18%, transparent)',
                        }}
                        title={asset.controlReason || '전역 ON/OFF 전환'}
                      >
                        <span
                          className="inline-block h-[16px] w-[16px] rounded-full bg-white shadow transition-transform"
                          style={{ transform: asset.enabled ? 'translateX(19px)' : 'translateX(3px)' }}
                        />
                      </button>
                    ) : (
                      <span
                        className="inline-flex items-center px-2 py-0.5 rounded-md text-[10.5px]"
                        style={{ background: 'var(--surface)', color: 'var(--muted)' }}
                        title={asset.controlReason}
                      >
                        {asset.enabled ? '활성' : '비활성'}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};
