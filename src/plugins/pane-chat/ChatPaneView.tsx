import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  AtSign,
  BarChart3,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Columns2,
  Copy,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  Globe,
  KeyRound,
  MessageSquare,
  Minimize2,
  Paperclip,
  Pencil,
  Plus,
  RefreshCw,
  Rows2,
  Shield,
  ShieldAlert,
  Sparkles,
  SquareSlash,
  Terminal,
  Trash2,
} from 'lucide-react';
import {
  BUILTIN_PLUGIN_IDS,
  PANE_WIDGET_ANCHORS,
  SlotOutlet,
  useCommandRegistry,
  useIntrospectionStore,
  useLayoutStore,
  useSlotRegistry,
  type ContextMenuItemDescriptor,
  type DeskClientContext,
  type PaneComponentProps,
} from '../../kernel/client';
import type { ChatMessage, ChatMode, SessionMetrics } from '../../shared/types';
import { fmtKo } from '../../utils/formatKo';
import { AGY_RPC, type AgyLoadedSession } from '../agent-agy/types';
import { AssistantTurnView, UserMessageBubble } from './AssistantTurnView';
import { useChatSessionStore, type ChatTabState, type QueuedPromptItem } from './chatStore';
import type { PaneChatConfig } from './manifest';
import {
  BUILTIN_SLASH_COMMANDS,
  formatModelDisplayLabel,
  groupModelsIntoFamilies,
  type SlashCommandItem,
} from './modelCatalog';

interface MentionFileEntry {
  name: string;
  relPath: string;
  fullPath: string;
  isDir: boolean;
}

const EMPTY_MESSAGES: ChatMessage[] = [];
const EMPTY_QUEUE: QueuedPromptItem[] = [];

const EFFORT_LABELS: Record<string, string> = {
  low: '낮음',
  medium: '보통',
  high: '높음',
  xhigh: '매우 높음',
  max: '최대',
};

const MODE_OPTIONS: Array<{ value: ChatMode; label: string; desc: string }> = [
  { value: 'turbo', label: '터보', desc: '모든 도구 자동 실행' },
  { value: 'auto', label: '자동', desc: '안전 기준 자동 승인' },
  { value: 'accept-edits', label: '편집 허용', desc: '파일 편집 자동 허용' },
  { value: 'plan', label: '계획', desc: '읽기·계획 전용' },
  { value: 'strict', label: '엄격', desc: '샌드박스 제한 실행' },
];

function translatePermissionOption(opt: { optionId: string; name: string; kind?: string }): string {
  const k = (opt.kind || opt.optionId || '').toLowerCase();
  if (k.includes('allow_always') || opt.name.toLowerCase().includes('always')) return '이 세션에서 항상 허용';
  if (k.includes('allow_once') || k === 'allow' || opt.name.toLowerCase() === 'allow') return '허용';
  if (k.includes('reject') || k.includes('deny') || opt.name.toLowerCase().includes('deny') || opt.name.toLowerCase().includes('reject')) {
    return '거부';
  }
  return opt.name;
}

export interface ChatPaneViewProps extends PaneComponentProps<ChatTabState> {
  ctx: DeskClientContext<PaneChatConfig>;
}

