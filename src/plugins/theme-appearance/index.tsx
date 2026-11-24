import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Blocks, Palette, Search, Settings, X } from 'lucide-react';
import { create } from 'zustand';
import {
  BUILTIN_PLUGIN_IDS,
  SchemaSettingsForm,
  extractSchemaSearchEntries,
  usePluginConfigStore,
  useSlotRegistry,
  type BuiltinPluginPackage,
  type ClientPluginModule,
  type DeskClientContext,
  type Disposer,
  type SettingsSearchEntry,
  type SlotContributionMap,
} from '../../kernel/client';
import { themeAppearanceConfigSchema, themeAppearanceManifest } from './manifest';

const FONT_STACKS: Record<string, string> = {
  'System UI': '-apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Pretendard", sans-serif',
  Pretendard: '"Pretendard", -apple-system, BlinkMacSystemFont, sans-serif',
  'SF Pro': '"SF Pro Display", "SF Pro Text", -apple-system, sans-serif',
  'JetBrains Mono': '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
};

const LIGHT_PRESETS = [
  { label: '기본 밝은 테마', lightBg: '#FFFFFF', lightFg: '#0A0A0C', lightAccent: '#2F75C3' },
  { label: '아이보리 페이퍼', lightBg: '#FAF8F5', lightFg: '#1F1D1A', lightAccent: '#B45309' },
  { label: '쿨 슬레이트', lightBg: '#F8FAFC', lightFg: '#0F172A', lightAccent: '#2563EB' },
];

interface SettingsModalState {
  open: boolean;
  activeSectionKey: string | null;
  openModal: (sectionKey?: string) => void;
  closeModal: () => void;
  setActiveSectionKey: (key: string) => void;
}

export const useDynamicSettingsModalStore = create<SettingsModalState>((set) => ({
  open: false,
  activeSectionKey: null,
  openModal: (sectionKey) => set((s) => ({ open: true, activeSectionKey: sectionKey ?? s.activeSectionKey })),
  closeModal: () => set({ open: false }),
  setActiveSectionKey: (activeSectionKey) => set({ activeSectionKey }),
}));

function buildThemeTokens(cfg: Record<string, unknown>): {
  cssVars: Record<string, string>;
  datasets: Record<string, string>;
  fontStack: string;
} {
  const theme = typeof cfg.theme === 'string' ? cfg.theme : 'light';
  const contrast = cfg.contrast === 'high' ? 'high' : 'default';
  const prefersDark = typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches;
  const isDark = theme === 'dark' || (theme === 'system' && prefersDark);

  const bg = String(isDark ? cfg.darkBg || '#111317' : cfg.lightBg || '#FFFFFF');
  const fg = String(isDark ? cfg.darkFg || '#EEF1F6' : cfg.lightFg || '#0A0A0C');
  const accent = String(isDark ? cfg.darkAccent || '#4C8DFF' : cfg.lightAccent || '#2F75C3');
  const fontSizePx = typeof cfg.fontSizePx === 'number' ? cfg.fontSizePx : 14;
  const fontFamily = typeof cfg.fontFamily === 'string' ? cfg.fontFamily : 'System UI';
  const fontStack = FONT_STACKS[fontFamily] || FONT_STACKS['System UI'];

  const palette: Record<string, string> = isDark
    ? {
        '--sidebar': '#16181d',
        '--surface': '#1d2027',
        '--surface-active': '#252932',
        '--card': '#181b21',
        '--border': contrast === 'high' ? '#3b4252' : '#252932',
        '--border-strong': contrast === 'high' ? '#4c566a' : '#323846',
        '--fg-soft': '#cbd5e1',
        '--muted': contrast === 'high' ? '#a7b0c0' : '#848d9d',
      }
    : {
        '--sidebar': '#f7f8fa',
        '--surface': '#f3f4f6',
        '--surface-active': '#eaedf2',
        '--card': bg,
        '--border': contrast === 'high' ? '#cbd2dc' : '#eceef2',
        '--border-strong': contrast === 'high' ? '#9aa5b4' : '#dde1e8',
        '--fg-soft': '#374151',
        '--muted': contrast === 'high' ? '#4b5563' : '#848c99',
      };

  return {
    cssVars: {
      '--bg': bg,
      '--fg': fg,
      '--accent': accent,
      '--accent-hover': accent,
      '--chat-font-size': `${fontSizePx}px`,
      ...palette,
    },
    datasets: {
      theme: isDark ? 'dark' : 'light',
      contrast,
    },
    fontStack,
  };
}

