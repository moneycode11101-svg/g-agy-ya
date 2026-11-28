import type { AgentModelOption, AgentRuntimeInfo } from '../../shared/agentProtocol';
import type { ChatMode } from '../../shared/types';

export interface ClaudePluginConfig extends Record<string, unknown> {
  defaultModel: string;
  defaultEffort: string;
  localPermission: ChatMode;
  configDir: string;
  cliPath: string;
}

export type ClaudeModelOption = AgentModelOption;
export type ClaudeRuntimeInfo = AgentRuntimeInfo;

export const FALLBACK_CLAUDE_MODELS: ClaudeModelOption[] = [
  {
    value: 'opus',
    label: 'Claude Opus (최신)',
    badge: { label: '최신', tone: 'new' },
    supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultEffort: 'high',
  },
  {
    value: 'fable',
    label: 'Claude Fable (최신)',
    isDefault: true,
    badge: { label: '최신', tone: 'new' },
    supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultEffort: 'high',
  },
  {
    value: 'sonnet',
    label: 'Claude Sonnet (최신)',
    badge: { label: '최신', tone: 'new' },
    supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultEffort: 'high',
  },
  {
    value: 'haiku',
    label: 'Claude Haiku (최신)',
    badge: { label: '최신', tone: 'new' },
    supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultEffort: 'high',
  },
  { value: 'claude-opus-4-6', label: 'Claude Opus 4.6', supportedEfforts: ['low', 'medium', 'high', 'max'] },
  { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', supportedEfforts: ['low', 'medium', 'high', 'max'] },
  { value: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
];

export const CLAUDE_RPC = {
  SESSIONS_LIST: 'agent-claude:sessions.list',
  SESSIONS_LOAD: 'agent-claude:sessions.load',
  SESSIONS_WATCH: 'agent-claude:sessions.watch',
  SESSIONS_UNWATCH: 'agent-claude:sessions.unwatch',
  PROMPT_SEND: 'agent-claude:prompt.send',
  PROMPT_CANCEL: 'agent-claude:prompt.cancel',
  AUTH_LOGIN: 'agent-claude:auth.login',
  AUTH_CANCEL: 'agent-claude:auth.cancel',
  PERMISSION_RESPOND: 'agent-claude:permission.respond',
  QUESTION_RESPOND: 'agent-claude:question.respond',
  QUOTA_GET: 'agent-claude:quota.get',
  MODELS_LIST: 'agent-claude:models.list',
  RUNTIME_INFO: 'agent-claude:runtime.info',
  ASSETS_SCAN: 'agent-claude:assets.scan',
} as const;

export const CLAUDE_BUS = {
  EVENT: 'agent-claude:event',
  QUOTA_UPDATED: 'agent-claude:quota.updated',
  MODELS_UPDATED: 'agent-claude:models.updated',
  ASSETS_UPDATED: 'agent-claude:assets.updated',
} as const;
