import React, { useEffect } from 'react';
import { Layers } from 'lucide-react';
import {
  BUILTIN_PLUGIN_IDS,
  PANE_WIDGET_ANCHORS,
  useIntrospectionStore,
  type ClientPluginModule,
  type DeskClientContext,
  type PaneComponentProps,
  type PaneTabRecord,
} from '../../kernel/client';
import { fmtKo } from '../../utils/formatKo';
import {
  RUNTIME_CONTEXT_INSPECTOR_MANIFEST,
  type RuntimeContextInspectorConfig,
} from './manifest';
import { RuntimeContextInspectorView } from './RuntimeContextInspectorView';

export const runtimeContextInspectorClientPlugin: ClientPluginModule<RuntimeContextInspectorConfig> = {
  activate(ctx: DeskClientContext<RuntimeContextInspectorConfig>) {
    const SettingsSectionView: React.FC = () => <RuntimeContextInspectorView ctx={ctx} />;

    const PaneView: React.FC<PaneComponentProps<{ cwd?: string; adapterId?: string }>> = ({ tab }) => (
      <div className="flex-1 min-h-0 overflow-y-auto scroll-thin p-5" style={{ background: 'var(--bg)' }}>
        <div className="max-w-[760px] mx-auto">
          <RuntimeContextInspectorView
            ctx={ctx}
            cwdOverride={tab.state?.cwd}
            adapterIdOverride={tab.state?.adapterId}
          />
        </div>
      </div>
    );

    const ComposerRuntimeBadge: React.FC<{ groupId: string; tab: PaneTabRecord }> = ({ groupId, tab }) => {
      const cfg = ctx.config.useConfig();
      const snapshot = useIntrospectionStore((s) => s.snapshot);
      const refreshSnapshot = useIntrospectionStore((s) => s.refreshSnapshot);

      useEffect(() => {
        if (!snapshot) {
          void refreshSnapshot();
        }
      }, [refreshSnapshot, snapshot]);

      if (cfg.showComposerBadge === false) return null;

      const tabAdapterId =
        typeof tab.state?.adapterId === 'string' && tab.state.adapterId
          ? tab.state.adapterId
          : BUILTIN_PLUGIN_IDS.AGENT_AGY;
      const proj =
        snapshot?.runtimeAssetsByAdapter?.[tabAdapterId] ??
        snapshot?.runtimeAssetsByAdapter?.[BUILTIN_PLUGIN_IDS.AGENT_AGY];
      const totalTokens = proj ? proj.totals.ruleTokens + proj.totals.skillTokens + proj.totals.mcpTokens : 0;
      const skillCount = proj ? proj.assets.filter((a) => a.kind === 'skill' && a.enabled).length : 0;
      const tabCwd = typeof tab.state?.cwd === 'string' ? tab.state.cwd : undefined;

      return (
        <button
          type="button"
          onClick={() =>
            ctx.workspace.openTab(
              'runtime-assets',
              { cwd: tabCwd, adapterId: tabAdapterId },
              { groupId, split: 'h' }
            )
          }
          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg text-[11px] cursor-pointer transition-colors hover:bg-[var(--surface)]"
          style={{ color: 'var(--muted)' }}
          title="클릭해서 Layer 2 런타임 자산(스킬·규칙·MCP) 인스펙터를 옆 창으로 열기"
        >
          <Layers size={11} />
          <span className="num">
            {proj ? `${fmtKo(totalTokens)} tok · 스킬 ${skillCount}` : '런타임 자산'}
          </span>
        </button>
      );
    };

    // 1) Replaces legacy static Settings tab 6 ('스킬 · 프로젝트') with live Layer 2 inspector
    ctx.slots.register('settings.section', {
      id: 'runtime-context-inspector-section',
      group: '에이전트 · 모델',
      title: '런타임 자산 · 스킬 · MCP',
      description: 'agy CLI의 스킬·규칙·MCP·플러그인 토큰 실측 및 전역 ON/OFF를 관리합니다.',
      icon: Layers,
      order: 25,
      schema: RUNTIME_CONTEXT_INSPECTOR_MANIFEST.configSchema,
      Component: SettingsSectionView,
      searchEntries: [
        {
          id: 'runtime-context-inspector:budget',
          title: '컨텍스트 토큰 예산 (스킬 · 규칙 · MCP)',
          description: '디스크 규칙, 심볼릭 링크 스킬, MCP 캐시 스키마 토큰 실측',
          keywords: '스킬 규칙 mcp 플러그인 컨텍스트 토큰 예산 심볼릭 링크 symlink runtime assets',
        },
        {
          id: 'runtime-context-inspector:toggle',
          title: 'agy CLI 플러그인 · MCP 전역 제어',
          description: 'agy plugin/mcp enable|disable 명령으로 전역 런타임 자산 ON/OFF',
          keywords: 'agy plugin disable enable mcp 토글 전역 제어 커스터마이제이션',
        },
      ],
    });

    // 2) Independent split pane (`runtime-assets`)
    ctx.panes.registerType<{ cwd?: string; adapterId?: string }>({
      type: 'runtime-assets',
      label: '런타임 자산 (스킬·MCP)',
      description: 'Layer 2 스킬·규칙·MCP 토큰 실측 및 제어',
      icon: Layers,
      accentColor: '#10b981',
      keepAlive: 'never',
      showInLauncher: true,
      showInOmnibox: true,
      order: 50,
      createDefaultState: (init) => ({
        title: '런타임 자산',
        state: {
          cwd: typeof init?.cwd === 'string' ? init.cwd : undefined,
          adapterId: typeof init?.adapterId === 'string' ? init.adapterId : undefined,
        },
      }),
      matchOmnibox: (query) => {
        const q = query.trim().toLowerCase();
        if (q === 'skills' || q === 'mcp' || q === 'assets' || q === '스킬' || q === '런타임') {
          return { score: 90, label: '런타임 자산 인스펙터 열기', init: {} };
        }
        return null;
      },
      Component: PaneView,
    });

    // 3) Live badge inside chat composer (`chat:composer-badge`)
    ctx.slots.register('pane.widget', {
      id: 'runtime-context-badge',
      targetPaneType: 'chat',
      anchor: PANE_WIDGET_ANCHORS.CHAT_COMPOSER_BADGE,
      order: 10,
      Component: ComposerRuntimeBadge,
    });

    // 4) Command
    ctx.commands.register({
      id: 'runtime-context-inspector:open',
      title: '런타임 자산 인스펙터 열기',
      run: () => {
        const focused = ctx.workspace.getFocusedTab();
        const cwd = typeof focused?.tab.state?.cwd === 'string' ? focused.tab.state.cwd : undefined;
        ctx.workspace.openTab('runtime-assets', { cwd }, { split: 'h' });
      },
    });
  },
};
