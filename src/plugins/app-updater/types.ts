export type UpdaterMode = 'git' | 'release';

export type UpdateSource = 'remote' | 'local-build' | 'local-commit' | null;

export type UpdaterStatus =
  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'update-available'
  | 'updating'
  | 'ready-to-restart'
  | 'error';

export type UpdateApplyStage = 'fetching' | 'pulling' | 'installing' | 'building' | 'restarting' | 'done';

export interface UpdateCommitItem {
  readonly sha: string;
  readonly message: string;
  readonly relativeTime: string;
}

export interface AppUpdaterStateSnapshot {
  readonly mode: UpdaterMode;
  readonly status: UpdaterStatus;
  readonly updateSource: UpdateSource;
  readonly updateKey: string | null;
  readonly currentVersion: string;
  readonly currentBranch: string | null;
  readonly currentSha: string | null;
  readonly remoteSha: string | null;
  readonly latestVersion: string | null;
  readonly aheadCount: number;
  readonly commits: UpdateCommitItem[];
  readonly releaseNotes: string | null;
  readonly releaseUrl: string;
  readonly repoUrl: string;
  readonly dirtyWorkingTree: boolean;
  readonly applyStage: UpdateApplyStage | null;
  readonly progressText: string | null;
  readonly error: string | null;
  readonly lastCheckedAt: string | null;
  readonly dismissedRemoteKey: string | null;
}

export interface AppUpdaterConfig extends Record<string, unknown> {
  autoCheckOnStart: boolean;
  checkIntervalMinutes: number;
  repoSlug: string;
  branch: string;
}

export const APP_UPDATER_RPC = {
  GET_STATE: 'app-updater:get-state',
  CHECK: 'app-updater:check',
  APPLY: 'app-updater:apply',
  RELAUNCH: 'app-updater:relaunch',
  DISMISS: 'app-updater:dismiss',
  OPEN_EXTERNAL: 'app-updater:open-external',
} as const;

export const APP_UPDATER_BUS = {
  STATE_UPDATED: 'app-updater:state-updated',
} as const;
