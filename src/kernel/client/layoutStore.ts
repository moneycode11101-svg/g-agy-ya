import { create } from 'zustand';
import {
  BUILTIN_PLUGIN_IDS,
  type LayoutNode,
  type PaneGroupRecord,
  type PaneTabRecord,
  type PersistedLayoutWorkspace,
  type SplitDir,
  type SplitDirection,
} from '../shared/types';
import { getDeskKernelBridge } from './sharedRuntime';
import { useSlotRegistry } from './slotRegistry';

const STORAGE_KEY_V4 = 'agy-desk:workspace:v4';
const STORAGE_KEY_V3 = 'agy-desk:workspace:v3';
const STORAGE_KEY_V2 = 'agy-desk:workspace:v2';

export const CORE_EMPTY_PANE_TYPE = 'core:empty';

function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

const LEGACY_KIND_TO_PLUGIN: Record<string, string> = {
  chat: BUILTIN_PLUGIN_IDS.PANE_CHAT,
  terminal: BUILTIN_PLUGIN_IDS.PANE_TERMINAL,
  webview: BUILTIN_PLUGIN_IDS.PANE_WEBVIEW,
  diff: BUILTIN_PLUGIN_IDS.PANE_GIT_DIFF,
  artifact: BUILTIN_PLUGIN_IDS.PANE_ARTIFACT,
  launcher: BUILTIN_PLUGIN_IDS.PANE_LAUNCHER,
};

function createCoreEmptyTab(): PaneTabRecord {
  return {
    id: uid('tab'),
    paneType: CORE_EMPTY_PANE_TYPE,
    ownerPluginId: 'core',
    title: '빈 창',
    state: {},
  };
}

function createFallbackTab(): PaneTabRecord {
  const launcherDef = useSlotRegistry.getState().paneTypes['launcher'];
  if (launcherDef) {
    const created = launcherDef.createDefaultState();
    return {
      id: uid('tab'),
      paneType: launcherDef.type,
      ownerPluginId: launcherDef.ownerPluginId || BUILTIN_PLUGIN_IDS.PANE_LAUNCHER,
      title: created.title,
      state: created.state,
    };
  }
  return createCoreEmptyTab();
}

function createInitialWorkspace(): PersistedLayoutWorkspace {
  const g1 = 'grp-main';
  const tab = createFallbackTab();
  return {
    schemaVersion: 4,
    layout: { type: 'leaf', groupId: g1 },
    groups: {
      [g1]: { id: g1, activeTabId: tab.id, tabs: [tab] },
    },
    focusedGroupId: g1,
    sidebarOpen: true,
  };
}

function createTabFromRegistry(paneType: string, init?: Record<string, unknown>): PaneTabRecord | null {
  if (paneType === CORE_EMPTY_PANE_TYPE) return createCoreEmptyTab();
  const def = useSlotRegistry.getState().paneTypes[paneType];
  if (!def) return null;
  const { title, state } = def.createDefaultState(init);
  return {
    id: uid('tab'),
    paneType: def.type,
    ownerPluginId: def.ownerPluginId || `pane-${def.type}`,
    title,
    state,
  };
}

/**
 * Lossless migration from legacy `agy-desk:workspace:v3` / `v2` into `PersistedLayoutWorkspace` (v4).
 * Maps legacy `kind` -> `paneType` + canonical 14 `ownerPluginId`, moves domain fields into opaque `state`,
 * and migrates `agyConversationId` -> `adapterId: 'agent-agy'` + `externalSessionId` without losing any field.
 * Never deletes v3 from localStorage so baseline rollback remains lossless (critic #12-5, #13-1).
 */
