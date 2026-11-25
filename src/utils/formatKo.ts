import type { QuotaBucket, QuotaWindow } from '../shared/types';

export function fmtKo(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return '0';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 100_000_000) return `${sign}${(abs / 100_000_000).toFixed(1)}억`;
  if (abs >= 10_000) {
    const v = abs / 10_000;
    return `${sign}${v >= 100 ? Math.round(v) : v.toFixed(1)}만`;
  }
  if (abs >= 1_000) return `${sign}${(abs / 1_000).toFixed(1)}천`;
  return `${sign}${Math.round(abs)}`;
}

export function fmtAgo(tsMs: number | null | undefined): string {
  if (!tsMs) return '';
  const diffSec = Math.max(0, Math.floor((Date.now() - tsMs) / 1000));
  if (diffSec < 60) return `${diffSec}초 전`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}분 전`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}시간 전`;
  return `${Math.floor(diffSec / 86400)}일 전`;
}

export function fmtReset(resetInSeconds: number | null, resetTime: string | null): string {
  if (resetTime) {
    const d = new Date(resetTime);
    if (!Number.isNaN(d.getTime())) {
      const diffHours = (d.getTime() - Date.now()) / 3_600_000;
      if (diffHours <= 24) {
        const hh = String(d.getHours()).padStart(2, '0');
        const mm = String(d.getMinutes()).padStart(2, '0');
        return `${hh}:${mm}`;
      }
      return `${d.getMonth() + 1}/${d.getDate()}`;
    }
  }
  if (resetInSeconds && resetInSeconds > 0) {
    const h = Math.floor(resetInSeconds / 3600);
    const m = Math.floor((resetInSeconds % 3600) / 60);
    if (h >= 24) return `${Math.floor(h / 24)}일`;
    if (h > 0) return `${h}시간`;
    return `${Math.max(1, m)}분`;
  }
  return '';
}

export function computePaceTickPct(
  win: QuotaWindow | undefined,
  resetTime: string | null,
  resetInSeconds: number | null
): number | null {
  const totalSec = win === '5h' ? 5 * 3600 : win === 'weekly' ? 7 * 86400 : 0;
  if (!totalSec) return null;
  let remSec: number | null = null;
  if (resetTime) {
    const ts = Date.parse(resetTime);
    if (!Number.isNaN(ts)) remSec = (ts - Date.now()) / 1000;
  }
  if (remSec == null && resetInSeconds != null) {
    remSec = resetInSeconds;
  }
  if (remSec == null) return null;
  const clampedRem = Math.max(0, Math.min(totalSec, remSec));
  const elapsedPct = Math.round((1 - clampedRem / totalSec) * 100);
  return Math.max(2, Math.min(98, elapsedPct));
}

export function quotaBucketTitle(b: QuotaBucket): string {
  const idLower = b.id.toLowerCase();
  const grp =
    b.group === 'codex' || idLower.includes('codex')
      ? 'Codex'
      : b.group === 'gemini' || idLower.includes('gemini')
        ? 'Gemini'
        : 'Claude·GPT';
  if (b.window === '5h' || idLower.includes('5h')) return `${grp} 5시간 한도`;
  if (b.window === 'weekly' || idLower.includes('week')) return `${grp} 주간 한도`;
  if (b.window === 'monthly' || idLower.includes('month')) return `${grp} 월간 한도`;
  return `${grp} (${b.id})`;
}

export function shortModelLabel(model: string): string {
  if (!model || model === 'default' || model === 'unknown') return '기본 모델';
  return model
    .replace(/^gemini-4-/, 'Gemini 4 ')
    .replace(/^gemini-/, 'Gemini ')
    .replace(/^claude-/, 'Claude ')
    .replace(/^gpt-/i, 'GPT-')
    .replace(/^o(\d+)-/i, 'o$1 ')
    .replace(/-/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\bGpt\b/g, 'GPT');
}
