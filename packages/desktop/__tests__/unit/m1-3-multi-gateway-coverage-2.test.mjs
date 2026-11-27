/**
 * M1.3 多网关分支全闭环补充单测（Part 2）
 * (packages/desktop/__tests__/unit/m1-3-multi-gateway-coverage-2.test.mjs)
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
import {
  createInitialState,
  resolveScopedBotRuntimeKey,
  resolveScopedEntityRuntimeKey,
} from '../../dist/renderer/state/appState.mjs';
import {
  createAppBootstrapGatewayHandlers,
  createColdStartFocusRunner,
  createDesktopMultiGatewayWiring,
  createModelCatalogFetcher,
  createMultiGatewayCoordinator,
  matchesForeverChatSession,
} from '../../dist/renderer/gateway/multiGatewayCoordinator.mjs';
import { createMultiGatewayRuntime } from '../../dist/renderer/gateway/multiGatewayRuntime.mjs';
import { GATEWAY_REGISTRY_STORAGE_KEY } from '../../dist/renderer/gateway/gatewayRegistryStore.mjs';
import { createBotActivityStore } from '../../dist/renderer/persistence/botActivityStore.mjs';
import { createConversationStreamController } from '../../dist/renderer/events/conversationStreamController.mjs';
import { createConversationOrgCoordinator } from '../../dist/renderer/services/conversationOrgCoordinator.mjs';
import { createMobileShellCoordinator } from '../../dist/renderer/mobile/mobileShellCoordinator.mjs';
import { createTokenStreamWriter } from '../../dist/renderer/stream/tokenStreamWriter.mjs';
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

test('M1.3 remaining branch closure: coordinator, mediaResolver, services, turnExecution & wiring fallbacks', async () => {
  const origWs = globalThis.WebSocket;
  const origLsDesc = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  class InstantSocket {
    constructor(url) { this.url = url; this.readyState = 0; queueMicrotask(() => { this.readyState = 1; this.onopen?.(); }); }
    send(raw) {
      const f = JSON.parse(raw);
      if (f.id != null) queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ jsonrpc: '2.0', id: f.id, result: { ok: true } }) }));
    }
    close(code = 1000, reason = 'c') { this.readyState = 3; this.onclose?.({ code, reason }); }
  }
  const mlCache = new CacheService(new MemoryCacheStore(), { sessionCap: 20, messageCap: 100 });

  // 1. conversationStreamController activeGatewayId fallback & empty gatewayId + rollback assertion
  const scCache = new Map();
  const scState = createInitialState({ platform: 'win32' });
  scState.gatewayCount = 2;
  scState.activeSessionId = 'sess-sc2';
  scState.activeGatewayId = 'gw-alt';
  scState.activeFocus = { type: 'session', sessionId: 'sess-sc2' };
  let scRenders = 0;
  const scNoop = () => {};
  const scEmpty = async () => '';
  const scBase = {
    getState: () => scState, render: () => { scRenders += 1; }, safeCopyText: async () => true,
    setTimedDockNotice: scNoop, isStreamingActiveForCurrentSession: () => false, t: (k) => k,
    getGatewayClient: () => null, getRpcCaller: () => ({ request: async () => ({}) }),
    getInteractiveService: () => new InteractiveService(), selectSession: async () => {},
    scheduleSessionsRefresh: scNoop, getSessionMessagesCache: () => scCache,
    handleOpenFilePreview: async () => {}, syncPromptNavigatorFromScroll: scNoop, loadOlderMessages: async () => {},
    relocateMessageWindowToIndex: () => false, syncScrollTopToWindow: scNoop, slideMessageWindowForward: scNoop,
    expandMessageWindow: () => false, settleInitialBottom: scNoop, scrollStreamToBottom: scNoop,
    scheduleStreamBottomInset: scNoop, layoutSignature: () => '', ensureLiveSessionId: scEmpty,
    getMessageWindowStart: () => 0, getMessageWindowEnd: () => 10, isMessageWindowUserExpanded: () => false,
    setMessageWindowUserExpanded: scNoop, getAverageRowHeightPx: () => 40, isInitialBottomSettling: () => false,
    setInitialBottomSettling: scNoop, getStreamScrollCooldown: () => false, setStreamScrollCooldown: scNoop,
    getLastStreamScrollTop: () => 0, setLastStreamScrollTop: scNoop, getProgrammaticScrollTarget: () => null,
    setProgrammaticScrollTarget: scNoop, getProgrammaticScrollIgnoreUntil: () => 0, getLayoutDriftUntil: () => 0,
    getReaderScrolledSessionId: () => '', setReaderScrolledSessionId: scNoop, setSettledLayoutSignature: scNoop,
    STICK_TO_BOTTOM_THRESHOLD_PX: 80, MESSAGE_WINDOW_CAPACITY: 100,
  };
  const makeSc = () => createConversationStreamController(scBase);
  scState.messages = [{ id: 'u1', rowId: 10, role: 'user', content: 'x', timestamp: '10:00' }];
  makeSc().handleRollbackMessage({ getAttribute: (n) => (n === 'data-msg-id' ? 'u1' : '10'), closest: () => null });
  assert.deepEqual(scState.messages, []);
  assert.equal(scState.rollbackArmed?.anchor?.rowId, 10);
  assert.deepEqual(scCache.get('gw-alt::sess-sc2'), []);
  scState.activeGatewayId = '';
  scState.messages = [{ id: 'u1', rowId: 10, role: 'user', content: 'x', timestamp: '10:00' }];
  makeSc().handleRollbackMessage({ getAttribute: (n) => (n === 'data-msg-id' ? 'u1' : '10'), closest: () => null });
  assert.deepEqual(scCache.get('sess-sc2'), []);
  assert.ok(scRenders >= 2);

  // 2. conversationOrgCoordinator explicit fallback, missing s.gatewayId & explicit gatewayId match/mismatch
  const orgState = createInitialState({ platform: 'win32' });
  orgState.gatewayCount = 2;
  orgState.sessions = [
    { id: 's-no-meta', title: 'NM', timestamp: 1, time: '1', preview: '' },
    { id: 's-with-meta', botName: 'b1', gatewayId: 'gw-1', title: 'WM', timestamp: 1, time: '1', preview: '' },
  ];
  orgState.archivedSessions = [
    { id: 's-arch-no-gw', title: 'AG', timestamp: 1, time: '1', preview: '' },
    { id: 's-arch-with-gw', botName: 'b1', gatewayId: 'gw-a', title: 'AG2', timestamp: 1, time: '1', preview: '' },
  ];
  const orgArchCalls = [];
  const orgToasts = [];
  const orgCoord = createConversationOrgCoordinator({
    getState: () => orgState, getGatewayClient: () => null, render: () => {}, t: (k) => k,
    showToast: (msg) => orgToasts.push(msg), restoreComposerFocus: () => {}, describeRpcError: (e) => String(e),
    setSessionArchived: async (id, arch, prof, gw) => { orgArchCalls.push([id, arch, prof, gw]); return true; },
    isForeverChatSession: () => false, fetchArchivedSessions: async () => {}, openNewChatInContainer: () => {},
  });
  assert.equal(await orgCoord.markDoneConfirmed('session', 's-no-meta', 'explicit-prof', 'gw-exp'), false);
  await orgCoord.markDoneConfirmed('session', 's-no-meta', undefined, 'gw-exp');
  await orgCoord.markDoneConfirmed('session', 's-no-meta', 'default', 'gw-exp');
  await orgCoord.markDoneConfirmed('session', 's-with-meta');
  assert.equal(await orgCoord.markDoneConfirmed('group', 'room-1'), false);
  await orgCoord.restoreDone('session', 's-missing', 'explicit-prof', 'gw-exp');
  assert.deepEqual(orgArchCalls, [
    ['s-no-meta', true, undefined, 'gw-exp'],
    ['s-no-meta', true, 'default', 'gw-exp'],
    ['s-with-meta', true, 'b1', 'gw-1'],
    ['s-missing', false, 'explicit-prof', 'gw-exp'],
  ]);
  assert.ok(orgToasts.includes('rail.orgSyncFailed'));
  orgCoord.autoReopenIfDone('session', 's-arch-no-gw', undefined, 'gw-b');
  orgCoord.autoReopenIfDone('session', 's-with-meta');
  orgCoord.autoReopenIfDone('session', 's-arch-with-gw', 'b1', 'gw-a');
  orgCoord.autoReopenIfDone('session', 's-arch-with-gw', 'b1', 'gw-other');
  assert.equal(orgArchCalls.length, 6);
  assert.deepEqual(orgArchCalls.slice(4), [
    ['s-arch-no-gw', false, undefined, 'gw-b'],
    ['s-arch-with-gw', false, 'b1', 'gw-a'],
  ]);

  // 3. mediaResolver deliverable coordinator url/gatewayId fallbacks & explicit focus gatewayId
  const mState = createInitialState({ platform: 'win32' });
  mState.isStreaming = false;
  mState.gatewayUrl = 'http://fb:8642';
  mState.activeGatewayId = 'gw-fb';
  mState.activeFocus = { type: 'session', sessionId: 's1' };
  mState.messages = [{ id: 'md1', role: 'assistant', content: 'Created file `src/app.ts`', timestamp: '10:00' }];
  const proxyUrls = [];
  const proxyMock = { async httpProxy(req) { if (req.path.startsWith('/api/files')) proxyUrls.push(req.baseUrl); return { status: 200, body: '{}' }; } };
  createSessionDeliverableCoordinator({
    getState: () => mState, getGatewayUrlForGateway: () => '', getDesktopApi: () => proxyMock, onVerifiedPathsUpdated: () => {},
  }).scheduleVerification();
  mState.activeGatewayId = '';
  mState.activeFocus = { type: 'session', sessionId: 's2' };
  createSessionDeliverableCoordinator({
    getState: () => mState, getDesktopApi: () => proxyMock, onVerifiedPathsUpdated: () => {},
  }).scheduleVerification();
  mState.activeFocus = { type: 'session', sessionId: 's3', gatewayId: 'gw-focus' };
  createSessionDeliverableCoordinator({
    getState: () => mState, getGatewayUrlForGateway: () => 'http://focus:8642', getDesktopApi: () => proxyMock, onVerifiedPathsUpdated: () => {},
  }).scheduleVerification();
  await flushMicrotasks();
  assert.deepEqual(proxyUrls, ['http://fb:8642', 'http://fb:8642', 'http://focus:8642']);

  // 4. messageLoadingService custom per-gw stream & handle registries + fallback
  const regCustom = new LiveStreamRegistry();
  regCustom.registerStream({ storedSessionId: 's-lc', liveSessionId: 'l-lc', messageId: 'mc', origin: 'remote' });
  const regFb = new LiveStreamRegistry();
  regFb.registerStream({ storedSessionId: 's-lfb', liveSessionId: 'l-lfb', messageId: 'mfb', origin: 'remote' });
  const mlState = createInitialState({ platform: 'win32' });
  mlState.gatewayCount = 2;
  const mlRegLookups = [];
  let mlRenders = 0;
  const mlSvc2 = new MessageLoadingService({
    getState: () => mlState, getGatewayClient: () => null, render: () => { mlRenders += 1; },
    sessionMessagesCache: new Map(), cacheService: mlCache, persistMessagesToCache: () => {},
    syncPromptNavigatorMeta: () => {}, syncPromptNavigatorFromScroll: () => {}, scrollStreamToBottom: () => {},
    setPendingScrollToBottom: () => {}, isStreamNearBottom: () => false, captureStreamAnchor: () => ({}),
    applyStreamAnchor: () => {}, getMessageWindowStart: () => 0, setMessageWindowStart: () => {},
    getMessageWindowEnd: () => 50, setMessageWindowEnd: () => {}, setMessageWindowUserExpanded: () => {},
    isGroupConversationActive: () => false, hostedRoomIds: new Set(), formatSessionTime: () => '',
    formatTimestamp: () => '', botActivityStore: { withActivityMap: () => undefined, persist: () => {} },
    botForeverChatCache: new Map(), sessionPreviewCache: new Map(), persistSessionPreviewCache: () => {},
    getActiveStreamingStoredSessionId: () => null, getLiveStreamRegistry: () => regFb,
    getLiveStreamRegistryForGateway: (gw) => { mlRegLookups.push(gw); return gw === 'gw-a' ? regCustom : undefined; },
    defaultSessionHandleRegistry: new SessionHandleRegistry(), getSessionHandleRegistryForGateway: () => new SessionHandleRegistry(),
    activeRunningSessionIds: new Set(), activityTransitionTracker: { clear: () => {} },
  });
  mlState.activeSessionId = 's-lc'; mlState.activeGatewayId = 'gw-a'; mlState.activeFocus = { type: 'session', sessionId: 's-lc', gatewayId: 'gw-a' };
  await mlSvc2.loadMessages('s-lc', 'default', 'gw-a');
  assert.equal(mlState.messagesPhase, 'ready');
  mlState.activeSessionId = 's-lfb'; mlState.activeGatewayId = 'gw-none'; mlState.activeFocus = { type: 'session', sessionId: 's-lfb', gatewayId: 'gw-none' };
  await mlSvc2.loadMessages('s-lfb', 'default', 'gw-none');
  assert.deepEqual(mlRegLookups, ['gw-a', 'gw-a', 'gw-none', 'gw-none']);
  assert.ok(mlRenders >= 2);

  // 5. profileManagementService refreshProfilesFromServer branches (280)
  const pState = createInitialState({ platform: 'win32' });
  pState.gatewayCount = undefined;
  pState.gatewayConnected = true;
  let pRpcCalls = 0;
  let pRenders = 0;
  const pBase = {
    getState: () => pState, getGatewayClient: () => null, render: () => { pRenders += 1; }, t: (k) => k, describeRpcError: (e) => String(e),
    botActivityStore: { updateLatestActivity: () => {} }, unreadBotNames: new Set(), activityTransitionTracker: new ActivityTransitionTracker({ windowMs: 850 }),
    sessionMessagesCache: new Map(), syncProfileLastMessages: () => {}, applyColdStartFocus: async () => {}, cancelColdStartFocus: () => {},
    fetchSessions: async () => {}, fetchModelOptions: async () => {}, selectSession: async () => {}, openGroupRoom: async () => {},
    restoreComposerFocus: () => {}, disarmRollbackOnLeave: () => {}, persistAgentsToCache: () => {}, persistAvatarCache: () => {},
    nextLoadMessagesGeneration: () => 1, getCurrentLoadMessagesGeneration: () => 1,
  };
  await createProfileManagementService(pBase).refreshProfilesFromServer();
  pState.gatewayConnected = false;
  await createProfileManagementService({
    ...pBase,
    getGatewayClient: () => ({ call: async () => { pRpcCalls += 1; return {}; } }),
  }).refreshProfilesFromServer();
  assert.equal(pRpcCalls, 0);
  assert.equal(pRenders, 0);

  // 6. sessionOperationService per-gw registries, formatSessionTime, resolveAgentAvatar, missing preview cache
  const soState = createInitialState({ platform: 'win32' });
  soState.gatewayCount = 2;
  soState.sessions = [{ id: 'del-1', gatewayId: 'gw-a', title: 'D', timestamp: 1, time: '1', preview: '' }];
  const soRpcMethods = [];
  const soBase = {
    getState: () => soState,
    getGatewayClient: () => ({
      call: async (m, p) => { soRpcMethods.push([m, p?.session_id]); return { ok: true }; },
      request: async () => ({ ok: true }),
    }),
    getDesktopApi: () => undefined, getCurrentTicket: () => null, getEffectiveUrl: (u) => u || '',
    render: () => {}, t: (k) => k, showToast: () => {}, setTimedDockNotice: () => {},
    clearTimedDockNotice: () => {}, restoreComposerFocus: () => {},
    sessionDrafts: new Map(), sessionMessagesCache: new Map(), unreadSessionIds: new Set(), activeRunningSessionIds: new Set(),
    activityTransitionTracker: new ActivityTransitionTracker({ windowMs: 850 }),
    sessionHandleRegistry: new SessionHandleRegistry(), cacheService: mlCache, persistSessionsToCache: () => {},
    forgetOlderCursorState: () => {}, sessionListGeneration: new SessionListGeneration(),
    getActiveStreamingStoredSessionId: () => null, getActiveStreamingMessageId: () => null, scheduleToolPatch: () => {},
    onReenterSameSession: () => {}, onSyncFocusedStream: () => {}, resetActiveStreamingState: () => {},
    setPendingScrollToBottom: () => {}, cancelSmoothScrollOnLeave: () => {}, setLastMessagesSnapshot: () => {},
    captureStreamAnchor: () => ({}), beginSessionEnter: () => {}, loadMessages: async () => {}, openBotChat: async () => {},
    ensureLiveSessionId: async () => '', incrementActiveLoadMessagesGeneration: () => 1,
  };
  await new SessionOperationService(soBase).enrichVisibleSessionPreviews();
  await new SessionOperationService(soBase).deleteSession('del-1', 'gw-a');
  assert.equal(soState.sessions.length, 0);
  const soCustom = new SessionOperationService({
    ...soBase,
    getSessionHandleRegistryForGateway: () => new SessionHandleRegistry(),
    getLiveStreamRegistryForGateway: () => new LiveStreamRegistry(),
    getConnectedGatewayClients: () => [{
      gatewayId: 'gw-a',
      client: {
        listArchivedSessions: async (prof) => ({
          ok: true,
          sessions: prof === 'default'
            ? [{ id: 'af', title: 'AF', time: 'fb-t', timestamp: 2 }, { id: 'ad', botName: 'coder', title: 'AD', time: 'fb-t2', timestamp: 3 }]
            : [],
        }),
      },
    }],
    formatSessionTime: (ts) => (ts === 2 ? 'fmt-2' : ''),
    resolveAgentAvatar: (n) => (n === 'default' ? 'av-def' : ''),
  });
  await soCustom.fetchArchivedSessions();
  assert.deepEqual(
    soState.archivedSessions.map((s) => [s.id, s.time, s.botAvatar]),
    [['ad', 'fb-t2', 'av-def'], ['af', 'fmt-2', 'av-def']],
  );
  soState.sessions = [{ id: 'del-2', gatewayId: 'gw-a', title: 'D2', timestamp: 1, time: '1', preview: '' }];
  await soCustom.deleteSession('del-2', 'gw-a');
  soState.sessions = [
    { id: 'del-3', gatewayId: 'gw-a', title: 'D3', timestamp: 1, time: '1', preview: '' },
    { id: 'del-4', gatewayId: 'gw-a', title: 'D4', timestamp: 1, time: '1', preview: '' },
  ];
  await new SessionOperationService({ ...soBase, getLiveStreamRegistry: () => new LiveStreamRegistry() }).deleteSession('del-3', 'gw-a');
  await new SessionOperationService({
    ...soBase, getLiveStreamRegistryForGateway: () => undefined, getLiveStreamRegistry: () => new LiveStreamRegistry(),
  }).deleteSession('del-4', 'gw-a');
  assert.equal(soState.sessions.length, 0);
  assert.deepEqual(soRpcMethods.filter((x) => x[0] === 'session.delete').map((x) => x[1]), ['del-1', 'del-2', 'del-3', 'del-4']);
  soState.sessions = [
    { id: 'sel-1', gatewayId: 'gw-a', title: 'S1', timestamp: 1, time: '1', preview: '' },
    { id: 'sel-2', gatewayId: 'gw-a', title: 'S2', timestamp: 1, time: '1', preview: '' },
    { id: 'sel-3', gatewayId: 'gw-a', title: 'S3', timestamp: 1, time: '1', preview: '' },
  ];
  await soCustom.selectSession('sel-1', { gatewayId: 'gw-a' });
  assert.equal(soState.activeSessionId, 'sel-1');
  await new SessionOperationService({
    ...soBase, getLiveStreamRegistryForGateway: () => undefined, getLiveStreamRegistry: () => new LiveStreamRegistry(),
  }).selectSession('sel-2', { gatewayId: 'gw-a' });
  await new SessionOperationService(soBase).selectSession('sel-3', { gatewayId: 'gw-a' });
  assert.equal(soState.activeSessionId, 'sel-3');
  assert.deepEqual(soState.activeFocus, { type: 'session', sessionId: 'sel-3', gatewayId: 'gw-a' });

  // 7. turnExecutionService with both registry getters
  const turnState = createInitialState({ platform: 'win32' });
  turnState.activeGatewayId = 'gw-t';
  const turnRegLookups = [];
  const baseTurn = {
    getState: () => turnState, getGatewayClient: () => null, getRpcCaller: () => ({ request: async () => ({}) }),
    getInteractiveService: () => new InteractiveService(), getCacheService: () => mlCache,
    getGroupRoomStore: () => ({ appendUserMessage: () => {}, isHostedRoom: () => false }),
    getActivityTransitionTracker: () => new ActivityTransitionTracker({ windowMs: 850 }),
    getTokenCoalescer: () => ({ push: () => {}, flush: () => {}, clear: () => {}, dropMessage: () => {} }),
    getSessionHandleRegistry: () => new SessionHandleRegistry(), getSessionMessagesCache: () => new Map(),
    getSessionDrafts: () => new Map(), getBotActivityStore: () => ({ updateLatestActivity: () => {} }),
    getHandoffService: () => ({ onUserMessage: () => {} }), completeEntityTurn: () => {},
    getActiveRunningSessionIds: () => new Set(), getUnreadSessionIds: () => new Set(),
    getActiveRunningBotNames: () => new Set(), getUnreadBotNames: () => new Set(),
    getActiveRunningGroupRoomIds: () => new Set(),
    getActiveStreamingContext: () => ({ activeStreamingMessageId: null, activeStreamingStoredSessionId: null, activeStreamingLiveId: null, activeStreamingBotName: null }),
    setActiveStreamingContext: () => {}, getTurnStartedSessionId: () => null, setTurnStartedSessionId: () => {},
    getSessionHistoryTrust: () => new Map(), forgetOlderCursorState: () => {}, createNewSession: async () => {},
    ensureLiveSessionId: async () => '', setMessageContent: () => {}, syncActiveGroupSpeakerFromMessages: () => {},
    scheduleToolPatch: () => {}, clearToolPatchQueue: () => {}, stopRunningToolTimers: () => {}, runSlashCommand: () => false,
    enqueueDraft: () => {}, handleQueueAction: () => {}, setMessageWindowUserExpanded: () => {}, ensureMessageWindow: () => {},
    render: () => {}, t: (k) => k,
  };
  const turnFbReg = new LiveStreamRegistry();
  const turnGwReg = new LiveStreamRegistry();
  turnGwReg.registerStream({ storedSessionId: 's-t', liveSessionId: 'l-t', messageId: 'm-t', origin: 'local' });
  createTurnExecutionService({ ...baseTurn, getLiveStreamRegistry: () => turnFbReg }).disarmTurnWatchdog();
  createTurnExecutionService({
    ...baseTurn,
    getLiveStreamRegistryForGateway: (gw) => { turnRegLookups.push(gw); return turnGwReg; },
  }).disarmTurnWatchdog();
  assert.deepEqual(turnRegLookups, ['gw-t']);
  assert.equal(turnGwReg.size(), 1);

  // 8. multiGatewayCoordinator slots, fallback live/handle reg, default args, desktop wiring & cold start/model branches
  const slotClient = { call: async () => ({}) };
  const slotCoordState = { activeFocus: { type: 'session', sessionId: 's' }, activeGatewayId: 'gw-s', gatewayConnected: true, gatewayCount: undefined, activeEntityGatewayOffline: false, profiles: [], sessions: [], groupRooms: [] };
  const coordSlots = createMultiGatewayCoordinator({
    runtime: {
      getSlot: (gw) => (gw === 'gw-s' ? { config: { id: 'gw-s', url: 'http://127.0.0.1:8655' }, connected: true, client: slotClient } : undefined),
      getClient: () => slotClient,
      getHealthSummary: () => ({ totalCount: 1, connectedCount: 1, allConnected: true, anyConnected: true, slots: [] }),
      buildAggregatedView: () => ({ health: { totalCount: 1, connectedCount: 1, allConnected: true, anyConnected: true, slots: [] }, profiles: [], sessions: [], groupRooms: [] }),
    },
    getState: () => slotCoordState,
    render: () => {},
    getFallbackHandleRegistry: () => new SessionHandleRegistry(),
    getFallbackLiveStreamRegistry: () => new LiveStreamRegistry(),
  });
  assert.ok(coordSlots.getHandleRegistry('gw-s'));
  assert.ok(coordSlots.getHandleRegistry('gw-other'));
  assert.ok(coordSlots.getHandleRegistry());
  assert.ok(coordSlots.getLiveStreamRegistry('gw-s'));
  assert.ok(coordSlots.getLiveStreamRegistry('gw-other'));
  assert.equal(coordSlots.resolveActiveClient(), slotClient);
  assert.equal(coordSlots.resolveActiveClient(slotClient), slotClient);
  assert.equal(await coordSlots.refreshAllSlotsIfMulti(), false);

  const nullCoordRuntime = {
    getSlot: () => undefined,
    getClient: () => null,
    getHealthSummary: () => ({ totalCount: 1, connectedCount: 0, allConnected: false, anyConnected: false, slots: [] }),
    buildAggregatedView: () => ({ health: { totalCount: 1, connectedCount: 0, allConnected: false, anyConnected: false, slots: [] }, profiles: [], sessions: [], groupRooms: [] }),
  };
  const nullCoord = createMultiGatewayCoordinator({
    runtime: nullCoordRuntime,
    getState: () => ({ ...slotCoordState, activeGatewayId: '' }),
    render: () => {},
  });
  assert.equal(nullCoord.resolveActiveClient(), null);
  assert.ok(nullCoord.getHandleRegistry());
  const undefHandleCoord = createMultiGatewayCoordinator({
    runtime: nullCoordRuntime,
    getState: () => ({ ...slotCoordState, activeGatewayId: '' }),
    render: () => {},
    getFallbackHandleRegistry: () => undefined,
  });
  assert.ok(undefHandleCoord.getHandleRegistry());

  const ls = createMemoryStorage({
    [GATEWAY_REGISTRY_STORAGE_KEY]: JSON.stringify([
      { id: 'gw-a', name: 'A', url: 'http://127.0.0.1:8651' },
      { id: 'gw-b', name: 'B', url: 'http://127.0.0.1:8652' },
    ]),
  });
  globalThis.WebSocket = InstantSocket;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: ls });
  let wiringWithGetter = null;
  let wiringNoOpts = null;
  let wiringAuthFail = null;
  try {
    const prim = [];
    const wState = { activeFocus: { type: 'session', sessionId: '' }, activeGatewayId: '', gatewayConnected: false, gatewayCount: 0, activeEntityGatewayOffline: false, profiles: [], sessions: [], groupRooms: [], gatewayUrl: 'http://127.0.0.1:1' };
    wiringWithGetter = createDesktopMultiGatewayWiring({
      getState: () => wState,
      getDesktopApi: () => ({ authenticateGateway: async () => ({ ok: true, message: 'ok', latency: 1, ticket: 'tk' }) }),
      getFallbackPassword: () => 'custom-pw',
      onPrimaryClientChange: (c) => prim.push(c),
      render: () => {},
    });
    await wiringWithGetter.bootstrap();
    await flushMicrotasks();
    assert.ok(prim.some(Boolean));

    // While ls still retains >= 2 gateways, clearing pool slots triggers onHealthChange with runtime.getClient() === null
    wiringWithGetter.runtime.disconnectGateway('gw-a', true);
    wiringWithGetter.runtime.disconnectGateway('gw-b', true);
    wiringWithGetter.runtime.syncGateways([]);
    await flushMicrotasks();
    assert.equal(prim.includes(null), true);

    wiringAuthFail = createDesktopMultiGatewayWiring({
      getState: () => ({ activeFocus: { type: 'session', sessionId: '' }, activeGatewayId: '', gatewayConnected: false, gatewayCount: 0, activeEntityGatewayOffline: false, profiles: [], sessions: [], groupRooms: [] }),
      getDesktopApi: () => ({ authenticateGateway: async () => ({ ok: false, message: 'denied', latency: 1 }) }),
      onPrimaryClientChange: (c) => prim.push(c),
      render: () => {},
    });
    await wiringAuthFail.bootstrap();
    await flushMicrotasks();

    wiringNoOpts = createDesktopMultiGatewayWiring({
      getState: () => ({ activeFocus: { type: 'session', sessionId: '' }, activeGatewayId: '', gatewayConnected: false, gatewayCount: 0, activeEntityGatewayOffline: false, profiles: [], sessions: [], groupRooms: [] }),
      getDesktopApi: () => ({ authenticateGateway: async () => ({ ok: true, message: 'ok', latency: 1, ticket: 'tk' }) }),
      render: () => {},
    });
    await wiringNoOpts.bootstrap();
    await flushMicrotasks();
    ls.removeItem(GATEWAY_REGISTRY_STORAGE_KEY);
    wiringNoOpts.runtime.disconnectGateway('gw-a', true);
    await flushMicrotasks();
    ls.setItem(GATEWAY_REGISTRY_STORAGE_KEY, JSON.stringify([
      { id: 'gw-a', name: 'A', url: 'http://127.0.0.1:8651' },
      { id: 'gw-b', name: 'B', url: 'http://127.0.0.1:8652' },
    ]));

    const cState = { activeFocus: { type: 'session', sessionId: '' }, profilesPhase: 'ready', gatewayUrl: '', gatewayCount: undefined, gatewayConnected: false, profileName: 'default', profiles: [], sessions: [] };
    delete globalThis.localStorage;
    const coldNoLs = createColdStartFocusRunner({
      getState: () => cState, resolveActiveClient: () => slotClient, getEffectiveUrl: (u) => u,
      selectSession: async () => {}, openBotChat: async () => {},
    });
    await coldNoLs.applyColdStartFocus();
    cState.gatewayUrl = 'http://127.0.0.1:8642';
    await coldNoLs.applyColdStartFocus();
    cState.gatewayConnected = true;
    await coldNoLs.applyColdStartFocus();
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: ls });
    const coldWithLs = createColdStartFocusRunner({
      getState: () => ({ ...cState, profiles: [{ name: 'coder' }] }),
      resolveActiveClient: () => slotClient, getEffectiveUrl: (u) => u,
      selectSession: async () => {}, openBotChat: async () => {},
    });
    await coldWithLs.applyColdStartFocus();

    const mState2 = createInitialState({ platform: 'win32' });
    mState2.profileName = '';
    const fetcher = createModelCatalogFetcher({
      getState: () => mState2,
      resolveActiveClient: () => ({ getModelCatalog: async (p) => ({ ok: true, models: [p], details: [], entries: [], currentProvider: 'p', currentModel: p }) }),
      render: () => {}, t: (k) => k,
    });
    await fetcher();
    assert.equal(mState2.selectedModel, 'default');
  } finally {
    wiringWithGetter?.runtime.dispose();
    wiringNoOpts?.runtime.dispose();
    wiringAuthFail?.runtime.dispose();
    globalThis.WebSocket = origWs;
    if (origLsDesc) Object.defineProperty(globalThis, 'localStorage', origLsDesc);
    else delete globalThis.localStorage;
  }
});

test('M1.3 Step 3 isolation: tokenStreamWriter, botActivityStore, services, coordinator & mobile actions', async (t) => {
  const origWs = globalThis.WebSocket;
  const origLsDesc = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const mlCache = new CacheService(new MemoryCacheStore(), { sessionCap: 20, messageCap: 100 });
  const noop = () => {};

  // 1. tokenStreamWriter: background gateway owner, cache key, colliding session & fallback
  const twState = createInitialState({ platform: 'win32' });
  twState.gatewayCount = 2;
  twState.activeGatewayId = 'gw-a';
  twState.activeSessionId = 's-act';
  twState.activeFocus = { type: 'bot', botName: 'default', gatewayId: 'gw-a' };
  twState.sessions = [
    { id: 's-bg', title: 'Colliding A', preview: 'keep-a', gatewayId: 'gw-a', timestamp: 1, time: '1' },
    { id: 's-bg', title: 'Real B', preview: 'old-b', gatewayId: 'gw-b', timestamp: 1, time: '1' },
  ];
  twState.messages = [{ id: 'm-act', role: 'assistant', content: 'pre:', timestamp: '10:00' }];
  const twCache = new Map();
  const twBotQueries = [];
  const twBotActs = [];
  const writer = createTokenStreamWriter({
    getState: () => twState,
    sessionMessagesCache: twCache,
    botActivityStore: {
      updateLatestActivity: (botName, content, ts, gatewayId) => {
        twBotActs.push({ botName, content, ts, gatewayId });
      },
    },
    getActiveStreamingStoredSessionId: () => 's-act',
    resolveSessionOwnerForMessage: (id) => (id === 'm-bg' ? { sessionId: 's-bg', gatewayId: 'gw-b' } : null),
    resolveSessionIdForMessage: (id) => (id === 'm-act' ? 's-act' : null),
    resolveBotNameForSession: (sid, gw) => {
      twBotQueries.push([sid, gw]);
      return gw === 'gw-b' ? 'coder' : null;
    },
    isStreamNearBottom: () => false,
    markProgrammaticScroll: noop,
  });
  writer.writeFlushedTokens(new Map([
    ['m-bg', { content: 'chunk-b', thought: 'th-b' }],
    ['m-act', { content: 'ok' }],
  ]));
  assert.equal(twCache.get(resolveScopedEntityRuntimeKey('s-bg', 'gw-b', 2))?.[0]?.content, 'chunk-b');
  assert.equal(twCache.get(resolveScopedEntityRuntimeKey('s-bg', 'gw-b', 2))?.[0]?.thought, 'th-b');
  assert.equal(twState.sessions[0].preview, 'keep-a');
  assert.equal(twState.sessions[1].preview, 'chunk-b');
  assert.equal(twState.messages[0].content, 'pre:ok');
  assert.deepEqual(twBotQueries, [['s-bg', 'gw-b']]);
  assert.deepEqual(twBotActs.map((x) => [x.botName, x.content, x.gatewayId]), [
    ['coder', 'chunk-b', 'gw-b'],
    ['default', 'ok', 'gw-a'],
  ]);

  // 2. botActivityStore.updateLatestActivity forwards gatewayId to applyBotActivity
  let baProfiles = [
    { name: 'default', displayName: 'A', gatewayId: 'gw-a' },
    { name: 'default', displayName: 'B', gatewayId: 'gw-b' },
  ];
  const baStore = createBotActivityStore({
    profiles: () => baProfiles,
    setProfiles: (next) => { baProfiles = next; },
    formatTime: (ts) => `t:${ts}`,
  });
  baStore.updateLatestActivity('default', 'act B', 1700000001000, 'gw-b');
  assert.equal(baStore.snapshot().get('gw-b:default')?.lastMessage, 'act B');
  assert.equal(baProfiles.find((p) => p.gatewayId === 'gw-b')?.lastMessage, 'act B');
  assert.equal(baProfiles.find((p) => p.gatewayId === 'gw-a')?.lastMessage, undefined);

  // 3. sessionOperationService: activeFocus.gatewayId, deleteSession stream guard, archived avatar gw, selectSession switch
  const regA = new SessionHandleRegistry();
  const regB = new SessionHandleRegistry();
  const streamRegB = new LiveStreamRegistry();
  const avatarQueries = [];
  const syncFocusedCalls = [];
  let resetStreamCount = 0;
  const soState = createInitialState({ platform: 'win32' });
  soState.gatewayCount = 2;
  soState.activeGatewayId = 'gw-a';
  soState.activeFocus = { type: 'bot', botName: 'coder', gatewayId: 'gw-b' };
  const clientA = {
    async call() { return { session_id: 'l-a', stored_session_id: 's-a' }; },
    async listArchivedSessions() { return { ok: true, sessions: [{ id: 'ar-a', title: 'AA', time: '10:00', timestamp: 1 }] }; },
  };
  const clientB = {
    async call(m) {
      if (m === 'session.create') return { session_id: 'l-new-b', stored_session_id: 's-new-b' };
      return { ok: true };
    },
    async listArchivedSessions() { return { ok: true, sessions: [{ id: 'ar-b', title: 'AB', time: '11:00', timestamp: 2 }] }; },
  };
  const soSvc = new SessionOperationService({
    getState: () => soState,
    getGatewayClient: () => clientA,
    getClientForGateway: (gw) => (gw === 'gw-b' ? clientB : clientA),
    getDesktopApi: () => ({ httpProxy: async () => ({ status: 200, body: '{}' }) }),
    getEffectiveUrl: (u) => u || '',
    getCurrentTicket: () => null,
    render: noop,
    t: (k) => k,
    showToast: noop,
    setTimedDockNotice: noop,
    restoreComposerFocus: noop,
    sessionDrafts: new Map(),
    sessionMessagesCache: new Map(),
    unreadSessionIds: new Set(),
    activeRunningSessionIds: new Set(),
    activityTransitionTracker: new ActivityTransitionTracker({ windowMs: 850 }),
    sessionHandleRegistry: regA,
    getSessionHandleRegistryForGateway: (gw) => (gw === 'gw-b' ? regB : regA),
    getLiveStreamRegistryForGateway: (gw) => (gw === 'gw-b' ? streamRegB : undefined),
    getConnectedGatewayClients: () => [{ gatewayId: 'gw-a', client: clientA }, { gatewayId: 'gw-b', client: clientB }],
    resolveAgentAvatar: (name, gw) => {
      avatarQueries.push([name, gw]);
      return `av:${gw || ''}:${name}`;
    },
    cacheService: mlCache,
    persistSessionsToCache: noop,
    forgetOlderCursorState: noop,
    sessionListGeneration: new SessionListGeneration(),
    getActiveStreamingStoredSessionId: () => 'del-col',
    onSyncFocusedStream: (sid) => syncFocusedCalls.push(sid),
    resetActiveStreamingState: () => { resetStreamCount += 1; },
    setPendingScrollToBottom: noop,
    setLastMessagesSnapshot: noop,
    loadMessages: async () => {},
    openBotChat: async () => {},
    ensureLiveSessionId: async () => '',
  });
  const createdB = await soSvc.createNewSession();
  assert.equal(createdB, 's-new-b');
  assert.equal(regB.getRegisteredLiveId('s-new-b'), 'l-new-b');
  assert.equal(regA.getRegisteredLiveId('s-new-b'), null);

  soState.activeFocus = { type: 'session', sessionId: 'other', gatewayId: 'gw-a' };
  soState.activeGatewayId = 'gw-a';
  soState.sessions = [
    { id: 'del-col', title: 'DB', gatewayId: 'gw-b', timestamp: 1, time: '1', preview: '' },
    { id: 'del-col', title: 'DA', gatewayId: 'gw-a', timestamp: 1, time: '1', preview: '' },
  ];
  await soSvc.deleteSession('del-col', 'gw-b');
  assert.equal(resetStreamCount, 0);
  await soSvc.deleteSession('del-col', 'gw-a');
  assert.equal(resetStreamCount, 1);

  await soSvc.fetchArchivedSessions();
  assert.equal(avatarQueries.some(([, gw]) => gw === 'gw-b'), true);

  soState.sessions = [
    { id: 'sel-col', title: 'SA', gatewayId: 'gw-a', timestamp: 1, time: '1', preview: '' },
    { id: 'sel-col', title: 'SB', gatewayId: 'gw-b', timestamp: 1, time: '1', preview: '' },
  ];
  soState.activeSessionId = 'sel-col';
  soState.activeGatewayId = 'gw-a';
  soState.activeFocus = { type: 'session', sessionId: 'sel-col', gatewayId: 'gw-a' };
  const soSelSvc = new SessionOperationService({
    getState: () => soState,
    getGatewayClient: () => clientA,
    getClientForGateway: (gw) => (gw === 'gw-b' ? clientB : clientA),
    getEffectiveUrl: (u) => u || '',
    getCurrentTicket: () => null,
    render: noop,
    t: (k) => k,
    showToast: noop,
    setTimedDockNotice: noop,
    restoreComposerFocus: noop,
    sessionDrafts: new Map(),
    sessionMessagesCache: new Map(),
    unreadSessionIds: new Set(),
    activeRunningSessionIds: new Set(),
    activityTransitionTracker: new ActivityTransitionTracker({ windowMs: 850 }),
    sessionHandleRegistry: regA,
    getLiveStreamRegistryForGateway: (gw) => (gw === 'gw-b' ? streamRegB : undefined),
    cacheService: mlCache,
    persistSessionsToCache: noop,
    forgetOlderCursorState: noop,
    sessionListGeneration: new SessionListGeneration(),
    getActiveStreamingStoredSessionId: () => 'sel-col',
    onSyncFocusedStream: (sid) => syncFocusedCalls.push(sid),
    resetActiveStreamingState: noop,
    setPendingScrollToBottom: noop,
    setLastMessagesSnapshot: noop,
    loadMessages: async () => {},
    openBotChat: async () => {},
    ensureLiveSessionId: async () => '',
  });
  await soSelSvc.selectSession('sel-col', { gatewayId: 'gw-b' });
  assert.equal(soState.isStreaming, false);
  streamRegB.registerStream({ storedSessionId: 'sel-col', liveSessionId: 'l-sel-b', messageId: 'm-sel-b', origin: 'remote' });
  soState.activeSessionId = 'other-s';
  await soSelSvc.selectSession('sel-col', { gatewayId: 'gw-b' });
  assert.equal(soState.isStreaming, true);
  assert.deepEqual(syncFocusedCalls, ['sel-col']);

  // 4. turnExecutionService: sendMessage per-gw handleReg + activity & probeWatchdogAuthority scoping
  const tState = createInitialState({ platform: 'win32' });
  tState.gatewayCount = 2;
  tState.activeGatewayId = 'gw-a';
  tState.activeSessionId = 'turn-s';
  tState.activeFocus = { type: 'bot', botName: 'default', gatewayId: 'gw-b' };
  tState.sessions = [
    { id: 'turn-s', title: 'TA', botName: 'coder', gatewayId: 'gw-a', timestamp: 1, time: '1', preview: '' },
    { id: 'turn-s', title: 'TB', botName: 'default', gatewayId: 'gw-b', timestamp: 1, time: '1', preview: '' },
  ];
  const turnRegA = new SessionHandleRegistry();
  const turnRegB = new SessionHandleRegistry();
  const turnStreamB = new LiveStreamRegistry();
  const turnActs = [];
  const turnBotLookups = [];
  const turnResumes = [];
  let streamCtx = {
    activeStreamingMessageId: null,
    activeStreamingStoredSessionId: null,
    activeStreamingLiveId: null,
    activeStreamingBotName: null,
  };
  const turnClientB = {
    async call(m, params) {
      if (m === 'prompt.submit') return { run_id: 'r1' };
      if (m === 'session.resume') {
        turnResumes.push(params);
        return { running: false };
      }
      return {};
    },
  };
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const turnSvc = createTurnExecutionService({
    getState: () => tState,
    getGatewayClient: () => clientA,
    getClientForGateway: (gw) => (gw === 'gw-b' ? turnClientB : clientA),
    getRpcCaller: () => ({ request: async () => ({}) }),
    getInteractiveService: () => new InteractiveService(),
    getCacheService: () => mlCache,
    getGroupRoomStore: () => ({ appendUserMessage: noop, isHostedRoom: () => false, getLogs: () => [] }),
    getActivityTransitionTracker: () => new ActivityTransitionTracker({ windowMs: 850 }),
    getTokenCoalescer: () => ({ push: noop, flush: noop, clear: noop, dropMessage: noop }),
    getSessionHandleRegistry: () => turnRegA,
    getSessionHandleRegistryForGateway: (gw) => (gw === 'gw-b' ? turnRegB : turnRegA),
    getLiveStreamRegistryForGateway: (gw) => (gw === 'gw-b' ? turnStreamB : undefined),
    resolveBotNameForSession: (sid, gw) => {
      turnBotLookups.push([sid, gw]);
      return 'resolved-b';
    },
    getSessionMessagesCache: () => new Map(),
    getSessionDrafts: () => new Map(),
    getBotActivityStore: () => ({ updateLatestActivity: (b, c, _ts, g) => turnActs.push([b, c, g]) }),
    getHandoffService: () => ({ onUserMessage: noop }),
    completeEntityTurn: noop,
    getActiveRunningSessionIds: () => new Set(),
    getUnreadSessionIds: () => new Set(),
    getActiveRunningBotNames: () => new Set(),
    getUnreadBotNames: () => new Set(),
    getActiveRunningGroupRoomIds: () => new Set(),
    getActiveStreamingContext: () => streamCtx,
    setActiveStreamingContext: (p) => { streamCtx = { ...streamCtx, ...p }; },
    getTurnStartedSessionId: () => null,
    setTurnStartedSessionId: noop,
    getSessionHistoryTrust: () => new Map(),
    forgetOlderCursorState: noop,
    createNewSession: async () => {},
    ensureLiveSessionId: async () => 'live-turn-b',
    setMessageContent: noop,
    syncActiveGroupSpeakerFromMessages: noop,
    scheduleToolPatch: noop,
    clearToolPatchQueue: noop,
    stopRunningToolTimers: noop,
    runSlashCommand: () => false,
    enqueueDraft: noop,
    handleQueueAction: noop,
    setMessageWindowUserExpanded: noop,
    ensureMessageWindow: noop,
    scrollStreamToBottom: noop,
    setPendingScrollToBottom: noop,
    render: noop,
    t: (k) => k,
  });
  try {
    await turnSvc.sendMessage('hi B');
    assert.equal(turnRegB.getRegisteredLiveId('turn-s'), 'live-turn-b');
    assert.equal(turnRegA.getRegisteredLiveId('turn-s'), null);
    assert.deepEqual(turnActs, [['default', 'hi B', 'gw-b']]);
    tState.gatewayConnected = true;
    tState.activeFocus = { type: 'session', sessionId: 'turn-s', gatewayId: 'gw-b' };
    tState.sessions = [{ id: 'turn-s', title: 'NoBot', gatewayId: 'gw-b', timestamp: 1, time: '1', preview: '' }];
    turnStreamB.removeSession('turn-s');
    turnSvc.armTurnWatchdog();
    t.mock.timers.tick(60_000);
    await flushMicrotasks(12);
    assert.deepEqual(turnBotLookups, [['turn-s', 'gw-b']]);
    assert.equal(turnResumes.length, 1);
  } finally {
    turnSvc.disarmTurnWatchdog(true);
    turnSvc.clearPresenceTerminal();
    t.mock.timers.reset();
  }

  // 5. messageLoadingService: targetGw on reconnect hooks & syncActiveSessionToBot
  const mlState = createInitialState({ platform: 'win32' });
  mlState.gatewayCount = 2;
  mlState.profiles = [
    { name: 'default', displayName: 'A', gatewayId: 'gw-a' },
    { name: 'default', displayName: 'B', gatewayId: 'gw-b' },
  ];
  const mlRegB = new LiveStreamRegistry();
  const stillGws = [];
  const finGws = [];
  const discGws = [];
  let resumeRunning = true;
  const mlClientB = {
    async call(m) {
      if (m === 'session.resume') {
        return { session_id: 'l-rec', stored_session_id: 'ml-rec', running: resumeRunning };
      }
      return {};
    },
    async fetchSessionMessages() {
      return { status: 'success', messages: [{ id: 'm1', role: 'user', content: 'hi', timestamp: 1700000000 }], pagination: { returned: 1 } };
    },
  };
  const mlSvc = new MessageLoadingService({
    getState: () => mlState,
    getGatewayClient: () => clientA,
    getClientForGateway: (gw) => (gw === 'gw-b' ? mlClientB : clientA),
    render: noop,
    sessionMessagesCache: new Map(),
    cacheService: mlCache,
    persistMessagesToCache: noop,
    syncPromptNavigatorMeta: noop,
    syncPromptNavigatorFromScroll: noop,
    scrollStreamToBottom: noop,
    setPendingScrollToBottom: noop,
    isStreamNearBottom: () => false,
    captureStreamAnchor: () => ({}),
    applyStreamAnchor: noop,
    getMessageWindowStart: () => 0,
    setMessageWindowStart: noop,
    getMessageWindowEnd: () => 50,
    setMessageWindowEnd: noop,
    setMessageWindowUserExpanded: noop,
    isGroupConversationActive: () => false,
    hostedRoomIds: new Set(),
    formatSessionTime: () => '10:00',
    formatTimestamp: () => '10:00',
    botActivityStore: { withActivityMap: (fn) => fn(new Map()), persist: noop },
    botForeverChatCache: new Map([['gw-a:default', 'ml-disc'], ['gw-b:default', 'ml-disc']]),
    sessionPreviewCache: new Map(),
    persistSessionPreviewCache: noop,
    getActiveStreamingStoredSessionId: () => null,
    getLiveStreamRegistryForGateway: (gw) => (gw === 'gw-b' ? mlRegB : undefined),
    defaultSessionHandleRegistry: new SessionHandleRegistry(),
    getSessionHandleRegistryForGateway: () => new SessionHandleRegistry(),
    activeRunningSessionIds: new Set(),
    activityTransitionTracker: new ActivityTransitionTracker({ windowMs: 850 }),
    onReconnectStillStreaming: (_s, _l, _r, gw) => stillGws.push(gw),
    onReconnectStreamFinished: (_s, gw) => finGws.push(gw),
    onActiveTurnDiscovered: (p) => discGws.push([p.botName, p.gatewayId]),
  });
  mlRegB.registerStream({ storedSessionId: 'ml-rec', liveSessionId: 'l-rec', messageId: 'mr', origin: 'remote' });
  await mlSvc.loadMessagesInner('ml-rec', 'default', { checkLiveTurn: true }, 'gw-b');
  resumeRunning = false;
  await mlSvc.loadMessagesInner('ml-rec', 'default', { checkLiveTurn: true }, 'gw-b');
  mlRegB.removeSession('ml-rec');
  resumeRunning = true;
  await mlSvc.loadMessagesInner('ml-disc', undefined, {}, 'gw-b');
  await flushMicrotasks(15);
  assert.deepEqual(stillGws, ['gw-b']);
  assert.deepEqual(finGws, ['gw-b']);
  assert.deepEqual(discGws, [['default', 'gw-b']]);

  // 6. multiGatewayCoordinator: seedCachedSlicesFromState, wakeAllSlots & matchesForeverChatSession
  assert.equal(matchesForeverChatSession(new Map([['gw-a:default', 'f-col'], ['gw-b:coder', 'f-other']]), 'f-col', 'default', 'gw-b'), false);
  assert.equal(matchesForeverChatSession(new Map([['gw-a:default', 'f-col'], ['gw-b:coder', 'f-other']]), 'f-col', 'default', 'gw-a'), true);

  let runtimeSeed = null;
  let wiringWake = null;
  let mobile = null;
  try {
    runtimeSeed = createMultiGatewayRuntime({
      getDesktopApi: () => undefined,
      resolvePassword: async () => '',
    });
    const seedState = createInitialState({ platform: 'win32' });
    const seedCoord = createMultiGatewayCoordinator({
      runtime: runtimeSeed,
      getState: () => seedState,
      render: noop,
    });
    assert.equal(seedCoord.seedCachedSlicesFromState(), false);
    runtimeSeed.syncGateways([
      { id: 'gw-a', name: 'A', url: 'http://127.0.0.1:8701' },
      { id: 'gw-b', name: 'B', url: 'http://127.0.0.1:8702' },
    ]);
    assert.equal(seedCoord.seedCachedSlicesFromState({
      profiles: [{ name: 'default', displayName: 'B', gatewayId: 'gw-b' }],
      sessions: [{ id: 's-seed', title: 'S', gatewayId: 'gw-b', timestamp: 1, time: '1', preview: '' }],
      groups: [
        { roomId: 'r-summary', name: 'RS', members: ['default'], createdAt: 1, updatedAt: 2, lastMessagePreview: 'sum', isDisbanded: false, gatewayId: 'gw-b', authorityGatewayId: 'gw-b', authorityEpoch: 1 },
        { roomId: 'r-rail', name: 'RR', members: ['default'], lastMessage: 'rail-msg', gatewayId: 'gw-b', gatewayLabel: 'Beta', gatewayOffline: true, crossGateway: true },
        { roomId: 'r-empty', name: 'RE', members: ['default'], gatewayId: 'gw-b' },
      ],
    }), true);
    assert.equal(seedState.groupRooms.find((g) => g.roomId === 'r-rail')?.lastMessagePreview, 'rail-msg');
    assert.equal(seedCoord.seedCachedSlicesFromState({
      profiles: [{ name: 'default', displayName: 'B', gatewayId: 'gw-b' }],
    }), false);
    const connCoord = createMultiGatewayCoordinator({
      runtime: {
        getSlot: () => undefined,
        getClient: () => null,
        getHealthSummary: () => ({
          totalCount: 2, connectedCount: 1, allConnected: false, anyConnected: true,
          slots: [{ gatewayId: 'gw-a', connected: true }, { gatewayId: 'gw-b', connected: false }],
        }),
        buildAggregatedView: () => ({
          health: { totalCount: 2, connectedCount: 1, allConnected: false, anyConnected: true, slots: [] },
          profiles: [], sessions: [], groupRooms: [],
        }),
      },
      getState: () => seedState,
      render: noop,
    });
    assert.equal(connCoord.seedCachedSlicesFromState({
      profiles: [{ name: 'a', displayName: 'A', gatewayId: 'gw-a' }],
    }), false);

    let failSocketOnB = false;
    class WakeSocket {
      constructor(url) {
        this.url = url;
        this.readyState = 0;
        if (url.includes('8712') && failSocketOnB) {
          queueMicrotask(() => { this.readyState = 3; this.onclose?.({ code: 1006, reason: 'down' }); });
        } else {
          queueMicrotask(() => { this.readyState = 1; this.onopen?.(); });
        }
      }
      send(raw) {
        const f = JSON.parse(raw);
        if (f.id != null) queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ jsonrpc: '2.0', id: f.id, result: { ok: true } }) }));
      }
      close(code = 1000, reason = 'c') { this.readyState = 3; this.onclose?.({ code, reason }); }
    }
    globalThis.WebSocket = WakeSocket;
    const lsWake = createMemoryStorage({
      [GATEWAY_REGISTRY_STORAGE_KEY]: JSON.stringify([
        { id: 'gw-a', name: 'A', url: 'http://127.0.0.1:8711' },
        { id: 'gw-b', name: 'B', url: 'http://127.0.0.1:8712' },
      ]),
    });
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: lsWake });
    wiringWake = createDesktopMultiGatewayWiring({
      getState: () => createInitialState({ platform: 'win32' }),
      getDesktopApi: () => ({ authenticateGateway: async () => ({ ok: true, message: 'ok', latency: 1, ticket: 'tk' }) }),
      render: noop,
    });
    await wiringWake.bootstrap();
    assert.equal(await wiringWake.wakeAllSlots(), 'alive');
    const resumeCalls = [];
    const handlers = createAppBootstrapGatewayHandlers({
      multiGateway: wiringWake,
      connectLegacy: noop,
      wakeLegacy: async () => 'alive',
      syncOnConnected: noop,
      syncOnResumeAlive: () => { resumeCalls.push('alive'); },
    });
    assert.equal(await handlers.onWakeOrRetry('focus'), 'alive');
    failSocketOnB = true;
    wiringWake.runtime.disconnectGateway('gw-b', false);
    assert.equal(await wiringWake.wakeAllSlots(), 'reconnecting');
    assert.equal(await handlers.onWakeOrRetry('focus'), 'reconnecting');
    wiringWake.runtime.disconnectGateway('gw-a', false);
    assert.equal(await wiringWake.wakeAllSlots(), 'disconnected');
    const fakeWakeDisc = await createAppBootstrapGatewayHandlers({
      multiGateway: {
        isMultiGatewayConfigured: () => true,
        bootstrap: async () => {},
        wakeAllSlots: async () => 'disconnected',
      },
      connectLegacy: noop,
      wakeLegacy: async () => 'alive',
      syncOnConnected: noop,
      syncOnResumeAlive: () => { resumeCalls.push('should-not'); },
    }).onWakeOrRetry('focus');
    assert.equal(fakeWakeDisc, 'disconnected');
    assert.deepEqual(resumeCalls, ['alive', 'alive']);

    // 7. profileManagementService: per-gw ProfileService, syncSessionBotDisplayNames, avatarCache, activity gw
    const pmState = createInitialState({ platform: 'win32' });
    pmState.gatewayCount = 2;
    pmState.activeGatewayId = 'gw-a';
    pmState.sessions = [
      { id: 's-da', botName: 'default', botDisplayName: 'OldA', gatewayId: 'gw-a', title: 'A', timestamp: 1, time: '1', preview: '' },
      { id: 's-db', botName: 'default', botDisplayName: 'OldB', gatewayId: 'gw-b', title: 'B', timestamp: 1, time: '1', preview: '' },
    ];
    const pmRegA = new SessionHandleRegistry();
    const pmRegB = new SessionHandleRegistry();
    const pmActs = [];
    const pmClientB = {
      async listProfiles() { return []; },
      async call(m) {
        if (m === 'session.list') return { sessions: [] };
        if (m === 'session.create') return { session_id: 'l-fc-b', stored_session_id: 's-fc-b' };
        return { success: true };
      },
      async request(m, p) { return this.call(m, p); },
      async fetchSessionMessages() {
        return { status: 'success', messages: [{ parts: [{ type: 'text', text: 'latest B' }], timestamp: 1700000002 }] };
      },
    };
    const pmSvc = createProfileManagementService({
      getState: () => pmState,
      getGatewayClient: () => pmClientB,
      getClientForGateway: (gw) => (gw === 'gw-b' ? pmClientB : clientA),
      getSessionHandleRegistryForGateway: (gw) => (gw === 'gw-b' ? pmRegB : pmRegA),
      render: noop,
      t: (k) => k,
      describeRpcError: (e) => String(e),
      botActivityStore: { updateLatestActivity: (b, txt, _ts, gw) => pmActs.push([b, txt, gw]) },
      unreadBotNames: new Set(),
      activityTransitionTracker: new ActivityTransitionTracker({ windowMs: 850 }),
      sessionMessagesCache: new Map(),
      syncProfileLastMessages: noop,
      applyColdStartFocus: async () => {},
      cancelColdStartFocus: noop,
      fetchSessions: async () => {},
      fetchModelOptions: async () => {},
      selectSession: async () => {},
      openGroupRoom: async () => {},
      restoreComposerFocus: noop,
      disarmRollbackOnLeave: noop,
      persistAgentsToCache: noop,
      persistAvatarCache: noop,
      nextLoadMessagesGeneration: () => 1,
      getCurrentLoadMessagesGeneration: () => 1,
    });
    pmSvc.syncSessionBotDisplayNames([{ name: 'default', displayName: 'NewB', gatewayId: 'gw-b' }]);
    assert.equal(pmState.sessions[0].botDisplayName, 'OldA');
    assert.equal(pmState.sessions[1].botDisplayName, 'NewB');
    await pmSvc.warmBotForeverChats([{ name: 'default', displayName: 'NewB', gatewayId: 'gw-b' }], pmClientB);
    assert.equal(pmRegB.getRegisteredLiveId('s-fc-b'), 'l-fc-b');
    assert.equal(pmRegA.getRegisteredLiveId('s-fc-b'), null);
    assert.deepEqual(pmActs, [['default', 'latest B', 'gw-b']]);

    // 8. mobileShellCoordinator: action-sheet callbacks forward gatewayId
    const mCalls = [];
    const mState = createInitialState({ platform: 'ios' });
    mobile = createMobileShellCoordinator({
      getState: () => mState,
      render: noop,
      leftRailController: { decorateRailProfiles: (x) => x, decorateRailGroups: (x) => x, decorateRailSessions: (x) => x },
      resolveAgentAvatar: () => '',
      selectSession: async (id, o) => { mCalls.push(['select', id, o?.gatewayId]); },
      openBotChat: async (b, g) => { mCalls.push(['bot', b, g]); },
      openGroupRoom: async (r, g) => { mCalls.push(['group', r, g]); },
      createNewSession: async () => null,
      renameSession: async (id, _c, next, g) => { mCalls.push(['renameSess', id, next, g]); },
      pinSession: async (id, g) => { mCalls.push(['pin', id, g]); },
      archiveSession: async (id, _b, g) => { mCalls.push(['arch', id, g]); },
      deleteSession: async (id, g) => { mCalls.push(['del', id, g]); },
      markDoneConfirmed: async (k, id, _p, g) => { mCalls.push(['done', k, id, g]); return true; },
      restoreDone: async (k, id, _p, g) => { mCalls.push(['restore', k, id, g]); return true; },
      moveEntityToFolder: async (k, id, _c, _p, g) => { mCalls.push(['move', k, id, g]); return true; },
      createFolder: async (_n, target) => { mCalls.push(['mkdir', target?.gatewayId]); return 'f1'; },
      createGroupRoom: async () => null,
      confirmGroupRename: async (r, n, g) => { mCalls.push(['renameGrp', r, n, g]); },
      disbandGroupRoom: async (r, g) => { mCalls.push(['disband', r, g]); },
      fetchGroupRooms: async () => {},
      routeSend: async () => {},
      sendGroupMessage: async () => {},
      interruptTurn: async () => {},
      switchModel: async () => {},
      getSettingsSnapshot: () => ({}),
      createSettingsActions: () => ({}),
      ensureSettingsSectionData: noop,
      copyText: async () => true,
      storage: createMemoryStorage(),
    });
    const ma = mobile.getActions();
    ma.onActionOpen({ kind: 'bot', id: 'default', title: 'B', gatewayId: 'gw-b' });
    ma.onActionOpen({ kind: 'group', id: 'r1', title: 'R', gatewayId: 'gw-b' });
    ma.onActionOpen({ kind: 'session', id: 's1', title: 'S', gatewayId: 'gw-b' });
    ma.onActionRename({ kind: 'group', id: 'r1', title: 'R', gatewayId: 'gw-b' }, 'R2');
    ma.onActionRename({ kind: 'session', id: 's1', title: 'S', gatewayId: 'gw-b' }, 'S2');
    ma.onActionPin({ kind: 'session', id: 's1', title: 'S', gatewayId: 'gw-b' });
    ma.onActionArchive({ kind: 'session', id: 's1', title: 'S', botName: 'default', gatewayId: 'gw-b' });
    ma.onActionMarkDone({ kind: 'session', id: 's1', title: 'S', botName: 'default', gatewayId: 'gw-b' });
    ma.onActionRestoreDone({ kind: 'group', id: 'r1', title: 'R', gatewayId: 'gw-b' });
    ma.onActionMoveToFolder({ kind: 'session', id: 's1', title: 'S', gatewayId: 'gw-b' }, 'f1');
    ma.onActionCreateFolder('F1', { kind: 'session', id: 's1', title: 'S', gatewayId: 'gw-b' });
    ma.onActionDelete({ kind: 'session', id: 's1', title: 'S', gatewayId: 'gw-b' });
    ma.onActionDisband({ kind: 'group', id: 'r1', title: 'R', gatewayId: 'gw-b' });
    await flushMicrotasks(8);
    assert.deepEqual(mCalls, [
      ['bot', 'default', 'gw-b'],
      ['group', 'r1', 'gw-b'],
      ['select', 's1', 'gw-b'],
      ['renameGrp', 'r1', 'R2', 'gw-b'],
      ['renameSess', 's1', 'S2', 'gw-b'],
      ['pin', 's1', 'gw-b'],
      ['arch', 's1', 'gw-b'],
      ['done', 'session', 's1', 'gw-b'],
      ['restore', 'group', 'r1', 'gw-b'],
      ['move', 'session', 's1', 'gw-b'],
      ['mkdir', 'gw-b'],
      ['del', 's1', 'gw-b'],
      ['disband', 'r1', 'gw-b'],
    ]);
  } finally {
    mobile?.dispose();
    wiringWake?.runtime.dispose();
    runtimeSeed?.dispose();
    globalThis.WebSocket = origWs;
    if (origLsDesc) Object.defineProperty(globalThis, 'localStorage', origLsDesc);
    else delete globalThis.localStorage;
  }
});
