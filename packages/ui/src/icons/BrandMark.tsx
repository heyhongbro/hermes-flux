/**
 * Hermes Flux 品牌折纸雨燕组件与多态矢量渲染器 (BrandSwiftMark)
 *
 * 【设计意图 (Why)】
 *   将包豪斯原彩折纸雨燕作为跨端共享的单一矢量组件与 HTML 渲染原语：
 *   1. `variant="icon"` (Variant A)：纯净放大版雨燕（无文字），用于关于页等旁侧自带标题的场景；
 *   2. `variant="badge"` (Variant B)：雨燕 + 深靛蓝 `FLUX` 字标，用于新手引导、空会话画布等非图标场景；
 *   3. `variant="mark"`：无外框透明悬浮燕，配合 `motion="fly"` 在冷启动、连接与加载态中轻盈滑翔，
 *      自动适配深浅双极性皮肤；
 *   4. 所有矢量分面按语义部位 (`data-part`) 编组，既支持翅羽微振动效，也便于后续扩展新形态。
 *
 * 【防范的历史坑 (Pitfall)】
 *   1. 同页渲染多个实例时 `<linearGradient>` 与 `<filter>` ID 若写死同名会互相覆盖甚至引用失效，
 *      React 分支统一用 `React.useId()` 清洗生成隔离前缀，HTML 模板分支强制调用方传入唯一 `idPrefix`；
 *   2. UI 组件若位于 `components-react/` 会被换肤门禁拦下品牌固定色相；本模块收口在 `packages/ui/src/icons/`，
 *      与语言/模型厂商彩色图标遵循完全一致的分层边界。
 *
 * 【约束与规则 (Rules)】
 *   1. 几何与色值严禁在此硬编码或覆写，必须唯一读取自 `./brand/brandSpec.js`；
 *   2. 严禁在普通会话列表行内渲染本组件（遵守 `ActivityIndicator.tsx` 列表行轻量化规范）；
 *   3. 动效仅允许使用纯 GPU 合成属性（由 `conversation.css` 的 `.flux-brand-swift` 统一控制）。
 */

import * as React from 'react';
import {
  BRAND_SPEC,
  type BrandFacet,
  type BrandFacetPart,
  type BrandLinearGradient,
  type BrandVariantTransform,
} from './brand/brandSpec.js';

export {
  BRAND_SPEC,
  type BrandSpec,
  type BrandFacet,
  type BrandFacetPart,
  type BrandVariantTransform,
} from './brand/brandSpec.js';

export type BrandSwiftVariant = 'icon' | 'badge' | 'mark';
export type BrandSwiftMotion = 'static' | 'glide' | 'fly';

export interface BrandSwiftMarkProps {
  variant?: BrandSwiftVariant;
  motion?: BrandSwiftMotion;
  size?: number;
  className?: string;
  decorative?: boolean;
  label?: string;
  idPrefix?: string;
}

export interface BrandSwiftHtmlOptions {
  variant?: BrandSwiftVariant;
  motion?: BrandSwiftMotion;
  size?: number;
  className?: string;
  decorative?: boolean;
  label?: string;
  idPrefix: string;
}

interface FacetPartGroup {
  part: BrandFacetPart;
  facets: BrandFacet[];
}

function groupFacetsByPart(facets: readonly BrandFacet[]): FacetPartGroup[] {
  const groups: FacetPartGroup[] = [];
  for (const facet of facets) {
    const prev = groups[groups.length - 1];
    if (!prev || prev.part !== facet.part) {
      groups.push({ part: facet.part, facets: [facet] });
    } else {
      prev.facets.push(facet);
    }
  }
  return groups;
}

