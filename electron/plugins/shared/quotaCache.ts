import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AccountQuotaSnapshot } from '../../../src/shared/types';

export interface PersistedAdapterQuotaEntry {
  snapshot: AccountQuotaSnapshot;
  email?: string | null;
  planTier?: string | null;
  savedAt: string;
}

interface QuotaCacheFile {
  version: 1;
  adapters: Record<string, PersistedAdapterQuotaEntry>;
}

export const UNIFIED_QUOTA_CACHE_PATH = path.join(
  os.homedir(),
  '.gemini',
  'antigravity',
  'agy-desk',
  'quota-cache.json'
);

function readCacheFile(): QuotaCacheFile {
  try {
    if (!fs.existsSync(UNIFIED_QUOTA_CACHE_PATH)) {
      return { version: 1, adapters: {} };
    }
    const raw = fs.readFileSync(UNIFIED_QUOTA_CACHE_PATH, 'utf8');
    const parsed = JSON.parse(raw) as Partial<QuotaCacheFile>;
    if (parsed && typeof parsed === 'object' && parsed.adapters && typeof parsed.adapters === 'object') {
      return { version: 1, adapters: parsed.adapters };
    }
  } catch {
    // ignore corrupt cache file
  }
  return { version: 1, adapters: {} };
}

function writeCacheFile(file: QuotaCacheFile): void {
  try {
    fs.mkdirSync(path.dirname(UNIFIED_QUOTA_CACHE_PATH), { recursive: true });
    const tmp = `${UNIFIED_QUOTA_CACHE_PATH}.tmp.${process.pid}.${Math.random().toString(36).slice(2, 6)}`;
    fs.writeFileSync(tmp, JSON.stringify(file, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, UNIFIED_QUOTA_CACHE_PATH);
  } catch {
    // non-fatal
  }
}

export function loadCachedAdapterQuota(adapterId: string): PersistedAdapterQuotaEntry | null {
  const file = readCacheFile();
  const entry = file.adapters[adapterId];
  if (!entry || !entry.snapshot || !Array.isArray(entry.snapshot.buckets)) return null;
  // Refresh dynamic resetInSeconds relative to current wall clock
  const now = Date.now();
  const hydratedBuckets = entry.snapshot.buckets.map((b) => {
    if (!b.resetTime) return b;
    const ms = Date.parse(b.resetTime);
    if (Number.isNaN(ms)) return b;
    return {
      ...b,
      resetInSeconds: Math.max(0, Math.round((ms - now) / 1000)),
    };
  });
  return {
    ...entry,
    snapshot: {
      ...entry.snapshot,
      adapterId,
      buckets: hydratedBuckets,
    },
  };
}

export function saveCachedAdapterQuota(
  adapterId: string,
  snapshot: AccountQuotaSnapshot,
  meta?: { email?: string | null; planTier?: string | null }
): void {
  if (!snapshot || snapshot.buckets.length === 0) return;
  const file = readCacheFile();
  const prev = file.adapters[adapterId];
  file.adapters[adapterId] = {
    snapshot: { ...snapshot, adapterId },
    email: meta?.email !== undefined ? meta.email : prev?.email ?? null,
    planTier: meta?.planTier !== undefined ? meta.planTier : prev?.planTier ?? null,
    savedAt: new Date().toISOString(),
  };
  writeCacheFile(file);
}
