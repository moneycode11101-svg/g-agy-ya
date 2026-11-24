import type { ChatMode } from './types';

export type PermissionPreset = 'turbo' | 'auto' | 'accept-edits' | 'plan' | 'strict';
export type ThemeMode = 'system' | 'light' | 'dark';
export type ContrastMode = 'default' | 'high';
export type SendKeyMode = 'enter' | 'cmd-enter';
export type QueueMode = 'queue' | 'immediate';
export type TranscriptViewMode = 'normal' | 'thinking' | 'detailed';
export type ChatWidthMode = 'narrow' | 'medium' | 'wide';
export type LinkOpenTarget = 'external' | 'embedded';
export type GitDiffBase = 'working' | 'head';

export interface AppSettings {
  // 1. 일반 · 입력
  sendKey: SendKeyMode;
  pendingMessageMode: QueueMode;
  confirmCloseRunning: boolean;
  defaultCwd: string;
  preventSleep: boolean;
  keepInMenuBar: boolean;

  // 2. 에이전트 · 모델
  defaultModel: string;
  defaultEffort: string;
  defaultMode: ChatMode;
  localPermission: PermissionPreset;
  allowedCommands: string[];
  warnOnCacheReset: boolean;

  // 3. 화면 · 채팅
  theme: ThemeMode;
  contrast: ContrastMode;
  fontFamily: string;
  fontSizePx: number;
  lightPreset: string;
  lightBg: string;
  lightFg: string;
  lightAccent: string;
  darkBg: string;
  darkFg: string;
  darkAccent: string;
  transcriptView: TranscriptViewMode;
  chatWidth: ChatWidthMode;
  showTokenBar: boolean;
  newRoomWarnPct: number;

  // 4. 웹뷰 · Git
  linkOpenTarget: LinkOpenTarget;
  defaultWebviewUrl: string;
  downloadDir: string;
  gitDiffBase: GitDiffBase;

  // 5. 알림 · 단축키
  notificationsEnabled: boolean;
  soundEnabled: boolean;
  soundVolume: number; // 0..100

  // 6. 스킬 · 프로젝트
  projectFolders: string[];
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  sendKey: 'enter',
  pendingMessageMode: 'queue',
  confirmCloseRunning: true,
  defaultCwd: '',
  preventSleep: false,
  keepInMenuBar: true,

  defaultModel: 'gemini-4-neon-xhigh',
  defaultEffort: 'default',
  defaultMode: 'turbo',
  localPermission: 'turbo',
  allowedCommands: [],
  warnOnCacheReset: true,

  theme: 'light',
  contrast: 'default',
  fontFamily: 'System UI',
  fontSizePx: 14,
  lightPreset: '기본 밝은 테마',
  lightBg: '#FFFFFF',
  lightFg: '#0A0A0C',
  lightAccent: '#2F75C3',
  darkBg: '#111317',
  darkFg: '#EEF1F6',
  darkAccent: '#4C8DFF',
  transcriptView: 'thinking',
  chatWidth: 'narrow',
  showTokenBar: true,
  newRoomWarnPct: 35,

  linkOpenTarget: 'embedded',
  defaultWebviewUrl: 'http://localhost:5173',
  downloadDir: '',
  gitDiffBase: 'working',

  notificationsEnabled: true,
  soundEnabled: false,
  soundVolume: 80,

  projectFolders: [],
};

export interface DiscoveredSkill {
  name: string;
  description: string;
  scope: 'global' | 'plugin' | 'builtin';
  pluginName?: string;
  tokens: number;
}

export interface CustomizationsInventory {
  ruleTokens: number;
  ruleCount: number;
  skillTokens: number;
  skillCount: number;
  mcpTokens: number;
  mcpCount: number;
  skills: DiscoveredSkill[];
  rules: Array<{ name: string; path: string; tokens: number }>;
  mcpServers: Array<{ name: string; pluginName?: string; tokens: number }>;
}

export interface SystemRuntimeInfo {
  appVersion: string;
  agyCliVersion: string;
  hostname: string;
  downloadDir: string;
  email: string | null;
  planTier: string | null;
}
