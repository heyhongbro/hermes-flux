/**
 * TurnExecutionService 中断收口、工具收敛与多流撤防守卫单测
 * (packages/desktop/__tests__/unit/turnExecutionService.interrupt.test.mjs)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveStreamRegistry } from '@hermes-flux/core';
import { createTurnExecutionService } from '../../dist/renderer/services/turnExecutionService.mjs';
import { advanceTimers, createGate, createMockTurnDeps } from './helpers/turnExecutionHarness.mjs';

test('D5: turnExecutionService - interruptTurn 终止当前流式并更新消息标记', async () => {
  const { deps, state, rpcCalls, activeStreamingContext } = createMockTurnDeps({
    state: {
      isStreaming: true,
      messages: [
        { id: 'ast-1', role: 'assistant', content: '生成中内容' },
      ],
    },
    activeStreamingContext: {
      activeStreamingMessageId: 'ast-1',
      activeStreamingStoredSessionId: 'sess-1',
      activeStreamingLiveId: 'live-1',
    },
  });

  const service = createTurnExecutionService(deps);
  await service.interruptTurn();

  assert.equal(state.isStreaming, false);
  assert.equal(state.presenceTerminal?.kind, 'interrupted');
  const msg = state.messages.find((m) => m.id === 'ast-1');
  assert.match(msg.content, /\*\(已中断\)\*/);
  assert.equal(activeStreamingContext().activeStreamingMessageId, null);

  const interruptRpc = rpcCalls.find((c) => c.method === 'session.interrupt');
  assert.ok(interruptRpc, '必须调用 remote session.interrupt');
  assert.equal(interruptRpc.params.session_id, 'live-1');
});

test('D5: turnExecutionService - interruptTurn 发生在上传/截断在途与重发 Turn 2 时的竞态保护', async () => {
  // 5b. interruptTurn() 发生在上传附件等待期间：hasUnsettledRunning 为 false，跳过 prompt.submit 且不覆写中断态
  {
    let releaseUpload;
    const uploadEntered = createGate();
    const uploadPromise = new Promise((resolve) => {
      releaseUpload = resolve;
    });
    const calls = [];
    const { deps, state } = createMockTurnDeps({
      state: {
        activeSessionId: 'sess-int-up',
        attachments: [{ id: 'att-int', name: 'up.png', type: 'image', previewUrl: 'data:image/png;base64,QUJD' }],
      },
      gatewayClient: {
        call: async (method) => {
          calls.push(method);
          if (method === 'image.attach_bytes') {
            uploadEntered.notify();
            return uploadPromise;
          }
          return {};
        },
      },
    });
    const service = createTurnExecutionService(deps);
    try {
      const p = service.sendMessage('interrupt while uploading');
      await uploadEntered.promise;

      await service.interruptTurn();
      const contentAfterInt = state.messages.at(-1)?.content;
      releaseUpload({ ok: true });
      await p;

      assert.equal(calls.includes('prompt.submit'), false);
      assert.equal(state.presenceTerminal?.kind, 'interrupted');
      assert.equal(state.messages.at(-1)?.content, contentAfterInt);
    } finally {
      service.disarmTurnWatchdog(true);
    }
  }

  // 6b. interruptTurn() 后 prompt.submit 迟到 reject：不得覆写已中断消息或恢复 rollbackArmed
  {
    let rejectTrunc;
    const truncEntered = createGate();
    const truncPromise = new Promise((_res, rej) => {
      rejectTrunc = rej;
    });
    const origSnap = [{ id: 'snap-int', role: 'user', content: 'int orig' }];
    const { deps, state } = createMockTurnDeps({
      state: {
        activeSessionId: 'sess-1',
        rollbackArmed: { sessionId: 'sess-1', anchor: { kind: 'row', rowId: 7 }, snapshot: origSnap },
      },
    });
    deps.getInteractiveService().truncateAndSubmit = () => {
      truncEntered.notify();
      return truncPromise;
    };
    const service = createTurnExecutionService(deps);
    try {
      const p = service.sendMessage('interrupt mid truncate');
      await truncEntered.promise;

      await service.interruptTurn();
      rejectTrunc(new Error('late after interrupt'));
      await p;
      assert.equal(state.presenceTerminal?.kind, 'interrupted');
      assert.notDeepEqual(state.messages, origSnap);
    } finally {
      service.disarmTurnWatchdog(true);
    }
  }

  // 8. 同会话/同 Bot interruptTurn 后立刻重发 Turn 2 -> Turn 1 迟到拒绝对 Turn 2 零污染
  {
    let rejectTurn1;
    const trunc1Entered = createGate();
    let callCount = 0;
    const origSnap1 = [{ id: 'snap-t1', role: 'user', content: 't1 orig' }];
    const { deps, state } = createMockTurnDeps({
      state: {
        activeSessionId: 'sess-same',
        activeFocus: { type: 'bot', botName: 'bot-same' },
        rollbackArmed: { sessionId: 'sess-same', anchor: { kind: 'row', rowId: 9 }, snapshot: origSnap1 },
      },
    });
    deps.getInteractiveService().truncateAndSubmit = () => {
      callCount += 1;
      if (callCount === 1) {
        trunc1Entered.notify();
        return new Promise((_res, rej) => {
          rejectTurn1 = rej;
        });
      }
      return Promise.resolve({ status: 'streaming', user_row_id: 202 });
    };
    const service = createTurnExecutionService(deps);
    try {
      const p1 = service.sendMessage('turn 1');
      await trunc1Entered.promise;

      await service.interruptTurn();
      await service.sendMessage('turn 2');
      const turn2CtxId = deps.getActiveStreamingContext().activeStreamingMessageId;
      const msgsBeforeReject = [...state.messages];

      rejectTurn1(new Error('late t1 reject'));
      await p1;

      assert.equal(deps.getActiveRunningSessionIds().has('sess-same'), true, 'Turn 1 不得清除 Turn 2 运行态');
      assert.equal(deps.getActiveRunningBotNames().has('bot-same'), true);
      assert.equal(deps.getActiveStreamingContext().activeStreamingMessageId, turn2CtxId);
      assert.deepEqual(state.messages, msgsBeforeReject);
    } finally {
      service.disarmTurnWatchdog(true);
    }
  }
});

