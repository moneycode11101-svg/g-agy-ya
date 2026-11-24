import React, { useEffect, useState } from 'react';
import { PanelLeft, RotateCcw, ShieldAlert } from 'lucide-react';
import { GlobalContextMenu } from './components/ContextMenu';
import { SplitTree } from './components/SplitTree';
import {
  bootstrapClientKernel,
  getDeskKernelBridge,
  SlotOutlet,
  useCommandRegistry,
  useIntrospectionStore,
  useLayoutStore,
  useSlotRegistry,
  type BuiltinPluginPackage,
} from './kernel/client';
import { AGENT_CLIENT_PLUGINS } from './plugins/agent-group';
import { SHELL_CLIENT_PLUGINS } from './plugins/shell-group';
import { VISUAL_CLIENT_PLUGINS } from './plugins/visual-group';
import { useContextMenuStore } from './store/contextMenuStore';

const ALL_CLIENT_PLUGINS: readonly BuiltinPluginPackage[] = [
  ...AGENT_CLIENT_PLUGINS,
  ...SHELL_CLIENT_PLUGINS,
  ...VISUAL_CLIENT_PLUGINS,
];

// Guard against React StrictMode double-mount so kernel boots cleanly exactly once per renderer lifetime
let kernelBootPromise: Promise<{ dispose: () => Promise<void> }> | null = null;

function ensureClientKernelBooted(): Promise<{ dispose: () => Promise<void> }> {
  if (!kernelBootPromise) {
    kernelBootPromise = bootstrapClientKernel({
      builtins: ALL_CLIENT_PLUGINS,
      hooks: {
        showContextMenu: (x, y, items) => {
          useContextMenuStore.getState().showMenu(x, y, items);
        },
        closeContextMenu: () => {
          useContextMenuStore.getState().closeMenu();
        },
      },
    });
  }
  return kernelBootPromise;
}

