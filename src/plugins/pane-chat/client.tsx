import React from 'react';
import { MessageSquare } from 'lucide-react';
import {
  BUILTIN_PLUGIN_IDS,
  useLayoutStore,
  usePluginConfigStore,
  type ClientPluginModule,
  type DeskClientContext,
  type PaneComponentProps,
  type PaneTabRecord,
  type SplitDir,
} from '../../kernel/client';
import {
  AGENT_BUS,
  agentRpc,
  type AgentLoadedSession,
  type AgentQuotaBusPayload,
  type ClientAgentAdapterDescriptor,
} from '../../shared/agentProtocol';
import type { AgentEvent, ChatMode, SessionSummary } from '../../shared/types';
import { ChatPaneView } from './ChatPaneView';
import { useChatSessionStore, type ChatTabState } from './chatStore';
import { PANE_CHAT_MANIFEST, type PaneChatConfig } from './manifest';

function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function getDefaultCwd(ctx: DeskClientContext<PaneChatConfig>): string {
  const configured = ctx.config.get().defaultCwd;
  if (configured) return configured;
  return window.deskKernel?.env.homeDir || '/';
}

function getAdapterDefaults(adapterId: string): {
  defaultModel?: string;
  defaultEffort?: string;
  localPermission?: ChatMode;
} {
  return (usePluginConfigStore.getState().configsByPlugin[adapterId] || {}) as {
    defaultModel?: string;
    defaultEffort?: string;
    localPermission?: ChatMode;
  };
}

function normalizeChatState(raw: Record<string, unknown>, ctx: DeskClientContext<PaneChatConfig>): ChatTabState {
  const adapterId =
    typeof raw.adapterId === 'string' && raw.adapterId ? raw.adapterId : BUILTIN_PLUGIN_IDS.AGENT_AGY;
  const adapterCfg = getAdapterDefaults(adapterId);
  const modeRaw = (raw.mode as ChatMode | undefined) || adapterCfg.localPermission || 'turbo';
  const validModes: readonly ChatMode[] = ['turbo', 'auto', 'accept-edits', 'plan', 'strict'];
  const mode: ChatMode = validModes.includes(modeRaw) ? modeRaw : 'turbo';
  const externalSessionId =
    typeof raw.externalSessionId === 'string'
      ? raw.externalSessionId
      : typeof raw.agyConversationId === 'string'
        ? raw.agyConversationId
        : null;
  const initialPrompt =
    typeof raw.initialPrompt === 'string'
      ? raw.initialPrompt
      : typeof raw.prefillPrompt === 'string'
        ? raw.prefillPrompt
        : typeof raw.prompt === 'string'
          ? raw.prompt
          : undefined;
  const addDirs = Array.isArray(raw.addDirs)
    ? raw.addDirs.filter((d): d is string => typeof d === 'string' && d.trim().length > 0)
    : undefined;

  const model = typeof raw.model === 'string' && raw.model ? raw.model : adapterCfg.defaultModel || 'default';
  const modelHasEmbeddedTier = /-(low|medium|high|xhigh|max)$/i.test(model);
  const effort = modelHasEmbeddedTier
    ? 'default'
    : typeof raw.effort === 'string' && raw.effort
      ? raw.effort
      : adapterCfg.defaultEffort || 'default';

  return {
    sessionId: typeof raw.sessionId === 'string' && raw.sessionId ? raw.sessionId : uid('sess'),
    adapterId,
    externalSessionId,
    agyConversationId: externalSessionId,
    cwd: typeof raw.cwd === 'string' && raw.cwd ? raw.cwd : getDefaultCwd(ctx),
    addDirs: addDirs && addDirs.length > 0 ? addDirs : undefined,
    projectLabel: typeof raw.projectLabel === 'string' ? raw.projectLabel : undefined,
    model,
    effort,
    mode,
    source: raw.source === 'cli' || raw.source === 'app' || raw.source === 'new' ? raw.source : 'new',
    initialPrompt,
  };
}

