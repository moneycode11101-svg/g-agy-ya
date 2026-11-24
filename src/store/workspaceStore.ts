import { create } from 'zustand';
import type {
  AccountQuotaSnapshot,
  AgyEvent,
  AuthPrompt,
  ChatMessage,
  ChatMode,
  ChatPaneTab,
  DiffPaneTab,
  LauncherPaneTab,
  LayoutNode,
  PaneGroup,
  PaneKind,
  PaneTab,
  SessionMetrics,
  SessionSummary,
  SplitDir,
  SplitDirection,
  TerminalPaneTab,
  WebviewPaneTab,
} from '../shared/types';
import { playCompletionChime } from '../utils/sound';
import { useSettingsStore } from './settingsStore';

const STORAGE_KEY = 'agy-desk:workspace:v3';

function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function getDefaultCwd(): string {
  const configured = useSettingsStore.getState().settings.defaultCwd;
  return configured || window.agyDesk?.homeDir || '/';
}

export function createLauncherTab(cwd?: string): LauncherPaneTab {
  return {
    id: uid('tab'),
    kind: 'launcher',
    title: '새 창 선택',
    cwd: cwd || getDefaultCwd(),
  };
}

export function createChatTab(opts?: Partial<ChatPaneTab>): ChatPaneTab {
  const appSettings = useSettingsStore.getState().settings;
  return {
    id: uid('tab'),
    kind: 'chat',
    title: opts?.title || '새 채팅',
    sessionId: opts?.sessionId || uid('sess'),
    agyConversationId: opts?.agyConversationId ?? null,
    cwd: opts?.cwd || getDefaultCwd(),
    projectLabel: opts?.projectLabel,
    model: opts?.model || appSettings.defaultModel || 'default',
    effort: opts?.effort || appSettings.defaultEffort || 'default',
    mode: opts?.mode || (appSettings.localPermission === 'auto' ? 'turbo' : appSettings.localPermission) || 'turbo',
    source: opts?.source || 'new',
  };
}

export function createTerminalTab(cwd?: string, title?: string): TerminalPaneTab {
  const resolved = cwd || getDefaultCwd();
  const folder = resolved.split('/').filter(Boolean).pop() || 'zsh';
  return {
    id: uid('tab'),
    kind: 'terminal',
    title: title || `터미널 · ${folder}`,
    terminalId: uid('term'),
    cwd: resolved,
  };
}

export function createWebviewTab(url?: string, title?: string): WebviewPaneTab {
  const targetUrl = url || useSettingsStore.getState().settings.defaultWebviewUrl || 'http://localhost:5173';
  let label = title;
  if (!label) {
    try {
      const u = new URL(targetUrl);
      label = u.hostname === 'localhost' || u.hostname === '127.0.0.1'
        ? `${u.hostname}:${u.port || '80'}`
        : u.hostname.replace(/^www\./, '');
    } catch {
      label = '브라우저';
    }
  }
  return {
    id: uid('tab'),
    kind: 'webview',
    title: label,
    url: targetUrl,
    partition: 'persist:agy-desk-browser',
  };
}

export function createDiffTab(cwd?: string): DiffPaneTab {
  return {
    id: uid('tab'),
    kind: 'diff',
    title: 'Git Diff',
    cwd: cwd || getDefaultCwd(),
  };
}

function createTabByKind(kind: PaneKind, initial?: { url?: string; cwd?: string; title?: string }): PaneTab {
  if (kind === 'launcher') return createLauncherTab(initial?.cwd);
  if (kind === 'chat') return createChatTab({ cwd: initial?.cwd, title: initial?.title });
  if (kind === 'terminal') return createTerminalTab(initial?.cwd, initial?.title);
  if (kind === 'diff') return createDiffTab(initial?.cwd);
  return createWebviewTab(initial?.url, initial?.title);
}

function splitLeafInTree(
  node: LayoutNode,
  targetGroupId: string,
  dir: SplitDir,
  newGroupId: string,
  side: 'before' | 'after' = 'after'
): LayoutNode {
  if (node.type === 'leaf') {
    if (node.groupId !== targetGroupId) return node;
    const newLeaf: LayoutNode = { type: 'leaf', groupId: newGroupId };
    return {
      type: 'split',
      id: uid('split'),
      dir,
      ratio: 0.5,
      a: side === 'before' ? newLeaf : node,
      b: side === 'before' ? node : newLeaf,
    };
  }
  return {
    ...node,
    a: splitLeafInTree(node.a, targetGroupId, dir, newGroupId, side),
    b: splitLeafInTree(node.b, targetGroupId, dir, newGroupId, side),
  };
}

