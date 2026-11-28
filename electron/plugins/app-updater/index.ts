import { app, shell } from 'electron';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BuiltinPluginPackage, Disposer, HostPluginModule } from '../../../src/kernel/shared/types';
import { appUpdaterManifest } from '../../../src/plugins/app-updater/manifest';
import {
  APP_UPDATER_BUS,
  APP_UPDATER_RPC,
  type AppUpdaterConfig,
  type AppUpdaterStateSnapshot,
  type UpdateApplyStage,
  type UpdateCommitItem,
} from '../../../src/plugins/app-updater/types';

const DEFAULT_REPO_SLUG = 'moneycode11101-svg/g-agy-ya';
const DEFAULT_BRANCH = 'main';
const SAFE_SLUG_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SAFE_BRANCH_RE = /^[A-Za-z0-9_./-]+$/;

function resolveRepoRoot(): string {
  const candidates = [
    path.resolve(__dirname, '..'),
    process.cwd(),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
  }
  return path.resolve(__dirname, '..');
}

function readPackageVersion(repoRoot: string): string {
  try {
    const raw = fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    if (typeof parsed.version === 'string' && parsed.version.trim()) {
      return parsed.version.trim();
    }
  } catch {
    // ignore
  }
  return app.getVersion() || '0.1.0';
}

/**
 * Computes a fast content fingerprint of the compiled Electron main bundle
 * and Vite renderer index (which embeds hashed JS/CSS asset filenames).
 * Returns null if build outputs do not exist yet.
 */
function computeBuildFingerprint(repoRoot: string): string | null {
  try {
    const mainCjsPath = path.join(repoRoot, 'dist-electron', 'main.cjs');
    const preloadCjsPath = path.join(repoRoot, 'dist-electron', 'preload.cjs');
    const webIndexPath = path.join(repoRoot, 'dist', 'index.html');
    const hasMain = fs.existsSync(mainCjsPath);
    const hasWeb = fs.existsSync(webIndexPath);
    if (!hasMain && !hasWeb) return null;

    const hash = crypto.createHash('sha1');
    if (hasMain) {
      hash.update('main:');
      hash.update(fs.readFileSync(mainCjsPath));
    }
    if (fs.existsSync(preloadCjsPath)) {
      hash.update('preload:');
      hash.update(fs.readFileSync(preloadCjsPath));
    }
    if (hasWeb) {
      hash.update('web:');
      hash.update(fs.readFileSync(webIndexPath, 'utf8'));
    }
    return hash.digest('hex').slice(0, 16);
  } catch {
    return null;
  }
}

function parseGitLogLines(stdout: string): UpdateCommitItem[] {
  if (!stdout.trim()) return [];
  return stdout
    .trim()
    .split('\n')
    .map((line) => {
      const [sha, message, relativeTime] = line.split('\x1f');
      return {
        sha: (sha || '').trim(),
        message: (message || '').trim(),
        relativeTime: (relativeTime || '').trim(),
      };
    })
    .filter((c) => Boolean(c.sha));
}

function buildToolEnv(): NodeJS.ProcessEnv {
  const home = os.homedir();
  const extraPaths: string[] = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];

  // Include active nvm / volta / asdf node bins so GUI-launched .app bundles find `npm` & `node`
  const nvmDir = path.join(home, '.nvm', 'versions', 'node');
  try {
    if (fs.existsSync(nvmDir)) {
      const versions = fs.readdirSync(nvmDir).sort().reverse();
      for (const v of versions.slice(0, 3)) {
        extraPaths.push(path.join(nvmDir, v, 'bin'));
      }
    }
  } catch {
    // ignore
  }
  extraPaths.push(path.join(home, '.volta', 'bin'), path.join(home, '.asdf', 'shims'));

  const cur = process.env.PATH || '';
  const merged = [...new Set([...extraPaths, ...cur.split(path.delimiter).filter(Boolean)])].join(path.delimiter);
  return {
    ...process.env,
    PATH: merged,
    GIT_TERMINAL_PROMPT: '0',
    LC_ALL: 'C.UTF-8',
  };
}

