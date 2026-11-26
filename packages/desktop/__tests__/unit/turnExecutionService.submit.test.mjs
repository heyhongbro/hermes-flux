/**
 * TurnExecutionService 消息提交、附件上传取消、回滚快照与并发排队竞态单测
 * (packages/desktop/__tests__/unit/turnExecutionService.submit.test.mjs)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveStreamRegistry } from '@hermes-flux/core';
import { createTurnExecutionService } from '../../dist/renderer/services/turnExecutionService.mjs';
import { advanceTimers, createGate, createMockTurnDeps } from './helpers/turnExecutionHarness.mjs';

test('D5: turnExecutionService - sendMessage 发送单聊并挂载流式上下文', async () => {
  const { deps, state, rpcCalls, activeStreamingContext, depsRecorded } = createMockTurnDeps();
  const service = createTurnExecutionService(deps);

  await service.sendMessage('请帮我分析这段架构');

  assert.equal(state.isStreaming, true);
  assert.ok(state.turnStartedAt > 0);
  assert.equal(state.messages.length, 3); // usr-1 + new user + new assistant
  assert.equal(depsRecorded.userExpandedState, false, '发消息必须主动解除历史回溯扩展锁定');
  assert.equal(depsRecorded.ensuredWindowTotal, 3, '发消息必须强制根据新总数对齐窗口');
  const userMsg = state.messages[1];
  assert.equal(userMsg.role, 'user');
  assert.equal(userMsg.content, '请帮我分析这段架构');
  assert.equal(userMsg.rowId, 42, '网关权威 user_row_id 必须绑定回用户行');

  const submitRpc = rpcCalls.find((c) => c.method === 'prompt.submit');
  assert.ok(submitRpc);
  assert.equal(submitRpc.params.text, '请帮我分析这段架构');
  assert.equal(activeStreamingContext().activeStreamingStoredSessionId, 'sess-1');

  service.armTurnWatchdog();
  service.feedTurnWatchdog();
  service.disarmTurnWatchdog();
  service.clearPresenceTerminal();
});

test('D5: turnExecutionService - sendMessage 附件上传期间断连与切会话后台提交收口', async (t) => {
  // 1. 上传期间 disconnect (getGatewayClient !== client) 与中断 (activeStreamingMessageId 变更) 均不得续发 prompt.submit
  for (const mode of ['disconnectClient', 'interruptStream']) {
    let releaseUpload;
    const uploadGate = createGate();
    const uploadPromise = new Promise((resolve) => {
      releaseUpload = resolve;
    });
    const calls = [];
    let currentClient = {
      call: async (method, params) => {
        calls.push({ method, params });
        if (method === 'image.attach_bytes') {
          uploadGate.notify();
          return uploadPromise;
        }
        return { status: 'streaming', user_row_id: 99 };
      },
    };
    const { deps } = createMockTurnDeps({
      state: {
        activeSessionId: 'sess-1',
        attachments: [
          {
            id: 'att-up-1',
            name: 'shot.png',
            label: 'Image 1',
            type: 'image',
            mimeType: 'image/png',
            previewUrl: 'data:image/png;base64,QUJD',
          },
        ],
      },
    });
    deps.getGatewayClient = () => currentClient;
    const service = createTurnExecutionService(deps);
    const sendPromise = service.sendMessage('hello');
    await uploadGate.promise;

    if (mode === 'disconnectClient') {
      currentClient = null;
    } else {
      deps.setActiveStreamingContext({ activeStreamingMessageId: 'ast-switched' });
    }
    releaseUpload({ ok: true, id: 'att-up-1' });
    await sendPromise;

    assert.equal(
      calls.some((c) => c.method === 'prompt.submit'),
      false,
      `${mode} 后严禁继续发送 prompt.submit`,
    );
  }

  // 2. 上传期间仅切换焦距到其他会话（state.isStreaming = false，activeStreamingContext 未撤消）：
  // 后台仍须完成 truncateAndSubmit，且 user_row_id / trust / cache 只更新 sess-1，不得污染 sess-other
  {
    let releaseUpload;
    const uploadGate = createGate();
    const uploadPromise = new Promise((resolve) => {
      releaseUpload = resolve;
    });
    const otherMessages = [{ id: 'other-m1', role: 'user', content: 'other session' }];
    const { deps, state, cacheService } = createMockTurnDeps({
      state: {
        activeSessionId: 'sess-1',
        hasOlderMessages: false,
        rollbackArmed: {
          sessionId: 'sess-1',
          anchor: { kind: 'row', rowId: 10 },
          snapshot: [{ id: 'snap-orig', role: 'user', content: 'orig' }],
        },
        attachments: [
          {
            id: 'att-bg-1',
            name: 'shot.png',
            type: 'image',
            previewUrl: 'data:image/png;base64,QUJD',
          },
        ],
      },
      gatewayClient: {
        call: async (method) => {
          if (method === 'image.attach_bytes') {
            uploadGate.notify();
            return uploadPromise;
          }
          return { status: 'streaming', user_row_id: 777 };
        },
      },
    });
    const service = createTurnExecutionService(deps);
    const sendP = service.sendMessage('bg truncate prompt');
    await uploadGate.promise;

    state.activeSessionId = 'sess-other';
    state.isStreaming = false;
    state.messages = otherMessages;
    state.hasOlderMessages = true;

    releaseUpload({ ok: true, id: 'att-bg-1' });
    await sendP;
    service.disarmTurnWatchdog(true);

    const s1Cache = deps.getSessionMessagesCache().get('sess-1') || [];
    assert.equal(s1Cache.some((m) => m.rowId === 88), true);
    assert.equal(state.hasOlderMessages, true, '后台 truncate 完成不得修改已切换新会话的 hasOlderMessages');
    assert.equal(deps.getSessionHistoryTrust().get('sess-1'), 'server-priority');
    assert.equal(cacheService.truncated.length, 1);
  }

  // 3. 切走会话后后台 truncateAndSubmit 失败：清理 sess-1 运行态与看门狗、恢复 sess-1 缓存快照，不覆写新会话
  {
    let releaseUpload;
    const uploadGate = createGate();
    const uploadPromise = new Promise((resolve) => {
      releaseUpload = resolve;
    });
    const origSnap = [{ id: 'snap-orig-2', role: 'user', content: 'orig 2' }];
    const otherMessages = [{ id: 'other-stay', role: 'user', content: 'stay' }];
    const { deps, state } = createMockTurnDeps({
      state: {
        activeSessionId: 'sess-1',
        activeFocus: { type: 'bot', botName: 'default' },
        rollbackArmed: {
          sessionId: 'sess-1',
          anchor: { kind: 'row', rowId: 12 },
          snapshot: origSnap,
        },
        attachments: [
          {
            id: 'att-bg-2',
            name: 'shot2.png',
            type: 'image',
            previewUrl: 'data:image/png;base64,QUJD',
          },
        ],
      },
      gatewayClient: {
        call: async (method) => {
          if (method === 'image.attach_bytes') {
            uploadGate.notify();
            return uploadPromise;
          }
          return {};
        },
      },
    });
    deps.getInteractiveService().truncateAndSubmit = async () => {
      throw new Error('bg fail');
    };
    const service = createTurnExecutionService(deps);
    const sendP = service.sendMessage('bg fail prompt');
    await uploadGate.promise;

    state.activeSessionId = 'sess-other';
    state.isStreaming = false;
    state.messages = otherMessages;
    state.dockNotice = '';

    releaseUpload({ ok: true, id: 'att-bg-2' });
    await sendP;

    assert.equal(deps.getActiveRunningSessionIds().has('sess-1'), false);
    assert.equal(deps.getActiveRunningBotNames().has('default'), false);
    assert.equal(deps.getActiveStreamingContext().activeStreamingMessageId, null);
    assert.equal(state.messages, otherMessages, '后台失败恢复不得覆写当前聚焦会话的消息列表');
    assert.equal(state.dockNotice, '', '后台失败不得向非聚焦会话弹出回滚失败横幅');
    assert.deepEqual(deps.getSessionMessagesCache().get('sess-1'), origSnap);
  }

  // 4. 同会话未切走时 truncateAndSubmit 成功须清空 state.hasOlderMessages，以及 status 非 streaming/queued 触发 failSubmittedTurn
  {
    const { deps, state } = createMockTurnDeps({
      state: {
        activeSessionId: 'sess-1',
        hasOlderMessages: true,
        rollbackArmed: {
          sessionId: 'sess-1',
          anchor: { kind: 'row', rowId: 15 },
          snapshot: [{ id: 'snap-focus', role: 'user', content: 'focus' }],
        },
      },
    });
    const service = createTurnExecutionService(deps);
    await service.sendMessage('focused truncate ok');
    assert.equal(state.hasOlderMessages, false);
    assert.equal(deps.getSessionHistoryTrust().get('sess-1'), 'server-priority');
  }

  {
    const { deps, state } = createMockTurnDeps({
      state: {
        activeSessionId: 'sess-1',
        activeFocus: { type: 'bot', botName: 'default' },
      },
      gatewayClient: {
        call: async (method) => {
          if (method === 'prompt.submit') return { status: 'rejected' };
          return {};
        },
      },
    });
    const service = createTurnExecutionService(deps);
    await service.sendMessage('rejected prompt');
    assert.equal(state.isStreaming, false);
    assert.equal(state.presenceTerminal?.kind, 'failed');
    assert.equal(deps.getActiveRunningSessionIds().has('sess-1'), false);
    assert.equal(deps.getActiveRunningBotNames().has('default'), false);
  }

  // 5. 上传期被 Session B 接管：清理旧会话/Bot 运行态并回滚缓存，同时完整保留 B 的上下文与看门狗
  {
    let releaseUpload;
    const uploadGate = createGate();
    const uploadPromise = new Promise((resolve) => {
      releaseUpload = resolve;
    });
    const origSnap = [{ id: 'snap-sup', role: 'user', content: 'sup orig' }];
    const { deps, state } = createMockTurnDeps({
      state: {
        activeSessionId: 'sess-a',
        activeFocus: { type: 'bot', botName: 'bot-a' },
        sessions: [{ id: 'sess-a', title: 'A', botName: 'bot-a', preview: '', timestamp: 1 }],
        rollbackArmed: { sessionId: 'sess-a', anchor: { kind: 'row', rowId: 5 }, snapshot: origSnap },
        attachments: [{ id: 'att-s1', name: 'a.png', type: 'image', previewUrl: 'data:image/png;base64,QUJD' }],
      },
      gatewayClient: {
        call: async (method) => {
          if (method === 'image.attach_bytes') {
            uploadGate.notify();
            return uploadPromise;
          }
          return {};
        },
      },
    });
    const service = createTurnExecutionService(deps);
    const sendP = service.sendMessage('sup upload');
    await uploadGate.promise;

    // Session B 覆盖活跃流式上下文，A 仍持有 sess-a & bot-a 归属 -> 仅清理 A 并回滚 sess-a 缓存
    state.activeSessionId = 'sess-b';
    deps.setActiveStreamingContext({
      activeStreamingMessageId: 'ast-b',
      activeStreamingStoredSessionId: 'sess-b',
      activeStreamingLiveId: 'live-b',
      activeStreamingBotName: 'bot-b',
    });
    deps.getActiveRunningSessionIds().add('sess-b');

    releaseUpload({ ok: true });
    await sendP;

    assert.equal(deps.getActiveRunningSessionIds().has('sess-a'), false);
    assert.equal(deps.getActiveRunningBotNames().has('bot-a'), false);
    assert.equal(deps.getActiveStreamingContext().activeStreamingMessageId, 'ast-b', '不得误清 B 的流式上下文');
    assert.equal(deps.getActiveRunningSessionIds().has('sess-b'), true);
    assert.deepEqual(deps.getSessionMessagesCache().get('sess-a'), origSnap);
  }

  // 5a. bot-only 接管场景：sess-a 已不在 activeRunningSessionIds 而 bot-a 仍归属本轮 -> 只清 bot-a，不覆写 sess-a 缓存
  {
    let releaseUpload;
    const uploadGate = createGate();
    const origSnap = [{ id: 'snap-bo', role: 'user', content: 'bo orig' }];
    const customCache = [{ id: 'keep-me', role: 'user', content: 'keep' }];
    const { deps } = createMockTurnDeps({
      state: {
        activeSessionId: 'sess-bo',
        activeFocus: { type: 'bot', botName: 'bot-bo' },
        rollbackArmed: { sessionId: 'sess-bo', anchor: { kind: 'row', rowId: 6 }, snapshot: origSnap },
        attachments: [{ id: 'att-bo', name: 'bo.png', type: 'image', previewUrl: 'data:image/png;base64,QUJD' }],
      },
      gatewayClient: {
        call: async (method) => {
          if (method === 'image.attach_bytes') {
            uploadGate.notify();
            return new Promise((r) => { releaseUpload = r; });
          }
          return {};
        },
      },
    });
    const service = createTurnExecutionService(deps);
    const sendP = service.sendMessage('bot only sup');
    await uploadGate.promise;

    deps.setActiveStreamingContext({ activeStreamingMessageId: 'ast-other' });
    deps.getActiveRunningSessionIds().delete('sess-bo');
    deps.getSessionMessagesCache().set('sess-bo', customCache);

    releaseUpload({ ok: true });
    await sendP;

    assert.equal(deps.getActiveRunningBotNames().has('bot-bo'), false);
    assert.equal(deps.getSessionMessagesCache().get('sess-bo'), customCache);
  }

  // 6. prompt.submit / truncateAndSubmit 在途时发生 disconnect / superseded 隔离保护
  // 6a. disconnect 后迟到 resolve 与 reject 均不得写入状态、缓存或误触发 failSubmittedTurn
  for (const outcome of ['resolve', 'reject']) {
    let resolveRpc;
    let rejectRpc;
    const rpcGate = createGate();
    const rpcPromise = new Promise((resolve, reject) => {
      resolveRpc = resolve;
      rejectRpc = reject;
    });
    let currentClient = {
      call: async (method) => {
        if (method === 'prompt.submit') {
          rpcGate.notify();
          return rpcPromise;
        }
        return {};
      },
    };
    const { deps, state } = createMockTurnDeps({
      state: { activeSessionId: 'sess-1' },
    });
    deps.getGatewayClient = () => currentClient;
    const service = createTurnExecutionService(deps);
    const p = service.sendMessage('disc mid rpc');
    await rpcGate.promise;

    currentClient = null;
    state.presenceTerminal = undefined;
    if (outcome === 'resolve') {
      resolveRpc({ status: 'streaming', user_row_id: 919 });
    } else {
      rejectRpc(new Error('Client disconnected'));
    }
    await p;
    service.disarmTurnWatchdog(true);
    assert.equal(state.presenceTerminal, undefined);
    assert.equal(deps.getSessionMessagesCache().get('sess-1')?.some((m) => m.rowId === 919), false);
  }

  // 6c. Session B 接管后 Session A prompt.submit 迟到 reject：清理 A 运行态但保留 B 的 activeStreamingContext
  {
    let rejectSup;
    const supGate = createGate();
    const supPromise = new Promise((_res, rej) => {
      rejectSup = rej;
    });
    const { deps, state } = createMockTurnDeps({
      state: {
        activeSessionId: 'sess-a',
        activeFocus: { type: 'bot', botName: 'bot-a' },
      },
      gatewayClient: {
        call: async () => {
          supGate.notify();
          return supPromise;
        },
      },
    });
    const service = createTurnExecutionService(deps);
    const p = service.sendMessage('sup mid rpc reject');
    await supGate.promise;

    state.activeSessionId = 'sess-b';
    deps.setActiveStreamingContext({
      activeStreamingMessageId: 'ast-b2',
      activeStreamingStoredSessionId: 'sess-b',
      activeStreamingLiveId: 'live-b2',
      activeStreamingBotName: 'bot-b',
    });
    rejectSup(new Error('late sup fail'));
    await p;

    assert.equal(deps.getActiveRunningSessionIds().has('sess-a'), false);
    assert.equal(deps.getActiveRunningBotNames().has('bot-a'), false);
    assert.equal(deps.getActiveStreamingContext().activeStreamingMessageId, 'ast-b2');
  }

  // 6d. 提交瞬间锁定 submittedProfileName + session.botName / profileName / 'default' 全回退分支 + empty targetStoredSessionId
  for (const caseSpec of [
    { sessionBot: 'sess-bot', stateProf: 'fallback-prof', expected: 'sess-bot' },
    { sessionBot: '', stateProf: '', expected: 'default' },
  ]) {
    const { deps, state, cacheService } = createMockTurnDeps({
      state: {
        activeSessionId: 'sess-prof',
        profileName: caseSpec.stateProf,
        activeFocus: { type: 'session', sessionId: 'sess-prof' },
        sessions: [{ id: 'sess-prof', title: 'P', botName: caseSpec.sessionBot, preview: '', timestamp: 1 }],
        rollbackArmed: {
          sessionId: 'sess-prof',
          anchor: { kind: 'row', rowId: 20 },
          snapshot: [{ id: 'snap-p', role: 'user', content: 'p' }],
        },
      },
    });
    let releaseTrunc;
    const truncGate = createGate();
    deps.getInteractiveService().truncateAndSubmit = () => {
      truncGate.notify();
      return new Promise((res) => {
        releaseTrunc = res;
      });
    };
    const service = createTurnExecutionService(deps);
    const p = service.sendMessage('profile lock');
    await truncGate.promise;

    // 等待期间外部切走 profileName，cacheService.truncate 仍须收到提交期锁定的 profile
    state.profileName = 'mutated-other-profile';
    releaseTrunc({ status: 'streaming', user_row_id: 300 });
    await p;
    service.disarmTurnWatchdog(true);
    assert.equal(cacheService.truncated[0]?.ref.profile, caseSpec.expected);
  }

  {
    const { deps, state } = createMockTurnDeps({
      state: { activeSessionId: '', profileName: 'prof-no-sess' },
      gatewayClient: { call: async () => ({ status: 'rejected' }) },
    });
    const service = createTurnExecutionService(deps);
    await service.sendMessage('no session id');
    assert.equal(state.isStreaming, false);
  }

  // 7. 同毫秒连续触发两次 sendMessage：单调序列保障 userMsgId / assistantMsgId 严格唯一
  await t.test('7. 同毫秒连续触发两次 sendMessage：单调序列保障 userMsgId / assistantMsgId 严格唯一', async (st) => {
    st.mock.timers.enable({ apis: ['Date'], now: 1_700_000_000_000 });
    let service;
    try {
      const { deps, state } = createMockTurnDeps({
        state: { activeSessionId: 'sess-1' },
      });
      service = createTurnExecutionService(deps);
      await service.sendMessage('same-ms-1');
      const ctx1 = deps.getActiveStreamingContext().activeStreamingMessageId;
      state.activeSessionId = 'sess-2';
      state.isStreaming = false;
      await service.sendMessage('same-ms-2');
      const ctx2 = deps.getActiveStreamingContext().activeStreamingMessageId;
      assert.notEqual(ctx1, ctx2);
      const usrIds = state.messages.filter((m) => m.id.startsWith('usr-1700000000000-')).map((m) => m.id);
      assert.equal(new Set(usrIds).size, 2);
    } finally {
      service?.disarmTurnWatchdog(true);
      st.mock.timers.reset();
    }
  });

  // 10. truncateAndSubmit 返回 rejected 状态时严禁调用 cacheService.truncate 或写入 trust，须完整回滚状态
  {
    const origSnap = [{ id: 'snap-rej', role: 'user', content: 'rej orig' }];
    const { deps, state, cacheService } = createMockTurnDeps({
      state: {
        activeSessionId: 'sess-rej-trunc',
        hasOlderMessages: true,
        rollbackArmed: { sessionId: 'sess-rej-trunc', anchor: { kind: 'row', rowId: 30 }, snapshot: origSnap },
      },
    });
    deps.getInteractiveService().truncateAndSubmit = async () => ({ status: 'rejected', user_row_id: 404 });
    const service = createTurnExecutionService(deps);
    await service.sendMessage('rejected truncate');

    assert.equal(cacheService.truncated.length, 0, 'rejected 状态绝不能持久化截断 cacheService');
    assert.equal(deps.getSessionHistoryTrust().has('sess-rej-trunc'), false);
    assert.equal(state.hasOlderMessages, true);
    assert.deepEqual(state.messages, origSnap);
  }

  // 11. ensureLiveSessionId 途中断连/换网关 -> 安全早退；多文件上传期间 profile 锁定与空 profile 透传 undefined
  {
    let releaseLive;
    const liveGate = createGate();
    let currentClient = { call: async () => ({ status: 'streaming' }) };
    const { deps, state } = createMockTurnDeps({
      state: { activeSessionId: 'sess-live-disc', messages: [] },
    });
    deps.getGatewayClient = () => currentClient;
    deps.ensureLiveSessionId = () => {
      liveGate.notify();
      return new Promise((res) => {
        releaseLive = res;
      });
    };
    const service = createTurnExecutionService(deps);
    const p = service.sendMessage('abort during ensureLive');
    await liveGate.promise;
    currentClient = null;
    releaseLive('live-x');
    await p;
    assert.equal(state.isStreaming, false);
    assert.equal(state.messages.length, 0);
  }

  for (const profSpec of [
    { initialProfile: 'frozen-prof', expectedProfile: 'frozen-prof' },
    { initialProfile: '', expectedProfile: undefined },
  ]) {
    const fileAttachProfiles = [];
    let releaseFirstAttach;
    const firstAttachGate = createGate();
    let attachCount = 0;
    const { deps, state } = createMockTurnDeps({
      state: {
        activeSessionId: 'sess-fa',
        profileName: profSpec.initialProfile,
        sessions: [{ id: 'sess-fa', title: 'FA', botName: '', preview: '', timestamp: 1 }],
        attachments: [
          { id: 'f1', name: 'a.txt', type: 'file', contentBase64: 'YQ==' },
          { id: 'f2', name: 'b.txt', type: 'file', contentBase64: 'Yg==' },
        ],
      },
      gatewayClient: {
        call: async (method, params) => {
          if (method === 'file.attach') {
            fileAttachProfiles.push(params.profile);
            attachCount += 1;
            if (attachCount === 1) {
              firstAttachGate.notify();
              return new Promise((res) => {
                releaseFirstAttach = res;
              });
            }
          }
          return { status: 'streaming' };
        },
      },
    });
    const service = createTurnExecutionService(deps);
    const p = service.sendMessage('multi file profile');
    await firstAttachGate.promise;
    state.profileName = 'drifted-later';
    releaseFirstAttach({ ok: true });
    await p;
    service.disarmTurnWatchdog(true);
    assert.deepEqual(fileAttachProfiles, [profSpec.expectedProfile, profSpec.expectedProfile]);
  }
});

test('D5: turnExecutionService - sendMessage 截断失败时原子恢复快照', async () => {
  const { deps, state, interactiveService } = createMockTurnDeps({
    state: {
      rollbackArmed: {
        sessionId: 'sess-1',
        anchor: { kind: 'row', rowId: 10 },
        snapshot: [
          { id: 'snap-1', role: 'user', content: '原提问' },
          { id: 'snap-2', role: 'assistant', content: '原回答' },
        ],
      },
    },
  });
  interactiveService.truncateAndSubmit = async () => {
    throw new Error('截断失败 502');
  };

  const service = createTurnExecutionService(deps);
  await service.sendMessage('重试发言');

  assert.equal(state.isStreaming, false);
  assert.equal(state.presenceTerminal?.kind, 'failed');
  assert.equal(state.messages.length, 2, '截断失败必须原子恢复快照，杜绝静默丢消息');
  assert.equal(state.messages[0].content, '原提问');
});

test('TurnExecutionService: 并发提交 queued / steered / redirected 占位撤下与队列去重', async (t) => {
  await t.test('并发提交收到 queued / steered 时撤下本地空助手占位泡并触发远端对账，queued 将用户消息转入队列胶囊', async () => {
    const raceCallbacks = [];
    let mode = 'queued';
    const raceClient = {
      call: async (method) => {
        if (method === 'prompt.submit') {
          if (mode === 'queued') return { status: 'queued', admission_id: 'adm-race-1' };
          return { status: 'steered', user_row_id: 77 };
        }
        return {};
      },
    };
    const { deps, state } = createMockTurnDeps({ gatewayClient: raceClient });
    deps.onQueuedSubmitRace = (sid) => raceCallbacks.push(sid);
    state.messages = [];
    state.queuedMessages = [];

    const svc = createTurnExecutionService(deps);
    await svc.sendMessage('desktop prompt');
    assert.equal(state.messages.length, 0, 'queued 竞态必须同时撤下本地用户泡与空助手泡');
    assert.deepEqual(state.queuedMessages, [{ id: 'adm-race-1', admissionId: 'adm-race-1', text: 'desktop prompt' }]);
    assert.deepEqual(raceCallbacks, ['sess-1']);

    mode = 'steered';
    await svc.sendMessage('steer msg');
    assert.equal(state.messages.filter((m) => m.role === 'user').length, 1, 'steered 竞态保留已绑定 rowId 的用户泡');
    assert.equal(state.messages.filter((m) => m.role === 'assistant').length, 0, 'steered 竞态必须撤下本地空助手占位泡');
    assert.deepEqual(raceCallbacks, ['sess-1', 'sess-1']);
  });

  // ForeverChat prompt.submit 收到 redirected 时撤下空占位泡并触发 onQueuedSubmitRace
  {
    const reg = new LiveStreamRegistry();
    const queuedRaceCalls = [];
    const { deps, state } = createMockTurnDeps({
      state: {
        activeSessionId: 'sess-old',
        activeLiveSessionId: 'live-old',
        activeFocus: { type: 'bot', botName: 'arch-bot' },
        sessions: [{ id: 'sess-old', title: 'Old', botName: 'arch-bot' }],
        isStreaming: false,
      },
      gatewayClient: {
        call: async (method) => {
          if (method === 'prompt.submit') {
            return { status: 'redirected', session_id: 'sess-old' };
          }
          return {};
        },
      },
    });
    deps.getLiveStreamRegistry = () => reg;
    deps.onQueuedSubmitRace = (sid) => { queuedRaceCalls.push(sid); };

    const svc = createTurnExecutionService(deps);
    await svc.sendMessage('并发重定向测试');
    assert.deepEqual(queuedRaceCalls, ['sess-old']);
    assert.equal(state.messages.some((m) => m.role === 'assistant' && m.content === ''), false);
  }

  // isQueuedRace 无 admission_id、无 queuedMessages 且去重 (L1157-1158)
  {
    let submitResponse = { status: 'queued', text: 'q' };
    const { deps, state } = createMockTurnDeps({
      gatewayClient: {
        call: async (method) => (method === 'prompt.submit' ? submitResponse : {}),
      },
    });
    const svc = createTurnExecutionService(deps);
    state.activeSessionId = 'sess-1';
    delete state.queuedMessages;
    await svc.sendMessage('hello queued fallback');
    assert.equal(state.queuedMessages.length, 1);
    const fixedId = state.queuedMessages[0].admissionId;
    submitResponse = { status: 'queued', admission_id: fixedId };
    await svc.sendMessage('hello dup');
    assert.equal(state.queuedMessages.length, 1, '同 admissionId 不可重复入队');
  }
});

test('Stage4 提交失败守卫: 存在并发后台 ForeverChat 时 failSubmittedTurn 绝不撤防看门狗', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_700_000_000_000 });
  let svc;
  try {
    const reg = new LiveStreamRegistry();
    const resumeCalls = [];
    const runningBots = new Set(['arch-bot']);
    const { deps, state } = createMockTurnDeps({
      state: {
        profileName: 'default',
        activeSessionId: 'sess-other',
        activeLiveSessionId: 'live-other',
        activeFocus: { type: 'session', sessionId: 'sess-other' },
        sessions: [{ id: 'sess-other', title: 'Other', botName: 'default' }],
        dockNotice: '',
        isStreaming: false,
      },
      gatewayClient: {
        call: async (method, params) => {
          if (method === 'session.resume') {
            resumeCalls.push({ ...params });
            if ('omit_messages' in params || 'profile' in params) {
              throw new Error('Extra inputs are not permitted');
            }
            return { running: false };
          }
          if (method === 'prompt.submit') {
            throw new Error('submit network boom');
          }
          return {};
        },
      },
    });
    reg.registerStream({
      storedSessionId: 'sess-hidden',
      liveSessionId: 'live-hidden',
      messageId: 'ast-hidden',
      botName: 'arch-bot',
      origin: 'remote',
      nowMs: 1000,
    });
    deps.getLiveStreamRegistry = () => reg;
    deps.getActiveRunningBotNames = () => runningBots;
    deps.setActiveStreamingContext({
      activeStreamingStoredSessionId: 'sess-hidden',
      activeStreamingMessageId: 'ast-hidden',
      activeStreamingLiveId: 'live-hidden',
      activeStreamingBotName: 'arch-bot',
    });
    deps.watchdogIdleTimeoutMs = 25;
    deps.watchdogHardLimitMs = 2_000;

    svc = createTurnExecutionService(deps);
    state.dockNotice = '';
    svc.armTurnWatchdog();
    state.activeSessionId = 'sess-other';
    await svc.sendMessage('will fail');
    assert.equal(reg.hasSession('sess-hidden'), true, 'sess-other 提交失败绝不得清除 sess-hidden');

    await advanceTimers(t, 25);
    assert.equal(reg.hasSession('sess-hidden'), false, '并发后台看门狗未被误撤防，到期后正常探活并收敛');
    assert.equal(resumeCalls.length, 3);
  } finally {
    svc?.disarmTurnWatchdog(true);
    t.mock.timers.reset();
  }
});

test('TurnExecutionService: 提交/失败回滚/竞态与游标清理全分支变异消杀 (turnExecutionSubmit)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_700_000_000_000 });
  try {
    // 2. sendMessage 同步锚点/注册流字段/coalescer/scroll/logStream 及 failSubmittedTurn 多流 disarm/ownership/focus 守卫
    {
      const reg = new LiveStreamRegistry();
      const scrollLogs = [];
      const infoLogs = [];
      const pendingScrolls = [];
      const turnStartedHist = [];
      const forgetCalls = [];
      let regEntryAtRpc = null;
      let renderCountAtRpc = 0;
      let submitFn;

      const { deps, state, rendered, tokenCoalescer, activityTransitionTracker, depsRecorded } = createMockTurnDeps({
        state: {
          activeSessionId: 'sess-sub',
          activeLiveSessionId: 'live-sub',
          activeFocus: { type: 'bot', botName: 'sub-bot', sessionId: 'sess-sub' },
          sessions: [{ id: 'sess-sub', title: 'Sub', botName: 'sub-bot', preview: '', timestamp: 1 }],
          messages: [],
          presenceTerminal: { kind: 'failed', message: 'stale' },
        },
        gatewayClient: {
          call: async (method, p) => {
            if (method === 'prompt.submit') {
              regEntryAtRpc = reg.getBySession('sess-sub') ? { ...reg.getBySession('sess-sub') } : null;
              renderCountAtRpc = rendered.length;
              return await submitFn(p);
            }
            return { running: false };
          },
        },
      });
      deps.watchdogIdleTimeoutMs = 25;
      deps.watchdogHardLimitMs = 500;
      deps.getLiveStreamRegistry = () => reg;
      deps.scrollStreamToBottom = (reason) => scrollLogs.push(reason);
      deps.setPendingScrollToBottom = (v) => pendingScrolls.push(v);
      const origSetTurnStarted = deps.setTurnStartedSessionId;
      deps.setTurnStartedSessionId = (id) => { turnStartedHist.push(id); origSetTurnStarted(id); };
      deps.forgetOlderCursorState = (sid) => forgetCalls.push(sid);
      deps.logStream = { info: (msg, meta) => infoLogs.push({ msg, meta }), warn: () => {}, debug: () => {} };

      const svc = createTurnExecutionService(deps);
      try {
        // 2a) 同步锚点 + armedRowId=null 不触发 cursor reset + 非法 user_row_id 不写 rowId
        tokenCoalescer.flushed = false;
        tokenCoalescer.cleared = false;
        submitFn = async () => ({ status: 'streaming', user_row_id: 0 });
        await svc.sendMessage('exact length check');
        assert.equal(regEntryAtRpc?.origin, 'local');
        assert.equal(regEntryAtRpc?.userMessageSynced, true);
        assert.ok(regEntryAtRpc?.startedAt > 0);
        assert.equal(depsRecorded.userExpandedState, false);
        assert.equal(depsRecorded.ensuredWindowTotal, 2);
        assert.deepEqual(turnStartedHist, ['sess-sub']);
        assert.equal(state.presenceTerminal, undefined, '发消息前必须 clearPresenceTerminal()');
        assert.equal(tokenCoalescer.flushed, true);
        assert.equal(tokenCoalescer.cleared, true);
        assert.deepEqual(pendingScrolls, [true]);
        assert.ok(renderCountAtRpc >= 1, 'sendMessage 必须在 RPC 返回前同步执行 render()');
        assert.deepEqual(scrollLogs, ['message sent']);
        assert.deepEqual(infoLogs[0], { msg: 'turn started', meta: { session: 'live-sub', chars: 'exact length check'.length } });
        assert.equal(forgetCalls.length, 0, '未武装回滚时不应重置历史游标');
        assert.equal(deps.getSessionHistoryTrust().get('sess-sub'), undefined);
        const userM = state.messages.find((m) => m.role === 'user');
        assert.equal(userM.rowId, undefined, 'user_row_id <= 0 时不得赋值 rowId');
        reg.removeSession('sess-sub');
        state.isStreaming = false;
        deps.setActiveStreamingContext({ activeStreamingStoredSessionId: null, activeStreamingMessageId: null, activeStreamingBotName: null });

        // 2b) failSubmittedTurn: rejected status 传 exact args + isFocused=false 时不误关前台 + 仍有 bg 流时不 disarm；无流时真 disarm
        reg.registerStream({ storedSessionId: 'sess-bg-alive', liveSessionId: 'l-bg', messageId: 'm-bg', origin: 'remote' });
        let rejectHeld;
        const rpcGate1 = createGate();
        submitFn = () => {
          rpcGate1.notify();
          return new Promise((_, rej) => { rejectHeld = rej; });
        };
        const bgPending = svc.sendMessage('bg fail');
        await rpcGate1.promise;
        state.activeSessionId = 'sess-other-ui';
        state.isStreaming = true;
        state.presenceTerminal = undefined;
        activityTransitionTracker.cleared.length = 0;
        rejectHeld(new Error('bg boom'));
        await bgPending;
        assert.equal(state.isStreaming, true, '非聚焦会话提交失败不得关闭前台 isStreaming');
        assert.equal(state.presenceTerminal, undefined, '非聚焦会话提交失败不得覆写前台 presenceTerminal');
        assert.ok(activityTransitionTracker.cleared.some((x) => x.domain === 'session' && x.id === 'sess-sub'));
        assert.ok(activityTransitionTracker.cleared.some((x) => x.domain === 'bot' && x.id === 'sub-bot'));
        // 尚有 sess-bg-alive 时看门狗不得被 disarm（仍在运行，等待会发射探活）
        let bgProbed = false;
        const origCall = deps.getGatewayClient().call;
        deps.getGatewayClient().call = async (m, p) => {
          if (m === 'session.resume') bgProbed = true;
          return origCall(m, p);
        };
        await advanceTimers(t, 25);
        assert.equal(bgProbed, true, 'reg 非空时提交失败不得 disarm 看门狗');
        reg.removeSession('sess-bg-alive');

        // 现聚焦 sess-sub 且无其它流，rejected status -> 调用 failSubmittedTurn 并真正 disarm
        state.activeSessionId = 'sess-sub';
        state.activeFocus = { type: 'session', sessionId: 'sess-sub' };
        state.isStreaming = false;
        deps.setActiveStreamingContext({ activeStreamingStoredSessionId: null, activeStreamingMessageId: null, activeStreamingBotName: null });
        activityTransitionTracker.cleared.length = 0;
        bgProbed = false;
        submitFn = async () => ({ status: 'rejected_quota' });
        await svc.sendMessage('rejected status');
        assert.ok(state.messages.at(-1).content.includes('chat.gatewayNotAccepted{"status":"rejected_quota"}'));
        assert.equal(state.presenceTerminal?.message, 'status=rejected_quota');
        assert.equal(activityTransitionTracker.cleared.some((x) => x.domain === 'bot'), false, '无 focusBotName 时不得误清 bot tracker');
        // 若 failSubmittedTurn 漏掉 disarmTurnWatchdog()，在无重武装前提下把 isStreaming 置 true，残留定时器将误探测
        state.activeSessionId = 'sess-stale-after-reject';
        state.isStreaming = true;
        await advanceTimers(t, 25);
        state.isStreaming = false;
        state.activeSessionId = 'sess-sub';
        assert.equal(bgProbed, false, 'reg 为空且 ownsStreamCtx 时 failSubmittedTurn 必须 disarm 看门狗');

        // ownedSessionId='' 但 ownedBotName 非空时不得误调 tracker.clear('session', '') 或 removeSession('')
        state.activeFocus = { type: 'bot', botName: 'sub-bot', sessionId: 'sess-sub' };
        state.isStreaming = false;
        deps.setActiveStreamingContext({ activeStreamingStoredSessionId: null, activeStreamingMessageId: null, activeStreamingBotName: null });
        const removedCalls = [];
        const origRemove = reg.removeSession.bind(reg);
        reg.removeSession = (sid) => { removedCalls.push(sid); return origRemove(sid); };
        activityTransitionTracker.cleared.length = 0;
        let holdFail;
        const rpcGate2 = createGate();
        submitFn = () => {
          rpcGate2.notify();
          return new Promise((_, rej) => { holdFail = rej; });
        };
        const pNoOwnSid = svc.sendMessage('lose sess own');
        await rpcGate2.promise;
        activityTransitionTracker.cleared.length = 0;
        deps.getActiveRunningSessionIds().delete('sess-sub'); // 使 getOwnedSessionId 返回 ''
        deps.setActiveStreamingContext({ activeStreamingMessageId: 'someone-else' }); // 使 ownsStreamCtx=false, 仅 ownedBotName='sub-bot' 为真
        holdFail(new Error('only bot owned'));
        await pNoOwnSid;
        assert.equal(removedCalls.includes(''), false);
        assert.equal(activityTransitionTracker.cleared.some((x) => x.domain === 'session'), false);
        assert.equal(activityTransitionTracker.cleared.some((x) => x.domain === 'bot' && x.id === 'sub-bot'), true);
        reg.removeSession = origRemove;
      } finally {
        svc.disarmTurnWatchdog(true);
      }
    }

    // 3. submitResult user_row_id 双更新 + redirected/queued 并发竞态（含 remoteStream 共存、background 残留不 disarm、admissionId 兜底、onQueuedSubmitRace）
    {
      const reg = new LiveStreamRegistry();
      let mode = 'row-bind';
      const onRaceCalls = [];
      const turnStartedCalls = [];
      let remoteWatchdogProbeCount = 0;
      let rendersAtRpc = 0;
      const { deps, state, rendered, activityTransitionTracker } = createMockTurnDeps({
        state: {
          activeSessionId: 'sess-race',
          activeLiveSessionId: 'live-race',
          activeFocus: { type: 'bot', botName: 'race-bot', sessionId: 'sess-race' },
          sessions: [{ id: 'sess-race', title: 'Race', botName: 'race-bot', preview: '', timestamp: 1 }],
          messages: [],
        },
        gatewayClient: {
          call: async (method) => {
            if (method === 'session.resume') {
              remoteWatchdogProbeCount += 1;
              return { running: false };
            }
            if (method === 'prompt.submit') {
              rendersAtRpc = rendered.length;
              if (mode === 'row-bind') {
                // 模拟在途期间替换一个独立消息对象副本组成的缓存数组，确保 cachedUser.rowId 是独立写入而非共享引用透传
                const cloned = state.messages.map((m) => ({ ...m }));
                cloned.unshift({ id: 'keep-other', role: 'user', content: 'old' });
                deps.getSessionMessagesCache().set('sess-race', cloned);
                return { status: 'streaming', user_row_id: 99 };
              }
              if (mode === 'row-bind-string') {
                return { status: 'streaming', user_row_id: '99' };
              }
              if (mode === 'redirected-with-bg') {
                // 注册独立缓存与后台另一条流
                deps.getSessionMessagesCache().set('sess-race', [...state.messages]);
                reg.registerStream({ storedSessionId: 'sess-bg2', liveSessionId: 'l-bg2', messageId: 'm-bg2', origin: 'remote' });
                return { status: 'redirected' };
              }
              if (mode === 'queued-foreign-stream') {
                // 在途期间远端已先行占位覆盖 registry 与 activeStreamingContext
                activityTransitionTracker.cleared.length = 0;
                deps.getSessionMessagesCache().set('sess-race', [...state.messages]);
                reg.registerStream({ storedSessionId: 'sess-race', liveSessionId: 'live-remote', messageId: 'remote-ast-msg', origin: 'remote', botName: 'race-bot' });
                deps.setActiveStreamingContext({ activeStreamingMessageId: 'remote-ast-msg', activeStreamingStoredSessionId: 'sess-race', activeStreamingLiveId: 'live-remote', activeStreamingBotName: 'race-bot' });
                state.isStreaming = true;
                return { status: 'queued' };
              }
              if (mode === 'queued-empty-reg') {
                return { status: 'queued', admission_id: 'q-second' };
              }
              if (mode === 'queued-bg-noreg') {
                state.activeSessionId = 'sess-foreground-other';
                state.isStreaming = true;
                return { status: 'queued', admission_id: 'q-second' };
              }
            }
            return {};
          },
        },
      });
      deps.watchdogIdleTimeoutMs = 25;
      deps.watchdogHardLimitMs = 500;
      deps.getLiveStreamRegistry = () => reg;
      deps.onQueuedSubmitRace = (sid) => onRaceCalls.push(sid);
      const origSetTurnStarted = deps.setTurnStartedSessionId;
      deps.setTurnStartedSessionId = (id) => { turnStartedCalls.push(id); origSetTurnStarted(id); };

      const svc = createTurnExecutionService(deps);
      try {
        // 3a) user_row_id=99 同时写进 state.messages 与独立 cachedUser（不影响 keep-other），非 number string '99' 不得误写 rowId
        await svc.sendMessage('bind row');
        const u1 = state.messages.find((m) => m.role === 'user' && m.content === 'bind row');
        assert.equal(u1.rowId, 99);
        const cachedArr = deps.getSessionMessagesCache().get('sess-race');
        assert.equal(cachedArr.find((m) => m.id === u1.id).rowId, 99);
        assert.equal(cachedArr.find((m) => m.id === 'keep-other').rowId, undefined);
        reg.removeSession('sess-race');
        state.isStreaming = false;
        deps.setActiveStreamingContext({ activeStreamingStoredSessionId: null, activeStreamingMessageId: null, activeStreamingBotName: null });

        mode = 'row-bind-string';
        state.messages = [];
        await svc.sendMessage('string row id');
        assert.equal(state.messages.find((m) => m.role === 'user')?.rowId, undefined, '非 number 的 user_row_id 不得赋值');
        reg.removeSession('sess-race');
        state.isStreaming = false;
        state.messages = [];
        deps.setActiveStreamingContext({ activeStreamingStoredSessionId: null, activeStreamingMessageId: null, activeStreamingBotName: null });

        // 3b) redirected: 仅撤 assistant 占位，保留 user 气泡；清 race-bot tracker 与 isStreaming，但后台仍有 sess-bg2 故不得 disarm
        onRaceCalls.length = 0;
        turnStartedCalls.length = 0;
        activityTransitionTracker.cleared.length = 0;
        mode = 'redirected-with-bg';
        await svc.sendMessage('redir prompt');
        assert.equal(state.messages.some((m) => m.content === 'redir prompt'), true, 'redirected 仅撤除空助手泡，必须保留用户消息');
        assert.equal(state.messages.filter((m) => m.role === 'assistant' && m.content === '').length, 0);
        assert.equal(deps.getSessionMessagesCache().get('sess-race').filter((m) => m.role === 'assistant' && m.content === '').length, 0);
        assert.equal(deps.getActiveRunningBotNames().has('race-bot'), false);
        assert.equal(
          activityTransitionTracker.cleared.filter((x) => x.domain === 'bot' && x.id === 'race-bot').length,
          2,
          'sendMessage 起手与 redirected 收口均须精确以 "bot" 清理 transition tracker',
        );
        assert.deepEqual(deps.getActiveStreamingContext(), {
          activeStreamingMessageId: null,
          activeStreamingStoredSessionId: null,
          activeStreamingLiveId: null,
          activeStreamingBotName: null,
        });
        assert.equal(state.isStreaming, false);
        assert.equal(state.turnStartedAt, undefined);
        assert.equal(turnStartedCalls.at(-1), null);
        assert.ok(rendered.length > rendersAtRpc, 'redirected 分支收口后必须调用 deps.render()');
        assert.deepEqual(onRaceCalls, ['sess-race']);
        // 后台 sess-bg2 仍在 -> 看门狗未 disarm -> 25ms 后触发探测
        remoteWatchdogProbeCount = 0;
        await advanceTimers(t, 25);
        assert.ok(remoteWatchdogProbeCount >= 1, 'redirected 清理本地占位但仍有后台流时不得 disarm 看门狗');
        reg.removeSession('sess-bg2');

        // 3c) queued-foreign-stream: 在途被远端占位流接管时，不可误删远端 stream、不可清 bot/isStreaming/turnStarted/activeCtx
        mode = 'queued-foreign-stream';
        turnStartedCalls.length = 0;
        activityTransitionTracker.cleared.length = 0;
        onRaceCalls.length = 0;
        await svc.sendMessage('queued with remote active');
        assert.equal(reg.getBySession('sess-race')?.messageId, 'remote-ast-msg', '远端占位流不可被 queued 分支误删');
        assert.equal(deps.getActiveRunningBotNames().has('race-bot'), true);
        assert.equal(activityTransitionTracker.cleared.some((x) => x.domain === 'bot'), false);
        assert.equal(deps.getActiveStreamingContext().activeStreamingMessageId, 'remote-ast-msg');
        assert.equal(state.isStreaming, true);
        assert.equal(turnStartedCalls.includes(null), false);
        assert.equal(state.queuedMessages.length, 1);
        assert.ok(state.queuedMessages[0].id.startsWith('queued-'));
        assert.equal(state.queuedMessages[0].id, state.queuedMessages[0].admissionId);
        assert.deepEqual(onRaceCalls, ['sess-race']);
        reg.removeSession('sess-race');
        state.isStreaming = false;
        deps.setActiveStreamingContext({ activeStreamingStoredSessionId: null, activeStreamingMessageId: null, activeStreamingBotName: null });

        // 3d) queued 且无其他流 -> 必须追加不同 admissionId 到 queuedMessages 并彻底 disarm 看门狗
        mode = 'queued-empty-reg';
        await svc.sendMessage('queued empty reg');
        assert.equal(state.queuedMessages.length, 2, '不同 admissionId 的新排队消息必须追加');
        remoteWatchdogProbeCount = 0;
        state.activeSessionId = 'sess-stale-queued';
        state.isStreaming = true;
        await advanceTimers(t, 25);
        state.isStreaming = false;
        state.activeSessionId = 'sess-race';
        assert.equal(remoteWatchdogProbeCount, 0, '最后流触发 queued 且清空本地占位时必须 disarm 看门狗');

        // 3e) 切走会话后后台 queued + 重复 admissionId 不追加 + 无 onQueuedSubmitRace 与 registry 降级
        mode = 'queued-bg-noreg';
        deps.onQueuedSubmitRace = undefined;
        deps.getLiveStreamRegistry = undefined;
        const svcNoRegRace = createTurnExecutionService(deps);
        try {
          await svcNoRegRace.sendMessage('bg queued dup');
          assert.equal(state.isStreaming, true, '非聚焦会话收到 queued 不可清除当前前台 isStreaming');
          assert.equal(state.queuedMessages.length, 2, '相同 admissionId q-second 不可重复入队');
        } finally {
          svcNoRegRace.disarmTurnWatchdog(true);
        }
      } finally {
        svc.disarmTurnWatchdog(true);
      }
    }
  } finally {
    t.mock.timers.reset();
  }
});
