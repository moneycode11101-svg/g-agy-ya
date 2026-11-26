import React, { useEffect, useState } from 'react';
import { KeyRound, Loader2, RefreshCw, Sparkles } from 'lucide-react';
import { SchemaSettingsForm } from '../../kernel/client/SchemaSettingsForm';
import type { ClientPluginModule, DeskClientContext } from '../../kernel/shared/types';
import type { ClientAgentAdapterDescriptor } from '../../shared/agentProtocol';
import type { AccountQuotaSnapshot } from '../../shared/types';
import { fmtReset, quotaBucketTitle } from '../../utils/formatKo';
import { AGENT_CLAUDE_MANIFEST } from './manifest';
import {
  CLAUDE_BUS,
  CLAUDE_RPC,
  FALLBACK_CLAUDE_MODELS,
  type ClaudePluginConfig,
  type ClaudeRuntimeInfo,
} from './types';

const DonutRing: React.FC<{ pct: number }> = ({ pct }) => {
  const clamped = Math.max(0, Math.min(100, pct));
  const r = 11;
  const c = 2 * Math.PI * r;
  const offset = c * (1 - clamped / 100);
  const strokeColor = clamped <= 15 ? 'var(--danger)' : clamped <= 40 ? 'var(--warn)' : '#d97706';
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

export const agentClaudeClientPlugin: ClientPluginModule<ClaudePluginConfig> = {
  activate(ctx: DeskClientContext<ClaudePluginConfig>) {
    const descriptor: ClientAgentAdapterDescriptor = {
      id: 'agent-claude',
      shortLabel: 'Claude',
      displayName: 'Claude Code (claude)',
      accentColor: '#d97706',
      rpcPrefix: 'agent-claude',
      busEventTopic: CLAUDE_BUS.EVENT,
      busQuotaTopic: CLAUDE_BUS.QUOTA_UPDATED,
      capabilities: {
        quota: true,
        runtimeAssets: true,
        sessionHistory: true,
        interactiveApproval: true,
        userQuestions: true,
        steering: false,
      },
      fallbackModels: FALLBACK_CLAUDE_MODELS,
    };

    ctx.services.provide('agent-adapter:claude', descriptor);
    ctx.services.provide('agent-adapter', descriptor);

    const AgentClaudeSettingsPanel: React.FC = () => {
      const cfg = ctx.config.useConfig();
      const [quota, setQuota] = useState<AccountQuotaSnapshot | null>(null);
      const [loadingQuota, setLoadingQuota] = useState(false);
      const [runtimeInfo, setRuntimeInfo] = useState<ClaudeRuntimeInfo | null>(null);
      const [loggingIn, setLoggingIn] = useState(false);
      const [loginStatus, setLoginStatus] = useState<string | null>(null);

      const handleCliLogin = async () => {
        setLoggingIn(true);
        setLoginStatus(null);
        try {
          const res = await ctx.rpc.invoke<{ ok: boolean; error?: string }>(CLAUDE_RPC.AUTH_LOGIN, {
            methodId: 'claudeai',
          });
          if (res?.ok) {
            setLoginStatus('Claude CLI 로그인이 완료되었습니다.');
            void loadQuota(true);
            void ctx.rpc
              .invoke<ClaudeRuntimeInfo>(CLAUDE_RPC.RUNTIME_INFO)
              .then((info) => setRuntimeInfo(info))
              .catch(() => {});
          } else {
            setLoginStatus(res?.error || '로그인에 실패했습니다.');
          }
        } catch (err) {
          setLoginStatus(err instanceof Error ? err.message : '로그인 요청 실패');
        } finally {
          setLoggingIn(false);
        }
      };

      const loadQuota = async (force = false) => {
        setLoadingQuota(true);
        try {
          const snap = await ctx.rpc.invoke<AccountQuotaSnapshot>(CLAUDE_RPC.QUOTA_GET, { force });
          setQuota(snap);
        } catch {
          // ignore
        } finally {
          setLoadingQuota(false);
        }
      };

      useEffect(() => {
        void ctx.rpc
          .invoke<ClaudeRuntimeInfo>(CLAUDE_RPC.RUNTIME_INFO)
          .then((info) => setRuntimeInfo(info))
          .catch(() => {});
        const unsub = ctx.bus.subscribe<AccountQuotaSnapshot>(CLAUDE_BUS.QUOTA_UPDATED, (env) => {
          if (env.payload?.buckets?.length) setQuota(env.payload);
        });
        return () => {
          void unsub();
        };
      }, []);

      const buckets = quota?.buckets || [];

      return (
        <div className="space-y-5">
          <SchemaSettingsForm
            schema={AGENT_CLAUDE_MANIFEST.configSchema || []}
            values={cfg}
            onChange={(patch) => void ctx.config.set(patch as Partial<ClaudePluginConfig>)}
          />

          <div className="space-y-2">
            <div className="flex items-center justify-between px-0.5">
              <div className="text-[12px] font-semibold" style={{ color: 'var(--muted)' }}>
                Claude Code 구독 할당량 (로컬 SDK IPC · 텔레메트리 0%)
              </div>
              <button
                type="button"
                onClick={() => void loadQuota(true)}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg text-[11.5px] cursor-pointer hover:bg-[var(--surface)]"
                style={{ color: 'var(--muted)' }}
              >
                <RefreshCw size={11} className={loadingQuota ? 'animate-spin' : ''} />
                <span>조회</span>
              </button>
            </div>
            <div
              className="rounded-xl border divide-y overflow-hidden"
              style={{ background: 'var(--card)', borderColor: 'var(--border)' }}
            >
              {buckets.length > 0 ? (
                buckets.map((b) => {
                  const remPct = b.remainingFraction != null ? Math.round(b.remainingFraction * 100) : 100;
                  const usedPct = 100 - remPct;
                  const reset = fmtReset(b.resetInSeconds, b.resetTime);
                  return (
                    <div
                      key={b.id}
                      className="px-4 py-3 flex items-center justify-between gap-4"
                      style={{ borderColor: 'var(--border)' }}
                    >
                      <div className="min-w-0">
                        <div className="text-[13px] font-medium" style={{ color: 'var(--fg)' }}>
                          {quotaBucketTitle(b)}
                        </div>
                        <div className="text-[11.5px] mt-0.5" style={{ color: 'var(--muted)' }}>
                          {reset ? `${reset} 초기화 · ${usedPct}% 사용` : `${usedPct}% 사용`}
                        </div>
                      </div>
                      <div className="flex items-center gap-2.5 shrink-0">
                        <span className="num text-[13.5px] font-semibold">{remPct}% 남음</span>
                        <DonutRing pct={remPct} />
                      </div>
                    </div>
                  );
                })
              ) : (
                <div className="px-4 py-3 text-[12px]" style={{ color: 'var(--muted)' }}>
                  {loadingQuota
                    ? 'Claude SDK get_usage 프로브 실행 중…'
                    : quota?.error || '우측 조회 버튼을 누르거나 대화를 시작하면 5시간/주간 한도가 표시됩니다.'}
                </div>
              )}
              {runtimeInfo && (
                <div
                  className="px-4 py-2.5 flex items-center justify-between gap-3 text-[11.5px]"
                  style={{ borderColor: 'var(--border)', color: 'var(--muted)' }}
                >
                  <div className="min-w-0">
                    <div className="truncate">
                      <span>런타임 · </span>
                      <span className="font-mono">
                        {runtimeInfo.cliVersion}
                        {runtimeInfo.homePath ? ` · ${runtimeInfo.homePath}` : ''}
                      </span>
                    </div>
                    {loginStatus && (
                      <div className="mt-0.5 text-[11px]" style={{ color: 'var(--accent)' }}>
                        {loginStatus}
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    {loggingIn ? (
                      <button
                        type="button"
                        onClick={() => void ctx.rpc.invoke(CLAUDE_RPC.AUTH_CANCEL)}
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-medium cursor-pointer"
                        style={{ background: 'var(--surface)', color: 'var(--fg-soft)' }}
                      >
                        <Loader2 size={11} className="animate-spin" />
                        <span>로그인 취소</span>
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => void handleCliLogin()}
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-medium cursor-pointer hover:opacity-90"
                        style={{ background: 'var(--accent)', color: '#fff' }}
                      >
                        <KeyRound size={11} />
                        <span>CLI 로그인</span>
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      );
    };

    ctx.slots.register('settings.section', {
      id: 'agent-claude-settings',
      group: '에이전트 · 모델',
      title: 'Claude Code (claude)',
      description: 'Claude Agent SDK 기반 모델·권한·CLAUDE_CONFIG_DIR 및 공식 할당량을 관리합니다.',
      icon: Sparkles,
      order: 22,
      schema: AGENT_CLAUDE_MANIFEST.configSchema,
      Component: AgentClaudeSettingsPanel,
      searchEntries: [
        {
          id: 'agent-claude:quota',
          title: 'Claude Code 할당량 · 설정',
          description: 'Claude Code 5시간/주간 사용 한도 및 CLAUDE_CONFIG_DIR',
          keywords: 'claude 클로드 quota 한도 opus sonnet config',
        },
      ],
    });
  },
};
