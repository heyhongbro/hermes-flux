/**
 * 状态栏与子 Agent 监控纯状态机形式化不变量证明 (INV-SUBAGENT-01 ~ INV-SUBAGENT-07)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import {
  RingBuffer,
  SessionStatusStore,
  SubagentStore,
  buildSessionScopeKey,
  mergeSubagentRecord,
  reconcileSubagentRecords,
  reduceRightPodMode,
} from '../../dist/index.js';

const TERMINAL_STATUSES = ['completed', 'failed', 'error', 'timeout', 'interrupted'];

function lifecycleRank(s) {
  if (s === 'queued') return 0;
  if (s === 'running') return 1;
  return 2;
}

const sourceArb = fc.constantFrom('live_event', 'subagent_list', 'spawn_tree', 'transcript_scan');
const statusArb = fc.constantFrom('queued', 'running', 'completed', 'failed', 'error', 'timeout', 'interrupted');

const subagentRecordArb = (idArb = fc.stringMatching(/^[a-z0-9_-]{2,10}$/)) =>
  fc.record({
    subagentId: idArb,
    parentSessionId: fc.constant('sess-inv'),
    goal: fc.stringMatching(/^[a-zA-Z0-9_-]{1,16}$/),
    lifecycleStatus: statusArb,
    phaseHint: fc.constantFrom('queued', 'thinking', 'tool', 'progress', 'idle'),
    source: sourceArb,
    toolCount: fc.integer({ min: 0, max: 500 }),
    filesRead: fc.array(fc.stringMatching(/^[a-z0-9/.]{2,12}$/), { maxLength: 6 }),
    filesWritten: fc.array(fc.stringMatching(/^[a-z0-9/.]{2,12}$/), { maxLength: 6 }),
    startedAt: fc.integer({ min: 1_000_000, max: 2_000_000_000 }),
    updatedAt: fc.integer({ min: 1_000_000, max: 2_000_000_000 }),
    interruptPending: fc.boolean(),
    targetProfile: fc.constant('default'),
    taskTitle: fc.constant('task'),
    status: fc.constant('running'),
    progressPercent: fc.integer({ min: 0, max: 100 }),
    currentActionText: fc.constant(''),
  }).map((r) => ({
    ...r,
    status: r.lifecycleStatus,
    ...(TERMINAL_STATUSES.includes(r.lifecycleStatus) ? { completedAt: r.updatedAt } : {}),
  }));

test('Formal Invariant Verifier: Status Bar & Subagent Monitor (INV-SUBAGENT-01 ~ INV-SUBAGENT-07)', async (t) => {
  await t.test('INV-SUBAGENT-01: syncSessionSubagents 代际围栏恒阻断跨会话慢响应回写', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 20 }),
        fc.integer({ min: 1, max: 10 }),
        fc.stringMatching(/^sub-[a-z0-9]{2,8}$/),
        async (initialGen, bumpCount, ghostId) => {
          const store = new SubagentStore(100);
          for (let i = 0; i < initialGen; i++) store.advanceSessionGeneration('sess-A');
          const expectedGen = store.getSessionGeneration('sess-A');

          let release;
          const rpcPromise = new Promise((r) => {
            release = r;
          });
          const syncTask = store.syncSessionSubagents(
            'sess-A',
            { async request() { return rpcPromise; } },
            { expectedGeneration: expectedGen }
          );

          for (let i = 0; i < bumpCount; i++) store.advanceSessionGeneration('sess-A');
          release({
            subagents: [{ subagent_id: ghostId, status: 'running', goal: 'ghost', started_at: 1000 }],
          });
          await syncTask;

          assert.equal(store.getTask(ghostId), undefined);
        }
      ),
      { numRuns: 1000 }
    );
  });

  await t.test('INV-SUBAGENT-02: mergeSubagentRecord 状态单调格、终态吸收与资源集合只增不减', () => {
    fc.assert(
      fc.property(subagentRecordArb(fc.constant('fixed-sub')), subagentRecordArb(fc.constant('fixed-sub')), (a, b) => {
        const merged = mergeSubagentRecord(a, b);
        assert.ok(
          lifecycleRank(merged.lifecycleStatus) >= lifecycleRank(a.lifecycleStatus),
          '合并态秩不得低于 existing'
        );
        assert.ok(
          lifecycleRank(merged.lifecycleStatus) >= lifecycleRank(b.lifecycleStatus),
          '合并态秩不得低于 incoming'
        );
        if (TERMINAL_STATUSES.includes(a.lifecycleStatus)) {
          assert.ok(TERMINAL_STATUSES.includes(merged.lifecycleStatus), 'existing 终态绝不退回');
          assert.equal(merged.interruptPending, false);
        }
        assert.ok(merged.toolCount >= Math.max(a.toolCount, b.toolCount));
        for (const f of a.filesRead ?? []) assert.ok((merged.filesRead ?? []).includes(f));
        for (const f of b.filesRead ?? []) assert.ok((merged.filesRead ?? []).includes(f));
      }),
      { numRuns: 1000 }
    );
  });

  await t.test('INV-SUBAGENT-03: reconcileSubagentRecords 幂等性、键唯一性与并发无歧义守恒', () => {
    fc.assert(
      fc.property(
        fc.array(subagentRecordArb(), { maxLength: 10 }),
        fc.array(subagentRecordArb(), { maxLength: 10 }),
        (existing, incoming) => {
          const r1 = reconcileSubagentRecords(existing, incoming);
          const ids1 = r1.merged.map((m) => m.subagentId);
          assert.equal(new Set(ids1).size, ids1.length, '合并结果严禁出现重复 subagentId');

          // 幂等性：同一批 incoming 再对齐一次，记录数与各生命周期终态不得退化
          const r2 = reconcileSubagentRecords(r1.merged, incoming);
          assert.equal(r2.merged.length, r1.merged.length);
          for (const rec1 of r1.merged) {
            const rec2 = r2.merged.find((x) => x.subagentId === rec1.subagentId);
            assert.ok(rec2);
            assert.ok(lifecycleRank(rec2.lifecycleStatus) >= lifecycleRank(rec1.lifecycleStatus));
          }
        }
      ),
      { numRuns: 1000 }
    );
  });

  await t.test('INV-SUBAGENT-04: applyUsageError Fail-Safe 保持既有上下文数值', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 900_000 }),
        fc.integer({ min: 1_000, max: 1_000_000 }),
        fc.string({ minLength: 1, maxLength: 40 }),
        (used, max, errMsg) => {
          const store = new SessionStatusStore();
          const key = buildSessionScopeKey('sess-u');
          store.applyUsagePayload(key, {
            usage: { input: 50, output: 20, context_used: used, context_max: max, context_percent: 12 },
          });
          store.applyUsageError(key, errMsg);
          const after = store.getScope(key);
          assert.equal(after?.usage?.contextUsed, used);
          assert.equal(after?.usage?.contextMax, max);
          assert.ok(after?.usageError);
        }
      ),
      { numRuns: 1000 }
    );
  });

  await t.test('INV-SUBAGENT-05: reduceRightPodMode 四态合法闭合与切会话必退 subagent 下钻', () => {
    const modeArb = fc.oneof(
      fc.constant({ kind: 'closed' }),
      fc.constant({ kind: 'status' }),
      fc.record({
        kind: fc.constant('subagent'),
        subagentId: fc.stringMatching(/^s-[a-z0-9]{1,6}$/),
        returnTo: fc.constantFrom('status', 'closed'),
      }),
      fc.record({
        kind: fc.constant('files'),
        returnTo: fc.constantFrom('status', 'closed'),
      })
    );
    const actionArb = fc.oneof(
      fc.constant({ type: 'toggle-status-bar' }),
      fc.constant({ type: 'toggle-files' }),
      fc.record({ type: fc.constant('open-files'), fromStatusBar: fc.boolean() }),
      fc.constant({ type: 'back-from-files' }),
      fc.record({ type: fc.constant('open-subagent'), subagentId: fc.stringMatching(/^s-[a-z0-9]{1,6}$/) }),
      fc.constant({ type: 'back-from-subagent' }),
      fc.constant({ type: 'close' }),
      fc.record({
        type: fc.constant('session-switched'),
        conversationMode: fc.constantFrom('scratchpad', 'bot_forever_chat', 'group_room'),
      })
    );

    fc.assert(
      fc.property(modeArb, fc.array(actionArb, { maxLength: 12 }), (init, actions) => {
        let mode = init;
        for (const act of actions) {
          mode = reduceRightPodMode(mode, act);
          assert.ok(['closed', 'status', 'subagent', 'files'].includes(mode.kind));
          if (act.type === 'session-switched') {
            assert.notEqual(mode.kind, 'subagent', '切换会话绝对禁止滞留 subagent 详情页');
          }
        }
      }),
      { numRuns: 1000 }
    );
  });

  await t.test('INV-SUBAGENT-06: RingBuffer 有界守恒且严格保留最新尾部元素', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 30 }),
        fc.array(fc.integer(), { maxLength: 120 }),
        (capacity, items) => {
          const rb = new RingBuffer(capacity);
          for (const item of items) rb.push(item);
          const out = rb.toArray();
          assert.ok(out.length <= capacity);
          assert.deepEqual(out, items.slice(-capacity));
        }
      ),
      { numRuns: 1000 }
    );
  });

  await t.test('INV-SUBAGENT-07: applyListSyncError Fail-Safe 保留已有任务不致空', () => {
    fc.assert(
      fc.property(
        fc.array(subagentRecordArb(), { minLength: 1, maxLength: 8 }),
        fc.string({ minLength: 1, maxLength: 32 }),
        (records, errMsg) => {
          const store = new SubagentStore(100);
          const unique = new Map();
          for (const r of records) unique.set(r.subagentId, r);
          for (const r of unique.values()) {
            store.upsertTask({ ...r, parentSessionId: 'sess-inv7' });
          }
          const beforeCount = store.getTasksBySession('sess-inv7').length;
          store.applyListSyncError('sess-inv7', errMsg);
          const afterCount = store.getTasksBySession('sess-inv7').length;
          assert.equal(afterCount, beforeCount);
          assert.ok(store.getListSyncError('sess-inv7'));
        }
      ),
      { numRuns: 1000 }
    );
  });
});
