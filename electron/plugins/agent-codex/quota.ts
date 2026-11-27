import type { AccountQuotaSnapshot, QuotaBucket, QuotaWindow } from '../../../src/shared/types';
import { loadCachedAdapterQuota, saveCachedAdapterQuota } from '../shared/quotaCache';
import type { CodexAppServerClient } from './rpcClient';

interface RawRateWindow {
  usedPercent?: number;
  resetsAt?: number | null; // epoch seconds
  windowDurationMins?: number | null;
}

interface RawRateLimitSnapshot {
  limitId?: string | null;
  planType?: string | null;
  primary?: RawRateWindow | null;
  secondary?: RawRateWindow | null;
  individualLimit?: { remainingPercent: number; resetsAt: number } | null;
}

interface RawRateLimitsResponse {
  accountId?: string | null;
  ordinaryUsageAllowed?: boolean | null;
  rateLimits?: RawRateLimitSnapshot | null;
  rateLimitsByLimitId?: Record<string, RawRateLimitSnapshot> | null;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function classifyWindow(mins: number | null | undefined, fallback: QuotaWindow): QuotaWindow {
  if (typeof mins === 'number' && Number.isFinite(mins) && mins > 0) {
    if (mins >= 43_200) return 'monthly';
    if (mins >= 10_080) return 'weekly';
    return '5h';
  }
  return fallback;
}

function toBucket(
  id: string,
  groupName: string,
  window: QuotaWindow,
  usedPercent: number,
  resetsAtSec?: number | null
): QuotaBucket {
  const remainingFraction = clamp01(1 - usedPercent / 100);
  const resetMs = typeof resetsAtSec === 'number' && resetsAtSec > 0 ? resetsAtSec * 1000 : null;
  return {
    id,
    group: 'codex',
    groupName,
    window,
    remainingFraction,
    resetInSeconds: resetMs ? Math.max(0, Math.round((resetMs - Date.now()) / 1000)) : null,
    resetTime: resetMs ? new Date(resetMs).toISOString() : null,
  };
}

/**
 * Pure TypeScript Codex quota tracker ported from t3code `codexUsageLimits.ts`.
 * Uses `account/rateLimits/read` (`params: null`) + sparse `account/rateLimits/updated` merging.
 * Strictly filters to main `"codex"` bucket (`limitId === "codex" || !limitId`).
 */
export class CodexQuotaService {
  private snapshot: AccountQuotaSnapshot = { adapterId: 'agent-codex', buckets: [], updatedAt: null };
  private mergedRaw: RawRateLimitSnapshot = {};
  private accountEmail: string | null = null;
  private accountPlanType: string | null = null;
  private listeners = new Set<(snap: AccountQuotaSnapshot) => void>();
  private inflight: Promise<AccountQuotaSnapshot> | null = null;
  private lastFetchAt = 0;
  private readonly getClient: () => CodexAppServerClient;

  constructor(opts: { getClient: () => CodexAppServerClient }) {
    this.getClient = opts.getClient;
    const persisted = loadCachedAdapterQuota('agent-codex');
    if (persisted && persisted.snapshot.buckets.length > 0) {
      this.snapshot = persisted.snapshot;
      if (persisted.email) this.accountEmail = persisted.email;
      if (persisted.planTier) this.accountPlanType = persisted.planTier;
    }
  }

  getCachedSnapshot(): AccountQuotaSnapshot {
    return this.snapshot;
  }

