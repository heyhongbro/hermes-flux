/**
 * M1.1 Core RPC Socket Abstraction & Bidirectional Protocol Unit Tests
 * (packages/core/__tests__/rpc/m1-1-socket-and-protocol.test.mjs)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HermesGatewayClient,
  ProfileService,
  RPC_SOCKET_READY_STATE,
  DEFAULT_GATEWAY_READY_STATE,
  parseGatewayReadyParams,
  buildServerRequestSuccessFrame,
  buildSessionEventsSinceParams,
  normalizeSessionEventsSinceResult,
  extractInstallId,
  createBrowserRpcSocket,
} from '../../dist/index.js';

function flushMicrotasks() {
  return new Promise((resolve) => queueMicrotask(resolve));
}

function createMockSocketHarness() {
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
    return sock;
  };
  return { sockets, socketFactory };
}

test('M1.1: IRpcSocket 与 socketFactory 抽象支持零全局 WebSocket 完整运行与探活断连', async () => {
  const savedWs = globalThis.WebSocket;
  delete globalThis.WebSocket;
  const harness = createMockSocketHarness();

  try {
    const client = new HermesGatewayClient({
      url: 'ws://mock.gateway.local/api/ws?ticket=t-1',
      socketFactory: harness.socketFactory,
      autoConnect: true,
      enableHeartbeat: false,
      enableLifecycleWake: false,
    });

    assert.equal(harness.sockets.length, 1);
    const sock = harness.sockets[0];
    assert.equal(client.getState(), 'CONNECTING');
    assert.equal(client.getSocket(), sock);

    sock.triggerOpen();
    assert.equal(client.getState(), 'HANDSHAKING');
    assert.equal(sock.sent[0].method, 'ping');

    sock.deliver({ jsonrpc: '2.0', id: sock.sent[0].id, result: { pong: true } });
    await flushMicrotasks();
    assert.equal(client.getState(), 'CONNECTED');

    const probePromise = client.probeOrWake('m1-1-test');
    const pingReq = sock.sent.at(-1);
    assert.equal(pingReq.method, 'ping');
    sock.deliver({ jsonrpc: '2.0', id: pingReq.id, result: { pong: true } });
    assert.equal(await probePromise, 'alive');

    const callPromise = client.call('session.list', { limit: 5 });
    const listReq = sock.sent.at(-1);
    assert.equal(listReq.method, 'session.list');
    sock.deliver({ jsonrpc: '2.0', id: listReq.id, result: { sessions: [{ id: 's1' }] } });
    const listRes = await callPromise;
    assert.deepEqual(listRes, { sessions: [{ id: 's1' }] });

    client.disconnect();
    assert.equal(client.getState(), 'DISCONNECTED');
    assert.equal(sock.closed, true);
  } finally {
    globalThis.WebSocket = savedWs;
  }
});

test('M1.1: createBrowserRpcSocket 在无 WebSocket 时显式报错，存在时包装原生构造函数', () => {
  const savedWs = globalThis.WebSocket;
  try {
    delete globalThis.WebSocket;
    assert.throws(() => createBrowserRpcSocket('ws://127.0.0.1:9119/api/ws'), /unavailable/i);

    const constructed = [];
    globalThis.WebSocket = class FakeWebSocket {
      constructor(u) {
        constructed.push(u);
        this.url = u;
        this.readyState = RPC_SOCKET_READY_STATE.OPEN;
      }
      send() {}
      close() {}
    };
    const wrapped = createBrowserRpcSocket('ws://127.0.0.1:9119/api/ws');
    assert.deepEqual(constructed, ['ws://127.0.0.1:9119/api/ws']);
    assert.equal(wrapped.readyState, RPC_SOCKET_READY_STATE.OPEN);
  } finally {
    globalThis.WebSocket = savedWs;
  }
});

test('M1.1: gateway.ready 首帧解析、session_authority / replay_epoch 状态读取与通知透传', async () => {
  assert.deepEqual(parseGatewayReadyParams(null), DEFAULT_GATEWAY_READY_STATE);
  assert.deepEqual(
    parseGatewayReadyParams({
      replay_epoch: '  ep-9  ',
      session_authority: true,
      heartbeat: false,
      change_events: true,
    }),
    {
      replayEpoch: 'ep-9',
      sessionAuthority: true,
      heartbeat: false,
      changeEvents: true,
    },
  );
  assert.deepEqual(
    parseGatewayReadyParams({
      replay_epoch: '   ',
      session_authority: null,
      heartbeat: null,
      change_events: 1,
    }),
    DEFAULT_GATEWAY_READY_STATE,
  );

  const harness = createMockSocketHarness();
  const client = new HermesGatewayClient({
    url: 'ws://gw-a/api/ws',
    socketFactory: harness.socketFactory,
    autoConnect: true,
    enableHeartbeat: false,
    enableLifecycleWake: false,
  });

  try {
    assert.deepEqual(client.getGatewayReadyState(), DEFAULT_GATEWAY_READY_STATE);
    assert.equal(client.isSessionAuthority(), false);
    assert.equal(client.getReplayEpoch(), null);

    const receivedRaw = [];
    client.onNotification('gateway.ready', (p) => receivedRaw.push(p));

    const sock = harness.sockets[0];
    sock.triggerOpen();
    sock.deliver({
      jsonrpc: '2.0',
      method: 'gateway.ready',
      params: {
        replay_epoch: 'ep-42',
        session_authority: true,
        heartbeat: true,
        change_events: true,
      },
    });
    sock.deliver({ jsonrpc: '2.0', id: sock.sent[0].id, result: { pong: true } });
    await flushMicrotasks();

    assert.deepEqual(client.getGatewayReadyState(), {
      replayEpoch: 'ep-42',
      sessionAuthority: true,
      heartbeat: true,
      changeEvents: true,
    });
    assert.equal(client.isSessionAuthority(), true);
    assert.equal(client.getReplayEpoch(), 'ep-42');
    assert.equal(receivedRaw.length, 1);
    assert.equal(receivedRaw[0].replay_epoch, 'ep-42');
  } finally {
    client.disconnect();
  }
});

test('M1.1: 双向反向请求分支 (id + method) 防 ID 碰撞、支持默认/单播路由、错误码透传与未注册拒绝', async () => {
  const harness = createMockSocketHarness();
  const client = new HermesGatewayClient({
    url: 'ws://gw-b/api/ws',
    socketFactory: harness.socketFactory,
    autoConnect: true,
    enableHeartbeat: false,
    enableLifecycleWake: false,
  });

  try {
    const sock = harness.sockets[0];
    sock.triggerOpen();
    sock.deliver({ jsonrpc: '2.0', id: sock.sent[0].id, result: { pong: true } });
    await flushMicrotasks();

    // 1. 同 id 碰撞防护：客户端外发 call 与服务端反向请求携带完全相同的 id
    const seenApprovals = [];
    const offApproval = client.onServerRequest('approval.request', async (params, req) => {
      seenApprovals.push({ params, req });
      return { choice: 'once' };
    });

    let outboundSettled = false;
    const outboundPromise = client.call('session.list', { limit: 10 }).then((r) => {
      outboundSettled = true;
      return r;
    });
    const outboundReq = sock.sent.at(-1);
    const collidingId = outboundReq.id;

    sock.deliver({
      jsonrpc: '2.0',
      id: collidingId,
      method: 'approval.request',
      params: { command: 'rm -rf /tmp/x' },
    });
    await flushMicrotasks();
    await flushMicrotasks();

    assert.equal(outboundSettled, false, '同 ID 反向请求绝不能误结算客户端在途 call');
    assert.equal(seenApprovals.length, 1);
    assert.deepEqual(seenApprovals[0].params, { command: 'rm -rf /tmp/x' });
    assert.equal(seenApprovals[0].req.id, collidingId);
    assert.deepEqual(sock.sent.at(-1), {
      jsonrpc: '2.0',
      id: collidingId,
      result: { choice: 'once' },
    });

    sock.deliver({ jsonrpc: '2.0', id: collidingId, result: { sessions: [{ id: 'ok' }] } });
    assert.deepEqual(await outboundPromise, { sessions: [{ id: 'ok' }] });

    // 2. 取消专职监听后回退到默认反向处理器
    offApproval();
    const fallbackCalls = [];
    const offDefault = client.setDefaultServerRequestHandler((req) => {
      fallbackCalls.push(req);
      if (req.method === 'throw.coded') {
        const err = new Error('denied by policy');
        err.code = 4100;
        throw err;
      }
      if (req.method === 'throw.plain') {
        throw new Error('plain failure');
      }
      if (req.method === 'throw.string') {
        throw 'string error';
      }
      return { handledBy: 'default', method: req.method };
    });

    sock.deliver({ jsonrpc: '2.0', id: 'srv-1', method: 'clarify.ask', params: { q: 'which?' } });
    await flushMicrotasks();
    assert.equal(fallbackCalls.length, 1);
    assert.deepEqual(sock.sent.at(-1), {
      jsonrpc: '2.0',
      id: 'srv-1',
      result: { handledBy: 'default', method: 'clarify.ask' },
    });

    // 3. 异常转标准 JSON-RPC Error Frame（含自定义错误码、普通 Error 与非 Error 异常）
    sock.deliver({ jsonrpc: '2.0', id: 'srv-2', method: 'throw.coded' });
    await flushMicrotasks();
    assert.deepEqual(sock.sent.at(-1), {
      jsonrpc: '2.0',
      id: 'srv-2',
      error: { code: 4100, message: 'denied by policy' },
    });

    sock.deliver({ jsonrpc: '2.0', id: 'srv-3', method: 'throw.plain' });
    await flushMicrotasks();
    assert.deepEqual(sock.sent.at(-1), {
      jsonrpc: '2.0',
      id: 'srv-3',
      error: { code: -32000, message: 'plain failure' },
    });

    sock.deliver({ jsonrpc: '2.0', id: 'srv-4', method: 'throw.string' });
    await flushMicrotasks();
    assert.deepEqual(sock.sent.at(-1), {
      jsonrpc: '2.0',
      id: 'srv-4',
      error: { code: -32000, message: 'string error' },
    });

    // 4. 清空处理器后返回 -32601 Method not found
    offDefault();
    sock.deliver({ jsonrpc: '2.0', id: 'srv-5', method: 'sudo.prompt', params: {} });
    await flushMicrotasks();
    assert.deepEqual(sock.sent.at(-1).error.code, -32601);
    assert.match(sock.sent.at(-1).error.message, /sudo\.prompt/);
  } finally {
    client.disconnect();
  }
});

test('M1.1: negotiateCapabilities 与 fetchSessionEventsSince (Legacy vs Canonical) 契约验证', async () => {
  assert.deepEqual(
    buildSessionEventsSinceParams({
      sessionId: 's1',
      profile: 'default',
      cursor: 12,
      replayEpoch: 'ep-legacy',
      sessionAuthority: false,
    }),
    {
      session_id: 's1',
      profile: 'default',
      last_seen: 12,
      replay_epoch: 'ep-legacy',
    },
  );
  assert.deepEqual(
    buildSessionEventsSinceParams({
      sessionId: 's1',
      cursor: 20,
      replayEpoch: 'ep-canon',
      sessionAuthority: true,
    }),
    {
      session_id: 's1',
      last_sequence: 20,
      replay_epoch: 'ep-canon',
    },
  );
    assert.deepEqual(
      buildSessionEventsSinceParams({
        sessionId: 's-min',
        sessionAuthority: false,
      }),
      {
        session_id: 's-min',
        last_seen: 0,
      },
    );
    assert.deepEqual(JSON.parse(buildServerRequestSuccessFrame('r-undef', undefined)), {
      jsonrpc: '2.0',
      id: 'r-undef',
      result: null,
    });
    assert.deepEqual(
      normalizeSessionEventsSinceResult({
        events: [null, { type: 'token', seq: 13 }],
        latest_seq: 13,
        truncated: true,
        count: 1,
        replay_epoch: 'ep-2',
        open_requests: ['bad', { id: 'req-1' }],
      }),
      {
        events: [{ type: 'token', seq: 13 }],
        latestSeq: 13,
        truncated: true,
        count: 1,
        epoch: 'ep-2',
        openRequests: [{ id: 'req-1' }],
      },
    );
    assert.deepEqual(
      normalizeSessionEventsSinceResult({
        events: [],
        last_sequence: 7,
        epoch: 'e-7',
      }),
      {
        events: [],
        latestSeq: 7,
        truncated: false,
        count: 0,
        epoch: 'e-7',
        openRequests: [],
      },
    );
    assert.deepEqual(normalizeSessionEventsSinceResult(null), {
    events: [],
    latestSeq: 0,
    truncated: false,
    count: 0,
    epoch: '',
    openRequests: [],
  });

  const harness = createMockSocketHarness();
  const client = new HermesGatewayClient({
    url: 'ws://gw-c/api/ws',
    socketFactory: harness.socketFactory,
    autoConnect: true,
    enableHeartbeat: false,
    enableLifecycleWake: false,
  });

  try {
    const sock = harness.sockets[0];
    sock.triggerOpen();
    sock.deliver({ jsonrpc: '2.0', id: sock.sent[0].id, result: { pong: true } });
    await flushMicrotasks();

    // 能力协商
    const capPromise = client.negotiateCapabilities({ server_requests: true, desktop_local: true });
    const capReq = sock.sent.at(-1);
    assert.equal(capReq.method, 'client.capabilities');
    assert.deepEqual(capReq.params, { server_requests: true, desktop_local: true });
    sock.deliver({
      jsonrpc: '2.0',
      id: capReq.id,
      result: { server_requests: ['approval', 'clarify'], declines_not_shown: false },
    });
    const capRes = await capPromise;
    assert.deepEqual(capRes.server_requests, ['approval', 'clarify']);

    // Legacy events.since
    const legacyPromise = client.fetchSessionEventsSince({
      sessionId: 'sess-legacy',
      profile: 'coder',
      cursor: 5,
      replayEpoch: 'ep-1',
    });
    const legacyReq = sock.sent.at(-1);
    assert.equal(legacyReq.method, 'session.events.since');
    assert.equal(legacyReq.params.last_seen, 5);
    assert.equal('last_sequence' in legacyReq.params, false);
    sock.deliver({
      jsonrpc: '2.0',
      id: legacyReq.id,
      result: {
        events: [{ seq: 6 }],
        latest_seq: 6,
        truncated: false,
        count: 1,
        epoch: 'ep-1',
        open_requests: [],
      },
    });
    const legacyNormalized = await legacyPromise;
    assert.equal(legacyNormalized.latestSeq, 6);
    assert.equal(legacyNormalized.epoch, 'ep-1');

    // 切换 gateway.ready session_authority=true -> Canonical
    sock.deliver({
      jsonrpc: '2.0',
      method: 'gateway.ready',
      params: { replay_epoch: 'ep-canon', session_authority: true, change_events: true },
    });
    const canonPromise = client.fetchSessionEventsSince({
      sessionId: 'sess-canon',
      cursor: 9,
    });
    const canonReq = sock.sent.at(-1);
    assert.equal(canonReq.method, 'session.events.since');
    assert.equal(canonReq.params.last_sequence, 9);
    assert.equal(canonReq.params.replay_epoch, 'ep-canon');
    assert.equal('last_seen' in canonReq.params, false);
    sock.deliver({
      jsonrpc: '2.0',
      id: canonReq.id,
      result: { events: [], latest_seq: 9, last_sequence: 9, epoch: 'ep-canon', replay_epoch: 'ep-canon' },
    });
    const canonNormalized = await canonPromise;
    assert.equal(canonNormalized.latestSeq, 9);
  } finally {
    client.disconnect();
  }
});

test('M1.1: install_id 提取与 HermesGatewayClient / ProfileService 全链路透传', async () => {
  assert.equal(extractInstallId({ install_id: '  inst-abc-123  ' }), 'inst-abc-123');
  assert.equal(extractInstallId({ install_id: '   ' }), undefined);
  assert.equal(extractInstallId({ install_id: 42 }), undefined);
  assert.equal(extractInstallId(null), undefined);

  const harness = createMockSocketHarness();
  const client = new HermesGatewayClient({
    url: 'ws://gw-d/api/ws',
    socketFactory: harness.socketFactory,
    autoConnect: true,
    enableHeartbeat: false,
    enableLifecycleWake: false,
  });

  try {
    const sock = harness.sockets[0];
    sock.triggerOpen();
    sock.deliver({ jsonrpc: '2.0', id: sock.sent[0].id, result: { pong: true } });
    await flushMicrotasks();

    assert.equal(client.getInstallId(), undefined);
    const profilesPromise = client.listProfiles();
    const listReq = sock.sent.at(-1);
    assert.equal(listReq.method, 'profiles.list');
    sock.deliver({
      jsonrpc: '2.0',
      id: listReq.id,
      result: {
        install_id: 'inst-gw-01',
        profiles: [{ name: 'default', is_default: true }],
      },
    });
    const profiles = await profilesPromise;
    assert.equal(profiles.length, 1);
    assert.equal(client.getInstallId(), 'inst-gw-01');

    client.setInstallId('  inst-manual  ');
    assert.equal(client.getInstallId(), 'inst-manual');
    client.setInstallId('   ');
    assert.equal(client.getInstallId(), undefined);
    client.setInstallId(undefined);
    assert.equal(client.getInstallId(), undefined);

    const svc = new ProfileService();
    const svcProfiles = await svc.listProfiles(
      {
        request: async () => ({
          install_id: 'inst-svc-99',
          profiles: [{ name: 'coder' }],
        }),
      },
      true,
    );
    assert.equal(svcProfiles.length, 1);
    assert.equal(svc.getLastInstallId(), 'inst-svc-99');
  } finally {
    client.disconnect();
  }
});

test('M1.1: 心跳分支、无全局 WebSocket、重复 connect 短路与默认 replay_epoch 边界覆盖', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const savedWs = globalThis.WebSocket;

  try {
    delete globalThis.WebSocket;
    const noWsClient = new HermesGatewayClient({
      url: 'ws://no-ws/api/ws',
      autoConnect: true,
      enableHeartbeat: false,
      enableLifecycleWake: false,
    });
    assert.equal(noWsClient.getState(), 'DISCONNECTED');

    const harness = createMockSocketHarness();
    const client = new HermesGatewayClient({
      url: 'ws://hb-gw/api/ws',
      socketFactory: harness.socketFactory,
      autoConnect: true,
      enableHeartbeat: true,
      heartbeatIntervalMs: 100,
      heartbeatTimeoutMs: 50,
      enableLifecycleWake: false,
    });
    const sock = harness.sockets[0];
    client.connect(); // CONNECTING 短路
    assert.equal(harness.sockets.length, 1);

    sock.triggerOpen();
    sock.deliver({ jsonrpc: '2.0', id: sock.sent[0].id, result: { pong: true } });
    await flushMicrotasks();
    client.connect(); // OPEN 短路
    assert.equal(harness.sockets.length, 1);

    // CONNECTED + OPEN 正常发 ping
    t.mock.timers.tick(100);
    assert.equal(sock.sent.at(-1).method, 'ping');
    sock.deliver({ jsonrpc: '2.0', id: sock.sent.at(-1).id, result: { pong: true } });
    await flushMicrotasks();

    // 非 OPEN 状态跳过心跳
    sock.readyState = RPC_SOCKET_READY_STATE.CLOSING;
    const countBefore = sock.sent.length;
    t.mock.timers.tick(100);
    assert.equal(sock.sent.length, countBefore);
    sock.readyState = RPC_SOCKET_READY_STATE.OPEN;

    // 非 CONNECTED 状态跳过心跳
    client.getFsm().transitionTo('HANDSHAKING');
    t.mock.timers.tick(100);
    assert.equal(sock.sent.length, countBefore);
    client.getFsm().transitionTo('CONNECTED');

    // 未收到 gateway.ready 时省略 replayEpoch -> 走 undefined 分支
    const p = client.fetchSessionEventsSince({ sessionId: 's-no-ep' });
    const req = sock.sent.at(-1);
    assert.equal('replay_epoch' in req.params, false);
    sock.deliver({ jsonrpc: '2.0', id: req.id, result: { events: [] } });
    await p;

    client.disconnect();
  } finally {
    t.mock.timers.reset();
    globalThis.WebSocket = savedWs;
  }
});
