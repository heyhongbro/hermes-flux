/**
 * 回合执行与队列控制服务（Turn Execution Service · D5）纯逻辑单测
 * (packages/desktop/__tests__/unit/turnExecutionService.test.mjs)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createTurnExecutionService } from '../../dist/renderer/services/turnExecutionService.mjs';

async function waitForCondition(cond, timeoutMs = 2000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitForCondition timeout after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

function createMockTurnDeps(overrides = {}) {
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

test('D5: turnExecutionService - armPresenceTerminal 与 clearPresenceTerminal 生命周期', () => {
  const { deps, state, rendered } = createMockTurnDeps();
  const service = createTurnExecutionService(deps);

  service.armPresenceTerminal({ kind: 'interrupted' });
  assert.equal(state.presenceTerminal?.kind, 'interrupted');

  service.clearPresenceTerminal();
  assert.equal(state.presenceTerminal, undefined);

  service.setTimedDockNotice('通知测试', 0);
  assert.equal(state.dockNotice, '通知测试');
});

test('D5: turnExecutionService - interruptTurn 终止当前流式并更新消息标记', async () => {
  const { deps, state, rpcCalls, activeStreamingContext } = createMockTurnDeps({
    state: {
      isStreaming: true,
      messages: [
        { id: 'ast-1', role: 'assistant', content: '生成中内容' },
      ],
    },
    activeStreamingContext: {
      activeStreamingMessageId: 'ast-1',
      activeStreamingStoredSessionId: 'sess-1',
      activeStreamingLiveId: 'live-1',
    },
  });

  const service = createTurnExecutionService(deps);
  await service.interruptTurn();

  assert.equal(state.isStreaming, false);
  assert.equal(state.presenceTerminal?.kind, 'interrupted');
  const msg = state.messages.find((m) => m.id === 'ast-1');
  assert.match(msg.content, /\*\(已中断\)\*/);
  assert.equal(activeStreamingContext().activeStreamingMessageId, null);

  const interruptRpc = rpcCalls.find((c) => c.method === 'session.interrupt');
  assert.ok(interruptRpc, '必须调用 remote session.interrupt');
  assert.equal(interruptRpc.params.session_id, 'live-1');
});

test('D5: turnExecutionService - sendMessage 发送单聊并挂载流式上下文', async () => {
  const { deps, state, rpcCalls, activeStreamingContext, depsRecorded } = createMockTurnDeps();
  const service = createTurnExecutionService(deps);

  await service.sendMessage('请帮我分析这段架构');

  assert.equal(state.isStreaming, true);
  assert.ok(state.turnStartedAt > 0);
  assert.equal(state.messages.length, 3); // usr-1 + new user + new assistant
  assert.equal(depsRecorded.userExpandedState, false, '发消息必须主动解除历史回溯扩展锁定');
  assert.equal(depsRecorded.ensuredWindowTotal, 3, '发消息必须强制根据新总数对齐窗口');
  const userMsg = state.messages[1];
  assert.equal(userMsg.role, 'user');
  assert.equal(userMsg.content, '请帮我分析这段架构');
  assert.equal(userMsg.rowId, 42, '网关权威 user_row_id 必须绑定回用户行');

  const submitRpc = rpcCalls.find((c) => c.method === 'prompt.submit');
  assert.ok(submitRpc);
  assert.equal(submitRpc.params.text, '请帮我分析这段架构');
  assert.equal(activeStreamingContext().activeStreamingStoredSessionId, 'sess-1');

  service.armTurnWatchdog();
  service.feedTurnWatchdog();
  service.disarmTurnWatchdog();
  service.clearPresenceTerminal();
});

test('D4-watchdog: turnExecutionService - 看门狗空闲超时触发静默熔断与提示下发', async () => {
  const { deps, state, activeStreamingContext, activityTransitionTracker } = createMockTurnDeps();
  deps.watchdogIdleTimeoutMs = 20;
  const service = createTurnExecutionService(deps);

  state.isStreaming = true;
  activeStreamingContext().activeStreamingStoredSessionId = 'sess-timeout';
  // Bot 主工位的流式回合同时挂 bot 域运行态：超时必须一并摘掉活跃标记，
  // 否则 Bot 卡片在会话侧已熔断、在 Bot 侧仍显示"正在运行"，两侧状态永久分叉。
  activeStreamingContext().activeStreamingBotName = 'bot-x';
  service.armTurnWatchdog();

  await new Promise((resolve) => setTimeout(resolve, 60));

  assert.equal(state.isStreaming, false, '超时后必须原子重置流式状态');
  assert.equal(state.dockNotice, 'chat.watchdogTimeoutNotice');
  assert.deepEqual(
    activityTransitionTracker.cleared,
    [{ domain: 'session', id: 'sess-timeout' }, { domain: 'bot', id: 'bot-x' }],
    '会话域与 Bot 域都必须摘掉活跃标记，不得只清一侧'
  );
});

