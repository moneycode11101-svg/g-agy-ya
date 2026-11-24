import { Monitor } from 'lucide-react';
import type { BuiltinPluginPackage, ClientPluginModule } from '../../kernel/client';
import { macosSystemShellConfigSchema, macosSystemShellManifest } from './manifest';

export const macosSystemShellClient: ClientPluginModule = {
  activate(ctx) {
    ctx.slots.register('settings.section', {
      id: 'system-shell',
      group: '알림 · 시스템',
      title: '시스템 · 메뉴 막대',
      description: 'macOS 메뉴 막대 상주 및 작업 중 절전 방지 설정',
      icon: Monitor,
      order: 65,
      schema: macosSystemShellConfigSchema,
    });
  },
};

export const macosSystemShellClientPackage: BuiltinPluginPackage = {
  manifest: macosSystemShellManifest,
  client: macosSystemShellClient,
};
