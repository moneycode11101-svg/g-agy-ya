import type {
  AccountQuotaSnapshot,
  AgentEvent,
  ChatMessage,
  ChatMode,
  SessionMetrics,
  SessionSummary,
} from './types';
import type { RuntimeAssetsProjection } from '../kernel/shared/types';

/**
 * Clean, zero-telemetry multi-agent L2 harness contract shared by:
 * - `agent-agy` (Antigravity CLI / ACP)
 * - `agent-claude` (Claude Code via `@anthropic-ai/claude-agent-sdk`)
 * - `agent-codex` (Codex CLI via `codex app-server --stdio` JSONL)
 *
 * Notice: No external telemetry, analytics, PostHog, Axiom, Clerk, or cloud relay hooks exist.
 */

export type AgentAdapterId = 'agent-agy' | 'agent-claude' | 'agent-codex' | (string & {});

export interface AgentCapabilities {
  readonly quota: boolean;
  readonly runtimeAssets: boolean;
  readonly sessionHistory: boolean;
  readonly interactiveApproval: boolean;
  readonly userQuestions: boolean;
  readonly steering: boolean;
}

export interface AgentModelOption {
  readonly value: string;
  readonly label: string;
  readonly supportedEfforts?: readonly string[];
  readonly defaultEffort?: string;
}

export interface AgentSendPromptRequest {
  tabSessionId: string;
  /** External provider session / thread ID (`agyConversationId` kept as alias for backward compat) */
  agyConversationId: string | null;
  externalSessionId?: string | null;
  prompt: string;
  cwd: string;
  addDirs?: string[];
  model: string;
  effort: string;
  mode: ChatMode;
  images?: string[];
}

export interface AgentLoadedSession {
  messages: ChatMessage[];
  metrics: SessionMetrics | null;
}

export interface AgentRuntimeInfo {
  appVersion: string;
  cliVersion: string;
  hostname: string;
  email: string | null;
  planTier: string | null;
  homePath?: string | null;
}

export interface AgentAdapterHostService {
  readonly id: AgentAdapterId;
  readonly displayName: string;
  readonly capabilities: AgentCapabilities;
  sendPrompt(req: AgentSendPromptRequest): Promise<{ ok: boolean; error?: string }> | { ok: boolean; error?: string };
  cancelTurn(tabSessionId: string): Promise<void> | void;
  submitAuthCode?(tabSessionId: string, code: string): boolean;
  respondPermission(tabSessionId: string, requestId: string, optionId: string | null): boolean;
  respondQuestion?(tabSessionId: string, requestId: string, answers: Record<string, string | string[]> | null): boolean;
  watchSession?(tabSessionId: string, conversationId: string): SessionMetrics | null;
  unwatchSession?(tabSessionId: string): void;
  listSessions(limit?: number): Promise<SessionSummary[]> | SessionSummary[];
  loadSession(conversationId: string): Promise<AgentLoadedSession> | AgentLoadedSession;
  getQuota(force?: boolean): Promise<AccountQuotaSnapshot>;
  listModels(force?: boolean): Promise<AgentModelOption[]>;
  getRuntimeInfo(): Promise<AgentRuntimeInfo> | AgentRuntimeInfo;
  scanRuntimeAssets?(cwd?: string): Promise<RuntimeAssetsProjection>;
}

export interface ClientAgentAdapterDescriptor {
  readonly id: AgentAdapterId;
  readonly shortLabel: string;
  readonly displayName: string;
  readonly accentColor: string;
  readonly rpcPrefix: string;
  readonly busEventTopic: string;
  readonly busQuotaTopic: string;
  readonly capabilities: AgentCapabilities;
  readonly fallbackModels: readonly AgentModelOption[];
}

export type AgentRpcMethod =
  | 'sessions.list'
  | 'sessions.load'
  | 'sessions.watch'
  | 'sessions.unwatch'
  | 'prompt.send'
  | 'prompt.cancel'
  | 'auth.submitCode'
  | 'permission.respond'
  | 'question.respond'
  | 'quota.get'
  | 'models.list'
  | 'runtime.info'
  | 'assets.scan'
  | 'assets.toggle';

/** Resolves the standardized namespaced RPC method for any agent adapter plugin. */
export function agentRpc(adapterId: string, method: AgentRpcMethod): string {
  return `${adapterId}:${method}`;
}

/** Shared cross-adapter Event Bus channels (in addition to adapter-specific legacy channels). */
export const AGENT_BUS = {
  EVENT: 'agent:event',
  QUOTA_UPDATED: 'agent:quota.updated',
  ASSETS_UPDATED: 'agent:assets.updated',
} as const;

export interface AgentQuotaBusPayload {
  readonly adapterId: string;
  readonly snapshot: AccountQuotaSnapshot;
}

export type AgentBusEventPayload = AgentEvent;

/**
 * Truncates text without splitting a UTF-16 surrogate pair.
 * Prevents broken JSON / Codex `turn/start` hang caused by trailing lone high surrogates.
 */
export function safeTruncateUtf16(input: string, maxChars: number, suffix = '…'): string {
  if (!input || input.length <= maxChars) return input;
  let end = Math.max(0, maxChars);
  if (end > 0) {
    const lastCode = input.charCodeAt(end - 1);
    if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
      end -= 1;
    }
  }
  return input.slice(0, end) + suffix;
}

/** Strips ANSI/VT escape sequences from CLI stderr or permission reason text. */
export function stripAnsi(input: string): string {
  return input.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
}
