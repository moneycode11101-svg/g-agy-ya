import {
  BUILTIN_PLUGIN_IDS,
  type ConfigFieldSchema,
  type PluginManifest,
} from '../../kernel/shared/types';

export const notifyFeedbackConfigSchema: readonly ConfigFieldSchema[] = [
  {
    key: 'notificationsEnabled',
    label: '에이전트 완료 OS 알림',
    description: '창이 비활성화된 상태에서 에이전트 응답이 완료되면 시스템 알림을 표시합니다.',
    group: '알림',
    type: 'boolean',
    defaultValue: true,
    keywords: ['알림', '노티', 'os', 'notification'],
  },
  {
    key: 'soundEnabled',
    label: '완료 효과음 재생',
    description: '에이전트 응답 완료 시 부드러운 2음 차임을 재생합니다.',
    group: '사운드',
    type: 'boolean',
    defaultValue: false,
    keywords: ['사운드', '효과음', '소리', 'sound', 'chime'],
  },
  {
    key: 'soundVolume',
    label: '효과음 볼륨',
    description: '완료 효과음의 음량(0~100%)을 조절합니다.',
    group: '사운드',
    type: 'number',
    widget: 'slider',
    defaultValue: 80,
    min: 0,
    max: 100,
    step: 5,
    keywords: ['볼륨', '음량', 'volume', 'sound'],
  },
];

export const notifyFeedbackManifest: PluginManifest = {
  id: BUILTIN_PLUGIN_IDS.NOTIFY_FEEDBACK,
  name: '알림 · 사운드 피드백',
  version: '1.0.0',
  apiVersion: '^1.0.0',
  description: '에이전트 턴 완료 시 macOS 알림과 완료 효과음을 제공하는 이벤트 구독 플러그인',
  layer: 'app',
  category: 'system-ux',
  icon: 'Bell',
  impactClass: 'instant',
  defaultEnabled: true,
  entry: {
    host: './electron/plugins/notify-feedback/index.ts',
    client: './src/plugins/notify-feedback/index.tsx',
  },
  capabilities: ['os:notify'],
  configSchema: notifyFeedbackConfigSchema,
  contributes: {
    slots: ['settings.section'],
  },
};
