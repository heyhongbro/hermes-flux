# Hermes Flux 品牌视觉标识规范 (Bauhaus Origami Swift Identity Spec)

## 1. 品牌起源与原稿资产留存 (Origin & Preserved Assets)

Hermes Flux 的品牌主图形为 **包豪斯原彩折纸雨燕（Bauhaus Classic Origami Swift）**，象征极速流式响应（Flux）、锐利几何美学与跨越 Desktop / Web / iOS / Android 的一致协同体验。

为便于后续扩展动画、多端变体衍生、动态换肤与高清物料再创作，系统将原始参考图与结构化几何规格完整保留于版本库中：

| 资产 | 路径 | 用途与语义 |
|---|---|---|
| **原始确定稿参考图** | [`docs/design-system/brand/bauhaus-swift-reference.jpg`](brand/bauhaus-swift-reference.jpg) | 未经裁切的 W3 包豪斯撞色燕确定稿原始 Raster，作为光影/比例/色相母本留存 |
| **几何与色彩单一真值 JSON** | [`packages/ui/src/icons/brand/brand-spec.json`](../../packages/ui/src/icons/brand/brand-spec.json) | 1000×1000 坐标系、9 面共线多边形顶点、渐变停靠点、语义部位 `part`、动画轴心 `animationPivots` 与各端变换矩阵 |
| **TypeScript 镜像模块** | [`packages/ui/src/icons/brand/brandSpec.ts`](../../packages/ui/src/icons/brand/brandSpec.ts) | `@generated` 只读类型镜像，供 `<BrandSwiftMark />` 与模板字符串渲染消费（`npm run icons:gen` 自动同步） |
| **纯矢量语义 SVG 资产** | `packages/ui/src/icons/brand/hermes-flux-{icon,badge,mark}.svg` | Variant A (`icon`)、Variant B (`badge`) 与悬浮透明精灵 (`mark`) 三份纯矢量母版，打包时拷贝至 `dist/renderer/icons/brand/` |
| **跨端生成管线** | [`scripts/gen-app-icons.py`](../../scripts/gen-app-icons.py) | 基于 `brand-spec.json` 一次性确定性产出 SVG + Desktop + Web + iOS + Android 全部资产（`npm run icons:gen`） |

---

## 2. 场景严格分流原则 (Variant Split Matrix)

遵循产品定位，「系统桌面/启动图标不重复叠字，非图标品牌展示区清晰呈现字标」：

| 变体 ID | 构成 | 变换参数 (`1000×1000`) | 适用场景（严格执行） |
|---|---|---|---|
| **Variant A (`icon`)** | 暖陶白超椭圆卡片 + 放大版折纸燕（**无文字**） | `translate(-140, -135) scale(1.28)` | Desktop `icon.png` / `icon.ico`、系统托盘、Web `favicon`、iOS `AppIcon`、Android `ic_launcher` / `ic_launcher_round`、`Settings → About`（旁侧已印有 `Hermes Flux` 标题） |
| **Variant B (`badge`)** | 暖陶白超椭圆卡片 + 折纸燕 + 深靛蓝 `#152854` `FLUX` 字标 | `translate(-20, -104) scale(1.04)` + `FLUX` | `README.md` 顶部徽标、Gateway Onboarding 引导卡主视觉、新会话空白对话舞台（`ConversationMessageList` / `ConversationStage` / `MiddlePod`）、iOS & Android 启动闪屏（配合 `HERMES FLUX`） |
| **Floating Mark (`mark`)** | 无背景卡片、透明底纯燕子矢量，按部位划分 `<g data-part="...">` | `translate(-120, -116) scale(1.24)` | 运行时飞翔加载态（Desktop 冷启动闪屏 `index.html`、Gateway 连接中、对话历史加载骨架 `ConversationSkeleton`）、深/浅主题通透浮标 |
| **Android Adaptive** | 透明前景 108dp 悬浮燕 + `#FAF9F6` 纯色背景 | `translate(140, 143.6) scale(0.72)` | `mipmap-*/ic_launcher_foreground.png` 与 `drawable-v24/ic_launcher_foreground.xml`（全部顶点严格落入 66dp 安全内圆 `R ≤ 295px < 305.5px`） |

---

## 3. 色彩体系与共线几何拓扑 (Palette & Collinear Geometry)

