import React, { useEffect, useRef, useState } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { Columns2, Copy, Eraser, FolderOpen, RotateCw, Rows2, Terminal as TerminalIcon, Trash2 } from 'lucide-react';
import {
  BUILTIN_PLUGIN_IDS,
  useCommandRegistry,
  useLayoutStore,
  usePluginConfigStore,
  type BuiltinPluginPackage,
  type ClientPluginModule,
  type ConfigFieldSchema,
  type DeskClientContext,
  type PaneComponentProps,
  type PluginManifest,
} from '../../kernel/client';

export interface TerminalTabState extends Record<string, unknown> {
  terminalId: string;
  cwd: string;
}

interface TerminalBusEvent {
  type: 'data' | 'exit';
  terminalId: string;
  data?: string;
  exitCode?: number;
}

const configSchema: readonly ConfigFieldSchema[] = [
  {
    key: 'fontSizePx',
    label: '터미널 글꼴 크기',
    description: 'xterm.js 인터랙티브 셸 폰트 크기(px)',
    group: '터미널',
    type: 'number',
    widget: 'slider',
    defaultValue: 13,
    min: 10,
    max: 20,
    step: 1,
    keywords: ['터미널', '글꼴', '폰트', 'terminal', 'font'],
  },
  {
    key: 'scrollback',
    label: '스크롤백 줄 수',
    description: '터미널 버퍼에 유지할 최대 출력 줄 수입니다.',
    group: '터미널',
    type: 'number',
    defaultValue: 5000,
    min: 500,
    max: 25000,
    step: 500,
    keywords: ['스크롤백', '버퍼', 'scrollback', 'terminal'],
  },
];

export const paneTerminalClientManifest: PluginManifest = {
  id: BUILTIN_PLUGIN_IDS.PANE_TERMINAL,
  name: '인터랙티브 터미널 (zsh)',
  version: '1.0.0',
  apiVersion: '^1.0.0',
  description: 'xterm.js + Python PTY 브리지 기반 실시간 인터랙티브 셸 패인',
  layer: 'app',
  category: 'pane',
  icon: 'Terminal',
  impactClass: 'stateful-pane',
  defaultEnabled: true,
  entry: {
    host: './electron/plugins/pane-terminal/index.ts',
    client: './src/plugins/pane-terminal/index.tsx',
  },
  capabilities: ['process:spawn', 'fs:read'],
  configSchema,
  contributes: {
    slots: ['pane.type', 'titlebar.actions', 'sidebar.section', 'settings.section'],
    paneTypes: [{ type: 'terminal', label: '터미널 (zsh)', icon: 'Terminal' }],
    commands: [{ id: 'pane-terminal:new-tab', title: '새 터미널 열기', defaultShortcut: 'Mod+Shift+T' }],
  },
};

function getXtermTheme(isDark: boolean) {
  if (isDark) {
    return {
      background: '#111317',
      foreground: '#eef1f6',
      cursor: '#4c8dff',
      cursorAccent: '#111317',
      selectionBackground: 'rgba(76, 141, 255, 0.32)',
      black: '#1e222a',
      red: '#f87171',
      green: '#4ade80',
      yellow: '#facc15',
      blue: '#60a5fa',
      magenta: '#c084fc',
      cyan: '#22d3ee',
      white: '#e2e8f0',
      brightBlack: '#64748b',
      brightRed: '#fca5a5',
      brightGreen: '#86efac',
      brightYellow: '#fde047',
      brightBlue: '#93c5fd',
      brightMagenta: '#d8b4fe',
      brightCyan: '#67e8f9',
      brightWhite: '#ffffff',
    };
  }
  return {
    background: '#fafafa',
    foreground: '#181a1f',
    cursor: '#3b82f6',
    cursorAccent: '#ffffff',
    selectionBackground: 'rgba(59, 130, 246, 0.22)',
    black: '#1f2937',
    red: '#dc2626',
    green: '#16a34a',
    yellow: '#ca8a04',
    blue: '#2563eb',
    magenta: '#9333ea',
    cyan: '#0891b2',
    white: '#e5e7eb',
    brightBlack: '#6b7280',
    brightRed: '#ef4444',
    brightGreen: '#22c55e',
    brightYellow: '#eab308',
    brightBlue: '#3b82f6',
    brightMagenta: '#a855f7',
    brightCyan: '#06b6d4',
    brightWhite: '#ffffff',
  };
}

