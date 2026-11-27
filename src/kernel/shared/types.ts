import type React from 'react';

// ============================================================================
// 1. Core Identifiers, Capabilities & Slot Catalog (8 Canonical Slots)
// ============================================================================

export const KERNEL_API_VERSION = '1.0.0';

/** Canonical 14 built-in plugin bundle IDs shared across Kernel, Runtime, Visualizer & Migrations */
export const BUILTIN_PLUGIN_IDS = {
  AGENT_AGY: 'agent-agy',
  AGENT_CLAUDE: 'agent-claude',
  AGENT_CODEX: 'agent-codex',
  PANE_CHAT: 'pane-chat',
  PANE_TERMINAL: 'pane-terminal',
  PANE_WEBVIEW: 'pane-webview',
  PANE_GIT_DIFF: 'pane-git-diff',
  PANE_ARTIFACT: 'pane-artifact',
  PANE_LAUNCHER: 'pane-launcher',
  HUD_TOKEN_BAR: 'hud-token-bar',
  SIDEBAR_WORKSPACE: 'sidebar-workspace',
  RUNTIME_CONTEXT_INSPECTOR: 'runtime-context-inspector',
  PLUGIN_STUDIO: 'plugin-studio',
  THEME_APPEARANCE: 'theme-appearance',
  NOTIFY_FEEDBACK: 'notify-feedback',
  MACOS_SYSTEM_SHELL: 'macos-system-shell',
  SHORTCUTS_PALETTE: 'shortcuts-palette',
  APP_UPDATER: 'app-updater',
} as const;

/** Canonical `pane.widget` anchor IDs unified across Chat, TokenBar, Runtime & Visualizer */
export const PANE_WIDGET_ANCHORS = {
  CHAT_ABOVE_COMPOSER: 'chat:above-composer',
  CHAT_COMPOSER_BADGE: 'chat:composer-badge',
  CHAT_FOOTER: 'chat:footer',
} as const;

export type PaneWidgetAnchor = (typeof PANE_WIDGET_ANCHORS)[keyof typeof PANE_WIDGET_ANCHORS] | (string & {});

export type SlotKind =
  | 'titlebar.actions'
  | 'sidebar.section'
  | 'pane.type'
  | 'pane.header.action'
  | 'pane.widget'
  | 'context-menu.item'
  | 'settings.section'
  | 'overlay.layer';

export type SlotSurface =
  | 'titlebar'
  | 'sidebar'
  | 'pane-tabbar'
  | 'pane-body'
  | 'launcher'
  | 'chat'
  | 'settings'
  | 'overlay';

export type PluginLayer = 'core' | 'app' | 'runtime-adapter' | 'visual-tool';
export type PluginOrigin = 'core-kernel' | 'builtin' | 'local-dev' | 'workspace';
export type PluginCategory =
  | 'kernel'
  | 'pane'
  | 'chat-widget'
  | 'system-ux'
  | 'agent-adapter'
  | 'visual-tool'
  | 'local-dev';

export type PluginLifecycleState =
  | 'discovered'
  | 'disabled'
  | 'loading'
  | 'activating'
  | 'active'
  | 'reloading'
  | 'suspended-dep'
  | 'deactivating'
  | 'degraded'
  | 'error'
  | 'quarantined';

export type ToggleImpactClass = 'instant' | 'stateful-pane' | 'dependency-critical';

export type PluginCapability =
  | 'fs:read'
  | 'fs:write'
  | 'process:spawn'
  | 'net:fetch'
  | 'electron:webview'
  | 'electron:tray'
  | 'os:notify'
  | 'os:power-save'
  | 'kernel:admin';

export type BootMode = 'normal' | 'safe-mode';

// ============================================================================
// 2. Declarative Config Schema (+ Global Settings Search Indexing)
// ============================================================================

export type ConfigFieldType =
  | 'boolean'
  | 'string'
  | 'number'
  | 'enum'
  | 'segmented'
  | 'color'
  | 'path'
  | 'string-list';

export type ConfigFieldWidget =
  | 'toggle'
  | 'select'
  | 'segmented'
  | 'color'
  | 'directory'
  | 'slider'
  | 'tags'
  | 'text';

