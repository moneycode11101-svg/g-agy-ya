import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  BUILTIN_PLUGIN_IDS,
  type ConfigFieldSchema,
  type Disposer,
  type LocalPluginMount,
  type PluginPatchEntry,
  type PluginsConfigDocument,
  type SlotKind,
  type SlotLayoutOverride,
} from '../../src/kernel/shared/types';

const HOME = os.homedir();
const DEFAULT_CONFIG_DIR = path.join(HOME, '.gemini', 'antigravity');
const DEFAULT_PLUGINS_CONFIG_PATH = path.join(DEFAULT_CONFIG_DIR, 'agy-desk-plugins.json');
const LEGACY_SETTINGS_PATH = path.join(DEFAULT_CONFIG_DIR, 'agy-desk-settings.json');

function createEmptyDocument(): PluginsConfigDocument {
  return {
    schemaVersion: 1,
    migratedFromLegacySettings: false,
    safeMode: false,
    mounts: [],
    plugins: {},
    slots: {},
  };
}

/**
 * Lossless 1-time migration from legacy flat `~/.gemini/antigravity/agy-desk-settings.json`
 * into namespaced plugin configs keyed by the 14 canonical plugin IDs.
 * Never deletes or mutates the legacy file so rollback to baseline remains 100% safe.
 */
function migrateLegacySettings(legacyPath: string): Partial<PluginsConfigDocument> | null {
  try {
    if (!fs.existsSync(legacyPath)) return null;
    const raw = fs.readFileSync(legacyPath, 'utf8');
    const s = JSON.parse(raw) as Record<string, unknown>;
    if (!s || typeof s !== 'object') return null;

    const plugins: Record<string, PluginPatchEntry> = {};

    const put = (pluginId: string, config: Record<string, unknown>, enabled?: boolean) => {
      const cleaned: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(config)) {
        if (v !== undefined) cleaned[k] = v;
      }
      if (Object.keys(cleaned).length === 0 && enabled === undefined) return;
      plugins[pluginId] = {
        ...(enabled !== undefined ? { enabled } : {}),
        ...(Object.keys(cleaned).length > 0 ? { config: cleaned } : {}),
      };
    };

    put(BUILTIN_PLUGIN_IDS.AGENT_AGY, {
      defaultModel: s.defaultModel,
      defaultEffort: s.defaultEffort,
      defaultMode: s.defaultMode,
      localPermission: s.localPermission,
      allowedCommands: s.allowedCommands,
    });

    put(BUILTIN_PLUGIN_IDS.PANE_CHAT, {
      sendKey: s.sendKey,
      pendingMessageMode: s.pendingMessageMode,
      confirmCloseRunning: s.confirmCloseRunning,
      defaultCwd: s.defaultCwd,
      warnOnCacheReset: s.warnOnCacheReset,
      transcriptView: s.transcriptView,
      chatWidth: s.chatWidth,
    });

    put(
      BUILTIN_PLUGIN_IDS.HUD_TOKEN_BAR,
      { newRoomWarnPct: s.newRoomWarnPct },
      s.showTokenBar === false ? false : undefined
    );

    put(BUILTIN_PLUGIN_IDS.PANE_WEBVIEW, {
      linkOpenTarget: s.linkOpenTarget,
      defaultWebviewUrl: s.defaultWebviewUrl,
      downloadDir: s.downloadDir,
    });

    put(BUILTIN_PLUGIN_IDS.PANE_GIT_DIFF, {
      gitDiffBase: s.gitDiffBase,
    });

    put(BUILTIN_PLUGIN_IDS.THEME_APPEARANCE, {
      theme: s.theme,
      contrast: s.contrast,
      fontFamily: s.fontFamily,
      fontSizePx: s.fontSizePx,
      lightPreset: s.lightPreset,
      lightBg: s.lightBg,
      lightFg: s.lightFg,
      lightAccent: s.lightAccent,
      darkBg: s.darkBg,
      darkFg: s.darkFg,
      darkAccent: s.darkAccent,
    });

    put(BUILTIN_PLUGIN_IDS.NOTIFY_FEEDBACK, {
      notificationsEnabled: s.notificationsEnabled,
      soundEnabled: s.soundEnabled,
      soundVolume: s.soundVolume,
    });

    put(BUILTIN_PLUGIN_IDS.MACOS_SYSTEM_SHELL, {
      preventSleep: s.preventSleep,
      keepInMenuBar: s.keepInMenuBar,
    });

    put(BUILTIN_PLUGIN_IDS.SIDEBAR_WORKSPACE, {
      projectFolders: s.projectFolders,
    });

    return {
      migratedFromLegacySettings: true,
      plugins,
    };
  } catch (err) {
    console.warn('[KernelConfigStore] Legacy settings migration skipped:', err);
    return null;
  }
}

