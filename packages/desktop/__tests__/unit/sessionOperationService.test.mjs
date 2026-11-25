/**
 * 会话生命周期与设置切换服务（Session Operation Service）脱离 DOM 纯逻辑单测
 * (packages/desktop/__tests__/unit/sessionOperationService.test.mjs)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionOperationService } from '../../dist/renderer/services/sessionOperationService.mjs';
import { SessionListGeneration, RpcErrorCode } from '@hermes-flux/core';

function createMockDeps(overrides = {}) {
  let promptInputValue = '';
  const storageMap = new Map();
  const sessionMessagesCache = new Map();
  const sessionDraftsMap = new Map();
  const toasts = [];
  const rendered = [];

  const state = {
    activeSessionId: 'sess-current',
    activeLiveSessionId: 'live-current',
    profileName: 'default',
    profiles: [{ name: 'default', displayName: 'Default Bot' }],
    sessions: [
      { id: 'sess-current', title: 'Current Task', botName: 'default', isArchived: false },
      { id: 'sess-next', title: 'Next Task', botName: 'default', isArchived: false },
    ],
    projects: [{ id: 'proj-1', path: '/workspace/project-1' }],
    pendingSessionIds: [],
    messages: [
      { id: 'm1', role: 'user', content: 'hello', timestamp: '12:00' },
      { id: 'm2', role: 'assistant', content: 'world', timestamp: '12:01' },
      { id: 'm3', role: 'system', displayKind: 'hidden', content: 'internal', timestamp: '12:02' },
    ],
    selectedModel: 'gpt-4o',
    currentProvider: 'openai',
    recentModels: [],
    reasoningLevel: 'default',
    approvalMode: 'manual',
    dockNotice: '',
    modelMenuOpen: false,
    isStreaming: false,
    activeFocus: { type: 'session', sessionId: 'sess-current' },
    rollbackArmed: null,
    gatewayUrl: 'http://127.0.0.1:8080',
    ...(overrides.state || {}),
  };

  const rpcCalls = [];
  const gatewayClient = overrides.gatewayClient ?? {
    call: async (method, params) => {
      rpcCalls.push({ method, params });
      if (method === 'session.create') {
        return { session_id: 'sess-new', id: 'sess-new', live_id: 'live-new' };
      }
      if (method === 'session.delete') {
        return { ok: true };
      }
      if (method === 'session.title') {
        return { ok: true };
      }
      if (method === 'session.archive') {
        return { ok: true };
      }
      if (method === 'config.set') {
        return { ok: true };
      }
      return {};
    },
    fetchSessionMessages: async () => ({ status: 'success', messages: [] }),
  };

  const deps = {
    getState: () => state,
    getGatewayClient: () => gatewayClient,
    getDesktopApi: () => undefined,
    getCurrentTicket: () => 'ticket-123',
    getEffectiveUrl: (url) => url || 'http://127.0.0.1:8080',
    render: () => { rendered.push(Date.now()); },
    t: (key, params) => `${key}:${JSON.stringify(params || {})}`,
    showToast: (msg) => { toasts.push(msg); },
    setTimedDockNotice: (msg) => { state.dockNotice = msg; },
    restoreComposerFocus: () => {},
    sessionDrafts: {
      get: (id) => sessionDraftsMap.get(id) || '',
      set: (id, val) => { sessionDraftsMap.set(id, val); },
      delete: (id) => { sessionDraftsMap.delete(id); },
      has: (id) => sessionDraftsMap.has(id),
    },
    sessionMessagesCache,
    unreadSessionIds: new Set(),
    activeRunningSessionIds: new Set(),
    activityTransitionTracker: { clear: () => {} },
    sessionHandleRegistry: {
      register: () => {},
      unregister: () => {},
      toStoredSessionId: (id) => id,
    },
    cacheService: {
      dropChannel: async () => {},
      writeSessions: async () => {},
    },
    persistSessionsToCache: () => {},
    forgetOlderCursorState: () => {},
    sessionListGeneration: new SessionListGeneration(),
    getActiveStreamingStoredSessionId: () => null,
    resetActiveStreamingState: () => { state.isStreaming = false; },
    setPendingScrollToBottom: () => {},
    setLastMessagesSnapshot: () => {},
    loadMessages: async () => {},
    openBotChat: async () => {},
    ensureLiveSessionId: async () => 'live-resolved',
    fetchSessions: async () => {},
    incrementActiveLoadMessagesGeneration: () => 1,
    getPromptInputValue: () => promptInputValue,
    setPromptInputValue: (val) => { promptInputValue = val; },
    focusPromptInput: () => {},
    promptDialog: (_title, defaultVal) => `${defaultVal} Renamed`,
    writeClipboardText: async (text) => { storageMap.set('clipboard', text); },
    storage: {
      getItem: (k) => storageMap.get(k) || null,
      setItem: (k, v) => { storageMap.set(k, v); },
    },
    ...overrides,
  };

  return { deps, state, rpcCalls, toasts, rendered, storageMap, sessionDraftsMap };
}

test('SessionOperationService - 核心生命周期与状态切换测试', async (t) => {
  await t.test('1. createNewSession: 暂存当前草稿、发起 session.create 并重置焦点与输入框', async () => {
    const enters = [];
    const { deps, state, rpcCalls } = createMockDeps({
      beginSessionEnter: (id, options) => enters.push({ id, options }),
    });
    deps.setPromptInputValue('未发送的当前草稿');
    const service = createSessionOperationService(deps);

    await service.createNewSession({ profile: 'default', title: '新建测试任务' });

    assert.equal(deps.sessionDrafts.get('sess-current'), '未发送的当前草稿', '切出会话前草稿必须被暂存');
    assert.equal(rpcCalls.some((c) => c.method === 'session.create'), true, '必须调用 session.create');
    assert.equal(state.activeSessionId, 'sess-new', 'activeSessionId 必须更新为新会话');
    assert.deepEqual(enters, [{ id: 'sess-new', options: { forcePinToBottom: true } }], '新建会话必须强制贴底');
    assert.equal(deps.getPromptInputValue(), '', '新会话输入框必须清空');
  });

  await t.test('2. deleteSession: 正确注销实体并平滑将焦点移交下一会话', async () => {
    const { deps, state } = createMockDeps();
    const service = createSessionOperationService(deps);

    await service.deleteSession('sess-current');

    assert.equal(state.sessions.some((s) => s.id === 'sess-current'), false, '已删会话必须从列表中移除');
    assert.equal(state.activeSessionId, 'sess-next', '删除当前活动会话后焦点平滑切换至下一会话');
  });

  await t.test('3. selectSession: 非破坏性草稿恢复，敲入新字时不被旧草稿覆盖，且离开前捕获锚点', async () => {
    let capturedAnchors = 0;
    const enters = [];
    const { deps, state } = createMockDeps({
      captureStreamAnchor: () => { capturedAnchors += 1; },
      beginSessionEnter: (id, options) => { enters.push({ id, options }); },
    });
    deps.sessionDrafts.set('sess-next', '旧会话草稿内容');
    const service = createSessionOperationService(deps);

    // 场景 A: 输入框为空时恢复草稿，且离开 sess-current 时调用 captureStreamAnchor
    deps.setPromptInputValue('');
    await service.selectSession('sess-next');
    assert.equal(capturedAnchors, 1, '切离活动会话前必须调用 captureStreamAnchor 捕获快照');
    assert.deepEqual(enters[0], { id: 'sess-next', options: undefined }, '切会话必须锁存进入计划');
    assert.equal(deps.getPromptInputValue(), '旧会话草稿内容', '空输入框切入时必须恢复旧草稿');

    // 场景 B: 用户在网络加载期间已键入文字时不被冲刷
    deps.sessionDrafts.set('sess-current', '更旧草稿');
    deps.loadMessages = async () => {
      // 模拟网络加载异步期间，用户在空白输入框中敲入了实时文字
      deps.setPromptInputValue('正在实时输入的文字');
    };
    await service.selectSession('sess-current');
    assert.equal(capturedAnchors, 2, '再次切离会话时继续捕获快照');
    assert.equal(deps.getPromptInputValue(), '正在实时输入的文字', '加载期间敲入的文字绝对不可被草稿冲刷');
  });

  await t.test('3b. selectSession: 切换会话时必须立即重置 dockNotice 并清除定时器', async () => {
    let clearedTimerCalls = 0;
    const { deps, state } = createMockDeps({
      clearTimedDockNotice: () => { clearedTimerCalls += 1; },
    });
    state.dockNotice = "指令 /compress 执行失败: RPC request 'slash.exec' with id 74 timed out after 25000ms";
    const service = createSessionOperationService(deps);

    await service.selectSession('sess-next');

    assert.equal(state.dockNotice, '', '切换会话时旧会话的 dockNotice 必须被重置为空');
    assert.equal(clearedTimerCalls, 1, '切换会话时必须触发 clearTimedDockNotice 清除定时器');
  });

  await t.test('3c. selectSession: 切离会话时立即清空 DOM，无草稿新会话输入框严格为空，且报错文本绝对禁止暂存为草稿', async () => {
    const { deps, state } = createMockDeps();
    const service = createSessionOperationService(deps);

    // 假设旧会话输入框中有残留的报错文本
    const errorText = "指令 /compress 执行失败: RPC request 'slash.exec' with id 74 timed out after 25000ms";
    deps.setPromptInputValue(errorText);

    // 切换至没有任何草稿的新会话 sess-clean
    await service.selectSession('sess-clean');

    assert.equal(deps.sessionDrafts.has('sess-current'), false, '旧会话中的报错文本绝对不得被存入草稿 store');
    assert.equal(deps.getPromptInputValue(), '', '新会话无草稿时输入框必须严格为空，绝不残留旧会话内容');
  });

  await t.test('4. exportMarkdown: 导出口径与视图一致，过滤 hidden 机器行', async () => {
    const { deps, storageMap, toasts } = createMockDeps();
    const service = createSessionOperationService(deps);

    await service.exportMarkdown('sess-current');

    const exported = storageMap.get('clipboard') || '';
    assert.ok(exported.includes('hello'), '必须包含普通消息');
    assert.ok(exported.includes('world'), '必须包含助手消息');
    assert.equal(exported.includes('internal'), false, 'displayKind=hidden 的机器行绝对不得导出');
    assert.ok(toasts.length > 0, '导出完成后必须触发 Toast 反馈');
  });

  await t.test('5. pinSession & archiveSession: 列表顺序与归档标记正确更新', async () => {
    const { deps, state, rpcCalls } = createMockDeps();
    const service = createSessionOperationService(deps);

    await service.pinSession('sess-next');
    assert.equal(state.sessions[0].id, 'sess-next', '置顶项必须移动至首位');

    await service.archiveSession('sess-next');
    assert.equal(rpcCalls.some((c) => c.method === 'session.archive'), true, '必须调用 session.archive');
    const archivedTarget = (state.archivedSessions || []).find((s) => s.id === 'sess-next');
    assert.equal(archivedTarget?.isArchived, true, 'isArchived 状态必须转入 archivedSessions');
    assert.equal(state.sessions.some((s) => s.id === 'sess-next'), false, '已归档会话应从活跃列表移出');
  });

  await t.test('6. switchModel / switchReasoning: 群聊视口严格拦截向单聊发 config.set', async () => {
    const { deps, state, rpcCalls } = createMockDeps();
    state.activeFocus = { type: 'group', roomId: 'room-123' };
    const service = createSessionOperationService(deps);

    await service.switchModel('claude-3-5-sonnet');
    await service.switchReasoning('high');

    const configCalls = rpcCalls.filter((c) => c.method === 'config.set');
    assert.equal(configCalls.length, 0, '群聊视口中切换模型与思考级别绝对禁止向 session 发送 config.set');
    assert.equal(state.selectedModel, 'claude-3-5-sonnet', '客户端模型选择器状态仍应正确记录');
    assert.equal(state.reasoningLevel, 'high', '客户端思考级别状态仍应正确记录');
  });

  await t.test('6b. switchModel 落盘抛错不得中断 render 与模型切换（P-032）', async () => {
    // 【杀伤力】把 safeSetItem 换回裸 storage.setItem，QuotaExceededError 会冒泡并跳过 render。
    const { deps, state, rendered } = createMockDeps();
    state.activeFocus = { type: 'group', roomId: 'room-123' };
    deps.storage.setItem = () => {
      const error = new Error('denied');
      error.name = 'QuotaExceededError';
      throw error;
    };
    const service = createSessionOperationService(deps);

    await assert.doesNotReject(
      () => service.switchModel('claude-3-5-sonnet'),
      '写盘失败不得让 switchModel 抛错',
    );
    assert.equal(state.selectedModel, 'claude-3-5-sonnet', '内存态必须已生效');
    assert.ok(rendered.length > 0, 'render 必须仍被调用（「点了没反应」的根因）');
  });

  await t.test('6c. switchModel 无可用存储时静默降级且不记日志（P-032）', async () => {
    const { deps, state, rendered } = createMockDeps();
    state.activeFocus = { type: 'group', roomId: 'room-123' };
    deps.storage = undefined;
    const logWarns = [];
    deps.logSessionWarn = (...args) => logWarns.push(args);
    const hadStorage = 'localStorage' in globalThis;
    const savedStorage = globalThis.localStorage;
    const savedWarn = console.warn;
    const warns = [];
    try {
      delete globalThis.localStorage;
      console.warn = (...args) => warns.push(args);
      const service = createSessionOperationService(deps);
      await assert.doesNotReject(() => service.switchModel('claude-3-5-sonnet'));
      assert.equal(logWarns.length, 0, 'unavailable 不属降级，不得调用注入 logger');
      assert.equal(warns.length, 0, 'unavailable 不属降级，不记日志');
      assert.ok(rendered.length > 0, 'render 必须仍被调用');
    } finally {
      console.warn = savedWarn;
      if (hadStorage) globalThis.localStorage = savedStorage;
      else delete globalThis.localStorage;
    }
  });

  await t.test('6d. switchModel 生产接线（未注入 storage + getter 抛错）不得中断 render（P-032）', async () => {
    // 【杀伤力】把 safeSetItem 的第三个参数改回 this.getStorage()，本用例立刻抛 SecurityError 变红。
    const { deps, state, rendered } = createMockDeps();
    state.activeFocus = { type: 'group', roomId: 'room-123' };
    deps.storage = undefined;
    const warns = [];
    deps.logSessionWarn = (message, meta) => warns.push([message, meta]);
    const hadStorage = 'localStorage' in globalThis;
    const savedStorage = globalThis.localStorage;
    try {
      Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        get() {
          const error = new Error('denied');
          error.name = 'SecurityError';
          throw error;
        },
      });
      const service = createSessionOperationService(deps);

      await assert.doesNotReject(
        () => service.switchModel('claude-3-5-sonnet'),
        'localStorage getter 抛错不得让 switchModel 抛错',
      );
      assert.ok(rendered.length > 0, 'render 必须仍被调用（「点了没反应」的根因）');
      assert.ok(warns.length > 0, '降级必须可观测');
      assert.equal(warns.at(-1)[1].reason, 'security');
    } finally {
      delete globalThis.localStorage;
      if (hadStorage) globalThis.localStorage = savedStorage;
    }
  });

  await t.test('7. disarmRollbackOnLeave: 离开会话时回滚快照安全恢复到原会话缓存', async () => {
    const { deps, state } = createMockDeps();
    state.rollbackArmed = {
      sessionId: 'sess-current',
      targetRowId: 10,
      targetMessageId: 'm10',
      snapshot: [{ id: 'm-restored', content: 'restored' }],
    };
    const service = createSessionOperationService(deps);

    service.disarmRollbackOnLeave('sess-current');

    assert.equal(state.rollbackArmed, null, '挂起回滚状态必须清空');
    const restored = deps.sessionMessagesCache.get('sess-current');
    assert.equal(restored?.length, 1, '快照必须被安全恢复到原会话缓存中');
  });

  await t.test('8. selectSession: 切回仍在流式运行且包含工具调用的会话时自动补排 scheduleToolPatch', async () => {
    const patchedIds = [];
    const { deps, state } = createMockDeps({
      getActiveStreamingStoredSessionId: () => 'sess-next',
      getActiveStreamingMessageId: () => 'ast-stream-1',
      scheduleToolPatch: (mid) => { patchedIds.push(mid); },
      loadMessages: async () => {
        state.messages = [
          {
            id: 'ast-stream-1',
            role: 'assistant',
            content: 'working...',
            toolCalls: [{ id: 'tc-1', name: 'terminal', status: 'running', args: '{}' }],
          },
        ];
      },
    });
    const service = createSessionOperationService(deps);

    await service.selectSession('sess-next');
    assert.equal(state.isStreaming, true);
    assert.deepEqual(patchedIds, ['ast-stream-1'], '切回流式运行且带工具调用的会话必须补刷 toolPatch');

    // 切回流式运行但无工具调用的会话：不得多余调度 scheduleToolPatch
    patchedIds.length = 0;
    const { deps: depsNoTools, state: stateNoTools } = createMockDeps({
      getActiveStreamingStoredSessionId: () => 'sess-next',
      getActiveStreamingMessageId: () => 'ast-stream-2',
      scheduleToolPatch: (mid) => { patchedIds.push(mid); },
      loadMessages: async () => {
        stateNoTools.messages = [{ id: 'ast-stream-2', role: 'assistant', content: 'plain' }];
      },
    });
    const serviceNoTools = createSessionOperationService(depsNoTools);
    await serviceNoTools.selectSession('sess-next');
    assert.deepEqual(patchedIds, [], '无工具调用时不触发 scheduleToolPatch');

    // 非流式会话（活跃流式会话是别的 id）即使存在带工具的活跃消息，也不得调度
    patchedIds.length = 0;
    const { deps: depsIdle, state: stateIdle } = createMockDeps({
      getActiveStreamingStoredSessionId: () => 'sess-other',
      getActiveStreamingMessageId: () => 'ast-idle-1',
      scheduleToolPatch: (mid) => { patchedIds.push(mid); },
      loadMessages: async () => {
        stateIdle.messages = [
          {
            id: 'ast-idle-1',
            role: 'assistant',
            content: 'done',
            toolCalls: [{ id: 'tc-9', name: 'terminal', status: 'completed', args: '{}' }],
          },
        ];
      },
    });
    const serviceIdle = createSessionOperationService(depsIdle);
    await serviceIdle.selectSession('sess-next');
    assert.equal(stateIdle.isStreaming, false, '活跃流式会话是其它 id 时本会话必须判为非流式');
    assert.deepEqual(patchedIds, [], '非流式会话选择不得调度 scheduleToolPatch（否则会覆写 React 已收口子树）');

    // 流式会话但活跃消息 ID 缺失：不得调度
    patchedIds.length = 0;
    const { deps: depsNoId, state: stateNoId } = createMockDeps({
      getActiveStreamingStoredSessionId: () => 'sess-next',
      getActiveStreamingMessageId: () => null,
      scheduleToolPatch: (mid) => { patchedIds.push(mid); },
      loadMessages: async () => {
        stateNoId.messages = [{ id: 'ast-x', role: 'assistant', content: 'x' }];
      },
    });
    await createSessionOperationService(depsNoId).selectSession('sess-next');
    assert.deepEqual(patchedIds, [], '无活跃流式消息 ID 时不得调度');

    // 流式会话且活跃消息 ID 指向不存在的消息：不得调度
    patchedIds.length = 0;
    const { deps: depsMiss, state: stateMiss } = createMockDeps({
      getActiveStreamingStoredSessionId: () => 'sess-next',
      getActiveStreamingMessageId: () => 'ast-missing',
      scheduleToolPatch: (mid) => { patchedIds.push(mid); },
      loadMessages: async () => {
        stateMiss.messages = [{ id: 'ast-x', role: 'assistant', content: 'x' }];
      },
    });
    await createSessionOperationService(depsMiss).selectSession('sess-next');
    assert.deepEqual(patchedIds, [], '活跃消息不在当前消息列表时不得调度');

    // 流式会话且工具数组为空：不得调度
    patchedIds.length = 0;
    const { deps: depsEmpty, state: stateEmpty } = createMockDeps({
      getActiveStreamingStoredSessionId: () => 'sess-next',
      getActiveStreamingMessageId: () => 'ast-empty',
      scheduleToolPatch: (mid) => { patchedIds.push(mid); },
      loadMessages: async () => {
        stateEmpty.messages = [{ id: 'ast-empty', role: 'assistant', content: 'x', toolCalls: [] }];
      },
    });
    await createSessionOperationService(depsEmpty).selectSession('sess-next');
    assert.deepEqual(patchedIds, [], '工具数组为空时不得调度');
  });
});

test('renameSession 支持移动端直接传入 nextTitleOverride 而跳过 window.prompt', async () => {
  const { deps, state, rpcCalls } = createMockDeps();
  const service = createSessionOperationService(deps);

  await service.renameSession('sess-current', 'Current Task', '移动端新标题');
  assert.equal(
    rpcCalls.some((c) => c.method === 'session.title' && c.params?.title === '移动端新标题'),
    true,
  );
  assert.equal(state.sessions.find((s) => s.id === 'sess-current')?.title, '移动端新标题');

  // 未传 nextTitleOverride 时依次回落到 promptDialog 与 window.prompt
  const { deps: dlgDeps, state: dlgState } = createMockDeps({
    promptDialog: () => 'Dialog Title',
  });
  await createSessionOperationService(dlgDeps).renameSession('sess-current', 'Current Task');
  assert.equal(dlgState.sessions.find((s) => s.id === 'sess-current')?.title, 'Dialog Title');

  const prevWindow = globalThis.window;
  globalThis.window = { prompt: () => 'Window Prompt Title' };
  try {
    const { deps: winDeps, state: winState } = createMockDeps();
    delete winDeps.promptDialog;
    await createSessionOperationService(winDeps).renameSession('sess-current', 'Current Task');
    assert.equal(winState.sessions.find((s) => s.id === 'sess-current')?.title, 'Window Prompt Title');
  } finally {
    globalThis.window = prevWindow;
  }
});

test('pinSession 切换 pinned 状态、排到首位、落盘持久化并安全忽略缺失 ID', async () => {
  const persisted = [];
  const { deps, state, toasts, rendered } = createMockDeps({
    persistSessionsToCache: (sessions) => persisted.push(sessions),
  });
  state.sessions = [
    { id: 'sess-current', title: 'First', lastActive: 100, botName: 'default' },
    { id: 'sess-next', title: 'Second', lastActive: 50, botName: 'default', pinned: false },
  ];
  const service = createSessionOperationService(deps);

  await service.pinSession('sess-missing');
  assert.equal(rendered.length, 0);

  await service.pinSession('sess-next');
  assert.equal(state.sessions[0].id, 'sess-next');
  assert.equal(state.sessions[0].pinned, true);
  assert.equal(persisted.length, 1);
  assert.ok(toasts.length >= 1);

  await service.pinSession('sess-next');
  assert.equal(state.sessions.find((s) => s.id === 'sess-next')?.pinned, false);
  assert.equal(persisted.length, 2);
});

test('enrichVisibleSessionPreviews 在 grouped 模式下跨 Bot 预热会话预览', async () => {
  const fetched = [];
  const previewCache = new Map();
  const { deps, state } = createMockDeps({
    state: {
      profileName: 'bot-a',
      leftRailLayout: 'dual-rail',
      sessions: [
        { id: 's-a', title: 'A 任务', botName: 'bot-a', timestamp: 2000, isArchived: false },
        { id: 's-b', title: 'B 任务', botName: 'bot-b', timestamp: 2000, isArchived: false },
      ],
    },
    gatewayClient: {
      call: async () => ({}),
      fetchSessionMessages: async () => ({ status: 'success', messages: [] }),
      fetchLastMessage: async (sessionId, opts) => {
        fetched.push({ sessionId, profile: opts?.profile });
        return { text: `preview:${sessionId}`, timestamp: 2500 };
      },
    },
    sessionPreviewCache: previewCache,
  });

  const service = createSessionOperationService(deps);
  await service.enrichVisibleSessionPreviews();
  assert.deepEqual(
    fetched,
    [{ sessionId: 's-a', profile: 'bot-a' }],
    'dual-rail 模式只预热当前选中的 Bot 会话',
  );

  fetched.length = 0;
  previewCache.clear();
  state.leftRailLayout = 'grouped';
  await service.enrichVisibleSessionPreviews();
  assert.deepEqual(
    fetched,
    [
      { sessionId: 's-a', profile: 'bot-a' },
      { sessionId: 's-b', profile: 'bot-b' },
    ],
    'grouped 模式必须跨 Bot 预热全量可见会话预览',
  );

  // grouped 模式必须在 slice(0, 10) 前先按置顶 + timestamp 倒序排序
  fetched.length = 0;
  previewCache.clear();
  const twelveSessions = Array.from({ length: 10 }, (_, idx) => ({
    id: `old-${idx}`,
    title: `Old ${idx}`,
    botName: 'bot-a',
    timestamp: 100 + idx,
    isArchived: false,
    pinned: false,
  }));
  twelveSessions.push(
    { id: 'newest-cross-bot', title: '最新跨Bot会话', botName: 'bot-b', timestamp: 99999, isArchived: false, pinned: false },
    { id: 'pinned-cross-bot', title: '置顶跨Bot会话', botName: 'bot-c', timestamp: 1, isArchived: false, pinned: true },
    { id: 'subagent-flag', title: '子代理标记', botName: 'bot-b', timestamp: 199999, isArchived: false, isSubagent: true },
    { id: 'subagent-src', title: '子代理来源', botName: 'bot-b', timestamp: 199999, isArchived: false, source: 'subagent' },
  );
  state.sessions = twelveSessions;
  await service.enrichVisibleSessionPreviews();
  assert.equal(fetched.length, 10);
  assert.equal(
    fetched.some((f) => f.sessionId === 'subagent-flag' || f.sessionId === 'subagent-src'),
    false,
    'isSubagent / source=subagent 会话不得参与预览预热',
  );
  assert.deepEqual(
    fetched.slice(0, 2),
    [
      { sessionId: 'pinned-cross-bot', profile: 'bot-c' },
      { sessionId: 'newest-cross-bot', profile: 'bot-b' },
    ],
    '必须优先预热置顶与最新会话，不得被头部旧会话挤出前 10 配额',
  );
});

test('createNewSession 返回新会话 ID / 失败返回 null；selectSession 同步跨 Bot profileName', async () => {
  // 1. 断线返回 null
  const offline = createMockDeps({ getGatewayClient: () => null });
  const offlineId = await createSessionOperationService(offline.deps).createNewSession({ profile: 'default', title: 'X' });
  assert.equal(offlineId, null);

  // 2. 缺句柄 / RPC 异常返回 null
  const noHandle = createMockDeps({
    gatewayClient: {
      call: async () => ({}),
      fetchSessionMessages: async () => ({ status: 'success', messages: [] }),
    },
  });
  assert.equal(await createSessionOperationService(noHandle.deps).createNewSession({ profile: 'default' }), null);

  const rpcReject = createMockDeps({
    gatewayClient: {
      call: async () => {
        throw new Error('RPC timeout');
      },
      fetchSessionMessages: async () => ({ status: 'success', messages: [] }),
    },
  });
  assert.equal(await createSessionOperationService(rpcReject.deps).createNewSession({ profile: 'default' }), null);

  // 3. 成功返回 storedId，且 selectSession 切换跨 Bot 会话时同步 state.profileName 与 loadMessages targetBotName
  const loadCalls = [];
  const ok = createMockDeps({
    loadMessages: async (sid, bot) => {
      loadCalls.push({ sid, bot });
    },
  });
  const okSvc = createSessionOperationService(ok.deps);
  const createdId = await okSvc.createNewSession({ profile: 'default', title: 'New' });
  assert.equal(createdId, 'sess-new');

  ok.state.profileName = 'default';
  ok.state.sessions.push({ id: 'sess-other-bot', title: 'Other Bot', botName: 'arch-wang', isArchived: false });
  await okSvc.selectSession('sess-other-bot', { botName: 'arch-wang' });
  assert.equal(ok.state.profileName, 'arch-wang', '跨 Bot 切换会话必须同步 state.profileName');
  assert.deepEqual(loadCalls, [{ sid: 'sess-other-bot', bot: 'arch-wang' }]);
});

test('跨 Profile 同 ID 归档隔离、恢复及 fetchArchivedSessions 部分 Profile 失败保护', async () => {
  // 1. default::s-dup 与 arch::s-dup 独立归档/恢复互不误伤
  const rpcLog = [];
  const { deps, state } = createMockDeps({
    state: {
      profileName: 'default',
      profiles: [
        { name: 'default', displayName: 'Default' },
        { name: 'arch', displayName: 'Arch' },
      ],
      sessions: [
        { id: 's-dup', title: 'Default Dup', botName: 'default', isArchived: false, timestamp: 200 },
        { id: 's-dup', title: 'Arch Dup', botName: 'arch', isArchived: false, timestamp: 100 },
      ],
      archivedSessions: [],
    },
    gatewayClient: {
      call: async (method, params) => {
        rpcLog.push({ method, params });
        return { ok: true };
      },
      fetchSessionMessages: async () => ({ status: 'success', messages: [] }),
    },
  });
  const svc = createSessionOperationService(deps);
  const archivedOk = await svc.setSessionArchived('s-dup', true, 'arch');
  assert.equal(archivedOk, true);
  assert.equal(rpcLog.at(-1).params.profile, 'arch');
  assert.deepEqual(
    state.sessions.map((s) => `${s.botName}:${s.id}`),
    ['default:s-dup'],
    '归档 arch::s-dup 绝不能误删 default::s-dup',
  );
  assert.deepEqual(
    state.archivedSessions.map((s) => `${s.botName}:${s.id}`),
    ['arch:s-dup'],
  );

  // 2. fetchArchivedSessions 当 arch 失败而 default 成功时，保留 arch 既有归档且 doneSessionsLoaded 必须为 false，同时隔离同 ID 跨 Profile 活跃滤除
  const partialHarness = createMockDeps({
    state: {
      profileName: 'default',
      profiles: [
        { name: 'default', displayName: 'Default' },
        { name: 'arch', displayName: 'Arch' },
      ],
      sessions: [
        { id: 's-dup', title: 'Default Active', botName: 'default', isArchived: false, timestamp: 300 },
      ],
      archivedSessions: [
        { id: 's-arch-cached', title: 'Arch Cached Done', botName: 'arch', isArchived: true, timestamp: 150 },
        { id: 's-dup', title: 'Arch Archived Dup', botName: 'arch', isArchived: true, timestamp: 120 },
      ],
      doneSessionsLoaded: false,
    },
    gatewayClient: {
      call: async () => ({}),
      fetchSessionMessages: async () => ({ status: 'success', messages: [] }),
      listSessions: async (prof) => {
        if (prof === 'default') {
          return {
            ok: true,
            sessions: [{ id: 's-dup', title: 'Default Active', botName: 'default', timestamp: 300, isArchived: false }],
          };
        }
        return { ok: true, sessions: [] };
      },
      listArchivedSessions: async (prof) => {
        if (prof === 'arch') return { ok: false, error: 'arch gateway timeout' };
        return {
          ok: true,
          sessions: [
            { id: 's-dup', title: 'Default Stale Archived', botName: 'default', isArchived: true, timestamp: 50 },
            { id: 's-def-done', title: 'Default Done', botName: 'default', isArchived: true, timestamp: 220 },
          ],
        };
      },
    },
  });
  const partialSvcInstance = createSessionOperationService(partialHarness.deps);
  await partialSvcInstance.fetchArchivedSessions({ force: true });
  assert.equal(partialHarness.state.doneSessionsLoaded, false, '部分 Profile 失败时 doneSessionsLoaded 绝不可为 true');
  assert.ok(partialHarness.state.doneError.includes('arch gateway timeout'));
  assert.deepEqual(
    partialHarness.state.archivedSessions.map((s) => `${s.botName}:${s.id}`),
    ['default:s-def-done', 'arch:s-arch-cached', 'arch:s-dup'],
    '失败 Profile 的已缓存归档必须保留，且仅过滤同 Profile 活跃 default:s-dup 而保留 arch:s-dup',
  );

  // 3. fetchSessions 返回 default:s-dup 活跃态时，仅清理同 Profile 归档副本而不误伤 arch:s-dup
  await partialSvcInstance.fetchSessions({ force: true });
  assert.equal(
    partialHarness.state.sessions.some((s) => s.botName === 'default' && s.id === 's-dup'),
    true,
  );
  assert.equal(
    partialHarness.state.archivedSessions.some((s) => s.botName === 'arch' && s.id === 's-dup'),
    true,
    'fetchSessions 按复合键清理 archivedSessions 时不得误删异 Profile 同 ID 归档',
  );

  // 4. activeSessionId 同 ID 跨 Profile 直接切换（default::s-dup -> arch::s-dup）不得被早退短路
  const crossLoadCalls = [];
  const crossHarness = createMockDeps({
    state: {
      activeSessionId: 's-dup',
      activeLiveSessionId: 'live-default-dup',
      profileName: 'default',
      profiles: [
        { name: 'default', displayName: 'Default' },
        { name: 'arch', displayName: 'Arch' },
      ],
      sessions: [
        { id: 's-dup', title: 'Default Dup', botName: 'default', isArchived: false },
      ],
      archivedSessions: [
        { id: 's-dup', title: 'Arch Dup Done', botName: 'arch', isArchived: true },
      ],
      messages: [{ id: 'm-old', role: 'assistant', content: 'from default' }],
    },
    loadMessages: async (sid, bot) => {
      crossLoadCalls.push({ sid, bot });
    },
  });
  await createSessionOperationService(crossHarness.deps).selectSession('s-dup', { botName: 'arch' });
  assert.equal(crossHarness.state.profileName, 'arch', '跨 Profile 同 ID 切换必须刷新 state.profileName');
  assert.deepEqual(crossLoadCalls, [{ sid: 's-dup', bot: 'arch' }]);

  // 5. createNewSession 指定 projectId 时规范化并登记 sessionCwds[storedId]，无 projectId 时不污染 sessionCwds
  const projHarness = createMockDeps({
    state: {
      projects: [{ id: 'proj-win', name: 'WinRepo', path: 'D:\\repos\\my-proj\\' }],
      sessionCwds: undefined,
    },
  });
  const projSvc = createSessionOperationService(projHarness.deps);
  await projSvc.createNewSession({ projectId: 'proj-win' });
  assert.equal(projHarness.state.sessionCwds['sess-new'], 'D:/repos/my-proj');
  const createdEntry = projHarness.state.sessions.find((s) => s.id === 'sess-new');
  assert.equal(createdEntry?.cwd, 'D:/repos/my-proj');

  const noProjHarness = createMockDeps({ state: { sessionCwds: {} } });
  await createSessionOperationService(noProjHarness.deps).createNewSession({});
  assert.equal(noProjHarness.state.sessionCwds['sess-new'], undefined);
});
