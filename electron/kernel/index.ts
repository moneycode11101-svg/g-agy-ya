import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KernelServiceRegistry } from '../../src/kernel/shared/serviceRegistry';
import {
  KERNEL_API_VERSION,
  type BuiltinPluginPackage,
  type Disposer,
  type IntrospectionCommand,
  type PersistedLayoutWorkspace,
  type PluginErrorRecord,
  type SlotKind,
} from '../../src/kernel/shared/types';
import { KernelConfigStore } from './configStore';
import { KernelEffectScope } from './effectScope';
import { KernelEventBus } from './eventBus';
import { HostPluginManager } from './hostPluginManager';
import { KernelIntrospectionHub } from './introspection';
import { LocalPluginCompiler, registerKernelProtocolSchemes, DESK_APP_SCHEME, DESK_PLUGIN_SCHEME } from './localPluginCompiler';
import { KernelRpcRouter, KERNEL_RPC_INVOKE_CHANNEL, KERNEL_RPC_NOTIFY_CHANNEL } from './rpcRouter';
import { KernelWebviewSecurity } from './webviewSecurity';

export {
  KernelConfigStore,
  KernelEffectScope,
  KernelEventBus,
  KernelIntrospectionHub,
  KernelRpcRouter,
  KernelServiceRegistry,
  KernelWebviewSecurity,
  LocalPluginCompiler,
  HostPluginManager,
  registerKernelProtocolSchemes,
  DESK_APP_SCHEME,
  DESK_PLUGIN_SCHEME,
  KERNEL_RPC_INVOKE_CHANNEL,
  KERNEL_RPC_NOTIFY_CHANNEL,
};

/** Fixed kernel IPC channels shared with preload (zero changes required when plugins are added) */
export const KERNEL_IPC = {
  ENV_SYNC: 'kernel:env:sync',
  RPC_INVOKE: KERNEL_RPC_INVOKE_CHANNEL,
  RPC_NOTIFY: KERNEL_RPC_NOTIFY_CHANNEL,
  BUS_PUBLISH: 'kernel:bus:publish',
  BUS_EVENT: 'kernel:bus:event',
  PLUGINS_BOOTSTRAP: 'kernel:plugins:bootstrap',
  PLUGINS_LIFECYCLE: 'kernel:plugins:lifecycle',
  INTROSPECTION_SNAPSHOT: 'kernel:introspection:snapshot',
  INTROSPECTION_SUBSCRIBE: 'kernel:introspection:subscribe',
  INTROSPECTION_UNSUBSCRIBE: 'kernel:introspection:unsubscribe',
  INTROSPECTION_DELTA: 'kernel:introspection:delta',
  INTROSPECTION_COMMAND: 'kernel:introspection:command',
} as const;

const WORKSPACE_BACKUP_PATH = path.join(os.homedir(), '.gemini', 'antigravity', 'agy-desk-workspace.json');

export interface HostKernelInstance {
  readonly bus: KernelEventBus;
  readonly rpc: KernelRpcRouter;
  readonly config: KernelConfigStore;
  readonly services: KernelServiceRegistry;
  readonly webviewSecurity: KernelWebviewSecurity;
  readonly compiler: LocalPluginCompiler;
  readonly plugins: HostPluginManager;
  readonly introspection: KernelIntrospectionHub;
  attachWindow(win: BrowserWindow): Disposer;
  boot(builtins: readonly BuiltinPluginPackage[]): Promise<void>;
  dispose(): Promise<void>;
}

/**
 * Factory creating the complete Zero-Feature Electron Main Kernel.
 * Ready to be invoked from `electron/main.ts` during Wave 3 cutover.
 */
