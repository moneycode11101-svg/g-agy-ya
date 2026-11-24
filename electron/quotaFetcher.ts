import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AccountQuotaSnapshot, QuotaBucket, QuotaGroupKey, QuotaWindow } from '../src/shared/types';

const HOME = os.homedir();
const LIVE_QUOTA_PATH = path.join(HOME, '.gemini', 'antigravity', 'token-band', 'live-quota.json');
const MIN_REFRESH_GAP_MS = 30_000;

function sortBuckets(buckets: QuotaBucket[]): QuotaBucket[] {
  return [...buckets].sort((a, b) => {
    const gRank = (x: QuotaBucket) => (x.group === 'gemini' ? 0 : 1);
    const wRank = (x: QuotaBucket) => (x.window === '5h' ? 0 : x.window === 'weekly' ? 1 : 2);
    return gRank(a) - gRank(b) || wRank(a) - wRank(b);
  });
}

function resolveAgyBinary(): string {
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

function computeResetInSeconds(resetTime: string | null): number | null {
  if (!resetTime) return null;
  const ts = Date.parse(resetTime);
  if (Number.isNaN(ts)) return null;
  return Math.max(0, Math.floor((ts - Date.now()) / 1000));
}

function readDiskSnapshot(): AccountQuotaSnapshot {
  try {
    const raw = fs.readFileSync(LIVE_QUOTA_PATH, 'utf8');
    const data = JSON.parse(raw) as {
      updatedAt?: string;
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

let lastSelfWriteMs = 0;

function persistLiveQuotaToDisk(buckets: QuotaBucket[], updatedAt: string): void {
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
    lastSelfWriteMs = Date.now();
    fs.writeFileSync(LIVE_QUOTA_PATH, JSON.stringify(next, null, 2) + '\n', 'utf8');
  } catch {
    // non-fatal
  }
}

/**
 * Pure fs.watch listener on ~/.gemini/antigravity/token-band/live-quota.json.
 * Immediately propagates quota updates written by external agy CLI / Antigravity App runs
 * without any background polling interval.
 */
export function startQuotaFileWatcher(): () => void {
  const dir = path.dirname(LIVE_QUOTA_PATH);
  let closed = false;
  let timer: NodeJS.Timeout | null = null;
  let watcher: fs.FSWatcher | null = null;

  try {
    fs.mkdirSync(dir, { recursive: true });
    watcher = fs.watch(dir, (_evType, filename) => {
      if (closed) return;
      if (filename && !filename.includes('live-quota')) return;
      if (Date.now() - lastSelfWriteMs < 600) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        if (closed) return;
        const disk = readDiskSnapshot();
        if (disk.buckets.length > 0 && disk.updatedAt !== cachedSnapshot?.updatedAt) {
          cachedSnapshot = disk;
          notify(disk);
        }
      }, 120);
    });
  } catch {
    watcher = null;
  }

  return () => {
    closed = true;
    if (timer) clearTimeout(timer);
    try {
      watcher?.close();
    } catch {
      // ignore
    }
  };
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

let cachedSnapshot: AccountQuotaSnapshot | null = null;
let lastFetchMs = 0;
let inFlight: Promise<AccountQuotaSnapshot> | null = null;
const listeners = new Set<(snap: AccountQuotaSnapshot) => void>();

export function onQuotaSnapshotChange(cb: (snap: AccountQuotaSnapshot) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function notify(snap: AccountQuotaSnapshot) {
  for (const cb of listeners) {
    try {
      cb(snap);
    } catch {
      // ignore
    }
  }
}

export function getCachedQuotaSnapshot(): AccountQuotaSnapshot {
  if (!cachedSnapshot) {
    cachedSnapshot = readDiskSnapshot();
  }
  return cachedSnapshot;
}

export function fetchLiveQuota(force = false): Promise<AccountQuotaSnapshot> {
  const now = Date.now();
  if (!force && cachedSnapshot && cachedSnapshot.buckets.length > 0 && now - lastFetchMs < MIN_REFRESH_GAP_MS) {
    return Promise.resolve(cachedSnapshot);
  }
  if (inFlight) return inFlight;

  const agyBin = resolveAgyBinary();
  inFlight = new Promise<AccountQuotaSnapshot>((resolve) => {
    execFile(
      agyBin,
      ['-p=/usage', '--output-format', 'json'],
      {
        cwd: HOME,
        timeout: 15_000,
        maxBuffer: 512 * 1024,
        env: {
          ...process.env,
          PATH: `${path.join(HOME, '.local', 'bin')}:/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ''}`,
        },
      },
      (err, stdout) => {
        inFlight = null;
        if (err && !stdout) {
          const fallback = getCachedQuotaSnapshot();
          resolve({ ...fallback, error: err.message });
          return;
        }
        try {
          const trimmed = (stdout || '').trim();
          const jsonStart = trimmed.indexOf('{');
          const parsed = JSON.parse(jsonStart >= 0 ? trimmed.slice(jsonStart) : trimmed) as RawUsageJson;
          const groups = parsed.command?.data?.groups;
          if (!Array.isArray(groups) || groups.length === 0) {
            const fallback = getCachedQuotaSnapshot();
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
          // Sort consistently: Gemini (5h -> weekly), then Claude/GPT (5h -> weekly)
          buckets.sort((a, b) => {
            const gRank = (x: QuotaBucket) => (x.group === 'gemini' ? 0 : 1);
            const wRank = (x: QuotaBucket) => (x.window === '5h' ? 0 : x.window === 'weekly' ? 1 : 2);
            return gRank(a) - gRank(b) || wRank(a) - wRank(b);
          });

          const updatedAt = new Date().toISOString();
          const snap: AccountQuotaSnapshot = { buckets, updatedAt };
          cachedSnapshot = snap;
          lastFetchMs = Date.now();
          persistLiveQuotaToDisk(buckets, updatedAt);
          notify(snap);
          resolve(snap);
        } catch (parseErr) {
          const fallback = getCachedQuotaSnapshot();
          resolve({
            ...fallback,
            error: parseErr instanceof Error ? parseErr.message : String(parseErr),
          });
        }
      }
    );
  });

  return inFlight;
}
