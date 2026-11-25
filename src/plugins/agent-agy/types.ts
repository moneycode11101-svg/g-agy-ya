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
  addDirs?: string[];
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
  sendPrompt(req: AgySendPromptRequest): Promise<{ ok: boolean; error?: string }> | { ok: boolean; error?: string };
  cancelTurn(tabSessionId: string): void;
  submitAuthCode(tabSessionId: string, code: string): boolean;
  respondPermission(tabSessionId: string, requestId: string, optionId: string | null): boolean;
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
  { value: 'gemini-4-neon-xhigh', label: 'Gemini 4 Neon (XHigh)' },
  { value: 'gemini-4-neon-high', label: 'Gemini 4 Neon (High)' },
  { value: 'gemini-4-neon-medium', label: 'Gemini 4 Neon (Medium)' },
  { value: 'gemini-4-neon-low', label: 'Gemini 4 Neon (Low)' },
  { value: 'gemini-4-carbon-high', label: 'Gemini 4 Carbon (High)' },
  { value: 'gemini-4-carbon-medium', label: 'Gemini 4 Carbon (Medium)' },
  { value: 'gemini-4-carbon-low', label: 'Gemini 4 Carbon (Low)' },
  { value: 'gemini-4-argon-high', label: 'Gemini 4 Argon (High)' },
  { value: 'gemini-4-argon-medium', label: 'Gemini 4 Argon (Medium)' },
  { value: 'gemini-4-argon-low', label: 'Gemini 4 Argon (Low)' },
  { value: 'gemini-4-hydrogen-xhigh', label: 'Gemini 4 Hydrogen (XHigh)' },
  { value: 'gemini-4-hydrogen-high', label: 'Gemini 4 Hydrogen (High)' },
  { value: 'gemini-4-hydrogen-medium', label: 'Gemini 4 Hydrogen (Medium)' },
  { value: 'gemini-4-hydrogen-low', label: 'Gemini 4 Hydrogen (Low)' },
  { value: 'gemini-pro-orchestrator-neon', label: 'Orchestrator (Neon)' },
  { value: 'gemini-pro-orchestrator', label: 'Orchestrator (Carbon)' },
  { value: 'gemini-pro-orchestrator-argon', label: 'Orchestrator (Argon)' },
  { value: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)' },
  { value: 'gemini-3.8-flash-medium', label: 'Gemini 3.8 Flash (Medium)' },
  { value: 'gemini-3.8-flash-low', label: 'Gemini 3.8 Flash (Low)' },
  { value: 'claude-opus-5-5-high', label: 'Claude Opus 5.5 (High)' },
  { value: 'claude-opus-5-5-medium', label: 'Claude Opus 5.5 (Medium)' },
  { value: 'claude-opus-5-5-low', label: 'Claude Opus 5.5 (Low)' },
  { value: 'claude-sonnet-5-5-high', label: 'Claude Sonnet 5.5 (High)' },
  { value: 'claude-sonnet-5-5-medium', label: 'Claude Sonnet 5.5 (Medium)' },
  { value: 'claude-sonnet-5-5-low', label: 'Claude Sonnet 5.5 (Low)' },
  { value: 'gpt-oss-120b-medium', label: 'GPT-OSS 120B (Medium)' },
];

export const AGY_RPC = {
  SESSIONS_LIST: 'agent-agy:sessions.list',
  SESSIONS_LOAD: 'agent-agy:sessions.load',
  SESSIONS_WATCH: 'agent-agy:sessions.watch',
  SESSIONS_UNWATCH: 'agent-agy:sessions.unwatch',
  PROMPT_SEND: 'agent-agy:prompt.send',
  PROMPT_CANCEL: 'agent-agy:prompt.cancel',
  AUTH_SUBMIT: 'agent-agy:auth.submitCode',
  PERMISSION_RESPOND: 'agent-agy:permission.respond',
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
