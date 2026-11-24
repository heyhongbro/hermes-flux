/**
 * 记忆图谱视口仿射变换与边界数学工具单元测试
 * (packages/ui/__tests__/star-map-viewport.test.mjs)
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_STAR_MAP_ZOOM,
  MIN_STAR_MAP_ZOOM,
  STAR_MAP_ZOOM_STEP,
  clampStarMapZoom,
  computeFitTransform,
  focusStarMapNode,
  zoomStarMapAround,
} from '../dist/components-react/learning/starMapViewport.js';

test('clampStarMapZoom 边界夹紧、非法输入回落与四位精度截断', () => {
  assert.equal(MIN_STAR_MAP_ZOOM, 0.35);
  assert.equal(MAX_STAR_MAP_ZOOM, 2.6);
  assert.ok(STAR_MAP_ZOOM_STEP > 1);

  assert.equal(clampStarMapZoom(Number.NaN), 1);
  assert.equal(clampStarMapZoom(Number.POSITIVE_INFINITY), 1);
  assert.equal(clampStarMapZoom(0), 1);
  assert.equal(clampStarMapZoom(-2), 1);
  assert.equal(clampStarMapZoom(0.05), MIN_STAR_MAP_ZOOM);
  assert.equal(clampStarMapZoom(MIN_STAR_MAP_ZOOM), MIN_STAR_MAP_ZOOM);
  assert.equal(clampStarMapZoom(9), MAX_STAR_MAP_ZOOM);
  assert.equal(clampStarMapZoom(1.23456), 1.2346);
});

test('computeFitTransform 全景居中适应、极端尺寸回落与 padding 限制', () => {
  const normal = computeFitTransform(800, 600, 448, 348, 24);
  // availW=400, availH=300 => rawScale = 0.5
  assert.equal(normal.scale, 0.5);
  assert.equal(normal.x, 24);
  assert.equal(normal.y, 24);

  // 宽主导裁切与高主导裁切：单独验证 availW/safeWorldW 与 availH/safeWorldH 及 padding*2
  const widthConstrained = computeFitTransform(1000, 200, 548, 500, 24);
  assert.equal(widthConstrained.scale, 0.5);
  assert.equal(widthConstrained.x, 24);

  const heightConstrained = computeFitTransform(200, 1000, 500, 548, 24);
  assert.equal(heightConstrained.scale, 0.5);
  assert.equal(heightConstrained.y, 24);

  // 小图不超过 1.15 倍上限
  const capped = computeFitTransform(100, 100, 800, 600);
  assert.equal(capped.scale, 1.15);
  assert.equal(capped.x, 342.5);
  assert.equal(capped.y, 242.5);

  // 逐一验证 worldWidth/worldHeight/viewportWidth 的 NaN、Infinity、0、负数回落（断言完整 x/y/scale）
  assert.deepEqual(computeFitTransform(0, 880, 1280, 880, 0), { x: 320, y: 0, scale: 1 });
  assert.deepEqual(computeFitTransform(-10, 880, 1280, 880, 0), { x: 320, y: 0, scale: 1 });
  assert.deepEqual(computeFitTransform(Number.NaN, 880, 1280, 880, 0), { x: 320, y: 0, scale: 1 });
  assert.deepEqual(computeFitTransform(Number.POSITIVE_INFINITY, 880, 1280, 880, 0), { x: 320, y: 0, scale: 1 });
  assert.deepEqual(computeFitTransform(1280, 0, 1280, 880, 0), { x: 0, y: 220, scale: 1 });
  assert.deepEqual(computeFitTransform(1280, -10, 1280, 880, 0), { x: 0, y: 220, scale: 1 });
  assert.deepEqual(computeFitTransform(1280, Number.NaN, 1280, 880, 0), { x: 0, y: 220, scale: 1 });
  assert.deepEqual(computeFitTransform(1280, Number.POSITIVE_INFINITY, 1280, 880, 0), { x: 0, y: 220, scale: 1 });
  assert.equal(computeFitTransform(1000, 200, 0, 500, 24).scale, 0.952);
  assert.equal(computeFitTransform(1000, 200, -50, 500, 24).scale, 0.952);
  assert.equal(computeFitTransform(1000, 200, Number.NaN, 500, 24).scale, 0.952);

  // 非法宽高与负/超大 padding 回落
  const invalidDims = computeFitTransform(0, -10, Number.NaN, 0, -5);
  assert.deepEqual(invalidDims, { x: 0, y: 0, scale: 1 });

  // 非对称视口下超大 padding 必须截断为短边（Math.min）的 25%
  const clampedPad = computeFitTransform(400, 200, 800, 200, 500);
  assert.equal(clampedPad.scale, 0.5);
  assert.equal(clampedPad.x, 300);
  assert.equal(clampedPad.y, 50);
});

test('zoomStarMapAround 保持指针下世界坐标严格不动并防呆非法数值', () => {
  const cur = { x: 40, y: -20, scale: 1.5 };
  const anchorX = 190;
  const anchorY = 130;
  const worldXBefore = (anchorX - cur.x) / cur.scale;
  const worldYBefore = (anchorY - cur.y) / cur.scale;

  const next = zoomStarMapAround(cur, 2, anchorX, anchorY);
  assert.equal(next.scale, 2);
  assert.equal(next.x, -10);
  assert.equal(next.y, -70);
  const worldXAfter = (anchorX - next.x) / next.scale;
  const worldYAfter = (anchorY - next.y) / next.scale;
  assert.equal(worldXAfter, worldXBefore);
  assert.equal(worldYAfter, worldYBefore);

  // 非法输入：NaN anchor 与 NaN current 坐标
  const bad = zoomStarMapAround(
    { x: Number.NaN, y: Number.POSITIVE_INFINITY, scale: -1 },
    Number.NaN,
    Number.NaN,
    Number.NEGATIVE_INFINITY,
  );
  assert.deepEqual(bad, { x: 0, y: 0, scale: 1 });
});

test('focusStarMapNode 平移居中、合法与非法参数回落及 round2 溢出归零', () => {
  const centered = focusStarMapNode(120, 80, 400, 300, 1.5);
  assert.deepEqual(centered, { x: 20, y: 30, scale: 1.5 });

  const defaultScale = focusStarMapNode(100, 50, 0, -1);
  assert.deepEqual(defaultScale, { x: 220, y: 170, scale: 1 });

  const zeroHeight = focusStarMapNode(100, 50, 400, 0);
  assert.deepEqual(zeroHeight, { x: 100, y: 170, scale: 1 });

  const nanNode = focusStarMapNode(Number.NaN, Number.POSITIVE_INFINITY, Number.NaN, Number.NaN, 10);
  assert.deepEqual(nanNode, { x: 320, y: 220, scale: MAX_STAR_MAP_ZOOM });

  // 触发 round2 内 Number.isFinite(value) === false 分支
  const overflow = focusStarMapNode(Number.MAX_VALUE, -Number.MAX_VALUE, 400, 300, 2);
  assert.deepEqual(overflow, { x: 0, y: 0, scale: 2 });
});
