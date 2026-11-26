/**
 * GatewayEventDispatcher 流式事件分发、工具补丁、Coalescer 分流与 Inspector 事件单测
 * (packages/desktop/__tests__/unit/gatewayEventDispatcher.dispatch.test.mjs)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveStreamRegistry, TokenCoalescer } from '@hermes-flux/core';
import { createGatewayEventDispatcher } from '../../dist/renderer/gateway/gatewayEventDispatcher.mjs';
import { advanceTimers, createMockDispatcherDeps } from './helpers/gatewayDispatcherHarness.mjs';

test('D6: gatewayEventDispatcher - tool-complete 同步更新 state 与缓存中的 imagePath', () => {
  const { deps, state, patchedTools, getSessionMessagesCache } = createMockDispatcherDeps({
    state: {
      messages: [
        { id: 'usr-1', role: 'user', content: 'draw' },
        {
          id: 'ast-1',
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'tc-1', name: 'draw_chart', status: 'running' }],
        },
      ],
    },
  });
  getSessionMessagesCache().set('sess-1', [
    { id: 'usr-1', role: 'user', content: 'draw' },
    {
      id: 'ast-1',
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'tc-1', name: 'draw_chart', status: 'running' }],
    },
  ]);

  const dispatcher = createGatewayEventDispatcher(deps);
  dispatcher.applyTurnActions([
    {
      type: 'tool-complete',
      messageId: 'ast-1',
      toolCallId: 'tc-1',
      output: 'saved chart',
      imagePath: '/out/rendered.png',
    },
  ]);

  assert.equal(state.messages[1].toolCalls[0].imagePath, '/out/rendered.png');
  assert.equal(getSessionMessagesCache().get('sess-1')[1].toolCalls[0].imagePath, '/out/rendered.png');
  assert.ok(patchedTools.includes('ast-1'));
});

test('D6: gatewayEventDispatcher - 120 FPS 双轨分流：高频 delta 严禁触发 render()', () => {
  const { deps, rendered, pushedTokens } = createMockDispatcherDeps();
  const dispatcher = createGatewayEventDispatcher(deps);

  dispatcher.applyTurnActions([
    { type: 'append-content', messageId: 'ast-1', text: 'Hello ' },
    { type: 'append-content', messageId: 'ast-1', text: 'World' },
    { type: 'append-thought', messageId: 'ast-1', text: 'Thinking...' },
  ]);

  assert.equal(rendered.length, 0, '高频增量 chunk 绝对禁止调用 render()');
  assert.equal(pushedTokens.length, 3);
  assert.equal(pushedTokens[0].delta, 'Hello ');
  assert.equal(pushedTokens[0].isThought, false);
  assert.equal(pushedTokens[2].isThought, true);
  assert.ok(deps.getState());
});

test('D6: gatewayEventDispatcher - 流式数据下发触发滑动看门狗喂狗与无注入安全降级', () => {
  const { deps, watchdogEvents } = createMockDispatcherDeps();
  const dispatcher = createGatewayEventDispatcher(deps);

  dispatcher.applyTurnActions([
    { type: 'append-content', messageId: 'ast-1', text: 'Chunk 1' },
    { type: 'append-thought', messageId: 'ast-1', text: 'Thought 1' },
    { type: 'tool-start', messageId: 'ast-1', toolCall: { id: 'tc-feed-1', name: 'read' } },
    { type: 'tool-complete', messageId: 'ast-1', toolCallId: 'tc-feed-1', output: 'done' },
  ]);

  const feeds = watchdogEvents.filter((e) => e === 'feed');
  assert.equal(feeds.length, 4, '4 次流式活跃事件必须各触发一次 feedTurnWatchdog');

  // 无 feedTurnWatchdog 注入时安全降级
  const noFeedDeps = { ...deps, feedTurnWatchdog: undefined };
  const dispatcher2 = createGatewayEventDispatcher(noFeedDeps);
  assert.doesNotThrow(() => {
    dispatcher2.applyTurnActions([
      { type: 'append-content', messageId: 'ast-1', text: 'Chunk 2' },
      { type: 'append-thought', messageId: 'ast-1', text: 'Thought 2' },
      { type: 'tool-start', messageId: 'ast-1', toolCall: { id: 'tc-feed-2', name: 'edit' } },
      { type: 'tool-complete', messageId: 'ast-1', toolCallId: 'tc-feed-2', output: 'ok' },
    ]);
  });
});

test('D6: gatewayEventDispatcher - 工具生命周期 tool-start / tool-complete 调度局部补丁', () => {
  const { deps, state, rendered, patchedTools } = createMockDispatcherDeps();
  const dispatcher = createGatewayEventDispatcher(deps);

  dispatcher.applyTurnActions([
    {
      type: 'tool-start',
      messageId: 'ast-1',
      toolCall: { id: 'tc-1', name: 'search', args: { q: 'Hermes' } },
    },
  ]);

  assert.equal(rendered.length, 0, '工具事件走 scheduleToolPatch，不触发全量 render');
  assert.equal(patchedTools.length, 1);
  assert.equal(patchedTools[0], 'ast-1');

  const astMsg = state.messages.find((m) => m.id === 'ast-1');
  assert.equal(astMsg.toolCalls?.length, 1);
  assert.equal(astMsg.toolCalls[0].name, 'search');
  assert.equal(astMsg.toolCalls[0].status, 'running');

  dispatcher.applyTurnActions([
    {
      type: 'tool-complete',
      messageId: 'ast-1',
      toolCallId: 'tc-1',
      output: 'Found 10 items',
      durationMs: 350,
    },
  ]);

  assert.equal(astMsg.toolCalls[0].status, 'completed');
  assert.equal(astMsg.toolCalls[0].output, 'Found 10 items');
  assert.equal(astMsg.toolCalls[0].durationMs, 350);
});

test('D6: gatewayEventDispatcher - handleInspectorEvent 解包工件、浏览器帧与 Diff', () => {
  const { deps, state } = createMockDispatcherDeps();
  const dispatcher = createGatewayEventDispatcher(deps);

  dispatcher.handleInspectorEvent({
    type: 'artifact.created',
    payload: { id: 'art-1', name: 'report.pdf', type: 'FILE', size: '2MB' },
  });
  assert.equal(state.artifacts.length, 1);
  assert.equal(state.artifacts[0].name, 'report.pdf');

  dispatcher.handleInspectorEvent({
    type: 'browser.frame',
    payload: { url: 'https://example.com', title: 'Example Page' },
  });
  assert.equal(state.browserFrame?.url, 'https://example.com');
  assert.equal(state.browserFrame?.title, 'Example Page');

  dispatcher.handleInspectorEvent({
    type: 'git.diff',
    payload: { diffs: [{ file: 'index.ts', additions: 10, deletions: 5 }] },
  });
  assert.equal(state.gitDiffs.length, 1);
});

test('gatewayEventDispatcher - 状态栏/子Agent 事件增量分流与 delegate_task delegationId 解析', async () => {
  const statusActions = [];
  let disconnectedCalls = 0;
  const { deps, state, rendered, getRegistryClearCount } = createMockDispatcherDeps();
  deps.onStatusTurnAction = (action) => statusActions.push(action.type);
  deps.onStatusDisconnected = () => {
    disconnectedCalls += 1;
  };
  deps.testConnection = async () => ({ ok: false, latency: 0, message: 'offline' });
  const dispatcher = createGatewayEventDispatcher(deps);
  try {
    const initialRenderCount = rendered.length;

    dispatcher.applyTurnActions([
      {
        type: 'tool-start',
        messageId: 'ast-1',
        toolCall: {
          id: 'tc-delegate-1',
          name: 'delegate_task',
          args: JSON.stringify({ goal: '运行核查', delegation_id: 'del-live-1' }),
        },
      },
      {
        type: 'session-usage',
        sessionId: 'live-1',
        payload: { context_used: 1200, context_max: 8000 },
      },
      {
        type: 'subagent-progress',
        sessionId: 'live-1',
        subagentId: 'sub-live-1',
        progressPercent: 45,
        actionText: 'scanning',
      },
    ]);

    const tc = state.messages[1].toolCalls.find((item) => item.id === 'tc-delegate-1');
    assert.ok(tc, 'tool-start 必须写入 delegate_task 工具胶囊');
    assert.equal(tc.delegationId, 'del-live-1');
    assert.equal(tc.rawArgs?.goal, '运行核查');
    const cachedTc = deps.getSessionMessagesCache().get('sess-1')[1].toolCalls.find((item) => item.id === 'tc-delegate-1');
    assert.equal(cachedTc?.delegationId, 'del-live-1');

    assert.deepEqual(statusActions, ['tool-start', 'session-usage', 'subagent-progress']);
    assert.equal(rendered.length, initialRenderCount, '纯状态/子Agent 更新严禁触发全量 render()');

    dispatcher.disconnect();
    assert.equal(disconnectedCalls, 1, 'disconnect 必须通知 onStatusDisconnected 清理状态定时轮询');
    assert.equal(getRegistryClearCount(), 1, 'disconnect 必须清空 SessionHandleRegistry 防重连错拿旧 liveId');

    await dispatcher.connect();
    assert.equal(disconnectedCalls, 2, 'connect 重连建链前必须先复位状态服务');
    assert.equal(getRegistryClearCount(), 2, 'connect 建链前必须再次清空陈旧句柄注册表');
  } finally {
    dispatcher.disconnect();
  }
});

test('D6: gatewayEventDispatcher - 流式动作细粒度分发/工具参数缓存/持久化行号与远端帧全量覆盖', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_700_000_000_000 });
  let coalescer;
  let dispatcher;
  try {
    const reg = new LiveStreamRegistry();
    const {
      deps, state, pushedTokens, patchedTools, watchdogEvents, presenceEvents,
    } = createMockDispatcherDeps({
      state: {
        activeSessionId: 'sess-fg',
        activeLiveSessionId: 'live-fg',
        isStreaming: false,
        sessions: [
          { id: 'sess-fg', title: 'FG', botName: 'default', preview: '', timestamp: 100 },
          { id: 'sess-known-bg', title: 'KnownBG', botName: 'bg-bot', preview: '', timestamp: 90 },
        ],
        messages: [
          { id: 'u-fg', role: 'user', content: 'hi', timestamp: '12:00:00' },
          { id: 'a-fg', role: 'assistant', content: '', thought: '', timestamp: '12:00:01' },
        ],
      },
      activeStreamingContext: {
        activeStreamingMessageId: 'a-fg',
        activeStreamingStoredSessionId: 'sess-fg',
        activeStreamingLiveId: 'live-fg',
        activeStreamingBotName: 'ctx-fallback-bot',
      },
    });

    const flushedDrops = [];
    coalescer = new TokenCoalescer((flushed) => {
      for (const [messageId, entry] of flushed.entries()) {
        pushedTokens.push({ messageId, content: entry.content, thought: entry.thought });
      }
    });
    const origDrop = coalescer.dropMessage.bind(coalescer);
    coalescer.dropMessage = (mid) => {
      flushedDrops.push(mid);
      return origDrop(mid);
    };

    const forceSyncCalls = [];
    const ensureWindowArgs = [];
    const expandedArgs = [];
    let nearBottomFlag = true;
    const pendingScrollArgs = [];
    const persistCalls = [];
    const statusActions = [];
    let renderCount = 0;

    deps.getLiveStreamRegistry = () => reg;
    deps.getTokenCoalescer = () => coalescer;
    deps.getSessionMessagesCache().delete('sess-fg');
    deps.getSessionMessagesCache().set('sess-fg', [
      { id: 'u-fg', role: 'user', content: 'hi', timestamp: '12:00:00' },
      { id: 'a-fg', role: 'assistant', content: '', thought: '', timestamp: '12:00:01' },
    ]);
    deps.onForceSyncMessageList = (v) => { forceSyncCalls.push(v); };
    deps.ensureMessageWindow = (n) => { ensureWindowArgs.push(n); };
    deps.setMessageWindowUserExpanded = (v) => { expandedArgs.push(v); };
    deps.isStreamNearBottom = () => nearBottomFlag;
    deps.setPendingScrollToBottom = (v) => { pendingScrollArgs.push(v); };
    deps.persistTurnToCache = (sid, bot, msgs) => {
      persistCalls.push({ sid, bot, count: msgs.length, clone: msgs });
    };
    deps.onStatusTurnAction = (action) => { statusActions.push(action); };
    deps.render = () => { renderCount += 1; };
    deps.resolveBotNameForSession = (sid) => (sid === 'sess-known-bg' ? 'bg-bot' : null);

    dispatcher = createGatewayEventDispatcher(deps);

    // 1. handleGatewayEvent: 覆盖已知后台会话对每个 TURN_STREAM_EVENT_TYPES 自动挂载 vs 非流式事件忽略
    for (const evtType of [
      'message.delta',
      'message.interim',
      'thinking.delta',
      'reasoning.delta',
      'tool.start',
      'tool.complete',
      'tool.end',
      'tool.error',
    ]) {
      dispatcher.handleGatewayEvent({ type: evtType, session_id: 'live-sess-known-bg', payload: { text: 'x' } });
      assert.equal(reg.hasSession('sess-known-bg'), false, `${evtType} 非运行态已知后台会话不得自动挂载`);
    }

    state.isStreaming = false;
    dispatcher.handleGatewayEvent({
      event: 'message.start',
      payload: { session_id: 'live-sess-known-bg', turn_id: 'turn-bg-1', display_text: 'display Q', text: 'raw Q' },
    });
    const bgStream = reg.getBySession('sess-known-bg');
    assert.ok(bgStream, 'message.start 对已知后台会话必须自动挂载 remote observer stream');
    assert.equal(bgStream.turnId, 'turn-bg-1');
    assert.equal(bgStream.botName, 'bg-bot');
    const bgMsgs = deps.getSessionMessagesCache().get('sess-known-bg');
    assert.ok(bgMsgs?.some((m) => m.role === 'user' && m.content === 'display Q'));
    assert.equal(state.isStreaming, false);
    assert.equal(forceSyncCalls.length, 0);

    dispatcher.handleGatewayEvent({ kind: 'custom.unrelated', session_id: 'live-untracked', payload: {} });
    assert.equal(reg.hasSession('untracked'), false);

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
      const sid = `sess-run-${idx}`;
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

    // 聚焦会话（via activeLiveSessionId，即使 activeSessionId 暂不相同）+ turn-started 覆盖 liveCoord 适配器回调
    const fgStartedAt = Date.now() - 500;
    reg.registerStream({
      storedSessionId: 'sess-fg',
      liveSessionId: 'live-fg',
      messageId: 'a-fg',
      origin: 'remote',
      nowMs: fgStartedAt,
    });
    reg.getBySession('sess-fg').userMessageSynced = false;
    reg.getBySession('sess-fg').turnId = undefined;

    const rendersBeforeStart = renderCount;
    dispatcher.applyTurnActions([
      {
        type: 'turn-started',
        sessionId: 'live-fg',
        turnId: 'turn-fg-1',
        displayText: 'Remote Display Prompt',
        text: 'Remote Raw Prompt',
      },
    ]);
    const fgEntry = reg.getBySession('sess-fg');
    assert.equal(fgEntry.turnId, 'turn-fg-1');
    assert.equal(fgEntry.userMessageSynced, true);
    assert.ok(forceSyncCalls.includes(true), '聚焦会话插回远端用户消息必须触发 onForceSyncMessageList(true)');
    assert.ok(state.messages.some((m) => m.role === 'user' && m.content === 'Remote Display Prompt'));
    assert.equal(state.isStreaming, true);
    assert.equal(state.turnStartedAt, fgEntry.startedAt);
    assert.equal(deps.getTurnStartedSessionId(), 'sess-fg');
    assert.ok(presenceEvents.includes('clear'));
    assert.ok(renderCount > rendersBeforeStart);

    dispatcher.applyTurnActions([
      { type: 'turn-started', sessionId: 'live-fg', turnId: 'turn-fg-override', text: 'Duplicate Prompt' },
    ]);
    assert.equal(fgEntry.turnId, 'turn-fg-1');
    assert.equal(state.messages.filter((m) => m.content === 'Duplicate Prompt').length, 0);

    const fgSyncCount = forceSyncCalls.length;
    const rendersTextOnly = renderCount;
    fgEntry.userMessageSynced = false;
    dispatcher.applyTurnActions([{ type: 'turn-started', sessionId: 'live-fg', turnId: 't-ignored', text: '' }]);
    assert.equal(fgEntry.userMessageSynced, false);
    dispatcher.applyTurnActions([{ type: 'turn-started', sessionId: 'live-fg', text: 'Action Text Only' }]);
    assert.equal(fgEntry.userMessageSynced, true);
    assert.equal(forceSyncCalls.length, fgSyncCount + 1);
    assert.equal(renderCount, rendersTextOnly + 1, '仅 cached/state 补插入远端消息即使 isStreaming 已为 true 也必须 render');
    assert.ok(state.messages.some((m) => m.role === 'user' && m.content === 'Action Text Only'));

    const armsBeforeTurn = watchdogEvents.filter((e) => e === 'arm').length;
    deps.setActiveStreamingContext({ activeStreamingStoredSessionId: null });
    state.activeSessionId = 'sess-unreg-turn';
    state.isStreaming = false;
    const tNowBefore = Date.now();
    dispatcher.applyTurnActions([{ type: 'turn-started', sessionId: '', turnId: 'ignored-unreg' }]);
    assert.equal(state.isStreaming, true);
    assert.ok(state.turnStartedAt >= tNowBefore);
    assert.equal(deps.getTurnStartedSessionId(), 'sess-unreg-turn');
    assert.equal(watchdogEvents.filter((e) => e === 'arm').length, armsBeforeTurn + 1);
    deps.setActiveStreamingContext({ activeStreamingStoredSessionId: null });
    state.activeSessionId = '';
    state.isStreaming = false;
    dispatcher.applyTurnActions([{ type: 'turn-started', sessionId: '' }]);
    assert.equal(state.isStreaming, true);
    assert.equal(deps.getTurnStartedSessionId(), '');
    assert.equal(watchdogEvents.filter((e) => e === 'arm').length, armsBeforeTurn + 2);
    state.activeSessionId = 'sess-fg';
    deps.setActiveStreamingContext({ activeStreamingStoredSessionId: 'sess-fg', activeStreamingLiveId: 'live-fg', activeStreamingMessageId: 'a-fg' });

    state.isStreaming = false;
    const rendersBeforeBgStart = renderCount;
    const armsBeforeBgStart = watchdogEvents.filter((e) => e === 'arm').length;
    state.sessions.push({ id: 'sess-known-bg2', title: 'BG2', botName: 'bg2', preview: '', timestamp: 80 });
    dispatcher.handleGatewayEvent({
      type: 'message.start',
      session_id: 'live-sess-known-bg2',
      payload: { turn_id: 'turn-bg2', display_text: 'bg2 prompt' },
    });
    assert.equal(state.isStreaming, false, '后台会话 turn-started 严禁污染前台 isStreaming');
    assert.equal(renderCount, rendersBeforeBgStart, '后台会话 turn-started 不应触发前台 render');
    assert.equal(watchdogEvents.filter((e) => e === 'arm').length, armsBeforeBgStart + 1);

    nearBottomFlag = false;
    state.activeSessionId = 'sess-fg2';
    state.activeLiveSessionId = 'live-fg2-custom';
    deps.toStoredSessionId = (id) => (id === 'live-fg2-custom' ? 'sess-fg2' : id.replace(/^live-/, ''));
    deps.getSessionMessagesCache().set('sess-fg2', []);
    dispatcher.handleGatewayEvent({
      kind: 'message.start',
      session_id: 'live-fg2-custom',
      payload: { text: 'Only Text Prompt' },
    });
    assert.ok(reg.hasSession('sess-fg2'));
    assert.deepEqual(expandedArgs.includes(false), true);
    assert.ok(ensureWindowArgs.length >= 1);
    assert.equal(pendingScrollArgs.length, 0, 'isStreamNearBottom 为 false 时不得设置 pendingScrollToBottom');
    assert.equal(reg.getBySession('sess-fg2').turnId, null);
    state.activeSessionId = 'sess-fg';
    state.activeLiveSessionId = 'live-fg';
    deps.toStoredSessionId = (id) => (id ? id.replace(/^live-/, '') : null);

    // 2. append-content: segment/offset/dedup + 无 registry fallback
    coalescer.clear();
    pushedTokens.length = 0;
    const feedsBeforeDelta = watchdogEvents.filter((e) => e === 'feed').length;
    dispatcher.applyTurnActions([
      { type: 'append-content', messageId: 'a-fg', text: 'Hello', turnId: 'turn-fg-1', segment: 0, offset: 0 },
    ]);
    coalescer.flush();
    assert.equal(pushedTokens.length, 1);
    assert.equal(pushedTokens[0].content, 'Hello');
    assert.equal(pushedTokens[0].thought, '');
    dispatcher.applyTurnActions([
      { type: 'append-content', messageId: 'a-fg', text: 'Hello', turnId: 'turn-fg-1', segment: 0, offset: 0 },
      { type: 'append-content', messageId: 'a-fg', text: '', turnId: 'turn-fg-1', segment: 0, offset: 5 },
    ]);
    coalescer.flush();
    assert.equal(pushedTokens.length, 1, '重复或空 delta 不得推送 tokenCoalescer');
    assert.equal(watchdogEvents.filter((e) => e === 'feed').length, feedsBeforeDelta + 1);

    dispatcher.applyTurnActions([{ type: 'append-content', messageId: 'unreg-msg', text: 'DirectChunk' }]);
    coalescer.flush();
    assert.equal(pushedTokens.length, 2);
    assert.equal(pushedTokens[1].content, 'DirectChunk');

    // 3. append-thought: 触活已注册流并推送 thought token
    fgEntry.lastActivityAt = 100;
    dispatcher.applyTurnActions([{ type: 'append-thought', messageId: 'a-fg', text: 'Think...' }]);
    coalescer.flush();
    assert.ok(fgEntry.lastActivityAt > 100, 'append-thought 必须 touchActivity 刷新 lastActivityAt');
    assert.equal(pushedTokens[2].thought, 'Think...');
    assert.equal(pushedTokens[2].content, '');

    // 4. interim-content
    dispatcher.applyTurnActions([
      { type: 'interim-content', messageId: 'a-fg', text: 'Next paragraph', alreadyStreamed: false, turnId: 'turn-fg-1', segment: 1 },
    ]);
    coalescer.flush();
    assert.equal(pushedTokens.length, 4);
    assert.equal(pushedTokens[3].content, '\n\nNext paragraph');
    const feedsBeforeSkipInterim = watchdogEvents.filter((e) => e === 'feed').length;
    dispatcher.applyTurnActions([
      { type: 'interim-content', messageId: 'a-fg', text: 'Already streamed', alreadyStreamed: true, turnId: 'turn-fg-1', segment: 1 },
      { type: 'interim-content', messageId: 'no-such-stream', text: 'Unregistered', alreadyStreamed: false },
    ]);
    coalescer.flush();
    assert.equal(pushedTokens.length, 4);
    assert.equal(watchdogEvents.filter((e) => e === 'feed').length, feedsBeforeSkipInterim + 2);

    // 5. stream-activity: 空 sessionId / 注册流 / ctx.activeStreamingStoredSessionId / runningSet 三路喂狗与未知过滤
    const feedsBeforeAct = watchdogEvents.filter((e) => e === 'feed').length;
    dispatcher.applyTurnActions([
      { type: 'stream-activity', sessionId: '', eventType: 'tool.progress' },
      { type: 'stream-activity', sessionId: 'live-unknown-idle', eventType: 'tool.progress' },
    ]);
    assert.equal(watchdogEvents.filter((e) => e === 'feed').length, feedsBeforeAct);

    deps.setActiveStreamingContext({ activeStreamingStoredSessionId: 'sess-ctx-only', activeStreamingLiveId: 'live-sess-ctx-only', activeStreamingMessageId: 'm-ctx' });
    dispatcher.applyTurnActions([{ type: 'stream-activity', sessionId: 'live-sess-ctx-only', eventType: 'tool.progress' }]);
    assert.equal(watchdogEvents.filter((e) => e === 'feed').length, feedsBeforeAct + 1);

    deps.getActiveRunningSessionIds().add('sess-running-only');
    dispatcher.applyTurnActions([{ type: 'stream-activity', sessionId: 'live-sess-running-only', eventType: 'tool.progress' }]);
    assert.equal(watchdogEvents.filter((e) => e === 'feed').length, feedsBeforeAct + 2);
    deps.setActiveStreamingContext({ activeStreamingStoredSessionId: 'sess-fg', activeStreamingLiveId: 'live-fg', activeStreamingMessageId: 'a-fg' });

    // 6. tool-start & tool-complete: JSON 解析 / delegation_id / 重复防重 / 后台 cachedTarget / durationMs 取大 / JSON output
    const separateFgCache = [
      { id: 'u-fg', role: 'user', content: 'hi', timestamp: '12:00:00' },
      { id: 'a-fg', role: 'assistant', content: '', thought: '', timestamp: '12:00:01' },
    ];
    deps.getSessionMessagesCache().set('sess-fg', separateFgCache);
    const patchCountBeforeTool = patchedTools.length;
    const statusCountBeforeTool = statusActions.length;

    dispatcher.applyTurnActions([
      {
        type: 'tool-start',
        messageId: 'a-fg',
        toolCall: { id: 'tc-str', name: 'delegate_task', args: '  {"delegation_id":"del-1","foo":"bar"} ' },
      },
      {
        type: 'tool-start',
        messageId: 'a-fg',
        toolCall: { id: 'tc-str', name: 'delegate_task', args: '{"delegationId":"del-dup"}' },
      },
      {
        type: 'tool-start',
        messageId: 'a-fg',
        toolCall: { id: 'tc-bad', name: 'read', args: '{bad json' },
      },
      {
        type: 'tool-start',
        messageId: 'a-fg',
        toolCall: { id: 'tc-arr', name: 'read', args: [1, 2] },
      },
    ]);

    const fgAst = state.messages.find((m) => m.id === 'a-fg');
    assert.equal(fgAst.toolCalls.length, 3);
    assert.deepEqual(fgAst.toolCalls[0].rawArgs, { delegation_id: 'del-1', foo: 'bar' });
    assert.equal(fgAst.toolCalls[0].delegationId, 'del-1');
    assert.equal(fgAst.toolCalls[1].rawArgs, undefined);
    assert.equal(fgAst.toolCalls[2].rawArgs, undefined);
    assert.equal(separateFgCache[1].toolCalls.length, 3, '独立缓存数组必须同步更新 toolCalls');
    assert.equal(statusActions.length, statusCountBeforeTool + 2, '仅 delegate_task 触发 onStatusTurnAction');
    assert.equal(patchedTools.length, patchCountBeforeTool + 4);

    const bgAst = bgMsgs.find((m) => m.id === bgStream.messageId);
    assert.equal(bgAst.toolCalls, undefined);
    bgStream.lastActivityAt = 100;
    dispatcher.applyTurnActions([
      {
        type: 'tool-start',
        messageId: bgStream.messageId,
        toolCall: { id: 'tc-bg-1', name: 'bash', args: { delegationId: 'del-bg-2', cmd: 'ls' } },
      },
      {
        type: 'tool-start',
        messageId: bgStream.messageId,
        toolCall: { id: 'tc-bg-2', name: 'read', args: '{"path":"README.md"}' },
      },
    ]);
    assert.equal(bgAst.toolCalls.length, 2);
    assert.equal(bgAst.toolCalls[0].status, 'running');
    assert.equal(bgAst.toolCalls[0].delegationId, 'del-bg-2');
    assert.deepEqual(bgAst.toolCalls[1].rawArgs, { path: 'README.md' });
    assert.deepEqual(separateFgCache[1].toolCalls[0].rawArgs, { delegation_id: 'del-1', foo: 'bar' });
    assert.equal(patchedTools.length, patchCountBeforeTool + 4, '后台会话 tool-start 不得调度前台 scheduleToolPatch');
    assert.ok(bgStream.lastActivityAt > 100);

    deps.setActiveStreamingContext({ activeStreamingStoredSessionId: null });
    state.messages.push({ id: 'a-no-owner', role: 'assistant', content: '', timestamp: '12:00:02' });
    dispatcher.applyTurnActions([
      { type: 'tool-start', messageId: 'a-no-owner', toolCall: { id: 'tc-no-own', name: 'read', args: {} } },
      { type: 'tool-complete', messageId: 'a-no-owner', toolCallId: 'tc-no-own', durationMs: 25 },
    ]);
    const noOwnMsg = state.messages.find((m) => m.id === 'a-no-owner');
    assert.equal(noOwnMsg.toolCalls[0].status, 'completed');
    assert.equal(noOwnMsg.toolCalls[0].durationMs, 25);
    assert.equal(noOwnMsg.toolCalls[0].output, undefined);
    deps.setActiveStreamingContext({ activeStreamingStoredSessionId: 'sess-fg', activeStreamingLiveId: 'live-fg', activeStreamingMessageId: 'a-fg' });

    fgAst.toolCalls[0].durationMs = 500;
    fgAst.toolCalls[1].startTime = Date.now() - 400;
    fgAst.toolCalls[1].durationMs = 150;
    fgAst.toolCalls[2].startTime = Date.now() - 20;
    fgAst.toolCalls[2].durationMs = undefined;
    separateFgCache[1].toolCalls[0].durationMs = 100;
    const patchesBeforeComplete = patchedTools.length;
    dispatcher.applyTurnActions([
      { type: 'tool-complete', messageId: 'a-fg', toolCallId: 'tc-str', output: { ok: true }, durationMs: 200 },
      { type: 'tool-complete', messageId: 'a-fg', toolCallId: 'tc-bad', output: 'str-ok', durationMs: -5 },
      { type: 'tool-complete', messageId: 'a-fg', toolCallId: 'tc-arr' },
      { type: 'tool-complete', messageId: 'a-fg', toolCallId: 'tc-missing' },
      { type: 'tool-complete', messageId: bgStream.messageId, toolCallId: 'tc-bg-1', durationMs: 0 },
    ]);
    assert.equal(fgAst.toolCalls[0].output, JSON.stringify({ ok: true }, null, 2));
    assert.equal(fgAst.toolCalls[0].durationMs, 500, '既有更大 durationMs 不得被更小 serverMs 覆写');
    assert.equal(separateFgCache[1].toolCalls[0].durationMs, 200);
    assert.equal(fgAst.toolCalls[1].output, 'str-ok');
    assert.ok(fgAst.toolCalls[1].durationMs >= 350 && fgAst.toolCalls[1].durationMs < 3000, '负 serverMs 与已有较小 durationMs 应回退并取 Math.max(durationMs, now-startTime)');
    assert.equal(fgAst.toolCalls[2].durationMs, 100, '不足 100ms 时保底为 Math.max(100, elapsed)=100');
    assert.equal(bgAst.toolCalls[0].status, 'completed');
    assert.equal(bgAst.toolCalls[0].durationMs, 0);
    assert.equal(patchedTools.length, patchesBeforeComplete + 4, '仅 focused tool-complete 调用 scheduleToolPatch，后台不调用');

    fgAst.toolCalls[2].startTime = undefined;
    fgAst.toolCalls[2].durationMs = undefined;
    dispatcher.applyTurnActions([{ type: 'tool-complete', messageId: 'a-fg', toolCallId: 'tc-arr' }]);
    assert.equal(fgAst.toolCalls[2].durationMs, undefined);

    // 7. persisted-turn
    persistCalls.length = 0;
    const rendersBeforePersist = renderCount;
    fgEntry.botName = 'fg-bot';
    dispatcher.applyTurnActions([
      { type: 'persisted-turn', messageId: 'a-fg', userRowId: 10, assistantRowId: 11 },
    ]);
    assert.equal(fgAst.rowId, 11);
    assert.equal(separateFgCache[0].rowId, 10);
    assert.equal(separateFgCache[1].rowId, 11);
    assert.equal(persistCalls.length, 1);
    assert.equal(persistCalls[0].sid, 'sess-fg');
    assert.equal(persistCalls[0].bot, 'fg-bot');
    assert.ok(renderCount > rendersBeforePersist);

    persistCalls.length = 0;
    deps.setActiveStreamingContext({ activeStreamingStoredSessionId: 'sess-fg', activeStreamingBotName: 'ctx-fallback-bot' });
    separateFgCache.push({ id: 'u2', role: 'user', content: 'q2', timestamp: '12:01:00' });
    separateFgCache.push({ id: 'a2', role: 'assistant', content: 'ans2', timestamp: '12:01:01' });
    reg.registerStream({ storedSessionId: 'sess-fg', liveSessionId: 'live-fg', messageId: 'a2', origin: 'local' });
    dispatcher.applyTurnActions([
      { type: 'persisted-turn', messageId: 'a2', userRowId: 20, assistantRowId: 21 },
    ]);
    assert.equal(separateFgCache[2].rowId, 20);
    assert.equal(separateFgCache[3].rowId, 21);
    assert.equal(persistCalls.length, 1);
    assert.equal(persistCalls[0].bot, 'ctx-fallback-bot');

    separateFgCache.push({ id: 'u3', role: 'user', content: 'q3', timestamp: '12:02:00' });
    separateFgCache.push({ id: 'a3', role: 'assistant', content: 'ans3', timestamp: '12:02:01' });
    reg.registerStream({ storedSessionId: 'sess-fg', liveSessionId: 'live-fg', messageId: 'a3', origin: 'local', botName: 'fg-bot-2' });
    dispatcher.applyTurnActions([
      { type: 'persisted-turn', messageId: 'a3', userRowId: 30, assistantRowId: 31 },
    ]);
    assert.equal(separateFgCache[4].rowId, 30);
    assert.equal(separateFgCache[5].rowId, 31);
    assert.equal(persistCalls.length, 2);
    assert.equal(persistCalls[1].bot, 'fg-bot-2');

    persistCalls.length = 0;
    const rendersNoopPersist = renderCount;
    dispatcher.applyTurnActions([
      { type: 'persisted-turn', messageId: 'non-existent', userRowId: 99, assistantRowId: 100 },
    ]);
    assert.equal(persistCalls.length, 0);
    assert.equal(renderCount, rendersNoopPersist);

    persistCalls.length = 0;
    const rendersBgPersist = renderCount;
    dispatcher.applyTurnActions([
      { type: 'persisted-turn', messageId: bgStream.messageId, userRowId: 50, assistantRowId: 51 },
    ]);
    assert.equal(bgAst.rowId, 51);
    assert.equal(persistCalls.length, 1);
    assert.equal(persistCalls[0].sid, 'sess-known-bg');
    assert.equal(persistCalls[0].bot, 'bg-bot');
    assert.equal(persistCalls[0].clone, bgMsgs);
    assert.ok(renderCount > rendersBgPersist);

    persistCalls.length = 0;
    state.activeSessionId = 'sess-fg-unreg';
    deps.setActiveStreamingContext({ activeStreamingStoredSessionId: null, activeStreamingBotName: 'leaked-bot' });
    state.messages.push({ id: 'u-fall', role: 'user', content: 'qf' });
    state.messages.push({ id: 'a-fall', role: 'assistant', content: 'af' });
    dispatcher.applyTurnActions([
      { type: 'persisted-turn', messageId: 'a-fall', userRowId: 60, assistantRowId: 61 },
    ]);
    assert.equal(persistCalls.length, 1);
    assert.equal(persistCalls[0].sid, 'sess-fg-unreg');
    assert.equal(persistCalls[0].bot, null);

    persistCalls.length = 0;
    state.activeSessionId = '';
    state.messages.push({ id: 'u-noowner', role: 'user', content: 'qno' });
    state.messages.push({ id: 'a-noowner', role: 'assistant', content: 'ano' });
    dispatcher.applyTurnActions([
      { type: 'persisted-turn', messageId: 'a-noowner', userRowId: 70, assistantRowId: 71 },
    ]);
    assert.equal(persistCalls.length, 0);
    state.activeSessionId = 'sess-fg';

    // liveCoord 适配器闭合验证（通过 dispatcher 暴露的协调器方法触发所有 L194-217 回调）
    const attachOk = dispatcher.attachLiveTurnFromResume({
      storedSessionId: 'sess-attach-disp',
      liveSessionId: 'live-attach-disp',
      botName: 'attach-bot',
      resumeResult: { running: true, inflight: { streaming: true, user: 'u-res', assistant: 'prefix-a' } },
    });
    assert.equal(attachOk, true);
    const attachStream = reg.getBySession('sess-attach-disp');
    assert.ok(attachStream);
    const attachMsg = deps.getSessionMessagesCache().get('sess-attach-disp')?.find((m) => m.id === attachStream.messageId);
    assert.equal(attachMsg?.content, 'prefix-a');
    state.activeSessionId = 'sess-attach-disp';
    state.messages = deps.getSessionMessagesCache().get('sess-attach-disp');
    dispatcher.syncFocusedStreamingProjection('sess-attach-disp');
    assert.equal(deps.getTurnStartedSessionId(), 'sess-attach-disp');
    assert.equal(deps.getActiveStreamingContext().activeStreamingStoredSessionId, 'sess-attach-disp');

    let adapterPresenceSyncs = 0;
    deps.syncAgentPresence = () => { adapterPresenceSyncs += 1; };
    await dispatcher.reconcileActiveTurnFromResume('sess-attach-disp', {
      running: true,
      inflight: { streaming: true, assistant: 'prefix-a-reconciled' },
    });
    assert.equal(state.messages[state.messages.length - 1].content, 'prefix-a-reconciled', 'setMessageContent 适配器必须写入最新投影');

    // 8. session.info non-running vs running & subagent-failed/complete 喂狗
    const feedsBeforeInfo = watchdogEvents.filter((e) => e === 'feed').length;
    dispatcher.applyTurnActions([
      { type: 'session-info', sessionId: 'live-fg', info: { running: false, streaming: false } },
    ]);
    assert.equal(watchdogEvents.filter((e) => e === 'feed').length, feedsBeforeInfo, '非运行 session.info 不得喂狗');

    dispatcher.applyTurnActions([
      { type: 'subagent-complete', sessionId: 'live-fg', subagentId: 'sa-1' },
    ]);
    assert.equal(watchdogEvents.filter((e) => e === 'feed').length, feedsBeforeInfo + 1);

    for (const sid of reg.listSessionIds()) {
      reg.removeSession(sid);
    }
    const disarmsBeforeReconcile = watchdogEvents.filter((e) => e === 'disarm').length;
    dispatcher.syncFocusedStreamingProjection('sess-attach-disp');
    assert.ok(watchdogEvents.filter((e) => e === 'disarm').length > disarmsBeforeReconcile);
    assert.ok(presenceEvents.filter((e) => e === 'clear').length >= 1);
    assert.equal(adapterPresenceSyncs >= 1, true);

    reg.registerStream({ storedSessionId: 'sess-disc', liveSessionId: 'live-disc', messageId: 'm-disc', origin: 'local' });
    const disarmsBeforeDisc = watchdogEvents.filter((e) => e === 'disarm').length;
    assert.ok(reg.size() > 0, 'disconnect 前流式注册表应仍有活跃句柄');
    dispatcher.disconnect();
    assert.equal(reg.size(), 0, 'disconnect 必须清空 LiveStreamRegistry，防止残留流跨连接污染');
    assert.ok(watchdogEvents.filter((e) => e === 'disarm').length > disarmsBeforeDisc);
  } finally {
    coalescer?.clear();
    dispatcher?.disconnect();
    t.mock.timers.reset();
  }
});

test('D6: gatewayEventDispatcher - tool-complete action.inlineDiff 同步更新前景与缓存工具调用', () => {
  const { deps, state, patchedTools } = createMockDispatcherDeps({
    state: {
      messages: [
        { id: 'usr-1', role: 'user', content: 'hi', timestamp: '12:00:00' },
        {
          id: 'ast-1',
          role: 'assistant',
          content: '',
          timestamp: '12:00:01',
          toolCalls: [{ id: 'tc-diff', name: 'edit_file', status: 'running', startTime: 1000 }],
        },
      ],
    },
  });
  const cachedMsgs = [
    { id: 'usr-1', role: 'user', content: 'hi', timestamp: '12:00:00' },
    {
      id: 'ast-1',
      role: 'assistant',
      content: '',
      timestamp: '12:00:01',
      toolCalls: [{ id: 'tc-diff', name: 'edit_file', status: 'running', startTime: 1000 }],
    },
  ];
  deps.getSessionMessagesCache().set('sess-1', cachedMsgs);
  const dispatcher = createGatewayEventDispatcher(deps);
  const inlineDiff = { path: 'src/app.ts', oldText: 'const a = 1;', newText: 'const a = 2;' };

  try {
    dispatcher.applyTurnActions([
      { type: 'tool-complete', messageId: 'ast-1', toolCallId: 'tc-diff', durationMs: 42, inlineDiff },
    ]);

    assert.deepEqual(state.messages[1].toolCalls[0].inlineDiff, inlineDiff);
    assert.deepEqual(cachedMsgs[1].toolCalls[0].inlineDiff, inlineDiff);
    assert.ok(patchedTools.includes('ast-1'));
  } finally {
    dispatcher.disconnect();
  }
});

test('D6: gatewayEventDispatcher - 无 streamRegistry 降级模式下 turn-started 开启流式态与看门狗', () => {
  const { deps, state, watchdogEvents } = createMockDispatcherDeps({
    state: { activeSessionId: 'sess-bg', isStreaming: false },
  });
  deps.getLiveStreamRegistry = undefined;
  const noRegDispatcher = createGatewayEventDispatcher(deps);
  const armsBefore = watchdogEvents.filter((e) => e === 'arm').length;
  try {
    noRegDispatcher.applyTurnActions([{ type: 'turn-started', sessionId: 'live-sess-bg' }]);
    assert.equal(state.isStreaming, true);
    assert.equal(watchdogEvents.filter((e) => e === 'arm').length, armsBefore + 1);
  } finally {
    noRegDispatcher.disconnect();
  }
});
