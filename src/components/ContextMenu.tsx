import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import {
  TAB_COLOR_SWATCHES,
  useContextMenuStore,
  type ContextMenuItem,
} from '../store/contextMenuStore';

const MenuList: React.FC<{
  items: ContextMenuItem[];
  onClose: () => void;
  flipSubmenuLeft?: boolean;
}> = ({ items, onClose, flipSubmenuLeft = false }) => {
  const [openSubIndex, setOpenSubIndex] = useState<number | null>(null);

  return (
    <div
      className="min-w-[204px] max-w-[260px] rounded-xl border p-1 text-[12.5px] select-none"
      style={{
        background: 'var(--card)',
        borderColor: 'var(--border-strong)',
        boxShadow: 'var(--shadow-popover)',
        color: 'var(--fg)',
      }}
    >
      {items.map((item, idx) => {
        if (item.type === 'separator') {
          return <div key={idx} className="my-1 h-px" style={{ background: 'var(--border)' }} />;
        }
        if (item.type === 'label') {
          return (
            <div
              key={idx}
              className="px-2.5 pt-1.5 pb-1 text-[10.5px] font-semibold"
              style={{ color: 'var(--muted)' }}
            >
              {item.label}
            </div>
          );
        }
        if (item.type === 'color-picker') {
          return (
            <div key={idx} className="px-2.5 py-1.5">
              <div className="text-[10.5px] font-semibold mb-1.5" style={{ color: 'var(--muted)' }}>
                {item.label}
              </div>
              <div className="flex items-center gap-1.5">
                {TAB_COLOR_SWATCHES.map((sw) => {
                  const selected = (item.value ?? null) === sw.value;
                  return (
                    <button
                      key={sw.label}
                      type="button"
                      title={sw.label}
                      onClick={() => {
                        item.onSelect(sw.value);
                        onClose();
                      }}
                      className="w-4 h-4 rounded-full cursor-pointer transition-transform hover:scale-115 flex items-center justify-center"
                      style={{
                        background: sw.value || 'transparent',
                        border: sw.value ? '1px solid transparent' : '1.5px solid var(--border-strong)',
                        boxShadow: selected ? '0 0 0 2px var(--card), 0 0 0 3.5px var(--fg)' : undefined,
                      }}
                    >
                      {!sw.value && (
                        <span className="block w-2.5 h-[1.5px] -rotate-45" style={{ background: 'var(--muted)' }} />
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        }
        if (item.type === 'submenu') {
          const isOpen = openSubIndex === idx;
          return (
            <div
              key={idx}
              className="relative"
              onMouseEnter={() => setOpenSubIndex(idx)}
              onMouseLeave={() => setOpenSubIndex((prev) => (prev === idx ? null : prev))}
            >
              <button
                type="button"
                className="w-full flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg text-left cursor-pointer transition-colors hover:bg-[var(--surface)]"
                style={{ background: isOpen ? 'var(--surface)' : undefined }}
              >
                <span className="flex items-center gap-2 min-w-0">
                  {item.icon && <span className="shrink-0 opacity-75">{item.icon}</span>}
                  <span className="truncate">{item.label}</span>
                </span>
                <ChevronRight size={13} style={{ color: 'var(--muted)' }} />
              </button>
              {isOpen && (
                <div
                  className={`absolute top-0 z-[110] ${
                    flipSubmenuLeft ? 'right-full pr-1' : 'left-full pl-1'
                  }`}
                >
                  <MenuList items={item.items} onClose={onClose} flipSubmenuLeft={flipSubmenuLeft} />
                </div>
              )}
            </div>
          );
        }

        return (
          <button
            key={idx}
            type="button"
            disabled={item.disabled}
            onMouseEnter={() => setOpenSubIndex(null)}
            onClick={() => {
              if (item.disabled) return;
              onClose();
              item.onSelect();
            }}
            className="w-full flex items-center justify-between gap-3 px-2.5 py-1.5 rounded-lg text-left cursor-pointer transition-colors hover:bg-[var(--surface)] disabled:opacity-40 disabled:cursor-default"
            style={{ color: item.danger ? 'var(--danger)' : 'var(--fg)' }}
          >
            <span className="flex items-center gap-2 min-w-0">
              {item.icon && <span className="shrink-0 opacity-80">{item.icon}</span>}
              <span className="truncate">{item.label}</span>
            </span>
            {item.shortcut && (
              <span className="text-[11px] font-mono shrink-0" style={{ color: 'var(--muted)' }}>
                {item.shortcut}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
};

export const GlobalContextMenu: React.FC = () => {
  const open = useContextMenuStore((s) => s.open);
  const x = useContextMenuStore((s) => s.x);
  const y = useContextMenuStore((s) => s.y);
  const items = useContextMenuStore((s) => s.items);
  const closeMenu = useContextMenuStore((s) => s.closeMenu);

  const menuRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    if (!open) return;
    const el = menuRef.current;
    const w = el?.offsetWidth || 220;
    const h = el?.offsetHeight || 260;
    const pad = 8;
    const left = Math.min(Math.max(pad, x), Math.max(pad, window.innerWidth - w - pad));
    const top = Math.min(Math.max(pad, y), Math.max(pad, window.innerHeight - h - pad));
    setPos({ left, top });
  }, [open, x, y, items]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeMenu();
    };
    const onBlur = () => closeMenu();
    window.addEventListener('keydown', onKey);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('blur', onBlur);
    };
  }, [open, closeMenu]);

  if (!open || items.length === 0) return null;

  return (
    <div
      className="fixed inset-0 z-[100]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) closeMenu();
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        closeMenu();
      }}
    >
      <div
        ref={menuRef}
        className="fixed z-[101]"
        style={{ left: pos.left, top: pos.top }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <MenuList
          items={items}
          onClose={closeMenu}
          flipSubmenuLeft={pos.left + 440 > window.innerWidth}
        />
      </div>
    </div>
  );
};
