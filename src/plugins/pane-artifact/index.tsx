import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  Code2,
  Columns2,
  Copy,
  ExternalLink,
  Eye,
  FileText,
  FolderOpen,
  RotateCw,
  Rows2,
  Trash2,
} from 'lucide-react';
import {
  getDeskKernelBridge,
  useLayoutStore,
  type BuiltinPluginPackage,
  type ClientPluginModule,
  type DeskClientContext,
  type PaneComponentProps,
} from '../../kernel/client';
import { InlineImageLightbox } from '../pane-chat/AssistantTurnView';
import { isRenderableLocalImagePath, renderSanitizedMarkdown } from '../pane-chat/sanitizeMarkdown';
import { paneArtifactManifest } from './manifest';
import { isArtifactPreviewablePath, openLocalArtifactInPane, parseLineRange } from './openArtifact';

export interface ArtifactTabState extends Record<string, unknown> {
  filePath?: string;
  lineStart?: number;
  lineEnd?: number;
  focusToken?: number;
  viewMode?: 'preview' | 'source';
}

interface ArtifactFileSnapshot {
  ok: boolean;
  filePath: string;
  fileName: string;
  dirPath: string;
  ext: string;
  content?: string;
  size?: number;
  mtimeMs?: number;
  isMarkdown?: boolean;
  isBinary?: boolean;
  tooLarge?: boolean;
  error?: string;
}

function shortenPath(p: string): string {
  const parts = p.split('/').filter(Boolean);
  if (parts.length <= 3) return p;
  return `…/${parts.slice(-3, -1).join('/')}`;
}