test('D5: turnExecutionService - interruptTurn 捕获前置贴底、清理工具补丁与运行中工具态、重置时长锚点且仅单次 render', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_700_000_000_000 });
  try {
    let nearBottom = true;
    const pendingScrollCalls = [];
    let clearToolPatchCalls = 0;
    let stopToolTimerCalls = 0;
    const { deps, state, rendered, activeStreamingContext } = createMockTurnDeps({
      state: {
        isStreaming: true,
        turnStartedAt: Date.now() - 5000,
        messages: [
          {
            id: 'ast-1',
            role: 'assistant',
            content: '生成中内容',
            toolCalls: [{ id: 'tc-run', name: 'run_cmd', status: 'running', args: '{}', startTime: Date.now() - 1200 }],
          },
        ],
      },
      activeStreamingContext: {
        activeStreamingMessageId: 'ast-1',
        activeStreamingStoredSessionId: 'sess-1',
        activeStreamingLiveId: 'live-1',
      },
    });
    deps.setTurnStartedSessionId('sess-1');
    deps.isStreamNearBottom = () => nearBottom;
    deps.setPendingScrollToBottom = (val) => pendingScrollCalls.push(val);
    deps.clearToolPatchQueue = () => { clearToolPatchCalls += 1; };
    deps.stopRunningToolTimers = () => { stopToolTimerCalls += 1; };
    // 模拟 flush / setMessageContent 撑高容器后 isStreamNearBottom 翻转 false
    const origSetContent = deps.setMessageContent;
    deps.setMessageContent = (mid, content) => {
      nearBottom = false;
      origSetContent(mid, content);
    };

    const service = createTurnExecutionService(deps);
    await service.interruptTurn();

    assert.deepEqual(pendingScrollCalls, [true], 'interruptTurn 必须在 flush/setMessageContent 改写 DOM 前捕获贴底意图');
    assert.equal(clearToolPatchCalls, 1, 'interruptTurn 必须清空 toolPatchQueue');
    assert.equal(stopToolTimerCalls, 1, 'interruptTurn 必须停止运行中工具计时器');
    assert.equal(state.messages[0].toolCalls[0].status, 'completed', '中断后运行中工具必须收敛为 completed，停止 spinner 空转');
    assert.ok(state.messages[0].toolCalls[0].durationMs >= 100, '收敛工具必须冻结耗时');
    assert.equal(state.turnStartedAt, undefined, '中断后必须清空 turnStartedAt');
    assert.equal(deps.getTurnStartedSessionId(), null, '中断后必须清空 turnStartedSessionId');
    assert.equal(rendered.length, 1, 'interruptTurn 必须仅触发唯一一次 render()（消除 setTimedDockNotice 后重复 render）');
    assert.equal(activeStreamingContext().activeStreamingMessageId, null);

    // 非贴底时中断不得强行拉回底部
    nearBottom = false;
    pendingScrollCalls.length = 0;
    state.isStreaming = true;
    deps.setActiveStreamingContext({
      activeStreamingMessageId: 'ast-1',
      activeStreamingStoredSessionId: 'sess-1',
      activeStreamingLiveId: 'live-1',
    });
    await service.interruptTurn();
    assert.deepEqual(pendingScrollCalls, [], '用户已上滚回看时中断不得强行置底');
  } finally {
    t.mock.timers.reset();
  }
});

