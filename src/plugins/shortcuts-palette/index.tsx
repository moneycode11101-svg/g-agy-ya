import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Command, Keyboard, Search, X } from 'lucide-react';
import { create } from 'zustand';
import {
  useCommandRegistry,
  useSlotRegistry,
  type BuiltinPluginPackage,
  type ClientPluginModule,
  type DeskClientContext,
  type PaneTypeDefinition,
} from '../../kernel/client';
import { shortcutsPaletteManifest } from './manifest';

interface PaletteState {
  open: boolean;
  openPalette: () => void;
  closePalette: () => void;
  togglePalette: () => void;
}

const usePaletteStore = create<PaletteState>((set) => ({
  open: false,
  openPalette: () => set({ open: true }),
  closePalette: () => set({ open: false }),
  togglePalette: () => set((s) => ({ open: !s.open })),
}));

function formatShortcutLabel(raw?: string): string {
  if (!raw) return '';
  const isMac = window.deskKernel?.env.platform === 'darwin' || navigator.platform.toLowerCase().includes('mac');
  return raw
    .split('+')
    .map((p) => {
      const low = p.trim().toLowerCase();
      if (low === 'mod' || low === 'cmd' || low === 'cmdorctrl') return isMac ? '⌘' : 'Ctrl';
      if (low === 'shift') return isMac ? '⇧' : 'Shift';
      if (low === 'alt' || low === 'opt') return isMac ? '⌥' : 'Alt';
      return p.trim().toUpperCase();
    })
    .join(isMac ? '' : '+');
}

interface PaletteEntry {
  id: string;
  title: string;
  subtitle: string;
  shortcut?: string;
  run: () => void | Promise<void>;
}

function createCommandPalette(ctx: DeskClientContext): React.FC {
  return function CommandPaletteOverlay() {
    const open = usePaletteStore((s) => s.open);
    const closePalette = usePaletteStore((s) => s.closePalette);
    const commandsMap = useCommandRegistry((s) => s.commands);
    const paneEntries = useSlotRegistry((s) => s.bySlot['pane.type']);
    const getEntries = useSlotRegistry((s) => s.getEntries);

    const [query, setQuery] = useState('');
    const [selectedIdx, setSelectedIdx] = useState(0);
    const inputRef = useRef<HTMLInputElement | null>(null);

    const allItems = useMemo<PaletteEntry[]>(() => {
      void paneEntries;
      const list: PaletteEntry[] = [];

      for (const cmd of Object.values(commandsMap)) {
        if (cmd.id === 'palette:open') continue;
        if (cmd.when && !cmd.when()) continue;
        list.push({
          id: `cmd:${cmd.id}`,
          title: cmd.title,
          subtitle: cmd.pluginId ? `명령 · ${cmd.pluginId}` : '커널 명령',
          shortcut: cmd.shortcut,
          run: () => cmd.run(),
        });
      }

      const panes = getEntries('pane.type')
        .map((e) => e.contribution as unknown as PaneTypeDefinition)
        .filter((p) => p.type !== 'launcher');

      for (const pane of panes) {
        list.push({
          id: `pane-split:${pane.type}`,
          title: `분할로 열기: ${pane.label}`,
          subtitle: `패인 · ${pane.ownerPluginId || pane.type}`,
          run: () => {
            ctx.workspace.openTab(pane.type, undefined, { split: 'h' });
          },
        });
      }

      return list;
    }, [commandsMap, getEntries, paneEntries]);

    const filtered = useMemo(() => {
      const q = query.trim().toLowerCase();
      if (!q) return allItems;
      return allItems.filter(
        (item) => item.title.toLowerCase().includes(q) || item.subtitle.toLowerCase().includes(q)
      );
    }, [allItems, query]);

    useEffect(() => {
      if (open) {
        setQuery('');
        setSelectedIdx(0);
        requestAnimationFrame(() => inputRef.current?.focus());
      }
    }, [open]);

    useEffect(() => {
      setSelectedIdx(0);
    }, [query]);

    if (!open) return null;

    const executeItem = (item?: PaletteEntry) => {
      if (!item) return;
      closePalette();
      void Promise.resolve(item.run()).catch((err) => {
        console.error('[CommandPalette] command failed:', err);
      });
    };

    return (
      <div
        className="fixed inset-0 z-[80] flex items-start justify-center pt-[14vh] px-4"
        style={{ background: 'rgba(10, 12, 16, 0.36)', backdropFilter: 'blur(2px)' }}
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) closePalette();
        }}
      >
        <div
          className="w-full max-w-[540px] rounded-2xl border overflow-hidden"
          style={{
            background: 'var(--card)',
            borderColor: 'var(--border-strong)',
            boxShadow: 'var(--shadow-popover)',
            color: 'var(--fg)',
          }}
        >
          <div className="px-3.5 py-2.5 border-b flex items-center gap-2" style={{ borderColor: 'var(--border)' }}>
            <Search size={15} style={{ color: 'var(--muted)' }} />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.preventDefault();
                  closePalette();
                } else if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setSelectedIdx((i) => Math.min(Math.max(0, filtered.length - 1), i + 1));
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setSelectedIdx((i) => Math.max(0, i - 1));
                } else if (e.key === 'Enter') {
                  e.preventDefault();
                  executeItem(filtered[selectedIdx]);
                }
              }}
              placeholder="명령 또는 패인 플러그인 검색..."
              className="flex-1 bg-transparent outline-none text-[13.5px]"
              style={{ color: 'var(--fg)' }}
            />
            <button
              type="button"
              onClick={closePalette}
              className="p-1 rounded hover:bg-[var(--surface)] cursor-pointer"
              style={{ color: 'var(--muted)' }}
            >
              <X size={14} />
            </button>
          </div>

          <div className="max-h-[340px] overflow-y-auto scroll-thin p-1.5 space-y-0.5">
            {filtered.length === 0 ? (
              <div className="py-8 text-center text-[12.5px]" style={{ color: 'var(--muted)' }}>
                일치하는 명령이 없습니다.
              </div>
            ) : (
              filtered.map((item, idx) => {
                const isSelected = idx === selectedIdx;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onMouseEnter={() => setSelectedIdx(idx)}
                    onClick={() => executeItem(item)}
                    className="w-full px-3 py-2 rounded-xl flex items-center justify-between gap-3 text-left cursor-pointer transition-colors"
                    style={{
                      background: isSelected ? 'var(--surface-active)' : 'transparent',
                      color: 'var(--fg)',
                    }}
                  >
                    <div className="min-w-0">
                      <div className="text-[13px] font-medium truncate">{item.title}</div>
                      <div className="text-[11px] truncate" style={{ color: 'var(--muted)' }}>
                        {item.subtitle}
                      </div>
                    </div>
                    {item.shortcut && (
                      <kbd
                        className="shrink-0 px-2 py-0.5 rounded-md border text-[11px] font-mono"
                        style={{ background: 'var(--bg)', borderColor: 'var(--border)', color: 'var(--muted)' }}
                      >
                        {formatShortcutLabel(item.shortcut)}
                      </kbd>
                    )}
                  </button>
                );
              })
            )}
          </div>
        </div>
      </div>
    );
  };
}

