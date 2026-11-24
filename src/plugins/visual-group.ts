import type { BuiltinPluginPackage } from '../kernel/shared/types';
import { pluginStudioClientPackage } from './plugin-studio';

export const VISUAL_CLIENT_PLUGINS: readonly BuiltinPluginPackage[] = [pluginStudioClientPackage];

export { pluginStudioClientPackage };
export { usePluginStudioUiStore } from './plugin-studio/studioState';
