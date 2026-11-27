import { BrowserWindow } from 'electron';
import type { BuiltinPluginPackage, EventEnvelope, HostPluginModule } from '../../../src/kernel/shared/types';
import { notifyFeedbackManifest } from '../../../src/plugins/notify-feedback/manifest';

interface AgentDoneEventPayload {
  type?: string;
  error?: string;
}

export const notifyFeedbackHost: HostPluginModule = {
  activate(ctx) {
    const handleAgentEvent = (env: EventEnvelope<AgentDoneEventPayload>) => {
      const payload = env.payload;
      if (!payload || payload.type !== 'done') return;
      if (!ctx.config.getKey('notificationsEnabled')) return;

      // Notify only when no app window currently has OS focus
      if (BrowserWindow.getFocusedWindow() !== null) return;

      const windows = BrowserWindow.getAllWindows();
      const targetWin = windows[0];
      ctx.host.notify({
        title: '제제이야',
        body: payload.error ? `작업 오류: ${String(payload.error).slice(0, 80)}` : '에이전트 응답이 완료되었습니다.',
        silent: true,
        onClick: () => {
          if (targetWin && !targetWin.isDestroyed()) {
            targetWin.show();
            targetWin.focus();
          }
        },
      });
    };

    // Subscribe to both standardized `agent-*:event` (Wave 2 adapters) and legacy `agy:event`
    ctx.bus.subscribe<AgentDoneEventPayload>('agent-*', (env) => {
      if (env.topic.endsWith(':event')) {
        handleAgentEvent(env);
      }
    });
    ctx.bus.subscribe<AgentDoneEventPayload>('agy:event', handleAgentEvent);

    ctx.rpc.handle('notify-feedback:open-os-settings', async () => {
      await ctx.host.openOsNotificationSettings();
      return true;
    });
  },
};

export const notifyFeedbackHostPackage: BuiltinPluginPackage = {
  manifest: notifyFeedbackManifest,
  host: notifyFeedbackHost,
};
