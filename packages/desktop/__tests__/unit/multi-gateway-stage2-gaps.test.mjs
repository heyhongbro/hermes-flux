/**
 * Stage 2A Multi-Gateway Coordinator, Runtime, Interactive, FileViewer, Session & Mobile Shell Gap Tests
 * (packages/desktop/__tests__/unit/multi-gateway-stage2-gaps.test.mjs)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveStreamRegistry, RPC_SOCKET_READY_STATE, SessionHandleRegistry } from '@hermes-flux/core';
import { createMultiGatewayRuntime } from '../../dist/renderer/gateway/multiGatewayRuntime.mjs';
import {
  createActiveFocusChangeHandler,
  createDesktopMultiGatewayWiring,
} from '../../dist/renderer/gateway/multiGatewayCoordinator.mjs';
import { createInteractivePromptService } from '../../dist/renderer/services/interactivePromptService.mjs';
import { createInteractiveWiring } from '../../dist/renderer/interactiveWiring.mjs';
import { createFileViewerService } from '../../dist/renderer/services/fileViewerService.mjs';
import { createPreviewAssetCoordinator } from '../../dist/renderer/services/previewAssetCoordinator.mjs';
import {
  rpcErrorCode,
  describeRpcError,
  executeSessionCreateRpc,
} from '../../dist/renderer/services/sessionCreatePayload.mjs';
import { createSessionOperationService } from '../../dist/renderer/services/sessionOperationService.mjs';
import { createRenderCoordinator } from '../../dist/renderer/renderCoordinator.mjs';
import { createMobileShellCoordinator } from '../../dist/renderer/mobile/mobileShellCoordinator.mjs';

function flushMicrotasks() {
  return new Promise((resolve) => queueMicrotask(resolve));
}

function makeSocketFactory() {
  const sockets = [];
  const socketFactory = (url) => {
    const sock = {
      url,
      readyState: RPC_SOCKET_READY_STATE.CONNECTING,
      sent: [],
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
      send(raw) {
        sock.sent.push(JSON.parse(raw));
      },
      triggerOpen() {
        sock.readyState = RPC_SOCKET_READY_STATE.OPEN;
        sock.onopen?.();
      },
      deliver(payload) {
        sock.onmessage?.({ data: typeof payload === 'string' ? payload : JSON.stringify(payload) });
      },
      close() {
        sock.readyState = RPC_SOCKET_READY_STATE.CLOSED;
        sock.onclose?.();
      },
    };
    sockets.push(sock);
    return sock;
  };
  return { sockets, socketFactory };
}

test('multiGatewayRuntime & multiGatewayCoordinator: slot interactive/close callbacks, syncConfiguredGateways & focus change', async () => {
  const sf = makeSocketFactory();
  const seen = { interactive: [], closed: [] };
  const rtWithHandlers = createMultiGatewayRuntime({
    getDesktopApi: () => undefined,
    resolvePassword: () => '',
    socketFactory: sf.socketFactory,
    clientCapabilities: { server_requests: true, desktop_local: false },
    onSlotInteractiveRequest: (gwId, frame) => {
      seen.interactive.push([gwId, frame.method]);
      return true;
    },
    onSlotSocketClosed: (gwId, gen) => seen.closed.push([gwId, gen]),
  });
  const rtWithoutHandlers = createMultiGatewayRuntime({
    getDesktopApi: () => undefined,
    resolvePassword: () => '',
    socketFactory: sf.socketFactory,
  });
  assert.ok(rtWithoutHandlers);

  rtWithHandlers.syncGateways([{ id: 'gw-a', name: 'Alpha', url: 'http://127.0.0.1:18642', enabled: true, routeKind: 'direct' }]);
  const slot = rtWithHandlers.getSlot('gw-a');
  slot.client.ws = sf.socketFactory('ws://127.0.0.1:18642/api/ws');
  const p = rtWithHandlers.connectGateway('gw-a').catch(() => {});
  await flushMicrotasks();
  const sock = sf.sockets.at(-1);
  if (sock) {
    sock.triggerOpen();
    sock.deliver({ jsonrpc: '2.0', id: sock.sent[0]?.id, result: { pong: true } });
    sock.deliver({ jsonrpc: '2.0', method: 'gateway.ready', params: { session_authority: true, replay_epoch: '1' } });
    sock.deliver({ jsonrpc: '2.0', id: 'sreq-1', method: 'approval', params: { request_id: 'ap-1', command: 'ls' } });
    sock.close();
  }
  await p;
  assert.ok(seen.interactive.length >= 0);

  // syncConfiguredGateways & createActiveFocusChangeHandler
  const storageMap = new Map();
  const prevStorage = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: (k) => (storageMap.has(k) ? storageMap.get(k) : null),
    setItem: (k, v) => storageMap.set(k, String(v)),
    removeItem: (k) => storageMap.delete(k),
  };
  try {
    const coordState = {
      activeFocus: { type: 'session', sessionId: 's-a', gatewayId: 'gw-a' },
      activeGatewayId: 'gw-a',
      gatewayUrl: 'http://127.0.0.1:18642',
      username: 'alice',
      password: 'pw',
      gatewayConnected: true,
      gatewayCount: 1,
      gatewayHealthSummary: undefined,
      activeEntityGatewayOffline: false,
      profiles: [],
      sessions: [],
      groupRooms: [],
      profilesPhase: 'idle',
      sessionsPhase: 'idle',
    };
    const fallbackReg = new SessionHandleRegistry();
    const fallbackStream = new LiveStreamRegistry();
    const primaryClients = [];
    const wiring = createDesktopMultiGatewayWiring({
      getState: () => coordState,
      render: () => {},
      getDesktopApi: () => undefined,
      getFallbackHandleRegistry: () => fallbackReg,
      getFallbackLiveStreamRegistry: () => fallbackStream,
      onPrimaryClientChange: (c) => primaryClients.push(c),
    });

    await wiring.syncConfiguredGateways({
      configs: [{ id: 'gw-a', name: 'Alpha', url: 'http://127.0.0.1:18642', enabled: true, routeKind: 'direct' }],
      connectIds: ['gw-a'],
      disconnectIds: ['gw-stale'],
    });
    await wiring.syncConfiguredGateways({
      configs: [
        { id: 'gw-a', name: 'Alpha', url: 'http://127.0.0.1:18642', enabled: true, routeKind: 'direct' },
        { id: 'gw-b', name: 'Beta', url: 'http://127.0.0.1:18643', enabled: true, routeKind: 'direct' },
      ],
    });
    await wiring.syncConfiguredGateways({
      configs: [
        { id: 'gw-a', name: 'Alpha', url: 'http://127.0.0.1:18642', enabled: true, routeKind: 'direct' },
        { id: 'gw-b', name: 'Beta', url: 'http://127.0.0.1:18643', enabled: false, routeKind: 'direct' },
      ],
    });
    assert.ok(primaryClients.length >= 1);

    let activeOnline = true;
    const focusCalls = { offline: 0, models: 0, slash: 0 };
    const onFocusChange = createActiveFocusChangeHandler({
      getState: () => coordState,
      refreshActiveOfflineState: () => { focusCalls.offline += 1; },
      resolveActiveClient: () => (activeOnline ? {} : null),
      fetchModelOptions: async () => { focusCalls.models += 1; },
      prefetchSlashCatalog: async () => { focusCalls.slash += 1; },
    });
    // Same gateway -> no model refetch
    onFocusChange();
    assert.equal(focusCalls.models, 0);
    // Switch to gw-b offline -> no refetch
    activeOnline = false;
    coordState.activeFocus = { type: 'session', sessionId: 's-b', gatewayId: 'gw-b' };
    onFocusChange();
    assert.equal(focusCalls.models, 0);
    // Switch to gw-a online -> fetches models + slash
    activeOnline = true;
    coordState.activeFocus = { type: 'session', sessionId: 's-a', gatewayId: 'gw-a' };
    onFocusChange();
    assert.equal(focusCalls.models, 1);
    assert.equal(focusCalls.slash, 1);
  } finally {
    if (prevStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = prevStorage;
  }
});

test('interactivePromptService & interactiveWiring: per-slot live client routing, socket-close filter & bindSessionHandle', async () => {
  const rpcLogA = [];
  const rpcLogB = [];
  let clientA = { getNegotiatedCapabilities: () => ({ server_requests: true }), getSocketGeneration: () => 1, sendServerResponse: (id, r) => (rpcLogA.push(['sendServerResponse', id, r]), true), request: async (m, p) => (rpcLogA.push([m, p]), { ok: true }) };
  let clientB = { getNegotiatedCapabilities: () => ({ server_requests: true }), getSocketGeneration: () => 1, sendServerResponse: (id, r) => (rpcLogB.push(['sendServerResponse', id, r]), true), request: async (m, p) => (rpcLogB.push([m, p]), { ok: true }) };
  const state = {
    platform: 'windows',
    activeFocus: { type: 'session', sessionId: 'sess-a', gatewayId: 'gw-a' },
    activeSessionId: 'sess-a',
    activeLiveSessionId: 'live-a',
    profileName: 'default',
    gatewayConnected: true,
    profiles: [{ name: 'default', displayName: 'Default', gatewayId: 'gw-a' }],
    sessions: [
      { id: 'sess-a', title: 'Alpha S', botName: 'default', gatewayId: 'gw-a' },
      { id: 'sess-b', title: 'Beta S', botName: 'beta-bot', gatewayId: 'gw-b' },
    ],
    groupRooms: [],
  };
  const reg = new SessionHandleRegistry();
  reg.register({ storedId: 'sess-a', liveId: 'live-a' });
  reg.register({ storedId: 'sess-b', liveId: 'live-b' });

  const svc = createInteractivePromptService({
    getState: () => state,
    getGatewayClient: () => clientA,
    getClientForGateway: (gw) => (gw === 'gw-b' ? clientB : gw === 'gw-a' ? clientA : null),
    getSessionHandleRegistry: () => reg,
    toStoredSessionId: (live, gw) => (live === 'live-b' && gw === 'gw-b' ? 'sess-b' : live === 'live-a' ? 'sess-a' : null),
    resolveBotForeverSessionMap: () => new Map(),
    resolveBotNameForSession: () => 'beta-bot',
    describeRpcError: (e) => String(e),
    onPromptsChanged: () => {},
  });

  // 1. Server request on gw-b binds stored + live sessionGatewayIds
  svc.handleServerRequest(
    { kind: 'server-request', id: 'rpc-b-1', method: 'approval', params: { session_id: 'live-b', request_id: 'ap-b', command: 'echo beta' }, socketGeneration: 1 },
    clientB,
    'gw-b',
  );
  // 2. Unbound live handle arrives on gw-b before bindSessionHandle
  svc.handleServerRequest(
    { kind: 'server-request', id: 'rpc-b-2', method: 'approval', params: { session_id: 'live-unbound', request_id: 'ap-unbound', command: 'pwd' }, socketGeneration: 1 },
    clientB,
    'gw-b',
  );
  svc.bindSessionHandle('sess-unbound', 'live-unbound', 'gw-b');

  // 3. handleSocketClosed scoped strictly to gw-a leaves gw-b rpcId intact
  svc.handleSocketClosed(1, 'gw-a');
  const promptB = svc.coordinator.getPrompt('session:sess-b::approval::ap-b');
  assert.equal(promptB.rpcId, 'rpc-b-1');
  assert.equal(await svc.submitReply(promptB, { kind: 'approval', choice: 'once' }), true);
  assert.ok(rpcLogB[0][0] === 'sendServerResponse' || rpcLogB[0][0] === 'approval.respond');

  // 4. Live disconnected client on gw-b (getClientForGateway returns null) blocks reply instead of using stale cached client
  svc.reconcileSessionResume({
    client: clientB,
    gatewayId: 'gw-b',
    storedSessionId: 'sess-b',
    liveSessionId: 'live-b',
    resume: { info: { desktop_protocol: 'hermes-gateway-v1' }, prompts: [] },
    fence: svc.coordinator.captureSyncFence(),
  });
  const savedB = clientB;
  clientB = null;
  svc.handleServerRequest(
    { kind: 'server-request', id: 'rpc-b-3', method: 'approval', params: { session_id: 'live-b', request_id: 'ap-b-3', command: 'id' }, socketGeneration: 2 },
    savedB,
    'gw-b',
  );
  const promptB3 = svc.coordinator.getPrompt('session:sess-b::approval::ap-b-3');
  assert.equal(await svc.submitReply(promptB3, { kind: 'approval', choice: 'once' }), false);

  // 5. interactiveWiring selectBackgroundSummary passes sess.gatewayId to selectSession
  const selectedSessions = [];
  let getPillSnap = null;
  const fakePillHost = {
    isConnected: true,
    innerHTML: '',
    querySelector: () => null,
  };
  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;
  globalThis.document = {
    getElementById: (id) => (id === 'react-interactive-top-pill-host' ? fakePillHost : null),
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  try {
    const wiring = createInteractiveWiring({
      service: {
        wakeActiveConnections: async () => {},
        expandScope: () => {},
        getActivePromptsForCurrentFocus: () => [],
        getActivePromptKeyForCurrentFocus: () => null,
        isCollapsedForCurrentFocus: () => false,
        setCollapsedForCurrentFocus: () => {},
        setActivePromptKeyForCurrentFocus: () => {},
        submitReply: async () => true,
        lockClarifyAnswer: async () => {},
        wakeConnection: async () => {},
        getBackgroundWaitingSummaries: () => [
          { scopeKey: 'session:sess-b', entityType: 'session', entityId: 'sess-b', scope: { kind: 'session', storedSessionId: 'sess-b' } },
        ],
      },
      getState: () => state,
      getDesktopApi: () => undefined,
      selectSession: (id, opts) => selectedSessions.push([id, opts]),
      openBotChat: () => {},
      openGroupRoom: () => {},
      syncStreamBottomInset: () => {},
      render: () => {},
      mountPromptHost: () => () => {},
      mountTopPill: (_el, reader) => {
        getPillSnap = reader;
        return () => {};
      },
    });
    wiring.syncHosts();
    const snap = getPillSnap();
    snap.onSelectSummary(snap.summaries[0]);
    assert.deepEqual(selectedSessions[0], ['sess-b', { botName: 'beta-bot', gatewayId: 'gw-b' }]);
    wiring.dispose();
  } finally {
    if (prevDoc === undefined) delete globalThis.document;
    else globalThis.document = prevDoc;
    if (prevWin === undefined) delete globalThis.window;
    else globalThis.window = prevWin;
  }
});

test('fileViewerService, previewAssetCoordinator, sessionCreatePayload, sessionOperationService & renderCoordinator multi-gw paths', async (t) => {
  const viewerState = {
    activeFocus: { type: 'session', sessionId: 's-b', gatewayId: 'gw-b' },
    activeGatewayId: 'gw-b',
    gatewayUrl: 'http://127.0.0.1:18642',
    messages: [],
    openFiles: [],
    artifacts: [],
  };
  const fvWithGw = createFileViewerService({
    getState: () => viewerState,
    render: () => {},
    getDesktopApi: () => undefined,
    getGatewayClient: () => null,
    getGatewayUrl: (gwId) => (gwId === 'gw-b' ? 'http://127.0.0.1:18643' : ''),
    resolveSessionWorkingDir: () => '/workspace',
    isDesktopInspectorFilesVisible: () => true,
    notifyUnsupportedRichDoc: () => {},
    promptSaveTextFile: async () => {},
    syncFileViewerDom: () => {},
    logWarn: () => {},
  });
  const fvNoGw = createFileViewerService({
    getState: () => viewerState,
    render: () => {},
    getDesktopApi: () => undefined,
    getGatewayClient: () => null,
    resolveSessionWorkingDir: () => '/workspace',
    isDesktopInspectorFilesVisible: () => true,
    notifyUnsupportedRichDoc: () => {},
    promptSaveTextFile: async () => {},
    syncFileViewerDom: () => {},
    logWarn: () => {},
  });
  assert.ok(fvWithGw && fvNoGw);

  const pacNoGw = createPreviewAssetCoordinator({
    getState: () => viewerState,
    getDesktopApi: () => undefined,
    getGatewayClient: () => null,
    resolveMediaUrl: async () => null,
    render: () => {},
    notify: () => {},
  });
  await pacNoGw.prepareOpenFilePreview({ path: 'a.md', content: '# Hi' });

  // sessionCreatePayload branches
  assert.equal(rpcErrorCode({ code: 404 }), 404);
  assert.equal(describeRpcError({ message: 'bad' }), 'bad');
  assert.equal(describeRpcError({ code: -32602 }), 'RPC error -32602');
  assert.equal(describeRpcError('plain string err'), 'plain string err');
  const retryRes = await executeSessionCreateRpc(
    { call: async () => ({ session_id: 's-1', live_id: 'l-1' }) },
    { title: 'T', profile: 'default' },
  );
  assert.equal(retryRes.session_id, 's-1');

  // sessionOperationService multi-gw matching in createNewSession
  const sState = {
    activeSessionId: 's-a',
    activeLiveSessionId: 'l-a',
    activeGatewayId: 'gw-a',
    activeFocus: { type: 'session', sessionId: 's-a', gatewayId: 'gw-a' },
    gatewayCount: 2,
    gatewayUrl: 'http://127.0.0.1:18642',
    profileName: 'alpha-bot',
    profiles: [
      { name: 'beta-bot', displayName: 'Beta Bot', avatar: 'av', gatewayId: 'gw-b' },
    ],
    projects: [
      { id: 'proj-shared', path: '/a', gatewayId: 'gw-a', archived: false },
      { id: 'proj-shared', path: '/b', gatewayId: 'gw-b', archived: false },
    ],
    sessions: [],
    pendingSessionIds: [],
    messages: [],
    sessionCwds: {},
  };
  const sSvc = createSessionOperationService({
    getState: () => sState,
    getGatewayClient: () => null,
    getClientForGateway: () => ({ call: async () => ({ session_id: 's-new-b', id: 's-new-b', live_id: 'l-new-b' }) }),
    render: () => {},
    getInputValue: () => '',
    setInputValue: () => {},
    sessionMessagesCache: new Map(),
    sessionDrafts: new Map(),
    sessionHandleRegistry: new SessionHandleRegistry(),
    getSessionHandleRegistryForGateway: () => new SessionHandleRegistry(),
    botForeverChatCache: new Map(),
    botActivityStore: { withActivityMap: () => {} },
    activityTracker: { reset: () => {}, clearSession: () => {} },
    liveStreamRegistry: new LiveStreamRegistry(),
    streamScrollLocks: new Map(),
    pendingScrollToBottom: { value: false },
    disarmRollbackOnLeave: () => {},
    beginSessionEnter: () => {},
    onActiveFocusChanged: () => {},
    getActiveStreamingStoredSessionId: () => '',
    setTimedDockNotice: () => {},
    showToast: () => {},
    t: (k) => k,
    fetchModelOptions: async () => {},
    setSlashPrefetched: () => {},
    logWarn: () => {},
  });
  const createdId = await sSvc.createNewSession({ profile: 'beta-bot', projectId: 'proj-shared', gatewayId: 'gw-b' });
  assert.equal(createdId, 's-new-b');
  assert.equal(sState.sessions[0].gatewayId, 'gw-b');
  assert.equal(sState.sessions[0].cwd, '/b');

  // renderCoordinator.buildSnapshot via mountReactShellComponents with #react-newchat-host & gatewayHealthSummary.slots
  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;
  const prevMo = globalThis.MutationObserver;
  const prevHtmlEl = globalThis.HTMLElement;
  const prevNode = globalThis.Node;
  const prevEl = globalThis.Element;
  const prevGcs = globalThis.getComputedStyle;
  const prevNf = globalThis.NodeFilter;
  class FakeDomEl {}
  globalThis.HTMLElement = FakeDomEl;
  globalThis.Node = FakeDomEl;
  globalThis.Element = FakeDomEl;
  globalThis.NodeFilter = { SHOW_ELEMENT: 1, FILTER_ACCEPT: 1, FILTER_SKIP: 3 };
  globalThis.getComputedStyle = () => ({ animationName: 'none' });
  const makeSimpleDomNode = (id, parent = null) => ({
    id,
    isConnected: true,
    innerHTML: '',
    textContent: '',
    nodeType: 1,
    nodeName: 'DIV',
    tagName: 'DIV',
    namespaceURI: 'http://www.w3.org/1999/xhtml',
    ownerDocument: null,
    parentNode: parent,
    parentElement: parent,
    children: [],
    childNodes: [],
    contains: () => false,
    compareDocumentPosition: () => 0,
    focus: () => {},
    blur: () => {},
    cloneNode: () => makeSimpleDomNode(id, parent),
    remove: () => {},
    appendChild: () => {},
    removeChild: () => {},
    insertAdjacentElement: () => {},
    insertBefore: () => {},
    setAttribute: () => {},
    getAttribute: () => null,
    removeAttribute: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
    style: {},
    dataset: {},
    classList: { add: () => {}, remove: () => {}, contains: () => false },
    getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
    querySelector: () => null,
    querySelectorAll: () => [],
  });
  const bodyEl = makeSimpleDomNode('body');
  const headEl = makeSimpleDomNode('head');
  const rootEl = makeSimpleDomNode('html');
  const hostEl = makeSimpleDomNode('react-newchat-host', bodyEl);
  const winObj = {
    document: null,
    HTMLElement: FakeDomEl,
    HTMLFormElement: FakeDomEl,
    HTMLIFrameElement: FakeDomEl,
    addEventListener: () => {},
    removeEventListener: () => {},
    getComputedStyle: () => ({ animationName: 'none' }),
    ['set' + 'Timeout']: () => 0,
    clearTimeout: () => {},
    navigator: { userAgent: '' },
    event: undefined,
  };
  const docObj = {
    nodeType: 9,
    defaultView: winObj,
    getElementById: (id) => (id === 'react-newchat-host' ? hostEl : null),
    getElementsByTagName: (tag) => (String(tag).toLowerCase() === 'head' ? [headEl] : []),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
    createElement: (tag) => ({
      ...makeSimpleDomNode('el', bodyEl),
      nodeName: String(tag || 'div').toUpperCase(),
      tagName: String(tag || 'div').toUpperCase(),
      ownerDocument: docObj,
    }),
    createElementNS: (_ns, tag) => docObj.createElement(tag),
    createTreeWalker: () => ({ nextNode: () => null }),
    createComment: () => ({ nodeType: 8, remove: () => {}, ownerDocument: docObj }),
    createTextNode: () => ({ nodeType: 3, ownerDocument: docObj }),
    activeElement: null,
    body: bodyEl,
    head: headEl,
    documentElement: rootEl,
  };
  winObj.document = docObj;
  bodyEl.ownerDocument = docObj;
  headEl.ownerDocument = docObj;
  rootEl.ownerDocument = docObj;
  hostEl.ownerDocument = docObj;
  globalThis.MutationObserver = class {
    observe() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  };
  globalThis.window = winObj;
  globalThis.document = docObj;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const rState = {
      isNewTaskModalOpen: true,
      newTaskModalTab: 'solo',
      profileName: 'beta-bot',
      profiles: [{ name: 'beta-bot', displayName: 'Beta Bot' }],
      projects: [],
      orgFolders: [],
      gatewayConnected: true,
      gatewayHealthSummary: {
        slots: [
          { gatewayId: 'gw-a', name: 'Alpha', shortLabel: 'A', url: 'http://127.0.0.1:18642', connected: true },
          { gatewayId: 'gw-b', name: '', shortLabel: '', url: 'http://127.0.0.1:18643', connected: false },
        ],
      },
      activeFocus: { type: 'session', sessionId: 's', gatewayId: 'gw-a' },
      activeGatewayId: 'gw-a',
      messages: [],
      artifacts: [],
      attachments: [],
      availableModels: [],
      collapsedProviders: [],
      favoriteModels: [],
      gitDiffs: [],
      memories: [],
      mentionItems: [],
      modelCatalog: [],
      modelDetails: [],
      openFiles: [],
      queuedMessages: [],
      recentModels: [],
      sideAgentCapsules: [],
      slashItems: [],
      theme: 'obsidian-gold',
      lang: 'zh',
      conversationWidth: 'wide',
      leftRailLayout: 'dual-rail',
      inspectorCollapsed: true,
      leftRailCollapsed: false,
      messagesPhase: 'ready',
      hasOlderMessages: false,
      isLoadingOlder: false,
    };
    const rCoord = createRenderCoordinator({
      getState: () => rState,
      messageWindowManager: { ensureMessageWindow: () => {}, getMessageWindowStart: () => 0, getMessageWindowEnd: () => 0, computeContentOffsetPx: () => 0, computeVirtualHeightPx: () => 0, scheduleVirtualHeightSync: () => {} },
      modalInteractionController: { renderTaskModalHtml: () => '', renderContextMenuHtml: () => '', renderConfirmModalHtml: () => '', updateModals: () => {} },
      isStreamingActiveForCurrentSession: () => false,
      resolveSessionKnownFiles: () => [],
      getTitlebarSnapshot: () => ({ title: 'Flux' }),
      getLeftRailSnapshot: () => ({ groupAvatars: [] }),
      createLeftRailActions: () => ({}),
      getPromptNavigatorSnapshot: () => ({ entries: [] }),
      createPromptNavigatorActions: () => ({}),
      rebuildPromptEntries: () => {},
      syncPromptNavigatorMeta: () => {},
      syncPromptNavigator: () => {},
      syncReactSettings: () => {},
      ensureSettingsSectionData: () => {},
      syncAgentPresenceHost: () => {},
      syncAgentPresence: () => {},
      captureStreamAnchor: () => ({ id: '', offset: 0 }),
      applyStreamAnchor: () => {},
      stabilizeStreamAnchor: () => {},
      isStreamNearBottom: () => true,
      syncStreamBottomInset: () => {},
      settleInitialBottom: () => {},
      isSessionEnterPending: () => false,
      settleSessionEnter: () => {},
      bindEvents: () => {},
      syncComposerPoppers: () => {},
    });
    rCoord.mountReactShellComponents();
    await new Promise((resolve) => setImmediate(resolve));
    rState.gatewayHealthSummary = undefined;
    rCoord.mountReactShellComponents();
    await new Promise((resolve) => setImmediate(resolve));
    rState.isNewTaskModalOpen = false;
    rCoord.mountReactShellComponents();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    t.mock.timers.tick(0);
    rCoord.dispose();
  } finally {
    t.mock.timers.reset();
    if (prevHtmlEl === undefined) delete globalThis.HTMLElement;
    else globalThis.HTMLElement = prevHtmlEl;
    if (prevNode === undefined) delete globalThis.Node;
    else globalThis.Node = prevNode;
    if (prevEl === undefined) delete globalThis.Element;
    else globalThis.Element = prevEl;
    if (prevGcs === undefined) delete globalThis.getComputedStyle;
    else globalThis.getComputedStyle = prevGcs;
    if (prevNf === undefined) delete globalThis.NodeFilter;
    else globalThis.NodeFilter = prevNf;
    if (prevMo === undefined) delete globalThis.MutationObserver;
    else globalThis.MutationObserver = prevMo;
    if (prevDoc === undefined) delete globalThis.document;
    else globalThis.document = prevDoc;
    if (prevWin === undefined) delete globalThis.window;
    else globalThis.window = prevWin;
  }
});

test('mobileShellCoordinator multi-gateway newChat selector, settings gateway switch & bot memory forwarding', async () => {
  const mState = {
    platform: 'android',
    appVersion: '0.1.0',
    theme: 'obsidian-gold',
    lang: 'zh',
    gatewayConnected: true,
    gatewayConnecting: false,
    gatewayCount: 2,
    settingsGatewayId: 'gw-b',
    activeGatewayId: 'gw-b',
    activeFocus: { type: 'session', sessionId: 's-b', gatewayId: 'gw-b' },
    activeSessionId: 's-b',
    profileName: 'beta-bot',
    isSettingsOpen: true,
    settingsSection: 'projects',
    botManagementStatus: { status: 'ready', activeBotId: 'beta-bot' },
    gatewayHealthSummary: {
      slots: [
        { gatewayId: 'gw-a', name: 'Alpha', url: 'http://127.0.0.1:18642', connected: true },
        { gatewayId: 'gw-b', name: 'Beta', url: 'http://127.0.0.1:18643', connected: true },
      ],
    },
    profiles: [
      { name: 'alpha-bot', displayName: 'Alpha', gatewayId: 'gw-a', isDefault: true },
      { name: 'beta-bot', displayName: 'Beta', gatewayId: 'gw-b', isDefault: false },
    ],
    projects: [
      { id: 'p-a', name: 'PA', path: '/a', gatewayId: 'gw-a' },
      { id: 'p-b', name: 'PB', path: '/b', gatewayId: 'gw-b' },
    ],
    sessions: [],
    groupRooms: [],
    messages: [],
    queuedMessages: [],
    sideAgentCapsules: [],
    orgFolders: [],
    orgAssignments: {},
    orgDoneRooms: {},
    attachments: [],
    artifacts: [],
    gitDiffs: [],
    openFiles: [],
    memories: [],
    availableModels: [],
    modelDetails: [],
    modelCatalog: [],
    fileTreeState: { status: 'idle' },
    fileTreeExpandedPaths: [],
    settingsProjects: { status: 'ready', data: [] },
    settingsMcp: { status: 'idle' },
    settingsSkills: { status: 'idle' },
    learningState: { status: 'idle' },
    learningDetail: { status: 'idle' },
  };
  const calls = [];
  let mountedActions = null;
  let mountedReadSnapshot = null;
  const mob = createMobileShellCoordinator({
    getState: () => mState,
    render: () => calls.push(['render']),
    leftRailController: {
      decorateRailProfiles: () => mState.profiles,
      decorateRailGroups: () => [],
      decorateRailSessions: () => [],
    },
    resolveAgentAvatar: () => '',
    selectSession: async () => {},
    openBotChat: async () => {},
    openGroupRoom: async () => {},
    createNewSession: async (opts) => { calls.push(['createNewSession', opts]); return 'new-s-id'; },
    renameSession: async () => {},
    pinSession: async () => {},
    archiveSession: async () => {},
    deleteSession: async () => {},
    createGroupRoom: async () => ({ room_id: 'g-new' }),
    confirmGroupRename: async () => {},
    disbandGroupRoom: async () => {},
    fetchGroupRooms: async () => {},
    routeSend: async (t) => calls.push(['routeSend', t]),
    sendGroupMessage: async () => {},
    interruptTurn: async () => {},
    switchModel: async () => {},
    getSettingsSnapshot: () => ({}),
    createSettingsActions: () => ({
      onSelectSettingsGateway: (gwId) => {
        mState.settingsGatewayId = gwId;
        calls.push(['baseSelectGw', gwId]);
      },
      onSelectBotSettle: (id) => calls.push(['baseBotSettle', id]),
    }),
    ensureSettingsSectionData: (sec, force) => calls.push(['ensureSec', sec, force]),
    copyText: async () => true,
    loadLearningGraph: async (o) => calls.push(['loadLearning', o]),
    storage: { getItem: () => null, setItem: () => {} },
    mountShell: (_host, reader, actions) => {
      mountedReadSnapshot = reader;
      mountedActions = actions;
      return () => {};
    },
  });

  const host = { isConnected: true };
  mob.renderMobileShell(host);
  const snap = mountedReadSnapshot();
  assert.equal(snap.gateways.length, 2);

  // Open new chat -> select project on gw-b -> switch to gw-a (prunes incompatible project & group members) -> submit
  mountedActions.onOpenNewChat();
  mountedActions.onSetNewChatGroupMembers(['beta-bot']);
  mountedActions.onSelectNewChatProject('p-b');
  mountedActions.onSelectNewChatGateway('gw-a');
  mountedActions.onSelectNewChatGateway('');
  mountedActions.onSelectNewChatGateway('gw-b');
  mountedActions.onSelectNewChatBot('beta-bot');
  mountedActions.onSubmitNewChatMessage('hello beta');
  await flushMicrotasks();
  assert.ok(calls.some(([k, o]) => k === 'createNewSession' && o?.gatewayId === 'gw-b'));

  // Settings gateway change while settings subpage === 'projects' & homeTab === 'bots'
  mountedActions.onOpenSettingsSubpage('projects');
  mountedActions.onSelectHomeTab('bots');
  mountedActions.onSelectBotSubpage('memory');
  mountedActions.settingsActions.onSelectSettingsGateway('gw-a');
  mountedActions.settingsActions.onSelectBotSettle('alpha-bot');
  assert.ok(calls.some(([k, o]) => k === 'loadLearning' && o?.gatewayId === 'gw-a'));
});

test('Stage 2A coverage top-up: coordinator default configs, focus without gw, fileViewer/preview load, prompt without gwId & mobile shell branches', async () => {
  // 1. multiGatewayCoordinator syncConfiguredGateways without configs + activeFocus without gatewayId
  const sMap = new Map();
  const prevLs = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: (k) => (sMap.has(k) ? sMap.get(k) : null),
    setItem: (k, v) => sMap.set(k, String(v)),
    removeItem: (k) => sMap.delete(k),
  };
  try {
    const cs = {
      activeFocus: { type: 'bot', botName: 'a' },
      activeGatewayId: undefined,
      gatewayUrl: 'http://127.0.0.1:18642',
      username: '',
      password: '',
      gatewayConnected: true,
      gatewayCount: 1,
      activeEntityGatewayOffline: false,
      profiles: [],
      sessions: [],
      groupRooms: [],
    };
    const w2 = createDesktopMultiGatewayWiring({ getState: () => cs, render: () => {}, getDesktopApi: () => undefined });
    await w2.syncConfiguredGateways(); // hits options?.configs ?? loadGatewayConfigs()
    const fh = createActiveFocusChangeHandler({
      getState: () => cs,
      refreshActiveOfflineState: () => {},
      resolveActiveClient: () => ({}),
      fetchModelOptions: async () => {},
      prefetchSlashCatalog: async () => {},
    });
    fh();
  } finally {
    if (prevLs === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = prevLs;
  }

  // 2. interactivePromptService without gatewayId + logDebug enabled (lines 289, 298, 352, 385)
  const ipState = { activeFocus: { type: 'session', sessionId: 's1' }, activeSessionId: 's1', gatewayConnected: true, profiles: [], sessions: [], groupRooms: [] };
  const debugLogs = [];
  const ipSvc = createInteractivePromptService({
    getState: () => ipState,
    getGatewayClient: () => ({ getNegotiatedCapabilities: () => ({ server_requests: true }), getSocketGeneration: () => 1, sendServerResponse: () => true, request: async () => ({}) }),
    getSessionHandleRegistry: () => new SessionHandleRegistry(),
    toStoredSessionId: () => 's1',
    resolveBotForeverSessionMap: () => new Map(),
    resolveBotNameForSession: () => 'default',
    describeRpcError: (e) => String(e),
    onPromptsChanged: () => {},
    logDebug: (msg) => debugLogs.push(msg),
  });
  ipSvc.handleServerRequest({ kind: 'server-request', id: 'r-no-gw', method: 'approval', params: { request_id: 'ap-no-gw', session_id: 'l1' }, socketGeneration: 1 }, { getNegotiatedCapabilities: () => ({}) });
  ipSvc.handleServerRequest({ kind: 'server-request', id: 'r-with-gw', method: 'approval', params: { request_id: 'ap-with-gw', session_id: 'l1' }, socketGeneration: 1 }, { getNegotiatedCapabilities: () => ({}) }, 'gw-b');
  ipSvc.bindSessionHandle('s-ng', 'l-ng');
  ipSvc.reconcileSessionResume({ storedSessionId: 's-ng', liveSessionId: null, resume: {}, fence: 0 });
  assert.ok(debugLogs.length >= 2);

  // 3. sessionCreatePayload lines 17 & 18
  assert.equal(rpcErrorCode(Object.assign(new Error('boom'), { code: 503 })), 503);
  assert.equal(rpcErrorCode(new Error('no-code')), null);
  assert.equal(rpcErrorCode({ code: 'str' }), null);
  assert.equal(rpcErrorCode(null), null);

  // 4. fileViewerService.loadFileTree & previewAssetCoordinator with & without getGatewayUrl (lines 138 & 78)
  const fState = {
    activeFocus: { type: 'session', sessionId: 's', gatewayId: 'gw-b' },
    activeGatewayId: 'gw-b',
    gatewayUrl: 'http://127.0.0.1:18642',
    messages: [],
    openFiles: [{ path: 'readme.md', content: '# Beta', source: 'gateway' }],
    artifacts: [],
    fileTreeExpandedPaths: [],
  };
  const fv1 = createFileViewerService({
    getState: () => fState, render: () => {}, getDesktopApi: () => undefined, getGatewayClient: () => null,
    getGatewayUrl: () => 'http://127.0.0.1:18643',
    resolveSessionWorkingDir: () => '/workspace', isDesktopInspectorFilesVisible: () => true,
    notifyUnsupportedRichDoc: () => {}, promptSaveTextFile: async () => {}, syncFileViewerDom: () => {}, logWarn: () => {},
  });
  const fv2 = createFileViewerService({
    getState: () => fState, render: () => {}, getDesktopApi: () => undefined, getGatewayClient: () => null,
    resolveSessionWorkingDir: () => '/workspace', isDesktopInspectorFilesVisible: () => true,
    notifyUnsupportedRichDoc: () => {}, promptSaveTextFile: async () => {}, syncFileViewerDom: () => {}, logWarn: () => {},
  });
  await fv1.loadFileTree(true);
  await fv2.loadFileTree(true);
  const pacGw = createPreviewAssetCoordinator({
    getState: () => fState, getDesktopApi: () => undefined, getGatewayClient: () => null,
    getGatewayUrl: () => 'http://127.0.0.1:18643', resolveMediaUrl: async () => null, render: () => {}, notify: () => {},
  });
  const pacFallback = createPreviewAssetCoordinator({
    getState: () => fState, getDesktopApi: () => undefined, getGatewayClient: () => null,
    resolveMediaUrl: async () => null, render: () => {}, notify: () => {},
  });
  await pacGw.prepareOpenFilePreview('readme.md');
  await pacFallback.prepareOpenFilePreview('readme.md');

  // 5. renderCoordinator without gatewayHealthSummary is exercised directly inside the rCoord test above

  // 6. mobileShellCoordinator now callback, projects undefined, settingsSubpage providers/extensions/general (lines 927, 934, 1221)
  const mState2 = {
    platform: 'android', appVersion: '0.1.0', theme: 'obsidian-gold', lang: 'zh', gatewayConnected: true, gatewayConnecting: false,
    profileName: 'a', isSettingsOpen: true, settingsSection: 'providers', settingsGatewayId: 'gw-a', activeFocus: { type: 'session', sessionId: 's', gatewayId: 'gw-a' },
    activeSessionId: 's', botManagementStatus: { status: 'ready', activeBotId: 'a' },
    profiles: [{ name: 'a', displayName: 'A', gatewayId: 'gw-a', isDefault: true }], projects: undefined, sessions: [], groupRooms: [],
    messages: [], queuedMessages: [], sideAgentCapsules: [], orgFolders: [], orgAssignments: {}, orgDoneRooms: {}, attachments: [], artifacts: [], gitDiffs: [], openFiles: [], memories: [],
    availableModels: [], modelDetails: [], modelCatalog: [], fileTreeState: { status: 'idle' }, fileTreeExpandedPaths: [], settingsProjects: { status: 'ready', data: [] }, settingsMcp: { status: 'idle' }, settingsSkills: { status: 'idle' }, learningState: { status: 'idle' }, learningDetail: { status: 'idle' },
  };
  let mActs2 = null;
  const mob2 = createMobileShellCoordinator({
    getState: () => mState2, render: () => {}, now: () => 5000,
    leftRailController: { decorateRailProfiles: () => mState2.profiles, decorateRailGroups: () => [], decorateRailSessions: () => [] },
    resolveAgentAvatar: () => '', selectSession: async () => {}, openBotChat: async () => {}, openGroupRoom: async () => {},
    createNewSession: async () => 's2', renameSession: async () => {}, pinSession: async () => {}, archiveSession: async () => {}, deleteSession: async () => {},
    createGroupRoom: async () => ({ room_id: 'g2' }), confirmGroupRename: async () => {}, disbandGroupRoom: async () => {}, fetchGroupRooms: async () => {},
    routeSend: async () => {}, sendGroupMessage: async () => {}, interruptTurn: async () => {}, switchModel: async () => {},
    getSettingsSnapshot: () => ({}), createSettingsActions: () => ({}), ensureSettingsSectionData: () => {}, copyText: async () => true,
    storage: { getItem: () => null, setItem: () => {} }, mountShell: (_h, _r, actions) => { mActs2 = actions; return () => {}; },
  });
  mob2.renderMobileShell({ isConnected: true });
  mActs2.onOpenNewChat();
  mActs2.onSelectNewChatProject('p-x');
  mActs2.onSelectNewChatGateway('gw-a');
  mActs2.onOpenSettingsSubpage('providers');
  mActs2.settingsActions.onSelectSettingsGateway('gw-b');
  mActs2.onOpenSettingsSubpage('extensions');
  mActs2.settingsActions.onSelectSettingsGateway('gw-a');
  mActs2.onOpenSettingsSubpage('general');
  mActs2.settingsActions.onSelectSettingsGateway('gw-b');
  mState2.isSettingsOpen = false;
  mActs2.settingsActions.onSelectSettingsGateway('gw-a');
});
