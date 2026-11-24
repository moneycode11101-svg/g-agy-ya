import {
  BUILTIN_PLUGIN_IDS,
  KERNEL_API_VERSION,
  PANE_WIDGET_ANCHORS,
  type PluginManifest,
} from '../../kernel/shared/types';

export interface RuntimeContextInspectorConfig extends Record<string, unknown> {
  showComposerBadge: boolean;
  showBuiltinSkills: boolean;
}

export const RUNTIME_CONTEXT_INSPECTOR_MANIFEST: PluginManifest = {
  id: BUILTIN_PLUGIN_IDS.RUNTIME_CONTEXT_INSPECTOR,
  name: '런타임 자산 · 컨텍스트 인스펙터',
  version: '1.0.0',
  apiVersion: `^${KERNEL_API_VERSION}`,
  description: '기존 정적 스킬 탭을 대체하는 Layer 2 런타임 자산(스킬·규칙·MCP·플러그인) 실측 분석 및 전역 제어 인스펙터',
  layer: 'visual-tool',
  category: 'visual-tool',
  icon: 'layers',
  impactClass: 'instant',
  defaultEnabled: true,
  entry: {
    client: 'builtin:runtime-context-inspector/client',
  },
  optionalRequires: [BUILTIN_PLUGIN_IDS.AGENT_AGY, BUILTIN_PLUGIN_IDS.PANE_CHAT],
  capabilities: [],
  configSchema: [
    {
      key: 'showComposerBadge',
      label: '채팅 입력창 런타임 자산 배지 표시',
      description: '채팅 컴포저 하단에 현재 활성 스킬·규칙·MCP 토큰 요약 칩을 표시합니다.',
      group: '런타임 자산 인스펙터',
      type: 'boolean',
      widget: 'toggle',
      defaultValue: true,
      keywords: ['배지', '컴포저', '런타임 자산', '스킬', '토큰'],
    },
    {
      key: 'showBuiltinSkills',
      label: '내장(builtin) 스킬 표시',
      description: 'agy CLI 기본 내장 스킬을 인스펙터 목록에 함께 표시합니다.',
      group: '런타임 자산 인스펙터',
      type: 'boolean',
      widget: 'toggle',
      defaultValue: true,
      keywords: ['내장 스킬', 'builtin', '스킬', '인스펙터'],
    },
  ],
  contributes: {
    slots: ['settings.section', 'pane.type', 'pane.widget'],
    paneTypes: [{ type: 'runtime-assets', label: '런타임 자산 (스킬·MCP)', icon: 'layers' }],
    commands: [{ id: 'runtime-context-inspector:open', title: '런타임 자산 인스펙터 열기' }],
  },
};

export const RUNTIME_INSPECTOR_BADGE_ANCHOR = PANE_WIDGET_ANCHORS.CHAT_COMPOSER_BADGE;
