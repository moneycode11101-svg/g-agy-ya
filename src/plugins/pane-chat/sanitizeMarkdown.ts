import { marked } from 'marked';

marked.setOptions({ breaks: true, gfm: true });

const ALLOWED_TAGS = new Set([
  'p',
  'br',
  'hr',
  'strong',
  'b',
  'em',
  'i',
  'u',
  's',
  'del',
  'code',
  'pre',
  'blockquote',
  'ul',
  'ol',
  'li',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'a',
  'img',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
  'span',
  'div',
  'sup',
  'sub',
  'input',
]);

/** Elements whose entire subtree must be dropped (not converted to text) */
const DROP_SUBTREE_TAGS = new Set([
  'script',
  'style',
  'iframe',
  'object',
  'embed',
  'applet',
  'svg',
  'math',
  'form',
  'link',
  'meta',
  'base',
  'template',
  'noscript',
  'audio',
  'video',
  'source',
]);

const ALLOWED_EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);
const SAFE_DATA_IMAGE_RE = /^data:image\/(png|jpeg|jpg|webp|gif|avif|bmp);base64,[a-z0-9+/=\s]+$/i;
const LOCAL_IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|avif|ico|tiff?)$/i;

export function isRenderableLocalImagePath(filePath: string): boolean {
  return LOCAL_IMAGE_EXT_RE.test(filePath);
}

function safeDecodePath(rawPath: string): string {
  try {
    return decodeURIComponent(rawPath);
  } catch {
    return rawPath;
  }
}

function escapeHtmlFallback(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function decodeFileUrlToPath(raw: string): string | null {
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'file:') return null;
    let p = decodeURIComponent(parsed.pathname);
    // Strip optional `#L10-L20` line anchors cleanly (pathname excludes hash already)
    // On Windows file:///C:/foo -> C:/foo
    if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1);
    return p || null;
  } catch {
    return null;
  }
}

function joinPosix(base: string, rel: string): string {
  const b = base.replace(/\/+$/, '');
  const parts = `${b}/${rel}`.split('/');
  const stack: string[] = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') stack.pop();
    else stack.push(part);
  }
  return `/${stack.join('/')}`;
}

function extractLineAnchor(raw: string): string | undefined {
  const hashIdx = raw.indexOf('#');
  if (hashIdx < 0) return undefined;
  const frag = raw.slice(hashIdx + 1).trim();
  const m = frag.match(/^L?(\d+)(?:-L?(\d+))?$/i);
  if (!m) return undefined;
  return m[2] ? `${m[1]}-${m[2]}` : m[1];
}

