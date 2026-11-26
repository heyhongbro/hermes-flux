/**
 * TurnExecutionService 核心路由、群聊、在场提示、定时通知与附件分发单测
 * (packages/desktop/__tests__/unit/turnExecutionService.core.test.mjs)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createTurnExecutionService } from '../../dist/renderer/services/turnExecutionService.mjs';
import { advanceTimers, createMockTurnDeps } from './helpers/turnExecutionHarness.mjs';

test('D5: turnExecutionService - armPresenceTerminal 与 clearPresenceTerminal 生命周期', () => {
  const { deps, state } = createMockTurnDeps();
  const service = createTurnExecutionService(deps);

  service.armPresenceTerminal({ kind: 'interrupted' });
  assert.equal(state.presenceTerminal?.kind, 'interrupted');

  service.clearPresenceTerminal();
  assert.equal(state.presenceTerminal, undefined);

  service.setTimedDockNotice('通知测试', 0);
  assert.equal(state.dockNotice, '通知测试');
});

test('D5: turnExecutionService - routeSend 分流裁决与 BTW 旁路调用', async () => {
  const { deps, state } = createMockTurnDeps({
    state: {
      activeFocus: { type: 'bot', botName: 'default' },
    },
  });
  const service = createTurnExecutionService(deps);

  // Bot 工位中的 @ 提及分流为 BTW 外援胶囊
  await service.routeSend('@Default Bot 帮我看一眼');
  assert.equal(state.sideAgentCapsules.length, 1);
  assert.equal(state.sideAgentCapsules[0].id, 'task-btw-1');
  assert.equal(state.sideAgentCapsules[0].status, 'pending');

  for (const c of state.sideAgentCapsules) {
    if (c.hintTimer) clearTimeout(c.hintTimer);
    if (c.expireTimer) clearTimeout(c.expireTimer);
  }
});

test('D5: turnExecutionService - sendGroupMessage 严格走 groups.send', async () => {
  const { deps, state, groupRoomStore } = createMockTurnDeps({
    state: {
      activeFocus: { type: 'group', roomId: 'room-1' },
    },
  });
  const service = createTurnExecutionService(deps);

  await service.sendGroupMessage('room-1', '各位 Agent 好');

  assert.equal(groupRoomStore.sent.length, 1);
  assert.equal(groupRoomStore.sent[0].roomId, 'room-1');
  assert.equal(groupRoomStore.sent[0].text, '各位 Agent 好');
  const targetRoom = state.groupRooms.find((r) => r.roomId === 'room-1');
  assert.equal(targetRoom.lastMessage, '各位 Agent 好');

  service.getGroupPollerManager().stopAll();
});

test('D5: turnExecutionService - routeSend 群聊模式零逃逸：严格走 sendGroupMessage，绝不调用 prompt.submit 或新建会话', async () => {
  let promptSubmitCalled = false;
  let createSessionCalled = false;
  const { deps, state, groupRoomStore, interactiveService } = createMockTurnDeps({
    state: {
      activeFocus: { type: 'group', roomId: 'room-alpha' },
      activeSessionId: '',
      activeLiveSessionId: '',
    },
  });
  interactiveService.submitPrompt = async () => { promptSubmitCalled = true; };
  deps.createNewSession = async () => { createSessionCalled = true; };

  const service = createTurnExecutionService(deps);
  await service.routeSend('群聊研讨测试发言');

  assert.equal(groupRoomStore.sent.length, 1);
  assert.equal(groupRoomStore.sent[0].roomId, 'room-alpha');
  assert.equal(groupRoomStore.sent[0].text, '群聊研讨测试发言');
  assert.equal(promptSubmitCalled, false, '群聊消息严禁逃逸至 prompt.submit');
  assert.equal(createSessionCalled, false, '群聊消息严禁触发 createNewSession');
  assert.equal(state.activeSessionId, '', '群聊发送后 activeSessionId 必须保持为空');

  service.getGroupPollerManager().stopAll();
});

test('D5: turnExecutionService - routeSend 群聊焦点丢失显式失败，绝不回退至普通单聊', async () => {
  let promptSubmitCalled = false;
  let createSessionCalled = false;
  const { deps, state, interactiveService } = createMockTurnDeps({
    state: {
      activeFocus: { type: 'group', roomId: '' }, // 群聊焦点但 roomId 丢失/异常
      activeSessionId: '',
    },
  });
  interactiveService.submitPrompt = async () => { promptSubmitCalled = true; };
  deps.createNewSession = async () => { createSessionCalled = true; };

  const service = createTurnExecutionService(deps);
  await service.routeSend('异常群聊文本');

  assert.equal(promptSubmitCalled, false, '焦点失配时严禁逃逸至 prompt.submit');
  assert.equal(createSessionCalled, false, '焦点失配时严禁创建新单聊会话');
  assert.equal(state.dockNotice.includes('group.sendFailed'), true, '必须显式提示群聊发送失败通知');
});

test('D5: turnExecutionService - syncGroupRoomLogsToState 解析群聊用户附件清单且跳过 Assistant 文本', () => {
  const { deps, state } = createMockTurnDeps({
    state: {
      activeFocus: { type: 'group', roomId: 'room-1' },
      messages: [],
    },
  });
  const service = createTurnExecutionService(deps);

  service.syncGroupRoomLogsToState('room-1', [
    {
      messageId: 'gm-1',
      actorKind: 'user',
      senderProfile: 'user',
      text: '[附件列表]\n- Image 1: arch.png\n\n请评审架构图',
      timestamp: 1700000000000,
    },
    {
      messageId: 'gm-2',
      actorKind: 'user',
      senderProfile: 'user',
      text: '纯文字消息',
      timestamp: 1700000001000,
    },
    {
      messageId: 'gm-3',
      actorKind: 'agent',
      senderProfile: 'arch-bot',
      text: '[附件列表]\n- note.md\n\n已收到',
      timestamp: 1700000002000,
    },
  ]);

  assert.equal(state.messages.length, 3);
  assert.equal(state.messages[0].role, 'user');
  assert.equal(state.messages[0].content, '请评审架构图');
  assert.equal(state.messages[0].attachments?.length, 1);
  assert.equal(state.messages[0].attachments?.[0]?.name, 'arch.png');

  assert.equal(state.messages[1].role, 'user');
  assert.equal(state.messages[1].content, '纯文字消息');
  assert.equal(state.messages[1].attachments, undefined);

  assert.equal(state.messages[2].role, 'assistant');
  assert.equal(state.messages[2].content, '[附件列表]\n- note.md\n\n已收到');
  assert.equal(state.messages[2].attachments, undefined);

  // 非聚焦群聊日志不得覆写当前消息流
  service.syncGroupRoomLogsToState('room-other', [{ text: 'ignored' }]);
  assert.equal(state.messages.length, 3);
});

test('D5: turnExecutionService - setTimedDockNotice 定时自动消失、覆盖取消与 durationMs=0 守卫', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_700_000_000_000 });
  try {
    const { deps, state, rendered } = createMockTurnDeps();
    const service = createTurnExecutionService(deps);

    service.setTimedDockNotice('first-notice', 25);
    assert.equal(state.dockNotice, 'first-notice');
    assert.equal(rendered.length, 1);

    // 二次调用替换旧定时，并改写为 40ms
    service.setTimedDockNotice('second-notice', 40);
    await advanceTimers(t, 25);
    assert.equal(state.dockNotice, 'second-notice', '旧定时器必须已被清除，不得误清 second-notice');

    await advanceTimers(t, 14);
    assert.equal(state.dockNotice, 'second-notice', '39ms 时 40ms 定时器不得提前触发');

    await advanceTimers(t, 1);
    assert.equal(state.dockNotice, '', '到期后必须清空 dockNotice');
    assert.ok(rendered.length >= 3, '到期清空后必须触发 render()');

    // 若定时期间外部改写了 dockNotice，旧定时触发时不得误清
    const rendersBefore = rendered.length;
    service.setTimedDockNotice('temp-a', 20);
    state.dockNotice = 'external-override';
    await advanceTimers(t, 20);
    assert.equal(state.dockNotice, 'external-override', '已被外部覆写的 dockNotice 不得被旧定时器清空');
    assert.equal(rendered.length, rendersBefore + 1);

    // 空文案与 durationMs === 0 不排定时
    service.setTimedDockNotice('', 20);
    service.setTimedDockNotice('sticky', 0);
    await advanceTimers(t, 20);
    assert.equal(state.dockNotice, 'sticky');
  } finally {
    t.mock.timers.reset();
  }
});

test('纯附件发送、普通文件 file.attach 上传、图片与文件错误降级及群聊附件送达', async () => {
  const { deps, state, rpcCalls } = createMockTurnDeps({
    gatewayClient: {
      call: async (method, params) => {
        rpcCalls.push({ method, params });
        if (method === 'image.attach_bytes' || method === 'file.attach') {
          throw new Error(`${method} rejected`);
        }
        if (method === 'prompt.submit') {
          return { status: 'streaming', user_row_id: 99 };
        }
        return {};
      },
    },
    state: {
      activeFocus: { type: 'bot', botName: 'default' },
      attachments: [
        {
          id: 'att-img',
          name: 'shot.png',
          type: 'image',
          previewUrl: 'data:image/png;base64,QUJD',
          sizeBytes: 120,
        },
        {
          id: 'att-doc',
          name: 'spec.md',
          type: 'file',
          contentBase64: 'IyBTcGVj',
          sizeBytes: 64,
        },
        {
          id: 'att-pdf',
          name: 'report.pdf',
          type: 'pdf',
          contentBase64: 'data:application/pdf;base64,JVBERg==',
          sizeBytes: 256,
        },
      ],
    },
  });
  const service = createTurnExecutionService(deps);

  // 0. 空文本且无附件直接返回不入队也不报错
  state.attachments = [];
  await service.sendMessage('   ');
  assert.equal(rpcCalls.length, 0);

  // 0b. 注入 logStream 验证 warn/info 分支与后续无 logStream 降级
  deps.logStream = { info() {}, warn() {} };
  state.attachments = [
    { id: 'log-img', name: 'log.png', type: 'image', previewUrl: 'data:image/png;base64,QQ', sizeBytes: 10 },
    { id: 'log-doc', name: 'log.txt', type: 'file', contentBase64: 'QQ', sizeBytes: 10 },
  ];
  await service.sendMessage('with log');
  deps.logStream = undefined;
  rpcCalls.length = 0;
  state.isStreaming = false;
  state.attachments = [
    {
      id: 'att-img',
      name: 'shot.png',
      type: 'image',
      previewUrl: 'data:image/png;base64,QUJD',
      sizeBytes: 120,
    },
    {
      id: 'att-doc',
      name: 'spec.md',
      type: 'file',
      contentBase64: 'IyBTcGVj',
      sizeBytes: 64,
    },
    {
      id: 'att-pdf',
      name: 'report.pdf',
      type: 'pdf',
      contentBase64: 'data:application/pdf;base64,JVBERg==',
      sizeBytes: 256,
    },
  ];
  await service.sendMessage('   ');
  assert.equal(state.attachments.length, 0);
  const pushedUser = state.messages.find((m) => m.role === 'user' && m.attachments?.length === 3);
  assert.ok(pushedUser, '纯附件发送必须保留 userMsg.attachments');
  assert.equal(pushedUser.content, '');
  assert.equal(state.sessions[0].preview, 'shot.png, spec.md, report.pdf');
  assert.equal(rpcCalls.find((c) => c.method === 'image.attach_bytes')?.params.filename, 'shot.png');
  const fileCalls = rpcCalls.filter((c) => c.method === 'file.attach');
  assert.equal(fileCalls.length, 2);
  assert.equal(fileCalls[0].params.data_url, 'data:application/octet-stream;base64,IyBTcGVj');
  assert.equal(fileCalls[1].params.data_url, 'data:application/pdf;base64,JVBERg==');
  assert.ok(
    rpcCalls.find((c) => c.method === 'prompt.submit')?.params.text.includes('- Image 1: shot.png'),
    '发送网关的正文必须含标准附件清单',
  );

  // 2. 群聊模式：纯附件送达 + 空发送阻断 + 文本+附件混合送达
  state.isStreaming = false;
  state.activeFocus = { type: 'group', roomId: 'room-1' };
  state.attachments = [];
  await service.sendGroupMessage('room-1', '   ');

  state.attachments = [
    { id: 'grp-att-1', name: 'diagram.png', type: 'image', previewUrl: 'data:image/png;base64,XYZ', sizeBytes: 42 },
  ];
  await service.sendMessage('   ');
  const grpAttachMsg = state.messages[state.messages.length - 1];
  assert.equal(grpAttachMsg.role, 'user');
  assert.equal(grpAttachMsg.content, '');
  assert.equal(grpAttachMsg.attachments?.[0]?.name, 'diagram.png');
  assert.equal(state.groupRooms[0].lastMessage, 'diagram.png');

  state.attachments = [];
  await service.sendGroupMessage('room-1', 'hello group');
  const grpTextMsg = state.messages[state.messages.length - 1];
  assert.equal(grpTextMsg.role, 'user');
  assert.equal(grpTextMsg.content, 'hello group');
  assert.equal(grpTextMsg.attachments, undefined);
  assert.equal(state.groupRooms[0].lastMessage, 'hello group');
  service.getGroupPollerManager().stopAll();
});
