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
  'img',
  'audio',
  'video',
  'source',
]);

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

function escapeHtmlFallback(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function sanitizeHref(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Reject control characters / HTML-entity tricks / protocol-relative URLs
  if (/[\u0000-\u001f\u007f]/.test(trimmed) || trimmed.startsWith('//')) return null;
  try {
    const parsed = new URL(trimmed);
    if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) return null;
    return parsed.href;
  } catch {
    return null;
  }
}

function sanitizeNode(node: Node, doc: Document): Node | null {
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

  const clean = doc.createElement(tag);

  // Strict per-tag attribute allowlist (all `on*`, `style`, `srcdoc`, `data-*`, etc. are dropped)
  if (tag === 'a') {
    const safeHref = sanitizeHref(el.getAttribute('href') || '');
    if (safeHref) {
      clean.setAttribute('href', safeHref);
      clean.setAttribute('rel', 'noopener noreferrer');
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
    const sanitizedChild = sanitizeNode(child, doc);
    if (sanitizedChild) clean.appendChild(sanitizedChild);
  }
  return clean;
}

/**
 * DOM-whitelist Markdown renderer (fixes critic audit #3 XSS vulnerability).
 * Completely immune to `<img/onerror>`, `<svg onload>`, `javascript:` entity bypasses, and nested tag evasion.
 */
export function renderSanitizedMarkdown(markdown: string): string {
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
    const safeChild = sanitizeNode(child, outDoc);
    if (safeChild) container.appendChild(safeChild);
  }

  return container.innerHTML;
}
