/**
 * 桌面端 InteractivePromptService、Model Confirm、焦点隔离、视口底部留白与左轨等待汇总单测
 * (packages/desktop/__tests__/unit/interactive-prompt-service.test.mjs)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createInteractivePromptService } from '../../dist/renderer/services/interactivePromptService.mjs';
import { isProtectedIslandFocus, collectBotForeverSessionMap } from '../../dist/renderer/interactiveWiring.mjs';
import { createSessionOperationService } from '../../dist/renderer/services/sessionOperationService.mjs';
import { StreamViewportManager } from '../../dist/renderer/viewport/streamViewportManager.mjs';
import { LeftRailSnapshotManager } from '../../dist/renderer/leftrail/leftRailSnapshotManager.mjs';

function makeBaseState(overrides = {}) {
  return {
    activeFocus: { type: 'session', sessionId: 'sess-1' },
    activeSessionId: 'sess-1',
    activeLiveSessionId: 'live-1',
    profileName: 'default',
    selectedModel: 'claude-3-5-sonnet',
    recentModels: [],
    modelMenuOpen: false,
    approvalMode: 'manual',
    dockNotice: '',
    gatewayConnected: true,
    sessions: [{ id: 'sess-1', title: 'Session 1', botName: 'default' }],
    profiles: [{ name: 'default', displayName: 'Default' }],
    groupRooms: [],
    archivedSessions: [],
    projects: [],
    orgFolders: [],
    orgAssignments: {},
    orgDoneRooms: {},
    orgContainerCollapsed: { done: true },
    ...overrides,
  };
}

function createFakeRegistry(map = new Map([['live-1', 'sess-1']])) {
  return {
    getRegisteredLiveId: (stored) => {
      for (const [live, st] of map.entries()) if (st === stored) return live;
      return null;
    },
    getStoredId: (live) => map.get(live) ?? null,
    register: ({ storedId, liveId }) => { map.set(liveId, storedId); },
    clear: () => map.clear(),
  };
}

test('InteractivePromptService: live WS 回复、socket 切代 RPC 降级、clarify.lock 与 resetOnDisconnect 恢复', async () => {
  const state = makeBaseState();
  const wsSent = [];
  const rpcCalls = [];
  let socketGen = 1;
  let changeCount = 0;
  let failClarifyRpc = false;

  const client = {
    getSocketGeneration: () => socketGen,
    getNegotiatedCapabilities: () => ({ server_requests: true }),
    sendServerResponse: (id, result, expectedGen) => {
      if (expectedGen !== socketGen) return false;
      wsSent.push({ id, result });
      return true;
    },
    call: async (method, params) => {
      rpcCalls.push({ method, params });
      if ((method === 'request.answer' || method === 'clarify.respond') && failClarifyRpc) {
        const err = new Error('transient network timeout');
        err.code = -32000;
        throw err;
      }
      if (method === 'clarify.lock') {
        return params.question_id === 'q2' ? { status: 'ok', remaining: [] } : { status: 'ok', remaining: ['q2'] };
      }
      if (method === 'approval.pending') {
        return {
          approvals: [{ request_id: 'pend-1', command: 'npm publish', choices: ['once', 'deny'] }],
        };
      }
      return { status: 'ok' };
    },
  };

  const svc = createInteractivePromptService({
    getState: () => state,
    getGatewayClient: () => client,
    getSessionHandleRegistry: () => createFakeRegistry(),
    toStoredSessionId: (id) => (id === 'live-1' ? 'sess-1' : id ?? null),
    resolveBotForeverSessionMap: () => new Map(),
    resolveBotNameForSession: () => 'default',
    describeRpcError: (e) => (e instanceof Error ? e.message : String(e)),
    onPromptsChanged: () => { changeCount += 1; },
    now: () => 10_000,
  });

  // 1. Live WS clarify -> WS response settlement
  const accepted = svc.handleServerRequest(
    {
      id: 'srv-1',
      method: 'clarify',
      params: {
        session_id: 'live-1',
        questions: [
          { qid: 'q1', question: 'Q1?' },
          { qid: 'q2', question: 'Q2?' },
        ],
      },
      socketGeneration: 1,
    },
    client,
  );
  assert.equal(accepted, true);
  assert.equal(svc.getActivePromptsForCurrentFocus().length, 1);

  const [clarify] = svc.getActivePromptsForCurrentFocus();
  await svc.lockClarifyAnswer(clarify, 'q1', 'Ans1');
  assert.equal(rpcCalls[0].method, 'clarify.lock');
  assert.equal(rpcCalls[0].params.profile, 'default');
  assert.equal(svc.getActivePromptsForCurrentFocus().length, 1);

  // Locking q2 empties remaining[] -> settles automatically
  await svc.lockClarifyAnswer(svc.getActivePromptsForCurrentFocus()[0], 'q2', 'Ans2');
  assert.equal(svc.getActivePromptsForCurrentFocus().length, 0);

  // 2. Socket generation rotation triggers transparent RPC fallback (request.answer)
  svc.handleServerRequest(
    {
      id: 'srv-2',
      method: 'secret',
      params: { session_id: 'live-1', env_var: 'TOKEN' },
      socketGeneration: 1,
    },
    client,
  );
  socketGen = 2; // rotated!
  svc.handleSocketClosed(1);
  const [secretPrompt] = svc.getActivePromptsForCurrentFocus();
  const settledSecret = await svc.submitReply(secretPrompt, { kind: 'credential', value: 'sk-topsecret' });
  assert.equal(settledSecret, true);
  assert.equal(wsSent.length, 0);
  const answerCall = rpcCalls.find((c) => c.method === 'request.answer');
  assert.ok(answerCall);
  assert.equal(answerCall.params.result.value, 'sk-topsecret');
  assert.equal(svc.getActivePromptsForCurrentFocus().length, 0);

  // 2b. Retryable RPC error rolls back prompt and returns false so ClarifyCard retains draft
  const fenceClarify = svc.captureSyncFence();
  svc.reconcileSessionResume({
    storedSessionId: 'sess-1',
    liveSessionId: 'live-1',
    profile: 'default',
    resume: {
      running: true,
      open_requests: [{ id: 'clarify-rpc-1', method: 'clarify', params: { session_id: 'live-1', questions: [{ qid: 'q1', question: 'Retry?' }] } }],
    },
    fence: fenceClarify,
  });
  const [rpcClarify] = svc.getActivePromptsForCurrentFocus();
  failClarifyRpc = true;
  const failedResult = await svc.submitReply(rpcClarify, { kind: 'clarify', answers: { q1: 'Draft' } });
  assert.equal(failedResult, false, '可重试失败回滚必须返回 false 通知上层保留草稿');
  assert.equal(svc.getActivePromptsForCurrentFocus()[0]?.status, 'open');
  assert.ok(svc.getActivePromptsForCurrentFocus()[0]?.errorMessage);
  failClarifyRpc = false;
  const recoveredResult = await svc.submitReply(svc.getActivePromptsForCurrentFocus()[0], {
    kind: 'clarify',
    answers: { q1: 'Draft' },
  });
  assert.equal(recoveredResult, true);
  assert.equal(svc.getActivePromptsForCurrentFocus().length, 0);

  // 3. resetOnDisconnect clears terminalKeys so re-hydrating same id works after reconnect
  svc.resetOnDisconnect();
  const fence = svc.captureSyncFence();
  svc.reconcileSessionResume({
    storedSessionId: 'sess-1',
    liveSessionId: 'live-1',
    profile: 'default',
    resume: {
      running: true,
      open_requests: [{ id: 'srv-2', method: 'secret', params: { session_id: 'live-1', env_var: 'TOKEN' } }],
    },
    fence,
  });
  assert.equal(svc.hasPendingPromptForSession('sess-1', 'live-1'), true);

  // 4. probeClassicPendingApprovalsIfRunning loads approval.pending
  await svc.probeClassicPendingApprovalsIfRunning({
    client,
    storedSessionId: 'sess-1',
    liveSessionId: 'live-1',
    profile: 'default',
    resume: { running: true, info: {} },
    fence,
  });
  assert.equal(svc.getActivePromptsForCurrentFocus().length, 2);

  // 5. connection request + wakeActiveConnections + request-cancel
  svc.handleTurnAction({
    type: 'connection-request',
    sessionId: 'live-1',
    payload: {
      op_id: 'op-conn',
      seq: 1,
      deadline_at: 999999,
      timeout_seconds: 60,
      targets: [{ name: 'gh', kind: 'connector', action: 'authorize', state: 'pending' }],
    },
  });
  await svc.wakeActiveConnections();
  assert.ok(rpcCalls.some((c) => c.method === 'connectors.operation.wake' && c.params.op_id === 'op-conn'));
  assert.ok(changeCount > 0);
});

test('SessionOperationService: switchModel confirm_required 走停靠确认与 cancel 回滚，switchApproval 失败回滚', async () => {
  const state = makeBaseState();
  const rpcCalls = [];
  let confirmOutcome = 'confirm';

  const service = createSessionOperationService({
    getState: () => state,
    getGatewayClient: () => ({
      call: async (method, params) => {
        rpcCalls.push({ method, params });
        if (method === 'config.set' && params.key === 'model' && !params.confirm_expensive_model) {
          return { confirm_required: true, confirm_message: 'Costly model!' };
        }
        if (method === 'config.set' && params.key === 'approval_mode') {
          throw new Error('gateway rejected mode');
        }
        return { applied: true };
      },
    }),
    getCurrentTicket: () => null,
    getEffectiveUrl: () => 'http://localhost',
    render: () => {},
    t: (k) => k,
    showToast: () => {},
    setTimedDockNotice: (m) => { state.dockNotice = m; },
    clearTimedDockNotice: () => {},
    restoreComposerFocus: () => {},
    sessionDrafts: { get: () => '', set: () => {}, clear: () => {} },
    sessionMessagesCache: new Map(),
    unreadSessionIds: new Set(),
    activeRunningSessionIds: new Set(),
    activityTransitionTracker: { clear: () => {} },
    sessionHandleRegistry: createFakeRegistry(),
    cacheService: {
      writeSessions: async () => {},
      readSessions: async () => [],
      deleteSession: async () => {},
    },
    persistSessionsToCache: () => {},
    forgetOlderCursorState: () => {},
    sessionListGeneration: { next: () => 1, isCurrent: () => true },
    getActiveStreamingStoredSessionId: () => null,
    getActiveStreamingMessageId: () => null,
    scheduleToolPatch: () => {},
    resetActiveStreamingState: () => {},
    setPendingScrollToBottom: () => {},
    cancelSmoothScrollOnLeave: () => {},
    setLastMessagesSnapshot: () => {},
    captureStreamAnchor: () => ({ kind: 'bottom' }),
    loadMessages: async () => {},
    openBotChat: async () => {},
    ensureLiveSessionId: async () => 'live-1',
    createNewSession: async () => null,
    requestRpcConfirm: async () => confirmOutcome,
  });

  // Confirm branch
  await service.switchModel('claude-opus-4');
  assert.equal(state.selectedModel, 'claude-opus-4');
  assert.equal(rpcCalls.length, 2);
  assert.equal(rpcCalls[1].params.confirm_expensive_model, true);

  // Cancel branch reverts selectedModel without dockNotice error
  confirmOutcome = 'cancel';
  await service.switchModel('gpt-5-pro');
  assert.equal(state.selectedModel, 'claude-opus-4');
  assert.equal(rpcCalls.length, 3, '取消确认后不得发出 confirm_expensive_model=true 的第二次调用');

  // switchApproval failure reverts approvalMode
  await service.switchApproval('off');
  assert.equal(state.approvalMode, 'manual');
  assert.ok(state.dockNotice.includes('gateway rejected mode'));
});

test('isProtectedIslandFocus 保护停靠岛内焦点及密码字段，放行普通主输入框', () => {
  const islandEl = { closest: (sel) => (sel === '[data-flux-island]' ? {} : null) };
  const mainInput = { closest: () => null, id: 'dock-prompt-input' };
  assert.equal(isProtectedIslandFocus(islandEl), true);
  assert.equal(isProtectedIslandFocus(mainInput), false);
  assert.equal(isProtectedIslandFocus(null), false);

  const botMap = collectBotForeverSessionMap(
    makeBaseState({
      sessions: [
        { id: 'bot-s', botName: 'ops', hidden: true },
        { id: 'child-s', botName: 'ops', hidden: false },
      ],
    }),
    new Map([['coder', 'forever-coder']]),
  );
  assert.equal(botMap.get('forever-coder'), 'coder');
  assert.equal(botMap.get('bot-s'), 'ops');
  assert.equal(botMap.has('child-s'), false);
});

test('StreamViewportManager.syncStreamBottomInset 在向上翻阅历史时仍实时更新底部留白且不强拉贴底', () => {
  const origResizeObserver = globalThis.ResizeObserver;
  const observed = [];
  globalThis.ResizeObserver = class {
    observe(el) { observed.push(el); }
    disconnect() {}
  };
  try {
    const podStyles = new Map();
    const streamStyles = new Map();
    let promptHeight = 0;
    const promptHost = { getBoundingClientRect: () => ({ top: 600 - promptHeight, height: promptHeight, bottom: 600 }) };
    const dock = { getBoundingClientRect: () => ({ top: 600, height: 100, bottom: 700 }) };
    const pod = {
      style: { setProperty: (k, v) => podStyles.set(k, v) },
      querySelector: (sel) => (sel === '#react-interactive-prompt-host' ? promptHost : null),
      getBoundingClientRect: () => ({ top: 0, bottom: 700, height: 700 }),
    };
    const stream = {
      scrollHeight: 2000,
      scrollTop: 800, // distance = 2000 - 800 - 500 = 700 > 48 (用户正在看历史)
      clientHeight: 500,
      style: {
        getPropertyValue: (k) => streamStyles.get(k) ?? '',
        setProperty: (k, v) => streamStyles.set(k, v),
      },
      getBoundingClientRect: () => ({ top: 0, bottom: 700, height: 700 }),
    };

    let settleCalls = 0;
    const mgr = new StreamViewportManager({
      getStreamElement: () => stream,
      getMiddlePodElement: () => pod,
      getInputDockElement: () => dock,
      getActiveSessionId: () => 'sess-1',
      getPresenceLayout: () => 'dock',
      isPromptJumpSettling: () => false,
      getMessageWindowEnd: () => 50,
      getMessageWindowStart: () => 0,
      getTotalMessages: () => 50,
      layoutSignature: () => 'sig',
      markProgrammaticScroll: () => {},
      setInitialBottomSettling: () => { settleCalls += 1; },
      requestAnimationFrame: (cb) => { cb(); return 1; },
    });

    mgr.syncStreamBottomInset();
    assert.equal(podStyles.get('--flux-input-dock-h'), '100px');
    assert.equal(podStyles.get('--flux-interactive-prompt-h'), '0px');
    assert.equal(streamStyles.has('--conv-gutter-bottom'), false, '无停靠卡且浏览历史时不得写入 --conv-gutter-bottom');
    assert.equal(observed.length, 2, '必须同时监听输入舱和交互停靠宿主');

    // 展开交互停靠卡 (height = 180) 但用户仍在历史位置 -> 必须更新 --conv-gutter-bottom 为 320px 且不触发自动贴底
    promptHeight = 180;
    mgr.syncStreamBottomInset();
    assert.equal(podStyles.get('--flux-interactive-prompt-h'), '180px');
    assert.equal(podStyles.get('--flux-dock-occupied-h'), '280px');
    assert.equal(streamStyles.get('--conv-gutter-bottom'), '320px');
    assert.equal(stream.scrollTop, 800);
    assert.equal(settleCalls, 0);

    // 收起/关闭停靠卡 (height = 0) -> 必须收缩回 140px 且不拉回底部
    promptHeight = 0;
    mgr.syncStreamBottomInset();
    assert.equal(podStyles.get('--flux-interactive-prompt-h'), '0px');
    assert.equal(streamStyles.get('--conv-gutter-bottom'), '140px');
    assert.equal(settleCalls, 0);
  } finally {
    globalThis.ResizeObserver = origResizeObserver;
  }
});

test('LeftRailSnapshotManager: waitingReason 命中 P-020 缓存破坏且 Bot 微轨透出子会话 waiting 信号', () => {
  const waitingReasons = new Map([['child-s', 'clarify']]);
  const s1 = { id: 'child-s', title: 'Child', preview: '', time: '', timestamp: 1, botName: 'coder', isArchived: false, isHidden: false, pinned: false };
  const g1 = { roomId: 'room-1', name: 'Room 1', members: ['coder'], lastMessage: '', updatedAt: '', createdAt: '' };
  const p1 = { name: 'coder', displayName: 'Coder', description: '', isDefault: false };

  const mgr = new LeftRailSnapshotManager({
    getSessions: () => [s1],
    getArchivedSessions: () => [],
    getGroupRooms: () => [g1],
    getProfiles: () => [p1],
    getActiveSessionId: () => 'other',
    getActiveFocus: () => ({ type: 'session', sessionId: 'other' }),
    getProfileName: () => 'default',
    getSearchQuery: () => '',
    isSessionsGroupExpanded: () => true,
    isGroupsGroupExpanded: () => true,
    getError: () => '',
    isCollapsed: () => false,
    getEditingGroupRoomId: () => undefined,
    getProfilesPhase: () => 'ready',
    getSessionsPhase: () => 'ready',
    getActivityVariant: () => 'dots',
    getActiveRunningSessionIds: () => new Set(),
    getUnreadSessionIds: () => new Set(),
    getActiveStreamingStoredSessionId: () => null,
    getActiveRunningGroupRoomIds: () => new Set(),
    getUnreadGroupRoomIds: () => new Set(),
    getActiveRunningBotNames: () => new Set(),
    getUnreadBotNames: () => new Set(),
    getWaitingEntityMaps: () => ({ sessionWaitingReasons: waitingReasons, groupWaitingReasons: new Map() }),
    getBotForeverSessionMap: () => new Map([['forever-coder', 'coder']]),
    resolveAgentAvatar: () => '',
    resolveTransition: () => ({ transition: 'none' }),
  });

  const decSessions1 = mgr.decorateSessions(100);
  assert.equal(decSessions1[0].activityState, 'waiting');
  assert.equal(decSessions1[0].waitingReason, 'clarify');

  const decProfiles1 = mgr.decorateProfiles(100);
  assert.equal(decProfiles1[0].activityState, 'read', '子会话 waiting 不得污染 Bot 主工位 activityState');
  assert.equal(decProfiles1[0].hasChildWaitingPrompt, true, '但必须标出 hasChildWaitingPrompt 供微轨角落提示');

  // 清除 child-s 的 waiting 后必须击穿缓存并反映最新态
  waitingReasons.clear();
  const decSessions2 = mgr.decorateSessions(200);
  const decProfiles2 = mgr.decorateProfiles(200);
  assert.equal(decSessions2[0].activityState, 'read');
  assert.equal(Boolean(decProfiles2[0].hasChildWaitingPrompt), false);
});

test('InteractivePromptService: handleServerRequest 安全退场、gateway-ready 协议切换与 probe 降级分级日志', async () => {
  const state = makeBaseState({
    activeFocus: { type: 'group', roomId: 'room-early' },
    activeSessionId: 'room-early',
    activeLiveSessionId: '',
  });
  const serverResponses = [];
  const serverErrors = [];
  const debugLogs = [];
  const warnLogs = [];
  let capabilities = { protocol_version: 2, declines_not_shown: false };
  let probeErrorToThrow = { code: -32601, message: 'Method not found' };

  const fakeClient = {
    getSocketGeneration: () => 5,
    getNegotiatedCapabilities: () => capabilities,
    async call() {
      throw probeErrorToThrow;
    },
    sendServerResponse(id, result, gen, method) {
      serverResponses.push({ id, result, gen, method });
      return true;
    },
    sendServerError(id, code, message, data, gen) {
      serverErrors.push({ id, code, message, gen });
      return true;
    },
  };

  const service = createInteractivePromptService({
    getState: () => state,
    getGatewayClient: () => fakeClient,
    getSessionHandleRegistry: () => createFakeRegistry(),
    toStoredSessionId: (id) => (id === 'live-early-conn' ? null : id ?? null),
    resolveBotForeverSessionMap: () => new Map(),
    resolveBotNameForSession: () => null,
    describeRpcError: (e) => (e && typeof e.message === 'string' ? e.message : String(e)),
    logDebug: (msg, meta) => debugLogs.push({ msg, meta }),
    logWarn: (msg, meta) => warnLogs.push({ msg, meta }),
    onPromptsChanged: () => {},
  });

  // 1. 不支持请求在无 declines_not_shown 时回 safe ws_response，有 declines_not_shown 时回 -32601 ws_error
  const claimedResp = service.handleServerRequest(
    { kind: 'server-request', id: 101, method: 'theme.pick', params: {}, socketGeneration: 5 },
    fakeClient,
  );
  assert.equal(claimedResp, true);
  assert.deepEqual(serverResponses[0], {
    id: 101,
    result: { cancelled: true },
    gen: 5,
    method: 'theme.pick',
  });

  capabilities = { protocol_version: 2, declines_not_shown: true };
  const claimedErr = service.handleServerRequest(
    { kind: 'server-request', id: 102, method: 'theme.pick', params: {}, socketGeneration: 5 },
    fakeClient,
  );
  assert.equal(claimedErr, true);
  assert.equal(serverErrors[0]?.id, 102);
  assert.equal(serverErrors[0]?.code, -32601);

  const unclaimed = service.handleServerRequest(
    { kind: 'server-request', id: 103, method: 'unrecognized.method', params: {}, socketGeneration: 5 },
    fakeClient,
  );
  assert.equal(unclaimed, false);

  // 2. 先收到 gateway-ready(session_authority=true) 再直接打开群聊 -> canonical 收口 ['once', 'deny']
  service.handleTurnAction({ type: 'gateway-ready', replayEpoch: 'ep-1', sessionAuthority: true });
  service.reconcileGroupState('room-early', [
    {
      kind: 'approval',
      requestId: 'g-req-1',
      memberId: 'coder',
      taskId: 't-1',
      executionGeneration: 1,
      command: 'ls',
      choices: ['once', 'session', 'always', 'deny'],
    },
  ]);
  const groupPrompts = service.getActivePromptsForCurrentFocus();
  assert.equal(groupPrompts.length, 1);
  assert.equal(groupPrompts[0].protocol, 'canonical');
  assert.deepEqual(groupPrompts[0].choices, ['once', 'deny']);

  // gateway-ready(session_authority=false) 切回 classic
  service.handleTurnAction({ type: 'gateway-ready', replayEpoch: 'ep-2', sessionAuthority: false });
  service.reconcileGroupState('room-early', [
    {
      kind: 'approval',
      requestId: 'g-req-2',
      memberId: 'coder',
      taskId: 't-2',
      executionGeneration: 2,
      command: 'pwd',
      choices: ['once', 'session', 'always', 'deny'],
    },
  ]);
  const classicPrompts = service.getActivePromptsForCurrentFocus();
  assert.equal(classicPrompts.find((p) => p.requestId === 'g-req-2')?.protocol, 'classic');
  assert.deepEqual(
    classicPrompts.find((p) => p.requestId === 'g-req-2')?.choices,
    ['once', 'session', 'always', 'deny'],
  );

  // 3. probeClassicPendingApprovalsIfRunning: -32601 记 debug，其它异常记 warn
  await service.probeClassicPendingApprovalsIfRunning({
    client: fakeClient,
    storedSessionId: 'sess-1',
    liveSessionId: 'live-1',
    resume: { running: true, info: {} },
    fence: 1,
  });
  assert.equal(debugLogs.some((l) => l.meta?.code === -32601), true);
  assert.equal(warnLogs.length, 0);

  probeErrorToThrow = { code: 500, message: 'internal failure' };
  await service.probeClassicPendingApprovalsIfRunning({
    client: fakeClient,
    storedSessionId: 'sess-1',
    liveSessionId: 'live-1',
    resume: { running: true, info: {} },
    fence: 2,
  });
  assert.equal(warnLogs.some((l) => l.meta?.code === 500), true);

  // 4. bindSessionHandle 与 connection.request/update 全链路单卡映射
  service.handleTurnAction({
    type: 'connection-request',
    sessionId: 'live-early-conn',
    payload: {
      op_id: 'op-svc-1',
      seq: 1,
      deadline_at: 999999,
      timeout_seconds: 60,
      owner: { type: 'session', session_id: 'live-early-conn' },
      targets: [{ name: 'gh', kind: 'connector', action: 'authorize', state: 'pending' }],
    },
  });
  service.bindSessionHandle('stored-early-conn', 'live-early-conn');
  assert.equal(service.getWaitingEntityMaps().sessionWaitingReasons.get('stored-early-conn'), 'connection');
  service.handleTurnAction({
    type: 'connection-update',
    payload: {
      op_id: 'op-svc-1',
      seq: 2,
      deadline_at: 999999,
      settled: false,
      owner: { type: 'session', session_id: 'live-early-conn' },
      targets: [{ name: 'gh', kind: 'connector', action: 'authorize', state: 'initiated' }],
    },
  });
  assert.equal(service.getBackgroundWaitingSummaries().filter((s) => s.entityId === 'stored-early-conn').length, 1);
  service.handleTurnAction({
    type: 'connection-update',
    payload: {
      op_id: 'op-svc-1',
      seq: 2,
      deadline_at: 999999,
      settled: true,
      owner: { type: 'session', session_id: 'live-early-conn' },
      targets: [],
    },
  });
  assert.equal(service.getWaitingEntityMaps().sessionWaitingReasons.has('stored-early-conn'), false);
});
