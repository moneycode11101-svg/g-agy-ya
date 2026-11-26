import { create } from 'zustand';
import {
  agentRpc,
  type AgentModelOption,
  type ClientAgentAdapterDescriptor,
} from '../../shared/agentProtocol';
import type {
  AccountQuotaSnapshot,
  AgentEvent,
  AuthPrompt,
  ChatBlock,
  ChatMessage,
  ChatMode,
  PermissionPrompt,
  QuestionPrompt,
  SessionMetrics,
} from '../../shared/types';
import { FALLBACK_AGY_MODELS } from '../agent-agy/types';
import { FALLBACK_CLAUDE_MODELS } from '../agent-claude/types';
import { FALLBACK_CODEX_MODELS } from '../agent-codex/types';

function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function closeOpenThinkingBlocks(blocks: ChatBlock[], now: number): ChatBlock[] {
  let changed = false;
  const next = blocks.map((b) => {
    if (b.type === 'thinking' && !b.endedAt) {
      changed = true;
      return { ...b, endedAt: now };
    }
    return b;
  });
  return changed ? next : blocks;
}

const DEFAULT_FALLBACK_MODELS_BY_ADAPTER: Record<string, AgentModelOption[]> = {
  'agent-agy': FALLBACK_AGY_MODELS,
  'agent-claude': FALLBACK_CLAUDE_MODELS,
  'agent-codex': FALLBACK_CODEX_MODELS,
};

export interface QueuedPromptItem {
  id: string;
  prompt: string;
  images?: string[];
}

export interface ChatTabState extends Record<string, unknown> {
  sessionId: string;
  adapterId: string;
  externalSessionId: string | null;
  agyConversationId: string | null;
  cwd: string;
  addDirs?: string[];
  projectLabel?: string;
  model: string;
  effort: string;
  mode: ChatMode;
  source?: 'cli' | 'app' | 'new';
  initialPrompt?: string;
}

export interface ChatRuntimeBridgeCallbacks {
  invokeRpc: <TRes = unknown>(method: string, payload?: unknown) => Promise<TRes>;
  getPendingMessageMode: () => 'queue' | 'immediate';
  updateTabStateBySession: (tabSessionId: string, patch: Partial<ChatTabState>) => void;
  updateTabTitleIfDefault: (groupId: string, tabId: string, prompt: string) => void;
  updateTabTitleBySession: (tabSessionId: string, title: string) => void;
  findTabBySessionId: (tabSessionId: string) => { groupId: string; tabId: string; state: ChatTabState } | null;
}

export interface ChatSessionStoreState {
  messagesBySession: Record<string, ChatMessage[]>;
  metricsBySession: Record<string, SessionMetrics>;
  runningSessions: Record<string, boolean>;
  queuedPromptsBySession: Record<string, QueuedPromptItem[]>;
  authPrompts: Record<string, AuthPrompt>;
  permissionPrompts: Record<string, PermissionPrompt>;
  questionPrompts: Record<string, QuestionPrompt>;
  noticesBySession: Record<string, Array<{ id: string; level: 'info' | 'warn' | 'error'; text: string }>>;
  errorsBySession: Record<string, string>;
  /** Legacy mirror of `accountQuotaByAdapter['agent-agy']` for backward compat */
  accountQuota: AccountQuotaSnapshot | null;
  accountQuotaByAdapter: Record<string, AccountQuotaSnapshot>;
  loadingQuota: boolean;
  adapterAvailable: boolean;
  availableAdapters: ClientAgentAdapterDescriptor[];
  /** Legacy mirror of `availableModelsByAdapter['agent-agy']` */
  availableModels: AgentModelOption[];
  availableModelsByAdapter: Record<string, AgentModelOption[]>;
  availableCommands: Array<{ name: string; description: string }>;
  callbacks: ChatRuntimeBridgeCallbacks | null;

  setCallbacks: (cbs: ChatRuntimeBridgeCallbacks | null) => void;
  setAdapterAvailable: (available: boolean) => void;
  setAvailableAdapters: (adapters: ClientAgentAdapterDescriptor[]) => void;
  setAccountQuota: (snap: AccountQuotaSnapshot, adapterId?: string) => void;
  refreshAccountQuota: (force?: boolean, adapterId?: string) => Promise<void>;
  refreshModels: (force?: boolean, adapterId?: string) => Promise<void>;

