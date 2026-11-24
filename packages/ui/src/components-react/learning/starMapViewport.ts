/**
 * 认知星图全量画布视口数学工具（缩放、居中适应、光标锚定缩放、焦点居中）。
 *
 * 【设计意图 (Why)】
 *   将放大、缩小、重置适应视口与聚焦某颗技能星点的仿射变换公式抽离为纯函数，
 *   保持零 DOM / React 依赖，确保边界夹紧（zoom min/max）、鼠标/双指锚定缩放不漂移，
 *   且脱离浏览器也可通过确定性单测完整验证。
 *
 * 【防范的历史坑 (Pitfall)】
 *   1. 画布宽高为 0 时直接除零会产生 `NaN`/`Infinity` 破坏 SVG `transform`；
 *   2. 缩放比未围绕指针坐标补偿偏移时，滚动鼠标滚轮会把目标星点甩出视野之外。
 */

export interface StarMapTransform {
  x: number;
  y: number;
  scale: number;
}

export const MIN_STAR_MAP_ZOOM = 0.35;
export const MAX_STAR_MAP_ZOOM = 2.6;
export const STAR_MAP_ZOOM_STEP = 1.25;

function round2(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Number(value.toFixed(2));
}

/** 将缩放倍率安全夹紧在 `[MIN_STAR_MAP_ZOOM, MAX_STAR_MAP_ZOOM]` 之间。 */
export function clampStarMapZoom(scale: number): number {
  if (!Number.isFinite(scale) || scale <= 0) return 1;
  return Math.max(MIN_STAR_MAP_ZOOM, Math.min(MAX_STAR_MAP_ZOOM, Number(scale.toFixed(4))));
}

/** 计算使整张完整星图居中且不裁切的最佳初始缩放与平移量。 */
export function computeFitTransform(
  worldWidth: number,
  worldHeight: number,
  viewportWidth: number,
  viewportHeight: number,
  padding = 24,
): StarMapTransform {
  const safeWorldW = Number.isFinite(worldWidth) && worldWidth > 0 ? worldWidth : 640;
  const safeWorldH = Number.isFinite(worldHeight) && worldHeight > 0 ? worldHeight : 440;
  const safeViewW = Number.isFinite(viewportWidth) && viewportWidth > 0 ? viewportWidth : safeWorldW;
  const safeViewH = Number.isFinite(viewportHeight) && viewportHeight > 0 ? viewportHeight : safeWorldH;
  const safePad = Number.isFinite(padding) && padding >= 0 ? Math.min(padding, Math.min(safeViewW, safeViewH) * 0.25) : 0;

  const availW = Math.max(1, safeViewW - safePad * 2);
  const availH = Math.max(1, safeViewH - safePad * 2);
  const rawScale = Math.min(availW / safeWorldW, availH / safeWorldH, 1.15);
  const scale = clampStarMapZoom(rawScale);

  const x = round2((safeViewW - safeWorldW * scale) / 2);
  const y = round2((safeViewH - safeWorldH * scale) / 2);
  return { x, y, scale };
}

/** 围绕视口锚点 `(anchorX, anchorY)` 平滑缩放到 `nextScale`，保证锚点下方的世界坐标静止不动。 */
export function zoomStarMapAround(
  current: StarMapTransform,
  nextScale: number,
  anchorX: number,
  anchorY: number,
): StarMapTransform {
  const curScale = clampStarMapZoom(current.scale);
  const clampedNext = clampStarMapZoom(nextScale);
  const safeAnchorX = Number.isFinite(anchorX) ? anchorX : 0;
  const safeAnchorY = Number.isFinite(anchorY) ? anchorY : 0;

  const worldX = (safeAnchorX - (Number.isFinite(current.x) ? current.x : 0)) / curScale;
  const worldY = (safeAnchorY - (Number.isFinite(current.y) ? current.y : 0)) / curScale;

  return {
    x: round2(safeAnchorX - worldX * clampedNext),
    y: round2(safeAnchorY - worldY * clampedNext),
    scale: clampedNext,
  };
}

/** 将指定世界坐标点 `(nodeX, nodeY)` 平移至视口中央并按需调整倍率。 */
export function focusStarMapNode(
  nodeX: number,
  nodeY: number,
  viewportWidth: number,
  viewportHeight: number,
  targetScale = 1,
): StarMapTransform {
  const scale = clampStarMapZoom(targetScale);
  const safeViewW = Number.isFinite(viewportWidth) && viewportWidth > 0 ? viewportWidth : 640;
  const safeViewH = Number.isFinite(viewportHeight) && viewportHeight > 0 ? viewportHeight : 440;
  const safeNodeX = Number.isFinite(nodeX) ? nodeX : 0;
  const safeNodeY = Number.isFinite(nodeY) ? nodeY : 0;

  return {
    x: round2(safeViewW / 2 - safeNodeX * scale),
    y: round2(safeViewH / 2 - safeNodeY * scale),
    scale,
  };
}
