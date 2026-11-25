import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  Blocks,
  ChevronDown,
  ChevronUp,
  Columns3,
  Cpu,
  ExternalLink,
  FileCode2,
  FolderPlus,
  History,
  Layers,
  Link2,
  Lock,
  Pause,
  Play,
  Radio,
  RefreshCw,
  RotateCw,
  ScanEye,
  Search,
  ShieldAlert,
  Trash2,
} from 'lucide-react';
import {
  BUILTIN_PLUGIN_IDS,
  getDeskKernelBridge,
  useIntrospectionStore,
  useLayoutStore,
  usePluginConfigStore,
  useSlotRegistry,
  type EventPulseSample,
  type PaneComponentProps,
  type PluginNodeSnapshot,
  type RuntimeAssetControlMode,
  type RuntimeContextAsset,
} from '../../kernel/client';
import { LiveEdgeSvgOverlay, type StaticLinkDef } from './LiveEdgeSvgOverlay';
import { PluginInspectorDrawer, lifecycleVisuals, originLabel } from './PluginInspectorDrawer';
import { usePluginStudioUiStore } from './studioState';

type FilterMode = 'all' | 'active' | 'local' | 'errors';

const Sparkline: React.FC<{ values: number[] }> = ({ values }) => {
  const pts = values.length > 0 ? values : [0, 0, 0, 0];
  const max = Math.max(4, ...pts);
  const w = 64;
  const h = 18;
  const step = pts.length > 1 ? w / (pts.length - 1) : w;
  const d = pts
    .map((v, i) => {
      const x = i * step;
      const y = h - 2 - (Math.min(max, v) / max) * (h - 4);
      return `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(' ');
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="shrink-0">
      <path d={d} fill="none" stroke="var(--accent)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
};

const MiniToggle: React.FC<{
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
  title?: string;
}> = ({ checked, disabled, onChange, title }) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    disabled={disabled}
    title={title}
    onClick={(e) => {
      e.stopPropagation();
      if (!disabled) onChange(!checked);
    }}
    className="relative inline-flex h-[20px] w-[35px] shrink-0 items-center rounded-full transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-default"
    style={{ background: checked ? 'var(--accent)' : 'color-mix(in srgb, var(--fg) 18%, transparent)' }}
  >
    <span
      className="inline-block h-[14px] w-[14px] rounded-full bg-white shadow transition-transform"
      style={{ transform: checked ? 'translateX(18px)' : 'translateX(3px)' }}
    />
  </button>
);

function controlModeBadge(mode: RuntimeAssetControlMode): { label: string; color: string } {
  switch (mode) {
    case 'live-toggle':
      return { label: '즉시 제어', color: 'var(--ok)' };
    case 'next-turn':
      return { label: '다음 턴 반영', color: 'var(--accent)' };
    case 'new-session':
      return { label: '새 세션 반영', color: '#0891b2' };
    case 'global-only':
      return { label: '전역 CLI 제어', color: 'var(--warn)' };
    default:
      return { label: 'CLI 읽기 전용', color: 'var(--muted)' };
  }
}

function fmtTok(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function fmtPulseTime(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
}

export const PluginStudioPane: React.FC<PaneComponentProps> = () => {
  const snapshot = useIntrospectionStore((s) => s.snapshot);
  const loading = useIntrospectionStore((s) => s.loading);
  const xrayActive = useIntrospectionStore((s) => s.xrayActive);
  const toggleXray = useIntrospectionStore((s) => s.toggleXray);
  const acquireLiveSubscription = useIntrospectionStore((s) => s.acquireLiveSubscription);
  const refreshSnapshot = useIntrospectionStore((s) => s.refreshSnapshot);
  const sendCommand = useIntrospectionStore((s) => s.sendCommand);
  const pushToast = useIntrospectionStore((s) => s.pushToast);

  const selectedNodeId = usePluginStudioUiStore((s) => s.selectedNodeId);
  const selectNode = usePluginStudioUiStore((s) => s.selectNode);
  const pingPluginInUi = usePluginStudioUiStore((s) => s.pingPluginInUi);
  const creatorModeActive = usePluginStudioUiStore((s) => s.creatorModeActive);
  const toggleCreatorMode = usePluginStudioUiStore((s) => s.toggleCreatorMode);

  const groups = useLayoutStore((s) => s.groups);
  const paneTypes = useSlotRegistry((s) => s.paneTypes);
  const studioConfig = usePluginConfigStore((s) => s.configsByPlugin[BUILTIN_PLUGIN_IDS.PLUGIN_STUDIO] || {});

  const showEventPulses = studioConfig.showEventPulses !== false;
  const compactBreakpoint = typeof studioConfig.compactBreakpointPx === 'number' ? studioConfig.compactBreakpointPx : 860;
  const defaultTraceOpen = studioConfig.defaultBottomTraceOpen !== false;

  const [query, setQuery] = useState('');
  const [filterMode, setFilterMode] = useState<FilterMode>('all');
  const [paneWidth, setPaneWidth] = useState(1080);
  const [traceOpen, setTraceOpen] = useState(defaultTraceOpen);
  const [tracePaused, setTracePaused] = useState(false);
  const [traceErrorsOnly, setTraceErrorsOnly] = useState(false);
  const [frozenPulses, setFrozenPulses] = useState<EventPulseSample[]>([]);
  const [selectedPulse, setSelectedPulse] = useState<EventPulseSample | null>(null);
  const [assetKindFilter, setAssetKindFilter] = useState<'all' | 'rule' | 'skill' | 'mcp' | 'plugin-bundle'>('all');
  const [pendingToggleConfirm, setPendingToggleConfirm] = useState<{
    node: PluginNodeSnapshot;
    nextEnabled: boolean;
  } | null>(null);
  const [layoutNonce, setLayoutNonce] = useState(0);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const nodeRefs = useRef<Map<string, HTMLElement>>(new Map());

  // Acquire reference-counted Main 10Hz telemetry subscription ONLY while mounted
  useEffect(() => {
    const release = acquireLiveSubscription();
    return () => release();
  }, [acquireLiveSubscription]);

  // Measure actual pane width so Studio auto-switches Wide 3-Tier <-> Compact Stack in split panes
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const measure = () => {
      setPaneWidth(el.clientWidth);
      setLayoutNonce((n) => n + 1);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!selectedNodeId) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        selectNode(null);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selectedNodeId, selectNode]);

  const isCompact = paneWidth < compactBreakpoint;

  const setNodeRef = (id: string) => (el: HTMLElement | null) => {
    if (el) nodeRefs.current.set(id, el);
    else nodeRefs.current.delete(id);
  };

  // Layout live metrics
  const splitCounts = useMemo(() => {
    const grpList = Object.values(groups);
    let totalTabs = 0;
    let hiddenPreserved = 0;
    for (const g of grpList) {
      totalTabs += g.tabs.length;
      for (const t of g.tabs) {
        const def = paneTypes[t.paneType];
        if (def?.keepAlive === 'group' && t.id !== g.activeTabId) {
          hiddenPreserved += 1;
        }
      }
    }
    return { groups: grpList.length, tabs: totalTabs, hiddenPreserved };
  }, [groups, paneTypes]);

  const allPlugins = useMemo(() => {
    if (!snapshot) return [];
    return Object.values(snapshot.plugins).sort((a, b) => {
      if (a.origin === 'local-dev' && b.origin !== 'local-dev') return -1;
      if (b.origin === 'local-dev' && a.origin !== 'local-dev') return 1;
      return a.manifest.name.localeCompare(b.manifest.name);
    });
  }, [snapshot]);

  const qLower = query.trim().toLowerCase();

  const filteredPlugins = useMemo(() => {
    return allPlugins.filter((p) => {
      if (filterMode === 'active' && p.lifecycleState !== 'active') return false;
      if (filterMode === 'local' && p.origin !== 'local-dev') return false;
      if (
        filterMode === 'errors' &&
        p.health.errorCount === 0 &&
        p.lifecycleState !== 'error' &&
        p.lifecycleState !== 'quarantined' &&
        p.lifecycleState !== 'degraded'
      ) {
        return false;
      }
      if (!qLower) return true;
      const hay = [
        p.id,
        p.manifest.name,
        p.manifest.description,
        p.manifest.category,
        ...p.occupiedSlots.map((s) => s.slotId),
      ]
        .join(' ')
        .toLowerCase();
      return hay.includes(qLower);
    });
  }, [allPlugins, filterMode, qLower]);

  const groupedPlugins = useMemo(() => {
    const sections: Array<{ id: string; title: string; items: PluginNodeSnapshot[] }> = [
      { id: 'local-dev', title: '로컬 외부 플러그인 (HMR)', items: [] },
      { id: 'pane', title: '워크스페이스 패인', items: [] },
      { id: 'chat-widget', title: '채팅 위젯 · HUD', items: [] },
      { id: 'system-ux', title: '사이드바 · 시스템 UX', items: [] },
      { id: 'agent-adapter', title: '에이전트 어댑터 (Layer 1 ↔ 2 브리지)', items: [] },
      { id: 'visual-tool', title: '시각화 · 스튜디오', items: [] },
    ];
    const map = new Map(sections.map((s) => [s.id, s]));
    for (const p of filteredPlugins) {
      if (p.origin === 'local-dev') {
        map.get('local-dev')!.items.push(p);
      } else {
        const sec = map.get(p.manifest.category) || map.get('system-ux')!;
        sec.items.push(p);
      }
    }
    return sections.filter((s) => s.items.length > 0);
  }, [filteredPlugins]);

  // Static structural links for SVG overlay (Core -> Plugins, Dependencies, Adapter -> Layer 2)
  const staticLinks = useMemo<StaticLinkDef[]>(() => {
    if (!snapshot) return [];
    const out: StaticLinkDef[] = [];
    for (const p of filteredPlugins) {
      if (p.lifecycleState === 'active' || p.origin === 'local-dev') {
        out.push({ id: `core->${p.id}`, fromId: '__core__', toId: p.id, kind: 'kernel' });
      }
      for (const req of p.requires) {
        const providers = snapshot.serviceBindings[req] || [];
        for (const provId of providers) {
          if (provId !== p.id) {
            out.push({ id: `dep:${provId}->${p.id}`, fromId: provId, toId: p.id, kind: 'dependency' });
          }
        }
      }
    }
    for (const adapterId of Object.keys(snapshot.runtimeAssetsByAdapter)) {
      out.push({
        id: `bridge:${adapterId}->layer2:${adapterId}`,
        fromId: adapterId,
        toId: `layer2:${adapterId}`,
        kind: 'adapter-bridge',
      });
    }
    return out;
  }, [filteredPlugins, snapshot]);

  useEffect(() => {
    setLayoutNonce((n) => n + 1);
  }, [filteredPlugins.length, selectedNodeId, assetKindFilter, isCompact]);

  // Safe toggle handler with Dormant Tab & dependent warnings
  const executeToggle = async (node: PluginNodeSnapshot, nextEnabled: boolean) => {
    setPendingToggleConfirm(null);
    const res = await sendCommand({ type: 'plugin:toggle', pluginId: node.id, enabled: nextEnabled });
    if (res.ok) {
      pushToast(
        nextEnabled
          ? `${node.manifest.name} 활성화됨`
          : `${node.manifest.name} 비활성화됨${
              node.activeOpenTabsCount > 0 ? ` (열린 탭 ${node.activeOpenTabsCount}개 데이터 보존됨)` : ''
            }`,
        'info'
      );
    } else {
      pushToast(res.error || '플러그인 토글 실패', 'error');
    }
  };

  const handleRequestToggle = (node: PluginNodeSnapshot, nextEnabled: boolean) => {
    if (node.locked) return;
    if (
      !nextEnabled &&
      (node.activeOpenTabsCount > 0 ||
        node.hiddenPreservedTabsCount > 0 ||
        (node.impactClass === 'dependency-critical' && node.dependents.length > 0))
    ) {
      setPendingToggleConfirm({ node, nextEnabled });
      return;
    }
    void executeToggle(node, nextEnabled);
  };

  const handleMountLocalDialog = async () => {
    const res = await sendCommand({ type: 'plugin:mount-local-dialog', watch: true });
    if (res.ok) {
      const mountedId = (res.data as { pluginId?: string } | undefined)?.pluginId;
      pushToast(
        mountedId ? `로컬 플러그인 "${mountedId}" 마운트 및 HMR 감시 시작!` : '로컬 플러그인 마운트 완료',
        'info'
      );
      if (mountedId) selectNode(mountedId, 'overview');
    } else if (res.error && !res.error.toLowerCase().includes('cancel')) {
      pushToast(res.error, 'error');
    }
  };

  const handleToggleRuntimeAsset = async (adapterId: string, asset: RuntimeContextAsset) => {
    if (asset.controlMode === 'read-only-cli') return;
    if (asset.controlMode === 'global-only') {
      const ok = window.confirm(
        `"${asset.name}"은(는) 전역 CLI 설정(agy ${asset.kind === 'mcp' ? 'mcp' : 'plugin'})을 변경합니다.\n` +
          `모든 워크스페이스와 새 CLI 세션에 영향을 미칩니다. 계속할까요?`
      );
      if (!ok) return;
    }
    const res = await sendCommand({
      type: 'runtime-asset:toggle',
      adapterPluginId: adapterId,
      assetId: asset.id,
      enabled: !asset.enabled,
      scope: asset.controlMode === 'global-only' ? 'global' : 'workspace',
    });
    if (res.ok) {
      pushToast(`${asset.name} ${!asset.enabled ? '활성화' : '비활성화'} 반영됨`, 'info');
    } else {
      pushToast(res.error || '자산 토글 실패', 'error');
    }
  };

  const handleRevealPath = async (targetPath: string) => {
    try {
      const res = await getDeskKernelBridge()?.rpc.invoke<{ ok: boolean; error?: string }>(
        'plugin-studio:reveal-path',
        { targetPath }
      );
      if (res && !res.ok) pushToast(res.error || '경로를 열 수 없습니다.', 'warn');
    } catch (err) {
      pushToast(String(err), 'error');
    }
  };

  const displayedPulses = useMemo(() => {
    const raw = tracePaused ? frozenPulses : snapshot?.recentPulses || [];
    return raw
      .filter((p) => {
        if (traceErrorsOnly && !p.isError) return false;
        if (selectedNodeId && selectedNodeId !== '__core__') {
          return p.fromNodeId === selectedNodeId || p.toNodeIds.includes(selectedNodeId);
        }
        return true;
      })
      .slice(-80)
      .reverse();
  }, [frozenPulses, selectedNodeId, snapshot?.recentPulses, traceErrorsOnly, tracePaused]);

  const activeCount = allPlugins.filter((p) => p.lifecycleState === 'active').length;
  const errorCount = allPlugins.filter(
    (p) => p.lifecycleState === 'error' || p.lifecycleState === 'quarantined' || p.health.errorCount > 0
  ).length;
  const localCount = allPlugins.filter((p) => p.origin === 'local-dev').length;
  const adapters = snapshot ? Object.values(snapshot.runtimeAssetsByAdapter) : [];

  return (
    <div
      ref={rootRef}
      className="flex-1 min-h-0 flex flex-col overflow-hidden relative select-none"
      style={{ background: 'var(--bg)', color: 'var(--fg)' }}
    >
      {/* Safe Mode Recovery Top Banner */}
      {snapshot?.bootMode === 'safe-mode' && (
        <div
          className="shrink-0 px-4 py-2 border-b flex flex-wrap items-center justify-between gap-2 text-[12px]"
          style={{
            background: 'color-mix(in srgb, var(--warn) 14%, var(--card))',
            borderColor: 'color-mix(in srgb, var(--warn) 45%, var(--border))',
          }}
        >
          <div className="flex items-center gap-2 min-w-0">
            <ShieldAlert size={15} style={{ color: 'var(--warn)' }} className="shrink-0" />
            <span className="font-medium truncate">
              안전 모드(Safe Mode)로 실행 중
              {snapshot.safeModeContext?.suspectedPluginId
                ? ` · 직전 크래시 의심: ${snapshot.safeModeContext.suspectedPluginId}`
                : ' · 외부 로컬 플러그인이 일시 격리되었습니다.'}
            </span>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            {snapshot.safeModeContext?.suspectedPluginId && (
              <button
                type="button"
                onClick={async () => {
                  const id = snapshot.safeModeContext?.suspectedPluginId;
                  if (id) await sendCommand({ type: 'plugin:toggle', pluginId: id, enabled: false });
                  await sendCommand({ type: 'system:set-safe-mode', enabled: false });
                  pushToast('의심 플러그인을 비활성화하고 다음 부팅 시 정상 모드로 복귀하도록 설정했습니다.', 'info');
                }}
                className="px-2.5 py-1 rounded-lg text-[11.5px] font-medium cursor-pointer"
                style={{ background: 'var(--warn)', color: '#fff' }}
              >
                의심 플러그인 끄고 정상 모드 복귀
              </button>
            )}
            <button
              type="button"
              onClick={async () => {
                await sendCommand({ type: 'system:set-safe-mode', enabled: false });
                pushToast('안전 모드 플래그를 해제했습니다. 앱을 재시작하면 일반 모드로 부팅합니다.', 'info');
              }}
              className="px-2.5 py-1 rounded-lg border text-[11.5px] cursor-pointer hover:bg-[var(--card)]"
              style={{ background: 'var(--bg)', borderColor: 'var(--border)' }}
            >
              안전 모드 해제
            </button>
          </div>
        </div>
      )}

      {/* Top Control Toolbar */}
      <div
        className="shrink-0 px-3.5 py-2.5 border-b flex flex-wrap items-center justify-between gap-2"
        style={{ background: 'var(--sidebar)', borderColor: 'var(--border)' }}
      >
        {/* Left: Title + Live Pill + Search */}
        <div className="flex items-center gap-2.5 min-w-0 flex-1">
          <div className="flex items-center gap-1.5 shrink-0">
            <Blocks size={16} style={{ color: 'var(--accent)' }} />
            <span className="text-[13.5px] font-semibold tracking-tight">플러그인 스튜디오</span>
          </div>

          <div
            className="hidden sm:inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border text-[11px] font-mono num shrink-0"
            style={{ background: 'var(--card)', borderColor: 'var(--border)', color: 'var(--fg-soft)' }}
            title="실시간 DeskEventBus 트래픽 (10Hz Live Projection)"
          >
            <span className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ background: 'var(--ok)' }} />
            <span>{snapshot ? `${snapshot.kernel.busEventsPerSec.toFixed(1)} evt/s` : '연결 중'}</span>
            {snapshot && <Sparkline values={snapshot.kernel.busSparkline} />}
          </div>

          <div
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-[12px] flex-1 max-w-[240px] min-w-[120px]"
            style={{ background: 'var(--card)', borderColor: 'var(--border)' }}
          >
            <Search size={12} style={{ color: 'var(--muted)' }} className="shrink-0" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="플러그인 · 슬롯 · 스킬 검색..."
              className="w-full bg-transparent outline-none text-[12px]"
              style={{ color: 'var(--fg)' }}
            />
          </div>
        </div>

        {/* Right: Primary Controls */}
        <div className="flex items-center gap-1.5 flex-wrap shrink-0">
          <button
            type="button"
            onClick={() => void handleMountLocalDialog()}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[12px] font-medium cursor-pointer transition-opacity hover:opacity-90"
            style={{ background: 'var(--accent)', color: '#fff' }}
            title="로컬 폴더의 desk-plugin.json을 앱 재빌드 없이 마운트하고 HMR 감시 시작"
          >
            <FolderPlus size={13} />
            <span>+ 로컬 플러그인 마운트</span>
          </button>

          <button
            type="button"
            onClick={() => toggleCreatorMode()}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border text-[12px] font-medium cursor-pointer transition-colors hover:bg-[var(--surface-active)]"
            style={{
              background: creatorModeActive ? 'color-mix(in srgb, #9333ea 14%, var(--card))' : 'var(--card)',
              borderColor: creatorModeActive ? '#9333ea' : 'var(--border)',
              color: creatorModeActive ? '#9333ea' : 'var(--fg-soft)',
            }}
            title="1클릭 크리에이터 3분할: [좌: 채팅] + [우상: 스튜디오] + [우하: 미리보기] (⌘⇧K)"
          >
            <Columns3 size={13} />
            <span>{creatorModeActive ? '3분할 복귀' : '크리에이터 3분할'}</span>
          </button>

          <button
            type="button"
            onClick={toggleXray}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border text-[12px] font-medium cursor-pointer transition-colors hover:bg-[var(--surface-active)]"
            style={{
              background: xrayActive ? 'color-mix(in srgb, var(--accent) 16%, var(--card))' : 'var(--card)',
              borderColor: xrayActive ? 'var(--accent)' : 'var(--border)',
              color: xrayActive ? 'var(--accent)' : 'var(--fg-soft)',
            }}
            title="UI X-Ray 투시 오버레이 토글 (⌘⇧X)"
          >
            <ScanEye size={13} />
            <span>X-Ray</span>
          </button>

          <button
            type="button"
            onClick={() => void sendCommand({ type: 'plugin:open-config-file' })}
            className="inline-flex items-center gap-1 px-2 py-1 rounded-lg border text-[12px] cursor-pointer hover:bg-[var(--surface-active)]"
            style={{ background: 'var(--card)', borderColor: 'var(--border)', color: 'var(--fg-soft)' }}
            title={snapshot?.profile.configFilePath || 'agy-desk-plugins.json 열기'}
          >
            <FileCode2 size={13} />
            {!isCompact && <span>설정 파일</span>}
          </button>

          <button
            type="button"
            onClick={() => void refreshSnapshot()}
            className="p-1.5 rounded-lg border cursor-pointer hover:bg-[var(--surface-active)]"
            style={{ background: 'var(--card)', borderColor: 'var(--border)', color: 'var(--muted)' }}
            title="스냅샷 새로고침"
          >
            <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {/* Filter & Summary Subbar */}
      <div
        className="shrink-0 px-3.5 py-1.5 border-b flex items-center justify-between gap-2 text-[11.5px]"
        style={{ background: 'var(--bg)', borderColor: 'var(--border)' }}
      >
        <div className="flex items-center gap-1">
          {(
            [
              { id: 'all', label: `전체 ${allPlugins.length}` },
              { id: 'active', label: `활성 ${activeCount}` },
              { id: 'local', label: `LOCAL ${localCount}` },
              { id: 'errors', label: `오류 ${errorCount}` },
            ] as Array<{ id: FilterMode; label: string }>
          ).map((f) => {
            const active = filterMode === f.id;
            return (
              <button
                key={f.id}
                type="button"
                onClick={() => setFilterMode(f.id)}
                className="px-2 py-0.5 rounded-md cursor-pointer transition-colors"
                style={{
                  background: active ? 'var(--surface-active)' : 'transparent',
                  color:
                    f.id === 'errors' && errorCount > 0
                      ? 'var(--danger)'
                      : active
                        ? 'var(--fg)'
                        : 'var(--muted)',
                  fontWeight: active ? 600 : 400,
                }}
              >
                {f.label}
              </button>
            );
          })}
        </div>
        <div className="hidden md:flex items-center gap-3 font-mono text-[11px] num" style={{ color: 'var(--muted)' }}>
          <span>분할 {splitCounts.groups} · 탭 {splitCounts.tabs}</span>
          {splitCounts.hiddenPreserved > 0 && <span>👻 숨김 보존 {splitCounts.hiddenPreserved}</span>}
          {snapshot && <span>RSS {snapshot.kernel.memoryRssMb}MB</span>}
        </div>
      </div>

      {/* Inline Stateful/Dependency Confirmation Bar */}
      {pendingToggleConfirm && (
        <div
          className="shrink-0 px-4 py-2.5 border-b flex flex-wrap items-center justify-between gap-2 text-[12px]"
          style={{
            background: 'color-mix(in srgb, var(--warn) 10%, var(--card))',
            borderColor: 'color-mix(in srgb, var(--warn) 40%, var(--border))',
          }}
        >
          <div className="flex items-center gap-2 min-w-0">
            <AlertTriangle size={14} style={{ color: 'var(--warn)' }} className="shrink-0" />
            <div className="leading-snug">
              <strong>{pendingToggleConfirm.node.manifest.name}</strong>을(를) 비활성화할까요?
              {pendingToggleConfirm.node.activeOpenTabsCount > 0 && (
                <span className="ml-1" style={{ color: 'var(--fg-soft)' }}>
                  열린 탭 {pendingToggleConfirm.node.activeOpenTabsCount}개
                  {pendingToggleConfirm.node.hiddenPreservedTabsCount > 0
                    ? `(숨김 보존 ${pendingToggleConfirm.node.hiddenPreservedTabsCount}개 포함)`
                    : ''}
                  는 삭제되지 않고 <strong>Dormant Placeholder</strong>로 안전 보존됩니다.
                </span>
              )}
              {pendingToggleConfirm.node.dependents.length > 0 && (
                <span className="ml-1" style={{ color: 'var(--warn)' }}>
                  의존 플러그인({pendingToggleConfirm.node.dependents.join(', ')})도 함께 일시 중지됩니다.
                </span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              onClick={() => void executeToggle(pendingToggleConfirm.node, pendingToggleConfirm.nextEnabled)}
              className="px-2.5 py-1 rounded-lg text-[11.5px] font-medium cursor-pointer"
              style={{ background: 'var(--warn)', color: '#fff' }}
            >
              안전하게 비활성화
            </button>
            <button
              type="button"
              onClick={() => setPendingToggleConfirm(null)}
              className="px-2.5 py-1 rounded-lg border text-[11.5px] cursor-pointer hover:bg-[var(--surface)]"
              style={{ background: 'var(--card)', borderColor: 'var(--border)', color: 'var(--muted)' }}
            >
              취소
            </button>
          </div>
        </div>
      )}

      {/* Main Content Area: Live 3-Tier Board + Right Inspector */}
      <div className="flex-1 min-h-0 flex relative overflow-hidden">
        {!snapshot ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-2 p-6 text-center">
            <Blocks size={24} className="animate-pulse" style={{ color: 'var(--accent)' }} />
            <div className="text-[13.5px] font-semibold">라이브 런타임 레지스트리에 연결하는 중…</div>
            <div className="text-[12px] max-w-sm" style={{ color: 'var(--muted)' }}>
              Electron Main의 IntrospectionHub 스냅샷을 구독하면 Core · App Plugins · Runtime Assets가 실시간 투영됩니다.
            </div>
          </div>
        ) : (
          <>
            {/* Scrollable Architecture Canvas (빈 땅 클릭 시 선택 해제) */}
            <div
              ref={canvasRef}
              onClick={(e) => {
                if (!selectedNodeId) return;
                const target = e.target as HTMLElement | null;
                if (target?.closest('[data-studio-selectable="true"], button, input, select, textarea, a')) return;
                selectNode(null);
              }}
              className="flex-1 min-w-0 min-h-0 overflow-auto scroll-thin p-4 relative"
            >
              {!isCompact && (
                <LiveEdgeSvgOverlay
                  containerRef={canvasRef}
                  nodeRefs={nodeRefs}
                  staticLinks={staticLinks}
                  eventEdges={snapshot.eventEdges}
                  selectedNodeId={selectedNodeId}
                  enabled={showEventPulses}
                  layoutNonce={layoutNonce}
                />
              )}

              <div
                className={
                  isCompact
                    ? 'flex flex-col gap-4 relative z-10'
                    : 'grid grid-cols-[215px_minmax(320px,1.25fr)_minmax(260px,0.95fr)] gap-6 items-start relative z-10'
                }
              >
                {/* ========================================================= */}
                {/* TIER 1: ZERO-FEATURE CORE KERNEL                          */}
                {/* ========================================================= */}
                <section className="space-y-2.5">
                  <div className="flex items-center justify-between px-1">
                    <span className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--muted)' }}>
                      Tier 1 · Core Kernel
                    </span>
                    <Lock size={11} style={{ color: 'var(--muted)' }} />
                  </div>

                  <div
                    ref={setNodeRef('__core__')}
                    data-studio-selectable="true"
                    onClick={(e) => {
                      e.stopPropagation();
                      selectNode(selectedNodeId === '__core__' ? null : '__core__', 'overview');
                    }}
                    className="rounded-2xl border p-3.5 space-y-3 cursor-pointer transition-all"
                    style={{
                      background: 'var(--card)',
                      borderColor: selectedNodeId === '__core__' ? 'var(--accent)' : 'var(--border-strong)',
                      boxShadow: selectedNodeId === '__core__' ? '0 0 0 1px var(--accent)' : 'var(--shadow-sm)',
                    }}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <span
                          className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0"
                          style={{ background: 'var(--surface)', color: 'var(--fg)' }}
                        >
                          <Cpu size={14} />
                        </span>
                        <div className="min-w-0">
                          <div className="text-[13px] font-semibold truncate">agy-desk Core</div>
                          <div className="text-[10.5px] font-mono" style={{ color: 'var(--muted)' }}>
                            Zero-Feature v{snapshot.kernel.kernelApiVersion}
                          </div>
                        </div>
                      </div>
                      <span
                        className="px-1.5 py-0.5 rounded text-[10px] font-mono"
                        style={{ background: 'color-mix(in srgb, var(--ok) 14%, transparent)', color: 'var(--ok)' }}
                      >
                        OK
                      </span>
                    </div>

                    <div className="space-y-1.5 text-[11.5px]">
                      <div
                        className="rounded-xl border px-2.5 py-2 flex items-center justify-between"
                        style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}
                      >
                        <span style={{ color: 'var(--fg-soft)' }}>분할 트리 엔진</span>
                        <span className="font-mono num text-[11px]" style={{ color: 'var(--muted)' }}>
                          {splitCounts.groups}그룹 · {splitCounts.tabs}탭
                        </span>
                      </div>
                      <div
                        className="rounded-xl border px-2.5 py-2 flex items-center justify-between"
                        style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}
                      >
                        <span style={{ color: 'var(--fg-soft)' }}>슬롯 레지스트리</span>
                        <span className="font-mono num text-[11px]" style={{ color: 'var(--accent)' }}>
                          {snapshot.kernel.occupiedSlotsCount}/{snapshot.kernel.totalSlotsCount} 점유
                        </span>
                      </div>
                      <div
                        className="rounded-xl border px-2.5 py-2 flex items-center justify-between"
                        style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}
                      >
                        <span style={{ color: 'var(--fg-soft)' }}>이벤트 버스</span>
                        <span className="font-mono num text-[11px]" style={{ color: 'var(--fg)' }}>
                          {snapshot.kernel.busEventsPerSec.toFixed(1)} e/s
                        </span>
                      </div>
                      <div
                        className="rounded-xl border px-2.5 py-2 flex items-center justify-between"
                        style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}
                      >
                        <span style={{ color: 'var(--fg-soft)' }}>로컬 로더 · 패치</span>
                        <span className="font-mono num text-[11px]" style={{ color: 'var(--muted)' }}>
                          {snapshot.profile.mountCount} 마운트
                        </span>
                      </div>
                    </div>
                  </div>
                </section>

                {/* ========================================================= */}
                {/* TIER 2: LAYER 1 APP PLUGINS (BUILTIN + LOCAL DEV HMR)     */}
                {/* ========================================================= */}
                <section className="space-y-3">
                  <div className="flex items-center justify-between px-1">
                    <span className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--muted)' }}>
                      Tier 2 · App Plugins ({filteredPlugins.length})
                    </span>
                    <span className="text-[10.5px]" style={{ color: 'var(--muted)' }}>
                      클릭하여 인스펙터 열기
                    </span>
                  </div>

                  {groupedPlugins.length === 0 ? (
                    <div
                      className="rounded-2xl border p-6 text-center text-[12px]"
                      style={{ background: 'var(--card)', borderColor: 'var(--border)', color: 'var(--muted)' }}
                    >
                      조건과 일치하는 플러그인이 없습니다.
                    </div>
                  ) : (
                    groupedPlugins.map((sec) => (
                      <div key={sec.id} className="space-y-1.5">
                        <div className="px-1 text-[11px] font-semibold" style={{ color: 'var(--muted)' }}>
                          {sec.title}
                        </div>
                        <div className="space-y-2">
                          {sec.items.map((node) => {
                            const vis = lifecycleVisuals(node.lifecycleState);
                            const orig = originLabel(node.origin);
                            const isSelected = selectedNodeId === node.id;
                            const isEnabled = node.enabledInConfig && node.lifecycleState !== 'disabled';
                            const isLocal = node.origin === 'local-dev';
                            const hasError =
                              node.lifecycleState === 'error' ||
                              node.lifecycleState === 'quarantined' ||
                              node.health.errorCount > 0;

                            return (
                              <div
                                key={node.id}
                                ref={setNodeRef(node.id)}
                                data-studio-selectable="true"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  selectNode(isSelected ? null : node.id);
                                }}
                                onMouseEnter={() => {
                                  if (node.occupiedSlots.length > 0) pingPluginInUi(node.id, null);
                                }}
                                onMouseLeave={() => pingPluginInUi(null, null)}
                                className="rounded-xl border p-3 cursor-pointer transition-all hover:border-[var(--border-strong)]"
                                style={{
                                  background: 'var(--card)',
                                  borderStyle: isLocal ? 'dashed' : 'solid',
                                  borderColor: isSelected
                                    ? 'var(--accent)'
                                    : hasError
                                      ? 'color-mix(in srgb, var(--danger) 55%, var(--border))'
                                      : isLocal
                                        ? 'color-mix(in srgb, #9333ea 50%, var(--border))'
                                        : 'var(--border)',
                                  boxShadow: isSelected ? '0 0 0 1px var(--accent)' : 'var(--shadow-sm)',
                                  opacity: node.lifecycleState === 'disabled' ? 0.68 : 1,
                                }}
                              >
                                <div className="flex items-start justify-between gap-2">
                                  <div className="min-w-0 flex-1">
                                    <div className="flex items-center gap-1.5 flex-wrap">
                                      <span
                                        className={`w-2 h-2 rounded-full shrink-0 ${vis.pulse ? 'animate-pulse' : ''}`}
                                        style={{ background: vis.color }}
                                        title={vis.label}
                                      />
                                      <span className="text-[12.5px] font-semibold truncate">
                                        {node.manifest.name}
                                      </span>
                                      <span
                                        className="px-1 py-0.2 rounded text-[9.5px] font-mono font-semibold"
                                        style={{
                                          background: `color-mix(in srgb, ${orig.color} 12%, transparent)`,
                                          color: orig.color,
                                        }}
                                      >
                                        {orig.text}
                                      </span>
                                      {node.watchActive && (
                                        <span
                                          className="px-1 py-0.2 rounded text-[9.5px] font-mono"
                                          style={{
                                            background: 'color-mix(in srgb, var(--ok) 14%, transparent)',
                                            color: 'var(--ok)',
                                          }}
                                        >
                                          HMR
                                        </span>
                                      )}
                                    </div>
                                    <div className="text-[11px] font-mono truncate mt-0.5" style={{ color: 'var(--muted)' }}>
                                      {node.id}
                                      {node.health.activationMs != null ? ` · ${node.health.activationMs}ms` : ''}
                                      {node.activeOpenTabsCount > 0 ? ` · 탭 ${node.activeOpenTabsCount}` : ''}
                                      {node.hiddenPreservedTabsCount > 0 ? ` · 👻${node.hiddenPreservedTabsCount}` : ''}
                                    </div>
                                  </div>

                                  <div className="flex items-center gap-1.5 shrink-0">
                                    {isLocal && (
                                      <>
                                        <button
                                          type="button"
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            void sendCommand({ type: 'plugin:reload', pluginId: node.id });
                                          }}
                                          className="p-1 rounded-md border cursor-pointer hover:bg-[var(--surface)]"
                                          style={{ borderColor: 'var(--border)', color: 'var(--fg-soft)' }}
                                          title="핫리로드"
                                        >
                                          <RotateCw size={11} />
                                        </button>
                                        {node.hasLastGoodVersion && (
                                          <button
                                            type="button"
                                            onClick={(e) => {
                                              e.stopPropagation();
                                              void sendCommand({ type: 'plugin:rollback', pluginId: node.id });
                                            }}
                                            className="p-1 rounded-md border cursor-pointer hover:bg-[var(--surface)]"
                                            style={{ borderColor: 'var(--warn)', color: 'var(--warn)' }}
                                            title="이전 정상 버전 롤백"
                                          >
                                            <History size={11} />
                                          </button>
                                        )}
                                        <button
                                          type="button"
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            void sendCommand({ type: 'plugin:unmount-local', pluginId: node.id });
                                          }}
                                          className="p-1 rounded-md border cursor-pointer hover:bg-[var(--surface)]"
                                          style={{ borderColor: 'var(--border)', color: 'var(--danger)' }}
                                          title="로컬 플러그인 언마운트"
                                        >
                                          <Trash2 size={11} />
                                        </button>
                                      </>
                                    )}

                                    <MiniToggle
                                      checked={isEnabled}
                                      disabled={node.locked}
                                      onChange={(next) => handleRequestToggle(node, next)}
                                      title={node.locked ? '코어 필수 플러그인' : isEnabled ? '비활성화' : '활성화'}
                                    />
                                  </div>
                                </div>

                                {/* Slot Chips & Error Pill */}
                                {(node.occupiedSlots.length > 0 || hasError || node.lifecycleState === 'suspended-dep') && (
                                  <div className="flex items-center flex-wrap gap-1 mt-2">
                                    {node.occupiedSlots.slice(0, 4).map((s) => (
                                      <span
                                        key={`${s.slotId}:${s.contributionId}`}
                                        className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-md text-[10px] font-mono"
                                        style={{ background: 'var(--surface)', color: 'var(--muted)' }}
                                      >
                                        <Layers size={9} /> {s.slotId}
                                      </span>
                                    ))}
                                    {node.occupiedSlots.length > 4 && (
                                      <span className="text-[10px] font-mono" style={{ color: 'var(--muted)' }}>
                                        +{node.occupiedSlots.length - 4}
                                      </span>
                                    )}
                                    {node.lifecycleState === 'suspended-dep' && (
                                      <span
                                        className="px-1.5 py-0.5 rounded-md text-[10px] font-medium"
                                        style={{
                                          background: 'color-mix(in srgb, var(--warn) 14%, transparent)',
                                          color: 'var(--warn)',
                                        }}
                                      >
                                        의존 일시중지
                                      </span>
                                    )}
                                    {hasError && (
                                      <span
                                        className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-md text-[10px] font-medium"
                                        style={{
                                          background: 'color-mix(in srgb, var(--danger) 14%, transparent)',
                                          color: 'var(--danger)',
                                        }}
                                      >
                                        <AlertTriangle size={9} />
                                        {node.lifecycleState === 'quarantined'
                                          ? '서킷브레이커 격리'
                                          : `오류 ${Math.max(1, node.health.errorCount)}`}
                                      </span>
                                    )}
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    ))
                  )}
                </section>

                {/* ========================================================= */}
                {/* TIER 3: LAYER 2 RUNTIME CONTEXT ASSETS                    */}
                {/* ========================================================= */}
                <section className="space-y-2.5">
                  <div className="flex items-center justify-between px-1">
                    <span className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--muted)' }}>
                      Tier 3 · Runtime Context Assets
                    </span>
                    <button
                      type="button"
                      onClick={() => void sendCommand({ type: 'runtime-asset:rescan' })}
                      className="inline-flex items-center gap-1 text-[11px] cursor-pointer hover:underline"
                      style={{ color: 'var(--accent)' }}
                      title="스킬·규칙·MCP 디스크 다시 스캔"
                    >
                      <RefreshCw size={10} /> 재스캔
                    </button>
                  </div>

                  {adapters.length === 0 ? (
                    <div
                      className="rounded-2xl border p-4 text-[12px] space-y-1.5"
                      style={{ background: 'var(--card)', borderColor: 'var(--border)' }}
                    >
                      <div className="font-semibold">연결된 에이전트 어댑터 없음</div>
                      <p className="text-[11.5px] leading-relaxed" style={{ color: 'var(--muted)' }}>
                        <code>agent-agy</code> 같은 Layer 1 어댑터 플러그인이 <code>RuntimeAssetProvider</code>를
                        등록하면 스킬·규칙·MCP와 실측 토큰 비용이 여기에 실시간 투영됩니다.
                      </p>
                    </div>
                  ) : (
                    adapters.map((proj) => {
                      const budget = Math.max(1, proj.tokenBudgetMax || 20_000);
                      const rulePct = Math.min(100, (proj.totals.ruleTokens / budget) * 100);
                      const skillPct = Math.min(100 - rulePct, (proj.totals.skillTokens / budget) * 100);
                      const mcpPct = Math.min(100 - rulePct - skillPct, (proj.totals.mcpTokens / budget) * 100);
                      const totalTok = proj.totals.ruleTokens + proj.totals.skillTokens + proj.totals.mcpTokens;

                      const filteredAssets = proj.assets.filter((a) => {
                        if (assetKindFilter !== 'all' && a.kind !== assetKindFilter) return false;
                        if (!qLower) return true;
                        return `${a.name} ${a.description} ${a.parentPluginName || ''} ${a.kind}`
                          .toLowerCase()
                          .includes(qLower);
                      });

                      return (
                        <div
                          key={proj.adapterPluginId}
                          ref={setNodeRef(`layer2:${proj.adapterPluginId}`)}
                          className="rounded-2xl border p-3.5 space-y-3"
                          style={{
                            background: 'var(--card)',
                            borderColor: 'color-mix(in srgb, #9333ea 35%, var(--border))',
                            boxShadow: 'var(--shadow-sm)',
                          }}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <div className="min-w-0">
                              <div className="text-[12.5px] font-semibold truncate">{proj.adapterLabel}</div>
                              <div className="text-[10.5px] font-mono" style={{ color: 'var(--muted)' }}>
                                via {proj.adapterPluginId} · 자산 {proj.assets.length}개
                              </div>
                            </div>
                            <span
                              className="text-[11px] font-mono num font-semibold shrink-0"
                              style={{ color: totalTok > budget * 0.8 ? 'var(--warn)' : 'var(--fg-soft)' }}
                            >
                              {fmtTok(totalTok)} / {fmtTok(budget)} tok
                            </span>
                          </div>

                          {/* Stacked Context Token Budget Bar */}
                          <div className="space-y-1.5">
                            <div className="h-2 rounded-full overflow-hidden flex" style={{ background: 'var(--surface)' }}>
                              <div
                                className="h-full transition-all"
                                style={{ width: `${rulePct}%`, background: '#3b82f6' }}
                                title={`규칙 ${proj.totals.ruleTokens} tok`}
                              />
                              <div
                                className="h-full transition-all"
                                style={{ width: `${skillPct}%`, background: '#22c55e' }}
                                title={`스킬 ${proj.totals.skillTokens} tok`}
                              />
                              <div
                                className="h-full transition-all"
                                style={{ width: `${mcpPct}%`, background: '#9333ea' }}
                                title={`MCP ${proj.totals.mcpTokens} tok`}
                              />
                            </div>
                            <div className="flex items-center justify-between text-[10.5px] font-mono num" style={{ color: 'var(--muted)' }}>
                              <span className="flex items-center gap-1">
                                <span className="w-2 h-2 rounded-full" style={{ background: '#3b82f6' }} />
                                규칙 {fmtTok(proj.totals.ruleTokens)}
                              </span>
                              <span className="flex items-center gap-1">
                                <span className="w-2 h-2 rounded-full" style={{ background: '#22c55e' }} />
                                스킬 {fmtTok(proj.totals.skillTokens)}
                              </span>
                              <span className="flex items-center gap-1">
                                <span className="w-2 h-2 rounded-full" style={{ background: '#9333ea' }} />
                                MCP {fmtTok(proj.totals.mcpTokens)}
                              </span>
                            </div>
                          </div>

                          {/* Kind Filter Pills */}
                          <div className="flex items-center gap-1 flex-wrap text-[10.5px]">
                            {(
                              [
                                ['all', '전체'],
                                ['plugin-bundle', '플러그인'],
                                ['rule', '규칙'],
                                ['skill', '스킬'],
                                ['mcp', 'MCP'],
                              ] as const
                            ).map(([k, lbl]) => (
                              <button
                                key={k}
                                type="button"
                                onClick={() => setAssetKindFilter(k)}
                                className="px-2 py-0.5 rounded-md cursor-pointer"
                                style={{
                                  background: assetKindFilter === k ? 'var(--surface-active)' : 'var(--surface)',
                                  color: assetKindFilter === k ? 'var(--fg)' : 'var(--muted)',
                                  fontWeight: assetKindFilter === k ? 600 : 400,
                                }}
                              >
                                {lbl}
                              </button>
                            ))}
                          </div>

                          {/* Asset Rows */}
                          <div className="space-y-1.5 max-h-[420px] overflow-y-auto scroll-thin pr-0.5">
                            {filteredAssets.length === 0 ? (
                              <div className="text-[11.5px] py-3 text-center" style={{ color: 'var(--muted)' }}>
                                표시할 런타임 자산이 없습니다.
                              </div>
                            ) : (
                              filteredAssets.map((asset) => {
                                const badge = controlModeBadge(asset.controlMode);
                                const canToggle = asset.controlMode !== 'read-only-cli';
                                return (
                                  <div
                                    key={asset.id}
                                    className="rounded-xl border px-2.5 py-2 space-y-1"
                                    style={{
                                      background: 'var(--bg)',
                                      borderColor: 'var(--border)',
                                      opacity: asset.enabled ? 1 : 0.62,
                                    }}
                                  >
                                    <div className="flex items-center justify-between gap-2">
                                      <div className="min-w-0 flex items-center gap-1.5">
                                        <span className="text-[12px] font-medium truncate" title={asset.name}>
                                          {asset.name}
                                        </span>
                                        {asset.isSymlink && (
                                          <span
                                            className="inline-flex items-center gap-0.5 px-1 rounded text-[9.5px] font-mono shrink-0"
                                            style={{ background: 'var(--surface)', color: 'var(--muted)' }}
                                            title={`심볼릭 링크 → ${asset.realPath || ''}`}
                                          >
                                            <Link2 size={9} /> sym
                                          </span>
                                        )}
                                      </div>

                                      <div className="flex items-center gap-1.5 shrink-0">
                                        <span className="text-[10.5px] font-mono num" style={{ color: 'var(--fg-soft)' }}>
                                          {fmtTok(asset.promptTokens)}t
                                        </span>
                                        {canToggle ? (
                                          <MiniToggle
                                            checked={asset.enabled}
                                            onChange={() => void handleToggleRuntimeAsset(proj.adapterPluginId, asset)}
                                            title={asset.controlReason || badge.label}
                                          />
                                        ) : (
                                          <Lock size={11} style={{ color: 'var(--muted)' }} />
                                        )}
                                      </div>
                                    </div>

                                    <div className="flex items-center justify-between gap-1 text-[10px]">
                                      <div className="flex items-center gap-1 min-w-0">
                                        <span
                                          className="px-1.5 py-0.2 rounded font-medium shrink-0"
                                          style={{
                                            background: `color-mix(in srgb, ${badge.color} 13%, transparent)`,
                                            color: badge.color,
                                          }}
                                          title={asset.controlReason}
                                        >
                                          {badge.label}
                                        </span>
                                        <span className="truncate font-mono" style={{ color: 'var(--muted)' }}>
                                          {asset.kind} · {asset.scope}
                                        </span>
                                      </div>
                                      {asset.sourcePath && (
                                        <button
                                          type="button"
                                          onClick={() => void handleRevealPath(asset.sourcePath)}
                                          className="p-0.5 rounded hover:bg-[var(--surface)] cursor-pointer shrink-0"
                                          style={{ color: 'var(--muted)' }}
                                          title={`Finder에서 열기: ${asset.sourcePath}`}
                                        >
                                          <ExternalLink size={10} />
                                        </button>
                                      )}
                                    </div>
                                  </div>
                                );
                              })
                            )}
                          </div>
                        </div>
                      );
                    })
                  )}
                </section>
              </div>
            </div>

            {/* Right Inspector Drawer */}
            {selectedNodeId && (
              <PluginInspectorDrawer
                snapshot={snapshot}
                selectedId={selectedNodeId}
                compactOverlay={isCompact}
                onClose={() => selectNode(null)}
                onRequestToggle={handleRequestToggle}
              />
            )}
          </>
        )}
      </div>

      {/* Collapsible Bottom Live Event Bus Trace Console */}
      <div
        className="shrink-0 border-t flex flex-col"
        style={{ background: 'var(--sidebar)', borderColor: 'var(--border)' }}
      >
        <div
          onClick={() => setTraceOpen((v) => !v)}
          className="h-8 px-3.5 flex items-center justify-between gap-2 cursor-pointer hover:bg-[var(--surface)] transition-colors"
        >
          <div className="flex items-center gap-2 text-[11.5px] min-w-0">
            <Radio size={12} style={{ color: tracePaused ? 'var(--muted)' : 'var(--accent)' }} />
            <span className="font-semibold">LIVE EVENT BUS TRACE</span>
            <span className="font-mono text-[10.5px] num" style={{ color: 'var(--muted)' }}>
              ({displayedPulses.length})
              {selectedNodeId && selectedNodeId !== '__core__' ? ` · 필터: ${selectedNodeId}` : ''}
            </span>
          </div>

          <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              onClick={() => {
                if (!tracePaused) setFrozenPulses(snapshot?.recentPulses || []);
                setTracePaused((v) => !v);
              }}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md border text-[10.5px] cursor-pointer hover:bg-[var(--card)]"
              style={{ background: 'var(--bg)', borderColor: 'var(--border)', color: 'var(--fg-soft)' }}
            >
              {tracePaused ? <Play size={10} /> : <Pause size={10} />}
              <span>{tracePaused ? '재개' : '일시정지'}</span>
            </button>
            <button
              type="button"
              onClick={() => setTraceErrorsOnly((v) => !v)}
              className="px-2 py-0.5 rounded-md border text-[10.5px] cursor-pointer"
              style={{
                background: traceErrorsOnly ? 'color-mix(in srgb, var(--danger) 14%, var(--bg))' : 'var(--bg)',
                borderColor: traceErrorsOnly ? 'var(--danger)' : 'var(--border)',
                color: traceErrorsOnly ? 'var(--danger)' : 'var(--muted)',
              }}
            >
              에러만
            </button>
            <button
              type="button"
              onClick={() => setTraceOpen((v) => !v)}
              className="p-0.5 rounded cursor-pointer"
              style={{ color: 'var(--muted)' }}
            >
              {traceOpen ? <ChevronDown size={13} /> : <ChevronUp size={13} />}
            </button>
          </div>
        </div>

        {traceOpen && (
          <div
            className="h-[132px] border-t flex min-h-0"
            style={{ background: 'var(--bg)', borderColor: 'var(--border)' }}
          >
            <div className="flex-1 min-w-0 overflow-y-auto scroll-thin divide-y font-mono text-[11px]" style={{ borderColor: 'var(--border)' }}>
              {displayedPulses.length === 0 ? (
                <div className="h-full flex items-center justify-center gap-1.5 text-[11.5px] font-sans" style={{ color: 'var(--muted)' }}>
                  <Activity size={13} />
                  <span>실시간 이벤트 대기 중… (채팅·터미널·플러그인 토글 시 펄스가 표시됩니다)</span>
                </div>
              ) : (
                displayedPulses.map((p) => (
                  <div
                    key={p.id}
                    onClick={() => setSelectedPulse(selectedPulse?.id === p.id ? null : p)}
                    className="px-3.5 py-1 flex items-center gap-2.5 cursor-pointer hover:bg-[var(--surface)]"
                    style={{
                      background: selectedPulse?.id === p.id ? 'var(--surface-active)' : undefined,
                      borderColor: 'var(--border)',
                    }}
                  >
                    <span className="shrink-0 num text-[10px]" style={{ color: 'var(--muted)' }}>
                      {fmtPulseTime(p.timestamp)}
                    </span>
                    <span className="shrink-0 truncate max-w-[160px]" style={{ color: 'var(--fg-soft)' }}>
                      {p.fromNodeId} → {p.toNodeIds[0] || '*'}
                    </span>
                    <span
                      className="px-1.5 py-0.2 rounded text-[10px] shrink-0"
                      style={{
                        background: p.isError
                          ? 'color-mix(in srgb, var(--danger) 14%, transparent)'
                          : 'color-mix(in srgb, var(--accent) 12%, transparent)',
                        color: p.isError ? 'var(--danger)' : 'var(--accent)',
                      }}
                    >
                      {p.channel}
                      {p.coalescedCount > 1 ? ` ×${p.coalescedCount}` : ''}
                    </span>
                    <span className="truncate flex-1" style={{ color: 'var(--muted)' }}>
                      {p.summary}
                    </span>
                  </div>
                ))
              )}
            </div>

            {selectedPulse && selectedPulse.payloadPreview && (
              <div
                className="w-[280px] shrink-0 border-l p-2 overflow-auto scroll-thin text-[10.5px] font-mono"
                style={{ background: 'var(--sidebar)', borderColor: 'var(--border)' }}
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="font-semibold" style={{ color: 'var(--accent)' }}>
                    {selectedPulse.channel}
                  </span>
                  <button
                    type="button"
                    onClick={() => setSelectedPulse(null)}
                    className="cursor-pointer"
                    style={{ color: 'var(--muted)' }}
                  >
                    ✕
                  </button>
                </div>
                <pre className="whitespace-pre-wrap break-all" style={{ color: 'var(--fg-soft)' }}>
                  {JSON.stringify(selectedPulse.payloadPreview, null, 2)}
                </pre>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
