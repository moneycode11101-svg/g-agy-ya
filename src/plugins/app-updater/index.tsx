import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertTriangle,
  ArrowRight,
  ArrowUpCircle,
  CheckCircle2,
  Download,
  ExternalLink,
  GitCommitHorizontal,
  Loader2,
  MoreVertical,
  RefreshCw,
  X,
} from 'lucide-react';
import { create } from 'zustand';
import {
  getDeskKernelBridge,
  useIntrospectionStore,
  type BuiltinPluginPackage,
  type ClientPluginModule,
  type DeskClientContext,
} from '../../kernel/client';
import { fmtAgo } from '../../utils/formatKo';
import { appUpdaterManifest } from './manifest';
import {
  APP_UPDATER_BUS,
  APP_UPDATER_RPC,
  type AppUpdaterConfig,
  type AppUpdaterStateSnapshot,
} from './types';

interface AppUpdaterUiStore {
  snapshot: AppUpdaterStateSnapshot | null;
  popoverOpen: boolean;
  setSnapshot: (snap: AppUpdaterStateSnapshot) => void;
  setPopoverOpen: (open: boolean) => void;
  togglePopover: () => void;
}

const useAppUpdaterStore = create<AppUpdaterUiStore>((set) => ({
  snapshot: null,
  popoverOpen: false,
  setSnapshot: (snapshot) => set({ snapshot }),
  setPopoverOpen: (popoverOpen) => set({ popoverOpen }),
  togglePopover: () => set((s) => ({ popoverOpen: !s.popoverOpen })),
}));

async function invokeCheck(manual = true): Promise<void> {
  const bridge = getDeskKernelBridge();
  if (!bridge) return;
  try {
    const snap = await bridge.rpc.invoke<AppUpdaterStateSnapshot>(APP_UPDATER_RPC.CHECK, { manual });
    if (snap) useAppUpdaterStore.getState().setSnapshot(snap);
  } catch {
    // host handles error state
  }
}

async function invokeApply(autoRelaunch = false): Promise<void> {
  const bridge = getDeskKernelBridge();
  if (!bridge) return;
  try {
    await bridge.rpc.invoke<{ ok: boolean; error?: string }>(APP_UPDATER_RPC.APPLY, { autoRelaunch });
  } catch {
    // host handles error state
  }
}

async function invokeRelaunch(): Promise<void> {
  const bridge = getDeskKernelBridge();
  if (!bridge) return;
  try {
    await bridge.rpc.invoke(APP_UPDATER_RPC.RELAUNCH);
  } catch {
    // ignore
  }
}

async function invokeDismiss(): Promise<void> {
  const bridge = getDeskKernelBridge();
  if (!bridge) return;
  try {
    const snap = await bridge.rpc.invoke<AppUpdaterStateSnapshot>(APP_UPDATER_RPC.DISMISS);
    if (snap) useAppUpdaterStore.getState().setSnapshot(snap);
    useAppUpdaterStore.getState().setPopoverOpen(false);
  } catch {
    // ignore
  }
}

async function invokeOpenExternal(url?: string): Promise<void> {
  const bridge = getDeskKernelBridge();
  if (!bridge) return;
  try {
    await bridge.rpc.invoke(APP_UPDATER_RPC.OPEN_EXTERNAL, { url });
  } catch {
    // ignore
  }
}

