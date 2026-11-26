import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SessionStatusStore,
  buildGroupScopeKey,
  buildSessionScopeKey,
  extractCompressionThreshold,
  normalizeSessionApprovalMode,
  reduceRightPodMode,
  resolveEffectiveCompressionRatio,
} from '../../dist/session/sessionStatusStore.js';

test('reduceRightPodMode - 四态互斥与全转移表', () => {
  // 1. toggle-status-bar
  assert.deepEqual(reduceRightPodMode({ kind: 'closed' }, { type: 'toggle-status-bar' }), { kind: 'status' });
  assert.deepEqual(
    reduceRightPodMode({ kind: 'files', returnTo: 'status' }, { type: 'toggle-status-bar' }),
    { kind: 'status' }
  );
  assert.deepEqual(reduceRightPodMode({ kind: 'status' }, { type: 'toggle-status-bar' }), { kind: 'closed' });
  assert.deepEqual(
    reduceRightPodMode({ kind: 'subagent', subagentId: 's1', returnTo: 'status' }, { type: 'toggle-status-bar' }),
    { kind: 'closed' }
  );

  // 2. toggle-files
  assert.deepEqual(reduceRightPodMode({ kind: 'closed' }, { type: 'toggle-files' }), {
    kind: 'files',
    returnTo: 'closed',
  });
  assert.deepEqual(reduceRightPodMode({ kind: 'status' }, { type: 'toggle-files' }), {
    kind: 'files',
    returnTo: 'closed',
  });
  assert.deepEqual(reduceRightPodMode({ kind: 'files', returnTo: 'status' }, { type: 'toggle-files' }), {
    kind: 'closed',
  });

  // 3. open-files & back-from-files
  const fromStatusFiles = reduceRightPodMode({ kind: 'status' }, { type: 'open-files' });
  assert.deepEqual(fromStatusFiles, { kind: 'files', returnTo: 'status' });
  assert.deepEqual(reduceRightPodMode(fromStatusFiles, { type: 'back-from-files' }), { kind: 'status' });
  assert.deepEqual(reduceRightPodMode({ kind: 'files', returnTo: 'closed' }, { type: 'back-from-files' }), {
    kind: 'closed',
  });

  // 4. open-subagent / back-from-subagent / resolve-subagent-id / close / session-switched
  const subFromStatus = reduceRightPodMode({ kind: 'status' }, { type: 'open-subagent', subagentId: 'deleg:d1:0' });
  assert.deepEqual(subFromStatus, { kind: 'subagent', subagentId: 'deleg:d1:0', returnTo: 'status' });
  const subFromClosed = reduceRightPodMode({ kind: 'closed' }, { type: 'open-subagent', subagentId: 'sub-2' });
  assert.deepEqual(subFromClosed, { kind: 'subagent', subagentId: 'sub-2', returnTo: 'closed' });
  assert.deepEqual(reduceRightPodMode(subFromStatus, { type: 'open-subagent', subagentId: 'sub-other' }), {
    kind: 'subagent',
    subagentId: 'sub-other',
    returnTo: 'status',
  });
  assert.deepEqual(
    reduceRightPodMode(subFromStatus, { type: 'resolve-subagent-id', oldId: 'deleg:d1:0', newId: 'sub-real' }),
    { kind: 'subagent', subagentId: 'sub-real', returnTo: 'status' }
  );
  assert.deepEqual(reduceRightPodMode(subFromStatus, { type: 'back-from-subagent' }), { kind: 'status' });
  assert.deepEqual(reduceRightPodMode(subFromClosed, { type: 'back-from-subagent' }), { kind: 'closed' });
  assert.deepEqual(
    reduceRightPodMode(subFromStatus, { type: 'session-switched', conversationMode: 'scratchpad' }),
    { kind: 'status' }
  );
  assert.deepEqual(
    reduceRightPodMode(subFromClosed, { type: 'session-switched', conversationMode: 'group_room' }),
    { kind: 'closed' }
  );
  assert.deepEqual(reduceRightPodMode(subFromStatus, { type: 'close' }), { kind: 'closed' });
});

test('extractCompressionThreshold & resolveEffectiveCompressionRatio - 严禁默认伪造', () => {
  // 真实网关结构（含 .config 包装）
  const parsed = extractCompressionThreshold({
    config: { compression: { enabled: true, threshold: 0.5, threshold_tokens: 500000 } },
  });
  assert.deepEqual(parsed, { ratio: 0.5, thresholdTokens: 500000 });
  assert.equal(resolveEffectiveCompressionRatio(parsed, 1000000), 0.5);
  assert.equal(resolveEffectiveCompressionRatio(parsed, 600000), 0.5);

  // 百分数 (1, 100] 换算
  const pct = extractCompressionThreshold({ compression: { threshold: 80 } });
  assert.deepEqual(pct, { ratio: 0.8, thresholdTokens: null });

  // 显式关闭或缺失返回 null（绝不编造 0.85 等默认值）
  assert.equal(extractCompressionThreshold({ compression: { enabled: false, threshold: 0.8 } }), null);
  assert.equal(extractCompressionThreshold({}), null);
  assert.equal(extractCompressionThreshold(null), null);
  assert.equal(extractCompressionThreshold({ compression: { threshold: 0 } }), null);
  assert.equal(extractCompressionThreshold({ compression: { threshold: 150 } }), null);
});