function createDynamicSettingsModal(ctx: DeskClientContext): React.FC {
  return function DynamicSettingsModal() {
    const open = useDynamicSettingsModalStore((s) => s.open);
    const activeSectionKey = useDynamicSettingsModalStore((s) => s.activeSectionKey);
    const closeModal = useDynamicSettingsModalStore((s) => s.closeModal);
    const setActiveSectionKey = useDynamicSettingsModalStore((s) => s.setActiveSectionKey);

    const rawSlotEntries = useSlotRegistry((s) => s.bySlot['settings.section']);
    const getEntries = useSlotRegistry((s) => s.getEntries);
    const configsByPlugin = usePluginConfigStore((s) => s.configsByPlugin);
    const setPluginConfig = usePluginConfigStore((s) => s.setPluginConfig);

    const [query, setQuery] = useState('');
    const searchRef = useRef<HTMLInputElement | null>(null);

    const sections = useMemo(() => {
      void rawSlotEntries;
      return getEntries('settings.section').map((entry) => ({
        key: entry.key,
        pluginId: entry.pluginId,
        contrib: entry.contribution as SlotContributionMap['settings.section'],
      }));
    }, [getEntries, rawSlotEntries]);

    const selected = useMemo(() => {
      if (sections.length === 0) return null;
      return sections.find((s) => s.key === activeSectionKey || s.contrib.id === activeSectionKey) || sections[0];
    }, [activeSectionKey, sections]);

    // Dynamic global search index across ALL active plugins (critic #12-3)
    const searchIndex = useMemo<Array<SettingsSearchEntry & { sectionKey: string; sectionTitle: string }>>(() => {
      const list: Array<SettingsSearchEntry & { sectionKey: string; sectionTitle: string }> = [];
      for (const sec of sections) {
        if (sec.contrib.schema && sec.contrib.schema.length > 0) {
          for (const item of extractSchemaSearchEntries(sec.pluginId, sec.contrib.id, sec.contrib.schema)) {
            list.push({ ...item, sectionKey: sec.key, sectionTitle: sec.contrib.title });
          }
        }
        if (sec.contrib.searchEntries) {
          for (const item of sec.contrib.searchEntries) {
            list.push({
              ...item,
              pluginId: sec.pluginId,
              sectionId: sec.contrib.id,
              keywords: item.keywords.toLowerCase(),
              sectionKey: sec.key,
              sectionTitle: sec.contrib.title,
            });
          }
        }
      }
      return list;
    }, [sections]);

    const qLower = query.trim().toLowerCase();
    const searchResults = useMemo(() => {
      if (!qLower) return [];
      return searchIndex
        .filter(
          (item) =>
            item.keywords.includes(qLower) ||
            item.title.toLowerCase().includes(qLower) ||
            (item.description || '').toLowerCase().includes(qLower) ||
            item.sectionTitle.toLowerCase().includes(qLower)
        )
        .slice(0, 24);
    }, [qLower, searchIndex]);

    useEffect(() => {
      if (!open) return;
      const onKey = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          closeModal();
        } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
          e.preventDefault();
          searchRef.current?.focus();
          searchRef.current?.select();
        }
      };
      window.addEventListener('keydown', onKey);
      return () => window.removeEventListener('keydown', onKey);
    }, [closeModal, open]);

    if (!open) return null;

    const updatePluginCfg = async (pluginId: string, patch: Record<string, unknown>) => {
      const prev = configsByPlugin[pluginId] || {};
      setPluginConfig(pluginId, { ...prev, ...patch });
      try {
        const saved = await ctx.rpc.invoke<Record<string, unknown>>('kernel:config:update', { pluginId, patch });
        setPluginConfig(pluginId, saved);
      } catch {
        // ignore if standalone browser mode
      }
    };

    const groupedNav = new Map<string, typeof sections>();
    for (const sec of sections) {
      const g = sec.contrib.group || '기타';
      const arr = groupedNav.get(g) || [];
      arr.push(sec);
      groupedNav.set(g, arr);
    }

    const SelectedCustomComp = selected?.contrib.Component;

    return (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center p-6"
        style={{ background: 'rgba(10, 12, 16, 0.42)', backdropFilter: 'blur(4px)' }}
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) closeModal();
        }}
      >
        <div
          className="w-full max-w-[920px] h-[min(720px,88vh)] rounded-2xl border flex overflow-hidden"
          style={{
            background: 'var(--bg)',
            borderColor: 'var(--border-strong)',
            boxShadow: 'var(--shadow-popover)',
            color: 'var(--fg)',
          }}
        >
          {/* 좌측: 통합 검색 + 동적 플러그인 설정 네비게이션 */}
          <aside
            className="w-[236px] shrink-0 border-r flex flex-col p-3 gap-2.5"
            style={{ background: 'var(--sidebar)', borderColor: 'var(--border)' }}
          >
            <div
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl border text-[12px]"
              style={{ background: 'var(--card)', borderColor: 'var(--border)' }}
            >
              <Search size={13} style={{ color: 'var(--muted)' }} className="shrink-0" />
              <input
                ref={searchRef}
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="설정 검색 (⌘F)..."
                className="flex-1 min-w-0 bg-transparent outline-none text-[12px]"
                style={{ color: 'var(--fg)' }}
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery('')}
                  className="cursor-pointer opacity-60 hover:opacity-100"
                >
                  <X size={12} />
                </button>
              )}
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto scroll-thin space-y-3">
              {Array.from(groupedNav.entries()).map(([groupLabel, items]) => (
                <div key={groupLabel} className="space-y-0.5">
                  <div className="px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide" style={{ color: 'var(--muted)' }}>
                    {groupLabel}
                  </div>
                  {items.map((item) => {
                    const isActive = !qLower && selected?.key === item.key;
                    const Icon = item.contrib.icon || Settings;
                    return (
                      <button
                        key={item.key}
                        type="button"
                        onClick={() => {
                          setQuery('');
                          setActiveSectionKey(item.key);
                        }}
                        className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-[12.5px] text-left cursor-pointer transition-colors hover:bg-[var(--surface-active)]"
                        style={{
                          background: isActive ? 'var(--surface-active)' : undefined,
                          color: isActive ? 'var(--fg)' : 'var(--fg-soft)',
                          fontWeight: isActive ? 600 : 400,
                        }}
                      >
                        <Icon size={14} />
                        <span className="truncate">{item.contrib.title}</span>
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>

            <div className="pt-2 border-t" style={{ borderColor: 'var(--border)' }}>
              <button
                type="button"
                onClick={() => {
                  closeModal();
                  if (ctx.panes.getType('plugin-studio')) {
                    ctx.workspace.openTab('plugin-studio', undefined, { split: 'h' });
                  }
                }}
                className="w-full flex items-center gap-2 px-2.5 py-2 rounded-xl border text-[12px] font-medium cursor-pointer hover:bg-[var(--surface)]"
                style={{ background: 'var(--card)', borderColor: 'var(--border)', color: 'var(--accent)' }}
              >
                <Blocks size={14} />
                <span className="truncate">Plugin Studio 열기 →</span>
              </button>
            </div>
          </aside>

          {/* 우측: 검색 결과 또는 선택된 플러그인 설정 본문 */}
          <div className="flex-1 min-w-0 flex flex-col">
            <div
              className="h-12 shrink-0 px-5 border-b flex items-center justify-between"
              style={{ borderColor: 'var(--border)' }}
            >
              <div>
                <div className="text-[14px] font-semibold">
                  {qLower ? `검색 결과 (${searchResults.length})` : selected?.contrib.title || '설정'}
                </div>
                {!qLower && selected?.contrib.description && (
                  <div className="text-[11.5px]" style={{ color: 'var(--muted)' }}>
                    {selected.contrib.description}
                  </div>
                )}
              </div>
              <button
                type="button"
                onClick={closeModal}
                className="p-1.5 rounded-lg hover:bg-[var(--surface)] cursor-pointer"
                style={{ color: 'var(--muted)' }}
                title="닫기 (Esc)"
              >
                <X size={16} />
              </button>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto scroll-thin p-5">
              {qLower ? (
                searchResults.length === 0 ? (
                  <div className="py-12 text-center text-[13px]" style={{ color: 'var(--muted)' }}>
                    &ldquo;{query}&rdquo; 와 일치하는 활성 플러그인 설정이 없습니다.
                  </div>
                ) : (
                  <div
                    className="rounded-xl border divide-y overflow-hidden"
                    style={{ background: 'var(--card)', borderColor: 'var(--border)' }}
                  >
                    {searchResults.map((hit) => (
                      <button
                        key={hit.id}
                        type="button"
                        onClick={() => {
                          setQuery('');
                          setActiveSectionKey(hit.sectionKey);
                        }}
                        className="w-full px-4 py-3 flex items-center justify-between gap-3 text-left cursor-pointer hover:bg-[var(--surface)]"
                        style={{ borderColor: 'var(--border)' }}
                      >
                        <div className="min-w-0">
                          <div className="text-[13px] font-medium" style={{ color: 'var(--fg)' }}>
                            {hit.title}
                          </div>
                          {hit.description && (
                            <div className="text-[11.5px] truncate mt-0.5" style={{ color: 'var(--muted)' }}>
                              {hit.description}
                            </div>
                          )}
                        </div>
                        <span
                          className="shrink-0 px-2 py-0.5 rounded-md text-[11px] font-medium"
                          style={{ background: 'var(--surface)', color: 'var(--muted)' }}
                        >
                          {hit.sectionTitle}
                        </span>
                      </button>
                    ))}
                  </div>
                )
              ) : selected ? (
                SelectedCustomComp ? (
                  <SelectedCustomComp />
                ) : selected.contrib.schema ? (
                  <SchemaSettingsForm
                    schema={selected.contrib.schema}
                    values={configsByPlugin[selected.pluginId] || {}}
                    onChange={(patch) => void updatePluginCfg(selected.pluginId, patch)}
                    onPickDirectory={() => ctx.rpc.invoke<string | null>('kernel:dialog:pick-dir').catch(() => null)}
                  />
                ) : (
                  <div className="text-[12.5px]" style={{ color: 'var(--muted)' }}>
                    이 섹션에는 표시할 설정 항목이 없습니다.
                  </div>
                )
              ) : (
                <div className="text-[12.5px]" style={{ color: 'var(--muted)' }}>
                  등록된 설정 섹션이 없습니다.
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  };
}

export const themeAppearanceClient: ClientPluginModule = {
  activate(ctx) {
    let activeThemeDisposers: Disposer[] = [];

    const applyScopedTheme = (cfg: Record<string, unknown>) => {
      // Unwind previous scoped CSS vars cleanly before applying new ones
      for (const d of activeThemeDisposers.splice(0).reverse()) {
        void d();
      }
      const { cssVars, datasets, fontStack } = buildThemeTokens(cfg);
      const dVars = ctx.ui.setCssVars(cssVars);
      const dData = ctx.ui.setRootDatasets(datasets);
      const prevBodyFont = typeof document !== 'undefined' ? document.body.style.fontFamily : '';
      if (typeof document !== 'undefined') {
        document.body.style.fontFamily = fontStack;
      }
      const dFont = ctx.scope.onDispose(() => {
        if (typeof document !== 'undefined') {
          document.body.style.fontFamily = prevBodyFont;
        }
      }, 'theme-body-font');
      activeThemeDisposers = [dVars, dData, dFont];
    };

    applyScopedTheme(ctx.config.get());
    ctx.config.onChange((next) => {
      applyScopedTheme(next);
    });

    // Follow OS theme changes when mode === 'system'
    if (typeof window !== 'undefined' && window.matchMedia) {
      const mql = window.matchMedia('(prefers-color-scheme: dark)');
      const onMedia = () => {
        if (ctx.config.getKey('theme') === 'system') {
          applyScopedTheme(ctx.config.get());
        }
      };
      mql.addEventListener('change', onMedia);
      ctx.scope.onDispose(() => mql.removeEventListener('change', onMedia), 'theme-media-query');
    }

    // Settings command (`⌘,`)
    ctx.commands.register({
      id: 'settings:open',
      title: '설정 열기',
      shortcut: 'Mod+,',
      run: (args) => {
        const tab = typeof args === 'string' ? args : undefined;
        useDynamicSettingsModalStore.getState().openModal(tab);
      },
    });

    // Dynamic SettingsModal overlay
    ctx.slots.register('overlay.layer', {
      id: 'settings-modal',
      zLayer: 'modal',
      order: 20,
      Component: createDynamicSettingsModal(ctx),
    });

    // Sidebar footer settings button
    ctx.slots.register('sidebar.section', {
      id: 'settings-footer-btn',
      zone: 'footer',
      order: 90,
      Component: () => (
        <button
          type="button"
          onClick={() => useDynamicSettingsModalStore.getState().openModal()}
          className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-[13px] cursor-pointer transition-colors hover:bg-[var(--surface-active)]"
          style={{ color: 'var(--fg-soft)' }}
        >
          <Settings size={14} style={{ color: 'var(--muted)' }} />
          <span>설정</span>
        </button>
      ),
    });

    // Own theme settings section (presets + full schema form)
    const ThemeSectionView: React.FC = () => {
      const values = usePluginConfigStore((s) => s.configsByPlugin[BUILTIN_PLUGIN_IDS.THEME_APPEARANCE] || {});
      return (
        <div className="space-y-4">
          <div className="space-y-1.5">
            <div className="text-[11.5px] font-semibold px-0.5" style={{ color: 'var(--muted)' }}>
              빠른 라이트 프리셋
            </div>
            <div className="flex flex-wrap gap-2">
              {LIGHT_PRESETS.map((p) => (
                <button
                  key={p.label}
                  type="button"
                  onClick={() =>
                    void ctx.config.set({
                      theme: 'light',
                      lightBg: p.lightBg,
                      lightFg: p.lightFg,
                      lightAccent: p.lightAccent,
                    })
                  }
                  className="inline-flex items-center gap-2 px-3 py-1.5 rounded-xl border text-[12px] cursor-pointer hover:bg-[var(--surface)]"
                  style={{ background: 'var(--card)', borderColor: 'var(--border)', color: 'var(--fg)' }}
                >
                  <span
                    className="w-3.5 h-3.5 rounded-full border"
                    style={{ background: p.lightBg, borderColor: p.lightAccent }}
                  />
                  <span>{p.label}</span>
                </button>
              ))}
            </div>
          </div>

          <SchemaSettingsForm
            schema={themeAppearanceConfigSchema}
            values={values}
            onChange={(patch) => void ctx.config.set(patch)}
          />
        </div>
      );
    };

    ctx.slots.register('settings.section', {
      id: 'appearance',
      group: '화면 · 테마',
      title: '테마 · 화면',
      description: '라이트/다크 테마, 대비, 글꼴, 색상 팔레트 설정',
      icon: Palette,
      order: 10,
      schema: themeAppearanceConfigSchema,
      Component: ThemeSectionView,
    });
  },
};

export const themeAppearanceClientPackage: BuiltinPluginPackage = {
  manifest: themeAppearanceManifest,
  client: themeAppearanceClient,
};
