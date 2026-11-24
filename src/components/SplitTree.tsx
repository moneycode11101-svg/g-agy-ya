import React, { useRef, useState } from 'react';
import { useLayoutStore, type LayoutNode } from '../kernel/client';
import { PaneGroupView } from './PaneGroupView';

interface SplitTreeProps {
  node: LayoutNode;
}

export const SplitTree: React.FC<SplitTreeProps> = ({ node }) => {
  const groups = useLayoutStore((s) => s.groups);
  const focusedGroupId = useLayoutStore((s) => s.focusedGroupId);
  const setSplitRatio = useLayoutStore((s) => s.setSplitRatio);
  const setDraggingOverlay = useLayoutStore((s) => s.setDraggingOverlay);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [dragging, setDragging] = useState(false);

  if (node.type === 'leaf') {
    const group = groups[node.groupId];
    if (!group) return null;
    return <PaneGroupView group={group} focused={focusedGroupId === group.id} />;
  }

  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    const el = wrapRef.current;
    if (!el) return;
    setDragging(true);
    // Activate zero-coupling CSS pointer shield (`[data-desk-dragging="true"] webview, iframe`)
    setDraggingOverlay(true);

    const rect = el.getBoundingClientRect();
    const onMove = (ev: MouseEvent) => {
      const ratio =
        node.dir === 'h'
          ? (ev.clientX - rect.left) / Math.max(1, rect.width)
          : (ev.clientY - rect.top) / Math.max(1, rect.height);
      setSplitRatio(node.id, ratio);
    };
    const onUp = () => {
      setDragging(false);
      setDraggingOverlay(false);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('blur', onUp);
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('blur', onUp);
  };

  return (
    <div
      ref={wrapRef}
      className={`flex-1 min-w-0 min-h-0 flex ${node.dir === 'h' ? 'flex-row' : 'flex-col'}`}
    >
      <div className="min-w-0 min-h-0 flex" style={{ flex: `${node.ratio} 1 0%` }}>
        <SplitTree node={node.a} />
      </div>
      <div
        onMouseDown={handleMouseDown}
        className={`${node.dir === 'h' ? 'split-handle-h' : 'split-handle-v'} ${dragging ? 'dragging' : ''}`}
      />
      <div className="min-w-0 min-h-0 flex" style={{ flex: `${1 - node.ratio} 1 0%` }}>
        <SplitTree node={node.b} />
      </div>
    </div>
  );
};
