import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Blocks,
  ChevronRight,
  FolderOpen,
  Ghost,
  Power,
  RotateCw,
  ScanEye,
  Settings2,
  Sparkles,
  X,
} from 'lucide-react';
import {
  BUILTIN_PLUGIN_IDS,
  getDomSlotAnchors,
  setXrayPointerShield,
  useIntrospectionStore,
  useLayoutStore,
  usePluginConfigStore,
  type DomSlotAnchor,
  type PluginNodeSnapshot,
} from '../../kernel/client';
import { lifecycleVisuals, originLabel } from './PluginInspectorDrawer';
import { usePluginStudioUiStore } from './studioState';

interface MeasuredBox {
  id: string;
  slotId: string;
  pluginId: string | null;
  contributionId?: string;
  groupId?: string;
  tabId?: string;
  depth: number;
  left: number;
  top: number;
  width: number;
  height: number;
  area: number;
}

interface HiddenGhostItem {
  id: string;
  slotId: string;
  pluginId: string;
  groupId?: string;
  tabId?: string;
}

function measureAllAnchors(includeEmptyDomSlots: boolean): {
  visible: MeasuredBox[];
  hiddenGhosts: HiddenGhostItem[];
} {
  const anchors: DomSlotAnchor[] = getDomSlotAnchors();
  const visible: MeasuredBox[] = [];
  const hiddenGhosts: HiddenGhostItem[] = [];
  const seenElements = new Set<HTMLElement>();

  const vw = window.innerWidth;
  const vh = window.innerHeight;

  for (const a of anchors) {
    if (!a.element || !a.element.isConnected) continue;
    // Skip X-Ray overlay itself so it never self-inspects
    if (a.slotId === 'overlay.layer' && a.pluginId === BUILTIN_PLUGIN_IDS.PLUGIN_STUDIO) continue;

    seenElements.add(a.element);
    const r = a.element.getBoundingClientRect();
    const isZero = r.width < 2 || r.height < 2;

    if (a.hiddenPreserved || (isZero && a.slotId === 'pane.type')) {
      if (a.pluginId) {
        hiddenGhosts.push({
          id: a.mountId,
          slotId: a.slotId,
          pluginId: a.pluginId,
          groupId: a.groupId,
          tabId: a.tabId,
        });
      }
      continue;
    }
    if (isZero) continue;

    // Clamp to visible viewport
    const left = Math.max(0, r.left);
    const top = Math.max(0, r.top);
    const right = Math.min(vw, r.right);
    const bottom = Math.min(vh, r.bottom);
    const width = right - left;
    const height = bottom - top;
    if (width < 4 || height < 4) continue;

    visible.push({
      id: a.mountId,
      slotId: a.slotId,
      pluginId: a.pluginId,
      contributionId: a.contributionId,
      groupId: a.groupId,
      tabId: a.tabId,
      depth: a.depth,
      left,
      top,
      width,
      height,
      area: width * height,
    });
  }

  // Also scan raw `[data-desk-slot]` elements (covers shell chrome slots & empty slots)
  if (typeof document !== 'undefined') {
    const domNodes = document.querySelectorAll<HTMLElement>('[data-desk-slot]');
    domNodes.forEach((el, idx) => {
      if (seenElements.has(el)) return;
      const slotId = el.dataset.deskSlot || '';
      const pluginId = el.dataset.deskPlugin || null;
      if (!slotId) return;
      if (!pluginId && !includeEmptyDomSlots) return;
      if (slotId === 'overlay.layer' && pluginId === BUILTIN_PLUGIN_IDS.PLUGIN_STUDIO) return;

      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) return;
      const left = Math.max(0, r.left);
      const top = Math.max(0, r.top);
      const width = Math.min(vw, r.right) - left;
      const height = Math.min(vh, r.bottom) - top;
      if (width < 4 || height < 4) return;

      visible.push({
        id: `dom:${slotId}:${pluginId || 'empty'}:${idx}`,
        slotId,
        pluginId,
        contributionId: el.dataset.deskContrib,
        depth: pluginId ? 1 : 0,
        left,
        top,
        width,
        height,
        area: width * height,
      });
    });
  }

  // Sort outer-to-inner so smaller/deeper badges render on top
  visible.sort((a, b) => a.depth - b.depth || b.area - a.area);
  return { visible, hiddenGhosts };
}