export interface ConfigFieldOption {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
}

export interface ConfigFieldSchema {
  readonly key: string;
  readonly label: string;
  readonly description?: string;
  readonly group?: string;
  readonly type: ConfigFieldType;
  readonly widget?: ConfigFieldWidget;
  readonly defaultValue: unknown;
  readonly options?: readonly ConfigFieldOption[];
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  readonly placeholder?: string;
  /** Keywords indexed by SettingsModal global search (⌘F) */
  readonly keywords?: readonly string[];
  readonly requiresReload?: boolean;
}

// ============================================================================
// 3. Unified Plugin Manifest (100% identical for Built-in & External Local)
// ============================================================================

export interface PluginManifest {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly apiVersion: string;
  readonly description: string;
  readonly layer: PluginLayer;
  readonly category: PluginCategory;
  readonly icon?: string;
  readonly impactClass?: ToggleImpactClass;
  readonly defaultEnabled?: boolean;
  readonly locked?: boolean;

  readonly entry: {
    readonly host?: string;
    readonly client?: string;
    readonly styles?: string;
  };

  readonly requires?: readonly string[];
  readonly optionalRequires?: readonly string[];
  readonly provides?: readonly string[];
  readonly capabilities?: readonly PluginCapability[];
  readonly configSchema?: readonly ConfigFieldSchema[];

  readonly contributes?: {
    readonly slots?: readonly SlotKind[];
    readonly paneTypes?: readonly Array<{ type: string; label: string; icon?: string }>[number][];
    readonly commands?: readonly Array<{ id: string; title: string; defaultShortcut?: string }>[number][];
  };
}

// ============================================================================
// 4. Data-Agnostic Layout Tree & Opaque PaneTabRecord (Zero Domain Coupling)
// ============================================================================

export type SplitDir = 'h' | 'v';
export type SplitDirection = 'left' | 'right' | 'up' | 'down';

export type LayoutNode =
  | { type: 'leaf'; groupId: string }
  | { type: 'split'; id: string; dir: SplitDir; ratio: number; a: LayoutNode; b: LayoutNode };

export interface PaneTabRecord<TState extends Record<string, unknown> = Record<string, unknown>> {
  readonly id: string;
  readonly paneType: string;
  readonly ownerPluginId: string;
  title: string;
  pinned?: boolean;
  color?: string | null;
  state: TState;
  stateVersion?: number;
}

export interface PaneGroupRecord {
  readonly id: string;
  activeTabId: string;
  tabs: PaneTabRecord[];
}

export interface PersistedLayoutWorkspace {
  schemaVersion: 4;
  layout: LayoutNode;
  groups: Record<string, PaneGroupRecord>;
  focusedGroupId: string;
  sidebarOpen: boolean;
}

// ============================================================================
// 5. Open Event Bus & Telemetry Contracts
// ============================================================================

export type BusChannelCategory = 'agent' | 'terminal' | 'telemetry' | 'workspace' | 'plugin' | 'error';

export interface EventEnvelope<T = unknown> {
  readonly id: string;
  readonly topic: string;
  readonly source: string;
  readonly timestamp: number;
  readonly payload: T;
  readonly isError?: boolean;
}

export interface EventEdgeMetrics {
  readonly edgeId: string;
  readonly fromNodeId: string;
  readonly toNodeId: string;
  readonly category: BusChannelCategory;
  readonly channels: string[];
  readonly eventsPerSec: number;
  readonly pulseIntensity: number; // 0..1 log-scaled
  readonly lastEventAt: number;
  readonly errorRatePerSec: number;
}

export interface EventPulseSample {
  readonly id: string;
  readonly timestamp: number;
  readonly fromNodeId: string;
  readonly toNodeIds: string[];
  readonly channel: string;
  readonly category: BusChannelCategory;
  readonly coalescedCount: number;
  readonly summary: string;
  readonly payloadPreview?: Record<string, unknown>;
  readonly isError?: boolean;
}

// ============================================================================
// 6. Layer 2 Runtime Context Assets Projection (AgentAdapter <-> Studio Bridge)
// ============================================================================

