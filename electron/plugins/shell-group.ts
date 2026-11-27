import type { BuiltinPluginPackage } from '../../src/kernel/shared/types';
import { paneLauncherManifest } from '../../src/plugins/pane-launcher/manifest';
import { shortcutsPaletteManifest } from '../../src/plugins/shortcuts-palette/manifest';
import { themeAppearanceManifest } from '../../src/plugins/theme-appearance/manifest';
import { appUpdaterHostPackage } from './app-updater';
import { macosSystemShellHostPackage } from './macos-system-shell';
import { notifyFeedbackHostPackage } from './notify-feedback';
import { paneArtifactHostPackage } from './pane-artifact';
import { paneGitDiffHostPackage } from './pane-git-diff';
import { paneTerminalHostPackage } from './pane-terminal';
import { paneWebviewHostPackage } from './pane-webview';

/**
 * Wave 2 Shell & Workspace Utility Plugins (Host registration bundle — all 8 plugins).
 * Includes manifests of client-only plugins so HostPluginManager owns lifecycle,
 * config persistence, and introspection uniformly across all 8 plugins.
 */
export const SHELL_HOST_PLUGINS: readonly BuiltinPluginPackage[] = [
  paneWebviewHostPackage,
  paneTerminalHostPackage,
  paneGitDiffHostPackage,
  paneArtifactHostPackage,
  { manifest: paneLauncherManifest },
  { manifest: themeAppearanceManifest },
  notifyFeedbackHostPackage,
  macosSystemShellHostPackage,
  appUpdaterHostPackage,
  { manifest: shortcutsPaletteManifest },
];