function formatPoints(points: readonly (readonly [number, number])[]): string {
  return points.map(([x, y]) => `${x},${y}`).join(' ');
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function sanitizeId(raw: string, fallback: string): string {
  const cleaned = raw.replace(/[^a-zA-Z0-9_-]/g, '');
  return cleaned || fallback;
}

function normalizeBrandSize(size: number): number {
  return Number.isFinite(size) && size > 0 ? size : 64;
}

const PART_PIVOT_KEY: Partial<Record<BrandFacetPart, keyof typeof BRAND_SPEC.animationPivots>> = {
  'wing-upper': 'wingUpper',
  'wing-lower': 'wingLower',
  tail: 'tail',
};

function resolvePartPivot(part: BrandFacetPart): readonly [number, number] | null {
  const pivotKey = PART_PIVOT_KEY[part];
  return pivotKey ? BRAND_SPEC.animationPivots[pivotKey] : null;
}

function renderLinearGradientDef(id: string, gradient: BrandLinearGradient): React.ReactElement {
  return (
    <linearGradient
      key={id}
      id={id}
      x1={gradient.x1}
      y1={gradient.y1}
      x2={gradient.x2}
      y2={gradient.y2}
      gradientUnits="userSpaceOnUse"
    >
      {gradient.stops.map((stop) => (
        <stop key={`${id}-${stop.offset}`} offset={`${Math.round(stop.offset * 100)}%`} stopColor={stop.color} />
      ))}
    </linearGradient>
  );
}

function renderLinearGradientHtml(id: string, gradient: BrandLinearGradient): string {
  const stops = gradient.stops
    .map((s) => `<stop offset="${Math.round(s.offset * 100)}%" stop-color="${s.color}" />`)
    .join('');
  return `<linearGradient id="${id}" x1="${gradient.x1}" y1="${gradient.y1}" x2="${gradient.x2}" y2="${gradient.y2}" gradientUnits="userSpaceOnUse">${stops}</linearGradient>`;
}

const FACET_GROUPS = groupFacetsByPart(BRAND_SPEC.facets);

/**
 * 跨端复用品牌折纸雨燕 React 组件。
 */
export function BrandSwiftMark({
  variant = 'mark',
  motion = 'static',
  size = 64,
  className,
  decorative = true,
  label = 'Hermes Flux',
  idPrefix,
}: BrandSwiftMarkProps): React.ReactElement {
  const reactId = React.useId();
  const safeSize = normalizeBrandSize(size);
  const fallbackPrefix = sanitizeId(`hf-${reactId}`, 'hf-swift');
  const prefix = idPrefix !== undefined ? sanitizeId(idPrefix, fallbackPrefix) : fallbackPrefix;
  const vt = BRAND_SPEC.variants[variant];
  const [tx, ty] = vt.translate;
  const wordmarkCx = 500 + Math.floor(BRAND_SPEC.wordmark.badgeLetterSpacing / 2);

  const rootClassName = className ? `flux-brand-swift ${className}` : 'flux-brand-swift';
  const a11yProps = decorative
    ? { 'aria-hidden': true as const }
    : { role: 'img' as const, 'aria-label': label };

  return (
    <span
      className={rootClassName}
      data-brand-variant={variant}
      data-brand-motion={motion}
      style={{ width: `${safeSize}px`, height: `${safeSize}px` }}
      {...a11yProps}
    >
      <span className="flux-brand-swift__rotor">
        <svg
          className="flux-brand-swift__svg"
          viewBox={BRAND_SPEC.viewBox}
          width="100%"
          height="100%"
          aria-hidden="true"
          focusable="false"
        >
          <defs>
            {vt.showCard ? renderLinearGradientDef(`${prefix}-bg`, BRAND_SPEC.background.gradient) : null}
            {BRAND_SPEC.facets.map((facet) =>
              facet.fillType === 'linear' ? renderLinearGradientDef(`${prefix}-${facet.id}`, facet.gradient) : null,
            )}
          </defs>

          {vt.showCard ? (
            <rect
              x={8}
              y={8}
              width={984}
              height={984}
              rx={BRAND_SPEC.squircleRx}
              fill={`url(#${prefix}-bg)`}
              stroke={BRAND_SPEC.shadow.color}
              strokeOpacity={0.1}
              strokeWidth={4}
            />
          ) : null}

          <g transform={`translate(${tx}, ${ty}) scale(${vt.scale})`}>
            {FACET_GROUPS.map((group) => {
              const pivot = resolvePartPivot(group.part);
              const partStyle: React.CSSProperties | undefined = pivot
                ? { transformOrigin: `${pivot[0]}px ${pivot[1]}px` }
                : undefined;
              return (
                <g
                  key={group.part}
                  data-part={group.part}
                  className={`flux-brand-swift__part flux-brand-swift__${group.part}`}
                  style={partStyle}
                >
                  {group.facets.map((facet) =>
                    facet.fillType === 'solid' ? (
                      <polygon
                        key={facet.id}
                        points={formatPoints(facet.points)}
                        fill={facet.color}
                        fillOpacity={facet.opacity}
                      />
                    ) : (
                      <polygon
                        key={facet.id}
                        points={formatPoints(facet.points)}
                        fill={`url(#${prefix}-${facet.id})`}
                      />
                    ),
                  )}
                </g>
              );
            })}
          </g>

          {vt.showWordmark ? (
            <text
              x={wordmarkCx}
              y={BRAND_SPEC.wordmark.badgeY}
              textAnchor="middle"
              fill={BRAND_SPEC.wordmark.color}
              fontFamily="'Segoe UI', -apple-system, BlinkMacSystemFont, 'Inter', Arial, sans-serif"
              fontSize={BRAND_SPEC.wordmark.badgeFontSize}
              fontWeight={800}
              letterSpacing={BRAND_SPEC.wordmark.badgeLetterSpacing}
            >
              {BRAND_SPEC.wordmark.shortText}
            </text>
          ) : null}
        </svg>
      </span>
      {motion === 'fly' ? <span className="flux-brand-swift__shadow" aria-hidden="true" /> : null}
    </span>
  );
}

/**
 * 供静态 HTML 模板（如 MiddlePod）复用的品牌折纸雨燕 HTML 字符串构建器。
 */
export function renderBrandSwiftHtml({
  variant = 'mark',
  motion = 'static',
  size = 64,
  className,
  decorative = true,
  label = 'Hermes Flux',
  idPrefix,
}: BrandSwiftHtmlOptions): string {
  const safeSize = normalizeBrandSize(size);
  const prefix = sanitizeId(idPrefix, 'hf-swift');
  const vt = BRAND_SPEC.variants[variant];
  const [tx, ty] = vt.translate;
  const wordmarkCx = 500 + Math.floor(BRAND_SPEC.wordmark.badgeLetterSpacing / 2);

  const rootClassName = className ? `flux-brand-swift ${escapeAttr(className)}` : 'flux-brand-swift';
  const a11yAttr = decorative ? 'aria-hidden="true"' : `role="img" aria-label="${escapeAttr(label)}"`;

  const bgDef = vt.showCard ? renderLinearGradientHtml(`${prefix}-bg`, BRAND_SPEC.background.gradient) : '';
  const facetDefs = BRAND_SPEC.facets
    .map((f) => (f.fillType === 'linear' ? renderLinearGradientHtml(`${prefix}-${f.id}`, f.gradient) : ''))
    .join('');

  const cardRect = vt.showCard
    ? `<rect x="8" y="8" width="984" height="984" rx="${BRAND_SPEC.squircleRx}" fill="url(#${prefix}-bg)" stroke="${BRAND_SPEC.shadow.color}" stroke-opacity="0.1" stroke-width="4" />`
    : '';

  const partGroupsHtml = FACET_GROUPS.map((group) => {
    const pivot = resolvePartPivot(group.part);
    const styleAttr = pivot ? ` style="transform-origin: ${pivot[0]}px ${pivot[1]}px"` : '';
    const polys = group.facets
      .map((facet) =>
        facet.fillType === 'solid'
          ? `<polygon points="${formatPoints(facet.points)}" fill="${facet.color}" fill-opacity="${facet.opacity}" />`
          : `<polygon points="${formatPoints(facet.points)}" fill="url(#${prefix}-${facet.id})" />`,
      )
      .join('');
    return `<g data-part="${group.part}" class="flux-brand-swift__part flux-brand-swift__${group.part}"${styleAttr}>${polys}</g>`;
  }).join('');

  const wordmarkHtml = vt.showWordmark
    ? `<text x="${wordmarkCx}" y="${BRAND_SPEC.wordmark.badgeY}" text-anchor="middle" fill="${BRAND_SPEC.wordmark.color}" font-family="'Segoe UI', -apple-system, BlinkMacSystemFont, 'Inter', Arial, sans-serif" font-size="${BRAND_SPEC.wordmark.badgeFontSize}" font-weight="800" letter-spacing="${BRAND_SPEC.wordmark.badgeLetterSpacing}">${BRAND_SPEC.wordmark.shortText}</text>`
    : '';

  const shadowEl = motion === 'fly' ? '<span class="flux-brand-swift__shadow" aria-hidden="true"></span>' : '';

  return (
    `<span class="${rootClassName}" data-brand-variant="${variant}" data-brand-motion="${motion}" style="width: ${safeSize}px; height: ${safeSize}px;" ${a11yAttr}>` +
    '<span class="flux-brand-swift__rotor">' +
    `<svg class="flux-brand-swift__svg" viewBox="${BRAND_SPEC.viewBox}" width="100%" height="100%" aria-hidden="true" focusable="false">` +
    '<defs>' +
    bgDef +
    facetDefs +
    '</defs>' +
    cardRect +
    `<g transform="translate(${tx}, ${ty}) scale(${vt.scale})">${partGroupsHtml}</g>` +
    wordmarkHtml +
    '</svg>' +
    '</span>' +
    shadowEl +
    '</span>'
  );
}