function migrateLegacyV3Workspace(raw: unknown): PersistedLayoutWorkspace | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as {
    layout?: LayoutNode;
    groups?: Record<string, { id: string; activeTabId: string; tabs?: Array<Record<string, unknown>> }>;
    focusedGroupId?: string;
    sidebarOpen?: boolean;
  };
  if (!obj.layout || !obj.groups || Object.keys(obj.groups).length === 0) return null;

  const groups: Record<string, PaneGroupRecord> = {};
  for (const [gid, grp] of Object.entries(obj.groups)) {
    const rawTabs = Array.isArray(grp.tabs) ? grp.tabs : [];
    const tabs: PaneTabRecord[] = rawTabs.map((t) => {
      const kind = typeof t.kind === 'string' ? t.kind : typeof t.paneType === 'string' ? t.paneType : CORE_EMPTY_PANE_TYPE;
      const paneType = kind === 'diff' ? 'diff' : kind;
      const ownerPluginId =
        typeof t.ownerPluginId === 'string' ? t.ownerPluginId : LEGACY_KIND_TO_PLUGIN[kind] || `pane-${kind}`;

      const state: Record<string, unknown> =
        t.state && typeof t.state === 'object' ? { ...(t.state as Record<string, unknown>) } : {};

      // Preserve every legacy flat field inside opaque `state`
      for (const [k, v] of Object.entries(t)) {
        if (k === 'id' || k === 'kind' || k === 'paneType' || k === 'ownerPluginId' || k === 'title' || k === 'pinned' || k === 'color' || k === 'state') {
          continue;
        }
        state[k] = v;
      }

      // Normalize legacy chat mode & adapter metadata without discarding original fields
      if (paneType === 'chat') {
        if (state.mode === 'auto') state.mode = 'turbo';
        if (!state.adapterId) state.adapterId = BUILTIN_PLUGIN_IDS.AGENT_AGY;
        if (state.externalSessionId === undefined && state.agyConversationId !== undefined) {
          state.externalSessionId = state.agyConversationId;
        }
      }

      return {
        id: typeof t.id === 'string' ? t.id : uid('tab'),
        paneType,
        ownerPluginId,
        title: typeof t.title === 'string' ? t.title : paneType,
        pinned: typeof t.pinned === 'boolean' ? t.pinned : undefined,
        color: typeof t.color === 'string' || t.color === null ? t.color : undefined,
        state,
        stateVersion: 1,
      };
    });

    const safeTabs = tabs.length > 0 ? tabs : [createCoreEmptyTab()];
    groups[gid] = {
      id: grp.id || gid,
      activeTabId: safeTabs.some((t) => t.id === grp.activeTabId) ? grp.activeTabId : safeTabs[0].id,
      tabs: safeTabs,
    };
  }

  const groupIds = Object.keys(groups);
  return {
    schemaVersion: 4,
    layout: obj.layout,
    groups,
    focusedGroupId: obj.focusedGroupId && groups[obj.focusedGroupId] ? obj.focusedGroupId : groupIds[0],
    sidebarOpen: typeof obj.sidebarOpen === 'boolean' ? obj.sidebarOpen : true,
  };
}

function readLocalWorkspaceSync(): PersistedLayoutWorkspace | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const rawV4 = localStorage.getItem(STORAGE_KEY_V4);
    if (rawV4) {
      const parsed = JSON.parse(rawV4) as PersistedLayoutWorkspace;
      if (parsed?.schemaVersion === 4 && parsed.layout && parsed.groups && Object.keys(parsed.groups).length > 0) {
        return parsed;
      }
    }
    const rawLegacy = localStorage.getItem(STORAGE_KEY_V3) || localStorage.getItem(STORAGE_KEY_V2);
    if (rawLegacy) {
      return migrateLegacyV3Workspace(JSON.parse(rawLegacy));
    }
  } catch {
    // ignore malformed storage
  }
  return null;
}

function savePersistedLayout(state: Pick<PersistedLayoutWorkspace, 'layout' | 'groups' | 'focusedGroupId' | 'sidebarOpen'>): void {
  const payload: PersistedLayoutWorkspace = {
    schemaVersion: 4,
    layout: state.layout,
    groups: state.groups,
    focusedGroupId: state.focusedGroupId,
    sidebarOpen: state.sidebarOpen,
  };
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_KEY_V4, JSON.stringify(payload));
    }
  } catch {
    // ignore quota errors
  }
  // Mirror to Main JSON backup for cross-origin safety (`file://` <-> `desk-app://app`)
  getDeskKernelBridge()?.rpc.notify('kernel:workspace:save', payload);
}

