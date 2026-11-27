/**
 * M1.3 全链路跨网关运行时路由与状态隔离单测 (Desktop Wiring & Services)
 * (packages/desktop/__tests__/unit/m1-3-multi-gateway-wiring.test.mjs)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ActivityTransitionTracker,
  LiveStreamRegistry,
  SessionHandleRegistry,
} from '@hermes-flux/core';
import {
  GATEWAY_REGISTRY_STORAGE_KEY,
  migrateLegacyGatewaySecrets,
} from '../../dist/renderer/gateway/gatewayRegistryStore.mjs';
import { createMultiGatewayRuntime } from '../../dist/renderer/gateway/multiGatewayRuntime.mjs';
import {
  createDesktopMultiGatewayWiring,
  matchesForeverChatSession,
  resolveActiveLiveSessionId,
} from '../../dist/renderer/gateway/multiGatewayCoordinator.mjs';
import {
  createInitialState,
  resolveScopedBotRuntimeKey,
  resolveScopedEntityRuntimeKey,
} from '../../dist/renderer/state/appState.mjs';
import { LeftRailSnapshotManager } from '../../dist/renderer/leftrail/leftRailSnapshotManager.mjs';
import { createLeftRailController } from '../../dist/renderer/events/leftRailController.mjs';
import { createMediaResolver } from '../../dist/renderer/services/mediaResolver.mjs';
import { createGroupOperationService } from '../../dist/renderer/services/groupOperationService.mjs';
import { createProfileManagementService } from '../../dist/renderer/services/profileManagementService.mjs';
import { createSessionOperationService } from '../../dist/renderer/services/sessionOperationService.mjs';
import { createMessageLoadingService } from '../../dist/renderer/services/messageLoadingService.mjs';
import { createTurnExecutionService } from '../../dist/renderer/services/turnExecutionService.mjs';
import { createModalInteractionController } from '../../dist/renderer/events/modalInteractionController.mjs';

function createMemoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => {
      map.set(k, String(v));
    },
    removeItem: (k) => {
      map.delete(k);
    },
    dump: () => Object.fromEntries(map.entries()),
  };
}

class MockSocket {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
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
    this.sent.push(raw);
    const frame = JSON.parse(raw);
    if (frame.method === 'prompt.submit') return;
    if (frame.id != null) {
      queueMicrotask(() => {
        this.onmessage?.({
          data: JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: { ok: true } }),
        });
      });
    }
  }
  close(code = 1000, reason = 'closed') {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
}

function createFakeSocketEnv() {
  const sockets = [];
  const socketFactory = (url) => {
    const sock = new MockSocket(url);
    sockets.push(sock);
    queueMicrotask(() => sock.open());
    return sock;
  };
  return { sockets, socketFactory };
}

async function flushMicrotasks(rounds = 8) {
  for (let i = 0; i < rounds; i += 1) {
    await Promise.resolve();
  }
}

function createFakeCacheService() {
  return {
    async openChannel() {
      return { rows: [], fenceMax: 0 };
    },
    async dropChannel() {},
    async readOlderRows() {
      return [];
    },
    async truncate() {},
  };
}

test('M1.3 Secret Migration & Runtime Reverse RPC guard', async () => {
  const storageEmpty = createMemoryStorage({});
  assert.equal(await migrateLegacyGatewaySecrets([], undefined, storageEmpty), '');

  const storageNoBridge = createMemoryStorage({ hermes_flux_password: 'no-bridge-pw' });
  assert.equal(await migrateLegacyGatewaySecrets([], null, storageNoBridge), 'no-bridge-pw');

  const storageWithPlaintext = createMemoryStorage({
    hermes_flux_gateway_url: 'https://gw-a.local',
    hermes_flux_password: 'legacy-secret-value',
    hermes_aura_password: 'legacy-aura-value',
  });
  const savedSecrets = [];
  const bridge = {
    async setGatewaySecret(key, val) {
      if (key.includes('fail.local')) throw new Error('keystore write error');
      savedSecrets.push([key, val]);
    },
  };
  const configs = [
    { id: 'gw-a', name: 'A', url: 'https://gw-a.local' },
    { id: 'gw-b', name: 'B', url: 'https://gw-b.local' },
    { id: 'gw-fail', name: 'F', url: 'https://fail.local' },
  ];
  const migrated = await migrateLegacyGatewaySecrets(configs, bridge, storageWithPlaintext);
  assert.equal(migrated, 'legacy-secret-value');
  assert.equal(savedSecrets.some(([k, v]) => k.includes('gw-b.local') && v === 'legacy-secret-value'), true);
  assert.equal(storageWithPlaintext.getItem('hermes_flux_password'), null);
  assert.equal(storageWithPlaintext.getItem('hermes_aura_password'), null);

  // P1-1: multiGatewayRuntime preserves -32601 when onSlotServerRequest is omitted
  const { sockets, socketFactory } = createFakeSocketEnv();
  const rtNoHandler = createMultiGatewayRuntime({
    socketFactory,
    enableHeartbeat: false,
    enableLifecycleWake: false,
    getDesktopApi: () => ({
      authenticateGateway: async () => ({ ok: true, message: 'ok', latency: 1, ticket: 'tk-1' }),
    }),
    resolvePassword: async () => 'p',
  });
  rtNoHandler.syncGateways([{ id: 'gw-1', name: 'One', url: 'http://127.0.0.1:9101' }]);
  await rtNoHandler.connectGateway('gw-1');
  await flushMicrotasks();
  const ws = sockets.at(-1);
  ws.onmessage?.({
    data: JSON.stringify({ jsonrpc: '2.0', id: 999, method: 'approval.prompt', params: { tool: 'bash' } }),
  });
  await flushMicrotasks();
  const methodNotFound = ws.sent.map((raw) => JSON.parse(raw)).find((m) => m.id === 999);
  assert.equal(methodNotFound.error.code, -32601);
  rtNoHandler.dispose();
});

test('M1.3 Coordinator helpers: matchesForeverChatSession / resolveActiveLiveSessionId / resolveClient / refreshSlotSlices / bootstrap', async () => {
  // 1. matchesForeverChatSession (all branches)
  const fcMap = new Map([
    ['rawBot', 'fc-raw'],
    ['gw-a:coder', 'fc-coder-a'],
    ['gw-b:CaseBot', 'fc-case-b'],
  ]);
  assert.equal(matchesForeverChatSession(fcMap, 'fc-raw'), true);
  assert.equal(matchesForeverChatSession(fcMap, 'fc-missing'), false);
  assert.equal(matchesForeverChatSession(fcMap, 'fc-raw', 'rawBot'), true);
  assert.equal(matchesForeverChatSession(fcMap, 'fc-coder-a', 'Coder'), true);
  assert.equal(matchesForeverChatSession(fcMap, 'fc-case-b', 'CaseBot'), true);
  assert.equal(matchesForeverChatSession(fcMap, 'fc-missing', 'coder'), false);

  // 2. resolveActiveLiveSessionId (all branches)
  const rState = createInitialState({ platform: 'win32' });
  rState.activeFocus = { type: 'group', roomId: 'r1' };
  const handleReg = new SessionHandleRegistry();
  const resumeCalls = [];
  let gen = 1;
  const liveClient = {
    async call(method, params) {
      resumeCalls.push([method, params]);
      if (params.profile === 'extra-trigger') {
        if (params.profile) throw new Error('Extra inputs are not permitted');
      }
      if (params.profile === 'fatal') throw new Error('boom');
      if (params.profile === 'no-handle') return {};
      return { stored_session_id: params.session_id, session_id: 'live-resumed-1' };
    },
  };
  const liveDeps = {
    getState: () => rState,
    resolveClient: (gw) => (gw === 'gw-offline' ? null : liveClient),
    sessionHandleRegistry: handleReg,
    getGeneration: () => gen,
    logSession: { debug() {} },
    describeRpcError: (e) => String(e instanceof Error ? e.message : e),
  };
  assert.equal(await resolveActiveLiveSessionId(liveDeps), '');
  rState.activeFocus = { type: 'session', sessionId: 's1' };
  rState.activeLiveSessionId = 'already-live';
  assert.equal(await resolveActiveLiveSessionId(liveDeps), 'already-live');

  rState.activeLiveSessionId = '';
  rState.activeSessionId = '';
  assert.equal(await resolveActiveLiveSessionId(liveDeps), '');

  rState.activeSessionId = 's1';
  rState.activeFocus = { type: 'session', sessionId: 's1', gatewayId: 'gw-offline' };
  assert.equal(await resolveActiveLiveSessionId(liveDeps), '');

  // Single gateway uses registered handle shortcut
  rState.gatewayCount = 1;
  rState.activeFocus = { type: 'session', sessionId: 's1' };
  rState.activeGatewayId = '';
  handleReg.register({ storedId: 's1', liveId: 'reg-live-1' });
  assert.equal(await resolveActiveLiveSessionId(liveDeps), 'reg-live-1');

  // Multi gateway skips registry shortcut & invokes client.call('session.resume')
  rState.gatewayCount = 2;
  rState.activeLiveSessionId = '';
  rState.activeFocus = { type: 'bot', botName: 'coder', gatewayId: 'gw-b' };
  rState.activeGatewayId = 'gw-b';
  assert.equal(await resolveActiveLiveSessionId(liveDeps), 'live-resumed-1');

  // Extra inputs fallback + default profile from session / 'default'
  rState.activeLiveSessionId = '';
  rState.activeFocus = { type: 'session', sessionId: 's2', gatewayId: 'gw-b' };
  rState.activeSessionId = 's2';
  rState.sessions = [{ id: 's2', title: 'S2', botName: 'extra-trigger', timestamp: 1, time: '1', preview: '', gatewayId: 'gw-b' }];
  assert.equal(await resolveActiveLiveSessionId(liveDeps), 'live-resumed-1');
  assert.equal(resumeCalls.some(([, p]) => !('profile' in p)), true);

  // Non-extra error & missing handle branches
  rState.activeLiveSessionId = '';
  rState.sessions = [{ id: 's2', title: 'S2', botName: 'fatal', timestamp: 1, time: '1', preview: '' }];
  assert.equal(await resolveActiveLiveSessionId(liveDeps), '');

  rState.sessions = [];
  rState.profileName = 'no-handle';
  assert.equal(await resolveActiveLiveSessionId(liveDeps), '');
  rState.profileName = '';
  await resolveActiveLiveSessionId(liveDeps);

  // 3. createDesktopMultiGatewayWiring default onManageGateways, onForwardActiveSlotEvent, bootstrap & health reconnect
  const origLsDesc = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const origWs = globalThis.WebSocket;
  const ls = createMemoryStorage({});
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: ls });
  const env = createFakeSocketEnv();
  globalThis.WebSocket = class extends MockSocket {
    constructor(url) {
      super(url);
      env.sockets.push(this);
      queueMicrotask(() => this.open());
    }
  };
  try {
    const baseState = createInitialState({ platform: 'win32' });
    baseState.gatewayUrl = 'http://fallback.local:8642';
    baseState.profiles = [{ name: 'solo', displayName: 'Solo' }];
    const fallbackClient = { id: 'legacy-fallback' };
    let renderCalls = 0;

    ls.setItem(GATEWAY_REGISTRY_STORAGE_KEY, JSON.stringify([{ id: 'gw-solo', name: 'Solo', url: 'http://solo.local:8642' }]));
    const wiringSingle = createDesktopMultiGatewayWiring({
      getState: () => baseState,
      getDesktopApi: () => ({
        authenticateGateway: async () => ({ ok: true, message: 'ok', latency: 1, ticket: 'tk' }),
      }),
      getFallbackClient: () => fallbackClient,
      render: () => {
        renderCalls += 1;
      },
    });
    try {
      wiringSingle.runtime.setSlotSlice('gw-solo', { profiles: [{ name: 'ignored', displayName: 'Ignored' }] });
      assert.equal(renderCalls, 0);
      wiringSingle.coordinator.onManageGateways?.();
      assert.equal(baseState.isSettingsOpen, true);
      assert.equal(baseState.settingsSection, 'gateway');
      assert.equal(renderCalls, 1);

      assert.equal(wiringSingle.coordinator.resolveClient('gw-solo'), fallbackClient);
      assert.equal(wiringSingle.coordinator.resolveClient(), fallbackClient);
      assert.equal(wiringSingle.coordinator.getGatewayUrl('missing'), 'http://fallback.local:8642');
      await wiringSingle.bootstrap();
      assert.equal(baseState.profiles[0].name, 'solo');
    } finally {
      wiringSingle.runtime.dispose();
    }

    // Multi-gateway wiring with onForwardActiveSlotEvent & onSlotEvent
    ls.setItem(
      GATEWAY_REGISTRY_STORAGE_KEY,
      JSON.stringify([
        { id: 'gw-a', name: 'Alpha', url: 'http://alpha.local:8642' },
        { id: 'gw-b', name: 'Beta', url: 'http://beta.local:8643' },
      ]),
    );
    const multiState = createInitialState({ platform: 'win32' });
    multiState.gatewayUrl = 'http://alpha.local:8642';
    multiState.activeFocus = { type: 'session', sessionId: 's1', gatewayId: 'gw-b' };
    multiState.activeGatewayId = 'gw-b';
    const forwardedEvents = [];
    const rawSlotEvents = [];
    const wiringMulti = createDesktopMultiGatewayWiring({
      getState: () => multiState,
      getDesktopApi: () => ({
        authenticateGateway: async () => ({ ok: true, message: 'ok', latency: 1, ticket: 'tk' }),
      }),
      getFallbackClient: () => fallbackClient,
      render: () => {
        renderCalls += 1;
      },
      onSlotEvent: (gw, params) => rawSlotEvents.push([gw, params]),
      onForwardActiveSlotEvent: (params) => forwardedEvents.push(params),
    });

    try {
      await wiringMulti.bootstrap();
      await flushMicrotasks(12);
      assert.equal(multiState.gatewayCount, 2);
      assert.equal(wiringMulti.coordinator.getGatewayUrl('gw-b'), 'http://beta.local:8643');
      assert.equal(wiringMulti.coordinator.getGatewayUrl(), 'http://alpha.local:8642');

      const sockB = env.sockets.find((s) => s.url.includes('beta.local'));
      const sockA = env.sockets.find((s) => s.url.includes('alpha.local'));
      sockB.onmessage?.({ data: JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'delta', payload: 1 } }) });
      sockA.onmessage?.({ data: JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'delta', payload: 2 } }) });
      assert.equal(rawSlotEvents.length, 2);
      assert.deepEqual(forwardedEvents, [{ type: 'delta', payload: 1 }]);

      wiringMulti.coordinator.disconnectGateway('gw-b');
      assert.equal(wiringMulti.coordinator.resolveClient('gw-b'), null);
      await wiringMulti.coordinator.refreshSlotSlices('gw-b');
      await wiringMulti.coordinator.refreshSlotSlices('non-existent');

      await wiringMulti.coordinator.reconnectGateway('gw-b');
      await flushMicrotasks(10);
      assert.notEqual(wiringMulti.coordinator.resolveClient('gw-b'), null);

      const slotA = wiringMulti.runtime.getSlot('gw-a');
      const origClientA = slotA.client;
      try {
        slotA.client = {
          disconnect() {},
          async listProfiles() {
            return [{ name: 'coder', displayName: 'Coder' }, { name: '', displayName: 'Blank' }];
          },
          async request(method, params) {
            return this.call(method, params);
          },
          async call(method) {
            if (method === 'groups.list') {
              return {
                rooms: [
                  { room_id: 'r1', name: 'SecRoom', members: ['coder'], created_at: 1700000000, updated_at: 1700000000000 },
                  { room_id: 'r2', name: 'MsRoom', members: ['coder'], created_at: 1700000000000, updated_at: 1700000000 },
                  { room_id: 'r-disbanded', name: 'Dead', members: [], disbanded_at: 1 },
                  { room_id: 'r-nots', name: 'NoTs', members: ['coder'], created_at: 'bad', updated_at: null },
                ],
              };
            }
            return {};
          },
          async listSessions(profile) {
            if (profile === 'coder') return { ok: false, sessions: [] };
            return {
              ok: true,
              sessions: [
                { id: 's1', title: 'S1', botName: 'coder', timestamp: 1, time: 't', preview: '', isArchived: false },
                { id: 's1', title: 'S1', botName: 'coder', timestamp: 2, time: 't', preview: 'newer', isArchived: false },
                { id: 's-arch', title: 'Arch', botName: 'default', timestamp: 1, time: 't', preview: '', isArchived: true },
              ],
            };
          },
        };
        await wiringMulti.coordinator.refreshSlotSlices('gw-a');
        assert.equal(multiState.sessions.some((s) => s.id === 's1' && s.preview === 'newer'), true);
        assert.equal(multiState.sessions.some((s) => s.id === 's-arch'), false);
        assert.equal(multiState.groupRooms.some((g) => g.roomId === 'r1' && g.createdAt > 1e12), true);

        // Exercise { groups: [...] } response path for seconds vs ms vs non-number timestamps
        slotA.client = {
          disconnect() {},
          async listProfiles() { return [{ name: 'coder', displayName: 'Coder' }]; },
          async request(method) {
            if (method === 'groups.list') {
              return {
                groups: [
                  { roomId: 'r-sec', name: 'Sec', members: ['coder'], createdAt: 1700000000, updatedAt: 1700000000 },
                  { roomId: 'r-badts', name: 'BadTs', members: ['coder'], createdAt: 'bad', updatedAt: null },
                ],
              };
            }
            return {};
          },
          async call(method, params) { return this.request(method, params); },
          async listSessions() { return { ok: true, sessions: [] }; },
        };
        await wiringMulti.coordinator.refreshSlotSlices('gw-a');
        assert.equal(multiState.groupRooms.some((g) => g.roomId === 'r-sec' && g.createdAt === 1700000000000), true);
        assert.equal(multiState.groupRooms.some((g) => g.roomId === 'r-badts' && g.createdAt === 0 && g.updatedAt === 0), true);

        slotA.client = {
          disconnect() {},
          async listProfiles() { throw new Error('p err'); },
          async request() { throw new Error('g err'); },
          async call() { throw new Error('g err'); },
          async listSessions() { return { ok: false, sessions: [] }; },
        };
        await wiringMulti.coordinator.refreshSlotSlices('gw-a');
      } finally {
        slotA.client = origClientA;
      }

      wiringMulti.runtime.syncGateways([{ id: 'gw-a', name: 'Alpha', url: 'http://alpha.local:8642' }]);
      wiringMulti.coordinator.syncPoolToState();
      assert.equal(multiState.gatewayCount, 1);
      assert.equal(multiState.profiles.some((p) => p.gatewayId === 'gw-b'), false);
      multiState.profiles = [{ name: 'manual-solo', displayName: 'Manual' }];
      wiringMulti.coordinator.syncPoolToState();
      assert.equal(multiState.profiles[0].name, 'manual-solo');
    } finally {
      wiringMulti.runtime.dispose();
    }
  } finally {
    globalThis.WebSocket = origWs;
    if (origLsDesc) Object.defineProperty(globalThis, 'localStorage', origLsDesc);
    else delete globalThis.localStorage;
  }
});

test('M1.3 LeftRailSnapshotManager, LeftRailController, MediaResolver & ModalInteractionController branches', async () => {
  assert.equal(resolveScopedEntityRuntimeKey('s1', 'gw-a', 1), 's1');
  assert.equal(resolveScopedEntityRuntimeKey('s1', undefined, 2), 's1');
  assert.equal(resolveScopedEntityRuntimeKey('s1', 'gw-b', 2), 'gw-b::s1');
  assert.equal(resolveScopedBotRuntimeKey('coder', 'gw-b', 2), 'gw-b:coder');
  assert.equal(resolveScopedBotRuntimeKey('coder', 'gw-b', 1), 'coder');

  const snap = new LeftRailSnapshotManager({
    getState: () => 'ready',
    getLayout: () => 'dual-rail',
    getSearchQuery: () => '',
    getCollapsedContainers: () => new Set(),
    getOrgPrefs: () => ({ showDoneSection: false }),
    getContainers: () => [],
    getDoneContainer: () => ({ id: 'done', kind: 'done', title: 'Done', items: [] }),
    getActiveSessionId: () => '',
    getActiveBotName: () => '',
    getActiveGroupRoomId: () => '',
    getActiveFocusType: () => 'session',
    getActiveGatewayId: () => 'gw-a',
    getGatewayCount: () => 2,
    getProfiles: () => [{ name: 'coder', displayName: 'Coder', gatewayId: 'gw-b' }],
    getSessions: () => [{ id: 's1', title: 'S1', botName: 'coder', timestamp: 1, time: '1m', preview: '', gatewayId: 'gw-b' }],
    getGroupRooms: () => [{ roomId: 'r1', name: 'R1', members: ['coder'], createdAt: 1, updatedAt: 1, gatewayId: 'gw-b' }],
    getProjects: () => [],
    isBotsGroupExpanded: () => true,
    isSessionsGroupExpanded: () => true,
    isGroupsGroupExpanded: () => true,
    getError: () => '',
    isCollapsed: () => false,
    getProfilesPhase: () => 'ready',
    getSessionsPhase: () => 'ready',
    getActivityVariant: () => 'pulse',
    getActiveRunningSessionIds: () => new Set(['gw-b::s1']),
    getUnreadSessionIds: () => new Set(),
    getActiveStreamingStoredSessionId: () => '',
    getActiveRunningGroupRoomIds: () => new Set(),
    getUnreadGroupRoomIds: () => new Set(['gw-b::r1']),
    getActiveRunningBotNames: () => new Set(['gw-b:coder']),
    getUnreadBotNames: () => new Set(),
    resolveAgentAvatar: () => '',
    resolveTransition: (_scope, id, st) => ({ transition: st === 'running' ? 'running' : 'idle', transitionToken: `${id}:tok` }),
  });
  assert.equal(snap.decorateSessions(100)[0].activityState, 'running');
  assert.equal(snap.decorateGroups(100)[0].activityState, 'unread');
  assert.equal(snap.decorateProfiles(100)[0].activityState, 'running');

  // LeftRailController confirmGroupRename covers all gateway fallback / rollback branches
  const lrState = createInitialState({ platform: 'win32' });
  lrState.activeGatewayId = 'gw-a';
  lrState.activeFocus = { type: 'group', roomId: 'r1', gatewayId: 'gw-a' };
  lrState.groupRooms = [
    { roomId: 'r1', name: 'Alpha Room', members: ['coder'], createdAt: 1, updatedAt: 1, gatewayId: 'gw-a' },
    { roomId: 'r1', name: 'Beta Room', members: ['coder'], createdAt: 1, updatedAt: 1, gatewayId: 'gw-b' },
  ];
  const renamedOn = [];
  const toasts = [];
  let failRename = false;
  const ctrl = createLeftRailController({
    getState: () => lrState,
    render: () => {},
    t: (k) => k,
    showToast: (m) => toasts.push(m),
    describeRpcError: (e) => String(e),
    getGatewayClient: () => ({ id: 'a' }),
    getClientForGateway: (gw) => (gw === 'gw-offline' ? null : { id: gw }),
    groupRoomStore: {
      async renameRoom(id, title, client) {
        if (failRename) throw new Error('rename err');
        renamedOn.push([id, title, client.id]);
      },
    },
    cancelColdStartFocus: () => {},
    selectSession: async () => {},
    openBotChat: async () => {},
    openGroupRoom: async () => {},
    fetchProjects: async () => {},
    fetchGroupRooms: async () => {},
    beginLeftRailResize: () => {},
    getActivityVariant: () => 'pulse',
    activeRunningSessionIds: new Set(),
    unreadSessionIds: new Set(),
    getActiveStreamingStoredSessionId: () => '',
    activeRunningGroupRoomIds: new Set(),
    unreadGroupRoomIds: new Set(),
    activeRunningBotNames: new Set(),
    unreadBotNames: new Set(),
    resolveAgentAvatar: () => '',
    activityTransitionTracker: new ActivityTransitionTracker({ windowMs: 850 }),
  });
  await ctrl.confirmGroupRename('r1', 'Beta Renamed', 'gw-b');
  assert.deepEqual(renamedOn, [['r1', 'Beta Renamed', 'gw-b']]);
  // Omitted gatewayId uses activeFocus.gatewayId ('gw-a'), or room/activeGatewayId when session focus
  await ctrl.confirmGroupRename('r1', 'Alpha Via Focus');
  assert.equal(renamedOn.at(-1)[2], 'gw-a');
  lrState.activeFocus = { type: 'session', sessionId: 's1' };
  failRename = true;
  await ctrl.confirmGroupRename('r-unknown', 'Ghost Room');
  await ctrl.confirmGroupRename('r1', 'Rollback Room', 'gw-b');
  assert.equal(lrState.groupRooms.find((r) => r.gatewayId === 'gw-b').name, 'Beta Renamed');
  await ctrl.confirmGroupRename('r1', 'Offline Nope', 'gw-offline');

  // MediaResolver URL branches including empty getGatewayUrlForGateway + empty state.gatewayUrl
  const mediaState = createInitialState({ platform: 'win32' });
  mediaState.activeFocus = { type: 'session', sessionId: 's1', gatewayId: 'gw-b' };
  mediaState.gatewayUrl = '';
  const resolverEmptyUrl = createMediaResolver({
    getState: () => mediaState,
    getDesktopApi: () => undefined,
    getGatewayClient: () => null,
    getClientForGateway: () => null,
    getGatewayUrlForGateway: () => '',
  });
  assert.equal(await resolverEmptyUrl.resolveMediaUrl('https://external.local/img.png'), 'https://external.local/img.png');

  // ModalInteractionController contextMenu disband-group error & delete forwarding
  let disbandFail = true;
  const deletedArgs = [];
  let modalCommit = {};
  const modalState = createInitialState({ platform: 'win32' });
  const modalCtrl = createModalInteractionController({
    getState: () => modalState,
    commitState: (p) => {
      modalCommit = { ...modalCommit, ...p };
      Object.assign(modalState, p);
    },
    requestRender: () => {},
    restoreComposerFocus: () => {},
    createNewSession: async () => null,
    deleteSession: async (id, gw) => { deletedArgs.push([id, gw]); },
    renameSession: async () => {},
    pinSession: async () => {},
    archiveSession: async () => {},
    exportMarkdown: async () => {},
    copySessionId: async () => {},
    openBotChat: async () => {},
    openBotSettings: () => {},
    openGroupRoom: async () => {},
    createGroupRoom: async () => null,
    disbandGroupRoom: async () => {
      if (disbandFail) throw new Error('disband err');
    },
    fetchGroupRooms: async () => {},
    t: (k) => k,
  });
  modalCtrl.handleContextMenuAction('disband-group', { x: 0, y: 0, targetType: 'group', targetId: 'r1', targetName: 'R1', gatewayId: 'gw-b' });
  modalState.confirmModal.onConfirm();
  await flushMicrotasks();
  assert.equal(modalCommit.dockNotice, 'ctx.disbandGroupFailed');
  disbandFail = false;
  modalCtrl.handleContextMenuAction('delete', { x: 0, y: 0, targetType: 'session', targetId: 's1', targetName: '', gatewayId: 'gw-b' });
  modalState.confirmModal.onConfirm();
  assert.deepEqual(deletedArgs, [['s1', 'gw-b']]);
});

test('M1.3 GroupOperation / ProfileManagement / SessionOperation / MessageLoading full branch coverage', async () => {
  // 1. GroupOperationService openGroupRoom (polling active) + createGroupRoom + disbandGroupRoom
  const gState = createInitialState({ platform: 'win32' });
  gState.gatewayCount = 2;
  gState.activeGatewayId = 'gw-a';
  gState.activeSessionId = 's1';
  gState.activeFocus = { type: 'session', sessionId: 's1', gatewayId: 'gw-a' };
  gState.messages = [{ id: 'm1', role: 'user', content: 'from A', timestamp: '10:00' }];
  gState.groupRooms = [
    { roomId: 'room-1', name: 'Room A', members: ['coder'], createdAt: 1, updatedAt: 1, gatewayId: 'gw-a' },
    { roomId: 'room-1', name: 'Room B', members: ['coder'], createdAt: 1, updatedAt: 1, gatewayId: 'gw-b' },
  ];
  gState.sessions = [{ id: 'cand-a', title: 'Cand A', botName: 'default', timestamp: 1, time: '1', preview: '', gatewayId: 'gw-a' }];
  const gMsgCache = new Map();
  const unreadGroups = new Set(['gw-b::room-1']);
  const runningGroups = new Set(['gw-b::room-1']);
  const pollerStarted = [];
  const pollerStopped = [];
  const selectedAfterDisband = [];
  let disbandOk = true;

  const clientA = { id: 'client-a', async listProfiles() { return []; }, async call() { return {}; } };
  const clientB = {
    id: 'client-b',
    async listProfiles() { return []; },
    async call(method) {
      if (method === 'groups.list') return { rooms: [] };
      return {};
    },
  };
  const groupSvc = createGroupOperationService({
    getState: () => gState,
    getGatewayClient: () => clientA,
    getClientForGateway: (gw) => (gw === 'gw-b' ? clientB : gw === 'gw-offline' ? null : clientA),
    onActiveFocusChanged: () => {},
    render: () => {},
    t: (k) => k,
    disarmRollbackOnLeave: () => {},
    unreadGroupRoomIds: unreadGroups,
    activeRunningGroupRoomIds: runningGroups,
    activityTransitionTracker: new ActivityTransitionTracker({ windowMs: 850 }),
    groupRoomStore: {
      async fetchLogs() {
        return [{ messageId: 'm-b', actorKind: 'user', senderProfile: 'user', text: 'hi from B', timestamp: 100 }];
      },
      async listRooms() {
        return [{ roomId: 'room-1', name: 'Room A', members: ['coder'], createdAt: 1, updatedAt: 1 }];
      },
      getLogs: () => [],
      async createRoom() { return { room_id: 'created-b' }; },
      async disbandRoom() { return disbandOk; },
    },
    turnExecutionService: {
      resetActiveGroupThread() {},
      syncGroupRoomLogsToState() {},
      async refreshGroupRoomLog() { return 0; },
      async sendGroupMessage() {},
    },
    groupPollerManager: {
      isPolling: () => false,
      startAwaitReply: (id) => pollerStarted.push(id),
      stop: (id) => pollerStopped.push(id),
      stopAll() {},
    },
    persistGroupsToCache: () => {},
    resolveAgentAvatar: () => '',
    formatTimestamp: () => '10:00',
    nextLoadMessagesGeneration: () => 1,
    getCurrentLoadMessagesGeneration: () => 1,
    sessionMessagesCache: gMsgCache,
    activeRunningSessionIds: new Set(),
    activeRunningBotNames: new Set(),
    onGroupDisbanded: () => {},
    selectSession: async (id, opts) => { selectedAfterDisband.push([id, opts]); },
  });
  await groupSvc.fetchGroupRooms();
  await groupSvc.openGroupRoom('room-1', 'gw-b');
  assert.deepEqual(pollerStarted, ['room-1']);
  assert.equal(gMsgCache.get('gw-a::s1')?.[0]?.content, 'from A');

  // disbandGroupRoom branches: offline noop, !ok throw, candidate switch, empty fallback
  await groupSvc.disbandGroupRoom('room-1', 'gw-offline');
  disbandOk = false;
  await assert.rejects(() => groupSvc.disbandGroupRoom('room-1', 'gw-b'), /disband rejected/);
  disbandOk = true;
  await groupSvc.disbandGroupRoom('room-1', 'gw-b');
  assert.equal(pollerStopped.at(-1), 'room-1');
  assert.deepEqual(selectedAfterDisband.at(-1), ['cand-a', { gatewayId: 'gw-a' }]);
  gState.sessions = [{ id: 'cand-nogw', title: 'NoGw', botName: 'default', timestamp: 1, time: '1', preview: '' }];
  gState.activeFocus = { type: 'group', roomId: 'room-1', gatewayId: 'gw-a' };
  await groupSvc.disbandGroupRoom('room-1', 'gw-a');
  assert.deepEqual(selectedAfterDisband.at(-1), ['cand-nogw', undefined]);

  gState.groupRooms = [{ roomId: 'room-last', name: 'Last', members: [], createdAt: 1, updatedAt: 1 }];
  gState.sessions = [];
  gState.activeFocus = { type: 'group', roomId: 'room-last' };
  await groupSvc.disbandGroupRoom('room-last');
  assert.equal(gState.activeFocus.type, 'session');

  // 2. ProfileManagementService openBotChat all branches (localForever offline, stale guard, error rollbacks)
  const pState = createInitialState({ platform: 'win32' });
  pState.gatewayCount = 2;
  pState.activeGatewayId = 'gw-a';
  pState.activeSessionId = 's1';
  pState.activeFocus = { type: 'session', sessionId: 's1', gatewayId: 'gw-a' };
  pState.messages = [{ id: 'm1', role: 'user', content: 'from A', timestamp: '10:00' }];
  pState.profiles = [{ name: 'coder', displayName: 'Coder', gatewayId: 'gw-b' }];
  pState.sessions = [{ id: 'fc-off', title: 'FC Off', botName: 'offbot', hidden: true, timestamp: 1, time: '1', preview: '', gatewayId: 'gw-offline' }];
  const botCache = new Map([['gw-a:coder', 'fc-a']]);
  const selectCalls = [];
  const groupCalls = [];
  let pGen = 0;
  let botFail = false;
  let mutateDuringCall = null;
  const pClientB = {
    async request(m, p) { return this.call(m, p); },
    async call(m) {
      mutateDuringCall?.();
      if (botFail) throw new Error('forever create err');
      if (m === 'session.list') return { sessions: [{ session_id: 'fc-b', hidden: true, profile: 'coder' }] };
      if (m === 'session.create') return { session_id: 'fc-b' };
      return {};
    },
    async listSessions() {
      return { ok: true, sessions: [{ id: 'fc-b', title: 'FC B', botName: 'coder', hidden: true, timestamp: 1, time: '1' }] };
    },
  };
  const profSvc = createProfileManagementService({
    getState: () => pState,
    getGatewayClient: () => clientA,
    getClientForGateway: (gw) => (gw === 'gw-b' ? pClientB : gw === 'gw-offline' ? null : clientA),
    onActiveFocusChanged: () => {},
    render: () => {},
    t: (k) => k,
    describeRpcError: (e) => String(e),
    botActivityStore: { persist() {}, withActivityMap: (fn) => fn(new Map()), updateLatestActivity() {} },
    unreadBotNames: new Set(['gw-b:coder']),
    activityTransitionTracker: new ActivityTransitionTracker({ windowMs: 850 }),
    sessionMessagesCache: new Map(),
    syncProfileLastMessages: () => {},
    applyColdStartFocus: async () => {},
    cancelColdStartFocus: () => {},
    fetchSessions: async () => {},
    fetchModelOptions: async () => {},
    selectSession: async (id, opts) => { selectCalls.push([id, opts]); },
    openGroupRoom: async (id, gw) => { groupCalls.push([id, gw]); },
    restoreComposerFocus: () => {},
    disarmRollbackOnLeave: () => {},
    persistAgentsToCache: () => {},
    persistAvatarCache: () => {},
    profileAvatarCache: new Map(),
    botForeverChatCache: botCache,
    nextLoadMessagesGeneration: () => ++pGen,
    getCurrentLoadMessagesGeneration: () => pGen,
  });
  await profSvc.openBotChat('coder', 'gw-b');
  assert.equal(botCache.get('gw-b:coder'), 'fc-b');
  assert.equal(selectCalls.at(-1)[1].gatewayId, 'gw-b');

  // Re-enter same bot triggers wasBotFocused branch
  pState.activeSessionId = 'fc-b';
  pState.activeLiveSessionId = 'live-fc-b';
  pState.messages = [{ id: 'm', role: 'user', content: 'hi', timestamp: '10:00' }];
  await profSvc.openBotChat('coder', 'gw-b');

  // Offline localForever hit
  pState.profiles.push({ name: 'offbot', displayName: 'Off', gatewayId: 'gw-offline' });
  await profSvc.openBotChat('offbot', 'gw-offline');
  assert.deepEqual(selectCalls.at(-1), ['fc-off', { preserveFocus: true, botName: 'offbot', gatewayId: 'gw-offline' }]);

  // Stale focus return after getOrCreateForeverChat + rollback on error across outgoing focus types (group / bot hit / bot miss / session)
  pState.profiles.push(
    { name: 'stalebot', displayName: 'Stale', gatewayId: 'gw-b' },
    { name: 'failbot', displayName: 'Fail', gatewayId: 'gw-b' },
  );
  mutateDuringCall = () => {
    pState.activeFocus = { type: 'session', sessionId: 'switched', gatewayId: 'gw-a' };
  };
  await profSvc.openBotChat('stalebot', 'gw-b');
  mutateDuringCall = null;
  botFail = true;
  mutateDuringCall = () => {
    pState.activeFocus = { type: 'session', sessionId: 'switched' };
  };
  await profSvc.openBotChat('failbot', 'gw-b');
  mutateDuringCall = null;

  pState.activeFocus = { type: 'group', roomId: 'out-room', gatewayId: 'gw-a' };
  await profSvc.openBotChat('failbot', 'gw-b');
  assert.deepEqual(groupCalls.at(-1), ['out-room', 'gw-a']);

  pState.activeFocus = { type: 'bot', botName: 'coder', gatewayId: 'gw-a' };
  botCache.set('gw-a:coder', 'fc-a');
  pState.profiles.push({ name: 'newbot', displayName: 'New', gatewayId: 'gw-b' });
  await profSvc.openBotChat('newbot', 'gw-b');

  botCache.delete('gw-a:coder');
  pState.activeFocus = { type: 'bot', botName: 'coder', gatewayId: 'gw-a' };
  await profSvc.openBotChat('newbot', 'gw-b');

  pState.activeFocus = { type: 'session', sessionId: '', gatewayId: 'gw-a' };
  await profSvc.openBotChat('newbot', 'gw-b');

  // 3. SessionOperationService & MessageLoadingService remaining edge branches
  const sState = createInitialState({ platform: 'win32' });
  sState.gatewayCount = 2;
  sState.activeGatewayId = 'gw-a';
  sState.activeSessionId = '1';
  sState.activeLiveSessionId = 'live-a-1';
  sState.activeFocus = { type: 'session', sessionId: '1', gatewayId: 'gw-a' };
  sState.messages = [{ id: 'ma1', role: 'user', content: 'A', timestamp: '09:00', rowId: 2, displayKind: 'user' }];
  sState.sessions = [
    { id: '1', title: 'Alpha 1', botName: 'default', timestamp: 10, time: '10', preview: '', gatewayId: 'gw-a' },
    { id: '1', title: 'Beta 1', botName: 'coder', timestamp: 20, time: '20', preview: '', gatewayId: 'gw-b' },
  ];
  const sMsgCache = new Map([['gw-a::1', sState.messages]]);
  const liveReg = new LiveStreamRegistry();
  liveReg.registerStream({
    storedSessionId: '1',
    liveSessionId: 'live-b-1',
    messageId: 'stream-msg-1',
    botName: 'coder',
    origin: 'local',
    startedAt: 1,
    userMessageSynced: true,
    nowMs: 1,
  });
  let throwOnRename = false;
  let deleteMode = 'ok';
  const mClientB = {
    async request(m, p) { return this.call(m, p); },
    async call(m) {
      if (m === 'session.title' && throwOnRename) throw new Error('title fail');
      if (m === 'session.delete') {
        if (deleteMode === 'missing') throw Object.assign(new Error('missing'), { code: 4007 });
        return {};
      }
      if (m === 'session.create') return { session_id: 'created-b', live_session_id: 'live-created-b' };
      if (m === 'session.resume') return { live_session_id: 'live-b-1', session_id: '1', running: true };
      return {};
    },
    async fetchSessionMessages(_sid, opts) {
      if (opts.offset > 0) {
        return { status: 'success', messages: [{ id: 'old-1', role: 'user', content: 'Older B', row_id: 1 }], pagination: { returned: 1 } };
      }
      return { status: 'success', messages: [{ id: 'mb1', role: 'user', content: 'B', row_id: 2 }], pagination: { returned: 1 } };
    },
  };
  const mClientA = {
    async request(m, p) { return this.call(m, p); },
    async call() { return {}; },
    async fetchSessionMessages() {
      return { status: 'success', messages: [{ id: 'ma1', role: 'user', content: 'A', row_id: 1 }], pagination: { returned: 1 } };
    },
  };
  const fakeCache = createFakeCacheService();
  fakeCache.readOlderRows = async () => [{ id: 'cached-old', role: 'user', content: 'CachedOld', timestamp: 1, rowId: 1, displaySeq: 1 }];
  const loadSvc = createMessageLoadingService({
    getState: () => sState,
    getGatewayClient: () => mClientA,
    render: () => {},
    sessionMessagesCache: sMsgCache,
    cacheService: fakeCache,
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
    botForeverChatCache: new Map([['gw-b:coder', '1'], ['rawBotNoColon', 'raw-forever']]),
    sessionPreviewCache: new Map(),
    persistSessionPreviewCache: () => {},
    getActiveStreamingStoredSessionId: () => null,
    getLiveStreamRegistry: () => liveReg,
    defaultSessionHandleRegistry: new SessionHandleRegistry(),
    activeRunningSessionIds: new Set(),
    activityTransitionTracker: new ActivityTransitionTracker({ windowMs: 850 }),
    onActiveTurnDiscovered: () => {},
  });
  // Omitted getClientForGateway uses getGatewayClient(); active stream injects placeholder row under cacheKey!
  await loadSvc.loadMessagesInner('1', 'coder');
  liveReg.removeSession('1');

  const loadSvcMulti = createMessageLoadingService({
    getState: () => sState,
    getGatewayClient: () => mClientA,
    getClientForGateway: (gw) => (gw === 'gw-b' ? mClientB : gw === 'gw-offline' ? null : mClientA),
    render: () => {},
    sessionMessagesCache: sMsgCache,
    cacheService: fakeCache,
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
    botForeverChatCache: new Map([['gw-b:coder', 'other'], ['unscoped', '1']]),
    sessionPreviewCache: new Map(),
    persistSessionPreviewCache: () => {},
    getActiveStreamingStoredSessionId: () => null,
    defaultSessionHandleRegistry: new SessionHandleRegistry(),
    activeRunningSessionIds: new Set(),
    activityTransitionTracker: new ActivityTransitionTracker({ windowMs: 850 }),
    onActiveTurnDiscovered: () => {},
  });
  sState.activeFocus = { type: 'session', sessionId: '1', gatewayId: 'gw-b' };
  sState.activeGatewayId = 'gw-b';
  sState.activeSessionId = '1';
  sState.archivedSessions = [{ id: 'arch-1', title: 'Arch', botName: 'coder', timestamp: 1, time: '1', preview: '', gatewayId: 'gw-b' }];
  await loadSvcMulti.loadMessagesInner('1', 'coder');
  await loadSvcMulti.loadOlderMessages();
  // Cover archive fallback in findMatchingSession
  await loadSvcMulti.loadMessagesInner('arch-1', undefined, undefined, 'gw-b');

  // SessionOperationService remaining branches (disarmRollback, rename error, export no match, unarchive, 4007 delete fallback to openBotChat)
  const openedFallbackBots = [];
  const sessSvc = createSessionOperationService({
    getState: () => sState,
    getGatewayClient: () => mClientA,
    getClientForGateway: (gw) => (gw === 'gw-b' ? mClientB : gw === 'gw-offline' ? null : mClientA),
    getCurrentTicket: () => 'tk-b',
    getEffectiveUrl: (url) => url || 'http://beta.local:8643',
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
    cacheService: fakeCache,
    persistSessionsToCache: () => {},
    forgetOlderCursorState: () => {},
    sessionListGeneration: { invalidateForDelete() {} },
    getActiveStreamingStoredSessionId: () => null,
    resetActiveStreamingState: () => {},
    setPendingScrollToBottom: () => {},
    setLastMessagesSnapshot: () => {},
    loadMessages: async () => {},
    openBotChat: async (bot, gw) => { openedFallbackBots.push([bot, gw]); },
    ensureLiveSessionId: async () => 'live-b-1',
    writeClipboardText: async () => {},
  });
  sState.rollbackArmed = { sessionId: '1', anchor: { kind: 'row', rowId: 1 }, snapshot: [{ id: 'snap', role: 'user', content: 'S', timestamp: '10:00' }] };
  sessSvc.disarmRollbackOnLeave('1');
  assert.equal(sMsgCache.get('gw-b::1')?.[0]?.id, 'snap');

  throwOnRename = true;
  await sessSvc.renameSession('1', 'Beta 1', 'Renamed On Catch', 'gw-b');
  await sessSvc.exportMarkdown('non-existent', 'gw-b');
  await sessSvc.setSessionArchived('arch-1', false, 'coder', 'gw-b');

  deleteMode = 'ok';
  sState.sessions = [{ id: '1', title: 'Only B', botName: 'coder', timestamp: 1, time: '1', preview: '', gatewayId: 'gw-b' }];
  sState.archivedSessions = [];
  sState.activeSessionId = '1';
  sState.activeGatewayId = 'gw-b';
  await sessSvc.deleteSession('1', 'gw-b');
  assert.deepEqual(openedFallbackBots.at(-1), ['default', 'gw-b']);

  deleteMode = 'missing';
  sState.sessions = [{ id: '2', title: 'Missing B', botName: 'coder', timestamp: 1, time: '1', preview: '', gatewayId: 'gw-b' }];
  await sessSvc.deleteSession('2', 'gw-b');
});

test('M1.3 TurnExecutionService remaining branches (poller, truncateAndSubmit, slash, watchdog)', async () => {
  const tState = createInitialState({ platform: 'win32' });
  tState.gatewayCount = 2;
  tState.activeGatewayId = 'gw-b';
  tState.activeSessionId = '1';
  tState.activeLiveSessionId = 'live-b-1';
  tState.activeFocus = { type: 'session', sessionId: '1', gatewayId: 'gw-b' };
  tState.profiles = [{ name: 'helper', displayName: 'Helper', gatewayId: 'gw-b' }];
  tState.sessions = [{ id: '1', title: 'B1', botName: 'coder', timestamp: 1, time: '1', preview: '', gatewayId: 'gw-b' }];
  const bCalls = [];
  const clientA = { async call() { return {}; } };
  const clientB = {
    async call(m, p) {
      bCalls.push([m, p]);
      if (m === 'prompt.submit') return { status: 'streaming', user_row_id: 9 };
      return {};
    },
  };
  let pollerCbs = null;
  let streamCtx = { activeStreamingMessageId: null, activeStreamingStoredSessionId: null, activeStreamingLiveId: null, activeStreamingBotName: null };
  let timedOut = 0;
  let slashRan = 0;
  const turnSvc = createTurnExecutionService({
    getState: () => tState,
    getGatewayClient: () => clientA,
    getClientForGateway: (gw) => (gw === 'gw-b' ? clientB : null),
    getRpcCaller: () => ({ async request() { return {}; } }),
    getInteractiveService: () => ({
      async truncateAndSubmit(caller, opts) {
        await caller.request('prompt.submit', { session_id: opts.sessionId, text: opts.text, row_id: opts.rowId });
        return { status: 'streaming' };
      },
    }),
    getCacheService: () => createFakeCacheService(),
    getGroupRoomStore: () => ({
      getLogs: () => [],
      async sendMessage(_id, _t, _s, c) {
        pollerCbs?.();
        await c.call('groups.send', {});
        return { event: { payload: { thread_id: 'th-1' } } };
      },
      async fetchLogs(_id, c) {
        await c.call('groups.log', {});
        return [{ messageId: 'g1', actorKind: 'assistant', senderProfile: 'helper', text: 'reply', timestamp: 100 }];
      },
    }),
    getActivityTransitionTracker: () => new ActivityTransitionTracker({ windowMs: 850 }),
    getTokenCoalescer: () => ({ flush() {}, clear() {} }),
    getSessionHandleRegistry: () => new SessionHandleRegistry(),
    getSessionMessagesCache: () => new Map([['gw-b::1', [{ id: 'bg', role: 'assistant', content: '', timestamp: '1' }]]]),
    getSessionDrafts: () => new Map(),
    getBotActivityStore: () => ({ updateLatestActivity() {} }),
    getHandoffService: () => ({ async sendBtw() { return { task_id: 'btw-1' }; } }),
    completeEntityTurn: () => { timedOut += 1; },
    getActiveRunningSessionIds: () => new Set(['gw-b::1']),
    getUnreadSessionIds: () => new Set(),
    getActiveRunningBotNames: () => new Set(['gw-b:coder']),
    getUnreadBotNames: () => new Set(),
    getActiveRunningGroupRoomIds: () => new Set(['gw-b::room-b']),
    getUnreadGroupRoomIds: () => new Set(),
    getActiveStreamingContext: () => streamCtx,
    setActiveStreamingContext: (p) => { streamCtx = { ...streamCtx, ...p }; },
    getTurnStartedSessionId: () => null,
    setTurnStartedSessionId: () => {},
    getSessionHistoryTrust: () => new Map(),
    forgetOlderCursorState: () => {},
    createNewSession: async () => {},
    ensureLiveSessionId: async () => 'live-b-1',
    setMessageContent: () => {},
    syncActiveGroupSpeakerFromMessages: () => {},
    resolveAgentAvatar: () => '',
    scrollStreamToBottom: () => {},
    setPendingScrollToBottom: () => {},
    runSlashCommand: async () => { slashRan += 1; },
    enqueueDraft: async () => {},
    handleQueueAction: async () => {},
    render: () => {},
    t: (k) => k,
  });

  try {
    // routeSend slash command check against Gateway B
    await turnSvc.routeSend('/help');
    assert.equal(slashRan, 1);

    // truncateAndSubmit uses resolveTargetRpcCaller(clientB).request(...)
    tState.rollbackArmed = {
      sessionId: '1',
      anchor: { kind: 'row', rowId: 5 },
      snapshot: [{ id: 'u0', role: 'user', content: 'prev', timestamp: '10:00' }],
    };
    tState.messages = [...tState.rollbackArmed.snapshot];
    await turnSvc.sendMessage('truncated resend');
    assert.equal(bCalls.some(([m, p]) => m === 'prompt.submit' && p.row_id === 5), true);

    // syncGroupRoomLogsToState + refreshGroupRoomLog + sendGroupMessage catch branch
    tState.groupRooms = [{ roomId: 'room-b', name: 'RB', members: ['helper'], createdAt: 1, updatedAt: 1, gatewayId: 'gw-b' }];
    tState.activeFocus = { type: 'group', roomId: 'room-b', gatewayId: 'gw-b' };
    await turnSvc.refreshGroupRoomLog('room-b');
    assert.equal(bCalls.some(([m]) => m === 'groups.log'), true);
    assert.equal(tState.messages.length, 1);
    assert.equal(tState.messages[0].content, 'reply');
  } finally {
    turnSvc.disarmTurnWatchdog(true);
    turnSvc.clearPresenceTerminal();
    turnSvc.getGroupPollerManager().stopAll();
  }
});
