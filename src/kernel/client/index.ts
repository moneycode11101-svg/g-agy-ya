import * as sharedTypes from '../shared/types';
import { KernelServiceRegistry } from '../shared/serviceRegistry';
import {
  ClientPluginManager,
  useIntrospectionStore,
  usePluginConfigStore,
  type ClientPluginManagerHooks,
  type ToastItem,
} from './clientPluginManager';
import { installGlobalKeybindingListener, useCommandRegistry } from './commandRegistry';
import { CoreEmptyPane, DormantPanePlaceholder } from './DormantPanePlaceholder';
import { CORE_EMPTY_PANE_TYPE, useLayoutStore } from './layoutStore';
import { SchemaSettingsForm, extractSchemaSearchEntries } from './SchemaSettingsForm';
import {
  ensureKernelPointerShieldCss,
  getDeskKernelBridge,
  initSharedPluginRuntime,
  setXrayPointerShield,
} from './sharedRuntime';
import {
  PluginErrorBoundary,
  PluginMountBoundary,
  SlotOutlet,
  getDomSlotAnchors,
  registerDomSlotAnchor,
  resolveOrderedSlotEntries,
  useSlotRegistry,
} from './slotRegistry';

export * from '../shared/types';
export {
  KernelServiceRegistry,
  ClientPluginManager,
  useIntrospectionStore,
  usePluginConfigStore,
  useCommandRegistry,
  installGlobalKeybindingListener,
  CoreEmptyPane,
  DormantPanePlaceholder,
  CORE_EMPTY_PANE_TYPE,
  useLayoutStore,
  SchemaSettingsForm,
  extractSchemaSearchEntries,
  ensureKernelPointerShieldCss,
  getDeskKernelBridge,
  initSharedPluginRuntime,
  setXrayPointerShield,
  PluginErrorBoundary,
  PluginMountBoundary,
  SlotOutlet,
  getDomSlotAnchors,
  registerDomSlotAnchor,
  resolveOrderedSlotEntries,
  useSlotRegistry,
};
export type { ClientPluginManagerHooks, ToastItem };

/**
 * Complete `@agy-desk/kernel` SDK surface exposed to external local plugins
 * via `window.__DESK_SHARED__['@agy-desk/kernel']` -> `desk-plugin://__host__/%40agy-desk%2Fkernel.mjs`.
 */
export const KERNEL_PUBLIC_SDK: Record<string, unknown> = {
  KERNEL_API_VERSION: sharedTypes.KERNEL_API_VERSION,
  BUILTIN_PLUGIN_IDS: sharedTypes.BUILTIN_PLUGIN_IDS,
  PANE_WIDGET_ANCHORS: sharedTypes.PANE_WIDGET_ANCHORS,
  CORE_EMPTY_PANE_TYPE,
  SlotOutlet,
  PluginMountBoundary,
  PluginErrorBoundary,
  SchemaSettingsForm,
  extractSchemaSearchEntries,
  DormantPanePlaceholder,
  CoreEmptyPane,
  useLayoutStore,
  useSlotRegistry,
  useCommandRegistry,
  useIntrospectionStore,
  usePluginConfigStore,
  getDomSlotAnchors,
  setXrayPointerShield,
};

/**
 * Convenience bootstrapper for Wave 3 `src/main.tsx` / `src/App.tsx`:
 * 1) Publishes frozen React 19 / Zustand / Lucide / Kernel singletons for external plugins
 * 2) Installs global keyboard shortcut listener
 * 3) Registers built-in plugins and activates everything before hydrating workspace layout
 */
export async function bootstrapClientKernel(opts: {
  builtins: readonly sharedTypes.BuiltinPluginPackage[];
  hooks?: ClientPluginManagerHooks;
}): Promise<{ manager: ClientPluginManager; dispose: () => Promise<void> }> {
  initSharedPluginRuntime(KERNEL_PUBLIC_SDK);
  const stopKeys = installGlobalKeybindingListener();
  const manager = new ClientPluginManager(opts.hooks);
  manager.registerBuiltins(opts.builtins);
  await manager.boot();

  return {
    manager,
    dispose: async () => {
      void stopKeys();
      await manager.dispose();
    },
  };
}
