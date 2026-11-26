/**
 * InteractiveRequestCoordinator 全边界条件、并发合流、重键与作用域聚合单测
 * (packages/core/__tests__/unit/interactive-coordinator-edge.test.mjs)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { InteractiveRequestCoordinator } from '../../dist/index.js';

test('InteractiveRequestCoordinator: app/session 作用域、single question 解析、submitting 保留与未知 method 退回 null', () => {
  const coord = new InteractiveRequestCoordinator();

  // 1. display.install.sudo 无 sessionId 时落入 app scope 含 profile_key
  const appSudo = coord.upsertServerRequest({
    rpcId: 11,
    socketGeneration: 1,
    method: 'display.install.sudo',
    params: { profile_key: 'xvfb', command: 'apt-get install xvfb', prompt: 'Need sudo', hint: 'pwd', origin: 'https://x.test', backend: 'keychain', display_name: 'Disp', metadata: { k: 1 } },
  });
  assert.ok(appSudo);
  assert.equal(appSudo.scope.kind, 'app');
  assert.equal(coord.getPrompt(appSudo.canonicalKey)?.canonicalKey, 'app::cred::display.install.sudo::11');
  const activeOnGroup = coord.getActivePromptsForFocus({ type: 'group', roomId: 'r1' }, '', '');
  assert.equal(activeOnGroup.some((p) => p.canonicalKey === appSudo.canonicalKey), true);
  assert.equal(coord.getWaitingEntityMaps().sessionWaitingReasons.size, 0);

  // 2. 未知 method 返回 null
  assert.equal(coord.upsertServerRequest({ rpcId: 12, socketGeneration: 1, method: 'unknown.req', params: {} }), null);

  // 3. clarify questions=非数组 + single question 参数 + existing lockedAnswers 合并 + submitting 状态保持
  const clSingle = coord.upsertServerRequest({
    rpcId: 'c-single',
    socketGeneration: 1,
    method: 'clarify',
    params: { session_id: 'live-1', question: 'Confirm?', choices: ['Yes', 99], multi_select: true, answers: { 'c-single': null, x: 'locked', bad: 42 } },
  });
  assert.ok(clSingle && clSingle.kind === 'clarify');
  assert.deepEqual(clSingle.questions, [{ qid: 'c-single', question: 'Confirm?', choices: ['Yes'], multi_select: true }]);
  assert.equal(clSingle.lockedAnswers.x, 'locked');
  assert.equal(coord.beginSubmit(clSingle.canonicalKey), true);
  const clReupserted = coord.upsertServerRequest({
    rpcId: 'c-single',
    socketGeneration: 1,
    method: 'clarify',
    params: { session_id: 'live-1', question: 'Confirm?', answers: { y: '2' } },
  });
  assert.equal(clReupserted?.status, 'submitting');
  if (clReupserted?.kind === 'clarify') {
    assert.deepEqual(clReupserted.lockedAnswers, { 'c-single': null, x: 'locked', y: '2' });
  }

  // clarify questions=空数组 + app scope clarify/approval
  const clApp = coord.upsertServerRequest({
    rpcId: 'c-empty',
    socketGeneration: 1,
    method: 'clarify',
    params: { questions: [null, { question: 'Q0', choices: 'not-arr' }] },
  });
  assert.ok(clApp);
  const clNone = coord.upsertServerRequest({
    rpcId: 'c-none',
    socketGeneration: 1,
    method: 'clarify',
    params: { questions: [null] },
  });
  assert.ok(clNone && clNone.kind === 'clarify');
  assert.deepEqual(clNone.questions, []);

  // 4. approval allow_session/allow_permanent/smart_denied/edit & app_scope & terminalKeys 阻挡非 live_ws 重建但放行 live_ws 新 rpcId
  const appApproval = coord.upsertServerRequest({
    rpcId: 21,
    socketGeneration: 1,
    method: 'approval',
    params: { session_id: 'live-1', allow_session: true, allow_permanent: true, smart_denied: true, edit: { diff: '+a' } },
  });
  assert.ok(appApproval && appApproval.kind === 'approval');
  assert.deepEqual(appApproval.choices, ['once', 'session', 'always', 'deny']);
  assert.equal(appApproval.smartDenied, true);
  coord.confirmSettled(appApproval.canonicalKey);

  // 非 live_ws 回放同一 key 被终态吸收
  const blockedReplay = coord.upsertServerRequest({
    rpcId: 21,
    socketGeneration: -1,
    method: 'approval',
    params: { session_id: 'live-1' },
    origin: 'open_requests',
  });
  assert.equal(blockedReplay?.status, 'settled');
  // live_ws 下发可清除 terminalKey 重建
  const revivedLive = coord.upsertServerRequest({
    rpcId: 22,
    socketGeneration: 2,
    method: 'approval',
    params: { session_id: 'live-1', request_id: 'singleton:21' },
    origin: 'live_ws',
  });
  assert.equal(revivedLive?.status, 'open');
});

test('InteractiveRequestCoordinator: bindSessionHandle 双端碰撞合并、onSocketClosed 与 reconcileFromResume 围栏全路径', () => {
  const coord = new InteractiveRequestCoordinator();

  // 空参提前返回
  coord.bindSessionHandle('', 'l1');
  coord.bindSessionHandle('s1', '');

  // live 端与 stored 端同后缀碰撞，含 targetExisting submitting/settled 状态优先保留
  coord.upsertServerRequest({
    rpcId: 'srv-10',
    socketGeneration: 1,
    method: 'secret',
    params: { session_id: 'live-col', env_var: 'A' },
    storedSessionId: null,
    origin: 'live_ws',
    nowMs: 100,
  });
  coord.upsertServerRequest({
    rpcId: 'srv-10',
    socketGeneration: 1,
    method: 'secret',
    params: { session_id: 'live-col', env_var: 'A' },
    storedSessionId: 'stored-col',
    origin: 'open_requests',
    nowMs: 200,
  });
  coord.beginSubmit('session:stored-col::cred::secret::srv-10');
  coord.bindSessionHandle('stored-col', 'live-col');
  assert.equal(coord.getPrompt('session:stored-col::cred::secret::srv-10')?.status, 'submitting');

  // rpc_confirm 的 scope 更新走 keepStableKey + newKey === oldKey 分支
  coord.addRpcConfirmPrompt({
    canonicalKey: 'rpc-confirm::m',
    requestId: 'rpc-confirm::m',
    kind: 'rpc_confirm',
    scope: { kind: 'session', storedSessionId: null, liveSessionId: 'live-col' },
    waitingReason: 'confirm',
    createdAtMs: 50,
    rpcId: null,
    socketGeneration: null,
    origin: 'rpc_confirm',
    protocol: 'classic',
    confirmKind: 'expensive_model',
    title: 'T',
    message: 'M',
  });
  coord.bindSessionHandle('stored-col', 'live-col');
  assert.equal(coord.getPrompt('rpc-confirm::m')?.scope.kind, 'session');

  // onSocketClosed 定向按 generation 解绑
  coord.upsertServerRequest({
    rpcId: 'srv-20',
    socketGeneration: 2,
    method: 'sudo',
    params: { session_id: 'live-2' },
    storedSessionId: 'st-2',
  });
  coord.onSocketClosed(1);
  assert.equal(coord.getPrompt('session:st-2::cred::sudo::srv-20')?.socketGeneration, 2);
  coord.onSocketClosed(2);
  assert.equal(coord.getPrompt('session:st-2::cred::sudo::srv-20')?.rpcId, null);

  // reconcileFromResume: 无效输入、prompts[] (clarify & approval with edit/bad gen)、pending_approval 无 request_id、open_requests 与围栏删除
  coord.reconcileFromResume({ storedSessionId: '', liveSessionId: null, resume: {}, fence: 0 });
  const stale = coord.upsertServerRequest({
    rpcId: 'stale-1',
    socketGeneration: 1,
    method: 'sudo',
    params: { session_id: 'live-st' },
    storedSessionId: 'st-fence',
  });
  assert.ok(stale);
  const fenceAfter = coord.captureSyncFence();
  coord.reconcileFromResume({
    storedSessionId: 'st-fence',
    liveSessionId: 'live-st',
    profile: 'prof-f',
    fence: fenceAfter,
    nowMs: 500,
    resume: {
      info: { desktop_protocol: 'hermes-gateway-v1' },
      prompts: [
        null,
        { prompt_id: '', kind: 'clarify' },
        { prompt_id: 'p-cl-1', kind: 'clarify', question: 'Which?', choices: ['A', 1], execution_generation: 'bad', multi_select: true },
        { prompt_id: 'p-ap-1', kind: 'approval', command: 'git status', description: 'check', execution_generation: 3, edit: { path: 'a.ts' } },
      ],
      pending_approval: { command: 'rm a', description: 'd', tool_name: 'terminal', allow_session: true, allow_permanent: false, smart_denied: false, edit: { path: 'b.ts' } },
      open_requests: [null, { id: '', method: 'secret' }, { id: 'dis', method: 'display.install.sudo', params: {} }],
    },
  });
  assert.equal(coord.getPrompt(stale.canonicalKey), undefined, 'snapshot 中缺失且 <= fence 的旧 open 条目必须被裁剪');
  assert.ok(coord.getPrompt('session:st-fence::clarify::p-cl-1'));
  assert.ok(coord.getPrompt('session:st-fence::approval::p-ap-1'));
  assert.ok(coord.getPrompt('app::cred::display.install.sudo::dis'));

  // reconcileApprovalPending 跳过非对象项，处理无 request_id / edit / smart_denied / allow flags
  coord.reconcileApprovalPending(
    'st-ap',
    'lv-ap',
    undefined,
    [null, { command: 'pwd', description: 'd', tool_name: 'sh', allow_session: true, allow_permanent: true, smart_denied: true, edit: { path: 'x' } }],
    0,
  );
  assert.ok(coord.getPrompt('session:st-ap::approval::singleton:pending-1'));
});

test('InteractiveRequestCoordinator: Connection、Group、Cancel、Focus 聚焦与后台等待汇总全边界', () => {
  const coord = new InteractiveRequestCoordinator();

  // Connection empty / stale seq / partial respond / missing / wrong kind / applyClarifyLockResult early return
  assert.equal(coord.applyConnectionRequest('', { op_id: '', seq: 1, deadline_at: 1, timeout_seconds: 1, targets: [] }), null);
  const c1 = coord.applyConnectionRequest(undefined, {
    op_id: 'op-x',
    seq: 3,
    deadline_at: 0,
    timeout_seconds: 60,
    tool_call_id: 'tc-x',
    display: { suggested: ['gh'] },
    targets: [{ name: 'gh', kind: 'connector', action: 'authorize', state: 'pending' }],
  }, 1000, 'prof-x');
  assert.ok(c1);
  // 乱序较小 seq 被忽略返回 existing
  assert.equal(coord.applyConnectionRequest(undefined, { op_id: 'op-x', seq: 1, deadline_at: 0, timeout_seconds: 60, targets: [] })?.seq, 3);
  coord.applyConnectionUpdate({ op_id: '', seq: 1, deadline_at: 0, settled: false, targets: [], owner: { type: 'account' } });
  coord.applyConnectionUpdate({ op_id: 'op-x', seq: 2, deadline_at: 0, settled: false, targets: [], owner: { type: 'account' } });
  // 部分成功更新 targets
  coord.applyConnectionRespondResult('op-x', false, [{ name: 'gh', kind: 'connector', action: 'authorize', state: 'initiated' }]);
  assert.equal(coord.getPrompt('connection::op-x')?.targets[0].state, 'initiated');
  coord.applyConnectionRespondResult('missing-op', false);
  coord.applyConnectionUpdate({ op_id: 'op-x', seq: 4, deadline_at: 5000, settled: false, targets: [], owner: { type: 'account' } });
  assert.equal(coord.getPrompt('connection::op-x')?.toolCallId, 'tc-x');
  coord.applyClarifyLockResult('connection::op-x', 'q1', 'a', []);

  // Group actions: empty roomId, retry/prepare/approval/canonical empty choices/removal of gone open actions
  coord.reconcileGroupPendingActions('', undefined, []);
  coord.reconcileGroupPendingActions(
    'room-1',
    'p-r1',
    [
      { kind: 'approval', requestId: 'ga-1', memberId: 'm1', taskId: 't1', executionGeneration: 1, command: 'ls', choices: ['session'] },
      { kind: 'retry', memberId: 'm2', taskId: 't2', executionGeneration: 1, errorDetail: 'err' },
    ],
    'canonical',
    100,
  );
  assert.deepEqual(coord.getPrompt('group::room-1::approval::ga-1')?.choices, ['once', 'deny']);
  assert.equal(coord.getWaitingReasonForGroup('room-1'), 'approval');
  assert.equal(coord.getWaitingEntityMaps().groupWaitingReasons.get('room-1'), 'approval');
  assert.equal(coord.getWaitingReasonForFocus({ type: 'group', roomId: 'room-1' }, '', ''), 'connection');
  coord.applyConnectionUpdate({ op_id: 'op-x', seq: 5, deadline_at: 0, settled: true, targets: [], owner: { type: 'account' } });
  assert.equal(coord.getPrompt('connection::op-x'), undefined);
  assert.equal(coord.getWaitingReasonForFocus({ type: 'group', roomId: 'room-1' }, '', ''), 'approval');

  // 第二次在同一群添 retry 与另一个房间 group，验证 getBackgroundWaitingPrompts 计数累加与 min(createdAtMs)
  coord.reconcileGroupPendingActions(
    'room-2',
    undefined,
    [
      { kind: 'retry', memberId: 'm3', taskId: 't3', executionGeneration: 1, errorDetail: 'e3' },
      { kind: 'retry', memberId: 'm4', taskId: 't4', executionGeneration: 1, errorDetail: 'e4' },
    ],
    'classic',
    200,
  );
  // 对同 session 塞两条请求以覆盖 session/bot aggregation 分支与 botForeverSessionIds
  coord.upsertServerRequest({ rpcId: 'bg-1', socketGeneration: 1, method: 'clarify', params: { session_id: 's-bg', question: '1' }, storedSessionId: 's-bg', nowMs: 300 });
  coord.upsertServerRequest({ rpcId: 'bg-2', socketGeneration: 1, method: 'sudo', params: { session_id: 's-bg' }, storedSessionId: 's-bg', nowMs: 150 });
  const bgList = coord.getBackgroundWaitingPrompts(
    { type: 'group', roomId: 'room-1' },
    'other',
    'other',
    new Map([['s-bg', 'coder-bot']]),
  );
  const botSummary = bgList.find((s) => s.entityType === 'bot' && s.entityId === 'coder-bot');
  const room2Summary = bgList.find((s) => s.entityType === 'group' && s.entityId === 'room-2');
  assert.equal(botSummary?.promptCount, 2);
  assert.equal(botSummary?.oldestCreatedAtMs, 150);
  assert.equal(room2Summary?.promptCount, 2);
  assert.equal(coord.getWaitingReasonForSession('s-bg'), 'clarify');
  assert.equal(coord.hasPendingPromptForSession(''), false);

  // 更新 room-1 移除 ga-1，保留 t2
  coord.reconcileGroupPendingActions('room-1', 'p-r1', [
    { kind: 'retry', memberId: 'm2', taskId: 't2', executionGeneration: 1, errorDetail: 'err' },
  ]);
  assert.equal(coord.getPrompt('group::room-1::approval::ga-1'), undefined);

  // 状态机边界：beginSubmit / confirmSettled / rollbackSubmit / cancelByRequestId / cancelApprovalsForSession singleton 匹配
  assert.equal(coord.beginSubmit('missing'), false);
  coord.confirmSettled('missing');
  assert.equal(coord.rollbackSubmit('missing', 'err'), false);
  assert.equal(coord.cancelByRequestId(''), 0);

  const s1 = coord.upsertServerRequest({
    rpcId: '999',
    socketGeneration: 1,
    method: 'approval',
    params: { session_id: 's-singleton' },
    storedSessionId: 's-singleton',
  });
  assert.ok(s1);
  // 通过 serverRequestId ('999') 而非 singleton:999 精准取消，再试一次 singleton 无 ids 取消
  assert.equal(coord.cancelByRequestId('999', 'done'), 1);
  coord.upsertServerRequest({
    rpcId: '1000',
    socketGeneration: 1,
    method: 'approval',
    params: { session_id: 's-singleton' },
    storedSessionId: 's-singleton',
  });
  assert.equal(
    coord.cancelApprovalsForSession({ stored_session_id: 's-singleton', cancelled_count: 1, reason: 'auto' }),
    1,
  );
});

test('InteractiveRequestCoordinator: 分支补齐（match变体/submitting保护/seq阻断/focus/maps/rollback）', () => {
  const coord = new InteractiveRequestCoordinator();

  // 1. promptMatchesSession 变体 (L137-139) 与 submitting 状态二次 upsert (L299/332/744/808/897)
  const lvOnly = coord.upsertServerRequest({
    rpcId: 'lv-only-1',
    socketGeneration: 1,
    method: 'approval',
    params: { session_id: 'lv-alias', request_id: 'req-lv-alias' },
  });
  assert.ok(lvOnly);
  assert.equal(coord.hasPendingPromptForSession('lv-alias', 'diff'), true); // L138
  assert.equal(coord.hasPendingPromptForSession('diff', 'lv-alias'), true); // L137

  const stPair = coord.upsertServerRequest({
    rpcId: 'st-pair-1',
    socketGeneration: 1,
    method: 'clarify',
    params: { session_id: 'lv-pair', question: 'Q1?' },
    storedSessionId: 'st-pair',
  });
  assert.ok(stPair);
  assert.equal(coord.hasPendingPromptForSession('diff', 'st-pair'), true); // L139
  assert.equal(coord.hasPendingPromptForSession('diff', 'diff'), false);
  assert.equal(coord.getWaitingReasonForSession('diff'), null);
  assert.equal(coord.getWaitingReasonForGroup('missing-room'), null);

  // submitting 状态保持 + rollbackSubmit true + 无 reason cancelByRequestId
  assert.equal(coord.beginSubmit(lvOnly.canonicalKey), true);
  coord.upsertServerRequest({
    rpcId: 'lv-only-2',
    socketGeneration: 2,
    method: 'approval',
    params: { session_id: 'lv-alias', request_id: 'req-lv-alias' },
  });
  assert.equal(coord.getPrompt(lvOnly.canonicalKey)?.status, 'submitting');
  assert.equal(coord.rollbackSubmit(lvOnly.canonicalKey, 'retryable'), true);
  assert.equal(coord.getPrompt(lvOnly.canonicalKey)?.status, 'open');
  assert.equal(coord.cancelByRequestId('req-lv-alias'), 1);

  const credSub = coord.upsertServerRequest({
    rpcId: 'cred-sub',
    socketGeneration: 1,
    method: 'secret',
    params: { session_id: 'lv-c' },
    storedSessionId: 'st-c',
  });
  assert.equal(coord.beginSubmit(credSub.canonicalKey), true);
  coord.upsertServerRequest({
    rpcId: 'cred-sub',
    socketGeneration: 1,
    method: 'secret',
    params: { session_id: 'lv-c' },
    storedSessionId: 'st-c',
  });
  assert.equal(coord.getPrompt(credSub.canonicalKey)?.status, 'submitting');

  // 2. bindSessionHandle 跳过非 session (app + group) & reconcileFromResume 无 profile + rpc_confirm 保留
  const appSudo = coord.upsertServerRequest({
    rpcId: 'app-1',
    socketGeneration: 1,
    method: 'display.install.sudo',
    params: {},
  });
  assert.ok(appSudo);
  coord.reconcileGroupPendingActions(
    'rm-classic',
    undefined,
    [
      { kind: 'approval', requestId: 'ga-cl', memberId: 'm1', taskId: 't1', executionGeneration: 1, command: 'ls', choices: ['once', 'always'] },
      { kind: 'approval', requestId: 'ga-sub', memberId: 'm2', taskId: 't2', executionGeneration: 1, command: 'id', choices: ['once'] },
    ],
    'classic',
  );
  assert.equal(coord.beginSubmit('group::rm-classic::approval::ga-sub'), true);
  coord.reconcileGroupPendingActions('rm-classic', undefined, [
    { kind: 'approval', requestId: 'ga-cl', memberId: 'm1', taskId: 't1', executionGeneration: 1, command: 'ls', choices: ['once', 'always'] },
    { kind: 'approval', requestId: 'ga-sub', memberId: 'm2', taskId: 't2', executionGeneration: 1, command: 'id', choices: ['once'] },
  ], 'classic');
  assert.equal(coord.getPrompt('group::rm-classic::approval::ga-sub')?.status, 'submitting');
  assert.equal(coord.getWaitingReasonForGroup('rm-classic'), 'approval');

  coord.addRpcConfirmPrompt({
    canonicalKey: 'rpc-confirm::st-min::keep',
    requestId: 'keep',
    kind: 'rpc_confirm',
    confirmKind: 'reload_mcp',
    scope: { kind: 'session', storedSessionId: 'st-min', liveSessionId: 'lv-min' },
    waitingReason: 'confirm',
    rpcId: null,
    socketGeneration: null,
    origin: 'rpc_confirm',
    protocol: 'classic',
    title: 'T',
    message: 'M',
  });
  coord.bindSessionHandle('st-min', 'lv-min'); // skips app/group/other session
  coord.reconcileFromResume({
    storedSessionId: 'st-min',
    liveSessionId: null,
    fence: 999999,
    resume: {
      info: {},
      prompts: [
        { prompt_id: 'c-min', kind: 'clarify', question: 'Min?' },
        { prompt_id: 'a-min', kind: 'approval', command: 'echo ok' },
      ],
      pending_approval: { command: 'rm -i' },
      open_requests: [{ id: 'op-min', method: 'secret', params: {} }],
    },
  });
  assert.ok(coord.getPrompt('rpc-confirm::st-min::keep'));
  assert.ok(coord.getPrompt('session:st-min::approval::singleton:pending'));

  // 3. Connection seq 非有限数、submitting 保留、settledSeq 阻断与全新 applyConnectionUpdate
  coord.applyConnectionRespondResult('op-never', true);
  const cuNew = (coord.applyConnectionUpdate({
    op_id: 'op-direct-upd',
    seq: 'bad',
    deadline_at: 0,
    settled: false,
    targets: 'not-arr',
    owner: { type: 'session', session_id: 'lv-cu' },
  }, 2000), coord.getPrompt('connection::op-direct-upd'));
  assert.equal(cuNew?.seq, 0);
  assert.equal(cuNew?.deadlineAtMs, 2000);
  assert.equal(coord.beginSubmit('connection::op-direct-upd'), true);
  coord.applyConnectionRequest('lv-cu', {
    op_id: 'op-direct-upd',
    seq: 'bad',
    deadline_at: 0,
    timeout_seconds: 10,
    targets: [],
  }, 3000, 'prof-cu', 'st-cu');
  coord.applyConnectionRespondResult('op-direct-upd', false);
  assert.equal(coord.getPrompt('connection::op-direct-upd')?.status, 'open');
  coord.applyConnectionUpdate({
    op_id: 'op-direct-upd',
    seq: 2,
    deadline_at: 0,
    settled: false,
    targets: [],
    owner: { type: 'account' },
  }, 4000, 'prof-cu');
  assert.equal(coord.getPrompt('connection::op-direct-upd')?.status, 'open');
  coord.applyConnectionUpdate({ op_id: 'op-direct-upd', seq: 5, deadline_at: 0, settled: true, targets: [], owner: { type: 'account' } });
  assert.equal(coord.applyConnectionRequest('lv-cu', { op_id: 'op-direct-upd', seq: 5, deadline_at: 0, timeout_seconds: 10, targets: [] }), null);
  // 提交中的 connection 在 applyConnectionUpdate 时保持 submitting
  coord.applyConnectionRequest(undefined, { op_id: 'op-sub-u', seq: 1, deadline_at: 0, timeout_seconds: 10, targets: [] }, 100);
  assert.equal(coord.beginSubmit('connection::op-sub-u'), true);
  coord.applyConnectionUpdate({ op_id: 'op-sub-u', seq: 2, deadline_at: 0, settled: false, targets: [], owner: { type: 'account' } }, 200);
  assert.equal(coord.getPrompt('connection::op-sub-u')?.status, 'submitting');
  coord.applyConnectionUpdate({ op_id: 'op-sub-u', seq: 3, deadline_at: 0, settled: true, targets: [], owner: { type: 'account' } });

  // 4. cancelApprovalsForSession 剩余边界 (session_id only / request_ids+boundServerId / mismatch / reqSet<count)
  coord.upsertServerRequest({
    rpcId: 'srv-ap-bound',
    socketGeneration: 1,
    method: 'approval',
    params: { session_id: 'lv-can', request_id: 'req-can-1' },
    storedSessionId: 'st-can',
  });
  coord.upsertServerRequest({
    rpcId: 'srv-ap-singleton',
    socketGeneration: 1,
    method: 'approval',
    params: { session_id: 'lv-can' },
    storedSessionId: 'st-can',
  });
  coord.upsertServerRequest({
    rpcId: 'srv-cl-skip',
    socketGeneration: 1,
    method: 'clarify',
    params: { session_id: 'lv-can', question: 'stay?' },
    storedSessionId: 'st-can',
  });
  assert.equal(
    coord.cancelApprovalsForSession({
      session_id: 'lv-can',
      request_ids: ['srv-ap-bound'],
      cancelled_count: 2,
    }),
    2,
  );
  // pending_approval 无 serverRequestIds 绑定且不匹配 reqSet (L1000 : false 分支)
  coord.reconcileFromResume({
    storedSessionId: 'st-can-unbound',
    liveSessionId: 'lv-can-unbound',
    fence: 0,
    resume: { pending_approval: { command: 'date' } },
  });
  assert.equal(
    coord.cancelApprovalsForSession({
      stored_session_id: 'st-can-unbound',
      request_ids: ['unrelated-id'],
      cancelled_count: 1,
    }),
    0,
  );
  assert.equal(coord.cancelApprovalsForSession({ stored_session_id: 'none-match' }), 0);

  // applyConnectionUpdate owner.type==='session' 且显式带 profile (L710 true)
  coord.applyConnectionUpdate(
    {
      op_id: 'op-sess-prof',
      seq: 1,
      deadline_at: 5000,
      settled: false,
      targets: [],
      owner: { type: 'session', session_id: 'lv-s1' },
    },
    600,
    'prof-sp',
    'st-s1',
  );
  assert.equal(coord.getPrompt('connection::op-sess-prof')?.scope.kind, 'session');
  // applyConnectionRequest 带 frameSessionId 且省略 profile (L710 false)
  const reqNoProf = coord.applyConnectionRequest(
    'lv-req-noprof',
    { op_id: 'op-req-noprof', seq: 1, deadline_at: 0, timeout_seconds: 10, targets: [] },
    610,
  );
  assert.equal(reqNoProf?.scope.kind, 'session');
  coord.confirmSettled('connection::op-req-noprof');

  // clearForSession (mismatch & omitted liveSessionId) + getActivePromptsForFocus + getBackgroundWaitingPrompts + getWaitingEntityMaps
  coord.clearForSession('st-can');
  coord.upsertServerRequest({
    rpcId: 'bare-null',
    socketGeneration: 1,
    method: 'clarify',
    params: { question: 'no sid' },
    storedSessionId: null,
  });
  coord.upsertServerRequest({
    rpcId: 'bg-s1-a',
    socketGeneration: 1,
    method: 'clarify',
    params: { session_id: 'lv-s1', question: 'A?' },
    storedSessionId: 'st-s1',
    nowMs: 500,
  });
  coord.upsertServerRequest({
    rpcId: 'bg-s1-b',
    socketGeneration: 1,
    method: 'secret',
    params: { session_id: 'lv-s1' },
    storedSessionId: 'st-s1',
    nowMs: 400,
  });
  coord.upsertServerRequest({
    rpcId: 'bg-lv2',
    socketGeneration: 1,
    method: 'approval',
    params: { session_id: 'lv-s2', request_id: 'r-s2' },
    storedSessionId: null,
    nowMs: 300,
  });

  // clearForSession 带 mismatched session 确保跳过非匹配项
  coord.clearForSession('non-existent');
  assert.equal(coord.getWaitingReasonForSession('st-s1'), 'connection');
  assert.equal(coord.hasPendingPromptForSession('', 'lv-s2'), true); // L1121 storedSessionId falsy
  assert.equal(coord.getWaitingReasonForSession('', 'lv-s2'), 'approval'); // L1134 storedSessionId falsy
  assert.equal(coord.getActivePromptsForFocus({ type: 'session', sessionId: 'st-s1' }, 'st-s1', 'lv-s1').length, 4); // app-1 + op-sess-prof + 2*st-s1
  assert.equal(coord.getActivePromptsForFocus({ type: 'session', sessionId: '' }, '', '').length, 1); // only app-1

  // account scope connection 在 getBackgroundWaitingPrompts 中连同 app 一并跳过 (L1065 + L1088 空焦点参数)
  coord.applyConnectionRequest(
    undefined,
    { op_id: 'op-acct-bg', seq: 1, deadline_at: 0, timeout_seconds: 60, targets: [] },
    100,
    'prof-acct',
  );
  const bgAllSess = coord.getBackgroundWaitingPrompts({ type: 'session', sessionId: '' }, '', '');
  assert.equal(bgAllSess.some((x) => x.entityId === 'st-s1'), true);
  assert.equal(bgAllSess.some((x) => x.entityId === 'op-acct-bg'), false);

  // 移除 app + account 提示后验证 getWaitingReasonForFocus 空焦点返回 null
  coord.confirmSettled(appSudo.canonicalKey);
  coord.confirmSettled('connection::op-acct-bg');
  assert.equal(coord.getWaitingReasonForFocus({ type: 'session', sessionId: 'empty' }, 'empty', ''), null);

  // getBackgroundWaitingPrompts focus=session 跳过当前会话、跳过 empty sid、保留非 bot 普通会话累加
  const bgNoBotMap = coord.getBackgroundWaitingPrompts({ type: 'session', sessionId: 'st-min' }, 'st-min', 'lv-min');
  const s1Summary = bgNoBotMap.find((x) => x.entityType === 'session' && x.entityId === 'st-s1');
  assert.equal(s1Summary?.promptCount, 3);
  assert.equal(s1Summary?.oldestCreatedAtMs, 400);

  // getWaitingEntityMaps 命中重复 session / liveOnly session / empty sid / group
  const maps = coord.getWaitingEntityMaps();
  assert.equal(maps.sessionWaitingReasons.get('st-s1'), 'connection');
  assert.equal(maps.sessionWaitingReasons.get('lv-s2'), 'approval');
  assert.equal(maps.groupWaitingReasons.get('rm-classic'), 'approval');
});

test('bindSessionHandle 无碰撞直迁、碰撞 submitting/rpcId 合并与 applyConnectionUpdate storedSessionId 分支', () => {
  const coord = new InteractiveRequestCoordinator();

  // 1. !targetExisting 直迁分支 (L412-413)
  coord.upsertServerRequest({
    rpcId: 'r-direct',
    socketGeneration: 1,
    method: 'clarify',
    params: { session_id: 'lv-direct', question: 'Q?' },
    storedSessionId: null,
  });
  coord.bindSessionHandle('st-direct', 'lv-direct');
  assert.equal(coord.getPrompt('session:st-direct::clarify::r-direct')?.scope.storedSessionId, 'st-direct');

  // 2. targetExisting.status === 'submitting' 保留 (L420 true)
  const storedSub = coord.upsertServerRequest({
    rpcId: 'r-sub-col',
    socketGeneration: 2,
    method: 'approval',
    params: { request_id: 'req-sub-col', session_id: 'lv-sub-col', command: 'ls' },
    storedSessionId: 'st-sub-col',
  });
  assert.equal(coord.beginSubmit(storedSub.canonicalKey), true);
  coord.upsertServerRequest({
    rpcId: 'r-sub-col-2',
    socketGeneration: 3,
    method: 'approval',
    params: { request_id: 'req-sub-col', session_id: 'lv-sub-col', command: 'ls' },
    storedSessionId: null,
  });
  coord.bindSessionHandle('st-sub-col', 'lv-sub-col');
  assert.equal(coord.getPrompt('session:st-sub-col::approval::req-sub-col')?.status, 'submitting');

  // 3. rebound.status === 'submitting' 与 rebound.rpcId === null (L420, L422)
  coord.upsertServerRequest({
    rpcId: 'r-mix-1',
    socketGeneration: 4,
    method: 'approval',
    params: { request_id: 'req-mix', session_id: 'lv-mix', command: 'pwd' },
    storedSessionId: 'st-mix',
  });
  const liveMix = coord.upsertServerRequest({
    rpcId: 'r-mix-2',
    socketGeneration: 5,
    method: 'approval',
    params: { request_id: 'req-mix', session_id: 'lv-mix', command: 'pwd' },
    storedSessionId: null,
  });
  assert.equal(coord.beginSubmit(liveMix.canonicalKey), true);
  coord.onSocketClosed(5); // leaves rebound.rpcId === null while keeping targetExisting's rpcId/gen
  coord.bindSessionHandle('st-mix', 'lv-mix');
  const mergedMix = coord.getPrompt('session:st-mix::approval::req-mix');
  assert.equal(mergedMix?.status, 'submitting');
  assert.equal(mergedMix?.socketGeneration, 4);

  // 3b. both targetExisting and rebound have status === 'open' (L420 : 'open' branch)
  coord.upsertServerRequest({
    rpcId: 'r-open-1',
    socketGeneration: 6,
    method: 'approval',
    params: { request_id: 'req-open-col', session_id: 'lv-open-col', command: 'echo 1' },
    storedSessionId: 'st-open-col',
  });
  coord.upsertServerRequest({
    rpcId: 'r-open-2',
    socketGeneration: 6,
    method: 'approval',
    params: { request_id: 'req-open-col', session_id: 'lv-open-col', command: 'echo 1' },
    storedSessionId: null,
  });
  coord.bindSessionHandle('st-open-col', 'lv-open-col');
  assert.equal(coord.getPrompt('session:st-open-col::approval::req-open-col')?.status, 'open');

  // 4. applyConnectionUpdate storedSessionId 全分支 (L772)
  coord.applyConnectionRequest('lv-c1', { op_id: 'op-c1', seq: 1, deadline_at: 100, timeout_seconds: 60, targets: [] }, 10, undefined, null);
  coord.applyConnectionUpdate({ op_id: 'op-c1', seq: 2, owner: { type: 'session', session_id: 'lv-c1' }, targets: [] }, 11);
  assert.equal(coord.getPrompt('connection::op-c1')?.scope.storedSessionId, null);
  coord.applyConnectionUpdate({ op_id: 'op-c1', seq: 3, owner: { type: 'session', session_id: 'lv-c1' }, targets: [] }, 12, undefined, 'st-c1');
  assert.equal(coord.getPrompt('connection::op-c1')?.scope.storedSessionId, 'st-c1');
  coord.applyConnectionUpdate({ op_id: 'op-c1', seq: 4, owner: { type: 'session', session_id: 'lv-c1' }, targets: [] }, 13, undefined, 'st-c1-other');
  assert.equal(coord.getPrompt('connection::op-c1')?.scope.storedSessionId, 'st-c1');

  // existing 为 account scope（scope.kind !== 'session'）而 update 为 session owner -> 回落 storedSessionId ?? null
  coord.applyConnectionRequest('lv-acct', { op_id: 'op-acct', seq: 1, owner: { type: 'account' }, deadline_at: 100, timeout_seconds: 60, targets: [] }, 10);
  coord.applyConnectionUpdate({ op_id: 'op-acct', seq: 2, owner: { type: 'session', session_id: 'lv-acct2' }, targets: [] }, 11, undefined, 'st-acct2');
  assert.equal(coord.getPrompt('connection::op-acct')?.scope.storedSessionId, 'st-acct2');
});

test('InteractiveRequestCoordinator: open_requests/approval_pending 升级 live_ws 抬升 arrivalSeq 且 clearForSession 返回被删键列表', () => {
  const coord = new InteractiveRequestCoordinator();

  // Case 1: pre-fence open_requests (rpcId: null) upgraded by post-fence live_ws (non-null rpcId) survives slow reconcileFromResume
  const preFence = coord.upsertServerRequest({
    rpcId: null,
    socketGeneration: -1,
    method: 'clarify',
    params: { session_id: 'lv-upg', request_id: 'req-upg', question: 'Keep?' },
    storedSessionId: 'st-upg',
    origin: 'open_requests',
  });
  assert.ok(preFence);
  assert.equal(preFence.rpcId, null);

  const fence = coord.captureSyncFence();

  const upgraded = coord.upsertServerRequest({
    rpcId: 'live-upg-rpc',
    socketGeneration: 2,
    method: 'clarify',
    params: { session_id: 'lv-upg', request_id: 'req-upg', question: 'Keep?' },
    storedSessionId: 'st-upg',
    origin: 'live_ws',
  });
  assert.ok(upgraded);
  assert.equal(upgraded.rpcId, 'live-upg-rpc');
  assert.equal(upgraded.arrivalSeq > fence, true);

  coord.reconcileFromResume({
    storedSessionId: 'st-upg',
    liveSessionId: 'lv-upg',
    resume: { running: true, open_requests: [] },
    fence,
  });
  const survived = coord.getPrompt(upgraded.canonicalKey);
  assert.ok(survived);
  assert.equal(survived.rpcId, 'live-upg-rpc');
  assert.equal(survived.arrivalSeq > fence, true);

  // Case 2: non-live re-upsert (rpcId: null -> rpcId: null) keeps original arrivalSeq
  coord.reconcileApprovalPending(
    'st-upg',
    'lv-upg',
    undefined,
    [{ request_id: 'pend-1', command: 'echo 1' }],
    fence,
  );
  const pendKey = 'session:st-upg::approval::pend-1';
  const seqBefore = coord.getPrompt(pendKey)?.arrivalSeq;
  assert.equal(typeof seqBefore, 'number');
  coord.reconcileApprovalPending(
    'st-upg',
    'lv-upg',
    undefined,
    [{ request_id: 'pend-1', command: 'echo 1' }],
    fence,
  );
  assert.equal(coord.getPrompt(pendKey)?.arrivalSeq, seqBefore);

  // Case 3: clearForSession returns exact removed canonical keys (and [] when empty)
  const removed = coord.clearForSession('st-upg', 'lv-upg');
  assert.deepEqual(removed.sort(), [pendKey, upgraded.canonicalKey].sort());
  assert.deepEqual(coord.clearForSession('st-upg', 'lv-upg'), []);
});