function sanitizeHref(raw: string, baseCwd?: string): { href: string; localFile?: string; localLines?: string } | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Reject control characters / protocol-relative URLs
  if (/[\u0000-\u001f\u007f]/.test(trimmed) || trimmed.startsWith('//')) return null;

  if (/^file:/i.test(trimmed)) {
    const localFile = decodeFileUrlToPath(trimmed);
    if (!localFile) return null;
    return { href: '#local-file', localFile, localLines: extractLineAnchor(trimmed) };
  }

  // Bare local absolute path links (e.g. `[image](/Users/.../a.png)` or `[doc](~/notes.md#L10-L20)`)
  if (trimmed.startsWith('/') || trimmed.startsWith('~/') || /^[A-Za-z]:[\\/]/.test(trimmed)) {
    const localFile = safeDecodePath(trimmed.split(/[?#]/)[0]);
    if (!localFile) return null;
    return { href: '#local-file', localFile, localLines: extractLineAnchor(trimmed) };
  }

  // Relative local file links resolved against workspace/artifact base directory
  if (baseCwd && !trimmed.startsWith('#') && !/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
    const cleanRel = safeDecodePath(trimmed.split(/[?#]/)[0]);
    if (cleanRel) {
      return {
        href: '#local-file',
        localFile: joinPosix(baseCwd, cleanRel),
        localLines: extractLineAnchor(trimmed),
      };
    }
  }

  try {
    const parsed = new URL(trimmed);
    if (!ALLOWED_EXTERNAL_PROTOCOLS.has(parsed.protocol)) return null;
    return { href: parsed.href };
  } catch {
    return null;
  }
}

function sanitizeImageSrc(raw: string, baseCwd?: string): { src: string; localPath?: string } | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/[\u0000-\u001f\u007f]/.test(trimmed) || trimmed.startsWith('//')) return null;

  // 1) Safe inline raster data URI (SVG intentionally blocked)
  if (/^data:/i.test(trimmed)) {
    return SAFE_DATA_IMAGE_RE.test(trimmed) ? { src: trimmed } : null;
  }

  // 2) Already rewritten local-media URL
  if (/^desk-app:\/\/local-media\?/i.test(trimmed)) {
    try {
      const u = new URL(trimmed);
      const p = u.searchParams.get('path') || undefined;
      return { src: trimmed, localPath: p };
    } catch {
      return null;
    }
  }

  // 3) file:// local path
  if (/^file:/i.test(trimmed)) {
    const localPath = decodeFileUrlToPath(trimmed);
    if (!localPath || !LOCAL_IMAGE_EXT_RE.test(localPath)) return null;
    return {
      src: `desk-app://local-media?path=${encodeURIComponent(localPath)}`,
      localPath,
    };
  }

  // 4) Remote http(s) URL
  if (/^https?:/i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        return { src: parsed.href };
      }
    } catch {
      return null;
    }
    return null;
  }

  // 5) Absolute local path (`/Users/...`, `~/...`) or Windows drive path
  if (trimmed.startsWith('/') || trimmed.startsWith('~/') || /^[A-Za-z]:[\\/]/.test(trimmed)) {
    const cleanPath = safeDecodePath(trimmed.split(/[?#]/)[0]);
    if (!LOCAL_IMAGE_EXT_RE.test(cleanPath)) return null;
    return {
      src: `desk-app://local-media?path=${encodeURIComponent(cleanPath)}`,
      localPath: cleanPath,
    };
  }

  // 6) Relative path resolved against active workspace cwd
  if (baseCwd && !/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
    const cleanRel = safeDecodePath(trimmed.split(/[?#]/)[0]);
    if (!LOCAL_IMAGE_EXT_RE.test(cleanRel)) return null;
    const resolved = joinPosix(baseCwd, cleanRel);
    return {
      src: `desk-app://local-media?path=${encodeURIComponent(resolved)}`,
      localPath: resolved,
    };
  }

  return null;
}

function sanitizeNode(node: Node, doc: Document, baseCwd?: string): Node | null {
  if (node.nodeType === Node.TEXT_NODE) {
    return doc.createTextNode(node.textContent || '');
  }
  if (node.nodeType !== Node.ELEMENT_NODE) {
    return null;
  }

  const el = node as HTMLElement;
  const tag = el.tagName.toLowerCase();

  if (DROP_SUBTREE_TAGS.has(tag)) {
    return null;
  }

  if (!ALLOWED_TAGS.has(tag)) {
    // Unwrap unknown HTML tags safely into plain text so raw text is preserved without HTML injection
    return doc.createTextNode(el.textContent || '');
  }

  // Only allow read-only GFM task-list checkboxes for `<input>`
  if (tag === 'input') {
    if ((el.getAttribute('type') || '').toLowerCase() !== 'checkbox') {
      return null;
    }
    const cleanInput = doc.createElement('input');
    cleanInput.setAttribute('type', 'checkbox');
    cleanInput.setAttribute('disabled', 'true');
    if (el.hasAttribute('checked')) cleanInput.setAttribute('checked', 'true');
    return cleanInput;
  }

  // Safe image element (strict attribute allowlist — zero event handlers, zero SVG/javascript)
  if (tag === 'img') {
    const safeImg = sanitizeImageSrc(el.getAttribute('src') || '', baseCwd);
    if (!safeImg) return null;
    const cleanImg = doc.createElement('img');
    cleanImg.setAttribute('src', safeImg.src);
    cleanImg.setAttribute('class', 'md-chat-img');
    cleanImg.setAttribute('loading', 'lazy');
    cleanImg.setAttribute('decoding', 'async');
    const alt = el.getAttribute('alt');
    if (alt) cleanImg.setAttribute('alt', alt.slice(0, 300));
    const title = el.getAttribute('title');
    if (title) cleanImg.setAttribute('title', title.slice(0, 200));
    if (safeImg.localPath) {
      cleanImg.setAttribute('data-local-path', safeImg.localPath);
    }
    return cleanImg;
  }

  const clean = doc.createElement(tag);

  // Strict per-tag attribute allowlist (all `on*`, `style`, `srcdoc`, `data-*`, etc. are dropped)
  if (tag === 'a') {
    const safeLink = sanitizeHref(el.getAttribute('href') || '', baseCwd);
    if (safeLink) {
      clean.setAttribute('href', safeLink.href);
      clean.setAttribute('rel', 'noopener noreferrer');
      if (safeLink.localFile) {
        clean.setAttribute('data-local-file', safeLink.localFile);
      }
      if (safeLink.localLines) {
        clean.setAttribute('data-local-lines', safeLink.localLines);
      }
    }
    const title = el.getAttribute('title');
    if (title) clean.setAttribute('title', title.slice(0, 200));
  } else if (tag === 'code' || tag === 'pre') {
    const cls = el.getAttribute('class') || '';
    const langMatch = cls.match(/\blanguage-[a-z0-9_-]+\b/i);
    if (langMatch) {
      clean.setAttribute('class', langMatch[0]);
    }
  } else if (tag === 'th' || tag === 'td') {
    const align = (el.getAttribute('align') || '').toLowerCase();
    if (align === 'left' || align === 'center' || align === 'right') {
      clean.setAttribute('align', align);
    }
  }

  for (const child of Array.from(el.childNodes)) {
    const sanitizedChild = sanitizeNode(child, doc, baseCwd);
    if (sanitizedChild) clean.appendChild(sanitizedChild);
  }
  return clean;
}

/**
 * DOM-whitelist Markdown renderer (immune to `<img/onerror>`, `<svg onload>`, `javascript:` bypasses).
 * Supports safe raster images (`https://`, `data:image/*`, `file://`, `/abs/path`, workspace-relative)
 * via Electron's `desk-app://local-media` image-only protocol handler.
 */
export function renderSanitizedMarkdown(markdown: string, baseCwd?: string): string {
  if (!markdown) return '';
  const rawHtml = marked.parse(markdown) as string;
  if (typeof DOMParser === 'undefined') {
    return escapeHtmlFallback(markdown);
  }

  const parser = new DOMParser();
  const parsed = parser.parseFromString(rawHtml, 'text/html');
  const outDoc = document.implementation.createHTMLDocument('');
  const container = outDoc.createElement('div');

  for (const child of Array.from(parsed.body.childNodes)) {
    const safeChild = sanitizeNode(child, outDoc, baseCwd);
    if (safeChild) container.appendChild(safeChild);
  }

  return container.innerHTML;
}
