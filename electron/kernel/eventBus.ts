import type {
  BusChannelCategory,
  Disposer,
  EventEdgeMetrics,
  EventEnvelope,
  EventPulseSample,
} from '../../src/kernel/shared/types';

interface BusSubscription {
  readonly id: string;
  readonly pattern: string;
  readonly subscriberId: string;
  readonly handler: (env: EventEnvelope) => void;
}

export interface TelemetryFlushBatch {
  readonly timestamp: number;
  readonly busEventsPerSec: number;
  readonly busSparkline: number[];
  readonly eventEdges: Record<string, EventEdgeMetrics>;
  readonly pulses: EventPulseSample[];
}

function matchesPattern(pattern: string, topic: string): boolean {
  if (pattern === '*' || pattern === topic) return true;
  if (pattern.endsWith('*')) {
    const prefix = pattern.slice(0, -1);
    return topic.startsWith(prefix);
  }
  return false;
}

function classifyTopic(topic: string, isError?: boolean): BusChannelCategory {
  if (isError || topic.includes('error') || topic.includes('crash')) return 'error';
  if (topic.startsWith('agent') || topic.startsWith('agy:') || topic.startsWith('session')) return 'agent';
  if (topic.startsWith('terminal')) return 'terminal';
  if (topic.startsWith('quota') || topic.startsWith('metric') || topic.startsWith('telemetry')) return 'telemetry';
  if (topic.startsWith('workspace') || topic.startsWith('webview') || topic.startsWith('layout')) return 'workspace';
  return 'plugin';
}

function summarizePayload(topic: string, payload: unknown): { summary: string; preview?: Record<string, unknown> } {
  if (payload == null) return { summary: topic };
  if (typeof payload === 'string') {
    return { summary: payload.length > 80 ? `${payload.slice(0, 80)}…` : payload };
  }
  if (typeof payload !== 'object') {
    return { summary: String(payload) };
  }
  const obj = payload as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof obj.type === 'string') parts.push(`type=${obj.type}`);
  if (typeof obj.pluginId === 'string') parts.push(`plugin=${obj.pluginId}`);
  if (typeof obj.tabSessionId === 'string') parts.push(`sess=${obj.tabSessionId.slice(0, 12)}`);
  if (typeof obj.terminalId === 'string') parts.push(`term=${obj.terminalId.slice(0, 10)}`);
  if (typeof obj.error === 'string' && obj.error) parts.push(`err=${obj.error.slice(0, 48)}`);

  // Bounded safe preview (never ship huge text_delta / PTY bytes to telemetry)
  const preview: Record<string, unknown> = {};
  let keys = 0;
  for (const [k, v] of Object.entries(obj)) {
    if (keys >= 8) break;
    if (typeof v === 'string') {
      preview[k] = v.length > 160 ? `${v.slice(0, 160)}… (${v.length} chars)` : v;
    } else if (typeof v === 'number' || typeof v === 'boolean' || v === null) {
      preview[k] = v;
    } else if (Array.isArray(v)) {
      preview[k] = `[Array(${v.length})]`;
    } else if (typeof v === 'object') {
      preview[k] = '[Object]';
    }
    keys++;
  }

  return {
    summary: parts.length > 0 ? parts.join(' · ') : topic,
    preview,
  };
}

/**
 * Open topic pub/sub EventBus with zero-overhead subscriber-gated 10Hz telemetry coalescer.
 * When telemetrySubscribers.size === 0, zero timers run and zero pulse summaries are allocated.
 */
export class KernelEventBus {
  private subs = new Map<string, BusSubscription>();
  private subSeq = 0;
  private eventSeq = 0;

  // Subscriber-gated 10Hz telemetry state
  private telemetryListeners = new Set<(batch: TelemetryFlushBatch) => void>();
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private recentPulses: EventPulseSample[] = [];
  private readonly maxRecentPulses = 200;

  // Pending 100ms coalescing buffers
  private pendingCoalesced = new Map<
    string,
    {
      fromNodeId: string;
      toNodeIds: Set<string>;
      channel: string;
      category: BusChannelCategory;
      count: number;
      lastPayload: unknown;
      lastTimestamp: number;
      isError: boolean;
    }
  >();

