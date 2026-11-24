import type { AccountQuotaSnapshot, AgyEvent, TerminalEvent } from '../src/shared/types';

export type DeskBusChannelMap = {
  'agy:event': AgyEvent;
  'terminal:event': TerminalEvent;
  'quota:updated': AccountQuotaSnapshot;
  'webview:new-tab': string;
};

export type DeskBusChannel = keyof DeskBusChannelMap;

/**
 * Thin pub/sub event bus inside Electron Main.
 * Currently fans out to Electron IPC (Mojo); a future WebSocket adapter can attach
 * via `subscribeAll()` without modifying any bridge or producer.
 */
export class DeskEventBus {
  private handlers = new Map<DeskBusChannel, Set<(payload: unknown) => void>>();
  private wildcard = new Set<(channel: DeskBusChannel, payload: unknown) => void>();

  publish<C extends DeskBusChannel>(channel: C, payload: DeskBusChannelMap[C]): void {
    const set = this.handlers.get(channel);
    if (set) {
      for (const fn of set) {
        try {
          fn(payload);
        } catch {
          // isolate subscriber failures
        }
      }
    }
    for (const fn of this.wildcard) {
      try {
        fn(channel, payload);
      } catch {
        // isolate subscriber failures
      }
    }
  }

  subscribe<C extends DeskBusChannel>(channel: C, fn: (payload: DeskBusChannelMap[C]) => void): () => void {
    let set = this.handlers.get(channel);
    if (!set) {
      set = new Set();
      this.handlers.set(channel, set);
    }
    set.add(fn as (payload: unknown) => void);
    return () => {
      set?.delete(fn as (payload: unknown) => void);
    };
  }

  subscribeAll(fn: (channel: DeskBusChannel, payload: unknown) => void): () => void {
    this.wildcard.add(fn);
    return () => {
      this.wildcard.delete(fn);
    };
  }
}