function detectDarkDom(): boolean {
  if (typeof document !== 'undefined' && document.documentElement.dataset.theme) {
    return document.documentElement.dataset.theme === 'dark';
  }
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches;
}

function createTerminalComponent(ctx: DeskClientContext): React.FC<PaneComponentProps<TerminalTabState>> {
  return function TerminalPaneView({ groupId, tab, active }) {
    const splitGroup = useLayoutStore((s) => s.splitGroup);
    const closeTab = useLayoutStore((s) => s.closeTab);
    const cfg = usePluginConfigStore((s) => s.configsByPlugin[BUILTIN_PLUGIN_IDS.PANE_TERMINAL] || {});
    const fontSizePx = typeof cfg.fontSizePx === 'number' ? cfg.fontSizePx : 13;
    const scrollback = typeof cfg.scrollback === 'number' ? cfg.scrollback : 5000;

    const terminalId = typeof tab.state.terminalId === 'string' ? tab.state.terminalId : tab.id;
    const cwd = typeof tab.state.cwd === 'string' && tab.state.cwd ? tab.state.cwd : window.deskKernel?.env.homeDir || '/';

    const containerRef = useRef<HTMLDivElement | null>(null);
    const termRef = useRef<Terminal | null>(null);
    const fitRef = useRef<FitAddon | null>(null);
    const [exitedCode, setExitedCode] = useState<number | null>(null);
    const [bootNonce, setBootNonce] = useState(0);
    const [isDark, setIsDark] = useState<boolean>(detectDarkDom);

    useEffect(() => {
      const offTheme = ctx.bus.subscribe('theme:changed', () => {
        const nextDark = detectDarkDom();
        setIsDark(nextDark);
        if (termRef.current) {
          termRef.current.options.theme = getXtermTheme(nextDark);
        }
      });
      return () => {
        void offTheme();
      };
    }, []);

    useEffect(() => {
      if (termRef.current) {
        termRef.current.options.fontSize = fontSizePx;
        try {
          fitRef.current?.fit();
          ctx.rpc.notify('pane-terminal:resize', {
            terminalId,
            cols: termRef.current.cols,
            rows: termRef.current.rows,
          });
        } catch {
          // ignore
        }
      }
    }, [fontSizePx, terminalId]);

    useEffect(() => {
      const el = containerRef.current;
      if (!el) return;

      const term = new Terminal({
        cursorBlink: true,
        fontSize: fontSizePx,
        lineHeight: 1.35,
        fontFamily: '"JetBrains Mono", Menlo, Monaco, "SF Mono", ui-monospace, monospace',
        scrollback,
        theme: getXtermTheme(detectDarkDom()),
        allowProposedApi: true,
      });
      const fitAddon = new FitAddon();
      const linksAddon = new WebLinksAddon((_ev, uri) => {
        const hasLinkCmd = Boolean(useCommandRegistry.getState().commands['link:open']);
        if (hasLinkCmd) {
          void ctx.commands.execute('link:open', uri);
        } else {
          void ctx.rpc.invoke('kernel:shell:open-external', { url: uri }).catch(() => {});
        }
      });

      term.loadAddon(fitAddon);
      term.loadAddon(linksAddon);
      term.open(el);
      termRef.current = term;
      fitRef.current = fitAddon;

      const safeFit = () => {
        try {
          if (el.clientWidth > 20 && el.clientHeight > 20) {
            fitAddon.fit();
            ctx.rpc.notify('pane-terminal:resize', {
              terminalId,
              cols: term.cols,
              rows: term.rows,
            });
          }
        } catch {
          // ignore layout race
        }
      };

      requestAnimationFrame(() => {
        safeFit();
        setExitedCode(null);
        void ctx.rpc
          .invoke<{ ok: boolean; error?: string; replay?: string }>('pane-terminal:create', {
            terminalId,
            cwd,
            cols: term.cols || 80,
            rows: term.rows || 24,
          })
          .then((res) => {
            if (res?.replay) {
              term.write(res.replay);
            } else if (res && !res.ok && res.error) {
              term.write(`\r\n[터미널 시작 실패] ${res.error}\r\n`);
            }
          })
          .catch(() => {});
      });

      const onDataDisposable = term.onData((data) => {
        ctx.rpc.notify('pane-terminal:write', { terminalId, data });
      });

      const offTermEvent = ctx.bus.subscribe<TerminalBusEvent>('terminal:event', (env) => {
        const ev = env.payload;
        if (!ev || ev.terminalId !== terminalId) return;
        if (ev.type === 'data' && ev.data) {
          term.write(ev.data);
        } else if (ev.type === 'exit') {
          setExitedCode(ev.exitCode ?? 0);
        }
      });

      const ro = new ResizeObserver(() => {
        requestAnimationFrame(safeFit);
      });
      ro.observe(el);

      // Note: intentionally do NOT kill Host PTY on React unmount (supports Client HMR without losing running shell!).
      // Host PTY is killed strictly in `onTabDispose` when user actually closes the tab.
      return () => {
        ro.disconnect();
        onDataDisposable.dispose();
        void offTermEvent();
        term.dispose();
        termRef.current = null;
        fitRef.current = null;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [terminalId, bootNonce]);

    useEffect(() => {
      if (!active) return;
      requestAnimationFrame(() => {
        try {
          fitRef.current?.fit();
          if (termRef.current) {
            ctx.rpc.notify('pane-terminal:resize', {
              terminalId,
              cols: termRef.current.cols,
              rows: termRef.current.rows,
            });
            termRef.current.focus();
          }
        } catch {
          // ignore
        }
      });
    }, [active, terminalId]);

    const handleContextMenu = (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const term = termRef.current;
      const selected = term?.getSelection() || '';
      ctx.ui.showContextMenu(e.clientX, e.clientY, [
        {
          type: 'item',
          label: '복사',
          icon: <Copy size={13} />,
          shortcut: '⌘C',
          disabled: !selected,
          onSelect: () => {
            if (selected) void navigator.clipboard.writeText(selected);
          },
        },
        {
          type: 'item',
          label: '붙여넣기',
          shortcut: '⌘V',
          onSelect: () => {
            void navigator.clipboard.readText().then((txt) => {
              if (txt) ctx.rpc.notify('pane-terminal:write', { terminalId, data: txt });
            });
          },
        },
        { type: 'separator' },
        { type: 'item', label: '터미널 오른쪽 분할', icon: <Columns2 size={13} />, onSelect: () => splitGroup(groupId, 'h', 'terminal') },
        { type: 'item', label: '터미널 아래로 분할', icon: <Rows2 size={13} />, onSelect: () => splitGroup(groupId, 'v', 'terminal') },
        { type: 'separator' },
        { type: 'item', label: '터미널 지우기 (초기화)', icon: <Eraser size={13} />, onSelect: () => term?.clear() },
        {
          type: 'item',
          label: '작업 폴더 Finder에서 열기',
          icon: <FolderOpen size={13} />,
          onSelect: () => void ctx.rpc.invoke('kernel:shell:show-in-finder', { targetPath: cwd }),
        },
        { type: 'separator' },
        { type: 'item', label: '터미널 탭 닫기', icon: <Trash2 size={13} />, danger: true, onSelect: () => void closeTab(groupId, tab.id) },
      ]);
    };

    return (
      <div
        className={
          active
            ? 'flex-1 min-h-0 flex flex-col relative'
            : 'pointer-events-none absolute size-0 overflow-hidden opacity-0'
        }
        aria-hidden={!active}
        style={{ background: isDark ? '#111317' : '#fafafa' }}
        onContextMenu={handleContextMenu}
      >
        <div
          ref={containerRef}
          className="flex-1 min-h-0 w-full px-2.5 py-2 overflow-hidden"
          onClick={() => termRef.current?.focus()}
        />
        {exitedCode !== null && (
          <div
            className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center"
            style={{ background: 'color-mix(in srgb, var(--bg) 90%, transparent)', backdropFilter: 'blur(4px)' }}
          >
            <div className="text-[14px] font-semibold">터미널 세션이 종료되었습니다</div>
            <div className="text-[12px]" style={{ color: 'var(--muted)' }}>
              종료 코드 {exitedCode} · {cwd}
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  setExitedCode(null);
                  setBootNonce((n) => n + 1);
                }}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium cursor-pointer"
                style={{ background: 'var(--accent)', color: '#fff' }}
              >
                <RotateCw size={12} />
                <span>다시 시작</span>
              </button>
              <button
                type="button"
                onClick={() => void closeTab(groupId, tab.id)}
                className="px-3 py-1.5 rounded-lg border text-xs cursor-pointer"
                style={{ borderColor: 'var(--border)', color: 'var(--fg)' }}
              >
                닫기
              </button>
            </div>
          </div>
        )}
      </div>
    );
  };
}

