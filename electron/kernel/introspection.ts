import { app, shell } from 'electron';
import {
  KERNEL_API_VERSION,
  type Disposer,
  type IntrospectionCommand,
  type IntrospectionDelta,
  type KernelIntrospectionSnapshot,
  type RuntimeAssetsProjection,
  type SlotKind,
  type SlotOccupancyEntry,
  type SlotSurface,
} from '../../src/kernel/shared/types';
import { KernelServiceRegistry } from '../../src/kernel/shared/serviceRegistry';
import { KernelConfigStore } from './configStore';
import { KernelEventBus } from './eventBus';
import { HostPluginManager } from './hostPluginManager';

const CANONICAL_SLOTS: Array<{ slotId: SlotKind; label: string; surface: SlotSurface; cardinality: 'single' | 'multi' }> = [
  { slotId: 'titlebar.actions', label: '타이틀바 액션', surface: 'titlebar', cardinality: 'multi' },
  { slotId: 'sidebar.section', label: '사이드바 섹션', surface: 'sidebar', cardinality: 'multi' },
  { slotId: 'pane.type', label: '분할 패인 타입', surface: 'pane-body', cardinality: 'multi' },
  { slotId: 'pane.header.action', label: '패인 탭바 확장', surface: 'pane-tabbar', cardinality: 'multi' },
  { slotId: 'pane.widget', label: '패인 내부 위젯', surface: 'chat', cardinality: 'multi' },
  { slotId: 'context-menu.item', label: '컨텍스트 메뉴', surface: 'overlay', cardinality: 'multi' },
  { slotId: 'settings.section', label: '설정 섹션', surface: 'settings', cardinality: 'multi' },
  { slotId: 'overlay.layer', label: '전역 오버레이', surface: 'overlay', cardinality: 'multi' },
];

export interface IntrospectionHubDeps {
  readonly manager: HostPluginManager;
  readonly bus: KernelEventBus;
  readonly config: KernelConfigStore;
  readonly services: KernelServiceRegistry;
}

/**
 * Single Source of Truth Live Projection Hub (Main process).
 * - Structural changes (plugin toggle, config update, errors, runtime asset rescans) push immediately.
 * - High-frequency bus telemetry coalesces at 10Hz ONLY when >= 1 subscriber is attached (0% CPU when idle).
 */
export class KernelIntrospectionHub {
  private readonly deps: IntrospectionHubDeps;
  private readonly startedAt = Date.now();
  private seq = 0;
  private subscribers = new Set<(delta: IntrospectionDelta) => void>();
  private telemetryUnsub: Disposer | null = null;
  private runtimeAssetsCache = new Map<string, RuntimeAssetsProjection>();
  private internalDisposers: Disposer[] = [];

  constructor(deps: IntrospectionHubDeps) {
    this.deps = deps;

    this.internalDisposers.push(
      deps.manager.onPluginStateChange((pluginId) => {
        if (this.subscribers.size === 0) return;
        const snap = deps.manager.getNodeSnapshot(pluginId);
        if (snap) {
          this.broadcast({
            type: 'plugin',
            seq: ++this.seq,
            plugin: snap,
            serviceBindings: deps.services.getBindingsSnapshot(),
          });
        } else {
          this.broadcast({
            type: 'plugin-removed',
            seq: ++this.seq,
            pluginId,
          });
        }
      }),
      deps.manager.onRuntimeAssetsUpdated((adapterPluginId, projection) => {
        this.runtimeAssetsCache.set(adapterPluginId, projection);
        if (this.subscribers.size === 0) return;
        this.broadcast({
          type: 'runtime-assets',
          seq: ++this.seq,
          adapterPluginId,
          projection,
        });
      }),
      deps.config.onDocumentChange(() => {
        if (this.subscribers.size === 0) return;
        this.broadcast({
          type: 'profile',
          seq: ++this.seq,
          profile: this.buildProfileSummary(),
        });
      })
    );
  }

