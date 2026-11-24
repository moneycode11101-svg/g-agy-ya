import React, { useEffect, useState } from 'react';
import type { BusChannelCategory, EventEdgeMetrics } from '../../kernel/client';

export interface StaticLinkDef {
  id: string;
  fromId: string;
  toId: string;
  kind: 'kernel' | 'dependency' | 'adapter-bridge';
}

interface ComputedLine {
  id: string;
  d: string;
  stroke: string;
  active: boolean;
  pulseDurationSec: number;
  width: number;
  dashed: boolean;
}

function categoryStroke(cat: BusChannelCategory): string {
  switch (cat) {
    case 'agent':
      return 'var(--accent)';
    case 'terminal':
      return 'var(--ok)';
    case 'telemetry':
      return '#9333ea';
    case 'error':
      return 'var(--danger)';
    case 'plugin':
      return '#0891b2';
    default:
      return 'var(--muted)';
  }
}

interface LiveEdgeSvgOverlayProps {
  containerRef: React.RefObject<HTMLDivElement | null>;
  nodeRefs: React.MutableRefObject<Map<string, HTMLElement>>;
  staticLinks: StaticLinkDef[];
  eventEdges: Record<string, EventEdgeMetrics>;
  selectedNodeId: string | null;
  enabled: boolean;
  layoutNonce: number;
}

/**
 * Lightweight SVG Cubic-Bezier edge overlay drawn above the 3-tier CSS Grid canvas.
 * Zero heavy graph library dependencies (~0KB); reflects live DeskEventBus traffic pulses.
 */
