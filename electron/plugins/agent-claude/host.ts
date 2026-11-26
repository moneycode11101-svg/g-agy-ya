import os from 'node:os';
import type { DeskHostContext, HostPluginModule } from '../../../src/kernel/shared/types';
import {
  AGENT_BUS,
  type AgentAdapterHostService,
  type AgentSendPromptRequest,
} from '../../../src/shared/agentProtocol';
import {
  CLAUDE_BUS,
  CLAUDE_RPC,
  type ClaudePluginConfig,
} from '../../../src/plugins/agent-claude/types';
import { ClaudePluginBridge } from './bridge';
import { resolveClaudeConfigDir } from './env';
import { ClaudeQuotaService } from './quota';
import { ClaudeRuntimeAssetProvider } from './runtimeAssets';
import { listRecentClaudeSessions, loadClaudeTranscript } from './transcript';

export const agentClaudeHostPlugin: HostPluginModule<ClaudePluginConfig> = {
  activate(ctx: DeskHostContext<ClaudePluginConfig>) {
    const quota = new ClaudeQuotaService({
      getConfigDir: () => String(ctx.config.get().configDir || ''),
      getCliPath: () => String(ctx.config.get().cliPath || ''),
    });

    const bridge = new ClaudePluginBridge({
      getConfig: () => ctx.config.get(),
      quota,
      emit: (ev) => {
        ctx.bus.publish(CLAUDE_BUS.EVENT, ev);
        ctx.bus.publish(AGENT_BUS.EVENT, ev);
        if (ev.type === 'done' && !ev.error) {
          void quota.fetchLiveQuota(false);
        }
      },
    });

    const assetProvider = new ClaudeRuntimeAssetProvider({
      getConfigDir: () => String(ctx.config.get().configDir || ''),
    });

    ctx.scope.onDispose(() => {
      bridge.dispose();
      quota.dispose();
    }, 'agent-claude:dispose-services');

    ctx.scope.onDispose(
      quota.onChange((snap) => {
        ctx.bus.publish(CLAUDE_BUS.QUOTA_UPDATED, snap);
        ctx.bus.publish(AGENT_BUS.QUOTA_UPDATED, { adapterId: 'agent-claude', snapshot: snap });
      }),
      'agent-claude:quota-sub'
    );

    ctx.host.registerRuntimeAssetProvider(assetProvider);

    const adapterService: AgentAdapterHostService = {
      id: 'agent-claude',
      displayName: 'Claude Code (claude)',
      capabilities: {
        quota: true,
        runtimeAssets: true,
        sessionHistory: true,
        interactiveApproval: true,
        userQuestions: true,
        steering: false,
      },
      sendPrompt: (req) => bridge.sendPrompt(req),
      cancelTurn: (tabSessionId) => bridge.cancelTurn(tabSessionId),
      startCliLogin: (methodId) => bridge.startCliLogin(methodId),
      cancelCliLogin: () => bridge.cancelCliLogin(),
      respondPermission: (tabSessionId, requestId, optionId) =>
        bridge.respondPermission(tabSessionId, requestId, optionId),
      respondQuestion: (tabSessionId, requestId, answers) =>
        bridge.respondQuestion(tabSessionId, requestId, answers),
      listSessions: (limit = 30) => listRecentClaudeSessions(limit, String(ctx.config.get().configDir || '')),
      loadSession: (conversationId) =>
        loadClaudeTranscript(conversationId, quota.getCachedSnapshot(), String(ctx.config.get().configDir || '')),
      getQuota: (force = false) => quota.fetchLiveQuota(force),
      listModels: (force = false) => bridge.listModels(force),
      getRuntimeInfo: () => ({
        appVersion: ctx.host.appVersion,
        cliVersion: bridge.detectVersion(),
        hostname: os.hostname(),
        email: null,
        planTier: null,
        homePath: resolveClaudeConfigDir(String(ctx.config.get().configDir || '')),
      }),
      scanRuntimeAssets: (cwd) => assetProvider.scanAssets(cwd),
    };

    ctx.services.provide('agent-adapter:claude', adapterService);
    ctx.services.provide('agent-adapter', adapterService);

    ctx.rpc.handle<{ limit?: number } | undefined>(CLAUDE_RPC.SESSIONS_LIST, (payload) =>
      adapterService.listSessions(payload?.limit ?? 30)
    );
    ctx.rpc.handle<{ conversationId: string }>(CLAUDE_RPC.SESSIONS_LOAD, (payload) =>
      adapterService.loadSession(payload.conversationId)
    );
    ctx.rpc.handle<{ tabSessionId: string; conversationId: string }>(CLAUDE_RPC.SESSIONS_WATCH, (payload) => {
      const loaded = loadClaudeTranscript(
        payload.conversationId,
        quota.getCachedSnapshot(),
        String(ctx.config.get().configDir || '')
      );
      return loaded.metrics;
    });
    ctx.rpc.handle<{ tabSessionId: string }, void>(CLAUDE_RPC.SESSIONS_UNWATCH, () => {});
    ctx.rpc.handle<AgentSendPromptRequest>(CLAUDE_RPC.PROMPT_SEND, (payload) => adapterService.sendPrompt(payload));
    ctx.rpc.handle<{ tabSessionId: string }>(CLAUDE_RPC.PROMPT_CANCEL, (payload) =>
      adapterService.cancelTurn(payload.tabSessionId)
    );
    ctx.rpc.handle<{ tabSessionId?: string; methodId?: string } | undefined, { ok: boolean; error?: string }>(
      CLAUDE_RPC.AUTH_LOGIN,
      async (payload) => await bridge.startCliLogin(payload?.methodId)
    );
    ctx.rpc.handle<{ tabSessionId?: string } | undefined, boolean>(CLAUDE_RPC.AUTH_CANCEL, () =>
      bridge.cancelCliLogin()
    );
    ctx.rpc.handle<{ tabSessionId: string; requestId: string; optionId: string | null }, boolean>(
      CLAUDE_RPC.PERMISSION_RESPOND,
      (payload) => adapterService.respondPermission(payload.tabSessionId, payload.requestId, payload.optionId)
    );
    ctx.rpc.handle<{ tabSessionId: string; requestId: string; answers: Record<string, string | string[]> | null }, boolean>(
      CLAUDE_RPC.QUESTION_RESPOND,
      (payload) => adapterService.respondQuestion!(payload.tabSessionId, payload.requestId, payload.answers)
    );
    ctx.rpc.handle<{ force?: boolean } | undefined>(CLAUDE_RPC.QUOTA_GET, (payload) =>
      adapterService.getQuota(Boolean(payload?.force))
    );
    ctx.rpc.handle<{ force?: boolean } | undefined>(CLAUDE_RPC.MODELS_LIST, (payload) =>
      adapterService.listModels(Boolean(payload?.force))
    );
    ctx.rpc.handle<void>(CLAUDE_RPC.RUNTIME_INFO, () => adapterService.getRuntimeInfo());
    ctx.rpc.handle<{ cwd?: string } | undefined>(CLAUDE_RPC.ASSETS_SCAN, (payload) =>
      assetProvider.scanAssets(payload?.cwd)
    );
  },
};
