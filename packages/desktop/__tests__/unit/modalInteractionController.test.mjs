/**
 * 全局模态弹窗与右键菜单交互控制器单元测试（Modal Interaction Controller Test）
 *
 * 【断言】
 *   1. closeConfirmModal('ok') 触发 onConfirm，并先置空 state.confirmModal；
 *   2. closeConfirmModal('cancel') 优先触发 onCancel，无 onCancel 时兜底调用 restoreComposerFocus()；
 *   3. handleGlobalEscape 与 handleGlobalEnter 在有确认弹窗时正确拦截并分发；
 *   4. submitTaskModal 单人模式调用 createNewSession，群聊模式补足成员并调用 createGroupRoom / openGroupRoom；
 *   5. handleContextMenuAction 正确分发各右键指令并弹出危险操作确认；
 *   6. closeContextMenuIfClickedOutside 在菜单外部点击时关闭菜单。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ModalInteractionController,
  createModalInteractionController,
} from '../../dist/renderer/events/modalInteractionController.mjs';

function createMockState(overrides = {}) {
  return {
    confirmModal: undefined,
    isNewTaskModalOpen: true,
    newTaskModalTab: 'solo',
    profileName: 'agent-alice',
    sessionContextMenu: undefined,
    editingGroupRoomId: undefined,
    dockNotice: '',
    sessions: [
      { id: 'sess-1', title: 'Session 1' },
      { id: 'sess-2', title: 'Session 2' },
    ],
    activeFocus: { type: 'session', sessionId: 'sess-1' },
    ...overrides,
  };
}

function createMockDeps(stateOverrides = {}, overrides = {}) {
  let currentState = createMockState(stateOverrides);
  const calls = {
    render: 0,
    restoreFocus: 0,
    newSession: [],
    deleteSession: [],
    renameSession: [],
    pinSession: [],
    archiveSession: [],
    exportMarkdown: [],
    copySessionId: [],
    openBotChat: [],
    openBotSettings: [],
    openGroupRoom: [],
    createGroupRoom: [],
    disbandGroupRoom: [],
    fetchGroupRooms: 0,
    routeSend: [],
    sendGroupMessage: [],
  };

  const deps = {
    getState: () => currentState,
    commitState: (patch) => {
      currentState = { ...currentState, ...patch };
    },
    requestRender: () => {
      calls.render++;
    },
    restoreComposerFocus: () => {
      calls.restoreFocus++;
    },
    createNewSession: async (options) => {
      calls.newSession.push(options);
      return overrides.createNewSessionResult === undefined ? 'sess-new-1' : overrides.createNewSessionResult;
    },
    deleteSession: async (id) => {
      calls.deleteSession.push(id);
    },
    renameSession: async (id, title) => {
      calls.renameSession.push({ id, title });
    },
    pinSession: async (id) => {
      calls.pinSession.push(id);
    },
    archiveSession: async (id) => {
      calls.archiveSession.push(id);
    },
    exportMarkdown: async (id) => {
      calls.exportMarkdown.push(id);
    },
    copySessionId: async (id) => {
      calls.copySessionId.push(id);
    },
    openBotChat: (profile) => {
      calls.openBotChat.push(profile);
    },
    openBotSettings: (profile) => {
      calls.openBotSettings.push(profile);
    },
    openGroupRoom: async (roomId) => {
      calls.openGroupRoom.push(roomId);
    },
    createGroupRoom: async (title, members) => {
      calls.createGroupRoom.push({ title, members });
      return overrides.createGroupRoomResult === undefined ? { room_id: 'room-new-123' } : overrides.createGroupRoomResult;
    },
    disbandGroupRoom: async (roomId) => {
      calls.disbandGroupRoom.push(roomId);
    },
    fetchGroupRooms: async () => {
      calls.fetchGroupRooms++;
    },
    routeSend: async (text) => {
      calls.routeSend.push(text);
    },
    sendGroupMessage: async (roomId, text) => {
      calls.sendGroupMessage.push({ roomId, text });
    },
    t: (key, params) => `${key}:${JSON.stringify(params || {})}`,
  };

  return { deps, calls, getState: () => currentState };
}

test('ModalInteractionController 领域行为测试', async (t) => {
  await t.test('1. closeConfirmModal("ok") 触发 onConfirm 并先清空弹窗状态', async () => {
    let confirmCalled = false;
    let stateAtConfirm = null;
    const { deps, calls, getState } = createMockDeps({
      confirmModal: {
        title: 'Delete?',
        message: 'Are you sure?',
        onConfirm: () => {
          confirmCalled = true;
          stateAtConfirm = getState().confirmModal;
        },
      },
    });

    const controller = createModalInteractionController(deps);
    controller.closeConfirmModal('ok');

    assert.equal(confirmCalled, true);
    assert.equal(stateAtConfirm, undefined, '确认回调执行时 confirmModal 必须已经清空');
    assert.equal(getState().confirmModal, undefined);
    assert.equal(calls.render, 1);
  });

  await t.test('2. closeConfirmModal("cancel") 触发 onCancel 或兜底 restoreComposerFocus', async () => {
    let cancelCalled = false;
    const { deps, calls } = createMockDeps({
      confirmModal: {
        title: 'Cancel?',
        message: 'Cancel?',
        onCancel: () => {
          cancelCalled = true;
        },
      },
    });

    const controller = new ModalInteractionController(deps);
    controller.closeConfirmModal('cancel');

    assert.equal(cancelCalled, true);
    assert.equal(calls.restoreFocus, 0, '有 onCancel 时不执行默认焦点恢复');

    // 测试没有 onCancel 时的兜底
    const { deps: depsNoCancel, calls: callsNoCancel } = createMockDeps({
      confirmModal: {
        title: 'Cancel?',
        message: 'Cancel?',
      },
    });
    const controller2 = new ModalInteractionController(depsNoCancel);
    controller2.closeConfirmModal('cancel');
    assert.equal(callsNoCancel.restoreFocus, 1, '无 onCancel 时执行兜底焦点恢复');
  });

  await t.test('3. 全局按键 Escape 与 Enter 拦截', async () => {
    let confirmed = false;
    let cancelled = false;

    const { deps } = createMockDeps({
      confirmModal: {
        title: 'Test',
        message: 'Test',
        onConfirm: () => { confirmed = true; },
        onCancel: () => { cancelled = true; },
      },
    });

    const controller = new ModalInteractionController(deps);
    assert.equal(controller.handleGlobalEscape(), true);
    assert.equal(cancelled, true);

    deps.commitState({
      confirmModal: {
        title: 'Test',
        message: 'Test',
        onConfirm: () => { confirmed = true; },
      },
    });

    assert.equal(controller.handleGlobalEnter(), true);
    assert.equal(confirmed, true);

    // 弹窗为空时均返回 false
    assert.equal(controller.handleGlobalEscape(), false);
    assert.equal(controller.handleGlobalEnter(), false);
  });

  await t.test('4. submitTaskModal 单人模式与群聊模式分流', async () => {
    const { deps, calls, getState } = createMockDeps();
    const controller = new ModalInteractionController(deps);

    // 单人模式
    controller.setModalTab('solo');
    controller.setSelectedAgent('agent-bob');
    await controller.submitTaskModal({ title: 'My Task', projectId: 'p-1' });

    assert.equal(calls.newSession.length, 1);
    assert.deepEqual(calls.newSession[0], {
      profile: 'agent-bob',
      projectId: 'p-1',
      title: 'My Task',
    });
    assert.equal(getState().isNewTaskModalOpen, false);

    // 群聊模式：不足 2 人时自动补齐
    controller.setModalTab('group');
    controller.setSelectedAgent('agent-carol');
    await controller.submitTaskModal({ title: 'My Group', members: ['agent-carol'] });

    assert.equal(calls.createGroupRoom.length, 1);
    assert.equal(calls.createGroupRoom[0].title, 'My Group');
    assert.deepEqual(calls.createGroupRoom[0].members, ['agent-carol', 'default']);
    assert.equal(calls.openGroupRoom.length, 1);
    assert.equal(calls.openGroupRoom[0], 'room-new-123');
    assert.equal(calls.fetchGroupRooms, 1);
  });

  await t.test('5. handleContextMenuAction 右键动作分发与删除确认', async () => {
    const { deps, calls, getState } = createMockDeps({
      sessionContextMenu: {
        x: 100,
        y: 100,
        targetType: 'session',
        targetId: 'sess-1',
        targetName: 'Session 1',
      },
    });

    const controller = new ModalInteractionController(deps);

    // 1. rename
    controller.handleContextMenuAction('rename');
    assert.equal(calls.renameSession.length, 1);
    assert.equal(calls.renameSession[0].id, 'sess-1');
    assert.equal(getState().sessionContextMenu, undefined, '动作执行后菜单必须关闭');

    // 2. copy-id
    controller.handleContextMenuAction('copy-id', { targetId: 'sess-2', targetName: 'Session 2' });
    assert.equal(calls.copySessionId.length, 1);
    assert.equal(calls.copySessionId[0], 'sess-2');

    // 3. delete 发起危险确认
    controller.handleContextMenuAction('delete', { targetId: 'sess-1', targetName: 'Session 1' });
    const modal = getState().confirmModal;
    assert.ok(modal);
    assert.equal(modal.isDanger, true);
    // 执行 onConfirm
    modal.onConfirm();
    assert.equal(calls.deleteSession.length, 1);
    assert.equal(calls.deleteSession[0], 'sess-1');
  });

  await t.test('6. closeContextMenuIfClickedOutside 点击外部关闭菜单', async () => {
    const { deps, getState } = createMockDeps({
      sessionContextMenu: {
        x: 10,
        y: 20,
        targetType: 'bot',
        targetId: 'bot-1',
      },
    });

    const controller = new ModalInteractionController(deps);
    const mockMenu = {
      contains: (node) => node && node.id === 'inside-node',
    };

    // 点在内部不关闭
    const insideRes = controller.closeContextMenuIfClickedOutside({ id: 'inside-node' }, mockMenu);
    assert.equal(insideRes, false);
    assert.ok(getState().sessionContextMenu);

    // 点在外部关闭
    const outsideRes = controller.closeContextMenuIfClickedOutside({ id: 'outside-node' }, mockMenu);
    assert.equal(outsideRes, true);
    assert.equal(getState().sessionContextMenu, undefined);
  });

  await t.test('7. submitTaskModal 支持即发首条消息，closeTaskModal 关闭弹窗并归还焦点', async () => {
    const { deps, calls, getState } = createMockDeps();
    const controller = new ModalInteractionController(deps);

    // 单人即发：传入 mode + agent + firstMessage
    await controller.submitTaskModal({
      mode: 'solo',
      agent: 'agent-dave',
      projectId: 'proj-9',
      title: 'Quick Sprint',
      firstMessage: '  开始分析日志文件  ',
    });
    assert.equal(calls.newSession.length, 1);
    assert.deepEqual(calls.newSession[0], {
      profile: 'agent-dave',
      projectId: 'proj-9',
      title: 'Quick Sprint',
    });
    assert.deepEqual(calls.routeSend, ['开始分析日志文件']);

    // 空白首条消息不触发 routeSend
    await controller.submitTaskModal({
      mode: 'solo',
      agent: 'agent-dave',
      firstMessage: '   ',
    });
    assert.equal(calls.routeSend.length, 1);

    // 群聊即发：自动开房并投递首条群聊消息
    await controller.submitTaskModal({
      mode: 'group',
      title: 'Architecture Review',
      members: ['agent-a', 'agent-b'],
      firstMessage: '请两位评审当前设计',
    });
    assert.deepEqual(calls.sendGroupMessage, [
      { roomId: 'room-new-123', text: '请两位评审当前设计' },
    ]);

    // closeTaskModal 关闭弹窗、归还焦点、请求重渲染
    deps.commitState({ isNewTaskModalOpen: true });
    assert.equal(getState().isNewTaskModalOpen, true);
    const prevFocusCalls = calls.restoreFocus;
    const prevRenderCalls = calls.render;
    controller.closeTaskModal();
    assert.equal(getState().isNewTaskModalOpen, false);
    assert.equal(calls.restoreFocus, prevFocusCalls + 1);
    assert.equal(calls.render, prevRenderCalls + 1);
  });

  await t.test('8. P0 隔离：断线或创建失败时保留弹窗与草稿，绝对禁止向旧对话误发首条消息', async () => {
    // 场景 A：solo createNewSession 返回 null（断线/RPC失败）
    const soloFail = createMockDeps(
      { isNewTaskModalOpen: true, selectedNewTaskProjectId: 'p-old' },
      { createNewSessionResult: null },
    );
    const soloCtrl = new ModalInteractionController(soloFail.deps);
    await soloCtrl.submitTaskModal({
      mode: 'solo',
      agent: 'default',
      projectId: 'p-new',
      firstMessage: '这条消息绝不能泄漏到旧会话',
    });
    assert.equal(soloFail.getState().isNewTaskModalOpen, true, '建聊失败不得关闭弹窗吞草稿');
    assert.equal(soloFail.calls.routeSend.length, 0, '建聊失败绝不可触发 routeSend 发进旧会话');
    assert.equal(soloFail.getState().selectedNewTaskProjectId, 'p-old', '失败时不得提前覆写项目偏好');

    // 场景 B：solo 成功时回写 selectedNewTaskProjectId，切回默认工作区（projectId: undefined）时清空
    const soloOk = createMockDeps({ isNewTaskModalOpen: true });
    const okCtrl = new ModalInteractionController(soloOk.deps);
    await okCtrl.submitTaskModal({
      mode: 'solo',
      agent: 'default',
      projectId: 'p-chosen',
    });
    assert.equal(soloOk.getState().isNewTaskModalOpen, false);
    assert.equal(soloOk.getState().selectedNewTaskProjectId, 'p-chosen');

    await okCtrl.submitTaskModal({
      mode: 'solo',
      agent: 'default',
      projectId: undefined,
    });
    assert.equal(soloOk.getState().selectedNewTaskProjectId, undefined, '切回默认工作区必须清空已记忆的项目 ID');

    // 场景 C：group createGroupRoom 返回 null（断线）与 throw 异常返回 { ok: false, error }
    const grpNull = createMockDeps(
      { isNewTaskModalOpen: true },
      { createGroupRoomResult: null },
    );
    const grpNullRes = await new ModalInteractionController(grpNull.deps).submitTaskModal({
      mode: 'group',
      members: ['default', 'arch'],
      firstMessage: '不得发入旧群',
    });
    assert.equal(grpNullRes.ok, false);
    assert.ok(grpNullRes.error?.includes('dock.createGroupFailed'));
    assert.equal(grpNull.getState().isNewTaskModalOpen, true);
    assert.equal(grpNull.calls.sendGroupMessage.length, 0);
    assert.ok(grpNull.getState().dockNotice.includes('dock.createGroupFailed'));

    const grpThrow = createMockDeps({ isNewTaskModalOpen: true });
    grpThrow.deps.createGroupRoom = async () => {
      throw new Error('group RPC 503');
    };
    const grpThrowRes = await new ModalInteractionController(grpThrow.deps).submitTaskModal({
      mode: 'group',
      members: ['default', 'arch'],
      firstMessage: '不得发入旧群',
    });
    assert.equal(grpThrowRes.ok, false);
    assert.ok(grpThrowRes.error?.includes('group RPC 503'));
    assert.equal(grpThrow.getState().isNewTaskModalOpen, true);
    assert.equal(grpThrow.calls.sendGroupMessage.length, 0);
    assert.ok(grpThrow.getState().dockNotice.includes('group RPC 503'));

    // 场景 D：solo title: '' + firstMessage: '' 使用默认任务标题、恢复输入焦点并返回 { ok: true }
    const soloBlankTitle = createMockDeps({ isNewTaskModalOpen: true });
    const blankRes = await new ModalInteractionController(soloBlankTitle.deps).submitTaskModal({
      mode: 'solo',
      agent: 'arch-wang',
      title: '',
      projectId: 'p1',
      firstMessage: '',
    });
    assert.deepEqual(blankRes, { ok: true });
    assert.equal(soloBlankTitle.calls.newSession.length, 1);
    assert.equal(soloBlankTitle.calls.newSession[0].profile, 'arch-wang');
    assert.equal(soloBlankTitle.calls.newSession[0].projectId, 'p1');
    assert.ok(soloBlankTitle.calls.newSession[0].title.includes('chat.defaultTaskTitle'));
    assert.equal(soloBlankTitle.calls.routeSend.length, 0);
    assert.equal(soloBlankTitle.calls.restoreFocus, 1, '提交关闭后必须归还焦点给主输入框');

    // 场景 E：solo createNewSession 抛异常时捕获并返回 { ok: false, error }，不得未捕获拒绝
    const soloThrow = createMockDeps({ isNewTaskModalOpen: true });
    soloThrow.deps.createNewSession = async () => {
      throw new Error('RPC timeout 504');
    };
    const throwRes = await new ModalInteractionController(soloThrow.deps).submitTaskModal({
      mode: 'solo',
      agent: 'arch-wang',
      title: '',
      firstMessage: '不得发送',
    });
    assert.deepEqual(throwRes, { ok: false, error: 'RPC timeout 504' });
    assert.equal(soloThrow.getState().isNewTaskModalOpen, true);
    assert.equal(soloThrow.getState().dockNotice, 'RPC timeout 504');
    assert.equal(soloThrow.calls.routeSend.length, 0);
  });

  await t.test('9. Phase 2 A11y：sessionContextMenu Esc 关闭与 Tab / 方向键焦点陷阱回归', () => {
    // 1. handleGlobalEscape 在 sessionContextMenu 打开时关闭并返回 true；全空返回 false
    const escCtx = createMockDeps({
      sessionContextMenu: { x: 10, y: 20, targetType: 'session', targetId: 's1', targetName: 'S1' },
    });
    const escCtrl = createModalInteractionController(escCtx.deps);
    assert.equal(escCtrl.handleGlobalEscape(), true);
    assert.equal(escCtx.getState().sessionContextMenu, undefined);
    assert.equal(escCtrl.handleGlobalEscape(), false);

    // 2. bindDomEvents ConfirmModal 焦点迁入与 Tab/Shift+Tab 循环 + ContextMenu 方向键与 Esc
    const mockFocusCalls = [];
    const makeBtn = (id) => ({
      id,
      focus: () => { mockFocusCalls.push(id); mockDoc.activeElement = btnMap[id]; },
    });
    const btnClose = makeBtn('btn-confirm-modal-close');
    const btnCancel = makeBtn('btn-confirm-modal-cancel');
    const btnOk = makeBtn('btn-confirm-modal-ok');
    const ctxItem0 = makeBtn('ctx-item-0');
    const ctxItem1 = makeBtn('ctx-item-1');
    ctxItem0.dataset = { action: 'rename' };
    ctxItem1.dataset = { action: 'delete' };

    const confirmBtns = [btnClose, btnCancel, btnOk];
    const ctxBtns = [ctxItem0, ctxItem1];
    const confirmCard = {
      contains: (el) => confirmBtns.includes(el),
      querySelectorAll: () => confirmBtns,
      onkeydown: null,
    };
    const contextMenuEl = {
      contains: (el) => ctxBtns.includes(el),
      onkeydown: null,
    };
    const btnMap = {
      'btn-confirm-modal-close': btnClose,
      'btn-confirm-modal-cancel': btnCancel,
      'btn-confirm-modal-ok': btnOk,
      'ctx-item-0': ctxItem0,
      'ctx-item-1': ctxItem1,
      'flux-confirm-modal-card': confirmCard,
      'session-context-menu': contextMenuEl,
    };
    const mockDoc = {
      activeElement: null,
      getElementById: (id) => btnMap[id] || null,
      querySelectorAll: (sel) => (sel === '#session-context-menu .ctx-item' ? ctxBtns : []),
    };

    const domCtx = createMockDeps({
      sessionContextMenu: { x: 10, y: 20, targetType: 'session', targetId: 's1', targetName: 'S1' },
    });
    const domCtrl = createModalInteractionController(domCtx.deps);
    domCtrl.bindDomEvents(mockDoc);

    // ConfirmModal 按钮及遮罩点击必须 stopPropagation 防止穿透到 Radix DismissableLayer deferred click
    const modalBtnCtx = createMockDeps({
      confirmModal: { title: 'Delete', message: 'Confirm?', onConfirm: () => {}, onCancel: () => {} },
    });
    const modalBtnCtrl = createModalInteractionController(modalBtnCtx.deps);
    const localMap = {
      'btn-confirm-modal-ok': { id: 'btn-confirm-modal-ok', focus: () => {}, onclick: null },
      'btn-confirm-modal-cancel': { id: 'btn-confirm-modal-cancel', focus: () => {}, onclick: null },
      'btn-confirm-modal-close': { id: 'btn-confirm-modal-close', focus: () => {}, onclick: null },
      'flux-confirm-modal-overlay': { id: 'flux-confirm-modal-overlay', onclick: null },
    };
    modalBtnCtrl.bindDomEvents({
      activeElement: null,
      getElementById: (id) => localMap[id] || null,
      querySelectorAll: () => [],
    });
    for (const [id, evTarget] of [
      ['btn-confirm-modal-ok', null],
      ['btn-confirm-modal-cancel', null],
      ['btn-confirm-modal-close', null],
      ['flux-confirm-modal-overlay', localMap['flux-confirm-modal-overlay']],
    ]) {
      let stopped = false;
      localMap[id].onclick({
        target: evTarget,
        stopPropagation: () => { stopped = true; },
      });
      assert.equal(stopped, true, `${id} 点击必须阻止冒泡防止底层 Radix 弹窗联动关闭`);
    }

    // ConfirmModal 自动聚焦到 cancel；Shift+Tab 从 first(close) 绕到 last(ok)，Tab 从 last(ok) 绕到 first(close)
    assert.equal(mockFocusCalls.includes('btn-confirm-modal-cancel'), true);
    mockDoc.activeElement = btnClose;
    let tabPrevented = false;
    confirmCard.onkeydown({ key: 'Tab', shiftKey: true, preventDefault: () => { tabPrevented = true; } });
    assert.equal(tabPrevented, true);
    assert.equal(mockDoc.activeElement, btnOk);
    tabPrevented = false;
    confirmCard.onkeydown({ key: 'Tab', shiftKey: false, preventDefault: () => { tabPrevented = true; } });
    assert.equal(tabPrevented, true);
    assert.equal(mockDoc.activeElement, btnClose);

    // ContextMenu 自动聚焦首项并支持 ArrowDown / ArrowUp / Home / End / Escape
    assert.equal(mockFocusCalls.includes('ctx-item-0'), true);
    mockDoc.activeElement = ctxItem0;
    contextMenuEl.onkeydown({ key: 'ArrowDown', preventDefault: () => {} });
    assert.equal(mockDoc.activeElement, ctxItem1);
    contextMenuEl.onkeydown({ key: 'ArrowUp', preventDefault: () => {} });
    assert.equal(mockDoc.activeElement, ctxItem0);
    contextMenuEl.onkeydown({ key: 'End', preventDefault: () => {} });
    assert.equal(mockDoc.activeElement, ctxItem1);
    contextMenuEl.onkeydown({ key: 'Home', preventDefault: () => {} });
    assert.equal(mockDoc.activeElement, ctxItem0);
    contextMenuEl.onkeydown({ key: 'Escape', preventDefault: () => {}, stopPropagation: () => {} });
    assert.equal(domCtx.getState().sessionContextMenu, undefined);

    // handleGlobalEnter 在取消/关闭按钮聚焦时让位（返回 false），仅在非取消按钮时触发确认
    const enterCtx = createMockDeps({
      confirmModal: { title: 'Delete', message: 'Confirm?', onConfirm: () => {} },
    });
    const enterCtrl = createModalInteractionController(enterCtx.deps);
    assert.equal(enterCtrl.handleGlobalEnter('btn-confirm-modal-cancel'), false);
    assert.equal(enterCtrl.handleGlobalEnter('btn-confirm-modal-close'), false);
    assert.ok(enterCtx.getState().confirmModal, '取消或关闭按钮聚焦时 Enter 不得误触确认');
    assert.equal(enterCtrl.handleGlobalEnter('btn-confirm-modal-ok'), true);
    assert.equal(enterCtx.getState().confirmModal, undefined);
  });
});
