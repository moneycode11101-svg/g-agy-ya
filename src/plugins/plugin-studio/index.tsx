import React, { useEffect } from 'react';
import { Blocks, ScanEye, X } from 'lucide-react';
import {
  useIntrospectionStore,
  useLayoutStore,
  type BuiltinPluginPackage,
  type ClientPluginModule,
  type DeskClientContext,
} from '../../kernel/client';
import { PLUGIN_STUDIO_MANIFEST } from './manifest';
import { PluginStudioPane } from './PluginStudioPane';
import { usePluginStudioUiStore } from './studioState';
import { XrayOverlay } from './XrayOverlay';

const SidebarStudioEntryButton: React.FC = () => {
  const studioOpen = usePluginStudioUiStore((s) => s.studioOpen);
  const toggleStudio = usePluginStudioUiStore((s) => s.toggleStudio);
  const snapshot = useIntrospectionStore((s) => s.snapshot);
  const groups = useLayoutStore((s) => s.groups);
  const focusedGroupId = useLayoutStore((s) => s.focusedGroupId);

  const focusedGroup = groups[focusedGroupId];
  const activeTab = focusedGroup?.tabs.find((t) => t.id === focusedGroup.activeTabId);
  const isStudioFocused = studioOpen || activeTab?.paneType === 'plugin-studio';

  const errorCount = snapshot
    ? Object.values(snapshot.plugins).filter(
        (p) => p.lifecycleState === 'error' || p.lifecycleState === 'quarantined'
      ).length
    : 0;
  const localCount = snapshot
    ? Object.values(snapshot.plugins).filter((p) => p.origin === 'local-dev').length
    : 0;

  return (
    <button
      type="button"
      onClick={() => toggleStudio()}
      className="w-full flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg text-[13px] cursor-pointer transition-colors hover:bg-[var(--surface-active)]"
      style={{
        background: isStudioFocused ? 'var(--surface-active)' : undefined,
        color: isStudioFocused ? 'var(--fg)' : 'var(--fg-soft)',
        fontWeight: isStudioFocused ? 600 : 500,
      }}
      title="라이브 플러그인 스튜디오 열기 (⌘⇧P)"
    >
      <span className="flex items-center gap-2 min-w-0">
        <Blocks size={14} style={{ color: 'var(--accent)' }} className="shrink-0" />
        <span className="truncate">플러그인 스튜디오</span>
      </span>
      <span className="flex items-center gap-1 shrink-0">
        {localCount > 0 && (
          <span
            className="px-1.5 py-0.2 rounded text-[10px] font-mono"
            style={{ background: 'color-mix(in srgb, #9333ea 14%, transparent)', color: '#9333ea' }}
          >
            +{localCount}
          </span>
        )}
        {errorCount > 0 && (
          <span
            className="w-2 h-2 rounded-full animate-pulse"
            style={{ background: 'var(--danger)' }}
            title={`오류 플러그인 ${errorCount}개`}
          />
        )}
      </span>
    </button>
  );
};

