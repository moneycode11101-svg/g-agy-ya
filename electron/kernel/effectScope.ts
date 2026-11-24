import type { Disposer, EffectScope } from '../../src/kernel/shared/types';

interface ScopeEntry {
  id: string;
  label: string;
  createdAt: number;
  disposer: Disposer;
}

/**
 * Cordis-inspired deterministic EffectScope.
 * Every resource acquired by a plugin (RPC handler, bus subscription, fs.watch,
 * child process, tray item, power-save lock, UI slot, CSS vars) attaches here
 * and is torn down in LIFO order on deactivate / crash / hot-reload.
 */
export class KernelEffectScope implements EffectScope {
  private entries: ScopeEntry[] = [];
  private disposed = false;
  private seq = 0;
  private readonly owner: string;
  private readonly onError?: (label: string, err: unknown) => void;

  constructor(owner: string, onError?: (label: string, err: unknown) => void) {
    this.owner = owner;
    this.onError = onError;
  }

  effect(setup: () => Disposer | void, label?: string): Disposer {
    if (this.disposed) {
      return () => {};
    }
    const maybeDisposer = setup();
    if (typeof maybeDisposer === 'function') {
      return this.onDispose(maybeDisposer, label);
    }
    return () => {};
  }

  onDispose(disposer: Disposer, label?: string): Disposer {
    if (this.disposed) {
      try {
        void disposer();
      } catch (err) {
        this.onError?.(label || 'late-dispose', err);
      }
      return () => {};
    }

    const id = `${this.owner}#${++this.seq}`;
    const entry: ScopeEntry = {
      id,
      label: label || `disposer-${this.seq}`,
      createdAt: Date.now(),
      disposer,
    };
    this.entries.push(entry);

    let called = false;
    return () => {
      if (called) return;
      called = true;
      const idx = this.entries.findIndex((e) => e.id === id);
      if (idx !== -1) {
        this.entries.splice(idx, 1);
      }
      try {
        return disposer();
      } catch (err) {
        this.onError?.(entry.label, err);
        return undefined;
      }
    };
  }

  listActive(): Array<{ id: string; label: string; createdAt: number }> {
    return this.entries.map(({ id, label, createdAt }) => ({ id, label, createdAt }));
  }

  size(): number {
    return this.entries.length;
  }

  async disposeAll(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    // LIFO teardown so dependent listeners unwind before underlying providers
    const toRun = this.entries.splice(0).reverse();
    for (const entry of toRun) {
      try {
        await entry.disposer();
      } catch (err) {
        this.onError?.(entry.label, err);
      }
    }
  }
}
