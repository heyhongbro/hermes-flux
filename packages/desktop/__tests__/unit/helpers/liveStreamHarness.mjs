/**
 * LiveStreamCoordinator 测试共用多会话夹具与确定性时钟辅助工具
 * （仅纯测试夹具，严禁引入 dist/ 编译产物或篡改 globalThis 全局对象）
 */

import { LiveStreamRegistry, TokenCoalescer } from '@hermes-flux/core';

/**
 * 排空当前微任务队列并让出一次 setImmediate 检查点，
 * 确保浮空 async rejection 能在当前测试作用域退出前被 node:test 捕获归因。
 */
export async function flushMicrotasks(rounds = 12) {
  for (let i = 0; i < rounds; i += 1) {
    await Promise.resolve();
  }
  await new Promise((resolve) => setImmediate(resolve));
}

/** 推进 node:test mock timers 并排空后续异步微任务 */
export async function advanceTimers(t, ms, rounds = 12) {
  t.mock.timers.tick(ms);
  await flushMicrotasks(rounds);
}

/** 创建多会话协调器测试夹具（依赖从调用侧注入，保证 helper 不直接依赖 dist/） */
export function createMultiSessionHarness({ createGatewayEventDispatcher, createTokenStreamWriter }, overrides = {}) {
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
