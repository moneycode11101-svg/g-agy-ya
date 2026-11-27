import esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(__dirname, 'dist');
fs.mkdirSync(distDir, { recursive: true });

const result = await esbuild.build({
  entryPoints: [path.join(__dirname, 'app.ts')],
  bundle: true,
  minify: true,
  format: 'iife',
  target: ['es2022'],
  write: false,
});

const jsCode = result.outputFiles[0].text;

const css = `
:root {
  --tb-bg: var(--color-background-primary, #ffffff);
  --tb-bg2: var(--color-background-secondary, #f5f6f8);
  --tb-bg3: var(--color-background-tertiary, #eceef2);
  --tb-text: var(--color-text-primary, #1b1f23);
  --tb-muted: var(--color-text-secondary, #636c76);
  --tb-border: var(--color-border-primary, #d8dee4);
  --tb-accent: var(--color-text-info, #2563eb);
  --tb-accent-soft: rgba(37, 99, 235, 0.12);
  --tb-cache-read: #10b981;
  --tb-cache-write: #8b5cf6;
  --tb-pending: #f59e0b;
  --tb-danger: var(--color-text-danger, #dc2626);
  --tb-warn: var(--color-text-warning, #d97706);
  --tb-font: var(--font-sans, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
}
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 0;
  background: var(--tb-bg);
  color: var(--tb-text);
  font-family: var(--tb-font);
  font-size: 12.5px;
  line-height: 1.45;
}
.wrap { padding: 12px; display: flex; flex-direction: column; gap: 10px; }
.loading, .empty-hint { padding: 20px; text-align: center; color: var(--tb-muted); }
.topbar { display: flex; flex-direction: column; gap: 8px; }
.title-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.brand { font-weight: 700; font-size: 14px; letter-spacing: -0.01em; }
.pill {
  font-size: 11px; padding: 2px 7px; border-radius: 999px;
  background: var(--tb-bg2); border: 1px solid var(--tb-border);
}
.controls { display: flex; gap: 6px; align-items: center; }
select {
  flex: 1; min-width: 0; padding: 5px 8px; border-radius: 6px;
  background: var(--tb-bg2); color: var(--tb-text); border: 1px solid var(--tb-border);
  font-size: 12px;
}
.icon-btn {
  padding: 5px 8px; border-radius: 6px; border: 1px solid var(--tb-border);
  background: var(--tb-bg2); color: var(--tb-text); cursor: pointer; font-size: 11.5px; white-space: nowrap;
}
.icon-btn.active { border-color: var(--tb-cache-read); color: var(--tb-cache-read); font-weight: 600; }
.err-banner { padding: 8px 10px; border-radius: 6px; background: rgba(220,38,38,0.1); color: var(--tb-danger); font-size: 11.5px; }

.hero-band {
  padding: 10px 12px; border-radius: 8px; background: var(--tb-bg2); border: 1px solid var(--tb-border);
  display: flex; flex-direction: column; gap: 6px;
}
.hero-top { display: flex; justify-content: space-between; align-items: center; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
.pct-badge {
  font-weight: 700; font-size: 12px; padding: 1px 7px; border-radius: 999px;
  background: var(--tb-accent-soft); color: var(--tb-accent);
}
.pct-badge.warn { background: rgba(217,119,6,0.15); color: var(--tb-warn); }
.pct-badge.danger { background: rgba(220,38,38,0.15); color: var(--tb-danger); }
.seg-bar {
  height: 10px; border-radius: 999px; overflow: hidden; background: var(--tb-bg3);
  display: flex; width: 100%;
}
.seg { height: 100%; transition: width 0.25s ease; }
.seg-cr { background: var(--tb-cache-read); }
.seg-cw { background: var(--tb-cache-write); }
.seg-pend { background: var(--tb-pending); }
.seg-legend { display: flex; flex-wrap: wrap; gap: 10px; font-size: 11px; color: var(--tb-muted); align-items: center; }
.seg-legend .right { margin-left: auto; color: var(--tb-text); }
.dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; margin-right: 4px; vertical-align: middle; }
.dot-cr { background: var(--tb-cache-read); }
.dot-cw { background: var(--tb-cache-write); }
.dot-pend { background: var(--tb-pending); }
.dot-ctx { background: var(--tb-accent); }

.kpi-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.kpi-card {
  padding: 9px 10px; border-radius: 8px; background: var(--tb-bg2); border: 1px solid var(--tb-border);
  display: flex; flex-direction: column; gap: 3px;
}
.kpi-label { font-size: 11px; color: var(--tb-muted); }
.kpi-val { font-size: 15px; font-weight: 700; letter-spacing: -0.01em; }
.kpi-sub { font-size: 11px; font-weight: 500; color: var(--tb-muted); }
.kpi-meta { font-size: 11px; color: var(--tb-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.kpi-note { font-size: 10.5px; color: var(--tb-muted); opacity: 0.9; }
.quota-mini { display: flex; flex-wrap: wrap; gap: 6px; font-size: 10.5px; color: var(--tb-muted); margin-top: 2px; }
.cr { color: var(--tb-cache-read); }
.cw { color: var(--tb-cache-write); }
.muted { color: var(--tb-muted); }

.tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--tb-border); padding-bottom: 4px; }
.tab {
  border: none; background: transparent; color: var(--tb-muted); padding: 5px 9px;
  border-radius: 6px; cursor: pointer; font-size: 12px; font-weight: 500;
}
.tab.active { background: var(--tb-accent-soft); color: var(--tb-accent); font-weight: 600; }

.tab-panel { display: flex; flex-direction: column; gap: 8px; }
.tool-list { display: flex; flex-direction: column; gap: 8px; }
.tool-row { display: flex; flex-direction: column; gap: 3px; }
.tool-head { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; font-size: 12px; }
.mini-bar { height: 6px; border-radius: 999px; background: var(--tb-bg3); overflow: hidden; }
.mini-fill { height: 100%; background: var(--tb-accent); border-radius: 999px; }

.table-wrap { overflow-x: auto; border: 1px solid var(--tb-border); border-radius: 8px; }
table { width: 100%; border-collapse: collapse; font-size: 11.5px; }
th, td { padding: 6px 8px; border-bottom: 1px solid var(--tb-border); text-align: left; }
th { background: var(--tb-bg2); color: var(--tb-muted); font-weight: 600; font-size: 11px; }
tr:last-child td { border-bottom: none; }
.num { text-align: right; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; white-space: nowrap; }
.exact { color: var(--tb-accent); font-weight: 600; }
.est { color: var(--tb-pending); font-weight: 600; }
.delta { color: var(--tb-warn); }
.target-cell { max-width: 170px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--tb-muted); }
code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px; padding: 1px 4px; border-radius: 4px; background: var(--tb-bg3);
}

.sparkline { width: 100%; height: 92px; border: 1px solid var(--tb-border); border-radius: 8px; background: var(--tb-bg2); }
.spark-legend { display: flex; gap: 12px; font-size: 11px; color: var(--tb-muted); }

.settings-box { display: flex; flex-direction: column; gap: 10px; padding: 10px; border-radius: 8px; background: var(--tb-bg2); border: 1px solid var(--tb-border); }
.toggle-row { display: flex; justify-content: space-between; align-items: center; gap: 10px; cursor: pointer; }
.toggle-row span { display: flex; flex-direction: column; gap: 2px; }
.toggle-row small, .field-row small { color: var(--tb-muted); font-size: 11px; }
.field-row { display: flex; flex-direction: column; gap: 4px; }
.field-row input[type="number"] {
  padding: 6px 8px; border-radius: 6px; border: 1px solid var(--tb-border);
  background: var(--tb-bg); color: var(--tb-text); font-size: 12.5px;
}
.primary-btn {
  align-self: flex-start; padding: 6px 14px; border-radius: 6px; border: none;
  background: var(--tb-accent); color: #fff; font-weight: 600; cursor: pointer; font-size: 12px;
}
@media (max-width: 420px) {
  .kpi-grid { grid-template-columns: 1fr; }
}
`;

const html = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Token Band</title>
<style>${css}</style>
</head>
<body>
<div id="app"></div>
<script>${jsCode}</script>
</body>
</html>
`;

const outPath = path.join(distDir, 'app.html');
fs.writeFileSync(outPath, html, 'utf8');
console.log(`Built ${outPath} (${(Buffer.byteLength(html) / 1024).toFixed(1)} KiB)`);
