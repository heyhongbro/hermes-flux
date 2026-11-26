import test from 'node:test';
import assert from 'node:assert/strict';
import { HermesGatewayClient } from '../../dist/rpc/client.js';

test('HermesGatewayClient JSON-RPC 2.0 Unit Tests', async (t) => {
  await t.test('Client should format standard JSON-RPC 2.0 call and resolve result', async () => {
    const client = new HermesGatewayClient({
      url: 'ws://127.0.0.1:9119/api/ws',
      timeoutMs: 1000,
    });

    let sentFrame = null;
    const mockWs = {
      readyState: 1, // WebSocket.OPEN
      send(data) {
        sentFrame = JSON.parse(data);
      },
    };

    // Inject active mock ws socket
    client['ws'] = mockWs;

    const promise = client.call('session.list', { profile: 'default' });

    assert.ok(sentFrame, 'Must have sent a frame');
    assert.equal(sentFrame.jsonrpc, '2.0');
    assert.equal(sentFrame.method, 'session.list');
    assert.deepEqual(sentFrame.params, { profile: 'default' });
    assert.ok(sentFrame.id);

    // Simulate incoming server JSON-RPC response
    client['handleMessage'](
      JSON.stringify({
        jsonrpc: '2.0',
        id: sentFrame.id,
        result: { sessions: [{ id: 's-flux-01', title: 'Flux Real Session' }] },
      })
    );

    const result = await promise;
    assert.deepEqual(result, {
      sessions: [{ id: 's-flux-01', title: 'Flux Real Session' }],
    });
  });

  await t.test('Client should reject on JSON-RPC error response', async () => {
    const client = new HermesGatewayClient({
      url: 'ws://127.0.0.1:9119/api/ws',
      timeoutMs: 1000,
    });

    let sentFrame = null;
    const mockWs = {
      readyState: 1,
      send(data) {
        sentFrame = JSON.parse(data);
      },
    };
    client['ws'] = mockWs;

    const promise = client.call('session.delete', { session_id: 'invalid-id', profile: 'default' });

    client['handleMessage'](
      JSON.stringify({
        jsonrpc: '2.0',
        id: sentFrame.id,
        error: { code: -32602, message: 'Session not found' },
      })
    );

    await assert.rejects(promise, (err) => {
      assert.equal(err.code, -32602);
      assert.equal(err.message, 'Session not found');
      return true;
    });
  });

  await t.test('Client should deliver server notifications to registered handlers', async () => {
    const client = new HermesGatewayClient({
      url: 'ws://127.0.0.1:9119/api/ws',
    });

    let receivedData = null;
    const unsubscribe = client.onNotification('message.delta', (params) => {
      receivedData = params;
    });

    client['handleMessage'](
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'message.delta',
        params: {
          session_id: 's-flux-01',
          delta: '真实流式 Token',
        },
      })
    );

    assert.ok(receivedData);
    assert.equal(receivedData.delta, '真实流式 Token');

    // Unsubscribe verification
    unsubscribe();
    receivedData = null;
    client['handleMessage'](
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'message.delta',
        params: { delta: 'Should not receive' },
      })
    );
    assert.equal(receivedData, null, 'Must not receive after unsubscribe');
  });

  await t.test('运行时契约守卫：未知字段必须在发送前被拒绝，而不是等网关 4000', async () => {
    const client = new HermesGatewayClient({
      url: 'ws://127.0.0.1:9119/api/ws',
      timeoutMs: 1000,
    });

    let sent = null;
    client['ws'] = {
      readyState: 1,
      send(data) {
        sent = JSON.parse(data);
      },
    };

    // 复刻本次真实事故：profiles.get_asset 多传 key
    await assert.rejects(
      () => client.call('profiles.get_asset', { name: 'default', asset: 'avatar', key: 'avatar' }),
      (err) => {
        assert.equal(err.code, 'CONTRACT_VIOLATION');
        assert.equal(err.method, 'profiles.get_asset');
        assert.deepEqual(err.unknownFields, ['key']);
        assert.ok(err.allowedFields.includes('name'));
        assert.ok(err.allowedFields.includes('asset'));
        return true;
      }
    );
    assert.equal(sent, null, '违规请求绝不允许真的发出去');

    // 合法参数必须正常发送
    const okPromise = client.call('profiles.get_asset', { name: 'default', asset: 'avatar' });
    assert.ok(sent, '合法请求必须被发送');
    assert.equal(sent.method, 'profiles.get_asset');
    client['handleMessage'](
      JSON.stringify({ jsonrpc: '2.0', id: sent.id, result: { found: false } })
    );
    await okPromise;
  });

  await t.test('运行时契约守卫：ping 属于网关额外方法，必须放行', async () => {
    const client = new HermesGatewayClient({
      url: 'ws://127.0.0.1:9119/api/ws',
      timeoutMs: 1000,
    });
    let sent = null;
    client['ws'] = {
      readyState: 1,
      send(data) {
        sent = JSON.parse(data);
      },
    };

    const promise = client.call('ping', {});
    assert.ok(sent, 'ping 必须被放行（网关确有该方法，只是不在生成契约里）');
    assert.equal(sent.method, 'ping');
    client['handleMessage'](JSON.stringify({ jsonrpc: '2.0', id: sent.id, result: { pong: true } }));
    assert.deepEqual(await promise, { pong: true });
  });

  await t.test('listProfiles 必须原样透传 ui_meta 与 has_avatar（旧群聊房间的唯一来源）', async () => {
    const client = new HermesGatewayClient({
      url: 'ws://127.0.0.1:9119/api/ws',
      timeoutMs: 1000,
    });

    let sentFrame = null;
    client['ws'] = {
      readyState: 1,
      send(data) {
        sentFrame = JSON.parse(data);
      },
    };

    const promise = client.listProfiles();

    client['handleMessage'](
      JSON.stringify({
        jsonrpc: '2.0',
        id: sentFrame.id,
        result: {
          profiles: [
            {
              name: 'default',
              display_name: 'Hermes',
              has_avatar: true,
              ui_meta: {
                'hermes-bots-groups': {
                  rooms: {
                    'id:rmvvnkwv9-1xpyu': {
                      roomId: 'rmvvnkwv9-1xpyu',
                      name: 'Hermes, Aura',
                      members: [{ name: 'default' }, { name: 'aura' }],
                      log: [{ from: { kind: 'user', name: 'You' }, text: '历史发言', at: 1793406132119 }],
                    },
                  },
                },
              },
            },
            { name: 'xiaofawang', display_name: 'Xiaofawang', has_avatar: false },
          ],
        },
      })
    );

    const profiles = await promise;
    assert.equal(profiles.length, 2);

    const def = profiles.find((p) => p.name === 'default');
    assert.equal(def.hasAvatar, true, 'has_avatar 必须保留');
    assert.ok(def.uiMeta, 'ui_meta 必须保留，否则旧群聊永远查不到');

    const rooms = def.uiMeta['hermes-bots-groups'].rooms;
    assert.ok(rooms['id:rmvvnkwv9-1xpyu'], '旧群聊房间必须完整保留');
    assert.equal(rooms['id:rmvvnkwv9-1xpyu'].name, 'Hermes, Aura');
    assert.equal(rooms['id:rmvvnkwv9-1xpyu'].log.length, 1, '历史发言日志必须保留');

    const xfw = profiles.find((p) => p.name === 'xiaofawang');
    assert.equal(xfw.hasAvatar, false);
    assert.equal(xfw.uiMeta, undefined, '没有 ui_meta 时不得伪造空对象');
  });

  await t.test('长耗时慢速 RPC 超时时间表与显式 timeoutMs 覆盖', async () => {
    const client = new HermesGatewayClient({
      url: 'ws://127.0.0.1:9119/api/ws',
      timeoutMs: 50,
    });

    const mockWs = {
      readyState: 1,
      send() {},
    };
    client['ws'] = mockWs;

    // slash.exec 在 LONG_RUNNING_METHOD_TIMEOUT_MS 中注册为 120_000ms
    const p1 = client.call('slash.exec', { session_id: 'sess-1', command: '/compress' });
    const pendingMap = client['pendingRequests'];
    const lastId = client['nextId'] - 1;
    const pending1 = pendingMap.get(lastId);
    assert.ok(pending1, 'Pending request must exist');
    // 在 50ms 后不应超时熔断（因为查表为 120000ms）
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.ok(pendingMap.has(lastId), 'slash.exec 不应在 50ms 全局短超时下提前熔断');

    // 清理 p1
    clearTimeout(pending1.timer);
    pendingMap.delete(lastId);
    p1.catch(() => {});

    // 显式指定 timeoutMs = 30ms 必须覆盖长耗时表
    const p2 = client.call('slash.exec', { session_id: 'sess-1', command: '/compress' }, 30);
    await assert.rejects(
      p2,
      /timed out after 30ms/,
      '显式传入的 timeoutMs 必须覆盖长耗时查表配置'
    );
  });

  await t.test('fetchGatewayConfig：优先 REST /api/config 解包，失败回退 config.get({ key: "full" }) 并解包 .config', async () => {
    const client = new HermesGatewayClient({ url: 'ws://127.0.0.1:9119/api/ws', timeoutMs: 1000 });
    let capturedRest = null;
    client.setRestFallbackHandler(async (path, opts) => {
      capturedRest = { path, opts };
      return { config: { compression: { enabled: true, threshold: 0.5, threshold_tokens: 500000 } } };
    });

    const cfg1 = await client.fetchGatewayConfig('bot-pro');
    assert.equal(capturedRest.path, '/api/config');
    assert.equal(capturedRest.opts.params.profile, 'bot-pro');
    assert.deepEqual(cfg1.compression, { enabled: true, threshold: 0.5, threshold_tokens: 500000 });

    // REST 失败时回退 WS config.get({ key: 'full', profile })
    client.setRestFallbackHandler(async () => {
      throw new Error('rest offline');
    });
    let sentFrame = null;
    client['ws'] = {
      readyState: 1,
      send(data) {
        sentFrame = JSON.parse(data);
      },
    };
    const pWs = client.fetchGatewayConfig('alt-bot');
    // fetchGatewayConfig 先 await failed REST，微任务让出后再发送 WS 请求
    await new Promise((r) => setTimeout(r, 0));
    assert.ok(sentFrame);
    assert.equal(sentFrame.method, 'config.get');
    assert.deepEqual(sentFrame.params, { key: 'full', profile: 'alt-bot' });
    client['handleMessage'](
      JSON.stringify({
        jsonrpc: '2.0',
        id: sentFrame.id,
        result: { config: { compression: { enabled: true, threshold: 0.6 } } },
      })
    );
    const cfg2 = await pWs;
    assert.deepEqual(cfg2.compression, { enabled: true, threshold: 0.6 });
  });

  await t.test('会话用量/上下文分布/压缩/spawn_tree/session.transcript 新封装方法正确透传参数', async () => {
    const client = new HermesGatewayClient({ url: 'ws://127.0.0.1:9119/api/ws', timeoutMs: 1000 });
    const frames = [];
    client['ws'] = {
      readyState: 1,
      send(data) {
        const parsed = JSON.parse(data);
        frames.push(parsed);
        queueMicrotask(() => {
          client['handleMessage'](JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: { ok: true } }));
        });
      },
    };

    await client.getSessionUsage('live-1', 'p-1');
    await client.getSessionContextBreakdown('live-1', 'p-1');
    await client.compressSession('live-1', 'p-1', 'focus perf');
    await client.fetchSubagentTranscript({ session_id: 'stored-1', subagent_id: 'sub-1', order: 'oldest', cursor: 'c1', limit: 50, profile: 'p-1' });
    await client.listSpawnTrees('stored-1', 'p-1', 10);
    await client.loadSpawnTree('spawns/a.json', 'p-1');

    assert.equal(frames[0].method, 'session.usage');
    assert.deepEqual(frames[0].params, { session_id: 'live-1', profile: 'p-1' });
    assert.equal(frames[1].method, 'session.context_breakdown');
    assert.deepEqual(frames[1].params, { session_id: 'live-1', profile: 'p-1' });
    assert.equal(frames[2].method, 'session.compress');
    assert.deepEqual(frames[2].params, { session_id: 'live-1', profile: 'p-1', focus_topic: 'focus perf' });
    assert.equal(frames[3].method, 'session.transcript');
    assert.deepEqual(frames[3].params, { session_id: 'stored-1', profile: 'p-1', subagent_id: 'sub-1', cursor: 'c1', limit: 50, order: 'oldest' });
    assert.equal(frames[4].method, 'spawn_tree.list');
    assert.deepEqual(frames[4].params, { session_id: 'stored-1', profile: 'p-1', limit: 10 });
    assert.equal(frames[5].method, 'spawn_tree.load');
    assert.deepEqual(frames[5].params, { path: 'spawns/a.json', profile: 'p-1' });
  });

  await t.test('listArchivedSessions 仅传合法 archived=only 且失败时显式返回 ok:false（不假冒空成功）', async () => {
    const client = new HermesGatewayClient({ url: 'ws://127.0.0.1:9119/api/ws', timeoutMs: 1000 });
    let capturedCall = null;
    client.setRestFallbackHandler(async (path, opts) => {
      capturedCall = { path, opts };
      return {
        sessions: [
          { id: 'arch-1', title: 'Old Task', profile: 'default', archived: true, updated_at: 1000 },
        ],
      };
    });

    const okRes = await client.listArchivedSessions('default', 25);
    assert.equal(capturedCall.path, '/api/sessions');
    assert.deepEqual(capturedCall.opts.params, { profile: 'default', limit: 25, archived: 'only' });
    assert.equal(okRes.ok, true);
    assert.equal(okRes.sessions.length, 1);
    assert.equal(okRes.sessions[0].isArchived, true);

    client.setRestFallbackHandler(async () => {
      throw new Error('HTTP 400: archived must be one of: exclude, only, include');
    });
    const errRes = await client.listArchivedSessions('default', 25);
    assert.equal(errRes.ok, false);
    assert.match(errRes.error || '', /HTTP 400/);
    assert.deepEqual(errRes.sessions, []);

    client.setRestFallbackHandler(async () => '<!doctype html><html><body>Login</body></html>');
    const htmlRes = await client.listArchivedSessions('default', 25);
    assert.equal(htmlRes.ok, false);
    assert.deepEqual(htmlRes.sessions, []);

    client.setRestFallbackHandler(async () => ({ ok: false, detail: 'invalid archived parameter' }));
    const detailRes = await client.listArchivedSessions('default', 25);
    assert.equal(detailRes.ok, false);
    assert.match(detailRes.error || '', /invalid archived parameter/);
  });

  await t.test('manages socket generations, server requests, responses, errors, and capability handshake', async () => {
    const client = new HermesGatewayClient({
      url: 'ws://127.0.0.1:19999/ws',
      enableHeartbeat: false,
      enableLifecycleWake: false,
      clientCapabilities: { server_requests: true, desktop_local: false },
    });
    const flushMicrotasks = async () => {
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
    };

    try {
      assert.equal(client.getSocketGeneration(), 0);
      assert.equal(client.getNegotiatedCapabilities(), null);

      // No socket / closed socket returns false
      assert.equal(client.sendServerResponse('r0', { ok: true }), false);
      assert.equal(client.sendServerError('r0', -32000, 'no ws'), false);

      const sent = [];
      let throwOnSend = false;
      const openSocket = {
        readyState: WebSocket.OPEN,
        close() {},
        send(raw) {
          if (throwOnSend) throw new Error('send boom');
          const parsed = JSON.parse(raw);
          sent.push(parsed);
          if (parsed.method === 'client.capabilities') {
            queueMicrotask(() => {
              client.handleMessage(
                JSON.stringify({
                  jsonrpc: '2.0',
                  id: parsed.id,
                  result: { interactive: true, version: '1.0' },
                }),
              );
            });
          }
        },
      };

      // Stale socket guard in completeHandshake
      client.completeHandshake(openSocket);
      assert.equal(client.getState(), 'DISCONNECTED');

      // Promote FSM + bind active socket, then test handshake + capabilities negotiation
      client.ws = openSocket;
      client.getFsm().transitionTo('CONNECTING');
      client.getFsm().transitionTo('HANDSHAKING');
      client.completeHandshake(openSocket);
      assert.equal(client.getState(), 'CONNECTED');
      await flushMicrotasks();
      assert.deepEqual(client.getNegotiatedCapabilities(), { interactive: true, version: '1.0' });

      // Socket closed listener + generation bump
      const closedGens = [];
      const unsubClosed = client.onSocketClosed((gen) => closedGens.push(gen));
      client.bumpSocketGeneration();
      assert.equal(client.getSocketGeneration(), 1);
      assert.equal(client.getNegotiatedCapabilities(), null);
      assert.deepEqual(closedGens, [0]);
      unsubClosed();
      client.bumpSocketGeneration();
      assert.equal(client.getSocketGeneration(), 2);
      assert.deepEqual(closedGens, [0]);

      // sendServerResponse & sendServerError: stale generation, success, and send throw
      assert.equal(client.sendServerResponse('r1', { ok: true }, 1, 'request.answer'), false);
      assert.equal(client.sendServerError('r1', -32601, 'stale', undefined, 1), false);

      sent.length = 0;
      assert.equal(client.sendServerResponse('r2', { token: 'abc' }, 2), true);
      assert.equal(client.sendServerError('r3', -32001, 'bad input', { field: 'x' }, 2), true);
      assert.equal(sent.length, 2);
      assert.deepEqual(sent[0].result, { token: 'abc' });
      assert.equal(sent[1].error.code, -32001);

      throwOnSend = true;
      assert.equal(client.sendServerResponse('r4', { ok: true }, 2, 'approval.decide'), false);
      assert.equal(client.sendServerError('r5', -32002, 'fail', undefined, 2), false);
      throwOnSend = false;

      // handleMessage server-request routing: unclaimed -> -32601, throwing listener caught, claimed -> no auto-error
      sent.length = 0;
      const unsubThrow = client.onServerRequest(() => {
        throw new Error('listener error');
      });
      client.handleMessage(JSON.stringify({ jsonrpc: '2.0', id: 'sr-1', method: 'approval.prompt', params: { p: 1 } }));
      assert.equal(sent.length, 1);
      assert.equal(sent[0].error.code, -32601);
      unsubThrow();

      const captured = [];
      const unsubClaim = client.onServerRequest((frame) => {
        captured.push(frame);
        return true;
      });
      client.handleMessage(JSON.stringify({ jsonrpc: '2.0', id: 'sr-2', method: 'approval.prompt', params: { p: 2 } }));
      assert.equal(captured.length, 1);
      assert.equal(captured[0].socketGeneration, 2);
      assert.equal(sent.length, 1);
      unsubClaim();

      // Early return inside negotiateClientCapabilities when socket is replaced before resolve
      const client2 = new HermesGatewayClient({
        url: 'ws://127.0.0.1:19999/ws',
        enableHeartbeat: false,
        enableLifecycleWake: false,
        clientCapabilities: { interactive: true },
      });
      try {
        let resolveReplaced;
        const replacedSocket = {
          readyState: WebSocket.OPEN,
          close() {},
          send(raw) {
            const parsed = JSON.parse(raw);
            if (parsed.method === 'client.capabilities') {
              resolveReplaced = () =>
                client2.handleMessage(
                  JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: { stale: true } }),
                );
            }
          },
        };
        client2.ws = replacedSocket;
        client2.getFsm().transitionTo('CONNECTING');
        client2.getFsm().transitionTo('HANDSHAKING');
        client2.completeHandshake(replacedSocket);
        client2.ws = openSocket;
        resolveReplaced?.();
        await flushMicrotasks();
        assert.equal(client2.getNegotiatedCapabilities(), null);
        // Orphan response id for non-existent pendingRequest hits if (!pending) return cleanly (L1465)
        client2.handleMessage(JSON.stringify({ jsonrpc: '2.0', id: 'orphan-resp-id', result: {} }));
      } finally {
        client2.disconnect();
      }
    } finally {
      client.disconnect();
    }
  });
});