function formatBytes(bytes?: number): string {
  if (bytes == null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function createArtifactComponent(ctx: DeskClientContext): React.FC<PaneComponentProps<ArtifactTabState>> {
  return function ArtifactPaneView({ groupId, tab, updateState }) {
    const splitGroup = useLayoutStore((s) => s.splitGroup);
    const closeTab = useLayoutStore((s) => s.closeTab);

    const filePath = typeof tab.state.filePath === 'string' ? tab.state.filePath : '';
    const lineStart = typeof tab.state.lineStart === 'number' ? tab.state.lineStart : undefined;
    const lineEnd = typeof tab.state.lineEnd === 'number' ? tab.state.lineEnd : lineStart;
    const focusToken = typeof tab.state.focusToken === 'number' ? tab.state.focusToken : 0;
    const savedMode = tab.state.viewMode === 'source' ? 'source' : 'preview';

    const [snap, setSnap] = useState<ArtifactFileSnapshot | null>(null);
    const [loading, setLoading] = useState(false);
    const [copied, setCopied] = useState(false);
    const [lightbox, setLightbox] = useState<{ src: string; alt?: string; localPath?: string } | null>(null);
    const sourceContainerRef = useRef<HTMLDivElement | null>(null);

    const isMarkdown = Boolean(snap?.isMarkdown);
    const effectiveMode: 'preview' | 'source' = isMarkdown && !lineStart ? savedMode : isMarkdown ? savedMode : 'source';

    const loadFile = useCallback(async (target: string) => {
      if (!target) {
        setSnap(null);
        return;
      }
      setLoading(true);
      try {
        const res = await ctx.rpc.invoke<ArtifactFileSnapshot>('pane-artifact:read-file', { filePath: target });
        setSnap(res);
      } catch (err) {
        setSnap({
          ok: false,
          filePath: target,
          fileName: target.split('/').pop() || target,
          dirPath: '',
          ext: '',
          error: err instanceof Error ? err.message : '파일을 불러오지 못했습니다.',
        });
      } finally {
        setLoading(false);
      }
    }, []);

    useEffect(() => {
      void loadFile(filePath);
    }, [filePath, loadFile]);

    // Live auto-reload when agent edits this artifact on disk
    useEffect(() => {
      if (!filePath) return;
      const watchId = `art-${tab.id}`;
      void ctx.rpc.invoke('pane-artifact:watch', { watchId, filePath }).catch(() => {});
      const unsub = ctx.bus.subscribe<{ watchId?: string; filePath?: string }>('pane-artifact:changed', (env) => {
        if (env.payload?.watchId === watchId) {
          void loadFile(filePath);
        }
      });
      return () => {
        unsub();
        void ctx.rpc.invoke('pane-artifact:unwatch', { watchId }).catch(() => {});
      };
    }, [filePath, loadFile, tab.id]);

    // Switch to source view automatically when explicitly navigating to a `#L10-L20` line range
    useEffect(() => {
      if (lineStart != null && focusToken > 0 && isMarkdown && savedMode === 'preview') {
        updateState({ viewMode: 'source' });
      }
    }, [focusToken, isMarkdown, lineStart, savedMode, updateState]);

    // Scroll highlighted line range into view
    useEffect(() => {
      if (effectiveMode !== 'source' || lineStart == null || !snap?.ok) return;
      const el = sourceContainerRef.current?.querySelector(`[data-line-no="${lineStart}"]`) as HTMLElement | null;
      if (el) {
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    }, [effectiveMode, focusToken, lineStart, snap?.ok, snap?.content]);

    const renderedHtml = useMemo(() => {
      if (!snap?.ok || !snap.isMarkdown || !snap.content) return '';
      return renderSanitizedMarkdown(snap.content, snap.dirPath || undefined);
    }, [snap?.content, snap?.dirPath, snap?.isMarkdown, snap?.ok]);

    const sourceLines = useMemo(() => {
      if (!snap?.ok || typeof snap.content !== 'string') return [];
      return snap.content.split('\n');
    }, [snap?.content, snap?.ok]);

    const handleCopy = () => {
      if (!snap?.content) return;
      void navigator.clipboard.writeText(snap.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    };

    const handleOpenExternal = () => {
      if (!filePath) return;
      void getDeskKernelBridge()?.rpc.invoke('kernel:shell:open-path', { targetPath: filePath });
    };

    const handleRevealFinder = () => {
      if (!filePath) return;
      void getDeskKernelBridge()?.rpc.invoke('kernel:shell:show-in-finder', { targetPath: filePath });
    };

    const handleProseClick = (e: React.MouseEvent<HTMLDivElement>) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;

      const img = target.closest('img.md-chat-img') as HTMLImageElement | null;
      if (img) {
        e.preventDefault();
        e.stopPropagation();
        const src = img.getAttribute('src');
        if (src) {
          setLightbox({
            src,
            alt: img.getAttribute('alt') || undefined,
            localPath: img.getAttribute('data-local-path') || undefined,
          });
        }
        return;
      }

      const link = target.closest('a') as HTMLAnchorElement | null;
      if (!link) return;

      const localFile = link.getAttribute('data-local-file');
      if (localFile) {
        e.preventDefault();
        e.stopPropagation();
        if (isRenderableLocalImagePath(localFile)) {
          setLightbox({
            src: `desk-app://local-media?path=${encodeURIComponent(localFile)}`,
            alt: link.textContent || undefined,
            localPath: localFile,
          });
        } else if (isArtifactPreviewablePath(localFile)) {
          const range = parseLineRange(link.getAttribute('data-local-lines'));
          const opened = openLocalArtifactInPane({
            filePath: localFile,
            sourceGroupId: groupId,
            reuseSameGroup: true,
            ...range,
          });
          if (!opened) {
            void getDeskKernelBridge()?.rpc.invoke('kernel:shell:open-path', { targetPath: localFile });
          }
        } else {
          void getDeskKernelBridge()?.rpc.invoke('kernel:shell:open-path', { targetPath: localFile });
        }
        return;
      }

      const href = link.getAttribute('href') || '';
      if (/^https?:\/\//i.test(href)) {
        e.preventDefault();
        e.stopPropagation();
        void getDeskKernelBridge()?.rpc.invoke('kernel:shell:open-external', { url: href });
      }
    };

    const handleContextMenu = (e: React.MouseEvent) => {
      e.preventDefault();
      ctx.ui.showContextMenu(e.clientX, e.clientY, [
        { type: 'item', label: '새로고침', icon: <RotateCw size={13} />, onSelect: () => void loadFile(filePath) },
        ...(isMarkdown
          ? [
              {
                type: 'item' as const,
                label: effectiveMode === 'preview' ? '원본 마크다운 보기' : '미리보기로 전환',
                icon: effectiveMode === 'preview' ? <Code2 size={13} /> : <Eye size={13} />,
                onSelect: () => updateState({ viewMode: effectiveMode === 'preview' ? 'source' : 'preview' }),
              },
            ]
          : []),
        { type: 'separator' },
        { type: 'item', label: 'Finder에서 보기', icon: <FolderOpen size={13} />, onSelect: handleRevealFinder },
        { type: 'item', label: '외부 기본 앱으로 열기', icon: <ExternalLink size={13} />, onSelect: handleOpenExternal },
        { type: 'separator' },
        { type: 'item', label: '오른쪽으로 분할', icon: <Columns2 size={13} />, shortcut: '⌘D', onSelect: () => splitGroup(groupId, 'h') },
        { type: 'item', label: '아래로 분할', icon: <Rows2 size={13} />, shortcut: '⌘⇧D', onSelect: () => splitGroup(groupId, 'v') },
        { type: 'separator' },
        { type: 'item', label: '탭 닫기', icon: <Trash2 size={13} />, danger: true, onSelect: () => void closeTab(groupId, tab.id) },
      ]);
    };

    const fileName = snap?.fileName || filePath.split('/').pop() || '아티팩트';
    const parentLabel = filePath ? shortenPath(filePath) : '';

    return (
      <div className="flex-1 min-h-0 flex flex-col" style={{ background: 'var(--bg)' }} onContextMenu={handleContextMenu}>
        {/* Header Bar */}
        <div
          className="h-9 shrink-0 px-3 border-b flex items-center justify-between gap-2 text-xs"
          style={{ background: 'var(--card)', borderColor: 'var(--border)' }}
        >
          <div className="flex items-center gap-2 min-w-0 flex-1">
            {isMarkdown ? (
              <FileText size={13} className="shrink-0" style={{ color: 'var(--accent)' }} />
            ) : (
              <Code2 size={13} className="shrink-0" style={{ color: 'var(--accent)' }} />
            )}
            <span className="font-semibold shrink-0 max-w-[200px] truncate" style={{ color: 'var(--fg)' }} title={filePath}>
              {fileName}
            </span>
            {parentLabel && (
              <span
                className="hidden xl:inline font-mono text-[11px] min-w-0 truncate"
                style={{ color: 'var(--muted)' }}
                title={filePath}
              >
                {parentLabel}
              </span>
            )}
            {snap?.size != null && (
              <span className="hidden lg:inline text-[10.5px] tabular-nums shrink-0" style={{ color: 'var(--muted)' }}>
                {formatBytes(snap.size)}
              </span>
            )}
          </div>

          <div className="flex items-center gap-1 shrink-0">
            {isMarkdown && snap?.ok && (
              <div
                className="flex items-center p-0.5 rounded-md border mr-1"
                style={{ borderColor: 'var(--border)', background: 'var(--bg)' }}
              >
                <button
                  type="button"
                  onClick={() => updateState({ viewMode: 'preview' })}
                  className="px-2 py-0.5 rounded text-[11px] cursor-pointer flex items-center gap-1 transition-colors"
                  style={{
                    background: effectiveMode === 'preview' ? 'var(--card)' : 'transparent',
                    color: effectiveMode === 'preview' ? 'var(--fg)' : 'var(--muted)',
                    fontWeight: effectiveMode === 'preview' ? 600 : 400,
                  }}
                >
                  <Eye size={11} />
                  <span>미리보기</span>
                </button>
                <button
                  type="button"
                  onClick={() => updateState({ viewMode: 'source' })}
                  className="px-2 py-0.5 rounded text-[11px] cursor-pointer flex items-center gap-1 transition-colors"
                  style={{
                    background: effectiveMode === 'source' ? 'var(--card)' : 'transparent',
                    color: effectiveMode === 'source' ? 'var(--fg)' : 'var(--muted)',
                    fontWeight: effectiveMode === 'source' ? 600 : 400,
                  }}
                >
                  <Code2 size={11} />
                  <span>원본</span>
                </button>
              </div>
            )}

            {snap?.ok && (
              <button
                type="button"
                onClick={handleCopy}
                className="p-1 rounded cursor-pointer hover:bg-[var(--surface-active)] transition-colors"
                style={{ color: copied ? 'var(--ok)' : 'var(--muted)' }}
                title="내용 복사"
              >
                {copied ? <Check size={13} /> : <Copy size={13} />}
              </button>
            )}

            <button
              type="button"
              onClick={() => void loadFile(filePath)}
              className="p-1 rounded cursor-pointer hover:bg-[var(--surface-active)] transition-colors"
              style={{ color: 'var(--muted)' }}
              title="새로고침 (파일 변경 시 자동 갱신됨)"
            >
              <RotateCw size={13} className={loading ? 'animate-spin' : ''} />
            </button>

            {filePath && (
              <>
                <button
                  type="button"
                  onClick={handleRevealFinder}
                  className="px-1.5 py-0.5 rounded cursor-pointer hover:bg-[var(--surface-active)] transition-colors flex items-center gap-1 text-[11px]"
                  style={{ color: 'var(--muted)' }}
                  title="Finder에서 위치 보기"
                >
                  <FolderOpen size={12} />
                  <span className="hidden lg:inline">Finder</span>
                </button>
                <button
                  type="button"
                  onClick={handleOpenExternal}
                  className="px-1.5 py-0.5 rounded cursor-pointer hover:bg-[var(--surface-active)] transition-colors flex items-center gap-1 text-[11px]"
                  style={{ color: 'var(--muted)' }}
                  title="외부 기본 앱으로 열기"
                >
                  <ExternalLink size={12} />
                  <span className="hidden lg:inline">외부 앱</span>
                </button>
              </>
            )}
          </div>
        </div>

        {/* Body */}
        {!filePath ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-2 p-6 text-xs" style={{ color: 'var(--muted)' }}>
            <FileText size={24} className="opacity-40" />
            <div>채팅의 아티팩트(.md)나 파일 링크를 클릭하면 여기에 바로 열립니다.</div>
          </div>
        ) : snap && !snap.ok ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-3 p-6 text-xs text-center" style={{ color: 'var(--muted)' }}>
            <div style={{ color: 'var(--fg)' }}>{snap.error || '파일을 열 수 없습니다.'}</div>
            <div className="font-mono text-[11px] max-w-[460px] break-all opacity-75">{filePath}</div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleOpenExternal}
                className="px-3 py-1.5 rounded-lg border cursor-pointer flex items-center gap-1.5"
                style={{ borderColor: 'var(--border)', background: 'var(--card)', color: 'var(--fg)' }}
              >
                <ExternalLink size={12} />
                <span>외부 앱으로 열기</span>
              </button>
              <button
                type="button"
                onClick={handleRevealFinder}
                className="px-3 py-1.5 rounded-lg border cursor-pointer flex items-center gap-1.5"
                style={{ borderColor: 'var(--border)', background: 'var(--card)', color: 'var(--fg)' }}
              >
                <FolderOpen size={12} />
                <span>Finder에서 보기</span>
              </button>
            </div>
          </div>
        ) : !snap ? (
          <div className="flex-1 flex items-center justify-center text-xs" style={{ color: 'var(--muted)' }}>
            불러오는 중…
          </div>
        ) : effectiveMode === 'preview' && snap.isMarkdown ? (
          <div className="flex-1 min-h-0 overflow-y-auto scroll-thin">
            <div className="max-w-[780px] mx-auto px-6 py-5">
              <div
                className="md-prose text-[14px] leading-relaxed"
                onClick={handleProseClick}
                dangerouslySetInnerHTML={{ __html: renderedHtml }}
              />
            </div>
          </div>
        ) : (
          <div ref={sourceContainerRef} className="flex-1 min-h-0 overflow-auto scroll-thin py-3 font-mono text-[12px] leading-relaxed">
            {sourceLines.map((line, idx) => {
              const lineNo = idx + 1;
              const isHighlighted = lineStart != null && lineEnd != null && lineNo >= lineStart && lineNo <= lineEnd;
              return (
                <div
                  key={lineNo}
                  data-line-no={lineNo}
                  className="flex px-3 hover:bg-[var(--surface-active)]"
                  style={
                    isHighlighted
                      ? { background: 'color-mix(in srgb, var(--accent) 14%, transparent)' }
                      : undefined
                  }
                >
                  <span
                    className="w-10 shrink-0 pr-3 text-right select-none tabular-nums text-[11px]"
                    style={{ color: isHighlighted ? 'var(--accent)' : 'var(--muted)', opacity: isHighlighted ? 1 : 0.6 }}
                  >
                    {lineNo}
                  </span>
                  <span className="whitespace-pre flex-1 min-w-0" style={{ color: 'var(--fg)' }}>
                    {line || ' '}
                  </span>
                </div>
              );
            })}
          </div>
        )}

        {lightbox && (
          <InlineImageLightbox
            src={lightbox.src}
            alt={lightbox.alt}
            localPath={lightbox.localPath}
            onClose={() => setLightbox(null)}
          />
        )}
      </div>
    );
  };
}