export type RuntimeAssetKind =
  | 'plugin-bundle'
  | 'rule'
  | 'skill'
  | 'mcp'
  | 'preset'
  | 'hook'
  | 'subagent'
  | 'prompt-template';

export type RuntimeAssetControlMode =
  | 'live-toggle'
  | 'next-turn'
  | 'new-session'
  | 'global-only'
  | 'read-only-cli';

export type RuntimeAssetScope = 'builtin' | 'global' | 'workspace' | 'session-overlay' | 'plugin' | 'preset';

export interface RuntimeAssetTokenCost {
  readonly alwaysInjected: number;
  readonly onDemandBody?: number;
  readonly basis: 'measured-cache' | 'file-estimate' | 'unmeasured';
}

export interface RuntimeContextAsset {
  readonly id: string;
  readonly kind: RuntimeAssetKind;
  readonly name: string;
  readonly description: string;
  readonly scope: RuntimeAssetScope;
  readonly parentPluginName?: string;
  readonly sourcePath: string;
  readonly isSymlink?: boolean;
  readonly realPath?: string;
  readonly tokenCost: RuntimeAssetTokenCost;
  /** Convenience mirrors of tokenCost for quick consumers */
  readonly promptTokens: number;
  readonly lazyBodyTokens?: number;
  readonly enabled: boolean;
  readonly controlMode: RuntimeAssetControlMode;
  readonly controlReason?: string;
  readonly sideEffects?: readonly string[];
  readonly pendingNextSession?: boolean;
}

export interface RuntimeAssetsProjection {
  readonly adapterPluginId: string;
  readonly adapterLabel: string;
  readonly scannedAt: number;
  readonly tokenBudgetMax: number;
  readonly totals: {
    readonly ruleTokens: number;
    readonly skillTokens: number;
    readonly mcpTokens: number;
    readonly activeSessionContextTokens?: number;
  };
  readonly activePresetId: string | null;
  readonly presets: Array<{ id: string; label: string; assetCount: number; totalTokens: number }>;
  readonly assets: RuntimeContextAsset[];
}

export interface RuntimeAssetProvider {
  readonly adapterPluginId: string;
  readonly adapterLabel: string;
  scanAssets(cwd?: string): Promise<RuntimeAssetsProjection>;
  toggleAsset?(req: {
    assetId: string;
    enabled: boolean;
    scope?: 'session' | 'workspace' | 'global';
    cwd?: string;
  }): Promise<{ ok: boolean; requiresWorkerRestart?: boolean; cacheResetLikely?: boolean; error?: string }>;
  applyPreset?(presetId: string, cwd?: string): Promise<{ ok: boolean; error?: string }>;
  watch?(onChange: (projection: RuntimeAssetsProjection) => void): Disposer;
}

// ============================================================================
// 7. Live Introspection Projection (Plugin Studio + UI X-Ray)
// ============================================================================

export interface PluginErrorRecord {
  readonly id: string;
  readonly timestamp: number;
  readonly phase: 'manifest' | 'compile' | 'load' | 'activate' | 'render' | 'bus-handler' | 'deactivate';
  readonly message: string;
  readonly fileLocation?: string;
  readonly stack?: string;
  readonly slotId?: string;
}

export interface PluginNodeSnapshot {
  readonly id: string;
  readonly manifest: PluginManifest;
  readonly origin: PluginOrigin;
  readonly sourcePath: string | null;
  readonly lifecycleState: PluginLifecycleState;
  readonly impactClass: ToggleImpactClass;
  readonly enabledInConfig: boolean;
  readonly locked: boolean;
  readonly hostActive: boolean;
  readonly clientActive: boolean;
  readonly revHash: string;
  readonly watchActive: boolean;
  readonly hasLastGoodVersion: boolean;
  readonly activeOpenTabsCount: number;
  readonly hiddenPreservedTabsCount: number;
  readonly requires: string[];
  readonly optionalRequires: string[];
  readonly provides: string[];
  readonly dependents: string[];
  readonly occupiedSlots: Array<{ slotId: SlotKind; contributionId: string }>;
  readonly currentConfig: Record<string, unknown>;
  readonly disposableCount: { host: number; client: number };
  readonly health: {
    readonly activationMs: number | null;
    readonly lastReloadMs: number | null;
    readonly errorCount: number;
    readonly lastError: PluginErrorRecord | null;
    readonly recentErrors: PluginErrorRecord[];
  };
}

