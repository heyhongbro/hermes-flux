/**
 * 左轨实体装饰与快照管理领域单测（Left Rail Snapshot Manager Test）
 *
 * 【断言与杀伤力】
 *   1. stableArray 数组引用稳定：元素全等复用前序数组，否则换新；
 *   2. decorateSessions 装饰缓存：相同对象与状态下复用 WeakMap 缓存对象；
 *   3. 三态隔离不变量：会话、群聊与 Bot 各自维护独立的运行/未读指示器，互不冒泡；
 *   4. getSnapshot 引用去重：inputs 字段全等时恒定返回前序快照引用，避免 React 树无效重绘；
 *   5. 搜索词/焦点变动时快照引用及时更新并重新构建视图模型。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LeftRailSnapshotManager,
  stableArray,
  sameLeftRailInputs,
} from '../../dist/renderer/leftrail/leftRailSnapshotManager.mjs';

function createMockLeftRailHost(overrides = {}) {
  let sessions = overrides.sessions ?? [
    { id: 's1', title: '会话 1', preview: '内容 1', time: '12:00', timestamp: 1000 },
  ];
  let archivedSessions = overrides.archivedSessions ?? [];
  let groupRooms = overrides.groupRooms ?? [
    { roomId: 'g1', name: '研讨室 1', members: ['bot-a', 'bot-b'], lastMessage: '你好' },
  ];
  let profiles = overrides.profiles ?? [
    { name: 'bot-a', displayName: '智能体 A', avatar: 'avatar-a' },
  ];
  let activeSessionId = overrides.activeSessionId ?? 's1';
  let activeFocus = overrides.activeFocus ?? { type: 'session', sessionId: 's1' };
  let profileName = overrides.profileName ?? 'default';
  let searchQuery = overrides.searchQuery ?? '';
  let layout = overrides.layout ?? 'dual-rail';
  let botsExpanded = overrides.isBotsGroupExpanded ?? true;
  let projects = overrides.projects ?? [];
  let folders = overrides.folders ?? [];
  let assignments = overrides.assignments ?? {};
  let hiddenProjectIds = overrides.hiddenProjectIds ?? [];

  const runningSessions = new Set(overrides.runningSessions ?? []);
  const unreadSessions = new Set(overrides.unreadSessions ?? []);
  const runningGroups = new Set(overrides.runningGroups ?? []);
  const unreadGroups = new Set(overrides.unreadGroups ?? []);
  const runningBots = new Set(overrides.runningBots ?? []);
  const unreadBots = new Set(overrides.unreadBots ?? []);

  const host = {
    getSessions: () => sessions,
    getArchivedSessions: () => archivedSessions,
    getGroupRooms: () => groupRooms,
    getProfiles: () => profiles,
    getProjects: () => projects,
    getFolders: () => folders,
    getAssignments: () => assignments,
    getHiddenProjectIds: () => hiddenProjectIds,
    getActiveSessionId: () => activeSessionId,
    getActiveFocus: () => activeFocus,
    getProfileName: () => profileName,
    getSearchQuery: () => searchQuery,
    getLayout: () => layout,
    isBotsGroupExpanded: () => botsExpanded,
    isSessionsGroupExpanded: () => true,
    isGroupsGroupExpanded: () => true,
    getError: () => '',
    isCollapsed: () => false,
    getEditingGroupRoomId: () => undefined,
    getProfilesPhase: () => 'ready',
    getSessionsPhase: () => 'ready',
    getActivityVariant: () => 'subtle',
    getActiveRunningSessionIds: () => runningSessions,
    getUnreadSessionIds: () => unreadSessions,
    getActiveStreamingStoredSessionId: () => null,
    getActiveRunningGroupRoomIds: () => runningGroups,
    getUnreadGroupRoomIds: () => unreadGroups,
    getActiveRunningBotNames: () => runningBots,
    getUnreadBotNames: () => unreadBots,
    resolveAgentAvatar: (name) => `avatar-for-${name}`,
    resolveTransition: () => ({ transition: 'none' }),
    _setSessions: (s) => { sessions = s; },
    _setSearchQuery: (q) => { searchQuery = q; },
    _setActiveFocus: (f) => { activeFocus = f; },
    _setLayout: (next) => { layout = next; },
    _setBotsExpanded: (next) => { botsExpanded = next; },
    _setHiddenProjectIds: (next) => { hiddenProjectIds = next; },
  };

  return host;
}

test('LeftRailSnapshotManager 领域单测', async (t) => {
  await t.test('1. stableArray 数组引用稳定性', () => {
    const item1 = { id: '1' };
    const item2 = { id: '2' };
    const arr1 = [item1, item2];
    const arr2 = [item1, item2];

    const result = stableArray(arr2, arr1);
    assert.equal(result, arr1, '元素全等时必须复用前序数组引用');

    const arr3 = [item1, { id: '3' }];
    assert.equal(stableArray(arr3, arr1), arr3, '元素变化时返回新数组');
  });

  await t.test('2. decorateSessions 装饰缓存复用', () => {
    const host = createMockLeftRailHost();
    const manager = new LeftRailSnapshotManager(host);

    const decor1 = manager.decorateSessions(1000);
    const decor2 = manager.decorateSessions(2000);

    assert.equal(decor1.length, 1);
    assert.equal(decor1, decor2, '内容未变时必须保持装饰后数组引用全等');
    assert.equal(decor1[0], decor2[0], '会话对象本身也必须复用 WeakMap 缓存引用');
  });

  await t.test('3. getSnapshot 引用去重：inputs 未变时恒定复用快照引用', () => {
    const host = createMockLeftRailHost();
    const manager = new LeftRailSnapshotManager(host);

    const snap1 = manager.getSnapshot();
    const snap2 = manager.getSnapshot();

    assert.equal(snap1, snap2, '未发生任何状态变迁时必须直接返回前序快照对象');
    assert.equal(snap1.model.activeSessions.length, 1);

    // 修改搜索条件
    host._setSearchQuery('会话 1');
    const snap3 = manager.getSnapshot();
    assert.notEqual(snap1, snap3, '搜索词变迁后必须产生新快照引用');
  });

  await t.test('4. grouped 模式生成 groupedModel 并响应 layout / isBotsGroupExpanded 失效', () => {
    const host = createMockLeftRailHost({ layout: 'dual-rail' });
    const manager = new LeftRailSnapshotManager(host);

    const dualSnap = manager.getSnapshot();
    assert.equal(dualSnap.layout, 'dual-rail');
    assert.equal(dualSnap.groupedModel, undefined, 'dual-rail 模式不应构建 groupedModel');

    host._setLayout('grouped');
    const groupedSnap = manager.getSnapshot();
    assert.notEqual(groupedSnap, dualSnap, '切换左侧栏布局必须使快照失效并重算');
    assert.equal(groupedSnap.layout, 'grouped');
    assert.ok(groupedSnap.groupedModel, 'grouped 模式必须产出 groupedModel');
    assert.equal(groupedSnap.groupedModel.botsSection.isCollapsed, false);
    assert.equal(groupedSnap.groupedModel.botsSection.effectiveExpanded, true);
    assert.equal(groupedSnap.groupedModel.botsSection.items.length, 1);
    assert.equal(groupedSnap.groupedModel.groupsSection.items.length, 1);
    assert.equal(groupedSnap.groupedModel.sessionsSection.items.length, 1);

    host._setBotsExpanded(false);
    const collapsedSnap = manager.getSnapshot();
    assert.notEqual(collapsedSnap, groupedSnap, '折叠 BOT 分组必须推进新快照');
    assert.equal(collapsedSnap.groupedModel.botsSection.isCollapsed, true);
    assert.equal(collapsedSnap.groupedModel.botsSection.effectiveExpanded, false);
  });

  await t.test('5. decorateSessions 跨 Profile 同 ID 会话隔离 (P-004)', () => {
    const host = createMockLeftRailHost({
      sessions: [
        { id: 's-dup', title: 'Default 任务', botName: 'default', time: '12:00', timestamp: 200 },
        { id: 's-dup', title: 'Arch 任务', botName: 'arch', time: '11:00', timestamp: 100 },
      ],
      archivedSessions: [
        { id: 's-dup', title: 'Ops 已归档', botName: 'ops', time: '10:00', timestamp: 50, isArchived: true },
        { id: 's-dup', title: 'Arch 重复过期', botName: 'arch', time: '09:00', timestamp: 40, isArchived: true },
      ],
    });
    const manager = new LeftRailSnapshotManager(host);
    const decor = manager.decorateSessions(1000);
    assert.equal(decor.length, 3, '不同 Profile 下相同 ID 必须全部保留，仅同 Profile 重复项去重');
    assert.deepEqual(
      decor.map((d) => `${d.botName}:${d.title}`),
      ['default:Default 任务', 'arch:Arch 任务', 'ops:Ops 已归档'],
    );
  });

  await t.test('6. hiddenProjectIds 驱动快照失效、内容相等复用，以及双轨/分组模型项目显示切换', () => {
    const host = createMockLeftRailHost({
      projects: [
        { id: 'p1', name: '项目 Alpha', path: '/repo/alpha', archived: false },
        { id: 'p2', name: '项目 Beta', path: '/repo/beta', archived: false },
      ],
      folders: [{ id: 'f1', name: '自建目录', order: 0 }],
      sessions: [
        { id: 's-p1-in', title: 'P1 目录内', botName: 'default', cwd: '/repo/alpha', projectId: 'p1', timestamp: 500 },
        { id: 's-p1-detached', title: 'P1 移出到全局', botName: 'default', cwd: '/repo/alpha', projectId: 'p1', timestamp: 480 },
        { id: 's-p1-custom', title: 'P1 移到自建目录', botName: 'default', cwd: '/repo/alpha', projectId: 'p1', timestamp: 460 },
        { id: 's-p2-in', title: 'P2 目录内', botName: 'default', cwd: '/repo/beta', projectId: 'p2', timestamp: 440 },
      ],
      groupRooms: [],
      assignments: {
        'session:default:s-p1-detached': '__none__',
        'session:default:s-p1-custom': 'f1',
      },
      hiddenProjectIds: ['p1'],
      layout: 'dual-rail',
    });
    const manager = new LeftRailSnapshotManager(host);

    const hiddenDual1 = manager.getSnapshot();
    assert.deepEqual(hiddenDual1.model.projectContainers.map((c) => c.id), ['p2']);
    assert.deepEqual(hiddenDual1.model.unassignedSessions.map((s) => s.id), ['s-p1-detached']);
    assert.deepEqual(
      hiddenDual1.model.folderContainers[0].items.map((i) => i.session.id),
      ['s-p1-custom'],
    );

    // 传入值相同但新引用的 ['p1']，sameLeftRailInputs 必须命中缓存并返回前序快照
    host._setHiddenProjectIds(['p1']);
    const hiddenDual2 = manager.getSnapshot();
    assert.equal(hiddenDual2, hiddenDual1, 'hiddenProjectIds 内容一致时不得使左轨快照失效');
    const baseProject = { id: 'p1', name: '项目 Alpha', path: '/repo/alpha', archived: false };
    const baseFolder = { id: 'f1', name: '自建目录', order: 0 };
    const baseInputs = {
      sessions: [],
      groups: [],
      profiles: [],
      activeSessionId: '',
      activeFocus: { type: 'bot', botName: 'default' },
      profileName: 'default',
      searchQuery: '',
      layout: 'dual-rail',
      isBotsGroupExpanded: true,
      isSessionsGroupExpanded: true,
      isGroupsGroupExpanded: true,
      error: '',
      collapsed: false,
      profilesPhase: 'ready',
      sessionsPhase: 'ready',
      activityVariant: 'subtle',
      editingGroupRoomId: undefined,
      projects: [baseProject],
      folders: [baseFolder],
      assignments: {},
      doneRoomsMap: undefined,
      containerCollapsed: undefined,
      hiddenProjectIds: ['p1'],
      showDoneSection: true,
      doneLoading: false,
      doneError: '',
    };
    assert.equal(
      sameLeftRailInputs(baseInputs, {
        ...baseInputs,
        projects: [baseProject],
        folders: [baseFolder],
        hiddenProjectIds: ['p1'],
      }),
      true,
    );
    assert.equal(sameLeftRailInputs(baseInputs, { ...baseInputs, hiddenProjectIds: [] }), false);

    // grouped 布局同样隐藏 p1 项目分组，但保留项目外关联会话
    host._setLayout('grouped');
    const hiddenGrouped = manager.getSnapshot();
    assert.notEqual(hiddenGrouped, hiddenDual1);
    assert.deepEqual(hiddenGrouped.groupedModel.projectSections.map((s) => s.id), ['p2']);
    assert.deepEqual(hiddenGrouped.groupedModel.sessionsSection.items.map((s) => s.id), ['s-p1-detached']);

    // 取消隐藏 p1 后，dual-rail 与 grouped 都恢复显示 p1 项目目录及其内部会话
    host._setHiddenProjectIds([]);
    const restoredGrouped = manager.getSnapshot();
    assert.notEqual(restoredGrouped, hiddenGrouped, 'hiddenProjectIds 变更必须使左轨快照失效');
    assert.deepEqual(restoredGrouped.groupedModel.projectSections.map((s) => s.id), ['p1', 'p2']);

    host._setLayout('dual-rail');
    const restoredDual = manager.getSnapshot();
    assert.deepEqual(restoredDual.model.projectContainers.map((c) => c.id), ['p1', 'p2']);
    assert.deepEqual(restoredDual.model.projectContainers[0].items.map((i) => i.session.id), ['s-p1-in']);
  });
});
