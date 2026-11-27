import { BUILTIN_PLUGIN_IDS, useLayoutStore } from '../../kernel/client';
import type { ClientAgentAdapterDescriptor } from '../../shared/agentProtocol';
import type { AccountQuotaSnapshot, QuotaBucket, QuotaWindow, SessionMetrics } from '../../shared/types';
import { computePaceTickPct } from '../../utils/formatKo';

export type ProviderAdapterId = 'agent-agy' | 'agent-claude' | 'agent-codex' | string;

export interface ProviderMeta {
  readonly id: ProviderAdapterId;
  readonly name: string;
  readonly shortName: string;
  readonly accent: string;
  readonly sourceLabel: string;
  readonly settingsSectionId: string;
}

export const PROVIDER_META: Record<string, ProviderMeta> = {
  [BUILTIN_PLUGIN_IDS.AGENT_AGY]: {
    id: BUILTIN_PLUGIN_IDS.AGENT_AGY,
    name: '반중력 (Antigravity)',
    shortName: '반중력',
    accent: '#3b82f6',
    sourceLabel: 'agy /usage',
    settingsSectionId: 'agent-agy-settings',
  },
  [BUILTIN_PLUGIN_IDS.AGENT_CLAUDE]: {
    id: BUILTIN_PLUGIN_IDS.AGENT_CLAUDE,
    name: 'Claude Code',
    shortName: 'Claude',
    accent: '#d97706',
    sourceLabel: 'Claude SDK',
    settingsSectionId: 'agent-claude-settings',
  },
  [BUILTIN_PLUGIN_IDS.AGENT_CODEX]: {
    id: BUILTIN_PLUGIN_IDS.AGENT_CODEX,
    name: 'Codex (OpenAI)',
    shortName: 'Codex',
    accent: '#10b981',
    sourceLabel: 'Codex app-server',
    settingsSectionId: 'agent-codex-settings',
  },
};

export function getProviderMeta(adapterId: string): ProviderMeta {
  return (
    PROVIDER_META[adapterId] || {
      id: adapterId,
      name: adapterId,
      shortName: adapterId.replace(/^agent-/, ''),
      accent: 'var(--accent)',
      sourceLabel: adapterId,
      settingsSectionId: `${adapterId}-settings`,
    }
  );
}

/** Accurate default context window for new/unmeasured tabs by adapter & selected model */
export function inferDefaultContextWindow(adapterId: string, model?: string): number {
  const m = String(model || '').toLowerCase();
  if (adapterId === BUILTIN_PLUGIN_IDS.AGENT_CODEX) {
    if (m.includes('1m')) return 1_000_000;
    return 400_000;
  }
  if (adapterId === BUILTIN_PLUGIN_IDS.AGENT_CLAUDE) {
    if (m.includes('1m') || m.includes('[1m]')) return 1_000_000;
    return 200_000;
  }
  // agent-agy hosts Gemini (1M), Claude (200k), and GPT-OSS (128k)
  if (m.includes('claude')) {
    return m.includes('1m') ? 1_000_000 : 200_000;
  }
  if (m.includes('gpt-oss')) return 128_000;
  return 1_048_576;
}

export function inferBucketWindow(b: QuotaBucket): QuotaWindow | undefined {
  if (b.window === '5h' || b.window === 'weekly' || b.window === 'monthly') return b.window;
  const s = b.id.toLowerCase();
  if (s.includes('5h') || s.includes('five')) return '5h';
  if (s.includes('week')) return 'weekly';
  if (s.includes('month') || s.includes('credit')) return 'monthly';
  return undefined;
}

export function bucketUsedPct(b: QuotaBucket): number {
  if (b.remainingFraction == null) return 0;
  return Math.min(100, Math.max(0, Math.round((1 - b.remainingFraction) * 100)));
}

export function bucketWindowLabel(b: QuotaBucket): string {
  const scopedMatch = /^claude-weekly-(.+)$/.exec(b.id);
  if (scopedMatch) {
    const raw = b.groupName?.includes('·') ? b.groupName.split('·').pop()?.trim() : scopedMatch[1];
    const clean = (raw || scopedMatch[1]).slice(0, 7);
    return clean.charAt(0).toUpperCase() + clean.slice(1);
  }
  if (b.id === 'codex-credits') return '크레딧';
  const w = inferBucketWindow(b);
  if (w === '5h') return '5시간';
  if (w === 'weekly') return '주간';
  if (w === 'monthly') return '월간';
  return b.id.length > 7 ? b.id.slice(0, 7) : b.id;
}

export function sortBucketsByWindow(list: QuotaBucket[]): QuotaBucket[] {
  const rank = (b: QuotaBucket) => {
    const w = inferBucketWindow(b);
    if (w === '5h') return 0;
    if (w === 'weekly') {
      return /^claude-weekly-.+/.test(b.id) ? 1.5 : 1;
    }
    return 2;
  };
  return [...list].sort((a, b) => rank(a) - rank(b));
}

