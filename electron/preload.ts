import { contextBridge, ipcRenderer } from 'electron';
import type {
  DeskKernelBridge,
  EventEnvelope,
  IntrospectionCommand,
  IntrospectionDelta,
  KernelPluginLifecycleEvent,
} from '../src/kernel/shared/types';

// Fixed 5-Primitive Preload Bridge — NEVER needs modification when adding/removing plugins.
const IPC = {
  ENV_SYNC: 'kernel:env:sync',
  RPC_INVOKE: 'kernel:rpc:invoke',
  RPC_NOTIFY: 'kernel:rpc:notify',
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

function matchesTopicPattern(pattern: string, topic: string): boolean {
  if (pattern === '*' || pattern === topic) return true;
  if (pattern.endsWith('*')) {
    return topic.startsWith(pattern.slice(0, -1));
  }
  return false;
}

const envInfo = (ipcRenderer.sendSync(IPC.ENV_SYNC) as DeskKernelBridge['env'] | undefined) || {
  platform: process.platform,
  homeDir: '',
  appVersion: '0.1.0',
  kernelApiVersion: '1.0.0',
  safeMode: false,
};

let introspectionSubCount = 0;

const deskKernel: DeskKernelBridge = {
  env: Object.freeze(envInfo),

  rpc: {
    invoke: <TRes = unknown>(method: string, payload?: unknown) =>
      ipcRenderer.invoke(IPC.RPC_INVOKE, method, payload) as Promise<TRes>,
    notify: (method: string, payload?: unknown) => {
      ipcRenderer.send(IPC.RPC_NOTIFY, method, payload);
    },
  },

  bus: {
    publish: (topic: string, payload?: unknown, sourcePluginId?: string) => {
      ipcRenderer.send(IPC.BUS_PUBLISH, topic, payload, sourcePluginId);
    },
    subscribe: (pattern: string, handler: (env: EventEnvelope) => void) => {
      const wrapped = (_ev: Electron.IpcRendererEvent, env: EventEnvelope) => {
        if (env && matchesTopicPattern(pattern, env.topic)) {
          handler(env);
        }
      };
      ipcRenderer.on(IPC.BUS_EVENT, wrapped);
      return () => {
        ipcRenderer.removeListener(IPC.BUS_EVENT, wrapped);
      };
    },
  },

  plugins: {
    getBootstrap: () => ipcRenderer.invoke(IPC.PLUGINS_BOOTSTRAP),
    onLifecycleEvent: (handler: (ev: KernelPluginLifecycleEvent) => void) => {
      const wrapped = (_ev: Electron.IpcRendererEvent, ev: KernelPluginLifecycleEvent) => handler(ev);
      ipcRenderer.on(IPC.PLUGINS_LIFECYCLE, wrapped);
      return () => {
        ipcRenderer.removeListener(IPC.PLUGINS_LIFECYCLE, wrapped);
      };
    },
  },

  introspection: {
    getSnapshot: () => ipcRenderer.invoke(IPC.INTROSPECTION_SNAPSHOT),
    subscribe: (handler: (delta: IntrospectionDelta) => void) => {
      const wrapped = (_ev: Electron.IpcRendererEvent, delta: IntrospectionDelta) => handler(delta);
      ipcRenderer.on(IPC.INTROSPECTION_DELTA, wrapped);
      introspectionSubCount += 1;
      if (introspectionSubCount === 1) {
        ipcRenderer.send(IPC.INTROSPECTION_SUBSCRIBE);
      }
      let unsubscribed = false;
      return () => {
        if (unsubscribed) return;
        unsubscribed = true;
        ipcRenderer.removeListener(IPC.INTROSPECTION_DELTA, wrapped);
        introspectionSubCount = Math.max(0, introspectionSubCount - 1);
        if (introspectionSubCount === 0) {
          ipcRenderer.send(IPC.INTROSPECTION_UNSUBSCRIBE);
        }
      };
    },
    sendCommand: (cmd: IntrospectionCommand) => ipcRenderer.invoke(IPC.INTROSPECTION_COMMAND, cmd),
  },
};

contextBridge.exposeInMainWorld('deskKernel', deskKernel);
