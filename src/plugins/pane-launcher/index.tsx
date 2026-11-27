import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, Columns2, LayoutGrid, Rows2, Search, Trash2 } from 'lucide-react';
import {
  useLayoutStore,
  useSlotRegistry,
  type BuiltinPluginPackage,
  type ClientPluginModule,
  type DeskClientContext,
  type PaneComponentProps,
  type PaneTypeDefinition,
} from '../../kernel/client';
import { paneLauncherManifest } from './manifest';

export interface LauncherTabState extends Record<string, unknown> {
  cwd?: string;
}

export { paneLauncherManifest };

function createLauncherComponent(ctx: DeskClientContext): React.FC<PaneComponentProps<LauncherTabState>> {
  return function DynamicLauncherPane({ groupId, tab }) {
    const convertTab = useLayoutStore((s) => s.convertTab);
    const splitGroup = useLayoutStore((s) => s.splitGroup);
    const closeSplitPane = useLayoutStore((s) => s.closeSplitPane);
    const groups = useLayoutStore((s) => s.groups);
    // Dynamically react to active pane plugins (including Plugin Studio & mounted local plugins!)
    const paneSlotEntries = useSlotRegistry((s) => s.bySlot['pane.type']);
    const getEntries = useSlotRegistry((s) => s.getEntries);

    const [omnibox, setOmnibox] = useState('');
    const inputRef = useRef<HTMLInputElement | null>(null);

    useEffect(() => {
      inputRef.current?.focus();
    }, []);

    const registeredPanes = useMemo<PaneTypeDefinition[]>(() => {
      void paneSlotEntries;
      return getEntries('pane.type')
        .map((e) => e.contribution as unknown as PaneTypeDefinition)
        .filter((p) => p.type !== 'launcher' && p.showInLauncher !== false);
    }, [getEntries, paneSlotEntries]);

    const cwd = typeof tab.state.cwd === 'string' && tab.state.cwd ? tab.state.cwd : window.deskKernel?.env.homeDir || '/';
    const totalGroups = Object.keys(groups).length;
    const q = omnibox.trim();
    const qLower = q.toLowerCase();

    const filteredPanes = useMemo(() => {
      if (!qLower) return registeredPanes;
      return registeredPanes.filter(
        (p) =>
          p.label.toLowerCase().includes(qLower) ||
          p.type.toLowerCase().includes(qLower) ||
          (p.description || '').toLowerCase().includes(qLower)
      );
    }, [qLower, registeredPanes]);

    const omniboxMatches = useMemo(() => {
      if (!q) return [];
      const matches: Array<{ pane: PaneTypeDefinition; score: number; label: string; init: Record<string, unknown> }> = [];
      for (const pane of registeredPanes) {
        const m = pane.matchOmnibox?.(q);
        if (m) matches.push({ pane, ...m });
      }
      return matches.sort((a, b) => b.score - a.score);
    }, [q, registeredPanes]);

    const handleSubmitOmnibox = (e: React.FormEvent) => {
      e.preventDefault();
      if (!q) return;
      if (omniboxMatches.length > 0) {
        const best = omniboxMatches[0];
        convertTab(groupId, tab.id, best.pane.type, { cwd, ...best.init });
        return;
      }
      if (filteredPanes.length > 0) {
        convertTab(groupId, tab.id, filteredPanes[0].type, { cwd });
        return;
      }
      // Fallback: if webview plugin exists, open search/url in webview
      const hasWebview = registeredPanes.some((p) => p.type === 'webview');
      if (hasWebview) {
        convertTab(groupId, tab.id, 'webview', { url: q });
      }
    };

    const handleContextMenu = (e: React.MouseEvent) => {
      e.preventDefault();
      ctx.ui.showContextMenu(e.clientX, e.clientY, [
        ...registeredPanes.map((p) => {
          const Icon = p.icon;
          return {
            type: 'item' as const,
            label: `${p.label} 열기`,
            icon: <Icon size={13} />,
            onSelect: () => convertTab(groupId, tab.id, p.type, { cwd }),
          };
        }),
        { type: 'separator' },
        { type: 'item', label: '오른쪽으로 분할', icon: <Columns2 size={13} />, shortcut: '⌘D', onSelect: () => splitGroup(groupId, 'h', 'launcher') },
        { type: 'item', label: '아래로 분할', icon: <Rows2 size={13} />, shortcut: '⌘⇧D', onSelect: () => splitGroup(groupId, 'v', 'launcher') },
        ...(totalGroups > 1
          ? [
              { type: 'separator' as const },
              {
                type: 'item' as const,
                label: '이 분할 창 닫기',
                icon: <Trash2 size={13} />,
                danger: true,
                onSelect: () => void closeSplitPane(groupId),
              },
            ]
          : []),
      ]);
    };

    return (
      <div
        className="flex-1 min-h-0 overflow-y-auto scroll-thin flex items-start @[420px]:items-center justify-center p-3.5 @[420px]:p-6 @container"
        style={{ background: 'var(--bg)' }}
        onContextMenu={handleContextMenu}
      >
        <div className="w-full max-w-[480px] space-y-4 @[420px]:space-y-5">
          <div className="space-y-1">
            <h2 className="text-[16px] font-semibold tracking-tight" style={{ color: 'var(--fg)' }}>
              이 분할 창에 무엇을 열까요?
            </h2>
            <p className="text-[12.5px]" style={{ color: 'var(--muted)' }}>
              활성화된 패인 플러그인 {registeredPanes.length}종 중 선택하거나 검색·URL을 입력하세요.
            </p>
          </div>

          <form onSubmit={handleSubmitOmnibox} className="relative">
            <div
              className="flex items-center gap-2 px-3.5 py-2.5 rounded-xl border transition-colors focus-within:border-[var(--accent)]"
              style={{ background: 'var(--card)', borderColor: 'var(--border-strong)', boxShadow: 'var(--shadow-sm)' }}
            >
              <Search size={14} style={{ color: 'var(--muted)' }} className="shrink-0" />
              <input
                ref={inputRef}
                type="text"
                value={omnibox}
                onChange={(e) => setOmnibox(e.target.value)}
                placeholder="패인 이름, 명령어(term, studio), 또는 URL 입력..."
                className="flex-1 bg-transparent outline-none text-[13px]"
                style={{ color: 'var(--fg)' }}
              />
              {q && (
                <button
                  type="submit"
                  className="p-1 rounded-md cursor-pointer"
                  style={{ background: 'var(--accent)', color: '#fff' }}
                  title="열기"
                >
                  <ArrowRight size={13} />
                </button>
              )}
            </div>
          </form>

          {omniboxMatches.length > 0 && (
            <div
              className="rounded-xl border divide-y overflow-hidden"
              style={{ background: 'var(--card)', borderColor: 'var(--border)' }}
            >
              {omniboxMatches.slice(0, 3).map((m) => {
                const Icon = m.pane.icon;
                return (
                  <button
                    key={`${m.pane.type}:${m.label}`}
                    type="button"
                    onClick={() => convertTab(groupId, tab.id, m.pane.type, { cwd, ...m.init })}
                    className="w-full px-3 py-2 flex items-center justify-between gap-2 text-left text-[12.5px] cursor-pointer hover:bg-[var(--surface)]"
                    style={{ borderColor: 'var(--border)', color: 'var(--fg)' }}
                  >
                    <span className="flex items-center gap-2 min-w-0">
                      <Icon size={14} />
                      <span className="truncate font-medium">{m.label}</span>
                    </span>
                    <span className="text-[11px] font-mono shrink-0" style={{ color: 'var(--muted)' }}>
                      ↵
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          {/* 동적 패인 플러그인 카드 그리드 (내장 + 로컬 마운트 플러그인 자동 반영) */}
          <div className="grid grid-cols-1 @[360px]:grid-cols-2 gap-2.5">
            {filteredPanes.map((pane) => {
              const Icon = pane.icon;
              const accent = pane.accentColor || 'var(--accent)';
              return (
                <button
                  key={pane.type}
                  type="button"
                  onClick={() => convertTab(groupId, tab.id, pane.type, { cwd })}
                  className="group text-left rounded-xl border p-3.5 cursor-pointer transition-all hover:border-[var(--border-strong)] hover:bg-[var(--surface)]"
                  style={{ background: 'var(--card)', borderColor: 'var(--border)', boxShadow: 'var(--shadow-sm)' }}
                >
                  <div className="flex items-center justify-between mb-2">
                    <span
                      className="w-8 h-8 rounded-lg flex items-center justify-center"
                      style={{
                        background: `color-mix(in srgb, ${accent} 13%, transparent)`,
                        color: accent,
                      }}
                    >
                      <Icon size={16} />
                    </span>
                    {pane.shortcut && (
                      <span className="text-[10.5px] font-mono" style={{ color: 'var(--muted)' }}>
                        {pane.shortcut}
                      </span>
                    )}
                  </div>
                  <div className="text-[13px] font-semibold truncate" style={{ color: 'var(--fg)' }}>
                    {pane.label}
                  </div>
                  <div className="text-[11.5px] mt-0.5 truncate" style={{ color: 'var(--muted)' }}>
                    {pane.description || pane.ownerPluginId || pane.type}
                  </div>
                </button>
              );
            })}
          </div>

          {filteredPanes.length === 0 && (
            <div className="text-center py-4 text-[12px]" style={{ color: 'var(--muted)' }}>
              일치하는 활성 패인 플러그인이 없습니다.
            </div>
          )}
        </div>
      </div>
    );
  };
}

export const paneLauncherClient: ClientPluginModule = {
  activate(ctx) {
    ctx.panes.registerType<LauncherTabState>({
      type: 'launcher',
      label: '새 창 선택',
      description: '분할 창 런처',
      icon: LayoutGrid,
      keepAlive: 'never',
      showInLauncher: false,
      showInOmnibox: false,
      order: 1,
      createDefaultState: (init) => ({
        title: '새 창 선택',
        state: {
          cwd: typeof init?.cwd === 'string' ? init.cwd : window.deskKernel?.env.homeDir || '/',
        },
      }),
      Component: createLauncherComponent(ctx),
    });

    ctx.commands.register({
      id: 'pane-launcher:split-right',
      title: '오른쪽으로 분할 (새 창 선택)',
      shortcut: 'Mod+D',
      run: () => {
        const focused = useLayoutStore.getState().focusedGroupId;
        useLayoutStore.getState().splitGroup(focused, 'h', 'launcher');
      },
    });

    ctx.commands.register({
      id: 'pane-launcher:split-down',
      title: '아래로 분할 (새 창 선택)',
      shortcut: 'Mod+Shift+D',
      run: () => {
        const focused = useLayoutStore.getState().focusedGroupId;
        useLayoutStore.getState().splitGroup(focused, 'v', 'launcher');
      },
    });

    ctx.slots.register('titlebar.actions', {
      id: 'split-right',
      zone: 'right',
      order: 30,
      Component: () => (
        <button
          type="button"
          onClick={() => {
            const focused = useLayoutStore.getState().focusedGroupId;
            useLayoutStore.getState().splitGroup(focused, 'h', 'launcher');
          }}
          className="p-1.5 rounded-lg hover:bg-[var(--surface)] cursor-pointer transition-colors"
          style={{ color: 'var(--muted)' }}
          title="오른쪽으로 분할 (⌘D) — 새 창 선택"
        >
          <Columns2 size={15} />
        </button>
      ),
    });

    ctx.slots.register('titlebar.actions', {
      id: 'split-down',
      zone: 'right',
      order: 35,
      Component: () => (
        <button
          type="button"
          onClick={() => {
            const focused = useLayoutStore.getState().focusedGroupId;
            useLayoutStore.getState().splitGroup(focused, 'v', 'launcher');
          }}
          className="p-1.5 rounded-lg hover:bg-[var(--surface)] cursor-pointer transition-colors"
          style={{ color: 'var(--muted)' }}
          title="아래로 분할 (⌘⇧D) — 새 창 선택"
        >
          <Rows2 size={15} />
        </button>
      ),
    });
  },
};

export const paneLauncherClientPackage: BuiltinPluginPackage = {
  manifest: paneLauncherManifest,
  client: paneLauncherClient,
};
