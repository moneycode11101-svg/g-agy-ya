import { BrowserWindow, dialog } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BuiltinPluginPackage, DeskHostContext, HostPluginModule } from '../../src/kernel/shared/types';
import { AGENT_AGY_MANIFEST } from '../../src/plugins/agent-agy/manifest';
import { AGENT_CLAUDE_MANIFEST } from '../../src/plugins/agent-claude/manifest';
import { AGENT_CODEX_MANIFEST } from '../../src/plugins/agent-codex/manifest';
import { HUD_TOKEN_BAR_MANIFEST } from '../../src/plugins/hud-token-bar/manifest';
import { PANE_CHAT_MANIFEST } from '../../src/plugins/pane-chat/manifest';
import { RUNTIME_CONTEXT_INSPECTOR_MANIFEST } from '../../src/plugins/runtime-context-inspector/manifest';
import { SIDEBAR_WORKSPACE_MANIFEST } from '../../src/plugins/sidebar-workspace/manifest';
import { agentAgyHostPlugin } from './agent-agy/host';
import { agentClaudeHostPlugin } from './agent-claude/host';
import { agentCodexHostPlugin } from './agent-codex/host';

/** Minimal host half for `pane-chat` (directory/file picker, clipboard image paste & external links) */
const paneChatHostPlugin: HostPluginModule = {
  activate(ctx: DeskHostContext) {
    ctx.rpc.handle<void, string | null>('pane-chat:pickDirectory', () => ctx.host.pickDirectory());
    ctx.rpc.handle<void, string[]>('pane-chat:pickFiles', async () => {
      const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || null;
      const res = win
        ? await dialog.showOpenDialog(win, {
            title: '첨부할 파일 또는 이미지 선택',
            properties: ['openFile', 'multiSelections'],
          })
        : await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'] });
      return res.canceled ? [] : res.filePaths;
    });
    ctx.rpc.handle<{ dataUrl: string; ext?: string }, string | null>(
      'pane-chat:saveClipboardImage',
      async ({ dataUrl, ext }) => {
        if (!dataUrl || !dataUrl.startsWith('data:image/')) return null;
        const comma = dataUrl.indexOf(',');
        if (comma === -1) return null;
        const buf = Buffer.from(dataUrl.slice(comma + 1), 'base64');
        const dir = path.join(os.homedir(), '.gemini', 'antigravity', 'agy-desk-paste');
        fs.mkdirSync(dir, { recursive: true });
        const safeExt = (ext || 'png').replace(/[^a-z0-9]/gi, '').toLowerCase() || 'png';
        const outPath = path.join(dir, `paste-${Date.now().toString(36)}.${safeExt}`);
        fs.writeFileSync(outPath, buf);
        return outPath;
      }
    );
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
    manifest: AGENT_CLAUDE_MANIFEST,
    host: agentClaudeHostPlugin as HostPluginModule,
  },
  {
    manifest: AGENT_CODEX_MANIFEST,
    host: agentCodexHostPlugin as HostPluginModule,
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
