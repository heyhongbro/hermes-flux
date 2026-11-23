import test from 'node:test';
import assert from 'node:assert/strict';
import { RingBuffer } from '../../dist/subagent/ringBuffer.js';
import {
  SubagentStore,
  extractDelegationsFromMessages,
  matchSubagentForToolCall,
  mergeSubagentRecord,
  reconcileSubagentRecords,
} from '../../dist/subagent/subagentStore.js';
import { normalizeEpochMs } from '../../dist/session/eventReducer.js';

test('RingBuffer - 内存定长截断与顺序保护 (Anti-OOM)', async (t) => {
  await t.test('1. 正向路径：定长写入与时间先后顺序导出', () => {
    // Arrange
    const rb = new RingBuffer(3);

    // Act
    rb.push('log-1');
    rb.push('log-2');

    // Assert
    assert.equal(rb.getSize(), 2);
    assert.deepEqual(rb.toArray(), ['log-1', 'log-2']);
  });

  await t.test('2. 极限边界：超出容量时自动挤出最旧数据，保持单调性', () => {
    // Arrange
    const rb = new RingBuffer(3);

    // Act
    rb.push('log-1');
    rb.push('log-2');
    rb.push('log-3');
    rb.push('log-4'); // 挤出 log-1
    rb.push('log-5'); // 挤出 log-2

    // Assert
    assert.equal(rb.getSize(), 3);
    assert.deepEqual(rb.toArray(), ['log-3', 'log-4', 'log-5']);
  });

  await t.test('3. 负向路径：非正数容量必须显式报错拒绝', () => {
    assert.throws(() => new RingBuffer(0), /capacity must be positive/);
    assert.throws(() => new RingBuffer(-5), /capacity must be positive/);
  });

  await t.test('4. 资源清空：clear 重置状态为 0', () => {
    const rb = new RingBuffer(5);
    rb.push('a');
    rb.push('b');
    rb.clear();
    assert.equal(rb.getSize(), 0);
    assert.deepEqual(rb.toArray(), []);
  });
});

