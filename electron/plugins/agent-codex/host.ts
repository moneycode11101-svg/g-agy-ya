import os from 'node:os';
import type { DeskHostContext, HostPluginModule } from '../../../src/kernel/shared/types';
import {
  AGENT_BUS,
  type AgentAdapterHostService,
  type AgentSendPromptRequest,
} from '../../../src/shared/agentProtocol';
import {
  CODEX_BUS,
  CODEX_RPC,
  type CodexPluginConfig,
} from '../../../src/plugins/agent-codex/types';
import { CodexPluginBridge } from './bridge';
import { CodexQuotaService } from './quota';
import { resolveCodexHome } from './rpcClient';
import { CodexRuntimeAssetProvider } from './runtimeAssets';

export const agentCodexHostPlugin: HostPluginModule<CodexPluginConfig> = {
  activate(ctx: DeskHostContext<CodexPluginConfig>) {
    const bridge = new CodexPluginBridge({
      getConfig: () => ctx.config.get(),
      emit: (ev) => {
        ctx.bus.publish(CODEX_BUS.EVENT, ev);
        ctx.bus.publish(AGENT_BUS.EVENT, ev);
      },
    });

    const quota = new CodexQuotaService({
      getClient: () => bridge.getClient(),
    });
    bridge.attachQuotaService(quota);

    const assetProvider = new CodexRuntimeAssetProvider({
      getCodexHome: () => String(ctx.config.get().codexHome || ''),
    });

    ctx.scope.onDispose(() => {
      bridge.dispose();
      quota.dispose();
    }, 'agent-codex:dispose-services');

    ctx.scope.onDispose(
      quota.onChange((snap) => {
        ctx.bus.publish(CODEX_BUS.QUOTA_UPDATED, snap);
        ctx.bus.publish(AGENT_BUS.QUOTA_UPDATED, { adapterId: 'agent-codex', snapshot: snap });
      }),
      'agent-codex:quota-sub'
    );

    ctx.host.registerRuntimeAssetProvider(assetProvider);

    const adapterService: AgentAdapterHostService = {
      id: 'agent-codex',
      displayName: 'Codex CLI (app-server)',
      capabilities: {
        quota: true,
        runtimeAssets: true,
        sessionHistory: true,
        interactiveApproval: true,
        userQuestions: true,
        steering: true,
      },
      sendPrompt: (req) => bridge.sendPrompt(req),
      cancelTurn: (tabSessionId) => bridge.cancelTurn(tabSessionId),
      startCliLogin: () => bridge.startCliLogin(),
      cancelCliLogin: () => bridge.cancelCliLogin(),
      respondPermission: (tabSessionId, requestId, optionId) =>
        bridge.respondPermission(tabSessionId, requestId, optionId),
      respondQuestion: (tabSessionId, requestId, answers) =>
        bridge.respondQuestion(tabSessionId, requestId, answers),
      listSessions: (limit = 30) => bridge.listSessions(limit),
      loadSession: (conversationId) => bridge.loadSession(conversationId),
      getQuota: (force = false) => quota.fetchLiveQuota(force),
      listModels: (force = false) => bridge.listModels(force),
      getRuntimeInfo: () => {
        const meta = quota.getAccountMeta();
        return {
          appVersion: ctx.host.appVersion,
          cliVersion: bridge.detectVersion(),
          hostname: os.hostname(),
          email: meta.email,
          planTier: meta.planTier,
          homePath: resolveCodexHome(String(ctx.config.get().codexHome || '')),
        };
      },
      scanRuntimeAssets: (cwd) => assetProvider.scanAssets(cwd),
    };

    ctx.services.provide('agent-adapter:codex', adapterService);
    ctx.services.provide('agent-adapter', adapterService);

    ctx.rpc.handle<{ limit?: number } | undefined>(CODEX_RPC.SESSIONS_LIST, (payload) =>
      adapterService.listSessions(payload?.limit ?? 30)
    );
    ctx.rpc.handle<{ conversationId: string }>(CODEX_RPC.SESSIONS_LOAD, (payload) =>
      adapterService.loadSession(payload.conversationId)
    );
    ctx.rpc.handle<{ tabSessionId: string; conversationId: string }>(CODEX_RPC.SESSIONS_WATCH, () => null);
    ctx.rpc.handle<{ tabSessionId: string }, void>(CODEX_RPC.SESSIONS_UNWATCH, () => {});
    ctx.rpc.handle<AgentSendPromptRequest>(CODEX_RPC.PROMPT_SEND, (payload) => adapterService.sendPrompt(payload));
    ctx.rpc.handle<{ tabSessionId: string }>(CODEX_RPC.PROMPT_CANCEL, (payload) =>
      adapterService.cancelTurn(payload.tabSessionId)
    );
    ctx.rpc.handle<{ tabSessionId?: string; methodId?: string } | undefined, { ok: boolean; error?: string }>(
      CODEX_RPC.AUTH_LOGIN,
      async () => await bridge.startCliLogin()
    );
    ctx.rpc.handle<{ tabSessionId?: string } | undefined, boolean>(CODEX_RPC.AUTH_CANCEL, () =>
      bridge.cancelCliLogin()
    );
    ctx.rpc.handle<{ tabSessionId: string; requestId: string; optionId: string | null }, boolean>(
      CODEX_RPC.PERMISSION_RESPOND,
      (payload) => adapterService.respondPermission(payload.tabSessionId, payload.requestId, payload.optionId)
    );
    ctx.rpc.handle<{ tabSessionId: string; requestId: string; answers: Record<string, string | string[]> | null }, boolean>(
      CODEX_RPC.QUESTION_RESPOND,
      (payload) => adapterService.respondQuestion!(payload.tabSessionId, payload.requestId, payload.answers)
    );
    ctx.rpc.handle<{ force?: boolean } | undefined>(CODEX_RPC.QUOTA_GET, (payload) =>
      adapterService.getQuota(Boolean(payload?.force))
    );
    ctx.rpc.handle<{ force?: boolean } | undefined>(CODEX_RPC.MODELS_LIST, (payload) =>
      adapterService.listModels(Boolean(payload?.force))
    );
    ctx.rpc.handle<void>(CODEX_RPC.RUNTIME_INFO, () => adapterService.getRuntimeInfo());
    ctx.rpc.handle<{ cwd?: string } | undefined>(CODEX_RPC.ASSETS_SCAN, (payload) =>
      assetProvider.scanAssets(payload?.cwd)
    );
  },
};
