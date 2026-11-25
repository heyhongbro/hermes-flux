/**
 * 跨端悬浮媒体预览灯箱（放大 / 缩小 / 双指捏合 / 拖拽平移 / 多图跟手滑动切换 / 关闭）
 *
 * 【设计意图 (Why)】
 *   统一 Desktop 与 Mobile 的图片沉浸式预览体验：当会话末尾画廊、Markdown 行内图片、
 *   用户气泡图片或移动端检查舱图片被点击时，直接在当前对话上方悬浮打开，
 *   支持按钮与滚轮/双指缩放、放大后单指自由拖拽平移、1x 态下仿 Bot 头像轮播的
 *   1:1 跟手左右切换及橡皮筋边界反馈。
 *
 * 【防范的历史坑 (Pitfall)】
 *   1. Mobile 壳外层有全屏三屏横向手势拦截，灯箱根节点必须声明 `data-gesture-ignore="pan-x"`
 *      与 `.m-no-swipe`，防止左右滑切图片时误把整屏滑回首页；
 *   2. 严禁内联硬编码十六进制或 rgb 色值，所有视觉层表面与边界完全映射设计 System Tokens；
 *   3. 1x 下拉关闭与 1:1 拖拽必须以点击位移阈值区分「轻触背景关闭」与「拖拽松手」。
 *
 * 【约束与规则 (Rules)】
 *   - 导出纯数学 helper 供 Node 单测验证（缩放夹取、平移边界、边界橡皮筋与跟手裁决）；
 *   - 零 `as any`，卸载时清理全局 `keydown` 监听。
 */

import * as React from 'react';
import { ChevronLeft, ChevronRight, Download, Minus, Plus, RotateCcw, X } from 'lucide-react';
import { t } from '../../i18n/index.js';

export interface MediaLightboxItem {
  id: string;
  src: string;
  path?: string;
  name: string;
  alt?: string;
}

export interface MediaLightboxProps {
  items: readonly MediaLightboxItem[];
  initialIndex: number;
  onClose: () => void;
  onDownload?: (item: MediaLightboxItem) => void;
  resolveMediaUrl?: (pathOrUrl: string) => Promise<string | null>;
}

export const LIGHTBOX_MIN_SCALE = 0.5;
export const LIGHTBOX_MAX_SCALE = 4;
export const LIGHTBOX_SCALE_STEP = 0.25;
export const LIGHTBOX_EDGE_DAMPING = 0.28;
export const LIGHTBOX_MAX_DRAG_PX = 160;
export const LIGHTBOX_SWIPE_COMMIT_PX = 56;
export const LIGHTBOX_SWIPE_FLICK_PX_MS = 0.35;
export const LIGHTBOX_DISMISS_DY_PX = 110;

const SAFE_MEDIA_SRC_RE = /^(?:data:image\/|https?:\/\/|blob:)/i;

/** 夹取灯箱缩放比例至合法区间 `[0.5, 4]`。 */
export function clampLightboxScale(scale: number): number {
  if (!Number.isFinite(scale)) return 1;
  return Math.round(Math.max(LIGHTBOX_MIN_SCALE, Math.min(LIGHTBOX_MAX_SCALE, scale)) * 100) / 100;
}

/** 依据当前缩放倍率与视口尺寸夹取拖拽平移量，避免把大图拖出屏幕外。 */
export function clampLightboxPan(
  panX: number,
  panY: number,
  scale: number,
  viewportWidth: number,
  viewportHeight: number,
): { x: number; y: number } {
  if (!Number.isFinite(scale) || scale <= 1.02) {
    return { x: 0, y: 0 };
  }
  const safeW = Math.max(240, viewportWidth || 390);
  const safeH = Math.max(240, viewportHeight || 640);
  const maxX = Math.round(((scale - 1) * safeW) / 2);
  const maxY = Math.round(((scale - 1) * safeH) / 2);
  return {
    x: Math.max(-maxX, Math.min(maxX, panX)),
    y: Math.max(-maxY, Math.min(maxY, panY)),
  };
}

/**
 * 计算 1x 态下跟手水平拖拽位移（含首尾/单图橡皮筋阻尼与限幅，手感对齐 Bot 头像轮播）。
 */