function removeLeafFromTree(node: LayoutNode, targetGroupId: string): LayoutNode | null {
  if (node.type === 'leaf') {
    return node.groupId === targetGroupId ? null : node;
  }
  const nextA = removeLeafFromTree(node.a, targetGroupId);
  const nextB = removeLeafFromTree(node.b, targetGroupId);
  if (!nextA) return nextB;
  if (!nextB) return nextA;
  return { ...node, a: nextA, b: nextB };
}

function updateRatioInTree(node: LayoutNode, splitId: string, ratio: number): LayoutNode {
  if (node.type === 'leaf') return node;
  if (node.id === splitId) {
    return { ...node, ratio: Math.min(0.85, Math.max(0.15, ratio)) };
  }
  return {
    ...node,
    a: updateRatioInTree(node.a, splitId, ratio),
    b: updateRatioInTree(node.b, splitId, ratio),
  };
}

function firstGroupId(node: LayoutNode): string {
  return node.type === 'leaf' ? node.groupId : firstGroupId(node.a);
}

function sortPinnedTabs(tabs: PaneTab[]): PaneTab[] {
  const pinned = tabs.filter((t) => t.pinned);
  const normal = tabs.filter((t) => !t.pinned);
  return [...pinned, ...normal];
}

function cleanupTabResources(tab: PaneTab): void {
  if (tab.kind === 'chat') {
    void window.agyDesk?.unwatchSession(tab.sessionId);
    void window.agyDesk?.cancelTurn(tab.sessionId);
  } else if (tab.kind === 'terminal') {
    void window.agyDesk?.killTerminal(tab.terminalId);
  }
}

interface PersistedWorkspace {
  layout: LayoutNode;
  groups: Record<string, PaneGroup>;
  focusedGroupId: string;
  sidebarOpen: boolean;
}

function createInitialWorkspace(): PersistedWorkspace {
  const g1 = 'grp-main';
  const chatTab = createChatTab({ title: '새 대화' });
  return {
    layout: { type: 'leaf', groupId: g1 },
    groups: {
      [g1]: { id: g1, activeTabId: chatTab.id, tabs: [chatTab] },
    },
    focusedGroupId: g1,
    sidebarOpen: true,
  };
}

function loadPersistedWorkspace(): PersistedWorkspace {
  try {
    const raw = localStorage.getItem(STORAGE_KEY) || localStorage.getItem('agy-desk:workspace:v2');
    if (!raw) return createInitialWorkspace();
    const parsed = JSON.parse(raw) as PersistedWorkspace;
    if (parsed?.layout && parsed?.groups && Object.keys(parsed.groups).length > 0) {
      // Migrate legacy 'auto' chat tabs to 'turbo' (--mode auto is unavailable on this account)
      for (const grp of Object.values(parsed.groups)) {
        for (const t of grp.tabs) {
          if (t.kind === 'chat' && t.mode === 'auto') {
            t.mode = 'turbo';
          }
        }
      }
      return parsed;
    }
  } catch {
    // ignore corrupt storage
  }
  return createInitialWorkspace();
}

function savePersistedWorkspace(
  state: Pick<PersistedWorkspace, 'layout' | 'groups' | 'focusedGroupId' | 'sidebarOpen'>
) {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        layout: state.layout,
        groups: state.groups,
        focusedGroupId: state.focusedGroupId,
        sidebarOpen: state.sidebarOpen,
      })
    );
  } catch {
    // ignore
  }
}

export interface WorkspaceState extends PersistedWorkspace {
  messagesBySession: Record<string, ChatMessage[]>;
  metricsBySession: Record<string, SessionMetrics>;
  runningSessions: Record<string, boolean>;
  queuedPromptsBySession: Record<string, Array<{ prompt: string; images?: string[] }>>;
  authPrompts: Record<string, AuthPrompt>;
  errorsBySession: Record<string, string>;

  recentSessions: SessionSummary[];
  loadingSessions: boolean;
  accountQuota: AccountQuotaSnapshot | null;
  loadingQuota: boolean;
  draggedTab: { groupId: string; tabId: string } | null;

