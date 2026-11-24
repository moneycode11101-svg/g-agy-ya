import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { powerSaveBlocker, session, shell } from 'electron';
import {
  DEFAULT_APP_SETTINGS,
  type AppSettings,
  type CustomizationsInventory,
  type DiscoveredSkill,
  type SystemRuntimeInfo,
} from '../src/shared/settingsTypes';

const HOME = os.homedir();
const SETTINGS_PATH = path.join(HOME, '.gemini', 'antigravity', 'agy-desk-settings.json');
const LIVE_QUOTA_PATH = path.join(HOME, '.gemini', 'antigravity', 'token-band', 'live-quota.json');

let powerBlockerId: number | null = null;
let onSettingsUpdatedHook: ((s: AppSettings) => void) | null = null;

export function setSettingsUpdateListener(cb: (s: AppSettings) => void): void {
  onSettingsUpdatedHook = cb;
}

export function loadAppSettings(): AppSettings {
  const defaults: AppSettings = {
    ...DEFAULT_APP_SETTINGS,
    defaultCwd: HOME,
    downloadDir: path.join(HOME, 'Downloads'),
  };
  try {
    if (!fs.existsSync(SETTINGS_PATH)) return defaults;
    const raw = fs.readFileSync(SETTINGS_PATH, 'utf8');
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    return {
      ...defaults,
      ...parsed,
      defaultCwd: parsed.defaultCwd || defaults.defaultCwd,
      downloadDir: parsed.downloadDir || defaults.downloadDir,
    };
  } catch {
    return defaults;
  }
}

export function applySystemEffects(settings: AppSettings): void {
  if (settings.preventSleep) {
    if (powerBlockerId === null || !powerSaveBlocker.isStarted(powerBlockerId)) {
      powerBlockerId = powerSaveBlocker.start('prevent-app-suspension');
    }
  } else if (powerBlockerId !== null) {
    if (powerSaveBlocker.isStarted(powerBlockerId)) {
      powerSaveBlocker.stop(powerBlockerId);
    }
    powerBlockerId = null;
  }
  onSettingsUpdatedHook?.(settings);
}

export function saveAppSettings(partial: Partial<AppSettings>): AppSettings {
  const next: AppSettings = { ...loadAppSettings(), ...partial };
  try {
    fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(next, null, 2) + '\n', 'utf8');
  } catch {
    // ignore disk errors
  }
  applySystemEffects(next);
  return next;
}

export async function clearEmbeddedBrowserData(): Promise<boolean> {
  try {
    const ses = session.fromPartition('persist:agy-desk-browser');
    await ses.clearCache();
    await ses.clearStorageData({ storages: ['cachestorage', 'serviceworkers'] });
    return true;
  } catch {
    return false;
  }
}

export async function openOsNotificationSettings(): Promise<void> {
  if (process.platform === 'darwin') {
    await shell.openExternal('x-apple.systempreferences:com.apple.Notifications-Settings.extension');
  }
}

let cachedAgyVersion: string | null = null;
function detectAgyVersion(): string {
  if (cachedAgyVersion !== null) return cachedAgyVersion;
  try {
    const bin = fs.existsSync(path.join(HOME, '.local', 'bin', 'agy'))
      ? path.join(HOME, '.local', 'bin', 'agy')
      : 'agy';
    cachedAgyVersion = execFileSync(bin, ['--version'], { encoding: 'utf8', timeout: 2000 }).trim();
  } catch {
    cachedAgyVersion = '미설치';
  }
  return cachedAgyVersion;
}

export function getSystemRuntimeInfo(appVersion: string): SystemRuntimeInfo {
  let email: string | null = null;
  let planTier: string | null = null;
  try {
    const q = JSON.parse(fs.readFileSync(LIVE_QUOTA_PATH, 'utf8')) as {
      email?: string | null;
      planTier?: string | null;
    };
    email = q.email || null;
    planTier = q.planTier || null;
  } catch {
    // ignore
  }
  return {
    appVersion,
    agyCliVersion: detectAgyVersion(),
    hostname: os.hostname(),
    downloadDir: loadAppSettings().downloadDir,
    email,
    planTier,
  };
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.round(text.length / 3.5));
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

export function scanCustomizationsInventory(): CustomizationsInventory {
  const skills: DiscoveredSkill[] = [];
  const rules: Array<{ name: string; path: string; tokens: number }> = [];
  const mcpServers: Array<{ name: string; pluginName?: string; tokens: number }> = [];
  const seenSkills = new Set<string>();

  const scanSkillDir = (dir: string, scope: DiscoveredSkill['scope'], pluginName?: string) => {
    if (!fs.existsSync(dir)) return;
    let ents: fs.Dirent[];
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of ents) {
      if (!ent.isDirectory()) continue;
      const skillFile = path.join(dir, ent.name, 'SKILL.md');
      if (!fs.existsSync(skillFile)) continue;
      try {
        const content = fs.readFileSync(skillFile, 'utf8');
        const fm = parseFrontmatter(content);
        const name = fm.name || ent.name;
        if (seenSkills.has(name)) continue;
        seenSkills.add(name);
        const headerTokens = estimateTokens(`${name}: ${fm.description}`);
        skills.push({
          name,
          description: fm.description || '설명 없음',
          scope,
          pluginName,
          tokens: headerTokens,
        });
      } catch {
        // ignore
      }
    }
  };

  const pluginsRoot = path.join(HOME, '.gemini', 'config', 'plugins');
  if (fs.existsSync(pluginsRoot)) {
    try {
      for (const pEnt of fs.readdirSync(pluginsRoot, { withFileTypes: true })) {
        if (!pEnt.isDirectory()) continue;
        const pDir = path.join(pluginsRoot, pEnt.name);
        scanSkillDir(path.join(pDir, 'skills'), 'plugin', pEnt.name);

        const rulesDir = path.join(pDir, 'rules');
        if (fs.existsSync(rulesDir)) {
          for (const rf of fs.readdirSync(rulesDir)) {
            if (!rf.endsWith('.md')) continue;
            const full = path.join(rulesDir, rf);
            try {
              const txt = fs.readFileSync(full, 'utf8');
              rules.push({ name: `${pEnt.name}/${rf}`, path: full, tokens: estimateTokens(txt) });
            } catch {
              // ignore
            }
          }
        }

        const mcpFile = path.join(pDir, 'mcp_config.json');
        if (fs.existsSync(mcpFile)) {
          try {
            const cfg = JSON.parse(fs.readFileSync(mcpFile, 'utf8')) as {
              mcpServers?: Record<string, unknown>;
            };
            for (const srv of Object.keys(cfg.mcpServers || {})) {
              mcpServers.push({ name: `${pEnt.name}_${srv}`, pluginName: pEnt.name, tokens: 6 });
            }
          } catch {
            // ignore
          }
        }
      }
    } catch {
      // ignore
    }
  }

  scanSkillDir(path.join(HOME, '.gemini', 'config', 'skills'), 'global');
  scanSkillDir(path.join(HOME, '.gemini', 'antigravity', 'builtin', 'skills'), 'builtin');

  skills.sort((a, b) => a.name.localeCompare(b.name));

  return {
    ruleTokens: rules.reduce((s, r) => s + r.tokens, 0),
    ruleCount: rules.length,
    skillTokens: skills.reduce((s, x) => s + x.tokens, 0),
    skillCount: skills.length,
    mcpTokens: mcpServers.reduce((s, x) => s + x.tokens, 0),
    mcpCount: mcpServers.length,
    skills,
    rules,
    mcpServers,
  };
}
