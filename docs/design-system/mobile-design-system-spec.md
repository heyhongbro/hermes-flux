# Hermes Flux 移动端设计系统与交互规范 (Mobile Design System Spec v1.0)

> **适用范围**：Android（首发）、iOS 与移动端窄屏 Web 壳层 (`@hermes-flux/ui/mobile` + `@hermes-flux/mobile`)。  
> **核心工程原则**：底层 `@hermes-flux/core` 状态机、网关 RPC 与桌面端渲染域服务（`SessionOperationService` / `GroupOperationService` / `TurnExecutionService` / `SettingsDataService`）100% 同构共享；移动端仅在最上层替换表现壳，同时物理隔离桌面窗控，遵循与桌面同源的新极客精准美学。

---

## 一、纯哑光双皮肤体系 (Pure Matte Dual-Skin System)

移动端裁剪桌面端多套皮肤，只保留两套纯平哑光皮肤并支持跟随系统自动切换：
1. **深邃哑光黑 (`dark` ➔ `obsidian-gold`)**：纯平深曜石界面表面阶梯（L0 `--background` / L1 `--panel` / L2 `--card` / L3 `--card-hover`），主色调为纯净高对比白；
2. **纯净浅白 (`light` ➔ `jade-white`)**：中性浅灰白画布（`#F8F9FA`）配纯白悬浮卡片（`#FFFFFF`）与深碳黑文字，彻底消除偏黄纸感。

**纯哑光硬件视觉铁律**：
- 移动端所有按钮、胶囊与卡片在静息与按压态**严禁使用发光边框 (`box-shadow` 光晕)、顶部高光描边 (`inset 0 1px 0`) 或渐变高光背景**；
- 顶部悬浮控制群与分组卡片可使用极轻环境微距投影（`var(--shadow-card)` / `var(--shadow-dock)`）配 `1px` 微距发丝线（`var(--border-subtle)`），保持至少 `44×44px` 触控热区与通透呼吸感。

---

## 二、三屏连续 1:1 跟手横向画布 (Continuous 3-Screen Pager)

移动端彻底取消底部 TabBar 与桌面三栏，采用 `300%` 宽度的横向连续轨道（支持手指 1:1 跟手拖拽与速率惯性判定，`cubic-bezier(0.22, 1, 0.36, 1)` 平滑落位，边缘带 `0.28` 阻尼橡皮筋）：
1. **左屏 — 会话列表首屏 (`home`)**：全域聚合 `智能体`、`群聊`、`普通会话`；
2. **中屏 — 无顶栏沉浸对话舞台 (`stage`)**：默认落屏目标（连线/选中会话即进入对话）；
3. **右屏 — 无顶栏单栏检查舱 (`inspector`)**：产出成果物、Git 变更、工作区文件与记忆/成员视图。

**手势正交豁免**：代码块与横向可滚动 Diff 视图必须声明 `touch-action: pan-x pan-y` 并标记 `data-gesture-ignore="pan-x"`，防止左右查看长代码时误触发切屏。

---

## 三、首屏双视图、顶部悬浮控件与分级导航 (Floating Topbar, Bot Hub & Settings IA)

### 1. 顶部悬浮控制群
所有顶部操作放弃传统实底矩形顶栏，全部改用绝对定位悬浮圆角胶囊（下方滚动内容可透出顶部柔和渐变遮罩）：
- **左上悬浮分段胶囊 (`[对话 ⇄ Bot]`)**：在「对话列表」与「Bot Hub」双主视图间秒切；
- **右上悬浮圆形图标钮**：
  - 对话列表下呈现 `[搜索]`、`[＋ 新建对话]`、`[⚙ 设置]`；
  - Bot Hub 下呈现 `[＋ 新建 Bot]`、`[⚙ 设置]`；
- **二三级详情页 (`MobileFloatingBackBar`)**：统一左上圆形悬浮返回钮 + 居中轻标题。

### 2. 左屏视图 B：Bot Hub (`MobileBotHubScreen` & `MobileBotSubpage`)
- **顶部对称头像轮播 (`buildBotCarouselWindow`)**：居中高亮展示当前 Bot `96px` 头像、名称、默认模型及「进入主工位对话」按钮，左右呈淡化相邻 Bot 头像（点按切换焦点）；
- **Bot 专属分级菜单**：模型绑定、`SOUL.md`、身份档案与人设；能力与集成（技能 / 工具集 / MCP）；知识与记忆（终身工位物理隔离说明），全部点击下钻独立全屏子页。

### 3. 设置中心分级菜单 (`MobileSettingsPage`)
设置中心只承载**跨 Bot 全局系统与提供方配置**（禁止堆砌平铺表单与具体 Bot 细节）：
- **一级入口**：分组卡片菜单（「系统与外观」→ 外观、字体与语言；「连接与模型服务」→ 网关连接 / 模型提供商；「扩展与关于」→ 全局扩展概览 / 关于）；
- **二级子页**：每个菜单点入后全屏展开对应配置页，其中「模型提供商」直接复用共享 `ProvidersAdminPanel`。

### 4. 首屏对话列表：三段可折叠无分割线列表
- **整体融合**：列表表面**完全去除分割线**，依靠 L0/L2 表面微差与行距建立视觉节奏；
- **固定排布顺序**：
  1. **智能体**（专职数字员工终身主工位，`hidden=1`，受物理保护严禁删除）；
  2. **群聊**（多智能体协同研讨室，`hosted_rooms`，通信严禁走 `prompt.submit`）；
  3. **普通会话**（随用随扔的排查会话，**头像强制使用归属 Bot 的头像** `renderBotAvatar`）。
