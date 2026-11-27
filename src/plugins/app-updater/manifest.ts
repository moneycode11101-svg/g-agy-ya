import {
  BUILTIN_PLUGIN_IDS,
  KERNEL_API_VERSION,
  type PluginManifest,
} from '../../kernel/shared/types';

export const appUpdaterManifest: PluginManifest = {
  id: BUILTIN_PLUGIN_IDS.APP_UPDATER,
  name: '앱 업데이트 · 패치 알림',
  version: '1.0.0',
  apiVersion: `^${KERNEL_API_VERSION}`,
  description:
    'GitHub 최신 패치와 릴리즈를 자동 확인하고, git clone 환경에서는 원클릭 업데이트(pull · 빌드 · 재시작)를 지원합니다.',
  layer: 'app',
  category: 'system-ux',
  icon: 'download',
  impactClass: 'instant',
  defaultEnabled: true,
  entry: {
    host: 'builtin:app-updater/host',
    client: 'builtin:app-updater/client',
  },
  capabilities: ['process:spawn', 'net:fetch', 'fs:read'],
  configSchema: [
    {
      key: 'autoCheckOnStart',
      label: '앱 시작 시 새 패치 자동 확인',
      description: '실행 직후 백그라운드에서 GitHub 최신 커밋/릴리즈와 비교합니다 (개인정보 전송 0%).',
      group: '앱 업데이트',
      type: 'boolean',
      widget: 'toggle',
      defaultValue: true,
      keywords: ['업데이트', '패치', '자동 확인', 'update', 'github'],
    },
    {
      key: 'checkIntervalMinutes',
      label: '주기적 업데이트 확인 간격 (분)',
      description: '0으로 두면 자동 주기 확인을 끄고 수동 확인만 사용합니다.',
      group: '앱 업데이트',
      type: 'number',
      widget: 'slider',
      defaultValue: 60,
      min: 0,
      max: 360,
      step: 30,
      keywords: ['업데이트', '주기', '간격', 'interval'],
    },
    {
      key: 'repoSlug',
      label: '업데이트 확인 GitHub 저장소',
      description: 'owner/repo 형식으로 지정합니다.',
      group: '앱 업데이트',
      type: 'string',
      widget: 'text',
      defaultValue: 'moneycode11101-svg/g-agy-ya',
      keywords: ['github', 'repo', '저장소', '업데이트'],
    },
    {
      key: 'branch',
      label: '추적 브랜치',
      description: 'git clone 환경에서 패치를 비교·적용할 기본 브랜치입니다.',
      group: '앱 업데이트',
      type: 'string',
      widget: 'text',
      defaultValue: 'main',
      keywords: ['branch', 'main', '브랜치', '업데이트'],
    },
  ],
  contributes: {
    slots: ['titlebar.actions', 'settings.section'],
    commands: [
      {
        id: 'app-updater:check',
        title: '앱 업데이트 지금 확인',
      },
    ],
  },
};
