import {
  app,
  BrowserWindow,
  clipboard,
  Menu,
  session,
  shell,
  type MenuItemConstructorOptions,
  type WebContents,
} from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { Disposer, HostWebviewHooks } from '../../src/kernel/shared/types';

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'about:']);
const ALLOWED_PARTITION_PREFIX = 'persist:agy-desk-';

function isAllowedUrl(rawUrl: string): boolean {
  if (!rawUrl || rawUrl === 'about:blank') return true;
  try {
    const parsed = new URL(rawUrl);
    return ALLOWED_PROTOCOLS.has(parsed.protocol);
  } catch {
    return false;
  }
}

function isOAuthUrl(rawUrl: string): boolean {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === 'accounts.google.com' ||
      host.endsWith('.accounts.google.com') ||
      host === 'appleid.apple.com'
    );
  } catch {
    return false;
  }
}

interface RegisteredHookEntry {
  id: string;
  pluginId: string;
  hooks: HostWebviewHooks;
}

/**
 * Kernel-Invariant Webview Security Baseline (critic #12-7).
 *
 * Security invariants ALWAYS remain enforced even when `pane-webview` is disabled:
 *  1. `app.on('web-contents-created')` and `session.on('will-download')` attach ONCE per app lifetime
 *     (eliminating listener accumulation leaks across macOS window reopen & hot-reload).
 *  2. Default-deny `will-attach-webview`: rejects non-http(s)/about URLs, ALWAYS deletes preload,
 *     forces `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, `webviewTag: false`,
 *     `plugins: false`, and jails partitions to `persist:agy-desk-*`.
 *  3. If `pane-webview` is disabled (no registered hooks), external `<webview>` attachments are blocked
 *     AND links safely fall back to `shell.openExternal`.
 */
export class KernelWebviewSecurity {
  private appListenersAttached = false;
  private hooksStack: RegisteredHookEntry[] = [];
  private seq = 0;
  private activeMainWindow: BrowserWindow | null = null;
  private windowDisposers = new WeakMap<BrowserWindow, Disposer>();

  private getActiveHooks(): HostWebviewHooks | null {
    return this.hooksStack.length > 0 ? this.hooksStack[this.hooksStack.length - 1].hooks : null;
  }

  /** Called once during app bootstrap to install app-wide singleton security guards */
  installGlobalGuards(): void {
    if (this.appListenersAttached) return;
    this.appListenersAttached = true;

    const browserSes = session.fromPartition(`${ALLOWED_PARTITION_PREFIX}browser`);
    browserSes.on('will-download', (_ev, item) => {
      const hooks = this.getActiveHooks();
      const downloadDir = hooks?.getDownloadDir?.();
      if (downloadDir && fs.existsSync(downloadDir)) {
        const safeName = path.basename(item.getFilename() || 'download');
        item.setSavePath(path.join(downloadDir, safeName));
      }
    });

    app.on('web-contents-created', (_event, contents: WebContents) => {
      if (contents.getType() !== 'webview') return;

      const ua = contents
        .getUserAgent()
        .replace(/\s*Electron\/[^\s]+/g, '')
        .replace(/\s*agy-desk\/[^\s]+/g, '');
      contents.setUserAgent(ua);

      // Never allow nested <webview> inside a <webview>
      contents.on('will-attach-webview', (e) => e.preventDefault());

      contents.on('will-navigate', (e, url) => {
        if (!isAllowedUrl(url)) {
          e.preventDefault();
        }
      });

      contents.setWindowOpenHandler(({ url }) => {
        if (!isAllowedUrl(url)) return { action: 'deny' };
        const hooks = this.getActiveHooks();
        const linkTarget = hooks?.getLinkOpenTarget?.() ?? 'external';
        if (isOAuthUrl(url) || linkTarget === 'external' || !hooks?.onNewTabRequest) {
          void shell.openExternal(url);
          return { action: 'deny' };
        }
        hooks.onNewTabRequest(url);
        return { action: 'deny' };
      });

      contents.on('context-menu', (_ev, params) => {
        const win = this.activeMainWindow;
        if (!win || win.isDestroyed()) return;
        const hooks = this.getActiveHooks();
        const items: MenuItemConstructorOptions[] = [];

        if (params.linkURL && isAllowedUrl(params.linkURL)) {
          if (hooks?.onNewTabRequest) {
            items.push({
              label: '새 웹뷰 탭에서 링크 열기',
              click: () => hooks.onNewTabRequest?.(params.linkURL),
            });
          }
          items.push(
            {
              label: '기본 브라우저에서 링크 열기',
              click: () => void shell.openExternal(params.linkURL),
            },
            {
              label: '링크 주소 복사',
              click: () => clipboard.writeText(params.linkURL),
            },
            { type: 'separator' }
          );
        }

        if (params.selectionText) {
          items.push(
            { label: '복사', accelerator: 'CmdOrCtrl+C', click: () => contents.copy() },
            { type: 'separator' }
          );
        }

        if (params.isEditable) {
          items.push(
            { label: '잘라내기', click: () => contents.cut(), enabled: params.editFlags.canCut },
            { label: '복사', click: () => contents.copy(), enabled: params.editFlags.canCopy },
            { label: '붙여넣기', click: () => contents.paste(), enabled: params.editFlags.canPaste },
            { label: '모두 선택', click: () => contents.selectAll() },
            { type: 'separator' }
          );
        }

        items.push(
          {
            label: '뒤로',
            enabled: contents.navigationHistory.canGoBack(),
            click: () => contents.navigationHistory.goBack(),
          },
          {
            label: '앞으로',
            enabled: contents.navigationHistory.canGoForward(),
            click: () => contents.navigationHistory.goForward(),
          },
          { label: '새로고침', click: () => contents.reload() },
          { type: 'separator' },
          {
            label: '현재 페이지 주소 복사',
            click: () => clipboard.writeText(contents.getURL()),
          },
          {
            label: '기본 브라우저에서 열기',
            click: () => {
              const url = contents.getURL();
              if (isAllowedUrl(url)) void shell.openExternal(url);
            },
          },
          { type: 'separator' },
          {
            label: '요소 검사 (DevTools)',
            click: () => contents.inspectElement(params.x, params.y),
          }
        );

        const menu = Menu.buildFromTemplate(items);
        menu.popup({ window: win });
      });
    });
  }

