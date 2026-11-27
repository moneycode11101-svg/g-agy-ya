import {
  BUILTIN_PLUGIN_IDS,
  KERNEL_API_VERSION,
  PANE_WIDGET_ANCHORS,
  type PluginManifest,
} from '../../kernel/shared/types';

export interface HudTokenBarConfig extends Record<string, unknown> {
  newRoomWarnPct: number;
  forceCompact: boolean;
}

export const HUD_TOKEN_BAR_MANIFEST: PluginManifest = {
  id: BUILTIN_PLUGIN_IDS.HUD_TOKEN_BAR,
  name: '토큰 밴드 · 실시간 할당량 HUD',
  version: '2.0.0',
  apiVersion: `^${KERNEL_API_VERSION}`,
  description:
    '채팅 입력창 위 엔진·모델 1:1 로컬 토큰 바 HUD + 3사(반중력·Claude·Codex) 통합 전역 토큰 밴드 대시보드 페이지',
  layer: 'app',
  category: 'chat-widget',
  icon: 'gauge',
  impactClass: 'instant',
  defaultEnabled: true,
  entry: {
    client: 'builtin:hud-token-bar/client',
  },
  optionalRequires: [
    BUILTIN_PLUGIN_IDS.PANE_CHAT,
    BUILTIN_PLUGIN_IDS.AGENT_AGY,
    BUILTIN_PLUGIN_IDS.AGENT_CLAUDE,
    BUILTIN_PLUGIN_IDS.AGENT_CODEX,
  ],
  capabilities: [],
  configSchema: [
    {
      key: 'newRoomWarnPct',
      label: '새 방 권장 경고 기준 (%)',
      description: '컨텍스트 사용률이 이 비율을 넘으면 토큰 바에 "새 방 권장"을 강조합니다.',
      group: '토큰 바 HUD',
      type: 'number',
      widget: 'slider',
      defaultValue: 35,
      min: 15,
      max: 80,
      step: 5,
      keywords: ['새 방 권장', '임계치', '컨텍스트', '경고', '퍼센트', '토큰 바'],
    },
    {
      key: 'forceCompact',
      label: '항상 1줄 초슬림 HUD 사용',
      description: '넓은 창에서도 4칸 카드 대신 1줄 컴팩트 토큰 바를 유지합니다.',
      group: '토큰 바 HUD',
      type: 'boolean',
      widget: 'toggle',
      defaultValue: false,
      keywords: ['컴팩트', '슬림', '1줄', '토큰 바', 'token bar'],
    },
  ],
  contributes: {
    slots: [
      'pane.widget',
      'pane.type',
      'sidebar.section',
      'titlebar.actions',
      'context-menu.item',
      'settings.section',
    ],
    paneTypes: [
      {
        type: 'token-band',
        label: '토큰 밴드',
        icon: 'gauge',
      },
    ],
    commands: [
      {
        id: 'hud-token-bar:open-global',
        title: '토큰 밴드 통합 보드 열기',
        defaultShortcut: 'Mod+Shift+U',
      },
    ],
  },
};

export const HUD_TOKEN_BAR_ANCHOR = PANE_WIDGET_ANCHORS.CHAT_ABOVE_COMPOSER;
