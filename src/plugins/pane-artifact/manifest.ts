import { BUILTIN_PLUGIN_IDS, type PluginManifest } from '../../kernel/shared/types';

export const paneArtifactManifest: PluginManifest = {
  id: BUILTIN_PLUGIN_IDS.PANE_ARTIFACT,
  name: '아티팩트 · 파일 뷰어',
  version: '1.0.0',
  apiVersion: '^1.0.0',
  description: '채팅의 아티팩트(.md) 및 로컬 문서·코드 링크를 외부 앱 대신 앱 안 우측 분할 패널에서 미리보기·실시간 갱신으로 열어주는 뷰어',
  layer: 'app',
  category: 'pane',
  icon: 'FileText',
  impactClass: 'instant',
  defaultEnabled: true,
  entry: {
    host: './electron/plugins/pane-artifact/index.ts',
    client: './src/plugins/pane-artifact/index.tsx',
  },
  capabilities: ['fs:read'],
  contributes: {
    slots: ['pane.type'],
    paneTypes: [{ type: 'artifact', label: '아티팩트 뷰어', icon: 'FileText' }],
  },
};