  /** Attach per-BrowserWindow `will-attach-webview` hard guard (with clean disposal on window close) */
  attachToWindow(mainWindow: BrowserWindow): Disposer {
    this.installGlobalGuards();
    this.activeMainWindow = mainWindow;

    const prev = this.windowDisposers.get(mainWindow);
    if (prev) void prev();

    const onWillAttach = (
      event: Electron.Event,
      webPreferences: Electron.WebPreferences,
      params: Record<string, string>
    ) => {
      // Default-deny when no plugin explicitly activates webview capability
      if (this.hooksStack.length === 0) {
        event.preventDefault();
        return;
      }
      const src = typeof params.src === 'string' ? params.src : 'about:blank';
      if (!isAllowedUrl(src)) {
        event.preventDefault();
        return;
      }

      delete webPreferences.preload;
      webPreferences.nodeIntegration = false;
      webPreferences.nodeIntegrationInSubFrames = false;
      webPreferences.nodeIntegrationInWorker = false;
      webPreferences.contextIsolation = true;
      webPreferences.sandbox = true;
      webPreferences.webSecurity = true;
      webPreferences.allowRunningInsecureContent = false;
      webPreferences.webviewTag = false;
      webPreferences.plugins = false;

      const partition = typeof params.partition === 'string' ? params.partition : '';
      if (!partition.startsWith(ALLOWED_PARTITION_PREFIX)) {
        webPreferences.partition = `${ALLOWED_PARTITION_PREFIX}browser`;
      }
    };

    mainWindow.webContents.on('will-attach-webview', onWillAttach);

    const dispose: Disposer = () => {
      if (!mainWindow.isDestroyed()) {
        mainWindow.webContents.removeListener('will-attach-webview', onWillAttach);
      }
      if (this.activeMainWindow === mainWindow) {
        this.activeMainWindow = null;
      }
      this.windowDisposers.delete(mainWindow);
    };

    mainWindow.once('closed', () => {
      void dispose();
    });

    this.windowDisposers.set(mainWindow, dispose);
    return dispose;
  }

  /** Disposable plugin hook registration (e.g., called by `pane-webview` plugin inside its EffectScope) */
  registerPluginHooks(pluginId: string, hooks: HostWebviewHooks): Disposer {
    const entry: RegisteredHookEntry = {
      id: `wv-hook-${++this.seq}`,
      pluginId,
      hooks,
    };
    this.hooksStack.push(entry);
    return () => {
      const idx = this.hooksStack.findIndex((h) => h.id === entry.id);
      if (idx !== -1) this.hooksStack.splice(idx, 1);
    };
  }
}
