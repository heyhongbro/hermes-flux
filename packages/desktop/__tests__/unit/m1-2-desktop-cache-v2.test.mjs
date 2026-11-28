/**
 * M1.2 DesktopCacheStore (IndexedDB V2 5 元组升级) 与 DesktopCacheBridge 分桶队列单元测试
 * (packages/desktop/__tests__/unit/m1-2-desktop-cache-v2.test.mjs)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CACHE_SCHEMA_VERSION,
  DEFAULT_CACHE_GATEWAY_ID,
  ROOM_CACHE_GATEWAY_ID,
  CacheService,
} from '@hermes-flux/core';
import {
  DESKTOP_CACHE_DB_VERSION,
  MESSAGE_KEY_PATH,
  DesktopCacheStore,
} from '../../dist/renderer/cache/DesktopCacheStore.mjs';
import {
  IndexWriteQueue,
  toCachedSession,
  toCachedGroup,
  toCachedMessage,
  persistSessionsToCache,
  persistGroupsToCache,
  persistAgentsToCache,
  persistTurnToCache,
} from '../../dist/renderer/cache/desktopCacheBridge.mjs';

function compareKeyTuples(a, b) {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return a.length - b.length;
}

function createFakeIndexedDbEnv(options = {}) {
  const stores = new Map();
  let currentVersion = options.initialVersion ?? 0;
  let deleteStoreCalls = [];
  let createdKeyPaths = [];

  if (options.preseedV1Messages) {
    stores.set('messages', {
      keyPath: ['profile', 'channel', 'channelId', 'orderKey'],
      records: new Map([['legacy-1', { profile: 'default', channel: 'session', channelId: 's1', orderKey: 1, text: 'old-v1' }]]),
    });
  }

  class FakeKeyRange {
    constructor(lower, upper) {
      this.lower = lower;
      this.upper = upper;
    }
    includes(key) {
      return compareKeyTuples(key, this.lower) >= 0 && compareKeyTuples(key, this.upper) <= 0;
    }
    static bound(lower, upper) {
      return new FakeKeyRange(lower, upper);
    }
  }

  function makeDb() {
    return {
      objectStoreNames: {
        contains: (name) => stores.has(name),
      },
      deleteObjectStore: (name) => {
        deleteStoreCalls.push(name);
        stores.delete(name);
      },
      createObjectStore: (name, cfg) => {
        createdKeyPaths.push({ name, keyPath: [...cfg.keyPath] });
        stores.set(name, { keyPath: [...cfg.keyPath], records: new Map() });
        return {};
      },
      transaction: (storeName) => {
        const tx = { oncomplete: null, onerror: null, onabort: null };
        let pendingOps = 0;
        let finished = false;
        const maybeComplete = () => {
          queueMicrotask(() => {
            if (!finished && pendingOps === 0) {
              finished = true;
              tx.oncomplete?.();
            }
          });
        };
        tx.objectStore = () => {
          const table = stores.get(storeName);
          return {
            put(value) {
              const keyTuple = table.keyPath.map((field) => {
                if (value[field] === undefined || value[field] === null) {
                  throw new Error(`DataError: missing keyPath field "${field}"`);
                }
                return value[field];
              });
              table.records.set(JSON.stringify(keyTuple), { key: keyTuple, value: { ...value } });
              maybeComplete();
            },
            delete(keyTuple) {
              table.records.delete(JSON.stringify(keyTuple));
              maybeComplete();
            },
            count(range) {
              pendingOps += 1;
              const req = { result: 0, onsuccess: null, onerror: null };
              queueMicrotask(() => {
                let cnt = 0;
                for (const entry of table.records.values()) {
                  if (!range || range.includes(entry.key)) cnt += 1;
                }
                req.result = cnt;
                pendingOps -= 1;
                req.onsuccess?.();
                maybeComplete();
              });
              return req;
            },
            openCursor(range, direction = 'next') {
              pendingOps += 1;
              const req = { result: null, onsuccess: null, onerror: null };
              const matching = [...table.records.entries()]
                .filter(([, entry]) => !range || range.includes(entry.key))
                .sort((a, b) =>
                  direction === 'prev'
                    ? compareKeyTuples(b[1].key, a[1].key)
                    : compareKeyTuples(a[1].key, b[1].key),
                );
              let idx = 0;
              const emitNext = () => {
                queueMicrotask(() => {
                  if (idx >= matching.length) {
                    req.result = null;
                    pendingOps -= 1;
                    req.onsuccess?.();
                    maybeComplete();
                    return;
                  }
                  const [serialized, entry] = matching[idx];
                  idx += 1;
                  req.result = {
                    primaryKey: entry.key,
                    value: entry.value,
                    continue: emitNext,
                    delete: () => {
                      table.records.delete(serialized);
                    },
                  };
                  req.onsuccess?.();
                });
              };
              emitNext();
              return req;
            },
          };
        };
        maybeComplete();
        return tx;
      },
    };
  }

  const fakeIndexedDB = {
    open(_name, version) {
      const req = { result: makeDb(), onupgradeneeded: null, onsuccess: null, onerror: null };
      queueMicrotask(() => {
        if (version > currentVersion) {
          currentVersion = version;
          req.onupgradeneeded?.();
        }
        req.onsuccess?.();
      });
      return req;
    },
  };

  return { fakeIndexedDB, FakeKeyRange, stores, deleteStoreCalls, createdKeyPaths };
}

test('M1.2: DesktopCacheStore V1 -> V2 升级重建 5 元组表与多网关物理隔离全路径', async () => {
  assert.equal(DESKTOP_CACHE_DB_VERSION, 2);
  assert.deepEqual(MESSAGE_KEY_PATH, ['gatewayId', 'profile', 'channel', 'channelId', 'orderKey']);

  const savedIdb = globalThis.indexedDB;
  const savedKeyRange = globalThis.IDBKeyRange;
  const savedStorage = globalThis.localStorage;
  const hadIdb = 'indexedDB' in globalThis;
  const hadKeyRange = 'IDBKeyRange' in globalThis;
  const hadStorage = 'localStorage' in globalThis;

  try {
    // 1. V1 -> V2 升级：必须显式删除旧 messages 表并建 V2 5 元组主键
    const v1Env = createFakeIndexedDbEnv({ initialVersion: 1, preseedV1Messages: true });
    globalThis.indexedDB = v1Env.fakeIndexedDB;
    globalThis.IDBKeyRange = v1Env.FakeKeyRange;

    const lsMap = new Map();
    globalThis.localStorage = {
      getItem: (k) => lsMap.get(k) ?? null,
      setItem: (k, v) => lsMap.set(k, v),
      removeItem: (k) => lsMap.delete(k),
    };

    const store = new DesktopCacheStore();
    await store.putMessages([]); // empty fast path
    await store.putMessages([
      { profile: 'default', channel: 'session', channelId: 's1', orderKey: 1, role: 'user', text: 'default-1', timestamp: 10, status: 'complete' },
      { gatewayId: 'gw-a', profile: 'default', channel: 'session', channelId: 's1', orderKey: 1, role: 'user', text: 'gwA-1', timestamp: 20, status: 'complete' },
      { gatewayId: 'gw-a', profile: 'default', channel: 'session', channelId: 's1', orderKey: 2, role: 'assistant', text: 'gwA-2', timestamp: 30, status: 'complete' },
      { gatewayId: 'gw-a', profile: 'default', channel: 'session', channelId: 's1', orderKey: 3, role: 'user', text: 'gwA-3', timestamp: 40, status: 'complete' },
      { gatewayId: 'gw-b', profile: 'default', channel: 'session', channelId: 's1', orderKey: 1, role: 'user', text: 'gwB-1', timestamp: 50, status: 'complete' },
      { profile: '', channel: 'room', channelId: 'rm-1', orderKey: 5, role: 'assistant', text: 'room-msg', timestamp: 60, status: 'complete' },
    ]);

    assert.deepEqual(v1Env.deleteStoreCalls, ['messages']);
    assert.deepEqual(v1Env.createdKeyPaths, [{ name: 'messages', keyPath: ['gatewayId', 'profile', 'channel', 'channelId', 'orderKey'] }]);

    // 同 profile/channelId 下按 gatewayId 物理隔离读取
    const listDefault = await store.listMessages({ profile: 'default', channel: 'session', channelId: 's1', limit: 10 });
    assert.deepEqual(listDefault.map((r) => [r.gatewayId, r.text]), [['__default__', 'default-1']]);

    const listA = await store.listMessages({ gatewayId: 'gw-a', profile: 'default', channel: 'session', channelId: 's1', limit: 2, beforeOrderKey: 3 });
    assert.deepEqual(listA.map((r) => r.orderKey), [2, 1]);

    assert.deepEqual(await store.listMessages({ gatewayId: 'gw-a', profile: 'default', channel: 'session', channelId: 's1', limit: 0 }), []);

    const listRoomViaB = await store.listMessages({ gatewayId: 'gw-b', profile: '', channel: 'room', channelId: 'rm-1', limit: 10 });
    assert.deepEqual(listRoomViaB.map((r) => [r.gatewayId, r.text]), [['__room__', 'room-msg']]);

    // trimChannel / deleteMessages / dropChannel 仅影响目标 gateway
    assert.equal(await store.countMessages({ gatewayId: 'gw-a', profile: 'default', channel: 'session', channelId: 's1' }), 3);
    assert.equal(await store.trimChannel({ gatewayId: 'gw-a', profile: 'default', channel: 'session', channelId: 's1' }, 5), 0);
    assert.equal(await store.trimChannel({ gatewayId: 'gw-a', profile: 'default', channel: 'session', channelId: 's1' }, 2), 1);
    assert.equal(await store.deleteMessages({ gatewayId: 'gw-a', profile: 'default', channel: 'session', channelId: 's1', aboveOrderKey: 2 }), 1);
    assert.equal(await store.dropChannel({ gatewayId: 'gw-a', profile: 'default', channel: 'session', channelId: 's1' }), 1);
    assert.equal(await store.dropChannel({ gatewayId: 'gw-a', profile: 'default', channel: 'session', channelId: 's1' }), 0);

    // gw-b 完全不受 gw-a 删除影响
    assert.equal(await store.countMessages({ gatewayId: 'gw-b', profile: 'default', channel: 'session', channelId: 's1' }), 1);

    // 分桶索引读写与 localStorage 异常降级内存路径
    await store.writeIndex('sessions:gw-a', { v: CACHE_SCHEMA_VERSION, items: ['a'] });
    await store.writeIndex('sessions:gw-b', { v: CACHE_SCHEMA_VERSION, items: ['b'] });
    assert.deepEqual((await store.readIndex('sessions:gw-a')).items, ['a']);
    assert.deepEqual((await store.readIndex('sessions:gw-b')).items, ['b']);
    await store.removeIndex('sessions:gw-a');
    assert.equal(await store.readIndex('sessions:gw-a'), null);

    // 2. 全新空白库首次创建不调用 deleteObjectStore
    const freshEnv = createFakeIndexedDbEnv({ initialVersion: 0, preseedV1Messages: false });
    globalThis.indexedDB = freshEnv.fakeIndexedDB;
    const freshStore = new DesktopCacheStore();
    await freshStore.countMessages({ gatewayId: 'gw-x', profile: 'default', channel: 'session', channelId: 's' });
    assert.deepEqual(freshEnv.deleteStoreCalls, []);
    assert.deepEqual(freshEnv.createdKeyPaths, [{ name: 'messages', keyPath: ['gatewayId', 'profile', 'channel', 'channelId', 'orderKey'] }]);
  } finally {
    if (hadIdb) globalThis.indexedDB = savedIdb;
    else delete globalThis.indexedDB;
    if (hadKeyRange) globalThis.IDBKeyRange = savedKeyRange;
    else delete globalThis.IDBKeyRange;
    if (hadStorage) globalThis.localStorage = savedStorage;
    else delete globalThis.localStorage;
  }
});

test('M1.2: desktopCacheBridge IndexWriteQueue 按网关分桶并发且持久化函数透传 gatewayId / __room__', async () => {
  const queue = new IndexWriteQueue();
  const order = [];
  let releaseGwA;
  const gwABlocker = new Promise((r) => {
    releaseGwA = r;
  });

  // 即使 gw-a 的写任务在等待，gw-b 的写任务绝不得被阻塞
  const pA1 = new Promise((res) => {
    queue.enqueue(async () => {
      await gwABlocker;
      order.push('a1');
      res();
    }, 'gw-a');
  });
  const pA2 = new Promise((res) => {
    queue.enqueue(async () => {
      order.push('a2');
      res();
    }, 'gw-a');
  });
  await new Promise((res) => {
    queue.enqueue(async () => {
      order.push('b1');
      res();
    }, 'gw-b');
  });

  assert.deepEqual(order, ['b1']);
  releaseGwA();
  await Promise.all([pA1, pA2]);
  assert.deepEqual(order, ['b1', 'a1', 'a2']);

  // gatewayId 透传检查
  const sess = toCachedSession({ id: 's1', title: 't', model: '', time: '', preview: '', timestamp: 10 }, 'default', 'gw-1');
  assert.equal(sess.gatewayId, 'gw-1');

  const grp = toCachedGroup({ roomId: 'r1', name: 'Room', members: [], createdAt: 10 });
  assert.equal(grp.gatewayId, ROOM_CACHE_GATEWAY_ID);

  const msg = toCachedMessage(
    { id: 'row-9', rowId: 9, role: 'user', content: 'hi' },
    { gatewayId: 'gw-1', profile: 'default', channel: 'session', channelId: 's1' },
  );
  assert.equal(msg.gatewayId, 'gw-1');

  // persistSessionsToCache / persistGroupsToCache / persistAgentsToCache / persistTurnToCache
  const memStore = new (await import('@hermes-flux/core')).MemoryCacheStore();
  const svc = new CacheService(memStore);

  await new Promise((res) => {
    const q = new IndexWriteQueue();
    persistSessionsToCache([{ id: 's1', title: 'S1', model: '', time: '', preview: '', timestamp: 10 }], svc, 'default', q, 'gw-1');
    persistGroupsToCache([{ roomId: 'rm1', name: 'RM', members: [], createdAt: 20 }], svc, q, 'gw-1');
    // 同步验证缺省 gatewayId（单网关向后兼容模式）
    persistGroupsToCache([{ roomId: 'rm-legacy', name: 'RML', members: [], createdAt: 21 }], svc, q);
    q.enqueue(async () => res(), 'gw-1');
  });
  // Flush __room__ and default buckets as well
  await new Promise((res) => {
    const check = async () => {
      const rooms = await svc.readSessions(ROOM_CACHE_GATEWAY_ID);
      const legacy = await svc.readSessions();
      if (rooms.length > 0 && legacy.some((s) => s.id === 'rm-legacy')) return res();
      queueMicrotask(check);
    };
    queueMicrotask(check);
  });

  const gw1Sessions = await svc.readSessions('gw-1');
  assert.equal(gw1Sessions.map((s) => s.id).includes('s1'), true);
  assert.equal((await svc.readSessions(ROOM_CACHE_GATEWAY_ID)).map((s) => s.id).includes('rm1'), true);

  persistAgentsToCache([{ name: 'bot', displayName: 'B', hasAvatar: false }], svc, 'gw-1');
  persistAgentsToCache([{ name: 'legacy-bot', displayName: 'LB', hasAvatar: false }], svc);
  await new Promise((r) => queueMicrotask(r));
  const gw1Agents = await svc.readAgents('gw-1');
  assert.equal(gw1Agents[0].gatewayId, 'gw-1');
  const legacyAgents = await svc.readAgents();
  assert.equal(legacyAgents[0].gatewayId, undefined);

  persistTurnToCache('s1', 'bot', [{ id: 'row-12', rowId: 12, role: 'assistant', content: 'ok' }], svc, false, 'default', 'gw-1');
  await new Promise((r) => queueMicrotask(r));
  const openedTurn = await svc.openChannel({ gatewayId: 'gw-1', profile: 'bot', channel: 'session', channelId: 's1' }, 10);
  assert.equal(openedTurn.rows.length, 1);
  assert.equal(openedTurn.rows[0].gatewayId, 'gw-1');

  assert.equal(DEFAULT_CACHE_GATEWAY_ID, '__default__');
});
