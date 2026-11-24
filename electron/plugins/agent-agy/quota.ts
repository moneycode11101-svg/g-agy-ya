import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Disposer } from '../../../src/kernel/shared/types';
import type { AccountQuotaSnapshot, QuotaBucket, QuotaGroupKey, QuotaWindow } from '../../../src/shared/types';

const HOME = os.homedir();
export const LIVE_QUOTA_PATH = path.join(HOME, '.gemini', 'antigravity', 'token-band', 'live-quota.json');
const MIN_REFRESH_GAP_MS = 30_000;

export function resolveAgyBinary(): string {
  const candidates = [
    path.join(HOME, '.local', 'bin', 'agy'),
    '/opt/homebrew/bin/agy',
    '/usr/local/bin/agy',
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return 'agy';
}

export function buildAgySpawnEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: `${path.join(HOME, '.local', 'bin')}:/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ''}`,
  };
}

interface LiveQuotaFile {
  updatedAt?: string;
  email?: string | null;
  planTier?: string | null;
  quota?: Record<
    string,
    {
      remaining_fraction?: number;
      reset_in_seconds?: number;
      reset_time?: string;
      window?: string;
      group?: string;
      group_name?: string;
      disabled?: boolean;
    }
  > | null;
}

interface RawUsageJson {
  status?: string;
  error?: string;
  command?: {
    name?: string;
    data?: {
      groups?: Array<{
        name?: string;
        buckets?: Array<{
          id?: string;
          name?: string;
          window?: string;
          remaining_fraction?: number;
          reset_time?: string;
        }>;
      }>;
    };
  };
}

function inferGroup(id: string, groupName?: string): QuotaGroupKey {
  const s = `${id} ${groupName || ''}`.toLowerCase();
  if (s.includes('gemini')) return 'gemini';
  return 'claude';
}

function inferWindow(id: string, rawWindow?: string): QuotaWindow | undefined {
  const s = `${rawWindow || ''} ${id}`.toLowerCase();
  if (s.includes('5h') || s.includes('five')) return '5h';
  if (s.includes('week')) return 'weekly';
  return undefined;
}

function sortBuckets(buckets: QuotaBucket[]): QuotaBucket[] {
  return [...buckets].sort((a, b) => {
    const gRank = (x: QuotaBucket) => (x.group === 'gemini' ? 0 : 1);
    const wRank = (x: QuotaBucket) => (x.window === '5h' ? 0 : x.window === 'weekly' ? 1 : 2);
    return gRank(a) - gRank(b) || wRank(a) - wRank(b);
  });
}

function computeResetInSeconds(resetTime: string | null): number | null {
  if (!resetTime) return null;
  const ts = Date.parse(resetTime);
  if (Number.isNaN(ts)) return null;
  return Math.max(0, Math.floor((ts - Date.now()) / 1000));
}

/**
 * Single Source of Truth for `~/.gemini/antigravity/token-band/live-quota.json`
 * and `agy -p=/usage --output-format json` sync (eliminates legacy 3x duplicate parsing).
 */
