import React, { useEffect, useState } from 'react';
import { Cpu, RefreshCw } from 'lucide-react';
import { SchemaSettingsForm } from '../../kernel/client/SchemaSettingsForm';
import type { ClientPluginModule, DeskClientContext } from '../../kernel/shared/types';
import type { AccountQuotaSnapshot } from '../../shared/types';
import { fmtReset, quotaBucketTitle } from '../../utils/formatKo';
import { AGENT_AGY_MANIFEST } from './manifest';
import { AGY_BUS, AGY_RPC, type AgyPluginConfig, type AgyRuntimeInfo } from './types';

export interface ClientAgentAdapterDescriptor {
  readonly id: string;
  readonly displayName: string;
  readonly rpcPrefix: string;
  readonly busEventTopic: string;
  readonly busQuotaTopic: string;
}

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

export const agentAgyClientPlugin: ClientPluginModule<AgyPluginConfig> = {
  activate(ctx: DeskClientContext<AgyPluginConfig>) {
    const descriptor: ClientAgentAdapterDescriptor = {
      id: 'agent-agy',
      displayName: 'Antigravity CLI (agy)',
      rpcPrefix: 'agent-agy',
      busEventTopic: AGY_BUS.EVENT,
      busQuotaTopic: AGY_BUS.QUOTA_UPDATED,
    };

    ctx.services.provide('agent-adapter:agy', descriptor);
    ctx.services.provide('agent-adapter', descriptor);

    const AgentAgySettingsPanel: React.FC = () => {
      const cfg = ctx.config.useConfig();
      const [quota, setQuota] = useState<AccountQuotaSnapshot | null>(null);
      const [loadingQuota, setLoadingQuota] = useState(false);
      const [runtimeInfo, setRuntimeInfo] = useState<AgyRuntimeInfo | null>(null);

      const loadQuota = async (force = false) => {
        setLoadingQuota(true);
        try {
          const snap = await ctx.rpc.invoke<AccountQuotaSnapshot>(AGY_RPC.QUOTA_GET, { force });
          setQuota(snap);
        } catch {
          // ignore
        } finally {
          setLoadingQuota(false);
        }
      };

      useEffect(() => {
        void loadQuota(false);
        void ctx.rpc
          .invoke<AgyRuntimeInfo>(AGY_RPC.RUNTIME_INFO)
          .then((info) => setRuntimeInfo(info))
          .catch(() => {});
        const unsub = ctx.bus.subscribe<AccountQuotaSnapshot>(AGY_BUS.QUOTA_UPDATED, (env) => {
          if (env.payload?.buckets?.length) {
            setQuota(env.payload);
          }
        });
        return () => {
          void unsub();
        };
      }, []);

      const buckets = quota?.buckets || [];

      return (
        <div className="space-y-5">
          <SchemaSettingsForm
            schema={AGENT_AGY_MANIFEST.configSchema || []}
            values={cfg}
            onChange={(patch) => void ctx.config.set(patch as Partial<AgyPluginConfig>)}
          />

          <div className="space-y-2">
            <div className="flex items-center justify-between px-0.5">
              <div className="text-[12px] font-semibold" style={{ color: 'var(--muted)' }}>
                공식 계정 할당량 (agy /usage)
              </div>
              <button
                type="button"
                onClick={() => void loadQuota(true)}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg text-[11.5px] cursor-pointer hover:bg-[var(--surface)]"
                style={{ color: 'var(--muted)' }}
              >
                <RefreshCw size={11} className={loadingQuota ? 'animate-spin' : ''} />
                <span>새로고침</span>
              </button>
            </div>
            <div
              className="rounded-xl border divide-y overflow-hidden"
              style={{ background: 'var(--card)', borderColor: 'var(--border)' }}
            >
              {buckets.length > 0 ? (
                buckets.map((b) => {
                  const unused = b.remainingFraction != null && b.remainingFraction >= 0.9999;
                  const remPct = b.remainingFraction != null ? Math.round(b.remainingFraction * 100) : 100;
                  const usedPct = 100 - remPct;
                  const reset = unused ? '' : fmtReset(b.resetInSeconds, b.resetTime);
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
                          {unused
                            ? '미사용 · 0% 사용 (첫 요청 시 타이머 시작)'
                            : reset
                              ? `${reset} 초기화 · ${usedPct}% 사용`
                              : `${usedPct}% 사용 · agy /usage 기준`}
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
                <div className="px-4 py-3.5 flex items-center justify-between gap-4">
                  <div>
                    <div className="text-[13px] font-medium">CLI 공식 할당량 동기화 대기</div>
                    <div className="text-[11.5px] mt-0.5" style={{ color: 'var(--muted)' }}>
                      {loadingQuota
                        ? 'agy /usage에서 주간/5시간 한도(%)를 불러오는 중입니다.'
                        : quota?.error || '새로고침을 눌러 할당량을 동기화하세요.'}
                    </div>
                  </div>
                  <DonutRing pct={100} />
                </div>
              )}
              {runtimeInfo && (
                <div
                  className="px-4 py-2.5 flex items-center justify-between text-[11.5px]"
                  style={{ borderColor: 'var(--border)', color: 'var(--muted)' }}
                >
                  <span>런타임 정보</span>
                  <span className="font-mono">
                    agy {runtimeInfo.agyCliVersion}
                    {runtimeInfo.email ? ` · ${runtimeInfo.email}` : ''}
                  </span>
                </div>
              )}
            </div>
          </div>
        </div>
      );
    };

    ctx.slots.register('settings.section', {
      id: 'agent-agy-settings',
      group: '에이전트 · 모델',
      title: 'Antigravity CLI (agy)',
      description: 'agy CLI 기본 모델·Effort·권한 플래그 및 공식 계정 할당량을 관리합니다.',
      icon: Cpu,
      order: 20,
      schema: AGENT_AGY_MANIFEST.configSchema,
      Component: AgentAgySettingsPanel,
      searchEntries: [
        {
          id: 'agent-agy:quota',
          title: '할당량 현황 (agy /usage)',
          description: 'Gemini 및 Claude·GPT 5시간/주간 공식 사용 한도',
          keywords: '할당량 quota usage 한도 5시간 주간 gemini claude',
        },
      ],
    });
  },
};