export interface SlotMountInstance {
  readonly mountId: string;
  readonly pluginId: string;
  readonly slotId: SlotKind;
  readonly contributionId: string;
  readonly zone?: string;
  readonly order: number;
  readonly groupId?: string;
  readonly tabId?: string;
  readonly visibility: 'visible' | 'hidden-preserved' | 'dormant-disabled';
  readonly mountKey: number;
  readonly hasRenderError: boolean;
}

export interface SlotOccupancyEntry {
  readonly slotId: SlotKind;
  readonly label: string;
  readonly surface: SlotSurface;
  readonly cardinality: 'single' | 'multi';
  readonly mounts: SlotMountInstance[];
}

export interface KernelHealthSnapshot {
  readonly appVersion: string;
  readonly kernelApiVersion: string;
  readonly uptimeMs: number;
  readonly totalSlotsCount: number;
  readonly occupiedSlotsCount: number;
  readonly busEventsPerSec: number;
  readonly busSparkline: number[];
  readonly memoryRssMb: number;
}

export interface KernelIntrospectionSnapshot {
  readonly seq: number;
  readonly timestamp: number;
  readonly bootMode: BootMode;
  readonly safeModeContext?: {
    readonly reason: 'boot-crash-loop' | 'cli-flag' | 'env-var' | 'manual';
    readonly suspectedPluginId: string | null;
    readonly crashCount: number;
  };
  readonly profile: {
    readonly configFilePath: string;
    readonly synced: boolean;
    readonly overrideCount: number;
    readonly mountCount: number;
    readonly lastSavedAt: number | null;
  };
  readonly kernel: KernelHealthSnapshot;
  readonly plugins: Record<string, PluginNodeSnapshot>;
  readonly serviceBindings: Record<string, string[]>;
  readonly slots: Record<SlotKind, SlotOccupancyEntry>;
  readonly runtimeAssetsByAdapter: Record<string, RuntimeAssetsProjection>;
  readonly eventEdges: Record<string, EventEdgeMetrics>;
  readonly recentPulses: EventPulseSample[];
}

export type IntrospectionDelta =
  | { type: 'full'; snapshot: KernelIntrospectionSnapshot }
  | { type: 'plugin'; seq: number; plugin: PluginNodeSnapshot; serviceBindings?: Record<string, string[]> }
  | { type: 'plugin-removed'; seq: number; pluginId: string }
  | {
      type: 'telemetry';
      seq: number;
      timestamp: number;
      kernel: Partial<KernelHealthSnapshot>;
      eventEdges: Record<string, EventEdgeMetrics>;
      pulses: EventPulseSample[];
    }
  | { type: 'runtime-assets'; seq: number; adapterPluginId: string; projection: RuntimeAssetsProjection }
  | { type: 'profile'; seq: number; profile: KernelIntrospectionSnapshot['profile'] };

export type IntrospectionCommand =
  | { type: 'plugin:toggle'; pluginId: string; enabled: boolean }
  | { type: 'plugin:reload'; pluginId: string }
  | { type: 'plugin:rollback'; pluginId: string }
  | { type: 'plugin:update-config'; pluginId: string; patch: Record<string, unknown> }
  /** Opens Main native directory picker (user-gesture security gate against XSS RCE) */
  | { type: 'plugin:mount-local-dialog'; watch?: boolean }
  | { type: 'plugin:mount-local'; dirPath: string; watch?: boolean }
  | { type: 'plugin:unmount-local'; pluginId: string }
  | { type: 'plugin:reveal-source'; pluginId: string }
  | { type: 'plugin:open-config-file' }
  | { type: 'runtime-asset:toggle'; adapterPluginId: string; assetId: string; enabled: boolean; scope?: 'session' | 'workspace' | 'global' }
  | { type: 'runtime-asset:rescan'; adapterPluginId?: string }
  | { type: 'runtime-asset:apply-preset'; adapterPluginId: string; presetId: string }
  | { type: 'system:set-safe-mode'; enabled: boolean };

