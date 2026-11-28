/**
 * 前后台视图协同同步协调器（ForegroundSyncCoordinator）全分支单元测试
 * (packages/desktop/__tests__/unit/foreground-sync-coordinator.test.mjs)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createForegroundSyncCoordinator,
  createActiveViewSyncAdapters,
} from '../../dist/renderer/services/foregroundSyncCoordinator.mjs';

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createHarness(overrides = {}) {
  const calls = [];
  const phases = [];
  let renderCount = 0;
  let currentNow = 10_000;

  const state = {
    gatewayConnected: true,
    manualDisconnected: false,
    connectionAuthError: false,
    connectionPhase: 'connected',
    activeFocus: { type: 'session', sessionId: 'sess-1' },
    activeSessionId: 'sess-1',
    isSettingsOpen: false,
    inspectorCollapsed: false,
    settingsSection: 'providers',
    rightPodMode: { kind: 'files' },
    messages: [],
    ...(overrides.state || {}),
  };

  let viewContext = {
    isMobile: false,
    mobilePane: 'stage',
    homeTab: 'chats',
    botSubpage: null,
    settingsOpen: false,
    settingsSubpage: null,
    ...(overrides.viewContext || {}),
  };

  const deps = {
    getState: () => state,
    render: () => {
      renderCount += 1;
      phases.push(state.connectionPhase);
    },
    fetchProfiles: async () => {
      calls.push('fetchProfiles');
      if (overrides.onFetchProfiles) await overrides.onFetchProfiles();
    },
    fetchSessions: async () => {
      calls.push('fetchSessions');
    },
    fetchGroupRooms: async () => {
      calls.push('fetchGroupRooms');
    },
    prefetchSlashCatalog: async () => {
      calls.push('prefetchSlashCatalog');
    },
    fetchModelOptions: async () => {
      calls.push('fetchModelOptions');
    },
    fetchProjects: async () => {
      calls.push('fetchProjects');
    },
    refreshActiveSession: async (opts) => {
      calls.push(['refreshActiveSession', Boolean(opts?.forceRefreshAfterReconnect)]);
      if (overrides.onRefreshActiveSession) await overrides.onRefreshActiveSession(opts);
    },
    refreshGroupRoomLog: async (roomId) => {
      calls.push(['refreshGroupRoomLog', roomId]);
    },
    ensureGroupPollerRunning: (roomId) => {
      calls.push(['ensureGroupPollerRunning', roomId]);
    },
    openBotChat: async (botName) => {
      calls.push(['openBotChat', botName]);
    },
    getActiveViewContext: () => viewContext,
    hasUnsavedBotDrafts: overrides.hasUnsavedBotDrafts ?? (() => false),
    refreshBotHubView: async () => {
      calls.push('refreshBotHubView');
    },
    refreshInspectorView: async () => {
      calls.push('refreshInspectorView');
    },
    refreshSettingsView: async (subpage) => {
      calls.push(['refreshSettingsView', subpage]);
    },
    isUserEditingInput: overrides.isUserEditingInput,
    resumeAliveThrottleMs: overrides.resumeAliveThrottleMs ?? 3000,
    quietSyncDelayMs: overrides.quietSyncDelayMs ?? 30,
    syncedFlashMs: overrides.syncedFlashMs ?? 30,
    now: () => currentNow,
  };

  const coordinator = createForegroundSyncCoordinator(deps);
  return {
    coordinator,
    state,
    calls,
    phases,
    getRenderCount: () => renderCount,
    setNow: (ms) => {
      currentNow = ms;
    },
    setViewContext: (next) => {
      viewContext = { ...viewContext, ...next };
    },
  };
}

test('createForegroundSyncCoordinator: connected/reconnected 与静默/慢速 resume-alive 相位切换', async () => {
  const h = createHarness({ quietSyncDelayMs: 40, syncedFlashMs: 25 });

  // 1. 快路径 resume-alive (<40ms) 不得进入 syncing/synced，直接归于 connected
  await h.coordinator.syncOnResumeAlive();
  assert.equal(h.state.connectionPhase, 'connected');
  assert.deepEqual(h.phases, [], '快路径不得额外闪烁 syncing/synced');

  // 2. 3000ms 节流期内忽略重复唤醒；force: true 必须放行
  const callsBeforeThrottle = h.calls.length;
  h.setNow(11_000);
  await h.coordinator.syncOnResumeAlive();
  assert.equal(h.calls.length, callsBeforeThrottle, '节流窗口内不得重复发请求');
  await h.coordinator.syncOnResumeAlive({ force: true });
  assert.ok(h.calls.length > callsBeforeThrottle, 'force: true 必须绕过节流');

  // 3. 慢速 resume-alive (>40ms) 触发 syncing -> synced -> connected
  const slow = createDeferred();
  const hSlow = createHarness({
    quietSyncDelayMs: 10,
    syncedFlashMs: 25,
    onRefreshActiveSession: () => slow.promise,
  });
  const pendingSlow = hSlow.coordinator.syncOnResumeAlive({ force: true });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(hSlow.state.connectionPhase, 'syncing', '超过 quietDelay 必须切入 syncing');
  slow.resolve();
  await pendingSlow;
  assert.equal(hSlow.state.connectionPhase, 'synced', '完成后先切入 synced');
  await new Promise((r) => setTimeout(r, 45));
  assert.equal(hSlow.state.connectionPhase, 'connected', 'synced 闪烁定时结束后回到 connected');

  // 4. reconnected / connected 立即进入 syncing 并传入 forceRefreshAfterReconnect=true/false
  const hConn = createHarness({ quietSyncDelayMs: 500, syncedFlashMs: 20 });
  await hConn.coordinator.syncOnConnected('reconnected');
  assert.ok(hConn.phases.includes('syncing'));
  assert.ok(hConn.phases.includes('synced'));
  assert.deepEqual(
    hConn.calls.find((c) => Array.isArray(c) && c[0] === 'refreshActiveSession'),
    ['refreshActiveSession', true],
  );
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(hConn.state.connectionPhase, 'connected');
  hConn.coordinator.dispose();
  hSlow.coordinator.dispose();
  h.coordinator.dispose();
});

test('createForegroundSyncCoordinator: 单飞队列按触发权重升级且 onAppPause 清理定时器', async () => {
  const gate = createDeferred();
  const h = createHarness({
    quietSyncDelayMs: 15,
    syncedFlashMs: 60,
    onFetchProfiles: () => gate.promise,
  });

  const p1 = h.coordinator.syncOnResumeAlive();
  // 在飞期间先后投递 reconnected(权重3) 与 connected(权重2) 与 resume-alive(权重1)
  const p2 = h.coordinator.syncOnConnected('connected');
  const p3 = h.coordinator.syncOnConnected('reconnected');
  const p4 = h.coordinator.syncOnResumeAlive({ force: true });

  gate.resolve();
  await Promise.all([p1, p2, p3, p4]);

  const refreshCalls = h.calls.filter((c) => Array.isArray(c) && c[0] === 'refreshActiveSession');
  assert.equal(refreshCalls.length, 2, '合并在飞队列后应多补跑一轮高权重触发');
  assert.deepEqual(refreshCalls[1], ['refreshActiveSession', true], '高权重 reconnected 不得被后到的 resume-alive 降级覆盖');

  // onAppPause 清理 synced 定时器
  h.coordinator.onAppPause();
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(h.state.connectionPhase, 'synced', 'onAppPause 清除 timer 后不再回退 connected');

  // 断网 / manualDisconnected / connectionAuthError 守卫
  h.state.gatewayConnected = false;
  const beforeOffline = h.calls.length;
  await h.coordinator.syncOnConnected('connected');
  assert.equal(h.calls.length, beforeOffline, '离线时 scheduleSync 必须直接返回');

  h.state.gatewayConnected = true;
  h.state.manualDisconnected = true;
  const phaseBeforeManual = h.state.connectionPhase;
  await h.coordinator.syncOnConnected('reconnected');
  assert.equal(h.state.connectionPhase, phaseBeforeManual, 'manualDisconnected 时 setPhaseIfStillOnline 不得写相位');
  h.coordinator.dispose();
});

test('createForegroundSyncCoordinator: 全视图感知刷新（群聊 / 离线直达Bot / BotHub草稿锁 / 检查舱 / 设置焦点锁 / dispose竞态）', async () => {
  // 1. 群聊聚焦（按域模型 activeSessionId=''）+ 桌面开启设置 + 检查舱打开
  const hGroup = createHarness({
    state: {
      activeFocus: { type: 'group', roomId: 'room-1' },
      activeSessionId: '',
      isSettingsOpen: true,
      inspectorCollapsed: false,
    },
    isUserEditingInput: () => false,
  });
  await hGroup.coordinator.syncOnConnected('connected');
  assert.deepEqual(
    hGroup.calls.filter((c) => Array.isArray(c)),
    [
      ['ensureGroupPollerRunning', 'room-1'],
      ['refreshGroupRoomLog', 'room-1'],
      ['refreshSettingsView', null],
    ],
  );
  assert.ok(hGroup.calls.includes('refreshInspectorView'));

  // 2. Bot 离线态（无 activeSessionId）触发 openBotChat；Mobile Bot Hub 在无草稿时刷新
  const hBot = createHarness({
    state: {
      activeFocus: { type: 'bot', botName: 'writer' },
      activeSessionId: '',
      inspectorCollapsed: true,
    },
    viewContext: {
      isMobile: true,
      mobilePane: 'home',
      homeTab: 'bots',
      botSubpage: null,
      settingsOpen: false,
      settingsSubpage: 'gateway',
    },
    hasUnsavedBotDrafts: () => false,
  });
  await hBot.coordinator.syncOnConnected('connected');
  assert.ok(hBot.calls.some((c) => Array.isArray(c) && c[0] === 'openBotChat' && c[1] === 'writer'));
  assert.ok(hBot.calls.includes('refreshBotHubView'));

  // 3. 有未保存草稿 / 默认 document.activeElement 正在输入时阻止覆写 BotHub 与 Settings
  const prevDocument = globalThis.document;
  try {
    globalThis.document = {
      activeElement: { tagName: 'TEXTAREA', isContentEditable: false },
    };
    const hGuard = createHarness({
      state: { isSettingsOpen: true, inspectorCollapsed: true },
      viewContext: {
        isMobile: true,
        mobilePane: 'inspector',
        botSubpage: 'soul',
        settingsOpen: true,
        settingsSubpage: 'providers',
      },
      hasUnsavedBotDrafts: () => true,
    });
    await hGuard.coordinator.syncOnConnected('connected');
    assert.equal(hGuard.calls.includes('refreshBotHubView'), false, '有草稿时严禁刷新 BotHub');
    assert.equal(
      hGuard.calls.some((c) => Array.isArray(c) && c[0] === 'refreshSettingsView'),
      false,
      '用户正编辑 textarea 时严禁覆写 Settings',
    );
    assert.ok(hGuard.calls.includes('refreshInspectorView'), '移动端 inspector 屏必须触发检查舱刷新');

    globalThis.document = { activeElement: { tagName: 'DIV', isContentEditable: false } };
    const hNotEditing = createForegroundSyncCoordinator({
      getState: () => ({
        gatewayConnected: true,
        manualDisconnected: false,
        connectionAuthError: false,
        connectionPhase: 'connected',
        activeFocus: { type: 'session', sessionId: 'sess-1' },
        activeSessionId: 'sess-1',
        isSettingsOpen: true,
        inspectorCollapsed: true,
        settingsSection: 'providers',
        messages: [],
      }),
      render: () => {},
      fetchProfiles: async () => {},
      fetchSessions: async () => {},
      fetchGroupRooms: async () => {},
      prefetchSlashCatalog: async () => {},
      fetchModelOptions: async () => {},
      fetchProjects: async () => {},
      refreshActiveSession: async () => {},
      refreshGroupRoomLog: async () => {},
      openBotChat: async () => {},
      getActiveViewContext: () => ({
        isMobile: false,
        mobilePane: 'stage',
        homeTab: 'chats',
        botSubpage: null,
        settingsOpen: true,
        settingsSubpage: 'providers',
      }),
      hasUnsavedBotDrafts: () => false,
      refreshSettingsView: () => callsInDefault.push('settings-refreshed'),
    });
    const callsInDefault = [];
    await hNotEditing.syncOnConnected('connected');
    assert.deepEqual(callsInDefault, ['settings-refreshed']);

    globalThis.document = { activeElement: { tagName: 'INPUT', isContentEditable: false } };
    await hNotEditing.syncOnConnected('connected');
    globalThis.document = { activeElement: { tagName: 'DIV', isContentEditable: true } };
    await hNotEditing.syncOnConnected('connected');
    delete globalThis.document;
    await hNotEditing.syncOnConnected('connected');
    assert.equal(callsInDefault.length, 2, 'document 缺失时不得阻断设置刷新');
    hNotEditing.dispose();
  } finally {
    globalThis.document = prevDocument;
  }

  // 4. 在 quietTimer 触发之前断开网关连接：quietTimer 回调应安全退出
  const slow2 = createDeferred();
  const hAbort = createHarness({
    quietSyncDelayMs: 5,
    onRefreshActiveSession: () => slow2.promise,
  });
  const pAbort = hAbort.coordinator.syncOnResumeAlive({ force: true });
  hAbort.state.gatewayConnected = false;
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(hAbort.state.connectionPhase, 'connected');
  slow2.resolve();
  await pAbort;
  hGroup.coordinator.dispose();
  hBot.coordinator.dispose();
  hAbort.coordinator.dispose();
});

test('createActiveViewSyncAdapters: 全视图适配回调与群轮询基线映射（使用 groupRoomStore.getLogs）', async () => {
  const events = [];
  let mobileActive = false;
  let polling = false;
  const state = {
    activeFocus: { type: 'group', roomId: 'room-1' },
    activeSessionId: '',
    settingsSection: 'agents',
    rightPodMode: { kind: 'files' },
    messages: [
      { id: 'u1', role: 'user', sender: 'human', content: 'hi' },
      { id: 'a1', role: 'assistant', sender: 'bot-a', content: 'hello' },
    ],
  };

  const adapters = createActiveViewSyncAdapters({
    getState: () => state,
    isMobileShellActive: () => mobileActive,
    getMobileViewContext: () => ({
      isMobile: true,
      mobilePane: 'home',
      homeTab: 'chats',
      botSubpage: null,
      settingsOpen: true,
      settingsSubpage: 'gateway',
    }),
    settingsDataService: {
      hasUnsavedBotDrafts: () => true,
      getBotManagementController: () => ({
        loadRoster: async (force) => {
          events.push(['loadRoster', force]);
        },
      }),
      ensureSettingsSectionData: (section, force) => {
        events.push(['ensureSettingsSectionData', section, force]);
      },
    },
    fileViewerService: {
      loadFileTree: async (force) => {
        events.push(['loadFileTree', force]);
      },
    },
    groupPollerManager: {
      isPolling: () => polling,
      startAwaitReply: (roomId, baseline) => {
        events.push(['startAwaitReply', roomId, baseline]);
      },
    },
    getGroupRoomLogs: (roomId) =>
      roomId === 'room-1'
        ? [
            { messageId: 'g-u1', seq: 11, actorKind: 'user', senderProfile: 'human', text: 'hi' },
            { messageId: 'g-a1', seq: 12, actorKind: 'assistant', senderProfile: 'bot-a', text: 'hello' },
          ]
        : [],
    hostedRoomIds: new Set(['room-1', 'room-2']),
    activeRunningGroupRoomIds: new Set(['room-1', 'room-2']),
  });

  assert.equal(adapters.getActiveViewContext().isMobile, false);
  mobileActive = true;
  assert.equal(adapters.getActiveViewContext().isMobile, true);
  assert.equal(adapters.hasUnsavedBotDrafts(), true);

  await adapters.refreshBotHubView();
  await adapters.refreshInspectorView();

  // Desktop non-files rightPodMode skips file tree refresh
  mobileActive = false;
  state.rightPodMode = { kind: 'status' };
  assert.equal(adapters.refreshInspectorView(), undefined);
  state.rightPodMode = undefined;
  await adapters.refreshInspectorView();

  // gateway -> connection; null -> state.settingsSection
  adapters.refreshSettingsView('gateway');
  adapters.refreshSettingsView(null);

  // Group poller guards & authoritative groupRoomStore baseline mapping (activeSessionId === '')
  adapters.ensureGroupPollerRunning('unknown-room');
  polling = true;
  adapters.ensureGroupPollerRunning('room-1');
  polling = false;
  adapters.ensureGroupPollerRunning('room-1');
  adapters.ensureGroupPollerRunning('room-2');

  assert.deepEqual(events, [
    ['loadRoster', true],
    ['loadFileTree', true],
    ['loadFileTree', true],
    ['ensureSettingsSectionData', 'gateway', true],
    ['ensureSettingsSectionData', 'agents', true],
    ['startAwaitReply', 'room-1', { knownCount: 2, lastSeq: 12, lastAssistantMessageId: 'g-a1' }],
    ['startAwaitReply', 'room-2', { knownCount: 0, lastSeq: 0, lastAssistantMessageId: null }],
  ]);

  // dispose() 在同步在途期间触发后，慢请求落盘不得改写 connectionPhase 或重启动效定时器
  const slowDispose = createDeferred();
  const hDispose = createHarness({
    onRefreshActiveSession: () => slowDispose.promise,
  });
  const pendingSync = hDispose.coordinator.syncOnConnected('reconnected');
  assert.equal(hDispose.state.connectionPhase, 'syncing');
  hDispose.coordinator.dispose();
  slowDispose.resolve();
  await pendingSync;
  assert.equal(hDispose.state.connectionPhase, 'syncing', 'dispose 后已结算同步不得写回 synced/connected');
  await hDispose.coordinator.syncOnResumeAlive({ force: true });
});
