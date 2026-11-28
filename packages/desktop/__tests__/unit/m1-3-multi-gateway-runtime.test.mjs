/**
 * M1.3 Desktop 多网关运行时、协调器与单槽隔离清场单测 (TDD RED -> GREEN)
 * (packages/desktop/__tests__/unit/m1-3-multi-gateway-runtime.test.mjs)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CACHE_GATEWAY_ID } from '@hermes-flux/core';
import {
  GATEWAY_REGISTRY_STORAGE_KEY,
  buildGatewaySecretIdKey,
  loadGatewayConfigs,
  saveGatewayConfigs,
  upsertGatewayConfig,
  removeGatewayConfig,
  setGatewayEnabled,
  resolveGatewayPassword,
  saveGatewayPassword,
  deleteGatewayPassword,
} from '../../dist/renderer/gateway/gatewayRegistryStore.mjs';
import { createMultiGatewayRuntime } from '../../dist/renderer/gateway/multiGatewayRuntime.mjs';
import {
  createMultiGatewayCoordinator,
  isActiveEntityGatewayOffline,
} from '../../dist/renderer/gateway/multiGatewayCoordinator.mjs';
import { createTitlebarController } from '../../dist/renderer/titlebarController.mjs';
import { LeftRailSnapshotManager } from '../../dist/renderer/leftrail/leftRailSnapshotManager.mjs';
import { createLeftRailController } from '../../dist/renderer/events/leftRailController.mjs';
import {
  createMediaResolver,
  createSessionDeliverableCoordinator,
} from '../../dist/renderer/services/mediaResolver.mjs';
import { createTurnExecutionService } from '../../dist/renderer/services/turnExecutionService.mjs';
import {
  shouldPreserveConversationShell,
} from '../../dist/renderer/renderCoordinator.mjs';

async function flushMicrotasks(rounds = 8) {
  for (let i = 0; i < rounds; i += 1) {
    await Promise.resolve();
  }
}

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
    if (frame.method === 'prompt.submit') {
      return;
    }
    if (frame.id != null) {
      queueMicrotask(() => {
        this.onmessage?.({
          data: JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: { ok: true } }),
        });
      });
    }
  }

  close() {
    this.readyState = 3;
    this.onclose?.({ code: 1000, reason: 'closed' });
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

test('M1.3 gatewayRegistryStore: 持久化/单机自动迁移/禁写明文密码与安全密钥解析', async () => {
  // 1. Null storage & invalid JSON degrade gracefully
  assert.deepEqual(loadGatewayConfigs(null), []);
  assert.deepEqual(loadGatewayConfigs(createMemoryStorage({ [GATEWAY_REGISTRY_STORAGE_KEY]: '{broken' })), []);
  assert.deepEqual(loadGatewayConfigs(createMemoryStorage({ [GATEWAY_REGISTRY_STORAGE_KEY]: '"not-array"' })), []);

  // 2. Single-gateway auto-migration from flux and legacy aura storage keys
  const legacyFlux = createMemoryStorage({
    hermes_flux_gateway_url: 'http://10.0.0.5:8765/',
    hermes_flux_username: 'alice',
  });
  const migratedFlux = loadGatewayConfigs(legacyFlux);
  assert.equal(migratedFlux.length, 1);
  assert.equal(migratedFlux[0].id, DEFAULT_CACHE_GATEWAY_ID);
  assert.equal(migratedFlux[0].url, 'http://10.0.0.5:8765/');
  assert.equal(migratedFlux[0].username, 'alice');
  assert.equal(migratedFlux[0].enabled, true);

  const legacyAura = createMemoryStorage({
    hermes_aura_gateway_url: 'https://relay.example.com',
    hermes_aura_username: 'bob',
  });
  const migratedAura = loadGatewayConfigs(legacyAura);
  assert.equal(migratedAura.length, 1);
  assert.equal(migratedAura[0].username, 'bob');

  // Empty URL produces no migrated config
  assert.deepEqual(loadGatewayConfigs(createMemoryStorage({ hermes_flux_gateway_url: '   ' })), []);

  // 3. Upsert / remove / toggle enabled + strip accidental plaintext password
  const store = createMemoryStorage();
  const dirtyList = [
    {
      id: 'gw-a',
      name: 'Office Mac',
      shortAlias: 'Office',
      url: 'http://office.local:8765',
      username: 'u1',
      password: 'LEAKED_PASSWORD',
      routeKind: 'direct',
      enabled: true,
    },
  ];
  const writeOk = saveGatewayConfigs(dirtyList, store);
  assert.equal(writeOk.ok, true);
  assert.equal(store.dump()[GATEWAY_REGISTRY_STORAGE_KEY].includes('LEAKED_PASSWORD'), false);

  const afterUpsert = upsertGatewayConfig(loadGatewayConfigs(store), {
    id: 'gw-b',
    name: 'Home Box',
    url: 'http://127.0.0.1:18765',
    routeKind: 'lan',
    enabled: true,
  });
  const afterUpdate = upsertGatewayConfig(afterUpsert, {
    id: 'gw-b',
    name: 'Home Renamed',
    url: 'http://127.0.0.1:18765',
    routeKind: 'relay',
    enabled: true,
  });
  assert.equal(afterUpdate.find((c) => c.id === 'gw-b')?.name, 'Home Renamed');

  const disabled = setGatewayEnabled(afterUpdate, 'gw-b', false);
  assert.equal(disabled.find((c) => c.id === 'gw-b')?.enabled, false);
  const removed = removeGatewayConfig(disabled, 'gw-b');
  assert.equal(removed.length, 1);

  // Storage failure surfaced as StorageWriteFailure
  assert.equal(saveGatewayConfigs(removed, null).reason, 'unavailable');
  assert.equal(
    saveGatewayConfigs(removed, {
      setItem: () => {
        throw Object.assign(new Error('quota'), { name: 'QuotaExceededError' });
      },
    }).reason,
    'quota',
  );

  // 4. Keychain resolution & mutation isolation
  assert.equal(buildGatewaySecretIdKey('  '), '');
  assert.equal(buildGatewaySecretIdKey('gw-a'), 'gw-id:gw-a');

  const secrets = new Map([['gw:http://legacy.local:8765', 'legacy-secret']]);
  const bridge = {
    getGatewaySecret: async (k) => secrets.get(k) ?? null,
    setGatewaySecret: async (k, v) => {
      secrets.set(k, v);
      return true;
    },
    deleteGatewaySecret: async (k) => {
      secrets.delete(k);
      return true;
    },
  };

  assert.equal(
    await resolveGatewayPassword({ id: 'gw-legacy', url: 'http://legacy.local:8765' }, bridge, 'fb'),
    'legacy-secret',
  );
  await saveGatewayPassword({ id: 'gw-legacy', url: 'http://legacy.local:8765' }, 'new-pw', bridge);
  assert.equal(secrets.get('gw-id:gw-legacy'), 'new-pw');
  assert.equal(secrets.get('gw:http://legacy.local:8765'), 'new-pw');
  assert.equal(
    await resolveGatewayPassword({ id: 'gw-legacy', url: 'http://legacy.local:8765' }, bridge),
    'new-pw',
  );

  await saveGatewayPassword({ id: 'gw-legacy', url: 'http://legacy.local:8765' }, '', bridge);
  assert.equal(secrets.has('gw-id:gw-legacy'), false);

  await saveGatewayPassword({ id: 'gw-del', url: 'http://del.local:8765' }, 'pw2', bridge);
  await deleteGatewayPassword({ id: 'gw-del', url: 'http://del.local:8765' }, bridge);
  assert.equal(secrets.has('gw-id:gw-del'), false);
  assert.equal(
    await resolveGatewayPassword({ id: 'gw-missing', url: 'http://missing.local' }, bridge, 'fallback'),
    'fallback',
  );
  assert.equal(
    await resolveGatewayPassword(
      { id: 'gw-err', url: '' },
      {
        getGatewaySecret: async () => {
          throw new Error('keychain locked');
        },
      },
      'fb-err',
    ),
    'fb-err',
  );
});

test('M1.3 multiGatewayRuntime: 并发连接池/REST 同源隔离/断线保活只读缓存与单网关退化', async () => {
  const { socketFactory, sockets } = createFakeSocketEnv();
  const httpCalls = [];
  const runtime = createMultiGatewayRuntime({
    socketFactory,
    enableHeartbeat: false,
    enableLifecycleWake: false,
    resolvePassword: async (cfg) => `pw-${cfg.id}`,
    getDesktopApi: () => ({
      authenticateGateway: async ({ url, username, password }) => {
        if (url.includes('fail-auth')) {
          return { ok: false, message: 'bad credentials', latency: 0, authError: true };
        }
        return {
          ok: true,
          message: 'ok',
          latency: url.includes('8001') ? 12 : 28,
          ticket: `ticket-${username}-${password}`,
          installId: url.includes('8001') ? 'inst-a' : 'inst-b',
        };
      },
      proxyWebSocketUrl: (wsUrl) => wsUrl.replace('/api/ws', '/proxy/api/ws'),
      httpProxy: async (req) => {
        httpCalls.push(req);
        return { proxied: true, baseUrl: req.baseUrl, path: req.path };
      },
    }),
  });

  const cfgA = {
    id: 'gw-a',
    name: 'Office',
    shortAlias: 'Office',
    url: 'http://127.0.0.1:8001',
    username: 'uA',
    routeKind: 'direct',
    enabled: true,
  };
  const cfgB = {
    id: 'gw-b',
    name: 'Home',
    shortAlias: 'Home',
    url: 'http://127.0.0.1:8002',
    username: 'uB',
    routeKind: 'lan',
    enabled: true,
  };

  try {
    runtime.syncGateways([cfgA, cfgB]);
    await runtime.connectAll();
    await flushMicrotasks();

    const healthAll = runtime.getHealthSummary();
    assert.equal(healthAll.totalCount, 2);
    assert.equal(healthAll.onlineCount, 2);
    assert.equal(healthAll.aggregateStatus, 'connected');
    assert.ok(runtime.getClient('gw-a') !== runtime.getClient('gw-b'));
    assert.ok(sockets.some((s) => s.url.includes('/proxy/api/ws?ticket=ticket-uA-pw-gw-a')));

    // REST proxy scoped per slot & cross-origin rejected
    const resA = await runtime.getSlot('gw-a').restProxy({ path: '/api/status' });
    assert.equal(resA.baseUrl, 'http://127.0.0.1:8001');
    await assert.rejects(
      () => runtime.getSlot('gw-a').restProxy({ baseUrl: 'http://evil.local:9999', path: '/api/secret' }),
      /Cross-gateway REST proxy rejected/,
    );

    // Set slices and verify offline cache retention on manual disconnect of B
    runtime.setSlotSlice('gw-a', {
      profiles: [{ name: 'default', displayName: 'Office Def', avatar: '' }],
      sessions: [{ id: 's1', title: 'S1 A', preview: '', time: '', botName: 'default' }],
      groups: [],
    });
    runtime.setSlotSlice('gw-b', {
      profiles: [{ name: 'default', displayName: 'Home Def', avatar: '' }],
      sessions: [{ id: 's1', title: 'S1 B', preview: '', time: '', botName: 'default' }],
      groups: [],
    });

    runtime.disconnectGateway('gw-b');
    const partialHealth = runtime.getHealthSummary();
    assert.equal(partialHealth.aggregateStatus, 'partial');
    assert.equal(partialHealth.onlineCount, 1);

    const partialView = runtime.buildAggregatedView();
    assert.equal(partialView.effectiveGatewayCount, 2);
    assert.equal(partialView.isMultiGateway, true);
    const cachedSessB = partialView.sessions.find((s) => s.gatewayId === 'gw-b');
    assert.ok(cachedSessB, '断线后缓存会话不能被擦除');
    assert.equal(cachedSessB.gatewayOffline, true);

    // Reconnect B
    assert.equal(await runtime.reconnectGateway('gw-b'), true);
    await flushMicrotasks();
    assert.equal(runtime.getHealthSummary().aggregateStatus, 'connected');

    // Remove B -> clean degradation to single-gateway mode
    runtime.syncGateways([cfgA]);
    const singleView = runtime.buildAggregatedView();
    assert.equal(singleView.effectiveGatewayCount, 1);
    assert.equal(singleView.isMultiGateway, false);
    assert.equal(runtime.getSlot('gw-b'), undefined);
  } finally {
    runtime.dispose();
  }
});

test('M1.3 multiGatewayCoordinator + titlebarController + renderCoordinator: 状态聚合、离线只读判据与保留壳层', async () => {
  const { socketFactory } = createFakeSocketEnv();
  const runtime = createMultiGatewayRuntime({
    socketFactory,
    enableHeartbeat: false,
    enableLifecycleWake: false,
    resolvePassword: async () => 'pw',
    getDesktopApi: () => ({
      authenticateGateway: async ({ url }) => ({
        ok: true,
        message: 'ok',
        latency: 18,
        ticket: 'tk',
        installId: url.includes('8001') ? 'inst-1' : 'inst-2',
      }),
    }),
  });

  const state = {
    platform: 'windows',
    isMaximized: false,
    gatewayConnected: true,
    connectionPhase: 'connected',
    connectionReconnectAttempt: 0,
    connectionAuthError: false,
    connectionReason: '',
    gatewayUrl: 'http://127.0.0.1:8001',
    activeGatewayId: 'gw-a',
    gatewayCount: 1,
    activeEntityGatewayOffline: false,
    activeSessionId: 's-shared',
    activeFocus: { type: 'session', sessionId: 's-shared', gatewayId: 'gw-b' },
    profileName: 'default',
    profiles: [],
    sessions: [],
    groupRooms: [],
    messages: [{ id: 'm1', role: 'user', content: 'cached' }],
    leftRailCollapsed: false,
    inspectorCollapsed: true,
    rightPodMode: { kind: 'closed' },
    dockNotice: '',
  };

  let renders = 0;
  let manageTriggered = 0;
  const coordinator = createMultiGatewayCoordinator({
    runtime,
    getState: () => state,
    render: () => {
      renders += 1;
    },
    onManageGateways: () => {
      manageTriggered += 1;
    },
  });

  try {
    runtime.syncGateways([
      { id: 'gw-a', name: 'Office', url: 'http://127.0.0.1:8001', enabled: true, routeKind: 'direct' },
      { id: 'gw-b', name: 'Home', url: 'http://127.0.0.1:8002', enabled: true, routeKind: 'lan' },
    ]);
    await runtime.connectAll();
    await flushMicrotasks();

    runtime.setSlotSlice('gw-a', {
      profiles: [{ name: 'default', displayName: 'Office Bot', avatar: '' }],
      sessions: [{ id: 's-shared', title: 'A Shared', preview: '', time: '', botName: 'default' }],
      groups: [],
    });
    runtime.setSlotSlice('gw-b', {
      profiles: [{ name: 'default', displayName: 'Home Bot', avatar: '' }],
      sessions: [{ id: 's-shared', title: 'B Shared', preview: '', time: '', botName: 'default' }],
      groups: [],
    });

    coordinator.syncPoolToState();
    assert.equal(state.gatewayCount, 2);
    assert.equal(state.activeEntityGatewayOffline, false);
    assert.equal(coordinator.getClientForGateway('gw-a'), runtime.getClient('gw-a'));
    assert.equal(coordinator.getClientForGateway('gw-b'), runtime.getClient('gw-b'));

    // Disconnect gw-b via coordinator -> active entity on gw-b becomes offline read-only!
    assert.equal(coordinator.disconnectGateway('gw-b'), true);
    assert.equal(state.activeEntityGatewayOffline, true);
    assert.equal(state.gatewayHealthSummary?.aggregateStatus, 'partial');
    assert.ok(renders > 0);

    // Switch active focus to gw-a -> editable again
    state.activeFocus = { type: 'session', sessionId: 's-shared', gatewayId: 'gw-a' };
    state.activeGatewayId = 'gw-a';
    assert.equal(coordinator.refreshActiveOfflineState(), false);
    assert.equal(state.activeEntityGatewayOffline, false);

    // Switch back to offline gw-b -> test shouldPreserveConversationShell + TitlebarController
    state.activeFocus = { type: 'bot', botName: 'default', gatewayId: 'gw-b' };
    state.activeGatewayId = 'gw-b';
    assert.equal(coordinator.refreshActiveOfflineState(), true);
    assert.equal(
      isActiveEntityGatewayOffline(
        { ...state, gatewayConnected: false, connectionPhase: 'unconfigured' },
        state.gatewayHealthSummary,
      ),
      true,
    );
    assert.equal(
      shouldPreserveConversationShell({
        ...state,
        gatewayConnected: false,
        connectionPhase: 'unconfigured',
      }),
      true,
    );

    const tb = createTitlebarController({
      getState: () => state,
      render: () => {},
      getDesktopApi: () => undefined,
      t: (k) => k,
    });
    const snap = tb.getTitlebarSnapshot();
    assert.equal(snap.connectionStatus, 'partial');
    assert.equal(snap.gatewayConnected, true);
    assert.equal(snap.gateways?.length, 2);
    assert.equal(snap.gateways?.find((g) => g.gatewayId === 'gw-b')?.connected, false);

    coordinator.onManageGateways?.();
    assert.equal(manageTriggered, 1);
  } finally {
    runtime.dispose();
  }
});

test('M1.3 LeftRailSnapshotManager & LeftRailController: 同名多网关防覆盖、装饰与 gatewayId 透传', () => {
  const sessionA = { id: 'same-id', title: 'S A', preview: 'pA', time: '10:00', botName: 'default', gatewayId: 'gw-a', gatewayLabel: 'Office', gatewayOffline: false };
  const sessionB = { id: 'same-id', title: 'S B', preview: 'pB', time: '10:01', botName: 'default', gatewayId: 'gw-b', gatewayLabel: 'Home', gatewayOffline: true };
  const profA = { name: 'default', displayName: 'Def A', avatar: '', gatewayId: 'gw-a', gatewayLabel: 'Office', gatewayOffline: false };
  const profB = { name: 'default', displayName: 'Def B', avatar: '', gatewayId: 'gw-b', gatewayLabel: 'Home', gatewayOffline: true };
  const groupA = { roomId: 'room-1', name: 'Room 1', members: ['default'], lastMessage: 'hi', updatedAt: 1000, gatewayId: 'gw-a', gatewayLabel: 'Office', gatewayOffline: false, crossGateway: true };

  let sessions = [sessionA, sessionB];
  let groups = [groupA];
  let profiles = [profA, profB];
  let gatewayCount = 2;

  const manager = new LeftRailSnapshotManager({
    getSessions: () => sessions,
    getGroupRooms: () => groups,
    getProfiles: () => profiles,
    getActiveSessionId: () => 'same-id',
    getActiveFocus: () => ({ type: 'session', sessionId: 'same-id', gatewayId: 'gw-b' }),
    getProfileName: () => 'default',
    getSearchQuery: () => '',
    getLayout: () => 'dual-rail',
    getGatewayCount: () => gatewayCount,
    isSessionsGroupExpanded: () => true,
    isGroupsGroupExpanded: () => true,
    getError: () => '',
    isCollapsed: () => false,
    getEditingGroupRoomId: () => undefined,
    getProfilesPhase: () => 'ready',
    getSessionsPhase: () => 'ready',
    getActivityVariant: () => 'cloud',
    getProfilesPhase: () => 'ready',
    getSessionsPhase: () => 'ready',
    getActiveRunningSessionIds: () => new Set(),
    getUnreadSessionIds: () => new Set(),
    getActiveStreamingStoredSessionId: () => null,
    getActiveRunningGroupRoomIds: () => new Set(),
    getUnreadGroupRoomIds: () => new Set(),
    getActiveRunningBotNames: () => new Set(),
    getUnreadBotNames: () => new Set(),
    resolveAgentAvatar: () => '',
    resolveTransition: (_s, _id, st) => ({ state: st, transition: 'none', transitionToken: undefined }),
  });

  const snapMulti = manager.getSnapshot(1000);
  assert.equal(snapMulti.model.isMultiGateway, true);
  assert.equal(snapMulti.model.allAgents.length, 2);

  // Changing only gatewayOffline / gatewayLabel must invalidate decorated objects
  sessionB.gatewayOffline = false;
  sessionB.gatewayLabel = 'Home2';
  const decoratedSessions = manager.decorateSessions(2000);
  assert.equal(decoratedSessions.length, 2);
  assert.equal(decoratedSessions.find((s) => s.gatewayId === 'gw-b')?.gatewayLabel, 'Home2');

  // Changing gatewayCount flips sameLeftRailInputs -> grouped model updates cleanly
  gatewayCount = 1;
  const snapSingle = manager.getSnapshot(3000);
  assert.equal(snapSingle.model.isMultiGateway, false);

  // LeftRailController forwards gatewayId on select and menu callbacks
  const forwarded = [];
  const state = {
    sessions: [sessionA, sessionB],
    groupRooms: [groupA],
    profiles: [profA, profB],
    projects: [],
    orgFolders: [],
    orgAssignments: {},
    orgDoneRooms: {},
    orgContainerCollapsed: { done: true },
    orgPrefs: {},
    activeSessionId: 'same-id',
    activeFocus: { type: 'session', sessionId: 'same-id', gatewayId: 'gw-a' },
    profileName: 'default',
    gatewayCount: 2,
    sessionSearchQuery: '',
    leftRailLayout: 'dual-rail',
    isBotsGroupExpanded: true,
    isSessionsGroupExpanded: true,
    isGroupsGroupExpanded: true,
    leftRailCollapsed: false,
    profilesPhase: 'ready',
    sessionsPhase: 'ready',
    sessionContextMenu: null,
    newTaskModalTab: 'solo',
    isNewTaskModalOpen: false,
  };
  const controller = createLeftRailController({
    getState: () => state,
    render: () => {},
    t: (k) => k,
    showToast: () => {},
    describeRpcError: String,
    getGatewayClient: () => null,
    groupRoomStore: { renameRoom: async () => {} },
    cancelColdStartFocus: () => {},
    selectSession: (id, opts) => forwarded.push(['session', id, opts]),
    openBotChat: (p, gw) => forwarded.push(['bot', p, gw]),
    openGroupRoom: (r, gw) => forwarded.push(['group', r, gw]),
    fetchProjects: () => {},
    fetchGroupRooms: () => {},
    beginLeftRailResize: () => {},
    getActivityVariant: () => 'cloud',
    activeRunningSessionIds: new Set(),
    unreadSessionIds: new Set(),
    getActiveStreamingStoredSessionId: () => null,
    activeRunningGroupRoomIds: new Set(),
    unreadGroupRoomIds: new Set(),
    activeRunningBotNames: new Set(),
    unreadBotNames: new Set(),
    resolveAgentAvatar: () => '',
    activityTransitionTracker: { resolveTransition: (_s, _id, st) => ({ state: st, transition: 'none' }) },
  });
  const actions = controller.createLeftRailActions();
  actions.onSelectSession('same-id', 'default', 'gw-b');
  actions.onSelectBot('default', 'gw-b');
  actions.onSelectGroup('room-1', 'gw-a');
  assert.deepEqual(forwarded, [
    ['session', 'same-id', { botName: 'default', gatewayId: 'gw-b' }],
    ['bot', 'default', 'gw-b'],
    ['group', 'room-1', 'gw-a'],
  ]);
  actions.onOpenSessionMenu('same-id', 'S B', 10, 20, 'default', 'gw-b');
  assert.equal(state.sessionContextMenu.gatewayId, 'gw-b');
  actions.onOpenBotMenu('default', 11, 21, 'gw-b');
  assert.equal(state.sessionContextMenu.gatewayId, 'gw-b');
  actions.onOpenGroupMenu('room-1', 'Room 1', 12, 22, 'gw-a');
  assert.equal(state.sessionContextMenu.gatewayId, 'gw-a');
});

test('M1.3 mediaResolver & turnExecutionService: activeGatewayId 缓存锚定、多机同名流隔离与离线只读拦截', async () => {
  // 1. mediaResolver anchors cache & deliverable scope on activeGatewayId across URL changes
  const rpcCalls = [];
  const state = {
    activeGatewayId: 'gw-office',
    gatewayUrl: 'http://192.168.1.50:8765',
    profileName: 'default',
    activeSessionId: 's1',
    activeFocus: { type: 'session', sessionId: 's1', gatewayId: 'gw-office' },
    messages: [],
    attachments: [],
    groupRooms: [],
    sessions: [],
    profiles: [{ name: 'default', displayName: 'Default' }],
    gatewayConnected: true,
    activeEntityGatewayOffline: true,
    isStreaming: false,
    queuedMessages: [],
    pickedMention: null,
    dockNotice: '',
  };
  const slotClient = {
    call: async (method, params) => {
      rpcCalls.push({ method, params });
      return { content: 'data:image/png;base64,SLOT_A' };
    },
  };
  const resolver = createMediaResolver({
    getState: () => state,
    getDesktopApi: () => ({
      httpProxy: async () => 'data:image/png;base64,HTTP_A',
    }),
    getGatewayClient: () => null,
    getClientForGateway: (gwId) => (gwId === 'gw-office' ? slotClient : null),
  });
  const first = await resolver.resolveMediaUrl('/out/pic.png');
  assert.equal(first, 'data:image/png;base64,HTTP_A');
  // Hot-switch route URL for the same gatewayId -> must hit cache, 0 extra calls!
  state.gatewayUrl = 'https://office-relay.example.com';
  const second = await resolver.resolveMediaUrl('/out/pic.png');
  assert.equal(second, 'data:image/png;base64,HTTP_A');

  const deliv = createSessionDeliverableCoordinator({
    getState: () => state,
    getDesktopApi: () => undefined,
    onVerifiedPathsUpdated: () => {},
  });
  deliv.scheduleVerification();
  deliv.clear();

  // 2. turnExecutionService blocks offline gateway sends cleanly with explicit notice
  const renderedNotices = [];
  let clientCalled = 0;
  const turnSvc = createTurnExecutionService({
    getState: () => state,
    render: () => renderedNotices.push(state.dockNotice),
    t: (key) => key,
    getGatewayClient: () => ({
      call: async () => {
        clientCalled += 1;
        return {};
      },
    }),
    getGroupRoomStore: () => ({ getLogs: () => [], sendMessage: async () => ({}) }),
    getSessionHandleRegistry: () => ({ register: () => {} }),
    getBotActivityStore: () => ({ updateLatestActivity: () => {} }),
    getActivityTransitionTracker: () => ({ clear: () => {} }),
    getTokenCoalescer: () => ({ flush: () => {}, clear: () => {} }),
    getSessionMessagesCache: () => new Map(),
    getActiveStreamingContext: () => ({ activeStreamingMessageId: null }),
    setActiveStreamingContext: () => {},
    getActiveRunningSessionIds: () => new Set(),
    getUnreadSessionIds: () => new Set(),
    getActiveRunningBotNames: () => new Set(),
    getUnreadBotNames: () => new Set(),
    getActiveRunningGroupRoomIds: () => new Set(),
    getUnreadGroupRoomIds: () => new Set(),
    setTurnStartedSessionId: () => {},
    setPendingScrollToBottom: () => {},
    scrollStreamToBottom: () => {},
    syncActiveGroupSpeakerFromMessages: () => {},
    createNewSession: async () => {},
    ensureLiveSessionId: async () => 'live-1',
    fetchSessions: async () => {},
    runSlashCommand: async () => {},
    enqueueDraft: async () => {},
    handleQueueAction: async () => {},
    refreshActiveSession: async () => {},
  });

  await turnSvc.sendMessage('should be blocked when offline');
  assert.equal(clientCalled, 0, '离线网关禁止发起 prompt.submit RPC');
  assert.equal(state.dockNotice, 'gateway.offlineReadOnlyNotice');
  assert.equal(renderedNotices.at(-1), 'gateway.offlineReadOnlyNotice');

  state.dockNotice = '';
  await turnSvc.sendGroupMessage('room-1', 'blocked group');
  assert.equal(clientCalled, 0, '离线群聊禁止发起 groups.send RPC');
  assert.equal(state.dockNotice, 'gateway.offlineReadOnlyNotice');
});