export interface DomSlotAnchor {
  readonly mountId: string;
  readonly slotId: SlotKind;
  readonly pluginId: string | null;
  readonly contributionId?: string;
  readonly element: HTMLElement;
  readonly groupId?: string;
  readonly tabId?: string;
  readonly depth: number;
  readonly hiddenPreserved?: boolean;
}

// ============================================================================
// 8. Declarative Plugins Configuration Document (agy-desk-plugins.json)
// ============================================================================

export interface LocalPluginMount {
  readonly id: string;
  readonly path: string;
  readonly enabled: boolean;
  readonly watch: boolean;
  readonly trust: 'local-dev' | 'restricted';
  readonly approvedCapabilities?: readonly PluginCapability[];
}

export interface PluginPatchEntry {
  readonly enabled?: boolean;
  readonly config?: Record<string, unknown>;
}

export interface SlotLayoutOverride {
  readonly order?: readonly string[];
  readonly hide?: readonly string[];
}

export interface PluginsConfigDocument {
  readonly schemaVersion: 1;
  readonly migratedFromLegacySettings?: boolean;
  readonly safeMode?: boolean;
  readonly mounts: LocalPluginMount[];
  readonly plugins: Record<string, PluginPatchEntry>;
  readonly slots: Partial<Record<SlotKind, SlotLayoutOverride>>;
}

// ============================================================================
// 9. Bootstrap & Preload Bridge Contract (Fixed 5-Primitive window.deskKernel)
// ============================================================================

export interface PluginBootstrapItem {
  readonly id: string;
  readonly manifest: PluginManifest;
  readonly origin: PluginOrigin;
  readonly sourcePath: string | null;
  readonly enabled: boolean;
  readonly lifecycleState: PluginLifecycleState;
  readonly revHash: string;
  readonly clientModuleUrl: string | null; // null for built-ins (resolved locally) or host-only plugins
  readonly config: Record<string, unknown>;
  readonly lastError?: PluginErrorRecord | null;
}

export interface PluginBootstrapBundle {
  readonly bootMode: BootMode;
  readonly configFilePath: string;
  readonly slotOverrides: Partial<Record<SlotKind, SlotLayoutOverride>>;
  readonly plugins: PluginBootstrapItem[];
}

export type KernelPluginLifecycleEvent =
  | { type: 'plugin-activated'; plugin: PluginBootstrapItem }
  | { type: 'plugin-deactivated'; pluginId: string; reason: 'disabled' | 'suspended-dep' | 'unmounted' | 'error' }
  | { type: 'plugin-reload-client'; pluginId: string; revHash: string; clientModuleUrl: string | null; config: Record<string, unknown> }
  | { type: 'plugin-config-changed'; pluginId: string; config: Record<string, unknown> }
  | { type: 'plugin-error'; pluginId: string; error: PluginErrorRecord }
  | { type: 'slots-override-changed'; slotOverrides: Partial<Record<SlotKind, SlotLayoutOverride>> };

export interface DeskKernelBridge {
  readonly env: {
    readonly platform: string;
    readonly homeDir: string;
    readonly appVersion: string;
    readonly kernelApiVersion: string;
    readonly safeMode: boolean;
  };
  readonly rpc: {
    invoke<TRes = unknown>(method: string, payload?: unknown): Promise<TRes>;
    notify(method: string, payload?: unknown): void;
  };
  readonly bus: {
    publish(topic: string, payload?: unknown, sourcePluginId?: string): void;
    subscribe(pattern: string, handler: (env: EventEnvelope) => void): () => void;
  };
  readonly plugins: {
    getBootstrap(): Promise<PluginBootstrapBundle>;
    onLifecycleEvent(handler: (ev: KernelPluginLifecycleEvent) => void): () => void;
  };
  readonly introspection: {
    getSnapshot(): Promise<KernelIntrospectionSnapshot>;
    subscribe(handler: (delta: IntrospectionDelta) => void): () => void;
    sendCommand(cmd: IntrospectionCommand): Promise<{ ok: boolean; error?: string; data?: unknown }>;
  };
  readonly files?: {
    getPathForFile(file: File): string;
  };
}

