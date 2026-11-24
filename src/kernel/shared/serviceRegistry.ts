import type { Disposer, ServiceRegistry } from './types';

interface ProviderEntry {
  id: string;
  pluginId: string;
  impl: unknown;
}

interface WatcherEntry {
  id: string;
  token: string;
  cb: (impl: unknown, providerPluginId: string) => Disposer | void;
  activeCleanups: Map<string, Disposer>; // providerEntry.id -> cleanup disposer
}

/**
 * Lightweight reactive ServiceRegistry (Cordis-inspired without framework lock-in).
 * Shared by both Electron Main (Host) and Renderer (Client).
 * When a provider plugin toggles ON/OFF dynamically, `whenAvailable()` listeners
 * automatically run or unwind their returned cleanup disposer.
 */
export class KernelServiceRegistry {
  private providers = new Map<string, ProviderEntry[]>();
  private watchers = new Map<string, WatcherEntry[]>();
  private seq = 0;

  private onChangeListeners = new Set<() => void>();

  onBindingsChange(cb: () => void): Disposer {
    this.onChangeListeners.add(cb);
    return () => {
      this.onChangeListeners.delete(cb);
    };
  }

  createScopedView(pluginId: string, registerDisposer?: (d: Disposer, label?: string) => Disposer): ServiceRegistry {
    const track = (d: Disposer, label: string): Disposer =>
      registerDisposer ? registerDisposer(d, label) : d;

    return {
      provide: <T>(token: string, impl: T): Disposer =>
        track(this.provideFor(pluginId, token, impl), `service:provide:${token}`),
      get: <T>(token: string): T | undefined => this.get<T>(token),
      getAll: <T>(token: string): Array<{ pluginId: string; impl: T }> => this.getAll<T>(token),
      whenAvailable: <T>(token: string, cb: (impl: T, providerPluginId: string) => Disposer | void): Disposer =>
        track(this.whenAvailable(token, cb), `service:watch:${token}`),
      getBindingsSnapshot: () => this.getBindingsSnapshot(),
    };
  }

  provideFor<T>(pluginId: string, token: string, impl: T): Disposer {
    const entry: ProviderEntry = {
      id: `svc-${++this.seq}`,
      pluginId,
      impl,
    };
    let list = this.providers.get(token);
    if (!list) {
      list = [];
      this.providers.set(token, list);
    }
    list.push(entry);

    // Notify existing watchers
    const watchList = this.watchers.get(token);
    if (watchList) {
      for (const w of watchList) {
        this.invokeWatcher(w, entry);
      }
    }
    this.emitBindingsChange();

    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      const cur = this.providers.get(token);
      if (cur) {
        const idx = cur.findIndex((p) => p.id === entry.id);
        if (idx !== -1) cur.splice(idx, 1);
        if (cur.length === 0) this.providers.delete(token);
      }
      const ws = this.watchers.get(token);
      if (ws) {
        for (const w of ws) {
          const cleanup = w.activeCleanups.get(entry.id);
          if (cleanup) {
            w.activeCleanups.delete(entry.id);
            try {
              void cleanup();
            } catch (err) {
              console.error(`[ServiceRegistry] cleanup failed for "${token}":`, err);
            }
          }
        }
      }
      this.emitBindingsChange();
    };
  }

  get<T>(token: string): T | undefined {
    const list = this.providers.get(token);
    if (!list || list.length === 0) return undefined;
    return list[list.length - 1].impl as T;
  }

  getAll<T>(token: string): Array<{ pluginId: string; impl: T }> {
    const list = this.providers.get(token);
    if (!list) return [];
    return list.map((e) => ({ pluginId: e.pluginId, impl: e.impl as T }));
  }

  whenAvailable<T>(token: string, cb: (impl: T, providerPluginId: string) => Disposer | void): Disposer {
    const watcher: WatcherEntry = {
      id: `watch-${++this.seq}`,
      token,
      cb: cb as (impl: unknown, providerPluginId: string) => Disposer | void,
      activeCleanups: new Map(),
    };
    let list = this.watchers.get(token);
    if (!list) {
      list = [];
      this.watchers.set(token, list);
    }
    list.push(watcher);

    const existing = this.providers.get(token);
    if (existing) {
      for (const p of existing) {
        this.invokeWatcher(watcher, p);
      }
    }

    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      const cur = this.watchers.get(token);
      if (cur) {
        const idx = cur.findIndex((w) => w.id === watcher.id);
        if (idx !== -1) cur.splice(idx, 1);
        if (cur.length === 0) this.watchers.delete(token);
      }
      for (const cleanup of watcher.activeCleanups.values()) {
        try {
          void cleanup();
        } catch (err) {
          console.error(`[ServiceRegistry] watcher dispose failed for "${token}":`, err);
        }
      }
      watcher.activeCleanups.clear();
    };
  }

  getBindingsSnapshot(): Record<string, string[]> {
    const snap: Record<string, string[]> = {};
    for (const [token, list] of this.providers.entries()) {
      snap[token] = list.map((e) => e.pluginId);
    }
    return snap;
  }

  private invokeWatcher(watcher: WatcherEntry, entry: ProviderEntry): void {
    try {
      const cleanup = watcher.cb(entry.impl, entry.pluginId);
      if (typeof cleanup === 'function') {
        watcher.activeCleanups.set(entry.id, cleanup);
      }
    } catch (err) {
      console.error(`[ServiceRegistry] watcher callback failed for "${watcher.token}":`, err);
    }
  }

  private emitBindingsChange(): void {
    for (const cb of this.onChangeListeners) {
      try {
        cb();
      } catch {
        // isolate listener failure
      }
    }
  }
}
