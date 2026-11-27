/**
 * M1.3 服务层与边界分支全路径单测补全 (Multi-Gateway Services & Coordinator Edges)
 * (packages/desktop/__tests__/unit/m1-3-multi-gateway-services.test.mjs)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ActivityTransitionTracker,
  LiveStreamRegistry,
  SessionHandleRegistry,
} from '@hermes-flux/core';
import { GATEWAY_REGISTRY_STORAGE_KEY } from '../../dist/renderer/gateway/gatewayRegistryStore.mjs';
import { createMultiGatewayRuntime } from '../../dist/renderer/gateway/multiGatewayRuntime.mjs';
import {
  createActiveLiveSessionIdResolver,
  createDesktopMultiGatewayWiring,
} from '../../dist/renderer/gateway/multiGatewayCoordinator.mjs';
import {
  createInitialState,
  resolveScopedEntityRuntimeKey,
} from '../../dist/renderer/state/appState.mjs';
import { createModalInteractionController } from '../../dist/renderer/events/modalInteractionController.mjs';
import { createGroupOperationService } from '../../dist/renderer/services/groupOperationService.mjs';
import { createMessageLoadingService } from '../../dist/renderer/services/messageLoadingService.mjs';
import { createProfileManagementService } from '../../dist/renderer/services/profileManagementService.mjs';
import { createSessionOperationService } from '../../dist/renderer/services/sessionOperationService.mjs';
import { createTurnExecutionService } from '../../dist/renderer/services/turnExecutionService.mjs';

function createMemoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
  };
}

class MockSocket {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  send(raw) {
    const frame = JSON.parse(raw);
    if (frame.id != null) {
      queueMicrotask(() => {
        this.onmessage?.({ data: JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: { ok: true } }) });
      });
    }
  }
  close(code = 1000, reason = 'closed') {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
}

async function flushMicrotasks(rounds = 10) {
  for (let i = 0; i < rounds; i += 1) {
    await Promise.resolve();
  }
}

function createFakeCacheService() {
  return {
    async openChannel() { return { rows: [], fenceMax: 0 }; },
    async dropChannel() {},
    async readOlderRows() { return []; },
    async truncate() {},
  };
}

test('M1.3 Runtime executeRestProxy + Coordinator edge branches & createActiveLiveSessionIdResolver', async () => {
  const origWs = globalThis.WebSocket;
  const origLsDesc = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const sockets = [];
  globalThis.WebSocket = class extends MockSocket {
    constructor(url) {
      super(url);
      sockets.push(this);
      queueMicrotask(() => this.open());
    }
  };
  const ls = createMemoryStorage({});
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, writable: true, value: ls });

  try {
    // 1. Runtime executeRestProxy WITH desktopApi.httpProxy, WITH {} (no httpProxy), and WITHOUT desktopApi (undefined)
    const proxyCalls = [];
    let apiMode = 'proxy';
    const rt = createMultiGatewayRuntime({
      getDesktopApi: () => {
        if (apiMode === 'undefined') return undefined;
        return {
          authenticateGateway: async () => ({ ok: true, message: 'ok', latency: 1, ticket: 'tk-rest' }),
          ...(apiMode === 'proxy'
            ? {
                httpProxy: async (req) => {
                  proxyCalls.push(req);
                  return { status: 200, data: { sessions: [] } };
                },
              }
            : {}),
        };
      },
      resolvePassword: async () => 'pw',
    });
    try {
      rt.syncGateways([{ id: 'gw-1', name: 'One', url: 'http://one.local:8642' }]);
      await rt.connectGateway('gw-1');
      await flushMicrotasks();
      const slot = rt.getSlot('gw-1');
      await slot.client.listSessions('default', 10);
      assert.equal(proxyCalls.length >= 1, true);
      assert.equal(proxyCalls[0].baseUrl, 'http://one.local:8642');
      apiMode = 'empty';
      await slot.client.listSessions('default', 10);
      apiMode = 'undefined';
      const wsFallback = await slot.client.listSessions('default', 10);
      assert.equal(typeof wsFallback.ok, 'boolean');
    } finally {
      rt.dispose();
    }

    // 2. Coordinator without getFallbackClient / empty URL / resolveActiveLiveSessionId edge branches
    const emptyState = createInitialState({ platform: 'win32' });
    emptyState.gatewayUrl = '';
    const wiringNoFallback = createDesktopMultiGatewayWiring({
      getState: () => emptyState,
      getDesktopApi: () => undefined,
      render: () => {},
      onForwardActiveSlotEvent: () => {},
    });
    try {
      assert.equal(wiringNoFallback.coordinator.resolveClient('missing'), null);
      assert.equal(wiringNoFallback.coordinator.resolveClient(), null);
      assert.equal(wiringNoFallback.coordinator.getGatewayUrl(), '');

      // Fire pool health change BEFORE bootstrap() to exercise !started early return
      wiringNoFallback.runtime.syncGateways([
        { id: 'gw-pre', name: 'Pre', url: 'http://pre.local:8642' },
      ]);
      await wiringNoFallback.runtime.disconnectGateway('gw-pre', true);
    } finally {
      wiringNoFallback.runtime.dispose();
    }

    // 3. Multi-gateway slot event forwarding when activeFocus lacks gatewayId / is undefined & default resolveClient()
    ls.setItem(
      GATEWAY_REGISTRY_STORAGE_KEY,
      JSON.stringify([
        { id: 'gw-a', name: 'Alpha', url: 'http://alpha.local:8642' },
        { id: 'gw-b', name: 'Beta', url: 'http://beta.local:8643' },
      ]),
    );
    const mState = createInitialState({ platform: 'win32' });
    mState.gatewayUrl = '';
    mState.activeFocus = { type: 'session', sessionId: 's1' };
    mState.activeGatewayId = 'gw-b';
    const forwarded = [];
    const wiringMulti = createDesktopMultiGatewayWiring({
      getState: () => mState,
      getDesktopApi: () => ({ authenticateGateway: async () => ({ ok: true, message: 'ok', latency: 1, ticket: 'tk-m' }) }),
      render: () => {},
      onForwardActiveSlotEvent: (p) => forwarded.push(p),
    });
    try {
      await wiringMulti.bootstrap();
      await flushMicrotasks();
      assert.notEqual(wiringMulti.coordinator.resolveClient(), null);
      assert.equal(wiringMulti.coordinator.resolveClient('unknown-gw'), null);

      const sockB = sockets.filter((s) => s.url.includes('beta.local')).at(-1);
      // activeFocus undefined -> falls back to activeGatewayId ('gw-b'), legacyUrl empty -> forwarded
      mState.activeFocus = undefined;
      sockB.onmessage?.({ data: JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { n: 1 } }) });
      // activeFocus defined without gatewayId -> falls back to activeGatewayId
      mState.activeFocus = { type: 'session', sessionId: 's1' };
      sockB.onmessage?.({ data: JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { n: 2 } }) });
      // activeGw empty -> not forwarded; same legacyUrl as slotUrl -> not forwarded
      mState.activeGatewayId = '';
      sockB.onmessage?.({ data: JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { n: 3 } }) });
      mState.activeGatewayId = 'gw-b';
      mState.gatewayUrl = 'http://beta.local:8643/';
      sockB.onmessage?.({ data: JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { n: 4 } }) });
      assert.deepEqual(forwarded, [{ n: 1 }, { n: 2 }]);
    } finally {
      wiringMulti.runtime.dispose();
    }

    // 4. createActiveLiveSessionIdResolver: gatewayCount undefined / <2 hit vs >=2 with activeGw
    const handleReg = new SessionHandleRegistry();
    handleReg.register({ storedId: 's-reg', liveId: 'live-from-reg' });
    const lState = createInitialState({ platform: 'win32' });
    lState.gatewayCount = undefined;
    lState.activeGatewayId = '';
    lState.activeFocus = { type: 'session', sessionId: 's-reg' };
    lState.activeSessionId = 's-reg';
    lState.activeLiveSessionId = '';
    const liveResolver = createActiveLiveSessionIdResolver({
      getState: () => lState,
      resolveClient: () => ({
        async call() { return { session_id: 'live-from-rpc', stored_session_id: 's-reg' }; },
      }),
      sessionHandleRegistry: handleReg,
      getGeneration: () => 1,
      describeRpcError: (e) => String(e),
    });
    assert.equal(await liveResolver(), 'live-from-reg');

    // Registered miss when gatewayCount === 2 and activeGw present
    lState.gatewayCount = 2;
    lState.activeGatewayId = 'gw-b';
    lState.activeFocus = { type: 'session', sessionId: 's-reg', gatewayId: 'gw-b' };
    lState.activeLiveSessionId = '';
    assert.equal(await liveResolver(), 'live-from-rpc');
  } finally {
    globalThis.WebSocket = origWs;
    if (origLsDesc) Object.defineProperty(globalThis, 'localStorage', origLsDesc);
    else delete globalThis.localStorage;
  }
});

test('M1.3 ModalInteraction / GroupOperation / ProfileManagement / MessageLoading remaining branches', async () => {
  // 1. ModalInteractionController: archive/mark-done with & without requestMarkDone + move-folder
  const markedDone = [];
  const archived = [];
  const moved = [];
  const modalState = createInitialState({ platform: 'win32' });
  const baseModalDeps = {
    getState: () => modalState,
    commitState: (p) => Object.assign(modalState, p),
    requestRender: () => {},
    restoreComposerFocus: () => {},
    createNewSession: async () => null,
    deleteSession: async () => {},
    renameSession: async () => {},
    pinSession: async () => {},
    archiveSession: async (id, prof, gw) => { archived.push([id, prof, gw]); },
    exportMarkdown: async () => {},
    copySessionId: async () => {},
    openBotChat: async () => {},
    openBotSettings: () => {},
    openGroupRoom: async () => {},
    createGroupRoom: async () => null,
    disbandGroupRoom: async () => {},
    fetchGroupRooms: async () => {},
    moveEntityToFolder: async (kind, id, fid, prof, gw) => { moved.push([kind, id, fid, prof, gw]); },
    t: (k) => k,
  };
  const modalWithMarkDone = createModalInteractionController({
    ...baseModalDeps,
    requestMarkDone: (kind, id, name, prof, gw) => { markedDone.push([kind, id, name, prof, gw]); },
  });
  modalWithMarkDone.handleContextMenuAction('archive', { x: 0, y: 0, targetType: 'session', targetId: 's1', targetName: 'S1', sessionProfile: 'coder', gatewayId: 'gw-b' });
  modalWithMarkDone.handleContextMenuAction('move-folder:fld-1', { x: 0, y: 0, targetType: 'group', targetId: 'g1', targetName: 'G1', gatewayId: 'gw-b' });
  assert.deepEqual(markedDone, [['session', 's1', 'S1', 'coder', 'gw-b']]);
  assert.deepEqual(moved, [['group', 'g1', 'fld-1', undefined, 'gw-b']]);

  const modalWithoutMarkDone = createModalInteractionController(baseModalDeps);
  modalWithoutMarkDone.handleContextMenuAction('mark-done', { x: 0, y: 0, targetType: 'session', targetId: 's2', targetName: 'S2', sessionProfile: 'default', gatewayId: 'gw-a' });
  modalWithoutMarkDone.handleContextMenuAction('mark-done', { x: 0, y: 0, targetType: 'group', targetId: 'g2', targetName: 'G2', gatewayId: 'gw-a' });
  assert.deepEqual(archived, [['s2', 'default', 'gw-a']]);

  // 2. GroupOperationService: fallback room match (line 209), omitted getClientForGateway & running sets, disband targetGw filtering
  const gState = createInitialState({ platform: 'win32' });
  gState.gatewayCount = 2;
  gState.activeGatewayId = '';
  gState.groupRooms = [
    { roomId: 'room-x', name: 'NoGw', members: ['coder'], createdAt: 1, updatedAt: 1 },
    { roomId: 'room-x', name: 'MatchA', members: ['coder'], createdAt: 1, updatedAt: 1, gatewayId: 'gw-a' },
    { roomId: 'room-x', name: 'OtherB', members: ['coder'], createdAt: 1, updatedAt: 1, gatewayId: 'gw-b' },
    { roomId: 'room-keep', name: 'Keep', members: ['coder'], createdAt: 1, updatedAt: 1, gatewayId: 'gw-b' },
  ];
  const gClient = { async listProfiles() { return []; }, async call() { return {}; } };
  const persistedSnapshots = [];
  const legacyGroupSvc = createGroupOperationService({
    getState: () => gState,
    getGatewayClient: () => gClient,
    render: () => {},
    t: (k) => k,
    disarmRollbackOnLeave: () => {},
    unreadGroupRoomIds: new Set(),
    activeRunningGroupRoomIds: new Set(),
    activityTransitionTracker: new ActivityTransitionTracker({ windowMs: 850 }),
    groupRoomStore: {
      async fetchLogs() { return []; },
      async listRooms() { return gState.groupRooms; },
      getLogs: () => [],
      async createRoom() { return { room_id: 'legacy-created' }; },
      async disbandRoom() { return true; },
    },
    turnExecutionService: {
      resetActiveGroupThread() {},
      syncGroupRoomLogsToState() {},
      async refreshGroupRoomLog() { return 0; },
      async sendGroupMessage() {},
    },
    groupPollerManager: { isPolling: () => false, stop() {} },
    persistGroupsToCache: (rooms) => { persistedSnapshots.push(rooms); },
    resolveAgentAvatar: () => '',
    formatTimestamp: () => '10:00',
    nextLoadMessagesGeneration: () => 1,
    getCurrentLoadMessagesGeneration: () => 1,
  });
  await legacyGroupSvc.openGroupRoom('room-x', 'gw-other');
  gState.groupRooms.push({ roomId: 'room-fallback', name: 'OnlyA', members: ['coder'], createdAt: 1, updatedAt: 1, gatewayId: 'gw-a' });
  await legacyGroupSvc.openGroupRoom('room-fallback', 'gw-other');
  const created = await legacyGroupSvc.createGroupRoom('Legacy Room', ['coder', 'arch']);
  assert.equal(created.room_id, 'legacy-created');
  const legacyGroupNoClient = createGroupOperationService({
    getState: () => gState,
    getGatewayClient: () => null,
    getClientForGateway: (gw) => (gw === 'gw-off' ? null : gClient),
    render: () => {},
    t: (k) => k,
    disarmRollbackOnLeave: () => {},
    unreadGroupRoomIds: new Set(),
    activeRunningGroupRoomIds: new Set(),
    activityTransitionTracker: new ActivityTransitionTracker({ windowMs: 850 }),
    groupRoomStore: {
      async fetchLogs() { return []; },
      async listRooms() { return []; },
      getLogs: () => [],
      async createRoom() { return { room_id: 'resolved-created' }; },
      async disbandRoom() { return true; },
    },
    turnExecutionService: {
      resetActiveGroupThread() {},
      syncGroupRoomLogsToState() {},
      async refreshGroupRoomLog() { return 0; },
      async sendGroupMessage() {},
    },
    groupPollerManager: { isPolling: () => false, stop() {} },
    persistGroupsToCache: () => {},
    resolveAgentAvatar: () => '',
    formatTimestamp: () => '10:00',
    nextLoadMessagesGeneration: () => 1,
    getCurrentLoadMessagesGeneration: () => 1,
  });
  gState.activeGatewayId = 'gw-a';
  assert.equal((await legacyGroupNoClient.createGroupRoom('With Resolver', ['a', 'b'])).room_id, 'resolved-created');
  gState.activeGatewayId = 'gw-off';
  assert.equal(await legacyGroupNoClient.createGroupRoom('Offline Resolver', ['a', 'b']), null);
  gState.activeGatewayId = '';
  await legacyGroupSvc.disbandGroupRoom('room-x', 'gw-b');
  assert.equal(persistedSnapshots[0].some((r) => r.gatewayId === 'gw-a'), true);
  assert.equal(persistedSnapshots[0].some((r) => r.gatewayId === 'gw-b' && r.roomId === 'room-x'), false);
  // Now with targetGw undefined
  gState.groupRooms = [{ roomId: 'room-unscoped', name: 'U', members: [], createdAt: 1, updatedAt: 1 }];
  await legacyGroupSvc.disbandGroupRoom('room-unscoped');
  assert.equal(persistedSnapshots.at(-1).length, 0);

  // 3. ProfileManagementService post-selectSession stale focus guard (line 409)
  const pState = createInitialState({ platform: 'win32' });
  pState.gatewayCount = 2;
  pState.activeGatewayId = 'gw-b';
  pState.profiles = [{ name: 'freshbot', displayName: 'Fresh', gatewayId: 'gw-b' }];
  let mutateInSelect = true;
  const pClient = {
    async request(m, p) { return this.call(m, p); },
    async call(m) {
      if (m === 'session.list') return { sessions: [{ session_id: 'fc-fresh', hidden: true, profile: 'freshbot' }] };
      if (m === 'session.create') return { session_id: 'fc-fresh' };
      return {};
    },
    async listSessions() {
      return { ok: true, sessions: [{ id: 'fc-fresh', title: 'FC', botName: 'freshbot', hidden: true, timestamp: 1, time: '1' }] };
    },
  };
  const profSvc = createProfileManagementService({
    getState: () => pState,
    getGatewayClient: () => pClient,
    getClientForGateway: () => pClient,
    render: () => {},
    t: (k) => k,
    describeRpcError: (e) => String(e),
    botActivityStore: { persist() {}, withActivityMap: (fn) => fn(new Map()), updateLatestActivity() {} },
    unreadBotNames: new Set(),
    activityTransitionTracker: new ActivityTransitionTracker({ windowMs: 850 }),
    sessionMessagesCache: new Map(),
    syncProfileLastMessages: () => {},
    applyColdStartFocus: async () => {},
    cancelColdStartFocus: () => {},
    fetchSessions: async () => {},
    fetchModelOptions: async () => {},
    selectSession: async () => {
      if (mutateInSelect) {
        pState.activeFocus = { type: 'session', sessionId: 'user-clicked-away', gatewayId: 'gw-a' };
      }
    },
    openGroupRoom: async () => {},
    restoreComposerFocus: () => {},
    disarmRollbackOnLeave: () => {},
    handleArmedOnDelete: () => {},
    botForeverChatCache: new Map(),
    nextLoadMessagesGeneration: () => 1,
    getCurrentLoadMessagesGeneration: () => 1,
  });
  await profSvc.openBotChat('freshbot', 'gw-b');
  assert.equal(pState.activeFocus.sessionId, 'user-clicked-away');
  mutateInSelect = false;
  pState.profiles = [
    { name: 'freshbot', displayName: 'Fresh', gatewayId: 'gw-b' },
    { name: 'localbot', displayName: 'Local' },
  ];
  pState.activeGatewayId = '';
  await profSvc.openBotChat('freshbot');
  assert.equal(pState.activeGatewayId, 'gw-b');
  pState.activeGatewayId = '';
  await profSvc.openBotChat('localbot');
  pState.activeGatewayId = '';
  await profSvc.openBotChat('unlistedbot');
  await profSvc.openBotChat('freshbot', 'gw-other');

  // 4. MessageLoadingService resolveForeverBotName (lines 295, 296, 303)
  const mState = createInitialState({ platform: 'win32' });
  mState.gatewayCount = 2;
  const discoveredBots = [];
  const loadClient = {
    async call(m) {
      if (m === 'session.resume') return { live_session_id: 'live-fc', running: true };
      return {};
    },
    async fetchSessionMessages() {
      return { status: 'success', messages: [{ id: 'm1', role: 'user', content: 'hi', row_id: 1 }], pagination: { returned: 1 } };
    },
  };
  const loadSvc = createMessageLoadingService({
    getState: () => mState,
    getGatewayClient: () => loadClient,
    getClientForGateway: () => loadClient,
    render: () => {},
    sessionMessagesCache: new Map(),
    cacheService: createFakeCacheService(),
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
    getMessageWindowEnd: () => 10,
    setMessageWindowEnd: () => {},
    setMessageWindowUserExpanded: () => {},
    isGroupConversationActive: () => false,
    hostedRoomIds: new Set(),
    formatSessionTime: () => '10:00',
    formatTimestamp: () => '10:00',
    botActivityStore: { withActivityMap: () => null, persist() {} },
    botForeverChatCache: new Map([
      ['gw-b:other', 'fc-other'],
      ['gw-a:coder', 'fc-shared'],
      ['gw-b:coder', 'fc-shared'],
      ['plainbot', 'fc-plain'],
    ]),
    sessionPreviewCache: new Map(),
    persistSessionPreviewCache: () => {},
    getActiveStreamingStoredSessionId: () => null,
    defaultSessionHandleRegistry: new SessionHandleRegistry(),
    activeRunningSessionIds: new Set(),
    activityTransitionTracker: new ActivityTransitionTracker({ windowMs: 850 }),
    onActiveTurnDiscovered: (payload) => discoveredBots.push(payload.botName),
  });
  await loadSvc.loadMessagesInner('fc-shared', undefined, undefined, 'gw-b');
  await flushMicrotasks(15);
  mState.activeGatewayId = '';
  await loadSvc.loadMessagesInner('fc-plain');
  await flushMicrotasks(15);
  await loadSvc.loadMessagesInner('fc-other', undefined, undefined, 'gw-unmatched');
  await flushMicrotasks(15);
  assert.deepEqual(discoveredBots, ['coder', 'plainbot', 'other']);
});

test('M1.3 SessionOperationService remaining edges & cross-gateway REST delete guard', async () => {
  const sState = createInitialState({ platform: 'win32' });
  sState.gatewayUrl = 'http://alpha.local:8642';
  sState.gatewayCount = 2;
  sState.activeGatewayId = 'gw-b';
  sState.activeFocus = { type: 'session', sessionId: 's-b', gatewayId: 'gw-b' };
  sState.activeSessionId = 's-b';
  sState.activeLiveSessionId = 'live-b';

  const httpProxyCalls = [];
  let hasHttpProxy = true;
  let renameFail = false;
  let deleteRpcFail = false;
  let approvalRpcFail = false;
  const configCalls = [];
  let liveIdResult = 'live-ok';

  const clientA = { async call() { return {}; } };
  const clientB = {
    async call(m, p) {
      if (m === 'session.create') return { session_id: 'dup-id', live_session_id: 'live-dup' };
      if (m === 'session.title' && renameFail) throw new Error('title err');
      if (m === 'session.delete' && deleteRpcFail) throw new Error('rpc del err');
      if (m === 'config.set') {
        if (approvalRpcFail) throw new Error('cfg err');
        configCalls.push(p);
      }
      return {};
    },
  };

  let curClientForGw = (gw) => (gw === 'gw-b' ? clientB : clientA);
  let currentTicket = 'tk-a';
  const sMsgCache = new Map();
  const sessSvc = createSessionOperationService({
    getState: () => sState,
    getGatewayClient: () => clientA,
    getClientForGateway: (gw) => curClientForGw(gw),
    getGatewayUrlForGateway: (gw) => (gw === 'gw-b' ? 'http://beta.local:8643' : 'http://alpha.local:8642'),
    onActiveFocusChanged: () => {},
    getDesktopApi: () => (hasHttpProxy ? { httpProxy: async (req) => { httpProxyCalls.push(req); return { status: 200 }; } } : undefined),
    getCurrentTicket: () => currentTicket,
    getEffectiveUrl: (u) => u || 'http://alpha.local:8642',
    render: () => {},
    t: (k) => k,
    showToast: () => {},
    setTimedDockNotice: () => {},
    restoreComposerFocus: () => {},
    sessionDrafts: new Map(),
    sessionMessagesCache: sMsgCache,
    unreadSessionIds: new Set(),
    activeRunningSessionIds: new Set(),
    activityTransitionTracker: new ActivityTransitionTracker({ windowMs: 850 }),
    sessionHandleRegistry: new SessionHandleRegistry(),
    cacheService: createFakeCacheService(),
    persistSessionsToCache: () => {},
    forgetOlderCursorState: () => {},
    sessionListGeneration: { invalidateForDelete() {} },
    getActiveStreamingStoredSessionId: () => null,
    resetActiveStreamingState: () => {},
    setPendingScrollToBottom: () => {},
    setLastMessagesSnapshot: () => {},
    loadMessages: async () => {},
    openBotChat: async () => {},
    ensureLiveSessionId: async () => liveIdResult,
  });

  // 1. Secondary gateway delete NEVER calls httpProxy targeting Gateway A even if RPC delete fails
  deleteRpcFail = true;
  sState.sessions = [{ id: 's-b', title: 'B', botName: 'coder', timestamp: 1, time: '1', preview: '', gatewayId: 'gw-b' }];
  await sessSvc.deleteSession('s-b', 'gw-b');
  assert.equal(httpProxyCalls.length, 0);

  // Primary gateway delete DOES use httpProxy when sameAsPrimary === true, and skips if httpProxy unavailable
  deleteRpcFail = false;
  sState.sessions = [{ id: 's-a', title: 'A', botName: '', timestamp: 1, time: '1', preview: '', gatewayId: 'gw-a' }];
  sState.activeSessionId = 's-a';
  sState.activeGatewayId = 'gw-a';
  sState.profileName = '';
  await sessSvc.deleteSession('s-a', 'gw-a');
  assert.equal(httpProxyCalls.length >= 1, true);
  assert.equal(httpProxyCalls[0].baseUrl, 'http://alpha.local:8642');

  hasHttpProxy = false;
  currentTicket = null;
  sState.sessions = [{ id: 's-a2', title: 'A2', botName: '', timestamp: 1, time: '1', preview: '', gatewayId: 'gw-a' }];
  sState.activeSessionId = 's-a2';
  sState.profileName = 'coder';
  await sessSvc.deleteSession('s-a2', 'gw-a');
  currentTicket = 'tk-a';
  await sessSvc.deleteSession('');

  // 2. createNewSession without activeGatewayId + upsertSessionByCompositeKey branches
  sState.gatewayCount = 1;
  sState.activeGatewayId = '';
  sState.sessions = [
    { id: 'dup-id', title: 'NoGw', botName: 'default', timestamp: 1, time: '1', preview: '' },
    { id: 'dup-id', title: 'GwA', botName: 'default', timestamp: 1, time: '1', preview: '', gatewayId: 'gw-a' },
  ];
  await sessSvc.createNewSession({ profile: 'default' });
  sState.gatewayCount = 2;
  sState.activeGatewayId = 'gw-b';
  sState.sessions = [
    { id: 'dup-id', title: 'GwA', botName: 'default', timestamp: 1, time: '1', preview: '', gatewayId: 'gw-a' },
    { id: 'dup-id', title: 'NoGw', botName: 'default', timestamp: 1, time: '1', preview: '' },
  ];
  await sessSvc.createNewSession({ profile: 'default' });
  sState.sessions = [
    { id: 'dup-id', title: 'GwA', botName: 'default', timestamp: 1, time: '1', preview: '', gatewayId: 'gw-a' },
    { id: 'dup-id', title: 'GwB', botName: 'default', timestamp: 1, time: '1', preview: '', gatewayId: 'gw-b' },
  ];
  await sessSvc.createNewSession({ profile: 'default' });

  // setSessionArchived unarchive when archivedSessions is undefined (line 674)
  sState.archivedSessions = undefined;
  sState.sessions = [{ id: 'unarch-s', title: 'S', botName: 'coder', timestamp: 1, time: '1', preview: '', gatewayId: 'gw-b' }];
  await sessSvc.setSessionArchived('unarch-s', false, 'coder', 'gw-b');

  // 3. renameSession with archivedSessions present (success & catch) and undefined
  sState.archivedSessions = [
    { id: 'arch-r', title: 'Old B', botName: 'coder', timestamp: 1, time: '1', preview: '', gatewayId: 'gw-b' },
    { id: 'other-id', title: 'Keep', botName: 'coder', timestamp: 1, time: '1', preview: '', gatewayId: 'gw-a' },
  ];
  await sessSvc.renameSession('arch-r', 'Old B', 'New B', 'gw-b');
  renameFail = true;
  await sessSvc.renameSession('arch-r', 'New B', 'Catch B', 'gw-b');
  sState.archivedSessions = undefined;
  await sessSvc.renameSession('none', 'Old', 'New', 'gw-b');

  // 4. selectSession: archived fallback without matching botName, switchingGateway combinations, targetGw empty, corrupted draft
  let inputBoxVal = '';
  const sessWithInput = createSessionOperationService({
    getState: () => sState,
    getGatewayClient: () => clientA,
    render: () => {},
    t: (k) => k,
    showToast: () => {},
    setTimedDockNotice: () => {},
    restoreComposerFocus: () => {},
    sessionDrafts: new Map([[resolveScopedEntityRuntimeKey('arch-sel', undefined, 1), 'Command /compress failed: timeout']]),
    sessionMessagesCache: sMsgCache,
    unreadSessionIds: new Set(),
    activeRunningSessionIds: new Set(),
    activityTransitionTracker: new ActivityTransitionTracker({ windowMs: 850 }),
    sessionHandleRegistry: new SessionHandleRegistry(),
    cacheService: createFakeCacheService(),
    persistSessionsToCache: () => {},
    forgetOlderCursorState: () => {},
    sessionListGeneration: { invalidateForDelete() {} },
    getActiveStreamingStoredSessionId: () => null,
    resetActiveStreamingState: () => {},
    setPendingScrollToBottom: () => {},
    setLastMessagesSnapshot: () => {},
    loadMessages: async () => {},
    openBotChat: async () => {},
    ensureLiveSessionId: async () => liveIdResult,
    getCurrentTicket: () => null,
    getEffectiveUrl: (u) => u || '',
    setInputValue: (v) => { inputBoxVal = v; },
    getInputValue: () => inputBoxVal,
  });
  sState.gatewayCount = 1;
  sState.activeGatewayId = '';
  sState.activeFocus = { type: 'session', sessionId: 'other' };
  sState.sessions = [];
  sState.archivedSessions = [{ id: 'arch-sel', title: 'AS', botName: 'coder', timestamp: 1, time: '1', preview: '' }];
  await sessWithInput.selectSession('arch-sel', { botName: 'mismatch' });
  assert.equal(inputBoxVal, '');

  sState.gatewayCount = 2;
  sState.archivedSessions = undefined;
  sState.activeGatewayId = 'gw-a';
  sState.activeFocus = { type: 'session', sessionId: 's-a', gatewayId: 'gw-a' };
  sState.sessions = [{ id: 's-b-switch', title: 'B', botName: 'coder', timestamp: 1, time: '1', preview: '', gatewayId: 'gw-b' }];
  await sessSvc.selectSession('s-b-switch', { gatewayId: 'gw-b' });
  sState.sessions = [{ id: 's-only-a', title: 'OnlyA', botName: 'coder', timestamp: 1, time: '1', preview: '', gatewayId: 'gw-a' }];
  await sessSvc.selectSession('s-only-a', { botName: 'otherbot', gatewayId: 'gw-a' });
  sState.archivedSessions = undefined;
  await sessSvc.selectSession('totally-missing');
  sState.archivedSessions = [{ id: 'other-arch', title: 'Other', botName: 'coder', timestamp: 1, time: '1', preview: '', gatewayId: 'gw-b' }];
  await sessSvc.selectSession('totally-missing');

  // 5. switchApproval all branches (success, catch, empty liveId, fallback activeGatewayId, offline / group early return)
  sState.activeGatewayId = 'gw-b';
  sState.activeSessionId = 's-b-switch';
  sState.activeFocus = { type: 'session', sessionId: 's-b-switch' };
  await sessSvc.switchApproval('smart');
  sState.activeFocus = { type: 'session', sessionId: 's-b-switch', gatewayId: 'gw-b' };
  await sessSvc.switchApproval('smart');
  assert.equal(configCalls.at(-1).value, 'smart');
  approvalRpcFail = true;
  await sessSvc.switchApproval('manual');
  assert.equal(sState.dockNotice.startsWith('Set approval mode failed:'), true);
  liveIdResult = '';
  await sessSvc.switchApproval('off');
  assert.equal(sState.dockNotice, 'Cannot set approval mode: live session channel unavailable');
  curClientForGw = () => null;
  await sessSvc.switchApproval('smart');
});

test('M1.3 TurnExecutionService group poller callbacks, unfocused group send & offline askSideAgent', async (t) => {
  const tState = createInitialState({ platform: 'win32' });
  tState.gatewayCount = 2;
  tState.activeGatewayId = 'gw-a';
  tState.activeSessionId = 's1';
  tState.activeFocus = { type: 'session', sessionId: 's1', gatewayId: 'gw-a' };
  tState.profiles = [{ name: 'helper', displayName: 'Helper', gatewayId: 'gw-b' }];
  tState.groupRooms = [
    { roomId: 'room-ok', name: 'NoGw', members: ['helper'], createdAt: 1, updatedAt: 1 },
    { roomId: 'room-ok', name: 'OtherGw', members: ['helper'], createdAt: 1, updatedAt: 1, gatewayId: 'gw-a' },
    { roomId: 'room-ok', name: 'TargetOk', members: ['helper'], createdAt: 1, updatedAt: 1, gatewayId: 'gw-b' },
    { roomId: 'room-fail', name: 'TargetFail', members: ['helper'], createdAt: 1, updatedAt: 1, gatewayId: 'gw-b' },
  ];

  const clientA = { async call() { return {}; } };
  const clientB = { async call() { return {}; } };
  let clientAvailableForB = true;
  let sendShouldFail = false;
  let fetchLogsReplies = [];
  let completedCount = 0;

  t.mock.timers.enable({ apis: ['setTimeout'] });
  const turnSvc = createTurnExecutionService({
    getState: () => tState,
    getGatewayClient: () => clientA,
    getClientForGateway: (gw) => (gw === 'gw-b' ? (clientAvailableForB ? clientB : null) : gw === 'gw-a' ? clientA : null),
    getRpcCaller: () => ({ async request() { return {}; } }),
    getInteractiveService: () => ({ async truncateAndSubmit() { return { status: 'streaming' }; } }),
    getCacheService: () => createFakeCacheService(),
    getGroupRoomStore: () => ({
      getLogs: () => [],
      async sendMessage() {
        if (sendShouldFail) throw new Error('group send boom');
        return { event: { payload: { thread_id: 'th-grp' } } };
      },
      async fetchLogs() { return fetchLogsReplies; },
    }),
    getActivityTransitionTracker: () => new ActivityTransitionTracker({ windowMs: 850 }),
    getTokenCoalescer: () => ({ flush() {}, clear() {} }),
    getSessionHandleRegistry: () => new SessionHandleRegistry(),
    getSessionMessagesCache: () => new Map(),
    getSessionDrafts: () => new Map(),
    getBotActivityStore: () => ({ updateLatestActivity() {} }),
    getHandoffService: () => ({ async sendBtw() { return { task_id: 'btw-1' }; } }),
    completeEntityTurn: (_domain, running, _unread, id) => {
      running.delete(id);
      completedCount += 1;
    },
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
    setActiveStreamingContext: () => {},
    getTurnStartedSessionId: () => null,
    setTurnStartedSessionId: () => {},
    getSessionHistoryTrust: () => new Map(),
    forgetOlderCursorState: () => {},
    createNewSession: async () => {},
    ensureLiveSessionId: async () => 'live-1',
    setMessageContent: () => {},
    syncActiveGroupSpeakerFromMessages: () => {},
    resolveAgentAvatar: () => '',
    scrollStreamToBottom: () => {},
    setPendingScrollToBottom: () => {},
    runSlashCommand: async () => {},
    enqueueDraft: async () => {},
    handleQueueAction: async () => {},
    render: () => {},
    t: (k) => k,
  });

  try {
    // 1. syncGroupRoomLogsToState while NOT focused on group (line 589 false branch)
    turnSvc.syncGroupRoomLogsToState('room-ok', [
      { messageId: 'g1', actorKind: 'assistant', senderProfile: 'helper', text: 'bg log', timestamp: 1700000000 },
    ]);

    // 2. Unfocused sendGroupMessage (lines 695-697 & 731) -> poller onCompleted (641-643)
    fetchLogsReplies = [
      { messageId: 'g-reply-1', actorKind: 'assistant', senderProfile: 'helper', text: 'done!', timestamp: 1700000005 },
    ];
    await turnSvc.sendGroupMessage('room-ok', 'hello unfocused');
    t.mock.timers.tick(1500);
    await flushMicrotasks(15);
    assert.equal(completedCount >= 1, true);

    // 3. sendGroupMessage catch branch (753-754)
    sendShouldFail = true;
    await turnSvc.sendGroupMessage('room-fail', 'fail send');
    assert.equal(tState.dockNotice, 'group.sendFailed');

    // 4. groupPollerManager fetchLogs !client reject -> 45+ ticks -> onFailed (627-629 & 647-650)
    sendShouldFail = false;
    await turnSvc.sendGroupMessage('room-fail', 'start poll then disconnect');
    clientAvailableForB = false;
    for (let i = 0; i < 65; i += 1) {
      t.mock.timers.tick(5000);
      await flushMicrotasks(8);
    }

    // 5. askSideAgent offline guard (1329-1332) & routeSend slash with null client (1427)
    tState.activeEntityGatewayOffline = true;
    await turnSvc.routeSend('@helper offline check');
    assert.equal(tState.dockNotice, 'gateway.offlineReadOnlyNotice');

    tState.activeFocus = { type: 'session', sessionId: 's1', gatewayId: 'gw-b' };
    tState.activeEntityGatewayOffline = false;
    await turnSvc.routeSend('/status');
    tState.activeFocus = { type: 'session', sessionId: 's1' };
    tState.activeGatewayId = '';
    await turnSvc.routeSend('/status');
  } finally {
    turnSvc.getGroupPollerManager().stopAll();
    turnSvc.disarmTurnWatchdog(true);
    turnSvc.clearPresenceTerminal();
    t.mock.timers.reset();
  }
});