export const App: React.FC = () => {
  const bootPhase = useLayoutStore((s) => s.bootPhase);
  const layout = useLayoutStore((s) => s.layout);
  const groups = useLayoutStore((s) => s.groups);
  const sidebarOpen = useLayoutStore((s) => s.sidebarOpen);
  const focusedGroupId = useLayoutStore((s) => s.focusedGroupId);
  const toggleSidebar = useLayoutStore((s) => s.toggleSidebar);
  const resetLayout = useLayoutStore((s) => s.resetLayout);
  const sidebarEntries = useSlotRegistry((s) => s.bySlot['sidebar.section']);
  const [safeModeDismissed, setSafeModeDismissed] = useState(false);

  useEffect(() => {
    void ensureClientKernelBooted();

    const offSidebarCmd = useCommandRegistry.getState().register({
      id: 'kernel:toggle-sidebar',
      title: '사이드바 토글',
      pluginId: 'kernel',
      shortcut: 'Mod+B',
      run: () => useLayoutStore.getState().toggleSidebar(),
    });

    const offCloseTabCmd = useCommandRegistry.getState().register({
      id: 'kernel:close-active-tab',
      title: '현재 탭 닫기',
      pluginId: 'kernel',
      shortcut: 'Mod+W',
      run: () => {
        const s = useLayoutStore.getState();
        const grp = s.groups[s.focusedGroupId];
        if (grp?.activeTabId) {
          void s.closeTab(grp.id, grp.activeTabId);
        }
      },
    });

    return () => {
      void offSidebarCmd();
      void offCloseTabCmd();
    };
  }, []);

  const bridge = getDeskKernelBridge();
  const isMac = bridge ? bridge.env.platform === 'darwin' : navigator.platform.toLowerCase().includes('mac');
  const isSafeMode = Boolean(bridge?.env.safeMode);

  const focusedGrp = groups[focusedGroupId];
  const focusedTab = focusedGrp?.tabs.find((t) => t.id === focusedGrp.activeTabId) || focusedGrp?.tabs[0];
  const rawProjectLabel =
    typeof focusedTab?.state?.projectLabel === 'string' && focusedTab.state.projectLabel
      ? focusedTab.state.projectLabel
      : typeof focusedTab?.state?.cwd === 'string' && focusedTab.state.cwd
        ? focusedTab.state.cwd.split('/').filter(Boolean).pop() || 'Home'
        : 'Workspace';
  const titleLabel = focusedTab?.title || 'Workspace';
  const splitCount = Object.keys(groups).length;
  const hasSidebarSections = (sidebarEntries?.length || 0) > 0;
  const showSidebar = sidebarOpen && hasSidebarSections;

  return (
    <div
      className="h-screen w-screen flex flex-col overflow-hidden"
      style={{ background: 'var(--bg)', color: 'var(--fg)' }}
    >
      {/* Safe Mode 복구 배너 (외부 로컬 플러그인 로드 중단 시 커널이 자동 제공) */}
      {isSafeMode && !safeModeDismissed && (
        <div
          className="h-8 shrink-0 px-3 border-b flex items-center justify-between gap-2 text-[12px]"
          style={{
            background: 'color-mix(in srgb, var(--warn) 14%, var(--card))',
            borderColor: 'color-mix(in srgb, var(--warn) 40%, var(--border))',
            color: 'var(--fg)',
          }}
        >
          <span className="flex items-center gap-1.5 min-w-0 truncate">
            <ShieldAlert size={13} style={{ color: 'var(--warn)' }} className="shrink-0" />
            <span className="font-semibold">Safe Mode</span>
            <span className="truncate" style={{ color: 'var(--muted)' }}>
              외부 로컬 플러그인이 일시 중지되었습니다. Plugin Studio 또는 설정 파일에서 복구할 수 있습니다.
            </span>
          </span>
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              onClick={() => void useIntrospectionStore.getState().sendCommand({ type: 'plugin:open-config-file' })}
              className="px-2 py-0.5 rounded border text-[11px] cursor-pointer hover:bg-[var(--surface)]"
              style={{ borderColor: 'var(--border)', background: 'var(--card)' }}
            >
              설정 파일 열기
            </button>
            <button
              type="button"
              onClick={() => {
                void useIntrospectionStore.getState().sendCommand({ type: 'system:set-safe-mode', enabled: false });
                setSafeModeDismissed(true);
              }}
              className="px-2 py-0.5 rounded border text-[11px] cursor-pointer hover:bg-[var(--surface)]"
              style={{ borderColor: 'var(--border)', background: 'var(--card)' }}
            >
              안전 모드 해제
            </button>
          </div>
        </div>
      )}

      {/* Zero-Feature 44px 단일 미니멀 타이틀바 (모든 기능 버튼은 `titlebar.actions` 슬롯에서 주입) */}
      <header
        className="h-11 shrink-0 flex items-center select-none app-drag border-b"
        style={{ borderColor: 'var(--border)', background: 'var(--bg)' }}
      >
        <div
          className={`h-full flex items-center justify-between px-3 shrink-0 transition-all ${
            showSidebar ? 'w-[244px] border-r' : 'w-auto'
          }`}
          style={{
            background: showSidebar ? 'var(--sidebar)' : 'var(--bg)',
            borderColor: 'var(--border)',
            paddingLeft: isMac ? '78px' : '12px',
          }}
        >
          <div className="flex items-center gap-1 app-no-drag">
            {hasSidebarSections && (
              <button
                type="button"
                onClick={toggleSidebar}
                className="p-1.5 rounded-lg hover:bg-[var(--surface-active)] cursor-pointer transition-colors"
                style={{ color: 'var(--muted)' }}
                title="사이드바 토글 (⌘B)"
              >
                <PanelLeft size={15} />
              </button>
            )}
            <SlotOutlet slotId="titlebar.actions" zone="left" compactError />
          </div>
        </div>

        <div className="flex-1 min-w-0 px-4 flex items-center justify-between gap-3">
          <div className="flex items-center gap-1.5 text-[13px] min-w-0">
            <span className="truncate" style={{ color: 'var(--muted)' }}>
              {rawProjectLabel}
            </span>
            <span style={{ color: 'var(--border-strong)' }}>/</span>
            <span className="font-medium truncate" style={{ color: 'var(--fg)' }}>
              {titleLabel}
            </span>
            <SlotOutlet slotId="titlebar.actions" zone="center" compactError />
          </div>

          <div className="flex items-center gap-0.5 app-no-drag shrink-0">
            <SlotOutlet slotId="titlebar.actions" zone="right" compactError />
            {splitCount > 1 && (
              <button
                type="button"
                onClick={() => void resetLayout()}
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

      {/* 바디: 빈 사이드바 슬롯 컨테이너 + Data-Agnostic 분할 트리 */}
      <div className="flex-1 min-h-0 flex">
        {showSidebar && (
          <aside
            className="w-[244px] shrink-0 border-r flex flex-col select-none min-h-0"
            style={{ background: 'var(--sidebar)', borderColor: 'var(--border)' }}
            data-desk-slot="sidebar.section"
          >
            <div className="px-2.5 pt-2.5 pb-1.5 space-y-0.5 shrink-0">
              <SlotOutlet slotId="sidebar.section" zone="top" />
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto scroll-thin px-2 pb-3 flex flex-col">
              <SlotOutlet slotId="sidebar.section" zone="body" />
            </div>
            <div className="p-2 border-t shrink-0 space-y-0.5" style={{ borderColor: 'var(--border)' }}>
              <SlotOutlet slotId="sidebar.section" zone="footer" />
            </div>
          </aside>
        )}

        <main className="flex-1 min-w-0 min-h-0 flex">
          {bootPhase === 'hydrated' ? (
            <SplitTree node={layout} />
          ) : (
            <div className="flex-1 flex items-center justify-center text-[12px]" style={{ color: 'var(--muted)' }}>
              워크스페이스 커널 준비 중...
            </div>
          )}
        </main>
      </div>

      {/* 전역 오버레이 슬롯 (SettingsModal, CommandPalette, UI X-Ray, Toast HUD) */}
      <SlotOutlet slotId="overlay.layer" />
      <GlobalContextMenu />
    </div>
  );
};