  // Layout & Orca split/tab actions
  setFocusedGroup: (groupId: string) => void;
  setDraggedTab: (drag: { groupId: string; tabId: string } | null) => void;
  toggleSidebar: () => void;
  resetLayout: () => void;
  splitGroup: (
    groupId: string,
    dir: SplitDir,
    kind?: PaneKind,
    initialUrl?: string,
    side?: 'before' | 'after'
  ) => void;
  addTabToGroup: (groupId: string, kind: PaneKind, initial?: { url?: string; cwd?: string; title?: string }) => void;
  convertLauncherTab: (
    groupId: string,
    tabId: string,
    kind: Exclude<PaneKind, 'launcher'>,
    initial?: { url?: string; cwd?: string; title?: string }
  ) => void;
  moveTabToGroup: (fromGroupId: string, tabId: string, toGroupId: string, insertIndex?: number) => void;
  moveTabToNewSplit: (
    fromGroupId: string,
    tabId: string,
    targetGroupId: string,
    direction: SplitDirection
  ) => void;
  duplicateTab: (groupId: string, tabId: string) => void;
  togglePinTab: (groupId: string, tabId: string) => void;
  setTabColor: (groupId: string, tabId: string, color: string | null) => void;
  renameTab: (groupId: string, tabId: string, title: string) => void;
  setActiveTab: (groupId: string, tabId: string) => void;
  closeTab: (groupId: string, tabId: string) => void;
  closeOtherTabs: (groupId: string, keepTabId: string) => void;
  closeSplitPane: (groupId: string) => void;
  setSplitRatio: (splitId: string, ratio: number) => void;
  updateTab: (groupId: string, tabId: string, patch: Partial<PaneTab>) => void;
  openUrlInWebview: (url: string) => void;

  // Session & agy actions
  refreshRecentSessions: () => Promise<void>;
  refreshAccountQuota: (force?: boolean) => Promise<void>;
  setAccountQuota: (snap: AccountQuotaSnapshot) => void;
  openExistingSession: (
    summary: SessionSummary,
    inNewSplit?: boolean | SplitDir,
    targetGroupId?: string
  ) => Promise<void>;
  sendPrompt: (groupId: string, tab: ChatPaneTab, prompt: string, images?: string[]) => Promise<void>;
  clearQueuedPrompts: (tabSessionId: string) => void;
  cancelTurn: (tabSessionId: string) => Promise<void>;
  submitAuthCode: (tabSessionId: string, code: string) => Promise<void>;
  handleAgyEvent: (ev: AgyEvent) => void;
}

const initial = loadPersistedWorkspace();

