import type { BuiltinPluginPackage, ClientPluginModule } from '../kernel/shared/types';
import { agentAgyClientPlugin } from './agent-agy/client';
import { AGENT_AGY_MANIFEST } from './agent-agy/manifest';
import { hudTokenBarClientPlugin } from './hud-token-bar/client';
import { HUD_TOKEN_BAR_MANIFEST } from './hud-token-bar/manifest';
import { paneChatClientPlugin } from './pane-chat/client';
import { PANE_CHAT_MANIFEST } from './pane-chat/manifest';
import { runtimeContextInspectorClientPlugin } from './runtime-context-inspector/client';
import { RUNTIME_CONTEXT_INSPECTOR_MANIFEST } from './runtime-context-inspector/manifest';
import { sidebarWorkspaceClientPlugin } from './sidebar-workspace/client';
import { SIDEBAR_WORKSPACE_MANIFEST } from './sidebar-workspace/manifest';

/**
 * Wave 2 Agent & Data Client plugin packages (5 bundled plugins).
 * Registered into Renderer via `bootstrapClientKernel({ builtins: [...AGENT_CLIENT_PLUGINS, ...] })`.
 */
export const AGENT_CLIENT_PLUGINS: BuiltinPluginPackage[] = [
  {
    manifest: AGENT_AGY_MANIFEST,
    client: agentAgyClientPlugin as ClientPluginModule,
  },
  {
    manifest: PANE_CHAT_MANIFEST,
    client: paneChatClientPlugin as ClientPluginModule,
  },
  {
    manifest: HUD_TOKEN_BAR_MANIFEST,
    client: hudTokenBarClientPlugin as ClientPluginModule,
  },
  {
    manifest: SIDEBAR_WORKSPACE_MANIFEST,
    client: sidebarWorkspaceClientPlugin as ClientPluginModule,
  },
  {
    manifest: RUNTIME_CONTEXT_INSPECTOR_MANIFEST,
    client: runtimeContextInspectorClientPlugin as ClientPluginModule,
  },
];
