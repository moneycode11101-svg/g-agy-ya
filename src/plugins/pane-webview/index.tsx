import React, { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Code2,
  Columns2,
  Copy,
  ExternalLink,
  Globe,
  RotateCw,
  Rows2,
  Trash2,
} from 'lucide-react';
import {
  BUILTIN_PLUGIN_IDS,
  SchemaSettingsForm,
  useLayoutStore,
  usePluginConfigStore,
  type BuiltinPluginPackage,
  type ClientPluginModule,
  type ConfigFieldSchema,
  type DeskClientContext,
  type PaneComponentProps,
  type PluginManifest,
} from '../../kernel/client';

export interface WebviewTabState extends Record<string, unknown> {
  url: string;
  partition: string;
}

interface WebviewElement extends HTMLElement {
  src: string;
  canGoBack: () => boolean;
  canGoForward: () => boolean;
  goBack: () => void;
  goForward: () => void;
  reload: () => void;
  stop: () => void;
  getURL: () => string;
  getTitle: () => string;
  openDevTools: () => void;
  isDevToolsOpened: () => boolean;
  closeDevTools: () => void;
}

export function normalizeWebviewUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return 'about:blank';
  if (/^https?:\/\//i.test(trimmed) || trimmed === 'about:blank') return trimmed;
  if (/^(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(trimmed)) return `http://${trimmed}`;
  if (/^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(trimmed)) return `https://${trimmed}`;
  return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`;
}

function titleFromUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    return u.hostname === 'localhost' || u.hostname === '127.0.0.1'
      ? `${u.hostname}:${u.port || '80'}`
      : u.hostname.replace(/^www\./, '');
  } catch {
    return '브라우저';
  }
}

const configSchema: readonly ConfigFieldSchema[] = [
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
    defaultValue: '',
    keywords: ['다운로드', '폴더', 'download'],
  },
];

export const paneWebviewClientManifest: PluginManifest = {
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
  configSchema,
  contributes: {
    slots: ['pane.type', 'titlebar.actions', 'sidebar.section', 'settings.section'],
    paneTypes: [{ type: 'webview', label: '웹사이트 (브라우저)', icon: 'Globe' }],
    commands: [
      { id: 'pane-webview:new-tab', title: '새 웹사이트 탭 열기', defaultShortcut: 'Mod+T' },
      { id: 'link:open', title: '링크 열기 (웹뷰/외부)' },
    ],
  },
};

function createWebviewComponent(ctx: DeskClientContext): React.FC<PaneComponentProps<WebviewTabState>> {
  return function WebviewPaneView({ groupId, tab, active, updateState, updateTabMeta }) {
    const splitGroup = useLayoutStore((s) => s.splitGroup);
    const closeTab = useLayoutStore((s) => s.closeTab);
    const webviewRef = useRef<WebviewElement | null>(null);
    const initialUrl = typeof tab.state.url === 'string' && tab.state.url ? tab.state.url : 'http://localhost:5173';
    const partition =
      typeof tab.state.partition === 'string' && tab.state.partition.startsWith('persist:agy-desk-')
        ? tab.state.partition
        : 'persist:agy-desk-browser';

    const [urlInput, setUrlInput] = useState(initialUrl);
    const [loading, setLoading] = useState(false);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [canBack, setCanBack] = useState(false);
    const [canFwd, setCanFwd] = useState(false);
    const initialSrcRef = useRef(initialUrl);

    useEffect(() => {
      const wv = webviewRef.current;
      if (!wv) return;

      const syncNav = () => {
        try {
          setCanBack(wv.canGoBack());
          setCanFwd(wv.canGoForward());
          const currentUrl = wv.getURL();
          if (currentUrl && currentUrl !== 'about:blank') {
            setUrlInput(currentUrl);
            updateState({ url: currentUrl });
          }
        } catch {
          // webview not ready yet
        }
      };

      const onStart = () => {
        setLoading(true);
        setLoadError(null);
      };
      const onStop = () => {
        setLoading(false);
        syncNav();
      };
      const onFail = (e: Event) => {
        const ev = e as Event & { errorCode?: number; errorDescription?: string; isMainFrame?: boolean };
        if (ev.isMainFrame !== false && ev.errorCode && ev.errorCode !== -3) {
          setLoading(false);
          setLoadError(ev.errorDescription || `연결 실패 (${ev.errorCode})`);
        }
      };
      const onTitle = (e: Event) => {
        const title = (e as CustomEvent & { title?: string }).title;
        if (title) {
          updateTabMeta({ title: title.length > 26 ? `${title.slice(0, 26)}…` : title });
        }
      };
      const onNavigate = (e: Event) => {
        const nextUrl = (e as Event & { url?: string }).url;
        if (nextUrl) {
          setUrlInput(nextUrl);
          updateState({ url: nextUrl });
        }
        syncNav();
      };

      wv.addEventListener('did-start-loading', onStart);
      wv.addEventListener('did-stop-loading', onStop);
      wv.addEventListener('did-fail-load', onFail);
      wv.addEventListener('page-title-updated', onTitle);
      wv.addEventListener('did-navigate', onNavigate);
      wv.addEventListener('did-navigate-in-page', onNavigate);

      return () => {
        wv.removeEventListener('did-start-loading', onStart);
        wv.removeEventListener('did-stop-loading', onStop);
        wv.removeEventListener('did-fail-load', onFail);
        wv.removeEventListener('page-title-updated', onTitle);
        wv.removeEventListener('did-navigate', onNavigate);
        wv.removeEventListener('did-navigate-in-page', onNavigate);
      };
    }, [updateState, updateTabMeta]);

    const navigate = (raw: string) => {
      const next = normalizeWebviewUrl(raw);
      setLoadError(null);
      setUrlInput(next);
      updateState({ url: next });
      if (webviewRef.current) {
        webviewRef.current.src = next;
      }
    };

    const openExternal = (url: string) => {
      void ctx.rpc.invoke('kernel:shell:open-external', { url }).catch(() => {});
    };

    const toggleDevTools = () => {
      const wv = webviewRef.current;
      if (!wv) return;
      try {
        if (wv.isDevToolsOpened()) wv.closeDevTools();
        else wv.openDevTools();
      } catch {
        // ignore
      }
    };

    const handleContextMenu = (e: React.MouseEvent) => {
      e.preventDefault();
      ctx.ui.showContextMenu(e.clientX, e.clientY, [
        { type: 'item', label: '뒤로', icon: <ArrowLeft size={13} />, disabled: !canBack, onSelect: () => webviewRef.current?.goBack() },
        { type: 'item', label: '앞으로', icon: <ArrowRight size={13} />, disabled: !canFwd, onSelect: () => webviewRef.current?.goForward() },
        { type: 'item', label: '새로고침', icon: <RotateCw size={13} />, onSelect: () => webviewRef.current?.reload() },
        { type: 'separator' },
        { type: 'item', label: '현재 URL 복사', icon: <Copy size={13} />, onSelect: () => void navigator.clipboard.writeText(urlInput) },
        { type: 'item', label: '기본 브라우저에서 열기', icon: <ExternalLink size={13} />, onSelect: () => openExternal(urlInput) },
        { type: 'item', label: '웹뷰 DevTools 토글', icon: <Code2 size={13} />, onSelect: toggleDevTools },
        { type: 'separator' },
        { type: 'item', label: '오른쪽으로 분할', icon: <Columns2 size={13} />, shortcut: '⌘D', onSelect: () => splitGroup(groupId, 'h') },
        { type: 'item', label: '아래로 분할', icon: <Rows2 size={13} />, shortcut: '⌘⇧D', onSelect: () => splitGroup(groupId, 'v') },
        { type: 'separator' },
        { type: 'item', label: '브라우저 탭 닫기', icon: <Trash2 size={13} />, danger: true, onSelect: () => void closeTab(groupId, tab.id) },
      ]);
    };

    return (
      <div
        className={
          active
            ? 'flex-1 min-h-0 flex flex-col @container'
            : 'pointer-events-none absolute size-0 overflow-hidden opacity-0'
        }
        aria-hidden={!active}
        onContextMenu={handleContextMenu}
      >
        <div
          className="h-9 shrink-0 px-2 border-b flex items-center gap-1.5 text-xs"
          style={{ background: 'var(--card)', borderColor: 'var(--border)' }}
        >
          <button
            type="button"
            disabled={!canBack}
            onClick={() => webviewRef.current?.goBack()}
            className="p-1 rounded hover:opacity-80 disabled:opacity-30 cursor-pointer"
            title="뒤로"
          >
            <ArrowLeft size={13} />
          </button>
          <button
            type="button"
            disabled={!canFwd}
            onClick={() => webviewRef.current?.goForward()}
            className="p-1 rounded hover:opacity-80 disabled:opacity-30 cursor-pointer"
            title="앞으로"
          >
            <ArrowRight size={13} />
          </button>
          <button
            type="button"
            onClick={() => (loading ? webviewRef.current?.stop() : webviewRef.current?.reload())}
            className="p-1 rounded hover:opacity-80 cursor-pointer"
            title="새로고침"
          >
            <RotateCw size={13} className={loading ? 'animate-spin' : ''} />
          </button>

          <form
            className="flex-1 flex items-center"
            onSubmit={(e) => {
              e.preventDefault();
              navigate(urlInput);
            }}
          >
            <input
              type="text"
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              placeholder="URL 또는 localhost:5173 입력..."
              className="w-full px-2.5 py-1 rounded-md border text-xs font-mono outline-none"
              style={{ background: 'var(--bg)', borderColor: 'var(--border)', color: 'var(--fg)' }}
            />
          </form>

          <div className="hidden @[440px]:flex items-center gap-1">
            {[
              ['3000', 'http://localhost:3000'],
              ['5173', 'http://localhost:5173'],
            ].map(([lbl, u]) => (
              <button
                key={lbl}
                type="button"
                onClick={() => navigate(u)}
                className="px-1.5 py-0.5 rounded border text-[10px] font-mono cursor-pointer hover:opacity-80"
                style={{ borderColor: 'var(--border)', color: 'var(--muted)' }}
                title={u}
              >
                :{lbl}
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={toggleDevTools}
            className="p-1 rounded hover:opacity-80 cursor-pointer"
            style={{ color: 'var(--muted)' }}
            title="웹뷰 DevTools 토글"
          >
            <Code2 size={13} />
          </button>
          <button
            type="button"
            onClick={() => openExternal(urlInput)}
            className="p-1 rounded hover:opacity-80 cursor-pointer"
            style={{ color: 'var(--muted)' }}
            title="기본 브라우저에서 열기"
          >
            <ExternalLink size={13} />
          </button>
        </div>

        <div className="flex-1 min-h-0 relative" style={{ background: 'var(--bg)' }}>
          {React.createElement('webview', {
            ref: (el: HTMLElement | null) => {
              webviewRef.current = el as WebviewElement | null;
            },
            src: initialSrcRef.current,
            partition,
            style: { display: 'flex', width: '100%', height: '100%' },
          })}

          {loadError && (
            <div
              className="absolute inset-0 flex flex-col items-center justify-center p-6 text-center gap-3"
              style={{ background: 'var(--bg)' }}
            >
              <div className="text-sm font-semibold">{urlInput} 에 연결할 수 없습니다</div>
              <div className="text-xs max-w-xs" style={{ color: 'var(--muted)' }}>
                로컬 개발 서버를 실행하거나 아래 바로가기 / 주소창에 원하는 사이트를 입력하세요. ({loadError})
              </div>
              <div className="flex flex-wrap justify-center gap-1.5 pt-1 text-xs">
                {[
                  ['localhost:3000', 'http://localhost:3000'],
                  ['localhost:5173', 'http://localhost:5173'],
                  ['GitHub', 'https://github.com'],
                  ['Google', 'https://www.google.com'],
                ].map(([lbl, u]) => (
                  <button
                    key={lbl}
                    type="button"
                    onClick={() => navigate(u)}
                    className="px-3 py-1.5 rounded-lg border cursor-pointer hover:opacity-80"
                    style={{ background: 'var(--card)', borderColor: 'var(--border)', color: 'var(--fg)' }}
                  >
                    {lbl}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    );
  };
}

export const paneWebviewClient: ClientPluginModule = {
  activate(ctx) {
    const getDefaultUrl = () => {
      const cfg = ctx.config.get();
      return typeof cfg.defaultWebviewUrl === 'string' && cfg.defaultWebviewUrl.trim()
        ? cfg.defaultWebviewUrl
        : 'http://localhost:5173';
    };

    const openUrlInWebviewTab = (rawUrl: string) => {
      const url = normalizeWebviewUrl(rawUrl);
      const layout = useLayoutStore.getState();
      const webGroup = Object.values(layout.groups).find((g) => g.tabs.some((t) => t.paneType === 'webview'));
      if (webGroup) {
        layout.addTabToGroup(webGroup.id, 'webview', { url });
      } else {
        layout.splitGroup(layout.focusedGroupId, 'h', 'webview', { url });
      }
    };

    ctx.panes.registerType<WebviewTabState>({
      type: 'webview',
      label: '웹사이트 (브라우저)',
      description: '내장 Chromium 웹뷰',
      icon: Globe,
      accentColor: '#a855f7',
      shortcut: '⌘T',
      keepAlive: 'group',
      showInLauncher: true,
      showInOmnibox: true,
      order: 30,
      createDefaultState: (init) => {
        const targetUrl =
          typeof init?.url === 'string' && init.url.trim() ? normalizeWebviewUrl(init.url) : getDefaultUrl();
        const title = typeof init?.title === 'string' && init.title ? init.title : titleFromUrl(targetUrl);
        return {
          title,
          state: { url: targetUrl, partition: 'persist:agy-desk-browser' },
        };
      },
      matchOmnibox: (query) => {
        const q = query.trim();
        if (!q) return null;
        if (/^(https?:\/\/|localhost|127\.0\.0\.1|[\w-]+\.[a-z]{2,})/i.test(q)) {
          return { score: 95, label: `웹사이트 열기: ${q}`, init: { url: normalizeWebviewUrl(q) } };
        }
        if (/^(web|webview|browser|웹|브라우저)$/i.test(q)) {
          return { score: 85, label: '새 웹사이트 (브라우저)', init: { url: getDefaultUrl() } };
        }
        return null;
      },
      Component: createWebviewComponent(ctx),
    });

    // Listen for Host new-tab events from webview window.open / context-menu
    ctx.bus.subscribe<{ url?: string }>('pane-webview:new-tab', (env) => {
      if (env.payload?.url) {
        openUrlInWebviewTab(env.payload.url);
      }
    });

    // Global `link:open` command (when pane-webview is OFF, callers fall back to kernel:shell:open-external)
    ctx.commands.register({
      id: 'link:open',
      title: '링크 열기 (웹뷰/외부)',
      run: async (args) => {
        const url = typeof args === 'string' ? args : (args as { url?: string } | undefined)?.url;
        if (!url) return;
        const target = ctx.config.getKey('linkOpenTarget');
        if (target === 'external') {
          await ctx.rpc.invoke('kernel:shell:open-external', { url });
        } else {
          openUrlInWebviewTab(url);
        }
      },
    });

    ctx.commands.register({
      id: 'pane-webview:new-tab',
      title: '새 웹사이트 탭 열기',
      shortcut: 'Mod+T',
      run: () => {
        ctx.workspace.openTab('webview', { url: getDefaultUrl() });
      },
    });

    ctx.slots.register('titlebar.actions', {
      id: 'quick-split',
      zone: 'right',
      order: 20,
      Component: () => (
        <button
          type="button"
          onClick={() => ctx.workspace.openTab('webview', { url: getDefaultUrl() }, { split: 'h' })}
          className="p-1.5 rounded-lg hover:bg-[var(--surface)] cursor-pointer transition-colors"
          style={{ color: 'var(--muted)' }}
          title="옆에 웹뷰 분할 열기 (⌘T)"
        >
          <Globe size={15} />
        </button>
      ),
    });

    ctx.slots.register('sidebar.section', {
      id: 'quick-webview',
      zone: 'top',
      order: 30,
      Component: () => (
        <button
          type="button"
          onClick={() => ctx.workspace.openTab('webview', { url: getDefaultUrl() }, { split: 'h' })}
          className="w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg text-[13px] cursor-pointer transition-colors hover:bg-[var(--surface-active)]"
          style={{ color: 'var(--fg-soft)' }}
        >
          <Globe size={14} style={{ color: 'var(--muted)' }} />
          <span>웹뷰 분할</span>
        </button>
      ),
    });

    const WebviewSettingsPanel: React.FC = () => {
      const values = usePluginConfigStore((s) => s.configsByPlugin[BUILTIN_PLUGIN_IDS.PANE_WEBVIEW] || {});
      const [clearing, setClearing] = useState(false);
      return (
        <div className="space-y-4">
          <SchemaSettingsForm
            schema={configSchema}
            values={values}
            onChange={(patch) => void ctx.config.set(patch)}
            onPickDirectory={() => ctx.rpc.invoke<string | null>('kernel:dialog:pick-dir')}
          />
          <div
            className="rounded-xl border px-4 py-3 flex items-center justify-between gap-3"
            style={{ background: 'var(--card)', borderColor: 'var(--border)' }}
          >
            <div>
              <div className="text-[12.5px] font-medium" style={{ color: 'var(--fg)' }}>
                내장 브라우저 캐시 비우기
              </div>
              <div className="text-[11.5px]" style={{ color: 'var(--muted)' }}>
                로그인 쿠키는 유지하고 캐시·서비스워커만 정리합니다.
              </div>
            </div>
            <button
              type="button"
              disabled={clearing}
              onClick={async () => {
                setClearing(true);
                try {
                  const ok = await ctx.rpc.invoke<boolean>('pane-webview:clear-history');
                  ctx.ui.toast(ok ? '내장 브라우저 캐시를 비웠습니다.' : '캐시 정리에 실패했습니다.', ok ? 'info' : 'error');
                } finally {
                  setClearing(false);
                }
              }}
              className="px-3 py-1.5 rounded-xl border text-[12px] font-medium cursor-pointer hover:bg-[var(--surface)]"
              style={{ borderColor: 'var(--border)', color: 'var(--fg)' }}
            >
              {clearing ? '정리 중...' : '캐시 비우기'}
            </button>
          </div>
        </div>
      );
    };

    ctx.slots.register('settings.section', {
      id: 'webview',
      group: '작업 도구',
      title: '웹뷰 · 브라우저',
      description: '내장 웹뷰 기본 주소, 링크 열기 방식, 다운로드 폴더 설정',
      icon: Globe,
      order: 40,
      schema: configSchema,
      Component: WebviewSettingsPanel,
      searchEntries: [
        {
          id: 'pane-webview:clear-cache',
          title: '내장 브라우저 캐시 비우기',
          description: '캐시와 서비스워커 정리',
          keywords: '캐시 비우기 웹뷰 브라우저 cache history',
        },
      ],
    });
  },
};

export const paneWebviewClientPackage: BuiltinPluginPackage = {
  manifest: paneWebviewClientManifest,
  client: paneWebviewClient,
};