function runCmd(
  bin: string,
  args: string[],
  cwd: string,
  timeoutMs = 15_000
): Promise<{ ok: boolean; stdout: string; stderr: string; error?: string }> {
  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        env: buildToolEnv(),
      },
      (err, stdout, stderr) => {
        if (err) {
          resolve({
            ok: false,
            stdout: String(stdout || ''),
            stderr: String(stderr || ''),
            error: (String(stderr || '') || String(stdout || '') || err.message).trim(),
          });
          return;
        }
        resolve({
          ok: true,
          stdout: String(stdout || ''),
          stderr: String(stderr || ''),
        });
      }
    );
  });
}

function compareSemver(a: string, b: string): number {
  const parse = (v: string) =>
    v
      .replace(/^v/i, '')
      .split('-')[0]
      .split('.')
      .map((n) => Number.parseInt(n, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  const len = Math.max(pa.length, pb.length, 3);
  for (let i = 0; i < len; i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function fmtRelativeKo(iso?: string): string {
  if (!iso) return '';
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return '';
  const min = Math.floor(ms / 60_000);
  if (min < 1) return '방금 전';
  if (min < 60) return `${min}분 전`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}시간 전`;
  const day = Math.floor(hr / 24);
  return `${day}일 전`;
}

function sanitizeConfig(raw: Partial<AppUpdaterConfig>): AppUpdaterConfig {
  const slug = typeof raw.repoSlug === 'string' && SAFE_SLUG_RE.test(raw.repoSlug.trim())
    ? raw.repoSlug.trim()
    : DEFAULT_REPO_SLUG;
  const branch = typeof raw.branch === 'string' && SAFE_BRANCH_RE.test(raw.branch.trim())
    ? raw.branch.trim()
    : DEFAULT_BRANCH;
  const interval =
    typeof raw.checkIntervalMinutes === 'number' && Number.isFinite(raw.checkIntervalMinutes)
      ? Math.max(0, Math.min(360, raw.checkIntervalMinutes))
      : 60;
  return {
    autoCheckOnStart: raw.autoCheckOnStart !== false,
    checkIntervalMinutes: interval,
    repoSlug: slug,
    branch,
  };
}

export const appUpdaterHost: HostPluginModule<AppUpdaterConfig> = {
  activate(ctx) {
    const repoRoot = resolveRepoRoot();
    const isGitRepo = fs.existsSync(path.join(repoRoot, '.git'));
    const initialCfg = sanitizeConfig(ctx.config.get());
    const bootBuildFingerprint = computeBuildFingerprint(repoRoot);
    let bootFullSha: string | null = null;

    let state: AppUpdaterStateSnapshot = {
      mode: isGitRepo ? 'git' : 'release',
      status: 'idle',
      updateSource: null,
      updateKey: null,
      currentVersion: readPackageVersion(repoRoot),
      currentBranch: null,
      currentSha: null,
      remoteSha: null,
      latestVersion: null,
      aheadCount: 0,
      commits: [],
      releaseNotes: null,
      releaseUrl: `https://github.com/${initialCfg.repoSlug}/releases`,
      repoUrl: `https://github.com/${initialCfg.repoSlug}`,
      dirtyWorkingTree: false,
      applyStage: null,
      progressText: null,
      error: null,
      lastCheckedAt: null,
      dismissedRemoteKey: null,
    };

    let disposed = false;
    let inFlightCheck: Promise<AppUpdaterStateSnapshot> | null = null;
    let inFlightLocalCheck: Promise<boolean> | null = null;
    let applying = false;
    let startTimer: ReturnType<typeof setTimeout> | null = null;
    let intervalTimer: ReturnType<typeof setInterval> | null = null;
    let watchDebounceTimer: ReturnType<typeof setTimeout> | null = null;
    const watchers: fs.FSWatcher[] = [];
    let offWindowFocus: Disposer | null = null;

    const emitState = (patch: Partial<AppUpdaterStateSnapshot>) => {
      state = { ...state, ...patch };
      if (!disposed) {
        ctx.bus.publish(APP_UPDATER_BUS.STATE_UPDATED, state);
      }
    };

    const getCfg = () => sanitizeConfig(ctx.config.get());

    const relaunchApp = () => {
      setTimeout(() => {
        app.relaunch();
        app.quit();
        setTimeout(() => app.exit(0), 2500);
      }, 80);
    };

    const captureBootHead = async (): Promise<void> => {
      if (!isGitRepo || bootFullSha) return;
      const [headRes, branchRes] = await Promise.all([
        runCmd('git', ['rev-parse', 'HEAD'], repoRoot, 5_000),
        runCmd('git', ['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot, 5_000),
      ]);
      if (headRes.ok && headRes.stdout.trim()) {
        bootFullSha = headRes.stdout.trim();
        if (!state.currentSha) {
          emitState({
            currentSha: bootFullSha.slice(0, 7),
            currentBranch: branchRes.ok ? branchRes.stdout.trim() : state.currentBranch,
          });
        }
      }
    };

    /**
     * Detects local compiled bundle updates (`dist-electron/main.cjs` or `dist/index.html`)
     * or new local git commits created while the app is running.
     * Returns true if a local patch/restart state is active.
     */
    const checkLocalPatchState = async (): Promise<boolean> => {
      if (disposed || applying) return false;
      if (inFlightLocalCheck) return inFlightLocalCheck;

      inFlightLocalCheck = (async () => {
        try {
          if (isGitRepo && !bootFullSha) {
            await captureBootHead();
          }

          const nowFingerprint = computeBuildFingerprint(repoRoot);
          const currentVersion = readPackageVersion(repoRoot);

          let headFullSha = '';
          let currentBranch = state.currentBranch;
          let dirtyWorkingTree = state.dirtyWorkingTree;

          if (isGitRepo) {
            const [headRes, branchRes, dirtyRes] = await Promise.all([
              runCmd('git', ['rev-parse', 'HEAD'], repoRoot, 4_000),
              runCmd('git', ['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot, 4_000),
              runCmd('git', ['status', '--porcelain', '--untracked-files=no'], repoRoot, 4_000),
            ]);
            if (headRes.ok) headFullSha = headRes.stdout.trim();
            if (branchRes.ok) currentBranch = branchRes.stdout.trim();
            if (dirtyRes.ok) dirtyWorkingTree = dirtyRes.stdout.trim().length > 0;
          }

          const headShortSha = headFullSha ? headFullSha.slice(0, 7) : state.currentSha;

          // Case 1: Compiled build on disk changed after launch -> ready to restart immediately!
          if (bootBuildFingerprint && nowFingerprint && nowFingerprint !== bootBuildFingerprint) {
            let commits: UpdateCommitItem[] = [];
            if (isGitRepo) {
              const logArgs =
                bootFullSha && headFullSha && headFullSha !== bootFullSha
                  ? ['log', `${bootFullSha}..HEAD`, '--pretty=format:%h%x1f%s%x1f%cr', '--max-count=10']
                  : ['log', '-1', '--pretty=format:%h%x1f%s%x1f%cr'];
              const logRes = await runCmd('git', logArgs, repoRoot, 4_000);
              if (logRes.ok) commits = parseGitLogLines(logRes.stdout);
            }
            const nextKey = `local-build:${nowFingerprint}`;
            emitState({
              status: 'ready-to-restart',
              updateSource: 'local-build',
              updateKey: nextKey,
              currentVersion,
              currentBranch,
              currentSha: headShortSha,
              remoteSha: headShortSha,
              aheadCount: commits.length || 1,
              commits,
              dirtyWorkingTree,
              applyStage: 'done',
              progressText: '새 빌드가 준비되었습니다. 다시 시작하면 바로 적용됩니다.',
              error: null,
              lastCheckedAt: new Date().toISOString(),
            });
            return true;
          }

          // Case 2: New local git commit(s) created after launch, not yet built
          if (isGitRepo && bootFullSha && headFullSha && headFullSha !== bootFullSha) {
            const logRes = await runCmd(
              'git',
              ['log', `${bootFullSha}..HEAD`, '--pretty=format:%h%x1f%s%x1f%cr', '--max-count=10'],
              repoRoot,
              4_000
            );
            const commits = logRes.ok ? parseGitLogLines(logRes.stdout) : [];
            const nextKey = `local-commit:${headFullSha}`;
            emitState({
              mode: 'git',
              status: 'update-available',
              updateSource: 'local-commit',
              updateKey: nextKey,
              currentVersion,
              currentBranch,
              currentSha: bootFullSha.slice(0, 7),
              remoteSha: headShortSha,
              aheadCount: commits.length || 1,
              commits,
              dirtyWorkingTree,
              applyStage: null,
              progressText: null,
              error: null,
              lastCheckedAt: new Date().toISOString(),
            });
            return true;
          }

          return false;
        } catch {
          return false;
        } finally {
          inFlightLocalCheck = null;
        }
      })();

      return inFlightLocalCheck;
    };

    const scheduleLocalCheck = (delayMs = 900) => {
      if (disposed || applying) return;
      if (watchDebounceTimer) clearTimeout(watchDebounceTimer);
      watchDebounceTimer = setTimeout(() => {
        watchDebounceTimer = null;
        void checkLocalPatchState();
      }, delayMs);
    };

    const setupLocalWatchers = () => {
      const watchTargets = [
        path.join(repoRoot, 'dist-electron'),
        path.join(repoRoot, 'dist'),
        ...(isGitRepo ? [path.join(repoRoot, '.git', 'logs')] : []),
      ];
      for (const dir of watchTargets) {
        try {
          if (!fs.existsSync(dir)) continue;
          const w = fs.watch(dir, { persistent: false }, (_ev, filename) => {
            const name = typeof filename === 'string' ? filename : '';
            if (
              !name ||
              name === 'main.cjs' ||
              name === 'preload.cjs' ||
              name === 'index.html' ||
              name === 'HEAD' ||
              name.endsWith('.js') ||
              name.endsWith('.css')
            ) {
              scheduleLocalCheck(900);
            }
          });
          w.on('error', () => {
            // ignore transient fs watcher errors
          });
          watchers.push(w);
        } catch {
          // ignore platforms/paths where fs.watch isn't supported
        }
      }
    };

    const checkViaGitHubCompare = async (
      repoSlug: string,
      localSha: string,
      branch: string
    ): Promise<{ aheadCount: number; remoteSha: string | null; commits: UpdateCommitItem[] } | null> => {
      try {
        const res = await fetch(
          `https://api.github.com/repos/${repoSlug}/compare/${encodeURIComponent(localSha)}...${encodeURIComponent(branch)}`,
          {
            headers: {
              Accept: 'application/vnd.github+json',
              'User-Agent': 'g-agy-ya-updater',
            },
            signal: AbortSignal.timeout(10_000),
          }
        );
        if (!res.ok) return null;
        const data = (await res.json()) as {
          ahead_by?: number;
          commits?: Array<{
            sha?: string;
            commit?: { message?: string; committer?: { date?: string } };
          }>;
        };
        const list = Array.isArray(data.commits) ? data.commits : [];
        const commits: UpdateCommitItem[] = list
          .slice(-10)
          .reverse()
          .map((c) => ({
            sha: String(c.sha || '').slice(0, 7),
            message: String(c.commit?.message || '').split('\n')[0].trim(),
            relativeTime: fmtRelativeKo(c.commit?.committer?.date),
          }));
        const remoteSha = list.length > 0 ? String(list[list.length - 1]?.sha || '').slice(0, 7) : localSha.slice(0, 7);
        return {
          aheadCount: typeof data.ahead_by === 'number' ? data.ahead_by : commits.length,
          remoteSha: remoteSha || null,
          commits,
        };
      } catch {
        return null;
      }
    };

    const checkForUpdates = async (manual = false): Promise<AppUpdaterStateSnapshot> => {
      if (applying) return state;
      if (inFlightCheck) return inFlightCheck;

      inFlightCheck = (async () => {
        // First check whether a newer local build is already waiting for restart
        const hasLocal = await checkLocalPatchState();
        if (hasLocal && state.status === 'ready-to-restart') {
          return state;
        }
        const hadLocalCommit = hasLocal && state.updateSource === 'local-commit';

        const cfg = getCfg();
        const repoUrl = `https://github.com/${cfg.repoSlug}`;
        const currentVersion = readPackageVersion(repoRoot);

        emitState({
          status: 'checking',
          currentVersion,
          repoUrl,
          releaseUrl: `${repoUrl}/releases`,
          error: null,
          progressText: manual ? '최신 패치를 확인하는 중…' : null,
        });

        try {
          if (isGitRepo) {
            const [headRes, branchRes, dirtyRes] = await Promise.all([
              runCmd('git', ['rev-parse', 'HEAD'], repoRoot, 5_000),
              runCmd('git', ['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot, 5_000),
              runCmd('git', ['status', '--porcelain', '--untracked-files=no'], repoRoot, 5_000),
            ]);

            const localFullSha = headRes.ok ? headRes.stdout.trim() : '';
            if (localFullSha && !bootFullSha) bootFullSha = localFullSha;
            const currentSha = localFullSha ? localFullSha.slice(0, 7) : null;
            const currentBranch = branchRes.ok ? branchRes.stdout.trim() : null;
            const dirtyWorkingTree = dirtyRes.ok ? dirtyRes.stdout.trim().length > 0 : false;

            const fetchRes = await runCmd('git', ['fetch', 'origin', cfg.branch, '--quiet'], repoRoot, 14_000);
            if (fetchRes.ok) {
              const targetRef = `origin/${cfg.branch}`;
              const [countRes, remoteShaRes, logRes] = await Promise.all([
                runCmd('git', ['rev-list', '--count', `HEAD..${targetRef}`], repoRoot, 5_000),
                runCmd('git', ['rev-parse', '--short', targetRef], repoRoot, 5_000),
                runCmd(
                  'git',
                  ['log', `HEAD..${targetRef}`, '--pretty=format:%h%x1f%s%x1f%cr', '--max-count=10'],
                  repoRoot,
                  5_000
                ),
              ]);

              const aheadCount = countRes.ok ? Number.parseInt(countRes.stdout.trim(), 10) || 0 : 0;
              const remoteSha = remoteShaRes.ok ? remoteShaRes.stdout.trim() : null;
              const commits = logRes.ok ? parseGitLogLines(logRes.stdout) : [];

              if (aheadCount === 0 && hadLocalCommit) {
                await checkLocalPatchState();
                return state;
              }

              emitState({
                mode: 'git',
                status: aheadCount > 0 ? 'update-available' : 'up-to-date',
                updateSource: aheadCount > 0 ? 'remote' : null,
                updateKey: aheadCount > 0 ? `remote:${remoteSha || aheadCount}` : null,
                currentVersion,
                currentBranch,
                currentSha,
                remoteSha,
                aheadCount,
                commits,
                dirtyWorkingTree,
                progressText: null,
                error: null,
                lastCheckedAt: new Date().toISOString(),
              });
              return state;
            }

            // Fallback: public GitHub compare API if `git fetch` failed (e.g. offline/remote mismatch)
            if (localFullSha) {
              const cmp = await checkViaGitHubCompare(cfg.repoSlug, localFullSha, cfg.branch);
              if (cmp) {
                if (cmp.aheadCount === 0 && hadLocalCommit) {
                  await checkLocalPatchState();
                  return state;
                }
                emitState({
                  mode: 'git',
                  status: cmp.aheadCount > 0 ? 'update-available' : 'up-to-date',
                  updateSource: cmp.aheadCount > 0 ? 'remote' : null,
                  updateKey: cmp.aheadCount > 0 ? `remote:${cmp.remoteSha || cmp.aheadCount}` : null,
                  currentVersion,
                  currentBranch,
                  currentSha,
                  remoteSha: cmp.remoteSha,
                  aheadCount: cmp.aheadCount,
                  commits: cmp.commits,
                  dirtyWorkingTree,
                  progressText: null,
                  error: null,
                  lastCheckedAt: new Date().toISOString(),
                });
                return state;
              }
            }

            if (hadLocalCommit) {
              await checkLocalPatchState();
              return state;
            }

            emitState({
              mode: 'git',
              status: 'error',
              currentBranch,
              currentSha,
              dirtyWorkingTree,
              progressText: null,
              error: manual ? fetchRes.error || '원격 저장소를 확인하지 못했습니다.' : null,
              lastCheckedAt: new Date().toISOString(),
            });
            return state;
          }

          // Packaged app mode: check latest GitHub Release tag (0% telemetry, public API)
          const res = await fetch(`https://api.github.com/repos/${cfg.repoSlug}/releases/latest`, {
            headers: {
              Accept: 'application/vnd.github+json',
              'User-Agent': 'g-agy-ya-updater',
            },
            signal: AbortSignal.timeout(10_000),
          });
          if (res.status === 404) {
            emitState({
              mode: 'release',
              status: 'up-to-date',
              updateSource: null,
              updateKey: null,
              currentVersion,
              latestVersion: currentVersion,
              aheadCount: 0,
              commits: [],
              progressText: null,
              error: null,
              lastCheckedAt: new Date().toISOString(),
            });
            return state;
          }
          if (!res.ok) {
            throw new Error(`GitHub API 응답 오류 (${res.status})`);
          }
          const rel = (await res.json()) as {
            tag_name?: string;
            html_url?: string;
            body?: string;
          };
          const latestVersion = String(rel.tag_name || '').trim() || currentVersion;
          const isNewer = compareSemver(latestVersion, currentVersion) > 0;
          emitState({
            mode: 'release',
            status: isNewer ? 'update-available' : 'up-to-date',
            updateSource: isNewer ? 'remote' : null,
            updateKey: isNewer ? `release:${latestVersion}` : null,
            currentVersion,
            latestVersion,
            aheadCount: isNewer ? 1 : 0,
            releaseNotes: typeof rel.body === 'string' ? rel.body.slice(0, 1200) : null,
            releaseUrl: typeof rel.html_url === 'string' && rel.html_url ? rel.html_url : `${repoUrl}/releases`,
            progressText: null,
            error: null,
            lastCheckedAt: new Date().toISOString(),
          });
          return state;
        } catch (err) {
          emitState({
            status: manual ? 'error' : 'idle',
            progressText: null,
            error: manual ? (err instanceof Error ? err.message : String(err)) : null,
            lastCheckedAt: new Date().toISOString(),
          });
          return state;
        } finally {
          inFlightCheck = null;
        }
      })();

      return inFlightCheck;
    };

    const applyGitUpdate = async (opts?: { autoRelaunch?: boolean }): Promise<{ ok: boolean; error?: string }> => {
      if (applying) return { ok: false, error: '이미 업데이트가 진행 중입니다.' };
      if (state.status === 'ready-to-restart') {
        relaunchApp();
        return { ok: true };
      }
      if (!isGitRepo) {
        await shell.openExternal(state.releaseUrl);
        return { ok: true };
      }

      const cfg = getCfg();
      const isLocalCommitOnly = state.updateSource === 'local-commit';
      applying = true;
      const setStage = (applyStage: UpdateApplyStage, progressText: string) => {
        emitState({
          status: 'updating',
          applyStage,
          progressText,
          error: null,
        });
      };

      try {
        let diffBaseSha = bootFullSha || '';

        if (!isLocalCommitOnly) {
          // Safety guard 1: never clobber dirty tracked edits when pulling remote
          const dirtyRes = await runCmd('git', ['status', '--porcelain', '--untracked-files=no'], repoRoot, 5_000);
          if (dirtyRes.ok && dirtyRes.stdout.trim().length > 0) {
            const msg =
              '로컬에 커밋되지 않은 수정사항이 있어 자동 업데이트를 중단했습니다. 변경사항을 정리한 뒤 다시 시도하세요.';
            emitState({ status: 'error', dirtyWorkingTree: true, applyStage: null, progressText: null, error: msg });
            return { ok: false, error: msg };
          }

          // Safety guard 2: only fast-forward when on the tracked branch
          const branchRes = await runCmd('git', ['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot, 5_000);
          const curBranch = branchRes.ok ? branchRes.stdout.trim() : '';
          if (curBranch !== cfg.branch) {
            const msg = `현재 "${curBranch || 'detached'}" 브랜치에 있습니다. "${cfg.branch}" 브랜치로 전환한 뒤 업데이트해 주세요.`;
            emitState({ status: 'error', currentBranch: curBranch || null, applyStage: null, progressText: null, error: msg });
            return { ok: false, error: msg };
          }

          const prevHeadRes = await runCmd('git', ['rev-parse', 'HEAD'], repoRoot, 5_000);
          diffBaseSha = prevHeadRes.ok ? prevHeadRes.stdout.trim() : '';

          setStage('fetching', '최신 패치를 가져오는 중 (git fetch)…');
          const fetchRes = await runCmd('git', ['fetch', 'origin', cfg.branch, '--quiet'], repoRoot, 20_000);
          if (!fetchRes.ok) {
            throw new Error(fetchRes.error || 'git fetch 실패');
          }

          setStage('pulling', '새 패치를 적용하는 중 (git pull --ff-only)…');
          const pullRes = await runCmd('git', ['pull', '--ff-only', 'origin', cfg.branch], repoRoot, 30_000);
          if (!pullRes.ok) {
            throw new Error(pullRes.error || 'git pull --ff-only 실패 (로컬 커밋이 분기되었을 수 있습니다)');
          }
        }

        // Only run `npm install` when package.json or package-lock.json changed
        let needsNpmInstall = false;
        if (diffBaseSha) {
          const diffRes = await runCmd('git', ['diff', '--name-only', `${diffBaseSha}..HEAD`], repoRoot, 5_000);
          if (diffRes.ok) {
            const changed = diffRes.stdout.split('\n').map((s) => s.trim());
            needsNpmInstall = changed.includes('package.json') || changed.includes('package-lock.json');
          }
        }

        const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm';
        if (needsNpmInstall) {
          setStage('installing', '의존성 패키지를 업데이트하는 중 (npm install)…');
          const instRes = await runCmd(npmBin, ['install'], repoRoot, 180_000);
          if (!instRes.ok) {
            throw new Error(instRes.error || 'npm install 실패');
          }
        }

        setStage('building', '최신 앱을 빌드하는 중 (npm run build)…');
        const buildRes = await runCmd(npmBin, ['run', 'build'], repoRoot, 180_000);
        if (!buildRes.ok) {
          throw new Error(buildRes.error || 'npm run build 실패');
        }

        const newShaRes = await runCmd('git', ['rev-parse', '--short', 'HEAD'], repoRoot, 5_000);
        const newSha = newShaRes.ok ? newShaRes.stdout.trim() : state.remoteSha;
        const freshFp = computeBuildFingerprint(repoRoot);

        if (opts?.autoRelaunch) {
          emitState({
            status: 'updating',
            updateSource: isLocalCommitOnly ? 'local-build' : 'remote',
            updateKey: freshFp ? `local-build:${freshFp}` : state.updateKey,
            currentVersion: readPackageVersion(repoRoot),
            currentSha: newSha,
            remoteSha: newSha,
            aheadCount: 0,
            applyStage: 'restarting',
            progressText: '빌드 완료 — 제제이야를 다시 시작하는 중…',
            error: null,
            lastCheckedAt: new Date().toISOString(),
          });
          relaunchApp();
          return { ok: true };
        }

        emitState({
          status: 'ready-to-restart',
          updateSource: isLocalCommitOnly ? 'local-build' : 'remote',
          updateKey: freshFp ? `local-build:${freshFp}` : state.updateKey,
          currentVersion: readPackageVersion(repoRoot),
          currentSha: newSha,
          remoteSha: newSha,
          aheadCount: 0,
          applyStage: 'done',
          progressText: '업데이트가 완료되었습니다. 다시 시작하면 바로 적용됩니다.',
          error: null,
          lastCheckedAt: new Date().toISOString(),
        });
        return { ok: true };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        emitState({
          status: 'error',
          applyStage: null,
          progressText: null,
          error: msg,
        });
        return { ok: false, error: msg };
      } finally {
        applying = false;
      }
    };

    const schedulePeriodicChecks = () => {
      if (intervalTimer) {
        clearInterval(intervalTimer);
        intervalTimer = null;
      }
      const cfg = getCfg();
      if (cfg.checkIntervalMinutes > 0) {
        intervalTimer = setInterval(() => {
          void checkForUpdates(false);
        }, cfg.checkIntervalMinutes * 60_000);
      }
    };

    // RPC endpoints
    ctx.rpc.handle<void, AppUpdaterStateSnapshot>(APP_UPDATER_RPC.GET_STATE, () => state);
    ctx.rpc.handle<{ manual?: boolean } | undefined, AppUpdaterStateSnapshot>(
      APP_UPDATER_RPC.CHECK,
      async (payload) => await checkForUpdates(payload?.manual !== false)
    );
    ctx.rpc.handle<{ autoRelaunch?: boolean } | undefined, { ok: boolean; error?: string }>(
      APP_UPDATER_RPC.APPLY,
      async (payload) => await applyGitUpdate({ autoRelaunch: Boolean(payload?.autoRelaunch) })
    );
    ctx.rpc.handle<void, { ok: boolean }>(APP_UPDATER_RPC.RELAUNCH, () => {
      relaunchApp();
      return { ok: true };
    });
    ctx.rpc.handle<{ remoteKey?: string | null } | undefined, AppUpdaterStateSnapshot>(
      APP_UPDATER_RPC.DISMISS,
      (payload) => {
        const key =
          payload?.remoteKey ??
          state.updateKey ??
          (state.mode === 'git' ? state.remoteSha : state.latestVersion);
        emitState({ dismissedRemoteKey: key || null });
        return state;
      }
    );
    ctx.rpc.handle<{ url?: string } | undefined, { ok: boolean }>(APP_UPDATER_RPC.OPEN_EXTERNAL, async (payload) => {
      const target = payload?.url && /^https?:\/\//i.test(payload.url) ? payload.url : state.repoUrl;
      await shell.openExternal(target);
      return { ok: true };
    });

    ctx.config.onChange(() => {
      schedulePeriodicChecks();
    });

    void captureBootHead();
    setupLocalWatchers();
    schedulePeriodicChecks();

    // Check local build/commit immediately on window focus, and remote if stale (>10m)
    offWindowFocus = ctx.host.onWindowFocus(() => {
      if (disposed || applying) return;
      void checkLocalPatchState().then((hasLocal) => {
        if (hasLocal || !getCfg().autoCheckOnStart) return;
        const lastMs = state.lastCheckedAt ? Date.parse(state.lastCheckedAt) : 0;
        if (!lastMs || Date.now() - lastMs > 10 * 60_000) {
          void checkForUpdates(false);
        }
      });
    });

    // Non-blocking check 4 seconds after launch so startup latency is untouched
    if (getCfg().autoCheckOnStart) {
      startTimer = setTimeout(() => {
        void checkForUpdates(false);
      }, 4_000);
    }

    ctx.scope.onDispose(() => {
      disposed = true;
      if (startTimer) clearTimeout(startTimer);
      if (intervalTimer) clearInterval(intervalTimer);
      if (watchDebounceTimer) clearTimeout(watchDebounceTimer);
      if (offWindowFocus) void offWindowFocus();
      for (const w of watchers) {
        try {
          w.close();
        } catch {
          // ignore
        }
      }
      watchers.length = 0;
    }, 'app-updater:cleanup');
  },
};

export const appUpdaterHostPackage: BuiltinPluginPackage = {
  manifest: appUpdaterManifest,
  host: appUpdaterHost,
};
