import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { FolderPlus, Image as ImageIcon, Paperclip, X } from 'lucide-react';
import { getDeskKernelBridge } from '../../kernel/client';

const IMAGE_FILE_RE = /\.(png|jpe?g|webp|gif|bmp|svg|avif|heic|heif|tif|tiff|ico)$/i;

export function isImageFilePath(filePath: string): boolean {
  return IMAGE_FILE_RE.test(filePath);
}

// Renderer-side thumbnail cache keyed by `${maxSize}:${filePath}`
const thumbnailCache = new Map<string, string | null>();
const inflightRequests = new Map<string, Promise<string | null>>();

function fetchImageThumbnail(filePath: string, maxSize: number): Promise<string | null> {
  const key = `${maxSize}:${filePath}`;
  if (thumbnailCache.has(key)) {
    return Promise.resolve(thumbnailCache.get(key) ?? null);
  }
  const existing = inflightRequests.get(key);
  if (existing) return existing;

  const bridge = getDeskKernelBridge();
  if (!bridge) return Promise.resolve(null);

  const req = bridge.rpc
    .invoke<string | null>('pane-chat:getImageThumbnail', { filePath, maxSize })
    .then((dataUrl) => {
      const normalized = typeof dataUrl === 'string' && dataUrl.startsWith('data:') ? dataUrl : null;
      // Keep cache bounded
      if (thumbnailCache.size > 240) {
        const oldest = thumbnailCache.keys().next().value;
        if (oldest !== undefined) thumbnailCache.delete(oldest);
      }
      thumbnailCache.set(key, normalized);
      return normalized;
    })
    .catch(() => null)
    .finally(() => {
      inflightRequests.delete(key);
    });

  inflightRequests.set(key, req);
  return req;
}

export function useImageThumbnail(filePath: string | null, maxSize = 200): string | null {
  const cacheKey = filePath ? `${maxSize}:${filePath}` : '';
  const [src, setSrc] = useState<string | null>(() =>
    cacheKey && thumbnailCache.has(cacheKey) ? (thumbnailCache.get(cacheKey) ?? null) : null
  );

  useEffect(() => {
    if (!filePath || !isImageFilePath(filePath)) {
      setSrc(null);
      return;
    }
    const key = `${maxSize}:${filePath}`;
    if (thumbnailCache.has(key)) {
      setSrc(thumbnailCache.get(key) ?? null);
      return;
    }
    let cancelled = false;
    void fetchImageThumbnail(filePath, maxSize).then((url) => {
      if (!cancelled) setSrc(url);
    });
    return () => {
      cancelled = true;
    };
  }, [filePath, maxSize]);

  return src;
}

const ImageLightboxModal: React.FC<{ filePath: string; onClose: () => void }> = ({ filePath, onClose }) => {
  const fullSrc = useImageThumbnail(filePath, 1400);
  const thumbSrc = useImageThumbnail(filePath, 200);
  const displaySrc = fullSrc || thumbSrc;
  const fileName = filePath.split('/').pop() || filePath;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal(
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center p-6"
      style={{ background: 'rgba(0, 0, 0, 0.72)', backdropFilter: 'blur(4px)' }}
      onClick={onClose}
    >
      <div
        className="relative max-w-[88vw] max-h-[86vh] flex flex-col items-center gap-2.5"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={onClose}
          className="absolute -top-3 -right-3 w-7 h-7 rounded-full flex items-center justify-center cursor-pointer transition-transform hover:scale-105"
          style={{
            background: 'var(--card)',
            color: 'var(--fg)',
            border: '1px solid var(--border-strong)',
            boxShadow: 'var(--shadow-popover)',
          }}
          title="닫기 (Esc)"
          aria-label="이미지 미리보기 닫기"
        >
          <X size={14} />
        </button>
        {displaySrc ? (
          <img
            src={displaySrc}
            alt={fileName}
            className="max-w-[86vw] max-h-[78vh] rounded-2xl object-contain border"
            style={{
              borderColor: 'rgba(255, 255, 255, 0.16)',
              background: 'var(--card)',
              boxShadow: '0 20px 50px rgba(0, 0, 0, 0.45)',
            }}
          />
        ) : (
          <div
            className="px-6 py-10 rounded-2xl border text-xs"
            style={{ background: 'var(--card)', borderColor: 'var(--border)', color: 'var(--muted)' }}
          >
            이미지를 불러오는 중...
          </div>
        )}
        <div
          className="px-3 py-1 rounded-full text-[11.5px] font-mono max-w-[80vw] truncate"
          style={{ background: 'rgba(15, 23, 42, 0.78)', color: '#f8fafc' }}
          title={filePath}
        >
          {fileName}
        </div>
      </div>
    </div>,
    document.body
  );
};

