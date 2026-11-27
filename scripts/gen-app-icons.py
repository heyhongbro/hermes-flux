#!/usr/bin/env python3
"""
Hermes Flux 全平台品牌资产确定性生成器 (Deterministic Brand Asset Generator)

设计意图 (Why):
  以 packages/ui/src/icons/brand/brand-spec.json 为唯一几何与色彩真值源，
  一次性确定性产出：
  1. TypeScript 只读镜像 (packages/ui/src/icons/brand/brandSpec.ts)
  2. 三份纯矢量语义 SVG (icon / badge / mark) + Web favicon-32.png
  3. Desktop icon.png (1024x1024 RGBA) 与多尺寸 icon.ico (16~256)
  4. iOS AppIcon-512@2x.png (1024x1024 不透明 RGB) 与 Splash.imageset (2732x2732 不透明 RGB)
  5. Android 15 枚 mipmap 启动图标 + VectorDrawable XML + 11 枚全分辨率 Splash PNG

防范的历史坑 (Pitfall):
  1. iOS AppIcon / Splash 若携带 Alpha 通道会导致 App Store 提交拒绝或黑屏边缘，
     必须显式输出纯净 RGB 三通道；
  2. Android Adaptive Foreground 若在矢量内部自带背景方框，会被系统圆形/圆角裁切出二次框边，
     必须保持透明底且全部顶点严守 66dp 安全内圆（scale 0.72, max R <= 295px < 305.5px）；
  3. 仅依赖外链 SVG 转码器在干净环境易缺失，本脚本用 numpy + Pillow 4x 超采样解析光栅化，
     零外部二进制依赖且像素可重现。

约束与规则 (Rules):
  - 所有几何坐标与色值只能读取自 brand-spec.json，严禁另起第二套硬编码表。
"""

from __future__ import annotations

import json
import math
import os
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

REPO_ROOT = Path(__file__).resolve().parent.parent
SPEC_PATH = REPO_ROOT / "packages/ui/src/icons/brand/brand-spec.json"
BRAND_DIR = REPO_ROOT / "packages/ui/src/icons/brand"
DESKTOP_BUILD_DIR = REPO_ROOT / "packages/desktop/build"
IOS_ASSETS_DIR = REPO_ROOT / "packages/mobile/ios/App/App/Assets.xcassets"
ANDROID_RES_DIR = REPO_ROOT / "packages/mobile/android/app/src/main/res"


def hex_to_rgb(hex_color: str) -> tuple[int, int, int]:
    h = hex_color.lstrip("#")
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    return int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)


def parse_hex_rgba(hex_color: str, opacity: float = 1.0) -> tuple[float, float, float, float]:
    r, g, b = hex_to_rgb(hex_color)
    return float(r), float(g), float(b), float(opacity)