// ============================================================================
// 10. EffectScope, ServiceRegistry & Host/Client Plugin Contexts
// ============================================================================

export type Disposer = () => void | Promise<void>;

export interface EffectScope {
  effect(setup: () => Disposer | void, label?: string): Disposer;
  onDispose(disposer: Disposer, label?: string): Disposer;
  listActive(): Array<{ id: string; label: string; createdAt: number }>;
  size(): number;
  disposeAll(): Promise<void>;
}

export interface ConfigNamespace<T extends Record<string, unknown> = Record<string, unknown>> {
  get(): Readonly<T>;
  getKey<K extends keyof T>(key: K): T[K];
  set(partial: Partial<T>): Promise<Readonly<T>>;
  onChange(cb: (next: Readonly<T>, prev: Readonly<T>) => void): Disposer;
}

export interface ServiceRegistry {
  provide<T>(token: string, impl: T): Disposer;
  get<T>(token: string): T | undefined;
  getAll<T>(token: string): Array<{ pluginId: string; impl: T }>;
  whenAvailable<T>(token: string, cb: (impl: T, providerPluginId: string) => Disposer | void): Disposer;
  getBindingsSnapshot(): Record<string, string[]>;
}

export interface TrayItemContribution {
  readonly id: string;
  readonly label: string;
  readonly order?: number;
  readonly click: () => void;
}

export interface HostWebviewHooks {
  onNewTabRequest?: (url: string) => void;
  getDownloadDir?: () => string | null;
  getLinkOpenTarget?: () => 'embedded' | 'external';
}

export interface DeskHostContext<TConfig extends Record<string, unknown> = Record<string, unknown>> {
  readonly pluginId: string;
  readonly manifest: PluginManifest;
  readonly scope: EffectScope;
  readonly config: ConfigNamespace<TConfig>;
  readonly services: ServiceRegistry;

  readonly bus: {
    publish<T>(topic: string, payload: T): void;
    subscribe<T = unknown>(pattern: string, handler: (env: EventEnvelope<T>) => void): Disposer;
  };

  readonly rpc: {
    handle<TReq = unknown, TRes = unknown>(
      method: string,
      handler: (payload: TReq, caller: { webContentsId: number }) => TRes | Promise<TRes>
    ): Disposer;
    onNotify<TReq = unknown>(method: string, handler: (payload: TReq) => void): Disposer;
  };

  readonly host: {
    readonly dataDir: string;
    readonly homeDir: string;
    readonly appVersion: string;
    pickDirectory(): Promise<string | null>;
    openExternal(url: string): Promise<void>;
    showInFolder(targetPath: string): void;
    notify(opts: { title: string; body: string; silent?: boolean; onClick?: () => void }): void;
    acquirePowerSave(reason: string): Disposer;
    setTrayEnabled(enabled: boolean): void;
    contributeTrayItem(item: TrayItemContribution): Disposer;
    registerWebviewHooks(hooks: HostWebviewHooks): Disposer;
    registerRuntimeAssetProvider(provider: RuntimeAssetProvider): Disposer;
    onWindowFocus(cb: () => void): Disposer;
    onWindowBeforeClose(cb: (ev: { preventDefault: () => void; hideWindow: () => void }) => void): Disposer;
    clearBrowserPartitionData(partition?: string): Promise<boolean>;
    openOsNotificationSettings(): Promise<void>;
  };

  readonly logger: {
    debug(msg: string, data?: unknown): void;
    info(msg: string, data?: unknown): void;
    warn(msg: string, data?: unknown): void;
    error(msg: string, err?: unknown): void;
  };
}

export interface HostPluginModule<TConfig extends Record<string, unknown> = Record<string, unknown>> {
  activate(ctx: DeskHostContext<TConfig>): void | Promise<void>;
  beforeDeactivate?(): Promise<{ ok: boolean; reason?: string }> | { ok: boolean; reason?: string };
  deactivate?(): void | Promise<void>;
}