- **分组头部语义**：
  - 三个大标题右侧**严禁显示数量数字**；
  - 展开/折叠采用 CSS Grid `grid-template-rows: 0fr ↔ 1fr` 平滑过渡，禁止 `display: none` 硬切，折叠态写入本地持久化；
  - `智能体` 与 `群聊` 仅在**折叠态且组内存在运行中条目**时在标题右侧显示 `prolate-lattice` 旋转点阵 + 对应状态词；**`普通会话` 分组标题恒不显示状态动画**（仅具体会话行自身展示运行态）。
- **单一可复用行组件 (`MobileEntityRow`)**：
  - 所有实体行共享同一几何与排版结构：左侧头像（Bot 圆形 / 群聊成员拼贴 / 普通会话归属 Bot 头像）、中部标题 + 单行摘要、右侧 `[ 30×16 prolate-lattice 旋转点阵 + 状态词（思考中/协同中/执行中 或 新回复）] + tabular-nums 时间`；
  - 长按会话/群聊/智能体唤起纯哑光底部操作面板（按三态隔离原则裁剪可执行动作）。

---

## 四、即发新建会话 Page Sheet (Instant New Chat Sheet)

对标极简移动输入模型：点击首屏 `＋` 后，底层画布等比微缩下沉 (`scale(0.935)`)，上方弹出大圆角 Page Sheet：
1. **顶部栏**：居中拖拽短条 + 左上角 `[ 头像 智能体名 ⌄ ]` 切换胶囊；
   - 点击胶囊展开智能体列表，底部提供「**发起多智能体群聊 ›**」入口；
   - 选择发起群聊时，面板内部**横向平滑推入第 2 步多选 Bot 页**，勾选≥2 个参会成员并可自定义群名称后确认返回第 1 步；
2. **中部居中留白舞台**：展示选中 Bot 的 `78px` 圆形大头像（或群聊成员拼贴矩阵）、名称、一句话简介（无简介显示淡色占位）与能力摘要（`Plugins · MCP · Skills`）；
3. **底部直接输入发送**：直接放置变形输入胶囊，输入首条消息点击发送即自动调用后端创建单聊会话或群聊房间并平滑推进中屏 `stage`。

---

## 五、无顶栏对话舞台、轨迹折叠与变形输入舱 (Headerless Stage, Compact Trace & Morphing Composer)

### 1. 无顶栏头部在场指示
- 对话舞台**彻底移除顶部导航条**，上方覆盖轻柔渐变遮罩并在安全区下方居中挂载共享 `AgentPresence`（圆形眨眼头像 / 群聊多头像栈 + 实时状态短句）；
- 监听消息流滚动方向：向上回溯历史时平滑收敛为紧凑悬浮小药丸，贴底或流式新消息到达时舒展恢复。

### 2. 移动端轨迹与子代理折叠策略
- **思考与多步工具调用**：在同一条助手消息内合并为单行 `33px` 纯哑光摘要胶囊（如 `思考与执行中…` 或 `已思考 1.8s · 执行 3 步操作 ›`），点击通过 `grid-template-rows: 0fr ↔ 1fr` 平滑展开思考文本与紧凑工具列表；折叠态下 DOM 锚点 `#msg-thought-*` 与 `#msg-tools-*` 始终保持挂载以确保 120 FPS 流式直写零丢帧；
- **子代理委派 (`delegate_task` / `subagent` / `ask_side_agent`)**：收敛为独立 `42px` 叠放头像状态条，点击弹出底部子代理详情抽屉查看详细任务输入/输出流或执行中断。

### 3. 底部变形输入舱 (`MobileMorphingComposer`)
- **默认收起态**：`46px` 单行纯哑光胶囊（左 `+` 附件钮，中单行输入框/占位符，右发送/停止圆形实心钮）；
- **聚焦/内容展开态**：平滑过渡为双层纯哑光输入卡——上层多行自适应 `<textarea>`，下层左侧 `[+]` 附件按钮与 `[Model ▾]` 模型选择胶囊（点击唤起纯哑光模型选择面板），下层右侧发送/停止圆钮；通过 `--m-bottom-inset`（`max(env(safe-area-inset-bottom, 0px), var(--keyboard-height, 0px))`）自动避让安全区与软键盘。

---

## 六、Android 与 iOS 跨端平台适配契约 (Mobile PAL Contract)

| 平台能力 | Android（首发） | iOS（架构就绪） |
|---|---|---|
| **系统安全区** | `viewport-fit=cover` + `env(safe-area-inset-top/bottom)` | 同左（适配灵动岛与 Home Indicator） |
| **物理返回 / 手势返回** | `@capacitor/app` 监听 `backButton` ➔ 派发 `hermes-mobile-back` 沿 10 层 UI 栈逐级退回，首屏根态才调用 `App.minimizeApp()` | iOS 边缘右滑返回消费 `reduceMobileBackAction` 状态机（检查舱 ➔ 对话 ➔ 首屏 / 设置页退回） |
| **系统状态栏皮肤同步** | `@capacitor/status-bar` 随双皮肤切换自动设置 `Style.Dark` / `Style.Light` 与顶底栏极性 | 同左（`overlaysWebView: true` + 动态前景色同步） |
| **软键盘避让** | `android:windowSoftInputMode="adjustResize"` + Capacitor 8 `SystemBars` 原生缩放 WebView 视口，bridge 锁死 `--keyboard-height: 0px`（仅当原生未缩放时兜底补差） | `KeyboardResize.None` + `--keyboard-height`，通过 `--m-bottom-inset: max(env(safe-area-inset-bottom, 0px), var(--keyboard-height, 0px))` 精准跟手上抬 |
