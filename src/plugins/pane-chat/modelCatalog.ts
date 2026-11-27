import type { AgentModelOption } from '../../shared/agentProtocol';

export interface ModelVariant {
  readonly key: string;
  readonly value: string;
  readonly effort?: string;
  readonly rawLabel: string;
  readonly tierKey: string;
  readonly tierLabel: string;
}

export interface ModelFamilyGroup {
  readonly id: string;
  readonly name: string;
  readonly resolvedModel?: string;
  readonly description?: string;
  readonly variants: ModelVariant[];
  readonly defaultVariantValue: string;
  readonly defaultVariantEffort?: string;
  readonly badge?: { readonly label: string; readonly tone: 'new' | 'warn' | 'muted' };
  readonly isEffortSubmenu?: boolean;
}

export const TIER_KO: Record<string, string> = {
  default: '기본',
  low: '낮음',
  medium: '보통',
  high: '높음',
  xhigh: '매우 높음',
  max: '최대',
  ultra: '울트라',
  neon: 'Neon',
  carbon: 'Carbon',
  argon: 'Argon',
};

const TIER_ORDER: Record<string, number> = {
  default: 0,
  low: 1,
  medium: 2,
  high: 3,
  xhigh: 4,
  max: 5,
  ultra: 6,
  neon: 1,
  carbon: 2,
  argon: 3,
};

const AGY_FAMILY_ORDER: Record<string, number> = {
  'gemini-4-neon': 10,
  'gemini-4-carbon': 20,
  'gemini-4-argon': 30,
  'gemini-4-hydrogen': 40,
  orchestrator: 50,
  'gemini-3.8-flash': 60,
  'claude-opus-5-5': 70,
  'claude-sonnet-5-5': 80,
  'gpt-oss-120b': 90,
};

const AGY_FAMILY_BADGES: Record<string, { label: string; tone: 'new' | 'warn' | 'muted' }> = {
  'gemini-4-neon': { label: '최신', tone: 'new' },
  'gemini-4-carbon': { label: '최신', tone: 'new' },
  'gemini-4-argon': { label: '곧 지원 중단', tone: 'warn' },
  'gemini-4-hydrogen': { label: '최신', tone: 'new' },
  orchestrator: { label: '최신', tone: 'new' },
  'gemini-3.8-flash': { label: '곧 지원 중단', tone: 'warn' },
  'claude-opus-5-5': { label: '최신', tone: 'new' },
  'claude-sonnet-5-5': { label: '최신', tone: 'new' },
};

function parseModelOption(opt: AgentModelOption): {
  familyId: string;
  familyName: string;
  tierKey: string;
  tierLabel: string;
} {
  const val = opt.value;
  const lbl = opt.label;

  // Orchestrator group
  if (val.startsWith('gemini-pro-orchestrator') || /^orchestrator\b/i.test(lbl)) {
    const m = lbl.match(/\(([^)]+)\)/);
    const key = (m?.[1] || (val.endsWith('-neon') ? 'Neon' : val.endsWith('-argon') ? 'Argon' : 'Carbon')).toLowerCase();
    return {
      familyId: 'orchestrator',
      familyName: '오케스트레이터',
      tierKey: key,
      tierLabel: TIER_KO[key] || m?.[1] || 'Carbon',
    };
  }

  // Single fixed-tier model like GPT-OSS 120B (Medium)
  if (val.startsWith('gpt-oss')) {
    return {
      familyId: 'gpt-oss-120b',
      familyName: lbl,
      tierKey: 'medium',
      tierLabel: '',
    };
  }

  // Standard "Family Name (Tier)" pattern from `agy models`
  const paren = lbl.match(/^(.+?)\s*\((Low|Medium|High|XHigh|Max)\)$/i);
  if (paren) {
    const famName = paren[1].trim();
    const tierKey = paren[2].toLowerCase();
    const famId = val.replace(/-(low|medium|high|xhigh|max)$/i, '');
    return {
      familyId: famId,
      familyName: famName,
      tierKey,
      tierLabel: TIER_KO[tierKey] || paren[2],
    };
  }

  // Fallback for embedded-tier model ids
  const suffix = val.match(/^(.+)-(low|medium|high|xhigh|max)$/i);
  if (suffix) {
    const tierKey = suffix[2].toLowerCase();
    return {
      familyId: suffix[1],
      familyName: lbl,
      tierKey,
      tierLabel: TIER_KO[tierKey] || suffix[2],
    };
  }

  return {
    familyId: val,
    familyName: lbl,
    tierKey: 'default',
    tierLabel: '',
  };
}

