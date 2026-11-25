import os from 'node:os';
import type { AccountQuotaSnapshot, QuotaBucket } from '../../../src/shared/types';
import {
  buildClaudeSpawnEnv,
  hasManagedMcpJson,
  loadClaudeAgentSdk,
  resolveClaudeBinary,
  suppressClaudeShadowedWarning,
} from './env';

interface RawRateLimitWindow {
  utilization?: number | null;
  resets_at?: string | null;
}

interface RawModelScopedLimit {
  display_name?: string;
  utilization?: number | null;
  resets_at?: string | null;
}

interface RawUsageResponse {
  rate_limits_available?: boolean;
  rate_limits?: {
    five_hour?: RawRateLimitWindow | null;
    seven_day?: RawRateLimitWindow | null;
    model_scoped?: RawModelScopedLimit[] | null;
  } | null;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function computeResetInSeconds(iso?: string | null): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  return Math.max(0, Math.round((ms - Date.now()) / 1000));
}

function makeBucket(
  id: string,
  groupName: string,
  window: '5h' | 'weekly',
  utilizationPct: number | null | undefined,
  resetsAt: string | null | undefined
): QuotaBucket | null {
  if (utilizationPct == null || !Number.isFinite(utilizationPct)) return null;
  const remainingFraction = clamp01(1 - utilizationPct / 100);
  return {
    id,
    group: 'claude',
    groupName,
    window,
    remainingFraction,
    resetInSeconds: computeResetInSeconds(resetsAt),
    resetTime: resetsAt ?? null,
  };
}

/**
 * Clean, zero-telemetry Claude quota tracker ported from t3code `claudeUsageLimits.ts` + `ClaudeProvider.ts`.
 * Uses the zero-API-call SDK control RPC `get_usage({ skipBehaviors: true })` so macOS Keychain OAuth
 * works seamlessly with zero Keychain prompts and zero user hooks executed (`disableAllHooks: true`).
 */
export class ClaudeQuotaService {
  private snapshot: AccountQuotaSnapshot = { adapterId: 'agent-claude', buckets: [], updatedAt: null };
  private inflight: Promise<AccountQuotaSnapshot> | null = null;
  private lastFetchAt = 0;
  private listeners = new Set<(snap: AccountQuotaSnapshot) => void>();
  private primaryScopedModelName: string | null = null;
  private readonly getConfigDir: () => string;
  private readonly getCliPath: () => string;

  constructor(opts: { getConfigDir: () => string; getCliPath: () => string }) {
    this.getConfigDir = opts.getConfigDir;
    this.getCliPath = opts.getCliPath;
  }

  getCachedSnapshot(): AccountQuotaSnapshot {
    return this.snapshot;
  }

  onChange(cb: (snap: AccountQuotaSnapshot) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emitChange(): void {
    for (const cb of this.listeners) {
      try {
        cb(this.snapshot);
      } catch {
        // isolate listener error
      }
    }
  }

  /** Merges live `rate_limit_event` stream frames (`utilization` is 0..1, `resetsAt` is epoch seconds!). */
  applyStreamRateLimitEvent(info: Record<string, unknown>): void {
    const rateLimitType = String(info.rateLimitType || info.rate_limit_type || '');
    const rawUtil = typeof info.utilization === 'number' ? info.utilization : null;
    const rawResetsAt = typeof info.resetsAt === 'number' ? info.resetsAt : null;
    if (rawUtil == null || !Number.isFinite(rawUtil)) return;

    // Stream event reports 0..1 scale; convert to 0..100
    const utilizationPct = rawUtil <= 1 ? rawUtil * 100 : rawUtil;
    const resetIso = rawResetsAt && rawResetsAt > 0 ? new Date(rawResetsAt * 1000).toISOString() : null;

    let bucket: QuotaBucket | null = null;
    if (rateLimitType === 'five_hour') {
      bucket = makeBucket('claude-5h', 'Claude Code', '5h', utilizationPct, resetIso);
    } else if (rateLimitType === 'seven_day') {
      bucket = makeBucket('claude-weekly', 'Claude Code', 'weekly', utilizationPct, resetIso);
    } else if (rateLimitType === 'seven_day_overage_included' && this.primaryScopedModelName) {
      const slug = this.primaryScopedModelName.toLowerCase().replace(/[^a-z0-9]+/g, '_');
      bucket = makeBucket(
        `claude-weekly-${slug}`,
        `Claude · ${this.primaryScopedModelName}`,
        'weekly',
        utilizationPct,
        resetIso
      );
    }

    if (!bucket) return;
    const existing = this.snapshot.buckets.filter((b) => b.id !== bucket!.id);
    this.snapshot = {
      adapterId: 'agent-claude',
      buckets: [...existing, bucket],
      updatedAt: new Date().toISOString(),
    };
    this.emitChange();
  }

  async fetchLiveQuota(force = false): Promise<AccountQuotaSnapshot> {
    const now = Date.now();
    if (!force && this.snapshot.buckets.length > 0 && now - this.lastFetchAt < 60_000) {
      return this.snapshot;
    }
    if (this.inflight) return this.inflight;

    this.inflight = this.runSdkUsageProbe()
      .then((snap) => {
        this.lastFetchAt = Date.now();
        if (snap.buckets.length > 0 || !this.snapshot.buckets.length) {
          this.snapshot = snap;
          this.emitChange();
        }
        return this.snapshot;
      })
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        if (!this.snapshot.buckets.length) {
          this.snapshot = { adapterId: 'agent-claude', buckets: [], updatedAt: null, error: msg };
        }
        return this.snapshot;
      })
      .finally(() => {
        this.inflight = null;
      });

