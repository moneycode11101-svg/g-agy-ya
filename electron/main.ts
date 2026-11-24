import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, Notification, shell, Tray } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgyBridge, getGitDiffSnapshot } from './agyBridge';
import { DeskEventBus } from './eventBus';
import { fetchLiveQuota, getCachedQuotaSnapshot, onQuotaSnapshotChange, startQuotaFileWatcher } from './quotaFetcher';
import { TerminalBridge } from './terminalBridge';
import {
  applySystemEffects,
  clearEmbeddedBrowserData,
  getSystemRuntimeInfo,
  loadAppSettings,
  openOsNotificationSettings,
  saveAppSettings,
  scanCustomizationsInventory,
  setSettingsUpdateListener,
} from './settingsStore';
import { analyzeSingleSession, listRecentSessions, loadTranscriptMessages } from './transcriptMetrics';
import { attachWebviewSecurityGuards } from './webviewGuard';

const APP_DISPLAY_NAME = '반중력GUI';
const ICON_PNG_PATH = path.join(__dirname, '../assets/icon.png');

// Preserve existing workspace localStorage & webview partition regardless of macOS .app bundle name
app.setPath('userData', path.join(app.getPath('appData'), 'agy-desk'));
app.setName(APP_DISPLAY_NAME);

let mainWindow: BrowserWindow | null = null;
let bridge: AgyBridge | null = null;
let termBridge: TerminalBridge | null = null;
let tray: Tray | null = null;
let stopQuotaWatcher: (() => void) | null = null;
let offQuotaSub: (() => void) | null = null;
let offBusForward: (() => void) | null = null;
let offBusAgyDone: (() => void) | null = null;
let isQuitting = false;
const bus = new DeskEventBus();

function buildTrayIcon() {
  // Minimal 16x16 monochrome Antigravity arch glyph (works cleanly in light & dark macOS menu bars)
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><path d="M3.1 11.8 C4.6 9.3 6.0 2.7 8.0 2.7 C10.0 2.7 11.4 9.3 12.9 11.8 C13.2 12.3 12.5 12.6 12.0 12.2 C10.8 10.9 9.5 8.1 8.0 8.1 C6.5 8.1 5.2 10.9 4.0 12.2 C3.5 12.6 2.8 12.3 3.1 11.8 Z" fill="black"/><rect x="3.5" y="13.5" width="9" height="1.4" rx="0.7" fill="black"/></svg>`;
  const img = nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`);
  img.setTemplateImage(true);
  return img;
}

function syncTray(keepInMenuBar: boolean) {
  if (keepInMenuBar) {
    if (!tray) {
      tray = new Tray(buildTrayIcon());
      tray.setToolTip(APP_DISPLAY_NAME);
      tray.setContextMenu(
        Menu.buildFromTemplate([
          {
            label: `${APP_DISPLAY_NAME} 열기`,
            click: () => {
              if (!mainWindow) createWindow();
              else {
                mainWindow.show();
                mainWindow.focus();
              }
            },
          },
          { type: 'separator' },
          {
            label: '종료',
            click: () => {
              isQuitting = true;
              app.quit();
            },
          },
        ])
      );
      tray.on('click', () => {
        if (!mainWindow) createWindow();
        else if (mainWindow.isVisible()) mainWindow.focus();
        else mainWindow.show();
      });
    }
  } else if (tray) {
    tray.destroy();
    tray = null;
  }
}

