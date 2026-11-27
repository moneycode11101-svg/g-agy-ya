import React, { useMemo } from 'react';
import { EyeOff, Gauge } from 'lucide-react';
import {
  BUILTIN_PLUGIN_IDS,
  PANE_WIDGET_ANCHORS,
  useIntrospectionStore,
  useLayoutStore,
  type ClientPluginModule,
  type DeskClientContext,
  type PaneComponentProps,
} from '../../kernel/client';
import { useChatSessionStore } from '../pane-chat/chatStore';
import { HUD_TOKEN_BAR_MANIFEST, type HudTokenBarConfig } from './manifest';
import { buildGlobalProviderSummaries, openGlobalTokenBandPane } from './quotaModel';
import { TokenBandPane } from './TokenBandPane';
import { TokenBarWidget } from './TokenBarWidget';

const SidebarTokenBandEntryButton: React.FC = () => {
  const groups = useLayoutStore((s) => s.groups);
  const focusedGroupId = useLayoutStore((s) => s.focusedGroupId);
  const availableAdapters = useChatSessionStore((s) => s.availableAdapters);
  const accountQuotaByAdapter = useChatSessionStore((s) => s.accountQuotaByAdapter);
  const legacyAgyQuota = useChatSessionStore((s) => s.accountQuota);

  const focusedGroup = groups[focusedGroupId];
  const activeTab = focusedGroup?.tabs.find((t) => t.id === focusedGroup.activeTabId);
  const isFocused = activeTab?.paneType === 'token-band';

  const providers = useMemo(
    () => buildGlobalProviderSummaries(availableAdapters, accountQuotaByAdapter, legacyAgyQuota),
    [availableAdapters, accountQuotaByAdapter, legacyAgyQuota]
  );

  const highestPct = useMemo(() => {
    let best: number | null = null;
    for (const p of providers) {
      if (p.maxUsedPct != null && (best == null || p.maxUsedPct > best)) best = p.maxUsedPct;
    }
    return best;
  }, [providers]);

  const anyDanger = providers.some((p) => p.hasDanger);
  const anyWarning = providers.some((p) => p.hasWarning);

  return (
    <button
      type="button"
      onClick={() => openGlobalTokenBandPane({ splitIfMissing: false })}
      className="w-full flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg text-[13px] cursor-pointer transition-colors hover:bg-[var(--surface-active)]"
      style={{
        background: isFocused ? 'var(--surface-active)' : undefined,
        color: isFocused ? 'var(--fg)' : 'var(--fg-soft)',
        fontWeight: isFocused ? 600 : 500,
      }}
      title="전역 토큰 밴드 보드 열기 (⌘⇧U)"
    >
      <span className="flex items-center gap-2 min-w-0">
        <Gauge size={14} style={{ color: anyDanger ? 'var(--danger)' : anyWarning ? 'var(--warn)' : 'var(--accent)' }} className="shrink-0" />
        <span className="truncate">토큰 밴드</span>
      </span>
      <span className="flex items-center gap-1 shrink-0">
        <span className="flex items-center gap-0.5">
          {providers.map((p) => (
            <span
              key={p.adapterId}
              className="w-1.5 h-1.5 rounded-full"
              style={{
                background: p.hasDanger ? 'var(--danger)' : p.allBuckets.length > 0 ? p.meta.accent : 'var(--border-strong)',
                opacity: p.allBuckets.length > 0 ? 1 : 0.45,
              }}
              title={`${p.meta.shortName}: ${p.maxUsedPct != null ? `최대 ${p.maxUsedPct}% 사용` : '미조회'}`}
            />
          ))}
        </span>
        {highestPct != null && (
          <span
            className="num text-[10.5px] font-semibold ml-0.5"
            style={{ color: anyDanger ? 'var(--danger)' : anyWarning ? 'var(--warn)' : 'var(--muted)' }}
          >
            {highestPct}%
          </span>
        )}
      </span>
    </button>
  );
};

const TitlebarTokenBandButton: React.FC = () => {
  const availableAdapters = useChatSessionStore((s) => s.availableAdapters);
  const accountQuotaByAdapter = useChatSessionStore((s) => s.accountQuotaByAdapter);
  const legacyAgyQuota = useChatSessionStore((s) => s.accountQuota);

  const providers = useMemo(
    () => buildGlobalProviderSummaries(availableAdapters, accountQuotaByAdapter, legacyAgyQuota),
    [availableAdapters, accountQuotaByAdapter, legacyAgyQuota]
  );

  const anyDanger = providers.some((p) => p.hasDanger);
  const anyWarning = providers.some((p) => p.hasWarning);

  return (
    <button
      type="button"
      onClick={() => openGlobalTokenBandPane({ splitIfMissing: true })}
      className="relative p-1.5 rounded-lg cursor-pointer transition-colors hover:bg-[var(--surface)] app-no-drag"
      style={{ color: anyDanger ? 'var(--danger)' : anyWarning ? 'var(--warn)' : 'var(--muted)' }}
      title="전역 토큰 밴드 통합 보드 열기 (⌘⇧U)"
    >
      <Gauge size={15} />
      {(anyDanger || anyWarning) && (
        <span
          className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full"
          style={{ background: anyDanger ? 'var(--danger)' : 'var(--warn)' }}
        />
      )}
    </button>
  );
};

