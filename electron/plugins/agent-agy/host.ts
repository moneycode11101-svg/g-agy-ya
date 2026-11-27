import os from 'node:os';
import type { DeskHostContext, HostPluginModule } from '../../../src/kernel/shared/types';
import { AGENT_BUS } from '../../../src/shared/agentProtocol';
import {
  AGY_BUS,
  AGY_RPC,
  type AgyAgentAdapterHostService,
  type AgyPluginConfig,
  type AgySendPromptRequest,
} from '../../../src/plugins/agent-agy/types';
import { AgyPluginBridge } from './bridge';
import { ensureBundledAgyPluginsInstalled } from './bundledPlugins';
import { AgyQuotaService } from './quota';
import { AgyRuntimeAssetProvider } from './runtimeAssets';
import { analyzeSingleSession, listRecentSessions, loadTranscriptMessages } from './transcript';

export const agentAgyHostPlugin: HostPluginModule<AgyPluginConfig> = {
  activate(ctx: DeskHostContext<AgyPluginConfig>) {
    // Seed default bundled skills/plugins (`korean-pack`, `token-band`) on first launch
    const seedResult = ensureBundledAgyPluginsInstalled();
    if (seedResult.installed.length > 0) {
      console.log(`[agent-agy] seeded bundled plugins: ${seedResult.installed.join(', ')}`);
    }

    const quota = new AgyQuotaService();

    const bridge = new AgyPluginBridge({
      getConfig: () => ctx.config.get(),
      quota,
      emit: (ev) => {
        const tagged = { ...ev, adapterId: 'agent-agy' };
        ctx.bus.publish(AGY_BUS.EVENT, tagged);
        ctx.bus.publish(AGENT_BUS.EVENT, tagged);
        if (ev.type === 'done' && !ev.error) {
          void quota.fetchLiveQuota(true);
        }
      },
    });

    const assetProvider = new AgyRuntimeAssetProvider({
      onAssetsMutated: () => {
        bridge.bumpAssetRevision();
        void assetProvider.scanAssets().then((proj) => {
          ctx.bus.publish(AGY_BUS.ASSETS_UPDATED, proj);
        });
      },
    });

    ctx.scope.onDispose(() => {
      bridge.dispose();
      quota.dispose();
    }, 'agent-agy:dispose-services');

    // Single-source quota fs.watch + window focus refresh
    ctx.scope.onDispose(quota.startWatcher(), 'agent-agy:quota-watcher');
    ctx.scope.onDispose(
      quota.onChange((snap) => {
        const taggedSnap = { ...snap, adapterId: 'agent-agy' };
        ctx.bus.publish(AGY_BUS.QUOTA_UPDATED, taggedSnap);
        ctx.bus.publish(AGENT_BUS.QUOTA_UPDATED, { adapterId: 'agent-agy', snapshot: taggedSnap });
      }),
      'agent-agy:quota-sub'
    );
    ctx.host.onWindowFocus(() => {
      void quota.fetchLiveQuota(false);
    });

    // Register Layer 2 RuntimeAssetProvider with Host Kernel Introspection Hub
    ctx.host.registerRuntimeAssetProvider(assetProvider);

    const adapterService: AgyAgentAdapterHostService = {
      id: 'agent-agy',
      displayName: 'Antigravity CLI (agy)',
      sendPrompt: (req) => bridge.sendPrompt(req),
      cancelTurn: (tabSessionId) => bridge.cancelTurn(tabSessionId),
      submitAuthCode: (tabSessionId, code) => bridge.submitAuthCode(tabSessionId, code),
      startCliLogin: (methodId) => bridge.startCliLogin(methodId),
      cancelCliLogin: () => bridge.cancelCliLogin(),
      respondPermission: (tabSessionId, requestId, optionId) =>
        bridge.respondPermission(tabSessionId, requestId, optionId),
      watchSession: (tabSessionId, conversationId) => bridge.watchSession(tabSessionId, conversationId),
      unwatchSession: (tabSessionId) => bridge.unwatchSession(tabSessionId),
      listSessions: (limit = 40) => listRecentSessions(limit),
      loadSession: (conversationId) => ({
        messages: loadTranscriptMessages(conversationId),
        metrics: analyzeSingleSession(conversationId, quota.getCachedSnapshot()),
      }),
      getQuota: async (force = false) => {
        if (force) return quota.fetchLiveQuota(true);
        const cached = quota.getCachedSnapshot();
        if (cached.buckets.length > 0) {
          void quota.fetchLiveQuota(false);
          return cached;
        }
        return quota.fetchLiveQuota(false);
      },
      listModels: (force = false) => bridge.listModels(force),
      getRuntimeInfo: () => {
        const meta = quota.getAccountMeta();
        return {
          appVersion: ctx.host.appVersion,
          agyCliVersion: bridge.detectVersion(),
          hostname: os.hostname(),
          email: meta.email,
          planTier: meta.planTier,
        };
      },
      scanRuntimeAssets: (cwd) => assetProvider.scanAssets(cwd),
    };

    ctx.services.provide('agent-adapter:agy', adapterService);
    ctx.services.provide('agent-adapter', adapterService);

    // Namespaced RPC endpoints (`agent-agy:*`)
    ctx.rpc.handle<{ limit?: number } | undefined, ReturnType<typeof listRecentSessions>>(
      AGY_RPC.SESSIONS_LIST,
      (payload) => adapterService.listSessions(payload?.limit ?? 40)
    );
    ctx.rpc.handle<{ conversationId: string }, ReturnType<typeof adapterService.loadSession>>(
      AGY_RPC.SESSIONS_LOAD,
      (payload) => adapterService.loadSession(payload.conversationId)
    );
    ctx.rpc.handle<{ tabSessionId: string; conversationId: string }>(
      AGY_RPC.SESSIONS_WATCH,
      (payload) => adapterService.watchSession(payload.tabSessionId, payload.conversationId)
    );
    ctx.rpc.handle<{ tabSessionId: string }, void>(AGY_RPC.SESSIONS_UNWATCH, (payload) => {
      adapterService.unwatchSession(payload.tabSessionId);
    });
    ctx.rpc.handle<AgySendPromptRequest, { ok: boolean; error?: string }>(
      AGY_RPC.PROMPT_SEND,
      async (payload) => await adapterService.sendPrompt(payload)
    );
    ctx.rpc.handle<{ tabSessionId: string }, void>(AGY_RPC.PROMPT_CANCEL, (payload) => {
      adapterService.cancelTurn(payload.tabSessionId);
    });
    ctx.rpc.handle<{ tabSessionId: string; code: string }, boolean>(
      AGY_RPC.AUTH_SUBMIT,
      (payload) => adapterService.submitAuthCode(payload.tabSessionId, payload.code)
    );
    ctx.rpc.handle<{ tabSessionId?: string; methodId?: string } | undefined, { ok: boolean; error?: string }>(
      AGY_RPC.AUTH_LOGIN,
      async (payload) => await adapterService.startCliLogin(payload?.methodId)
    );
    ctx.rpc.handle<{ tabSessionId?: string } | undefined, boolean>(
      AGY_RPC.AUTH_CANCEL,
      () => adapterService.cancelCliLogin()
    );
    ctx.rpc.handle<{ tabSessionId: string; requestId: string; optionId: string | null }, boolean>(
      AGY_RPC.PERMISSION_RESPOND,
      (payload) => adapterService.respondPermission(payload.tabSessionId, payload.requestId, payload.optionId)
    );
    ctx.rpc.handle<{ force?: boolean } | undefined>(AGY_RPC.QUOTA_GET, (payload) =>
      adapterService.getQuota(Boolean(payload?.force))
    );
    ctx.rpc.handle<{ force?: boolean } | undefined>(AGY_RPC.MODELS_LIST, (payload) =>
      adapterService.listModels(Boolean(payload?.force))
    );
    ctx.rpc.handle<void>(AGY_RPC.RUNTIME_INFO, () => adapterService.getRuntimeInfo());
    ctx.rpc.handle<{ cwd?: string } | undefined>(AGY_RPC.ASSETS_SCAN, (payload) =>
      adapterService.scanRuntimeAssets(payload?.cwd)
    );
    ctx.rpc.handle<{ assetId: string; enabled: boolean; scope?: 'session' | 'workspace' | 'global'; cwd?: string }>(
      AGY_RPC.ASSETS_TOGGLE,
      async (payload) => {
        const res = await assetProvider.toggleAsset(payload);
        if (res.ok) {
          const proj = await assetProvider.scanAssets(payload.cwd);
          ctx.bus.publish(AGY_BUS.ASSETS_UPDATED, proj);
        }
        return res;
      }
    );

    // Non-blocking initial quota refresh + ACP daemon warmup
    void quota.fetchLiveQuota(false);
    bridge.warmup();
  },
};
