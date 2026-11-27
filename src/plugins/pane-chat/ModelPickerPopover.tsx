import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { BarChart3, Check, ChevronRight, RefreshCw } from 'lucide-react';
import { TIER_KO, type ModelFamilyGroup } from './modelCatalog';

export interface ModelPickerPopoverProps {
  open: boolean;
  anchorRef: React.RefObject<HTMLElement | null>;
  onClose: () => void;
  availableModelsCount: number;
  modelFamilies: ModelFamilyGroup[];
  currentModel: string;
  currentEffort?: string;
  refreshingModels: boolean;
  onRefreshModels: () => void;
  onSelectModel: (modelValue: string, effort?: string) => void;
  onOpenUsage: () => void;
}

const MAIN_WIDTH = 300;
const SUB_WIDTH = 184;
const SUB_GAP = 6;
const VIEWPORT_PAD = 10;

interface MainPos {
  left: number;
  bottom: number;
  maxListHeight: number;
}

interface SubPos {
  left: number;
  top: number;
  side: 'right' | 'left';
  inlineMode: boolean;
}

export const ModelPickerPopover: React.FC<ModelPickerPopoverProps> = ({
  open,
  anchorRef,
  onClose,
  availableModelsCount,
  modelFamilies,
  currentModel,
  currentEffort,
  refreshingModels,
  onRefreshModels,
  onSelectModel,
  onOpenUsage,
}) => {
  const normalizedEffort = currentEffort || 'default';

  const activeModelFamily = useMemo(() => {
    const exact = modelFamilies.find((f) => f.variants.some((v) => v.value === currentModel));
    if (exact) return exact;
    if (currentModel && currentModel !== 'default') {
      return (
        modelFamilies.find((f) => f.id !== 'default' && f.resolvedModel === currentModel) || null
      );
    }
    return null;
  }, [modelFamilies, currentModel]);

  const [activeFamilyId, setActiveFamilyId] = useState<string | null>(null);
  const [mainPos, setMainPos] = useState<MainPos | null>(null);
  const [subPos, setSubPos] = useState<SubPos | null>(null);

  const mainMenuRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const submenuRef = useRef<HTMLDivElement | null>(null);
  const rowRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const wasOpenRef = useRef(false);

  // Initialize hovered/active family ONLY when popover transitions closed -> open
  useEffect(() => {
    if (open && !wasOpenRef.current) {
      const defaultFam =
        activeModelFamily && activeModelFamily.variants.length > 1
          ? activeModelFamily.id
          : modelFamilies.find((f) => f.variants.length > 1)?.id || null;
      setActiveFamilyId(defaultFam);
    }
    wasOpenRef.current = open;
  }, [open, activeModelFamily, modelFamilies]);

  const expandedFamily = useMemo(() => {
    if (!activeFamilyId) return null;
    const fam = modelFamilies.find((f) => f.id === activeFamilyId) || null;
    return fam && fam.variants.length > 1 ? fam : null;
  }, [activeFamilyId, modelFamilies]);

  const computeMainPosition = useCallback(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const r = anchor.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const width = Math.min(MAIN_WIDTH, vw - VIEWPORT_PAD * 2);
    const left = Math.max(VIEWPORT_PAD, Math.min(r.left, vw - width - VIEWPORT_PAD));
    const bottom = Math.max(VIEWPORT_PAD, vh - r.top + 8);
    // Reserve ~104px for header + footer + borders inside the popover
    const availableAbove = Math.max(180, r.top - 8 - VIEWPORT_PAD);
    const maxListHeight = Math.min(460, Math.max(160, availableAbove - 104));
    setMainPos({ left, bottom, maxListHeight });
  }, [anchorRef]);

  const computeSubPosition = useCallback(() => {
    if (!open || !expandedFamily) {
      setSubPos(null);
      return;
    }
    const mainEl = mainMenuRef.current;
    if (!mainEl) return;

    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const mainRect = mainEl.getBoundingClientRect();

    const canFitRight = mainRect.right + SUB_GAP + SUB_WIDTH <= vw - VIEWPORT_PAD;
    const canFitLeft = mainRect.left - SUB_GAP - SUB_WIDTH >= VIEWPORT_PAD;

    if (!canFitRight && !canFitLeft) {
      setSubPos({ left: 0, top: 0, side: 'right', inlineMode: true });
      return;
    }

    const side: 'right' | 'left' = canFitRight ? 'right' : 'left';
    const left = side === 'right' ? mainRect.right + SUB_GAP : mainRect.left - SUB_GAP - SUB_WIDTH;

    const rowEl = rowRefs.current.get(expandedFamily.id);
    const listEl = listRef.current;
    const rowRect = rowEl?.getBoundingClientRect();
    const listRect = listEl?.getBoundingClientRect();

    let anchorTop = mainRect.top + 36;
    if (rowRect) {
      if (listRect) {
        anchorTop = Math.max(listRect.top, Math.min(rowRect.top, listRect.bottom - rowRect.height));
      } else {
        anchorTop = rowRect.top;
      }
    }

    // Offset by -6px (p-1.5) so submenu's first block aligns flush with the hovered row
    const desiredTop = anchorTop - 6;
    const estimatedH = 48 + expandedFamily.variants.length * 32 + 12;
    const measuredH = submenuRef.current?.offsetHeight || estimatedH;
    const top = Math.max(VIEWPORT_PAD, Math.min(desiredTop, vh - measuredH - VIEWPORT_PAD));

    setSubPos({ left, top, side, inlineMode: false });
  }, [open, expandedFamily]);

  // Measure main menu synchronously before paint
  useLayoutEffect(() => {
    if (!open) {
      setMainPos(null);
      setSubPos(null);
      return;
    }
    computeMainPosition();
  }, [open, computeMainPosition, modelFamilies.length]);

  // Measure submenu synchronously after main menu & expandedFamily are laid out
  useLayoutEffect(() => {
    if (!open || !mainPos) return;
    computeSubPosition();
  }, [open, mainPos, expandedFamily, computeSubPosition]);

  // Clamp submenu top against its actual rendered height on initial mount
  useLayoutEffect(() => {
    if (!open || !subPos || subPos.inlineMode) return;
    const el = submenuRef.current;
    if (!el) return;
    const actualH = el.offsetHeight;
    const maxTop = Math.max(VIEWPORT_PAD, window.innerHeight - actualH - VIEWPORT_PAD);
    if (subPos.top > maxTop) {
      setSubPos((prev) => (prev && prev.top > maxTop ? { ...prev, top: maxTop } : prev));
    }
  }, [open, subPos, expandedFamily]);

  // Keep positions accurate on window resize and dismiss on outside mousedown / Escape
  useEffect(() => {
    if (!open) return;

    const onResize = () => {
      computeMainPosition();
      computeSubPosition();
    };
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (mainMenuRef.current?.contains(target)) return;
      if (submenuRef.current?.contains(target)) return;
      if (anchorRef.current?.contains(target)) return;
      onClose();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };

    window.addEventListener('resize', onResize);
    window.addEventListener('mousedown', onMouseDown, true);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('mousedown', onMouseDown, true);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open, anchorRef, onClose, computeMainPosition, computeSubPosition]);

  if (!open || !mainPos) return null;

  const isInlineMode = Boolean(subPos?.inlineMode);

  return createPortal(
    <>
      {/* 메인 모델 패밀리 목록 */}
      <div
        ref={mainMenuRef}
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        className="fixed z-[120] rounded-2xl border p-1.5 select-none"
        style={{
          left: mainPos.left,
          bottom: mainPos.bottom,
          width: Math.min(MAIN_WIDTH, window.innerWidth - VIEWPORT_PAD * 2),
          background: 'var(--card)',
          borderColor: 'var(--border)',
          boxShadow: 'var(--shadow-popover)',
        }}
      >
        <div className="px-2.5 py-1.5 flex items-center justify-between gap-2">
          <span className="text-[11px] font-semibold" style={{ color: 'var(--muted)' }}>
            모델
          </span>
          <div className="flex items-center gap-1">
            <span className="text-[10px] font-mono" style={{ color: 'var(--muted)' }}>
              {availableModelsCount}개
            </span>
            <button
              type="button"
              onClick={onRefreshModels}
              className="p-1 rounded-md hover:bg-[var(--surface)] cursor-pointer"
              style={{ color: 'var(--muted)' }}
              title="모델 목록 새로고침"
              aria-label="모델 목록 새로고침"
            >
              <RefreshCw size={11} className={refreshingModels ? 'animate-spin' : ''} />
            </button>
          </div>
        </div>

        <div
          ref={listRef}
          onScroll={computeSubPosition}
          className="space-y-0.5 overflow-y-auto scroll-thin"
          style={{ maxHeight: mainPos.maxListHeight }}
        >
          {modelFamilies.map((fam) => {
            const isSelectedFamily = activeModelFamily?.id === fam.id;
            const activeVariant = isSelectedFamily
              ? fam.isEffortSubmenu
                ? fam.variants.find((v) => (v.effort || 'default') === normalizedEffort) || fam.variants[0]
                : fam.variants.find((v) => v.value === currentModel)
              : undefined;
            const isExpanded = expandedFamily?.id === fam.id;
            const hasMultiple = fam.variants.length > 1;
            const shownTier = fam.isEffortSubmenu
              ? isSelectedFamily && normalizedEffort !== 'default'
                ? TIER_KO[normalizedEffort] || normalizedEffort
                : ''
              : activeVariant?.tierLabel ||
                fam.variants.find((v) => v.value === fam.defaultVariantValue)?.tierLabel ||
                '';

            return (
              <div key={fam.id} className="space-y-1">
                <button
                  ref={(el) => {
                    if (el) rowRefs.current.set(fam.id, el);
                    else rowRefs.current.delete(fam.id);
                  }}
                  type="button"
                  onMouseEnter={() => {
                    if (hasMultiple) setActiveFamilyId(fam.id);
                    else setActiveFamilyId(null);
                  }}
                  onClick={() => {
                    if (!hasMultiple || !isInlineMode) {
                      onSelectModel(fam.defaultVariantValue, fam.defaultVariantEffort);
                    } else {
                      setActiveFamilyId(isExpanded ? null : fam.id);
                    }
                  }}
                  title={fam.description || undefined}
                  className="w-full text-left px-2.5 py-1.5 rounded-xl text-[12.5px] cursor-pointer transition-colors flex items-center justify-between gap-2"
                  style={{
                    background: isExpanded
                      ? 'var(--surface-active)'
                      : isSelectedFamily
                        ? 'var(--surface)'
                        : undefined,
                    color: 'var(--fg)',
                  }}
                >
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span
                      className="truncate"
                      style={{ fontWeight: isSelectedFamily ? 600 : 450 }}
                    >
                      {fam.name}
                    </span>
                    {shownTier && (
                      <span className="text-[11.5px] shrink-0" style={{ color: 'var(--muted)' }}>
                        {shownTier}
                      </span>
                    )}
                    {fam.badge && (
                      <span
                        className="text-[10px] px-1.5 py-[1px] rounded-full shrink-0"
                        style={{
                          background:
                            fam.badge.tone === 'warn'
                              ? 'color-mix(in srgb, var(--warn) 12%, var(--surface))'
                              : 'var(--surface)',
                          color: fam.badge.tone === 'warn' ? 'var(--warn)' : 'var(--muted)',
                        }}
                      >
                        {fam.badge.label}
                      </span>
                    )}
                  </div>
                  <span className="shrink-0 flex items-center gap-1" style={{ color: 'var(--muted)' }}>
                    {isSelectedFamily && <Check size={13} style={{ color: 'var(--fg)' }} />}
                    {hasMultiple && <ChevronRight size={13} />}
                  </span>
                </button>

                {/* 초소형 창(좌우 공간 모두 부족할 때)용 인라인 티어 선택 바 */}
                {isInlineMode && hasMultiple && isExpanded && (
                  <div className="flex flex-wrap gap-1 px-2.5 pb-1.5">
                    {fam.variants.map((v) => {
                      const active =
                        isSelectedFamily &&
                        (fam.isEffortSubmenu
                          ? (v.effort || 'default') === normalizedEffort
                          : currentModel === v.value);
                      return (
                        <button
                          key={v.key}
                          type="button"
                          onClick={() => onSelectModel(v.value, v.effort)}
                          className="px-2 py-0.5 rounded-md text-[11px] cursor-pointer transition-colors"
                          style={{
                            background: active ? 'var(--fg)' : 'var(--surface)',
                            color: active ? 'var(--bg)' : 'var(--fg-soft)',
                            fontWeight: active ? 600 : 400,
                          }}
                        >
                          {v.tierLabel || v.rawLabel}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="border-t mt-1.5 pt-1.5" style={{ borderColor: 'var(--border)' }}>
          <button
            type="button"
            onClick={onOpenUsage}
            className="w-full text-left px-2.5 py-1.5 rounded-xl text-[12px] cursor-pointer hover:bg-[var(--surface)] flex items-center justify-between gap-2"
            style={{ color: 'var(--fg-soft)' }}
          >
            <span className="inline-flex items-center gap-2">
              <BarChart3 size={13} style={{ color: 'var(--muted)' }} />
              <span>사용량 보기</span>
            </span>
            <ChevronRight size={13} style={{ color: 'var(--muted)' }} />
          </button>
        </div>
      </div>

      {/* 호버/선택된 행에 맞춰 정렬되는 플로팅 서브메뉴 (패인 overflow-hidden에 잘리지 않음) */}
      {expandedFamily && subPos && !subPos.inlineMode && (
        <div
          ref={submenuRef}
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          className="fixed z-[121] rounded-2xl border p-1.5 space-y-0.5 select-none"
          style={{
            left: subPos.left,
            top: subPos.top,
            width: SUB_WIDTH,
            background: 'var(--card)',
            borderColor: 'var(--border)',
            boxShadow: 'var(--shadow-popover)',
          }}
        >
          {/* 메인 메뉴와 서브메뉴 사이 간격 호버 브리지 */}
          <div
            aria-hidden="true"
            className="absolute top-0 bottom-0"
            style={
              subPos.side === 'right'
                ? { left: -SUB_GAP - 2, width: SUB_GAP + 4 }
                : { right: -SUB_GAP - 2, width: SUB_GAP + 4 }
            }
          />

          <div className="px-2.5 py-1">
            <div className="text-[11px] font-semibold truncate" style={{ color: 'var(--fg)' }}>
              {expandedFamily.name}
            </div>
            <div className="text-[10px]" style={{ color: 'var(--muted)' }}>
              {expandedFamily.id === 'orchestrator' ? '백엔드 모델 선택' : '추론 강도 선택'}
            </div>
          </div>

          {expandedFamily.variants.map((v) => {
            const isExpandedSelected = activeModelFamily?.id === expandedFamily.id;
            const active =
              isExpandedSelected &&
              (expandedFamily.isEffortSubmenu
                ? (v.effort || 'default') === normalizedEffort
                : currentModel === v.value);
            return (
              <button
                key={v.key}
                type="button"
                onClick={() => onSelectModel(v.value, v.effort)}
                className="w-full text-left px-2.5 py-1.5 rounded-xl text-xs cursor-pointer transition-colors hover:bg-[var(--surface)] flex items-center justify-between gap-2"
                style={{
                  background: active ? 'var(--surface-active)' : undefined,
                  fontWeight: active ? 600 : 400,
                  color: 'var(--fg)',
                }}
              >
                <span className="truncate">{v.tierLabel || v.rawLabel}</span>
                {active && <Check size={12} className="shrink-0" />}
              </button>
            );
          })}
        </div>
      )}
    </>,
    document.body
  );
};
