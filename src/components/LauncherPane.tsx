import React, { useEffect, useRef, useState } from 'react';
import {
  ArrowRight,
  Columns2,
  GitCompareArrows,
  Globe,
  MessageSquare,
  Rows2,
  Search,
  Terminal,
  Trash2,
} from 'lucide-react';
import type { LauncherPaneTab } from '../shared/types';
import { useContextMenuStore } from '../store/contextMenuStore';
import { useSettingsStore } from '../store/settingsStore';
import { useWorkspaceStore } from '../store/workspaceStore';

function normalizeQuickUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return 'http://localhost:5173';
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(trimmed)) return `http://${trimmed}`;
  if (/^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(trimmed)) return `https://${trimmed}`;
  return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`;
}

interface LauncherPaneProps {
  groupId: string;
  tab: LauncherPaneTab;
}

export const LauncherPane: React.FC<LauncherPaneProps> = ({ groupId, tab }) => {
  const convertLauncherTab = useWorkspaceStore((s) => s.convertLauncherTab);
  const splitGroup = useWorkspaceStore((s) => s.splitGroup);
  const closeSplitPane = useWorkspaceStore((s) => s.closeSplitPane);
  const recentSessions = useWorkspaceStore((s) => s.recentSessions);
  const openExistingSession = useWorkspaceStore((s) => s.openExistingSession);
  const groups = useWorkspaceStore((s) => s.groups);
  const showMenu = useContextMenuStore((s) => s.showMenu);
  const defaultWebviewUrl = useSettingsStore((s) => s.settings.defaultWebviewUrl);

  const [omnibox, setOmnibox] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const totalGroups = Object.keys(groups).length;

  const handleSubmitOmnibox = (e: React.FormEvent) => {
    e.preventDefault();
    const q = omnibox.trim();
    if (!q) return;
    if (q === 'term' || q === 'terminal' || q === '터미널' || q === 'zsh') {
      convertLauncherTab(groupId, tab.id, 'terminal', { cwd: tab.cwd });
      return;
    }
    if (q === 'chat' || q === '채팅' || q === 'agy') {
      convertLauncherTab(groupId, tab.id, 'chat', { cwd: tab.cwd });
      return;
    }
    if (q === 'diff' || q === 'git') {
      convertLauncherTab(groupId, tab.id, 'diff', { cwd: tab.cwd });
      return;
    }
    const url = normalizeQuickUrl(q);
    convertLauncherTab(groupId, tab.id, 'webview', { url });
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    showMenu(e.clientX, e.clientY, [
      {
        type: 'item',
        label: '새 채팅 열기',
        icon: <MessageSquare size={13} />,
        onSelect: () => convertLauncherTab(groupId, tab.id, 'chat', { cwd: tab.cwd }),
      },
      {
        type: 'item',
        label: '새 터미널 열기',
        icon: <Terminal size={13} />,
        onSelect: () => convertLauncherTab(groupId, tab.id, 'terminal', { cwd: tab.cwd }),
      },
      {
        type: 'item',
        label: '웹사이트 열기',
        icon: <Globe size={13} />,
        onSelect: () => convertLauncherTab(groupId, tab.id, 'webview', { url: defaultWebviewUrl }),
      },
      {
        type: 'item',
        label: 'Git Diff 열기',
        icon: <GitCompareArrows size={13} />,
        onSelect: () => convertLauncherTab(groupId, tab.id, 'diff', { cwd: tab.cwd }),
      },
      { type: 'separator' },
      {
        type: 'item',
        label: '오른쪽으로 분할',
        icon: <Columns2 size={13} />,
        shortcut: '⌘D',
        onSelect: () => splitGroup(groupId, 'h', 'launcher'),
      },
      {
        type: 'item',
        label: '아래로 분할',
        icon: <Rows2 size={13} />,
        shortcut: '⌘⇧D',
        onSelect: () => splitGroup(groupId, 'v', 'launcher'),
      },
      ...(totalGroups > 1
        ? [
            { type: 'separator' as const },
            {
              type: 'item' as const,
              label: '이 분할 창 닫기',
              icon: <Trash2 size={13} />,
              danger: true,
              onSelect: () => closeSplitPane(groupId),
            },
          ]
        : []),
    ]);
  };

  const filteredSessions = omnibox.trim()
    ? recentSessions.filter((s) => s.title.toLowerCase().includes(omnibox.trim().toLowerCase())).slice(0, 4)
    : recentSessions.slice(0, 3);

  return (
    <div
      className="flex-1 min-h-0 overflow-y-auto scroll-thin flex items-center justify-center p-6 @container"
      style={{ background: 'var(--bg)' }}
      onContextMenu={handleContextMenu}
    >
      <div className="w-full max-w-[460px] space-y-5">
        <div className="space-y-1">
          <h2 className="text-[16px] font-semibold tracking-tight" style={{ color: 'var(--fg)' }}>
            이 분할 창에 무엇을 열까요?
          </h2>
          <p className="text-[12.5px]" style={{ color: 'var(--muted)' }}>
            채팅 · 터미널 · 웹사이트 · Git Diff 중 고르거나 URL을 바로 입력하세요.
          </p>
        </div>

        {/* Orca식 옴니박스 입력창 */}
        <form onSubmit={handleSubmitOmnibox} className="relative">
          <div
            className="flex items-center gap-2 px-3.5 py-2.5 rounded-xl border transition-colors focus-within:border-[var(--accent)]"
            style={{
              background: 'var(--card)',
              borderColor: 'var(--border-strong)',
              boxShadow: 'var(--shadow-sm)',
            }}
          >
            <Search size={14} style={{ color: 'var(--muted)' }} className="shrink-0" />
            <input
              ref={inputRef}
              type="text"
              value={omnibox}
              onChange={(e) => setOmnibox(e.target.value)}
              placeholder="URL 입력 (localhost:3000, github.com) 또는 검색..."
              className="flex-1 bg-transparent outline-none text-[13px]"
              style={{ color: 'var(--fg)' }}
            />
            {omnibox.trim() && (
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

        {/* 4종 핵심 창 선택 그리드 */}
        <div className="grid grid-cols-2 gap-2.5">
          {[
            {
              kind: 'chat' as const,
              icon: <MessageSquare size={16} />,
              title: '새 채팅 (agy)',
              desc: '독립 에이전트 대화 시작',
              shortcut: '⌘N',
              color: '#3b82f6',
              onClick: () => convertLauncherTab(groupId, tab.id, 'chat', { cwd: tab.cwd }),
            },
            {
              kind: 'terminal' as const,
              icon: <Terminal size={16} />,
              title: '터미널 (zsh)',
              desc: '실시간 인터랙티브 셸',
              shortcut: '⌘⇧T',
              color: '#22c55e',
              onClick: () => convertLauncherTab(groupId, tab.id, 'terminal', { cwd: tab.cwd }),
            },
            {
              kind: 'webview' as const,
              icon: <Globe size={16} />,
              title: '웹사이트 (브라우저)',
              desc: '내장 Chromium 웹뷰',
              shortcut: '⌘T',
              color: '#a855f7',
              onClick: () =>
                convertLauncherTab(groupId, tab.id, 'webview', {
                  url: defaultWebviewUrl || 'http://localhost:5173',
                }),
            },
            {
              kind: 'diff' as const,
              icon: <GitCompareArrows size={16} />,
              title: 'Git Diff',
              desc: '변경 파일 및 diff 보기',
              shortcut: '⌘⇧G',
              color: '#f97316',
              onClick: () => convertLauncherTab(groupId, tab.id, 'diff', { cwd: tab.cwd }),
            },
          ].map((card) => (
            <button
              key={card.kind}
              type="button"
              onClick={card.onClick}
              className="group text-left rounded-xl border p-3.5 cursor-pointer transition-all hover:border-[var(--border-strong)] hover:bg-[var(--surface)]"
              style={{
                background: 'var(--card)',
                borderColor: 'var(--border)',
                boxShadow: 'var(--shadow-sm)',
              }}
            >
              <div className="flex items-center justify-between mb-2">
                <span
                  className="w-8 h-8 rounded-lg flex items-center justify-center"
                  style={{
                    background: `color-mix(in srgb, ${card.color} 12%, transparent)`,
                    color: card.color,
                  }}
                >
                  {card.icon}
                </span>
                <span className="text-[10.5px] font-mono" style={{ color: 'var(--muted)' }}>
                  {card.shortcut}
                </span>
              </div>
              <div className="text-[13px] font-semibold" style={{ color: 'var(--fg)' }}>
                {card.title}
              </div>
              <div className="text-[11.5px] mt-0.5 truncate" style={{ color: 'var(--muted)' }}>
                {card.desc}
              </div>
            </button>
          ))}
        </div>

        {/* 빠른 웹사이트 바로가기 */}
        <div className="space-y-1.5">
          <div className="text-[11px] font-medium" style={{ color: 'var(--muted)' }}>
            빠른 웹사이트 열기
          </div>
          <div className="flex flex-wrap gap-1.5">
            {[
              ['localhost:3000', 'http://localhost:3000'],
              ['localhost:5173', 'http://localhost:5173'],
              ['localhost:8000', 'http://localhost:8000'],
              ['GitHub', 'https://github.com'],
              ['Google', 'https://www.google.com'],
            ].map(([lbl, u]) => (
              <button
                key={lbl}
                type="button"
                onClick={() => convertLauncherTab(groupId, tab.id, 'webview', { url: u })}
                className="px-2.5 py-1 rounded-lg border text-[11.5px] cursor-pointer transition-colors hover:bg-[var(--surface)]"
                style={{ background: 'var(--card)', borderColor: 'var(--border)', color: 'var(--fg-soft)' }}
              >
                {lbl}
              </button>
            ))}
          </div>
        </div>

        {/* 최근 대화 바로 열기 */}
        {filteredSessions.length > 0 && (
          <div className="space-y-1">
            <div className="text-[11px] font-medium" style={{ color: 'var(--muted)' }}>
              {omnibox.trim() ? '일치하는 대화' : '최근 대화 바로 열기'}
            </div>
            <div
              className="rounded-xl border divide-y overflow-hidden"
              style={{ background: 'var(--card)', borderColor: 'var(--border)' }}
            >
              {filteredSessions.map((sess) => (
                <button
                  key={sess.conversationId}
                  type="button"
                  onClick={() => void openExistingSession(sess, false, groupId)}
                  className="w-full px-3 py-2 flex items-center justify-between gap-2 text-left text-[12px] cursor-pointer hover:bg-[var(--surface)]"
                  style={{ borderColor: 'var(--border)', color: 'var(--fg-soft)' }}
                >
                  <span className="flex items-center gap-2 min-w-0">
                    <MessageSquare size={12} style={{ color: 'var(--muted)' }} className="shrink-0" />
                    <span className="truncate">{sess.title}</span>
                  </span>
                  <ArrowRight size={12} style={{ color: 'var(--muted)' }} className="shrink-0" />
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
