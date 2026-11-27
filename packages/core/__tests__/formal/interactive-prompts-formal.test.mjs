/**
 * 核心交互式请求协调与协议不变量形式化验证 (INV-INTERACT-01 .. INV-INTERACT-08)
 *
 * 【设计意图 (Why)】
 *   在数千种随机并发交错（慢 resume vs live_ws 抢先抵达、ws/rpc 双端竞争、socket 切代、
 *   乱序 connection.update、三态作用域混排与敏感字段探测）下，用 fast-check 证明核心安全定理。
 *
 * 【约束与规则 (Rules)】
 *   - 严禁使用本地时区 API 或 Math.random()；
 *   - 每条 `INV-INTERACT-*` 独立执行高强度 `fc.assert(..., { numRuns: 200 })`；
 *   - 失败时必须暴露真实反例，严禁弱断言或捕获吞错。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import {
  InteractiveRequestCoordinator,
  classifyJsonRpcFrame,
  resolveReplyRoute,
  redactInteractivePayload,
  SessionStatusStore,
  buildGroupScopeKey,
  GroupLogPollerManager,
} from '../../dist/index.js';

const safeIdArb = fc
  .stringMatching(/^[a-z0-9][a-z0-9_-]{2,18}$/)
  .filter((s) => s.length >= 3);

test('INV-INTERACT-01: session.resume 围栏对账绝不抹杀 fence 之后抵达的 live_ws 交互卡', () => {
  fc.assert(
    fc.property(
      safeIdArb,
      safeIdArb,
      safeIdArb,
      safeIdArb,
      fc.constantFrom('clarify', 'approval', 'secret', 'sudo'),
      (storedId, liveId, oldReqId, liveReqId, method) => {
        fc.pre(oldReqId !== liveReqId && storedId !== liveId);
        const coord = new InteractiveRequestCoordinator();
        coord.upsertServerRequest({
          rpcId: oldReqId,
          socketGeneration: 1,
          method: 'approval',
          params: { session_id: liveId, command: 'ls', request_id: oldReqId },
          storedSessionId: storedId,
          nowMs: 1000,
        });

        // 在发起 session.resume 前捕获围栏
        const fence = coord.captureSyncFence();

        // 在途期间 live_ws 下发全新请求（arrivalSeq > fence）
        const arrived = coord.upsertServerRequest({
          rpcId: liveReqId,
          socketGeneration: 1,
          method,
          params: { session_id: liveId, prompt: 'enter value', question: 'q?' },
          storedSessionId: storedId,
          nowMs: 1010,
        });
        assert.ok(arrived);

        // 慢 session.resume 返回空列表：只能裁剪 arrivalSeq <= fence 的旧条目，不得删 live 卡片
        coord.reconcileFromResume({
          storedSessionId: storedId,
          liveSessionId: liveId,
          resume: { running: false, open_requests: [] },
          fence,
          nowMs: 1020,
        });

        const remaining = coord.getActivePromptsForFocus(
          { type: 'session', sessionId: storedId },
          storedId,
          liveId,
        );
        assert.equal(remaining.length, 1);
        assert.equal(remaining[0].canonicalKey, arrived.canonicalKey);
        assert.equal(coord.getWaitingReasonForSession(storedId, liveId), arrived.waitingReason);
      },
    ),
    { numRuns: 200 },
  );
});

test('INV-INTERACT-02: bindSessionHandle 将仅带 liveSessionId 的先到请求原位重键至 storedSessionId 且去重合并', () => {
  fc.assert(
    fc.property(
      safeIdArb,
      safeIdArb,
      safeIdArb,
      fc.constantFrom('clarify', 'secret', 'approval'),
      (storedId, liveId, reqId, method) => {
        fc.pre(storedId !== liveId);
        const coord = new InteractiveRequestCoordinator();

        const livePrompt = coord.upsertServerRequest({
          rpcId: reqId,
          socketGeneration: 3,
          method,
          params: {
            session_id: liveId,
            question: 'Choose target',
            choices: ['A', 'B'],
            request_id: reqId,
            command: 'echo ok',
          },
          storedSessionId: null,
          nowMs: 2000,
        });
        assert.ok(livePrompt);
        assert.equal(livePrompt.scope.kind, 'session');
        assert.equal(livePrompt.scope.storedSessionId, null);

        coord.bindSessionHandle(storedId, liveId);

        const listAfterBind = coord.getActivePromptsForFocus(
          { type: 'session', sessionId: storedId },
          storedId,
          liveId,
        );
        assert.equal(listAfterBind.length, 1);
        assert.equal(listAfterBind[0].scope.kind, 'session');
        assert.equal(listAfterBind[0].scope.storedSessionId, storedId);
        assert.equal(listAfterBind[0].rpcId, reqId);
        assert.equal(listAfterBind[0].socketGeneration, 3);
      },
    ),
    { numRuns: 200 },
  );
});

test('INV-INTERACT-03: Cancel-Dominates-Rollback，settled/cancelled 终态具有吸收律', () => {
  fc.assert(
    fc.property(
      safeIdArb,
      safeIdArb,
      fc.constantFrom('cancel', 'settle'),
      fc.boolean(),
      (storedId, reqId, terminalOp, beginBeforeTerminal) => {
        const coord = new InteractiveRequestCoordinator();
        const prompt = coord.upsertServerRequest({
          rpcId: reqId,
          socketGeneration: 2,
          method: 'clarify',
          params: { session_id: storedId, question: 'Continue?' },
          storedSessionId: storedId,
          nowMs: 3000,
        });
        assert.ok(prompt);

        if (beginBeforeTerminal) {
          assert.equal(coord.beginSubmit(prompt.canonicalKey), true);
        }

        if (terminalOp === 'cancel') {
          assert.equal(coord.cancelByRequestId(reqId, 'aborted'), 1);
        } else {
          coord.confirmSettled(prompt.canonicalKey);
        }

        // 即使在途网络请求稍后失败触发回滚，终态绝对不可倒流为 open
        assert.equal(coord.rollbackSubmit(prompt.canonicalKey, 'network error'), false);
        assert.equal(coord.beginSubmit(prompt.canonicalKey), false);
        assert.equal(coord.hasPendingPromptForSession(storedId), false);

        // open_requests 或慢 resume 重放也不得复活已被终结的 canonicalKey
        const fence = coord.captureSyncFence();
        coord.reconcileFromResume({
          storedSessionId: storedId,
          liveSessionId: storedId,
          resume: {
            open_requests: [{ id: reqId, method: 'clarify', params: { session_id: storedId, question: 'Continue?' } }],
          },
          fence,
          nowMs: 3100,
        });
        assert.equal(coord.hasPendingPromptForSession(storedId), false);
      },
    ),
    { numRuns: 200 },
  );
});

test('INV-INTERACT-04: classifyJsonRpcFrame 严格优先按 method 分类，同号 id 绝不与本地 pendingRequests 混淆', () => {
  fc.assert(
    fc.property(
      fc.oneof(fc.integer({ min: 1, max: 10000 }), safeIdArb),
      fc.constantFrom('clarify', 'approval', 'secret', 'sudo', 'vault.code', 'event'),
      fc.dictionary(safeIdArb, fc.string({ maxLength: 20 })),
      (id, method, params) => {
        // 带 id 且 method 非空的帧一律是 server-request，而非普通 notification 或 response
        const serverFrame = classifyJsonRpcFrame({ jsonrpc: '2.0', id, method, params });
        assert.equal(serverFrame.kind, 'server-request');
        assert.equal(serverFrame.id, id);
        assert.equal(serverFrame.method, method);

        // id === null 即使有 method 也退为 ignore 或不得当成合法带 id 请求
        const nullIdFrame = classifyJsonRpcFrame({ jsonrpc: '2.0', id: null, method, params });
        assert.notEqual(nullIdFrame.kind, 'server-request');

        // 只有结果/错误而无 method 的带 id 帧才判为 response
        const responseFrame = classifyJsonRpcFrame({ jsonrpc: '2.0', id, result: { ok: true } });
        assert.equal(responseFrame.kind, 'response');
      },
    ),
    { numRuns: 250 },
  );
});

test('INV-INTERACT-05: socketGeneration 切代自动降级 RPC 且严禁 Classic/Canonical 契约参数混传', () => {
  fc.assert(
    fc.property(
      safeIdArb,
      safeIdArb,
      safeIdArb,
      fc.integer({ min: 1, max: 10 }),
      fc.integer({ min: 1, max: 10 }),
      fc.constantFrom('classic', 'canonical'),
      (storedId, reqId, profile, arrivalGen, currentGen, protocol) => {
        const coord = new InteractiveRequestCoordinator();
        coord.reconcileFromResume({
          storedSessionId: storedId,
          liveSessionId: storedId,
          profile,
          resume: {
            info: protocol === 'canonical' ? { desktop_protocol: 'hermes-gateway-v1' } : {},
            open_requests:
              protocol === 'classic'
                ? [{ id: reqId, method: 'clarify', params: { session_id: storedId, question: 'Q?' } }]
                : [],
            prompts:
              protocol === 'canonical'
                ? [{ prompt_id: reqId, kind: 'clarify', question: 'Q?', execution_generation: 7 }]
                : [],
          },
          fence: 0,
          nowMs: 4000,
        });

        const [prompt] = coord.getActivePromptsForFocus(
          { type: 'session', sessionId: storedId },
          storedId,
          storedId,
        );
        assert.ok(prompt && prompt.kind === 'clarify');

        // 模拟同时挂有 live rpcId 的情况
        const livePrompt = { ...prompt, rpcId: reqId, socketGeneration: arrivalGen };
        const route = resolveReplyRoute(
          livePrompt,
          { kind: 'clarify', answers: { [prompt.questions[0].qid]: 'yes' }, singleAnswer: 'yes' },
          currentGen,
        );

        if (arrivalGen === currentGen) {
          assert.equal(route.transport, 'ws_response');
        } else {
          assert.equal(route.transport, 'rpc');
          if (protocol === 'canonical') {
            assert.equal(route.method, 'clarify.respond');
            assert.equal('profile' in route.params, false, 'clarify.respond 不得携带 profile');
            assert.equal(route.params.execution_generation, 7);
          } else {
            assert.equal(route.method, 'request.answer');
          }
        }
      },
    ),
    { numRuns: 200 },
  );
});

test('INV-INTERACT-06: 群聊 pending_actions 与单聊/Bot 主工位严格隔离，Canonical 群聊审批限 once|deny', () => {
  fc.assert(
    fc.property(
      safeIdArb,
      safeIdArb,
      safeIdArb,
      safeIdArb,
      fc.constantFrom('once', 'session', 'always', 'deny'),
      (roomId, sessionId, botName, reqId, attemptedChoice) => {
        fc.pre(roomId !== sessionId);
        const coord = new InteractiveRequestCoordinator();
        const rawPending = [
          {
            kind: 'approval',
            request_id: reqId,
            member_id: 'm1',
            task_id: 'task-1',
            execution_generation: 4,
            command: 'rm -rf tmp',
            choices: ['once', 'session', 'always', 'deny'],
          },
        ];
        const store = new SessionStatusStore();
        store.applyGroupState(roomId, {
          room_id: roomId,
          driver_status: { pending_actions: rawPending },
        });
        const normalized = store.getScope(buildGroupScopeKey(roomId))?.groupState?.pendingActions ?? [];
        coord.reconcileGroupPendingActions(roomId, botName, normalized, 'canonical', 5000);

        // 单聊与 Bot 域绝不显示任何群聊 waiting
        assert.equal(coord.hasPendingPromptForSession(sessionId), false);
        assert.equal(coord.getWaitingReasonForSession(sessionId), null);
        assert.equal(coord.getWaitingReasonForGroup(roomId), 'approval');

        const [groupPrompt] = coord.getActivePromptsForFocus(
          { type: 'group', roomId },
          '',
          '',
        );
        assert.ok(groupPrompt && groupPrompt.kind === 'group_action');
        assert.deepEqual(groupPrompt.choices, ['once', 'deny']);

        const route = resolveReplyRoute(groupPrompt, {
          kind: 'group_action',
          action: 'approve',
          choice: attemptedChoice,
        }, null);
        assert.equal(route.transport, 'rpc');
        if (route.transport === 'rpc') {
          assert.equal(route.method, 'groups.approve');
          assert.ok(
            route.params.choice === 'once' || route.params.choice === 'deny',
            'canonical 群聊 groups.approve 必须阻断 session/always 并收敛到 once|deny',
          );
        }
      },
    ),
    { numRuns: 200 },
  );
});

test('INV-INTERACT-07: connection op 强制 seq 单调增量与 settled:false 保活', () => {
  fc.assert(
    fc.property(
      safeIdArb,
      safeIdArb,
      fc.integer({ min: 5, max: 50 }),
      fc.integer({ min: 1, max: 4 }),
      (opId, sessionId, highSeq, staleSeq) => {
        const coord = new InteractiveRequestCoordinator();
        const created = coord.applyConnectionRequest(
          sessionId,
          {
            op_id: opId,
            seq: highSeq,
            deadline_at: 999999,
            timeout_seconds: 300,
            targets: [{ name: 'github', kind: 'connector', action: 'authorize', state: 'pending' }],
          },
          6000,
          'default',
          sessionId,
        );
        assert.ok(created);

        // 乱序更低 seq 的 settled=true 通知或 partial update 不得覆盖更高 seq
        coord.applyConnectionUpdate({
          op_id: opId,
          seq: staleSeq,
          deadline_at: 999999,
          settled: true,
          targets: [{ name: 'github', kind: 'connector', action: 'authorize', state: 'connected' }],
          owner: { type: 'session', session_id: sessionId },
        }, 6010);
        assert.equal(coord.hasPendingPromptForSession(sessionId), true);

        // connection.respond 返回 settled=false 时必须保留卡片供继续授权其余目标
        coord.applyConnectionRespondResult(opId, false, [
          { name: 'github', kind: 'connector', action: 'authorize', state: 'initiated' },
        ]);
        const active = coord.getPrompt(created.canonicalKey);
        assert.ok(active && active.status === 'open');

        // 正序更高 seq 且 settled=true 时立即收敛并拒绝更低 seq 复活
        coord.applyConnectionUpdate({
          op_id: opId,
          seq: highSeq + 1,
          deadline_at: 999999,
          settled: true,
          targets: [{ name: 'github', kind: 'connector', action: 'authorize', state: 'connected' }],
          owner: { type: 'session', session_id: sessionId },
        }, 6020);
        assert.equal(coord.hasPendingPromptForSession(sessionId), false);
      },
    ),
    { numRuns: 200 },
  );
});

test('INV-INTERACT-08: redactInteractivePayload 对任意 secret/sudo/vault/connection.env 明文彻底脱敏', () => {
  fc.assert(
    fc.property(
      fc.string({ minLength: 4, maxLength: 24 }).map((s) => `sec_${s}`),
      fc.constantFrom('MY_API_TOKEN', 'DB_PASS', 'CUSTOM_SECRET'),
      (rawSecret, envKey) => {
        const cases = [
          redactInteractivePayload('secret', { value: rawSecret }),
          redactInteractivePayload('sudo', { value: rawSecret }),
          redactInteractivePayload('vault.unlock_prompt', { value: rawSecret, hint: 'visible' }),
          redactInteractivePayload('request.answer', {
            id: 'r1',
            result: { value: rawSecret, identifier: 'alice' },
          }),
          redactInteractivePayload('connection.respond', {
            op_id: 'op1',
            result: { targets: [{ name: 'slack', status: 'approved', env: { [envKey]: rawSecret } }] },
          }),
        ];

        for (const sanitized of cases) {
          const serialized = JSON.stringify(sanitized);
          assert.equal(
            serialized.includes(rawSecret),
            false,
            `交互载荷日志脱敏失败，泄漏了明文: ${serialized}`,
          );
          assert.equal(serialized.includes('[REDACTED]'), true);
        }
      },
    ),
    { numRuns: 200 },
  );
});

test('INV-INTERACT-09: GroupLogPollerManager 在 isBlocked 期间暂停轮次与停滞计数且永不误判失败', async () => {
  await fc.assert(
    fc.asyncProperty(
      safeIdArb,
      fc.integer({ min: 1, max: 4 }),
      fc.integer({ min: 2, max: 6 }),
      fc.integer({ min: 1, max: 8 }),
      async (roomId, maxStagnant, extraBlockedTicks, postUnblockIdleTicks) => {
        const maxRounds = maxStagnant + 1;
        const totalBlockedTicks = maxRounds + maxStagnant + extraBlockedTicks;
        let blocked = true;
        let fetchCount = 0;
        let logs = [];
        let failedCount = 0;
        let completedCount = 0;

        let nextHandle = 1;
        const queue = [];
        const scheduler = {
          setTimeout(cb, delayMs) {
            const handle = nextHandle++;
            queue.push({ handle, cb, delayMs });
            return handle;
          },
          clearTimeout(handle) {
            const idx = queue.findIndex((item) => item.handle === handle);
            if (idx >= 0) queue.splice(idx, 1);
          },
        };

        const mgr = new GroupLogPollerManager({
          fetchLogs: async () => {
            fetchCount += 1;
            return logs;
          },
          isFocused: () => true,
          isBlocked: () => blocked,
          onSyncLogs: () => {},
          onCompleted: () => {
            completedCount += 1;
          },
          onFailed: () => {
            failedCount += 1;
          },
          scheduler,
          maxRounds,
          maxStagnantRounds: maxStagnant,
          intervalMs: 100,
          backoffIntervalMs: 500,
        });

        mgr.startAwaitReply(roomId, { knownCount: 0, lastSeq: null, lastAssistantMessageId: null });
        const flushTick = async () => {
          const next = queue.shift();
          if (!next) return false;
          next.cb();
          await Promise.resolve();
          await Promise.resolve();
          return true;
        };

        for (let i = 0; i < totalBlockedTicks; i += 1) {
          assert.equal(queue.length > 0, true);
          assert.equal(queue[0].delayMs, i === 0 ? 100 : 500, '阻塞期必须按 backoffIntervalMs 保活调度');
          await flushTick();
          assert.equal(failedCount, 0, '阻塞期绝不能误判超时失败');
          assert.equal(fetchCount, 0, '阻塞期暂停执行 fetchLogs 避免无意义轮次消耗');
        }

        blocked = false;
        for (let i = 0; i < Math.min(maxStagnant - 1, postUnblockIdleTicks); i += 1) {
          await flushTick();
        }
        assert.equal(failedCount, 0);

        logs = [{ messageId: 'm-reply', role: 'assistant', seq: 10, content: 'done' }];
        while (queue.length > 0 && completedCount === 0 && failedCount === 0) {
          await flushTick();
        }
        assert.equal(failedCount, 0);
        assert.equal(completedCount, 1);
        mgr.stopAll();
      },
    ),
    { numRuns: 100 },
  );
});
