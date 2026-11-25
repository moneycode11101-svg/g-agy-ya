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
import { resolveClaudeConfigDir } from './env';

function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.round(text.length / 3.5));
}

function safeReadJson(filePath: string): Record<string, unknown> | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function parseFrontmatter(md: string): { name: string; description: string } {
  const m = md.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!m) return { name: '', description: '' };
  const fm = m[1];
  const nameMatch = fm.match(/^name:\s*(.+)$/m);
  const descBlock = fm.match(/^description:\s*>-?\s*\n((?:\s+.+\n?)+)/m);
  const descInline = fm.match(/^description:\s*(.+)$/m);
  const name = nameMatch ? nameMatch[1].trim().replace(/^["']|["']$/g, '') : '';
  const description = descBlock
    ? descBlock[1].replace(/\s+/g, ' ').trim()
    : descInline
      ? descInline[1].trim().replace(/^["']|["']$/g, '')
      : '';
  return { name, description };
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

function findAncestors(cwd?: string): string[] {
  if (!cwd) return [];
  try {
    const resolved = path.resolve(cwd);
    if (!fs.existsSync(resolved)) return [];
    const dirs: string[] = [];
    let cur = resolved;
    const home = os.homedir();
    for (let i = 0; i < 10; i++) {
      dirs.push(cur);
      if (fs.existsSync(path.join(cur, '.git')) || cur === home) break;
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
    return dirs;
  } catch {
    return [];
  }
}

/**
 * Layer 2 RuntimeAssetProvider for `agent-claude`.
 * Scans `~/.claude` (or custom `CLAUDE_CONFIG_DIR`) + workspace `CLAUDE.md`, `.claude/skills`,
 * `.claude/rules`, `settings.json` hooks/plugins, and `.mcp.json`.
 */
export class ClaudeRuntimeAssetProvider implements RuntimeAssetProvider {
  readonly adapterPluginId = BUILTIN_PLUGIN_IDS.AGENT_CLAUDE;
  readonly adapterLabel = 'Claude Code (claude)';
  private readonly getConfigDir: () => string;
  private lastCwd?: string;

  constructor(opts: { getConfigDir: () => string }) {
    this.getConfigDir = opts.getConfigDir;
  }

  async scanAssets(cwd?: string): Promise<RuntimeAssetsProjection> {
    if (cwd) this.lastCwd = cwd;
    const effectiveCwd = cwd || this.lastCwd;
    const claudeDir = resolveClaudeConfigDir(this.getConfigDir());
    const assets: RuntimeContextAsset[] = [];
    const seenPaths = new Set<string>();

    const addRule = (filePath: string, name: string, scope: RuntimeContextAsset['scope']) => {
      if (!fs.existsSync(filePath)) return;
      try {
        const real = fs.realpathSync(filePath);
        if (seenPaths.has(real)) return;
        seenPaths.add(real);
        const text = fs.readFileSync(filePath, 'utf8');
        const tokens = estimateTokens(text);
        assets.push({
          id: `claude-rule:${scope}:${name}`,
          kind: 'rule',
          name,
          description: scope === 'workspace' ? '프로젝트 CLAUDE 규칙' : '전역 Claude 규칙',
          scope,
          sourcePath: filePath,
          isSymlink: fs.lstatSync(filePath).isSymbolicLink(),
          realPath: real !== filePath ? real : undefined,
          tokenCost: { alwaysInjected: tokens, basis: 'file-estimate' },
          promptTokens: tokens,
          enabled: true,
          controlMode: 'read-only-cli',
          controlReason: 'Claude Code CLI가 세션 시작 시 자동으로 로드합니다.',
        });
      } catch {
        // ignore
      }
    };

    const scanSkills = (dir: string, scope: RuntimeContextAsset['scope']) => {
      if (!fs.existsSync(dir)) return;
      try {
        for (const entry of fs.readdirSync(dir)) {
          if (entry.startsWith('.')) continue;
          const full = path.join(dir, entry);
          const info = inspectDir(full);
          if (!info.isDir) continue;
          const skillMd = path.join(full, 'SKILL.md');
          if (!fs.existsSync(skillMd)) continue;
          try {
            const content = fs.readFileSync(skillMd, 'utf8');
            const fm = parseFrontmatter(content);
            const name = fm.name || entry;
            const headerTokens = estimateTokens(`${name}: ${fm.description}`);
            const bodyTokens = estimateTokens(content);
            assets.push({
              id: `claude-skill:${scope}:${name}`,
              kind: 'skill',
              name,
              description: fm.description || 'Claude 스킬',
              scope,
              sourcePath: skillMd,
              isSymlink: info.isSymlink,
              realPath: info.realPath,
              tokenCost: { alwaysInjected: headerTokens, onDemandBody: bodyTokens, basis: 'file-estimate' },
              promptTokens: headerTokens,
              lazyBodyTokens: bodyTokens,
              enabled: true,
              controlMode: 'read-only-cli',
              controlReason: 'Claude Code 스킬 디렉터리에서 자동 인식됩니다.',
            });
          } catch {
            // ignore
          }
        }
      } catch {
        // ignore
      }
    };

    // Global CLAUDE.md, rules, skills
    addRule(path.join(claudeDir, 'CLAUDE.md'), '~/.claude/CLAUDE.md', 'global');
    const globalRulesDir = path.join(claudeDir, 'rules');
    if (fs.existsSync(globalRulesDir)) {
      try {
        for (const rf of fs.readdirSync(globalRulesDir)) {
          if (rf.endsWith('.md')) addRule(path.join(globalRulesDir, rf), `rules/${rf}`, 'global');
        }
      } catch {
        // ignore
      }
    }
    scanSkills(path.join(claudeDir, 'skills'), 'global');

    // Global settings.json plugins & hooks
    const settings = safeReadJson(path.join(claudeDir, 'settings.json'));
    const enabledPlugins = settings?.enabledPlugins;
    if (enabledPlugins && typeof enabledPlugins === 'object') {
      for (const [pluginKey, enabled] of Object.entries(enabledPlugins as Record<string, unknown>)) {
        assets.push({
          id: `claude-plugin:${pluginKey}`,
          kind: 'plugin-bundle',
          name: pluginKey,
          description: 'Claude Code 설정 플러그인',
          scope: 'global',
          sourcePath: path.join(claudeDir, 'settings.json'),
          tokenCost: { alwaysInjected: 0, basis: 'unmeasured' },
          promptTokens: 0,
          enabled: enabled === true,
          controlMode: 'read-only-cli',
          controlReason: '~/.claude/settings.json에서 관리됩니다.',
        });
      }
    }

    const hooks = settings?.hooks;
    if (hooks && typeof hooks === 'object') {
      for (const hookName of Object.keys(hooks as Record<string, unknown>)) {
        assets.push({
          id: `claude-hook:global:${hookName}`,
          kind: 'hook',
          name: hookName,
          description: 'Claude Code 전역 라이프사이클 훅',
          scope: 'global',
          sourcePath: path.join(claudeDir, 'settings.json'),
          tokenCost: { alwaysInjected: 0, basis: 'measured-cache' },
          promptTokens: 0,
          enabled: true,
          controlMode: 'read-only-cli',
          controlReason: '~/.claude/settings.json에서 관리됩니다.',
        });
      }
    }

    // Global MCP from ~/.claude.json
    const claudeJson = safeReadJson(path.join(os.homedir(), '.claude.json'));
    const globalMcp = claudeJson?.mcpServers;
    if (globalMcp && typeof globalMcp === 'object') {
      for (const srvName of Object.keys(globalMcp as Record<string, unknown>)) {
        assets.push({
          id: `claude-mcp:global:${srvName}`,
          kind: 'mcp',
          name: srvName,
          description: 'Claude Code 전역 MCP 서버',
          scope: 'global',
          sourcePath: path.join(os.homedir(), '.claude.json'),
          tokenCost: { alwaysInjected: 0, basis: 'unmeasured' },
          promptTokens: 0,
          enabled: true,
          controlMode: 'read-only-cli',
          controlReason: '~/.claude.json에서 관리됩니다.',
        });
      }
    }

    // Workspace-level CLAUDE.md, .claude/rules, .claude/skills, .mcp.json
    for (const dir of findAncestors(effectiveCwd)) {
      const baseName = path.basename(dir);
      addRule(path.join(dir, 'CLAUDE.md'), `${baseName}/CLAUDE.md`, 'workspace');
      addRule(path.join(dir, 'CLAUDE.local.md'), `${baseName}/CLAUDE.local.md`, 'workspace');
      const dotClaude = path.join(dir, '.claude');
      if (fs.existsSync(dotClaude)) {
        scanSkills(path.join(dotClaude, 'skills'), 'workspace');
        const wsRules = path.join(dotClaude, 'rules');
        if (fs.existsSync(wsRules)) {
          try {
            for (const rf of fs.readdirSync(wsRules)) {
              if (rf.endsWith('.md')) addRule(path.join(wsRules, rf), `${baseName}/.claude/rules/${rf}`, 'workspace');
            }
          } catch {
            // ignore
          }
        }
      }
      const wsMcp = safeReadJson(path.join(dir, '.mcp.json'));
      const wsServers = wsMcp?.mcpServers;
      if (wsServers && typeof wsServers === 'object') {
        for (const srvName of Object.keys(wsServers as Record<string, unknown>)) {
          assets.push({
            id: `claude-mcp:ws:${baseName}:${srvName}`,
            kind: 'mcp',
            name: srvName,
            description: `${baseName} 프로젝트 MCP 서버`,
            scope: 'workspace',
            sourcePath: path.join(dir, '.mcp.json'),
            tokenCost: { alwaysInjected: 0, basis: 'unmeasured' },
            promptTokens: 0,
            enabled: true,
            controlMode: 'read-only-cli',
            controlReason: '프로젝트 .mcp.json에서 자동 로드됩니다.',
          });
        }
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
    const claudeDir = resolveClaudeConfigDir(this.getConfigDir());
    let timer: ReturnType<typeof setTimeout> | null = null;
    let closed = false;
    let watcher: fs.FSWatcher | null = null;
    try {
      if (fs.existsSync(claudeDir)) {
        watcher = fs.watch(claudeDir, () => {
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
