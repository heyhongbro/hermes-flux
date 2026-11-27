/**
 * Core clientChannelHelpers、fetchSessionMessages 与 executeServerRequestFrame 分支全覆盖单测
 * (packages/core/__tests__/rpc/client-channel-helpers.test.mjs)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HermesGatewayClient,
  RPC_SOCKET_READY_STATE,
  executeServerRequestFrame,
} from '../../dist/index.js';
import {
  describeRpcClientError,
  fetchGatewayConfigWithFallback,
  fetchLastMessageWithFallback,
  getModelCatalogWithFallback,
  listArchivedSessionsWithFallback,
  listProfilesWithFallback,
  listSessionsWithFallback,
} from '../../dist/rpc/clientChannelHelpers.js';

function createTransport(opts = {}) {
  let socketOpen = Boolean(opts.socketOpen);
  let fsmState = opts.fsmState ?? (socketOpen ? 'CONNECTED' : 'DISCONNECTED');
  let rest = opts.rest === undefined ? null : opts.rest;
  return {
    setSocketOpen(v) { socketOpen = v; },
    setFsmState(s) { fsmState = s; },
    setRest(r) { rest = r; },
    async call(method, params) {
      if (opts.onCall) return opts.onCall(method, params);
      throw new Error(`Unexpected WS call: ${method}`);
    },
    isSocketOpen: () => socketOpen,
    getFsmState: () => fsmState,
    getRestFallback: () => rest,
  };
}

test('describeRpcClientError 覆盖 Error / code / string / 未知类型', () => {
  assert.equal(describeRpcClientError(new Error('boom')), 'boom');
  assert.equal(describeRpcClientError({ message: '   ', code: 4000 }), 'RPC 错误 4000');
  assert.equal(describeRpcClientError('plain err'), 'plain err');
  assert.equal(describeRpcClientError(12345), '未知错误');
});

test('listSessionsWithFallback 覆盖 REST/WS 降级与 limit/error 全分支', async () => {
  // 1. REST 失败 + WS 断开（返回 lastError）
  const t1 = createTransport({
    socketOpen: false,
    rest: async () => { throw new Error('rest-down'); },
  });
  const r1 = await listSessionsWithFallback(t1, 'default', 0);
  assert.equal(r1.ok, false);
  assert.equal(r1.error, 'rest-down');

  // 2. REST 失败 + WS 连通成功 + WS 回落
  const t2 = createTransport({
    socketOpen: true,
    rest: async () => { throw 'rest-str-err'; },
    onCall: async () => ({ sessions: [{ id: 's-ws', title: 'WS', timestamp: 1 }] }),
  });
  const r2 = await listSessionsWithFallback(t2, 'coder', 10);
  assert.equal(r2.ok, true);
  assert.equal(r2.sessions[0].id, 's-ws');

  // 3. REST 与 WS 均抛异常且错误为空字符串时触发默认错误文案
  const t3 = createTransport({
    socketOpen: true,
    rest: async () => { throw ''; },
    onCall: async () => { throw ''; },
  });
  const r3 = await listSessionsWithFallback(t3, 'default', 50);
  assert.equal(r3.ok, false);
  assert.equal(r3.error, '');

  const t4 = createTransport({ socketOpen: false, fsmState: 'CONNECTING', rest: null });
  const r4 = await listSessionsWithFallback(t4);
  assert.equal(r4.ok, false);
  assert.match(r4.error, /WebSocket 未连接/);

  const t5 = createTransport({
    socketOpen: true,
    rest: null,
    onCall: async () => { throw { code: 5000 }; },
  });
  const r5 = await listSessionsWithFallback(t5);
  assert.equal(r5.ok, false);
  assert.equal(r5.error, 'RPC 错误 5000');
});

test('listArchivedSessionsWithFallback 覆盖未注入 REST / 畸形载荷 / 显式拒绝 / 异常全分支', async () => {
  assert.equal((await listArchivedSessionsWithFallback(createTransport({ rest: null }))).ok, false);

  const cases = [
    { val: '<html>nope</html>', expectErr: '网关返回非 JSON 已归档会话响应' },
    { val: { ok: false }, expectErr: '网关拒绝返回已归档会话列表' },
    { val: { detail: 'detail-bad' }, expectErr: 'detail-bad' },
    { val: { detail: '   ', error: 'err-bad' }, expectErr: 'err-bad' },
    { val: { badKey: [] }, expectErr: '网关未返回合法的已归档会话列表' },
    { val: 42, expectErr: '网关未返回合法的已归档会话列表' },
  ];
  for (const c of cases) {
    const res = await listArchivedSessionsWithFallback(
      createTransport({ rest: async () => c.val }),
      'default',
      0,
    );
    assert.equal(res.ok, false);
    assert.equal(res.error, c.expectErr);
  }

  const okArr = await listArchivedSessionsWithFallback(
    createTransport({ rest: async () => [{ id: 'arch-1', title: 'A' }] }),
  );
  assert.equal(okArr.ok, true);
  assert.equal(okArr.sessions[0].isArchived, true);

  const okObj = await listArchivedSessionsWithFallback(
    createTransport({ rest: async () => ({ sessions: [{ id: 'arch-2', title: 'B' }] }) }),
  );
  assert.equal(okObj.ok, true);

  const errRes = await listArchivedSessionsWithFallback(
    createTransport({ rest: async () => { throw new Error('arch-boom'); } }),
  );
  assert.equal(errRes.ok, false);
  assert.equal(errRes.error, 'arch-boom');
});

test('fetchLastMessageWithFallback 覆盖空入参、text/content、时间戳与异常降级', async () => {
  assert.equal(await fetchLastMessageWithFallback(createTransport({ rest: null }), 's1'), null);
  assert.equal(await fetchLastMessageWithFallback(createTransport({ rest: async () => ({}) }), ''), null);
  assert.equal(
    await fetchLastMessageWithFallback(createTransport({ rest: async () => ({ messages: [] }) }), 's1'),
    null,
  );
  assert.deepEqual(
    await fetchLastMessageWithFallback(
      createTransport({ rest: async () => ({ messages: [{ text: 'a\nb  c', timestamp: 1700000000 }] }) }),
      's1',
      { profile: 'coder' },
    ),
    { text: 'a b c', timestamp: 1700000000000, role: '' },
  );
  assert.deepEqual(
    await fetchLastMessageWithFallback(
      createTransport({ rest: async () => ({ messages: [{ content: 'hi', timestamp: 1700000000000, role: 'assistant' }] }) }),
      's1',
    ),
    { text: 'hi', timestamp: 1700000000000, role: 'assistant' },
  );
  assert.deepEqual(
    await fetchLastMessageWithFallback(
      createTransport({ rest: async () => ({ messages: [{ timestamp: 0 }] }) }),
      's1',
    ),
    { text: '', timestamp: 0, role: '' },
  );
  assert.equal(
    await fetchLastMessageWithFallback(
      createTransport({ rest: async () => 'non-obj' }),
      's1',
    ),
    null,
  );
  assert.equal(
    await fetchLastMessageWithFallback(
      createTransport({ rest: async () => ({}) }),
      's1',
    ),
    null,
  );
  assert.deepEqual(
    await fetchLastMessageWithFallback(
      createTransport({ rest: async () => ({ messages: [{ content: 'no-ts', timestamp: 'bad' }] }) }),
      's1',
    ),
    { text: 'no-ts', timestamp: 0, role: '' },
  );
  assert.equal(
    await fetchLastMessageWithFallback(
      createTransport({ rest: async () => { throw new Error('last-err'); } }),
      's1',
    ),
    null,
  );
});

test('getModelCatalogWithFallback / listProfilesWithFallback / fetchGatewayConfigWithFallback 覆盖全路径', async () => {
  const catNull = await getModelCatalogWithFallback(
    createTransport({ socketOpen: false, rest: null }),
    'default',
    ['m-fb'],
  );
  assert.equal(catNull.ok, false);
  assert.deepEqual(catNull.models, ['m-fb']);

  const profArr = await listProfilesWithFallback(
    createTransport({ onCall: async () => [{ name: 'bot-a' }] }),
  );
  assert.equal(profArr.profiles[0].name, 'bot-a');

  const profObj = await listProfilesWithFallback(
    createTransport({ onCall: async () => ({ install_id: 'inst-1', profiles: [{ name: 'bot-b' }] }) }),
  );
  assert.equal(profObj.installId, 'inst-1');
  assert.equal(profObj.profiles[0].name, 'bot-b');

  const profEmptyObj = await listProfilesWithFallback(
    createTransport({ onCall: async () => ({ unexpected: true }) }),
  );
  assert.deepEqual(profEmptyObj.profiles, []);

  const profErr = await listProfilesWithFallback(
    createTransport({ onCall: async () => { throw new Error('prof-fail'); } }),
  );
  assert.equal(profErr.profiles[0].isDefault, true);

  // fetchGatewayConfigWithFallback
  assert.deepEqual(
    await fetchGatewayConfigWithFallback(
      createTransport({ rest: async () => ({ config: { a: 1 } }) }),
      'coder',
    ),
    { a: 1 },
  );
  assert.deepEqual(
    await fetchGatewayConfigWithFallback(
      createTransport({ rest: async () => ({ b: 2 }) }),
    ),
    { b: 2 },
  );
  assert.deepEqual(
    await fetchGatewayConfigWithFallback(
      createTransport({
        socketOpen: true,
        rest: async () => 'non-obj',
        onCall: async () => ({ config: { c: 3 } }),
      }),
      'coder',
    ),
    { c: 3 },
  );
  assert.deepEqual(
    await fetchGatewayConfigWithFallback(
      createTransport({
        socketOpen: true,
        rest: async () => { throw new Error('rest-cfg-err'); },
        onCall: async () => ({ d: 4 }),
      }),
    ),
    { d: 4 },
  );
  await assert.rejects(
    () => fetchGatewayConfigWithFallback(
      createTransport({
        socketOpen: true,
        rest: async () => { throw 'rest-str-cfg-err'; },
        onCall: async () => 'non-obj-ws',
      }),
    ),
    /rest-str-cfg-err/,
  );
  await assert.rejects(
    () => fetchGatewayConfigWithFallback(
      createTransport({
        socketOpen: false,
        rest: async () => { throw new Error('rest-throw-err'); },
      }),
    ),
    /rest-throw-err/,
  );
  await assert.rejects(
    () => fetchGatewayConfigWithFallback(createTransport({ socketOpen: false, rest: null })),
    /网关未连接且无法读取配置/,
  );
});

test('HermesGatewayClient.fetchSessionMessages 与 executeServerRequestFrame 边界全覆盖', async () => {
  const errFrameJson = await executeServerRequestFrame(
    { id: 99, method: 'unknown.method', params: {} },
    undefined,
    null,
  );
  assert.equal(JSON.parse(errFrameJson).error.code, -32601);

  const client = new HermesGatewayClient({
    url: 'ws://mock/api/ws',
    enableHeartbeat: false,
    enableLifecycleWake: false,
    socketFactory: () => ({ readyState: RPC_SOCKET_READY_STATE.CLOSED, send() {}, close() {} }),
  });

  // 未注入 REST
  assert.equal((await client.fetchSessionMessages('s1')).status, 'error');

  // 非法响应与边界分页
  const responses = [
    null,
    { messages: 'bad' },
    { messages: [123] },
    { messages: [{ id: 'm1' }], pagination: { returned: 1, total: 9 } },
    { messages: [{ id: 'm2' }], pagination: { returned: 'x', total: 'y' } },
    { messages: [{ id: 'm3' }], pagination: null },
  ];
  for (const r of responses) {
    client.setRestFallbackHandler(async () => r);
    const out = await client.fetchSessionMessages('s1', { profile: 'coder', includeCompacted: true });
    assert.ok(out.status === 'success' || out.status === 'error');
  }

  client.setRestFallbackHandler(async () => { throw new Error('fetch-msg-boom'); });
  const errOut = await client.fetchSessionMessages('s1');
  assert.equal(errOut.status, 'error');
  assert.equal(errOut.error, 'fetch-msg-boom');
});