test('D4-watchdog: turnExecutionService - 非流式态超时不误伤状态', async () => {
  const { deps, state } = createMockTurnDeps();
  deps.watchdogIdleTimeoutMs = 20;
  const service = createTurnExecutionService(deps);

  state.isStreaming = false;
  state.dockNotice = '';
  service.armTurnWatchdog();

  await new Promise((resolve) => setTimeout(resolve, 60));

  assert.equal(state.dockNotice, '', '非流式态超时不得下发看门狗提示');
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

test('D5: turnExecutionService - routeSend 分流裁决与 BTW 旁路调用', async () => {
  const { deps, state } = createMockTurnDeps({
    state: {
      activeFocus: { type: 'bot', botName: 'default' },
    },
  });
  const service = createTurnExecutionService(deps);

  // Bot 工位中的 @ 提及分流为 BTW 外援胶囊
  await service.routeSend('@Default Bot 帮我看一眼');
  assert.equal(state.sideAgentCapsules.length, 1);
  assert.equal(state.sideAgentCapsules[0].id, 'task-btw-1');
  assert.equal(state.sideAgentCapsules[0].status, 'pending');

  for (const c of state.sideAgentCapsules) {
    if (c.hintTimer) clearTimeout(c.hintTimer);
    if (c.expireTimer) clearTimeout(c.expireTimer);
  }
});

test('D5: turnExecutionService - sendGroupMessage 严格走 groups.send', async () => {
  const { deps, state, groupRoomStore } = createMockTurnDeps({
    state: {
      activeFocus: { type: 'group', roomId: 'room-1' },
    },
  });
  const service = createTurnExecutionService(deps);

  await service.sendGroupMessage('room-1', '各位 Agent 好');

  assert.equal(groupRoomStore.sent.length, 1);
  assert.equal(groupRoomStore.sent[0].roomId, 'room-1');
  assert.equal(groupRoomStore.sent[0].text, '各位 Agent 好');
  const targetRoom = state.groupRooms.find((r) => r.roomId === 'room-1');
  assert.equal(targetRoom.lastMessage, '各位 Agent 好');

  service.getGroupPollerManager().stopAll();
});

test('D5: turnExecutionService - routeSend 群聊模式零逃逸：严格走 sendGroupMessage，绝不调用 prompt.submit 或新建会话', async () => {
  let promptSubmitCalled = false;
  let createSessionCalled = false;
  const { deps, state, groupRoomStore, interactiveService } = createMockTurnDeps({
    state: {
      activeFocus: { type: 'group', roomId: 'room-alpha' },
      activeSessionId: '',
      activeLiveSessionId: '',
    },
  });
  interactiveService.submitPrompt = async () => { promptSubmitCalled = true; };
  deps.createNewSession = async () => { createSessionCalled = true; };

  const service = createTurnExecutionService(deps);
  await service.routeSend('群聊研讨测试发言');

  assert.equal(groupRoomStore.sent.length, 1);
  assert.equal(groupRoomStore.sent[0].roomId, 'room-alpha');
  assert.equal(groupRoomStore.sent[0].text, '群聊研讨测试发言');
  assert.equal(promptSubmitCalled, false, '群聊消息严禁逃逸至 prompt.submit');
  assert.equal(createSessionCalled, false, '群聊消息严禁触发 createNewSession');
  assert.equal(state.activeSessionId, '', '群聊发送后 activeSessionId 必须保持为空');

  service.getGroupPollerManager().stopAll();
});

test('D5: turnExecutionService - routeSend 群聊焦点丢失显式失败，绝不回退至普通单聊', async () => {
  let promptSubmitCalled = false;
  let createSessionCalled = false;
  const { deps, state, interactiveService } = createMockTurnDeps({
    state: {
      activeFocus: { type: 'group', roomId: '' }, // 群聊焦点但 roomId 丢失/异常
      activeSessionId: '',
    },
  });
  interactiveService.submitPrompt = async () => { promptSubmitCalled = true; };
  deps.createNewSession = async () => { createSessionCalled = true; };

  const service = createTurnExecutionService(deps);
  await service.routeSend('异常群聊文本');

  assert.equal(promptSubmitCalled, false, '焦点失配时严禁逃逸至 prompt.submit');
  assert.equal(createSessionCalled, false, '焦点失配时严禁创建新单聊会话');
  assert.equal(state.dockNotice.includes('group.sendFailed'), true, '必须显式提示群聊发送失败通知');
});

test('D5: turnExecutionService - syncGroupRoomLogsToState 解析群聊用户附件清单且跳过 Assistant 文本', () => {
  const { deps, state } = createMockTurnDeps({
    state: {
      activeFocus: { type: 'group', roomId: 'room-1' },
      messages: [],
    },
  });
  const service = createTurnExecutionService(deps);

  service.syncGroupRoomLogsToState('room-1', [
    {
      messageId: 'gm-1',
      actorKind: 'user',
      senderProfile: 'user',
      text: '[附件列表]\n- Image 1: arch.png\n\n请评审架构图',
      timestamp: 1700000000000,
    },
    {
      messageId: 'gm-2',
      actorKind: 'user',
      senderProfile: 'user',
      text: '纯文字消息',
      timestamp: 1700000001000,
    },
    {
      messageId: 'gm-3',
      actorKind: 'agent',
      senderProfile: 'arch-bot',
      text: '[附件列表]\n- note.md\n\n已收到',
      timestamp: 1700000002000,
    },
  ]);

  assert.equal(state.messages.length, 3);
  assert.equal(state.messages[0].role, 'user');
  assert.equal(state.messages[0].content, '请评审架构图');
  assert.equal(state.messages[0].attachments?.length, 1);
  assert.equal(state.messages[0].attachments?.[0]?.name, 'arch.png');

  assert.equal(state.messages[1].role, 'user');
  assert.equal(state.messages[1].content, '纯文字消息');
  assert.equal(state.messages[1].attachments, undefined);

  assert.equal(state.messages[2].role, 'assistant');
  assert.equal(state.messages[2].content, '[附件列表]\n- note.md\n\n已收到');
  assert.equal(state.messages[2].attachments, undefined);

  // 非聚焦群聊日志不得覆写当前消息流
  service.syncGroupRoomLogsToState('room-other', [{ text: 'ignored' }]);
  assert.equal(state.messages.length, 3);
});

test('D5: turnExecutionService - sendMessage 附件上传期间断连/中断中止与切会话后台提交收口', async () => {
  // 1. 上传期间 disconnect (getGatewayClient !== client) 与中断 (activeStreamingMessageId 变更) 均不得续发 prompt.submit
  for (const mode of ['disconnectClient', 'interruptStream']) {
    let releaseUpload;
    const uploadPromise = new Promise((resolve) => {
      releaseUpload = resolve;
    });
    const calls = [];
    let currentClient = {
      call: async (method, params) => {
        calls.push({ method, params });
        if (method === 'image.attach_bytes') {
          return uploadPromise;
        }
        return { status: 'streaming', user_row_id: 99 };
      },
    };
    const { deps } = createMockTurnDeps({
      state: {
        activeSessionId: 'sess-1',
        attachments: [
          {
            id: 'att-up-1',
            name: 'shot.png',
            label: 'Image 1',
            type: 'image',
            mimeType: 'image/png',
            previewUrl: 'data:image/png;base64,QUJD',
          },
        ],
      },
    });
    deps.getGatewayClient = () => currentClient;
    const service = createTurnExecutionService(deps);
    const sendPromise = service.sendMessage('hello');
    await new Promise((r) => setTimeout(r, 10));

    if (mode === 'disconnectClient') {
      currentClient = null;
    } else {
      deps.setActiveStreamingContext({ activeStreamingMessageId: 'ast-switched' });
    }
    releaseUpload({ ok: true, id: 'att-up-1' });
    await sendPromise;

    assert.equal(
      calls.some((c) => c.method === 'prompt.submit'),
      false,
      `${mode} 后严禁继续发送 prompt.submit`,
    );
  }

  // 2. 上传期间仅切换焦距到其他会话（state.isStreaming = false，activeStreamingContext 未撤消）：
  // 后台仍须完成 truncateAndSubmit，且 user_row_id / trust / cache 只更新 sess-1，不得污染 sess-other
  {
    let releaseUpload;
    const uploadPromise = new Promise((resolve) => {
      releaseUpload = resolve;
    });
    const otherMessages = [{ id: 'other-m1', role: 'user', content: 'other session' }];
    const { deps, state, cacheService } = createMockTurnDeps({
      state: {
        activeSessionId: 'sess-1',
        hasOlderMessages: false,
        rollbackArmed: {
          sessionId: 'sess-1',
          anchor: { kind: 'row', rowId: 10 },
          snapshot: [{ id: 'snap-orig', role: 'user', content: 'orig' }],
        },
        attachments: [
          {
            id: 'att-bg-1',
            name: 'shot.png',
            type: 'image',
            previewUrl: 'data:image/png;base64,QUJD',
          },
        ],
      },
      gatewayClient: {
        call: async (method) => {
          if (method === 'image.attach_bytes') return uploadPromise;
          return { status: 'streaming', user_row_id: 777 };
        },
      },
    });
    const service = createTurnExecutionService(deps);
    const sendP = service.sendMessage('bg truncate prompt');
    await new Promise((r) => setTimeout(r, 10));

    state.activeSessionId = 'sess-other';
    state.isStreaming = false;
    state.messages = otherMessages;
    state.hasOlderMessages = true;

    releaseUpload({ ok: true, id: 'att-bg-1' });
    await sendP;

    const s1Cache = deps.getSessionMessagesCache().get('sess-1') || [];
    assert.equal(s1Cache.some((m) => m.rowId === 88), true);
    assert.equal(state.hasOlderMessages, true, '后台 truncate 完成不得修改已切换新会话的 hasOlderMessages');
    assert.equal(deps.getSessionHistoryTrust().get('sess-1'), 'server-priority');
    assert.equal(cacheService.truncated.length, 1);
  }

  // 3. 切走会话后后台 truncateAndSubmit 失败：清理 sess-1 运行态与看门狗、恢复 sess-1 缓存快照，不覆写新会话
  {
    let releaseUpload;
    const uploadPromise = new Promise((resolve) => {
      releaseUpload = resolve;
    });
    const origSnap = [{ id: 'snap-orig-2', role: 'user', content: 'orig 2' }];
    const otherMessages = [{ id: 'other-stay', role: 'user', content: 'stay' }];
    const { deps, state } = createMockTurnDeps({
      state: {
        activeSessionId: 'sess-1',
        activeFocus: { type: 'bot', botName: 'default' },
        rollbackArmed: {
          sessionId: 'sess-1',
          anchor: { kind: 'row', rowId: 12 },
          snapshot: origSnap,
        },
        attachments: [
          {
            id: 'att-bg-2',
            name: 'shot2.png',
            type: 'image',
            previewUrl: 'data:image/png;base64,QUJD',
          },
        ],
      },
      gatewayClient: {
        call: async (method) => {
          if (method === 'image.attach_bytes') return uploadPromise;
          return {};
        },
      },
    });
    deps.getInteractiveService().truncateAndSubmit = async () => {
      throw new Error('bg fail');
    };
    const service = createTurnExecutionService(deps);
    const sendP = service.sendMessage('bg fail prompt');
    await new Promise((r) => setTimeout(r, 10));

    state.activeSessionId = 'sess-other';
    state.isStreaming = false;
    state.messages = otherMessages;
    state.dockNotice = '';

    releaseUpload({ ok: true, id: 'att-bg-2' });
    await sendP;

    assert.equal(deps.getActiveRunningSessionIds().has('sess-1'), false);
    assert.equal(deps.getActiveRunningBotNames().has('default'), false);
    assert.equal(deps.getActiveStreamingContext().activeStreamingMessageId, null);
    assert.equal(state.messages, otherMessages, '后台失败恢复不得覆写当前聚焦会话的消息列表');
    assert.equal(state.dockNotice, '', '后台失败不得向非聚焦会话弹出回滚失败横幅');
    assert.deepEqual(deps.getSessionMessagesCache().get('sess-1'), origSnap);
  }

  // 4. 同会话未切走时 truncateAndSubmit 成功须清空 state.hasOlderMessages，以及 status 非 streaming/queued 触发 failSubmittedTurn
  {
    const { deps, state } = createMockTurnDeps({
      state: {
        activeSessionId: 'sess-1',
        hasOlderMessages: true,
        rollbackArmed: {
          sessionId: 'sess-1',
          anchor: { kind: 'row', rowId: 15 },
          snapshot: [{ id: 'snap-focus', role: 'user', content: 'focus' }],
        },
      },
    });
    const service = createTurnExecutionService(deps);
    await service.sendMessage('focused truncate ok');
    assert.equal(state.hasOlderMessages, false);
    assert.equal(deps.getSessionHistoryTrust().get('sess-1'), 'server-priority');
  }

  {
    const { deps, state } = createMockTurnDeps({
      state: {
        activeSessionId: 'sess-1',
        activeFocus: { type: 'bot', botName: 'default' },
      },
      gatewayClient: {
        call: async (method) => {
          if (method === 'prompt.submit') return { status: 'rejected' };
          return {};
        },
      },
    });
    const service = createTurnExecutionService(deps);
    await service.sendMessage('rejected prompt');
    assert.equal(state.isStreaming, false);
    assert.equal(state.presenceTerminal?.kind, 'failed');
    assert.equal(deps.getActiveRunningSessionIds().has('sess-1'), false);
    assert.equal(deps.getActiveRunningBotNames().has('default'), false);
  }

  // 5. 上传期被 Session B 接管：清理旧会话/Bot 运行态并回滚缓存，同时完整保留 B 的上下文与看门狗
  {
    let releaseUpload;
    const uploadPromise = new Promise((resolve) => {
      releaseUpload = resolve;
    });
    const origSnap = [{ id: 'snap-sup', role: 'user', content: 'sup orig' }];
    const { deps, state } = createMockTurnDeps({
      state: {
        activeSessionId: 'sess-a',
        activeFocus: { type: 'bot', botName: 'bot-a' },
        sessions: [{ id: 'sess-a', title: 'A', botName: 'bot-a', preview: '', timestamp: 1 }],
        rollbackArmed: { sessionId: 'sess-a', anchor: { kind: 'row', rowId: 5 }, snapshot: origSnap },
        attachments: [{ id: 'att-s1', name: 'a.png', type: 'image', previewUrl: 'data:image/png;base64,QUJD' }],
      },
      gatewayClient: {
        call: async (method) => (method === 'image.attach_bytes' ? uploadPromise : {}),
      },
    });
    const service = createTurnExecutionService(deps);
    const sendP = service.sendMessage('sup upload');
    await new Promise((r) => setTimeout(r, 10));

    // Session B 覆盖活跃流式上下文，A 仍持有 sess-a & bot-a 归属 -> 仅清理 A 并回滚 sess-a 缓存
    state.activeSessionId = 'sess-b';
    deps.setActiveStreamingContext({
      activeStreamingMessageId: 'ast-b',
      activeStreamingStoredSessionId: 'sess-b',
      activeStreamingLiveId: 'live-b',
      activeStreamingBotName: 'bot-b',
    });
    deps.getActiveRunningSessionIds().add('sess-b');

    releaseUpload({ ok: true });
    await sendP;

    assert.equal(deps.getActiveRunningSessionIds().has('sess-a'), false);
    assert.equal(deps.getActiveRunningBotNames().has('bot-a'), false);
    assert.equal(deps.getActiveStreamingContext().activeStreamingMessageId, 'ast-b', '不得误清 B 的流式上下文');
    assert.equal(deps.getActiveRunningSessionIds().has('sess-b'), true);
    assert.deepEqual(deps.getSessionMessagesCache().get('sess-a'), origSnap);
  }

  // 5a. bot-only 接管场景：sess-a 已不在 activeRunningSessionIds 而 bot-a 仍归属本轮 -> 只清 bot-a，不覆写 sess-a 缓存
  {
    let releaseUpload;
    const origSnap = [{ id: 'snap-bo', role: 'user', content: 'bo orig' }];
    const customCache = [{ id: 'keep-me', role: 'user', content: 'keep' }];
    const { deps, state } = createMockTurnDeps({
      state: {
        activeSessionId: 'sess-bo',
        activeFocus: { type: 'bot', botName: 'bot-bo' },
        rollbackArmed: { sessionId: 'sess-bo', anchor: { kind: 'row', rowId: 6 }, snapshot: origSnap },
        attachments: [{ id: 'att-bo', name: 'bo.png', type: 'image', previewUrl: 'data:image/png;base64,QUJD' }],
      },
      gatewayClient: {
        call: async (method) =>
          method === 'image.attach_bytes' ? new Promise((r) => { releaseUpload = r; }) : {},
      },
    });
    const service = createTurnExecutionService(deps);
    const sendP = service.sendMessage('bot only sup');
    await new Promise((r) => setTimeout(r, 10));

    deps.setActiveStreamingContext({ activeStreamingMessageId: 'ast-other' });
    deps.getActiveRunningSessionIds().delete('sess-bo');
    deps.getSessionMessagesCache().set('sess-bo', customCache);

    releaseUpload({ ok: true });
    await sendP;

    assert.equal(deps.getActiveRunningBotNames().has('bot-bo'), false);
    assert.equal(deps.getSessionMessagesCache().get('sess-bo'), customCache);
  }

  // 5b. interruptTurn() 发生在上传附件等待期间：hasUnsettledRunning 为 false，跳过 prompt.submit 且不覆写中断态
  {
    let releaseUpload;
    const uploadPromise = new Promise((resolve) => {
      releaseUpload = resolve;
    });
    const calls = [];
    const { deps, state } = createMockTurnDeps({
      state: {
        activeSessionId: 'sess-int-up',
        attachments: [{ id: 'att-int', name: 'up.png', type: 'image', previewUrl: 'data:image/png;base64,QUJD' }],
      },
      gatewayClient: {
        call: async (method) => {
          calls.push(method);
          if (method === 'image.attach_bytes') return uploadPromise;
          return {};
        },
      },
    });
    const service = createTurnExecutionService(deps);
    const p = service.sendMessage('interrupt while uploading');
    await new Promise((r) => setTimeout(r, 10));

    await service.interruptTurn();
    const contentAfterInt = state.messages.at(-1)?.content;
    releaseUpload({ ok: true });
    await p;

    assert.equal(calls.includes('prompt.submit'), false);
    assert.equal(state.presenceTerminal?.kind, 'interrupted');
    assert.equal(state.messages.at(-1)?.content, contentAfterInt);
  }

  // 6. prompt.submit / truncateAndSubmit 在途时发生 disconnect / interrupt / superseded 隔离保护
  // 6a. disconnect 后迟到 resolve 与 reject 均不得写入状态、缓存或误触发 failSubmittedTurn
  for (const outcome of ['resolve', 'reject']) {
    let resolveRpc;
    let rejectRpc;
    const rpcPromise = new Promise((resolve, reject) => {
      resolveRpc = resolve;
      rejectRpc = reject;
    });
    let currentClient = {
      call: async (method) => (method === 'prompt.submit' ? rpcPromise : {}),
    };
    const { deps, state } = createMockTurnDeps({
      state: { activeSessionId: 'sess-1' },
    });
    deps.getGatewayClient = () => currentClient;
    const service = createTurnExecutionService(deps);
    const p = service.sendMessage('disc mid rpc');
    await new Promise((r) => setTimeout(r, 10));

    currentClient = null;
    state.presenceTerminal = undefined;
    if (outcome === 'resolve') {
      resolveRpc({ status: 'streaming', user_row_id: 919 });
    } else {
      rejectRpc(new Error('Client disconnected'));
    }
    await p;
    assert.equal(state.presenceTerminal, undefined);
    assert.equal(deps.getSessionMessagesCache().get('sess-1')?.some((m) => m.rowId === 919), false);
  }

  // 6b. interruptTurn() 后 prompt.submit 迟到 reject：不得覆写已中断消息或恢复 rollbackArmed
  {
    let rejectTrunc;
    const truncPromise = new Promise((_res, rej) => {
      rejectTrunc = rej;
    });
    const origSnap = [{ id: 'snap-int', role: 'user', content: 'int orig' }];
    const { deps, state } = createMockTurnDeps({
      state: {
        activeSessionId: 'sess-1',
        rollbackArmed: { sessionId: 'sess-1', anchor: { kind: 'row', rowId: 7 }, snapshot: origSnap },
      },
    });
    deps.getInteractiveService().truncateAndSubmit = () => truncPromise;
    const service = createTurnExecutionService(deps);
    const p = service.sendMessage('interrupt mid truncate');
    await new Promise((r) => setTimeout(r, 10));

    await service.interruptTurn();
    rejectTrunc(new Error('late after interrupt'));
    await p;
    assert.equal(state.presenceTerminal?.kind, 'interrupted');
    assert.notDeepEqual(state.messages, origSnap);
  }

  // 6c. Session B 接管后 Session A prompt.submit 迟到 reject：清理 A 运行态但保留 B 的 activeStreamingContext
  {
    let rejectSup;
    const supPromise = new Promise((_res, rej) => {
      rejectSup = rej;
    });
    const { deps, state } = createMockTurnDeps({
      state: {
        activeSessionId: 'sess-a',
        activeFocus: { type: 'bot', botName: 'bot-a' },
      },
      gatewayClient: {
        call: async () => supPromise,
      },
    });
    const service = createTurnExecutionService(deps);
    const p = service.sendMessage('sup mid rpc reject');
    await new Promise((r) => setTimeout(r, 10));

    state.activeSessionId = 'sess-b';
    deps.setActiveStreamingContext({
      activeStreamingMessageId: 'ast-b2',
      activeStreamingStoredSessionId: 'sess-b',
      activeStreamingLiveId: 'live-b2',
      activeStreamingBotName: 'bot-b',
    });
    rejectSup(new Error('late sup fail'));
    await p;

    assert.equal(deps.getActiveRunningSessionIds().has('sess-a'), false);
    assert.equal(deps.getActiveRunningBotNames().has('bot-a'), false);
    assert.equal(deps.getActiveStreamingContext().activeStreamingMessageId, 'ast-b2');
  }

  // 6d. 提交瞬间锁定 submittedProfileName + session.botName / profileName / 'default' 全回退分支 + empty targetStoredSessionId
  for (const caseSpec of [
    { sessionBot: 'sess-bot', stateProf: 'fallback-prof', expected: 'sess-bot' },
    { sessionBot: '', stateProf: '', expected: 'default' },
  ]) {
    const { deps, state, cacheService } = createMockTurnDeps({
      state: {
        activeSessionId: 'sess-prof',
        profileName: caseSpec.stateProf,
        activeFocus: { type: 'session', sessionId: 'sess-prof' },
        sessions: [{ id: 'sess-prof', title: 'P', botName: caseSpec.sessionBot, preview: '', timestamp: 1 }],
        rollbackArmed: {
          sessionId: 'sess-prof',
          anchor: { kind: 'row', rowId: 20 },
          snapshot: [{ id: 'snap-p', role: 'user', content: 'p' }],
        },
      },
    });
    let releaseTrunc;
    deps.getInteractiveService().truncateAndSubmit = () =>
      new Promise((res) => {
        releaseTrunc = res;
      });
    const service = createTurnExecutionService(deps);
    const p = service.sendMessage('profile lock');
    await new Promise((r) => setTimeout(r, 10));

    // 等待期间外部切走 profileName，cacheService.truncate 仍须收到提交期锁定的 profile
    state.profileName = 'mutated-other-profile';
    releaseTrunc({ status: 'streaming', user_row_id: 300 });
    await p;
    assert.equal(cacheService.truncated[0]?.ref.profile, caseSpec.expected);
  }

  {
    const { deps, state } = createMockTurnDeps({
      state: { activeSessionId: '', profileName: 'prof-no-sess' },
      gatewayClient: { call: async () => ({ status: 'rejected' }) },
    });
    const service = createTurnExecutionService(deps);
    await service.sendMessage('no session id');
    assert.equal(state.isStreaming, false);
  }

  // 7. 同毫秒连续触发两次 sendMessage：单调序列保障 userMsgId / assistantMsgId 严格唯一
  {
    const origNow = Date.now;
    Date.now = () => 1700000000000;
    try {
      const { deps, state } = createMockTurnDeps({
        state: { activeSessionId: 'sess-1' },
      });
      const service = createTurnExecutionService(deps);
      await service.sendMessage('same-ms-1');
      const ctx1 = deps.getActiveStreamingContext().activeStreamingMessageId;
      state.activeSessionId = 'sess-2';
      state.isStreaming = false;
      await service.sendMessage('same-ms-2');
      const ctx2 = deps.getActiveStreamingContext().activeStreamingMessageId;
      assert.notEqual(ctx1, ctx2);
      const usrIds = state.messages.filter((m) => m.id.startsWith('usr-1700000000000-')).map((m) => m.id);
      assert.equal(new Set(usrIds).size, 2);
    } finally {
      Date.now = origNow;
    }
  }

  // 8. 同会话/同 Bot interruptTurn 后立刻重发 Turn 2 -> Turn 1 迟到拒绝对 Turn 2 零污染
  {
    let rejectTurn1;
    let callCount = 0;
    const origSnap1 = [{ id: 'snap-t1', role: 'user', content: 't1 orig' }];
    const { deps, state } = createMockTurnDeps({
      state: {
        activeSessionId: 'sess-same',
        activeFocus: { type: 'bot', botName: 'bot-same' },
        rollbackArmed: { sessionId: 'sess-same', anchor: { kind: 'row', rowId: 9 }, snapshot: origSnap1 },
      },
    });
    deps.getInteractiveService().truncateAndSubmit = () => {
      callCount += 1;
      if (callCount === 1) {
        return new Promise((_res, rej) => {
          rejectTurn1 = rej;
        });
      }
      return Promise.resolve({ status: 'streaming', user_row_id: 202 });
    };
    const service = createTurnExecutionService(deps);
    const p1 = service.sendMessage('turn 1');
    await new Promise((r) => setTimeout(r, 10));

    await service.interruptTurn();
    await service.sendMessage('turn 2');
    const turn2CtxId = deps.getActiveStreamingContext().activeStreamingMessageId;
    const msgsBeforeReject = [...state.messages];

    rejectTurn1(new Error('late t1 reject'));
    await p1;

    assert.equal(deps.getActiveRunningSessionIds().has('sess-same'), true, 'Turn 1 不得清除 Turn 2 运行态');
    assert.equal(deps.getActiveRunningBotNames().has('bot-same'), true);
    assert.equal(deps.getActiveStreamingContext().activeStreamingMessageId, turn2CtxId);
    assert.deepEqual(state.messages, msgsBeforeReject);
  }

  // 9. 同会话看门狗超时释放归属后立刻重发 Turn 2 -> Turn 1 迟到拒绝对 Turn 2 零污染
  {
    let rejectTurn1;
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
    const service = createTurnExecutionService(deps);
    const p1 = service.sendMessage('wd turn 1');
    await new Promise((r) => setTimeout(r, 60)); // 看门狗超时并释放 ownership

    await service.sendMessage('wd turn 2');
    const turn2CtxId = deps.getActiveStreamingContext().activeStreamingMessageId;
    rejectTurn1(new Error('late after watchdog'));
    await p1;

    assert.equal(deps.getActiveRunningSessionIds().has('sess-wd'), true);
    assert.equal(deps.getActiveRunningBotNames().has('bot-wd'), true);
    assert.equal(deps.getActiveStreamingContext().activeStreamingMessageId, turn2CtxId);
    service.disarmTurnWatchdog();
  }

  // 10. truncateAndSubmit 返回 rejected 状态时严禁调用 cacheService.truncate 或写入 trust，须完整回滚状态
  {
    const origSnap = [{ id: 'snap-rej', role: 'user', content: 'rej orig' }];
    const { deps, state, cacheService } = createMockTurnDeps({
      state: {
        activeSessionId: 'sess-rej-trunc',
        hasOlderMessages: true,
        rollbackArmed: { sessionId: 'sess-rej-trunc', anchor: { kind: 'row', rowId: 30 }, snapshot: origSnap },
      },
    });
    deps.getInteractiveService().truncateAndSubmit = async () => ({ status: 'rejected', user_row_id: 404 });
    const service = createTurnExecutionService(deps);
    await service.sendMessage('rejected truncate');

    assert.equal(cacheService.truncated.length, 0, 'rejected 状态绝不能持久化截断 cacheService');
    assert.equal(deps.getSessionHistoryTrust().has('sess-rej-trunc'), false);
    assert.equal(state.hasOlderMessages, true);
    assert.deepEqual(state.messages, origSnap);
  }

  // 11. ensureLiveSessionId 途中断连/换网关 -> 安全早退；多文件上传期间 profile 锁定与空 profile 透传 undefined
  {
    let releaseLive;
    let currentClient = { call: async () => ({ status: 'streaming' }) };
    const { deps, state } = createMockTurnDeps({
      state: { activeSessionId: 'sess-live-disc', messages: [] },
    });
    deps.getGatewayClient = () => currentClient;
    deps.ensureLiveSessionId = () =>
      new Promise((res) => {
        releaseLive = res;
      });
    const service = createTurnExecutionService(deps);
    const p = service.sendMessage('abort during ensureLive');
    await new Promise((r) => setTimeout(r, 10));
    currentClient = null;
    releaseLive('live-x');
    await p;
    assert.equal(state.isStreaming, false);
    assert.equal(state.messages.length, 0);
  }

  for (const profSpec of [
    { initialProfile: 'frozen-prof', expectedProfile: 'frozen-prof' },
    { initialProfile: '', expectedProfile: undefined },
  ]) {
    const fileAttachProfiles = [];
    let releaseFirstAttach;
    let attachCount = 0;
    const { deps, state } = createMockTurnDeps({
      state: {
        activeSessionId: 'sess-fa',
        profileName: profSpec.initialProfile,
        sessions: [{ id: 'sess-fa', title: 'FA', botName: '', preview: '', timestamp: 1 }],
        attachments: [
          { id: 'f1', name: 'a.txt', type: 'file', contentBase64: 'YQ==' },
          { id: 'f2', name: 'b.txt', type: 'file', contentBase64: 'Yg==' },
        ],
      },
      gatewayClient: {
        call: async (method, params) => {
          if (method === 'file.attach') {
            fileAttachProfiles.push(params.profile);
            attachCount += 1;
            if (attachCount === 1) {
              return new Promise((res) => {
                releaseFirstAttach = res;
              });
            }
          }
          return { status: 'streaming' };
        },
      },
    });
    const service = createTurnExecutionService(deps);
    const p = service.sendMessage('multi file profile');
    await new Promise((r) => setTimeout(r, 10));
    state.profileName = 'drifted-later';
    releaseFirstAttach({ ok: true });
    await p;
    assert.deepEqual(fileAttachProfiles, [profSpec.expectedProfile, profSpec.expectedProfile]);
  }
});


test('D5: turnExecutionService - sendMessage 截断失败时原子恢复快照', async () => {
  const { deps, state, interactiveService } = createMockTurnDeps({
    state: {
      rollbackArmed: {
        sessionId: 'sess-1',
        anchor: { kind: 'row', rowId: 10 },
        snapshot: [
          { id: 'snap-1', role: 'user', content: '原提问' },
          { id: 'snap-2', role: 'assistant', content: '原回答' },
        ],
      },
    },
  });
  interactiveService.truncateAndSubmit = async () => {
    throw new Error('截断失败 502');
  };

  const service = createTurnExecutionService(deps);
  await service.sendMessage('重试发言');

  assert.equal(state.isStreaming, false);
  assert.equal(state.presenceTerminal?.kind, 'failed');
  assert.equal(state.messages.length, 2, '截断失败必须原子恢复快照，杜绝静默丢消息');
  assert.equal(state.messages[0].content, '原提问');
});

test('D5: turnExecutionService - interruptTurn 捕获前置贴底、清理工具补丁与运行中工具态、重置时长锚点且仅单次 render', async () => {
  let nearBottom = true;
  const pendingScrollCalls = [];
  let clearToolPatchCalls = 0;
  let stopToolTimerCalls = 0;
  const { deps, state, rendered, activeStreamingContext } = createMockTurnDeps({
    state: {
      isStreaming: true,
      turnStartedAt: Date.now() - 5000,
      messages: [
        {
          id: 'ast-1',
          role: 'assistant',
          content: '生成中内容',
          toolCalls: [{ id: 'tc-run', name: 'run_cmd', status: 'running', args: '{}', startTime: Date.now() - 1200 }],
        },
      ],
    },
    activeStreamingContext: {
      activeStreamingMessageId: 'ast-1',
      activeStreamingStoredSessionId: 'sess-1',
      activeStreamingLiveId: 'live-1',
    },
  });
  deps.setTurnStartedSessionId('sess-1');
  deps.isStreamNearBottom = () => nearBottom;
  deps.setPendingScrollToBottom = (val) => pendingScrollCalls.push(val);
  deps.clearToolPatchQueue = () => { clearToolPatchCalls += 1; };
  deps.stopRunningToolTimers = () => { stopToolTimerCalls += 1; };
  // 模拟 flush / setMessageContent 撑高容器后 isStreamNearBottom 翻转 false
  const origSetContent = deps.setMessageContent;
  deps.setMessageContent = (mid, content) => {
    nearBottom = false;
    origSetContent(mid, content);
  };

  const service = createTurnExecutionService(deps);
  await service.interruptTurn();

  assert.deepEqual(pendingScrollCalls, [true], 'interruptTurn 必须在 flush/setMessageContent 改写 DOM 前捕获贴底意图');
  assert.equal(clearToolPatchCalls, 1, 'interruptTurn 必须清空 toolPatchQueue');
  assert.equal(stopToolTimerCalls, 1, 'interruptTurn 必须停止运行中工具计时器');
  assert.equal(state.messages[0].toolCalls[0].status, 'completed', '中断后运行中工具必须收敛为 completed，停止 spinner 空转');
  assert.ok(state.messages[0].toolCalls[0].durationMs >= 100, '收敛工具必须冻结耗时');
  assert.equal(state.turnStartedAt, undefined, '中断后必须清空 turnStartedAt');
  assert.equal(deps.getTurnStartedSessionId(), null, '中断后必须清空 turnStartedSessionId');
  assert.equal(rendered.length, 1, 'interruptTurn 必须仅触发唯一一次 render()（消除 setTimedDockNotice 后重复 render）');
  assert.equal(activeStreamingContext().activeStreamingMessageId, null);

  // 非贴底时中断不得强行拉回底部
  nearBottom = false;
  pendingScrollCalls.length = 0;
  state.isStreaming = true;
  deps.setActiveStreamingContext({
    activeStreamingMessageId: 'ast-1',
    activeStreamingStoredSessionId: 'sess-1',
    activeStreamingLiveId: 'live-1',
  });
  await service.interruptTurn();
  assert.deepEqual(pendingScrollCalls, [], '用户已上滚回看时中断不得强行置底');
});

test('D4-watchdog: turnExecutionService - 看门狗超时在 flush 前捕获贴底意图并清理工具补丁与计时器', async () => {
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

  const service = createTurnExecutionService(deps);
  service.armTurnWatchdog();
  await new Promise((resolve) => setTimeout(resolve, 60));

  assert.equal(state.isStreaming, false);
  assert.deepEqual(pendingScrollCalls, [true], '看门狗超时必须在 flush 前捕获贴底意图');
  assert.equal(clearToolPatchCalls, 1, '看门狗超时必须清空 toolPatchQueue');
  assert.equal(stopToolTimerCalls, 1, '看门狗超时必须停止运行中工具计时器');
});

test('D5: turnExecutionService - setTimedDockNotice skipRender 选项与 interruptTurn 独立缓存运行中工具收敛', async () => {
  const { deps, state, rendered } = createMockTurnDeps({
    state: {
      isStreaming: true,
      messages: [
        {
          id: 'ast-1',
          role: 'assistant',
          content: 'live',
          toolCalls: [{ id: 'tc-1', name: 'shell', status: 'running', args: '{}', startTime: Date.now() - 500 }],
        },
      ],
    },
    activeStreamingContext: {
      activeStreamingMessageId: 'ast-1',
      activeStreamingStoredSessionId: 'sess-1',
      activeStreamingLiveId: 'live-1',
    },
  });

  // 独立缓存数组（引用不同于 state.messages），用于覆盖 interruptTurn 同步收敛缓存副本路径
  const separateCachedMsgs = [
    {
      id: 'ast-1',
      role: 'assistant',
      content: 'live',
      toolCalls: [{ id: 'tc-1', name: 'shell', status: 'running', args: '{}', startTime: Date.now() - 500 }],
    },
  ];
  deps.getSessionMessagesCache().set('sess-1', separateCachedMsgs);

  const service = createTurnExecutionService(deps);

  // 1. setTimedDockNotice({ skipRender: true }) 只写文案不触发额外 render
  service.setTimedDockNotice('quiet notice', 0, { skipRender: true });
  assert.equal(state.dockNotice, 'quiet notice');
  assert.equal(rendered.length, 0, 'skipRender: true 不得触发同步 render()');

  // 2. interruptTurn 同时收敛 state.messages 与独立缓存数组里的 running toolCalls
  await service.interruptTurn();
  assert.equal(state.messages[0].toolCalls[0].status, 'completed');
  assert.equal(separateCachedMsgs[0].toolCalls[0].status, 'completed', '独立缓存副本中的运行中工具也必须收敛');
  assert.equal(rendered.length, 1);

  // 3. 当 sessionMessagesCache 无对应桶时（cached === undefined），interruptTurn 必须安全完成而不抛错
  deps.getSessionMessagesCache().delete('sess-1');
  deps.setActiveStreamingContext({
    activeStreamingMessageId: 'ast-1',
    activeStreamingStoredSessionId: 'sess-1',
    activeStreamingLiveId: 'live-1',
  });
  state.isStreaming = true;
  state.messages[0].toolCalls[0].status = 'running';
  await service.interruptTurn();
  assert.equal(state.messages[0].toolCalls[0].status, 'completed');
});

test('D5: turnExecutionService - 看门狗超时/定时通知/中断收口变异杀伤（后台缓存、空正文、工具耗时、群聊与实体清理）', async () => {
  // 1. setTimedDockNotice：定时自动消失、覆盖新通知不误清、二次调用取消旧定时、durationMs=0 不定时
  {
    const { deps, state, rendered } = createMockTurnDeps();
    const service = createTurnExecutionService(deps);

    service.setTimedDockNotice('first-notice', 25);
    assert.equal(state.dockNotice, 'first-notice');
    assert.equal(rendered.length, 1);

    // 二次调用替换旧定时，并改写为 40ms
    service.setTimedDockNotice('second-notice', 40);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(state.dockNotice, 'second-notice', '旧定时器必须已被清除，不得误清 second-notice');

    await new Promise((r) => setTimeout(r, 30));
    assert.equal(state.dockNotice, '', '到期后必须清空 dockNotice');
    assert.ok(rendered.length >= 3, '到期清空后必须触发 render()');

    // 若定时期间外部改写了 dockNotice，旧定时触发时不得误清
    const rendersBefore = rendered.length;
    service.setTimedDockNotice('temp-a', 20);
    state.dockNotice = 'external-override';
    await new Promise((r) => setTimeout(r, 35));
    assert.equal(state.dockNotice, 'external-override', '已被外部覆写的 dockNotice 不得被旧定时器清空');
    assert.equal(rendered.length, rendersBefore + 1);

    // 空文案与 durationMs === 0 不排定时
    service.setTimedDockNotice('', 20);
    service.setTimedDockNotice('sticky', 0);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(state.dockNotice, 'sticky');
  }

  // 2. handleWatchdogTimeout：未注入 isStreamNearBottom / 后台会话不得置底，且必须 flush/清空实体/tracker/context
  {
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
    deps.getTokenCoalescer = () => ({ enqueue: () => {}, flush: () => flushCalls.push(1) });
    deps.setPendingScrollToBottom = (v) => pendingCalls.push(v);
    deps.setTurnStartedSessionId = (id) => turnStartedCalls.push(id);
    deps.getActivityTransitionTracker = () => ({ clear: (k, id) => trackerClears.push([k, id]) });
    deps.isStreamNearBottom = undefined;
    deps.getActiveRunningSessionIds().add('sess-bg');
    deps.getActiveRunningBotNames().add('bot-a');

    const service = createTurnExecutionService(deps);
    service.armTurnWatchdog();
    await new Promise((r) => setTimeout(r, 55));

    assert.equal(flushCalls.length, 1);
    assert.deepEqual(pendingCalls, [], '后台会话或未注入 isStreamNearBottom 时不得触发置底');
    assert.equal(deps.getActiveRunningSessionIds().has('sess-bg'), false);
    assert.equal(deps.getActiveRunningBotNames().has('bot-a'), false);
    assert.deepEqual(trackerClears, [['session', 'sess-bg'], ['bot', 'bot-a']]);
    assert.deepEqual(turnStartedCalls, [null]);
    assert.equal(deps.getActiveStreamingContext().activeStreamingMessageId, null);
    assert.equal(deps.getActiveStreamingContext().activeStreamingBotName, null);
    assert.equal(rendered.length, 1);
  }

  // 3. interruptTurn：当前空正文回填 interruptedEmpty、后台缓存非空/空正文、工具耗时兜底、群聊中断与实体清理
  {
    const flushCalls = [];
    const setContentCalls = [];
    const trackerClears = [];
    const pendingCalls = [];
    const { deps, state } = createMockTurnDeps({
      state: {
        isStreaming: true,
        activeSessionId: 'sess-1',
        messages: [
          {
            id: 'ast-empty',
            role: 'assistant',
            content: '',
            toolCalls: [
              { id: 't-fast', name: 'f', status: 'running', startTime: Date.now() - 5 },
              { id: 't-slow', name: 's', status: 'running', startTime: Date.now() - 400 },
              { id: 't-keep', name: 'k', status: 'running', startTime: Date.now() - 400, durationMs: 222 },
              { id: 't-err', name: 'e', status: 'failed', startTime: Date.now() - 400 },
            ],
          },
        ],
      },
      activeStreamingContext: {
        activeStreamingMessageId: 'ast-empty',
        activeStreamingStoredSessionId: 'sess-1',
        activeStreamingLiveId: 'live-1',
        activeStreamingBotName: 'bot-1',
      },
    });
    deps.getTokenCoalescer = () => ({ enqueue: () => {}, flush: () => flushCalls.push(1) });
    deps.setMessageContent = (id, c) => setContentCalls.push([id, c]);
    deps.getActivityTransitionTracker = () => ({ clear: (k, id) => trackerClears.push([k, id]) });
    deps.setPendingScrollToBottom = (v) => pendingCalls.push(v);
    deps.isStreamNearBottom = undefined;
    deps.getActiveRunningSessionIds().add('sess-1');
    deps.getActiveRunningBotNames().add('bot-1');

    const service = createTurnExecutionService(deps);
    await service.interruptTurn();

    assert.equal(flushCalls.length, 1);
    assert.equal(state.messages[0].content, deps.t('chat.interruptedEmpty'));
    assert.deepEqual(setContentCalls, [['ast-empty', deps.t('chat.interruptedEmpty')]]);
    assert.deepEqual(pendingCalls, [], '未注入 isStreamNearBottom 时默认 false');
    assert.equal(state.messages[0].toolCalls[0].durationMs, 100);
    assert.ok(state.messages[0].toolCalls[1].durationMs >= 300);
    assert.equal(state.messages[0].toolCalls[2].durationMs, 222);
    assert.equal(state.messages[0].toolCalls[3].status, 'failed');
    assert.equal(deps.getActiveRunningSessionIds().has('sess-1'), false);
    assert.equal(deps.getActiveRunningBotNames().has('bot-1'), false);
    assert.deepEqual(trackerClears, [['session', 'sess-1'], ['bot', 'bot-1']]);

    // 后台会话中断：命中非空与空缓存消息
    const bgMsgs = [
      { id: 'other', role: 'user', content: 'u' },
      { id: 'bg-1', role: 'assistant', content: 'partial' },
      { id: 'bg-empty', role: 'assistant', content: '' },
    ];
    deps.getSessionMessagesCache().set('sess-bg', bgMsgs);
    deps.setActiveStreamingContext({
      activeStreamingMessageId: 'bg-1',
      activeStreamingStoredSessionId: 'sess-bg',
      activeStreamingLiveId: 'live-bg',
      activeStreamingBotName: null,
    });
    await service.interruptTurn();
    assert.equal(bgMsgs[0].content, 'u');
    assert.equal(bgMsgs[1].content, `partial${deps.t('chat.interruptedSuffix')}`);

    deps.setActiveStreamingContext({
      activeStreamingMessageId: 'bg-empty',
      activeStreamingStoredSessionId: 'sess-bg',
      activeStreamingLiveId: 'live-bg',
      activeStreamingBotName: null,
    });
    await service.interruptTurn();
    assert.equal(bgMsgs[2].content, deps.t('chat.interruptedEmpty'));

    // 群聊聚焦中断：无 sessionId/botName，清理 activeRunningGroupRoomIds 与 tracker('group', roomId)
    trackerClears.length = 0;
    state.activeFocus = { type: 'group', roomId: 'room-1' };
    deps.getActiveRunningGroupRoomIds().add('room-1');
    deps.setActiveStreamingContext({
      activeStreamingMessageId: null,
      activeStreamingStoredSessionId: null,
      activeStreamingLiveId: null,
      activeStreamingBotName: null,
    });
    await service.interruptTurn();
    assert.equal(deps.getActiveRunningGroupRoomIds().has('room-1'), false);
    assert.deepEqual(trackerClears, [['group', 'room-1']]);
  }
});

test('纯附件发送、普通文件 file.attach 上传、图片与文件错误降级及群聊附件送达', async () => {
    const { deps, state, rpcCalls } = createMockTurnDeps({
      gatewayClient: {
        call: async (method, params) => {
          rpcCalls.push({ method, params });
          if (method === 'image.attach_bytes' || method === 'file.attach') {
            throw new Error(`${method} rejected`);
          }
          if (method === 'prompt.submit') {
            return { status: 'streaming', user_row_id: 99 };
          }
          return {};
        },
      },
      state: {
        activeFocus: { type: 'bot', botName: 'default' },
        attachments: [
          {
            id: 'att-img',
            name: 'shot.png',
            type: 'image',
            previewUrl: 'data:image/png;base64,QUJD',
            sizeBytes: 120,
          },
          {
            id: 'att-doc',
            name: 'spec.md',
            type: 'file',
            contentBase64: 'IyBTcGVj',
            sizeBytes: 64,
          },
          {
            id: 'att-pdf',
            name: 'report.pdf',
            type: 'pdf',
            contentBase64: 'data:application/pdf;base64,JVBERg==',
            sizeBytes: 256,
          },
        ],
      },
    });
    const service = createTurnExecutionService(deps);

    // 0. 空文本且无附件直接返回不入队也不报错
    state.attachments = [];
    await service.sendMessage('   ');
    assert.equal(rpcCalls.length, 0);

    // 0b. 注入 logStream 验证 warn/info 分支与后续无 logStream 降级
    deps.logStream = { info() {}, warn() {} };
    state.attachments = [
      { id: 'log-img', name: 'log.png', type: 'image', previewUrl: 'data:image/png;base64,QQ', sizeBytes: 10 },
      { id: 'log-doc', name: 'log.txt', type: 'file', contentBase64: 'QQ', sizeBytes: 10 },
    ];
    await service.sendMessage('with log');
    deps.logStream = undefined;
    rpcCalls.length = 0;
    state.isStreaming = false;
    state.attachments = [
      {
        id: 'att-img',
        name: 'shot.png',
        type: 'image',
        previewUrl: 'data:image/png;base64,QUJD',
        sizeBytes: 120,
      },
      {
        id: 'att-doc',
        name: 'spec.md',
        type: 'file',
        contentBase64: 'IyBTcGVj',
        sizeBytes: 64,
      },
      {
        id: 'att-pdf',
        name: 'report.pdf',
        type: 'pdf',
        contentBase64: 'data:application/pdf;base64,JVBERg==',
        sizeBytes: 256,
      },
    ];
    await service.sendMessage('   ');
    assert.equal(state.attachments.length, 0);
    const pushedUser = state.messages.find((m) => m.role === 'user' && m.attachments?.length === 3);
    assert.ok(pushedUser, '纯附件发送必须保留 userMsg.attachments');
    assert.equal(pushedUser.content, '');
    assert.equal(state.sessions[0].preview, 'shot.png, spec.md, report.pdf');
    assert.equal(rpcCalls.find((c) => c.method === 'image.attach_bytes')?.params.filename, 'shot.png');
    const fileCalls = rpcCalls.filter((c) => c.method === 'file.attach');
    assert.equal(fileCalls.length, 2);
    assert.equal(fileCalls[0].params.data_url, 'data:application/octet-stream;base64,IyBTcGVj');
    assert.equal(fileCalls[1].params.data_url, 'data:application/pdf;base64,JVBERg==');
    assert.ok(
      rpcCalls.find((c) => c.method === 'prompt.submit')?.params.text.includes('- Image 1: shot.png'),
      '发送网关的正文必须含标准附件清单',
    );

    // 2. 群聊模式：纯附件送达 + 空发送阻断 + 文本+附件混合送达
    state.isStreaming = false;
    state.activeFocus = { type: 'group', roomId: 'room-1' };
    state.attachments = [];
    await service.sendGroupMessage('room-1', '   ');

    state.attachments = [
      { id: 'grp-att-1', name: 'diagram.png', type: 'image', previewUrl: 'data:image/png;base64,XYZ', sizeBytes: 42 },
    ];
    await service.sendMessage('   ');
    const grpAttachMsg = state.messages[state.messages.length - 1];
    assert.equal(grpAttachMsg.role, 'user');
    assert.equal(grpAttachMsg.content, '');
    assert.equal(grpAttachMsg.attachments?.[0]?.name, 'diagram.png');
    assert.equal(state.groupRooms[0].lastMessage, 'diagram.png');

    state.attachments = [];
    await service.sendGroupMessage('room-1', 'hello group');
    const grpTextMsg = state.messages[state.messages.length - 1];
    assert.equal(grpTextMsg.role, 'user');
    assert.equal(grpTextMsg.content, 'hello group');
    assert.equal(grpTextMsg.attachments, undefined);
    assert.equal(state.groupRooms[0].lastMessage, 'hello group');
    service.getGroupPollerManager().stopAll();
});

test('TurnExecutionService: 看门狗先探活续期、离线容错延后收口及多端并发 queued/steered 提交竞态处理', async (t) => {
  await t.test('watchdog 过期时网关仍 running=true 必须续期并调用 onWatchdogTurnStillRunning，不误杀也不弹超时横幅', async () => {
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

    const svc = createTurnExecutionService(deps);
    svc.armTurnWatchdog();
    await new Promise((r) => setTimeout(r, 70));
    svc.disarmTurnWatchdog();

    assert.ok(resumeProbeCount >= 1, '看门狗到期必须发起 session.resume 权威探活');
    assert.equal(stillRunningCalls.length >= 1, true);
    assert.equal(state.isStreaming, true, '网关仍在运行时绝不可误杀 isStreaming');
    assert.equal(state.dockNotice, '', '权威续期期间绝不可弹出超时提示');
  });

  await t.test('watchdog 离线断网态首次超时走 defer-offline 延后，超限后安全收敛', async () => {
    const { deps, state } = createMockTurnDeps();
    deps.watchdogIdleTimeoutMs = 20;
    state.gatewayConnected = false;
    state.isStreaming = true;
    deps.setActiveStreamingContext({
      activeStreamingMessageId: 'ast-off',
      activeStreamingStoredSessionId: 'sess-1',
      activeStreamingLiveId: 'live-1',
    });

    const svc = createTurnExecutionService(deps);
    svc.armTurnWatchdog();
    // 第一次到期（20ms）应走 defer-offline，不会在单轮超时立刻收口
    await new Promise((r) => setTimeout(r, 30));
    // 等待连续容忍次数耗尽后终态安全收敛
    await new Promise((r) => setTimeout(r, 90));
    svc.disarmTurnWatchdog();

    assert.equal(state.isStreaming, false, '离线多次超限后必须安全终止并释放输入锁定');
    assert.equal(state.dockNotice, 'chat.watchdogTimeoutNotice');
  });

  await t.test('并发提交收到 queued / steered 时撤下本地空助手占位泡并触发远端对账，queued 将用户消息转入队列胶囊', async () => {
    const raceCallbacks = [];
    let mode = 'queued';
    const raceClient = {
      call: async (method) => {
        if (method === 'prompt.submit') {
          if (mode === 'queued') return { status: 'queued', admission_id: 'adm-race-1' };
          return { status: 'steered', user_row_id: 77 };
        }
        return {};
      },
    };
    const { deps, state } = createMockTurnDeps({ gatewayClient: raceClient });
    deps.onQueuedSubmitRace = (sid) => raceCallbacks.push(sid);
    state.messages = [];
    state.queuedMessages = [];

    const svc = createTurnExecutionService(deps);
    await svc.sendMessage('desktop prompt');
    assert.equal(state.messages.length, 0, 'queued 竞态必须同时撤下本地用户泡与空助手泡');
    assert.deepEqual(state.queuedMessages, [{ id: 'adm-race-1', admissionId: 'adm-race-1', text: 'desktop prompt' }]);
    assert.deepEqual(raceCallbacks, ['sess-1']);

    mode = 'steered';
    await svc.sendMessage('steer msg');
    assert.equal(state.messages.filter((m) => m.role === 'user').length, 1, 'steered 竞态保留已绑定 rowId 的用户泡');
    assert.equal(state.messages.filter((m) => m.role === 'assistant').length, 0, 'steered 竞态必须撤下本地空助手占位泡');
    assert.deepEqual(raceCallbacks, ['sess-1', 'sess-1']);
  });
});


test('TurnExecutionService: 多流最老流探活收敛、探活异常重试、hard-limit 熔断与 ForeverChat 并发排队收口', async () => {
  const { LiveStreamRegistry } = await import('@hermes-flux/core');
  const reg = new LiveStreamRegistry();
  const runningBots = new Set(['arch-bot']);
  const runningSessions = new Set(['sess-old', 'sess-new']);
  const refreshed = [];
  const stillRunningCalls = [];
  const queuedRaceCalls = [];
  let resumeBehavior = 'old-finished';
  let throwCount = 0;

  const { deps, state } = createMockTurnDeps({
    state: {
      activeSessionId: 'sess-old',
      activeLiveSessionId: 'live-old',
      activeFocus: { type: 'bot', botName: 'arch-bot' },
      sessions: [
        { id: 'sess-old', title: 'Old', botName: 'arch-bot' },
        { id: 'sess-new', title: 'New', botName: 'default' },
      ],
      isStreaming: true,
    },
    gatewayClient: {
      call: async (method, params) => {
        if (method === 'session.resume') {
          if (resumeBehavior === 'throw') {
            throwCount += 1;
            throw new Error('probe rpc timeout');
          }
          if (params.session_id === 'sess-old' && resumeBehavior === 'old-finished') {
            return { running: false };
          }
          if (params.session_id === 'sess-new' && resumeBehavior === 'old-finished') {
            return { running: true, inflight: { streaming: true } };
          }
          if (resumeBehavior === 'running') {
            return { running: true, inflight: { streaming: true, assistant: 'still active' } };
          }
          return { running: false };
        }
        if (method === 'prompt.submit') {
          return { status: 'redirected', session_id: 'sess-old' };
        }
        return {};
      },
    },
  });

  // 注册两个并发流：sess-old 最久未活跃，sess-new 较新
  reg.registerStream({
    storedSessionId: 'sess-old',
    liveSessionId: 'live-old',
    messageId: 'ast-old',
    botName: 'arch-bot',
    origin: 'local',
    nowMs: 1000,
  });
  reg.registerStream({
    storedSessionId: 'sess-new',
    liveSessionId: 'live-new',
    messageId: 'ast-new',
    origin: 'remote',
    nowMs: 5000,
  });

  deps.getLiveStreamRegistry = () => reg;
  deps.resolveBotNameForSession = (sid) => (sid === 'sess-old' ? 'arch-bot' : null);
  deps.getActiveRunningBotNames = () => runningBots;
  deps.getActiveRunningSessionIds = () => runningSessions;
  deps.onWatchdogTurnCompleted = async (sid) => { refreshed.push(sid); };
  deps.onWatchdogTurnStillRunning = (sid, res) => { stillRunningCalls.push({ sid, running: Boolean(res?.running) }); };
  deps.onQueuedSubmitRace = (sid) => { queuedRaceCalls.push(sid); };
  deps.watchdogIdleTimeoutMs = 45;
  deps.watchdogHardLimitMs = 2_000;

  const svc = createTurnExecutionService(deps);
  const waitUntil = async (cond, timeoutMs = 800) => {
    const start = Date.now();
    while (!cond()) {
      if (Date.now() - start > timeoutMs) {
        throw new Error('waitUntil timeout exceeded');
      }
      await new Promise((r) => setTimeout(r, 10));
    }
  };

  try {
    // 1. inactivity 超时必须挑选最久未活跃的 sess-old 探活并单独收敛，保留 sess-new 并续期看门狗
    svc.armTurnWatchdog();
    await waitUntil(() => !reg.hasSession('sess-old'));
    assert.equal(reg.hasSession('sess-old'), false, '超时已结束的 sess-old 必须移除');
    assert.equal(reg.hasSession('sess-new'), true, '较新的 sess-new 并发流不得被误杀');
    assert.equal(runningBots.has('arch-bot'), false, 'ForeverChat 唯一流收敛后必须清理 runningBotName');
    assert.equal(refreshed.length >= 1, true);

    // 2. 探活抛错第 1 次容错续期，第 2 次达到 maxProbeFailures 后强制收敛；hard-limit 直接收敛
    resumeBehavior = 'throw';
    throwCount = 0;
    state.isStreaming = true;
    await waitUntil(() => throwCount >= 1);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(reg.hasSession('sess-new'), true, '首次探活异常必须先容错续期不立即丢流');
    await waitUntil(() => !reg.hasSession('sess-new'));
    assert.equal(throwCount >= 2, true);
    assert.equal(reg.hasSession('sess-new'), false, '连续探活失败超限必须安全收敛');

    // 验证 sess-old 收口后曾对仍在运行的 sess-new 触发 2 参 onWatchdogTurnStillRunning
    // （当 waitUntil 期间恰好再次探活 sess-new 时会有记录；下面显式断言 running=true 回调契约）
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
    await waitUntil(() => stillRunningCalls.length >= 1);
    assert.deepEqual(stillRunningCalls[0], { sid: 'sess-new', running: true });
    reg.removeSession('sess-new');
    svc.disarmTurnWatchdog();

    // hard-limit 直接终止
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
      await waitUntil(() => !reg.hasSession('sess-new'));
      assert.equal(reg.hasSession('sess-new'), false);
      assert.equal(state.isStreaming, false);
    } finally {
      hardSvc.disarmTurnWatchdog();
    }

    // 3. ForeverChat prompt.submit 收到 redirected 时撤下空占位泡并触发 onQueuedSubmitRace
    state.activeSessionId = 'sess-old';
    state.activeLiveSessionId = 'live-old';
    state.isStreaming = false;
    await svc.sendMessage('并发重定向测试');
    assert.deepEqual(queuedRaceCalls, ['sess-old']);
    assert.equal(state.messages.some((m) => m.role === 'assistant' && m.content === ''), false);
  } finally {
    svc.disarmTurnWatchdog();
  }
});


test('Stage4 修复回归: 隐藏 ForeverChat 后台 profile 探活 + Extra inputs 回退 + 提交失败不撤防并发流看门狗 + 群聊/空闲前缀隔离', async () => {
  const { LiveStreamRegistry } = await import('@hermes-flux/core');
  const reg = new LiveStreamRegistry();
  const resumeCalls = [];
  let submitBehavior = 'reject';
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
        if (method === 'prompt.submit') {
          if (submitBehavior === 'reject') {
            throw new Error('submit network boom');
          }
          return { status: 'streaming' };
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

  const svc = createTurnExecutionService(deps);
  try {
    // 1. 先激活 sess-hidden 的看门狗，再在 sess-other 触发 prompt.submit 失败（failSubmittedTurn）；
    //    因 reg 中仍有并发后台 sess-hidden，failSubmittedTurn 绝不得撤防看门狗——不重新 arm 也能在 25ms 后自然触发探活！
    state.dockNotice = '';
    svc.armTurnWatchdog();
    state.activeSessionId = 'sess-other';
    await svc.sendMessage('will fail');
    assert.equal(reg.hasSession('sess-hidden'), true, 'sess-other 提交失败绝不得清除 sess-hidden');

    // 2. 不重新 arm 看门狗，等待原看门狗自然超时并探活：必须读取 streamEntry.botName ('arch-bot')，
    //    并在两次 Extra inputs 后回退为裸 { session_id } 成功收口；同时绝不得把 timeoutNotice 泄露到前景 sess-other
    const deadline = Date.now() + 800;
    while (reg.hasSession('sess-hidden') && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
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
    const deadline2 = Date.now() + 800;
    while (reg.hasSession('sess-bg-group') && Date.now() < deadline2) {
      await new Promise((r) => setTimeout(r, 10));
    }
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
    const deadline3 = Date.now() + 800;
    while (reg.hasSession('sess-hidden-nullbot') && Date.now() < deadline3) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(reg.hasSession('sess-hidden-nullbot'), false);
    assert.deepEqual(resumeCalls[0], { session_id: 'sess-hidden-nullbot', profile: 'arch-bot-resolved', omit_messages: true });
    assert.equal(runningBots.has('arch-bot-resolved'), false, 'resolveBotNameForSession 解析出的 Bot 活跃态必须在超时收口时摘除');
  } finally {
    svc.disarmTurnWatchdog();
  }
});

test('TurnExecutionService: 看门狗 hard-limit/空目标/stale probe/feedTurnWatchdog(expired)/queued 缺省字段与 isStreamingActiveForCurrentSession', async () => {
  const { LiveStreamRegistry } = await import('@hermes-flux/core');
  const reg = new LiveStreamRegistry();
  let resumeHandler = async () => ({ running: false });
  const resumeCalls = [];
  let submitResponse = { status: 'queued', text: 'q' };

  const { deps, state } = createMockTurnDeps({
    gatewayClient: {
      call: async (method, params) => {
        if (method === 'session.resume') {
          resumeCalls.push(params);
          return resumeHandler(params);
        }
        if (method === 'prompt.submit') {
          return submitResponse;
        }
        return {};
      },
    },
  });
  deps.watchdogIdleTimeoutMs = 650;
  deps.watchdogHardLimitMs = 760;
  deps.getLiveStreamRegistry = () => reg;

  // 1. hard-limit 触发直接调用 settleWatchdogTimeout (L414-416)：越过 throttleMs(500) 后 feed 推迟 idleTimer 到 hardLimitMs(760) 之后
  const svcHard = createTurnExecutionService(deps);
  try {
    reg.registerStream({ storedSessionId: 'sess-1', liveSessionId: 'live-1', messageId: 'm-1', origin: 'local' });
    state.isStreaming = true;
    svcHard.armTurnWatchdog();
    await new Promise((r) => setTimeout(r, 540));
    svcHard.feedTurnWatchdog();
    await new Promise((r) => setTimeout(r, 270));
    assert.equal(reg.hasSession('sess-1'), false, 'hard-limit 必须直接熔断收敛');
    assert.equal(resumeCalls.length, 0, 'hard-limit 不可再发探活');
    assert.equal(state.dockNotice, 'chat.watchdogTimeoutNotice');
  } finally {
    svcHard.disarmTurnWatchdog();
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
        if (method === 'prompt.submit') return submitResponse;
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
  const svcNoReg = createTurnExecutionService(deps2);
  try {
    // 3a) !targetStoredId 直接超时收口
    svcNoReg.armTurnWatchdog();
    await new Promise((r) => setTimeout(r, 55));
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
    await new Promise((r) => setTimeout(r, 70));
    assert.ok(warnLogs.length >= 1, '2nd 非 Extra inputs 探活失败必须记录 warn 并算一次失败');

    // 3c) expired 状态期间调用 feedTurnWatchdog() 抢占 in-flight 探活，且 renewIdle() 必须真正重新布防下一轮定时探活 (L455-458, L355)
    resumeCalls.length = 0;
    state2.isStreaming = true;
    resumeHandler = () => new Promise((res) => { releasePendingProbe = () => res({ running: false }); });
    svcNoReg.armTurnWatchdog();
    await new Promise((r) => setTimeout(r, 45));
    assert.equal(resumeCalls.length, 1);
    assert.equal(resumeCalls[0].profile, 'default', '全部 profile 来源为空时须兜底 default');
    svcNoReg.feedTurnWatchdog(); // 处于 expired 态，触发 L455-458 renewIdle 与 gen 递增
    releasePendingProbe(); // 陈旧探活随后返回，命中 L355 早退而不误杀
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(state2.isStreaming, true, 'stale probe 在 feedTurnWatchdog 续期后绝不可误关流式态');
    resumeHandler = async () => ({ running: true });
    await new Promise((r) => setTimeout(r, 45));
    assert.ok(resumeCalls.length >= 2, 'expired 期 feedTurnWatchdog() 调用 renewIdle 后必须能在下一周期继续触发探活');

    // 3d) 无 streamRegistry 与有 streamRegistry 下的 interruptTurn (L773)
    await svcNoReg.interruptTurn();
    assert.equal(state2.isStreaming, false);

    reg.registerStream({ storedSessionId: 'sess-1', liveSessionId: 'live-1', messageId: 'm-reg', origin: 'local' });
    deps.setActiveStreamingContext({ activeStreamingStoredSessionId: 'sess-1', activeStreamingLiveId: 'live-1', activeStreamingMessageId: 'm-reg' });
    state.activeSessionId = 'sess-1';
    state.isStreaming = true;
    await svcHard.interruptTurn();
    assert.equal(reg.hasSession('sess-1'), false, '有 streamRegistry 时 interruptTurn 必须同步移除活跃流');
    assert.equal(state.isStreaming, false);

    // 3e) isQueuedRace 无 admission_id、无 queuedMessages 且去重 (L1157-1158)
    state2.activeSessionId = 'sess-1';
    delete state2.queuedMessages;
    await svcNoReg.sendMessage('hello queued fallback');
    assert.equal(state2.queuedMessages.length, 1);
    const fixedId = state2.queuedMessages[0].admissionId;
    submitResponse = { status: 'queued', admission_id: fixedId };
    await svcNoReg.sendMessage('hello dup');
    assert.equal(state2.queuedMessages.length, 1, '同 admissionId 不可重复入队');

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
    deps2.setActiveStreamingContext({ activeStreamingStoredSessionId: null, activeStreamingMessageId: null });
    svcNoReg.disarmTurnWatchdog();
    svcOrphanReg.armTurnWatchdog();
    await new Promise((r) => setTimeout(r, 70));
    svcOrphanReg.disarmTurnWatchdog();
    assert.equal(settledOrphan, true);
  } finally {
    svcNoReg.disarmTurnWatchdog();
  }
});

test('TurnExecutionService: 看门狗全分支消杀（ownership释放/tracker清理/group与后台保护/多流re-arm/离线与失败reset/profile与warn校验）', async () => {
  const { LiveStreamRegistry } = await import('@hermes-flux/core');

  // 1. releaseTurnOwnership + tracker.clear + failSubmittedTurn 防陈旧回合误杀新回合
  {
    const reg = new LiveStreamRegistry();
    let rejectPendingSubmit;
    let submitResolveMode = 'hold';
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
        call: async (method, params) => {
          if (method === 'prompt.submit') {
            if (submitResolveMode === 'hold') {
              return await new Promise((_, rej) => { rejectPendingSubmit = rej; });
            }
            return { status: 'streaming' };
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
      await waitForCondition(() => Boolean(deps.getActiveStreamingContext().activeStreamingMessageId));
      const inFlightMsgId = deps.getActiveStreamingContext().activeStreamingMessageId;
      assert.ok(inFlightMsgId);
      pendingScrolls.length = 0;
      // 等待看门狗超时收口（触发 releaseTurnOwnership + tracker.clear）
      await waitForCondition(() => !state.isStreaming);
      assert.equal(state.isStreaming, false);
      assert.equal(pendingScrolls.length, 0, '非贴底超时不得 setPendingScrollToBottom');
      assert.ok(activityTransitionTracker.cleared.some((x) => x.domain === 'session' && x.id === 'sess-own'));
      assert.ok(activityTransitionTracker.cleared.some((x) => x.domain === 'bot' && x.id === 'arch-bot'));

      // 模拟外部立即发起新一轮运行，再令陈旧 prompt.submit 失败：因 releaseTurnOwnership 已释放锁，failSubmittedTurn 不得误删新回合运行态
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

  // 2. group 聚焦无 streamRegistry / 空目标、后台超时保留前景色 ctx 与 pendingScroll、双流最老流选择 + remainingStreams re-arm
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
      // 注册 3 条流（故意打乱时间戳以验证严格最小挑选）：sess-a(300), sess-fg(100, 但先让 sess-bg-old 成为最小 50)
      reg.registerStream({ storedSessionId: 'sess-a', liveSessionId: 'la', messageId: 'ma', origin: 'remote', nowMs: 300 });
      reg.registerStream({ storedSessionId: 'sess-bg-old', liveSessionId: 'lb', messageId: 'mb', origin: 'remote', nowMs: 50 });
      reg.registerStream({ storedSessionId: 'sess-fg', liveSessionId: 'lf', messageId: 'mf', origin: 'local', nowMs: 200 });
      deps.setActiveStreamingContext({ activeStreamingStoredSessionId: 'sess-fg', activeStreamingMessageId: 'mf' });
      state.isStreaming = true;
      svc.armTurnWatchdog();
      await waitForCondition(() => completedHooks.length >= 1);
      // 首轮超时应选中 sess-bg-old(50)，不应清 ctx.activeStreamingStoredSessionId ('sess-fg')，也不应触发贴底
      assert.equal(resumeTargets[0], 'sess-bg-old');
      assert.equal(resumeProfiles[0], 'bg-old-bot');
      assert.equal(deps.getActiveStreamingContext().activeStreamingStoredSessionId, 'sess-fg', '后台超时不得清空前台 activeStreamingContext');
      assert.equal(pendingScrolls.length, 0, '后台超时即使贴底也不得触发当前视口 setPendingScrollToBottom');
      assert.equal(state.isStreaming, true, '前台 sess-fg 仍在 reg 时后台超时不得关闭 isStreaming');

      // 等待第二轮重武装自动到期（验证 L296 slidingWatchdog.arm() re-arm）：应选中 sess-fg(200) 收口，且即便还有 sess-a(300) 前台因 !hasSession('sess-fg') 必须关停 isStreaming
      await waitForCondition(() => completedHooks.length >= 2);
      assert.equal(resumeTargets[1], 'sess-fg');
      assert.equal(state.isStreaming, false, 'sess-fg 出队后即使仍有 sess-a，!hasSession(sess-fg) 时前台 isStreaming 必须置 false');
      assert.deepEqual(pendingScrolls, [true]);

      // 等第三轮重武装自动到期清理 sess-a(300)
      await waitForCondition(() => completedHooks.length >= 3);
      assert.equal(resumeTargets[2], 'sess-a');
      assert.deepEqual(completedHooks, ['sess-bg-old', 'sess-fg', 'sess-a']);
    } finally {
      svc.disarmTurnWatchdog(true);
    }

    // 无 streamRegistry + activeFocus.type='group' 下的空目标超时与匹配 ctx 超时保护，及非聚焦 bot 房 profile 查找
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
      // 无 ctx 也无 activeSessionId -> !timedOutSessionId 在 group 下不改 dockNotice/isStreaming，也不触发 scroll
      stateGrp.activeSessionId = '';
      depsGrp.setActiveStreamingContext({ activeStreamingStoredSessionId: null, activeStreamingMessageId: null });
      svcGrp.armTurnWatchdog();
      await new Promise((r) => setTimeout(r, 80));
      assert.equal(stateGrp.isStreaming, true, 'group 焦点的空目标超时不得误关 isStreaming');
      assert.equal(stateGrp.dockNotice, 'keep-notice');
      assert.equal(grpScrolls.length, 0);

      // 非匹配 state.activeFocus.type='bot' + ctx 指向 sess-other-b -> 用 sessions 中的 other-b-profile，且首次非 Extra error 立即停在 1 次不重试
      const countBefore = resumeTargets.length;
      stateGrp.activeFocus = { type: 'bot', botName: 'wrong-focused-bot' };
      stateGrp.activeSessionId = 'sess-focused-diff';
      depsGrp.setActiveStreamingContext({ activeStreamingStoredSessionId: 'sess-other-b', activeStreamingMessageId: 'm-ob' });
      svcGrp.armTurnWatchdog();
      await waitForCondition(() => warnEntries.length >= 1);
      await new Promise((r) => setTimeout(r, 15));
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
            if (mode === 'running-reset') {
              return { running: true, inflight: { streaming: true } };
            }
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
      // 3a) gatewayConnected=false (non-null client): 第一次 defer-offline 保活，随后恢复 running 清零失败计数
      reg.registerStream({ storedSessionId: 'sess-off', liveSessionId: 'l-off', messageId: 'm-off', origin: 'local' });
      state.isStreaming = true;
      svc.armTurnWatchdog();
      await new Promise((r) => setTimeout(r, 95));
      assert.equal(state.isStreaming, true, 'gatewayConnected=false 第1次超时必须走 defer-offline 续期');

      mode = 'running-reset';
      state.gatewayConnected = true;
      await waitForCondition(() => probeCalls >= 1);
      assert.equal(state.isStreaming, true);

      // 3b) 第 2 轮走 midflight-disconnect 累加一次失败，然后在第 3 轮走 running=true 清零 failures，之后再次 midflight-disconnect 仍须容错（证明已清零）
      const seqAfterReset = probeCalls;
      mode = 'midflight-disconnect';
      await waitForCondition(() => probeCalls >= seqAfterReset + 1);
      await new Promise((r) => setTimeout(r, 10));
      assert.equal(state.isStreaming, true, '在途断连触发 defer-offline 不得立刻误杀');

      const seqAfterMid = probeCalls;
      state.gatewayConnected = true;
      mode = 'running-reset';
      await waitForCondition(() => probeCalls >= seqAfterMid + 1);
      assert.equal(state.isStreaming, true);
      assert.equal(completedHooks.length, 0);

      // 再次失败仍容错（第1次被清零，若未清零则会累加早退）
      const seqBeforeSecondMid = probeCalls;
      mode = 'midflight-disconnect';
      await waitForCondition(() => probeCalls >= seqBeforeSecondMid + 1);
      await new Promise((r) => setTimeout(r, 10));
      assert.equal(state.isStreaming, true, 'running=true 重置连续失败计数后，新的一轮第1次在途断连必须仍容错');
    } finally {
      svc.disarmTurnWatchdog(true);
    }
  }
});

test('TurnExecutionService: 提交/打断/失败回滚/竞态与游标清理全分支变异消杀 (turnExecutionSubmit)', async () => {
  const { LiveStreamRegistry } = await import('@hermes-flux/core');

  // 1. interruptTurn 空会话防误删 removeSession & releaseTurnOwnership 防延迟失败误杀新回合
  {
    const removedIds = [];
    let rejectInterrupted;
    const { deps, state } = createMockTurnDeps({
      state: {
        activeSessionId: '',
        activeLiveSessionId: '',
        sessions: [{ id: 'sess-int', title: 'Int', botName: 'int-bot', preview: '', timestamp: 1 }],
        messages: [],
      },
      gatewayClient: {
        call: async (method) => {
          if (method === 'prompt.submit') {
            return await new Promise((_, rej) => { rejectInterrupted = rej; });
          }
          return {};
        },
      },
    });
    deps.getLiveStreamRegistry = () => ({
      registerStream: () => {},
      hasSession: () => false,
      getBySession: () => undefined,
      listSessionIds: () => [],
      removeSession: (sid) => removedIds.push(sid),
      size: () => 0,
    });
    const svc = createTurnExecutionService(deps);
    try {
      await svc.interruptTurn();
      assert.deepEqual(removedIds, [], 'interruptedSessionId 为空时不得调用 removeSession');

      state.activeSessionId = 'sess-int';
      state.activeLiveSessionId = 'live-int';
      state.activeFocus = { type: 'bot', botName: 'int-bot', sessionId: 'sess-int' };
      const pendingSend = svc.sendMessage('interrupt me');
      await new Promise((r) => setTimeout(r, 5));
      await svc.interruptTurn();
      // 打断后重新开始新一轮运行态
      deps.getActiveRunningSessionIds().add('sess-int');
      deps.getActiveRunningBotNames().add('int-bot');
      rejectInterrupted(new Error('interrupted drop'));
      await pendingSend;
      assert.equal(deps.getActiveRunningSessionIds().has('sess-int'), true, 'interruptTurn 释放 ownership 后迟到拒绝不得误杀新回合');
      assert.equal(deps.getActiveRunningBotNames().has('int-bot'), true);
    } finally {
      svc.disarmTurnWatchdog(true);
    }
  }

  // 2. sendMessage 同步锚点/注册流字段/coalescer/scroll/logStream 及 failSubmittedTurn 多流 disarm/ownership/focus 守卫
  {
    const reg = new LiveStreamRegistry();
    const scrollLogs = [];
    const infoLogs = [];
    const pendingScrolls = [];
    const turnStartedHist = [];
    const forgetCalls = [];
    let regEntryAtRpc = null;
    let renderCountAtRpc = 0;
    let submitFn;

    const { deps, state, rendered, tokenCoalescer, activityTransitionTracker, depsRecorded } = createMockTurnDeps({
      state: {
        activeSessionId: 'sess-sub',
        activeLiveSessionId: 'live-sub',
        activeFocus: { type: 'bot', botName: 'sub-bot', sessionId: 'sess-sub' },
        sessions: [{ id: 'sess-sub', title: 'Sub', botName: 'sub-bot', preview: '', timestamp: 1 }],
        messages: [],
        presenceTerminal: { kind: 'failed', message: 'stale' },
      },
      gatewayClient: {
        call: async (method, p) => {
          if (method === 'prompt.submit') {
            regEntryAtRpc = reg.getBySession('sess-sub') ? { ...reg.getBySession('sess-sub') } : null;
            renderCountAtRpc = rendered.length;
            return await submitFn(p);
          }
          return { running: false };
        },
      },
    });
    deps.watchdogIdleTimeoutMs = 25;
    deps.watchdogHardLimitMs = 500;
    deps.getLiveStreamRegistry = () => reg;
    deps.scrollStreamToBottom = (reason) => scrollLogs.push(reason);
    deps.setPendingScrollToBottom = (v) => pendingScrolls.push(v);
    const origSetTurnStarted = deps.setTurnStartedSessionId;
    deps.setTurnStartedSessionId = (id) => { turnStartedHist.push(id); origSetTurnStarted(id); };
    deps.forgetOlderCursorState = (sid) => forgetCalls.push(sid);
    deps.logStream = { info: (msg, meta) => infoLogs.push({ msg, meta }), warn: () => {}, debug: () => {} };

    const svc = createTurnExecutionService(deps);
    try {
      // 2a) 同步锚点 + armedRowId=null 不触发 cursor reset + 非法 user_row_id 不写 rowId
      tokenCoalescer.flushed = false;
      tokenCoalescer.cleared = false;
      submitFn = async () => ({ status: 'streaming', user_row_id: 0 });
      await svc.sendMessage('exact length check');
      assert.equal(regEntryAtRpc?.origin, 'local');
      assert.equal(regEntryAtRpc?.userMessageSynced, true);
      assert.ok(regEntryAtRpc?.startedAt > 0);
      assert.equal(depsRecorded.userExpandedState, false);
      assert.equal(depsRecorded.ensuredWindowTotal, 2);
      assert.deepEqual(turnStartedHist, ['sess-sub']);
      assert.equal(state.presenceTerminal, undefined, '发消息前必须 clearPresenceTerminal()');
      assert.equal(tokenCoalescer.flushed, true);
      assert.equal(tokenCoalescer.cleared, true);
      assert.deepEqual(pendingScrolls, [true]);
      assert.ok(renderCountAtRpc >= 1, 'sendMessage 必须在 RPC 返回前同步执行 render()');
      assert.deepEqual(scrollLogs, ['message sent']);
      assert.deepEqual(infoLogs[0], { msg: 'turn started', meta: { session: 'live-sub', chars: 'exact length check'.length } });
      assert.equal(forgetCalls.length, 0, '未武装回滚时不应重置历史游标');
      assert.equal(deps.getSessionHistoryTrust().get('sess-sub'), undefined);
      const userM = state.messages.find((m) => m.role === 'user');
      assert.equal(userM.rowId, undefined, 'user_row_id <= 0 时不得赋值 rowId');
      reg.removeSession('sess-sub');
      state.isStreaming = false;
      deps.setActiveStreamingContext({ activeStreamingStoredSessionId: null, activeStreamingMessageId: null, activeStreamingBotName: null });

      // 2b) failSubmittedTurn: rejected status 传 exact args + isFocused=false 时不误关前台 + 仍有 bg 流时不 disarm；无流时真 disarm
      reg.registerStream({ storedSessionId: 'sess-bg-alive', liveSessionId: 'l-bg', messageId: 'm-bg', origin: 'remote' });
      let rejectHeld;
      let notifyRpcEntered;
      const rpcEntered1 = new Promise((res) => { notifyRpcEntered = res; });
      submitFn = () => {
        notifyRpcEntered();
        return new Promise((_, rej) => { rejectHeld = rej; });
      };
      const bgPending = svc.sendMessage('bg fail');
      await rpcEntered1;
      state.activeSessionId = 'sess-other-ui';
      state.isStreaming = true;
      state.presenceTerminal = undefined;
      activityTransitionTracker.cleared.length = 0;
      rejectHeld(new Error('bg boom'));
      await bgPending;
      assert.equal(state.isStreaming, true, '非聚焦会话提交失败不得关闭前台 isStreaming');
      assert.equal(state.presenceTerminal, undefined, '非聚焦会话提交失败不得覆写前台 presenceTerminal');
      assert.ok(activityTransitionTracker.cleared.some((x) => x.domain === 'session' && x.id === 'sess-sub'));
      assert.ok(activityTransitionTracker.cleared.some((x) => x.domain === 'bot' && x.id === 'sub-bot'));
      // 尚有 sess-bg-alive 时看门狗不得被 disarm（仍在运行，等待会发射探活）
      let bgProbed = false;
      const origCall = deps.getGatewayClient().call;
      deps.getGatewayClient().call = async (m, p) => {
        if (m === 'session.resume') bgProbed = true;
        return origCall(m, p);
      };
      await new Promise((r) => setTimeout(r, 35));
      assert.equal(bgProbed, true, 'reg 非空时提交失败不得 disarm 看门狗');
      reg.removeSession('sess-bg-alive');

      // 现聚焦 sess-sub 且无其它流，rejected status -> 调用 failSubmittedTurn 并真正 disarm
      state.activeSessionId = 'sess-sub';
      state.activeFocus = { type: 'session', sessionId: 'sess-sub' };
      state.isStreaming = false;
      deps.setActiveStreamingContext({ activeStreamingStoredSessionId: null, activeStreamingMessageId: null, activeStreamingBotName: null });
      activityTransitionTracker.cleared.length = 0;
      bgProbed = false;
      submitFn = async () => ({ status: 'rejected_quota' });
      await svc.sendMessage('rejected status');
      assert.ok(state.messages.at(-1).content.includes('chat.gatewayNotAccepted{"status":"rejected_quota"}'));
      assert.equal(state.presenceTerminal?.message, 'status=rejected_quota');
      assert.equal(activityTransitionTracker.cleared.some((x) => x.domain === 'bot'), false, '无 focusBotName 时不得误清 bot tracker');
      // 若 failSubmittedTurn 漏掉 disarmTurnWatchdog()，在无重武装前提下把 isStreaming 置 true，残留定时器将误探测
      state.activeSessionId = 'sess-stale-after-reject';
      state.isStreaming = true;
      await new Promise((r) => setTimeout(r, 45));
      state.isStreaming = false;
      state.activeSessionId = 'sess-sub';
      assert.equal(bgProbed, false, 'reg 为空且 ownsStreamCtx 时 failSubmittedTurn 必须 disarm 看门狗');

      // ownedSessionId='' 但 ownedBotName 非空时不得误调 tracker.clear('session', '') 或 removeSession('')
      state.activeFocus = { type: 'bot', botName: 'sub-bot', sessionId: 'sess-sub' };
      state.isStreaming = false;
      deps.setActiveStreamingContext({ activeStreamingStoredSessionId: null, activeStreamingMessageId: null, activeStreamingBotName: null });
      const removedCalls = [];
      const origRemove = reg.removeSession.bind(reg);
      reg.removeSession = (sid) => { removedCalls.push(sid); return origRemove(sid); };
      activityTransitionTracker.cleared.length = 0;
      let holdFail;
      let notifyRpcEntered2;
      const rpcEntered2 = new Promise((res) => { notifyRpcEntered2 = res; });
      submitFn = () => {
        notifyRpcEntered2();
        return new Promise((_, rej) => { holdFail = rej; });
      };
      const pNoOwnSid = svc.sendMessage('lose sess own');
      await rpcEntered2;
      activityTransitionTracker.cleared.length = 0;
      deps.getActiveRunningSessionIds().delete('sess-sub'); // 使 getOwnedSessionId 返回 ''
      deps.setActiveStreamingContext({ activeStreamingMessageId: 'someone-else' }); // 使 ownsStreamCtx=false, 仅 ownedBotName='sub-bot' 为真
      holdFail(new Error('only bot owned'));
      await pNoOwnSid;
      assert.equal(removedCalls.includes(''), false);
      assert.equal(activityTransitionTracker.cleared.some((x) => x.domain === 'session'), false);
      assert.equal(activityTransitionTracker.cleared.some((x) => x.domain === 'bot' && x.id === 'sub-bot'), true);
      reg.removeSession = origRemove;
    } finally {
      svc.disarmTurnWatchdog(true);
    }
  }

  // 3. submitResult user_row_id 双更新 + redirected/queued 并发竞态（含 remoteStream 共存、background 残留不 disarm、admissionId 兜底、onQueuedSubmitRace）
  {
    const reg = new LiveStreamRegistry();
    let mode = 'row-bind';
    let onRaceCalls = [];
    const turnStartedCalls = [];
    let remoteWatchdogProbeCount = 0;
    let rendersAtRpc = 0;
    const { deps, state, rendered, activityTransitionTracker } = createMockTurnDeps({
      state: {
        activeSessionId: 'sess-race',
        activeLiveSessionId: 'live-race',
        activeFocus: { type: 'bot', botName: 'race-bot', sessionId: 'sess-race' },
        sessions: [{ id: 'sess-race', title: 'Race', botName: 'race-bot', preview: '', timestamp: 1 }],
        messages: [],
      },
      gatewayClient: {
        call: async (method) => {
          if (method === 'session.resume') {
            remoteWatchdogProbeCount += 1;
            return { running: false };
          }
          if (method === 'prompt.submit') {
            rendersAtRpc = rendered.length;
            if (mode === 'row-bind') {
              // 模拟在途期间替换一个独立消息对象副本组成的缓存数组，确保 cachedUser.rowId 是独立写入而非共享引用透传
              const cloned = state.messages.map((m) => ({ ...m }));
              cloned.unshift({ id: 'keep-other', role: 'user', content: 'old' });
              deps.getSessionMessagesCache().set('sess-race', cloned);
              return { status: 'streaming', user_row_id: 99 };
            }
            if (mode === 'row-bind-string') {
              return { status: 'streaming', user_row_id: '99' };
            }
            if (mode === 'redirected-with-bg') {
              // 注册独立缓存与后台另一条流
              deps.getSessionMessagesCache().set('sess-race', [...state.messages]);
              reg.registerStream({ storedSessionId: 'sess-bg2', liveSessionId: 'l-bg2', messageId: 'm-bg2', origin: 'remote' });
              return { status: 'redirected' };
            }
            if (mode === 'queued-foreign-stream') {
              // 在途期间远端已先行占位覆盖 registry 与 activeStreamingContext
              activityTransitionTracker.cleared.length = 0;
              deps.getSessionMessagesCache().set('sess-race', [...state.messages]);
              reg.registerStream({ storedSessionId: 'sess-race', liveSessionId: 'live-remote', messageId: 'remote-ast-msg', origin: 'remote', botName: 'race-bot' });
              deps.setActiveStreamingContext({ activeStreamingMessageId: 'remote-ast-msg', activeStreamingStoredSessionId: 'sess-race', activeStreamingLiveId: 'live-remote', activeStreamingBotName: 'race-bot' });
              state.isStreaming = true;
              return { status: 'queued' };
            }
            if (mode === 'queued-empty-reg') {
              return { status: 'queued', admission_id: 'q-second' };
            }
            if (mode === 'queued-bg-noreg') {
              state.activeSessionId = 'sess-foreground-other';
              state.isStreaming = true;
              return { status: 'queued', admission_id: 'q-second' };
            }
          }
          return {};
        },
      },
    });
    deps.watchdogIdleTimeoutMs = 25;
    deps.watchdogHardLimitMs = 500;
    deps.getLiveStreamRegistry = () => reg;
    deps.onQueuedSubmitRace = (sid) => onRaceCalls.push(sid);
    const origSetTurnStarted = deps.setTurnStartedSessionId;
    deps.setTurnStartedSessionId = (id) => { turnStartedCalls.push(id); origSetTurnStarted(id); };

    const svc = createTurnExecutionService(deps);
    try {
      // 3a) user_row_id=99 同时写进 state.messages 与独立 cachedUser（不影响 keep-other），非 number string '99' 不得误写 rowId
      await svc.sendMessage('bind row');
      const u1 = state.messages.find((m) => m.role === 'user' && m.content === 'bind row');
      assert.equal(u1.rowId, 99);
      const cachedArr = deps.getSessionMessagesCache().get('sess-race');
      assert.equal(cachedArr.find((m) => m.id === u1.id).rowId, 99);
      assert.equal(cachedArr.find((m) => m.id === 'keep-other').rowId, undefined);
      reg.removeSession('sess-race');
      state.isStreaming = false;
      deps.setActiveStreamingContext({ activeStreamingStoredSessionId: null, activeStreamingMessageId: null, activeStreamingBotName: null });

      mode = 'row-bind-string';
      state.messages = [];
      await svc.sendMessage('string row id');
      assert.equal(state.messages.find((m) => m.role === 'user')?.rowId, undefined, '非 number 的 user_row_id 不得赋值');
      reg.removeSession('sess-race');
      state.isStreaming = false;
      state.messages = [];
      deps.setActiveStreamingContext({ activeStreamingStoredSessionId: null, activeStreamingMessageId: null, activeStreamingBotName: null });

      // 3b) redirected: 仅撤 assistant 占位，保留 user 气泡；清 race-bot tracker 与 isStreaming，但后台仍有 sess-bg2 故不得 disarm
      onRaceCalls.length = 0;
      turnStartedCalls.length = 0;
      activityTransitionTracker.cleared.length = 0;
      mode = 'redirected-with-bg';
      await svc.sendMessage('redir prompt');
      assert.equal(state.messages.some((m) => m.content === 'redir prompt'), true, 'redirected 仅撤除空助手泡，必须保留用户消息');
      assert.equal(state.messages.filter((m) => m.role === 'assistant' && m.content === '').length, 0);
      assert.equal(deps.getSessionMessagesCache().get('sess-race').filter((m) => m.role === 'assistant' && m.content === '').length, 0);
      assert.equal(deps.getActiveRunningBotNames().has('race-bot'), false);
      assert.ok(activityTransitionTracker.cleared.some((x) => x.domain === 'bot' && x.id === 'race-bot'));
      assert.equal(state.isStreaming, false);
      assert.equal(state.turnStartedAt, undefined);
      assert.equal(turnStartedCalls.at(-1), null);
      assert.ok(rendered.length > rendersAtRpc, 'redirected 分支收口后必须调用 deps.render()');
      assert.deepEqual(onRaceCalls, ['sess-race']);
      // 后台 sess-bg2 仍在 -> 看门狗未 disarm -> 25ms 后触发探测
      remoteWatchdogProbeCount = 0;
      await new Promise((r) => setTimeout(r, 35));
      assert.ok(remoteWatchdogProbeCount >= 1, 'redirected 清理本地占位但仍有后台流时不得 disarm 看门狗');
      reg.removeSession('sess-bg2');

      // 3c) queued-foreign-stream: 在途被远端占位流接管时，不可误删远端 stream、不可清 bot/isStreaming/turnStarted/activeCtx
      mode = 'queued-foreign-stream';
      turnStartedCalls.length = 0;
      activityTransitionTracker.cleared.length = 0;
      onRaceCalls.length = 0;
      await svc.sendMessage('queued with remote active');
      assert.equal(reg.getBySession('sess-race')?.messageId, 'remote-ast-msg', '远端占位流不可被 queued 分支误删');
      assert.equal(deps.getActiveRunningBotNames().has('race-bot'), true);
      assert.equal(activityTransitionTracker.cleared.some((x) => x.domain === 'bot'), false);
      assert.equal(deps.getActiveStreamingContext().activeStreamingMessageId, 'remote-ast-msg');
      assert.equal(state.isStreaming, true);
      assert.equal(turnStartedCalls.includes(null), false);
      assert.equal(state.queuedMessages.length, 1);
      assert.ok(state.queuedMessages[0].id.startsWith('queued-'));
      assert.equal(state.queuedMessages[0].id, state.queuedMessages[0].admissionId);
      assert.deepEqual(onRaceCalls, ['sess-race']);
      reg.removeSession('sess-race');
      state.isStreaming = false;
      deps.setActiveStreamingContext({ activeStreamingStoredSessionId: null, activeStreamingMessageId: null, activeStreamingBotName: null });

      // 3d) queued 且无其他流 -> 必须追加不同 admissionId 到 queuedMessages 并彻底 disarm 看门狗
      mode = 'queued-empty-reg';
      await svc.sendMessage('queued empty reg');
      assert.equal(state.queuedMessages.length, 2, '不同 admissionId 的新排队消息必须追加');
      remoteWatchdogProbeCount = 0;
      state.activeSessionId = 'sess-stale-queued';
      state.isStreaming = true;
      await new Promise((r) => setTimeout(r, 45));
      state.isStreaming = false;
      state.activeSessionId = 'sess-race';
      assert.equal(remoteWatchdogProbeCount, 0, '最后流触发 queued 且清空本地占位时必须 disarm 看门狗');

      // 3e) 切走会话后后台 queued + 重复 admissionId 不追加 + 无 onQueuedSubmitRace 与 registry 降级
      mode = 'queued-bg-noreg';
      deps.onQueuedSubmitRace = undefined;
      deps.getLiveStreamRegistry = undefined;
      const svcNoRegRace = createTurnExecutionService(deps);
      try {
        await svcNoRegRace.sendMessage('bg queued dup');
        assert.equal(state.isStreaming, true, '非聚焦会话收到 queued 不可清除当前前台 isStreaming');
        assert.equal(state.queuedMessages.length, 2, '相同 admissionId q-second 不可重复入队');
      } finally {
        svcNoRegRace.disarmTurnWatchdog(true);
      }
    } finally {
      svc.disarmTurnWatchdog(true);
    }
  }
});

test('TurnExecutionService: disarmTurnWatchdog 多流守卫与 interruptTurn 后置安全撤防', async () => {
  const { LiveStreamRegistry } = await import('@hermes-flux/core');

  // 1. LiveStreamRegistry 非空时 disarmTurnWatchdog() 不得撤防看门狗；清空后可正常撤防；force=true 强制撤防
  {
    const reg = new LiveStreamRegistry();
    let probeCount = 0;
    const { deps, state } = createMockTurnDeps({
      gatewayClient: {
        call: async (method) => {
          if (method === 'session.resume') {
            probeCount += 1;
            return { running: true };
          }
          return {};
        },
      },
    });
    deps.watchdogIdleTimeoutMs = 20;
    deps.watchdogHardLimitMs = 300;
    deps.getLiveStreamRegistry = () => reg;
    const svc = createTurnExecutionService(deps);
    try {
      state.activeSessionId = 'sess-keep';
      state.isStreaming = true;
      reg.registerStream({
        storedSessionId: 'sess-keep',
        liveSessionId: 'live-keep',
        messageId: 'ast-keep',
        origin: 'remote',
        nowMs: 1000,
      });
      svc.armTurnWatchdog();
      svc.disarmTurnWatchdog();
      await waitForCondition(() => probeCount >= 1);
      assert.ok(probeCount >= 1, '仍有活跃流时 disarmTurnWatchdog() 严禁关闭看门狗');

      // 强制 disarm(true) 即使仍有流也立即撤防
      probeCount = 0;
      svc.disarmTurnWatchdog(true);
      await new Promise((r) => setTimeout(r, 38));
      assert.equal(probeCount, 0, 'force=true 必须强制撤防看门狗');

      // 流清空后无参 disarmTurnWatchdog() 必须正常撤防
      svc.armTurnWatchdog();
      reg.removeSession('sess-keep');
      probeCount = 0;
      svc.disarmTurnWatchdog();
      await new Promise((r) => setTimeout(r, 38));
      assert.equal(probeCount, 0, 'LiveStreamRegistry 清空后无参 disarm 必须撤防看门狗');
    } finally {
      svc.disarmTurnWatchdog(true);
    }
  }

  // 2. interruptTurn 先移除当前流再撤防：唯一流彻底撤防，并发后台流存在时看门狗继续探活
  {
    const reg = new LiveStreamRegistry();
    let probeCount = 0;
    const { deps, state } = createMockTurnDeps({
      gatewayClient: {
        call: async (method) => {
          if (method === 'session.resume') {
            probeCount += 1;
            return { running: true };
          }
          return {};
        },
      },
      activeStreamingContext: {
        activeStreamingStoredSessionId: 'sess-int-a',
        activeStreamingLiveId: 'live-int-a',
        activeStreamingMessageId: 'ast-int-a',
      },
    });
    deps.watchdogIdleTimeoutMs = 20;
    deps.watchdogHardLimitMs = 300;
    deps.getLiveStreamRegistry = () => reg;
    const svc = createTurnExecutionService(deps);
    try {
      state.activeSessionId = 'sess-int-a';
      state.activeLiveSessionId = 'live-int-a';
      state.isStreaming = true;
      state.messages = [
        { id: 'u-a', role: 'user', content: 'hi' },
        { id: 'ast-int-a', role: 'assistant', content: 'part' },
      ];
      reg.registerStream({
        storedSessionId: 'sess-int-a',
        liveSessionId: 'live-int-a',
        messageId: 'ast-int-a',
        origin: 'local',
        nowMs: 1000,
      });
      reg.registerStream({
        storedSessionId: 'sess-bg-b',
        liveSessionId: 'live-bg-b',
        messageId: 'ast-bg-b',
        origin: 'remote',
        nowMs: 1000,
      });
      svc.armTurnWatchdog();

      // 打断 sess-int-a 但后台 sess-bg-b 仍在运行：sess-int-a 被摘除但看门狗继续保活探询
      await svc.interruptTurn();
      assert.equal(reg.hasSession('sess-int-a'), false);
      assert.equal(reg.hasSession('sess-bg-b'), true);
      probeCount = 0;
      await waitForCondition(() => probeCount >= 1);
      assert.ok(probeCount >= 1, '打断当前流但仍有后台流时，看门狗必须继续保持武装');

      // 无其他流时 interruptTurn 必须彻底 disarm 看门狗
      svc.disarmTurnWatchdog(true);
      reg.removeSession('sess-bg-b');
      deps.setActiveStreamingContext({
        activeStreamingStoredSessionId: 'sess-int-solo',
        activeStreamingLiveId: 'live-int-solo',
        activeStreamingMessageId: 'ast-int-solo',
      });
      state.activeSessionId = 'sess-int-solo';
      state.activeLiveSessionId = 'live-int-solo';
      state.isStreaming = true;
      state.messages = [{ id: 'ast-int-solo', role: 'assistant', content: 'solo' }];
      reg.registerStream({
        storedSessionId: 'sess-int-solo',
        liveSessionId: 'live-int-solo',
        messageId: 'ast-int-solo',
        origin: 'local',
        nowMs: 2000,
      });
      svc.armTurnWatchdog();
      probeCount = 0;
      await svc.interruptTurn();
      assert.equal(reg.hasSession('sess-int-solo'), false);
      state.activeSessionId = 'sess-after-int';
      state.isStreaming = true;
      await new Promise((r) => setTimeout(r, 45));
      state.isStreaming = false;
      assert.equal(probeCount, 0, '最后一条流被打断后，看门狗必须彻底撤防');
    } finally {
      svc.disarmTurnWatchdog(true);
    }
  }
});
