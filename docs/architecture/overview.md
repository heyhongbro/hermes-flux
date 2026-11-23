# Hermes Flux 架构总览 (Architecture Overview)

> **定位**：本文档是 **Hermes Flux** 全平台工作台的现行架构总览，与仓库实际代码保持严格一致。

---

## 一、Monorepo 单向分层拓扑

```text
packages/desktop (Electron 34)  ──┐
packages/mobile  (Capacitor 8)  ──┼──▶ packages/ui (React 19 + Design Tokens + Styles) ──▶ packages/core (Pure TS)
```

- **`packages/core`**：纯 TypeScript 无界核心层，零 DOM / React / Electron 依赖。
  - **Gateway JSON-RPC 2.0 客户端与 WebSocket 状态机**：5 态连接生命周期（含全抖动指数退避重连与半开心跳看门狗）、服务端反向干预请求分发与下行事件归约。
  - **120FPS 流式 Token 合流引擎**：按帧合并增量推理与正文片段，避免高频事件冲击渲染层。
  - **客户端持久化缓存与多网关状态管理**：基于 `IStorage` / `IPlatformBridge` 抽象提供启动快照、尾部消息窗口与防误删围栏。
  - **纯领域模型**：三态会话模式、Profile 活动同步、群聊房间模型、模型目录与供应商绑定视图。
- **`packages/ui`**：跨端共享表现层与设计系统。
  - 承载 React 19 UI 组件、Tailwind CSS 4 与原生样式、单一真值源皮肤字典（`packages/ui/src/tokens/skins.ts`）、中英文双语字典（`packages/ui/src/i18n/`）与 Markdown 渲染器。
  - 严格禁止绕过 `core` / PAL 发起裸 `fetch`、`new WebSocket` 或调用平台私有 IPC。
- **`packages/desktop`**：基于 Electron 34 的桌面端薄壳容器（macOS / Windows / Linux），提供窗口控制、本地凭据/代理桥接、工作区文件系统能力与本地缓存持久化适配器。
- **`packages/mobile`**：基于 Capacitor 8 的移动端薄壳容器（iOS / Android），通过同构 `PlatformBridge` 复用 `packages/ui` 与 `packages/core`（详见 [`capacitor-mobile-bridge-spec.md`](./capacitor-mobile-bridge-spec.md)）。

---

## 二、核心子系统规范索引

| 子系统 | 规范文档 | 核心内容 |
|---|---|---|
| **三态对话模型** | [`three-conversation-modes-spec.md`](./three-conversation-modes-spec.md) | 普通会话、专职 Bot 终身主工位、多 Agent 群聊研讨室的物理隔离与 RPC 分流 |
| **三舱与左双轨导航** | [`ultimate-tri-rail-architecture-spec.md`](./ultimate-tri-rail-architecture-spec.md) | Folder / Workspace / Project / Bot / Group / Session 实体模型与三舱布局 |
| **网关与客户端交互协议** | [`gateway-client-interaction-protocol.md`](./gateway-client-interaction-protocol.md) | 连接生命周期、双 ID 语义、六大场景时序与增量对齐矩阵 |
| **官方网关契约索引** | [`../gateway/README.md`](../gateway/README.md) | 由 OpenRPC 契约与真实网关探针自动生成的各模块接口文档 |
| **客户端缓存设计** | [`client-cache-and-multi-client-sync-spec.md`](./client-cache-and-multi-client-sync-spec.md) | 启动快照与尾部消息缓存、围栏机制、截断与离线策略（接口手册见 [`../api/client-cache.md`](../api/client-cache.md)） |
| **多网关配置与无感连接** | [`client-settings-and-multi-gateway-cache-spec.md`](./client-settings-and-multi-gateway-cache-spec.md) | 分桶配置命名空间、多网关隔离与冷启动静默连接状态机 |
| **设计系统与皮肤引擎** | [`theme-engine-spec.md`](./theme-engine-spec.md) | 43 语义槽皮肤契约、生成链与 [`../design-system/README.md`](../design-system/README.md) 视觉总纲 |
| **动效与宿主隔离** | [`motion-system-and-host-isolation-spec.md`](./motion-system-and-host-isolation-spec.md) | 跨端动效状态机、Version CAS 与 Grid 折叠契约 |
| **工程门禁与测试体系** | [`../quality-gates.md`](../quality-gates.md) | 静态门禁、增量覆盖、形式化不变量证明（`fast-check`）与变异验证（详见 [`../testing-strategy.md`](../testing-strategy.md)） |
