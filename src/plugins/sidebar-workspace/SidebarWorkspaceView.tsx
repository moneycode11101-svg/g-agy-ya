import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Columns2,
  Copy,
  Folder,
  FolderOpen,
  FolderPlus,
  MessageSquare,
  Plus,
  RefreshCw,
  Rows2,
  Trash2,
} from 'lucide-react';
import {
  useLayoutStore,
  type DeskClientContext,
  type SplitDir,
} from '../../kernel/client';
import type { AgyEvent, SessionSummary } from '../../shared/types';
import { fmtAgo } from '../../utils/formatKo';
import { AGY_BUS, AGY_RPC } from '../agent-agy/types';
import type { ChatTabState } from '../pane-chat/chatStore';
import type { SidebarWorkspaceConfig } from './manifest';

export interface SidebarWorkspaceViewProps {
  ctx: DeskClientContext<SidebarWorkspaceConfig>;
}

export const SidebarWorkspaceView: React.FC<SidebarWorkspaceViewProps> = ({ ctx }) => {
  const cfg = ctx.config.useConfig();
  const projectFolders = useMemo(
    () => (Array.isArray(cfg.projectFolders) ? cfg.projectFolders.map(String) : []),
    [cfg.projectFolders]
  );
  const sessionLimit = typeof cfg.sessionLimit === 'number' ? cfg.sessionLimit : 40;

  const groups = useLayoutStore((s) => s.groups);
  const focusedGroupId = useLayoutStore((s) => s.focusedGroupId);

  const [recentSessions, setRecentSessions] = useState<SessionSummary[]>([]);
  const [loadingSessions, setLoadingSessions] = useState(false);

  const refreshSessions = useCallback(async () => {
    setLoadingSessions(true);
    try {
      const list = await ctx.rpc.invoke<SessionSummary[]>(AGY_RPC.SESSIONS_LIST, { limit: sessionLimit });
      if (Array.isArray(list)) setRecentSessions(list);
    } catch {
      // agent-agy may be disabled; keep UI intact
    } finally {
      setLoadingSessions(false);
    }
  }, [ctx.rpc, sessionLimit]);

  useEffect(() => {
    void refreshSessions();
    const unsub = ctx.bus.subscribe<AgyEvent>(AGY_BUS.EVENT, (env) => {
      if (env.payload?.type === 'done') {
        void refreshSessions();
      }
    });
    return () => {
      void unsub();
    };
  }, [ctx.bus, refreshSessions]);

  const focusedGroup = groups[focusedGroupId];
  const activeTab = focusedGroup?.tabs.find((t) => t.id === focusedGroup.activeTabId);
  const activeChatState = activeTab?.paneType === 'chat' ? (activeTab.state as ChatTabState) : null;
  const activeConvId = activeChatState?.externalSessionId ?? activeChatState?.agyConversationId ?? null;

  const { projectGroups, standaloneSessions } = useMemo(() => {
    const byProject = new Map<string, { label: string; folderPath?: string; items: SessionSummary[] }>();
    const standalone: SessionSummary[] = [];

    for (const dir of projectFolders) {
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

  const handleAddProjectFolder = async () => {
    try {
      const dir = await ctx.rpc.invoke<string | null>('sidebar-workspace:pickDirectory');
      if (dir && !projectFolders.includes(dir)) {
        await ctx.config.set({ projectFolders: [...projectFolders, dir] });
        ctx.ui.toast(`프로젝트 폴더 추가됨: ${dir.split('/').pop() || dir}`, 'info');
      }
    } catch {
      // ignore
    }
  };

  const handleRemoveProjectFolder = async (dir: string) => {
    await ctx.config.set({ projectFolders: projectFolders.filter((x) => x !== dir) });
  };

  const openSession = (summary: SessionSummary, split: boolean | SplitDir = false) => {
    void ctx.commands.execute('pane-chat:open-session', { summary, split });
  };

  const renderSessionRow = (sess: SessionSummary) => {
    const isSelected = activeConvId === sess.conversationId;
    return (
      <div
        key={sess.conversationId}
        onClick={() => openSession(sess, false)}
        onContextMenu={(e) => {
          e.preventDefault();
          ctx.ui.showContextMenu(e.clientX, e.clientY, [
            {
              type: 'item',
              label: '현재 창에서 열기',
              icon: <MessageSquare size={13} />,
              onSelect: () => openSession(sess, false),
            },
            {
              type: 'item',
              label: '오른쪽 분할로 열기',
              icon: <Columns2 size={13} />,
              onSelect: () => openSession(sess, 'h'),
            },
            {
              type: 'item',
              label: '아래 분할로 열기',
              icon: <Rows2 size={13} />,
              onSelect: () => openSession(sess, 'v'),
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
              onSelect: () => void refreshSessions(),
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
              openSession(sess, 'h');
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
    <div className="flex flex-col gap-3">
      {/* + 새 대화 화이트 필 버튼 */}
      <div className="px-1">
        <button
          type="button"
          onClick={() => ctx.workspace.openTab('chat')}
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
      </div>

      {/* 프로젝트 폴더 섹션 (기존 설정 6번 탭에서 사이드바로 승격!) */}
      <div>
        <div
          className="px-2 pt-1 pb-1 flex items-center justify-between text-[11.5px]"
          style={{ color: 'var(--muted)' }}
        >
          <span className="font-medium">프로젝트</span>
          <div className="flex items-center gap-0.5">
            <button
              type="button"
              onClick={() => void handleAddProjectFolder()}
              className="p-1 rounded hover:bg-[var(--surface-active)] cursor-pointer"
              title="프로젝트 폴더 추가"
            >
              <FolderPlus size={12} />
            </button>
            <button
              type="button"
              onClick={() => void refreshSessions()}
              className="p-1 rounded hover:bg-[var(--surface-active)] cursor-pointer"
              title="새로고침"
            >
              <RefreshCw size={11} className={loadingSessions ? 'animate-spin' : ''} />
            </button>
          </div>
        </div>

        {projectGroups.length === 0 ? (
          <button
            type="button"
            onClick={() => void handleAddProjectFolder()}
            className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-[12px] cursor-pointer transition-colors hover:bg-[var(--surface-active)]"
            style={{ color: 'var(--muted)' }}
          >
            <FolderPlus size={13} />
            <span>프로젝트 폴더 추가...</span>
          </button>
        ) : (
          <div className="space-y-1">
            {projectGroups.map((pg) => (
              <div key={pg.label} className="space-y-0.5">
                <div
                  onContextMenu={(e) => {
                    if (!pg.folderPath) return;
                    e.preventDefault();
                    const dir = pg.folderPath;
                    ctx.ui.showContextMenu(e.clientX, e.clientY, [
                      {
                        type: 'item',
                        label: `${pg.label}에서 새 대화`,
                        icon: <MessageSquare size={13} />,
                        onSelect: () => ctx.workspace.openTab('chat', { cwd: dir }),
                      },
                      {
                        type: 'item',
                        label: 'Finder에서 열기',
                        icon: <FolderOpen size={13} />,
                        onSelect: () => void ctx.rpc.invoke('sidebar-workspace:showInFolder', { targetPath: dir }),
                      },
                      { type: 'separator' },
                      {
                        type: 'item',
                        label: '프로젝트 목록에서 제거',
                        icon: <Trash2 size={13} />,
                        danger: true,
                        onSelect: () => void handleRemoveProjectFolder(dir),
                      },
                    ]);
                  }}
                  className="group flex items-center justify-between gap-1 px-2.5 py-1 text-[12.5px] font-medium rounded-lg hover:bg-[var(--surface-active)]"
                  style={{ color: 'var(--fg-soft)' }}
                >
                  <span className="flex items-center gap-2 min-w-0">
                    <Folder size={13} style={{ color: 'var(--muted)' }} className="shrink-0" />
                    <span className="truncate" title={pg.folderPath || pg.label}>
                      {pg.label}
                    </span>
                  </span>
                  {pg.folderPath && (
                    <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                      <button
                        type="button"
                        onClick={() => ctx.workspace.openTab('chat', { cwd: pg.folderPath })}
                        className="p-0.5 rounded hover:bg-[var(--card)] cursor-pointer"
                        style={{ color: 'var(--muted)' }}
                        title={`${pg.label}에서 새 대화`}
                      >
                        <Plus size={12} />
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleRemoveProjectFolder(pg.folderPath!)}
                        className="p-0.5 rounded hover:bg-[var(--card)] cursor-pointer"
                        style={{ color: 'var(--muted)' }}
                        title="프로젝트 폴더 제거"
                      >
                        <Trash2 size={11} />
                      </button>
                    </div>
                  )}
                </div>
                {pg.items.length > 0 && <div className="pl-1 space-y-0.5">{pg.items.map(renderSessionRow)}</div>}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 최근 대화 섹션 */}
      <div>
        <div
          className="px-2 pt-1 pb-1 flex items-center justify-between text-[11.5px]"
          style={{ color: 'var(--muted)' }}
        >
          <span className="font-medium">대화</span>
          <button
            type="button"
            onClick={() => ctx.workspace.openTab('chat')}
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
  );
};