export function inferAgyModelPool(model?: string): 'gemini' | 'claude' {
  const m = String(model || '').toLowerCase();
  if (m.includes('claude') || m.includes('gpt') || m.includes('o1') || m.includes('o3') || m.includes('o4')) {
    return 'claude';
  }
  return 'gemini';
}

function isAgyGeminiBucket(b: QuotaBucket): boolean {
  if (b.group === 'gemini') return true;
  if (b.group === 'claude' || b.group === 'codex') return false;
  return `${b.id} ${b.groupName || ''}`.toLowerCase().includes('gemini');
}

export interface HudQuotaView {
  readonly adapterId: string;
  readonly title: string;
  readonly accent: string;
  readonly sourceLabel: string;
  readonly buckets: QuotaBucket[];
  readonly updatedAt: string | null;
  readonly error?: string;
  /** True only when inside `agent-agy` and both Gemini + Claude·GPT pools exist */
  readonly canToggleAgyPool: boolean;
  readonly activeAgyPool?: 'gemini' | 'claude';
}

/**
 * Strictly maps the active chat tab's adapter + selected model to its 1:1 matching quota pool:
 * - Gemini model on `agent-agy` -> 반중력 Gemini 한도
 * - Claude/GPT model on `agent-agy` -> 반중력 Claude·GPT 한도
 * - `agent-claude` -> Claude Code 한도 (5h + weekly + matching model-scoped weekly)
 * - `agent-codex` -> Codex 한도 (5h + weekly + credits if any)
 */
export function selectHudQuotaView(opts: {
  adapterId: string;
  model?: string;
  accountQuotaByAdapter: Record<string, AccountQuotaSnapshot>;
  legacyAgyQuota?: AccountQuotaSnapshot | null;
  metrics?: SessionMetrics;
  agyPoolOverride?: 'gemini' | 'claude' | null;
}): HudQuotaView {
  const { adapterId, model, accountQuotaByAdapter, legacyAgyQuota, metrics, agyPoolOverride } = opts;
  const meta = getProviderMeta(adapterId);
  const snap =
    accountQuotaByAdapter[adapterId] ??
    (adapterId === BUILTIN_PLUGIN_IDS.AGENT_AGY ? legacyAgyQuota ?? null : null);

  const rawBuckets =
    snap && snap.buckets.length > 0 ? snap.buckets : (metrics?.quotaBuckets ?? []);
  const updatedAt = snap?.updatedAt || metrics?.quotaUpdatedAt || null;
  const error = snap?.error;

  if (adapterId === BUILTIN_PLUGIN_IDS.AGENT_CODEX) {
    const sorted = sortBucketsByWindow(rawBuckets);
    return {
      adapterId,
      title: 'Codex 한도',
      accent: meta.accent,
      sourceLabel: meta.sourceLabel,
      buckets: sorted,
      updatedAt,
      error,
      canToggleAgyPool: false,
    };
  }

  if (adapterId === BUILTIN_PLUGIN_IDS.AGENT_CLAUDE) {
    const sorted = sortBucketsByWindow(rawBuckets);
    // Prioritize 5h + overall weekly + model-scoped weekly matching the active Claude model
    const base = sorted.filter((b) => !/^claude-weekly-.+/.test(b.id));
    const scoped = sorted.filter((b) => /^claude-weekly-.+/.test(b.id));
    const mLower = String(model || '').toLowerCase();
    const matchedScoped = scoped.find((b) => {
      const slug = b.id.replace(/^claude-weekly-/, '').toLowerCase();
      return slug && mLower.includes(slug);
    });
    const ordered = [
      ...base,
      ...(matchedScoped ? [matchedScoped] : scoped.slice(0, 1)),
      ...scoped.filter((b) => b !== matchedScoped && b !== scoped[0]),
    ];
    return {
      adapterId,
      title: 'Claude Code 한도',
      accent: meta.accent,
      sourceLabel: meta.sourceLabel,
      buckets: ordered,
      updatedAt,
      error,
      canToggleAgyPool: false,
    };
  }

  // Default: `agent-agy` (split into Gemini pool vs Antigravity Claude·GPT pool)
  const geminiBuckets = sortBucketsByWindow(rawBuckets.filter((b) => isAgyGeminiBucket(b)));
  const claudeGptBuckets = sortBucketsByWindow(rawBuckets.filter((b) => !isAgyGeminiBucket(b)));
  const inferred = inferAgyModelPool(model);
  const desired = agyPoolOverride ?? inferred;
  const activePool: 'gemini' | 'claude' =
    desired === 'claude'
      ? claudeGptBuckets.length > 0
        ? 'claude'
        : 'gemini'
      : geminiBuckets.length > 0
        ? 'gemini'
        : 'claude';
  const activeBuckets = activePool === 'gemini' ? geminiBuckets : claudeGptBuckets;

  return {
    adapterId,
    title: activePool === 'gemini' ? 'Gemini 한도' : '반중력 Claude·GPT',
    accent: activePool === 'gemini' ? '#3b82f6' : '#8b5cf6',
    sourceLabel: meta.sourceLabel,
    buckets: activeBuckets,
    updatedAt,
    error,
    canToggleAgyPool: geminiBuckets.length > 0 && claudeGptBuckets.length > 0,
    activeAgyPool: activePool,
  };
}