### 3.1 品牌专色表
- **暖陶白卡面 (`bg-warm`)**：线性渐变 `(150, 0) -> (850, 1000)`，`#FFFEFC` (0%) → `#FAF9F6` (65%) → `#F0EEE8` (100%)；Android 自适应纯色底 `#FAF9F6`；圆角 `rx=225`。
- **朱砂橙主翼 (`wing-upper`)**：上折面 `#FF6538 → #EA4B20`，下折面 `#E6461D → #CC3612`。
- **琥珀金胸颈头 (`body` / `head`)**：颈首 `#F7AD2A → #FFD056`，上胸 `#FFC23D → #F5A623`，下胸 `#EB9414 → #D97E0A`，折缝微阴影 `#A65E00` (`opacity: 0.16`)。
- **钴靛蓝尾与副翼 (`tail` / `wing-lower`)**：副翼 `#19347A → #10255E`，尾羽 `#255CD1 → #193F96`。
- **青碧锋喙 (`beak`)**：`#12B0A2 → #0A857C`。
- **字标靛蓝 (`wordmark`)**：`#152854`。
- **卡面浮影 (`shadow`)**：`dx=4, dy=20, stdDeviation=18, color=#1A2233, opacity=0.17`。

> 注：以上色值为品牌资产专属真值，位于 `packages/ui/src/icons/` 下（独立于 UI 换肤面 `isSkinSurface`），换肤界面文字与容器仍必须严格遵循语义 Token，不得在皮肤页面硬编码品牌 HEX。

### 3.2 数学共线脊线（零像素缝隙保证）
中轴脊线五个关键控制点严格满足斜率共线（向量 `(−28, 118)`）：
`B(540, 338) → D(512, 456) → Q(493, 535) → G(484, 572) → H(455, 694)`。
任意子面缩放至 16px~2732px 均不产生亚像素渗色白边。

---

## 4. 动效编排与性能红线 (Motion Choreography & GPU Rules)

1. **`motion="static"`**：静止图标与静态卡片徽标（零合成器开销）。
2. **`motion="glide"`**：新会话空舞台柔和悬浮（`@keyframes fluxSwiftGlide`，运行 2 周后平稳静置，杜绝空闲期 60fps 空转）。
3. **`motion="fly"`**：冷启动、网关连接与历史加载期间展翅飞行（`@keyframes fluxSwiftFly` 滑翔路径 + `@keyframes fluxSwiftWingUpper` / `@keyframes fluxSwiftWingLower` 折翼扑动 + `@keyframes fluxSwiftTail` 尾羽微摆 + `@keyframes fluxSwiftShadow` 地面投影呼吸）。
4. **工程红线**：
   - 只驱动 GPU 合成属性 `transform` 与 `opacity`，严禁触发布局重排属性（`width`/`height`/`top`/`left`）。
   - 严禁在滚动容器 `#conversation-stream` 或 `.conv-stream` 上施加 `transform`。
   - 严禁在普通会话列表行内渲染 `<svg>`（遵守 `ActivityIndicator.tsx` 规范）。
   - 窗口隐藏（`:root[data-app-hidden="true"]` 与 `:root[data-page-hidden="true"]`）立即暂停全部关键帧并同步释放 `.flux-brand-swift[data-brand-motion="fly"] .flux-brand-swift__rotor` 的 `will-change: auto`；遵循唯一 `@media (prefers-reduced-motion: reduce)` 块退化为静止态并释放合成器图层提示。

---

## 5. 二次扩展与全端重建指南 (Extension & Regeneration)

当需要微调翅膀角度、派生深色限定版或新增平台尺寸时：
1. 编辑 [`packages/ui/src/icons/brand/brand-spec.json`](../../packages/ui/src/icons/brand/brand-spec.json)；
2. 执行 `npm run icons:gen`（驱动 `scripts/gen-app-icons.py` 重新渲染 `brandSpec.ts`、3 份矢量 SVG、Desktop `icon.{png,ico}`、iOS `AppIcon` + `Splash`、Android 15 枚 `mipmap` + VectorDrawable + 11 枚 `Splash`）；
3. 执行 `npm run build && npm run build:mobile:assets` 将新版品牌矢量与 `favicon` 同步进桌面及移动端产物；
4. 运行 `node --test scripts/__tests__/brand-icons.test.mjs packages/ui/__tests__/brand-mark.test.mjs` 验证全部像素尺寸、透明通道与向量结构契约。
