import React, { useMemo } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  Copy,
  FolderOpen,
  History,
  Layers,
  Lock,
  Radio,
  RotateCw,
  Settings2,
  ShieldAlert,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import {
  SchemaSettingsForm,
  getDeskKernelBridge,
  useIntrospectionStore,
  useSlotRegistry,
  type EventPulseSample,
  type KernelIntrospectionSnapshot,
  type PluginLifecycleState,
  type PluginNodeSnapshot,
} from '../../kernel/client';
import { usePluginStudioUiStore, type InspectorTabId } from './studioState';

export function lifecycleVisuals(state: PluginLifecycleState): {
  label: string;
  color: string;
  pulse?: boolean;
} {
  switch (state) {
    case 'active':
      return { label: '활성', color: 'var(--ok)' };
    case 'loading':
    case 'activating':
    case 'reloading':
      return { label: state === 'reloading' ? '리로드 중' : '로딩', color: 'var(--accent)', pulse: true };
    case 'degraded':
    case 'suspended-dep':
      return { label: state === 'suspended-dep' ? '의존 일시중지' : '성능저하', color: 'var(--warn)' };
    case 'error':
    case 'quarantined':
      return { label: state === 'quarantined' ? '격리됨' : '오류', color: 'var(--danger)', pulse: true };
    case 'deactivating':
      return { label: '중지 중', color: 'var(--muted)' };
    case 'disabled':
      return { label: '비활성', color: 'var(--muted)' };
    default:
      return { label: '발견됨', color: 'var(--muted)' };
  }
}