  async getSnapshot(): Promise<KernelIntrospectionSnapshot> {
    // Ensure registered runtime asset providers have at least one initial scan cached
    for (const provider of this.deps.manager.getRuntimeAssetProviders()) {
      if (!this.runtimeAssetsCache.has(provider.adapterPluginId)) {
        try {
          const proj = await provider.scanAssets();
          this.runtimeAssetsCache.set(provider.adapterPluginId, proj);
        } catch (err) {
          console.warn(`[IntrospectionHub] Initial asset scan failed for ${provider.adapterPluginId}:`, err);
        }
      }
    }

    const plugins = this.deps.manager.getAllNodeSnapshots();
    const slots = this.buildEmptySlotMap();
    let occupiedCount = 0;

    for (const node of Object.values(plugins)) {
      for (const occ of node.occupiedSlots) {
        const entry = slots[occ.slotId];
        if (!entry) continue;
        entry.mounts.push({
          mountId: `${node.id}:${occ.slotId}:${occ.contributionId}`,
          pluginId: node.id,
          slotId: occ.slotId,
          contributionId: occ.contributionId,
          order: 100,
          visibility: node.lifecycleState === 'active' ? 'visible' : 'dormant-disabled',
          mountKey: 1,
          hasRenderError: node.health.lastError?.phase === 'render',
        });
      }
    }
    for (const entry of Object.values(slots)) {
      if (entry.mounts.length > 0) occupiedCount += 1;
    }

    const telemetry = this.deps.bus.getTelemetrySnapshot();
    const runtimeAssetsByAdapter: Record<string, RuntimeAssetsProjection> = {};
    for (const [k, v] of this.runtimeAssetsCache.entries()) {
      runtimeAssetsByAdapter[k] = v;
    }

    return {
      seq: ++this.seq,
      timestamp: Date.now(),
      bootMode: this.deps.manager.bootMode,
      safeModeContext: this.deps.manager.safeModeContext,
      profile: this.buildProfileSummary(),
      kernel: {
        appVersion: app.getVersion(),
        kernelApiVersion: KERNEL_API_VERSION,
        uptimeMs: Date.now() - this.startedAt,
        totalSlotsCount: CANONICAL_SLOTS.length,
        occupiedSlotsCount: occupiedCount,
        busEventsPerSec: telemetry.busEventsPerSec,
        busSparkline: telemetry.busSparkline,
        memoryRssMb: Math.round(process.memoryUsage().rss / (1024 * 1024)),
      },
      plugins,
      serviceBindings: this.deps.services.getBindingsSnapshot(),
      slots,
      runtimeAssetsByAdapter,
      eventEdges: telemetry.eventEdges,
      recentPulses: telemetry.recentPulses,
    };
  }

  subscribe(listener: (delta: IntrospectionDelta) => void): Disposer {
    this.subscribers.add(listener);
    if (this.subscribers.size === 1 && !this.telemetryUnsub) {
      // Activate 10Hz telemetry coalescer ONLY while at least one observer exists
      this.telemetryUnsub = this.deps.bus.subscribeTelemetry((batch) => {
        this.broadcast({
          type: 'telemetry',
          seq: ++this.seq,
          timestamp: batch.timestamp,
          kernel: {
            uptimeMs: Date.now() - this.startedAt,
            busEventsPerSec: batch.busEventsPerSec,
            busSparkline: batch.busSparkline,
            memoryRssMb: Math.round(process.memoryUsage().rss / (1024 * 1024)),
          },
          eventEdges: batch.eventEdges,
          pulses: batch.pulses,
        });
      });
    }

    return () => {
      this.subscribers.delete(listener);
      if (this.subscribers.size === 0 && this.telemetryUnsub) {
        void this.telemetryUnsub();
        this.telemetryUnsub = null;
      }
    };
  }

