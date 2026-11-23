# grouped-left-sidebar-and-new-chat · 桌面端分组左侧栏与新版新建会话弹窗

## 1. 启动

前置构建（必需）：

```bash
npm run build
```

驱动与单元回归入口：

```bash
node --test packages/desktop/__tests__/cdp/grouped-left-sidebar-cdp.test.mjs
npm test
npm run gates:changed
```

## 2. 驱动与视觉矩阵

| 场景 | 外观设置 / 模式 | 核心断言重点 |
|---|---|---|
| `grouped-expanded` | `leftRailLayout = 'grouped'`, `leftRailCollapsed = false` | 无 `#flux-station-rail` 微轨；顶部同排呈现 32px 纯哑光胶囊搜索框与圆形 `#rail-grouped-new-chat-btn`；顺序恒为 **BOT → 群聊 → 普通会话**，标题无数量数字，`sessions` 标题无状态动画 |
| `grouped-collapsed` | `leftRailLayout = 'grouped'`, `leftRailCollapsed = true` | 左栏彻底收拢为 `0px`，`.titlebar-left` 让出交通灯/全局图标宽度，`.titlebar-center` 按左右对称居中 |
| `grouped-accordion-collapse` | 点击 `#rail-bots-accordion-trigger` 折叠 BOT 分组 | `.flux-grouped-section__body` 平滑收起且 `visibility: hidden` 阻止键盘聚焦落入隐藏项；仅当含运行中条目时标题右侧点亮状态动画 |
| `new-chat-dialog` | 点击 `#rail-grouped-new-chat-btn` 或快捷键触发 `isNewTaskModalOpen = true` | 两步极简弹窗（无名称与开场白输入框）：第一步选 Agent 点击即创建生效，底部入口切第二步多选 ≥2 位 BOT 后确认建群并自动派生群名；断线或创建失败时保留弹窗严禁误发入旧会话 |
| `dual-rail-regression` | 设置 → 外观 → 切回「双轨分栏 (`dual-rail`)」 | `#flux-station-rail` 完整恢复，折叠态保留微轨且行为零回归 |

## 3. 断言（Binding 不变量）

| 断言 | 不变量 |
|---|---|
| `dualModeSwitchPersisted` | 设置 → 外观切换 `hermes_flux_left_rail_layout`，冷启动刷新后维持选定布局模式 |
| `crossBotSessionInheritance` | `grouped` 模式下普通会话跨 Bot 全量展示，继承归属 Bot 圆形头像；严格过滤 `hidden` 与 `isSubagent`（主工位/子代理隔离） |
| `rowComponentUnified` | 三类实体统一渲染为 `RailEntityRow`，满足 4px 整数网格与语义 Token |
| `offlineSubmitNoLeak` | `gatewayConnected === false` 或 `createNewSession` 返回 `null` 时，`routeSend` / `sendGroupMessage` 绝对不触发，且弹窗草稿不丢失 |
| `zeroContrastCollapse` | 浅色皮肤（含 `jade-white` / `ayu-light`）下 `NewChatDialog` 预览卡（`Surface raised`）、内嵌列表（`bg-input`）与空态说明文字（`text-muted-foreground`）层次清晰 |

## 4. 产物与清理

- `artifacts/verification/grouped-left-sidebar-and-new-chat/screenshot.png`（`grouped-expanded` 主工作台全屏截图）
- `artifacts/verification/grouped-left-sidebar-and-new-chat/new-chat-dialog-solo.png`（新版新建会话第一步 Agent 选角列表截图 · 深色皮肤）
- `artifacts/verification/grouped-left-sidebar-and-new-chat/new-chat-dialog.png`（新版新建群聊第二步多选成员截图 · 深色皮肤）
- `artifacts/verification/grouped-left-sidebar-and-new-chat/new-chat-dialog-light.png`（新版新建群聊第二步多选成员截图 · `jade-white` 浅色皮肤双对比度取证）
- `artifacts/verification/grouped-left-sidebar-and-new-chat/grouped-collapsed.png`（`grouped` 模式 0px 折叠态截图）
- `artifacts/verification/grouped-left-sidebar-and-new-chat/evidence.json`（5 场景真实 Blink DOM / 计算样式 / 悬停实测断言证据）
- 清理：CDP 浏览器与临时 `user-data-dir` 随 `t.after` 自动清理；`artifacts/verification/` 证据文件保留。
