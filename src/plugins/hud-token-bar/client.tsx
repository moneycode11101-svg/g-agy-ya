import React from 'react';
import { EyeOff, Gauge } from 'lucide-react';
import {
  BUILTIN_PLUGIN_IDS,
  PANE_WIDGET_ANCHORS,
  useIntrospectionStore,
  type ClientPluginModule,
  type DeskClientContext,
} from '../../kernel/client';
import { HUD_TOKEN_BAR_MANIFEST, type HudTokenBarConfig } from './manifest';
import { TokenBarWidget } from './TokenBarWidget';

export const hudTokenBarClientPlugin: ClientPluginModule<HudTokenBarConfig> = {
  activate(ctx: DeskClientContext<HudTokenBarConfig>) {
    const BoundTokenBar: React.FC<{ groupId: string; tab: import('../../kernel/client').PaneTabRecord }> = (props) => (
      <TokenBarWidget {...props} ctx={ctx} />
    );

    ctx.slots.register('pane.widget', {
      id: 'token-bar',
      targetPaneType: 'chat',
      anchor: PANE_WIDGET_ANCHORS.CHAT_ABOVE_COMPOSER,
      order: 10,
      Component: BoundTokenBar,
    });

    ctx.slots.register('context-menu.item', {
      id: 'hud-token-bar:toggle',
      target: 'pane-body',
      order: 60,
      resolve: ({ tab }) => {
        if (tab?.paneType !== 'chat') return [];
        return [
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

    ctx.slots.register('settings.section', {
      id: 'hud-token-bar-settings',
      group: '화면 · 채팅',
      title: '토큰 바 HUD',
      description: '입력창 위 실시간 컨텍스트·캐시·할당량 토큰 바 표시 기준을 설정합니다.',
      icon: Gauge,
      order: 35,
      schema: HUD_TOKEN_BAR_MANIFEST.configSchema,
    });
  },
};
