/**
 * 会话组织协同编排器与 SessionOperationService 归档/建聊契约单元测试
 * (packages/desktop/__tests__/unit/conversationOrgCoordinator.test.mjs)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DONE_ROOMS_UI_META_KEY,
  FOLDERS_UI_META_KEY,
  SessionListGeneration,
  buildSessionEntityKey,
} from '@hermes-flux/core';
import { createConversationOrgCoordinator } from '../../dist/renderer/services/conversationOrgCoordinator.mjs';
import { createSessionOperationService } from '../../dist/renderer/services/sessionOperationService.mjs';

function createBaseState(overrides = {}) {
  return {
    activeSessionId: 'sess-active',
    activeLiveSessionId: 'live-active',
    profileName: 'default',
    gatewayConnected: true,
    isStreaming: false,
    profiles: [
      {
        name: 'default',
        displayName: 'Default 助理',
        isDefault: true,
        uiMeta: {},
        uiMetaRevisions: {},
      },
    ],
    sessions: [
      { id: 'sess-active', title: '进行中会话', botName: 'default', isArchived: false, hidden: false },
      { id: 'sess-bot', title: 'Bot 主工位', botName: 'default', isArchived: false, hidden: true },
    ],
    archivedSessions: [],
    groupRooms: [{ roomId: 'room-1', name: '方案研讨室', members: ['default', 'arch-wang'] }],
    projects: [
      { id: 'proj-1', name: 'Flux Core', path: '/work/hermes-flux', archived: false },
      { id: 'proj-arch', name: '旧归档项目', path: '/work/old', archived: true },
    ],
    pendingSessionIds: [],
    messages: [],
    selectedModel: 'gpt-4o',
    currentProvider: 'openai',
    recentModels: [],
    reasoningLevel: 'default',
    approvalMode: 'manual',
    dockNotice: '',
    modelMenuOpen: false,
    activeFocus: { type: 'session', sessionId: 'sess-active' },
    rollbackArmed: null,
    gatewayUrl: 'http://127.0.0.1:8080',
    orgPrefs: { showDoneSection: true, autoReopenOnSend: true },
    orgFolders: [],
    orgAssignments: {},
    orgDoneRooms: {},
    orgContainerCollapsed: { done: true },
    doneSessionsLoaded: false,
    doneLoading: false,
    doneError: '',
    sessionsPhase: 'ready',
    confirmModal: null,
    ...overrides,
  };
}

async function flushMicrotasks(rounds = 40) {
  for (let i = 0; i < rounds; i += 1) {
    await Promise.resolve();
  }
}

function createHarness(options = {}) {
  const state = createBaseState(options.state);
  const rpcCalls = [];
  const toasts = [];
  const storageMap = new Map();
  let archivedCalls = 0;
  let remoteFolders = { version: 1, folders: [{ id: 'fld-1', name: '待审', order: 0, createdAt: 1, updatedAt: 1 }], assignments: {} };
  let remoteDoneRooms = { version: 1, done: {} };

  const defaultCall = async (method, params) => {
    rpcCalls.push({ method, params });
    if (method === 'session.create') return { session_id: 'sess-created', id: 'sess-created', live_id: 'live-created' };
    if (method === 'session.archive') {
      if (options.failSessionArchive) throw new Error('archive denied');
      return { ok: true };
    }
    if (method === 'session.list') {
      return { sessions: state.sessions };
    }
    if (method === 'profiles.list') {
      return {
        profiles: [
          {
            name: 'default',
            is_default: true,
            ui_meta: { [FOLDERS_UI_META_KEY]: remoteFolders, [DONE_ROOMS_UI_META_KEY]: remoteDoneRooms },
            ui_meta_revisions: { [FOLDERS_UI_META_KEY]: 1, [DONE_ROOMS_UI_META_KEY]: 1 },
          },
        ],
      };
    }
    if (method === 'profiles.configure') {
      if (options.failProfileConfigure) throw new Error('ui_meta write failed');
      if (params?.ui_meta?.[FOLDERS_UI_META_KEY]) remoteFolders = params.ui_meta[FOLDERS_UI_META_KEY];
      if (params?.ui_meta?.[DONE_ROOMS_UI_META_KEY]) remoteDoneRooms = params.ui_meta[DONE_ROOMS_UI_META_KEY];
      return {
        ok: true,
        applied: {
          ui_meta: true,
          ui_meta_revisions: { [FOLDERS_UI_META_KEY]: 2, [DONE_ROOMS_UI_META_KEY]: 2 },
        },
      };
    }
    return {};
  };

  const gatewayClient = options.gatewayClient ?? {
    call: defaultCall,
    request: defaultCall,
    fetchSessionMessages: async () => ({ status: 'success', messages: [] }),
    listArchivedSessions: async () => {
      archivedCalls += 1;
      return {
        ok: true,
        sessions: [{ id: 'sess-done-remote', title: '远端已归档', isArchived: true, botName: 'default' }],
      };
    },
  };

  let coordinator;
  const sessionService = createSessionOperationService({
    getState: () => state,
    getGatewayClient: () => gatewayClient,
    getDesktopApi: () => undefined,
    getCurrentTicket: () => 't-1',
    getEffectiveUrl: (u) => u || 'http://127.0.0.1:8080',
    render: () => {},
    t: (key, params) => `${key}:${JSON.stringify(params || {})}`,
    showToast: (msg) => toasts.push(msg),
    setTimedDockNotice: (msg) => { state.dockNotice = msg; },
    restoreComposerFocus: () => {},
    sessionDrafts: { get: () => '', set: () => {}, delete: () => {}, has: () => false },
    sessionMessagesCache: new Map(),
    unreadSessionIds: new Set(),
    activeRunningSessionIds: new Set(),
    activityTransitionTracker: { clear: () => {} },
    sessionHandleRegistry: { register: () => {}, unregister: () => {}, toStoredSessionId: (id) => id },
    cacheService: { dropChannel: async () => {}, writeSessions: async () => {} },
    persistSessionsToCache: () => {},
    forgetOlderCursorState: () => {},
    sessionListGeneration: new SessionListGeneration(),
    getActiveStreamingStoredSessionId: () => null,
    resetActiveStreamingState: () => {},
    setPendingScrollToBottom: () => {},
    setLastMessagesSnapshot: () => {},
    loadMessages: async () => {},
    openBotChat: async () => {},
    ensureLiveSessionId: async () => 'live-created',
    fetchSessions: async () => {},
    incrementActiveLoadMessagesGeneration: () => 1,
    getPromptInputValue: () => '',
    setPromptInputValue: () => {},
    focusPromptInput: () => {},
    promptDialog: () => null,
    writeClipboardText: async () => {},
    storage: { getItem: (k) => storageMap.get(k) || null, setItem: (k, v) => storageMap.set(k, v) },
    onSessionCreatedInContainer: (p, sid, cid) => coordinator?.assignNewEntityContainer('session', sid, { profile: p, containerId: cid }),
    onSessionDeleted: (sid, p) => coordinator?.pruneDeletedEntity('session', sid, p),
  });

  coordinator = createConversationOrgCoordinator({
    getState: () => state,
    getGatewayClient: () => gatewayClient,
    render: () => {},
    t: (key, params) => `${key}:${JSON.stringify(params || {})}`,
    showToast: (msg) => toasts.push(msg),
    restoreComposerFocus: () => {},
    describeRpcError: (err) => (err instanceof Error ? err.message : String(err)),
    setSessionArchived: (id, archived, profile) => sessionService.setSessionArchived(id, archived, profile),
    isForeverChatSession: options.isForeverChatSession,
    fetchArchivedSessions: (opts) => sessionService.fetchArchivedSessions(opts),
    openNewChatInContainer: () => {},
    storage: { getItem: (k) => storageMap.get(k) || null, setItem: (k, v) => storageMap.set(k, v) },
  });

  return { state, rpcCalls, toasts, storageMap, sessionService, coordinator, getArchivedCalls: () => archivedCalls };
}

test('session.create 契约与归档状态机：默认不传 cwd/project_id，选项目传 cwd + cwd_explicit', async () => {
  const { sessionService, rpcCalls } = createHarness();

  await sessionService.createNewSession({ profile: 'default', title: '默认会话' });
  const defaultCall = rpcCalls.find((c) => c.method === 'session.create');
  assert.ok(defaultCall);
  assert.equal('project_id' in defaultCall.params, false, 'session.create 绝不能传非法字段 project_id');
  assert.equal('cwd' in defaultCall.params, false, '选默认时必须省略 cwd');
  assert.equal('cwd_explicit' in defaultCall.params, false, '选默认时必须省略 cwd_explicit');

  rpcCalls.length = 0;
  await sessionService.createNewSession({ profile: 'default', title: '项目会话', projectId: 'proj-1' });
  const projCall = rpcCalls.find((c) => c.method === 'session.create');
  assert.ok(projCall);
  assert.equal('project_id' in projCall.params, false, '选中项目时也绝不能传 project_id');
  assert.equal(projCall.params.cwd, '/work/hermes-flux');
  assert.equal(projCall.params.cwd_explicit, true);
});

test('setSessionArchived 失败保真、二次确认弹窗与 Bot 主工位物理屏蔽', async () => {
  const { state, coordinator } = createHarness({ failSessionArchive: true });

  // Bot 主工位严禁触发确认弹窗或归档
  coordinator.requestMarkDone('session', 'sess-bot', 'Bot 主工位');
  assert.equal(state.confirmModal, null, 'Bot 主工位不得触发标记已完成二次确认弹窗');
  assert.equal(await coordinator.markDoneConfirmed('session', 'sess-bot'), false);

  // 普通会话必须弹出 confirmModal，不可直接归档
  coordinator.requestMarkDone('session', 'sess-active', '进行中会话');
  assert.ok(state.confirmModal, '必须打开二次确认弹窗');
  assert.equal(state.sessions.some((s) => s.id === 'sess-active'), true, '未确认前不得移出活跃列表');

  // RPC 失败时绝不伪造本地已归档
  const ok = await coordinator.markDoneConfirmed('session', 'sess-active');
  assert.equal(ok, false);
  assert.equal(state.sessions.find((s) => s.id === 'sess-active')?.isArchived, false);
  assert.equal(state.archivedSessions.length, 0);

  // 成功路径：sess-active 迁入 archivedSessions，恢复无需弹窗立即还原
  const okHarness = createHarness();
  assert.equal(await okHarness.coordinator.markDoneConfirmed('session', 'sess-active'), true);
  assert.equal(okHarness.state.archivedSessions.some((s) => s.id === 'sess-active'), true);
  assert.equal(okHarness.state.sessions.some((s) => s.id === 'sess-active'), false);
  assert.equal(await okHarness.coordinator.restoreDone('session', 'sess-active'), true);
  assert.equal(okHarness.state.sessions.some((s) => s.id === 'sess-active' && !s.isArchived), true);
});

test('发送自动恢复 (autoReopenOnSend)、偏好与折叠惰性加载、两阶段建群告警及按需清理', async () => {
  const h = createHarness({
    state: {
      archivedSessions: [{ id: 'sess-arch-1', title: '老会话', botName: 'default', isArchived: true, hidden: false }],
      profiles: [
        {
          name: 'default',
          displayName: 'Default 助理',
          isDefault: true,
          uiMeta: {
            [DONE_ROOMS_UI_META_KEY]: { version: 1, done: { 'room-1': 12345 } },
          },
          uiMetaRevisions: { [DONE_ROOMS_UI_META_KEY]: 1 },
        },
      ],
      orgPrefs: { showDoneSection: true, autoReopenOnSend: true },
    },
  });
  h.coordinator.hydrateFromProfiles(h.state.profiles);
  assert.equal(h.state.orgDoneRooms['room-1'], 12345);

  // 自动恢复群聊与归档会话
  h.coordinator.autoReopenIfDone('group', 'room-1');
  await flushMicrotasks();
  assert.equal(h.state.orgDoneRooms['room-1'], undefined, 'autoReopenOnSend=true 时向已完成群发消息应自动恢复');

  h.coordinator.autoReopenIfDone('session', 'sess-arch-1');
  await flushMicrotasks();
  assert.equal(h.rpcCalls.some((c) => c.method === 'session.archive' && c.params.archived === false), true);

  // 关闭 autoReopenOnSend 后不再自动恢复
  h.coordinator.setOrgPrefs({ autoReopenOnSend: false });
  assert.ok(h.storageMap.size >= 1);
  h.state.orgDoneRooms = { 'room-1': 999 };
  h.coordinator.autoReopenIfDone('group', 'room-1');
  await flushMicrotasks();
  assert.equal(h.state.orgDoneRooms['room-1'], 999);

  // 首次展开 done 抽屉触发惰性拉取
  h.coordinator.toggleContainer('done');
  await flushMicrotasks();
  assert.equal(h.getArchivedCalls(), 1);

  // 两阶段建群后归属同步失败仅弹非阻塞告警
  const failGroupHarness = createHarness({ failProfileConfigure: true });
  await failGroupHarness.coordinator.assignNewEntityContainer('group', 'room-1', { projectId: 'proj-1' });
  assert.ok(
    failGroupHarness.toasts.some((msg) => msg.includes('rail.groupFolderPostAssignWarning')),
    '建群后 ui_meta 同步失败应弹出告警而非阻断建群',
  );

  // doneSessionsLoaded === false 时删除普通会话绝不抹除已归档会话的显式映射
  const archKey = buildSessionEntityKey('default', 'sess-unloaded-arch');
  const activeKey = buildSessionEntityKey('default', 'sess-active');
  let pruneServerFolders = {
    version: 1,
    folders: [{ id: 'fld-1', name: '待审', order: 0, createdAt: 1, updatedAt: 1 }],
    assignments: { [archKey]: 'fld-1', [activeKey]: 'fld-1' },
  };
  const pruneGuardCall = async (method, params) => {
    pruneGuardCalls.push({ method, params });
    if (method === 'profiles.list') {
      return {
        profiles: [
          {
            name: 'default',
            is_default: true,
            ui_meta: { [FOLDERS_UI_META_KEY]: pruneServerFolders, [DONE_ROOMS_UI_META_KEY]: { version: 1, done: {} } },
            ui_meta_revisions: { [FOLDERS_UI_META_KEY]: 1, [DONE_ROOMS_UI_META_KEY]: 1 },
          },
        ],
      };
    }
    if (method === 'profiles.configure') {
      if (params?.ui_meta?.[FOLDERS_UI_META_KEY]) pruneServerFolders = params.ui_meta[FOLDERS_UI_META_KEY];
      return { ok: true, applied: { ui_meta: true, ui_meta_revisions: { [FOLDERS_UI_META_KEY]: 2, [DONE_ROOMS_UI_META_KEY]: 2 } } };
    }
    return {};
  };
  const pruneGuard = createHarness({
    state: {
      doneSessionsLoaded: false,
      profiles: [
        {
          name: 'default',
          displayName: 'Default 助理',
          isDefault: true,
          uiMeta: { [FOLDERS_UI_META_KEY]: pruneServerFolders },
          uiMetaRevisions: { [FOLDERS_UI_META_KEY]: 1 },
        },
      ],
    },
    gatewayClient: {
      call: pruneGuardCall,
      request: pruneGuardCall,
      fetchSessionMessages: async () => ({ status: 'success', messages: [] }),
    },
  });
  const pruneGuardCalls = [];
  pruneGuard.coordinator.hydrateFromProfiles(pruneGuard.state.profiles);
  pruneGuardCalls.length = 0;
  pruneGuard.coordinator.pruneDeletedEntity('session', 'sess-active', 'default');
  await flushMicrotasks();
  const configureCalls = pruneGuardCalls.filter((c) => c.method === 'profiles.configure');
  assert.equal(configureCalls.length >= 1, true, '必须触发单条显式归属清理');
  assert.equal(
    configureCalls.some((c) => !(activeKey in (c.params?.ui_meta?.[FOLDERS_UI_META_KEY]?.assignments ?? {}))),
    true,
  );
  assert.equal(
    pruneGuard.state.orgAssignments[archKey],
    'fld-1',
    'doneSessionsLoaded=false 时未加载归档会话的映射绝不能被误清理',
  );
});

test('哑光输入模态框建夹/改名、跨 Profile 同 ID 删除保护与未索引主工位免疫', async () => {
  // 1. 无 promptText 时 promptCreateFolder / promptRenameFolder 打开哑光输入 confirmModal（绝不调 window.prompt）
  let winPromptCalls = 0;
  const prevWin = globalThis.window;
  globalThis.window = {
    prompt: () => {
      winPromptCalls += 1;
      return 'should-not-use';
    },
  };
  try {
    const promptH = createHarness();
    promptH.coordinator.hydrateFromProfiles(promptH.state.profiles);
    promptH.coordinator.promptCreateFolder({ kind: 'session', id: 'sess-active', profile: 'default' });
    assert.ok(promptH.state.confirmModal, '必须通过 state.confirmModal 打开哑光输入框');
    assert.ok(typeof promptH.state.confirmModal.inputPlaceholder === 'string');
    assert.equal(winPromptCalls, 0, '严禁回退原生 window.prompt');

    await promptH.state.confirmModal.onConfirm('新专题文件夹');
    await flushMicrotasks();
    const createdFolder = promptH.state.orgFolders.find((f) => f.name === '新专题文件夹');
    assert.ok(createdFolder);
    assert.equal(
      promptH.state.orgAssignments[buildSessionEntityKey('default', 'sess-active')],
      createdFolder.id,
    );

    promptH.coordinator.promptRenameFolder(createdFolder.id, createdFolder.name);
    assert.equal(promptH.state.confirmModal?.inputDefaultValue, '新专题文件夹');
    assert.equal(winPromptCalls, 0);
    await promptH.state.confirmModal.onConfirm('已改名文件夹');
    await flushMicrotasks();
    assert.equal(promptH.state.orgFolders.some((f) => f.name === '已改名文件夹'), true);
  } finally {
    globalThis.window = prevWin;
  }

  // 2. doneSessionsLoaded = true 且存在同 ID 跨 Profile 会话时，删 arch::s-dup 绝不误清 default::s-dup 映射
  const defKey = buildSessionEntityKey('default', 's-dup');
  const archDupKey = buildSessionEntityKey('arch', 's-dup');
  let remoteFolders = {
    version: 1,
    folders: [{ id: 'fld-1', name: '待审', order: 0, createdAt: 1, updatedAt: 1 }],
    assignments: { [defKey]: 'fld-1', [archDupKey]: 'fld-1' },
  };
  const crossRpc = async (method, params) => {
    if (method === 'profiles.list') {
      return {
        profiles: [
          {
            name: 'default',
            is_default: true,
            ui_meta: { [FOLDERS_UI_META_KEY]: remoteFolders, [DONE_ROOMS_UI_META_KEY]: { version: 1, done: {} } },
            ui_meta_revisions: { [FOLDERS_UI_META_KEY]: 1, [DONE_ROOMS_UI_META_KEY]: 1 },
          },
        ],
      };
    }
    if (method === 'profiles.configure') {
      if (params?.ui_meta?.[FOLDERS_UI_META_KEY]) remoteFolders = params.ui_meta[FOLDERS_UI_META_KEY];
      return { ok: true, applied: { ui_meta: true, ui_meta_revisions: { [FOLDERS_UI_META_KEY]: 2, [DONE_ROOMS_UI_META_KEY]: 2 } } };
    }
    return {};
  };
  const dupH = createHarness({
    state: {
      doneSessionsLoaded: true,
      sessionsPhase: 'ready',
      sessions: [
        { id: 's-dup', title: 'Default 副本', botName: 'default', isArchived: false, hidden: false },
        { id: 's-dup', title: 'Arch 副本', botName: 'arch', isArchived: false, hidden: false },
      ],
      archivedSessions: [],
      profiles: [
        {
          name: 'default',
          displayName: 'Default 助理',
          isDefault: true,
          uiMeta: { [FOLDERS_UI_META_KEY]: remoteFolders },
          uiMetaRevisions: { [FOLDERS_UI_META_KEY]: 1 },
        },
      ],
    },
    gatewayClient: {
      call: crossRpc,
      request: crossRpc,
      fetchSessionMessages: async () => ({ status: 'success', messages: [] }),
      listArchivedSessions: async () => ({ ok: true, sessions: [] }),
    },
    isForeverChatSession: (sid) => sid === 'unindexed-forever',
  });
  dupH.coordinator.hydrateFromProfiles(dupH.state.profiles);
  dupH.coordinator.pruneDeletedEntity('session', 's-dup', 'arch');
  await flushMicrotasks();
  assert.equal(dupH.state.orgAssignments[defKey], 'fld-1', 'default::s-dup 映射必须完整保留');
  assert.equal(dupH.state.orgAssignments[archDupKey], undefined, 'arch::s-dup 映射必须精准回收');

  // 3. 未在 state.sessions 中索引的 Bot 主工位也受 isForeverChatSession 物理保护，不可移入文件夹
  const moveBlocked = await dupH.coordinator.moveEntityToFolder('session', 'unindexed-forever', 'fld-1', 'default');
  assert.equal(moveBlocked, false);

  // 4. getMoveEntityContext 对仅带 path 的活跃项目通过 cwd 命中 prj:<id>，并在移回未分类后转为 null
  const prjH = createHarness({
    state: {
      sessionsPhase: 'ready',
      projects: [{ id: 'p-work', name: 'WorkRepo', path: '/opt/data/workspace/work-repo', archived: false }],
      sessions: [
        {
          id: 'sess-in-prj',
          title: 'Project Session',
          botName: 'default',
          cwd: '/opt/data/workspace/work-repo/sub',
          isArchived: false,
          hidden: false,
        },
      ],
      profiles: [
        {
          name: 'default',
          displayName: 'Default',
          isDefault: true,
          uiMeta: {
            [FOLDERS_UI_META_KEY]: { version: 1, folders: [], assignments: {} },
            [DONE_ROOMS_UI_META_KEY]: { version: 1, done: {} },
          },
          uiMetaRevisions: { [FOLDERS_UI_META_KEY]: 1, [DONE_ROOMS_UI_META_KEY]: 1 },
        },
      ],
    },
  });
  prjH.coordinator.hydrateFromProfiles(prjH.state.profiles);
  const beforeCtx = prjH.coordinator.getMoveEntityContext('session', 'sess-in-prj', 'default');
  assert.equal(beforeCtx.currentContainerId, 'prj:p-work');
  assert.equal(beforeCtx.hasCwdProjectMatch, true);

  await prjH.coordinator.moveEntityToFolder('session', 'sess-in-prj', null, 'default');
  const afterCtx = prjH.coordinator.getMoveEntityContext('session', 'sess-in-prj', 'default');
  assert.equal(afterCtx.currentContainerId, null);
  assert.equal(afterCtx.hasCwdProjectMatch, true);

  // 5. setOrgPrefs 支持按项目开关 hiddenProjectIds 归一化去重并持久化到 storage
  prjH.coordinator.setOrgPrefs({ hiddenProjectIds: ['p-work', ' p-work ', '', 'p-other'] });
  assert.deepEqual(prjH.state.orgPrefs.hiddenProjectIds, ['p-work', 'p-other']);
  const storedRaw = JSON.parse(prjH.storageMap.get('hermes_flux_conversation_org_prefs'));
  assert.deepEqual(storedRaw.hiddenProjectIds, ['p-work', 'p-other']);
  prjH.coordinator.setOrgPrefs({ hiddenProjectIds: ['p-other'] });
  assert.deepEqual(prjH.state.orgPrefs.hiddenProjectIds, ['p-other']);
});
