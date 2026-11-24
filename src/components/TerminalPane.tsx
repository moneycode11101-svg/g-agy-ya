import React, { useEffect, useRef, useState } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import {
  Columns2,
  Copy,
  Eraser,
  FolderOpen,
  RotateCw,
  Rows2,
  Trash2,
} from 'lucide-react';
import type { TerminalPaneTab } from '../shared/types';
import { useContextMenuStore } from '../store/contextMenuStore';
import { useSettingsStore } from '../store/settingsStore';
import { useWorkspaceStore } from '../store/workspaceStore';

interface TerminalPaneProps {
  groupId: string;
  tab: TerminalPaneTab;
  active: boolean;
}

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

export const TerminalPane: React.FC<TerminalPaneProps> = ({ groupId, tab, active }) => {
  const splitGroup = useWorkspaceStore((s) => s.splitGroup);
  const closeTab = useWorkspaceStore((s) => s.closeTab);
  const openUrlInWebview = useWorkspaceStore((s) => s.openUrlInWebview);
  const showMenu = useContextMenuStore((s) => s.showMenu);
  const themeSetting = useSettingsStore((s) => s.settings.theme);
  const linkOpenTarget = useSettingsStore((s) => s.settings.linkOpenTarget);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [exitedCode, setExitedCode] = useState<number | null>(null);
  const [bootNonce, setBootNonce] = useState(0);

  const resolveIsDark = () => {
    const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches;
    return themeSetting === 'dark' || (themeSetting === 'system' && prefersDark);
  };

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      lineHeight: 1.35,
      fontFamily: '"JetBrains Mono", Menlo, Monaco, "SF Mono", ui-monospace, monospace',
      scrollback: 5000,
      theme: getXtermTheme(resolveIsDark()),
      allowProposedApi: true,
    });
    const fitAddon = new FitAddon();
    const linksAddon = new WebLinksAddon((_ev, uri) => {
      if (linkOpenTarget === 'external') {
        void window.agyDesk?.openExternal(uri);
      } else {
        openUrlInWebview(uri);
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
          window.agyDesk?.resizeTerminal(tab.terminalId, term.cols, term.rows);
        }
      } catch {
        // ignore layout race
      }
    };

    requestAnimationFrame(() => {
      safeFit();
      setExitedCode(null);
      void window.agyDesk?.createTerminal(tab.terminalId, tab.cwd, term.cols || 80, term.rows || 24);
    });

    const onDataDisposable = term.onData((data) => {
      window.agyDesk?.writeTerminal(tab.terminalId, data);
    });

    const offTermEvent = window.agyDesk?.onTerminalEvent((ev) => {
      if (ev.terminalId !== tab.terminalId) return;
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

    return () => {
      ro.disconnect();
      onDataDisposable.dispose();
      offTermEvent?.();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.terminalId, bootNonce]);

  // Live theme switch
  useEffect(() => {
    if (termRef.current) {
      termRef.current.options.theme = getXtermTheme(resolveIsDark());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [themeSetting]);

  // Refit & focus when tab becomes active
  useEffect(() => {
    if (!active) return;
    requestAnimationFrame(() => {
      try {
        fitRef.current?.fit();
        if (termRef.current) {
          window.agyDesk?.resizeTerminal(tab.terminalId, termRef.current.cols, termRef.current.rows);
          termRef.current.focus();
        }
      } catch {
        // ignore
      }
    });
  }, [active, tab.terminalId]);

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const term = termRef.current;
    const selected = term?.getSelection() || '';

    showMenu(e.clientX, e.clientY, [
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
            if (txt) window.agyDesk?.writeTerminal(tab.terminalId, txt);
          });
        },
      },
      { type: 'separator' },
      {
        type: 'item',
        label: '터미널 오른쪽 분할',
        icon: <Columns2 size={13} />,
        onSelect: () => splitGroup(groupId, 'h', 'terminal'),
      },
      {
        type: 'item',
        label: '터미널 아래로 분할',
        icon: <Rows2 size={13} />,
        onSelect: () => splitGroup(groupId, 'v', 'terminal'),
      },
      { type: 'separator' },
      {
        type: 'item',
        label: '터미널 지우기 (초기화)',
        icon: <Eraser size={13} />,
        onSelect: () => term?.clear(),
      },
      {
        type: 'item',
        label: '작업 폴더 Finder에서 열기',
        icon: <FolderOpen size={13} />,
        onSelect: () => void window.agyDesk?.showInFinder(tab.cwd),
      },
      { type: 'separator' },
      {
        type: 'item',
        label: '터미널 탭 닫기',
        icon: <Trash2 size={13} />,
        danger: true,
        onSelect: () => closeTab(groupId, tab.id),
      },
    ]);
  };

  const isDark = resolveIsDark();

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
            종료 코드 {exitedCode} · {tab.cwd}
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
              onClick={() => closeTab(groupId, tab.id)}
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
