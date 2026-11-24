import React, { useCallback, useEffect, useState } from 'react';
import { Columns2, FolderOpen, GitBranch, GitCompareArrows, RotateCw, Rows2, Terminal, Trash2 } from 'lucide-react';
import {
  BUILTIN_PLUGIN_IDS,
  useLayoutStore,
  usePluginConfigStore,
  type BuiltinPluginPackage,
  type ClientPluginModule,
  type ConfigFieldSchema,
  type DeskClientContext,
  type PaneComponentProps,
  type PluginManifest,
} from '../../kernel/client';

export interface DiffTabState extends Record<string, unknown> {
  cwd: string;
  selectedFile?: string;
}

interface GitDiffSnapshot {
  ok: boolean;
  cwd: string;
  branch: string;
  files: Array<{ status: string; path: string }>;
  diffText: string;
  error?: string;
}

const configSchema: readonly ConfigFieldSchema[] = [
  {
    key: 'gitDiffBase',
    label: 'Git Diff 비교 기준',
    description: '워킹 트리 변경분만 볼지 HEAD 대비 전체 변경을 볼지 선택합니다.',
    group: 'Git Diff',
    type: 'segmented',
    defaultValue: 'working',
    options: [
      { value: 'working', label: '워킹 트리' },
      { value: 'head', label: 'HEAD 전체' },
    ],
    keywords: ['git', 'diff', 'head', '워킹 트리', '비교'],
  },
];

export const paneGitDiffClientManifest: PluginManifest = {
  id: BUILTIN_PLUGIN_IDS.PANE_GIT_DIFF,
  name: 'Git Diff 뷰어',
  version: '1.0.0',
  apiVersion: '^1.0.0',
  description: '로컬 Git 저장소의 변경 파일 목록과 Unified Diff를 표시하는 독립 패인',
  layer: 'app',
  category: 'pane',
  icon: 'GitCompareArrows',
  impactClass: 'instant',
  defaultEnabled: true,
  entry: {
    host: './electron/plugins/pane-git-diff/index.ts',
    client: './src/plugins/pane-git-diff/index.tsx',
  },
  capabilities: ['process:spawn', 'fs:read'],
  configSchema,
  contributes: {
    slots: ['pane.type', 'sidebar.section', 'settings.section'],
    paneTypes: [{ type: 'diff', label: 'Git Diff', icon: 'GitCompareArrows' }],
    commands: [{ id: 'pane-git-diff:new-tab', title: 'Git Diff 탭 열기', defaultShortcut: 'Mod+Shift+G' }],
  },
};

