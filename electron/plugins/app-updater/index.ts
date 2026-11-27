import { app, shell } from 'electron';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BuiltinPluginPackage, HostPluginModule } from '../../../src/kernel/shared/types';
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

    let state: AppUpdaterStateSnapshot = {
      mode: isGitRepo ? 'git' : 'release',
      status: 'idle',
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
    let applying = false;
    let startTimer: ReturnType<typeof setTimeout> | null = null;
    let intervalTimer: ReturnType<typeof setInterval> | null = null;

    const emitState = (patch: Partial<AppUpdaterStateSnapshot>) => {
      state = { ...state, ...patch };
      if (!disposed) {
        ctx.bus.publish(APP_UPDATER_BUS.STATE_UPDATED, state);
      }
    };

    const getCfg = () => sanitizeConfig(ctx.config.get());

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
              const commits: UpdateCommitItem[] = logRes.ok && logRes.stdout.trim()
                ? logRes.stdout
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
                    .filter((c) => Boolean(c.sha))
                : [];

              emitState({
                mode: 'git',
                status: aheadCount > 0 ? 'update-available' : 'up-to-date',
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
                emitState({
                  mode: 'git',
                  status: cmp.aheadCount > 0 ? 'update-available' : 'up-to-date',
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

    const applyGitUpdate = async (): Promise<{ ok: boolean; error?: string }> => {
      if (applying) return { ok: false, error: '이미 업데이트가 진행 중입니다.' };
      if (!isGitRepo) {
        await shell.openExternal(state.releaseUrl);
        return { ok: true };
      }

      const cfg = getCfg();
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
        // Safety guard 1: never clobber dirty tracked edits
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
        const prevHead = prevHeadRes.ok ? prevHeadRes.stdout.trim() : '';

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

        // Only run `npm install` when package.json or package-lock.json changed
        let needsNpmInstall = false;
        if (prevHead) {
          const diffRes = await runCmd('git', ['diff', '--name-only', `${prevHead}..HEAD`], repoRoot, 5_000);
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

        emitState({
          status: 'ready-to-restart',
          currentVersion: readPackageVersion(repoRoot),
          currentSha: newSha,
          remoteSha: newSha,
          aheadCount: 0,
          applyStage: 'done',
          progressText: '업데이트가 완료되었습니다. 앱을 재시작하면 바로 적용됩니다.',
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
    ctx.rpc.handle<void, { ok: boolean; error?: string }>(APP_UPDATER_RPC.APPLY, async () => await applyGitUpdate());
    ctx.rpc.handle<void, { ok: boolean }>(APP_UPDATER_RPC.RELAUNCH, () => {
      app.relaunch();
      app.exit(0);
      return { ok: true };
    });
    ctx.rpc.handle<{ remoteKey?: string | null } | undefined, AppUpdaterStateSnapshot>(
      APP_UPDATER_RPC.DISMISS,
      (payload) => {
        const key = payload?.remoteKey ?? (state.mode === 'git' ? state.remoteSha : state.latestVersion);
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

    schedulePeriodicChecks();

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
    }, 'app-updater:cleanup');
  },
};

export const appUpdaterHostPackage: BuiltinPluginPackage = {
  manifest: appUpdaterManifest,
  host: appUpdaterHost,
};
