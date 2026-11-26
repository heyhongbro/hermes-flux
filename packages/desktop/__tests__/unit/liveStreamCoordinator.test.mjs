/**
 * 多端协同与并发流协调器 (LiveStreamCoordinator + GatewayEventDispatcher) 全场景单测
 * (packages/desktop/__tests__/unit/liveStreamCoordinator.test.mjs)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createGatewayEventDispatcher, createLiveStreamCoordinator, resolveBotNameForSession } from '../../dist/renderer/gateway/gatewayEventDispatcher.mjs';
import { createTokenStreamWriter } from '../../dist/renderer/stream/tokenStreamWriter.mjs';
import {
  advanceTimers,
  createMultiSessionHarness as createHarness,
  flushMicrotasks,
} from './helpers/liveStreamHarness.mjs';

const createMultiSessionHarness = (overrides) =>
  createHarness({ createGatewayEventDispatcher, createTokenStreamWriter }, overrides);

test('双端观察者自动挂载流、补齐远端用户气泡、按游标去重、并平滑收口', async () => {
  const resumeCalls = [];
  const h = createMultiSessionHarness({
    gatewayClient: {
      call: async (method, params) => {
        resumeCalls.push({ method, params });
        if (method === 'session.resume') {
          return {
            running: true,
            inflight: { streaming: true, user: '远端提问内容', assistant: 'He' },
          };
        }
        return {};
      },
      fetchSessionMessages: async () => ({ status: 'success', messages: [] }),
      disconnect: () => {},
    },
  });

  try {
    // 1. 远端启动回合（message.start 未携带 prompt text -> 非阻塞 session.resume 补齐 user 气泡）
  h.dispatcher.handleGatewayEvent({
    type: 'message.start',
    session_id: 'live-a',
    payload: { turn_id: 'turn-1' },
  });

  assert.equal(h.state.isStreaming, true, '观察端收到远端 message.start 必须立即进入流式态');
  const stream = h.liveStreamRegistry.getBySession('sess-a');
  assert.ok(stream, '必须自动注册 origin=remote 的流记录');
  assert.equal(stream.origin, 'remote');

  // 2. 收到增量（含重复分片）+ 阶段补丁 message.interim + 工具流 + 终态收口
  h.dispatcher.handleGatewayEvent({
    type: 'message.delta',
    session_id: 'live-a',
    payload: { turn_id: 'turn-1', segment: 0, offset: 0, text: 'Hello' },
  });
  h.dispatcher.handleGatewayEvent({
    type: 'message.delta',
    session_id: 'live-a',
    payload: { turn_id: 'turn-1', segment: 0, offset: 0, text: 'Hello' },
  });
  h.dispatcher.handleGatewayEvent({
    type: 'message.delta',
    session_id: 'live-a',
    payload: { turn_id: 'turn-1', segment: 0, offset: 3, text: 'lo World' },
  });
  h.tokenCoalescer.flush();

  await flushMicrotasks();
  assert.equal(resumeCalls.length, 1);
  assert.equal(resumeCalls[0].params.omit_messages, true);
  assert.equal(h.state.messages[0].role, 'user');
  assert.equal(h.state.messages[0].content, '远端提问内容', '必须把远端用户提问插入流式助手泡之前');
  assert.equal(h.state.messages[1].id, stream.messageId);
  assert.equal(h.state.messages[1].content, 'Hello World', '重复与重叠分片必须去重不双写且不被较短 inflight 回退');

  // 3. 阶段文本补丁与持久化 rowId 绑定、收口
  h.dispatcher.handleGatewayEvent({
    type: 'message.interim',
    session_id: 'live-a',
    payload: { turn_id: 'turn-1', segment: 1, text: '阶段补充', already_streamed: false },
  });
  h.dispatcher.handleGatewayEvent({
    type: 'message.complete',
    session_id: 'live-a',
    payload: {
      text: 'Hello World\n\n阶段补充',
      persisted_turn: { user_row_id: 101, final_assistant_row_id: 102, row_ids: [101, 102] },
    },
  });

  assert.equal(h.state.isStreaming, false);
  assert.equal(h.liveStreamRegistry.hasSession('sess-a'), false);
  assert.equal(h.state.messages[0].rowId, 101);
  assert.equal(h.state.messages[1].rowId, 102);
  assert.equal(h.state.messages[1].content, 'Hello World\n\n阶段补充');
  } finally {
    h.dispatcher.disconnect();
  }
});

test('多会话并发严格物理隔离：后台 sess-b 流式输出与完成绝不污染前台 sess-a', () => {
  const h = createMultiSessionHarness();

  // sess-a 与 sess-b 同时流式输出
  h.dispatcher.handleGatewayEvent({
    type: 'message.start',
    session_id: 'live-a',
    payload: { turn_id: 'ta', display_text: 'Ask A' },
  });
  h.dispatcher.handleGatewayEvent({
    type: 'message.start',
    session_id: 'live-b',
    payload: { turn_id: 'tb', display_text: 'Ask B' },
  });
  h.dispatcher.handleGatewayEvent({
    type: 'message.delta',
    session_id: 'live-a',
    payload: { turn_id: 'ta', segment: 0, offset: 0, text: 'Reply A ' },
  });
  h.dispatcher.handleGatewayEvent({
    type: 'message.delta',
    session_id: 'live-b',
    payload: { turn_id: 'tb', segment: 0, offset: 0, text: 'Reply B' },
  });
  h.tokenCoalescer.flush();

  const aMsgs = h.state.messages;
  const bMsgs = h.sessionMessagesCache.get('sess-b');
  assert.equal(aMsgs.filter((m) => m.role === 'user')[0].content, 'Ask A');
  assert.equal(aMsgs.filter((m) => m.role === 'assistant')[0].content, 'Reply A ');
  assert.equal(bMsgs.filter((m) => m.role === 'user')[0].content, 'Ask B');
  assert.equal(bMsgs.filter((m) => m.role === 'assistant')[0].content, 'Reply B');

  // sess-b 在后台先结束，前台 sess-a 必须依然保持流式态与看门狗激活
  h.dispatcher.handleGatewayEvent({
    type: 'message.complete',
    session_id: 'live-b',
    payload: { text: 'Reply B' },
  });

  assert.equal(h.liveStreamRegistry.hasSession('sess-b'), false);
  assert.equal(h.unreadSessions.has('sess-b'), true);
  assert.equal(h.state.isStreaming, true, '后台 sess-b 结束绝对不能关停前台 sess-a 的流式状态');
  assert.equal(h.liveStreamRegistry.hasSession('sess-a'), true);

  // sess-a 继续输出不丢文字
  h.dispatcher.handleGatewayEvent({
    type: 'message.delta',
    session_id: 'live-a',
    payload: { turn_id: 'ta', segment: 0, offset: 8, text: 'cont.' },
  });
  h.tokenCoalescer.flush();
  assert.equal(h.state.messages.find((m) => m.role === 'assistant').content, 'Reply A cont.');
});

test('退出重进恢复（attachLiveTurnFromResume）、session.reclaimed 与空闲 sessions.changed 同步', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_700_000_000_000 });
  const h = createMultiSessionHarness({
    state: {
      activeSessionId: 'sess-a',
      messages: [{ id: 'hist-1', role: 'user', rowId: 1, content: '已落盘提问' }],
    },
  });

  try {
  // 1. 重进会话从 session.resume 接管运行中长任务（Unix 秒时间戳须归一化，用户气泡不重复）
  const attached = h.dispatcher.attachLiveTurnFromResume({
    storedSessionId: 'sess-a',
    liveSessionId: 'live-a-new',
    resumeResult: {
      running: true,
      turn_started_at: 1700000000,
      inflight: {
        streaming: true,
        user: '已落盘提问',
        assistant: '已恢复在途前缀',
      },
    },
    botName: null,
  });

  assert.equal(attached, true);
  assert.equal(h.state.isStreaming, true);
  assert.equal(h.state.activeLiveSessionId, 'live-a-new');
  assert.equal(h.state.turnStartedAt, 1700000000 * 1000);
  assert.equal(h.state.messages.filter((m) => m.role === 'user').length, 1, '已落盘用户消息不得重复插入');
  assert.equal(h.state.messages[1].content, '已恢复在途前缀');

  // 后续流式 delta 在 inflight 基础上无缝续接
  h.dispatcher.handleGatewayEvent({
    type: 'message.delta',
    session_id: 'live-a-new',
    payload: { text: ' + 新增流式' },
  });
  h.tokenCoalescer.flush();
  assert.equal(h.state.messages[1].content, '已恢复在途前缀 + 新增流式');

  // 2. 非 Delta 保活事件 + session.info(running) 驱动喂狗
  const beforeFeed = h.counters().watchdogFed;
  h.dispatcher.handleGatewayEvent({
    type: 'tool.progress',
    session_id: 'live-a-new',
    payload: { percent: 50 },
  });
  h.dispatcher.handleGatewayEvent({
    type: 'session.info',
    session_id: 'live-a-new',
    payload: { running: true },
  });
  assert.equal(h.counters().watchdogFed, beforeFeed + 2);

  // 3. session.reclaimed 回收句柄触发清理与自愈拉取
  h.dispatcher.handleGatewayEvent({
    type: 'session.reclaimed',
    session_id: 'live-a-new',
    payload: { stored_session_id: 'sess-a', reason: 'ttl' },
  });
  assert.equal(h.liveStreamRegistry.hasSession('sess-a'), false);
  assert.equal(h.state.activeLiveSessionId, '');
  assert.equal(h.state.isStreaming, false);
  assert.equal(h.counters().refreshActiveCalls, 1);

  // 4. 空闲会话收到 sessions.changed 广播防抖同步当前会话消息
  h.dispatcher.handleGatewayEvent({ type: 'sessions.changed', payload: {} });
  await advanceTimers(t, 149);
  assert.equal(h.counters().refreshActiveCalls, 1, '149ms 时防抖定时器不得提前触发');
  await advanceTimers(t, 1);
  assert.equal(h.counters().refreshActiveCalls, 2);
  } finally {
    h?.dispatcher.disconnect();
    t.mock.timers.reset();
  }
});

test('Stage4 回归防护: 节拍器并发对账去重、后台无句柄流收口/失败不污染空闲前景、空 activeIds 过滤', async () => {
  // 1. 节拍器 cadence 开启且尚有排队 token 时执行对账覆盖，必须丢弃旧队列不产生尾部重复正文
  const h = createMultiSessionHarness({
    gatewayClient: {
      call: async (method) => {
        if (method === 'session.resume') {
          return {
            running: true,
            inflight: { streaming: true, user: 'prompt-cadence', assistant: 'ABCDEFGH_RECONCILED' },
          };
        }
        return {};
      },
      fetchSessionMessages: async () => ({ status: 'success', messages: [] }),
      disconnect: () => {},
    },
  });
  // 用 cadence:true（默认真实节拍器）推入分片，前 2~6 字符留在队列尚未 flush
  h.dispatcher.handleGatewayEvent({
    type: 'message.start',
    session_id: 'live-a',
    payload: { turn_id: 'tc-1', display_text: 'prompt-cadence' },
  });
  h.dispatcher.handleGatewayEvent({
    type: 'message.delta',
    session_id: 'live-a',
    payload: { turn_id: 'tc-1', segment: 0, offset: 0, text: 'ABCDEFGH' },
  });
  // 在 coalescer 未 flush 完前，看门狗探活对账写入更长权威快照
  h.dispatcher.reconcileActiveTurnFromResume('sess-a', {
    running: true,
    inflight: { streaming: true, user: 'prompt-cadence', assistant: 'ABCDEFGH_RECONCILED' },
  });
  h.tokenCoalescer.flush();
  const astMsg = h.state.messages.find((m) => m.role === 'assistant');
  assert.equal(astMsg.content, 'ABCDEFGH_RECONCILED', '对账覆盖后残余 queued token 绝不得重复追加到尾部');

  // 完成 sess-a，前景恢复完全空闲
  h.dispatcher.handleGatewayEvent({
    type: 'message.complete',
    session_id: 'live-a',
    payload: { text: 'ABCDEFGH_RECONCILED' },
  });
  assert.equal(h.state.isStreaming, false);

  // 2. 后台 sess-b 以全新未登记到 SessionHandleRegistry 的 liveId ('ephemeral-b-live') 运行与失败/完成，
  //    前景处于空闲时绝不可泄露 presenceTerminal 或 dockNotice 到前景
  h.state.dockNotice = '';
  h.state.presenceTerminal = undefined;
  h.liveStreamRegistry.registerStream({
    storedSessionId: 'sess-b',
    liveSessionId: 'ephemeral-b-live',
    messageId: 'ast-b-ephemeral',
    origin: 'remote',
    nowMs: 2000,
  });
  h.runningSessions.add('sess-b');
  h.sessionMessagesCache.set('sess-b', [{ id: 'ast-b-ephemeral', role: 'assistant', content: '' }]);

  const disarmsBefore = h.counters().watchdogDisarmed;
  h.dispatcher.handleGatewayEvent({
    type: 'error',
    session_id: 'ephemeral-b-live',
    payload: { message: 'background crash' },
  });
  assert.equal(h.liveStreamRegistry.hasSession('sess-b'), false, '必须通过 liveStreamRegistry 匹配到 sess-b 并移除');
  assert.equal(h.runningSessions.has('sess-b'), false);
  assert.equal(h.counters().watchdogDisarmed, disarmsBefore + 1, '全部流结束必须撤防看门狗（后台 error）');
  assert.equal(h.state.presenceTerminal, undefined, '后台失败绝不可污染空闲前景的 presenceTerminal');
  assert.equal(h.state.dockNotice, '', '后台失败绝不可污染空闲前景的 dockNotice');

  // 2b. 后台 sess-b 以全新未登记 liveId 正常完成 (turn-completed)，同样必须在前景空闲时撤防看门狗且不污染前景
  h.liveStreamRegistry.registerStream({
    storedSessionId: 'sess-b',
    liveSessionId: 'ephemeral-b-live-2',
    messageId: 'ast-b-ephemeral-2',
    origin: 'remote',
    nowMs: 3000,
  });
  h.runningSessions.add('sess-b');
  h.sessionMessagesCache.set('sess-b', [{ id: 'ast-b-ephemeral-2', role: 'assistant', content: '' }]);
  const disarmsBeforeDone = h.counters().watchdogDisarmed;
  h.dispatcher.handleGatewayEvent({
    type: 'message.complete',
    session_id: 'ephemeral-b-live-2',
    payload: { text: 'background done' },
  });
  assert.equal(h.liveStreamRegistry.hasSession('sess-b'), false, 'turn-completed 必须移除 sess-b');
  assert.equal(h.runningSessions.has('sess-b'), false);
  assert.equal(h.counters().watchdogDisarmed, disarmsBeforeDone + 1, '全部流结束必须撤防看门狗（后台 turn-completed）');
  assert.equal(h.state.presenceTerminal, undefined);

  // 3. 群聊/无活动单聊（activeSessionIds 为空）时，陌生会话事件绝不旁路触发 isStreaming
  h.state.activeSessionId = '';
  h.state.activeLiveSessionId = '';
  h.dispatcher.handleGatewayEvent({
    type: 'message.start',
    session_id: 'stray-unknown-sess',
    payload: { text: 'hijack' },
  });
  assert.equal(h.state.isStreaming, false);
  assert.equal(h.liveStreamRegistry.size(), 0);
  h.dispatcher.disconnect();
});


test('LiveStreamCoordinator 全分支覆盖: ForeverChat / reconcile(append|attach) / fetch降级补气泡 / 广播防抖与跳过', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_700_000_000_000 });
  let h;
  try {
  let resumeMode = 'empty-user';
  let fetchMessagesMode = 'normal';
  const fetchedCalls = [];
  h = createMultiSessionHarness({
    state: {
      activeSessionId: 'sess-forever',
      activeLiveSessionId: 'live-forever',
      sessions: [
        { id: 'sess-forever', title: 'Forever', botName: 'arch-bot', preview: '', timestamp: 2000 },
        { id: 'sess-a', title: 'Session A', botName: 'default', preview: '', timestamp: 1000 },
        { id: 'sess-b', title: 'Session B', botName: 'default', preview: '', timestamp: 900 },
      ],
      messages: [
        { id: 'ast-existing', role: 'assistant', content: 'old-prefix' },
      ],
    },
    gatewayClient: {
      call: async (method) => {
        if (method === 'session.resume') {
          if (resumeMode === 'throw') throw new Error('resume unavailable');
          return { running: true, inflight: { streaming: true, user: '', assistant: '' } };
        }
        return {};
      },
      fetchSessionMessages: async (sid) => {
        fetchedCalls.push({ sid, mode: fetchMessagesMode });
        if (fetchMessagesMode === 'throw') {
          throw new Error('fetch unavailable');
        }
        return {
          status: 'success',
          messages: [
            { id: 'r-u', row_id: 501, role: 'user', content: 'restored-from-fetch' },
            { id: 'r-a', row_id: 502, role: 'assistant', content: 'wip' },
          ],
        };
      },
      disconnect: () => {},
    },
  });
  h.sessionMessagesCache.set('sess-forever', h.state.messages);

  // 1. attachLiveTurnFromResume: 非运行态返回 false
  assert.equal(
    h.dispatcher.attachLiveTurnFromResume({
      storedSessionId: 'sess-forever',
      liveSessionId: 'live-forever',
      resumeResult: { running: false },
    }),
    false,
  );

  // 2. ForeverChat 复用已存在末尾助手气泡并协调文本 + 毫秒时间戳直通 + 补插 user 提问 + 二次 attach 幂等追加
  const okAttach = h.dispatcher.attachLiveTurnFromResume({
    storedSessionId: 'sess-forever',
    liveSessionId: 'live-forever',
    resumeResult: {
      running: true,
      turn_started_at: 1_700_000_000_555,
      inflight: { streaming: true, user: 'forever-q', assistant: 'old-prefix-extended' },
    },
    botName: 'arch-bot',
  });
  assert.equal(okAttach, true);
  assert.equal(h.state.turnStartedAt, 1_700_000_000_555);
  assert.equal(h.state.messages[0].role, 'user');
  assert.equal(h.state.messages[0].content, 'forever-q');
  assert.equal(h.state.messages[1].id, 'ast-existing');
  assert.equal(h.state.messages[1].content, 'old-prefix-extended');

  // 二次 attach 到已存在的流（命中 existing 分支并做更长正文协调）
  assert.equal(
    h.dispatcher.attachLiveTurnFromResume({
      storedSessionId: 'sess-forever',
      liveSessionId: 'live-forever-2',
      resumeResult: {
        running: true,
        inflight: { streaming: true, user: 'forever-q', assistant: 'old-prefix-extended-v2' },
      },
    }),
    true,
  );
  assert.equal(h.state.messages[1].content, 'old-prefix-extended-v2');

  // 3. reconcileActiveTurnFromResume: append 分支 -> 未注册流按 running=true 挂载 -> 前景完成清理
  h.dispatcher.reconcileActiveTurnFromResume('sess-forever', {
    running: true,
    inflight: { streaming: true, user: 'forever-q', assistant: 'old-prefix-extended-v2 + tail' },
  });
  assert.equal(h.state.messages[1].content, 'old-prefix-extended-v2 + tail');

  // 对尚未进注册表的 sess-b 按 running=true 对账 -> 自动挂载后台流
  h.dispatcher.reconcileActiveTurnFromResume('sess-b', {
    running: true,
    inflight: { streaming: true, user: 'b-user', assistant: 'b-ast' },
  });
  assert.equal(h.liveStreamRegistry.hasSession('sess-b'), true);

  // 通过 message.complete 收口 sess-forever，sess-b 在后台保持运行而前景 sess-forever 恢复空闲
  h.dispatcher.handleGatewayEvent({
    type: 'message.complete',
    session_id: 'live-forever-2',
    payload: { text: 'old-prefix-extended-v2 + tail' },
  });
  assert.equal(h.liveStreamRegistry.hasSession('sess-forever'), false);
  assert.equal(h.liveStreamRegistry.hasSession('sess-b'), true);
  assert.equal(h.state.isStreaming, false);

  // 切到无流会话 sess-a 并清理后台 sess-b
  h.state.activeSessionId = 'sess-a';
  h.dispatcher.syncFocusedStreamingProjection('sess-a');
  assert.equal(h.counters().activeStreamingContext.activeStreamingStoredSessionId, null);
  h.dispatcher.handleGatewayEvent({ type: 'message.complete', session_id: 'live-b', payload: { text: 'b-ast' } });

  // 4. observer 自动挂载：session.resume 返回空 inflightUser -> 降级 fetchSessionMessages 补插 user 气泡并绑定 rowId
  h.state.messages.length = 0;
  h.dispatcher.handleGatewayEvent({
    type: 'message.start',
    session_id: 'live-a',
    payload: { turn_id: 'obs-t1' },
  });
  await flushMicrotasks();
  assert.equal(fetchedCalls.length, 1);
  assert.equal(h.state.messages.some((m) => m.role === 'user' && m.content === 'restored-from-fetch' && m.rowId === 501), true);

  // session.resume 抛错保护与行 rowId 绑定分支（已存在无 rowId user 行时从 fetch 绑定 rowId）
  h.dispatcher.handleGatewayEvent({ type: 'message.complete', session_id: 'live-a', payload: { text: 'done-a' } });
  h.state.messages = [{ id: 'u-no-row', role: 'user', content: 'restored-from-fetch' }];
  h.sessionMessagesCache.set('sess-a', h.state.messages);
  h.dispatcher.handleGatewayEvent({ type: 'message.start', session_id: 'live-a', payload: { turn_id: 'obs-t2' } });
  await flushMicrotasks();
  assert.equal(h.state.messages[0].rowId, 501, '已存在同名用户行无 rowId 时应绑定远端 rowId');
  h.dispatcher.handleGatewayEvent({ type: 'message.complete', session_id: 'live-a', payload: { text: 'done-a2' } });

  resumeMode = 'throw';
  fetchMessagesMode = 'throw';
  h.dispatcher.handleGatewayEvent({ type: 'message.start', session_id: 'live-a', payload: { turn_id: 'obs-t3' } });
  await flushMicrotasks();
  h.dispatcher.handleGatewayEvent({ type: 'message.complete', session_id: 'live-a', payload: { text: 'done-a3' } });

  // 5. 未经历 message.start 的直接 message.delta 自动触发观察端建流
  h.state.activeSessionId = 'sess-forever';
  h.dispatcher.handleGatewayEvent({
    type: 'message.delta',
    session_id: 'live-forever',
    payload: { turn_id: 'direct-d1', segment: 0, offset: 0, text: 'direct-delta' },
  });
  h.tokenCoalescer.flush();
  assert.equal(h.liveStreamRegistry.hasSession('sess-forever'), true);

  // 6. sessions.changed 广播防抖（有活跃流时跳过、群聊跳过、连续触发防抖）
  const beforeSyncCalls = h.counters().refreshActiveCalls;
  h.dispatcher.handleGatewayEvent({ type: 'sessions.changed', payload: {} });
  await advanceTimers(t, 150);
  assert.equal(h.counters().refreshActiveCalls, beforeSyncCalls, '当前聚焦会话有活跃流时 sessions.changed 不得覆盖刷新');

  // 群聊态忽略 sessions.changed
  h.dispatcher.handleGatewayEvent({
    type: 'message.complete',
    session_id: 'live-forever',
    payload: { text: 'direct-delta' },
  });
  h.state.activeFocus = { type: 'group', roomId: 'room-1' };
  h.dispatcher.handleGatewayEvent({ type: 'sessions.changed', payload: {} });
  await advanceTimers(t, 150);
  assert.equal(h.counters().refreshActiveCalls, beforeSyncCalls, '群聊聚焦态必须忽略 sessions.changed');

  // 恢复普通空闲会话，连续两次 sessions.changed 只触发一次防抖刷新
  h.state.activeFocus = { type: 'session', sessionId: 'sess-a' };
  h.state.activeSessionId = 'sess-a';
  h.dispatcher.handleGatewayEvent({ type: 'sessions.changed', payload: {} });
  await advanceTimers(t, 100);
  assert.equal(h.counters().refreshActiveCalls, beforeSyncCalls, '100ms 时防抖尚未到期不得提前触发');
  h.dispatcher.handleGatewayEvent({ type: 'sessions.changed', payload: {} });
  await advanceTimers(t, 149);
  assert.equal(h.counters().refreshActiveCalls, beforeSyncCalls, '连续两次 sessions.changed 重置防抖后 149ms 不得触发');
  await advanceTimers(t, 1);
  assert.equal(h.counters().refreshActiveCalls, beforeSyncCalls + 1);
  } finally {
    h?.dispatcher.disconnect();
    t.mock.timers.reset();
  }
});


test('Stage4 回归: 过时 activeStreamingStoredSessionId 下后台完成/失败不污染空闲单聊或群聊，静默期续期刷新活跃时间', () => {
  const h = createMultiSessionHarness({
    state: {
      activeSessionId: 'sess-a',
      activeLiveSessionId: 'live-a',
      isStreaming: false,
      dockNotice: '',
      presenceTerminal: undefined,
    },
  });

  // 1. reconcileActiveTurnFromResume 在 silent 工具阶段 (assistant 为空) 也须刷新 lastActivityAt，防止最老流饥饿
  h.liveStreamRegistry.registerStream({
    storedSessionId: 'sess-a',
    liveSessionId: 'live-a',
    messageId: 'ast-silent',
    origin: 'remote',
    nowMs: 1000,
  });
  h.dispatcher.reconcileActiveTurnFromResume('sess-a', {
    running: true,
    inflight: { streaming: true, user: 'u', assistant: '' },
  });
  assert.ok(
    (h.liveStreamRegistry.getBySession('sess-a')?.lastActivityAt ?? 0) > 1000,
    '静默在途阶段对账必须刷新 lastActivityAt 避免饥饿',
  );
  h.dispatcher.handleGatewayEvent({ type: 'message.complete', session_id: 'live-a', payload: { text: 'ok' } });

  // 2. 前景在空闲 sess-a（或群聊），ctx 遗留过时指针指向后台 sess-b 时，sess-b 失败/完成不得泄露到前景
  h.liveStreamRegistry.registerStream({
    storedSessionId: 'sess-b',
    liveSessionId: 'live-b',
    messageId: 'ast-b-stale',
    origin: 'remote',
    nowMs: 2000,
  });
  h.runningSessions.add('sess-b');
  h.sessionMessagesCache.set('sess-b', [{ id: 'ast-b-stale', role: 'assistant', content: '' }]);
  h.dispatcher.resumeReconnectStreaming('sess-b', 'live-b');
  // 切到空前景并模拟残留过时 ctx
  h.state.activeFocus = { type: 'group', roomId: 'room-group-9' };
  h.state.activeSessionId = '';
  h.state.activeLiveSessionId = '';
  h.state.isStreaming = false;
  h.state.dockNotice = '';
  h.state.presenceTerminal = undefined;

  const disarmsBefore = h.counters().watchdogDisarmed;
  h.dispatcher.handleGatewayEvent({
    type: 'error',
    session_id: 'live-b',
    payload: { message: 'bg failed while in group' },
  });
  assert.equal(h.liveStreamRegistry.hasSession('sess-b'), false);
  assert.equal(h.state.dockNotice, '', '群聊下后台单聊失败绝不得写入群聊 dockNotice');
  assert.equal(h.state.presenceTerminal, undefined, '群聊下后台单聊失败绝不得写入 presenceTerminal');
  assert.equal(h.counters().activeStreamingContext.activeStreamingStoredSessionId, null);
  assert.equal(h.counters().watchdogDisarmed, disarmsBefore + 1);
  h.dispatcher.disconnect();
});

test('LiveStreamCoordinator 直调与 resolveBotNameForSession: 全路径与防竞态守卫覆盖', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_700_000_000_000 });
  let coord;
  try {
  const cache = new Map([['forever-bot', 'sess-f']]);
  assert.equal(
    resolveBotNameForSession('sess-f', cache, { activeFocus: { type: 'session', sessionId: 's1' }, activeSessionId: 's1' }),
    'forever-bot',
  );
  assert.equal(
    resolveBotNameForSession('sess-b', cache, { activeFocus: { type: 'bot', botName: 'focus-bot' }, activeSessionId: 'sess-b' }),
    'focus-bot',
  );
  assert.equal(
    resolveBotNameForSession('sess-x', cache, { activeFocus: { type: 'session', sessionId: 'sess-x' }, activeSessionId: 'sess-x' }),
    null,
  );

  const { LiveStreamRegistry } = await import('@hermes-flux/core');
  let reg = new LiveStreamRegistry();
  let useRegistry = true;
  let epoch = 1;
  let nearBottom = false;
  let refreshCalls = 0;
  let enableRefresh = true;
  let enableScrollSetter = true;
  let enableNearBottomGetter = true;
  let client = null;
  let resumeFn = async () => ({ running: false });
  let fetchFn = async () => ({ status: 'success', messages: [{ id: 'u1', row_id: 1, role: 'user', content: 'from-rest' }] });

  const sessionMessagesCache = new Map();
  const runningSessions = new Set();
  const runningBots = new Set();
  const state = {
    profileName: '',
    sessions: [],
    activeSessionId: 'sess-1',
    activeLiveSessionId: 'live-raw',
    activeFocus: { type: 'session', sessionId: 'sess-1' },
    messages: [],
    gatewayConnected: true,
    isStreaming: false,
    turnStartedAt: undefined,
  };
  let ctx = { activeStreamingMessageId: null, activeStreamingStoredSessionId: null, activeStreamingLiveId: null, activeStreamingBotName: null };
  let turnSid = null;

  coord = createLiveStreamCoordinator({
    getConnectionEpoch: () => epoch,
    getState: () => state,
    getGatewayClient: () => client,
    getLiveStreamRegistry: () => (useRegistry ? reg : undefined),
    resolveBotNameForSession: () => null,
    getSessionMessagesCache: () => sessionMessagesCache,
    getActiveRunningSessionIds: () => runningSessions,
    getActiveRunningBotNames: () => runningBots,
    setActiveStreamingContext: (p) => { ctx = { ...ctx, ...p }; },
    setTurnStartedSessionId: (id) => { turnSid = id; },
    toStoredSessionId: (id) => (id === 'unmapped' ? null : id || null),
    setMessageContent: (mid, content) => {
      const m = state.messages.find((item) => item.id === mid);
      if (m) m.content = content;
    },
    armTurnWatchdog: () => {},
    disarmTurnWatchdog: () => {},
    clearPresenceTerminal: () => {},
    syncAgentPresence: () => {},
    render: () => {},
    get refreshActiveSession() {
      return enableRefresh ? async () => { refreshCalls += 1; } : undefined;
    },
    get isStreamNearBottom() {
      return enableNearBottomGetter ? () => nearBottom : undefined;
    },
    get setPendingScrollToBottom() {
      return enableScrollSetter ? () => {} : undefined;
    },
    ensureMessageWindow: () => {},
    onForceSyncMessageList: () => {},
  });

  // 1. resolveStoredSessionId / insertRemoteUserPromptIfMissing / syncFocusedStreamingProjection / attachLiveTurnFromResume 无 registry 与边界
  assert.equal(coord.resolveStoredSessionId(''), null);
  assert.equal(coord.resolveStoredSessionId('live-raw'), 'sess-1');
  assert.equal(coord.resolveStoredSessionId('unmapped'), 'unmapped');
  assert.equal(coord.insertRemoteUserPromptIfMissing('sess-uncached', 'm1', '   '), false);

  state.activeSessionId = '';
  coord.syncFocusedStreamingProjection(); // targetSid='' (L261-262)
  state.activeSessionId = 'sess-1';
  coord.syncFocusedStreamingProjection(); // targetSid='sess-1' with no stream

  useRegistry = false;
  coord.syncFocusedStreamingProjection();
  assert.equal(coord.attachLiveTurnFromResume({ storedSessionId: 'sess-1', liveSessionId: 'live-1', resumeResult: { running: true } }), false);
  assert.equal(coord.ensureRemoteObserverStream('sess-1', 'live-1'), undefined);
  useRegistry = true;

  // 2. scheduleActiveSessionIdleSync: 无 refreshActiveSession 与 epoch 变化中断
  enableRefresh = false;
  coord.scheduleActiveSessionIdleSync(5);
  enableRefresh = true;
  coord.scheduleActiveSessionIdleSync(15);
  epoch += 1;
  await advanceTimers(t, 15);
  assert.equal(refreshCalls, 0);

  // 3. ensureRemoteObserverStream: 既有流补齐 userText + turnId + 已存在流早退 + nearBottom 3 态 (true/false/undefined)
  const s1 = coord.ensureRemoteObserverStream('sess-1', '', { turnId: 't1' });
  assert.ok(s1);
  // 再次调用已有 turnId 时跳过 !existing.turnId (L564 false)
  state.messages = [{ id: s1.messageId, role: 'assistant', content: '' }];
  coord.ensureRemoteObserverStream('sess-1', 'live-updated', { turnId: 't2', userText: 'late prompt' });
  assert.equal(state.messages.some((m) => m.role === 'user' && m.content === 'late prompt'), true);
  // 后台已有流补齐不触发聚焦同步 (L552 false)
  coord.ensureRemoteObserverStream('sess-bg', 'live-bg', {});
  sessionMessagesCache.set('sess-bg', [{ id: reg.getBySession('sess-bg').messageId, role: 'assistant', content: '' }]);
  coord.ensureRemoteObserverStream('sess-bg', 'live-bg-2', { userText: 'bg prompt' });
  assert.equal(sessionMessagesCache.get('sess-bg').some((m) => m.content === 'bg prompt'), true);

  reg.clear();
  state.messages = [];
  nearBottom = true;
  coord.ensureRemoteObserverStream('sess-1', 'live-1', { userText: 'near-bottom-true' });
  reg.clear();
  state.messages = [];
  client = { call: (m, p) => resumeFn(m, p), fetchSessionMessages: (s, o) => fetchFn(s, o) };

  // 4. hydrateRemoteTurnUserMessage 并发防重入 (L327) + non-Error 字符串抛错 (L307/315) + fetchSessionMessages 期间流变化 (L356)
  let gateResume;
  resumeFn = () => new Promise((r) => { gateResume = r; });
  state.messages = [];
  coord.ensureRemoteObserverStream('sess-race', 'live-race');
  reg.removeSession('sess-race');
  // hydratingRemoteSessions 仍持有 'sess-race' -> 二次触发命中 L327 并发防重入早退
  coord.ensureRemoteObserverStream('sess-race', 'live-race-2');
  epoch += 1;
  gateResume({ running: true, inflight: { streaming: true, user: 'stale-user', assistant: '' } });
  await flushMicrotasks();
  assert.equal(state.messages.some((m) => m.content === 'stale-user'), false);

  // b) string non-Error 抛错分支 (L307, L315): 1st 'Extra inputs' 字符串 -> 2nd 'hard-string' 字符串
  reg.clear();
  state.messages = [];
  resumeFn = async (_m, p) => {
    if ('omit_messages' in p) throw 'Extra inputs string';
    throw 'hard non-error string';
  };
  coord.ensureRemoteObserverStream('sess-1', 'live-1');
  await flushMicrotasks();

  // c) 1st 非 Extra inputs 字符串抛错 (L308)
  reg.clear();
  resumeFn = async () => { throw 'direct non-extra string'; };
  coord.ensureRemoteObserverStream('sess-1', 'live-1');
  await flushMicrotasks();

  // d) 3rd fallback + fetchSessionMessages 在途时流被替换 (L356 !stillStream || messageId mismatch) + 空/非user行 (L363/370)
  reg.clear();
  state.messages = [];
  let releaseFetch;
  let fetchEntered = false;
  resumeFn = async (_m, p) => {
    if ('omit_messages' in p || 'profile' in p) throw new Error('Extra inputs');
    return { running: true, inflight: { streaming: true } };
  };
  fetchFn = () => {
    fetchEntered = true;
    return new Promise((r) => { releaseFetch = r; });
  };
  coord.ensureRemoteObserverStream('sess-1', 'live-1');
  await flushMicrotasks();
  assert.equal(fetchEntered, true);
  reg.removeSession('sess-1');
  releaseFetch({ status: 'success', messages: [{ id: 'u1', row_id: 1, role: 'user', content: 'late-rest' }] });
  await flushMicrotasks();

  // e) fetchSessionMessages 返回含空/非user/已存在 user 与新插入 user (L366 false/true)
  reg.clear();
  state.messages = [{ id: 'u-pre', rowId: 1, role: 'user', content: 'from-rest' }];
  fetchFn = async () => ({
    status: 'success',
    messages: [
      { id: 'u-pre', row_id: 1, role: 'user', content: 'from-rest' },
      { id: 'a-tail', row_id: 2, role: 'assistant', content: 'ans' },
    ],
  });
  resumeFn = async () => ({ running: true, inflight: { streaming: true } });
  coord.ensureRemoteObserverStream('sess-1', 'live-1');
  await flushMicrotasks();

  // f) fetchSessionMessages 插入缺失远程 user prompt (L366 mutated = true || mutated)
  reg.clear();
  state.messages = [];
  fetchFn = async () => ({
    status: 'success',
    messages: [
      { id: 'u-new', row_id: 1, role: 'user', content: 'remote-fresh-prompt' },
      { id: 'a-new', row_id: 2, role: 'assistant', content: 'ans' },
    ],
  });
  coord.ensureRemoteObserverStream('sess-1', 'live-1');
  await flushMicrotasks();
  assert.equal(state.messages.some((m) => m.role === 'user' && m.content === 'remote-fresh-prompt'), true);

  // g) callSessionResume 返回期间 curStream 被删 / messageId 被替换 (L338)，以及 fetch 期间 client 实例切换 (L350)
  reg.clear();
  state.messages = [];
  let releaseResumeSwap;
  resumeFn = () => new Promise((r) => { releaseResumeSwap = r; });
  coord.ensureRemoteObserverStream('sess-swap', 'live-swap');
  reg.removeSession('sess-swap');
  reg.registerStream({ storedSessionId: 'sess-swap', liveSessionId: 'live-swap', messageId: 'other-ast', origin: 'remote' });
  releaseResumeSwap({ running: true, inflight: { streaming: true, user: 'MUST-NOT-LEAK', assistant: 'NO-LEAK-A' } });
  await flushMicrotasks();
  assert.equal(state.messages.some((m) => m.content === 'MUST-NOT-LEAK'), false);
  assert.equal(reg.getBySession('sess-swap').accumulatedText, '');

  reg.clear();
  let releaseResumeDel;
  resumeFn = () => new Promise((r) => { releaseResumeDel = r; });
  coord.ensureRemoteObserverStream('sess-del', 'live-del');
  reg.removeSession('sess-del');
  releaseResumeDel({ running: true, inflight: { streaming: true, user: 'DEL-LEAK', assistant: 'DEL-A' } });
  await flushMicrotasks();

  reg.clear();
  state.messages = [];
  let releaseFetchClientSwap;
  let fetchClientEntered = false;
  resumeFn = async () => ({ running: true, inflight: { streaming: true } });
  fetchFn = () => {
    fetchClientEntered = true;
    return new Promise((r) => { releaseFetchClientSwap = r; });
  };
  coord.ensureRemoteObserverStream('sess-client', 'live-client');
  await flushMicrotasks();
  assert.equal(fetchClientEntered, true);
  const savedClient = client;
  client = null;
  releaseFetchClientSwap({ status: 'success', messages: [{ id: 'u-late', row_id: 1, role: 'user', content: 'CLIENT-SWAP-LEAK' }] });
  await flushMicrotasks();
  client = savedClient;
  assert.equal(state.messages.some((m) => m.content === 'CLIENT-SWAP-LEAK'), false);

  // h) ensureRemoteObserverStream existing 流无 startInfo (L560 undefined) 与 existing.turnId === null 时补齐 turnId (L560 true)
  reg.clear();
  state.messages = [];
  coord.ensureRemoteObserverStream('sess-bg2', 'live-bg2');
  coord.ensureRemoteObserverStream('sess-bg2', 'live-bg2b');
  assert.equal(reg.getBySession('sess-bg2')?.turnId ?? null, null);
  coord.ensureRemoteObserverStream('sess-bg2', 'live-bg2c', { turnId: 'turn-late' });
  assert.equal(reg.getBySession('sess-bg2')?.turnId, 'turn-late');

  // 5. attachLiveTurnFromResume & reconcileActiveTurnFromResume live_id / session_id / sessionId / empty / isStreamNearBottom / 缺失 setter 分支
  reg.clear();
  state.messages = [];
  state.activeSessionId = 'sess-attach';
  nearBottom = false;
  coord.reconcileActiveTurnFromResume('sess-attach', { running: true, live_id: 'l-id', inflight: { streaming: true, assistant: 'a' } });
  // 已存在流状态下覆盖 explicitLiveId 的 session_id / live_id / sessionId / '' 全分支 (L523-530)
  coord.reconcileActiveTurnFromResume('sess-attach', { running: true, session_id: 'sid-explicit', inflight: { streaming: true, assistant: 'a1' } });
  assert.equal(reg.getBySession('sess-attach')?.liveSessionId, 'sid-explicit');
  coord.reconcileActiveTurnFromResume('sess-attach', { running: true, live_id: 'lid-explicit', inflight: { streaming: true, assistant: 'a2' } });
  assert.equal(reg.getBySession('sess-attach')?.liveSessionId, 'lid-explicit');
  coord.reconcileActiveTurnFromResume('sess-attach', { running: true, sessionId: 's-id', inflight: { streaming: true, assistant: 'ab' } });
  coord.reconcileActiveTurnFromResume('sess-attach', { running: true, sessionId: '', inflight: { streaming: true, assistant: '' } });
  coord.reconcileActiveTurnFromResume('sess-attach', { running: true, sessionId: 123, inflight: { streaming: true, assistant: '' } });
  assert.equal(reg.getBySession('sess-attach')?.liveSessionId, 's-id');
  // 新流进入 attachLiveTurnFromResume 且 nearBottom=true + 缺失 setPendingScrollToBottom (L501 ?.) 与缺失 isStreamNearBottom (L500 ??)
  state.activeSessionId = 'sess-no-scroll';
  nearBottom = true;
  enableScrollSetter = false;
  coord.reconcileActiveTurnFromResume('sess-no-scroll', { running: true, session_id: 'live-no-scroll', inflight: { streaming: true, assistant: 'ns' } });
  enableScrollSetter = true;
  state.activeSessionId = 'sess-default-bottom';
  enableNearBottomGetter = false;
  coord.reconcileActiveTurnFromResume('sess-default-bottom', { running: true, session_id: 'live-default-bottom', inflight: { streaming: true, assistant: 'db' } });
  enableNearBottomGetter = true;
  coord.reconcileActiveTurnFromResume('', { running: false }); // rawId/handles empty fallback
  } finally {
    coord?.clearActiveSessionSyncTimer();
    coord?.clearHydrationState();
    t.mock.timers.reset();
  }
});