  // Rolling 1-second counters for rate calculation & 20-bucket sparkline (500ms/bucket)
  private edgeWindowCounts = new Map<
    string,
    {
      fromNodeId: string;
      toNodeId: string;
      category: BusChannelCategory;
      channels: Set<string>;
      timestamps: number[];
      errorTimestamps: number[];
      lastEventAt: number;
    }
  >();
  private totalWindowTimestamps: number[] = [];
  private sparklineBuckets: number[] = new Array(20).fill(0);
  private currentBucketCount = 0;
  private tickCounter = 0;

  publish<T = unknown>(topic: string, payload: T, source = 'kernel', isError = false): EventEnvelope<T> {
    const now = Date.now();
    const env: EventEnvelope<T> = {
      id: `evt-${++this.eventSeq}`,
      topic,
      source,
      timestamp: now,
      payload,
      isError: isError || undefined,
    };

    const matchedTargets: string[] = [];
    for (const sub of this.subs.values()) {
      if (!matchesPattern(sub.pattern, topic)) continue;
      matchedTargets.push(sub.subscriberId);
      try {
        sub.handler(env);
      } catch (err) {
        console.error(`[KernelEventBus] subscriber "${sub.subscriberId}" failed on "${topic}":`, err);
      }
    }

    // Zero-overhead gate: skip all telemetry bookkeeping when nobody is observing Studio/X-Ray
    if (this.telemetryListeners.size > 0) {
      this.recordTelemetry(env, matchedTargets);
    }

    return env;
  }

  subscribe<T = unknown>(
    pattern: string,
    handler: (env: EventEnvelope<T>) => void,
    subscriberId = 'kernel'
  ): Disposer {
    const id = `sub-${++this.subSeq}`;
    this.subs.set(id, {
      id,
      pattern,
      subscriberId,
      handler: handler as (env: EventEnvelope) => void,
    });
    return () => {
      this.subs.delete(id);
    };
  }

  subscribeTelemetry(listener: (batch: TelemetryFlushBatch) => void): Disposer {
    this.telemetryListeners.add(listener);
    if (!this.flushTimer) {
      this.flushTimer = setInterval(() => this.flushTelemetryTick(), 100);
    }
    return () => {
      this.telemetryListeners.delete(listener);
      if (this.telemetryListeners.size === 0 && this.flushTimer) {
        clearInterval(this.flushTimer);
        this.flushTimer = null;
        this.pendingCoalesced.clear();
      }
    };
  }

  getTelemetrySnapshot(): {
    busEventsPerSec: number;
    busSparkline: number[];
    eventEdges: Record<string, EventEdgeMetrics>;
    recentPulses: EventPulseSample[];
  } {
    const now = Date.now();
    this.pruneWindows(now);
    return {
      busEventsPerSec: this.totalWindowTimestamps.length,
      busSparkline: [...this.sparklineBuckets],
      eventEdges: this.buildEdgeMetrics(now),
      recentPulses: [...this.recentPulses],
    };
  }

  dispose(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    this.subs.clear();
    this.telemetryListeners.clear();
    this.pendingCoalesced.clear();
    this.edgeWindowCounts.clear();
  }

  private recordTelemetry(env: EventEnvelope, targets: string[]): void {
    const category = classifyTopic(env.topic, env.isError);
    const key = `${env.source}::${env.topic}`;
    let bucket = this.pendingCoalesced.get(key);
    if (!bucket) {
      bucket = {
        fromNodeId: env.source,
        toNodeIds: new Set<string>(),
        channel: env.topic,
        category,
        count: 0,
        lastPayload: env.payload,
        lastTimestamp: env.timestamp,
        isError: Boolean(env.isError),
      };
      this.pendingCoalesced.set(key, bucket);
    }
    bucket.count += 1;
    bucket.lastPayload = env.payload;
    bucket.lastTimestamp = env.timestamp;
    if (env.isError) bucket.isError = true;
    for (const t of targets) {
      if (t !== env.source) bucket.toNodeIds.add(t);
    }

    this.totalWindowTimestamps.push(env.timestamp);
    this.currentBucketCount += 1;

    const effectiveTargets = targets.length > 0 ? targets : ['core:bus'];
    for (const target of effectiveTargets) {
      if (target === env.source) continue;
      const edgeId = `${env.source}->${target}:${category}`;
      let edge = this.edgeWindowCounts.get(edgeId);
      if (!edge) {
        edge = {
          fromNodeId: env.source,
          toNodeId: target,
          category,
          channels: new Set<string>(),
          timestamps: [],
          errorTimestamps: [],
          lastEventAt: env.timestamp,
        };
        this.edgeWindowCounts.set(edgeId, edge);
      }
      edge.channels.add(env.topic);
      edge.timestamps.push(env.timestamp);
      if (env.isError) edge.errorTimestamps.push(env.timestamp);
      edge.lastEventAt = env.timestamp;
    }
  }

