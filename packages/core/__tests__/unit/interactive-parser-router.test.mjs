/**
 * Connection 解析器、JSON-RPC 反向请求路由分类器与 Interactive Reply Router 全分支单测
 * (packages/core/__tests__/unit/interactive-parser-router.test.mjs)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyJsonRpcFrame,
  resolveUnsupportedServerRequestResponse,
  negotiateClientCapabilities,
  buildJsonRpcErrorFrame,
  parseConnectionOperationTarget,
  parseConnectionRequestPayload,
  parseConnectionUpdatePayload,
  serializeClarifyAnswer,
  resolveReplyRoute,
  isIdempotentSettlementResponse,
  isRetryableTransportError,
} from '../../dist/index.js';

test('serverRequestRouter: 帧分类、畸形 id/params 过滤、不支持退场与能力协商降级', async () => {
  // 1. classifyJsonRpcFrame 非对象/数组/无效帧/Notification/Response/ServerRequest
  assert.deepEqual(classifyJsonRpcFrame(null), { kind: 'ignore' });
  assert.deepEqual(classifyJsonRpcFrame([1, 2]), { kind: 'ignore' });
  assert.deepEqual(classifyJsonRpcFrame('raw'), { kind: 'ignore' });
  assert.deepEqual(classifyJsonRpcFrame({ jsonrpc: '2.0', id: '', method: '' }), { kind: 'ignore' });
  assert.deepEqual(classifyJsonRpcFrame({ jsonrpc: '2.0', id: Number.NaN }), { kind: 'ignore' });
  assert.deepEqual(classifyJsonRpcFrame({ jsonrpc: '2.0', method: 'notify.x', params: 'p' }), {
    kind: 'notification',
    method: 'notify.x',
    params: 'p',
  });
  const srArrParams = classifyJsonRpcFrame({ jsonrpc: '2.0', id: 's-1', method: 'clarify', params: ['bad'] });
  assert.equal(srArrParams.kind, 'server-request');
  if (srArrParams.kind === 'server-request') {
    assert.deepEqual(srArrParams.params, {});
  }
  const srNullParams = classifyJsonRpcFrame({ jsonrpc: '2.0', id: 7, method: 'sudo', params: null });
  assert.equal(srNullParams.kind, 'server-request');
  if (srNullParams.kind === 'server-request') {
    assert.deepEqual(srNullParams.params, {});
  }
  const respFrame = classifyJsonRpcFrame({ jsonrpc: '2.0', id: 8, result: { ok: true }, error: null });
  assert.equal(respFrame.kind, 'response');

  // 2. resolveUnsupportedServerRequestResponse 全分支含 theme.apply & declines_not_shown
  const appDecline = resolveUnsupportedServerRequestResponse('theme.apply', {
    server_requests: true,
    declines_not_shown: true,
  });
  assert.equal(appDecline?.kind, 'ws_error');
  const appCompat = resolveUnsupportedServerRequestResponse('theme.apply', null);
  assert.deepEqual(appCompat, { kind: 'ws_response', result: { value: '' } });

  // 3. buildJsonRpcErrorFrame 携带 data 字段
  const errWithData = JSON.parse(buildJsonRpcErrorFrame(9, -32602, 'bad', { field: 'x' }));
  assert.deepEqual(errWithData.error.data, { field: 'x' });

  // 4. negotiateClientCapabilities 默认字段、非对象报错与降级二次也失败返回 null
  const nonObjErr = await negotiateClientCapabilities(
    {
      async call() {
        throw 'string error';
      },
    },
    {},
  );
  assert.equal(nonObjErr, null);

  let attempt = 0;
  const doubleFail = await negotiateClientCapabilities(
    {
      async call() {
        attempt += 1;
        const err = new Error('Extra inputs rejected');
        err.code = 4000;
        throw err;
      },
    },
    {},
  );
  assert.equal(attempt, 2);
  assert.equal(doubleFail, null);
});

test('connectionParser: 全可选字段、null 重置、非法目标与 owner/display 归一化边界', () => {
  // 无效 payload / target
  assert.equal(parseConnectionOperationTarget(null), null);
  assert.equal(parseConnectionOperationTarget([]), null);
  assert.equal(parseConnectionOperationTarget({ name: 'gh', kind: 'invalid', action: 'authorize', state: 'pending' }), null);
  assert.equal(parseConnectionRequestPayload(null), null);
  assert.equal(parseConnectionRequestPayload({ seq: 1 }), null);
  assert.equal(parseConnectionUpdatePayload(null), null);
  assert.equal(parseConnectionUpdatePayload({ seq: 1 }), null);

  // 完整丰富 target 字段与子结构体分支
  const fullReq = parseConnectionRequestPayload({
    op_id: 'op-full',
    seq: 'bad',
    deadline_at: Number.NaN,
    timeout_seconds: Infinity,
    tool_call_id: 'tc-1',
    display: { suggested: ['a', 123, 'b'] },
    targets: [
      null,
      {
        name: 'linear',
        kind: 'mcp',
        action: 'install',
        state: 'connected',
        resolved: true,
        detail: 'ok',
        instructions: 'follow steps',
        discovery_error: 'none',
        connect_url: 'https://example.com',
        connection_id: 'cid-1',
        alias: 'lin',
        attempt: '2',
        required_env: [
          null,
          { name: '' },
          { name: 'API_KEY', required: false, secret: false, default: 'def', prompt: 'Enter key' },
          { name: 'TOKEN' },
        ],
        launch: { kind: 'stdio', target: 'npx server', env: ['API_KEY', 99], cwd: '/app' },
        tools: ['search', 42],
        hint: 'h',
        display: 'Linear',
        description: 'Linear MCP',
        tier: 'official',
        platforms: ['linux', 'darwin'],
        repo: 'org/repo',
        sha: 'abc123',
        subdir: 'pkg',
        scan: { status: 'warnings', summary: 'minor warning' },
        requires_hermes: '0.23.0',
        has_desktop_half: true,
        target_profile: 'default',
        app_state: 'present',
        skill: 'linear-skill',
        phase: 'downloading',
        approved: { force: true, enable: true, ref: 'main' },
        enabled: true,
        missing_env: ['MISSING_VAR'],
        server_errors: [null, {}, { name: 'srv', error: 'timeout' }],
        already_installed: false,
      },
      {
        name: 'minimal-nulls',
        kind: 'connector',
        action: 'connect',
        state: 'failed',
        required_env: null,
        launch: { kind: 'stdio', target: '' },
        scan: { status: 'unknown' },
        tier: 'unknown-tier',
        app_state: 'unknown-app',
        phase: 'unknown-phase',
        server_errors: null,
      },
      {
        name: 'explicit-null-enums',
        kind: 'plugin',
        action: 'enable',
        state: 'expired',
        required_env: 'not-array',
        launch: null,
        scan: null,
        tier: null,
        app_state: null,
        phase: null,
        approved: null,
        server_errors: 'not-array',
      },
    ],
  });
  assert.ok(fullReq);
  assert.equal(fullReq.seq, 0);
  assert.equal(fullReq.timeout_seconds, 300);
  assert.deepEqual(fullReq.display, { suggested: ['a', 'b'] });
  assert.equal(fullReq.targets.length, 3);
  assert.equal(fullReq.targets[0].required_env?.length, 2);
  assert.equal(fullReq.targets[0].required_env?.[0].secret, false);
  assert.equal(fullReq.targets[0].required_env?.[1].secret, true);
  assert.equal(fullReq.targets[0].launch?.cwd, '/app');
  assert.equal(fullReq.targets[0].tier, 'official');
  assert.equal(fullReq.targets[0].app_state, 'present');
  assert.equal(fullReq.targets[0].phase, 'downloading');
  assert.deepEqual(fullReq.targets[0].approved, { force: true, enable: true, ref: 'main' });
  assert.deepEqual(fullReq.targets[0].server_errors, [{ name: 'srv', error: 'timeout' }]);
  assert.equal(fullReq.targets[1].required_env, null);
  assert.equal(fullReq.targets[1].launch, undefined);
  assert.equal(fullReq.targets[1].scan, undefined);
  assert.equal(fullReq.targets[2].launch, null);
  assert.equal(fullReq.targets[2].tier, null);
  assert.equal(fullReq.targets[2].app_state, null);
  assert.equal(fullReq.targets[2].phase, null);
  assert.equal(fullReq.targets[2].approved, null);

  // parseConnectionRequestPayload display=null / display={suggested: 'bad'}
  const nullDisp = parseConnectionRequestPayload({
    op_id: 'op-disp',
    seq: 1,
    deadline_at: 2,
    timeout_seconds: 10,
    display: null,
    targets: 'bad',
  });
  assert.equal(nullDisp?.display, null);
  assert.deepEqual(nullDisp?.targets, []);
  const emptyDisp = parseConnectionRequestPayload({
    op_id: 'op-disp2',
    seq: 1,
    deadline_at: 2,
    timeout_seconds: 10,
    display: { suggested: 'bad' },
  });
  assert.deepEqual(emptyDisp?.display, { suggested: [] });

  // parseConnectionUpdatePayload 全枚举/null/owner 分支
  const updFull = parseConnectionUpdatePayload({
    op_id: 'op-u1',
    seq: 5,
    deadline_at: 99,
    settled: true,
    settled_at: 88,
    settled_by: 'all_resolved',
    target: 'linear',
    from: 'pending',
    to: 'connected',
    actor: 'backend_watcher',
    detail: 'done',
    owner: { type: 'session', session_id: 's-live' },
    targets: [],
  });
  assert.equal(updFull?.settled, true);
  assert.equal(updFull?.settled_at, 88);
  assert.equal(updFull?.settled_by, 'all_resolved');
  assert.equal(updFull?.from, 'pending');
  assert.equal(updFull?.to, 'connected');
  assert.equal(updFull?.actor, 'backend_watcher');
  assert.deepEqual(updFull?.owner, { type: 'session', session_id: 's-live' });

  const updNulls = parseConnectionUpdatePayload({
    op_id: 'op-u2',
    seq: 6,
    deadline_at: 99,
    settled: false,
    settled_at: null,
    settled_by: null,
    from: null,
    to: null,
    actor: null,
    owner: { type: 'session', session_id: '' },
  });
  assert.equal(updNulls?.settled_at, null);
  assert.equal(updNulls?.settled_by, null);
  assert.equal(updNulls?.from, null);
  assert.equal(updNulls?.to, null);
  assert.equal(updNulls?.actor, null);
  assert.deepEqual(updNulls?.owner, { type: 'account' });

  const updInvalidEnums = parseConnectionUpdatePayload({
    op_id: 'op-u3',
    settled_by: 'bad',
    from: 'bad',
    to: 'bad',
    actor: 'bad',
  });
  assert.equal(updInvalidEnums?.settled_by, undefined);
  assert.equal(updInvalidEnums?.from, undefined);
  assert.equal(updInvalidEnums?.to, undefined);
  assert.equal(updInvalidEnums?.actor, undefined);

  // connectionParser L68/73/82/127/128/149: null 可选值与缺失 env/cwd/ref
  const pNulls = parseConnectionRequestPayload({
    op_id: 'op-nulls',
    targets: [
      {
        name: 'gh',
        kind: 'connector',
        action: 'authorize',
        state: 'pending',
        resolved: null,
        detail: null,
        tools: null,
        required_env: [{ name: 'TOKEN', prompt: null }],
        launch: { kind: 'remote', target: 'https://x', env: null, cwd: null },
        approved: { force: false, enable: false },
      },
      {
        name: 'gh2',
        kind: 'mcp',
        action: 'install',
        state: 'connected',
        launch: { kind: 'stdio', target: 'srv' },
        approved: { force: true, enable: true, ref: null },
      },
    ],
  });
  assert.equal(pNulls?.targets[0].resolved, null);
  assert.equal(pNulls?.targets[0].detail, null);
  assert.equal(pNulls?.targets[0].tools, null);
  assert.equal(pNulls?.targets[0].required_env[0].prompt, null);
  assert.equal(pNulls?.targets[0].launch?.env, null);
  assert.equal(pNulls?.targets[0].launch?.cwd, null);
  assert.equal('ref' in (pNulls?.targets[0].approved ?? {}), false);
  assert.equal(pNulls?.targets[1].approved?.ref, null);
});

test('replyRouter: Clarify/Approval/Credential/Connection/Group 全路由组合与校验助手', () => {
  // serializeClarifyAnswer 去重、非字符串过滤、自定义裁剪与单/多选
  assert.equal(serializeClarifyAnswer(['Opt', 'Opt', 123], '  Extra  ', true), 'Opt, Extra');
  assert.equal(serializeClarifyAnswer([], '   ', false), null);
  assert.equal(serializeClarifyAnswer(['One'], '', false), 'One');

  const sessScope = { kind: 'session', storedSessionId: 'st-1', liveSessionId: 'lv-1', profile: 'p-1' };
  const appScope = { kind: 'app' };

  // rpc_confirm 本地回调路由
  const rpcRoute = resolveReplyRoute(
    {
      canonicalKey: 'c-1',
      requestId: 'c-1',
      kind: 'rpc_confirm',
      scope: sessScope,
      waitingReason: 'confirm',
      status: 'open',
      arrivalSeq: 1,
      createdAtMs: 1,
      rpcId: null,
      socketGeneration: null,
      origin: 'rpc_confirm',
      protocol: 'classic',
      confirmKind: 'expensive_model',
      title: 'Confirm',
      message: 'Msg',
    },
    { kind: 'rpc_confirm', outcome: 'confirm_always' },
    1,
  );
  assert.deepEqual(rpcRoute, { transport: 'local_callback', outcome: 'confirm_always' });

  // clarify canonical live_ws submitted & cancelled + canonical RPC fallback
  const canonicalClarify = {
    canonicalKey: 'cl-1',
    requestId: 'cl-1',
    kind: 'clarify',
    scope: sessScope,
    waitingReason: 'clarify',
    status: 'open',
    arrivalSeq: 2,
    createdAtMs: 2,
    rpcId: 'srv-cl',
    socketGeneration: 3,
    origin: 'live_ws',
    protocol: 'canonical',
    promptId: 'p-cl',
    executionGeneration: 4,
    questions: [{ qid: 'q1', question: 'Q?', multi_select: false }],
    lockedAnswers: {},
  };
  const wsClSubmit = resolveReplyRoute(canonicalClarify, { kind: 'clarify', answers: { q1: 'yes' } }, 3);
  assert.equal(wsClSubmit.transport, 'ws_response');
  if (wsClSubmit.transport === 'ws_response') assert.equal(wsClSubmit.result.outcome, 'submitted');

  const wsClCancel = resolveReplyRoute(canonicalClarify, { kind: 'clarify', cancelled: true }, 3);
  if (wsClCancel.transport === 'ws_response') assert.equal(wsClCancel.result.outcome, 'cancelled');

  const canRpcSubmit = resolveReplyRoute(canonicalClarify, { kind: 'clarify', singleAnswer: 'solo' }, 9);
  assert.equal(canRpcSubmit.transport, 'rpc');
  if (canRpcSubmit.transport === 'rpc') {
    assert.equal(canRpcSubmit.method, 'clarify.respond');
    assert.equal(canRpcSubmit.params.answer, 'solo');
  }
  const canRpcCancel = resolveReplyRoute(
    { ...canonicalClarify, executionGeneration: undefined },
    { kind: 'clarify', cancelled: true },
    9,
  );
  if (canRpcCancel.transport === 'rpc') {
    assert.equal(canRpcCancel.params.answer, '');
    assert.equal(canRpcCancel.params.execution_generation, 0);
  }
  const canRpcFallbackAns = resolveReplyRoute(canonicalClarify, { kind: 'clarify', answers: { q1: 'ans1' } }, 9);
  if (canRpcFallbackAns.transport === 'rpc') assert.equal(canRpcFallbackAns.params.answer, 'ans1');
  const canRpcEmpty = resolveReplyRoute({ ...canonicalClarify, questions: [] }, { kind: 'clarify' }, 9);
  if (canRpcEmpty.transport === 'rpc') assert.equal(canRpcEmpty.params.answer, '');

  // classic clarify RPC 无 profile 与有 answers
  const classicClarifyApp = { ...canonicalClarify, protocol: 'classic', promptId: undefined, scope: appScope };
  const clAppRpc = resolveReplyRoute(classicClarifyApp, { kind: 'clarify', answers: { q1: 'a' } }, 9);
  if (clAppRpc.transport === 'rpc') {
    assert.equal(clAppRpc.method, 'request.answer');
    assert.equal('profile' in clAppRpc.params, false);
  }

  // approval live WS / canonical RPC / classic RPC (含 all:true 与 singleton: 前缀)
  const appPrompt = {
    canonicalKey: 'ap-1',
    requestId: 'ap-1',
    kind: 'approval',
    scope: sessScope,
    waitingReason: 'approval',
    status: 'open',
    arrivalSeq: 3,
    createdAtMs: 3,
    rpcId: 'srv-ap',
    socketGeneration: 2,
    origin: 'live_ws',
    protocol: 'classic',
    choices: ['once', 'deny'],
  };
  const wsApAll = resolveReplyRoute(appPrompt, { kind: 'approval', choice: 'once', all: true }, 2);
  if (wsApAll.transport === 'ws_response') assert.equal(wsApAll.result.all, true);

  const canApRpc = resolveReplyRoute(
    { ...appPrompt, protocol: 'canonical', promptId: 'ap-p', executionGeneration: 5 },
    { kind: 'approval', choice: 'once' },
    9,
  );
  if (canApRpc.transport === 'rpc') {
    assert.equal(canApRpc.params.prompt_id, 'ap-p');
    assert.equal(canApRpc.params.execution_generation, 5);
  }
  const canApNoGen = resolveReplyRoute(
    { ...appPrompt, protocol: 'canonical', promptId: 'ap-p', executionGeneration: undefined, scope: appScope },
    { kind: 'approval', choice: 'deny' },
    9,
  );
  if (canApNoGen.transport === 'rpc') assert.equal(canApNoGen.params.execution_generation, 0);

  const clsApSingleton = resolveReplyRoute(
    { ...appPrompt, requestId: 'singleton:1', scope: appScope },
    { kind: 'approval', choice: 'session', all: true },
    9,
  );
  if (clsApSingleton.transport === 'rpc') {
    assert.equal('request_id' in clsApSingleton.params, false);
    assert.equal('profile' in clsApSingleton.params, false);
    assert.equal(clsApSingleton.params.all, true);
  }
  const clsApNormal = resolveReplyRoute(appPrompt, { kind: 'approval', choice: 'once' }, 9);
  if (clsApNormal.transport === 'rpc') assert.equal(clsApNormal.params.request_id, 'ap-1');

  // credential vault.save_login 空值、pre-serialized value、以及 RPC 无 profile 回退
  const credPrompt = {
    canonicalKey: 'cr-1',
    requestId: 'cr-1',
    kind: 'credential',
    method: 'vault.save_login',
    scope: appScope,
    waitingReason: 'credential',
    status: 'open',
    arrivalSeq: 4,
    createdAtMs: 4,
    rpcId: null,
    socketGeneration: null,
    origin: 'open_requests',
    protocol: 'classic',
  };
  const emptyVault = resolveReplyRoute(credPrompt, { kind: 'credential', value: '' }, null);
  if (emptyVault.transport === 'rpc') assert.equal(emptyVault.params.result.value, '');
  const preVault = resolveReplyRoute(credPrompt, { kind: 'credential', value: '{"a":1}' }, null);
  if (preVault.transport === 'rpc') assert.equal(preVault.params.result.value, '{"a":1}');
  const partialVault = resolveReplyRoute(credPrompt, { kind: 'credential', value: '', identifier: 'id' }, null);
  if (partialVault.transport === 'rpc') assert.deepEqual(JSON.parse(partialVault.params.result.value), { identifier: 'id', password: '' });
  const credWithProf = resolveReplyRoute({ ...credPrompt, scope: sessScope }, { kind: 'credential', value: 'v' }, null);
  if (credWithProf.transport === 'rpc') assert.equal(credWithProf.params.profile, 'p-1');

  // connection reply
  const connRoute = resolveReplyRoute(
    {
      canonicalKey: 'conn-1',
      requestId: 'op-1',
      kind: 'connection',
      scope: { kind: 'account', profile: 'p-acc' },
      waitingReason: 'connection',
      status: 'open',
      arrivalSeq: 5,
      createdAtMs: 5,
      rpcId: null,
      socketGeneration: null,
      origin: 'connection_event',
      protocol: 'classic',
      opId: 'op-1',
      seq: 1,
      deadlineAtMs: 100,
      timeoutSeconds: 60,
      owner: { type: 'account' },
      targets: [],
    },
    { kind: 'connection', targets: [{ name: 'gh', status: 'skipped' }], settledBy: 'continue', said: 'ok' },
    null,
  );
  if (connRoute.transport === 'rpc') {
    assert.equal(connRoute.params.profile, 'p-acc');
    assert.equal(connRoute.params.result.said, 'ok');
    assert.equal(connRoute.params.result.settled_by, 'continue');
  }
  const connMinRoute = resolveReplyRoute(
    {
      canonicalKey: 'conn-2',
      requestId: 'op-2',
      kind: 'connection',
      scope: appScope,
      waitingReason: 'connection',
      status: 'open',
      arrivalSeq: 6,
      createdAtMs: 6,
      rpcId: null,
      socketGeneration: null,
      origin: 'connection_event',
      protocol: 'classic',
      opId: 'op-2',
      seq: 1,
      deadlineAtMs: 100,
      timeoutSeconds: 60,
      owner: { type: 'account' },
      targets: [],
    },
    { kind: 'connection' },
    null,
  );
  if (connMinRoute.transport === 'rpc') assert.deepEqual(connMinRoute.params.result, {});

  // group_action retry / discard / canonical coercion / mismatched throw
  const grpPrompt = {
    canonicalKey: 'g-1',
    requestId: 'gr-1',
    kind: 'group_action',
    scope: { kind: 'group', roomId: 'room-1', profile: 'p-grp' },
    waitingReason: 'confirm',
    status: 'open',
    arrivalSeq: 7,
    createdAtMs: 7,
    rpcId: null,
    socketGeneration: null,
    origin: 'group_state',
    protocol: 'canonical',
    roomId: 'room-1',
    actionKind: 'retry',
    memberId: 'm1',
    taskId: 't1',
    executionGeneration: 2,
    choices: ['once', 'deny'],
  };
  const rRetry = resolveReplyRoute(grpPrompt, { kind: 'group_action', action: 'retry' }, null);
  assert.equal(rRetry.method, 'groups.retry');
  assert.equal(rRetry.params.profile, 'p-grp');
  const rRetryNoProf = resolveReplyRoute({ ...grpPrompt, scope: appScope }, { kind: 'group_action', action: 'retry' }, null);
  assert.equal('profile' in rRetryNoProf.params, false);
  const rDiscard = resolveReplyRoute(grpPrompt, { kind: 'group_action', action: 'discard' }, null);
  assert.equal(rDiscard.method, 'groups.discard');
  const rDiscardNoProf = resolveReplyRoute({ ...grpPrompt, scope: appScope }, { kind: 'group_action', action: 'discard' }, null);
  assert.equal('profile' in rDiscardNoProf.params, false);
  const rApproveCan = resolveReplyRoute(grpPrompt, { kind: 'group_action', action: 'approve', choice: 'always' }, null);
  assert.equal(rApproveCan.params.choice, 'once');
  const rApproveNoProf = resolveReplyRoute({ ...grpPrompt, scope: appScope }, { kind: 'group_action', action: 'approve' }, null);
  assert.equal(rApproveNoProf.params.choice, 'once');
  assert.equal('profile' in rApproveNoProf.params, false);

  assert.throws(
    () => resolveReplyRoute(grpPrompt, { kind: 'approval', choice: 'once' }, null),
    /Mismatched interactive reply kind/,
  );

  // isIdempotentSettlementResponse & isRetryableTransportError 全分支
  assert.equal(isIdempotentSettlementResponse('clarify.respond', null), false);
  assert.equal(isIdempotentSettlementResponse('clarify.respond', { status: 'resolved' }), true);
  assert.equal(isIdempotentSettlementResponse('unknown.method', { status: 'resolved' }), false);
  assert.equal(isRetryableTransportError('primitive-err'), true);
  assert.equal(isRetryableTransportError({ message: null }), true);
  assert.equal(isRetryableTransportError({ message: 'Contract schema error' }), false);

  // replyRouter L74: session scope 同时缺失 liveSessionId 与 storedSessionId 时安全回落空串
  const bareSessRoute = resolveReplyRoute(
    {
      canonicalKey: 'cl-bare',
      requestId: 'cl-bare',
      kind: 'clarify',
      scope: { kind: 'session', storedSessionId: null, liveSessionId: null },
      waitingReason: 'clarify',
      status: 'open',
      arrivalSeq: 99,
      createdAtMs: 1,
      rpcId: null,
      socketGeneration: null,
      origin: 'canonical_prompt',
      protocol: 'canonical',
      promptId: 'p-bare',
      executionGeneration: 1,
      questions: [{ qid: 'q1', question: 'Q?', multi_select: false }],
      lockedAnswers: {},
    },
    { kind: 'clarify', answers: { q1: 'ok' } },
    1,
  );
  assert.equal(bareSessRoute.transport, 'rpc');
  if (bareSessRoute.transport === 'rpc') {
    assert.equal(bareSessRoute.params.session_id, '');
  }

  // classic clarify RPC fallback omitting answers -> answers ?? {} (L146)
  const classicNoAnswers = resolveReplyRoute(
    {
      canonicalKey: 'session:s1::clarify::c-empty',
      requestId: 'c-empty',
      kind: 'clarify',
      scope: { kind: 'session', storedSessionId: 's1', liveSessionId: 'lv1' },
      waitingReason: 'clarify',
      status: 'open',
      arrivalSeq: 100,
      createdAtMs: 1,
      rpcId: null,
      socketGeneration: null,
      origin: 'open_requests',
      protocol: 'classic',
      questions: [{ qid: 'q1', question: 'Q?', multi_select: false }],
      lockedAnswers: {},
    },
    { kind: 'clarify' },
    1,
  );
  assert.equal(classicNoAnswers.transport, 'rpc');
  if (classicNoAnswers.transport === 'rpc') {
    assert.deepEqual(classicNoAnswers.params.result, { answers: {}, outcome: 'submitted' });
  }
});