const TitlebarVisualControls: React.FC = () => {
  const xrayActive = useIntrospectionStore((s) => s.xrayActive);
  const toggleXray = useIntrospectionStore((s) => s.toggleXray);
  const snapshot = useIntrospectionStore((s) => s.snapshot);
  const studioOpen = usePluginStudioUiStore((s) => s.studioOpen);
  const toggleStudio = usePluginStudioUiStore((s) => s.toggleStudio);
  const setStudioOpen = usePluginStudioUiStore((s) => s.setStudioOpen);

  const hasError = snapshot
    ? Object.values(snapshot.plugins).some(
        (p) => p.lifecycleState === 'error' || p.lifecycleState === 'quarantined'
      )
    : false;

  return (
    <div className="flex items-center gap-0.5 app-no-drag">
      <button
        type="button"
        onClick={() => {
          if (!xrayActive && studioOpen) setStudioOpen(false);
          toggleXray();
        }}
        className="p-1.5 rounded-lg cursor-pointer transition-colors hover:bg-[var(--surface)]"
        style={{
          color: xrayActive ? 'var(--accent)' : 'var(--muted)',
          background: xrayActive ? 'color-mix(in srgb, var(--accent) 14%, transparent)' : undefined,
        }}
        title="UI X-Ray 투시 오버레이 토글 (⌘⇧X)"
      >
        <ScanEye size={15} />
      </button>
      <button
        type="button"
        onClick={() => {
          if (!studioOpen && xrayActive) toggleXray();
          toggleStudio();
        }}
        className="relative p-1.5 rounded-lg cursor-pointer transition-colors hover:bg-[var(--surface)]"
        style={{
          color: studioOpen ? 'var(--accent)' : 'var(--muted)',
          background: studioOpen ? 'color-mix(in srgb, var(--accent) 14%, transparent)' : undefined,
        }}
        title="플러그인 스튜디오 열기 (⌘⇧P)"
      >
        <Blocks size={15} />
        {hasError && (
          <span
            className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full"
            style={{ background: 'var(--danger)' }}
          />
        )}
      </button>
    </div>
  );
};