// Pure binary split tree helpers
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

function sortPinnedTabs(tabs: PaneTabRecord[]): PaneTabRecord[] {
  const pinned = tabs.filter((t) => t.pinned);
  const normal = tabs.filter((t) => !t.pinned);
  return [...pinned, ...normal];
}

// Triple-release CSS pointer-event shield (critic #12-9: mouseup + dragend + window.blur)
let dragShieldListenersAttached = false;
function applyDragShieldDom(active: boolean): void {
  if (typeof document === 'undefined') return;
  if (active) {
    document.documentElement.dataset.deskDragging = 'true';
    if (!dragShieldListenersAttached) {
      dragShieldListenersAttached = true;
      const clear = () => {
        if (useLayoutStore.getState().draggingOverlay || useLayoutStore.getState().draggedTab) {
          useLayoutStore.getState().setDraggingOverlay(false);
          useLayoutStore.getState().setDraggedTab(null);
        }
      };
      window.addEventListener('mouseup', clear, true);
      window.addEventListener('dragend', clear, true);
      window.addEventListener('blur', clear);
    }
  } else {
    delete document.documentElement.dataset.deskDragging;
  }
}

export interface LayoutStoreState {
  bootPhase: 'booting' | 'hydrated';
  layout: LayoutNode;
  groups: Record<string, PaneGroupRecord>;
  focusedGroupId: string;
  sidebarOpen: boolean;
  draggedTab: { groupId: string; tabId: string } | null;
  draggingOverlay: boolean;
  savedLayoutSnapshot: PersistedLayoutWorkspace | null; // for Creator Mode layout restore

  hydrateWorkspace: () => Promise<void>;
  setFocusedGroup: (groupId: string) => void;
  setDraggedTab: (drag: { groupId: string; tabId: string } | null) => void;
  setDraggingOverlay: (active: boolean) => void;
  toggleSidebar: () => void;
  setSidebarOpen: (open: boolean) => void;
  saveLayoutSnapshot: () => void;
  restoreLayoutSnapshot: () => void;

  resetLayout: () => Promise<void>;
  openTab: (
    paneType: string,
    init?: Record<string, unknown>,
    opts?: { groupId?: string; split?: SplitDir; side?: 'before' | 'after' }
  ) => string | null;
  splitGroup: (
    groupId: string,
    dir: SplitDir,
    paneType?: string,
    init?: Record<string, unknown>,
    side?: 'before' | 'after'
  ) => string | null;
  addTabToGroup: (groupId: string, paneType: string, init?: Record<string, unknown>) => string | null;
  convertTab: (groupId: string, tabId: string, paneType: string, init?: Record<string, unknown>) => void;
  moveTabToGroup: (fromGroupId: string, tabId: string, toGroupId: string, insertIndex?: number) => void;
  moveTabToNewSplit: (fromGroupId: string, tabId: string, targetGroupId: string, direction: SplitDirection) => void;
  duplicateTab: (groupId: string, tabId: string) => void;
  togglePinTab: (groupId: string, tabId: string) => void;
  setTabColor: (groupId: string, tabId: string, color: string | null) => void;
  renameTab: (groupId: string, tabId: string, title: string) => void;
  setActiveTab: (groupId: string, tabId: string) => void;
  closeTab: (groupId: string, tabId: string) => Promise<void>;
  closeOtherTabs: (groupId: string, keepTabId: string) => Promise<void>;
  closeSplitPane: (groupId: string) => Promise<void>;
  setSplitRatio: (splitId: string, ratio: number) => void;
  updateTabState: (groupId: string, tabId: string, patch: Record<string, unknown>) => void;
  updateTabMeta: (
    groupId: string,
    tabId: string,
    patch: Partial<Pick<PaneTabRecord, 'title' | 'color' | 'pinned'>>
  ) => void;
  getTabCountsByPlugin: () => Record<string, { open: number; hiddenPreserved: number }>;
}

const initialSeed = createInitialWorkspace();

