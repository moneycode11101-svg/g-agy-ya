import React from 'react';
import { FolderKanban } from 'lucide-react';
import type { ClientPluginModule, DeskClientContext } from '../../kernel/shared/types';
import { SIDEBAR_WORKSPACE_MANIFEST, type SidebarWorkspaceConfig } from './manifest';
import { SidebarWorkspaceView } from './SidebarWorkspaceView';

export const sidebarWorkspaceClientPlugin: ClientPluginModule<SidebarWorkspaceConfig> = {
  activate(ctx: DeskClientContext<SidebarWorkspaceConfig>) {
    const BoundSidebar: React.FC = () => <SidebarWorkspaceView ctx={ctx} />;

    ctx.slots.register('sidebar.section', {
      id: 'sidebar-workspace:body',
      zone: 'body',
      title: '워크스페이스 · 대화',
      order: 20,
      Component: BoundSidebar,
    });

    ctx.slots.register('settings.section', {
      id: 'sidebar-workspace-settings',
      group: '일반 · 입력',
      title: '사이드바 · 프로젝트 폴더',
      description: '사이드바에 고정할 프로젝트 폴더 목록과 최근 대화 표시 개수를 관리합니다.',
      icon: FolderKanban,
      order: 15,
      schema: SIDEBAR_WORKSPACE_MANIFEST.configSchema,
    });
  },
};
