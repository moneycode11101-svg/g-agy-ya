import type { BuiltinPluginPackage } from '../../src/kernel/shared/types';
import { pluginStudioHostPackage } from './plugin-studio';

export const VISUAL_HOST_PLUGINS: readonly BuiltinPluginPackage[] = [pluginStudioHostPackage];

export { pluginStudioHostPackage };
