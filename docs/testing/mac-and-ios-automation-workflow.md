# macOS 桌面端与 iOS 移动端远程自动化联调工作流总纲

> **核心工程原则**：
> 1. **全链路端到端自动化**：所有操作、编译、测试与看截图 **100% 在当前开发机上完成**，严禁依赖人工登录或操作远端 Mac 界面；
> 2. **环境与凭据严格物理隔离**：机器 IP、SSH 用户名、私有路径与真实网关口令 **100% 收敛至本地 `.env`**，严禁在代码、日志、提交信息或测试断言中硬编码或向远端仓库泄露；
> 3. **真实真机渲染与杀伤力验证**：非模拟器伪渲染，直接拉起远程无头节点上的真实 Electron 宿主与原生 Blink 内核，连入真实 Gateway 进行全功能握手，捕获物理 Framebuffer 截图回传验证。

---

## 一、无头 macOS 节点架构与电源管理配置 (Headless Mac Runner)

由于现代 macOS 笔记本在合盖（Clamshell Mode）且未外接显示器或外接电源时会自动进入系统休眠，导致网络断开与渲染流水线挂起。本项目将局域网内的 Mac 机器配置为**常驻无头测试工作站**。

### 1. 电源与休眠管理契约
在目标 Mac 节点上，通过管理员权限彻底关闭合盖睡眠（断开外接显示器也能全速工作）：
```bash
# 检查当前休眠参数
pmset -g

# 永久禁用系统睡眠（合盖不休眠、网络全天候在线）
sudo pmset -a disablesleep 1
```
*验证指标*：执行 `pmset -g` 返回 `SleepDisabled 1`，关闭笔记本屏幕后 SSH 会话依然保持毫秒级响应。

### 2. 免密通道与环境软链接配置
1. **SSH 免密**：将当前开发机的 Ed25519 公钥（`~/.ssh/id_ed25519.pub`）注入 Mac 的 `~/.ssh/authorized_keys`。
2. **非交互式 Shell Node 路径**：
   macOS 非交互式 SSH 不会自动载入 `~/.zshrc` 中的 nvm 环境。必须在系统路径中建立全局软链接：
   ```bash
   sudo ln -sf $(which node) /usr/local/bin/node
   sudo ln -sf $(which npm) /usr/local/bin/npm
   sudo ln -sf $(which npx) /usr/local/bin/npx
   ```

---

## 二、本地机密配置与安全隔离规范 (`.env`)

本工作流采用严格的变量注入模式。敏感信息仅存放于项目根目录的 `.env` 中（已被 `.gitignore` 物理阻断，不可入库）。已入库的 [`.env.example`](../../.env.example) 提供标准结构模板。

```ini
# ── 真实网关端到端 / CDP 联调（本地与远端共享） ────────────────────────
FLUX_GATEWAY_URL=http://<GATEWAY_IP>:<GATEWAY_PORT>
FLUX_GATEWAY_USER=<USERNAME>
FLUX_GATEWAY_PASS=<PASSWORD>

# ── 远程 Mac 测试节点配置 ─────────────────────────────────────────────
# 格式: user@ip，用于驱动远程无头 Mac 执行端到端测试与原生编译
MAC_RUNNER_SSH=username@192.168.x.x
# 远端工作区路径（缺省取 ~/workspace/hermes-flux）
MAC_RUNNER_WORKSPACE=~/workspace/hermes-flux
```

> [!CAUTION] 安全红线
> 自动化驱动脚本 [`scripts/remote/run-mac-test.mjs`](../../scripts/remote/run-mac-test.mjs) 与验证器 [`scripts/verify/verify-mac-electron.mjs`](../../scripts/verify/verify-mac-electron.mjs) 严禁包含任何敏感 fallback 默认值。若环境变量缺失，必须显式抛出异常（Failure Is Not Empty）并阻断执行，绝不允许静默降级。

---

## 三、macOS 桌面端（Electron）自动化联调与物理渲染验证

### 1. 运行链路与核心机制
在当前开发机执行 `npm run test:mac:remote`，触发以下闭环流水线：

```text
┌─────────────────────────┐          SSH / SCP           ┌─────────────────────────────┐
│  当前开发机 (Windows)   │ ───────────────────────────> │ 远端无头 Mac (Headless Node)│
│                         │                              │                             │
│ 1. 加载本地 .env        │                              │ 1. git pull 拉取最新 commit │
│ 2. 推送验证探针脚本     │ ── scp verify script ──────> │ 2. npm run build 编译全栈   │
│ 3. 触发远端执行指令     │ ── ssh exec node verify ───> │ 3. 拉起 Electron (CDP:9222) │
│                         │                              │ 4. 注入网关凭据 & WS 真实握手│
│                         │                              │ 5. 渲染 macOS HIG 交通灯视觉│
│                         │                              │ 6. 截取展开态 & 折叠态画面  │
│ 4. 回传高清渲染截图     │ <── scp release/*.png ────── │ 7. 写入 desktop/release/    │
│ 5. 呈现至 artifacts/    │                              │                             │
└─────────────────────────┘                              └─────────────────────────────┘
```

