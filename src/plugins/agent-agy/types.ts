import type {
  AccountQuotaSnapshot,
  AgyEvent,
  ChatMessage,
  ChatMode,
  SessionMetrics,
  SessionSummary,
} from '../../shared/types';
import type { RuntimeAssetsProjection } from '../../kernel/shared/types';

export interface AgyPluginConfig extends Record<string, unknown> {
  defaultModel: string;
  defaultEffort: string;
  defaultMode: ChatMode;
  localPermission: 'turbo' | 'auto' | 'accept-edits' | 'plan' | 'strict';
  allowedCommands: string[];
}

export interface AgyModelOption {
  value: string;
  label: string;
}

export interface AgySendPromptRequest {
  tabSessionId: string;
  agyConversationId: string | null;
  prompt: string;
  cwd: string;
  model: string;
  effort: string;
  mode: ChatMode;
  images?: string[];
}

export interface AgyRuntimeInfo {
  appVersion: string;
  agyCliVersion: string;
  hostname: string;
  email: string | null;
  planTier: string | null;
}

export interface AgyLoadedSession {
  messages: ChatMessage[];
  metrics: SessionMetrics | null;
}

export interface AgyAgentAdapterHostService {
  readonly id: string;
  readonly displayName: string;
  sendPrompt(req: AgySendPromptRequest): { ok: boolean; error?: string };
  cancelTurn(tabSessionId: string): void;
  submitAuthCode(tabSessionId: string, code: string): boolean;
  watchSession(tabSessionId: string, conversationId: string): SessionMetrics | null;
  unwatchSession(tabSessionId: string): void;
  listSessions(limit?: number): SessionSummary[];
  loadSession(conversationId: string): AgyLoadedSession;
  getQuota(force?: boolean): Promise<AccountQuotaSnapshot>;
  listModels(force?: boolean): Promise<AgyModelOption[]>;
  getRuntimeInfo(): AgyRuntimeInfo;
  scanRuntimeAssets(cwd?: string): Promise<RuntimeAssetsProjection>;
}

export const FALLBACK_AGY_MODELS: AgyModelOption[] = [
  { value: 'default', label: 'Gemini 4 Neon 기본' },
  { value: 'gemini-4-neon-medium', label: 'Gemini 4 Neon 보통' },
  { value: 'gemini-4-neon-high', label: 'Gemini 4 Neon 높음' },
  { value: 'gemini-4-neon-xhigh', label: 'Gemini 4 Neon 매우 높음' },
  { value: 'claude-sonnet-5-5-high', label: 'Claude Sonnet 5.5' },
  { value: 'claude-opus-5-5-high', label: 'Claude Opus 5.5' },
];

export const AGY_RPC = {
  SESSIONS_LIST: 'agent-agy:sessions.list',
  SESSIONS_LOAD: 'agent-agy:sessions.load',
  SESSIONS_WATCH: 'agent-agy:sessions.watch',
  SESSIONS_UNWATCH: 'agent-agy:sessions.unwatch',
  PROMPT_SEND: 'agent-agy:prompt.send',
  PROMPT_CANCEL: 'agent-agy:prompt.cancel',
  AUTH_SUBMIT: 'agent-agy:auth.submitCode',
  QUOTA_GET: 'agent-agy:quota.get',
  MODELS_LIST: 'agent-agy:models.list',
  RUNTIME_INFO: 'agent-agy:runtime.info',
  ASSETS_SCAN: 'agent-agy:assets.scan',
  ASSETS_TOGGLE: 'agent-agy:assets.toggle',
} as const;

export const AGY_BUS = {
  EVENT: 'agent-agy:event',
  QUOTA_UPDATED: 'agent-agy:quota.updated',
  ASSETS_UPDATED: 'agent-agy:assets.updated',
} as const;

export type AgyBusEventPayload = AgyEvent;
