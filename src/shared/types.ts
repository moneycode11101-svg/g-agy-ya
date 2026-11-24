export type SplitDir = 'h' | 'v';

export type LayoutNode =
  | { type: 'leaf'; groupId: string }
  | { type: 'split'; id: string; dir: SplitDir; ratio: number; a: LayoutNode; b: LayoutNode };

export type PaneKind = 'launcher' | 'chat' | 'terminal' | 'webview' | 'diff';

export type SplitDirection = 'left' | 'right' | 'up' | 'down';

export type ChatMode = 'turbo' | 'accept-edits' | 'plan' | 'strict' | 'auto';

interface BasePaneTab {
  id: string;
  title: string;
  pinned?: boolean;
  color?: string | null;
}

export interface LauncherPaneTab extends BasePaneTab {
  kind: 'launcher';
  cwd: string;
}

export interface ChatPaneTab extends BasePaneTab {
  kind: 'chat';
  sessionId: string; // local tab session key; agyConversationId holds real CLI ID once assigned
  agyConversationId: string | null;
  cwd: string;
  projectLabel?: string;
  model: string;
  effort: string;
  mode: ChatMode;
  source?: 'cli' | 'app' | 'new';
}

export interface TerminalPaneTab extends BasePaneTab {
  kind: 'terminal';
  terminalId: string;
  cwd: string;
}

export interface WebviewPaneTab extends BasePaneTab {
  kind: 'webview';
  url: string;
  partition: string;
}

export interface DiffPaneTab extends BasePaneTab {
  kind: 'diff';
  cwd: string;
  selectedFile?: string;
}

export type PaneTab = LauncherPaneTab | ChatPaneTab | TerminalPaneTab | WebviewPaneTab | DiffPaneTab;

export interface TerminalEvent {
  type: 'data' | 'exit';
  terminalId: string;
  data?: string;
  exitCode?: number;
}

export interface PaneGroup {
  id: string;
  activeTabId: string;
  tabs: PaneTab[];
}

export interface ToolCallItem {
  id: string;
  name: string;
  argsSummary: string;
  outputPreview?: string;
  status: 'running' | 'done' | 'error';
  deltaTokens?: number;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  thinking?: string;
  tools?: ToolCallItem[];
  images?: string[]; // file paths attached
  createdAt: number;
  streaming?: boolean;
}

export interface ToolDeltaSummary {
  name: string;
  count: number;
  deltaTokens: number;
  sharePct: number;
}

export interface TurnHistoryItem {
  invocation: number;
  contextAtCall: number;
  cacheHitPct: number;
  outputTokens: number;
  tokPerSec: number | null;
  compacted: boolean;
  cacheMiss: boolean;
}

export type QuotaGroupKey = 'gemini' | 'claude';
export type QuotaWindow = '5h' | 'weekly';

export interface QuotaBucket {
  id: string;
  group?: QuotaGroupKey;
  groupName?: string;
  window?: QuotaWindow;
  remainingFraction: number | null;
  resetInSeconds: number | null;
  resetTime: string | null;
}

export interface AccountQuotaSnapshot {
  buckets: QuotaBucket[];
  updatedAt: string | null;
  error?: string;
}

export interface SessionMetrics {
  conversationId: string;
  model: string;
  invocations: number;
  currentContext: number;
  contextWindow: number;
  usedPct: number;
  lastCacheRead: number;
  lastInputTokens: number;
  lastCacheHitPct: number;
  lastCallAt: number | null;
  lastTurnTokens: number;
  lastTurnCalls: number;
  lastTurnOutput: number;
  tokPerSec: number | null;
  sessionCumulative: number;
  overallCacheHitPct: number;
  toolDeltas: ToolDeltaSummary[];
  recentTurns: TurnHistoryItem[];
  quotaBuckets: QuotaBucket[];
  quotaUpdatedAt: string | null;
}

export interface SessionSummary {
  conversationId: string;
  source: 'cli' | 'app';
  title: string;
  projectId: string;
  projectLabel: string;
  updatedAt: number;
  currentContext: number;
  model: string;
}

export interface AuthPrompt {
  url: string;
  message: string;
}

export type AgyEvent =
  | { type: 'session_init'; tabSessionId: string; agyConversationId: string; model?: string }
  | { type: 'text_delta'; tabSessionId: string; delta: string }
  | { type: 'thinking_delta'; tabSessionId: string; delta: string }
  | { type: 'tool_use'; tabSessionId: string; tool: ToolCallItem }
  | { type: 'tool_result'; tabSessionId: string; toolId: string; output: string; isError?: boolean }
  | { type: 'auth_required'; tabSessionId: string; url: string; message: string }
  | { type: 'metrics'; tabSessionId: string; metrics: SessionMetrics }
  | { type: 'done'; tabSessionId: string; exitCode: number; error?: string };

export interface GitDiffFile {
  status: string;
  path: string;
}

export interface GitDiffSnapshot {
  ok: boolean;
  cwd: string;
  branch: string;
  files: GitDiffFile[];
  diffText: string;
  error?: string;
}

import type { AppSettings, CustomizationsInventory, SystemRuntimeInfo } from './settingsTypes';

export interface AgyDeskApi {
  platform: string;
  homeDir: string;
  listSessions: () => Promise<SessionSummary[]>;
  loadSession: (conversationId: string) => Promise<{ messages: ChatMessage[]; metrics: SessionMetrics | null }>;
  watchSession: (tabSessionId: string, conversationId: string) => Promise<SessionMetrics | null>;
  unwatchSession: (tabSessionId: string) => Promise<void>;
  sendPrompt: (req: {
    tabSessionId: string;
    agyConversationId: string | null;
    prompt: string;
    cwd: string;
    model: string;
    effort: string;
    mode: ChatMode;
    images?: string[];
  }) => Promise<{ ok: boolean; error?: string }>;
  cancelTurn: (tabSessionId: string) => Promise<void>;
  submitAuthCode: (tabSessionId: string, code: string) => Promise<boolean>;
  onAgyEvent: (cb: (ev: AgyEvent) => void) => () => void;
  onWebviewNewTab: (cb: (url: string) => void) => () => void;
  getQuota: (force?: boolean) => Promise<AccountQuotaSnapshot>;
  onQuotaUpdated: (cb: (snap: AccountQuotaSnapshot) => void) => () => void;
  pickDirectory: () => Promise<string | null>;
  getGitDiff: (cwd: string, filePath?: string) => Promise<GitDiffSnapshot>;
  openExternal: (url: string) => Promise<void>;
  showInFinder: (targetPath: string) => Promise<void>;
  createTerminal: (
    terminalId: string,
    cwd: string,
    cols: number,
    rows: number
  ) => Promise<{ ok: boolean; error?: string }>;
  writeTerminal: (terminalId: string, data: string) => void;
  resizeTerminal: (terminalId: string, cols: number, rows: number) => void;
  killTerminal: (terminalId: string) => Promise<void>;
  onTerminalEvent: (cb: (ev: TerminalEvent) => void) => () => void;
  getSettings: () => Promise<AppSettings>;
  saveSettings: (partial: Partial<AppSettings>) => Promise<AppSettings>;
  getRuntimeInfo: () => Promise<SystemRuntimeInfo>;
  getCustomizationsInventory: () => Promise<CustomizationsInventory>;
  clearBrowserHistory: () => Promise<boolean>;
  openNotificationSettings: () => Promise<void>;
}

declare global {
  interface Window {
    agyDesk: AgyDeskApi;
  }
}
