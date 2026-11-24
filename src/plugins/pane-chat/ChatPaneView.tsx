import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  ChevronDown,
  ChevronRight,
  Columns2,
  Copy,
  FolderOpen,
  Globe,
  KeyRound,
  MessageSquare,
  Minimize2,
  Plus,
  Rows2,
  Shield,
  Square,
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
import type { ChatMessage, ChatMode, SessionMetrics, ToolCallItem } from '../../shared/types';
import { fmtAgo, fmtKo } from '../../utils/formatKo';
import { AGY_RPC, type AgyLoadedSession } from '../agent-agy/types';
import { useChatSessionStore, type ChatTabState } from './chatStore';
import type { PaneChatConfig } from './manifest';
import { renderSanitizedMarkdown } from './sanitizeMarkdown';

const EMPTY_MESSAGES: ChatMessage[] = [];
const EMPTY_QUEUE: Array<{ prompt: string; images?: string[] }> = [];

const EFFORT_OPTIONS = [
  { value: 'default', label: '기본' },
  { value: 'low', label: '낮음' },
  { value: 'medium', label: '보통' },
  { value: 'high', label: '높음' },
  { value: 'xhigh', label: '매우 높음' },
];

const MODE_OPTIONS: Array<{ value: ChatMode; label: string; desc: string }> = [
  { value: 'turbo', label: '터보', desc: '모든 도구 자동 실행' },
  { value: 'accept-edits', label: '편집 허용', desc: '파일 편집 자동 허용' },
  { value: 'plan', label: '계획', desc: '읽기·계획 전용' },
  { value: 'strict', label: '엄격', desc: '샌드박스 제한 실행' },
];

