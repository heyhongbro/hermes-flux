/**
 * 回合执行与队列控制服务（Turn Execution Service · D5）纯逻辑单测
 * (packages/desktop/__tests__/unit/turnExecutionService.test.mjs)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createTurnExecutionService } from '../../dist/renderer/services/turnExecutionService.mjs';

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
});
