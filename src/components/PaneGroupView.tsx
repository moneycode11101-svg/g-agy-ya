import React, { useEffect, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Columns2,
  Copy,
  Edit3,
  GitCompareArrows,
  Globe,
  LayoutGrid,
  MessageSquare,
  MoreHorizontal,
  Pin,
  PinOff,
  Plus,
  Rows2,
  Search,
  Terminal,
  Trash2,
  X,
} from 'lucide-react';
import type { PaneGroup, PaneKind, PaneTab, SplitDirection } from '../shared/types';
import { useContextMenuStore, type ContextMenuItem } from '../store/contextMenuStore';
import { useSettingsStore } from '../store/settingsStore';
import { useWorkspaceStore } from '../store/workspaceStore';
import { ChatPane } from './ChatPane';
import { DiffPane } from './DiffPane';
import { LauncherPane } from './LauncherPane';
import { TerminalPane } from './TerminalPane';
import { WebviewPane } from './WebviewPane';

interface PaneGroupViewProps {
  group: PaneGroup;
  focused: boolean;
}

type DropZone = SplitDirection | 'center' | null;

function TabIcon({ kind }: { kind: PaneTab['kind'] }) {
  if (kind === 'chat') return <MessageSquare size={12} />;
  if (kind === 'terminal') return <Terminal size={12} />;
  if (kind === 'webview') return <Globe size={12} />;
  if (kind === 'diff') return <GitCompareArrows size={12} />;
  return <LayoutGrid size={12} />;
}

function normalizeQuickUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return 'http://localhost:5173';
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(trimmed)) return `http://${trimmed}`;
  if (/^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(trimmed)) return `https://${trimmed}`;
  return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`;
}

export const PaneGroupView: React.FC<PaneGroupViewProps> = ({ group, focused }) => {
  const groups = useWorkspaceStore((s) => s.groups);
  const setFocusedGroup = useWorkspaceStore((s) => s.setFocusedGroup);
  const setActiveTab = useWorkspaceStore((s) => s.setActiveTab);
  const closeTab = useWorkspaceStore((s) => s.closeTab);
  const closeOtherTabs = useWorkspaceStore((s) => s.closeOtherTabs);
  const closeSplitPane = useWorkspaceStore((s) => s.closeSplitPane);
  const addTabToGroup = useWorkspaceStore((s) => s.addTabToGroup);
  const splitGroup = useWorkspaceStore((s) => s.splitGroup);
  const moveTabToGroup = useWorkspaceStore((s) => s.moveTabToGroup);
  const moveTabToNewSplit = useWorkspaceStore((s) => s.moveTabToNewSplit);
  const duplicateTab = useWorkspaceStore((s) => s.duplicateTab);
  const togglePinTab = useWorkspaceStore((s) => s.togglePinTab);
  const setTabColor = useWorkspaceStore((s) => s.setTabColor);
  const renameTab = useWorkspaceStore((s) => s.renameTab);
  const draggedTab = useWorkspaceStore((s) => s.draggedTab);
  const setDraggedTab = useWorkspaceStore((s) => s.setDraggedTab);
  const runningSessions = useWorkspaceStore((s) => s.runningSessions);
  const recentSessions = useWorkspaceStore((s) => s.recentSessions);
  const openExistingSession = useWorkspaceStore((s) => s.openExistingSession);
  const showMenu = useContextMenuStore((s) => s.showMenu);
  const defaultWebviewUrl = useSettingsStore((s) => s.settings.defaultWebviewUrl);

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

  // Disable <webview> pointer events while dragging a tab so drop zones over webviews work seamlessly
  useEffect(() => {
    const webviews = Array.from(document.querySelectorAll('webview')) as HTMLElement[];
    webviews.forEach((w) => {
      w.style.pointerEvents = draggedTab ? 'none' : '';
    });
    if (!draggedTab) {
      setDropZone(null);
      setTabDropTargetId(null);
    }
  }, [draggedTab]);

  const buildSplitSubmenu = (
    dir: 'h' | 'v',
    side: 'before' | 'after' = 'after'
  ): ContextMenuItem[] => [
    {
      type: 'item',
      label: '새 창 선택 (런처)',
      icon: <LayoutGrid size={13} />,
      onSelect: () => splitGroup(group.id, dir, 'launcher', undefined, side),
    },
    { type: 'separator' },
    {
      type: 'item',
      label: '새 채팅 (agy)',
      icon: <MessageSquare size={13} />,
      onSelect: () => splitGroup(group.id, dir, 'chat', undefined, side),
    },
    {
      type: 'item',
      label: '새 터미널 (zsh)',
      icon: <Terminal size={13} />,
      onSelect: () => splitGroup(group.id, dir, 'terminal', undefined, side),
    },
    {
      type: 'item',
      label: '새 웹사이트 (브라우저)',
      icon: <Globe size={13} />,
      onSelect: () => splitGroup(group.id, dir, 'webview', defaultWebviewUrl, side),
    },
    {
      type: 'item',
      label: 'Git Diff',
      icon: <GitCompareArrows size={13} />,
      onSelect: () => splitGroup(group.id, dir, 'diff', undefined, side),
    },
  ];

  const openTabContextMenu = (e: React.MouseEvent, tab: PaneTab) => {
    e.preventDefault();
    e.stopPropagation();
    const canMoveToSplit = group.tabs.length > 1;
    const unpinnedOthers = group.tabs.filter((t) => t.id !== tab.id && !t.pinned).length;

    const items: ContextMenuItem[] = [
      {
        type: 'submenu',
        label: '오른쪽으로 분할',
        icon: <Columns2 size={13} />,
        items: buildSplitSubmenu('h', 'after'),
      },
      {
        type: 'submenu',
        label: '아래로 분할',
        icon: <Rows2 size={13} />,
        items: buildSplitSubmenu('v', 'after'),
      },
      ...(canMoveToSplit
        ? [
            {
              type: 'submenu' as const,
              label: '이 탭을 분할 창으로 이동',
              icon: <ArrowRight size={13} />,
              items: [
                {
                  type: 'item' as const,
                  label: '오른쪽',
                  icon: <ArrowRight size={13} />,
                  onSelect: () => moveTabToNewSplit(group.id, tab.id, group.id, 'right'),
                },
                {
                  type: 'item' as const,
                  label: '아래',
                  icon: <ArrowDown size={13} />,
                  onSelect: () => moveTabToNewSplit(group.id, tab.id, group.id, 'down'),
                },
                {
                  type: 'item' as const,
                  label: '왼쪽',
                  icon: <ArrowLeft size={13} />,
                  onSelect: () => moveTabToNewSplit(group.id, tab.id, group.id, 'left'),
                },
                {
                  type: 'item' as const,
                  label: '위',
                  icon: <ArrowUp size={13} />,
                  onSelect: () => moveTabToNewSplit(group.id, tab.id, group.id, 'up'),
                },
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
      {
        type: 'item',
        label: '탭 복제',
        icon: <Copy size={13} />,
        onSelect: () => duplicateTab(group.id, tab.id),
      },
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
      { type: 'separator' },
      {
        type: 'item',
        label: '닫기',
        icon: <X size={13} />,
        shortcut: '⌘W',
        disabled: Boolean(tab.pinned),
        onSelect: () => closeTab(group.id, tab.id),
      },
      {
        type: 'item',
        label: '다른 탭 닫기',
        disabled: unpinnedOthers === 0,
        onSelect: () => closeOtherTabs(group.id, tab.id),
      },
      ...(totalGroups > 1
        ? [
            { type: 'separator' as const },
            {
              type: 'item' as const,
              label: '분할 창 닫기',
              icon: <Trash2 size={13} />,
              danger: true,
              onSelect: () => closeSplitPane(group.id),
            },
          ]
        : []),
    ];

    showMenu(e.clientX, e.clientY, items);
  };

  const openPaneActionsMenu = (x: number, y: number) => {
    const items: ContextMenuItem[] = [
      { type: 'label', label: '이 창에 탭 추가' },
      {
        type: 'item',
        label: '새 채팅 (agy)',
        icon: <MessageSquare size={13} />,
        shortcut: '⌘N',
        onSelect: () => addTabToGroup(group.id, 'chat'),
      },
      {
        type: 'item',
        label: '새 터미널 (zsh)',
        icon: <Terminal size={13} />,
        shortcut: '⌘⇧T',
        onSelect: () => addTabToGroup(group.id, 'terminal'),
      },
      {
        type: 'item',
        label: '새 웹사이트 (브라우저)',
        icon: <Globe size={13} />,
        shortcut: '⌘T',
        onSelect: () => addTabToGroup(group.id, 'webview', { url: defaultWebviewUrl }),
      },
      {
        type: 'item',
        label: 'Git Diff',
        icon: <GitCompareArrows size={13} />,
        shortcut: '⌘⇧G',
        onSelect: () => addTabToGroup(group.id, 'diff'),
      },
      { type: 'separator' },
      {
        type: 'submenu',
        label: '오른쪽으로 분할',
        icon: <Columns2 size={13} />,
        items: buildSplitSubmenu('h', 'after'),
      },
      {
        type: 'submenu',
        label: '아래로 분할',
        icon: <Rows2 size={13} />,
        items: buildSplitSubmenu('v', 'after'),
      },
      {
        type: 'submenu',
        label: '왼쪽으로 분할',
        icon: <ArrowLeft size={13} />,
        items: buildSplitSubmenu('h', 'before'),
      },
      {
        type: 'submenu',
        label: '위로 분할',
        icon: <ArrowUp size={13} />,
        items: buildSplitSubmenu('v', 'before'),
      },
      ...(totalGroups > 1
        ? [
            { type: 'separator' as const },
            {
              type: 'item' as const,
              label: '이 분할 창 닫기',
              icon: <Trash2 size={13} />,
              danger: true,
              onSelect: () => closeSplitPane(group.id),
            },
          ]
        : []),
    ];
    showMenu(x, y, items);
  };

  const handleQuickCreate = (kind: Exclude<PaneKind, 'launcher'>, url?: string) => {
    setNewTabOpen(false);
    setNewTabQuery('');
    addTabToGroup(group.id, kind, url ? { url } : undefined);
  };

  const handleNewTabOmniboxSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const q = newTabQuery.trim();
    if (!q) {
      handleQuickCreate('chat');
      return;
    }
    if (q === 'term' || q === 'terminal' || q === '터미널' || q === 'zsh') {
      handleQuickCreate('terminal');
      return;
    }
    if (q === 'chat' || q === '채팅' || q === 'agy') {
      handleQuickCreate('chat');
      return;
    }
    if (q === 'diff' || q === 'git') {
      handleQuickCreate('diff');
      return;
    }
    handleQuickCreate('webview', normalizeQuickUrl(q));
  };

  // Drag-over zone detection on pane body (Orca edge-split drop!)
  const handleBodyDragOver = (e: React.DragEvent) => {
    if (!draggedTab) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const rect = bodyRef.current?.getBoundingClientRect();
    if (!rect) return;
    const rx = (e.clientX - rect.left) / Math.max(1, rect.width);
    const ry = (e.clientY - rect.top) / Math.max(1, rect.height);
    const edge = 0.26;

    // Prevent no-op self split when dragging the only tab in this pane
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

  const qLower = newTabQuery.trim().toLowerCase();
  const matchingSessions = qLower
    ? recentSessions.filter((s) => s.title.toLowerCase().includes(qLower)).slice(0, 4)
    : [];

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
      {/* Orca식 통합 패인 탭 바 (항상 표시: 탭 + '+' 옴니박스 선택기 + 우측 분할/작업 메뉴) */}
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
      >
        {/* 좌측: 드래그 가능한 탭 목록 + Orca '+' 새 탭 드롭다운 */}
        <div className="flex items-center gap-0.5 min-w-0 flex-1">
          <div className="flex items-center gap-0.5 min-w-0 overflow-x-auto scroll-thin">
            {group.tabs.map((tab, idx) => {
              const isActive = tab.id === activeTab?.id;
              const isBusy = tab.kind === 'chat' && Boolean(runningSessions[tab.sessionId]);
              const isEditing = editingTabId === tab.id;
              const isDropTarget = tabDropTargetId === tab.id;

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
                  className="group relative flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[12px] cursor-pointer max-w-[190px] shrink-0 transition-colors"
                  style={{
                    background: isActive ? 'var(--card)' : 'transparent',
                    color: isActive ? 'var(--fg)' : 'var(--muted)',
                    boxShadow: isActive ? 'var(--shadow-sm)' : undefined,
                    borderLeft: isDropTarget ? '2px solid var(--accent)' : undefined,
                  }}
                  title={`${tab.title} (더블클릭 이름 변경 · 드래그로 분할 · 우클릭 메뉴)`}
                >
                  {tab.color && (
                    <span
                      className="w-2 h-2 rounded-full shrink-0"
                      style={{ background: tab.color }}
                    />
                  )}
                  {tab.pinned && <Pin size={10} className="shrink-0 opacity-70" />}
                  <span
                    className={`shrink-0 ${isBusy ? 'animate-pulse' : ''}`}
                    style={{ color: isBusy ? 'var(--accent)' : undefined }}
                  >
                    <TabIcon kind={tab.kind} />
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

                  {!tab.pinned && !isEditing && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        closeTab(group.id, tab.id);
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

          {/* Orca 시그니처 '+' 새 탭 옴니박스 피커 */}
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
              title="새 탭 추가 (채팅 · 터미널 · 웹사이트 · Diff)"
              aria-label="새 탭"
            >
              <Plus size={14} />
            </button>

            {newTabOpen && (
              <div
                className="absolute top-full left-0 mt-1.5 w-[272px] rounded-xl border p-1.5 z-[90] space-y-1"
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
                      placeholder="URL 입력 또는 새 탭 검색..."
                      className="w-full bg-transparent outline-none text-[12px]"
                      style={{ color: 'var(--fg)' }}
                    />
                  </div>
                </form>

                {qLower && (
                  <button
                    type="button"
                    onClick={() => handleQuickCreate('webview', normalizeQuickUrl(newTabQuery))}
                    className="w-full flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg text-[12px] text-left cursor-pointer hover:bg-[var(--surface)]"
                  >
                    <span className="flex items-center gap-2 min-w-0">
                      <Globe size={13} style={{ color: 'var(--accent)' }} className="shrink-0" />
                      <span className="truncate">웹사이트 열기: {newTabQuery}</span>
                    </span>
                    <span className="text-[10.5px] font-mono shrink-0" style={{ color: 'var(--muted)' }}>
                      ↵
                    </span>
                  </button>
                )}

                <div className="space-y-0.5 pt-0.5">
                  {[
                    {
                      kind: 'chat' as const,
                      label: '새 채팅 (agy)',
                      shortcut: '⌘N',
                      icon: <MessageSquare size={13} />,
                      onClick: () => handleQuickCreate('chat'),
                    },
                    {
                      kind: 'terminal' as const,
                      label: '새 터미널 (zsh)',
                      shortcut: '⌘⇧T',
                      icon: <Terminal size={13} />,
                      onClick: () => handleQuickCreate('terminal'),
                    },
                    {
                      kind: 'webview' as const,
                      label: '새 웹사이트 (브라우저)',
                      shortcut: '⌘T',
                      icon: <Globe size={13} />,
                      onClick: () => handleQuickCreate('webview', defaultWebviewUrl),
                    },
                    {
                      kind: 'diff' as const,
                      label: 'Git Diff',
                      shortcut: '⌘⇧G',
                      icon: <GitCompareArrows size={13} />,
                      onClick: () => handleQuickCreate('diff'),
                    },
                  ]
                    .filter((item) => !qLower || item.label.toLowerCase().includes(qLower))
                    .map((item) => (
                      <button
                        key={item.kind}
                        type="button"
                        onClick={item.onClick}
                        className="w-full flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg text-[12.5px] text-left cursor-pointer hover:bg-[var(--surface)]"
                        style={{ color: 'var(--fg)' }}
                      >
                        <span className="flex items-center gap-2">
                          <span style={{ color: 'var(--muted)' }}>{item.icon}</span>
                          <span>{item.label}</span>
                        </span>
                        <span className="text-[11px] font-mono" style={{ color: 'var(--muted)' }}>
                          {item.shortcut}
                        </span>
                      </button>
                    ))}
                </div>

                {matchingSessions.length > 0 && (
                  <div className="pt-1 border-t space-y-0.5" style={{ borderColor: 'var(--border)' }}>
                    <div className="px-2 py-0.5 text-[10.5px] font-semibold" style={{ color: 'var(--muted)' }}>
                      최근 대화
                    </div>
                    {matchingSessions.map((sess) => (
                      <button
                        key={sess.conversationId}
                        type="button"
                        onClick={() => {
                          setNewTabOpen(false);
                          setNewTabQuery('');
                          void openExistingSession(sess, false, group.id);
                        }}
                        className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-[12px] text-left cursor-pointer hover:bg-[var(--surface)] truncate"
                        style={{ color: 'var(--fg-soft)' }}
                      >
                        <MessageSquare size={12} style={{ color: 'var(--muted)' }} className="shrink-0" />
                        <span className="truncate">{sess.title}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* 우측: Orca식 미니멀 분할 버튼 + '⋯' 창 작업 메뉴 */}
        <div className="flex items-center gap-0.5 shrink-0 pl-1">
          <button
            type="button"
            onClick={() => splitGroup(group.id, 'h', 'launcher')}
            className="p-1.5 rounded-md hover:bg-[var(--surface-active)] cursor-pointer transition-colors"
            style={{ color: 'var(--muted)' }}
            title="오른쪽으로 분할 (⌘D) — 새 창 선택"
          >
            <Columns2 size={13.5} />
          </button>
          <button
            type="button"
            onClick={() => splitGroup(group.id, 'v', 'launcher')}
            className="p-1.5 rounded-md hover:bg-[var(--surface-active)] cursor-pointer transition-colors"
            style={{ color: 'var(--muted)' }}
            title="아래로 분할 (⌘⇧D) — 새 창 선택"
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

      {/* 패인 본문 (비활성 웹뷰·터미널은 size-0 보존해 프로세스·로그인 상태 유지!) */}
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
          if (tab.kind === 'webview') {
            return <WebviewPane key={tab.id} groupId={group.id} tab={tab} active={isActive} />;
          }
          if (tab.kind === 'terminal') {
            return <TerminalPane key={tab.id} groupId={group.id} tab={tab} active={isActive} />;
          }
          if (!isActive) return null;
          if (tab.kind === 'launcher') {
            return <LauncherPane key={tab.id} groupId={group.id} tab={tab} />;
          }
          if (tab.kind === 'chat') {
            return <ChatPane key={tab.id} groupId={group.id} tab={tab} />;
          }
          return <DiffPane key={tab.id} groupId={group.id} tab={tab} />;
        })}

        {/* Orca식 탭 드래그 → 가장자리 분할 드롭존 프리뷰 */}
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
                        : '이 창으로 탭 이동'}
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
