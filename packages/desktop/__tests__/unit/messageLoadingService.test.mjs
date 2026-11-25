/**
 * 消息加载、历史分页漫游与副标题同步服务（Message Loading Service）脱离 DOM 纯逻辑单测
 * (packages/desktop/__tests__/unit/messageLoadingService.test.mjs)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createMessageLoadingService } from '../../dist/renderer/services/messageLoadingService.mjs';

function createMockDeps(overrides = {}) {
  const sessionMessagesCache = new Map();
  const sessionPreviewCache = new Map();
  const botForeverChatCache = new Map();
  const activeRunningSessionIds = new Set();
  const unreadSessionIds = new Set();
  const rendered = [];

  let windowStart = 0;
  let windowEnd = 30;
  let userExpanded = false;

  const state = {
    activeSessionId: 'sess-1',
    activeLiveSessionId: 'live-1',
    profileName: 'default',
    profiles: [{ name: 'default', displayName: 'Default Bot' }],
    sessions: [
      { id: 'sess-1', title: 'Task 1', botName: 'default', timestamp: 100 },
      { id: 'sess-parent', title: 'Parent Task', botName: 'default', timestamp: 50 },
    ],
    messages: [],
    hasOlderMessages: false,
    isLoadingOlder: false,
    messagesPhase: 'ready',
    activeFocus: { type: 'session', sessionId: 'sess-1' },
    dockNotice: '',
    ...(overrides.state || {}),
  };

  const rpcCalls = [];
  const gatewayClient = overrides.gatewayClient ?? {
    call: async (method, params) => {
      rpcCalls.push({ method, params });
      return {};
    },
    fetchSessionMessages: async (sessionId, opts) => {
      rpcCalls.push({ method: 'fetchSessionMessages', sessionId, opts });
      return {
        status: 'success',
        messages: [
          { id: 'msg-older-1', row_id: 1, role: 'user', content: 'older prompt' },
          { id: 'msg-older-2', row_id: 2, role: 'assistant', content: 'older reply' },
        ],
        pagination: { returned: 2, total: 2 },
      };
    },
  };

  const deps = {
    getState: () => state,
    getGatewayClient: () => gatewayClient,
    render: () => { rendered.push(Date.now()); },
    sessionMessagesCache,
    cacheService: {
      openChannel: async () => ({ rows: [], fenceMax: 0 }),
      readOlderRows: async () => [],
      dropChannel: async () => {},
      applyRemoteWindow: async () => {},
    },
    persistMessagesToCache: () => {},
    syncPromptNavigatorMeta: () => {},
    syncPromptNavigatorFromScroll: () => {},
    scrollStreamToBottom: () => {},
    setPendingScrollToBottom: () => {},
    isStreamNearBottom: () => true,
    captureStreamAnchor: () => ({}),
    applyStreamAnchor: () => {},
    getMessageWindowStart: () => windowStart,
    setMessageWindowStart: (val) => { windowStart = val; },
    getMessageWindowEnd: () => windowEnd,
    setMessageWindowEnd: (val) => { windowEnd = val; },
    setMessageWindowUserExpanded: (val) => { userExpanded = val; },
    setCanvasStructureDirty: () => {},
    setSuppressPinBottomOnce: () => {},
    isGroupConversationActive: () => false,
    hostedRoomIds: new Set(['room-group-1']),
    formatSessionTime: (ts) => `time-${ts}`,
    formatTimestamp: (ts) => `ts-${ts}`,
    botActivityStore: {
      withActivityMap: (fn) => fn(new Map()),
      persist: () => {},
    },
    botForeverChatCache,
    sessionPreviewCache,
    persistSessionPreviewCache: () => {},
    getActiveStreamingStoredSessionId: () => null,
    defaultSessionHandleRegistry: {
      register: () => {},
      unregister: () => {},
      toStoredSessionId: (id) => id,
      toLiveId: () => '',
    },
    activeRunningSessionIds,
    activityTransitionTracker: { clear: () => {} },
    ...overrides,
  };

  return { deps, state, rpcCalls, rendered, sessionMessagesCache, sessionPreviewCache };
}

test('MessageLoadingService - 消息加载与游标管理测试', async (t) => {
  await t.test('1. parseRawMessages: 转换原始网关行为视图模型', async () => {
    const { deps } = createMockDeps();
    const service = createMessageLoadingService(deps);

    const vms = service.parseRawMessages([
      { id: '1', row_id: 1, role: 'user', content: 'hello' },
      { id: '2', row_id: 2, role: 'assistant', content: 'hi' },
    ]);

    assert.equal(vms.length, 2);
    assert.equal(vms[0].role, 'user');
    assert.equal(vms[0].content, 'hello');
    assert.equal(vms[0].rowId, 1);
  });

  await t.test('2. syncActiveSessionPreviewToRail: 正确反哺最后一条可见人类消息为副标题', async () => {
    const { deps, state, sessionPreviewCache } = createMockDeps();
    const service = createMessageLoadingService(deps);

    const messages = [
      { id: '1', role: 'user', content: 'User question', rawTimestamp: 1000 },
      { id: '2', role: 'assistant', content: 'Agent response message', rawTimestamp: 2000 },
      { id: '3', role: 'system', displayKind: 'hidden', content: 'internal telemetry', rawTimestamp: 3000 },
    ];

    service.syncActiveSessionPreviewToRail('sess-1', messages, 'default');

    const sess = state.sessions.find((s) => s.id === 'sess-1');
    assert.equal(sess?.preview, 'Agent response message', '预览必须是最后一条非 hidden 真实内容');
    assert.equal(sess?.timestamp, 2000, '时间戳必须与最后一条可见人类消息对齐');
    const cached = sessionPreviewCache.get('sess-1');
    assert.equal(cached?.text, 'Agent response message', '缓存也必须记录权威副标题');
  });

  await t.test('3. forgetOlderCursorState: 彻底清理 offset 与 overshootRetry 状态', async () => {
    const { deps } = createMockDeps();
    const service = createMessageLoadingService(deps);

    service.sessionServerOffset.set('sess-1', 100);
    service.sessionAuthoritativeOffset.set('sess-1', 100);
    service.sessionOvershootRetry.add('sess-1:sess-1');
    service.sessionOvershootRetry.add('sess-other:sess-other');

    service.forgetOlderCursorState('sess-1');

    assert.equal(service.sessionServerOffset.has('sess-1'), false);
    assert.equal(service.sessionAuthoritativeOffset.has('sess-1'), false);
    assert.equal(service.sessionOvershootRetry.has('sess-1:sess-1'), false);
    assert.equal(service.sessionOvershootRetry.has('sess-other:sess-other'), true, '其它会话游标标记不得误删');
  });

  await t.test('4. syncUntrustedCacheOrderFlag: 识别旧版未排序缓存行', async () => {
    const { deps } = createMockDeps();
    const service = createMessageLoadingService(deps);

    service.syncUntrustedCacheOrderFlag('sess-clean', [{ orderKey: 1, displaySeq: 1 }]);
    assert.equal(service.untrustedOrderCacheSessions.has('sess-clean'), false, '具备合法 displaySeq 为干净缓存');

    service.syncUntrustedCacheOrderFlag('sess-dirty', [{ orderKey: 1 }]);
    assert.equal(service.untrustedOrderCacheSessions.has('sess-dirty'), true, '缺少 displaySeq 必须标记为不可信');
  });

  await t.test('5. loadMessages: 命中内存缓存时 0ms 呈现并收敛状态', async () => {
    const { deps, state, sessionMessagesCache } = createMockDeps();
    const cachedList = [
      { id: 'c1', rowId: 1, role: 'user', content: 'cached user' },
      { id: 'c2', rowId: 2, role: 'assistant', content: 'cached agent' },
    ];
    sessionMessagesCache.set('sess-1', cachedList);
    const service = createMessageLoadingService(deps);

    await service.loadMessages('sess-1');

    assert.equal(state.messages.length, 2, '必须立即上屏缓存消息');
    assert.equal(state.messagesPhase, 'ready', '缓存命中必须立即收敛为 ready 相位');
  });

  await t.test('6. loadOlderMessages: 群聊房间直接拦截，坚决不打单会话 REST', async () => {
    const { deps, state, rpcCalls } = createMockDeps();
    state.activeSessionId = 'room-group-1'; // 属于 hostedRoomIds
    const service = createMessageLoadingService(deps);

    await service.loadOlderMessages();

    assert.equal(rpcCalls.length, 0, '群聊研讨室绝对禁止发起单会话向早分页 REST');
    assert.equal(state.isLoadingOlder, false, '加载状态必须同步关闭');
  });
});

test('MessageLoadingService - 长任务重进发现/续流、omit_messages 兼容降级与静默无变更不重绘', async (t) => {
  await t.test('7. 重进运行中会话（含 Extra inputs 回退 omit_messages）必须通知 onActiveTurnDiscovered 且隔离 Bot 与普通会话', async () => {
    const discovered = [];
    const rpcCalls = [];
    const { deps, state } = createMockDeps();
    deps.botForeverChatCache.set('arch-bot', 'sess-forever-1');
    deps.getGatewayClient = () => ({
      fetchSessionMessages: async () => ({
        status: 'success',
        messages: [{ id: 1, role: 'user', content: 'persisted q', timestamp: 1000 }],
      }),
      call: async (method, params) => {
        rpcCalls.push({ method, params });
        if (params.omit_messages) {
          throw { code: -32602, message: 'Extra inputs are not permitted' };
        }
        return {
          session_id: 'live-reenter-1',
          stored_session_id: params.session_id,
          running: true,
          turn_started_at: 1700000005,
          inflight: { streaming: true, user: 'persisted q', assistant: 'still thinking' },
        };
      },
    });
    deps.onActiveTurnDiscovered = (info) => discovered.push(info);
    const service = createMessageLoadingService(deps);

    // A. 普通会话：发现运行中回合，botName 必须为 null（不得污染 Bot）
    await service.loadMessages('sess-1', 'arch-bot');
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(rpcCalls.some((c) => c.params.omit_messages === true), true, 'fastLoaded 时应优先带 omit_messages: true');
    assert.equal(deps.activeRunningSessionIds.has('sess-1'), true);
    assert.equal(discovered.length, 1);
    assert.equal(discovered[0].storedSessionId, 'sess-1');
    assert.equal(discovered[0].liveSessionId, 'live-reenter-1');
    assert.equal(discovered[0].botName, null, '普通会话绝不得归属 Bot');

    // B. Forever Chat 会话：botName 必须准确识别为 arch-bot
    state.activeSessionId = 'sess-forever-1';
    await service.loadMessages('sess-forever-1', 'arch-bot');
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(discovered[1].storedSessionId, 'sess-forever-1');
    assert.equal(discovered[1].botName, 'arch-bot');
  });

  await t.test('8. 流式早退恢复缺失 activeLiveSessionId/气泡，checkLiveTurn:true 穿透校对运行态', async () => {
    const stillStreaming = [];
    const { deps, state, sessionMessagesCache } = createMockDeps({
      getLiveStreamRegistry: () => ({
        hasSession: (sid) => sid === 'sess-1',
        getBySession: (sid) => (sid === 'sess-1'
          ? { storedSessionId: 'sess-1', liveSessionId: 'live-stream-99', messageId: 'ast-live-99', accumulatedText: 'partial', startedAt: 12000 }
          : undefined),
      }),
      onReconnectStillStreaming: (sid, lid, res) => stillStreaming.push({ sid, lid, running: Boolean(res?.running) }),
    });
    sessionMessagesCache.set('sess-1', [{ id: 'u1', role: 'user', content: 'hi', rowId: 1 }]);
    state.activeLiveSessionId = '';
    let resumeCount = 0;
    deps.getGatewayClient = () => ({
      fetchSessionMessages: async () => ({ status: 'success', messages: [] }),
      call: async () => {
        resumeCount += 1;
        return { session_id: 'live-stream-99', stored_session_id: 'sess-1', running: true };
      },
    });
    const service = createMessageLoadingService(deps);

    await service.loadMessages('sess-1');
    assert.equal(resumeCount, 0, '常规加载流式会话必须早退不重复调 session.resume');
    assert.equal(state.activeLiveSessionId, 'live-stream-99', '必须恢复丢失的 activeLiveSessionId');
    assert.equal(state.isStreaming, true);
    assert.equal(state.messages.some((m) => m.id === 'ast-live-99' && m.content === 'partial'), true, '若流式气泡尚未落进列表须从注册表补回');

    await service.refreshActiveSession({ checkLiveTurn: true });
    assert.equal(resumeCount, 1, 'checkLiveTurn: true 必须穿透探活');
    assert.deepEqual(stillStreaming, [{ sid: 'sess-1', lid: 'live-stream-99', running: true }]);
  });

  await t.test('9. silent 静默刷新在消息完全一致时不触发无效 render()，远端新增消息时立即上屏并 render()', async () => {
    const { deps, state, rendered } = createMockDeps();
    state.activeSessionId = 'sess-1';
    let serverRows = [
      { id: 1, role: 'user', content: 'q1', timestamp: 1000 },
      { id: 2, role: 'assistant', content: 'a1', timestamp: 2000 },
    ];
    deps.getGatewayClient = () => ({
      fetchSessionMessages: async () => ({ status: 'success', messages: serverRows }),
      call: async () => ({ session_id: 'live-1', stored_session_id: 'sess-1', running: false }),
    });
    const service = createMessageLoadingService(deps);

    await service.loadMessages('sess-1');
    const baselineRenders = rendered.length;

    // 服务端内容一致 -> 静默刷新不得触发无意义的 render()
    await service.refreshActiveSession({ checkLiveTurn: true });
    assert.equal(rendered.length, baselineRenders, '消息完全相同时静默刷新不得多余 render');

    // 另一端发来新消息 -> 静默刷新必须立即上屏并 render()
    serverRows = [
      ...serverRows,
      { id: 3, role: 'user', content: 'from desktop', timestamp: 3000 },
    ];
    await service.refreshActiveSession({ checkLiveTurn: true });
    assert.equal(state.messages.length, 3);
    assert.equal(state.messages[2].content, 'from desktop');
    assert.equal(rendered.length, baselineRenders + 1, '有新消息同步到达时必须触发 render()');
  });
});

test('MessageLoadingService: Step 5 发现后台在途回合通知 onActiveTurnDiscovered，且异常与运行态结束分支不崩', async () => {
  const discovered = [];
  const finished = [];
  let resumeShouldFail = false;
  let resumeRunning = true;
  let clientStreamingId = null;
  const { deps, state, sessionMessagesCache } = createMockDeps({
    state: {
      activeSessionId: 'sess-forever',
      activeLiveSessionId: '',
      activeFocus: { type: 'bot', botName: 'arch-bot' },
      sessions: [{ id: 'sess-forever', title: 'Forever', botName: 'arch-bot', timestamp: 100 }],
    },
    getActiveStreamingStoredSessionId: () => clientStreamingId,
    onActiveTurnDiscovered: (info) => {
      discovered.push(info);
    },
    onReconnectStreamFinished: (sid) => {
      finished.push(sid);
      clientStreamingId = null;
    },
    gatewayClient: {
      fetchSessionMessages: async () => ({
        status: 'success',
        messages: [{ id: 'u-1', row_id: 1, role: 'user', content: 'hi' }],
        pagination: { returned: 1, total: 1 },
      }),
      call: async (method) => {
        if (method === 'session.resume') {
          if (resumeShouldFail) throw new Error('resume boom');
          return {
            session_id: 'live-disc',
            running: resumeRunning,
            inflight: resumeRunning ? { streaming: true, assistant: 'ok' } : null,
          };
        }
        return {};
      },
    },
  });
  deps.botForeverChatCache.set('arch-bot', 'sess-forever');
  sessionMessagesCache.set('sess-forever', [{ id: 'u-1', rowId: 1, role: 'user', content: 'hi' }]);
  const service = createMessageLoadingService(deps);

  // a) ForeverChat loadMessages 完成后 Step 5 发现 running=true 通知 onActiveTurnDiscovered
  await service.loadMessages('sess-forever');
  assert.equal(discovered.length, 1);
  assert.equal(discovered[0].storedSessionId, 'sess-forever');
  assert.equal(discovered[0].liveSessionId, 'live-disc');
  assert.equal(discovered[0].botName, 'arch-bot');
  assert.equal(discovered[0].resumeResult.running, true);

  // b) 客户端原以为在流式但 session.resume 返回 running=false 时触发 finished 收敛
  resumeRunning = false;
  clientStreamingId = 'sess-forever';
  await service.refreshActiveSession({ checkLiveTurn: true });
  assert.equal(discovered.length, 1);
  assert.deepEqual(finished, ['sess-forever']);

  // c) session.resume 抛错时不中断历史消息加载流程
  resumeShouldFail = true;
  await service.loadMessages('sess-forever', { forceReload: true });
  assert.equal(state.messages.length, 1);
});

test('MessageLoadingService - areMessageListsEquivalent / callSessionResume 多段降级 / 无注册表兜底与权威清理', async () => {
  let fetchRows = [
    { id: 'u1', row_id: 10, role: 'user', content: 'hello' },
    {
      id: 'a1',
      row_id: 11,
      role: 'assistant',
      content: 'done',
      thought: 't1',
      tool_calls: [{ id: 'tc-1', name: 'terminal', status: 'completed', output: 'ok' }],
    },
  ];
  const resumePayloads = [];
  let resumeBehavior = async () => ({ session_id: 'live-1', running: false });
  let fetchShouldFail = false;
  const logs = [];
  let streamingId = null;

  const { deps, state, rendered } = createMockDeps({
    getActiveStreamingStoredSessionId: () => streamingId,
    defaultSessionHandleRegistry: {
      register: () => {},
      unregister: () => {},
      toStoredSessionId: (id) => id,
      toLiveId: () => '',
    },
    logSession: {
      debug: (...a) => logs.push(['debug', ...a]),
      info: (...a) => logs.push(['info', ...a]),
    },
    gatewayClient: {
      fetchSessionMessages: async () => {
        if (fetchShouldFail) throw new Error('rest offline');
        return {
          status: 'success',
          messages: fetchRows,
          pagination: { returned: fetchRows.length, total: fetchRows.length },
        };
      },
      call: async (method, params) => {
        if (method === 'session.resume') {
          resumePayloads.push(params);
          return resumeBehavior(params);
        }
        return {};
      },
    },
  });

  // 1. omitMessages=false 遇到 Extra inputs 直接降级为裸 { session_id }，并落盘 running=true 触发权威清理日志
  const activeSet = deps.activeRunningSessionIds;
  activeSet.add('sess-1');
  resumeBehavior = async (params) => {
    if ('profile' in params) throw new Error('Extra inputs are not permitted');
    return { session_id: 'live-fallback', running: false, inflight: null };
  };
  const service = createMessageLoadingService(deps);
  await service.loadMessages('sess-1');
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(activeSet.has('sess-1'), false, 'authoritative idle must prune orphan running session');
  assert.ok(logs.some((entry) => entry[0] === 'info' && String(entry[1]).includes('reconciled orphan running state')));

  // 2. silent 刷新命中 areMessageListsEquivalent 全分支：
  //   a) 完全等价 (含 toolCalls id + status 相同) -> 不触发无效 render
  const rendersBeforeEq = rendered.length;
  await service.refreshActiveSession();
  assert.equal(rendered.length, rendersBeforeEq, '消息与 toolCalls 完全一致时不得重绘');

  //   b) toolCalls id 改变 -> 触发 render (L186 left)
  const rendersBeforeTcId = rendered.length;
  fetchRows = [
    { id: 'u1', row_id: 10, role: 'user', content: 'hello' },
    {
      id: 'a1',
      row_id: 11,
      role: 'assistant',
      content: 'done',
      thought: 't1',
      tool_calls: [{ id: 'tc-2', name: 'terminal', status: 'completed', output: 'ok' }],
    },
  ];
  await service.refreshActiveSession();
  assert.ok(rendered.length > rendersBeforeTcId, 'toolCall.id 变化必须触发重绘');

  //   c) toolCalls status 改变 -> 触发 render (L185-L187)
  const rendersBeforeTcStatus = rendered.length;
  fetchRows = [
    { id: 'u1', row_id: 10, role: 'user', content: 'hello' },
    {
      id: 'a1',
      row_id: 11,
      role: 'assistant',
      content: 'done',
      thought: 't1',
      tool_calls: [{ id: 'tc-2', name: 'terminal', status: 'failed', output: 'err' }],
    },
  ];
  await service.refreshActiveSession();
  assert.ok(rendered.length > rendersBeforeTcStatus, 'toolCall.status 变化必须触发重绘');

  //   d) 同长度 content 改变 -> L182 返回 false 触发 render
  const rendersBeforeContent = rendered.length;
  fetchRows = [
    { id: 'u1', row_id: 10, role: 'user', content: 'hello' },
    {
      id: 'a1',
      row_id: 11,
      role: 'assistant',
      content: 'done-edited',
      thought: 't1',
      tool_calls: [{ id: 'tc-2', name: 'terminal', status: 'failed', output: 'err' }],
    },
  ];
  await service.refreshActiveSession();
  assert.ok(rendered.length > rendersBeforeContent, '同长度 content 变化必须触发重绘');

  // 3. 流式无注册表兜底 + defaultSessionHandleRegistry.toLiveId 命中与回落 sessionId (L475)
  streamingId = 'sess-1';
  state.activeLiveSessionId = '';
  await service.loadMessagesInner('sess-1', undefined, { silent: false });
  assert.equal(state.activeLiveSessionId, 'sess-1');
  deps.defaultSessionHandleRegistry.toLiveId = (sid) => `live-mapped-${sid}`;
  state.activeLiveSessionId = '';
  await service.loadMessagesInner('sess-1', undefined, { silent: false });
  assert.equal(state.activeLiveSessionId, 'live-mapped-sess-1');
  deps.defaultSessionHandleRegistry.toLiveId = () => '';

  // 4. callSessionResume(omitMessages=true) 三级降级全路径：
  //   a) 1st Extra inputs -> 2nd Extra inputs -> 3rd 裸 { session_id } 成功 (L380, L381, L384)
  await new Promise((r) => setTimeout(r, 20));
  resumePayloads.length = 0;
  resumeBehavior = async (params) => {
    if ('omit_messages' in params || 'profile' in params) {
      throw new Error('Extra inputs are not permitted');
    }
    return { session_id: 'live-3rd', running: true, inflight: { streaming: true, assistant: 'ok' } };
  };
  await service.refreshActiveSession({ checkLiveTurn: true });
  assert.deepEqual(resumePayloads, [
    { session_id: 'sess-1', profile: 'default', omit_messages: true },
    { session_id: 'sess-1', profile: 'default' },
    { session_id: 'sess-1' },
  ]);

  //   b) 1st Extra inputs -> 2nd 抛非 Extra inputs 错误 -> 原样抛出由上层保护捕获 (L381, L382)
  resumePayloads.length = 0;
  resumeBehavior = async (params) => {
    if ('omit_messages' in params) throw new Error('Extra inputs are not permitted');
    throw new Error('upstream gateway 503');
  };
  await service.refreshActiveSession({ checkLiveTurn: true });
  assert.equal(resumePayloads.length, 2, '非 Extra inputs 错误不可降级第三次并安全保留实时缓冲区');

  //   c) omitMessages=false（REST fetchSessionMessages 失败 -> fastLoaded=false）遇到 Extra inputs 降级为 { session_id } (L387)
  streamingId = null;
  fetchShouldFail = true;
  resumePayloads.length = 0;
  resumeBehavior = async (params) => {
    if ('profile' in params) throw new Error('Extra inputs are not permitted');
    return { session_id: 'live-no-fast', running: false };
  };
  await service.loadMessages('sess-1');
  await new Promise((r) => setTimeout(r, 25));
  assert.deepEqual(resumePayloads, [
    { session_id: 'sess-1', profile: 'default' },
    { session_id: 'sess-1' },
  ]);
  fetchShouldFail = false;
});

test('MessageLoadingService 变异消杀全边界：构造代际/列表全字段比对/refreshActiveSession/重连钩子与权威状态收敛', async () => {
  const events = [];
  let isStreamingForSess = false;
  let streamEntry = null;
  let gatewayPresent = true;
  let resumeBehavior = async () => ({ session_id: 'live-bg', running: false });
  const resumePayloads = [];
  let fetchRows = [
    { id: 'u1', row_id: 1, role: 'user', content: 'q' },
    { id: 'a1', row_id: 2, role: 'assistant', content: 'ans', thought: 'th', tool_calls: [{ id: 'tc1', name: 'bash', status: 'completed' }] },
  ];
  let fetchReturnedOverride;

  const { deps, state, rendered } = createMockDeps({
    getGeneration: () => 7,
    isGroupConversationActive: (sid) => sid === 'sess-group',
    getActiveStreamingStoredSessionId: () => (isStreamingForSess ? 'sess-1' : null),
    getLiveStreamRegistry: () => ({
      hasSession: (sid) => Boolean(streamEntry && sid === 'sess-1'),
      getBySession: (sid) => (sid === 'sess-1' ? streamEntry : undefined),
    }),
    defaultSessionHandleRegistry: {
      register: (h) => events.push(['register', h.liveId]),
      unregister: () => {},
      toStoredSessionId: (id) => id,
      toLiveId: () => 'live-mapped',
    },
    gatewayClient: {
      fetchSessionMessages: async () => ({
        status: 'success',
        messages: fetchRows,
        pagination: { returned: fetchReturnedOverride ?? fetchRows.length, total: fetchReturnedOverride ?? fetchRows.length },
      }),
      call: async (method, params) => {
        if (method === 'session.resume') {
          resumePayloads.push(params);
          return resumeBehavior(params);
        }
        return {};
      },
    },
  });
  const baseGw = deps.gatewayClient;
  const wrappedDeps = {
    ...deps,
    getGatewayClient: () => (gatewayPresent ? baseGw : null),
  };
  wrappedDeps.botForeverChatCache.set('forever-bot', 'sess-1');
  wrappedDeps.activeRunningSessionIds.add('sess-1');

  const svc = createMessageLoadingService(wrappedDeps);
  assert.equal(svc.getActiveLoadMessagesGeneration(), 7, 'constructor 必须同步注入初始 generation (L236)');

  // 1. areMessageListsEquivalent 逐字段差异比对 + silent 不变时保留 dockNotice (L175-184, L641-642)
  fetchRows = [
    { id: 'u1', role: 'user', content: 'q' },
    { id: 'a1', role: 'assistant', content: 'ans', thought: 'th', tool_calls: [{ id: 'tc1', name: 'bash', status: 'completed' }] },
  ];
  await svc.loadMessages('sess-1');
  await new Promise((r) => setTimeout(r, 20));
  state.dockNotice = 'keep-silent-notice';
  const rBeforeEq = rendered.length;
  await svc.refreshActiveSession();
  assert.equal(rendered.length, rBeforeEq);
  assert.equal(state.dockNotice, 'keep-silent-notice', 'silent 且列表无变化时不得清空 dockNotice');

  const mutateAndCheckRender = async (nextRow) => {
    const before = rendered.length;
    wrappedDeps.sessionMessagesCache.delete('sess-1');
    svc.markSessionServerPriority('sess-1');
    fetchRows = [fetchRows[0], nextRow];
    await svc.refreshActiveSession();
    assert.ok(rendered.length > before, `字段变化必须触发 render: ${JSON.stringify(nextRow)}`);
  };
  await mutateAndCheckRender({ id: 'a1-new', role: 'assistant', content: 'ans', thought: 'th', tool_calls: [{ id: 'tc1', name: 'bash', status: 'completed' }] });
  await mutateAndCheckRender({ id: 'a1-new', role: 'user', content: 'ans', thought: 'th', tool_calls: [{ id: 'tc1', name: 'bash', status: 'completed' }] });
  await mutateAndCheckRender({ id: 'a1-new', role: 'user', content: 'ans', thought: 'th-diff', tool_calls: [{ id: 'tc1', name: 'bash', status: 'completed' }] });
  await mutateAndCheckRender({ id: 'a1-new', row_id: 9, role: 'user', content: 'ans', thought: 'th-diff', tool_calls: [{ id: 'tc1', name: 'bash', status: 'completed' }] });
  await mutateAndCheckRender({ id: 'a1-new', row_id: 9, role: 'user', content: 'ans', thought: 'th-diff', tool_calls: [{ id: 'tc1', name: 'bash', status: 'completed' }, { id: 'tc2', name: 'read', status: 'completed' }] });
  // tool_calls 从有变无 & 双方均无 toolCalls 时也必须正常工作
  await mutateAndCheckRender({ id: 'a1-new', row_id: 9, role: 'user', content: 'ans', thought: 'th-diff' });
  const rNoTcEq = rendered.length;
  await svc.refreshActiveSession();
  assert.equal(rendered.length, rNoTcEq);

  // 2. merged.length > serverKnownCount 时 hasOlderMessages 恒为 true (L638-639)
  wrappedDeps.sessionMessagesCache.set('sess-1', [
    { id: 'u1', rowId: 1, role: 'user', content: 'q' },
    { id: 'a1-new', rowId: 9, role: 'user', content: 'ans' },
    { id: 'extra-local', role: 'assistant', content: 'local-only' },
  ]);
  fetchReturnedOverride = 1;
  state.hasOlderMessages = false;
  await svc.loadMessages('sess-1');
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(state.hasOlderMessages, true);
  fetchReturnedOverride = undefined;

  // 3. refreshActiveSession 早退与 bot/session/profileName 分支 (L395-398)
  resumePayloads.length = 0;
  state.activeSessionId = '';
  await svc.refreshActiveSession();
  state.activeSessionId = 'sess-group';
  await svc.refreshActiveSession();
  assert.equal(resumePayloads.length, 0);

  state.activeSessionId = 'sess-1';
  state.activeFocus = { type: 'bot', botName: 'bot-focus' };
  await svc.refreshActiveSession();
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(resumePayloads.at(-1).profile, 'bot-focus');

  state.activeFocus = { type: 'session', sessionId: 'sess-1' };
  state.sessions = [{ id: 'other', botName: 'x' }, { id: 'sess-1', botName: 'sess-bot' }];
  await svc.refreshActiveSession();
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(resumePayloads.at(-1).profile, 'sess-bot');

  state.sessions = [{ id: 'sess-1' }];
  state.profileName = 'fallback-prof';
  await svc.refreshActiveSession();
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(resumePayloads.at(-1).profile, 'fallback-prof');

  // 4. callSessionResume omitMessages=false 首次即非 Extra inputs 时绝不重试 (L371)
  resumePayloads.length = 0;
  const origFetch = baseGw.fetchSessionMessages;
  baseGw.fetchSessionMessages = async () => { throw new Error('rest down'); };
  resumeBehavior = async () => { throw new Error('unauthorized 401'); };
  await svc.loadMessages('sess-1');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(resumePayloads.length, 1);
  assert.match(state.dockNotice, /unauthorized 401/);
  baseGw.fetchSessionMessages = origFetch;

  // 5. isSessionStreaming(!shouldProbeLive): 已有 activeLiveSessionId 不覆盖、existingStream 补插与去重 (L473, L479-490)
  isStreamingForSess = true;
  streamEntry = { storedSessionId: 'sess-1', liveSessionId: 'l-str', messageId: 'ast-str', accumulatedText: 'live', startedAt: 100 };
  state.activeLiveSessionId = 'keep-live';
  state.messages = [{ id: 'u1', role: 'user', content: 'q' }];
  const rBeforeAdd = rendered.length;
  await svc.loadMessagesInner('sess-1', undefined, { silent: true });
  assert.equal(state.activeLiveSessionId, 'keep-live');
  assert.equal(state.messages.some((m) => m.id === 'ast-str' && m.role === 'assistant'), true);
  assert.equal(wrappedDeps.sessionMessagesCache.get('sess-1').some((m) => m.id === 'ast-str'), true);
  assert.equal(rendered.length, rBeforeAdd + 1);
  const rBeforeDup = rendered.length;
  await svc.loadMessagesInner('sess-1', undefined, { silent: true });
  assert.equal(state.messages.filter((m) => m.id === 'ast-str').length, 1);
  assert.equal(rendered.length, rBeforeDup, 'state.messages 已含 ast-str 时不得重复补插与重绘');

  // 6. setReconnectHooks + checkLiveTurn 全路径 (L255, L496, L502, L504, L511-528, L645-646, L758, L775-779)
  svc.setReconnectHooks({
    onReconnectStillStreaming: (sid, lid) => events.push(['hook-still', sid, lid]),
    onReconnectStreamFinished: (sid) => events.push(['hook-finished', sid]),
    onActiveTurnDiscovered: (info) => events.push(['hook-discovered', info.botName, info.liveSessionId]),
    onForceSyncMessageList: (force) => events.push(['hook-force-sync', force]),
  });

  // 6a) gatewayClient 为 null 时 checkLiveTurn 安全早退
  gatewayPresent = false;
  await svc.loadMessagesInner('sess-1', undefined, { silent: true, checkLiveTurn: true });
  gatewayPresent = true;

  // 6b) silent=true 且 messages 为空时 omit_messages 不得为 true (L502)
  resumePayloads.length = 0;
  state.messages = [];
  resumeBehavior = async () => ({ session_id: '', running: true, inflight: { streaming: true } });
  await svc.loadMessagesInner('sess-1', undefined, { silent: true, checkLiveTurn: true });
  assert.equal('omit_messages' in resumePayloads.at(-1), false);
  assert.equal(state.activeLiveSessionId, 'sess-1', 'checkHandles 为空时 activeLiveSessionId 必须回落 sessionId');
  assert.ok(events.some((e) => e[0] === 'hook-still' && e[1] === 'sess-1'));

  // 6c) checkRes 在途时 generation 变化 -> L504 早退不注册/不触发 hook
  let releaseCheck;
  resumeBehavior = () => new Promise((r) => { releaseCheck = r; });
  const eventsBeforeStale = events.length;
  const staleCheckP = svc.loadMessagesInner('sess-1', undefined, { silent: true, checkLiveTurn: true });
  svc.incrementGeneration();
  releaseCheck({ session_id: 'stale-live', running: true, inflight: { streaming: true } });
  await staleCheckP;
  assert.equal(events.length, eventsBeforeStale);

  // 6d) checkRes running=false -> 触发 onReconnectStreamFinished + onForceSyncMessageList(true) (L527-528, L645-646) + resolveForeverBotName (L775-779)
  let seq = 0;
  resumeBehavior = async () => {
    seq += 1;
    if (seq === 1) return { session_id: 'live-ended', running: false };
    return { session_id: 'live-bg-active', running: true, inflight: { streaming: true } };
  };
  await svc.loadMessagesInner('sess-1', undefined, { silent: true, checkLiveTurn: true });
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(events.some((e) => e[0] === 'hook-finished' && e[1] === 'sess-1'));
  assert.ok(events.some((e) => e[0] === 'hook-force-sync' && e[1] === true));
  assert.ok(events.some((e) => e[0] === 'hook-discovered' && e[1] === 'forever-bot'));

  // 6e) background session.resume 返回 null 时安全跳过 (L758)
  isStreamingForSess = false;
  streamEntry = null;
  resumeBehavior = async () => null;
  await svc.loadMessages('sess-1');
  await new Promise((r) => setTimeout(r, 15));
});