const TitlebarUpdateControl: React.FC = () => {
  const snap = useAppUpdaterStore((s) => s.snapshot);
  const open = useAppUpdaterStore((s) => s.popoverOpen);
  const setOpen = useAppUpdaterStore((s) => s.setPopoverOpen);
  const toggleOpen = useAppUpdaterStore((s) => s.togglePopover);

  const anchorWrapRef = useRef<HTMLDivElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ right: number; top: number }>({ right: 16, top: 48 });

  const effectiveKey = snap
    ? snap.updateKey ?? (snap.mode === 'git' ? snap.remoteSha : snap.latestVersion)
    : null;
  const isDismissed = Boolean(effectiveKey && snap?.dismissedRemoteKey === effectiveKey);
  const isUpdating = snap?.status === 'updating';
  const isReadyToRestart = snap?.status === 'ready-to-restart';
  const isUpdateAvailable = snap?.status === 'update-available';
  const isChecking = snap?.status === 'checking';

  const hasVisibleReady = isReadyToRestart && !isDismissed;
  const hasVisibleUpdate = isUpdateAvailable && !isDismissed;
  const showUpdatePill = isUpdating || hasVisibleReady || hasVisibleUpdate;
  const hasDismissedPatch = isDismissed && (isReadyToRestart || isUpdateAvailable);

  const canOneClickApplyAndRestart = Boolean(
    isUpdateAvailable &&
      snap?.mode === 'git' &&
      (snap.updateSource === 'local-commit' || !snap.dirtyWorkingTree)
  );

  useEffect(() => {
    if (!open) return;
    const syncPos = () => {
      const r = anchorWrapRef.current?.getBoundingClientRect();
      if (!r) return;
      const right = Math.max(12, Math.round(window.innerWidth - r.right));
      const top = Math.round(r.bottom + 6);
      setPos({ right, top });
    };
    syncPos();
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (anchorWrapRef.current?.contains(target) || popoverRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('resize', syncPos);
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('resize', syncPos);
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, setOpen]);

  const handleTogglePopover = () => {
    const next = !open;
    toggleOpen();
    if (next && (!snap || snap.status === 'idle')) {
      void invokeCheck(true);
    }
  };

  const handlePillClick = () => {
    if (isUpdating) {
      toggleOpen();
      return;
    }
    if (isReadyToRestart) {
      void invokeRelaunch();
      return;
    }
    if (canOneClickApplyAndRestart) {
      void invokeApply(true);
      return;
    }
    setOpen(true);
  };

  const pillLabel = isUpdating
    ? snap?.applyStage === 'restarting'
      ? '다시 시작하는 중…'
      : snap?.applyStage === 'building'
        ? '빌드 중…'
        : '업데이트 중…'
    : isReadyToRestart || canOneClickApplyAndRestart
      ? '다시 시작하여 업데이트'
      : '업데이트 확인';

  const pillTitle = isUpdating
    ? snap?.progressText || '업데이트를 적용하는 중입니다'
    : isReadyToRestart
      ? snap?.updateSource === 'local-build'
        ? '새 로컬 빌드가 준비되었습니다 — 클릭해서 바로 재시작'
        : '업데이트 빌드 완료 — 클릭해서 바로 재시작'
      : canOneClickApplyAndRestart
        ? snap?.updateSource === 'local-commit'
          ? `로컬 커밋 ${snap.aheadCount}건 빌드 후 바로 재시작`
          : `새 패치 ${snap?.aheadCount || 1}건 적용 후 바로 재시작`
        : '업데이트 상세 확인';

  return (
    <>
      <div ref={anchorWrapRef} className="inline-flex items-center gap-0.5 app-no-drag shrink-0">
        {showUpdatePill ? (
          <>
            <button
              type="button"
              onClick={handlePillClick}
              className="h-[27px] px-3 rounded-full inline-flex items-center gap-1.5 text-[12px] font-semibold cursor-pointer transition-all hover:brightness-95 active:scale-[0.98] whitespace-nowrap shrink-0"
              style={{
                background: 'var(--accent)',
                color: '#ffffff',
                boxShadow: '0 1px 2px rgba(15, 23, 42, 0.14)',
              }}
              title={pillTitle}
            >
              {isUpdating && <Loader2 size={12} className="animate-spin shrink-0" />}
              <span>{pillLabel}</span>
              {!isUpdating && <ArrowRight size={13} strokeWidth={2.3} className="shrink-0" />}
            </button>
            <button
              type="button"
              onClick={handleTogglePopover}
              className="p-1.5 rounded-lg cursor-pointer transition-colors hover:bg-[var(--surface)] shrink-0"
              style={{ color: open ? 'var(--fg)' : 'var(--muted)' }}
              title="업데이트 상세 · 변경 내역 보기"
              aria-label="업데이트 상세 보기"
            >
              <MoreVertical size={14} />
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={handleTogglePopover}
            className="relative p-1.5 rounded-lg cursor-pointer transition-colors hover:bg-[var(--surface)] shrink-0"
            style={{ color: open ? 'var(--fg)' : 'var(--muted)' }}
            title={hasDismissedPatch ? '대기 중인 업데이트가 있습니다' : '앱 업데이트 확인'}
            aria-label="앱 업데이트 확인"
          >
            {isChecking ? (
              <Loader2 size={14} className="animate-spin shrink-0" />
            ) : (
              <ArrowUpCircle size={15} className="shrink-0" />
            )}
            {hasDismissedPatch && (
              <span
                className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full"
                style={{ background: 'var(--accent)' }}
              />
            )}
          </button>
        )}
      </div>

      {open &&
        createPortal(
          <div
            ref={popoverRef}
            className="fixed z-[95] w-[360px] max-w-[calc(100vw-24px)] rounded-2xl border overflow-hidden text-[12px]"
            style={{
              right: `${pos.right}px`,
              top: `${pos.top}px`,
              background: 'var(--card)',
              borderColor: 'var(--border-strong)',
              boxShadow: 'var(--shadow-popover)',
              color: 'var(--fg)',
            }}
          >
            {/* Header */}
            <div
              className="px-3.5 py-2.5 border-b flex items-center justify-between gap-2"
              style={{ background: 'var(--sidebar)', borderColor: 'var(--border)' }}
            >
              <div className="min-w-0">
                <div className="text-[13px] font-semibold flex items-center gap-1.5">
                  <Download size={13} style={{ color: 'var(--accent)' }} />
                  <span>제제이야 업데이트</span>
                </div>
                <div className="text-[11px] font-mono truncate mt-0.5" style={{ color: 'var(--muted)' }}>
                  v{snap?.currentVersion || '0.1.0'}
                  {snap?.currentSha ? ` · ${snap.currentSha}` : ''}
                  {snap?.currentBranch ? ` (${snap.currentBranch})` : ''}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="p-1 rounded-lg hover:bg-[var(--surface)] cursor-pointer shrink-0"
                style={{ color: 'var(--muted)' }}
                title="닫기"
              >
                <X size={13} />
              </button>
            </div>

            {/* Body */}
            <div className="p-3.5 space-y-3">
              {isChecking && (
                <div className="flex items-center gap-2 py-3 text-[12px]" style={{ color: 'var(--muted)' }}>
                  <Loader2 size={14} className="animate-spin" style={{ color: 'var(--accent)' }} />
                  <span>최신 패치를 확인하는 중…</span>
                </div>
              )}

              {isUpdating && (
                <div
                  className="rounded-xl border p-3 space-y-2"
                  style={{
                    background: 'color-mix(in srgb, var(--accent) 8%, var(--bg))',
                    borderColor: 'color-mix(in srgb, var(--accent) 30%, var(--border))',
                  }}
                >
                  <div className="flex items-center gap-2 font-medium" style={{ color: 'var(--accent)' }}>
                    <Loader2 size={14} className="animate-spin shrink-0" />
                    <span>{snap?.progressText || '업데이트를 적용하는 중…'}</span>
                  </div>
                  <div className="text-[11px]" style={{ color: 'var(--muted)' }}>
                    완료될 때까지 창을 닫지 마세요. 빌드가 끝나면 바로 반영됩니다.
                  </div>
                </div>
              )}

              {isReadyToRestart && (
                <>
                  <div
                    className="rounded-xl border p-3 space-y-1.5"
                    style={{
                      background: 'color-mix(in srgb, var(--accent) 8%, var(--bg))',
                      borderColor: 'color-mix(in srgb, var(--accent) 30%, var(--border))',
                    }}
                  >
                    <div className="flex items-center gap-2 font-semibold" style={{ color: 'var(--accent)' }}>
                      <CheckCircle2 size={14} className="shrink-0" />
                      <span>
                        {snap?.updateSource === 'local-build'
                          ? '새 로컬 빌드가 준비되었습니다'
                          : '최신 패치 빌드가 완료되었습니다'}
                      </span>
                    </div>
                    <div className="text-[11.5px] leading-relaxed" style={{ color: 'var(--fg-soft)' }}>
                      다시 시작하면 새 빌드({snap?.currentSha || `v${snap?.currentVersion}`})가 즉시 적용됩니다.
                    </div>
                  </div>

                  {snap && snap.commits.length > 0 && (
                    <div className="space-y-1">
                      <div className="text-[11px] font-semibold" style={{ color: 'var(--muted)' }}>
                        반영될 패치
                      </div>
                      <div
                        className="max-h-[168px] overflow-y-auto scroll-thin rounded-xl border divide-y"
                        style={{ background: 'var(--bg)', borderColor: 'var(--border)' }}
                      >
                        {snap.commits.map((c) => (
                          <div
                            key={c.sha}
                            className="px-2.5 py-2 flex items-start gap-2 text-[11.5px]"
                            style={{ borderColor: 'var(--border)' }}
                          >
                            <GitCommitHorizontal size={13} className="shrink-0 mt-0.5" style={{ color: 'var(--accent)' }} />
                            <div className="min-w-0 flex-1">
                              <div className="leading-snug break-keep">{c.message}</div>
                              <div className="text-[10px] font-mono mt-0.5" style={{ color: 'var(--muted)' }}>
                                {c.sha}
                                {c.relativeTime ? ` · ${c.relativeTime}` : ''}
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}

              {snap?.status === 'update-available' && (
                <>
                  <div
                    className="rounded-xl border p-3 space-y-1.5"
                    style={{
                      background: 'color-mix(in srgb, var(--accent) 8%, var(--bg))',
                      borderColor: 'color-mix(in srgb, var(--accent) 28%, var(--border))',
                    }}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold" style={{ color: 'var(--accent)' }}>
                        {snap.updateSource === 'local-commit'
                          ? `새 로컬 커밋 ${snap.aheadCount}건 (빌드 필요)`
                          : snap.mode === 'git'
                            ? `새 패치 ${snap.aheadCount}개가 있습니다`
                            : `새 버전 ${snap.latestVersion} 출시`}
                      </span>
                      {snap.remoteSha && (
                        <span className="font-mono text-[10.5px]" style={{ color: 'var(--muted)' }}>
                          {snap.currentSha} → {snap.remoteSha}
                        </span>
                      )}
                    </div>
                    <p className="text-[11.5px] leading-snug" style={{ color: 'var(--fg-soft)' }}>
                      {snap.updateSource === 'local-commit'
                        ? '아래 버튼을 누르면 로컬 커밋을 빌드하고 바로 다시 시작합니다.'
                        : snap.mode === 'git'
                          ? '아래 버튼을 누르면 git pull · 빌드 후 바로 다시 시작합니다.'
                          : 'GitHub 릴리즈 페이지에서 최신 설치 파일을 받을 수 있습니다.'}
                    </p>
                  </div>

                  {snap.commits.length > 0 && (
                    <div className="space-y-1">
                      <div className="text-[11px] font-semibold" style={{ color: 'var(--muted)' }}>
                        변경된 패치
                      </div>
                      <div
                        className="max-h-[168px] overflow-y-auto scroll-thin rounded-xl border divide-y"
                        style={{ background: 'var(--bg)', borderColor: 'var(--border)' }}
                      >
                        {snap.commits.map((c) => (
                          <div
                            key={c.sha}
                            className="px-2.5 py-2 flex items-start gap-2 text-[11.5px]"
                            style={{ borderColor: 'var(--border)' }}
                          >
                            <GitCommitHorizontal size={13} className="shrink-0 mt-0.5" style={{ color: 'var(--accent)' }} />
                            <div className="min-w-0 flex-1">
                              <div className="leading-snug break-keep">{c.message}</div>
                              <div className="text-[10px] font-mono mt-0.5" style={{ color: 'var(--muted)' }}>
                                {c.sha}
                                {c.relativeTime ? ` · ${c.relativeTime}` : ''}
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {snap.mode === 'release' && snap.releaseNotes && (
                    <pre
                      className="max-h-[150px] overflow-y-auto scroll-thin rounded-xl border p-2.5 text-[11px] whitespace-pre-wrap font-sans"
                      style={{ background: 'var(--bg)', borderColor: 'var(--border)', color: 'var(--fg-soft)' }}
                    >
                      {snap.releaseNotes}
                    </pre>
                  )}

                  {snap.mode === 'git' && snap.updateSource !== 'local-commit' && snap.dirtyWorkingTree && (
                    <div
                      className="rounded-xl border px-2.5 py-2 flex items-start gap-2 text-[11px]"
                      style={{
                        background: 'color-mix(in srgb, var(--warn) 10%, var(--bg))',
                        borderColor: 'color-mix(in srgb, var(--warn) 35%, var(--border))',
                        color: 'var(--fg-soft)',
                      }}
                    >
                      <AlertTriangle size={13} className="shrink-0 mt-0.5" style={{ color: 'var(--warn)' }} />
                      <span>로컬에 수정 중인 파일이 감지되었습니다. 변경사항을 보호하기 위해 커밋/정리 후 업데이트해 주세요.</span>
                    </div>
                  )}
                </>
              )}

              {snap?.status === 'up-to-date' && (
                <div className="flex items-center gap-2 py-2 text-[12px]" style={{ color: 'var(--fg-soft)' }}>
                  <CheckCircle2 size={15} style={{ color: 'var(--ok)' }} className="shrink-0" />
                  <div>
                    <div className="font-medium">최신 버전을 사용 중입니다.</div>
                    {snap.lastCheckedAt && (
                      <div className="text-[11px]" style={{ color: 'var(--muted)' }}>
                        마지막 확인: {fmtAgo(Date.parse(snap.lastCheckedAt)) || '방금 전'}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {snap?.status === 'error' && (
                <div
                  className="rounded-xl border p-2.5 flex items-start gap-2 text-[11.5px]"
                  style={{
                    background: 'color-mix(in srgb, var(--danger) 10%, var(--bg))',
                    borderColor: 'color-mix(in srgb, var(--danger) 35%, var(--border))',
                    color: 'var(--fg)',
                  }}
                >
                  <AlertTriangle size={14} className="shrink-0 mt-0.5" style={{ color: 'var(--danger)' }} />
                  <div className="leading-snug break-keep">{snap.error || '업데이트 확인 중 오류가 발생했습니다.'}</div>
                </div>
              )}

              {/* Footer Actions */}
              <div className="flex items-center justify-between gap-2 pt-1">
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    disabled={isChecking || isUpdating}
                    onClick={() => void invokeCheck(true)}
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border text-[11.5px] cursor-pointer hover:bg-[var(--surface)] disabled:opacity-50"
                    style={{ background: 'var(--bg)', borderColor: 'var(--border)', color: 'var(--fg-soft)' }}
                  >
                    <RefreshCw size={11} className={isChecking ? 'animate-spin' : ''} />
                    <span>다시 확인</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => void invokeOpenExternal(snap?.mode === 'release' ? snap.releaseUrl : snap?.repoUrl)}
                    className="inline-flex items-center gap-1 px-2 py-1.5 rounded-lg border text-[11.5px] cursor-pointer hover:bg-[var(--surface)]"
                    style={{ background: 'var(--bg)', borderColor: 'var(--border)', color: 'var(--muted)' }}
                    title="GitHub 저장소 열기"
                  >
                    <ExternalLink size={11} />
                    <span>GitHub</span>
                  </button>
                </div>

                <div className="flex items-center gap-1.5">
                  {(snap?.status === 'update-available' || isReadyToRestart) && (
                    <button
                      type="button"
                      onClick={() => void invokeDismiss()}
                      className="px-2 py-1.5 rounded-lg text-[11px] cursor-pointer hover:bg-[var(--surface)]"
                      style={{ color: 'var(--muted)' }}
                    >
                      나중에
                    </button>
                  )}
                  {snap?.status === 'update-available' && (
                    <button
                      type="button"
                      disabled={snap.mode === 'git' && snap.updateSource !== 'local-commit' && snap.dirtyWorkingTree}
                      onClick={() => void invokeApply(snap.mode === 'git')}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11.5px] font-semibold cursor-pointer hover:brightness-95 disabled:opacity-45 disabled:cursor-not-allowed"
                      style={{ background: 'var(--accent)', color: '#fff' }}
                    >
                      <span>{snap.mode === 'git' ? '다시 시작하여 업데이트' : '다운로드'}</span>
                      <ArrowRight size={12} strokeWidth={2.3} />
                    </button>
                  )}
                  {isReadyToRestart && (
                    <button
                      type="button"
                      onClick={() => void invokeRelaunch()}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11.5px] font-semibold cursor-pointer hover:brightness-95"
                      style={{ background: 'var(--accent)', color: '#fff' }}
                    >
                      <span>다시 시작하여 업데이트</span>
                      <ArrowRight size={12} strokeWidth={2.3} />
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>,
          document.body
        )}
    </>
  );
};

export const appUpdaterClient: ClientPluginModule<AppUpdaterConfig> = {
  activate(ctx: DeskClientContext<AppUpdaterConfig>) {
    // Hydrate initial state from host
    void ctx.rpc
      .invoke<AppUpdaterStateSnapshot>(APP_UPDATER_RPC.GET_STATE)
      .then((snap) => {
        if (snap) useAppUpdaterStore.getState().setSnapshot(snap);
      })
      .catch(() => {});

    // Subscribe to live update state changes
    let prevNotifiedKey: string | null = null;
    ctx.bus.subscribe<AppUpdaterStateSnapshot>(APP_UPDATER_BUS.STATE_UPDATED, (env) => {
      const snap = env?.payload;
      if (!snap) return;
      useAppUpdaterStore.getState().setSnapshot(snap);

      // Show a single unobtrusive toast when a new patch or local build is discovered
      const notifyKey = snap.updateKey ?? (snap.mode === 'git' ? snap.remoteSha : snap.latestVersion);
      if (
        (snap.status === 'update-available' || snap.status === 'ready-to-restart') &&
        notifyKey &&
        notifyKey !== prevNotifiedKey &&
        notifyKey !== snap.dismissedRemoteKey
      ) {
        prevNotifiedKey = notifyKey;
        const msg =
          snap.status === 'ready-to-restart'
            ? '새 빌드가 준비되었습니다. 상단 "다시 시작하여 업데이트"를 누르면 바로 적용됩니다.'
            : snap.updateSource === 'local-commit'
              ? `새 로컬 커밋 ${snap.aheadCount}건이 있습니다. 상단 버튼으로 빌드 후 바로 재시작할 수 있습니다.`
              : snap.mode === 'git'
                ? `새 패치 ${snap.aheadCount}개가 있습니다. 상단 "다시 시작하여 업데이트"로 바로 적용할 수 있습니다.`
                : `새 버전 ${snap.latestVersion}이 출시되었습니다.`;
        useIntrospectionStore.getState().pushToast(msg, 'info');
      }
    });

    // Titlebar update badge & popover
    ctx.slots.register('titlebar.actions', {
      id: 'app-updater-badge',
      zone: 'right',
      order: 8,
      Component: TitlebarUpdateControl,
    });

    // Settings section
    ctx.slots.register('settings.section', {
      id: 'app-updater-settings',
      group: '시스템 · 알림',
      title: '앱 업데이트',
      description: 'GitHub 최신 패치 자동 확인 및 원클릭 업데이트를 설정합니다.',
      icon: ArrowUpCircle,
      order: 75,
      schema: appUpdaterManifest.configSchema,
    });

    // Command Palette entry
    ctx.commands.register({
      id: 'app-updater:check',
      title: '앱 업데이트 지금 확인',
      run: () => {
        useAppUpdaterStore.getState().setPopoverOpen(true);
        void invokeCheck(true);
      },
    });
  },
};

export const appUpdaterClientPackage: BuiltinPluginPackage = {
  manifest: appUpdaterManifest,
  client: appUpdaterClient,
};
