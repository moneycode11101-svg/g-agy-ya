import { BUILTIN_PLUGIN_IDS, type PluginManifest } from '../../kernel/shared/types';

export const shortcutsPaletteManifest: PluginManifest = {
  id: BUILTIN_PLUGIN_IDS.SHORTCUTS_PALETTE,
  name: '단축키 · 커맨드 팔레트',
  version: '1.0.0',
  apiVersion: '^1.0.0',
  description: '활성 플러그인의 모든 명령을 실시간 색인하는 ⌘K 커맨드 팔레트 및 동적 단축키 맵',
  layer: 'app',
  category: 'system-ux',
  icon: 'Command',
  impactClass: 'instant',
  defaultEnabled: true,
  entry: {
    client: './src/plugins/shortcuts-palette/index.tsx',
  },
  contributes: {
    slots: ['overlay.layer', 'settings.section'],
    commands: [{ id: 'palette:open', title: '커맨드 팔레트 열기', defaultShortcut: 'Mod+K' }],
  },
};
