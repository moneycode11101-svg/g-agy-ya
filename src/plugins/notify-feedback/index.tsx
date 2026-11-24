import React from 'react';
import { Bell, ExternalLink, Volume2 } from 'lucide-react';
import {
  BUILTIN_PLUGIN_IDS,
  SchemaSettingsForm,
  usePluginConfigStore,
  type BuiltinPluginPackage,
  type ClientPluginModule,
  type EventEnvelope,
} from '../../kernel/client';
import { playCompletionChime } from '../../utils/sound';
import { notifyFeedbackConfigSchema, notifyFeedbackManifest } from './manifest';

interface AgentDoneEventPayload {
  type?: string;
}

export const notifyFeedbackClient: ClientPluginModule = {
  activate(ctx) {
    const onDone = (env: EventEnvelope<AgentDoneEventPayload>) => {
      if (env.payload?.type !== 'done') return;
      const cfg = ctx.config.get();
      if (cfg.soundEnabled) {
        const vol = typeof cfg.soundVolume === 'number' ? cfg.soundVolume : 80;
        playCompletionChime(vol);
      }
    };

    ctx.bus.subscribe<AgentDoneEventPayload>('agent-*', (env) => {
      if (env.topic.endsWith(':event')) onDone(env);
    });
    ctx.bus.subscribe<AgentDoneEventPayload>('agy:event', onDone);

    const NotifySettingsView: React.FC = () => {
      const values = usePluginConfigStore((s) => s.configsByPlugin[BUILTIN_PLUGIN_IDS.NOTIFY_FEEDBACK] || {});
      const volume = typeof values.soundVolume === 'number' ? values.soundVolume : 80;

      return (
        <div className="space-y-4">
          <SchemaSettingsForm
            schema={notifyFeedbackConfigSchema}
            values={values}
            onChange={(patch) => void ctx.config.set(patch)}
          />
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => playCompletionChime(volume)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border text-[12px] font-medium cursor-pointer hover:bg-[var(--surface)]"
              style={{ background: 'var(--card)', borderColor: 'var(--border)', color: 'var(--fg)' }}
            >
              <Volume2 size={13} />
              <span>완료음 미리 듣기</span>
            </button>
            <button
              type="button"
              onClick={() => void ctx.rpc.invoke('notify-feedback:open-os-settings').catch(() => {})}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border text-[12px] cursor-pointer hover:bg-[var(--surface)]"
              style={{ background: 'var(--card)', borderColor: 'var(--border)', color: 'var(--fg-soft)' }}
            >
              <ExternalLink size={13} />
              <span>macOS 알림 설정 열기</span>
            </button>
          </div>
        </div>
      );
    };

    ctx.slots.register('settings.section', {
      id: 'notifications',
      group: '알림 · 시스템',
      title: '알림 · 사운드',
      description: '에이전트 응답 완료 시 시스템 알림 및 완료 효과음 설정',
      icon: Bell,
      order: 60,
      schema: notifyFeedbackConfigSchema,
      Component: NotifySettingsView,
    });
  },
};

export const notifyFeedbackClientPackage: BuiltinPluginPackage = {
  manifest: notifyFeedbackManifest,
  client: notifyFeedbackClient,
};