export function originLabel(origin: PluginNodeSnapshot['origin']): { text: string; color: string } {
  switch (origin) {
    case 'local-dev':
      return { text: 'LOCAL DEV', color: '#9333ea' };
    case 'workspace':
      return { text: 'WORKSPACE', color: '#0891b2' };
    case 'core-kernel':
      return { text: 'CORE', color: 'var(--muted)' };
    default:
      return { text: 'BUILTIN', color: 'var(--accent)' };
  }
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

interface PluginInspectorDrawerProps {
  snapshot: KernelIntrospectionSnapshot;
  selectedId: string;
  compactOverlay: boolean;
  onClose: () => void;
  onRequestToggle: (node: PluginNodeSnapshot, nextEnabled: boolean) => void;
}

export const PluginInspectorDrawer: React.FC<PluginInspectorDrawerProps> = ({
  snapshot,
  selectedId,
  compactOverlay,
  onClose,
  onRequestToggle,
}) => {
  const inspectorTab = usePluginStudioUiStore((s) => s.inspectorTab);
  const setInspectorTab = usePluginStudioUiStore((s) => s.setInspectorTab);
  const selectNode = usePluginStudioUiStore((s) => s.selectNode);
  const pingPluginInUi = usePluginStudioUiStore((s) => s.pingPluginInUi);
  const askAgentAboutPlugin = usePluginStudioUiStore((s) => s.askAgentAboutPlugin);

  const sendCommand = useIntrospectionStore((s) => s.sendCommand);
  const pushToast = useIntrospectionStore((s) => s.pushToast);
  const bySlot = useSlotRegistry((s) => s.bySlot);

  const isCore = selectedId === '__core__';
  const node = isCore ? null : snapshot.plugins[selectedId] || null;

  const relatedPulses = useMemo<EventPulseSample[]>(() => {
    if (isCore) return snapshot.recentPulses.slice(-40).reverse();
    if (!node) return [];
    return snapshot.recentPulses
      .filter((p) => p.fromNodeId === node.id || p.toNodeIds.includes(node.id))
      .slice(-40)
      .reverse();
  }, [isCore, node, snapshot.recentPulses]);

  const relatedEdges = useMemo(() => {
    if (!node) return [];
    return Object.values(snapshot.eventEdges).filter(
      (e) => e.fromNodeId === node.id || e.toNodeId === node.id
    );
  }, [node, snapshot.eventEdges]);

  const liveClientSlots = useMemo(() => {
    if (!node) return [];
    const out: Array<{ slotId: string; contributionId: string; key: string }> = [];
    for (const [slotId, list] of Object.entries(bySlot)) {
      for (const entry of list) {
        if (entry.pluginId === node.id) {
          out.push({ slotId, contributionId: entry.contribution.id, key: entry.key });
        }
      }
    }
    return out;
  }, [bySlot, node]);

  const handlePickDirectory = async (): Promise<string | null> => {
    try {
      const bridge = getDeskKernelBridge();
      if (!bridge) return null;
      return await bridge.rpc.invoke<string | null>('plugin-studio:pick-directory');
    } catch {
      return null;
    }
  };

  if (!isCore && !node) {
    return null;
  }

  const containerCls = compactOverlay
    ? 'absolute inset-y-0 right-0 z-30 w-[330px] max-w-[92%] border-l flex flex-col shadow-xl'
    : 'w-[340px] shrink-0 border-l flex flex-col min-h-0';

  if (isCore) {
    return (
      <aside
        className={containerCls}
        style={{ background: 'var(--card)', borderColor: 'var(--border)' }}
      >
        <div
          className="px-3.5 py-3 border-b flex items-center justify-between gap-2"
          style={{ borderColor: 'var(--border)' }}
        >
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <Lock size={13} style={{ color: 'var(--muted)' }} />
              <span className="text-[13.5px] font-semibold truncate">Zero-Feature Core Kernel</span>
            </div>
            <div className="text-[11px] font-mono mt-0.5" style={{ color: 'var(--muted)' }}>
              v{snapshot.kernel.appVersion} · API {snapshot.kernel.kernelApiVersion} · RSS {snapshot.kernel.memoryRssMb}MB
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-lg hover:bg-[var(--surface)] cursor-pointer"
            style={{ color: 'var(--muted)' }}
            title="인스펙터 닫기"
          >
            <X size={14} />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto scroll-thin p-3.5 space-y-4 text-[12px]">
          <div
            className="rounded-xl border p-3 space-y-2"
            style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}
          >
            <div className="text-[11.5px] font-semibold">선언적 프로필 설정 파일</div>
            <div className="font-mono text-[11px] break-all" style={{ color: 'var(--muted)' }}>
              {snapshot.profile.configFilePath}
            </div>
            <div className="flex items-center justify-between text-[11px]" style={{ color: 'var(--fg-soft)' }}>
              <span>
                오버라이드 {snapshot.profile.overrideCount}건 · 로컬 마운트 {snapshot.profile.mountCount}개
              </span>
              <button
                type="button"
                onClick={() => void sendCommand({ type: 'plugin:open-config-file' })}
                className="px-2 py-0.5 rounded-md border cursor-pointer hover:bg-[var(--card)]"
                style={{ background: 'var(--card)', borderColor: 'var(--border)' }}
              >
                Finder 열기
              </button>
            </div>
          </div>

          <div className="space-y-1.5">
            <div className="text-[11.5px] font-semibold" style={{ color: 'var(--muted)' }}>
              표준 UI 슬롯 점유 현황 ({snapshot.kernel.occupiedSlotsCount} / {snapshot.kernel.totalSlotsCount})
            </div>
            <div
              className="rounded-xl border divide-y overflow-hidden"
              style={{ background: 'var(--bg)', borderColor: 'var(--border)' }}
            >
              {Object.values(snapshot.slots).map((slot) => (
                <div
                  key={slot.slotId}
                  className="px-3 py-2 flex items-center justify-between gap-2"
                  style={{ borderColor: 'var(--border)' }}
                >
                  <div className="min-w-0">
                    <div className="font-mono text-[11.5px] font-medium truncate">{slot.slotId}</div>
                    <div className="text-[11px]" style={{ color: 'var(--muted)' }}>
                      {slot.label}
                    </div>
                  </div>
                  <span
                    className="px-1.5 py-0.5 rounded-md text-[11px] font-mono num"
                    style={{
                      background: slot.mounts.length > 0 ? 'color-mix(in srgb, var(--accent) 12%, transparent)' : 'var(--surface)',
                      color: slot.mounts.length > 0 ? 'var(--accent)' : 'var(--muted)',
                    }}
                  >
                    {slot.mounts.length}
                  </span>
                </div>
              ))}
            </div>
          </div>

          <div className="space-y-1.5">
            <div className="text-[11.5px] font-semibold" style={{ color: 'var(--muted)' }}>
              활성 서비스 바인딩 ({Object.keys(snapshot.serviceBindings).length})
            </div>
            {Object.keys(snapshot.serviceBindings).length === 0 ? (
              <div className="text-[11.5px]" style={{ color: 'var(--muted)' }}>
                등록된 서비스 토큰이 아직 없습니다.
              </div>
            ) : (
              <div
                className="rounded-xl border divide-y overflow-hidden"
                style={{ background: 'var(--bg)', borderColor: 'var(--border)' }}
              >
                {Object.entries(snapshot.serviceBindings).map(([token, providers]) => (
                  <div
                    key={token}
                    className="px-3 py-2 flex items-center justify-between gap-2"
                    style={{ borderColor: 'var(--border)' }}
                  >
                    <code className="text-[11px] truncate">{token}</code>
                    <span className="text-[11px] font-mono truncate" style={{ color: 'var(--accent)' }}>
                      {providers.join(', ')}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </aside>
    );
  }

  // TypeScript narrowing guarantee
  if (!node) return null;

  const vis = lifecycleVisuals(node.lifecycleState);
  const orig = originLabel(node.origin);
  const isEnabled = node.enabledInConfig && node.lifecycleState !== 'disabled';
  const schema = node.manifest.configSchema || [];

  const tabs: Array<{ id: InspectorTabId; label: string; count?: number }> = [
    { id: 'overview', label: '개요' },
    { id: 'config', label: '설정', count: schema.length || undefined },
    { id: 'slots', label: '슬롯', count: Math.max(node.occupiedSlots.length, liveClientSlots.length) || undefined },
    {
      id: 'logs',
      label: '로그',
      count: node.health.errorCount > 0 ? node.health.errorCount : undefined,
    },
  ];

  return (
    <aside
      className={containerCls}
      style={{ background: 'var(--card)', borderColor: 'var(--border)' }}
    >
      {/* Header */}
      <div className="px-3.5 pt-3 pb-2.5 border-b space-y-2.5" style={{ borderColor: 'var(--border)' }}>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 flex-wrap">
              <span
                className={`w-2 h-2 rounded-full shrink-0 ${vis.pulse ? 'animate-pulse' : ''}`}
                style={{ background: vis.color }}
              />
              <span className="text-[13.5px] font-semibold truncate">{node.manifest.name}</span>
              <span
                className="px-1.5 py-0.5 rounded text-[10px] font-semibold font-mono"
                style={{
                  background: `color-mix(in srgb, ${orig.color} 13%, transparent)`,
                  color: orig.color,
                }}
              >
                {orig.text}
              </span>
            </div>
            <div className="text-[11px] font-mono mt-0.5 truncate" style={{ color: 'var(--muted)' }}>
              {node.id} · v{node.manifest.version} · {vis.label}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-lg hover:bg-[var(--surface)] cursor-pointer shrink-0"
            style={{ color: 'var(--muted)' }}
            title="인스펙터 닫기"
          >
            <X size={14} />
          </button>
        </div>

        {/* Action Strip */}
        <div className="flex items-center gap-1.5 flex-wrap">
          {!node.locked ? (
            <button
              type="button"
              onClick={() => onRequestToggle(node, !isEnabled)}
              className="px-2.5 py-1 rounded-lg text-[11.5px] font-medium cursor-pointer transition-opacity hover:opacity-90"
              style={{
                background: isEnabled ? 'var(--surface)' : 'var(--accent)',
                color: isEnabled ? 'var(--fg)' : '#fff',
                border: isEnabled ? '1px solid var(--border)' : '1px solid transparent',
              }}
            >
              {isEnabled ? '비활성화' : '활성화'}
            </button>
          ) : (
            <span
              className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] border"
              style={{ borderColor: 'var(--border)', color: 'var(--muted)' }}
            >
              <Lock size={11} /> 잠김
            </span>
          )}

          <button
            type="button"
            onClick={async () => {
              const res = await sendCommand({ type: 'plugin:reload', pluginId: node.id });
              if (res.ok) pushToast(`${node.id} 리로드 완료`, 'info');
              else pushToast(res.error || '리로드 실패', 'error');
            }}
            className="inline-flex items-center gap-1 px-2 py-1 rounded-lg border text-[11.5px] cursor-pointer hover:bg-[var(--surface)]"
            style={{ background: 'var(--bg)', borderColor: 'var(--border)', color: 'var(--fg-soft)' }}
            title="핫리로드"
          >
            <RotateCw size={11} />
            <span>리로드</span>
          </button>

          {node.hasLastGoodVersion && (
            <button
              type="button"
              onClick={async () => {
                const res = await sendCommand({ type: 'plugin:rollback', pluginId: node.id });
                if (res.ok) pushToast(`${node.id} 이전 정상 버전으로 롤백 완료`, 'info');
                else pushToast(res.error || '롤백 실패', 'error');
              }}
              className="inline-flex items-center gap-1 px-2 py-1 rounded-lg border text-[11.5px] cursor-pointer hover:bg-[var(--surface)]"
              style={{ background: 'var(--bg)', borderColor: 'var(--warn)', color: 'var(--warn)' }}
              title="이전 정상 번들로 롤백"
            >
              <History size={11} />
              <span>롤백</span>
            </button>
          )}

          {node.sourcePath && (
            <button
              type="button"
              onClick={() => void sendCommand({ type: 'plugin:reveal-source', pluginId: node.id })}
              className="inline-flex items-center gap-1 px-2 py-1 rounded-lg border text-[11.5px] cursor-pointer hover:bg-[var(--surface)]"
              style={{ background: 'var(--bg)', borderColor: 'var(--border)', color: 'var(--fg-soft)' }}
              title={node.sourcePath}
            >
              <FolderOpen size={11} />
              <span>폴더</span>
            </button>
          )}

          <button
            type="button"
            onClick={() =>
              askAgentAboutPlugin({
                pluginId: node.id,
                pluginName: node.manifest.name,
                slotId: node.occupiedSlots[0]?.slotId,
                sourcePath: node.sourcePath,
                errorMessage: node.health.lastError?.message,
                errorStack: node.health.lastError?.stack,
              })
            }
            className="inline-flex items-center gap-1 px-2 py-1 rounded-lg border text-[11.5px] cursor-pointer hover:bg-[var(--surface)]"
            style={{
              background: 'color-mix(in srgb, var(--accent) 10%, var(--bg))',
              borderColor: 'color-mix(in srgb, var(--accent) 35%, var(--border))',
              color: 'var(--accent)',
            }}
            title="이 플러그인을 에이전트 채팅으로 바로 수정 요청"
          >
            <Sparkles size={11} />
            <span>에이전트에 묻기</span>
          </button>
        </div>

        {/* Sub-tabs */}
        <div className="flex items-center gap-1 pt-0.5">
          {tabs.map((t) => {
            const active = inspectorTab === t.id;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setInspectorTab(t.id)}
                className="flex-1 py-1 rounded-lg text-[11.5px] font-medium cursor-pointer transition-colors flex items-center justify-center gap-1"
                style={{
                  background: active ? 'var(--surface-active)' : 'transparent',
                  color: active ? 'var(--fg)' : 'var(--muted)',
                }}
              >
                <span>{t.label}</span>
                {t.count !== undefined && (
                  <span
                    className="px-1 rounded text-[10px] font-mono num"
                    style={{
                      background:
                        t.id === 'logs' && node.health.errorCount > 0
                          ? 'color-mix(in srgb, var(--danger) 18%, transparent)'
                          : 'var(--surface)',
                      color: t.id === 'logs' && node.health.errorCount > 0 ? 'var(--danger)' : 'var(--muted)',
                    }}
                  >
                    {t.count}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0 overflow-y-auto scroll-thin p-3.5 space-y-4 text-[12px]">
        {inspectorTab === 'overview' && (
          <>
            <p className="leading-relaxed break-keep" style={{ color: 'var(--fg-soft)' }}>
              {node.manifest.description || '설명 없음'}
            </p>

            {/* Last Error Banner */}
            {node.health.lastError && (
              <div
                className="rounded-xl border p-2.5 space-y-1.5"
                style={{
                  background: 'color-mix(in srgb, var(--danger) 8%, var(--bg))',
                  borderColor: 'color-mix(in srgb, var(--danger) 40%, var(--border))',
                }}
              >
                <div className="flex items-center justify-between gap-1 text-[11.5px] font-semibold" style={{ color: 'var(--danger)' }}>
                  <span className="inline-flex items-center gap-1">
                    <AlertTriangle size={12} /> 최근 오류 ({node.health.lastError.phase})
                  </span>
                  <span className="font-mono text-[10.5px]">{fmtTime(node.health.lastError.timestamp)}</span>
                </div>
                <div className="font-mono text-[11px] break-all" style={{ color: 'var(--fg-soft)' }}>
                  {node.health.lastError.message}
                </div>
              </div>
            )}

            {/* Live Metrics Grid */}
            <div className="grid grid-cols-2 gap-2">
              <div className="rounded-xl border p-2.5" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
                <div className="text-[10.5px]" style={{ color: 'var(--muted)' }}>Host / Client</div>
                <div className="text-[12px] font-semibold mt-0.5 num">
                  {node.hostActive ? 'Host ON' : 'Host -'} · {node.clientActive ? 'UI ON' : 'UI -'}
                </div>
                <div className="text-[10.5px] font-mono mt-0.5" style={{ color: 'var(--muted)' }}>
                  리소스 {node.disposableCount.host}H / {node.disposableCount.client}C
                </div>
              </div>
              <div className="rounded-xl border p-2.5" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
                <div className="text-[10.5px]" style={{ color: 'var(--muted)' }}>활성화 / 리로드</div>
                <div className="text-[12px] font-semibold mt-0.5 num">
                  {node.health.activationMs != null ? `${node.health.activationMs}ms` : '-'}
                  {node.health.lastReloadMs != null ? ` · ↻${node.health.lastReloadMs}ms` : ''}
                </div>
                <div className="text-[10.5px] font-mono mt-0.5" style={{ color: 'var(--muted)' }}>
                  rev {node.revHash.slice(0, 7)}
                </div>
              </div>
              <div className="rounded-xl border p-2.5" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
                <div className="text-[10.5px]" style={{ color: 'var(--muted)' }}>열린 탭 / 숨김 보존</div>
                <div className="text-[12px] font-semibold mt-0.5 num">
                  열림 {node.activeOpenTabsCount} · 👻숨김 {node.hiddenPreservedTabsCount}
                </div>
                <div className="text-[10.5px] mt-0.5" style={{ color: 'var(--muted)' }}>
                  등급: {node.impactClass}
                </div>
              </div>
              <div className="rounded-xl border p-2.5" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
                <div className="text-[10.5px]" style={{ color: 'var(--muted)' }}>연결 트래픽 엣지</div>
                <div className="text-[12px] font-semibold mt-0.5 num">
                  {relatedEdges.length}개 연결
                </div>
                <div className="text-[10.5px] font-mono mt-0.5" style={{ color: 'var(--muted)' }}>
                  {relatedEdges.reduce((acc, e) => acc + e.eventsPerSec, 0).toFixed(1)} evt/s
                </div>
              </div>
            </div>

            {/* Source & Watch Info */}
            {node.sourcePath && (
              <div className="space-y-1">
                <div className="text-[11px] font-semibold" style={{ color: 'var(--muted)' }}>로컬 소스 경로</div>
                <div
                  className="rounded-xl border px-2.5 py-2 font-mono text-[11px] break-all flex items-center justify-between gap-2"
                  style={{ background: 'var(--bg)', borderColor: 'var(--border)', color: 'var(--fg-soft)' }}
                >
                  <span>{node.sourcePath}</span>
                  {node.watchActive && (
                    <span
                      className="px-1.5 py-0.5 rounded text-[10px] shrink-0"
                      style={{ background: 'color-mix(in srgb, var(--ok) 15%, transparent)', color: 'var(--ok)' }}
                    >
                      WATCH
                    </span>
                  )}
                </div>
              </div>
            )}

            {/* Dependencies & Dependents */}
            <div className="space-y-2">
              {node.requires.length > 0 && (
                <div className="space-y-1">
                  <div className="text-[11px] font-semibold" style={{ color: 'var(--muted)' }}>필수 의존성 (requires)</div>
                  <div className="flex flex-wrap gap-1">
                    {node.requires.map((req) => (
                      <span
                        key={req}
                        className="px-2 py-0.5 rounded-md border text-[11px] font-mono"
                        style={{ background: 'var(--surface)', borderColor: 'var(--border)', color: 'var(--fg-soft)' }}
                      >
                        {req}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {node.provides.length > 0 && (
                <div className="space-y-1">
                  <div className="text-[11px] font-semibold" style={{ color: 'var(--muted)' }}>제공 서비스 (provides)</div>
                  <div className="flex flex-wrap gap-1">
                    {node.provides.map((prov) => (
                      <span
                        key={prov}
                        className="px-2 py-0.5 rounded-md border text-[11px] font-mono"
                        style={{
                          background: 'color-mix(in srgb, var(--accent) 10%, transparent)',
                          borderColor: 'color-mix(in srgb, var(--accent) 30%, var(--border))',
                          color: 'var(--accent)',
                        }}
                      >
                        {prov}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {node.dependents.length > 0 && (
                <div className="space-y-1">
                  <div className="text-[11px] font-semibold" style={{ color: 'var(--muted)' }}>
                    이 플러그인에 의존하는 플러그인
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {node.dependents.map((depId) => (
                      <button
                        key={depId}
                        type="button"
                        onClick={() => selectNode(depId, 'overview')}
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md border text-[11px] font-mono cursor-pointer hover:bg-[var(--surface-active)]"
                        style={{ background: 'var(--surface)', borderColor: 'var(--border)', color: 'var(--fg)' }}
                      >
                        <span>{depId}</span>
                        <ArrowRight size={10} />
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Capabilities */}
            {node.manifest.capabilities && node.manifest.capabilities.length > 0 && (
              <div className="space-y-1">
                <div className="text-[11px] font-semibold" style={{ color: 'var(--muted)' }}>선언 권한 (Capabilities)</div>
                <div className="flex flex-wrap gap-1">
                  {node.manifest.capabilities.map((cap) => (
                    <span
                      key={cap}
                      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10.5px] font-mono border"
                      style={{ background: 'var(--bg)', borderColor: 'var(--border)', color: 'var(--muted)' }}
                    >
                      <ShieldAlert size={10} /> {cap}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Unmount Local Plugin */}
            {node.origin === 'local-dev' && (
              <div className="pt-2 border-t" style={{ borderColor: 'var(--border)' }}>
                <button
                  type="button"
                  onClick={async () => {
                    const res = await sendCommand({ type: 'plugin:unmount-local', pluginId: node.id });
                    if (res.ok) {
                      pushToast(`${node.id} 로컬 마운트를 해제했습니다.`, 'info');
                      onClose();
                    } else {
                      pushToast(res.error || '언마운트 실패', 'error');
                    }
                  }}
                  className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-xl border text-[12px] cursor-pointer hover:bg-[var(--surface)]"
                  style={{ borderColor: 'color-mix(in srgb, var(--danger) 40%, var(--border))', color: 'var(--danger)' }}
                >
                  <Trash2 size={12} />
                  <span>로컬 플러그인 마운트 해제</span>
                </button>
              </div>
            )}
          </>
        )}

        {inspectorTab === 'config' && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="inline-flex items-center gap-1.5 text-[12px] font-semibold">
                <Settings2 size={13} style={{ color: 'var(--muted)' }} />
                <span>선언적 스키마 설정</span>
              </div>
              <span className="text-[10.5px]" style={{ color: 'var(--muted)' }}>
                즉시 반영 · 자동 저장
              </span>
            </div>

            <SchemaSettingsForm
              schema={schema}
              values={node.currentConfig}
              compact
              onPickDirectory={handlePickDirectory}
              onChange={(patch) => {
                void sendCommand({ type: 'plugin:update-config', pluginId: node.id, patch });
              }}
            />

            <div className="space-y-1 pt-2 border-t" style={{ borderColor: 'var(--border)' }}>
              <div className="flex items-center justify-between text-[11px]" style={{ color: 'var(--muted)' }}>
                <span className="font-semibold">현재 네임스페이스 JSON 스냅샷</span>
                <button
                  type="button"
                  onClick={() => {
                    void navigator.clipboard?.writeText(JSON.stringify(node.currentConfig, null, 2));
                    pushToast('설정 JSON 복사됨', 'info');
                  }}
                  className="inline-flex items-center gap-1 cursor-pointer hover:underline"
                >
                  <Copy size={10} /> 복사
                </button>
              </div>
              <pre
                className="p-2.5 rounded-xl border text-[10.5px] font-mono overflow-x-auto max-h-40"
                style={{ background: 'var(--bg)', borderColor: 'var(--border)', color: 'var(--fg-soft)' }}
              >
                {JSON.stringify({ enabled: node.enabledInConfig, config: node.currentConfig }, null, 2)}
              </pre>
            </div>
          </div>
        )}

        {inspectorTab === 'slots' && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="inline-flex items-center gap-1.5 text-[12px] font-semibold">
                <Layers size={13} style={{ color: 'var(--muted)' }} /> 점유 UI 슬롯
              </span>
              <button
                type="button"
                onClick={() => pingPluginInUi(node.id, null)}
                className="px-2 py-0.5 rounded-md border text-[11px] cursor-pointer hover:bg-[var(--surface)]"
                style={{ background: 'var(--bg)', borderColor: 'var(--border)', color: 'var(--accent)' }}
              >
                화면에서 위치 깜빡이기
              </button>
            </div>

            {liveClientSlots.length === 0 && node.occupiedSlots.length === 0 ? (
              <div className="text-[11.5px] py-4 text-center" style={{ color: 'var(--muted)' }}>
                현재 점유 중인 클라이언트 UI 슬롯이 없습니다. (Host 전용 또는 비활성)
              </div>
            ) : (
              <div
                className="rounded-xl border divide-y overflow-hidden"
                style={{ background: 'var(--bg)', borderColor: 'var(--border)' }}
              >
                {(liveClientSlots.length > 0
                  ? liveClientSlots
                  : node.occupiedSlots.map((o) => ({
                      slotId: o.slotId,
                      contributionId: o.contributionId,
                      key: `${o.slotId}:${o.contributionId}`,
                    }))
                ).map((s) => (
                  <div
                    key={s.key}
                    onMouseEnter={() => pingPluginInUi(node.id, s.slotId as never)}
                    className="px-3 py-2 flex items-center justify-between gap-2 hover:bg-[var(--surface)] transition-colors"
                    style={{ borderColor: 'var(--border)' }}
                  >
                    <div className="min-w-0">
                      <div className="font-mono text-[11.5px] font-medium truncate">{s.slotId}</div>
                      <div className="font-mono text-[10.5px] truncate" style={{ color: 'var(--muted)' }}>
                        contrib: {s.contributionId}
                      </div>
                    </div>
                    <span
                      className="px-1.5 py-0.5 rounded text-[10px]"
                      style={{ background: 'color-mix(in srgb, var(--accent) 12%, transparent)', color: 'var(--accent)' }}
                    >
                      LIVE
                    </span>
                  </div>
                ))}
              </div>
            )}

            {/* Subscribed / Published Edges */}
            <div className="space-y-1.5 pt-2 border-t" style={{ borderColor: 'var(--border)' }}>
              <div className="inline-flex items-center gap-1.5 text-[11.5px] font-semibold" style={{ color: 'var(--muted)' }}>
                <Radio size={12} /> 활성 이벤트 버스 엣지 ({relatedEdges.length})
              </div>
              {relatedEdges.length === 0 ? (
                <div className="text-[11.5px]" style={{ color: 'var(--muted)' }}>
                  최근 10초간 관측된 이벤트 트래픽이 없습니다.
                </div>
              ) : (
                <div className="space-y-1.5">
                  {relatedEdges.map((edge) => (
                    <div
                      key={edge.edgeId}
                      className="rounded-lg border px-2.5 py-1.5 text-[11px] font-mono space-y-0.5"
                      style={{ background: 'var(--bg)', borderColor: 'var(--border)' }}
                    >
                      <div className="flex items-center justify-between gap-1">
                        <span className="truncate">
                          {edge.fromNodeId} → {edge.toNodeId}
                        </span>
                        <span className="num shrink-0 font-semibold" style={{ color: 'var(--accent)' }}>
                          {edge.eventsPerSec.toFixed(1)}/s
                        </span>
                      </div>
                      <div className="text-[10px] truncate" style={{ color: 'var(--muted)' }}>
                        {edge.channels.join(', ')}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {inspectorTab === 'logs' && (
          <div className="space-y-3">
            {/* Errors */}
            {node.health.recentErrors.length > 0 && (
              <div className="space-y-1.5">
                <div className="text-[11.5px] font-semibold" style={{ color: 'var(--danger)' }}>
                  최근 오류 기록 ({node.health.recentErrors.length})
                </div>
                {node.health.recentErrors.map((err) => (
                  <div
                    key={err.id}
                    className="rounded-xl border p-2.5 space-y-1.5"
                    style={{
                      background: 'color-mix(in srgb, var(--danger) 6%, var(--bg))',
                      borderColor: 'color-mix(in srgb, var(--danger) 35%, var(--border))',
                    }}
                  >
                    <div className="flex items-center justify-between text-[10.5px] font-mono">
                      <span style={{ color: 'var(--danger)' }}>
                        {err.phase} {err.fileLocation ? `@ ${err.fileLocation}` : ''}
                      </span>
                      <span style={{ color: 'var(--muted)' }}>{fmtTime(err.timestamp)}</span>
                    </div>
                    <div className="text-[11.5px] font-mono break-all">{err.message}</div>
                    {err.stack && (
                      <details className="text-[10.5px]">
                        <summary className="cursor-pointer" style={{ color: 'var(--muted)' }}>
                          스택 트레이스
                        </summary>
                        <pre
                          className="mt-1 p-2 rounded-lg overflow-x-auto max-h-28 text-[10px]"
                          style={{ background: 'var(--surface)', color: 'var(--muted)' }}
                        >
                          {err.stack}
                        </pre>
                      </details>
                    )}
                    <button
                      type="button"
                      onClick={() =>
                        askAgentAboutPlugin({
                          pluginId: node.id,
                          pluginName: node.manifest.name,
                          slotId: err.slotId,
                          sourcePath: node.sourcePath,
                          errorMessage: err.message,
                          errorStack: err.stack,
                        })
                      }
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium cursor-pointer"
                      style={{ background: 'var(--accent)', color: '#fff' }}
                    >
                      <Sparkles size={10} /> 에이전트에게 이 오류 수정 요청
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Scoped Pulses */}
            <div className="space-y-1.5">
              <div className="text-[11.5px] font-semibold" style={{ color: 'var(--muted)' }}>
                최근 이벤트 펄스 ({relatedPulses.length})
              </div>
              {relatedPulses.length === 0 ? (
                <div className="text-[11.5px] py-3 text-center" style={{ color: 'var(--muted)' }}>
                  이 플러그인과 관련된 최근 이벤트가 없습니다.
                </div>
              ) : (
                <div className="space-y-1">
                  {relatedPulses.map((p) => (
                    <div
                      key={p.id}
                      className="rounded-lg border px-2.5 py-1.5 text-[11px] space-y-0.5"
                      style={{ background: 'var(--bg)', borderColor: 'var(--border)' }}
                    >
                      <div className="flex items-center justify-between gap-1 font-mono text-[10.5px]">
                        <span style={{ color: p.isError ? 'var(--danger)' : 'var(--accent)' }}>
                          {p.channel}
                          {p.coalescedCount > 1 ? ` ×${p.coalescedCount}` : ''}
                        </span>
                        <span style={{ color: 'var(--muted)' }}>{fmtTime(p.timestamp)}</span>
                      </div>
                      <div className="truncate text-[11px]" style={{ color: 'var(--fg-soft)' }}>
                        {p.summary}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </aside>
  );
};
