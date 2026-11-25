/**
 * 多端协同与并发流协调器 (LiveStreamCoordinator + GatewayEventDispatcher) 全场景单测
 * (packages/desktop/__tests__/unit/liveStreamCoordinator.test.mjs)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveStreamRegistry, TokenCoalescer } from '@hermes-flux/core';
import { createGatewayEventDispatcher, createLiveStreamCoordinator, resolveBotNameForSession } from '../../dist/renderer/gateway/gatewayEventDispatcher.mjs';
import { createTokenStreamWriter } from '../../dist/renderer/stream/tokenStreamWriter.mjs';

function createMultiSessionHarness(overrides = {}) {
  const rendered = [];
  const liveStreamRegistry = new LiveStreamRegistry();
  const sessionMessagesCache = new Map();
  const runningSessions = new Set();
  const unreadSessions = new Set();
  const runningBots = new Set();
  const unreadBots = new Set();
  const runningGroups = new Set();
  const unreadGroups = new Set();

  let activeStreamingContext = {
    activeStreamingMessageId: null,
    activeStreamingStoredSessionId: null,
    activeStreamingLiveId: null,
    activeStreamingBotName: null,
  };
  let turnStartedSessionId = null;
  let watchdogArmed = 0;
  let watchdogFed = 0;
  let watchdogDisarmed = 0;
  let syncPresenceCalls = 0;
  let forceSyncCalls = 0;
  let refreshActiveCalls = 0;

  const state = {
    gatewayUrl: 'http://127.0.0.1:8080',
    username: 'u',
    password: 'p',
    profileName: 'default',
    profiles: [{ name: 'default', displayName: 'Default' }, { name: 'arch-bot', displayName: 'Arch' }],
    sessions: [
      { id: 'sess-a', title: 'Session A', botName: 'default', preview: '', timestamp: 1000 },
      { id: 'sess-b', title: 'Session B', botName: 'arch-bot', preview: '', timestamp: 900 },
    ],
    archivedSessions: [],
    activeSessionId: 'sess-a',
    activeLiveSessionId: 'live-a',
    activeFocus: { type: 'session', sessionId: 'sess-a' },
    messages: [],
    sideAgentCapsules: [],
    gatewayConnected: true,
    gatewayConnecting: false,
    connectionPhase: 'connected',
    connectionReconnectAttempt: 0,
    connectionAuthError: false,
    connectionReason: '',
    manualDisconnected: false,
    isStreaming: false,
    turnStartedAt: undefined,
    dockNotice: '',
    presenceTerminal: undefined,
    ...(overrides.state || {}),
  };

  sessionMessagesCache.set('sess-a', state.messages);
  sessionMessagesCache.set('sess-b', overrides.sessBMessages || []);

  const tokenWriter = createTokenStreamWriter({
    getState: () => state,
    sessionMessagesCache,
    botActivityStore: { updateLatestActivity: () => {} },
    getActiveStreamingStoredSessionId: () => activeStreamingContext.activeStreamingStoredSessionId,
    resolveSessionIdForMessage: (mid) => liveStreamRegistry.getSessionIdForMessage(mid),
    resolveBotNameForSession: (sid) => (sid === 'sess-forever' ? 'arch-bot' : null),
    isStreamNearBottom: () => false,
    markProgrammaticScroll: () => {},
  });
  const tokenCoalescer = new TokenCoalescer((map) => tokenWriter.writeFlushedTokens(map));

  const gatewayClient = overrides.gatewayClient ?? {
    call: async () => ({}),
    fetchSessionMessages: async () => ({ status: 'success', messages: [] }),
    disconnect: () => {},
  };

  const deps = {
    getState: () => state,
    getGatewayClient: () => gatewayClient,
    setGatewayClient: () => {},
    getCurrentTicket: () => 't-1',
    setCurrentTicket: () => {},
    getDesktopApi: () => undefined,
    getEffectiveUrl: (u) => u || '',
    testConnection: async () => ({ ok: true, latency: 5, ticket: 't-1', message: 'ok' }),
    completeEntityTurn: (_domain, running, unread, entityId, focused) => {
      running.delete(entityId);
      if (!focused) unread.add(entityId);
    },
    getSessionHandleRegistry: () => ({
      getLiveIds: (ids) => ids.map((id) => `live-${id.replace(/^sess-/, '')}`),
      toLiveId: (id) => `live-${id.replace(/^sess-/, '')}`,
      toStoredId: (id) => (id.startsWith('live-') ? `sess-${id.slice(5)}` : id),
      register: () => {},
      clear: () => {},
    }),
    getLiveStreamRegistry: () => liveStreamRegistry,
    resolveBotNameForSession: (sid) => (sid === 'sess-forever' ? 'arch-bot' : null),
    getSessionMessagesCache: () => sessionMessagesCache,
    getTokenCoalescer: () => tokenCoalescer,
    getActivityTransitionTracker: () => ({ clear: () => {}, clearAll: () => {} }),
    getBotActivityStore: () => ({ updateLatestActivity: () => {} }),
    getCacheService: () => ({ truncate: async () => {} }),
    getActiveRunningSessionIds: () => runningSessions,
    getUnreadSessionIds: () => unreadSessions,
    getActiveRunningBotNames: () => runningBots,
    getUnreadBotNames: () => unreadBots,
    getActiveRunningGroupRoomIds: () => runningGroups,
    getUnreadGroupRoomIds: () => unreadGroups,
    getActiveStreamingContext: () => activeStreamingContext,
    setActiveStreamingContext: (ctx) => {
      activeStreamingContext = { ...activeStreamingContext, ...ctx };
    },
    getTurnStartedSessionId: () => turnStartedSessionId,
    setTurnStartedSessionId: (id) => { turnStartedSessionId = id; },
    stopProfileAutoRefresh: () => {},
    startProfileAutoRefresh: () => {},
    stopAllGroupPollers: () => {},
    clearTransitionRefreshTimer: () => {},
    clearSessionsRefreshTimer: () => {},
    scheduleSessionsRefresh: () => {},
    persistTurnToCache: () => {},
    persistSessionsToCache: () => {},
    syncProfileLastMessages: () => {},
    syncAgentPresence: () => { syncPresenceCalls += 1; },
    scheduleToolPatch: () => {},
    stopRunningToolTimers: () => {},
    setMessageContent: (mid, text) => {
      const m = state.messages.find((item) => item.id === mid);
      if (m) m.content = text;
    },
    toStoredSessionId: (id) => (id ? (id.startsWith('live-') ? `sess-${id.slice(5)}` : id) : null),
    applyColdStartFocus: async () => {},
    fetchProfiles: async () => {},
    fetchSessions: async () => {},
    fetchGroupRooms: async () => {},
    fetchModelOptions: async () => {},
    fetchProjects: async () => {},
    prefetchSlashCatalog: async () => {},
    armTurnWatchdog: () => { watchdogArmed += 1; },
    feedTurnWatchdog: () => { watchdogFed += 1; },
    disarmTurnWatchdog: () => { watchdogDisarmed += 1; },
    clearPresenceTerminal: () => {},
    armPresenceTerminal: () => {},
    setTimedDockNotice: (msg) => { state.dockNotice = msg; },
    refreshActiveSession: async () => { refreshActiveCalls += 1; },
    onForceSyncMessageList: () => { forceSyncCalls += 1; },
    ensureMessageWindow: () => {},
    setMessageWindowUserExpanded: () => {},
    render: () => { rendered.push(Date.now()); },
    t: (k) => k,
  };

  const dispatcher = createGatewayEventDispatcher(deps);
  return {
    dispatcher,
    state,
    liveStreamRegistry,
    sessionMessagesCache,
    runningSessions,
    unreadSessions,
    tokenCoalescer,
    counters: () => ({
      rendered: rendered.length,
      watchdogArmed,
      watchdogFed,
      watchdogDisarmed,
      syncPresenceCalls,
      forceSyncCalls,
      refreshActiveCalls,
      turnStartedSessionId,
      activeStreamingContext: { ...activeStreamingContext },
    }),
  };
}

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

  await new Promise((r) => setTimeout(r, 15));
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

test('退出重进恢复（attachLiveTurnFromResume）、session.reclaimed 与空闲 sessions.changed 同步', async () => {
  const h = createMultiSessionHarness({
    state: {
      activeSessionId: 'sess-a',
      messages: [{ id: 'hist-1', role: 'user', rowId: 1, content: '已落盘提问' }],
    },
  });

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
  await new Promise((r) => setTimeout(r, 180));
  assert.equal(h.counters().refreshActiveCalls, 2);

  h.dispatcher.disconnect();
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


test('LiveStreamCoordinator 全分支覆盖: ForeverChat / reconcile(append|attach) / fetch降级补气泡 / 广播防抖与跳过', async () => {
  let resumeMode = 'empty-user';
  let fetchMessagesMode = 'normal';
  const fetchedCalls = [];
  const h = createMultiSessionHarness({
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
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(fetchedCalls.length, 1);
  assert.equal(h.state.messages.some((m) => m.role === 'user' && m.content === 'restored-from-fetch' && m.rowId === 501), true);

  // session.resume 抛错保护与行 rowId 绑定分支（已存在无 rowId user 行时从 fetch 绑定 rowId）
  h.dispatcher.handleGatewayEvent({ type: 'message.complete', session_id: 'live-a', payload: { text: 'done-a' } });
  h.state.messages = [{ id: 'u-no-row', role: 'user', content: 'restored-from-fetch' }];
  h.sessionMessagesCache.set('sess-a', h.state.messages);
  h.dispatcher.handleGatewayEvent({ type: 'message.start', session_id: 'live-a', payload: { turn_id: 'obs-t2' } });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(h.state.messages[0].rowId, 501, '已存在同名用户行无 rowId 时应绑定远端 rowId');
  h.dispatcher.handleGatewayEvent({ type: 'message.complete', session_id: 'live-a', payload: { text: 'done-a2' } });

  resumeMode = 'throw';
  fetchMessagesMode = 'throw';
  h.dispatcher.handleGatewayEvent({ type: 'message.start', session_id: 'live-a', payload: { turn_id: 'obs-t3' } });
  await new Promise((r) => setTimeout(r, 20));
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
  await new Promise((r) => setTimeout(r, 170));
  assert.equal(h.counters().refreshActiveCalls, beforeSyncCalls, '当前聚焦会话有活跃流时 sessions.changed 不得覆盖刷新');

  // 群聊态忽略 sessions.changed
  h.dispatcher.handleGatewayEvent({
    type: 'message.complete',
    session_id: 'live-forever',
    payload: { text: 'direct-delta' },
  });
  h.state.activeFocus = { type: 'group', roomId: 'room-1' };
  h.dispatcher.handleGatewayEvent({ type: 'sessions.changed', payload: {} });
  await new Promise((r) => setTimeout(r, 170));
  assert.equal(h.counters().refreshActiveCalls, beforeSyncCalls, '群聊聚焦态必须忽略 sessions.changed');

  // 恢复普通空闲会话，连续两次 sessions.changed 只触发一次防抖刷新
  h.state.activeFocus = { type: 'session', sessionId: 'sess-a' };
  h.state.activeSessionId = 'sess-a';
  h.dispatcher.handleGatewayEvent({ type: 'sessions.changed', payload: {} });
  h.dispatcher.handleGatewayEvent({ type: 'sessions.changed', payload: {} });
  await new Promise((r) => setTimeout(r, 180));
  assert.equal(h.counters().refreshActiveCalls, beforeSyncCalls + 1);

  h.dispatcher.disconnect();
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

test('LiveStreamCoordinator 直调与 resolveBotNameForSession: 全路径与防竞态守卫覆盖', async () => {
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

  const coord = createLiveStreamCoordinator({
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
  await new Promise((r) => setTimeout(r, 30));
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
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(state.messages.some((m) => m.content === 'stale-user'), false);

  // b) string non-Error 抛错分支 (L307, L315): 1st 'Extra inputs' 字符串 -> 2nd 'hard-string' 字符串
  reg.clear();
  state.messages = [];
  resumeFn = async (_m, p) => {
    if ('omit_messages' in p) throw 'Extra inputs string';
    throw 'hard non-error string';
  };
  coord.ensureRemoteObserverStream('sess-1', 'live-1');
  await new Promise((r) => setTimeout(r, 25));

  // c) 1st 非 Extra inputs 字符串抛错 (L308)
  reg.clear();
  resumeFn = async () => { throw 'direct non-extra string'; };
  coord.ensureRemoteObserverStream('sess-1', 'live-1');
  await new Promise((r) => setTimeout(r, 25));

  // d) 3rd fallback + fetchSessionMessages 在途时流被替换 (L356 !stillStream || messageId mismatch) + 空/非user行 (L363/370)
  reg.clear();
  state.messages = [];
  let releaseFetch;
  resumeFn = async (_m, p) => {
    if ('omit_messages' in p || 'profile' in p) throw new Error('Extra inputs');
    return { running: true, inflight: { streaming: true } };
  };
  fetchFn = () => new Promise((r) => { releaseFetch = r; });
  coord.ensureRemoteObserverStream('sess-1', 'live-1');
  await new Promise((r) => setTimeout(r, 20));
  reg.removeSession('sess-1');
  releaseFetch({ status: 'success', messages: [{ id: 'u1', row_id: 1, role: 'user', content: 'late-rest' }] });
  await new Promise((r) => setTimeout(r, 20));

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
  await new Promise((r) => setTimeout(r, 25));

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
  await new Promise((r) => setTimeout(r, 25));
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
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(state.messages.some((m) => m.content === 'MUST-NOT-LEAK'), false);
  assert.equal(reg.getBySession('sess-swap').accumulatedText, '');

  reg.clear();
  let releaseResumeDel;
  resumeFn = () => new Promise((r) => { releaseResumeDel = r; });
  coord.ensureRemoteObserverStream('sess-del', 'live-del');
  reg.removeSession('sess-del');
  releaseResumeDel({ running: true, inflight: { streaming: true, user: 'DEL-LEAK', assistant: 'DEL-A' } });
  await new Promise((r) => setTimeout(r, 15));

  reg.clear();
  state.messages = [];
  let releaseFetchClientSwap;
  resumeFn = async () => ({ running: true, inflight: { streaming: true } });
  fetchFn = () => new Promise((r) => { releaseFetchClientSwap = r; });
  coord.ensureRemoteObserverStream('sess-client', 'live-client');
  await new Promise((r) => setTimeout(r, 15));
  const savedClient = client;
  client = null;
  releaseFetchClientSwap({ status: 'success', messages: [{ id: 'u-late', row_id: 1, role: 'user', content: 'CLIENT-SWAP-LEAK' }] });
  await new Promise((r) => setTimeout(r, 15));
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
  coord.clearActiveSessionSyncTimer();
  coord.clearHydrationState();
});

test('LiveStreamCoordinator 变异消杀全边界：resolveBot/resolveId/idleSync/userInsert/existingAttach/canReuseTail/observer', async () => {
  // 1. resolveBotNameForSession 在 focus.type==='bot' 但 activeSessionId !== storedSessionId 时绝不误归属 (L99)
  assert.equal(
    resolveBotNameForSession('sess-other', new Map(), {
      activeFocus: { type: 'bot', botName: 'focus-bot' },
      activeSessionId: 'sess-mine',
    }),
    null,
  );

  let client = {
    call: async (_m, p) => {
      if ('profile' in p && p.profile === 'extra-test') throw new Error('Extra inputs');
      return { running: true, inflight: { streaming: true, assistant: 'remote-ans' } };
    },
    fetchSessionMessages: async () => ({ status: 'success', messages: [] }),
  };
  let epoch = 1;
  let nearBottom = false;
  const calls = {
    refresh: [],
    dropQueued: [],
    setMsgContent: [],
    setTurnSid: [],
    ctxs: [],
    clearTerminal: 0,
    armWatchdog: 0,
    disarmWatchdog: 0,
    setUserExpanded: [],
    ensureWindow: [],
    setScrollBottom: [],
    forceSync: [],
    renders: 0,
    syncPresence: 0,
  };
  const sessionMessagesCache = new Map();
  const runningSessions = new Set();
  const runningBots = new Set();
  const reg = new LiveStreamRegistry();
  const state = {
    profileName: 'prof-def',
    sessions: [{ id: 'sess-p', title: 'P', botName: 'sess-bot', preview: '', timestamp: 0 }],
    activeSessionId: 'sess-1',
    activeLiveSessionId: 'live-raw',
    activeFocus: { type: 'session', sessionId: 'sess-1' },
    messages: [],
    gatewayConnected: true,
    isStreaming: false,
    turnStartedAt: undefined,
  };

  const coord = createLiveStreamCoordinator({
    getConnectionEpoch: () => epoch,
    getState: () => state,
    getGatewayClient: () => client,
    getLiveStreamRegistry: () => reg,
    resolveBotNameForSession: (sid) => (sid === 'sess-late-bot' ? 'resolved-bot' : null),
    getSessionMessagesCache: () => sessionMessagesCache,
    getActiveRunningSessionIds: () => runningSessions,
    getActiveRunningBotNames: () => runningBots,
    setActiveStreamingContext: (p) => calls.ctxs.push(p),
    setTurnStartedSessionId: (id) => calls.setTurnSid.push(id),
    toStoredSessionId: (id) => (id === 'alias-live' ? 'sess-alias' : null),
    setMessageContent: (mid, text) => calls.setMsgContent.push([mid, text]),
    dropQueuedTokens: (mid) => calls.dropQueued.push(mid),
    armTurnWatchdog: () => { calls.armWatchdog += 1; },
    disarmTurnWatchdog: () => { calls.disarmWatchdog += 1; },
    clearPresenceTerminal: () => { calls.clearTerminal += 1; },
    syncAgentPresence: () => { calls.syncPresence += 1; },
    render: () => { calls.renders += 1; },
    refreshActiveSession: async (opts) => { calls.refresh.push(opts); },
    isStreamNearBottom: () => nearBottom,
    setPendingScrollToBottom: (v) => calls.setScrollBottom.push(v),
    setMessageWindowUserExpanded: (v) => calls.setUserExpanded.push(v),
    ensureMessageWindow: (n) => calls.ensureWindow.push(n),
    onForceSyncMessageList: (v) => calls.forceSync.push(v),
  });

  // 2. resolveStoredSessionId 四层解析顺序精确校验 (L123-139)
  reg.registerStream({ storedSessionId: 'sess-alias', liveSessionId: 'live-direct', messageId: 'm-al', origin: 'local' });
  assert.equal(coord.resolveStoredSessionId('sess-alias'), 'sess-alias');
  assert.equal(coord.resolveStoredSessionId('live-direct'), 'sess-alias');
  assert.equal(coord.resolveStoredSessionId('alias-live'), 'sess-alias');
  assert.equal(coord.resolveStoredSessionId('live-raw'), 'sess-1');
  assert.equal(coord.resolveStoredSessionId('totally-unknown'), 'totally-unknown');

  // 3. scheduleActiveSessionIdleSync 前置/后置守卫、{ checkLiveTurn: true } 实参与 clearActiveSessionSyncTimer 取消 (L110-112, L162-172)
  reg.clear();
  state.gatewayConnected = false;
  coord.scheduleActiveSessionIdleSync(5);
  state.gatewayConnected = true;
  state.activeFocus = { type: 'group', roomId: 'g1' };
  coord.scheduleActiveSessionIdleSync(5);
  state.activeFocus = { type: 'session', sessionId: 'sess-1' };
  state.isStreaming = true;
  coord.scheduleActiveSessionIdleSync(5);
  state.isStreaming = false;
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(calls.refresh.length, 0);

  // 定时器回调内部守卫（启动后变成 isStreaming 或 gatewayConnected=false）
  coord.scheduleActiveSessionIdleSync(10);
  state.isStreaming = true;
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls.refresh.length, 0);
  state.isStreaming = false;

  // clearActiveSessionSyncTimer 取消待触发定时
  coord.scheduleActiveSessionIdleSync(20);
  coord.clearActiveSessionSyncTimer();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(calls.refresh.length, 0);

  // 正常触发必须传 { checkLiveTurn: true }
  coord.scheduleActiveSessionIdleSync(5);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(calls.refresh, [{ checkLiveTurn: true }]);

  // 4. insertRemoteUserPromptIfMissing bindRowId 更新、非 bind 已存在、有效 rowId vs 无效 rowId 与递增 bubbleId (L211-232)
  reg.clear();
  reg.registerStream({ storedSessionId: 'sess-1', liveSessionId: 'l1', messageId: 'ast-u', origin: 'remote' });
  state.messages = [
    { id: 'u-match', role: 'user', content: 'same-u' },
    { id: 'ast-u', role: 'assistant', content: '' },
  ];
  assert.equal(coord.insertRemoteUserPromptIfMissing('sess-1', 'ast-u', 'same-u', 77), true);
  assert.equal(state.messages[0].rowId, 77);
  assert.equal(sessionMessagesCache.get('sess-1')[0].rowId, 77);
  assert.equal(reg.getBySession('sess-1').userMessageSynced, true);
  assert.equal(coord.insertRemoteUserPromptIfMissing('sess-1', 'ast-u', 'same-u'), false);

  state.messages = [{ id: 'ast-u', role: 'assistant', content: '' }];
  assert.equal(coord.insertRemoteUserPromptIfMissing('sess-1', 'ast-u', 'new-with-row', 88), true);
  assert.equal(state.messages[0].rowId, 88);
  assert.equal(coord.insertRemoteUserPromptIfMissing('sess-1', 'ast-u', 'new-bad-row', -5), true);
  const badRowBubble = state.messages.find((m) => m.content === 'new-bad-row');
  assert.equal('rowId' in badRowBubble, false);

  // 5. syncFocusedStreamingProjection 非空后台流不 disarmTurnWatchdog vs 空表 disarmTurnWatchdog (L259-290)
  reg.clear();
  reg.registerStream({ storedSessionId: 'sess-bg-active', liveSessionId: 'lb', messageId: 'mb', origin: 'remote' });
  const disBefore = calls.disarmWatchdog;
  coord.syncFocusedStreamingProjection('sess-1');
  assert.equal(state.isStreaming, false);
  assert.equal(calls.disarmWatchdog, disBefore, '后台仍有活跃流时不得撤防看门狗');
  reg.clear();
  coord.syncFocusedStreamingProjection('sess-1');
  assert.equal(calls.disarmWatchdog, disBefore + 1);

  // 6. attachLiveTurnFromResume 当 stream 已存在时 (L406-440 -> 消除 L410/L418/L419 NoCoverage!)
  // 6a) state.messages 已有 ast-exist 时补齐 late user 与 late assistant (L410-411)
  reg.clear();
  state.activeSessionId = 'sess-late-bot';
  state.messages = [{ id: 'ast-exist', role: 'assistant', content: '' }];
  sessionMessagesCache.delete('sess-late-bot');
  reg.registerStream({ storedSessionId: 'sess-late-bot', liveSessionId: 'old-l', messageId: 'ast-exist', origin: 'remote', initialContent: '' });
  const winBefore = calls.ensureWindow.length;
  const syncBefore = calls.forceSync.length;
  const renBefore = calls.renders;
  const presBefore = calls.syncPresence;
  assert.equal(
    coord.attachLiveTurnFromResume({
      storedSessionId: 'sess-late-bot',
      liveSessionId: 'new-l',
      resumeResult: { running: true, inflight: { streaming: true, user: 'u-late', assistant: 'a-late' } },
    }),
    true,
  );
  assert.equal(reg.getBySession('sess-late-bot').botName, 'resolved-bot');
  assert.equal(reg.getBySession('sess-late-bot').liveSessionId, 'new-l');
  assert.equal(reg.getBySession('sess-late-bot').userMessageSynced, true);
  assert.equal(runningSessions.has('sess-late-bot'), true);
  assert.equal(runningBots.has('resolved-bot'), true);
  assert.equal(state.messages.some((m) => m.role === 'user' && m.content === 'u-late'), true);
  assert.equal(state.messages.some((m) => m.id === 'ast-exist' && m.content === 'a-late'), true);
  assert.equal(calls.ensureWindow.length, winBefore + 1);
  assert.equal(calls.forceSync.length, syncBefore + 1);
  assert.equal(calls.renders, renBefore + 1);
  assert.equal(calls.syncPresence, presBefore + 1);

  // 6b) state.messages 缺失已注册气泡时 ensureAssistantMessagePresent 返回 true 触发 changed=true (L418-419)
  state.messages = [];
  sessionMessagesCache.delete('sess-late-bot');
  const renBeforeMiss = calls.renders;
  coord.attachLiveTurnFromResume({
    storedSessionId: 'sess-late-bot',
    liveSessionId: 'new-l',
    resumeResult: { running: true, inflight: { streaming: true, user: 'u-late', assistant: 'a-late' } },
  });
  assert.equal(state.messages.some((m) => m.id === 'ast-exist'), true);
  assert.equal(calls.renders, renBeforeMiss + 1);

  // unfocused existing stream 不触发前景 render/syncPresence (L430)
  const presBg = calls.syncPresence;
  const renBg = calls.renders;
  reg.registerStream({ storedSessionId: 'sess-unfocused-ex', liveSessionId: 'l-u', messageId: 'm-u', origin: 'remote' });
  sessionMessagesCache.set('sess-unfocused-ex', [{ id: 'm-u', role: 'assistant', content: 'old' }]);
  coord.attachLiveTurnFromResume({
    storedSessionId: 'sess-unfocused-ex',
    liveSessionId: 'l-u2',
    resumeResult: { running: true, inflight: { streaming: true, assistant: 'old+more' } },
  });
  assert.equal(calls.renders, renBg);
  assert.equal(calls.syncPresence, presBg);
  assert.equal(sessionMessagesCache.get('sess-unfocused-ex')[0].content, 'old+more');
  assert.equal(calls.dropQueued.includes('m-u'), true);

  // 7. attachLiveTurnFromResume 新流: running=false 返回 false (L399)、canReuseTail 真假分支与 empty inflightAssistant (L442-505)
  assert.equal(coord.attachLiveTurnFromResume({ storedSessionId: 'x', liveSessionId: 'lx', resumeResult: { running: false } }), false);
  reg.clear();
  state.activeSessionId = 'sess-reuse';
  state.messages = [{ id: 'tail-a', role: 'assistant', content: 'prefix' }];
  calls.dropQueued.length = 0;
  nearBottom = false;
  calls.setScrollBottom.length = 0;
  calls.setUserExpanded.length = 0;
  coord.attachLiveTurnFromResume({
    storedSessionId: 'sess-reuse',
    liveSessionId: 'l-reuse',
    resumeResult: { running: true, inflight: { streaming: true, user: 'u-r', assistant: 'prefix+more' } },
  });
  assert.equal(reg.getBySession('sess-reuse').messageId, 'tail-a');
  assert.equal(calls.dropQueued.includes('tail-a'), true);
  assert.equal(state.messages.some((m) => m.id === 'tail-a' && m.content === 'prefix+more'), true);
  assert.deepEqual(calls.setUserExpanded.slice(-1), [false]);
  assert.deepEqual(calls.setScrollBottom, [], 'nearBottom=false 时不得置起 setPendingScrollToBottom(true)');

  // 新流不可复用（tail 有 rowId）+ empty inflightAssistant (L462 '') + nearBottom=true + unfocused
  reg.clear();
  state.activeSessionId = 'sess-new-empty';
  state.messages = [{ id: 'tail-durable', role: 'assistant', rowId: 5, content: 'done' }];
  nearBottom = true;
  coord.attachLiveTurnFromResume({
    storedSessionId: 'sess-new-empty',
    liveSessionId: 'l-ne',
    resumeResult: { running: true, inflight: { streaming: true, assistant: '' } },
  });
  const spawnedMsg = state.messages.find((m) => m.id !== 'tail-durable');
  assert.equal(spawnedMsg?.role, 'assistant');
  assert.equal(spawnedMsg?.content, '');
  assert.equal(reg.getBySession('sess-new-empty').userMessageSynced, false);
  assert.deepEqual(calls.setScrollBottom, [true]);

  // 8. reconcileActiveTurnFromResume existing unfocused + running=false (L533-546) + ensureRemoteObserverStream unfocused/startInfo.userText (L560-618)
  const syncRecBefore = calls.forceSync.length;
  coord.reconcileActiveTurnFromResume('sess-unfocused-rec', { running: true, inflight: { streaming: true, assistant: 'init' } });
  coord.reconcileActiveTurnFromResume('sess-unfocused-rec', { running: true, session_id: 'sid-u', inflight: { streaming: true, assistant: 'init+next' } });
  assert.equal(calls.forceSync.length, syncRecBefore, 'unfocused reconcile 不得强制刷前台列表');
  assert.equal(sessionMessagesCache.get('sess-unfocused-rec').some((m) => m.content === 'init+next'), true);

  // existing focused stream 在 !isRunning 下不 crash 且保留 synced projection (L533, L543)
  state.activeSessionId = 'sess-new-empty';
  coord.reconcileActiveTurnFromResume('sess-new-empty', { running: false });

  // ensureRemoteObserverStream existing 聚焦流收到 late userText 必须同步列表并 render (L562-565)
  const fSyncEnsBefore = calls.forceSync.length;
  const renEnsBefore = calls.renders;
  coord.ensureRemoteObserverStream('sess-new-empty', 'l-ne2', { userText: 'late-observer-u' });
  assert.equal(calls.forceSync.length, fSyncEnsBefore + 1);
  assert.equal(calls.renders, renEnsBefore + 1);

  // ensureRemoteObserverStream 新聚焦流 nearBottom=false 时不得调用 setPendingScrollToBottom(true) (L609)
  reg.clear();
  state.activeSessionId = 'sess-obs-nb';
  state.messages = [];
  nearBottom = false;
  calls.setScrollBottom.length = 0;
  coord.ensureRemoteObserverStream('sess-obs-nb', 'live-obs-nb', { userText: 'prefilled-u', turnId: 't-obs' });
  assert.deepEqual(calls.setScrollBottom, []);
  assert.equal(reg.getBySession('sess-obs-nb').userMessageSynced, true);

  // 9. hydrateRemoteTurnUserMessage profile 从 state.sessions -> state.profileName -> 'default' 回退 + focused post-hydration sync (L333, L377-382)
  const sentProfiles = [];
  client = {
    call: async (_m, p) => {
      sentProfiles.push(p.profile);
      return { running: true, inflight: { streaming: true, user: 'u-hydrated', assistant: 'a-hydrated' } };
    },
    fetchSessionMessages: async () => ({ status: 'success', messages: [] }),
  };
  reg.clear();
  state.activeSessionId = 'sess-p';
  state.messages = [];
  const fHydBefore = calls.forceSync.length;
  coord.ensureRemoteObserverStream('sess-p', 'live-p');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(sentProfiles.at(-1), 'sess-bot');
  assert.ok(calls.forceSync.length > fHydBefore);
  assert.equal(state.messages.some((m) => m.role === 'user' && m.content === 'u-hydrated'), true);
  assert.equal(state.messages.some((m) => m.role === 'assistant' && m.content === 'a-hydrated'), true);

  // 10. 补充精确定向消杀（Hydration L116-384）
  // 10a) clearHydrationState 确实清空 hydratingRemoteSessions
  let pendResume;
  let resumeInvokeCount = 0;
  client = {
    call: async () => {
      resumeInvokeCount += 1;
      return new Promise((r) => { pendResume = r; });
    },
    fetchSessionMessages: async () => ({ status: 'success', messages: [] }),
  };
  reg.clear();
  coord.ensureRemoteObserverStream('sess-clr', 'live-clr');
  reg.removeSession('sess-clr');
  coord.ensureRemoteObserverStream('sess-clr', 'live-clr2'); // 被 hydratingRemoteSessions 去重阻塞
  assert.equal(resumeInvokeCount, 1);
  coord.clearHydrationState();
  reg.removeSession('sess-clr');
  coord.ensureRemoteObserverStream('sess-clr', 'live-clr3'); // 清空后允许重新触发
  assert.equal(resumeInvokeCount, 2);
  pendResume?.({ running: false });
  await new Promise((r) => setTimeout(r, 15));

  // 10b) resolveStoredSessionId hasSession vs liveSessionId vs mapped+hasSession vs uncached [] fallback (L123-147)
  reg.clear();
  sessionMessagesCache.delete('sess-uncached-brandnew');
  coord.ensureRemoteObserverStream('sess-uncached-brandnew', 'live-brandnew', { userText: 'hi' });
  assert.equal(sessionMessagesCache.get('sess-uncached-brandnew')[0].role, 'user');
  assert.equal(sessionMessagesCache.get('sess-uncached-brandnew')[1].role, 'assistant');

  // 使用专属轻量 coordinator 精确锁定 L124/L132/L170/L184/L222/L244-279/L304-382
  let lightConnected = true;
  let lightSessId = 'sess-l';
  let lightLiveId = 'live-l';
  let lightEpoch = 1;
  let lightRefresh = [];
  let lightSetMsg = [];
  let lightCtxs = [];
  let lightTurnSids = [];
  let lightClearTerm = 0;
  let lightArm = 0;
  let lightRenders = 0;
  let lightForceSync = 0;
  let lightUserWin = 0;
  let lightPresence = 0;
  let lightClient = null;
  const lightReg = new LiveStreamRegistry();
  const lightCache = new Map();
  const lightState = {
    profileName: 'def-p',
    sessions: [],
    get activeSessionId() { return lightSessId; },
    get activeLiveSessionId() { return lightLiveId; },
    set activeLiveSessionId(v) { lightLiveId = v; },
    activeFocus: { type: 'session', sessionId: 'sess-l' },
    messages: [{ id: 'u0', role: 'user', content: 'hi' }],
    get gatewayConnected() { return lightConnected; },
    isStreaming: false,
    turnStartedAt: undefined,
  };
  const lightCoord = createLiveStreamCoordinator({
    getConnectionEpoch: () => lightEpoch,
    getState: () => lightState,
    getGatewayClient: () => lightClient,
    getLiveStreamRegistry: () => lightReg,
    getSessionMessagesCache: () => lightCache,
    getActiveRunningSessionIds: () => new Set(),
    getActiveRunningBotNames: () => new Set(),
    setActiveStreamingContext: (p) => lightCtxs.push(p),
    setTurnStartedSessionId: (id) => lightTurnSids.push(id),
    toStoredSessionId: (id) => (id === 'sess-reg' ? 'WRONG-MAP' : id === 'map-to-reg' ? 'sess-reg' : null),
    setMessageContent: (m, t) => lightSetMsg.push([m, t]),
    armTurnWatchdog: () => { lightArm += 1; },
    disarmTurnWatchdog: () => {},
    clearPresenceTerminal: () => { lightClearTerm += 1; },
    syncAgentPresence: () => { lightPresence += 1; },
    render: () => { lightRenders += 1; },
    refreshActiveSession: async (o) => { lightRefresh.push(o); },
    ensureMessageWindow: () => { lightUserWin += 1; },
    onForceSyncMessageList: () => { lightForceSync += 1; },
  });

  // L124 & L132 精确区分
  lightReg.registerStream({ storedSessionId: 'sess-reg', liveSessionId: 'live-reg', messageId: 'm-reg', origin: 'local' });
  assert.equal(lightCoord.resolveStoredSessionId('sess-reg'), 'sess-reg');
  lightSessId = 'sess-wrong-fallback';
  lightLiveId = 'map-to-reg';
  assert.equal(lightCoord.resolveStoredSessionId('map-to-reg'), 'sess-reg');

  // L170 定时器回调内 !gatewayConnected 与 !activeSessionId 检查
  lightConnected = true;
  lightSessId = 'sess-l';
  lightCoord.scheduleActiveSessionIdleSync(5);
  lightConnected = false;
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(lightRefresh.length, 0);
  lightConnected = true;
  lightCoord.scheduleActiveSessionIdleSync(5);
  lightSessId = '';
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(lightRefresh.length, 0);
  lightSessId = 'sess-l';

  // L184 去重 & L264-279 syncFocusedStreamingProjection 全字段断言
  lightReg.registerStream({ storedSessionId: 'sess-l', liveSessionId: 'live-l', messageId: 'm-l', botName: 'b-l', origin: 'local', startedAt: 555 });
  lightCoord.syncFocusedStreamingProjection('sess-l');
  assert.equal(lightState.messages.some((m) => m.id === 'm-l' && m.role === 'assistant'), true);
  assert.equal(lightClearTerm, 1);
  assert.equal(lightArm, 1);
  assert.equal(lightTurnSids.at(-1), 'sess-l');
  assert.deepEqual(lightCtxs.at(-1), {
    activeStreamingMessageId: 'm-l',
    activeStreamingStoredSessionId: 'sess-l',
    activeStreamingLiveId: 'live-l',
    activeStreamingBotName: 'b-l',
  });
  const countBeforeDupAst = lightState.messages.length;
  lightCoord.syncFocusedStreamingProjection('sess-l');
  assert.equal(lightState.messages.length, countBeforeDupAst);

  // L222 userRowId=0 / 1.5 不写入 rowId
  lightCoord.insertRemoteUserPromptIfMissing('sess-l', 'm-l', 'row-zero-u', 0);
  lightCoord.insertRemoteUserPromptIfMissing('sess-l', 'm-l', 'row-float-u', 1.5);
  assert.equal('rowId' in lightState.messages.find((m) => m.content === 'row-zero-u'), false);
  assert.equal('rowId' in lightState.messages.find((m) => m.content === 'row-float-u'), false);

  // L264-279 idle reset ctx 断言
  lightReg.removeSession('sess-l');
  lightCoord.syncFocusedStreamingProjection('sess-l');
  assert.equal(lightTurnSids.at(-1), null);
  assert.deepEqual(lightCtxs.at(-1), {
    activeStreamingMessageId: null,
    activeStreamingStoredSessionId: null,
    activeStreamingLiveId: null,
    activeStreamingBotName: null,
  });

  // L302-313 三级降级与 2nd 非 Extra 失败 + L335/L350/L353/L359/L377-381
  const lightCalls = [];
  const fetchOptsSeen = [];
  let resumeImpl = async (_m, p) => {
    lightCalls.push(p);
    if ('omit_messages' in p || 'profile' in p) throw new Error('Extra inputs are not permitted');
    return { running: true, inflight: { streaming: true, user: 'u-3rd', assistant: 'a-3rd' } };
  };
  let fetchImpl = async (_sid, opts) => {
    fetchOptsSeen.push(opts);
    return { status: 'success', messages: [] };
  };
  lightClient = {
    call: (m, p) => resumeImpl(m, p),
    fetchSessionMessages: (sid, opts) => fetchImpl(sid, opts),
  };
  lightState.messages = [];
  lightCache.clear();
  const winHydBefore = lightUserWin;
  const fsHydBefore = lightForceSync;
  const renHydBefore = lightRenders;
  const presHydBefore = lightPresence;
  lightCoord.ensureRemoteObserverStream('sess-l', 'live-l');
  await new Promise((r) => setTimeout(r, 25));
  assert.deepEqual(lightCalls, [
    { session_id: 'sess-l', profile: 'def-p', omit_messages: true },
    { session_id: 'sess-l', profile: 'def-p' },
    { session_id: 'sess-l' },
  ]);
  assert.equal(lightSetMsg.some(([mid, text]) => mid && text === 'a-3rd'), true);
  assert.equal(lightUserWin, winHydBefore + 2);
  assert.equal(lightForceSync, fsHydBefore + 2);
  assert.equal(lightRenders, renHydBefore + 2);
  assert.equal(lightPresence, presHydBefore + 2);

  // unfocused hydrateRemoteTurnUserMessage 返回 mutated=true 时写入后台缓存，但绝不触发前景 UI 刷新 (L377)
  const renBgSuccess = lightRenders;
  const fsBgSuccess = lightForceSync;
  const presBgSuccess = lightPresence;
  resumeImpl = async () => ({ running: true, inflight: { streaming: true, user: 'u-bg', assistant: 'a-bg' } });
  lightCoord.ensureRemoteObserverStream('sess-bg-hyd-ok', 'live-bg-hyd-ok');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(lightCache.get('sess-bg-hyd-ok').some((m) => m.content === 'u-bg'), true);
  assert.equal(lightCache.get('sess-bg-hyd-ok').some((m) => m.content === 'a-bg'), true);
  assert.equal(lightRenders, renBgSuccess);
  assert.equal(lightForceSync, fsBgSuccess);
  assert.equal(lightPresence, presBgSuccess);

  // 1st 非 Extra 错误仅发 1 次 RPC (L304) + 2nd 非 Extra 仅发 2 次 RPC (L312)
  lightCalls.length = 0;
  resumeImpl = async (_m, p) => {
    lightCalls.push(p);
    throw new Error('401 unauthorized');
  };
  lightCoord.ensureRemoteObserverStream('sess-bg-err1', 'live-bg-err1');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(lightCalls.length, 1);

  lightCalls.length = 0;
  const renUnf = lightRenders;
  const fsUnf = lightForceSync;
  const presUnf = lightPresence;
  resumeImpl = async (_m, p) => {
    lightCalls.push(p);
    if ('omit_messages' in p) throw new Error('Extra inputs are not permitted');
    throw new Error('503 unavailable');
  };
  lightCoord.ensureRemoteObserverStream('sess-bg-hyd', 'live-bg-hyd');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(lightCalls.length, 2);
  assert.equal(lightRenders, renUnf);
  assert.equal(lightForceSync, fsUnf);
  assert.equal(lightPresence, presUnf);

  // L335 (epoch changed while curStream alive) & L344 (!curStream.userMessageSynced) & L345-347 (fetchOpts) & L350/L352
  let relEpochResume;
  lightReg.clear();
  resumeImpl = () => new Promise((r) => { relEpochResume = r; });
  lightState.messages = [];
  lightCoord.ensureRemoteObserverStream('sess-l', 'live-l');
  lightEpoch += 1;
  relEpochResume({ running: true, inflight: { streaming: true, user: 'stale-ep-u', assistant: 'stale-ep-a' } });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(lightState.messages.some((m) => m.content === 'stale-ep-u'), false);

  // userMessageSynced 在 resume 期间被置为 true -> 不得发起冗余 fetchSessionMessages (L344)
  let relMarkSyncResume;
  fetchOptsSeen.length = 0;
  lightReg.clear();
  resumeImpl = () => new Promise((r) => { relMarkSyncResume = r; });
  lightCoord.ensureRemoteObserverStream('sess-l', 'live-l');
  lightReg.markUserSynced('sess-l');
  relMarkSyncResume({ running: true, inflight: { streaming: true } });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(fetchOptsSeen.length, 0);

  let relEpochFetch;
  lightReg.clear();
  resumeImpl = async () => ({ running: true, inflight: { streaming: true } });
  fetchImpl = (_sid, opts) => {
    fetchOptsSeen.push(opts);
    return new Promise((r) => { relEpochFetch = r; });
  };
  lightState.messages = [];
  lightCoord.ensureRemoteObserverStream('sess-l', 'live-l');
  await new Promise((r) => setTimeout(r, 15));
  assert.deepEqual(fetchOptsSeen.at(-1), { limit: 10, order: 'latest', profile: 'def-p' });
  lightEpoch += 1;
  relEpochFetch({ status: 'success', messages: [{ id: 'u-st-f', row_id: 1, role: 'user', content: 'stale-f-u' }] });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(lightState.messages.some((m) => m.content === 'stale-f-u'), false);

  // L352 fetch 在途时 stillStream messageId 被替换 -> 不得注入旧 user prompt
  let relSwapFetch;
  lightReg.clear();
  resumeImpl = async () => ({ running: true, inflight: { streaming: true } });
  fetchImpl = () => new Promise((r) => { relSwapFetch = r; });
  lightState.messages = [];
  lightCoord.ensureRemoteObserverStream('sess-l', 'live-l');
  await new Promise((r) => setTimeout(r, 15));
  lightReg.registerStream({ storedSessionId: 'sess-l', liveSessionId: 'live-l', messageId: 'replaced-ast', origin: 'remote' });
  relSwapFetch({ status: 'success', messages: [{ id: 'u-sw-f', row_id: 1, role: 'user', content: 'swap-f-u' }] });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(lightState.messages.some((m) => m.content === 'swap-f-u'), false);

  // L353 outcome.status !== 'success' & L359 whitespace user content 忽略
  lightReg.clear();
  lightState.messages = [];
  fetchImpl = async () => ({ status: 'error', messages: [{ id: 'ue', row_id: 1, role: 'user', content: 'err-skip' }] });
  lightCoord.ensureRemoteObserverStream('sess-l', 'live-l');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(lightState.messages.some((m) => m.content === 'err-skip'), false);

  lightReg.clear();
  lightState.messages = [];
  fetchImpl = async () => ({ status: 'success', messages: [{ id: 'uw', row_id: 1, role: 'user', content: '   ' }] });
  lightCoord.ensureRemoteObserverStream('sess-l', 'live-l');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(lightState.messages.some((m) => m.role === 'user'), false);

  // 11. 补充精确定向消杀（Attach & Observer L402-617）
  nearBottom = false;
  client = null; // 避免 section 11 测试 observer 时意外触发 async hydration 干扰计数

  // 11a) attachLiveTurnFromResume existing: 空 liveSessionId 不覆盖、已有 botName 不被覆盖、已 synced user 不重复插、无变更不触发 ensureWindow/forceSync 但同步 isStreaming (L407-438)
  reg.clear();
  runningSessions.clear();
  runningBots.clear();
  state.activeSessionId = 'sess-ex-noop';
  state.isStreaming = false;
  state.messages = [{ id: 'ast-ex-n', role: 'assistant', content: 'done-txt' }];
  reg.registerStream({
    storedSessionId: 'sess-ex-noop',
    liveSessionId: 'keep-live-id',
    messageId: 'ast-ex-n',
    botName: 'orig-bot',
    origin: 'local', // userMessageSynced=true
    initialContent: 'done-txt',
  });
  const wNoop = calls.ensureWindow.length;
  const fsNoop = calls.forceSync.length;
  const renNoop = calls.renders;
  coord.attachLiveTurnFromResume({
    storedSessionId: 'sess-ex-noop',
    liveSessionId: '',
    botName: 'other-bot',
    resumeResult: { running: true, inflight: { streaming: true, user: 'ignored-dup-u', assistant: 'done-txt' } },
  });
  assert.equal(reg.getBySession('sess-ex-noop').liveSessionId, 'keep-live-id');
  assert.equal(reg.getBySession('sess-ex-noop').botName, 'orig-bot');
  assert.equal(state.messages.some((m) => m.content === 'ignored-dup-u'), false);
  assert.equal(state.isStreaming, true, 'existing focused attach 无内容变更时也必须同步焦点流式态 (L431)');
  assert.equal(calls.ensureWindow.length, wNoop);
  assert.equal(calls.forceSync.length, fsNoop);
  assert.equal(calls.renders, renNoop);

  // 11b) attachLiveTurnFromResume existing 仅 inflightAssistant 推进（L425 -> changed=true）
  coord.attachLiveTurnFromResume({
    storedSessionId: 'sess-ex-noop',
    liveSessionId: 'keep-live-id',
    resumeResult: { running: true, inflight: { streaming: true, assistant: 'done-txt+more' } },
  });
  assert.equal(calls.ensureWindow.length, wNoop + 1);
  assert.equal(calls.forceSync.length, fsNoop + 1);
  assert.equal(calls.renders, renNoop + 1);

  // 11c) attachLiveTurnFromResume 新流: tail.role='user' 不得误复用 (L447)、tail 比 inflight 更长保留 tail (L455)、空 liveId 回落 storedSessionId (L480) 与 unfocused 不刷 UI (L495)
  reg.clear();
  state.activeSessionId = 'sess-user-tail';
  state.messages = [{ id: 'u-tail', role: 'user', content: 'prefix' }];
  calls.forceSync.length = 0;
  const presAttachBefore = calls.syncPresence;
  const renAttachBefore = calls.renders;
  nearBottom = true;
  calls.setScrollBottom.length = 0;
  coord.attachLiveTurnFromResume({
    storedSessionId: 'sess-user-tail',
    liveSessionId: '',
    resumeResult: { running: true, inflight: { streaming: true, assistant: 'prefix+ai' } },
  });
  assert.notEqual(reg.getBySession('sess-user-tail').messageId, 'u-tail');
  assert.equal(reg.getBySession('sess-user-tail').liveSessionId, 'sess-user-tail');
  assert.deepEqual(calls.forceSync, [true]);
  assert.equal(calls.renders, renAttachBefore + 1);
  assert.equal(calls.syncPresence, presAttachBefore + 1);
  assert.deepEqual(calls.setScrollBottom, [true]);

  state.activeSessionId = 'sess-longer-tail';
  state.messages = [{ id: 'ast-long', role: 'assistant', content: 'already-longer-content' }];
  coord.attachLiveTurnFromResume({
    storedSessionId: 'sess-longer-tail',
    liveSessionId: 'l-long',
    resumeResult: { running: true, inflight: { streaming: true, assistant: 'already' } },
  });
  assert.equal(state.messages[0].id, 'ast-long');
  assert.equal(state.messages[0].content, 'already-longer-content');

  // unfocused 新流 attach 不调用前景 hooks (L495)
  const renUnfAt = calls.renders;
  const fsUnfAt = calls.forceSync.length;
  coord.attachLiveTurnFromResume({
    storedSessionId: 'sess-bg-at',
    liveSessionId: 'l-bg-at',
    resumeResult: { running: true, inflight: { streaming: true, user: 'u-bg-at', assistant: 'a-bg-at' } },
  });
  assert.equal(calls.renders, renUnfAt);
  assert.equal(calls.forceSync.length, fsUnfAt);

  // 11d) reconcileActiveTurnFromResume explicitLiveId 非字符串回退 (L523/L525)、running=false 不 touchActivity 但仍同步焦点 (L533/L543)
  reg.clear();
  state.activeSessionId = 'sess-rec-types';
  reg.registerStream({ storedSessionId: 'sess-rec-types', liveSessionId: 'init-l', messageId: 'm-rt', origin: 'local', nowMs: 100 });
  coord.reconcileActiveTurnFromResume('sess-rec-types', { running: true, session_id: 123, live_id: 'lid-ok', inflight: { streaming: true } });
  assert.equal(reg.getBySession('sess-rec-types').liveSessionId, 'lid-ok');
  coord.reconcileActiveTurnFromResume('sess-rec-types', { running: true, live_id: 456, sessionId: 'sid-ok', inflight: { streaming: true } });
  assert.equal(reg.getBySession('sess-rec-types').liveSessionId, 'sid-ok');

  // running=false 在 focused existing 上不刷新 lastActivityAt，但同步投影与 presence；unfocused 不同步 presence (L533, L537, L543)
  reg.getBySession('sess-rec-types').lastActivityAt = 100;
  state.isStreaming = false;
  const presRec = calls.syncPresence;
  const fsRec = calls.forceSync.length;
  const renRec = calls.renders;
  coord.reconcileActiveTurnFromResume('sess-rec-types', { running: false });
  assert.equal(reg.getBySession('sess-rec-types').lastActivityAt, 100);
  assert.equal(state.isStreaming, true);
  assert.equal(calls.syncPresence, presRec + 1);
  coord.reconcileActiveTurnFromResume('sess-rec-types', { running: true, inflight: { streaming: true, assistant: 'rec-delta' } });
  assert.equal(calls.forceSync.length, fsRec + 1);
  assert.equal(calls.renders, renRec + 1);

  reg.registerStream({ storedSessionId: 'sess-rec-unf', liveSessionId: 'l-ru', messageId: 'm-ru', origin: 'remote' });
  const presRecUnf = calls.syncPresence;
  coord.reconcileActiveTurnFromResume('sess-rec-unf', { running: false });
  assert.equal(calls.syncPresence, presRecUnf);

  // attach from reconcile when missing -> resolveBotNameForSession -> botName (L518)
  coord.reconcileActiveTurnFromResume('sess-late-bot', { running: true, session_id: 'l-lb', inflight: { streaming: true } });
  assert.equal(reg.getBySession('sess-late-bot').botName, 'resolved-bot');

  // 11e) ensureRemoteObserverStream: empty liveId 保底、unfocused existing 不刷前台、unfocused new 与 focused new 全参数校验 (L558-615)
  reg.clear();
  runningSessions.clear();
  runningBots.clear();
  state.activeSessionId = 'sess-obs-focus';
  state.messages = [];
  sessionMessagesCache.clear();

  // unfocused new bot stream
  const renObs = calls.renders;
  const fsObs = calls.forceSync.length;
  coord.ensureRemoteObserverStream('sess-late-bot', '', {});
  assert.equal(reg.getBySession('sess-late-bot').liveSessionId, 'sess-late-bot');
  assert.equal(runningSessions.has('sess-late-bot'), true);
  assert.equal(runningBots.has('resolved-bot'), true);
  assert.equal(sessionMessagesCache.get('sess-late-bot')?.[0]?.role, 'assistant');
  assert.equal(sessionMessagesCache.get('sess-late-bot')?.[0]?.content, '');
  assert.equal(calls.renders, renObs);
  assert.equal(calls.forceSync.length, fsObs);

  // unfocused existing with liveId='' & late userText 不刷前台 UI (L558, L562)
  coord.ensureRemoteObserverStream('sess-late-bot', '', { userText: 'u-unf-late' });
  assert.equal(reg.getBySession('sess-late-bot').liveSessionId, 'sess-late-bot');
  assert.equal(reg.getBySession('sess-late-bot').userMessageSynced, true);
  assert.equal(calls.renders, renObs);
  // already userMessageSynced 时再次传 userText 不重复插入 (L560)
  const bgLenBefore = sessionMessagesCache.get('sess-late-bot').length;
  coord.ensureRemoteObserverStream('sess-late-bot', 'new-bg-live', { userText: 'dup-ignored' });
  assert.equal(sessionMessagesCache.get('sess-late-bot').length, bgLenBefore);

  // focused new with nearBottom=true: ensureWindow/forceSync/render/setPendingScrollToBottom/setUserExpanded/syncPresence 全执行 (L605-614)
  nearBottom = true;
  calls.setScrollBottom.length = 0;
  calls.setUserExpanded.length = 0;
  const wObs = calls.ensureWindow.length;
  const fsObsFocus = calls.forceSync.length;
  const renObsFocus = calls.renders;
  const presObsFocus = calls.syncPresence;
  state.isStreaming = false;
  coord.ensureRemoteObserverStream('sess-obs-focus', 'live-obs-f', { turnId: 't-of', userText: 'u-of' });
  assert.equal(state.isStreaming, true, 'focused observer 必须激活前台投影 (L606)');
  assert.equal(reg.getBySession('sess-obs-focus').liveSessionId, 'live-obs-f');
  assert.equal(reg.getBySession('sess-obs-focus').turnId, 't-of');
  assert.deepEqual(calls.setUserExpanded.slice(-1), [false]);
  assert.equal(calls.ensureWindow.length, wObs + 1);
  assert.deepEqual(calls.setScrollBottom, [true]);
  assert.equal(calls.forceSync.length, fsObsFocus + 1);
  assert.equal(calls.renders, renObsFocus + 1);
  assert.equal(calls.syncPresence, presObsFocus + 1);

  // 11f) 补齐 existing observer 更新 non-empty liveId (L558)、new attach runningSessions/runningBots/already-present userSynced (L486/L489/L490) 与 startInfo.userText 不触发 hydration (L617)
  coord.ensureRemoteObserverStream('sess-obs-focus', 'live-obs-updated');
  assert.equal(reg.getBySession('sess-obs-focus').liveSessionId, 'live-obs-updated');
  coord.ensureRemoteObserverStream('sess-obs-focus', '');
  assert.equal(reg.getBySession('sess-obs-focus').liveSessionId, 'live-obs-updated');

  let hydUnexpected = 0;
  client = {
    call: async () => {
      hydUnexpected += 1;
      return { running: false };
    },
    fetchSessionMessages: async () => ({ status: 'success', messages: [] }),
  };
  coord.ensureRemoteObserverStream('sess-no-hyd', 'live-nh', { userText: 'prefilled-no-hyd' });
  assert.equal(hydUnexpected, 0, '已有 userText 置 userSynced=true 时绝不发起 hydration RPC (L617)');
  client = null;

  reg.clear();
  runningSessions.clear();
  runningBots.clear();
  state.activeSessionId = 'sess-bot-attach';
  state.messages = [
    { id: 'u-dup-attach', role: 'user', content: 'already-u' },
    { id: 'ast-tail-att', role: 'assistant', content: 'pre' },
  ];
  coord.attachLiveTurnFromResume({
    storedSessionId: 'sess-bot-attach',
    liveSessionId: 'l-ba',
    botName: 'att-bot',
    resumeResult: { running: true, inflight: { streaming: true, user: 'already-u', assistant: 'pre' } },
  });
  assert.equal(runningSessions.has('sess-bot-attach'), true);
  assert.equal(runningBots.has('att-bot'), true);
  assert.equal(reg.getBySession('sess-bot-attach').userMessageSynced, true, 'already-present 时 Boolean(inflightUser)||insertedUser 仍应为 true (L486)');
  runningBots.clear();
  coord.attachLiveTurnFromResume({
    storedSessionId: 'sess-nobot-attach',
    liveSessionId: 'l-nba',
    resumeResult: { running: true, inflight: { streaming: true, assistant: '' } },
  });
  assert.equal(runningBots.size, 0, 'resolvedBotName 为空时不得向 runningBots 写入 null (L490)');

  coord.clearActiveSessionSyncTimer();
  coord.clearHydrationState();
  lightCoord.clearActiveSessionSyncTimer();
  lightCoord.clearHydrationState();
});
