/**
 * M1.2 Core 5 元组缓存隔离、分桶配额与群聊哨兵单元测试
 * (packages/core/__tests__/cache/m1-2-multi-gateway-cache.test.mjs)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CACHE_SCHEMA_VERSION,
  DEFAULT_CACHE_GATEWAY_ID,
  ROOM_CACHE_GATEWAY_ID,
  CacheService,
  MemoryCacheStore,
  channelKey,
  messageKey,
  normalizeCachedMessageRow,
  resolveCacheGatewayId,
  resolveIndexKey,
  createEnvelope,
} from '../../dist/index.js';

function makeMsg(orderKey, overrides = {}) {
  return {
    profile: 'default',
    channel: 'session',
    channelId: 's-shared',
    orderKey,
    role: 'assistant',
    text: `msg-${orderKey}`,
    timestamp: 1_700_000_000_000 + orderKey,
    status: 'complete',
    ...overrides,
  };
}

function makeSummary(id, timestamp, overrides = {}) {
  return {
    id,
    profile: 'default',
    kind: 'session',
    title: `title-${id}`,
    timestamp,
    isArchived: false,
    hidden: false,
    pinned: false,
    unread: false,
    ...overrides,
  };
}

test('M1.2: Schema V2 常量、resolveCacheGatewayId 与 resolveIndexKey 规则', () => {
  assert.equal(CACHE_SCHEMA_VERSION, 2);
  assert.equal(DEFAULT_CACHE_GATEWAY_ID, '__default__');
  assert.equal(ROOM_CACHE_GATEWAY_ID, '__room__');

  assert.equal(resolveCacheGatewayId({ channel: 'session' }), '__default__');
  assert.equal(resolveCacheGatewayId({ channel: 'session', gatewayId: '   ' }), '__default__');
  assert.equal(resolveCacheGatewayId({ channel: 'session', gatewayId: '  gw-alpha  ' }), 'gw-alpha');
  assert.equal(resolveCacheGatewayId({ channel: 'room', gatewayId: 'gw-alpha' }), '__room__');
  assert.equal(resolveCacheGatewayId({ kind: 'group', gatewayId: 'gw-alpha' }), '__room__');

  assert.equal(resolveIndexKey('sessions'), 'sessions');
  assert.equal(resolveIndexKey('sessions', '   '), 'sessions');
  assert.equal(resolveIndexKey('sessions', ' gw-1 '), 'sessions:gw-1');
  assert.equal(resolveIndexKey('agents', 'gw-2'), 'agents:gw-2');
  assert.equal(resolveIndexKey('avatars', 'gw-2'), 'avatars:gw-2');
  assert.equal(resolveIndexKey('sync-meta', 'gw-2'), 'sync-meta:gw-2');

  const refA = { gatewayId: 'gw-a', profile: 'default', channel: 'session', channelId: 's1' };
  const refB = { gatewayId: 'gw-b', profile: 'default', channel: 'session', channelId: 's1' };
  assert.notEqual(channelKey(refA), channelKey(refB));
  assert.notEqual(
    messageKey(makeMsg(1, { gatewayId: 'gw-a' })),
    messageKey(makeMsg(1, { gatewayId: 'gw-b' })),
  );

  // 群聊跨网关生成完全一致的 __room__ 键
  const roomRefA = { gatewayId: 'gw-a', profile: '', channel: 'room', channelId: 'room-1' };
  const roomRefB = { gatewayId: 'gw-b', profile: '', channel: 'room', channelId: 'room-1' };
  assert.equal(channelKey(roomRefA), channelKey(roomRefB));
  assert.equal(
    messageKey(makeMsg(5, { gatewayId: 'gw-a', profile: '', channel: 'room', channelId: 'room-1' })),
    messageKey(makeMsg(5, { gatewayId: 'gw-b', profile: '', channel: 'room', channelId: 'room-1' })),
  );

  // normalizeCachedMessageRow 自动补全 gatewayId 与可选 authorityEpoch
  const norm = normalizeCachedMessageRow(makeMsg(1), {
    gatewayId: 'gw-norm',
    authorityEpoch: 4,
    profile: 'default',
    channel: 'session',
    channelId: 's1',
  });
  assert.equal(norm.gatewayId, 'gw-norm');
  assert.equal(norm.authorityEpoch, 4);
  const preserveExisting = normalizeCachedMessageRow(
    makeMsg(2, { gatewayId: 'gw-own', authorityEpoch: 9 }),
    { gatewayId: 'gw-other', authorityEpoch: 3, profile: 'default', channel: 'session', channelId: 's1' },
  );
  assert.equal(preserveExisting.gatewayId, 'gw-own');
  assert.equal(preserveExisting.authorityEpoch, 9);
});

test('M1.2: MemoryCacheStore 与 CacheService 5 元组全链路分桶（会话正文、锁、索引独立上限）', async () => {
  const store = new MemoryCacheStore();
  const service = new CacheService(store, { sessionCap: 2, messageCap: 10, now: () => 1_700_000_000_000 });

  const refA = { gatewayId: 'gw-a', profile: 'default', channel: 'session', channelId: 's-shared' };
  const refB = { gatewayId: 'gw-b', profile: 'default', channel: 'session', channelId: 's-shared' };

  // 同 profile/channel/channelId/orderKey 并发写入互不污染
  await Promise.all([
    service.appendRows(refA, [makeMsg(1, { text: 'from-A-1' }), makeMsg(2, { text: 'from-A-2' })]),
    service.appendRows(refB, [makeMsg(1, { text: 'from-B-1' })]),
  ]);

  const openA = await service.openChannel(refA, 10);
  const openB = await service.openChannel(refB, 10);
  assert.deepEqual(
    openA.rows.map((r) => [r.gatewayId, r.text]),
    [
      ['gw-a', 'from-A-2'],
      ['gw-a', 'from-A-1'],
    ],
  );
  assert.deepEqual(
    openB.rows.map((r) => [r.gatewayId, r.text]),
    [['gw-b', 'from-B-1']],
  );

  // applyRemoteWindow 围栏裁剪 A 绝不误伤 B
  await service.applyRemoteWindow(refA, [makeMsg(1, { text: 'from-A-1-remote' })], openA.fenceMax);
  const afterRemoteB = await service.openChannel(refB, 10);
  assert.equal(afterRemoteB.rows.length, 1);
  assert.equal(afterRemoteB.rows[0].text, 'from-B-1');

  // truncate / dropChannel A 不影响 B
  await service.truncate(refA, 0, null);
  assert.equal((await service.openChannel(refA, 10)).rows.length, 0);
  assert.equal((await service.openChannel(refB, 10)).rows.length, 1);

  await service.dropChannel(refB);
  assert.equal((await service.openChannel(refB, 10)).rows.length, 0);

  // 索引分桶：按 gatewayId 读写互不干扰，坏信封仅清除对应网关桶
  await service.writeSessions([makeSummary('sa1', 100), makeSummary('sa2', 200), makeSummary('sa3', 300)], 'gw-a');
  await service.writeSessions([makeSummary('sb1', 50)], 'gw-b');
  assert.deepEqual(
    (await service.readSessions('gw-a')).map((s) => s.id),
    ['sa3', 'sa2'],
  );
  assert.deepEqual(
    (await service.readSessions('gw-b')).map((s) => s.id),
    ['sb1'],
  );

  // 未指定 gatewayId 写混合多网关会话时，按每网关独立 sessionCap=2 裁剪而非全局互相挤死
  const mixedKept = await service.writeSessions([
    makeSummary('a1', 900, { gatewayId: 'gw-a' }),
    makeSummary('a2', 800, { gatewayId: 'gw-a' }),
    makeSummary('a3', 700, { gatewayId: 'gw-a' }),
    makeSummary('b1', 200, { gatewayId: 'gw-b' }),
    makeSummary('b2', 100, { gatewayId: 'gw-b' }),
    makeSummary('g1', 50, { kind: 'group', profile: '' }),
  ]);
  assert.deepEqual(
    mixedKept.map((s) => s.id),
    ['a1', 'a2', 'b1', 'b2', 'g1'],
  );

  // Agents 与 Avatars 分桶隔离
  await service.writeAgents([{ name: 'bot', displayName: 'Bot A', hasAvatar: false, gatewayId: 'gw-a' }], 'gw-a');
  await service.writeAgents([{ name: 'bot', displayName: 'Bot B', hasAvatar: false, gatewayId: 'gw-b' }], 'gw-b');
  assert.equal((await service.readAgents('gw-a'))[0].displayName, 'Bot A');
  assert.equal((await service.readAgents('gw-b'))[0].displayName, 'Bot B');

  await service.writeAvatars({ bot: 'data:image/png;base64,AAA' }, 'gw-a');
  await service.writeAvatars({ bot: 'data:image/png;base64,BBB' }, 'gw-b');
  assert.equal((await service.readAvatars('gw-a')).bot, 'data:image/png;base64,AAA');
  assert.equal((await service.readAvatars('gw-b')).bot, 'data:image/png;base64,BBB');

  // V1 旧信封读出时仅淘汰对应桶，不影响其他网关桶
  await store.writeIndex('sessions:gw-a', { v: 1, savedAt: 0, items: [] });
  assert.deepEqual(await service.readSessions('gw-a'), []);
  assert.equal((await service.readSessions('gw-b'))[0].id, 'sb1');

  await store.writeIndex('avatars:gw-a', { v: 1, savedAt: 0, items: {} });
  assert.deepEqual(await service.readAvatars('gw-a'), {});
  assert.deepEqual(await service.readAvatars('gw-missing'), {});
  assert.equal((await service.readAvatars('gw-b')).bot, 'data:image/png;base64,BBB');
});

test('M1.2: 群聊 __room__ 跨网关主备切换不断档，且拒绝低 authorityEpoch 陈旧覆盖（含持久化重启恢复）', async () => {
  const roomStore = new MemoryCacheStore();
  const service = new CacheService(roomStore);
  const gwARoomRef = {
    gatewayId: 'gw-a',
    profile: '',
    channel: 'room',
    channelId: 'room-federated',
    authorityEpoch: 2,
  };
  const gwBRoomRef = {
    gatewayId: 'gw-b',
    profile: '',
    channel: 'room',
    channelId: 'room-federated',
    authorityEpoch: 1,
  };

  await service.appendRows(gwARoomRef, [
    makeMsg(1, { profile: '', channel: 'room', channelId: 'room-federated', displaySeq: 1, text: 'epoch2-m1' }),
    makeMsg(2, { profile: '', channel: 'room', channelId: 'room-federated', displaySeq: 2, text: 'epoch2-m2' }),
  ]);

  // promote 后由另一节点访问同一 roomId，应直接命中同一 __room__ 桶
  const promotedOpen = await service.openChannel(
    { gatewayId: 'gw-c', profile: '', channel: 'room', channelId: 'room-federated' },
    20,
  );
  assert.equal(promotedOpen.rows.length, 2);
  assert.equal(promotedOpen.rows[0].gatewayId, '__room__');

  // 旧主 gw-b 以陈旧 epoch=1 发起 applyRemoteWindow 或 appendRows，必须被权威代际门拦截
  const staleWindow = await service.applyRemoteWindow(
    gwBRoomRef,
    [makeMsg(1, { profile: '', channel: 'room', channelId: 'room-federated', text: 'stale-m1' })],
    promotedOpen.fenceMax,
  );
  assert.equal(staleWindow.rows.length, 2);
  assert.equal(staleWindow.rows[0].text, 'epoch2-m2');
  assert.deepEqual(staleWindow.evictedKeys, []);

  const staleAppend = await service.appendRows(gwBRoomRef, [
    makeMsg(3, { profile: '', channel: 'room', channelId: 'room-federated', text: 'stale-m3' }),
  ]);
  assert.equal(staleAppend.written, 0);

  // 新权威 gw-c 携带更高 epoch=3 可正常推进并落盘
  const freshRoomRef = {
    gatewayId: 'gw-c',
    profile: '',
    channel: 'room',
    channelId: 'room-federated',
    authorityEpoch: 3,
  };
  const freshAppend = await service.appendRows(freshRoomRef, [
    makeMsg(3, { profile: '', channel: 'room', channelId: 'room-federated', text: 'epoch3-m3' }),
  ]);
  assert.equal(freshAppend.written, 1);

  const afterFresh = await service.openChannel(freshRoomRef, 20);
  assert.equal(afterFresh.rows.length, 3);
  assert.equal(afterFresh.rows[0].authorityEpoch, 3);

  // 重建全新 CacheService（模拟重启后内存 roomAuthorityEpochs 已清空），仍应从持久行读出 known=3 拦截 epoch=2
  const restartedService = new CacheService(roomStore);
  const staleAfterRestart = await restartedService.applyRemoteWindow(
    gwARoomRef,
    [makeMsg(1, { profile: '', channel: 'room', channelId: 'room-federated', text: 'demoted-epoch2' })],
    afterFresh.fenceMax,
  );
  assert.equal(staleAfterRestart.rows.length, 3);
  assert.equal(staleAfterRestart.rows[0].text, 'epoch3-m3');
});
