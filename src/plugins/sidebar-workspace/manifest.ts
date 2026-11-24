import { BUILTIN_PLUGIN_IDS, KERNEL_API_VERSION, type PluginManifest } from '../../kernel/shared/types';

export interface SidebarWorkspaceConfig extends Record<string, unknown> {
  projectFolders: string[];
  sessionLimit: number;
}

export const SIDEBAR_WORKSPACE_MANIFEST: PluginManifest = {
  id: BUILTIN_PLUGIN_IDS.SIDEBAR_WORKSPACE,
  name: '사이드바 세션 · 프로젝트 탐색기',
  version: '1.0.0',
  apiVersion: `^${KERNEL_API_VERSION}`,
  description: '좌측 사이드바의 + 새 대화, 프로젝트 폴더 그룹(인라인 추가/제거), 최근 대화 목록 제공',
  layer: 'app',
  category: 'system-ux',
  icon: 'folder-kanban',
  impactClass: 'instant',
  defaultEnabled: true,
  entry: {
    host: 'builtin:sidebar-workspace/host',
    client: 'builtin:sidebar-workspace/client',
  },
  optionalRequires: [BUILTIN_PLUGIN_IDS.AGENT_AGY, BUILTIN_PLUGIN_IDS.PANE_CHAT],
  capabilities: [],
  configSchema: [
    {
      key: 'projectFolders',
      label: '등록된 프로젝트 폴더',
      description: '사이드바에서 프로젝트별로 대화를 묶어 표시할 폴더 경로 목록입니다. 사이드바의 + 버튼으로도 바로 관리할 수 있습니다.',
      group: '프로젝트 탐색기',
      type: 'string-list',
      widget: 'tags',
      defaultValue: [],
      placeholder: '/Users/.../my-project',
      keywords: ['프로젝트', '폴더', '워크스페이스', '사이드바', 'projectFolders'],
    },
    {
      key: 'sessionLimit',
      label: '표시할 최근 대화 수',
      description: '사이드바에 불러올 최근 대화 세션의 최대 개수입니다.',
      group: '프로젝트 탐색기',
      type: 'number',
      widget: 'slider',
      defaultValue: 40,
      min: 10,
      max: 100,
      step: 10,
      keywords: ['최근 대화', '세션 수', '목록', 'limit'],
    },
  ],
  contributes: {
    slots: ['sidebar.section', 'settings.section'],
  },
};
