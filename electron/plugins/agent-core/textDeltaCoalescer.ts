/**
 * Pure TypeScript port of t3code's `ProviderTextDeltaCoalescer` (zero Effect-TS, zero telemetry).
 * Buffers rapid streaming deltas on a 50ms window per `(turnId, itemId)` to avoid flooding
 * Electron IPC / React reconciliation while guaranteeing strict ordering on turn completion.
 */

export interface CoalescedFlushEntry {
  readonly turnId: string;
  readonly itemId: string;
  readonly delta: string;
  readonly completed: boolean;
}

export class TextDeltaCoalescer {
  private readonly flushIntervalMs: number;
  private readonly onFlush: (entry: CoalescedFlushEntry) => void;
  private readonly pending = new Map<string, { turnId: string; itemId: string; pendingDelta: string }>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: { flushIntervalMs?: number; onFlush: (entry: CoalescedFlushEntry) => void }) {
    this.flushIntervalMs = Math.max(1, opts.flushIntervalMs ?? 50);
    this.onFlush = opts.onFlush;
  }

  private key(turnId: string, itemId: string): string {
    return `${turnId}\0${itemId}`;
  }

  append(turnId: string, itemId: string, delta: string): void {
    if (!delta) return;
    const k = this.key(turnId, itemId);
    const existing = this.pending.get(k);
    if (existing) {
      existing.pendingDelta += delta;
    } else {
      this.pending.set(k, { turnId, itemId, pendingDelta: delta });
    }
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.flushDirty();
      }, this.flushIntervalMs);
    }
  }

  flushDirty(): void {
    if (this.pending.size === 0) return;
    const entries = [...this.pending.values()];
    this.pending.clear();
    for (const entry of entries) {
      if (entry.pendingDelta) {
        this.onFlush({
          turnId: entry.turnId,
          itemId: entry.itemId,
          delta: entry.pendingDelta,
          completed: false,
        });
      }
    }
  }

  complete(turnId: string, itemId: string, trailingDelta = ''): void {
    const k = this.key(turnId, itemId);
    const existing = this.pending.get(k);
    this.pending.delete(k);
    const combined = (existing?.pendingDelta ?? '') + trailingDelta;
    if (combined) {
      this.onFlush({
        turnId,
        itemId,
        delta: combined,
        completed: true,
      });
    }
  }

  flushTurn(turnId: string): void {
    for (const [k, entry] of [...this.pending.entries()]) {
      if (entry.turnId !== turnId) continue;
      this.pending.delete(k);
      if (entry.pendingDelta) {
        this.onFlush({
          turnId: entry.turnId,
          itemId: entry.itemId,
          delta: entry.pendingDelta,
          completed: true,
        });
      }
    }
  }

  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pending.clear();
  }
}
