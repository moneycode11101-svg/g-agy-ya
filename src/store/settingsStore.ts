import { create } from 'zustand';
import {
  DEFAULT_APP_SETTINGS,
  type AppSettings,
  type CustomizationsInventory,
  type SystemRuntimeInfo,
} from '../shared/settingsTypes';

const FONT_STACKS: Record<string, string> = {
  'System UI': '-apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Pretendard", sans-serif',
  Pretendard: '"Pretendard", -apple-system, BlinkMacSystemFont, sans-serif',
  'SF Pro': '"SF Pro Display", "SF Pro Text", -apple-system, sans-serif',
  'JetBrains Mono': '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
};

export function applyVisualSettingsToDom(settings: AppSettings): void {
  const root = document.documentElement;
  const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches;
  const isDark = settings.theme === 'dark' || (settings.theme === 'system' && prefersDark);

  root.dataset.theme = isDark ? 'dark' : 'light';
  root.dataset.contrast = settings.contrast;

  const bg = isDark ? settings.darkBg : settings.lightBg;
  const fg = isDark ? settings.darkFg : settings.lightFg;
  const accent = isDark ? settings.darkAccent : settings.lightAccent;

  root.style.setProperty('--bg', bg);
  root.style.setProperty('--fg', fg);
  root.style.setProperty('--accent', accent);
  root.style.setProperty('--accent-hover', accent);
  root.style.setProperty('--chat-font-size', `${settings.fontSizePx || 14}px`);

  const stack = FONT_STACKS[settings.fontFamily] || FONT_STACKS['System UI'];
  document.body.style.fontFamily = stack;

  if (isDark) {
    root.style.setProperty('--sidebar', '#16181d');
    root.style.setProperty('--surface', '#1d2027');
    root.style.setProperty('--surface-active', '#252932');
    root.style.setProperty('--card', '#181b21');
    root.style.setProperty('--border', settings.contrast === 'high' ? '#3b4252' : '#252932');
    root.style.setProperty('--border-strong', settings.contrast === 'high' ? '#4c566a' : '#323846');
    root.style.setProperty('--fg-soft', '#cbd5e1');
    root.style.setProperty('--muted', settings.contrast === 'high' ? '#a7b0c0' : '#848d9d');
  } else {
    root.style.setProperty('--sidebar', '#f7f8fa');
    root.style.setProperty('--surface', '#f3f4f6');
    root.style.setProperty('--surface-active', '#eaedf2');
    root.style.setProperty('--card', bg);
    root.style.setProperty('--border', settings.contrast === 'high' ? '#cbd2dc' : '#eceef2');
    root.style.setProperty('--border-strong', settings.contrast === 'high' ? '#9aa5b4' : '#dde1e8');
    root.style.setProperty('--fg-soft', '#374151');
    root.style.setProperty('--muted', settings.contrast === 'high' ? '#4b5563' : '#848c99');
  }
}

export type SettingsTabId = 'general' | 'agent' | 'appearance' | 'webview' | 'notify' | 'custom';

interface SettingsState {
  settings: AppSettings;
  loaded: boolean;
  modalOpen: boolean;
  activeTab: SettingsTabId;
  runtimeInfo: SystemRuntimeInfo | null;
  inventory: CustomizationsInventory | null;

  openSettings: (tab?: SettingsTabId) => void;
  closeSettings: () => void;
  setActiveTab: (tab: SettingsTabId) => void;
  hydrate: () => Promise<void>;
  updateSettings: (partial: Partial<AppSettings>) => Promise<void>;
  refreshInventory: () => Promise<void>;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: DEFAULT_APP_SETTINGS,
  loaded: false,
  modalOpen: false,
  activeTab: 'general',
  runtimeInfo: null,
  inventory: null,

  openSettings: (tab) => {
    set((s) => ({ modalOpen: true, activeTab: tab || s.activeTab }));
    void get().refreshInventory();
  },

  closeSettings: () => set({ modalOpen: false }),

  setActiveTab: (tab) => {
    set({ activeTab: tab });
    if (tab === 'custom') {
      void get().refreshInventory();
    }
  },

  hydrate: async () => {
    if (!window.agyDesk) {
      applyVisualSettingsToDom(DEFAULT_APP_SETTINGS);
      set({ loaded: true });
      return;
    }
    const [loadedSettings, runtimeInfo] = await Promise.all([
      window.agyDesk.getSettings(),
      window.agyDesk.getRuntimeInfo(),
    ]);
    applyVisualSettingsToDom(loadedSettings);
    set({ settings: loadedSettings, runtimeInfo, loaded: true });
  },

  updateSettings: async (partial) => {
    const optimistic = { ...get().settings, ...partial };
    applyVisualSettingsToDom(optimistic);
    set({ settings: optimistic });
    if (window.agyDesk) {
      const saved = await window.agyDesk.saveSettings(partial);
      applyVisualSettingsToDom(saved);
      set({ settings: saved });
    }
  },

  refreshInventory: async () => {
    if (!window.agyDesk) return;
    const inv = await window.agyDesk.getCustomizationsInventory();
    set({ inventory: inv });
  },
}));
