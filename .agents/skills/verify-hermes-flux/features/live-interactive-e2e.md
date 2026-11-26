# Live interactive dock cards, waiting states & MCP OAuth (`live-interactive-e2e`)

覆盖桌面端（740px 输入舱上方贴舱停靠卡 `#react-interactive-prompt-host` 与顶部后台提醒胶囊 `#react-interactive-top-pill-host`）与移动端（贴舱卡、审批模式抽屉 `MobileApprovalModeSheet`、首页/左轨等待徽章、在场指示器等待态），以及设置 › 扩展面板中的 MCP OAuth 内联授权流；所有交互卡均以非模态停靠方式存在，严禁弹出全屏对话框阻断历史消息浏览。

## Sub-features

- `clarify-dock-card`: `ClarifyCard` 在输入舱上方贴舱展示单题/多题选项列表、自由文本「其他」及逐题锁定按钮；支持折叠保留草稿与选中状态，非模态（`dialogCount === 0`），提交/跳过按钮位于同一底栏水平行（`footerRowSpread === 0`）。
- `approval-dock-card`: `ApprovalCard` 以紧凑卡片呈现命令预览与 `once` / `session` / `always` / `deny` 审批按钮，支持桌面贴舱、移动端 366px 贴舱（零横向溢出、`>= 44px` 有效触控热区）及高风险策略切换。
- `credential-connection-cards`: `CredentialPromptCard` 与 `ConnectionPromptCard` 以安全密码/外链方式就地处理 `secret` / `sudo` / `display.install.sudo` / `connection` 授权，并在日志脱敏中严格隐藏口令。
- `background-waiting-pill`: 切离存在未决交互请求的后台会话后，在顶部居中悬浮 `#react-interactive-top-pill-host` 提醒胶囊（桌面端位于在场状态下方 `below-presence` 且不重叠；移动端置于安全区与 Inspector 按钮左侧之间，点击直达对应会话）。
- `rail-and-presence-status`: 左轨分组列表（`GroupedLeftRail`）、移动端首页行（`MobileEntityRow`）与在场指示器（`AgentPresence`）准确呈现「等待回答 / 等待审批 / 等待凭据」状态，严格隔离普通会话、Bot 主工位与群聊研讨室。
- `mcp-oauth-inline`: 设置 › 扩展（`McpOAuthInlinePanel`）支持连接/取消 MCP OAuth 并持久化授权证据与真实 `reload.mcp` 重载闭环。

## How to get to it (user POV)

- 桌面端：在任意会话发送触发澄清问题、敏感终端命令审批、sudo/secret 凭据请求或连接器授权的提示词，即可在输入框正上方看到可折叠停靠卡；切换到另一会话后顶部出现后台等待提醒胶囊，点击「前往处理」跳回目标会话并恢复焦点。
- 移动端：进入对话舞台触发同类请求后在底部作曲区上方展示贴舱卡片，可切换审批模式（`MobileApprovalModeSheet`），切回首页可在对应会话行看到等待状态点，顶部提醒胶囊与右上 Inspector 按钮零重叠。
- 扩展设置：打开设置 › 扩展 › 点击支持 OAuth 的 MCP 服务「连接」按钮完成内联授权状态流转。

## Driving it with control-flux

Preconditions: `npm run build` is fresh, `node scripts/verify/control-flux.mjs doctor` passes, and when verifying against a live Hermes gateway (0.23.2+) `.env` provides `FLUX_GATEWAY_{URL,USER,PASS}` (never echo or commit `.env` values).

1. Execute interactive unit, formal, and CDP suites alongside live Blink verification:
   - Offline gate & UI verification: `npm run verify` and `npm run coverage:new`
   - Real Chromium/Blink CDP live-gateway run (driving Clarify, Approval, Background Top Pill, Mobile Stage Dock + Approval Mode Sheet, Credential/Sudo, and Settings › Extensions): captures physical screenshots and DOM/geometry metrics under `artifacts/verification/live-interactive-e2e/`.
2. Observable assertions recorded in `artifacts/verification/live-interactive-e2e/evidence.json` (`gatewayVersion: "0.23.2"`):
   - Desktop `clarify`: non-modal (`dialogCount: 0`), `cardWidth: 740`, `cardHeight: 144`, single-row footer buttons (`footerRowSpread: 0`), collapse/expand preserves draft, top pill avoids overlapping stage presence (`overlapsPresence: false`), `replyMentionsAlpha: true`.
   - Desktop & Mobile `approval`: desktop `cardWidth: 740`, `cardHeight: 117`, single-row 4 choice buttons (`footerRowSpread: 0`); mobile `cardWidth: 366`, `noHorizontalOverflow: true`, min effective touch target `44px`, mobile top pill clears inspector (`overlapsInspector: false`, `noOverflow: true`).
   - Artifacts written:
     - `artifacts/verification/live-interactive-e2e/evidence.json`
     - `artifacts/verification/live-interactive-e2e/desktop-clarify-open.png`
     - `artifacts/verification/live-interactive-e2e/desktop-clarify-settled.png`
     - `artifacts/verification/live-interactive-e2e/desktop-bg-top-pill.png`
     - `artifacts/verification/live-interactive-e2e/desktop-approval-open.png`
     - `artifacts/verification/live-interactive-e2e/mobile-approval-dock.png`
     - `artifacts/verification/live-interactive-e2e/mobile-approval-mode-sheet.png`
     - `artifacts/verification/live-interactive-e2e/mobile-bg-top-pill.png`
     - `artifacts/verification/live-interactive-e2e/desktop-credential-open.png`
     - `artifacts/verification/live-interactive-e2e/desktop-settings-extensions.png`

## Gotchas

- `artifacts/verification/` is gitignored and `desktop-clarify-open` / `mobile-approval-dock` test sessions are deleted during teardown (`cleanup.mainDeleted: true`, `cleanup.switchDeleted: true`); always rely on fresh CDP runs rather than stale local files.
- Never log, echo, or commit `.env` credentials or plain-text sudo/secret values into `evidence.json`, console logs, or PR descriptions.
- Do not call `control-flux.mjs run live-interactive-e2e` because offline `control-flux.mjs` only hosts built-in offline features; live interactive verification requires a live gateway with server-request support or headless unit/formal suites (`packages/core/__tests__/formal/interactive-prompts-formal.test.mjs`, `packages/ui/__tests__/interactive-cards-behavior.test.mjs`).
