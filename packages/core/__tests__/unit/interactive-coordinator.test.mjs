/**
 * 核心交互式协议路由器、能力协商、状态优先级与协调器单元测试
 * (packages/core/__tests__/unit/interactive-coordinator.test.mjs)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  InteractiveRequestCoordinator,
  negotiateClientCapabilities,
  resolveUnsupportedServerRequestResponse,
  resolveReplyRoute,
  isIdempotentSettlementResponse,
  isRetryableTransportError,
  buildJsonRpcResultFrame,
  buildJsonRpcErrorFrame,
  resolveActivityState,
  deriveAgentPresence,
  reduceGatewayEvent,
  parseConnectionRequestPayload,
  parseConnectionUpdatePayload,
} from '../../dist/index.js';

test('negotiateClientCapabilities 首选完整参数并在 4000 Extra inputs 时自动降级重试', async () => {
  const calls = [];
  const res = await negotiateClientCapabilities(
    {
      async call(method, params) {
        calls.push({ method, params });
        if ('desktop_local' in params) {
          const err = new Error('Extra inputs are not permitted');
          err.code = 4000;
          throw err;
        }
        return { server_requests: true, canonical_clarify_batch: false };
      },
    },
    { server_requests: true, desktop_local: false },
  );

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].params, { server_requests: true, desktop_local: false });
  assert.deepEqual(calls[1].params, { server_requests: true });
  assert.deepEqual(res, { server_requests: true, canonical_clarify_batch: false });
});

test('negotiateClientCapabilities 在 -32601 时静默返回 null 不阻断建连', async () => {
  const res = await negotiateClientCapabilities(
    {
      async call() {
        const err = new Error('Method not found');
        err.code = -32601;
        throw err;
      },
    },
    { server_requests: true, desktop_local: false },
  );
  assert.equal(res, null);
});

test('resolveUnsupportedServerRequestResponse 对 desktop_local / phase-3 返回安全退场帧，不挂死 300s', () => {
  const previewErr = resolveUnsupportedServerRequestResponse('preview.act', {
    server_requests: true,
    declines_not_shown: true,
    canonical_clarify_batch: false,
  });
  assert.ok(previewErr && previewErr.kind === 'ws_error');
  assert.equal(previewErr.code, -32601);

  const previewCompat = resolveUnsupportedServerRequestResponse('preview.act', null);
  assert.ok(previewCompat && previewCompat.kind === 'ws_response');
  assert.deepEqual(previewCompat.result, { value: '' });

  const setupCompat = resolveUnsupportedServerRequestResponse('setup_beat', null);
  assert.ok(setupCompat && setupCompat.kind === 'ws_response');
  assert.deepEqual(setupCompat.result, {});

  const themePick = resolveUnsupportedServerRequestResponse('theme.pick', null);
  assert.ok(themePick && themePick.kind === 'ws_response');
  assert.deepEqual(themePick.result, { cancelled: true });

  const ok = resolveUnsupportedServerRequestResponse('clarify', null);
  assert.equal(ok, null);
});

test('buildJsonRpcResultFrame 与 buildJsonRpcErrorFrame 输出规范 JSON-RPC 2.0 报文', () => {
  const resObj = JSON.parse(buildJsonRpcResultFrame(42, { choice: 'once' }));
  assert.deepEqual(resObj, { jsonrpc: '2.0', id: 42, result: { choice: 'once' } });

  const errObj = JSON.parse(buildJsonRpcErrorFrame('srv-1', -32601, 'unsupported'));
  assert.deepEqual(errObj, { jsonrpc: '2.0', id: 'srv-1', error: { code: -32601, message: 'unsupported' } });
});

test('reset() 彻底释放 terminalKeys 使重连同号请求可正常重建，而 cancel 保持终态吸收', () => {
  const coord = new InteractiveRequestCoordinator();
  const p1 = coord.upsertServerRequest({
    rpcId: '1',
    socketGeneration: 1,
    method: 'secret',
    params: { session_id: 's1', env_var: 'OPENAI_API_KEY' },
    storedSessionId: 's1',
    nowMs: 100,
  });
  assert.ok(p1);
  coord.confirmSettled(p1.canonicalKey);
  assert.equal(coord.hasPendingPromptForSession('s1'), false);

  // reset 后同 id 从 open_requests 恢复必须生效
  coord.reset();
  coord.reconcileFromResume({
    storedSessionId: 's1',
    liveSessionId: 's1',
    resume: {
      open_requests: [{ id: '1', method: 'secret', params: { session_id: 's1', env_var: 'OPENAI_API_KEY' } }],
    },
    fence: 0,
    nowMs: 200,
  });
  assert.equal(coord.hasPendingPromptForSession('s1'), true);
});

test('vault.save_login 与 clarify.cancelled 的 replyRouter 参数序列化精确合法', () => {
  const coord = new InteractiveRequestCoordinator();
  const vault = coord.upsertServerRequest({
    rpcId: 'v-1',
    socketGeneration: 1,
    method: 'vault.save_login',
    params: { session_id: 's1', site: 'github.com' },
    storedSessionId: 's1',
  });
  assert.ok(vault);
  const wsRoute = resolveReplyRoute(vault, { kind: 'credential', value: '', identifier: 'alice', password: 'pw' }, 1);
  assert.equal(wsRoute.transport, 'ws_response');
  if (wsRoute.transport === 'ws_response') {
    assert.deepEqual(JSON.parse(String(wsRoute.result.value)), { identifier: 'alice', password: 'pw' });
  }

  const clarify = coord.upsertServerRequest({
    rpcId: 'c-1',
    socketGeneration: 1,
    method: 'clarify',
    params: { session_id: 's1', question: 'Q?' },
    storedSessionId: 's1',
  });
  assert.ok(clarify);
  const cancelRpc = resolveReplyRoute(clarify, { kind: 'clarify', cancelled: true }, 99);
  assert.equal(cancelRpc.transport, 'rpc');
  if (cancelRpc.transport === 'rpc') {
    assert.equal(cancelRpc.method, 'request.answer');
    assert.equal('answers' in cancelRpc.params.result, false);
    assert.equal(cancelRpc.params.result.outcome, 'cancelled');
  }

  assert.equal(isIdempotentSettlementResponse('request.answer', { status: 'expired' }), true);
  assert.equal(isIdempotentSettlementResponse('approval.respond', { resolved: 0 }), true);
  assert.equal(isRetryableTransportError({ code: 4000, message: 'Extra inputs' }), false);
  assert.equal(isRetryableTransportError({ code: -32000, message: 'timeout' }), true);
});

test('ActivityState 与 AgentPresence 对 waiting 状态严格保持最高优先级 (waiting > running > unread)', () => {
  const st = resolveActivityState('s1', {
    waitingIds: new Set(['s1']),
    runningIds: new Set(['s1']),
    unreadIds: new Set(['s1']),
    streamingId: 's1',
  });
  assert.equal(st, 'waiting');

  const presence = deriveAgentPresence({
    isStreaming: true,
    waitingReason: 'credential',
    message: {
      thought: 'thinking',
      toolCalls: [{ name: 'bash', status: 'running', args: '{}' }],
    },
    turnStartedAt: 1000,
    now: 5000,
  });
  assert.equal(presence.kind, 'waiting');
  if (presence.kind === 'waiting') {
    assert.equal(presence.reason, 'credential');
  }
});

test('eventReducer 在聚焦其他会话时依然放出 request.cancel / approval.cancelled / connection.request / connection.update', () => {
  const ctx = { activeSessionIds: ['active-s'], activeStreamingMessageId: 'msg-1' };

  const cancels = reduceGatewayEvent(
    { type: 'request.cancel', session_id: 'other-s', payload: { id: 'req-9', method: 'clarify', reason: 'timeout' } },
    ctx,
  );
  assert.equal(cancels.length, 1);
  assert.equal(cancels[0].type, 'request-cancel');

  const appCancels = reduceGatewayEvent(
    { type: 'approval.cancelled', session_id: 'other-s', payload: { request_ids: ['a1'], cancelled_count: 1, reason: 'superseded' } },
    ctx,
  );
  assert.equal(appCancels.length, 1);
  assert.equal(appCancels[0].type, 'approval-cancelled');

  const connReq = reduceGatewayEvent(
    {
      type: 'connection.request',
      session_id: 'other-s',
      payload: { op_id: 'op-1', seq: 1, deadline_at: 2000, timeout_seconds: 60, targets: [{ name: 'gh', kind: 'connector', action: 'authorize', state: 'pending' }] },
    },
    ctx,
  );
  assert.equal(connReq.length, 1);
  assert.equal(connReq[0].type, 'connection-request');
});

test('parseConnectionRequestPayload / parseConnectionUpdatePayload 规范化合法目标并丢弃未知非法字段', () => {
  const req = parseConnectionRequestPayload({
    op_id: 'op-x',
    seq: 2,
    deadline_at: 100,
    timeout_seconds: 300,
    targets: [{ name: 'valid', kind: 'mcp', action: 'install', state: 'pending' }, { nope: true }],
  });
  assert.ok(req);
  assert.equal(req.targets.length, 1);
  assert.equal(req.targets[0].name, 'valid');

  const upd = parseConnectionUpdatePayload({
    op_id: 'op-x',
    seq: 3,
    deadline_at: 100,
    settled: false,
    targets: [{ name: 'valid', kind: 'mcp', action: 'install', state: 'initiated' }],
    owner: { type: 'account' },
  });
  assert.ok(upd);
  assert.equal(upd.owner.type, 'account');
});

test('bindSessionHandle 保持 connection::opId 主键并配合 applyConnectionUpdate 严格阻止同 seq 复活', () => {
  const coord = new InteractiveRequestCoordinator();
  const created = coord.applyConnectionRequest(
    'live-conn-1',
    {
      op_id: 'op-c1',
      seq: 2,
      deadline_at: 2000,
      timeout_seconds: 120,
      owner: { type: 'session', session_id: 'live-conn-1' },
      targets: [{ name: 'gh', kind: 'connector', action: 'authorize', state: 'pending' }],
    },
    1000,
    'default',
    null,
  );
  assert.ok(created);
  assert.equal(created.canonicalKey, 'connection::op-c1');

  coord.bindSessionHandle('stored-conn-1', 'live-conn-1');
  const afterBind = coord.getActivePromptsForFocus(
    { type: 'session', sessionId: 'stored-conn-1' },
    'stored-conn-1',
    'live-conn-1',
  );
  assert.equal(afterBind.length, 1);
  assert.equal(afterBind[0].canonicalKey, 'connection::op-c1');
  assert.equal(afterBind[0].scope.kind, 'session');
  if (afterBind[0].scope.kind === 'session') {
    assert.equal(afterBind[0].scope.storedSessionId, 'stored-conn-1');
  }

  coord.applyConnectionUpdate(
    {
      op_id: 'op-c1',
      seq: 3,
      deadline_at: 2000,
      settled: false,
      owner: { type: 'session', session_id: 'live-conn-1' },
      targets: [{ name: 'gh', kind: 'connector', action: 'authorize', state: 'initiated' }],
    },
    1100,
    'default',
    null,
  );
  const afterUpdate = coord.getActivePromptsForFocus(
    { type: 'session', sessionId: 'stored-conn-1' },
    'stored-conn-1',
    'live-conn-1',
  );
  assert.equal(afterUpdate.length, 1, '同一 op_id 更新不得因重键产生重复卡片');
  assert.equal(afterUpdate[0].targets[0].state, 'initiated');
  if (afterUpdate[0].scope.kind === 'session') {
    assert.equal(afterUpdate[0].scope.storedSessionId, 'stored-conn-1');
  }

  // 结算后同一 seq 或更小 seq 重放必须彻底吸收，不得复活
  coord.applyConnectionUpdate(
    {
      op_id: 'op-c1',
      seq: 3,
      deadline_at: 2000,
      settled: true,
      owner: { type: 'session', session_id: 'live-conn-1' },
      targets: [],
    },
    1200,
  );
  assert.equal(
    coord.getActivePromptsForFocus(
      { type: 'session', sessionId: 'stored-conn-1' },
      'stored-conn-1',
      'live-conn-1',
    ).length,
    0,
  );

  coord.applyConnectionUpdate(
    {
      op_id: 'op-c1',
      seq: 3,
      deadline_at: 2000,
      settled: false,
      owner: { type: 'session', session_id: 'live-conn-1' },
      targets: [{ name: 'gh', kind: 'connector', action: 'authorize', state: 'pending' }],
    },
    1300,
  );
  assert.equal(
    coord.getActivePromptsForFocus(
      { type: 'session', sessionId: 'stored-conn-1' },
      'stored-conn-1',
      'live-conn-1',
    ).length,
    0,
    '同 seq=3 乱序重放不得复活已结案连接卡',
  );

  // applyConnectionRespondResult 结案 seq=0 后同 seq=0 更新也不得复活
  coord.applyConnectionRequest(
    '',
    {
      op_id: 'op-c2',
      seq: 0,
      deadline_at: 2000,
      timeout_seconds: 120,
      targets: [{ name: 'slack', kind: 'connector', action: 'authorize', state: 'pending' }],
    },
    1400,
  );
  coord.applyConnectionRespondResult('op-c2', true);
  coord.applyConnectionUpdate(
    {
      op_id: 'op-c2',
      seq: 0,
      deadline_at: 2000,
      settled: false,
      owner: { type: 'account' },
      targets: [{ name: 'slack', kind: 'connector', action: 'authorize', state: 'pending' }],
    },
    1500,
  );
  assert.equal(
    coord.getActivePromptsForFocus({ type: 'session', sessionId: 'stored-conn-1' }, 'stored-conn-1', 'live-conn-1').length,
    0,
  );
});

test('reconcileFromResume、applyClarifyLockResult、cancelApprovalsForSession 与 clearForSession 行为完备', () => {
  const coord = new InteractiveRequestCoordinator();
  // 1. approval.pending 在 running resume 且 snapshot 无条目时保留，pending_connection 补全 storedSessionId
  const fence1 = coord.captureSyncFence();
  coord.reconcileApprovalPending(
    's-rec',
    'live-rec',
    'default',
    [{ request_id: 'app-1', command: 'ls', choices: ['once', 'deny'] }],
    fence1,
    1000,
  );
  const fence2 = coord.captureSyncFence();
  coord.reconcileFromResume({
    storedSessionId: 's-rec',
    liveSessionId: 'live-rec',
    profile: 'default',
    fence: fence2,
    nowMs: 1100,
    resume: { running: true },
  });
  assert.equal(
    coord
      .getActivePromptsForFocus({ type: 'session', sessionId: 's-rec' }, 's-rec', 'live-rec')
      .some((p) => p.kind === 'approval' && p.requestId === 'app-1'),
    true,
  );

  const fence3 = coord.captureSyncFence();
  coord.reconcileFromResume({
    storedSessionId: 's-rec',
    liveSessionId: 'live-rec',
    profile: 'default',
    fence: fence3,
    nowMs: 1150,
    resume: {
      running: true,
      pending_connection: {
        op_id: 'op-res',
        seq: 1,
        deadline_at: 5000,
        timeout_seconds: 60,
        targets: [{ name: 'notion', kind: 'connector', action: 'authorize', state: 'pending' }],
      },
    },
  });
  const recPrompts = coord.getActivePromptsForFocus({ type: 'session', sessionId: 's-rec' }, 's-rec', 'live-rec');
  const resConn = recPrompts.find((p) => p.kind === 'connection');
  assert.ok(resConn);
  assert.equal(resConn.scope.kind === 'session' ? resConn.scope.storedSessionId : null, 's-rec');

  // 2. applyClarifyLockResult 逐题锁定与最终收敛
  const clarify = coord.upsertServerRequest({
    rpcId: 77,
    socketGeneration: 1,
    method: 'clarify',
    params: {
      session_id: 'live-rec',
      prompt_id: 'cl-lock',
      questions: [
        { id: 'q1', prompt: 'Env?', choices: ['dev', 'prod'] },
        { id: 'q2', prompt: 'Region?', choices: ['us', 'eu'] },
      ],
    },
    storedSessionId: 's-rec',
    origin: 'live_ws',
  });
  assert.ok(clarify);
  coord.applyClarifyLockResult(clarify.canonicalKey, 'q1', 'prod', ['q2']);
  const partialClarify = coord.getPrompt(clarify.canonicalKey);
  assert.ok(partialClarify && partialClarify.kind === 'clarify');
  assert.equal(partialClarify.lockedAnswers.q1, 'prod');
  coord.applyClarifyLockResult(clarify.canonicalKey, 'q2', 'eu', []);
  assert.equal(coord.getPrompt(clarify.canonicalKey), undefined);

  // 3. cancelApprovalsForSession 精确按 request_ids 及 singleton 语义取消，不影响其他请求
  coord.upsertServerRequest({
    rpcId: 88,
    socketGeneration: 1,
    method: 'approval',
    params: { session_id: 'live-rec', request_id: 'req-a', command: 'rm a' },
    storedSessionId: 's-rec',
    origin: 'live_ws',
  });
  coord.upsertServerRequest({
    rpcId: 89,
    socketGeneration: 1,
    method: 'approval',
    params: { session_id: 'live-rec', request_id: 'req-b', command: 'rm b' },
    storedSessionId: 's-rec',
    origin: 'live_ws',
  });
  const cancelledCount = coord.cancelApprovalsForSession({
    session_id: 'live-rec',
    stored_session_id: 's-rec',
    request_ids: ['req-a'],
    cancelled_count: 1,
    reason: 'superseded',
  });
  assert.equal(cancelledCount, 1);
  const afterCancel = coord.getActivePromptsForFocus({ type: 'session', sessionId: 's-rec' }, 's-rec', 'live-rec');
  assert.equal(afterCancel.some((p) => p.requestId === 'req-a'), false);
  assert.equal(afterCancel.some((p) => p.requestId === 'req-b'), true);

  // 4. clearForSession 清空该会话全部残余请求但保留 account 级请求
  coord.applyConnectionRequest('', {
    op_id: 'op-acct',
    seq: 1,
    deadline_at: 9999,
    timeout_seconds: 60,
    targets: [{ name: 'gh', kind: 'connector', action: 'authorize', state: 'pending' }],
  });
  coord.clearForSession('s-rec', 'live-rec');
  const activeOther = coord.getActivePromptsForFocus({ type: 'session', sessionId: 's-rec' }, 's-rec', 'live-rec');
  assert.equal(activeOther.length, 1);
  assert.equal(activeOther[0].canonicalKey, 'connection::op-acct');

  // 5. resolveReplyRoute 在 classic 与 canonical 模式下对 group_action.choice 的差异收敛
  const classicRoute = resolveReplyRoute(
    {
      canonicalKey: 'g-1',
      requestId: 'r-1',
      kind: 'group_action',
      scope: { kind: 'group', roomId: 'room-c' },
      waitingReason: 'approval',
      status: 'open',
      arrivalSeq: 1,
      createdAtMs: 1,
      rpcId: null,
      socketGeneration: null,
      origin: 'group_state',
      protocol: 'classic',
      roomId: 'room-c',
      actionKind: 'approval',
      memberId: 'm1',
      taskId: 't1',
      executionGeneration: 1,
      choices: ['once', 'session', 'always', 'deny'],
    },
    { kind: 'group_action', action: 'approve', choice: 'always' },
  );
  assert.equal(classicRoute.params.choice, 'always');
});
