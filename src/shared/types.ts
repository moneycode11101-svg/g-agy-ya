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
  title?: string;
  kind?: string;
  argsSummary: string;
  outputPreview?: string;
  status: 'running' | 'done' | 'error';
  deltaTokens?: number;
  startedAt?: number;
  endedAt?: number;
}

export interface ChatStepItem {
  title: string;
  status: 'pending' | 'in_progress' | 'done' | 'skipped' | 'failed';
}

export type ChatBlock =
  | { id: string; type: 'thinking'; text: string; startedAt: number; endedAt?: number }
  | { id: string; type: 'tool'; tool: ToolCallItem }
  | { id: string; type: 'text'; text: string }
  | { id: string; type: 'steps'; items: ChatStepItem[] }
  | { id: string; type: 'plan'; text: string };

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  thinking?: string;
  tools?: ToolCallItem[];
  blocks?: ChatBlock[];
  focus?: string;
  images?: string[]; // file paths attached
  createdAt: number;
  endedAt?: number;
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

export type QuotaGroupKey = 'gemini' | 'claude' | 'codex';
export type QuotaWindow = '5h' | 'weekly' | 'monthly';

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
  adapterId?: string;
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
  adapterId?: string;
  conversationId: string;
  source: 'cli' | 'app';
  title: string;
  projectId: string;
  projectLabel: string;
  cwd?: string;
  updatedAt: number;
  currentContext: number;
  model: string;
}

export interface AuthPromptMethod {
  id: string;
  label: string;
  description?: string;
}

export interface AuthPrompt {
  title?: string;
  url?: string;
  message: string;
  mode?: 'acp' | 'code';
  methods?: AuthPromptMethod[];
  loggingIn?: boolean;
  error?: string;
  pendingRetry?: {
    groupId: string;
    tabId: string;
    prompt: string;
    images?: string[];
    userMessageId?: string;
  };
}

export interface PermissionOption {
  optionId: string;
  name: string;
  kind?: string;
}

export interface PermissionPrompt {
  requestId: string;
  toolName: string;
  title: string;
  argsSummary: string;
  rawInput?: string;
  options: PermissionOption[];
}

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface QuestionItem {
  id: string;
  header: string;
  question: string;
  options?: QuestionOption[];
  multiSelect?: boolean;
  isSecret?: boolean;
}

export interface QuestionPrompt {
  requestId: string;
  questions: QuestionItem[];
}

export type AgyEvent =
  | { type: 'session_init'; adapterId?: string; tabSessionId: string; agyConversationId: string; model?: string }
  | { type: 'session_title'; adapterId?: string; tabSessionId: string; title: string }
  | { type: 'commands_update'; adapterId?: string; commands: Array<{ name: string; description: string }> }
  | { type: 'text_delta'; adapterId?: string; tabSessionId: string; delta: string }
  | { type: 'thinking_delta'; adapterId?: string; tabSessionId: string; delta: string }
  | { type: 'focus_update'; adapterId?: string; tabSessionId: string; focus: string }
  | { type: 'steps_update'; adapterId?: string; tabSessionId: string; steps: ChatStepItem[] }
  | { type: 'plan_proposed'; adapterId?: string; tabSessionId: string; plan: string }
  | { type: 'tool_use'; adapterId?: string; tabSessionId: string; tool: ToolCallItem }
  | { type: 'tool_delta'; adapterId?: string; tabSessionId: string; toolId: string; delta: string }
  | { type: 'tool_result'; adapterId?: string; tabSessionId: string; toolId: string; output: string; isError?: boolean }
  | { type: 'permission_request'; adapterId?: string; tabSessionId: string; request: PermissionPrompt }
  | { type: 'permission_cleared'; adapterId?: string; tabSessionId: string; requestId?: string }
  | { type: 'question_request'; adapterId?: string; tabSessionId: string; request: QuestionPrompt }
  | { type: 'question_cleared'; adapterId?: string; tabSessionId: string; requestId?: string }
  | { type: 'usage_delta'; adapterId?: string; tabSessionId: string; used: number; size: number }
  | { type: 'notice'; adapterId?: string; tabSessionId: string; level: 'info' | 'warn' | 'error'; text: string }
  | {
      type: 'auth_required';
      adapterId?: string;
      tabSessionId: string;
      title?: string;
      url?: string;
      message: string;
      mode?: 'acp' | 'code';
      methods?: Array<{ id: string; label: string; description?: string }>;
    }
  | { type: 'auth_cleared'; adapterId?: string; tabSessionId?: string }
  | { type: 'metrics'; adapterId?: string; tabSessionId: string; metrics: SessionMetrics }
  | { type: 'done'; adapterId?: string; tabSessionId: string; exitCode: number; error?: string };

export type AgentEvent = AgyEvent;

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