export function extractSchemaDefaults(schema?: readonly ConfigFieldSchema[]): Record<string, unknown> {
  const defaults: Record<string, unknown> = {};
  if (!schema) return defaults;
  for (const field of schema) {
    defaults[field.key] = field.defaultValue;
  }
  return defaults;
}

/**
 * Declarative plugin configuration store backed by `~/.gemini/antigravity/agy-desk-plugins.json`.
 * Guarantees serialized write queue + atomic tmp->rename persistence (critic #12-6)
 * so rapid slider/color-picker updates can never overwrite each other out of order.
 */
export class KernelConfigStore {
  readonly configFilePath: string;
  private readonly legacySettingsPath: string;
  private doc: PluginsConfigDocument;
  private lastSavedAt: number | null = null;
  private lastWriteHash = '';
  private writeQueue: Promise<void> = Promise.resolve();
  private watcher: fs.FSWatcher | null = null;
  private watchDebounce: ReturnType<typeof setTimeout> | null = null;

  private docListeners = new Set<(doc: PluginsConfigDocument, source: 'internal' | 'external') => void>();
  private pluginConfigListeners = new Map<
    string,
    Set<(next: Record<string, unknown>, prev: Record<string, unknown>) => void>
  >();
  private schemaRegistry = new Map<string, readonly ConfigFieldSchema[]>();

  constructor(opts?: { configFilePath?: string; legacySettingsPath?: string }) {
    this.configFilePath = opts?.configFilePath || DEFAULT_PLUGINS_CONFIG_PATH;
    this.legacySettingsPath = opts?.legacySettingsPath || LEGACY_SETTINGS_PATH;
    this.doc = this.loadFromDiskOrMigrate();
  }

  getDocument(): Readonly<PluginsConfigDocument> {
    return this.doc;
  }

  getLastSavedAt(): number | null {
    return this.lastSavedAt;
  }

  registerPluginSchema(pluginId: string, schema?: readonly ConfigFieldSchema[]): void {
    if (schema && schema.length > 0) {
      this.schemaRegistry.set(pluginId, schema);
    } else {
      this.schemaRegistry.delete(pluginId);
    }
  }

  isPluginEnabled(pluginId: string, defaultEnabled = true): boolean {
    const entry = this.doc.plugins[pluginId];
    if (entry && typeof entry.enabled === 'boolean') return entry.enabled;
    const mount = this.doc.mounts.find((m) => m.id === pluginId);
    if (mount && typeof mount.enabled === 'boolean') return mount.enabled;
    return defaultEnabled;
  }

  getPluginConfig<T extends Record<string, unknown> = Record<string, unknown>>(pluginId: string): Readonly<T> {
    const defaults = extractSchemaDefaults(this.schemaRegistry.get(pluginId));
    const override = this.doc.plugins[pluginId]?.config || {};
    return { ...defaults, ...override } as Readonly<T>;
  }

  async setPluginEnabled(pluginId: string, enabled: boolean): Promise<void> {
    const prevEntry = this.doc.plugins[pluginId] || {};
    const nextMounts = this.doc.mounts.map((m) => (m.id === pluginId ? { ...m, enabled } : m));
    this.doc = {
      ...this.doc,
      mounts: nextMounts,
      plugins: {
        ...this.doc.plugins,
        [pluginId]: { ...prevEntry, enabled },
      },
    };
    await this.enqueuePersist();
    this.emitDocChange('internal');
  }

