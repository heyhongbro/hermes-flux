/**
 * 完整可缩放认知星图 SVG 画布与焦点预览条 (CognitiveStarMapCanvas)
 *
 * 【设计意图 (Why)】
 *   一次性渲染当前 Bot 过滤后的全部星图节点与连线（取消分页截断），
 *   通过指针拖拽平移、鼠标滚轮与触控双指捏合缩放、以及右上角浮动控制条实现自由漫游；
 *   明确区分 `skill-link`（技能关联）、`mention`（记忆引用）连线与每个技能的调用次数徽标。
 *
 * 【防范的历史坑 (Pitfall)】
 *   1. 画布必须声明 `.m-no-swipe`、`data-gesture-ignore="pan-x"` 与 `touch-action: none`，
 *      防止移动端拖拽星图或双指捏合时误触发三屏水平滑动切页；
 *   2. Node 无头单测（SSR / createReactHookDriver）环境无 `ResizeObserver`，必须提供默认视口回退宽高。
 */

import * as React from 'react';
import { ChevronRight, LocateFixed, Minus, Plus, RotateCcw } from 'lucide-react';
import type {
  ConstellationNode,
  FullConstellationLayout,
} from '@hermes-flux/core';
import { t } from '../../i18n/index.js';
import {
  MAX_STAR_MAP_ZOOM,
  MIN_STAR_MAP_ZOOM,
  STAR_MAP_ZOOM_STEP,
  computeFitTransform,
  focusStarMapNode,
  zoomStarMapAround,
  type StarMapTransform,
} from './starMapViewport.js';

export interface StarMapFocusRequest {
  nodeId: string;
  seq: number;
}

export interface CognitiveStarMapCanvasProps {
  layout: FullConstellationLayout;
  variant: 'desktop' | 'mobile';
  testIdPrefix: string;
  selectedId?: string;
  fitTriggerKey: string;
  focusRequest?: StarMapFocusRequest | null;
  onSelectNode: (nodeId: string) => void;
  onOpenNodeDetail: (nodeId: string) => void;
}

function measurePillWidth(text: string): number {
  let units = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    units += code > 255 ? 1.85 : 1;
  }
  return Math.max(58, Math.min(148, Math.round(units * 6.8 + 16)));
}

function clipNodeLabel(label: string): string {
  return label.length > 18 ? `${label.slice(0, 17)}…` : label;
}