  getAccountMeta(): { email: string | null; planTier: string | null } {
    return { email: this.accountEmail, planTier: this.accountPlanType };
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
        // isolate
      }
    }
  }

  /** Merges sparse `account/rateLimits/updated` notifications without clobbering existing windows. */
  applySparseUpdate(raw: RawRateLimitSnapshot | null | undefined): void {
    if (!raw || typeof raw !== 'object') return;
    // Ignore model-specific secondary buckets so they don't overwrite the primary codex quota UI
    if (raw.limitId && raw.limitId !== 'codex') return;

    this.mergedRaw = {
      ...this.mergedRaw,
      ...(raw.limitId !== undefined ? { limitId: raw.limitId } : {}),
      ...(raw.planType !== undefined ? { planType: raw.planType } : {}),
      ...(raw.primary !== undefined ? { primary: raw.primary } : {}),
      ...(raw.secondary !== undefined ? { secondary: raw.secondary } : {}),
      ...(raw.individualLimit !== undefined ? { individualLimit: raw.individualLimit } : {}),
    };
    if (raw.planType) this.accountPlanType = raw.planType;
    this.rebuildSnapshotFromRaw();
  }

  private rebuildSnapshotFromRaw(): void {
    const raw = this.mergedRaw;
    const plan = String(raw.planType || this.accountPlanType || '').toLowerCase();
    const isFreeOrGo = plan === 'free' || plan === 'go';
    const buckets: QuotaBucket[] = [];

    if (raw.primary && typeof raw.primary.usedPercent === 'number') {
      const win = classifyWindow(raw.primary.windowDurationMins, isFreeOrGo ? 'monthly' : '5h');
      buckets.push(toBucket(`codex-${win}`, 'Codex (GPT)', win, raw.primary.usedPercent, raw.primary.resetsAt));
    }
    if (raw.secondary && typeof raw.secondary.usedPercent === 'number') {
      const win = classifyWindow(raw.secondary.windowDurationMins, 'weekly');
      buckets.push(toBucket(`codex-${win}`, 'Codex (GPT)', win, raw.secondary.usedPercent, raw.secondary.resetsAt));
    }
    if (raw.individualLimit && typeof raw.individualLimit.remainingPercent === 'number') {
      const used = Math.max(0, Math.min(100, 100 - raw.individualLimit.remainingPercent));
      buckets.push(toBucket('codex-credits', 'Codex 크레딧', 'monthly', used, raw.individualLimit.resetsAt));
    }

    if (buckets.length > 0) {
      this.snapshot = {
        adapterId: 'agent-codex',
        buckets,
        updatedAt: new Date().toISOString(),
      };
      saveCachedAdapterQuota('agent-codex', this.snapshot, {
        email: this.accountEmail,
        planTier: this.accountPlanType,
      });
      this.emitChange();
    }
  }

  async fetchLiveQuota(force = false): Promise<AccountQuotaSnapshot> {
    const now = Date.now();
    if (!force && this.snapshot.buckets.length > 0 && now - this.lastFetchAt < 45_000) {
      return this.snapshot;
    }
    if (this.inflight) return this.inflight;

    this.inflight = (async () => {
      try {
        const client = this.getClient();
        await client.ensureStarted();

        // Check account info first (`account/read`)
        try {
          const acct = (await client.request('account/read', {}, 10_000)) as {
            account?: { type?: string; email?: string; planType?: string } | null;
          };
          if (acct?.account) {
            if (acct.account.email) this.accountEmail = acct.account.email;
            if (acct.account.planType) this.accountPlanType = acct.account.planType;
            if (acct.account.type === 'apiKey') {
              return {
                adapterId: 'agent-codex',
                buckets: [],
                updatedAt: new Date().toISOString(),
                error: 'API 키 모드는 5시간/주간 구독 한도가 없습니다.',
              };
            }
          }
        } catch {
          // continue to rateLimits/read
        }

        // CRITICAL: params must be `null` for `account/rateLimits/read`
        const resp = (await client.request('account/rateLimits/read', null, 10_000)) as RawRateLimitsResponse;
        const primarySnap = resp?.rateLimitsByLimitId?.codex ?? resp?.rateLimits ?? null;
        if (primarySnap) {
          this.mergedRaw = primarySnap;
          if (primarySnap.planType) this.accountPlanType = primarySnap.planType;
          this.rebuildSnapshotFromRaw();
        }
        this.lastFetchAt = Date.now();
        return this.snapshot;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!this.snapshot.buckets.length) {
          this.snapshot = { adapterId: 'agent-codex', buckets: [], updatedAt: null, error: msg };
        }
        return this.snapshot;
      } finally {
        this.inflight = null;
      }
    })();

    return this.inflight;
  }

  dispose(): void {
    this.listeners.clear();
  }
}
