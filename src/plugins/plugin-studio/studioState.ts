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
  selectedNodeId: string | null;
  inspectorTab: InspectorTabId;
  pingedPluginId: string | null;
  pingedSlotId: SlotKind | null;
  creatorModeActive: boolean;

  selectNode: (nodeId: string | null, tab?: InspectorTabId) => void;
  setInspectorTab: (tab: InspectorTabId) => void;
  pingPluginInUi: (pluginId: string | null, slotId?: SlotKind | null) => void;
  openStudioAndInspect: (pluginId?: string, tab?: InspectorTabId, opts?: { splitIfMissing?: boolean }) => void;
  toggleCreatorMode: (previewPaneType?: string) => void;
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

export const usePluginStudioUiStore = create<PluginStudioUiState>((set, get) => ({
  selectedNodeId: null,
  inspectorTab: 'overview',
  pingedPluginId: null,
  pingedSlotId: null,
  creatorModeActive: false,

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

    const existing = findExistingTabByPaneType('plugin-studio');
    const layout = useLayoutStore.getState();
    if (existing) {
      layout.setActiveTab(existing.groupId, existing.tabId);
      return;
    }

    const shouldSplit = opts?.splitIfMissing ?? false;
    if (shouldSplit) {
      layout.openTab('plugin-studio', undefined, { split: 'h', side: 'after' });
    } else {
      layout.openTab('plugin-studio');
    }
  },

  toggleCreatorMode: (previewPaneType) => {
    const layout = useLayoutStore.getState();
    const { creatorModeActive } = get();

    if (creatorModeActive && layout.savedLayoutSnapshot) {
      layout.restoreLayoutSnapshot();
      set({ creatorModeActive: false });
      useIntrospectionStore.getState().pushToast('이전 워크스페이스 레이아웃으로 복귀했습니다.', 'info');
      return;
    }

    // Snapshot current workspace so user can exit Creator Mode losslessly in 1 click
    layout.saveLayoutSnapshot();

    const paneTypes = useSlotRegistry.getState().paneTypes;
    const snap = useIntrospectionStore.getState().snapshot;

    // Pick best preview pane for bottom-right: explicit -> any active local-dev pane -> launcher -> core:empty
    let resolvedPreviewType = previewPaneType;
    if (!resolvedPreviewType && snap) {
      const localPluginIds = new Set(
        Object.values(snap.plugins)
          .filter((p) => p.origin === 'local-dev' && p.lifecycleState === 'active')
          .map((p) => p.id)
      );
      const localPane = Object.values(paneTypes).find(
        (def) => def.ownerPluginId && localPluginIds.has(def.ownerPluginId)
      );
      if (localPane) resolvedPreviewType = localPane.type;
    }
    if (!resolvedPreviewType) {
      resolvedPreviewType = paneTypes['launcher'] ? 'launcher' : 'core:empty';
    }

    const leftType = paneTypes['chat'] ? 'chat' : paneTypes['launcher'] ? 'launcher' : 'core:empty';

    // Reuse existing left chat tab if present in focused group, else open one
    const initialGroups = Object.values(layout.groups);
    let leftGroupId = layout.focusedGroupId;
    const existingChat = findExistingTabByPaneType('chat');
    if (existingChat) {
      leftGroupId = existingChat.groupId;
      layout.setActiveTab(existingChat.groupId, existingChat.tabId);
    } else if (initialGroups.length > 0) {
      leftGroupId = initialGroups[0].id;
      layout.addTabToGroup(leftGroupId, leftType);
    }

    // Split right -> top-right: Plugin Studio
    layout.splitGroup(leftGroupId, 'h', 'plugin-studio', undefined, 'after');
    const rightTopGroupId = useLayoutStore.getState().focusedGroupId;

    // Split bottom of right-top -> bottom-right: Local plugin live preview or launcher
    useLayoutStore.getState().splitGroup(rightTopGroupId, 'v', resolvedPreviewType, undefined, 'after');

    // Focus back to left chat for immediate prompting
    useLayoutStore.getState().setFocusedGroup(leftGroupId);
    set({ creatorModeActive: true });
    useIntrospectionStore
      .getState()
      .pushToast('크리에이터 3분할 활성화: [좌: 채팅] + [우상: 스튜디오] + [우하: 미리보기]', 'info');
  },

  askAgentAboutPlugin: (info) => {
    const promptText = buildAskAgentPrompt(info);
    // Turn off X-Ray so user lands straight in chat
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