def find_bold_font(px_size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    candidates = [
        r"C:\Windows\Fonts\segoeuib.ttf",
        r"C:\Windows\Fonts\arialbd.ttf",
        r"C:\Windows\Fonts\tahomabd.ttf",
        r"C:\Windows\Fonts\verdanab.ttf",
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
        "/System/Library/Fonts/SFNS.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    ]
    for path in candidates:
        if os.path.exists(path):
            return ImageFont.truetype(path, px_size)
    return ImageFont.load_default()


def render_linear_gradient_array(
    width: int,
    height: int,
    x1: float,
    y1: float,
    x2: float,
    y2: float,
    stops: list[dict[str, Any]],
) -> np.ndarray:
    """Compute vectorized RGB float32 array for a linear gradient across width x height."""
    dx = x2 - x1
    dy = y2 - y1
    denom = dx * dx + dy * dy
    if denom <= 1e-9:
        rgb = np.array(hex_to_rgb(stops[-1]["color"]), dtype=np.float32)
        return np.broadcast_to(rgb, (height, width, 3)).copy()

    xs = (np.arange(width, dtype=np.float32) + 0.5 - x1)[None, :]
    ys = (np.arange(height, dtype=np.float32) + 0.5 - y1)[:, None]
    t = np.clip((xs * dx + ys * dy) / denom, 0.0, 1.0)

    offsets = np.array([float(s["offset"]) for s in stops], dtype=np.float32)
    colors = np.array([hex_to_rgb(s["color"]) for s in stops], dtype=np.float32)

    out = np.empty((height, width, 3), dtype=np.float32)
    for ch in range(3):
        out[:, :, ch] = np.interp(t, offsets, colors[:, ch])
    return out


def alpha_composite_float(dst: np.ndarray, src_rgba: np.ndarray) -> np.ndarray:
    """Straight-RGBA composite onto float32 RGBA destination in [0..255] / [0..1]."""
    sa = src_rgba[:, :, 3:4]
    da = dst[:, :, 3:4]
    out_a = sa + da * (1.0 - sa)
    safe_a = np.where(out_a > 1e-6, out_a, 1.0)
    out_rgb = (src_rgba[:, :, :3] * sa + dst[:, :, :3] * da * (1.0 - sa)) / safe_a
    out = np.empty_like(dst)
    out[:, :, :3] = np.where(out_a > 1e-6, out_rgb, 0.0)
    out[:, :, 3:4] = out_a
    return out


def draw_spaced_text_centered(
    size: int,
    text: str,
    center_x: float,
    baseline_y: float,
    font_size: int,
    letter_spacing: float,
    color_hex: str,
) -> Image.Image:
    """Render tracked uppercase wordmark optically centered around center_x."""
    font = find_bold_font(font_size)
    probe = Image.new("L", (16, 16), 0)
    draw_probe = ImageDraw.Draw(probe)

    glyph_boxes = []
    total_w = 0.0
    for idx, ch in enumerate(text):
        if ch == " ":
            adv = font_size * 0.38
            glyph_boxes.append((ch, 0.0, adv))
            total_w += adv + letter_spacing
            continue
        bbox = draw_probe.textbbox((0, 0), ch, font=font, anchor="ls")
        gw = float(bbox[2] - bbox[0])
        left_bear = float(bbox[0])
        glyph_boxes.append((ch, left_bear, gw))
        total_w += gw
        if idx < len(text) - 1:
            total_w += letter_spacing

    cursor_x = center_x - total_w / 2.0
    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    r, g, b = hex_to_rgb(color_hex)

    for idx, (ch, left_bear, gw) in enumerate(glyph_boxes):
        if ch != " ":
            draw.text((cursor_x - left_bear, baseline_y), ch, font=font, fill=(r, g, b, 255), anchor="ls")
        cursor_x += gw + letter_spacing
    return layer


def make_squircle_mask(size: int, x0: float, y0: float, w: float, h: float, rx: float, ss: int = 4) -> np.ndarray:
    """Create antialiased [0..1] float32 mask for rounded rectangle."""
    big = Image.new("L", (size * ss, size * ss), 0)
    d = ImageDraw.Draw(big)
    d.rounded_rectangle(
        [x0 * ss, y0 * ss, (x0 + w) * ss, (y0 + h) * ss],
        radius=rx * ss,
        fill=255,
    )
    small = big.resize((size, size), Image.Resampling.LANCZOS)
    return np.asarray(small, dtype=np.float32) / 255.0


def rasterize_swift_layer(
    spec: dict[str, Any],
    size: int,
    tx: float,
    ty: float,
    scale: float,
    ss: int = 4,
    with_shadow: bool = True,
) -> Image.Image:
    """Rasterize the 9-facet Bauhaus origami swift onto a transparent RGBA image of size x size."""
    unit = size / 1000.0
    canvas = np.zeros((size, size, 4), dtype=np.float32)

    # Rasterize swift polygons into an isolated RGBA buffer first so a unified drop shadow is applied
    swift_buf = np.zeros((size, size, 4), dtype=np.float32)
    mask_ss = ss if size <= 1024 else 2

    for facet in spec["facets"]:
        pts_1000 = [(tx + px * scale, ty + py * scale) for px, py in facet["points"]]
        pts_px = [(x * unit, y * unit) for x, y in pts_1000]

        xs = [p[0] for p in pts_px]
        ys = [p[1] for p in pts_px]
        bx0 = max(0, int(math.floor(min(xs))) - 2)
        by0 = max(0, int(math.floor(min(ys))) - 2)
        bx1 = min(size, int(math.ceil(max(xs))) + 2)
        by1 = min(size, int(math.ceil(max(ys))) + 2)
        bw = bx1 - bx0
        bh = by1 - by0
        if bw <= 0 or bh <= 0:
            continue

        poly_big = Image.new("L", (bw * mask_ss, bh * mask_ss), 0)
        poly_draw = ImageDraw.Draw(poly_big)
        poly_draw.polygon([((x - bx0) * mask_ss, (y - by0) * mask_ss) for x, y in pts_px], fill=255)
        poly_alpha = np.asarray(poly_big.resize((bw, bh), Image.Resampling.BOX), dtype=np.float32) / 255.0

        src_crop = np.zeros((bh, bw, 4), dtype=np.float32)
        if facet["fillType"] == "solid":
            r, g, b = hex_to_rgb(facet["color"])
            src_crop[:, :, 0] = r
            src_crop[:, :, 1] = g
            src_crop[:, :, 2] = b
            src_crop[:, :, 3] = poly_alpha * float(facet.get("opacity", 1.0))
        else:
            grad = facet["gradient"]
            gx1 = (tx + grad["x1"] * scale) * unit - bx0
            gy1 = (ty + grad["y1"] * scale) * unit - by0
            gx2 = (tx + grad["x2"] * scale) * unit - bx0
            gy2 = (ty + grad["y2"] * scale) * unit - by0
            rgb_grad = render_linear_gradient_array(bw, bh, gx1, gy1, gx2, gy2, grad["stops"])
            src_crop[:, :, :3] = rgb_grad
            src_crop[:, :, 3] = poly_alpha

        swift_buf[by0:by1, bx0:bx1] = alpha_composite_float(swift_buf[by0:by1, bx0:bx1], src_crop)

    if with_shadow:
        sh = spec["shadow"]
        sr, sg, sb = hex_to_rgb(sh["color"])
        alpha_chan = Image.fromarray(np.clip(swift_buf[:, :, 3] * 255.0, 0, 255).astype(np.uint8), mode="L")
        dx_px = int(round(sh["dx"] * unit))
        dy_px = int(round(sh["dy"] * unit))
        blur_r = max(1.0, float(sh["stdDeviation"]) * unit)

        shifted = Image.new("L", (size, size), 0)
        shifted.paste(alpha_chan, (dx_px, dy_px))
        blurred = shifted.filter(ImageFilter.GaussianBlur(radius=blur_r))
        sh_alpha = (np.asarray(blurred, dtype=np.float32) / 255.0) * float(sh["opacity"])

        canvas[:, :, 0] = sr
        canvas[:, :, 1] = sg
        canvas[:, :, 2] = sb
        canvas[:, :, 3] = sh_alpha
        canvas = alpha_composite_float(canvas, swift_buf)
    else:
        canvas = swift_buf

    out_u8 = np.zeros((size, size, 4), dtype=np.uint8)
    out_u8[:, :, :3] = np.clip(np.round(canvas[:, :, :3]), 0, 255).astype(np.uint8)
    out_u8[:, :, 3] = np.clip(np.round(canvas[:, :, 3] * 255.0), 0, 255).astype(np.uint8)
    return Image.fromarray(out_u8, mode="RGBA")


def rasterize_card_icon(
    spec: dict[str, Any],
    size: int,
    variant_key: str,
    rounded: str = "squircle",
    transparent_outside: bool = True,
) -> Image.Image:
    """
    Rasterize square/squircle/round icon of arbitrary pixel dimension.
    rounded: 'squircle' | 'circle' | 'none'
    """
    v = spec["variants"][variant_key]
    tx, ty = v["translate"]
    scale = v["scale"]
    unit = size / 1000.0

    # Background warm ceramic gradient
    bg_grad = spec["background"]["gradient"]
    bg_rgb = render_linear_gradient_array(
        size,
        size,
        bg_grad["x1"] * unit,
        bg_grad["y1"] * unit,
        bg_grad["x2"] * unit,
        bg_grad["y2"] * unit,
        bg_grad["stops"],
    )
    base_rgba = np.zeros((size, size, 4), dtype=np.float32)
    base_rgba[:, :, :3] = bg_rgb
    base_rgba[:, :, 3] = 1.0

    base_img = Image.fromarray(
        np.dstack([
            np.clip(np.round(base_rgba[:, :, :3]), 0, 255).astype(np.uint8),
            np.full((size, size), 255, dtype=np.uint8),
        ]),
        mode="RGBA",
    )

    swift_img = rasterize_swift_layer(spec, size, tx, ty, scale, ss=4 if size <= 1024 else 2, with_shadow=True)
    composed = Image.alpha_composite(base_img, swift_img)

    if v.get("showWordmark"):
        wm = spec["wordmark"]
        text_img = draw_spaced_text_centered(
            size=size,
            text=wm["shortText"],
            center_x=500.0 * unit,
            baseline_y=wm["badgeY"] * unit,
            font_size=max(8, int(round(wm["badgeFontSize"] * unit))),
            letter_spacing=wm["badgeLetterSpacing"] * unit,
            color_hex=wm["color"],
        )
        composed = Image.alpha_composite(composed, text_img)

    if rounded == "squircle" and transparent_outside:
        mask = make_squircle_mask(size, 0, 0, size, size, spec["squircleRx"] * unit, ss=4)
        arr = np.asarray(composed, dtype=np.uint8).copy()
        arr[:, :, 3] = np.clip(np.round(mask * 255.0), 0, 255).astype(np.uint8)
        return Image.fromarray(arr, mode="RGBA")
    if rounded == "circle" and transparent_outside:
        mask_big = Image.new("L", (size * 4, size * 4), 0)
        d = ImageDraw.Draw(mask_big)
        pad = size * 0.02 * 4
        d.ellipse([pad, pad, size * 4 - pad, size * 4 - pad], fill=255)
        mask = np.asarray(mask_big.resize((size, size), Image.Resampling.LANCZOS), dtype=np.float32) / 255.0
        arr = np.asarray(composed, dtype=np.uint8).copy()
        arr[:, :, 3] = np.clip(np.round(mask * 255.0), 0, 255).astype(np.uint8)
        return Image.fromarray(arr, mode="RGBA")

    return composed


def rasterize_splash(spec: dict[str, Any], width: int, height: int, opaque_rgb: bool = True) -> Image.Image:
    """Rasterize warm ceramic Splash with centered Variant B swift & HERMES FLUX wordmark."""
    bg_grad = spec["background"]["gradient"]
    bg_rgb = render_linear_gradient_array(
        width,
        height,
        (bg_grad["x1"] / 1000.0) * width,
        (bg_grad["y1"] / 1000.0) * height,
        (bg_grad["x2"] / 1000.0) * width,
        (bg_grad["y2"] / 1000.0) * height,
        bg_grad["stops"],
    )
    splash = Image.fromarray(np.clip(np.round(bg_rgb), 0, 255).astype(np.uint8), mode="RGB").convert("RGBA")

    min_dim = min(width, height)
    # Keep hero lockup inside ~32% of square 2732x2732 for iOS scaleAspectFill safety, or ~44% of phone min dim
    hero_frac = 0.28 if width == height and width >= 2000 else 0.42
    hero_size = max(180, int(round(min_dim * hero_frac)))

    v = spec["variants"]["badge"]
    # Render pure swift centered cleanly above wordmark
    swift_hero = rasterize_swift_layer(
        spec,
        hero_size,
        tx=-40.0,
        ty=-50.0,
        scale=1.10,
        ss=3 if hero_size <= 900 else 2,
        with_shadow=True,
    )
    hx = (width - hero_size) // 2
    hy = (height - hero_size) // 2 - int(round(hero_size * 0.14))
    splash.alpha_composite(swift_hero, dest=(hx, hy))

    # Wordmark: HERMES FLUX beneath swift
    wm_font_px = max(18, int(round(hero_size * 0.115)))
    wm_layer = draw_spaced_text_centered(
        size=max(width, height),
        text=spec["wordmark"]["fullText"],
        center_x=width / 2.0,
        baseline_y=hy + hero_size * 0.94,
        font_size=wm_font_px,
        letter_spacing=wm_font_px * 0.24,
        color_hex=spec["wordmark"]["color"],
    )
    wm_cropped = wm_layer.crop((0, 0, width, height))
    splash = Image.alpha_composite(splash, wm_cropped)

    if opaque_rgb:
        return splash.convert("RGB")
    return splash


def build_svg_string(spec: dict[str, Any], variant_key: str, id_prefix: str = "hf") -> str:
    """Emit standalone pure-vector semantic SVG matching brand-spec.json."""
    v = spec["variants"][variant_key]
    tx, ty = v["translate"]
    scale = v["scale"]
    show_card = v["showCard"]
    show_wordmark = v["showWordmark"]

    defs: list[str] = []
    if show_card:
        bg_g = spec["background"]["gradient"]
        stops = "\n      ".join(
            f'<stop offset="{int(round(s["offset"] * 100))}%" stop-color="{s["color"]}" />'
            for s in bg_g["stops"]
        )
        defs.append(
            f'    <linearGradient id="{id_prefix}-bg" x1="{bg_g["x1"]}" y1="{bg_g["y1"]}" '
            f'x2="{bg_g["x2"]}" y2="{bg_g["y2"]}" gradientUnits="userSpaceOnUse">\n'
            f'      {stops}\n'
            f'    </linearGradient>'
        )

    sh = spec["shadow"]
    defs.append(
        f'    <filter id="{id_prefix}-shadow" x="-25%" y="-25%" width="150%" height="150%">\n'
        f'      <feDropShadow dx="{sh["dx"]}" dy="{sh["dy"]}" stdDeviation="{sh["stdDeviation"]}" '
        f'flood-color="{sh["color"]}" flood-opacity="{sh["opacity"]}" />\n'
        f'    </filter>'
    )

    for facet in spec["facets"]:
        if facet["fillType"] != "linear":
            continue
        fg = facet["gradient"]
        stops = "\n      ".join(
            f'<stop offset="{int(round(s["offset"] * 100))}%" stop-color="{s["color"]}" />'
            for s in fg["stops"]
        )
        defs.append(
            f'    <linearGradient id="{id_prefix}-{facet["id"]}" x1="{fg["x1"]}" y1="{fg["y1"]}" '
            f'x2="{fg["x2"]}" y2="{fg["y2"]}" gradientUnits="userSpaceOnUse">\n'
            f'      {stops}\n'
            f'    </linearGradient>'
        )

    # Group contiguous facets by semantic part
    part_groups: list[tuple[str, list[dict[str, Any]]]] = []
    for facet in spec["facets"]:
        part = facet["part"]
        if not part_groups or part_groups[-1][0] != part:
            part_groups.append((part, [facet]))
        else:
            part_groups[-1][1].append(facet)

    part_lines: list[str] = []
    for part, items in part_groups:
        part_lines.append(f'      <g data-part="{part}">')
        for facet in items:
            pts_str = " ".join(f"{x},{y}" for x, y in facet["points"])
            if facet["fillType"] == "solid":
                part_lines.append(
                    f'        <polygon id="{id_prefix}-poly-{facet["id"]}" points="{pts_str}" '
                    f'fill="{facet["color"]}" fill-opacity="{facet["opacity"]}" />'
                )
            else:
                part_lines.append(
                    f'        <polygon id="{id_prefix}-poly-{facet["id"]}" points="{pts_str}" '
                    f'fill="url(#{id_prefix}-{facet["id"]})" />'
                )
        part_lines.append("      </g>")

    lines = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{spec["viewBox"]}" width="100%" height="100%" role="img" aria-label="Hermes Flux">',
        "  <defs>",
        "\n".join(defs),
        "  </defs>",
    ]

    if show_card:
        lines.append(
            f'  <rect x="8" y="8" width="984" height="984" rx="{spec["squircleRx"]}" fill="url(#{id_prefix}-bg)" '
            f'stroke="{sh["color"]}" stroke-opacity="0.10" stroke-width="4" />'
        )

    lines.append(f'  <g filter="url(#{id_prefix}-shadow)">')
    lines.append(f'    <g transform="translate({tx}, {ty}) scale({scale})">')
    lines.extend(part_lines)
    lines.append("    </g>")
    lines.append("  </g>")

    if show_wordmark:
        wm = spec["wordmark"]
        # Optically compensate trailing letter-spacing on centered SVG text
        cx = 500 + wm["badgeLetterSpacing"] // 2
        lines.append(
            f'  <text x="{cx}" y="{wm["badgeY"]}" text-anchor="middle" fill="{wm["color"]}" '
            f'font-family="\'Segoe UI\', -apple-system, BlinkMacSystemFont, \'Inter\', Arial, sans-serif" '
            f'font-size="{wm["badgeFontSize"]}" font-weight="800" letter-spacing="{wm["badgeLetterSpacing"]}">'
            f'{wm["shortText"]}</text>'
        )

    lines.append("</svg>")
    return "\n".join(lines) + "\n"


def emit_brand_spec_ts(spec: dict[str, Any]) -> None:
    """Generate packages/ui/src/icons/brand/brandSpec.ts from brand-spec.json."""
    out_path = BRAND_DIR / "brandSpec.ts"
    json_literal = json.dumps(spec, ensure_ascii=False, indent=2)
    content = f"""/**
 * Hermes Flux 品牌几何与色彩规格镜像 (@generated by scripts/gen-app-icons.py)
 *
 * 【设计意图 (Why)】
 *   UI 组件层需要强类型消费 `brand-spec.json` 中的包豪斯折纸雨燕几何、渐变与语义分片信息，
 *   而 UI 包启用 strict ESM 且未开启 resolveJsonModule；由生成脚本同步输出只读 TS 镜像，
 *   保证所有矢量 SVG、React 组件与多端位图共享唯一真值源，零手工漂移。
 *
 * 【防范的历史坑 (Pitfall)】
 *   严禁手改本文件中的坐标或色值；任何改动必须回到 `brand-spec.json` 并运行 `npm run icons:gen`。
 *
 * 【约束与规则 (Rules)】
 *   1. 本文件位于 `packages/ui/src/icons/`，仅定义品牌视觉数据，严禁在此混入换肤 UI 文案或状态逻辑；
 *   2. spineCollinearPoints 五点保持数学共线，修改时须同步保持零缝隙邻接。
 */

export type BrandFacetPart = 'wing-lower' | 'tail' | 'wing-upper' | 'head' | 'beak' | 'body';

export interface BrandGradientStop {{
  readonly offset: number;
  readonly color: string;
}}

export interface BrandLinearGradient {{
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
  readonly stops: readonly BrandGradientStop[];
}}

export type BrandFacet =
  | {{
      readonly id: string;
      readonly part: BrandFacetPart;
      readonly points: readonly (readonly [number, number])[];
      readonly fillType: 'linear';
      readonly gradient: BrandLinearGradient;
    }}
  | {{
      readonly id: string;
      readonly part: BrandFacetPart;
      readonly points: readonly (readonly [number, number])[];
      readonly fillType: 'solid';
      readonly color: string;
      readonly opacity: number;
    }};

export interface BrandVariantTransform {{
  readonly translate: readonly [number, number];
  readonly scale: number;
  readonly showCard: boolean;
  readonly showWordmark: boolean;
}}

export interface BrandSpec {{
  readonly version: string;
  readonly name: string;
  readonly referenceImage?: string;
  readonly viewBox: string;
  readonly squircleRx: number;
  readonly background: {{
    readonly flatHex: string;
    readonly gradient: BrandLinearGradient;
  }};
  readonly shadow: {{
    readonly dx: number;
    readonly dy: number;
    readonly stdDeviation: number;
    readonly color: string;
    readonly opacity: number;
  }};
  readonly wordmark: {{
    readonly shortText: string;
    readonly fullText: string;
    readonly color: string;
    readonly badgeY: number;
    readonly badgeFontSize: number;
    readonly badgeLetterSpacing: number;
  }};
  readonly spineCollinearPoints: readonly (readonly [number, number])[];
  readonly animationPivots: Record<string, readonly [number, number]>;
  readonly facets: readonly BrandFacet[];
  readonly variants: Record<'icon' | 'badge' | 'mark' | 'androidAdaptive' | 'androidRound', BrandVariantTransform>;
}}

export const BRAND_SPEC: BrandSpec = {json_literal} as const;
"""
    out_path.write_text(content, encoding="utf-8", newline="\n")


def emit_android_vectors(spec: dict[str, Any]) -> None:
    """Update Android VectorDrawable & color XML resources from brand-spec.json."""
    # 1. values/ic_launcher_background.xml
    bg_color_xml = ANDROID_RES_DIR / "values/ic_launcher_background.xml"
    bg_color_xml.write_text(
        '<?xml version="1.0" encoding="utf-8"?>\n'
        '<resources>\n'
        f'    <color name="ic_launcher_background">{spec["background"]["flatHex"]}</color>\n'
        '</resources>\n',
        encoding="utf-8",
        newline="\n",
    )

    # 2. drawable/ic_launcher_background.xml (warm ceramic vector fill)
    drawable_bg_xml = ANDROID_RES_DIR / "drawable/ic_launcher_background.xml"
    drawable_bg_xml.write_text(
        '<?xml version="1.0" encoding="utf-8"?>\n'
        '<vector xmlns:android="http://schemas.android.com/apk/res/android"\n'
        '    android:width="108dp"\n'
        '    android:height="108dp"\n'
        '    android:viewportWidth="108"\n'
        '    android:viewportHeight="108">\n'
        '    <path\n'
        f'        android:fillColor="{spec["background"]["flatHex"]}"\n'
        '        android:pathData="M0,0h108v108h-108z" />\n'
        '</vector>\n',
        encoding="utf-8",
        newline="\n",
    )

    # 3. drawable-v24/ic_launcher_foreground.xml (Bauhaus origami swift mapped to 108dp viewport)
    v = spec["variants"]["androidAdaptive"]
    tx, ty = v["translate"]
    sc = v["scale"]
    dp_scale = 108.0 / 1000.0

    vector_paths: list[str] = []
    for facet in spec["facets"]:
        pts = [((tx + x * sc) * dp_scale, (ty + y * sc) * dp_scale) for x, y in facet["points"]]
        path_d = "M" + " L".join(f"{px:.2f},{py:.2f}" for px, py in pts) + " Z"
        if facet["fillType"] == "solid":
            alpha_hex = f"{int(round(facet['opacity'] * 255)):02X}"
            raw_hex = facet["color"].lstrip("#")
            fill_attr = f'android:fillColor="#{alpha_hex}{raw_hex}"'
            vector_paths.append(
                f'    <path\n        {fill_attr}\n        android:pathData="{path_d}" />'
            )
        else:
            grad = facet["gradient"]
            sx = (tx + grad["x1"] * sc) * dp_scale
            sy = (ty + grad["y1"] * sc) * dp_scale
            ex = (tx + grad["x2"] * sc) * dp_scale
            ey = (ty + grad["y2"] * sc) * dp_scale
            items = "\n".join(
                f'                <item android:color="{s["color"]}" android:offset="{s["offset"]}" />'
                for s in grad["stops"]
            )
            vector_paths.append(
                f'    <path android:pathData="{path_d}">\n'
                f'        <aapt:attr name="android:fillColor">\n'
                f'            <gradient\n'
                f'                android:startX="{sx:.2f}"\n'
                f'                android:startY="{sy:.2f}"\n'
                f'                android:endX="{ex:.2f}"\n'
                f'                android:endY="{ey:.2f}"\n'
                f'                android:type="linear">\n'
                f'{items}\n'
                f'            </gradient>\n'
                f'        </aapt:attr>\n'
                f'    </path>'
            )

    fg_xml = ANDROID_RES_DIR / "drawable-v24/ic_launcher_foreground.xml"
    fg_xml.write_text(
        '<vector xmlns:android="http://schemas.android.com/apk/res/android"\n'
        '    xmlns:aapt="http://schemas.android.com/aapt"\n'
        '    android:width="108dp"\n'
        '    android:height="108dp"\n'
        '    android:viewportWidth="108"\n'
        '    android:viewportHeight="108">\n'
        + "\n".join(vector_paths)
        + "\n</vector>\n",
        encoding="utf-8",
        newline="\n",
    )


def main() -> None:
    spec = json.loads(SPEC_PATH.read_text(encoding="utf-8"))
    BRAND_DIR.mkdir(parents=True, exist_ok=True)
    DESKTOP_BUILD_DIR.mkdir(parents=True, exist_ok=True)

    print("[Hermes Flux Brand Generator] Generating assets from brand-spec.json...")

    # 1. Typed TypeScript mirror
    emit_brand_spec_ts(spec)
    print("  ✔ Emitted packages/ui/src/icons/brand/brandSpec.ts")

    # 2. Pure-vector semantic SVGs
    for variant_key, filename in [
        ("icon", "hermes-flux-icon.svg"),
        ("badge", "hermes-flux-badge.svg"),
        ("mark", "hermes-flux-mark.svg"),
    ]:
        svg_text = build_svg_string(spec, variant_key, id_prefix=f"hf-{variant_key}")
        (BRAND_DIR / filename).write_text(svg_text, encoding="utf-8", newline="\n")
    print("  ✔ Emitted 3 semantic SVGs (icon / badge / mark)")

    # 3. Desktop 1024x1024 RGBA master + ICO + favicon-32
    master_1024 = rasterize_card_icon(spec, 1024, "icon", rounded="squircle", transparent_outside=True)
    master_1024.save(DESKTOP_BUILD_DIR / "icon.png", format="PNG")
    master_1024.resize((32, 32), Image.Resampling.LANCZOS).save(BRAND_DIR / "favicon-32.png", format="PNG")

    ico_sizes = [16, 24, 32, 48, 64, 128, 256]
    ico_frames = [master_1024.resize((s, s), Image.Resampling.LANCZOS) for s in ico_sizes]
    ico_frames[-1].save(
        DESKTOP_BUILD_DIR / "icon.ico",
        format="ICO",
        append_images=ico_frames[:-1],
        sizes=[(s, s) for s in ico_sizes],
    )
    print("  ✔ Emitted Desktop icon.png (1024x1024), icon.ico (16~256), and favicon-32.png")

    # 4. iOS AppIcon (1024x1024 opaque RGB) & Splash (2732x2732 opaque RGB)
    ios_icon = rasterize_card_icon(spec, 1024, "icon", rounded="none", transparent_outside=False).convert("RGB")
    ios_icon.save(IOS_ASSETS_DIR / "AppIcon.appiconset/AppIcon-512@2x.png", format="PNG")

    ios_splash = rasterize_splash(spec, 2732, 2732, opaque_rgb=True)
    for name in ["splash-2732x2732.png", "splash-2732x2732-1.png", "splash-2732x2732-2.png"]:
        ios_splash.save(IOS_ASSETS_DIR / "Splash.imageset" / name, format="PNG")
    print("  ✔ Emitted iOS AppIcon-512@2x.png (RGB) & Splash.imageset (3x 2732x2732 RGB)")

    # 5. Android Launcher Icons (legacy square, legacy round, transparent adaptive foreground)
    round_1024 = rasterize_card_icon(spec, 1024, "androidRound", rounded="circle", transparent_outside=True)
    adaptive_v = spec["variants"]["androidAdaptive"]
    adaptive_512 = rasterize_swift_layer(
        spec,
        512,
        adaptive_v["translate"][0],
        adaptive_v["translate"][1],
        adaptive_v["scale"],
        ss=4,
        with_shadow=True,
    )

    density_dims = {
        "mdpi": (48, 108),
        "hdpi": (72, 162),
        "xhdpi": (96, 216),
        "xxhdpi": (144, 324),
        "xxxhdpi": (192, 432),
    }
    for density, (icon_px, fg_px) in density_dims.items():
        mdir = ANDROID_RES_DIR / f"mipmap-{density}"
        master_1024.resize((icon_px, icon_px), Image.Resampling.LANCZOS).save(mdir / "ic_launcher.png", format="PNG")
        round_1024.resize((icon_px, icon_px), Image.Resampling.LANCZOS).save(mdir / "ic_launcher_round.png", format="PNG")
        adaptive_512.resize((fg_px, fg_px), Image.Resampling.LANCZOS).save(mdir / "ic_launcher_foreground.png", format="PNG")

    emit_android_vectors(spec)
    print("  ✔ Emitted Android 15 mipmap PNGs & updated VectorDrawable XMLs")

    # 6. Android 11 Splash PNGs
    splash_targets = {
        "drawable/splash.png": (480, 320),
        "drawable-port-mdpi/splash.png": (320, 480),
        "drawable-port-hdpi/splash.png": (480, 800),
        "drawable-port-xhdpi/splash.png": (720, 1280),
        "drawable-port-xxhdpi/splash.png": (960, 1600),
        "drawable-port-xxxhdpi/splash.png": (1280, 1920),
        "drawable-land-mdpi/splash.png": (480, 320),
        "drawable-land-hdpi/splash.png": (800, 480),
        "drawable-land-xhdpi/splash.png": (1280, 720),
        "drawable-land-xxhdpi/splash.png": (1600, 960),
        "drawable-land-xxxhdpi/splash.png": (1920, 1280),
    }
    splash_cache: dict[tuple[int, int], Image.Image] = {}
    for rel, dims in splash_targets.items():
        if dims not in splash_cache:
            splash_cache[dims] = rasterize_splash(spec, dims[0], dims[1], opaque_rgb=True)
        splash_cache[dims].save(ANDROID_RES_DIR / rel, format="PNG")
    print("  ✔ Emitted Android 11 Splash PNGs")
    print("[Hermes Flux Brand Generator] Done.")


if __name__ == "__main__":
    main()