  private pruneWindows(now: number): void {
    const cutoff1s = now - 1000;
    while (this.totalWindowTimestamps.length > 0 && this.totalWindowTimestamps[0] < cutoff1s) {
      this.totalWindowTimestamps.shift();
    }
    const cutoffIdle = now - 30_000;
    for (const [edgeId, edge] of this.edgeWindowCounts.entries()) {
      while (edge.timestamps.length > 0 && edge.timestamps[0] < cutoff1s) {
        edge.timestamps.shift();
      }
      while (edge.errorTimestamps.length > 0 && edge.errorTimestamps[0] < cutoff1s) {
        edge.errorTimestamps.shift();
      }
      if (edge.timestamps.length === 0 && edge.lastEventAt < cutoffIdle) {
        this.edgeWindowCounts.delete(edgeId);
      }
    }
  }

  private buildEdgeMetrics(now: number): Record<string, EventEdgeMetrics> {
    const out: Record<string, EventEdgeMetrics> = {};
    for (const [edgeId, edge] of this.edgeWindowCounts.entries()) {
      const rate = edge.timestamps.length;
      const pulseIntensity = rate > 0 ? Math.min(1, Math.log2(rate + 1) / 6) : 0;
      out[edgeId] = {
        edgeId,
        fromNodeId: edge.fromNodeId,
        toNodeId: edge.toNodeId,
        category: edge.category,
        channels: Array.from(edge.channels).slice(0, 8),
        eventsPerSec: rate,
        pulseIntensity: now - edge.lastEventAt < 1500 ? Math.max(pulseIntensity, 0.12) : 0,
        lastEventAt: edge.lastEventAt,
        errorRatePerSec: edge.errorTimestamps.length,
      };
    }
    return out;
  }

  private flushTelemetryTick(): void {
    const now = Date.now();
    this.tickCounter += 1;

    // Advance 500ms sparkline bucket every 5 ticks (5 * 100ms)
    if (this.tickCounter % 5 === 0) {
      this.sparklineBuckets.shift();
      this.sparklineBuckets.push(this.currentBucketCount * 2); // normalize to evt/s
      this.currentBucketCount = 0;
    }

    this.pruneWindows(now);

    const newPulses: EventPulseSample[] = [];
    for (const item of this.pendingCoalesced.values()) {
      const { summary, preview } = summarizePayload(item.channel, item.lastPayload);
      const sample: EventPulseSample = {
        id: `pulse-${++this.eventSeq}`,
        timestamp: item.lastTimestamp,
        fromNodeId: item.fromNodeId,
        toNodeIds: Array.from(item.toNodeIds),
        channel: item.channel,
        category: item.category,
        coalescedCount: item.count,
        summary,
        payloadPreview: preview,
        isError: item.isError || undefined,
      };
      newPulses.push(sample);
      this.recentPulses.push(sample);
    }
    this.pendingCoalesced.clear();

    if (this.recentPulses.length > this.maxRecentPulses) {
      this.recentPulses.splice(0, this.recentPulses.length - this.maxRecentPulses);
    }

    // Only broadcast if there are new pulses or every 500ms to refresh decay/sparkline
    if (newPulses.length === 0 && this.tickCounter % 5 !== 0) return;

    const batch: TelemetryFlushBatch = {
      timestamp: now,
      busEventsPerSec: this.totalWindowTimestamps.length,
      busSparkline: [...this.sparklineBuckets],
      eventEdges: this.buildEdgeMetrics(now),
      pulses: newPulses,
    };

    for (const listener of this.telemetryListeners) {
      try {
        listener(batch);
      } catch {
        // isolate telemetry listener errors
      }
    }
  }
}