export const ChatPaneView: React.FC<ChatPaneViewProps> = ({ groupId, tab, updateState, ctx }) => {
  const state = tab.state;
  const sessionId = state.sessionId;
  const externalSessionId = state.externalSessionId ?? state.agyConversationId ?? null;

  const cfg = ctx.config.useConfig();
  const messages = useChatSessionStore((s) => s.messagesBySession[sessionId]) ?? EMPTY_MESSAGES;
  const queuedPrompts = useChatSessionStore((s) => s.queuedPromptsBySession[sessionId]) ?? EMPTY_QUEUE;
  const metrics = useChatSessionStore((s) => s.metricsBySession[sessionId]);
  const isRunning = useChatSessionStore((s) => Boolean(s.runningSessions[sessionId]));
  const authPrompt = useChatSessionStore((s) => s.authPrompts[sessionId]);
  const permissionPrompt = useChatSessionStore((s) => s.permissionPrompts[sessionId]);
  const errorText = useChatSessionStore((s) => s.errorsBySession[sessionId]);
  const adapterAvailable = useChatSessionStore((s) => s.adapterAvailable);
  const availableModels = useChatSessionStore((s) => s.availableModels);
  const availableCommands = useChatSessionStore((s) => s.availableCommands);
  const refreshModels = useChatSessionStore((s) => s.refreshModels);
  const sendPrompt = useChatSessionStore((s) => s.sendPrompt);
  const removeQueuedPrompt = useChatSessionStore((s) => s.removeQueuedPrompt);
  const updateQueuedPrompt = useChatSessionStore((s) => s.updateQueuedPrompt);
  const sendQueuedNow = useChatSessionStore((s) => s.sendQueuedNow);
  const cancelTurn = useChatSessionStore((s) => s.cancelTurn);
  const submitAuthCode = useChatSessionStore((s) => s.submitAuthCode);
  const respondPermission = useChatSessionStore((s) => s.respondPermission);
  const hydrateSession = useChatSessionStore((s) => s.hydrateSession);
  const setSessionMetrics = useChatSessionStore((s) => s.setSessionMetrics);

  const groups = useLayoutStore((s) => s.groups);
  const splitGroup = useLayoutStore((s) => s.splitGroup);
  const addTabToGroup = useLayoutStore((s) => s.addTabToGroup);
  const closeSplitPane = useLayoutStore((s) => s.closeSplitPane);
  const registeredPaneTypes = useSlotRegistry((s) => s.paneTypes);
  const contextMenuContribs = useSlotRegistry((s) => s.bySlot['context-menu.item']);
  const runtimeAssets = useIntrospectionStore(
    (s) => s.snapshot?.runtimeAssetsByAdapter?.[BUILTIN_PLUGIN_IDS.AGENT_AGY]?.assets
  );

  const [input, setInput] = useState(state.initialPrompt || '');
  const [authCode, setAuthCode] = useState('');
  const [attachedImages, setAttachedImages] = useState<string[]>([]);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [modeMenuOpen, setModeMenuOpen] = useState(false);
  const [plusMenuOpen, setPlusMenuOpen] = useState(false);
  const [activeFamilyId, setActiveFamilyId] = useState<string | null>(null);
  const [refreshingModels, setRefreshingModels] = useState(false);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const [slashIndex, setSlashIndex] = useState(0);
  const [mentionDismissed, setMentionDismissed] = useState(false);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [mentionItems, setMentionItems] = useState<MentionFileEntry[]>([]);
  const [queueCardCollapsed, setQueueCardCollapsed] = useState(false);
  const [editingQueueId, setEditingQueueId] = useState<string | null>(null);
  const [editingQueueText, setEditingQueueText] = useState('');
  const [pendingSwitch, setPendingSwitch] = useState<{ patch: Partial<ChatTabState>; label: string } | null>(null);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const isComposingRef = useRef(false);
  const compositionDataRef = useRef('');
  const postSubmitGuardUntilRef = useRef(0);

  // Consume one-shot initialPrompt (e.g. from X-Ray "Ask Agent") so it does not repeat on reload
  useEffect(() => {
    if (state.initialPrompt) {
      setInput(state.initialPrompt);
      updateState({ initialPrompt: undefined });
      textareaRef.current?.focus();
    }
  }, [state.initialPrompt, updateState]);

  // Listen for `chat:prefill-prompt` from Plugin Studio / UI X-Ray "이 플러그인 수정 에이전트에 묻기"
  useEffect(() => {
    const unsub = ctx.bus.subscribe<{
      groupId?: string | null;
      tabId?: string | null;
      cwd?: string;
      prompt?: string;
    }>('chat:prefill-prompt', (env) => {
      const p = env.payload;
      if (!p?.prompt) return;
      if (p.tabId && p.tabId !== tab.id) return;
      if (!p.tabId && p.groupId && p.groupId !== groupId) return;
      setInput(p.prompt);
      if (p.cwd) updateState({ cwd: p.cwd });
      requestAnimationFrame(() => textareaRef.current?.focus());
    });
    return () => {
      void unsub();
    };
  }, [ctx.bus, groupId, tab.id, updateState]);

  const lastMessage = messages[messages.length - 1];
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [
    messages.length,
    queuedPrompts.length,
    lastMessage?.text,
    lastMessage?.thinking,
    lastMessage?.blocks?.length,
    lastMessage?.focus,
    permissionPrompt?.requestId,
  ]);

  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(160, Math.max(24, ta.scrollHeight))}px`;
  }, [input]);

  useEffect(() => {
    setSlashDismissed(false);
    setSlashIndex(0);
    setMentionDismissed(false);
    setMentionIndex(0);
  }, [input]);

  useEffect(() => {
    if (!modelMenuOpen && !modeMenuOpen && !plusMenuOpen) return;
    const onClick = () => {
      setModelMenuOpen(false);
      setModeMenuOpen(false);
      setPlusMenuOpen(false);
    };
    window.addEventListener('click', onClick);
    return () => window.removeEventListener('click', onClick);
  }, [modelMenuOpen, modeMenuOpen, plusMenuOpen]);

  // Hydrate & fs.watch with proper cleanup (`unwatchSession`) + race guard (mandatory fix b)
  useEffect(() => {
    if (!externalSessionId || !adapterAvailable) return;
    let cancelled = false;

    const existingMsgs = useChatSessionStore.getState().messagesBySession[sessionId];
    const existingMetrics = useChatSessionStore.getState().metricsBySession[sessionId];
    if (!existingMsgs?.length && !existingMetrics) {
      void ctx.rpc
        .invoke<AgyLoadedSession>(AGY_RPC.SESSIONS_LOAD, { conversationId: externalSessionId })
        .then((loaded) => {
          if (cancelled || !loaded) return;
          hydrateSession(sessionId, loaded.messages, loaded.metrics);
        })
        .catch(() => {});
    }

    void ctx.rpc
      .invoke<SessionMetrics | null>(AGY_RPC.SESSIONS_WATCH, {
        tabSessionId: sessionId,
        conversationId: externalSessionId,
      })
      .then((watched) => {
        if (cancelled || !watched) return;
        setSessionMetrics(sessionId, watched);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      void ctx.rpc.invoke(AGY_RPC.SESSIONS_UNWATCH, { tabSessionId: sessionId }).catch(() => {});
    };
  }, [adapterAvailable, ctx.rpc, externalSessionId, hydrateSession, sessionId, setSessionMetrics]);

  const modelFamilies = useMemo(() => groupModelsIntoFamilies(availableModels), [availableModels]);
  const activeModelFamily = useMemo(
    () => modelFamilies.find((f) => f.variants.some((v) => v.value === state.model)) || null,
    [modelFamilies, state.model]
  );
  const expandedFamily = useMemo(() => {
    if (activeFamilyId) {
      return modelFamilies.find((f) => f.id === activeFamilyId) || null;
    }
    return activeModelFamily;
  }, [activeFamilyId, activeModelFamily, modelFamilies]);

  const allSlashItems = useMemo<SlashCommandItem[]>(() => {
    const items: SlashCommandItem[] = [...BUILTIN_SLASH_COMMANDS];
    const seen = new Set(items.map((i) => i.command.toLowerCase()));
    const builtinSet = new Set(BUILTIN_SLASH_COMMANDS.map((i) => i.command.toLowerCase()));

    // Merge live official commands/skills announced by `agy acp`
    for (const acpCmd of availableCommands) {
      const cmd = acpCmd.name.startsWith('/') ? acpCmd.name : `/${acpCmd.name}`;
      const key = cmd.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({
        command: cmd,
        description: acpCmd.description || 'agy 명령어 · 스킬',
        category: builtinSet.has(key) ? '내장 명령' : '스킬',
      });
    }

    if (Array.isArray(runtimeAssets)) {
      for (const asset of runtimeAssets) {
        if (asset.kind !== 'skill' || !asset.enabled) continue;
        const cmd = `/${asset.name}`;
        if (seen.has(cmd.toLowerCase())) continue;
        seen.add(cmd.toLowerCase());
        items.push({
          command: cmd,
          description: asset.description || '설치된 agy 스킬',
          category: '스킬',
        });
      }
    }
    return items;
  }, [availableCommands, runtimeAssets]);

  const slashMatch = useMemo(() => {
    if (slashDismissed) return null;
    const m = input.match(/^\/([^\s\n]*)$/);
    return m ? m[1].toLowerCase() : null;
  }, [input, slashDismissed]);

  const filteredSlashItems = useMemo(() => {
    if (slashMatch === null) return [];
    if (!slashMatch) return allSlashItems;
    return allSlashItems.filter(
      (item) =>
        item.command.toLowerCase().includes(slashMatch) ||
        item.description.toLowerCase().includes(slashMatch)
    );
  }, [allSlashItems, slashMatch]);

  const slashMenuOpen = slashMatch !== null && filteredSlashItems.length > 0;

  // `@` workspace file/folder mention detection & live listing
  const mentionMatch = useMemo(() => {
    if (mentionDismissed || slashMenuOpen) return null;
    const m = input.match(/(?:^|\s)@([^\s\n]*)$/);
    return m ? m[1] : null;
  }, [input, mentionDismissed, slashMenuOpen]);

  useEffect(() => {
    if (mentionMatch === null) {
      setMentionItems([]);
      return;
    }
    let cancelled = false;
    void ctx.rpc
      .invoke<MentionFileEntry[]>('pane-chat:listFiles', {
        cwd: state.cwd,
        query: mentionMatch,
        limit: 16,
      })
      .then((res) => {
        if (!cancelled && Array.isArray(res)) {
          setMentionItems(res);
          setMentionIndex(0);
        }
      })
      .catch(() => {
        if (!cancelled) setMentionItems([]);
      });
    return () => {
      cancelled = true;
    };
  }, [ctx.rpc, mentionMatch, state.cwd]);

  const mentionMenuOpen = mentionMatch !== null && mentionItems.length > 0;

  const selectMentionItem = (entry: MentionFileEntry) => {
    const nextInput = input.replace(/@([^\s\n]*)$/, `@${entry.relPath} `);
    setInput(nextInput);
    setMentionDismissed(true);
    if (!entry.isDir) {
      setAttachedImages((prev) => Array.from(new Set([...prev, entry.fullPath])));
    } else if (entry.fullPath !== state.cwd) {
      const nextDirs = Array.from(new Set([...(state.addDirs || []), entry.fullPath]));
      updateState({ addDirs: nextDirs });
    }
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const triggerMentionFromMenu = () => {
    setPlusMenuOpen(false);
    setMentionDismissed(false);
    setInput((prev) => {
      if (/(?:^|\s)@$/.test(prev)) return prev;
      return prev && !/\s$/.test(prev) ? `${prev} @` : `${prev}@`;
    });
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const triggerSlashFromMenu = () => {
    setPlusMenuOpen(false);
    setSlashDismissed(false);
    setInput((prev) => (prev.startsWith('/') ? prev : '/'));
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const triggerBrowserFromMenu = () => {
    setPlusMenuOpen(false);
    if (registeredPaneTypes['webview']) {
      splitGroup(groupId, 'h', 'webview');
    } else {
      setInput('/browser ');
      requestAnimationFrame(() => textareaRef.current?.focus());
    }
  };

  const selectSlashItem = (item: SlashCommandItem) => {
    setInput(`${item.command} `);
    setSlashDismissed(true);
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  // Independent `warnOnCacheReset` — works even when `hud-token-bar` plugin is OFF (mandatory fix c)
  const requestSwitchModel = (modelValue: string) => {
    setModelMenuOpen(false);
    if (modelValue === state.model && (!state.effort || state.effort === 'default')) return;
    const patch: Partial<ChatTabState> = { model: modelValue, effort: 'default' };
    const ctxTokens = metrics?.currentContext ?? 0;
    if (cfg.warnOnCacheReset !== false && ctxTokens > 5000) {
      setPendingSwitch({ patch, label: formatModelDisplayLabel(modelValue, availableModels) });
    } else {
      updateState(patch);
    }
  };

  const handleRefreshModels = async () => {
    setRefreshingModels(true);
    try {
      await refreshModels(true);
    } finally {
      setRefreshingModels(false);
    }
  };

  const handlePickCwd = async () => {
    setPlusMenuOpen(false);
    try {
      const dir = await ctx.rpc.invoke<string | null>('pane-chat:pickDirectory');
      if (dir) updateState({ cwd: dir });
    } catch {
      // ignore
    }
  };

  const handlePickFiles = async () => {
    setPlusMenuOpen(false);
    try {
      const files = await ctx.rpc.invoke<string[]>('pane-chat:pickFiles');
      if (Array.isArray(files) && files.length > 0) {
        setAttachedImages((prev) => Array.from(new Set([...prev, ...files])));
      }
    } catch {
      // ignore
    }
  };

  const handleAddExtraDir = async () => {
    setPlusMenuOpen(false);
    try {
      const dir = await ctx.rpc.invoke<string | null>('pane-chat:pickDirectory');
      if (dir && dir !== state.cwd) {
        const next = Array.from(new Set([...(state.addDirs || []), dir]));
        updateState({ addDirs: next });
      }
    } catch {
      // ignore
    }
  };

  const handleRemoveAddDir = (dir: string) => {
    const next = (state.addDirs || []).filter((d) => d !== dir);
    updateState({ addDirs: next.length > 0 ? next : undefined });
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = Array.from(e.clipboardData?.items || []);
    const imageItems = items.filter((it) => it.kind === 'file' && it.type.startsWith('image/'));
    if (imageItems.length === 0) return;

    const hasPlainText = items.some((it) => it.kind === 'string' && it.type === 'text/plain');
    if (!hasPlainText) e.preventDefault();

    for (const item of imageItems) {
      const file = item.getAsFile();
      if (!file) continue;
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = typeof reader.result === 'string' ? reader.result : '';
        if (!dataUrl) return;
        void ctx.rpc
          .invoke<string | null>('pane-chat:saveClipboardImage', {
            dataUrl,
            ext: file.type.split('/')[1] || 'png',
          })
          .then((savedPath) => {
            if (savedPath) {
              setAttachedImages((prev) => Array.from(new Set([...prev, savedPath])));
            }
          })
          .catch(() => {});
      };
      reader.readAsDataURL(file);
    }
  };

  const openExternalSafe = async (url: string) => {
    const linkCmd = useCommandRegistry.getState().commands['link:open'];
    if (linkCmd) {
      await ctx.commands.execute('link:open', { url });
      return;
    }
    try {
      await ctx.rpc.invoke('pane-chat:openExternal', { url });
    } catch {
      // ignore
    }
  };

  const handleSubmit = async (e?: React.FormEvent, delivery?: 'queue' | 'immediate') => {
    e?.preventDefault();
    const ta = textareaRef.current;
    const raw = ta?.value ?? input;
    const text = raw.trim();
    if (!text) return;

    // Force macOS Korean IME to terminate any in-flight composition cleanly so no ghost syllable leaks back
    postSubmitGuardUntilRef.current = Date.now() + 80;
    if (isComposingRef.current && ta) {
      isComposingRef.current = false;
      compositionDataRef.current = '';
      ta.blur();
      ta.value = '';
      setInput('');
      requestAnimationFrame(() => {
        if (textareaRef.current) {
          textareaRef.current.value = '';
          textareaRef.current.focus();
        }
      });
    } else {
      setInput('');
      if (ta) ta.value = '';
    }

    const imgs = [...attachedImages];
    setAttachedImages([]);
    await sendPrompt(groupId, tab.id, state, text, imgs, delivery);
  };

  const handleMarkdownClick = (e: React.MouseEvent) => {
    const anchor = (e.target as HTMLElement | null)?.closest('a');
    if (!anchor) return;
    const href = anchor.getAttribute('href');
    if (href && /^https?:\/\//i.test(href)) {
      e.preventDefault();
      void openExternalSafe(href);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const files = Array.from(e.dataTransfer.files || []);
    const paths = files
      .map((f) => (f as File & { path?: string }).path)
      .filter((p): p is string => Boolean(p));
    if (paths.length > 0) setAttachedImages((prev) => [...prev, ...paths]);
  };

  const colMaxWidthClass =
    cfg.chatWidth === 'wide' ? 'max-w-none' : cfg.chatWidth === 'medium' ? 'max-w-[900px]' : 'max-w-[740px]';

  const currentModelLabel = formatModelDisplayLabel(state.model, availableModels);
  const modelHasEmbeddedTier = Boolean(
    state.model && state.model !== 'default' && /-(low|medium|high|xhigh|max)$/i.test(state.model)
  );
  const currentEffortSuffix =
    !modelHasEmbeddedTier && state.effort && state.effort !== 'default'
      ? ` · ${EFFORT_LABELS[state.effort] || state.effort}`
      : '';
  const currentModeLabel = MODE_OPTIONS.find((m) => m.value === state.mode)?.label || '터보';
  const totalGroups = Object.keys(groups).length;

  const handlePaneContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const sel = window.getSelection()?.toString() || '';
    const extraItems: ContextMenuItemDescriptor[] = [];
    for (const entry of contextMenuContribs || []) {
      const c = entry.contribution as {
        target?: string;
        resolve?: (arg: { groupId?: string; tab?: typeof tab }) => ContextMenuItemDescriptor[];
      };
      if (c.target === 'pane-body' && typeof c.resolve === 'function') {
        try {
          extraItems.push(...c.resolve({ groupId, tab }));
        } catch {
          // isolate plugin menu error
        }
      }
    }

    const items: ContextMenuItemDescriptor[] = [
      ...(sel
        ? [
            {
              type: 'item' as const,
              label: '선택 텍스트 복사',
              icon: <Copy size={13} />,
              shortcut: '⌘C',
              onSelect: () => void navigator.clipboard.writeText(sel),
            },
            { type: 'separator' as const },
          ]
        : []),
      {
        type: 'item',
        label: '오른쪽으로 분할 (새 창 선택)',
        icon: <Columns2 size={13} />,
        shortcut: '⌘D',
        onSelect: () => splitGroup(groupId, 'h', registeredPaneTypes['launcher'] ? 'launcher' : 'chat'),
      },
      {
        type: 'item',
        label: '아래로 분할 (새 창 선택)',
        icon: <Rows2 size={13} />,
        shortcut: '⌘⇧D',
        onSelect: () => splitGroup(groupId, 'v', registeredPaneTypes['launcher'] ? 'launcher' : 'chat'),
      },
      ...(registeredPaneTypes['terminal'] || registeredPaneTypes['webview']
        ? [
            { type: 'separator' as const },
            ...(registeredPaneTypes['terminal']
              ? [
                  {
                    type: 'item' as const,
                    label: '옆에 터미널 열기',
                    icon: <Terminal size={13} />,
                    onSelect: () => splitGroup(groupId, 'h', 'terminal', { cwd: state.cwd }),
                  },
                ]
              : []),
            ...(registeredPaneTypes['webview']
              ? [
                  {
                    type: 'item' as const,
                    label: '옆에 웹사이트 열기',
                    icon: <Globe size={13} />,
                    onSelect: () => splitGroup(groupId, 'h', 'webview'),
                  },
                ]
              : []),
          ]
        : []),
      { type: 'separator' },
      {
        type: 'item',
        label: '이 창에 새 채팅 탭 추가',
        icon: <MessageSquare size={13} />,
        shortcut: '⌘N',
        onSelect: () => addTabToGroup(groupId, 'chat', { cwd: state.cwd }),
      },
      {
        type: 'item',
        label: '/compact 컨텍스트 압축',
        icon: <Minimize2 size={13} />,
        disabled: isRunning || messages.length === 0 || !adapterAvailable,
        onSelect: () => void sendPrompt(groupId, tab.id, state, '/compact'),
      },
      ...(extraItems.length > 0 ? [{ type: 'separator' as const }, ...extraItems] : []),
      ...(totalGroups > 1
        ? [
            { type: 'separator' as const },
            {
              type: 'item' as const,
              label: '이 분할 창 닫기',
              icon: <Trash2 size={13} />,
              danger: true,
              onSelect: () => void closeSplitPane(groupId),
            },
          ]
        : []),
    ];

    ctx.ui.showContextMenu(e.clientX, e.clientY, items);
  };

  return (
    <div
      className="flex-1 min-h-0 flex flex-col @container"
      style={{ background: 'var(--bg)' }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={handleDrop}
      onContextMenu={handlePaneContextMenu}
    >
      {/* 중앙 채팅 스크롤 영역 */}
      <div
        ref={scrollRef}
        onClick={handleMarkdownClick}
        className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden scroll-thin"
      >
        <div className={`${colMaxWidthClass} mx-auto w-full px-6 py-6 space-y-6 min-w-0`}>
          {!adapterAvailable && (
            <div
              className="rounded-2xl border px-4 py-3 flex items-center justify-between gap-3 text-xs"
              style={{
                borderColor: 'color-mix(in srgb, var(--warn) 40%, transparent)',
                background: 'color-mix(in srgb, var(--warn) 8%, var(--card))',
                color: 'var(--fg)',
              }}
            >
              <div>
                <div className="font-semibold">에이전트 어댑터(agent-agy)가 비활성화되어 있습니다.</div>
                <div className="text-[11.5px] mt-0.5" style={{ color: 'var(--muted)' }}>
                  플러그인을 다시 켜면 즉시 대화를 이어갈 수 있습니다.
                </div>
              </div>
              <button
                type="button"
                onClick={() =>
                  void useIntrospectionStore.getState().sendCommand({
                    type: 'plugin:toggle',
                    pluginId: BUILTIN_PLUGIN_IDS.AGENT_AGY,
                    enabled: true,
                  })
                }
                className="px-3 py-1.5 rounded-lg text-[11.5px] font-medium cursor-pointer shrink-0"
                style={{ background: 'var(--accent)', color: '#fff' }}
              >
                agent-agy 켜기
              </button>
            </div>
          )}

          {messages.length === 0 ? (
            <div className="pt-20 pb-8 flex flex-col items-center text-center gap-2">
              <div className="text-[20px] font-semibold tracking-tight" style={{ color: 'var(--fg)' }}>
                무엇을 작업할까요?
              </div>
              <div className="text-[13px] max-w-md leading-relaxed" style={{ color: 'var(--muted)' }}>
                각 채팅은 공식 <code>agy acp</code> 상주 세션으로 연결됩니다. 상단 분할 버튼으로 플러그인 스튜디오·웹뷰·터미널을 옆에 자유롭게 띄워둘 수 있습니다.
              </div>
            </div>
          ) : (
            messages.map((m) =>
              m.role === 'user' ? (
                <UserMessageBubble key={m.id} message={m} />
              ) : (
                <AssistantTurnView
                  key={m.id}
                  message={m}
                  transcriptView={cfg.transcriptView || 'normal'}
                />
              )
            )
          )}

          {errorText && (
            <div
              className="rounded-2xl border px-4 py-3 text-xs whitespace-pre-wrap"
              style={{
                borderColor: 'color-mix(in srgb, var(--danger) 35%, transparent)',
                color: 'var(--danger)',
                background: 'color-mix(in srgb, var(--danger) 6%, var(--card))',
              }}
            >
              {errorText}
            </div>
          )}
        </div>
      </div>

      {/* 하단 플로팅 영역: 배너 + 동적 위젯 슬롯(chat:above-composer) + 대기 중인 메시지 카드 + 컴포저 */}
      <div className="shrink-0 w-full">
        <div className={`${colMaxWidthClass} mx-auto w-full px-5 pb-4 pt-1 space-y-2.5`}>
          {pendingSwitch && (
            <div
              className="rounded-xl border px-3.5 py-2 flex items-center justify-between gap-2 text-xs"
              style={{
                background: 'color-mix(in srgb, var(--warn) 10%, var(--card))',
                borderColor: 'color-mix(in srgb, var(--warn) 40%, transparent)',
              }}
            >
              <div className="flex items-center gap-2 min-w-0">
                <AlertTriangle size={14} style={{ color: 'var(--warn)' }} className="shrink-0" />
                <span className="truncate">
                  모델을 <strong>{pendingSwitch.label}</strong>(으)로 바꾸면 이 대화 캐시(
                  <strong>{fmtKo(metrics?.currentContext)}</strong>)가 다음 전송 때 0%로 초기화됩니다.
                </span>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  type="button"
                  onClick={() => {
                    updateState(pendingSwitch.patch);
                    setPendingSwitch(null);
                  }}
                  className="px-2.5 py-1 rounded-lg text-[11px] font-medium cursor-pointer"
                  style={{ background: 'var(--warn)', color: '#fff' }}
                >
                  변경
                </button>
                <button
                  type="button"
                  onClick={() => setPendingSwitch(null)}
                  className="px-2 py-1 rounded-lg text-[11px] cursor-pointer hover:bg-[var(--surface)]"
                  style={{ color: 'var(--muted)' }}
                >
                  취소
                </button>
              </div>
            </div>
          )}

          {permissionPrompt && (
            <div
              className="rounded-2xl border px-4 py-3 text-xs space-y-2.5"
              style={{
                background: 'var(--card)',
                borderColor: 'color-mix(in srgb, var(--warn) 45%, transparent)',
                boxShadow: 'var(--shadow-sm)',
              }}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-start gap-2 min-w-0">
                  <ShieldAlert size={15} className="shrink-0 mt-0.5" style={{ color: 'var(--warn)' }} />
                  <div className="min-w-0">
                    <div className="font-semibold flex items-center gap-1.5 flex-wrap">
                      <span>도구 실행 승인 요청</span>
                      <span
                        className="font-mono text-[10.5px] px-1.5 py-0.5 rounded-md font-normal"
                        style={{ background: 'var(--surface)', color: 'var(--muted)' }}
                      >
                        {permissionPrompt.toolName}
                      </span>
                    </div>
                    <div className="mt-0.5 font-mono text-[11.5px] break-all" style={{ color: 'var(--fg-soft)' }}>
                      {permissionPrompt.argsSummary || permissionPrompt.title}
                    </div>
                  </div>
                </div>
              </div>

              {permissionPrompt.rawInput && (
                <details className="text-[11px]" style={{ color: 'var(--muted)' }}>
                  <summary className="cursor-pointer select-none hover:opacity-100 opacity-80">
                    실행 파라미터 상세 보기
                  </summary>
                  <pre
                    className="mt-1.5 p-2 rounded-xl border font-mono text-[11px] overflow-x-auto max-h-36 whitespace-pre-wrap break-words"
                    style={{ background: 'var(--sidebar)', borderColor: 'var(--border)' }}
                  >
                    {permissionPrompt.rawInput}
                  </pre>
                </details>
              )}

              <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                {permissionPrompt.options.map((opt, idx) => {
                  const isReject =
                    (opt.kind || opt.optionId).toLowerCase().includes('reject') ||
                    (opt.kind || opt.optionId).toLowerCase().includes('deny');
                  const isPrimary = idx === 0 && !isReject;
                  return (
                    <button
                      key={opt.optionId}
                      type="button"
                      onClick={() =>
                        void respondPermission(sessionId, permissionPrompt.requestId, opt.optionId)
                      }
                      className="px-3 py-1.5 rounded-lg text-[11.5px] font-medium cursor-pointer transition-opacity hover:opacity-90"
                      style={
                        isPrimary
                          ? { background: 'var(--accent)', color: '#fff' }
                          : isReject
                            ? {
                                background: 'color-mix(in srgb, var(--danger) 12%, var(--surface))',
                                color: 'var(--danger)',
                              }
                            : { background: 'var(--surface)', color: 'var(--fg-soft)' }
                      }
                    >
                      {translatePermissionOption(opt)}
                    </button>
                  );
                })}
                <button
                  type="button"
                  onClick={() => void respondPermission(sessionId, permissionPrompt.requestId, null)}
                  className="px-2.5 py-1.5 rounded-lg text-[11.5px] cursor-pointer hover:bg-[var(--surface)]"
                  style={{ color: 'var(--muted)' }}
                >
                  취소
                </button>
              </div>
            </div>
          )}

          {authPrompt && (
            <div
              className="rounded-2xl border px-4 py-3 text-xs space-y-2.5"
              style={{
                background: 'var(--card)',
                borderColor: 'color-mix(in srgb, var(--accent) 45%, transparent)',
                boxShadow: 'var(--shadow-sm)',
              }}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 font-medium">
                  <KeyRound size={14} style={{ color: 'var(--accent)' }} />
                  <span>{authPrompt.message}</span>
                </div>
                <button
                  type="button"
                  onClick={() => void openExternalSafe(authPrompt.url)}
                  className="px-3 py-1 rounded-lg text-[11px] font-medium cursor-pointer shrink-0"
                  style={{ background: 'var(--accent)', color: '#fff' }}
                >
                  Google 로그인 열기
                </button>
              </div>
              <form
                className="flex items-center gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (authCode.trim()) {
                    void submitAuthCode(sessionId, authCode);
                    setAuthCode('');
                  }
                }}
              >
                <input
                  type="text"
                  value={authCode}
                  onChange={(e) => setAuthCode(e.target.value)}
                  placeholder="인증 코드를 붙여넣고 Enter..."
                  className="flex-1 px-3 py-1.5 rounded-lg border text-xs outline-none"
                  style={{ background: 'var(--bg)', borderColor: 'var(--border-strong)', color: 'var(--fg)' }}
                />
                <button
                  type="submit"
                  className="px-3 py-1.5 rounded-lg text-[11px] font-medium cursor-pointer"
                  style={{ background: 'var(--fg)', color: 'var(--bg)' }}
                >
                  확인
                </button>
              </form>
            </div>
          )}

          {/* 동적 플러그인 슬롯: chat:above-composer (hud-token-bar 등) */}
          <SlotOutlet
            slotId="pane.widget"
            targetPaneType="chat"
            anchor={PANE_WIDGET_ANCHORS.CHAT_ABOVE_COMPOSER}
            groupId={groupId}
            tab={tab}
          />

          {/* 순정 Antigravity 스타일 `대기 중인 메시지` 카드 */}
          {queuedPrompts.length > 0 && (
            <div
              className="rounded-[20px] border px-4 py-3 transition-all"
              style={{
                background: 'var(--card)',
                borderColor: 'var(--border-strong)',
                boxShadow: 'var(--shadow-sm)',
              }}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-[13px] font-semibold shrink-0" style={{ color: 'var(--fg)' }}>
                    대기 중인 메시지
                  </span>
                  <span
                    className="inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full text-[11px] font-semibold tabular-nums shrink-0"
                    style={{ background: 'var(--surface)', color: 'var(--fg-soft)' }}
                  >
                    {queuedPrompts.length}
                  </span>
                  <span className="text-[12px] truncate" style={{ color: 'var(--muted)' }}>
                    에이전트 작업이 끝난 후 전송됨
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => setQueueCardCollapsed((v) => !v)}
                  className="p-1 rounded-lg hover:bg-[var(--surface)] cursor-pointer shrink-0"
                  style={{ color: 'var(--muted)' }}
                  title={queueCardCollapsed ? '대기 메시지 펼치기' : '대기 메시지 접기'}
                  aria-label="대기 중인 메시지 접기/펼치기"
                >
                  {queueCardCollapsed ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
                </button>
              </div>

              {!queueCardCollapsed && (
                <div className="mt-2.5 space-y-1.5">
                  {queuedPrompts.map((q) => (
                    <div
                      key={q.id}
                      className="flex items-center justify-between gap-2 py-1 rounded-xl"
                    >
                      {editingQueueId === q.id ? (
                        <input
                          type="text"
                          autoFocus
                          value={editingQueueText}
                          onChange={(e) => setEditingQueueText(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                              e.preventDefault();
                              updateQueuedPrompt(sessionId, q.id, editingQueueText);
                              setEditingQueueId(null);
                            } else if (e.key === 'Escape') {
                              e.preventDefault();
                              setEditingQueueId(null);
                            }
                          }}
                          onBlur={() => {
                            updateQueuedPrompt(sessionId, q.id, editingQueueText);
                            setEditingQueueId(null);
                          }}
                          className="flex-1 min-w-0 px-2.5 py-1 rounded-lg border text-[13px] outline-none"
                          style={{
                            background: 'var(--bg)',
                            borderColor: 'var(--accent)',
                            color: 'var(--fg)',
                          }}
                        />
                      ) : (
                        <div className="min-w-0 flex-1 text-[13.5px] truncate" style={{ color: 'var(--fg)' }}>
                          {q.prompt}
                        </div>
                      )}

                      <div className="flex items-center gap-0.5 shrink-0">
                        <button
                          type="button"
                          onClick={() => void sendQueuedNow(groupId, tab.id, state, q.id)}
                          className="p-1.5 rounded-lg hover:bg-[var(--surface)] cursor-pointer transition-colors"
                          style={{ color: 'var(--muted)' }}
                          title="지금 바로 전송"
                          aria-label="지금 바로 전송"
                        >
                          <ArrowRight size={14} />
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setEditingQueueId(q.id);
                            setEditingQueueText(q.prompt);
                          }}
                          className="p-1.5 rounded-lg hover:bg-[var(--surface)] cursor-pointer transition-colors"
                          style={{ color: 'var(--muted)' }}
                          title="대기 메시지 편집"
                          aria-label="대기 메시지 편집"
                        >
                          <Pencil size={14} />
                        </button>
                        <button
                          type="button"
                          onClick={() => removeQueuedPrompt(sessionId, q.id)}
                          className="p-1.5 rounded-lg hover:bg-[var(--surface)] cursor-pointer transition-colors"
                          style={{ color: 'var(--muted)' }}
                          title="대기 메시지 삭제"
                          aria-label="대기 메시지 삭제"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* 플로팅 컴포저 카드 */}
          <form
            onSubmit={(e) => void handleSubmit(e)}
            className="relative rounded-[22px] border px-4 pt-3 pb-2.5 transition-shadow"
            style={{
              background: 'var(--card)',
              borderColor: 'var(--border-strong)',
              boxShadow: 'var(--shadow-composer)',
            }}
          >
            {/* `@` 워크스페이스 파일·폴더 멘션 자동완성 팝오버 */}
            {mentionMenuOpen && (
              <div
                onClick={(e) => e.stopPropagation()}
                className="absolute bottom-full left-0 right-0 mb-2 rounded-2xl border p-1.5 z-50 max-h-64 overflow-y-auto scroll-thin"
                style={{
                  background: 'var(--card)',
                  borderColor: 'var(--border)',
                  boxShadow: 'var(--shadow-popover)',
                }}
              >
                <div
                  className="px-2.5 py-1 flex items-center justify-between text-[10.5px] font-semibold"
                  style={{ color: 'var(--muted)' }}
                >
                  <span>@ 파일 · 폴더 멘션 ({state.cwd.split('/').pop() || '/'})</span>
                  <span>↑↓ 선택 · Tab/Enter 삽입 · Esc 닫기</span>
                </div>
                {mentionItems.slice(0, 12).map((entry, idx) => {
                  const selected = idx === Math.min(mentionIndex, Math.min(mentionItems.length, 12) - 1);
                  return (
                    <button
                      key={entry.fullPath}
                      type="button"
                      onMouseEnter={() => setMentionIndex(idx)}
                      onClick={() => selectMentionItem(entry)}
                      className="w-full text-left px-2.5 py-1.5 rounded-xl flex items-center justify-between gap-3 text-xs cursor-pointer transition-colors"
                      style={{
                        background: selected ? 'var(--surface-active)' : undefined,
                        color: 'var(--fg)',
                      }}
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        {entry.isDir ? (
                          <Folder size={13} className="shrink-0" style={{ color: 'var(--accent)' }} />
                        ) : (
                          <FileText size={13} className="shrink-0" style={{ color: 'var(--muted)' }} />
                        )}
                        <span className="font-mono text-[12px] truncate">{entry.relPath}</span>
                      </div>
                      <span
                        className="text-[10px] px-1.5 py-0.5 rounded-md shrink-0"
                        style={{ background: 'var(--surface)', color: 'var(--muted)' }}
                      >
                        {entry.isDir ? '폴더' : '파일'}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}

            {/* 슬래시 명령어 · 설치된 스킬 자동완성 팝오버 */}
            {slashMenuOpen && (
              <div
                onClick={(e) => e.stopPropagation()}
                className="absolute bottom-full left-0 right-0 mb-2 rounded-2xl border p-1.5 z-50 max-h-64 overflow-y-auto scroll-thin"
                style={{
                  background: 'var(--card)',
                  borderColor: 'var(--border)',
                  boxShadow: 'var(--shadow-popover)',
                }}
              >
                <div
                  className="px-2.5 py-1 flex items-center justify-between text-[10.5px] font-semibold"
                  style={{ color: 'var(--muted)' }}
                >
                  <span>슬래시 명령어 · 스킬</span>
                  <span>↑↓ 선택 · Tab/Enter 입력 · Esc 닫기</span>
                </div>
                {filteredSlashItems.slice(0, 12).map((item, idx) => {
                  const selected = idx === Math.min(slashIndex, Math.min(filteredSlashItems.length, 12) - 1);
                  return (
                    <button
                      key={item.command}
                      type="button"
                      onMouseEnter={() => setSlashIndex(idx)}
                      onClick={() => selectSlashItem(item)}
                      className="w-full text-left px-2.5 py-1.5 rounded-xl flex items-center justify-between gap-3 text-xs cursor-pointer transition-colors"
                      style={{
                        background: selected ? 'var(--surface-active)' : undefined,
                        color: 'var(--fg)',
                      }}
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        {item.category === '스킬' && (
                          <Sparkles size={12} className="shrink-0" style={{ color: 'var(--accent)' }} />
                        )}
                        <span className="font-mono font-medium shrink-0">{item.command}</span>
                        <span className="truncate text-[11.5px]" style={{ color: 'var(--muted)' }}>
                          {item.description}
                        </span>
                      </div>
                      <span
                        className="text-[10px] px-1.5 py-0.5 rounded-md shrink-0"
                        style={{ background: 'var(--surface)', color: 'var(--muted)' }}
                      >
                        {item.category}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}

            {(attachedImages.length > 0 || (state.addDirs && state.addDirs.length > 0)) && (
              <div className="flex flex-wrap gap-1.5 mb-2">
                {(state.addDirs || []).map((dir) => (
                  <span
                    key={`dir:${dir}`}
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg text-[11px] font-mono"
                    style={{
                      background: 'color-mix(in srgb, var(--accent) 10%, var(--surface))',
                      color: 'var(--fg-soft)',
                    }}
                    title={`추가 컨텍스트 폴더 (--add-dir): ${dir}`}
                  >
                    <FolderPlus size={11} style={{ color: 'var(--accent)' }} />
                    <span>{dir.split('/').pop() || dir}</span>
                    <button
                      type="button"
                      onClick={() => handleRemoveAddDir(dir)}
                      className="cursor-pointer opacity-60 hover:opacity-100 ml-0.5"
                      title="추가 폴더 해제"
                    >
                      ✕
                    </button>
                  </span>
                ))}
                {attachedImages.map((img) => (
                  <span
                    key={img}
                    className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-lg text-[11px] font-mono"
                    style={{ background: 'var(--surface)', color: 'var(--fg-soft)' }}
                    title={img}
                  >
                    <Paperclip size={10} style={{ color: 'var(--muted)' }} />
                    <span>{img.split('/').pop()}</span>
                    <button
                      type="button"
                      onClick={() => setAttachedImages((prev) => prev.filter((x) => x !== img))}
                      className="cursor-pointer opacity-60 hover:opacity-100"
                      title="첨부 제거"
                    >
                      ✕
                    </button>
                  </span>
                ))}
              </div>
            )}

            <textarea
              ref={textareaRef}
              rows={1}
              spellCheck={false}
              value={input}
              onCompositionStart={(e) => {
                isComposingRef.current = true;
                compositionDataRef.current = e.data || '';
              }}
              onCompositionUpdate={(e) => {
                compositionDataRef.current = e.data || '';
              }}
              onCompositionEnd={(e) => {
                isComposingRef.current = false;
                compositionDataRef.current = '';
                if (Date.now() < postSubmitGuardUntilRef.current) {
                  setInput('');
                  if (textareaRef.current) textareaRef.current.value = '';
                  return;
                }
                setInput(e.currentTarget.value);
              }}
              onChange={(e) => {
                if (Date.now() < postSubmitGuardUntilRef.current) {
                  setInput('');
                  if (textareaRef.current) textareaRef.current.value = '';
                  return;
                }
                setInput(e.target.value);
              }}
              onPaste={handlePaste}
              onKeyDown={(e) => {
                // Ctrl+C cancels an active turn when nothing is selected (matches vanilla Antigravity)
                if (
                  isRunning &&
                  e.ctrlKey &&
                  !e.metaKey &&
                  !e.altKey &&
                  e.key.toLowerCase() === 'c' &&
                  !window.getSelection()?.toString()
                ) {
                  e.preventDefault();
                  void cancelTurn(sessionId);
                  return;
                }

                const composing =
                  e.nativeEvent.isComposing || e.keyCode === 229 || isComposingRef.current;
                const isEnterKey = e.key === 'Enter' || e.code === 'Enter';
                const currentVal = e.currentTarget.value;
                // Korean 2-beolsik has no candidate popup: allow single-Enter submission while Hangul composes
                const isHangulComposing =
                  composing &&
                  /[\u1100-\u11FF\u3130-\u318F\uAC00-\uD7A3]/.test(
                    compositionDataRef.current || currentVal.slice(-1)
                  );

                if (mentionMenuOpen && !composing) {
                  const visibleCount = Math.min(mentionItems.length, 12);
                  if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    setMentionIndex((i) => (i + 1) % visibleCount);
                    return;
                  }
                  if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    setMentionIndex((i) => (i - 1 + visibleCount) % visibleCount);
                    return;
                  }
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    setMentionDismissed(true);
                    return;
                  }
                  if (e.key === 'Tab' || (isEnterKey && !e.shiftKey && !e.metaKey && !e.ctrlKey)) {
                    const target = mentionItems[Math.min(mentionIndex, visibleCount - 1)];
                    if (target) {
                      e.preventDefault();
                      selectMentionItem(target);
                      return;
                    }
                  }
                }
                if (slashMenuOpen && !composing) {
                  const visibleCount = Math.min(filteredSlashItems.length, 12);
                  if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    setSlashIndex((i) => (i + 1) % visibleCount);
                    return;
                  }
                  if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    setSlashIndex((i) => (i - 1 + visibleCount) % visibleCount);
                    return;
                  }
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    setSlashDismissed(true);
                    return;
                  }
                  if (e.key === 'Tab' || (isEnterKey && !e.shiftKey && !e.metaKey && !e.ctrlKey)) {
                    const target = filteredSlashItems[Math.min(slashIndex, visibleCount - 1)];
                    if (target && currentVal.trim().toLowerCase() !== target.command.toLowerCase()) {
                      e.preventDefault();
                      selectSlashItem(target);
                      return;
                    }
                  }
                }
                if (isEnterKey && (!composing || isHangulComposing)) {
                  const wantCmd = cfg.sendKey === 'cmd-enter';
                  const isAltImmediate = isRunning && e.altKey && !e.shiftKey && !e.metaKey && !e.ctrlKey;
                  const isNormalSend =
                    (wantCmd && (e.metaKey || e.ctrlKey)) || (!wantCmd && !e.shiftKey && !e.altKey);
                  if (isAltImmediate || isNormalSend) {
                    e.preventDefault();
                    void handleSubmit(undefined, isAltImmediate ? 'immediate' : undefined);
                  }
                }
              }}
              placeholder={
                cfg.sendKey === 'cmd-enter'
                  ? '무엇이든 물어보세요, @로 멘션, /로 작업 실행 · Cmd+Enter 전송'
                  : '무엇이든 물어보세요, @로 멘션, /로 작업 실행'
              }
              className="w-full bg-transparent outline-none resize-none text-[14px] leading-relaxed"
              style={{ color: 'var(--fg)' }}
            />

            {/* 컴포저 내부 하단 컨트롤 바 */}
            <div className="mt-2 flex items-center justify-between gap-1.5 text-[12.5px] min-w-0">
              <div className="flex items-center gap-1 min-w-0 flex-1 relative">
                {/* + 컨텍스트 추가 메뉴 (순정 Antigravity 동일 구성) */}
                <div className="relative shrink-0">
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setModelMenuOpen(false);
                      setModeMenuOpen(false);
                      setPlusMenuOpen((v) => !v);
                    }}
                    className="p-1.5 rounded-full hover:bg-[var(--surface)] cursor-pointer transition-colors shrink-0"
                    style={{ color: 'var(--muted)' }}
                    title="컨텍스트 추가"
                    aria-label="컨텍스트 추가"
                  >
                    <Plus size={16} />
                  </button>

                  {plusMenuOpen && (
                    <div
                      onClick={(e) => e.stopPropagation()}
                      className="absolute bottom-full left-0 mb-2 w-52 rounded-2xl border p-1.5 z-50 space-y-0.5"
                      style={{
                        background: 'var(--card)',
                        borderColor: 'var(--border)',
                        boxShadow: 'var(--shadow-popover)',
                      }}
                    >
                      <div className="px-2.5 py-1 text-[11px] font-semibold" style={{ color: 'var(--muted)' }}>
                        컨텍스트 추가
                      </div>
                      <button
                        type="button"
                        onClick={() => void handlePickFiles()}
                        className="w-full text-left px-2.5 py-1.5 rounded-xl text-[13px] cursor-pointer hover:bg-[var(--surface)] flex items-center gap-2.5"
                        style={{ color: 'var(--fg)' }}
                      >
                        <Paperclip size={15} style={{ color: 'var(--muted)' }} />
                        <span>파일</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleAddExtraDir()}
                        className="w-full text-left px-2.5 py-1.5 rounded-xl text-[13px] cursor-pointer hover:bg-[var(--surface)] flex items-center gap-2.5"
                        style={{ color: 'var(--fg)' }}
                      >
                        <Folder size={15} style={{ color: 'var(--muted)' }} />
                        <span>폴더</span>
                      </button>
                      <button
                        type="button"
                        onClick={triggerMentionFromMenu}
                        className="w-full text-left px-2.5 py-1.5 rounded-xl text-[13px] cursor-pointer hover:bg-[var(--surface)] flex items-center gap-2.5"
                        style={{ color: 'var(--fg)' }}
                      >
                        <AtSign size={15} style={{ color: 'var(--muted)' }} />
                        <span>멘션</span>
                      </button>
                      <button
                        type="button"
                        onClick={triggerSlashFromMenu}
                        className="w-full text-left px-2.5 py-1.5 rounded-xl text-[13px] cursor-pointer hover:bg-[var(--surface)] flex items-center gap-2.5"
                        style={{ color: 'var(--fg)' }}
                      >
                        <SquareSlash size={15} style={{ color: 'var(--muted)' }} />
                        <span>작업</span>
                      </button>
                      <button
                        type="button"
                        onClick={triggerBrowserFromMenu}
                        className="w-full text-left px-2.5 py-1.5 rounded-xl text-[13px] cursor-pointer hover:bg-[var(--surface)] flex items-center gap-2.5"
                        style={{ color: 'var(--fg)' }}
                      >
                        <Globe size={15} style={{ color: 'var(--muted)' }} />
                        <span>브라우저</span>
                      </button>
                      <div className="border-t my-1" style={{ borderColor: 'var(--border)' }} />
                      <button
                        type="button"
                        onClick={() => void handlePickCwd()}
                        className="w-full text-left px-2.5 py-1.5 rounded-xl text-[12.5px] cursor-pointer hover:bg-[var(--surface)] flex items-center justify-between gap-2"
                        style={{ color: 'var(--fg)' }}
                      >
                        <span className="inline-flex items-center gap-2.5">
                          <FolderOpen size={14} style={{ color: 'var(--muted)' }} />
                          <span>작업 폴더 변경</span>
                        </span>
                        <span className="text-[11px] font-mono truncate max-w-[70px]" style={{ color: 'var(--accent)' }}>
                          {state.cwd.split('/').pop() || '/'}
                        </span>
                      </button>
                    </div>
                  )}
                </div>

                {/* 계층형 모델 선택 팝오버 (Antigravity 전체 모델 패밀리 + 티어 선택 + 사용량 보기) */}
                <div className="relative min-w-0">
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setModeMenuOpen(false);
                      setPlusMenuOpen(false);
                      setModelMenuOpen((prev) => {
                        const next = !prev;
                        if (next) {
                          setActiveFamilyId(activeModelFamily?.id || modelFamilies[0]?.id || null);
                          void refreshModels(false);
                        }
                        return next;
                      });
                    }}
                    className="inline-flex items-center gap-1 px-1.5 py-1 rounded-lg hover:bg-[var(--surface)] cursor-pointer transition-colors text-[12.5px] font-medium max-w-full min-w-0"
                    style={{ color: 'var(--fg-soft)' }}
                  >
                    <span className="truncate min-w-0">
                      {currentModelLabel}
                      {currentEffortSuffix}
                    </span>
                    <ChevronDown size={13} className="shrink-0" style={{ color: 'var(--muted)' }} />
                  </button>

                  {modelMenuOpen && (
                    <div
                      onClick={(e) => e.stopPropagation()}
                      className="absolute bottom-full left-0 mb-2 z-50 flex items-end"
                    >
                      <div
                        className="w-[300px] rounded-2xl border p-1.5"
                        style={{
                          background: 'var(--card)',
                          borderColor: 'var(--border)',
                          boxShadow: 'var(--shadow-popover)',
                        }}
                      >
                        <div className="px-2.5 py-1.5 flex items-center justify-between gap-2">
                          <span className="text-[11px] font-semibold" style={{ color: 'var(--muted)' }}>
                            모델
                          </span>
                          <div className="flex items-center gap-1">
                            <span className="text-[10px] font-mono" style={{ color: 'var(--muted)' }}>
                              {availableModels.length}개
                            </span>
                            <button
                              type="button"
                              onClick={() => void handleRefreshModels()}
                              className="p-1 rounded-md hover:bg-[var(--surface)] cursor-pointer"
                              style={{ color: 'var(--muted)' }}
                              title="agy models 목록 새로고침"
                              aria-label="모델 목록 새로고침"
                            >
                              <RefreshCw size={11} className={refreshingModels ? 'animate-spin' : ''} />
                            </button>
                          </div>
                        </div>

                        <div className="space-y-0.5 max-h-[360px] overflow-y-auto scroll-thin">
                          {modelFamilies.map((fam) => {
                            const activeVariant = fam.variants.find((v) => v.value === state.model);
                            const isSelectedFamily = Boolean(activeVariant);
                            const isExpanded = expandedFamily?.id === fam.id;
                            const hasMultiple = fam.variants.length > 1;
                            const shownTier =
                              activeVariant?.tierLabel ||
                              fam.variants.find((v) => v.value === fam.defaultVariantValue)?.tierLabel ||
                              '';

                            return (
                              <div key={fam.id} className="space-y-1">
                                <button
                                  type="button"
                                  onMouseEnter={() => {
                                    if (hasMultiple) setActiveFamilyId(fam.id);
                                    else setActiveFamilyId(null);
                                  }}
                                  onClick={() => {
                                    if (!hasMultiple) {
                                      requestSwitchModel(fam.defaultVariantValue);
                                    } else {
                                      setActiveFamilyId(fam.id);
                                    }
                                  }}
                                  className="w-full text-left px-2.5 py-1.5 rounded-xl text-[12.5px] cursor-pointer transition-colors flex items-center justify-between gap-2"
                                  style={{
                                    background: isExpanded
                                      ? 'var(--surface-active)'
                                      : isSelectedFamily
                                        ? 'var(--surface)'
                                        : undefined,
                                    color: 'var(--fg)',
                                  }}
                                >
                                  <div className="flex items-center gap-1.5 min-w-0">
                                    <span
                                      className="truncate"
                                      style={{ fontWeight: isSelectedFamily ? 600 : 450 }}
                                    >
                                      {fam.name}
                                    </span>
                                    {shownTier && (
                                      <span className="text-[11.5px] shrink-0" style={{ color: 'var(--muted)' }}>
                                        {shownTier}
                                      </span>
                                    )}
                                    {fam.badge && (
                                      <span
                                        className="text-[10px] px-1.5 py-[1px] rounded-full shrink-0"
                                        style={{
                                          background:
                                            fam.badge.tone === 'warn'
                                              ? 'color-mix(in srgb, var(--warn) 12%, var(--surface))'
                                              : 'var(--surface)',
                                          color: fam.badge.tone === 'warn' ? 'var(--warn)' : 'var(--muted)',
                                        }}
                                      >
                                        {fam.badge.label}
                                      </span>
                                    )}
                                  </div>
                                  <span className="shrink-0 flex items-center" style={{ color: 'var(--muted)' }}>
                                    {isSelectedFamily ? (
                                      <Check size={13} style={{ color: 'var(--fg)' }} />
                                    ) : hasMultiple ? (
                                      <ChevronRight size={13} />
                                    ) : null}
                                  </span>
                                </button>

                                {/* 좁은 분할 창(<520px)용 인라인 티어 선택 바 */}
                                {hasMultiple && isExpanded && (
                                  <div className="flex @[520px]:hidden flex-wrap gap-1 px-2.5 pb-1.5">
                                    {fam.variants.map((v) => {
                                      const active = state.model === v.value;
                                      return (
                                        <button
                                          key={v.value}
                                          type="button"
                                          onClick={() => requestSwitchModel(v.value)}
                                          className="px-2 py-0.5 rounded-md text-[11px] cursor-pointer transition-colors"
                                          style={{
                                            background: active ? 'var(--fg)' : 'var(--surface)',
                                            color: active ? 'var(--bg)' : 'var(--fg-soft)',
                                            fontWeight: active ? 600 : 400,
                                          }}
                                        >
                                          {v.tierLabel || v.rawLabel}
                                        </button>
                                      );
                                    })}
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>

                        <div className="border-t mt-1.5 pt-1.5" style={{ borderColor: 'var(--border)' }}>
                          <button
                            type="button"
                            onClick={() => {
                              setModelMenuOpen(false);
                              void ctx.commands.execute('settings:open', 'agent-agy-settings');
                            }}
                            className="w-full text-left px-2.5 py-1.5 rounded-xl text-[12px] cursor-pointer hover:bg-[var(--surface)] flex items-center justify-between gap-2"
                            style={{ color: 'var(--fg-soft)' }}
                          >
                            <span className="inline-flex items-center gap-2">
                              <BarChart3 size={13} style={{ color: 'var(--muted)' }} />
                              <span>사용량 보기</span>
                            </span>
                            <ChevronRight size={13} style={{ color: 'var(--muted)' }} />
                          </button>
                        </div>
                      </div>

                      {/* 데스크톱 너비(>=520px)용 우측 티어 서브메뉴 */}
                      {expandedFamily && expandedFamily.variants.length > 1 && (
                        <div
                          className="hidden @[520px]:block ml-1.5 w-44 rounded-2xl border p-1.5 space-y-0.5"
                          style={{
                            background: 'var(--card)',
                            borderColor: 'var(--border)',
                            boxShadow: 'var(--shadow-popover)',
                          }}
                        >
                          <div className="px-2.5 py-1">
                            <div className="text-[11px] font-semibold truncate" style={{ color: 'var(--fg)' }}>
                              {expandedFamily.name}
                            </div>
                            <div className="text-[10px]" style={{ color: 'var(--muted)' }}>
                              {expandedFamily.id === 'orchestrator' ? '백엔드 모델 선택' : '추론 강도 선택'}
                            </div>
                          </div>
                          {expandedFamily.variants.map((v) => {
                            const active = state.model === v.value;
                            return (
                              <button
                                key={v.value}
                                type="button"
                                onClick={() => requestSwitchModel(v.value)}
                                className="w-full text-left px-2.5 py-1.5 rounded-xl text-xs cursor-pointer transition-colors hover:bg-[var(--surface)] flex items-center justify-between gap-2"
                                style={{
                                  background: active ? 'var(--surface-active)' : undefined,
                                  fontWeight: active ? 600 : 400,
                                  color: 'var(--fg)',
                                }}
                              >
                                <span className="truncate">{v.tierLabel || v.rawLabel}</span>
                                {active && <Check size={12} className="shrink-0" />}
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* 작업 폴더 칩 */}
                <button
                  type="button"
                  onClick={() => void handlePickCwd()}
                  className="hidden @[430px]:inline-flex items-center gap-1 px-2 py-1 rounded-lg hover:bg-[var(--surface)] cursor-pointer text-[11.5px] font-mono truncate max-w-[130px] shrink-0"
                  style={{ color: 'var(--muted)' }}
                  title={state.cwd}
                >
                  <FolderOpen size={12} />
                  <span className="truncate">{state.cwd.split('/').pop() || '/'}</span>
                </button>

                {/* 동적 플러그인 슬롯: chat:composer-badge (런타임 자산 배지, 외부 로컬 타이머 배지 등) */}
                <div className="hidden @[480px]:flex items-center gap-1 shrink-0">
                  <SlotOutlet
                    slotId="pane.widget"
                    targetPaneType="chat"
                    anchor={PANE_WIDGET_ANCHORS.CHAT_COMPOSER_BADGE}
                    groupId={groupId}
                    tab={tab}
                    compactError={true}
                  />
                </div>
              </div>

              <div className="flex items-center gap-1 shrink-0">
                {/* 실행 모드 버튼 */}
                <div className="relative">
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setModelMenuOpen(false);
                      setPlusMenuOpen(false);
                      setModeMenuOpen((v) => !v);
                    }}
                    className="inline-flex items-center gap-1 px-2 py-1 rounded-lg hover:bg-[var(--surface)] cursor-pointer text-[12.5px]"
                    style={{ color: 'var(--muted)' }}
                    title={`실행 모드: ${currentModeLabel}`}
                  >
                    <Shield size={12} />
                    <span className="hidden @[340px]:inline">{currentModeLabel}</span>
                    <ChevronDown size={12} />
                  </button>

                  {modeMenuOpen && (
                    <div
                      onClick={(e) => e.stopPropagation()}
                      className="absolute bottom-full right-0 mb-2 w-48 rounded-xl border p-1.5 z-50 space-y-0.5"
                      style={{
                        background: 'var(--card)',
                        borderColor: 'var(--border)',
                        boxShadow: 'var(--shadow-popover)',
                      }}
                    >
                      {MODE_OPTIONS.map((m) => (
                        <button
                          key={m.value}
                          type="button"
                          onClick={() => {
                            updateState({ mode: m.value });
                            setModeMenuOpen(false);
                          }}
                          className="w-full text-left px-2.5 py-1.5 rounded-lg text-xs cursor-pointer hover:bg-[var(--surface)] flex items-center justify-between gap-2"
                          style={{
                            background: state.mode === m.value ? 'var(--surface-active)' : undefined,
                            fontWeight: state.mode === m.value ? 600 : 400,
                          }}
                        >
                          <div>
                            <div>{m.label}</div>
                            <div className="text-[10.5px] font-normal" style={{ color: 'var(--muted)' }}>
                              {m.desc}
                            </div>
                          </div>
                          {state.mode === m.value && <Check size={12} className="shrink-0" />}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                {isRunning && !input.trim() ? (
                  <button
                    type="button"
                    onClick={() => void cancelTurn(sessionId)}
                    className="w-7 h-7 rounded-full flex items-center justify-center cursor-pointer transition-opacity hover:opacity-85"
                    style={{ background: 'var(--surface)' }}
                    title="응답 중지 (⌃C)"
                    aria-label="응답 중지 (⌃C)"
                  >
                    <span className="w-2.5 h-2.5 rounded-[2px]" style={{ background: '#ef4444' }} />
                  </button>
                ) : (
                  <button
                    type="submit"
                    disabled={!input.trim() || !adapterAvailable}
                    className="w-7 h-7 rounded-full flex items-center justify-center cursor-pointer transition-all disabled:opacity-35 hover:opacity-90"
                    style={{ background: 'var(--accent)', color: '#fff' }}
                    title={isRunning ? '대기열에 추가 (Enter · ⌥Enter 즉시 전송)' : '전송 (Enter)'}
                    aria-label={isRunning ? '대기열에 추가' : '전송'}
                  >
                    <ArrowRight size={15} strokeWidth={2.2} />
                  </button>
                )}
              </div>
            </div>
          </form>

          {/* 동적 플러그인 슬롯: chat:footer */}
          <SlotOutlet
            slotId="pane.widget"
            targetPaneType="chat"
            anchor={PANE_WIDGET_ANCHORS.CHAT_FOOTER}
            groupId={groupId}
            tab={tab}
          />
        </div>
      </div>
    </div>
  );
};