function boxAccentColor(box: MeasuredBox, node?: PluginNodeSnapshot): string {
  if (!box.pluginId) return 'var(--muted)';
  if (node?.lifecycleState === 'error' || node?.lifecycleState === 'quarantined') return 'var(--danger)';
  if (node?.lifecycleState === 'degraded' || node?.lifecycleState === 'suspended-dep') return 'var(--warn)';
  if (node?.origin === 'local-dev') return '#9333ea';
  if (box.slotId === 'pane.widget') return '#0891b2';
  return 'var(--accent)';
}

export const XrayOverlay: React.FC = () => {
  const xrayActive = useIntrospectionStore((s) => s.xrayActive);
  const setXrayActive = useIntrospectionStore((s) => s.setXrayActive);
  const snapshot = useIntrospectionStore((s) => s.snapshot);
  const acquireLiveSubscription = useIntrospectionStore((s) => s.acquireLiveSubscription);
  const sendCommand = useIntrospectionStore((s) => s.sendCommand);
  const pushToast = useIntrospectionStore((s) => s.pushToast);

  const pingedPluginId = usePluginStudioUiStore((s) => s.pingedPluginId);
  const pingedSlotId = usePluginStudioUiStore((s) => s.pingedSlotId);
  const openStudioAndInspect = usePluginStudioUiStore((s) => s.openStudioAndInspect);
  const askAgentAboutPlugin = usePluginStudioUiStore((s) => s.askAgentAboutPlugin);

  const studioConfig = usePluginConfigStore((s) => s.configsByPlugin[BUILTIN_PLUGIN_IDS.PLUGIN_STUDIO] || {});
  const defaultEmptySlots = Boolean(studioConfig.showEmptyXraySlots);

  const [showEmptySlots, setShowEmptySlots] = useState(defaultEmptySlots);
  const [boxes, setBoxes] = useState<MeasuredBox[]>([]);
  const [hiddenGhosts, setHiddenGhosts] = useState<HiddenGhostItem[]>([]);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [selectedStack, setSelectedStack] = useState<MeasuredBox[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [popoverPos, setPopoverPos] = useState<{ x: number; y: number } | null>(null);
  const [ghostListOpen, setGhostListOpen] = useState(false);

  // Sync empty slot default when config updates
  useEffect(() => {
    setShowEmptySlots(defaultEmptySlots);
  }, [defaultEmptySlots]);

  // Keep <webview> pointer-events shield strictly aligned with xrayActive
  useEffect(() => {
    setXrayPointerShield(xrayActive);
    return () => {
      setXrayPointerShield(false);
    };
  }, [xrayActive]);

  // Subscribe to Main live introspection ONLY while X-Ray is open
  useEffect(() => {
    if (!xrayActive) return;
    const release = acquireLiveSubscription();
    return () => release();
  }, [acquireLiveSubscription, xrayActive]);

  // Re-measure bounding boxes whenever X-Ray is active OR passive ping is active
  const needsMeasurement = xrayActive || Boolean(pingedPluginId || pingedSlotId);

  const refreshRects = useCallback(() => {
    const res = measureAllAnchors(xrayActive && showEmptySlots);
    setBoxes(res.visible);
    setHiddenGhosts(res.hiddenGhosts);
  }, [showEmptySlots, xrayActive]);

  useEffect(() => {
    if (!needsMeasurement) {
      setBoxes([]);
      setHiddenGhosts([]);
      setSelectedStack([]);
      setPopoverPos(null);
      setHoveredId(null);
      setGhostListOpen(false);
      return;
    }

    let rafId = 0;
    const schedule = () => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(refreshRects);
    };

    schedule();
    const interval = window.setInterval(schedule, 450);
    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', schedule, true);

    return () => {
      cancelAnimationFrame(rafId);
      window.clearInterval(interval);
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', schedule, true);
    };
  }, [needsMeasurement, refreshRects]);

  // Keyboard shortcuts while X-Ray is active: Esc closes, [ / ] cycles nested slot stack
  useEffect(() => {
    if (!xrayActive) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (selectedStack.length > 0) {
          setSelectedStack([]);
          setPopoverPos(null);
        } else {
          setXrayActive(false);
        }
      } else if (e.key === '[' && selectedStack.length > 1) {
        e.preventDefault();
        setSelectedIndex((i) => (i - 1 + selectedStack.length) % selectedStack.length);
      } else if (e.key === ']' && selectedStack.length > 1) {
        e.preventDefault();
        setSelectedIndex((i) => (i + 1) % selectedStack.length);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [selectedStack.length, setXrayActive, xrayActive]);

  const pingBoxes = useMemo(() => {
    if (xrayActive || (!pingedPluginId && !pingedSlotId)) return [];
    return boxes.filter((b) => {
      if (pingedPluginId && b.pluginId !== pingedPluginId) return false;
      if (pingedSlotId && b.slotId !== pingedSlotId) return false;
      return true;
    });
  }, [boxes, pingedPluginId, pingedSlotId, xrayActive]);

  // Passive Soft-Ping mode (when hovering a plugin/slot inside Plugin Studio)
  if (!xrayActive) {
    if (pingBoxes.length === 0) return null;
    return (
      <div className="pointer-events-none fixed inset-0 z-[92]">
        {pingBoxes.map((b) => (
          <div
            key={b.id}
            className="absolute rounded-xl border-2 animate-pulse"
            style={{
              left: b.left,
              top: b.top,
              width: b.width,
              height: b.height,
              borderColor: 'var(--accent)',
              background: 'color-mix(in srgb, var(--accent) 10%, transparent)',
            }}
          >
            <span
              className="absolute -top-2.5 left-2 px-1.5 py-0.5 rounded-md text-[10px] font-mono font-semibold shadow-sm"
              style={{ background: 'var(--accent)', color: '#fff' }}
            >
              {b.pluginId} · {b.slotId}
            </span>
          </div>
        ))}
      </div>
    );
  }

  // Pick all boxes containing (clientX, clientY), ordered innermost-first
  const hitTestAt = (x: number, y: number): MeasuredBox[] => {
    const hits = boxes.filter((b) => x >= b.left && x <= b.left + b.width && y >= b.top && y <= b.top + b.height);
    hits.sort((a, b) => b.depth - a.depth || a.area - b.area);
    return hits;
  };

  const openInspectorForBox = (box: MeasuredBox, clientX: number, clientY: number) => {
    const stack = hitTestAt(clientX, clientY);
    const list = stack.some((s) => s.id === box.id) ? stack : [box, ...stack];
    const idx = Math.max(0, list.findIndex((s) => s.id === box.id));
    setSelectedStack(list);
    setSelectedIndex(idx);
    setPopoverPos({ x: clientX, y: clientY });
    setGhostListOpen(false);
  };

  const activeBox = selectedStack[selectedIndex] || null;
  const activeNode: PluginNodeSnapshot | undefined =
    activeBox?.pluginId && snapshot ? snapshot.plugins[activeBox.pluginId] : undefined;

  const uniquePluginsCount = new Set(boxes.map((b) => b.pluginId).filter(Boolean)).size;

  // Clamp popover inside viewport cleanly
  const clampedPopover = (() => {
    if (!popoverPos) return null;
    const popW = 324;
    const popH = 265;
    const pad = 12;
    const left = Math.min(Math.max(pad, popoverPos.x + 8), Math.max(pad, window.innerWidth - popW - pad));
    const top = Math.min(Math.max(pad + 44, popoverPos.y + 8), Math.max(pad + 44, window.innerHeight - popH - pad));
    return { left, top };
  })();

  return (
    <div
      className="fixed inset-0 z-[95] select-none"
      style={{ background: 'rgba(15, 23, 42, 0.08)' }}
      onMouseMove={(e) => {
        if (selectedStack.length > 0) return;
        const hits = hitTestAt(e.clientX, e.clientY);
        setHoveredId(hits[0]?.id || null);
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          const hits = hitTestAt(e.clientX, e.clientY);
          if (hits.length > 0) {
            openInspectorForBox(hits[0], e.clientX, e.clientY);
          } else {
            setSelectedStack([]);
            setPopoverPos(null);
          }
        }
      }}
    >
      {/* Top Floating X-Ray Control HUD */}
      <div className="fixed top-12 left-1/2 -translate-x-1/2 z-[98] flex flex-col items-center gap-1.5">
        <div
          className="flex items-center gap-2.5 px-3.5 py-1.5 rounded-full border text-[12px]"
          style={{
            background: 'var(--card)',
            borderColor: 'var(--accent)',
            boxShadow: 'var(--shadow-popover)',
            color: 'var(--fg)',
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <span className="inline-flex items-center gap-1.5 font-semibold" style={{ color: 'var(--accent)' }}>
            <ScanEye size={14} />
            <span>UI X-Ray</span>
          </span>
          <span className="text-[11.5px] font-mono num" style={{ color: 'var(--muted)' }}>
            슬롯 {boxes.length} · 플러그인 {uniquePluginsCount}
          </span>

          <label className="inline-flex items-center gap-1 text-[11.5px] cursor-pointer" style={{ color: 'var(--fg-soft)' }}>
            <input
              type="checkbox"
              checked={showEmptySlots}
              onChange={(e) => setShowEmptySlots(e.target.checked)}
              className="accent-[var(--accent)] cursor-pointer"
            />
            <span>빈 슬롯</span>
          </label>

          {hiddenGhosts.length > 0 && (
            <button
              type="button"
              onClick={() => setGhostListOpen((v) => !v)}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[11px] font-mono cursor-pointer hover:bg-[var(--surface)]"
              style={{ background: 'var(--surface)', borderColor: 'var(--border)', color: 'var(--fg-soft)' }}
              title="비활성 상태지만 size-0로 로그인/PTY 프로세스가 보존된 탭"
            >
              <Ghost size={11} />
              <span>숨김 보존 {hiddenGhosts.length}</span>
            </button>
          )}

          <button
            type="button"
            onClick={() => {
              setXrayActive(false);
              openStudioAndInspect(undefined, 'overview', { splitIfMissing: true });
            }}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium cursor-pointer hover:bg-[var(--surface)]"
            style={{ color: 'var(--fg-soft)' }}
          >
            <Blocks size={11} />
            <span>스튜디오</span>
          </button>

          <button
            type="button"
            onClick={() => setXrayActive(false)}
            className="inline-flex items-center gap-0.5 px-2 py-0.5 rounded-full text-[11px] font-medium cursor-pointer"
            style={{ background: 'var(--fg)', color: 'var(--bg)' }}
            title="X-Ray 종료 (Esc)"
          >
            <span>종료</span>
            <span className="font-mono text-[10px] opacity-80 ml-0.5">Esc</span>
          </button>
        </div>

        {/* Hidden Preserved (size-0) Ghost Tabs Popover */}
        {ghostListOpen && hiddenGhosts.length > 0 && (
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-[340px] rounded-2xl border p-3 text-[12px] space-y-2"
            style={{
              background: 'var(--card)',
              borderColor: 'var(--border-strong)',
              boxShadow: 'var(--shadow-popover)',
            }}
          >
            <div className="flex items-center justify-between">
              <span className="font-semibold text-[12px]">👻 숨김 보존 프로세스 (size-0 keepAlive)</span>
              <button
                type="button"
                onClick={() => setGhostListOpen(false)}
                className="p-0.5 rounded hover:bg-[var(--surface)] cursor-pointer"
                style={{ color: 'var(--muted)' }}
              >
                <X size={12} />
              </button>
            </div>
            <div className="space-y-1 max-h-44 overflow-y-auto scroll-thin">
              {hiddenGhosts.map((g) => (
                <div
                  key={g.id}
                  className="px-2.5 py-1.5 rounded-lg border flex items-center justify-between gap-2 text-[11.5px]"
                  style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}
                >
                  <div className="min-w-0">
                    <div className="font-mono font-medium truncate">{g.pluginId}</div>
                    <div className="text-[10.5px] font-mono truncate" style={{ color: 'var(--muted)' }}>
                      {g.slotId} {g.tabId ? `· ${g.tabId}` : ''}
                    </div>
                  </div>
                  {g.groupId && g.tabId && (
                    <button
                      type="button"
                      onClick={() => {
                        useLayoutStore.getState().setActiveTab(g.groupId!, g.tabId!);
                        setGhostListOpen(false);
                      }}
                      className="px-2 py-0.5 rounded-md border text-[11px] cursor-pointer hover:bg-[var(--card)] shrink-0"
                      style={{ background: 'var(--card)', borderColor: 'var(--border)' }}
                    >
                      탭 전환
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Rendered Slot Wireframes & Origin Badges */}
      {boxes.map((box) => {
        const node = box.pluginId && snapshot ? snapshot.plugins[box.pluginId] : undefined;
        const color = boxAccentColor(box, node);
        const isHovered = hoveredId === box.id;
        const isSelected = activeBox?.id === box.id;
        const isError = node?.lifecycleState === 'error' || node?.lifecycleState === 'quarantined';
        const isEmpty = !box.pluginId;

        return (
          <div
            key={box.id}
            onMouseEnter={() => {
              if (selectedStack.length === 0) setHoveredId(box.id);
            }}
            onClick={(e) => {
              e.stopPropagation();
              openInspectorForBox(box, e.clientX, e.clientY);
            }}
            className="fixed rounded-lg transition-colors cursor-pointer"
            style={{
              left: box.left,
              top: box.top,
              width: box.width,
              height: box.height,
              border: `${isSelected || isHovered ? 2 : 1.5}px ${isError ? 'solid' : isEmpty ? 'dotted' : 'dashed'} ${color}`,
              background: isSelected
                ? `color-mix(in srgb, ${color} 15%, transparent)`
                : isHovered
                  ? `color-mix(in srgb, ${color} 9%, transparent)`
                  : 'transparent',
              zIndex: 95 + box.depth,
            }}
          >
            {/* Origin Badge Pill */}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                openInspectorForBox(box, e.clientX, e.clientY);
              }}
              className="absolute top-1 left-1 max-w-[calc(100%-8px)] inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] font-mono font-semibold shadow-sm cursor-pointer truncate"
              style={{
                background: isSelected || isHovered ? color : 'var(--card)',
                color: isSelected || isHovered ? '#fff' : color,
                border: `1px solid ${color}`,
              }}
              title={`${box.pluginId || '빈 슬롯'} @ ${box.slotId} — 클릭하여 제어`}
            >
              <span
                className="w-1.5 h-1.5 rounded-full shrink-0"
                style={{ background: isSelected || isHovered ? '#fff' : color }}
              />
              <span className="truncate">
                {box.pluginId ? `${box.pluginId} · ${box.slotId}` : `빈 슬롯 · ${box.slotId}`}
              </span>
            </button>
          </div>
        );
      })}

      {/* Anchored 1-Click 5-Action X-Ray Popover */}
      {activeBox && clampedPopover && (
        <div
          onClick={(e) => e.stopPropagation()}
          className="fixed z-[99] w-[324px] rounded-2xl border p-3.5 space-y-3 text-[12px]"
          style={{
            left: clampedPopover.left,
            top: clampedPopover.top,
            background: 'var(--card)',
            borderColor: 'var(--border-strong)',
            boxShadow: 'var(--shadow-popover)',
            color: 'var(--fg)',
          }}
        >
          {/* Nested Slot Hierarchy Breadcrumb */}
          {selectedStack.length > 1 && (
            <div
              className="flex items-center gap-1 flex-wrap pb-2 border-b text-[10.5px] font-mono"
              style={{ borderColor: 'var(--border)' }}
            >
              {selectedStack
                .slice()
                .reverse()
                .map((item, revIdx) => {
                  const realIdx = selectedStack.length - 1 - revIdx;
                  const active = realIdx === selectedIndex;
                  return (
                    <React.Fragment key={item.id}>
                      {revIdx > 0 && <ChevronRight size={10} style={{ color: 'var(--muted)' }} />}
                      <button
                        type="button"
                        onClick={() => setSelectedIndex(realIdx)}
                        className="px-1.5 py-0.5 rounded cursor-pointer truncate max-w-[120px]"
                        style={{
                          background: active ? 'var(--surface-active)' : 'transparent',
                          color: active ? 'var(--accent)' : 'var(--muted)',
                          fontWeight: active ? 600 : 400,
                        }}
                      >
                        {item.pluginId || item.slotId}
                      </button>
                    </React.Fragment>
                  );
                })}
            </div>
          )}

          {/* Header */}
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="text-[13.5px] font-semibold truncate">
                  {activeNode?.manifest.name || activeBox.pluginId || '빈 슬롯 영역'}
                </span>
                {activeNode && (
                  <span
                    className="px-1.5 py-0.2 rounded text-[9.5px] font-mono font-semibold"
                    style={{
                      background: `color-mix(in srgb, ${originLabel(activeNode.origin).color} 13%, transparent)`,
                      color: originLabel(activeNode.origin).color,
                    }}
                  >
                    {originLabel(activeNode.origin).text}
                  </span>
                )}
              </div>
              <div className="text-[11px] font-mono mt-0.5 truncate" style={{ color: 'var(--muted)' }}>
                슬롯: {activeBox.slotId}
                {activeBox.contributionId ? ` (${activeBox.contributionId})` : ''}
              </div>
              {activeNode && (
                <div className="text-[11px] mt-0.5 flex items-center gap-2" style={{ color: 'var(--fg-soft)' }}>
                  <span className="inline-flex items-center gap-1">
                    <span
                      className="w-1.5 h-1.5 rounded-full"
                      style={{ background: lifecycleVisuals(activeNode.lifecycleState).color }}
                    />
                    {lifecycleVisuals(activeNode.lifecycleState).label}
                  </span>
                  <span className="font-mono text-[10.5px]" style={{ color: 'var(--muted)' }}>
                    v{activeNode.manifest.version} · 오류 {activeNode.health.errorCount}
                  </span>
                </div>
              )}
            </div>
            <button
              type="button"
              onClick={() => {
                setSelectedStack([]);
                setPopoverPos(null);
              }}
              className="p-1 rounded-lg hover:bg-[var(--surface)] cursor-pointer shrink-0"
              style={{ color: 'var(--muted)' }}
            >
              <X size={13} />
            </button>
          </div>

          {activeNode?.health.lastError && (
            <div
              className="rounded-lg border px-2.5 py-1.5 text-[11px] font-mono flex items-start gap-1.5"
              style={{
                background: 'color-mix(in srgb, var(--danger) 8%, var(--bg))',
                borderColor: 'color-mix(in srgb, var(--danger) 35%, var(--border))',
                color: 'var(--danger)',
              }}
            >
              <AlertTriangle size={12} className="shrink-0 mt-0.5" />
              <span className="line-clamp-2">{activeNode.health.lastError.message}</span>
            </div>
          )}

          {/* 5 One-Click Actions */}
          {activeBox.pluginId ? (
            <div className="space-y-1.5">
              <div className="grid grid-cols-2 gap-1.5">
                {/* 1. ON/OFF Toggle */}
                <button
                  type="button"
                  disabled={activeNode?.locked}
                  onClick={async () => {
                    if (!activeBox.pluginId) return;
                    const nextEnabled = activeNode ? !(activeNode.enabledInConfig && activeNode.lifecycleState !== 'disabled') : false;
                    const res = await sendCommand({
                      type: 'plugin:toggle',
                      pluginId: activeBox.pluginId,
                      enabled: nextEnabled,
                    });
                    if (res.ok) {
                      pushToast(`${activeBox.pluginId} ${nextEnabled ? '활성화됨' : '비활성화됨'}`, 'info');
                      setSelectedStack([]);
                      setPopoverPos(null);
                      refreshRects();
                    } else {
                      pushToast(res.error || '토글 실패', 'error');
                    }
                  }}
                  className="inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-xl border text-[11.5px] font-medium cursor-pointer hover:bg-[var(--surface)] disabled:opacity-40"
                  style={{ background: 'var(--bg)', borderColor: 'var(--border)', color: 'var(--fg)' }}
                >
                  <Power size={12} />
                  <span>{activeNode?.lifecycleState === 'disabled' ? '플러그인 켜기' : 'ON/OFF 끄기'}</span>
                </button>

                {/* 2. Open in Plugin Studio Inspector */}
                <button
                  type="button"
                  onClick={() => {
                    if (!activeBox.pluginId) return;
                    setXrayActive(false);
                    openStudioAndInspect(activeBox.pluginId, 'config', { splitIfMissing: true });
                  }}
                  className="inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-xl border text-[11.5px] font-medium cursor-pointer hover:bg-[var(--surface)]"
                  style={{ background: 'var(--bg)', borderColor: 'var(--border)', color: 'var(--fg)' }}
                >
                  <Settings2 size={12} />
                  <span>스튜디오 설정</span>
                </button>

                {/* 3. Reveal Local Source Folder */}
                <button
                  type="button"
                  disabled={!activeNode?.sourcePath}
                  onClick={async () => {
                    if (!activeBox.pluginId) return;
                    const res = await sendCommand({ type: 'plugin:reveal-source', pluginId: activeBox.pluginId });
                    if (!res.ok) pushToast(res.error || '내장 플러그인은 외부 폴더가 없습니다.', 'warn');
                  }}
                  className="inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-xl border text-[11.5px] font-medium cursor-pointer hover:bg-[var(--surface)] disabled:opacity-40 disabled:cursor-default"
                  style={{ background: 'var(--bg)', borderColor: 'var(--border)', color: 'var(--fg)' }}
                  title={activeNode?.sourcePath || '외부 로컬 플러그인에서만 폴더를 열 수 있습니다'}
                >
                  <FolderOpen size={12} />
                  <span>로컬 소스 열기</span>
                </button>

                {/* 4. Hot Reload */}
                <button
                  type="button"
                  onClick={async () => {
                    if (!activeBox.pluginId) return;
                    const res = await sendCommand({ type: 'plugin:reload', pluginId: activeBox.pluginId });
                    if (res.ok) {
                      pushToast(`${activeBox.pluginId} 핫리로드 완료`, 'info');
                      refreshRects();
                    } else {
                      pushToast(res.error || '리로드 실패', 'error');
                    }
                  }}
                  className="inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-xl border text-[11.5px] font-medium cursor-pointer hover:bg-[var(--surface)]"
                  style={{ background: 'var(--bg)', borderColor: 'var(--border)', color: 'var(--fg)' }}
                >
                  <RotateCw size={12} />
                  <span>핫리로드</span>
                </button>
              </div>

              {/* 5. Ask Agent to Modify this Plugin */}
              <button
                type="button"
                onClick={() => {
                  if (!activeBox.pluginId) return;
                  askAgentAboutPlugin({
                    pluginId: activeBox.pluginId,
                    pluginName: activeNode?.manifest.name,
                    slotId: activeBox.slotId,
                    sourcePath: activeNode?.sourcePath,
                    errorMessage: activeNode?.health.lastError?.message,
                    errorStack: activeNode?.health.lastError?.stack,
                  });
                }}
                className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl text-[12px] font-semibold cursor-pointer transition-opacity hover:opacity-90"
                style={{ background: 'var(--accent)', color: '#fff' }}
              >
                <Sparkles size={13} />
                <span>이 플러그인 수정 에이전트에 묻기</span>
              </button>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="text-[11.5px]" style={{ color: 'var(--muted)' }}>
                현재 이 슬롯(<code>{activeBox.slotId}</code>)에 마운트된 플러그인이 없습니다.
              </div>
              <button
                type="button"
                onClick={() => {
                  setXrayActive(false);
                  openStudioAndInspect('__core__', 'slots', { splitIfMissing: true });
                }}
                className="w-full px-3 py-1.5 rounded-xl text-[12px] font-medium cursor-pointer"
                style={{ background: 'var(--accent)', color: '#fff' }}
              >
                스튜디오에서 슬롯 확인하기
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