export interface GlobalProviderPool {
  readonly id: string;
  readonly label: string;
  readonly accent: string;
  readonly buckets: QuotaBucket[];
}

export interface GlobalProviderSummary {
  readonly adapterId: string;
  readonly meta: ProviderMeta;
  readonly installed: boolean;
  readonly pools: GlobalProviderPool[];
  readonly allBuckets: QuotaBucket[];
  readonly maxUsedPct: number | null;
  readonly hasWarning: boolean;
  readonly hasDanger: boolean;
  readonly updatedAt: string | null;
  readonly error?: string;
}

export function buildGlobalProviderSummaries(
  availableAdapters: ClientAgentAdapterDescriptor[],
  accountQuotaByAdapter: Record<string, AccountQuotaSnapshot>,
  legacyAgyQuota?: AccountQuotaSnapshot | null
): GlobalProviderSummary[] {
  const orderedIds: string[] = [
    BUILTIN_PLUGIN_IDS.AGENT_AGY,
    BUILTIN_PLUGIN_IDS.AGENT_CLAUDE,
    BUILTIN_PLUGIN_IDS.AGENT_CODEX,
  ];
  for (const a of availableAdapters) {
    if (!orderedIds.includes(a.id)) orderedIds.push(a.id);
  }
  const availableSet = new Set(availableAdapters.map((a) => a.id));

  return orderedIds.map((adapterId) => {
    const meta = getProviderMeta(adapterId);
    const snap =
      accountQuotaByAdapter[adapterId] ??
      (adapterId === BUILTIN_PLUGIN_IDS.AGENT_AGY ? legacyAgyQuota ?? null : null);
    const allBuckets = sortBucketsByWindow(snap?.buckets || []);
    const pools: GlobalProviderPool[] = [];

    if (adapterId === BUILTIN_PLUGIN_IDS.AGENT_AGY) {
      const gem = sortBucketsByWindow(allBuckets.filter((b) => isAgyGeminiBucket(b)));
      const clg = sortBucketsByWindow(allBuckets.filter((b) => !isAgyGeminiBucket(b)));
      if (gem.length > 0) pools.push({ id: 'agy-gemini', label: 'Gemini 모델 풀', accent: '#3b82f6', buckets: gem });
      if (clg.length > 0) pools.push({ id: 'agy-claude', label: 'Claude · GPT 풀', accent: '#8b5cf6', buckets: clg });
    } else if (adapterId === BUILTIN_PLUGIN_IDS.AGENT_CLAUDE) {
      const base = allBuckets.filter((b) => !/^claude-weekly-.+/.test(b.id));
      const scoped = allBuckets.filter((b) => /^claude-weekly-.+/.test(b.id));
      if (base.length > 0) pools.push({ id: 'claude-base', label: '구독 기본 한도', accent: '#d97706', buckets: base });
      if (scoped.length > 0) pools.push({ id: 'claude-scoped', label: '모델별 주간 한도', accent: '#f59e0b', buckets: scoped });
    } else {
      if (allBuckets.length > 0) {
        pools.push({
          id: `${adapterId}-main`,
          label: adapterId === BUILTIN_PLUGIN_IDS.AGENT_CODEX ? 'Codex 구독 한도' : '계정 한도',
          accent: meta.accent,
          buckets: allBuckets,
        });
      }
    }

    let maxUsedPct: number | null = null;
    let hasWarning = false;
    let hasDanger = false;
    for (const b of allBuckets) {
      if (b.remainingFraction == null) continue;
      const used = bucketUsedPct(b);
      if (maxUsedPct == null || used > maxUsedPct) maxUsedPct = used;
      if (used >= 85) hasDanger = true;
      const w = inferBucketWindow(b);
      const tick = b.remainingFraction >= 0.9999 ? null : computePaceTickPct(w, b.resetTime, b.resetInSeconds);
      if (used >= 70 || (tick != null && used > tick + 10)) hasWarning = true;
    }

    return {
      adapterId,
      meta,
      installed: availableSet.size === 0 || availableSet.has(adapterId),
      pools,
      allBuckets,
      maxUsedPct,
      hasWarning,
      hasDanger,
      updatedAt: snap?.updatedAt || null,
      error: snap?.error,
    };
  });
}

/** Opens or focuses the singleton global Token Band pane (`paneType: 'token-band'`). */
export function openGlobalTokenBandPane(opts?: { splitIfMissing?: boolean }): void {
  const layout = useLayoutStore.getState();
  for (const [groupId, group] of Object.entries(layout.groups)) {
    const found = group.tabs.find((t) => t.paneType === 'token-band');
    if (found) {
      layout.setActiveTab(groupId, found.id);
      return;
    }
  }
  if (opts?.splitIfMissing) {
    layout.openTab('token-band', undefined, { split: 'h', side: 'after' });
  } else {
    layout.openTab('token-band');
  }
}
