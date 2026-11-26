/**
 * TurnExecutionService 测试共用 Mock 依赖与确定性时钟/Gate 辅助工具
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

/** 创建确定性异步屏障，替代魔法延时 await sleep */
export function createGate() {
  let notify;
  const promise = new Promise((resolve) => {
    notify = resolve;
  });
  return { promise, notify };
}

export function createMockTurnDeps(overrides = {}) {
  const rendered = [];
  const state = {
    activeSessionId: 'sess-1',
    activeLiveSessionId: 'live-1',
    profileName: 'default',
    profiles: [{ name: 'default', displayName: 'Default Bot' }, { name: 'arch-bot', displayName: '架构师' }],
    sessions: [
      { id: 'sess-1', title: 'Task 1', botName: 'default', preview: '', timestamp: 1000 },
    ],
    groupRooms: [
      { roomId: 'room-1', name: 'General', lastMessage: '', updatedAt: 1000 },
    ],
    messages: [
      { id: 'usr-1', role: 'user', content: 'hello', timestamp: '12:00:00' },
    ],
    attachments: [],
    sideAgentCapsules: [],
    activeFocus: { type: 'session', sessionId: 'sess-1' },
    isStreaming: false,
    turnStartedAt: undefined,
    dockNotice: '',
    presenceTerminal: undefined,
    rollbackArmed: null,
    hasOlderMessages: false,
    pickedMention: null,
    ...(overrides.state || {}),
  };

  const rpcCalls = [];
  const gatewayClient = overrides.gatewayClient ?? {
    call: async (method, params) => {
      rpcCalls.push({ method, params });
      if (method === 'prompt.submit') {
        return { status: 'streaming', user_row_id: 42 };
      }
      if (method === 'session.interrupt') {
        return { ok: true };
      }
      if (method === 'image.attach_bytes') {
        return { ok: true, id: 'att-1' };
      }
      if (method === 'prompt.background') {
        return { task_id: 'task-bg-1' };
      }
      return {};
    },
  };

  let activeStreamingContext = {
    activeStreamingMessageId: null,
    activeStreamingStoredSessionId: null,
    activeStreamingLiveId: null,
    activeStreamingBotName: null,
    ...(overrides.activeStreamingContext || {}),
  };

  let turnStartedSessionId = null;
  const runningSessions = new Set();
  const unreadSessions = new Set();
  const runningBots = new Set();
  const unreadBots = new Set();
  const runningGroups = new Set();
  const unreadGroups = new Set();

  const sessionMessagesCache = new Map();
  const sessionDraftsMap = new Map();
  const sessionHistoryTrust = new Map();

  const tokenCoalescer = {
    flushed: false,
    cleared: false,
    flush() { this.flushed = true; },
    clear() { this.cleared = true; },
  };

  const activityTransitionTracker = {
    cleared: [],
    clear(domain, id) { this.cleared.push({ domain, id }); },
  };

  const sessionHandleRegistry = {
    registered: [],
    register(pair) { this.registered.push(pair); },
    toLiveId: (id) => `live-${id}`,
    toStoredId: (id) => id.replace(/^live-/, ''),
    getLiveIds: (ids) => ids.map((id) => `live-${id}`),
  };

  const botActivityStore = {
    updated: [],
    updateLatestActivity(botName, content, ts) {
      this.updated.push({ botName, content, ts });
    },
  };

  const interactiveService = {
    truncateCalls: [],
    truncateAndSubmit: async (caller, params) => {
      interactiveService.truncateCalls.push(params);
      return { status: 'streaming', user_row_id: 88 };
    },
  };

  const cacheService = {
    truncated: [],
    truncate: async (ref, rowId, survivorMap) => {
      cacheService.truncated.push({ ref, rowId, survivorMap });
    },
  };

  const groupRoomStore = {
    sent: [],
    logs: new Map(),
    getLogs(roomId) { return groupRoomStore.logs.get(roomId) || []; },
    fetchLogs: async (roomId) => groupRoomStore.logs.get(roomId) || [],
    sendMessage: async (roomId, text, actor, client, opts) => {
      groupRoomStore.sent.push({ roomId, text, opts });
      return { event: { payload: { thread_id: 'thread-123' } } };
    },
  };

  const handoffService = {
    sendBtw: async (liveId, question, profile) => {
      return { task_id: 'task-btw-1' };
    },
  };

  const completedTurns = [];
  const depsRecorded = {
    userExpandedState: null,
    ensuredWindowTotal: null,
  };

  const deps = {
    getState: () => state,
    getGatewayClient: () => gatewayClient,
    getRpcCaller: () => ({ call: (m, p) => gatewayClient.call(m, p) }),
    getInteractiveService: () => interactiveService,
    getCacheService: () => cacheService,
    getGroupRoomStore: () => groupRoomStore,
    getActivityTransitionTracker: () => activityTransitionTracker,
    getTokenCoalescer: () => tokenCoalescer,
    getSessionHandleRegistry: () => sessionHandleRegistry,
    getSessionMessagesCache: () => sessionMessagesCache,
    getSessionDrafts: () => ({
      get: (id) => sessionDraftsMap.get(id),
      set: (id, val) => sessionDraftsMap.set(id, val),
      delete: (id) => sessionDraftsMap.delete(id),
    }),
    getBotActivityStore: () => botActivityStore,
    getHandoffService: () => handoffService,
    completeEntityTurn: (domain, running, unread, entityId, focused) => {
      completedTurns.push({ domain, entityId, focused });
    },

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

    getSessionHistoryTrust: () => sessionHistoryTrust,
    forgetOlderCursorState: () => {},
    createNewSession: async () => {},
    ensureLiveSessionId: async () => 'live-1',
    setMessageContent: (mid, content) => {
      const target = state.messages.find((m) => m.id === mid);
      if (target) target.content = content;
    },
    syncActiveGroupSpeakerFromMessages: () => {},
    resolveAgentAvatar: () => '',
    scrollStreamToBottom: () => {},
    setPendingScrollToBottom: () => {},

    runSlashCommand: async () => {},
    enqueueDraft: async () => {},
    handleQueueAction: async () => {},

    setMessageWindowUserExpanded: (val) => {
      depsRecorded.userExpandedState = val;
    },
    ensureMessageWindow: (total) => {
      depsRecorded.ensuredWindowTotal = total;
    },

    render: () => { rendered.push(Date.now()); },
    t: (key, params) => {
      if (key === 'chat.interruptedSuffix') return ' *(已中断)*';
      if (key === 'chat.interruptedEmpty') return '*(已中断本轮生成)*';
      return `${key}${params ? JSON.stringify(params) : ''}`;
    },
  };

  return {
    state,
    deps,
    rpcCalls,
    interactiveService,
    cacheService,
    groupRoomStore,
    tokenCoalescer,
    botActivityStore,
    activityTransitionTracker,
    rendered,
    depsRecorded,
    activeStreamingContext: () => activeStreamingContext,
  };
}
