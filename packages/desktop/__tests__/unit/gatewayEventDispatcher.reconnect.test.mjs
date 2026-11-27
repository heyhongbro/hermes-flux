/**
 * GatewayEventDispatcher 帧解析、重连续流恢复/水合、idle sync 与断连清理单测
 * (packages/desktop/__tests__/unit/gatewayEventDispatcher.reconnect.test.mjs)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveStreamRegistry, TokenCoalescer } from '@hermes-flux/core';
import { createGatewayEventDispatcher } from '../../dist/renderer/gateway/gatewayEventDispatcher.mjs';
import { advanceTimers, createMockDispatcherDeps, flushMicrotasks } from './helpers/gatewayDispatcherHarness.mjs';

test('D6: gatewayEventDispatcher - 隐私模式下连接回写配置失败不得中断连接流程（P-032）', async () => {
  const hadStorage = 'localStorage' in globalThis;
  const savedStorage = globalThis.localStorage;
  const savedWarn = console.warn;
  const warns = [];
  let dispatcher;
  try {
    globalThis.localStorage = {
      getItem: () => null,
      setItem: () => {
        const error = new Error('denied');
        error.name = 'SecurityError';
        throw error;
      },
    };
    console.warn = (...args) => warns.push(args);

    const { deps, rendered, state } = createMockDispatcherDeps();
    deps.testConnection = async () => ({ ok: false, latency: 0, message: 'denied' });
    dispatcher = createGatewayEventDispatcher(deps);

    await assert.doesNotReject(() => dispatcher.connect(), '写盘失败不得让 connect 抛错');
    assert.equal(state.gatewayUrl, 'http://127.0.0.1:8080', '内存态必须已生效');
    assert.ok(rendered.length >= 1, '连接流程必须继续并触发 render');
    assert.ok(
      warns.some((args) => String(args[0]).includes('failed to persist connection config')),
      '写盘失败必须可观测（Failure Is Not Empty）',
    );
  } finally {
    dispatcher?.disconnect();
    console.warn = savedWarn;
    if (hadStorage) globalThis.localStorage = savedStorage;
    else delete globalThis.localStorage;
  }
});

test('D6: gatewayEventDispatcher - 正常存储与无 localStorage 时回写不产生降级日志（P-032）', async () => {
  for (const mode of ['normal', 'absent']) {
    const hadStorage = 'localStorage' in globalThis;
    const savedStorage = globalThis.localStorage;
    const savedWarn = console.warn;
    const warns = [];
    let dispatcher;
    try {
      if (mode === 'normal') {
        globalThis.localStorage = { getItem: () => null, setItem: () => {} };
      } else {
        delete globalThis.localStorage;
      }
      console.warn = (...args) => warns.push(args);

      const { deps } = createMockDispatcherDeps();
      deps.testConnection = async () => ({ ok: false, latency: 0, message: 'denied' });
      dispatcher = createGatewayEventDispatcher(deps);

      await assert.doesNotReject(() => dispatcher.connect());
      assert.equal(warns.length, 0, `${mode} 场景不得产生降级日志`);
    } finally {
      dispatcher?.disconnect();
      console.warn = savedWarn;
      if (hadStorage) globalThis.localStorage = savedStorage;
      else delete globalThis.localStorage;
    }
  }
});

test('D6: gatewayEventDispatcher - disconnect 深度清空会话与未读运行集合', () => {
  const { deps, state, rendered } = createMockDispatcherDeps();
  state.learningState = {
    status: 'ready',
    graph: { nodes: [], edges: [], summary: [], totalSkills: 0, totalMemories: 0, axisStart: '', axisEnd: '' },
  };
  state.learningDetail = { status: 'ready', id: 'memory:1', kind: 'memory', label: 'M1', content: 'body' };
  const dispatcher = createGatewayEventDispatcher(deps);

  const prevEpoch = dispatcher.getConnectionEpoch();
  dispatcher.disconnect();

  assert.equal(dispatcher.getConnectionEpoch(), prevEpoch + 1, '断开连接必须自增 connectionEpoch');
  assert.equal(state.gatewayConnected, false);
  assert.equal(state.sessions.length, 0);
  assert.equal(state.messages.length, 0);
  assert.equal(deps.getActiveRunningSessionIds().size, 0, '运行中集合必须清空');
  assert.deepEqual(state.learningState, { status: 'idle' });
  assert.deepEqual(state.learningDetail, { status: 'idle' });
  assert.ok(rendered.length > 0);
});

test('D6: gatewayEventDispatcher - 重连续流恢复/终止与多流后台保活及阶段补丁路由', async () => {
  const reg = new LiveStreamRegistry();
  const runningBots = new Set();
  const { deps, state, watchdogEvents } = createMockDispatcherDeps({
    state: {
      activeSessionId: 'sess-forever',
      activeLiveSessionId: 'live-old',
      sessions: [
        { id: 'sess-forever', title: 'Forever', botName: 'arch-bot', preview: '', timestamp: 100 },
        { id: 'sess-bg', title: 'Bg', botName: 'default', preview: '', timestamp: 50 },
      ],
      messages: [{ id: 'u1', role: 'user', content: 'q', timestamp: '12:00:00' }],
    },
  });
  const flushedByCoalescer = [];
  const coalescer = new TokenCoalescer((map) => {
    for (const [messageId, entry] of map.entries()) {
      flushedByCoalescer.push({ messageId, content: entry.content, thought: entry.thought });
    }
  });
  deps.getTokenCoalescer = () => coalescer;
  deps.getLiveStreamRegistry = () => reg;
  deps.getActiveRunningBotNames = () => runningBots;
  deps.resolveBotNameForSession = (sid) => (sid === 'sess-forever' ? 'arch-bot' : null);
  deps.toStoredSessionId = (id) => (id?.startsWith('live-') ? (id === 'live-bg' ? 'sess-bg' : 'sess-forever') : id || null);
  deps.getSessionMessagesCache().set('sess-forever', state.messages);
  deps.getSessionMessagesCache().set('sess-bg', [{ id: 'bg-a', role: 'assistant', content: 'bg-' }]);

  const droppedQueues = [];
  const originalDropMessage = coalescer.dropMessage.bind(coalescer);
  coalescer.dropMessage = (mid) => {
    droppedQueues.push(mid);
    return originalDropMessage(mid);
  };
  let toolPatchCleared = 0;
  let timersStopped = 0;
  deps.clearToolPatchQueue = () => { toolPatchCleared += 1; };
  deps.stopRunningToolTimers = () => { timersStopped += 1; };
  const dispatcher = createGatewayEventDispatcher(deps);
  let fallbackDispatcher;

  try {
    // 1. resumeReconnectStreaming: 带 resumeResult 走 attach，不带 resumeResult 更新 liveId 并同步投影；未注册聚焦会话也不得误清空 isStreaming
    dispatcher.resumeReconnectStreaming('sess-forever', 'live-r1', {
      running: true,
      inflight: { streaming: true, user: 'q', assistant: 'reconnected-prefix' },
    });
    assert.equal(reg.hasSession('sess-forever'), true);
    assert.equal(runningBots.has('arch-bot'), true);

    dispatcher.resumeReconnectStreaming('sess-forever', 'live-r2');
    assert.equal(reg.getBySession('sess-forever')?.liveSessionId, 'live-r2');
    assert.equal(state.activeLiveSessionId, 'live-r2', '必须把重连新 liveId 同步到 focused 投影');
    state.activeSessionId = 'sess-unknown';
    state.isStreaming = true;
    dispatcher.resumeReconnectStreaming('sess-unknown', 'live-unknown');
    assert.equal(reg.hasSession('sess-unknown'), false);
    assert.equal(state.isStreaming, true, '未注册会话触发 resumeReconnectStreaming 不得把前台 isStreaming 清成 false');
    const origResolveBot = deps.resolveBotNameForSession;
    deps.resolveBotNameForSession = (sid) => (sid === 'sess-bot-res' ? 'resume-only-bot' : origResolveBot(sid));
    dispatcher.resumeReconnectStreaming('sess-bot-res', 'live-bot-res', { running: true, inflight: { streaming: true } });
    assert.equal(reg.getBySession('sess-bot-res')?.botName, 'resume-only-bot');
    assert.equal(runningBots.has('resume-only-bot'), true);
    reg.removeSession('sess-bot-res');
    runningBots.delete('resume-only-bot');
    deps.resolveBotNameForSession = origResolveBot;
    state.activeSessionId = 'sess-forever';

    // 2. 后台 sess-bg 注册流接收 message.interim / stream-activity / session.info(running)
    reg.registerStream({
      storedSessionId: 'sess-bg',
      liveSessionId: 'live-bg',
      messageId: 'bg-a',
      origin: 'remote',
      nowMs: 1000,
    });
    const fgStreamMsgId = reg.getBySession('sess-forever').messageId;
    coalescer.push({ messageId: 'bg-a', delta: 'stale-bg', isThought: false });
    coalescer.push({ messageId: fgStreamMsgId, delta: 'keep-fg', isThought: false });
    coalescer.push({ messageId: 'untracked-id', delta: 'keep-untracked', isThought: false });
    deps.getActiveRunningSessionIds().add('sess-bg');
    deps.getActiveRunningSessionIds().add('sess-forever');
    dispatcher.handleGatewayEvent({
      type: 'message.interim',
      session_id: 'live-bg',
      payload: { turn_id: 'tb', segment: 0, text: 'step1', already_streamed: false },
    });
    dispatcher.handleGatewayEvent({
      type: 'tool.progress',
      session_id: 'live-bg',
      payload: {},
    });
    dispatcher.handleGatewayEvent({
      type: 'session.info',
      session_id: 'live-bg',
      payload: { running: true },
    });
    assert.ok(watchdogEvents.includes('feed'));

    // 3. finishReconnectStreaming: 清理后台 sess-bg 时仅 drop('bg-a') 不 clear；仅当全部流结束时 clear + 撤防看门狗
    dispatcher.finishReconnectStreaming('sess-bg');
    assert.equal(reg.hasSession('sess-bg'), false);
    assert.deepEqual(droppedQueues, ['bg-a']);
    assert.equal(deps.getActiveRunningSessionIds().has('sess-bg'), false);
    assert.equal(deps.getActiveRunningSessionIds().has('sess-forever'), true);
    assert.equal(state.isStreaming, true, '前台 sess-forever 仍活跃时不可关闭 isStreaming');
    assert.equal(watchdogEvents.includes('disarm'), false, '仍有活跃并发流时不得撤防看门狗');
    coalescer.flush();
    assert.equal(flushedByCoalescer.some((x) => x.messageId === 'bg-a'), false, 'bg-a 必须被 dropMessage 丢弃');
    assert.equal(flushedByCoalescer.some((x) => x.messageId === fgStreamMsgId), true, '非最后流结束后 keep-fg 不得被 coalescer.clear() 误清空');
    assert.equal(flushedByCoalescer.some((x) => x.messageId === 'untracked-id'), true);

    reg.registerStream({ storedSessionId: 'sess-bg2', liveSessionId: 'live-bg2', messageId: 'm-bg2', origin: 'remote' });
    deps.setActiveStreamingContext({ activeStreamingStoredSessionId: 'sess-keep', activeStreamingMessageId: 'm-keep' });
    state.isStreaming = true;
    state.turnStartedAt = 12345;
    deps.setTurnStartedSessionId('sess-forever');
    dispatcher.finishReconnectStreaming('sess-forever');
    assert.equal(deps.getActiveStreamingContext().activeStreamingStoredSessionId, 'sess-keep', '不同会话 finish 不得清空 activeStreamingStoredSessionId');
    assert.equal(state.isStreaming, false, '聚焦会话 finish 即便后台仍有 sess-bg2 也必须把前台 isStreaming 置 false');
    assert.equal(state.turnStartedAt, undefined);
    assert.equal(deps.getTurnStartedSessionId(), null);
    assert.equal(watchdogEvents.includes('disarm'), false, '尚有 sess-bg2 在 reg 中，不得 disarm');

    flushedByCoalescer.length = 0;
    coalescer.push({ messageId: 'stale-all', delta: 'drop-by-clear', isThought: false });
    state.isStreaming = true;
    dispatcher.finishReconnectStreaming('sess-bg2');
    coalescer.flush();
    assert.equal(state.isStreaming, false, '最后一条非聚焦流结束后也必须把 isStreaming 收口为 false');
    assert.equal(flushedByCoalescer.length, 0, '最后一条流结束后必须调用 coalescer.clear()');
    assert.equal(reg.size(), 0);
    assert.equal(runningBots.has('arch-bot'), false);
    assert.equal(deps.getActiveRunningSessionIds().has('sess-forever'), false);
    assert.ok(toolPatchCleared >= 2);
    assert.ok(timersStopped >= 2);
    assert.ok(watchdogEvents.includes('disarm'));

    // 4. 无 LiveStreamRegistry 降级模式下的 resumeReconnectStreaming / finishReconnectStreaming
    deps.getLiveStreamRegistry = undefined;
    fallbackDispatcher = createGatewayEventDispatcher(deps);
    deps.setActiveStreamingContext({ activeStreamingStoredSessionId: 'sess-forever', activeStreamingLiveId: 'l-old' });
    const armCountBeforeOther = watchdogEvents.filter((e) => e === 'arm').length;
    fallbackDispatcher.resumeReconnectStreaming('sess-other', 'l-ignored');
    assert.equal(deps.getActiveStreamingContext().activeStreamingLiveId, 'l-old');
    assert.equal(watchdogEvents.filter((e) => e === 'arm').length, armCountBeforeOther);
    fallbackDispatcher.resumeReconnectStreaming('sess-forever', 'l-new');
    assert.equal(deps.getActiveStreamingContext().activeStreamingLiveId, 'l-new');
    assert.equal(watchdogEvents.filter((e) => e === 'arm').length, armCountBeforeOther + 1);
    state.isStreaming = true;
    state.activeSessionId = 'sess-other-focus';
    fallbackDispatcher.finishReconnectStreaming('sess-forever');
    assert.equal(deps.getActiveStreamingContext().activeStreamingStoredSessionId, null);
    assert.equal(state.isStreaming, false, '无 streamRegistry 降级模式下即使非聚焦会话 finish 也应收口 isStreaming');
  } finally {
    coalescer.clear();
    fallbackDispatcher?.disconnect();
    dispatcher.disconnect();
  }
});

test('D6: gatewayFrameAndReconnect - idle sync / subagent.spawn_requested / TURN_STREAM_EVENT_TYPES 与畸形事件帧', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_700_000_000_000 });
  let idleSyncCount = 0;
  const reg = new LiveStreamRegistry();
  const { deps, state, watchdogEvents } = createMockDispatcherDeps({});
  deps.getLiveStreamRegistry = () => reg;
  deps.refreshActiveSession = async () => { idleSyncCount += 1; };
  state.gatewayConnected = true;

  let dispatcher;
  let noRegDispatcher;
  try {
    // 1. session.info running/streaming 命中聚焦但未注册流的会话 -> scheduleActiveSessionIdleSync(50)
    dispatcher = createGatewayEventDispatcher(deps);
    dispatcher.handleGatewayEvent({ type: 'session.info', session_id: 'live-1', payload: { streaming: true } });
    await advanceTimers(t, 49);
    assert.equal(idleSyncCount, 0, '49ms 时 session.info 触发的 50ms 空闲同步不得提前触发');
    await advanceTimers(t, 1);
    assert.ok(idleSyncCount >= 1);

    // 2. subagent.spawn_requested 带 parent_id 与直接 subagent-spawn + payload.session_id 提取 + 注册表含空 liveSessionId
    reg.registerStream({ storedSessionId: 'sess-empty-live', liveSessionId: '', messageId: 'ast-el', origin: 'local' });
    reg.getBySession('sess-empty-live').liveSessionId = '';
    dispatcher.handleGatewayEvent({
      type: 'subagent.spawn_requested',
      session_id: 'live-1',
      payload: { parent_id: 'sess-1', child_session_id: 'child-1' },
    });
    dispatcher.applyTurnActions([
      { type: 'subagent-spawn', parentSessionId: 'sess-1', subagentId: 'sa-direct', profile: 'default', title: 'direct' },
    ]);
    dispatcher.handleGatewayEvent({
      type: 'message.delta',
      payload: { session_id: 'live-1', text: 'via-payload' },
    });

    // 3. TURN_STREAM_EVENT_TYPES 自动挂载 vs 非运行/普通事件忽略 + session.info non-running 与 subagent-complete 喂狗
    for (const [idx, evtType] of [
      'message.delta',
      'message.interim',
      'thinking.delta',
      'reasoning.delta',
      'tool.start',
      'tool.complete',
      'tool.end',
      'tool.error',
    ].entries()) {
      dispatcher.handleGatewayEvent({ type: evtType, session_id: 'live-unregistered-idle', payload: { text: 'x' } });
      assert.equal(reg.hasSession('unregistered-idle'), false);

      const sid = `sess-run-rc-${idx}`;
      deps.getActiveRunningSessionIds().add(sid);
      deps.getSessionMessagesCache().set(sid, [{ id: `u-${idx}`, role: 'user', content: 'q' }]);
      dispatcher.handleGatewayEvent({ type: 'unrelated.evt', session_id: `live-${sid}`, payload: {} });
      assert.equal(reg.hasSession(sid), false);
      const payload = evtType.startsWith('tool.') ? { tool_id: 't1', name: 'read' } : { text: 'p' };
      dispatcher.handleGatewayEvent({ type: evtType, session_id: `live-${sid}`, payload });
      assert.equal(reg.hasSession(sid), true, `运行态后台会话收到 ${evtType} 必须自动挂载`);
      reg.removeSession(sid);
      deps.getActiveRunningSessionIds().delete(sid);
    }

    const feedsBeforeInfo = watchdogEvents.filter((e) => e === 'feed').length;
    dispatcher.applyTurnActions([{ type: 'session-info', sessionId: 'live-1', info: { running: false, streaming: false } }]);
    assert.equal(watchdogEvents.filter((e) => e === 'feed').length, feedsBeforeInfo);
    dispatcher.applyTurnActions([{ type: 'subagent-complete', sessionId: 'live-1', subagentId: 'sa-1' }]);
    assert.equal(watchdogEvents.filter((e) => e === 'feed').length, feedsBeforeInfo + 1);

    // 4. 缺失 streamRegistry + 畸形事件帧分支
    const { deps: depsNoReg, state: stateNoReg } = createMockDispatcherDeps({});
    stateNoReg.gatewayConnected = true;
    noRegDispatcher = createGatewayEventDispatcher(depsNoReg);
    noRegDispatcher.handleGatewayEvent(null);
    noRegDispatcher.handleGatewayEvent({ event: 'custom.evt', payload: [] });
    noRegDispatcher.handleGatewayEvent({ kind: 'custom.kind', payload: {} });
    noRegDispatcher.handleGatewayEvent({ payload: {} });
  } finally {
    noRegDispatcher?.disconnect();
    dispatcher?.disconnect();
    t.mock.timers.reset();
  }
});

test('D6: gatewayEventDispatcher - frame parsing/session-info/subagent-failed/resolvedStreamingMessageId 与 disconnect 定时器及水合清理', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_700_000_000_000 });
  let coalescer;
  let dispatcher;
  try {
    const reg = new LiveStreamRegistry();
    const flushedTokens = [];
    coalescer = new TokenCoalescer((map) => {
      for (const [messageId, entry] of map.entries()) {
        flushedTokens.push({ messageId, content: entry.content, thought: entry.thought });
      }
    });
    const { deps, state, rendered, watchdogEvents } = createMockDispatcherDeps({
      state: {
        activeSessionId: 'sess-focus',
        activeLiveSessionId: '',
        gatewayConnected: true,
        sessions: [{ id: 'sess-focus', title: 'Focus', botName: 'default', preview: '', timestamp: 10 }],
      },
      activeStreamingContext: {
        activeStreamingStoredSessionId: null,
        activeStreamingLiveId: null,
        activeStreamingMessageId: null,
        activeStreamingBotName: null,
      },
    });
    let idleSyncCount = 0;
    let resumeCalls = 0;
    let holdResumeResolve = null;
    const fakeClient = {
      disconnect() {},
      call: async (method) => {
        if (method === 'session.resume') {
          resumeCalls += 1;
          if (resumeCalls === 1) {
            return await new Promise((resolve) => { holdResumeResolve = resolve; });
          }
          return { running: true, messages: [{ role: 'user', content: 'hyd2' }] };
        }
        return null;
      },
    };
    deps.setGatewayClient(fakeClient);
    deps.getLiveStreamRegistry = () => reg;
    deps.getTokenCoalescer = () => coalescer;
    deps.refreshActiveSession = async () => { idleSyncCount += 1; };
    deps.resolveBotNameForSession = () => null;
    deps.toStoredSessionId = (id) => (id?.startsWith('live-') ? id.replace(/^live-/, '') : id || null);
    deps.getActiveRunningSessionIds().clear();

    dispatcher = createGatewayEventDispatcher(deps);
    const statusList = [];
    deps.onStatusTurnAction = (a) => statusList.push(a.type);
    const feedsBefore = watchdogEvents.filter((e) => e === 'feed').length;

    dispatcher.applyTurnActions([
      { type: 'subagent-failed', sessionId: 'live-unknown-sa', subagentId: 'sa-f', error: 'err' },
      { type: 'session-info', sessionId: 'live-sess-unknown', info: null },
      { type: 'session-info', sessionId: 'live-sess-unknown', info: { running: true } },
    ]);
    assert.deepEqual(statusList, ['subagent-failed', 'session-info', 'session-info']);
    assert.equal(watchdogEvents.filter((e) => e === 'feed').length, feedsBefore, '未知非活跃 session-info / subagent 不得喂狗');

    // a) 仅在 streamRegistry
    reg.registerStream({ storedSessionId: 'sess-reg-only', liveSessionId: 'custom-ws-handle-1', messageId: 'm-reg', origin: 'local', nowMs: 100 });
    const f1 = watchdogEvents.filter((e) => e === 'feed').length;
    dispatcher.applyTurnActions([{ type: 'session-info', sessionId: 'custom-ws-handle-1', info: { running: true } }]);
    assert.equal(watchdogEvents.filter((e) => e === 'feed').length, f1 + 1);
    assert.ok(reg.getBySession('sess-reg-only').lastActivityAt > 100);
    reg.registerStream({ storedSessionId: 'sess-focus', liveSessionId: 'live-sess-focus', messageId: 'm-foc', origin: 'local' });
    dispatcher.applyTurnActions([{ type: 'session-info', sessionId: 'live-sess-focus', info: { streaming: true } }]);
    assert.equal(watchdogEvents.filter((e) => e === 'feed').length, f1 + 2);
    await advanceTimers(t, 50);
    assert.equal(idleSyncCount, 0, '已注册流收到 session.info 不得重复触发 idleSync');
    reg.removeSession('sess-focus');

    // b) 仅在 ctx.activeStreamingStoredSessionId
    deps.setActiveStreamingContext({ activeStreamingStoredSessionId: 'sess-ctx-i', activeStreamingMessageId: 'm-ctx-i' });
    const f2 = watchdogEvents.filter((e) => e === 'feed').length;
    dispatcher.applyTurnActions([
      { type: 'session-info', sessionId: 'live-sess-ctx-i', info: { running: false, streaming: true } },
      { type: 'subagent-progress', sessionId: 'live-sess-ctx-i', subagentId: 'sa-ctx', status: 'ok' },
    ]);
    assert.equal(watchdogEvents.filter((e) => e === 'feed').length, f2 + 2);
    deps.setActiveStreamingContext({ activeStreamingStoredSessionId: null, activeStreamingMessageId: null });

    // c) 仅在 runningSet
    deps.getActiveRunningSessionIds().add('sess-runset-i');
    const f3 = watchdogEvents.filter((e) => e === 'feed').length;
    dispatcher.applyTurnActions([{ type: 'session-info', sessionId: 'live-sess-runset-i', info: { running: true } }]);
    assert.equal(watchdogEvents.filter((e) => e === 'feed').length, f3 + 1);
    deps.getActiveRunningSessionIds().delete('sess-runset-i');

    // 2. registeredLiveIds 差异句柄路由 + framePayload array 安全兜底 + payload.session_id 识别
    flushedTokens.length = 0;
    dispatcher.handleGatewayEvent({
      type: 'message.delta',
      session_id: 'custom-ws-handle-1',
      payload: { text: 'via-custom-handle' },
    });
    coalescer.flush();
    assert.equal(flushedTokens.some((x) => x.messageId === 'm-reg' && x.content === 'via-custom-handle'), true);

    dispatcher.handleGatewayEvent({ type: 'message.start', session_id: 'live-sess-focus', payload: ['bad-array'] });
    assert.equal(reg.hasSession('sess-focus'), true, 'focused 会话收到无 turn_id message.start 会挂载流但不应读数组下标');
    reg.removeSession('sess-focus');

    state.sessions.push({ id: 'p-only', title: 'POnly', botName: '', preview: '', timestamp: 20 });
    deps.getSessionMessagesCache().set('p-only', []);
    dispatcher.handleGatewayEvent({
      type: 'message.start',
      session_id: '',
      payload: { session_id: 'live-p-only', turn_id: 't-po', text: 'text-from-p' },
    });
    assert.equal(reg.hasSession('p-only'), true);
    assert.equal(reg.getBySession('p-only').turnId, 't-po');
    assert.equal(deps.getSessionMessagesCache().get('p-only').some((m) => m.role === 'user' && m.content === 'text-from-p'), true);

    // 3. isKnownSession: 仅 state.sessions 命中 vs 仅 resolveBotNameForSession 命中 vs 完全未知不挂载
    dispatcher.handleGatewayEvent({ type: 'message.start', session_id: 'live-totally-unknown', payload: { text: 'ignore' } });
    assert.equal(reg.hasSession('totally-unknown'), false, '完全未知会话即使收到 message.start 也不得误挂载');

    deps.resolveBotNameForSession = (sid) => (sid === 'sess-bot-only' ? 'bot-only' : null);
    deps.getSessionMessagesCache().set('sess-bot-only', []);
    dispatcher.handleGatewayEvent({
      kind: 'message.start',
      session_id: 'live-sess-bot-only',
      payload: { turn_id: 't-kind', display_text: 'kind-display', text: 'kind-raw' },
    });
    assert.equal(reg.hasSession('sess-bot-only'), true, 'resolveBotNameForSession 命中已知 Bot 且 kind=message.start 必须挂载并提取 display_text/turn_id');
    assert.equal(reg.getBySession('sess-bot-only').turnId, 't-kind');
    assert.equal(deps.getSessionMessagesCache().get('sess-bot-only').some((m) => m.role === 'user' && m.content === 'kind-display'), true);

    state.activeSessionId = 'sess-focus-by-id';
    state.activeLiveSessionId = '';
    state.isStreaming = false;
    deps.getSessionMessagesCache().set('sess-focus-by-id', []);
    let syncPresenceCount = 0;
    deps.syncAgentPresence = () => { syncPresenceCount += 1; };
    const rendersBeforeFocById = rendered.length;
    dispatcher.handleGatewayEvent({
      kind: 'message.start',
      session_id: 'live-sess-focus-by-id',
      payload: { text: 'kind-text-fallback' },
    });
    assert.equal(reg.hasSession('sess-focus-by-id'), true);
    assert.equal(state.isStreaming, true, 'activeIds.push 必须将聚焦新流推入 reduceGatewayEvent 识别队列');
    assert.equal(rendered.length, rendersBeforeFocById + 1, 'needsRender=true 必须触发 deps.render()');
    assert.equal(syncPresenceCount, 1, 'applyTurnActions 每次收尾必须调用 syncAgentPresence()');
    dispatcher.applyTurnActions([{ type: 'append-thought', messageId: 'm-none', text: 't' }]);
    assert.equal(rendered.length, rendersBeforeFocById + 1, 'needsRender=false 不得多余重绘');
    assert.equal(syncPresenceCount, 2);
    const rendersBeforeTitle = rendered.length;
    dispatcher.applyTurnActions([{ type: 'session-title', sessionId: 'sess-focus', title: 'Updated Title' }]);
    assert.equal(rendered.length, rendersBeforeTitle + 1, 'session-title 置 needsRender=true 时必须触发 L824 deps.render()');
    assert.equal(syncPresenceCount, 3);
    assert.equal(deps.getSessionMessagesCache().get('sess-focus-by-id').some((m) => m.content === 'kind-text-fallback'), true);
    reg.removeSession('sess-focus-by-id');
    state.isStreaming = false;

    // 4. resolvedStreamingMessageId 当无 streamRegistry 注册项时
    state.activeSessionId = 'sess-other-ui';
    deps.setActiveStreamingContext({
      activeStreamingStoredSessionId: 'sess-unreg-ctx',
      activeStreamingMessageId: 'msg-unreg-ctx',
      activeStreamingLiveId: 'live-sess-mismatch-active',
    });
    flushedTokens.length = 0;
    dispatcher.handleGatewayEvent({ type: 'message.delta', session_id: 'live-sess-unreg-ctx', payload: { text: 'ctx-hit' } });
    dispatcher.handleGatewayEvent({ type: 'message.delta', session_id: 'live-sess-mismatch-active', payload: { text: 'ctx-miss' } });
    coalescer.flush();
    assert.equal(flushedTokens.find((x) => x.messageId === 'msg-unreg-ctx')?.content, 'ctx-hit');
    assert.equal(
      flushedTokens.some((x) => x.content.includes('ctx-miss')),
      false,
      'session 不匹配时 resolvedStreamingMessageId 必须返回 null，严禁路由到 ctx.activeStreamingMessageId',
    );
    deps.setActiveStreamingContext({ activeStreamingStoredSessionId: null, activeStreamingMessageId: null, activeStreamingLiveId: null });

    // 5. disconnect 取消待发 idleSync timer 并清空 hydratingRemoteSessions
    state.activeSessionId = 'sess-focus';
    state.isStreaming = false;
    idleSyncCount = 0;
    dispatcher.applyTurnActions([{ type: 'session-info', sessionId: 'live-sess-focus', info: { running: true } }]);
    let releaseHyd = null;
    let hydCount = 0;
    deps.setGatewayClient({
      disconnect() {},
      call: async (method) => {
        if (method === 'session.resume') {
          hydCount += 1;
          return await new Promise((resolve) => { releaseHyd = resolve; });
        }
        return null;
      },
    });
    deps.getSessionMessagesCache().set('sess-hyd', []);
    deps.getActiveRunningSessionIds().add('sess-hyd');
    dispatcher.handleGatewayEvent({ type: 'message.delta', session_id: 'live-sess-hyd', payload: { text: 'd1' } });
    assert.equal(hydCount, 1);
    reg.removeSession('sess-hyd');
    dispatcher.handleGatewayEvent({ type: 'message.delta', session_id: 'live-sess-hyd', payload: { text: 'd1b' } });
    assert.equal(hydCount, 1);

    dispatcher.disconnect();
    await advanceTimers(t, 50);
    assert.equal(idleSyncCount, 0, 'disconnect 必须清除 clearActiveSessionSyncTimer 防止断开后触发 stale sync');

    const resumeBeforeRehyd = resumeCalls;
    deps.setGatewayClient(fakeClient);
    deps.getActiveRunningSessionIds().add('sess-hyd');
    dispatcher.handleGatewayEvent({ type: 'message.delta', session_id: 'live-sess-hyd', payload: { text: 'd2' } });
    assert.equal(hydCount, 1);
    assert.equal(resumeCalls, resumeBeforeRehyd + 1, 'disconnect 调用 clearHydrationState 后应解除 hydratingRemoteSessions 去重锁');
    releaseHyd?.(null);
    holdResumeResolve?.(null);
    await flushMicrotasks();
  } finally {
    coalescer?.clear();
    dispatcher?.disconnect();
    t.mock.timers.reset();
  }
});

test('D6: gatewayEventDispatcher - 交互 TurnAction 分发、approval_mode 同步与 frame.kind / payload.session_id 回退', () => {
  const interactiveActions = [];
  const notifications = [];
  let riskReturn = true;
  const riskEvents = [];
  const { deps, rendered, state } = createMockDispatcherDeps();
  state.activeSessionId = 'sess-1';
  state.approvalMode = 'manual';
  deps.onInteractiveTurnAction = (action) => interactiveActions.push(action);
  deps.onGatewayNotification = (action) => notifications.push(action);
  deps.onToolOutputRisk = (action) => {
    riskEvents.push(action);
    return riskReturn;
  };
  const dispatcher = createGatewayEventDispatcher(deps);
  try {
    // 1. session-info syncs approval_mode (manual / smart / off) & ignores unsupported values
    for (const mode of ['smart', 'off', 'manual']) {
      const prevR = rendered.length;
      dispatcher.applyTurnActions([{ type: 'session-info', sessionId: 'sess-1', info: { approval_mode: mode } }]);
      assert.equal(state.approvalMode, mode);
      assert.equal(rendered.length, prevR + 1);
    }
    const rBeforeInvalid = rendered.length;
    dispatcher.applyTurnActions([{ type: 'session-info', sessionId: 'sess-1', info: { approval_mode: 'bogus' } }]);
    assert.equal(state.approvalMode, 'manual');
    assert.equal(rendered.length, rBeforeInvalid);
    assert.equal(interactiveActions.length, 4);

    // 2. request-cancel / approval-cancelled / connection-request / connection-update / gateway-ready trigger onInteractiveTurnAction + render
    for (const act of [
      { type: 'request-cancel', id: 'rc-1', method: 'approval', reason: 'done' },
      { type: 'approval-cancelled', sessionId: 'live-1', reason: 'x', cancelledCount: 1, requestIds: ['a1'] },
      { type: 'connection-request', sessionId: 'live-1', payload: { op_id: 'op-1', seq: 1, deadline_at: 2, timeout_seconds: 10, targets: [] } },
      { type: 'connection-update', sessionId: 'live-1', payload: { op_id: 'op-1', seq: 2, deadline_at: 2, settled: true, targets: [] } },
      { type: 'gateway-ready', replayEpoch: 'ep-1', sessionAuthority: true },
    ]) {
      const prevR = rendered.length;
      dispatcher.applyTurnActions([act]);
      assert.equal(rendered.length, prevR + 1);
    }
    assert.equal(interactiveActions.length, 9);

    // 3. tool-output-risk: true -> render, false -> no render
    const rRisk1 = rendered.length;
    dispatcher.applyTurnActions([{ type: 'tool-output-risk', toolCallId: 'tc-1', risk: 'high', findings: ['leak'], redacted: true }]);
    assert.equal(rendered.length, rRisk1 + 1);
    riskReturn = false;
    dispatcher.applyTurnActions([{ type: 'tool-output-risk', toolCallId: 'tc-2', risk: 'low', findings: [], redacted: false }]);
    assert.equal(rendered.length, rRisk1 + 1);
    assert.equal(riskEvents.length, 2);

    // 4. notification-show / notification-clear call onGatewayNotification without render
    const rNotif = rendered.length;
    dispatcher.applyTurnActions([
      { type: 'notification-show', text: 'hi', level: 'info', kind: 'notice' },
      { type: 'notification-clear', key: 'k1' },
    ]);
    assert.equal(notifications.length, 2);
    assert.equal(rendered.length, rNotif);

    // 5. handleGatewayEvent frame.type/event/kind + frameRec.session_id / framePayload.session_id parsing
    const reg = new LiveStreamRegistry();
    deps.getLiveStreamRegistry = () => reg;
    const disp2 = createGatewayEventDispatcher(deps);
    try {
      disp2.handleGatewayEvent({
        type: 'request.cancel',
        payload: { session_id: 'live-1', id: 'rk-pl', reason: 'timeout' },
      });
      disp2.handleGatewayEvent({
        type: 'connection.update',
        session_id: 'live-1',
        payload: { op_id: 'op-pl', seq: 3, deadline_at: 4, settled: false, targets: [] },
      });
      assert.equal(interactiveActions.at(-2)?.id, 'rk-pl');
      assert.equal(interactiveActions.at(-2)?.sessionId, undefined);
      assert.equal(interactiveActions.at(-1)?.payload?.op_id, 'op-pl');
      assert.equal(interactiveActions.at(-1)?.sessionId, 'live-1');

      state.activeSessionId = 's-kind';
      disp2.handleGatewayEvent({ kind: 'message.start', session_id: 'live-s-kind', payload: { text: 'hk' } });
      state.activeSessionId = 's-ev';
      disp2.handleGatewayEvent({ event: 'message.start', payload: { session_id: 'live-s-ev', text: 'he' } });
      assert.equal(reg.hasSession('s-kind'), true);
      assert.equal(reg.hasSession('s-ev'), true);
    } finally {
      disp2.disconnect();
    }
  } finally {
    dispatcher.disconnect();
  }
});

test('GatewayEventDispatcher 多网关帧路由：handleGatewayEvent / projects.changed / session-info 按 sourceGatewayId 严格隔离', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const regA = new LiveStreamRegistry();
  const regB = new LiveStreamRegistry();
  let fetchProjectsCalls = 0;
  let idleSyncCalls = 0;
  const { deps, state, watchdogEvents } = createMockDispatcherDeps({
    state: {
      gatewayCount: 2,
      gatewayConnected: true,
      activeSessionId: 'sess-dup',
      activeLiveSessionId: 'live-dup',
      activeGatewayId: 'gw-a',
      activeFocus: { type: 'session', sessionId: 'sess-dup', gatewayId: 'gw-a' },
      sessions: [
        { id: 'sess-dup', gatewayId: 'gw-a', title: 'Alpha Dup', botName: 'alpha-bot', preview: '', timestamp: 10 },
        { id: 'sess-dup', gatewayId: 'gw-b', title: 'Beta Dup', botName: 'beta-bot', preview: '', timestamp: 20 },
      ],
    },
  });
  deps.getLiveStreamRegistry = () => regA;
  deps.getLiveStreamRegistryForGateway = (gw) => (gw === 'gw-a' ? regA : gw === 'gw-b' ? regB : undefined);
  deps.getSessionHandleRegistryForGateway = () => ({
    getLiveIds: (ids) => ids.map((id) => `live-${id}`),
    toLiveId: (id) => `live-${id}`,
    toStoredId: (id) => (id === 'live-dup' ? 'sess-dup' : id.replace(/^live-/, '')),
    register: () => {},
    clear: () => {},
  });
  deps.fetchProjects = async () => { fetchProjectsCalls += 1; };
  deps.resolveBotNameForSession = () => null;
  deps.refreshActiveSession = async () => { idleSyncCalls += 1; };
  const dispatcher = createGatewayEventDispatcher(deps);
  try {
    // 1. projects.changed from non-active gw-b must NOT refresh projects; from active gw-a MUST
    dispatcher.handleGatewayEvent({ type: 'projects.changed', payload: {} }, 'gw-b');
    assert.equal(fetchProjectsCalls, 0);
    dispatcher.handleGatewayEvent({ type: 'projects.changed', payload: {} }, 'gw-a');
    assert.equal(fetchProjectsCalls, 1);

    // 2. message.start from gw-b matching known session 'sess-dup' attaches observer to regB ONLY without hijacking Alpha active state
    state.isStreaming = false;
    dispatcher.handleGatewayEvent({ type: 'message.start', session_id: 'live-dup', payload: { turn_id: 't-b', text: 'bg user' } }, 'gw-b');
    assert.equal(regB.hasSession('sess-dup'), true, 'gw-b 已知会话应挂载到 regB');
    assert.equal(regA.hasSession('sess-dup'), false, 'gw-b 帧不得污染 regA');
    assert.equal(state.isStreaming, false, '非焦点网关 gw-b 不得激活 gw-a 前台流状态');

    // 3. session-info with running=true feeds regB watchdog without scheduling focused idle sync; focused gw-a schedules idle sync without mutating regA
    watchdogEvents.length = 0;
    dispatcher.applyTurnActions([{ type: 'session-info', sessionId: 'sess-dup', info: { running: true } }], 'gw-b');
    assert.ok(watchdogEvents.includes('feed'), 'regB 存在会话流时 gw-b session-info 应触发看门狗续期');
    t.mock.timers.tick(100);
    assert.equal(idleSyncCalls, 0, '非焦点网关 gw-b 不得触发前台闲置同步');

    dispatcher.applyTurnActions([{ type: 'session-info', sessionId: 'sess-dup', info: { running: true } }], 'gw-a');
    assert.equal(idleSyncCalls, 0);
    t.mock.timers.tick(60);
    assert.equal(idleSyncCalls, 1);
    assert.equal(regA.hasSession('sess-dup'), false);
  } finally {
    dispatcher.disconnect();
  }
});
