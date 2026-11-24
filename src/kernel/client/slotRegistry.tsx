import React, { Component, useEffect, useRef } from 'react';
import { create } from 'zustand';
import type {
  Disposer,
  DomSlotAnchor,
  PaneTabRecord,
  PaneTypeDefinition,
  PluginErrorRecord,
  SlotContributionMap,
  SlotKind,
  SlotLayoutOverride,
} from '../shared/types';

// ============================================================================
// 1. Reactive Slot Registry + Zero-Overhead X-Ray DOM Anchor Map
// ============================================================================

export type StoredSlotEntry<S extends SlotKind = SlotKind> = {
  readonly key: string; // `${pluginId}:${contribution.id}`
  readonly pluginId: string;
  readonly slotId: S;
  readonly contribution: SlotContributionMap[S];
};

/** Non-reactive Map for X-Ray DOM anchor refs (0% overhead / 0 re-renders when X-Ray is off) */
const domAnchorMap = new Map<string, DomSlotAnchor>();

export function getDomSlotAnchors(): DomSlotAnchor[] {
  return Array.from(domAnchorMap.values());
}

export function registerDomSlotAnchor(anchor: DomSlotAnchor): () => void {
  domAnchorMap.set(anchor.mountId, anchor);
  return () => {
    if (domAnchorMap.get(anchor.mountId) === anchor) {
      domAnchorMap.delete(anchor.mountId);
    }
  };
}

interface SlotRegistryState {
  bySlot: Record<SlotKind, StoredSlotEntry[]>;
  paneTypes: Record<string, PaneTypeDefinition>;
  slotOverrides: Partial<Record<SlotKind, SlotLayoutOverride>>;
  mountKeys: Record<string, number>; // pluginId -> monotonic HMR counter
  onRenderError?: (pluginId: string, err: PluginErrorRecord) => void;
  onPluginAction?: (action: 'reload' | 'disable', pluginId: string) => void;

  setCallbacks: (cbs: {
    onRenderError?: (pluginId: string, err: PluginErrorRecord) => void;
    onPluginAction?: (action: 'reload' | 'disable', pluginId: string) => void;
  }) => void;
  setSlotOverrides: (overrides: Partial<Record<SlotKind, SlotLayoutOverride>>) => void;
  bumpMountKey: (pluginId: string) => void;

  registerContribution: <S extends SlotKind>(
    pluginId: string,
    slotId: S,
    contribution: SlotContributionMap[S]
  ) => Disposer;

  registerPaneType: <TState extends Record<string, unknown>>(
    pluginId: string,
    def: PaneTypeDefinition<TState>
  ) => Disposer;

  getEntries: <S extends SlotKind>(slotId: S) => StoredSlotEntry<S>[];
  getOccupiedSlotsForPlugin: (pluginId: string) => Array<{ slotId: SlotKind; contributionId: string }>;
}

const EMPTY_BY_SLOT: Record<SlotKind, StoredSlotEntry[]> = {
  'titlebar.actions': [],
  'sidebar.section': [],
  'pane.type': [],
  'pane.header.action': [],
  'pane.widget': [],
  'context-menu.item': [],
  'settings.section': [],
  'overlay.layer': [],
};

