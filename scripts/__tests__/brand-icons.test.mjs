/**
 * Hermes Flux 跨端品牌资产契约与二进制像素校验测试
 *
 * 【测试什么】
 *   1. 原始设计母本 (`bauhaus-swift-reference.jpg`) 与 `brand-spec.json` 真实落盘、共线脊线成立，
 *      且与生成镜像 `brandSpec.ts` (`BRAND_SPEC`) 深度全等；
 *   2. 三份静态 SVG (`hermes-flux-{icon,badge,mark}.svg`) 与桌面冷启动 `index.html` 内联 SVG
 *      精确复用 `brand-spec.json` 的 `squircleRx`、变换矩阵、9 面顶点与渐变停靠色，零漂移；
 *   3. Desktop (`icon.png` 1024x1024 RGBA / `icon.ico` 7 尺寸)、iOS (`AppIcon` 1024x1024 纯 RGB 无透明、
 *      `Splash` 3x 2732x2732 纯 RGB)、Android (15 枚 mipmap PNG 含透明自适应前景 / 11 枚 Splash PNG /
 *      3 份 VectorDrawable & color XML) 二进制头与像素尺寸 100% 合规；
 *   4. 桌面渲染产物 (`dist/renderer/icons/brand/`) 与 `start-browser-live.mjs` 静态路由同步包含品牌资产。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { BRAND_SPEC } from '../../packages/ui/dist/icons/brand/brandSpec.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../..');

function readPngHeader(absPath) {
  const buf = fs.readFileSync(absPath);
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.ok(buf.subarray(0, 8).equals(sig), `${absPath} 必须是合法 PNG 文件头`);
  assert.equal(buf.subarray(12, 16).toString('ascii'), 'IHDR', `${absPath} 首个 chunk 必须为 IHDR`);
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
    bitDepth: buf.readUInt8(24),
    colorType: buf.readUInt8(25), // 2 = RGB (opaque), 6 = RGBA
    buf,
  };
}

function readRgbaCornerAlpha(absPath) {
  const { width, height, colorType, buf } = readPngHeader(absPath);
  assert.equal(colorType, 6, `${absPath} 必须为 RGBA (colorType=6)`);
  const idats = [];
  let off = 8;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const kind = buf.subarray(off + 4, off + 8).toString('ascii');
    if (kind === 'IDAT') idats.push(buf.subarray(off + 8, off + 8 + len));
    off += 12 + len;
  }
  const inflated = zlib.inflateSync(Buffer.concat(idats));
  const rowBytes = width * 4 + 1;
  const topLeftFilter = inflated[0];
  assert.equal(topLeftFilter, 0, '预期第 0 行 filter type === 0 以便直接读取角区透明通道');
  const tlAlpha = inflated[4];
  const trAlpha = inflated[1 + (width - 1) * 4 + 3];
  const blRowStart = (height - 1) * rowBytes;
  const blFilter = inflated[blRowStart];
  assert.equal(blFilter, 0, '预期末行 filter type === 0');
  const blAlpha = inflated[blRowStart + 4];
  return { tlAlpha, trAlpha, blAlpha };
}

function readIcoEntries(absPath) {
  const buf = fs.readFileSync(absPath);
  assert.equal(buf.readUInt16LE(0), 0, 'ICO reserved word 必须为 0');
  assert.equal(buf.readUInt16LE(2), 1, 'ICO type 必须为 1 (icon)');
  const count = buf.readUInt16LE(4);
  const sizes = [];
  for (let i = 0; i < count; i += 1) {
    const base = 6 + i * 16;
    const rawW = buf.readUInt8(base);
    const rawH = buf.readUInt8(base + 1);
    sizes.push({
      width: rawW === 0 ? 256 : rawW,
      height: rawH === 0 ? 256 : rawH,
    });
  }
  return sizes;
}

function assertSvgMatchesSpecGeometry(svgMarkup, spec, variantKey, label) {
  const v = spec.variants[variantKey];
  const [tx, ty] = v.translate;
  assert.ok(
    svgMarkup.includes(`transform="translate(${tx}, ${ty}) scale(${v.scale})"`),
    `${label} 必须保持变体 ${variantKey} 的严格变换矩阵`,
  );
  for (const facet of spec.facets) {
    const expectedPoints = facet.points.map(([x, y]) => `${x},${y}`).join(' ');
    assert.ok(
      svgMarkup.includes(`points="${expectedPoints}"`),
      `${label} 缺少分面 ${facet.id} 的精确坐标 points="${expectedPoints}"`,
    );
    if (facet.fillType === 'linear') {
      for (const stop of facet.gradient.stops) {
        assert.ok(
          svgMarkup.includes(stop.color),
          `${label} 缺少分面 ${facet.id} 渐变色 ${stop.color}`,
        );
      }
    } else {
      assert.ok(svgMarkup.includes(facet.color), `${label} 缺少纯色分面 ${facet.id} (${facet.color})`);
    }
  }
  for (const part of ['wing-lower', 'tail', 'wing-upper', 'head', 'beak', 'body']) {
    assert.ok(svgMarkup.includes(`data-part="${part}"`), `${label} 缺少语义部位 data-part="${part}"`);
  }
}

test('品牌母本：参考原图、brand-spec.json 与生成镜像 BRAND_SPEC 完全一致且脊线共线', () => {
  const refPath = path.join(REPO_ROOT, 'docs/design-system/brand/bauhaus-swift-reference.jpg');
  const specDocPath = path.join(REPO_ROOT, 'docs/design-system/brand-identity-spec.md');
  const specJsonPath = path.join(REPO_ROOT, 'packages/ui/src/icons/brand/brand-spec.json');

  assert.ok(fs.existsSync(refPath), '必须保留原始参考图 bauhaus-swift-reference.jpg');
  const jpgHeader = fs.readFileSync(refPath).subarray(0, 3);
  assert.deepEqual([...jpgHeader], [0xff, 0xd8, 0xff], '参考图必须是有效 JPEG 二进制');

  const docText = fs.readFileSync(specDocPath, 'utf8');
  assert.ok(docText.includes('bauhaus-swift-reference.jpg'), '设计规范必须引用原始参考图');
  assert.ok(docText.includes('brand-spec.json'), '设计规范必须引用 brand-spec.json');
  assert.ok(docText.includes('fluxSwiftWingUpper') && docText.includes('fluxSwiftWingLower'), '规范必须与实际拆分关键帧命名一致');

  const spec = JSON.parse(fs.readFileSync(specJsonPath, 'utf8'));
  assert.deepEqual(BRAND_SPEC, spec, 'brandSpec.ts 的 BRAND_SPEC 必须与 brand-spec.json 严格深相等，禁止手改漂移');
  assert.equal(spec.viewBox, '0 0 1000 1000');
  assert.equal(spec.facets.length, 9, '包豪斯折纸雨燕必须包含全部 9 个矢量分面');
  assert.equal(spec.variants.icon.showWordmark, false, 'Variant A 图标禁止带文字');
  assert.equal(spec.variants.badge.showWordmark, true, 'Variant B 徽标必须带 FLUX 字标');
  assert.equal(spec.variants.mark.showCard, false, 'Floating mark 必须无外框底卡');

  const pts = spec.spineCollinearPoints;
  assert.equal(pts.length, 5);
  const [x1, y1] = pts[0];
  const [x2, y2] = pts[pts.length - 1];
  const segLen = Math.hypot(x2 - x1, y2 - y1);
  for (const [px, py] of pts.slice(1, -1)) {
    const cross = Math.abs((x2 - x1) * (y1 - py) - (x1 - px) * (y2 - y1));
    const dist = cross / segLen;
    assert.ok(dist < 1.0, `脊线点 (${px}, ${py}) 偏离共线轴 ${dist.toFixed(3)}px >= 1px`);
  }
});

test('SVG 三态资产与冷启动 index.html 内联矢量：与 brand-spec.json 几何/色值/圆角严格同源', () => {
  const iconSvg = fs.readFileSync(path.join(REPO_ROOT, 'packages/ui/src/icons/brand/hermes-flux-icon.svg'), 'utf8');
  const badgeSvg = fs.readFileSync(path.join(REPO_ROOT, 'packages/ui/src/icons/brand/hermes-flux-badge.svg'), 'utf8');
  const markSvg = fs.readFileSync(path.join(REPO_ROOT, 'packages/ui/src/icons/brand/hermes-flux-mark.svg'), 'utf8');
  const html = fs.readFileSync(path.join(REPO_ROOT, 'packages/desktop/src/renderer/index.html'), 'utf8');

  assert.ok(!iconSvg.includes('<text'), 'Variant A SVG 不得包含任何文字');
  assert.ok(iconSvg.includes(`<rect x="8" y="8" width="984" height="984" rx="${BRAND_SPEC.squircleRx}"`), 'Variant A rx 必须与 brand-spec.json squircleRx 一致');
  assert.ok(iconSvg.includes(`stroke="${BRAND_SPEC.shadow.color}"`), 'Variant A 描边色必须读取自 shadow.color');
  assertSvgMatchesSpecGeometry(iconSvg, BRAND_SPEC, 'icon', 'hermes-flux-icon.svg');

  assert.ok(badgeSvg.includes('>FLUX</text>'), 'Variant B SVG 必须包含 FLUX 字标');
  assert.ok(badgeSvg.includes(BRAND_SPEC.wordmark.color), 'Variant B 字标必须使用 brand-spec.json wordmark.color');
  assert.ok(badgeSvg.includes(`rx="${BRAND_SPEC.squircleRx}"`), 'Variant B rx 必须与 brand-spec.json squircleRx 一致');
  assertSvgMatchesSpecGeometry(badgeSvg, BRAND_SPEC, 'badge', 'hermes-flux-badge.svg');

  assert.ok(!markSvg.includes('<rect'), 'Floating Mark SVG 不得包含底框矩形');
  assert.ok(!markSvg.includes('<text'), 'Floating Mark SVG 不得包含文字');
  assertSvgMatchesSpecGeometry(markSvg, BRAND_SPEC, 'mark', 'hermes-flux-mark.svg');

  assert.ok(html.includes('href="icons/brand/hermes-flux-icon.svg"'), 'index.html 必须配置 SVG favicon');
  assert.ok(html.includes('href="icons/brand/favicon-32.png"'), 'index.html 必须配置 32px PNG favicon');
  assert.ok(html.includes('data-boot-splash="true"'), 'index.html 必须包含冷启动过渡闪屏');
  assert.ok(html.includes('data-brand-motion="fly"'), '冷启动闪屏必须包含飞行动画雨燕');
  assert.ok(!html.includes('<rect'), 'index.html 透明悬浮启动雨燕不得包含底框矩形');
  assertSvgMatchesSpecGeometry(html, BRAND_SPEC, 'mark', 'index.html boot splash SVG');
});

test('Desktop 资产与 Browser-Live 路由：icon.png / icon.ico / favicon-32.png 与构建产物完整', () => {
  const pngInfo = readPngHeader(path.join(REPO_ROOT, 'packages/desktop/build/icon.png'));
  assert.equal(pngInfo.width, 1024);
  assert.equal(pngInfo.height, 1024);
  assert.equal(pngInfo.colorType, 6, 'Desktop icon.png 必须保留圆角外侧 Alpha 透明通道');

  const favInfo = readPngHeader(path.join(REPO_ROOT, 'packages/ui/src/icons/brand/favicon-32.png'));
  assert.equal(favInfo.width, 32);
  assert.equal(favInfo.height, 32);

  const icoEntries = readIcoEntries(path.join(REPO_ROOT, 'packages/desktop/build/icon.ico'));
  assert.deepEqual(
    icoEntries.map((e) => e.width).sort((a, b) => a - b),
    [16, 24, 32, 48, 64, 128, 256],
    'icon.ico 必须内置 16~256 全部 7 档尺寸',
  );

  for (const shipped of ['hermes-flux-icon.svg', 'hermes-flux-badge.svg', 'hermes-flux-mark.svg', 'favicon-32.png']) {
    const builtPath = path.join(REPO_ROOT, 'packages/desktop/dist/renderer/icons/brand', shipped);
    assert.ok(fs.existsSync(builtPath), `Desktop 构建产物必须包含 icons/brand/${shipped}`);
  }

  const liveServerSrc = fs.readFileSync(path.join(REPO_ROOT, 'scripts/start-browser-live.mjs'), 'utf8');
  assert.ok(liveServerSrc.includes('/icons/brand/hermes-flux-icon.svg'), '浏览器直跑模式必须声明品牌 SVG favicon');
  assert.ok(liveServerSrc.includes("'icons/brand/'"), '浏览器直跑模式必须静态映射 /icons/brand/*');
});

test('iOS 资产：AppIcon-512@2x 与 3 份 Splash 均为纯净不透明 RGB（严禁携带 Alpha 通道）', () => {
  const iosIcon = readPngHeader(
    path.join(REPO_ROOT, 'packages/mobile/ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png'),
  );
  assert.equal(iosIcon.width, 1024);
  assert.equal(iosIcon.height, 1024);
  assert.equal(iosIcon.colorType, 2, 'iOS AppIcon 必须为纯 RGB (colorType=2) 无 Alpha 通道');

  for (const name of ['splash-2732x2732.png', 'splash-2732x2732-1.png', 'splash-2732x2732-2.png']) {
    const sp = readPngHeader(
      path.join(REPO_ROOT, 'packages/mobile/ios/App/App/Assets.xcassets/Splash.imageset', name),
    );
    assert.equal(sp.width, 2732, `${name} 宽度必须为 2732`);
    assert.equal(sp.height, 2732, `${name} 高度必须为 2732`);
    assert.equal(sp.colorType, 2, `${name} 必须为纯 RGB`);
  }
});

test('Android 资产：15 枚 mipmap、透明自适应前景、VectorDrawable XML 与 11 枚 Splash PNG 全部合规', () => {
  const densities = {
    mdpi: [48, 108],
    hdpi: [72, 162],
    xhdpi: [96, 216],
    xxhdpi: [144, 324],
    xxxhdpi: [192, 432],
  };

  for (const [density, [iconPx, fgPx]] of Object.entries(densities)) {
    const dir = path.join(REPO_ROOT, `packages/mobile/android/app/src/main/res/mipmap-${density}`);
    const sq = readPngHeader(path.join(dir, 'ic_launcher.png'));
    const rd = readPngHeader(path.join(dir, 'ic_launcher_round.png'));
    const fg = readPngHeader(path.join(dir, 'ic_launcher_foreground.png'));

    assert.equal(sq.width, iconPx);
    assert.equal(sq.height, iconPx);
    assert.equal(rd.width, iconPx);
    assert.equal(rd.height, iconPx);
    assert.equal(fg.width, fgPx);
    assert.equal(fg.height, fgPx);
    assert.equal(fg.colorType, 6, `mipmap-${density}/ic_launcher_foreground.png 必须是 RGBA`);
  }

  const corners = readRgbaCornerAlpha(
    path.join(REPO_ROOT, 'packages/mobile/android/app/src/main/res/mipmap-xxxhdpi/ic_launcher_foreground.png'),
  );
  assert.deepEqual(corners, { tlAlpha: 0, trAlpha: 0, blAlpha: 0 }, 'Android 自适应前景四角必须全透明');

  const bgColorXml = fs.readFileSync(
    path.join(REPO_ROOT, 'packages/mobile/android/app/src/main/res/values/ic_launcher_background.xml'),
    'utf8',
  );
  assert.ok(bgColorXml.includes(BRAND_SPEC.background.flatHex), 'Android 启动底色必须来自 brand-spec background.flatHex');

  const drawableBg = fs.readFileSync(
    path.join(REPO_ROOT, 'packages/mobile/android/app/src/main/res/drawable/ic_launcher_background.xml'),
    'utf8',
  );
  assert.ok(drawableBg.includes(BRAND_SPEC.background.flatHex) && !drawableBg.includes('#26A69A'), '必须替换遗留绿色网格背景');

  const drawableFg = fs.readFileSync(
    path.join(REPO_ROOT, 'packages/mobile/android/app/src/main/res/drawable-v24/ic_launcher_foreground.xml'),
    'utf8',
  );
  assert.ok(!drawableFg.includes('M66.94,46.02'), '必须清理遗留的默认 Android 机器人头像路径');
  assert.ok(drawableFg.includes('#FF6538') && drawableFg.includes('#12B0A2'), 'Android 矢量前景必须包含包豪斯雨燕分面配色');

  const expectedSplashes = {
    'drawable/splash.png': [480, 320],
    'drawable-port-mdpi/splash.png': [320, 480],
    'drawable-port-hdpi/splash.png': [480, 800],
    'drawable-port-xhdpi/splash.png': [720, 1280],
    'drawable-port-xxhdpi/splash.png': [960, 1600],
    'drawable-port-xxxhdpi/splash.png': [1280, 1920],
    'drawable-land-mdpi/splash.png': [480, 320],
    'drawable-land-hdpi/splash.png': [800, 480],
    'drawable-land-xhdpi/splash.png': [1280, 720],
    'drawable-land-xxhdpi/splash.png': [1600, 960],
    'drawable-land-xxxhdpi/splash.png': [1920, 1280],
  };
  for (const [rel, [w, h]] of Object.entries(expectedSplashes)) {
    const sp = readPngHeader(path.join(REPO_ROOT, 'packages/mobile/android/app/src/main/res', rel));
    assert.equal(sp.width, w, `${rel} 宽应为 ${w}`);
    assert.equal(sp.height, h, `${rel} 高应为 ${h}`);
  }
});
