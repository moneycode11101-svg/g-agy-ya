import { execFile } from 'node:child_process';
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
import { buildAgySpawnEnv, resolveAgyBinary } from './quota';

const HOME = os.homedir();
const GEMINI_CONFIG_DIR = path.join(HOME, '.gemini', 'config');
const GEMINI_CONFIG_JSON = path.join(GEMINI_CONFIG_DIR, 'config.json');
const PLUGINS_ROOT = path.join(GEMINI_CONFIG_DIR, 'plugins');
const GLOBAL_SKILLS_ROOT = path.join(GEMINI_CONFIG_DIR, 'skills');
const GLOBAL_MCP_CONFIG = path.join(GEMINI_CONFIG_DIR, 'mcp_config.json');
const GLOBAL_HOOKS_JSON = path.join(GEMINI_CONFIG_DIR, 'hooks.json');
const CLI_BUILTIN_ROOT = path.join(HOME, '.gemini', 'antigravity-cli', 'builtin');
const APP_BUILTIN_ROOT = path.join(HOME, '.gemini', 'antigravity', 'builtin');
const CLI_MCP_CACHE_ROOT = path.join(HOME, '.gemini', 'antigravity-cli', 'mcp');
const APP_MCP_CACHE_ROOT = path.join(HOME, '.gemini', 'antigravity', 'mcp');

const RULES_BUDGET_TOKENS = 20_000;
const PER_RULE_FILE_MAX_BYTES = 24_000;

function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.round(text.length / 3.5));
}

/** Symlink-aware directory check: fixes legacy Dirent.isDirectory() bug that dropped yeop / lee-tools / global skills! */
function inspectDirEntry(fullPath: string): { isDir: boolean; isSymlink: boolean; realPath?: string } {
  try {
    const lstat = fs.lstatSync(fullPath);
    const isSymlink = lstat.isSymbolicLink();
    const stat = isSymlink ? fs.statSync(fullPath) : lstat;
    if (!stat.isDirectory()) return { isDir: false, isSymlink };
    const realPath = isSymlink ? fs.realpathSync(fullPath) : undefined;
    return { isDir: true, isSymlink, realPath };
  } catch {
    return { isDir: false, isSymlink: false };
  }
}

function safeReadJsonc(filePath: string): Record<string, unknown> | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf8');
    // Minimal JSONC strip (line/block comments + trailing commas) for plugin.json
    const cleaned = raw
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|\s)\/\/.*$/gm, '$1')
      .replace(/,\s*([}\]])/g, '$1');
    const parsed = JSON.parse(cleaned);
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

function readConfigPluginStates(): Record<string, { enabled?: boolean }> {
  const cfg = safeReadJsonc(GEMINI_CONFIG_JSON);
  const plugins = cfg?.plugins;
  if (!plugins || typeof plugins !== 'object') return {};
  return plugins as Record<string, { enabled?: boolean }>;
}

/**
 * Measures REAL serialized MCP tool schemas & instructions from `~/.gemini/antigravity-cli/mcp/<key>/`
 * (replaces legacy hardcoded `tokens: 6` distortion).
 */
function measureMcpCacheTokens(candidates: string[]): { tokens: number; toolCount: number; basis: 'measured-cache' | 'unmeasured'; cacheDir?: string } {
  for (const root of [CLI_MCP_CACHE_ROOT, APP_MCP_CACHE_ROOT]) {
    for (const key of candidates) {
      const dir = path.join(root, key);
      if (!fs.existsSync(dir)) continue;
      try {
        const files = fs.readdirSync(dir);
        let totalChars = 0;
        let toolCount = 0;
        for (const f of files) {
          if (!f.endsWith('.json') && !f.endsWith('.md')) continue;
          const content = fs.readFileSync(path.join(dir, f), 'utf8');
          totalChars += content.length;
          if (f.endsWith('.json')) toolCount += 1;
        }
        if (totalChars > 0) {
          return {
            tokens: Math.max(1, Math.round(totalChars / 3.5)),
            toolCount,
            basis: 'measured-cache',
            cacheDir: dir,
          };
        }
      } catch {
        // try next candidate
      }
    }
  }
  return { tokens: 0, toolCount: 0, basis: 'unmeasured' };
}

