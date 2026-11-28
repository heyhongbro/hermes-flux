/**
 * Stage 2A Core Multi-Gateway Interactive & Pool Routing Unit Tests
 * (packages/core/__tests__/gateway/multi-gateway-stage2-interactive.test.mjs)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GatewayConnectionPool,
  InteractiveRequestCoordinator,
  RPC_SOCKET_READY_STATE,
} from '../../dist/index.js';

function flushMicrotasks() {
  return new Promise((resolve) => queueMicrotask(resolve));
}

function createSocketHarness() {
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
        if (sock.closed) return;
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

test('GatewayConnectionPool forwards slot interactive requests, default server requests, and socket close per gatewayId', async () => {
  const harness = createSocketHarness();
  const pool = new GatewayConnectionPool({
    socketFactory: harness.socketFactory,
    clientCapabilities: { server_requests: true, desktop_local: false },
    enableHeartbeat: false,
    enableLifecycleWake: false,
    authenticateGateway: async (cfg) => ({ ok: true, ticket: `tk-${cfg.id}`, latency: 10 }),
  });

  const interactiveEvents = [];
  const defaultServerEvents = [];
  const socketClosedEvents = [];

  const unsubInteractiveTrue = pool.onSlotInteractiveRequest((gatewayId, frame, client) => {
    interactiveEvents.push({ tag: 'claim', gatewayId, method: frame.method, hasClient: Boolean(client) });
    return frame.method === 'approval';
  });
  const unsubInteractiveFalse = pool.onSlotInteractiveRequest((gatewayId, frame, client) => {
    interactiveEvents.push({ tag: 'observer', gatewayId, method: frame.method, hasClient: Boolean(client) });
    return false;
  });
  const unsubServer = pool.onSlotServerRequest(async (gatewayId, req, client) => {
    defaultServerEvents.push({ gatewayId, method: req.method, hasClient: Boolean(client) });
    return { handledBy: gatewayId };
  });
  const unsubClosed = pool.onSlotSocketClosed((gatewayId, closedGeneration) => {
    socketClosedEvents.push({ gatewayId, closedGeneration });
  });

  const slot = pool.addGateway({
    id: 'gw-alpha',
    name: 'Alpha',
    url: 'http://127.0.0.1:18642',
    routeKind: 'direct',
  });

  const connectPromise = pool.connectGateway('gw-alpha');
  await flushMicrotasks();
  const sock = harness.sockets[0];
  sock.triggerOpen();
  sock.deliver({ jsonrpc: '2.0', id: sock.sent[0].id, result: { pong: true } });
  sock.deliver({
    jsonrpc: '2.0',
    method: 'gateway.ready',
    params: { session_authority: true, replay_epoch: 'ep-1' },
  });
  await connectPromise;
  await flushMicrotasks();

  // 1. Server request claimed by interactive listener
  sock.deliver({
    jsonrpc: '2.0',
    id: 'req-claimed-1',
    method: 'approval',
    params: { request_id: 'ap-1', session_id: 'live-a', command: 'echo hi' },
  });
  await flushMicrotasks();
  assert.equal(interactiveEvents.filter((e) => e.method === 'approval').length, 2);
  assert.equal(interactiveEvents[0].gatewayId, 'gw-alpha');
  assert.equal(interactiveEvents[0].hasClient, true);
  assert.equal(defaultServerEvents.length, 0);

  // 2. Unclaimed server request falls through to onSlotServerRequest with 3rd `client` arg
  sock.deliver({
    jsonrpc: '2.0',
    id: 'req-default-1',
    method: 'desktop.custom',
    params: { payload: 42 },
  });
  await flushMicrotasks();
  await flushMicrotasks();
  await flushMicrotasks();
  await flushMicrotasks();
  assert.deepEqual(defaultServerEvents, [{ gatewayId: 'gw-alpha', method: 'desktop.custom', hasClient: true }]);
  assert.ok(sock.sent.some((m) => m.id === 'req-default-1' && m.result?.handledBy === 'gw-alpha'));

  // 3. Socket close notifies onSlotSocketClosed
  const activeClient = slot.client;
  assert.ok(activeClient);
  sock.close();
  await flushMicrotasks();
  assert.equal(socketClosedEvents.length, 1);
  assert.equal(socketClosedEvents[0].gatewayId, 'gw-alpha');
  assert.equal(typeof socketClosedEvents[0].closedGeneration, 'number');

  // 4. Unsubscribe cleans up all listeners cleanly
  unsubInteractiveTrue();
  unsubInteractiveFalse();
  unsubServer();
  unsubClosed();
  sock.close();
  assert.equal(socketClosedEvents.length, 1);
});

test('InteractiveRequestCoordinator.onSocketClosed applies optional filter selectively across slots', () => {
  const coordinator = new InteractiveRequestCoordinator();
  coordinator.upsertServerRequest({
    rpcId: 'rpc-alpha',
    socketGeneration: 1,
    method: 'approval',
    params: { request_id: 'req-alpha', session_id: 'live-alpha', command: 'ls' },
    storedSessionId: 'sess-alpha',
    nowMs: 1000,
    origin: 'live_ws',
  });
  coordinator.upsertServerRequest({
    rpcId: 'rpc-beta',
    socketGeneration: 1,
    method: 'approval',
    params: { request_id: 'req-beta', session_id: 'live-beta', command: 'pwd' },
    storedSessionId: 'sess-beta',
    nowMs: 1005,
    origin: 'live_ws',
  });

  coordinator.onSocketClosed(1, (prompt) => prompt.scope.kind === 'session' && prompt.scope.storedSessionId === 'sess-alpha');

  const unresolved = coordinator.listUnresolvedPrompts();
  const alpha = unresolved.find((p) => p.requestId === 'req-alpha');
  const beta = unresolved.find((p) => p.requestId === 'req-beta');
  assert.equal(alpha?.rpcId, null, 'filtered gateway prompt must unbind rpcId');
  assert.equal(alpha?.socketGeneration, null);
  assert.equal(beta?.rpcId, 'rpc-beta', 'unrelated gateway prompt must keep live rpcId');
  assert.equal(beta?.socketGeneration, 1);

  coordinator.onSocketClosed(1);
  const afterAll = coordinator.listUnresolvedPrompts().find((p) => p.requestId === 'req-beta');
  assert.equal(afterAll?.rpcId, null);
});
