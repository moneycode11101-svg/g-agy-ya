import { contextBridge, ipcRenderer } from 'electron';
import type { AccountQuotaSnapshot, AgyDeskApi, AgyEvent, TerminalEvent } from '../src/shared/types';

const homeDir: string = ipcRenderer.sendSync('app:home-dir') || '';

const api: AgyDeskApi = {
  platform: process.platform,
  homeDir,
  listSessions: () => ipcRenderer.invoke('sessions:list'),
  loadSession: (conversationId) => ipcRenderer.invoke('sessions:load', conversationId),
  watchSession: (tabSessionId, conversationId) =>
    ipcRenderer.invoke('sessions:watch', tabSessionId, conversationId),
  unwatchSession: (tabSessionId) => ipcRenderer.invoke('sessions:unwatch', tabSessionId),
  sendPrompt: (req) => ipcRenderer.invoke('agy:send', req),
  cancelTurn: (tabSessionId) => ipcRenderer.invoke('agy:cancel', tabSessionId),
  submitAuthCode: (tabSessionId, code) => ipcRenderer.invoke('agy:auth-code', tabSessionId, code),
  onAgyEvent: (cb) => {
    const handler = (_ev: Electron.IpcRendererEvent, payload: AgyEvent) => cb(payload);
    ipcRenderer.on('agy:event', handler);
    return () => ipcRenderer.removeListener('agy:event', handler);
  },
  onWebviewNewTab: (cb) => {
    const handler = (_ev: Electron.IpcRendererEvent, url: string) => cb(url);
    ipcRenderer.on('webview:new-tab', handler);
    return () => ipcRenderer.removeListener('webview:new-tab', handler);
  },
  getQuota: (force) => ipcRenderer.invoke('quota:get', Boolean(force)),
  onQuotaUpdated: (cb) => {
    const handler = (_ev: Electron.IpcRendererEvent, snap: AccountQuotaSnapshot) => cb(snap);
    ipcRenderer.on('quota:updated', handler);
    return () => ipcRenderer.removeListener('quota:updated', handler);
  },
  pickDirectory: () => ipcRenderer.invoke('dialog:pick-dir'),
  getGitDiff: (cwd, filePath) => ipcRenderer.invoke('git:diff', cwd, filePath),
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),
  showInFinder: (targetPath) => ipcRenderer.invoke('shell:show-in-finder', targetPath),
  createTerminal: (terminalId, cwd, cols, rows) =>
    ipcRenderer.invoke('terminal:create', terminalId, cwd, cols, rows),
  writeTerminal: (terminalId, data) => ipcRenderer.send('terminal:write', terminalId, data),
  resizeTerminal: (terminalId, cols, rows) => ipcRenderer.send('terminal:resize', terminalId, cols, rows),
  killTerminal: (terminalId) => ipcRenderer.invoke('terminal:kill', terminalId),
  onTerminalEvent: (cb) => {
    const handler = (_ev: Electron.IpcRendererEvent, payload: TerminalEvent) => cb(payload);
    ipcRenderer.on('terminal:event', handler);
    return () => ipcRenderer.removeListener('terminal:event', handler);
  },
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (partial) => ipcRenderer.invoke('settings:save', partial),
  getRuntimeInfo: () => ipcRenderer.invoke('settings:runtime-info'),
  getCustomizationsInventory: () => ipcRenderer.invoke('settings:customizations'),
  clearBrowserHistory: () => ipcRenderer.invoke('browser:clear-history'),
  openNotificationSettings: () => ipcRenderer.invoke('system:open-notifications'),
};

contextBridge.exposeInMainWorld('agyDesk', api);
