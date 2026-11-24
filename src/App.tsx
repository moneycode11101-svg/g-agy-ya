import React, { useEffect } from 'react';
import { Columns2, Globe, PanelLeft, RotateCcw, Rows2, Terminal } from 'lucide-react';
import { GlobalContextMenu } from './components/ContextMenu';
import { SettingsModal } from './components/SettingsModal';
import { Sidebar } from './components/Sidebar';
import { SplitTree } from './components/SplitTree';
import { useSettingsStore } from './store/settingsStore';
import { useWorkspaceStore } from './store/workspaceStore';

export const App: React.FC = () => {
  const layout = useWorkspaceStore((s) => s.layout);
  const groups = useWorkspaceStore((s) => s.groups);
  const sidebarOpen = useWorkspaceStore((s) => s.sidebarOpen);
  const focusedGroupId = useWorkspaceStore((s) => s.focusedGroupId);
  const toggleSidebar = useWorkspaceStore((s) => s.toggleSidebar);
  const splitGroup = useWorkspaceStore((s) => s.splitGroup);
  const addTabToGroup = useWorkspaceStore((s) => s.addTabToGroup);
  const closeTab = useWorkspaceStore((s) => s.closeTab);
  const resetLayout = useWorkspaceStore((s) => s.resetLayout);
  const refreshRecentSessions = useWorkspaceStore((s) => s.refreshRecentSessions);
  const refreshAccountQuota = useWorkspaceStore((s) => s.refreshAccountQuota);
  const setAccountQuota = useWorkspaceStore((s) => s.setAccountQuota);
  const handleAgyEvent = useWorkspaceStore((s) => s.handleAgyEvent);
  const openUrlInWebview = useWorkspaceStore((s) => s.openUrlInWebview);
  const hydrateSettings = useSettingsStore((s) => s.hydrate);
  const openSettings = useSettingsStore((s) => s.openSettings);
  const settingsOpen = useSettingsStore((s) => s.modalOpen);
  const defaultWebviewUrl = useSettingsStore((s) => s.settings.defaultWebviewUrl);

  useEffect(() => {
    void hydrateSettings();
    void refreshRecentSessions();
    void refreshAccountQuota(false);
    if (!window.agyDesk) return;
    const offAgy = window.agyDesk.onAgyEvent(handleAgyEvent);
    const offWv = window.agyDesk.onWebviewNewTab(openUrlInWebview);
    const offQuota = window.agyDesk.onQuotaUpdated(setAccountQuota);
    return () => {
      offAgy();
      offWv();
      offQuota();
    };
  }, [handleAgyEvent, hydrateSettings, openUrlInWebview, refreshAccountQuota, refreshRecentSessions, setAccountQuota]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const key = e.key.toLowerCase();

      if (key === ',') {
        e.preventDefault();
        openSettings();
      } else if (key === 'b') {
        e.preventDefault();
        toggleSidebar();
      } else if (key === 'd') {
        e.preventDefault();
        splitGroup(focusedGroupId, e.shiftKey ? 'v' : 'h', 'launcher');
      } else if (key === 'n') {
        e.preventDefault();
        addTabToGroup(focusedGroupId, 'chat');
      } else if (key === 't') {
        e.preventDefault();
        addTabToGroup(focusedGroupId, e.shiftKey ? 'terminal' : 'webview');
      } else if (key === 'g' && e.shiftKey) {
        e.preventDefault();
        addTabToGroup(focusedGroupId, 'diff');
      } else if (key === 'w') {
        e.preventDefault();
        const grp = useWorkspaceStore.getState().groups[focusedGroupId];
        if (grp?.activeTabId) closeTab(grp.id, grp.activeTabId);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [addTabToGroup, closeTab, focusedGroupId, openSettings, splitGroup, toggleSidebar]);

  useEffect(() => {
    if (settingsOpen && document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  }, [settingsOpen]);

  const isMac = window.agyDesk?.platform === 'darwin';
  const focusedGrp = groups[focusedGroupId];
  const focusedTab = focusedGrp?.tabs.find((t) => t.id === focusedGrp.activeTabId) || focusedGrp?.tabs[0];
  const folderLabel =
    focusedTab?.kind === 'chat' && focusedTab.projectLabel
      ? focusedTab.projectLabel
      : focusedTab && 'cwd' in focusedTab
        ? focusedTab.cwd.split('/').pop() || 'Home'
        : 'Workspace';
  const titleLabel = focusedTab?.title || '새 대화';
  const splitCount = Object.keys(groups).length;

  return (
    <div
      className="h-screen w-screen flex flex-col overflow-hidden"
      style={{ background: 'var(--bg)', color: 'var(--fg)' }}
    >
      <SettingsModal />
      <GlobalContextMenu />

      {/* Antigravity 스타일 단일 미니멀 타이틀바 (44px) */}
      <header
        aria-hidden={settingsOpen || undefined}
        className="h-11 shrink-0 flex items-center select-none app-drag border-b"
        style={{ borderColor: 'var(--border)', background: 'var(--bg)' }}
      >
        {/* 좌측 사이드바 영역 폭과 맞춘 컨트롤 */}
        <div
          className={`h-full flex items-center justify-between px-3 shrink-0 transition-all ${
            sidebarOpen ? 'w-[244px] border-r' : 'w-auto'
          }`}
          style={{
            background: sidebarOpen ? 'var(--sidebar)' : 'var(--bg)',
            borderColor: 'var(--border)',
            paddingLeft: isMac ? '78px' : '12px',
          }}
        >
          <div className="flex items-center gap-1 app-no-drag">
            <button
              type="button"
              onClick={toggleSidebar}
              className="p-1.5 rounded-lg hover:bg-[var(--surface-active)] cursor-pointer transition-colors"
              style={{ color: 'var(--muted)' }}
              title="사이드바 토글 (⌘B)"
            >
              <PanelLeft size={15} />
            </button>
          </div>
        </div>

        {/* 중앙 브레드크럼 + 우측 미니멀 고스트 아이콘 */}
        <div className="flex-1 min-w-0 px-4 flex items-center justify-between gap-3">
          <div className="flex items-center gap-1.5 text-[13px] min-w-0">
            <span className="truncate" style={{ color: 'var(--muted)' }}>
              {folderLabel}
            </span>
            <span style={{ color: 'var(--border-strong)' }}>/</span>
            <span className="font-medium truncate" style={{ color: 'var(--fg)' }}>
              {titleLabel}
            </span>
          </div>

          <div className="flex items-center gap-0.5 app-no-drag shrink-0">
            <button
              type="button"
              onClick={() => splitGroup(focusedGroupId, 'h', 'terminal')}
              className="p-1.5 rounded-lg hover:bg-[var(--surface)] cursor-pointer transition-colors"
              style={{ color: 'var(--muted)' }}
              title="옆에 터미널 분할 열기 (⌘⇧T)"
            >
              <Terminal size={15} />
            </button>
            <button
              type="button"
              onClick={() => splitGroup(focusedGroupId, 'h', 'webview', defaultWebviewUrl || 'http://localhost:5173')}
              className="p-1.5 rounded-lg hover:bg-[var(--surface)] cursor-pointer transition-colors"
              style={{ color: 'var(--muted)' }}
              title="옆에 웹뷰 분할 열기 (⌘T)"
            >
              <Globe size={15} />
            </button>
            <button
              type="button"
              onClick={() => splitGroup(focusedGroupId, 'h', 'launcher')}
              className="p-1.5 rounded-lg hover:bg-[var(--surface)] cursor-pointer transition-colors"
              style={{ color: 'var(--muted)' }}
              title="오른쪽으로 분할 (⌘D) — 새 창 선택"
            >
              <Columns2 size={15} />
            </button>
            <button
              type="button"
              onClick={() => splitGroup(focusedGroupId, 'v', 'launcher')}
              className="p-1.5 rounded-lg hover:bg-[var(--surface)] cursor-pointer transition-colors"
              style={{ color: 'var(--muted)' }}
              title="아래로 분할 (⌘⇧D) — 새 창 선택"
            >
              <Rows2 size={15} />
            </button>
            {splitCount > 1 && (
              <button
                type="button"
                onClick={resetLayout}
                className="p-1.5 rounded-lg hover:bg-[var(--surface)] cursor-pointer transition-colors"
                style={{ color: 'var(--muted)' }}
                title="단일 화면으로 복귀"
              >
                <RotateCcw size={14} />
              </button>
            )}
          </div>
        </div>
      </header>

      {/* 바디 */}
      <div aria-hidden={settingsOpen || undefined} className="flex-1 min-h-0 flex">
        {sidebarOpen && <Sidebar />}
        <main className="flex-1 min-w-0 min-h-0 flex">
          <SplitTree node={layout} />
        </main>
      </div>
    </div>
  );
};
