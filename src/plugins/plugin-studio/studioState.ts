import { create } from 'zustand';
import {
  BUILTIN_PLUGIN_IDS,
  getDeskKernelBridge,
  useIntrospectionStore,
  useLayoutStore,
  useSlotRegistry,
  type SlotKind,
} from '../../kernel/client';

export type InspectorTabId = 'overview' | 'config' | 'slots' | 'logs';

export interface AskAgentPluginPayload {
  pluginId: string;
  pluginName?: string;
  slotId?: string;
  sourcePath?: string | null;
  errorMessage?: string;
  errorStack?: string;
}

interface PluginStudioUiState {
  studioOpen: boolean;
  selectedNodeId: string | null;
  inspectorTab: InspectorTabId;
  pingedPluginId: string | null;
  pingedSlotId: SlotKind | null;

  setStudioOpen: (open: boolean) => void;
  toggleStudio: () => void;
  selectNode: (nodeId: string | null, tab?: InspectorTabId) => void;
  setInspectorTab: (tab: InspectorTabId) => void;
  pingPluginInUi: (pluginId: string | null, slotId?: SlotKind | null) => void;
  openStudioAndInspect: (pluginId?: string, tab?: InspectorTabId, opts?: { splitIfMissing?: boolean }) => void;
  askAgentAboutPlugin: (info: AskAgentPluginPayload) => void;
}

let pingClearTimer: ReturnType<typeof setTimeout> | null = null;

function findExistingTabByPaneType(paneType: string): { groupId: string; tabId: string } | null {
  const { groups } = useLayoutStore.getState();
  for (const grp of Object.values(groups)) {
    const found = grp.tabs.find((t) => t.paneType === paneType);
    if (found) return { groupId: grp.id, tabId: found.id };
  }
  return null;
}

function buildAskAgentPrompt(info: AskAgentPluginPayload): string {
  const lines = [
    `[플러그인 수정 요청: ${info.pluginName || info.pluginId} (${info.pluginId})]`,
  ];
  if (info.sourcePath) lines.push(`- 로컬 소스 경로: ${info.sourcePath}`);
  if (info.slotId) lines.push(`- 대상 UI 슬롯: ${info.slotId}`);
  if (info.errorMessage) {
    lines.push(`- 최근 오류: ${info.errorMessage}`);
    if (info.errorStack) {
      lines.push(`- 스택 요약:\n\`\`\`\n${info.errorStack.slice(0, 600)}\n\`\`\``);
    }
  }
  lines.push('');
  lines.push('위 플러그인을 확인하고 요청하는 변경/수정을 적용해 주세요:');
  return lines.join('\n');
}

export const usePluginStudioUiStore = create<PluginStudioUiState>((set) => ({
  studioOpen: false,
  selectedNodeId: null,
  inspectorTab: 'overview',
  pingedPluginId: null,
  pingedSlotId: null,

  setStudioOpen: (studioOpen) => set({ studioOpen }),
  toggleStudio: () => set((s) => ({ studioOpen: !s.studioOpen })),

  selectNode: (nodeId, tab) =>
    set((s) => ({
      selectedNodeId: nodeId,
      inspectorTab: tab ?? s.inspectorTab,
    })),

  setInspectorTab: (inspectorTab) => set({ inspectorTab }),

  pingPluginInUi: (pluginId, slotId = null) => {
    if (pingClearTimer) {
      clearTimeout(pingClearTimer);
      pingClearTimer = null;
    }
    set({ pingedPluginId: pluginId, pingedSlotId: slotId });
    if (pluginId || slotId) {
      pingClearTimer = setTimeout(() => {
        set({ pingedPluginId: null, pingedSlotId: null });
        pingClearTimer = null;
      }, 2200);
    }
  },

  openStudioAndInspect: (pluginId, tab, opts) => {
    if (pluginId) {
      set({ selectedNodeId: pluginId, inspectorTab: tab || 'overview' });
    } else if (tab) {
      set({ inspectorTab: tab });
    }

    // Default: open as full-window view so the 3-tier architecture board never squishes inside split panes
    if (!opts?.splitIfMissing) {
      if (useIntrospectionStore.getState().xrayActive) {
        useIntrospectionStore.getState().setXrayActive(false);
      }
      set({ studioOpen: true });
      return;
    }

    const existing = findExistingTabByPaneType('plugin-studio');
    const layout = useLayoutStore.getState();
    if (existing) {
      layout.setActiveTab(existing.groupId, existing.tabId);
      return;
    }
    layout.openTab('plugin-studio', undefined, { split: 'h', side: 'after' });
  },

  askAgentAboutPlugin: (info) => {
    const promptText = buildAskAgentPrompt(info);
    // Close full-window Studio & X-Ray so user lands straight in chat
    set({ studioOpen: false });
    if (useIntrospectionStore.getState().xrayActive) {
      useIntrospectionStore.getState().setXrayActive(false);
    }

    const layout = useLayoutStore.getState();
    const paneTypes = useSlotRegistry.getState().paneTypes;
    let targetGroupId: string | null = null;
    let targetTabId: string | null = null;

    const existingChat = findExistingTabByPaneType('chat');
    if (existingChat) {
      targetGroupId = existingChat.groupId;
      targetTabId = existingChat.tabId;
      layout.setActiveTab(existingChat.groupId, existingChat.tabId);
    } else if (paneTypes['chat']) {
      targetTabId = layout.openTab(
        'chat',
        info.sourcePath ? { cwd: info.sourcePath, title: `수정 · ${info.pluginId}` } : { title: `수정 · ${info.pluginId}` },
        { split: 'h', side: 'before' }
      );
      targetGroupId = useLayoutStore.getState().focusedGroupId;
    }

    // Publish open bus event for pane-chat to prefill composer draft if subscribed
    getDeskKernelBridge()?.bus.publish(
      'chat:prefill-prompt',
      {
        groupId: targetGroupId,
        tabId: targetTabId,
        pluginId: info.pluginId,
        cwd: info.sourcePath || undefined,
        prompt: promptText,
      },
      BUILTIN_PLUGIN_IDS.PLUGIN_STUDIO
    );

    // Also copy to clipboard as an immediate reliable fallback
    try {
      void navigator.clipboard?.writeText(promptText);
    } catch {
      // ignore clipboard errors
    }

    useIntrospectionStore
      .getState()
      .pushToast(
        `${info.pluginId} 수정 컨텍스트를 채팅에 전달하고 클립보드에 복사했습니다.`,
        'info'
      );
  },
}));
