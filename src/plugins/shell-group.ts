import type { BuiltinPluginPackage } from '../kernel/client';
import { macosSystemShellClientPackage } from './macos-system-shell';
import { notifyFeedbackClientPackage } from './notify-feedback';
import { paneGitDiffClientPackage } from './pane-git-diff';
import { paneLauncherClientPackage } from './pane-launcher';
import { paneTerminalClientPackage } from './pane-terminal';
import { paneWebviewClientPackage } from './pane-webview';
import { shortcutsPaletteClientPackage } from './shortcuts-palette';
import { themeAppearanceClientPackage } from './theme-appearance';

/**
 * Wave 2 Shell & Workspace Utility Plugins (Client registration bundle — all 8 plugins).
 */
export const SHELL_CLIENT_PLUGINS: readonly BuiltinPluginPackage[] = [
  paneWebviewClientPackage,
  paneTerminalClientPackage,
  paneGitDiffClientPackage,
  paneLauncherClientPackage,
  themeAppearanceClientPackage,
  notifyFeedbackClientPackage,
  macosSystemShellClientPackage,
  shortcutsPaletteClientPackage,
];