/**
 * Groups flat `agy models` entries into families AND builds effort submenus for
 * Claude / Codex models that expose `supportedEfforts`, while preserving each
 * provider's official curated ordering.
 */
export function groupModelsIntoFamilies(models: readonly AgentModelOption[]): ModelFamilyGroup[] {
  const isAgyCatalog = models.some(
    (m) => m.value.startsWith('gemini-') || m.value.startsWith('gpt-oss')
  );

  const byFamily = new Map<
    string,
    {
      name: string;
      resolvedModel?: string;
      description?: string;
      badge?: { readonly label: string; readonly tone: 'new' | 'warn' | 'muted' };
      variants: ModelVariant[];
      isEffortSubmenu: boolean;
      firstSeenIndex: number;
    }
  >();

  models.forEach((opt, idx) => {
    if (!opt.value) return;

    // Models with separate `supportedEfforts` (Claude Code / Codex)
    if (Array.isArray(opt.supportedEfforts) && opt.supportedEfforts.length > 0) {
      const seenEfforts = new Set<string>();
      const effortItems: ModelVariant[] = [
        {
          key: `${opt.value}::default`,
          value: opt.value,
          effort: 'default',
          rawLabel: opt.label,
          tierKey: 'default',
          tierLabel: opt.defaultEffort
            ? `기본 (${TIER_KO[opt.defaultEffort.toLowerCase()] || opt.defaultEffort})`
            : '기본',
        },
      ];
      for (const rawEff of opt.supportedEfforts) {
        const eff = String(rawEff || '').trim().toLowerCase();
        if (!eff || eff === 'default' || seenEfforts.has(eff)) continue;
        seenEfforts.add(eff);
        effortItems.push({
          key: `${opt.value}::${eff}`,
          value: opt.value,
          effort: eff,
          rawLabel: `${opt.label} (${TIER_KO[eff] || eff})`,
          tierKey: eff,
          tierLabel: TIER_KO[eff] || eff,
        });
      }

      byFamily.set(opt.value, {
        name: opt.label,
        resolvedModel: opt.resolvedModel,
        description: opt.description,
        badge: opt.badge,
        variants: effortItems,
        isEffortSubmenu: effortItems.length > 1,
        firstSeenIndex: idx,
      });
      return;
    }

    const p = parseModelOption(opt);
    let bucket = byFamily.get(p.familyId);
    if (!bucket) {
      bucket = {
        name: p.familyName,
        resolvedModel: opt.resolvedModel,
        description: opt.description,
        badge: opt.badge ?? (isAgyCatalog ? AGY_FAMILY_BADGES[p.familyId] : undefined),
        variants: [],
        isEffortSubmenu: false,
        firstSeenIndex: idx,
      };
      byFamily.set(p.familyId, bucket);
    }
    if (!bucket.variants.some((v) => v.value === opt.value)) {
      bucket.variants.push({
        key: opt.value,
        value: opt.value,
        rawLabel: opt.label,
        tierKey: p.tierKey,
        tierLabel: p.tierLabel,
      });
    }
  });

  const groups: Array<{ group: ModelFamilyGroup; firstSeenIndex: number }> = [];
  for (const [id, bucket] of byFamily.entries()) {
    const sorted = [...bucket.variants].sort(
      (a, b) => (TIER_ORDER[a.tierKey] ?? 99) - (TIER_ORDER[b.tierKey] ?? 99)
    );

    let defaultVariantValue = sorted[0]?.value || id;
    let defaultVariantEffort: string | undefined;

    if (bucket.isEffortSubmenu) {
      defaultVariantValue = id;
      defaultVariantEffort = 'default';
    } else {
      // Prefer xhigh/high/medium/neon as sensible click default for embedded-tier `agy` families
      const preferred =
        sorted.find((v) => v.tierKey === 'xhigh') ||
        sorted.find((v) => v.tierKey === 'high') ||
        sorted.find((v) => v.tierKey === 'medium') ||
        sorted.find((v) => v.tierKey === 'neon') ||
        sorted[0];
      defaultVariantValue = preferred?.value || sorted[0]?.value || id;
      defaultVariantEffort = preferred?.effort;
    }

    groups.push({
      firstSeenIndex: bucket.firstSeenIndex,
      group: {
        id,
        name: bucket.name,
        resolvedModel: bucket.resolvedModel,
        description: bucket.description,
        variants: sorted,
        defaultVariantValue,
        defaultVariantEffort,
        badge: bucket.badge,
        isEffortSubmenu: bucket.isEffortSubmenu,
      },
    });
  }

  return groups
    .sort((a, b) => {
      if (a.group.id === 'default' && b.group.id !== 'default') return -1;
      if (b.group.id === 'default' && a.group.id !== 'default') return 1;
      if (isAgyCatalog) {
        const orderDiff = (AGY_FAMILY_ORDER[a.group.id] ?? 500) - (AGY_FAMILY_ORDER[b.group.id] ?? 500);
        if (orderDiff !== 0) return orderDiff;
      }
      return a.firstSeenIndex - b.firstSeenIndex;
    })
    .map((x) => x.group);
}