test('D5: turnExecutionService - setTimedDockNotice skipRender 选项与 interruptTurn 独立缓存运行中工具收敛', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_700_000_000_000 });
  try {
    const { deps, state, rendered } = createMockTurnDeps({
      state: {
        isStreaming: true,
        messages: [
          {
            id: 'ast-1',
            role: 'assistant',
            content: 'live',
            toolCalls: [{ id: 'tc-1', name: 'shell', status: 'running', args: '{}', startTime: Date.now() - 500 }],
          },
        ],
      },
      activeStreamingContext: {
        activeStreamingMessageId: 'ast-1',
        activeStreamingStoredSessionId: 'sess-1',
        activeStreamingLiveId: 'live-1',
      },
    });

    // 独立缓存数组（引用不同于 state.messages），用于覆盖 interruptTurn 同步收敛缓存副本路径
    const separateCachedMsgs = [
      {
        id: 'ast-1',
        role: 'assistant',
        content: 'live',
        toolCalls: [{ id: 'tc-1', name: 'shell', status: 'running', args: '{}', startTime: Date.now() - 500 }],
      },
    ];
    deps.getSessionMessagesCache().set('sess-1', separateCachedMsgs);

    const service = createTurnExecutionService(deps);

    // 1. setTimedDockNotice({ skipRender: true }) 只写文案不触发额外 render
    service.setTimedDockNotice('quiet notice', 0, { skipRender: true });
    assert.equal(state.dockNotice, 'quiet notice');
    assert.equal(rendered.length, 0, 'skipRender: true 不得触发同步 render()');

    // 2. interruptTurn 同时收敛 state.messages 与独立缓存数组里的 running toolCalls
    await service.interruptTurn();
    assert.equal(state.messages[0].toolCalls[0].status, 'completed');
    assert.equal(separateCachedMsgs[0].toolCalls[0].status, 'completed', '独立缓存副本中的运行中工具也必须收敛');
    assert.equal(rendered.length, 1);

    // 3. 当 sessionMessagesCache 无对应桶时（cached === undefined），interruptTurn 必须安全完成而不抛错
    deps.getSessionMessagesCache().delete('sess-1');
    deps.setActiveStreamingContext({
      activeStreamingMessageId: 'ast-1',
      activeStreamingStoredSessionId: 'sess-1',
      activeStreamingLiveId: 'live-1',
    });
    state.isStreaming = true;
    state.messages[0].toolCalls[0].status = 'running';
    await service.interruptTurn();
    assert.equal(state.messages[0].toolCalls[0].status, 'completed');
  } finally {
    t.mock.timers.reset();
  }
});

