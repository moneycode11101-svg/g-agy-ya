import * as React from 'react';
import * as ReactDOM from 'react-dom';
import * as ReactDOMClient from 'react-dom/client';
import * as ReactJsxRuntime from 'react/jsx-runtime';
import * as LucideIcons from 'lucide-react';
import * as Zustand from 'zustand';
import type { DeskKernelBridge } from '../shared/types';

const KERNEL_SHIELD_STYLE_ID = 'desk-kernel-pointer-shield';
const VALID_IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

let sharedInitialized = false;

/**
 * Injects the zero-coupling CSS pointer-event shield once at kernel boot.
 * Replaces hardcoded `document.querySelectorAll('webview')` calls in SplitTree/PaneGroupView
 * and protects X-Ray overlay from Chromium `<webview>` pointer capture (critic #12-9).
 */
export function ensureKernelPointerShieldCss(): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById(KERNEL_SHIELD_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = KERNEL_SHIELD_STYLE_ID;
  style.textContent = `
[data-desk-dragging="true"] webview,
[data-desk-dragging="true"] iframe,
[data-desk-xray="true"] webview,
[data-desk-xray="true"] iframe {
  pointer-events: none !important;
}
`;
  document.head.appendChild(style);
}

/**
 * Publishes immutable singleton instances of React 19, ReactDOM, JSX runtime, Zustand,
 * Lucide icons, and `@agy-desk/kernel` on `window.__DESK_SHARED__` (Main World only —
 * preserves Electron `contextIsolation: true` and `sandbox: true`).
 * Also reports live named export keys to Main so `desk-plugin://__host__/<pkg>.mjs`
 * re-exports every named symbol cleanly with zero SyntaxError / Invalid Hook Call (critic #12-4).
 */
function unwrapSharedModule(ns: unknown): Record<string, unknown> {
  if (!ns || typeof ns !== 'object') return {};
  const rec = ns as Record<string, unknown>;
  const def = rec.default;
  if (def && typeof def === 'object') {
    return { ...(def as Record<string, unknown>), ...rec, default: def };
  }
  return { ...rec };
}

export function initSharedPluginRuntime(kernelSdkExports: Record<string, unknown>): void {
  ensureKernelPointerShieldCss();
  if (sharedInitialized || typeof window === 'undefined') return;
  sharedInitialized = true;

  const sharedRegistry: Record<string, Record<string, unknown>> = {
    react: unwrapSharedModule(React),
    'react-dom': unwrapSharedModule(ReactDOM),
    'react-dom/client': unwrapSharedModule(ReactDOMClient),
    'react/jsx-runtime': unwrapSharedModule(ReactJsxRuntime),
    'react/jsx-dev-runtime': unwrapSharedModule(ReactJsxRuntime),
    zustand: unwrapSharedModule(Zustand),
    'lucide-react': unwrapSharedModule(LucideIcons),
    '@agy-desk/kernel': kernelSdkExports,
  };

  Object.defineProperty(window, '__DESK_SHARED__', {
    value: Object.freeze(sharedRegistry),
    writable: false,
    configurable: false,
  });

  // Notify Main of exact live export keys so `desk-plugin://__host__/<pkg>.mjs` matches 100%
  const exportMap: Record<string, string[]> = {};
  for (const [spec, mod] of Object.entries(sharedRegistry)) {
    exportMap[spec] = Object.keys(mod).filter((k) => k !== 'default' && VALID_IDENT.test(k));
  }

  window.deskKernel?.rpc.notify('kernel:shared-exports', exportMap);
}

export function getDeskKernelBridge(): DeskKernelBridge | null {
  if (typeof window === 'undefined') return null;
  return window.deskKernel ?? null;
}

/** Set or clear X-Ray global pointer shield attribute (`data-desk-xray`) */
export function setXrayPointerShield(active: boolean): void {
  if (typeof document === 'undefined') return;
  if (active) {
    document.documentElement.dataset.deskXray = 'true';
  } else {
    delete document.documentElement.dataset.deskXray;
  }
}
