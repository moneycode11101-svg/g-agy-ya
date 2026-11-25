import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  BUILTIN_PLUGIN_IDS,
  type Disposer,
  type RuntimeAssetProvider,
  type RuntimeAssetsProjection,
  type RuntimeContextAsset,
} from '../../../src/kernel/shared/types';
import { resolveCodexHome } from './rpcClient';

function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.round(text.length / 3.5));
}

function parseFrontmatter(md: string): { name: string; description: string } {
  const m = md.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!m) return { name: '', description: '' };
  const fm = m[1];
  const nameMatch = fm.match(/^name:\s*(.+)$/m);
  const descInline = fm.match(/^description:\s*(.+)$/m);
  return {
    name: nameMatch ? nameMatch[1].trim().replace(/^["']|["']$/g, '') : '',
    description: descInline ? descInline[1].trim().replace(/^["']|["']$/g, '') : '',
  };
}

function inspectDir(fullPath: string): { isDir: boolean; isSymlink: boolean; realPath?: string } {
  try {
    const lstat = fs.lstatSync(fullPath);
    const isSymlink = lstat.isSymbolicLink();
    const stat = isSymlink ? fs.statSync(fullPath) : lstat;
    if (!stat.isDirectory()) return { isDir: false, isSymlink };
    return { isDir: true, isSymlink, realPath: isSymlink ? fs.realpathSync(fullPath) : undefined };
  } catch {
    return { isDir: false, isSymlink: false };
  }
}

/**
 * Layer 2 RuntimeAssetProvider for `agent-codex`.
 * Scans `<CODEX_HOME>/AGENTS.md`, `skills/`, `hooks.json`, `config.toml` MCP servers,
 * and workspace `AGENTS.md`.
 */
export class CodexRuntimeAssetProvider implements RuntimeAssetProvider {
  readonly adapterPluginId = BUILTIN_PLUGIN_IDS.AGENT_CODEX;
  readonly adapterLabel = 'Codex CLI (짚)';
  private readonly getCodexHome: () => string;
  private lastCwd?: string;

  constructor(opts: { getCodexHome: () => string }) {
    this.getCodexHome = opts.getCodexHome;
  }

  async scanAssets(cwd?: string): Promise<RuntimeAssetsProjection> {
    if (cwd) this.lastCwd = cwd;
    const effectiveCwd = cwd || this.lastCwd;
    const codexHome = resolveCodexHome(this.getCodexHome());
    const assets: RuntimeContextAsset[] = [];

    const addRule = (filePath: string, name: string, scope: RuntimeContextAsset['scope']) => {
      if (!fs.existsSync(filePath)) return;
      try {
        const text = fs.readFileSync(filePath, 'utf8');
        const tokens = estimateTokens(text);
        const isSymlink = fs.lstatSync(filePath).isSymbolicLink();
        assets.push({
          id: `codex-rule:${scope}:${name}`,
          kind: 'rule',
          name,
          description: scope === 'workspace' ? '워크스페이스 AGENTS.md' : '전역 Codex AGENTS.md',
          scope,
          sourcePath: filePath,
          isSymlink,
          realPath: isSymlink ? fs.realpathSync(filePath) : undefined,
          tokenCost: { alwaysInjected: tokens, basis: 'file-estimate' },
          promptTokens: tokens,
          enabled: true,
          controlMode: 'read-only-cli',
          controlReason: 'Codex app-server가 자동으로 로드합니다.',
        });
      } catch {
        // ignore
      }
    };

    addRule(path.join(codexHome, 'AGENTS.md'), 'CODEX_HOME/AGENTS.md', 'global');
    if (effectiveCwd && fs.existsSync(path.join(effectiveCwd, 'AGENTS.md'))) {
      addRule(path.join(effectiveCwd, 'AGENTS.md'), `${path.basename(effectiveCwd)}/AGENTS.md`, 'workspace');
    }

    // Scan CODEX_HOME/skills
    const skillsDir = path.join(codexHome, 'skills');
    if (fs.existsSync(skillsDir)) {
      try {
        for (const entry of fs.readdirSync(skillsDir)) {
          if (entry.startsWith('.')) continue;
          const full = path.join(skillsDir, entry);
          const info = inspectDir(full);
          if (!info.isDir) continue;
          const mdPath = path.join(full, 'SKILL.md');
          if (!fs.existsSync(mdPath)) continue;
          try {
            const content = fs.readFileSync(mdPath, 'utf8');
            const fm = parseFrontmatter(content);
            const name = fm.name || entry;
            const headerTokens = estimateTokens(`${name}: ${fm.description}`);
            assets.push({
              id: `codex-skill:global:${name}`,
              kind: 'skill',
              name,
              description: fm.description || 'Codex 스킬',
              scope: 'global',
              sourcePath: mdPath,
              isSymlink: info.isSymlink,
              realPath: info.realPath,
              tokenCost: { alwaysInjected: headerTokens, onDemandBody: estimateTokens(content), basis: 'file-estimate' },
              promptTokens: headerTokens,
              lazyBodyTokens: estimateTokens(content),
              enabled: true,
              controlMode: 'read-only-cli',
              controlReason: `${codexHome}/skills에서 자동 로드됩니다.`,
            });
          } catch {
            // ignore
          }
        }
      } catch {
        // ignore
      }
    }

    // Parse `[mcp_servers.<name>]` from config.toml
    const configTomlPath = path.join(codexHome, 'config.toml');
    if (fs.existsSync(configTomlPath)) {
      try {
        const toml = fs.readFileSync(configTomlPath, 'utf8');
        const seenMcp = new Set<string>();
        for (const match of toml.matchAll(/^\s*\[mcp_servers\.([a-zA-Z0-9_-]+)\]/gm)) {
          const srv = match[1];
          if (seenMcp.has(srv)) continue;
          seenMcp.add(srv);
          assets.push({
            id: `codex-mcp:global:${srv}`,
            kind: 'mcp',
            name: srv,
            description: 'Codex config.toml MCP 서버',
            scope: 'global',
            sourcePath: configTomlPath,
            tokenCost: { alwaysInjected: 0, basis: 'unmeasured' },
            promptTokens: 0,
            enabled: true,
            controlMode: 'read-only-cli',
            controlReason: `${configTomlPath}에서 관리됩니다.`,
          });
        }
      } catch {
        // ignore
      }
    }

    // hooks.json
    const hooksPath = path.join(codexHome, 'hooks.json');
    if (fs.existsSync(hooksPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(hooksPath, 'utf8')) as Record<string, unknown>;
        for (const key of Object.keys(parsed)) {
          assets.push({
            id: `codex-hook:global:${key}`,
            kind: 'hook',
            name: key,
            description: 'Codex hooks.json 훅',
            scope: 'global',
            sourcePath: hooksPath,
            tokenCost: { alwaysInjected: 0, basis: 'measured-cache' },
            promptTokens: 0,
            enabled: true,
            controlMode: 'read-only-cli',
            controlReason: `${hooksPath}에서 관리됩니다.`,
          });
        }
      } catch {
        // ignore
      }
    }

    let ruleTokens = 0;
    let skillTokens = 0;
    let mcpTokens = 0;
    for (const a of assets) {
      if (!a.enabled) continue;
      if (a.kind === 'rule') ruleTokens += a.promptTokens;
      else if (a.kind === 'skill') skillTokens += a.promptTokens;
      else if (a.kind === 'mcp') mcpTokens += a.promptTokens;
    }

    return {
      adapterPluginId: this.adapterPluginId,
      adapterLabel: this.adapterLabel,
      scannedAt: Date.now(),
      tokenBudgetMax: 20_000,
      totals: { ruleTokens, skillTokens, mcpTokens },
      activePresetId: null,
      presets: [],
      assets,
    };
  }

  watch(onChange: (projection: RuntimeAssetsProjection) => void): Disposer {
    const codexHome = resolveCodexHome(this.getCodexHome());
    let timer: ReturnType<typeof setTimeout> | null = null;
    let closed = false;
    let watcher: fs.FSWatcher | null = null;
    try {
      if (fs.existsSync(codexHome)) {
        watcher = fs.watch(codexHome, () => {
          if (closed) return;
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => {
            if (closed) return;
            void this.scanAssets(this.lastCwd).then((proj) => {
              if (!closed) onChange(proj);
            });
          }, 350);
        });
      }
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
}