    return this.inflight;
  }

  private async runSdkUsageProbe(): Promise<AccountQuotaSnapshot> {
    suppressClaudeShadowedWarning();
    const sdk = await loadClaudeAgentSdk();
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), 18_000);

    // Never-yielding prompt iterable -> zero Anthropic completion calls, control IPC only
    async function* idlePrompt() {
      await new Promise<void>((resolve) => {
        if (abortController.signal.aborted) {
          resolve();
          return;
        }
        abortController.signal.addEventListener('abort', () => resolve(), { once: true });
      });
    }

    const strictMcp = !hasManagedMcpJson();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let q: any = null;
    try {
      q = sdk.query({
        prompt: idlePrompt(),
        options: {
          cwd: os.homedir(),
          pathToClaudeCodeExecutable: resolveClaudeBinary(this.getCliPath()),
          env: buildClaudeSpawnEnv({ configDir: this.getConfigDir(), isProbe: true }),
          persistSession: false,
          settingSources: ['user', 'project', 'local'],
          settings: { disableAllHooks: true },
          allowedTools: [],
          mcpServers: {},
          ...(strictMcp ? { strictMcpConfig: true } : {}),
          abortController,
        },
      });

      await q.initializationResult();
      const usageFn = q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
      if (typeof usageFn !== 'function') {
        return {
          adapterId: 'agent-claude',
          buckets: [],
          updatedAt: null,
          error: '현재 Claude Code SDK에서 get_usage RPC를 지원하지 않습니다.',
        };
      }

      const raw = (await usageFn.call(q, { skipBehaviors: true })) as RawUsageResponse;
      const buckets: QuotaBucket[] = [];
      const rl = raw?.rate_limits;
      if (rl?.five_hour) {
        const b = makeBucket('claude-5h', 'Claude Code', '5h', rl.five_hour.utilization, rl.five_hour.resets_at);
        if (b) buckets.push(b);
      }
      if (rl?.seven_day) {
        const b = makeBucket('claude-weekly', 'Claude Code', 'weekly', rl.seven_day.utilization, rl.seven_day.resets_at);
        if (b) buckets.push(b);
      }
      if (Array.isArray(rl?.model_scoped) && rl.model_scoped.length > 0) {
        const first = rl.model_scoped[0];
        if (first?.display_name) this.primaryScopedModelName = first.display_name;
        for (const scoped of rl.model_scoped) {
          if (!scoped?.display_name) continue;
          const slug = scoped.display_name.toLowerCase().replace(/[^a-z0-9]+/g, '_');
          const b = makeBucket(
            `claude-weekly-${slug}`,
            `Claude · ${scoped.display_name}`,
            'weekly',
            scoped.utilization,
            scoped.resets_at
          );
          if (b) buckets.push(b);
        }
      }

      return {
        adapterId: 'agent-claude',
        buckets,
        updatedAt: new Date().toISOString(),
        ...(buckets.length === 0 && raw?.rate_limits_available === false
          ? { error: 'API 키 모드이거나 구독 한도 정보를 사용할 수 없습니다.' }
          : {}),
      };
    } finally {
      clearTimeout(timeout);
      abortController.abort();
      try {
        q?.close?.();
      } catch {
        // ignore close errors
      }
    }
  }

  dispose(): void {
    this.listeners.clear();
  }
}
