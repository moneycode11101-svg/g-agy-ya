import { create } from 'zustand';
import type {
  AccountQuotaSnapshot,
  AgyEvent,
  AuthPrompt,
  ChatMessage,
  ChatMode,
  SessionMetrics,
} from '../../shared/types';
import {
  AGY_RPC,
  FALLBACK_AGY_MODELS,
  type AgyModelOption,
} from '../agent-agy/types';

function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export interface ChatTabState extends Record<string, unknown> {
  sessionId: string;
  adapterId: string;
  externalSessionId: string | null;
  agyConversationId: string | null;
  cwd: string;
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
  findTabBySessionId: (tabSessionId: string) => { groupId: string; tabId: string; state: ChatTabState } | null;
}

export interface ChatSessionStoreState {
  messagesBySession: Record<string, ChatMessage[]>;
  metricsBySession: Record<string, SessionMetrics>;
  runningSessions: Record<string, boolean>;
  queuedPromptsBySession: Record<string, Array<{ prompt: string; images?: string[] }>>;
  authPrompts: Record<string, AuthPrompt>;
  errorsBySession: Record<string, string>;
  accountQuota: AccountQuotaSnapshot | null;
  loadingQuota: boolean;
  adapterAvailable: boolean;
  availableModels: AgyModelOption[];
  callbacks: ChatRuntimeBridgeCallbacks | null;

  setCallbacks: (cbs: ChatRuntimeBridgeCallbacks | null) => void;
  setAdapterAvailable: (available: boolean) => void;
  setAccountQuota: (snap: AccountQuotaSnapshot) => void;
  refreshAccountQuota: (force?: boolean) => Promise<void>;
  refreshModels: (force?: boolean) => Promise<void>;

  hydrateSession: (tabSessionId: string, messages: ChatMessage[], metrics?: SessionMetrics | null) => void;
  setSessionMetrics: (tabSessionId: string, metrics: SessionMetrics) => void;
  sendPrompt: (groupId: string, tabId: string, state: ChatTabState, prompt: string, images?: string[]) => Promise<void>;
  clearQueuedPrompts: (tabSessionId: string) => void;
  cancelTurn: (tabSessionId: string) => Promise<void>;
  submitAuthCode: (tabSessionId: string, code: string) => Promise<void>;
  handleAgyEvent: (ev: AgyEvent) => void;
  cleanupSession: (tabSessionId: string) => void;
}

/**
 * Session & streaming store owned by `pane-chat`.
 * Keeps `metricsBySession` and `accountQuota` synced directly from `agent-agy` events
 * so `warnOnCacheReset` remains 100% functional even when `hud-token-bar` is disabled!
 */
export const useChatSessionStore = create<ChatSessionStoreState>((set, get) => ({
  messagesBySession: {},
  metricsBySession: {},
  runningSessions: {},
  queuedPromptsBySession: {},
  authPrompts: {},
  errorsBySession: {},
  accountQuota: null,
  loadingQuota: false,
  adapterAvailable: true,
  availableModels: FALLBACK_AGY_MODELS,
  callbacks: null,

  setCallbacks: (callbacks) => set({ callbacks }),
  setAdapterAvailable: (adapterAvailable) => set({ adapterAvailable }),

  setAccountQuota: (snap) => {
    if (snap && snap.buckets.length > 0) {
      set({ accountQuota: snap });
    }
  },

  refreshAccountQuota: async (force = false) => {
    const cbs = get().callbacks;
    if (!cbs) return;
    set({ loadingQuota: true });
    try {
      const snap = await cbs.invokeRpc<AccountQuotaSnapshot>(AGY_RPC.QUOTA_GET, { force });
      if (snap && (snap.buckets.length > 0 || !get().accountQuota)) {
        set({ accountQuota: snap });
      }
    } catch {
      // adapter may be disabled
    } finally {
      set({ loadingQuota: false });
    }
  },

  refreshModels: async (force = false) => {
    const cbs = get().callbacks;
    if (!cbs) return;
    try {
      const models = await cbs.invokeRpc<AgyModelOption[]>(AGY_RPC.MODELS_LIST, { force });
      if (Array.isArray(models) && models.length > 0) {
        set({ availableModels: models });
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

  sendPrompt: async (groupId, tabId, state, prompt, images) => {
    const trimmed = prompt.trim();
    if (!trimmed) return;
    const cbs = get().callbacks;
    if (!cbs) return;

    const sid = state.sessionId;
    if (get().runningSessions[sid]) {
      const mode = cbs.getPendingMessageMode();
      if (mode === 'queue') {
        set((prev) => ({
          queuedPromptsBySession: {
            ...prev.queuedPromptsBySession,
            [sid]: [...(prev.queuedPromptsBySession[sid] || []), { prompt: trimmed, images }],
          },
        }));
        return;
      }
      await get().cancelTurn(sid);
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

    const isFirst = (get().messagesBySession[sid]?.length || 0) === 0;
    if (isFirst) {
      cbs.updateTabTitleIfDefault(groupId, tabId, trimmed);
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
      const res = await cbs.invokeRpc<{ ok: boolean; error?: string }>(AGY_RPC.PROMPT_SEND, {
        tabSessionId: sid,
        agyConversationId: convId,
        prompt: trimmed,
        cwd: state.cwd,
        model: state.model,
        effort: state.effort,
        mode: state.mode,
        images,
      });

      if (res && !res.ok) {
        set((prev) => ({
          runningSessions: { ...prev.runningSessions, [sid]: false },
          errorsBySession: { ...prev.errorsBySession, [sid]: res.error || '실행 실패' },
        }));
      }
    } catch (err) {
      set((prev) => ({
        runningSessions: { ...prev.runningSessions, [sid]: false },
        errorsBySession: {
          ...prev.errorsBySession,
          [sid]: err instanceof Error ? err.message : '에이전트 어댑터(agent-agy)가 비활성화되어 있습니다.',
        },
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
    const cbs = get().callbacks;
    if (cbs) {
      try {
        await cbs.invokeRpc(AGY_RPC.PROMPT_CANCEL, { tabSessionId });
      } catch {
        // ignore if adapter disabled
      }
    }
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
    const cbs = get().callbacks;
    if (!cbs) return;
    try {
      const ok = await cbs.invokeRpc<boolean>(AGY_RPC.AUTH_SUBMIT, { tabSessionId, code });
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

  handleAgyEvent: (ev) => {
    const sid = ev.tabSessionId;
    const cbs = get().callbacks;

    if (ev.type === 'session_init') {
      cbs?.updateTabStateBySession(sid, {
        externalSessionId: ev.agyConversationId,
        agyConversationId: ev.agyConversationId,
        ...(ev.model ? { model: ev.model } : {}),
        source: 'cli',
      });
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
      const errorsBySession = { ...prev.errorsBySession };
      delete messagesBySession[tabSessionId];
      delete metricsBySession[tabSessionId];
      delete runningSessions[tabSessionId];
      delete queuedPromptsBySession[tabSessionId];
      delete authPrompts[tabSessionId];
      delete errorsBySession[tabSessionId];
      return {
        messagesBySession,
        metricsBySession,
        runningSessions,
        queuedPromptsBySession,
        authPrompts,
        errorsBySession,
      };
    });
  },
}));