export const paneTerminalClient: ClientPluginModule = {
  activate(ctx) {
    ctx.panes.registerType<TerminalTabState>({
      type: 'terminal',
      label: '터미널 (zsh)',
      description: '실시간 인터랙티브 셸',
      icon: TerminalIcon,
      accentColor: '#22c55e',
      shortcut: '⌘⇧T',
      keepAlive: 'group',
      showInLauncher: true,
      showInOmnibox: true,
      order: 20,
      createDefaultState: (init) => {
        const cwd =
          typeof init?.cwd === 'string' && init.cwd.trim() ? init.cwd : window.deskKernel?.env.homeDir || '/';
        const folder = cwd.split('/').filter(Boolean).pop() || 'zsh';
        const terminalId = `term-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
        return {
          title: typeof init?.title === 'string' && init.title ? init.title : `터미널 · ${folder}`,
          state: { terminalId, cwd },
        };
      },
      duplicateState: (src) => {
        const cwd = typeof src.state.cwd === 'string' ? src.state.cwd : window.deskKernel?.env.homeDir || '/';
        const folder = cwd.split('/').filter(Boolean).pop() || 'zsh';
        return {
          title: `터미널 · ${folder}`,
          state: {
            terminalId: `term-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
            cwd,
          },
        };
      },
      onTabDispose: async (tab) => {
        const terminalId = typeof tab.state.terminalId === 'string' ? tab.state.terminalId : tab.id;
        await ctx.rpc.invoke('pane-terminal:kill', { terminalId }).catch(() => {});
      },
      matchOmnibox: (query) => {
        const q = query.trim().toLowerCase();
        if (q === 'term' || q === 'terminal' || q === '터미널' || q === 'zsh' || q === 'shell') {
          return { score: 100, label: '새 터미널 (zsh)', init: {} };
        }
        return null;
      },
      Component: createTerminalComponent(ctx),
    });

    ctx.commands.register({
      id: 'pane-terminal:new-tab',
      title: '새 터미널 열기',
      shortcut: 'Mod+Shift+T',
      run: () => {
        ctx.workspace.openTab('terminal');
      },
    });

    ctx.slots.register('titlebar.actions', {
      id: 'quick-split',
      zone: 'right',
      order: 10,
      Component: () => (
        <button
          type="button"
          onClick={() => ctx.workspace.openTab('terminal', undefined, { split: 'h' })}
          className="p-1.5 rounded-lg hover:bg-[var(--surface)] cursor-pointer transition-colors"
          style={{ color: 'var(--muted)' }}
          title="옆에 터미널 분할 열기 (⌘⇧T)"
        >
          <TerminalIcon size={15} />
        </button>
      ),
    });

    ctx.slots.register('sidebar.section', {
      id: 'quick-terminal',
      zone: 'top',
      order: 20,
      Component: () => (
        <button
          type="button"
          onClick={() => ctx.workspace.openTab('terminal', undefined, { split: 'h' })}
          className="w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg text-[13px] cursor-pointer transition-colors hover:bg-[var(--surface-active)]"
          style={{ color: 'var(--fg-soft)' }}
        >
          <TerminalIcon size={14} style={{ color: 'var(--muted)' }} />
          <span>터미널 분할</span>
        </button>
      ),
    });

    ctx.slots.register('settings.section', {
      id: 'terminal',
      group: '작업 도구',
      title: '터미널',
      description: '인터랙티브 셸 폰트 크기 및 스크롤백 버퍼 설정',
      icon: TerminalIcon,
      order: 45,
      schema: configSchema,
    });
  },
};

export const paneTerminalClientPackage: BuiltinPluginPackage = {
  manifest: paneTerminalClientManifest,
  client: paneTerminalClient,
};
