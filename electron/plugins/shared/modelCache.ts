import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentModelOption } from '../../../src/shared/agentProtocol';

interface PersistedAdapterModelsEntry {
  models: AgentModelOption[];
  savedAt: string;
}

interface ModelsCacheFile {
  version: 1;
  adapters: Record<string, PersistedAdapterModelsEntry>;
}

export const UNIFIED_MODELS_CACHE_PATH = path.join(
  os.homedir(),
  '.gemini',
  'antigravity',
  'agy-desk',
  'models-cache.json'
);

function readCacheFile(): ModelsCacheFile {
  try {
    if (!fs.existsSync(UNIFIED_MODELS_CACHE_PATH)) {
      return { version: 1, adapters: {} };
    }
    const raw = fs.readFileSync(UNIFIED_MODELS_CACHE_PATH, 'utf8');
    const parsed = JSON.parse(raw) as Partial<ModelsCacheFile>;
    if (parsed && typeof parsed === 'object' && parsed.adapters && typeof parsed.adapters === 'object') {
      return { version: 1, adapters: parsed.adapters };
    }
  } catch {
    // ignore corrupt cache file
  }
  return { version: 1, adapters: {} };
}

function writeCacheFile(file: ModelsCacheFile): void {
  try {
    fs.mkdirSync(path.dirname(UNIFIED_MODELS_CACHE_PATH), { recursive: true });
    const tmp = `${UNIFIED_MODELS_CACHE_PATH}.tmp.${process.pid}.${Math.random().toString(36).slice(2, 6)}`;
    fs.writeFileSync(tmp, JSON.stringify(file, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, UNIFIED_MODELS_CACHE_PATH);
  } catch {
    // non-fatal
  }
}

export function loadCachedAdapterModels(adapterId: string): AgentModelOption[] | null {
  const file = readCacheFile();
  const entry = file.adapters[adapterId];
  if (!entry || !Array.isArray(entry.models) || entry.models.length === 0) return null;
  const valid = entry.models.filter(
    (m): m is AgentModelOption =>
      Boolean(m && typeof m.value === 'string' && m.value && m.value !== 'default' && typeof m.label === 'string')
  );
  return valid.length > 0 ? valid : null;
}

export function saveCachedAdapterModels(adapterId: string, models: readonly AgentModelOption[]): void {
  if (!Array.isArray(models) || models.length === 0) return;
  const filtered = models.filter((m) => m && m.value && m.value !== 'default');
  if (filtered.length === 0) return;
  const file = readCacheFile();
  file.adapters[adapterId] = {
    models: filtered,
    savedAt: new Date().toISOString(),
  };
  writeCacheFile(file);
}