const FullWindowStudioOverlay: React.FC = () => {
  const studioOpen = usePluginStudioUiStore((s) => s.studioOpen);
  const setStudioOpen = usePluginStudioUiStore((s) => s.setStudioOpen);
  const selectedNodeId = usePluginStudioUiStore((s) => s.selectedNodeId);
  const xrayActive = useIntrospectionStore((s) => s.xrayActive);

  useEffect(() => {
    if (!studioOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !selectedNodeId) {
        setStudioOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [studioOpen, selectedNodeId, setStudioOpen]);

  // Hide full-window studio while X-Ray is active so the user can inspect their actual workspace panes
  if (!studioOpen || xrayActive) return null;

  return (
    <div
      className="fixed inset-x-0 top-11 bottom-0 z-[82] flex flex-col"
      style={{ background: 'var(--bg)' }}
    >
      <PluginStudioPane
        groupId="__studio_overlay__"
        tab={{
          id: '__studio_overlay_tab__',
          paneType: 'plugin-studio',
          ownerPluginId: 'plugin-studio',
          title: '플러그인 스튜디오',
          state: {},
        }}
        active
        updateState={() => {}}
        updateTabMeta={() => {}}
        onCloseOverlay={() => setStudioOpen(false)}
      />
    </div>
  );
};

const StudioToastHud: React.FC = () => {
  const toasts = useIntrospectionStore((s) => s.toasts);
  const dismissToast = useIntrospectionStore((s) => s.dismissToast);
  if (toasts.length === 0) return null;

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[96] flex flex-col gap-1.5 max-w-[360px]">
      {toasts.map((t) => {
        const border =
          t.level === 'error'
            ? 'var(--danger)'
            : t.level === 'warn'
              ? 'var(--warn)'
              : 'var(--border-strong)';
        return (
          <div
            key={t.id}
            className="pointer-events-auto rounded-xl border px-3 py-2 text-[12px] flex items-center justify-between gap-2.5"
            style={{
              background: 'var(--card)',
              borderColor: border,
              boxShadow: 'var(--shadow-popover)',
              color: 'var(--fg)',
            }}
          >
            <span className="leading-snug">{t.message}</span>
            <button
              type="button"
              onClick={() => dismissToast(t.id)}
              className="p-0.5 rounded hover:bg-[var(--surface)] cursor-pointer shrink-0"
              style={{ color: 'var(--muted)' }}
            >
              <X size={12} />
            </button>
          </div>
        );
      })}
    </div>
  );
};

const pluginStudioClient: ClientPluginModule = {
  activate(ctx: DeskClientContext) {
    // 1. Register `plugin-studio` split pane type (Live 3-tier Architecture Board)
    ctx.panes.registerType({
      type: 'plugin-studio',
      label: '플러그인 스튜디오',
      description: '실시간 3단 아키텍처 보드 · 플러그인 ON/OFF · 이벤트 펄스',
      icon: Blocks,
      accentColor: '#6366f1',
      shortcut: '⌘⇧P',
      keepAlive: 'never',
      showInLauncher: true,
      showInOmnibox: true,
      order: 50,
      createDefaultState: () => ({
        title: '플러그인 스튜디오',
        state: {},
      }),
      matchOmnibox: (q: string) => {
        const lower = q.trim().toLowerCase();
        if (
          lower === 'studio' ||
          lower === 'plugin' ||
          lower === 'plugins' ||
          lower === '스튜디오' ||
          lower === '플러그인' ||
          lower === 'xray'
        ) {
          return { score: 95, label: '플러그인 스튜디오 열기', init: {} };
        }
        return null;
      },
      Component: PluginStudioPane,
    });

    // 2. Register first-class top Sidebar entry button ("플러그인 스튜디오")
    ctx.slots.register('sidebar.section', {
      id: 'plugin-studio-nav',
      zone: 'top',
      order: 1,
      Component: SidebarStudioEntryButton,
    });

    // 3. Register Titlebar quick open & UI X-Ray toggle buttons
    ctx.slots.register('titlebar.actions', {
      id: 'plugin-studio-titlebar',
      zone: 'right',
      order: 15,
      Component: TitlebarVisualControls,
    });

    // 4. Register Full-Window Studio Overlay, UI X-Ray Overlay & Toast HUD in overlay.layer
    ctx.slots.register('overlay.layer', {
      id: 'plugin-studio-full-overlay',
      zLayer: 'modal',
      order: 5,
      Component: FullWindowStudioOverlay,
    });

    ctx.slots.register('overlay.layer', {
      id: 'ui-xray-overlay',
      zLayer: 'xray',
      order: 10,
      Component: XrayOverlay,
    });

    ctx.slots.register('overlay.layer', {
      id: 'studio-toast-hud',
      zLayer: 'hud',
      order: 90,
      Component: StudioToastHud,
    });

    // 5. Register declarative settings section so ⌘F global search indexes Studio & X-Ray options
    ctx.slots.register('settings.section', {
      id: 'plugin-studio-settings',
      group: '플러그인',
      title: '플러그인 스튜디오 · X-Ray',
      description: '실시간 플러그인 보드 반응형 폭, 이벤트 펄스 및 UI X-Ray 오버레이 표시를 설정합니다.',
      icon: Blocks,
      schema: PLUGIN_STUDIO_MANIFEST.configSchema,
      order: 60,
    });

    // 6. Register keyboard commands
    ctx.commands.register({
      id: 'plugin-studio:open',
      title: '플러그인 스튜디오 열기',
      shortcut: 'Mod+Shift+P',
      run: () => {
        const ui = usePluginStudioUiStore.getState();
        if (!ui.studioOpen && useIntrospectionStore.getState().xrayActive) {
          useIntrospectionStore.getState().setXrayActive(false);
        }
        ui.toggleStudio();
      },
    });

    ctx.commands.register({
      id: 'plugin-studio:toggle-xray',
      title: 'UI X-Ray 오버레이 토글',
      shortcut: 'Mod+Shift+X',
      run: () => {
        useIntrospectionStore.getState().toggleXray();
      },
    });

    ctx.commands.register({
      id: 'plugin-studio:mount-local',
      title: '로컬 플러그인 폴더 마운트...',
      run: async () => {
        const res = await useIntrospectionStore
          .getState()
          .sendCommand({ type: 'plugin:mount-local-dialog', watch: true });
        if (res.ok) {
          useIntrospectionStore.getState().pushToast('로컬 플러그인 마운트 완료!', 'info');
        }
      },
    });

    // Cleanly disable X-Ray pointer shield if plugin-studio itself is deactivated
    ctx.scope.onDispose(() => {
      if (useIntrospectionStore.getState().xrayActive) {
        useIntrospectionStore.getState().setXrayActive(false);
      }
    }, 'plugin-studio:reset-xray');
  },
};

export const pluginStudioClientPackage: BuiltinPluginPackage = {
  manifest: PLUGIN_STUDIO_MANIFEST,
  client: pluginStudioClient,
};