export function computeLightboxDragDelta(dx: number, currentIndex: number, total: number): number {
  if (!Number.isFinite(dx)) return 0;
  const hasPrev = total > 1 && currentIndex > 0;
  const hasNext = total > 1 && currentIndex < total - 1;
  const hitEdge = (dx > 0 && !hasPrev) || (dx < 0 && !hasNext);
  const scaled = hitEdge ? dx * LIGHTBOX_EDGE_DAMPING : dx;
  const clamped = Math.max(-LIGHTBOX_MAX_DRAG_PX, Math.min(LIGHTBOX_MAX_DRAG_PX, scaled));
  return Math.round(clamped * 100) / 100;
}

/**
 * 裁决 1x 态松手后的切换或下滑关闭结果。
 */
export function computeLightboxSwipeResult(input: {
  totalDx: number;
  totalDy: number;
  durationMs: number;
  currentIndex: number;
  total: number;
}): { action: 'prev' | 'next' | 'close' | 'none'; nextIndex: number } {
  const safeTotal = Math.max(0, input.total);
  if (safeTotal === 0) return { action: 'none', nextIndex: 0 };
  const idx = Math.max(0, Math.min(safeTotal - 1, input.currentIndex));
  const dt = Math.max(1, input.durationMs);
  const vx = input.totalDx / dt;

  if (
    Math.abs(input.totalDy) > LIGHTBOX_DISMISS_DY_PX &&
    Math.abs(input.totalDy) > Math.abs(input.totalDx) * 1.4
  ) {
    return { action: 'close', nextIndex: idx };
  }

  const hasNext = idx < safeTotal - 1;
  const hasPrev = idx > 0;
  if (hasNext && (input.totalDx <= -LIGHTBOX_SWIPE_COMMIT_PX || vx <= -LIGHTBOX_SWIPE_FLICK_PX_MS)) {
    return { action: 'next', nextIndex: idx + 1 };
  }
  if (hasPrev && (input.totalDx >= LIGHTBOX_SWIPE_COMMIT_PX || vx >= LIGHTBOX_SWIPE_FLICK_PX_MS)) {
    return { action: 'prev', nextIndex: idx - 1 };
  }
  return { action: 'none', nextIndex: idx };
}