function findWorkspaceAncestors(cwd?: string): string[] {
  if (!cwd) return [];
  try {
    const resolved = path.resolve(cwd);
    if (!fs.existsSync(resolved)) return [];
    const dirs: string[] = [];
    let cur = resolved;
    for (let depth = 0; depth < 12; depth++) {
      dirs.push(cur);
      if (fs.existsSync(path.join(cur, '.git')) || cur === HOME) break;
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
    return dirs;
  } catch {
    return [];
  }
}

function execAgySubcommand(args: string[]): Promise<{ ok: boolean; stdout: string; error?: string }> {
  return new Promise((resolve) => {
    execFile(
      resolveAgyBinary(),
      args,
      {
        cwd: HOME,
        timeout: 12_000,
        maxBuffer: 512 * 1024,
        env: buildAgySpawnEnv(),
      },
      (err, stdout, stderr) => {
        if (err) {
          const msg = (stderr || stdout || err.message).trim();
          resolve({ ok: false, stdout: stdout || '', error: msg || `agy ${args.join(' ')} failed` });
          return;
        }
        resolve({ ok: true, stdout: stdout || '' });
      }
    );
  });
}

/**
 * Layer 2 RuntimeAssetProvider for `agent-agy`.
 * - Symlink-aware scanning (tracks `yeop`, `lee-tools/skills/*`, `~/.gemini/config/skills/*`)
 * - Authoritative `config.json` enabled/disabled status
 * - Real MCP tool schema cache token measurement (`~/.gemini/antigravity-cli/mcp/`)
 * - Workspace `.agents/` & hierarchical `AGENTS.md`/`GEMINI.md` scanning
 * - Honest `controlMode` ('global-only' vs 'read-only-cli') + safe CLI mutation (`agy plugin` / `agy mcp`)
 */
export class AgyRuntimeAssetProvider implements RuntimeAssetProvider {
  readonly adapterPluginId = BUILTIN_PLUGIN_IDS.AGENT_AGY;
  readonly adapterLabel = 'Antigravity CLI (agy)';
  private readonly onAssetsMutated?: () => void;
  private lastCwd?: string;

  constructor(opts?: { onAssetsMutated?: () => void }) {
    this.onAssetsMutated = opts?.onAssetsMutated;
  }

  async scanAssets(cwd?: string): Promise<RuntimeAssetsProjection> {
    if (cwd) this.lastCwd = cwd;
    const effectiveCwd = cwd || this.lastCwd;
    const assets: RuntimeContextAsset[] = [];
    const configStates = readConfigPluginStates();
    const seenSkillNames = new Set<string>();
    const seenRulePaths = new Set<string>();

    const scanSkillDir = (
      dir: string,
      scope: RuntimeContextAsset['scope'],
      parentPluginName: string | undefined,
      parentEnabled: boolean
    ) => {
      if (!fs.existsSync(dir)) return;
      let names: string[];
      try {
        names = fs.readdirSync(dir);
      } catch {
        return;
      }
      for (const name of names) {
        if (name.startsWith('.')) continue;
        const fullDir = path.join(dir, name);
        const info = inspectDirEntry(fullDir);
        if (!info.isDir) continue;
        const skillFile = path.join(fullDir, 'SKILL.md');
        if (!fs.existsSync(skillFile)) continue;
        try {
          const content = fs.readFileSync(skillFile, 'utf8');
          const fm = parseFrontmatter(content);
          const skillName = fm.name || name;
          const dedupKey = `${scope}:${parentPluginName || ''}:${skillName}`;
          if (seenSkillNames.has(dedupKey)) continue;
          seenSkillNames.add(dedupKey);

          const headerTokens = estimateTokens(`${skillName}: ${fm.description} (${skillFile})`);
          const bodyTokens = estimateTokens(content);

          assets.push({
            id: `skill:${scope}:${parentPluginName ? `${parentPluginName}:` : ''}${skillName}`,
            kind: 'skill',
            name: skillName,
            description: fm.description || '설명 없음',
            scope,
            parentPluginName,
            sourcePath: skillFile,
            isSymlink: info.isSymlink,
            realPath: info.realPath,
            tokenCost: {
              alwaysInjected: headerTokens,
              onDemandBody: bodyTokens,
              basis: 'file-estimate',
            },
            promptTokens: headerTokens,
            lazyBodyTokens: bodyTokens,
            enabled: parentEnabled,
            controlMode: 'read-only-cli',
            controlReason: parentPluginName
              ? `플러그인 "${parentPluginName}" 번들 단위로 ON/OFF 제어됩니다.`
              : scope === 'builtin'
                ? 'agy CLI 기본 내장 스킬은 개별 비활성화를 지원하지 않습니다.'
                : '개별 글로벌 스킬은 agy CLI 공식 토글이 없습니다 (플러그인으로 묶어 제어 권장).',
          });
        } catch {
          // ignore unreadable skill
        }
      }
    };

    const addRuleFile = (
      rulePath: string,
      displayName: string,
      scope: RuntimeContextAsset['scope'],
      parentPluginName: string | undefined,
      enabled: boolean
    ) => {
      try {
        const real = fs.realpathSync(rulePath);
        if (seenRulePaths.has(real)) return;
        seenRulePaths.add(real);
        const buf = fs.readFileSync(rulePath);
        const truncated = buf.length > PER_RULE_FILE_MAX_BYTES;
        const text = buf.subarray(0, PER_RULE_FILE_MAX_BYTES).toString('utf8');
        const tokens = estimateTokens(text);

        assets.push({
          id: `rule:${scope}:${displayName}`,
          kind: 'rule',
          name: displayName,
          description: truncated
            ? `24KB 상한으로 절단됨 (원본 ${Math.round(buf.length / 1024)}KB)`
            : scope === 'workspace'
              ? '워크스페이스 계층 규칙 (항상 적용)'
              : parentPluginName
                ? `플러그인 ${parentPluginName} 활성 시 적용`
                : '전역 규칙',
          scope,
          parentPluginName,
          sourcePath: rulePath,
          isSymlink: fs.lstatSync(rulePath).isSymbolicLink(),
          realPath: real !== rulePath ? real : undefined,
          tokenCost: { alwaysInjected: tokens, basis: 'file-estimate' },
          promptTokens: tokens,
          enabled,
          controlMode: 'read-only-cli',
          controlReason: parentPluginName
            ? `부모 플러그인 "${parentPluginName}" 토글로 함께 제어됩니다.`
            : '디렉터리 계층 규칙(AGENTS.md/GEMINI.md)은 agy CLI에서 자동 로드됩니다.',
        });
      } catch {
        // ignore unreadable rule
      }
    };

    // 1) Installed user/marketplace plugins in `~/.gemini/config/plugins` (symlink-safe!)
    if (fs.existsSync(PLUGINS_ROOT)) {
      try {
        for (const dirName of fs.readdirSync(PLUGINS_ROOT)) {
          if (dirName.startsWith('.')) continue;
          const pDir = path.join(PLUGINS_ROOT, dirName);
          const info = inspectDirEntry(pDir);
          if (!info.isDir) continue;

          const manifestJson = safeReadJsonc(path.join(pDir, 'plugin.json')) || {};
          const displayName = String(manifestJson.displayName || manifestJson.name || dirName);
          const description = String(manifestJson.description || '설치된 agy CLI 플러그인 번들');
          const defaultEnabled = manifestJson.disabled === true ? false : true;
          const cfgEntry = configStates[dirName];
          const enabled = typeof cfgEntry?.enabled === 'boolean' ? cfgEntry.enabled : defaultEnabled;

          const beforeIdx = assets.length;

          // Scan child skills
          scanSkillDir(path.join(pDir, 'skills'), 'plugin', dirName, enabled);

          // Scan child rules
          const rulesDir = path.join(pDir, 'rules');
          if (fs.existsSync(rulesDir)) {
            try {
              for (const rf of fs.readdirSync(rulesDir)) {
                if (!rf.endsWith('.md')) continue;
                addRuleFile(path.join(rulesDir, rf), `${dirName}/${rf}`, 'plugin', dirName, enabled);
              }
            } catch {
              // ignore
            }
          }

          // Scan child MCP servers + real schema cache measurement
          const mcpFile = path.join(pDir, 'mcp_config.json');
          if (fs.existsSync(mcpFile)) {
            const cfg = safeReadJsonc(mcpFile);
            const servers = cfg?.mcpServers;
            if (servers && typeof servers === 'object') {
              for (const srvName of Object.keys(servers as Record<string, unknown>)) {
                const measured = measureMcpCacheTokens([`${dirName}_${srvName}`, srvName]);
                assets.push({
                  id: `mcp:plugin:${dirName}:${srvName}`,
                  kind: 'mcp',
                  name: `${dirName}_${srvName}`,
                  description:
                    measured.basis === 'measured-cache'
                      ? `캐시된 도구 ${measured.toolCount}개 스키마 실측 (${dirName} 플러그인)`
                      : `도구 스키마 캐시 미생성 — 첫 실행 후 실측됨 (${dirName} 플러그인)`,
                  scope: 'plugin',
                  parentPluginName: dirName,
                  sourcePath: measured.cacheDir || mcpFile,
                  tokenCost: { alwaysInjected: measured.tokens, basis: measured.basis },
                  promptTokens: measured.tokens,
                  enabled,
                  controlMode: 'read-only-cli',
                  controlReason: `부모 플러그인 "${dirName}"을 토글하면 이 MCP 서버도 함께 켜지거나 꺼집니다.`,
                });
              }
            }
          }

          // Scan child hooks
          const hooksFile = path.join(pDir, 'hooks.json');
          if (fs.existsSync(hooksFile)) {
            const hJson = safeReadJsonc(hooksFile);
            if (hJson) {
              for (const [hookName, hookSpec] of Object.entries(hJson)) {
                const hookObj = hookSpec && typeof hookSpec === 'object' ? (hookSpec as Record<string, unknown>) : {};
                const hookEnabled = enabled && hookObj.enabled !== false;
                assets.push({
                  id: `hook:plugin:${dirName}:${hookName}`,
                  kind: 'hook',
                  name: `${dirName}/${hookName}`,
                  description: '플러그인 라이프사이클 훅 (프롬프트 토큰 미소비)',
                  scope: 'plugin',
                  parentPluginName: dirName,
                  sourcePath: hooksFile,
                  tokenCost: { alwaysInjected: 0, basis: 'measured-cache' },
                  promptTokens: 0,
                  enabled: hookEnabled,
                  controlMode: 'read-only-cli',
                  controlReason: `부모 플러그인 "${dirName}" 단위로 제어됩니다.`,
                });
              }
            }
          }

          // Sum child always-injected tokens for the parent bundle summary
          const children = assets.slice(beforeIdx);
          const bundleTokens = children.reduce((sum, c) => sum + c.promptTokens, 0);
          assets.splice(beforeIdx, 0, {
            id: `plugin:${dirName}`,
            kind: 'plugin-bundle',
            name: displayName,
            description,
            scope: 'global',
            sourcePath: pDir,
            isSymlink: info.isSymlink,
            realPath: info.realPath,
            tokenCost: {
              alwaysInjected: bundleTokens,
              basis: children.some((c) => c.tokenCost.basis === 'measured-cache') ? 'measured-cache' : 'file-estimate',
            },
            promptTokens: bundleTokens,
            enabled,
            controlMode: 'global-only',
            controlReason: 'agy plugin enable/disable 명령으로 전역 활성화 상태를 변경합니다.',
            sideEffects: [
              '전역 ~/.gemini/config/config.json 변경 (다른 터미널 agy CLI · 앱에도 반영)',
              '활성 채팅 워커는 다음 턴에 재기동되며 프롬프트 캐시가 초기화될 수 있음',
            ],
          });
        }
      } catch {
        // ignore plugins root scan error
      }
    }

    // 2) Built-in plugins (`~/.gemini/antigravity-cli/builtin/plugins`, e.g., swarm)
    const builtinPluginsRoot = fs.existsSync(path.join(CLI_BUILTIN_ROOT, 'plugins'))
      ? path.join(CLI_BUILTIN_ROOT, 'plugins')
      : path.join(APP_BUILTIN_ROOT, 'plugins');
    if (fs.existsSync(builtinPluginsRoot)) {
      try {
        for (const dirName of fs.readdirSync(builtinPluginsRoot)) {
          if (dirName.startsWith('.')) continue;
          const pDir = path.join(builtinPluginsRoot, dirName);
          const info = inspectDirEntry(pDir);
          if (!info.isDir) continue;
          const mJson = safeReadJsonc(path.join(pDir, 'plugin.json')) || {};
          const cfgEntry = configStates[dirName];
          const enabled = typeof cfgEntry?.enabled === 'boolean' ? cfgEntry.enabled : mJson.disabled !== true;
          assets.push({
            id: `plugin:${dirName}`,
            kind: 'plugin-bundle',
            name: String(mJson.displayName || mJson.name || dirName),
            description: String(mJson.description || 'Antigravity 내장 플러그인 (삭제 불가, 비활성화 가능)'),
            scope: 'builtin',
            sourcePath: pDir,
            tokenCost: { alwaysInjected: 0, basis: 'unmeasured' },
            promptTokens: 0,
            enabled,
            controlMode: 'global-only',
            controlReason: '내장 플러그인은 agy plugin enable/disable로 전역 전환만 가능합니다.',
            sideEffects: ['전역 config.json 변경 (삭제 불가)'],
          });
        }
      } catch {
        // ignore
      }
    }

    // 3) Global standalone MCP servers (`~/.gemini/config/mcp_config.json`)
    if (fs.existsSync(GLOBAL_MCP_CONFIG)) {
      const mcpCfg = safeReadJsonc(GLOBAL_MCP_CONFIG);
      const servers = mcpCfg?.mcpServers;
      if (servers && typeof servers === 'object') {
        for (const [srvName, srvVal] of Object.entries(servers as Record<string, unknown>)) {
          const obj = srvVal && typeof srvVal === 'object' ? (srvVal as Record<string, unknown>) : {};
          const enabled = obj.disabled !== true;
          const measured = measureMcpCacheTokens([srvName]);
          assets.push({
            id: `mcp-global:${srvName}`,
            kind: 'mcp',
            name: srvName,
            description:
              measured.basis === 'measured-cache'
                ? `전역 MCP 서버 · 캐시된 도구 ${measured.toolCount}개 실측`
                : '전역 MCP 서버 (도구 스키마 캐시 미생성)',
            scope: 'global',
            sourcePath: measured.cacheDir || GLOBAL_MCP_CONFIG,
            tokenCost: { alwaysInjected: measured.tokens, basis: measured.basis },
            promptTokens: measured.tokens,
            enabled,
            controlMode: 'global-only',
            controlReason: 'agy mcp enable/disable 명령으로 전역 전환합니다.',
            sideEffects: ['전역 mcp_config.json 변경'],
          });
        }
      }
    }

    // 4) Global hooks (`~/.gemini/config/hooks.json`)
    if (fs.existsSync(GLOBAL_HOOKS_JSON)) {
      const hJson = safeReadJsonc(GLOBAL_HOOKS_JSON);
      if (hJson) {
        for (const [hookName, hookSpec] of Object.entries(hJson)) {
          const hookObj = hookSpec && typeof hookSpec === 'object' ? (hookSpec as Record<string, unknown>) : {};
          assets.push({
            id: `hook:global:${hookName}`,
            kind: 'hook',
            name: hookName,
            description: '전역 라이프사이클 훅 (~/.gemini/config/hooks.json)',
            scope: 'global',
            sourcePath: GLOBAL_HOOKS_JSON,
            tokenCost: { alwaysInjected: 0, basis: 'measured-cache' },
            promptTokens: 0,
            enabled: hookObj.enabled !== false,
            controlMode: 'read-only-cli',
            controlReason: '~/.gemini/config/hooks.json에서 enabled 필드로 관리됩니다.',
          });
        }
      }
    }

    // 5) Global standalone skills (`~/.gemini/config/skills`, symlink-safe!)
    scanSkillDir(GLOBAL_SKILLS_ROOT, 'global', undefined, true);

    // 6) CLI built-in skills (`~/.gemini/antigravity-cli/builtin/skills` preferred over App dir!)
    const builtinSkillsRoot = fs.existsSync(path.join(CLI_BUILTIN_ROOT, 'skills'))
      ? path.join(CLI_BUILTIN_ROOT, 'skills')
      : path.join(APP_BUILTIN_ROOT, 'skills');
    scanSkillDir(builtinSkillsRoot, 'builtin', undefined, true);

    // 7) Workspace-level hierarchical rules & `.agents/` skills for active `cwd`
    const workspaceDirs = findWorkspaceAncestors(effectiveCwd);
    for (const dir of workspaceDirs) {
      for (const ruleName of ['AGENTS.md', 'GEMINI.md']) {
        const rp = path.join(dir, ruleName);
        if (fs.existsSync(rp)) {
          addRuleFile(rp, `${path.basename(dir)}/${ruleName}`, 'workspace', undefined, true);
        }
      }
      for (const dotDir of ['.agents', '.agent']) {
        const base = path.join(dir, dotDir);
        if (!fs.existsSync(base)) continue;
        scanSkillDir(path.join(base, 'skills'), 'workspace', undefined, true);
        const rDir = path.join(base, 'rules');
        if (fs.existsSync(rDir)) {
          try {
            for (const rf of fs.readdirSync(rDir)) {
              if (!rf.endsWith('.md')) continue;
              addRuleFile(path.join(rDir, rf), `${path.basename(dir)}/${dotDir}/rules/${rf}`, 'workspace', undefined, true);
            }
          } catch {
            // ignore
          }
        }
      }
    }

    // Calculate active totals (exclude plugin-bundle wrapper to avoid double-counting children!)
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
      tokenBudgetMax: RULES_BUDGET_TOKENS,
      totals: {
        ruleTokens,
        skillTokens,
        mcpTokens,
      },
      activePresetId: null,
      presets: [],
      assets,
    };
  }

  async toggleAsset(req: {
    assetId: string;
    enabled: boolean;
    scope?: 'session' | 'workspace' | 'global';
    cwd?: string;
  }): Promise<{ ok: boolean; requiresWorkerRestart?: boolean; cacheResetLikely?: boolean; error?: string }> {
    const verb = req.enabled ? 'enable' : 'disable';

    if (req.assetId.startsWith('plugin:')) {
      const dirName = req.assetId.slice('plugin:'.length);
      if (!dirName || !/^[a-zA-Z0-9._-]+$/.test(dirName)) {
        return { ok: false, error: `잘못된 플러그인 이름: ${dirName}` };
      }
      const res = await execAgySubcommand(['plugin', verb, dirName]);
      if (!res.ok) return { ok: false, error: res.error };
      this.onAssetsMutated?.();
      return { ok: true, requiresWorkerRestart: true, cacheResetLikely: true };
    }

    if (req.assetId.startsWith('mcp-global:')) {
      const srvName = req.assetId.slice('mcp-global:'.length);
      if (!srvName || !/^[a-zA-Z0-9._-]+$/.test(srvName)) {
        return { ok: false, error: `잘못된 MCP 서버 이름: ${srvName}` };
      }
      const res = await execAgySubcommand(['mcp', verb, srvName]);
      if (!res.ok) return { ok: false, error: res.error };
      this.onAssetsMutated?.();
      return { ok: true, requiresWorkerRestart: true, cacheResetLikely: true };
    }

    return {
      ok: false,
      error: '이 항목은 agy CLI에서 개별 토글을 지원하지 않습니다. 부모 플러그인 번들 단위로 제어하세요.',
    };
  }

  watch(onChange: (projection: RuntimeAssetsProjection) => void): Disposer {
    const watchers: fs.FSWatcher[] = [];
    let debounce: ReturnType<typeof setTimeout> | null = null;
    let closed = false;

    const trigger = () => {
      if (closed) return;
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        if (closed) return;
        void this.scanAssets(this.lastCwd).then((proj) => {
          if (!closed) onChange(proj);
        });
      }, 250);
    };

    const dirs = [GEMINI_CONFIG_DIR, PLUGINS_ROOT, GLOBAL_SKILLS_ROOT, CLI_MCP_CACHE_ROOT];
    for (const dir of dirs) {
      if (!fs.existsSync(dir)) continue;
      try {
        watchers.push(fs.watch(dir, () => trigger()));
      } catch {
        // ignore unwatched dir
      }
    }

    return () => {
      closed = true;
      if (debounce) clearTimeout(debounce);
      for (const w of watchers) {
        try {
          w.close();
        } catch {
          // ignore
        }
      }
    };
  }
}
