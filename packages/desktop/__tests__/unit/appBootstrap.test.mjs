/**
 * 启动自举与模块组装中心纯单测 (App Bootstrap Unit Test)
 * (packages/desktop/__tests__/unit/appBootstrap.test.mjs)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clampLeftRailWidth,
  clampRail,
  clampStatusRailWidth,
  clampSubagentRailWidth,
  resolveRightRailSpec,
  restoreRailWidths,
  bindRailResizeEvents,
  isConversationDemoMode,
  injectConversationDemo,
  createAppBootstrap,
  LEFT_RAIL_WIDTH,
  RIGHT_RAIL_WIDTH,
  STATUS_RAIL_WIDTH,
  SUBAGENT_RAIL_WIDTH,
} from '../../dist/renderer/bootstrap/appBootstrap.mjs';

function createMockDeps(overrides = {}) {
  let renderCount = 0;
  let connectCount = 0;
  let restoreCacheCount = 0;
  let syncSystemWindowCount = 0;
  const boots = [];

  const state = {
    theme: 'obsidian-gold',
    lang: 'zh',
    platform: 'windows',
    gatewayConnected: false,
    gatewayConnecting: false,
    profileName: 'default',
    messages: [],
    availableModels: [],
    modelCatalog: [],
    gatewayUrl: 'http://127.0.0.1:8080',
    ...(overrides.state || {}),
  };

  const desktopApi = overrides.desktopApi ?? {
    getDefaultGatewayConfig: async () => ({
      url: 'http://127.0.0.1:9999',
      profile: 'test-profile',
    }),
  };

  const deps = {
    getState: () => state,
    render: () => {
      renderCount += 1;
    },
    getDesktopApi: () => desktopApi,
    getGatewayClient: () => null,
    connect: () => {
      connectCount += 1;
    },
    restoreCacheToState: async () => {
      restoreCacheCount += 1;
    },
    refreshProfilesFromServer: async () => {},
    syncSystemWindow: async () => {
      syncSystemWindowCount += 1;
    },
    fontPreferences: { family: 'sans-serif', size: 14 },
    logBoot: (info) => {
      boots.push(info);
    },
  };

  return {
    deps,
    state,
    desktopApi,
    getRenderCount: () => renderCount,
    getConnectCount: () => connectCount,
    getRestoreCacheCount: () => restoreCacheCount,
    getSyncSystemWindowCount: () => syncSystemWindowCount,
    boots,
  };
}

test('AppBootstrap: clampLeftRailWidth 与 clampRail 边界防护与兜底', () => {
  // 左轨宽度夹取测试
  assert.equal(clampLeftRailWidth(null), LEFT_RAIL_WIDTH.defaultValue);
  assert.equal(clampLeftRailWidth('invalid'), LEFT_RAIL_WIDTH.defaultValue);
  assert.equal(clampLeftRailWidth('100'), LEFT_RAIL_WIDTH.min);
  assert.equal(clampLeftRailWidth('1000'), LEFT_RAIL_WIDTH.max);
  assert.equal(clampLeftRailWidth('300'), 300);

  // 通用轨宽度夹取测试
  assert.equal(clampRail(null, 200, 500, 300), 300);
  assert.equal(clampRail('150', 200, 500, 300), 200);
  assert.equal(clampRail('600', 200, 500, 300), 500);
  assert.equal(clampRail('350', 200, 500, 300), 350);
});

test('AppBootstrap: isConversationDemoMode 非 demo 环境安全回退', () => {
  assert.equal(isConversationDemoMode(), false);
});

test('AppBootstrap: injectConversationDemo 注入完整演示模型与对话消息', () => {
  const state = {
    gatewayConnected: false,
    gatewayConnecting: true,
    profileName: '',
    messages: [],
    availableModels: [],
    modelCatalog: [],
  };

  injectConversationDemo(state);

  assert.equal(state.gatewayConnected, true);
  assert.equal(state.gatewayConnecting, false);
  assert.equal(state.profileName, 'default');
  assert.ok(state.availableModels.length > 0);
  assert.ok(state.modelCatalog.length > 0);
  assert.ok(state.messages.length >= 4);
});

test('AppBootstrap: init 正常执行自举流水线，触发缓存恢复与连接建立', async () => {
  const { deps, boots, getConnectCount, getRestoreCacheCount, getSyncSystemWindowCount } = createMockDeps();
  const bootstrap = createAppBootstrap(deps);

  await bootstrap.init();

  assert.equal(boots.length, 1);
  assert.equal(getSyncSystemWindowCount(), 1);
  assert.equal(getRestoreCacheCount(), 1);
  assert.equal(getConnectCount(), 1);
});

test('AppBootstrap: RIGHT_RAIL_WIDTH 默认 640px，restoreRailWidths 与双击复位对齐该真值', () => {
  assert.equal(RIGHT_RAIL_WIDTH.min, 380);
  assert.equal(RIGHT_RAIL_WIDTH.defaultValue, 640);
  assert.deepEqual(restoreRailWidths(), {
    left: LEFT_RAIL_WIDTH.defaultValue,
    right: RIGHT_RAIL_WIDTH.defaultValue,
  });

  const savedDoc = globalThis.document;
  const savedWin = globalThis.window;
  const savedStorage = globalThis.localStorage;
  const rootProps = new Map();
  const store = new Map();
  const handle = { dataset: { railHandle: 'right' } };

  globalThis.window = { innerWidth: 1440, addEventListener() {}, removeEventListener() {} };
  globalThis.document = {
    documentElement: { style: { setProperty: (k, v) => rootProps.set(k, v) } },
    querySelectorAll: () => [handle],
  };
  globalThis.localStorage = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, v),
  };

  try {
    const restored = restoreRailWidths();
    assert.equal(restored.right, RIGHT_RAIL_WIDTH.defaultValue);
    assert.equal(rootProps.get('--rail-w-right'), '640px');

    bindRailResizeEvents();
    handle.ondblclick({ stopPropagation() {} });
    assert.equal(rootProps.get('--rail-w-right'), '640px');
    assert.equal(store.get('hermes_flux_rail_w_right'), '640');

    // 状态栏 / 子Agent 独立变量与夹取边界验证
    assert.equal(STATUS_RAIL_WIDTH.min, 264);
    assert.equal(STATUS_RAIL_WIDTH.defaultValue, 288);
    assert.equal(clampStatusRailWidth('120'), 264);
    assert.equal(clampStatusRailWidth('900'), 400);
    assert.equal(SUBAGENT_RAIL_WIDTH.min, 360);
    assert.equal(SUBAGENT_RAIL_WIDTH.defaultValue, 420);
    assert.equal(clampSubagentRailWidth('200'), 360);
    assert.equal(clampSubagentRailWidth('800'), 560);
    assert.equal(resolveRightRailSpec('status').cssVar, '--rail-w-status');
    assert.equal(resolveRightRailSpec('subagent').cssVar, '--rail-w-subagent');
    assert.equal(resolveRightRailSpec('files').cssVar, '--rail-w-right');

    globalThis.document.getElementById = (id) =>
      id === 'flux-inspector-pod' ? { dataset: { podMode: 'status' } } : null;
    handle.ondblclick({ stopPropagation() {} });
    assert.equal(rootProps.get('--rail-w-status'), '288px');
    assert.equal(store.get('hermes_flux_rail_w_status'), '288');

    globalThis.document.getElementById = (id) =>
      id === 'flux-inspector-pod' ? { dataset: { podMode: 'subagent' } } : null;
    handle.ondblclick({ stopPropagation() {} });
    assert.equal(rootProps.get('--rail-w-subagent'), '420px');
    assert.equal(store.get('hermes_flux_rail_w_subagent'), '420');
  } finally {
    globalThis.document = savedDoc;
    globalThis.window = savedWin;
    globalThis.localStorage = savedStorage;
  }
});

test('AppBootstrap: setupGlobalEventListeners 统一接管焦点/可见性/网络/电源/移动桥事件并支持彻底卸载', async () => {
  const savedDoc = globalThis.document;
  const savedWin = globalThis.window;
  const savedNavDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

  const winListeners = new Map();
  const docListeners = new Map();
  const netListeners = new Map();
  let powerCb = null;
  let offPowerCalled = false;
  const wakeReasons = [];
  let pauseCalls = 0;
  let offlineCalls = 0;
  let fallbackProfileRefreshCalls = 0;

  const addTo = (map, type, fn) => {
    if (!map.has(type)) map.set(type, []);
    map.get(type).push(fn);
  };
  const removeFrom = (map, type, fn) => {
    map.set(type, (map.get(type) ?? []).filter((f) => f !== fn));
  };
  const emit = (map, type, ev = {}) => {
    for (const fn of [...(map.get(type) ?? [])]) fn(ev);
  };

  let visibilityState = 'visible';
  const dataset = {};
  globalThis.document = {
    get visibilityState() { return visibilityState; },
    documentElement: { dataset, style: { setProperty() {}, removeProperty() {} } },
    addEventListener: (t, fn) => addTo(docListeners, t, fn),
    removeEventListener: (t, fn) => removeFrom(docListeners, t, fn),
  };
  globalThis.window = {
    addEventListener: (t, fn) => addTo(winListeners, t, fn),
    removeEventListener: (t, fn) => removeFrom(winListeners, t, fn),
  };
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      connection: {
        addEventListener: (t, fn) => addTo(netListeners, t, fn),
        removeEventListener: (t, fn) => removeFrom(netListeners, t, fn),
      },
    },
  });

  try {
    const { deps, state } = createMockDeps();
    deps.getDesktopApi = () => ({
      onPowerEvent: (cb) => {
        powerCb = cb;
        return () => { offPowerCalled = true; };
      },
    });
    deps.onWakeOrRetry = (reason) => { wakeReasons.push(reason); };
    deps.onAppPause = () => { pauseCalls += 1; };
    deps.onNetworkOffline = () => { offlineCalls += 1; };

    const bootstrap = createAppBootstrap(deps);
    const cleanup = bootstrap.setupGlobalEventListeners();

    // focus 经过 250ms 防抖后唤醒（两次快速触发只执行一次）
    emit(winListeners, 'focus');
    emit(winListeners, 'focus');
    await new Promise((r) => setTimeout(r, 290));
    assert.deepEqual(wakeReasons, ['focus']);

    // visibilitychange hidden/visible
    visibilityState = 'hidden';
    emit(docListeners, 'visibilitychange');
    assert.equal(dataset.pageHidden, 'true');
    assert.equal(dataset.appHidden, 'true');
    assert.equal(pauseCalls, 1);

    visibilityState = 'visible';
    emit(docListeners, 'visibilitychange');
    assert.equal(dataset.pageHidden, undefined);
    assert.equal(dataset.appHidden, 'false');
    await new Promise((r) => setTimeout(r, 290));
    assert.equal(wakeReasons.at(-1), 'visibility');

    // pageshow persisted=false 忽略，persisted=true 立即唤醒
    emit(winListeners, 'pageshow', { persisted: false });
    emit(winListeners, 'pageshow', { persisted: true });
    assert.equal(wakeReasons.at(-1), 'pageshow');

    // online / offline / netinfo change
    emit(winListeners, 'offline');
    emit(winListeners, 'online');
    emit(netListeners, 'change');
    assert.equal(offlineCalls, 1);
    assert.deepEqual(wakeReasons.slice(-2), ['online', 'netinfo-change']);

    // 移动桥事件：pause / resume / network-change
    emit(winListeners, 'hermes-mobile-pause');
    emit(winListeners, 'hermes-mobile-resume');
    emit(winListeners, 'hermes-mobile-network-change', { detail: { connected: false } });
    emit(winListeners, 'hermes-mobile-network-change', { detail: { connected: true } });
    assert.equal(pauseCalls, 2);
    assert.equal(offlineCalls, 2);
    assert.deepEqual(wakeReasons.slice(-2), ['mobile-resume', 'mobile-network-change']);

    // Electron powerMonitor 事件：suspend / resume / unlock-screen
    powerCb?.('suspend');
    powerCb?.('resume');
    powerCb?.('unlock-screen');
    assert.equal(pauseCalls, 3);
    assert.deepEqual(wakeReasons.slice(-2), ['power-resume', 'power-unlock-screen']);

    // 卸载清理所有监听与挂起的防抖定时器
    emit(winListeners, 'focus');
    cleanup();
    assert.equal(offPowerCalled, true);
    assert.equal(winListeners.get('focus').length, 0);
    assert.equal(docListeners.get('visibilitychange').length, 0);
    assert.equal(netListeners.get('change').length, 0);

    // 未传入 onWakeOrRetry 时的回退行为，且 navigator=undefined 时安全跳过 network change 注册
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: undefined });
    const { deps: fallbackDeps, state: fState } = createMockDeps();
    fallbackDeps.getDesktopApi = () => ({});
    fallbackDeps.getGatewayClient = () => ({});
    fallbackDeps.refreshProfilesFromServer = async () => { fallbackProfileRefreshCalls += 1; };
    fState.isStreaming = false;
    const fbCleanup = createAppBootstrap(fallbackDeps).setupGlobalEventListeners();
    emit(winListeners, 'online');
    assert.equal(fallbackProfileRefreshCalls, 1);
    fbCleanup();
  } finally {
    globalThis.document = savedDoc;
    globalThis.window = savedWin;
    if (savedNavDesc) Object.defineProperty(globalThis, 'navigator', savedNavDesc);
    else delete globalThis.navigator;
  }
});