const ComposerImageCard: React.FC<{
  filePath: string;
  onRemove: () => void;
  onPreview: () => void;
}> = ({ filePath, onRemove, onPreview }) => {
  const thumbSrc = useImageThumbnail(filePath, 200);
  const fileName = filePath.split('/').pop() || filePath;

  return (
    <div className="relative group shrink-0" title={`${fileName}\n${filePath}`}>
      <button
        type="button"
        onClick={onPreview}
        className="w-[54px] h-[54px] rounded-xl border overflow-hidden cursor-pointer transition-transform hover:scale-[1.02] flex items-center justify-center"
        style={{
          background: 'var(--surface)',
          borderColor: 'var(--border-strong)',
          boxShadow: 'var(--shadow-sm)',
        }}
      >
        {thumbSrc ? (
          <img
            src={thumbSrc}
            alt={fileName}
            draggable={false}
            className="w-full h-full object-cover"
          />
        ) : (
          <ImageIcon size={18} style={{ color: 'var(--muted)' }} />
        )}
      </button>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onRemove();
        }}
        className="absolute -top-1.5 -right-1.5 w-[18px] h-[18px] rounded-full flex items-center justify-center cursor-pointer opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity"
        style={{
          background: 'var(--fg)',
          color: 'var(--bg)',
          boxShadow: '0 1px 4px rgba(0, 0, 0, 0.28)',
        }}
        title="이미지 첨부 제거"
        aria-label={`${fileName} 첨부 제거`}
      >
        <X size={10} strokeWidth={2.6} />
      </button>
    </div>
  );
};

export interface ComposerAttachmentStripProps {
  attachedFiles: string[];
  addDirs?: string[];
  onRemoveFile: (filePath: string) => void;
  onRemoveAddDir: (dirPath: string) => void;
}

