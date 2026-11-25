import React, { useEffect, useState } from 'react';
import { RefreshCw, Terminal } from 'lucide-react';
import { SchemaSettingsForm } from '../../kernel/client/SchemaSettingsForm';
import type { ClientPluginModule, DeskClientContext } from '../../kernel/shared/types';
import type { ClientAgentAdapterDescriptor } from '../../shared/agentProtocol';
import type { AccountQuotaSnapshot } from '../../shared/types';
import { fmtReset, quotaBucketTitle } from '../../utils/formatKo';
import { AGENT_CODEX_MANIFEST } from './manifest';
import {
  CODEX_BUS,
  CODEX_RPC,
  FALLBACK_CODEX_MODELS,
  type CodexPluginConfig,
  type CodexRuntimeInfo,
} from './types';

const DonutRing: React.FC<{ pct: number }> = ({ pct }) => {
  const clamped = Math.max(0, Math.min(100, pct));
  const r = 11;
  const c = 2 * Math.PI * r;
  const offset = c * (1 - clamped / 100);
  const strokeColor = clamped <= 15 ? 'var(--danger)' : clamped <= 40 ? 'var(--warn)' : '#10b981';
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

export const agentCodexClientPlugin: ClientPluginModule<CodexPluginConfig> = {
  activate(ctx: DeskClientContext<CodexPluginConfig>) {
    const descriptor: ClientAgentAdapterDescriptor = {
      id: 'agent-codex',
      shortLabel: 'Codex',
      displayName: 'Codex CLI (짚 · app-server)',
      accentColor: '#10b981',
      rpcPrefix: 'agent-codex',
      busEventTopic: CODEX_BUS.EVENT,
      busQuotaTopic: CODEX_BUS.QUOTA_UPDATED,
      capabilities: {
        quota: true,
        runtimeAssets: true,
        sessionHistory: true,
        interactiveApproval: true,
        userQuestions: true,
        steering: true,
      },
      fallbackModels: FALLBACK_CODEX_MODELS,
    };

    ctx.services.provide('agent-adapter:codex', descriptor);
    ctx.services.provide('agent-adapter', descriptor);

    const AgentCodexSettingsPanel: React.FC = () => {
      const cfg = ctx.config.useConfig();
      const [quota, setQuota] = useState<AccountQuotaSnapshot | null>(null);
      const [loadingQuota, setLoadingQuota] = useState(false);
      const [runtimeInfo, setRuntimeInfo] = useState<CodexRuntimeInfo | null>(null);

      const loadQuota = async (force = false) => {
        setLoadingQuota(true);
        try {
          const snap = await ctx.rpc.invoke<AccountQuotaSnapshot>(CODEX_RPC.QUOTA_GET, { force });
          setQuota(snap);
          const info = await ctx.rpc.invoke<CodexRuntimeInfo>(CODEX_RPC.RUNTIME_INFO);
          setRuntimeInfo(info);
        } catch {
          // ignore
        } finally {
          setLoadingQuota(false);
        }
      };

      useEffect(() => {
        void ctx.rpc
          .invoke<CodexRuntimeInfo>(CODEX_RPC.RUNTIME_INFO)
          .then((info) => setRuntimeInfo(info))
          .catch(() => {});
        const unsub = ctx.bus.subscribe<AccountQuotaSnapshot>(CODEX_BUS.QUOTA_UPDATED, (env) => {
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
            schema={AGENT_CODEX_MANIFEST.configSchema || []}
            values={cfg}
            onChange={(patch) => void ctx.config.set(patch as Partial<CodexPluginConfig>)}
          />

          <div className="space-y-2">
            <div className="flex items-center justify-between px-0.5">
              <div className="text-[12px] font-semibold" style={{ color: 'var(--muted)' }}>
                Codex (짚) 공식 할당량 (`account/rateLimits/read` · 텔레메트리 0%)
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
                    ? 'codex app-server에서 5시간/주간 한도를 불러오는 중…'
                    : quota?.error || '우측 조회 버튼을 누르거나 대화를 시작하면 5시간/주간 한도가 표시됩니다.'}
                </div>
              )}
              {runtimeInfo && (
                <div
                  className="px-4 py-2.5 flex items-center justify-between text-[11.5px]"
                  style={{ borderColor: 'var(--border)', color: 'var(--muted)' }}
                >
                  <span>런타임 · 계정</span>
                  <span className="font-mono truncate max-w-[360px]">
                    {runtimeInfo.cliVersion}
                    {runtimeInfo.email ? ` · ${runtimeInfo.email}` : ''}
                    {runtimeInfo.homePath ? ` · ${runtimeInfo.homePath}` : ''}
                  </span>
                </div>
              )}
            </div>
          </div>
        </div>
      );
    };

    ctx.slots.register('settings.section', {
      id: 'agent-codex-settings',
      group: '에이전트 · 모델',
      title: 'Codex CLI (짚 · app-server)',
      description: 'OpenAI Codex app-server 모델·추론 강도·권한·CODEX_HOME 및 5시간/주간 한도를 관리합니다.',
      icon: Terminal,
      order: 24,
      schema: AGENT_CODEX_MANIFEST.configSchema,
      Component: AgentCodexSettingsPanel,
      searchEntries: [
        {
          id: 'agent-codex:quota',
          title: 'Codex (짚) 할당량 · 계정 설정',
          description: 'Codex 5시간/주간 사용 한도 및 CODEX_HOME 계정 전환',
          keywords: 'codex 짚 gpt sol quota 한도 계정',
        },
      ],
    });
  },
};
