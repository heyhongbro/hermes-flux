/**
 * 连接与同步状态胶囊（ConnectionStatusPill）及移动端三屏连接态契约单元测试
 * (packages/ui/__tests__/connection-status-pill.test.mjs)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { setLocale, t } from '../dist/i18n/index.js';
import {
  ConnectionStatusPill,
  mountConnectionStatusPill,
  MobileConversationScreen,
  MobileHomeScreen,
  MobileWorkspaceShell,
  Titlebar,
  buildMobileHomeModel,
} from '../dist/index.js';

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
      const scopedKey = node.key != null ? `${key}#k=${String(node.key)}` : key;
      let slot = slots.get(scopedKey);
      if (!slot) {
        slot = { states: [], refs: [], memos: [], effects: [] };
        slots.set(scopedKey, slot);
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
        useRef(init) {
          const idx = rIdx++;
          if (idx >= slot.refs.length) {
            slot.refs.push({ current: init });
          }
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
        useContext(ctx) {
          return ctx?._currentValue;
        },
        useId() {
          return `id-${scopedKey}`;
        },
      };

      let rendered;
      try {
        rendered = compFn(node.props);
      } finally {
        internals.H = prevH;
      }
      return resolve(rendered, `${scopedKey}>${compFn.name || 'Fn'}`);
    }

    if (node.props && 'children' in node.props) {
      return {
        ...node,
        props: {
          ...node.props,
          children: resolve(node.props.children, key),
        },
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
        const effects = pendingEffects;
        pendingEffects = [];
        for (const fn of effects) fn();
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
              if (typeof entry.cleanup === 'function') entry.cleanup();
            }
          }
          slots.clear();
        },
      };
    },
  };
}

function findAll(node, pred, acc = []) {
  if (!node || typeof node !== 'object') return acc;
  if (Array.isArray(node)) {
    for (const item of node) findAll(item, pred, acc);
    return acc;
  }
  if (pred(node)) acc.push(node);
  if (node.props?.children) findAll(node.props.children, pred, acc);
  return acc;
}

test('ConnectionStatusPill: 渲染七态相位、双语文案、紧凑模式与重试/设置动作', () => {
  setLocale('zh-CN');
  assert.equal(
    renderToStaticMarkup(React.createElement(ConnectionStatusPill, { phase: 'connected', layout: 'stage' })),
    '',
  );
  assert.equal(
    renderToStaticMarkup(React.createElement(ConnectionStatusPill, { phase: 'unconfigured', layout: 'floating' })),
    '',
  );

  const connectingHtml = renderToStaticMarkup(
    React.createElement(ConnectionStatusPill, { phase: 'connecting', layout: 'stage', compact: true }),
  );
  assert.match(connectingHtml, /conn-pill--stage/);
  assert.match(connectingHtml, /conn-pill--compact/);
  assert.match(connectingHtml, /data-phase="connecting"/);
  assert.match(connectingHtml, /conn-pill__ring/);
  assert.match(connectingHtml, new RegExp(t('conn.connecting')));

  const reconnecting1 = renderToStaticMarkup(
    React.createElement(ConnectionStatusPill, { phase: 'reconnecting', attempt: 1, layout: 'stage', onRetry: () => {} }),
  );
  assert.match(reconnecting1, /正在重连/);
  assert.doesNotMatch(reconnecting1, /conn-pill__action/, '第 1 次重连尚未展示手动重试按钮');

  const reconnecting3 = renderToStaticMarkup(
    React.createElement(ConnectionStatusPill, { phase: 'reconnecting', attempt: 3, layout: 'floating', onRetry: () => {} }),
  );
  assert.match(reconnecting3, /第 3 次/);
  assert.match(reconnecting3, /conn-pill__action/);
  assert.match(reconnecting3, /重试/);

  const syncingHtml = renderToStaticMarkup(
    React.createElement(ConnectionStatusPill, { phase: 'syncing', layout: 'stage' }),
  );
  assert.match(syncingHtml, /conn-pill__wave/);
  assert.match(syncingHtml, /正在同步最新内容/);

  const syncedHtml = renderToStaticMarkup(
    React.createElement(ConnectionStatusPill, { phase: 'synced', layout: 'stage' }),
  );
  assert.match(syncedHtml, /conn-pill__check/);
  assert.match(syncedHtml, /已同步最新/);

  const offlineHtml = renderToStaticMarkup(
    React.createElement(ConnectionStatusPill, { phase: 'offline', layout: 'stage', onRetry: () => {} }),
  );
  assert.match(offlineHtml, /连接已断开/);
  assert.match(offlineHtml, />重试</);

  setLocale('en-US');
  const authErrorEn = renderToStaticMarkup(
    React.createElement(ConnectionStatusPill, {
      phase: 'offline',
      isAuthError: true,
      layout: 'floating',
      onOpenSettings: () => {},
      onRetry: () => {},
    }),
  );
  assert.match(authErrorEn, /Auth failed/);
  assert.match(authErrorEn, />Settings</);
  assert.doesNotMatch(authErrorEn, />Retry</);
  setLocale('zh-CN');
});

test('ConnectionStatusPill: 节拍计时器同步、visibility/reducedMotion 暂停与稳定 onMountedChange', () => {
  const prevWin = globalThis.window;
  const prevDoc = globalThis.document;
  const prevSetTimeout = globalThis.setTimeout;
  const prevClearTimeout = globalThis.clearTimeout;
  const prevSetInterval = globalThis.setInterval;
  const prevClearInterval = globalThis.clearInterval;
  const timeouts = [];
  const intervals = [];
  const visibilityHandlers = new Set();
  const mountedLog = [];
  let retryClicks = 0;
  let reducedMotion = false;
  let docHidden = false;
  let pageHiddenAttr = null;
  let appHiddenAttr = null;

  globalThis.document = {
    get hidden() {
      return docHidden;
    },
    addEventListener(type, fn) {
      if (type === 'visibilitychange') visibilityHandlers.add(fn);
    },
    removeEventListener(type, fn) {
      if (type === 'visibilitychange') visibilityHandlers.delete(fn);
    },
    documentElement: {
      getAttribute(name) {
        if (name === 'data-page-hidden') return pageHiddenAttr;
        if (name === 'data-app-hidden') return appHiddenAttr;
        return null;
      },
    },
  };
  globalThis.window = { matchMedia: () => ({ matches: reducedMotion }) };
  globalThis.setTimeout = (fn) => {
    const id = timeouts.length + 1;
    timeouts.push({ id, fn, cleared: false });
    return id;
  };
  globalThis.clearTimeout = (id) => {
    const entry = timeouts.find((tItem) => tItem.id === id);
    if (entry) entry.cleared = true;
  };
  globalThis.setInterval = (fn) => {
    const id = intervals.length + 1;
    intervals.push({ id, fn, cleared: false });
    return id;
  };
  globalThis.clearInterval = (id) => {
    const entry = intervals.find((tItem) => tItem.id === id);
    if (entry) entry.cleared = true;
  };

  try {
    let phase = 'reconnecting';
    let attempt = 3;
    const driver = createReactHookDriver();
    const view = driver.mount(() =>
      React.createElement(ConnectionStatusPill, {
        phase,
        attempt,
        layout: 'stage',
        onRetry: () => {
          retryClicks += 1;
        },
        onMountedChange: (mounted) => mountedLog.push(mounted),
      }),
    );

    assert.deepEqual(mountedLog, [true]);
    assert.equal(intervals.length, 1);
    const retryBtn = findAll(view.tree, (n) => n.props?.className?.includes('conn-pill__action'))[0];
    retryBtn.props.onClick();
    assert.equal(retryClicks, 1);

    // 节拍推进 data-beat: 0 -> 1
    assert.equal(findAll(view.tree, (n) => n.props?.role === 'status')[0].props['data-beat'], '0');
    intervals[0].fn();
    view.rerender();
    assert.equal(findAll(view.tree, (n) => n.props?.role === 'status')[0].props['data-beat'], '1');
    // 即使 onMountedChange 使用内联新闭包也不触发误震荡
    assert.deepEqual(mountedLog, [true]);

    // visibilitychange 生命周期：可见态重复触发不重复建timer；隐藏即清除 timer；回到前台恢复新 timer
    for (const h of visibilityHandlers) h();
    assert.equal(intervals.length, 1);

    docHidden = true;
    for (const h of visibilityHandlers) h();
    assert.equal(intervals[0].cleared, true);
    for (const h of visibilityHandlers) h();

    docHidden = false;
    for (const h of visibilityHandlers) h();
    assert.equal(intervals.length, 2);
    intervals[1].fn();
    view.rerender();
    assert.equal(findAll(view.tree, (n) => n.props?.role === 'status')[0].props['data-beat'], '2');

    // data-page-hidden="true" 下时钟回调自停并清掉当前 timer，恢复后重建第 3 个 timer 验证 reducedMotion/appHidden
    pageHiddenAttr = 'true';
    intervals[1].fn();
    assert.equal(intervals[1].cleared, true);
    pageHiddenAttr = null;
    for (const h of visibilityHandlers) h();
    assert.equal(intervals.length, 3);
    appHiddenAttr = 'true';
    intervals[2].fn();
    appHiddenAttr = null;
    for (const h of visibilityHandlers) h();
    reducedMotion = true;
    intervals[3].fn();
    reducedMotion = false;
    for (const h of visibilityHandlers) h();

    // synced -> connected 时进入 exiting，但继续展示已同步文案避免退场前闪烁 offline
    phase = 'synced';
    attempt = 0;
    view.rerender();
    phase = 'connected';
    view.rerender();
    view.rerender();

    let pillEl = findAll(view.tree, (n) => n.props?.role === 'status')[0];
    assert.ok(pillEl, 'exiting 期间必须保活');
    assert.equal(pillEl.props['data-phase'], 'synced');
    assert.equal(pillEl.props['data-motion-state'], 'exiting');

    // 派发 transitionend 后归位 exited 并触发 onMountedChange(false)
    pillEl.props.onTransitionEnd({ target: pillEl, currentTarget: pillEl, propertyName: 'opacity' });
    view.rerender();
    assert.equal(view.tree, null);
    assert.equal(mountedLog[mountedLog.length - 1], false);

    // reducedMotion 初始即开启时根本不启动 interval；无 listeners 与无 window/document 兜底也可挂载卸载
    reducedMotion = true;
    const beforeReducedCount = intervals.length;
    const dReduced = createReactHookDriver();
    const vReduced = dReduced.mount(() =>
      React.createElement(ConnectionStatusPill, { phase: 'connecting', layout: 'stage' }),
    );
    assert.equal(intervals.length, beforeReducedCount);
    vReduced.unmount();
    reducedMotion = false;

    globalThis.document = { hidden: false };
    const dNoListeners = createReactHookDriver();
    const vNoListeners = dNoListeners.mount(() =>
      React.createElement(ConnectionStatusPill, { phase: 'connecting', layout: 'stage' }),
    );
    vNoListeners.unmount();

    globalThis.window = undefined;
    globalThis.document = undefined;
    const dBare = createReactHookDriver();
    const vBare = dBare.mount(() =>
      React.createElement(ConnectionStatusPill, { phase: 'connecting', layout: 'stage' }),
    );
    vBare.unmount();

    // 卸载清理再次确保归还 false
    view.unmount();
    assert.equal(mountedLog[mountedLog.length - 1], false);
  } finally {
    globalThis.window = prevWin;
    globalThis.document = prevDoc;
    globalThis.setTimeout = prevSetTimeout;
    globalThis.clearTimeout = prevClearTimeout;
    globalThis.setInterval = prevSetInterval;
    globalThis.clearInterval = prevClearInterval;
  }
});

test('mountConnectionStatusPill: 断连宿主守卫与注入 root 挂载/更新/卸载', () => {
  assert.throws(
    () => mountConnectionStatusPill(null, () => ({ phase: 'connecting', layout: 'stage' })),
    /connected/,
  );
  assert.throws(
    () => mountConnectionStatusPill({ isConnected: false }, () => ({ phase: 'connecting', layout: 'stage' })),
    /connected/,
  );

  const renders = [];
  let unmounted = false;
  let currentPhase = 'reconnecting';
  const handle = mountConnectionStatusPill(
    { isConnected: true },
    () => ({ phase: currentPhase, attempt: 2, layout: 'stage' }),
    () => ({
      render: (el) => renders.push(el.props.phase),
      unmount: () => {
        unmounted = true;
      },
    }),
  );
  currentPhase = 'synced';
  handle.update();
  handle.unmount();
  assert.deepEqual(renders, ['reconnecting', 'synced']);
  assert.equal(unmounted, true);
});

test('Mobile screens: 传入 connectionPhase 顶替舞台并隐藏瞬态卡片，省略时保留兼容卡片', () => {
  const noop = () => {};
  const homeModel = buildMobileHomeModel({
    activeSessionId: '',
    profiles: [{ name: 'bot-a', displayName: 'Bot A', lastActive: 100 }],
    groups: [],
    sessions: [],
    profileName: 'bot-a',
    searchQuery: '',
    collapsed: { bots: false, groups: false, sessions: false },
  });

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
    bots: [{ profile: 'bot-a', displayName: 'Bot A' }],
    scopedProfile: 'bot-a',
    profiles: { status: 'ready', data: [{ name: 'bot-a', displayName: 'Bot A' }] },
    botManagement: {
      status: { status: 'ready', activeBotId: 'bot-a' },
      activeBotId: 'bot-a',
      roster: [{ id: 'bot-a', displayName: 'Bot A', model: '', isDefault: true, hasDraft: false }],
      activeDetail: null,
      availableModels: [],
      isBusy: false,
      wizard: {
        open: false,
        busy: false,
        draft: {
          mode: 'blank',
          name: '',
          displayName: '',
          description: '',
          model: '',
          provider: '',
          cloneFrom: '',
          cloneChannels: true,
          mirrorCredentials: true,
        },
      },
      exitPrompt: null,
    },
    providerAdminBusy: false,
    mcp: { status: 'ready', data: [] },
    skills: { status: 'ready', data: [] },
    gateway: {
      url: 'http://127.0.0.1:9119',
      username: 'admin',
      hasStoredPassword: false,
      profileName: 'bot-a',
      latencyMs: 0,
      status: 'disconnected',
      test: null,
    },
    appVersion: '0.1.0',
    platform: 'ios',
    busy: false,
  };

  // 1. MobileHomeScreen: 仅有 connectionPhase 未定义或 unconfigured 时展示 offline-banner，连接恢复态/离线态由状态胶囊接管
  const homeReconnect = renderToStaticMarkup(
    React.createElement(MobileHomeScreen, {
      homeTab: 'chats',
      model: homeModel,
      allProfiles: [],
      groupAvatars: [],
      activeBotName: 'bot-a',
      gatewayConnected: false,
      gatewayConnecting: true,
      connectionPhase: 'reconnecting',
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
      onOpenActionSheet: noop,
      settingsActions: {},
    }),
  );
  assert.doesNotMatch(homeReconnect, /m-home__offline-banner/);

  const homeOffline = renderToStaticMarkup(
    React.createElement(MobileHomeScreen, {
      homeTab: 'chats',
      model: homeModel,
      allProfiles: [],
      groupAvatars: [],
      activeBotName: 'bot-a',
      gatewayConnected: false,
      gatewayConnecting: false,
      connectionPhase: 'offline',
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
      onOpenActionSheet: noop,
      settingsActions: {},
    }),
  );
  assert.doesNotMatch(homeOffline, /m-home__offline-banner/, 'offline 时顶部悬浮胶囊已接管离线提示与操作');

  const homeUnconfigured = renderToStaticMarkup(
    React.createElement(MobileHomeScreen, {
      homeTab: 'bots',
      model: homeModel,
      allProfiles: [],
      groupAvatars: [],
      activeBotName: 'bot-a',
      gatewayConnected: false,
      gatewayConnecting: false,
      connectionPhase: 'unconfigured',
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
      onOpenActionSheet: noop,
      settingsActions: {},
    }),
  );
  assert.match(homeUnconfigured, /m-home__offline-banner/, '未配置态在 Bot Hub 展示引导条');

  const botHubReconnecting = renderToStaticMarkup(
    React.createElement(MobileHomeScreen, {
      homeTab: 'bots',
      model: homeModel,
      allProfiles: [],
      groupAvatars: [],
      activeBotName: 'bot-a',
      gatewayConnected: false,
      gatewayConnecting: true,
      connectionPhase: 'reconnecting',
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
      onOpenActionSheet: noop,
      settingsActions: {},
    }),
  );
  assert.doesNotMatch(botHubReconnecting, /m-home__offline-banner/, 'Bot Hub 重连期隐藏离线 Banner 防重叠');

  // 2. MobileConversationScreen: 重连期与离线态均由 Stage 胶囊承接并隐藏重复 offline-card
  const stageReconnect = renderToStaticMarkup(
    React.createElement(MobileConversationScreen, {
      gatewayConnected: false,
      connectionPhase: 'reconnecting',
      connectionReconnectAttempt: 2,
      activeFocus: { type: 'session', sessionId: 's1' },
      activeBotDisplayName: 'Bot A',
      isStreaming: false,
      messagesCount: 2,
      selectedModel: 'm1',
      availableModels: ['m1'],
      modelDetails: [],
      attachments: [],
      dockNotice: '',
      sideAgentCapsules: [],
      onSendMessage: noop,
      onInterruptTurn: noop,
      onSelectModel: noop,
      onRefreshModels: noop,
      onOpenAttachmentPicker: noop,
      onRemoveAttachment: noop,
      onOpenSettings: noop,
      onRetryConnect: noop,
    }),
  );
  assert.doesNotMatch(stageReconnect, /m-stage__offline-card/);
  assert.match(stageReconnect, /conn-pill--stage/);
  assert.match(stageReconnect, /正在重连 · 第 2 次/);

  // 3. MobileWorkspaceShell: 非舞台页渲染 m-conn-floating-host；停留在网关设置页时隐藏避免遮挡表单
  const shellFloating = renderToStaticMarkup(
    React.createElement(MobileWorkspaceShell, {
      snapshot: {
        platform: 'ios',
        theme: 'obsidian-gold',
        appearancePref: 'system',
        locale: 'zh',
        gatewayConnected: false,
        gatewayConnecting: true,
        connectionPhase: 'reconnecting',
        connectionReconnectAttempt: 1,
        connectionAuthError: false,
        homeModel,
        allProfiles: [],
        groupAvatars: [],
        activePane: 'home',
        homeTab: 'chats',
        searchOpen: false,
        searchQuery: '',
        sectionsCollapsed: { bots: false, groups: false, sessions: false },
        activeFocus: { type: 'bot', botName: 'bot-a' },
        activeBotName: 'bot-a',
        activeBotDisplayName: 'Bot A',
        isStreaming: false,
        messagesCount: 0,
        selectedModel: '',
        availableModels: [],
        modelDetails: [],
        attachments: [],
        dockNotice: '',
        sideAgentCapsules: [],
        newChatOpen: false,
        newChatStep: 'pick',
        subagentSheetOpen: false,
        inspectorTab: 'files',
        fileTreeState: { status: 'idle' },
        fileTreeExpandedPaths: [],
        fileTreeFilterQuery: '',
        learningState: { status: 'idle' },
        learningDetail: { status: 'idle' },
        settingsOpen: false,
        settingsSubpage: null,
        botSubpage: null,
        settingsSnapshot: validSettingsSnapshot,
        actionSheet: null,
      },
      actions: {
        onSelectPane: noop,
        onSelectHomeTab: noop,
        onSelectBotSubpage: noop,
        onOpenSearch: noop,
        onCloseSearch: noop,
        onSearchChange: noop,
        onToggleSection: noop,
        onOpenNewChat: noop,
        onCloseNewChat: noop,
        onNewChatSelectStep: noop,
        onSubmitNewChat: noop,
        onSelectBot: noop,
        onSelectGroup: noop,
        onSelectSession: noop,
        onOpenActionSheet: noop,
        onCloseActionSheet: noop,
        onActionRename: noop,
        onActionTogglePin: noop,
        onActionToggleArchive: noop,
        onActionDelete: noop,
        onOpenInspectorTab: noop,
        onRefreshFileTree: noop,
        onToggleFileTreeDir: noop,
        onSetFileTreeFilter: noop,
        onOpenWorkspaceFile: noop,
        onEnsureLearning: noop,
        onRefreshLearning: noop,
        onLoadLearningDetail: noop,
        onEditLearningNode: async () => ({ ok: true }),
        onDeleteLearningNode: async () => ({ ok: true }),
        onCloseSubagentSheet: noop,
        onCopyInspectorText: noop,
        onSendMessage: noop,
        onInterruptTurn: noop,
        onSelectModel: noop,
        onRefreshModels: noop,
        onOpenAttachmentPicker: noop,
        onRemoveAttachment: noop,
        onOpenSettings: noop,
        onCloseSettings: noop,
        onSelectSettingsSubpage: noop,
        onSetAppearancePreference: noop,
        onRetryConnect: noop,
        settingsActions: {},
      },
    }),
  );
  assert.match(shellFloating, /m-conn-floating-host/);
  assert.match(shellFloating, /conn-pill--floating/);

  const shellSettingsGateway = renderToStaticMarkup(
    React.createElement(MobileWorkspaceShell, {
      snapshot: {
        platform: 'ios',
        theme: 'obsidian-gold',
        appearancePref: 'system',
        locale: 'zh',
        gatewayConnected: false,
        gatewayConnecting: true,
        connectionPhase: 'reconnecting',
        connectionReconnectAttempt: 1,
        connectionAuthError: false,
        homeModel,
        allProfiles: [],
        groupAvatars: [],
        activePane: 'home',
        homeTab: 'chats',
        searchOpen: false,
        searchQuery: '',
        sectionsCollapsed: { bots: false, groups: false, sessions: false },
        activeFocus: { type: 'bot', botName: 'bot-a' },
        activeBotName: 'bot-a',
        activeBotDisplayName: 'Bot A',
        isStreaming: false,
        messagesCount: 0,
        selectedModel: '',
        availableModels: [],
        modelDetails: [],
        attachments: [],
        dockNotice: '',
        sideAgentCapsules: [],
        newChatOpen: false,
        newChatStep: 'pick',
        subagentSheetOpen: false,
        inspectorTab: 'files',
        fileTreeState: { status: 'idle' },
        fileTreeExpandedPaths: [],
        fileTreeFilterQuery: '',
        learningState: { status: 'idle' },
        learningDetail: { status: 'idle' },
        settingsOpen: true,
        settingsSubpage: 'gateway',
        botSubpage: null,
        settingsSnapshot: validSettingsSnapshot,
        actionSheet: null,
      },
      actions: {
        onSelectPane: noop,
        onSelectHomeTab: noop,
        onSelectBotSubpage: noop,
        onOpenSearch: noop,
        onCloseSearch: noop,
        onSearchChange: noop,
        onToggleSection: noop,
        onOpenNewChat: noop,
        onCloseNewChat: noop,
        onNewChatSelectStep: noop,
        onSubmitNewChat: noop,
        onSelectBot: noop,
        onSelectGroup: noop,
        onSelectSession: noop,
        onOpenActionSheet: noop,
        onCloseActionSheet: noop,
        onActionRename: noop,
        onActionTogglePin: noop,
        onActionToggleArchive: noop,
        onActionDelete: noop,
        onOpenInspectorTab: noop,
        onRefreshFileTree: noop,
        onToggleFileTreeDir: noop,
        onSetFileTreeFilter: noop,
        onOpenWorkspaceFile: noop,
        onEnsureLearning: noop,
        onRefreshLearning: noop,
        onLoadLearningDetail: noop,
        onEditLearningNode: async () => ({ ok: true }),
        onDeleteLearningNode: async () => ({ ok: true }),
        onCloseSubagentSheet: noop,
        onCopyInspectorText: noop,
        onSendMessage: noop,
        onInterruptTurn: noop,
        onSelectModel: noop,
        onRefreshModels: noop,
        onOpenAttachmentPicker: noop,
        onRemoveAttachment: noop,
        onOpenSettings: noop,
        onCloseSettings: noop,
        onSelectSettingsSubpage: noop,
        onSetAppearancePreference: noop,
        onRetryConnect: noop,
        settingsActions: {},
      },
    }),
  );
  assert.doesNotMatch(shellSettingsGateway, /m-conn-floating-host/);

  const shellSettingsAppearance = renderToStaticMarkup(
    React.createElement(MobileWorkspaceShell, {
      snapshot: {
        platform: 'ios',
        theme: 'obsidian-gold',
        appearancePref: 'system',
        locale: 'zh',
        gatewayConnected: false,
        gatewayConnecting: true,
        connectionPhase: 'reconnecting',
        connectionReconnectAttempt: 1,
        connectionAuthError: false,
        homeModel,
        allProfiles: [],
        groupAvatars: [],
        activePane: 'home',
        homeTab: 'chats',
        searchOpen: false,
        searchQuery: '',
        sectionsCollapsed: { bots: false, groups: false, sessions: false },
        activeFocus: { type: 'bot', botName: 'bot-a' },
        activeBotName: 'bot-a',
        activeBotDisplayName: 'Bot A',
        isStreaming: false,
        messagesCount: 0,
        selectedModel: '',
        availableModels: [],
        modelDetails: [],
        attachments: [],
        dockNotice: '',
        sideAgentCapsules: [],
        newChatOpen: false,
        newChatStep: 'pick',
        subagentSheetOpen: false,
        inspectorTab: 'files',
        fileTreeState: { status: 'idle' },
        fileTreeExpandedPaths: [],
        fileTreeFilterQuery: '',
        learningState: { status: 'idle' },
        learningDetail: { status: 'idle' },
        settingsOpen: true,
        settingsSubpage: 'appearance',
        botSubpage: null,
        settingsSnapshot: validSettingsSnapshot,
        actionSheet: null,
      },
      actions: {
        onSelectPane: noop,
        onSelectHomeTab: noop,
        onSelectBotSubpage: noop,
        onOpenSearch: noop,
        onCloseSearch: noop,
        onSearchChange: noop,
        onToggleSection: noop,
        onOpenNewChat: noop,
        onCloseNewChat: noop,
        onNewChatSelectStep: noop,
        onSubmitNewChat: noop,
        onSelectBot: noop,
        onSelectGroup: noop,
        onSelectSession: noop,
        onOpenActionSheet: noop,
        onCloseActionSheet: noop,
        onActionRename: noop,
        onActionTogglePin: noop,
        onActionToggleArchive: noop,
        onActionDelete: noop,
        onOpenInspectorTab: noop,
        onRefreshFileTree: noop,
        onToggleFileTreeDir: noop,
        onSetFileTreeFilter: noop,
        onOpenWorkspaceFile: noop,
        onEnsureLearning: noop,
        onRefreshLearning: noop,
        onLoadLearningDetail: noop,
        onEditLearningNode: async () => ({ ok: true }),
        onDeleteLearningNode: async () => ({ ok: true }),
        onCloseSubagentSheet: noop,
        onCopyInspectorText: noop,
        onSendMessage: noop,
        onInterruptTurn: noop,
        onSelectModel: noop,
        onRefreshModels: noop,
        onOpenAttachmentPicker: noop,
        onRemoveAttachment: noop,
        onOpenSettings: noop,
        onCloseSettings: noop,
        onSelectSettingsSubpage: noop,
        onSetAppearancePreference: noop,
        onRetryConnect: noop,
        settingsActions: {},
      },
    }),
  );
  assert.match(shellSettingsAppearance, /m-conn-floating-host/);

  // 舞台页下开启设置(非网关)或 Bot 子页也展示悬浮条，纯舞台(无抽屉遮罩)则交给顶置 Stage 胶囊
  const renderShellVariant = (patch) =>
    renderToStaticMarkup(
      React.createElement(MobileWorkspaceShell, {
        snapshot: {
          platform: 'ios',
          theme: 'obsidian-gold',
          appearancePref: 'system',
          locale: 'zh',
          gatewayConnected: false,
          gatewayConnecting: true,
          connectionPhase: 'reconnecting',
          connectionReconnectAttempt: 1,
          connectionAuthError: false,
          homeModel,
          allProfiles: [],
          groupAvatars: [],
          activePane: 'stage',
          homeTab: 'chats',
          searchOpen: false,
          searchQuery: '',
          sectionsCollapsed: { bots: false, groups: false, sessions: false },
          activeFocus: { type: 'bot', botName: 'bot-a' },
          activeBotName: 'bot-a',
          activeBotDisplayName: 'Bot A',
          isStreaming: false,
          messagesCount: 0,
          selectedModel: '',
          availableModels: [],
          modelDetails: [],
          attachments: [],
          dockNotice: '',
          sideAgentCapsules: [],
          newChatOpen: false,
          newChatStep: 'pick',
          subagentSheetOpen: false,
          inspectorTab: 'files',
          fileTreeState: { status: 'idle' },
          fileTreeExpandedPaths: [],
          fileTreeFilterQuery: '',
          learningState: { status: 'idle' },
          learningDetail: { status: 'idle' },
          settingsOpen: false,
          settingsSubpage: null,
          botSubpage: null,
          settingsSnapshot: validSettingsSnapshot,
          actionSheet: null,
          ...patch,
        },
        actions: {
          onSelectPane: noop,
          onSelectHomeTab: noop,
          onSelectBotSubpage: noop,
          onOpenSearch: noop,
          onCloseSearch: noop,
          onSearchChange: noop,
          onToggleSection: noop,
          onOpenNewChat: noop,
          onCloseNewChat: noop,
          onNewChatSelectStep: noop,
          onSubmitNewChat: noop,
          onSelectBot: noop,
          onSelectGroup: noop,
          onSelectSession: noop,
          onOpenActionSheet: noop,
          onCloseActionSheet: noop,
          onActionRename: noop,
          onActionTogglePin: noop,
          onActionToggleArchive: noop,
          onActionDelete: noop,
          onOpenInspectorTab: noop,
          onRefreshFileTree: noop,
          onToggleFileTreeDir: noop,
          onSetFileTreeFilter: noop,
          onOpenWorkspaceFile: noop,
          onEnsureLearning: noop,
          onRefreshLearning: noop,
          onLoadLearningDetail: noop,
          onEditLearningNode: async () => ({ ok: true }),
          onDeleteLearningNode: async () => ({ ok: true }),
          onCloseSubagentSheet: noop,
          onCopyInspectorText: noop,
          onSendMessage: noop,
          onInterruptTurn: noop,
          onSelectModel: noop,
          onRefreshModels: noop,
          onOpenAttachmentPicker: noop,
          onRemoveAttachment: noop,
          onOpenSettings: noop,
          onCloseSettings: noop,
          onSelectSettingsSubpage: noop,
          onSetAppearancePreference: noop,
          onRetryConnect: noop,
          settingsActions: {},
        },
      }),
    );
  assert.doesNotMatch(renderShellVariant({ activePane: 'stage', settingsOpen: false, botSubpage: null }), /m-conn-floating-host/);
  assert.match(renderShellVariant({ activePane: 'stage', settingsOpen: true, settingsSubpage: 'appearance' }), /m-conn-floating-host/);
  assert.match(renderShellVariant({ activePane: 'stage', settingsOpen: false, botSubpage: 'identity' }), /m-conn-floating-host/);

  // 4. Titlebar connectionStatus 与悬停文案映射
  const tbReconnecting = renderToStaticMarkup(
    React.createElement(Titlebar, {
      platform: 'macos',
      isMaximized: false,
      gatewayConnected: false,
      connectionStatus: 'reconnecting',
      leftRailCollapsed: false,
      inspectorCollapsed: true,
      onMinimize: noop,
      onMaximize: noop,
      onClose: noop,
      onToggleLeftRail: noop,
      onToggleInspector: noop,
      onOpenSettings: noop,
    }),
  );
  assert.match(tbReconnecting, /data-status="reconnecting"/);
  assert.match(tbReconnecting, new RegExp(t('conn.reconnecting')));

  const tbSyncing = renderToStaticMarkup(
    React.createElement(Titlebar, {
      platform: 'windows',
      isMaximized: false,
      gatewayConnected: true,
      connectionStatus: 'syncing',
      leftRailCollapsed: false,
      inspectorCollapsed: true,
      onMinimize: noop,
      onMaximize: noop,
      onClose: noop,
      onToggleLeftRail: noop,
      onToggleInspector: noop,
      onOpenSettings: noop,
    }),
  );
  assert.match(tbSyncing, /data-status="syncing"/);
  assert.match(tbSyncing, new RegExp(t('conn.syncing')));
});