test('D5: turnExecutionService - interruptTurn 空正文/后台缓存/工具耗时兜底与群聊实体清理', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_700_000_000_000 });
  try {
    const flushCalls = [];
    const setContentCalls = [];
    const trackerClears = [];
    const pendingCalls = [];
    const { deps, state } = createMockTurnDeps({
      state: {
        isStreaming: true,
        activeSessionId: 'sess-1',
        messages: [
          {
            id: 'ast-empty',
            role: 'assistant',
            content: '',
            toolCalls: [
              { id: 't-fast', name: 'f', status: 'running', startTime: Date.now() - 5 },
              { id: 't-slow', name: 's', status: 'running', startTime: Date.now() - 400 },
              { id: 't-keep', name: 'k', status: 'running', startTime: Date.now() - 400, durationMs: 222 },
              { id: 't-err', name: 'e', status: 'failed', startTime: Date.now() - 400 },
            ],
          },
        ],
      },
      activeStreamingContext: {
        activeStreamingMessageId: 'ast-empty',
        activeStreamingStoredSessionId: 'sess-1',
        activeStreamingLiveId: 'live-1',
        activeStreamingBotName: 'bot-1',
      },
    });
    deps.getTokenCoalescer = () => ({ enqueue: () => {}, flush: () => flushCalls.push(1) });
    deps.setMessageContent = (id, c) => setContentCalls.push([id, c]);
    deps.getActivityTransitionTracker = () => ({ clear: (k, id) => trackerClears.push([k, id]) });
    deps.setPendingScrollToBottom = (v) => pendingCalls.push(v);
    deps.isStreamNearBottom = undefined;
    deps.getActiveRunningSessionIds().add('sess-1');
    deps.getActiveRunningBotNames().add('bot-1');

    const service = createTurnExecutionService(deps);
    await service.interruptTurn();

    assert.equal(flushCalls.length, 1);
    assert.equal(state.messages[0].content, deps.t('chat.interruptedEmpty'));
    assert.deepEqual(setContentCalls, [['ast-empty', deps.t('chat.interruptedEmpty')]]);
    assert.deepEqual(pendingCalls, [], '未注入 isStreamNearBottom 时默认 false');
    assert.equal(state.messages[0].toolCalls[0].durationMs, 100);
    assert.ok(state.messages[0].toolCalls[1].durationMs >= 300);
    assert.equal(state.messages[0].toolCalls[2].durationMs, 222);
    assert.equal(state.messages[0].toolCalls[3].status, 'failed');
    assert.equal(deps.getActiveRunningSessionIds().has('sess-1'), false);
    assert.equal(deps.getActiveRunningBotNames().has('bot-1'), false);
    assert.deepEqual(trackerClears, [['session', 'sess-1'], ['bot', 'bot-1']]);

    // 后台会话中断：命中非空与空缓存消息
    const bgMsgs = [
      { id: 'other', role: 'user', content: 'u' },
      { id: 'bg-1', role: 'assistant', content: 'partial' },
      { id: 'bg-empty', role: 'assistant', content: '' },
    ];
    deps.getSessionMessagesCache().set('sess-bg', bgMsgs);
    deps.setActiveStreamingContext({
      activeStreamingMessageId: 'bg-1',
      activeStreamingStoredSessionId: 'sess-bg',
      activeStreamingLiveId: 'live-bg',
      activeStreamingBotName: null,
    });
    await service.interruptTurn();
    assert.equal(bgMsgs[0].content, 'u');
    assert.equal(bgMsgs[1].content, `partial${deps.t('chat.interruptedSuffix')}`);

    deps.setActiveStreamingContext({
      activeStreamingMessageId: 'bg-empty',
      activeStreamingStoredSessionId: 'sess-bg',
      activeStreamingLiveId: 'live-bg',
      activeStreamingBotName: null,
    });
    await service.interruptTurn();
    assert.equal(bgMsgs[2].content, deps.t('chat.interruptedEmpty'));

    // 群聊聚焦中断：无 sessionId/botName，清理 activeRunningGroupRoomIds 与 tracker('group', roomId)
    trackerClears.length = 0;
    state.activeFocus = { type: 'group', roomId: 'room-1' };
    deps.getActiveRunningGroupRoomIds().add('room-1');
    deps.setActiveStreamingContext({
      activeStreamingMessageId: null,
      activeStreamingStoredSessionId: null,
      activeStreamingLiveId: null,
      activeStreamingBotName: null,
    });
    await service.interruptTurn();
    assert.equal(deps.getActiveRunningGroupRoomIds().has('room-1'), false);
    assert.deepEqual(trackerClears, [['group', 'room-1']]);
  } finally {
    t.mock.timers.reset();
  }
});