// ============================================================================
// 11. Client UI Contributions, PaneTypeDefinition & DeskClientContext
// ============================================================================

export type ContextMenuItemDescriptor =
  | { type: 'separator' }
  | { type: 'label'; label: string }
  | {
      type: 'item';
      label: string;
      icon?: React.ReactNode;
      shortcut?: string;
      danger?: boolean;
      disabled?: boolean;
      onSelect: () => void;
    }
  | {
      type: 'submenu';
      label: string;
      icon?: React.ReactNode;
      items: ContextMenuItemDescriptor[];
    }
  | {
      type: 'color-picker';
      label: string;
      value: string | null;
      onSelect: (color: string | null) => void;
    };

export interface PaneComponentProps<TState extends Record<string, unknown> = Record<string, unknown>> {
  readonly groupId: string;
  readonly tab: PaneTabRecord<TState>;
  readonly active: boolean;
  readonly updateState: (patch: Partial<TState>) => void;
  readonly updateTabMeta: (patch: Partial<Pick<PaneTabRecord, 'title' | 'color' | 'pinned'>>) => void;
}

export interface PaneTypeDefinition<TState extends Record<string, unknown> = Record<string, unknown>> {
  readonly type: string;
  readonly ownerPluginId?: string;
  readonly label: string;
  readonly description?: string;
  readonly icon: React.ComponentType<{ size?: number }>;
  readonly accentColor?: string;
  readonly shortcut?: string;
  readonly keepAlive?: 'never' | 'group';
  readonly showInLauncher?: boolean;
  readonly showInOmnibox?: boolean;
  readonly order?: number;
  createDefaultState(init?: Record<string, unknown>): { title: string; state: TState };
  duplicateState?(src: PaneTabRecord<TState>): { title: string; state: TState };
  migrateState?(rawState: Record<string, unknown>, fromVersion?: number): TState;
  beforeClose?(tab: PaneTabRecord<TState>): Promise<boolean> | boolean;
  onTabDispose?(tab: PaneTabRecord<TState>): void | Promise<void>;
  matchOmnibox?(query: string): { score: number; label: string; init: Record<string, unknown> } | null;
  TabBadge?: React.ComponentType<{ tab: PaneTabRecord<TState>; active: boolean }>;
  Component: React.ComponentType<PaneComponentProps<TState>>;
}

export interface SettingsSearchEntry {
  readonly id: string;
  readonly sectionId: string;
  readonly pluginId: string;
  readonly title: string;
  readonly description?: string;
  readonly keywords: string;
}

export interface SlotContributionBase {
  readonly id: string;
  readonly pluginId?: string;
  readonly order?: number;
  readonly when?: () => boolean;
}

export interface TitlebarActionContribution extends SlotContributionBase {
  readonly zone: 'left' | 'center' | 'right';
  readonly Component: React.ComponentType;
}

export interface SidebarSectionContribution extends SlotContributionBase {
  readonly zone: 'top' | 'body' | 'footer';
  readonly title?: string;
  readonly Component: React.ComponentType;
}

export interface PaneHeaderActionContribution extends SlotContributionBase {
  readonly targetPaneTypes?: readonly string[];
  readonly Component: React.ComponentType<{ groupId: string; activeTab?: PaneTabRecord }>;
}

export interface PaneWidgetContribution extends SlotContributionBase {
  readonly targetPaneType: string;
  readonly anchor: PaneWidgetAnchor;
  readonly Component: React.ComponentType<{ groupId: string; tab: PaneTabRecord }>;
}

export interface ContextMenuContribution extends SlotContributionBase {
  readonly target: 'tab' | 'pane-body' | 'sidebar-item' | 'global';
  resolve(ctx: { groupId?: string; tab?: PaneTabRecord; payload?: unknown }): ContextMenuItemDescriptor[];
}

export interface SettingsSectionContribution extends SlotContributionBase {
  readonly group: string;
  readonly title: string;
  readonly description?: string;
  readonly icon?: React.ComponentType<{ size?: number }>;
  readonly schema?: readonly ConfigFieldSchema[];
  readonly Component?: React.ComponentType;
  readonly searchEntries?: readonly Omit<SettingsSearchEntry, 'pluginId' | 'sectionId'>[];
}

