import type { AgentModelOption, AgentRuntimeInfo } from '../../shared/agentProtocol';
import type { ChatMode } from '../../shared/types';

export interface CodexPluginConfig extends Record<string, unknown> {
  defaultModel: string;
  defaultEffort: string;
  localPermission: ChatMode;
  codexHome: string;
  cliPath: string;
}

export type CodexModelOption = AgentModelOption;
export type CodexRuntimeInfo = AgentRuntimeInfo;

export const FALLBACK_CODEX_MODELS: CodexModelOption[] = [
  {
    value: 'gpt-6.2-sol',
    label: 'GPT-6.2-Sol',
    isDefault: true,
    supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    defaultEffort: 'medium',
  },
  {
    value: 'gpt-6.2-astra',
    label: 'GPT-6.2-Astra',
    supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    defaultEffort: 'low',
  },
  {
    value: 'gpt-6.1-terra',
    label: 'GPT-6.1 Terra',
    supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    defaultEffort: 'low',
  },
  {
    value: 'gpt-6.1-sol',
    label: 'GPT-6.1-Sol',
    supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    defaultEffort: 'xhigh',
  },
  {
    value: 'gpt-5.4',
    label: 'GPT-5.4',
    supportedEfforts: ['low', 'medium', 'high', 'xhigh'],
    defaultEffort: 'high',
  },
  {
    value: 'o4-mini',
    label: 'o4-mini',
    supportedEfforts: ['low', 'medium', 'high'],
    defaultEffort: 'medium',
  },
];

export const CODEX_RPC = {
  SESSIONS_LIST: 'agent-codex:sessions.list',
  SESSIONS_LOAD: 'agent-codex:sessions.load',
  SESSIONS_WATCH: 'agent-codex:sessions.watch',
  SESSIONS_UNWATCH: 'agent-codex:sessions.unwatch',
  PROMPT_SEND: 'agent-codex:prompt.send',
  PROMPT_CANCEL: 'agent-codex:prompt.cancel',
  AUTH_LOGIN: 'agent-codex:auth.login',
  AUTH_CANCEL: 'agent-codex:auth.cancel',
  PERMISSION_RESPOND: 'agent-codex:permission.respond',
  QUESTION_RESPOND: 'agent-codex:question.respond',
  QUOTA_GET: 'agent-codex:quota.get',
  MODELS_LIST: 'agent-codex:models.list',
  RUNTIME_INFO: 'agent-codex:runtime.info',
  ASSETS_SCAN: 'agent-codex:assets.scan',
} as const;

export const CODEX_BUS = {
  EVENT: 'agent-codex:event',
  QUOTA_UPDATED: 'agent-codex:quota.updated',
  ASSETS_UPDATED: 'agent-codex:assets.updated',
} as const;