export const useLayoutStore = create<LayoutStoreState>((set, get) => {
  const persist = () => {
    const s = get();
    if (s.bootPhase !== 'hydrated') return; // Never overwrite storage before hydration completes
    savePersistedLayout({
      layout: s.layout,
      groups: s.groups,
      focusedGroupId: s.focusedGroupId,
      sidebarOpen: s.sidebarOpen,
    });
  };

  const runTabDispose = async (tab: PaneTabRecord) => {
    const def = useSlotRegistry.getState().paneTypes[tab.paneType];
    if (def?.onTabDispose) {
      try {
        await def.onTabDispose(tab);
      } catch (err) {
        console.error(`[LayoutStore] onTabDispose failed for "${tab.paneType}":`, err);
      }
    }
  };

  return {
    bootPhase: 'booting',
    layout: initialSeed.layout,
    groups: initialSeed.groups,
    focusedGroupId: initialSeed.focusedGroupId,
    sidebarOpen: initialSeed.sidebarOpen,
    draggedTab: null,
    draggingOverlay: false,
    savedLayoutSnapshot: null,

    hydrateWorkspace: async () => {
      // 1) Local storage (v4 or lossless migrated v3/v2)
      let loaded = readLocalWorkspaceSync();
      // 2) Cross-origin Main JSON backup if localStorage empty
      if (!loaded) {
        try {
          const backup = await getDeskKernelBridge()?.rpc.invoke<PersistedLayoutWorkspace | null>('kernel:workspace:load');
          if (backup?.schemaVersion === 4 && backup.layout && Object.keys(backup.groups || {}).length > 0) {
            loaded = backup;
          }
        } catch {
          // ignore
        }
      }

      if (!loaded) {
        // Fresh workspace: prefer registered 'chat' or 'launcher', else core:empty
        const paneTypes = useSlotRegistry.getState().paneTypes;
        const defaultType = paneTypes['chat'] ? 'chat' : paneTypes['launcher'] ? 'launcher' : CORE_EMPTY_PANE_TYPE;
        const tab = createTabFromRegistry(defaultType) || createCoreEmptyTab();
        loaded = {
          schemaVersion: 4,
          layout: { type: 'leaf', groupId: 'grp-main' },
          groups: { 'grp-main': { id: 'grp-main', activeTabId: tab.id, tabs: [tab] } },
          focusedGroupId: 'grp-main',
          sidebarOpen: true,
        };
      } else {
        // Run optional per-plugin state migrations WITHOUT ever deleting unknown/disabled tabs!
        const paneTypes = useSlotRegistry.getState().paneTypes;
        for (const grp of Object.values(loaded.groups)) {
          for (const tab of grp.tabs) {
            const def = paneTypes[tab.paneType];
            if (def?.migrateState) {
              try {
                tab.state = def.migrateState(tab.state, tab.stateVersion);
              } catch {
                // preserve raw state on migration error
              }
            }
          }
        }
      }

      set({
        bootPhase: 'hydrated',
        layout: loaded.layout,
        groups: loaded.groups,
        focusedGroupId: loaded.focusedGroupId,
        sidebarOpen: loaded.sidebarOpen,
      });
      persist();
    },

    setFocusedGroup: (groupId) => {
      if (get().focusedGroupId === groupId) return;
      set({ focusedGroupId: groupId });
      persist();
    },

    setDraggedTab: (draggedTab) => {
      set({ draggedTab });
      applyDragShieldDom(Boolean(draggedTab) || get().draggingOverlay);
    },

    setDraggingOverlay: (draggingOverlay) => {
      set({ draggingOverlay });
      applyDragShieldDom(draggingOverlay || Boolean(get().draggedTab));
    },

    toggleSidebar: () => {
      set((s) => ({ sidebarOpen: !s.sidebarOpen }));
      persist();
    },

    setSidebarOpen: (sidebarOpen) => {
      set({ sidebarOpen });
      persist();
    },

    saveLayoutSnapshot: () => {
      const s = get();
      set({
        savedLayoutSnapshot: structuredClone({
          schemaVersion: 4,
          layout: s.layout,
          groups: s.groups,
          focusedGroupId: s.focusedGroupId,
          sidebarOpen: s.sidebarOpen,
        }),
      });
    },

    restoreLayoutSnapshot: () => {
      const snap = get().savedLayoutSnapshot;
      if (!snap) return;
      set({
        layout: snap.layout,
        groups: snap.groups,
        focusedGroupId: snap.focusedGroupId,
        sidebarOpen: snap.sidebarOpen,
        savedLayoutSnapshot: null,
      });
      persist();
    },

    resetLayout: async () => {
      const s = get();
      for (const grp of Object.values(s.groups)) {
        for (const t of grp.tabs) await runTabDispose(t);
      }
      const fresh = createInitialWorkspace();
      set({
        layout: fresh.layout,
        groups: fresh.groups,
        focusedGroupId: fresh.focusedGroupId,
        sidebarOpen: s.sidebarOpen,
      });
      persist();
    },

    openTab: (paneType, init, opts) => {
      const s = get();
      const targetGroup = opts?.groupId && s.groups[opts.groupId] ? opts.groupId : s.focusedGroupId;
      if (opts?.split) {
        return get().splitGroup(targetGroup, opts.split, paneType, init, opts.side || 'after');
      }
      return get().addTabToGroup(targetGroup, paneType, init);
    },

    splitGroup: (groupId, dir, paneType, init, side = 'after') => {
      const s = get();
      const targetType = paneType || (useSlotRegistry.getState().paneTypes['launcher'] ? 'launcher' : CORE_EMPTY_PANE_TYPE);
      const sourceGroup = s.groups[groupId];
      const activeTab = sourceGroup?.tabs.find((t) => t.id === sourceGroup.activeTabId);
      const inheritedCwd = typeof activeTab?.state?.cwd === 'string' ? activeTab.state.cwd : undefined;
      const mergedInit = inheritedCwd && !init?.cwd ? { ...init, cwd: inheritedCwd } : init;

      const newTab = createTabFromRegistry(targetType, mergedInit) || createFallbackTab();
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
      return newTab.id;
    },

    addTabToGroup: (groupId, paneType, init) => {
      const s = get();
      const grp = s.groups[groupId];
      if (!grp) return null;
      const activeTab = grp.tabs.find((t) => t.id === grp.activeTabId);
      const inheritedCwd = typeof activeTab?.state?.cwd === 'string' ? activeTab.state.cwd : undefined;
      const mergedInit = inheritedCwd && !init?.cwd ? { ...init, cwd: inheritedCwd } : init;

      const newTab = createTabFromRegistry(paneType, mergedInit);
      if (!newTab) return null;

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
      return newTab.id;
    },

    convertTab: (groupId, tabId, paneType, init) => {
      const s = get();
      const grp = s.groups[groupId];
      if (!grp) return;
      const target = grp.tabs.find((t) => t.id === tabId);
      if (!target) return;
      const inheritedCwd = typeof target.state?.cwd === 'string' ? target.state.cwd : undefined;
      const mergedInit = inheritedCwd && !init?.cwd ? { ...init, cwd: inheritedCwd } : init;
      const created = createTabFromRegistry(paneType, mergedInit);
      if (!created) return;

      const replaced: PaneTabRecord = {
        ...created,
        pinned: target.pinned,
        color: target.color,
      };
      set({
        groups: {
          ...s.groups,
          [groupId]: {
            ...grp,
            activeTabId: replaced.id,
            tabs: grp.tabs.map((t) => (t.id === tabId ? replaced : t)),
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

      const nextGroups: Record<string, PaneGroupRecord> = {
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
          const fresh = createFallbackTab();
          nextGroups[fromGroupId] = { id: fromGroupId, activeTabId: fresh.id, tabs: [fresh] };
        }
      } else {
        const nextFromActive =
          fromGrp.activeTabId === tabId ? fromRemaining[fromRemaining.length - 1].id : fromGrp.activeTabId;
        nextGroups[fromGroupId] = { ...fromGrp, tabs: fromRemaining, activeTabId: nextFromActive };
      }

      set({ layout: nextLayout, groups: nextGroups, focusedGroupId: toGroupId });
      persist();
    },

    moveTabToNewSplit: (fromGroupId, tabId, targetGroupId, direction) => {
      const s = get();
      const fromGrp = s.groups[fromGroupId];
      const targetGrp = s.groups[targetGroupId];
      if (!fromGrp || !targetGrp) return;
      const moving = fromGrp.tabs.find((t) => t.id === tabId);
      if (!moving) return;
      if (fromGroupId === targetGroupId && fromGrp.tabs.length <= 1) return;

      const dir: SplitDir = direction === 'left' || direction === 'right' ? 'h' : 'v';
      const side: 'before' | 'after' = direction === 'left' || direction === 'up' ? 'before' : 'after';

      const newGroupId = uid('grp');
      let nextLayout = splitLeafInTree(s.layout, targetGroupId, dir, newGroupId, side);
      const nextGroups: Record<string, PaneGroupRecord> = {
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

      set({ layout: nextLayout, groups: nextGroups, focusedGroupId: newGroupId });
      persist();
    },

    duplicateTab: (groupId, tabId) => {
      const s = get();
      const grp = s.groups[groupId];
      if (!grp) return;
      const src = grp.tabs.find((t) => t.id === tabId);
      if (!src) return;

      const def = useSlotRegistry.getState().paneTypes[src.paneType];
      let dup: PaneTabRecord;
      if (def?.duplicateState) {
        const res = def.duplicateState(src);
        dup = {
          id: uid('tab'),
          paneType: src.paneType,
          ownerPluginId: src.ownerPluginId,
          title: res.title,
          color: src.color,
          state: res.state,
          stateVersion: src.stateVersion,
        };
      } else if (def) {
        const res = def.createDefaultState(src.state);
        dup = {
          id: uid('tab'),
          paneType: src.paneType,
          ownerPluginId: src.ownerPluginId,
          title: res.title,
          color: src.color,
          state: res.state,
          stateVersion: src.stateVersion,
        };
      } else {
        dup = {
          ...src,
          id: uid('tab'),
          pinned: false,
          state: structuredClone(src.state),
        };
      }

      const idx = grp.tabs.findIndex((t) => t.id === tabId);
      const nextTabs = [...grp.tabs];
      nextTabs.splice(idx + 1, 0, dup);
      set({
        groups: { ...s.groups, [groupId]: { ...grp, tabs: nextTabs, activeTabId: dup.id } },
        focusedGroupId: groupId,
      });
      persist();
    },

    togglePinTab: (groupId, tabId) => {
      const s = get();
      const grp = s.groups[groupId];
      if (!grp) return;
      const toggled = grp.tabs.map((t) => (t.id === tabId ? { ...t, pinned: !t.pinned } : t));
      set({
        groups: { ...s.groups, [groupId]: { ...grp, tabs: sortPinnedTabs(toggled) } },
      });
      persist();
    },

    setTabColor: (groupId, tabId, color) => {
      get().updateTabMeta(groupId, tabId, { color });
    },

    renameTab: (groupId, tabId, title) => {
      const trimmed = title.trim();
      if (!trimmed) return;
      get().updateTabMeta(groupId, tabId, { title: trimmed });
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

    closeTab: async (groupId, tabId) => {
      const s = get();
      const grp = s.groups[groupId];
      if (!grp) return;
      const closing = grp.tabs.find((t) => t.id === tabId);
      if (!closing) return;

      const def = useSlotRegistry.getState().paneTypes[closing.paneType];
      if (def?.beforeClose) {
        const allow = await def.beforeClose(closing);
        if (!allow) return;
      }

      await runTabDispose(closing);

      const latest = get();
      const latestGrp = latest.groups[groupId];
      if (!latestGrp) return;

      const remaining = latestGrp.tabs.filter((t) => t.id !== tabId);
      if (remaining.length > 0) {
        const nextActive = latestGrp.activeTabId === tabId ? remaining[remaining.length - 1].id : latestGrp.activeTabId;
        set({
          groups: {
            ...latest.groups,
            [groupId]: { ...latestGrp, tabs: remaining, activeTabId: nextActive },
          },
        });
        persist();
        return;
      }

      const nextLayout = removeLeafFromTree(latest.layout, groupId);
      if (!nextLayout) {
        // Zero-Feature Core invariant (critic #12-9): never hardcode 'chat'
        const fresh = createFallbackTab();
        set({
          groups: {
            ...latest.groups,
            [groupId]: { id: groupId, activeTabId: fresh.id, tabs: [fresh] },
          },
        });
        persist();
        return;
      }

      const nextGroups = { ...latest.groups };
      delete nextGroups[groupId];
      const nextFocus = latest.focusedGroupId === groupId ? firstGroupId(nextLayout) : latest.focusedGroupId;
      set({ layout: nextLayout, groups: nextGroups, focusedGroupId: nextFocus });
      persist();
    },

    closeOtherTabs: async (groupId, keepTabId) => {
      const s = get();
      const grp = s.groups[groupId];
      if (!grp) return;

      const keep: PaneTabRecord[] = [];
      for (const tab of grp.tabs) {
        if (tab.id === keepTabId || tab.pinned) {
          keep.push(tab);
        } else {
          const def = useSlotRegistry.getState().paneTypes[tab.paneType];
          if (def?.beforeClose) {
            const ok = await def.beforeClose(tab);
            if (!ok) {
              keep.push(tab);
              continue;
            }
          }
          await runTabDispose(tab);
        }
      }

      set({
        groups: { ...get().groups, [groupId]: { ...grp, tabs: keep, activeTabId: keepTabId } },
        focusedGroupId: groupId,
      });
      persist();
    },

    closeSplitPane: async (groupId) => {
      const s = get();
      const grp = s.groups[groupId];
      if (!grp) return;

      for (const tab of grp.tabs) {
        const def = useSlotRegistry.getState().paneTypes[tab.paneType];
        if (def?.beforeClose) {
          const ok = await def.beforeClose(tab);
          if (!ok) return;
        }
      }
      for (const tab of grp.tabs) {
        await runTabDispose(tab);
      }

      const latest = get();
      const nextLayout = removeLeafFromTree(latest.layout, groupId);
      if (!nextLayout) {
        const fresh = createFallbackTab();
        set({
          groups: { [groupId]: { id: groupId, activeTabId: fresh.id, tabs: [fresh] } },
          focusedGroupId: groupId,
        });
        persist();
        return;
      }
      const nextGroups = { ...latest.groups };
      delete nextGroups[groupId];
      const nextFocus = latest.focusedGroupId === groupId ? firstGroupId(nextLayout) : latest.focusedGroupId;
      set({ layout: nextLayout, groups: nextGroups, focusedGroupId: nextFocus });
      persist();
    },

    setSplitRatio: (splitId, ratio) => {
      set((s) => ({ layout: updateRatioInTree(s.layout, splitId, ratio) }));
      persist();
    },

    updateTabState: (groupId, tabId, patch) => {
      const s = get();
      const grp = s.groups[groupId];
      if (!grp) return;
      const nextTabs = grp.tabs.map((t) => (t.id === tabId ? { ...t, state: { ...t.state, ...patch } } : t));
      set({ groups: { ...s.groups, [groupId]: { ...grp, tabs: nextTabs } } });
      persist();
    },

    updateTabMeta: (groupId, tabId, patch) => {
      const s = get();
      const grp = s.groups[groupId];
      if (!grp) return;
      const nextTabs = grp.tabs.map((t) => (t.id === tabId ? { ...t, ...patch } : t));
      set({ groups: { ...s.groups, [groupId]: { ...grp, tabs: nextTabs } } });
      persist();
    },

    getTabCountsByPlugin: () => {
      const s = get();
      const paneTypes = useSlotRegistry.getState().paneTypes;
      const counts: Record<string, { open: number; hiddenPreserved: number }> = {};
      for (const grp of Object.values(s.groups)) {
        for (const tab of grp.tabs) {
          const entry = counts[tab.ownerPluginId] || { open: 0, hiddenPreserved: 0 };
          entry.open += 1;
          const def = paneTypes[tab.paneType];
          if (def?.keepAlive === 'group' && tab.id !== grp.activeTabId) {
            entry.hiddenPreserved += 1;
          }
          counts[tab.ownerPluginId] = entry;
        }
      }
      return counts;
    },
  };
});