export const useSlotRegistry = create<SlotRegistryState>((set, get) => ({
  bySlot: { ...EMPTY_BY_SLOT },
  paneTypes: {},
  slotOverrides: {},
  mountKeys: {},

  setCallbacks: (cbs) => set({ onRenderError: cbs.onRenderError, onPluginAction: cbs.onPluginAction }),

  setSlotOverrides: (slotOverrides) => set({ slotOverrides }),

  bumpMountKey: (pluginId) =>
    set((s) => ({
      mountKeys: { ...s.mountKeys, [pluginId]: (s.mountKeys[pluginId] || 0) + 1 },
    })),

  registerContribution: (pluginId, slotId, contribution) => {
    const key = `${pluginId}:${contribution.id}`;
    const entry: StoredSlotEntry = {
      key,
      pluginId,
      slotId,
      contribution: { ...contribution, pluginId },
    };

    set((s) => {
      const prevList = s.bySlot[slotId] || [];
      const filtered = prevList.filter((e) => e.key !== key);
      return {
        bySlot: {
          ...s.bySlot,
          [slotId]: [...filtered, entry],
        },
      };
    });

    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      set((s) => {
        const prevList = s.bySlot[slotId] || [];
        return {
          bySlot: {
            ...s.bySlot,
            [slotId]: prevList.filter((e) => e !== entry),
          },
        };
      });
    };
  },

  registerPaneType: (pluginId, def) => {
    const typedDef: PaneTypeDefinition = {
      ...(def as unknown as PaneTypeDefinition),
      ownerPluginId: pluginId,
    };

    set((s) => ({
      paneTypes: { ...s.paneTypes, [def.type]: typedDef },
    }));

    const slotDisposer = get().registerContribution(pluginId, 'pane.type', {
      ...typedDef,
      id: `pane:${def.type}`,
      pluginId,
      order: def.order ?? 100,
    });

    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      void slotDisposer();
      set((s) => {
        if (s.paneTypes[def.type] !== typedDef) return s;
        const next = { ...s.paneTypes };
        delete next[def.type];
        return { paneTypes: next };
      });
    };
  },

  getEntries: <S extends SlotKind>(slotId: S) => {
    const entries = (get().bySlot[slotId] || []) as StoredSlotEntry<S>[];
    return resolveOrderedSlotEntries(entries, get().slotOverrides[slotId]);
  },

  getOccupiedSlotsForPlugin: (pluginId) => {
    const out: Array<{ slotId: SlotKind; contributionId: string }> = [];
    const bySlot = get().bySlot;
    for (const [slotId, entries] of Object.entries(bySlot) as Array<[SlotKind, StoredSlotEntry[]]>) {
      for (const e of entries) {
        if (e.pluginId === pluginId) {
          out.push({ slotId, contributionId: e.contribution.id });
        }
      }
    }
    return out;
  },
}));

/** Helper applying declarative `SlotLayoutOverride` (order + hide) */
export function resolveOrderedSlotEntries<S extends SlotKind>(
  entries: readonly StoredSlotEntry<S>[],
  override?: SlotLayoutOverride
): StoredSlotEntry<S>[] {
  const hiddenSet = new Set(override?.hide || []);
  const orderList = override?.order || [];
  const orderRank = new Map<string, number>();
  orderList.forEach((k, idx) => orderRank.set(k, idx));

  return entries
    .filter((e) => !hiddenSet.has(e.key) && (!e.contribution.when || e.contribution.when()))
    .sort((a, b) => {
      const ra = orderRank.has(a.key) ? orderRank.get(a.key)! : 10_000 + (a.contribution.order ?? 100);
      const rb = orderRank.has(b.key) ? orderRank.get(b.key)! : 10_000 + (b.contribution.order ?? 100);
      if (ra !== rb) return ra - rb;
      return a.key.localeCompare(b.key);
    });
}

// ============================================================================
// 2. Per-Slot / Per-Pane PluginErrorBoundary (Fault Isolation)
// ============================================================================

export interface PluginErrorBoundaryProps {
  pluginId: string;
  slotId: SlotKind;
  contributionId?: string;
  compact?: boolean;
  children: React.ReactNode;
}

interface PluginErrorBoundaryState {
  error: Error | null;
}

