/**
 * TurnSideAgentHelper 与合并后多网关/服务全分支闭环单测
 * (packages/desktop/__tests__/unit/turn-side-agent-and-merge-coverage.test.mjs)
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
  createTurnExecutionService,
  describeRpcError,
} from '../../dist/renderer/services/turnExecutionService.mjs';
import {
  createActiveLiveSessionIdResolver,
  createModelCatalogFetcher,
  createMultiGatewayCoordinator,
  resolveSessionEnterPhase,
} from '../../dist/renderer/gateway/multiGatewayCoordinator.mjs';
import {
  IndexWriteQueue,
  persistMultiGatewayAgentsToCache,
  persistMultiGatewaySessionsToCache,
} from '../../dist/renderer/cache/desktopCacheBridge.mjs';
import { createGroupOperationService } from '../../dist/renderer/services/groupOperationService.mjs';
import { MessageLoadingService } from '../../dist/renderer/services/messageLoadingService.mjs';
import { SessionOperationService } from '../../dist/renderer/services/sessionOperationService.mjs';
import {
  collectGatewayScopedSessionIds,
  createGatewayEventDispatcher,
} from '../../dist/renderer/gateway/gatewayEventDispatcher.mjs';
import { LeftRailSnapshotManager } from '../../dist/renderer/leftrail/leftRailSnapshotManager.mjs';
import { advanceTimers, createMockTurnDeps } from './helpers/turnExecutionHarness.mjs';
import { createMockDispatcherDeps } from './helpers/gatewayDispatcherHarness.mjs';

test('turnSideAgentHelper 与 turnExecutionService offline / sideAgent / routeSend 全分支', async (t) => {
  assert.equal(describeRpcError(new Error('err-msg')), 'err-msg');
  assert.equal(describeRpcError({ message: 'obj-msg' }), 'obj-msg');
  assert.equal(describeRpcError({ code: 4000 }), 'RPC error 4000');
  assert.equal(describeRpcError('plain-str'), 'plain-str');
  assert.equal(describeRpcError(999), '999');

  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_700_000_000_000 });
  try {
    // 1. sendMessage activeEntityGatewayOffline (turnExecutionService:921)
    const offlineHarness = createMockTurnDeps({ state: { activeEntityGatewayOffline: true } });
    const offlineSvc = createTurnExecutionService(offlineHarness.deps);
    await offlineSvc.sendMessage('blocked');
    assert.equal(offlineHarness.state.dockNotice, 'gateway.offlineReadOnlyNotice');
    await offlineSvc.askSideAgent('btw', 'arch-bot', 'offline?');

    const onlineHarness = createMockTurnDeps({
      state: {
        activeEntityGatewayOffline: false,
        activeFocus: { type: 'session', sessionId: 's-online-ok' },
        activeSessionId: 's-online-ok',
      },
      gatewayClient: { call: async () => ({ accepted: true }) },
    });
    await createTurnExecutionService(onlineHarness.deps).sendMessage('online send');

    // 2. !client & !liveId guards
    const nullClientHarness = createMockTurnDeps();
    nullClientHarness.deps.getGatewayClient = () => null;
    await createTurnExecutionService(nullClientHarness.deps).askSideAgent('btw', 'arch-bot', 'no client');
    assert.equal(nullClientHarness.state.dockNotice, 'chat.gatewayNotConnected');

    const noLiveHarness = createMockTurnDeps();
    noLiveHarness.deps.ensureLiveSessionId = async () => '';
    await createTurnExecutionService(noLiveHarness.deps).askSideAgent('btw', 'arch-bot', 'no live');
    assert.equal(noLiveHarness.state.dockNotice, 'chat.forkNoLive');

    // 3. BTW displayName 匹配 + 定时器 slowHint / expired + non-pending 分支 + non-unref 兜底
    let seq = 0;
    const okHarness = createMockTurnDeps({
      state: {
        activeFocus: { type: 'bot', botName: 'default', gatewayId: 'gw-1' },
        profiles: [
          { name: 'arch-bot', displayName: '架构师', gatewayId: 'gw-1' },
          { name: 'plain-bot', displayName: '' },
        ],
      },
      gatewayClient: {
        call: async (method) => {
          if (method === 'prompt.background') return seq++ === 0 ? { task_id: 'bg-1' } : {};
          return {};
        },
      },
    });
    okHarness.deps.getHandoffService = () => ({
      onUserMessage: () => {},
      sendBtw: async () => ({ task_id: `btw-${++seq}` }),
    });
    const svc = createTurnExecutionService(okHarness.deps);

    svc.armCapsuleTimers('missing-id');
    await svc.askSideAgent('btw', '架构师', 'q1');
    const c1 = okHarness.state.sideAgentCapsules[0];
    assert.equal(c1.profile, 'arch-bot');
    await advanceTimers(t, 15_000);
    assert.equal(c1.notice, 'capsule.slowHint');
    await advanceTimers(t, 600_000);
    assert.equal(c1.status, 'expired');

    // 状态提前变更为 done 后再走 timer（覆盖 c.status === 'pending' 的假分支）
    await svc.askSideAgent('btw', 'unknown-bot', 'q2');
    const c2 = okHarness.state.sideAgentCapsules[1];
    c2.status = 'done';
    await advanceTimers(t, 615_000);
    assert.equal(c2.status, 'done');

    // safeUnrefTimer 无 .unref 分支
    const origSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = () => ({});
    try {
      await svc.askSideAgent('delegation', 'arch-bot', 'bg-ok');
    } finally {
      globalThis.setTimeout = origSetTimeout;
    }

    // 缺失 task_id 失败路径与对象错误码
    await svc.askSideAgent('delegation', 'arch-bot', 'bg-missing-id');
    const failCap = okHarness.state.sideAgentCapsules.at(-1);
    assert.equal(failCap.status, 'failed');

    const throwHarness = createMockTurnDeps({
      gatewayClient: {
        call: async () => { throw { code: 4000 }; },
      },
    });
    await createTurnExecutionService(throwHarness.deps).askSideAgent('delegation', 'arch-bot', 'bg-err');
    assert.equal(throwHarness.state.sideAgentCapsules[0].notice, 'RPC error 4000');

    // 4. collectKnownSendProfiles: group members + 'all' 去重 + 房间缺失
    okHarness.state.activeFocus = { type: 'group', roomId: 'r-g1', gatewayId: 'gw-1' };
    okHarness.state.groupRooms = [
      { roomId: 'r-g1', gatewayId: 'gw-1', name: 'G1', members: ['arch-bot', 'extra-bot', 123] },
      { roomId: 'r-all', name: 'GAll', members: ['all'] },
    ];
    await svc.routeSend('hello room');
    okHarness.state.activeFocus = { type: 'group', roomId: 'r-all' };
    await svc.routeSend('hello all');
    okHarness.state.activeFocus = { type: 'group', roomId: 'r-none' };
    await svc.routeSend('hello missing room');
  } finally {
    t.mock.timers.reset();
  }
});

test('multiGatewayCoordinator 分支: resolveSessionEnterPhase / refreshAllSlotsIfMulti / interactiveResume / modelCatalog', async () => {
  assert.equal(resolveSessionEnterPhase(true, true), 'ready');
  assert.equal(resolveSessionEnterPhase(false, true), 'loading');
  assert.equal(resolveSessionEnterPhase(false, false), 'ready');

  const st = createInitialState({ platform: 'win32' });
  st.gatewayCount = undefined;
  const runtimeStub = {
    getSlot: () => undefined,
    getClient: () => null,
    getHealthSummary: () => ({ totalCount: 1, onlineCount: 0, connectedCount: 0, allConnected: false, anyConnected: false, slots: [] }),
    buildAggregatedView: () => ({ health: { totalCount: 1, onlineCount: 0, slots: [] }, effectiveGatewayCount: 1, isMultiGateway: false, profiles: [], sessions: [], groupRooms: [] }),
    refreshAll: async () => [],
    refreshGateway: async () => {},
    syncGateways: () => {},
    connectAll: async () => {},
    reconnectGateway: async () => false,
    disconnectGateway: () => false,
    getSnapshot: () => new Map(),
    onEvent: () => () => {},
  };
  const coord = createMultiGatewayCoordinator({
    runtime: runtimeStub,
    getState: () => st,
    render: () => {},
  });
  assert.equal(await coord.refreshAllSlotsIfMulti(() => false), false);
  assert.equal(await coord.refreshAllSlotsIfMulti(), false);
  assert.equal(await coord.refreshAllSlotsIfMulti(() => true), true);
  st.gatewayCount = 2;
  assert.equal(await coord.refreshAllSlotsIfMulti(() => false), true);

  // resolveActiveLiveSessionId with and without interactive callbacks & handles
  const liveState = createInitialState({ platform: 'win32' });
  liveState.gatewayCount = 2;
  liveState.activeFocus = { type: 'session', sessionId: 's-1', gatewayId: 'gw-a' };
  liveState.activeSessionId = 's-1';
  let resumePayload = { session_id: 'lv-1', stored_session_id: 's-1' };
  const reconciled = [];
  const withHooks = createActiveLiveSessionIdResolver({
    getState: () => liveState,
    resolveClient: () => ({ call: async () => resumePayload }),
    sessionHandleRegistry: new SessionHandleRegistry(),
    getGeneration: () => 1,
    describeRpcError: (e) => String(e),
    onCaptureInteractiveFence: () => 5,
    onInteractiveResumeReconciled: (info) => reconciled.push(info),
  });
  assert.equal(await withHooks(), 'lv-1');
  liveState.activeLiveSessionId = '';
  resumePayload = {};
  assert.equal(await withHooks(), '');
  resumePayload = null;
  assert.equal(await withHooks(), '');
  assert.equal(reconciled.length, 2);
  assert.equal(reconciled[0].fence, 5);
  assert.equal(reconciled[1].liveSessionId, null);

  // createModelCatalogFetcher empty vs non-empty catalog error & currentModel fallbacks
  const catState = createInitialState({ platform: 'win32' });
  let catRes = { ok: false, error: '', models: [], details: [], entries: [], currentModel: '', currentProvider: '' };
  const fetchCat = createModelCatalogFetcher({
    getState: () => catState,
    resolveActiveClient: () => ({ getModelCatalog: async () => catRes }),
    render: () => {},
    t: (k) => k,
  });
  await fetchCat();
  assert.equal(catState.dockNotice, 'chat.gatewayNotConnected');
  catRes = { ok: false, error: 'cat-custom-err', models: [], details: [], entries: [], currentModel: '', currentProvider: '' };
  await fetchCat();
  assert.equal(catState.dockNotice, 'cat-custom-err');
  catRes = { ok: true, models: ['m-1'], details: [], entries: [], currentModel: '', currentProvider: 'p1' };
  await fetchCat({ clearNotice: false });
  assert.equal(catState.selectedModel, 'm-1');
});

test('desktopCacheBridge / group / messageLoading / sessionOperation / dispatcher / leftRail 单支补齐', async () => {
  const cache = new CacheService(new MemoryCacheStore(), { sessionCap: 20, messageCap: 50 });
  const queue = new IndexWriteQueue();
  const sList = [{ id: 's1', title: 'S1', botName: 'default', timestamp: 1, time: '1', preview: '' }];
  const pList = [{ name: 'default' }];
  persistMultiGatewaySessionsToCache(sList, cache);
  persistMultiGatewaySessionsToCache(sList, cache, 'default', queue, ['gw-a'], 1);
  persistMultiGatewaySessionsToCache(sList, cache, 'default', queue, [], 2);
  persistMultiGatewaySessionsToCache(sList, cache, 'default', queue, ['gw-a'], 2);
  persistMultiGatewayAgentsToCache(pList, cache);
  persistMultiGatewayAgentsToCache(pList, cache, ['gw-a'], 1);
  persistMultiGatewayAgentsToCache(pList, cache, [], 2);
  persistMultiGatewayAgentsToCache(pList, cache, ['gw-a'], 2);

  // groupOperationService:112
  const gState = createInitialState({ platform: 'win32' });
  let refreshCount = 0;
  const makeGroupSvc = (withRefresh) => createGroupOperationService({
    getState: () => gState,
    getGatewayClient: () => null,
    render: () => {},
    t: (k) => k,
    disarmRollbackOnLeave: () => {},
    unreadGroupRoomIds: new Set(),
    activeRunningGroupRoomIds: new Set(),
    activityTransitionTracker: new ActivityTransitionTracker({ windowMs: 850 }),
    turnExecutionService: {
      resetActiveGroupThread: () => {},
      syncGroupRoomLogsToState: () => {},
      refreshGroupRoomLog: async () => 0,
      sendGroupMessage: async () => {},
    },
    groupPollerManager: { isPolling: () => false, startAwaitReply: () => {}, stop: () => {}, stopAll: () => {} },
    persistGroupsToCache: () => {},
    resolveAgentAvatar: () => '',
    formatTimestamp: () => '',
    nextLoadMessagesGeneration: () => 1,
    getCurrentLoadMessagesGeneration: () => 1,
    setPendingScrollToBottom: () => {},
    captureStreamAnchor: () => ({}),
    beginSessionEnter: () => {},
    onMultiGatewayRefresh: withRefresh ? async () => { refreshCount += 1; } : undefined,
  });
  gState.gatewayCount = undefined;
  await makeGroupSvc(true).fetchGroupRooms();
  gState.gatewayCount = 2;
  await makeGroupSvc(true).fetchGroupRooms();
  await makeGroupSvc(false).fetchGroupRooms();
  assert.equal(refreshCount, 1);

  // messageLoadingService:291, 357
  const mlState = createInitialState({ platform: 'win32' });
  const makeMl = (getHandleReg) => new MessageLoadingService({
    getState: () => mlState,
    getGatewayClient: () => null,
    render: () => {},
    sessionMessagesCache: new Map(),
    cacheService: cache,
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
    formatSessionTime: () => '',
    formatTimestamp: () => '',
    botActivityStore: { updateLatestActivity: () => {} },
    botForeverChatCache: new Map(),
    sessionPreviewCache: new Map(),
    persistSessionPreviewCache: () => {},
    getActiveStreamingStoredSessionId: () => null,
    defaultSessionHandleRegistry: new SessionHandleRegistry(),
    getSessionHandleRegistryForGateway: getHandleReg,
    activeRunningSessionIds: new Set(),
    activityTransitionTracker: new ActivityTransitionTracker({ windowMs: 850 }),
    getGeneration: () => 1,
  });
  mlState.gatewayCount = 1;
  await makeMl(undefined).loadMessages('ml-s1');
  makeMl(undefined).forgetOlderCursorState('ml-s1', 'gw-b');
  mlState.gatewayCount = 2;
  await makeMl(() => new SessionHandleRegistry()).loadMessages('ml-s1', undefined, 'gw-b');
  await makeMl(() => undefined).loadMessages('ml-s1', undefined, 'gw-b');
  makeMl(undefined).forgetOlderCursorState('ml-s1', 'gw-b');

  // sessionOperationService:452, 458, 1246
  const soState = createInitialState({ platform: 'win32' });
  const makeSo = (previewCache) => new SessionOperationService({
    getState: () => soState,
    getGatewayClient: () => ({ call: async () => ({ ok: true }), request: async () => ({ ok: true }) }),
    getClientForGateway: () => ({ call: async () => ({ ok: true }), request: async () => ({ ok: true }) }),
    getDesktopApi: () => undefined,
    getEffectiveUrl: () => '',
    getCurrentTicket: () => null,
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
    cacheService: cache,
    persistSessionsToCache: () => {},
    forgetOlderCursorState: () => {},
    sessionListGeneration: new SessionListGeneration(),
    getActiveStreamingStoredSessionId: () => null,
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
    ...(previewCache ? { sessionPreviewCache: previewCache } : {}),
  });
  soState.gatewayCount = 1;
  soState.activeSessionId = 'd1';
  soState.sessions = [
    { id: 'd1', title: '1', timestamp: 1, time: '1', preview: '' },
    { id: 'd2', title: '2', timestamp: 2, time: '2', preview: '' },
  ];
  await makeSo(undefined).enrichVisibleSessionPreviews();
  await makeSo(new Map()).enrichVisibleSessionPreviews();
  await makeSo(new Map()).deleteSession('d1'); // targetGw undefined + nextSession without gatewayId
  soState.gatewayCount = 2;
  soState.activeSessionId = 'd2';
  soState.activeGatewayId = 'gw-a';
  soState.sessions = [
    { id: 'd2', gatewayId: 'gw-a', title: '2', timestamp: 2, time: '2', preview: '' },
    { id: 'd3', gatewayId: 'gw-b', title: '3', timestamp: 3, time: '3', preview: '' },
  ];
  await makeSo(new Map()).deleteSession('d2', 'gw-a'); // fallback state.sessions[0] with gatewayId

  // liveStreamCoordinator:81,273 & gatewayEventDispatcher:951 (gatewayId × gatewayCount & focusMatchesSource)
  assert.deepEqual(collectGatewayScopedSessionIds(['s1'], 'gw-a', undefined), ['s1']);
  assert.deepEqual(collectGatewayScopedSessionIds(['s1'], 'gw-a', 1), ['s1']);
  assert.deepEqual(collectGatewayScopedSessionIds(['gw-a::s1', 'gw-b::s2'], 'gw-a', 2), ['s1']);
  assert.deepEqual(collectGatewayScopedSessionIds(['s1'], undefined, 2), ['s1']);

  const { deps: dDeps, state: dState } = createMockDispatcherDeps({
    state: {
      gatewayCount: 2,
      activeGatewayId: 'gw-a',
      activeFocus: { type: 'session', sessionId: 'sess-1', gatewayId: 'gw-a' },
    },
  });
  const disp = createGatewayEventDispatcher(dDeps);
  disp.handleGatewayEvent({ type: 'message.delta', session_id: 'other', payload: { text: 'x' } }, 'gw-b');
  disp.handleGatewayEvent({ type: 'message.delta', session_id: 'live-1', payload: { text: 'y' } }, 'gw-a');
  disp.handleGatewayEvent({ type: 'message.delta', session_id: 'unreg-1', payload: { text: 'z' } });
  dState.gatewayCount = undefined;
  disp.handleGatewayEvent({ type: 'message.delta', session_id: 'unreg-2', payload: { text: 'z' } }, 'gw-a');
  dState.gatewayCount = 1;
  disp.handleGatewayEvent({ type: 'message.delta', session_id: 'unreg-3', payload: { text: 'z' } }, 'gw-a');

  // leftRailSnapshotManager:289 (decorateGroups waiting reasons: omitted, scoped hit, raw hit, miss)
  const baseHost = {
    getSessions: () => [],
    getGroupRooms: () => [
      { roomId: 'r1', gatewayId: 'gw-a', name: 'R1', members: ['default'], updatedAt: 10 },
      { roomId: 'r2', gatewayId: 'gw-a', name: 'R2', members: ['default'], updatedAt: 10 },
      { roomId: 'r3', gatewayId: 'gw-a', name: 'R3', members: ['default'], updatedAt: 10 },
    ],
    getProfiles: () => [],
    getActiveSessionId: () => '',
    getActiveFocus: () => ({ type: 'session', sessionId: '' }),
    getProfileName: () => 'default',
    getSearchQuery: () => '',
    getGatewayCount: () => 2,
    isSessionsGroupExpanded: () => true,
    isGroupsGroupExpanded: () => true,
    getError: () => '',
    isCollapsed: () => false,
    getEditingGroupRoomId: () => undefined,
    getProfilesPhase: () => 'ready',
    getSessionsPhase: () => 'ready',
    getActivityVariant: () => 'breath',
    getActiveRunningSessionIds: () => new Set(),
    getUnreadSessionIds: () => new Set(),
    getActiveStreamingStoredSessionId: () => null,
    getActiveRunningGroupRoomIds: () => new Set(),
    getUnreadGroupRoomIds: () => new Set(),
    getActiveRunningBotNames: () => new Set(),
    getUnreadBotNames: () => new Set(),
    resolveAgentAvatar: () => '',
    resolveTransition: () => ({ transition: 'none' }),
  };
  assert.equal(new LeftRailSnapshotManager(baseHost).decorateGroups(1000).length, 3);
  const decorated = new LeftRailSnapshotManager({
    ...baseHost,
    getWaitingEntityMaps: () => ({
      sessionWaitingReasons: new Map(),
      groupWaitingReasons: new Map([['gw-a::r1', 'approval'], ['r2', 'clarify']]),
    }),
  }).decorateGroups(1000);
  assert.equal(decorated[0].waitingReason, 'approval');
  assert.equal(decorated[1].waitingReason, 'clarify');
  assert.equal(decorated[2].waitingReason, undefined);
});