export function CognitiveStarMapCanvas({
  layout,
  variant,
  testIdPrefix,
  fitTriggerKey,
  focusRequest,
  onSelectNode,
  onOpenNodeDetail,
}: CognitiveStarMapCanvasProps): React.ReactElement {
  const defaultWidth = variant === 'desktop' ? 840 : 360;
  const defaultHeight = variant === 'desktop' ? 440 : 380;

  const stageRef = React.useRef<HTMLDivElement | null>(null);
  const [viewportSize, setViewportSize] = React.useState<{ width: number; height: number }>({
    width: defaultWidth,
    height: defaultHeight,
  });

  const [transform, setTransform] = React.useState<StarMapTransform>(() =>
    computeFitTransform(layout.width, layout.height, defaultWidth, defaultHeight),
  );
  const [isDragging, setIsDragging] = React.useState(false);

  const pointersRef = React.useRef<Map<number, { x: number; y: number }>>(new Map());
  const panStateRef = React.useRef<{
    active: boolean;
    pointerId: number;
    startClientX: number;
    startClientY: number;
    startTx: number;
    startTy: number;
    moved: boolean;
  }>({
    active: false,
    pointerId: -1,
    startClientX: 0,
    startClientY: 0,
    startTx: 0,
    startTy: 0,
    moved: false,
  });
  const pinchStateRef = React.useRef<{
    active: boolean;
    initialDist: number;
    initialScale: number;
  }>({
    active: false,
    initialDist: 0,
    initialScale: 1,
  });
  const suppressClickRef = React.useRef(false);

  // 监测真实容器尺寸（浏览器中生效，Node 单测安全跳过）
  React.useEffect(() => {
    const el = stageRef.current;
    if (!el || typeof el.getBoundingClientRect !== 'function') return;
    const syncSize = (): void => {
      const rect = el.getBoundingClientRect();
      if (rect.width > 40 && rect.height > 40) {
        setViewportSize((prev) =>
          Math.abs(prev.width - rect.width) > 2 || Math.abs(prev.height - rect.height) > 2
            ? { width: Math.round(rect.width), height: Math.round(rect.height) }
            : prev,
        );
      }
    };
    syncSize();
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(syncSize);
      observer.observe(el);
      return () => observer.disconnect();
    }
    return undefined;
  }, []);

  // Bot / 筛选条件 / 图谱版本切换时自动全景适配
  React.useEffect(() => {
    setTransform(
      computeFitTransform(layout.width, layout.height, viewportSize.width, viewportSize.height),
    );
  }, [fitTriggerKey, layout.width, layout.height, viewportSize.width, viewportSize.height]);

  // 外部列表触发聚焦某颗技能星点时平滑居中
  React.useEffect(() => {
    if (!focusRequest) return;
    const node = layout.nodes.find((n) => n.id === focusRequest.nodeId);
    if (!node) return;
    setTransform((prev) =>
      focusStarMapNode(
        node.x,
        node.y,
        viewportSize.width,
        viewportSize.height,
        Math.max(1, prev.scale),
      ),
    );
  }, [focusRequest, layout.nodes, viewportSize.width, viewportSize.height]);

  const posMap = React.useMemo(() => {
    const map = new Map<string, (typeof layout.nodes)[number]>();
    for (const node of layout.nodes) {
      map.set(node.id, node);
    }
    return map;
  }, [layout.nodes]);

  const activeNode: ConstellationNode | null = layout.activeNode;
  const activePosNode = activeNode ? posMap.get(activeNode.id) ?? null : null;

  const handleZoomBy = (factor: number): void => {
    setTransform((prev) =>
      zoomStarMapAround(
        prev,
        prev.scale * factor,
        viewportSize.width / 2,
        viewportSize.height / 2,
      ),
    );
  };

  const handleFitReset = (): void => {
    setTransform(
      computeFitTransform(layout.width, layout.height, viewportSize.width, viewportSize.height),
    );
  };

  const handleWheel = (event: React.WheelEvent<HTMLDivElement>): void => {
    if (!Number.isFinite(event.deltaY) || event.deltaY === 0) return;
    event.preventDefault();
    const rect = stageRef.current?.getBoundingClientRect?.();
    const anchorX = rect ? event.clientX - rect.left : viewportSize.width / 2;
    const anchorY = rect ? event.clientY - rect.top : viewportSize.height / 2;
    const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
    setTransform((prev) => zoomStarMapAround(prev, prev.scale * factor, anchorX, anchorY));
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest?.('[data-constellation-controls="true"]')) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;

    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointersRef.current.size === 2) {
      const pts = Array.from(pointersRef.current.values());
      const dist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
      pinchStateRef.current = {
        active: dist > 10,
        initialDist: Math.max(10, dist),
        initialScale: transform.scale,
      };
      panStateRef.current.active = false;
      setIsDragging(false);
      return;
    }

    if (pointersRef.current.size === 1) {
      panStateRef.current = {
        active: true,
        pointerId: event.pointerId,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startTx: transform.x,
        startTy: transform.y,
        moved: false,
      };
    }
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (!pointersRef.current.has(event.pointerId)) return;
    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (pointersRef.current.size === 2 && pinchStateRef.current.active) {
      const pts = Array.from(pointersRef.current.values());
      const dist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
      const nextScale = pinchStateRef.current.initialScale * (dist / pinchStateRef.current.initialDist);
      const rect = stageRef.current?.getBoundingClientRect?.();
      const midX = (pts[0].x + pts[1].x) / 2 - (rect?.left ?? 0);
      const midY = (pts[0].y + pts[1].y) / 2 - (rect?.top ?? 0);
      setTransform((prev) => zoomStarMapAround(prev, nextScale, midX, midY));
      suppressClickRef.current = true;
      return;
    }

    const pan = panStateRef.current;
    if (!pan.active || pan.pointerId !== event.pointerId) return;
    const dx = event.clientX - pan.startClientX;
    const dy = event.clientY - pan.startClientY;
    if (!pan.moved && Math.hypot(dx, dy) >= 5) {
      pan.moved = true;
      setIsDragging(true);
      try {
        event.currentTarget?.setPointerCapture?.(event.pointerId);
      // gate-degrade: 无真实 DOM capture 时按普通拖拽降级
      } catch {
      }
    }
    if (!pan.moved) return;
    setTransform((prev) => ({
      ...prev,
      x: Number((pan.startTx + dx).toFixed(2)),
      y: Number((pan.startTy + dy).toFixed(2)),
    }));
  };

  const handlePointerEnd = (event: React.PointerEvent<HTMLDivElement>): void => {
    pointersRef.current.delete(event.pointerId);
    if (pointersRef.current.size < 2) {
      pinchStateRef.current.active = false;
    }
    const pan = panStateRef.current;
    if (pan.active && pan.pointerId === event.pointerId) {
      const moved = pan.moved;
      pan.active = false;
      setIsDragging(false);
      try {
        event.currentTarget?.releasePointerCapture?.(event.pointerId);
      // gate-degrade: 未曾捕获 pointerId 时安全忽略
      } catch {
      }
      if (moved) {
        suppressClickRef.current = true;
        setTimeout(() => {
          suppressClickRef.current = false;
        }, 0);
      }
    }
  };

  if (!activeNode) {
    return (
      <div className="constellation-card constellation-card--state">
        <p className="constellation-state__text">{t('mobile.memory.emptyFilter')}</p>
      </div>
    );
  }

  const connectedSet = new Set(layout.connectedIds);
  const zoomPct = Math.round(transform.scale * 100);
  const activeSkillLinkCount = activePosNode?.skillLinkCount ?? 0;

  return (
    <>
      <div
        ref={stageRef}
        className="constellation-stage m-no-swipe"
        data-gesture-ignore="pan-x"
        data-dragging={isDragging ? 'true' : 'false'}
        data-testid={`${testIdPrefix}-stage`}
        onWheel={handleWheel}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerEnd}
        onPointerCancel={handlePointerEnd}
      >
        <div className="constellation-zoom-bar" data-constellation-controls="true">
          <button
            type="button"
            className="constellation-zoom-btn"
            data-testid={`${testIdPrefix}-zoom-out`}
            aria-label={t('mobile.memory.zoomOutAria')}
            disabled={transform.scale <= MIN_STAR_MAP_ZOOM + 0.01}
            onClick={() => handleZoomBy(1 / STAR_MAP_ZOOM_STEP)}
          >
            <Minus size={14} aria-hidden="true" />
          </button>
          <span className="constellation-zoom-readout" data-testid={`${testIdPrefix}-zoom-label`}>
            {zoomPct}%
          </span>
          <button
            type="button"
            className="constellation-zoom-btn"
            data-testid={`${testIdPrefix}-zoom-in`}
            aria-label={t('mobile.memory.zoomInAria')}
            disabled={transform.scale >= MAX_STAR_MAP_ZOOM - 0.01}
            onClick={() => handleZoomBy(STAR_MAP_ZOOM_STEP)}
          >
            <Plus size={14} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="constellation-zoom-btn"
            data-testid={`${testIdPrefix}-zoom-reset`}
            aria-label={t('mobile.memory.zoomResetAria')}
            onClick={handleFitReset}
          >
            <RotateCcw size={13} aria-hidden="true" />
          </button>
        </div>

        <svg
          className="constellation-svg"
          viewBox={`0 0 ${viewportSize.width} ${viewportSize.height}`}
          role="img"
          aria-label={t('mobile.memory.constellationTitle')}
        >
          <g transform={`translate(${transform.x} ${transform.y}) scale(${transform.scale})`}>
            {layout.edges.map((edge) => {
              const src = posMap.get(edge.source);
              const dst = posMap.get(edge.target);
              if (!src || !dst) return null;
              const isIncident = src.isSelected || dst.isSelected;
              const isDim = !isIncident;
              return (
                <line
                  key={`${edge.source}::${edge.target}`}
                  x1={src.x}
                  y1={src.y}
                  x2={dst.x}
                  y2={dst.y}
                  className="constellation-edge"
                  data-kind={edge.kind}
                  data-active={isIncident ? 'true' : 'false'}
                  data-dim={isDim ? 'true' : 'false'}
                />
              );
            })}

            {layout.nodes.map((node) => {
              const shortText = clipNodeLabel(node.label);
              const pillW = measurePillWidth(shortText);
              const pillY = node.radius + 8;
              const glyphText = node.kind === 'skill' ? '✦' : '◆';
              const isRelatedOrSelected = node.isSelected || connectedSet.has(node.id);
              const isDim = !isRelatedOrSelected && connectedSet.size > 0;
              const showUsesBadge = node.kind === 'skill' || node.uses > 0;
              const usesBadgeText = `x${node.uses}`;
              const usesBadgeW = Math.max(24, usesBadgeText.length * 7 + 10);

              return (
                <g
                  key={node.id}
                  role="button"
                  tabIndex={0}
                  className="constellation-node"
                  data-testid={`${testIdPrefix}-node-${node.id}`}
                  data-kind={node.kind}
                  data-selected={node.isSelected ? 'true' : 'false'}
                  data-neighbor={node.isNeighbor ? 'true' : 'false'}
                  data-dim={isDim ? 'true' : 'false'}
                  transform={`translate(${node.x} ${node.y})`}
                  aria-label={`${node.fullLabel} (${t('mobile.memory.usesCount', { count: node.uses })})`}
                  onClick={() => {
                    if (suppressClickRef.current) return;
                    onSelectNode(node.id);
                  }}
                  onDoubleClick={() => onOpenNodeDetail(node.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onSelectNode(node.id);
                    }
                  }}
                >
                  {node.isSelected ? (
                    <circle r={node.radius + 5} className="constellation-node__ring" />
                  ) : null}
                  <circle r={node.radius} className="constellation-node__circle" />
                  <text x={0} y={0} className="constellation-node__glyph">
                    {glyphText}
                  </text>

                  {showUsesBadge ? (
                    <g transform={`translate(${node.radius * 0.72} ${-node.radius * 0.72})`}>
                      <rect
                        x={-usesBadgeW / 2}
                        y={-9}
                        width={usesBadgeW}
                        height={18}
                        rx={9}
                        className="constellation-node__uses-bg"
                      />
                      <text x={0} y={0} className="constellation-node__uses-text">
                        {usesBadgeText}
                      </text>
                    </g>
                  ) : null}

                  <rect
                    x={-pillW / 2}
                    y={pillY}
                    width={pillW}
                    height={20}
                    rx={6}
                    className="constellation-node__label-bg"
                  />
                  <text x={0} y={pillY + 10} className="constellation-node__label-text">
                    {shortText}
                  </text>
                </g>
              );
            })}
          </g>
        </svg>

        <div className="constellation-legend" aria-hidden="true">
          <span className="constellation-legend__item">
            <span className="constellation-legend__dot" data-kind="skill" />
            <span>{t('mobile.memory.legendSkill')}</span>
          </span>
          <span className="constellation-legend__item">
            <span className="constellation-legend__dot" data-kind="memory" />
            <span>{t('mobile.memory.legendMemory')}</span>
          </span>
          <span className="constellation-legend__item">
            <span className="constellation-legend__line" data-kind="skill-link" />
            <span>{t('mobile.memory.legendSkillLink')}</span>
          </span>
          <span className="constellation-legend__item">
            <span className="constellation-legend__line" data-kind="mention" />
            <span>{t('mobile.memory.legendMention')}</span>
          </span>
        </div>
      </div>

      <button
        type="button"
        className="constellation-preview-bar"
        data-testid={`${testIdPrefix}-open-detail`}
        aria-label={t('mobile.memory.openDetailAria')}
        onClick={() => onOpenNodeDetail(activeNode.id)}
      >
        <span className="constellation-preview-bar__main">
          <span className="constellation-preview-bar__title">{activeNode.fullLabel}</span>
          <span className="constellation-preview-bar__meta">
            <span>
              {activeNode.kind === 'skill'
                ? t('mobile.memory.kindSkill')
                : t('mobile.memory.kindMemory')}
            </span>
            <span>·</span>
            <span>{t('mobile.memory.usesCount', { count: activeNode.uses })}</span>
            {activeNode.kind === 'skill' ? (
              <>
                <span>·</span>
                <span>{t('mobile.memory.skillLinksCount', { count: activeSkillLinkCount })}</span>
              </>
            ) : null}
            {activeNode.date ? (
              <>
                <span>·</span>
                <span>{activeNode.date}</span>
              </>
            ) : null}
          </span>
        </span>
        <span className="constellation-preview-bar__cta">
          <LocateFixed size={13} aria-hidden="true" />
          <span>{t('mobile.memory.openDetailBtn')}</span>
          <ChevronRight size={15} aria-hidden="true" />
        </span>
      </button>
    </>
  );
}
