import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const BUNDLED_ROOT = path.join(REPO_ROOT, 'bundled-plugins');
const PLUGIN_IDS = ['korean-pack', 'token-band'];
const EXECUTABLE_REL_PATHS = ['bin/run-node.sh', 'cli/statusline.sh'];

const force = process.argv.includes('--force');
const homeDir = process.env.AGY_DESK_HOME || os.homedir();
const destRoot = path.join(homeDir, '.gemini', 'config', 'plugins');
const markerPath = path.join(homeDir, '.gemini', 'antigravity', 'agy-desk-bundled-plugins.json');

function copyDirClean(srcDir, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.DS_Store') continue;
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) copyDirClean(srcPath, destPath);
    else if (entry.isFile()) fs.copyFileSync(srcPath, destPath);
  }
}

let marker = { schemaVersion: 1, seeded: {} };
try {
  if (fs.existsSync(markerPath)) {
    const parsed = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    if (parsed && typeof parsed.seeded === 'object') marker = { schemaVersion: 1, seeded: parsed.seeded };
  }
} catch {}

for (const id of PLUGIN_IDS) {
  const src = path.join(BUNDLED_ROOT, id);
  const dest = path.join(destRoot, id);
  if (!fs.existsSync(src)) continue;

  if (!force && fs.existsSync(dest)) {
    console.log(`[install:plugins] already installed: ${id} (${dest}) — pass --force to overwrite`);
    marker.seeded[id] = marker.seeded[id] || { installedAt: new Date().toISOString(), source: 'existing' };
    continue;
  }

  if (force && fs.existsSync(dest)) {
    fs.rmSync(dest, { recursive: true, force: true });
  }
  copyDirClean(src, dest);
  if (process.platform !== 'win32') {
    for (const rel of EXECUTABLE_REL_PATHS) {
      const p = path.join(dest, rel);
      if (fs.existsSync(p)) fs.chmodSync(p, 0o755);
    }
  }
  marker.seeded[id] = { installedAt: new Date().toISOString(), source: 'bundled' };
  console.log(`[install:plugins] installed: ${id} -> ${dest}`);
}

fs.mkdirSync(path.dirname(markerPath), { recursive: true });
fs.writeFileSync(markerPath, JSON.stringify(marker, null, 2) + '\n', 'utf8');
