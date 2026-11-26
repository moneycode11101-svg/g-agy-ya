import { BrowserWindow, dialog, nativeImage } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BuiltinPluginPackage, DeskHostContext, HostPluginModule } from '../../src/kernel/shared/types';
import { AGENT_AGY_MANIFEST } from '../../src/plugins/agent-agy/manifest';
import { AGENT_CLAUDE_MANIFEST } from '../../src/plugins/agent-claude/manifest';
import { AGENT_CODEX_MANIFEST } from '../../src/plugins/agent-codex/manifest';
import { HUD_TOKEN_BAR_MANIFEST } from '../../src/plugins/hud-token-bar/manifest';
import { PANE_CHAT_MANIFEST } from '../../src/plugins/pane-chat/manifest';
import { RUNTIME_CONTEXT_INSPECTOR_MANIFEST } from '../../src/plugins/runtime-context-inspector/manifest';
import { SIDEBAR_WORKSPACE_MANIFEST } from '../../src/plugins/sidebar-workspace/manifest';
import { agentAgyHostPlugin } from './agent-agy/host';
import { agentClaudeHostPlugin } from './agent-claude/host';
import { agentCodexHostPlugin } from './agent-codex/host';

const MENTION_SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'dist-electron',
  '.next',
  'target',
  '__pycache__',
  '.cache',
  '.Trash',
  'Library',
  'Applications',
  '.venv',
  'venv',
]);

interface MentionFileEntry {
  name: string;
  relPath: string;
  fullPath: string;
  isDir: boolean;
}

function listWorkspaceFilesForMention(cwd: string, query = '', limit = 30): MentionFileEntry[] {
  const root = cwd && fs.existsSync(cwd) ? cwd : os.homedir();
  const isHomeRoot = path.resolve(root) === path.resolve(os.homedir());
  const maxDepth = isHomeRoot ? 2 : 4;
  const maxScan = 500;
  const q = query.trim().toLowerCase();

  const collected: MentionFileEntry[] = [];
  const queue: Array<{ dir: string; rel: string; depth: number }> = [{ dir: root, rel: '', depth: 0 }];

  while (queue.length > 0 && collected.length < maxScan) {
    const cur = queue.shift()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(cur.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (collected.length >= maxScan) break;
      const name = ent.name;
      if (name.startsWith('.') && name !== '.env' && name !== '.gitignore') continue;
      if (ent.isDirectory() && MENTION_SKIP_DIRS.has(name)) continue;

      const relPath = cur.rel ? `${cur.rel}/${name}` : name;
      const fullPath = path.join(cur.dir, name);
      const isDir = ent.isDirectory();

      collected.push({ name, relPath, fullPath, isDir });
      if (isDir && cur.depth + 1 < maxDepth) {
        queue.push({ dir: fullPath, rel: relPath, depth: cur.depth + 1 });
      }
    }
  }

  const filtered = q
    ? collected.filter(
        (item) => item.name.toLowerCase().includes(q) || item.relPath.toLowerCase().includes(q)
      )
    : collected;

  filtered.sort((a, b) => {
    if (q) {
      const aStart = a.name.toLowerCase().startsWith(q) ? 0 : 1;
      const bStart = b.name.toLowerCase().startsWith(q) ? 0 : 1;
      if (aStart !== bStart) return aStart - bStart;
    }
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.relPath.length - b.relPath.length || a.relPath.localeCompare(b.relPath);
  });

  return filtered.slice(0, limit);
}