export const paneChatClientPlugin: ClientPluginModule<PaneChatConfig> = {
  activate(ctx: DeskClientContext<PaneChatConfig>) {
    const store = useChatSessionStore.getState();

    store.setCallbacks({
      invokeRpc: (method, payload) => ctx.rpc.invoke(method, payload),
      getPendingMessageMode: () => ctx.config.get().pendingMessageMode || 'queue',
      updateTabStateBySession: (tabSessionId, patch) => {
        const s = useLayoutStore.getState();
        for (const grp of Object.values(s.groups)) {
          const t = grp.tabs.find((x) => x.paneType === 'chat' && (x.state as ChatTabState)?.sessionId === tabSessionId);
          if (t) {
            s.updateTabState(grp.id, t.id, patch);
            break;
          }
        }
      },
      updateTabTitleIfDefault: (groupId, tabId, prompt) => {
        const grp = useLayoutStore.getState().groups[groupId];
        const tab = grp?.tabs.find((t) => t.id === tabId);
        if (
          tab &&
          (tab.title === '새 채팅' ||
            tab.title === '새 대화' ||
            tab.title === '메인 채팅' ||
            tab.title.startsWith('새 채팅 ('))
        ) {
          const shortTitle = prompt.length > 26 ? prompt.slice(0, 26) + '…' : prompt;
          useLayoutStore.getState().updateTabMeta(groupId, tabId, { title: shortTitle });
        }
      },
      updateTabTitleBySession: (tabSessionId, title) => {
        const s = useLayoutStore.getState();
        for (const grp of Object.values(s.groups)) {
          const t = grp.tabs.find((x) => x.paneType === 'chat' && (x.state as ChatTabState)?.sessionId === tabSessionId);
          if (t) {
            const clean = title.trim();
            if (clean) {
              const shortTitle = clean.length > 32 ? clean.slice(0, 32) + '…' : clean;
              s.updateTabMeta(grp.id, t.id, { title: shortTitle });
            }
            break;
          }
        }
      },
      findTabBySessionId: (tabSessionId) => {
        const s = useLayoutStore.getState();
        for (const grp of Object.values(s.groups)) {
          const t = grp.tabs.find((x) => x.paneType === 'chat' && (x.state as ChatTabState)?.sessionId === tabSessionId);
          if (t) {
            return { groupId: grp.id, tabId: t.id, state: t.state as ChatTabState };
          }
        }
        return null;
      },
    });
    ctx.scope.onDispose(() => {
      useChatSessionStore.getState().setCallbacks(null);
    }, 'pane-chat:store-callbacks');

    // Reactively sync all active agent-adapter plugins (`agent-agy`, `agent-claude`, `agent-codex`, ...)
    const syncAdapters = () => {
      const list = ctx.services
        .getAll<ClientAgentAdapterDescriptor>('agent-adapter')
        .map((e) => e.impl)
        .filter((d): d is ClientAgentAdapterDescriptor => Boolean(d && d.id));
      const order: Record<string, number> = {
        'agent-agy': 1,
        'agent-claude': 2,
        'agent-codex': 3,
      };
      list.sort((a, b) => (order[a.id] ?? 99) - (order[b.id] ?? 99));
      useChatSessionStore.getState().setAvailableAdapters(list);
      return list;
    };

    syncAdapters();
    ctx.services.whenAvailable<ClientAgentAdapterDescriptor>('agent-adapter', (desc) => {
      syncAdapters();
      if (desc?.id) {
        void useChatSessionStore.getState().refreshAccountQuota(false, desc.id);
        void useChatSessionStore.getState().refreshModels(false, desc.id);
      }
      return () => {
        syncAdapters();
      };
    });

    // Unified cross-adapter Event Bus subscription (`agent:event` + `agent:quota.updated`)
    ctx.bus.subscribe<AgentEvent>(AGENT_BUS.EVENT, (env) => {
      if (env.payload) {
        useChatSessionStore.getState().handleAgentEvent(env.payload);
      }
    });
    ctx.bus.subscribe<AgentQuotaBusPayload>(AGENT_BUS.QUOTA_UPDATED, (env) => {
      if (env.payload?.snapshot) {
        useChatSessionStore.getState().setAccountQuota(env.payload.snapshot, env.payload.adapterId);
      }
    });

    // Provide lightweight telemetry service for decoupled widgets (`hud-token-bar`, etc.)
    ctx.services.provide('chat:telemetry', {
      useChatSessionStore,
      refreshQuota: (force?: boolean, adapterId?: string) =>
        useChatSessionStore.getState().refreshAccountQuota(force, adapterId),
      sendPromptToTab: (groupId: string, tabId: string, state: ChatTabState, prompt: string) =>
        useChatSessionStore.getState().sendPrompt(groupId, tabId, state, prompt),
    });

    const BoundChatPane: React.FC<PaneComponentProps<ChatTabState>> = (props) => (
      <ChatPaneView {...props} ctx={ctx} />
    );

    const ChatTabBadge: React.FC<{ tab: PaneTabRecord<ChatTabState>; active: boolean }> = ({ tab }) => {
      const running = useChatSessionStore((s) => Boolean(s.runningSessions[tab.state?.sessionId]));
      const adapterId = tab.state?.adapterId || 'agent-agy';
      const dotColor =
        adapterId === 'agent-claude' ? '#d97706' : adapterId === 'agent-codex' ? '#10b981' : 'var(--accent)';
      if (running) {
        return (
          <span
            className="w-1.5 h-1.5 rounded-full animate-pulse shrink-0"
            style={{ background: dotColor }}
            title="응답 생성 중"
          />
        );
      }
      if (adapterId === 'agent-claude' || adapterId === 'agent-codex') {
        return (
          <span
            className="w-1.5 h-1.5 rounded-full shrink-0 opacity-75"
            style={{ background: dotColor }}
            title={adapterId === 'agent-claude' ? 'Claude Code' : 'Codex CLI'}
          />
        );
      }
      return null;
    };

    ctx.panes.registerType<ChatTabState>({
      type: 'chat',
      label: '새 채팅 (반중력·Claude·Codex)',
      description: '반중력 · Claude Code · Codex 멀티 엔진 대화',
      icon: MessageSquare,
      accentColor: '#3b82f6',
      shortcut: '⌘N',
      keepAlive: 'never',
      showInLauncher: true,
      showInOmnibox: true,
      order: 10,
      createDefaultState: (init) => {
        const state = normalizeChatState(init || {}, ctx);
        const title = typeof init?.title === 'string' && init.title ? init.title : '새 채팅';
        return { title, state };
      },
      duplicateState: (src) => {
        const s = src.state;
        const next = normalizeChatState(
          {
            cwd: s.cwd,
            addDirs: s.addDirs,
            model: s.model,
            effort: s.effort,
            mode: s.mode,
            adapterId: s.adapterId,
          },
          ctx
        );
        return { title: '새 채팅', state: next };
      },
      migrateState: (raw) => normalizeChatState(raw, ctx),
      matchOmnibox: (query) => {
        const q = query.trim().toLowerCase();
        if (q === 'claude' || q === '클로드') {
          return { score: 110, label: '새 채팅 (Claude Code)', init: { adapterId: 'agent-claude' } };
        }
        if (q === 'codex' || q === 'gpt' || q === 'openai') {
          return { score: 110, label: '새 채팅 (Codex CLI)', init: { adapterId: 'agent-codex' } };
        }
        if (q === 'chat' || q === '채팅' || q === 'agy' || q === '반중력') {
          return { score: 100, label: '새 채팅 (반중력)', init: { adapterId: 'agent-agy' } };
        }
        return null;
      },
      beforeClose: async (tab) => {
        const sid = tab.state?.sessionId;
        if (!sid) return true;
        const isBusy = Boolean(useChatSessionStore.getState().runningSessions[sid]);
        if (isBusy && ctx.config.get().confirmCloseRunning !== false) {
          return ctx.ui.confirm('응답을 생성 중인 채팅입니다. 중단하고 닫으시겠습니까?');
        }
        return true;
      },
      onTabDispose: async (tab) => {
        const sid = tab.state?.sessionId;
        if (!sid) return;
        const adapterId = tab.state?.adapterId || 'agent-agy';
        try {
          await ctx.rpc.invoke(agentRpc(adapterId, 'sessions.unwatch'), { tabSessionId: sid });
          await ctx.rpc.invoke(agentRpc(adapterId, 'prompt.cancel'), { tabSessionId: sid });
        } catch {
          // ignore if adapter disabled
        }
        useChatSessionStore.getState().cleanupSession(sid);
      },
      TabBadge: ChatTabBadge,
      Component: BoundChatPane,
    });

    ctx.commands.register({
      id: 'pane-chat:new-chat',
      title: '새 채팅 탭',
      shortcut: 'Mod+N',
      run: (args) => {
        const init = args && typeof args === 'object' ? (args as Record<string, unknown>) : undefined;
        ctx.workspace.openTab('chat', init);
      },
    });

    ctx.commands.register({
      id: 'pane-chat:new-claude-chat',
      title: '새 Claude Code 채팅 탭',
      run: (args) => {
        const init = args && typeof args === 'object' ? (args as Record<string, unknown>) : {};
        ctx.workspace.openTab('chat', { ...init, adapterId: BUILTIN_PLUGIN_IDS.AGENT_CLAUDE });
      },
    });

    ctx.commands.register({
      id: 'pane-chat:new-codex-chat',
      title: '새 Codex 채팅 탭',
      run: (args) => {
        const init = args && typeof args === 'object' ? (args as Record<string, unknown>) : {};
        ctx.workspace.openTab('chat', { ...init, adapterId: BUILTIN_PLUGIN_IDS.AGENT_CODEX });
      },
    });

    ctx.commands.register({
      id: 'pane-chat:send-prompt',
      title: '채팅 프롬프트 전송',
      run: async (args) => {
        const req = args as { groupId?: string; tabId?: string; prompt?: string } | undefined;
        if (!req?.prompt) return;
        const focused =
          req.groupId && req.tabId
            ? { groupId: req.groupId, tab: useLayoutStore.getState().groups[req.groupId]?.tabs.find((t) => t.id === req.tabId) }
            : ctx.workspace.getFocusedTab();
        if (!focused?.tab || focused.tab.paneType !== 'chat') return;
        await useChatSessionStore
          .getState()
          .sendPrompt(focused.groupId, focused.tab.id, focused.tab.state as ChatTabState, req.prompt);
      },
    });

    ctx.commands.register({
      id: 'pane-chat:open-session',
      title: '기존 대화 세션 열기',
      run: async (args) => {
        const req = args as { summary: SessionSummary; split?: boolean | SplitDir; targetGroupId?: string } | undefined;
        if (!req?.summary) return;
        const { summary, split = false, targetGroupId } = req;
        const adapterId = summary.adapterId || BUILTIN_PLUGIN_IDS.AGENT_AGY;

        const layout = useLayoutStore.getState();
        for (const grp of Object.values(layout.groups)) {
          const existing = grp.tabs.find(
            (t) =>
              t.paneType === 'chat' &&
              ((t.state as ChatTabState).externalSessionId === summary.conversationId ||
                (t.state as ChatTabState).agyConversationId === summary.conversationId)
          );
          if (existing) {
            layout.setActiveTab(grp.id, existing.id);
            return;
          }
        }

        const init: Record<string, unknown> = {
          title: summary.title,
          adapterId,
          externalSessionId: summary.conversationId,
          agyConversationId: summary.conversationId,
          ...(summary.cwd ? { cwd: summary.cwd } : {}),
          projectLabel: summary.projectLabel || undefined,
          model: summary.model || 'default',
          source: summary.source,
        };

        const baseGroupId = targetGroupId || layout.focusedGroupId;
        let openedTabId: string | null = null;
        if (split) {
          const dir: SplitDir = split === 'v' ? 'v' : 'h';
          openedTabId = layout.splitGroup(baseGroupId, dir, 'chat', init);
        } else {
          const targetGrp = layout.groups[baseGroupId] || Object.values(layout.groups)[0];
          const curActive = targetGrp?.tabs.find((t) => t.id === targetGrp.activeTabId);
          if (curActive && (curActive.paneType === 'launcher' || curActive.paneType === 'core:empty')) {
            layout.convertTab(targetGrp.id, curActive.id, 'chat', init);
            const updatedGrp = useLayoutStore.getState().groups[targetGrp.id];
            openedTabId = updatedGrp?.activeTabId || null;
          } else if (targetGrp) {
            openedTabId = layout.addTabToGroup(targetGrp.id, 'chat', init);
          }
        }

        if (openedTabId) {
          const nextState = useLayoutStore.getState();
          let sessionId: string | null = null;
          for (const grp of Object.values(nextState.groups)) {
            const tab = grp.tabs.find((t) => t.id === openedTabId);
            if (tab) {
              sessionId = (tab.state as ChatTabState).sessionId;
              break;
            }
          }
          if (sessionId) {
            try {
              const loaded = await ctx.rpc.invoke<AgentLoadedSession>(agentRpc(adapterId, 'sessions.load'), {
                conversationId: summary.conversationId,
              });
              if (loaded) {
                useChatSessionStore.getState().hydrateSession(sessionId, loaded.messages, loaded.metrics);
              }
            } catch {
              // ignore
            }
          }
        }
      },
    });

    ctx.slots.register('settings.section', {
      id: 'pane-chat-settings',
      group: '일반 · 입력',
      title: '채팅 · 입력',
      description: '메시지 전송 방식, 대기열, 캐시 보호 경고, 트랜스크립트 단계 및 컬럼 너비를 구성합니다.',
      icon: MessageSquare,
      order: 10,
      schema: PANE_CHAT_MANIFEST.configSchema,
    });
  },
};
