import type { BuiltinPluginPackage, DeskHostContext, HostPluginModule } from '../../src/kernel/shared/types';
import { AGENT_AGY_MANIFEST } from '../../src/plugins/agent-agy/manifest';
import { HUD_TOKEN_BAR_MANIFEST } from '../../src/plugins/hud-token-bar/manifest';
import { PANE_CHAT_MANIFEST } from '../../src/plugins/pane-chat/manifest';
import { RUNTIME_CONTEXT_INSPECTOR_MANIFEST } from '../../src/plugins/runtime-context-inspector/manifest';
import { SIDEBAR_WORKSPACE_MANIFEST } from '../../src/plugins/sidebar-workspace/manifest';
import { agentAgyHostPlugin } from './agent-agy/host';

/** Minimal host half for `pane-chat` (directory picker & external link fallback, works even if agent-agy is OFF) */
const paneChatHostPlugin: HostPluginModule = {
  activate(ctx: DeskHostContext) {
    ctx.rpc.handle<void, string | null>('pane-chat:pickDirectory', () => ctx.host.pickDirectory());
    ctx.rpc.handle<{ url?: string }, void>('pane-chat:openExternal', async (payload) => {
      if (payload?.url) {
        await ctx.host.openExternal(payload.url);
      }
    });
  },
};

/** Minimal host half for `sidebar-workspace` (project folder picker & Finder reveal, independent of agent-agy) */
const sidebarWorkspaceHostPlugin: HostPluginModule = {
  activate(ctx: DeskHostContext) {
    ctx.rpc.handle<void, string | null>('sidebar-workspace:pickDirectory', () => ctx.host.pickDirectory());
    ctx.rpc.handle<{ targetPath?: string }, void>('sidebar-workspace:showInFolder', (payload) => {
      if (payload?.targetPath) {
        ctx.host.showInFolder(payload.targetPath);
      }
    });
  },
};

/**
 * Wave 2 Agent & Data Host plugin packages (5 bundled plugins).
 * Registered into Electron Main via `createHostKernel().boot([...AGENT_HOST_PLUGINS, ...])`.
 */
export const AGENT_HOST_PLUGINS: BuiltinPluginPackage[] = [
  {
    manifest: AGENT_AGY_MANIFEST,
    host: agentAgyHostPlugin as HostPluginModule,
  },
  {
    manifest: PANE_CHAT_MANIFEST,
    host: paneChatHostPlugin,
  },
  {
    manifest: HUD_TOKEN_BAR_MANIFEST,
  },
  {
    manifest: SIDEBAR_WORKSPACE_MANIFEST,
    host: sidebarWorkspaceHostPlugin,
  },
  {
    manifest: RUNTIME_CONTEXT_INSPECTOR_MANIFEST,
  },
];
