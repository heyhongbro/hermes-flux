/**
 * TurnExecutionService 滑动看门狗、权威探活、多流接力与边界门限单测
 * (packages/desktop/__tests__/unit/turnExecutionService.watchdog.test.mjs)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveStreamRegistry } from '@hermes-flux/core';
import { createTurnExecutionService } from '../../dist/renderer/services/turnExecutionService.mjs';
import { advanceTimers, createGate, createMockTurnDeps, flushMicrotasks } from './helpers/turnExecutionHarness.mjs';

test('D4-watchdog: turnExecutionService - 看门狗空闲超时触发静默熔断与提示下发', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_700_000_000_000 });
  let service;
  try {
    const { deps, state, activeStreamingContext, activityTransitionTracker } = createMockTurnDeps();
    deps.watchdogIdleTimeoutMs = 20;
    service = createTurnExecutionService(deps);

    state.isStreaming = true;
    activeStreamingContext().activeStreamingStoredSessionId = 'sess-timeout';
    // Bot 主工位的流式回合同时挂 bot 域运行态：超时必须一并摘掉活跃标记，
    // 否则 Bot 卡片在会话侧已熔断、在 Bot 侧仍显示"正在运行"，两侧状态永久分叉。
    activeStreamingContext().activeStreamingBotName = 'bot-x';
    service.armTurnWatchdog();

    await advanceTimers(t, 19);
    assert.equal(state.isStreaming, true, '19ms 时 20ms 看门狗不得提前超时');
    assert.equal(state.dockNotice, '');

    await advanceTimers(t, 1);
    assert.equal(state.isStreaming, false, '超时后必须原子重置流式状态');
    assert.equal(state.dockNotice, 'chat.watchdogTimeoutNotice');
    assert.deepEqual(activityTransitionTracker.cleared, [{ domain: 'session', id: 'sess-timeout' }, { domain: 'bot', id: 'bot-x' }], '会话域与 Bot 域都必须摘掉活跃标记，不得只清一侧');
  } finally {
    service?.disarmTurnWatchdog(true);
    t.mock.timers.reset();
  }
});

test('D4-watchdog: turnExecutionService - 非流式态超时不误伤状态', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_700_000_000_000 });
  let service;
  try {
    const { deps, state } = createMockTurnDeps();
    deps.watchdogIdleTimeoutMs = 20;
    service = createTurnExecutionService(deps);

    state.isStreaming = false;
    state.dockNotice = '';
    service.armTurnWatchdog();

    await advanceTimers(t, 20);
    assert.equal(state.dockNotice, '', '非流式态超时不得下发看门狗提示');
  } finally {
    service?.disarmTurnWatchdog(true);
    t.mock.timers.reset();
  }
});

test('D4-watchdog: turnExecutionService - 定时器 unref 异常时安全降级不抛错', () => {
  const { deps } = createMockTurnDeps();
  const service = createTurnExecutionService(deps);

  const origSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = () => ({
    unref() {
      throw new Error('mock unref error');
    },
  });
  try {
    assert.doesNotThrow(() => service.armTurnWatchdog(), '跨端定时器缺少 unref 能力时必须安全降级');
  } finally {
    globalThis.setTimeout = origSetTimeout;
    service.disarmTurnWatchdog();
  }
});

test('D5: turnExecutionService - 同会话看门狗超时释放归属后立刻重发 Turn 2 -> Turn 1 迟到拒绝对 Turn 2 零污染', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_700_000_000_000 });
  let service;
  try {
    let rejectTurn1;
    const submit1Gate = createGate();
    let turnNo = 0;
    const { deps, state } = createMockTurnDeps({
      state: {
        activeSessionId: 'sess-wd',
        activeFocus: { type: 'bot', botName: 'bot-wd' },
      },
      gatewayClient: {
        call: async (method) => {
          if (method === 'prompt.submit') {
            turnNo += 1;
            if (turnNo === 1) {
              submit1Gate.notify();
              return new Promise((_res, rej) => {
                rejectTurn1 = rej;
              });
            }
            return { status: 'streaming', user_row_id: 303 };
          }
          return {};
        },
      },
    });
    deps.watchdogIdleTimeoutMs = 20;
    service = createTurnExecutionService(deps);
    const p1 = service.sendMessage('wd turn 1');
    await submit1Gate.promise;

    await advanceTimers(t, 19);
    assert.equal(state.isStreaming, true, '19ms 时 20ms 看门狗不得提前释放 ownership');
    await advanceTimers(t, 1);
    assert.equal(state.isStreaming, false, '20ms 到期后看门狗必须超时并释放 ownership');

    await service.sendMessage('wd turn 2');
    const turn2CtxId = deps.getActiveStreamingContext().activeStreamingMessageId;
    rejectTurn1(new Error('late after watchdog'));
    await p1;

    assert.equal(deps.getActiveRunningSessionIds().has('sess-wd'), true);
    assert.equal(deps.getActiveRunningBotNames().has('bot-wd'), true);
    assert.equal(deps.getActiveStreamingContext().activeStreamingMessageId, turn2CtxId);
  } finally {
    service?.disarmTurnWatchdog(true);
    t.mock.timers.reset();
  }
});

test('D4-watchdog: turnExecutionService - 看门狗超时在 flush 前捕获贴底意图并清理工具补丁与计时器', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_700_000_000_000 });
  let service;
  try {
    let nearBottom = true;
    const pendingScrollCalls = [];
    let clearToolPatchCalls = 0;
    let stopToolTimerCalls = 0;
    const { deps, state, tokenCoalescer } = createMockTurnDeps({
      state: {
        activeSessionId: 'sess-focus',
        isStreaming: true,
      },
      activeStreamingContext: {
        activeStreamingMessageId: 'ast-1',
        activeStreamingStoredSessionId: 'sess-focus',
        activeStreamingLiveId: 'live-1',
      },
    });
    deps.watchdogIdleTimeoutMs = 20;
    deps.isStreamNearBottom = () => nearBottom;
    deps.setPendingScrollToBottom = (val) => pendingScrollCalls.push(val);
    deps.clearToolPatchQueue = () => { clearToolPatchCalls += 1; };
    deps.stopRunningToolTimers = () => { stopToolTimerCalls += 1; };
    tokenCoalescer.flush = () => {
      tokenCoalescer.flushed = true;
      nearBottom = false;
    };

    service = createTurnExecutionService(deps);
    service.armTurnWatchdog();
    await advanceTimers(t, 19);
    assert.equal(state.isStreaming, true, '19ms 时 20ms 看门狗不得提前触发');
    await advanceTimers(t, 1);

    assert.equal(state.isStreaming, false);
    assert.deepEqual(pendingScrollCalls, [true], '看门狗超时必须在 flush 前捕获贴底意图');
    assert.equal(clearToolPatchCalls, 1, '看门狗超时必须清空 toolPatchQueue');
    assert.equal(stopToolTimerCalls, 1, '看门狗超时必须停止运行中工具计时器');
  } finally {
    service?.disarmTurnWatchdog(true);
    t.mock.timers.reset();
  }
});

test('D5: turnExecutionService - handleWatchdogTimeout 后台与未注入 isStreamNearBottom 安全收口', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_700_000_000_000 });
  let service;
  try {
    const flushCalls = [];
    const turnStartedCalls = [];
    const trackerClears = [];
    const pendingCalls = [];
    const { deps, rendered } = createMockTurnDeps({
      state: { isStreaming: true, activeSessionId: 'sess-1', turnStartedAt: 12345 },
      activeStreamingContext: {
        activeStreamingMessageId: 'ast-bg',
        activeStreamingStoredSessionId: 'sess-bg',
        activeStreamingLiveId: 'live-bg',
        activeStreamingBotName: 'bot-a',
      },
    });
    deps.watchdogIdleTimeoutMs = 25;
    deps.getTokenCoalescer = () => ({ enqueue: () => {}, flush: () => flushCalls.push(1), clear: () => {} });
    deps.setPendingScrollToBottom = (v) => pendingCalls.push(v);
    deps.setTurnStartedSessionId = (id) => turnStartedCalls.push(id);
    deps.getActivityTransitionTracker = () => ({ clear: (k, id) => trackerClears.push([k, id]) });
    deps.isStreamNearBottom = undefined;
    deps.getActiveRunningSessionIds().add('sess-bg');
    deps.getActiveRunningBotNames().add('bot-a');

    service = createTurnExecutionService(deps);
    service.armTurnWatchdog();
    await advanceTimers(t, 24);
    assert.equal(flushCalls.length, 0, '24ms 时 25ms 看门狗不得提前触发');
    await advanceTimers(t, 1);

    assert.equal(flushCalls.length, 1);
    assert.deepEqual(pendingCalls, [], '后台会话或未注入 isStreamNearBottom 时不得触发置底');
    assert.equal(deps.getActiveRunningSessionIds().has('sess-bg'), false);
    assert.equal(deps.getActiveRunningBotNames().has('bot-a'), false);
    assert.deepEqual(trackerClears, [['session', 'sess-bg'], ['bot', 'bot-a']]);
    assert.deepEqual(turnStartedCalls, [null]);
    assert.equal(deps.getActiveStreamingContext().activeStreamingMessageId, null);
    assert.equal(deps.getActiveStreamingContext().activeStreamingBotName, null);
    assert.equal(rendered.length, 1);
  } finally {
    service?.disarmTurnWatchdog(true);
    t.mock.timers.reset();
  }
});

test('TurnExecutionService: 看门狗先探活续期与离线容错延后收口', async (t) => {
  await t.test('watchdog 过期时网关仍 running=true 必须续期并调用 onWatchdogTurnStillRunning，不误杀也不弹超时横幅', async (st) => {
    st.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_700_000_000_000 });
    let svc;
    try {
      const stillRunningCalls = [];
      let resumeProbeCount = 0;
      const mockClient = {
        call: async (method) => {
          if (method === 'session.resume') {
            resumeProbeCount += 1;
            return {
              running: true,
              inflight: { streaming: true, user: 'q', assistant: 'long tool running...' },
            };
          }
          return {};
        },
      };
      const { deps, state } = createMockTurnDeps({ gatewayClient: mockClient });
      deps.watchdogIdleTimeoutMs = 25;
      deps.onWatchdogTurnStillRunning = (sid, res) => stillRunningCalls.push({ sid, res });
      state.isStreaming = true;
      state.dockNotice = '';
      deps.setActiveStreamingContext({
        activeStreamingMessageId: 'ast-long',
        activeStreamingStoredSessionId: 'sess-1',
        activeStreamingLiveId: 'live-1',
      });

      svc = createTurnExecutionService(deps);
      svc.armTurnWatchdog();
      await advanceTimers(st, 24);
      assert.equal(resumeProbeCount, 0, '24ms 时 25ms 看门狗不得提前探活');
      await advanceTimers(st, 1);
      svc.disarmTurnWatchdog();

      assert.ok(resumeProbeCount >= 1, '看门狗到期必须发起 session.resume 权威探活');
      assert.equal(stillRunningCalls.length >= 1, true);
      assert.equal(state.isStreaming, true, '网关仍在运行时绝不可误杀 isStreaming');
      assert.equal(state.dockNotice, '', '权威续期期间绝不可弹出超时提示');
    } finally {
      svc?.disarmTurnWatchdog(true);
      st.mock.timers.reset();
    }
  });

  await t.test('watchdog 离线断网态首次超时走 defer-offline 延后，超限后安全收敛', async (st) => {
    st.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_700_000_000_000 });
    let svc;
    try {
      const { deps, state } = createMockTurnDeps();
      deps.watchdogIdleTimeoutMs = 20;
      state.gatewayConnected = false;
      state.isStreaming = true;
      deps.setActiveStreamingContext({
        activeStreamingMessageId: 'ast-off',
        activeStreamingStoredSessionId: 'sess-1',
        activeStreamingLiveId: 'live-1',
      });

      svc = createTurnExecutionService(deps);
      svc.armTurnWatchdog();
      // Hop 1 (20ms): 走 defer-offline，不得收敛
      await advanceTimers(st, 19);
      assert.equal(state.isStreaming, true);
      await advanceTimers(st, 1);
      assert.equal(state.isStreaming, true, '第1次离线超时走 defer-offline 不得立刻收口');
      // Hop 2 (+20ms): 仍未超 maxProbeFailures(2)，走 defer-offline
      await advanceTimers(st, 20);
      assert.equal(state.isStreaming, true, '第2次离线超时走 defer-offline 仍不得立刻收口');
      // Hop 3 (+20ms): 超限后安全收敛
      await advanceTimers(st, 19);
      assert.equal(state.isStreaming, true);
      await advanceTimers(st, 1);
      svc.disarmTurnWatchdog();

      assert.equal(state.isStreaming, false, '离线多次超限后必须安全终止并释放输入锁定');
      assert.equal(state.dockNotice, 'chat.watchdogTimeoutNotice');
    } finally {
      svc?.disarmTurnWatchdog(true);
      st.mock.timers.reset();
    }
  });
});

test('TurnExecutionService: 多流最老流探活收敛、探活异常重试与 hard-limit 熔断', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_700_000_000_000 });
  let svc;
  try {
    const reg = new LiveStreamRegistry();
    const runningBots = new Set(['arch-bot']);
    const runningSessions = new Set(['sess-old', 'sess-new']);
    const refreshed = [];
    const stillRunningCalls = [];
    let resumeBehavior = 'old-finished';
    let throwCount = 0;

    const { deps, state } = createMockTurnDeps({
      state: {
        activeSessionId: 'sess-old',
        activeLiveSessionId: 'live-old',
        activeFocus: { type: 'bot', botName: 'arch-bot' },
        sessions: [{ id: 'sess-old', title: 'Old', botName: 'arch-bot' }, { id: 'sess-new', title: 'New', botName: 'default' }],
        isStreaming: true,
      },
      gatewayClient: {
        call: async (method, params) => {
          if (method !== 'session.resume') return {};
          if (resumeBehavior === 'throw') { throwCount += 1; throw new Error('probe rpc timeout'); }
          if (params.session_id === 'sess-old' && resumeBehavior === 'old-finished') return { running: false };
          if (params.session_id === 'sess-new' && resumeBehavior === 'old-finished') return { running: true, inflight: { streaming: true } };
          if (resumeBehavior === 'running') return { running: true, inflight: { streaming: true, assistant: 'still active' } };
          return { running: false };
        },
      },
    });

    // 注册两个并发流：sess-old 最久未活跃，sess-new 较新
    reg.registerStream({ storedSessionId: 'sess-old', liveSessionId: 'live-old', messageId: 'ast-old', botName: 'arch-bot', origin: 'local', nowMs: 1000 });
    reg.registerStream({ storedSessionId: 'sess-new', liveSessionId: 'live-new', messageId: 'ast-new', origin: 'remote', nowMs: 5000 });

    deps.getLiveStreamRegistry = () => reg;
    deps.resolveBotNameForSession = (sid) => (sid === 'sess-old' ? 'arch-bot' : null);
    deps.getActiveRunningBotNames = () => runningBots;
    deps.getActiveRunningSessionIds = () => runningSessions;
    deps.onWatchdogTurnCompleted = async (sid) => { refreshed.push(sid); };
    deps.onWatchdogTurnStillRunning = (sid, res) => { stillRunningCalls.push({ sid, running: Boolean(res?.running) }); };
    deps.watchdogIdleTimeoutMs = 45;
    deps.watchdogHardLimitMs = 2_000;

    svc = createTurnExecutionService(deps);
    // 1. inactivity 超时必须挑选最久未活跃的 sess-old 探活并单独收敛，保留 sess-new 并续期看门狗
    svc.armTurnWatchdog();
    await advanceTimers(t, 45);
    assert.equal(reg.hasSession('sess-old'), false, '超时已结束的 sess-old 必须移除');
    assert.equal(reg.hasSession('sess-new'), true, '较新的 sess-new 并发流不得被误杀');
    assert.equal(runningBots.has('arch-bot'), false, 'ForeverChat 唯一流收敛后必须清理 runningBotName');
    assert.equal(refreshed.length >= 1, true);

    // 2. 探活抛错第 1、2 次容错续期，第 3 次达到超限 (> maxProbeFailures=2) 后强制收敛；hard-limit 直接收敛
    resumeBehavior = 'throw';
    throwCount = 0;
    state.isStreaming = true;
    await advanceTimers(t, 45);
    assert.equal(throwCount, 1);
    assert.equal(reg.hasSession('sess-new'), true, '首次探活异常必须先容错续期不立即丢流');
    await advanceTimers(t, 45);
    assert.equal(throwCount, 2);
    assert.equal(reg.hasSession('sess-new'), true, '第2次探活异常仍未超限不得丢流');
    await advanceTimers(t, 45);
    assert.equal(throwCount, 3);
    assert.equal(reg.hasSession('sess-new'), false, '连续探活失败超限必须安全收敛');

    // 验证 sess-new 仍在运行时的 2 参 onWatchdogTurnStillRunning 回调契约
    reg.registerStream({
      storedSessionId: 'sess-new',
      liveSessionId: 'live-new',
      messageId: 'ast-new-live',
      origin: 'remote',
      nowMs: 5500,
    });
    resumeBehavior = 'old-finished';
    stillRunningCalls.length = 0;
    svc.armTurnWatchdog();
    await advanceTimers(t, 45);
    assert.deepEqual(stillRunningCalls[0], { sid: 'sess-new', running: true });
    reg.removeSession('sess-new');
    svc.disarmTurnWatchdog();

    // hard-limit 直接终止（idle=40, hard=15 被 SlidingActiveWatchdog 钳位至 40ms）
    const hardDeps = { ...deps, watchdogIdleTimeoutMs: 40, watchdogHardLimitMs: 15 };
    const hardSvc = createTurnExecutionService(hardDeps);
    try {
      reg.registerStream({
        storedSessionId: 'sess-new',
        liveSessionId: 'live-new',
        messageId: 'ast-new-2',
        origin: 'local',
        nowMs: 6000,
      });
      state.activeSessionId = 'sess-new';
      state.isStreaming = true;
      hardSvc.armTurnWatchdog();
      await advanceTimers(t, 39);
      assert.equal(reg.hasSession('sess-new'), true, 'hardLimitMs 钳位下限 40ms 前不得提前收敛');
      await advanceTimers(t, 1);
      assert.equal(reg.hasSession('sess-new'), false);
      assert.equal(state.isStreaming, false);
    } finally {
      hardSvc.disarmTurnWatchdog(true);
    }
  } finally {
    svc?.disarmTurnWatchdog(true);
    t.mock.timers.reset();
  }
});

test('Stage4 修复回归: 隐藏 ForeverChat 后台 profile 探活 + Extra inputs 回退 + 群聊/空闲前缀隔离', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_700_000_000_000 });
  let svc;
  try {
    const reg = new LiveStreamRegistry();
    const resumeCalls = [];
    const runningBots = new Set(['arch-bot']);

    const { deps, state } = createMockTurnDeps({
      state: {
        profileName: 'default',
        activeSessionId: 'sess-other',
        activeLiveSessionId: 'live-other',
        activeFocus: { type: 'session', sessionId: 'sess-other' },
        // 刻意将 sess-hidden 排除在可见 sessions 之外，模拟 hidden=1 的 Forever Chat
        sessions: [{ id: 'sess-other', title: 'Other', botName: 'default' }],
        dockNotice: '',
        isStreaming: false,
      },
      gatewayClient: {
        call: async (method, params) => {
          if (method === 'session.resume') {
            resumeCalls.push({ ...params });
            if ('omit_messages' in params || 'profile' in params) {
              throw new Error('Extra inputs are not permitted');
            }
            return { running: false };
          }
          return {};
        },
      },
    });

    // 后台 hidden Forever Chat 注册了 botName='arch-bot'，同时前景上下文仍残留过时指针指向 sess-hidden
    reg.registerStream({
      storedSessionId: 'sess-hidden',
      liveSessionId: 'live-hidden',
      messageId: 'ast-hidden',
      botName: 'arch-bot',
      origin: 'remote',
      nowMs: 1000,
    });
    deps.getLiveStreamRegistry = () => reg;
    deps.getActiveRunningBotNames = () => runningBots;
    deps.setActiveStreamingContext({
      activeStreamingStoredSessionId: 'sess-hidden',
      activeStreamingMessageId: 'ast-hidden',
      activeStreamingLiveId: 'live-hidden',
      activeStreamingBotName: 'arch-bot',
    });
    deps.watchdogIdleTimeoutMs = 25;
    deps.watchdogHardLimitMs = 2_000;

    svc = createTurnExecutionService(deps);
    // 2. 等待原看门狗自然超时并探活：必须读取 streamEntry.botName ('arch-bot')，
    //    并在两次 Extra inputs 后回退为裸 { session_id } 成功收口；同时绝不得把 timeoutNotice 泄露到前景 sess-other
    svc.armTurnWatchdog();
    await advanceTimers(t, 24);
    assert.equal(reg.hasSession('sess-hidden'), true);
    await advanceTimers(t, 1);
    assert.equal(reg.hasSession('sess-hidden'), false);
    assert.deepEqual(resumeCalls, [
      { session_id: 'sess-hidden', profile: 'arch-bot', omit_messages: true },
      { session_id: 'sess-hidden', profile: 'arch-bot' },
      { session_id: 'sess-hidden' },
    ]);
    assert.equal(runningBots.has('arch-bot'), false);
    assert.equal(state.dockNotice, '', '后台 hidden 会话看门狗超时绝不得污染无关前景会话的 dockNotice');
    assert.equal(deps.getActiveStreamingContext().activeStreamingStoredSessionId, null, '过时上下文指标须顺带清理');

    // 3. 切入群聊后，即使无目标 ID（!timedOutSessionId）或后台流超时也绝不覆写群聊 dockNotice
    state.activeFocus = { type: 'group', roomId: 'room-1' };
    state.activeSessionId = '';
    reg.registerStream({
      storedSessionId: 'sess-bg-group',
      liveSessionId: 'live-bg-group',
      messageId: 'ast-bg-group',
      origin: 'remote',
      nowMs: 2000,
    });
    state.dockNotice = '';
    svc.armTurnWatchdog();
    await advanceTimers(t, 24);
    assert.equal(reg.hasSession('sess-bg-group'), true);
    await advanceTimers(t, 1);
    assert.equal(reg.hasSession('sess-bg-group'), false);
    assert.equal(state.dockNotice, '', '单聊后台看门狗超时绝不得泄露进群聊视口');

    // 4. streamEntry.botName 为空 (botName: null) 时，probeWatchdogAuthority 与 settleWatchdogTimeout
    //    仍须通过 deps.resolveBotNameForSession 解析出隐藏 Forever Chat 的真实 profile 并摘掉 runningBots
    runningBots.add('arch-bot-resolved');
    deps.resolveBotNameForSession = (sid) => (sid === 'sess-hidden-nullbot' ? 'arch-bot-resolved' : null);
    resumeCalls.length = 0;
    reg.registerStream({
      storedSessionId: 'sess-hidden-nullbot',
      liveSessionId: 'live-hidden-nullbot',
      messageId: 'ast-hidden-nullbot',
      botName: null,
      origin: 'remote',
      nowMs: 3000,
    });
    state.activeFocus = { type: 'session', sessionId: 'sess-other' };
    state.activeSessionId = 'sess-other';
    svc.armTurnWatchdog();
    await advanceTimers(t, 24);
    assert.equal(reg.hasSession('sess-hidden-nullbot'), true);
    await advanceTimers(t, 1);
    assert.equal(reg.hasSession('sess-hidden-nullbot'), false);
    assert.deepEqual(resumeCalls[0], { session_id: 'sess-hidden-nullbot', profile: 'arch-bot-resolved', omit_messages: true });
    assert.equal(runningBots.has('arch-bot-resolved'), false, 'resolveBotNameForSession 解析出的 Bot 活跃态必须在超时收口时摘除');
  } finally {
    svc?.disarmTurnWatchdog(true);
    t.mock.timers.reset();
  }
});

test('TurnExecutionService: 看门狗 hard-limit/空目标/stale probe/feedTurnWatchdog(expired) 与 isStreamingActiveForCurrentSession', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_700_000_000_000 });
  let svcHard;
  let svcNoReg;
  try {
    const reg = new LiveStreamRegistry();
    let resumeHandler = async () => ({ running: false });
    const resumeCalls = [];

    const { deps, state } = createMockTurnDeps({
      gatewayClient: {
        call: async (method, params) => {
          if (method === 'session.resume') {
            resumeCalls.push(params);
            return resumeHandler(params);
          }
          return {};
        },
      },
    });
    deps.watchdogIdleTimeoutMs = 650;
    deps.watchdogHardLimitMs = 760;
    deps.getLiveStreamRegistry = () => reg;

    // 1. hard-limit 触发直接调用 settleWatchdogTimeout (L414-416)：越过 throttleMs(500) 后 feed 推迟 idleTimer 到 hardLimitMs(760) 之后
    svcHard = createTurnExecutionService(deps);
    try {
      reg.registerStream({ storedSessionId: 'sess-1', liveSessionId: 'live-1', messageId: 'm-1', origin: 'local' });
      state.isStreaming = true;
      svcHard.armTurnWatchdog();
      await advanceTimers(t, 500);
      svcHard.feedTurnWatchdog();
      await advanceTimers(t, 259);
      assert.equal(reg.hasSession('sess-1'), true, '759ms 时 hardLimitMs=760 不得提前收敛');
      await advanceTimers(t, 1);
      assert.equal(reg.hasSession('sess-1'), false, 'hard-limit 必须直接熔断收敛');
      assert.equal(resumeCalls.length, 0, 'hard-limit 不可再发探活');
      assert.equal(state.dockNotice, 'chat.watchdogTimeoutNotice');
    } finally {
      svcHard.disarmTurnWatchdog(true);
    }

    // 2. isStreamingActiveForCurrentSession 全分支 (L471-480)
    state.activeSessionId = '';
    assert.equal(svcHard.isStreamingActiveForCurrentSession(), false);
    state.activeSessionId = 'sess-1';
    reg.registerStream({ storedSessionId: 'sess-1', liveSessionId: 'live-1', messageId: 'm-1', origin: 'local' });
    assert.equal(svcHard.isStreamingActiveForCurrentSession(), true);
    reg.removeSession('sess-1');
    deps.setActiveStreamingContext({ activeStreamingStoredSessionId: 'sess-1', activeStreamingMessageId: 'm-1' });
    state.isStreaming = true;
    assert.equal(svcHard.isStreamingActiveForCurrentSession(), true);
    state.isStreaming = false;
    assert.equal(svcHard.isStreamingActiveForCurrentSession(), false);

    // 3. !targetStoredId 空目标超时、feedTurnWatchdog(expired) 续期抢占 in-flight 探活、2nd 非 Extra error 与 'default' 兜底 (L240-264, L321-322, L342, L352, L355, L410, L455-458)
    const warnLogs = [];
    let releasePendingProbe;
    const { deps: deps2, state: state2 } = createMockTurnDeps({
      gatewayClient: {
        call: async (method, params) => {
          if (method === 'session.resume') {
            resumeCalls.push(params);
            return resumeHandler(params);
          }
          return {};
        },
      },
    });
    deps2.watchdogIdleTimeoutMs = 25;
    deps2.watchdogHardLimitMs = 1200;
    deps2.logStream = { debug: () => {}, info: () => {}, warn: (...a) => warnLogs.push(a) };
    state2.profileName = '';
    state2.sessions = [];
    state2.activeSessionId = '';
    state2.isStreaming = true;
    svcNoReg = createTurnExecutionService(deps2);
    try {
      // 3a) !targetStoredId 直接超时收口
      svcNoReg.armTurnWatchdog();
      await advanceTimers(t, 24);
      assert.equal(state2.isStreaming, true);
      await advanceTimers(t, 1);
      assert.equal(state2.isStreaming, false);

      // 3b) 非聚焦超时无 streamRegistry 分支 (L285) + logStream?.warn 分支 (L352)
      deps2.setActiveStreamingContext({ activeStreamingStoredSessionId: 'sess-other', activeStreamingMessageId: 'm-other' });
      state2.activeSessionId = 'sess-1';
      state2.isStreaming = true;
      state2.dockNotice = '';
      svcNoReg.armTurnWatchdog();
      resumeHandler = async (p) => {
        if ('omit_messages' in p) throw new Error('Extra inputs are not permitted');
        throw new Error('backend 502 error');
      };
      await advanceTimers(t, 25);
      assert.equal(warnLogs.length, 1, '第1次 2nd 非 Extra inputs 探活失败必须记录 warn 且不误关');
      assert.equal(state2.isStreaming, true);
      await advanceTimers(t, 25);
      assert.equal(warnLogs.length, 2, '第2次探活失败仍不得超 maxProbeFailures(2)');
      assert.equal(state2.isStreaming, true);
      await advanceTimers(t, 25);
      assert.equal(warnLogs.length, 3, '第3次超限必须记录 warn 并收口');
      assert.equal(state2.isStreaming, false);
      assert.equal(state2.dockNotice, 'chat.watchdogTimeoutNotice');

      // 3c) expired 状态期间调用 feedTurnWatchdog() 抢占 in-flight 探活，且 renewIdle() 必须真正重新布防下一轮定时探活 (L455-458, L355)
      resumeCalls.length = 0;
      state2.isStreaming = true;
      resumeHandler = () => new Promise((res) => { releasePendingProbe = () => res({ running: false }); });
      svcNoReg.armTurnWatchdog();
      await advanceTimers(t, 25);
      assert.equal(resumeCalls.length, 1);
      assert.equal(resumeCalls[0].profile, 'default', '全部 profile 来源为空时须兜底 default');
      svcNoReg.feedTurnWatchdog(); // 处于 expired 态，触发 L455-458 renewIdle 与 gen 递增
      releasePendingProbe(); // 陈旧探活随后返回，命中 L355 早退而不误杀
      await flushMicrotasks();
      assert.equal(state2.isStreaming, true, 'stale probe 在 feedTurnWatchdog 续期后绝不可误关流式态');
      resumeHandler = async () => ({ running: true });
      await advanceTimers(t, 24);
      assert.equal(resumeCalls.length, 1, 'renewIdle 后 24ms 不得提前触发下一轮探活');
      await advanceTimers(t, 1);
      assert.ok(resumeCalls.length >= 2, 'expired 期 feedTurnWatchdog() 调用 renewIdle 后必须能在下一周期继续触发探活');

      // 3f) custom minimal streamRegistry 返回 null entry 且无 ctx/activeSessionId 时由 streamIds[0] 兜底 (L409-410)
      let settledOrphan = false;
      resumeHandler = async () => ({ running: false });
      const svcOrphanReg = createTurnExecutionService({
        ...deps2,
        watchdogIdleTimeoutMs: 25,
        watchdogHardLimitMs: 300,
        getLiveStreamRegistry: () => ({
          listSessionIds: () => ['s-orphaned'],
          getBySession: () => undefined,
          removeSession: () => { settledOrphan = true; },
          size: () => (settledOrphan ? 0 : 1),
        }),
      });
      state2.activeFocus = { type: 'group', roomId: 'room-1' };
      state2.activeSessionId = '';
      state2.isStreaming = false;
      deps2.setActiveStreamingContext({ activeStreamingStoredSessionId: null, activeStreamingMessageId: null });
      svcNoReg.disarmTurnWatchdog();
      svcOrphanReg.armTurnWatchdog();
      await advanceTimers(t, 25);
      svcOrphanReg.disarmTurnWatchdog(true);
      assert.equal(settledOrphan, true);
    } finally {
      svcNoReg.disarmTurnWatchdog(true);
    }
  } finally {
    svcHard?.disarmTurnWatchdog(true);
    svcNoReg?.disarmTurnWatchdog(true);
    t.mock.timers.reset();
  }
});

test('TurnExecutionService: 看门狗全分支消杀（ownership释放/tracker清理/group与后台保护/多流re-arm/离线与失败reset/profile与warn校验）', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_700_000_000_000 });
  try {
    // 1. releaseTurnOwnership + tracker.clear + failSubmittedTurn 防陈旧回合误杀新回合
    {
      const reg = new LiveStreamRegistry();
      let rejectPendingSubmit;
      const submitGate = createGate();
      let nearBottom = false;
      const pendingScrolls = [];
      const { deps, state, activityTransitionTracker } = createMockTurnDeps({
        state: {
          activeSessionId: 'sess-own',
          activeLiveSessionId: 'live-own',
          activeFocus: { type: 'bot', botName: 'arch-bot', sessionId: 'sess-own' },
          sessions: [{ id: 'sess-own', title: 'Own', botName: 'arch-bot', preview: '', timestamp: 1 }],
          messages: [],
        },
        gatewayClient: {
          call: async (method) => {
            if (method === 'prompt.submit') {
              submitGate.notify();
              return await new Promise((_, rej) => { rejectPendingSubmit = rej; });
            }
            if (method === 'session.resume') return { running: false };
            return {};
          },
        },
      });
      deps.watchdogIdleTimeoutMs = 60;
      deps.watchdogHardLimitMs = 1500;
      deps.getLiveStreamRegistry = () => reg;
      deps.isStreamNearBottom = () => nearBottom;
      deps.setPendingScrollToBottom = (v) => pendingScrolls.push(v);

      const svc = createTurnExecutionService(deps);
      try {
        const submitPromise = svc.sendMessage('held prompt');
        await submitGate.promise;
        const inFlightMsgId = deps.getActiveStreamingContext().activeStreamingMessageId;
        assert.ok(inFlightMsgId);
        pendingScrolls.length = 0;
        await advanceTimers(t, 59);
        assert.equal(state.isStreaming, true, '59ms 时 60ms 看门狗不得提前触发');
        await advanceTimers(t, 1);
        assert.equal(state.isStreaming, false);
        assert.equal(pendingScrolls.length, 0, '非贴底超时不得 setPendingScrollToBottom');
        assert.ok(activityTransitionTracker.cleared.some((x) => x.domain === 'session' && x.id === 'sess-own'));
        assert.ok(activityTransitionTracker.cleared.some((x) => x.domain === 'bot' && x.id === 'arch-bot'));

        deps.getActiveRunningSessionIds().add('sess-own');
        deps.getActiveRunningBotNames().add('arch-bot');
        const oldMsgBefore = state.messages.find((m) => m.id === inFlightMsgId)?.content;
        rejectPendingSubmit(new Error('late network drop'));
        await submitPromise;
        assert.equal(deps.getActiveRunningSessionIds().has('sess-own'), true, 'timeout 释放 turnOwnership 后迟到失败不得误杀新运行会话');
        assert.equal(deps.getActiveRunningBotNames().has('arch-bot'), true, 'timeout 释放 turnOwnership 后迟到失败不得误杀新运行 Bot');
        assert.equal(state.messages.find((m) => m.id === inFlightMsgId)?.content, oldMsgBefore);
      } finally {
        svc.disarmTurnWatchdog(true);
      }
    }

    // 2. group 聚焦无 streamRegistry / 空目标、后台超时保留前景 ctx 与 pendingScroll、双流最老流选择 + remainingStreams re-arm
    {
      const reg = new LiveStreamRegistry();
      const resumeProfiles = [];
      const resumeTargets = [];
      const pendingScrolls = [];
      const completedHooks = [];
      const { deps, state } = createMockTurnDeps({
        state: {
          activeSessionId: 'sess-fg',
          activeFocus: { type: 'session', sessionId: 'sess-fg' },
          sessions: [
            { id: 'sess-fg', title: 'FG', botName: 'fg-bot', preview: '', timestamp: 1 },
            { id: 'sess-bg-old', title: 'BGOld', botName: 'bg-old-bot', preview: '', timestamp: 1 },
          ],
          gatewayConnected: true,
        },
        gatewayClient: {
          call: async (method, p) => {
            if (method === 'session.resume') {
              resumeTargets.push(p.session_id);
              resumeProfiles.push(p.profile);
              return { running: false };
            }
            return {};
          },
        },
      });
      deps.watchdogIdleTimeoutMs = 80;
      deps.watchdogHardLimitMs = 2000;
      deps.getLiveStreamRegistry = () => reg;
      deps.isStreamNearBottom = () => true;
      deps.setPendingScrollToBottom = (v) => pendingScrolls.push(v);
      deps.onWatchdogTurnCompleted = async (sid) => completedHooks.push(sid);

      const svc = createTurnExecutionService(deps);
      try {
        reg.registerStream({ storedSessionId: 'sess-a', liveSessionId: 'la', messageId: 'ma', origin: 'remote', nowMs: 300 });
        reg.registerStream({ storedSessionId: 'sess-bg-old', liveSessionId: 'lb', messageId: 'mb', origin: 'remote', nowMs: 50 });
        reg.registerStream({ storedSessionId: 'sess-fg', liveSessionId: 'lf', messageId: 'mf', origin: 'local', nowMs: 200 });
        deps.setActiveStreamingContext({ activeStreamingStoredSessionId: 'sess-fg', activeStreamingMessageId: 'mf' });
        state.isStreaming = true;
        svc.armTurnWatchdog();
        await advanceTimers(t, 80);
        assert.equal(completedHooks.length, 1);
        assert.equal(resumeTargets[0], 'sess-bg-old');
        assert.equal(resumeProfiles[0], 'bg-old-bot');
        assert.equal(deps.getActiveStreamingContext().activeStreamingStoredSessionId, 'sess-fg', '后台超时不得清空前台 activeStreamingContext');
        assert.equal(pendingScrolls.length, 0, '后台超时即使贴底也不得触发当前视口 setPendingScrollToBottom');
        assert.equal(state.isStreaming, true, '前台 sess-fg 仍在 reg 时后台超时不得关闭 isStreaming');

        await advanceTimers(t, 80);
        assert.equal(completedHooks.length, 2);
        assert.equal(resumeTargets[1], 'sess-fg');
        assert.equal(state.isStreaming, false, 'sess-fg 出队后即使仍有 sess-a，!hasSession(sess-fg) 时前台 isStreaming 必须置 false');
        assert.deepEqual(pendingScrolls, [true]);

        await advanceTimers(t, 80);
        assert.equal(completedHooks.length, 3);
        assert.equal(resumeTargets[2], 'sess-a');
        assert.deepEqual(completedHooks, ['sess-bg-old', 'sess-fg', 'sess-a']);
      } finally {
        svc.disarmTurnWatchdog(true);
      }

      const warnEntries = [];
      const { deps: depsGrp, state: stateGrp } = createMockTurnDeps({
        state: {
          activeSessionId: 'sess-x',
          activeFocus: { type: 'group', roomId: 'room-1' },
          isStreaming: true,
          dockNotice: 'keep-notice',
          sessions: [{ id: 'sess-other-b', title: 'OtherB', botName: 'other-b-profile', preview: '', timestamp: 1 }],
          gatewayConnected: true,
        },
        gatewayClient: {
          call: async (method, p) => {
            if (method === 'session.resume') {
              resumeTargets.push(p.session_id);
              resumeProfiles.push(p.profile);
              throw new Error('non-extra direct error');
            }
            return {};
          },
        },
      });
      depsGrp.watchdogIdleTimeoutMs = 45;
      depsGrp.watchdogHardLimitMs = 250;
      depsGrp.isStreamNearBottom = () => true;
      depsGrp.logStream = { debug: () => {}, info: () => {}, warn: (msg, meta) => warnEntries.push({ msg, meta }) };
      const grpScrolls = [];
      depsGrp.setPendingScrollToBottom = (v) => grpScrolls.push(v);
      const svcGrp = createTurnExecutionService(depsGrp);
      try {
        stateGrp.activeSessionId = '';
        depsGrp.setActiveStreamingContext({ activeStreamingStoredSessionId: null, activeStreamingMessageId: null });
        svcGrp.armTurnWatchdog();
        await advanceTimers(t, 45);
        assert.equal(stateGrp.isStreaming, true, 'group 焦点的空目标超时不得误关 isStreaming');
        assert.equal(stateGrp.dockNotice, 'keep-notice');
        assert.equal(grpScrolls.length, 0);

        const countBefore = resumeTargets.length;
        stateGrp.activeFocus = { type: 'bot', botName: 'wrong-focused-bot' };
        stateGrp.activeSessionId = 'sess-focused-diff';
        depsGrp.setActiveStreamingContext({ activeStreamingStoredSessionId: 'sess-other-b', activeStreamingMessageId: 'm-ob' });
        svcGrp.armTurnWatchdog();
        await advanceTimers(t, 45);
        assert.ok(warnEntries.length >= 1);
        assert.equal(resumeTargets.length - countBefore, 1, '非 Extra inputs 错误绝不可重试 session.resume');
        assert.equal(resumeProfiles[countBefore], 'other-b-profile', 'activeSessionId !== targetStoredId 时不可错用 activeFocus.botName');
        assert.equal(warnEntries[0].msg, 'watchdog authority probe failed');
        assert.equal(warnEntries[0].meta.sessionId, 'sess-other-b');
        assert.ok(warnEntries[0].meta.error.includes('non-extra direct error'));
      } finally {
        svcGrp.disarmTurnWatchdog(true);
      }
    }

    // 3. 离线 (gatewayConnected=false 伴随非空 client) 延后容错 -> 在途断连 defer-offline -> running=true 清零失败计数 -> 再次错误仍可容错
    {
      const reg = new LiveStreamRegistry();
      let mode = 'offline';
      let probeCalls = 0;
      const completedHooks = [];
      const { deps, state } = createMockTurnDeps({
        state: {
          activeSessionId: 'sess-off',
          sessions: [{ id: 'sess-off', title: 'Off', botName: 'default', preview: '', timestamp: 1 }],
          gatewayConnected: false,
        },
        gatewayClient: {
          call: async (method) => {
            if (method === 'session.resume') {
              probeCalls += 1;
              if (mode === 'midflight-disconnect') {
                state.gatewayConnected = false;
                throw new Error('socket closed mid-flight');
              }
              if (mode === 'running-reset') return { running: true, inflight: { streaming: true } };
              return { running: false };
            }
            return {};
          },
        },
      });
      deps.watchdogIdleTimeoutMs = 70;
      deps.watchdogHardLimitMs = 3000;
      deps.getLiveStreamRegistry = () => reg;
      deps.onWatchdogTurnCompleted = async (sid) => completedHooks.push(sid);
      const svc = createTurnExecutionService(deps);
      try {
        reg.registerStream({ storedSessionId: 'sess-off', liveSessionId: 'l-off', messageId: 'm-off', origin: 'local' });
        state.isStreaming = true;
        svc.armTurnWatchdog();
        await advanceTimers(t, 70);
        assert.equal(probeCalls, 0);
        assert.equal(state.isStreaming, true, 'gatewayConnected=false 第1次超时必须走 defer-offline 续期');

        mode = 'running-reset';
        state.gatewayConnected = true;
        await advanceTimers(t, 70);
        assert.equal(probeCalls, 1);
        assert.equal(state.isStreaming, true);

        const seqAfterReset = probeCalls;
        mode = 'midflight-disconnect';
        await advanceTimers(t, 70);
        assert.equal(probeCalls, seqAfterReset + 1);
        assert.equal(state.isStreaming, true, '在途断连触发 defer-offline 不得立刻误杀');

        const seqAfterMid = probeCalls;
        state.gatewayConnected = true;
        mode = 'running-reset';
        await advanceTimers(t, 70);
        assert.equal(probeCalls, seqAfterMid + 1);
        assert.equal(state.isStreaming, true);
        assert.equal(completedHooks.length, 0);

        const seqBeforeSecondMid = probeCalls;
        mode = 'midflight-disconnect';
        await advanceTimers(t, 70);
        assert.equal(probeCalls, seqBeforeSecondMid + 1);
        assert.equal(state.isStreaming, true, 'running=true 重置连续失败计数后，新的一轮第1次在途断连必须仍容错');
      } finally {
        svc.disarmTurnWatchdog(true);
      }
    }
  } finally {
    t.mock.timers.reset();
  }
});

test('TurnExecutionService: disarmTurnWatchdog 多流守卫（有流拒撤 / force=true / 清空撤防）', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_700_000_000_000 });
  let svc;
  try {
    const reg = new LiveStreamRegistry();
    let probeCount = 0;
    const { deps, state } = createMockTurnDeps({
      gatewayClient: {
        call: async (method) => {
          if (method === 'session.resume') { probeCount += 1; return { running: true }; }
          return {};
        },
      },
    });
    deps.watchdogIdleTimeoutMs = 20;
    deps.watchdogHardLimitMs = 300;
    deps.getLiveStreamRegistry = () => reg;
    svc = createTurnExecutionService(deps);

    state.activeSessionId = 'sess-keep';
    state.isStreaming = true;
    reg.registerStream({ storedSessionId: 'sess-keep', liveSessionId: 'live-keep', messageId: 'ast-keep', origin: 'remote', nowMs: 1000 });
    svc.armTurnWatchdog();
    svc.disarmTurnWatchdog();
    await advanceTimers(t, 20);
    assert.ok(probeCount >= 1, '仍有活跃流时 disarmTurnWatchdog() 严禁关闭看门狗');

    probeCount = 0;
    svc.disarmTurnWatchdog(true);
    await advanceTimers(t, 20);
    assert.equal(probeCount, 0, 'force=true 必须强制撤防看门狗');

    svc.armTurnWatchdog();
    reg.removeSession('sess-keep');
    probeCount = 0;
    svc.disarmTurnWatchdog();
    await advanceTimers(t, 20);
    assert.equal(probeCount, 0, 'LiveStreamRegistry 清空后无参 disarm 必须撤防看门狗');
  } finally {
    svc?.disarmTurnWatchdog(true);
    t.mock.timers.reset();
  }
});

test('TurnExecutionService 边界: 默认 idle(60s)/hardLimit(120m)/throttle(500ms)', async (t) => {
  const createWatchdogBoundarySvc = (idleMs, hardMs, runningReply = false) => {
    const resumeCalls = [];
    const { deps, state } = createMockTurnDeps({
      gatewayClient: {
        call: async (method, params) => {
          if (method === 'session.resume') { resumeCalls.push(params); return { running: runningReply }; }
          return {};
        },
      },
    });
    deps.watchdogIdleTimeoutMs = idleMs;
    deps.watchdogHardLimitMs = hardMs;
    state.isStreaming = true;
    state.dockNotice = '';
    deps.setActiveStreamingContext({ activeStreamingStoredSessionId: 'sess-1', activeStreamingMessageId: 'ast-1', activeStreamingLiveId: 'live-1' });
    return { svc: createTurnExecutionService(deps), state, resumeCalls };
  };

  await t.test('默认 idleTimeoutMs=60000 精确门限（59999 不探活 / +1 触发）', async (st) => {
    st.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_700_000_000_000 });
    const { svc, state, resumeCalls } = createWatchdogBoundarySvc(undefined, 500_000);
    try {
      svc.armTurnWatchdog();
      await advanceTimers(st, 59_999);
      assert.equal(resumeCalls.length, 0, '59999ms 时默认 60000ms 空闲看门狗不得提前探活');
      assert.equal(state.isStreaming, true);
      await advanceTimers(st, 1);
      assert.equal(resumeCalls.length, 1, '60000ms 整点必须触发默认空闲探活');
    } finally {
      svc.disarmTurnWatchdog(true);
      st.mock.timers.reset();
    }
  });

  await t.test('默认 hardLimitMs=7200000 (120m) 连续喂狗后精确硬上限熔断', async (st) => {
    st.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_700_000_000_000 });
    const { svc, state, resumeCalls } = createWatchdogBoundarySvc(undefined, undefined, true);
    try {
      svc.armTurnWatchdog();
      for (let i = 0; i < 120; i += 1) {
        st.mock.timers.tick(59_500);
        svc.feedTurnWatchdog();
      }
      st.mock.timers.tick(500);
      svc.feedTurnWatchdog();
      await advanceTimers(st, 59_499);
      assert.equal(state.isStreaming, true, '7199999ms 时默认 120m 硬上限不得提前熔断');
      assert.equal(resumeCalls.length, 0);
      await advanceTimers(st, 1);
      assert.equal(state.isStreaming, false, '7200000ms 整点必须触发默认 120m 硬上限直接收敛');
      assert.equal(state.dockNotice, 'chat.watchdogTimeoutNotice');
      assert.equal(resumeCalls.length, 0, 'hard-limit 收敛绝不可发起 session.resume 探活');
    } finally {
      svc.disarmTurnWatchdog(true);
      st.mock.timers.reset();
    }
  });

  await t.test('默认 throttleMs=500 节流窗口（499ms 被节流 / 500ms 放行续期）', async (st) => {
    st.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_700_000_000_000 });
    const c1 = createWatchdogBoundarySvc(650, 10_000);
    const c2 = createWatchdogBoundarySvc(650, 10_000);
    try {
      c1.svc.armTurnWatchdog();
      await advanceTimers(st, 499);
      c1.svc.feedTurnWatchdog();
      await advanceTimers(st, 150);
      assert.equal(c1.resumeCalls.length, 0);
      assert.equal(c1.state.isStreaming, true);
      await advanceTimers(st, 1);
      assert.equal(c1.resumeCalls.length, 1, '499ms feed 被节流后应在原始 650ms 点位触发探活');
      assert.equal(c1.state.isStreaming, false);

      c2.svc.armTurnWatchdog();
      await advanceTimers(st, 500);
      c2.svc.feedTurnWatchdog();
      await advanceTimers(st, 150);
      assert.equal(c2.resumeCalls.length, 0, '500ms 整点 feed 必须放行并推迟 idleTimeoutMs');
      assert.equal(c2.state.isStreaming, true);
      await advanceTimers(st, 499);
      assert.equal(c2.resumeCalls.length, 0);
      assert.equal(c2.state.isStreaming, true);
      await advanceTimers(st, 1);
      assert.equal(c2.resumeCalls.length, 1, '推迟后的 1150ms 整点必须触发探活');
      assert.equal(c2.state.isStreaming, false);
    } finally {
      c1.svc.disarmTurnWatchdog(true);
      c2.svc.disarmTurnWatchdog(true);
      st.mock.timers.reset();
    }
  });
});
