import fs from 'node:fs';
import path from 'node:path';
import type { BuiltinPluginPackage, DeskHostContext, HostPluginModule } from '../../../src/kernel/shared/types';
import { PLUGIN_STUDIO_MANIFEST } from '../../../src/plugins/plugin-studio/manifest';

const pluginStudioHost: HostPluginModule = {
  activate(ctx: DeskHostContext) {
    // Allow Plugin Studio & X-Ray to open local plugin or Layer 2 asset paths in Finder
    ctx.rpc.handle<{ targetPath: string }, { ok: boolean; error?: string }>(
      'plugin-studio:reveal-path',
      async ({ targetPath }) => {
        if (!targetPath || typeof targetPath !== 'string') {
          return { ok: false, error: '경로가 비어 있습니다.' };
        }
        const resolved = path.resolve(targetPath.replace(/^~(?=\/|$)/, ctx.host.homeDir));
        if (!fs.existsSync(resolved)) {
          return { ok: false, error: `경로를 찾을 수 없습니다: ${resolved}` };
        }
        ctx.host.showInFolder(resolved);
        return { ok: true };
      }
    );

    // Directory picker bridge for SchemaSettingsForm inside Plugin Studio right-hand inspector
    ctx.rpc.handle<void, string | null>('plugin-studio:pick-directory', async () => {
      return ctx.host.pickDirectory();
    });

    // Helper to locate bundled sample local plugin directory for quick exploration
    ctx.rpc.handle<void, { path: string | null }>('plugin-studio:get-sample-plugin-path', async () => {
      const candidates = [
        path.resolve(process.cwd(), 'examples', 'sample-focus-timer'),
        path.resolve(__dirname, '..', '..', '..', 'examples', 'sample-focus-timer'),
        path.resolve(__dirname, '..', 'examples', 'sample-focus-timer'),
      ];
      for (const c of candidates) {
        if (fs.existsSync(path.join(c, 'desk-plugin.json'))) {
          return { path: c };
        }
      }
      return { path: null };
    });
  },
};

export const pluginStudioHostPackage: BuiltinPluginPackage = {
  manifest: PLUGIN_STUDIO_MANIFEST,
  host: pluginStudioHost,
};