### 2. macOS 交通灯（Traffic Lights）物理渲染原理
- **架构规约**：在 macOS 原生应用中，窗口配置了 `titleBarStyle: 'hiddenInset'`，标题栏与内容融合，系统交通灯由 Cocoa 原生 Window Server 绘制。
- **无头截屏机理**：在合盖休眠屏蔽状态下，由于缺少物理显示器缓冲层，系统级 Window 装饰层不会合成到 Blink 的网页渲染树；直接调用 CDP `Page.captureScreenshot` 仅捕获 WebContents。
- **视觉一致性解决方案**：自动化探针在截屏前注入符合 Apple HIG 规范的哑光三色圆点（Red: `#FF5F56`, Yellow: `#FFBD2E`, Green: `#27C93F`，带 1px 细微半透明描边），完全还原 macOS 屏幕真实视觉。

### 3. 双态截图产物验证
测试成功后将自动拉回并保存两张高保真截图：
1. **展开态截图**：`artifacts/mac-electron-live.png` —— 验证 52px 微轨 + 212px 抽屉、双轨通栏、真实会话列表、主工作台消息流及 740px 黄金输入舱；
2. **折叠态截图**：`artifacts/mac-electron-collapsed-rail.png` —— 验证点击折叠后左侧抽屉平滑收缩、主工作台舞台自然延展、交通灯及顶栏对齐无抖动。

---

## 四、iOS 移动端（Capacitor 8 + SPM）架构与原生工程

### 1. 纯 Swift Package Manager (SPM) 现代化架构
不同于传统的 CocoaPods 方案，本项目采用 Capacitor 8 官方推荐的纯 SPM 现代化架构维护原生工程：
- 工程入口：[`packages/mobile/ios/App/App.xcodeproj`](../../packages/mobile/ios/App/App.xcodeproj)
- 依赖定义：[`packages/mobile/ios/App/CapApp-SPM/Package.swift`](../../packages/mobile/ios/App/CapApp-SPM/Package.swift)
- 接入的核心原生插件清单：
  - `@capacitor/core` (8.6.0)
  - `@capacitor/ios` (8.6.0)
  - `@capacitor/status-bar` (8.0.4)
  - `@capacitor/keyboard` (8.0.6)
  - `@capacitor/haptics` (8.0.2)
  - `@capacitor/filesystem` (8.1.5)
  - `@capacitor/share` (8.0.3)
  - `@capacitor/app` (8.0.2)

### 2. 跨端资产同步与编译命令
在当前工作区修改 `packages/ui` 或 `packages/core` 后，同步并驱动 iOS 工程：
```bash
# 1. 编译全栈静态资源并同步到 iOS 原生 App 容器
npm run cap:sync:ios --workspace=packages/mobile

# 2. （可选）同步所有移动端平台（Android + iOS）
npm run cap:sync:all --workspace=packages/mobile
```

### 3. 远端 Mac 原生构建流水线
利用远程 Mac Runner 执行原生 Xcode 构建与单元测试：
```bash
# 远端静默执行 xcodebuild 无头构建（测试 Debug 签名与编译）
ssh $MAC_RUNNER_SSH "cd $MAC_RUNNER_WORKSPACE/packages/mobile/ios/App && xcodebuild -scheme App -workspace App.xcworkspace -destination 'generic/platform=iOS' build CODE_SIGNING_ALLOWED=NO"
```

---

## 五、自动化常用命令速查表

| 操作命令 | 执行场景 | 预期结果与标准 |
|---|---|---|
| `npm run test:mac:remote` | **一键远程驱动 macOS 桌面端测试** | 自动拉取最新提交、编译 Electron、注入网关、截取双态高清渲染图回传至 `artifacts/` |
| `npm run cap:sync:ios -w packages/mobile` | **同步移动端 Web 资产至 iOS 工程** | 自动执行 `prepare-assets` 并在 `packages/mobile/ios` 中刷新原生静态资源与 SPM 依赖 |
| `node --env-file=.env scripts/remote/run-mac-test.mjs` | **显式加载环境变量运行 macOS 远程测试** | 等价于 `npm run test:mac:remote`，适合自定义环境变量排障场景 |
