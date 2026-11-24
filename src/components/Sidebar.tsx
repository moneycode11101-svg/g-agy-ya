import React, { useMemo } from 'react';
import {
  Columns2,
  Copy,
  Folder,
  GitCompareArrows,
  Globe,
  MessageSquare,
  Plus,
  RefreshCw,
  Rows2,
  Settings,
  Terminal,
} from 'lucide-react';
import type { SessionSummary } from '../shared/types';
import { useContextMenuStore } from '../store/contextMenuStore';
import { useSettingsStore } from '../store/settingsStore';
import { useWorkspaceStore } from '../store/workspaceStore';
import { fmtAgo } from '../utils/formatKo';

export const Sidebar: React.FC = () => {
  const recentSessions = useWorkspaceStore((s) => s.recentSessions);
  const loadingSessions = useWorkspaceStore((s) => s.loadingSessions);
  const groups = useWorkspaceStore((s) => s.groups);
  const focusedGroupId = useWorkspaceStore((s) => s.focusedGroupId);
  const addTabToGroup = useWorkspaceStore((s) => s.addTabToGroup);
  const splitGroup = useWorkspaceStore((s) => s.splitGroup);
  const refreshRecentSessions = useWorkspaceStore((s) => s.refreshRecentSessions);
  const openExistingSession = useWorkspaceStore((s) => s.openExistingSession);
  const openSettings = useSettingsStore((s) => s.openSettings);
  const defaultWebviewUrl = useSettingsStore((s) => s.settings.defaultWebviewUrl);
  const projectFolders = useSettingsStore((s) => s.settings.projectFolders);
  const showMenu = useContextMenuStore((s) => s.showMenu);

  const focusedGroup = groups[focusedGroupId];
  const activeTab = focusedGroup?.tabs.find((t) => t.id === focusedGroup.activeTabId);
  const activeConvId = activeTab?.kind === 'chat' ? activeTab.agyConversationId : null;

  const { projectGroups, standaloneSessions } = useMemo(() => {
    const byProject = new Map<string, { label: string; folderPath?: string; items: SessionSummary[] }>();
    const standalone: SessionSummary[] = [];

    for (const dir of projectFolders || []) {
      const label = dir.split('/').filter(Boolean).pop() || dir;
      if (!byProject.has(label)) {
        byProject.set(label, { label, folderPath: dir, items: [] });
      }
    }

    for (const s of recentSessions) {
      if (s.projectLabel) {
        const entry = byProject.get(s.projectLabel) || { label: s.projectLabel, items: [] };
        entry.items.push(s);
        byProject.set(s.projectLabel, entry);
      } else {
        standalone.push(s);
      }
    }

    return {
      projectGroups: Array.from(byProject.values()),
      standaloneSessions: standalone,
    };
  }, [recentSessions, projectFolders]);

  const renderSessionRow = (sess: SessionSummary) => {
    const isSelected = activeConvId === sess.conversationId;
    return (
      <div
        key={sess.conversationId}
        onClick={() => void openExistingSession(sess, false)}
        onContextMenu={(e) => {
          e.preventDefault();
          showMenu(e.clientX, e.clientY, [
            {
              type: 'item',
              label: '현재 창에서 열기',
              icon: <MessageSquare size={13} />,
              onSelect: () => void openExistingSession(sess, false),
            },
            {
              type: 'item',
              label: '오른쪽 분할로 열기',
              icon: <Columns2 size={13} />,
              onSelect: () => void openExistingSession(sess, 'h'),
            },
            {
              type: 'item',
              label: '아래 분할로 열기',
              icon: <Rows2 size={13} />,
              onSelect: () => void openExistingSession(sess, 'v'),
            },
            { type: 'separator' },
            {
              type: 'item',
              label: '대화 제목 복사',
              icon: <Copy size={13} />,
              onSelect: () => void navigator.clipboard.writeText(sess.title),
            },
            {
              type: 'item',
              label: '세션 ID 복사',
              icon: <Copy size={13} />,
              onSelect: () => void navigator.clipboard.writeText(sess.conversationId),
            },
            { type: 'separator' },
            {
              type: 'item',
              label: '대화 목록 새로고침',
              icon: <RefreshCw size={13} />,
              onSelect: () => void refreshRecentSessions(),
            },
          ]);
        }}
        className="group flex items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 cursor-pointer transition-colors hover:bg-[var(--surface-active)]"
        style={{
          background: isSelected ? 'var(--surface-active)' : undefined,
          color: isSelected ? 'var(--fg)' : 'var(--fg-soft)',
        }}
        title={sess.title}
      >
        <span className={`truncate text-[13px] ${isSelected ? 'font-medium' : ''}`}>{sess.title}</span>

        <div className="flex items-center shrink-0">
          <span className="text-[11px] num group-hover:hidden" style={{ color: 'var(--muted)' }}>
            {fmtAgo(sess.updatedAt)}
          </span>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              void openExistingSession(sess, true);
            }}
            className="hidden group-hover:inline-flex p-0.5 rounded hover:bg-[var(--card)] cursor-pointer"
            style={{ color: 'var(--muted)' }}
            title="옆 창으로 분할 열기"
          >
            <Columns2 size={13} />
          </button>
        </div>
      </div>
    );
  };

  return (
    <aside
      className="w-[244px] shrink-0 border-r flex flex-col select-none"
      style={{ background: 'var(--sidebar)', borderColor: 'var(--border)' }}
    >
      {/* 상단 + 새 대화 화이트 필 버튼 */}
      <div className="px-3 pt-2.5 pb-2 space-y-1">
        <button
          type="button"
          onClick={() => addTabToGroup(focusedGroupId, 'chat')}
          className="w-full flex items-center gap-2 px-3 py-2 rounded-xl border text-[13px] font-medium cursor-pointer transition-colors hover:opacity-90"
          style={{
            background: 'var(--card)',
            borderColor: 'var(--border)',
            boxShadow: 'var(--shadow-sm)',
            color: 'var(--fg)',
          }}
        >
          <Plus size={15} strokeWidth={2} />
          <span>새 대화</span>
        </button>

        {/* 보조 유틸리티 행 */}
        <div className="pt-1 space-y-0.5 text-[13px]">
          <button
            type="button"
            onClick={() => splitGroup(focusedGroupId, 'h', 'terminal')}
            className="w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg cursor-pointer transition-colors hover:bg-[var(--surface-active)]"
            style={{ color: 'var(--fg-soft)' }}
          >
            <Terminal size={14} style={{ color: 'var(--muted)' }} />
            <span>터미널 분할</span>
          </button>
          <button
            type="button"
            onClick={() => splitGroup(focusedGroupId, 'h', 'webview', defaultWebviewUrl || 'http://localhost:5173')}
            className="w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg cursor-pointer transition-colors hover:bg-[var(--surface-active)]"
            style={{ color: 'var(--fg-soft)' }}
          >
            <Globe size={14} style={{ color: 'var(--muted)' }} />
            <span>웹뷰 분할</span>
          </button>
          <button
            type="button"
            onClick={() => splitGroup(focusedGroupId, 'h', 'diff')}
            className="w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg cursor-pointer transition-colors hover:bg-[var(--surface-active)]"
            style={{ color: 'var(--fg-soft)' }}
          >
            <GitCompareArrows size={14} style={{ color: 'var(--muted)' }} />
            <span>Git Diff</span>
          </button>
        </div>
      </div>

      {/* 프로젝트 + 대화 스크롤 영역 (Antigravity GUI 1:1 구조) */}
      <div className="flex-1 min-h-0 overflow-y-auto scroll-thin px-2 pb-3 space-y-3">
        {projectGroups.length > 0 && (
          <div>
            <div
              className="px-2 pt-2 pb-1 flex items-center justify-between text-[11.5px]"
              style={{ color: 'var(--muted)' }}
            >
              <span className="font-medium">프로젝트</span>
              <button
                type="button"
                onClick={() => void refreshRecentSessions()}
                className="p-1 rounded hover:bg-[var(--surface-active)] cursor-pointer"
                title="새로고침"
              >
                <RefreshCw size={11} className={loadingSessions ? 'animate-spin' : ''} />
              </button>
            </div>
            <div className="space-y-1">
              {projectGroups.map((pg) => (
                <div key={pg.label} className="space-y-0.5">
                  <div
                    className="group flex items-center justify-between gap-2 px-2.5 py-1 text-[12.5px] font-medium"
                    style={{ color: 'var(--fg-soft)' }}
                  >
                    <span className="flex items-center gap-2 min-w-0">
                      <Folder size={13} style={{ color: 'var(--muted)' }} className="shrink-0" />
                      <span className="truncate" title={pg.folderPath || pg.label}>{pg.label}</span>
                    </span>
                    {pg.folderPath && (
                      <button
                        type="button"
                        onClick={() => addTabToGroup(focusedGroupId, 'chat', { cwd: pg.folderPath })}
                        className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-[var(--surface-active)] cursor-pointer shrink-0"
                        style={{ color: 'var(--muted)' }}
                        title={`${pg.label}에서 새 대화`}
                      >
                        <Plus size={12} />
                      </button>
                    )}
                  </div>
                  <div className="pl-1 space-y-0.5">{pg.items.map(renderSessionRow)}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        <div>
          <div
            className="px-2 pt-1 pb-1 flex items-center justify-between text-[11.5px]"
            style={{ color: 'var(--muted)' }}
          >
            <span className="font-medium">대화</span>
            <button
              type="button"
              onClick={() => addTabToGroup(focusedGroupId, 'chat')}
              className="p-1 rounded hover:bg-[var(--surface-active)] cursor-pointer"
              title="새 대화 (⌘N)"
            >
              <Plus size={12} />
            </button>
          </div>
          {standaloneSessions.length === 0 && projectGroups.length === 0 ? (
            <div className="px-2.5 py-3 text-[12px]" style={{ color: 'var(--muted)' }}>
              저장된 대화가 없습니다.
            </div>
          ) : (
            <div className="space-y-0.5">{standaloneSessions.map(renderSessionRow)}</div>
          )}
        </div>
      </div>

      {/* Antigravity 스타일 하단 설정 버튼 */}
      <div className="p-2 border-t" style={{ borderColor: 'var(--border)' }}>
        <button
          type="button"
          onClick={() => openSettings('general')}
          className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-[13px] cursor-pointer transition-colors hover:bg-[var(--surface-active)]"
          style={{ color: 'var(--fg-soft)' }}
        >
          <Settings size={14} style={{ color: 'var(--muted)' }} />
          <span>설정</span>
        </button>
      </div>
    </aside>
  );
};