function createDiffComponent(ctx: DeskClientContext): React.FC<PaneComponentProps<DiffTabState>> {
  return function DiffPaneView({ groupId, tab, updateState }) {
    const splitGroup = useLayoutStore((s) => s.splitGroup);
    const closeTab = useLayoutStore((s) => s.closeTab);
    const cfg = usePluginConfigStore((s) => s.configsByPlugin[BUILTIN_PLUGIN_IDS.PANE_GIT_DIFF] || {});
    const gitDiffBase = cfg.gitDiffBase === 'head' ? 'head' : 'working';

    const cwd = typeof tab.state.cwd === 'string' && tab.state.cwd ? tab.state.cwd : window.deskKernel?.env.homeDir || '/';
    const selectedFile = typeof tab.state.selectedFile === 'string' ? tab.state.selectedFile : undefined;

    const [snap, setSnap] = useState<GitDiffSnapshot | null>(null);
    const [loading, setLoading] = useState(false);

    const load = useCallback(
      async (dir: string, file?: string) => {
        setLoading(true);
        try {
          const res = await ctx.rpc.invoke<GitDiffSnapshot>('pane-git-diff:snapshot', { cwd: dir, filePath: file });
          setSnap(res);
        } catch (err) {
          setSnap({
            ok: false,
            cwd: dir,
            branch: '',
            files: [],
            diffText: '',
            error: err instanceof Error ? err.message : 'Git Diff 조회 실패',
          });
        } finally {
          setLoading(false);
        }
      },
      []
    );

    useEffect(() => {
      void load(cwd, selectedFile);
    }, [cwd, gitDiffBase, load, selectedFile]);

    const handlePickDir = async () => {
      const dir = await ctx.rpc.invoke<string | null>('kernel:dialog:pick-dir').catch(() => null);
      if (dir) {
        updateState({ cwd: dir, selectedFile: undefined });
      }
    };

    const lines = (snap?.diffText || '').split('\n');

    const handleContextMenu = (e: React.MouseEvent) => {
      e.preventDefault();
      ctx.ui.showContextMenu(e.clientX, e.clientY, [
        { type: 'item', label: 'Diff 새로고침', icon: <RotateCw size={13} />, onSelect: () => void load(cwd, selectedFile) },
        {
          type: 'item',
          label: gitDiffBase === 'working' ? 'HEAD 전체 비교로 전환' : '워킹 트리 비교로 전환',
          icon: <GitBranch size={13} />,
          onSelect: () => void ctx.config.set({ gitDiffBase: gitDiffBase === 'working' ? 'head' : 'working' }),
        },
        { type: 'item', label: '저장소 폴더 변경...', icon: <FolderOpen size={13} />, onSelect: () => void handlePickDir() },
        { type: 'separator' },
        { type: 'item', label: '옆에 터미널 열기', icon: <Terminal size={13} />, onSelect: () => splitGroup(groupId, 'h', 'terminal', { cwd }) },
        { type: 'item', label: '오른쪽으로 분할', icon: <Columns2 size={13} />, shortcut: '⌘D', onSelect: () => splitGroup(groupId, 'h') },
        { type: 'item', label: '아래로 분할', icon: <Rows2 size={13} />, shortcut: '⌘⇧D', onSelect: () => splitGroup(groupId, 'v') },
        { type: 'separator' },
        { type: 'item', label: 'Diff 탭 닫기', icon: <Trash2 size={13} />, danger: true, onSelect: () => void closeTab(groupId, tab.id) },
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
              title={cwd}
            >
              <FolderOpen size={12} />
              <span className="truncate font-mono">{cwd.split('/').pop() || cwd}</span>
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
            onClick={() => void load(cwd, selectedFile)}
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
            <div
              className="w-44 shrink-0 border-r overflow-y-auto scroll-thin p-1.5 space-y-0.5"
              style={{ borderColor: 'var(--border)', background: 'var(--sidebar)' }}
            >
              <button
                type="button"
                onClick={() => updateState({ selectedFile: undefined })}
                className="w-full text-left px-2 py-1 rounded text-[11px] cursor-pointer truncate"
                style={{
                  background: !selectedFile ? 'var(--card)' : 'transparent',
                  fontWeight: !selectedFile ? 600 : 400,
                }}
              >
                전체 변경 ({snap.files.length})
              </button>
              {snap.files.map((f) => (
                <button
                  key={f.path}
                  type="button"
                  onClick={() => updateState({ selectedFile: f.path })}
                  className="w-full text-left px-2 py-1 rounded text-[11px] cursor-pointer flex items-center gap-1.5"
                  style={{
                    background: selectedFile === f.path ? 'var(--card)' : 'transparent',
                    fontWeight: selectedFile === f.path ? 600 : 400,
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
                    // Fixed legacy undefined `--primary` CSS variable bug -> `var(--accent)`
                    color = 'var(--accent)';
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
}

export const paneGitDiffClient: ClientPluginModule = {
  activate(ctx) {
    ctx.panes.registerType<DiffTabState>({
      type: 'diff',
      label: 'Git Diff',
      description: '변경 파일 및 diff 보기',
      icon: GitCompareArrows,
      accentColor: '#f97316',
      shortcut: '⌘⇧G',
      keepAlive: 'never',
      showInLauncher: true,
      showInOmnibox: true,
      order: 40,
      createDefaultState: (init) => ({
        title: 'Git Diff',
        state: {
          cwd: typeof init?.cwd === 'string' && init.cwd.trim() ? init.cwd : window.deskKernel?.env.homeDir || '/',
          selectedFile: typeof init?.selectedFile === 'string' ? init.selectedFile : undefined,
        },
      }),
      matchOmnibox: (query) => {
        const q = query.trim().toLowerCase();
        if (q === 'diff' || q === 'git' || q === 'git diff') {
          return { score: 95, label: 'Git Diff', init: {} };
        }
        return null;
      },
      Component: createDiffComponent(ctx),
    });

    ctx.commands.register({
      id: 'pane-git-diff:new-tab',
      title: 'Git Diff 탭 열기',
      shortcut: 'Mod+Shift+G',
      run: () => {
        ctx.workspace.openTab('diff');
      },
    });

    ctx.slots.register('sidebar.section', {
      id: 'quick-diff',
      zone: 'top',
      order: 40,
      Component: () => (
        <button
          type="button"
          onClick={() => ctx.workspace.openTab('diff', undefined, { split: 'h' })}
          className="w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg text-[13px] cursor-pointer transition-colors hover:bg-[var(--surface-active)]"
          style={{ color: 'var(--fg-soft)' }}
        >
          <GitCompareArrows size={14} style={{ color: 'var(--muted)' }} />
          <span>Git Diff</span>
        </button>
      ),
    });

    ctx.slots.register('settings.section', {
      id: 'git-diff',
      group: '작업 도구',
      title: 'Git Diff',
      description: 'Git 변경 비교 기준 설정',
      icon: GitCompareArrows,
      order: 46,
      schema: configSchema,
    });
  },
};

export const paneGitDiffClientPackage: BuiltinPluginPackage = {
  manifest: paneGitDiffClientManifest,
  client: paneGitDiffClient,
};
