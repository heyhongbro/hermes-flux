/**
 * M1.3 Multi-Gateway Pure-Flat UI Component & ViewModel Tests (TDD)
 * (packages/ui/__tests__/m1-3-multi-gateway-ui.test.mjs)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { setLocale } from '../dist/i18n/index.js';
import { LeftRail } from '../dist/components-react/LeftRail.js';
import { GroupedLeftRail } from '../dist/components-react/GroupedLeftRail.js';
import {
  renderGroupCollageAvatar,
  renderLeftRailHtml,
  RailEntityRow,
  Titlebar,
  GatewayHealthPopover,
  buildLeftRailModel,
  buildGroupedLeftRailModel,
  buildMobileHomeModel,
  isAgentScopeActive,
  isGroupFocused,
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
    if (elType === React.Fragment) {
      return resolve(node.props?.children, `${key}<>`);
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
          return ctx._currentValue;
        },
      };

      let rendered;
      try {
        rendered = compFn(node.props);
      } finally {
        internals.H = prevH;
      }
      return resolve(rendered, `${scopedKey}>`);
    }

    const nextProps = { ...node.props };
    if (node.props && 'children' in node.props) {
      nextProps.children = resolve(node.props.children, key);
    }
    return { ...node, props: nextProps };
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
  if (tree.props && 'children' in tree.props) {
    findElements(tree.props.children, predicate, out);
  }
  return out;
}

const MULTI_PROFILES = [
  {
    name: 'default',
    displayName: 'Default A',
    isDefault: true,
    avatar: 'data:image/png;base64,a-default',
    gatewayId: 'gw-a',
    gatewayLabel: 'Office',
    gatewayRouteLabel: 'Direct',
    gatewayOffline: false,
    timestamp: 3000,
    activityState: 'running',
  },
  {
    name: 'coder',
    displayName: 'Coder A',
    avatar: 'data:image/png;base64,a-coder',
    gatewayId: 'gw-a',
    gatewayLabel: 'Office',
    gatewayOffline: false,
    timestamp: 2000,
    activityState: 'read',
  },
  {
    name: 'default',
    displayName: 'Default B',
    isDefault: true,
    avatar: 'data:image/png;base64,b-default',
    gatewayId: 'gw-b',
    gatewayLabel: 'Home',
    gatewayRouteLabel: 'LAN',
    gatewayOffline: true,
    timestamp: 1000,
    activityState: 'unread',
  },
];

const MULTI_SESSIONS = [
  {
    id: 'sess-1',
    title: 'Shared ID on A',
    preview: 'running on A',
    botName: 'default',
    gatewayId: 'gw-a',
    gatewayLabel: 'Office',
    gatewayOffline: false,
    timestamp: 5000,
    activityState: 'running',
  },
  {
    id: 'sess-1',
    title: 'Shared ID on B',
    preview: 'cached on B',
    botName: 'default',
    gatewayId: 'gw-b',
    gatewayLabel: 'Home',
    gatewayOffline: true,
    timestamp: 4000,
    activityState: 'read',
  },
];

const MULTI_GROUPS = [
  {
    roomId: 'room-x',
    name: 'Cross Room',
    members: ['default', 'coder'],
    gatewayId: 'gw-a',
    gatewayLabel: 'Office',
    gatewayOffline: false,
    crossGateway: true,
    updatedAt: 6000,
  },
];

test('M1.3 UI botAvatar: 群聊拼图头像按 gatewayId:name 隔离解析，杜绝跨机同名 default 头像串台', () => {
  const htmlA = renderGroupCollageAvatar(['default', 'coder'], MULTI_PROFILES, 36, 'gw-a');
  assert.ok(htmlA.includes('a-default'), 'gw-a 群聊应取 gw-a 的 default 头像');
  assert.equal(htmlA.includes('b-default'), false);

  const htmlB = renderGroupCollageAvatar(['default', 'ghost-member'], MULTI_PROFILES, 36, 'gw-b');
  assert.ok(htmlB.includes('b-default'), 'gw-b 群聊应取 gw-b 的 default 头像');
  assert.equal(htmlB.includes('a-default'), false);

  const scopedDirect = renderGroupCollageAvatar(['gw-b:default', 'gw-a:coder'], MULTI_PROFILES, 36);
  assert.ok(scopedDirect.includes('b-default'));
  assert.ok(scopedDirect.includes('a-coder'));
});

test('M1.3 UI RailEntityRow: 非紧凑行来源微标固定在 Row 2 左侧，离线态只弱化透明度+图标禁拼 "(离线)"，compact 回落 Row 1', () => {
  const baselineHtml = renderToStaticMarkup(
    React.createElement(RailEntityRow, {
      active: false,
      title: 'Session Baseline',
      subtitle: 'hello world',
    }),
  );
  assert.equal(baselineHtml.includes('data-gateway-badge='), false);
  assert.equal(baselineHtml.includes('opacity-60'), false);

  const row2BadgeHtml = renderToStaticMarkup(
    React.createElement(RailEntityRow, {
      active: false,
      title: 'Remote Session',
      subtitle: 'last snippet',
      gatewayBadge: { label: 'Home', offline: true },
    }),
  );
  assert.ok(row2BadgeHtml.includes('opacity-60'));
  assert.ok(row2BadgeHtml.includes('data-gateway-offline="true"'));
  assert.ok(row2BadgeHtml.includes('data-gateway-badge="Home"'));
  assert.equal(row2BadgeHtml.includes('(离线)'), false, '离线严禁拼接中文 "(离线)" 文字');
  const titleIdx = row2BadgeHtml.indexOf('Remote Session');
  const badgeIdx = row2BadgeHtml.indexOf('data-gateway-badge="Home"');
  const subtitleIdx = row2BadgeHtml.indexOf('last snippet');
  assert.ok(titleIdx < badgeIdx && badgeIdx < subtitleIdx, 'badge 必须位于 Row 1 标题之后、Row 2 subtitle 之前');

  const compactHtml = renderToStaticMarkup(
    React.createElement(RailEntityRow, {
      active: false,
      compact: true,
      title: 'Compact Done Session',
      subtitle: 'ignored',
      gatewayBadge: { label: 'Office' },
    }),
  );
  assert.ok(compactHtml.includes('data-gateway-badge="Office"'), 'compact 行无 Row 2 时回落 Row 1 展示短标');
});

test('M1.3 UI LeftRail & GroupedLeftRail: 单网关零变化，>=2 网关启用纯扁平混排、取消微轨置顶锁、显示宿主首字符徽标与 Tooltip', () => {
  setLocale('zh-CN');

  // Single gateway baseline: fixed top defaultAgent stays outside .station-agents-scroll, zero badges
  const singleHtml = renderLeftRailHtml({
    activeSessionId: 'sess-1',
    activeFocus: { type: 'bot', botName: 'default', gatewayId: 'gw-a' },
    sessions: MULTI_SESSIONS.slice(0, 1),
    profileName: 'default',
    profiles: MULTI_PROFILES.slice(0, 2),
    groups: MULTI_GROUPS,
    searchQuery: '',
    collapsed: false,
    gatewayCount: 1,
  });
  const stationScrollStartSingle = singleHtml.indexOf('station-agents-scroll');
  const defaultOutsideIdx = singleHtml.indexOf('data-station-profile="default"');
  assert.ok(defaultOutsideIdx > 0 && defaultOutsideIdx < stationScrollStartSingle, '单网关必须保留 default 置顶在滚动区之外');
  assert.equal(singleHtml.includes('data-station-host-badge='), false);
  assert.equal(singleHtml.includes('data-gateway-badge='), false);

  // Multi gateway dual-rail: allAgents inside scroll container, host monogram at bottom-0 right-0, Tooltip, Row 2 badge
  const multiHtml = renderLeftRailHtml({
    activeSessionId: 'sess-1',
    activeFocus: { type: 'bot', botName: 'default', gatewayId: 'gw-b' },
    sessions: MULTI_SESSIONS,
    profileName: 'default',
    profiles: MULTI_PROFILES,
    groups: MULTI_GROUPS,
    searchQuery: '',
    collapsed: false,
    gatewayCount: 2,
  });
  const scrollIdx = multiHtml.indexOf('station-agents-scroll');
  assert.ok(multiHtml.indexOf('data-station-profile="default"') > scrollIdx, '多网关取消默认置顶，所有站点卡同入滚动区');
  assert.ok(multiHtml.includes('data-station-host-badge="O"'));
  assert.ok(multiHtml.includes('data-station-host-badge="H"'));
  assert.ok(multiHtml.includes('data-tooltip="Default B · Home (LAN)"'));
  assert.ok(multiHtml.includes('data-tooltip="Coder A · Office"'), '缺少 gatewayRouteLabel 时回退仅显示节点短标');
  assert.equal(multiHtml.includes('data-gateway-badge="Home"'), true);

  // Dual-rail focus switched to gw-a shows Office badge in drawer and marks gw-a station active
  const multiGwAHtml = renderLeftRailHtml({
    activeSessionId: 'sess-1',
    activeFocus: { type: 'bot', botName: 'default', gatewayId: 'gw-a' },
    sessions: MULTI_SESSIONS,
    profileName: 'default',
    profiles: MULTI_PROFILES,
    groups: MULTI_GROUPS,
    searchQuery: '',
    collapsed: false,
    gatewayCount: 2,
  });
  assert.equal(multiGwAHtml.includes('data-gateway-badge="Office"'), true);

  // Grouped flat mode (unfiltered) displays both Office and Home badges side-by-side without gateway tabs
  const groupedFlatHtml = renderLeftRailHtml({
    layout: 'grouped',
    activeSessionId: 'sess-1',
    activeFocus: { type: 'session', sessionId: 'sess-1', gatewayId: 'gw-a' },
    sessions: MULTI_SESSIONS,
    profileName: 'default',
    profiles: MULTI_PROFILES,
    groups: MULTI_GROUPS,
    searchQuery: '',
    collapsed: false,
    gatewayCount: 2,
  });
  assert.equal(groupedFlatHtml.includes('data-gateway-badge="Office"'), true);
  assert.equal(groupedFlatHtml.includes('data-gateway-badge="Home"'), true);

  // Scoped active state: gw-b:default focused -> gw-b station active, gw-a station NOT active
  const gwADefaultPos = multiHtml.indexOf('data-gateway-id="gw-a"');
  const gwBDefaultPos = multiHtml.indexOf('data-gateway-id="gw-b"');
  const gwAClassChunk = multiHtml.slice(Math.max(0, gwADefaultPos - 260), gwADefaultPos);
  const gwBClassChunk = multiHtml.slice(Math.max(0, gwBDefaultPos - 260), gwBDefaultPos);
  assert.equal(/\bactive\b/.test(gwAClassChunk), false);
  assert.equal(/\bactive\b/.test(gwBClassChunk), true);

  // Search by gateway short label filters across entities cleanly without a filter bar
  const searchByHostHtml = renderLeftRailHtml({
    layout: 'grouped',
    activeSessionId: 'sess-1',
    activeFocus: { type: 'session', sessionId: 'sess-1', gatewayId: 'gw-b' },
    sessions: MULTI_SESSIONS,
    profileName: 'default',
    profiles: MULTI_PROFILES,
    groups: MULTI_GROUPS,
    searchQuery: 'Home',
    collapsed: false,
    gatewayCount: 2,
  });
  assert.ok(searchByHostHtml.includes('Shared ID on B'));
  assert.equal(searchByHostHtml.includes('Shared ID on A'), false);
  assert.ok(searchByHostHtml.includes('Default B'));

  // MobileHomeModel also carries gatewayCount -> isMultiGateway and scoped owner lookup
  const mobileHome = buildMobileHomeModel({
    activeSessionId: 'sess-1',
    activeFocus: { type: 'session', sessionId: 'sess-1', gatewayId: 'gw-b' },
    profiles: MULTI_PROFILES,
    groups: MULTI_GROUPS,
    sessions: MULTI_SESSIONS,
    profileName: 'default',
    searchQuery: '',
    collapsed: { bots: false, groups: false, sessions: false },
    gatewayCount: 2,
  });
  assert.equal(mobileHome.isMultiGateway, true);
  const bSessVm = mobileHome.sessionsSection.items.find((s) => s.gatewayId === 'gw-b');
  assert.equal(bSessVm?.ownerAvatarUrl, 'data:image/png;base64,b-default');
  assert.equal(bSessVm?.isActive, true);

  // Badge without subtitle on Row 2 + RailEntityRow + isAgentScopeActive session mismatch branch
  const badgeNoSubtitle = renderToStaticMarkup(
    React.createElement(RailEntityRow, {
      active: false,
      title: 'Empty Sub',
      gatewayBadge: { label: 'Relay', crossGateway: true },
    }),
  );
  assert.ok(badgeNoSubtitle.includes('data-gateway-badge="Relay"'));

  assert.equal(
    isAgentScopeActive({
      agentName: 'default',
      agentGatewayId: 'gw-a',
      focus: { type: 'session', sessionId: 'sess-1', gatewayId: 'gw-b' },
      selectedAgentName: 'default',
      selectedAgentGatewayId: 'gw-b',
      activeSessionBotName: 'default',
      activeSessionGatewayId: 'gw-b',
    }),
    false,
  );
  assert.equal(
    isAgentScopeActive({
      agentName: 'default',
      agentGatewayId: 'gw-a',
      focus: { type: 'bot', botName: 'default', gatewayId: 'gw-a' },
      selectedAgentName: 'default',
      selectedAgentGatewayId: 'gw-a',
    }),
    true,
  );
});

test('M1.3 UI DualRailLeftRail & GroupedLeftRail: 点击与右键菜单回调透传 gatewayId', () => {
  const driver = createReactHookDriver();
  const captured = [];
  const baseHandlers = {
    collapsed: false,
    searchQuery: '',
    onSelectSession: (id, bot, gw) => captured.push(['sel-session', id, bot, gw]),
    onSelectBot: (name, gw) => captured.push(['sel-bot', name, gw]),
    onSelectGroup: (roomId, gw) => captured.push(['sel-group', roomId, gw]),
    onOpenSessionMenu: (id, title, x, y, profile, gw) => captured.push(['menu-session', id, profile, gw]),
    onOpenBotMenu: (name, x, y, gw) => captured.push(['menu-bot', name, gw]),
    onOpenGroupMenu: (roomId, name, x, y, gw) => captured.push(['menu-group', roomId, gw]),
    onSearchChange: () => {},
    onNewChat: () => {},
    onToggleSessions: () => {},
    onToggleGroups: () => {},
    onStartGroupRename: () => {},
    onConfirmGroupRename: () => {},
    onCancelGroupRename: () => {},
    onResizeStart: () => {},
  };

  try {
    const dualModel = buildLeftRailModel({
      activeSessionId: 'sess-1',
      activeFocus: { type: 'session', sessionId: 'sess-1', gatewayId: 'gw-a' },
      profiles: MULTI_PROFILES,
      groups: MULTI_GROUPS,
      sessions: MULTI_SESSIONS,
      profileName: 'default',
      searchQuery: '',
      gatewayCount: 2,
    });
    const dualTree = driver.render(
      React.createElement(LeftRail, {
        ...baseHandlers,
        model: dualModel,
        layout: 'dual-rail',
      }),
    );
    const stationBtnA = findElements(
      dualTree,
      (el) => el.props?.['data-station-profile'] === 'default' && el.props?.['data-gateway-id'] === 'gw-a',
    )[0];
    assert.ok(stationBtnA);
    stationBtnA.props.onClick();
    stationBtnA.props.onContextMenu({ preventDefault() {}, stopPropagation() {}, clientX: 5, clientY: 6 });

    const groupedModel = buildGroupedLeftRailModel({
      activeSessionId: 'sess-1',
      activeFocus: { type: 'session', sessionId: 'sess-1', gatewayId: 'gw-b' },
      profiles: MULTI_PROFILES,
      groups: MULTI_GROUPS,
      sessions: MULTI_SESSIONS,
      profileName: 'default',
      searchQuery: '',
      gatewayCount: 2,
    });
    const groupedTree = driver.render(
      React.createElement(GroupedLeftRail, {
        ...baseHandlers,
        model: dualModel,
        groupedModel,
      }),
    );
    const botRowB = findElements(
      groupedTree,
      (el) => el.props?.['data-profile'] === 'default' && el.props?.['data-gateway-id'] === 'gw-b',
    )[0];
    assert.ok(botRowB);
    botRowB.props.onClick();
    botRowB.props.onContextMenu({ preventDefault() {}, stopPropagation() {}, clientX: 7, clientY: 8 });

    const sessRowB = findElements(
      groupedTree,
      (el) => el.props?.['data-id'] === 'sess-1' && el.props?.['data-gateway-id'] === 'gw-b',
    )[0];
    assert.ok(sessRowB);
    sessRowB.props.onClick();
    sessRowB.props.onContextMenu({ preventDefault() {}, stopPropagation() {}, clientX: 9, clientY: 10 });

    const groupRow = findElements(groupedTree, (el) => el.props?.['data-room-id'] === 'room-x')[0];
    assert.ok(groupRow);
    groupRow.props.onClick();
    groupRow.props.onContextMenu({ preventDefault() {}, stopPropagation() {}, clientX: 11, clientY: 12 });

    assert.deepEqual(captured, [
      ['sel-bot', 'default', 'gw-a'],
      ['menu-bot', 'default', 'gw-a'],
      ['sel-bot', 'default', 'gw-b'],
      ['menu-bot', 'default', 'gw-b'],
      ['sel-session', 'sess-1', 'default', 'gw-b'],
      ['menu-session', 'sess-1', 'default', 'gw-b'],
      ['sel-group', 'room-x', 'gw-a'],
      ['menu-group', 'room-x', 'gw-a'],
    ]);
  } finally {
    driver.cleanupAll();
  }
});

test('M1.3 UI Titlebar & GatewayHealthPopover: 28x28 纯点健康开关、无数字读数、点击展开 L4 浮层并触发重连/断开/管理', () => {
  setLocale('zh-CN');
  const driver = createReactHookDriver();
  const actions = [];
  const docHandlers = {};
  const prevDoc = globalThis.document;
  let focusRestored = 0;
  globalThis.document = {
    addEventListener(evt, fn) {
      docHandlers[evt] = fn;
    },
    removeEventListener(evt) {
      delete docHandlers[evt];
    },
    getElementById(id) {
      if (id === 'titlebar-gateway-health-btn') {
        return { focus() { focusRestored += 1; } };
      }
      return null;
    },
  };

  try {
    const props = {
      platform: 'windows',
      isMaximized: false,
      gatewayConnected: true,
      connectionStatus: 'partial',
      leftRailCollapsed: false,
      inspectorCollapsed: true,
      gateways: [
        {
          gatewayId: 'gw-a',
          name: 'Office Mac',
          shortLabel: 'Office',
          status: 'connected',
          connected: true,
          latencyMs: 14,
          routeKind: 'direct',
          reconnectAttempt: 0,
          authError: false,
        },
        {
          gatewayId: 'gw-b',
          name: 'Home Box',
          shortLabel: 'Home',
          status: 'offline',
          connected: false,
          routeKind: 'lan',
          reconnectAttempt: 2,
          authError: false,
        },
      ],
      onMinimize: () => actions.push('min'),
      onMaximize: () => actions.push('max'),
      onClose: () => actions.push('close'),
      onToggleLeftRail: () => actions.push('rail'),
      onToggleInspector: () => actions.push('insp'),
      onOpenSettings: () => actions.push('settings'),
      onReconnectGateway: (id) => actions.push(`reconnect:${id}`),
      onDisconnectGateway: (id) => actions.push(`disconnect:${id}`),
      onManageGateways: () => actions.push('manage'),
    };

    const closedHtml = renderToStaticMarkup(React.createElement(Titlebar, props));
    assert.ok(closedHtml.includes('id="titlebar-gateway-health-btn"'));
    assert.ok(closedHtml.includes('data-status="partial"'));
    assert.equal(closedHtml.includes('14ms'), false, '顶栏关闭浮层态绝不泄露延迟数字或文字');
    assert.equal(closedHtml.includes('1/2'), false, '顶栏绝不出现数量徽标');

    // Click health dot via hook driver to open L4 popover
    let tree = driver.render(React.createElement(Titlebar, props));
    const healthBtn = findElements(tree, (el) => el.props?.id === 'titlebar-gateway-health-btn')[0];
    assert.ok(healthBtn);
    healthBtn.props.onClick({ stopPropagation() {} });

    tree = driver.render(React.createElement(Titlebar, props));
    const popover = findElements(tree, (el) => el.props?.['data-testid'] === 'gateway-health-popover')[0];
    assert.ok(popover, '点击健康指示点应打开 GatewayHealthPopover');

    const reconBtn = findElements(tree, (el) => el.props?.['data-testid'] === 'gw-health-action-gw-b')[0];
    assert.ok(reconBtn);
    reconBtn.props.onClick();

    const discBtn = findElements(tree, (el) => el.props?.['data-testid'] === 'gw-health-action-gw-a')[0];
    assert.ok(discBtn);
    discBtn.props.onClick();

    const manageBtn = findElements(tree, (el) => el.props?.['data-testid'] === 'gw-health-manage-btn')[0];
    assert.ok(manageBtn);
    manageBtn.props.onClick();

    assert.deepEqual(actions, ['reconnect:gw-b', 'disconnect:gw-a', 'manage']);

    // Manage click closed popover -> reopen and test Escape close
    tree = driver.render(React.createElement(Titlebar, props));
    assert.equal(findElements(tree, (el) => el.props?.['data-testid'] === 'gateway-health-popover').length, 0);

    findElements(tree, (el) => el.props?.id === 'titlebar-gateway-health-btn')[0].props.onClick({ stopPropagation() {} });
    tree = driver.render(React.createElement(Titlebar, props));
    assert.equal(findElements(tree, (el) => el.props?.['data-testid'] === 'gateway-health-popover').length, 1);

    docHandlers.keydown?.({ key: 'Escape' });
    tree = driver.render(React.createElement(Titlebar, props));
    assert.equal(findElements(tree, (el) => el.props?.['data-testid'] === 'gateway-health-popover').length, 0);
    assert.equal(focusRestored, 1, 'Escape 关闭健康浮层后应把焦点交还给触发按钮');
  } finally {
    driver.cleanupAll();
    if (prevDoc === undefined) delete globalThis.document;
    else globalThis.document = prevDoc;
  }
});

test('M1.3 UI styles.css: 必须为 partial 状态提供 warning 指示灯色值', () => {
  const css = fs.readFileSync(
    path.resolve(import.meta.dirname, '../../desktop/src/renderer/styles.css'),
    'utf8',
  );
  assert.match(css, /\.titlebar-connection-indicator\[data-status="partial"\][^}]*var\(--warning\)/);
});

test('M1.3 UI Titlebar & GatewayHealthPopover Edge Branches: 空列表/鉴权报错/同步重连无延迟/外部点击关闭与无 document 环境', () => {
  setLocale('zh-CN');

  // Empty gateway list & omitted onManageGateways + SSR/non-DOM environment (no document)
  const prevDoc = globalThis.document;
  delete globalThis.document;
  try {
    const emptyPopoverHtml = renderToStaticMarkup(
      React.createElement(GatewayHealthPopover, {
        gateways: [],
        onClose: () => {},
      }),
    );
    assert.ok(emptyPopoverHtml.includes('data-testid="gateway-health-popover"'));

    // Syncing + authError + connected-no-latencyMs + name fallback (no shortLabel)
    const variantsHtml = renderToStaticMarkup(
      React.createElement(GatewayHealthPopover, {
        gateways: [
          {
            gatewayId: 'gw-sync',
            name: 'SyncNode',
            status: 'syncing',
            connected: true,
          },
          {
            gatewayId: 'gw-auth',
            name: 'AuthFailNode',
            status: 'offline',
            connected: false,
            authError: true,
            routeKind: 'relay',
          },
          {
            gatewayId: 'gw-reconn',
            name: 'ReconnNode',
            status: 'reconnecting',
            connected: false,
          },
        ],
        onClose: () => {},
      }),
    );
    assert.ok(variantsHtml.includes('SyncNode'));
    assert.ok(variantsHtml.includes('AuthFailNode'));
    assert.ok(variantsHtml.includes('ReconnNode'));

    for (const status of ['syncing', 'reconnecting', 'offline']) {
      const tbHtml = renderToStaticMarkup(
        React.createElement(Titlebar, {
          platform: 'macos',
          isMaximized: false,
          gatewayConnected: false,
          connectionStatus: status,
          leftRailCollapsed: false,
          inspectorCollapsed: true,
          onMinimize: () => {},
          onMaximize: () => {},
          onClose: () => {},
          onToggleLeftRail: () => {},
          onToggleInspector: () => {},
          onOpenSettings: () => {},
        }),
      );
      assert.ok(tbHtml.includes(`data-status="${status}"`));
    }
  } finally {
    if (prevDoc !== undefined) globalThis.document = prevDoc;
  }

  // Interactive document listeners: non-Escape key ignored, inside click ignored, outside click closes
  const driver = createReactHookDriver();
  const docHandlers = {};
  let closeCount = 0;
  try {
    // Run useEffect with document === undefined to cover early SSR return
    driver.render(
      React.createElement(GatewayHealthPopover, {
        gateways: [
          {
            gatewayId: 'gw-off-zero',
            name: 'Offline Zero',
            status: 'offline',
            connected: false,
            reconnectAttempt: 0,
            authError: false,
          },
          {
            gatewayId: 'gw-off-undef',
            name: 'Offline Undef',
            status: 'offline',
            connected: false,
          },
        ],
        onClose: () => {},
      }),
    );
  } finally {
    driver.cleanupAll();
  }
  const driverDoc = createReactHookDriver();
  let focusRestored = 0;
  globalThis.document = {
    addEventListener(evt, fn) {
      docHandlers[evt] = fn;
    },
    removeEventListener(evt) {
      delete docHandlers[evt];
    },
    getElementById(id) {
      if (id === 'titlebar-gateway-health-btn') {
        return { focus() { focusRestored += 1; } };
      }
      return null;
    },
  };
  try {
    driverDoc.render(
      React.createElement(GatewayHealthPopover, {
        gateways: [
          {
            gatewayId: 'gw-1',
            name: 'Node 1',
            status: 'reconnecting',
            connected: false,
            reconnectAttempt: 3,
          },
          {
            gatewayId: 'gw-2',
            name: 'Node 2',
            status: 'offline',
            connected: false,
            reconnectAttempt: 0,
          },
        ],
        onClose: () => {
          closeCount += 1;
        },
      }),
    );
    docHandlers.keydown?.({ key: 'Enter' });
    docHandlers.pointerdown?.({ target: { closest: () => ({}) } });
    assert.equal(closeCount, 0);
    docHandlers.pointerdown?.({ target: { closest: () => null } });
    assert.equal(closeCount, 1);
  } finally {
    driverDoc.cleanupAll();
    if (prevDoc === undefined) delete globalThis.document;
    else globalThis.document = prevDoc;
  }
});

test('M1.3 UI Coverage Matrix: DualRail 容器/已完成行回调、单网关无 gatewayId 分支、React.memo 比较与模型边界', () => {
  setLocale('zh-CN');
  const driver = createReactHookDriver();
  const captured = [];
  const handlers = {
    collapsed: false,
    searchQuery: '',
    onSelectSession: (id, bot, gw) => captured.push(['sel-session', id, bot, gw]),
    onSelectBot: (name, gw) => captured.push(['sel-bot', name, gw]),
    onSelectGroup: (roomId, gw) => captured.push(['sel-group', roomId, gw]),
    onOpenSessionMenu: (id, title, x, y, profile, gw) => captured.push(['menu-session', id, gw]),
    onOpenBotMenu: (name, x, y, gw) => captured.push(['menu-bot', name, gw]),
    onOpenGroupMenu: (roomId, name, x, y, gw) => captured.push(['menu-group', roomId, gw]),
    onSearchChange: () => {},
    onNewChat: () => {},
    onToggleSessions: () => {},
    onToggleGroups: () => {},
    onStartGroupRename: () => {},
    onConfirmGroupRename: () => {},
    onCancelGroupRename: () => {},
    onResizeStart: () => {},
  };

  try {
    const richProfiles = [
      ...MULTI_PROFILES,
      { name: 'no-label-bot', displayName: '', gatewayId: 'gw-a', timestamp: 500 },
    ];
    const richSessions = [
      ...MULTI_SESSIONS,
      { id: 'sess-proj', title: 'Proj Sess', preview: 'in proj', botName: 'default', gatewayId: 'gw-a', gatewayLabel: 'Office', timestamp: 6000 },
      { id: 'sess-done', title: 'Done Sess', preview: 'finished', botName: 'default', gatewayId: 'gw-a', gatewayLabel: 'Office', isDone: true, timestamp: 100 },
    ];
    const richGroups = [
      ...MULTI_GROUPS,
      { roomId: 'room-proj', name: 'Proj Room', members: ['default'], gatewayId: 'gw-a', gatewayLabel: 'Office', updatedAt: 6100 },
      { roomId: 'room-done', name: 'Done Room', members: ['default'], gatewayId: 'gw-a', gatewayLabel: 'Office', gatewayOffline: true, updatedAt: 50 },
    ];
    const projects = [{ id: 'p1', name: 'Project One' }];
    const assignments = {
      'session:default:sess-proj': 'prj:p1',
      'group:room-proj': 'prj:p1',
    };
    const doneRoomsMap = { 'room-done': 1000 };
    const containerCollapsed = { 'prj:p1': false, done: false };

    const dualRichModel = buildLeftRailModel({
      activeSessionId: 'sess-proj',
      activeFocus: { type: 'session', sessionId: 'sess-proj', gatewayId: 'gw-a' },
      profiles: richProfiles,
      groups: richGroups,
      sessions: richSessions,
      projects,
      assignments,
      doneRoomsMap,
      containerCollapsed,
      profileName: 'default',
      searchQuery: '',
      gatewayCount: 2,
    });

    // First render, identical re-render, and single-prop transitions to exercise every React.memo branch
    const richHandlers = { ...handlers, groupAvatars: richProfiles };
    driver.render(React.createElement(LeftRail, { ...richHandlers, model: dualRichModel, layout: 'dual-rail', activityVariant: 'halo' }));
    driver.render(React.createElement(LeftRail, { ...richHandlers, model: dualRichModel, layout: 'dual-rail', activityVariant: 'halo' }));
    const treeDual3 = driver.render(
      React.createElement(LeftRail, { ...richHandlers, model: dualRichModel, layout: 'dual-rail', activityVariant: 'orbit' }),
    );
    driver.render(
      React.createElement(LeftRail, {
        ...richHandlers,
        model: {
          ...dualRichModel,
          currentFocus: { type: 'bot', botName: 'coder', gatewayId: 'gw-b' },
          selectedAgent: dualRichModel.allAgents[1] || dualRichModel.selectedAgent,
        },
        layout: 'dual-rail',
        activityVariant: 'orbit',
      }),
    );
    driver.render(
      React.createElement(LeftRail, {
        ...richHandlers,
        model: {
          ...dualRichModel,
          allAgents: dualRichModel.allAgents.map((agent) => ({ ...agent })),
        },
        layout: 'dual-rail',
        activityVariant: 'orbit',
      }),
    );
    const treeDual2 = driver.render(
      React.createElement(LeftRail, { ...richHandlers, model: { ...dualRichModel, isMultiGateway: false }, layout: 'dual-rail', activityVariant: 'orbit' }),
    );
    driver.render(React.createElement(LeftRail, { ...richHandlers, model: dualRichModel, layout: 'dual-rail', activityVariant: 'orbit' }));
    driver.render(
      React.createElement(LeftRail, {
        ...richHandlers,
        model: {
          ...dualRichModel,
          isMultiGateway: true,
          allAgents: [...dualRichModel.allAgents, { name: 'unscoped-bot', displayName: 'Unscoped' }],
        },
        layout: 'dual-rail',
        activityVariant: 'orbit',
      }),
    );

    for (const el of findElements(treeDual3, (n) => n.props?.['data-room-id'] === 'room-proj' || n.props?.['data-room-id'] === 'room-done')) {
      el.props.onClick?.();
      el.props.onContextMenu?.({ preventDefault() {}, stopPropagation() {}, clientX: 1, clientY: 2 });
    }
    for (const el of findElements(treeDual3, (n) => n.props?.['data-id'] === 'sess-proj' || n.props?.['data-id'] === 'sess-done')) {
      el.props.onClick?.();
      el.props.onContextMenu?.({ preventDefault() {}, stopPropagation() {}, clientX: 3, clientY: 4 });
    }
    for (const el of findElements(treeDual2, (n) => n.props?.['data-station-profile'] === 'default' || n.props?.['data-station-profile'] === 'coder')) {
      el.props.onClick?.();
      el.props.onContextMenu?.({ preventDefault() {}, stopPropagation() {}, clientX: 5, clientY: 6 });
    }

    // Grouped re-render to exercise React.memo comparators on GroupedBotRow / GroupedGroupRow / GroupedSessionRow
    const groupedRichModel = buildGroupedLeftRailModel({
      activeSessionId: 'sess-proj',
      activeFocus: { type: 'session', sessionId: 'sess-proj', gatewayId: 'gw-a' },
      profiles: richProfiles,
      groups: richGroups,
      sessions: richSessions,
      projects,
      assignments,
      doneRoomsMap,
      containerCollapsed,
      profileName: 'default',
      searchQuery: '',
      gatewayCount: 2,
    });
    driver.render(React.createElement(GroupedLeftRail, { ...richHandlers, model: dualRichModel, groupedModel: groupedRichModel, activityVariant: 'halo' }));
    driver.render(React.createElement(GroupedLeftRail, { ...richHandlers, model: dualRichModel, groupedModel: groupedRichModel, activityVariant: 'halo' }));
    driver.render(React.createElement(GroupedLeftRail, { ...richHandlers, model: dualRichModel, groupedModel: groupedRichModel, activityVariant: 'orbit' }));
    driver.render(React.createElement(GroupedLeftRail, { ...richHandlers, model: dualRichModel, groupedModel: { ...groupedRichModel, isMultiGateway: false }, activityVariant: 'orbit' }));
    driver.render(
      React.createElement(GroupedLeftRail, {
        ...richHandlers,
        model: dualRichModel,
        groupedModel: {
          ...groupedRichModel,
          botsSection: {
            ...groupedRichModel.botsSection,
            items: groupedRichModel.botsSection.items.map((row) => ({ ...row })),
          },
        },
        activityVariant: 'orbit',
      }),
    );
    driver.render(React.createElement(GroupedLeftRail, { ...richHandlers, model: dualRichModel, groupedModel: groupedRichModel, activityVariant: 'orbit' }));

    // Single-gateway DualRail without and with gatewayId on profiles
    const singleNoGwModel = buildLeftRailModel({
      activeSessionId: '',
      activeFocus: { type: 'bot', botName: 'ghost-missing-bot', gatewayId: 'gw-z' },
      profiles: [
        { name: 'default', displayName: 'Def Plain', isDefault: true },
        { name: 'coder', displayName: 'Coder Plain' },
      ],
      groups: [],
      sessions: [],
      profileName: 'default',
      searchQuery: '',
      gatewayCount: 1,
    });
    const singleTree = driver.render(React.createElement(LeftRail, { ...handlers, model: singleNoGwModel, layout: 'dual-rail' }));
    for (const btn of findElements(singleTree, (n) => n.props?.['data-station-profile'] === 'default' || n.props?.['data-station-profile'] === 'coder')) {
      btn.props.onClick?.();
    }

    const singleWithGwModel = buildLeftRailModel({
      activeSessionId: '',
      activeFocus: { type: 'bot', botName: 'default', gatewayId: 'gw-a' },
      profiles: [
        { name: 'default', displayName: 'Default A', isDefault: true, gatewayId: 'gw-a' },
        { name: 'coder', displayName: 'Coder A', gatewayId: 'gw-a' },
      ],
      groups: [],
      sessions: [],
      profileName: 'default',
      searchQuery: '',
      gatewayCount: 1,
    });
    const singleGwTree = driver.render(React.createElement(LeftRail, { ...handlers, model: singleWithGwModel, layout: 'dual-rail' }));
    for (const btn of findElements(singleGwTree, (n) => n.props?.['data-station-profile'] === 'default' || n.props?.['data-station-profile'] === 'coder')) {
      btn.props.onClick?.();
    }

    const noGwDriver = createReactHookDriver();
    try {
      const noGwDefaultModel = buildLeftRailModel({
        activeSessionId: '',
        activeFocus: { type: 'bot', botName: 'default' },
        profiles: [{ name: 'default', displayName: 'Default Local' }],
        groups: [],
        sessions: [],
        profileName: 'default',
        searchQuery: '',
        gatewayCount: 1,
      });
      const noGwTree = noGwDriver.render(React.createElement(LeftRail, { ...handlers, model: noGwDefaultModel, layout: 'dual-rail' }));
      for (const btn of findElements(noGwTree, (n) => n.props?.['data-station-profile'] === 'default')) {
        btn.props.onClick?.();
      }
      assert.ok(captured.some((c) => c[0] === 'sel-bot' && c[1] === 'default' && c[2] === undefined));
    } finally {
      noGwDriver.cleanupAll();
    }

    assert.ok(captured.some((c) => c[0] === 'sel-group' && c[1] === 'room-proj' && c[2] === 'gw-a'));
    assert.ok(captured.some((c) => c[0] === 'sel-group' && c[1] === 'room-done' && c[2] === 'gw-a'));
    assert.ok(captured.some((c) => c[0] === 'sel-session' && c[1] === 'sess-done' && c[3] === 'gw-a'));
    assert.equal(isGroupFocused({ type: 'group', roomId: 'r1', gatewayId: 'gw-a' }, 'r1', 'gw-b'), false);
    assert.equal(isGroupFocused({ type: 'group', roomId: 'r1', gatewayId: 'gw-a' }, 'r1', 'gw-a'), true);

    const mobileOfflineGroup = buildMobileHomeModel({
      activeSessionId: '',
      activeFocus: { type: 'group', roomId: 'room-done', gatewayId: 'gw-a' },
      profiles: richProfiles,
      groups: richGroups,
      sessions: richSessions,
      profileName: 'default',
      searchQuery: '',
      collapsed: { bots: false, groups: false, sessions: false },
      gatewayCount: 2,
    });
    assert.equal(mobileOfflineGroup.groupsSection.items.some((g) => g.gatewayOffline === true), true);
  } finally {
    driver.cleanupAll();
  }
});
