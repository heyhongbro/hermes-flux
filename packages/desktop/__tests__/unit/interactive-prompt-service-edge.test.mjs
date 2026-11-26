/**
 * InteractivePromptService 边界、降级、并发围栏与本地确认全分支单测
 * (packages/desktop/__tests__/unit/interactive-prompt-service-edge.test.mjs)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildInteractiveScopeKey,
  createInteractivePromptService,
} from '../../dist/renderer/services/interactivePromptService.mjs';

function makeState(overrides = {}) {
  return {
    activeFocus: { type: 'session', sessionId: 'sess-1' },
    activeSessionId: 'sess-1',
    activeLiveSessionId: 'live-1',
    profileName: 'default',
    sessions: [{ id: 'sess-1', title: 'S1', botName: 'bot-a' }],
    profiles: [{ name: 'default', displayName: 'Default' }],
    groupRooms: [],
    ...overrides,
  };
}

test('buildInteractiveScopeKey 覆盖 group / bot / session 全焦点变体与空值回退', () => {
  assert.equal(buildInteractiveScopeKey({ type: 'group', roomId: 'r-1' }, 's1'), 'group:r-1');
  assert.equal(buildInteractiveScopeKey({ type: 'group', roomId: '' }, 's1'), 'group:');
  assert.equal(buildInteractiveScopeKey({ type: 'bot', botName: 'coder' }, 'sess-bot'), 'session:sess-bot');
  assert.equal(buildInteractiveScopeKey({ type: 'bot', botName: '' }, ''), 'bot:');
  assert.equal(buildInteractiveScopeKey({ type: 'session', sessionId: 's-only' }, ''), 'session:s-only');
  assert.equal(buildInteractiveScopeKey({ type: 'session', sessionId: '' }, ''), 'session:');
});

test('InteractivePromptService: unsupported capabilities、协议解析、handleTurnAction 全分支、提交回滚与终态提示', async () => {
  const state = makeState();
  let client = null;
  let nowTick = 5000;
  const wsResponses = [];
  const wsErrors = [];
  const notices = [];
  const debugLogs = [];
  const warnLogs = [];
  const rpcCalls = [];
  let changeCount = 0;

  const svc = createInteractivePromptService({
    getState: () => state,
    getGatewayClient: () => client,
    getSessionHandleRegistry: () => ({ clear() {}, getStoredId: () => null, getRegisteredLiveId: () => null, register() {} }),
    toStoredSessionId: (id) => (id === 'live-1' ? 'sess-1' : null),
    resolveBotForeverSessionMap: () => new Map([['sess-forever', 'bot-a']]),
    resolveBotNameForSession: (sid) => (sid === 'sess-1' ? 'bot-a' : null),
    describeRpcError: (err) => (err instanceof Error ? err.message : String(err)),
    onTerminalSubmitNotice: (msg) => notices.push(msg),
    onPromptsChanged: () => {
      changeCount += 1;
    },
    logDebug: (m, meta) => debugLogs.push({ m, meta }),
    logWarn: (m, meta) => warnLogs.push({ m, meta }),
    now: () => nowTick,
  });

  const unsub = svc.subscribe(() => {});
  // 没有 client 时的安全路径
  assert.equal(svc.getProtocolForSession(null), 'classic');
  assert.equal(svc.hasPendingPromptForGroup(''), false);
  await svc.wakeConnection({
    canonicalKey: 'connection::no-cli',
    requestId: 'no-cli',
    kind: 'connection',
    scope: { kind: 'account' },
    waitingReason: 'connection',
    status: 'open',
    arrivalSeq: 1,
    createdAtMs: 1,
    rpcId: null,
    socketGeneration: null,
    origin: 'connection_event',
    protocol: 'classic',
    opId: 'no-cli',
    seq: 1,
    deadlineAtMs: 2,
    timeoutSeconds: 10,
    owner: { type: 'account' },
    targets: [],
  });

  // 2. 构造 fakeClient，测试 desktop_local / phase3 unsupported 两支路
  let negotiated = { server_requests: true, declines_not_shown: false };
  let socketGen = 1;
  let wsSendShouldSucceed = true;
  let nextRpcImpl = async () => ({ status: 'ok' });

  client = {
    getSocketGeneration: () => socketGen,
    getNegotiatedCapabilities: () => negotiated,
    sendServerResponse: (id, result, gen) => {
      if (!wsSendShouldSucceed || gen !== socketGen) return false;
      wsResponses.push({ id, result });
      return true;
    },
    sendServerError: (id, code, msg, data, gen) => {
      wsErrors.push({ id, code, msg, data, gen });
      return true;
    },
    call: async (method, params) => {
      rpcCalls.push({ method, params });
      return await nextRpcImpl(method, params);
    },
  };

  assert.equal(
    svc.handleServerRequest({ kind: 'server-request', id: 'dl-1', method: 'theme.pick', params: {}, socketGeneration: 1 }, client),
    true,
  );
  assert.equal(wsResponses.at(-1)?.result?.cancelled, true);

  negotiated = { server_requests: true, declines_not_shown: true };
  assert.equal(
    svc.handleServerRequest({ kind: 'server-request', id: 'dl-2', method: 'theme.pick', params: {}, socketGeneration: 1 }, client),
    true,
  );
  assert.equal(wsErrors.at(-1)?.code, -32601);

  assert.equal(
    svc.handleServerRequest({ kind: 'server-request', id: 'unk', method: 'totally.unknown', params: {}, socketGeneration: 1 }, client),
    false,
  );

  // params.gateway_session_id 回退解析与正常提交收口
  state.profileName = '';
  assert.equal(
    svc.handleServerRequest({ kind: 'server-request', id: 'cl-gw', method: 'clarify', params: { gateway_session_id: 'live-unk', question: 'G?' }, socketGeneration: 1 }, client),
    true,
  );
  const gwPrompt = svc.coordinator.getPrompt('session:live-unk::clarify::cl-gw');
  assert.ok(gwPrompt);
  assert.equal(await svc.submitReply(gwPrompt, { kind: 'clarify', answers: { 'cl-gw': 'yes' } }), true);
  assert.equal(svc.coordinator.getPrompt('session:live-unk::clarify::cl-gw'), undefined);

  // 3. sessionProtocols 查找：bindSessionHandle 双向传播、session-info classic/canonical、reconcileSessionResume null info
  svc.bindSessionHandle('', 'live-1');
  svc.bindSessionHandle('st-x', 'live-x');
  svc.handleTurnAction({ type: 'session-info', sessionId: 'live-1', info: { desktop_protocol: 'hermes-gateway-v1' } });
  assert.equal(svc.getProtocolForSession('sess-1'), 'canonical');
  assert.equal(svc.getGatewayProtocol(), 'canonical');
  svc.handleTurnAction({ type: 'session-info', sessionId: 'live-other', info: { desktop_protocol: 'classic' } });
  assert.equal(svc.getProtocolForSession('sess-other-direct'), 'canonical'); // falls back to gatewayProtocol
  assert.equal(svc.getProtocolForSession('live-other'), 'classic');

  svc.reconcileSessionResume({ storedSessionId: 'st-res', liveSessionId: null, resume: { running: false } });
  assert.equal(svc.getGatewayProtocol(), 'canonical');

  // probeClassicPendingApprovalsIfRunning: running false / canonical / no sessionId / success without profile / non-array approvals
  await svc.probeClassicPendingApprovalsIfRunning({ client, storedSessionId: 'st-res', liveSessionId: null, resume: { running: false }, fence: 1 });
  await svc.probeClassicPendingApprovalsIfRunning({ client, storedSessionId: 'st-res', liveSessionId: null, resume: { running: true, info: { desktop_protocol: 'hermes-gateway-v1' } }, fence: 1 });
  await svc.probeClassicPendingApprovalsIfRunning({ client, storedSessionId: '', liveSessionId: null, resume: { running: true }, fence: 1 });
  nextRpcImpl = async () => ({ approvals: null });
  await svc.probeClassicPendingApprovalsIfRunning({ client, storedSessionId: 'st-res', liveSessionId: 'lv-res', resume: { running: true }, fence: 1 });
  nextRpcImpl = async () => ({ approvals: [{ command: 'ls' }] });
  await svc.probeClassicPendingApprovalsIfRunning({ client, storedSessionId: 'st-res', liveSessionId: 'lv-res', profile: 'p1', resume: { running: true }, fence: 1 });

  // 4. handleTurnAction: request-cancel (0 vs >0), approval-cancelled (0 vs >0), connection-request null, unknown default
  svc.handleTurnAction({ type: 'request-cancel', id: 'no-such' });
  svc.handleTurnAction({ type: 'approval-cancelled', sessionId: 'no-such', requestIds: [] });
  svc.handleTurnAction({ type: 'connection-request', payload: { op_id: '', seq: 1, deadline_at: 0, timeout_seconds: 1, targets: [] } });
  svc.handleTurnAction({ type: 'totally-unrelated' });

  // 5. submitReply & dispatchRpcRoute 失败/幂等/终态提示/WS失败回落RPC/无client回滚
  const apPrompt = svc.handleServerRequest({
    kind: 'server-request',
    id: 'ap-sub-1',
    method: 'approval',
    params: { session_id: 'live-1', request_id: 'ap-req-1', command: 'echo 1' },
    socketGeneration: 1,
  }, client);
  assert.equal(apPrompt, true);
  const apObj = svc.coordinator.getPrompt('session:sess-1::approval::ap-req-1');
  // 切代 ws_response 失败 -> 走 fallbackRoute.transport === 'rpc' 命中 non-retryable terminal error -> onTerminalSubmitNotice
  socketGen = 2;
  nextRpcImpl = async () => {
    const err = new Error('Contract invalid choice');
    err.code = 4000;
    throw err;
  };
  const apTerminal = await svc.submitReply(apObj, { kind: 'approval', choice: 'once' });
  assert.equal(apTerminal, true);
  assert.match(notices.at(-1) || '', /Contract invalid choice/);
  // 对同一 prompt 再次 submitReply 命中 beginSubmit === false
  assert.equal(await svc.submitReply(apObj, { kind: 'approval', choice: 'once' }), false);

  // already_resolved / expired 终态错不弹窗提示 + isIdempotentSettlementResponse true 结算
  svc.handleServerRequest({
    kind: 'server-request',
    id: 'ap-exp',
    method: 'approval',
    params: { session_id: 'live-1', request_id: 'ap-exp-1', command: 'echo 2' },
    socketGeneration: 99,
  }, client);
  const noticeBefore = notices.length;
  nextRpcImpl = async () => {
    throw new Error('request already_resolved by peer');
  };
  await svc.submitReply(svc.coordinator.getPrompt('session:sess-1::approval::ap-exp-1'), { kind: 'approval', choice: 'deny' });
  assert.equal(notices.length, noticeBefore);

  // connection.respond with non-object res vs targets array, non-idempotent normal ok
  svc.handleTurnAction({
    type: 'connection-request',
    payload: { op_id: 'op-route', seq: 1, deadline_at: 999999, timeout_seconds: 30, owner: { type: 'account' }, targets: [] },
  });
  const connObj = svc.coordinator.getPrompt('connection::op-route');
  nextRpcImpl = async () => 'non-obj';
  assert.equal(await svc.submitReply(connObj, { kind: 'connection', settledBy: 'continue' }), true);
  nextRpcImpl = async () => ({ settled: true, targets: [{ name: 'gh', kind: 'connector', action: 'authorize', state: 'connected' }] });
  assert.equal(await svc.submitReply(connObj, { kind: 'connection', settledBy: 'all_resolved' }), true);

  // 断连期间 submitReply -> rollbackSubmit with client missing message
  svc.handleServerRequest({
    kind: 'server-request',
    id: 'sec-off',
    method: 'secret',
    params: { session_id: 'live-1' },
    socketGeneration: 2,
  }, client);
  const secObj = svc.coordinator.getPrompt('session:sess-1::cred::secret::sec-off');
  const savedClient = client;
  client = null;
  assert.equal(await svc.submitReply(secObj, { kind: 'credential', value: 'x' }), false);
  client = savedClient;

  // 6. lockClarifyAnswer 并发锁重入、expired、normal、catch 与 canonical 早退
  svc.handleTurnAction({ type: 'gateway-ready', replayEpoch: 'ep-c', sessionAuthority: false });
  svc.handleTurnAction({ type: 'session-info', sessionId: 'live-1', info: { desktop_protocol: 'classic' } });
  svc.handleServerRequest({
    kind: 'server-request',
    id: 'cl-lock-1',
    method: 'clarify',
    params: { session_id: 'live-1', questions: [{ qid: 'q1', question: 'Q1' }, { qid: 'q2', question: 'Q2' }] },
    socketGeneration: 2,
  }, client);
  const clObj = svc.coordinator.getPrompt('session:sess-1::clarify::cl-lock-1');
  let releaseLock = null;
  nextRpcImpl = () =>
    new Promise((resolve) => {
      releaseLock = resolve;
    });
  const pLock1 = svc.lockClarifyAnswer(clObj, 'q1', 'A1');
  const pLockDup = svc.lockClarifyAnswer(clObj, 'q1', 'A1'); // hit clarifyLockInFlight
  assert.ok(typeof releaseLock === 'function');
  releaseLock({ status: 'ok', remaining: ['q2'] });
  await Promise.all([pLock1, pLockDup]);
  nextRpcImpl = async () => ({ status: 'expired' });
  await svc.lockClarifyAnswer(clObj, 'q2', 'A2');
  nextRpcImpl = async () => {
    throw new Error('lock rpc boom');
  };
  await svc.lockClarifyAnswer({ ...clObj, scope: { kind: 'app' } }, 'q1', 'A');
  await svc.lockClarifyAnswer({ ...clObj, protocol: 'canonical' }, 'q1', 'A');

  // 7. wakeConnection (app scope & catch) + wakeActiveConnections
  svc.handleTurnAction({
    type: 'connection-request',
    payload: { op_id: 'op-wake-1', seq: 1, deadline_at: 9999, timeout_seconds: 60, owner: { type: 'account' }, targets: [] },
  });
  nextRpcImpl = async () => {
    throw new Error('wake timeout');
  };
  await svc.wakeActiveConnections();
  assert.equal(warnLogs.some((l) => l.m === 'connectors.operation.wake failed'), true);

  // 8. requestRpcConfirm 全 scope / options / 重复覆写 cancel / 本地确认兑现与 resetOnDisconnect
  const pOld = svc.requestRpcConfirm({
    scope: { kind: 'session', storedSessionId: 'sess-1', liveSessionId: 'live-1', profile: 'p1' },
    confirmKind: 'expensive_model',
    key: 'rpc-c-1',
    title: 'T',
    message: 'M',
    confirmLabel: 'Yes',
    secondaryConfirmLabel: 'Always',
    cancelLabel: 'No',
    metadata: { m: 1 },
  });
  const pNew = svc.requestRpcConfirm({
    scope: { kind: 'session', storedSessionId: null, liveSessionId: null },
    confirmKind: 'reload_mcp',
    key: 'rpc-c-1',
    title: 'T2',
    message: 'M2',
  });
  assert.equal(await pOld, 'cancel');
  assert.equal(await svc.submitReply(svc.coordinator.getPrompt('rpc-c-1'), { kind: 'rpc_confirm', outcome: 'confirm_always' }), true);
  assert.equal(await pNew, 'confirm_always');

  const pGrp = svc.requestRpcConfirm({
    scope: { kind: 'group', roomId: 'r-g', profile: 'default' },
    confirmKind: 'group_discard',
    key: 'rpc-c-grp',
    title: 'G',
    message: 'M',
  });
  assert.equal(svc.hasPendingPromptForGroup('r-g'), true);
  const pAcct = svc.requestRpcConfirm({
    scope: { kind: 'account' },
    confirmKind: 'reload_mcp',
    key: 'rpc-c-acct',
    title: 'A',
    message: 'M',
  });
  svc.resetOnDisconnect();
  assert.equal(await pGrp, 'cancel');
  assert.equal(await pAcct, 'cancel');

  // 9. Focus/Collapsed/ActiveKey 状态助手 + group/bot focus + clearSession + handleSocketClosed
  state.activeFocus = { type: 'group', roomId: 'r-focus' };
  assert.equal(svc.isCollapsedForCurrentFocus(), false);
  assert.equal(svc.getActivePromptKeyForCurrentFocus(), null);
  svc.reconcileGroupState('r-focus', [
    { kind: 'retry', memberId: 'm1', taskId: 't1', executionGeneration: 1 },
    { kind: 'prepare', memberId: 'm2', taskId: 't2', executionGeneration: 1 },
  ]);
  assert.equal(svc.getWaitingReasonForCurrentFocus(), 'confirm');
  assert.equal(svc.getActivePromptKeyForCurrentFocus(), 'group::r-focus::retry::t1');
  svc.setActivePromptKeyForCurrentFocus('group::r-focus::prepare::t2');
  assert.equal(svc.getActivePromptKeyForCurrentFocus(), 'group::r-focus::prepare::t2');
  svc.setActivePromptKeyForCurrentFocus('stale-non-existent');
  assert.equal(svc.getActivePromptKeyForCurrentFocus(), 'group::r-focus::retry::t1');
  svc.setCollapsedForCurrentFocus(true);
  assert.equal(svc.isCollapsedForCurrentFocus(), true);
  svc.expandScope('group:r-focus');
  assert.equal(svc.isCollapsedForCurrentFocus(), false);

  state.activeFocus = { type: 'bot', botName: 'bot-a' };
  state.activeSessionId = 'sess-1';
  assert.ok(Array.isArray(svc.getActivePromptsForCurrentFocus()));
  svc.handleSocketClosed(2);
  svc.clearSession('sess-1', 'live-1');
  unsub();
  svc.handleSocketClosed(3);

  // 10. 补充覆盖：bindSessionHandle 协议传播、reconcileSessionResume info 协议同步、
  //     toStoredSessionId 回退查表、idempotent 幂等结算、clarify.lock 缺省 remaining 与 group wakeConnection
  const subEvents = [];
  const svc2 = createInteractivePromptService({
    getState: () => state,
    getGatewayClient: () => client,
    getSessionHandleRegistry: () => ({ clear() {}, getStoredId: () => null, getRegisteredLiveId: () => null, register() {} }),
    toStoredSessionId: (id) => (id === 'live-mapped' ? 'sess-stored-proto' : id === 'live-1' ? 'sess-1' : null),
    resolveBotForeverSessionMap: () => new Map(),
    resolveBotNameForSession: () => null,
    describeRpcError: String,
    t: (k) => k,
    onTerminalSubmitNotice: () => {},
    onPromptsChanged: () => {},
  });
  const unsub2 = svc2.subscribe(() => subEvents.push('n'));

  // reconcileSessionResume: canonical + liveSessionId & classic + null liveSessionId
  svc2.reconcileSessionResume({
    storedSessionId: 'sess-stored-proto',
    liveSessionId: 'lv-can',
    resume: { running: false, info: { desktop_protocol: 'hermes-gateway-v1' } },
    fence: 1,
  });
  assert.equal(svc2.getProtocolForSession('sess-stored-proto'), 'canonical');
  svc2.reconcileSessionResume({
    storedSessionId: 'sess-cls-only',
    liveSessionId: null,
    resume: { running: false, info: { desktop_protocol: 'classic' } },
    fence: 2,
  });
  svc2.bindSessionHandle('sess-cls-only', 'lv-cls-bound');
  assert.equal(svc2.getProtocolForSession('lv-cls-bound'), 'classic');

  // handleServerRequest: profile hint param, mapped toStoredSessionId lookup, no session_id, terminal duplicate returning false
  assert.equal(
    svc2.handleServerRequest({
      kind: 'server-request',
      id: 'cl-idemp-1',
      method: 'clarify',
      params: { session_id: 'live-mapped', profile: 'prof-param', questions: [{ qid: 'q1', question: 'Q?' }] },
      socketGeneration: 99,
    }, client),
    true,
  );
  assert.equal(
    svc2.handleServerRequest({
      kind: 'server-request',
      id: 'sec-nosess',
      method: 'secret',
      params: {},
      socketGeneration: 2,
    }, client),
    true,
  );
  // 幂等 settled response (already_resolved) -> confirms & settles prompt; 未知 method -> false
  nextRpcImpl = async () => ({ status: 'already_resolved' });
  const idempPrompt = svc2.coordinator.getPrompt('session:sess-stored-proto::clarify::cl-idemp-1');
  assert.equal(await svc2.submitReply(idempPrompt, { kind: 'clarify', answers: { q1: 'A' } }), true);
  assert.equal(svc2.coordinator.getPrompt('session:sess-stored-proto::clarify::cl-idemp-1'), undefined);
  assert.equal(
    svc2.handleServerRequest({
      kind: 'server-request',
      id: 'unk-method-1',
      method: 'custom.unknown.method',
      params: { session_id: 'live-mapped' },
      socketGeneration: 99,
    }, client),
    false,
  );

  // getProtocolForSession via toStoredSessionId fallback (`live-mapped` -> `sess-stored-proto` mapped)
  assert.equal(svc2.getProtocolForSession('live-mapped'), 'canonical');

  // RPC-routed submitReply -> isIdempotentSettlementResponse true (L495-498) & false fallback (L501)
  svc2.reconcileSessionResume({
    storedSessionId: 'sess-rpc-can',
    liveSessionId: 'lv-rpc-can',
    resume: {
      info: { desktop_protocol: 'hermes-gateway-v1' },
      prompts: [{ prompt_id: 'pr-rpc-1', kind: 'clarify', question: 'Q?', execution_generation: 1 }],
    },
    fence: 3,
  });
  const rpcCanPrompt = svc2.coordinator.getPrompt('session:sess-rpc-can::clarify::pr-rpc-1');
  assert.ok(rpcCanPrompt);
  nextRpcImpl = async () => ({ status: 'already_resolved' });
  assert.equal(await svc2.submitReply(rpcCanPrompt, { kind: 'clarify', singleAnswer: 'A1' }), true);

  // lockClarifyAnswer remaining: undefined -> ?? null, { remaining: ['q2'] }, { status: 'ok' }
  // Use session_id 'lv-cls-bound' (classic protocol) so prompt.protocol !== 'canonical' and clarify.lock runs!
  nextRpcImpl = async () => undefined;
  svc2.handleServerRequest({
    kind: 'server-request',
    id: 'cl-noremain',
    method: 'clarify',
    params: { session_id: 'lv-cls-bound', questions: [{ qid: 'q1', question: 'Q?' }] },
    socketGeneration: 2,
  }, client);
  await svc2.lockClarifyAnswer(svc2.coordinator.getPrompt('session:lv-cls-bound::clarify::cl-noremain'), 'q1', 'A');
  nextRpcImpl = async () => ({ remaining: ['q2'] });
  await svc2.lockClarifyAnswer(svc2.coordinator.getPrompt('session:lv-cls-bound::clarify::cl-noremain'), 'q1', 'B');
  nextRpcImpl = async () => ({ status: 'ok' });
  await svc2.lockClarifyAnswer(svc2.coordinator.getPrompt('session:lv-cls-bound::clarify::cl-noremain'), 'q1', 'C');
  assert.ok(rpcCalls.some((c) => c.method === 'clarify.lock'));
  await svc2.wakeConnection({
    opId: 'op-grp-wake',
    scope: { kind: 'group', roomId: 'rm-wake' },
  });

  // clearSession 必须为被清除的 rpc_confirm 条目解析 'cancel'，同时安全清理普通 clarify 提示
  assert.equal(
    svc2.handleServerRequest({
      kind: 'server-request',
      id: 'cl-clear-1',
      method: 'clarify',
      params: { session_id: 'sess-clear', question: 'Drop?' },
      socketGeneration: 2,
    }, client),
    true,
  );
  const confirmPromise = svc2.requestRpcConfirm({
    key: 'rpc-confirm::sess-clear::del',
    scope: { kind: 'session', storedSessionId: 'sess-clear', liveSessionId: null },
    confirmKind: 'expensive_model',
    title: 'Confirm',
    message: 'Proceed?',
  });
  svc2.clearSession('sess-clear');
  assert.equal(await confirmPromise, 'cancel');
  assert.equal(svc2.coordinator.getPrompt('rpc-confirm::sess-clear::del'), undefined);
  assert.equal(svc2.coordinator.getPrompt('session:sess-clear::clarify::cl-clear-1'), undefined);
  svc2.clearSession('sess-nonexistent');

  unsub2();
  assert.ok(subEvents.length > 0);
});
