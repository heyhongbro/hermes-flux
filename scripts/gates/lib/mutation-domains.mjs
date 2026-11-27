/**
 * 变异测试领域注册表（Mutation Domains Registry）
 *
 * 【设计意图 (Why)】
 *   全量 Core 包含 15,000+ 变异体，直接全量运行耗时过长。
 *   按业务领域（Domain）划分为可独立执行、独立度量的变异单元，
 *   使老存量代码能够分阶段、分批次推进变异消减，每个领域运行时间控制在 10~60 秒内。
 */

export const MUTATION_DOMAINS = {
  cache: {
    title: '缓存合并状态机 (Cache Merge FSM)',
    mutate: ['packages/core/src/cache/cacheMerge.ts'],
    testFiles: [
      'packages/core/__tests__/cache/cache-merge.test.mjs',
      'packages/core/__tests__/cache/cache-edge-cases.test.mjs',
      'packages/core/__tests__/cache/cache-display-order.test.mjs',
      'packages/core/__tests__/formal/cache-fence-formal.test.mjs',
    ],
    buildCommand: 'npm run build:core',
    minScore: 70,
  },
  coalesce: {
    title: 'Token 流式合流引擎 (Token Coalescing Engine)',
    mutate: ['packages/core/src/coalesce/tokenCoalescer.ts'],
    testFiles: ['packages/core/__tests__/coalesce/tokenCoalescer.test.mjs'],
    buildCommand: 'npm run build:core',
    // 实测 136 mutant / 99 killed / 9 timeout / 28 survived / 0 noCov = 79.41%（2026-11-25），门禁锁 ≥75%
    minScore: 75,
    targetScore: 75,
  },
  session: {
    title: '会话生命周期与截断合并 (Session Merge & Truncate Plan)',
    mutate: [
      'packages/core/src/session/sessionMerge.ts',
      'packages/core/src/session/truncatePlan.ts',
    ],
    testFiles: [
      'packages/core/__tests__/session/session-merge.test.mjs',
      'packages/core/__tests__/session/session-truncate-plan.test.mjs',
      'packages/core/__tests__/formal/session-lifecycle-formal.test.mjs',
    ],
    buildCommand: 'npm run build:core',
    minScore: 65,
  },
  rpc: {
    title: '网关连接 5 态状态机 (Gateway Connection FSM)',
    mutate: ['packages/core/src/rpc/fsm.ts'],
    testFiles: [
      'packages/core/__tests__/rpc/ws-fsm.test.mjs',
      'packages/core/__tests__/formal/ws-fsm-formal.test.mjs',
    ],
    buildCommand: 'npm run build:core',
    minScore: 70,
  },
  viewport: {
    title: '会话视口记忆与基准行高 (Session Viewport Memory & Median)',
    mutate: [
      'packages/core/src/viewport/sessionScrollMemory.ts',
      'packages/core/src/viewport/adaptiveMedianEstimator.ts',
    ],
    testFiles: [
      'packages/core/__tests__/viewport/sessionScrollMemory.test.mjs',
      'packages/core/__tests__/viewport/adaptiveMedianEstimator.test.mjs',
      'packages/core/__tests__/formal/session-scroll-memory-formal.test.mjs',
      'packages/core/__tests__/formal/viewport-estimator-formal.test.mjs',
    ],
    buildCommand: 'npm run build:core',
    // 实测 126 mutant / 123 killed / 3 survived = 97.62%（2026-11-17，本机）。
    // 剩余 3 个经人工核对：maxEntries 恒 ≥1 使 `if (oldestKey)` 为等价守卫；
    // 另两处为三元方向性等价变异，不改变可观测行为。
    minScore: 90,
  },
  codeCopy: {
    title: '代码块复制委托 (Markdown Code Block Copy)',
    mutate: ['packages/ui/src/lib/codeCopy.ts'],
    testFiles: ['packages/ui/__tests__/code-copy.test.mjs'],
    buildCommand: 'npm run build:ui',
    minScore: 80,
  },
  streamWriter: {
    title: '流式 Token 写入与贴底跟随 (Token Stream Writer)',
    mutate: ['packages/desktop/src/renderer/stream/tokenStreamWriter.ts'],
    testFiles: ['packages/desktop/__tests__/unit/tokenStreamWriter.test.mjs'],
    buildCommand: 'node scripts/gates/build-desktop-unit.mjs src/renderer/stream/tokenStreamWriter.ts',
    // 实测 194 mutant / 169 killed / 23 survived / 2 noCov = 87.11%（被测 88.02%，2026-11-25）
    minScore: 80,
  },
  streamViewport: {
    title: '流视口占位高度去重与中性补偿 (Stream Viewport Intrinsic)',
    // 分段必须覆盖本次逻辑的全部输入与输出契约：
    // 190-215 上限常量、455-540 淘汰与采样去重、570-760 变量写入/中性补偿/锚点采集
    mutate: [
      'packages/desktop/src/renderer/viewport/streamViewportManager.ts:190-217',
      'packages/desktop/src/renderer/viewport/streamViewportManager.ts:483-571',
      'packages/desktop/src/renderer/viewport/streamViewportManager.ts:601-791',
    ],
    testFiles: [
      'packages/desktop/__tests__/unit/stream-viewport-manager.test.mjs',
      'packages/desktop/__tests__/unit/stream-viewport-interactive.test.mjs',
    ],
    buildCommand:
      'node scripts/gates/build-desktop-unit.mjs src/renderer/viewport/streamViewportManager.ts',
    // 实测 249 mutant / 217 killed / 25 survived / 7 noCov = 87.15%（2026-11-18，含 FIFO 淘汰与补偿输入契约）
    minScore: 85,
  },
  renderCoordinatorPin: {
    title: '渲染协调提交后单在途贴底锚定 (Render Coordinator Pin)',
    mutate: [
      'packages/desktop/src/renderer/renderCoordinator.ts:247-310',
      'packages/desktop/src/renderer/renderCoordinator.ts:706-724',
      'packages/desktop/src/renderer/renderCoordinator.ts:809-824',
      'packages/desktop/src/renderer/renderCoordinator.ts:1018-1075',
    ],
    testFiles: ['packages/desktop/__tests__/unit/render-coordinator.test.mjs'],
    buildCommand:
      'node scripts/gates/build-desktop-unit.mjs src/renderer/renderCoordinator.ts src/renderer/viewport/postCommitPinObservers.ts',
    // 实测 180 mutant / 151 killed / 3 timeout / 26 survived / 0 noCov = 85.56%（2026-11-18）
    minScore: 80,
  },
  turnSettlement: {
    title: '流式回合收口与状态收敛 (Turn Settlement)',
    mutate: ['packages/desktop/src/renderer/gateway/gatewayEventDispatcher.ts:559-785'],
    testFiles: ['packages/desktop/__tests__/unit/gatewayEventDispatcher.settlement.test.mjs'],
    buildCommand:
      'node scripts/gates/build-desktop-unit.mjs src/renderer/gateway/gatewayEventDispatcher.ts',
    // 实测 393 mutant / 345 killed / 48 survived / 0 noCov = 87.79%（2026-11-25）
    minScore: 85,
  },
  turnExecutionWatchdog: {
    title: '回合看门狗探活续期与离线收敛 (Turn Execution Watchdog)',
    mutate: ['packages/desktop/src/renderer/services/turnExecutionService.ts:243-509'],
    testFiles: ['packages/desktop/__tests__/unit/turnExecutionService.watchdog.test.mjs'],
    buildCommand:
      'node scripts/gates/build-desktop-unit.mjs src/renderer/services/turnExecutionService.ts',
    // 实测 317 mutant / 260 killed / 57 survived / 0 noCov = 82.02%（2026-11-25）
    minScore: 80,
  },
  turnExecutionSubmit: {
    title: '回合并发提交、打断与流式绑定 (Turn Execution Submit & Interrupt)',
    mutate: [
      'packages/desktop/src/renderer/services/turnExecutionService.ts:798-804',
      'packages/desktop/src/renderer/services/turnExecutionService.ts:966-1040',
      'packages/desktop/src/renderer/services/turnExecutionService.ts:1119-1190',
    ],
    testFiles: [
      'packages/desktop/__tests__/unit/turnExecutionService.submit.test.mjs',
      'packages/desktop/__tests__/unit/turnExecutionService.interrupt.test.mjs',
    ],
    buildCommand:
      'node scripts/gates/build-desktop-unit.mjs src/renderer/services/turnExecutionService.ts',
    // 实测 210 mutant / 186 killed / 24 survived / 0 noCov = 88.57%（2026-11-25）
    minScore: 80,
  },
  sessionSelectToolPatch: {
    title: '会话切回流式工具补刷与删除清理 (Session Select & Delete Cleanup)',
    mutate: [
      'packages/desktop/src/renderer/services/sessionOperationService.ts:421-427',
      'packages/desktop/src/renderer/services/sessionOperationService.ts:458-464',
      'packages/desktop/src/renderer/services/sessionOperationService.ts:754-763',
      'packages/desktop/src/renderer/services/sessionOperationService.ts:791-809',
      'packages/desktop/src/renderer/services/sessionOperationService.ts:837-850',
    ],
    testFiles: ['packages/desktop/__tests__/unit/sessionOperationService.test.mjs'],
    buildCommand:
      'node scripts/gates/build-desktop-unit.mjs src/renderer/services/sessionOperationService.ts',
    // 实测 84 mutant / 79 killed / 5 survived / 0 noCov = 94.05%（2026-11-25）
    minScore: 90,
  },
  toolSection: {
    title: '工具区块流式/收口原子交接 (ToolSection Key Swap)',
    mutate: ['packages/ui/src/components-react/conversation/ToolCapsule.tsx:378-387'],
    testFiles: ['packages/ui/__tests__/streaming-anchor-contract.test.mjs'],
    buildCommand: 'npm run build:ui',
    // 实测 7 mutant / 6 killed / 0 survived / 1 noCov = 85.71%（覆盖分 100%）（2026-11-18）
    minScore: 70,
  },
  avatarSize: {
    title: '头像尺寸白名单与回退 (Avatar Size Resolver)',
    // 纯函数：数字/字符串双形态 + 白名单 + 回退值，全部可被单测直接命中。
    // 门槛 98：50/51 = 98.04% 通过，49/51 = 96.08% 会被拦下 —— 只给唯一那个
    // 等价变异体留余量（`typeof size === 'number'` → true 时，后续 Number.isFinite
    // 天然不 coercion 字符串，行为完全一致，不可杀，已人工核对）。
    mutate: ['packages/ui/src/utils/avatarSize.ts'],
    testFiles: ['packages/ui/__tests__/avatar-size.test.mjs'],
    buildCommand: 'npm run build:ui',
    minScore: 98,
  },
  starMapViewport: {
    title: '记忆地图视口缩放与拟合数学 (Star Map Viewport Math)',
    mutate: ['packages/ui/src/components-react/learning/starMapViewport.ts'],
    testFiles: ['packages/ui/__tests__/star-map-viewport.test.mjs'],
    buildCommand: 'npm run build:ui',
    // 实测 94 mutant / 93 killed / 1 equiv survived / 0 noCov = 98.94%（2026-11-24）。
    // 唯一存活变异为 `padding >= 0` -> `padding > 0`（fallback 为 0 时行为等价）。
    minScore: 95,
  },
  constellationLayout: {
    title: '全量力导向星图无重叠布局 (Constellation Full Layout)',
    // 范围聚焦在确定性契约函数：节点半径与奇点归一化 (64-106)、过滤/选中/关联索引 (124-205)、
    // 原点归正/边界画幅/选中节点置顶及技能清单提取排序 (361-482)；
    // L207-359 力导向连续弹簧阻尼/螺旋调参由 INV-LEARN-02 形式化性质测试守护。
    // 实测 265 mutant / 219 killed / 1 timeout / 45 survived / 0 noCov = 83.02%（2026-11-24）。
    mutate: [
      'packages/core/src/learning/constellationLayout.ts:64-106',
      'packages/core/src/learning/constellationLayout.ts:124-205',
      'packages/core/src/learning/constellationLayout.ts:361-482',
    ],
    testFiles: ['packages/core/__tests__/learning/learning-constellation.test.mjs'],
    buildCommand: 'npm run build:core',
    minScore: 80,
  },
  learningConstellation: {
    title: '多 Bot 记忆图谱构建与技能清单 (Learning Constellation Graph)',
    // L115-725 覆盖清洗、调用次数解析、技能互连、WS/REST/ProfileSkills 隔离构图与边界容错（排除废弃兼容函数 L731-805）。
    // 实测 942 mutant / 769 killed / 2 timeout / 171 survived / 0 noCov = 81.85%（2026-11-24）。
    mutate: ['packages/core/src/learning/learningConstellation.ts:115-725'],
    testFiles: ['packages/core/__tests__/learning/learning-constellation.test.mjs'],
    buildCommand: 'npm run build:core',
    minScore: 80,
  },
  learningService: {
    title: '多 Bot 记忆隔离拉取与降级服务 (Learning Service & REST)',
    // 实测 817 mutant / 654 killed / 12 timeout / 151 survived / 0 noCov = 81.52%（learningRest 91.96%, learningService 78.16%, 2026-11-24）。
    mutate: [
      'packages/desktop/src/renderer/learningRest.ts',
      'packages/desktop/src/renderer/services/learningService.ts',
    ],
    testFiles: ['packages/desktop/__tests__/unit/learning-service.test.mjs'],
    buildCommand:
      'node scripts/gates/build-desktop-unit.mjs src/renderer/learningRest.ts src/renderer/services/learningService.ts',
    minScore: 80,
  },
  deliverables: {
    // 实测 (deliverables :134-620): 761 mutant / 614 killed / 2 timeout / 140 survived / 5 noCov = 80.95%
    title: '回合与会话成果物提取与 MEDIA 标签剥离 (Deliverables Engine)',
    mutate: ['packages/core/src/session/deliverables.ts:134-620'],
    testFiles: ['packages/core/__tests__/session/deliverables.test.mjs'],
    buildCommand: 'npm run build:core',
    minScore: 75,
  },
  mediaResolver: {
    // 实测 (mediaResolver): 121 mutant / 98 killed / 22 survived / 1 noCov = 80.99%
    title: '媒体 URL 代理解析、LRU 缓存与已知文件推导 (Media Resolver)',
    mutate: ['packages/desktop/src/renderer/services/mediaResolver.ts'],
    testFiles: ['packages/desktop/__tests__/unit/mediaResolver.test.mjs'],
    buildCommand: 'node scripts/gates/build-desktop-unit.mjs src/renderer/services/mediaResolver.ts',
    minScore: 80,
  },
  mediaLightbox: {
    // 实测 (mediaLightbox MediaLightbox:50-128 + TurnDeliverables:47-142): 278 mutant / 228 killed / 50 survived / 0 noCov = 82.01%
    title: '浮动媒体灯箱手势与回合交付物画廊 (MediaLightbox & TurnDeliverables)',
    mutate: [
      'packages/ui/src/components-react/conversation/MediaLightbox.tsx:50-128',
      'packages/ui/src/components-react/conversation/TurnDeliverables.tsx:47-142',
    ],
    testFiles: ['packages/ui/__tests__/media-lightbox.test.mjs'],
    buildCommand: 'npm run build:ui',
    minScore: 80,
  },
  androidSigning: {
    // 实测 (androidSigning): 326 mutant / 284 killed / 1 timeout / 41 survived / 0 noCov = 87.42%
    title: 'Android Release 签名配置解析与密钥隔离守卫 (Android Release Signing)',
    mutate: ['packages/mobile/scripts/android-signing-config.mjs'],
    testFiles: ['packages/mobile/__tests__/unit/android-signing-config.test.mjs'],
    buildCommand: 'node -e ""',
    minScore: 80,
  },
  iosSigning: {
    // 实测 (iosSigning): 620 mutant / 569 killed / 51 survived / 0 noCov = 91.77%
    title: 'iOS Release 签名配置解析与 ExportOptions 生成 (iOS Release Signing)',
    mutate: ['packages/mobile/scripts/ios-signing-config.mjs'],
    testFiles: ['packages/mobile/__tests__/unit/ios-signing-config.test.mjs'],
    buildCommand: 'node -e ""',
    minScore: 80,
  },
  desktopSigning: {
    // 实测 (desktopSigning): 850 mutant / 780 killed / 69 survived / 1 noCov = 91.76%
    title: 'Desktop Win/macOS 签名公证配置与安全参数构造 (Desktop Release Signing)',
    mutate: ['packages/desktop/scripts/desktop-signing-config.mjs'],
    testFiles: ['packages/desktop/__tests__/unit/desktop-signing-config.test.mjs'],
    buildCommand: 'node -e ""',
    minScore: 80,
  },
  releaseSigningCheck: {
    // 实测 (releaseSigningCheck): 203 mutant / 179 killed / 7 survived / 17 noCov = 88.18%
    title: '全平台发行签名诊断聚合器 (Cross-Platform Signing Doctor)',
    mutate: ['scripts/signing/check-signing.mjs'],
    testFiles: ['scripts/__tests__/release-signing-check.test.mjs'],
    buildCommand: 'node -e ""',
    minScore: 80,
  },
  liveStreamSync: {
    title: '多端实时流式同步纯内核 (Live Stream Registry & Sync)',
    mutate: ['packages/core/src/session/liveStreamSync.ts'],
    testFiles: [
      'packages/core/__tests__/session/liveStreamSync.test.mjs',
      'packages/core/__tests__/formal/live-stream-sync-formal.test.mjs',
    ],
    buildCommand: 'npm run build:core',
    // 实测 479 mutant / 433 killed / 46 survived / 0 noCov = 90.40%（2026-11-25）
    minScore: 88,
  },
  slidingWatchdog: {
    title: '滑动流式活跃看门狗 (Sliding Active Watchdog)',
    mutate: ['packages/core/src/turn/slidingWatchdog.ts'],
    testFiles: [
      'packages/core/__tests__/turn/slidingWatchdog.test.mjs',
      'packages/core/__tests__/formal/sliding-watchdog-formal.test.mjs',
    ],
    buildCommand: 'npm run build:core',
    // 实测 115 mutant / 109 killed / 6 survived / 0 noCov = 94.78%（2026-11-25）
    minScore: 90,
  },
  eventReducerStreaming: {
    title: '网关流式事件归约扩展 (Event Reducer Streaming Extension)',
    mutate: [
      'packages/core/src/session/eventReducer.ts:461-475',
      'packages/core/src/session/eventReducer.ts:722-854',
    ],
    testFiles: ['packages/core/__tests__/session/eventReducer.test.mjs'],
    buildCommand: 'npm run build:core',
    // 实测 247 mutant / 245 killed / 2 survived / 0 noCov = 99.19%（2026-11-25）
    minScore: 95,
  },
  liveStreamCoordHydration: {
    title: '实时流解析、同步与远端补全协调器 (Live Stream Hydration)',
    mutate: ['packages/desktop/src/renderer/gateway/liveStreamCoordinator.ts:99-411'],
    testFiles: [
      'packages/desktop/__tests__/unit/liveStreamCoordinator.test.mjs',
      'packages/desktop/__tests__/unit/liveStreamCoordinator.boundaries.test.mjs',
    ],
    buildCommand:
      'node scripts/gates/build-desktop-unit.mjs src/renderer/gateway/gatewayEventDispatcher.ts',
    // 实测 358 mutant / 306 killed / 52 survived / 0 noCov = 85.47%（2026-11-25）
    minScore: 82,
  },
  liveStreamCoordAttach: {
    title: '实时流恢复挂载与观察者投影协调器 (Live Stream Attach & Observer)',
    mutate: ['packages/desktop/src/renderer/gateway/liveStreamCoordinator.ts:411-656'],
    testFiles: [
      'packages/desktop/__tests__/unit/liveStreamCoordinator.test.mjs',
      'packages/desktop/__tests__/unit/liveStreamCoordinator.boundaries.test.mjs',
    ],
    buildCommand:
      'node scripts/gates/build-desktop-unit.mjs src/renderer/gateway/gatewayEventDispatcher.ts',
    // 实测 284 mutant / 240 killed / 44 survived / 0 noCov = 84.51%（2026-11-25）
    minScore: 80,
  },
  messageLoadingStreaming: {
    title: '会话加载权威对账与恢复状态机 (Message Loading Streaming)',
    mutate: [
      'packages/desktop/src/renderer/services/messageLoadingService.ts:178-203',
      'packages/desktop/src/renderer/services/messageLoadingService.ts:230-283',
      'packages/desktop/src/renderer/services/messageLoadingService.ts:361-424',
      'packages/desktop/src/renderer/services/messageLoadingService.ts:474-553',
      'packages/desktop/src/renderer/services/messageLoadingService.ts:656-691',
      'packages/desktop/src/renderer/services/messageLoadingService.ts:789-814',
    ],
    testFiles: ['packages/desktop/__tests__/unit/messageLoadingService.test.mjs'],
    buildCommand:
      'node scripts/gates/build-desktop-unit.mjs src/renderer/services/messageLoadingService.ts',
    // 实测 283 mutant / 235 killed / 47 survived / 1 noCov = 83.04%（2026-11-25）
    minScore: 80,
  },
  multideviceHooks: {
    title: '多端协同状态与桌面/移动端钩子 (Multidevice Hooks)',
    mutate: [
      'packages/desktop/src/renderer/events/presenceController.ts:94-150',
      'packages/desktop/src/renderer/mobile/mobileShellCoordinator.ts:559-576',
    ],
    testFiles: [
      'packages/desktop/__tests__/unit/presenceController.test.mjs',
      'packages/desktop/__tests__/unit/mobile-shell-coordinator.test.mjs',
    ],
    buildCommand:
      'node scripts/gates/build-desktop-unit.mjs src/renderer/events/presenceController.ts src/renderer/mobile/mobileShellCoordinator.ts',
    // 实测 69 mutant / 60 killed / 9 survived / 0 noCov = 86.96%（2026-11-25）
    minScore: 85,
  },
  gatewayStreamingDispatch: {
    title: '网关流式事件动作分发 (Gateway Streaming Dispatch)',
    mutate: [
      'packages/desktop/src/renderer/gateway/gatewayEventDispatcher.ts:207-236',
      'packages/desktop/src/renderer/gateway/gatewayEventDispatcher.ts:293-401',
      'packages/desktop/src/renderer/gateway/gatewayEventDispatcher.ts:428-552',
    ],
    testFiles: [
      'packages/desktop/__tests__/unit/gatewayEventDispatcher.dispatch.test.mjs',
      'packages/desktop/__tests__/unit/liveStreamCoordinator.test.mjs',
    ],
    buildCommand:
      'node scripts/gates/build-desktop-unit.mjs src/renderer/gateway/gatewayEventDispatcher.ts',
    // 实测 352 mutant / 301 killed / 50 survived / 1 unreachable noCov = 85.51%（2026-11-25）
    minScore: 82,
  },
  gatewayFrameAndReconnect: {
    title: '网关帧解析与重连续流 (Gateway Frame & Reconnect)',
    mutate: [
      'packages/desktop/src/renderer/gateway/gatewayEventDispatcher.ts:195-205',
      'packages/desktop/src/renderer/gateway/gatewayEventDispatcher.ts:811-974',
      'packages/desktop/src/renderer/gateway/gatewayEventDispatcher.ts:1297-1299',
      'packages/desktop/src/renderer/gateway/gatewayEventDispatcher.ts:1401-1459',
    ],
    testFiles: ['packages/desktop/__tests__/unit/gatewayEventDispatcher.reconnect.test.mjs'],
    buildCommand:
      'node scripts/gates/build-desktop-unit.mjs src/renderer/gateway/gatewayEventDispatcher.ts',
    // 实测 284 mutant / 239 killed / 2 timeout / 43 survived / 0 noCov = 84.86%（2026-11-25）
    minScore: 82,
  },
};
