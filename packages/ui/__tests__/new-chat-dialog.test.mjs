/**
 * 新建会话弹窗纯模型与 React 渲染契约测试（NewChatDialog + newChatModel）。
 *
 * 【测试覆盖】
 *   1. resolveDefaultBotName / resolveInitialGroupMembers / toggleGroupMember / buildAutoGroupTitle 边界、大小写去重；
 *   2. buildNewChatSubmitPayload：单聊省略标题/首句构造、群聊 <2 成员拦截、>=2 成员构包；
 *   3. NewChatDialog SSR 渲染：关闭态返回空、第一步直选 Agent 即生效（无标题框/输入框/确认按钮）+ 底部「发起多智能体群聊」入口、
 *      第二步多选成员 + 返回钮 + 确认创建、断线状态离线提示、无 profile 时回落默认助手、英文文案切换。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  NewChatDialog,
  buildAutoGroupTitle,
  createNewChatSubmitGate,
  resolveDefaultBotName,
  resolveInitialGroupMembers,
  resolveValidProjectId,
  shouldSubmitNewChatComposerKey,
  syncDialogSelectionOnProfiles,
  toggleGroupMember,
  buildNewChatSubmitPayload,
  setLocale,
} from '../dist/index.js';
import { CollageAvatar } from '../dist/components-react/RailEntityRow.js';

const PROFILES = [
  { name: 'default', displayName: 'Default 助理', description: '全能中枢', isDefault: true },
  { name: 'arch-wang', displayName: '架构老王', description: '分布式架构专家', isDefault: false },
  { name: 'qa-li', displayName: '测试小李', description: '质量守门员', isDefault: false },
];

const NOOP_ACTIONS = {
  onClose: () => {},
  onModeChange: () => {},
  onSubmit: () => {},
};

test('newChatModel 纯函数：默认 BOT、初始群成员、勾选去重、自动群名生成与提交载荷构造', () => {
  assert.equal(resolveDefaultBotName(PROFILES, 'ARCH-WANG'), 'arch-wang');
  assert.equal(resolveDefaultBotName(PROFILES, 'nonexistent'), 'default');
  assert.equal(resolveDefaultBotName([{ name: 'only', displayName: 'Only' }], ''), 'only');
  assert.equal(resolveDefaultBotName([], 'fallback'), 'fallback');
  assert.equal(resolveDefaultBotName([], ''), 'default');

  assert.deepEqual(resolveInitialGroupMembers(PROFILES, 'qa-li'), ['qa-li', 'default']);
  assert.deepEqual(resolveInitialGroupMembers([{ name: 'solo', displayName: 'Solo' }], ''), ['solo']);
  assert.deepEqual(resolveInitialGroupMembers([], ''), []);

  assert.deepEqual(toggleGroupMember(['default'], 'arch-wang'), ['default', 'arch-wang']);
  assert.deepEqual(toggleGroupMember(['default', 'arch-wang'], 'ARCH-WANG'), ['default']);
  assert.deepEqual(toggleGroupMember(['default'], '   '), ['default']);

  assert.equal(buildAutoGroupTitle([], PROFILES, '新研讨群聊'), '新研讨群聊');
  assert.equal(buildAutoGroupTitle(['   '], PROFILES, '新研讨群聊'), '新研讨群聊');
  assert.equal(buildAutoGroupTitle(['default', 'ARCH-WANG'], PROFILES, '新研讨群聊'), 'Default 助理 · 架构老王');
  assert.equal(
    buildAutoGroupTitle(['default', 'arch-wang', 'qa-li'], PROFILES, '新研讨群聊'),
    'Default 助理 · 架构老王 · 测试小李',
  );
  assert.equal(
    buildAutoGroupTitle(['default', 'arch-wang', 'qa-li', 'ops-zhao', 'Default'], PROFILES, '新研讨群聊'),
    'Default 助理 · 架构老王 · 测试小李 +1',
  );

  assert.deepEqual(
    buildNewChatSubmitPayload({
      mode: 'solo',
      selectedBot: 'arch-wang',
      selectedMembers: [],
      projectId: 'proj-1',
    }),
    {
      ok: true,
      payload: {
        mode: 'solo',
        agent: 'arch-wang',
        members: [],
        title: '',
        projectId: 'proj-1',
        firstMessage: '',
      },
    },
  );

  assert.deepEqual(
    buildNewChatSubmitPayload({
      mode: 'group',
      selectedBot: 'default',
      selectedMembers: ['default', 'DEFAULT'],
      title: '仅一人无效群',
      firstMessage: '',
    }),
    { ok: false, reason: 'need-two-members' },
  );

  assert.deepEqual(
    buildNewChatSubmitPayload({
      mode: 'group',
      selectedBot: 'default',
      selectedMembers: ['default', 'arch-wang', 'Default'],
      title: '  Default 助理 · 架构老王  ',
      projectId: 'proj-group-1',
      firstMessage: '',
    }),
    {
      ok: true,
      payload: {
        mode: 'group',
        agent: 'default',
        members: ['default', 'arch-wang'],
        title: 'Default 助理 · 架构老王',
        projectId: 'proj-group-1',
        firstMessage: '',
      },
    },
  );
});

test('NewChatDialog 渲染：两步极简选角/建群工作流（无手填名称框）、离线防护与多语言切换', () => {
  setLocale('zh-CN');

  const closed = renderToStaticMarkup(
    React.createElement(NewChatDialog, {
      snapshot: {
        isOpen: false,
        initialMode: 'solo',
        profiles: PROFILES,
        projects: [],
        selectedProfile: 'default',
        gatewayConnected: true,
      },
      actions: NOOP_ACTIONS,
    }),
  );
  assert.equal(closed, '', '关闭态不得输出任何 DOM');

  const soloWithProjects = renderToStaticMarkup(
    React.createElement(NewChatDialog, {
      snapshot: {
        isOpen: true,
        initialMode: 'solo',
        profiles: PROFILES,
        projects: [{ id: 'p1', name: 'Flux Repo', path: '/repo' }],
        selectedProfile: 'arch-wang',
        selectedProjectId: 'p1',
        gatewayConnected: true,
      },
      actions: NOOP_ACTIONS,
    }),
  );
  assert.ok(soloWithProjects.includes('data-testid="new-chat-dialog"'));
  assert.ok(soloWithProjects.includes('data-mode="solo"'));
  assert.ok(soloWithProjects.includes('data-new-chat-bot="default"'));
  assert.ok(soloWithProjects.includes('data-new-chat-bot="arch-wang"'));
  assert.ok(soloWithProjects.includes('data-testid="new-chat-start-group"'), '单聊列表底部必须提供发起多智能体群聊入口');
  assert.ok(soloWithProjects.includes('选择智能体'));
  assert.ok(soloWithProjects.includes('发起多智能体群聊'));
  assert.ok(soloWithProjects.includes('id="new-chat-project-select"'), '有项目时应保留工作区选择器');
  assert.ok(soloWithProjects.includes('data-tooltip="关闭新建窗口"'), '关闭按钮必须消费 Tooltip');
  assert.equal(soloWithProjects.includes('title="关闭新建窗口"'), false, '严禁渲染原生 title 黑块');
  assert.equal(soloWithProjects.includes('id="new-chat-title-input"'), false, '不再要求填写会话名称');
  assert.equal(soloWithProjects.includes('id="new-chat-composer-input"'), false, '不再在弹窗内放置额外输入框');
  assert.equal(soloWithProjects.includes('data-testid="new-chat-submit-btn"'), false, '点击 Agent 即生效，不得有确认按钮');

  const soloOfflineEmpty = renderToStaticMarkup(
    React.createElement(NewChatDialog, {
      snapshot: {
        isOpen: true,
        initialMode: 'solo',
        profiles: [],
        projects: [],
        selectedProfile: '',
        gatewayConnected: false,
      },
      actions: NOOP_ACTIONS,
    }),
  );
  assert.equal(soloOfflineEmpty.includes('id="new-chat-project-select"'), false, '无项目时不渲染多余下拉');
  assert.ok(soloOfflineEmpty.includes('当前未连接网关'), '断线时必须提示网关未连接');
  assert.ok(soloOfflineEmpty.includes('data-new-chat-bot="default"'), '无 profile 时应兜底展示 Default 助理');
  assert.ok(
    /disabled=""[^>]*data-new-chat-bot="default"|data-new-chat-bot="default"[^>]*disabled=""/.test(soloOfflineEmpty),
    '断线时 Agent 直选按钮必须禁用',
  );

  const groupView = renderToStaticMarkup(
    React.createElement(NewChatDialog, {
      snapshot: {
        isOpen: true,
        initialMode: 'group',
        profiles: PROFILES,
        projects: [],
        selectedProfile: 'default',
        gatewayConnected: true,
      },
      actions: NOOP_ACTIONS,
    }),
  );
  assert.ok(groupView.includes('data-mode="group"'));
  assert.ok(groupView.includes('data-testid="new-chat-back-btn"'), '群聊步必须提供返回上一步按钮');
  assert.ok(groupView.includes('data-tooltip="返回"'), '返回按钮必须消费 Tooltip');
  assert.ok(groupView.includes('data-tooltip="关闭新建窗口"'), '群聊关闭按钮必须消费 Tooltip');
  assert.equal(groupView.includes('title="关闭新建窗口"'), false, '群聊关闭按钮严禁渲染原生 title');
  assert.ok(groupView.includes('data-new-chat-member="default"'));
  assert.ok(groupView.includes('data-new-chat-member="arch-wang"'));
  assert.ok(groupView.includes('选择群聊成员'));
  assert.ok(groupView.includes('确认创建'));
  assert.ok(groupView.includes('至少选 2 位智能体'), '初始未选满 2 人时必须提示最少人数');
  assert.ok(
    /disabled=""[^>]*data-testid="new-chat-submit-btn"|data-testid="new-chat-submit-btn"[^>]*disabled=""/.test(groupView),
    '未选满 2 人时确认创建按钮必须禁用',
  );
  assert.equal(groupView.includes('id="new-chat-title-input"'), false, '群聊步同样不得出现名称输入框');
  assert.equal(groupView.includes('id="new-chat-composer-input"'), false, '群聊步不得出现开场白输入框');

  setLocale('en-US');
  const enSoloHtml = renderToStaticMarkup(
    React.createElement(NewChatDialog, {
      snapshot: {
        isOpen: true,
        initialMode: 'solo',
        profiles: PROFILES,
        projects: [],
        selectedProfile: 'default',
        gatewayConnected: true,
      },
      actions: NOOP_ACTIONS,
    }),
  );
  assert.ok(enSoloHtml.includes('New conversation'));
  assert.ok(enSoloHtml.includes('Choose an agent'));
  assert.ok(enSoloHtml.includes('Start group chat'));

  const enGroupHtml = renderToStaticMarkup(
    React.createElement(NewChatDialog, {
      snapshot: {
        isOpen: true,
        initialMode: 'group',
        profiles: PROFILES,
        projects: [],
        selectedProfile: 'default',
        gatewayConnected: true,
      },
      actions: NOOP_ACTIONS,
    }),
  );
  assert.ok(enGroupHtml.includes('Select group members'));
  assert.ok(enGroupHtml.includes('Create group'));
  setLocale('zh-CN');

  // 0 成员 CollageAvatar 必须渲染 SVG，严禁回退原生 👥 emoji
  const emptyCollageHtml = renderToStaticMarkup(
    React.createElement(CollageAvatar, { members: [], profiles: PROFILES, size: 36 }),
  );
  assert.ok(emptyCollageHtml.includes('<svg'), '0 成员拼贴头像必须渲染 SVG 矢量图标');
  assert.equal(emptyCollageHtml.includes('👥'), false, '严禁使用原生 👥 emoji');
});

test('newChatModel 交互纯函数：IME/Shift+Enter 防误触、项目有效性校验与冷启动 profiles 同步', () => {
  // 1. shouldSubmitNewChatComposerKey 四象限
  assert.equal(
    shouldSubmitNewChatComposerKey({ key: 'Enter', shiftKey: false, isComposing: false, keyCode: 13, canSubmit: true }),
    true,
  );
  assert.equal(
    shouldSubmitNewChatComposerKey({ key: 'Enter', shiftKey: true, isComposing: false, keyCode: 13, canSubmit: true }),
    false,
    'Shift+Enter 仅换行不得提交',
  );
  assert.equal(
    shouldSubmitNewChatComposerKey({ key: 'Enter', shiftKey: false, isComposing: true, keyCode: 13, canSubmit: true }),
    false,
    'IME isComposing 期间按 Enter 不得提交',
  );
  assert.equal(
    shouldSubmitNewChatComposerKey({ key: 'Enter', shiftKey: false, isComposing: false, keyCode: 229, canSubmit: true }),
    false,
    'Chromium keyCode=229 组合键输入不得提交',
  );
  assert.equal(
    shouldSubmitNewChatComposerKey({ key: 'Enter', shiftKey: false, isComposing: false, keyCode: 13, canSubmit: false }),
    false,
    '未连接或人数不足禁发时 Enter 不得提交',
  );

  // 2. resolveValidProjectId
  assert.equal(resolveValidProjectId([{ id: 'p1', name: 'P1' }], 'p1'), 'p1');
  assert.equal(resolveValidProjectId([{ id: 'p1', name: 'P1' }], 'deleted-p'), '');
  assert.equal(resolveValidProjectId([], 'p1'), '');

  // 3. syncDialogSelectionOnProfiles：异步拉回后未触碰时自动补全，已触碰时不覆盖用户选择
  assert.deepEqual(
    syncDialogSelectionOnProfiles({
      profiles: PROFILES,
      selectedProfile: 'arch-wang',
      currentBot: 'default',
      currentMembers: [],
      userTouched: false,
    }),
    { nextMembers: ['arch-wang', 'default'] },
  );
  assert.deepEqual(
    syncDialogSelectionOnProfiles({
      profiles: PROFILES,
      selectedProfile: 'arch-wang',
      currentBot: 'stale-bot',
      currentMembers: ['stale-bot'],
      userTouched: false,
    }),
    { nextBot: 'arch-wang', nextMembers: ['arch-wang', 'default'] },
  );
  assert.deepEqual(
    syncDialogSelectionOnProfiles({
      profiles: PROFILES,
      selectedProfile: 'arch-wang',
      currentBot: 'qa-li',
      currentMembers: ['qa-li'],
      userTouched: true,
    }),
    {},
    '用户手动修改后不得再被异步 profiles 覆盖',
  );

  // 4. createNewChatSubmitGate：并发重入互斥、令牌校验与跨周期 stale finally 隔离
  const gate = createNewChatSubmitGate();
  assert.equal(gate.isBusy(), false);
  const t1 = gate.begin();
  assert.equal(typeof t1, 'number');
  assert.equal(gate.isBusy(), true);
  assert.equal(gate.begin(), null, '在途提交期间重复点击必须被拦截');
  assert.equal(gate.end(t1 + 99), false, '不匹配的令牌不得错误解锁');
  assert.equal(gate.isBusy(), true);
  gate.reset();
  assert.equal(gate.isBusy(), false);
  const t2 = gate.begin();
  assert.notEqual(t2, t1);
  assert.equal(gate.end(t1), false, '关窗重开前在途请求 t1 的迟到 finally 绝不能解开新请求 t2');
  assert.equal(gate.isBusy(), true);
  assert.equal(gate.end(t2), true);
  assert.equal(gate.isBusy(), false);
});

test('NewChatDialog 1步项目选择：仅活跃项目可见、标签为「项目/默认」、无活跃项目自动隐藏', () => {
  setLocale('zh-CN');
  const onlyArchivedHtml = renderToStaticMarkup(
    React.createElement(NewChatDialog, {
      snapshot: {
        isOpen: true,
        initialMode: 'solo',
        profiles: PROFILES,
        projects: [{ id: 'arch-1', name: '已归档项目', path: '/old', archived: true }],
        selectedProfile: 'default',
        gatewayConnected: true,
      },
      actions: NOOP_ACTIONS,
    }),
  );
  assert.equal(onlyArchivedHtml.includes('id="new-chat-project-select"'), false, '仅有 archived 项目时应隐藏项目下拉');

  const mixedHtml = renderToStaticMarkup(
    React.createElement(NewChatDialog, {
      snapshot: {
        isOpen: true,
        initialMode: 'solo',
        profiles: PROFILES,
        projects: [
          { id: 'p-live', name: 'FluxLive', path: '/work/flux', archived: false },
          { id: 'p-arch', name: 'FluxOld', path: '/work/old', archived: true },
        ],
        selectedProfile: 'default',
        gatewayConnected: true,
      },
      actions: NOOP_ACTIONS,
    }),
  );
  assert.ok(mixedHtml.includes('id="new-chat-project-select"'));
  assert.ok(mixedHtml.includes('项目'));
  assert.ok(mixedHtml.includes('默认'));
  assert.equal(mixedHtml.includes('FluxOld'), false, '已归档项目不得出现在新建选择器');
  assert.equal(mixedHtml.includes('归属'), false);
  assert.equal(mixedHtml.includes('走网关默认配置'), false);

  const selectedProjHtml = renderToStaticMarkup(
    React.createElement(NewChatDialog, {
      snapshot: {
        isOpen: true,
        initialMode: 'solo',
        profiles: PROFILES,
        projects: [
          { id: 'p-live', name: 'FluxLive', path: '/work/flux', archived: false },
          { id: 'p-arch', name: 'FluxOld', path: '/work/old', archived: true },
        ],
        selectedProfile: 'default',
        selectedProjectId: 'p-live',
        gatewayConnected: true,
      },
      actions: NOOP_ACTIONS,
    }),
  );
  assert.ok(selectedProjHtml.includes('FluxLive'));

  const staleArchivedSelectionHtml = renderToStaticMarkup(
    React.createElement(NewChatDialog, {
      snapshot: {
        isOpen: true,
        initialMode: 'solo',
        profiles: PROFILES,
        projects: [
          { id: 'p-live', name: 'FluxLive', path: '/work/flux', archived: false },
          { id: 'p-arch', name: 'FluxOld', path: '/work/old', archived: true },
        ],
        selectedProfile: 'default',
        selectedProjectId: 'p-arch',
        gatewayConnected: true,
      },
      actions: NOOP_ACTIONS,
    }),
  );
  assert.equal(staleArchivedSelectionHtml.includes('FluxOld'), false, '选中已归档项目必须自动回退为「默认」');
  assert.ok(staleArchivedSelectionHtml.includes('默认'));

  setLocale('en-US');
  const enHtml = renderToStaticMarkup(
    React.createElement(NewChatDialog, {
      snapshot: {
        isOpen: true,
        initialMode: 'solo',
        profiles: PROFILES,
        projects: [{ id: 'p-live', name: 'FluxLive', path: '/work/flux' }],
        selectedProfile: 'default',
        gatewayConnected: true,
      },
      actions: NOOP_ACTIONS,
    }),
  );
  assert.ok(enHtml.includes('Project'));
  assert.ok(enHtml.includes('Default'));
  setLocale('zh-CN');
});

test('NewChatDialog 清除自定义文件夹绑定：点击 X 后提交载荷显式传 containerId: "" 且不回退旧目录', async () => {
  setLocale('zh-CN');
  // 1. buildNewChatSubmitPayload 保留显式传入的空 containerId，省略未传键
  const omittedOutcome = buildNewChatSubmitPayload({
    mode: 'solo',
    selectedBot: 'default',
    selectedMembers: [],
    projectId: '',
  });
  assert.equal(omittedOutcome.ok, true);
  assert.equal('containerId' in omittedOutcome.payload, false);

  const clearedOutcome = buildNewChatSubmitPayload({
    mode: 'solo',
    selectedBot: 'default',
    selectedMembers: [],
    projectId: '',
    containerId: '',
  });
  assert.equal(clearedOutcome.ok, true);
  assert.equal(clearedOutcome.payload.containerId, '', '显式清空时必须透传 containerId: ""');

  // 2. 运行真实 NewChatDialog 状态机：点击「移出当前文件夹」X 后再选 Bot，onSubmit 收到 containerId: ""
  const states = [];
  const refs = [];
  const memos = [];
  let sIdx = 0;
  let rIdx = 0;
  let mIdx = 0;
  const internals = React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const renderOnce = (elProps) => {
    sIdx = 0;
    rIdx = 0;
    mIdx = 0;
    const prevH = internals.H;
    internals.H = {
      useState(init) {
        const idx = sIdx++;
        if (idx >= states.length) states.push(typeof init === 'function' ? init() : init);
        return [
          states[idx],
          (next) => {
            states[idx] = typeof next === 'function' ? next(states[idx]) : next;
          },
        ];
      },
      useRef(init) {
        const idx = rIdx++;
        if (idx >= refs.length) refs.push({ current: init });
        return refs[idx];
      },
      useMemo(factory, deps) {
        const idx = mIdx++;
        if (idx >= memos.length) memos.push({ val: factory(), deps });
        else if (
          !deps ||
          !memos[idx].deps ||
          deps.length !== memos[idx].deps.length ||
          deps.some((d, i) => !Object.is(d, memos[idx].deps[i]))
        ) {
          memos[idx] = { val: factory(), deps };
        }
        return memos[idx].val;
      },
      useCallback(fn) {
        return fn;
      },
      useEffect() {},
      useLayoutEffect() {},
    };
    try {
      let node = NewChatDialog(elProps);
      if (node && typeof node.type === 'function') {
        node = node.type(node.props);
      }
      return node;
    } finally {
      internals.H = prevH;
    }
  };
  const collectElements = (node, pred, out = []) => {
    if (!node || typeof node !== 'object') return out;
    if (Array.isArray(node)) {
      for (const child of node) collectElements(child, pred, out);
      return out;
    }
    if (pred(node)) out.push(node);
    if (node.props?.children) collectElements(node.props.children, pred, out);
    return out;
  };

  const submitted = [];
  const dialogProps = {
    snapshot: {
      isOpen: true,
      initialMode: 'solo',
      profiles: PROFILES,
      projects: [],
      folders: [{ id: 'fld-1', name: '紧急修复', order: 0 }],
      selectedProfile: 'default',
      selectedContainerId: 'fld-1',
      gatewayConnected: true,
    },
    actions: {
      onClose: () => {},
      onModeChange: () => {},
      onSubmit: async (payload) => {
        submitted.push(payload);
        return { ok: true };
      },
    },
  };

  let tree = renderOnce(dialogProps);
  const clearBtn = collectElements(tree, (n) => n.props?.['aria-label'] === '移出当前文件夹')[0];
  assert.ok(clearBtn, '必须渲染带移出文件夹无障碍标签的清除按钮');
  assert.ok(String(clearBtn.props.className).includes('size-7'));
  assert.ok(String(clearBtn.props.className).includes('rounded-card'));

  clearBtn.props.onClick();
  tree = renderOnce(dialogProps);
  assert.equal(collectElements(tree, (n) => n.props?.['aria-label'] === '移出当前文件夹').length, 0);
  const botBtn = collectElements(tree, (n) => n.props?.['data-new-chat-bot'] === 'default')[0];
  assert.ok(botBtn);
  await botBtn.props.onClick();
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].containerId, '', '解绑后提交必须显式携带 containerId: ""');
});
