import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const BUNDLED_AGY_PLUGIN_IDS = ['korean-pack', 'token-band'] as const;

interface SeedMarkerDocument {
  schemaVersion: 1;
  seeded: Record<string, { installedAt: string; source: 'bundled' | 'existing' }>;
}

const EXECUTABLE_REL_PATHS = ['bin/run-node.sh', 'cli/statusline.sh'];

function resolveBundledPluginsRoot(): string | null {
  const candidates = [
    path.resolve(__dirname, '../bundled-plugins'),
    path.resolve(process.cwd(), 'bundled-plugins'),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(dir)) return dir;
  }
  return null;
}

function readMarker(markerPath: string): SeedMarkerDocument {
  try {
    if (fs.existsSync(markerPath)) {
      const parsed = JSON.parse(fs.readFileSync(markerPath, 'utf8')) as Partial<SeedMarkerDocument>;
      if (parsed && typeof parsed === 'object' && parsed.seeded && typeof parsed.seeded === 'object') {
        return { schemaVersion: 1, seeded: { ...parsed.seeded } };
      }
    }
  } catch {
    // start fresh on corrupt marker
  }
  return { schemaVersion: 1, seeded: {} };
}

function writeMarker(markerPath: string, doc: SeedMarkerDocument): void {
  fs.mkdirSync(path.dirname(markerPath), { recursive: true });
  fs.writeFileSync(markerPath, JSON.stringify(doc, null, 2) + '\n', 'utf8');
}

function copyDirClean(srcDir: string, destDir: string): void {
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.DS_Store') continue;
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyDirClean(srcPath, destPath);
    } else if (entry.isFile()) {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function ensureExecutableScripts(pluginDestDir: string): void {
  if (process.platform === 'win32') return;
  for (const rel of EXECUTABLE_REL_PATHS) {
    const target = path.join(pluginDestDir, rel);
    if (fs.existsSync(target)) {
      try {
        fs.chmodSync(target, 0o755);
      } catch {
        // ignore chmod errors on restricted filesystems
      }
    }
  }
}

export interface BundledSeedResult {
  installed: string[];
  skipped: string[];
}

/**
 * Seeds default bundled Antigravity plugins (`korean-pack`, `token-band`) into
 * `~/.gemini/config/plugins/` once on first launch so new users get Korean output
 * rules and Token Band skills/hooks/MCP out of the box.
 *
 * - Never overwrites an already-installed user plugin unless `force: true`.
 * - Records seeded IDs in `~/.gemini/antigravity/agy-desk-bundled-plugins.json`
 *   so if a user intentionally removes a bundled plugin later, it is not forced back.
 */
export function ensureBundledAgyPluginsInstalled(opts?: {
  homeDir?: string;
  bundledRoot?: string;
  force?: boolean;
}): BundledSeedResult {
  const homeDir = opts?.homeDir || os.homedir();
  const bundledRoot = opts?.bundledRoot || resolveBundledPluginsRoot();
  const force = Boolean(opts?.force);

  const installed: string[] = [];
  const skipped: string[] = [];

  if (!bundledRoot || !fs.existsSync(bundledRoot)) {
    return { installed, skipped: [...BUNDLED_AGY_PLUGIN_IDS] };
  }

  const pluginsDestRoot = path.join(homeDir, '.gemini', 'config', 'plugins');
  const markerPath = path.join(homeDir, '.gemini', 'antigravity', 'agy-desk-bundled-plugins.json');
  const marker = readMarker(markerPath);
  let markerDirty = false;

  for (const pluginId of BUNDLED_AGY_PLUGIN_IDS) {
    const srcDir = path.join(bundledRoot, pluginId);
    if (!fs.existsSync(srcDir)) {
      skipped.push(pluginId);
      continue;
    }

    const destDir = path.join(pluginsDestRoot, pluginId);
    const alreadyExists = fs.existsSync(destDir);

    if (!force && marker.seeded[pluginId]) {
      skipped.push(pluginId);
      continue;
    }

    if (!force && alreadyExists) {
      marker.seeded[pluginId] = { installedAt: new Date().toISOString(), source: 'existing' };
      markerDirty = true;
      skipped.push(pluginId);
      continue;
    }

    try {
      if (force && alreadyExists) {
        fs.rmSync(destDir, { recursive: true, force: true });
      }
      copyDirClean(srcDir, destDir);
      ensureExecutableScripts(destDir);
      marker.seeded[pluginId] = { installedAt: new Date().toISOString(), source: 'bundled' };
      markerDirty = true;
      installed.push(pluginId);
    } catch (err) {
      console.warn(`[bundled-plugins] failed to install "${pluginId}":`, err);
      skipped.push(pluginId);
    }
  }

  if (markerDirty) {
    try {
      writeMarker(markerPath, marker);
    } catch {
      // non-fatal
    }
  }

  return { installed, skipped };
}
