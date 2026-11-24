import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'dist-electron');
fs.mkdirSync(outDir, { recursive: true });

const common = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  external: ['electron', 'esbuild'],
  sourcemap: true,
};

await Promise.all([
  esbuild.build({
    ...common,
    entryPoints: [path.join(root, 'electron/main.ts')],
    outfile: path.join(outDir, 'main.cjs'),
  }),
  esbuild.build({
    ...common,
    entryPoints: [path.join(root, 'electron/preload.ts')],
    outfile: path.join(outDir, 'preload.cjs'),
  }),
]);

fs.copyFileSync(path.join(root, 'electron/pty_helper.py'), path.join(outDir, 'pty_helper.py'));

console.log('[build:electron] built dist-electron/main.cjs, preload.cjs & pty_helper.py');