export class AgyQuotaService {
  private cachedSnapshot: AccountQuotaSnapshot | null = null;
  private cachedAccount: { email: string | null; planTier: string | null } = { email: null, planTier: null };
  private lastFetchMs = 0;
  private lastSelfWriteMs = 0;
  private inFlight: Promise<AccountQuotaSnapshot> | null = null;
  private listeners = new Set<(snap: AccountQuotaSnapshot) => void>();
  private watcher: fs.FSWatcher | null = null;
  private watchTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  onChange(cb: (snap: AccountQuotaSnapshot) => void): Disposer {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  getAccountMeta(): { email: string | null; planTier: string | null } {
    if (!this.cachedSnapshot) {
      this.readFromDisk();
    }
    return this.cachedAccount;
  }

  getCachedSnapshot(): AccountQuotaSnapshot {
    if (!this.cachedSnapshot) {
      this.cachedSnapshot = this.readFromDisk();
    }
    return this.cachedSnapshot;
  }

  startWatcher(): Disposer {
    if (this.watcher || this.disposed) return () => {};
    const dir = path.dirname(LIVE_QUOTA_PATH);
    try {
      fs.mkdirSync(dir, { recursive: true });
      this.watcher = fs.watch(dir, (_evType, filename) => {
        if (this.disposed) return;
        if (filename && !filename.includes('live-quota')) return;
        if (Date.now() - this.lastSelfWriteMs < 600) return;
        if (this.watchTimer) clearTimeout(this.watchTimer);
        this.watchTimer = setTimeout(() => {
          if (this.disposed) return;
          const prevUpdated = this.cachedSnapshot?.updatedAt;
          const disk = this.readFromDisk();
          if (disk.buckets.length > 0 && disk.updatedAt !== prevUpdated) {
            this.cachedSnapshot = disk;
            this.notify(disk);
          }
        }, 120);
      });
    } catch {
      this.watcher = null;
    }

    return () => {
      if (this.watchTimer) {
        clearTimeout(this.watchTimer);
        this.watchTimer = null;
      }
      try {
        this.watcher?.close();
      } catch {
        // ignore
      }
      this.watcher = null;
    };
  }

  fetchLiveQuota(force = false): Promise<AccountQuotaSnapshot> {
    if (this.disposed) return Promise.resolve(this.getCachedSnapshot());
    const now = Date.now();
    if (!force && this.cachedSnapshot && this.cachedSnapshot.buckets.length > 0 && now - this.lastFetchMs < MIN_REFRESH_GAP_MS) {
      return Promise.resolve(this.cachedSnapshot);
    }
    if (this.inFlight) return this.inFlight;

    const agyBin = resolveAgyBinary();
    this.inFlight = new Promise<AccountQuotaSnapshot>((resolve) => {
      execFile(
        agyBin,
        ['-p=/usage', '--output-format', 'json'],
        {
          cwd: HOME,
          timeout: 15_000,
          maxBuffer: 512 * 1024,
          env: buildAgySpawnEnv(),
        },
        (err, stdout) => {
          this.inFlight = null;
          if (this.disposed) {
            resolve(this.getCachedSnapshot());
            return;
          }
          if (err && !stdout) {
            const fallback = this.getCachedSnapshot();
            resolve({ ...fallback, error: err.message });
            return;
          }
          try {
            const trimmed = (stdout || '').trim();
            const jsonStart = trimmed.indexOf('{');
            const parsed = JSON.parse(jsonStart >= 0 ? trimmed.slice(jsonStart) : trimmed) as RawUsageJson;
            const groups = parsed.command?.data?.groups;
            if (!Array.isArray(groups) || groups.length === 0) {
              const fallback = this.getCachedSnapshot();
              resolve({ ...fallback, error: parsed.error || '사용 한도 데이터를 찾지 못했습니다.' });
              return;
            }

            const buckets: QuotaBucket[] = [];
            for (const g of groups) {
              const gName = g.name || '';
              for (const b of g.buckets || []) {
                const id = b.id || `${inferGroup('', gName)}-${b.window || 'limit'}`;
                const resetTime = b.reset_time || null;
                buckets.push({
                  id,
                  group: inferGroup(id, gName),
                  groupName: gName,
                  window: inferWindow(id, b.window),
                  remainingFraction: typeof b.remaining_fraction === 'number' ? b.remaining_fraction : null,
                  resetInSeconds: computeResetInSeconds(resetTime),
                  resetTime,
                });
              }
            }

            const sorted = sortBuckets(buckets);
            const updatedAt = new Date().toISOString();
            const snap: AccountQuotaSnapshot = { buckets: sorted, updatedAt };
            this.cachedSnapshot = snap;
            this.lastFetchMs = Date.now();
            this.persistToDisk(sorted, updatedAt);
            this.notify(snap);
            resolve(snap);
          } catch (parseErr) {
            const fallback = this.getCachedSnapshot();
            resolve({
              ...fallback,
              error: parseErr instanceof Error ? parseErr.message : String(parseErr),
            });
          }
        }
      );
    });

    return this.inFlight;
  }

  dispose(): void {
    this.disposed = true;
    if (this.watchTimer) {
      clearTimeout(this.watchTimer);
      this.watchTimer = null;
    }
    try {
      this.watcher?.close();
    } catch {
      // ignore
    }
    this.watcher = null;
    this.listeners.clear();
  }

  private readFromDisk(): AccountQuotaSnapshot {
    try {
      const raw = fs.readFileSync(LIVE_QUOTA_PATH, 'utf8');
      const data = JSON.parse(raw) as LiveQuotaFile;
      this.cachedAccount = {
        email: data.email || null,
        planTier: data.planTier || null,
      };
      if (!data?.quota || typeof data.quota !== 'object') {
        return { buckets: [], updatedAt: data?.updatedAt || null };
      }
      const buckets: QuotaBucket[] = Object.entries(data.quota)
        .filter(([, v]) => v && typeof v === 'object' && !v.disabled)
        .map(([id, v]) => {
          const resetTime = v.reset_time || null;
          return {
            id,
            group: v.group === 'gemini' || v.group === 'claude' ? v.group : inferGroup(id, v.group_name),
            groupName: v.group_name,
            window: inferWindow(id, v.window),
            remainingFraction: typeof v.remaining_fraction === 'number' ? v.remaining_fraction : null,
            resetInSeconds:
              typeof v.reset_in_seconds === 'number' ? v.reset_in_seconds : computeResetInSeconds(resetTime),
            resetTime,
          };
        });
      return { buckets: sortBuckets(buckets), updatedAt: data.updatedAt || null };
    } catch {
      return { buckets: [], updatedAt: null };
    }
  }

  private persistToDisk(buckets: QuotaBucket[], updatedAt: string): void {
    try {
      let existing: Record<string, unknown> = {};
      if (fs.existsSync(LIVE_QUOTA_PATH)) {
        try {
          existing = JSON.parse(fs.readFileSync(LIVE_QUOTA_PATH, 'utf8')) as Record<string, unknown>;
        } catch {
          existing = {};
        }
      }
      const quotaMap: Record<string, Record<string, unknown>> = {};
      for (const b of buckets) {
        quotaMap[b.id] = {
          remaining_fraction: b.remainingFraction,
          reset_in_seconds: b.resetInSeconds,
          reset_time: b.resetTime,
          window: b.window,
          group: b.group,
          group_name: b.groupName,
        };
      }
      const next = {
        ...existing,
        source: 'antigravity-cli',
        updatedAt,
        quota: quotaMap,
      };
      fs.mkdirSync(path.dirname(LIVE_QUOTA_PATH), { recursive: true });
      this.lastSelfWriteMs = Date.now();
      const tmp = `${LIVE_QUOTA_PATH}.tmp.${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8');
      fs.renameSync(tmp, LIVE_QUOTA_PATH);
    } catch {
      // non-fatal
    }
  }

  private notify(snap: AccountQuotaSnapshot): void {
    for (const cb of this.listeners) {
      try {
        cb(snap);
      } catch {
        // isolate listener error
      }
    }
  }
}
