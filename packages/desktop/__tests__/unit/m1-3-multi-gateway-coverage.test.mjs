/**
 * M1.3 多网关全分支与抽取协调器单测补完
 * (packages/desktop/__tests__/unit/m1-3-multi-gateway-coverage.test.mjs)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ActivityTransitionTracker,
  CacheService,
  InteractiveService,
  LiveStreamRegistry,
  MemoryCacheStore,
  SessionHandleRegistry,
  SessionListGeneration,
} from '@hermes-flux/core';
import { createInitialState } from '../../dist/renderer/state/appState.mjs';
import {
  IndexWriteQueue,
  persistMultiGatewayAgentsToCache,
  persistMultiGatewayGroupsToCache,
  persistMultiGatewaySessionsToCache,
  restoreMultiGatewayCacheSnapshot,
} from '../../dist/renderer/cache/desktopCacheBridge.mjs';
import {
  createActiveGatewayRpcCaller,
  createAppBootstrapGatewayHandlers,
  createColdStartFocusRunner,
  createDesktopMultiGatewayWiring,
  createModelCatalogFetcher,
  createMultiGatewayCoordinator,
  getConfiguredGatewayIds,
  renderToolPatchForMessage,
  resolveFocusedGatewayId,
  resolveGatewayScopedStoredSessionId,
  resolveMessageSessionIdAcrossRegistries,
} from '../../dist/renderer/gateway/multiGatewayCoordinator.mjs';
import { GATEWAY_REGISTRY_STORAGE_KEY } from '../../dist/renderer/gateway/gatewayRegistryStore.mjs';
import {
  createGatewayEventDispatcher,
  isFocusedOnBot,
  isFocusedOnEntity,
  isSameActiveGateway,
  resolveBotNameForSession,
} from '../../dist/renderer/gateway/gatewayEventDispatcher.mjs';
import { createConversationStreamController } from '../../dist/renderer/events/conversationStreamController.mjs';
import { createConversationOrgCoordinator } from '../../dist/renderer/services/conversationOrgCoordinator.mjs';
import { MessageLoadingService } from '../../dist/renderer/services/messageLoadingService.mjs';
import { createProfileManagementService } from '../../dist/renderer/services/profileManagementService.mjs';
import { SessionOperationService } from '../../dist/renderer/services/sessionOperationService.mjs';
import { createTurnExecutionService } from '../../dist/renderer/services/turnExecutionService.mjs';
import { createSessionDeliverableCoordinator } from '../../dist/renderer/services/mediaResolver.mjs';
import { flushMicrotasks } from './helpers/gatewayDispatcherHarness.mjs';

function createMemoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
  };
}

test('M1.3 desktopCacheBridge multi-gateway groups, extra gateway buckets, and fallback snapshot', async () => {
  const store = new MemoryCacheStore();
  const cache = new CacheService(store, { sessionCap: 50, messageCap: 200 });
  const queue = new IndexWriteQueue();

  // Unknown third gatewayId not in gatewayIds triggers byGw.get(targetGw) ?? [] branch
  persistMultiGatewaySessionsToCache(
    [
      { id: 's-1', title: 'S1', botName: 'a', gatewayId: 'gw-extra', timestamp: 1, time: '1', preview: '' },
      { id: 's-2', title: 'S2', botName: 'b', timestamp: 2, time: '2', preview: '' },
    ],
    cache,
    'default',
    queue,
    ['', 'gw-a', 'gw-b'],
    2,
  );
  persistMultiGatewayAgentsToCache(
    [
      { name: 'coder', gatewayId: 'gw-extra' },
      { name: 'default' },
    ],
    cache,
    ['', 'gw-a', 'gw-b'],
    2,
  );
  persistMultiGatewayGroupsToCache(
    [{ roomId: 'r-1', name: 'Room 1', members: ['coder'], createdAt: 1, updatedAt: 2 }],
    cache,
    queue,
    2,
  );
  persistMultiGatewayGroupsToCache(
    [{ roomId: 'r-single', name: 'Single Room', members: ['default'], createdAt: 1, updatedAt: 2 }],
    cache,
    queue,
    1,
  );
  await flushMicrotasks();

  let fallbackCalls = 0;
  const singleWithFallback = await restoreMultiGatewayCacheSnapshot(cache, ['gw-a'], async () => {
    fallbackCalls += 1;
    return [
      [{ id: 'fb', kind: 'session', gatewayId: 'default', profile: 'default', title: 'FB', botName: 'default', timestamp: 1 }],
      [{ name: 'fb-agent', hasAvatar: false }],
      { a: 'data:image/png;base64,AA==' },
    ];
  });
  assert.equal(fallbackCalls, 1);
  assert.equal(singleWithFallback.sessions[0].id, 'fb');

  const singleNoFallback = await restoreMultiGatewayCacheSnapshot(cache, ['gw-a']);
  assert.equal(Array.isArray(singleNoFallback.sessions), true);
});

test('M1.3 multiGatewayCoordinator extracted renderer helpers, fallbacks, and bootstrap handlers', async () => {
  const origLsDesc = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const ls = createMemoryStorage({
    [GATEWAY_REGISTRY_STORAGE_KEY]: JSON.stringify([
      { id: 'gw-a', name: 'A', url: 'http://127.0.0.1:8651' },
      { id: 'gw-b', name: 'B', url: 'http://127.0.0.1:8652' },
    ]),
    hermes_flux_profile: 'coder',
  });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: ls });
  try {
    assert.deepEqual(getConfiguredGatewayIds(), ['gw-a', 'gw-b']);

    const state = createInitialState({ platform: 'win32' });
    state.gatewayCount = 2;
    state.gatewayConnected = true;
    state.profilesPhase = 'ready';
    state.activeGatewayId = 'gw-a';
    state.activeFocus = { type: 'session', sessionId: 's1' };
    state.gatewayUrl = '';

    assert.equal(resolveFocusedGatewayId(state), 'gw-a');
    assert.equal(resolveFocusedGatewayId({ activeGatewayId: 'gw-z', activeFocus: null }), 'gw-z');

    // createColdStartFocusRunner branches
    const picked = [];
    const cold = createColdStartFocusRunner({
      getState: () => state,
      resolveActiveClient: () => null,
      getEffectiveUrl: (u) => u,
      selectSession: async (id, opts) => { picked.push({ kind: 'session', id, opts }); },
      openBotChat: async (bot, gw) => { picked.push({ kind: 'bot', bot, gw }); },
    });
    await cold.applyColdStartFocus();
    assert.equal(picked.length, 0);

    // activeClient present, no targets -> none
    let clientReady = { call: async () => ({}) };
    const cold2 = createColdStartFocusRunner({
      getState: () => state,
      resolveActiveClient: () => clientReady,
      getEffectiveUrl: (u) => u,
      selectSession: async (id, opts) => { picked.push({ kind: 'session', id, opts }); },
      openBotChat: async (bot, gw) => { picked.push({ kind: 'bot', bot, gw }); },
    });
    await cold2.applyColdStartFocus();
    assert.equal(picked.length, 0);

    // Group focus early return & profilesPhase skeleton early return
    state.activeFocus = { type: 'group', roomId: 'r1' };
    await cold2.applyColdStartFocus();
    state.activeFocus = { type: 'session', sessionId: 's1' };
    state.profilesPhase = 'loading';
    await cold2.applyColdStartFocus();
    state.profilesPhase = 'ready';

    // Session fallback branch (matched with & without gatewayId)
    state.sessions = [{ id: 's-cold', title: 'Cold', gatewayId: 'gw-b', timestamp: 1, time: '1', preview: '' }];
    await cold2.applyColdStartFocus();
    assert.deepEqual(picked.pop(), { kind: 'session', id: 's-cold', opts: { gatewayId: 'gw-b' } });

    // Already applied guard + bot branch without localStorage match
    await cold2.applyColdStartFocus();
    assert.equal(picked.length, 0);

    ls.removeItem('hermes_flux_profile');
    const stateNoGw = { ...state, profileName: 'helper', profiles: [{ name: 'helper', gatewayId: 'gw-b' }], sessions: [{ id: 's2', title: 'S2', timestamp: 1, time: '1', preview: '' }] };
    const coldBot = createColdStartFocusRunner({
      getState: () => stateNoGw,
      resolveActiveClient: () => clientReady,
      getEffectiveUrl: (u) => u,
      selectSession: async (id, opts) => { picked.push({ kind: 'session', id, opts }); },
      openBotChat: async (bot, gw) => { picked.push({ kind: 'bot', bot, gw }); },
      getStorageItem: () => null,
    });
    await coldBot.applyColdStartFocus();
    assert.deepEqual(picked.pop(), { kind: 'bot', bot: 'helper', gw: 'gw-b' });

    const coldSessionPlain = createColdStartFocusRunner({
      getState: () => ({ ...state, profiles: [], profileName: 'default', sessions: [{ id: 's-plain', title: 'P', timestamp: 1, time: '1', preview: '' }] }),
      resolveActiveClient: () => clientReady,
      getEffectiveUrl: (u) => u,
      selectSession: async (id, opts) => { picked.push({ kind: 'session', id, opts }); },
      openBotChat: async (bot, gw) => { picked.push({ kind: 'bot', bot, gw }); },
      getStorageItem: () => null,
    });
    await coldSessionPlain.applyColdStartFocus();
    assert.deepEqual(picked.pop(), { kind: 'session', id: 's-plain', opts: undefined });
    coldSessionPlain.cancelColdStartFocus();
    await coldSessionPlain.applyColdStartFocus();

    // createModelCatalogFetcher all branches
    let renders = 0;
    let catalogMode = 'fail-no-err';
    const fakeClient = {
      async getModelCatalog(prof) {
        if (catalogMode === 'fail-no-err') return { ok: false, error: '' };
        if (catalogMode === 'ok-current') return { ok: true, models: ['m1'], details: [], entries: [], currentProvider: 'p1', currentModel: 'm1' };
        return { ok: true, models: ['m-fallback'], details: [], entries: [], currentProvider: `p-${prof}`, currentModel: '' };
      },
    };
    let activeForCatalog = null;
    const fetchModels = createModelCatalogFetcher({
      getState: () => state,
      resolveActiveClient: () => activeForCatalog,
      render: () => { renders += 1; },
      t: (k) => k,
    });
    await fetchModels();
    assert.equal(state.dockNotice, 'chat.gatewayNotConnected');

    activeForCatalog = fakeClient;
    await fetchModels();
    assert.equal(state.dockNotice, 'chat.gatewayNotConnected');

    catalogMode = 'ok-current';
    await fetchModels({ clearNotice: true });
    assert.equal(state.selectedModel, 'm1');
    assert.equal(state.dockNotice, '');

    catalogMode = 'ok-fallback';
    state.selectedModel = '';
    state.dockNotice = 'keep-me';
    await fetchModels({ clearNotice: false });
    assert.equal(state.selectedModel, 'm-fallback');
    assert.equal(state.dockNotice, 'keep-me');
    assert.ok(renders >= 4);

    // requestActiveGatewayRpc & createActiveGatewayRpcCaller
    const rpcDisconnected = createActiveGatewayRpcCaller(() => null);
    await assert.rejects(() => rpcDisconnected.request('ping'), /Gateway client not connected/);
    const rpcConnected = createActiveGatewayRpcCaller(() => ({ call: async (m) => ({ m }) }));
    assert.deepEqual(await rpcConnected.request('ping'), { m: 'ping' });

    // resolveGatewayScopedStoredSessionId, resolveMessageSessionIdAcrossRegistries, renderToolPatchForMessage
    const hRegA = new SessionHandleRegistry();
    hRegA.register({ storedId: 'st-1', liveId: 'lv-1' });
    const lRegA = new LiveStreamRegistry();
    lRegA.registerStream({ storedSessionId: 'st-1', liveSessionId: 'lv-1', messageId: 'msg-reg', origin: 'local' });
    const lFallback = new LiveStreamRegistry();
    lFallback.registerStream({ storedSessionId: 'st-fb', liveSessionId: 'lv-fb', messageId: 'msg-fb', origin: 'local' });

    const coordMock = {
      getHandleRegistry: () => hRegA,
      getLiveStreamRegistry: (gw) => (gw === 'gw-a' ? lRegA : undefined),
    };
    assert.equal(resolveGatewayScopedStoredSessionId({ id: '', state, coordinator: coordMock, activeStreamingLiveId: null, activeStreamingStoredSessionId: null }), null);
    state.sessions = [
      { id: 'st-1', gatewayId: 'gw-a', title: '1', timestamp: 1, time: '1', preview: '' },
      { id: 'st-b', gatewayId: 'gw-b', title: 'b', timestamp: 1, time: '1', preview: '' },
    ];
    assert.equal(resolveGatewayScopedStoredSessionId({ id: 'lv-1', state, coordinator: coordMock, activeStreamingLiveId: null, activeStreamingStoredSessionId: null }), 'st-1');
    assert.equal(resolveGatewayScopedStoredSessionId({ id: 'lv-stream', state, coordinator: coordMock, activeStreamingLiveId: 'lv-stream', activeStreamingStoredSessionId: 'st-stream' }), 'st-stream');
    state.activeLiveSessionId = 'lv-state';
    state.activeSessionId = 'st-state';
    assert.equal(resolveGatewayScopedStoredSessionId({ id: 'lv-state', state, coordinator: coordMock, activeStreamingLiveId: null, activeStreamingStoredSessionId: null }), 'st-state');
    assert.equal(resolveGatewayScopedStoredSessionId({ id: 'raw-id', state: { ...state, gatewayCount: undefined }, coordinator: coordMock, activeStreamingLiveId: null, activeStreamingStoredSessionId: null }), 'raw-id');

    assert.equal(resolveMessageSessionIdAcrossRegistries('msg-reg', state, coordMock, lFallback), 'st-1');
    state.activeFocus = { type: 'session', sessionId: 'x', gatewayId: 'gw-missing' };
    assert.equal(resolveMessageSessionIdAcrossRegistries('msg-fb', state, coordMock, lFallback), 'st-fb');

    const msgCache = new Map([['gw-a::st-cache', [{ id: 'tool-m', role: 'assistant', content: '', timestamp: '1' }]]]);
    state.activeFocus = { type: 'session', sessionId: 'st-cache', gatewayId: 'gw-a' };
    state.messages = [];
    assert.equal(renderToolPatchForMessage('tool-m', state, 'st-cache', msgCache, () => '<div>tool</div>'), '<div>tool</div>');
    assert.equal(renderToolPatchForMessage('missing', state, null, msgCache, () => '<div>tool</div>'), '');

    // Coordinator fallbacks (omitted fallback registries + null runtime client + refreshAllSlotsIfMulti)
    const runtimeStub = {
      getSlot: () => undefined,
      getClient: () => null,
      getHealthSummary: () => ({ totalCount: 0, connectedCount: 0, allConnected: false, anyConnected: false, slots: [] }),
      buildAggregatedView: () => ({
        health: { totalCount: 0, connectedCount: 0, allConnected: false, anyConnected: false, slots: [] },
        profiles: [],
        sessions: [],
        groupRooms: [],
      }),
      syncGateways: () => {},
      connectAll: async () => {},
      reconnectGateway: async () => false,
      disconnectGateway: () => false,
      getSnapshot: () => new Map(),
      onEvent: () => () => {},
    };
    const fallbackClient = { call: async () => ({}) };
    const bareCoord = createMultiGatewayCoordinator({
      runtime: runtimeStub,
      getState: () => ({ ...state, gatewayCount: 1 }),
      render: () => {},
      getFallbackClient: () => fallbackClient,
    });
    assert.ok(bareCoord.getHandleRegistry());
    assert.equal(bareCoord.getLiveStreamRegistry(), undefined);
    assert.equal(bareCoord.resolveActiveClient(fallbackClient), fallbackClient);
    assert.equal(bareCoord.getActiveGatewayUrl('http://fallback'), 'http://fallback');
    assert.ok(bareCoord.getActiveHandleRegistry());
    assert.equal(await bareCoord.refreshAllSlotsIfMulti(), false);
    assert.equal(await bareCoord.refreshAllSlotsIfMulti(() => true), true);

    // createDesktopMultiGatewayWiring omitted onManageGateways, onHealthChange/bootstrap with null client, and omitted getFallbackPassword
    const stateObj = { activeFocus: { type: 'session', sessionId: '' }, activeGatewayId: '', gatewayConnected: false, gatewayCount: 0, gatewayHealthSummary: undefined, activeEntityGatewayOffline: false, profiles: [], sessions: [], groupRooms: [], gatewayUrl: 'http://127.0.0.1:1', password: 'pw' };
    const wiringWithPw = createDesktopMultiGatewayWiring({
      getState: () => stateObj,
      getDesktopApi: () => undefined,
      onPrimaryClientChange: () => {},
      render: () => {},
    });
    wiringWithPw.coordinator.onManageGateways?.();
    await wiringWithPw.bootstrap();
    wiringWithPw.runtime.dispose();

    // Test AppBootstrapGatewayHandlers in both modes
    let multiCfg = true;
    const calls = [];
    const handlers = createAppBootstrapGatewayHandlers({
      multiGateway: {
        isMultiGatewayConfigured: () => multiCfg,
        bootstrap: async () => { calls.push('mg-boot'); },
        wakeAllSlots: async () => { calls.push('mg-wake'); },
      },
      connectLegacy: () => { calls.push('legacy-conn'); },
      wakeLegacy: async () => { calls.push('legacy-wake'); return 'reconnected'; },
      syncOnConnected: () => { calls.push('sync-conn'); },
      syncOnResumeAlive: () => { calls.push('sync-alive'); },
    });
    handlers.connect();
    await flushMicrotasks();
    assert.equal(await handlers.onWakeOrRetry('focus'), 'alive');
    await handlers.onSettingsConnect();
    handlers.bootstrapPostInit();
    multiCfg = false;
    handlers.connect();
    assert.equal(await handlers.onWakeOrRetry('focus'), 'reconnected');
    await handlers.onSettingsConnect();
    handlers.bootstrapPostInit();
    await flushMicrotasks();
    assert.deepEqual(calls, ['mg-boot', 'sync-conn', 'mg-wake', 'sync-alive', 'mg-boot', 'legacy-conn', 'legacy-wake', 'legacy-conn', 'mg-boot']);
  } finally {
    if (origLsDesc) Object.defineProperty(globalThis, 'localStorage', origLsDesc);
    else delete globalThis.localStorage;
  }
});

test('M1.3 liveStreamCoordinator, GatewayEventDispatcher & conversationStreamController remaining branches', async () => {
  const st = createInitialState({ platform: 'win32' });
  st.gatewayCount = undefined;
  st.activeGatewayId = 'gw-b';
  st.activeSessionId = 's1';
  st.activeFocus = { type: 'session', sessionId: 's1' };
  assert.equal(isSameActiveGateway(st, 'gw-b'), true);
  assert.equal(isSameActiveGateway({ ...st, gatewayCount: 2, activeFocus: { type: 'session', sessionId: 's1' } }, 'gw-b'), true);
  assert.equal(isSameActiveGateway({ ...st, gatewayCount: 2, activeGatewayId: undefined, activeFocus: { type: 'session', sessionId: 's1' } }, 'gw-b'), true);
  assert.equal(isFocusedOnEntity(st, 's1', 'gw-b'), true);
  assert.equal(isFocusedOnEntity({ ...st, gatewayCount: 2 }, 's1', 'gw-b'), true);

  st.activeFocus = { type: 'bot', botName: 'coder' };
  assert.equal(isFocusedOnBot({ ...st, gatewayCount: 2 }, 'coder', 'gw-b'), true);
  assert.equal(resolveBotNameForSession('fc-1', new Map([['gw-b:coder', 'fc-1']]), { ...st, gatewayCount: 2 }), 'coder');
  assert.equal(resolveBotNameForSession('fc-1', new Map([['gw-b:coder', 'fc-1']]), { ...st, gatewayCount: undefined }), 'coder');
  assert.equal(
    resolveBotNameForSession(
      'fc-miss',
      new Map([['gw-b:coder', 'fc-miss'], ['gw-c:second', 'fc-miss']]),
      { activeFocus: { type: 'session', sessionId: 'other' }, activeSessionId: 'other', activeGatewayId: 'gw-a', gatewayCount: 2 },
    ),
    'coder',
  );

  // GatewayEventDispatcher projects.changed when focusMatchesSource === true + applyTurnActions default gateway + finishReconnectStreaming branches
  const hA = new SessionHandleRegistry();
  const rA = new LiveStreamRegistry();
  let projectFetches = 0;
  let ctx = { activeStreamingMessageId: 'm1', activeStreamingStoredSessionId: 's1', activeStreamingLiveId: 'l1', activeStreamingBotName: null };
  st.gatewayCount = 2;
  st.activeGatewayId = '';
  st.activeFocus = { type: 'session', sessionId: 's1' };
  const dispatcher = createGatewayEventDispatcher({
    getState: () => st,
    getGatewayClient: () => null,
    setGatewayClient: () => {},
    getCurrentTicket: () => undefined,
    setCurrentTicket: () => {},
    getDesktopApi: () => undefined,
    getEffectiveUrl: (u) => u || '',
    testConnection: async () => ({ ok: true, message: '', latency: 1 }),
    completeEntityTurn: () => {},
    getSessionHandleRegistry: () => hA,
    getSessionMessagesCache: () => new Map(),
    getTokenCoalescer: () => ({ push: () => {}, flush: () => {}, clear: () => {}, dropMessage: () => {} }),
    getActivityTransitionTracker: () => new ActivityTransitionTracker({ windowMs: 850 }),
    getBotActivityStore: () => ({ updateLatestActivity: () => {} }),
    getCacheService: () => ({}),
    getActiveRunningSessionIds: () => new Set(),
    getUnreadSessionIds: () => new Set(),
    getActiveRunningBotNames: () => new Set(),
    getUnreadBotNames: () => new Set(),
    getActiveRunningGroupRoomIds: () => new Set(),
    getUnreadGroupRoomIds: () => new Set(),
    getActiveStreamingContext: () => ctx,
    setActiveStreamingContext: (p) => { ctx = { ...ctx, ...p }; },
    getTurnStartedSessionId: () => null,
    setTurnStartedSessionId: () => {},
    stopProfileAutoRefresh: () => {},
    startProfileAutoRefresh: () => {},
    stopAllGroupPollers: () => {},
    clearTransitionRefreshTimer: () => {},
    clearSessionsRefreshTimer: () => {},
    scheduleSessionsRefresh: () => {},
    persistTurnToCache: () => {},
    persistSessionsToCache: () => {},
    syncProfileLastMessages: () => {},
    syncAgentPresence: () => {},
    scheduleToolPatch: () => {},
    clearToolPatchQueue: () => {},
    stopRunningToolTimers: () => {},
    setMessageContent: () => {},
    toStoredSessionId: (id) => id,
    applyColdStartFocus: async () => {},
    fetchProfiles: async () => {},
    fetchSessions: async () => {},
    fetchGroupRooms: async () => {},
    fetchModelOptions: async () => {},
    fetchProjects: async () => { projectFetches += 1; },
    prefetchSlashCatalog: async () => {},
    armTurnWatchdog: () => {},
    feedTurnWatchdog: () => {},
    disarmTurnWatchdog: () => {},
    clearPresenceTerminal: () => {},
    armPresenceTerminal: () => {},
    setTimedDockNotice: () => {},
    render: () => {},
    t: (k) => k,
  });
  dispatcher.handleGatewayEvent({ type: 'projects.changed' }, 'gw-b');
  assert.equal(projectFetches, 1);

  // finishReconnectStreaming when focused && activeStreamingStoredSessionId does NOT match vs matches
  st.activeFocus = { type: 'session', sessionId: 's-other', gatewayId: 'gw-a' };
  st.activeSessionId = 's-other';
  dispatcher.finishReconnectStreaming('s-other', 'gw-a');
  assert.equal(ctx.activeStreamingStoredSessionId, 's1');
  dispatcher.finishReconnectStreaming('s1', 'gw-b');
  assert.equal(ctx.activeStreamingStoredSessionId, 's1');

  // conversationStreamController rollback updates scoped sessionMessagesCache
  const streamMsgs = [
    { id: 'u1', rowId: 10, role: 'user', content: 'rollback me', timestamp: '10:00' },
    { id: 'a1', rowId: 11, role: 'assistant', content: 'reply', timestamp: '10:01' },
  ];
  const scState = createInitialState({ platform: 'win32' });
  scState.gatewayCount = 2;
  scState.activeGatewayId = 'gw-b';
  scState.activeSessionId = 'sess-rb';
  scState.activeFocus = { type: 'session', sessionId: 'sess-rb', gatewayId: 'gw-b' };
  scState.messages = [...streamMsgs];
  const scCache = new Map();
  const sc = createConversationStreamController({
    getState: () => scState,
    render: () => {},
    safeCopyText: async () => true,
    setTimedDockNotice: () => {},
    isStreamingActiveForCurrentSession: () => false,
    t: (k) => k,
    getGatewayClient: () => null,
    getRpcCaller: () => ({ request: async () => ({}) }),
    getInteractiveService: () => new InteractiveService(),
    selectSession: async () => {},
    scheduleSessionsRefresh: () => {},
    getSessionMessagesCache: () => scCache,
    handleOpenFilePreview: async () => {},
    syncPromptNavigatorFromScroll: () => {},
    loadOlderMessages: async () => {},
    relocateMessageWindowToIndex: () => false,
    syncScrollTopToWindow: () => {},
    slideMessageWindowForward: () => {},
    expandMessageWindow: () => false,
    settleInitialBottom: () => {},
    scrollStreamToBottom: () => {},
    scheduleStreamBottomInset: () => {},
    layoutSignature: () => '',
    ensureLiveSessionId: async () => '',
    getMessageWindowStart: () => 0,
    getMessageWindowEnd: () => 10,
    isMessageWindowUserExpanded: () => false,
    setMessageWindowUserExpanded: () => {},
    getAverageRowHeightPx: () => 40,
    isInitialBottomSettling: () => false,
    setInitialBottomSettling: () => {},
    getStreamScrollCooldown: () => false,
    setStreamScrollCooldown: () => {},
    getLastStreamScrollTop: () => 0,
    setLastStreamScrollTop: () => {},
    getProgrammaticScrollTarget: () => null,
    setProgrammaticScrollTarget: () => {},
    getProgrammaticScrollIgnoreUntil: () => 0,
    getLayoutDriftUntil: () => 0,
    getReaderScrolledSessionId: () => '',
    setReaderScrolledSessionId: () => {},
    setSettledLayoutSignature: () => {},
    STICK_TO_BOTTOM_THRESHOLD_PX: 80,
    MESSAGE_WINDOW_CAPACITY: 100,
  });
  sc.handleRollbackMessage({
    getAttribute: (name) => (name === 'data-msg-id' ? 'u1' : name === 'data-row-id' ? '10' : null),
    closest: () => null,
  });
  assert.ok(scCache.has('gw-b::sess-rb'));
  void rA;
});

test('M1.3 services coverage: conversationOrg, profileManagement, messageLoading, sessionOperation, turnExecution', async () => {
  // 1. conversationOrgCoordinator uncovered branches
  const orgState = createInitialState({ platform: 'win32' });
  orgState.gatewayCount = 2;
  orgState.sessions = [
    { id: 's-org', gatewayId: 'gw-a', title: 'Other', timestamp: 1, time: '1', preview: '' },
    { id: 's-flag', isArchived: true, gatewayId: 'gw-b', title: 'Flagged', timestamp: 1, time: '1', preview: '' },
  ];
  orgState.archivedSessions = [{ id: 's-arch-no-meta', title: 'Arch', timestamp: 1, time: '1', preview: '' }];
  orgState.orgDoneRooms = { 'room-done': { updatedAt: 10 } };
  const archivedCalls = [];
  const rpcCalls = [];
  const orgCoord = createConversationOrgCoordinator({
    getState: () => orgState,
    getGatewayClient: () => ({
      request: async (m, p) => { rpcCalls.push({ m, p }); return { ok: true }; },
      call: async (m, p) => { rpcCalls.push({ m, p }); return { ok: true }; },
    }),
    render: () => {},
    t: (k) => k,
    showToast: () => {},
    restoreComposerFocus: () => {},
    describeRpcError: (e) => String(e),
    setSessionArchived: async (id, arch, prof, gw) => { archivedCalls.push({ id, arch, prof, gw }); return true; },
    isForeverChatSession: () => false,
    fetchArchivedSessions: async () => {},
    openNewChatInContainer: () => {},
  });
  await orgCoord.markDoneConfirmed('session', 's-org', undefined, 'gw-a');
  await orgCoord.restoreDone('session', 's-arch-no-meta', undefined, 'gw-a');
  orgCoord.autoReopenIfDone('session', 's-flag', undefined, 'gw-b');
  orgCoord.autoReopenIfDone('session', 's-flag', undefined, 'gw-a'); // mismatch -> noop
  orgCoord.autoReopenIfDone('group', 'room-done', undefined, 'gw-b');
  await orgCoord.moveEntityToFolder('session', 's-org', 'folder-1');
  const groupCtx = orgCoord.getMoveEntityContext('group', 'room-done');
  const sessCtx = orgCoord.getMoveEntityContext('session', 's-org', undefined, 'gw-a');
  assert.ok(groupCtx && sessCtx);
  assert.equal(archivedCalls.some((c) => c.id === 's-org' && c.arch === true && c.gw === 'gw-a'), true);
  assert.equal(archivedCalls.some((c) => c.id === 's-arch-no-meta' && c.arch === false && c.gw === 'gw-a'), true);

  // 2. profileManagementService uncovered branches
  const profState = createInitialState({ platform: 'win32' });
  profState.gatewayCount = 1;
  profState.profiles = [];
  let pClient = null;
  let avatarCallIdx = 0;
  let listMode = 'forever';
  const profClientA = {
    async listProfiles() { return [{ name: 'bot1', hasAvatar: true }]; },
    async request(m) {
      if (m === 'profiles.get_asset') {
        avatarCallIdx += 1;
        return avatarCallIdx === 1 ? { data: 'ZmFrZQ==' } : { data: 'data:image/png;base64,ZmFrZQ==' };
      }
      if (m === 'session.list') {
        return listMode === 'forever' ? { sessions: [{ id: 'fc-1', title: 'Bot Chat' }] } : { sessions: [] };
      }
      return {};
    },
    async call(m, p) { return this.request(m, p); },
    async fetchSessionMessages() {
      return { status: 'success', messages: [{ id: 1, parts: [{ type: 'text', text: 'forever hi' }], created_at: 1700000000 }] };
    },
  };
  const profSvc = createProfileManagementService({
    getState: () => profState,
    getGatewayClient: () => pClient,
    getClientForGateway: (gw) => (gw === 'gw-null' ? null : profClientA),
    render: () => {},
    t: (k) => k,
    describeRpcError: (e) => String(e),
    botActivityStore: { updateLatestActivity: () => {} },
    unreadBotNames: new Set(),
    activityTransitionTracker: new ActivityTransitionTracker({ windowMs: 850 }),
    sessionMessagesCache: new Map(),
    syncProfileLastMessages: () => {},
    applyColdStartFocus: async () => {},
    cancelColdStartFocus: () => {},
    fetchSessions: async () => {},
    fetchModelOptions: async () => {},
    selectSession: async () => {},
    openGroupRoom: async () => {},
    restoreComposerFocus: () => {},
    disarmRollbackOnLeave: () => {},
    persistAgentsToCache: () => {},
    persistAvatarCache: () => {},
    nextLoadMessagesGeneration: () => 1,
    getCurrentLoadMessagesGeneration: () => 1,
  });
  await profSvc.fetchProfiles(); // no client & not multi-gw -> early return (131)
  pClient = profClientA;
  await profSvc.fetchProfiles();
  await profSvc.fetchProfiles({ refresh: true }); // unchanged -> early return (159)
  profState.profiles = [{ name: 'bot1', gatewayId: 'gw-null', hasAvatar: true }];
  await profSvc.fetchProfiles({ refresh: true }); // topology changed (gatewayId) -> fetches again
  // Overlapping generation cancellation in single-gw & multi-gw
  let resolveSlowList;
  const slowClient = {
    ...profClientA,
    listProfiles: () => new Promise((r) => { resolveSlowList = () => r([{ name: 'slow' }]); }),
  };
  pClient = slowClient;
  const slowPromise = profSvc.fetchProfiles();
  pClient = profClientA;
  await profSvc.fetchProfiles();
  resolveSlowList();
  await slowPromise;

  // Multi-gw warmBotForeverChats + stale generation + refreshProfilesFromServer
  const profStateMulti = createInitialState({ platform: 'win32' });
  profStateMulti.gatewayCount = 2;
  profStateMulti.gatewayConnected = true;
  profStateMulti.activeGatewayId = 'gw-b';
  let multiIdx = 0;
  let resolveMulti;
  const profSvcMulti = createProfileManagementService({
    getState: () => profStateMulti,
    getGatewayClient: () => null,
    getClientForGateway: (gw) => (gw === 'gw-miss' ? null : profClientA),
    render: () => {},
    t: (k) => k,
    describeRpcError: (e) => String(e),
    botActivityStore: { updateLatestActivity: () => {} },
    unreadBotNames: new Set(),
    activityTransitionTracker: new ActivityTransitionTracker({ windowMs: 850 }),
    sessionMessagesCache: new Map(),
    syncProfileLastMessages: () => {},
    applyColdStartFocus: async () => {},
    cancelColdStartFocus: () => {},
    fetchSessions: async () => {},
    fetchModelOptions: async () => {},
    selectSession: async () => {},
    openGroupRoom: async () => {},
    restoreComposerFocus: () => {},
    disarmRollbackOnLeave: () => {},
    persistAgentsToCache: () => {},
    persistAvatarCache: () => {},
    nextLoadMessagesGeneration: () => 1,
    getCurrentLoadMessagesGeneration: () => 1,
    onMultiGatewayRefresh: async () => {
      multiIdx += 1;
      if (multiIdx === 1) {
        await new Promise((r) => { resolveMulti = r; });
        profStateMulti.profiles = [];
      } else {
        profStateMulti.profiles = [{ name: 'bot1', gatewayId: 'gw-b' }, { name: 'bot2', gatewayId: 'gw-miss' }];
      }
    },
  });
  const m1 = profSvcMulti.fetchProfiles();
  const m2 = profSvcMulti.fetchProfiles();
  resolveMulti();
  await Promise.all([m1, m2]);
  await profSvcMulti.warmBotForeverChats([{ name: 'bot1', gatewayId: 'gw-b' }, { name: 'bot2', gatewayId: 'gw-miss' }], profClientA);
  profSvcMulti.refreshProfilesFromServer();

  // 3. messageLoadingService uncovered branches
  const mlState = createInitialState({ platform: 'win32' });
  mlState.gatewayCount = 2;
  mlState.activeGatewayId = 'gw-b';
  mlState.activeFocus = { type: 'session', sessionId: 's-cache', gatewayId: 'gw-b' };
  mlState.activeSessionId = 's-cache';
  mlState.sessions = [{ id: 's-cache', gatewayId: 'gw-b', botName: 'coder', parentSessionId: 'parent-1', title: 'S', timestamp: 1, time: '1', preview: '' }];
  const mlCache = new CacheService(new MemoryCacheStore(), { sessionCap: 20, messageCap: 100 });
  const mlCacheOrigOpen = mlCache.openChannel.bind(mlCache);
  mlCache.openChannel = async () => ({
    rows: [{ rowId: 1, role: 'user', content: 'legacy cached row', timestamp: 1700000000 }],
    fenceMax: 5,
    fromPersistent: true,
  });
  let olderAttempt = 0;
  let mlMode = 'zero-retry';
  const mlClient = {
    async fetchSessionMessages(sid, opts) {
      if (mlMode === 'zero-retry' && opts?.offset !== undefined) {
        olderAttempt += 1;
        return { status: 'success', messages: [] };
      }
      if (mlMode === 'older-batch' && opts?.offset !== undefined) {
        return { status: 'success', messages: [{ id: 20, role: 'user', content: 'older row', timestamp: 1700000000 }], pagination: { returned: 1 } };
      }
      return { status: 'success', messages: [{ id: 50, role: 'user', content: 'fresh rest', timestamp: 1700000010 }], pagination: { returned: 1 } };
    },
    async call() { return { session_id: 'live-ml' }; },
  };
  const mlSvc = new MessageLoadingService({
    getState: () => mlState,
    getGatewayClient: () => mlClient,
    render: () => {},
    sessionMessagesCache: new Map(),
    cacheService: mlCache,
    persistMessagesToCache: () => {},
    syncPromptNavigatorMeta: () => {},
    syncPromptNavigatorFromScroll: () => {},
    scrollStreamToBottom: () => {},
    setPendingScrollToBottom: () => {},
    isStreamNearBottom: () => false,
    captureStreamAnchor: () => ({}),
    applyStreamAnchor: () => {},
    getMessageWindowStart: () => 0,
    setMessageWindowStart: () => {},
    getMessageWindowEnd: () => 50,
    setMessageWindowEnd: () => {},
    setMessageWindowUserExpanded: () => {},
    isGroupConversationActive: () => false,
    hostedRoomIds: new Set(),
    formatSessionTime: () => '10:00',
    formatTimestamp: () => '10:00',
    botActivityStore: { withActivityMap: () => undefined, persist: () => {} },
    botForeverChatCache: new Map([['gw-b:coder', 's-cache']]),
    sessionPreviewCache: new Map(),
    persistSessionPreviewCache: () => {},
    getActiveStreamingStoredSessionId: () => null,
    defaultSessionHandleRegistry: new SessionHandleRegistry(),
    activeRunningSessionIds: new Set(),
    activityTransitionTracker: { clear: () => {} },
  });
  await mlSvc.loadMessages('s-cache', 'coder', 'gw-b');
  mlSvc.forgetOlderCursorState('s-cache', 'gw-b');
  mlSvc.sessionServerOffset.set('gw-b::s-cache', 10);
  mlState.messages = [{ id: 'm50', rowId: 50, role: 'user', content: 'fresh', timestamp: '10:00' }];
  await mlSvc.loadOlderMessages(); // zero-message retry-fallback + exhausted
  mlMode = 'older-batch';
  mlSvc.sessionServerOffset.delete('gw-b::s-cache:s-cache:exhausted');
  mlSvc.sessionParentOffsetMap.delete('gw-b::s-cache:s-cache');
  mlSvc.sessionServerOffset.delete('gw-b::s-cache');
  await mlSvc.loadOlderMessages(); // hits storedOffset ?? fallback & older persist
  void mlCacheOrigOpen;
  void olderAttempt;

  // 4. sessionOperationService uncovered branches
  const soState = createInitialState({ platform: 'win32' });
  soState.gatewayCount = 2;
  soState.profiles = [{ name: 'coder', gatewayId: 'gw-b' }];
  let multiGwList = [];
  let fallbackSoClient = null;
  let onMultiRefreshResult = true;
  let useMultiCb = true;
  const soPreviewCache = new Map();
  const soSvc = new SessionOperationService({
    getState: () => soState,
    getGatewayClient: () => fallbackSoClient,
    getConnectedGatewayClients: () => multiGwList,
    getClientForGateway: (gw) => (gw === 'gw-a' ? {
      fetchLastMessage: async () => ({ text: 'p-text', timestamp: 0 }),
    } : null),
    render: () => {},
    t: (k) => k,
    showToast: () => {},
    setTimedDockNotice: () => {},
    clearTimedDockNotice: () => {},
    restoreComposerFocus: () => {},
    sessionDrafts: new Map(),
    sessionMessagesCache: new Map(),
    unreadSessionIds: new Set(),
    activeRunningSessionIds: new Set(),
    activityTransitionTracker: new ActivityTransitionTracker({ windowMs: 850 }),
    sessionHandleRegistry: new SessionHandleRegistry(),
    cacheService: mlCache,
    persistSessionsToCache: () => {},
    forgetOlderCursorState: () => {},
    sessionListGeneration: new SessionListGeneration(),
    getActiveStreamingStoredSessionId: () => null,
    getLiveStreamRegistry: () => new LiveStreamRegistry(),
    getActiveStreamingMessageId: () => null,
    scheduleToolPatch: () => {},
    onReenterSameSession: () => {},
    onSyncFocusedStream: () => {},
    resetActiveStreamingState: () => {},
    setPendingScrollToBottom: () => {},
    cancelSmoothScrollOnLeave: () => {},
    setLastMessagesSnapshot: () => {},
    captureStreamAnchor: () => ({}),
    beginSessionEnter: () => {},
    loadMessages: async () => {},
    openBotChat: async () => {},
    ensureLiveSessionId: async () => '',
    incrementActiveLoadMessagesGeneration: () => 1,
    sessionPreviewCache: soPreviewCache,
    onMultiGatewayRefresh: async () => onMultiRefreshResult,
  });
  await soSvc.fetchArchivedSessions(); // 0 clients
  soState.gatewayCount = 1;
  fallbackSoClient = { listArchivedSessions: async () => ({ ok: false }) };
  await soSvc.fetchArchivedSessions(); // single-gw failure fallback
  soState.gatewayCount = 2;
  multiGwList = [
    { gatewayId: 'gw-a', client: { listArchivedSessions: async () => Promise.reject(new Error('boom')) } },
    { gatewayId: 'gw-b', client: { listArchivedSessions: async () => ({ ok: true, sessions: [{ id: 'arch-1', title: 'A1', time: '10:00', timestamp: 1 }] }) } },
  ];
  await soSvc.fetchArchivedSessions();
  await soSvc.fetchSessions(); // onMultiGatewayRefresh returns true
  onMultiRefreshResult = false;
  fallbackSoClient = null;
  await soSvc.fetchSessions(); // returns false -> continues to null client
  soState.leftRailLayout = 'flat';
  soState.gatewayCount = 1;
  soState.sessions = [
    { id: 'prev-1', gatewayId: 'gw-a', botName: 'other', title: 'O', timestamp: 100, time: '1', preview: '' },
    { id: 'prev-2', gatewayId: 'gw-a', title: 'D', timestamp: 100, time: '1', preview: '' },
  ];
  await soSvc.enrichVisibleSessionPreviews(); // single-gw default match + gw-a client
  soState.gatewayCount = 2;
  soState.sessions = [
    { id: 'prev-3', gatewayId: 'gw-b', botName: 'coder', title: 'NullClient', timestamp: 100, time: '1', preview: '' },
  ];
  await soSvc.enrichVisibleSessionPreviews(); // gw-b client null branch

  // 5. turnExecutionService omitted getLiveStreamRegistryForGateway branch (line 232)
  const turnSvc = createTurnExecutionService({
    getState: () => createInitialState({ platform: 'win32' }),
    getGatewayClient: () => null,
    getRpcCaller: () => ({ request: async () => ({}) }),
    getInteractiveService: () => new InteractiveService(),
    getCacheService: () => mlCache,
    getGroupRoomStore: () => ({ appendUserMessage: () => {}, isHostedRoom: () => false }),
    getActivityTransitionTracker: () => new ActivityTransitionTracker({ windowMs: 850 }),
    getTokenCoalescer: () => ({ push: () => {}, flush: () => {}, clear: () => {}, dropMessage: () => {} }),
    getSessionHandleRegistry: () => new SessionHandleRegistry(),
    getSessionMessagesCache: () => new Map(),
    getSessionDrafts: () => new Map(),
    getBotActivityStore: () => ({ updateLatestActivity: () => {} }),
    getHandoffService: () => ({ onUserMessage: () => {} }),
    completeEntityTurn: () => {},
    getActiveRunningSessionIds: () => new Set(),
    getUnreadSessionIds: () => new Set(),
    getActiveRunningBotNames: () => new Set(),
    getUnreadBotNames: () => new Set(),
    getActiveRunningGroupRoomIds: () => new Set(),
    getActiveStreamingContext: () => ({ activeStreamingMessageId: null, activeStreamingStoredSessionId: null, activeStreamingLiveId: null, activeStreamingBotName: null }),
    setActiveStreamingContext: () => {},
    getTurnStartedSessionId: () => null,
    setTurnStartedSessionId: () => {},
    getSessionHistoryTrust: () => new Map(),
    forgetOlderCursorState: () => {},
    createNewSession: async () => {},
    ensureLiveSessionId: async () => '',
    setMessageContent: () => {},
    syncActiveGroupSpeakerFromMessages: () => {},
    scheduleToolPatch: () => {},
    clearToolPatchQueue: () => {},
    stopRunningToolTimers: () => {},
    runSlashCommand: () => false,
    enqueueDraft: () => {},
    handleQueueAction: () => {},
    setMessageWindowUserExpanded: () => {},
    ensureMessageWindow: () => {},
    render: () => {},
    t: (k) => k,
  });
  turnSvc.disarmTurnWatchdog();
  void useMultiCb;
});