  async handleCommand(cmd: IntrospectionCommand): Promise<{ ok: boolean; error?: string; data?: unknown }> {
    switch (cmd.type) {
      case 'plugin:toggle':
        return this.deps.manager.togglePlugin(cmd.pluginId, cmd.enabled);
      case 'plugin:reload':
        return this.deps.manager.reloadPlugin(cmd.pluginId, 'both');
      case 'plugin:rollback':
        return this.deps.manager.rollbackPlugin(cmd.pluginId);
      case 'plugin:update-config': {
        const next = await this.deps.manager.updatePluginConfig(cmd.pluginId, cmd.patch);
        return { ok: true, data: next };
      }
      case 'plugin:mount-local-dialog': {
        const res = await this.deps.manager.mountLocalPluginViaDialog(cmd.watch ?? true);
        return { ok: res.ok, error: res.error, data: { pluginId: res.pluginId } };
      }
      case 'plugin:mount-local': {
        const res = await this.deps.manager.mountLocalPlugin(cmd.dirPath, cmd.watch ?? true, false);
        return { ok: res.ok, error: res.error, data: { pluginId: res.pluginId } };
      }
      case 'plugin:unmount-local':
        return this.deps.manager.unmountLocalPlugin(cmd.pluginId);
      case 'plugin:reveal-source': {
        const ok = this.deps.manager.revealPluginSource(cmd.pluginId);
        return ok ? { ok: true } : { ok: false, error: 'Built-in plugin has no external source folder' };
      }
      case 'plugin:open-config-file': {
        shell.showItemInFolder(this.deps.config.configFilePath);
        return { ok: true };
      }
      case 'runtime-asset:rescan': {
        const targets = cmd.adapterPluginId
          ? [this.deps.manager.getRuntimeAssetProvider(cmd.adapterPluginId)].filter(Boolean)
          : this.deps.manager.getRuntimeAssetProviders();
        for (const provider of targets) {
          if (!provider) continue;
          const proj = await provider.scanAssets();
          this.runtimeAssetsCache.set(provider.adapterPluginId, proj);
          this.broadcast({
            type: 'runtime-assets',
            seq: ++this.seq,
            adapterPluginId: provider.adapterPluginId,
            projection: proj,
          });
        }
        return { ok: true };
      }
      case 'runtime-asset:toggle': {
        const provider = this.deps.manager.getRuntimeAssetProvider(cmd.adapterPluginId);
        if (!provider?.toggleAsset) {
          return { ok: false, error: `Adapter "${cmd.adapterPluginId}" does not support toggling assets` };
        }
        const res = await provider.toggleAsset({
          assetId: cmd.assetId,
          enabled: cmd.enabled,
          scope: cmd.scope,
        });
        if (res.ok) {
          const proj = await provider.scanAssets();
          this.runtimeAssetsCache.set(provider.adapterPluginId, proj);
          this.broadcast({
            type: 'runtime-assets',
            seq: ++this.seq,
            adapterPluginId: provider.adapterPluginId,
            projection: proj,
          });
        }
        return { ok: res.ok, error: res.error, data: res };
      }
      case 'runtime-asset:apply-preset': {
        const provider = this.deps.manager.getRuntimeAssetProvider(cmd.adapterPluginId);
        if (!provider?.applyPreset) {
          return { ok: false, error: `Adapter "${cmd.adapterPluginId}" does not support presets` };
        }
        const res = await provider.applyPreset(cmd.presetId);
        if (res.ok) {
          const proj = await provider.scanAssets();
          this.runtimeAssetsCache.set(provider.adapterPluginId, proj);
          this.broadcast({
            type: 'runtime-assets',
            seq: ++this.seq,
            adapterPluginId: provider.adapterPluginId,
            projection: proj,
          });
        }
        return res;
      }
      case 'system:set-safe-mode': {
        await this.deps.config.setSafeModeFlag(cmd.enabled);
        return { ok: true };
      }
      default:
        return { ok: false, error: 'Unsupported introspection command' };
    }
  }

  dispose(): void {
    void this.telemetryUnsub?.();
    this.telemetryUnsub = null;
    for (const d of this.internalDisposers) void d();
    this.internalDisposers = [];
    this.subscribers.clear();
  }

  private buildProfileSummary(): KernelIntrospectionSnapshot['profile'] {
    const doc = this.deps.config.getDocument();
    return {
      configFilePath: this.deps.config.configFilePath,
      synced: true,
      overrideCount: Object.keys(doc.plugins).length,
      mountCount: doc.mounts.length,
      lastSavedAt: this.deps.config.getLastSavedAt(),
    };
  }

  private buildEmptySlotMap(): Record<SlotKind, SlotOccupancyEntry> {
    const map = {} as Record<SlotKind, SlotOccupancyEntry>;
    for (const s of CANONICAL_SLOTS) {
      map[s.slotId] = {
        slotId: s.slotId,
        label: s.label,
        surface: s.surface,
        cardinality: s.cardinality,
        mounts: [],
      };
    }
    return map;
  }

  private broadcast(delta: IntrospectionDelta): void {
    for (const listener of this.subscribers) {
      try {
        listener(delta);
      } catch {
        // isolate subscriber errors
      }
    }
  }
}