export const useWorkspaceStore = create<WorkspaceState>((set, get) => {
  const persist = () => {
    const s = get();
    savePersistedWorkspace({
      layout: s.layout,
      groups: s.groups,
      focusedGroupId: s.focusedGroupId,
      sidebarOpen: s.sidebarOpen,
    });
  };

  return {
    ...initial,
    messagesBySession: {},
    metricsBySession: {},
    runningSessions: {},
    queuedPromptsBySession: {},
    authPrompts: {},
    errorsBySession: {},
    recentSessions: [],
    loadingSessions: false,
    accountQuota: null,
    loadingQuota: false,
    draggedTab: null,

    setFocusedGroup: (groupId) => {
      if (get().focusedGroupId === groupId) return;
      set({ focusedGroupId: groupId });
      persist();
    },

    setDraggedTab: (draggedTab) => {
      set({ draggedTab });
    },

    toggleSidebar: () => {
      set((s) => ({ sidebarOpen: !s.sidebarOpen }));
      persist();
    },

    resetLayout: () => {
      const s = get();
      for (const grp of Object.values(s.groups)) {
        for (const t of grp.tabs) cleanupTabResources(t);
      }
      const fresh = createInitialWorkspace();
      set(fresh);
      persist();
    },

    splitGroup: (groupId, dir, kind = 'launcher', initialUrl, side = 'after') => {
      const s = get();
      const sourceGroup = s.groups[groupId];
      const activeTab = sourceGroup?.tabs.find((t) => t.id === sourceGroup.activeTabId);
      const inheritedCwd = activeTab && 'cwd' in activeTab ? activeTab.cwd : getDefaultCwd();
      const newTab = createTabByKind(kind, { url: initialUrl, cwd: inheritedCwd });
      const newGroupId = uid('grp');
      const nextLayout = splitLeafInTree(s.layout, groupId, dir, newGroupId, side);
      set({
        layout: nextLayout,
        groups: {
          ...s.groups,
          [newGroupId]: { id: newGroupId, activeTabId: newTab.id, tabs: [newTab] },
        },
        focusedGroupId: newGroupId,
      });
      persist();
    },

    addTabToGroup: (groupId, kind, init) => {
      const s = get();
      const grp = s.groups[groupId];
      if (!grp) return;
      const activeTab = grp.tabs.find((t) => t.id === grp.activeTabId);
      const cwd = init?.cwd || (activeTab && 'cwd' in activeTab ? activeTab.cwd : getDefaultCwd());
      const newTab = createTabByKind(kind, { url: init?.url, cwd, title: init?.title });
      set({
        groups: {
          ...s.groups,
          [groupId]: {
            ...grp,
            activeTabId: newTab.id,
            tabs: [...grp.tabs, newTab],
          },
        },
        focusedGroupId: groupId,
      });
      persist();
    },

    convertLauncherTab: (groupId, tabId, kind, init) => {
      const s = get();
      const grp = s.groups[groupId];
      if (!grp) return;
      const target = grp.tabs.find((t) => t.id === tabId);
      if (!target) return;
      const cwd = init?.cwd || ('cwd' in target ? target.cwd : getDefaultCwd());
      const created = createTabByKind(kind, { url: init?.url, cwd, title: init?.title });
      const replaced: PaneTab = {
        ...created,
        pinned: target.pinned,
        color: target.color,
      };
      const nextTabs = grp.tabs.map((t) => (t.id === tabId ? replaced : t));
      set({
        groups: {
          ...s.groups,
          [groupId]: {
            ...grp,
            activeTabId: replaced.id,
            tabs: nextTabs,
          },
        },
        focusedGroupId: groupId,
      });
      persist();
    },

    moveTabToGroup: (fromGroupId, tabId, toGroupId, insertIndex) => {
      const s = get();
      const fromGrp = s.groups[fromGroupId];
      const toGrp = s.groups[toGroupId];
      if (!fromGrp || !toGrp) return;
      const moving = fromGrp.tabs.find((t) => t.id === tabId);
      if (!moving) return;

      if (fromGroupId === toGroupId) {
        const oldIdx = fromGrp.tabs.findIndex((t) => t.id === tabId);
        if (oldIdx === -1) return;
        const copy = [...fromGrp.tabs];
        copy.splice(oldIdx, 1);
        const targetIdx = insertIndex == null ? copy.length : Math.max(0, Math.min(copy.length, insertIndex));
        copy.splice(targetIdx, 0, moving);
        set({
          groups: {
            ...s.groups,
            [fromGroupId]: { ...fromGrp, tabs: sortPinnedTabs(copy), activeTabId: moving.id },
          },
          focusedGroupId: fromGroupId,
        });
        persist();
        return;
      }

      const fromRemaining = fromGrp.tabs.filter((t) => t.id !== tabId);
      const nextToTabs = [...toGrp.tabs];
      const idx = insertIndex == null ? nextToTabs.length : Math.max(0, Math.min(nextToTabs.length, insertIndex));
      nextToTabs.splice(idx, 0, moving);

      const nextGroups: Record<string, PaneGroup> = {
        ...s.groups,
        [toGroupId]: { ...toGrp, tabs: sortPinnedTabs(nextToTabs), activeTabId: moving.id },
      };
      let nextLayout = s.layout;

      if (fromRemaining.length === 0) {
        const pruned = removeLeafFromTree(s.layout, fromGroupId);
        if (pruned) {
          nextLayout = pruned;
          delete nextGroups[fromGroupId];
        } else {
          const fresh = createLauncherTab();
          nextGroups[fromGroupId] = { id: fromGroupId, activeTabId: fresh.id, tabs: [fresh] };
        }
      } else {
        const nextFromActive =
          fromGrp.activeTabId === tabId ? fromRemaining[fromRemaining.length - 1].id : fromGrp.activeTabId;
        nextGroups[fromGroupId] = { ...fromGrp, tabs: fromRemaining, activeTabId: nextFromActive };
      }

      set({
        layout: nextLayout,
        groups: nextGroups,
        focusedGroupId: toGroupId,
      });
      persist();
    },

    moveTabToNewSplit: (fromGroupId, tabId, targetGroupId, direction) => {
      const s = get();
      const fromGrp = s.groups[fromGroupId];
      const targetGrp = s.groups[targetGroupId];
      if (!fromGrp || !targetGrp) return;
      const moving = fromGrp.tabs.find((t) => t.id === tabId);
      if (!moving) return;

      // Don't split a single-tab pane onto itself (that would be a no-op)
      if (fromGroupId === targetGroupId && fromGrp.tabs.length <= 1) return;

      const dir: SplitDir = direction === 'left' || direction === 'right' ? 'h' : 'v';
      const side: 'before' | 'after' = direction === 'left' || direction === 'up' ? 'before' : 'after';

      const newGroupId = uid('grp');
      let nextLayout = splitLeafInTree(s.layout, targetGroupId, dir, newGroupId, side);
      const nextGroups: Record<string, PaneGroup> = {
        ...s.groups,
        [newGroupId]: { id: newGroupId, activeTabId: moving.id, tabs: [moving] },
      };

      const fromRemaining = fromGrp.tabs.filter((t) => t.id !== tabId);
      if (fromRemaining.length === 0) {
        const pruned = removeLeafFromTree(nextLayout, fromGroupId);
        if (pruned) {
          nextLayout = pruned;
          delete nextGroups[fromGroupId];
        }
      } else {
        const nextFromActive =
          fromGrp.activeTabId === tabId ? fromRemaining[fromRemaining.length - 1].id : fromGrp.activeTabId;
        nextGroups[fromGroupId] = { ...fromGrp, tabs: fromRemaining, activeTabId: nextFromActive };
      }

      set({
        layout: nextLayout,
        groups: nextGroups,
        focusedGroupId: newGroupId,
      });
      persist();
    },

    duplicateTab: (groupId, tabId) => {
      const s = get();
      const grp = s.groups[groupId];
      if (!grp) return;
      const src = grp.tabs.find((t) => t.id === tabId);
      if (!src) return;
      let dup: PaneTab;
      if (src.kind === 'webview') {
        dup = createWebviewTab(src.url, src.title);
      } else if (src.kind === 'terminal') {
        dup = createTerminalTab(src.cwd);
      } else if (src.kind === 'diff') {
        dup = createDiffTab(src.cwd);
      } else if (src.kind === 'launcher') {
        dup = createLauncherTab(src.cwd);
      } else {
        dup = createChatTab({ cwd: src.cwd, model: src.model, effort: src.effort, mode: src.mode });
      }
      dup.color = src.color;
      const idx = grp.tabs.findIndex((t) => t.id === tabId);
      const nextTabs = [...grp.tabs];
      nextTabs.splice(idx + 1, 0, dup);
      set({
        groups: {
          ...s.groups,
          [groupId]: { ...grp, tabs: nextTabs, activeTabId: dup.id },
        },
        focusedGroupId: groupId,
      });
      persist();
    },

    togglePinTab: (groupId, tabId) => {
      const s = get();
      const grp = s.groups[groupId];
      if (!grp) return;
      const toggled = grp.tabs.map((t) => (t.id === tabId ? ({ ...t, pinned: !t.pinned } as PaneTab) : t));
      set({
        groups: {
          ...s.groups,
          [groupId]: { ...grp, tabs: sortPinnedTabs(toggled) },
        },
      });
      persist();
    },

    setTabColor: (groupId, tabId, color) => {
      get().updateTab(groupId, tabId, { color });
    },

    renameTab: (groupId, tabId, title) => {
      const trimmed = title.trim();
      if (!trimmed) return;
      get().updateTab(groupId, tabId, { title: trimmed });
    },

    setActiveTab: (groupId, tabId) => {
      const s = get();
      const grp = s.groups[groupId];
      if (!grp) return;
      set({
        groups: { ...s.groups, [groupId]: { ...grp, activeTabId: tabId } },
        focusedGroupId: groupId,
      });
      persist();
    },

    closeTab: (groupId, tabId) => {
      const s = get();
      const grp = s.groups[groupId];
      if (!grp) return;
      const closing = grp.tabs.find((t) => t.id === tabId);
      if (!closing) return;

      if (closing.kind === 'chat') {
        const isBusy = Boolean(s.runningSessions[closing.sessionId]);
        const confirmClose = useSettingsStore.getState().settings.confirmCloseRunning;
        if (isBusy && confirmClose) {
          const ok = window.confirm('응답을 생성 중인 채팅입니다. 중단하고 닫으시겠습니까?');
          if (!ok) return;
        }
      }
      cleanupTabResources(closing);

      const remaining = grp.tabs.filter((t) => t.id !== tabId);
      if (remaining.length > 0) {
        const nextActive = grp.activeTabId === tabId ? remaining[remaining.length - 1].id : grp.activeTabId;
        set({
          groups: {
            ...s.groups,
            [groupId]: { ...grp, tabs: remaining, activeTabId: nextActive },
          },
        });
        persist();
        return;
      }

      const nextLayout = removeLeafFromTree(s.layout, groupId);
      if (!nextLayout) {
        const freshTab = createChatTab();
        set({
          groups: {
            ...s.groups,
            [groupId]: { id: groupId, activeTabId: freshTab.id, tabs: [freshTab] },
          },
        });
        persist();
        return;
      }
      const nextGroups = { ...s.groups };
      delete nextGroups[groupId];
      const nextFocus = s.focusedGroupId === groupId ? firstGroupId(nextLayout) : s.focusedGroupId;
      set({
        layout: nextLayout,
        groups: nextGroups,
        focusedGroupId: nextFocus,
      });
      persist();
    },

    closeOtherTabs: (groupId, keepTabId) => {
      const s = get();
      const grp = s.groups[groupId];
      if (!grp) return;
      const keep: PaneTab[] = [];
      for (const tab of grp.tabs) {
        if (tab.id === keepTabId || tab.pinned) {
          keep.push(tab);
        } else {
          cleanupTabResources(tab);
        }
      }
      set({
        groups: {
          ...s.groups,
          [groupId]: { ...grp, tabs: keep, activeTabId: keepTabId },
        },
        focusedGroupId: groupId,
      });
      persist();
    },

    closeSplitPane: (groupId) => {
      const s = get();
      const grp = s.groups[groupId];
      if (!grp) return;
      const confirmClose = useSettingsStore.getState().settings.confirmCloseRunning;
      const hasBusyChat = grp.tabs.some((t) => t.kind === 'chat' && s.runningSessions[t.sessionId]);
      if (hasBusyChat && confirmClose) {
        const ok = window.confirm('이 분할 창에 응답 생성 중인 채팅이 있습니다. 모두 중단하고 닫으시겠습니까?');
        if (!ok) return;
      }
      for (const tab of grp.tabs) cleanupTabResources(tab);

      const nextLayout = removeLeafFromTree(s.layout, groupId);
      if (!nextLayout) {
        const fresh = createChatTab();
        set({
          groups: {
            [groupId]: { id: groupId, activeTabId: fresh.id, tabs: [fresh] },
          },
          focusedGroupId: groupId,
        });
        persist();
        return;
      }
      const nextGroups = { ...s.groups };
      delete nextGroups[groupId];
      const nextFocus = s.focusedGroupId === groupId ? firstGroupId(nextLayout) : s.focusedGroupId;
      set({
        layout: nextLayout,
        groups: nextGroups,
        focusedGroupId: nextFocus,
      });
      persist();
    },

    setSplitRatio: (splitId, ratio) => {
      set((s) => ({ layout: updateRatioInTree(s.layout, splitId, ratio) }));
      persist();
    },

    updateTab: (groupId, tabId, patch) => {
      const s = get();
      const grp = s.groups[groupId];
      if (!grp) return;
      const nextTabs = grp.tabs.map((t) => (t.id === tabId ? ({ ...t, ...patch } as PaneTab) : t));
      set({
        groups: { ...s.groups, [groupId]: { ...grp, tabs: nextTabs } },
      });
      persist();
    },

    openUrlInWebview: (url) => {
      const s = get();
      const webGroup = Object.values(s.groups).find((g) => g.tabs.some((t) => t.kind === 'webview'));
      if (webGroup) {
        get().addTabToGroup(webGroup.id, 'webview', { url });
      } else {
        get().splitGroup(s.focusedGroupId, 'h', 'webview', url);
      }
    },

    refreshRecentSessions: async () => {
      if (!window.agyDesk) return;
      set({ loadingSessions: true });
      try {
        const list = await window.agyDesk.listSessions();
        set({ recentSessions: list });
      } finally {
        set({ loadingSessions: false });
      }
    },

    refreshAccountQuota: async (force = false) => {
      if (!window.agyDesk) return;
      set({ loadingQuota: true });
      try {
        const snap = await window.agyDesk.getQuota(force);
        if (snap && (snap.buckets.length > 0 || !get().accountQuota)) {
          set({ accountQuota: snap });
        }
      } finally {
        set({ loadingQuota: false });
      }
    },

    setAccountQuota: (snap) => {
      if (snap && snap.buckets.length > 0) {
        set({ accountQuota: snap });
      }
    },

    openExistingSession: async (summary, inNewSplit = false, targetGroupId) => {
      const s = get();
      for (const grp of Object.values(s.groups)) {
        const existing = grp.tabs.find(
          (t): t is ChatPaneTab => t.kind === 'chat' && t.agyConversationId === summary.conversationId
        );
        if (existing) {
          get().setActiveTab(grp.id, existing.id);
          return;
        }
      }

      const newTab = createChatTab({
        title: summary.title,
        agyConversationId: summary.conversationId,
        projectLabel: summary.projectLabel || undefined,
        model: summary.model || 'default',
        source: summary.source,
      });

      const baseGroupId = targetGroupId || s.focusedGroupId;

      if (inNewSplit) {
        const splitDir: SplitDir = inNewSplit === 'v' ? 'v' : 'h';
        const newGroupId = uid('grp');
        const nextLayout = splitLeafInTree(s.layout, baseGroupId, splitDir, newGroupId);
        set({
          layout: nextLayout,
          groups: {
            ...s.groups,
            [newGroupId]: { id: newGroupId, activeTabId: newTab.id, tabs: [newTab] },
          },
          focusedGroupId: newGroupId,
        });
      } else {
        const targetGroup = s.groups[baseGroupId] || Object.values(s.groups)[0];
        const currentActive = targetGroup.tabs.find((t) => t.id === targetGroup.activeTabId);
        const replaceLauncher = currentActive?.kind === 'launcher';
        const replaceSingleChat =
          Object.keys(s.groups).length === 1 &&
          targetGroup.tabs.length === 1 &&
          currentActive?.kind === 'chat' &&
          !s.runningSessions[currentActive.sessionId];

        if (replaceSingleChat && currentActive?.kind === 'chat') {
          void window.agyDesk?.unwatchSession(currentActive.sessionId);
        }

        const nextTabs = replaceLauncher
          ? targetGroup.tabs.map((t) => (t.id === currentActive.id ? newTab : t))
          : replaceSingleChat
            ? [newTab]
            : [...targetGroup.tabs, newTab];

        set({
          groups: {
            ...s.groups,
            [targetGroup.id]: {
              ...targetGroup,
              activeTabId: newTab.id,
              tabs: nextTabs,
            },
          },
          focusedGroupId: targetGroup.id,
        });
      }
      persist();

      if (window.agyDesk) {
        const loaded = await window.agyDesk.loadSession(summary.conversationId);
        const watched = await window.agyDesk.watchSession(newTab.sessionId, summary.conversationId);
        set((prev) => ({
          messagesBySession: {
            ...prev.messagesBySession,
            [newTab.sessionId]: loaded.messages,
          },
          metricsBySession:
            watched || loaded.metrics
              ? { ...prev.metricsBySession, [newTab.sessionId]: (watched || loaded.metrics)! }
              : prev.metricsBySession,
        }));
      }
    },

    sendPrompt: async (groupId, tab, prompt, images) => {
      const trimmed = prompt.trim();
      if (!trimmed) return;

      if (get().runningSessions[tab.sessionId]) {
        const mode = useSettingsStore.getState().settings.pendingMessageMode;
        if (mode === 'queue') {
          set((prev) => ({
            queuedPromptsBySession: {
              ...prev.queuedPromptsBySession,
              [tab.sessionId]: [
                ...(prev.queuedPromptsBySession[tab.sessionId] || []),
                { prompt: trimmed, images },
              ],
            },
          }));
          return;
        }
        await get().cancelTurn(tab.sessionId);
      }

      const userMsg: ChatMessage = {
        id: uid('u'),
        role: 'user',
        text: trimmed,
        images: images && images.length > 0 ? images : undefined,
        createdAt: Date.now(),
      };
      const assistantMsg: ChatMessage = {
        id: uid('a'),
        role: 'assistant',
        text: '',
        tools: [],
        createdAt: Date.now(),
        streaming: true,
      };

      const isFirst = (get().messagesBySession[tab.sessionId]?.length || 0) === 0;
      if (isFirst && (tab.title === '새 채팅' || tab.title === '새 대화' || tab.title === '메인 채팅')) {
        const shortTitle = trimmed.length > 26 ? trimmed.slice(0, 26) + '…' : trimmed;
        get().updateTab(groupId, tab.id, { title: shortTitle });
      }

      set((prev) => ({
        messagesBySession: {
          ...prev.messagesBySession,
          [tab.sessionId]: [...(prev.messagesBySession[tab.sessionId] || []), userMsg, assistantMsg],
        },
        runningSessions: { ...prev.runningSessions, [tab.sessionId]: true },
        errorsBySession: { ...prev.errorsBySession, [tab.sessionId]: '' },
      }));

      const res = await window.agyDesk?.sendPrompt({
        tabSessionId: tab.sessionId,
        agyConversationId: tab.agyConversationId,
        prompt: trimmed,
        cwd: tab.cwd,
        model: tab.model,
        effort: tab.effort,
        mode: tab.mode as ChatMode,
        images,
      });

      if (res && !res.ok) {
        set((prev) => ({
          runningSessions: { ...prev.runningSessions, [tab.sessionId]: false },
          errorsBySession: { ...prev.errorsBySession, [tab.sessionId]: res.error || '실행 실패' },
        }));
      }
    },

    clearQueuedPrompts: (tabSessionId) => {
      set((prev) => {
        const next = { ...prev.queuedPromptsBySession };
        delete next[tabSessionId];
        return { queuedPromptsBySession: next };
      });
    },

    cancelTurn: async (tabSessionId) => {
      await window.agyDesk?.cancelTurn(tabSessionId);
      set((prev) => {
        const msgs = (prev.messagesBySession[tabSessionId] || []).map((m) =>
          m.streaming ? { ...m, streaming: false } : m
        );
        return {
          messagesBySession: { ...prev.messagesBySession, [tabSessionId]: msgs },
          runningSessions: { ...prev.runningSessions, [tabSessionId]: false },
        };
      });
    },

    submitAuthCode: async (tabSessionId, code) => {
      const ok = await window.agyDesk?.submitAuthCode(tabSessionId, code);
      if (ok) {
        set((prev) => {
          const next = { ...prev.authPrompts };
          delete next[tabSessionId];
          return { authPrompts: next };
        });
      }
    },

    handleAgyEvent: (ev) => {
      const sid = ev.tabSessionId;

      if (ev.type === 'session_init') {
        const s = get();
        for (const grp of Object.values(s.groups)) {
          const tab = grp.tabs.find((t): t is ChatPaneTab => t.kind === 'chat' && t.sessionId === sid);
          if (tab) {
            get().updateTab(grp.id, tab.id, {
              agyConversationId: ev.agyConversationId,
              model: ev.model || tab.model,
              source: 'cli',
            });
            break;
          }
        }
        return;
      }

      if (ev.type === 'auth_required') {
        set((prev) => ({
          authPrompts: {
            ...prev.authPrompts,
            [sid]: { url: ev.url, message: ev.message },
          },
        }));
        return;
      }

      if (ev.type === 'metrics') {
        set((prev) => ({
          metricsBySession: { ...prev.metricsBySession, [sid]: ev.metrics },
        }));
        return;
      }

      if (ev.type === 'text_delta' || ev.type === 'thinking_delta') {
        set((prev) => {
          const list = [...(prev.messagesBySession[sid] || [])];
          let last = list[list.length - 1];
          if (!last || last.role !== 'assistant') {
            last = { id: uid('a'), role: 'assistant', text: '', tools: [], createdAt: Date.now(), streaming: true };
            list.push(last);
          } else {
            last = { ...last };
            list[list.length - 1] = last;
          }
          if (ev.type === 'text_delta') last.text += ev.delta;
          else last.thinking = (last.thinking || '') + ev.delta;
          return { messagesBySession: { ...prev.messagesBySession, [sid]: list } };
        });
        return;
      }

      if (ev.type === 'tool_use') {
        set((prev) => {
          const list = [...(prev.messagesBySession[sid] || [])];
          let last = list[list.length - 1];
          if (!last || last.role !== 'assistant') {
            last = { id: uid('a'), role: 'assistant', text: '', tools: [], createdAt: Date.now(), streaming: true };
            list.push(last);
          } else {
            last = { ...last, tools: [...(last.tools || [])] };
            list[list.length - 1] = last;
          }
          last.tools!.push(ev.tool);
          return { messagesBySession: { ...prev.messagesBySession, [sid]: list } };
        });
        return;
      }

      if (ev.type === 'tool_result') {
        set((prev) => {
          const list = [...(prev.messagesBySession[sid] || [])];
          const last = list[list.length - 1];
          if (!last || last.role !== 'assistant' || !last.tools) return prev;
          const tools = last.tools.map((t) =>
            t.id === ev.toolId || (!ev.toolId && t.status === 'running')
              ? { ...t, outputPreview: ev.output, status: ev.isError ? ('error' as const) : ('done' as const) }
              : t
          );
          list[list.length - 1] = { ...last, tools };
          return { messagesBySession: { ...prev.messagesBySession, [sid]: list } };
        });
        return;
      }

      if (ev.type === 'done') {
        const appSettings = useSettingsStore.getState().settings;
        if (appSettings.soundEnabled) {
          playCompletionChime(appSettings.soundVolume);
        }

        const queued = get().queuedPromptsBySession[sid] || [];
        const nextQueuedItem = queued[0];
        const remainingQueue = queued.slice(1);

        set((prev) => {
          const list = (prev.messagesBySession[sid] || []).map((m) =>
            m.streaming
              ? {
                  ...m,
                  streaming: false,
                  tools: m.tools?.map((t) => (t.status === 'running' ? { ...t, status: 'done' as const } : t)),
                }
              : m
          );
          const nextAuth = { ...prev.authPrompts };
          delete nextAuth[sid];
          return {
            messagesBySession: { ...prev.messagesBySession, [sid]: list },
            runningSessions: { ...prev.runningSessions, [sid]: false },
            queuedPromptsBySession: { ...prev.queuedPromptsBySession, [sid]: remainingQueue },
            authPrompts: nextAuth,
            errorsBySession: ev.error ? { ...prev.errorsBySession, [sid]: ev.error } : prev.errorsBySession,
          };
        });
        void get().refreshRecentSessions();

        if (nextQueuedItem && !ev.error) {
          const s = get();
          for (const grp of Object.values(s.groups)) {
            const targetTab = grp.tabs.find((t): t is ChatPaneTab => t.kind === 'chat' && t.sessionId === sid);
            if (targetTab) {
              setTimeout(() => {
                void get().sendPrompt(grp.id, targetTab, nextQueuedItem.prompt, nextQueuedItem.images);
              }, 80);
              break;
            }
          }
        }
      }
    },
  };
});
