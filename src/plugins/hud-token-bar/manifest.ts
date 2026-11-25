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
  name: '실시간 토큰 · 캐시 · 할당량 HUD',
  version: '1.0.0',
  apiVersion: `^${KERNEL_API_VERSION}`,
  description: '채팅 입력창 위 4칸/1줄 초슬림 토큰 바 및 도구별 증가·최근 턴·계정 할당량 드로어 (끄면 토큰 바만 즉시 숨김)',
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
    slots: ['pane.widget', 'context-menu.item', 'settings.section'],
  },
};

export const HUD_TOKEN_BAR_ANCHOR = PANE_WIDGET_ANCHORS.CHAT_ABOVE_COMPOSER;
