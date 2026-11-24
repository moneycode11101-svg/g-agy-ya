import { BUILTIN_PLUGIN_IDS, type PluginManifest } from '../../kernel/shared/types';

export const paneLauncherManifest: PluginManifest = {
  id: BUILTIN_PLUGIN_IDS.PANE_LAUNCHER,
  name: '분할 창 런처',
  version: '1.0.0',
  apiVersion: '^1.0.0',
  description: '활성화된 모든 패인 플러그인을 동적으로 나열·검색하는 새 분할 창 런처',
  layer: 'app',
  category: 'pane',
  icon: 'LayoutGrid',
  impactClass: 'instant',
  defaultEnabled: true,
  entry: {
    client: './src/plugins/pane-launcher/index.tsx',
  },
  contributes: {
    slots: ['pane.type', 'titlebar.actions'],
    paneTypes: [{ type: 'launcher', label: '새 창 선택', icon: 'LayoutGrid' }],
    commands: [
      { id: 'pane-launcher:split-right', title: '오른쪽으로 분할 (새 창 선택)', defaultShortcut: 'Mod+D' },
      { id: 'pane-launcher:split-down', title: '아래로 분할 (새 창 선택)', defaultShortcut: 'Mod+Shift+D' },
    ],
  },
};
