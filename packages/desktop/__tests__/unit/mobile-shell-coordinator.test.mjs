/**
 * 移动端表现壳薄协调适配器（MobileShellCoordinator）全量行为单测
 * (packages/desktop/__tests__/unit/mobile-shell-coordinator.test.mjs)
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MOBILE_APPEARANCE_STORAGE_KEY,
  MOBILE_SECTIONS_STORAGE_KEY,
  createMobileShellCoordinator,
} from '../../dist/renderer/mobile/mobileShellCoordinator.mjs';

function createMemoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem(k) {
      return map.has(k) ? map.get(k) : null;
    },
    setItem(k, v) {
      map.set(k, String(v));
    },
  };
}

function createHarness(overrides = {}) {
  const calls = [];
  const state = {
    platform: 'android',
    appVersion: '0.1.0',
    theme: 'obsidian-gold',
    lang: 'zh',
    gatewayConnected: true,
    gatewayConnecting: false,
    profileName: 'arch',
    sessionSearchQuery: '',
    isSettingsOpen: false,
    settingsSection: 'appearance',
    activeFocus: { type: 'session', sessionId: 's-1' },
    activeSessionId: 's-1',
    isStreaming: false,
    messages: [{ id: 'm1', role: 'assistant', content: 'hi' }],
    selectedModel: 'anthropic/claude-sonnet-4',
    availableModels: ['anthropic/claude-sonnet-4'],
    modelDetails: [{ id: 'anthropic/claude-sonnet-4', provider: 'anthropic', name: 'Claude', displayName: 'Claude 4' }],
    attachments: [{ id: 'att-1', name: 'doc.md', type: 'file' }],
    dockNotice: '',
    artifacts: [{ id: 'a1', name: 'out.md', type: 'md', size: '1KB' }],
    gitDiffs: [],
    openFiles: [],
    activeFilePath: '',
    fileTreeState: { status: 'idle' },
    fileTreeExpandedPaths: [],
    fileTreeFilterQuery: '',
    memories: [],
    learningState: { status: 'idle' },
    learningDetail: { status: 'idle' },
    groupRooms: [{ roomId: 'g-1', name: '架构群', members: ['arch', 'ops-external'] }],
    profiles: [
      { name: 'default', displayName: '默认', isDefault: true, avatar: 'av://default' },
      { name: 'arch', displayName: '架构老王', avatar: 'av://arch' },
    ],
    sessions: [{ id: 's-1', title: '会话1', botName: 'arch' }],
    sideAgentCapsules: [{ id: 'c1', kind: 'btw', profile: 'arch', question: 'q', answer: 'a', status: 'done' }],
    settingsMcp: { status: 'ready', data: [{ name: 'fs' }] },
    settingsSkills: { status: 'ready', data: [{ name: 'git' }, { name: 'gh' }] },
    profilesPhase: 'ready',
    sessionsPhase: 'ready',
    botManagementDetail: {
      id: 'arch',
      displayName: '架构老王',
      description: 'desc',
      model: '',
      provider: '',
      soul: '',
      isDefault: false,
      toolsets: { authoritative: true, rows: [{ id: 't1', label: 't1', enabled: true }, { id: 't2', label: 't2', enabled: false }] },
      mcpServers: { authoritative: true, rows: [{ id: 'm1', label: 'm1', enabled: true }] },
      skills: { authoritative: true, rows: [{ id: 'sk1', label: 'sk1', enabled: true }] },
    },
    ...(overrides.state || {}),
  };

  const deps = {
    getState: () => state,
    render: () => calls.push(['render']),
    leftRailController: {
      decorateRailProfiles: () => state.profiles,
      decorateRailGroups: () => state.groupRooms,
      decorateRailSessions: () => state.sessions,
    },
    resolveAgentAvatar: (name) => `fallback-av://${name || 'none'}`,
    selectSession: async (id, opts) => calls.push(['selectSession', id, opts]),
    openBotChat: async (p) => calls.push(['openBotChat', p]),
    openGroupRoom: async (id) => calls.push(['openGroupRoom', id]),
    createNewSession: async (opts) => {
      calls.push(['createNewSession', opts]);
      return 'sess-created';
    },
    renameSession: async (id, cur, next) => calls.push(['renameSession', id, cur, next]),
    pinSession: async (id) => calls.push(['pinSession', id]),
    archiveSession: async (id) => calls.push(['archiveSession', id]),
    deleteSession: async (id) => calls.push(['deleteSession', id]),
    createGroupRoom: async (title, members) => {
      calls.push(['createGroupRoom', title, members]);
      return { room: { room_id: 'room-new' } };
    },
    confirmGroupRename: async (id, n) => calls.push(['confirmGroupRename', id, n]),
    disbandGroupRoom: async (id) => calls.push(['disbandGroupRoom', id]),
    fetchGroupRooms: async () => calls.push(['fetchGroupRooms']),
    routeSend: async (t) => calls.push(['routeSend', t]),
    sendGroupMessage: async (id, t) => calls.push(['sendGroupMessage', id, t]),
    interruptTurn: async () => calls.push(['interruptTurn']),
    switchModel: async (m, p) => calls.push(['switchModel', m, p]),
    getSettingsSnapshot: () => ({ gateway: { url: 'http://gw', username: 'u', status: 'connected' } }),
    createSettingsActions: () => ({ onClose() {} }),
    ensureSettingsSectionData: (sec, force) => calls.push(['ensureSettingsSectionData', sec, force]),
    copyText: async (txt) => {
      calls.push(['copyText', txt]);
      return true;
    },
    onStageReady: () => calls.push(['onStageReady']),
    syncReactMessageList: (f) => calls.push(['syncReactMessageList', f]),
    syncAgentPresenceHost: () => calls.push(['syncAgentPresenceHost']),
    syncAgentPresence: () => calls.push(['syncAgentPresence']),
    syncStatusBarAppearance: (ap) => calls.push(['syncStatusBarAppearance', ap]),
    getSystemPrefersDark: () => false,
    storage: createMemoryStorage(),
    now: () => Date.UTC(2026, 10, 21, 10, 0, 0),
    ...overrides,
  };

  const coordinator = createMobileShellCoordinator(deps);
  return { state, deps, calls, coordinator };
}

test('MobileShellCoordinator: 成果物卡片、图片灯箱、onOpenArtifactFile 竞态与媒体下载回退', async () => {
  let openResolve;
  const downloadCalls = [];
  const h = createHarness({
    state: {
      messages: [
        {
          id: 'm1',
          role: 'assistant',
          content: 'MEDIA:data:image/png;base64,AA==\nMEDIA:/out/page.html',
        },
      ],
      openFiles: [
        { path: '/out/page.html', content: '<h1>hi</h1>', byteSize: 11 },
        { path: '/out/stale.md', content: '# stale' },
      ],
    },
    downloadFile: async (p) => {
      downloadCalls.push(p);
    },
    openWorkspaceFile: async () => {
      if (openResolve) {
        await openResolve();
      }
    },
  });

  // 1. 构建产物扩展名提取 + onCloseMediaLightbox 空态安全返回
  const snap0 = h.coordinator.buildSnapshot();
  assert.ok(snap0.artifacts.some((a) => a.path === '/out/page.html' && a.type === 'HTML'));
  assert.ok(snap0.artifacts.some((a) => a.kind === 'image' && a.type === 'IMG'));
  const actions = h.coordinator.getActions();
  actions.onCloseMediaLightbox();

  // 2. onDownloadMediaItem 无专用依赖时回退 deps.downloadFile
  actions.onDownloadMediaItem({ id: 'm1', src: '', path: '/out/page.html', name: 'page.html' });
  assert.deepEqual(downloadCalls, ['/out/page.html']);

  // 3. onOpenArtifactFile：空串忽略；图片走灯箱；HTML 走阅读器
  await actions.onOpenArtifactFile('');
  await actions.onOpenArtifactFile('/out/shot.png', 'data:image/png;base64,AA==');
  assert.equal(h.coordinator.buildSnapshot().mediaLightbox?.items[0]?.path, '/out/shot.png');
  actions.onCloseMediaLightbox();
  assert.equal(h.coordinator.buildSnapshot().mediaLightbox, null);

  await actions.onOpenArtifactFile('/out/page.html');
  const snapReader = h.coordinator.buildSnapshot();
  assert.equal(snapReader.inspectorReaderOpen, true);
  assert.equal(snapReader.inspectorReaderItem?.filePath, '/out/page.html');

  // 4. 在 memory/diffs 等非 files/artifacts Tab 下调用 openFileInReader 自动切到 files；异步期间切走 Tab 则丢弃过期打开
  actions.onSelectInspectorTab('memory');
  await h.coordinator.openFileInReader('/out/page.html');
  assert.equal(h.coordinator.buildSnapshot().inspectorTab, 'files');

  let releaseStale;
  openResolve = () => new Promise((r) => { releaseStale = r; });
  actions.onCloseInspectorReader();
  const pendingStale = h.coordinator.openFileInReader('/out/stale.md');
  actions.onSelectInspectorTab('memory');
  releaseStale();
  await pendingStale;
  assert.equal(h.coordinator.buildSnapshot().inspectorReaderOpen, false, '异步加载期间切到非授权 Tab 不得弹出过期阅读器');
});

test('MobileShellCoordinator 存储容错、皮肤归一化、统计计数与群成员解析', () => {
  // 损坏 JSON 折叠缓存 + 明亮皮肤初始状态 + 抛错存储容错
  const brokenStorage = createMemoryStorage({
    [MOBILE_SECTIONS_STORAGE_KEY]: '{not-valid-json',
    [MOBILE_APPEARANCE_STORAGE_KEY]: 'system',
  });
  const h1 = createHarness({
    storage: brokenStorage,
    state: { theme: 'jade-white', lang: 'en', activeFocus: { type: 'group', roomId: 'g-1' } },
  });
  const snap1 = h1.coordinator.buildSnapshot();
  assert.equal(snap1.locale, 'en');
  assert.equal(snap1.theme, 'jade-white', 'systemPrefersDark=false 时应收敛为纯净浅白 jade-white');
  assert.deepEqual(snap1.newChatStats, { pluginsCount: 1, mcpCount: 1, skillsCount: 1 });
  assert.deepEqual(
    snap1.groupMembers.map((m) => [m.name, m.avatar]),
    [
      ['arch', 'av://arch'],
      ['ops-external', 'fallback-av://ops-external'],
    ],
  );
  assert.ok(h1.calls.some(([k, v]) => k === 'syncStatusBarAppearance' && v === 'light'));

  // 缺失 detail 时回退全局 MCP/Skills，完全 idle 时返回 undefined
  const h2 = createHarness({
    state: {
      botManagementDetail: null,
      settingsMcp: { status: 'ready', data: [{ id: 1 }, { id: 2 }] },
      settingsSkills: { status: 'idle', data: [] },
      activeFocus: { type: 'group', roomId: 'missing-room' },
    },
  });
  assert.deepEqual(h2.coordinator.buildSnapshot().newChatStats, { pluginsCount: 0, mcpCount: 2, skillsCount: 0 });
  assert.deepEqual(h2.coordinator.buildSnapshot().groupMembers, []);

  h2.state.settingsMcp = { status: 'idle', data: [] };
  assert.equal(h2.coordinator.buildSnapshot().newChatStats, undefined);

  // window.hermesMobile 兜底与 throw storage 安全降级
  const prevWin = globalThis.window;
  const barCalls = [];
  globalThis.window = {
    matchMedia: () => ({ matches: true }),
    hermesMobile: { syncStatusBarAppearance: (a) => barCalls.push(a) },
  };
  try {
    const throwingStorage = {
      getItem() { throw new Error('denied'); },
      setItem() { throw new Error('quota'); },
    };
    const h3 = createHarness({
      storage: throwingStorage,
      syncStatusBarAppearance: undefined,
      getSystemPrefersDark: undefined,
      state: { profileName: '', profiles: [{ name: 'default', isDefault: true, displayName: 'Default' }] },
    });
    assert.equal(h3.coordinator.buildSnapshot().activeBotDisplayName, 'Default');
    h3.coordinator.getActions().onSetAppearancePreference('light');
    assert.deepEqual(barCalls, ['dark', 'light']);
  } finally {
    globalThis.window = prevWin;
  }

  // 无 injected storage 时回落 globalThis.localStorage
  const prevLS = globalThis.localStorage;
  globalThis.localStorage = createMemoryStorage({
    [MOBILE_SECTIONS_STORAGE_KEY]: JSON.stringify({ bots: true, groups: false, sessions: true }),
  });
  try {
    const h4 = createHarness({ storage: undefined });
    assert.equal(h4.coordinator.buildSnapshot().homeModel.botsSection.isCollapsed, true);
    h4.coordinator.getActions().onToggleSection('bots');
    assert.equal(h4.coordinator.buildSnapshot().homeModel.botsSection.isCollapsed, false);
  } finally {
    globalThis.localStorage = prevLS;
  }
});

test('MobileShellCoordinator 全部动作回调与 Bot 终身工位删除物理保护', async () => {
  const { state, calls, coordinator } = createHarness();
  const actions = coordinator.getActions();

  actions.onSelectPane('inspector');
  assert.equal(coordinator.getActivePane(), 'inspector');
  actions.onSelectBot('arch');
  assert.equal(coordinator.getActivePane(), 'stage');
  actions.onSelectGroup('g-1');
  actions.onSelectSession('s-1', 'arch');

  actions.onOpenSearch();
  actions.onSearchChange('ws');
  assert.equal(state.sessionSearchQuery, 'ws');
  actions.onCloseSearch();
  assert.equal(state.sessionSearchQuery, '');

  // 长按面板与三态物理保护
  actions.onOpenActionSheet({ kind: 'bot', id: 'arch', title: '架构老王', isProtected: true });
  actions.onActionDelete({ kind: 'bot', id: 'arch', title: '架构老王', isProtected: true });
  actions.onActionDisband({ kind: 'session', id: 's-1', title: 'x' });
  actions.onActionRename({ kind: 'bot', id: 'arch', title: 'x' }, '不允许');
  assert.equal(calls.some(([k]) => k === 'deleteSession'), false, 'Bot 终身主工位严禁触发 deleteSession');

  actions.onActionOpen({ kind: 'bot', id: 'arch', title: 'x' });
  actions.onActionOpen({ kind: 'group', id: 'g-1', title: 'x' });
  actions.onActionOpen({ kind: 'session', id: 's-1', title: 'x' });
  actions.onActionRename({ kind: 'group', id: 'g-1', title: '旧名' }, '新群名');
  actions.onActionRename({ kind: 'session', id: 's-1', title: '旧名' }, '新会话名');
  actions.onActionPin({ kind: 'session', id: 's-1', title: 'x' });
  actions.onActionPin({ kind: 'bot', id: 'arch', title: 'x' });
  actions.onActionArchive({ kind: 'session', id: 's-1', title: 'x' });
  actions.onActionArchive({ kind: 'group', id: 'g-1', title: 'x' });
  actions.onActionDelete({ kind: 'session', id: 's-1', title: 'x' });
  actions.onActionDisband({ kind: 'group', id: 'g-1', title: 'x' });
  actions.onCloseActionSheet();
  assert.equal(calls.some(([k]) => k === 'deleteSession'), true);
  assert.equal(calls.some(([k]) => k === 'disbandGroupRoom'), true);

  // 即发新建页：单聊创建 vs 多智能体群聊创建与直发
  actions.onOpenNewChat();
  actions.onSelectNewChatBot('arch');
  actions.onSubmitNewChatMessage('单聊首句');
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(calls.some(([k]) => k === 'createNewSession'));
  assert.ok(calls.some(([k, t]) => k === 'routeSend' && t === '单聊首句'));

  actions.onOpenNewChat();
  actions.onSetNewChatGroupMembers(['default', 'arch']);
  actions.onSetNewChatGroupName('专题群');
  actions.onSetNewChatStep('group-members');
  actions.onSubmitNewChatMessage('群聊首句');
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(calls.some(([k, title]) => k === 'createGroupRoom' && title === '专题群'));
  assert.ok(calls.some(([k, id, text]) => k === 'sendGroupMessage' && id === 'room-new' && text === '群聊首句'));

  // 空文本且无附件不提交
  state.attachments = [];
  actions.onOpenNewChat();
  actions.onCloseNewChat();
  actions.onSubmitNewChatMessage('   ');

  // 消息发送 / 中断 / 模型切换 / 附件选取与移除
  actions.onSendMessage('hi');
  actions.onInterruptTurn();
  actions.onSelectModel('openai/gpt-4o', 'openai');
  actions.onRefreshModels?.();
  state.attachments = [{ id: 'a1', name: 'x', type: 'file' }];
  actions.onRemoveAttachment('a1');
  assert.equal(state.attachments.length, 0);

  // 内置 DOM file picker 与自定义 openAttachmentPicker 两条分支
  const prevDoc = globalThis.document;
  let pickedFiles = null;
  let clickedInput = null;
  const mockBody1 = {
    appendChild(el) {
      el.parentNode = mockBody1;
    },
    removeChild() {},
  };
  globalThis.document = {
    body: mockBody1,
    createElement() {
      clickedInput = {
        style: {},
        files: [{ name: 'photo.png' }],
        click() {},
      };
      return clickedInput;
    },
  };
  try {
    actions.onOpenAttachmentPicker();
    clickedInput.onchange();
  } finally {
    globalThis.document = prevDoc;
  }

  const hCustomPicker = createHarness({
    openAttachmentPicker: () => calls.push(['customAttachmentPicker']),
    onFilesPicked: (f) => { pickedFiles = f; },
  });
  hCustomPicker.coordinator.getActions().onOpenAttachmentPicker();
  assert.ok(calls.some(([k]) => k === 'customAttachmentPicker'));
  assert.equal(pickedFiles, null);

  // 子代理、StageReady、检查舱与设置
  coordinator.openSubagentDetail({ messageId: 'm-1', tools: [] });
  assert.equal(coordinator.buildSnapshot().subagentSheet?.messageId, 'm-1');
  actions.onCloseSubagentSheet();
  assert.equal(coordinator.buildSnapshot().subagentSheet, null);

  actions.onStageReady();
  assert.ok(calls.some(([k]) => k === 'syncAgentPresenceHost'));

  actions.onSelectInspectorTab('diffs');
  actions.onOpenInspectorItem({ kind: 'diffs', title: 'a.ts', content: '+1' });
  assert.equal(coordinator.buildSnapshot().inspectorReaderOpen, true);
  actions.onCloseInspectorReader();
  actions.onCopyInspectorText('copied!');
  assert.ok(calls.some(([k, txt]) => k === 'copyText' && txt === 'copied!'));

  actions.onSelectHomeTab('bots');
  assert.equal(coordinator.buildSnapshot().homeTab, 'bots');
  assert.ok(calls.some(([k, sec, force]) => k === 'ensureSettingsSectionData' && sec === 'agents' && force === false));
  state.botManagementStatus = { status: 'list_error', message: 'offline' };
  calls.length = 0;
  actions.onSelectHomeTab('bots');
  assert.ok(calls.some(([k, sec, force]) => k === 'ensureSettingsSectionData' && sec === 'agents' && force === true));
  calls.length = 0;
  actions.onSelectBotSubpage('model');
  assert.equal(coordinator.buildSnapshot().botSubpage, 'model');
  assert.ok(calls.some(([k, sec, force]) => k === 'ensureSettingsSectionData' && sec === 'agents' && force === true));
  actions.onSelectBotSubpage(null);
  assert.equal(coordinator.buildSnapshot().botSubpage, null);

  // 在 Bot Hub 页断开再连通网关关闭设置时，若处于 list_error 必须强制重载；未连通或非 Bots 页则不触发
  calls.length = 0;
  state.gatewayConnected = true;
  actions.onCloseSettings();
  assert.ok(calls.some(([k, sec, force]) => k === 'ensureSettingsSectionData' && sec === 'agents' && force === true));
  calls.length = 0;
  state.gatewayConnected = false;
  actions.onCloseSettings();
  assert.equal(calls.some(([k, sec]) => k === 'ensureSettingsSectionData' && sec === 'agents'), false);
  state.gatewayConnected = true;

  actions.onSelectHomeTab('chats');
  assert.equal(coordinator.buildSnapshot().homeTab, 'chats');

  actions.onOpenSettings();
  assert.equal(state.isSettingsOpen, true);
  actions.onSelectSettingsSubpage('gateway');
  assert.equal(coordinator.buildSnapshot().settingsSubpage, 'gateway');
  actions.onSelectSettingsSubpage('providers');
  actions.onSelectSettingsSubpage('extensions');
  assert.ok(calls.some(([k, sec]) => k === 'ensureSettingsSectionData' && sec === 'providers'));
  assert.ok(calls.some(([k, sec]) => k === 'ensureSettingsSectionData' && sec === 'extensions'));
  actions.onOpenSettingsSubpage('providers');
  assert.equal(coordinator.buildSnapshot().settingsSubpage, 'providers');
  actions.onOpenSettingsSubpage('extensions');
  actions.onOpenSettingsSubpage('gateway');
  actions.onCloseSettings();
  assert.equal(state.isSettingsOpen, false);

  // modelCatalog 优先映射、currentProvider 透传与 onRefreshModels 回调触发 fetchModelOptions
  const refreshCalls = [];
  const hCatalog = createHarness({
    fetchModelOptions: () => refreshCalls.push('fetched'),
    state: {
      currentProvider: 'cpa',
      selectedModel: 'gemini-3-flash',
      modelCatalog: [
        {
          id: 'gemini-3-flash',
          providerSlug: 'cpa',
          providerName: 'CPA Gateway',
          name: 'Gemini 3 Flash',
          displayName: 'Gemini 3 Flash',
          unavailable: false,
        },
        {
          id: 'opus-locked',
          providerSlug: 'anthropic',
          providerName: 'Anthropic',
          name: 'Claude Opus',
          displayName: 'Claude Opus',
          unavailable: true,
        },
      ],
    },
  });
  const catalogSnap = hCatalog.coordinator.buildSnapshot();
  assert.equal(catalogSnap.currentProvider, 'cpa');
  assert.deepEqual(catalogSnap.modelDetails, [
    {
      id: 'gemini-3-flash',
      provider: 'cpa',
      providerName: 'CPA Gateway',
      name: 'Gemini 3 Flash',
      displayName: 'Gemini 3 Flash',
      unavailable: false,
    },
    {
      id: 'opus-locked',
      provider: 'anthropic',
      providerName: 'Anthropic',
      name: 'Claude Opus',
      displayName: 'Claude Opus',
      unavailable: true,
    },
  ]);
  hCatalog.coordinator.getActions().onRefreshModels();
  assert.deepEqual(refreshCalls, ['fetched']);

  // renderMobileShell 挂载 / 复用更新 / 换宿主重挂 / 销毁
  let mounts = 0;
  let updates = 0;
  let unmounts = 0;
  const hMount = createHarness({
    mountShell: () => {
      mounts += 1;
      return {
        update() { updates += 1; },
        unmount() { unmounts += 1; },
      };
    },
  });
  const host1 = { id: 'h1' };
  const host2 = { id: 'h2' };
  hMount.coordinator.renderMobileShell(host1);
  hMount.coordinator.renderMobileShell(host1);
  hMount.coordinator.renderMobileShell(host2);
  hMount.coordinator.dispose();
  assert.equal(mounts, 2);
  assert.equal(updates, 1);
  assert.equal(unmounts, 2);
});

test('MobileShellCoordinator 补充边界分支：离线/默认回落/空文件选择与群聊创建异常', async () => {
  const calls = [];
  const prevWin = globalThis.window;
  const prevDoc = globalThis.document;
  globalThis.window = undefined;
  globalThis.document = undefined;

  try {
    const h = createHarness({
      now: undefined,
      getSystemPrefersDark: undefined,
      storage: createMemoryStorage(),
      state: {
        gatewayConnected: false,
        profileName: '',
        profiles: [],
        groupRooms: [],
        botManagementDetail: null,
        settingsMcp: { status: 'idle', data: [] },
        settingsSkills: { status: 'ready', data: [{ name: 's1' }] },
      },
      createGroupRoom: async () => null,
    });

    const snap = h.coordinator.buildSnapshot();
    assert.equal(snap.activeBotDisplayName, 'default');
    assert.deepEqual(snap.newChatStats, { pluginsCount: 0, mcpCount: 0, skillsCount: 1 });

    const a = h.coordinator.getActions();
    a.onOpenNewChat();
    a.onSelectNewChatBot('');
    a.onSetNewChatGroupMembers(['default']);
    a.onSetNewChatStep('compose');
    a.onSetNewChatGroupMembers(['default', 'arch']);
    // 群聊创建返回 null 时不得调用 openGroupRoom
    a.onSubmitNewChatMessage('新建群消息');
    await new Promise((r) => setTimeout(r, 15));

    // flat { room_id } 返回分支
    const hFlat = createHarness({
      createGroupRoom: async () => {
        calls.push('createdFlat');
        return { room_id: 'flat-room' };
      },
      openGroupRoom: async (rid) => calls.push(['openGroupRoom', rid]),
      sendGroupMessage: async (rid, txt) => calls.push(['sendGroupMessage', rid, txt]),
    });
    const af = hFlat.coordinator.getActions();
    af.onOpenNewChat();
    af.onSetNewChatGroupMembers(['a', 'b']);
    af.onSubmitNewChatMessage('直发扁平群');
    await new Promise((r) => setTimeout(r, 15));
    assert.ok(calls.some((c) => Array.isArray(c) && c[0] === 'openGroupRoom' && c[1] === 'flat-room'));

    // document === undefined 时文件选取安全早退
    a.onOpenAttachmentPicker();

    // 空文件列表触发 onchange 不得调用 onFilesPicked
    let picked = false;
    let mockInp = null;
    const mockBody2 = {
      appendChild(el) {
        el.parentNode = mockBody2;
      },
      removeChild() {},
    };
    globalThis.document = {
      body: mockBody2,
      createElement() {
        mockInp = { style: {}, files: [], click() {} };
        return mockInp;
      },
    };
    const hEmptyPick = createHarness({ onFilesPicked: () => { picked = true; } });
    hEmptyPick.coordinator.getActions().onOpenAttachmentPicker();
    mockInp.onchange();
    assert.equal(picked, false);

    hEmptyPick.coordinator.getActions().onOpenAttachmentPicker();
    mockInp.files = null;
    mockInp.onchange();

    // 默认 profile 命中 + onFilesPicked 已传 / 缺失时 ?. 双分支
    const hWithPickCb = createHarness({
      openAttachmentPicker: undefined,
      onFilesPicked: (files) => calls.push(['onFilesPicked', files.length]),
    });
    hWithPickCb.coordinator.getActions().onOpenAttachmentPicker();
    mockInp.files = [{ name: 'a.png' }];
    mockInp.onchange();
    assert.ok(calls.some(([k, n]) => k === 'onFilesPicked' && n === 1));

    const hDefProf = createHarness({
      onFilesPicked: undefined,
      state: { profileName: '', profiles: [{ name: 'boss', displayName: 'Boss', isDefault: true }] },
    });
    hDefProf.coordinator.getActions().onOpenNewChat();
    assert.equal(hDefProf.coordinator.buildSnapshot().newChatTargetBot, 'boss');
    hDefProf.coordinator.getActions().onOpenAttachmentPicker();
    mockInp.files = [{ name: 'a.png' }];
    mockInp.onchange();

    // 默认 mountShell 回落到 mountMobileWorkspaceShell 时断连宿主应抛预期错
    const hDefaultMount = createHarness({ mountShell: undefined });
    assert.throws(() => hDefaultMount.coordinator.renderMobileShell({ isConnected: false }), /connected/);

    // 防御分支覆盖：isProtected 阻断、onActionOpen(botName/无botName)、纯附件群聊建房与提交异常捕获
    const protCalls = [];
    const hProt = createHarness({
      createNewSession: async () => {
        throw new Error('create failed');
      },
      sendGroupMessage: async (rid, txt) => protCalls.push(['unexpectedGroupSend', rid, txt]),
      selectSession: async (id, opts) => protCalls.push(['selectSession', id, opts]),
      state: {
        sessions: [
          { id: 's-pinned', title: 'Pinned Old', lastActive: 10, botName: 'arch', isPinned: true },
          { id: 's-newer', title: 'Newer Unpinned', lastActive: 9999999999999, isPinned: false },
          { id: 's-nobot', title: 'No Bot', lastActive: 5 },
        ],
      },
    });
    const ap = hProt.coordinator.getActions();
    // 已置顶会话在 buildSnapshot 中必须稳居未置顶新会话之上
    const homeItems = hProt.coordinator.buildSnapshot().homeModel.sessionsSection.items;
    assert.equal(homeItems[0].id, 's-pinned');
    assert.equal(homeItems[0].isPinned, true);

    const protSheet = { kind: 'session', id: 's-pinned', title: 'P', isProtected: true };
    ap.onActionRename(protSheet, 'x');
    ap.onActionPin(protSheet);
    ap.onActionArchive(protSheet);
    ap.onActionDelete(protSheet);
    ap.onActionDisband({ kind: 'group', id: 'g-1', title: 'G', isProtected: true });
    ap.onActionOpen({ kind: 'session', id: 's-nobot', title: 'NoBot' });
    assert.ok(protCalls.some(([k, id, opts]) => k === 'selectSession' && id === 's-nobot' && opts === undefined));

    // 纯附件提交到群聊：也经 sendGroupMessage 携带附件送出
    hProt.state.attachments = [{ id: 'a1', name: 'f.txt', type: 'file' }];
    ap.onOpenNewChat();
    ap.onSetNewChatGroupMembers(['default', 'arch']);
    ap.onSetNewChatStep('group-members');
    ap.onSubmitNewChatMessage('   ');
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(protCalls.some(([k, rid, txt]) => k === 'unexpectedGroupSend' && rid === 'room-new' && txt === ''), true);

    // 单聊 createNewSession 抛错被 catch 捕获，不产生未处理拒绝
    ap.onOpenNewChat();
    ap.onSubmitNewChatMessage('will fail safely');
    await new Promise((r) => setTimeout(r, 15));
  } finally {
    globalThis.window = prevWin;
    globalThis.document = prevDoc;
  }
});

test('MobileShellCoordinator openFileGen 防并发覆盖、切屏/切 Tab 防御、缺失文件不回退与下载透传 filePath', async () => {
  let resolveSlow;
  const slowOpened = new Promise((resolve) => {
    resolveSlow = resolve;
  });
  const downloadedPaths = [];
  let waitSlow = false;
  const h = createHarness({
    openWorkspaceFile: async (filePath) => {
      if (waitSlow && filePath === 'src/slow.ts') {
        await slowOpened;
      }
    },
    downloadFile: async (filePath) => {
      downloadedPaths.push(filePath);
    },
    state: {
      activeSessionId: 'sess-1',
      openFiles: [
        { path: 'src/active.ts', content: 'active body', source: 'gateway_api' },
        { path: 'src/slow.ts', content: 'slow body', source: 'gateway_api' },
        { path: 'src/fast.ts', content: 'fast body', source: 'gateway_api' },
      ],
      activeFilePath: 'src/active.ts',
    },
  });

  const acts = h.coordinator.getActions();

  // 1. 尚在 stage 面板调用 onOpenWorkspaceFile -> activePane !== 'inspector' 必须拦截
  acts.onOpenWorkspaceFile('src/active.ts');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(h.coordinator.buildSnapshot().inspectorReaderOpen, false);

  // 2. 在 inspector 但非 files Tab 调用 -> inspectorTab !== 'files' 必须拦截
  acts.onSelectPane('inspector');
  acts.onSelectInspectorTab('artifacts');
  acts.onOpenWorkspaceFile('src/active.ts');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(h.coordinator.buildSnapshot().inspectorReaderOpen, false);

  // 3. 切到 files Tab 后未打开文件先点下载 -> 必须阻断（不传入 undefined 触发回退下载）
  acts.onSelectInspectorTab('files');
  acts.onDownloadInspectorFile();
  assert.deepEqual(downloadedPaths, []);

  // 4. 并发竞态：slow 先触发，fast 后触发并先完成；slow 迟到后不得覆盖 fast
  waitSlow = true;
  acts.onOpenWorkspaceFile('src/slow.ts');
  acts.onOpenWorkspaceFile('src/fast.ts');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(h.coordinator.buildSnapshot().inspectorReaderItem?.filePath, 'src/fast.ts');
  resolveSlow();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(h.coordinator.buildSnapshot().inspectorReaderItem?.filePath, 'src/fast.ts');

  // 5. 下载应精准透传当前阅读器条目 filePath ('src/fast.ts')，即使 activeFilePath 仍为 'src/active.ts'
  acts.onDownloadInspectorFile();
  assert.deepEqual(downloadedPaths, ['src/fast.ts']);

  // 5.1 在途请求期间切回 stage 面板 -> onSelectPane 递增 openFileGen 并拦截后续打开
  acts.onCloseInspectorReader();
  let releasePaneSlow;
  waitSlow = true;
  const paneCoordinator = createHarness({
    openWorkspaceFile: async (fp) => {
      if (fp === 'src/slow.ts') {
        await new Promise((r) => {
          releasePaneSlow = r;
        });
      }
    },
    state: {
      activeSessionId: 'sess-1',
      openFiles: [{ path: 'src/slow.ts', content: 'slow body', source: 'gateway_api' }],
    },
  });
  const paneActs = paneCoordinator.coordinator.getActions();
  paneActs.onSelectPane('inspector');
  paneActs.onSelectInspectorTab('files');
  paneActs.onOpenWorkspaceFile('src/slow.ts');
  paneActs.onSelectPane('stage');
  releasePaneSlow();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(paneCoordinator.coordinator.buildSnapshot().inspectorReaderOpen, false);

  // 6. 请求不存在的文件时，严禁回退打开 state.activeFilePath
  acts.onCloseInspectorReader();
  acts.onOpenWorkspaceFile('src/missing.ts');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(h.coordinator.buildSnapshot().inspectorReaderOpen, false);
});

test('MobileShellCoordinator 文件树、认知星图与触觉反馈新钩子全分支覆盖', async () => {
  const prevWin = globalThis.window;
  const prevDoc = globalThis.document;
  const hapticWinCalls = [];
  globalThis.window = {
    matchMedia: () => ({ matches: true }),
    hermesMobile: {
      hapticSelection: async () => hapticWinCalls.push('win-haptic'),
    },
  };
  let bodyAppended = 0;
  let bodyRemoved = 0;
  let createdInput = null;
  globalThis.document = {
    body: {
      appendChild(el) {
        bodyAppended += 1;
        createdInput = el;
        el.parentNode = { removeChild() { bodyRemoved += 1; } };
      },
    },
    createElement() {
      return { style: {}, files: [], click() {} };
    },
  };

  try {
    const extCalls = [];
    const { state, coordinator } = createHarness({
      loadFileTree: (force) => extCalls.push(['loadFileTree', force]),
      toggleFileTreeDir: (p) => extCalls.push(['toggleFileTreeDir', p]),
      setFileTreeFilter: (q) => extCalls.push(['setFileTreeFilter', q]),
      openWorkspaceFile: async (fp) => {
        extCalls.push(['openWorkspaceFile', fp]);
        if (fp === 'src/exact.ts') {
          state.openFiles.push({ path: 'src/exact.ts', content: 'exact', byteSize: 42 });
        } else if (fp === 'src/win.png') {
          state.openFiles.push({ path: 'src\\win.png', content: 'data:image/png;base64,AA' });
        } else if (fp === 'fallback') {
          state.activeFilePath = 'src/fallback.md';
          state.openFiles.push({ path: 'src/fallback.md', content: 'fb', isBinary: true, isTooLarge: false });
        }
      },
      downloadFile: () => extCalls.push(['downloadFile']),
      loadLearningGraph: (opts, explicitProf) => extCalls.push(['loadLearningGraph', opts, explicitProf]),
      loadLearningDetail: (id, prof) => extCalls.push(['loadLearningDetail', id, prof]),
      editLearningNode: async (id, c, prof) => ({ ok: true, id, c, prof }),
      deleteLearningNode: async (id, prof) => ({ ok: true, id, prof }),
      createSettingsActions: () => ({
        onClose() {},
        onSelectBotSettle: (id) => extCalls.push(['baseSettle', id]),
      }),
      state: {
        botManagementActiveBotId: 'reviewer',
        activeFocus: { type: 'session', sessionId: 's-1' },
        sessions: [{ id: 's-1', title: 'S1', botName: 'arch', cwd: '/opt/hermes/workspace' }],
      },
    });
    const acts = coordinator.getActions();
    assert.equal(coordinator.buildSnapshot().workspaceRootName, 'workspace');
    assert.equal(coordinator.buildSnapshot().inspectorBotProfile, 'arch');
    assert.equal(coordinator.buildSnapshot().inspectorBotLabel, '架构老王');

    // Inspector 切页懒加载: files & memory(按激活会话所属 Bot) & memory(群聊跳过) & Bot Hub memory(按目标 Bot)
    acts.onSelectInspectorTab('files');
    acts.onSelectInspectorTab('memory');
    acts.onSelectPane('inspector');
    state.activeFocus = { type: 'group', roomId: 'g-1' };
    acts.onSelectInspectorTab('memory');
    acts.onSelectBotSubpage('memory');
    acts.settingsActions.onSelectBotSettle('reviewer');
    assert.equal(extCalls.filter(([k]) => k === 'loadFileTree').length, 1);
    const loadGraphCalls = extCalls.filter(([k]) => k === 'loadLearningGraph');
    assert.equal(loadGraphCalls.length, 4);
    assert.deepEqual(loadGraphCalls[0][1], { profile: 'arch', force: false });
    assert.deepEqual(loadGraphCalls[1][1], { profile: 'arch', force: false });
    assert.deepEqual(loadGraphCalls[2][1], { profile: 'reviewer', force: false });
    assert.deepEqual(loadGraphCalls[3][1], { profile: 'reviewer', force: false });

    // FileTree actions + openWorkspaceFile (exact / backslash / root-only / blank / missing 不回退)
    acts.onSelectInspectorTab('files');
    acts.onLoadFileTree(true);
    acts.onToggleFileTreeDir('src');
    acts.onFilterFileTree('app');
    acts.onOpenWorkspaceFile('missing.ts');
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(coordinator.buildSnapshot().inspectorReaderOpen, false);
    acts.onOpenWorkspaceFile('src/win.png');
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(coordinator.buildSnapshot().inspectorReaderOpen, true);
    state.openFiles.push({ path: '/', content: 'root-only' });
    acts.onOpenWorkspaceFile('/');
    await new Promise((r) => setTimeout(r, 10));
    state.openFiles.push({ path: ' ', content: 'blank-path' });
    acts.onOpenWorkspaceFile(' ');
    await new Promise((r) => setTimeout(r, 10));
    acts.onOpenWorkspaceFile('src/exact.ts');
    await new Promise((r) => setTimeout(r, 10));
    const snap = coordinator.buildSnapshot();
    assert.equal(snap.inspectorReaderOpen, true);
    assert.equal(snap.inspectorReaderItem?.title, 'exact.ts');

    acts.onDownloadInspectorFile();
    acts.onEnsureLearning();
    acts.onRefreshLearning('arch');
    acts.onLoadLearningDetail('memory:1', 'arch');
    assert.deepEqual(await acts.onEditLearningNode('memory:1', 'new', 'arch'), {
      ok: true,
      id: 'memory:1',
      c: 'new',
      prof: 'arch',
    });
    assert.deepEqual(await acts.onDeleteLearningNode('memory:1', 'arch'), {
      ok: true,
      id: 'memory:1',
      prof: 'arch',
    });
    const allGraphCalls = extCalls.filter(([k]) => k === 'loadLearningGraph');
    // onSelectBotSettle 之后位于 botSubpage='memory' -> onEnsureLearning() 隐式解析 activeBot = 'reviewer'
    assert.deepEqual(allGraphCalls.at(-2)?.[1], { profile: 'reviewer', force: false });
    assert.deepEqual(
      allGraphCalls.at(-1)?.[1],
      { profile: 'arch', force: true },
    );
    assert.deepEqual(
      extCalls.filter(([k]) => k === 'loadLearningDetail').at(-1),
      ['loadLearningDetail', 'memory:1', 'arch'],
    );

    // 未传显式 profile 时，resolveActiveLearningProfile 按当前所在面板（Bot Hub memory 子页 vs Inspector）自动解析归属
    state.activeFocus = { type: 'bot', botName: 'arch' };
    state.botManagementActiveBotId = 'reviewer';
    acts.onSelectBotSubpage('memory');
    acts.onRefreshLearning();
    acts.onLoadLearningDetail('skill:rev-1');
    assert.deepEqual(extCalls.filter(([k]) => k === 'loadLearningGraph').at(-1)?.[1], {
      profile: 'reviewer',
      force: true,
    });
    assert.deepEqual(extCalls.filter(([k]) => k === 'loadLearningDetail').at(-1), [
      'loadLearningDetail',
      'skill:rev-1',
      'reviewer',
    ]);
    acts.onSelectBotSubpage(null);
    acts.onRefreshLearning();
    acts.onLoadLearningDetail('memory:arch-2');
    assert.deepEqual(extCalls.filter(([k]) => k === 'loadLearningGraph').at(-1)?.[1], {
      profile: 'arch',
      force: true,
    });
    assert.deepEqual(extCalls.filter(([k]) => k === 'loadLearningDetail').at(-1), [
      'loadLearningDetail',
      'memory:arch-2',
      'arch',
    ]);

    // activeFocus / profileName 全部缺省时的回落 'default' 与 state.profileName / isDefault 回落及 onSelectBotSettle 可选链
    state.activeFocus = { type: 'bot', botName: '' };
    state.profileName = '';
    acts.onEnsureLearning();
    state.activeFocus = { type: 'session', sessionId: 'not-found' };
    acts.onEnsureLearning();
    state.botManagementActiveBotId = '';
    state.profiles = [{ name: 'main-def', isDefault: true }];
    acts.onSelectBotSubpage('memory');
    assert.ok(extCalls.filter(([k]) => k === 'loadLearningGraph').some(([, arg]) => arg?.profile === 'main-def'));
    state.profiles = [{ name: '', isDefault: true }];
    state.profileName = 'profile-fallback';
    acts.onSelectBotSubpage('memory');
    state.profileName = '';
    acts.onSelectBotSubpage('memory');
    acts.settingsActions.onSelectBotSettle('solo-mem');
    acts.onSelectBotSubpage('basic');
    acts.settingsActions.onSelectBotSettle('solo');
    assert.ok(extCalls.some(([k, v]) => k === 'baseSettle' && v === 'solo'));
    assert.ok(extCalls.filter(([k]) => k === 'loadLearningGraph').some(([, arg]) => arg?.profile === 'profile-fallback'));

    // baseSettingsActions 不含 onSelectBotSettle 且 deps 不含 loadLearningGraph 时的 ?. 可选调用分支
    const hNoSettle = createHarness({
      createSettingsActions: () => ({ onClose() {} }),
      loadLearningGraph: undefined,
    });
    const noSettleActs = hNoSettle.coordinator.getActions();
    noSettleActs.onSelectBotSubpage('memory');
    noSettleActs.settingsActions.onSelectBotSettle('arch');

    // Haptic fallback to window.hermesMobile + injected triggerHapticSelection
    acts.onHapticSelection();
    assert.equal(hapticWinCalls.length, 1);
    const hCustomHaptic = createHarness({
      triggerHapticSelection: () => extCalls.push(['customHaptic']),
    });
    hCustomHaptic.coordinator.getActions().onHapticSelection();
    assert.ok(extCalls.some(([k]) => k === 'customHaptic'));

    // document.body.appendChild + oncancel cleanup in onOpenAttachmentPicker
    acts.onOpenAttachmentPicker();
    assert.equal(bodyAppended, 1);
    createdInput.oncancel();
    assert.equal(bodyRemoved, 1);
  } finally {
    globalThis.window = prevWin;
    globalThis.document = prevDoc;
  }
});

test('mobileShellCoordinator: onActionDisband 回退 home 屏与异常处理', async () => {
  const calls = [];
  const h = createHarness({
    openGroupRoom: async (id) => {
      calls.push(['openGroupRoom', id]);
      h.state.activeFocus = { type: 'group', roomId: id };
    },
    disbandGroupRoom: async (id) => {
      calls.push(['disband', id]);
      if (id === 'grp-error') throw new Error('网关拒绝解散');
      // 模拟 index.ts 在 disbandGroupRoom 内部已先行重置 activeFocus
      h.state.activeFocus = { type: 'session', sessionId: '' };
    },
  });

  const acts = h.coordinator.getActions();
  // 1. 处于 stage 且聚焦在 grp-1 时解散，必须成功切回 home
  acts.onSelectGroup('grp-1');
  assert.equal(h.coordinator.getActivePane(), 'stage');
  assert.equal(h.state.activeFocus.type, 'group');
  assert.deepEqual(h.coordinator.getActiveViewContext(), {
    isMobile: true,
    mobilePane: 'stage',
    homeTab: 'chats',
    botSubpage: null,
    settingsOpen: false,
    settingsSubpage: null,
  });

  acts.onActionDisband({ kind: 'group', id: 'grp-1', title: '群聊1' });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(h.coordinator.getActivePane(), 'home', '聚焦中的群聊解散后必须平滑切回 home 屏');

  // 2. 解散失败时记录可见 dockNotice
  acts.onActionDisband({ kind: 'group', id: 'grp-error', title: '异常群聊' });
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(h.state.dockNotice.includes('网关拒绝解散'), '解散失败必须向用户暴露 dockNotice');

  // 3. 新建会话返回 null 时绝不可误调用 routeSend 串台发送
  const abortedRoutes = [];
  const hNullCreate = createHarness({
    createNewSession: async () => null,
    routeSend: async (txt) => abortedRoutes.push(txt),
  });
  const nullActs = hNullCreate.coordinator.getActions();
  nullActs.onOpenNewChat();
  nullActs.onSelectNewChatBot('default');
  nullActs.onSubmitNewChatMessage('不得串台发送的消息');
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(abortedRoutes, [], 'createNewSession 失败返回 null 时绝不可触发 routeSend');

  // 4. 长按菜单打开同 ID 跨 Profile 会话与已完成归档会话必须透传准确 botName
  const openCalls = [];
  const hDupOpen = createHarness({
    state: {
      sessions: [
        { id: 's-dup', title: 'Default Dup', botName: 'default', isArchived: false },
        { id: 's-dup', title: 'Arch Dup', botName: 'arch', isArchived: false },
      ],
      archivedSessions: [
        { id: 's-arch-only', title: 'Done Session', botName: 'arch', isArchived: true },
      ],
    },
    selectSession: async (id, opts) => {
      openCalls.push([id, opts]);
    },
  });
  const dupActs = hDupOpen.coordinator.getActions();
  dupActs.onActionOpen({ kind: 'session', id: 's-dup', title: 'Arch Dup', botName: 'arch' });
  dupActs.onActionOpen({ kind: 'session', id: 's-arch-only', title: 'Done Session' });
  assert.deepEqual(openCalls, [
    ['s-dup', { botName: 'arch' }],
    ['s-arch-only', { botName: 'arch' }],
  ]);

  // 5. state.orgPrefs.hiddenProjectIds 传播至 homeModel.projectSections：仅隐藏项目文件夹及内含会话，保留项目外会话
  const hProjVis = createHarness({
    state: {
      orgPrefs: { showDoneSection: true, autoReopenOnSend: true, hiddenProjectIds: ['p-hide'] },
      orgFolders: [{ id: 'fld-keep', name: '保留文件夹', order: 0 }],
      orgAssignments: {
        'session:default:s-outside-none': '__none__',
        'session:default:s-outside-folder': 'fld-keep',
      },
      projects: [
        { id: 'p-hide', name: 'HiddenRepo', path: '/opt/work/hidden', archived: false },
        { id: 'p-show', name: 'ShownRepo', path: '/opt/work/shown', archived: false },
      ],
      sessions: [
        { id: 's-inside-hidden', title: 'Hidden Folder Session', botName: 'default', cwd: '/opt/work/hidden/sub', projectId: 'p-hide', isArchived: false },
        { id: 's-outside-none', title: 'Detached From Folder', botName: 'default', cwd: '/opt/work/hidden/sub', projectId: 'p-hide', isArchived: false },
        { id: 's-outside-folder', title: 'In Custom Folder', botName: 'default', cwd: '/opt/work/hidden', projectId: 'p-hide', isArchived: false },
        { id: 's-visible', title: 'Visible Project Session', botName: 'default', cwd: '/opt/work/shown', projectId: 'p-show', isArchived: false },
      ],
    },
  });
  const visSnap = hProjVis.coordinator.buildSnapshot();
  assert.deepEqual(
    visSnap.homeModel.projectSections.map((s) => s.id),
    ['p-show'],
    'hiddenProjectIds 内的项目文件夹必须从 homeModel.projectSections 隐藏',
  );
  assert.deepEqual(
    visSnap.homeModel.sessionsSection.items.map((r) => r.id),
    ['s-outside-none'],
    '关联项目但显式处于 __none__ 的会话不受项目隐藏影响，应在会话区正常显示',
  );
  assert.deepEqual(
    visSnap.homeModel.folderSections.find((f) => f.id === 'fld-keep')?.items.map((r) => r.id),
    ['s-outside-folder'],
    '关联项目但处于自定义文件夹的会话应正常显示在自定义文件夹中',
  );
});

test('移动端检查舱成果物自动聚合与正文路径唤起阅读器/灯箱', async () => {
  const openedFilesLog = [];
  const h = createHarness({
    state: {
      messages: [
        {
          id: 'u-upload',
          role: 'user',
          content: '参考图',
          attachments: [{ id: 'ua-1', name: 'ref.png', type: 'image', previewUrl: 'data:image/png;base64,REF' }],
        },
        {
          id: 'ast-deliver',
          role: 'assistant',
          content: '已输出三张图与网页原型：\nMEDIA:/out/img-1.png\n![img-2](/out/img-2.png)\n[原型](/out/report.html)',
          toolCalls: [
            {
              id: 'tc-img-3',
              name: 'image_generate',
              status: 'completed',
              args: '{}',
              imagePath: '/out/img-3.png',
            },
            {
              id: 'tc-term-readonly',
              name: 'terminal',
              status: 'completed',
              args: 'cat /etc/hosts',
              output: '{"output":"127.0.0.1 localhost"}',
            },
          ],
        },
      ],
    },
    openWorkspaceFile: async (filePath) => {
      openedFilesLog.push(filePath);
      h.state.openFiles.push({
        path: filePath,
        content: '<h1>Prototype</h1>',
      });
    },
  });

  const snap = h.coordinator.buildSnapshot();
  const artifactPaths = snap.artifacts.map((a) => a.path);
  assert.ok(artifactPaths.includes('/out/img-1.png'), '必须汇总 MEDIA 成果物');
  assert.ok(artifactPaths.includes('/out/img-2.png'), '必须汇总 Markdown 图片成果物');
  assert.ok(artifactPaths.includes('/out/img-3.png'), '必须汇总 tool.imagePath 成果物');
  assert.ok(artifactPaths.includes('/out/report.html'), '必须汇总 HTML 成果物');
  assert.equal(artifactPaths.includes('/etc/hosts'), false, '只读命令行路径绝不可进入成果物');
  assert.equal(artifactPaths.some((p) => p?.includes('ref.png')), false, '用户上传附件不得混入成果物');

  // 点击文档路径直接切换检查舱并滑入富阅读器
  await h.coordinator.openFileInReader('/out/report.html');
  const afterDocSnap = h.coordinator.buildSnapshot();
  assert.deepEqual(openedFilesLog, ['/out/report.html']);
  assert.equal(afterDocSnap.activePane, 'inspector');
  assert.equal(afterDocSnap.inspectorReaderOpen, true);
  assert.equal(afterDocSnap.inspectorReaderItem?.filePath, '/out/report.html');

  // 点击成果物 Tab 中的 HTML 卡片也必须正常唤起阅读器
  h.coordinator.getActions().onSelectInspectorTab('artifacts');
  h.coordinator.getActions().onOpenArtifactFile?.('/out/report.html');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(h.coordinator.buildSnapshot().inspectorTab, 'artifacts');
  assert.equal(h.coordinator.buildSnapshot().inspectorReaderOpen, true);

  // 点击图片路径直接打开全屏悬浮灯箱
  await h.coordinator.openFileInReader('/out/img-3.png');
  const afterImgSnap = h.coordinator.buildSnapshot();
  assert.equal(afterImgSnap.mediaLightbox?.items.length, 1);
  assert.equal(afterImgSnap.mediaLightbox?.items[0].path, '/out/img-3.png');

  // 灯箱直接下载未打开进 state.openFiles 的图片产物
  const downloadedItems = [];
  const dlHost = createHarness({
    downloadMediaItem: async (item) => {
      downloadedItems.push(item);
    },
  });
  dlHost.coordinator.getActions().onDownloadMediaItem?.({
    id: 'dl-1',
    src: 'data:image/png;base64,AA==',
    path: '/out/img-3.png',
    name: 'img-3.png',
  });
  assert.equal(downloadedItems.length, 1);
  assert.equal(downloadedItems[0].src, 'data:image/png;base64,AA==');

  h.coordinator.closeMediaLightbox();
  assert.equal(h.coordinator.buildSnapshot().mediaLightbox, null);
});
