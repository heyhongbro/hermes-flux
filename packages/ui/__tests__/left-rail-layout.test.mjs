/**
 * 左侧栏布局偏好、单栏分组左轨模型与 GroupedLeftRail 组件全面单元测试。
 *
 * 【测试维度（四大象限 + 变异杀伤）】
 *   1. Token 层（tokens/leftRailLayout）：合法值收敛、脏值回退 'dual-rail'、localStorage 读写往返与异常降级、
 *      分组折叠状态解析/畸形 JSON 恢复、applyLeftRailLayout 根节点属性写入；
 *   2. 纯视图模型（buildGroupedLeftRailModel）：三段恒定排序（BOT -> 群聊 -> 普通会话）、
 *      Default 置顶、跨 Bot 全量会话聚合、普通会话继承归属 Bot 头像（含缺失回退默认 Bot）、
 *      搜索过滤与自动展开不篡改持久化折叠态、标题零数量、普通会话大标题恒无运行动画、
 *      仅当 BOT/群聊已折叠且含运行项时返回 headerStatus、跨 Bot 归档会话投影；
 *   3. React 渲染层（LeftRail + GroupedLeftRail）：grouped 态不渲染 #flux-station-rail、
 *      渲染显眼新建会话按钮 #rail-grouped-new-chat-btn、共用单一 RailEntityRow、
 *      折叠态 0px 收拢与把手隐藏、加载骨架态、群聊行内重命名表单、搜索空态、dual-rail 向后兼容。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  LEFT_RAIL_LAYOUTS,
  DEFAULT_LEFT_RAIL_LAYOUT,
  LEFT_RAIL_LAYOUT_STORAGE_KEY,
  GROUPED_RAIL_SECTIONS_STORAGE_KEY,
  DEFAULT_GROUPED_RAIL_SECTIONS,
  resolveLeftRailLayout,
  loadLeftRailLayout,
  saveLeftRailLayout,
  applyLeftRailLayout,
  loadGroupedRailSections,
  saveGroupedRailSections,
  buildGroupedLeftRailModel,
  buildLeftRailModel,
  renderContextMenu,
  renderLeftRailHtml,
  ReactLeftRail,
  setLocale,
} from '../dist/index.js';
import { RowTime } from '../dist/components-react/RailEntityRow.js';

const NOW = Date.UTC(2026, 10, 3, 15, 30);

const PROFILES = [
  {
    name: 'default',
    displayName: 'Default 助理',
    isDefault: true,
    avatar: 'data:image/png;base64,default-ava',
    lastMessage: '主中枢待命中',
    lastTime: '10:00',
    timestamp: NOW - 600_000,
    activityState: 'read',
  },
  {
    name: 'arch-wang',
    displayName: '架构老王',
    avatar: 'data:image/png;base64,wang-ava',
    description: '架构审校专家',
    lastMessage: 'WAL 锁已完成',
    timestamp: NOW - 120_000,
    activityState: 'running',
  },
];

const GROUPS = [
  {
    roomId: 'room-1',
    name: '架构攻关群',
    members: ['default', 'arch-wang'],
    lastMessage: '收敛最终接口方案',
    updatedAt: NOW - 30_000,
    activityState: 'running',
  },
  {
    roomId: 'room-2',
    name: '日常评审群',
    members: ['default'],
    lastMessage: '周会同步',
    updatedAt: NOW - 900_000,
    activityState: 'read',
  },
];

const SESSIONS = [
  {
    id: 's-default',
    title: '中枢排查会话',
    preview: '查看日志堆栈',
    botName: 'default',
    timestamp: NOW - 200_000,
    activityState: 'read',
  },
  {
    id: 's-wang',
    title: '老王专项任务',
    preview: '重构状态机并发',
    botName: 'arch-wang',
    timestamp: NOW - 10_000,
    activityState: 'running',
  },
  {
    id: 's-orphan',
    title: '遗失归属会话',
    preview: '回落默认头像',
    botName: 'deleted-bot',
    timestamp: NOW - 400_000,
    activityState: 'unread',
  },
  {
    id: 's-pinned',
    title: '置顶常规会话',
    preview: '永久置顶',
    botName: 'arch-wang',
    timestamp: NOW - 800_000,
    isPinned: true,
    activityState: 'read',
  },
  {
    id: 's-archived',
    title: '历史归档会话',
    preview: '不再活跃',
    botName: 'arch-wang',
    timestamp: NOW - 900_000,
    isArchived: true,
  },
  {
    id: 's-hidden-bot-forever',
    title: 'Bot 终身主工位内部会话',
    preview: '绝对隔离',
    botName: 'default',
    timestamp: NOW - 1_000,
    hidden: true,
  },
  {
    id: 's-subagent-internal',
    title: '子代理派生工作会话',
    preview: '禁止出现在普通会话列表',
    botName: 'default',
    timestamp: NOW - 2_000,
    isSubagent: true,
    isArchived: true,
  },
];

test('leftRailLayout token：合法值收敛、存储往返、损坏 JSON 恢复与根节点属性写入', () => {
  assert.deepEqual([...LEFT_RAIL_LAYOUTS], ['dual-rail', 'grouped']);
  assert.equal(DEFAULT_LEFT_RAIL_LAYOUT, 'dual-rail');
  assert.equal(resolveLeftRailLayout('grouped'), 'grouped');
  assert.equal(resolveLeftRailLayout('dual-rail'), 'dual-rail');
  for (const bogus of [null, undefined, '', 'classic', 'mobile', 123]) {
    assert.equal(resolveLeftRailLayout(bogus), 'dual-rail');
  }

  const hadStorage = 'localStorage' in globalThis;
  const prevStorage = globalThis.localStorage;
  try {
    delete globalThis.localStorage;
    assert.equal(loadLeftRailLayout(), 'dual-rail');
    assert.doesNotThrow(() => saveLeftRailLayout('grouped'));
    assert.deepEqual(loadGroupedRailSections(), DEFAULT_GROUPED_RAIL_SECTIONS);
    assert.doesNotThrow(() => saveGroupedRailSections({ bots: false, groups: true, sessions: false }));

    const store = new Map();
    globalThis.localStorage = {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => {
        store.set(k, v);
      },
    };
    saveLeftRailLayout('grouped');
    assert.equal(store.get(LEFT_RAIL_LAYOUT_STORAGE_KEY), 'grouped');
    assert.equal(loadLeftRailLayout(), 'grouped');
    saveLeftRailLayout('dirty-val');
    assert.equal(loadLeftRailLayout(), 'dual-rail');

    saveGroupedRailSections({ bots: false, groups: true, sessions: false });
    assert.deepEqual(loadGroupedRailSections(), { bots: false, groups: true, sessions: false });
    store.set(GROUPED_RAIL_SECTIONS_STORAGE_KEY, '{corrupt-json');
    assert.deepEqual(loadGroupedRailSections(), { bots: true, groups: true, sessions: true });
    store.set(GROUPED_RAIL_SECTIONS_STORAGE_KEY, JSON.stringify({ bots: 'nope', groups: false }));
    assert.deepEqual(loadGroupedRailSections(), { bots: true, groups: false, sessions: true });

    globalThis.localStorage = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    assert.equal(loadLeftRailLayout(), 'dual-rail');
    assert.doesNotThrow(() => saveLeftRailLayout('grouped'));
    assert.deepEqual(loadGroupedRailSections(), { bots: true, groups: true, sessions: true });
    assert.doesNotThrow(() => saveGroupedRailSections({ bots: false, groups: false, sessions: true }));
  } finally {
    if (hadStorage) globalThis.localStorage = prevStorage;
    else delete globalThis.localStorage;
  }

  const attrs = new Map();
  const root = { setAttribute: (k, v) => attrs.set(k, v) };
  assert.equal(applyLeftRailLayout('grouped', root), 'grouped');
  assert.equal(attrs.get('data-left-rail-layout'), 'grouped');
  assert.equal(applyLeftRailLayout('invalid', root), 'dual-rail');
  assert.equal(attrs.get('data-left-rail-layout'), 'dual-rail');
  assert.equal(applyLeftRailLayout('grouped', null), 'grouped');
});

test('buildGroupedLeftRailModel：三段排序、头像继承、标题状态约束与搜索自动展开', () => {
  const model = buildGroupedLeftRailModel({
    activeSessionId: 's-wang',
    activeFocus: { type: 'session', sessionId: 's-wang' },
    profiles: PROFILES,
    groups: GROUPS,
    sessions: SESSIONS,
    profileName: 'default',
    searchQuery: '',
    isBotsGroupExpanded: true,
    isGroupsGroupExpanded: true,
    isSessionsGroupExpanded: true,
    nowMs: NOW,
  });

  // 1. Default Bot 置顶，其余按 timestamp 排序
  assert.deepEqual(
    model.botsSection.items.map((item) => item.id),
    ['default', 'arch-wang'],
  );
  assert.equal(model.botsSection.titleKey, 'rail.sectionBots');
  assert.equal(model.groupsSection.titleKey, 'rail.sectionGroups');
  assert.equal(model.sessionsSection.titleKey, 'rail.sectionSessions');

  // 2. 跨 Bot 普通会话全量聚合（置顶优先，其后时间倒序），禁止隔离掉 arch-wang 的会话
  assert.deepEqual(
    model.sessionsSection.items.map((item) => item.id),
    ['s-pinned', 's-wang', 's-default', 's-orphan'],
  );

  // 3. 普通会话强制继承归属 Bot 头像，缺失 Bot 回退默认 Bot
  const wangRow = model.sessionsSection.items.find((item) => item.id === 's-wang');
  const orphanRow = model.sessionsSection.items.find((item) => item.id === 's-orphan');
  assert.equal(wangRow?.ownerAvatarUrl, 'data:image/png;base64,wang-ava');
  assert.equal(wangRow?.isActive, true);
  assert.equal(orphanRow?.ownerBotName, 'default');
  assert.equal(orphanRow?.ownerAvatarUrl, 'data:image/png;base64,default-ava');

  // 4. 归档会话跨 Bot 正常投影，同时严格隔离 hidden 主工位与 isSubagent 子代理会话
  assert.deepEqual(
    model.archivedSessions.map((item) => item.id),
    ['s-archived'],
  );
  assert.equal(model.archivedSessions[0].ownerAvatarUrl, 'data:image/png;base64,wang-ava');
  assert.equal(
    model.sessionsSection.items.some((i) => i.id === 's-hidden-bot-forever' || i.id === 's-subagent-internal'),
    false,
    'hidden 与 isSubagent 会话绝不能渗入普通会话列表',
  );
  assert.equal(
    model.archivedSessions.some((i) => i.id === 's-hidden-bot-forever' || i.id === 's-subagent-internal'),
    false,
    'hidden 与 isSubagent 会话绝不能渗入归档列表',
  );

  // 5. 标题状态灯规则：展开时全部为 null；全部折叠且均有 running 项时，仅 BOT/群聊亮，普通会话恒为 null
  assert.equal(model.botsSection.headerStatus, null);
  assert.equal(model.groupsSection.headerStatus, null);
  assert.equal(model.sessionsSection.headerStatus, null);

  const collapsedModel = buildGroupedLeftRailModel({
    activeSessionId: 's-wang',
    profiles: PROFILES,
    groups: GROUPS,
    sessions: SESSIONS,
    profileName: 'default',
    searchQuery: '',
    isBotsGroupExpanded: false,
    isGroupsGroupExpanded: false,
    isSessionsGroupExpanded: false,
    nowMs: NOW,
  });
  assert.equal(collapsedModel.botsSection.headerStatus?.state, 'running');
  assert.equal(collapsedModel.groupsSection.headerStatus?.state, 'running');
  assert.equal(collapsedModel.sessionsSection.headerStatus, null, '普通会话折叠且含运行项时大标题也绝不允许显示状态动画');

  // 6. 搜索非空且有命中项时自动展开，但不篡改 isCollapsed 字段
  const searchModel = buildGroupedLeftRailModel({
    activeSessionId: 's-wang',
    profiles: PROFILES,
    groups: GROUPS,
    sessions: SESSIONS,
    profileName: 'default',
    searchQuery: '老王专项',
    isBotsGroupExpanded: false,
    isGroupsGroupExpanded: false,
    isSessionsGroupExpanded: false,
    nowMs: NOW,
  });
  assert.equal(searchModel.isSearching, true);
  assert.equal(searchModel.sessionsSection.isCollapsed, false ? false : true);
  assert.equal(searchModel.sessionsSection.effectiveExpanded, true);
  assert.equal(searchModel.groupsSection.effectiveExpanded, false);
  assert.equal(searchModel.hasAnyResult, true);

  const missModel = buildGroupedLeftRailModel({
    activeSessionId: '',
    profiles: PROFILES,
    groups: GROUPS,
    sessions: SESSIONS,
    profileName: 'default',
    searchQuery: '完全不存在',
    nowMs: NOW,
  });
  assert.equal(missModel.hasAnyResult, false);
});

test('GroupedLeftRail 渲染契约：无独立 BOT 边栏、含新建会话按钮、三段顺序无数字计数、折叠 0px', () => {
  setLocale('zh-CN');
  const html = renderLeftRailHtml({
    layout: 'grouped',
    activeSessionId: 's-wang',
    activeFocus: { type: 'session', sessionId: 's-wang' },
    sessions: SESSIONS,
    profileName: 'default',
    profiles: PROFILES,
    groups: GROUPS,
    searchQuery: '',
    collapsed: false,
    isBotsGroupExpanded: true,
    isGroupsGroupExpanded: true,
    isSessionsGroupExpanded: true,
  });

  assert.equal(html.includes('id="flux-station-rail"'), false, '分组模式必须去掉独立 BOT 微轨边栏');
  assert.ok(html.includes('data-rail-layout="grouped"'), '容器必须标记 data-rail-layout="grouped"');
  assert.ok(html.includes('id="rail-grouped-new-chat-btn"'), '分组模式顶部必须有圆形新建会话按钮');
  assert.ok(html.includes('data-tooltip="新建会话"'), '圆形新建会话按钮必须挂 Tooltip');
  assert.ok(html.includes('aria-label="新建会话"'), '圆形新建会话按钮必须带无障碍标签');
  assert.ok(html.includes('rounded-full'), '搜索框与新建按钮必须采用统一胶囊/圆形造型');
  assert.ok(html.includes('id="session-search-input"'), '搜索框必须在位');
  assert.ok(html.includes('aria-controls="rail-bots-nested-list"'));
  assert.ok(html.includes('aria-controls="rail-groups-nested-list"'));
  assert.ok(html.includes('aria-controls="rail-sessions-nested-list"'));
  assert.ok(html.includes('历史归档会话'), '归档区必须渲染跨 Bot 归档条目');
  assert.equal(html.includes('Bot 终身主工位内部会话'), false, 'hidden 会话严禁渲染进分组左轨');
  assert.equal(html.includes('text-faint'), false, '分组左轨严禁使用低对比度 text-faint');

  // 三段展示顺序：BOT -> 群聊 -> 普通会话，且大标题不含数量括号
  const botsAt = html.indexOf('id="rail-bots-accordion-trigger"');
  const groupsAt = html.indexOf('id="rail-groups-accordion-trigger"');
  const sessionsAt = html.indexOf('id="rail-sessions-accordion-trigger"');
  assert.ok(botsAt > 0 && groupsAt > botsAt && sessionsAt > groupsAt, '三段分组顺序必须为 BOT -> 群聊 -> 普通会话');
  assert.equal(html.includes('BOT ('), false, '分组标题不得带数量数字');
  assert.equal(html.includes('普通会话 ('), false, '普通会话标题不得带数量数字');

  // 普通会话行继承归属 Bot 头像（s-wang 行内包含 wang-ava）
  const sWangStart = html.indexOf('data-id="s-wang"');
  const sWangEnd = html.indexOf('</button>', sWangStart);
  assert.ok(html.slice(sWangStart, sWangEnd).includes('wang-ava'), '普通会话行必须继承显示所属 Bot 头像');

  // 折叠态彻底收拢为 0px，不渲染把手与内容抽屉
  const collapsedHtml = renderLeftRailHtml({
    layout: 'grouped',
    activeSessionId: 's-wang',
    sessions: SESSIONS,
    profileName: 'default',
    profiles: PROFILES,
    groups: GROUPS,
    searchQuery: '',
    collapsed: true,
  });
  assert.ok(collapsedHtml.includes('rail-collapsed'));
  assert.ok(collapsedHtml.includes('width:0px'));
  assert.equal(collapsedHtml.includes('rail-resize-handle'), false);
  assert.equal(collapsedHtml.includes('rail-grouped-new-chat-btn'), false);

  // 加载骨架态 & 行内重命名态 & 经典模式不回归
  const loadingHtml = renderLeftRailHtml({
    layout: 'grouped',
    activeSessionId: '',
    sessions: [],
    profileName: 'default',
    profiles: [],
    groups: [],
    searchQuery: '',
    collapsed: false,
    profilesPhase: 'loading',
    sessionsPhase: 'loading',
  });
  assert.ok(loadingHtml.includes('data-skeleton="bot"'));
  assert.ok(loadingHtml.includes('data-skeleton="session"'));

  const renamingHtml = renderLeftRailHtml({
    layout: 'grouped',
    activeSessionId: '',
    sessions: SESSIONS,
    profileName: 'default',
    profiles: PROFILES,
    groups: GROUPS,
    searchQuery: '',
    collapsed: false,
    editingGroupRoomId: 'room-1',
  });
  assert.ok(renamingHtml.includes('id="rail-group-rename-input-room-1"'));

  const classicHtml = renderLeftRailHtml({
    layout: 'dual-rail',
    activeSessionId: 's-default',
    sessions: SESSIONS,
    profileName: 'default',
    profiles: PROFILES,
    groups: GROUPS,
    searchQuery: '',
    collapsed: false,
  });
  assert.ok(classicHtml.includes('id="flux-station-rail"'), '经典双轨模式必须完全保持原样可用');

  // 无 groupedModel 传参即使传 grouped 也安全回落经典双轨不崩
  const safeFallback = renderToStaticMarkup(
    React.createElement(ReactLeftRail, {
      model: buildLeftRailModel({
        activeSessionId: '',
        sessions: [],
        profileName: 'default',
        profiles: PROFILES,
        groups: [],
        searchQuery: '',
      }),
      layout: 'grouped',
      collapsed: false,
      searchQuery: '',
      onSelectSession: () => {},
      onSelectBot: () => {},
      onSelectGroup: () => {},
      onOpenSessionMenu: () => {},
      onOpenBotMenu: () => {},
      onOpenGroupMenu: () => {},
      onSearchChange: () => {},
      onNewChat: () => {},
      onToggleSessions: () => {},
      onToggleGroups: () => {},
      onStartGroupRename: () => {},
      onConfirmGroupRename: () => {},
      onCancelGroupRename: () => {},
      onResizeStart: () => {},
    }),
  );
  assert.ok(safeFallback.includes('id="flux-station-rail"'));

  // 错误态横幅 / 三段空态 / 搜索无果态 / 无障碍与异常时间戳守卫
  const emptyErrorHtml = renderLeftRailHtml({
    layout: 'grouped',
    activeSessionId: '',
    sessions: [],
    profileName: 'default',
    profiles: [],
    groups: [],
    searchQuery: '',
    collapsed: false,
    error: '网关握手超时',
  });
  assert.ok(emptyErrorHtml.includes('id="session-list-error"'));
  assert.ok(emptyErrorHtml.includes('网关握手超时'));
  assert.ok(emptyErrorHtml.includes('暂无可用 BOT'));
  assert.ok(emptyErrorHtml.includes('暂无协同群聊'));
  assert.ok(emptyErrorHtml.includes('暂时无法显示历史会话'));
  assert.equal(emptyErrorHtml.includes('text-faint'), false, '错误/空态说明文案严禁退回低对比度 text-faint');

  const noSearchHitHtml = renderLeftRailHtml({
    layout: 'grouped',
    activeSessionId: '',
    sessions: SESSIONS,
    profileName: 'default',
    profiles: PROFILES,
    groups: GROUPS,
    searchQuery: '不存在的检索关键字',
    collapsed: false,
  });
  assert.ok(noSearchHitHtml.includes('未找到匹配的会话或 BOT'));

  assert.doesNotThrow(() => {
    renderToStaticMarkup(React.createElement(RowTime, { timestamp: Number.NaN, fallback: '刚才' }));
    renderToStaticMarkup(React.createElement(RowTime, { timestamp: Number.POSITIVE_INFINITY, fallback: '未知' }));
  }, 'RowTime 对 NaN / Infinity 异常时间戳不得抛出 RangeError');
});

test('桌面左轨扁平顶级组织、行内 hover 完成/恢复胶囊（Bot 免疫）与底部无计数已完成抽屉', () => {
  setLocale('zh-CN');
  const orgInput = {
    layout: 'grouped',
    activeSessionId: 's-default',
    sessions: [
      ...SESSIONS,
      { id: 's-proj', title: '项目自动匹配会话', preview: 'cwd test', botName: 'default', cwd: '/work/flux/sub', timestamp: NOW - 5_000, activityState: 'read' },
      { id: 's-fld', title: '自定义目录会话', preview: 'fld test', botName: 'default', timestamp: NOW - 15_000, activityState: 'read' },
      { id: 's-archived-1', title: '已收工任务', preview: 'finished', botName: 'default', isArchived: true, timestamp: NOW - 50_000 },
    ],
    profileName: 'default',
    profiles: PROFILES,
    groups: [
      { roomId: 'room-1', name: '进行中群聊', members: ['default', 'arch-wang'], updatedAt: NOW - 30_000, activityState: 'running' },
      { roomId: 'room-done', name: '已完成群聊', members: ['default', 'arch-wang'], updatedAt: NOW - 80_000, activityState: 'read' },
    ],
    projects: [{ id: 'p-flux', name: 'FluxProject', path: '/work/flux', archived: false }],
    folders: [{ id: 'fld-1', name: '重要收件箱', order: 0 }],
    assignments: { 'session:default:s-fld': 'fld-1' },
    doneRoomsMap: { 'room-done': NOW - 70_000 },
    showDoneSection: true,
    searchQuery: '',
    collapsed: false,
    onRequestMarkDone: () => {},
    onRestoreDone: () => {},
    onToggleContainer: () => {},
  };

  const html = renderLeftRailHtml(orgInput);
  // 1. 新建会话旁边严禁渲染独立的新建文件夹按钮
  assert.equal(html.includes('new-folder-btn'), false);
  // 2. 扁平顶级结构：Bot -> Project -> Folder -> Groups -> Sessions -> Done 抽屉
  const botIdx = html.indexOf('data-profile="default"');
  const prjIdx = html.indexOf('data-container-id="prj:p-flux"');
  const fldIdx = html.indexOf('data-container-id="fld-1"');
  const doneIdx = html.indexOf('data-section="done"');
  assert.ok(botIdx !== -1 && prjIdx !== -1 && fldIdx !== -1 && doneIdx !== -1);
  assert.ok(botIdx < prjIdx && prjIdx < fldIdx && fldIdx < doneIdx);

  // 3. 普通会话与群聊渲染 sibling hover 完成胶囊（图标 + 文案，min-h-7 且绝不嵌套在行 button 内），Bot 主工位严格免疫
  const botButtonMatch = html.match(/<button[^>]*data-profile="default"[\s\S]*?<\/button>/);
  assert.ok(botButtonMatch);
  assert.equal(botButtonMatch[0].includes('data-row-hover-action='), false, 'Bot 行绝不可渲染完成/恢复胶囊');
  const sessionButtonBlocks = html.match(/<button[^>]*class="[^"]*session-item[^"]*"[^>]*>[\s\S]*?<\/button>/g) || [];
  assert.ok(sessionButtonBlocks.length > 0);
  assert.equal(
    sessionButtonBlocks.some((block) => block.includes('data-row-hover-action=')),
    false,
    '完成胶囊必须作为兄弟 button 渲染，严禁嵌套交互元素',
  );
  assert.match(html, /<button[^>]*data-row-hover-action="done"[^>]*class="[^"]*\bmin-h-7\b[^"]*"/);
  assert.ok(html.includes('data-row-hover-action="restore"'));
  const addFldBtnMatch = html.match(/<button[^>]*data-testid="rail-container-add-fld-1"[^>]*>/);
  assert.ok(addFldBtnMatch);
  assert.match(addFldBtnMatch[0], /\bafter:-inset-1\b/);
  assert.match(addFldBtnMatch[0], /\brounded-card\b/);

  // 4. 右键菜单：同时呈现活跃项目 (prj:) 与自定义文件夹，且允许移出当前归属（含项目归属解绑）
  const prjGroupMenuHtml = renderContextMenu({
    x: 0,
    y: 0,
    targetType: 'group',
    targetId: 'g-proj',
    targetName: '项目群聊',
    currentContainerId: 'prj:p-flux',
    projects: [{ id: 'p-flux', name: 'FluxProject' }],
    folders: [{ id: 'fld-1', name: '紧急修复' }],
  });
  assert.ok(prjGroupMenuHtml.includes('data-action="move-folder:prj:p-flux"'), '会话/群聊右键菜单必须呈现活跃项目');
  assert.ok(prjGroupMenuHtml.includes('ctx-item--active'), '当前归属项目项必须高亮勾选');
  assert.ok(prjGroupMenuHtml.includes('move-folder:__unassign__'), '项目归属项也允许移出回到默认列表');
  const fldSessionMenuHtml = renderContextMenu({
    x: 0,
    y: 0,
    targetType: 'session',
    targetId: 's-1',
    targetName: '会话',
    currentContainerId: 'fld-1',
    projects: [{ id: 'p-flux', name: 'FluxProject' }],
    folders: [{ id: 'fld-1', name: '紧急修复' }],
  });
  assert.ok(fldSessionMenuHtml.includes('move-folder:__unassign__'));
  assert.ok(fldSessionMenuHtml.includes('move-folder:prj:p-flux'));
  const botMenuHtml = renderContextMenu({
    x: 0,
    y: 0,
    targetType: 'bot',
    targetId: 'default',
    targetName: 'Default',
    projects: [{ id: 'p-flux', name: 'FluxProject' }],
    folders: [{ id: 'fld-1', name: '紧急修复' }],
  });
  assert.equal(botMenuHtml.includes('new-folder'), false, 'Bot 右键菜单严禁出现新建文件夹');
  assert.equal(botMenuHtml.includes('move-folder:'), false, 'Bot 右键菜单严禁出现移动到文件夹');

  // 4. 底部已完成区默认折叠且禁止显示数字角标
  assert.match(html, /data-section="done"[^>]*data-expanded="false"/);
  assert.equal(/>已完成\s*\(\d+\)/.test(html), false, '已完成标题严禁附带计数数字');

  // 5. 搜索命中时自动展开已完成区，关闭开关则彻底隐藏
  const searchHtml = renderLeftRailHtml({ ...orgInput, searchQuery: '已收工' });
  assert.match(searchHtml, /data-section="done"[^>]*data-expanded="true"/);

  const hiddenDoneHtml = renderLeftRailHtml({ ...orgInput, showDoneSection: false });
  assert.equal(hiddenDoneHtml.includes('data-section="done"'), false);
});
