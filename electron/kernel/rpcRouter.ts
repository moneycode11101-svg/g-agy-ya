import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import type { Disposer } from '../../src/kernel/shared/types';

export type RpcHandler<TReq = unknown, TRes = unknown> = (
  payload: TReq,
  caller: { webContentsId: number }
) => TRes | Promise<TRes>;

export type RpcNotifyHandler<TReq = unknown> = (payload: TReq, caller: { webContentsId: number }) => void;

interface RegisteredInvoke {
  ownerId: string;
  handler: RpcHandler;
}

interface RegisteredNotify {
  ownerId: string;
  handler: RpcNotifyHandler;
}

export const KERNEL_RPC_INVOKE_CHANNEL = 'kernel:rpc:invoke';
export const KERNEL_RPC_NOTIFY_CHANNEL = 'kernel:rpc:notify';

/**
 * Namespaced RPC Router over a single fixed Electron IPC pair.
 * Solves critic invariant #3: unlike raw `ipcMain.handle()` which throws fatally on
 * duplicate registration during hot-reload, KernelRpcRouter supports safe replacement
 * and deterministic Disposer-scoped unregistration.
 */
export class KernelRpcRouter {
  private invokeHandlers = new Map<string, RegisteredInvoke>();
  private notifyHandlers = new Map<string, RegisteredNotify>();
  private attached = false;

  attachToIpc(): Disposer {
    if (this.attached) return () => {};
    this.attached = true;

    // Remove stale handlers defensively in case of partial re-init
    ipcMain.removeHandler(KERNEL_RPC_INVOKE_CHANNEL);

    ipcMain.handle(
      KERNEL_RPC_INVOKE_CHANNEL,
      async (ev: IpcMainInvokeEvent, method: string, payload: unknown) => {
        if (typeof method !== 'string' || !method) {
          throw new Error('[KernelRpcRouter] Invalid RPC method name');
        }
        const entry = this.invokeHandlers.get(method);
        if (!entry) {
          throw new Error(`[KernelRpcRouter] Unknown RPC method: ${method}`);
        }
        return entry.handler(payload, { webContentsId: ev.sender.id });
      }
    );

    const onNotify = (ev: IpcMainEvent, method: string, payload: unknown) => {
      if (typeof method !== 'string' || !method) return;
      const entry = this.notifyHandlers.get(method);
      if (!entry) return;
      try {
        entry.handler(payload, { webContentsId: ev.sender.id });
      } catch (err) {
        console.error(`[KernelRpcRouter] notify "${method}" failed:`, err);
      }
    };
    ipcMain.on(KERNEL_RPC_NOTIFY_CHANNEL, onNotify);

    return () => {
      ipcMain.removeHandler(KERNEL_RPC_INVOKE_CHANNEL);
      ipcMain.removeListener(KERNEL_RPC_NOTIFY_CHANNEL, onNotify);
      this.attached = false;
    };
  }

  /**
   * Register a request/reply handler. Safe to replace if owned by the same plugin
   * (hot-reload), and rejects accidental hijack by another active plugin.
   */
  handle<TReq = unknown, TRes = unknown>(
    ownerId: string,
    method: string,
    handler: RpcHandler<TReq, TRes>
  ): Disposer {
    const existing = this.invokeHandlers.get(method);
    if (existing && existing.ownerId !== ownerId) {
      throw new Error(
        `[KernelRpcRouter] Method "${method}" is already registered by "${existing.ownerId}" (attempted by "${ownerId}")`
      );
    }
    const record: RegisteredInvoke = { ownerId, handler: handler as RpcHandler };
    this.invokeHandlers.set(method, record);
    return () => {
      if (this.invokeHandlers.get(method) === record) {
        this.invokeHandlers.delete(method);
      }
    };
  }

  onNotify<TReq = unknown>(ownerId: string, method: string, handler: RpcNotifyHandler<TReq>): Disposer {
    const existing = this.notifyHandlers.get(method);
    if (existing && existing.ownerId !== ownerId) {
      throw new Error(
        `[KernelRpcRouter] Notify "${method}" is already registered by "${existing.ownerId}" (attempted by "${ownerId}")`
      );
    }
    const record: RegisteredNotify = { ownerId, handler: handler as RpcNotifyHandler };
    this.notifyHandlers.set(method, record);
    return () => {
      if (this.notifyHandlers.get(method) === record) {
        this.notifyHandlers.delete(method);
      }
    };
  }

  /** Direct in-process invoke (used by Main services or tests) */
  async invokeLocal<TRes = unknown>(method: string, payload?: unknown): Promise<TRes> {
    const entry = this.invokeHandlers.get(method);
    if (!entry) {
      throw new Error(`[KernelRpcRouter] Unknown RPC method: ${method}`);
    }
    return (await entry.handler(payload, { webContentsId: -1 })) as TRes;
  }

  listMethods(): Array<{ method: string; ownerId: string; kind: 'invoke' | 'notify' }> {
    const list: Array<{ method: string; ownerId: string; kind: 'invoke' | 'notify' }> = [];
    for (const [method, entry] of this.invokeHandlers.entries()) {
      list.push({ method, ownerId: entry.ownerId, kind: 'invoke' });
    }
    for (const [method, entry] of this.notifyHandlers.entries()) {
      list.push({ method, ownerId: entry.ownerId, kind: 'notify' });
    }
    return list;
  }
}