const ToolGroupDisclosure: React.FC<{ tools: ToolCallItem[]; defaultOpen?: boolean }> = ({
  tools,
  defaultOpen = false,
}) => {
  const [open, setOpen] = useState(defaultOpen);
  useEffect(() => {
    setOpen(defaultOpen);
  }, [defaultOpen]);
  const running = tools.some((t) => t.status === 'running');
  return (
    <div className="mb-1.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 text-[12.5px] cursor-pointer transition-opacity hover:opacity-100 opacity-75"
        style={{ color: 'var(--muted)' }}
      >
        <span>{running ? `도구 실행 중 (${tools.length}개)` : `도구 ${tools.length}회 실행`}</span>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
      </button>
      {open && (
        <div className="mt-1.5 pl-3 border-l space-y-1.5 text-[12px]" style={{ borderColor: 'var(--border)' }}>
          {tools.map((t) => (
            <div key={t.id} className="space-y-1">
              <div className="flex items-center gap-2 font-mono text-[11.5px]">
                <span className="font-semibold" style={{ color: 'var(--fg-soft)' }}>
                  {t.name}
                </span>
                {t.argsSummary && (
                  <span className="truncate" style={{ color: 'var(--muted)' }}>
                    {t.argsSummary}
                  </span>
                )}
              </div>
              {t.outputPreview && (
                <pre
                  className="p-2 rounded-lg text-[11px] font-mono overflow-x-auto max-h-28 whitespace-pre-wrap"
                  style={{ background: 'var(--sidebar)', color: 'var(--muted)' }}
                >
                  {t.outputPreview}
                </pre>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

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
  const errorText = useChatSessionStore((s) => s.errorsBySession[sessionId]);
  const adapterAvailable = useChatSessionStore((s) => s.adapterAvailable);
  const availableModels = useChatSessionStore((s) => s.availableModels);
  const sendPrompt = useChatSessionStore((s) => s.sendPrompt);
  const clearQueuedPrompts = useChatSessionStore((s) => s.clearQueuedPrompts);
  const cancelTurn = useChatSessionStore((s) => s.cancelTurn);
  const submitAuthCode = useChatSessionStore((s) => s.submitAuthCode);
  const hydrateSession = useChatSessionStore((s) => s.hydrateSession);
  const setSessionMetrics = useChatSessionStore((s) => s.setSessionMetrics);

  const groups = useLayoutStore((s) => s.groups);
  const splitGroup = useLayoutStore((s) => s.splitGroup);
  const addTabToGroup = useLayoutStore((s) => s.addTabToGroup);
  const closeSplitPane = useLayoutStore((s) => s.closeSplitPane);
  const registeredPaneTypes = useSlotRegistry((s) => s.paneTypes);
  const contextMenuContribs = useSlotRegistry((s) => s.bySlot['context-menu.item']);

  const [input, setInput] = useState(state.initialPrompt || '');
  const [authCode, setAuthCode] = useState('');
  const [attachedImages, setAttachedImages] = useState<string[]>([]);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [modeMenuOpen, setModeMenuOpen] = useState(false);
  const [pendingSwitch, setPendingSwitch] = useState<{ field: 'model' | 'effort'; value: string } | null>(null);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

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

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, messages[messages.length - 1]?.text]);

  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(160, Math.max(24, ta.scrollHeight))}px`;
  }, [input]);

  useEffect(() => {
    if (!modelMenuOpen && !modeMenuOpen) return;
    const onClick = () => {
      setModelMenuOpen(false);
      setModeMenuOpen(false);
    };
    window.addEventListener('click', onClick);
    return () => window.removeEventListener('click', onClick);
  }, [modelMenuOpen, modeMenuOpen]);

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

  // Independent `warnOnCacheReset` — works even when `hud-token-bar` plugin is OFF (mandatory fix c)
  const requestSwitch = (field: 'model' | 'effort', value: string) => {
    setModelMenuOpen(false);
    if (value === state[field]) return;
    const ctxTokens = metrics?.currentContext ?? 0;
    if (cfg.warnOnCacheReset !== false && ctxTokens > 5000) {
      setPendingSwitch({ field, value });
    } else {
      updateState({ [field]: value } as Partial<ChatTabState>);
    }
  };

  const handlePickCwd = async () => {
    try {
      const dir = await ctx.rpc.invoke<string | null>('pane-chat:pickDirectory');
      if (dir) updateState({ cwd: dir });
    } catch {
      // ignore
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

  const handleSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const text = input.trim();
    if (!text) return;
    setInput('');
    const imgs = [...attachedImages];
    setAttachedImages([]);
    await sendPrompt(groupId, tab.id, state, text, imgs);
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

  const renderedMessages = useMemo(
    () =>
      messages.map((m) => ({
        ...m,
        html: m.role === 'assistant' ? renderSanitizedMarkdown(m.text) : '',
      })),
    [messages]
  );

  const colMaxWidthClass =
    cfg.chatWidth === 'wide' ? 'max-w-none' : cfg.chatWidth === 'medium' ? 'max-w-[900px]' : 'max-w-[740px]';

  const currentModelLabel = availableModels.find((m) => m.value === state.model)?.label || state.model;
  const currentEffortSuffix =
    state.effort && state.effort !== 'default'
      ? ` · ${EFFORT_OPTIONS.find((e) => e.value === state.effort)?.label || state.effort}`
      : '';
  const currentModeLabel =
    MODE_OPTIONS.find((m) => m.value === state.mode)?.label || (state.mode === 'auto' ? '터보' : '터보');
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

          {renderedMessages.length === 0 ? (
            <div className="pt-20 pb-8 flex flex-col items-center text-center gap-2">
              <div className="text-[20px] font-semibold tracking-tight" style={{ color: 'var(--fg)' }}>
                무엇을 작업할까요?
              </div>
              <div className="text-[13px] max-w-md leading-relaxed" style={{ color: 'var(--muted)' }}>
                각 채팅은 독립된 <code>agy</code> 세션으로 돌아갑니다. 상단 분할 버튼으로 플러그인 스튜디오·웹뷰·터미널을 옆에 자유롭게 띄워둘 수 있습니다.
              </div>
            </div>
          ) : (
            renderedMessages.map((m) =>
              m.role === 'user' ? (
                <div key={m.id} className="flex justify-end">
                  <div
                    className="max-w-[78%] rounded-[20px] px-4 py-2.5 leading-relaxed whitespace-pre-wrap break-words"
                    style={{
                      fontSize: 'var(--chat-font-size, 14px)',
                      background: 'var(--surface)',
                      color: 'var(--fg)',
                      boxShadow: 'var(--shadow-sm)',
                    }}
                  >
                    {m.images && m.images.length > 0 && (
                      <div className="flex flex-wrap gap-1.5 mb-1.5">
                        {m.images.map((img) => (
                          <span
                            key={img}
                            className="text-[11px] font-mono px-2 py-0.5 rounded-md"
                            style={{ background: 'var(--card)', color: 'var(--muted)' }}
                          >
                            {img.split('/').pop()}
                          </span>
                        ))}
                      </div>
                    )}
                    {m.text}
                  </div>
                </div>
              ) : !m.streaming && !m.text && !m.thinking && (!m.tools || m.tools.length === 0) ? null : (
                <div key={m.id} className="space-y-1.5">
                  {m.thinking && cfg.transcriptView !== 'normal' && (
                    <details
                      open={cfg.transcriptView === 'detailed'}
                      className="text-[12.5px] mb-1"
                      style={{ color: 'var(--muted)' }}
                    >
                      <summary className="cursor-pointer select-none opacity-75 hover:opacity-100">
                        생각 과정
                      </summary>
                      <div
                        className="mt-1.5 pl-3 border-l whitespace-pre-wrap text-[12.5px] leading-relaxed"
                        style={{ borderColor: 'var(--border)' }}
                      >
                        {m.thinking}
                      </div>
                    </details>
                  )}

                  {m.tools && m.tools.length > 0 && (
                    <ToolGroupDisclosure tools={m.tools} defaultOpen={cfg.transcriptView === 'detailed'} />
                  )}

                  {m.text ? (
                    <div className="md-prose break-words" dangerouslySetInnerHTML={{ __html: m.html }} />
                  ) : m.streaming ? (
                    <div className="text-[13px] animate-pulse" style={{ color: 'var(--muted)' }}>
                      응답 작성 중…
                    </div>
                  ) : null}

                  {!m.streaming && m.createdAt > 0 && (
                    <div className="pt-1 text-[11px]" style={{ color: 'var(--muted)' }}>
                      {fmtAgo(m.createdAt)}
                    </div>
                  )}
                </div>
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

      {/* 하단 플로팅 영역: 배너 + 동적 위젯 슬롯(chat:above-composer) + 컴포저 + 동적 풋터 슬롯 */}
      <div className="shrink-0 w-full">
        <div className={`${colMaxWidthClass} mx-auto w-full px-5 pb-4 pt-1 space-y-2.5`}>
          {queuedPrompts.length > 0 && (
            <div
              className="rounded-xl border px-3.5 py-2 flex items-center justify-between gap-2 text-xs"
              style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}
            >
              <span className="truncate" style={{ color: 'var(--fg-soft)' }}>
                대기열 {queuedPrompts.length}건: <strong className="font-medium">{queuedPrompts[0].prompt}</strong>
              </span>
              <button
                type="button"
                onClick={() => clearQueuedPrompts(sessionId)}
                className="text-[11px] px-2 py-0.5 rounded hover:bg-[var(--card)] cursor-pointer shrink-0"
                style={{ color: 'var(--muted)' }}
              >
                비우기
              </button>
            </div>
          )}

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
                  {pendingSwitch.field === 'model' ? '모델' : 'Effort'}을 바꾸면 이 대화 캐시(
                  <strong>{fmtKo(metrics?.currentContext)}</strong>)가 다음 전송 때 0%로 초기화됩니다.
                </span>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  type="button"
                  onClick={() => {
                    updateState({ [pendingSwitch.field]: pendingSwitch.value } as Partial<ChatTabState>);
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

          {/* 플로팅 컴포저 카드 */}
          <form
            onSubmit={(e) => void handleSubmit(e)}
            className="rounded-[22px] border px-4 pt-3 pb-2.5 transition-shadow"
            style={{
              background: 'var(--card)',
              borderColor: 'var(--border-strong)',
              boxShadow: 'var(--shadow-composer)',
            }}
          >
            {attachedImages.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mb-2">
                {attachedImages.map((img) => (
                  <span
                    key={img}
                    className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-lg text-[11px] font-mono"
                    style={{ background: 'var(--surface)', color: 'var(--fg-soft)' }}
                  >
                    {img.split('/').pop()}
                    <button
                      type="button"
                      onClick={() => setAttachedImages((prev) => prev.filter((x) => x !== img))}
                      className="cursor-pointer opacity-60 hover:opacity-100"
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
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                  const wantCmd = cfg.sendKey === 'cmd-enter';
                  if ((wantCmd && (e.metaKey || e.ctrlKey)) || (!wantCmd && !e.shiftKey)) {
                    e.preventDefault();
                    void handleSubmit();
                  }
                }
              }}
              placeholder={
                cfg.sendKey === 'cmd-enter'
                  ? '무엇이든 물어보세요 · Cmd+Enter 전송 · /compact'
                  : '무엇이든 물어보세요 · /compact · 파일 드래그 첨부'
              }
              className="w-full bg-transparent outline-none resize-none text-[14px] leading-relaxed"
              style={{ color: 'var(--fg)' }}
            />

            {/* 컴포저 내부 하단 컨트롤 바 */}
            <div className="mt-2 flex items-center justify-between gap-1.5 text-[12.5px] min-w-0">
              <div className="flex items-center gap-1 min-w-0 flex-1 relative">
                <button
                  type="button"
                  onClick={() => void handlePickCwd()}
                  className="p-1.5 rounded-full hover:bg-[var(--surface)] cursor-pointer transition-colors shrink-0"
                  style={{ color: 'var(--muted)' }}
                  title={`작업 폴더 변경 (${state.cwd})`}
                >
                  <Plus size={16} />
                </button>

                {/* 모델/Effort 팝오버 */}
                <div className="relative min-w-0">
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setModeMenuOpen(false);
                      setModelMenuOpen((v) => !v);
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
                      className="absolute bottom-full left-0 mb-2 w-64 rounded-2xl border p-2 z-50 space-y-2"
                      style={{
                        background: 'var(--card)',
                        borderColor: 'var(--border)',
                        boxShadow: 'var(--shadow-popover)',
                      }}
                    >
                      <div className="space-y-0.5 max-h-52 overflow-y-auto scroll-thin">
                        <div className="px-2 py-1 text-[10.5px] font-semibold" style={{ color: 'var(--muted)' }}>
                          모델
                        </div>
                        {availableModels.map((m) => (
                          <button
                            key={m.value}
                            type="button"
                            onClick={() => requestSwitch('model', m.value)}
                            className="w-full text-left px-2.5 py-1.5 rounded-lg text-xs cursor-pointer transition-colors hover:bg-[var(--surface)] truncate"
                            style={{
                              background: state.model === m.value ? 'var(--surface-active)' : undefined,
                              fontWeight: state.model === m.value ? 600 : 400,
                            }}
                          >
                            {m.label}
                          </button>
                        ))}
                      </div>
                      <div className="border-t pt-2" style={{ borderColor: 'var(--border)' }}>
                        <div className="px-2 pb-1.5 text-[10.5px] font-semibold" style={{ color: 'var(--muted)' }}>
                          Effort (변경 시 캐시 초기화)
                        </div>
                        <div className="flex flex-wrap gap-1 px-1">
                          {EFFORT_OPTIONS.map((ef) => (
                            <button
                              key={ef.value}
                              type="button"
                              onClick={() => requestSwitch('effort', ef.value)}
                              className="px-2 py-1 rounded-md text-[11px] cursor-pointer transition-colors"
                              style={{
                                background: state.effort === ef.value ? 'var(--fg)' : 'var(--surface)',
                                color: state.effort === ef.value ? 'var(--bg)' : 'var(--fg-soft)',
                              }}
                            >
                              {ef.label}
                            </button>
                          ))}
                        </div>
                      </div>
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
                      className="absolute bottom-full right-0 mb-2 w-44 rounded-xl border p-1.5 z-50 space-y-0.5"
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
                          className="w-full text-left px-2.5 py-1.5 rounded-lg text-xs cursor-pointer hover:bg-[var(--surface)]"
                          style={{
                            background:
                              state.mode === m.value || (state.mode === 'auto' && m.value === 'turbo')
                                ? 'var(--surface-active)'
                                : undefined,
                            fontWeight:
                              state.mode === m.value || (state.mode === 'auto' && m.value === 'turbo') ? 600 : 400,
                          }}
                        >
                          <div>{m.label}</div>
                          <div className="text-[10.5px]" style={{ color: 'var(--muted)' }}>
                            {m.desc}
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                {isRunning ? (
                  <button
                    type="button"
                    onClick={() => void cancelTurn(sessionId)}
                    className="w-8 h-8 rounded-full flex items-center justify-center cursor-pointer transition-opacity hover:opacity-90"
                    style={{ background: 'var(--danger)', color: '#fff' }}
                    title="응답 중지"
                  >
                    <Square size={12} fill="currentColor" />
                  </button>
                ) : (
                  <button
                    type="submit"
                    disabled={!input.trim() || !adapterAvailable}
                    className="w-8 h-8 rounded-full flex items-center justify-center cursor-pointer transition-opacity disabled:opacity-35 hover:opacity-90"
                    style={{ background: 'var(--accent)', color: '#fff' }}
                    title="전송 (Enter)"
                  >
                    <ArrowRight size={16} strokeWidth={2.2} />
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