export const paneArtifactClient: ClientPluginModule = {
  activate(ctx) {
    ctx.panes.registerType<ArtifactTabState>({
      type: 'artifact',
      label: '아티팩트 뷰어',
      description: '로컬 마크다운 아티팩트 및 코드 미리보기',
      icon: FileText,
      accentColor: '#6366f1',
      keepAlive: 'never',
      showInLauncher: false,
      showInOmnibox: false,
      order: 45,
      createDefaultState: (init) => {
        const fp = typeof init?.filePath === 'string' ? init.filePath.trim() : '';
        const title = fp ? fp.split('/').pop() || '아티팩트' : '아티팩트';
        return {
          title,
          state: {
            filePath: fp || undefined,
            lineStart: typeof init?.lineStart === 'number' ? init.lineStart : undefined,
            lineEnd: typeof init?.lineEnd === 'number' ? init.lineEnd : undefined,
            focusToken: typeof init?.focusToken === 'number' ? init.focusToken : undefined,
            viewMode: init?.viewMode === 'source' ? 'source' : 'preview',
          },
        };
      },
      Component: createArtifactComponent(ctx),
    });
  },
};

export const paneArtifactClientPackage: BuiltinPluginPackage = {
  manifest: paneArtifactManifest,
  client: paneArtifactClient,
};