test('SubagentStore - 子代理生命周期与穿透日志流状态机', async (t) => {
  await t.test('1. 任务创建、更新与会话维度检索', () => {
    // Arrange
    const store = new SubagentStore(100);
    let notifyCount = 0;
    const unsub = store.subscribe(() => {
      notifyCount++;
    });

    // Act
    store.upsertTask({
      subagentId: 'sub-1',
      parentSessionId: 'sess-A',
      targetProfile: 'arch-wang',
      taskTitle: '审查死锁',
      status: 'running',
      progressPercent: 20,
    });

    store.upsertTask({
      subagentId: 'sub-2',
      parentSessionId: 'sess-B',
      targetProfile: 'fe-zhang',
      taskTitle: '优化渲染',
      status: 'thinking',
    });

    // Assert
    assert.equal(notifyCount, 2);
    const sessATasks = store.getTasksBySession('sess-A');
    assert.equal(sessATasks.length, 1);
    assert.equal(sessATasks[0].subagentId, 'sub-1');
    assert.equal(sessATasks[0].targetProfile, 'arch-wang');

    const sessBTasks = store.getTasksBySession('sess-B');
    assert.equal(sessBTasks.length, 1);
    assert.equal(sessBTasks[0].subagentId, 'sub-2');

    unsub();
  });

  await t.test('2. 穿透日志流订阅与 RingBuffer 定长广播', () => {
    // Arrange
    const store = new SubagentStore(5);
    const receivedEntries = [];
    const unsubTail = store.subscribeTail('sub-stream-1', (entry) => {
      receivedEntries.push(entry);
    });

    // Act
    store.appendLog('sub-stream-1', { seq: 1, timestamp: 100, kind: 'stdout', text: 'line 1' });
    store.appendLog('sub-stream-1', { seq: 2, timestamp: 200, kind: 'thought', text: 'thinking...' });
    store.appendLog('sub-other', { seq: 3, timestamp: 300, kind: 'stdout', text: 'other line' });

    // Assert: 只有目标 subagentId 的监听器收到广播
    assert.equal(receivedEntries.length, 2);
    assert.equal(receivedEntries[0].text, 'line 1');
    assert.equal(receivedEntries[1].text, 'thinking...');

    // 缓存校验
    const logs = store.getLogs('sub-stream-1');
    assert.equal(logs.length, 2);

    unsubTail();
    store.appendLog('sub-stream-1', { seq: 4, timestamp: 400, kind: 'stdout', text: 'line after unsub' });
    assert.equal(receivedEntries.length, 2, '注销后不再接收推送');
  });

  await t.test('3. spawnSubagent：网关无此 RPC，必须显式抛出 UnsupportedCapabilityError', async () => {
    // Arrange
    const store = new SubagentStore(100);
    let rpcCalled = false;
    const mockBridge = {
      async request() {
        rpcCalled = true;
        return {};
      },
    };

    // Act & Assert：网关契约里没有 subagent.spawn（只有 list/steer/interrupt/tail），
    // 严禁向不存在的方法发请求后把 -32601 包装成业务失败。
    await assert.rejects(
      () =>
        store.spawnSubagent(
          {
            parent_session_id: 'sess-100',
            target_profile: 'arch-wang',
            task_title: '推演并发竞态',
            instruction: '查锁',
          },
          mockBridge
        ),
      (err) => {
        assert.equal(err.code, 'UNSUPPORTED_CAPABILITY');
        assert.equal(err.method, 'subagent.spawn');
        assert.match(err.message, /delegate_task/);
        return true;
      }
    );
    assert.equal(rpcCalled, false, '禁止向不存在的方法发起 RPC');
  });

  await t.test('4. steerSubagent：实时干预指令结构化返回值（queued/rejected/error）与日志记录', async () => {
    const store = new SubagentStore(100);
    store.upsertTask({
      subagentId: 'sub-live-1',
      parentSessionId: 'sess-1',
      targetProfile: 'arch-wang',
      status: 'running',
    });

    let steeredInstruction = '';
    const okBridge = {
      async request(method, params) {
        assert.equal(method, 'subagent.steer');
        assert.equal(params.instruction, undefined, 'instruction 不是契约字段');
        assert.equal(params.profile, 'alt-prof');
        steeredInstruction = params.text;
        return { accepted: true, status: 'queued', text: params.text };
      },
    };

    const outcome = await store.steerSubagent('sub-live-1', '优先分析读写锁', okBridge, { profile: 'alt-prof' });
    assert.deepEqual(outcome, { ok: true, status: 'queued', text: '优先分析读写锁' });
    assert.equal(steeredInstruction, '优先分析读写锁');
    assert.ok(store.getLogs('sub-live-1').some((l) => l.text.includes('优先分析读写锁')));

    const rejectedOutcome = await store.steerSubagent(
      'sub-live-1',
      '追加指令',
      { async request() { return { status: 'rejected', text: '已停止接收' }; } }
    );
    assert.deepEqual(rejectedOutcome, { ok: true, status: 'rejected', text: '已停止接收' });

    const errOutcome = await store.steerSubagent(
      'sub-live-1',
      '网络异常指令',
      { async request() { throw new Error('boom-steer'); } }
    );
    assert.deepEqual(errOutcome, { ok: false, error: 'boom-steer' });
    assert.ok(store.getLogs('sub-live-1').some((l) => l.kind === 'stderr' && l.text.includes('boom-steer')));
  });

  await t.test('5. interruptSubagent：found:true 终态收敛、found:false 回滚对账、RPC 失败回滚', async () => {
    const store = new SubagentStore(100);
    store.upsertTask({
      subagentId: 'sub-kill-1',
      parentSessionId: 'sess-1',
      targetProfile: 'arch-wang',
      status: 'running',
    });

    let resolveInterrupt;
    let interruptedId = '';
    const pendingBridge = {
      request(method, params) {
        assert.equal(method, 'subagent.interrupt');
        interruptedId = params.subagent_id;
        assert.equal(params.profile, 'bot-a');
        return new Promise((r) => {
          resolveInterrupt = r;
        });
      },
    };

    const p = store.interruptSubagent('sub-kill-1', pendingBridge, { profile: 'bot-a' });
    // RPC 未返回前：只能置 interruptPending=true，绝不伪造 completedAt 或终态
    const inflight = store.getTask('sub-kill-1');
    assert.equal(inflight?.interruptPending, true);
    assert.equal(inflight?.lifecycleStatus, 'running');
    assert.equal(inflight?.completedAt, undefined);

    resolveInterrupt({ found: true, subagent_id: 'sub-kill-1' });
    const okOutcome = await p;
    assert.deepEqual(okOutcome, { ok: true });
    assert.equal(interruptedId, 'sub-kill-1');
    const doneTask = store.getTask('sub-kill-1');
    assert.equal(doneTask?.status, 'interrupted');
    assert.equal(doneTask?.lifecycleStatus, 'interrupted');
    assert.equal(doneTask?.interruptPending, false);
    assert.ok(doneTask?.completedAt);

    // found: false 分支：清除 pending、保 running、触发 subagent.list 对账
    store.upsertTask({
      subagentId: 'sub-missing-1',
      parentSessionId: 'sess-1',
      status: 'running',
    });
    const calledMethods = [];
    const notFoundOutcome = await store.interruptSubagent('sub-missing-1', {
      async request(method) {
        calledMethods.push(method);
        if (method === 'subagent.interrupt') return { found: false };
        if (method === 'subagent.list') return { subagents: [], delegations: [] };
        return {};
      },
    });
    assert.deepEqual(notFoundOutcome, { ok: false, reason: 'not_found' });
    assert.equal(store.getTask('sub-missing-1')?.interruptPending, false);
    assert.equal(store.getTask('sub-missing-1')?.lifecycleStatus, 'running');
    assert.ok(calledMethods.includes('subagent.list'));

    // RPC 抛错分支：回滚 interruptPending 并写 stderr
    const errOutcome = await store.interruptSubagent('sub-missing-1', {
      async request() { throw new Error('interrupt timeout'); },
    });
    assert.deepEqual(errOutcome, { ok: false, reason: 'rpc_error', error: 'interrupt timeout' });
    assert.equal(store.getTask('sub-missing-1')?.interruptPending, false);
    assert.ok(store.getLogs('sub-missing-1').some((l) => l.kind === 'stderr' && l.text.includes('interrupt timeout')));
  });

  await t.test('6. syncSessionSubagents：新旧 SubagentListResult 映射、profile 透传与 delegations 合成键', async () => {
    const store = new SubagentStore(100);
    let capturedParams = null;
    const mockBridge = {
      async request(method, params) {
        assert.equal(method, 'subagent.list');
        capturedParams = params;
        return {
          subagents: [
            {
              subagent_id: 'sub-remote-1',
              parent_session_id: 'sess-sync',
              profile: 'arch-wang',
              title: '远程历史任务',
              status: 'completed',
              progress: 100,
              started_at: 1795280000,
              updated_at: 1795280015,
            },
          ],
          delegations: [
            {
              delegation_id: 'deleg-fail-1',
              task_index: 2,
              goal: '失败委派项',
              status: 'failed',
              error: 'Quota exceeded',
              dispatched_at: 1795280001,
              completed_at: 1795280005,
            },
          ],
        };
      },
    };

    await store.syncSessionSubagents('sess-sync', mockBridge, { profile: 'research-bot' });
    assert.equal(capturedParams.profile, 'research-bot');

    const tasks = store.getTasksBySession('sess-sync');
    assert.equal(tasks.length, 2);
    const remote = tasks.find((x) => x.subagentId === 'sub-remote-1');
    const failed = tasks.find((x) => x.subagentId === 'deleg:deleg-fail-1:2');
    assert.equal(remote?.lifecycleStatus, 'completed');
    assert.equal(remote?.startedAt, 1795280000000, '秒级时间戳必须归一化为毫秒');
    assert.equal(failed?.lifecycleStatus, 'failed');
    assert.equal(failed?.error, 'Quota exceeded');
  });

  await t.test('7. 状态单调格与三源合并优先级（终态不可逆、Math.max、去重并集）', () => {
    const t0 = normalizeEpochMs(1795280100);
    assert.equal(t0, 1795280100000);
    assert.equal(normalizeEpochMs(-5), undefined);
    assert.equal(normalizeEpochMs('not-a-date'), undefined);

    const terminalRec = {
      subagentId: 's-mono',
      parentSessionId: 'p1',
      goal: '分析模块',
      lifecycleStatus: 'completed',
      phaseHint: 'idle',
      source: 'subagent_list',
      toolCount: 4,
      filesRead: ['a.ts'],
      filesWritten: [],
      startedAt: 1795280000000,
      updatedAt: 1795280020000,
      completedAt: 1795280020000,
      targetProfile: 'default',
      taskTitle: '分析模块',
      status: 'completed',
      progressPercent: 100,
      currentActionText: 'done',
    };
    const lateRunning = {
      ...terminalRec,
      lifecycleStatus: 'running',
      phaseHint: 'tool',
      source: 'live_event',
      toolCount: 2,
      filesRead: ['b.ts'],
      status: 'running',
      progressPercent: 60,
      updatedAt: 1795280099000,
      completedAt: undefined,
    };

    const merged = mergeSubagentRecord(terminalRec, lateRunning);
    assert.equal(merged.lifecycleStatus, 'completed', '终态吸收律：晚到 running 帧不得复活终态');
    assert.equal(merged.toolCount, 4, '计数器取 Math.max');
    assert.deepEqual(merged.filesRead, ['a.ts', 'b.ts'], 'filesRead 取去重并集');
  });

  await t.test('8. 1:1 无歧义别名迁徙（含缓冲与回调）与多任务缺 task_index 歧义拒绝', () => {
    const store = new SubagentStore(100);
    const resolvedCalls = [];
    store.subscribeAliasResolved((oldId, newId, parent) => {
      resolvedCalls.push({ oldId, newId, parent });
    });

    // 合成记录（来自 canonical spawn_requested / L3 扫描）
    store.applyEventUpdate({
      type: 'subagent-update',
      sessionId: 'sess-alias',
      subagentId: 'deleg:d1:0',
      delegationId: 'd1',
      taskIndex: 0,
      goal: '审计权限边界',
      lifecycleStatus: 'queued',
      phaseHint: 'queued',
      timestamp: 10000,
    });
    store.appendLog('deleg:d1:0', { seq: 1, timestamp: 10001, kind: 'stdout', text: 'early log' });

    const realSnap = {
      subagentId: 'sub-real-99',
      parentSessionId: 'sess-alias',
      delegationId: 'd1',
      goal: '审计权限边界',
      lifecycleStatus: 'running',
      phaseHint: 'tool',
      source: 'subagent_list',
      toolCount: 1,
      startedAt: 10002,
      updatedAt: 10005,
      targetProfile: 'default',
      taskTitle: '审计权限边界',
      status: 'running',
      progressPercent: 30,
      currentActionText: 'read_file',
    };

    store.reconcileFromMessages('sess-alias', []); // no-op sanity
    // 走公开 upsertTask 触发 mergeSessionRecords -> reconcileSubagentRecords 1:1 迁徙
    store.upsertTask(realSnap);

    assert.equal(store.resolveSubagentId('deleg:d1:0'), 'sub-real-99');
    assert.equal(store.getLogs('sub-real-99')[0]?.text, 'early log', '日志环形缓冲区随别名迁移保留');
    assert.equal(resolvedCalls.length, 1);
    assert.deepEqual(resolvedCalls[0], { oldId: 'deleg:d1:0', newId: 'sub-real-99', parent: 'sess-alias' });

    // 多任务同 delegation_id 且缺失 task_index 时严禁误合并
    const existingTwo = [
      { ...realSnap, subagentId: 'deleg:d2:0', delegationId: 'd2', taskIndex: 0, goal: '子任务 A' },
      { ...realSnap, subagentId: 'deleg:d2:1', delegationId: 'd2', taskIndex: 1, goal: '子任务 B' },
    ];
    const ambigIncoming = [{ ...realSnap, subagentId: 'sub-real-d2', delegationId: 'd2', taskIndex: undefined, goal: '子任务 A' }];
    const { merged, resolvedAliases } = reconcileSubagentRecords(existingTwo, ambigIncoming);
    assert.equal(resolvedAliases.length, 0, '同 delegation_id 并发多任务缺 task_index 时不得盲并');
    assert.equal(merged.length, 3);
  });

  await t.test('9. loadSubagentTranscript：20页游标排空、reset 清空、增量保真及 -32601 -> REST -> degraded_tail 与自愈升级', async () => {
    const store = new SubagentStore(100);
    store.upsertTask({ subagentId: 'sub-t1', parentSessionId: 'st-p1', status: 'running', childSessionId: 'child-s1' });

    // 9a: 多页游标排空 + 重复游标防死循环
    let pageCalls = 0;
    const pagedRes = await store.loadSubagentTranscript({
      subagentId: 'sub-t1',
      storedSessionId: 'st-p1',
      profile: 'worker-a',
      bridge: {
        async request(method, params) {
          assert.equal(method, 'session.transcript');
          assert.equal(params.profile, 'worker-a');
          pageCalls++;
          if (pageCalls === 1) {
            return {
              rows: [{ row_id: 1, role: 'user', content: 'hi', timestamp: 100 }],
              next_cursor: 'c2',
              running: true,
              available: true,
            };
          }
          if (pageCalls === 2) {
            return {
              rows: [{ row_id: 2, role: 'assistant', content: 'working', timestamp: 101 }],
              next_cursor: 'c2', // 重复游标应立即终止
              running: true,
              available: true,
            };
          }
          throw new Error('should not loop');
        },
      },
    });
    assert.equal(pageCalls, 2);
    assert.equal(pagedRes.status, 'ready');
    assert.equal(pagedRes.rows.length, 2);

    // 9b: available: false 先降级为 degraded_tail（但不锁 transcriptUnsupported），随后自愈升级为 ready
    store.upsertTask({ subagentId: 'sub-heal', parentSessionId: 'st-p1', status: 'running' });
    const unavail = await store.loadSubagentTranscript({
      subagentId: 'sub-heal',
      storedSessionId: 'st-p1',
      bridge: {
        async request() {
          return { rows: [], running: true, available: false };
        },
      },
    });
    assert.equal(unavail.status, 'degraded_tail');
    assert.equal(unavail.transcriptUnsupported, false);

    const healed = await store.loadSubagentTranscript({
      subagentId: 'sub-heal',
      storedSessionId: 'st-p1',
      bridge: {
        async request() {
          return {
            rows: [{ row_id: 10, role: 'assistant', content: '落地了', timestamp: 102 }],
            running: false,
            available: true,
          };
        },
      },
    });
    assert.equal(healed.status, 'ready');
    assert.equal(healed.rows.length, 1);

    // 9c: -32601 -> REST fetchChildMessages 兜底成功；无 REST 数据时再退 subagent.tail + 锁定 transcriptUnsupported
    store.upsertTask({ subagentId: 'sub-32601', parentSessionId: 'st-p1', status: 'running', childSessionId: 'child-rest-1' });
    const viaRest = await store.loadSubagentTranscript({
      subagentId: 'sub-32601',
      storedSessionId: 'st-p1',
      bridge: {
        async request() {
          const e = new Error('Method not found (-32601)');
          e.code = -32601;
          throw e;
        },
      },
      fetchChildMessages: async () => [{ row_id: 50, role: 'assistant', content: 'rest ok' }],
    });
    assert.equal(viaRest.status, 'ready');
    assert.equal(viaRest.transcriptUnsupported, true);
    assert.equal(viaRest.rows[0].content, 'rest ok');

    store.upsertTask({ subagentId: 'sub-tail-only', parentSessionId: 'st-p1', status: 'running' });
    const degraded = await store.loadSubagentTranscript({
      subagentId: 'sub-tail-only',
      storedSessionId: 'st-p1',
      liveSessionId: 'live-p1',
      bridge: {
        async request(method) {
          if (method === 'session.transcript') {
            const e = new Error('Method not found');
            e.code = -32601;
            throw e;
          }
          if (method === 'subagent.tail') {
            return { subagent_id: 'sub-tail-only', available: true, text: 'tail fallback line', truncated: false };
          }
          return {};
        },
      },
    });
    assert.equal(degraded.status, 'degraded_tail');
    assert.equal(degraded.transcriptUnsupported, true);
    assert.ok(store.getLogs('sub-tail-only').some((l) => l.text.includes('tail fallback line')));
  });

  await t.test('10. extractDelegationsFromMessages & matchSubagentForToolCall & Fail-Safe 列表误差保底 + 代际围栏', async () => {
    const extracted = extractDelegationsFromMessages(
      [
        {
          id: 'm1',
          role: 'assistant',
          timestamp: 1795280000,
          toolCalls: [
            {
              id: 'tc-d1',
              name: 'delegate_task',
              status: 'completed',
              durationMs: 2500,
              rawArgs: { goal: '检查 CSS 变量' },
              output: JSON.stringify({
                delegation_id: 'del-msg-1',
                results: [{ subagent_id: 'sub-msg-1', goal: '检查 CSS 变量', status: 'completed', summary: '0 违规' }],
              }),
            },
          ],
        },
      ],
      'sess-l3'
    );
    assert.equal(extracted.length, 1);
    assert.equal(extracted[0].subagentId, 'sub-msg-1');
    assert.equal(matchSubagentForToolCall({ id: 'tc-d1', rawArgs: { goal: '检查 CSS 变量' } }, extracted), 'sub-msg-1');

    // INV-SUBAGENT-01 & INV-SUBAGENT-07: 代际围栏 + Fail-Safe 不致空
    const store = new SubagentStore(100);
    store.upsertTask({ subagentId: 'keep-me', parentSessionId: 'sess-fs', status: 'running', goal: '保底记录' });
    const gen0 = store.getSessionGeneration('sess-fs');

    let finishSlowRpc;
    const slowSync = store.syncSessionSubagents(
      'sess-fs',
      {
        async request() {
          return new Promise((r) => {
            finishSlowRpc = r;
          });
        },
      },
      { expectedGeneration: gen0 }
    );
    // 切换会话推进代际并清旧数据
    store.advanceSessionGeneration('sess-fs');
    finishSlowRpc({
      subagents: [{ subagent_id: 'stale-ghost', status: 'running', goal: '幽灵回写' }],
    });
    await slowSync;
    assert.equal(store.getTask('stale-ghost'), undefined, '过期代际的慢响应不得回写到当前存储');

    // sync 错误 Fail-Safe
    await store.syncSessionSubagents('sess-fs', {
      async request() { throw new Error('network down'); },
    });
    assert.equal(store.getListSyncError('sess-fs'), 'network down');
    assert.equal(store.getTasksBySession('sess-fs').length, 1, 'subagent.list 失败不得清空已有子任务');
  });

  await t.test('11. 异步 delegate_task 派发回执不误标 completed（INV-SUBAGENT-02 防单调锁死回归）', async () => {
    const asyncMsgs = [
      {
        id: 'm-async-1',
        role: 'assistant',
        timestamp: 1795280100,
        toolCalls: [
          {
            id: 'tc-async-1',
            name: 'delegate_task',
            status: 'completed',
            durationMs: 120,
            rawArgs: { goal: '审计异步运行状态' },
            output: JSON.stringify({ status: 'running', subagent_id: 'sub-async-1' }),
          },
          {
            id: 'tc-async-2',
            name: 'delegate_task',
            status: 'completed',
            durationMs: 90,
            rawArgs: {
              tasks: [
                { goal: '多任务异步分片 A' },
                { goal: '多任务异步分片 B' },
              ],
            },
            output: JSON.stringify({ status: 'dispatched', delegation_id: 'del-2' }),
          },
        ],
      },
    ];

    const scanned = extractDelegationsFromMessages(asyncMsgs, 'sess-async');
    assert.equal(scanned.length, 3);
    assert.equal(scanned[0].subagentId, 'sub-async-1');
    assert.equal(scanned[0].lifecycleStatus, 'running');
    assert.equal(scanned[0].completedAt, undefined);
    assert.equal(scanned[1].delegationId, 'del-2');
    assert.equal(scanned[1].lifecycleStatus, 'running');
    assert.equal(scanned[1].completedAt, undefined);
    assert.equal(scanned[2].lifecycleStatus, 'running');

    const store = new SubagentStore(100);
    store.reconcileFromMessages('sess-async', asyncMsgs);
    await store.syncSessionSubagents('sess-async', {
      async request() {
        return {
          subagents: [
            {
              subagent_id: 'sub-async-1',
              delegation_id: 'del-1',
              goal: '审计异步运行状态',
              status: 'running',
            },
          ],
        };
      },
    });
    assert.equal(store.getTask('sub-async-1')?.lifecycleStatus, 'running', 'subagent.list 返回 running 不得被回执 completed 锁死');
    assert.equal(store.getRunningCount(), 3);

    // 真实终态事件到来时正常跃迁为 completed
    await store.syncSessionSubagents('sess-async', {
      async request() {
        return {
          subagents: [
            {
              subagent_id: 'sub-async-1',
              delegation_id: 'del-1',
              goal: '审计异步运行状态',
              status: 'completed',
            },
          ],
        };
      },
    });
    assert.equal(store.getTask('sub-async-1')?.lifecycleStatus, 'completed');
  });

  await t.test('12. loadSubagentTail 幂等去重 + 无 row_id 转录复轮询去重 + interrupt found:false 传父会话作用域', async () => {
    const store = new SubagentStore(100);
    store.upsertTask({ subagentId: 'sub-tail-1', parentSessionId: 'stored-parent-1', status: 'running', goal: 'tail dedup' });

    const tailBridge = {
      async request(method) {
        if (method === 'subagent.tail') {
          return {
            subagent_id: 'sub-tail-1',
            entries: [
              { seq: 1, timestamp: 1000, kind: 'tool_call', text: 'grep -rn foo' },
              { seq: 2, timestamp: 1001, kind: 'stdout', text: 'matched 2' },
            ],
          };
        }
        return {};
      },
    };
    await store.loadSubagentTail('sub-tail-1', tailBridge);
    await store.loadSubagentTail('sub-tail-1', tailBridge);
    assert.equal(store.getLogs('sub-tail-1').length, 2, '相同 seq entries 复轮询严禁重复追加');

    // snapshot res.text 模式：同快照跳过、增量追尾仅追加新增片段
    store.upsertTask({ subagentId: 'sub-snap-1', parentSessionId: 'stored-parent-1', status: 'running', goal: 'text snap' });
    let snapPhase = 0;
    const snapBridge = {
      async request() {
        snapPhase += 1;
        return {
          subagent_id: 'sub-snap-1',
          text: snapPhase < 3 ? 'line1\n' : 'line1\nline2\n',
        };
      },
    };
    await store.loadSubagentTail('sub-snap-1', snapBridge);
    await store.loadSubagentTail('sub-snap-1', snapBridge);
    await store.loadSubagentTail('sub-snap-1', snapBridge);
    assert.deepEqual(
      store.getLogs('sub-snap-1').map((l) => l.text),
      ['line1\n', 'line2'],
    );

    // 无 row_id 转录行（next_cursor=null 后复轮询）严禁重复追加
    store.upsertTask({ subagentId: 'sub-noid-1', parentSessionId: 'stored-parent-1', status: 'running', goal: 'no row_id' });
    const noIdBridge = {
      async request(method) {
        if (method === 'session.transcript') {
          return {
            available: true,
            running: true,
            next_cursor: null,
            rows: [
              { row_kind: 'message', role: 'user', timestamp: 1700000001, content: 'hello child' },
              { row_kind: 'message', role: 'assistant', timestamp: 1700000002, content: 'working on it' },
            ],
          };
        }
        return {};
      },
    };
    await store.loadSubagentTranscript({
      subagentId: 'sub-noid-1',
      storedSessionId: 'stored-parent-1',
      bridge: noIdBridge,
    });
    const ts2 = await store.loadSubagentTranscript({
      subagentId: 'sub-noid-1',
      storedSessionId: 'stored-parent-1',
      bridge: noIdBridge,
    });
    assert.equal(ts2.rows.length, 2, '无 row_id 行复轮询不得因下标偏移重复追加');

    // interrupt found:false 必须把 task.parentSessionId 透传至 storedSessionId
    const calls = [];
    await store.interruptSubagent(
      'sub-tail-1',
      {
        async request(method, params) {
          calls.push({ method, params });
          if (method === 'subagent.interrupt') return { found: false };
          if (method === 'subagent.list') return { subagents: [] };
          return {};
        },
      },
      { sessionId: 'live-parent-1' },
    );
    await new Promise((r) => setTimeout(r, 15));
    const genAfter = store.getSessionGeneration('stored-parent-1');
    assert.equal(genAfter, 0);
    assert.ok(calls.some((c) => c.method === 'subagent.list' && c.params?.session_id === 'live-parent-1'));
    assert.equal(store.getTask('sub-tail-1')?.parentSessionId, 'stored-parent-1');
  });

  await t.test('13. 只读与清空守恒：终态/合成 deleg ID 拦截 steer & interrupt，且 clearAll 清空状态并推进代际', async () => {
    const store = new SubagentStore(100);
    store.upsertTask({ subagentId: 'sub-ended-1', parentSessionId: 'sess-guard', status: 'completed', goal: 'Done' });
    store.upsertTask({ subagentId: 'deleg:syn-1:0', parentSessionId: 'sess-guard', status: 'running', goal: 'Synthetic live' });

    let rpcCount = 0;
    const strictBridge = {
      async request() {
        rpcCount += 1;
        return { ok: true };
      },
    };

    const steerEnded = await store.steerSubagent('sub-ended-1', 'try steer', strictBridge, { sessionId: 'live-guard' });
    const intEnded = await store.interruptSubagent('sub-ended-1', strictBridge, { sessionId: 'live-guard' });
    assert.equal(steerEnded.ok, false);
    assert.deepEqual(intEnded, { ok: false, reason: 'already_ended' });
    assert.equal(store.getLogs('sub-ended-1').length, 0, '终态拒绝 steer 后绝不可污染日志缓冲区');
    assert.equal(Boolean(store.getTask('sub-ended-1')?.interruptPending), false);

    const steerSyn = await store.steerSubagent('deleg:syn-1:0', 'try steer syn', strictBridge, { sessionId: 'live-guard' });
    const intSyn = await store.interruptSubagent('deleg:syn-1:0', strictBridge, { sessionId: 'live-guard' });
    assert.equal(steerSyn.ok, false);
    assert.deepEqual(intSyn, { ok: false, reason: 'synthetic_id' });
    assert.equal(store.getLogs('deleg:syn-1:0').length, 0);
    assert.equal(Boolean(store.getTask('deleg:syn-1:0')?.interruptPending), false);
    assert.equal(rpcCount, 0, '终态与合成 deleg ID 严禁触发任何 subagent.steer / interrupt RPC');

    // clearAll 清空全部缓存并递增 sessionGeneration 以抛弃在途 subagent.list 响应
    assert.equal(store.getRunningCount(), 1);
    let releaseList;
    const inflightSync = store.syncSessionSubagents('sess-guard', {
      async request() {
        return new Promise((r) => {
          releaseList = r;
        });
      },
    });
    store.clearAll();
    assert.equal(store.getRunningCount(), 0);
    assert.equal(store.getTasksBySession('sess-guard').length, 0);
    releaseList({ subagents: [{ subagent_id: 'ghost-after-clear', status: 'running', goal: 'Ghost' }] });
    await inflightSync;
    assert.equal(store.getTask('ghost-after-clear'), undefined, 'clearAll 必须推进代际围栏丢弃断线前在途响应');

    // 从未建档的全新会话（tasks 与 sessionGenerations 均为空）+ 在途 interrupt / tail 在 clearAll 后均不得回写脏态
    let releaseFreshList;
    const freshSync = store.syncSessionSubagents('sess-fresh-zero', {
      async request() {
        return new Promise((r) => {
          releaseFreshList = r;
        });
      },
    });
    store.upsertTask({ subagentId: 'sub-inflight-int', parentSessionId: 'sess-fresh-tail', status: 'running', goal: 'Int' });
    let releaseInt;
    const inflightInt = store.interruptSubagent('sub-inflight-int', {
      async request() {
        return new Promise((r) => {
          releaseInt = r;
        });
      },
    }, { sessionId: 'live-fresh-tail' });
    let releaseTail;
    const inflightTail = store.loadSubagentTail('sub-inflight-int', {
      async request() {
        return new Promise((r) => {
          releaseTail = r;
        });
      },
    }, 50, { sessionId: 'live-fresh-tail' });

    store.clearAll();
    releaseFreshList({ subagents: [{ subagent_id: 'ghost-fresh-0', status: 'running', goal: 'Ghost0' }] });
    releaseInt({ found: true });
    releaseTail({ entries: [{ seq: 99, timestamp: 1700000099, kind: 'stdout', text: 'stale tail after clearAll' }] });
    await Promise.all([freshSync, inflightInt, inflightTail]);

    assert.equal(store.getTasksBySession('sess-fresh-zero').length, 0, '零历史任务会话的在途 sync 必须在 clearAll 后丢弃');
    assert.equal(store.getListSyncError('sess-fresh-zero'), undefined);
    assert.equal(store.getTask('sub-inflight-int'), undefined, '在途 interrupt 绝不可在 clearAll 后插入孤立终态任务');
    assert.deepEqual(store.getLogs('sub-inflight-int'), [], '在途 subagent.tail 绝不可在 clearAll 后污染日志环');
  });
});
