/**
 * 断连重连舞台保活、流式对账、增量合并与冷启动退避单元测试
 * (packages/desktop/__tests__/unit/reconnect-stage-preservation.test.mjs)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  renderConversationCanvas,
  renderMiddlePod,
  setLocale,
  t,
} from '@hermes-flux/ui';
import {
  createInitialState,
} from '../../dist/renderer/state/appState.mjs';
import {
  createRenderCoordinator,
  shouldPreserveConversationShell,
} from '../../dist/renderer/renderCoordinator.mjs';
import { planSessionLoadMerge } from '../../dist/renderer/rollbackTransaction.mjs';
import { createMessageLoadingService } from '../../dist/renderer/services/messageLoadingService.mjs';
import { createProfileManagementService } from '../../dist/renderer/services/profileManagementService.mjs';
import { createGatewayEventDispatcher } from '../../dist/renderer/gateway/gatewayEventDispatcher.mjs';
import { createTitlebarController } from '../../dist/renderer/titlebarController.mjs';

test('shouldPreserveConversationShell & MiddlePod preserveStage 全分支边界', () => {
  const base = createInitialState({ platform: 'windows' });

  assert.equal(shouldPreserveConversationShell({ ...base, gatewayConnected: true }), true);
  assert.equal(
    shouldPreserveConversationShell({ ...base, gatewayConnected: false, connectionPhase: undefined }),
    false,
  );
  assert.equal(
    shouldPreserveConversationShell({
      ...base,
      gatewayConnected: false,
      connectionPhase: 'unconfigured',
      activeSessionId: 's1',
      messages: [{ id: 'm1', role: 'user', content: 'hi', timestamp: '' }],
    }),
    false,
  );
  assert.equal(
    shouldPreserveConversationShell({
      ...base,
      gatewayConnected: false,
      connectionPhase: 'reconnecting',
      activeSessionId: '',
      messages: [],
    }),
    false,
  );
  assert.equal(
    shouldPreserveConversationShell({
      ...base,
      gatewayConnected: false,
      connectionPhase: 'reconnecting',
      activeSessionId: 's1',
      messages: [],
    }),
    true,
  );
  assert.equal(
    shouldPreserveConversationShell({
      ...base,
      gatewayConnected: false,
      connectionPhase: 'offline',
      activeSessionId: '',
      messages: [{ id: 'm1', role: 'user', content: 'cached', timestamp: '' }],
    }),
    true,
  );

  // MiddlePod renderConversationCanvas: preserveStage 保留有消息画布 / 保留空态 / 未保活降级 onboarding
  const visibleHtml = renderConversationCanvas({
    gatewayConnected: false,
    gatewayConnecting: true,
    preserveStage: true,
    messages: [{ id: 'm1', role: 'assistant', content: 'ok', timestamp: '10:00' }],
  });
  assert.match(visibleHtml, /react-message-list-host/);
  assert.doesNotMatch(visibleHtml, /gateway-onboarding-card/);

  const emptyStageHtml = renderConversationCanvas({
    gatewayConnected: false,
    gatewayConnecting: true,
    preserveStage: true,
    messages: [],
  });
  assert.doesNotMatch(emptyStageHtml, /gateway-onboarding-card/);

  const onboardingHtml = renderConversationCanvas({
    gatewayConnected: false,
    gatewayConnecting: false,
    preserveStage: false,
    messages: [],
  });
  assert.match(onboardingHtml, /gateway-onboarding-card/);

  const podHtml = renderMiddlePod({
    gatewayConnected: false,
    preserveStage: true,
    messages: [{ id: 'm1', role: 'user', content: 'hi', timestamp: '' }],
    dockHtml: '<div class="input-dock-container"></div>',
  });
  assert.match(podHtml, /id="react-conv-connection-host"/);
});

test('RenderCoordinator: 断连保活输入舱与 ConnectionStatusPill 挂载/更新/顶替/清理全闭环', () => {
  const saved = {
    document: globalThis.document,
    window: globalThis.window,
    raf: globalThis.requestAnimationFrame,
    gcs: globalThis.getComputedStyle,
    HTMLElement: globalThis.HTMLElement,
  };

  function makeEl(id, tagName = 'DIV') {
    const attrs = new Map();
    const children = [];
    const el = {
      id,
      tagName,
      nodeType: 1,
      className: '',
      innerHTML: '',
      children,
      style: { setProperty() {}, getPropertyValue: () => '', removeProperty() {} },
      dataset: {},
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      isConnected: true,
      parentNode: null,
      setAttribute(k, v) {
        attrs.set(k, String(v));
      },
      getAttribute(k) {
        return attrs.get(k) ?? null;
      },
      removeAttribute(k) {
        attrs.delete(k);
      },
      appendChild(child) {
        child.parentNode = el;
        children.push(child);
        if (child.id) elements.set(child.id, child);
        return child;
      },
      insertAdjacentHTML() {},
      querySelector(sel) {
        if (sel === '.flux-body-container') return bodyContainer;
        if (sel === '.flux-middle-pod') return middlePod;
        if (sel === '.input-dock-container') return dockPresent ? existingDock : null;
        return null;
      },
      querySelectorAll() {
        return [];
      },
      getBoundingClientRect: () => ({ top: 0, bottom: 100, left: 0, right: 400, width: 400, height: 100 }),
    };
    return el;
  }

  let bodyContainer = null;
  let dockPresent = false;
  let dockRemoved = false;
  let existingDock = {
    outerHTML: '<div class="input-dock-container"></div>',
    remove() {
      dockRemoved = true;
      dockPresent = false;
    },
  };
  const middlePod = makeEl('middle-pod');
  const presenceHost = makeEl('react-conv-presence-host');
  const rootEl = makeEl('flux-app-root');
  const elements = new Map([
    ['flux-app-root', rootEl],
    ['conversation-stream', makeEl('conversation-stream')],
    ['react-conv-presence-host', presenceHost],
  ]);

  globalThis.document = {
    activeElement: null,
    getElementById: (id) => elements.get(id) ?? null,
    querySelector: (sel) => (sel === '.flux-middle-pod' ? middlePod : null),
    querySelectorAll: () => [],
    createElement: (tag) => makeEl('', tag.toUpperCase()),
    addEventListener() {},
    removeEventListener() {},
    documentElement: makeEl('html', 'HTML'),
    body: makeEl('body', 'BODY'),
    head: makeEl('head', 'HEAD'),
  };
  globalThis.window = {
    addEventListener() {},
    removeEventListener() {},
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  };
  globalThis.requestAnimationFrame = () => 1;
  globalThis.getComputedStyle = () => ({ paddingBottom: '0px', getPropertyValue: () => '' });
  globalThis.HTMLElement = class {};

  const pillEvents = [];
  let mountedPillCount = 0;
  let capturedPillGetProps = null;
  let ensureSettingsCalls = 0;

  const state = createInitialState({ platform: 'windows' });
  state.gatewayUrl = 'https://gw.example';
  state.gatewayConnected = false;
  state.connectionPhase = 'reconnecting';
  state.connectionReconnectAttempt = 1;
  state.activeSessionId = 's1';
  state.messages = [{ id: 'm1', rowId: 1, role: 'user', content: 'hello', timestamp: '10:00' }];

  try {
    const coordinator = createRenderCoordinator({
      getState: () => state,
      messageWindowManager: {
        ensureMessageWindow() {},
        getMessageWindowStart: () => 0,
        getMessageWindowEnd: () => 50,
        getAverageRowHeightPx: () => 60,
        computeContentOffsetPx: () => 0,
        computeVirtualHeightPx: () => 300,
        markProgrammaticScroll() {},
        syncScrollTopToWindow() {},
        observeVirtualWindowGeometry() {},
        scheduleVirtualHeightSync() {},
      },
      modalInteractionController: {
        renderContextMenuHtml: () => '',
        renderConfirmModalHtml: () => '',
        updateModals() {},
      },
      isStreamingActiveForCurrentSession: () => false,
      resolveSessionKnownFiles: () => [],
      getTitlebarSnapshot: () => ({}),
      getLeftRailSnapshot: () => ({}),
      createLeftRailActions: () => ({}),
      getPromptNavigatorSnapshot: () => ({}),
      createPromptNavigatorActions: () => ({}),
      rebuildPromptEntries() {},
      syncPromptNavigatorMeta() {},
      syncPromptNavigator() {},
      syncReactSettings() {},
      ensureSettingsSectionData: () => {
        ensureSettingsCalls += 1;
      },
      syncAgentPresenceHost() {},
      syncAgentPresence() {},
      captureStreamAnchor: () => ({}),
      applyStreamAnchor() {},
      stabilizeStreamAnchor() {},
      isStreamNearBottom: () => true,
      syncStreamBottomInset() {},
      settleInitialBottom() {},
      isSessionEnterPending: () => false,
      settleSessionEnter() {},
      bindEvents() {},
      syncComposerPoppers() {},
      mountConnectionPill: (host, getProps) => {
        mountedPillCount += 1;
        capturedPillGetProps = getProps;
        pillEvents.push(['mount', host.id, getProps().phase]);
        getProps().onMountedChange?.(true);
        return {
          update() {
            pillEvents.push(['update', getProps().phase, getProps().attempt]);
          },
          unmount() {
            pillEvents.push(['unmount']);
            getProps().onMountedChange?.(false);
          },
        };
      },
    });

    // 1. 全量装配：重连期间 preserveStage=true，dock 与 #react-conv-connection-host 自动创建并挂载
    coordinator.render();
    assert.ok(rootEl.innerHTML.includes('input-dock-container'), '重连期全量渲染必须保留输入舱');
    assert.equal(mountedPillCount, 1);
    assert.equal(presenceHost.getAttribute('data-replaced'), 'true', '重连胶囊激活时必须顶替在场槽位');

    // 2. 切入增量渲染：同一 phase/attempt 跳过重复 update；attempt 变化触发 update()
    bodyContainer = makeEl('body-container');
    dockPresent = true;
    coordinator.render();
    assert.equal(pillEvents.filter((e) => e[0] === 'update').length, 0);

    state.connectionReconnectAttempt = 3;
    coordinator.render();
    assert.deepEqual(pillEvents.at(-1), ['update', 'reconnecting', 3]);

    // 3. 点击 pill onOpenSettings 打开设置页，再以 authError=true 触发 key 变更与更新
    capturedPillGetProps().onOpenSettings();
    assert.equal(state.isSettingsOpen, true);
    assert.equal(ensureSettingsCalls, 1);

    state.connectionAuthError = true;
    coordinator.render();

    // 更新到已连接态：handle 已挂载且 !isVisible -> 调用 update()；更换 host 节点触发旧 handle.unmount()
    state.gatewayConnected = true;
    state.connectionAuthError = false;
    state.connectionPhase = 'connected';
    coordinator.render();

    state.gatewayConnected = false;
    state.connectionPhase = 'offline';
    const nextHost = makeEl('react-conv-connection-host');
    elements.set('react-conv-connection-host', nextHost);
    coordinator.render();
    assert.ok(pillEvents.some((e) => e[0] === 'unmount'));

    // presenceHost 带有 data-mobile-slot='true' 时不得覆写其 data-replaced；无 presenceHost 时安全跳过
    presenceHost.dataset.mobileSlot = 'true';
    coordinator.render();
    delete presenceHost.dataset.mobileSlot;
    elements.delete('react-conv-presence-host');
    coordinator.render();
    elements.set('react-conv-presence-host', presenceHost);

    // 4. connectionPhase 改为 'unconfigured' 后不再 preserveShell：触发 existingDock.remove()
    state.connectionPhase = 'unconfigured';
    coordinator.render();
    assert.equal(dockRemoved, true, 'unconfigured 时允许移除 dock');

    // 5. 若连接宿主节点断连（isConnected=false），自动卸载旧 handle 并恢复 presence
    const connHost = elements.get('react-conv-connection-host');
    connHost.isConnected = false;
    state.connectionPhase = 'syncing';
    coordinator.render();
    assert.equal(presenceHost.getAttribute('data-replaced'), 'false');

    // 重新连接宿主并在 dispose() 时清理；connectionPhase=undefined 时安全跳过
    connHost.isConnected = true;
    coordinator.render();
    state.connectionPhase = undefined;
    coordinator.render();
    coordinator.dispose();
    assert.equal(pillEvents.at(-1)[0], 'unmount');

    // 默认 mountConnectionStatusPill 后备分支验证（未注入 mountConnectionPill）
    const defaultCoord = createRenderCoordinator({
      getState: () => ({ ...createInitialState({ platform: 'windows' }), connectionPhase: 'reconnecting' }),
      messageWindowManager: {
        ensureMessageWindow() {},
        getMessageWindowStart: () => 0,
        getMessageWindowEnd: () => 50,
        getAverageRowHeightPx: () => 60,
        computeContentOffsetPx: () => 0,
        computeVirtualHeightPx: () => 300,
        markProgrammaticScroll() {},
        syncScrollTopToWindow() {},
        observeVirtualWindowGeometry() {},
        scheduleVirtualHeightSync() {},
      },
      modalInteractionController: {
        renderContextMenuHtml: () => '',
        renderConfirmModalHtml: () => '',
        updateModals() {},
      },
      isStreamingActiveForCurrentSession: () => false,
      resolveSessionKnownFiles: () => [],
      getTitlebarSnapshot: () => ({}),
      getLeftRailSnapshot: () => ({}),
      createLeftRailActions: () => ({}),
      getPromptNavigatorSnapshot: () => ({}),
      createPromptNavigatorActions: () => ({}),
      rebuildPromptEntries() {},
      syncPromptNavigatorMeta() {},
      syncPromptNavigator() {},
      syncReactSettings() {},
      ensureSettingsSectionData() {},
      syncAgentPresenceHost() {},
      syncAgentPresence() {},
      captureStreamAnchor: () => ({}),
      applyStreamAnchor() {},
      stabilizeStreamAnchor() {},
      isStreamNearBottom: () => true,
      syncStreamBottomInset() {},
      settleInitialBottom() {},
      isSessionEnterPending: () => false,
      settleSessionEnter() {},
      bindEvents() {},
      syncComposerPoppers() {},
    });
    assert.throws(() => defaultCoord.render(), /addEventListener|Target container|DOM element/i);
    defaultCoord.dispose();
  } finally {
    globalThis.document = saved.document;
    globalThis.window = saved.window;
    globalThis.requestAnimationFrame = saved.raf;
    globalThis.getComputedStyle = saved.gcs;
    globalThis.HTMLElement = saved.HTMLElement;
  }
});

test('planSessionLoadMerge: dropStaleUncommittedTail 与 rowId 断层整窗替换', () => {
  const existing = [
    { id: 'u1', rowId: 10 },
    { id: 'a1', rowId: 11 },
    { id: 'u-local-tmp', content: 'stale optimistic' },
    { id: 'a-local-tmp', rowId: -1, content: 'partial answer' },
    { id: 'persisted-later', rowId: 99, content: 'already persisted' },
  ];
  const serverWithNew = [
    { id: 'a1', rowId: 11 },
    { id: 'u2', rowId: 12 },
    { id: 'a2', rowId: 13 },
  ];

  // 重连确认非流式时：dropStaleUncommittedTail=true 丢弃旧临时行与未对齐尾部，避免双重气泡
  const dropped = planSessionLoadMerge(serverWithNew, existing, false, { dropStaleUncommittedTail: true });
  assert.deepEqual(
    dropped.map((m) => m.id),
    ['u1', 'a1', 'u2', 'a2'],
  );

  // 未开启 dropStaleUncommittedTail 时：仅保留无权威 rowId 临时行，过滤已有 rowId>0 行
  const kept = planSessionLoadMerge(serverWithNew, existing, false);
  assert.deepEqual(
    kept.map((m) => m.id),
    ['u1', 'a1', 'u2', 'a2', 'u-local-tmp', 'a-local-tmp'],
  );

  // rowId 断层（> lastExisting.rowId + 1）整窗替换为服务端最新窗口
  const existingGap = [
    { id: 'm1', rowId: 1 },
    { id: 'm2', rowId: 2 },
    { id: 'm3', rowId: 3 },
  ];
  const parsedGap = [
    { id: 'm10', rowId: 10 },
    { id: 'm11', rowId: 11 },
  ];
  assert.deepEqual(
    planSessionLoadMerge(parsedGap, existingGap, false).map((m) => m.id),
    ['m10', 'm11'],
  );
  // 紧邻 (+1) 连续时正常追加
  assert.deepEqual(
    planSessionLoadMerge([{ id: 'm4', rowId: 4 }, { id: 'm5', rowId: 5 }], existingGap, false).map((m) => m.id),
    ['m1', 'm2', 'm3', 'm4', 'm5'],
  );
});

test('MessageLoadingService & ProfileManagementService: refreshActiveSession、重连流式对账与 Bot 离线回落', async () => {
  const sessionMessagesCache = new Map();
  const botForeverChatCache = new Map();
  const events = [];
  let streamingStoredId = 'sess-live';
  let resumeBehavior = 'running';

  const state = createInitialState({ platform: 'windows' });
  state.gatewayConnected = true;
  state.activeSessionId = 'sess-live';
  state.activeLiveSessionId = 'live-old';
  state.activeFocus = { type: 'session', sessionId: 'sess-live' };
  state.sessions = [{ id: 'sess-live', title: 'Live', botName: 'default', timestamp: 100 }];
  state.messages = [
    { id: 'm1', rowId: 1, role: 'user', content: 'hi', timestamp: '10:00' },
    { id: 'tmp-stream', role: 'assistant', content: 'half...', timestamp: '10:01' },
  ];
  sessionMessagesCache.set('sess-live', [...state.messages]);

  const svc = createMessageLoadingService({
    getState: () => state,
    getGatewayClient: () => ({
      call: async (method) => {
        if (method === 'session.resume') {
          if (resumeBehavior === 'throw') throw new Error('rpc resume failed');
          if (resumeBehavior === 'running') {
            return { session_id: 'live-new', running: true, inflight: { streaming: true } };
          }
          return { session_id: 'live-done', running: false };
        }
        return {};
      },
      fetchSessionMessages: async () => ({
        status: 'success',
        messages: [
          { id: 'm1', row_id: 1, role: 'user', content: 'hi' },
          { id: 'a1', row_id: 2, role: 'assistant', content: 'final answer' },
        ],
        pagination: { total: 2, returned: 2 },
      }),
    }),
    render: () => { events.push('render'); },
    sessionMessagesCache,
    cacheService: {
      openChannel: async () => ({ rows: [], fenceMax: 0 }),
      readOlderRows: async () => [],
      applyRemoteWindow: async () => {},
    },
    persistMessagesToCache: () => {},
    syncPromptNavigatorMeta: () => {},
    syncPromptNavigatorFromScroll: () => {},
    scrollStreamToBottom: () => {},
    setPendingScrollToBottom: () => {},
    isStreamNearBottom: () => true,
    captureStreamAnchor: () => ({}),
    applyStreamAnchor: () => {},
    getMessageWindowStart: () => 0,
    setMessageWindowStart: () => {},
    getMessageWindowEnd: () => 30,
    setMessageWindowEnd: () => {},
    setMessageWindowUserExpanded: () => {},
    setCanvasStructureDirty: () => {},
    setSuppressPinBottomOnce: () => {},
    isGroupConversationActive: () => false,
    hostedRoomIds: new Set(),
    formatSessionTime: () => '10:00',
    formatTimestamp: () => '10:00',
    botActivityStore: { withActivityMap: (fn) => fn(new Map()), persist: () => {} },
    botForeverChatCache,
    sessionPreviewCache: new Map(),
    persistSessionPreviewCache: () => {},
    getActiveStreamingStoredSessionId: () => streamingStoredId,
    defaultSessionHandleRegistry: { register() {}, toStoredId: (x) => x },
    activeRunningSessionIds: new Set(['sess-live']),
    activityTransitionTracker: { clear() {}, recordCompleted() {} },
  });

  svc.setReconnectHooks({
    onReconnectStillStreaming: (sid, lid) => events.push(['still', sid, lid]),
    onReconnectStreamFinished: (sid) => {
      events.push(['finished', sid]);
      streamingStoredId = null;
    },
    onForceSyncMessageList: (force) => events.push(['forceSync', force]),
  });

  // 1. 重连仍在生成 -> 保持流缓冲并刷新 liveId
  await svc.refreshActiveSession({ forceRefreshAfterReconnect: true });
  assert.deepEqual(events.at(-1), ['still', 'sess-live', 'live-new']);

  // 2. session.resume 抛错 -> 静默保留本地流不崩
  resumeBehavior = 'throw';
  await svc.refreshActiveSession({ forceRefreshAfterReconnect: true });

  // 3. 重连服务端已收口 -> 清理流状态，丢弃 stale 临时气泡，拉取权威结果并 forceSync(true)
  resumeBehavior = 'done';
  await svc.refreshActiveSession({ forceRefreshAfterReconnect: true });
  assert.ok(events.some((e) => Array.isArray(e) && e[0] === 'finished' && e[1] === 'sess-live'));
  assert.ok(events.some((e) => Array.isArray(e) && e[0] === 'forceSync' && e[1] === true));
  assert.deepEqual(
    state.messages.map((m) => m.id),
    ['1', '2'],
  );

  // 非连续 rowId 断层触发 sessionServerOffset.delete(sessionId) 后对齐最新窗口
  streamingStoredId = null;
  state.messages = [{ id: '1', rowId: 1, role: 'user', content: 'old', timestamp: '10:00' }];
  sessionMessagesCache.set('sess-gap', [...state.messages]);
  state.activeSessionId = 'sess-gap';
  state.sessions.push({ id: 'sess-gap', title: 'Gap', botName: 'default', timestamp: 120 });
  svc.sessionServerOffset.set('sess-gap', 1);
  const gapSvc = createMessageLoadingService({
    getState: () => state,
    getGatewayClient: () => ({
      call: async () => ({}),
      fetchSessionMessages: async () => ({
        status: 'success',
        messages: [
          { id: '20', row_id: 20, role: 'user', content: 'latest q' },
          { id: '21', row_id: 21, role: 'assistant', content: 'latest a' },
        ],
        pagination: { total: 21, returned: 2 },
      }),
    }),
    render: () => {},
    sessionMessagesCache,
    cacheService: {
      openChannel: async () => ({ rows: [], fenceMax: 0 }),
      readOlderRows: async () => [],
      applyRemoteWindow: async () => {},
    },
    persistMessagesToCache: () => {},
    syncPromptNavigatorMeta: () => {},
    syncPromptNavigatorFromScroll: () => {},
    scrollStreamToBottom: () => {},
    setPendingScrollToBottom: () => {},
    isStreamNearBottom: () => true,
    captureStreamAnchor: () => ({}),
    applyStreamAnchor: () => {},
    getMessageWindowStart: () => 0,
    setMessageWindowStart: () => {},
    getMessageWindowEnd: () => 30,
    setMessageWindowEnd: () => {},
    setMessageWindowUserExpanded: () => {},
    setCanvasStructureDirty: () => {},
    setSuppressPinBottomOnce: () => {},
    isGroupConversationActive: () => false,
    hostedRoomIds: new Set(),
    formatSessionTime: () => '10:00',
    formatTimestamp: () => '10:00',
    botActivityStore: { withActivityMap: (fn) => fn(new Map()), persist: () => {} },
    botForeverChatCache,
    sessionPreviewCache: new Map(),
    persistSessionPreviewCache: () => {},
    getActiveStreamingStoredSessionId: () => null,
    defaultSessionHandleRegistry: { register() {}, toStoredId: (x) => x },
    activeRunningSessionIds: new Set(),
    activityTransitionTracker: { clear() {}, recordCompleted() {} },
  });
  gapSvc.sessionServerOffset.set('sess-gap', 999);
  await gapSvc.refreshActiveSession({ forceRefreshAfterReconnect: true });
  assert.equal(gapSvc.sessionServerOffset.get('sess-gap'), 2);
  assert.equal(state.hasOlderMessages, true);

  // 无 activeSessionId 时安全跳过
  state.activeSessionId = '';
  await svc.refreshActiveSession();

  // loadMessages 覆盖空 sessionId (!silent)、缓存未命中 (!silent)、bot 焦点解析、以及无网关离线 !silent 渲染
  state.activeFocus = { type: 'bot', botName: 'bot-focus' };
  state.activeSessionId = 'sess-missing';
  await gapSvc.refreshActiveSession();
  state.activeFocus = { type: 'session', sessionId: 'sess-unknown' };
  state.activeSessionId = 'sess-unknown';
  await gapSvc.refreshActiveSession();
  await gapSvc.loadMessages('', { silent: false });
  await gapSvc.loadMessages('sess-uncached', { silent: false });
  await gapSvc.loadMessages('sess-uncached', { silent: false });

  const offlineMls = createMessageLoadingService({
    getState: () => state,
    getGatewayClient: () => null,
    render: () => { events.push('offline-render'); },
    sessionMessagesCache: new Map(),
    cacheService: { openChannel: async () => ({ rows: [], fenceMax: 0 }), readOlderRows: async () => [], applyRemoteWindow: async () => {} },
    persistMessagesToCache: () => {},
    syncPromptNavigatorMeta: () => {},
    syncPromptNavigatorFromScroll: () => {},
    scrollStreamToBottom: () => {},
    setPendingScrollToBottom: () => {},
    isStreamNearBottom: () => true,
    captureStreamAnchor: () => ({}),
    applyStreamAnchor: () => {},
    getMessageWindowStart: () => 0,
    setMessageWindowStart: () => {},
    getMessageWindowEnd: () => 30,
    setMessageWindowEnd: () => {},
    setMessageWindowUserExpanded: () => {},
    setCanvasStructureDirty: () => {},
    setSuppressPinBottomOnce: () => {},
    isGroupConversationActive: () => false,
    hostedRoomIds: new Set(),
    formatSessionTime: () => '10:00',
    formatTimestamp: () => '10:00',
    botActivityStore: { withActivityMap: (fn) => fn(new Map()), persist: () => {} },
    botForeverChatCache,
    sessionPreviewCache: new Map(),
    persistSessionPreviewCache: () => {},
    getActiveStreamingStoredSessionId: () => null,
    defaultSessionHandleRegistry: { register() {}, toStoredId: (x) => x },
    activeRunningSessionIds: new Set(),
    activityTransitionTracker: { clear() {}, recordCompleted() {} },
  });
  await offlineMls.loadMessages('off-1', { silent: false });
  await offlineMls.loadMessages('off-1', { silent: true });

  // ProfileManagementService.openBotChat 离线回落（缓存未命中时找本地 forever chat，或清空 activeSessionId）
  const selected = [];
  const pState = createInitialState({ platform: 'windows' });
  pState.gatewayConnected = false;
  pState.activeSessionId = 'old-sess';
  pState.activeFocus = { type: 'session', sessionId: 'old-sess' };
  pState.sessions = [{ id: 'hidden-bot-1', hidden: true, botName: 'bot-a' }];
  pState.messages = [{ id: 'm1', role: 'user', content: 'prev', timestamp: '' }];

  const pSvc = createProfileManagementService({
    getState: () => pState,
    getGatewayClient: () => null,
    render: () => {},
    t: (k) => k,
    describeRpcError: (e) => String(e),
    botActivityStore: { updateLatestActivity() {}, withActivityMap: (fn) => fn(new Map()) },
    unreadBotNames: new Set(),
    activityTransitionTracker: { clear() {} },
    sessionMessagesCache: new Map(),
    syncProfileLastMessages() {},
    applyColdStartFocus: async () => {},
    cancelColdStartFocus() {},
    fetchSessions: async () => {},
    fetchModelOptions: async () => {},
    selectSession: async (id) => selected.push(id),
    openGroupRoom: async () => {},
    restoreComposerFocus() {},
    disarmRollbackOnLeave() {},
    persistAgentsToCache() {},
    persistAvatarCache() {},
    profileAvatarCache: new Map(),
    botForeverChatCache: new Map(),
    nextLoadMessagesGeneration: () => 1,
    getCurrentLoadMessagesGeneration: () => 1,
    logSession() {},
  });

  await pSvc.openBotChat('');
  await pSvc.openBotChat('bot-a');
  assert.deepEqual(selected, ['hidden-bot-1']);

  pState.sessions = [];
  pState.activeSessionId = 'prev-sess';
  pState.messages = [{ id: 'm1', role: 'user', content: 'prev', timestamp: '' }];
  await pSvc.openBotChat('bot-b');
  pState.activeSessionId = '';
  pState.messages = [];
  await pSvc.openBotChat('bot-c');
  assert.equal(pState.activeSessionId, '');
  assert.equal(pState.messagesPhase, 'ready');
});

test('GatewayEventDispatcher & TitlebarController: 冷启动退避、鉴权终止、醒来探活、syncHooks 与 Titlebar connectionStatus', async () => {
  setLocale('zh-CN');
  const savedWs = globalThis.WebSocket;
  const sockets = [];
  class MockWebSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 0; // CONNECTING
      this.sent = [];
      sockets.push(this);
    }
    send(data) {
      this.sent.push(JSON.parse(data));
    }
    close(code = 1000, reason = '') {
      this.readyState = 3;
      this.onclose?.({ code, reason });
    }
  }
  MockWebSocket.CONNECTING = 0;
  MockWebSocket.OPEN = 1;
  MockWebSocket.CLOSING = 2;
  MockWebSocket.CLOSED = 3;
  globalThis.WebSocket = MockWebSocket;

  let dispatcher;
  try {
    const state = createInitialState({ platform: 'windows' });
    state.gatewayUrl = 'https://gw.example';
    let client = null;
    let ticket = undefined;
    let authResult = { ok: false, latency: 5, message: 'network timeout' };
    const syncTriggers = [];
    let resumeSyncCalls = 0;
    const watchdogCalls = [];
    const activeRunning = new Set(['s-live']);
    let streamCtx = {
      activeStreamingMessageId: 'msg-1',
      activeStreamingStoredSessionId: 's-live',
      activeStreamingLiveId: 'l-old',
      activeStreamingBotName: 'default',
    };

    dispatcher = createGatewayEventDispatcher({
      getState: () => state,
      getGatewayClient: () => client,
      setGatewayClient: (c) => { client = c; },
      getCurrentTicket: () => ticket,
      setCurrentTicket: (tk) => { ticket = tk; },
      getDesktopApi: () => undefined,
      getEffectiveUrl: (u) => (u || '').trim(),
      testConnection: async () => authResult,
      completeEntityTurn() {},
      getSessionHandleRegistry: () => ({ clear() {}, toStoredId: (x) => x }),
      getSessionMessagesCache: () => new Map(),
      getTokenCoalescer: () => ({ push() {}, flush() {}, clear() {} }),
      getActivityTransitionTracker: () => ({ clear() {}, clearAll() {}, recordCompleted() {} }),
      getBotActivityStore: () => ({ withActivityMap: (fn) => fn(new Map()), persist() {} }),
      getCacheService: () => ({}),
      getActiveRunningSessionIds: () => activeRunning,
      getUnreadSessionIds: () => new Set(),
      getActiveRunningBotNames: () => new Set(),
      getUnreadBotNames: () => new Set(),
      getActiveRunningGroupRoomIds: () => new Set(),
      getUnreadGroupRoomIds: () => new Set(),
      getActiveStreamingContext: () => streamCtx,
      setActiveStreamingContext: (patch) => { streamCtx = { ...streamCtx, ...patch }; },
      getTurnStartedSessionId: () => null,
      setTurnStartedSessionId() {},
      stopProfileAutoRefresh() {},
      startProfileAutoRefresh() {},
      stopAllGroupPollers() {},
      clearTransitionRefreshTimer() {},
      clearSessionsRefreshTimer() {},
      scheduleSessionsRefresh() {},
      persistTurnToCache() {},
      persistSessionsToCache() {},
      syncProfileLastMessages() {},
      syncAgentPresence() {},
      scheduleToolPatch() {},
      clearToolPatchQueue() {},
      stopRunningToolTimers() {},
      setMessageContent() {},
      toStoredSessionId: (x) => x,
      applyColdStartFocus: async () => {},
      fetchProfiles: async () => {},
      fetchSessions: async () => {},
      fetchGroupRooms: async () => {},
      fetchModelOptions: async () => {},
      fetchProjects: async () => {},
      prefetchSlashCatalog: async () => {},
      armTurnWatchdog: () => watchdogCalls.push('arm'),
      disarmTurnWatchdog: () => watchdogCalls.push('disarm'),
      clearPresenceTerminal() {},
      armPresenceTerminal() {},
      setTimedDockNotice() {},
      isStreamNearBottom: () => true,
      setPendingScrollToBottom() {},
      render() {},
      t: (k, p) => t(k, p),
    });

    dispatcher.setSyncHooks({
      onConnectedSync: (tr) => {
        syncTriggers.push(tr);
        state.connectionPhase = 'connected';
      },
      onResumeAliveSync: () => { resumeSyncCalls += 1; },
    });

    // 1. 认证失败 (401) 停止重试，进入 offline + connectionAuthError=true
    authResult = { ok: false, latency: 2, message: '401 Unauthorized' };
    await dispatcher.connect();
    assert.equal(state.connectionPhase, 'offline');
    assert.equal(state.connectionAuthError, true);
    assert.equal(await dispatcher.wakeOrRetry('focus'), 'disconnected');

    // 2. markNetworkOffline + retryNow 清理错误并发起真实连接
    state.connectionAuthError = false;
    state.manualDisconnected = false;
    dispatcher.markNetworkOffline();
    assert.equal(state.connectionPhase, 'reconnecting');

    // 临时断网安排退避重试（再由 retryNow 立即接管）
    authResult = { ok: false, latency: 5, message: 'ECONNREFUSED' };
    await dispatcher.connect();
    assert.equal(state.connectionPhase, 'reconnecting');
    assert.equal(state.connectionReconnectAttempt, 1);

    authResult = { ok: true, latency: 5, ticket: 'tk-ok' };
    await dispatcher.retryNow();
    assert.ok(sockets.length >= 1);
    const ws = sockets[sockets.length - 1];
    ws.readyState = MockWebSocket.OPEN;
    ws.onopen?.();
    // 响应握手 ping -> CONNECTED
    const pingFrame = ws.sent.find((f) => f.method === 'ping');
    assert.ok(pingFrame);
    ws.onmessage?.({ data: JSON.stringify({ jsonrpc: '2.0', id: pingFrame.id, result: { ok: true } }) });
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(state.gatewayConnected, true);
    assert.deepEqual(syncTriggers, ['connected']);

    // 3. TitlebarController connectionStatus 校验
    const tb = createTitlebarController({
      getState: () => state,
      render() {},
      getDesktopApi: () => undefined,
      t: (k) => t(k),
    });
    assert.equal(tb.getTitlebarSnapshot().connectionStatus, 'connected');
    state.connectionPhase = 'syncing';
    assert.equal(tb.getTitlebarSnapshot().connectionStatus, 'syncing');
    state.connectionPhase = 'reconnecting';
    assert.equal(tb.getTitlebarSnapshot().connectionStatus, 'reconnecting');
    state.gatewayConnected = false;
    state.connectionPhase = 'offline';
    assert.equal(tb.getTitlebarSnapshot().connectionStatus, 'offline');
    state.gatewayConnected = true;
    state.connectionPhase = 'connected';

    // 4. wakeOrRetry 在 CONNECTED 下发送 ping 并触发 onResumeAliveSync
    const wakePromise = dispatcher.wakeOrRetry('mobile-resume');
    const wakePing = ws.sent.filter((f) => f.method === 'ping').at(-1);
    ws.onmessage?.({ data: JSON.stringify({ jsonrpc: '2.0', id: wakePing.id, result: { ok: true } }) });
    assert.equal(await wakePromise, 'alive');
    assert.equal(resumeSyncCalls, 1);

    // 5. 重连期流式恢复与收口句柄
    dispatcher.resumeReconnectStreaming('s-live', 'l-new');
    assert.equal(streamCtx.activeStreamingLiveId, 'l-new');
    assert.ok(watchdogCalls.includes('arm'));

    state.isStreaming = true;
    dispatcher.finishReconnectStreaming('s-live');
    assert.equal(state.isStreaming, false);
    assert.equal(streamCtx.activeStreamingStoredSessionId, null);
    assert.equal(activeRunning.has('s-live'), false);

    // 6. disconnect() 强制清空并置 manualDisconnected = true，空 URL 时 disconnect 归位 unconfigured
    dispatcher.disconnect();
    assert.equal(state.manualDisconnected, true);
    assert.equal(state.connectionPhase, 'offline');
    state.gatewayUrl = '';
    dispatcher.markNetworkOffline();
    dispatcher.disconnect();
    assert.equal(state.connectionPhase, 'unconfigured');
    await dispatcher.connect();
    assert.equal(state.connectionPhase, 'unconfigured');
  } finally {
    dispatcher?.disconnect();
    globalThis.WebSocket = savedWs;
  }
});

test('GatewayEventDispatcher: 无 syncHooks 回退、冷启动 1s 自动重试定时器、重连 401 终止与异常兜底', async () => {
  const savedWs = globalThis.WebSocket;
  const sockets = [];
  class MockWebSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.sent = [];
      sockets.push(this);
    }
    send(data) {
      this.sent.push(JSON.parse(data));
    }
    close(code = 1000, reason = '') {
      this.readyState = 3;
      this.onclose?.({ code, reason });
    }
  }
  MockWebSocket.CONNECTING = 0;
  MockWebSocket.OPEN = 1;
  MockWebSocket.CLOSING = 2;
  MockWebSocket.CLOSED = 3;
  globalThis.WebSocket = MockWebSocket;

  let dispatcher;
  try {
    const state = createInitialState({ platform: 'windows' });
    state.gatewayUrl = 'https://gw.example';
    let client = null;
    let ticket = undefined;
    let connectAttempt = 0;
    let statusConnCalls = 0;
    let statusDiscCalls = 0;
    let fallbackResumeSync = 0;
    let clearedHandles = 0;

    dispatcher = createGatewayEventDispatcher({
      getState: () => state,
      getGatewayClient: () => client,
      setGatewayClient: (c) => { client = c; },
      getCurrentTicket: () => ticket,
      setCurrentTicket: (tk) => { ticket = tk; },
      getDesktopApi: () => undefined,
      getEffectiveUrl: (u) => (u || '').trim(),
      testConnection: async () => {
        connectAttempt += 1;
        if (connectAttempt === 1) throw new Error('boom transient');
        if (connectAttempt === 2) return { ok: true, latency: 4, ticket: 'tk-1' };
        if (connectAttempt === 3) return { ok: true, latency: 4, ticket: 'tk-2' };
        return { ok: false, latency: 4, message: '401 invalid credentials' };
      },
      completeEntityTurn() {},
      getSessionHandleRegistry: () => ({ clear() { clearedHandles += 1; }, toStoredId: (x) => x }),
      getSessionMessagesCache: () => new Map(),
      getTokenCoalescer: () => ({ push() {}, flush() {}, clear() {} }),
      getActivityTransitionTracker: () => ({ clear() {}, clearAll() {}, recordCompleted() {} }),
      getBotActivityStore: () => ({ withActivityMap: (fn) => fn(new Map()), persist() {} }),
      getCacheService: () => ({}),
      getActiveRunningSessionIds: () => new Set(),
      getUnreadSessionIds: () => new Set(),
      getActiveRunningBotNames: () => new Set(),
      getUnreadBotNames: () => new Set(),
      getActiveRunningGroupRoomIds: () => new Set(),
      getUnreadGroupRoomIds: () => new Set(),
      getActiveStreamingContext: () => ({ activeStreamingMessageId: null, activeStreamingStoredSessionId: null, activeStreamingLiveId: null, activeStreamingBotName: null }),
      setActiveStreamingContext() {},
      getTurnStartedSessionId: () => null,
      setTurnStartedSessionId() {},
      stopProfileAutoRefresh() {},
      startProfileAutoRefresh() {},
      stopAllGroupPollers() {},
      clearTransitionRefreshTimer() {},
      clearSessionsRefreshTimer() {},
      scheduleSessionsRefresh() {},
      persistTurnToCache() {},
      persistSessionsToCache() {},
      syncProfileLastMessages() {},
      syncAgentPresence() {},
      scheduleToolPatch() {},
      stopRunningToolTimers() {},
      setMessageContent() {},
      toStoredSessionId: (x) => x,
      applyColdStartFocus: async () => {},
      fetchProfiles: async () => {},
      fetchSessions: async () => {},
      fetchGroupRooms: async () => {},
      fetchModelOptions: async () => {},
      fetchProjects: async () => {},
      prefetchSlashCatalog: async () => {},
      armTurnWatchdog() {},
      disarmTurnWatchdog() {},
      clearPresenceTerminal() {},
      armPresenceTerminal() {},
      setTimedDockNotice() {},
      render() {},
      t: (k, p) => t(k, p),
      onResumeAliveSync: () => { fallbackResumeSync += 1; },
      onStatusConnected: () => { statusConnCalls += 1; },
      onStatusDisconnected: () => { statusDiscCalls += 1; },
    });

    // 1. 第 1 次抛出 Error('boom transient') 进入 catch 兜底并启动 1000ms 重试定时器自动拉起第 2 次成功
    await dispatcher.connect();
    assert.equal(state.connectionPhase, 'reconnecting');
    await new Promise((r) => setTimeout(r, 1150));
    assert.ok(sockets.length >= 1, '冷启动 1s 重试定时器必须自动重跑 connect()');

    const ws1 = sockets[0];
    ws1.readyState = MockWebSocket.OPEN;
    ws1.onopen?.();
    const ping1 = ws1.sent.find((f) => f.method === 'ping');
    ws1.onmessage?.({ data: JSON.stringify({ jsonrpc: '2.0', id: ping1.id, result: { ok: true } }) });
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(state.connectionPhase, 'connected');
    assert.equal(statusConnCalls, 1);

    // 2. deps.onResumeAliveSync 回退路径
    const wakeP = dispatcher.wakeOrRetry('focus');
    const wakePing = ws1.sent.filter((f) => f.method === 'ping').at(-1);
    ws1.onmessage?.({ data: JSON.stringify({ jsonrpc: '2.0', id: wakePing.id, result: { ok: true } }) });
    assert.equal(await wakeP, 'alive');
    assert.equal(fallbackResumeSync, 1);

    // 3. 在 syncing 相位发生异常断连：Phase 切回 reconnecting，清空 live 句柄并通知 onStatusDisconnected
    state.connectionPhase = 'syncing';
    state.activeLiveSessionId = 'live-tmp';
    const discBeforeDrop = statusDiscCalls;
    ws1.close(1006, 'drop');
    assert.equal(state.connectionPhase, 'reconnecting');
    assert.equal(state.activeLiveSessionId, '');
    assert.ok(clearedHandles >= 1);
    assert.equal(statusDiscCalls - discBeforeDrop, 1);

    // 等待自动重连 resolveUrl 执行第 3 次 authenticate (ok=true, tk-2) 并建立 ws2
    for (let i = 0; i < 60 && sockets.length < 2; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(sockets.length >= 2, '自动重连必须发起第 2 条 WebSocket');
    const ws2 = sockets[1];
    ws2.readyState = MockWebSocket.OPEN;
    ws2.onopen?.();
    const ping2 = ws2.sent.find((f) => f.method === 'ping');
    assert.ok(ping2);
    ws2.onmessage?.({ data: JSON.stringify({ jsonrpc: '2.0', id: ping2.id, result: { ok: true } }) });
    await new Promise((r) => setTimeout(r, 15));

    // 4. 再次断线，第 4 次 authenticate 返回 401 -> connectionAuthError=true + client.disconnect()
    ws2.close(1006, 'drop2');
    for (let i = 0; i < 80 && !state.connectionAuthError; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(state.connectionAuthError, true);
    assert.equal(state.connectionPhase, 'offline');
  } finally {
    dispatcher?.disconnect();
    globalThis.WebSocket = savedWs;
  }
});

test('GatewayEventDispatcher & 边缘分支补充：空错误兜底、冷启动定时器取消提前退出、同相幂等与 DOM 缺失回退', async () => {
  setLocale('zh-CN');
  const savedWs = globalThis.WebSocket;
  const sockets = [];
  class MockWebSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.sent = [];
      sockets.push(this);
    }
    send(data) {
      this.sent.push(JSON.parse(data));
    }
    close(code = 1000, reason = '') {
      this.readyState = 3;
      this.onclose?.({ code, reason });
    }
  }
  MockWebSocket.CONNECTING = 0;
  MockWebSocket.OPEN = 1;
  MockWebSocket.CLOSING = 2;
  MockWebSocket.CLOSED = 3;
  globalThis.WebSocket = MockWebSocket;

  let dispatcher;
  try {
    const state = createInitialState({ platform: 'windows' });
    state.gatewayUrl = 'https://gw.example';
    let client = null;
    let ticket = undefined;
    let mode = 'empty-error';

    dispatcher = createGatewayEventDispatcher({
      getState: () => state,
      getGatewayClient: () => client,
      setGatewayClient: (c) => { client = c; },
      getCurrentTicket: () => ticket,
      setCurrentTicket: (tk) => { ticket = tk; },
      getDesktopApi: () => undefined,
      getEffectiveUrl: (u) => (u || '').trim(),
      testConnection: async () => {
        if (mode === 'empty-error') throw new Error('');
        return { ok: true, latency: 2, ticket: 'tk-dup' };
      },
      completeEntityTurn() {},
      getSessionHandleRegistry: () => ({ clear() {}, toStoredId: (x) => x }),
      getSessionMessagesCache: () => new Map(),
      getTokenCoalescer: () => ({ push() {}, flush() {}, clear() {} }),
      getActivityTransitionTracker: () => ({ clear() {}, clearAll() {}, recordCompleted() {} }),
      getBotActivityStore: () => ({ withActivityMap: (fn) => fn(new Map()), persist() {} }),
      getCacheService: () => ({}),
      getActiveRunningSessionIds: () => new Set(),
      getUnreadSessionIds: () => new Set(),
      getActiveRunningBotNames: () => new Set(),
      getUnreadBotNames: () => new Set(),
      getActiveRunningGroupRoomIds: () => new Set(),
      getUnreadGroupRoomIds: () => new Set(),
      getActiveStreamingContext: () => ({ activeStreamingMessageId: null, activeStreamingStoredSessionId: null, activeStreamingLiveId: null, activeStreamingBotName: null }),
      setActiveStreamingContext() {},
      getTurnStartedSessionId: () => null,
      setTurnStartedSessionId() {},
      stopProfileAutoRefresh() {},
      startProfileAutoRefresh() {},
      stopAllGroupPollers() {},
      clearTransitionRefreshTimer() {},
      clearSessionsRefreshTimer() {},
      scheduleSessionsRefresh() {},
      persistTurnToCache() {},
      persistSessionsToCache() {},
      syncProfileLastMessages() {},
      syncAgentPresence() {},
      scheduleToolPatch() {},
      stopRunningToolTimers() {},
      setMessageContent() {},
      toStoredSessionId: (x) => x,
      applyColdStartFocus: async () => {},
      fetchProfiles: async () => {},
      fetchSessions: async () => {},
      fetchGroupRooms: async () => {},
      fetchModelOptions: async () => {},
      fetchProjects: async () => {},
      prefetchSlashCatalog: async () => {},
      armTurnWatchdog() {},
      disarmTurnWatchdog() {},
      clearPresenceTerminal() {},
      armPresenceTerminal() {},
      setTimedDockNotice() {},
      render() {},
      t: (k, p) => t(k, p),
    });

    // 1. 空消息 Error('') 触发 chat.networkError 兜底文案，并随后在冷启动重试定时器触发前标记 manualDisconnected 提前退出
    await dispatcher.connect();
    assert.equal(state.connectionReason, t('chat.networkError'));
    state.manualDisconnected = true;
    await new Promise((r) => setTimeout(r, 1150));
    assert.equal(sockets.length, 0, 'manualDisconnected=true 时定时器触发不得新建连接');

    // 2. wasConnected=true & isConnected=true & !phaseOrAttemptChanged -> 跳过状态覆写分支
    state.manualDisconnected = false;
    mode = 'ok';
    await dispatcher.connect();
    const ws = sockets[0];
    assert.ok(ws);
    ws.readyState = MockWebSocket.OPEN;
    ws.onopen?.();
    const pingFrame = ws.sent.find((f) => f.method === 'ping');
    state.gatewayConnected = true;
    state.connectionPhase = 'connected';
    state.connectionReconnectAttempt = 0;
    ws.onmessage?.({ data: JSON.stringify({ jsonrpc: '2.0', id: pingFrame.id, result: { ok: true } }) });
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(state.connectionPhase, 'connected');
  } finally {
    dispatcher?.disconnect();
    globalThis.WebSocket = savedWs;
  }
});

test('RenderCoordinator & 缓存日志与离线 Bot 查找补充边界', async () => {
  const saved = {
    document: globalThis.document,
    window: globalThis.window,
    raf: globalThis.requestAnimationFrame,
    gcs: globalThis.getComputedStyle,
    HTMLElement: globalThis.HTMLElement,
  };

  function makeEl(id, tagName = 'DIV') {
    const attrs = new Map();
    const el = {
      id,
      tagName,
      nodeType: 1,
      className: '',
      innerHTML: '',
      children: [],
      style: { setProperty() {}, getPropertyValue: () => '', removeProperty() {} },
      dataset: {},
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      isConnected: true,
      parentNode: null,
      setAttribute(k, v) { attrs.set(k, String(v)); },
      getAttribute(k) { return attrs.get(k) ?? null; },
      removeAttribute(k) { attrs.delete(k); },
      appendChild(child) {
        child.parentNode = el;
        el.children.push(child);
        if (child.id) elements.set(child.id, child);
        return child;
      },
      insertAdjacentHTML() {},
      querySelector(sel) {
        if (sel === '.flux-body-container') return bodyContainer;
        if (sel === '.flux-middle-pod') return middlePod;
        return null;
      },
      querySelectorAll() { return []; },
      getBoundingClientRect: () => ({ top: 0, bottom: 100, left: 0, right: 400, width: 400, height: 100 }),
    };
    return el;
  }

  let bodyContainer = null;
  let middlePod = null;
  const rootEl = makeEl('flux-app-root');
  const elements = new Map([['flux-app-root', rootEl]]);
  globalThis.document = {
    activeElement: null,
    getElementById: (id) => elements.get(id) ?? null,
    querySelector: (sel) => (sel === '.flux-middle-pod' ? middlePod : null),
    querySelectorAll: () => [],
    createElement: (tag) => makeEl('', tag.toUpperCase()),
    addEventListener() {},
    removeEventListener() {},
    documentElement: makeEl('html', 'HTML'),
    body: makeEl('body', 'BODY'),
    head: makeEl('head', 'HEAD'),
  };
  globalThis.window = {
    addEventListener() {},
    removeEventListener() {},
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  };
  globalThis.requestAnimationFrame = () => 1;
  globalThis.getComputedStyle = () => ({ paddingBottom: '0px', getPropertyValue: () => '' });
  globalThis.HTMLElement = class {};

  try {
    const state = createInitialState({ platform: 'windows' });
    state.gatewayConnected = false;
    state.connectionPhase = 'connected';
    state.activeSessionId = 's1';
    state.messages = [{ id: 'm1', rowId: 1, role: 'user', content: 'hi', timestamp: '10:00' }];

    const coord = createRenderCoordinator({
      getState: () => state,
      messageWindowManager: {
        ensureMessageWindow() {},
        getMessageWindowStart: () => 0,
        getMessageWindowEnd: () => 50,
        getAverageRowHeightPx: () => 60,
        computeContentOffsetPx: () => 0,
        computeVirtualHeightPx: () => 300,
        markProgrammaticScroll() {},
        syncScrollTopToWindow() {},
        observeVirtualWindowGeometry() {},
        scheduleVirtualHeightSync() {},
      },
      modalInteractionController: {
        renderContextMenuHtml: () => '',
        renderConfirmModalHtml: () => '',
        updateModals() {},
      },
      isStreamingActiveForCurrentSession: () => false,
      resolveSessionKnownFiles: () => [],
      getTitlebarSnapshot: () => ({}),
      getLeftRailSnapshot: () => ({}),
      createLeftRailActions: () => ({}),
      getPromptNavigatorSnapshot: () => ({}),
      createPromptNavigatorActions: () => ({}),
      rebuildPromptEntries() {},
      syncPromptNavigatorMeta() {},
      syncPromptNavigator() {},
      syncReactSettings() {},
      ensureSettingsSectionData() {},
      syncAgentPresenceHost() {},
      syncAgentPresence() {},
      captureStreamAnchor: () => ({}),
      applyStreamAnchor() {},
      stabilizeStreamAnchor() {},
      isStreamNearBottom: () => true,
      syncStreamBottomInset() {},
      settleInitialBottom() {},
      isSessionEnterPending: () => false,
      settleSessionEnter() {},
      bindEvents() {},
      syncComposerPoppers() {},
      mountConnectionPill: () => ({ update() {}, unmount() {} }),
    });

    // 1. !connectionPillHandle && !isVisible 早退 (renderCoordinator.ts:308)
    coord.render();

    // 2. isVisible=true 但既无 #react-conv-connection-host 也无 .flux-middle-pod (renderCoordinator.ts:314)
    state.connectionPhase = 'reconnecting';
    coord.render();

    // 3. incremental 路径下 preserveShell=true 且 messages=[] + messagesPhase='loading' (renderCoordinator.ts:1231)
    bodyContainer = makeEl('body-container');
    elements.set('conversation-stream', makeEl('conversation-stream'));
    state.messages = [];
    state.messagesPhase = 'loading';
    coord.render();
    coord.dispose();

    // 4. MessageLoadingService cache-hit + logSession.debug (messageLoadingService.ts:357)
    const msgCache = new Map([['sess-cached', [{ id: 'c1', rowId: 1, role: 'user', content: 'cached', timestamp: '10:00' }]]]);
    const debugLogs = [];
    const cacheSvc = createMessageLoadingService({
      getState: () => state,
      getGatewayClient: () => null,
      render() {},
      sessionMessagesCache: msgCache,
      cacheService: {
        openChannel: async () => ({ rows: [], fenceMax: 0 }),
        readOlderRows: async () => [],
        applyRemoteWindow: async () => {},
      },
      persistMessagesToCache() {},
      syncPromptNavigatorMeta() {},
      syncPromptNavigatorFromScroll() {},
      scrollStreamToBottom() {},
      setPendingScrollToBottom() {},
      isStreamNearBottom: () => true,
      captureStreamAnchor: () => ({}),
      applyStreamAnchor() {},
      getMessageWindowStart: () => 0,
      setMessageWindowStart() {},
      getMessageWindowEnd: () => 30,
      setMessageWindowEnd() {},
      setMessageWindowUserExpanded() {},
      setCanvasStructureDirty() {},
      setSuppressPinBottomOnce() {},
      isGroupConversationActive: () => false,
      hostedRoomIds: new Set(),
      formatSessionTime: () => '10:00',
      formatTimestamp: () => '10:00',
      botActivityStore: { withActivityMap: (fn) => fn(new Map()), persist() {} },
      botForeverChatCache: new Map(),
      sessionPreviewCache: new Map(),
      persistSessionPreviewCache() {},
      getActiveStreamingStoredSessionId: () => null,
      defaultSessionHandleRegistry: { register() {}, toStoredId: (x) => x },
      activeRunningSessionIds: new Set(),
      activityTransitionTracker: { clear() {}, recordCompleted() {} },
      logSession: { debug: (msg) => debugLogs.push(msg), info() {}, warn() {} },
    });
    await cacheSvc.loadMessages('sess-cached', { silent: false });
    assert.ok(debugLogs.some((m) => m.includes('cached') || m.includes('cache')));

    // 5. ProfileManagementService.openBotChat 离线遍历包含不匹配 hidden/botName 项、非空 outgoingSessionId + 空 messages 与 cached 命中
    const selected = [];
    const pState = createInitialState({ platform: 'windows' });
    pState.gatewayConnected = false;
    pState.activeSessionId = 'prev-empty';
    pState.messages = [];
    pState.sessions = [
      { id: 'vis', hidden: false, botName: 'bot-b' },
      { id: 'other-hidden', hidden: true, botName: 'bot-x' },
    ];
    let activeClient = null;
    const botCache = new Map([['bot-cached', 'forever-cached-1']]);
    const pSvc = createProfileManagementService({
      getState: () => pState,
      getGatewayClient: () => activeClient,
      render() {},
      t: (k) => k,
      describeRpcError: (e) => String(e),
      botActivityStore: { updateLatestActivity() {}, withActivityMap: (fn) => fn(new Map()) },
      unreadBotNames: new Set(),
      activityTransitionTracker: { clear() {} },
      sessionMessagesCache: new Map(),
      syncProfileLastMessages() {},
      applyColdStartFocus: async () => {},
      cancelColdStartFocus() {},
      fetchSessions: async () => {},
      fetchModelOptions: async () => {},
      selectSession: async (id) => selected.push(id),
      openGroupRoom: async () => {},
      restoreComposerFocus() {},
      disarmRollbackOnLeave() {},
      persistAgentsToCache() {},
      persistAvatarCache() {},
      profileAvatarCache: new Map(),
      botForeverChatCache: botCache,
      nextLoadMessagesGeneration: () => 1,
      getCurrentLoadMessagesGeneration: () => 1,
      logSession() {},
    });
    await pSvc.openBotChat('bot-b');
    await pSvc.openBotChat('bot-cached');
    activeClient = {
      request: async () => ({ sessions: [{ id: 'fc-online-1', title: 'Bot Chat', created_at: 1000 }] }),
    };
    await pSvc.openBotChat('bot-online');
    assert.deepEqual(selected, ['forever-cached-1', 'fc-online-1']);
  } finally {
    globalThis.document = saved.document;
    globalThis.window = saved.window;
    globalThis.requestAnimationFrame = saved.raf;
    globalThis.getComputedStyle = saved.gcs;
    globalThis.HTMLElement = saved.HTMLElement;
  }
});

test('双审加固回归：群聊空台保活、末尾未落盘乐观行断层重锚与冷启动认证竞态守卫', async () => {
  setLocale('zh-CN');

  // 1. Group Room 在 activeSessionId='' 且 messages=[] 时断连必须保留舞台
  const gBase = createInitialState({ platform: 'windows' });
  assert.equal(
    shouldPreserveConversationShell({
      ...gBase,
      gatewayConnected: false,
      connectionPhase: 'reconnecting',
      activeSessionId: '',
      activeFocus: { type: 'group', roomId: 'room-42' },
      messages: [],
    }),
    true,
  );
  assert.equal(
    shouldPreserveConversationShell({
      ...gBase,
      gatewayConnected: false,
      connectionPhase: 'reconnecting',
      activeSessionId: '',
      activeFocus: { type: 'group', roomId: '' },
      messages: [],
    }),
    false,
  );

  // 2. 末尾带无 rowId 乐观/系统行的断层合并与紧邻 (+1) trim/保留，以及全无 rowId 回退
  const localWithTail = [
    { id: 'u1', rowId: 1, role: 'user', content: 'q1', timestamp: '10:00' },
    { id: 'a1', rowId: 2, role: 'assistant', content: 'a1', timestamp: '10:01' },
    { id: 'tmp-tail', role: 'user', content: 'pending offline', timestamp: '10:02' },
  ];
  assert.deepEqual(
    planSessionLoadMerge(
      [
        { id: 'u3', rowId: 3, role: 'user', content: 'q3', timestamp: '10:03' },
        { id: 'a3', rowId: 4, role: 'assistant', content: 'a3', timestamp: '10:04' },
      ],
      localWithTail,
      false,
      { dropStaleUncommittedTail: true },
    ).map((m) => m.id),
    ['u1', 'a1', 'u3', 'a3'],
  );
  assert.deepEqual(
    planSessionLoadMerge(
      [
        { id: 'u3', rowId: 3, role: 'user', content: 'q3', timestamp: '10:03' },
        { id: 'a3', rowId: 4, role: 'assistant', content: 'a3', timestamp: '10:04' },
      ],
      localWithTail,
      false,
      { dropStaleUncommittedTail: false },
    ).map((m) => m.id),
    ['u1', 'a1', 'tmp-tail', 'u3', 'a3'],
  );
  assert.deepEqual(
    planSessionLoadMerge(
      [
        { id: 'u60', rowId: 60, role: 'user', content: 'q60', timestamp: '10:50' },
        { id: 'a60', rowId: 61, role: 'assistant', content: 'a60', timestamp: '10:51' },
      ],
      localWithTail,
      false,
    ).map((m) => m.id),
    ['u60', 'a60'],
  );
  assert.deepEqual(
    planSessionLoadMerge(
      [{ id: 'p1', role: 'user', content: 'n1', timestamp: '10:00' }],
      [
        { id: 'x1', role: 'user', content: 'o1', timestamp: '10:00' },
        { id: 'x2', role: 'assistant', content: 'o2', timestamp: '10:01' },
      ],
      false,
    ).map((m) => m.id),
    ['x1', 'x2'],
  );

  const sessionMessagesCache = new Map([['sess-tail-gap', [...localWithTail]]]);
  const msgState = createInitialState({ platform: 'windows' });
  msgState.gatewayConnected = true;
  msgState.activeSessionId = 'sess-tail-gap';
  msgState.activeFocus = { type: 'session', sessionId: 'sess-tail-gap' };
  msgState.sessions = [{ id: 'sess-tail-gap', title: 'Tail', botName: 'default', timestamp: 100 }];
  msgState.messages = [...localWithTail];

  const tailGapSvc = createMessageLoadingService({
    getState: () => msgState,
    getGatewayClient: () => ({
      call: async () => ({}),
      fetchSessionMessages: async () => ({
        status: 'success',
        messages: [
          { id: 'u60', row_id: 60, role: 'user', content: 'q60' },
          { id: 'a60', row_id: 61, role: 'assistant', content: 'a60' },
        ],
        pagination: { total: 61, returned: 2 },
      }),
    }),
    render() {},
    sessionMessagesCache,
    cacheService: {
      openChannel: async () => ({ rows: [], fenceMax: 0 }),
      readOlderRows: async () => [],
      applyRemoteWindow: async () => {},
    },
    persistMessagesToCache() {},
    syncPromptNavigatorMeta() {},
    syncPromptNavigatorFromScroll() {},
    scrollStreamToBottom() {},
    setPendingScrollToBottom() {},
    isStreamNearBottom: () => true,
    captureStreamAnchor: () => ({}),
    applyStreamAnchor() {},
    getMessageWindowStart: () => 0,
    setMessageWindowStart() {},
    getMessageWindowEnd: () => 30,
    setMessageWindowEnd() {},
    setMessageWindowUserExpanded() {},
    setCanvasStructureDirty() {},
    setSuppressPinBottomOnce() {},
    isGroupConversationActive: () => false,
    hostedRoomIds: new Set(),
    formatSessionTime: () => '10:00',
    formatTimestamp: () => '10:00',
    botActivityStore: { withActivityMap: (fn) => fn(new Map()), persist() {} },
    botForeverChatCache: new Map(),
    sessionPreviewCache: new Map(),
    persistSessionPreviewCache() {},
    getActiveStreamingStoredSessionId: () => null,
    defaultSessionHandleRegistry: { register() {}, toStoredId: (x) => x },
    activeRunningSessionIds: new Set(),
    activityTransitionTracker: { clear() {}, recordCompleted() {} },
  });
  tailGapSvc.sessionServerOffset.set('sess-tail-gap', 888);
  await tailGapSvc.refreshActiveSession({ forceRefreshAfterReconnect: true });
  assert.equal(tailGapSvc.sessionServerOffset.get('sess-tail-gap'), 2);
  assert.equal(msgState.hasOlderMessages, true);

  // 3. GatewayEventDispatcher: 冷启动 testConnection 在途时 wakeOrRetry 保护 + 卡死 >8s 重启后迟到 catch 丢弃
  const savedWs = globalThis.WebSocket;
  const savedNow = Date.now;
  let nowOffset = 0;
  Date.now = () => savedNow() + nowOffset;
  const sockets = [];
  class MockWebSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.sent = [];
      sockets.push(this);
    }
    send(data) { this.sent.push(JSON.parse(data)); }
    close(code = 1000, reason = '') { this.readyState = 3; this.onclose?.({ code, reason }); }
  }
  MockWebSocket.CONNECTING = 0;
  MockWebSocket.OPEN = 1;
  MockWebSocket.CLOSING = 2;
  MockWebSocket.CLOSED = 3;
  globalThis.WebSocket = MockWebSocket;

  let dispatcher;
  try {
    const dState = createInitialState({ platform: 'windows' });
    dState.gatewayUrl = 'https://gw.example';
    let client = null;
    let ticket;
    let authCalls = 0;
    const pendingAuths = [];

    dispatcher = createGatewayEventDispatcher({
      getState: () => dState,
      getGatewayClient: () => client,
      setGatewayClient: (c) => { client = c; },
      getCurrentTicket: () => ticket,
      setCurrentTicket: (tk) => { ticket = tk; },
      getDesktopApi: () => undefined,
      getEffectiveUrl: (u) => (u || '').trim(),
      testConnection: () =>
        new Promise((resolve, reject) => {
          authCalls += 1;
          pendingAuths.push({ resolve, reject });
        }),
      completeEntityTurn() {},
      getSessionHandleRegistry: () => ({ clear() {}, toStoredId: (x) => x }),
      getSessionMessagesCache: () => new Map(),
      getTokenCoalescer: () => ({ push() {}, flush() {}, clear() {} }),
      getActivityTransitionTracker: () => ({ clear() {}, clearAll() {}, recordCompleted() {} }),
      getBotActivityStore: () => ({ withActivityMap: (fn) => fn(new Map()), persist() {} }),
      getCacheService: () => ({}),
      getActiveRunningSessionIds: () => new Set(),
      getUnreadSessionIds: () => new Set(),
      getActiveRunningBotNames: () => new Set(),
      getUnreadBotNames: () => new Set(),
      getActiveRunningGroupRoomIds: () => new Set(),
      getUnreadGroupRoomIds: () => new Set(),
      getActiveStreamingContext: () => ({
        activeStreamingMessageId: null,
        activeStreamingStoredSessionId: null,
        activeStreamingLiveId: null,
        activeStreamingBotName: null,
      }),
      setActiveStreamingContext() {},
      getTurnStartedSessionId: () => null,
      setTurnStartedSessionId() {},
      stopProfileAutoRefresh() {},
      startProfileAutoRefresh() {},
      stopAllGroupPollers() {},
      clearTransitionRefreshTimer() {},
      clearSessionsRefreshTimer() {},
      scheduleSessionsRefresh() {},
      persistTurnToCache() {},
      persistSessionsToCache() {},
      syncProfileLastMessages() {},
      syncAgentPresence() {},
      scheduleToolPatch() {},
      stopRunningToolTimers() {},
      setMessageContent() {},
      toStoredSessionId: (x) => x,
      applyColdStartFocus: async () => {},
      fetchProfiles: async () => {},
      fetchSessions: async () => {},
      fetchGroupRooms: async () => {},
      fetchModelOptions: async () => {},
      fetchProjects: async () => {},
      prefetchSlashCatalog: async () => {},
      armTurnWatchdog() {},
      disarmTurnWatchdog() {},
      clearPresenceTerminal() {},
      armPresenceTerminal() {},
      setTimedDockNotice() {},
      render() {},
      t: (k, p) => t(k, p),
    });

    const p1 = dispatcher.connect();
    assert.equal(dState.connectionPhase, 'connecting');
    // 8s 内的 focus 唤醒不得打断正在进行的首跳鉴权
    assert.equal(await dispatcher.wakeOrRetry('focus'), 'reconnecting');
    assert.equal(authCalls, 1, '在途鉴权未超时前严禁被 wakeOrRetry 截断');
    assert.equal(dState.connectionPhase, 'connecting');

    // 卡死超过 8s 后唤醒必须接管并开启第 2 轮连接；第 1 轮迟到 reject 不得污染新连接
    nowOffset = 9_000;
    assert.equal(await dispatcher.wakeOrRetry('online'), 'reconnecting');
    assert.equal(authCalls, 2);

    pendingAuths[0].reject(new Error('stale auth timeout'));
    await p1;
    assert.equal(dState.testStatus, undefined, '过期 epoch 的 catch 拒絶不得覆写 testStatus');

    // disconnect() 后即使距上一轮未满 8s，retryNow() 也必须立刻发起新认证而非卡死在 offline
    nowOffset = 9_200;
    dispatcher.disconnect();
    assert.equal(dState.connectionPhase, 'offline');
    await dispatcher.retryNow();
    assert.equal(authCalls, 3, 'disconnect() 后 retryNow() 必须立即重启连接');

    // 未断连但首跳慢认证在途（<8s），用户手动触发 retryNow() 也必须立刻抢占重启
    nowOffset = 9_300;
    await dispatcher.retryNow();
    assert.equal(authCalls, 4, 'manual-retry 即使在 8s 窗口内也必须允许用户主动抢占重连');

    pendingAuths[1].reject(new Error('stale after disconnect'));
    pendingAuths[2].reject(new Error('superseded by manual retry'));
    pendingAuths[3].resolve({ ok: true, latency: 3, ticket: 'tk-fresh' });
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(dState.testStatus?.ok, true);
  } finally {
    Date.now = savedNow;
    dispatcher?.disconnect();
    globalThis.WebSocket = savedWs;
  }
});