  hydrateSession: (tabSessionId: string, messages: ChatMessage[], metrics?: SessionMetrics | null) => void;
  setSessionMetrics: (tabSessionId: string, metrics: SessionMetrics) => void;
  sendPrompt: (
    groupId: string,
    tabId: string,
    state: ChatTabState,
    prompt: string,
    images?: string[],
    delivery?: 'queue' | 'immediate'
  ) => Promise<void>;
  removeQueuedPrompt: (tabSessionId: string, queueId: string) => void;
  updateQueuedPrompt: (tabSessionId: string, queueId: string, nextPrompt: string) => void;
  sendQueuedNow: (groupId: string, tabId: string, state: ChatTabState, queueId: string) => Promise<void>;
  clearQueuedPrompts: (tabSessionId: string) => void;
  cancelTurn: (tabSessionId: string, adapterIdOverride?: string) => Promise<void>;
  submitAuthCode: (tabSessionId: string, code: string) => Promise<void>;
  startCliLogin: (tabSessionId: string, methodId?: string) => Promise<{ ok: boolean; error?: string }>;
  cancelCliLogin: (tabSessionId: string) => Promise<void>;
  dismissAuthPrompt: (tabSessionId: string) => void;
  respondPermission: (tabSessionId: string, requestId: string, optionId: string | null) => Promise<void>;
  respondQuestion: (
    tabSessionId: string,
    requestId: string,
    answers: Record<string, string | string[]> | null
  ) => Promise<void>;
  dismissNotice: (tabSessionId: string, noticeId: string) => void;
  handleAgyEvent: (ev: AgentEvent) => void;
  handleAgentEvent: (ev: AgentEvent) => void;
  cleanupSession: (tabSessionId: string) => void;
}

function resolveAdapterForSession(
  cbs: ChatRuntimeBridgeCallbacks | null,
  tabSessionId: string,
  override?: string
): string {
  if (override) return override;
  const tab = cbs?.findTabBySessionId(tabSessionId);
  return tab?.state?.adapterId || 'agent-agy';
}

/**
 * Multi-adapter session & streaming store owned by `pane-chat`.
 * Dynamically routes RPCs to `agent-agy`, `agent-claude`, or `agent-codex` via `adapterId`.
 */
