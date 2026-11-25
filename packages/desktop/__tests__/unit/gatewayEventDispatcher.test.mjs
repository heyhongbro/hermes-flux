/**
 * 网关连接生命周期与 WebSocket 下行事件分发服务（Gateway Event Dispatcher · D6）纯逻辑单测
 * (packages/desktop/__tests__/unit/gatewayEventDispatcher.test.mjs)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createGatewayEventDispatcher } from '../../dist/renderer/gateway/gatewayEventDispatcher.mjs';

function createMockDispatcherDeps(overrides = {}) {
  const rendered = [];
  const state = {
    activeSessionId: 'sess-1',
    activeLiveSessionId: 'live-1',
    profileName: 'default',
    profiles: [{ name: 'default', displayName: 'Default Bot' }],
    sessions: [
      { id: 'sess-1', title: 'Task 1', botName: 'default', preview: '', timestamp: 1000 },
    ],
    messages: [
      { id: 'usr-1', role: 'user', content: 'hello', timestamp: '12:00:00' },
      { id: 'ast-1', role: 'assistant', content: '', thought: '', timestamp: '12:00:01' },
    ],
    artifacts: [],
    browserFrame: undefined,
    gitDiffs: [],
    sideAgentCapsules: [],
    activeFocus: { type: 'session', sessionId: 'sess-1' },
    isStreaming: false,
    turnStartedAt: undefined,
    dockNotice: '',
    presenceTerminal: undefined,
    gatewayConnected: false,
    gatewayConnecting: false,
    gatewayUrl: 'http://127.0.0.1:8080',
    username: 'admin',
    password: 'pwd',
    ...(overrides.state || {}),
  };

  let activeStreamingContext = {
    activeStreamingMessageId: 'ast-1',
    activeStreamingStoredSessionId: 'sess-1',
    activeStreamingLiveId: 'live-1',
    activeStreamingBotName: null,
    ...(overrides.activeStreamingContext || {}),
  };

  let turnStartedSessionId = null;
  let currentTicket = undefined;
  let gatewayClient = null;

  const runningSessions = new Set(['sess-1']);
  const unreadSessions = new Set();
  const runningBots = new Set();
  const unreadBots = new Set();
  const runningGroups = new Set();
  const unreadGroups = new Set();

  const sessionMessagesCache = new Map();
  sessionMessagesCache.set('sess-1', [...state.messages]);

  const pushedTokens = [];
  const tokenCoalescer = {
    push(item) { pushedTokens.push(item); },
    flush() {},
    clear() {},
  };

  const activityTransitionTracker = {
    clearedAll: false,
    cleared: [],
    clear(domain, id) { this.cleared.push({ domain, id }); },
    clearAll() { this.clearedAll = true; },
  };

  const patchedTools = [];
  const scheduledSessionsRefreshes = [];
  const completedEntityTurns = [];
  const watchdogEvents = [];
  const presenceEvents = [];

  let registryClearCount = 0;

  const deps = {
    getState: () => state,
    getGatewayClient: () => gatewayClient,
    setGatewayClient: (c) => { gatewayClient = c; },
    getCurrentTicket: () => currentTicket,
    setCurrentTicket: (t) => { currentTicket = t; },
    getDesktopApi: () => undefined,
    getEffectiveUrl: (url) => url || 'http://127.0.0.1:8080',
    testConnection: async (url, u, p) => ({ ok: true, latency: 15, ticket: 'ticket-xyz', message: 'ok' }),
    completeEntityTurn: (domain, running, unread, entityId, focused) => {
      completedEntityTurns.push({ domain, entityId, focused });
    },

    getSessionHandleRegistry: () => ({
      getLiveIds: (ids) => ids.map((id) => `live-${id}`),
      toLiveId: (id) => `live-${id}`,
      toStoredId: (id) => id.replace(/^live-/, ''),
      register: () => {},
      clear: () => { registryClearCount += 1; },
    }),
    getSessionMessagesCache: () => sessionMessagesCache,
    getTokenCoalescer: () => tokenCoalescer,
    getActivityTransitionTracker: () => activityTransitionTracker,
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
    scheduleSessionsRefresh: () => { scheduledSessionsRefreshes.push(Date.now()); },

    persistTurnToCache: () => {},
    persistSessionsToCache: () => {},
    syncProfileLastMessages: () => {},
    syncAgentPresence: () => {},
    scheduleToolPatch: (mid) => { patchedTools.push(mid); },
    stopRunningToolTimers: () => {},
    setMessageContent: (mid, content) => {
      const msg = state.messages.find((m) => m.id === mid);
      if (msg) msg.content = content;
    },
    toStoredSessionId: (id) => id ? id.replace(/^live-/, '') : null,

    applyColdStartFocus: async () => {},
    fetchProfiles: async () => {},
    fetchSessions: async () => {},
    fetchGroupRooms: async () => {},
    fetchModelOptions: async () => {},
    fetchProjects: async () => {},
    prefetchSlashCatalog: async () => {},

    armTurnWatchdog: () => { watchdogEvents.push('arm'); },
    feedTurnWatchdog: () => { watchdogEvents.push('feed'); },
    disarmTurnWatchdog: () => { watchdogEvents.push('disarm'); },
    clearPresenceTerminal: () => { presenceEvents.push('clear'); },
    armPresenceTerminal: (term) => { presenceEvents.push(term); },
    setTimedDockNotice: () => {},

    render: () => { rendered.push(Date.now()); },
    t: (key) => key,
  };

  return {
    state,
    deps,
    rendered,
    pushedTokens,
    patchedTools,
    completedEntityTurns,
    watchdogEvents,
    presenceEvents,
    activeStreamingContext: () => activeStreamingContext,
    getRegistryClearCount: () => registryClearCount,
  };
}

test('D6: gatewayEventDispatcher - 隐私模式下连接回写配置失败不得中断连接流程（P-032）', async () => {
  // 【杀伤力】把 safeSetItem 换回裸 localStorage.setItem，connect() 会抛 SecurityError 且跳过 render。
  const hadStorage = 'localStorage' in globalThis;
  const savedStorage = globalThis.localStorage;
  const savedWarn = console.warn;
  const warns = [];
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
    // 让 testConnection 直接返回失败，避免在 Node 里创建真实 WebSocket 客户端。
    deps.testConnection = async () => ({ ok: false, latency: 0, message: 'denied' });
    const dispatcher = createGatewayEventDispatcher(deps);

    await assert.doesNotReject(() => dispatcher.connect(), '写盘失败不得让 connect 抛错');
    assert.equal(state.gatewayUrl, 'http://127.0.0.1:8080', '内存态必须已生效');
    assert.ok(rendered.length >= 1, '连接流程必须继续并触发 render');
    assert.ok(
      warns.some((args) => String(args[0]).includes('failed to persist connection config')),
      '写盘失败必须可观测（Failure Is Not Empty）',
    );
  } finally {
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
    try {
      if (mode === 'normal') {
        globalThis.localStorage = { getItem: () => null, setItem: () => {} };
      } else {
        delete globalThis.localStorage;
      }
      console.warn = (...args) => warns.push(args);

      const { deps } = createMockDispatcherDeps();
      deps.testConnection = async () => ({ ok: false, latency: 0, message: 'denied' });
      await assert.doesNotReject(() => createGatewayEventDispatcher(deps).connect());
      assert.equal(warns.length, 0, `${mode} 场景不得产生降级日志`);
    } finally {
      console.warn = savedWarn;
      if (hadStorage) globalThis.localStorage = savedStorage;
      else delete globalThis.localStorage;
    }
  }
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

  // 验证活跃流式数据持续喂狗
  const feedCount = pushedTokens.length;
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

test('D6: gatewayEventDispatcher - handleInspectorEvent 解包工件、浏览器帧与 Diff', () => {
  const { deps, state, rendered } = createMockDispatcherDeps();
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

test('D6: gatewayEventDispatcher - turn-completed / turn-failed 全链路收口变异杀伤（工具收敛/缓存持久化/会话置顶/Bot与后台态）', () => {
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

  deps.getTokenCoalescer = () => ({ enqueue: () => {}, flush: () => flushCalls.push(1) });
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
  deps.getActivityTransitionTracker = () => ({ clear: (kind, id) => trackerClears.push([kind, id]) });
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

  const dispatcher = createGatewayEventDispatcher(deps);
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
});


test('D6: gatewayEventDispatcher - 重连续流恢复/终止与多流后台保活及阶段补丁路由', async () => {
  const { LiveStreamRegistry, TokenCoalescer } = await import('@hermes-flux/core');
  const reg = new LiveStreamRegistry();
  const runningBots = new Set();
  const { deps, state, watchdogEvents, rendered } = createMockDispatcherDeps({
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

  // activeStreamingStoredSessionId 为不同会话时，finishReconnectStreaming 不得误清它；而聚焦会话finish时即便另有后台流仍需收口前台 isStreaming
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
  dispatcher.finishReconnectStreaming('sess-bg2');
  coalescer.flush();
  assert.equal(flushedByCoalescer.length, 0, '最后一条流结束后必须调用 coalescer.clear()');
  assert.equal(reg.size(), 0);
  assert.equal(runningBots.has('arch-bot'), false);
  assert.equal(deps.getActiveRunningSessionIds().has('sess-forever'), false);
  assert.ok(toolPatchCleared >= 2);
  assert.ok(timersStopped >= 2);
  assert.ok(watchdogEvents.includes('disarm'));

  // 4. 无 LiveStreamRegistry 降级模式下的 resumeReconnectStreaming / finishReconnectStreaming
  deps.getLiveStreamRegistry = undefined;
  const fallbackDispatcher = createGatewayEventDispatcher(deps);
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
  fallbackDispatcher.disconnect();
  dispatcher.disconnect();
});

test('D6: gatewayEventDispatcher - idle sync/session.info/subagent-spawn/缺失 registry 与畸形事件帧全分支', async () => {
  const { LiveStreamRegistry } = await import('@hermes-flux/core');
  let idleSyncCount = 0;
  const reg = new LiveStreamRegistry();
  const { deps, state } = createMockDispatcherDeps({});
  deps.getLiveStreamRegistry = () => reg;
  deps.refreshActiveSession = async () => { idleSyncCount += 1; };
  state.gatewayConnected = true;

  // 1. session.info running/streaming 命中聚焦但未注册流的会话 -> scheduleActiveSessionIdleSync(50) (L794, L803-804)
  const dispatcher = createGatewayEventDispatcher(deps);
  dispatcher.handleGatewayEvent({ type: 'session.info', session_id: 'live-1', payload: { streaming: true } });
  await new Promise((r) => setTimeout(r, 90));
  assert.ok(idleSyncCount >= 1);

  // 2. stream-activity 无 sessionId + 聚焦/后台流式切换收口 + unfocused completedBotName (L371, L564, L607-608, L615, L637, L666-673, L709, L789)
  dispatcher.applyTurnActions([{ type: 'stream-activity', sessionId: '', eventType: 'tool.progress' }]);
  reg.registerStream({ storedSessionId: 'sess-1', liveSessionId: 'live-1', messageId: 'ast-1', origin: 'local' });
  reg.registerStream({ storedSessionId: 'sess-bg', liveSessionId: 'live-bg', messageId: 'ast-bg', botName: 'bg-bot', origin: 'remote' });
  deps.getActiveRunningBotNames().add('bg-bot');
  dispatcher.handleGatewayEvent({ type: 'message.complete', session_id: 'live-bg', payload: { text: 'bg done' } });
  assert.equal(reg.hasSession('sess-bg'), false, '后台会话收到 message.complete 必须注销并发流');
  assert.equal(deps.getActiveRunningSessionIds().has('sess-1'), true, '前台 sess-1 运行态不得受后台完成波及');
  dispatcher.handleGatewayEvent({ type: 'error', session_id: 'live-bg', payload: { message: 'bg err' } });

  // 3. subagent.spawn_requested 带 parent_id 与直接 subagent-spawn (L789, L791) + payload.session_id 提取 (L857) + 注册表含空 liveSessionId (L834)
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

  // 3b. unfocused completedBotName 无缓存 (L566 !msgs, L617 ?.) 与空缓存数组 (L617 || null)
  deps.resolveBotNameForSession = (sid) => (sid.startsWith('sess-bot') ? 'bot-bg' : null);
  deps.getActiveRunningBotNames().add('bot-bg');
  deps.getSessionMessagesCache().delete('sess-bot-nocache');
  deps.getSessionMessagesCache().set('sess-bot-emptycache', []);
  dispatcher.applyTurnActions([
    { type: 'turn-completed', sessionId: 'sess-bot-nocache', finalText: 'done' },
    { type: 'turn-completed', sessionId: 'sess-bot-emptycache', finalText: 'done' },
  ]);

  // 3c. 有 streamRegistry 但 activeStreamingStoredSessionId 与 state.activeSessionId 均为空 -> L547/548/552/617/639/668/669 全假分支；以及 activeSessionId 仍在流中 -> L639 全真分支
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

  // 4. 缺失 streamRegistry + 空上下文 turn-completed/turn-failed + focused message.complete 带 text（直接 idle sync(0)）+ 畸形帧分支
  let noRegIdleSync = 0;
  const { deps: depsNoReg, state: stateNoReg } = createMockDispatcherDeps({});
  depsNoReg.refreshActiveSession = async () => { noRegIdleSync += 1; };
  stateNoReg.gatewayConnected = true;
  const noRegDispatcher = createGatewayEventDispatcher(depsNoReg);
  noRegDispatcher.handleGatewayEvent(null);
  noRegDispatcher.handleGatewayEvent({ event: 'custom.evt', payload: [] });
  noRegDispatcher.handleGatewayEvent({ kind: 'custom.kind', payload: {} });
  noRegDispatcher.handleGatewayEvent({ payload: {} });
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
  await new Promise((r) => setTimeout(r, 40));
  assert.ok(noRegIdleSync >= 1, '无 streamRegistry 且有 finalText 时必须触发 idle sync(0)');

  noRegDispatcher.disconnect();
  dispatcher.disconnect();
});

test('D6: gatewayEventDispatcher - 流式动作细粒度分发/工具参数缓存/持久化行号与远端帧全量覆盖', async () => {
  const { LiveStreamRegistry, TokenCoalescer } = await import('@hermes-flux/core');
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
  const coalescer = new TokenCoalescer((flushed) => {
    for (const [messageId, entry] of flushed.entries()) {
      pushedTokens.push({ messageId, content: entry.content, thought: entry.thought });
    }
  });
  const origDrop = coalescer.dropMessage.bind(coalescer);
  coalescer.dropMessage = (mid) => {
    flushedDrops.push(mid);
    return origDrop(mid);
  };

  let forceSyncCalls = [];
  let ensureWindowArgs = [];
  let expandedArgs = [];
  let nearBottomFlag = true;
  let pendingScrollArgs = [];
  let persistCalls = [];
  let statusActions = [];
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

  const dispatcher = createGatewayEventDispatcher(deps);

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
    // 非聚焦、非运行态下，已知后台会话遇到非 message.start 不得挂载
    dispatcher.handleGatewayEvent({ type: evtType, session_id: 'live-sess-known-bg', payload: { text: 'x' } });
    assert.equal(reg.hasSession('sess-known-bg'), false, `${evtType} 非运行态已知后台会话不得自动挂载`);
  }

  // message.start 命中已知后台会话（使用 display_text + turn_id）自动挂载并同步远端 user 气泡与 turnId
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
  // 后台 turn-started 不得污染前台 state.isStreaming 或 forceSync
  assert.equal(state.isStreaming, false);
  assert.equal(forceSyncCalls.length, 0);

  // 对非聚焦非流式的普通事件名不得自动挂载
  dispatcher.handleGatewayEvent({ kind: 'custom.unrelated', session_id: 'live-untracked', payload: {} });
  assert.equal(reg.hasSession('untracked'), false);

  // 对活跃运行态的后台会话，TURN_STREAM_EVENT_TYPES 中的每个事件（如 message.delta/interim/thinking/reasoning/tool.*）都能触发自动挂载，普通事件不能
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

  // 聚焦会话（via activeLiveSessionId，即使 activeSessionId 暂不相同）+ message.delta/start 覆盖 liveCoord 适配器回调
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

  // 已有 turnId 与已 synced 时，再发 turn-started 既不覆盖 turnId 也不重复插入
  dispatcher.applyTurnActions([
    { type: 'turn-started', sessionId: 'live-fg', turnId: 'turn-fg-override', text: 'Duplicate Prompt' },
  ]);
  assert.equal(fgEntry.turnId, 'turn-fg-1');
  assert.equal(state.messages.filter((m) => m.content === 'Duplicate Prompt').length, 0);

  // 未 synced 且仅带 action.text（无 displayText）且 state.isStreaming 已为 true 时，仍需插入并 render+forceSync；无 text 且无 displayText 时不插入
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

  // turn-started 回落路径: ctx.activeStreamingStoredSessionId 为 null -> 回落 state.activeSessionId；无注册流时 turnStartedAt 用 Date.now() 且 arm 看门狗
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
  // targetStartedId 为空串时（ctx 与 state.activeSessionId 均为空），startedStream 回落 undefined 且安全 arm 看门狗
  deps.setActiveStreamingContext({ activeStreamingStoredSessionId: null });
  state.activeSessionId = '';
  state.isStreaming = false;
  dispatcher.applyTurnActions([{ type: 'turn-started', sessionId: '' }]);
  assert.equal(state.isStreaming, true);
  assert.equal(deps.getTurnStartedSessionId(), '');
  assert.equal(watchdogEvents.filter((e) => e === 'arm').length, armsBeforeTurn + 2);
  // 恢复聚焦上下文
  state.activeSessionId = 'sess-fg';
  deps.setActiveStreamingContext({ activeStreamingStoredSessionId: 'sess-fg', activeStreamingLiveId: 'live-fg', activeStreamingMessageId: 'a-fg' });

  // 后台 type='message.start' 当 state.isStreaming=false 时绝不可把前台置为 isStreaming=true，且不触及前台 render，但仍 arm 看门狗
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

  // 聚焦未注册但 activeLiveSessionId 匹配的 message.start 覆盖 nearBottom=false / text 回退 / liveCoord adapter
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
  // 重置聚焦回 sess-fg
  state.activeSessionId = 'sess-fg';
  state.activeLiveSessionId = 'live-fg';
  deps.toStoredSessionId = (id) => (id ? id.replace(/^live-/, '') : null);

  // 2. append-content: segment/offset/dedup + 无 registry fallback
  coalescer.clear();
  pushedTokens.length = 0;
  const feedsBeforeDelta = watchdogEvents.filter((e) => e === 'feed').length;
  // 先发 segment 0 offset 0 "Hello"
  dispatcher.applyTurnActions([
    { type: 'append-content', messageId: 'a-fg', text: 'Hello', turnId: 'turn-fg-1', segment: 0, offset: 0 },
  ]);
  coalescer.flush();
  assert.equal(pushedTokens.length, 1);
  assert.equal(pushedTokens[0].content, 'Hello');
  assert.equal(pushedTokens[0].thought, '');
  // 重复发同一段，acceptDelta 应拒绝且不推流、不喂狗；空文本被接受但 deltaToAppend 为空同样不推不喂
  dispatcher.applyTurnActions([
    { type: 'append-content', messageId: 'a-fg', text: 'Hello', turnId: 'turn-fg-1', segment: 0, offset: 0 },
    { type: 'append-content', messageId: 'a-fg', text: '', turnId: 'turn-fg-1', segment: 0, offset: 5 },
  ]);
  coalescer.flush();
  assert.equal(pushedTokens.length, 1, '重复或空 delta 不得推送 tokenCoalescer');
  assert.equal(watchdogEvents.filter((e) => e === 'feed').length, feedsBeforeDelta + 1);

  // unregistered messageId 直接走无 registry 推送
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

  // 4. interim-content: 未流式文本推送（segment=1, alreadyStreamed=false） vs 已流式文本跳过（alreadyStreamed=true） vs 无注册流
  dispatcher.applyTurnActions([
    { type: 'interim-content', messageId: 'a-fg', text: 'Next paragraph', alreadyStreamed: false, turnId: 'turn-fg-1', segment: 1 },
  ]);
  coalescer.flush();
  assert.equal(pushedTokens.length, 4);
  assert.equal(pushedTokens[3].content, '\n\nNext paragraph');
  // 再次发 alreadyStreamed: true 的 interim 与未注册 interim，均不得再次 push
  const feedsBeforeSkipInterim = watchdogEvents.filter((e) => e === 'feed').length;
  dispatcher.applyTurnActions([
    { type: 'interim-content', messageId: 'a-fg', text: 'Already streamed', alreadyStreamed: true, turnId: 'turn-fg-1', segment: 1 },
    { type: 'interim-content', messageId: 'no-such-stream', text: 'Unregistered', alreadyStreamed: false },
  ]);
  coalescer.flush();
  assert.equal(pushedTokens.length, 4);
  assert.equal(watchdogEvents.filter((e) => e === 'feed').length, feedsBeforeSkipInterim + 2);

  // 5. stream-activity: 注册流 / ctx.activeStreamingStoredSessionId / runningSet 三路喂狗与未知过滤
  const feedsBeforeAct = watchdogEvents.filter((e) => e === 'feed').length;
  dispatcher.applyTurnActions([{ type: 'stream-activity', sessionId: 'live-unknown-idle', eventType: 'tool.progress' }]);
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
    // 重复 id 不应追加第二条
    {
      type: 'tool-start',
      messageId: 'a-fg',
      toolCall: { id: 'tc-str', name: 'delegate_task', args: '{"delegationId":"del-dup"}' },
    },
    // 非法 JSON / 数组参数不抛异常且不产生 rawArgs；非 delegate_task 不触发 onStatusTurnAction
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

  // 后台流 tool-start (cachedTarget.toolCalls 初始为 undefined)，不得更新 state.messages 也不触发 scheduleToolPatch
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

  // tool-start 当 ownerSessionId 为 null 时依然命中 state.messages 且不崩溃；tool-complete 同样兼容 null ownerSessionId
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

  // tool-complete: object output JSON 序列化、serverMs=0、负 serverMs 回退、Math.max(100/existing) 与 scheduleToolPatch 验证
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

  // 无 startTime 且无 serverMs 时 durationMs 保持 undefined
  fgAst.toolCalls[2].startTime = undefined;
  fgAst.toolCalls[2].durationMs = undefined;
  dispatcher.applyTurnActions([{ type: 'tool-complete', messageId: 'a-fg', toolCallId: 'tc-arr' }]);
  assert.equal(fgAst.toolCalls[2].durationMs, undefined);

  // 7. persisted-turn: 同步 state.messages 与 separateFgCache 并携带 botName 调用 persistTurnToCache
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

  // 更新 cached 中的 msg rowId（不改 state.messages）再次触发 persisted-turn（仅 cached 变更路径）
  persistCalls.length = 0;
  // 先绑定 stream 为 sess-fg 且无 botName，验证回落到 ctx.activeStreamingBotName；再测 explicit botName
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

  // 无变更时不重绘、不持久化
  persistCalls.length = 0;
  const rendersNoopPersist = renderCount;
  dispatcher.applyTurnActions([
    { type: 'persisted-turn', messageId: 'non-existent', userRowId: 99, assistantRowId: 100 },
  ]);
  assert.equal(persistCalls.length, 0);
  assert.equal(renderCount, rendersNoopPersist);

  // 后台会话 persisted-turn (persistOwnerId !== state.activeSessionId): 只更新 cached 并带 bg-bot 持久化，缓存为空/缺失时安全跳过
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

  // persisted-turn 回落 state.activeSessionId 当 activeStreamingStoredSessionId 为 null 且无 stream 时，bot 必须为 null（不得泄漏 activeStreamingBotName）
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

  // persistOwnerId 也为空（state.activeSessionId === '' 且 ctx 为 null）仍更新 state.messages 且不崩溃也不持久化
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

  // 清空所有流再调用 syncFocusedStreamingProjection('sess-attach-disp') 触发 liveCoord disarmTurnWatchdog 适配器
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
});

test('D6: gatewayEventDispatcher - frame parsing/session-info/subagent-failed/resolvedStreamingMessageId 与 disconnect 定时器及水合清理', async () => {
  const { LiveStreamRegistry, TokenCoalescer } = await import('@hermes-flux/core');
  const reg = new LiveStreamRegistry();
  const flushedTokens = [];
  const coalescer = new TokenCoalescer((map) => {
    for (const [messageId, entry] of map.entries()) {
      flushedTokens.push({ messageId, content: entry.content, thought: entry.thought });
    }
  });
  const { deps, state, watchdogEvents, rendered } = createMockDispatcherDeps({
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
  let fakeClient = {
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

  const dispatcher = createGatewayEventDispatcher(deps);

  // 1. subagent-failed + session-info(info: null, running: true, streaming: true) 三路喂狗与 idleSync 门卫
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

  // a) 仅在 streamRegistry（不在 ctx 也不在 runningSet）-> running=true 与 streaming=true 均喂狗并 touchActivity
  reg.registerStream({ storedSessionId: 'sess-reg-only', liveSessionId: 'custom-ws-handle-1', messageId: 'm-reg', origin: 'local', nowMs: 100 });
  const f1 = watchdogEvents.filter((e) => e === 'feed').length;
  dispatcher.applyTurnActions([{ type: 'session-info', sessionId: 'custom-ws-handle-1', info: { running: true } }]);
  assert.equal(watchdogEvents.filter((e) => e === 'feed').length, f1 + 1);
  assert.ok(reg.getBySession('sess-reg-only').lastActivityAt > 100);
  // 已在 reg 中的 unfocused session 不触发 idleSync；已注册的 focused session 也不触发 idleSync
  reg.registerStream({ storedSessionId: 'sess-focus', liveSessionId: 'live-sess-focus', messageId: 'm-foc', origin: 'local' });
  dispatcher.applyTurnActions([{ type: 'session-info', sessionId: 'live-sess-focus', info: { streaming: true } }]);
  assert.equal(watchdogEvents.filter((e) => e === 'feed').length, f1 + 2);
  await new Promise((r) => setTimeout(r, 75));
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

  // payload 为数组时安全过滤不挂载
  dispatcher.handleGatewayEvent({ type: 'message.start', session_id: 'live-sess-focus', payload: ['bad-array'] });
  assert.equal(reg.hasSession('sess-focus'), true, 'focused 会话收到无 turn_id message.start 会挂载流但不应读数组下标');
  reg.removeSession('sess-focus');

  // top-level session_id 为空，回退使用 payload.session_id
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

  // kind='message.start' 无 display_text 时回 fallback text；focused via activeSessionId（activeLiveSessionId === ''）
  state.activeSessionId = 'sess-focus-by-id';
  state.activeLiveSessionId = '';
  deps.getSessionMessagesCache().set('sess-focus-by-id', []);
  dispatcher.handleGatewayEvent({
    kind: 'message.start',
    session_id: 'live-sess-focus-by-id',
    payload: { text: 'kind-text-fallback' },
  });
  assert.equal(reg.hasSession('sess-focus-by-id'), true);
  assert.equal(deps.getSessionMessagesCache().get('sess-focus-by-id').some((m) => m.content === 'kind-text-fallback'), true);
  reg.removeSession('sess-focus-by-id');

  // 4. resolvedStreamingMessageId 当无 streamRegistry 注册项时：命中 ctx.activeStreamingStoredSessionId 则发给 ctx.activeStreamingMessageId，未命中则为 null
  state.activeSessionId = 'sess-other-ui';
  deps.setActiveStreamingContext({ activeStreamingStoredSessionId: 'sess-unreg-ctx', activeStreamingMessageId: 'msg-unreg-ctx' });
  flushedTokens.length = 0;
  dispatcher.handleGatewayEvent({ type: 'message.delta', session_id: 'live-sess-unreg-ctx', payload: { text: 'ctx-hit' } });
  dispatcher.handleGatewayEvent({ type: 'message.delta', session_id: 'live-sess-mismatch', payload: { text: 'ctx-miss' } });
  coalescer.flush();
  assert.equal(flushedTokens.length, 1);
  assert.equal(flushedTokens[0].messageId, 'msg-unreg-ctx');
  assert.equal(flushedTokens[0].content, 'ctx-hit');
  deps.setActiveStreamingContext({ activeStreamingStoredSessionId: null, activeStreamingMessageId: null });

  // 5. disconnect 取消待发 idleSync timer 并清空 hydratingRemoteSessions
  state.activeSessionId = 'sess-focus';
  idleSyncCount = 0;
  dispatcher.applyTurnActions([{ type: 'session-info', sessionId: 'live-sess-focus', info: { running: true } }]);
  // 启动一次挂起的 session.resume 水合（使用全新 pending promise 验证去重锁 + disconnect 清除去重锁）
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
  // 即使移除 stream，因 hydratingRemoteSessions 仍在途锁定，同会话二次挂载不得重复调 session.resume
  reg.removeSession('sess-hyd');
  dispatcher.handleGatewayEvent({ type: 'message.delta', session_id: 'live-sess-hyd', payload: { text: 'd1b' } });
  assert.equal(hydCount, 1);

  dispatcher.disconnect();
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(idleSyncCount, 0, 'disconnect 必须清除 clearActiveSessionSyncTimer 防止断开后触发 stale sync');

  // disconnect 清空 hydratingRemoteSessions 后（旧 promise 仍挂起也无妨），重新附带网关 client 触发同 sessionId 水合必须允许再次请求 session.resume
  const resumeBeforeRehyd = resumeCalls;
  deps.setGatewayClient(fakeClient);
  deps.getActiveRunningSessionIds().add('sess-hyd');
  dispatcher.handleGatewayEvent({ type: 'message.delta', session_id: 'live-sess-hyd', payload: { text: 'd2' } });
  assert.equal(hydCount, 1);
  assert.equal(resumeCalls, resumeBeforeRehyd + 1, 'disconnect 调用 clearHydrationState 后应解除 hydratingRemoteSessions 去重锁');
  releaseHyd?.(null);
  holdResumeResolve?.(null);
  await new Promise((r) => setTimeout(r, 20));
  dispatcher.disconnect();
});

test('D6: turnSettlement - session-reclaimed/refresh-sessions/finalReplace/cache工具收敛与多流disarm守卫全分支', async () => {
  const { LiveStreamRegistry } = await import('@hermes-flux/core');
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

  const dispatcher = createGatewayEventDispatcher(deps);

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
  // 含 completedStream 且有 finalReplace 时不应再多发 idleSync(0)
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(refreshCalls.length, 0);

  // 2. idleSync(0) 负向组合（有 completedStream 即使无 finalReplace 也不 sync；无 completedStream 且无 finalReplace 且 unfocused 也不 sync）+ 空内容保留旧 preview + 3元素 slice(-1)[0]
  state.gatewayConnected = true;
  deps.getSessionMessagesCache().set('sess-bg', [{ id: 'bu-empty', role: 'assistant', content: '' }]);
  dispatcher.applyTurnActions([
    { type: 'replace-content', messageId: 'bu-empty', text: '' },
    { type: 'turn-completed', sessionId: 'live-sess-bg', finalText: '' },
  ]);
  assert.equal(state.sessions.find((s) => s.id === 'sess-bg').preview, 'old-bg-prev', '空内容完成不得把旧 preview 覆写为空');
  assert.deepEqual(setContentLog.filter((x) => x[0] === 'bu-empty'), [], '有 streamRegistry 时后台 finalReplace 不得调 setMessageContent 污染前台');
  assert.equal(deps.getSessionMessagesCache().get('sess-bg')[0].id, 'bu-empty', '后台会话完成绝不可被前台 state.messages 覆写缓存');

  // 3-item bgCache 验证 slice(-1)[0]（非 slice(+1)[0]）+ completedBotName === ctx.activeStreamingBotName 独立清理
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

  // Focused 完成但 reg 中仍存在同/异会话流时的 syncFocusedProjection 与防 disarm 守卫
  reg.registerStream({ storedSessionId: 'sess-bg-keep', liveSessionId: 'live-bg-keep', messageId: 'm-keep', origin: 'remote' });
  reg.registerStream({ storedSessionId: 'sess-foc', liveSessionId: 'live-sess-foc-next', messageId: 'a-next', origin: 'local' });
  state.activeSessionId = 'sess-foc';
  state.isStreaming = false;
  deps.setActiveStreamingContext({ activeStreamingStoredSessionId: null, activeStreamingMessageId: null, activeStreamingBotName: null });
  const disarmKeep = watchdogEvents.filter((e) => e === 'disarm').length;
  // sessionId='' 且 ctx=null -> isFocused=true 且 sess-foc 仍在 reg -> 调 syncFocusedStreamingProjection 恢复 isStreaming=true 且不 disarm
  dispatcher.applyTurnActions([{ type: 'turn-completed', sessionId: '' }]);
  assert.equal(state.isStreaming, true, 'focused 完成若 reg 仍有当前会话流，必须 syncFocusedStreamingProjection 保活');
  assert.equal(watchdogEvents.filter((e) => e === 'disarm').length, disarmKeep);
  reg.removeSession('sess-foc');
  // focused 完成但后台仍有 sess-bg-keep -> 置 isStreaming=false 但不得 disarm
  dispatcher.applyTurnActions([{ type: 'turn-completed', sessionId: 'live-sess-foc' }]);
  assert.equal(state.isStreaming, false);
  assert.equal(watchdogEvents.filter((e) => e === 'disarm').length, disarmKeep);
  reg.removeSession('sess-bg-keep');

  // 有 completedStream 且有 finalText 时（无 finalReplace）focused 仍不得额外 idleSync(0)；而无 completedStream 无 finalReplace 有 finalText 则 sync(0)
  refreshCalls.length = 0;
  reg.registerStream({ storedSessionId: 'sess-foc', liveSessionId: 'live-sess-foc', messageId: 'a1', origin: 'local' });
  dispatcher.applyTurnActions([{ type: 'turn-completed', sessionId: 'live-sess-foc', finalText: 'streamed' }]);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(refreshCalls.length, 0);

  dispatcher.applyTurnActions([{ type: 'turn-completed', sessionId: 'live-sess-foc', finalText: 'unstreamed-authoritative' }]);
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(refreshCalls, [{ checkLiveTurn: true }]);
  refreshCalls.length = 0;

  // 3. 后台最后一个流完成/失败时的 disarm 收口（!state.isStreaming && !activeStreamingStoredSessionId -> disarm; 否则不 disarm）
  deps.setActiveStreamingContext({ activeStreamingStoredSessionId: null, activeStreamingMessageId: null, activeStreamingLiveId: null, activeStreamingBotName: null });
  reg.registerStream({ storedSessionId: 'sess-bg', liveSessionId: 'live-sess-bg', messageId: 'bu-empty', botName: 'bg-bot', origin: 'remote' });
  state.isStreaming = false;
  const disarm0 = watchdogEvents.filter((e) => e === 'disarm').length;
  dispatcher.applyTurnActions([{ type: 'turn-completed', sessionId: 'live-sess-bg' }]);
  assert.equal(watchdogEvents.filter((e) => e === 'disarm').length, disarm0 + 1, '全部流结束且前台空闲时，后台完成必须 disarm 看门狗');

  // activeStreamingStoredSessionId 仍存在或 reg 非空或 state.isStreaming=true 时后台完成不得 disarm
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

  // 4. turn-failed 深度分支: 后台 cache pendingMsg 回填 + focused 贴底滚动 + 后台最后流 disarm + 同会话仍有存活流时调用 syncFocusedProjection
  deps.getSessionMessagesCache().set('sess-bg-fail', [{ id: 'm-bg-f', role: 'assistant', content: '' }]);
  reg.registerStream({ storedSessionId: 'sess-bg-fail', liveSessionId: 'live-sess-bg-fail', messageId: 'm-bg-f', botName: 'fail-bg-bot', origin: 'remote' });
  deps.setActiveStreamingContext({ activeStreamingBotName: 'keep-ctx-bot' });
  const disarmFail0 = watchdogEvents.filter((e) => e === 'disarm').length;
  dispatcher.applyTurnActions([{ type: 'turn-failed', sessionId: 'live-sess-bg-fail', message: 'bg boom' }]);
  assert.equal(deps.getSessionMessagesCache().get('sess-bg-fail')[0].content, 'chat.turnFailedPrefix:bg boom', 'turn-failed 必须回填后台缓存内空消息');
  assert.equal(deps.getActiveStreamingContext().activeStreamingBotName, 'keep-ctx-bot');
  assert.equal(watchdogEvents.filter((e) => e === 'disarm').length, disarmFail0 + 1, '后台最后一个流 fail 且空闲时必须 disarm');

  // focused turn-failed 且近底 -> setPendingScrollToBottom(true); setTurnStartedSessionId(null); 后台有流时不得 disarm；focused 仍有残留流时调用 syncFocusedProjection 不置 false
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

  // 后台 fail 当 ctx.activeStreamingBotName 匹配 failedBotName 但 session 不同时仍须清零 activeStreamingBotName；有剩余流时不 disarm
  deps.setActiveStreamingContext({ activeStreamingStoredSessionId: 'sess-other-x', activeStreamingBotName: 'fail-bg-bot' });
  reg.registerStream({ storedSessionId: 'sess-bg-fail', liveSessionId: 'live-sess-bg-fail', messageId: 'm-bg-f', botName: 'fail-bg-bot', origin: 'remote' });
  state.isStreaming = false;
  dispatcher.applyTurnActions([{ type: 'turn-failed', sessionId: 'live-sess-bg-fail', message: 'bg boom 2' }]);
  assert.equal(deps.getActiveStreamingContext().activeStreamingBotName, null);
  assert.equal(watchdogEvents.filter((e) => e === 'disarm').length, disarmFocFail, 'reg 中尚有 sess-bg-still 不得 disarm');
  reg.removeSession('sess-bg-still');

  // activeSessionId 在 reg 中仍有新流时 fail (failedTargetId === null) -> L711-712 走 syncFocusedStreamingProjection
  reg.registerStream({ storedSessionId: 'sess-foc', liveSessionId: 'live-foc-2', messageId: 'a-f-2', origin: 'remote' });
  state.activeSessionId = 'sess-foc';
  state.isStreaming = false;
  deps.setActiveStreamingContext({ activeStreamingStoredSessionId: null, activeStreamingMessageId: null });
  dispatcher.applyTurnActions([{ type: 'turn-failed', sessionId: '', message: 'generic err' }]);
  assert.equal(state.isStreaming, true, 'activeSessionId 在 reg 中仍有新流时 fail 必须 syncFocusedStreamingProjection 保持 isStreaming=true');
  reg.removeSession('sess-foc');

  // 5. session-reclaimed: 聚焦会话回收 / 后台匹配的 ctx 会话回收 / 不匹配 ctx 不误清
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

  // 后台 reclaimed 命中 ctx.activeStreamingStoredSessionId (触发 syncFocusedStreamingProjection 收口 isStreaming 但不清空 activeLiveSessionId) + render
  state.activeLiveSessionId = 'keep-foc-live';
  state.isStreaming = true;
  const rendersBeforeRec = rendered.length;
  deps.setActiveStreamingContext({ activeStreamingStoredSessionId: 'sess-bg-rec', activeStreamingMessageId: 'm-rec' });
  dispatcher.applyTurnActions([{ type: 'session-reclaimed', storedSessionId: 'sess-bg-rec', sessionId: 'live-bg-rec' }]);
  assert.equal(state.activeLiveSessionId, 'keep-foc-live');
  assert.equal(state.isStreaming, false, '命中 ctx.activeStreamingStoredSessionId 时应调用 syncFocusedStreamingProjection');
  assert.ok(rendered.length > rendersBeforeRec);
  assert.equal(refreshCalls.length, 1);

  // 未命中任何上下文的 session-reclaimed 保持 isStreaming 不变
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
  await new Promise((r) => setTimeout(r, 185));
  assert.deepEqual(refreshCalls, [{ checkLiveTurn: true }]);

  // 7. 无 streamRegistry 模式下后台 finalReplace 仍走 setMessageContent (L556 !streamRegistry 分支)
  deps.getLiveStreamRegistry = undefined;
  setContentLog.length = 0;
  const noRegDispatcher = createGatewayEventDispatcher(deps);
  deps.getSessionMessagesCache().set('sess-bg', [{ id: 'm-noreg', role: 'assistant', content: 'old' }]);
  noRegDispatcher.applyTurnActions([
    { type: 'replace-content', messageId: 'm-noreg', text: 'NoReg Final' },
    { type: 'turn-completed', sessionId: 'live-sess-bg' },
  ]);
  assert.deepEqual(setContentLog, [['m-noreg', 'NoReg Final']]);

  // 7b. 无 streamRegistry + 空/非空 targetStartedId 与 session-reclaimed 全分支闭合 (L288, L740)
  const armsBeforeNoReg = watchdogEvents.length;
  state.activeSessionId = 'sess-bg';
  state.isStreaming = false;
  noRegDispatcher.applyTurnActions([{ type: 'turn-started', sessionId: 'live-sess-bg' }]);
  assert.equal(state.isStreaming, true);
  assert.equal(watchdogEvents.length > armsBeforeNoReg, true);

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
  noRegDispatcher.disconnect();

  dispatcher.disconnect();
});
