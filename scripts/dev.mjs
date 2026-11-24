import { spawn } from 'node:child_process';
import { createServer } from 'vite';

const server = await createServer();
await server.listen();
const addr = server.resolvedUrls?.local?.[0] || 'http://localhost:5178';
console.log('[dev] Vite ready at', addr);

// Build electron bundles
await new Promise((resolve, reject) => {
  const b = spawn(process.execPath, ['scripts/build-electron.mjs'], { stdio: 'inherit' });
  b.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`build exited ${code}`))));
});

const electronBin = process.platform === 'win32'
  ? 'node_modules/.bin/electron.cmd'
  : 'node_modules/.bin/electron';

const child = spawn(electronBin, ['.'], {
  stdio: 'inherit',
  env: { ...process.env, VITE_DEV_SERVER_URL: addr },
});

child.on('exit', async (code) => {
  await server.close();
  process.exit(code ?? 0);
});
