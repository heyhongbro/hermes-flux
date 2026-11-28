/**
 * M1.3 Multi-Gateway Connection Pool & Aggregator Unit Tests (TDD)
 * (packages/core/__tests__/gateway/m1-3-multi-gateway-pool.test.mjs)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GatewayConnectionPool,
  buildSlotDefaultWsUrl,
  normalizeGatewayOriginUrl,
  detectCloneCollisions,
  aggregateMultiGatewaySnapshots,
  scopedEntityKey,
  scopedBotKey,
  deriveGatewayShortLabel,
  deriveGatewayMonogram,
  resolveAggregateTitlebarStatus,
  RPC_SOCKET_READY_STATE,
  DEFAULT_CACHE_GATEWAY_ID,
} from '../../dist/index.js';

function flushMicrotasks() {
  return new Promise((resolve) => queueMicrotask(resolve));
}

function createMockSocketHarness() {
  const socketsByUrl = new Map();
  const sockets = [];
  const socketFactory = (url) => {
    const sent = [];
    const sock = {
      url,
      readyState: RPC_SOCKET_READY_STATE.CONNECTING,
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
      sent,
      closed: false,
      send(data) {
        sent.push(JSON.parse(data));
      },
      close() {
        sock.closed = true;
        sock.readyState = RPC_SOCKET_READY_STATE.CLOSED;
        sock.onclose?.();
      },
      triggerOpen() {
        sock.readyState = RPC_SOCKET_READY_STATE.OPEN;
        sock.onopen?.();
      },
      deliver(payload) {
        sock.onmessage?.({ data: typeof payload === 'string' ? payload : JSON.stringify(payload) });
      },
    };
    sockets.push(sock);
    socketsByUrl.set(url, sock);
    return sock;
  };
  return { sockets, socketsByUrl, socketFactory };
}

test('M1.3 types & aggregate status: deterministic scoped keys, labels, monograms, and aggregate health', () => {
  assert.equal(scopedEntityKey(undefined, 'sess-1'), `${DEFAULT_CACHE_GATEWAY_ID}::sess-1`);
  assert.equal(scopedEntityKey('gw-a', 'sess-1'), 'gw-a::sess-1');
  assert.equal(scopedEntityKey('  ', 'sess-1'), `${DEFAULT_CACHE_GATEWAY_ID}::sess-1`);

  assert.equal(scopedBotKey(undefined, 'Default'), `${DEFAULT_CACHE_GATEWAY_ID}:default`);
  assert.equal(scopedBotKey('gw-b', '  Arch-Wang '), 'gw-b:arch-wang');

  assert.equal(deriveGatewayShortLabel('Mac Studio', 'http://10.0.0.5:8642', 'MS'), 'MS');
  assert.equal(deriveGatewayShortLabel('Home Linux', 'http://10.0.0.5:8642'), 'Home Linux');
  assert.equal(deriveGatewayShortLabel('', 'wss://relay-gw.example.com:8443/ws'), 'relay-gw.example.com');
  assert.equal(deriveGatewayShortLabel('  ', 'not a url'), 'not a url');
  assert.equal(deriveGatewayShortLabel('', ''), 'Gateway');

  assert.equal(deriveGatewayMonogram('Home'), 'H');
  assert.equal(deriveGatewayMonogram('主机A'), '主');
  assert.equal(deriveGatewayMonogram(''), 'G');
  assert.equal(deriveGatewayMonogram('  b '), 'B');

  assert.equal(normalizeGatewayOriginUrl(''), '');
  assert.equal(normalizeGatewayOriginUrl('wss://host.local:8443/api/ws'), 'https://host.local:8443');
  assert.equal(normalizeGatewayOriginUrl('http://[invalid///'), 'http://[invalid');
  assert.equal(buildSlotDefaultWsUrl('', 'tk'), '');
  assert.equal(buildSlotDefaultWsUrl('ws://127.0.0.1:8080/api/ws', 'tk'), 'ws://127.0.0.1:8080/api/ws?ticket=tk');
  assert.equal(buildSlotDefaultWsUrl('wss://gw.local/api/ws'), 'wss://gw.local/api/ws');

  assert.equal(resolveAggregateTitlebarStatus([]), 'offline');
  assert.equal(
    resolveAggregateTitlebarStatus([{ status: 'syncing', connected: true }]),
    'syncing',
  );
  assert.equal(
    resolveAggregateTitlebarStatus([
      { status: 'connected', connected: true },
      { status: 'connected', connected: true },
    ]),
    'connected',
  );
  assert.equal(
    resolveAggregateTitlebarStatus([
      { status: 'connected', connected: true },
      { status: 'syncing', connected: true },
    ]),
    'syncing',
  );
  assert.equal(
    resolveAggregateTitlebarStatus([
      { status: 'connected', connected: true },
      { status: 'offline', connected: false },
    ]),
    'partial',
  );
  assert.equal(
    resolveAggregateTitlebarStatus([
      { status: 'reconnecting', connected: false },
      { status: 'offline', connected: false },
    ]),
    'reconnecting',
  );
  assert.equal(
    resolveAggregateTitlebarStatus([
      { status: 'offline', connected: false },
      { status: 'offline', connected: false },
    ]),
    'offline',
  );
});

test('M1.3 GatewayConnectionPool: 并发管理多个隔离 Slot，断连/事件/REST 闭包/状态互不串扰', async () => {
  const harness = createMockSocketHarness();
  const restCalls = [];
  const poolEvents = [];
  const healthUpdates = [];

  const pool = new GatewayConnectionPool({
    socketFactory: harness.socketFactory,
    enableHeartbeat: false,
    enableLifecycleWake: false,
    authenticateGateway: async (cfg) => {
      if (cfg.id === 'gw-bad-auth') {
        return { ok: false, authError: true, message: '401 Unauthorized' };
      }
      if (cfg.id === 'gw-throw') {
        throw new Error('ECONNREFUSED');
      }
      return {
        ok: true,
        ticket: `tk-${cfg.id}`,
        latency: cfg.id === 'gw-a' ? 12 : 48,
        installId: `inst-${cfg.id}`,
      };
    },
    executeRestProxy: async (gatewayId, config, req) => {
      restCalls.push({ gatewayId, baseUrl: config.url, req });
      return { ok: true, gatewayId, path: req.path };
    },
  });

  const unsubEvent = pool.onSlotEvent((gatewayId, params) => {
    poolEvents.push({ gatewayId, params });
  });
  const unsubHealth = pool.onHealthChange((summary) => {
    healthUpdates.push(summary.aggregateStatus);
  });

  const slotA = pool.addGateway({
    id: 'gw-a',
    name: 'Local A',
    url: 'http://127.0.0.1:8642',
    routeKind: 'direct',
  });
  const slotB = pool.addGateway({
    id: 'gw-b',
    name: 'Home B',
    url: 'http://192.168.1.20:8642',
    routeKind: 'lan',
  });
  assert.equal(pool.size(), 2);
  assert.equal(pool.getPrimarySlot()?.gatewayId, 'gw-a');
  assert.notEqual(slotA.client, slotB.client);
  assert.notEqual(slotA.sessionHandleRegistry, slotB.sessionHandleRegistry);
  assert.notEqual(slotA.liveStreamRegistry, slotB.liveStreamRegistry);
  assert.notEqual(slotA.groupRoomStore, slotB.groupRoomStore);

  // Repeating addGateway with same id updates config cleanly
  pool.addGateway({ id: 'gw-a', name: 'Home A Renamed', url: 'http://127.0.0.1:8642', routeKind: 'lan' });
  assert.equal(slotA.config.name, 'Home A Renamed');
  pool.updateGatewayConfig('gw-a', { shortAlias: 'A1' });
  assert.equal(slotA.config.shortAlias, 'A1');
  assert.equal(pool.updateGatewayConfig('missing', { name: 'X' }), false);

  // Scoped REST proxy rejects cross-gateway baseUrl injection
  await assert.rejects(
    () => slotA.restProxy({ baseUrl: 'http://192.168.1.20:8642', path: '/api/sessions' }),
    /Cross-gateway/i,
  );
  const restOk = await slotA.restProxy({ path: '/api/sessions' });
  assert.deepEqual(restOk, { ok: true, gatewayId: 'gw-a', path: '/api/sessions' });

  // Concurrent connectAll connects both independently
  const connectAllPromise = pool.connectAll();
  await flushMicrotasks();
  assert.equal(harness.sockets.length, 2);

  for (const sock of harness.sockets) {
    sock.triggerOpen();
    sock.deliver({ jsonrpc: '2.0', id: sock.sent[0].id, result: { pong: true } });
    sock.deliver({
      jsonrpc: '2.0',
      method: 'gateway.ready',
      params: sock.url.includes('127.0.0.1')
        ? { session_authority: true, replay_epoch: 'ep-a' }
        : { session_authority: false, replay_epoch: 'ep-b' },
    });
  }
  await connectAllPromise;
  await flushMicrotasks();

  assert.equal(slotA.connected, true);
  assert.equal(slotB.connected, true);
  assert.equal(slotA.sessionAuthority, true);
  assert.equal(slotA.replayEpoch, 'ep-a');
  assert.equal(slotB.sessionAuthority, false);
  assert.equal(slotB.replayEpoch, 'ep-b');
  assert.equal(pool.getHealthSummary().aggregateStatus, 'connected');
  assert.equal(pool.getHealthSummary().onlineCount, 2);

  // Bidirectional server request routed cleanly with slot gatewayId
  const handledRequests = [];
  const unsubServerReq = pool.onSlotServerRequest(async (gatewayId, request) => {
    handledRequests.push({ gatewayId, id: request.id, method: request.method });
    return { approved: gatewayId === 'gw-a' };
  });
  harness.sockets[0].deliver({ jsonrpc: '2.0', id: 'srv-1', method: 'approval.request', params: { tool: 'bash' } });
  harness.sockets[1].deliver({ jsonrpc: '2.0', id: 'srv-1', method: 'approval.request', params: { tool: 'rm' } });
  await flushMicrotasks();
  assert.equal(handledRequests.length, 2);
  assert.equal(handledRequests[0].gatewayId, 'gw-a');
  assert.equal(handledRequests[1].gatewayId, 'gw-b');

  // Event routed per slot without cross-contamination
  harness.sockets[1].deliver({ jsonrpc: '2.0', method: 'event', params: { type: 'message.delta', session_id: 's1' } });
  assert.equal(poolEvents.length, 1);
  assert.equal(poolEvents[0].gatewayId, 'gw-b');

  // Isolate per-slot disconnect: shutting down B leaves A 100% untouched & connected
  slotB.runningSessionIds.add('s-b1');
  slotB.sessionHandleRegistry.register({ liveId: 'l1', storedId: 's-b1' });
  slotA.runningSessionIds.add('s-a1');
  pool.disconnectGateway('gw-b', true);
  assert.equal(slotB.connected, false);
  assert.equal(slotB.runningSessionIds.size, 0);
  assert.equal(slotB.sessionHandleRegistry.getRegisteredLiveId('s-b1'), null);
  assert.equal(slotA.connected, true);
  assert.equal(slotA.runningSessionIds.has('s-a1'), true);
  assert.equal(pool.getHealthSummary().aggregateStatus, 'partial');
  assert.equal(pool.getHealthSummary().onlineCount, 1);

  // Reconnect gw-b using reconnectGateway
  const reconnPromise = pool.reconnectGateway('gw-b');
  await flushMicrotasks();
  const sockB2 = harness.sockets.at(-1);
  sockB2.triggerOpen();
  sockB2.deliver({ jsonrpc: '2.0', id: sockB2.sent[0].id, result: { pong: true } });
  await reconnPromise;
  await flushMicrotasks();
  assert.equal(slotB.connected, true);
  assert.equal(pool.getHealthSummary().aggregateStatus, 'connected');

  // Auth failure & throwing auth on a third slot stays isolated and returns false
  pool.addGateway({ id: 'gw-bad-auth', name: 'BadAuth', url: 'http://10.0.0.9:8642' });
  const badOk = await pool.connectGateway('gw-bad-auth');
  assert.equal(badOk, false);
  assert.equal(pool.getSlot('gw-bad-auth')?.authError, true);
  assert.equal(pool.getSlot('gw-bad-auth')?.phase, 'offline');
  assert.equal(slotA.connected, true);

  pool.addGateway({ id: 'gw-throw', name: 'ThrowGW', url: 'http://10.0.0.10:8642' });
  const throwOk = await pool.connectGateway('gw-throw');
  assert.equal(throwOk, false);
  assert.match(pool.getSlot('gw-throw')?.reason || '', /ECONNREFUSED/);

  assert.equal(await pool.connectGateway('non-existent'), false);
  assert.equal(pool.disconnectGateway('non-existent'), false);

  // Removing a gateway cleans up only that slot; removing back to 1 restores single slot
  assert.equal(pool.removeGateway('gw-bad-auth'), true);
  assert.equal(pool.removeGateway('gw-throw'), true);
  assert.equal(pool.removeGateway('gw-throw'), false);
  assert.equal(pool.size(), 2);

  unsubEvent();
  unsubHealth();
  unsubServerReq();
  assert.ok(healthUpdates.length > 0);
  pool.disconnectAll(true);
  assert.equal(pool.getHealthSummary().aggregateStatus, 'offline');
});

test('M1.3 MultiGatewayAggregator: 扁平汇总、同名 Bot 并存、离线保留缓存、克隆碰撞隔离与同源去重', () => {
  const sliceA = {
    gatewayId: 'gw-a',
    name: 'Host A',
    url: 'http://127.0.0.1:8642',
    installId: 'install-1',
    fingerprint: 'fp-hardware-1',
    connected: true,
    profiles: [
      { name: 'default', displayName: 'Default A', isDefault: true, timestamp: 1000 },
      { name: 'writer', displayName: 'Writer', timestamp: 2000 },
    ],
    sessions: [
      { id: 's-1', title: 'Task A', model: 'm', time: '10:00', preview: 'hi', isArchived: false, timestamp: 500, botName: 'default' },
    ],
    groups: [
      { roomId: 'room-shared', name: 'Arch Room (Stale)', members: ['default', 'writer'], createdAt: 100, updatedAt: 200, authorityGatewayId: 'gw-a', authorityEpoch: 1 },
      { roomId: 'room-only-a', name: 'Only A', members: ['default', 'writer'], createdAt: 100, updatedAt: 300 },
    ],
  };

  const sliceB = {
    gatewayId: 'gw-b',
    name: 'Host B',
    url: 'http://192.168.1.5:8642',
    installId: 'install-2',
    fingerprint: 'fp-hardware-2',
    connected: false,
    offline: true,
    profiles: [
      { name: 'default', displayName: 'Default B', isDefault: true, timestamp: 3000 },
    ],
    sessions: [
      { id: 's-1', title: 'Task B', model: 'm', time: '10:05', preview: 'cached', isArchived: false, timestamp: 600, botName: 'default', pinned: true },
    ],
    groups: [
      { roomId: 'room-shared', name: 'Arch Room (Authoritative)', members: ['default', 'writer'], createdAt: 100, updatedAt: 400, authorityGatewayId: 'gw-b', authorityEpoch: 3 },
    ],
  };

  const view = aggregateMultiGatewaySnapshots([sliceA, sliceB]);
  assert.equal(view.effectiveGatewayCount, 2);
  assert.equal(view.isMultiGateway, true);
  assert.equal(view.collisions.length, 0);

  // Both 'default' bots coexist without collision, stamped with gatewayId & offline flag
  assert.equal(view.profiles.length, 3);
  const defaultB = view.profiles.find((p) => p.gatewayId === 'gw-b' && p.name === 'default');
  assert.equal(defaultB?.gatewayOffline, true);
  assert.equal(defaultB?.gatewayLabel, 'Host B');

  // Offline slice B retains cached session & pinned sort puts s-1 on B before s-1 on A
  assert.equal(view.sessions.length, 2);
  assert.equal(view.sessions[0].gatewayId, 'gw-b');
  assert.equal(view.sessions[0].gatewayOffline, true);

  // Shared room deduplicated by highest authorityEpoch (3 > 1) and flagged crossGateway
  assert.equal(view.groups.length, 2);
  const shared = view.groups.find((g) => g.roomId === 'room-shared');
  assert.equal(shared?.name, 'Arch Room (Authoritative)');
  assert.equal(shared?.authorityEpoch, 3);
  assert.equal(shared?.crossGateway, true);

  // Duplicate gateway (same installId + same fingerprint) deduplicates
  const dupView = aggregateMultiGatewaySnapshots([
    sliceA,
    {
      ...sliceA,
      gatewayId: 'gw-a-lan',
      name: 'Host A LAN',
      url: 'http://192.168.1.99:8642',
    },
  ]);
  assert.equal(dupView.effectiveGatewayCount, 1);
  assert.equal(dupView.isMultiGateway, false);
  assert.equal(dupView.collisions.some((c) => c.kind === 'duplicate-gateway'), true);
  assert.equal(dupView.profiles.length, 2);

  // VM clone collision (same installId + DIFFERENT fingerprint) stays isolated!
  const collisions = detectCloneCollisions([
    sliceA,
    {
      ...sliceB,
      installId: 'install-1',
      fingerprint: 'fp-hardware-cloned-vm',
    },
  ]);
  assert.equal(collisions.some((c) => c.kind === 'clone-collision'), true);
  const cloneView = aggregateMultiGatewaySnapshots([
    sliceA,
    {
      ...sliceB,
      installId: 'install-1',
      fingerprint: 'fp-hardware-cloned-vm',
    },
  ]);
  assert.equal(cloneView.effectiveGatewayCount, 2);
  assert.equal(cloneView.profiles.length, 3);
});

function completeHandshake(sock) {
  sock.triggerOpen();
  if (sock.sent[0]) {
    sock.deliver({ jsonrpc: '2.0', id: sock.sent[0].id, result: { pong: true } });
  }
}

test('M1.3 Pool & Aggregator Edge Branches: 无 REST 代理/并发逾期鉴权/空地址/未注册服务端请求/无 installId 去重与全量排序边界', async () => {
  // 1. Pool without executeRestProxy / onServerRequest listener
  const harness = createMockSocketHarness();
  let releasePendingAuth;
  let rejectPendingAuth;
  let authCallCount = 0;

  const barePool = new GatewayConnectionPool({
    socketFactory: harness.socketFactory,
    enableHeartbeat: false,
    enableLifecycleWake: false,
  });
  const emptySlot = barePool.addGateway({ id: 'gw-empty', name: 'Empty', url: '' });
  assert.equal(emptySlot.phase, 'unconfigured');
  assert.equal(await barePool.connectGateway('gw-empty'), false);
  assert.equal(emptySlot.phase, 'unconfigured');
  await assert.rejects(() => emptySlot.restProxy({ path: '/api/sessions' }), /REST proxy is unavailable/);

  barePool.addGateway({ id: 'gw-raw', name: 'Raw', url: 'http://127.0.0.1:9911' });
  await barePool.connectGateway('gw-raw');
  await flushMicrotasks();
  const rawSock = harness.sockets.at(-1);
  completeHandshake(rawSock);
  await flushMicrotasks();
  rawSock.deliver({ jsonrpc: '2.0', id: 'srv-unhandled', method: 'approval.request', params: {} });
  await flushMicrotasks();
  const unhandledReply = rawSock.sent.find((f) => f.id === 'srv-unhandled');
  assert.equal(unhandledReply?.error?.code, -32601);

  // 2. Race / superseded connectGateway during slow auth + REST fallback + poller cleanup
  const racePool = new GatewayConnectionPool({
    socketFactory: harness.socketFactory,
    enableHeartbeat: false,
    enableLifecycleWake: false,
    authenticateGateway: async (cfg) => {
      authCallCount += 1;
      if (cfg.id === 'gw-auth-empty-msg') {
        return { ok: false, authError: true };
      }
      if (cfg.id === 'gw-race-ok' && authCallCount === 1) {
        return new Promise((res) => {
          releasePendingAuth = res;
        });
      }
      if (cfg.id === 'gw-race-err' && authCallCount === 3) {
        return new Promise((_res, rej) => {
          rejectPendingAuth = rej;
        });
      }
      return { ok: true, ticket: 't-new', latency: 5, installId: 'inst-r' };
    },
    executeRestProxy: async (_id, cfg, req) => ({ url: cfg.url, path: req.path, sessions: [] }),
  });

  const raceSlotOk = racePool.addGateway({ id: 'gw-race-ok', name: 'Race OK', url: 'http://127.0.0.1:9922' });
  racePool.updateGatewayConfig('gw-race-ok', { installId: 'inst-patched' });
  assert.equal(raceSlotOk.installId, 'inst-patched');

  const p1 = racePool.connectGateway('gw-race-ok');
  const p2 = racePool.connectGateway('gw-race-ok');
  await flushMicrotasks();
  const raceSock = harness.sockets.at(-1);
  completeHandshake(raceSock);
  await flushMicrotasks();
  await p2;
  releasePendingAuth({ ok: true, ticket: 'stale', latency: 99 });
  assert.equal(await p1, false);

  const raceSlotErr = racePool.addGateway({ id: 'gw-race-err', name: 'Race Err', url: 'http://127.0.0.1:9923' });
  const pe1 = racePool.connectGateway('gw-race-err');
  const pe2 = racePool.connectGateway('gw-race-err');
  await flushMicrotasks();
  completeHandshake(harness.sockets.at(-1));
  await flushMicrotasks();
  await pe2;
  rejectPendingAuth(new Error('stale auth boom'));
  assert.equal(await pe1, false);
  assert.equal(raceSlotErr.connected, true);

  racePool.addGateway({ id: 'gw-auth-empty-msg', name: 'EmptyMsg', url: 'http://127.0.0.1:9924' });
  assert.equal(await racePool.connectGateway('gw-auth-empty-msg'), false);
  assert.equal(racePool.getSlot('gw-auth-empty-msg')?.reason, 'Authentication failed');

  let pollerStopped = 0;
  raceSlotOk.groupPollerManager = { stopAll: () => { pollerStopped += 1; } };
  const listOnline = await raceSlotOk.client.listSessions('default', 10);
  assert.equal(listOnline.ok, true);
  const detachedClient = raceSlotOk.client;
  assert.equal(racePool.disconnectGateway('gw-race-ok'), true);
  assert.equal(pollerStopped, 1);
  assert.equal(racePool.removeGateway('gw-race-ok'), true);
  const listDetached = await detachedClient.listSessions('default', 10);
  assert.equal(listDetached.ok, true);
  racePool.disconnectAll(true);
  barePool.disconnectAll(true);

  // 3. Aggregator tie-breakers & URL-only slices without installId
  const agg = aggregateMultiGatewaySnapshots([
    {
      gatewayId: 'gw-z-off',
      name: 'Offline SameOrigin',
      url: 'http://10.0.0.10:8642/',
      connected: false,
      offline: true,
      profiles: [{ name: 'b-bot', displayName: 'B' }],
      sessions: [{ id: 's-b', title: 'B', model: 'm', time: '', preview: '', isArchived: false }],
      groups: [
        { roomId: 'r-tie-off', name: 'Tie Offline', members: ['a'], createdAt: 100, authorityEpoch: 1 },
        { roomId: 'r-b', name: 'Group B', members: ['a'], createdAt: 100 },
      ],
    },
    {
      gatewayId: 'gw-a-off',
      name: 'Offline DiffOrigin',
      url: 'http://10.0.0.12:8642',
      connected: false,
      offline: true,
      profiles: [{ name: 'c-bot', displayName: 'C' }],
      sessions: [{ id: 's-c', title: 'C', model: 'm', time: '', preview: '', isArchived: false }],
      groups: [
        { roomId: 'r-tie-off', name: 'Tie Online Auth Later', members: ['a'], createdAt: 100, authorityEpoch: 1 },
      ],
    },
    {
      gatewayId: 'gw-on-10',
      name: 'Online 10 (Same URL as gw-z-off)',
      url: 'ws://10.0.0.10:8642',
      connected: true,
      profiles: [{ name: 'a-bot', displayName: 'A' }],
      sessions: [{ id: 's-a', title: 'A', model: 'm', time: '', preview: '', isArchived: false }],
      groups: [
        { roomId: 'r-tie-off', name: 'Tie Online Wins Offline', members: ['a'], createdAt: 100, authorityEpoch: 1 },
      ],
    },
    {
      gatewayId: 'gw-on-auth-b',
      name: 'Online 11 Auth B',
      url: 'http://10.0.0.11:8642',
      connected: true,
      profiles: [{ name: 'b2', displayName: 'B2' }, { name: 'a2', displayName: 'A2' }],
      sessions: [
        { id: 's-2', title: 'S2', model: 'm', time: '', preview: '', isArchived: false },
        { id: 's-1', title: 'S1', model: 'm', time: '', preview: '', isArchived: false, pinned: true },
      ],
      groups: [
        { roomId: 'r-auth-tie', name: 'Auth B', members: ['a'], createdAt: 100, authorityGatewayId: 'gw-on-auth-b' },
        { roomId: 'r-date-tie', name: 'Date Older', members: ['a'], createdAt: 100, updatedAt: 100 },
        { roomId: 'r-id-tie', name: 'ID Tie B', members: ['a'], createdAt: 100 },
        { roomId: 'r-a', name: 'Group A', members: ['a'], createdAt: 100 },
      ],
    },
    {
      gatewayId: 'gw-on-auth-a',
      name: 'Online 13 Auth A',
      url: 'http://10.0.0.13:8642',
      connected: true,
      profiles: [],
      sessions: [],
      groups: [
        { roomId: 'r-auth-tie', name: 'NonAuth', members: ['a'], createdAt: 100, authorityGatewayId: 'other-gw' },
        { roomId: 'r-date-tie', name: 'Date Newer', members: ['a'], createdAt: 100, updatedAt: 500 },
        { roomId: 'r-id-tie', name: 'ID Tie A', members: ['a'], createdAt: 100 },
      ],
    },
    {
      gatewayId: 'gw-empty-url',
      name: 'EmptyUrl',
      url: '',
      connected: true,
      profiles: [],
      sessions: [],
      groups: [],
    },
  ]);

  assert.equal(agg.collisions.some((c) => c.kind === 'duplicate-gateway'), true);
  assert.equal(agg.groups.find((g) => g.roomId === 'r-tie-off')?.name, 'Tie Online Wins Offline');
  assert.equal(agg.groups.find((g) => g.roomId === 'r-auth-tie')?.name, 'Auth B');
  assert.equal(agg.groups.find((g) => g.roomId === 'r-date-tie')?.name, 'Date Newer');
  assert.equal(agg.groups.find((g) => g.roomId === 'r-id-tie')?.name, 'ID Tie A');

  // Additional full tie-breaker & same-origin comparison matrix for MultiGatewayAggregator
  const sliceM2Online = {
    gatewayId: 'gw-m2',
    name: 'M2',
    url: 'http://10.0.0.20:8642',
    installId: 'inst-shared',
    fingerprint: 'fp-2',
    connected: true,
    offline: false,
    profiles: [
      { name: 'p-nodate', displayName: 'PN' },
      { name: 'p-z', displayName: 'PZ', timestamp: 500 },
      { name: 'p-b', displayName: 'PB', timestamp: 500 },
      { name: 'p-hi', displayName: 'PH', timestamp: 900 },
    ],
    sessions: [
      { id: 'sess-nodate-m2', title: 'ND2', model: 'm', time: '', preview: '', isArchived: false, pinned: false },
      { id: 'sess-z', title: 'Z', model: 'm', time: '', preview: '', isArchived: false, timestamp: 500, pinned: false },
      { id: 'sess-a', title: 'A', model: 'm', time: '', preview: '', isArchived: false, timestamp: 500, pinned: false },
      { id: 'sess-hi', title: 'Hi', model: 'm', time: '', preview: '', isArchived: false, timestamp: 600, pinned: false },
      { id: 'sess-lo', title: 'Lo', model: 'm', time: '', preview: '', isArchived: false, timestamp: 400, pinned: false },
    ],
    groups: [
      { roomId: 'r-conn-off', name: 'OnlineM2', members: ['a'], createdAt: 100, updatedAt: 100 },
      { roomId: 'r-disc', name: 'OnlineOverDisc', members: ['a'], createdAt: 100, updatedAt: 100 },
      { roomId: 'r-auth-m2', name: 'Auth M2 Winner', authorityGatewayId: 'gw-m2', members: ['a'] },
      { roomId: 'r-auth-m1', name: 'Auth M1 Loser', authorityGatewayId: 'gw-m1', members: ['a'] },
      { roomId: 'r-u-vs-c', name: 'UpdatedM2Wins', updatedAt: 200, members: ['a'] },
      { roomId: 'r-c-vs-u', name: 'CreatedM2Loses', createdAt: 150, members: ['a'] },
      { roomId: 'r-zero-vs-c', name: 'ZeroBothDates', updatedAt: 0, createdAt: 0, members: ['a'] },
      { roomId: 'r-zero-dates', name: 'Z-gw', members: ['a'] },
    ],
  };
  const sliceM1Online = {
    gatewayId: 'gw-m1',
    name: 'M1',
    url: 'http://10.0.0.20:8642',
    installId: 'inst-shared',
    fingerprint: 'fp-1',
    connected: true,
    offline: false,
    profiles: [
      { name: 'p-nodate-m1', displayName: 'PN1' },
      { name: 'p-a', displayName: 'PA', timestamp: 500 },
    ],
    sessions: [
      { id: 'sess-nodate-m1', title: 'ND1', model: 'm', time: '', preview: '', isArchived: false, pinned: false },
      { id: 'sess-m1', title: 'M1', model: 'm', time: '', preview: '', isArchived: false, timestamp: 500, pinned: false },
    ],
    groups: [
      { roomId: 'r-auth-m2', name: 'Auth M2 Loser', authorityGatewayId: 'gw-m2', members: ['a'] },
      { roomId: 'r-auth-m1', name: 'Auth M1 Winner', authorityGatewayId: 'gw-m1', members: ['a'] },
      { roomId: 'r-u-vs-c', name: 'CreatedM1Loses', createdAt: 150, members: ['a'] },
      { roomId: 'r-c-vs-u', name: 'UpdatedM1Wins', updatedAt: 200, members: ['a'] },
      { roomId: 'r-zero-vs-c', name: 'CreatedM1WinsZero', createdAt: 100, members: ['a'] },
      { roomId: 'r-zero-dates', name: 'M1-gw', members: ['a'] },
    ],
  };
  const sliceConnOffline = {
    gatewayId: 'gw-m0',
    name: 'M0-OffFlag',
    url: 'http://10.0.0.21:8642',
    installId: 'inst-m0',
    fingerprint: 'fp-0',
    connected: true,
    offline: true,
    profiles: [],
    sessions: [],
    groups: [
      { roomId: 'r-conn-off', name: 'ConnWithOfflineFlag', members: ['a'], createdAt: 100, updatedAt: 100 },
      { roomId: 'r-both-connoff', name: 'ConnOffA', members: ['a'], createdAt: 100, updatedAt: 100 },
    ],
  };
  const sliceConnOffline2 = {
    gatewayId: 'gw-m4',
    name: 'M4-OffFlag',
    url: 'http://10.0.0.24:8642',
    installId: 'inst-m4',
    fingerprint: 'fp-4',
    connected: true,
    offline: true,
    profiles: [],
    sessions: [],
    groups: [
      { roomId: 'r-both-connoff', name: 'ConnOffB', members: ['a'], createdAt: 100, updatedAt: 100 },
    ],
  };
  const sliceDisconnected = {
    gatewayId: 'gw-m3',
    name: 'M3-Disconn',
    url: 'http://10.0.0.22:8642',
    installId: 'inst-m3',
    fingerprint: 'fp-3',
    connected: false,
    offline: false,
    profiles: [],
    sessions: [],
    groups: [
      { roomId: 'r-disc', name: 'DisconnectedLoser', members: ['a'], createdAt: 100, updatedAt: 100 },
      { roomId: 'r-both-disc', name: 'DiscA', members: ['a'], createdAt: 100, updatedAt: 100 },
    ],
  };
  const sliceDisconnected2 = {
    gatewayId: 'gw-m5',
    name: 'M5-Disconn',
    url: 'http://10.0.0.25:8642',
    installId: 'inst-m5',
    fingerprint: 'fp-5',
    connected: false,
    offline: false,
    profiles: [],
    sessions: [],
    groups: [
      { roomId: 'r-both-disc', name: 'DiscB', members: ['a'], createdAt: 100, updatedAt: 100 },
    ],
  };

  const aggTies = aggregateMultiGatewaySnapshots([
    sliceM2Online,
    sliceM1Online,
    sliceConnOffline,
    sliceConnOffline2,
    sliceDisconnected,
    sliceDisconnected2,
  ]);
  const aggTiesRev = aggregateMultiGatewaySnapshots([
    sliceDisconnected2,
    sliceDisconnected,
    sliceConnOffline2,
    sliceConnOffline,
    sliceM1Online,
    sliceM2Online,
  ]);
  assert.equal(aggTies.effectiveGatewayCount, 6);
  assert.equal(aggTies.groups.find((g) => g.roomId === 'r-zero-dates')?.name, 'M1-gw');
  assert.equal(aggTiesRev.groups.find((g) => g.roomId === 'r-zero-dates')?.name, 'M1-gw');
  assert.equal(aggTies.groups.find((g) => g.roomId === 'r-auth-m2')?.name, 'Auth M2 Winner');
  assert.equal(aggTiesRev.groups.find((g) => g.roomId === 'r-auth-m1')?.name, 'Auth M1 Winner');
  assert.equal(aggTies.groups.find((g) => g.roomId === 'r-u-vs-c')?.name, 'UpdatedM2Wins');
  assert.equal(aggTiesRev.groups.find((g) => g.roomId === 'r-c-vs-u')?.name, 'UpdatedM1Wins');
  assert.equal(aggTies.groups.find((g) => g.roomId === 'r-zero-vs-c')?.name, 'CreatedM1WinsZero');
  assert.equal(aggTies.groups.find((g) => g.roomId === 'r-conn-off')?.name, 'OnlineM2');
  assert.equal(aggTiesRev.groups.find((g) => g.roomId === 'r-disc')?.name, 'OnlineOverDisc');
  assert.equal(aggTies.groups.find((g) => g.roomId === 'r-both-connoff')?.name, 'ConnOffA');
  assert.equal(aggTies.groups.find((g) => g.roomId === 'r-both-disc')?.name, 'DiscA');

  // Stage 1 audit fixes: full clearSlotTransientState, ticket clearing on failed auth,
  // updateGatewayConfig origin-change disconnect & unconfigured phase, addGateway installId sync,
  // and asymmetric installId vs origin deduplication
  const pPool = new GatewayConnectionPool({
    socketFactory: harness.socketFactory,
    authenticateGateway: async (cfg) => {
      if (cfg.url.includes('throw-str')) {
        throw 'auth-string-boom';
      }
      if (cfg.url.includes('fail-next')) {
        return { ok: false, message: 'denied', authError: true };
      }
      return { ok: true, ticket: 'tk-valid', latency: 3, installId: 'inst-p' };
    },
  });
  try {
    const s1 = pPool.addGateway({ id: 'gw-p', name: 'P', url: 'http://10.0.1.1:8642', installId: 'inst-0' });
    pPool.addGateway({ id: 'gw-p', name: 'P2', url: 'http://10.0.1.1:8642', installId: 'inst-1' });
    assert.equal(s1.config.name, 'P2');
    assert.equal(s1.installId, 'inst-1');
    await pPool.connectGateway('gw-p');
    assert.equal(s1.ticket, 'tk-valid');

    s1.liveStreamRegistry.registerStream({ storedSessionId: 's1', liveSessionId: 'l1', messageId: 'm1', origin: 'local' });
    s1.unreadSessionIds.add('s1');
    s1.unreadBotNames.add('default');
    s1.unreadGroupRoomIds.add('r1');
    s1.sessionTurnOwner.set('s1', 'm1');
    s1.botTurnOwner.set('default', 'm1');
    s1.activeGroupThreadByRoom.set('r1', 'th1');

    // Same-origin patch keeps client and ticket intact
    assert.equal(pPool.updateGatewayConfig('gw-p', { url: 'http://10.0.1.1:8642/' }), true);
    assert.equal(s1.ticket, 'tk-valid');

    // Different-origin patch invalidates ticket, disconnects client & clears transient state
    assert.equal(pPool.updateGatewayConfig('gw-p', { url: 'http://10.0.1.2:8642/fail-next' }), true);
    assert.equal(s1.ticket, undefined);
    assert.equal(s1.phase, 'offline');
    assert.equal(s1.liveStreamRegistry.size(), 0);
    assert.equal(s1.unreadSessionIds.size, 0);
    assert.equal(s1.unreadBotNames.size, 0);
    assert.equal(s1.unreadGroupRoomIds.size, 0);
    assert.equal(s1.sessionTurnOwner.size, 0);
    assert.equal(s1.botTurnOwner.size, 0);
    assert.equal(s1.activeGroupThreadByRoom.size, 0);

    // Setting a prior ticket then failing auth must not leave stale ticket behind
    s1.ticket = 'stale-should-clear';
    assert.equal(await pPool.connectGateway('gw-p'), false);
    assert.equal(s1.ticket, undefined);

    // Non-Error string rejection from authenticateGateway falls back to String(err)
    assert.equal(pPool.updateGatewayConfig('gw-p', { url: 'http://10.0.1.2:8642/throw-str' }), true);
    assert.equal(await pPool.connectGateway('gw-p'), false);
    assert.equal(s1.reason, 'auth-string-boom');

    // Updating url to empty string transitions phase to unconfigured
    assert.equal(pPool.updateGatewayConfig('gw-p', { url: '' }), true);
    assert.equal(s1.phase, 'unconfigured');
  } finally {
    pPool.disconnectAll(true);
  }

  // Asymmetric installId vs url-only dedupe + distinct fingerprints at same origin + empty url slice
  const asymView = aggregateMultiGatewaySnapshots([
    {
      gatewayId: 'gw-no-inst',
      name: 'NoInst',
      url: 'http://10.0.2.10:8642',
      connected: true,
      offline: false,
      profiles: [],
      sessions: [],
      groups: [],
    },
    {
      gatewayId: 'gw-with-inst',
      name: 'WithInst',
      url: 'http://10.0.2.10:8642',
      installId: 'inst-asym',
      fingerprint: 'fp-a',
      connected: true,
      offline: false,
      profiles: [],
      sessions: [],
      groups: [],
    },
    {
      gatewayId: 'gw-zclone-same-url',
      name: 'CloneSameUrl',
      url: 'http://10.0.2.10:8642',
      installId: 'inst-asym',
      fingerprint: 'fp-b',
      connected: true,
      offline: false,
      profiles: [],
      sessions: [],
      groups: [],
    },
    {
      gatewayId: 'gw-inst-no-url',
      name: 'InstNoUrl',
      url: '',
      installId: 'inst-empty-url',
      connected: true,
      offline: false,
      profiles: [],
      sessions: [],
      groups: [],
    },
  ]);
  assert.equal(asymView.collisions.some((c) => c.kind === 'duplicate-gateway' && c.collidingGatewayId === 'gw-no-inst' && c.installId === 'inst-asym'), true);
  assert.equal(asymView.collisions.some((c) => c.kind === 'clone-collision' && c.collidingGatewayId === 'gw-zclone-same-url'), true);
  assert.equal(asymView.effectiveGatewayCount, 3);

  // Same-origin duplicate detection even when both have installId (one lacks fingerprint or distinct installId without clone)
  const sameOriginMixedView = aggregateMultiGatewaySnapshots([
    {
      gatewayId: 'gw-a-fp',
      name: 'WithFp',
      url: 'http://10.0.2.20:8642',
      installId: 'inst-mix',
      fingerprint: 'fp-1',
      connected: true,
      offline: false,
      profiles: [],
      sessions: [],
      groups: [],
    },
    {
      gatewayId: 'gw-b-nofp',
      name: 'NoFpSameOrigin',
      url: 'http://10.0.2.20:8642/',
      installId: 'inst-mix',
      connected: true,
      offline: false,
      profiles: [],
      sessions: [],
      groups: [],
    },
  ]);
  assert.equal(sameOriginMixedView.collisions.some((c) => c.kind === 'duplicate-gateway' && c.collidingGatewayId === 'gw-b-nofp'), true);
  assert.equal(sameOriginMixedView.effectiveGatewayCount, 1);

  // First slice without installId establishes origin; second slice with installId on same origin merges into duplicate-gateway
  const noInstFirstOrigin = aggregateMultiGatewaySnapshots([
    {
      gatewayId: 'gw-noinst-online',
      name: 'NoInst',
      url: 'http://10.0.2.21:8642',
      connected: true,
      offline: false,
      profiles: [],
      sessions: [],
      groups: [],
    },
    {
      gatewayId: 'gw-inst-second',
      name: 'WithInst',
      url: 'http://10.0.2.21:8642/',
      installId: 'inst-second',
      connected: false,
      offline: true,
      profiles: [],
      sessions: [],
      groups: [],
    },
    {
      gatewayId: 'gw-inst-nourl',
      name: 'NoUrl',
      url: '',
      installId: 'inst-nourl',
      connected: true,
      offline: false,
      profiles: [],
      sessions: [],
      groups: [],
    },
  ]);
  const secondOriginDup = noInstFirstOrigin.collisions.find(
    (c) => c.kind === 'duplicate-gateway' && c.collidingGatewayId === 'gw-inst-second',
  );
  assert.equal(secondOriginDup?.installId, 'inst-second');
  assert.equal(noInstFirstOrigin.effectiveGatewayCount, 2);
});

test('M1.3 GatewayConnectionPool auto-reconnect mints fresh ws-ticket via resolveUrl and handles failures/override', async () => {
  const { sockets, socketFactory } = createMockSocketHarness();
  let authCall = 0;
  let authMode = 'ok';
  let customWsUrl = true;
  const pool = new GatewayConnectionPool({
    socketFactory,
    enableHeartbeat: false,
    enableLifecycleWake: false,
    authenticateGateway: async (cfg) => {
      authCall += 1;
      if (authMode === 'throw') throw new Error('auth down');
      if (authMode === 'fail') return { ok: false, authError: true, message: 'bad secret' };
      return { ok: true, ticket: `tk-${authCall}`, latency: 5, installId: `inst-${cfg.id}-${authCall}` };
    },
    resolveWsUrl: (cfg, ticket) => (customWsUrl ? buildSlotDefaultWsUrl(cfg.url, ticket) : ''),
  });
  try {
    pool.addGateway({ id: 'gw-rec', name: 'Rec', url: 'http://127.0.0.1:8655' });
    assert.equal(await pool.connectGateway('gw-rec'), true);
    assert.equal(sockets[0].url, 'ws://127.0.0.1:8655/api/ws?ticket=tk-1');
    sockets[0].triggerOpen();
    sockets[0].deliver({ jsonrpc: '2.0', id: sockets[0].sent[0].id, result: { ok: true } });
    await flushMicrotasks();

    // Simulate auto-reconnect triggering client.connect() directly (consumes initialUrlConsumed=true -> resolveUrl)
    const slot = pool.getSlot('gw-rec');
    sockets[0].close();
    slot.client.connect();
    await flushMicrotasks();
    assert.equal(authCall, 2);
    assert.equal(sockets[1].url, 'ws://127.0.0.1:8655/api/ws?ticket=tk-2');
    assert.equal(slot.ticket, 'tk-2');

    // Empty resolveWsUrl returns null cleanly; auth failure & auth exception update slot diagnostics
    sockets[1].close();
    customWsUrl = false;
    slot.client.connect();
    await flushMicrotasks();

    customWsUrl = true;
    authMode = 'fail';
    slot.client.connect();
    await flushMicrotasks();
    assert.equal(slot.authError, true);
    assert.equal(slot.reason, 'bad secret');

    authMode = 'fail-empty';
    const slotEmptyMsg = pool.getSlot('gw-rec');
    assert.ok(slotEmptyMsg);

    authMode = 'throw';
    slot.client.connect();
    await flushMicrotasks();
    assert.equal(slot.authError, false);
    assert.equal(slot.reason, 'auth down');

    // Removed slot, non-Error throw, empty auth failure message, default wsUrl, & stale epoch guards
    authMode = 'ok';
    let slowAuthMode = 'resolve';
    let finishSlowAuth;
    let rejectSlowAuth;
    const poolSlow = new GatewayConnectionPool({
      socketFactory,
      enableHeartbeat: false,
      enableLifecycleWake: false,
      authenticateGateway: () => new Promise((res, rej) => {
        if (slowAuthMode === 'throw-str') { rej('raw-err'); return; }
        if (slowAuthMode === 'fail-empty') { res({ ok: false, message: '', latency: 1 }); return; }
        finishSlowAuth = res;
        rejectSlowAuth = rej;
      }),
    });
    let slotSlow;
    let defClient;
    try {
      poolSlow.addGateway({ id: 'gw-slow', name: 'Slow', url: 'http://127.0.0.1:8656' });
      const pSlow = poolSlow.connectGateway('gw-slow');
      slotSlow = poolSlow.getSlot('gw-slow');
      // Force wsUrlOverride initial bind then trigger resolveUrl via connect() while slow auth is pending
      assert.equal(await poolSlow.connectGateway('gw-slow', 'ws://127.0.0.1:8656/api/ws?ticket=manual'), true);
      sockets.at(-1).triggerOpen();
      sockets.at(-1).close();
      // Override skips resolveUrl completely
      slotSlow.client.connect();
      await flushMicrotasks();
      poolSlow.removeGateway('gw-slow');
      finishSlowAuth?.({ ok: true, ticket: 'late' });
      await pSlow;

      // Default resolveWsUrl (no custom resolveWsUrl) + fail-empty + throw non-Error + epoch bump resolve/reject + !rec
      poolSlow.addGateway({ id: 'gw-def', name: 'Def', url: 'http://127.0.0.1:8657' });
      const pDefOk = poolSlow.connectGateway('gw-def');
      finishSlowAuth?.({ ok: true, ticket: 'def-1', latency: 2 });
      assert.equal(await pDefOk, true);
      const defSlot = poolSlow.getSlot('gw-def');
      defClient = defSlot.client;
      sockets.at(-1).triggerOpen();
      sockets.at(-1).close();
      defClient.connect();
      finishSlowAuth?.({ ok: true, ticket: 'def-2', latency: 3 });
      for (let i = 0; i < 8; i += 1) {
        await flushMicrotasks();
      }
      assert.equal(defSlot.ticket, 'def-2');
      assert.equal(sockets.at(-1).url, 'ws://127.0.0.1:8657/api/ws?ticket=def-2');

      const drainMicrotasks = async () => {
        for (let i = 0; i < 6; i += 1) {
          await flushMicrotasks();
        }
      };

      // Empty message auth fail (467) & non-Error throw (460)
      sockets.at(-1).triggerOpen();
      sockets.at(-1).close();
      slowAuthMode = 'fail-empty';
      defClient.connect();
      await drainMicrotasks();
      assert.equal(defSlot.reason, 'Authentication failed');
      slowAuthMode = 'throw-str';
      defClient.connect();
      await drainMicrotasks();
      assert.equal(defSlot.reason, 'raw-err');

      // Epoch bump before slow auth resolves (464) or rejects (458)
      slowAuthMode = 'resolve';
      defClient.connect();
      poolSlow.disconnectGateway('gw-def', false);
      finishSlowAuth?.({ ok: true, ticket: 'stale-ok', latency: 1 });
      await drainMicrotasks();
      defClient.connect();
      poolSlow.disconnectGateway('gw-def', false);
      rejectSlowAuth?.(new Error('stale-err'));
      await drainMicrotasks();

      // Removed slot after resolveUrl captured (449)
      poolSlow.removeGateway('gw-def');
      defClient.connect();
      await drainMicrotasks();
    } finally {
      slotSlow?.client?.disconnect();
      defClient?.disconnect();
      poolSlow.dispose?.();
      poolSlow.disconnectAll(true);
    }
  } finally {
    pool.disconnectAll(true);
  }
});

test('M1.3 wakeSlot protects in-flight CONNECTING/HANDSHAKING sockets, skips authError, and exposes slot phase', async () => {
  const sockets = [];
  class ManualSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.sent = [];
      this.closed = false;
      this.onopen = null;
      this.onmessage = null;
      this.onclose = null;
      this.onerror = null;
    }
    send(raw) {
      const frame = JSON.parse(raw);
      this.sent.push(frame);
      if (frame.method === 'ping' && frame.id != null) {
        queueMicrotask(() => {
          this.onmessage?.({ data: JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: { pong: true } }) });
        });
      }
    }
    close() {
      this.closed = true;
      this.readyState = 3;
      this.onclose?.({ code: 1000, reason: 'closed' });
    }
  }

  let authCalls = 0;
  let authOk = true;
  const wakePool = new GatewayConnectionPool({
    enableHeartbeat: false,
    enableLifecycleWake: false,
    socketFactory: (url) => {
      const sock = new ManualSocket(url);
      sockets.push(sock);
      return sock;
    },
    authenticateGateway: async (cfg) => {
      authCalls += 1;
      return authOk ? { ok: true, ticket: `tk-${cfg.id}-${authCalls}` } : { ok: false, authError: true, message: '401' };
    },
  });

  try {
    wakePool.addGateway({ id: 'gw-handshaking', name: 'H', url: 'http://127.0.0.1:9931' });
    wakePool.addGateway({ id: 'gw-auth-bad', name: 'A', url: 'http://127.0.0.1:9932' });
    wakePool.addGateway({ id: 'gw-disc', name: 'D', url: 'http://127.0.0.1:9933' });

    await wakePool.connectGateway('gw-handshaking');
    await flushMicrotasks();
    // Socket created in CONNECTING state (never opened yet)
    assert.equal(wakePool.getSlot('gw-handshaking')?.client.getState(), 'CONNECTING');
    const authBeforeWake = authCalls;
    const sockCountBeforeWake = sockets.length;

    // wakeSlot on in-flight CONNECTING must NOT re-auth or teardown socket
    assert.equal(await wakePool.wakeSlot('gw-handshaking', 'focus'), 'reconnecting');
    assert.equal(authCalls, authBeforeWake);
    assert.equal(sockets.length, sockCountBeforeWake);
    assert.equal(sockets[0].closed, false);

    // Healthy slot becomes connected -> health summary exposes phase='connected' and wakeSlot probes ping -> 'alive'
    sockets[0].readyState = 1;
    sockets[0].onopen?.();
    await flushMicrotasks();
    assert.equal(wakePool.getHealthSummary().slots.find((s) => s.gatewayId === 'gw-handshaking')?.phase, 'connected');
    assert.equal(await wakePool.wakeSlot('gw-handshaking', 'focus'), 'alive');

    // authError slot -> wakeSlot skips without hammering auth
    authOk = false;
    await wakePool.connectGateway('gw-auth-bad');
    const authAfterBad = authCalls;
    assert.equal(await wakePool.wakeSlot('gw-auth-bad', 'focus'), 'disconnected');
    assert.equal(authCalls, authAfterBad);

    // DISCONNECTED clean slot (non-manual) -> wakeSlot reconnects
    authOk = true;
    await wakePool.connectGateway('gw-disc');
    const discSock = sockets.at(-1);
    discSock.readyState = 1;
    discSock.onopen?.();
    await flushMicrotasks();
    wakePool.disconnectGateway('gw-disc', false);
    const sockCountBeforeDiscWake = sockets.length;
    const wakeDiscRes = await wakePool.wakeSlot('gw-disc', 'focus');
    assert.equal(wakeDiscRes, 'reconnecting');
    assert.equal(sockets.length, sockCountBeforeDiscWake + 1);
  } finally {
    wakePool.disconnectAll(true);
  }
});