export function createHostKernel(opts: {
  appDisplayName?: string;
  appDistDir?: string;
  getMainWindow: () => BrowserWindow | null;
  createOrShowWindow?: () => void;
  requestQuit?: () => void;
}): HostKernelInstance {
  const bus = new KernelEventBus();
  const rpc = new KernelRpcRouter();
  const config = new KernelConfigStore();
  const services = new KernelServiceRegistry();
  const webviewSecurity = new KernelWebviewSecurity();
  const compiler = new LocalPluginCompiler();

  const plugins = new HostPluginManager({
    bus,
    rpc,
    config,
    webviewSecurity,
    compiler,
    services,
    appDisplayName: opts.appDisplayName,
    getMainWindow: opts.getMainWindow,
    createOrShowWindow: opts.createOrShowWindow,
    requestQuit: opts.requestQuit,
  });

  const introspection = new KernelIntrospectionHub({
    manager: plugins,
    bus,
    config,
    services,
  });

  const disposers: Disposer[] = [];

  // 1) Attach fixed IPC bridge channels
  disposers.push(rpc.attachToIpc());

  ipcMain.removeAllListeners(KERNEL_IPC.ENV_SYNC);
  ipcMain.on(KERNEL_IPC.ENV_SYNC, (ev) => {
    ev.returnValue = {
      platform: process.platform,
      homeDir: os.homedir(),
      appVersion: app.getVersion(),
      kernelApiVersion: KERNEL_API_VERSION,
      safeMode: plugins.bootMode === 'safe-mode',
    };
  });

  ipcMain.removeAllListeners(KERNEL_IPC.BUS_PUBLISH);
  ipcMain.on(KERNEL_IPC.BUS_PUBLISH, (_ev, topic: string, payload: unknown, sourcePluginId?: string) => {
    if (typeof topic !== 'string' || !topic) return;
    bus.publish(topic, payload, sourcePluginId || 'renderer');
  });

  // Forward all bus envelopes to active main window
  disposers.push(
    bus.subscribe(
      '*',
      (env) => {
        const win = opts.getMainWindow();
        if (win && !win.isDestroyed()) {
          win.webContents.send(KERNEL_IPC.BUS_EVENT, env);
        }
      },
      'renderer-bridge'
    )
  );

  // Forward plugin lifecycle events to main window
  disposers.push(
    plugins.onLifecycleEvent((ev) => {
      const win = opts.getMainWindow();
      if (win && !win.isDestroyed()) {
        win.webContents.send(KERNEL_IPC.PLUGINS_LIFECYCLE, ev);
      }
    })
  );

  ipcMain.removeHandler(KERNEL_IPC.PLUGINS_BOOTSTRAP);
  ipcMain.handle(KERNEL_IPC.PLUGINS_BOOTSTRAP, () => plugins.getBootstrapBundle());

  ipcMain.removeHandler(KERNEL_IPC.INTROSPECTION_SNAPSHOT);
  ipcMain.handle(KERNEL_IPC.INTROSPECTION_SNAPSHOT, () => introspection.getSnapshot());

  ipcMain.removeHandler(KERNEL_IPC.INTROSPECTION_COMMAND);
  ipcMain.handle(KERNEL_IPC.INTROSPECTION_COMMAND, (_ev, cmd: IntrospectionCommand) =>
    introspection.handleCommand(cmd)
  );

  // Reference-counted introspection delta streaming per webContents
  const activeIntroSubscribers = new Map<number, Disposer>();
  ipcMain.removeAllListeners(KERNEL_IPC.INTROSPECTION_SUBSCRIBE);
  ipcMain.on(KERNEL_IPC.INTROSPECTION_SUBSCRIBE, (ev) => {
    const wc = ev.sender;
    if (activeIntroSubscribers.has(wc.id)) return;
    const unsub = introspection.subscribe((delta) => {
      if (!wc.isDestroyed()) {
        wc.send(KERNEL_IPC.INTROSPECTION_DELTA, delta);
      }
    });
    activeIntroSubscribers.set(wc.id, unsub);
    wc.once('destroyed', () => {
      const stop = activeIntroSubscribers.get(wc.id);
      if (stop) {
        activeIntroSubscribers.delete(wc.id);
        void stop();
      }
    });
  });

  ipcMain.removeAllListeners(KERNEL_IPC.INTROSPECTION_UNSUBSCRIBE);
  ipcMain.on(KERNEL_IPC.INTROSPECTION_UNSUBSCRIBE, (ev) => {
    const stop = activeIntroSubscribers.get(ev.sender.id);
    if (stop) {
      activeIntroSubscribers.delete(ev.sender.id);
      void stop();
    }
  });

  // 2) Core kernel RPCs (shared exports sync, client status report, workspace JSON backup, config update)
  disposers.push(
    rpc.onNotify<Record<string, string[]>>('kernel', 'kernel:shared-exports', (exportMap) => {
      compiler.updateSharedExportMap(exportMap);
    }),
    rpc.onNotify<{
      pluginId: string;
      clientActive?: boolean;
      error?: PluginErrorRecord;
      occupiedSlots?: Array<{ slotId: SlotKind; contributionId: string }>;
      activeOpenTabsCount?: number;
      hiddenPreservedTabsCount?: number;
      clientDisposableCount?: number;
    }>('kernel', 'kernel:client:report-status', (payload) => {
      if (payload?.pluginId) {
        plugins.reportClientStatus(payload.pluginId, payload);
      }
    }),
    rpc.handle<{ pluginId: string; patch: Record<string, unknown> }, Record<string, unknown>>(
      'kernel',
      'kernel:config:update',
      async ({ pluginId, patch }) => plugins.updatePluginConfig(pluginId, patch)
    ),
    rpc.handle<void, string | null>('kernel', 'kernel:dialog:pick-dir', async () => {
      const win = opts.getMainWindow();
      const res = win
        ? await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
        : await dialog.showOpenDialog({ properties: ['openDirectory'] });
      return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0];
    }),
    rpc.handle<{ url: string }, boolean>('kernel', 'kernel:shell:open-external', async ({ url }) => {
      if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
        await shell.openExternal(url);
        return true;
      }
      return false;
    }),
    rpc.handle<{ targetPath: string }, boolean>('kernel', 'kernel:shell:show-in-finder', async ({ targetPath }) => {
      if (typeof targetPath === 'string' && targetPath.trim()) {
        shell.showItemInFolder(targetPath);
        return true;
      }
      return false;
    }),
    rpc.handle<{ targetPath: string }, boolean>('kernel', 'kernel:shell:open-path', async ({ targetPath }) => {
      if (typeof targetPath === 'string' && targetPath.trim()) {
        const clean = targetPath.trim().replace(/^~(?=\/|$)/, os.homedir());
        if (path.isAbsolute(clean) && fs.existsSync(clean)) {
          const errMsg = await shell.openPath(clean);
          return !errMsg;
        }
      }
      return false;
    }),
    rpc.handle<void, PersistedLayoutWorkspace | null>('kernel', 'kernel:workspace:load', async () => {
      try {
        if (!fs.existsSync(WORKSPACE_BACKUP_PATH)) return null;
        const parsed = JSON.parse(fs.readFileSync(WORKSPACE_BACKUP_PATH, 'utf8')) as PersistedLayoutWorkspace;
        return parsed && parsed.schemaVersion === 4 ? parsed : null;
      } catch {
        return null;
      }
    }),
    rpc.onNotify<PersistedLayoutWorkspace>('kernel', 'kernel:workspace:save', (workspace) => {
      try {
        if (!workspace || workspace.schemaVersion !== 4) return;
        fs.mkdirSync(path.dirname(WORKSPACE_BACKUP_PATH), { recursive: true });
        const tmp = `${WORKSPACE_BACKUP_PATH}.tmp.${process.pid}`;
        fs.writeFileSync(tmp, JSON.stringify(workspace, null, 2) + '\n', 'utf8');
        fs.renameSync(tmp, WORKSPACE_BACKUP_PATH);
      } catch {
        // non-fatal backup write failure
      }
    })
  );

  return {
    bus,
    rpc,
    config,
    services,
    webviewSecurity,
    compiler,
    plugins,
    introspection,

    attachWindow(win: BrowserWindow): Disposer {
      const d1 = webviewSecurity.attachToWindow(win);
      const d2 = plugins.attachWindowEvents(win);
      return () => {
        void d1();
        void d2();
      };
    },

    async boot(builtins: readonly BuiltinPluginPackage[]): Promise<void> {
      webviewSecurity.installGlobalGuards();
      compiler.attachProtocolHandlers({ appDistDir: opts.appDistDir });
      disposers.push(config.startExternalWatcher());

      for (const pkg of builtins) {
        plugins.registerBuiltin(pkg);
      }
      await plugins.bootAll();
    },

    async dispose(): Promise<void> {
      for (const stop of activeIntroSubscribers.values()) void stop();
      activeIntroSubscribers.clear();
      introspection.dispose();
      await plugins.disposeAll();
      for (const d of disposers.splice(0).reverse()) {
        await d();
      }
      bus.dispose();
    },
  };
}