export interface OverlayLayerContribution extends SlotContributionBase {
  readonly zLayer: 'hud' | 'modal' | 'popover' | 'xray';
  readonly Component: React.ComponentType;
}

export interface SlotContributionMap {
  'titlebar.actions': TitlebarActionContribution;
  'sidebar.section': SidebarSectionContribution;
  'pane.type': PaneTypeDefinition & SlotContributionBase;
  'pane.header.action': PaneHeaderActionContribution;
  'pane.widget': PaneWidgetContribution;
  'context-menu.item': ContextMenuContribution;
  'settings.section': SettingsSectionContribution;
  'overlay.layer': OverlayLayerContribution;
}

export interface CommandDefinition {
  readonly id: string;
  readonly title: string;
  readonly pluginId?: string;
  readonly shortcut?: string; // e.g. 'Mod+N', 'Mod+Shift+X'
  readonly when?: () => boolean;
  readonly run: (args?: unknown) => void | Promise<void>;
}

export interface DeskClientContext<TConfig extends Record<string, unknown> = Record<string, unknown>> {
  readonly pluginId: string;
  readonly manifest: PluginManifest;
  readonly scope: EffectScope;
  readonly services: ServiceRegistry;

  readonly config: ConfigNamespace<TConfig> & {
    useConfig(): Readonly<TConfig>;
  };

  readonly bus: {
    publish<T>(topic: string, payload: T): void;
    subscribe<T = unknown>(pattern: string, handler: (env: EventEnvelope<T>) => void): Disposer;
  };

  readonly rpc: {
    invoke<TRes = unknown>(method: string, payload?: unknown): Promise<TRes>;
    notify(method: string, payload?: unknown): void;
  };

  readonly slots: {
    register<S extends SlotKind>(slotId: S, contribution: SlotContributionMap[S]): Disposer;
  };

  readonly panes: {
    registerType<TState extends Record<string, unknown>>(def: PaneTypeDefinition<TState>): Disposer;
    getType(paneType: string): PaneTypeDefinition | undefined;
    listTypes(): PaneTypeDefinition[];
  };

  readonly commands: {
    register(cmd: CommandDefinition): Disposer;
    execute(commandId: string, args?: unknown): Promise<void>;
  };

  readonly workspace: {
    openTab(
      paneType: string,
      init?: Record<string, unknown>,
      opts?: { groupId?: string; split?: SplitDir; side?: 'before' | 'after' }
    ): string | null;
    convertTab(groupId: string, tabId: string, paneType: string, init?: Record<string, unknown>): void;
    focusTab(groupId: string, tabId: string): void;
    closeTab(groupId: string, tabId: string): Promise<void>;
    getFocusedTab(): { groupId: string; tab: PaneTabRecord } | null;
    updateTabState(groupId: string, tabId: string, patch: Record<string, unknown>): void;
    updateTabMeta(
      groupId: string,
      tabId: string,
      patch: Partial<Pick<PaneTabRecord, 'title' | 'color' | 'pinned'>>
    ): void;
  };

  readonly ui: {
    showContextMenu(x: number, y: number, items: ContextMenuItemDescriptor[]): void;
    setCssVars(vars: Record<string, string>): Disposer;
    setRootDatasets(datasets: Record<string, string>): Disposer;
    injectStyle(cssText: string): Disposer;
    confirm(message: string): Promise<boolean>;
    toast(msg: string, level?: 'info' | 'warn' | 'error'): void;
  };

  readonly introspection: DeskKernelBridge['introspection'];
}

export interface ClientPluginModule<TConfig extends Record<string, unknown> = Record<string, unknown>> {
  activate(ctx: DeskClientContext<TConfig>): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}

/** Built-in plugin bundle descriptor (same activate contract as external local plugins) */
export interface BuiltinPluginPackage {
  readonly manifest: PluginManifest;
  readonly host?: HostPluginModule;
  readonly client?: ClientPluginModule;
}

declare global {
  interface Window {
    deskKernel?: DeskKernelBridge;
    __DESK_SHARED__?: Readonly<Record<string, unknown>>;
  }
}