/** Formats any model value into a concise Korean label for the composer pill */
export function formatModelDisplayLabel(
  modelValue: string,
  models: readonly AgentModelOption[],
  adapterShortLabel = 'agy'
): string {
  if (!modelValue || modelValue === 'default') {
    const def = models.find((m) => m.value === 'default');
    if (def?.label) return def.label;
    return `기본 모델 (${adapterShortLabel})`;
  }
  const found =
    models.find((m) => m.value === modelValue) ||
    models.find((m) => m.value !== 'default' && m.resolvedModel === modelValue);
  if (!found) return modelValue;
  const p = parseModelOption(found);
  if (!p.tierLabel || p.familyName.includes(`(${p.tierLabel})`)) return p.familyName;
  return `${p.familyName} ${p.tierLabel}`;
}

export interface SlashCommandItem {
  readonly command: string;
  readonly description: string;
  readonly category: '내장 명령' | '스킬';
}

export const BUILTIN_SLASH_COMMANDS: readonly SlashCommandItem[] = [
  { command: '/compact', description: '대화 컨텍스트를 압축해 토큰 사용량을 줄입니다', category: '내장 명령' },
  { command: '/plan', description: '복잡한 작업을 실행 전 단계별로 계획합니다', category: '내장 명령' },
  { command: '/goal', description: '목표가 완전히 달성될 때까지 자율 반복 실행합니다', category: '내장 명령' },
  { command: '/grill-me', description: '질문 인터뷰로 설계 결정을 꼼꼼히 맞춥니다', category: '내장 명령' },
  { command: '/teamwork', description: '자율 에이전트 팀 협업으로 큰 작업을 진행합니다', category: '내장 명령' },
  { command: '/boost', description: '깊은 추론 · 다각도 분석 · 엄격 검증 모드', category: '내장 명령' },
  { command: '/learn', description: '교정 사항이나 설정을 규칙으로 영구 저장합니다', category: '내장 명령' },
  { command: '/schedule', description: '반복 스케줄 또는 일회성 타이머를 설정합니다', category: '내장 명령' },
  { command: '/browser', description: '웹 탐색 및 브라우저 자동화를 실행합니다', category: '내장 명령' },
  { command: '/usage', description: '계정 모델 사용량 및 한도를 조회합니다', category: '내장 명령' },
  { command: '/help', description: 'agy CLI 도움말을 확인합니다', category: '내장 명령' },
  { command: '/changelog', description: '최신 업데이트 변경 내역을 봅니다', category: '내장 명령' },
];
