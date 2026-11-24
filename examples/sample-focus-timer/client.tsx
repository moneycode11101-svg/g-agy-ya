import React from 'react';
import { CheckCircle2, Flame, Pause, Play, RotateCcw, Timer } from 'lucide-react';
import { create } from 'zustand';
import { PANE_WIDGET_ANCHORS } from '@agy-desk/kernel';

interface TimerConfig {
  workMinutes?: number;
  label?: string;
}

interface FocusTimerStore {
  workMinutes: number;
  remainingSec: number;
  running: boolean;
  completedSessions: number;
  setWorkMinutes: (mins: number) => void;
  toggleRunning: () => void;
  reset: () => void;
  tick: () => boolean; // returns true when a session completes
}

function clampMinutes(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 25;
  return Math.max(1, Math.min(120, Math.round(n)));
}

function formatClock(totalSec: number): string {
  const safe = Math.max(0, Math.floor(totalSec));
  const mm = String(Math.floor(safe / 60)).padStart(2, '0');
  const ss = String(safe % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

export function activate(ctx: {
  pluginId: string;
  manifest: { configSchema?: unknown[] };
  scope: { onDispose: (fn: () => void, label?: string) => void };
  config: {
    get: () => TimerConfig;
    useConfig: () => TimerConfig;
    onChange: (cb: (next: TimerConfig) => void) => () => void;
  };
  bus: { publish: (topic: string, payload: unknown) => void };
  panes: { registerType: (def: Record<string, unknown>) => () => void };
  slots: { register: (slotId: string, contrib: Record<string, unknown>) => () => void };
  workspace: { openTab: (paneType: string, init?: Record<string, unknown>, opts?: Record<string, unknown>) => string | null };
  ui: { toast: (msg: string, level?: 'info' | 'warn' | 'error') => void };
}) {
  const initialMins = clampMinutes(ctx.config.get().workMinutes ?? 25);

  const useTimerStore = create<FocusTimerStore>((set, get) => ({
    workMinutes: initialMins,
    remainingSec: initialMins * 60,
    running: false,
    completedSessions: 0,

    setWorkMinutes: (mins) => {
      const clamped = clampMinutes(mins);
      set((s) => ({
        workMinutes: clamped,
        remainingSec: s.running ? Math.min(s.remainingSec, clamped * 60) : clamped * 60,
      }));
    },

    toggleRunning: () => {
      const next = !get().running;
      set({ running: next });
      ctx.bus.publish('sample-focus-timer:state', {
        running: next,
        remainingSec: get().remainingSec,
        label: ctx.config.get().label || '깊은 집중',
      });
    },

    reset: () => {
      const mins = get().workMinutes;
      set({ running: false, remainingSec: mins * 60 });
      ctx.bus.publish('sample-focus-timer:state', {
        running: false,
        remainingSec: mins * 60,
        reset: true,
      });
    },

    tick: () => {
      const s = get();
      if (!s.running) return false;
      if (s.remainingSec <= 1) {
        const mins = s.workMinutes;
        set({
          running: false,
          remainingSec: mins * 60,
          completedSessions: s.completedSessions + 1,
        });
        return true;
      }
      set({ remainingSec: s.remainingSec - 1 });
      return false;
    },
  }));

  // Live config sync when user drags the `workMinutes` slider in Plugin Studio Inspector
  ctx.config.onChange((next) => {
    if (next.workMinutes !== undefined) {
      useTimerStore.getState().setWorkMinutes(clampMinutes(next.workMinutes));
    }
  });

  // Single 1s ticker cleanly torn down on hot-reload / deactivate via EffectScope
  const intervalId = window.setInterval(() => {
    const completed = useTimerStore.getState().tick();
    if (completed) {
      const lbl = ctx.config.get().label || '깊은 집중';
      ctx.bus.publish('sample-focus-timer:completed', {
        label: lbl,
        completedSessions: useTimerStore.getState().completedSessions,
      });
      ctx.ui.toast(`포커스 타이머 완료! (${lbl})`, 'info');
    }
  }, 1000);

  ctx.scope.onDispose(() => {
    window.clearInterval(intervalId);
  }, 'focus-timer:interval');

  // 1) Pane View (`pane.type`: focus-timer)
  const FocusTimerPane: React.FC = () => {
    const cfg = ctx.config.useConfig();
    const workMinutes = useTimerStore((s) => s.workMinutes);
    const remainingSec = useTimerStore((s) => s.remainingSec);
    const running = useTimerStore((s) => s.running);
    const completedSessions = useTimerStore((s) => s.completedSessions);
    const toggleRunning = useTimerStore((s) => s.toggleRunning);
    const reset = useTimerStore((s) => s.reset);

    const sessionLabel = cfg.label || '깊은 집중';
    const totalSec = Math.max(1, workMinutes * 60);
    const progress = 1 - remainingSec / totalSec;
    const radius = 64;
    const circumference = 2 * Math.PI * radius;
    const strokeOffset = circumference * (1 - Math.max(0, Math.min(1, progress)));

    return (
      <div className="sft-root">
        <div className="sft-card">
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--muted)' }}>
            <Flame size={14} style={{ color: running ? '#9333ea' : 'var(--muted)' }} />
            <span style={{ fontWeight: 600, color: 'var(--fg-soft)' }}>{sessionLabel}</span>
            <span
              style={{
                padding: '1px 6px',
                borderRadius: 6,
                fontSize: 10,
                fontFamily: 'ui-monospace, monospace',
                background: 'color-mix(in srgb, #9333ea 13%, transparent)',
                color: '#9333ea',
              }}
            >
              LOCAL HMR
            </span>
          </div>

          <div style={{ position: 'relative', width: 156, height: 156, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <svg width="156" height="156" viewBox="0 0 156 156" style={{ transform: 'rotate(-90deg)' }}>
              <circle cx="78" cy="78" r={radius} fill="none" stroke="var(--surface)" strokeWidth="8" />
              <circle
                cx="78"
                cy="78"
                r={radius}
                fill="none"
                stroke={running ? '#9333ea' : 'var(--accent)'}
                strokeWidth="8"
                strokeLinecap="round"
                strokeDasharray={circumference}
                strokeDashoffset={strokeOffset}
                style={{ transition: 'stroke-dashoffset 280ms ease' }}
              />
            </svg>
            <div style={{ position: 'absolute', textAlign: 'center' }}>
              <div
                style={{
                  fontSize: 32,
                  fontWeight: 700,
                  fontVariantNumeric: 'tabular-nums',
                  letterSpacing: '-0.03em',
                }}
              >
                {formatClock(remainingSec)}
              </div>
              <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
                {running ? '집중 진행 중' : `${workMinutes}분 대기`}
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button type="button" className="sft-btn sft-btn-primary" onClick={toggleRunning}>
              {running ? <Pause size={14} /> : <Play size={14} />}
              <span>{running ? '일시정지' : '집중 시작'}</span>
            </button>
            <button type="button" className="sft-btn" onClick={reset} title="타이머 초기화">
              <RotateCcw size={13} />
              <span>초기화</span>
            </button>
          </div>

          <div
            style={{
              width: '100%',
              paddingTop: 12,
              borderTop: '1px solid var(--border)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              fontSize: 11.5,
              color: 'var(--muted)',
            }}
          >
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
              <CheckCircle2 size={13} style={{ color: 'var(--ok)' }} />
              <span>완료 세션 {completedSessions}회</span>
            </span>
            <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 10.5 }}>
              client.tsx 저장 시 자동 HMR
            </span>
          </div>
        </div>
      </div>
    );
  };

  // 2) Live Chat Composer Badge (`pane.widget`: chat:composer-badge)
  const ChatComposerTimerBadge: React.FC = () => {
    const cfg = ctx.config.useConfig();
    const remainingSec = useTimerStore((s) => s.remainingSec);
    const running = useTimerStore((s) => s.running);
    const toggleRunning = useTimerStore((s) => s.toggleRunning);

    const label = cfg.label || '깊은 집중';

    return (
      <button
        type="button"
        className={`sft-badge ${running ? 'sft-badge-running' : ''}`}
        onClick={(e) => {
          e.stopPropagation();
          if (e.shiftKey) {
            ctx.workspace.openTab('focus-timer', undefined, { split: 'h', side: 'after' });
          } else {
            toggleRunning();
          }
        }}
        title={`${label} 타이머 — 클릭: 시작/일시정지 · Shift+클릭: 타이머 패인 분할 열기`}
      >
        <Timer size={11} />
        <span>{formatClock(remainingSec)}</span>
        <span style={{ opacity: 0.75 }}>{label}</span>
      </button>
    );
  };

  ctx.panes.registerType({
    type: 'focus-timer',
    label: '포커스 타이머',
    description: '로컬 핫리로드 포모도로 집중 타이머 샘플',
    icon: Timer,
    accentColor: '#9333ea',
    keepAlive: 'never',
    showInLauncher: true,
    showInOmnibox: true,
    order: 80,
    createDefaultState: () => ({
      title: ctx.config.get().label || '포커스 타이머',
      state: {},
    }),
    matchOmnibox: (query: string) => {
      const q = query.trim().toLowerCase();
      if (q === 'timer' || q === 'focus' || q === 'pomodoro' || q === '타이머' || q === '포모도로') {
        return { score: 90, label: '포커스 타이머 열기', init: {} };
      }
      return null;
    },
    Component: FocusTimerPane,
  });

  ctx.slots.register('pane.widget', {
    id: 'focus-timer-composer-badge',
    targetPaneType: 'chat',
    anchor: PANE_WIDGET_ANCHORS.CHAT_COMPOSER_BADGE,
    order: 40,
    Component: ChatComposerTimerBadge,
  });

  ctx.slots.register('settings.section', {
    id: 'focus-timer-settings',
    group: '로컬 플러그인',
    title: '포커스 타이머',
    description: '로컬 마운트 샘플 플러그인의 집중 시간과 라벨을 실시간으로 변경합니다.',
    icon: Timer,
    schema: ctx.manifest.configSchema,
    order: 90,
  });
}

export default { activate };
