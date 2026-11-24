import { BrowserWindow, Menu, WebContents, app, clipboard, session, shell, type MenuItemConstructorOptions } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { loadAppSettings } from './settingsStore';

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

let downloadHookAttached = false;

/**
 * Orca-style <webview> security hardening + real downloadDir & linkOpenTarget routing.
 */
export function attachWebviewSecurityGuards(
  mainWindow: BrowserWindow,
  onNewTabRequest: (url: string) => void
): void {
  // Wire real will-download path from settings.downloadDir
  if (!downloadHookAttached) {
    downloadHookAttached = true;
    const browserSes = session.fromPartition(`${ALLOWED_PARTITION_PREFIX}browser`);
    browserSes.on('will-download', (_ev, item) => {
      const settings = loadAppSettings();
      if (settings.downloadDir && fs.existsSync(settings.downloadDir)) {
        const safeName = path.basename(item.getFilename() || 'download');
        item.setSavePath(path.join(settings.downloadDir, safeName));
      }
    });
  }

  mainWindow.webContents.on('will-attach-webview', (event, webPreferences, params) => {
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
  });

  app.on('web-contents-created', (_event, contents: WebContents) => {
    if (contents.getType() !== 'webview') return;

    const ua = contents
      .getUserAgent()
      .replace(/\s*Electron\/[^\s]+/g, '')
      .replace(/\s*agy-desk\/[^\s]+/g, '');
    contents.setUserAgent(ua);

    contents.on('will-attach-webview', (e) => e.preventDefault());

    contents.on('will-navigate', (e, url) => {
      if (!isAllowedUrl(url)) {
        e.preventDefault();
      }
    });

    contents.setWindowOpenHandler(({ url }) => {
      if (!isAllowedUrl(url)) return { action: 'deny' };
      const settings = loadAppSettings();
      if (isOAuthUrl(url) || settings.linkOpenTarget === 'external') {
        void shell.openExternal(url);
        return { action: 'deny' };
      }
      onNewTabRequest(url);
      return { action: 'deny' };
    });

    // Real right-click context menu inside embedded <webview> webpages (Orca / Chrome parity)
    contents.on('context-menu', (_ev, params) => {
      const items: MenuItemConstructorOptions[] = [];

      if (params.linkURL && isAllowedUrl(params.linkURL)) {
        items.push(
          {
            label: '새 웹뷰 탭에서 링크 열기',
            click: () => onNewTabRequest(params.linkURL),
          },
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
          {
            label: '복사',
            accelerator: 'CmdOrCtrl+C',
            click: () => contents.copy(),
          },
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
        {
          label: '새로고침',
          click: () => contents.reload(),
        },
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
          click: () => {
            contents.inspectElement(params.x, params.y);
          },
        }
      );

      const menu = Menu.buildFromTemplate(items);
      menu.popup({ window: mainWindow });
    });
  });
}
