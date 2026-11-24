import {
  BUILTIN_PLUGIN_IDS,
  type ConfigFieldSchema,
  type PluginManifest,
} from '../../kernel/shared/types';

export const macosSystemShellConfigSchema: readonly ConfigFieldSchema[] = [
  {
    key: 'keepInMenuBar',
    label: '메뉴 막대(Tray) 상주 유지',
    description: '창 닫기 버튼을 눌러도 앱을 종료하지 않고 macOS 상단 메뉴 막대에 유지합니다.',
    group: 'macOS 시스템 연동',
    type: 'boolean',
    defaultValue: true,
    keywords: ['트레이', '메뉴바', '메뉴 막대', 'tray', 'menubar', '닫기'],
  },
  {
    key: 'preventSleep',
    label: '장기 작업 중 앱 절전 방지',
    description: '에이전트 작업이나 터미널 실행 중 macOS App Nap·절전 진입을 방지합니다.',
    group: 'macOS 시스템 연동',
    type: 'boolean',
    defaultValue: false,
    keywords: ['절전', '잠자기', 'sleep', 'power', 'app nap'],
  },
];

export const macosSystemShellManifest: PluginManifest = {
  id: BUILTIN_PLUGIN_IDS.MACOS_SYSTEM_SHELL,
  name: 'macOS 시스템 셸 · 트레이',
  version: '1.0.0',
  apiVersion: '^1.0.0',
  description: '메뉴 막대 Tray 아이콘 상주, 창 닫기 숨김 가로채기, ref-counted 절전 방지 플러그인',
  layer: 'app',
  category: 'system-ux',
  icon: 'Monitor',
  impactClass: 'instant',
  defaultEnabled: true,
  entry: {
    host: './electron/plugins/macos-system-shell/index.ts',
    client: './src/plugins/macos-system-shell/index.tsx',
  },
  capabilities: ['electron:tray', 'os:power-save'],
  configSchema: macosSystemShellConfigSchema,
  contributes: {
    slots: ['settings.section'],
  },
};
