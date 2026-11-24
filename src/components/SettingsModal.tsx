import React, { useEffect, useRef, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Monitor,
  Moon,
  Plus,
  RefreshCw,
  Search,
  Sun,
  Trash2,
  Volume2,
  X,
} from 'lucide-react';
import type {
  AppSettings,
  ChatWidthMode,
  CustomizationsInventory,
  GitDiffBase,
  PermissionPreset,
  ThemeMode,
  TranscriptViewMode,
} from '../shared/settingsTypes';
import { useSettingsStore, type SettingsTabId } from '../store/settingsStore';
import { useWorkspaceStore } from '../store/workspaceStore';
import { fmtReset, quotaBucketTitle } from '../utils/formatKo';
import { playCompletionChime } from '../utils/sound';

const ToggleSwitch: React.FC<{ checked: boolean; onChange: (next: boolean) => void }> = ({
  checked,
  onChange,
}) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    onClick={() => onChange(!checked)}
    className="relative inline-flex h-[24px] w-[42px] shrink-0 items-center rounded-full transition-colors cursor-pointer"
    style={{ background: checked ? 'var(--accent)' : 'color-mix(in srgb, var(--fg) 18%, transparent)' }}
  >
    <span
      className="inline-block h-[18px] w-[18px] rounded-full bg-white shadow transition-transform"
      style={{ transform: checked ? 'translateX(21px)' : 'translateX(3px)' }}
    />
  </button>
);

