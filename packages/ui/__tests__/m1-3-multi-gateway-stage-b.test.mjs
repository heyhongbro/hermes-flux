/**
 * M1.3 Stage B UI Parity Tests
 * (packages/ui/__tests__/m1-3-multi-gateway-stage-b.test.mjs)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { setLocale } from '../dist/i18n/index.js';
import { LeftRail } from '../dist/components-react/LeftRail.js';
import { renderGroupCollageAvatar } from '../dist/utils/botAvatar.js';
import {
  Titlebar,
  GatewayHealthPopover,
  formatGatewayRouteLabel,
  GroupedLeftRail,
  buildGroupedLeftRailModel,
  MobileBotHubScreen,
  MobileEntityRow,
  MobileHomeScreen,
  MobileConversationScreen,
  MobileWorkspaceShell,
  buildLeftRailModel,
  buildMobileHomeModel,
} from '../dist/index.js';

function createReactDriver() {
  const slots = new Map();
  let pendingEffects = [];

  function resolve(node, key = 'root') {
    if (node == null || typeof node === 'boolean' || typeof node === 'string' || typeof node === 'number') {
      return node;
    }
    if (Array.isArray(node)) {
      return node.map((item, idx) => resolve(item, `${key}[${idx}]`));
    }
    if (typeof node !== 'object') return node;
    if (node.type === React.Fragment) {
      return resolve(node.props?.children, `${key}<>`);
    }
    const elType = node.type;
    const innerType =
      elType && typeof elType === 'object' && elType.$$typeof === Symbol.for('react.memo')
        ? elType.type
        : elType;
    const compFn =
      typeof innerType === 'function'
        ? innerType
        : innerType && typeof innerType === 'object' && typeof innerType.render === 'function'
          ? innerType.render
          : null;

    if (compFn) {
      const compName = innerType?.displayName || innerType?.name || 'comp';
      const scopedKey = `${key}/${compName}${node.key != null ? `#k=${String(node.key)}` : ''}`;
      let slot = slots.get(scopedKey);
      if (!slot) {
        slot = { states: [], refs: [], memos: [], effects: [], hasRendered: false, lastProps: null };
        slots.set(scopedKey, slot);
      }
      if (
        slot.hasRendered &&
        elType &&
        typeof elType === 'object' &&
        elType.$$typeof === Symbol.for('react.memo') &&
        typeof elType.compare === 'function'
      ) {
        elType.compare(slot.lastProps, node.props);
      }
      slot.hasRendered = true;
      slot.lastProps = node.props;
      let sIdx = 0;
      let rIdx = 0;
      let mIdx = 0;
      let eIdx = 0;
      const internals = React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
      const prevH = internals.H;
      const scheduleEffect = (fn, deps) => {
        const idx = eIdx++;
        if (idx >= slot.effects.length) {
          slot.effects.push({ deps, cleanup: undefined, hasRun: false });
        }
        const entry = slot.effects[idx];
        const changed =
          !entry.hasRun ||
          deps === undefined ||
          entry.deps === undefined ||
          deps.length !== entry.deps.length ||
          deps.some((d, i) => !Object.is(d, entry.deps[i]));
        if (changed) {
          pendingEffects.push(() => {
            if (typeof entry.cleanup === 'function') {
              entry.cleanup();
              entry.cleanup = undefined;
            }
            entry.deps = deps;
            entry.hasRun = true;
            const cleanup = fn();
            if (typeof cleanup === 'function') entry.cleanup = cleanup;
          });
        }
      };
      internals.H = {
        useState(init) {
          const idx = sIdx++;
          if (idx >= slot.states.length) slot.states.push(typeof init === 'function' ? init() : init);
          return [slot.states[idx], (next) => { slot.states[idx] = typeof next === 'function' ? next(slot.states[idx]) : next; }];
        },
        useRef(init) {
          const idx = rIdx++;
          if (idx >= slot.refs.length) slot.refs.push({ current: init });
          return slot.refs[idx];
        },
        useMemo(factory, deps) {
          const idx = mIdx++;
          if (idx >= slot.memos.length) {
            slot.memos.push({ value: factory(), deps });
          } else {
            const prev = slot.memos[idx];
            if (!deps || !prev.deps || deps.some((d, i) => !Object.is(d, prev.deps[i]))) {
              slot.memos[idx] = { value: factory(), deps };
            }
          }
          return slot.memos[idx].value;
        },
        useCallback(cb) { return cb; },
        useEffect: scheduleEffect,
        useLayoutEffect: scheduleEffect,
        useInsertionEffect: scheduleEffect,
        useContext(ctx) { return ctx._currentValue; },
      };
      let rendered;
      try {
        rendered = compFn(node.props);
      } finally {
        internals.H = prevH;
      }
      return resolve(rendered, `${scopedKey}>`);
    }
    if (node.props && 'children' in node.props) {
      return { ...node, props: { ...node.props, children: resolve(node.props.children, `${key}>`) } };
    }
    return node;
  }

  return {
    render(element) {
      pendingEffects = [];
      const tree = resolve(element);
      const effects = pendingEffects;
      pendingEffects = [];
      for (const run of effects) run();
      return tree;
    },
    cleanupAll() {
      for (const slot of slots.values()) {
        for (const eff of slot.effects) {
          eff.cleanup?.();
          eff.cleanup = undefined;
        }
      }
    },
  };
}

function findElements(tree, predicate, out = []) {
  if (!tree) return out;
  if (Array.isArray(tree)) {
    for (const item of tree) findElements(item, predicate, out);
    return out;
  }
  if (typeof tree !== 'object') return out;
  if (predicate(tree)) out.push(tree);
  if (tree.props && 'children' in tree.props) findElements(tree.props.children, predicate, out);
  return out;
}

test('M1.3 UI Stage B Parity: formatGatewayRouteLabel/本地网关回退/LeftRail滚动与Tooltip/移动端离线与gatewayId闭环', () => {
  setLocale('zh-CN');
  assert.equal(formatGatewayRouteLabel(undefined), '');
  assert.equal(formatGatewayRouteLabel('direct'), '直连');
  assert.equal(formatGatewayRouteLabel('lan'), '局域网');
  assert.equal(formatGatewayRouteLabel('relay'), '中继');
  assert.equal(formatGatewayRouteLabel('custom-tunnel'), 'custom-tunnel');

  setLocale('en-US');
  assert.equal(formatGatewayRouteLabel('direct'), 'Direct');
  assert.equal(formatGatewayRouteLabel('lan'), 'LAN');
  assert.equal(formatGatewayRouteLabel('relay'), 'Relay');
  setLocale('zh-CN');

  // 1. Titlebar single-gateway fallback uses gateway.localNode & popover uses overflow-hidden + scrollbar-thin
  const prevDoc = globalThis.document;
  const driver = createReactDriver();
  try {
    globalThis.document = {
      documentElement: { lang: 'zh-CN' },
      addEventListener() {},
      removeEventListener() {},
      getElementById(id) {
        if (id === 'titlebar-gateway-health-btn') {
          return { getBoundingClientRect: () => ({ bottom: 32, left: 10, right: 38, top: 4, width: 28, height: 28 }) };
        }
        return null;
      },
    };
    const titlebarProps = {
      connectionStatus: 'connected',
      gatewayLabel: 'My Local Box',
      gatewayUrl: 'http://127.0.0.1:8642',
      leftRailCollapsed: false,
      rightPodVisible: false,
      theme: 'obsidian-gold',
      platform: 'win32',
      onToggleLeftRail: () => {},
      onToggleRightPod: () => {},
      onToggleTheme: () => {},
      onOpenSettings: () => {},
    };
    const fallbackTree = driver.render(React.createElement(Titlebar, titlebarProps));
    findElements(fallbackTree, (el) => el.props?.id === 'titlebar-gateway-health-btn')[0].props.onClick({ stopPropagation() {} });
    const openedTree = driver.render(React.createElement(Titlebar, titlebarProps));
    const popBox = findElements(
      openedTree,
      (el) => typeof el.props?.className === 'string' && el.props.className.includes('overflow-hidden'),
    )[0];
    const popScroll = findElements(
      openedTree,
      (el) => typeof el.props?.className === 'string' && el.props.className.includes('scrollbar-thin'),
    )[0];
    assert.ok(popBox && popScroll);
    assert.equal(JSON.stringify(openedTree).includes('本地网关'), true);
    setLocale('en-US');
    const enPopHtml = renderToStaticMarkup(React.createElement(GatewayHealthPopover, {
      open: true,
      gateways: [{ gatewayId: 'gw-a', name: 'N', routeKind: 'lan', status: 'connected' }],
      onClose: () => {},
    }));
    assert.match(enPopHtml, /LAN/);
    setLocale('zh-CN');
  } finally {
    driver.cleanupAll();
    globalThis.document = prevDoc;
  }

  // 2. LeftRail uses scrollbar-none and localized gatewayRouteLabel in Tooltip
  const localizedLeftModel = buildLeftRailModel({
    activeSessionId: '',
    activeFocus: { type: 'bot', botName: 'arch', gatewayId: 'gw-a' },
    profiles: [
      { name: 'default', displayName: 'Default', isDefault: true, gatewayId: 'gw-a', gatewayLabel: 'NodeA', gatewayRouteLabel: 'lan' },
      { name: 'arch', displayName: 'Arch', isDefault: false, gatewayId: 'gw-b', gatewayLabel: 'NodeB', gatewayRouteLabel: 'relay' },
    ],
    groups: [],
    sessions: [],
    profileName: 'arch',
    gatewayCount: 2,
  });
  const railHtml = renderToStaticMarkup(React.createElement(LeftRail, {
    model: localizedLeftModel,
    layout: 'dual-rail',
    collapsed: false,
    onSelectSession: () => {},
    onSelectBot: () => {},
    onSelectGroup: () => {},
    onNewChat: () => {},
  }));
  assert.match(railHtml, /station-agents-scroll[^"]*scrollbar-none/);
  assert.doesNotMatch(railHtml, /station-agents-scroll[^"]*\[scrollbar-width:none\]/);
  assert.match(railHtml, /NodeA \(局域网\)/);
  assert.match(railHtml, /NodeB \(中继\)/);

  // 3. MobileEntityRow online/offline badges + subtitle combinations
  const mobileRowOnline = renderToStaticMarkup(React.createElement(MobileEntityRow, {
    kind: 'session',
    entityId: 's-1',
    title: 'Online Row',
    subtitle: 'Hello',
    avatarHtml: '<span>A</span>',
    isActive: false,
    gatewayBadge: { label: 'Node-A' },
    activityState: 'read',
    activityTransition: 'none',
    onSelect: () => {},
  }));
  assert.match(mobileRowOnline, /data-gateway-badge="Node-A"/);
  assert.doesNotMatch(mobileRowOnline, /opacity-60/);
  assert.doesNotMatch(mobileRowOnline, /data-gateway-offline/);

  const mobileRowBadgeOnly = renderToStaticMarkup(React.createElement(MobileEntityRow, {
    kind: 'bot',
    entityId: 'b-off',
    title: 'Offline Badge Only',
    avatarHtml: '<span>B</span>',
    isActive: false,
    gatewayBadge: { label: 'Node-B', offline: true },
    activityState: 'read',
    activityTransition: 'none',
    onSelect: () => {},
  }));
  assert.match(mobileRowBadgeOnly, /opacity-60/);
  assert.match(mobileRowBadgeOnly, /data-gateway-offline="true"/);
  assert.match(mobileRowBadgeOnly, /<svg/);

  const mobileRowFlagOfflineOnly = renderToStaticMarkup(React.createElement(MobileEntityRow, {
    kind: 'group',
    entityId: 'g-off',
    title: 'Offline Flag Only',
    avatarHtml: '<span>G</span>',
    isActive: false,
    gatewayOffline: true,
    activityState: 'read',
    activityTransition: 'none',
    onSelect: () => {},
  }));
  assert.match(mobileRowFlagOfflineOnly, /opacity-60/);
  assert.match(mobileRowFlagOfflineOnly, /data-gateway-offline="true"/);

  // 4. MobileHomeScreen unique keys + gatewayId propagation + crossGateway badge + undefined gatewayId fallback
  const validSettingsSnapshot = {
    isOpen: false,
    section: 'appearance',
    theme: 'obsidian-gold',
    locale: 'zh',
    fontPrefs: { uiFont: 'system', monoFont: 'jetbrains-mono', sizeScale: 'medium' },
    activityVariant: 'prolate-lattice',
    conversationWidth: 'wide',
    leftRailLayout: 'dual-rail',
    presenceLayout: 'stage',
    providers: { status: 'idle' },
    providerViews: { status: 'ready', data: [] },
    providerFailures: [],
    subscriptionCatalog: { status: 'ready', data: [] },
    customEndpoints: { status: 'ready', data: [] },
    endpointProfiles: {},
    endpointFailures: [],
    bots: [{ profile: 'default', displayName: 'Default' }],
    scopedProfile: 'default',
    profiles: { status: 'ready', data: [{ name: 'default', displayName: 'Default' }] },
    botManagement: {
      status: { status: 'ready', activeBotId: 'default' },
      activeBotId: 'default',
      roster: [{ id: 'default', displayName: 'Default', model: '', isDefault: true, hasDraft: false }],
      activeDetail: null,
      availableModels: [],
      isBusy: false,
      wizard: {
        open: false,
        busy: false,
        draft: {
          mode: 'blank', name: '', displayName: '', description: '', model: '', provider: '',
          cloneFrom: '', cloneChannels: true, mirrorCredentials: true,
        },
      },
      exitPrompt: null,
    },
    providerAdminBusy: false,
    mcp: { status: 'ready', data: [] },
    skills: { status: 'ready', data: [] },
    gateway: { url: 'http://127.0.0.1:8642', username: 'admin', hasStoredPassword: false, profileName: 'default', latencyMs: 0, status: 'connected', test: null },
    appVersion: '0.1.0',
    platform: 'ios',
    busy: false,
  };

  const mProfiles = [
    { name: 'default', displayName: 'NodeA Bot', isDefault: true, gatewayId: 'gw-a', gatewayLabel: 'Alpha' },
    { name: 'default', displayName: 'NodeB Bot', isDefault: false, gatewayId: 'gw-b', gatewayLabel: 'Beta', gatewayOffline: true },
    { name: 'solo', displayName: 'NoGw Bot', isDefault: false },
  ];
  const mGroups = [
    { roomId: 'room-shared', name: 'Shared Room A', members: ['default'], createdAt: 10, updatedAt: 100, gatewayId: 'gw-a', gatewayLabel: 'Alpha', crossGateway: true },
    { roomId: 'room-shared', name: 'Shared Room B', members: ['default'], createdAt: 10, updatedAt: 90, gatewayId: 'gw-b', gatewayLabel: 'Beta', gatewayOffline: true },
    { roomId: 'room-plain', name: 'NoGw Room', members: ['solo'], createdAt: 10, updatedAt: 50 },
  ];
  const mSessions = [
    { id: 'sess-shared', title: 'Same Sess A', model: 'm', time: '10:00', timestamp: 200, botName: 'default', gatewayId: 'gw-a', gatewayLabel: 'Alpha' },
    { id: 'sess-shared', title: 'Same Sess B', model: 'm', time: '09:00', timestamp: 190, botName: 'default', gatewayId: 'gw-b', gatewayLabel: 'Beta', gatewayOffline: true },
    { id: 'sess-plain', title: 'NoGw Sess', model: 'm', time: '08:00', timestamp: 80, botName: 'solo' },
  ];
  const mobileHomeVm = buildMobileHomeModel({
    activeSessionId: '',
    activeFocus: { type: 'bot', botName: 'default', gatewayId: 'gw-a' },
    profiles: mProfiles,
    groups: mGroups,
    sessions: mSessions,
    profileName: 'default',
    searchQuery: '',
    collapsed: { bots: false, groups: false, sessions: false },
    gatewayCount: 2,
  });

  const mobileCalls = [];
  const noop = () => {};
  const homeDriver = createReactDriver();
  try {
    const homeTree = homeDriver.render(React.createElement(MobileHomeScreen, {
      homeTab: 'chats',
      model: mobileHomeVm,
      allProfiles: mProfiles,
      groupAvatars: mProfiles,
      activeBotName: 'default',
      gatewayConnected: true,
      gatewayConnecting: false,
      connectionPhase: 'connected',
      searchOpen: false,
      searchQuery: '',
      botSubpage: null,
      settingsSnapshot: validSettingsSnapshot,
      modelDetails: [],
      sectionsCollapsed: { bots: false, groups: false, sessions: false },
      onSelectHomeTab: noop,
      onSelectBotSubpage: noop,
      onOpenSettings: noop,
      onOpenSettingsGateway: noop,
      onOpenSearch: noop,
      onCloseSearch: noop,
      onSearchChange: noop,
      onOpenNewChat: noop,
      onToggleSection: noop,
      onSelectBot: (b, gw) => mobileCalls.push(['bot', b, gw]),
      onSelectGroup: (r, gw) => mobileCalls.push(['group', r, gw]),
      onSelectSession: (s, b, gw) => mobileCalls.push(['session', s, b, gw]),
      onOpenActionSheet: noop,
      settingsActions: {},
    }));
    const rowBtns = findElements(homeTree, (el) => el.type === 'button' && Boolean(el.props?.['data-kind']));
    const hasBadge = (el, label) => JSON.stringify(el).includes(`"data-gateway-badge":"${label}"`);
    const botBtns = rowBtns.filter((el) => el.props['data-kind'] === 'bot');
    const grpBtns = rowBtns.filter((el) => el.props['data-kind'] === 'group');
    const sessBtns = rowBtns.filter((el) => el.props['data-kind'] === 'session');
    assert.equal(botBtns.length, 3);
    assert.equal(grpBtns.length, 3);
    assert.equal(sessBtns.length, 3);
    const botBtnB = botBtns.find((el) => hasBadge(el, 'Beta'));
    const grpBtnA = grpBtns.find((el) => hasBadge(el, 'Alpha'));
    const sessBtnB = sessBtns.find((el) => hasBadge(el, 'Beta'));
    assert.ok(botBtnB && grpBtnA && sessBtnB);
    assert.equal(botBtnB.props['data-gateway-offline'], 'true');
    assert.equal(sessBtnB.props['data-gateway-offline'], 'true');
    const fakeEvt = { stopPropagation() {}, preventDefault() {} };
    botBtnB.props.onClick(fakeEvt);
    grpBtnA.props.onClick(fakeEvt);
    sessBtnB.props.onClick(fakeEvt);
    assert.deepEqual(mobileCalls, [
      ['bot', 'default', 'gw-b'],
      ['group', 'room-shared', 'gw-a'],
      ['session', 'sess-shared', 'default', 'gw-b'],
    ]);
  } finally {
    homeDriver.cleanupAll();
  }

  // 5. MobileWorkspaceShell + MobileConversationScreen offline read-only guard & composer disable
  const offlineStageHtml = renderToStaticMarkup(React.createElement(MobileWorkspaceShell, {
    snapshot: {
      platform: 'ios', theme: 'obsidian-gold', appearancePref: 'system', locale: 'zh',
      gatewayConnected: true, gatewayConnecting: false, gatewayCount: 2, activeEntityGatewayOffline: true,
      connectionPhase: 'connected', homeModel: mobileHomeVm, allProfiles: mProfiles, groupAvatars: mProfiles,
      activePane: 'stage', homeTab: 'chats', searchOpen: false, searchQuery: '',
      sectionsCollapsed: { bots: false, groups: false, sessions: false },
      activeFocus: { type: 'session', sessionId: 'sess-shared', botName: 'default', gatewayId: 'gw-b' },
      activeBotName: 'default', activeBotDisplayName: 'NodeB Bot', isStreaming: false, messagesCount: 1,
      selectedModel: 'm', availableModels: ['m'], modelDetails: [], attachments: [], dockNotice: '',
      sideAgentCapsules: [], newChatOpen: false, newChatStep: 'pick', subagentSheetOpen: false,
      inspectorTab: 'files', fileTreeState: { status: 'idle' }, fileTreeExpandedPaths: [], fileTreeFilterQuery: '',
      learningState: { status: 'idle' }, learningDetail: { status: 'idle' }, settingsOpen: false,
      settingsSubpage: null, botSubpage: null, settingsSnapshot: validSettingsSnapshot, actionSheet: null,
    },
    actions: {
      onSelectPane: noop, onSelectHomeTab: noop, onSelectBotSubpage: noop, onOpenSearch: noop, onCloseSearch: noop,
      onSearchChange: noop, onToggleSection: noop, onOpenNewChat: noop, onCloseNewChat: noop, onNewChatSelectStep: noop,
      onSubmitNewChat: noop, onSelectBot: noop, onSelectGroup: noop, onSelectSession: noop, onOpenActionSheet: noop,
      onCloseActionSheet: noop, onActionRename: noop, onActionTogglePin: noop, onActionToggleArchive: noop,
      onActionDelete: noop, onOpenInspectorTab: noop, onRefreshFileTree: noop, onToggleFileTreeDir: noop,
      onSetFileTreeFilter: noop, onOpenWorkspaceFile: noop, onEnsureLearning: noop, onRefreshLearning: noop,
      onLoadLearningDetail: noop, onEditLearningNode: async () => ({ ok: true }), onDeleteLearningNode: async () => ({ ok: true }),
      onCloseSubagentSheet: noop, onCopyInspectorText: noop, onSendMessage: noop, onInterruptTurn: noop,
      onSelectModel: noop, onRefreshModels: noop, onOpenAttachmentPicker: noop, onRemoveAttachment: noop,
      onOpenSettings: noop, onCloseSettings: noop, onSelectSettingsSubpage: noop, onSetAppearancePreference: noop,
      onRetryConnect: noop, settingsActions: {},
    },
  }));
  assert.match(offlineStageHtml, /当前节点已离线，正在只读浏览本地缓存/);
  assert.match(offlineStageHtml, /disabled=""/);

  const customNoticeStageHtml = renderToStaticMarkup(React.createElement(MobileConversationScreen, {
    gatewayConnected: true,
    activeEntityGatewayOffline: true,
    connectionPhase: 'connected',
    activeFocus: { type: 'bot', botName: 'default', gatewayId: 'gw-b' },
    activeBotDisplayName: 'NodeB Bot',
    isStreaming: false,
    messagesCount: 0,
    selectedModel: 'm',
    availableModels: ['m'],
    modelDetails: [],
    attachments: [],
    dockNotice: 'Custom Offline Warning',
    sideAgentCapsules: [],
    onSendMessage: noop, onInterruptTurn: noop, onSelectModel: noop, onRefreshModels: noop,
    onOpenAttachmentPicker: noop, onRemoveAttachment: noop, onOpenSettings: noop,
  }));
  assert.match(customNoticeStageHtml, /Custom Offline Warning/);

  // 6. LeftRail + GroupedLeftRail + MobileHomeScreen forward gatewayId on done/restore/actionSheet
  const doneRestoreCalls = [];
  const railProfiles = [
    { name: 'default', displayName: 'NodeA Bot', isDefault: true, gatewayId: 'gw-a', gatewayLabel: 'Alpha' },
    { name: 'default', displayName: 'NodeB Bot', isDefault: false, gatewayId: 'gw-b', gatewayLabel: 'Beta' },
  ];
  const railProjects = [{ id: 'proj-a', name: 'ProjA', path: '/proj-a', gatewayId: 'gw-a' }];
  const railFolders = [{ id: 'fold-1', name: 'Fold 1' }];
  const railAssignments = { 'room:grp-fold': 'fold-1' };
  const railGroups = [
    { roomId: 'grp-fold', name: 'Folder Group', members: ['default'], createdAt: 1, updatedAt: 70, gatewayId: 'gw-a', gatewayLabel: 'Alpha' },
    { roomId: 'grp-free', name: 'Free Group', members: ['default'], createdAt: 1, updatedAt: 60, gatewayId: 'gw-b', gatewayLabel: 'Beta' },
    { roomId: 'grp-done', name: 'Done Group', members: ['default'], createdAt: 1, updatedAt: 40, gatewayId: 'gw-b', gatewayLabel: 'Beta', isDone: true },
  ];
  const railSessions = [
    { id: 'sess-proj', title: 'Proj Session', model: 'm', time: '10:00', timestamp: 80, botName: 'default', cwd: '/proj-a', gatewayId: 'gw-b', gatewayLabel: 'Beta' },
    { id: 'sess-free', title: 'Free Session', model: 'm', time: '09:00', timestamp: 50, botName: 'default', gatewayId: 'gw-a', gatewayLabel: 'Alpha' },
    { id: 'sess-done', title: 'Done Session', model: 'm', time: '08:00', timestamp: 30, botName: 'default', gatewayId: 'gw-a', gatewayLabel: 'Alpha', isDone: true },
  ];

  const dualGroups = [
    { roomId: 'grp-fold', name: 'Folder Group', members: ['default'], createdAt: 1, updatedAt: 70, gatewayId: 'gw-a', gatewayLabel: 'Alpha' },
    { roomId: 'grp-free', name: 'Free Group', members: ['default'], createdAt: 1, updatedAt: 60, gatewayId: 'gw-a', gatewayLabel: 'Alpha' },
    { roomId: 'grp-done', name: 'Done Group', members: ['default'], createdAt: 1, updatedAt: 40, gatewayId: 'gw-a', gatewayLabel: 'Alpha', isDone: true },
  ];
  const dualSessions = [
    { id: 'sess-proj', title: 'Proj Session', model: 'm', time: '10:00', timestamp: 80, botName: 'default', cwd: '/proj-a', gatewayId: 'gw-a', gatewayLabel: 'Alpha' },
    { id: 'sess-free', title: 'Free Session', model: 'm', time: '09:00', timestamp: 50, botName: 'default', gatewayId: 'gw-a', gatewayLabel: 'Alpha' },
    { id: 'sess-done', title: 'Done Session', model: 'm', time: '08:00', timestamp: 30, botName: 'default', gatewayId: 'gw-a', gatewayLabel: 'Alpha', isDone: true },
  ];

  const dualLeftModel = buildLeftRailModel({
    activeSessionId: '',
    activeFocus: { type: 'bot', botName: 'default', gatewayId: 'gw-a' },
    sessions: dualSessions,
    profileName: 'default',
    profiles: railProfiles,
    groups: dualGroups,
    projects: railProjects,
    folders: railFolders,
    assignments: railAssignments,
    containerCollapsed: { done: false },
    showDoneSection: true,
    searchQuery: '',
    gatewayCount: 2,
    isGroupsGroupExpanded: true,
    isSessionsGroupExpanded: true,
  });
  const groupedLeftModel = buildGroupedLeftRailModel({
    activeSessionId: '',
    activeFocus: { type: 'bot', botName: 'default', gatewayId: 'gw-a' },
    sessions: railSessions,
    profileName: 'default',
    profiles: railProfiles,
    groups: railGroups,
    projects: railProjects,
    folders: railFolders,
    assignments: railAssignments,
    containerCollapsed: { done: false },
    showDoneSection: true,
    searchQuery: '',
    gatewayCount: 2,
    isBotsGroupExpanded: true,
    isGroupsGroupExpanded: true,
    isSessionsGroupExpanded: true,
  });

  const sharedRailHandlers = {
    collapsed: false,
    searchQuery: '',
    groupAvatars: railProfiles,
    onSelectSession: noop,
    onSelectBot: noop,
    onSelectGroup: noop,
    onOpenSessionMenu: noop,
    onOpenBotMenu: noop,
    onOpenGroupMenu: noop,
    onSearchChange: noop,
    onNewChat: noop,
    onToggleBots: noop,
    onToggleSessions: noop,
    onToggleGroups: noop,
    onStartGroupRename: noop,
    onConfirmGroupRename: noop,
    onCancelGroupRename: noop,
    onResizeStart: noop,
    onRequestMarkDone: (kind, id, _title, profile, gatewayId) => doneRestoreCalls.push(['mark', kind, id, profile, gatewayId]),
    onRestoreDone: (kind, id, profile, gatewayId) => doneRestoreCalls.push(['restore', kind, id, profile, gatewayId]),
  };

  const dualDriver = createReactDriver();
  try {
    const dualTree = dualDriver.render(React.createElement(LeftRail, {
      ...sharedRailHandlers,
      model: dualLeftModel,
      layout: 'dual-rail',
    }));
    const dualBtns = findElements(dualTree, (el) => el.type === 'button' && Boolean(el.props?.['data-row-hover-action']));
    assert.equal(dualBtns.length, 6);
    for (const btn of dualBtns) btn.props.onClick({ stopPropagation() {} });
  } finally {
    dualDriver.cleanupAll();
  }
  assert.deepEqual(doneRestoreCalls, [
    ['mark', 'session', 'sess-proj', 'default', 'gw-a'],
    ['mark', 'group', 'grp-fold', undefined, 'gw-a'],
    ['mark', 'group', 'grp-free', undefined, 'gw-a'],
    ['mark', 'session', 'sess-free', 'default', 'gw-a'],
    ['restore', 'group', 'grp-done', undefined, 'gw-a'],
    ['restore', 'session', 'sess-done', 'default', 'gw-a'],
  ]);

  const groupedCalls = [];
  const groupedDriver = createReactDriver();
  try {
    const groupedTree = groupedDriver.render(React.createElement(GroupedLeftRail, {
      ...sharedRailHandlers,
      model: dualLeftModel,
      groupedModel: groupedLeftModel,
      onRequestMarkDone: (kind, id, _title, profile, gatewayId) => groupedCalls.push(['mark', kind, id, profile, gatewayId]),
      onRestoreDone: (kind, id, profile, gatewayId) => groupedCalls.push(['restore', kind, id, profile, gatewayId]),
    }));
    const groupedBtns = findElements(groupedTree, (el) => el.type === 'button' && Boolean(el.props?.['data-row-hover-action']));
    assert.equal(groupedBtns.length, 6);
    for (const btn of groupedBtns) btn.props.onClick({ stopPropagation() {} });
  } finally {
    groupedDriver.cleanupAll();
  }
  assert.deepEqual(groupedCalls, [
    ['mark', 'session', 'sess-proj', 'default', 'gw-b'],
    ['mark', 'group', 'grp-fold', undefined, 'gw-a'],
    ['mark', 'group', 'grp-free', undefined, 'gw-b'],
    ['mark', 'session', 'sess-free', 'default', 'gw-a'],
    ['restore', 'group', 'grp-done', undefined, 'gw-b'],
    ['restore', 'session', 'sess-done', 'default', 'gw-a'],
  ]);

  const sheetCalls = [];
  const actionSheetDriver = createReactDriver();
  try {
    const sheetTree = actionSheetDriver.render(React.createElement(MobileHomeScreen, {
      homeTab: 'chats',
      model: mobileHomeVm,
      allProfiles: mProfiles,
      groupAvatars: mProfiles,
      activeBotName: 'default',
      gatewayConnected: true,
      gatewayConnecting: false,
      connectionPhase: 'connected',
      searchOpen: false,
      searchQuery: '',
      botSubpage: null,
      settingsSnapshot: validSettingsSnapshot,
      modelDetails: [],
      sectionsCollapsed: { bots: false, groups: false, sessions: false },
      onSelectHomeTab: noop,
      onSelectBotSubpage: noop,
      onOpenSettings: noop,
      onOpenSettingsGateway: noop,
      onOpenSearch: noop,
      onCloseSearch: noop,
      onSearchChange: noop,
      onOpenNewChat: noop,
      onToggleSection: noop,
      onSelectBot: noop,
      onSelectGroup: noop,
      onSelectSession: noop,
      onOpenActionSheet: (sheet) => sheetCalls.push([sheet.kind, sheet.id, sheet.gatewayId]),
      settingsActions: {},
    }));
    const rowBtns2 = findElements(sheetTree, (el) => el.type === 'button' && Boolean(el.props?.['data-kind']));
    const hasBadge2 = (el, label) => JSON.stringify(el).includes(`"data-gateway-badge":"${label}"`);
    const fakeCtx = { preventDefault() {}, stopPropagation() {} };
    rowBtns2.find((el) => el.props['data-kind'] === 'bot' && hasBadge2(el, 'Beta')).props.onContextMenu(fakeCtx);
    rowBtns2.find((el) => el.props['data-kind'] === 'group' && hasBadge2(el, 'Alpha')).props.onContextMenu(fakeCtx);
    rowBtns2.find((el) => el.props['data-kind'] === 'session' && hasBadge2(el, 'Beta')).props.onContextMenu(fakeCtx);
  } finally {
    actionSheetDriver.cleanupAll();
  }
  assert.deepEqual(sheetCalls, [
    ['bot', 'default', 'gw-b'],
    ['group', 'room-shared', 'gw-a'],
    ['session', 'sess-shared', 'gw-b'],
  ]);
});

test('M1.3 Review Fixes UI: 单网关 __default__ 不渲染死按钮, 群聊行内重命名/BotHub 透传 gatewayId, 群聊拼图头像防串台', () => {
  const noop = () => {};
  const recons = [];
  const discs = [];
  let manages = 0;

  // 1. Titlebar single-gateway fallback omits dead __default__ disconnect/reconnect buttons
  const singleTbDriver = createReactDriver();
  try {
    const tClosed = singleTbDriver.render(React.createElement(Titlebar, {
      platform: 'darwin', isMaximized: false, gatewayConnected: true,
      onMinimize: noop, onMaximize: noop, onClose: noop, onToggleLeftRail: noop, onToggleInspector: noop, onOpenSettings: noop,
      onReconnectGateway: (gid) => recons.push(gid), onDisconnectGateway: (gid) => discs.push(gid), onManageGateways: () => { manages += 1; },
    }));
    findElements(tClosed, (el) => el.props?.id === 'titlebar-gateway-health-btn')[0].props.onClick({ stopPropagation() {} });
    const tOpen = singleTbDriver.render(React.createElement(Titlebar, {
      platform: 'darwin', isMaximized: false, gatewayConnected: true,
      onMinimize: noop, onMaximize: noop, onClose: noop, onToggleLeftRail: noop, onToggleInspector: noop, onOpenSettings: noop,
      onReconnectGateway: (gid) => recons.push(gid), onDisconnectGateway: (gid) => discs.push(gid), onManageGateways: () => { manages += 1; },
    }));
    assert.equal(findElements(tOpen, (el) => el.props?.['data-testid'] === 'gw-health-action-__default__').length, 0);
    const manageBtn = findElements(tOpen, (el) => el.props?.['data-testid'] === 'gw-health-manage-btn')[0];
    assert.ok(manageBtn);
    manageBtn.props.onClick();
    assert.equal(manages, 1);
  } finally {
    singleTbDriver.cleanupAll();
  }

  // 2. Titlebar multi-gateway mode renders live per-slot buttons and forwards gatewayId
  const multiTbDriver = createReactDriver();
  try {
    const gws = [
      { gatewayId: 'gw-a', name: 'Office', status: 'connected', connected: true, routeKind: 'direct' },
      { gatewayId: 'gw-b', name: 'Home', status: 'offline', connected: false, routeKind: 'lan' },
    ];
    const t0 = multiTbDriver.render(React.createElement(Titlebar, {
      platform: 'darwin', isMaximized: false, gatewayConnected: true, connectionStatus: 'partial', gateways: gws,
      onMinimize: noop, onMaximize: noop, onClose: noop, onToggleLeftRail: noop, onToggleInspector: noop, onOpenSettings: noop,
      onReconnectGateway: (gid) => recons.push(gid), onDisconnectGateway: (gid) => discs.push(gid), onManageGateways: noop,
    }));
    findElements(t0, (el) => el.props?.id === 'titlebar-gateway-health-btn')[0].props.onClick({ stopPropagation() {} });
    const t1 = multiTbDriver.render(React.createElement(Titlebar, {
      platform: 'darwin', isMaximized: false, gatewayConnected: true, connectionStatus: 'partial', gateways: gws,
      onMinimize: noop, onMaximize: noop, onClose: noop, onToggleLeftRail: noop, onToggleInspector: noop, onOpenSettings: noop,
      onReconnectGateway: (gid) => recons.push(gid), onDisconnectGateway: (gid) => discs.push(gid), onManageGateways: noop,
    }));
    findElements(t1, (el) => el.props?.['data-testid'] === 'gw-health-action-gw-a')[0].props.onClick();
    findElements(t1, (el) => el.props?.['data-testid'] === 'gw-health-action-gw-b')[0].props.onClick();
  } finally {
    multiTbDriver.cleanupAll();
  }
  assert.deepEqual(discs, ['gw-a']);
  assert.deepEqual(recons, ['gw-b']);

  // 3. LeftRail & GroupedLeftRail inline group rename scopes editingGroupGatewayId and passes gatewayId
  const submitRenameViaDriver = (driver, renderProps, expectedInitial, nextName) => {
    const initialTree = driver.render(renderProps());
    const inputs = findElements(initialTree, (el) => el.type === 'input' && String(el.props?.id || '').startsWith('rail-group-rename-input-'));
    assert.equal(inputs.length, 1);
    assert.equal(inputs[0].props.value, expectedInitial);
    inputs[0].props.onChange({ currentTarget: { value: nextName } });
    const updatedTree = driver.render(renderProps());
    const forms = findElements(updatedTree, (el) => el.type === 'form');
    assert.equal(forms.length, 1);
    forms[0].props.onSubmit({ preventDefault() {} });
  };

  // 3. Colliding group roomId inline rename isolation (LeftRail & GroupedLeftRail)
  const renameConfirms = [];
  const collideGroups = [
    { roomId: 'room-shared', name: 'AlphaRoom', members: ['default'], updatedAt: 20, gatewayId: 'gw-a', gatewayLabel: 'Alpha' },
    { roomId: 'room-shared', name: 'BetaRoom', members: ['default'], updatedAt: 10, gatewayId: 'gw-b', gatewayLabel: 'Beta' },
  ];
  const collideModel = buildLeftRailModel({
    activeSessionId: '', activeFocus: { type: 'bot', botName: 'default' },
    sessions: [], profileName: 'default', profiles: [], groups: collideGroups,
    gatewayCount: 2, isSessionsGroupExpanded: true, isGroupsGroupExpanded: true, profilesPhase: 'ready', sessionsPhase: 'ready', error: '',
  });
  const dualRenDriver = createReactDriver();
  try {
    submitRenameViaDriver(dualRenDriver, () => React.createElement(LeftRail, {
      model: collideModel, layout: 'dual-rail', collapsed: false, searchQuery: '',
      editingGroupRoomId: 'room-shared', editingGroupGatewayId: 'gw-b', groupAvatars: [],
      onSelectSession: noop, onSelectBot: noop, onSelectGroup: noop,
      onOpenSessionMenu: noop, onOpenBotMenu: noop, onOpenGroupMenu: noop,
      onSearchChange: noop, onNewChat: noop, onToggleSessions: noop, onToggleGroups: noop,
      onStartGroupRename: noop,
      onConfirmGroupRename: (id, name, gw) => renameConfirms.push([id, name, gw]),
      onCancelGroupRename: noop, onResizeStart: noop,
    }), 'BetaRoom', 'BetaRenamed');
  } finally {
    dualRenDriver.cleanupAll();
  }
  const grpRenModel = buildGroupedLeftRailModel({
    activeSessionId: '', activeFocus: { type: 'bot', botName: 'default' },
    sessions: [], profileName: 'default', profiles: [], groups: collideGroups,
    gatewayCount: 2, isBotsGroupExpanded: true, isGroupsGroupExpanded: true, isSessionsGroupExpanded: true,
    profilesPhase: 'ready', sessionsPhase: 'ready', error: '',
  });
  const grpRenDriver = createReactDriver();
  try {
    submitRenameViaDriver(grpRenDriver, () => React.createElement(GroupedLeftRail, {
      model: collideModel, groupedModel: grpRenModel, collapsed: false, searchQuery: '',
      editingGroupRoomId: 'room-shared', editingGroupGatewayId: 'gw-a', groupAvatars: [],
      onSelectSession: noop, onSelectBot: noop, onSelectGroup: noop,
      onOpenSessionMenu: noop, onOpenBotMenu: noop, onOpenGroupMenu: noop,
      onSearchChange: noop, onNewChat: noop, onToggleSessions: noop, onToggleGroups: noop,
      onStartGroupRename: noop,
      onConfirmGroupRename: (id, name, gw) => renameConfirms.push([id, name, gw]),
      onCancelGroupRename: noop, onResizeStart: noop,
    }), 'AlphaRoom', 'AlphaRenamed');
  } finally {
    grpRenDriver.cleanupAll();
  }

  // Exercise folder group, done group, and unscoped isEditingGroup (!editingGatewayId / !gatewayId)
  const orgGroups = [
    { roomId: 'room-fld', name: 'FolderRoom', members: ['default'], updatedAt: 30, gatewayId: 'gw-b', gatewayLabel: 'Beta' },
    { roomId: 'room-done', name: 'DoneRoom', members: ['default'], updatedAt: 25, gatewayId: 'gw-b', gatewayLabel: 'Beta' },
    { roomId: 'room-plain', name: 'PlainRoom', members: ['default'], updatedAt: 5 },
  ];
  const orgRenameModel = buildLeftRailModel({
    activeSessionId: '', activeFocus: { type: 'bot', botName: 'default' },
    sessions: [], profileName: 'default', profiles: [], groups: orgGroups,
    folders: [{ id: 'fld-1', name: 'WorkFolder', order: 0 }],
    assignments: { 'room:room-fld': 'fld-1' },
    doneRoomIds: ['room-done'],
    doneRoomsMap: { 'room-done': 25 },
    containerCollapsed: { 'fld-1': false, done: false },
    showDoneSection: true,
    gatewayCount: 2, isSessionsGroupExpanded: true, isGroupsGroupExpanded: true, profilesPhase: 'ready', sessionsPhase: 'ready', error: '',
  });
  for (const [roomId, gwId, expected, next] of [
    ['room-fld', 'gw-b', 'FolderRoom', 'FolderRenamed'],
    ['room-done', 'gw-b', 'DoneRoom', 'DoneRenamed'],
    ['room-plain', 'gw-a', 'PlainRoom', 'PlainRenamed'],
    ['room-plain', undefined, 'PlainRoom', 'PlainNoGw'],
  ]) {
    const d = createReactDriver();
    try {
      submitRenameViaDriver(d, () => React.createElement(LeftRail, {
        model: orgRenameModel, layout: 'dual-rail', collapsed: false, searchQuery: '',
        editingGroupRoomId: roomId, editingGroupGatewayId: gwId, groupAvatars: [],
        onSelectSession: noop, onSelectBot: noop, onSelectGroup: noop,
        onOpenSessionMenu: noop, onOpenBotMenu: noop, onOpenGroupMenu: noop,
        onSearchChange: noop, onNewChat: noop, onToggleSessions: noop, onToggleGroups: noop,
        onStartGroupRename: noop,
        onConfirmGroupRename: (id, name, gw) => renameConfirms.push([id, name, gw]),
        onCancelGroupRename: noop, onResizeStart: noop,
      }), expected, next);
    } finally {
      d.cleanupAll();
    }
  }
  assert.deepEqual(renameConfirms, [
    ['room-shared', 'BetaRenamed', 'gw-b'],
    ['room-shared', 'AlphaRenamed', 'gw-a'],
    ['room-fld', 'FolderRenamed', 'gw-b'],
    ['room-done', 'DoneRenamed', 'gw-b'],
    ['room-plain', 'PlainRenamed', undefined],
    ['room-plain', 'PlainNoGw', undefined],
  ]);

  // 4. MobileBotHubScreen onOpenBotChat propagates gatewayId + botAvatar renderGroupCollageAvatar stops cross-gateway bleed
  const hubOpenCalls = [];
  const hubDriver = createReactDriver();
  try {
    const hubTree = hubDriver.render(React.createElement(MobileBotHubScreen, {
      allProfiles: [{ name: 'coder', displayName: 'Coder', gatewayId: 'gw-b' }],
      activeBotName: 'coder', gatewayConnected: true, connectionPhase: 'connected', modelDetails: [],
      settingsSnapshot: {
        section: 'agents', isOpen: true, botManagement: { status: { status: 'ready' }, roster: [], activeBotId: 'coder', activeDetail: null, activeDraft: null, isBusy: false, errorBanner: null, confirmPending: null },
        profiles: { status: 'ready', data: [] },
      },
      onSelectBotSubpage: noop, onOpenSettingsGateway: noop, settingsActions: { onSelectBotSettle: noop },
      onOpenBotChat: (name, gw) => hubOpenCalls.push([name, gw]),
    }));
    findElements(hubTree, (el) => el.props?.['data-testid'] === 'mobile-bot-open-chat')[0].props.onClick();
  } finally {
    hubDriver.cleanupAll();
  }
  const hubMissDriver = createReactDriver();
  try {
    const missTree = hubMissDriver.render(React.createElement(MobileBotHubScreen, {
      allProfiles: [],
      activeBotName: 'orphan', gatewayConnected: true, connectionPhase: 'connected', modelDetails: [],
      settingsSnapshot: {
        section: 'agents', isOpen: true,
        botManagement: { status: { status: 'ready' }, roster: [{ id: 'orphan', displayName: 'Orphan', model: '' }], activeBotId: 'orphan', activeDetail: null, activeDraft: null, isBusy: false, errorBanner: null, confirmPending: null },
        profiles: { status: 'ready', data: [] },
      },
      onSelectBotSubpage: noop, onOpenSettingsGateway: noop, settingsActions: { onSelectBotSettle: noop },
      onOpenBotChat: (name, gw) => hubOpenCalls.push([name, gw]),
    }));
    findElements(missTree, (el) => el.props?.['data-testid'] === 'mobile-bot-open-chat')[0].props.onClick();
  } finally {
    hubMissDriver.cleanupAll();
  }
  assert.deepEqual(hubOpenCalls, [['coder', 'gw-b'], ['orphan', undefined]]);

  const collageProfiles = [
    { name: 'default', displayName: 'Alpha', avatar: 'https://a.test/a.png', gatewayId: 'gw-a' },
    { name: 'shared', avatar: 'https://plain.test/u.png' },
  ];
  const htmlB = renderGroupCollageAvatar(['default', 'shared'], collageProfiles, 28, 'gw-b');
  assert.equal(htmlB.includes('https://a.test/a.png'), false, 'gw-a avatar must not bleed into gw-b collage');
  assert.equal(htmlB.includes('https://plain.test/u.png'), true, 'unscoped avatar remains allowed');
  const htmlUnscoped = renderGroupCollageAvatar(['default', 'shared'], collageProfiles, 28);
  assert.equal(htmlUnscoped.includes('https://a.test/a.png'), true);

  // leftRailModel.allAgents sort recognizes name === 'default' even when isDefault flag is omitted
  const sortedNoFlag = buildLeftRailModel({
    activeSessionId: '',
    activeFocus: { type: 'bot', botName: 'default' },
    sessions: [],
    profileName: 'default',
    profiles: [
      { name: 'coder', displayName: 'Coder', timestamp: 20 },
      { name: 'default', displayName: 'Default', timestamp: 10 },
    ],
    groups: [],
    gatewayCount: 1,
    isSessionsGroupExpanded: true,
    isGroupsGroupExpanded: true,
    profilesPhase: 'ready',
    sessionsPhase: 'ready',
    error: '',
  });
  assert.deepEqual(sortedNoFlag.allAgents.map((p) => p.name), ['default', 'coder']);
});