const DynamicShortcutsSettingsSection: React.FC = () => {
  const commandsMap = useCommandRegistry((s) => s.commands);
  const items = useMemo(
    () =>
      Object.values(commandsMap).sort((a, b) => {
        const sa = a.shortcut ? 0 : 1;
        const sb = b.shortcut ? 0 : 1;
        return sa - sb || a.title.localeCompare(b.title);
      }),
    [commandsMap]
  );

  return (
    <div className="space-y-3">
      <div className="text-[12px]" style={{ color: 'var(--muted)' }}>
        현재 활성화된 플러그인들이 등록한 실시간 명령 및 키보드 단축키 목록입니다 ({items.length}개).
      </div>
      <div
        className="rounded-xl border divide-y overflow-hidden"
        style={{ background: 'var(--card)', borderColor: 'var(--border)' }}
      >
        {items.map((cmd) => (
          <div
            key={cmd.id}
            className="px-4 py-2.5 flex items-center justify-between gap-3"
            style={{ borderColor: 'var(--border)' }}
          >
            <div className="min-w-0">
              <div className="text-[13px] font-medium truncate" style={{ color: 'var(--fg)' }}>
                {cmd.title}
              </div>
              <div className="text-[11px] font-mono truncate" style={{ color: 'var(--muted)' }}>
                {cmd.pluginId || 'kernel'} · {cmd.id}
              </div>
            </div>
            {cmd.shortcut ? (
              <kbd
                className="shrink-0 px-2 py-0.5 rounded-md border text-[11.5px] font-mono"
                style={{ background: 'var(--surface)', borderColor: 'var(--border)', color: 'var(--fg-soft)' }}
              >
                {formatShortcutLabel(cmd.shortcut)}
              </kbd>
            ) : (
              <span className="text-[11px]" style={{ color: 'var(--muted)' }}>
                팔레트 전용
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};

export const shortcutsPaletteClient: ClientPluginModule = {
  activate(ctx) {
    ctx.commands.register({
      id: 'palette:open',
      title: '커맨드 팔레트 열기',
      shortcut: 'Mod+K',
      run: () => usePaletteStore.getState().togglePalette(),
    });

    ctx.slots.register('overlay.layer', {
      id: 'command-palette',
      zLayer: 'popover',
      order: 30,
      Component: createCommandPalette(ctx),
    });

    ctx.slots.register('settings.section', {
      id: 'shortcuts',
      group: '알림 · 시스템',
      title: '단축키 · 커맨드',
      description: '활성 플러그인의 키보드 단축키 및 ⌘K 커맨드 팔레트 목록',
      icon: Keyboard,
      order: 70,
      Component: DynamicShortcutsSettingsSection,
      searchEntries: [
        {
          id: 'shortcuts:palette',
          title: '커맨드 팔레트 (⌘K)',
          description: '모든 활성 플러그인 명령 검색 및 실행',
          keywords: '단축키 키보드 커맨드 팔레트 shortcuts command palette ⌘K',
        },
      ],
    });
  },
};

export const shortcutsPaletteClientPackage: BuiltinPluginPackage = {
  manifest: shortcutsPaletteManifest,
  client: shortcutsPaletteClient,
};

export { Command as ShortcutsIcon };
