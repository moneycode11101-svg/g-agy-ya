import type { AgentModelOption } from '../../../src/shared/agentProtocol';

export interface RawClaudeSdkModelInfo {
  value?: string;
  resolvedModel?: string;
  displayName?: string;
  description?: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: readonly string[];
}

const CLAUDE_ALIAS_VALUES = new Set(['fable', 'opus', 'sonnet', 'haiku']);

function formatResolvedModelFallback(modelId?: string): string {
  if (!modelId) return '';
  const cleaned = modelId
    .replace(/^claude-/i, '')
    .replace(/-\d{8}$/, '')
    .trim();
  if (!cleaned) return '';
  const m = cleaned.match(/^([a-z]+)-(\d+)(?:-(\d+))?$/i);
  if (m) {
    const family = m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase();
    return m[3] ? `${family} ${m[2]}.${m[3]}` : `${family} ${m[2]}`;
  }
  return cleaned;
}

function formatClaudeDisplayLabel(rawDisplay: string, value: string): string {
  const base = rawDisplay.trim() || formatResolvedModelFallback(value) || value;
  if (/^claude\b/i.test(base)) return base;
  if (/^(fable|opus|sonnet|haiku)\b/i.test(base)) return `Claude ${base}`;
  return base;
}

/**
 * Normalizes live `ModelInfo[]` returned by `@anthropic-ai/claude-agent-sdk`
 * (`initializationResult().models` / `supportedModels()`) while preserving
 * Anthropic's official model ordering and per-model effort capabilities.
 */
export function normalizeClaudeSdkModels(raw: unknown): AgentModelOption[] {
  if (!Array.isArray(raw) || raw.length === 0) return [];

  const out: AgentModelOption[] = [];
  const seen = new Set<string>();

  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const item = entry as RawClaudeSdkModelInfo;
    const value = typeof item.value === 'string' ? item.value.trim() : '';
    if (!value || seen.has(value)) continue;
    seen.add(value);

    const resolvedModel =
      typeof item.resolvedModel === 'string' && item.resolvedModel.trim()
        ? item.resolvedModel.trim()
        : undefined;
    const rawDisplay = typeof item.displayName === 'string' ? item.displayName.trim() : '';
    const rawDesc = typeof item.description === 'string' ? item.description.trim() : '';

    const efforts =
      item.supportsEffort !== false && Array.isArray(item.supportedEffortLevels)
        ? item.supportedEffortLevels
            .map((e) => String(e || '').trim().toLowerCase())
            .filter(Boolean)
        : undefined;

    if (value === 'default') {
      const descLooksLikeModel =
        Boolean(rawDesc) && rawDesc.length <= 28 && /^(claude\s+)?(fable|opus|sonnet|haiku)\b/i.test(rawDesc);
      const resolvedLabel = descLooksLikeModel
        ? rawDesc.replace(/^claude\s+/i, '')
        : formatResolvedModelFallback(resolvedModel);
      out.push({
        value: 'default',
        label: resolvedLabel ? `기본 모델 (${resolvedLabel})` : '기본 모델 (Claude)',
        resolvedModel,
        description: rawDesc || undefined,
        badge: { label: '추천', tone: 'new' },
        supportedEfforts: efforts && efforts.length > 0 ? efforts : undefined,
      });
      continue;
    }

    const isLatestAlias = CLAUDE_ALIAS_VALUES.has(value.toLowerCase());
    out.push({
      value,
      label: formatClaudeDisplayLabel(rawDisplay, value),
      resolvedModel,
      description: rawDesc || undefined,
      ...(isLatestAlias ? { badge: { label: '최신', tone: 'new' as const } } : {}),
      supportedEfforts: efforts && efforts.length > 0 ? efforts : undefined,
    });
  }

  return out;
}