export const ComposerAttachmentStrip: React.FC<ComposerAttachmentStripProps> = ({
  attachedFiles,
  addDirs,
  onRemoveFile,
  onRemoveAddDir,
}) => {
  const [previewPath, setPreviewPath] = useState<string | null>(null);

  const imageFiles = attachedFiles.filter((p) => isImageFilePath(p));
  const otherFiles = attachedFiles.filter((p) => !isImageFilePath(p));
  const dirs = addDirs || [];

  if (imageFiles.length === 0 && otherFiles.length === 0 && dirs.length === 0) {
    return null;
  }

  return (
    <>
      <div
        className="pb-2.5 mb-2.5 border-b space-y-2"
        style={{ borderColor: 'var(--border)' }}
      >
        {imageFiles.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 pt-2 pr-2 max-h-[156px] overflow-y-auto scroll-thin">
            {imageFiles.map((imgPath) => (
              <ComposerImageCard
                key={imgPath}
                filePath={imgPath}
                onRemove={() => onRemoveFile(imgPath)}
                onPreview={() => setPreviewPath(imgPath)}
              />
            ))}
          </div>
        )}

        {(dirs.length > 0 || otherFiles.length > 0) && (
          <div className="flex flex-wrap gap-1.5">
            {dirs.map((dir) => (
              <span
                key={`dir:${dir}`}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg text-[11px] font-mono"
                style={{
                  background: 'color-mix(in srgb, var(--accent) 10%, var(--surface))',
                  color: 'var(--fg-soft)',
                }}
                title={`추가 컨텍스트 폴더 (--add-dir): ${dir}`}
              >
                <FolderPlus size={11} style={{ color: 'var(--accent)' }} />
                <span>{dir.split('/').pop() || dir}</span>
                <button
                  type="button"
                  onClick={() => onRemoveAddDir(dir)}
                  className="cursor-pointer opacity-60 hover:opacity-100 ml-0.5"
                  title="추가 폴더 해제"
                >
                  ✕
                </button>
              </span>
            ))}
            {otherFiles.map((filePath) => (
              <span
                key={filePath}
                className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-lg text-[11px] font-mono"
                style={{ background: 'var(--surface)', color: 'var(--fg-soft)' }}
                title={filePath}
              >
                <Paperclip size={10} style={{ color: 'var(--muted)' }} />
                <span className="max-w-[200px] truncate">{filePath.split('/').pop()}</span>
                <button
                  type="button"
                  onClick={() => onRemoveFile(filePath)}
                  className="cursor-pointer opacity-60 hover:opacity-100"
                  title="첨부 제거"
                >
                  ✕
                </button>
              </span>
            ))}
          </div>
        )}
      </div>

      {previewPath && (
        <ImageLightboxModal filePath={previewPath} onClose={() => setPreviewPath(null)} />
      )}
    </>
  );
};

const MessageImageTile: React.FC<{ filePath: string; onPreview: () => void }> = ({
  filePath,
  onPreview,
}) => {
  const thumbSrc = useImageThumbnail(filePath, 280);
  const fileName = filePath.split('/').pop() || filePath;

  return (
    <button
      type="button"
      onClick={onPreview}
      className="w-16 h-16 rounded-xl border overflow-hidden cursor-pointer shrink-0 flex items-center justify-center transition-transform hover:scale-[1.03]"
      style={{
        background: 'var(--card)',
        borderColor: 'var(--border-strong)',
      }}
      title={fileName}
    >
      {thumbSrc ? (
        <img src={thumbSrc} alt={fileName} draggable={false} className="w-full h-full object-cover" />
      ) : (
        <span className="inline-flex flex-col items-center gap-0.5 px-1 text-[9.5px] font-mono truncate max-w-full" style={{ color: 'var(--muted)' }}>
          <ImageIcon size={14} />
          <span className="truncate max-w-full">{fileName}</span>
        </span>
      )}
    </button>
  );
};

export const MessageAttachmentGrid: React.FC<{
  images: string[];
  chipBackground?: string;
}> = ({ images, chipBackground = 'var(--card)' }) => {
  const [previewPath, setPreviewPath] = useState<string | null>(null);

  if (!images || images.length === 0) return null;

  const imgFiles = images.filter((p) => isImageFilePath(p));
  const nonImgFiles = images.filter((p) => !isImageFilePath(p));

  return (
    <>
      <div className="space-y-1.5 mb-1.5">
        {imgFiles.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {imgFiles.map((imgPath) => (
              <MessageImageTile
                key={imgPath}
                filePath={imgPath}
                onPreview={() => setPreviewPath(imgPath)}
              />
            ))}
          </div>
        )}
        {nonImgFiles.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {nonImgFiles.map((filePath) => (
              <span
                key={filePath}
                className="inline-flex items-center gap-1 text-[11px] font-mono px-2 py-0.5 rounded-md border"
                style={{ background: chipBackground, borderColor: 'var(--border)', color: 'var(--muted)' }}
                title={filePath}
              >
                <Paperclip size={10} />
                <span>{filePath.split('/').pop()}</span>
              </span>
            ))}
          </div>
        )}
      </div>
      {previewPath && (
        <ImageLightboxModal filePath={previewPath} onClose={() => setPreviewPath(null)} />
      )}
    </>
  );
};
