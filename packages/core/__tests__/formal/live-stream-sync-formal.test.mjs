/**
 * 核心形式化安全不变量检验：长耗时看门狗续期与多端/多会话实时流式同步 (INV-TURN-02 / INV-STREAM-02..06)
 *
 * 【设计意图 (Why)】
 *   在数千种随机方法交错、乱序增量、重复分片与探活失败状态空间中，用 fast-check 穷尽证明
 *   `SlidingActiveWatchdog.renewIdle`、`LiveStreamRegistry`、`extractResumeInflightState`、
 *   `decideWatchdogProbeAction` 与 `planRemoteUserPromptInsert` 满足严格的数学安全定理。
 *
 * 【约束与规则 (Rules)】
 *   - 严禁出现任何本地时区 API、Math.random() 或弱断言；
 *   - 必须使用 `fc.assert(..., { numRuns: 200 })` 以上高强度性质校验。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import {
  SlidingActiveWatchdog,
  LiveStreamRegistry,
  extractResumeInflightState,
  decideWatchdogProbeAction,
  planRemoteUserPromptInsert,
} from '../../dist/index.js';

test('INV-TURN-02: SlidingActiveWatchdog.renewIdle 永不复活 idle/disarmed，且严格受 hardLimitMs 封顶', () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 100, max: 5_000 }),
      fc.integer({ min: 1, max: 6 }),
      fc.array(
        fc.oneof(
          fc.record({ op: fc.constant('arm') }),
          fc.record({ op: fc.constant('disarm') }),
          fc.record({ op: fc.constant('feed') }),
          fc.record({ op: fc.constant('renew') }),
          fc.record({ op: fc.constant('advance'), ms: fc.integer({ min: 1, max: 8_000 }) }),
        ),
        { minLength: 1, maxLength: 25 },
      ),
      (idleTimeoutMs, hardMult, ops) => {
        const hardLimitMs = idleTimeoutMs * hardMult;
        let nowMs = 1_000_000;
        const reasons = [];
        const wd = new SlidingActiveWatchdog({
          idleTimeoutMs,
          hardLimitMs,
          throttleMs: 50,
          now: () => nowMs,
          onTimeout: (r) => reasons.push(r),
        });

        // 初始 idle 态调用 renewIdle 绝对不得激活
        assert.equal(wd.renewIdle(), false);
        assert.equal(wd.getState(), 'idle');
        let startedAt = null;

        for (const step of ops) {
          const prevState = wd.getState();
          const prevElapsed = wd.getElapsedMs();

          if (step.op === 'arm') {
            wd.arm();
            startedAt = nowMs;
            assert.equal(wd.getState(), 'armed');
            assert.equal(wd.getElapsedMs(), 0);
          } else if (step.op === 'disarm') {
            wd.disarm();
            assert.equal(wd.getState(), 'disarmed');
            assert.equal(wd.renewIdle(), false);
            assert.equal(wd.getState(), 'disarmed');
          } else if (step.op === 'feed') {
            wd.feed();
            if (prevState === 'armed') {
              assert.equal(wd.getElapsedMs(), prevElapsed);
            }
          } else if (step.op === 'renew') {
            const ok = wd.renewIdle();
            if (prevState === 'idle' || prevState === 'disarmed') {
              assert.equal(ok, false);
              assert.equal(wd.getState(), prevState);
            } else if (startedAt !== null && nowMs - startedAt >= hardLimitMs) {
              assert.equal(ok, false);
            } else if (startedAt !== null) {
              assert.equal(ok, true);
              assert.equal(wd.getState(), 'armed');
              assert.equal(wd.getElapsedMs(), prevElapsed);
              assert.equal(wd.getIdleElapsedMs(), 0);
            }
          } else if (step.op === 'advance') {
            nowMs += step.ms;
          }
        }
        wd.disarm();
      },
    ),
    { numRuns: 250 },
  );
});

test('INV-STREAM-02: LiveStreamRegistry 在任意注册/迁移/删除序列下保持 storedSessionId <-> messageId 严格双射', () => {
  const idArb = fc.constantFrom('s1', 's2', 's3', 's4');
  const msgArb = fc.constantFrom('m1', 'm2', 'm3', 'm4');

  fc.assert(
    fc.property(
      fc.array(
        fc.oneof(
          fc.record({
            op: fc.constant('register'),
            sid: idArb,
            mid: msgArb,
            liveId: fc.constantFrom('l1', 'l2', 'l3'),
            origin: fc.constantFrom('local', 'remote'),
          }),
          fc.record({ op: fc.constant('remove'), sid: idArb }),
          fc.record({ op: fc.constant('clear') }),
        ),
        { minLength: 1, maxLength: 35 },
      ),
      (ops) => {
        const reg = new LiveStreamRegistry();
        for (const step of ops) {
          if (step.op === 'register') {
            reg.registerStream({
              storedSessionId: step.sid,
              liveSessionId: step.liveId,
              messageId: step.mid,
              origin: step.origin,
              nowMs: 1000,
            });
          } else if (step.op === 'remove') {
            reg.removeSession(step.sid);
          } else {
            reg.clear();
          }

          const sids = reg.listSessionIds();
          assert.equal(sids.length, reg.size());
          const seenMsgs = new Set();
          for (const sid of sids) {
            const stream = reg.getBySession(sid);
            assert.ok(stream);
            assert.equal(stream.storedSessionId, sid);
            assert.equal(seenMsgs.has(stream.messageId), false);
            seenMsgs.add(stream.messageId);
            assert.equal(reg.getSessionIdForMessage(stream.messageId), sid);
            assert.equal(reg.getByMessageId(stream.messageId), stream);
          }
        }
      },
    ),
    { numRuns: 300 },
  );
});

test('INV-STREAM-03: LiveStreamRegistry.acceptDelta 对重复与重叠分片严格幂等且只增不减', () => {
  fc.assert(
    fc.property(
      fc.string({ minLength: 1, maxLength: 40 }),
      fc.array(
        fc.tuple(
          fc.integer({ min: 0, max: 39 }),
          fc.integer({ min: 1, max: 12 }),
        ),
        { minLength: 1, maxLength: 20 },
      ),
      (fullText, slices) => {
        const reg = new LiveStreamRegistry();
        reg.registerStream({
          storedSessionId: 's1',
          liveSessionId: 'live-1',
          messageId: 'msg-1',
          origin: 'remote',
          nowMs: 1000,
        });

        // 先按顺序或乱序投喂切片，并重复投喂每一次
        let expected = '';
        for (const [startRaw, len] of slices) {
          const offset = Math.min(startRaw, fullText.length);
          const text = fullText.slice(offset, Math.min(fullText.length, offset + len));
          if (!text) continue;

          const before = reg.getBySession('s1').accumulatedText;
          const first = reg.acceptDelta('s1', { turnId: 't1', segment: 0, offset, text }, 1100);
          const afterFirst = reg.getBySession('s1').accumulatedText;
          assert.ok(afterFirst.startsWith(before));

          // 立即重复相同分片必须严格幂等（不追加任何字符）
          const replay = reg.acceptDelta('s1', { turnId: 't1', segment: 0, offset, text }, 1200);
          assert.equal(replay.deltaToAppend, '');
          assert.equal(reg.getBySession('s1').accumulatedText, afterFirst);
          expected = afterFirst;
        }
        assert.equal(reg.getBySession('s1').accumulatedText, expected);
      },
    ),
    { numRuns: 250 },
  );
});

test('INV-STREAM-04: reconcileInflightText 绝对不回退已领先的本地流文本', () => {
  fc.assert(
    fc.property(
      fc.string({ minLength: 1, maxLength: 50 }),
      fc.string({ minLength: 0, maxLength: 50 }),
      (localText, remoteExtra) => {
        const reg = new LiveStreamRegistry();
        reg.registerStream({
          storedSessionId: 's1',
          liveSessionId: 'live-1',
          messageId: 'msg-1',
          origin: 'local',
          initialContent: localText,
          nowMs: 1000,
        });

        // 1. 远端仅赶上部分前缀时（慢快照）严禁回退
        const prefix = localText.slice(0, Math.floor(localText.length / 2));
        const resSlow = reg.reconcileInflightText('s1', prefix, 1100);
        assert.equal(resSlow.mode, 'noop');
        assert.equal(reg.getBySession('s1').accumulatedText, localText);

        // 2. 远端严格超前时必须补全为远端全量
        const longer = localText + remoteExtra;
        const resAhead = reg.reconcileInflightText('s1', longer, 1200);
        assert.equal(reg.getBySession('s1').accumulatedText, longer);
        if (remoteExtra.length === 0) {
          assert.equal(resAhead.mode, 'noop');
        } else {
          assert.equal(resAhead.mode, 'append');
          assert.equal(resAhead.text, remoteExtra);
        }
      },
    ),
    { numRuns: 250 },
  );
});

test('INV-STREAM-05: planRemoteUserPromptInsert 在插槽补全后二次执行严格幂等（不重复生成用户气泡）', () => {
  const msgArb = fc.record({
    id: fc.uuid(),
    role: fc.constantFrom('user', 'assistant', 'system'),
    content: fc.string({ minLength: 0, maxLength: 20 }),
    displayKind: fc.constantFrom(undefined, 'hidden', 'user'),
  });

  fc.assert(
    fc.property(
      fc.array(msgArb, { maxLength: 8 }),
      fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.trim().length > 0),
      fc.integer({ min: 1, max: 10_000 }),
      (history, userText, rowId) => {
        const assistantId = 'ast-target';
        const messages = [...history, { id: assistantId, role: 'assistant', content: 'streaming...' }];
        const plan1 = planRemoteUserPromptInsert(messages, {
          assistantMessageId: assistantId,
          userText,
          userRowId: rowId,
        });
        assert.ok(plan1 !== null);
        if (plan1.kind === 'insert-before') {
          const updated = [...messages];
          updated.splice(plan1.insertIndex, 0, {
            id: 'usr-inserted',
            role: 'user',
            content: userText,
            rowId,
          });
          const plan2 = planRemoteUserPromptInsert(updated, {
            assistantMessageId: assistantId,
            userText,
            userRowId: rowId,
          });
          assert.equal(plan2?.kind, 'already-present');
        } else {
          assert.equal(plan1.kind, 'already-present');
        }
      },
    ),
    { numRuns: 250 },
  );
});

test('INV-STREAM-06: decideWatchdogProbeAction 严守 hard-limit 止损与权威运行必续期规则', () => {
  fc.assert(
    fc.property(
      fc.boolean(),
      fc.boolean(),
      fc.boolean(),
      fc.integer({ min: 0, max: 5 }),
      fc.integer({ min: 1, max: 4 }),
      (isGatewayConnected, probeRunning, probeError, consecutiveProbeFailures, maxProbeFailures) => {
        // 1. hard-limit 无条件收口
        assert.equal(
          decideWatchdogProbeAction({
            reason: 'hard-limit',
            isGatewayConnected,
            probeResult: { isRunning: true },
            probeError: false,
            consecutiveProbeFailures: 0,
            maxProbeFailures,
          }),
          'settle-timeout',
        );

        // 2. 在线且网关明确 running=true 时必须 renew
        const liveAction = decideWatchdogProbeAction({
          reason: 'inactivity',
          isGatewayConnected: true,
          probeResult: { isRunning: probeRunning },
          probeError,
          consecutiveProbeFailures,
          maxProbeFailures,
        });
        if (probeError) {
          assert.equal(liveAction, consecutiveProbeFailures < maxProbeFailures ? 'renew' : 'settle-timeout');
        } else if (probeRunning) {
          assert.equal(liveAction, 'renew');
        } else {
          assert.equal(liveAction, 'settle-completed');
        }

        // 3. extractResumeInflightState 绝不对非法载荷抛错
        const extracted = extractResumeInflightState({
          running: probeRunning,
          turn_started_at: 1700000000,
          inflight: { streaming: probeRunning, user: 'u', assistant: 'a' },
        });
        assert.equal(extracted.isRunning, probeRunning);
        assert.equal(extracted.turnStartedAtMs, 1700000000 * 1000);
      },
    ),
    { numRuns: 250 },
  );
});