export const LiveEdgeSvgOverlay: React.FC<LiveEdgeSvgOverlayProps> = ({
  containerRef,
  nodeRefs,
  staticLinks,
  eventEdges,
  selectedNodeId,
  enabled,
  layoutNonce,
}) => {
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [lines, setLines] = useState<ComputedLine[]>([]);

  useEffect(() => {
    if (!enabled) {
      setLines([]);
      return;
    }

    let rafId = 0;
    const recompute = () => {
      const container = containerRef.current;
      if (!container) return;
      const cRect = container.getBoundingClientRect();
      setSize({ width: container.scrollWidth, height: container.scrollHeight });

      const scrollLeft = container.scrollLeft;
      const scrollTop = container.scrollTop;

      const resolveNodeEl = (id: string): HTMLElement | undefined => {
        if (id === 'kernel' || id === 'core' || id === 'renderer' || id === 'renderer-bridge') {
          return nodeRefs.current.get('__core__');
        }
        return nodeRefs.current.get(id);
      };

      const makeCurve = (fromEl: HTMLElement, toEl: HTMLElement): string => {
        const a = fromEl.getBoundingClientRect();
        const b = toEl.getBoundingClientRect();
        const ax = a.left - cRect.left + scrollLeft;
        const ay = a.top - cRect.top + scrollTop;
        const bx = b.left - cRect.left + scrollLeft;
        const by = b.top - cRect.top + scrollTop;

        const aCenterX = ax + a.width / 2;
        const bCenterX = bx + b.width / 2;
        const goingRight = bCenterX >= aCenterX;

        const x1 = goingRight ? ax + a.width : ax;
        const y1 = ay + a.height / 2;
        const x2 = goingRight ? bx : bx + b.width;
        const y2 = by + b.height / 2;
        const dx = Math.max(36, Math.abs(x2 - x1) * 0.45);
        const cx1 = goingRight ? x1 + dx : x1 - dx;
        const cx2 = goingRight ? x2 - dx : x2 + dx;
        return `M ${x1.toFixed(1)} ${y1.toFixed(1)} C ${cx1.toFixed(1)} ${y1.toFixed(1)}, ${cx2.toFixed(1)} ${y2.toFixed(1)}, ${x2.toFixed(1)} ${y2.toFixed(1)}`;
      };

      const out: ComputedLine[] = [];
      const seenPairs = new Set<string>();

      // 1) Live traffic edges from DeskEventBus (highest visual priority)
      const now = Date.now();
      for (const edge of Object.values(eventEdges)) {
        const fromEl = resolveNodeEl(edge.fromNodeId);
        const toEl = resolveNodeEl(edge.toNodeId);
        if (!fromEl || !toEl || fromEl === toEl) continue;
        const pairKey = `${edge.fromNodeId}->${edge.toNodeId}`;
        seenPairs.add(pairKey);

        const isRecent = now - edge.lastEventAt < 4500 || edge.eventsPerSec > 0.05;
        const emphasized =
          selectedNodeId === edge.fromNodeId ||
          selectedNodeId === edge.toNodeId ||
          (selectedNodeId === '__core__' && (edge.fromNodeId === 'kernel' || edge.toNodeId === 'kernel'));
        const intensity = Math.max(0.15, Math.min(1, edge.pulseIntensity));

        out.push({
          id: `live:${edge.edgeId}`,
          d: makeCurve(fromEl, toEl),
          stroke: categoryStroke(edge.category),
          active: isRecent,
          pulseDurationSec: Math.max(0.7, 2.4 - intensity * 1.5),
          width: emphasized ? 2.4 : isRecent ? 1.8 : 1.2,
          dashed: false,
        });
      }

      // 2) Structural links (Core -> Tier 1 -> Tier 2 Runtime Assets, dependencies)
      for (const link of staticLinks) {
        const fromEl = resolveNodeEl(link.fromId);
        const toEl = resolveNodeEl(link.toId);
        if (!fromEl || !toEl || fromEl === toEl) continue;
        const pairKey = `${link.fromId}->${link.toId}`;
        if (seenPairs.has(pairKey)) continue;

        const emphasized = selectedNodeId === link.fromId || selectedNodeId === link.toId;
        out.push({
          id: `static:${link.id}`,
          d: makeCurve(fromEl, toEl),
          stroke:
            link.kind === 'adapter-bridge'
              ? '#9333ea'
              : link.kind === 'dependency'
                ? 'var(--warn)'
                : 'var(--border-strong)',
          active: emphasized && link.kind === 'adapter-bridge',
          pulseDurationSec: 2.2,
          width: emphasized ? 1.8 : 1.1,
          dashed: link.kind !== 'adapter-bridge',
        });
      }

      setLines(out);
    };

    const schedule = () => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(recompute);
    };

    schedule();
    const el = containerRef.current;
    const ro = el ? new ResizeObserver(schedule) : null;
    if (el && ro) ro.observe(el);
    el?.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);

    return () => {
      cancelAnimationFrame(rafId);
      ro?.disconnect();
      el?.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
    };
  }, [containerRef, enabled, eventEdges, layoutNonce, nodeRefs, selectedNodeId, staticLinks]);

  if (!enabled || lines.length === 0 || size.width === 0) return null;

  return (
    <svg
      className="pointer-events-none absolute top-0 left-0 z-0"
      width={size.width}
      height={size.height}
      style={{ overflow: 'visible' }}
    >
      <defs>
        <style>{`
          @keyframes deskEdgeFlow {
            from { stroke-dashoffset: 28; }
            to { stroke-dashoffset: 0; }
          }
        `}</style>
      </defs>
      {lines.map((ln) => (
        <g key={ln.id}>
          <path
            d={ln.d}
            fill="none"
            stroke={ln.stroke}
            strokeWidth={ln.width}
            strokeOpacity={ln.active ? 0.55 : 0.35}
            strokeDasharray={ln.dashed ? '4 4' : undefined}
          />
          {ln.active && (
            <path
              d={ln.d}
              fill="none"
              stroke={ln.stroke}
              strokeWidth={ln.width + 0.8}
              strokeOpacity={0.9}
              strokeDasharray="6 22"
              strokeLinecap="round"
              style={{
                animation: `deskEdgeFlow ${ln.pulseDurationSec.toFixed(2)}s linear infinite`,
              }}
            />
          )}
        </g>
      ))}
    </svg>
  );
};
