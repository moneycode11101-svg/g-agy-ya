import React, { useCallback, useEffect, useState } from 'react';
import { Columns2, FolderOpen, GitBranch, RotateCw, Rows2, Terminal, Trash2 } from 'lucide-react';
import type { DiffPaneTab, GitDiffSnapshot } from '../shared/types';
import { useContextMenuStore } from '../store/contextMenuStore';
import { useSettingsStore } from '../store/settingsStore';
import { useWorkspaceStore } from '../store/workspaceStore';

interface DiffPaneProps {
  groupId: string;
  tab: DiffPaneTab;
}

export const DiffPane: React.FC<DiffPaneProps> = ({ groupId, tab }) => {
  const updateTab = useWorkspaceStore((s) => s.updateTab);
  const splitGroup = useWorkspaceStore((s) => s.splitGroup);
  const closeTab = useWorkspaceStore((s) => s.closeTab);
  const gitDiffBase = useSettingsStore((s) => s.settings.gitDiffBase);
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  const showMenu = useContextMenuStore((s) => s.showMenu);
  const [snap, setSnap] = useState<GitDiffSnapshot | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(
    async (cwd: string, file?: string) => {
      if (!window.agyDesk) return;
      setLoading(true);
      try {
        const res = await window.agyDesk.getGitDiff(cwd, file);
        setSnap(res);
      } finally {
        setLoading(false);
      }
    },
    []
  );

  useEffect(() => {
    void load(tab.cwd, tab.selectedFile);
  }, [gitDiffBase, load, tab.cwd, tab.selectedFile]);

  const handlePickDir = async () => {
    const dir = await window.agyDesk?.pickDirectory();
    if (dir) {
      updateTab(groupId, tab.id, { cwd: dir, selectedFile: undefined });
    }
  };

  const lines = (snap?.diffText || '').split('\n');

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    showMenu(e.clientX, e.clientY, [
      {
        type: 'item',
        label: 'Diff 새로고침',
        icon: <RotateCw size={13} />,
        onSelect: () => void load(tab.cwd, tab.selectedFile),
      },
      {
        type: 'item',
        label: gitDiffBase === 'working' ? 'HEAD 전체 비교로 전환' : '워킹 트리 비교로 전환',
        icon: <GitBranch size={13} />,
        onSelect: () => void updateSettings({ gitDiffBase: gitDiffBase === 'working' ? 'head' : 'working' }),
      },
      {
        type: 'item',
        label: '저장소 폴더 변경...',
        icon: <FolderOpen size={13} />,
        onSelect: () => void handlePickDir(),
      },
      { type: 'separator' },
      {
        type: 'item',
        label: '옆에 터미널 열기',
        icon: <Terminal size={13} />,
        onSelect: () => splitGroup(groupId, 'h', 'terminal'),
      },
      {
        type: 'item',
        label: '오른쪽으로 분할 (새 창 선택)',
        icon: <Columns2 size={13} />,
        shortcut: '⌘D',
        onSelect: () => splitGroup(groupId, 'h', 'launcher'),
      },
      {
        type: 'item',
        label: '아래로 분할 (새 창 선택)',
        icon: <Rows2 size={13} />,
        shortcut: '⌘⇧D',
        onSelect: () => splitGroup(groupId, 'v', 'launcher'),
      },
      { type: 'separator' },
      {
        type: 'item',
        label: 'Diff 탭 닫기',
        icon: <Trash2 size={13} />,
        danger: true,
        onSelect: () => closeTab(groupId, tab.id),
      },
    ]);
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col text-xs" onContextMenu={handleContextMenu}>
      <div
        className="h-9 shrink-0 px-2.5 border-b flex items-center justify-between gap-2"
        style={{ background: 'var(--card)', borderColor: 'var(--border)' }}
      >
        <div className="flex items-center gap-2 min-w-0">
          <button
            type="button"
            onClick={() => void handlePickDir()}
            className="flex items-center gap-1 px-2 py-0.5 rounded border cursor-pointer hover:opacity-80 truncate max-w-[200px]"
            style={{ borderColor: 'var(--border)', color: 'var(--muted)' }}
            title={tab.cwd}
          >
            <FolderOpen size={12} />
            <span className="truncate font-mono">{tab.cwd.split('/').pop() || tab.cwd}</span>
          </button>
          {snap?.branch && (
            <span className="flex items-center gap-1 font-mono" style={{ color: 'var(--muted)' }}>
              <GitBranch size={12} />
              {snap.branch}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={() => void load(tab.cwd, tab.selectedFile)}
          className="p-1 rounded cursor-pointer hover:opacity-80"
          style={{ color: 'var(--muted)' }}
          title="Diff 새로고침"
        >
          <RotateCw size={13} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {!snap?.ok ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-2 p-6" style={{ color: 'var(--muted)' }}>
          <div>{snap?.error || 'Git 상태를 불러오는 중...'}</div>
          <button
            type="button"
            onClick={() => void handlePickDir()}
            className="px-3 py-1.5 rounded-lg border cursor-pointer"
            style={{ borderColor: 'var(--border)', color: 'var(--fg)', background: 'var(--card)' }}
          >
            Git 저장소 폴더 선택
          </button>
        </div>
      ) : (
        <div className="flex-1 min-h-0 flex">
          {/* 변경 파일 목록 */}
          <div
            className="w-44 shrink-0 border-r overflow-y-auto scroll-thin p-1.5 space-y-0.5"
            style={{ borderColor: 'var(--border)', background: 'var(--sidebar)' }}
          >
            <button
              type="button"
              onClick={() => updateTab(groupId, tab.id, { selectedFile: undefined })}
              className="w-full text-left px-2 py-1 rounded text-[11px] cursor-pointer truncate"
              style={{
                background: !tab.selectedFile ? 'var(--card)' : 'transparent',
                fontWeight: !tab.selectedFile ? 600 : 400,
              }}
            >
              전체 변경 ({snap.files.length})
            </button>
            {snap.files.map((f) => (
              <button
                key={f.path}
                type="button"
                onClick={() => updateTab(groupId, tab.id, { selectedFile: f.path })}
                className="w-full text-left px-2 py-1 rounded text-[11px] cursor-pointer flex items-center gap-1.5"
                style={{
                  background: tab.selectedFile === f.path ? 'var(--card)' : 'transparent',
                  fontWeight: tab.selectedFile === f.path ? 600 : 400,
                }}
                title={f.path}
              >
                <span className="font-mono text-[10px] shrink-0" style={{ color: 'var(--warn)' }}>
                  {f.status}
                </span>
                <span className="truncate font-mono">{f.path.split('/').pop()}</span>
              </button>
            ))}
          </div>

          {/* Unified diff 본문 */}
          <div className="flex-1 min-w-0 overflow-auto scroll-thin p-2.5 font-mono text-[11px] leading-relaxed">
            {snap.diffText.trim() ? (
              lines.map((line, i) => {
                let bg = 'transparent';
                let color = 'var(--fg)';
                if (line.startsWith('+') && !line.startsWith('+++')) {
                  bg = 'color-mix(in srgb, var(--ok) 14%, transparent)';
                  color = 'var(--ok)';
                } else if (line.startsWith('-') && !line.startsWith('---')) {
                  bg = 'color-mix(in srgb, var(--danger) 14%, transparent)';
                  color = 'var(--danger)';
                } else if (line.startsWith('@@')) {
                  color = 'var(--primary)';
                } else if (line.startsWith('diff --git')) {
                  color = 'var(--muted)';
                }
                return (
                  <div key={i} className="px-1.5 whitespace-pre" style={{ background: bg, color }}>
                    {line || ' '}
                  </div>
                );
              })
            ) : (
              <div className="p-4" style={{ color: 'var(--muted)' }}>
                워킹 트리에 unstaged diff가 없습니다.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
