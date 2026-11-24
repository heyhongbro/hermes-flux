import test from 'node:test';
import assert from 'node:assert/strict';
import { HermesGatewayClient } from '../../dist/rpc/client.js';

function withMockWebSocket(factory) {
  const HadWs = 'WebSocket' in globalThis;
  const PrevWs = globalThis.WebSocket;
  class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    constructor(url) {
      this.url = url;
      this.readyState = FakeWebSocket.CONNECTING;
      this.onopen = null;
      this.onmessage = null;
      this.onerror = null;
      this.onclose = null;
      this.sent = [];
      factory(this);
    }
    send(data) {
      this.sent.push(data);
      if (this._onSend) this._onSend(data);
    }
    close() {
      this.readyState = FakeWebSocket.CLOSED;
      if (this._onClose) this._onClose();
    }
  }
  globalThis.WebSocket = FakeWebSocket;
  return () => {
    if (HadWs) globalThis.WebSocket = PrevWs;
    else delete globalThis.WebSocket;
  };
}

test('HermesGatewayClient probeOrWake & handshake hardening unit suite', async (t) => {
  await t.test('handshake ping: success -> CONNECTED, numeric RPC error -> CONNECTED, timeout/transport error -> RECONNECTING', async () => {
    const sockets = [];
    const restore = withMockWebSocket((s) => sockets.push(s));
    try {
      const client = new HermesGatewayClient({
        url: 'ws://127.0.0.1:9119/api/ws',
        heartbeatTimeoutMs: 40,
        enableHeartbeat: false,
        enableLifecycleWake: false,
      });

      // 1. Success handshake
      client.connect();
      const s1 = sockets[0];
      s1.readyState = 1;
      s1._onSend = (raw) => {
        const frame = JSON.parse(raw);
        s1.onmessage({ data: JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: { pong: true } }) });
      };
      s1.onopen();
      await new Promise((r) => setTimeout(r, 15));
      assert.equal(client.getState(), 'CONNECTED');
      assert.equal(client.getReconnectAttempt(), 0);

      // Simulate onclose clearing inflight pending requests immediately
      s1._onSend = () => {};
      const inflight = client.call('session.list', { profile: 'default' });
      s1.onclose();
      await assert.rejects(inflight, /WebSocket closed/);
      assert.equal(client.getState(), 'RECONNECTING');
      assert.ok(client.getReconnectAttempt() >= 1);

      // 2. Legacy numeric RPC error (-32601) -> CONNECTED
      client.wakeImmediately('legacy-test');
      const s2 = sockets[sockets.length - 1];
      s2.readyState = 1;
      s2._onSend = (raw) => {
        const frame = JSON.parse(raw);
        s2.onmessage({ data: JSON.stringify({ jsonrpc: '2.0', id: frame.id, error: { code: -32601, message: 'not found' } }) });
      };
      s2.onopen();
      await new Promise((r) => setTimeout(r, 15));
      assert.equal(client.getState(), 'CONNECTED');
      s2.onclose();

      // 3. Handshake ping timeout + socket.close throws -> RECONNECTING
      client.wakeImmediately('handshake-fail-test');
      const s3 = sockets[sockets.length - 1];
      s3.readyState = 1;
      s3._onSend = () => {}; // no reply -> times out at 40ms
      let s3CloseAttempted = false;
      s3._onClose = () => {
        s3CloseAttempted = true;
        throw new Error('close failed on half-open handshake');
      };
      // 必须事件驱动监听 HANDSHAKING -> RECONNECTING：WebSocketFsm 采用全抖动退避 Uniform(0, 1000)，
      // 固定 sleep 会偶发晚于随机短退避定时器触发 connect() 而观测到 CONNECTING。
      const waitReconnecting = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          unsub();
          reject(new Error(`Expected HANDSHAKING -> RECONNECTING, current state=${client.getState()}`));
        }, 2000);
        const unsub = client.getFsm().onStateChange((next, prev) => {
          if (prev === 'HANDSHAKING' && next === 'RECONNECTING') {
            clearTimeout(timer);
            unsub();
            resolve();
          }
        });
      });
      s3.onopen();
      await waitReconnecting;
      assert.equal(s3CloseAttempted, true);
      assert.equal(client.getState(), 'RECONNECTING');
      assert.ok(client.getReconnectAttempt() >= 1);

      client.disconnect();
    } finally {
      restore();
    }
  });

  await t.test('ws.send throwing synchronously rejects call() and cleans up timer', async () => {
    const client = new HermesGatewayClient({
      url: 'ws://127.0.0.1:9119/api/ws',
      enableLifecycleWake: false,
      timeoutMs: 500,
    });
    client['ws'] = {
      readyState: 1,
      send() {
        throw new Error('broken pipe');
      },
      close() {},
    };
    await assert.rejects(client.call('ping', {}), /broken pipe/);

    client['ws'] = {
      readyState: 1,
      send() {
        throw 'string send error';
      },
      close() {},
    };
    await assert.rejects(client.call('ping', {}), /string send error/);
    client.disconnect();
  });

  await t.test('probeOrWake covers CONNECTED alive/dedup/legacy/timeout, stale CONNECTING/HANDSHAKING, RECONNECTING, intentionalClose', async () => {
    const sockets = [];
    const restore = withMockWebSocket((s) => sockets.push(s));
    try {
      const client = new HermesGatewayClient({
        url: 'ws://127.0.0.1:9119/api/ws',
        enableHeartbeat: false,
        enableLifecycleWake: false,
      });

      // DISCONNECTED / IDLE -> wakeImmediately -> 'reconnecting'
      assert.equal(await client.probeOrWake('cold-wake'), 'reconnecting');
      const s1 = sockets[0];
      assert.equal(client.getState(), 'CONNECTING');

      // Fresh CONNECTING (< staleConnectingMs) stays 'reconnecting' without tearing down socket
      assert.equal(await client.probeOrWake('fresh-connecting', { staleConnectingMs: 60_000 }), 'reconnecting');
      assert.equal(sockets.length, 1);

      // Stale CONNECTING (>= staleConnectingMs) + throwing close() -> resets without setting intentionalClose
      client['isResolvingUrl'] = true;
      s1._onClose = () => {
        throw new Error('stale close boom');
      };
      assert.equal(await client.probeOrWake('stale-connecting', { staleConnectingMs: 0 }), 'reconnecting');
      assert.equal(client['intentionalClose'], false);
      assert.equal(client['isResolvingUrl'], false);
      assert.ok(sockets.length >= 2);

      // Transition s2 to CONNECTED
      const s2 = sockets[sockets.length - 1];
      s2.readyState = 1;
      s2._onSend = (raw) => {
        const frame = JSON.parse(raw);
        s2.onmessage({ data: JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: { pong: true } }) });
      };
      s2.onopen();
      await new Promise((r) => setTimeout(r, 15));
      assert.equal(client.getState(), 'CONNECTED');

      // Single-flight deduplication on CONNECTED alive probe
      let pingCount = 0;
      s2._onSend = (raw) => {
        const frame = JSON.parse(raw);
        pingCount += 1;
        setTimeout(() => {
          s2.onmessage({ data: JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: { pong: true } }) });
        }, 20);
      };
      const [r1, r2] = await Promise.all([client.probeOrWake('p1'), client.probeOrWake('p2')]);
      assert.equal(r1, 'alive');
      assert.equal(r2, 'alive');
      assert.equal(pingCount, 1, 'concurrent CONNECTED probes must deduplicate into one ping');

      // Legacy RPC error code on CONNECTED probe still counts as alive
      s2._onSend = (raw) => {
        const frame = JSON.parse(raw);
        s2.onmessage({ data: JSON.stringify({ jsonrpc: '2.0', id: frame.id, error: { code: -32601, message: 'none' } }) });
      };
      assert.equal(await client.probeOrWake('legacy-alive'), 'alive');

      // CONNECTED probe when socket replaced mid-flight returns 'reconnecting' safely
      s2._onSend = () => {}; // never responds
      const replaceRace = client.probeOrWake('replace-race', { probeTimeoutMs: 30 });
      client['ws'] = { readyState: 1, send() {}, close() {} };
      assert.equal(await replaceRace, 'reconnecting');

      // Restore s2 as active socket and test CONNECTED half-open probe timeout -> recycles socket
      client['ws'] = s2;
      s2.readyState = 1;
      s2._onSend = () => {};
      assert.equal(await client.probeOrWake('half-open', { probeTimeoutMs: 25 }), 'reconnecting');
      const s3 = sockets[sockets.length - 1];
      assert.ok(sockets.indexOf(s3) > sockets.indexOf(s2));

      // CONNECTED with closed readyState -> recycles immediately
      client['fsm'].transitionTo('CONNECTED');
      s3.readyState = 3;
      assert.equal(await client.probeOrWake('dead-readyState'), 'reconnecting');

      // Probe rejected because disconnect() was called mid-probe -> 'disconnected'
      const s4 = sockets[sockets.length - 1];
      s4.readyState = 1;
      client['fsm'].transitionTo('CONNECTED');
      client['ws'] = s4;
      s4._onSend = () => {};
      const disconnectMidProbe = client.probeOrWake('mid-disconnect', { probeTimeoutMs: 20 });
      client.disconnect();
      assert.equal(await disconnectMidProbe, 'disconnected');

      // intentionalClose -> probeOrWake returns 'disconnected' immediately
      assert.equal(await client.probeOrWake('after-disconnect'), 'disconnected');
    } finally {
      restore();
    }
  });
});