function pointerDistance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function MediaLightbox({
  items,
  initialIndex,
  onClose,
  onDownload,
  resolveMediaUrl,
}: MediaLightboxProps): React.ReactElement | null {
  const safeInitial = items.length > 0 ? Math.max(0, Math.min(items.length - 1, initialIndex)) : 0;
  const [index, setIndex] = React.useState(safeInitial);
  const [scale, setScale] = React.useState(1);
  const [pan, setPan] = React.useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [swipeDrag, setSwipeDrag] = React.useState<{ dx: number; dy: number }>({ dx: 0, dy: 0 });
  const [isDragging, setIsDragging] = React.useState(false);
  const [resolvedSrcMap, setResolvedSrcMap] = React.useState<Record<string, string>>({});
  const [failedIds, setFailedIds] = React.useState<Record<string, boolean>>({});
  const [retryToken, setRetryToken] = React.useState(0);

  const stageRef = React.useRef<HTMLDivElement | null>(null);
  const pointersRef = React.useRef<Map<number, { x: number; y: number }>>(new Map());
  const pinchStartRef = React.useRef<{ dist: number; scale: number } | null>(null);
  const dragOriginRef = React.useRef<{
    startX: number;
    startY: number;
    panX: number;
    panY: number;
    startTime: number;
    moved: boolean;
  } | null>(null);
  const suppressBackdropCloseRef = React.useRef(false);
  const scaleRef = React.useRef(scale);
  scaleRef.current = scale;

  React.useEffect(() => {
    const clamped = items.length > 0 ? Math.max(0, Math.min(items.length - 1, initialIndex)) : 0;
    setIndex(clamped);
    setScale(1);
    setPan({ x: 0, y: 0 });
    setSwipeDrag({ dx: 0, dy: 0 });
    setFailedIds({});
  }, [initialIndex, items]);

  const currentItem = items[index];

  // 懒解析需要走网关鉴权代理的路径型图片（失败显式呈现错误态与重试钮，禁止无限加载）
  React.useEffect(() => {
    if (!currentItem || !resolveMediaUrl) return;
    const candidate = currentItem.src || currentItem.path || '';
    if (
      !candidate ||
      SAFE_MEDIA_SRC_RE.test(candidate) ||
      resolvedSrcMap[currentItem.id] ||
      failedIds[currentItem.id]
    ) {
      return;
    }

    let cancelled = false;
    void resolveMediaUrl(candidate)
      .then((resolved) => {
        if (cancelled) return;
        if (!resolved || !SAFE_MEDIA_SRC_RE.test(resolved)) {
          setFailedIds((prev) => ({ ...prev, [currentItem.id]: true }));
          return;
        }
        setResolvedSrcMap((prev) => ({ ...prev, [currentItem.id]: resolved }));
      })
      .catch(() => {
        if (cancelled) return;
        setFailedIds((prev) => ({ ...prev, [currentItem.id]: true }));
      });
    return () => {
      cancelled = true;
    };
  }, [currentItem, resolveMediaUrl, resolvedSrcMap, failedIds, retryToken]);

  const resetTransform = React.useCallback(() => {
    setScale(1);
    setPan({ x: 0, y: 0 });
    setSwipeDrag({ dx: 0, dy: 0 });
  }, []);

  const stepIndex = React.useCallback(
    (delta: number) => {
      if (items.length <= 1) return;
      setIndex((prev) => {
        const next = Math.max(0, Math.min(items.length - 1, prev + delta));
        return next;
      });
      setScale(1);
      setPan({ x: 0, y: 0 });
      setSwipeDrag({ dx: 0, dy: 0 });
    },
    [items.length],
  );

  const adjustScale = React.useCallback((nextRaw: number) => {
    const next = clampLightboxScale(nextRaw);
    setScale(next);
    if (next <= 1.02) {
      setPan({ x: 0, y: 0 });
    } else {
      const rect = stageRef.current?.getBoundingClientRect();
      setPan((prev) => clampLightboxPan(prev.x, prev.y, next, rect?.width ?? 640, rect?.height ?? 640));
    }
  }, []);

  const adjustScaleRef = React.useRef(adjustScale);
  adjustScaleRef.current = adjustScale;

  React.useEffect(() => {
    const stageEl = stageRef.current;
    if (!stageEl || typeof stageEl.addEventListener !== 'function') return;
    const onNativeWheel = (event: WheelEvent): void => {
      event.preventDefault();
      const delta = event.deltaY < 0 ? LIGHTBOX_SCALE_STEP : -LIGHTBOX_SCALE_STEP;
      adjustScaleRef.current(scaleRef.current + delta);
    };
    stageEl.addEventListener('wheel', onNativeWheel, { passive: false });
    return () => stageEl.removeEventListener('wheel', onNativeWheel);
  }, []);

  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        stepIndex(-1);
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        stepIndex(1);
      } else if (event.key === '+' || event.key === '=') {
        event.preventDefault();
        adjustScale(scale + LIGHTBOX_SCALE_STEP);
      } else if (event.key === '-') {
        event.preventDefault();
        adjustScale(scale - LIGHTBOX_SCALE_STEP);
      } else if (event.key === '0') {
        event.preventDefault();
        resetTransform();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose, stepIndex, adjustScale, resetTransform, scale]);

  if (!currentItem) return null;

  const rawDisplaySrc = resolvedSrcMap[currentItem.id] || currentItem.src || '';
  const displaySrc = SAFE_MEDIA_SRC_RE.test(rawDisplaySrc) ? rawDisplaySrc : '';
  const isLoadFailed = Boolean(failedIds[currentItem.id] || (!resolveMediaUrl && !displaySrc));
  const zoomPercent = `${Math.round(scale * 100)}%`;

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 && event.pointerType === 'mouse') return;
    if ((event.target as HTMLElement)?.closest?.('button')) return;

    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    // gate-degrade: 无 DOM 环境或浏览器拒绝 pointerCapture 时降级为普通坐标追踪
    } catch {}

    if (pointersRef.current.size === 2) {
      const pts = Array.from(pointersRef.current.values());
      pinchStartRef.current = { dist: Math.max(1, pointerDistance(pts[0], pts[1])), scale };
      dragOriginRef.current = null;
      setSwipeDrag({ dx: 0, dy: 0 });
      return;
    }

    pinchStartRef.current = null;
    dragOriginRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      panX: pan.x,
      panY: pan.y,
      startTime: Date.now(),
      moved: false,
    };
    setIsDragging(true);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (!pointersRef.current.has(event.pointerId)) return;
    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (pointersRef.current.size === 2 && pinchStartRef.current) {
      const pts = Array.from(pointersRef.current.values());
      const dist = pointerDistance(pts[0], pts[1]);
      const factor = dist / pinchStartRef.current.dist;
      adjustScale(pinchStartRef.current.scale * factor);
      return;
    }

    const origin = dragOriginRef.current;
    if (!origin) return;
    const dx = event.clientX - origin.startX;
    const dy = event.clientY - origin.startY;
    if (Math.hypot(dx, dy) > 5) {
      origin.moved = true;
    }

    if (scale > 1.02) {
      const rect = stageRef.current?.getBoundingClientRect();
      setPan(
        clampLightboxPan(
          origin.panX + dx,
          origin.panY + dy,
          scale,
          rect?.width ?? 640,
          rect?.height ?? 640,
        ),
      );
      return;
    }

    const clampedDx = computeLightboxDragDelta(dx, index, items.length);
    const clampedDy = Math.abs(dy) > Math.abs(dx) ? Math.max(-160, Math.min(180, dy * 0.65)) : 0;
    setSwipeDrag({ dx: clampedDx, dy: clampedDy });
  };

  const finishPointer = (event: React.PointerEvent<HTMLDivElement>, canceled: boolean): void => {
    const wasPinching = pinchStartRef.current !== null;
    pointersRef.current.delete(event.pointerId);
    try {
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    // gate-degrade: releasePointerCapture 失败时安全忽略
    } catch {}

    if (pointersRef.current.size < 2) {
      pinchStartRef.current = null;
    }

    // 双指捏合松开其中一指时，平滑过渡为剩余单指继续拖拽平移
    if (!canceled && wasPinching && pointersRef.current.size === 1) {
      const remaining = Array.from(pointersRef.current.values())[0];
      dragOriginRef.current = {
        startX: remaining.x,
        startY: remaining.y,
        panX: pan.x,
        panY: pan.y,
        startTime: Date.now(),
        moved: false,
      };
      setIsDragging(true);
      return;
    }

    const origin = dragOriginRef.current;
    dragOriginRef.current = null;
    setIsDragging(false);

    if (canceled) {
      suppressBackdropCloseRef.current = false;
      setSwipeDrag({ dx: 0, dy: 0 });
      return;
    }

    if (!origin) return;
    if (origin.moved) {
      suppressBackdropCloseRef.current = true;
    }

    if (scale <= 1.02 && origin.moved) {
      const totalDx = event.clientX - origin.startX;
      const totalDy = event.clientY - origin.startY;
      const outcome = computeLightboxSwipeResult({
        totalDx,
        totalDy,
        durationMs: Date.now() - origin.startTime,
        currentIndex: index,
        total: items.length,
      });
      setSwipeDrag({ dx: 0, dy: 0 });
      if (outcome.action === 'close') {
        onClose();
        return;
      }
      if (outcome.action === 'prev' || outcome.action === 'next') {
        setIndex(outcome.nextIndex);
        resetTransform();
      }
    } else {
      setSwipeDrag({ dx: 0, dy: 0 });
    }
  };

  const handleDoubleClick = (): void => {
    if (scale > 1.05) {
      resetTransform();
    } else {
      adjustScale(2.25);
    }
  };

  const tx = scale > 1.02 ? pan.x : swipeDrag.dx;
  const ty = scale > 1.02 ? pan.y : swipeDrag.dy;

  return (
    <div
      className="flux-lightbox m-no-swipe"
      data-gesture-ignore="pan-x"
      data-testid="media-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={currentItem.name}
    >
      <div className="flux-lightbox__topbar m-no-swipe">
        <div className="flux-lightbox__meta">
          <span className="flux-lightbox__title" title={currentItem.path || currentItem.name}>
            {currentItem.name}
          </span>
          {items.length > 1 ? (
            <span className="flux-lightbox__counter" data-testid="lightbox-counter">
              {index + 1} / {items.length}
            </span>
          ) : null}
        </div>
        <div className="flux-lightbox__actions">
          {onDownload ? (
            <button
              type="button"
              className="flux-lightbox__icon-btn"
              data-testid="lightbox-download"
              aria-label={t('conversation.lightboxDownload')}
              title={t('conversation.lightboxDownload')}
              onClick={() => onDownload(currentItem)}
            >
              <Download size={16} aria-hidden="true" />
            </button>
          ) : null}
          <button
            type="button"
            className="flux-lightbox__icon-btn"
            data-testid="lightbox-close"
            aria-label={t('conversation.lightboxClose')}
            title={t('conversation.lightboxClose')}
            onClick={onClose}
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>
      </div>

      <div
        ref={stageRef}
        className="flux-lightbox__stage m-no-swipe"
        data-zoomed={scale > 1.02 ? 'true' : 'false'}
        data-dragging={isDragging ? 'true' : 'false'}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={(e) => finishPointer(e, false)}
        onPointerCancel={(e) => finishPointer(e, true)}
        onDoubleClick={handleDoubleClick}
        onClick={(event) => {
          if (suppressBackdropCloseRef.current) {
            suppressBackdropCloseRef.current = false;
            return;
          }
          if (event.target === event.currentTarget) {
            onClose();
          }
        }}
      >
        {items.length > 1 && index > 0 ? (
          <button
            type="button"
            className="flux-lightbox__nav flux-lightbox__nav--prev m-no-swipe"
            data-testid="lightbox-prev"
            aria-label={t('conversation.lightboxPrev')}
            onClick={(event) => {
              event.stopPropagation();
              stepIndex(-1);
            }}
          >
            <ChevronLeft size={20} aria-hidden="true" />
          </button>
        ) : null}

        {displaySrc ? (
          <img
            src={displaySrc}
            alt={currentItem.alt || currentItem.name}
            className="flux-lightbox__image"
            draggable={false}
            style={{
              transform: `translate3d(${Math.round(tx)}px, ${Math.round(ty)}px, 0) scale(${scale})`,
            }}
          />
        ) : isLoadFailed ? (
          <div className="flux-lightbox__error" data-testid="lightbox-error">
            <span>{t('conversation.deliverableMediaFailed')}</span>
            {resolveMediaUrl ? (
              <button
                type="button"
                className="conv-deliverable-retry-btn"
                data-testid="lightbox-retry"
                onClick={(event) => {
                  event.stopPropagation();
                  setFailedIds((prev) => {
                    const next = { ...prev };
                    delete next[currentItem.id];
                    return next;
                  });
                  setRetryToken((n) => n + 1);
                }}
              >
                <RotateCcw size={13} aria-hidden="true" />
                <span>{t('conversation.deliverableRetry')}</span>
              </button>
            ) : null}
          </div>
        ) : (
          <div className="flux-lightbox__loading">{t('conversation.deliverableLoadingMedia')}</div>
        )}

        {items.length > 1 && index < items.length - 1 ? (
          <button
            type="button"
            className="flux-lightbox__nav flux-lightbox__nav--next m-no-swipe"
            data-testid="lightbox-next"
            aria-label={t('conversation.lightboxNext')}
            onClick={(event) => {
              event.stopPropagation();
              stepIndex(1);
            }}
          >
            <ChevronRight size={20} aria-hidden="true" />
          </button>
        ) : null}
      </div>

      <div className="flux-lightbox__toolbar m-no-swipe" data-gesture-ignore="pan-x">
        <button
          type="button"
          className="flux-lightbox__tool-btn"
          data-testid="lightbox-zoom-out"
          aria-label={t('conversation.lightboxZoomOut')}
          title={t('conversation.lightboxZoomOut')}
          disabled={scale <= LIGHTBOX_MIN_SCALE}
          onClick={() => adjustScale(scale - LIGHTBOX_SCALE_STEP)}
        >
          <Minus size={15} aria-hidden="true" />
        </button>
        <span className="flux-lightbox__zoom-readout" data-testid="lightbox-zoom-label">
          {zoomPercent}
        </span>
        <button
          type="button"
          className="flux-lightbox__tool-btn"
          data-testid="lightbox-zoom-in"
          aria-label={t('conversation.lightboxZoomIn')}
          title={t('conversation.lightboxZoomIn')}
          disabled={scale >= LIGHTBOX_MAX_SCALE}
          onClick={() => adjustScale(scale + LIGHTBOX_SCALE_STEP)}
        >
          <Plus size={15} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="flux-lightbox__tool-btn"
          data-testid="lightbox-zoom-reset"
          aria-label={t('conversation.lightboxZoomReset')}
          title={t('conversation.lightboxZoomReset')}
          onClick={resetTransform}
        >
          <RotateCcw size={14} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