export class PluginErrorBoundary extends Component<PluginErrorBoundaryProps, PluginErrorBoundaryState> {
  state: PluginErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): PluginErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    const record: PluginErrorRecord = {
      id: `err-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      timestamp: Date.now(),
      phase: 'render',
      message: error.message || String(error),
      stack: [error.stack, info.componentStack].filter(Boolean).join('\n'),
      slotId: this.props.slotId,
    };
    useSlotRegistry.getState().onRenderError?.(this.props.pluginId, record);
  }

  private handleRetry = () => {
    this.setState({ error: null });
    useSlotRegistry.getState().onPluginAction?.('reload', this.props.pluginId);
  };

  private handleDisable = () => {
    useSlotRegistry.getState().onPluginAction?.('disable', this.props.pluginId);
  };

  private handleCopy = () => {
    if (!this.state.error) return;
    void navigator.clipboard?.writeText(
      `[Plugin Error: ${this.props.pluginId} @ ${this.props.slotId}]\n${this.state.error.message}\n${this.state.error.stack || ''}`
    );
  };

  render() {
    if (!this.state.error) return this.props.children;

    if (this.props.compact) {
      return (
        <span
          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium border"
          style={{
            borderColor: 'var(--danger)',
            color: 'var(--danger)',
            background: 'color-mix(in srgb, var(--danger) 10%, transparent)',
          }}
          title={`${this.props.pluginId}: ${this.state.error.message}`}
        >
          <span>⚠ {this.props.pluginId}</span>
          <button type="button" onClick={this.handleRetry} className="underline cursor-pointer">
            ↻
          </button>
        </span>
      );
    }

    return (
      <div
        className="m-2 p-3 rounded-xl border text-[12px] space-y-2"
        style={{
          background: 'color-mix(in srgb, var(--danger) 8%, var(--card))',
          borderColor: 'color-mix(in srgb, var(--danger) 45%, var(--border))',
          color: 'var(--fg)',
        }}
      >
        <div className="flex items-center justify-between gap-2">
          <div className="font-semibold" style={{ color: 'var(--danger)' }}>
            플러그인 렌더링 오류 · {this.props.pluginId}
          </div>
          <span className="text-[11px] font-mono" style={{ color: 'var(--muted)' }}>
            {this.props.slotId}
          </span>
        </div>
        <div className="font-mono text-[11.5px] break-all" style={{ color: 'var(--fg-soft)' }}>
          {this.state.error.message}
        </div>
        <div className="flex items-center gap-1.5 pt-0.5">
          <button
            type="button"
            onClick={this.handleRetry}
            className="px-2.5 py-1 rounded-lg border text-[11.5px] font-medium cursor-pointer hover:bg-[var(--surface)]"
            style={{ background: 'var(--card)', borderColor: 'var(--border)' }}
          >
            ↻ 다시 로드
          </button>
          <button
            type="button"
            onClick={this.handleDisable}
            className="px-2.5 py-1 rounded-lg border text-[11.5px] cursor-pointer hover:bg-[var(--surface)]"
            style={{ background: 'var(--card)', borderColor: 'var(--border)', color: 'var(--danger)' }}
          >
            플러그인 끄기
          </button>
          <button
            type="button"
            onClick={this.handleCopy}
            className="px-2.5 py-1 rounded-lg border text-[11.5px] cursor-pointer hover:bg-[var(--surface)]"
            style={{ background: 'var(--card)', borderColor: 'var(--border)', color: 'var(--muted)' }}
          >
            오류 복사
          </button>
        </div>
      </div>
    );
  }
}

// ============================================================================
// 3. X-Ray Instrumented Mount Wrapper & Generic <SlotOutlet />
// ============================================================================

export const PluginMountBoundary: React.FC<{
  mountId: string;
  slotId: SlotKind;
  pluginId: string;
  contributionId: string;
  groupId?: string;
  tabId?: string;
  depth?: number;
  hiddenPreserved?: boolean;
  compactError?: boolean;
  className?: string;
  children: React.ReactNode;
}> = ({
  mountId,
  slotId,
  pluginId,
  contributionId,
  groupId,
  tabId,
  depth = 1,
  hiddenPreserved = false,
  compactError = false,
  className = 'contents',
  children,
}) => {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const mountKey = useSlotRegistry((s) => s.mountKeys[pluginId] || 0);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    // When wrapper uses `display: contents`, point X-Ray to the first real child element for accurate rect measurement
    const targetEl =
      className === 'contents' && el.firstElementChild instanceof HTMLElement ? el.firstElementChild : el;

    return registerDomSlotAnchor({
      mountId,
      slotId,
      pluginId,
      contributionId,
      element: targetEl,
      groupId,
      tabId,
      depth,
      hiddenPreserved,
    });
  }, [className, contributionId, depth, groupId, hiddenPreserved, mountId, mountKey, pluginId, slotId, tabId]);

  return (
    <div
      ref={wrapRef}
      className={className}
      data-desk-slot={slotId}
      data-desk-plugin={pluginId}
      data-desk-contrib={contributionId}
    >
      <PluginErrorBoundary
        key={`${pluginId}:${mountKey}`}
        pluginId={pluginId}
        slotId={slotId}
        contributionId={contributionId}
        compact={compactError}
      >
        {children}
      </PluginErrorBoundary>
    </div>
  );
};

export interface SlotOutletProps {
  slotId: SlotKind;
  zone?: string;
  targetPaneType?: string;
  anchor?: string;
  zLayer?: 'hud' | 'modal' | 'popover' | 'xray';
  groupId?: string;
  tab?: PaneTabRecord;
  depth?: number;
  compactError?: boolean;
  itemClassName?: string;
}

/**
 * Renders all active plugin contributions registered to `slotId`, respecting
 * declarative `SlotLayoutOverride` (order + hide), per-plugin ErrorBoundary isolation,
 * and X-Ray DOM anchor instrumentation.
 */
export const SlotOutlet: React.FC<SlotOutletProps> = ({
  slotId,
  zone,
  targetPaneType,
  anchor,
  zLayer,
  groupId,
  tab,
  depth = 1,
  compactError = false,
  itemClassName = 'contents',
}) => {
  const entries = useSlotRegistry((s) => s.bySlot[slotId]);
  const override = useSlotRegistry((s) => s.slotOverrides[slotId]);

  const ordered = resolveOrderedSlotEntries(entries || [], override);

  return (
    <>
      {ordered.map((entry) => {
        const c = entry.contribution;

        if (slotId === 'titlebar.actions') {
          const tc = c as SlotContributionMap['titlebar.actions'];
          if (zone && tc.zone !== zone) return null;
          const Comp = tc.Component;
          return (
            <PluginMountBoundary
              key={entry.key}
              mountId={`${slotId}:${entry.key}`}
              slotId={slotId}
              pluginId={entry.pluginId}
              contributionId={tc.id}
              depth={depth}
              compactError={compactError || true}
              className={itemClassName}
            >
              <Comp />
            </PluginMountBoundary>
          );
        }

        if (slotId === 'sidebar.section') {
          const sc = c as SlotContributionMap['sidebar.section'];
          if (zone && sc.zone !== zone) return null;
          const Comp = sc.Component;
          return (
            <PluginMountBoundary
              key={entry.key}
              mountId={`${slotId}:${entry.key}`}
              slotId={slotId}
              pluginId={entry.pluginId}
              contributionId={sc.id}
              depth={depth}
              compactError={compactError}
              className={itemClassName}
            >
              <Comp />
            </PluginMountBoundary>
          );
        }

        if (slotId === 'pane.header.action') {
          const hc = c as SlotContributionMap['pane.header.action'];
          if (hc.targetPaneTypes && tab && !hc.targetPaneTypes.includes(tab.paneType)) return null;
          const Comp = hc.Component;
          return (
            <PluginMountBoundary
              key={entry.key}
              mountId={`${slotId}:${groupId || 'g'}:${entry.key}`}
              slotId={slotId}
              pluginId={entry.pluginId}
              contributionId={hc.id}
              groupId={groupId}
              tabId={tab?.id}
              depth={depth}
              compactError={true}
              className={itemClassName}
            >
              <Comp groupId={groupId || ''} activeTab={tab} />
            </PluginMountBoundary>
          );
        }

        if (slotId === 'pane.widget') {
          const wc = c as SlotContributionMap['pane.widget'];
          if (targetPaneType && wc.targetPaneType !== targetPaneType) return null;
          if (anchor && wc.anchor !== anchor) return null;
          if (!tab) return null;
          const Comp = wc.Component;
          return (
            <PluginMountBoundary
              key={entry.key}
              mountId={`${slotId}:${groupId || 'g'}:${tab.id}:${entry.key}`}
              slotId={slotId}
              pluginId={entry.pluginId}
              contributionId={wc.id}
              groupId={groupId}
              tabId={tab.id}
              depth={depth + 1}
              compactError={compactError}
              className={itemClassName}
            >
              <Comp groupId={groupId || ''} tab={tab} />
            </PluginMountBoundary>
          );
        }

        if (slotId === 'overlay.layer') {
          const oc = c as SlotContributionMap['overlay.layer'];
          if (zLayer && oc.zLayer !== zLayer) return null;
          const Comp = oc.Component;
          return (
            <PluginMountBoundary
              key={entry.key}
              mountId={`${slotId}:${entry.key}`}
              slotId={slotId}
              pluginId={entry.pluginId}
              contributionId={oc.id}
              depth={depth}
              compactError={compactError}
              className={itemClassName}
            >
              <Comp />
            </PluginMountBoundary>
          );
        }

        return null;
      })}
    </>
  );
};