test('TurnExecutionService: interruptTurn 全分支与多流撤防守卫 (turnExecutionSubmit)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_700_000_000_000 });
  try {
    // 1. interruptTurn 空会话防误删 removeSession & releaseTurnOwnership 防延迟失败误杀新回合
    {
      const removedIds = [];
      let rejectInterrupted;
      const submitIntEntered = createGate();
      const { deps, state } = createMockTurnDeps({
        state: {
          activeSessionId: '',
          activeLiveSessionId: '',
          sessions: [{ id: 'sess-int', title: 'Int', botName: 'int-bot', preview: '', timestamp: 1 }],
          messages: [],
        },
        gatewayClient: {
          call: async (method) => {
            if (method === 'prompt.submit') {
              submitIntEntered.notify();
              return await new Promise((_, rej) => { rejectInterrupted = rej; });
            }
            return {};
          },
        },
      });
      deps.getLiveStreamRegistry = () => ({
        registerStream: () => {},
        hasSession: () => false,
        getBySession: () => undefined,
        listSessionIds: () => [],
        removeSession: (sid) => removedIds.push(sid),
        size: () => 0,
      });
      const svc = createTurnExecutionService(deps);
      try {
        await svc.interruptTurn();
        assert.deepEqual(removedIds, [], 'interruptedSessionId 为空时不得调用 removeSession');

        state.activeSessionId = 'sess-int';
        state.activeLiveSessionId = 'live-int';
        state.activeFocus = { type: 'bot', botName: 'int-bot', sessionId: 'sess-int' };
        const pendingSend = svc.sendMessage('interrupt me');
        await submitIntEntered.promise;
        await svc.interruptTurn();
        // 打断后重新开始新一轮运行态
        deps.getActiveRunningSessionIds().add('sess-int');
        deps.getActiveRunningBotNames().add('int-bot');
        rejectInterrupted(new Error('interrupted drop'));
        await pendingSend;
        assert.equal(deps.getActiveRunningSessionIds().has('sess-int'), true, 'interruptTurn 释放 ownership 后迟到拒绝不得误杀新回合');
        assert.equal(deps.getActiveRunningBotNames().has('int-bot'), true);
      } finally {
        svc.disarmTurnWatchdog(true);
      }
    }

    // 2. 无 streamRegistry（含后台缓存缺失与消息缺失）与有 streamRegistry 下的 interruptTurn (L475-476, L773)
    {
      const { deps: depsNoReg, state: stateNoReg } = createMockTurnDeps({
        state: { activeSessionId: 'sess-1', isStreaming: true },
        activeStreamingContext: {
          activeStreamingStoredSessionId: 'sess-other',
          activeStreamingLiveId: 'live-other',
          activeStreamingMessageId: 'm-1',
        },
      });
      const svcNoReg = createTurnExecutionService(depsNoReg);
      await svcNoReg.interruptTurn();
      assert.equal(stateNoReg.isStreaming, false);

      depsNoReg.getSessionMessagesCache().set('sess-other', [{ id: 'other-id', role: 'user', content: 'u' }]);
      depsNoReg.setActiveStreamingContext({
        activeStreamingStoredSessionId: 'sess-other',
        activeStreamingLiveId: 'live-other',
        activeStreamingMessageId: 'm-missing',
      });
      await svcNoReg.interruptTurn();
      assert.equal(depsNoReg.getSessionMessagesCache().get('sess-other')[0].content, 'u');

      const reg = new LiveStreamRegistry();
      const { deps, state } = createMockTurnDeps({
        state: { activeSessionId: 'sess-1', isStreaming: true },
        activeStreamingContext: {
          activeStreamingStoredSessionId: 'sess-1',
          activeStreamingLiveId: 'live-1',
          activeStreamingMessageId: 'm-reg',
        },
      });
      deps.getLiveStreamRegistry = () => reg;
      reg.registerStream({ storedSessionId: 'sess-1', liveSessionId: 'live-1', messageId: 'm-reg', origin: 'local' });
      const svcWithReg = createTurnExecutionService(deps);
      await svcWithReg.interruptTurn();
      assert.equal(reg.hasSession('sess-1'), false, '有 streamRegistry 时 interruptTurn 必须同步移除活跃流');
      assert.equal(state.isStreaming, false);
    }

    // 3. interruptTurn 先移除当前流再撤防：唯一流彻底撤防，并发后台流存在时看门狗继续探活
    {
      const reg = new LiveStreamRegistry();
      let probeCount = 0;
      const { deps, state } = createMockTurnDeps({
        gatewayClient: {
          call: async (method) => {
            if (method === 'session.resume') {
              probeCount += 1;
              return { running: true };
            }
            return {};
          },
        },
        activeStreamingContext: {
          activeStreamingStoredSessionId: 'sess-int-a',
          activeStreamingLiveId: 'live-int-a',
          activeStreamingMessageId: 'ast-int-a',
        },
      });
      deps.watchdogIdleTimeoutMs = 20;
      deps.watchdogHardLimitMs = 300;
      deps.getLiveStreamRegistry = () => reg;
      const svc = createTurnExecutionService(deps);
      try {
        state.activeSessionId = 'sess-int-a';
        state.activeLiveSessionId = 'live-int-a';
        state.isStreaming = true;
        state.messages = [
          { id: 'u-a', role: 'user', content: 'hi' },
          { id: 'ast-int-a', role: 'assistant', content: 'part' },
        ];
        reg.registerStream({
          storedSessionId: 'sess-int-a',
          liveSessionId: 'live-int-a',
          messageId: 'ast-int-a',
          origin: 'local',
          nowMs: 1000,
        });
        reg.registerStream({
          storedSessionId: 'sess-bg-b',
          liveSessionId: 'live-bg-b',
          messageId: 'ast-bg-b',
          origin: 'remote',
          nowMs: 1000,
        });
        svc.armTurnWatchdog();

        // 打断 sess-int-a 但后台 sess-bg-b 仍在运行：sess-int-a 被摘除但看门狗继续保活探询
        await svc.interruptTurn();
        assert.equal(reg.hasSession('sess-int-a'), false);
        assert.equal(reg.hasSession('sess-bg-b'), true);
        probeCount = 0;
        await advanceTimers(t, 20);
        assert.ok(probeCount >= 1, '打断当前流但仍有后台流时，看门狗必须继续保持武装');

        // 无其他流时 interruptTurn 必须彻底 disarm 看门狗
        svc.disarmTurnWatchdog(true);
        reg.removeSession('sess-bg-b');
        deps.setActiveStreamingContext({
          activeStreamingStoredSessionId: 'sess-int-solo',
          activeStreamingLiveId: 'live-int-solo',
          activeStreamingMessageId: 'ast-int-solo',
        });
        state.activeSessionId = 'sess-int-solo';
        state.activeLiveSessionId = 'live-int-solo';
        state.isStreaming = true;
        state.messages = [{ id: 'ast-int-solo', role: 'assistant', content: 'solo' }];
        reg.registerStream({
          storedSessionId: 'sess-int-solo',
          liveSessionId: 'live-int-solo',
          messageId: 'ast-int-solo',
          origin: 'local',
          nowMs: 2000,
        });
        svc.armTurnWatchdog();
        probeCount = 0;
        await svc.interruptTurn();
        assert.equal(reg.hasSession('sess-int-solo'), false);
        state.activeSessionId = 'sess-after-int';
        state.isStreaming = true;
        await advanceTimers(t, 20);
        state.isStreaming = false;
        assert.equal(probeCount, 0, '最后一条流被打断后，看门狗必须彻底撤防');
      } finally {
        svc.disarmTurnWatchdog(true);
      }
    }
  } finally {
    t.mock.timers.reset();
  }
});