function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: Array<{ value: T; label: React.ReactNode }>;
  onChange: (v: T) => void;
}) {
  return (
    <div
      className="inline-flex items-center rounded-full p-0.5 border text-[12.5px]"
      style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            className="px-3 py-1 rounded-full cursor-pointer transition-all flex items-center justify-center gap-1"
            style={{
              background: active ? 'var(--card)' : 'transparent',
              color: active ? 'var(--fg)' : 'var(--muted)',
              fontWeight: active ? 600 : 400,
              boxShadow: active ? 'var(--shadow-sm)' : undefined,
            }}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

const SettingsCard: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div
    className="rounded-2xl border divide-y overflow-hidden"
    style={{ background: 'var(--card)', borderColor: 'var(--border)' }}
  >
    {children}
  </div>
);

const SettingsRow: React.FC<{
  title: string;
  desc?: React.ReactNode;
  right: React.ReactNode;
}> = ({ title, desc, right }) => (
  <div className="px-4 py-3.5 flex items-center justify-between gap-4" style={{ borderColor: 'var(--border)' }}>
    <div className="min-w-0">
      <div className="text-[13.5px] font-medium" style={{ color: 'var(--fg)' }}>
        {title}
      </div>
      {desc && (
        <div className="text-[12px] mt-0.5 leading-relaxed break-keep" style={{ color: 'var(--muted)' }}>
          {desc}
        </div>
      )}
    </div>
    <div className="shrink-0">{right}</div>
  </div>
);

const SelectPill: React.FC<{
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (v: string) => void;
}> = ({ value, options, onChange }) => (
  <select
    value={value}
    onChange={(e) => onChange(e.target.value)}
    className="px-3 py-1.5 rounded-xl border text-[12.5px] font-medium cursor-pointer outline-none"
    style={{
      background: 'var(--surface)',
      borderColor: 'var(--border)',
      color: 'var(--fg)',
    }}
  >
    {options.map((o) => (
      <option key={o.value} value={o.value}>
        {o.label}
      </option>
    ))}
  </select>
);

const DonutRing: React.FC<{ pct: number }> = ({ pct }) => {
  const clamped = Math.max(0, Math.min(100, pct));
  const r = 11;
  const c = 2 * Math.PI * r;
  const offset = c * (1 - clamped / 100);
  const strokeColor = clamped <= 15 ? 'var(--danger)' : clamped <= 40 ? 'var(--warn)' : '#4d8b31';
  return (
    <svg width="28" height="28" viewBox="0 0 28 28" className="-rotate-90">
      <circle cx="14" cy="14" r={r} fill="none" stroke="var(--border)" strokeWidth="3.2" />
      <circle
        cx="14"
        cy="14"
        r={r}
        fill="none"
        stroke={strokeColor}
        strokeWidth="3.2"
        strokeDasharray={c}
        strokeDashoffset={offset}
        strokeLinecap="round"
      />
    </svg>
  );
};

const CustomizationsSection: React.FC<{
  inventory: CustomizationsInventory | null;
  onRefresh: () => void;
}> = ({ inventory, onRefresh }) => {
  const [skillsOpen, setSkillsOpen] = useState(true);
  const [rulesExpanded, setRulesExpanded] = useState(false);

  const ruleTokens = inventory?.ruleTokens ?? 0;
  const otherTokens = (inventory?.skillTokens ?? 0) + (inventory?.mcpTokens ?? 0);
  const budget = 20_000;
  const rulePct = Math.min(100, Number(((ruleTokens / budget) * 100).toFixed(1)));
  const otherPct = Math.min(100, Number(((otherTokens / budget) * 100).toFixed(1)));
  const skillPct = Number((((inventory?.skillTokens ?? 0) / budget) * 100).toFixed(1));
  const mcpPct = Number((((inventory?.mcpTokens ?? 0) / budget) * 100).toFixed(1));

  return (
    <div className="space-y-5">
      <div>
        <div className="flex items-center justify-between mb-2">
          <div className="text-[13px] font-semibold">컨텍스트 토큰 예산 (실측 스캔)</div>
          <button
            type="button"
            onClick={onRefresh}
            className="p-1 rounded hover:bg-[var(--surface)] cursor-pointer"
            style={{ color: 'var(--muted)' }}
            title="다시 스캔"
          >
            <RefreshCw size={12} />
          </button>
        </div>

        <div
          className="rounded-2xl border p-4 space-y-3.5 text-[12.5px]"
          style={{ background: 'var(--card)', borderColor: 'var(--border)' }}
        >
          <p className="leading-relaxed" style={{ color: 'var(--muted)' }}>
            ~/.gemini/config/plugins 및 skills 디스크에서 로드되는 규칙 · 스킬 · MCP의 프롬프트 토큰량입니다.
          </p>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="font-medium">규칙</span>
              <span className="num text-[12px]" style={{ color: 'var(--muted)' }}>
                {ruleTokens.toLocaleString()} / 20,000 tokens ({rulePct}%)
              </span>
            </div>
            <div className="h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--surface)' }}>
              <div className="h-full rounded-full" style={{ width: `${Math.max(1, rulePct)}%`, background: '#3b82f6' }} />
            </div>
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="font-medium">스킬 · MCP</span>
              <span className="num text-[12px]" style={{ color: 'var(--muted)' }}>
                {otherTokens.toLocaleString()} / 20,000 tokens ({otherPct}%)
              </span>
            </div>
            <div className="h-1.5 rounded-full overflow-hidden flex" style={{ background: 'var(--surface)' }}>
              <div className="h-full" style={{ width: `${Math.min(100, skillPct)}%`, background: '#22c55e' }} />
              <div className="h-full" style={{ width: `${Math.min(100, mcpPct)}%`, background: '#9333ea' }} />
            </div>
          </div>

          <div className="pt-1 space-y-2 text-[12.5px]">
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full" style={{ background: '#3b82f6' }} />
                <span>규칙</span>
                <span className="num" style={{ color: 'var(--muted)' }}>
                  ({ruleTokens.toLocaleString()} tokens) {rulePct}%
                </span>
              </span>
              <button
                type="button"
                onClick={() => setRulesExpanded((v) => !v)}
                className="text-[12px] cursor-pointer hover:underline"
                style={{ color: 'var(--accent)' }}
              >
                세부 정보 {inventory?.ruleCount ?? 0}개 {rulesExpanded ? '숨기기' : '표시'}
              </button>
            </div>
            {rulesExpanded && inventory?.rules && (
              <div className="pl-4 space-y-1 text-[11.5px] font-mono" style={{ color: 'var(--muted)' }}>
                {inventory.rules.map((r) => (
                  <div key={r.path} className="flex justify-between">
                    <span className="truncate">{r.name}</span>
                    <span>{r.tokens} tok</span>
                  </div>
                ))}
              </div>
            )}

            <div className="flex items-center justify-between">
              <span className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full" style={{ background: '#22c55e' }} />
                <span>스킬</span>
                <span className="num" style={{ color: 'var(--muted)' }}>
                  ({(inventory?.skillTokens ?? 0).toLocaleString()} tokens) {skillPct}%
                </span>
              </span>
              <span className="text-[12px]" style={{ color: 'var(--muted)' }}>
                {inventory?.skillCount ?? 0}개 로드됨
              </span>
            </div>

            <div className="flex items-center justify-between">
              <span className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full" style={{ background: '#9333ea' }} />
                <span>MCP 서버</span>
                <span className="num" style={{ color: 'var(--muted)' }}>
                  ({(inventory?.mcpTokens ?? 0).toLocaleString()} tokens) {mcpPct}%
                </span>
              </span>
              <span className="text-[12px]" style={{ color: 'var(--muted)' }}>
                {inventory?.mcpCount ?? 0}개 서버
              </span>
            </div>
          </div>
        </div>
      </div>

      <div>
        <button
          type="button"
          onClick={() => setSkillsOpen((v) => !v)}
          className="flex items-center gap-2 mb-2 cursor-pointer"
        >
          <span className="text-[13px] font-semibold">설치된 스킬</span>
          <span
            className="px-1.5 py-0.5 rounded-md text-[11px] font-mono"
            style={{ background: 'var(--surface)', color: 'var(--muted)' }}
          >
            {inventory?.skillCount ?? 0}
          </span>
          {skillsOpen ? (
            <ChevronDown size={13} style={{ color: 'var(--muted)' }} />
          ) : (
            <ChevronRight size={13} style={{ color: 'var(--muted)' }} />
          )}
        </button>

        {skillsOpen && (
          <div className="space-y-2">
            {(inventory?.skills || []).map((sk) => (
              <div
                key={sk.name}
                className="rounded-xl border px-3.5 py-2.5"
                style={{ background: 'var(--card)', borderColor: 'var(--border)' }}
              >
                <div className="flex items-center gap-2">
                  <span className="text-[13px] font-semibold">{sk.name}</span>
                  <span
                    className="px-1.5 py-0.5 rounded text-[10.5px] font-medium"
                    style={{
                      background:
                        sk.scope === 'plugin'
                          ? 'color-mix(in srgb, #9333ea 12%, transparent)'
                          : 'color-mix(in srgb, var(--accent) 12%, transparent)',
                      color: sk.scope === 'plugin' ? '#7e22ce' : 'var(--accent)',
                    }}
                  >
                    {sk.scope === 'plugin' ? `플러그인: ${sk.pluginName}` : sk.scope === 'global' ? '전역' : '내장'}
                  </span>
                </div>
                <div className="text-[12px] mt-1 line-clamp-2 leading-relaxed" style={{ color: 'var(--muted)' }}>
                  {sk.description}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

const SHORTCUTS_LIST = [
  { group: '분할 및 패인', name: '오른쪽 분할 (새 창 선택)', keys: ['⌘', 'D'] },
  { group: '분할 및 패인', name: '아래 분할 (새 창 선택)', keys: ['⇧', '⌘', 'D'] },
  { group: '탐색', name: '새 채팅 탭', keys: ['⌘', 'N'] },
  { group: '탐색', name: '새 터미널 탭 (zsh)', keys: ['⇧', '⌘', 'T'] },
  { group: '탐색', name: '새 웹사이트 탭 (브라우저)', keys: ['⌘', 'T'] },
  { group: '탐색', name: 'Git Diff 탭', keys: ['⇧', '⌘', 'G'] },
  { group: '탐색', name: '탭 닫기', keys: ['⌘', 'W'] },
  { group: '탐색', name: '사이드바 토글', keys: ['⌘', 'B'] },
  { group: '탐색', name: '설정 열기', keys: ['⌘', ','] },
  { group: '채팅', name: '메시지 전송', keys: ['Enter / ⌘+Enter'] },
];

interface SearchableRow {
  id: string;
  tab: SettingsTabId;
  tabLabel: string;
  keywords: string;
  render: () => React.ReactNode;
}

export const SettingsModal: React.FC = () => {
  const modalOpen = useSettingsStore((s) => s.modalOpen);
  const closeSettings = useSettingsStore((s) => s.closeSettings);
  const activeTab = useSettingsStore((s) => s.activeTab);
  const setActiveTab = useSettingsStore((s) => s.setActiveTab);
  const settings = useSettingsStore((s) => s.settings);
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  const runtimeInfo = useSettingsStore((s) => s.runtimeInfo);
  const inventory = useSettingsStore((s) => s.inventory);
  const refreshInventory = useSettingsStore((s) => s.refreshInventory);
  const metricsBySession = useWorkspaceStore((s) => s.metricsBySession);
  const accountQuota = useWorkspaceStore((s) => s.accountQuota);
  const loadingQuota = useWorkspaceStore((s) => s.loadingQuota);
  const refreshAccountQuota = useWorkspaceStore((s) => s.refreshAccountQuota);

  const [globalQuery, setGlobalQuery] = useState('');
  const [cmdInput, setCmdInput] = useState('');
  const [clearedMsg, setClearedMsg] = useState(false);
  const searchRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (modalOpen) {
      void refreshAccountQuota(false);
    }
  }, [modalOpen, refreshAccountQuota]);

  useEffect(() => {
    if (!modalOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (globalQuery) setGlobalQuery('');
        else closeSettings();
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [modalOpen, closeSettings, globalQuery]);

  if (!modalOpen) return null;

  const set = (patch: Partial<AppSettings>) => void updateSettings(patch);
  const firstQuotaMetrics = Object.values(metricsBySession).find((m) => m.quotaBuckets.length > 0);
  const quotaBuckets =
    accountQuota && accountQuota.buckets.length > 0
      ? accountQuota.buckets
      : (firstQuotaMetrics?.quotaBuckets ?? []);

  const navItems: Array<{ id: SettingsTabId; label: string }> = [
    { id: 'general', label: '일반 · 입력' },
    { id: 'agent', label: '에이전트 · 모델' },
    { id: 'appearance', label: '화면 · 채팅' },
    { id: 'webview', label: '웹뷰 · Git' },
    { id: 'notify', label: '알림 · 단축키' },
    { id: 'custom', label: '스킬 · 프로젝트' },
  ];

  // Global searchable index (Orca + Claude best practice: search across ALL tabs and toggle inline!)
  const searchableRows: SearchableRow[] = [
    {
      id: 'sendKey',
      tab: 'general',
      tabLabel: '일반 · 입력',
      keywords: '메시지 보내기 전송 키 enter cmd+enter 입력',
      render: () => (
        <SettingsRow
          title="메시지 보내기 키"
          desc="채팅 입력창에서 메시지를 전송할 키를 선택합니다."
          right={
            <SegmentedControl
              value={settings.sendKey}
              onChange={(v) => set({ sendKey: v })}
              options={[
                { value: 'enter', label: '입력 (Enter)' },
                { value: 'cmd-enter', label: 'Cmd+Enter' },
              ]}
            />
          }
        />
      ),
    },
    {
      id: 'pendingMessageMode',
      tab: 'general',
      tabLabel: '일반 · 입력',
      keywords: '대기 중인 메시지 후속 대기열 즉시 전송 큐',
      render: () => (
        <SettingsRow
          title="응답 중 후속 메시지"
          desc="에이전트가 응답 중일 때 보낸 메시지를 대기열에 쌓거나 즉시 중단 후 보냅니다."
          right={
            <SegmentedControl
              value={settings.pendingMessageMode}
              onChange={(v) => set({ pendingMessageMode: v })}
              options={[
                { value: 'queue', label: '대기열에 추가' },
                { value: 'immediate', label: '즉시 보내기' },
              ]}
            />
          }
        />
      ),
    },
    {
      id: 'confirmCloseRunning',
      tab: 'general',
      tabLabel: '일반 · 입력',
      keywords: '실행 중인 채팅 닫기 확인 탭 안전장치 cmd+w',
      render: () => (
        <SettingsRow
          title="실행 중인 채팅 닫기 전 확인"
          desc="응답을 생성 중인 채팅 탭을 닫을 때 중단 확인 대화상자를 표시합니다."
          right={
            <ToggleSwitch
              checked={settings.confirmCloseRunning}
              onChange={(v) => set({ confirmCloseRunning: v })}
            />
          }
        />
      ),
    },
    {
      id: 'defaultCwd',
      tab: 'general',
      tabLabel: '일반 · 입력',
      keywords: '기본 작업 디렉터리 폴더 워크스페이스 경로 cwd',
      render: () => (
        <SettingsRow
          title="기본 작업 디렉터리"
          desc={<span className="font-mono text-[11.5px]">{settings.defaultCwd}</span>}
          right={
            <button
              type="button"
              onClick={async () => {
                const dir = await window.agyDesk?.pickDirectory();
                if (dir) set({ defaultCwd: dir });
              }}
              className="px-3 py-1 rounded-lg text-[12px] font-medium cursor-pointer"
              style={{ background: 'var(--surface)', color: 'var(--fg)' }}
            >
              변경...
            </button>
          }
        />
      ),
    },
    {
      id: 'preventSleep',
      tab: 'general',
      tabLabel: '일반 · 입력',
      keywords: '절전 모드 방지 잠자기 powerSaveBlocker',
      render: () => (
        <SettingsRow
          title="절전 모드 방지"
          desc="앱이 실행되는 동안 Mac이 절전 모드로 전환되지 않도록 유지합니다."
          right={<ToggleSwitch checked={settings.preventSleep} onChange={(v) => set({ preventSleep: v })} />}
        />
      ),
    },
    {
      id: 'keepInMenuBar',
      tab: 'general',
      tabLabel: '일반 · 입력',
      keywords: '메뉴 막대 유지 트레이 tray 백그라운드',
      render: () => (
        <SettingsRow
          title="메뉴 막대에 유지 (Tray)"
          desc="창을 닫아도 상단 메뉴 막대에서 앱을 바로 다시 열 수 있게 유지합니다."
          right={<ToggleSwitch checked={settings.keepInMenuBar} onChange={(v) => set({ keepInMenuBar: v })} />}
        />
      ),
    },
    {
      id: 'defaultModel',
      tab: 'agent',
      tabLabel: '에이전트 · 모델',
      keywords: '기본 모델 neon claude opus sonnet model',
      render: () => (
        <SettingsRow
          title="기본 모델"
          desc="새 대화 시작 시 agy --model 기본값으로 사용합니다."
          right={
            <SelectPill
              value={settings.defaultModel}
              onChange={(v) => set({ defaultModel: v })}
              options={[
                { value: 'gemini-4-neon-xhigh', label: 'Gemini 4 Neon 매우 높음' },
                { value: 'gemini-4-neon-high', label: 'Gemini 4 Neon 높음' },
                { value: 'gemini-4-neon-medium', label: 'Gemini 4 Neon 보통' },
                { value: 'claude-sonnet-5-5-high', label: 'Claude Sonnet 5.5' },
                { value: 'claude-opus-5-5-high', label: 'Claude Opus 5.5' },
              ]}
            />
          }
        />
      ),
    },
    {
      id: 'defaultEffort',
      tab: 'agent',
      tabLabel: '에이전트 · 모델',
      keywords: 'effort 추론 에포트 기본 높음 보통 낮음',
      render: () => (
        <SettingsRow
          title="기본 Effort"
          desc="새 대화 시작 시 agy --effort 기본값입니다."
          right={
            <SelectPill
              value={settings.defaultEffort}
              onChange={(v) => set({ defaultEffort: v })}
              options={[
                { value: 'default', label: '모델 기본' },
                { value: 'low', label: '낮음 (low)' },
                { value: 'medium', label: '보통 (medium)' },
                { value: 'high', label: '높음 (high)' },
                { value: 'xhigh', label: '매우 높음 (xhigh)' },
              ]}
            />
          }
        />
      ),
    },
    {
      id: 'warnOnCacheReset',
      tab: 'agent',
      tabLabel: '에이전트 · 모델',
      keywords: '캐시 초기화 경고 모델 effort 변경 cache',
      render: () => (
        <SettingsRow
          title="모델·Effort 변경 시 캐시 초기화 경고"
          desc="진행 중인 대화에서 모델이나 Effort를 바꿀 때 캐시가 0%로 초기화됨을 미리 알려줍니다."
          right={<ToggleSwitch checked={settings.warnOnCacheReset} onChange={(v) => set({ warnOnCacheReset: v })} />}
        />
      ),
    },
    {
      id: 'localPermission',
      tab: 'agent',
      tabLabel: '에이전트 · 모델',
      keywords: '권한 터보 자동 샌드박스 계획 편집 permissions sandbox',
      render: () => (
        <SettingsRow
          title="로컬 실행 권한"
          desc="agy CLI 실행 시 권한 플래그(--dangerously-skip-permissions / --sandbox)에 직접 반영됩니다."
          right={
            <SelectPill
              value={settings.localPermission}
              onChange={(v) => set({ localPermission: v as PermissionPreset, defaultMode: v as PermissionPreset })}
              options={[
                { value: 'turbo', label: '터보 (자동 허용)' },
                { value: 'accept-edits', label: '편집 자동 허용' },
                { value: 'plan', label: '계획 전용' },
                { value: 'strict', label: '엄격 (샌드박스)' },
              ]}
            />
          }
        />
      ),
    },
    {
      id: 'theme',
      tab: 'appearance',
      tabLabel: '화면 · 채팅',
      keywords: '테마 밝음 어두움 다크모드 라이트모드 시스템 theme',
      render: () => (
        <SettingsRow
          title="테마"
          right={
            <SegmentedControl<ThemeMode>
              value={settings.theme}
              onChange={(v) => set({ theme: v })}
              options={[
                { value: 'system', label: <Monitor size={14} /> },
                { value: 'light', label: <Sun size={14} /> },
                { value: 'dark', label: <Moon size={14} /> },
              ]}
            />
          }
        />
      ),
    },
    {
      id: 'contrast',
      tab: 'appearance',
      tabLabel: '화면 · 채팅',
      keywords: '대비 고대비 contrast 테두리',
      render: () => (
        <SettingsRow
          title="대비"
          right={
            <SegmentedControl
              value={settings.contrast}
              onChange={(v) => set({ contrast: v })}
              options={[
                { value: 'default', label: '기본값' },
                { value: 'high', label: '강함' },
              ]}
            />
          }
        />
      ),
    },
    {
      id: 'transcriptView',
      tab: 'appearance',
      tabLabel: '화면 · 채팅',
      keywords: '트랜스크립트 보기 대화 단계 사고 과정 도구 펼침 상세',
      render: () => (
        <SettingsRow
          title="트랜스크립트 보기 단계"
          desc="채팅에 표시할 사고 과정 및 도구 호출 세부 수준을 선택합니다."
          right={
            <SegmentedControl<TranscriptViewMode>
              value={settings.transcriptView}
              onChange={(v) => set({ transcriptView: v })}
              options={[
                { value: 'normal', label: '일반' },
                { value: 'thinking', label: '사고 과정' },
                { value: 'detailed', label: '상세' },
              ]}
            />
          }
        />
      ),
    },
    {
      id: 'chatWidth',
      tab: 'appearance',
      tabLabel: '화면 · 채팅',
      keywords: '채팅 너비 컬럼 폭 좁음 보통 넓음 width',
      render: () => (
        <SettingsRow
          title="채팅 컬럼 너비"
          desc="대화 본문과 입력창의 최대 가로 폭을 조절합니다."
          right={
            <SegmentedControl<ChatWidthMode>
              value={settings.chatWidth}
              onChange={(v) => set({ chatWidth: v })}
              options={[
                { value: 'narrow', label: '좁음' },
                { value: 'medium', label: '보통' },
                { value: 'wide', label: '넓음' },
              ]}
            />
          }
        />
      ),
    },
    {
      id: 'showTokenBar',
      tab: 'appearance',
      tabLabel: '화면 · 채팅',
      keywords: '토큰 바 4칸 컨텍스트 캐시 표시 token bar',
      render: () => (
        <SettingsRow
          title="입력창 위 4칸 토큰 바 표시"
          desc="현재 컨텍스트·캐시 적중률·직전 턴·누적량을 입력창 바로 위에 표시합니다."
          right={<ToggleSwitch checked={settings.showTokenBar} onChange={(v) => set({ showTokenBar: v })} />}
        />
      ),
    },
    {
      id: 'newRoomWarnPct',
      tab: 'appearance',
      tabLabel: '화면 · 채팅',
      keywords: '새 방 권장 임계치 컨텍스트 경고 퍼센트',
      render: () => (
        <SettingsRow
          title="새 방 권장 경고 기준"
          desc="컨텍스트 사용률이 이 비율을 넘으면 토큰 바에 '새 방 권장'을 강조합니다."
          right={
            <div className="flex items-center gap-3 w-40">
              <input
                type="range"
                min={15}
                max={80}
                step={5}
                value={settings.newRoomWarnPct}
                onChange={(e) => set({ newRoomWarnPct: Number(e.target.value) })}
                className="flex-1 accent-[var(--accent)] cursor-pointer"
              />
              <span className="num text-xs w-9 text-right font-semibold">{settings.newRoomWarnPct}%</span>
            </div>
          }
        />
      ),
    },
    {
      id: 'linkOpenTarget',
      tab: 'webview',
      tabLabel: '웹뷰 · Git',
      keywords: '링크 열기 위치 외부 내장 브라우저 웹뷰 link',
      render: () => (
        <SettingsRow
          title="링크 열기 위치"
          desc="채팅이나 웹뷰에서 새 창 링크를 클릭할 때 열릴 위치를 선택합니다."
          right={
            <SegmentedControl
              value={settings.linkOpenTarget}
              onChange={(v) => set({ linkOpenTarget: v })}
              options={[
                { value: 'external', label: '외부 브라우저' },
                { value: 'embedded', label: '내장 웹뷰' },
              ]}
            />
          }
        />
      ),
    },
    {
      id: 'defaultWebviewUrl',
      tab: 'webview',
      tabLabel: '웹뷰 · Git',
      keywords: '웹뷰 기본 주소 url localhost',
      render: () => (
        <SettingsRow
          title="새 웹뷰 기본 URL"
          desc="웹뷰 분할 버튼을 누를 때 처음 로드할 주소입니다."
          right={
            <input
              value={settings.defaultWebviewUrl}
              onChange={(e) => set({ defaultWebviewUrl: e.target.value })}
              className="w-48 px-2.5 py-1 rounded-lg border font-mono text-xs outline-none"
              style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}
            />
          }
        />
      ),
    },
    {
      id: 'downloadDir',
      tab: 'webview',
      tabLabel: '웹뷰 · Git',
      keywords: '다운로드 위치 폴더 저장 download',
      render: () => (
        <SettingsRow
          title="다운로드 위치"
          desc={<span className="font-mono text-[11.5px]">{settings.downloadDir}</span>}
          right={
            <button
              type="button"
              onClick={async () => {
                const dir = await window.agyDesk?.pickDirectory();
                if (dir) set({ downloadDir: dir });
              }}
              className="px-3 py-1 rounded-lg text-[12px] font-medium cursor-pointer"
              style={{ background: 'var(--surface)', color: 'var(--fg)' }}
            >
              변경...
            </button>
          }
        />
      ),
    },
    {
      id: 'gitDiffBase',
      tab: 'webview',
      tabLabel: '웹뷰 · Git',
      keywords: 'git diff 비교 기준 워킹 트리 head',
      render: () => (
        <SettingsRow
          title="Git Diff 기본 비교 기준"
          desc="Diff 패인에서 unstaged 변경만 볼지 HEAD 전체 변경을 볼지 선택합니다."
          right={
            <SegmentedControl<GitDiffBase>
              value={settings.gitDiffBase}
              onChange={(v) => set({ gitDiffBase: v })}
              options={[
                { value: 'working', label: '워킹 트리' },
                { value: 'head', label: 'HEAD 전체' },
              ]}
            />
          }
        />
      ),
    },
    {
      id: 'notificationsEnabled',
      tab: 'notify',
      tabLabel: '알림 · 단축키',
      keywords: '알림 완료 macOS notification',
      render: () => (
        <SettingsRow
          title="에이전트 완료 알림"
          desc="창이 백그라운드에 있을 때 응답이 완료되면 macOS 시스템 알림을 표시합니다."
          right={
            <ToggleSwitch
              checked={settings.notificationsEnabled}
              onChange={(v) => set({ notificationsEnabled: v })}
            />
          }
        />
      ),
    },
    {
      id: 'soundEnabled',
      tab: 'notify',
      tabLabel: '알림 · 단축키',
      keywords: '사운드 효과음 소리 볼륨 sound chime',
      render: () => (
        <SettingsRow
          title="완료 알림 사운드"
          desc="응답이 완료될 때 부드러운 효과음을 재생합니다."
          right={
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => playCompletionChime(settings.soundVolume)}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11.5px] cursor-pointer"
                style={{ background: 'var(--surface)', color: 'var(--fg-soft)' }}
                title="알림음 미리듣기"
              >
                <Volume2 size={12} />
                <span>테스트</span>
              </button>
              <ToggleSwitch checked={settings.soundEnabled} onChange={(v) => set({ soundEnabled: v })} />
            </div>
          }
        />
      ),
    },
  ];

  const q = globalQuery.trim().toLowerCase();
  const searchMatches = q
    ? searchableRows.filter((r) => `${r.tabLabel} ${r.keywords}`.toLowerCase().includes(q))
    : [];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-6"
      style={{ background: 'rgba(15, 23, 42, 0.28)', backdropFilter: 'blur(2px)' }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) closeSettings();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="설정"
        className="w-[920px] max-w-[92vw] h-[720px] max-h-[88vh] rounded-2xl border flex overflow-hidden"
        style={{
          background: 'var(--card)',
          borderColor: 'var(--border)',
          boxShadow: 'var(--shadow-popover)',
        }}
      >
        {/* 좌측: 통합 검색(Orca+Claude) + 6개 핵심 탭 */}
        <nav
          className="w-[216px] shrink-0 border-r flex flex-col justify-between p-3 select-none"
          style={{ background: 'var(--sidebar)', borderColor: 'var(--border)' }}
        >
          <div className="space-y-3 overflow-y-auto scroll-thin">
            <div
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl border text-xs"
              style={{ background: 'var(--card)', borderColor: 'var(--border)' }}
            >
              <Search size={13} style={{ color: 'var(--muted)' }} />
              <input
                ref={searchRef}
                value={globalQuery}
                onChange={(e) => setGlobalQuery(e.target.value)}
                placeholder="설정 검색 (⌘F)"
                aria-label="설정 검색"
                className="w-full bg-transparent outline-none text-[12.5px]"
              />
              {globalQuery && (
                <button
                  type="button"
                  onClick={() => setGlobalQuery('')}
                  className="cursor-pointer opacity-60 hover:opacity-100"
                >
                  ✕
                </button>
              )}
            </div>

            <div className="space-y-0.5">
              {navItems.map((n) => {
                const active = !q && activeTab === n.id;
                return (
                  <button
                    key={n.id}
                    type="button"
                    onClick={() => {
                      setGlobalQuery('');
                      setActiveTab(n.id);
                    }}
                    className="w-full text-left px-3 py-1.5 rounded-lg text-[13px] cursor-pointer transition-colors hover:bg-[var(--surface-active)]"
                    style={{
                      background: active ? 'var(--surface-active)' : 'transparent',
                      color: active ? 'var(--fg)' : 'var(--fg-soft)',
                      fontWeight: active ? 600 : 400,
                    }}
                  >
                    {n.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="pt-3 border-t space-y-1.5" style={{ borderColor: 'var(--border)' }}>
            <div className="flex items-center gap-2.5 px-2 py-1">
              <div
                className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold text-white shrink-0"
                style={{ background: 'var(--accent)' }}
              >
                {(runtimeInfo?.email?.[0] || 'A').toUpperCase()}
              </div>
              <div className="min-w-0">
                <div className="text-[12.5px] font-semibold truncate">반중력GUI {runtimeInfo?.appVersion || '0.1.0'}</div>
                <div className="text-[11px] truncate" style={{ color: 'var(--muted)' }}>
                  {runtimeInfo?.email || `agy CLI ${runtimeInfo?.agyCliVersion || ''}`}
                </div>
              </div>
            </div>
          </div>
        </nav>

        {/* 우측 본문 */}
        <div className="flex-1 min-w-0 flex flex-col relative">
          <button
            type="button"
            onClick={closeSettings}
            className="absolute top-4 right-4 p-1.5 rounded-lg hover:bg-[var(--surface)] cursor-pointer z-10"
            style={{ color: 'var(--muted)' }}
            title="닫기 (Esc)"
          >
            <X size={16} />
          </button>

          <div className="flex-1 min-h-0 overflow-y-auto scroll-thin px-10 py-8">
            <div className="max-w-[580px] space-y-6">
              {/* 글로벌 검색 결과 뷰 */}
              {q ? (
                <>
                  <div>
                    <h2 className="text-[18px] font-semibold">검색 결과 ({searchMatches.length})</h2>
                    <p className="text-[13px] mt-1" style={{ color: 'var(--muted)' }}>
                      "{globalQuery}"와 일치하는 설정 항목을 바로 변경할 수 있습니다.
                    </p>
                  </div>
                  {searchMatches.length > 0 ? (
                    <SettingsCard>
                      {searchMatches.map((m) => (
                        <div key={m.id}>{m.render()}</div>
                      ))}
                    </SettingsCard>
                  ) : (
                    <div className="py-12 text-center text-xs" style={{ color: 'var(--muted)' }}>
                      일치하는 설정 항목이 없습니다.
                    </div>
                  )}
                </>
              ) : (
                <>
                  {/* 1. 일반 · 입력 */}
                  {activeTab === 'general' && (
                    <>
                      <div>
                        <h2 className="text-[18px] font-semibold">일반 및 입력</h2>
                        <p className="text-[13px] mt-1" style={{ color: 'var(--muted)' }}>
                          메시지 전송 방식, 탭 안전장치, 기본 작업 폴더 및 macOS 상주 동작을 구성합니다.
                        </p>
                      </div>

                      <div className="space-y-2">
                        <div className="text-[13px] font-semibold">입력 & 탭 안전장치</div>
                        <SettingsCard>
                          {searchableRows.find((r) => r.id === 'sendKey')!.render()}
                          {searchableRows.find((r) => r.id === 'pendingMessageMode')!.render()}
                          {searchableRows.find((r) => r.id === 'confirmCloseRunning')!.render()}
                        </SettingsCard>
                      </div>

                      <div className="space-y-2">
                        <div className="text-[13px] font-semibold">워크스페이스 & 앱</div>
                        <SettingsCard>
                          {searchableRows.find((r) => r.id === 'defaultCwd')!.render()}
                          {searchableRows.find((r) => r.id === 'preventSleep')!.render()}
                          {searchableRows.find((r) => r.id === 'keepInMenuBar')!.render()}
                          <SettingsRow
                            title="앱 · CLI 버전"
                            right={
                              <span className="font-mono text-[12.5px]" style={{ color: 'var(--muted)' }}>
                                v{runtimeInfo?.appVersion || '0.1.0'} · agy {runtimeInfo?.agyCliVersion || ''}
                              </span>
                            }
                          />
                        </SettingsCard>
                      </div>
                    </>
                  )}

                  {/* 2. 에이전트 · 모델 */}
                  {activeTab === 'agent' && (
                    <>
                      <div>
                        <h2 className="text-[18px] font-semibold">에이전트 및 모델</h2>
                        <p className="text-[13px] mt-1" style={{ color: 'var(--muted)' }}>
                          agy CLI 실행 플래그, 로컬 권한, 캐시 보호 및 공식 할당량을 관리합니다.
                        </p>
                      </div>

                      <div className="space-y-2">
                        <div className="text-[13px] font-semibold">기본 모델 & 캐시 보호</div>
                        <SettingsCard>
                          {searchableRows.find((r) => r.id === 'defaultModel')!.render()}
                          {searchableRows.find((r) => r.id === 'defaultEffort')!.render()}
                          {searchableRows.find((r) => r.id === 'warnOnCacheReset')!.render()}
                        </SettingsCard>
                      </div>

                      <div className="space-y-2">
                        <div className="text-[13px] font-semibold">로컬 실행 권한 (agy CLI)</div>
                        <SettingsCard>
                          {searchableRows.find((r) => r.id === 'localPermission')!.render()}
                          <div className="px-4 py-3.5 space-y-2.5">
                            <div>
                              <div className="text-[13.5px] font-medium">허용 명령 규칙</div>
                              <div className="text-[12px] mt-0.5" style={{ color: 'var(--muted)' }}>
                                실행 시 <code>agy --settings permissions.allow</code>로 직접 전달됩니다.
                              </div>
                            </div>
                            <form
                              className="flex gap-1.5 text-xs"
                              onSubmit={(e) => {
                                e.preventDefault();
                                const v = cmdInput.trim();
                                if (!v) return;
                                set({ allowedCommands: [...settings.allowedCommands, v] });
                                setCmdInput('');
                              }}
                            >
                              <input
                                value={cmdInput}
                                onChange={(e) => setCmdInput(e.target.value)}
                                placeholder="예: npm test, git status"
                                className="flex-1 px-2.5 py-1.5 rounded-lg border font-mono outline-none"
                                style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}
                              />
                              <button
                                type="submit"
                                className="px-3 py-1 rounded-lg font-medium cursor-pointer"
                                style={{ background: 'var(--fg)', color: 'var(--bg)' }}
                              >
                                추가
                              </button>
                            </form>
                            {settings.allowedCommands.length > 0 && (
                              <div className="flex flex-wrap gap-1.5 text-xs">
                                {settings.allowedCommands.map((cmd, idx) => (
                                  <span
                                    key={`${cmd}-${idx}`}
                                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md border font-mono"
                                    style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}
                                  >
                                    {cmd}
                                    <button
                                      type="button"
                                      onClick={() =>
                                        set({ allowedCommands: settings.allowedCommands.filter((_, i) => i !== idx) })
                                      }
                                      className="cursor-pointer opacity-60 hover:opacity-100"
                                    >
                                      ✕
                                    </button>
                                  </span>
                                ))}
                              </div>
                            )}
                          </div>
                        </SettingsCard>
                      </div>

                      <div className="space-y-2">
                        <div className="flex items-center justify-between">
                          <div className="text-[13px] font-semibold">할당량 현황</div>
                          <button
                            type="button"
                            onClick={() => void refreshAccountQuota(true)}
                            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg text-[11.5px] cursor-pointer hover:bg-[var(--surface)]"
                            style={{ color: 'var(--muted)' }}
                          >
                            <RefreshCw size={11} className={loadingQuota ? 'animate-spin' : ''} />
                            <span>새로고침</span>
                          </button>
                        </div>
                        <SettingsCard>
                          {quotaBuckets.length > 0 ? (
                            quotaBuckets.map((b) => {
                              const unused = b.remainingFraction != null && b.remainingFraction >= 0.9999;
                              const remPct = b.remainingFraction != null ? Math.round(b.remainingFraction * 100) : 100;
                              const usedPct = 100 - remPct;
                              const reset = unused ? '' : fmtReset(b.resetInSeconds, b.resetTime);
                              return (
                                <SettingsRow
                                  key={b.id}
                                  title={quotaBucketTitle(b)}
                                  desc={
                                    unused
                                      ? '미사용 · 0% 사용 (첫 요청 시 타이머 시작)'
                                      : reset
                                        ? `${reset} 초기화 · ${usedPct}% 사용`
                                        : `${usedPct}% 사용 · agy /usage 기준`
                                  }
                                  right={
                                    <div className="flex items-center gap-2.5">
                                      <span className="num text-[14px] font-semibold">{remPct}% 남음</span>
                                      <DonutRing pct={remPct} />
                                    </div>
                                  }
                                />
                              );
                            })
                          ) : (
                            <SettingsRow
                              title="CLI 공식 할당량 동기화 대기"
                              desc="agy /usage에서 주간/5시간 한도(%)를 불러오는 중입니다."
                              right={<DonutRing pct={100} />}
                            />
                          )}
                        </SettingsCard>
                      </div>
                    </>
                  )}

                  {/* 3. 화면 · 채팅 */}
                  {activeTab === 'appearance' && (
                    <>
                      <div>
                        <h2 className="text-[18px] font-semibold">화면 및 채팅 표시</h2>
                        <p className="text-[13px] mt-1" style={{ color: 'var(--muted)' }}>
                          테마·글꼴·채팅 컬럼 너비·트랜스크립트 단계와 토큰 바가 실시간으로 적용됩니다.
                        </p>
                      </div>

                      <div className="space-y-2">
                        <div className="text-[13px] font-semibold">채팅 & 토큰 바</div>
                        <SettingsCard>
                          {searchableRows.find((r) => r.id === 'transcriptView')!.render()}
                          {searchableRows.find((r) => r.id === 'chatWidth')!.render()}
                          {searchableRows.find((r) => r.id === 'showTokenBar')!.render()}
                          {searchableRows.find((r) => r.id === 'newRoomWarnPct')!.render()}
                        </SettingsCard>
                      </div>

                      <div className="space-y-2">
                        <div className="text-[13px] font-semibold">테마 & 타이포그래피</div>
                        <SettingsCard>
                          {searchableRows.find((r) => r.id === 'theme')!.render()}
                          {searchableRows.find((r) => r.id === 'contrast')!.render()}
                          <SettingsRow
                            title="글꼴"
                            right={
                              <SelectPill
                                value={settings.fontFamily}
                                onChange={(v) => set({ fontFamily: v })}
                                options={[
                                  { value: 'System UI', label: 'System UI' },
                                  { value: 'Pretendard', label: 'Pretendard' },
                                  { value: 'SF Pro', label: 'SF Pro' },
                                  { value: 'JetBrains Mono', label: 'JetBrains Mono' },
                                ]}
                              />
                            }
                          />
                          <SettingsRow
                            title="글꼴 크기"
                            right={
                              <SelectPill
                                value={String(settings.fontSizePx)}
                                onChange={(v) => set({ fontSizePx: Number(v) })}
                                options={[
                                  { value: '13', label: '13px' },
                                  { value: '14', label: '14px' },
                                  { value: '15', label: '15px' },
                                  { value: '16', label: '16px' },
                                ]}
                              />
                            }
                          />
                        </SettingsCard>
                      </div>

                      <div className="space-y-2">
                        <div className="text-[13px] font-semibold">
                          {settings.theme === 'dark' ? '어두운 테마 색상' : '밝은 테마 색상'}
                        </div>
                        <SettingsCard>
                          <SettingsRow
                            title="프리셋"
                            right={
                              <SelectPill
                                value={settings.lightPreset}
                                onChange={(v) => {
                                  if (v === '기본 밝은 테마') {
                                    set({ lightPreset: v, theme: 'light', lightBg: '#FFFFFF', lightFg: '#0A0A0C', lightAccent: '#2F75C3' });
                                  } else if (v === '따뜻한 종이') {
                                    set({ lightPreset: v, theme: 'light', lightBg: '#FAF8F5', lightFg: '#1F1B16', lightAccent: '#B45309' });
                                  } else if (v === '기본 어두운 테마') {
                                    set({ lightPreset: v, theme: 'dark', darkBg: '#111317', darkFg: '#EEF1F6', darkAccent: '#4C8DFF' });
                                  }
                                }}
                                options={[
                                  { value: '기본 밝은 테마', label: '기본 밝은 테마' },
                                  { value: '따뜻한 종이', label: '따뜻한 종이' },
                                  { value: '기본 어두운 테마', label: '기본 어두운 테마' },
                                ]}
                              />
                            }
                          />
                          {(
                            [
                              ['배경색', 'lightBg', 'darkBg'],
                              ['전경색', 'lightFg', 'darkFg'],
                              ['강조 색상', 'lightAccent', 'darkAccent'],
                            ] as const
                          ).map(([lbl, lKey, dKey]) => {
                            const val = settings.theme === 'dark' ? settings[dKey] : settings[lKey];
                            return (
                              <SettingsRow
                                key={lbl}
                                title={lbl}
                                right={
                                  <label
                                    className="inline-flex items-center gap-2 px-2.5 py-1 rounded-xl border text-xs font-mono cursor-pointer"
                                    style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}
                                  >
                                    <input
                                      type="color"
                                      value={val}
                                      onChange={(e) =>
                                        set(settings.theme === 'dark' ? { [dKey]: e.target.value } : { [lKey]: e.target.value })
                                      }
                                      className="w-4 h-4 rounded border-0 bg-transparent cursor-pointer"
                                    />
                                    <span>{val.toUpperCase()}</span>
                                  </label>
                                }
                              />
                            );
                          })}
                        </SettingsCard>
                      </div>
                    </>
                  )}

                  {/* 4. 웹뷰 · Git */}
                  {activeTab === 'webview' && (
                    <>
                      <div>
                        <h2 className="text-[18px] font-semibold">내장 웹뷰 및 Git Diff</h2>
                        <p className="text-[13px] mt-1" style={{ color: 'var(--muted)' }}>
                          분할 패인에 띄우는 Chromium 웹뷰와 Git Diff 비교 기준을 관리합니다.
                        </p>
                      </div>

                      <div className="space-y-2">
                        <div className="text-[13px] font-semibold">내장 Chromium 웹뷰</div>
                        <SettingsCard>
                          {searchableRows.find((r) => r.id === 'linkOpenTarget')!.render()}
                          {searchableRows.find((r) => r.id === 'defaultWebviewUrl')!.render()}
                          {searchableRows.find((r) => r.id === 'downloadDir')!.render()}
                          <SettingsRow
                            title="방문 기록 및 캐시"
                            desc={clearedMsg ? '내장 웹뷰 캐시를 삭제했습니다.' : '내장 웹뷰의 캐시와 임시 저장 데이터를 비웁니다.'}
                            right={
                              <button
                                type="button"
                                onClick={async () => {
                                  const ok = await window.agyDesk?.clearBrowserHistory();
                                  if (ok) {
                                    setClearedMsg(true);
                                    setTimeout(() => setClearedMsg(false), 2500);
                                  }
                                }}
                                className="px-3 py-1 rounded-lg text-[12px] font-medium cursor-pointer"
                                style={{ background: 'var(--surface)', color: 'var(--fg)' }}
                              >
                                지우기
                              </button>
                            }
                          />
                        </SettingsCard>
                      </div>

                      <div className="space-y-2">
                        <div className="text-[13px] font-semibold">Git Diff 패인</div>
                        <SettingsCard>{searchableRows.find((r) => r.id === 'gitDiffBase')!.render()}</SettingsCard>
                      </div>
                    </>
                  )}

                  {/* 5. 알림 · 단축키 */}
                  {activeTab === 'notify' && (
                    <>
                      <div>
                        <h2 className="text-[18px] font-semibold">알림 및 단축키</h2>
                        <p className="text-[13px] mt-1" style={{ color: 'var(--muted)' }}>
                          백그라운드 작업 완료 알림과 무한 분할 단축키를 관리합니다.
                        </p>
                      </div>

                      <div className="space-y-2">
                        <div className="text-[13px] font-semibold">완료 알림 & 사운드</div>
                        <SettingsCard>
                          {searchableRows.find((r) => r.id === 'notificationsEnabled')!.render()}
                          {searchableRows.find((r) => r.id === 'soundEnabled')!.render()}
                          <SettingsRow
                            title="볼륨"
                            right={
                              <div className="flex items-center gap-3 w-44">
                                <input
                                  type="range"
                                  min={0}
                                  max={100}
                                  value={settings.soundVolume}
                                  onChange={(e) => set({ soundVolume: Number(e.target.value) })}
                                  className="flex-1 accent-[var(--accent)] cursor-pointer"
                                />
                                <span className="num text-xs w-9 text-right">{settings.soundVolume}%</span>
                              </div>
                            }
                          />
                          <SettingsRow
                            title="macOS 알림 권한"
                            desc="시스템 설정에서 앱 알림 배너 권한을 확인합니다."
                            right={
                              <button
                                type="button"
                                onClick={() => void window.agyDesk?.openNotificationSettings()}
                                className="px-3 py-1 rounded-lg text-[12px] font-medium cursor-pointer"
                                style={{ background: 'var(--surface)', color: 'var(--fg)' }}
                              >
                                시스템 설정 열기
                              </button>
                            }
                          />
                        </SettingsCard>
                      </div>

                      <div className="space-y-2">
                        <div className="text-[13px] font-semibold">주요 단축키</div>
                        <SettingsCard>
                          {SHORTCUTS_LIST.map((row) => (
                            <SettingsRow
                              key={row.name}
                              title={row.name}
                              right={
                                <span
                                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border font-mono text-[11.5px]"
                                  style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}
                                >
                                  {row.keys.join(' + ')}
                                </span>
                              }
                            />
                          ))}
                        </SettingsCard>
                      </div>
                    </>
                  )}

                  {/* 6. 스킬 · 프로젝트 */}
                  {activeTab === 'custom' && (
                    <>
                      <div>
                        <h2 className="text-[18px] font-semibold">스킬 · 규칙 · 프로젝트</h2>
                        <p className="text-[13px] mt-1" style={{ color: 'var(--muted)' }}>
                          작업 프로젝트 폴더 등록과 실제 디스크 기반 프롬프트 토큰 예산을 확인합니다.
                        </p>
                      </div>

                      <div className="space-y-2">
                        <div className="text-[13px] font-semibold">등록된 프로젝트 폴더</div>
                        <SettingsCard>
                          {settings.projectFolders.length === 0 ? (
                            <div className="px-4 py-5 text-center text-[12.5px]" style={{ color: 'var(--muted)' }}>
                              아직 추가된 폴더가 없습니다.
                            </div>
                          ) : (
                            settings.projectFolders.map((dir) => (
                              <div key={dir} className="px-4 py-2.5 flex items-center justify-between gap-2 text-xs font-mono">
                                <span className="truncate">{dir}</span>
                                <button
                                  type="button"
                                  onClick={() =>
                                    set({ projectFolders: settings.projectFolders.filter((x) => x !== dir) })
                                  }
                                  className="p-1 rounded hover:bg-[var(--surface)] cursor-pointer"
                                  style={{ color: 'var(--muted)' }}
                                >
                                  <Trash2 size={13} />
                                </button>
                              </div>
                            ))
                          )}
                          <button
                            type="button"
                            onClick={async () => {
                              const dir = await window.agyDesk?.pickDirectory();
                              if (dir && !settings.projectFolders.includes(dir)) {
                                set({ projectFolders: [...settings.projectFolders, dir] });
                              }
                            }}
                            className="w-full py-2.5 flex items-center justify-center gap-1.5 text-[12.5px] font-medium cursor-pointer transition-colors hover:opacity-80"
                            style={{ background: 'var(--surface)', color: 'var(--fg)' }}
                          >
                            <Plus size={14} />
                            <span>폴더 추가</span>
                          </button>
                        </SettingsCard>
                      </div>

                      <CustomizationsSection inventory={inventory} onRefresh={() => void refreshInventory()} />
                    </>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