/** Minimal host half for `pane-chat` (directory/file picker, @ mention file search, clipboard image paste & external links) */
const paneChatHostPlugin: HostPluginModule = {
  activate(ctx: DeskHostContext) {
    ctx.rpc.handle<void, string | null>('pane-chat:pickDirectory', () => ctx.host.pickDirectory());
    ctx.rpc.handle<{ cwd?: string; query?: string; limit?: number } | undefined, MentionFileEntry[]>(
      'pane-chat:listFiles',
      (payload) =>
        listWorkspaceFilesForMention(
          payload?.cwd || os.homedir(),
          payload?.query || '',
          payload?.limit ?? 24
        )
    );
    ctx.rpc.handle<void, string[]>('pane-chat:pickFiles', async () => {
      const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || null;
      const res = win
        ? await dialog.showOpenDialog(win, {
            title: '첨부할 파일 또는 이미지 선택',
            properties: ['openFile', 'multiSelections'],
          })
        : await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'] });
      return res.canceled ? [] : res.filePaths;
    });
    ctx.rpc.handle<{ dataUrl: string; ext?: string }, string | null>(
      'pane-chat:saveClipboardImage',
      async ({ dataUrl, ext }) => {
        if (!dataUrl || !dataUrl.startsWith('data:image/')) return null;
        const comma = dataUrl.indexOf(',');
        if (comma === -1) return null;
        const buf = Buffer.from(dataUrl.slice(comma + 1), 'base64');
        const dir = path.join(os.homedir(), '.gemini', 'antigravity', 'agy-desk-paste');
        fs.mkdirSync(dir, { recursive: true });
        const safeExt = (ext || 'png').replace(/[^a-z0-9]/gi, '').toLowerCase() || 'png';
        const suffix = Math.random().toString(36).slice(2, 6);
        const outPath = path.join(dir, `paste-${Date.now().toString(36)}-${suffix}.${safeExt}`);
        fs.writeFileSync(outPath, buf);
        return outPath;
      }
    );
    ctx.rpc.handle<
      { paths?: string[] } | undefined,
      Array<{ path: string; exists: boolean; isDir: boolean; isImage: boolean; name: string }>
    >('pane-chat:inspectPaths', (payload) => {
      const IMAGE_EXTS = new Set([
        '.png',
        '.jpg',
        '.jpeg',
        '.webp',
        '.gif',
        '.bmp',
        '.svg',
        '.avif',
        '.heic',
        '.heif',
        '.tif',
        '.tiff',
        '.ico',
      ]);
      const raw = Array.isArray(payload?.paths) ? payload!.paths : [];
      const results: Array<{ path: string; exists: boolean; isDir: boolean; isImage: boolean; name: string }> = [];
      for (const p of raw) {
        if (typeof p !== 'string' || !p.trim()) continue;
        try {
          const st = fs.statSync(p);
          const ext = path.extname(p).toLowerCase();
          results.push({
            path: p,
            exists: true,
            isDir: st.isDirectory(),
            isImage: st.isFile() && IMAGE_EXTS.has(ext),
            name: path.basename(p) || p,
          });
        } catch {
          results.push({
            path: p,
            exists: false,
            isDir: false,
            isImage: false,
            name: path.basename(p) || p,
          });
        }
      }
      return results;
    });
    ctx.rpc.handle<{ filePath?: string; maxSize?: number } | undefined, string | null>(
      'pane-chat:getImageThumbnail',
      (payload) => {
        const filePath = payload?.filePath;
        if (typeof filePath !== 'string' || !filePath.trim()) return null;
        const MIME_MAP: Record<string, string> = {
          '.png': 'image/png',
          '.jpg': 'image/jpeg',
          '.jpeg': 'image/jpeg',
          '.webp': 'image/webp',
          '.gif': 'image/gif',
          '.bmp': 'image/bmp',
          '.svg': 'image/svg+xml',
          '.avif': 'image/avif',
          '.ico': 'image/x-icon',
          '.heic': 'image/heic',
          '.heif': 'image/heif',
          '.tif': 'image/tiff',
          '.tiff': 'image/tiff',
        };
        const ext = path.extname(filePath).toLowerCase();
        const mime = MIME_MAP[ext];
        if (!mime) return null;
        try {
          const st = fs.statSync(filePath);
          if (!st.isFile() || st.size === 0) return null;
          const maxSize = Math.max(48, Math.min(1600, payload?.maxSize ?? 200));

          // SVG / GIF / WebP / AVIF: try nativeImage first for fast thumbnailing (except SVG/GIF)
          if (ext !== '.svg' && ext !== '.gif') {
            const img = nativeImage.createFromPath(filePath);
            if (!img.isEmpty()) {
              const size = img.getSize();
              const longest = Math.max(size.width, size.height);
              const target =
                longest > maxSize
                  ? size.width >= size.height
                    ? img.resize({ width: maxSize, quality: 'good' })
                    : img.resize({ height: maxSize, quality: 'good' })
                  : img;
              return target.toDataURL();
            }
          }

          // Fallback for SVG, animated GIF, or formats nativeImage doesn't decode directly
          if (st.size <= 8 * 1024 * 1024) {
            const b64 = fs.readFileSync(filePath).toString('base64');
            return `data:${mime};base64,${b64}`;
          }
          return null;
        } catch {
          return null;
        }
      }
    );
    ctx.rpc.handle<{ url?: string }, void>('pane-chat:openExternal', async (payload) => {
      if (payload?.url) {
        await ctx.host.openExternal(payload.url);
      }
    });
  },
};

/** Minimal host half for `sidebar-workspace` (project folder picker & Finder reveal, independent of agent-agy) */
const sidebarWorkspaceHostPlugin: HostPluginModule = {
  activate(ctx: DeskHostContext) {
    ctx.rpc.handle<void, string | null>('sidebar-workspace:pickDirectory', () => ctx.host.pickDirectory());
    ctx.rpc.handle<{ targetPath?: string }, void>('sidebar-workspace:showInFolder', (payload) => {
      if (payload?.targetPath) {
        ctx.host.showInFolder(payload.targetPath);
      }
    });
  },
};

/**
 * Wave 2 Agent & Data Host plugin packages (5 bundled plugins).
 * Registered into Electron Main via `createHostKernel().boot([...AGENT_HOST_PLUGINS, ...])`.
 */
export const AGENT_HOST_PLUGINS: BuiltinPluginPackage[] = [
  {
    manifest: AGENT_AGY_MANIFEST,
    host: agentAgyHostPlugin as HostPluginModule,
  },
  {
    manifest: AGENT_CLAUDE_MANIFEST,
    host: agentClaudeHostPlugin as HostPluginModule,
  },
  {
    manifest: AGENT_CODEX_MANIFEST,
    host: agentCodexHostPlugin as HostPluginModule,
  },
  {
    manifest: PANE_CHAT_MANIFEST,
    host: paneChatHostPlugin,
  },
  {
    manifest: HUD_TOKEN_BAR_MANIFEST,
  },
  {
    manifest: SIDEBAR_WORKSPACE_MANIFEST,
    host: sidebarWorkspaceHostPlugin,
  },
  {
    manifest: RUNTIME_CONTEXT_INSPECTOR_MANIFEST,
  },
];
