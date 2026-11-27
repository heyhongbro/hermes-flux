/**
 * M1.3 Desktop Edge Coverage Split (Store / Runtime / Snapshot / Media / RenderCoordinator)
 * (packages/desktop/__tests__/unit/m1-3-multi-gateway-runtime-edge.test.mjs)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GATEWAY_REGISTRY_STORAGE_KEY,
  loadGatewayConfigs,
  saveGatewayConfigs,
  upsertGatewayConfig,
  resolveGatewayPassword,
  saveGatewayPassword,
} from '../../dist/renderer/gateway/gatewayRegistryStore.mjs';
import { createMultiGatewayRuntime } from '../../dist/renderer/gateway/multiGatewayRuntime.mjs';
import {
  createDesktopMultiGatewayWiring,
  isActiveEntityGatewayOffline,
} from '../../dist/renderer/gateway/multiGatewayCoordinator.mjs';
import { LeftRailSnapshotManager } from '../../dist/renderer/leftrail/leftRailSnapshotManager.mjs';
import {
  createMediaResolver,
  createSessionDeliverableCoordinator,
} from '../../dist/renderer/services/mediaResolver.mjs';
import { createRenderCoordinator } from '../../dist/renderer/renderCoordinator.mjs';

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

test('M1.3 Desktop Full Edge Coverage: store/runtime/coordinator/snapshot/media/renderCoordinator 全分支闭环', async () => {
  // 1. gatewayRegistryStore global localStorage + throwing accessor + sanitize edge cases
  const origLsDesc = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  try {
    delete globalThis.localStorage;
    assert.deepEqual(loadGatewayConfigs(), []);

    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('blocked');
      },
    });
    assert.deepEqual(loadGatewayConfigs(), []);

    const memLs = createMemoryStorage({
      hermes_flux_gateway_url: 'http://127.0.0.1:8765',
    });
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: memLs,
    });
    const migratedNoUser = loadGatewayConfigs();
    assert.equal(migratedNoUser.length, 1);
    assert.equal(migratedNoUser[0].username, undefined);

    // Throwing getItem, missing getItem, + invalid items inside registry JSON
    assert.deepEqual(loadGatewayConfigs({ setItem: () => {} }), []);
    assert.deepEqual(
      loadGatewayConfigs({
        getItem: () => {
          throw new Error('read boom');
        },
        setItem: () => {},
      }),
      [],
    );
    assert.deepEqual(
      loadGatewayConfigs(
        createMemoryStorage({
          [GATEWAY_REGISTRY_STORAGE_KEY]: JSON.stringify([
            null,
            { id: 123, url: 456 },
            { id: '', url: 'http://x' },
            { id: 'gw-1', url: 'http://valid.local:8765', name: '', routeKind: 'bogus', enabled: false, installId: 'i1', fingerprint: 'f1' },
            { id: 'gw-2', url: 'http://n.local:8765' },
          ]),
        }),
      ),
      [
        {
          id: 'gw-1',
          name: 'valid.local',
          url: 'http://valid.local:8765',
          enabled: false,
          routeKind: 'direct',
          installId: 'i1',
          fingerprint: 'f1',
        },
        {
          id: 'gw-2',
          name: 'n.local',
          url: 'http://n.local:8765',
          enabled: true,
          routeKind: 'direct',
        },
      ],
    );
  } finally {
    if (origLsDesc) Object.defineProperty(globalThis, 'localStorage', origLsDesc);
    else delete globalThis.localStorage;
  }

  assert.equal(
    saveGatewayConfigs([{ id: '', name: 'bad', url: '' }, { id: 'ok', name: 'OK', url: 'http://ok.local' }], createMemoryStorage()).ok,
    true,
  );
  assert.deepEqual(upsertGatewayConfig([], { id: '', name: '', url: '' }), []);
  assert.equal(await resolveGatewayPassword({ id: 'a', url: 'http://x' }, null, 'fb'), 'fb');
  assert.equal(
    await resolveGatewayPassword({ id: '', url: '' }, { getGatewaySecret: async () => null }, 'fb2'),
    'fb2',
  );
  await saveGatewayPassword({ id: 'a', url: 'http://x' }, 'pw', null);
  await saveGatewayPassword(
    { id: 'a', url: 'http://x' },
    'pw',
    {
      setGatewaySecret: async () => {
        throw new Error('keychain err');
      },
    },
  );

  // 2. multiGatewayRuntime edge paths
  const { socketFactory, sockets } = createFakeSocketEnv();
  const eventsSeen = [];
  const srvSeen = [];
  const slicesSeen = [];
  const runtime = createMultiGatewayRuntime({
    socketFactory,
    enableHeartbeat: false,
    enableLifecycleWake: false,
    resolvePassword: async () => 'p',
    getDesktopApi: () => ({
      authenticateGateway: async ({ url }) => {
        if (url.includes('explicit-bool')) return { ok: false, message: 'denied', authError: true, latency: 0 };
        if (url.includes('empty-msg')) return { ok: false, message: '', latency: 0 };
        if (url.includes('unauth')) return { ok: false, message: '401 Unauthorized', latency: 0 };
        if (url.includes('timeout')) return { ok: false, message: 'network timeout', latency: 0 };
        return { ok: true, message: 'ok', latency: 10, ticket: 't' };
      },
    }),
    onHealthChange: () => {},
    onSlotEvent: (gw, p) => eventsSeen.push([gw, p]),
    onSlotServerRequest: async (gw, req) => {
      srvSeen.push([gw, req.method]);
      return { ok: true };
    },
    onSlicesUpdated: (v) => slicesSeen.push(v),
  });

  assert.equal(runtime.getClient(), null);
  assert.equal(runtime.getSlot(), undefined);
  assert.equal(runtime.getClient('missing'), null);
  assert.equal(runtime.getSlot('missing'), undefined);

  runtime.syncGateways([
    { id: 'gw-1', name: 'One', url: 'http://127.0.0.1:9101', enabled: true },
    { id: 'gw-empty', name: 'Empty', url: '', enabled: true },
    { id: 'gw-bool', name: 'Bool', url: 'http://explicit-bool.local', enabled: true },
    { id: 'gw-emsg', name: 'EmptyMsg', url: 'http://empty-msg.local', enabled: true },
    { id: 'gw-unauth', name: 'Unauth', url: 'http://unauth.local', enabled: true },
    { id: 'gw-timeout', name: 'Timeout', url: 'http://timeout.local', enabled: true },
  ]);
  await runtime.connectGateway('gw-1');
  await runtime.connectGateway('gw-empty');
  await runtime.connectGateway('gw-bool');
  await runtime.connectGateway('gw-emsg');
  await runtime.connectGateway('gw-unauth');
  await runtime.connectGateway('gw-timeout');
  await flushMicrotasks();

  assert.equal(runtime.getSlot('gw-bool')?.authError, true);
  assert.equal(runtime.getSlot('gw-emsg')?.authError, false);
  assert.equal(runtime.getSlot('gw-unauth')?.authError, true);
  assert.equal(runtime.getSlot('gw-timeout')?.authError, false);
  assert.ok(runtime.getClient() === runtime.getClient('gw-1'));
  assert.ok(runtime.getSlot() === runtime.getSlot('gw-1'));

  // Update existing slot config & test setSlotSlice partial updates
  runtime.syncGateways([{ id: 'gw-1', name: 'One Updated', url: 'http://127.0.0.1:9101', enabled: true }]);
  runtime.setSlotSlice('gw-1', { sessions: [{ id: 's1', title: 'S1', model: 'm', time: '', preview: '', isArchived: false }] });
  runtime.setSlotSlice('gw-unknown', {});
  assert.ok(slicesSeen.length >= 2);

  // Deliver slot event + server request
  sockets[0].onmessage?.({ data: JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { kind: 'ping' } }) });
  sockets[0].onmessage?.({ data: JSON.stringify({ jsonrpc: '2.0', id: 'sreq-1', method: 'tool.confirm', params: {} }) });
  await flushMicrotasks();
  assert.equal(eventsSeen.length, 1);
  assert.equal(srvSeen.length, 1);

  await assert.rejects(() => runtime.getSlot('gw-1').restProxy({ path: '/x' }), /httpProxy bridge unavailable/);
  runtime.disconnectAll(true);
  runtime.dispose();

  // Bare runtime without desktopApi / optional listeners
  const bareRt = createMultiGatewayRuntime({
    socketFactory,
    enableHeartbeat: false,
    enableLifecycleWake: false,
    resolvePassword: async () => '',
    getDesktopApi: () => undefined,
  });
  bareRt.syncGateways([{ id: 'g-bare', name: 'Bare', url: 'http://127.0.0.1:9202' }]);
  assert.equal(await bareRt.connectGateway('g-bare'), false);
  // Simulate server request when no onSlotServerRequest callback is passed (must complete handshake first)
  bareRt.syncGateways([{ id: 'g-srv', name: 'Srv', url: 'http://127.0.0.1:9203' }]);
  await bareRt.connectGateway('g-srv', 'ws://127.0.0.1:9203/api/ws');
  await flushMicrotasks(12);
  const bareSock = sockets.at(-1);
  bareSock.onmessage?.({ data: JSON.stringify({ jsonrpc: '2.0', id: 'srv-x', method: 'm', params: {} }) });
  await flushMicrotasks(12);
  assert.equal(bareSock.sent.some((raw) => JSON.parse(raw).id === 'srv-x'), true);
  bareRt.dispose();

  // 3. multiGatewayCoordinator: group focus offline, fallback focus gw, health-slot fallback, zero/single slot, reconnectGateway, wiring
  const noGwFocusState = {
    activeGatewayId: undefined,
    activeFocus: { type: 'bot', botName: 'default' },
    profiles: [],
    sessions: [],
    groupRooms: [],
  };
  assert.equal(isActiveEntityGatewayOffline(noGwFocusState), false);
  const groupState = {
    activeGatewayId: 'gw-g1',
    gatewayConnected: true,
    gatewayCount: 1,
    gatewayHealthSummary: undefined,
    activeEntityGatewayOffline: false,
    activeFocus: { type: 'group', roomId: 'room-1', gatewayId: 'gw-g1' },
    profiles: [],
    sessions: [],
    groupRooms: [{ roomId: 'room-1', name: 'R1', members: [], gatewayId: 'gw-g1', gatewayOffline: true }],
  };
  assert.equal(isActiveEntityGatewayOffline(groupState), true);
  groupState.groupRooms = [{ roomId: 'room-other', name: 'RO', members: [], gatewayId: 'gw-g1' }];
  assert.equal(
    isActiveEntityGatewayOffline(groupState, {
      aggregateStatus: 'partial',
      totalCount: 1,
      onlineCount: 0,
      slots: [{ gatewayId: 'gw-g1', name: 'G1', shortLabel: 'G1', url: 'http://a', status: 'offline', connected: false, routeKind: 'direct', reconnectAttempt: 0, authError: false }],
    }),
    true,
  );
  assert.equal(
    isActiveEntityGatewayOffline(groupState, {
      aggregateStatus: 'connected',
      totalCount: 1,
      onlineCount: 1,
      slots: [{ gatewayId: 'gw-other', name: 'G2', shortLabel: 'G2', url: 'http://b', status: 'connected', connected: true, routeKind: 'direct', reconnectAttempt: 0, authError: false }],
    }),
    false,
  );

  // Wiring helper with configured storage + throwing storage
  const wiringState = {
    ...groupState,
    password: 'pw',
    gatewayUrl: '',
    connectionPhase: 'unconfigured',
  };
  const savedLs = globalThis.localStorage;
  try {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: createMemoryStorage({ hermes_flux_gateway_url: 'http://127.0.0.1:9300' }),
    });
    const w = createDesktopMultiGatewayWiring({
      getState: () => wiringState,
      getDesktopApi: () => undefined,
      render: () => {},
    });
    assert.ok(await w.coordinator.reconnectGateway('__default__') === false);
    w.runtime.setSlotSlice('__default__', { profiles: [{ name: 'default', displayName: 'Def' }] });
    w.runtime.dispose();

    // Also trigger 0-slot syncPoolToState branch
    const emptyWiring = createDesktopMultiGatewayWiring({
      getState: () => wiringState,
      getDesktopApi: () => undefined,
      render: () => {},
    });
    emptyWiring.runtime.syncGateways([]);
    const emptyView = emptyWiring.coordinator.syncPoolToState();
    assert.equal(emptyView.effectiveGatewayCount, 0);
    assert.equal(wiringState.gatewayCount, 1);
    emptyWiring.runtime.dispose();

    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('storage disabled');
      },
    });
    const wFail = createDesktopMultiGatewayWiring({
      getState: () => wiringState,
      getDesktopApi: () => undefined,
      render: () => {},
    });
    wFail.runtime.dispose();
  } finally {
    if (savedLs !== undefined) {
      Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: savedLs });
    } else {
      delete globalThis.localStorage;
    }
  }

  // 4. leftRailSnapshotManager without getGatewayCount & decorateGroups variations
  const snapMgrBare = new LeftRailSnapshotManager({
    getSessions: () => [],
    getGroupRooms: () => [
      { roomId: 'g-off', name: 'OfflineG', members: [], gatewayOffline: true, crossGateway: false },
      { roomId: 'g-on', name: 'OnlineG', members: [], gatewayOffline: false, crossGateway: true },
    ],
    getProfiles: () => [],
    getActiveSessionId: () => '',
    getActiveFocus: () => ({ type: 'bot', botName: 'default' }),
    getProfileName: () => 'default',
    getSearchQuery: () => '',
    isSessionsGroupExpanded: () => true,
    isGroupsGroupExpanded: () => true,
    getError: () => '',
    isCollapsed: () => false,
    getEditingGroupRoomId: () => undefined,
    getProfilesPhase: () => 'ready',
    getSessionsPhase: () => 'ready',
    getActivityVariant: () => 'cloud',
    getActiveRunningSessionIds: () => new Set(),
    getUnreadSessionIds: () => new Set(),
    getActiveStreamingStoredSessionId: () => null,
    getActiveRunningGroupRoomIds: () => new Set(),
    getUnreadGroupRoomIds: () => new Set(),
    getActiveRunningBotNames: () => new Set(),
    getUnreadBotNames: () => new Set(),
    resolveAgentAvatar: () => '',
    resolveTransition: (_s, _id, st) => ({ state: st, transition: 'none' }),
  });
  assert.equal(snapMgrBare.getSnapshot().model.isMultiGateway, false);

  // 5. mediaResolver & deliverables with both activeGatewayId & gatewayUrl omitted
  const bareMediaState = {
    activeGatewayId: undefined,
    gatewayUrl: '',
    profileName: '',
    activeSessionId: 's1',
    activeFocus: { type: 'session', sessionId: 's1' },
    messages: [],
  };
  const bareResolver = createMediaResolver({
    getState: () => bareMediaState,
    getDesktopApi: () => undefined,
    getGatewayClient: () => null,
  });
  await bareResolver.resolveMediaUrl('/x.png');
  const bareDeliv = createSessionDeliverableCoordinator({
    getState: () => bareMediaState,
    getDesktopApi: () => undefined,
    onVerifiedPathsUpdated: () => {},
  });
  bareDeliv.scheduleVerification();
  bareDeliv.getSessionDeliverables();

  // 6. renderCoordinator.render() with activeEntityGatewayOffline = true (dockNotice empty + non-empty)
  const savedDoc = globalThis.document;
  const savedWin = globalThis.window;
  const savedRaf = globalThis.requestAnimationFrame;
  const savedGcs = globalThis.getComputedStyle;
  const savedHtml = globalThis.HTMLElement;
  const makeStubEl = (id) => ({
    id,
    innerHTML: '',
    className: '',
    style: { setProperty() {}, getPropertyValue: () => '', removeProperty() {} },
    dataset: {},
    children: [],
    childElementCount: 0,
    setAttribute() {},
    getAttribute: () => null,
    removeAttribute() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    appendChild() {},
    removeChild() {},
    addEventListener() {},
    removeEventListener() {},
    focus() {},
    blur() {},
    click() {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    getBoundingClientRect: () => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 }),
  });
  const appRootEl = makeStubEl('flux-app-root');
  const streamEl = makeStubEl('conversation-stream');
  globalThis.document = {
    getElementById: (id) => (id === 'flux-app-root' ? appRootEl : id === 'conversation-stream' ? streamEl : null),
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: (tag) => makeStubEl(tag),
    addEventListener() {},
    removeEventListener() {},
    documentElement: {
      style: { setProperty() {}, getPropertyValue: () => '', removeProperty() {} },
      dataset: {},
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      setAttribute() {},
      getAttribute: () => null,
      removeAttribute() {},
    },
    body: makeStubEl('body'),
    head: makeStubEl('head'),
  };
  globalThis.window = { addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) };
  globalThis.requestAnimationFrame = (cb) => {
    cb();
    return 1;
  };
  globalThis.getComputedStyle = () => ({ paddingBottom: '0px', getPropertyValue: () => '' });
  globalThis.HTMLElement = savedHtml ?? class HTMLElement {};
  try {
    const rcState = {
      platform: 'windows',
      theme: 'obsidian-gold',
      lang: 'en',
      isMaximized: false,
      leftRailCollapsed: false,
      inspectorCollapsed: true,
      rightPodMode: { kind: 'closed' },
      activeInspectorTab: 'files',
      activeSessionId: 's-off',
      activeFocus: { type: 'session', sessionId: 's-off', gatewayId: 'gw-off' },
      messages: [],
      gatewayConnected: true,
      gatewayConnecting: false,
      connectionPhase: 'connected',
      hasOlderMessages: false,
      isLoadingOlder: false,
      messagesPhase: 'ready',
      profileName: 'default',
      artifacts: [],
      attachments: [],
      availableModels: [],
      collapsedProviders: [],
      favoriteModels: [],
      gitDiffs: [],
      memories: [],
      mentionItems: [],
      modelCatalog: {},
      modelDetails: [],
      openFiles: [],
      queuedMessages: [],
      recentModels: [],
      sideAgentCapsules: [],
      slashItems: [],
      rollbackArmed: null,
      activeFilePath: '',
      approvalMode: 'smart',
      currentProvider: 'auto',
      dockNotice: '',
      fileSearchOpen: false,
      fileSearchQuery: '',
      fileShowLineNumbers: false,
      fileViewMode: 'rendered',
      fileWordWrap: false,
      inspectorFullscreen: false,
      isSettingsOpen: false,
      mentionPopperOpen: false,
      modelMenuOpen: false,
      modelSearchQuery: '',
      selectedModel: 'auto',
      reasoningLevel: 'medium',
      settingsSection: 'appearance',
      conversationWidth: 'wide',
      leftRailLayout: 'dual-rail',
      slashPopperOpen: false,
      gatewayUrl: 'http://localhost',
      modelCatalogHash: '',
      activeEntityGatewayOffline: true,
    };
    const rc = createRenderCoordinator({
      getState: () => rcState,
      messageWindowManager: {
        ensureMessageWindow() {},
        getMessageWindowStart: () => 0,
        getMessageWindowEnd: () => 0,
        computeContentOffsetPx: () => 0,
        computeVirtualHeightPx: () => 0,
        scheduleVirtualHeightSync() {},
        markProgrammaticScroll() {},
      },
      modalInteractionController: {
        renderTaskModalHtml: () => '',
        renderContextMenuHtml: () => '',
        renderConfirmModalHtml: () => '',
        updateModals() {},
      },
      isStreamingActiveForCurrentSession: () => false,
      resolveSessionKnownFiles: () => [],
      getTitlebarSnapshot: () => ({ title: 'Flux' }),
      getLeftRailSnapshot: () => ({ items: [] }),
      createLeftRailActions: () => ({}),
      getPromptNavigatorSnapshot: () => ({ entries: [] }),
      createPromptNavigatorActions: () => ({}),
      rebuildPromptEntries() {},
      syncPromptNavigatorMeta() {},
      syncPromptNavigator() {},
      syncReactSettings() {},
      ensureSettingsSectionData() {},
      syncAgentPresenceHost() {},
      syncAgentPresence() {},
      captureStreamAnchor: () => ({ id: 'top', offset: 0 }),
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
    rc.render();
    assert.ok(appRootEl.innerHTML.length > 0);
    rcState.dockNotice = 'Explicit notice overrides default';
    rc.render();
    rcState.dockNotice = '';
    rcState.activeEntityGatewayOffline = false;
    rc.render();
    rc.dispose();
  } finally {
    globalThis.document = savedDoc;
    globalThis.window = savedWin;
    globalThis.requestAnimationFrame = savedRaf;
    globalThis.getComputedStyle = savedGcs;
    globalThis.HTMLElement = savedHtml;
  }
});