export const useChatSessionStore = create<ChatSessionStoreState>((set, get) => ({
  messagesBySession: {},
  metricsBySession: {},
  runningSessions: {},
  queuedPromptsBySession: {},
  authPrompts: {},
  permissionPrompts: {},
  questionPrompts: {},
  noticesBySession: {},
  errorsBySession: {},
  accountQuota: null,
  accountQuotaByAdapter: {},
  loadingQuota: false,
  adapterAvailable: true,
  availableAdapters: [],
  availableModels: FALLBACK_AGY_MODELS,
  availableModelsByAdapter: { ...DEFAULT_FALLBACK_MODELS_BY_ADAPTER },
  availableCommands: [],
  callbacks: null,

  setCallbacks: (callbacks) => set({ callbacks }),
  setAdapterAvailable: (adapterAvailable) => set({ adapterAvailable }),

  setAvailableAdapters: (adapters) =>
    set((prev) => {
      const nextModels = { ...prev.availableModelsByAdapter };
      for (const a of adapters) {
        if (!nextModels[a.id] && a.fallbackModels?.length) {
          nextModels[a.id] = [...a.fallbackModels];
        }
      }
      return {
        availableAdapters: adapters,
        adapterAvailable: adapters.length > 0,
        availableModelsByAdapter: nextModels,
      };
    }),

  setAccountQuota: (snap, adapterId) => {
    const id = adapterId || snap?.adapterId || 'agent-agy';
    if (!snap) return;
    set((prev) => {
      const hasBuckets = snap.buckets.length > 0;
      const existing = prev.accountQuotaByAdapter[id];
      if (!hasBuckets && existing && existing.buckets.length > 0) return prev;
      return {
        accountQuotaByAdapter: { ...prev.accountQuotaByAdapter, [id]: { ...snap, adapterId: id } },
        ...(id === 'agent-agy' && hasBuckets ? { accountQuota: snap } : {}),
      };
    });
  },

  refreshAccountQuota: async (force = false, adapterId = 'agent-agy') => {
    const cbs = get().callbacks;
    if (!cbs) return;
    set({ loadingQuota: true });
    try {
      const snap = await cbs.invokeRpc<AccountQuotaSnapshot>(agentRpc(adapterId, 'quota.get'), { force });
      if (snap) {
        get().setAccountQuota(snap, adapterId);
      }
    } catch {
      // adapter may be disabled
    } finally {
      set({ loadingQuota: false });
    }
  },

  refreshModels: async (force = false, adapterId = 'agent-agy') => {
    const cbs = get().callbacks;
    if (!cbs) return;
    try {
      const models = await cbs.invokeRpc<AgentModelOption[]>(agentRpc(adapterId, 'models.list'), { force });
      if (Array.isArray(models) && models.length > 0) {
        set((prev) => ({
          availableModelsByAdapter: { ...prev.availableModelsByAdapter, [adapterId]: models },
          ...(adapterId === 'agent-agy' ? { availableModels: models } : {}),
        }));
      }
    } catch {
      // keep fallback models
    }
  },

  hydrateSession: (tabSessionId, messages, metrics) => {
    set((prev) => ({
      messagesBySession: prev.messagesBySession[tabSessionId]?.length
        ? prev.messagesBySession
        : { ...prev.messagesBySession, [tabSessionId]: messages },
      metricsBySession: metrics
        ? { ...prev.metricsBySession, [tabSessionId]: metrics }
        : prev.metricsBySession,
    }));
  },

  setSessionMetrics: (tabSessionId, metrics) => {
    set((prev) => ({
      metricsBySession: { ...prev.metricsBySession, [tabSessionId]: metrics },
    }));
  },

  sendPrompt: async (groupId, tabId, state, prompt, images, delivery) => {
    const trimmed = prompt.trim();
    const hasImages = Array.isArray(images) && images.length > 0;
    if (!trimmed && !hasImages) return;
    const cbs = get().callbacks;
    if (!cbs) return;

    const sid = state.sessionId;
    const adapterId = state.adapterId || 'agent-agy';

    if (get().runningSessions[sid]) {
      const mode = delivery || cbs.getPendingMessageMode();
      if (mode === 'queue') {
        set((prev) => ({
          queuedPromptsBySession: {
            ...prev.queuedPromptsBySession,
            [sid]: [...(prev.queuedPromptsBySession[sid] || []), { id: uid('q'), prompt: trimmed, images }],
          },
        }));
        return;
      }
      await get().cancelTurn(sid, adapterId);
    }

    const now = Date.now();
    const userMsg: ChatMessage = {
      id: uid('u'),
      role: 'user',
      text: trimmed,
      images: images && images.length > 0 ? images : undefined,
      createdAt: now,
    };
    const assistantMsg: ChatMessage = {
      id: uid('a'),
      role: 'assistant',
      text: '',
      tools: [],
      blocks: [],
      createdAt: now,
      streaming: true,
    };

    const isFirst = (get().messagesBySession[sid]?.length || 0) === 0;
    if (isFirst) {
      cbs.updateTabTitleIfDefault(groupId, tabId, trimmed || (images?.[0]?.split('/').pop() ?? '이미지'));
    }

    set((prev) => ({
      messagesBySession: {
        ...prev.messagesBySession,
        [sid]: [...(prev.messagesBySession[sid] || []), userMsg, assistantMsg],
      },
      runningSessions: { ...prev.runningSessions, [sid]: true },
      errorsBySession: { ...prev.errorsBySession, [sid]: '' },
    }));

    try {
      const convId = state.externalSessionId ?? state.agyConversationId ?? null;
      const res = await cbs.invokeRpc<{ ok: boolean; error?: string; authRequired?: boolean }>(
        agentRpc(adapterId, 'prompt.send'),
        {
          tabSessionId: sid,
          agyConversationId: convId,
          externalSessionId: convId,
          prompt: trimmed,
          cwd: state.cwd,
          addDirs: state.addDirs,
          model: state.model,
          effort: state.effort,
          mode: state.mode,
          images,
        }
      );

      if (res && !res.ok) {
        set((prev) => {
          const existingAuth = prev.authPrompts[sid];
          const isAuthFlow = Boolean(res.authRequired || existingAuth);
          const list = isAuthFlow
            ? (prev.messagesBySession[sid] || []).filter((m) => m.id !== assistantMsg.id)
            : (prev.messagesBySession[sid] || []).map((m) =>
                m.streaming ? { ...m, streaming: false, endedAt: Date.now() } : m
              );
          const nextAuthPrompts = isAuthFlow
            ? {
                ...prev.authPrompts,
                [sid]: {
                  ...existingAuth,
                  mode: existingAuth?.mode || ('acp' as const),
                  message:
                    existingAuth?.message ||
                    '로컬 agy CLI 로그인이 풀렸습니다. 아래 버튼으로 바로 다시 로그인할 수 있습니다.',
                  pendingRetry: {
                    groupId,
                    tabId,
                    prompt: trimmed,
                    images,
                    userMessageId: userMsg.id,
                  },
                },
              }
            : prev.authPrompts;
          return {
            messagesBySession: { ...prev.messagesBySession, [sid]: list },
            runningSessions: { ...prev.runningSessions, [sid]: false },
            authPrompts: nextAuthPrompts,
            errorsBySession: isAuthFlow
              ? { ...prev.errorsBySession, [sid]: '' }
              : { ...prev.errorsBySession, [sid]: res.error || '실행 실패' },
          };
        });
      }
    } catch (err) {
      set((prev) => {
        const list = (prev.messagesBySession[sid] || []).map((m) =>
          m.streaming ? { ...m, streaming: false, endedAt: Date.now() } : m
        );
        return {
          messagesBySession: { ...prev.messagesBySession, [sid]: list },
          runningSessions: { ...prev.runningSessions, [sid]: false },
          errorsBySession: {
            ...prev.errorsBySession,
            [sid]: err instanceof Error ? err.message : `에이전트 어댑터(${adapterId})가 비활성화되어 있습니다.`,
          },
        };
      });
    }
  },

  removeQueuedPrompt: (tabSessionId, queueId) => {
    set((prev) => {
      const cur = prev.queuedPromptsBySession[tabSessionId] || [];
      const next = cur.filter((q) => q.id !== queueId);
      return {
        queuedPromptsBySession: {
          ...prev.queuedPromptsBySession,
          [tabSessionId]: next,
        },
      };
    });
  },

  updateQueuedPrompt: (tabSessionId, queueId, nextPrompt) => {
    const trimmed = nextPrompt.trim();
    if (!trimmed) {
      get().removeQueuedPrompt(tabSessionId, queueId);
      return;
    }
    set((prev) => {
      const cur = prev.queuedPromptsBySession[tabSessionId] || [];
      return {
        queuedPromptsBySession: {
          ...prev.queuedPromptsBySession,
          [tabSessionId]: cur.map((q) => (q.id === queueId ? { ...q, prompt: trimmed } : q)),
        },
      };
    });
  },

  sendQueuedNow: async (groupId, tabId, state, queueId) => {
    const sid = state.sessionId;
    const item = (get().queuedPromptsBySession[sid] || []).find((q) => q.id === queueId);
    if (!item) return;
    get().removeQueuedPrompt(sid, queueId);
    await get().sendPrompt(groupId, tabId, state, item.prompt, item.images, 'immediate');
  },

  clearQueuedPrompts: (tabSessionId) => {
    set((prev) => {
      const next = { ...prev.queuedPromptsBySession };
      delete next[tabSessionId];
      return { queuedPromptsBySession: next };
    });
  },

  cancelTurn: async (tabSessionId, adapterIdOverride) => {
    const cbs = get().callbacks;
    const adapterId = resolveAdapterForSession(cbs, tabSessionId, adapterIdOverride);
    if (cbs) {
      try {
        await cbs.invokeRpc(agentRpc(adapterId, 'prompt.cancel'), { tabSessionId });
      } catch {
        // ignore if adapter disabled
      }
    }
    const now = Date.now();
    set((prev) => {
      const msgs = (prev.messagesBySession[tabSessionId] || []).map((m) =>
        m.streaming
          ? {
              ...m,
              streaming: false,
              focus: undefined,
              endedAt: now,
              blocks: m.blocks ? closeOpenThinkingBlocks(m.blocks, now) : m.blocks,
            }
          : m
      );
      const nextPerms = { ...prev.permissionPrompts };
      delete nextPerms[tabSessionId];
      const nextQs = { ...prev.questionPrompts };
      delete nextQs[tabSessionId];
      return {
        messagesBySession: { ...prev.messagesBySession, [tabSessionId]: msgs },
        runningSessions: { ...prev.runningSessions, [tabSessionId]: false },
        permissionPrompts: nextPerms,
        questionPrompts: nextQs,
      };
    });
  },

  submitAuthCode: async (tabSessionId, code) => {
    const cbs = get().callbacks;
    if (!cbs) return;
    const adapterId = resolveAdapterForSession(cbs, tabSessionId);
    try {
      const ok = await cbs.invokeRpc<boolean>(agentRpc(adapterId, 'auth.submitCode'), { tabSessionId, code });
      if (ok) {
        set((prev) => {
          const next = { ...prev.authPrompts };
          delete next[tabSessionId];
          return { authPrompts: next };
        });
      }
    } catch {
      // ignore
    }
  },

  startCliLogin: async (tabSessionId, methodId = 'oauth-personal') => {
    const cbs = get().callbacks;
    if (!cbs) return { ok: false, error: '초기화되지 않았습니다.' };
    const adapterId = resolveAdapterForSession(cbs, tabSessionId);

    set((prev) => {
      const cur = prev.authPrompts[tabSessionId];
      if (!cur) return prev;
      return {
        authPrompts: {
          ...prev.authPrompts,
          [tabSessionId]: { ...cur, loggingIn: true, error: undefined },
        },
        errorsBySession: { ...prev.errorsBySession, [tabSessionId]: '' },
      };
    });

    try {
      const res = await cbs.invokeRpc<{ ok: boolean; error?: string }>(
        agentRpc(adapterId, 'auth.login'),
        { tabSessionId, methodId }
      );
      if (res?.ok) {
        const retry = get().authPrompts[tabSessionId]?.pendingRetry;
        set((prev) => {
          const nextAuth = { ...prev.authPrompts };
          for (const sid of Object.keys(nextAuth)) {
            if (resolveAdapterForSession(cbs, sid) === adapterId) {
              delete nextAuth[sid];
            }
          }
          const nextErrors = { ...prev.errorsBySession };
          nextErrors[tabSessionId] = '';
          const nextMsgs = { ...prev.messagesBySession };
          if (retry?.userMessageId && nextMsgs[tabSessionId]) {
            nextMsgs[tabSessionId] = nextMsgs[tabSessionId].filter((m) => m.id !== retry.userMessageId);
          }
          return {
            authPrompts: nextAuth,
            errorsBySession: nextErrors,
            messagesBySession: nextMsgs,
          };
        });

        void get().refreshModels(true, adapterId);
        void get().refreshAccountQuota(true, adapterId);

        if (retry) {
          const target = cbs.findTabBySessionId(tabSessionId);
          if (target) {
            void get().sendPrompt(
              target.groupId,
              target.tabId,
              target.state,
              retry.prompt,
              retry.images
            );
          }
        } else {
          set((prev) => ({
            noticesBySession: {
              ...prev.noticesBySession,
              [tabSessionId]: [
                ...(prev.noticesBySession[tabSessionId] || []).slice(-3),
                { id: uid('n'), level: 'info', text: 'agy CLI 로그인이 완료되었습니다.' },
              ],
            },
          }));
        }
        return { ok: true };
      }

      const errMsg = res?.error || 'agy CLI 로그인에 실패했습니다.';
      set((prev) => {
        const cur = prev.authPrompts[tabSessionId];
        if (!cur) return prev;
        return {
          authPrompts: {
            ...prev.authPrompts,
            [tabSessionId]: { ...cur, loggingIn: false, error: errMsg },
          },
        };
      });
      return { ok: false, error: errMsg };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'agy CLI 로그인 요청에 실패했습니다.';
      set((prev) => {
        const cur = prev.authPrompts[tabSessionId];
        if (!cur) return prev;
        return {
          authPrompts: {
            ...prev.authPrompts,
            [tabSessionId]: { ...cur, loggingIn: false, error: errMsg },
          },
        };
      });
      return { ok: false, error: errMsg };
    }
  },

  cancelCliLogin: async (tabSessionId) => {
    const cbs = get().callbacks;
    if (!cbs) return;
    const adapterId = resolveAdapterForSession(cbs, tabSessionId);
    try {
      await cbs.invokeRpc(agentRpc(adapterId, 'auth.cancel'), { tabSessionId });
    } catch {
      // ignore
    }
    set((prev) => {
      const cur = prev.authPrompts[tabSessionId];
      if (!cur) return prev;
      return {
        authPrompts: {
          ...prev.authPrompts,
          [tabSessionId]: { ...cur, loggingIn: false },
        },
      };
    });
  },

  dismissAuthPrompt: (tabSessionId) => {
    set((prev) => {
      if (!prev.authPrompts[tabSessionId]) return prev;
      const next = { ...prev.authPrompts };
      delete next[tabSessionId];
      return { authPrompts: next };
    });
  },

  respondPermission: async (tabSessionId, requestId, optionId) => {
    const cbs = get().callbacks;
    if (!cbs) return;
    const adapterId = resolveAdapterForSession(cbs, tabSessionId);
    set((prev) => {
      const next = { ...prev.permissionPrompts };
      if (next[tabSessionId]?.requestId === requestId) {
        delete next[tabSessionId];
      }
      return { permissionPrompts: next };
    });
    try {
      await cbs.invokeRpc<boolean>(agentRpc(adapterId, 'permission.respond'), {
        tabSessionId,
        requestId,
        optionId,
      });
    } catch {
      // ignore
    }
  },

  respondQuestion: async (tabSessionId, requestId, answers) => {
    const cbs = get().callbacks;
    if (!cbs) return;
    const adapterId = resolveAdapterForSession(cbs, tabSessionId);
    set((prev) => {
      const next = { ...prev.questionPrompts };
      if (next[tabSessionId]?.requestId === requestId) {
        delete next[tabSessionId];
      }
      return { questionPrompts: next };
    });
    try {
      await cbs.invokeRpc<boolean>(agentRpc(adapterId, 'question.respond'), {
        tabSessionId,
        requestId,
        answers,
      });
    } catch {
      // ignore
    }
  },

  dismissNotice: (tabSessionId, noticeId) => {
    set((prev) => ({
      noticesBySession: {
        ...prev.noticesBySession,
        [tabSessionId]: (prev.noticesBySession[tabSessionId] || []).filter((n) => n.id !== noticeId),
      },
    }));
  },

  handleAgyEvent: (ev) => get().handleAgentEvent(ev),

  handleAgentEvent: (ev) => {
    if (ev.type === 'commands_update') {
      if (ev.commands.length > 0) {
        set({ availableCommands: ev.commands });
      }
      return;
    }

    const cbs = get().callbacks;

    if (ev.type === 'auth_cleared') {
      const targetSid = ev.tabSessionId;
      set((prev) => {
        if (targetSid) {
          if (!prev.authPrompts[targetSid]) return prev;
          const next = { ...prev.authPrompts };
          delete next[targetSid];
          return { authPrompts: next };
        }
        const evAdapter = ev.adapterId;
        if (!evAdapter) return { authPrompts: {} };
        const next = { ...prev.authPrompts };
        for (const k of Object.keys(next)) {
          if (resolveAdapterForSession(cbs, k) === evAdapter) {
            delete next[k];
          }
        }
        return { authPrompts: next };
      });
      return;
    }

    const sid = ev.tabSessionId;

    if (ev.type === 'session_init') {
      cbs?.updateTabStateBySession(sid, {
        ...(ev.adapterId ? { adapterId: ev.adapterId } : {}),
        externalSessionId: ev.agyConversationId,
        agyConversationId: ev.agyConversationId,
        ...(ev.model ? { model: ev.model } : {}),
        source: 'cli',
      });
      return;
    }

    if (ev.type === 'session_title') {
      cbs?.updateTabTitleBySession(sid, ev.title);
      return;
    }

    if (ev.type === 'auth_required') {
      set((prev) => ({
        authPrompts: {
          ...prev.authPrompts,
          [sid]: {
            ...prev.authPrompts[sid],
            title: ev.title,
            url: ev.url,
            message: ev.message,
            mode: ev.mode || (ev.url ? 'code' : 'acp'),
            methods: ev.methods,
            loggingIn: false,
            error: undefined,
          },
        },
      }));
      return;
    }

    if (ev.type === 'permission_request') {
      set((prev) => ({
        permissionPrompts: {
          ...prev.permissionPrompts,
          [sid]: ev.request,
        },
      }));
      return;
    }

    if (ev.type === 'permission_cleared') {
      set((prev) => {
        if (!prev.permissionPrompts[sid]) return prev;
        if (ev.requestId && prev.permissionPrompts[sid].requestId !== ev.requestId) return prev;
        const next = { ...prev.permissionPrompts };
        delete next[sid];
        return { permissionPrompts: next };
      });
      return;
    }

    if (ev.type === 'question_request') {
      set((prev) => ({
        questionPrompts: {
          ...prev.questionPrompts,
          [sid]: ev.request,
        },
      }));
      return;
    }

    if (ev.type === 'question_cleared') {
      set((prev) => {
        if (!prev.questionPrompts[sid]) return prev;
        if (ev.requestId && prev.questionPrompts[sid].requestId !== ev.requestId) return prev;
        const next = { ...prev.questionPrompts };
        delete next[sid];
        return { questionPrompts: next };
      });
      return;
    }

    if (ev.type === 'notice') {
      set((prev) => ({
        noticesBySession: {
          ...prev.noticesBySession,
          [sid]: [...(prev.noticesBySession[sid] || []).slice(-3), { id: uid('nt'), level: ev.level, text: ev.text }],
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

    if (ev.type === 'usage_delta') {
      set((prev) => {
        const cur = prev.metricsBySession[sid];
        const win = ev.size > 0 ? ev.size : cur?.contextWindow || 200_000;
        const usedPct = win > 0 ? Number(((ev.used / win) * 100).toFixed(1)) : 0;
        if (!cur) {
          return {
            metricsBySession: {
              ...prev.metricsBySession,
              [sid]: {
                conversationId: sid,
                model: '',
                invocations: 1,
                currentContext: ev.used,
                contextWindow: win,
                usedPct,
                lastCacheRead: 0,
                lastInputTokens: ev.used,
                lastCacheHitPct: 0,
                lastCallAt: Date.now(),
                lastTurnTokens: ev.used,
                lastTurnCalls: 1,
                lastTurnOutput: 0,
                tokPerSec: null,
                sessionCumulative: ev.used,
                overallCacheHitPct: 0,
                toolDeltas: [],
                recentTurns: [],
                quotaBuckets: [],
                quotaUpdatedAt: null,
              },
            },
          };
        }
        return {
          metricsBySession: {
            ...prev.metricsBySession,
            [sid]: { ...cur, currentContext: ev.used, contextWindow: win, usedPct },
          },
        };
      });
      return;
    }

    if (ev.type === 'focus_update') {
      set((prev) => {
        const list = [...(prev.messagesBySession[sid] || [])];
        let last = list[list.length - 1];
        if (!last || last.role !== 'assistant') {
          last = {
            id: uid('a'),
            role: 'assistant',
            text: '',
            tools: [],
            blocks: [],
            focus: ev.focus,
            createdAt: Date.now(),
            streaming: true,
          };
          list.push(last);
        } else {
          list[list.length - 1] = { ...last, focus: ev.focus };
        }
        return { messagesBySession: { ...prev.messagesBySession, [sid]: list } };
      });
      return;
    }

    if (ev.type === 'steps_update') {
      set((prev) => {
        const list = [...(prev.messagesBySession[sid] || [])];
        let last = list[list.length - 1];
        if (!last || last.role !== 'assistant') {
          last = {
            id: uid('a'),
            role: 'assistant',
            text: '',
            tools: [],
            blocks: [{ id: uid('st'), type: 'steps', items: ev.steps }],
            createdAt: Date.now(),
            streaming: true,
          };
          list.push(last);
        } else {
          const blocks = [...(last.blocks || [])];
          const existingIdx = blocks.findIndex((b) => b.type === 'steps');
          if (existingIdx >= 0) {
            blocks[existingIdx] = { ...blocks[existingIdx], type: 'steps', items: ev.steps };
          } else {
            blocks.push({ id: uid('st'), type: 'steps', items: ev.steps });
          }
          list[list.length - 1] = { ...last, blocks };
        }
        return { messagesBySession: { ...prev.messagesBySession, [sid]: list } };
      });
      return;
    }

    if (ev.type === 'plan_proposed') {
      const now = Date.now();
      set((prev) => {
        const list = [...(prev.messagesBySession[sid] || [])];
        let last = list[list.length - 1];
        if (!last || last.role !== 'assistant') {
          last = {
            id: uid('a'),
            role: 'assistant',
            text: '',
            tools: [],
            blocks: [{ id: uid('pl'), type: 'plan', text: ev.plan }],
            createdAt: now,
            streaming: true,
          };
          list.push(last);
        } else {
          const blocks = closeOpenThinkingBlocks([...(last.blocks || [])], now);
          blocks.push({ id: uid('pl'), type: 'plan', text: ev.plan });
          list[list.length - 1] = { ...last, blocks };
        }
        return { messagesBySession: { ...prev.messagesBySession, [sid]: list } };
      });
      return;
    }

    if (ev.type === 'thinking_delta') {
      const now = Date.now();
      set((prev) => {
        const list = [...(prev.messagesBySession[sid] || [])];
        let last = list[list.length - 1];
        if (!last || last.role !== 'assistant') {
          last = {
            id: uid('a'),
            role: 'assistant',
            text: '',
            thinking: ev.delta,
            tools: [],
            blocks: [{ id: uid('th'), type: 'thinking', text: ev.delta, startedAt: now }],
            createdAt: now,
            streaming: true,
          };
          list.push(last);
        } else {
          const blocks = [...(last.blocks || [])];
          const tail = blocks[blocks.length - 1];
          if (tail && tail.type === 'thinking' && !tail.endedAt) {
            blocks[blocks.length - 1] = { ...tail, text: tail.text + ev.delta };
          } else {
            blocks.push({ id: uid('th'), type: 'thinking', text: ev.delta, startedAt: now });
          }
          list[list.length - 1] = {
            ...last,
            thinking: (last.thinking || '') + ev.delta,
            blocks,
          };
        }
        return { messagesBySession: { ...prev.messagesBySession, [sid]: list } };
      });
      return;
    }

    if (ev.type === 'text_delta') {
      const now = Date.now();
      set((prev) => {
        const list = [...(prev.messagesBySession[sid] || [])];
        let last = list[list.length - 1];
        if (!last || last.role !== 'assistant') {
          last = {
            id: uid('a'),
            role: 'assistant',
            text: ev.delta,
            tools: [],
            blocks: [{ id: uid('tx'), type: 'text', text: ev.delta }],
            createdAt: now,
            streaming: true,
          };
          list.push(last);
        } else {
          const blocks = closeOpenThinkingBlocks([...(last.blocks || [])], now);
          const tail = blocks[blocks.length - 1];
          let nextFullText = last.text;
          if (tail && tail.type === 'text') {
            blocks[blocks.length - 1] = { ...tail, text: tail.text + ev.delta };
            nextFullText = last.text + ev.delta;
          } else {
            blocks.push({ id: uid('tx'), type: 'text', text: ev.delta });
            nextFullText = last.text ? `${last.text}\n\n${ev.delta}` : ev.delta;
          }
          list[list.length - 1] = {
            ...last,
            text: nextFullText,
            blocks,
          };
        }
        return { messagesBySession: { ...prev.messagesBySession, [sid]: list } };
      });
      return;
    }

    if (ev.type === 'tool_use') {
      const now = Date.now();
      set((prev) => {
        const list = [...(prev.messagesBySession[sid] || [])];
        let last = list[list.length - 1];
        if (!last || last.role !== 'assistant') {
          last = {
            id: uid('a'),
            role: 'assistant',
            text: '',
            tools: [ev.tool],
            blocks: [{ id: `tb-${ev.tool.id}`, type: 'tool', tool: ev.tool }],
            createdAt: now,
            streaming: true,
          };
          list.push(last);
        } else {
          const blocks = closeOpenThinkingBlocks([...(last.blocks || [])], now);
          blocks.push({ id: `tb-${ev.tool.id}`, type: 'tool', tool: ev.tool });
          list[list.length - 1] = {
            ...last,
            tools: [...(last.tools || []), ev.tool],
            blocks,
          };
        }
        return { messagesBySession: { ...prev.messagesBySession, [sid]: list } };
      });
      return;
    }

    if (ev.type === 'tool_delta') {
      set((prev) => {
        const list = [...(prev.messagesBySession[sid] || [])];
        const last = list[list.length - 1];
        if (!last || last.role !== 'assistant') return prev;
        const append = (cur?: string) => ((cur || '') + ev.delta).slice(-2400);
        const tools = (last.tools || []).map((t) =>
          t.id === ev.toolId ? { ...t, outputPreview: append(t.outputPreview) } : t
        );
        const blocks = (last.blocks || []).map((b) =>
          b.type === 'tool' && b.tool.id === ev.toolId
            ? { ...b, tool: { ...b.tool, outputPreview: append(b.tool.outputPreview) } }
            : b
        );
        list[list.length - 1] = { ...last, tools, blocks };
        return { messagesBySession: { ...prev.messagesBySession, [sid]: list } };
      });
      return;
    }

    if (ev.type === 'tool_result') {
      const now = Date.now();
      set((prev) => {
        const list = [...(prev.messagesBySession[sid] || [])];
        const last = list[list.length - 1];
        if (!last || last.role !== 'assistant') return prev;
        const nextStatus: 'done' | 'error' = ev.isError ? 'error' : 'done';
        const tools = (last.tools || []).map((t) =>
          t.id === ev.toolId || (!ev.toolId && t.status === 'running')
            ? { ...t, outputPreview: ev.output || t.outputPreview, status: nextStatus, endedAt: now }
            : t
        );
        const blocks = (last.blocks || []).map((b) =>
          b.type === 'tool' && (b.tool.id === ev.toolId || (!ev.toolId && b.tool.status === 'running'))
            ? { ...b, tool: { ...b.tool, outputPreview: ev.output || b.tool.outputPreview, status: nextStatus, endedAt: now } }
            : b
        );
        list[list.length - 1] = { ...last, tools, blocks };
        return { messagesBySession: { ...prev.messagesBySession, [sid]: list } };
      });
      return;
    }

    if (ev.type === 'done') {
      const now = Date.now();
      const queued = get().queuedPromptsBySession[sid] || [];
      const nextQueuedItem = queued[0];
      const remainingQueue = queued.slice(1);

      set((prev) => {
        const list = (prev.messagesBySession[sid] || []).map((m) =>
          m.streaming
            ? {
                ...m,
                streaming: false,
                focus: undefined,
                endedAt: now,
                tools: m.tools?.map((t) =>
                  t.status === 'running' ? { ...t, status: 'done' as const, endedAt: now } : t
                ),
                blocks: m.blocks
                  ? closeOpenThinkingBlocks(m.blocks, now).map((b) =>
                      b.type === 'tool' && b.tool.status === 'running'
                        ? { ...b, tool: { ...b.tool, status: 'done' as const, endedAt: now } }
                        : b
                    )
                  : m.blocks,
              }
            : m
        );
        const nextAuth = { ...prev.authPrompts };
        delete nextAuth[sid];
        const nextPerms = { ...prev.permissionPrompts };
        delete nextPerms[sid];
        const nextQs = { ...prev.questionPrompts };
        delete nextQs[sid];
        return {
          messagesBySession: { ...prev.messagesBySession, [sid]: list },
          runningSessions: { ...prev.runningSessions, [sid]: false },
          queuedPromptsBySession: { ...prev.queuedPromptsBySession, [sid]: remainingQueue },
          authPrompts: nextAuth,
          permissionPrompts: nextPerms,
          questionPrompts: nextQs,
          errorsBySession: ev.error ? { ...prev.errorsBySession, [sid]: ev.error } : prev.errorsBySession,
        };
      });

      if (nextQueuedItem && !ev.error && cbs) {
        const target = cbs.findTabBySessionId(sid);
        if (target) {
          setTimeout(() => {
            void get().sendPrompt(target.groupId, target.tabId, target.state, nextQueuedItem.prompt, nextQueuedItem.images);
          }, 80);
        }
      }
    }
  },

  cleanupSession: (tabSessionId) => {
    set((prev) => {
      const messagesBySession = { ...prev.messagesBySession };
      const metricsBySession = { ...prev.metricsBySession };
      const runningSessions = { ...prev.runningSessions };
      const queuedPromptsBySession = { ...prev.queuedPromptsBySession };
      const authPrompts = { ...prev.authPrompts };
      const permissionPrompts = { ...prev.permissionPrompts };
      const questionPrompts = { ...prev.questionPrompts };
      const noticesBySession = { ...prev.noticesBySession };
      const errorsBySession = { ...prev.errorsBySession };
      delete messagesBySession[tabSessionId];
      delete metricsBySession[tabSessionId];
      delete runningSessions[tabSessionId];
      delete queuedPromptsBySession[tabSessionId];
      delete authPrompts[tabSessionId];
      delete permissionPrompts[tabSessionId];
      delete questionPrompts[tabSessionId];
      delete noticesBySession[tabSessionId];
      delete errorsBySession[tabSessionId];
      return {
        messagesBySession,
        metricsBySession,
        runningSessions,
        queuedPromptsBySession,
        authPrompts,
        permissionPrompts,
        questionPrompts,
        noticesBySession,
        errorsBySession,
      };
    });
  },
}));
