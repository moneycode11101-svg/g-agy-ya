import os from 'node:os';
import path from 'node:path';
import {
  BUILTIN_PLUGIN_IDS,
  type BuiltinPluginPackage,
  type ConfigFieldSchema,
  type HostPluginModule,
  type PluginManifest,
} from '../../../src/kernel/shared/types';

export const paneWebviewConfigSchema: readonly ConfigFieldSchema[] = [
  {
    key: 'linkOpenTarget',
    label: '링크 열기 방식',
    description: '채팅·터미널·웹뷰에서 클릭한 링크를 내장 웹뷰로 열지 기본 브라우저로 열지 선택합니다.',
    group: '웹뷰 동작',
    type: 'segmented',
    defaultValue: 'embedded',
    options: [
      { value: 'embedded', label: '내장 웹뷰' },
      { value: 'external', label: '기본 브라우저' },
    ],
    keywords: ['링크', '브라우저', '웹뷰', 'link', 'external', 'embedded'],
  },
  {
    key: 'defaultWebviewUrl',
    label: '새 웹뷰 기본 URL',
    description: '새 웹사이트 탭/분할을 열 때 처음 이동할 주소입니다.',
    group: '웹뷰 동작',
    type: 'string',
    defaultValue: 'http://localhost:5173',
    placeholder: 'http://localhost:5173',
    keywords: ['기본 url', 'localhost', '웹사이트', 'webview'],
  },
  {
    key: 'downloadDir',
    label: '다운로드 저장 폴더',
    description: '내장 웹뷰에서 파일을 내려받을 때 저장할 로컬 경로입니다.',
    group: '웹뷰 동작',
    type: 'path',
    defaultValue: path.join(os.homedir(), 'Downloads'),
    keywords: ['다운로드', '폴더', 'download'],
  },
];

export const paneWebviewManifest: PluginManifest = {
  id: BUILTIN_PLUGIN_IDS.PANE_WEBVIEW,
  name: '내장 웹뷰 (브라우저)',
  version: '1.0.0',
  apiVersion: '^1.0.0',
  description: 'Chromium <webview> 기반 내장 브라우저 패인(비활성 탭 size-0 로그인·상태 보존)',
  layer: 'app',
  category: 'pane',
  icon: 'Globe',
  impactClass: 'stateful-pane',
  defaultEnabled: true,
  entry: {
    host: './electron/plugins/pane-webview/index.ts',
    client: './src/plugins/pane-webview/index.tsx',
  },
  capabilities: ['electron:webview'],
  configSchema: paneWebviewConfigSchema,
  contributes: {
    slots: ['pane.type', 'titlebar.actions', 'sidebar.section', 'settings.section'],
    paneTypes: [{ type: 'webview', label: '웹사이트 (브라우저)', icon: 'Globe' }],
    commands: [
      { id: 'pane-webview:new-tab', title: '새 웹사이트 탭 열기', defaultShortcut: 'Mod+T' },
      { id: 'link:open', title: '링크 열기 (웹뷰/외부)' },
    ],
  },
};

export const paneWebviewHost: HostPluginModule = {
  activate(ctx) {
    // Disposable hooks on KernelWebviewSecurity: disabling plugin preserves kernel default-deny!
    ctx.host.registerWebviewHooks({
      onNewTabRequest: (url) => {
        ctx.bus.publish('pane-webview:new-tab', { url });
      },
      getDownloadDir: () => {
        const configured = ctx.config.getKey('downloadDir');
        return typeof configured === 'string' && configured.trim()
          ? configured
          : path.join(ctx.host.homeDir, 'Downloads');
      },
      getLinkOpenTarget: () => {
        const target = ctx.config.getKey('linkOpenTarget');
        return target === 'external' ? 'external' : 'embedded';
      },
    });

    ctx.rpc.handle('pane-webview:clear-history', async () =>
      ctx.host.clearBrowserPartitionData('persist:agy-desk-browser')
    );
  },
};

export const paneWebviewHostPackage: BuiltinPluginPackage = {
  manifest: paneWebviewManifest,
  host: paneWebviewHost,
};
