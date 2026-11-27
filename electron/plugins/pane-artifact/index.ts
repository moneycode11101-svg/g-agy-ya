import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BuiltinPluginPackage, HostPluginModule } from '../../../src/kernel/shared/types';
import { paneArtifactManifest } from '../../../src/plugins/pane-artifact/manifest';

const MAX_ARTIFACT_READ_BYTES = 2 * 1024 * 1024; // 2 MB text preview cap
const MARKDOWN_EXT_RE = /\.(md|mdx|markdown)$/i;

export interface ArtifactFileSnapshot {
  ok: boolean;
  filePath: string;
  fileName: string;
  dirPath: string;
  ext: string;
  content?: string;
  size?: number;
  mtimeMs?: number;
  isMarkdown?: boolean;
  isBinary?: boolean;
  tooLarge?: boolean;
  error?: string;
}

function resolveLocalPath(raw: string): string | null {
  const trimmed = String(raw || '').trim();
  if (!trimmed || trimmed.includes('\0')) return null;
  const expanded = trimmed.replace(/^~(?=\/|$)/, os.homedir());
  if (!path.isAbsolute(expanded)) return null;
  return path.resolve(expanded);
}

function readArtifactFile(rawPath: string): ArtifactFileSnapshot {
  const resolved = resolveLocalPath(rawPath);
  if (!resolved) {
    return {
      ok: false,
      filePath: rawPath,
      fileName: path.basename(rawPath || ''),
      dirPath: '',
      ext: '',
      error: '올바른 절대 경로가 아닙니다.',
    };
  }
  const fileName = path.basename(resolved);
  const dirPath = path.dirname(resolved);
  const ext = path.extname(resolved).toLowerCase();

  try {
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) {
      return {
        ok: false,
        filePath: resolved,
        fileName,
        dirPath,
        ext,
        error: '파일이 아닙니다 (디렉터리 또는 특수 경로).',
      };
    }
    if (stat.size > MAX_ARTIFACT_READ_BYTES) {
      return {
        ok: false,
        filePath: resolved,
        fileName,
        dirPath,
        ext,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        tooLarge: true,
        error: `파일 크기가 ${(stat.size / (1024 * 1024)).toFixed(1)}MB로 인앱 미리보기 한도(2MB)를 초과합니다.`,
      };
    }

    const buf = fs.readFileSync(resolved);
    const probeLen = Math.min(buf.length, 8192);
    let hasNullByte = false;
    for (let i = 0; i < probeLen; i++) {
      if (buf[i] === 0) {
        hasNullByte = true;
        break;
      }
    }
    if (hasNullByte) {
      return {
        ok: false,
        filePath: resolved,
        fileName,
        dirPath,
        ext,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        isBinary: true,
        error: '바이너리 파일은 텍스트 미리보기를 지원하지 않습니다.',
      };
    }

    return {
      ok: true,
      filePath: resolved,
      fileName,
      dirPath,
      ext,
      content: buf.toString('utf8'),
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      isMarkdown: MARKDOWN_EXT_RE.test(resolved),
    };
  } catch (err) {
    return {
      ok: false,
      filePath: resolved,
      fileName,
      dirPath,
      ext,
      error: err instanceof Error ? err.message : '파일을 읽을 수 없습니다.',
    };
  }
}

interface WatchEntry {
  watcher: fs.FSWatcher;
  timer: ReturnType<typeof setTimeout> | null;
}

const watchers = new Map<string, WatchEntry>();

function stopWatch(watchId: string): void {
  const entry = watchers.get(watchId);
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  try {
    entry.watcher.close();
  } catch {
    // ignore
  }
  watchers.delete(watchId);
}

export const paneArtifactHost: HostPluginModule = {
  activate(ctx) {
    ctx.rpc.handle<{ filePath: string }, ArtifactFileSnapshot>('pane-artifact:read-file', async ({ filePath }) => {
      return readArtifactFile(filePath);
    });

    ctx.rpc.handle<{ watchId: string; filePath: string }, boolean>(
      'pane-artifact:watch',
      async ({ watchId, filePath }) => {
        if (!watchId) return false;
        stopWatch(watchId);
        const resolved = resolveLocalPath(filePath);
        if (!resolved) return false;
        const dirPath = path.dirname(resolved);
        const targetBase = path.basename(resolved);
        if (!fs.existsSync(dirPath)) return false;

        try {
          const entry: WatchEntry = {
            watcher: fs.watch(dirPath, (_ev, changedName) => {
              if (changedName && changedName !== targetBase) return;
              if (entry.timer) clearTimeout(entry.timer);
              entry.timer = setTimeout(() => {
                entry.timer = null;
                ctx.bus.publish('pane-artifact:changed', { watchId, filePath: resolved });
              }, 160);
            }),
            timer: null,
          };
          entry.watcher.on('error', () => stopWatch(watchId));
          watchers.set(watchId, entry);
          return true;
        } catch {
          return false;
        }
      }
    );

    ctx.rpc.handle<{ watchId: string }, boolean>('pane-artifact:unwatch', async ({ watchId }) => {
      stopWatch(watchId);
      return true;
    });
  },

  deactivate() {
    for (const id of Array.from(watchers.keys())) {
      stopWatch(id);
    }
  },
};

export const paneArtifactHostPackage: BuiltinPluginPackage = {
  manifest: paneArtifactManifest,
  host: paneArtifactHost,
};