test('SessionStatusStore - sessionInfo, usage优先级, breakdown回填, Fail-Safe与群聊成员解析', () => {
  const store = new SessionStatusStore();
  const scopeKey = buildSessionScopeKey('sess-1');

  store.applySessionInfo(scopeKey, {
    cwd: '/repo/hermes-flux',
    branch: 'feat/status',
    model: 'claude-sonnet-4',
    provider: 'anthropic',
    usage: { input: 10, output: 5, compressions: 1, context_max: 200000, context_used: 40000, context_percent: 20 },
  });

  // SessionUsagePayload 严格优先消费 payload.usage
  store.applyUsagePayload(scopeKey, {
    usage: { input: 1200, output: 300, calls: 4, cache_hit_pct: 75, context_max: 1000000, context_used: 250000, context_percent: 25, compressions: 2 },
    input_tokens: 999999,
    config_context_length: 999999,
  });

  let scope = store.getScope(scopeKey);
  assert.equal(scope?.cwd, '/repo/hermes-flux');
  assert.equal(scope?.branch, 'feat/status');
  assert.equal(scope?.usage?.input, 1200, '必须优先读取契约 payload.usage，而非顶层兼容字段');
  assert.equal(scope?.usage?.contextMax, 1000000);
  assert.equal(scope?.usage?.cacheHitPct, 75);
  assert.equal(scope?.usage?.compressions, 2);

  // resume 刚建立时 usage 省略 context_*，必须保留已有/breakdown 窗口读数，不得归零闪退
  store.applyUsagePayload(scopeKey, { usage: { input: 1200, output: 300 } });
  scope = store.getScope(scopeKey);
  assert.equal(scope?.usage?.contextMax, 1000000);
  assert.equal(scope?.usage?.contextUsed, 250000);

  // Fail-Safe：报错不得清空上一次有效读数
  store.applyUsageError(scopeKey, 'temporary rpc glitch');
  scope = store.getScope(scopeKey);
  assert.equal(scope?.usageError, 'temporary rpc glitch');
  assert.equal(scope?.usage?.contextUsed, 250000);

  // 新会话未产生 usage 前，breakdown 回填 context_*
  const s2Key = buildSessionScopeKey('sess-2');
  store.setBreakdownLoading(s2Key);
  assert.equal(store.getScope(s2Key)?.breakdown.status, 'loading');
  store.applyContextBreakdown(s2Key, {
    categories: [{ id: 'system_prompt', label: 'System Prompt', tokens: 3000, color: 'var(--context-usage-1)' }],
    estimated_total: 3500,
    context_used: 3500,
    context_max: 200000,
    context_percent: 2,
    context_estimated: true,
    model: 'gpt-5',
    context_files: [{ path: 'AGENTS.md', tokens: 1200 }],
  });
  const s2 = store.getScope(s2Key);
  assert.equal(s2?.breakdown.status, 'ready');
  assert.equal(s2?.usage?.contextMax, 200000);
  assert.equal(s2?.usage?.contextUsed, 3500);

  // 群聊活跃：room.members 解析与秒级时间戳归一
  store.applyGroupState('room-9', {
    room: {
      room_id: 'room-9',
      name: '架构组',
      members: [{ member_id: 'mem-1', profile: 'arch', handle: 'arch_bot', display_name: '架构老王' }],
    },
    context: { routing: 'round_robin' },
    driver_status: {
      running: true,
      working: true,
      blocked: false,
      member_activity: [
        { member_id: 'mem-1', status: 'tool_calling', round_index: 2, tool: 'read_file', started_at: 1795280000.5 },
      ],
    },
  });
  const g = store.getScope(buildGroupScopeKey('room-9'))?.groupState;
  assert.equal(g?.name, '架构组');
  assert.equal(g?.routing, 'round_robin');
  assert.equal(g?.memberActivity[0]?.displayName, '架构老王');
  assert.equal(g?.memberActivity[0]?.startedAt, 1795280000500);

  store.deleteScope(scopeKey);
  assert.equal(store.getScope(scopeKey), undefined);

  // 压缩后 context_used 更新但省略 context_percent：必须按新用量重算百分比，不得残留旧 60%
  const s3Key = buildSessionScopeKey('sess-compress');
  store.applyUsagePayload(s3Key, {
    input_tokens: 6800,
    output_tokens: 2800,
    context_tokens: 9600,
    context_length: 16000,
  });
  let s3 = store.getScope(s3Key);
  assert.equal(s3?.usage?.input, 6800);
  assert.equal(s3?.usage?.output, 2800);
  assert.equal(s3?.usage?.contextPercent, 60);

  store.applyUsagePayload(s3Key, {
    input: 6800,
    output: 2800,
    context_used: 4800,
    context_max: 16000,
    compressions: 2,
  });
  s3 = store.getScope(s3Key);
  assert.equal(s3?.usage?.contextUsed, 4800);
  assert.equal(s3?.usage?.contextPercent, 30, 'session.compress 刷新用量时必须重算 contextPercent=30');

  // 哑读数 { context_used: 0, context_max: 0 } 不得冲掉已有 30%
  store.applyUsagePayload(s3Key, { context_used: 0, context_max: 0 });
  s3 = store.getScope(s3Key);
  assert.equal(s3?.usage?.contextPercent, 30);
});

