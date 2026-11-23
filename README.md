# Hermes Flux

> **Cross-Platform Workspace for Hermes Agent**  
> 面向 Hermes Agent 的全平台极客美学工作台（Desktop · iOS · Android）

---

## 核心特性

- **三态会话正交隔离**：普通会话（Scratchpad）、专职数字员工终身主工位（Bot Forever Chat）与多 Agent 群聊研讨室（Group Room）各自独立存储与协议分流，互不污染上下文。
- **左双轨 + 三舱工作台**：56px 紧凑微轨 + 自适应抽屉导航、通栏对话流与 740px 黄金输入舱、右侧 410px 多模态检查舱。
- **单一真值设计系统与多端皮肤**：基于 43 语义槽契约（`packages/ui/src/tokens/skins.ts`），支持 `obsidian-gold`、`ayu-dark`、`ayu-light` 等多套高质感皮肤与中英文双语切换。
- **高可靠通信与启动快照缓存**：JSON-RPC 2.0 双向通信、5 态 WebSocket 连接状态机、120FPS 流式 Token 合流与离线可读启动快照缓存。
- **可证明的工程门禁体系**：静态架构/换肤/i18n/性能门禁、`fast-check` 形式化不变量证明、网关契约校验与变异自证。

---

## Monorepo 结构

```text
hermes-flux/
├── packages/
│   ├── core/       # 纯 TypeScript 无界核心层（JSON-RPC、WS FSM、Token 合流、缓存与领域模型）
│   ├── ui/         # 跨端共享 React 19 UI 组件、Design Tokens、样式与双语字典
│   ├── desktop/    # Electron 34 桌面端宿主（Windows / macOS / Linux）
│   └── mobile/     # Capacitor 8 移动端宿主（iOS / Android）
├── scripts/        # 自动化门禁（gates）、网关契约校验（contract）与渲染验证工具
├── docs/           # 现行架构规范、设计系统规范与自动生成的网关接口文档
└── .agents/        # 通用 Agent 角色规范、工作流命令与验证技能
```

---

## 快速开始

### 环境要求

- **Node.js** `>= 22.18.0`
- **npm**（仓库使用 `package-lock.json` 作为唯一权威锁文件）

### 安装与构建

```bash
npm ci
npm run build
```

### 启动桌面端

```bash
npm --workspace=@hermes-flux/desktop run start
```

如需接入真实 Hermes Gateway，请将根目录 [`.env.example`](.env.example) 复制为 `.env` 并填写网关地址与凭据（`.env` 已被 `.gitignore` 忽略，严禁提交到版本库）。

### 运行全套质量门禁与测试

```bash
npm run verify
```

---

## 文档索引

- [架构总览 (Architecture Overview)](docs/architecture/overview.md)
- [三态对话模型规范](docs/architecture/three-conversation-modes-spec.md)
- [官方网关协议映射矩阵](docs/architecture/gateway-api-and-features-matrix.md)
- [单一真值皮肤系统规范](docs/architecture/theme-engine-spec.md)
- [极客美学设计系统总纲](docs/design-system/README.md)
- [项目研发路线图](docs/roadmap.md)
- [工程纪律与质量门禁](ENGINEERING_DISCIPLINE.md)
