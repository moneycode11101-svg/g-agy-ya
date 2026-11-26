import { app, BrowserWindow, nativeImage, nativeTheme } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import {
  createHostKernel,
  DESK_APP_SCHEME,
  registerKernelProtocolSchemes,
  type HostKernelInstance,
} from './kernel';
import { AGENT_HOST_PLUGINS } from './plugins/agent-group';
import { SHELL_HOST_PLUGINS } from './plugins/shell-group';
import { VISUAL_HOST_PLUGINS } from './plugins/visual-group';

const APP_DISPLAY_NAME = '반중력GUI';
const ICON_PNG_PATH = path.join(__dirname, '../assets/icon.png');
const DIST_DIR = path.join(__dirname, '../dist');

// Preserve existing workspace userData & webview partition regardless of macOS .app bundle name
app.setPath('userData', path.join(app.getPath('appData'), 'agy-desk'));
app.setName(APP_DISPLAY_NAME);

// Must be registered BEFORE app.whenReady() for privileged `desk-app://` and `desk-plugin://` ESM
registerKernelProtocolSchemes();

let mainWindow: BrowserWindow | null = null;
let kernel: HostKernelInstance | null = null;
let isQuitting = false;

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

  kernel?.attachWindow(mainWindow);

  mainWindow.webContents.on('console-message', (_ev, level, message, line, sourceId) => {
    if (level >= 2) {
      console.error(`[renderer:${level}] ${message} (${sourceId}:${line})`);
    }
  });

  mainWindow.webContents.on('did-fail-load', (_ev, code, desc, url) => {
    console.error(`[renderer:fail-load] ${code} ${desc} ${url}`);
  });

  // Prevent accidental file drops on non-droppable surfaces from navigating the app window away
  const devUrl = process.env.VITE_DEV_SERVER_URL;
  mainWindow.webContents.on('will-navigate', (ev, navUrl) => {
    const allowedPrefix = devUrl || `${DESK_APP_SCHEME}://`;
    if (!navUrl.startsWith(allowedPrefix)) {
      ev.preventDefault();
    }
  });

  if (devUrl) {
    void mainWindow.loadURL(devUrl);
  } else {
    // Load production bundle via privileged `desk-app://app/` origin (avoids `file://` opaque origin CORS)
    void mainWindow.loadURL(`${DESK_APP_SCHEME}://app/index.html`);
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.on('before-quit', () => {
  isQuitting = true;
  kernel?.plugins.markQuitting();
  void kernel?.dispose();
});

app.whenReady().then(async () => {
  if (process.platform === 'darwin' && fs.existsSync(ICON_PNG_PATH)) {
    const dockImg = nativeImage.createFromPath(ICON_PNG_PATH);
    if (!dockImg.isEmpty()) {
      app.dock?.setIcon(dockImg);
    }
  }

  kernel = createHostKernel({
    appDisplayName: APP_DISPLAY_NAME,
    appDistDir: DIST_DIR,
    getMainWindow: () => mainWindow,
    createOrShowWindow: () => {
      if (!mainWindow) createWindow();
      else {
        mainWindow.show();
        mainWindow.focus();
      }
    },
    requestQuit: () => {
      isQuitting = true;
      kernel?.plugins.markQuitting();
      app.quit();
    },
  });

  await kernel.boot([...AGENT_HOST_PLUGINS, ...SHELL_HOST_PLUGINS, ...VISUAL_HOST_PLUGINS]);
  createWindow();

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
  if (isQuitting || process.platform !== 'darwin') {
    app.quit();
  }
});
