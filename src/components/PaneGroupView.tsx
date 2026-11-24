import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Columns2,
  Copy,
  Edit3,
  LayoutGrid,
  MoreHorizontal,
  Pin,
  PinOff,
  Plus,
  Rows2,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import {
  CORE_EMPTY_PANE_TYPE,
  CoreEmptyPane,
  DormantPanePlaceholder,
  PluginErrorBoundary,
  PluginMountBoundary,
  SlotOutlet,
  useLayoutStore,
  useSlotRegistry,
  type ContextMenuContribution,
  type PaneGroupRecord,
  type PaneTabRecord,
  type PaneTypeDefinition,
  type SplitDirection,
} from '../kernel/client';
import { useContextMenuStore, type ContextMenuItem } from '../store/contextMenuStore';

interface PaneGroupViewProps {
  group: PaneGroupRecord;
  focused: boolean;
}

type DropZone = SplitDirection | 'center' | null;

export const PaneGroupView: React.FC<PaneGroupViewProps> = ({ group, focused }) => {
  const groups = useLayoutStore((s) => s.groups);
  const setFocusedGroup = useLayoutStore((s) => s.setFocusedGroup);
  const setActiveTab = useLayoutStore((s) => s.setActiveTab);
  const closeTab = useLayoutStore((s) => s.closeTab);
  const closeOtherTabs = useLayoutStore((s) => s.closeOtherTabs);
  const closeSplitPane = useLayoutStore((s) => s.closeSplitPane);
  const addTabToGroup = useLayoutStore((s) => s.addTabToGroup);
  const convertTab = useLayoutStore((s) => s.convertTab);
  const splitGroup = useLayoutStore((s) => s.splitGroup);
  const moveTabToGroup = useLayoutStore((s) => s.moveTabToGroup);
  const moveTabToNewSplit = useLayoutStore((s) => s.moveTabToNewSplit);
  const duplicateTab = useLayoutStore((s) => s.duplicateTab);
  const togglePinTab = useLayoutStore((s) => s.togglePinTab);
  const setTabColor = useLayoutStore((s) => s.setTabColor);
  const renameTab = useLayoutStore((s) => s.renameTab);
  const updateTabState = useLayoutStore((s) => s.updateTabState);
  const updateTabMeta = useLayoutStore((s) => s.updateTabMeta);
  const draggedTab = useLayoutStore((s) => s.draggedTab);
  const setDraggedTab = useLayoutStore((s) => s.setDraggedTab);

  const paneTypesMap = useSlotRegistry((s) => s.paneTypes);
  const paneSlotEntries = useSlotRegistry((s) => s.bySlot['pane.type']);
  const menuSlotEntries = useSlotRegistry((s) => s.bySlot['context-menu.item']);
  const getEntries = useSlotRegistry((s) => s.getEntries);
  const showMenu = useContextMenuStore((s) => s.showMenu);

  const [newTabOpen, setNewTabOpen] = useState(false);
  const [newTabQuery, setNewTabQuery] = useState('');
  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');
  const [dropZone, setDropZone] = useState<DropZone>(null);
  const [tabDropTargetId, setTabDropTargetId] = useState<string | null>(null);

  const plusBtnRef = useRef<HTMLButtonElement | null>(null);
  const plusSearchRef = useRef<HTMLInputElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  const activeTab = group.tabs.find((t) => t.id === group.activeTabId) || group.tabs[0];
  const totalGroups = Object.keys(groups).length;

  const registeredPanes = useMemo<PaneTypeDefinition[]>(() => {
    void paneSlotEntries;
    return getEntries('pane.type')
      .map((e) => e.contribution as unknown as PaneTypeDefinition)
      .filter((p) => p.type !== 'launcher' && p.showInOmnibox !== false);
  }, [getEntries, paneSlotEntries]);

  useEffect(() => {
    if (!newTabOpen) return;
    requestAnimationFrame(() => plusSearchRef.current?.focus());
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (plusBtnRef.current?.parentElement?.contains(target)) return;
      setNewTabOpen(false);
      setNewTabQuery('');
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setNewTabOpen(false);
        setNewTabQuery('');
      }
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [newTabOpen]);

  useEffect(() => {
    if (!draggedTab) {
      setDropZone(null);
      setTabDropTargetId(null);
    }
  }, [draggedTab]);

  const resolveExtraContextMenuItems = (
    target: 'tab' | 'pane-body',
    tab?: PaneTabRecord
  ): ContextMenuItem[] => {
    void menuSlotEntries;
    const entries = getEntries('context-menu.item');
    const extras: ContextMenuItem[] = [];
    for (const e of entries) {
      const c = e.contribution as ContextMenuContribution;
      if (c.target !== target) continue;
      try {
        const resolved = c.resolve({ groupId: group.id, tab });
        if (resolved.length > 0) extras.push(...(resolved as ContextMenuItem[]));
      } catch {
        // isolate plugin context menu errors
      }
    }
    return extras;
  };

  const buildSplitSubmenu = (dir: 'h' | 'v', side: 'before' | 'after' = 'after'): ContextMenuItem[] => {
    const items: ContextMenuItem[] = [];
    if (paneTypesMap['launcher']) {
      items.push(
        {
          type: 'item',
          label: '새 창 선택 (런처)',
          icon: <LayoutGrid size={13} />,
          onSelect: () => splitGroup(group.id, dir, 'launcher', undefined, side),
        },
        { type: 'separator' }
      );
    }
    for (const pane of registeredPanes) {
      const Icon = pane.icon;
      items.push({
        type: 'item',
        label: pane.label,
        icon: <Icon size={13} />,
        onSelect: () => splitGroup(group.id, dir, pane.type, undefined, side),
      });
    }
    return items;
  };

  const openTabContextMenu = (e: React.MouseEvent, tab: PaneTabRecord) => {
    e.preventDefault();
    e.stopPropagation();
    const canMoveToSplit = group.tabs.length > 1;
    const unpinnedOthers = group.tabs.filter((t) => t.id !== tab.id && !t.pinned).length;
    const extraPluginItems = resolveExtraContextMenuItems('tab', tab);

    const items: ContextMenuItem[] = [
      { type: 'submenu', label: '오른쪽으로 분할', icon: <Columns2 size={13} />, items: buildSplitSubmenu('h', 'after') },
      { type: 'submenu', label: '아래로 분할', icon: <Rows2 size={13} />, items: buildSplitSubmenu('v', 'after') },
      ...(canMoveToSplit
        ? [
            {
              type: 'submenu' as const,
              label: '이 탭을 분할 창으로 이동',
              icon: <ArrowRight size={13} />,
              items: [
                { type: 'item' as const, label: '오른쪽', icon: <ArrowRight size={13} />, onSelect: () => moveTabToNewSplit(group.id, tab.id, group.id, 'right') },
                { type: 'item' as const, label: '아래', icon: <ArrowDown size={13} />, onSelect: () => moveTabToNewSplit(group.id, tab.id, group.id, 'down') },
                { type: 'item' as const, label: '왼쪽', icon: <ArrowLeft size={13} />, onSelect: () => moveTabToNewSplit(group.id, tab.id, group.id, 'left') },
                { type: 'item' as const, label: '위', icon: <ArrowUp size={13} />, onSelect: () => moveTabToNewSplit(group.id, tab.id, group.id, 'up') },
              ],
            },
          ]
        : []),
      { type: 'separator' },
      {
        type: 'item',
        label: tab.pinned ? '탭 고정 해제' : '탭 고정',
        icon: tab.pinned ? <PinOff size={13} /> : <Pin size={13} />,
        onSelect: () => togglePinTab(group.id, tab.id),
      },
      { type: 'item', label: '탭 복제', icon: <Copy size={13} />, onSelect: () => duplicateTab(group.id, tab.id) },
      {
        type: 'item',
        label: '이름 바꾸기',
        icon: <Edit3 size={13} />,
        onSelect: () => {
          setEditingTabId(tab.id);
          setEditingTitle(tab.title);
        },
      },
      {
        type: 'color-picker',
        label: '탭 색상',
        value: tab.color ?? null,
        onSelect: (color) => setTabColor(group.id, tab.id, color),
      },
      ...(extraPluginItems.length > 0 ? [{ type: 'separator' as const }, ...extraPluginItems] : []),
      { type: 'separator' },
      {
        type: 'item',
        label: '닫기',
        icon: <X size={13} />,
        shortcut: '⌘W',
        disabled: Boolean(tab.pinned),
        onSelect: () => void closeTab(group.id, tab.id),
      },
      {
        type: 'item',
        label: '다른 탭 닫기',
        disabled: unpinnedOthers === 0,
        onSelect: () => void closeOtherTabs(group.id, tab.id),
      },
      ...(totalGroups > 1
        ? [
            { type: 'separator' as const },
            {
              type: 'item' as const,
              label: '분할 창 닫기',
              icon: <Trash2 size={13} />,
              danger: true,
              onSelect: () => void closeSplitPane(group.id),
            },
          ]
        : []),
    ];

    showMenu(e.clientX, e.clientY, items);
  };

  const openPaneActionsMenu = (x: number, y: number) => {
    const items: ContextMenuItem[] = [
      { type: 'label', label: '이 창에 탭 추가' },
      ...registeredPanes.map((pane) => {
        const Icon = pane.icon;
        return {
          type: 'item' as const,
          label: pane.label,
          icon: <Icon size={13} />,
          shortcut: pane.shortcut,
          onSelect: () => addTabToGroup(group.id, pane.type),
        };
      }),
      { type: 'separator' },
      { type: 'submenu', label: '오른쪽으로 분할', icon: <Columns2 size={13} />, items: buildSplitSubmenu('h', 'after') },
      { type: 'submenu', label: '아래로 분할', icon: <Rows2 size={13} />, items: buildSplitSubmenu('v', 'after') },
      { type: 'submenu', label: '왼쪽으로 분할', icon: <ArrowLeft size={13} />, items: buildSplitSubmenu('h', 'before') },
      { type: 'submenu', label: '위로 분할', icon: <ArrowUp size={13} />, items: buildSplitSubmenu('v', 'before') },
      ...(totalGroups > 1
        ? [
            { type: 'separator' as const },
            {
              type: 'item' as const,
              label: '이 분할 창 닫기',
              icon: <Trash2 size={13} />,
              danger: true,
              onSelect: () => void closeSplitPane(group.id),
            },
          ]
        : []),
    ];
    showMenu(x, y, items);
  };

  const q = newTabQuery.trim();
  const qLower = q.toLowerCase();

  const omniboxMatches = useMemo(() => {
    if (!q) return [];
    const list: Array<{ pane: PaneTypeDefinition; score: number; label: string; init: Record<string, unknown> }> = [];
    for (const pane of registeredPanes) {
      const m = pane.matchOmnibox?.(q);
      if (m) list.push({ pane, ...m });
    }
    return list.sort((a, b) => b.score - a.score);
  }, [q, registeredPanes]);

  const filteredQuickPanes = useMemo(() => {
    if (!qLower) return registeredPanes;
    return registeredPanes.filter(
      (p) =>
        p.label.toLowerCase().includes(qLower) ||
        p.type.toLowerCase().includes(qLower) ||
        (p.description || '').toLowerCase().includes(qLower)
    );
  }, [qLower, registeredPanes]);

  const handleQuickCreate = (paneType: string, init?: Record<string, unknown>) => {
    setNewTabOpen(false);
    setNewTabQuery('');
    addTabToGroup(group.id, paneType, init);
  };

  const handleNewTabOmniboxSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!q) {
      if (registeredPanes[0]) handleQuickCreate(registeredPanes[0].type);
      return;
    }
    if (omniboxMatches.length > 0) {
      const best = omniboxMatches[0];
      handleQuickCreate(best.pane.type, best.init);
      return;
    }
    if (filteredQuickPanes.length > 0) {
      handleQuickCreate(filteredQuickPanes[0].type);
      return;
    }
    if (paneTypesMap['webview']) {
      handleQuickCreate('webview', { url: q });
    }
  };

  const handleBodyDragOver = (e: React.DragEvent) => {
    if (!draggedTab) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const rect = bodyRef.current?.getBoundingClientRect();
    if (!rect) return;
    const rx = (e.clientX - rect.left) / Math.max(1, rect.width);
    const ry = (e.clientY - rect.top) / Math.max(1, rect.height);
    const edge = 0.26;

    const isOnlyTabInSelf = draggedTab.groupId === group.id && group.tabs.length <= 1;
    if (isOnlyTabInSelf) {
      setDropZone(null);
      return;
    }

    if (rx < edge) setDropZone('left');
    else if (rx > 1 - edge) setDropZone('right');
    else if (ry < edge) setDropZone('up');
    else if (ry > 1 - edge) setDropZone('down');
    else setDropZone('center');
  };

  const handleBodyDrop = (e: React.DragEvent) => {
    if (!draggedTab || !dropZone) return;
    e.preventDefault();
    const { groupId: fromG, tabId } = draggedTab;
    const zone = dropZone;
    setDropZone(null);
    setDraggedTab(null);

    if (zone === 'center') {
      moveTabToGroup(fromG, tabId, group.id);
    } else {
      moveTabToNewSplit(fromG, tabId, group.id, zone);
    }
  };

  return (
    <div
      onMouseDown={() => setFocusedGroup(group.id)}
      className="flex-1 min-w-0 min-h-0 flex flex-col relative overflow-hidden"
      style={{
        background: 'var(--bg)',
        boxShadow:
          totalGroups > 1 && focused
            ? 'inset 0 2px 0 0 color-mix(in srgb, var(--accent) 75%, transparent)'
            : undefined,
      }}
    >
      {/* 통합 패인 탭 바 */}
      <div
        onContextMenu={(e) => {
          if (e.target === e.currentTarget) {
            e.preventDefault();
            openPaneActionsMenu(e.clientX, e.clientY);
          }
        }}
        onDragOver={(e) => {
          if (!draggedTab) return;
          e.preventDefault();
        }}
        onDrop={(e) => {
          if (!draggedTab) return;
          e.preventDefault();
          moveTabToGroup(draggedTab.groupId, draggedTab.tabId, group.id);
          setDraggedTab(null);
          setTabDropTargetId(null);
        }}
        className="h-9 shrink-0 px-1.5 border-b flex items-center justify-between gap-1 select-none"
        style={{ background: 'var(--sidebar)', borderColor: 'var(--border)' }}
        data-desk-slot="pane.header.action"
      >
        {/* 좌측: 탭 목록 + '+' 동적 옴니박스 피커 */}
        <div className="flex items-center gap-0.5 min-w-0 flex-1">
          <div className="flex items-center gap-0.5 min-w-0 overflow-x-auto scroll-thin">
            {group.tabs.map((tab, idx) => {
              const isActive = tab.id === activeTab?.id;
              const isEditing = editingTabId === tab.id;
              const isDropTarget = tabDropTargetId === tab.id;
              const paneDef = paneTypesMap[tab.paneType];
              const Icon = paneDef?.icon || LayoutGrid;
              const TabBadge = paneDef?.TabBadge;

              return (
                <div
                  key={tab.id}
                  draggable={!isEditing}
                  onDragStart={(e) => {
                    e.dataTransfer.effectAllowed = 'move';
                    e.dataTransfer.setData('text/plain', tab.id);
                    setDraggedTab({ groupId: group.id, tabId: tab.id });
                  }}
                  onDragEnd={() => {
                    setDraggedTab(null);
                    setTabDropTargetId(null);
                    setDropZone(null);
                  }}
                  onDragOver={(e) => {
                    if (!draggedTab || draggedTab.tabId === tab.id) return;
                    e.preventDefault();
                    e.stopPropagation();
                    setTabDropTargetId(tab.id);
                  }}
                  onDragLeave={() => {
                    if (tabDropTargetId === tab.id) setTabDropTargetId(null);
                  }}
                  onDrop={(e) => {
                    if (!draggedTab) return;
                    e.preventDefault();
                    e.stopPropagation();
                    moveTabToGroup(draggedTab.groupId, draggedTab.tabId, group.id, idx);
                    setDraggedTab(null);
                    setTabDropTargetId(null);
                  }}
                  onClick={() => setActiveTab(group.id, tab.id)}
                  onDoubleClick={() => {
                    setEditingTabId(tab.id);
                    setEditingTitle(tab.title);
                  }}
                  onContextMenu={(e) => openTabContextMenu(e, tab)}
                  className="group relative flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[12px] cursor-pointer max-w-[196px] shrink-0 transition-colors"
                  style={{
                    background: isActive ? 'var(--card)' : 'transparent',
                    color: isActive ? 'var(--fg)' : 'var(--muted)',
                    boxShadow: isActive ? 'var(--shadow-sm)' : undefined,
                    borderLeft: isDropTarget ? '2px solid var(--accent)' : undefined,
                    opacity: !paneDef && tab.paneType !== CORE_EMPTY_PANE_TYPE ? 0.65 : 1,
                  }}
                  title={`${tab.title} (더블클릭 이름 변경 · 드래그로 분할 · 우클릭 메뉴)`}
                >
                  {tab.color && (
                    <span className="w-2 h-2 rounded-full shrink-0" style={{ background: tab.color }} />
                  )}
                  {tab.pinned && <Pin size={10} className="shrink-0 opacity-70" />}
                  <span className="shrink-0">
                    <Icon size={12} />
                  </span>

                  {isEditing ? (
                    <input
                      autoFocus
                      value={editingTitle}
                      onChange={(e) => setEditingTitle(e.target.value)}
                      onClick={(e) => e.stopPropagation()}
                      onBlur={() => {
                        renameTab(group.id, tab.id, editingTitle);
                        setEditingTabId(null);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          renameTab(group.id, tab.id, editingTitle);
                          setEditingTabId(null);
                        } else if (e.key === 'Escape') {
                          setEditingTabId(null);
                        }
                      }}
                      className="w-28 bg-transparent outline-none border-b text-[12px] font-medium"
                      style={{ borderColor: 'var(--accent)', color: 'var(--fg)' }}
                    />
                  ) : (
                    <span className="truncate font-medium">{tab.title}</span>
                  )}

                  {TabBadge && (
                    <PluginErrorBoundary pluginId={tab.ownerPluginId} slotId="pane.type" compact>
                      <TabBadge tab={tab} active={isActive} />
                    </PluginErrorBoundary>
                  )}

                  {!tab.pinned && !isEditing && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        void closeTab(group.id, tab.id);
                      }}
                      className="p-0.5 rounded opacity-0 group-hover:opacity-60 hover:!opacity-100 hover:bg-[var(--surface)] cursor-pointer transition-opacity"
                      title="탭 닫기 (⌘W)"
                    >
                      <X size={11} />
                    </button>
                  )}
                </div>
              );
            })}
          </div>

          {/* '+' 동적 새 탭 옴니박스 피커 */}
          <div className="relative shrink-0 ml-0.5">
            <button
              ref={plusBtnRef}
              type="button"
              onClick={() => setNewTabOpen((v) => !v)}
              className="p-1.5 rounded-lg hover:bg-[var(--surface-active)] cursor-pointer transition-colors"
              style={{
                color: newTabOpen ? 'var(--fg)' : 'var(--muted)',
                background: newTabOpen ? 'var(--surface-active)' : undefined,
              }}
              title="새 탭 추가"
              aria-label="새 탭"
            >
              <Plus size={14} />
            </button>

            {newTabOpen && (
              <div
                className="absolute top-full left-0 mt-1.5 w-[276px] rounded-xl border p-1.5 z-[90] space-y-1"
                style={{
                  background: 'var(--card)',
                  borderColor: 'var(--border-strong)',
                  boxShadow: 'var(--shadow-popover)',
                }}
              >
                <form onSubmit={handleNewTabOmniboxSubmit}>
                  <div
                    className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs"
                    style={{ background: 'var(--bg)', borderColor: 'var(--border)' }}
                  >
                    <Search size={12} style={{ color: 'var(--muted)' }} className="shrink-0" />
                    <input
                      ref={plusSearchRef}
                      type="text"
                      value={newTabQuery}
                      onChange={(e) => setNewTabQuery(e.target.value)}
                      placeholder="URL 또는 패인 플러그인 검색..."
                      className="w-full bg-transparent outline-none text-[12px]"
                      style={{ color: 'var(--fg)' }}
                    />
                  </div>
                </form>

                {omniboxMatches.length > 0 && (
                  <div className="space-y-0.5 pt-0.5">
                    {omniboxMatches.slice(0, 3).map((m) => {
                      const Icon = m.pane.icon;
                      return (
                        <button
                          key={`match:${m.pane.type}:${m.label}`}
                          type="button"
                          onClick={() => handleQuickCreate(m.pane.type, m.init)}
                          className="w-full flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg text-[12px] text-left cursor-pointer hover:bg-[var(--surface)]"
                        >
                          <span className="flex items-center gap-2 min-w-0">
                            <span style={{ color: 'var(--accent)' }} className="shrink-0">
                              <Icon size={13} />
                            </span>
                            <span className="truncate">{m.label}</span>
                          </span>
                          <span className="text-[10.5px] font-mono shrink-0" style={{ color: 'var(--muted)' }}>
                            ↵
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}

                <div className="space-y-0.5 pt-0.5">
                  {filteredQuickPanes.map((pane) => {
                    const Icon = pane.icon;
                    return (
                      <button
                        key={pane.type}
                        type="button"
                        onClick={() => handleQuickCreate(pane.type)}
                        className="w-full flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg text-[12.5px] text-left cursor-pointer hover:bg-[var(--surface)]"
                        style={{ color: 'var(--fg)' }}
                      >
                        <span className="flex items-center gap-2 min-w-0">
                          <span style={{ color: 'var(--muted)' }} className="shrink-0">
                            <Icon size={13} />
                          </span>
                          <span className="truncate">{pane.label}</span>
                        </span>
                        {pane.shortcut && (
                          <span className="text-[11px] font-mono shrink-0" style={{ color: 'var(--muted)' }}>
                            {pane.shortcut}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* 우측: 플러그인 탭바 액션 슬롯 + 분할 버튼 + '⋯' 창 작업 메뉴 */}
        <div className="flex items-center gap-0.5 shrink-0 pl-1">
          <SlotOutlet slotId="pane.header.action" groupId={group.id} tab={activeTab} compactError />
          <button
            type="button"
            onClick={() => splitGroup(group.id, 'h')}
            className="p-1.5 rounded-md hover:bg-[var(--surface-active)] cursor-pointer transition-colors"
            style={{ color: 'var(--muted)' }}
            title="오른쪽으로 분할 (⌘D)"
          >
            <Columns2 size={13.5} />
          </button>
          <button
            type="button"
            onClick={() => splitGroup(group.id, 'v')}
            className="p-1.5 rounded-md hover:bg-[var(--surface-active)] cursor-pointer transition-colors"
            style={{ color: 'var(--muted)' }}
            title="아래로 분할 (⌘⇧D)"
          >
            <Rows2 size={13.5} />
          </button>
          <button
            type="button"
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              openPaneActionsMenu(r.right - 210, r.bottom + 4);
            }}
            className="p-1.5 rounded-md hover:bg-[var(--surface-active)] cursor-pointer transition-colors"
            style={{ color: 'var(--muted)' }}
            title="창 작업"
            aria-label="창 작업"
          >
            <MoreHorizontal size={14} />
          </button>
        </div>
      </div>

      {/* 패인 본문: 일반화된 keepAlive + DormantPanePlaceholder + PluginErrorBoundary + X-Ray 계측 */}
      <div
        ref={bodyRef}
        onDragOver={handleBodyDragOver}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
            setDropZone(null);
          }
        }}
        onDrop={handleBodyDrop}
        className="flex-1 min-h-0 flex flex-col relative"
      >
        {group.tabs.map((tab) => {
          const isActive = tab.id === activeTab?.id;
          const paneDef = paneTypesMap[tab.paneType];
          const isKeepAlive = paneDef?.keepAlive === 'group';

          if (!isActive && !isKeepAlive) return null;

          if (tab.paneType === CORE_EMPTY_PANE_TYPE) {
            return (
              <CoreEmptyPane
                key={tab.id}
                onSelectPaneType={(pt) => convertTab(group.id, tab.id, pt)}
              />
            );
          }

          if (!paneDef) {
            return (
              <DormantPanePlaceholder
                key={tab.id}
                groupId={group.id}
                tab={tab}
                onCloseTab={() => void closeTab(group.id, tab.id)}
              />
            );
          }

          const PaneComp = paneDef.Component;
          return (
            <PluginMountBoundary
              key={tab.id}
              mountId={`pane.type:${group.id}:${tab.id}`}
              slotId="pane.type"
              pluginId={paneDef.ownerPluginId || tab.ownerPluginId}
              contributionId={`pane:${paneDef.type}`}
              groupId={group.id}
              tabId={tab.id}
              depth={1}
              hiddenPreserved={isKeepAlive && !isActive}
            >
              <PaneComp
                groupId={group.id}
                tab={tab}
                active={isActive}
                updateState={(patch) => updateTabState(group.id, tab.id, patch)}
                updateTabMeta={(patch) => updateTabMeta(group.id, tab.id, patch)}
              />
            </PluginMountBoundary>
          );
        })}

        {/* 탭 드래그 → 가장자리 분할 드롭존 프리뷰 */}
        {draggedTab && dropZone && (
          <div className="pointer-events-none absolute inset-0 z-40">
            <div
              className="absolute rounded-xl border-2 flex items-center justify-center transition-all duration-100"
              style={{
                borderColor: 'var(--accent)',
                background: 'color-mix(in srgb, var(--accent) 14%, transparent)',
                top: dropZone === 'down' ? '50%' : '8px',
                bottom: dropZone === 'up' ? '50%' : '8px',
                left: dropZone === 'right' ? '50%' : '8px',
                right: dropZone === 'left' ? '50%' : '8px',
              }}
            >
              <span
                className="px-3 py-1 rounded-full text-[12px] font-semibold shadow-sm"
                style={{ background: 'var(--accent)', color: '#fff' }}
              >
                {dropZone === 'left'
                  ? '왼쪽으로 분할'
                  : dropZone === 'right'
                    ? '오른쪽으로 분할'
                    : dropZone === 'up'
                      ? '위로 분할'
                      : dropZone === 'down'
                        ? '아래로 분할'
                        : '이 창에 탭으로 이동'}
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
