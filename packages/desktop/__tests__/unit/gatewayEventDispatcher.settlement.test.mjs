/**
 * GatewayEventDispatcher 回合收口 (turn-completed / turn-failed / session-reclaimed) 与工具/缓存收敛单测
 * (packages/desktop/__tests__/unit/gatewayEventDispatcher.settlement.test.mjs)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveStreamRegistry } from '@hermes-flux/core';
import { createGatewayEventDispatcher } from '../../dist/renderer/gateway/gatewayEventDispatcher.mjs';
import { advanceTimers, createMockDispatcherDeps } from './helpers/gatewayDispatcherHarness.mjs';

test('D6: gatewayEventDispatcher - 低频边界 turn-completed 触发 render 与状态收拢', () => {
  const { deps, state, rendered, completedEntityTurns, watchdogEvents, activeStreamingContext } = createMockDispatcherDeps();
  const dispatcher = createGatewayEventDispatcher(deps);

  dispatcher.applyTurnActions([
    {
      type: 'turn-completed',
      sessionId: 'sess-1',
    },
  ]);

  assert.ok(rendered.length > 0, 'turn-completed 必须调用 render()');
  assert.equal(state.isStreaming, false);
  assert.ok(watchdogEvents.includes('disarm'));
  assert.equal(activeStreamingContext().activeStreamingMessageId, null);
  assert.equal(completedEntityTurns.length, 1);
  assert.equal(completedEntityTurns[0].entityId, 'sess-1');
});

test('D6: gatewayEventDispatcher - turn-failed 落终态快照与错误呈现', () => {
  const { deps, state, rendered, presenceEvents, watchdogEvents } = createMockDispatcherDeps();
  const dispatcher = createGatewayEventDispatcher(deps);

  dispatcher.applyTurnActions([
    {
      type: 'turn-failed',
      sessionId: 'sess-1',
      message: 'Rate limit exceeded 429',
    },
  ]);

  assert.ok(rendered.length > 0);
  assert.equal(state.isStreaming, false);
  assert.ok(watchdogEvents.includes('disarm'));
  const failedPresence = presenceEvents.find((p) => p && typeof p === 'object' && p.kind === 'failed');
  assert.ok(failedPresence, '失败事件必须落入终态快照');
  assert.equal(failedPresence.message, 'Rate limit exceeded 429');
});

test('D6: gatewayEventDispatcher - turn-completed 前贴底时即使 finalReplace/flush 撑高容器也必须锁定贴底', () => {
  // 1. 前置贴底：flush/setMessageContent 执行后容器变高导致 isNearBottom 变 false，仍须触发 setPendingScrollToBottom(true)
  let nearBottom = true;
  const pendingCalls = [];
  const { deps, state } = createMockDispatcherDeps();
  deps.isStreamNearBottom = () => nearBottom;
  deps.setPendingScrollToBottom = (val) => pendingCalls.push(val);
  deps.getTokenCoalescer = () => ({
    push: () => {},
    flush: () => { nearBottom = false; },
    clear: () => {},
  });
  deps.setMessageContent = () => { nearBottom = false; };
  state.activeSessionId = 'sess-1';
  state.messages.push({ id: 'msg-1', role: 'assistant', content: 'hi', timestamp: '10:00' });
  const dispatcher = createGatewayEventDispatcher(deps);

  dispatcher.applyTurnActions([
    { type: 'replace-content', messageId: 'msg-1', text: 'very long final response...' },
    { type: 'turn-completed', sessionId: 'sess-1' },
  ]);
  assert.deepEqual(pendingCalls, [true], '流式结束前原本贴底时，必须锁定本次 render 的贴底意图');

  // 2. 前置非贴底（用户正在向上回看历史）：绝不能强行拉回底部
  nearBottom = false;
  pendingCalls.length = 0;
  dispatcher.applyTurnActions([{ type: 'turn-completed', sessionId: 'sess-1' }]);
  assert.deepEqual(pendingCalls, [], '用户原本不在底部时不得触发贴底');

  // 3. 后台非当前聚焦会话完成：不得触发当前视口贴底
  nearBottom = true;
  pendingCalls.length = 0;
  dispatcher.applyTurnActions([{ type: 'turn-completed', sessionId: 'sess-other' }]);
  assert.deepEqual(pendingCalls, [], '后台会话完成不得触发当前会话视口贴底');
});

test('D6: gatewayEventDispatcher - turn-completed / turn-failed / disconnect 必须清空 toolPatchQueue，且 turn-failed 不双 render', () => {
  let clearToolPatchCalls = 0;
  let syncPresenceCalls = 0;
  const pendingCalls = [];
  const { deps, state, rendered } = createMockDispatcherDeps();
  deps.clearToolPatchQueue = () => { clearToolPatchCalls += 1; };
  deps.syncAgentPresence = () => { syncPresenceCalls += 1; };
  deps.isStreamNearBottom = () => true;
  deps.setPendingScrollToBottom = (val) => pendingCalls.push(val);
  // 模拟真实 turnExecutionService.setTimedDockNotice：未传 skipRender 时会同步调用 render()
  deps.setTimedDockNotice = (msg, _dur, opts) => {
    state.dockNotice = msg;
    if (!opts?.skipRender) {
      deps.render();
    }
  };
  const dispatcher = createGatewayEventDispatcher(deps);

  // 1. turn-completed 清理工具补丁队列
  dispatcher.applyTurnActions([{ type: 'turn-completed', sessionId: 'sess-1' }]);
  assert.equal(clearToolPatchCalls, 1, 'turn-completed 必须清空 toolPatchQueue，防止迟到 rAF 覆写 React DOM');

  // 2. turn-failed 清理队列且仅触发唯一一次 render()（消除双 render）
  rendered.length = 0;
  syncPresenceCalls = 0;
  pendingCalls.length = 0;
  state.isStreaming = true;
  deps.setActiveStreamingContext({
    activeStreamingMessageId: 'ast-1',
    activeStreamingStoredSessionId: 'sess-1',
    activeStreamingLiveId: 'live-1',
  });
  dispatcher.applyTurnActions([{ type: 'turn-failed', sessionId: 'sess-1', message: 'boom 500' }]);
  assert.equal(clearToolPatchCalls, 2, 'turn-failed 必须清空 toolPatchQueue');
  assert.equal(rendered.length, 1, 'turn-failed 必须只触发唯一一次 render()，严禁 setTimedDockNotice + needsRender 双渲染');
  assert.equal(syncPresenceCalls, 1, 'turn-failed 仍须同步在场指示器');
  assert.equal(state.dockNotice, 'boom 500', '错误提示仍须落盘至 dockNotice');
  assert.deepEqual(pendingCalls, [true], 'turn-failed 前贴底时必须保留贴底意图');

  // 3. disconnect 清理队列
  dispatcher.disconnect();
  assert.equal(clearToolPatchCalls, 3, 'disconnect 必须清空 toolPatchQueue');
});

test('D6: gatewayEventDispatcher - turn-completed / turn-failed 全链路收口变异杀伤（工具收敛/缓存持久化/会话置顶/Bot与后台态）', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_700_000_000_000 });
  let dispatcher;
  try {
    const flushCalls = [];
    const stopTimerCalls = [];
    const setContentCalls = [];
    const completeCalls = [];
    const persistTurnCalls = [];
    const persistSessionsCalls = [];
    const botActivityCalls = [];
    const syncProfileCalls = [];
    const turnStartedSessionCalls = [];
    const clearPresenceCalls = [];
    const trackerClears = [];
    const pendingCalls = [];

    const { deps, state } = createMockDispatcherDeps({
      state: {
        activeSessionId: 'sess-1',
        activeFocus: { type: 'bot', botName: 'arch-bot' },
        sessions: [
          { id: 'sess-top', title: 'Top', botName: 'default', preview: 'old', timestamp: 100 },
          { id: 'sess-1', title: 'Task 1', botName: 'arch-bot', preview: '', timestamp: 50 },
          { id: 'sess-bg', title: 'Bg', botName: 'default', preview: '', timestamp: 20 },
        ],
        messages: [
          { id: 'usr-1', role: 'user', content: 'hi', timestamp: '12:00:00' },
          {
            id: 'ast-1',
            role: 'assistant',
            content: 'draft',
            timestamp: '12:00:01',
            toolCalls: [
              { id: 't1', name: 'read', status: 'running', startTime: Date.now() - 500 },
              { id: 't2', name: 'fast', status: 'running', startTime: Date.now() - 5 },
              { id: 't3', name: 'preset', status: 'running', startTime: Date.now() - 900, durationMs: 321 },
              { id: 't4', name: 'err', status: 'failed', startTime: Date.now() - 900 },
            ],
          },
        ],
      },
      activeStreamingContext: {
        activeStreamingMessageId: 'ast-1',
        activeStreamingStoredSessionId: 'sess-1',
        activeStreamingLiveId: 'live-1',
        activeStreamingBotName: 'arch-bot',
      },
    });

    deps.getTokenCoalescer = () => ({ enqueue: () => {}, flush: () => flushCalls.push(1), clear: () => {} });
    deps.stopRunningToolTimers = () => stopTimerCalls.push(1);
    deps.setMessageContent = (id, text) => {
      setContentCalls.push([id, text]);
      const m = state.messages.find((x) => x.id === id);
      if (m) m.content = text;
    };
    deps.completeEntityTurn = (kind, _run, _unread, id, focused) => completeCalls.push({ kind, id, focused });
    deps.persistTurnToCache = (sid, bot, msgs) => persistTurnCalls.push({ sid, bot, count: msgs.length });
    deps.persistSessionsToCache = (sessions) => persistSessionsCalls.push(sessions.map((s) => s.id));
    deps.getBotActivityStore = () => ({
      updateLatestActivity: (bot, content) => botActivityCalls.push({ bot, content }),
    });
    deps.syncProfileLastMessages = () => syncProfileCalls.push(1);
    deps.setTurnStartedSessionId = (id) => turnStartedSessionCalls.push(id);
    deps.clearPresenceTerminal = () => clearPresenceCalls.push(1);
    deps.getActivityTransitionTracker = () => ({ clear: (kind, id) => trackerClears.push([kind, id]), clearAll: () => {} });
    deps.setPendingScrollToBottom = (v) => pendingCalls.push(v);
    deps.t = (k, p) => (p ? `${k}:${JSON.stringify(p)}` : k);
    // 故意不注入 isStreamNearBottom，验证默认回落为 false（不得误触发贴底）
    deps.isStreamNearBottom = undefined;

    // 缓存含多条消息，确保 replace-content 按 id 精确匹配
    const cachedSess1 = [
      { id: 'usr-1', role: 'user', content: 'hi' },
      { id: 'ast-1', role: 'assistant', content: 'draft' },
    ];
    deps.getSessionMessagesCache().set('sess-1', cachedSess1);

    dispatcher = createGatewayEventDispatcher(deps);
    dispatcher.applyTurnActions([
      { type: 'replace-content', messageId: 'ast-1', text: 'Final Answer' },
      { type: 'turn-completed' }, // 缺 action.sessionId，必须回退到 ctx.activeStreamingStoredSessionId
    ]);

    assert.equal(flushCalls.length, 1);
    assert.equal(stopTimerCalls.length, 1);
    assert.deepEqual(setContentCalls, [['ast-1', 'Final Answer']]);
    assert.equal(cachedSess1[0].content, 'hi', 'replace-content 严禁误改非目标缓存消息');
    assert.equal(cachedSess1[1].content, 'Final Answer', 'replace-content 必须同步更新目标缓存消息');

    const tcs = state.messages[1].toolCalls;
    assert.equal(tcs[0].status, 'completed');
    assert.ok(tcs[0].durationMs >= 400, '已运行 500ms 的工具 durationMs 应反映真实耗时');
    assert.equal(tcs[1].status, 'completed');
    assert.equal(tcs[1].durationMs, 100, '极短耗时工具 durationMs 应由 Math.max(100, ...) 兜底为 100');
    assert.equal(tcs[2].durationMs, 321, '已有 durationMs 不得被覆写');
    assert.equal(tcs[3].status, 'failed', '非 running 状态工具不得被改成 completed');

    assert.deepEqual(pendingCalls, [], '未注入 isStreamNearBottom 时默认 false，不得触发贴底');
    assert.deepEqual(completeCalls, [
      { kind: 'session', id: 'sess-1', focused: true },
      { kind: 'bot', id: 'arch-bot', focused: true },
    ]);
    assert.equal(persistTurnCalls.length, 1);
    assert.equal(persistTurnCalls[0].sid, 'sess-1');
    assert.equal(persistTurnCalls[0].count, 2);
    assert.equal(state.sessions[0].id, 'sess-1', '完成会话必须置顶到 state.sessions[0]');
    assert.equal(state.sessions[0].preview, 'Final Answer');
    assert.deepEqual(persistSessionsCalls[0], ['sess-1', 'sess-top', 'sess-bg']);
    assert.deepEqual(botActivityCalls, [{ bot: 'arch-bot', content: 'Final Answer' }]);
    assert.equal(syncProfileCalls.length, 1);
    assert.deepEqual(turnStartedSessionCalls, [null]);
    assert.equal(clearPresenceCalls.length, 1);
    assert.equal(deps.getActiveStreamingContext().activeStreamingBotName, null);

    // 2. 后台非聚焦会话 + 后台 Bot 完成：从 sessionMessagesCache 取终答并更新 preview/botActivity
    completeCalls.length = 0;
    persistTurnCalls.length = 0;
    botActivityCalls.length = 0;
    deps.getSessionMessagesCache().set('sess-bg', [
      { id: 'bg-u', role: 'user', content: 'bg q' },
      { id: 'bg-a', role: 'assistant', content: 'Background Final' },
    ]);
    deps.setActiveStreamingContext({
      activeStreamingMessageId: 'bg-a',
      activeStreamingStoredSessionId: 'sess-bg',
      activeStreamingLiveId: 'live-bg',
      activeStreamingBotName: 'bg-bot',
    });
    dispatcher.applyTurnActions([{ type: 'turn-completed', sessionId: 'sess-bg' }]);
    assert.equal(persistTurnCalls[0].sid, 'sess-bg');
    assert.equal(state.sessions[0].id, 'sess-bg');
    assert.equal(state.sessions[0].preview, 'Background Final');
    assert.deepEqual(botActivityCalls, [{ bot: 'bg-bot', content: 'Background Final' }]);
    assert.deepEqual(completeCalls, [
      { kind: 'session', id: 'sess-bg', focused: false },
      { kind: 'bot', id: 'bg-bot', focused: false },
    ]);

    // 3. turn-failed：空消息填充错误前缀、非空消息不覆盖、清理 runningSession/runningBot/tracker 与 activeStreamingContext
    flushCalls.length = 0;
    stopTimerCalls.length = 0;
    syncProfileCalls.length = 0;
    trackerClears.length = 0;
    pendingCalls.length = 0;
    state.messages.push({ id: 'ast-empty', role: 'assistant', content: '', timestamp: '12:00:02' });
    deps.getActiveRunningSessionIds().add('sess-1');
    deps.getActiveRunningBotNames().add('fail-bot');
    deps.setActiveStreamingContext({
      activeStreamingMessageId: 'ast-empty',
      activeStreamingStoredSessionId: 'sess-1',
      activeStreamingLiveId: 'live-1',
      activeStreamingBotName: 'fail-bot',
    });
    dispatcher.applyTurnActions([{ type: 'turn-failed', message: 'net err' }]);
    assert.equal(flushCalls.length, 1);
    assert.equal(stopTimerCalls.length, 1);
    assert.equal(syncProfileCalls.length, 1);
    assert.ok(state.messages.find((m) => m.id === 'ast-empty').content.includes('net err'), '空正文必须回填错误文案');
    assert.equal(deps.getActiveRunningSessionIds().has('sess-1'), false);
    assert.equal(deps.getActiveRunningBotNames().has('fail-bot'), false);
    assert.deepEqual(trackerClears, [['session', 'sess-1'], ['bot', 'fail-bot']]);
    assert.equal(deps.getActiveStreamingContext().activeStreamingMessageId, null);
    assert.equal(deps.getActiveStreamingContext().activeStreamingStoredSessionId, null);
    assert.equal(deps.getActiveStreamingContext().activeStreamingBotName, null);
    assert.deepEqual(pendingCalls, [], '未注入 isStreamNearBottom 时 turn-failed 默认 false，不得误触发贴底');

    // 非空消息 fail 不得覆写已有正文，且后台会话 fail 即使贴底也不得触发当前视口贴底
    deps.isStreamNearBottom = () => true;
    state.messages.push({ id: 'ast-nonempty', role: 'assistant', content: 'Keep me', timestamp: '12:00:03' });
    deps.setActiveStreamingContext({
      activeStreamingMessageId: 'ast-nonempty',
      activeStreamingStoredSessionId: 'sess-bg',
      activeStreamingLiveId: 'live-bg',
      activeStreamingBotName: null,
    });
    dispatcher.applyTurnActions([{ type: 'turn-failed', sessionId: 'sess-bg', message: 'bg err' }]);
    assert.equal(state.messages.find((m) => m.id === 'ast-nonempty').content, 'Keep me', '非空正文不得被错误前缀覆盖');
    assert.deepEqual(pendingCalls, [], '后台会话 turn-failed 不得触发当前会话视口贴底');
  } finally {
    dispatcher?.disconnect();
    t.mock.timers.reset();
  }
});

test('D6: turnSettlement - 后台流收口、缺失缓存/registry 与空上下文完结/失败分支', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_700_000_000_000 });
  const reg = new LiveStreamRegistry();
  const { deps, state } = createMockDispatcherDeps({});
  deps.getLiveStreamRegistry = () => reg;
  state.gatewayConnected = true;

  let dispatcher;
  let noRegDispatcher;
  try {
    dispatcher = createGatewayEventDispatcher(deps);

    // 1. 聚焦/后台流式切换收口 (L564, L607-608, L615, L637, L666-673, L709)
    reg.registerStream({ storedSessionId: 'sess-1', liveSessionId: 'live-1', messageId: 'ast-1', origin: 'local' });
    reg.registerStream({ storedSessionId: 'sess-bg', liveSessionId: 'live-bg', messageId: 'ast-bg', botName: 'bg-bot', origin: 'remote' });
    deps.getActiveRunningBotNames().add('bg-bot');
    dispatcher.handleGatewayEvent({ type: 'message.complete', session_id: 'live-bg', payload: { text: 'bg done' } });
    assert.equal(reg.hasSession('sess-bg'), false, '后台会话收到 message.complete 必须注销并发流');
    assert.equal(deps.getActiveRunningSessionIds().has('sess-1'), true, '前台 sess-1 运行态不得受后台完成波及');
    dispatcher.handleGatewayEvent({ type: 'error', session_id: 'live-bg', payload: { message: 'bg err' } });

    // 2. unfocused completedBotName 无缓存 (L566 !msgs, L617 ?.) 与空缓存数组 (L617 || null)
    deps.resolveBotNameForSession = (sid) => (sid.startsWith('sess-bot') ? 'bot-bg' : null);
    deps.getActiveRunningBotNames().add('bot-bg');
    deps.getSessionMessagesCache().delete('sess-bot-nocache');
    deps.getSessionMessagesCache().set('sess-bot-emptycache', []);
    dispatcher.applyTurnActions([
      { type: 'turn-completed', sessionId: 'sess-bot-nocache', finalText: 'done' },
      { type: 'turn-completed', sessionId: 'sess-bot-emptycache', finalText: 'done' },
    ]);

    // 3. 有 streamRegistry 但 activeStreamingStoredSessionId 与 state.activeSessionId 均为空 + activeSessionId 仍在流中
    deps.setActiveStreamingContext({
      activeStreamingStoredSessionId: null,
      activeStreamingLiveId: null,
      activeStreamingMessageId: null,
      activeStreamingBotName: 'b-orphan',
    });
    state.activeSessionId = '';
    dispatcher.applyTurnActions([
      { type: 'turn-completed', sessionId: '', finalText: '' },
      { type: 'turn-failed', sessionId: '', message: 'fail empty' },
    ]);
    reg.registerStream({ storedSessionId: 'sess-still-live', liveSessionId: 'live-still', messageId: 'm-live', origin: 'local' });
    state.activeSessionId = 'sess-still-live';
    state.activeFocus = { type: 'session', sessionId: 'sess-still-live' };
    dispatcher.applyTurnActions([
      { type: 'turn-completed', sessionId: '', finalText: '' },
    ]);

    // 4. 缺失 streamRegistry + 空上下文 turn-completed/turn-failed + focused message.complete 带 text（idle sync(0)）
    let noRegIdleSync = 0;
    const { deps: depsNoReg, state: stateNoReg } = createMockDispatcherDeps({});
    depsNoReg.refreshActiveSession = async () => { noRegIdleSync += 1; };
    stateNoReg.gatewayConnected = true;
    noRegDispatcher = createGatewayEventDispatcher(depsNoReg);
    depsNoReg.setActiveStreamingContext({
      activeStreamingStoredSessionId: null,
      activeStreamingLiveId: null,
      activeStreamingMessageId: null,
      activeStreamingBotName: null,
    });
    noRegDispatcher.applyTurnActions([
      { type: 'turn-failed', sessionId: '', message: 'fail no id' },
      { type: 'turn-completed', sessionId: '', finalText: '' },
      { type: 'turn-completed', sessionId: 'sess-1', finalText: 'authoritative text' },
    ]);
    assert.equal(noRegIdleSync, 0, 'scheduleActiveSessionIdleSync(0) 不得同步执行');
    await advanceTimers(t, 0);
    assert.ok(noRegIdleSync >= 1, '无 streamRegistry 且有 finalText 时必须触发 idle sync(0)');
  } finally {
    noRegDispatcher?.disconnect();
    dispatcher?.disconnect();
    t.mock.timers.reset();
  }
});

test('D6: turnSettlement - session-reclaimed/refresh-sessions/finalReplace/cache工具收敛与多流disarm守卫全分支', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_700_000_000_000 });
  let dispatcher;
  let noRegDispatcher;
  try {
    const reg = new LiveStreamRegistry();
    const clearTracker = [];
    const pendingScrolls = [];
    const setContentLog = [];
    const persistTurnLog = [];
    const persistSessLog = [];
    const completeLog = [];
    const botActLog = [];
    const refreshCalls = [];
    let schedSessionsCount = 0;

    const { deps, state, watchdogEvents, rendered } = createMockDispatcherDeps({
      state: {
        activeSessionId: 'sess-foc',
        activeLiveSessionId: 'live-foc',
        activeFocus: { type: 'session', sessionId: 'sess-foc' },
        isStreaming: true,
        sessions: [
          { id: 'sess-foc', title: 'Foc', botName: 'foc-bot', preview: 'old-prev', timestamp: 10 },
          { id: 'sess-bg', title: 'BG', botName: 'bg-bot', preview: 'old-bg-prev', timestamp: 5 },
        ],
        messages: [
          { id: 'u1', role: 'user', content: 'hi' },
          {
            id: 'a1',
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 't1', name: 'read', status: 'running', startTime: Date.now() - 300 }],
          },
        ],
      },
      activeStreamingContext: {
        activeStreamingMessageId: 'a1',
        activeStreamingStoredSessionId: 'sess-foc',
        activeStreamingLiveId: 'live-foc',
        activeStreamingBotName: 'ctx-bot',
      },
    });

    deps.getLiveStreamRegistry = () => reg;
    deps.isStreamNearBottom = () => true;
    deps.setPendingScrollToBottom = (v) => pendingScrolls.push(v);
    deps.setMessageContent = (mid, text) => {
      setContentLog.push([mid, text]);
      const m = state.messages.find((x) => x.id === mid);
      if (m) m.content = text;
    };
    deps.persistTurnToCache = (sid, bot, msgs) => persistTurnLog.push({ sid, bot, count: msgs.length });
    deps.persistSessionsToCache = (s) => persistSessLog.push(s.map((x) => x.id));
    deps.completeEntityTurn = (kind, r, u, id, foc) => completeLog.push({ kind, id, foc });
    deps.getBotActivityStore = () => ({ updateLatestActivity: (bot, content) => botActLog.push({ bot, content }) });
    deps.getActivityTransitionTracker = () => ({
      clear: (domain, id) => clearTracker.push([domain, id]),
      clearAll: () => {},
    });
    deps.refreshActiveSession = async (opts) => { refreshCalls.push(opts); };
    deps.scheduleSessionsRefresh = () => { schedSessionsCount += 1; };
    deps.t = (k, vars) => (vars?.message ? `${k}:${vars.message}` : k);

    const separateFocCache = [
      { id: 'u1', role: 'user', content: 'hi' },
      {
        id: 'a1',
        role: 'assistant',
        content: 'draft',
        toolCalls: [{ id: 't1', name: 'read', status: 'running', startTime: Date.now() - 300 }],
      },
    ];
    const bgCache = [
      { id: 'bu1', role: 'user', content: 'bq' },
      {
        id: 'ba1',
        role: 'assistant',
        content: 'b-draft',
        toolCalls: [{ id: 'bt1', name: 'bash', status: 'running', startTime: Date.now() - 300 }],
      },
    ];
    deps.getSessionMessagesCache().set('sess-foc', separateFocCache);
    deps.getSessionMessagesCache().set('sess-bg', bgCache);

    dispatcher = createGatewayEventDispatcher(deps);

    // 1. focused turn-completed: finalReplace + 独立缓存数组工具收敛 + sessionMessagesCache 快照克隆 + ctx-bot 未命中时不误清
    deps.setActiveStreamingContext({ activeStreamingStoredSessionId: 'sess-other-active', activeStreamingBotName: 'keep-other-bot' });
    reg.registerStream({ storedSessionId: 'sess-foc', liveSessionId: 'live-sess-foc', messageId: 'a1', botName: 'foc-bot', origin: 'local' });
    dispatcher.applyTurnActions([
      { type: 'replace-content', messageId: 'a1', text: 'Foc Done' },
      { type: 'turn-completed', sessionId: 'live-sess-foc', finalText: 'Foc Done' },
    ]);
    assert.equal(separateFocCache[1].content, 'Foc Done', 'replace-content 必须同步更新独立缓存数组');
    assert.equal(separateFocCache[1].toolCalls[0].status, 'completed', 'turn-completed 必须收敛独立缓存数组内的运行态工具');
    const cachedAfterSet = deps.getSessionMessagesCache().get('sess-foc');
    assert.equal(cachedAfterSet.length, 2);
    assert.notEqual(cachedAfterSet, state.messages, 'focused cache 写入应保存 [...state.messages] 浅拷贝而非 []');
    assert.equal(deps.getActiveStreamingContext().activeStreamingBotName, 'keep-other-bot', 'completedBotName 与 ctx 不同时不得误清 activeStreamingBotName');
    await advanceTimers(t, 0);
    assert.equal(refreshCalls.length, 0);

    // 2. idleSync(0) 负向组合 + 空内容保留旧 preview + 3元素 slice(-1)[0]
    state.gatewayConnected = true;
    deps.getSessionMessagesCache().set('sess-bg', [{ id: 'bu-empty', role: 'assistant', content: '' }]);
    dispatcher.applyTurnActions([
      { type: 'replace-content', messageId: 'bu-empty', text: '' },
      { type: 'turn-completed', sessionId: 'live-sess-bg', finalText: '' },
    ]);
    assert.equal(state.sessions.find((s) => s.id === 'sess-bg').preview, 'old-bg-prev', '空内容完成不得把旧 preview 覆写为空');
    assert.deepEqual(setContentLog.filter((x) => x[0] === 'bu-empty'), [], '有 streamRegistry 时后台 finalReplace 不得调 setMessageContent 污染前台');
    assert.equal(deps.getSessionMessagesCache().get('sess-bg')[0].id, 'bu-empty', '后台会话完成绝不可被前台 state.messages 覆写缓存');

    deps.getSessionMessagesCache().set('sess-bg', [
      { id: 'b0', role: 'user', content: 'q0' },
      { id: 'b1', role: 'assistant', content: 'middle-older' },
      { id: 'b2', role: 'assistant', content: 'Latest BG Tail' },
    ]);
    reg.registerStream({ storedSessionId: 'sess-bg', liveSessionId: 'live-sess-bg', messageId: 'b2', botName: 'bg-bot', origin: 'remote' });
    deps.setActiveStreamingContext({ activeStreamingStoredSessionId: 'sess-other-active', activeStreamingBotName: 'bg-bot' });
    state.isStreaming = false;
    dispatcher.applyTurnActions([{ type: 'turn-completed', sessionId: 'live-sess-bg' }]);
    assert.equal(state.sessions.find((s) => s.id === 'sess-bg').preview, 'Latest BG Tail');
    assert.equal(deps.getActiveStreamingContext().activeStreamingBotName, null, 'completedBotName 命中 ctx.activeStreamingBotName 时即使 session 不匹配也必须清零');

    reg.registerStream({ storedSessionId: 'sess-bg-keep', liveSessionId: 'live-bg-keep', messageId: 'm-keep', origin: 'remote' });
    reg.registerStream({ storedSessionId: 'sess-foc', liveSessionId: 'live-sess-foc-next', messageId: 'a-next', origin: 'local' });
    state.activeSessionId = 'sess-foc';
    state.isStreaming = false;
    deps.setActiveStreamingContext({ activeStreamingStoredSessionId: null, activeStreamingMessageId: null, activeStreamingBotName: null });
    const disarmKeep = watchdogEvents.filter((e) => e === 'disarm').length;
    dispatcher.applyTurnActions([{ type: 'turn-completed', sessionId: '' }]);
    assert.equal(state.isStreaming, true, 'focused 完成若 reg 仍有当前会话流，必须 syncFocusedStreamingProjection 保活');
    assert.equal(watchdogEvents.filter((e) => e === 'disarm').length, disarmKeep);
    reg.removeSession('sess-foc');
    dispatcher.applyTurnActions([{ type: 'turn-completed', sessionId: 'live-sess-foc' }]);
    assert.equal(state.isStreaming, false);
    assert.equal(watchdogEvents.filter((e) => e === 'disarm').length, disarmKeep);
    reg.removeSession('sess-bg-keep');

    refreshCalls.length = 0;
    reg.registerStream({ storedSessionId: 'sess-foc', liveSessionId: 'live-sess-foc', messageId: 'a1', origin: 'local' });
    dispatcher.applyTurnActions([{ type: 'turn-completed', sessionId: 'live-sess-foc', finalText: 'streamed' }]);
    await advanceTimers(t, 0);
    assert.equal(refreshCalls.length, 0);

    dispatcher.applyTurnActions([{ type: 'turn-completed', sessionId: 'live-sess-foc', finalText: 'unstreamed-authoritative' }]);
    assert.deepEqual(refreshCalls, [], 'scheduleActiveSessionIdleSync(0) 不得在同步阶段立即执行');
    await advanceTimers(t, 0);
    assert.deepEqual(refreshCalls, [{ checkLiveTurn: true }]);
    refreshCalls.length = 0;

    // 3. 后台最后一个流完成/失败时的 disarm 收口
    deps.setActiveStreamingContext({ activeStreamingStoredSessionId: null, activeStreamingMessageId: null, activeStreamingLiveId: null, activeStreamingBotName: null });
    reg.registerStream({ storedSessionId: 'sess-bg', liveSessionId: 'live-sess-bg', messageId: 'bu-empty', botName: 'bg-bot', origin: 'remote' });
    state.isStreaming = false;
    const disarm0 = watchdogEvents.filter((e) => e === 'disarm').length;
    dispatcher.applyTurnActions([{ type: 'turn-completed', sessionId: 'live-sess-bg' }]);
    assert.equal(watchdogEvents.filter((e) => e === 'disarm').length, disarm0 + 1, '全部流结束且前台空闲时，后台完成必须 disarm 看门狗');

    reg.registerStream({ storedSessionId: 'sess-bg', liveSessionId: 'live-sess-bg', messageId: 'bu-empty', botName: 'bg-bot', origin: 'remote' });
    reg.registerStream({ storedSessionId: 'sess-bg-extra', liveSessionId: 'live-bg-extra', messageId: 'b-ext', origin: 'remote' });
    const disarm1 = watchdogEvents.filter((e) => e === 'disarm').length;
    dispatcher.applyTurnActions([{ type: 'turn-completed', sessionId: 'live-sess-bg' }]);
    assert.equal(watchdogEvents.filter((e) => e === 'disarm').length, disarm1);
    reg.removeSession('sess-bg-extra');
    deps.setActiveStreamingContext({ activeStreamingStoredSessionId: 'sess-foc' });
    reg.registerStream({ storedSessionId: 'sess-bg', liveSessionId: 'live-sess-bg', messageId: 'bu-empty', origin: 'remote' });
    dispatcher.applyTurnActions([{ type: 'turn-completed', sessionId: 'live-sess-bg' }]);
    assert.equal(watchdogEvents.filter((e) => e === 'disarm').length, disarm1);
    deps.setActiveStreamingContext({ activeStreamingStoredSessionId: null });
    state.isStreaming = false;

    // 4. turn-failed 深度分支
    deps.getSessionMessagesCache().set('sess-bg-fail', [{ id: 'm-bg-f', role: 'assistant', content: '' }]);
    reg.registerStream({ storedSessionId: 'sess-bg-fail', liveSessionId: 'live-sess-bg-fail', messageId: 'm-bg-f', botName: 'fail-bg-bot', origin: 'remote' });
    deps.setActiveStreamingContext({ activeStreamingBotName: 'keep-ctx-bot' });
    const disarmFail0 = watchdogEvents.filter((e) => e === 'disarm').length;
    dispatcher.applyTurnActions([{ type: 'turn-failed', sessionId: 'live-sess-bg-fail', message: 'bg boom' }]);
    assert.equal(deps.getSessionMessagesCache().get('sess-bg-fail')[0].content, 'chat.turnFailedPrefix:bg boom', 'turn-failed 必须回填后台缓存内空消息');
    assert.equal(deps.getActiveStreamingContext().activeStreamingBotName, 'keep-ctx-bot');
    assert.equal(watchdogEvents.filter((e) => e === 'disarm').length, disarmFail0 + 1, '后台最后一个流 fail 且空闲时必须 disarm');

    pendingScrolls.length = 0;
    state.messages = [{ id: 'a-f-near', role: 'assistant', content: '' }];
    state.isStreaming = true;
    deps.setTurnStartedSessionId('sess-foc');
    reg.registerStream({ storedSessionId: 'sess-bg-still', liveSessionId: 'live-bg-still', messageId: 'm-bgs', origin: 'remote' });
    const disarmFocFail = watchdogEvents.filter((e) => e === 'disarm').length;
    deps.setActiveStreamingContext({ activeStreamingStoredSessionId: 'sess-foc', activeStreamingMessageId: 'a-f-near', activeStreamingLiveId: 'live-foc', activeStreamingBotName: null });
    dispatcher.applyTurnActions([{ type: 'turn-failed', sessionId: 'live-sess-foc', message: 'foc boom' }]);
    assert.deepEqual(pendingScrolls, [true]);
    assert.equal(deps.getTurnStartedSessionId(), null, 'focused turn-failed 必须清零 turnStartedSessionId');
    assert.equal(watchdogEvents.filter((e) => e === 'disarm').length, disarmFocFail, '后台仍有流时 focused fail 不得 disarm');

    deps.setActiveStreamingContext({ activeStreamingStoredSessionId: 'sess-other-x', activeStreamingBotName: 'fail-bg-bot' });
    reg.registerStream({ storedSessionId: 'sess-bg-fail', liveSessionId: 'live-sess-bg-fail', messageId: 'm-bg-f', botName: 'fail-bg-bot', origin: 'remote' });
    state.isStreaming = false;
    dispatcher.applyTurnActions([{ type: 'turn-failed', sessionId: 'live-sess-bg-fail', message: 'bg boom 2' }]);
    assert.equal(deps.getActiveStreamingContext().activeStreamingBotName, null);
    assert.equal(watchdogEvents.filter((e) => e === 'disarm').length, disarmFocFail, 'reg 中尚有 sess-bg-still 不得 disarm');
    reg.removeSession('sess-bg-still');

    reg.registerStream({ storedSessionId: 'sess-foc', liveSessionId: 'live-foc-2', messageId: 'a-f-2', origin: 'remote' });
    state.activeSessionId = 'sess-foc';
    state.isStreaming = false;
    deps.setActiveStreamingContext({ activeStreamingStoredSessionId: null, activeStreamingMessageId: null });
    dispatcher.applyTurnActions([{ type: 'turn-failed', sessionId: '', message: 'generic err' }]);
    assert.equal(state.isStreaming, true, 'activeSessionId 在 reg 中仍有新流时 fail 必须 syncFocusedStreamingProjection 保持 isStreaming=true');
    reg.removeSession('sess-foc');

    // 5. session-reclaimed
    clearTracker.length = 0;
    refreshCalls.length = 0;
    state.activeSessionId = 'sess-foc';
    state.activeLiveSessionId = 'live-sess-foc';
    state.isStreaming = true;
    reg.registerStream({ storedSessionId: 'sess-foc', liveSessionId: 'live-sess-foc', messageId: 'a1', botName: 'foc-bot', origin: 'local' });
    deps.getActiveRunningSessionIds().add('sess-foc');
    deps.getActiveRunningBotNames().add('foc-bot');
    dispatcher.applyTurnActions([{ type: 'session-reclaimed', sessionId: 'live-sess-foc' }]);
    assert.equal(reg.hasSession('sess-foc'), false);
    assert.equal(deps.getActiveRunningSessionIds().has('sess-foc'), false);
    assert.equal(deps.getActiveRunningBotNames().has('foc-bot'), false);
    assert.equal(state.activeLiveSessionId, '');
    assert.equal(state.isStreaming, false);
    assert.deepEqual(clearTracker, [['session', 'sess-foc'], ['bot', 'foc-bot']]);
    assert.deepEqual(refreshCalls, [{ forceRefreshAfterReconnect: true, checkLiveTurn: true }]);

    state.activeLiveSessionId = 'keep-foc-live';
    state.isStreaming = true;
    const rendersBeforeRec = rendered.length;
    deps.setActiveStreamingContext({ activeStreamingStoredSessionId: 'sess-bg-rec', activeStreamingMessageId: 'm-rec' });
    dispatcher.applyTurnActions([{ type: 'session-reclaimed', storedSessionId: 'sess-bg-rec', sessionId: 'live-bg-rec' }]);
    assert.equal(state.activeLiveSessionId, 'keep-foc-live');
    assert.equal(state.isStreaming, false, '命中 ctx.activeStreamingStoredSessionId 时应调用 syncFocusedStreamingProjection');
    assert.ok(rendered.length > rendersBeforeRec);
    assert.equal(refreshCalls.length, 1);

    state.isStreaming = true;
    deps.setActiveStreamingContext({ activeStreamingStoredSessionId: 'sess-keep-other' });
    dispatcher.applyTurnActions([{ type: 'session-reclaimed', sessionId: 'live-sess-unrelated' }]);
    assert.equal(state.isStreaming, true);
    state.isStreaming = false;
    deps.setActiveStreamingContext({ activeStreamingStoredSessionId: null });

    // 6. refresh-sessions: 同时调度 scheduleSessionsRefresh 与 scheduleActiveSessionIdleSync (150ms)
    state.gatewayConnected = true;
    state.isStreaming = false;
    schedSessionsCount = 0;
    refreshCalls.length = 0;
    dispatcher.applyTurnActions([{ type: 'refresh-sessions' }]);
    assert.equal(schedSessionsCount, 1);
    await advanceTimers(t, 149);
    assert.deepEqual(refreshCalls, [], '149ms 时 refresh-sessions 调度的 150ms 同步不得提前触发');
    await advanceTimers(t, 1);
    assert.deepEqual(refreshCalls, [{ checkLiveTurn: true }]);

    // 7. 无 streamRegistry 模式下后台 finalReplace 仍走 setMessageContent + session-reclaimed 全分支闭合
    deps.getLiveStreamRegistry = undefined;
    setContentLog.length = 0;
    noRegDispatcher = createGatewayEventDispatcher(deps);
    deps.getSessionMessagesCache().set('sess-bg', [{ id: 'm-noreg', role: 'assistant', content: 'old' }]);
    noRegDispatcher.applyTurnActions([
      { type: 'replace-content', messageId: 'm-noreg', text: 'NoReg Final' },
      { type: 'turn-completed', sessionId: 'live-sess-bg' },
    ]);
    assert.deepEqual(setContentLog, [['m-noreg', 'NoReg Final']]);

    state.activeLiveSessionId = 'keep-no-rec';
    refreshCalls.length = 0;
    noRegDispatcher.applyTurnActions([{ type: 'session-reclaimed', sessionId: '' }]);
    assert.equal(state.activeLiveSessionId, 'keep-no-rec');
    assert.equal(refreshCalls.length, 0);

    state.activeSessionId = 'sess-noreg-rec';
    state.activeLiveSessionId = 'live-sess-noreg-rec';
    deps.getActiveRunningSessionIds().add('sess-noreg-rec');
    noRegDispatcher.applyTurnActions([{ type: 'session-reclaimed', sessionId: 'live-sess-noreg-rec' }]);
    assert.equal(deps.getActiveRunningSessionIds().has('sess-noreg-rec'), false);
    assert.equal(state.activeLiveSessionId, '');
    assert.deepEqual(refreshCalls, [{ forceRefreshAfterReconnect: true, checkLiveTurn: true }]);
  } finally {
    noRegDispatcher?.disconnect();
    dispatcher?.disconnect();
    t.mock.timers.reset();
  }
});