export const hudTokenBarClientPlugin: ClientPluginModule<HudTokenBarConfig> = {
  activate(ctx: DeskClientContext<HudTokenBarConfig>) {
    const BoundTokenBar: React.FC<{ groupId: string; tab: import('../../kernel/client').PaneTabRecord }> = (props) => (
      <TokenBarWidget {...props} ctx={ctx} />
    );

    const BoundTokenBandPane: React.FC<PaneComponentProps> = (props) => (
      <TokenBandPane {...props} ctx={ctx} />
    );

    // 1. Local Chat HUD (1:1 matched to active chat tab's adapter & model)
    ctx.slots.register('pane.widget', {
      id: 'token-bar',
      targetPaneType: 'chat',
      anchor: PANE_WIDGET_ANCHORS.CHAT_ABOVE_COMPOSER,
      order: 10,
      Component: BoundTokenBar,
    });

    // 2. Global Token Band Dedicated Pane (all 3 providers + all open sessions + aggregated tools)
    ctx.panes.registerType({
      type: 'token-band',
      label: '토큰 밴드',
      description: '반중력 · Claude · Codex 구독 한도 통합 보드 및 전체 세션 컨텍스트',
      icon: Gauge,
      accentColor: '#3b82f6',
      shortcut: '⌘⇧U',
      keepAlive: 'never',
      showInLauncher: true,
      showInOmnibox: true,
      order: 45,
      createDefaultState: () => ({
        title: '토큰 밴드',
        state: {},
      }),
      matchOmnibox: (q: string) => {
        const lower = q.trim().toLowerCase();
        if (
          lower === 'token' ||
          lower === 'quota' ||
          lower === 'usage' ||
          lower === 'band' ||
          lower === '토큰' ||
          lower === '한도' ||
          lower === '사용량' ||
          lower === '토큰밴드'
        ) {
          return { score: 95, label: '토큰 밴드 통합 보드 열기', init: {} };
        }
        return null;
      },
      Component: BoundTokenBandPane,
    });

    // 3. First-class Sidebar Top Entry (right under Plugin Studio)
    ctx.slots.register('sidebar.section', {
      id: 'token-band-nav',
      zone: 'top',
      order: 2,
      Component: SidebarTokenBandEntryButton,
    });

    // 4. Titlebar Quick Open Button
    ctx.slots.register('titlebar.actions', {
      id: 'token-band-titlebar',
      zone: 'right',
      order: 14,
      Component: TitlebarTokenBandButton,
    });

    // 5. Global Command & Shortcut (⌘⇧U)
    ctx.commands.register({
      id: 'hud-token-bar:open-global',
      title: '토큰 밴드 통합 보드 열기',
      shortcut: 'Mod+Shift+U',
      run: (payload?: unknown) => {
        const opts = (payload && typeof payload === 'object' ? payload : undefined) as
          | { splitIfMissing?: boolean }
          | undefined;
        openGlobalTokenBandPane({ splitIfMissing: opts?.splitIfMissing ?? false });
      },
    });

    // 6. Chat Context Menu Actions
    ctx.slots.register('context-menu.item', {
      id: 'hud-token-bar:toggle',
      target: 'pane-body',
      order: 60,
      resolve: ({ tab }) => {
        if (tab?.paneType !== 'chat') return [];
        return [
          {
            type: 'item',
            label: '전역 토큰 밴드 보드 열기',
            icon: <Gauge size={13} />,
            onSelect: () => {
              openGlobalTokenBandPane({ splitIfMissing: true });
            },
          },
          {
            type: 'item',
            label: '토큰 바 HUD 플러그인 끄기',
            icon: <EyeOff size={13} />,
            onSelect: () => {
              void useIntrospectionStore.getState().sendCommand({
                type: 'plugin:toggle',
                pluginId: BUILTIN_PLUGIN_IDS.HUD_TOKEN_BAR,
                enabled: false,
              });
            },
          },
        ];
      },
    });

    // 7. Settings Section
    ctx.slots.register('settings.section', {
      id: 'hud-token-bar-settings',
      group: '화면 · 채팅',
      title: '토큰 밴드 · HUD',
      description: '입력창 위 로컬 토큰 바와 전역 토큰 밴드 표시 기준을 설정합니다.',
      icon: Gauge,
      order: 35,
      schema: HUD_TOKEN_BAR_MANIFEST.configSchema,
    });
  },
};