function createWindow() {
  const isDark = nativeTheme.shouldUseDarkColors;
  app.accessibilitySupportEnabled = true;

  mainWindow = new BrowserWindow({
    title: APP_DISPLAY_NAME,
    width: 1420,
    height: 900,
    minWidth: 820,
    minHeight: 540,
    icon: fs.existsSync(ICON_PNG_PATH) ? ICON_PNG_PATH : undefined,
    backgroundColor: isDark ? '#111317' : '#ffffff',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: process.platform === 'darwin' ? { x: 16, y: 15 } : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true,
    },
  });

  attachWebviewSecurityGuards(mainWindow, (url) => {
    bus.publish('webview:new-tab', url);
  });

  mainWindow.webContents.on('console-message', (_ev, level, message, line, sourceId) => {
    if (level >= 2) {
      console.error(`[renderer:${level}] ${message} (${sourceId}:${line})`);
    }
  });

  mainWindow.webContents.on('did-fail-load', (_ev, code, desc, url) => {
    console.error(`[renderer:fail-load] ${code} ${desc} ${url}`);
  });

  // Event-driven quota refresh when user returns focus to the window (30s cooldown inside fetchLiveQuota)
  mainWindow.on('focus', () => {
    void fetchLiveQuota(false);
  });

  bridge = new AgyBridge((ev) => {
    bus.publish('agy:event', ev);
  });

  termBridge = new TerminalBridge((ev) => {
    bus.publish('terminal:event', ev);
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    void mainWindow.loadURL(devUrl);
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  mainWindow.on('close', (ev) => {
    const settings = loadAppSettings();
    if (!isQuitting && process.platform === 'darwin' && settings.keepInMenuBar) {
      ev.preventDefault();
      mainWindow?.hide();
    }
  });

  mainWindow.on('closed', () => {
    bridge?.dispose();
    bridge = null;
    termBridge?.dispose();
    termBridge = null;
    mainWindow = null;
  });
}

function registerIpc() {
  ipcMain.on('app:home-dir', (ev) => {
    ev.returnValue = os.homedir();
  });

  ipcMain.handle('sessions:list', () => listRecentSessions(40));

  ipcMain.handle('sessions:load', (_ev, conversationId: string) => ({
    messages: loadTranscriptMessages(conversationId),
    metrics: analyzeSingleSession(conversationId),
  }));

  ipcMain.handle('sessions:watch', (_ev, tabSessionId: string, conversationId: string) =>
    bridge ? bridge.watchSession(tabSessionId, conversationId) : null
  );

  ipcMain.handle('sessions:unwatch', (_ev, tabSessionId: string) => {
    bridge?.unwatchSession(tabSessionId);
  });

  ipcMain.handle('agy:send', (_ev, req) => {
    if (!bridge) return { ok: false, error: 'Bridge not ready' };
    return bridge.sendPrompt(req);
  });

  ipcMain.handle('agy:cancel', (_ev, tabSessionId: string) => {
    bridge?.cancelTurn(tabSessionId);
  });

  ipcMain.handle('agy:auth-code', (_ev, tabSessionId: string, code: string) =>
    bridge ? bridge.submitAuthCode(tabSessionId, code) : false
  );

  ipcMain.handle('quota:get', (_ev, force?: boolean) => {
    if (force) return fetchLiveQuota(true);
    const cached = getCachedQuotaSnapshot();
    if (cached.buckets.length > 0) {
      void fetchLiveQuota(false);
      return cached;
    }
    return fetchLiveQuota(false);
  });

  ipcMain.handle('dialog:pick-dir', async () => {
    if (!mainWindow) return null;
    const res = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
    });
    return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0];
  });

  ipcMain.handle('git:diff', (_ev, cwd: string, filePath?: string) => getGitDiffSnapshot(cwd, filePath));

  ipcMain.handle('shell:open-external', (_ev, url: string) => {
    if (/^https?:\/\//i.test(url)) {
      return shell.openExternal(url);
    }
    return undefined;
  });

  ipcMain.handle('shell:show-in-finder', (_ev, targetPath: string) => {
    if (targetPath) shell.showItemInFolder(targetPath);
  });

  ipcMain.handle('terminal:create', (_ev, terminalId: string, cwd: string, cols: number, rows: number) =>
    termBridge ? termBridge.create(terminalId, cwd, cols, rows) : { ok: false, error: 'Terminal bridge not ready' }
  );
  ipcMain.on('terminal:write', (_ev, terminalId: string, data: string) => {
    termBridge?.write(terminalId, data);
  });
  ipcMain.on('terminal:resize', (_ev, terminalId: string, cols: number, rows: number) => {
    termBridge?.resize(terminalId, cols, rows);
  });
  ipcMain.handle('terminal:kill', (_ev, terminalId: string) => {
    termBridge?.kill(terminalId);
  });

  ipcMain.handle('settings:get', () => loadAppSettings());
  ipcMain.handle('settings:save', (_ev, partial) => saveAppSettings(partial));
  ipcMain.handle('settings:runtime-info', () => getSystemRuntimeInfo(app.getVersion()));
  ipcMain.handle('settings:customizations', () => scanCustomizationsInventory());
  ipcMain.handle('browser:clear-history', () => clearEmbeddedBrowserData());
  ipcMain.handle('system:open-notifications', () => openOsNotificationSettings());
}

app.on('before-quit', () => {
  isQuitting = true;
  stopQuotaWatcher?.();
  stopQuotaWatcher = null;
  offQuotaSub?.();
  offQuotaSub = null;
  offBusForward?.();
  offBusForward = null;
  offBusAgyDone?.();
  offBusAgyDone = null;
  termBridge?.dispose();
  bridge?.dispose();
});

app.whenReady().then(() => {
  if (process.platform === 'darwin' && fs.existsSync(ICON_PNG_PATH)) {
    const dockImg = nativeImage.createFromPath(ICON_PNG_PATH);
    if (!dockImg.isEmpty()) {
      app.dock?.setIcon(dockImg);
    }
  }
  setSettingsUpdateListener((s) => syncTray(s.keepInMenuBar));
  const initialSettings = loadAppSettings();
  applySystemEffects(initialSettings);
  syncTray(initialSettings.keepInMenuBar);

  // Fan out all DeskEventBus events to Electron IPC
  offBusForward = bus.subscribeAll((channel, payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(channel, payload);
    }
  });

  // Event-driven side effects on agent turn completion: quota refresh + unfocused OS notification
  offBusAgyDone = bus.subscribe('agy:event', (ev) => {
    if (ev.type !== 'done') return;
    if (!ev.error) {
      void fetchLiveQuota(true);
    }
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isFocused()) {
      const settings = loadAppSettings();
      if (settings.notificationsEnabled && Notification.isSupported()) {
        const n = new Notification({
          title: APP_DISPLAY_NAME,
          body: ev.error ? `작업 오류: ${ev.error.slice(0, 80)}` : '에이전트 응답이 완료되었습니다.',
          silent: true,
        });
        n.on('click', () => {
          mainWindow?.show();
          mainWindow?.focus();
        });
        n.show();
      }
    }
  });

  offQuotaSub = onQuotaSnapshotChange((snap) => {
    bus.publish('quota:updated', snap);
  });

  // Pure event-driven external quota sync via fs.watch (zero polling intervals)
  stopQuotaWatcher = startQuotaFileWatcher();

  registerIpc();
  createWindow();

  // Initial one-shot fetch on startup
  void fetchLiveQuota(true);

  app.on('activate', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    } else {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (!loadAppSettings().keepInMenuBar || process.platform !== 'darwin') {
    bridge?.dispose();
    if (process.platform !== 'darwin') app.quit();
  }
});