test('normalizeSessionApprovalMode 与 applyGroupState pending_actions/counts 全分支覆盖', () => {
  assert.equal(normalizeSessionApprovalMode(null), undefined);
  assert.equal(normalizeSessionApprovalMode({ approval_mode: 'manual' }), 'manual');
  assert.equal(normalizeSessionApprovalMode({ approval_mode: 'smart' }), 'smart');
  assert.equal(normalizeSessionApprovalMode({ approval_mode: 'off' }), 'off');
  assert.equal(normalizeSessionApprovalMode({ yolo: true }), 'off');
  assert.equal(normalizeSessionApprovalMode({ edit_approval_policy: 'ask' }), 'manual');
  assert.equal(normalizeSessionApprovalMode({ approval_mode: 'unknown' }), undefined);

  const store = new SessionStatusStore();
  const sKey = buildSessionScopeKey('s-app');
  store.applySessionInfo(sKey, { approval_mode: 'manual' });
  assert.equal(store.getScope(sKey)?.approvalMode, 'manual');

  store.applyGroupState('room-act', {
    room: { room_id: 'room-act', name: 'ActRoom', members: [] },
    driver_status: {
      running: true,
      working: false,
      blocked: true,
      counts: { queued: 2, ignored: 'non-num' },
      member_activity: [],
      pending_actions: [
        null,
        [],
        { kind: 'approval', member_id: 'm1', task_id: '', request_id: 'r0' },
        {
          kind: 'approval',
          member_id: 'm1',
          task_id: 't1',
          request_id: 'r1',
          execution_generation: 3,
          command: 'ls',
          description: 'list',
          tool_name: 'terminal',
          choices: ['once', 'session', 'always', 'deny', 'invalid'],
          allow_session: true,
          allow_permanent: true,
        },
        {
          member_id: 'm2',
          task_id: 't2',
          request_id: 'r2',
          execution_generation: 'bad',
          allow_session: true,
          allow_permanent: true,
        },
        {
          member_id: 'm2b',
          task_id: 't2b',
          request_id: 'r2b',
          allow_session: false,
          allow_permanent: false,
        },
        { kind: 'prep', member_id: 'm3', task_id: 'prepare:install', error: 'missing dep' },
        { member_id: 'm3b', task_id: 'prepare:bare' },
        { kind: 'failed', member_id: 'm4', task_id: 't4', error: 'boom' },
        { member_id: 'm5', task_id: 't5', reason: 'timeout' },
        { member_id: 'm6', task_id: 't6', message: 'stalled' },
        { member_id: 'm7', task_id: 't7' },
        { member_id: 'm8', task_id: '' },
        { kind: 123, member_id: 99, task_id: null, request_id: 'r-non-str' },
      ],
    },
  });
  const snap = store.getScope(buildGroupScopeKey('room-act'))?.groupState;
  assert.deepEqual(snap?.counts, { queued: 2 });
  assert.equal(snap?.pendingActions.length, 9);
  assert.deepEqual(snap?.pendingActions[1].choices, ['once', 'session', 'always', 'deny']);
  assert.deepEqual(snap?.pendingActions[2].choices, ['once', 'deny']);
  assert.equal(snap?.pendingActions[3].kind, 'prepare');
  assert.equal(snap?.pendingActions[5].errorDetail, 'boom');
  assert.equal(snap?.pendingActions[6].errorDetail, 'timeout');
  assert.equal(snap?.pendingActions[7].errorDetail, 'stalled');
  assert.equal(snap?.pendingActions[8].errorDetail, undefined);
});
