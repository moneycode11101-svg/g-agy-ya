import { create } from 'zustand';
import { KernelServiceRegistry } from '../shared/serviceRegistry';
import type {
  BuiltinPluginPackage,
  ClientPluginModule,
  ConfigNamespace,
  ContextMenuItemDescriptor,
  DeskClientContext,
  Disposer,
  EffectScope,
  EventEnvelope,
  IntrospectionCommand,
  IntrospectionDelta,
  KernelIntrospectionSnapshot,
  KernelPluginLifecycleEvent,
  PluginBootstrapItem,
  PluginErrorRecord,
} from '../shared/types';
import { useCommandRegistry } from './commandRegistry';
import { useLayoutStore } from './layoutStore';
import { getDeskKernelBridge } from './sharedRuntime';
import { useSlotRegistry } from './slotRegistry';

// ============================================================================
// 1. Client-side EffectScope (LIFO deterministic cleanup)
// ============================================================================

class ClientEffectScope implements EffectScope {
  private entries: Array<{ id: string; label: string; createdAt: number; disposer: Disposer }> = [];
  private disposed = false;
  private seq = 0;
  private readonly owner: string;

  constructor(owner: string) {
    this.owner = owner;
  }

  effect(setup: () => Disposer | void, label?: string): Disposer {
    if (this.disposed) return () => {};
    const maybe = setup();
    return typeof maybe === 'function' ? this.onDispose(maybe, label) : () => {};
  }

  onDispose(disposer: Disposer, label?: string): Disposer {
    if (this.disposed) {
      try {
        void disposer();
      } catch {
        // ignore
      }
      return () => {};
    }
    const id = `${this.owner}#${++this.seq}`;
    const entry = { id, label: label || `client-disposer-${this.seq}`, createdAt: Date.now(), disposer };
    this.entries.push(entry);
    let called = false;
    return () => {
      if (called) return;
      called = true;
      const idx = this.entries.findIndex((e) => e.id === id);
      if (idx !== -1) this.entries.splice(idx, 1);
      try {
        return disposer();
      } catch (err) {
        console.error(`[ClientEffectScope:${this.owner}] dispose "${entry.label}" failed:`, err);
        return undefined;
      }
    };
  }

  listActive() {
    return this.entries.map(({ id, label, createdAt }) => ({ id, label, createdAt }));
  }

  size() {
    return this.entries.length;
  }

  async disposeAll(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const entry of this.entries.splice(0).reverse()) {
      try {
        await entry.disposer();
      } catch (err) {
        console.error(`[ClientEffectScope:${this.owner}] disposeAll "${entry.label}" failed:`, err);
      }
    }
  }
}

// ============================================================================
// 2. Reactive Plugin Config Store & Live Introspection Store
// ============================================================================

interface PluginConfigStoreState {
  configsByPlugin: Record<string, Record<string, unknown>>;
  setPluginConfig: (pluginId: string, config: Record<string, unknown>) => void;
}

export const usePluginConfigStore = create<PluginConfigStoreState>((set) => ({
  configsByPlugin: {},
  setPluginConfig: (pluginId, config) =>
    set((s) => ({
      configsByPlugin: { ...s.configsByPlugin, [pluginId]: config },
    })),
}));

export interface ToastItem {
  readonly id: string;
  readonly message: string;
  readonly level: 'info' | 'warn' | 'error';
  readonly createdAt: number;
}

interface IntrospectionStoreState {
  snapshot: KernelIntrospectionSnapshot | null;
  loading: boolean;
  toasts: ToastItem[];
  xrayActive: boolean;
  subscriberCount: number;
  unsubBridge: (() => void) | null;

  pushToast: (message: string, level?: 'info' | 'warn' | 'error') => void;
  dismissToast: (id: string) => void;
  setXrayActive: (active: boolean) => void;
  toggleXray: () => void;
  /** Reference-counted live subscription: Main 10Hz telemetry runs ONLY while subscriberCount > 0 */
  acquireLiveSubscription: () => () => void;
  refreshSnapshot: () => Promise<void>;
  sendCommand: (cmd: IntrospectionCommand) => Promise<{ ok: boolean; error?: string; data?: unknown }>;
}

