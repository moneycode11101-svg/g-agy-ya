import React, { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Code2,
  Columns2,
  Copy,
  ExternalLink,
  RotateCw,
  Rows2,
  Trash2,
} from 'lucide-react';
import type { WebviewPaneTab } from '../shared/types';
import { useContextMenuStore } from '../store/contextMenuStore';
import { useWorkspaceStore } from '../store/workspaceStore';

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

function normalizeUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return 'about:blank';
  if (/^https?:\/\//i.test(trimmed) || trimmed === 'about:blank') return trimmed;
  if (/^(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(trimmed)) return `http://${trimmed}`;
  if (/^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(trimmed)) return `https://${trimmed}`;
  return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`;
}

interface WebviewPaneProps {
  groupId: string;
  tab: WebviewPaneTab;
  active: boolean;
}

export const WebviewPane: React.FC<WebviewPaneProps> = ({ groupId, tab, active }) => {
  const updateTab = useWorkspaceStore((s) => s.updateTab);
  const splitGroup = useWorkspaceStore((s) => s.splitGroup);
  const closeTab = useWorkspaceStore((s) => s.closeTab);
  const showMenu = useContextMenuStore((s) => s.showMenu);
  const webviewRef = useRef<WebviewElement | null>(null);
  const [urlInput, setUrlInput] = useState(tab.url);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [canBack, setCanBack] = useState(false);
  const [canFwd, setCanFwd] = useState(false);
  const initialSrcRef = useRef(tab.url);

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
          updateTab(groupId, tab.id, { url: currentUrl });
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
        updateTab(groupId, tab.id, { title: title.length > 26 ? title.slice(0, 26) + '…' : title });
      }
    };
    const onNavigate = (e: Event) => {
      const nextUrl = (e as Event & { url?: string }).url;
      if (nextUrl) {
        setUrlInput(nextUrl);
        updateTab(groupId, tab.id, { url: nextUrl });
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
  }, [groupId, tab.id, updateTab]);

  const navigate = (raw: string) => {
    const next = normalizeUrl(raw);
    setLoadError(null);
    setUrlInput(next);
    updateTab(groupId, tab.id, { url: next });
    if (webviewRef.current) {
      webviewRef.current.src = next;
    }
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    showMenu(e.clientX, e.clientY, [
      {
        type: 'item',
        label: '뒤로',
        icon: <ArrowLeft size={13} />,
        disabled: !canBack,
        onSelect: () => webviewRef.current?.goBack(),
      },
      {
        type: 'item',
        label: '앞으로',
        icon: <ArrowRight size={13} />,
        disabled: !canFwd,
        onSelect: () => webviewRef.current?.goForward(),
      },
      {
        type: 'item',
        label: '새로고침',
        icon: <RotateCw size={13} />,
        onSelect: () => webviewRef.current?.reload(),
      },
      { type: 'separator' },
      {
        type: 'item',
        label: '현재 URL 복사',
        icon: <Copy size={13} />,
        onSelect: () => void navigator.clipboard.writeText(urlInput),
      },
      {
        type: 'item',
        label: '기본 브라우저에서 열기',
        icon: <ExternalLink size={13} />,
        onSelect: () => void window.agyDesk?.openExternal(urlInput),
      },
      {
        type: 'item',
        label: '웹뷰 DevTools 토글',
        icon: <Code2 size={13} />,
        onSelect: () => {
          const wv = webviewRef.current;
          if (!wv) return;
          try {
            if (wv.isDevToolsOpened()) wv.closeDevTools();
            else wv.openDevTools();
          } catch {
            // ignore
          }
        },
      },
      { type: 'separator' },
      {
        type: 'item',
        label: '오른쪽으로 분할 (새 창 선택)',
        icon: <Columns2 size={13} />,
        shortcut: '⌘D',
        onSelect: () => splitGroup(groupId, 'h', 'launcher'),
      },
      {
        type: 'item',
        label: '아래로 분할 (새 창 선택)',
        icon: <Rows2 size={13} />,
        shortcut: '⌘⇧D',
        onSelect: () => splitGroup(groupId, 'v', 'launcher'),
      },
      { type: 'separator' },
      {
        type: 'item',
        label: '브라우저 탭 닫기',
        icon: <Trash2 size={13} />,
        danger: true,
        onSelect: () => closeTab(groupId, tab.id),
      },
    ]);
  };

  // Orca trick: keep inactive <webview> mounted at size-0 so login, scroll & app state survive tab switching
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
      {/* 브라우저 주소창 툴바 */}
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
            style={{
              background: 'var(--bg)',
              borderColor: 'var(--border)',
              color: 'var(--fg)',
            }}
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
          onClick={() => {
            const wv = webviewRef.current;
            if (!wv) return;
            try {
              if (wv.isDevToolsOpened()) wv.closeDevTools();
              else wv.openDevTools();
            } catch {
              // ignore
            }
          }}
          className="p-1 rounded hover:opacity-80 cursor-pointer"
          style={{ color: 'var(--muted)' }}
          title="웹뷰 DevTools 토글"
        >
          <Code2 size={13} />
        </button>
        <button
          type="button"
          onClick={() => void window.agyDesk?.openExternal(urlInput)}
          className="p-1 rounded hover:opacity-80 cursor-pointer"
          style={{ color: 'var(--muted)' }}
          title="기본 브라우저에서 열기"
        >
          <ExternalLink size={13} />
        </button>
      </div>

      {/* 실제 Chromium <webview> DOM 엘리먼트 */}
      <div className="flex-1 min-h-0 relative" style={{ background: 'var(--bg)' }}>
        {React.createElement('webview', {
          ref: (el: HTMLElement | null) => {
            webviewRef.current = el as WebviewElement | null;
          },
          src: initialSrcRef.current,
          partition: tab.partition,
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