  async updatePluginConfig<T extends Record<string, unknown> = Record<string, unknown>>(
    pluginId: string,
    partial: Partial<T>
  ): Promise<Readonly<T>> {
    const prevResolved = this.getPluginConfig<T>(pluginId);
    const prevEntry = this.doc.plugins[pluginId] || {};
    const mergedOverride: Record<string, unknown> = {
      ...(prevEntry.config || {}),
      ...partial,
    };

    this.doc = {
      ...this.doc,
      plugins: {
        ...this.doc.plugins,
        [pluginId]: {
          ...prevEntry,
          config: mergedOverride,
        },
      },
    };

    const nextResolved = this.getPluginConfig<T>(pluginId);
    this.emitPluginConfigChange(pluginId, nextResolved, prevResolved);
    await this.enqueuePersist();
    this.emitDocChange('internal');
    return nextResolved;
  }

  async upsertMount(mount: LocalPluginMount): Promise<void> {
    const exists = this.doc.mounts.some((m) => m.id === mount.id);
    const nextMounts = exists
      ? this.doc.mounts.map((m) => (m.id === mount.id ? mount : m))
      : [...this.doc.mounts, mount];
    this.doc = { ...this.doc, mounts: nextMounts };
    await this.enqueuePersist();
    this.emitDocChange('internal');
  }

  async removeMount(pluginId: string): Promise<void> {
    this.doc = {
      ...this.doc,
      mounts: this.doc.mounts.filter((m) => m.id !== pluginId),
    };
    await this.enqueuePersist();
    this.emitDocChange('internal');
  }

  async updateSlotOverride(slotId: SlotKind, override: SlotLayoutOverride | null): Promise<void> {
    const nextSlots = { ...this.doc.slots };
    if (override === null) {
      delete nextSlots[slotId];
    } else {
      nextSlots[slotId] = override;
    }
    this.doc = { ...this.doc, slots: nextSlots };
    await this.enqueuePersist();
    this.emitDocChange('internal');
  }

  async setSafeModeFlag(enabled: boolean): Promise<void> {
    this.doc = { ...this.doc, safeMode: enabled };
    await this.enqueuePersist();
    this.emitDocChange('internal');
  }

  onPluginConfigChange(
    pluginId: string,
    cb: (next: Record<string, unknown>, prev: Record<string, unknown>) => void
  ): Disposer {
    let set = this.pluginConfigListeners.get(pluginId);
    if (!set) {
      set = new Set();
      this.pluginConfigListeners.set(pluginId, set);
    }
    set.add(cb);
    return () => {
      set?.delete(cb);
      if (set && set.size === 0) this.pluginConfigListeners.delete(pluginId);
    };
  }

  onDocumentChange(cb: (doc: PluginsConfigDocument, source: 'internal' | 'external') => void): Disposer {
    this.docListeners.add(cb);
    return () => {
      this.docListeners.delete(cb);
    };
  }

  startExternalWatcher(): Disposer {
    if (this.watcher) return () => {};
    try {
      fs.mkdirSync(path.dirname(this.configFilePath), { recursive: true });
      const dir = path.dirname(this.configFilePath);
      const base = path.basename(this.configFilePath);
      this.watcher = fs.watch(dir, (_eventType, filename) => {
        if (filename && filename !== base) return;
        if (this.watchDebounce) clearTimeout(this.watchDebounce);
        this.watchDebounce = setTimeout(() => {
          this.reloadFromDiskExternal();
        }, 160);
      });
    } catch {
      // ignore watcher setup error
    }
    return () => {
      if (this.watchDebounce) {
        clearTimeout(this.watchDebounce);
        this.watchDebounce = null;
      }
      this.watcher?.close();
      this.watcher = null;
    };
  }

