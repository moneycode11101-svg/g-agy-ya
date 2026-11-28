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

  let defaultResolvedModel: string | undefined;
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const item = entry as RawClaudeSdkModelInfo;
    if (typeof item.value === 'string' && item.value.trim() === 'default') {
      if (typeof item.resolvedModel === 'string' && item.resolvedModel.trim()) {
        defaultResolvedModel = item.resolvedModel.trim();
      }
      break;
    }
  }

  const out: AgentModelOption[] = [];
  const seen = new Set<string>();
  let markedDefault = false;

  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const item = entry as RawClaudeSdkModelInfo;
    const value = typeof item.value === 'string' ? item.value.trim() : '';
    if (!value || value === 'default' || seen.has(value)) continue;
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
            .filter((e) => Boolean(e) && e !== 'default')
        : undefined;

    const isLatestAlias = CLAUDE_ALIAS_VALUES.has(value.toLowerCase());
    const matchesDefault =
      !markedDefault &&
      Boolean(defaultResolvedModel) &&
      (resolvedModel === defaultResolvedModel || value === defaultResolvedModel);
    if (matchesDefault) markedDefault = true;

    out.push({
      value,
      label: formatClaudeDisplayLabel(rawDisplay, value),
      resolvedModel,
      description: rawDesc || undefined,
      ...(matchesDefault ? { isDefault: true } : {}),
      ...(isLatestAlias ? { badge: { label: '최신', tone: 'new' as const } } : {}),
      supportedEfforts: efforts && efforts.length > 0 ? efforts : undefined,
    });
  }

  return out;
}