export const useIntrospectionStore = create<IntrospectionStoreState>((set, get) => ({
  snapshot: null,
  loading: false,
  toasts: [],
  xrayActive: false,
  subscriberCount: 0,
  unsubBridge: null,

  pushToast: (message, level = 'info') => {
    const id = `toast-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    set((s) => ({
      toasts: [...s.toasts.slice(-4), { id, message, level, createdAt: Date.now() }],
    }));
    setTimeout(() => {
      get().dismissToast(id);
    }, 4500);
  },

  dismissToast: (id) =>
    set((s) => ({
      toasts: s.toasts.filter((t) => t.id !== id),
    })),

  setXrayActive: (xrayActive) => {
    if (typeof document !== 'undefined') {
      if (xrayActive) document.documentElement.dataset.deskXray = 'true';
      else delete document.documentElement.dataset.deskXray;
    }
    set({ xrayActive });
  },

  toggleXray: () => {
    get().setXrayActive(!get().xrayActive);
  },

  refreshSnapshot: async () => {
    const bridge = getDeskKernelBridge();
    if (!bridge) return;
    set({ loading: true });
    try {
      const snap = await bridge.introspection.getSnapshot();
      set({ snapshot: snap });
    } finally {
      set({ loading: false });
    }
  },

  acquireLiveSubscription: () => {
    const prev = get().subscriberCount;
    set({ subscriberCount: prev + 1 });

    if (prev === 0) {
      const bridge = getDeskKernelBridge();
      if (bridge) {
        void get().refreshSnapshot();
        const unsub = bridge.introspection.subscribe((delta: IntrospectionDelta) => {
          if (delta.type === 'full') {
            set({ snapshot: delta.snapshot });
            return;
          }
          set((s) => {
            if (!s.snapshot) return s;
            if (delta.type === 'plugin') {
              return {
                snapshot: {
                  ...s.snapshot,
                  seq: delta.seq,
                  plugins: { ...s.snapshot.plugins, [delta.plugin.id]: delta.plugin },
                  serviceBindings: delta.serviceBindings ?? s.snapshot.serviceBindings,
                },
              };
            }
            if (delta.type === 'plugin-removed') {
              const nextPlugins = { ...s.snapshot.plugins };
              delete nextPlugins[delta.pluginId];
              return {
                snapshot: { ...s.snapshot, seq: delta.seq, plugins: nextPlugins },
              };
            }
            if (delta.type === 'telemetry') {
              const mergedPulses = [...s.snapshot.recentPulses, ...delta.pulses].slice(-200);
              return {
                snapshot: {
                  ...s.snapshot,
                  seq: delta.seq,
                  timestamp: delta.timestamp,
                  kernel: { ...s.snapshot.kernel, ...delta.kernel },
                  eventEdges: delta.eventEdges,
                  recentPulses: mergedPulses,
                },
              };
            }
            if (delta.type === 'runtime-assets') {
              return {
                snapshot: {
                  ...s.snapshot,
                  seq: delta.seq,
                  runtimeAssetsByAdapter: {
                    ...s.snapshot.runtimeAssetsByAdapter,
                    [delta.adapterPluginId]: delta.projection,
                  },
                },
              };
            }
            if (delta.type === 'profile') {
              return {
                snapshot: { ...s.snapshot, seq: delta.seq, profile: delta.profile },
              };
            }
            return s;
          });
        });
        set({ unsubBridge: unsub });
      }
    }

    let released = false;
    return () => {
      if (released) return;
      released = true;
      const nextCount = Math.max(0, get().subscriberCount - 1);
      if (nextCount === 0) {
        get().unsubBridge?.();
        set({ subscriberCount: 0, unsubBridge: null });
      } else {
        set({ subscriberCount: nextCount });
      }
    };
  },

  sendCommand: async (cmd) => {
    const bridge = getDeskKernelBridge();
    if (!bridge) return { ok: false, error: 'DeskKernelBridge unavailable' };
    return bridge.introspection.sendCommand(cmd);
  },
}));

// ============================================================================
// 3. ClientPluginManager (Built-ins + Dynamic External `desk-plugin://` ESM)
// ============================================================================

interface ActiveClientRecord {
  item: PluginBootstrapItem;
  mod: ClientPluginModule;
  scope: ClientEffectScope;
}

export interface ClientPluginManagerHooks {
  showContextMenu?: (x: number, y: number, items: ContextMenuItemDescriptor[]) => void;
  closeContextMenu?: () => void;
}

function makeClientError(phase: PluginErrorRecord['phase'], err: unknown): PluginErrorRecord {
  return {
    id: `err-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    timestamp: Date.now(),
    phase,
    message: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  };
}

/**
 * Manages client-side activation, live ON/OFF, Compile-Before-Swap client HMR,
 * scoped CSS var/style cleanup, and health telemetry back to Main.
 */
export class ClientPluginManager {
  readonly services = new KernelServiceRegistry();
  private readonly builtins = new Map<string, BuiltinPluginPackage>();
  private readonly active = new Map<string, ActiveClientRecord>();
  private readonly configWatchers = new Map<
    string,
    Set<(next: Record<string, unknown>, prev: Record<string, unknown>) => void>
  >();
  private readonly hooks: ClientPluginManagerHooks;
  private lifecycleUnsub: (() => void) | null = null;
  private layoutUnsub: (() => void) | null = null;
  private localBusListeners = new Map<string, Set<(env: EventEnvelope) => void>>();

  constructor(hooks: ClientPluginManagerHooks = {}) {
    this.hooks = hooks;

    useSlotRegistry.getState().setCallbacks({
      onRenderError: (pluginId, err) => {
        getDeskKernelBridge()?.rpc.notify('kernel:client:report-status', { pluginId, error: err });
      },
      onPluginAction: (action, pluginId) => {
        if (action === 'reload') {
          void useIntrospectionStore.getState().sendCommand({ type: 'plugin:reload', pluginId });
        } else if (action === 'disable') {
          void useIntrospectionStore.getState().sendCommand({ type: 'plugin:toggle', pluginId, enabled: false });
        }
      },
    });
  }

  registerBuiltins(packages: readonly BuiltinPluginPackage[]): void {
    for (const pkg of packages) {
      this.builtins.set(pkg.manifest.id, pkg);
    }
  }

  async boot(): Promise<void> {
    const bridge = getDeskKernelBridge();

    if (!bridge) {
      // Pure browser preview fallback (no Electron preload): activate registered built-in clients directly
      for (const pkg of this.builtins.values()) {
        if (pkg.manifest.defaultEnabled === false) continue;
        const item: PluginBootstrapItem = {
          id: pkg.manifest.id,
          manifest: pkg.manifest,
          origin: 'builtin',
          sourcePath: null,
          enabled: true,
          lifecycleState: 'active',
          revHash: 'builtin',
          clientModuleUrl: null,
          config: this.extractDefaultConfig(pkg),
        };
        usePluginConfigStore.getState().setPluginConfig(item.id, item.config);
        await this.activateClientPlugin(item);
      }
      await useLayoutStore.getState().hydrateWorkspace();
      return;
    }

    const bundle = await bridge.plugins.getBootstrap();
    useSlotRegistry.getState().setSlotOverrides(bundle.slotOverrides || {});

    // Activate all enabled plugins BEFORE hydrating workspace layout (critic #12-5!)
    for (const item of bundle.plugins) {
      usePluginConfigStore.getState().setPluginConfig(item.id, item.config);
      if (item.lifecycleState === 'active') {
        await this.activateClientPlugin(item);
      }
    }

    // Hydrate workspace AFTER plugins register their pane types
    await useLayoutStore.getState().hydrateWorkspace();
    this.reportAllTabCounts();

    // Subscribe to layout changes to keep Main's activeOpenTabsCount / hiddenPreservedTabsCount in sync
    this.layoutUnsub = useLayoutStore.subscribe(() => {
      this.reportAllTabCounts();
    });

    // Subscribe to live Main lifecycle pushes (toggle ON/OFF, HMR client reload, config updates)
    this.lifecycleUnsub = bridge.plugins.onLifecycleEvent((ev) => {
      void this.handleLifecycleEvent(ev);
    });
  }

  async dispose(): Promise<void> {
    this.lifecycleUnsub?.();
    this.lifecycleUnsub = null;
    this.layoutUnsub?.();
    this.layoutUnsub = null;
    for (const pluginId of Array.from(this.active.keys()).reverse()) {
      await this.deactivateClientPlugin(pluginId);
    }
  }

  private async handleLifecycleEvent(ev: KernelPluginLifecycleEvent): Promise<void> {
    if (ev.type === 'slots-override-changed') {
      useSlotRegistry.getState().setSlotOverrides(ev.slotOverrides);
      return;
    }

    if (ev.type === 'plugin-config-changed') {
      const prev = usePluginConfigStore.getState().configsByPlugin[ev.pluginId] || {};
      usePluginConfigStore.getState().setPluginConfig(ev.pluginId, ev.config);
      const watchers = this.configWatchers.get(ev.pluginId);
      if (watchers) {
        for (const cb of watchers) {
          try {
            cb(ev.config, prev);
          } catch {
            // isolate
          }
        }
      }
      return;
    }

    if (ev.type === 'plugin-deactivated') {
      await this.deactivateClientPlugin(ev.pluginId);
      return;
    }

    if (ev.type === 'plugin-activated') {
      usePluginConfigStore.getState().setPluginConfig(ev.plugin.id, ev.plugin.config);
      await this.activateClientPlugin(ev.plugin);
      return;
    }

    if (ev.type === 'plugin-reload-client') {
      const prev = this.active.get(ev.pluginId);
      usePluginConfigStore.getState().setPluginConfig(ev.pluginId, ev.config);
      const nextItem: PluginBootstrapItem | null = prev
        ? { ...prev.item, revHash: ev.revHash, clientModuleUrl: ev.clientModuleUrl, config: ev.config }
        : null;
      await this.deactivateClientPlugin(ev.pluginId);
      if (nextItem) {
        useSlotRegistry.getState().bumpMountKey(ev.pluginId);
        await this.activateClientPlugin(nextItem);
        useIntrospectionStore.getState().pushToast(`${ev.pluginId} 핫리로드 완료 (${ev.revHash.slice(0, 6)})`, 'info');
      }
      return;
    }

    if (ev.type === 'plugin-error') {
      useIntrospectionStore
        .getState()
        .pushToast(`${ev.pluginId} 오류: ${ev.error.message.slice(0, 90)}`, 'error');
    }
  }

  private async activateClientPlugin(item: PluginBootstrapItem): Promise<void> {
    if (this.active.has(item.id)) {
      await this.deactivateClientPlugin(item.id);
    }

    let clientMod: (ClientPluginModule & { __deskPluginCss?: string }) | null = null;

    try {
      if (item.origin === 'builtin') {
        const pkg = this.builtins.get(item.id);
        clientMod = pkg?.client || null;
      } else if (item.clientModuleUrl) {
        // Native browser ESM dynamic import over privileged `desk-plugin://` protocol (sandbox:true safe!)
        const imported = (await import(/* @vite-ignore */ item.clientModuleUrl)) as {
          default?: ClientPluginModule;
          activate?: ClientPluginModule['activate'];
          deactivate?: ClientPluginModule['deactivate'];
          __deskPluginCss?: string;
        };
        if (typeof imported.activate === 'function') {
          clientMod = {
            activate: imported.activate,
            deactivate: imported.deactivate,
            __deskPluginCss: imported.__deskPluginCss,
          };
        } else if (imported.default && typeof imported.default.activate === 'function') {
          clientMod = {
            ...imported.default,
            __deskPluginCss: imported.__deskPluginCss,
          };
        }
      }
    } catch (err) {
      const errRec = makeClientError('load', err);
      getDeskKernelBridge()?.rpc.notify('kernel:client:report-status', {
        pluginId: item.id,
        clientActive: false,
        error: errRec,
      });
      return;
    }

    if (!clientMod) {
      // Host-only plugin (e.g. agent-agy or os-integration) -> completely valid!
      getDeskKernelBridge()?.rpc.notify('kernel:client:report-status', {
        pluginId: item.id,
        clientActive: false,
        occupiedSlots: [],
        clientDisposableCount: 0,
      });
      return;
    }

    const scope = new ClientEffectScope(item.id);
    const ctx = this.createClientContext(item, scope);

    try {
      if (clientMod.__deskPluginCss) {
        ctx.ui.injectStyle(clientMod.__deskPluginCss);
      }
      await clientMod.activate(ctx);
      this.active.set(item.id, { item, mod: clientMod, scope });

      getDeskKernelBridge()?.rpc.notify('kernel:client:report-status', {
        pluginId: item.id,
        clientActive: true,
        occupiedSlots: useSlotRegistry.getState().getOccupiedSlotsForPlugin(item.id),
        clientDisposableCount: scope.size(),
      });
    } catch (err) {
      await scope.disposeAll();
      const errRec = makeClientError('activate', err);
      getDeskKernelBridge()?.rpc.notify('kernel:client:report-status', {
        pluginId: item.id,
        clientActive: false,
        error: errRec,
      });
    }
  }

  private async deactivateClientPlugin(pluginId: string): Promise<void> {
    const rec = this.active.get(pluginId);
    if (!rec) return;
    this.active.delete(pluginId);

    // Prevent stale closures in open context menus (critic #12-10)
    this.hooks.closeContextMenu?.();

    try {
      if (rec.mod.deactivate) {
        await rec.mod.deactivate();
      }
    } catch (err) {
      console.error(`[ClientPluginManager] deactivate("${pluginId}") failed:`, err);
    }

    await rec.scope.disposeAll();

    getDeskKernelBridge()?.rpc.notify('kernel:client:report-status', {
      pluginId,
      clientActive: false,
      occupiedSlots: [],
      clientDisposableCount: 0,
    });
  }

  private createClientContext(item: PluginBootstrapItem, scope: ClientEffectScope): DeskClientContext {
    const pluginId = item.id;
    const bridge = getDeskKernelBridge();

    const publishEvent = <T,>(topic: string, payload: T) => {
      if (bridge) {
        bridge.bus.publish(topic, payload, pluginId);
      } else {
        const env: EventEnvelope<T> = {
          id: `local-${Date.now()}`,
          topic,
          source: pluginId,
          timestamp: Date.now(),
          payload,
        };
        for (const [pat, set] of this.localBusListeners.entries()) {
          if (pat === '*' || pat === topic || (pat.endsWith('*') && topic.startsWith(pat.slice(0, -1)))) {
            for (const fn of set) fn(env);
          }
        }
      }
    };

    const subscribeEvent = <T = unknown,>(pattern: string, handler: (env: EventEnvelope<T>) => void): Disposer => {
      if (bridge) {
        return scope.onDispose(bridge.bus.subscribe(pattern, handler as (env: EventEnvelope) => void), `bus:sub:${pattern}`);
      }
      let set = this.localBusListeners.get(pattern);
      if (!set) {
        set = new Set();
        this.localBusListeners.set(pattern, set);
      }
      const wrapped = handler as (env: EventEnvelope) => void;
      set.add(wrapped);
      return scope.onDispose(() => {
        set?.delete(wrapped);
      }, `bus:sub:${pattern}`);
    };

    const configNs: ConfigNamespace & { useConfig(): Readonly<Record<string, unknown>> } = {
      get: () => usePluginConfigStore.getState().configsByPlugin[pluginId] || item.config || {},
      getKey: (k) => (usePluginConfigStore.getState().configsByPlugin[pluginId] || item.config || {})[k],
      set: async (partial) => {
        const cur = usePluginConfigStore.getState().configsByPlugin[pluginId] || {};
        const optimistic = { ...cur, ...partial };
        usePluginConfigStore.getState().setPluginConfig(pluginId, optimistic);
        if (bridge) {
          const saved = await bridge.rpc.invoke<Record<string, unknown>>('kernel:config:update', {
            pluginId,
            patch: partial,
          });
          usePluginConfigStore.getState().setPluginConfig(pluginId, saved);
          return saved;
        }
        return optimistic;
      },
      onChange: (cb) => {
        let set = this.configWatchers.get(pluginId);
        if (!set) {
          set = new Set();
          this.configWatchers.set(pluginId, set);
        }
        set.add(cb);
        return scope.onDispose(() => {
          set?.delete(cb);
        }, `config:watch:${pluginId}`);
      },
      useConfig: () => usePluginConfigStore((s) => s.configsByPlugin[pluginId] || item.config || {}),
    };

    return {
      pluginId,
      manifest: item.manifest,
      scope,
      services: this.services.createScopedView(pluginId, (d, label) => scope.onDispose(d, label)),
      config: configNs,
      bus: {
        publish: publishEvent,
        subscribe: subscribeEvent,
      },
      rpc: {
        invoke: async <TRes = unknown,>(method: string, payload?: unknown) => {
          if (!bridge) throw new Error(`RPC "${method}" unavailable without Electron bridge`);
          return bridge.rpc.invoke<TRes>(method, payload);
        },
        notify: (method: string, payload?: unknown) => {
          bridge?.rpc.notify(method, payload);
        },
      },
      slots: {
        register: (slotId, contribution) =>
          scope.onDispose(
            useSlotRegistry.getState().registerContribution(pluginId, slotId, contribution),
            `slot:${slotId}:${contribution.id}`
          ),
      },
      panes: {
        registerType: (def) =>
          scope.onDispose(useSlotRegistry.getState().registerPaneType(pluginId, def), `pane:${def.type}`),
        getType: (paneType) => useSlotRegistry.getState().paneTypes[paneType],
        listTypes: () => Object.values(useSlotRegistry.getState().paneTypes),
      },
      commands: {
        register: (cmd) =>
          scope.onDispose(
            useCommandRegistry.getState().register({ ...cmd, pluginId }),
            `command:${cmd.id}`
          ),
        execute: (id, args) => useCommandRegistry.getState().execute(id, args),
      },
      workspace: {
        openTab: (paneType, init, opts) => useLayoutStore.getState().openTab(paneType, init, opts),
        convertTab: (groupId, tabId, paneType, init) =>
          useLayoutStore.getState().convertTab(groupId, tabId, paneType, init),
        focusTab: (groupId, tabId) => useLayoutStore.getState().setActiveTab(groupId, tabId),
        closeTab: (groupId, tabId) => useLayoutStore.getState().closeTab(groupId, tabId),
        getFocusedTab: () => {
          const s = useLayoutStore.getState();
          const grp = s.groups[s.focusedGroupId];
          if (!grp) return null;
          const tab = grp.tabs.find((t) => t.id === grp.activeTabId) || grp.tabs[0];
          return tab ? { groupId: grp.id, tab } : null;
        },
        updateTabState: (groupId, tabId, patch) =>
          useLayoutStore.getState().updateTabState(groupId, tabId, patch),
        updateTabMeta: (groupId, tabId, patch) =>
          useLayoutStore.getState().updateTabMeta(groupId, tabId, patch),
      },
      ui: {
        showContextMenu: (x, y, items) => {
          this.hooks.showContextMenu?.(x, y, items);
        },
        /** Scoped CSS variables with deterministic revert + `theme:changed` event on dispose (critic #12-10) */
        setCssVars: (vars) => {
          if (typeof document === 'undefined') return () => {};
          const root = document.documentElement;
          const prevValues = new Map<string, string>();
          for (const [k, v] of Object.entries(vars)) {
            prevValues.set(k, root.style.getPropertyValue(k));
            root.style.setProperty(k, v);
          }
          publishEvent('theme:changed', { pluginId, keys: Object.keys(vars) });
          return scope.onDispose(() => {
            for (const [k, prevVal] of prevValues.entries()) {
              if (prevVal) root.style.setProperty(k, prevVal);
              else root.style.removeProperty(k);
            }
            publishEvent('theme:changed', { pluginId, reverted: true });
          }, `css-vars:${pluginId}`);
        },
        setRootDatasets: (datasets) => {
          if (typeof document === 'undefined') return () => {};
          const root = document.documentElement;
          const prev = new Map<string, string | undefined>();
          for (const [k, v] of Object.entries(datasets)) {
            prev.set(k, root.dataset[k]);
            root.dataset[k] = v;
          }
          return scope.onDispose(() => {
            for (const [k, old] of prev.entries()) {
              if (old !== undefined) root.dataset[k] = old;
              else delete root.dataset[k];
            }
          }, `root-datasets:${pluginId}`);
        },
        injectStyle: (cssText) => {
          if (typeof document === 'undefined' || !cssText.trim()) return () => {};
          const el = document.createElement('style');
          el.dataset.deskPluginStyle = pluginId;
          el.textContent = cssText;
          document.head.appendChild(el);
          return scope.onDispose(() => {
            el.remove();
          }, `style:${pluginId}`);
        },
        confirm: async (message) => window.confirm(message),
        toast: (msg, level = 'info') => useIntrospectionStore.getState().pushToast(msg, level),
      },
      introspection: bridge?.introspection || {
        getSnapshot: async () => {
          throw new Error('Introspection unavailable without Electron bridge');
        },
        subscribe: () => () => {},
        sendCommand: async () => ({ ok: false, error: 'Unavailable' }),
      },
    };
  }

  private reportAllTabCounts(): void {
    const bridge = getDeskKernelBridge();
    if (!bridge) return;
    const counts = useLayoutStore.getState().getTabCountsByPlugin();
    for (const pluginId of this.active.keys()) {
      const c = counts[pluginId] || { open: 0, hiddenPreserved: 0 };
      bridge.rpc.notify('kernel:client:report-status', {
        pluginId,
        activeOpenTabsCount: c.open,
        hiddenPreservedTabsCount: c.hiddenPreserved,
      });
    }
  }

  private extractDefaultConfig(pkg: BuiltinPluginPackage): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const f of pkg.manifest.configSchema || []) {
      out[f.key] = f.defaultValue;
    }
    return out;
  }
}