  private loadFromDiskOrMigrate(): PluginsConfigDocument {
    try {
      if (fs.existsSync(this.configFilePath)) {
        const raw = fs.readFileSync(this.configFilePath, 'utf8');
        this.lastWriteHash = raw;
        const parsed = JSON.parse(raw) as Partial<PluginsConfigDocument>;
        if (parsed && parsed.schemaVersion === 1) {
          return {
            schemaVersion: 1,
            migratedFromLegacySettings: Boolean(parsed.migratedFromLegacySettings),
            safeMode: Boolean(parsed.safeMode),
            mounts: Array.isArray(parsed.mounts) ? parsed.mounts : [],
            plugins: parsed.plugins && typeof parsed.plugins === 'object' ? parsed.plugins : {},
            slots: parsed.slots && typeof parsed.slots === 'object' ? parsed.slots : {},
          };
        }
      }
    } catch (err) {
      console.warn('[KernelConfigStore] Failed reading plugins config, recreating default:', err);
    }

    const base = createEmptyDocument();
    const migrated = migrateLegacySettings(this.legacySettingsPath);
    const initial: PluginsConfigDocument = migrated
      ? {
          ...base,
          migratedFromLegacySettings: true,
          plugins: migrated.plugins || {},
        }
      : base;

    this.doc = initial;
    void this.enqueuePersist();
    return initial;
  }

  private reloadFromDiskExternal(): void {
    try {
      if (!fs.existsSync(this.configFilePath)) return;
      const raw = fs.readFileSync(this.configFilePath, 'utf8');
      if (raw === this.lastWriteHash) return; // self-write echo
      const parsed = JSON.parse(raw) as Partial<PluginsConfigDocument>;
      if (!parsed || parsed.schemaVersion !== 1) return;

      const prevDoc = this.doc;
      const nextDoc: PluginsConfigDocument = {
        schemaVersion: 1,
        migratedFromLegacySettings: Boolean(parsed.migratedFromLegacySettings),
        safeMode: Boolean(parsed.safeMode),
        mounts: Array.isArray(parsed.mounts) ? parsed.mounts : [],
        plugins: parsed.plugins && typeof parsed.plugins === 'object' ? parsed.plugins : {},
        slots: parsed.slots && typeof parsed.slots === 'object' ? parsed.slots : {},
      };

      const prevConfigs = new Map<string, Record<string, unknown>>();
      for (const pid of this.pluginConfigListeners.keys()) {
        prevConfigs.set(pid, { ...this.getPluginConfig(pid) });
      }

      this.lastWriteHash = raw;
      this.doc = nextDoc;

      for (const [pid, prevCfg] of prevConfigs.entries()) {
        const nextCfg = this.getPluginConfig(pid);
        if (JSON.stringify(prevCfg) !== JSON.stringify(nextCfg)) {
          this.emitPluginConfigChange(pid, nextCfg, prevCfg);
        }
      }

      if (JSON.stringify(prevDoc) !== JSON.stringify(nextDoc)) {
        this.emitDocChange('external');
      }
    } catch {
      // ignore transient partial write while external editor saves
    }
  }

  private enqueuePersist(): Promise<void> {
    const serialized = JSON.stringify(this.doc, null, 2) + '\n';
    this.writeQueue = this.writeQueue
      .catch(() => {})
      .then(async () => {
        const dir = path.dirname(this.configFilePath);
        await fs.promises.mkdir(dir, { recursive: true });
        const tmpPath = `${this.configFilePath}.tmp.${process.pid}.${Date.now()}`;
        this.lastWriteHash = serialized;
        await fs.promises.writeFile(tmpPath, serialized, 'utf8');
        await fs.promises.rename(tmpPath, this.configFilePath);
        this.lastSavedAt = Date.now();
      });
    return this.writeQueue;
  }

  private emitPluginConfigChange(
    pluginId: string,
    next: Record<string, unknown>,
    prev: Record<string, unknown>
  ): void {
    const set = this.pluginConfigListeners.get(pluginId);
    if (!set) return;
    for (const cb of set) {
      try {
        cb(next, prev);
      } catch (err) {
        console.error(`[KernelConfigStore] config listener error for "${pluginId}":`, err);
      }
    }
  }

  private emitDocChange(source: 'internal' | 'external'): void {
    for (const cb of this.docListeners) {
      try {
        cb(this.doc, source);
      } catch {
        // isolate
      }
    }
  }
}
