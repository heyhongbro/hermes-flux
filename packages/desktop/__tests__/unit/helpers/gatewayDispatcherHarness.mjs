/**
 * GatewayEventDispatcher 测试共用 Mock 依赖与确定性时钟辅助工具
 * （仅纯测试夹具，严禁引入 dist/ 编译产物或篡改 globalThis 全局对象）
 */

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

export function createMockDispatcherDeps(overrides = {}) {
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
    testConnection: async (_url, _u, _p) => ({ ok: true, latency: 15, ticket: 'ticket-xyz', message: 'ok' }),
    completeEntityTurn: (domain, _running, _unread, entityId, focused) => {
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
    toStoredSessionId: (id) => (id ? id.replace(/^live-/, '') : null),

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
    getSessionMessagesCache: () => sessionMessagesCache,
  };
}
