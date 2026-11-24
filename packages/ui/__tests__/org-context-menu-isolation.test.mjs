/**
 * 左轨与移动端右键/长按隔离、移动容器列表及 Done 重试回归测试
 * (packages/ui/__tests__/org-context-menu-isolation.test.mjs)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { setLocale, t } from '../dist/i18n/index.js';
import { RailEntityRow } from '../dist/components-react/RailEntityRow.js';
import { RailDoneFooterSection } from '../dist/components-react/RailOrgContainers.js';
import { LeftRail } from '../dist/components-react/LeftRail.js';
import { GroupedLeftRail } from '../dist/components-react/GroupedLeftRail.js';
import { buildLeftRailModel } from '../dist/components-react/leftRailModel.js';
import { MobileHomeScreen } from '../dist/components-react/mobile/MobileHomeScreen.js';
import { MobileWorkspaceShell } from '../dist/components-react/mobile/MobileWorkspaceShell.js';
import { buildGroupedLeftRailModel } from '../dist/components-react/groupedLeftRailModel.js';
import { buildMobileHomeModel, DEFAULT_MOBILE_SECTIONS_COLLAPSED } from '../dist/components-react/mobile/mobileShellModel.js';

function findAll(node, predicate, acc = []) {
  if (!node || typeof node !== 'object') return acc;
  if (Array.isArray(node)) {
    for (const item of node) findAll(item, predicate, acc);
    return acc;
  }
  if (predicate(node)) acc.push(node);
  if (node.props && 'children' in node.props) {
    findAll(node.props.children, predicate, acc);
  }
  return acc;
}

function collectText(node) {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(collectText).join('');
  if (typeof node === 'object' && node.props && 'children' in node.props) {
    return collectText(node.props.children);
  }
  return '';
}

function createReactHookDriver() {
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

    const elType = node.type;
    if (typeof elType === 'symbol') {
      return {
        ...node,
        props: { ...node.props, children: resolve(node.props?.children, `${key}.frag`) },
      };
    }
    if (
      elType &&
      typeof elType === 'object' &&
      (elType.$$typeof === Symbol.for('react.context') || elType.$$typeof === Symbol.for('react.provider'))
    ) {
      const ctx = elType._context ?? elType;
      const prevVal = ctx._currentValue;
      ctx._currentValue = node.props?.value;
      try {
        return {
          ...node,
          props: { ...node.props, children: resolve(node.props?.children, `${key}.ctx`) },
        };
      } finally {
        ctx._currentValue = prevVal;
      }
    }

    const innerType =
      elType && typeof elType === 'object' && elType.$$typeof === Symbol.for('react.memo')
        ? elType.type
        : elType;
    const compFn =
      innerType && typeof innerType === 'object' && innerType.$$typeof === Symbol.for('react.forward_ref')
        ? (p) => innerType.render(p, p.ref ?? node.ref ?? null)
        : typeof innerType === 'function'
          ? innerType
          : null;

    if (compFn) {
      let slot = slots.get(key);
      if (!slot) {
        slot = { states: [], refs: [], memos: [], effects: [] };
        slots.set(key, slot);
      }
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
          if (idx >= slot.states.length) {
            slot.states.push(typeof init === 'function' ? init() : init);
          }
          const setter = (next) => {
            slot.states[idx] = typeof next === 'function' ? next(slot.states[idx]) : next;
          };
          return [slot.states[idx], setter];
        },
        useReducer(reducer, initialArg, init) {
          const idx = sIdx++;
          if (idx >= slot.states.length) {
            slot.states.push(init ? init(initialArg) : initialArg);
          }
          const dispatch = (action) => {
            slot.states[idx] = reducer(slot.states[idx], action);
          };
          return [slot.states[idx], dispatch];
        },
        useImperativeHandle() {},
        useTransition() {
          return [false, (fn) => fn()];
        },
        useDeferredValue(val) {
          return val;
        },
        use(usable) {
          return usable?._currentValue;
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
            const changed = !deps || !prev.deps || deps.some((d, i) => !Object.is(d, prev.deps[i]));
            if (changed) slot.memos[idx] = { value: factory(), deps };
          }
          return slot.memos[idx].value;
        },
        useCallback(cb) {
          return cb;
        },
        useEffect: scheduleEffect,
        useLayoutEffect: scheduleEffect,
        useInsertionEffect: scheduleEffect,
        useDebugValue() {},
        useId() {
          return `id-${key}`;
        },
        useContext(ctx) {
          return ctx?._currentValue;
        },
        useSyncExternalStore(_sub, getSnap) {
          return getSnap();
        },
      };
      let rendered;
      try {
        rendered = compFn(node.props);
      } finally {
        internals.H = prevH;
      }
      return resolve(rendered, `${key}>${compFn.name || 'Fn'}`);
    }

    if (node.props && 'children' in node.props) {
      return {
        ...node,
        props: { ...node.props, children: resolve(node.props.children, key) },
      };
    }
    return node;
  }

  return {
    mount(renderFn) {
      let tree = null;
      const rerender = () => {
        pendingEffects = [];
        tree = resolve(renderFn(), 'root');
        const currentEffects = pendingEffects;
        pendingEffects = [];
        for (const effect of currentEffects) effect();
        return tree;
      };
      rerender();
      return {
        get tree() {
          return tree;
        },
        rerender,
        unmount() {
          for (const slot of slots.values()) {
            for (const entry of slot.effects) {
              if (typeof entry.cleanup === 'function') {
                entry.cleanup();
                entry.cleanup = undefined;
              }
            }
          }
        },
      };
    },
  };
}

test('RailEntityRow / LeftRail / GroupedLeftRail 右键事件隔离与 data-entity-row 标注', () => {
  setLocale('zh-CN');

  const rowTree = RailEntityRow({
    active: false,
    title: '排查会话',
    entityKind: 'session',
    hoverAction: { label: '完成', ariaLabel: '完成', icon: 'done', onAction: () => {} },
    onContextMenu: () => {},
  });
  assert.equal(rowTree.props['data-entity-row'], 'session');
  const hoverBtn = findAll(rowTree, (n) => n.props?.['data-row-hover-action'] === 'done')[0];
  let hoverPrevented = false;
  let hoverStopped = false;
  hoverBtn.props.onContextMenu({
    preventDefault: () => { hoverPrevented = true; },
    stopPropagation: () => { hoverStopped = true; },
  });
  assert.equal(hoverPrevented, true);
  assert.equal(hoverStopped, true);

  // 未传 hoverAction 的 RailEntityRow 渲染结果也不得带多余 <svg>
  const plainSessionHtml = renderToStaticMarkup(
    React.createElement(RailEntityRow, {
      active: false,
      title: '纯会话',
      entityKind: 'session',
    }),
  );
  assert.ok(plainSessionHtml.includes('data-entity-row="session"'));
  assert.equal(plainSessionHtml.includes('<svg'), false);

  // LeftRail 与 GroupedLeftRail 行级右键必须 stopPropagation，绝不冒泡到 #session-list-container 变成 rail 菜单
  const calls = [];
  const profiles = [{ name: 'default', displayName: '默认中枢', isDefault: true }];
  const sessions = [{ id: 's-1', title: '普通会话', botName: 'default', activityState: 'read' }];
  const groups = [{ roomId: 'r-1', name: '研讨群', members: ['default'] }];

  const dualModel = buildLeftRailModel({
    activeSessionId: 's-1',
    activeFocus: { type: 'session', sessionId: 's-1' },
    sessions,
    profileName: 'default',
    profiles,
    groups,
    searchQuery: '',
    showDoneSection: true,
    doneError: 'HTTP 400',
    containerCollapsed: { done: false },
  });

  const baseProps = {
    model: dualModel,
    collapsed: false,
    searchQuery: '',
    onSelectSession: () => {},
    onSelectBot: () => {},
    onSelectGroup: () => {},
    onOpenSessionMenu: (id) => calls.push(['session', id]),
    onOpenBotMenu: (name) => calls.push(['bot', name]),
    onOpenGroupMenu: (id) => calls.push(['group', id]),
    onOpenRailMenu: () => calls.push(['rail']),
    onSearchChange: () => {},
    onNewChat: () => {},
    onToggleBots: () => {},
    onToggleSessions: () => {},
    onToggleGroups: () => {},
    onStartGroupRename: () => {},
    onConfirmGroupRename: () => {},
    onCancelGroupRename: () => {},
    onResizeStart: () => {},
  };

  const dualHtml = renderToStaticMarkup(React.createElement(LeftRail, baseProps));
  assert.ok(dualHtml.includes('data-entity-row="session"'));
  assert.ok(dualHtml.includes('data-entity-row="group"'));

  const groupedModel = buildGroupedLeftRailModel({
    activeSessionId: 's-1',
    activeFocus: { type: 'session', sessionId: 's-1' },
    sessions,
    profiles,
    groups,
    profileName: 'default',
    searchQuery: '',
    collapsed: { bots: false, groups: false, sessions: false, done: true },
    showDoneSection: true,
    doneError: 'HTTP 400',
  });
  const prevWin = globalThis.window;
  globalThis.window = {
    addEventListener() {},
    removeEventListener() {},
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  };
  const prevEl = globalThis.Element;
  class MockElement {
    constructor(matchSelectors = ['[data-section="bots"]']) {
      this.matchSelectors = matchSelectors;
    }
    closest(sel) {
      return this.matchSelectors.some((item) => sel.includes(item)) ? this : null;
    }
  }
  globalThis.Element = MockElement;
  const railDriver = createReactHookDriver();
  let railMounted = null;
  try {
    railMounted = railDriver.mount(() =>
      React.createElement(LeftRail, {
        ...baseProps,
        onRetryDoneSection: () => calls.push(['retry-done']),
      }),
    );
    const listContainer = findAll(railMounted.tree, (n) => n.props?.id === 'session-list-container')[0];
    assert.ok(listContainer, 'DualRailLeftRail 必须渲染 #session-list-container');
    // 来自 BOT 区或实体的右键即使冒泡到 #session-list-container 也必须被拦截
    listContainer.props.onContextMenu({
      target: new MockElement(['[data-section="bots"]']),
      clientX: 10,
      clientY: 20,
      preventDefault: () => {},
    });
    listContainer.props.onContextMenu({
      target: new MockElement(['[data-entity-row]']),
      clientX: 12,
      clientY: 24,
      preventDefault: () => {},
    });
    assert.deepEqual(calls, []);
    // 空白区域右键应正常触发 onOpenRailMenu
    let railPrevented = false;
    listContainer.props.onContextMenu({
      target: new MockElement([]),
      clientX: 15,
      clientY: 30,
      preventDefault: () => { railPrevented = true; },
    });
    assert.equal(railPrevented, true);
    assert.deepEqual(calls, [['rail']]);

    const retryHtml = renderToStaticMarkup(
      React.createElement(RailDoneFooterSection, {
        expanded: true,
        loading: false,
        error: '加载失败',
        isEmpty: true,
        onRetry: () => {},
      }, null),
    );
    assert.ok(retryHtml.includes('data-testid="rail-done-retry"'));
    assert.ok(retryHtml.includes(t('rail.doneRetry')));
  } finally {
    railMounted?.unmount();
    globalThis.window = prevWin;
    globalThis.Element = prevEl;
  }

  // GroupedLeftRail 渲染已完成失败重试按钮
  const groupedRetryHtml = renderToStaticMarkup(
    React.createElement(GroupedLeftRail, {
      ...baseProps,
      groupedModel,
      onRetryDoneSection: () => {},
    }),
  );
  assert.ok(groupedRetryHtml.includes('data-testid="rail-done-retry"'));
});

test('移动端 Done 重试按钮与 Move-to-Folder 项目/解绑列表渲染', () => {
  setLocale('zh-CN');
  const profiles = [{ name: 'default', displayName: '默认中枢', isDefault: true }];
  const model = buildMobileHomeModel({
    activeSessionId: 's-1',
    profiles,
    groups: [],
    sessions: [],
    archivedSessions: [],
    projects: [{ id: 'p-1', name: 'FluxProj', path: '/opt/data/flux', archived: false }],
    folders: [{ id: 'fld-1', name: '待处理', order: 0 }],
    profileName: 'default',
    searchQuery: '',
    collapsed: { ...DEFAULT_MOBILE_SECTIONS_COLLAPSED, done: false },
    showDoneSection: true,
    doneError: 'HTTP 502',
  });
  const homeHtml = renderToStaticMarkup(
    React.createElement(MobileHomeScreen, {
      homeTab: 'chats',
      model,
      allProfiles: profiles,
      groupAvatars: profiles,
      activeBotName: 'default',
      gatewayConnected: true,
      gatewayConnecting: false,
      searchOpen: false,
      settingsSnapshot: {
        isOpen: false,
        section: 'appearance',
        theme: 'obsidian-gold',
        locale: 'zh',
        fontPrefs: { uiFont: 'geist-sans', monoFont: 'jetbrains-mono', sizeScale: 'medium' },
        activityVariant: 'cloud',
        conversationWidth: 'wide',
        leftRailLayout: 'dual-rail',
        profiles: { status: 'ready', data: [] },
        mcp: { status: 'ready', data: [] },
        skills: { status: 'ready', data: [] },
        bots: [],
        botManagement: {
          status: { status: 'idle', activeBotId: 'default' },
          roster: [],
          activeBotId: 'default',
          availableModels: [],
          wizard: {
            open: false,
            draft: { mode: 'blank', name: '', displayName: '', description: '', model: '', provider: '', cloneFrom: '', cloneChannels: false, mirrorCredentials: false },
            busy: false,
          },
          exitPrompt: null,
          isBusy: false,
        },
        scopedProfile: 'default',
        providerViews: { status: 'ready', data: [] },
        providerFailures: [],
        subscriptionCatalog: { status: 'ready', data: [] },
        customEndpoints: { status: 'ready', data: [] },
        endpointProfiles: {},
        endpointFailures: [],
        providerAdminBusy: false,
        gateway: { url: '', username: '', hasStoredPassword: false, profileName: 'default', status: 'connected', latencyMs: 1 },
        platform: 'web',
        busy: false,
        presenceLayout: 'stage',
      },
      modelDetails: [],
      onSelectHomeTab: () => {},
      onSelectBotSubpage: () => {},
      onOpenSettings: () => {},
      onOpenSettingsGateway: () => {},
      onOpenSearch: () => {},
      onCloseSearch: () => {},
      onSearchChange: () => {},
      onOpenNewChat: () => {},
      onToggleSection: () => {},
      onRetryDoneSection: () => {},
      onSelectBot: () => {},
      onSelectGroup: () => {},
      onSelectSession: () => {},
      onOpenActionSheet: () => {},
      settingsActions: {},
    }),
  );
  assert.ok(homeHtml.includes('data-testid="mobile-done-retry"'));
  assert.ok(homeHtml.includes(t('rail.doneRetry')));

  // MobileWorkspaceShell 挂载后进入 move-folder step 时显示活跃项目 + 自定义文件夹 + 移出文件夹
  const prevMobileWin = globalThis.window;
  globalThis.window = {
    addEventListener() {},
    removeEventListener() {},
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  };
  const mobileDriver = createReactHookDriver();
  let mobileMounted = null;
  try {
    const mobileSnapshot = {
      platform: 'web',
      theme: 'obsidian-gold',
      appearancePref: 'dark',
      locale: 'zh',
      gatewayConnected: true,
      gatewayConnecting: false,
      homeModel: model,
      homeTab: 'chats',
      allProfiles: profiles,
      groupAvatars: profiles,
      projects: [{ id: 'p-1', name: 'FluxProj', path: '/opt/data/flux', archived: false }],
      folders: [{ id: 'fld-1', name: '待处理', order: 0 }],
      activePane: 'home',
      searchOpen: false,
      searchQuery: '',
      newChatOpen: false,
      newChatStep: 'compose',
      newChatTargetKind: 'bot',
      newChatTargetBot: 'default',
      newChatGroupMembers: [],
      newChatGroupName: '',
      newChatStats: { model: '', msgCount: 0, skillsCount: 0, mcpCount: 0 },
      actionSheet: {
        kind: 'session',
        id: 's-1',
        title: '调试',
        currentContainerId: 'prj:p-1',
        step: 'move-folder',
      },
      activeFocus: { type: 'session', sessionId: 's-1' },
      activeSessionId: 's-1',
      activeBotName: 'default',
      activeBotDisplayName: '默认中枢',
      activeSessionTitle: '调试',
      isStreaming: false,
      messages: [],
      messagesCount: 0,
      selectedModel: '',
      currentProvider: '',
      availableModels: [],
      modelDetails: [],
      attachments: [],
      dockNotice: '',
      sideAgentCapsules: [],
      subagentSheet: null,
      inspectorTab: 'status',
      inspectorReaderOpen: false,
      inspectorReaderItem: null,
      artifacts: [],
      gitDiffs: [],
      openFiles: [],
      fileTreeState: { status: 'idle', tree: [] },
      fileTreeExpandedPaths: [],
      fileTreeFilterQuery: '',
      activeFilePath: '',
      memories: [],
      learningState: { status: 'idle' },
      learningDetail: { status: 'idle' },
      groupMembers: [],
      settingsOpen: false,
      settingsSubpage: null,
      settingsSnapshot: {
        isOpen: false,
        section: 'appearance',
        theme: 'obsidian-gold',
        locale: 'zh',
        fontPrefs: { uiFont: 'geist-sans', monoFont: 'jetbrains-mono', sizeScale: 'medium' },
        activityVariant: 'cloud',
        conversationWidth: 'wide',
        leftRailLayout: 'dual-rail',
        profiles: { status: 'ready', data: [] },
        mcp: { status: 'ready', data: [] },
        skills: { status: 'ready', data: [] },
        bots: [],
        botManagement: {
          status: { status: 'idle', activeBotId: 'default' },
          roster: [],
          activeBotId: 'default',
          availableModels: [],
          wizard: {
            open: false,
            draft: { mode: 'blank', name: '', displayName: '', description: '', model: '', provider: '', cloneFrom: '', cloneChannels: false, mirrorCredentials: false },
            busy: false,
          },
          exitPrompt: null,
          isBusy: false,
        },
        scopedProfile: 'default',
        providerViews: { status: 'ready', data: [] },
        providerFailures: [],
        subscriptionCatalog: { status: 'ready', data: [] },
        customEndpoints: { status: 'ready', data: [] },
        endpointProfiles: {},
        endpointFailures: [],
        providerAdminBusy: false,
        gateway: { url: '', username: '', hasStoredPassword: false, profileName: 'default', status: 'connected', latencyMs: 1 },
        platform: 'web',
        busy: false,
        presenceLayout: 'stage',
      },
      botSubpage: null,
    };
    const mobileActions = {
      onSelectPane: () => {},
      onSelectHomeTab: () => {},
      onSelectBotSubpage: () => {},
      onOpenSettingsSubpage: () => {},
      onSelectBot: () => {},
      onSelectGroup: () => {},
      onSelectSession: () => {},
      onToggleSection: () => {},
      onOpenSearch: () => {},
      onCloseSearch: () => {},
      onSearchChange: () => {},
      onOpenActionSheet: () => {},
      onCloseActionSheet: () => {},
      onActionOpen: () => {},
      onActionRename: () => {},
      onActionPin: () => {},
      onActionArchive: () => {},
      onActionDelete: () => {},
      onActionDisband: () => {},
      onOpenNewChat: () => {},
      onCloseNewChat: () => {},
      onSetNewChatStep: () => {},
      onSelectNewChatBot: () => {},
      onSetNewChatGroupMembers: () => {},
      onSetNewChatGroupName: () => {},
      onSubmitNewChatMessage: () => {},
      onSendMessage: () => {},
      onInterruptTurn: () => {},
      onSelectModel: () => {},
      onOpenAttachmentPicker: () => {},
      onRemoveAttachment: () => {},
      onOpenSubagentSheet: () => {},
      onCloseSubagentSheet: () => {},
      onSelectInspectorTab: () => {},
      onOpenInspectorItem: () => {},
      onCloseInspectorReader: () => {},
      onCopyInspectorText: () => {},
      onLoadFileTree: () => {},
      onToggleFileTreeDir: () => {},
      onFilterFileTree: () => {},
      onOpenWorkspaceFile: () => {},
      onDownloadInspectorFile: () => {},
      onRefreshLearning: () => {},
      onLoadLearningDetail: () => {},
      onOpenSettings: () => {},
      onCloseSettings: () => {},
      onSelectSettingsSubpage: () => {},
      onSetAppearancePreference: () => {},
      settingsActions: {},
    };
    mobileMounted = mobileDriver.mount(() =>
      React.createElement(MobileWorkspaceShell, {
        snapshot: mobileSnapshot,
        actions: mobileActions,
      }),
    );
    const updatedTree = mobileMounted.rerender();
    assert.ok(findAll(updatedTree, (n) => n.props?.['data-folder-target'] === 'prj:p-1').length > 0);
    assert.ok(findAll(updatedTree, (n) => n.props?.['data-folder-target'] === 'fld-1').length > 0);
    assert.ok(collectText(updatedTree).includes(t('mobile.actionSheet.removeFromFolder')));
  } finally {
    mobileMounted?.unmount();
    globalThis.window = prevMobileWin;
  }
});
