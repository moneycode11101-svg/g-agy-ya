import type { BuiltinPluginPackage, Disposer, HostPluginModule } from '../../../src/kernel/shared/types';
import { macosSystemShellManifest } from '../../../src/plugins/macos-system-shell/manifest';

export const macosSystemShellHost: HostPluginModule = {
  activate(ctx) {
    let powerSaveDisposer: Disposer | null = null;

    const applyConfig = (cfg: Record<string, unknown>) => {
      const keepInMenuBar = cfg.keepInMenuBar !== false;
      const preventSleep = Boolean(cfg.preventSleep);

      ctx.host.setTrayEnabled(keepInMenuBar);

      if (preventSleep && !powerSaveDisposer) {
        powerSaveDisposer = ctx.host.acquirePowerSave('macos-system-shell:preventSleep');
      } else if (!preventSleep && powerSaveDisposer) {
        void powerSaveDisposer();
        powerSaveDisposer = null;
      }
    };

    applyConfig(ctx.config.get());
    ctx.config.onChange((next) => {
      applyConfig(next);
    });

    // Intercept window close on macOS when keepInMenuBar is active (critic #13-4)
    ctx.host.onWindowBeforeClose((ev) => {
      const keepInMenuBar = ctx.config.getKey('keepInMenuBar') !== false;
      if (process.platform === 'darwin' && keepInMenuBar) {
        ev.preventDefault();
        ev.hideWindow();
      }
    });

    // Cleanly disable tray and release power-save lock if plugin is deactivated
    ctx.scope.onDispose(() => {
      ctx.host.setTrayEnabled(false);
      if (powerSaveDisposer) {
        void powerSaveDisposer();
        powerSaveDisposer = null;
      }
    }, 'macos-system-shell-cleanup');
  },
};

export const macosSystemShellHostPackage: BuiltinPluginPackage = {
  manifest: macosSystemShellManifest,
  host: macosSystemShellHost,
};
