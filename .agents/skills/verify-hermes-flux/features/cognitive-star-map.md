# Cognitive star map & skill topology

桌面端（设置 › BOT › 记忆页签与状态栏「记忆」直达按钮）与移动端（Inspector 记忆页与 Bot Hub 记忆子页）共享同一 `CognitiveStarMapPanel` 组件：严格按 `targetProfile` 物理隔离加载每个数字员工专属记忆图谱（REST `/api/learning/graph?profile=...` 优先，拒绝非 `default` Bot 回落无 `profile` 的 WS `learning.frames`），取消分页完整呈现节点、技能关联连线（`skill-link` / `mention`）与调用次数（`xN`），支持缩放平移、下方可搜索/排序的技能列表以及 `w-modal-xl` 大号双视图详情弹窗。

## Sub-features

- `profile-isolation-fence`: 切换 Bot 时优先校验 `learningState.profile === targetProfile` 并校验 REST 返回 `profile` 一致性，不一致立即阻断旧图显示；REST 404 时仅 `default` 回落 WS `learning.*`，其它 Bot 回落 `profiles.describe({ profile })` + `complete.slash`（只取 `kind === 'skill'` 与 `text`）。
- `full-zoomable-constellation`: 取消窄屏分页，基于 `layoutFullConstellationGraph` 确定性排布全部节点（零重叠硬碰撞约束 + 缩放/拖拽/滚轮/双指捏合/聚焦动画）。
- `skill-list-and-xl-detail`: 图谱下方随 Bot 切换重置搜索与排序（`uses`/`links`/`name`）展示完整技能列表；点击打开 `xl` 大号详情窗（移动端显式避让安全区 + `>=44px` 热区 + 阻断 Portal 误滑），共享 `SkillMarkdownView` 呈现 `rendered`/`raw` 双视图与关联技能跳转。

## How to get to it (user POV)

- 桌面端：1) 右侧会话状态栏点击 `[data-testid="status-open-constellation-btn"]` 直达对应 Bot 的记忆页；2) 设置 › BOT › 点击第 6 个页签 `[data-bot-tab="constellation"]` 或基本页只读卡上的「记忆」按钮。
- 移动端：1) Inspector 顶栏切换到记忆页；2) Bot Hub › 选择目标 Bot › 进入「记忆与学习」子页。

## Driving it with control-flux

Preconditions: `npm run build` is fresh, `node scripts/verify/control-flux.mjs doctor` passes.

1. Run `node scripts/verify/control-flux.mjs run bot-config-center`.
   Observable: Step 5b 切换到 `[data-bot-tab="constellation"]`，验证 `[data-testid="desktop-constellation-panel"]` 的 `data-profile="arch"`、全部节点一次性渲染（零分页）、技能列表项可见，点击技能项打开 `[data-constellation-detail-dialog="true"]`（宽 `> 700px` 且含 `[data-skill-markdown-rendered="true"]`），关闭后在 `artifacts/verification/bot-config-center/` 生成 `screenshot.png` 与 `evidence.json`。

## Gotchas

- `scripts/verify/control-flux.mjs` 行数上限登记在 `scripts/gates/rules/maintainability.mjs`（`max: 1701`），扩展断言需保持紧凑，勿新增冗余空行。
- 非 `default` Bot 在旧版网关（REST 404）下禁止执行 `learning.edit` / `learning.delete` 写操作，否则会静默修改 `default` Bot 记忆，客户端已显式拒绝并给出 `profileWriteUnsupported` 提示。
