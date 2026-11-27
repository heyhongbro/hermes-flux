import test from 'node:test';
import assert from 'node:assert/strict';
import { buildChannelBounds } from '../../dist/index.js';

const REF = { profile: 'default', channel: 'session', channelId: 's1' };

const MAX = Number.MAX_SAFE_INTEGER;

test('buildChannelBounds: full 模式覆盖 [0, MAX]（5 元组默认网关回退 __default__）', () => {
  const bounds = buildChannelBounds(REF, 'full');
  assert.deepEqual(bounds.lower, ['__default__', 'default', 'session', 's1', 0]);
  assert.deepEqual(bounds.upper, ['__default__', 'default', 'session', 's1', MAX]);
});

test('buildChannelBounds: list-before 把上界减一（排除 boundary 本身）', () => {
  const bounds = buildChannelBounds(REF, 'list-before', 10);
  assert.deepEqual(bounds.lower, ['__default__', 'default', 'session', 's1', 0]);
  assert.deepEqual(bounds.upper, ['__default__', 'default', 'session', 's1', 9]);
});

test('buildChannelBounds: delete-above 把下界加一（排除 boundary 本身）', () => {
  const bounds = buildChannelBounds(REF, 'delete-above', 10);
  assert.deepEqual(bounds.lower, ['__default__', 'default', 'session', 's1', 11]);
  assert.deepEqual(bounds.upper, ['__default__', 'default', 'session', 's1', MAX]);
});

test('buildChannelBounds: 缺省 boundary 时退化为全量，不产生越界区间', () => {
  const list = buildChannelBounds(REF, 'list-before');
  const del = buildChannelBounds(REF, 'delete-above');
  assert.deepEqual(list.lower, ['__default__', 'default', 'session', 's1', 0]);
  assert.deepEqual(list.upper, ['__default__', 'default', 'session', 's1', MAX]);
  assert.deepEqual(del.lower, ['__default__', 'default', 'session', 's1', 0]);
  assert.deepEqual(del.upper, ['__default__', 'default', 'session', 's1', MAX]);
});

test('buildChannelBounds: 不同 channelId 的前缀严格隔离', () => {
  const a = buildChannelBounds({ ...REF, channelId: 'a' }, 'full');
  const b = buildChannelBounds({ ...REF, channelId: 'b' }, 'full');
  assert.notDeepEqual(a.lower.slice(0, 4), b.lower.slice(0, 4));
  assert.equal(a.lower[3], 'a');
  assert.equal(b.lower[3], 'b');
});

test('buildChannelBounds: 不同 channel 类型（session / room）前缀隔离且 room 锁定 __room__', () => {
  const s = buildChannelBounds({ ...REF, gatewayId: 'gw-a', channel: 'session' }, 'full');
  const r = buildChannelBounds({ ...REF, gatewayId: 'gw-a', channel: 'room' }, 'full');
  const r2 = buildChannelBounds({ ...REF, gatewayId: 'gw-b', channel: 'room' }, 'full');
  const rNoGw = buildChannelBounds({ ...REF, channel: 'room' }, 'full');
  assert.equal(s.lower[0], 'gw-a');
  assert.equal(s.lower[2], 'session');
  assert.equal(r.lower[0], '__room__');
  assert.equal(r.upper[0], '__room__');
  assert.equal(r.lower[2], 'room');
  assert.deepEqual(r.lower, r2.lower);
  assert.deepEqual(r.lower, rNoGw.lower);
});

test('buildChannelBounds: 不同 gatewayId 即使 profile/channel/channelId 全相同也严格正交', () => {
  const a = buildChannelBounds({ ...REF, gatewayId: 'gw-a' }, 'full');
  const b = buildChannelBounds({ ...REF, gatewayId: 'gw-b' }, 'full');
  assert.equal(a.lower[0], 'gw-a');
  assert.equal(b.lower[0], 'gw-b');
  assert.notDeepEqual(a.lower, b.lower);
  assert.notDeepEqual(a.upper, b.upper);
});

test('buildChannelBounds: 不同 profile 前缀隔离', () => {
  const a = buildChannelBounds({ ...REF, profile: 'default' }, 'full');
  const b = buildChannelBounds({ ...REF, profile: 'aura' }, 'full');
  assert.equal(a.lower[1], 'default');
  assert.equal(b.lower[1], 'aura');
});

test('buildChannelBounds: boundary=0 时 list-before 产生空区间（上界 -1）', () => {
  const bounds = buildChannelBounds(REF, 'list-before', 0);
  assert.equal(bounds.upper[4], -1);
  assert.ok(bounds.upper[4] < bounds.lower[4], '上界应低于下界，形成空区间');
});

test('buildChannelBounds: boundary=MAX 时 delete-above 产生空区间', () => {
  const bounds = buildChannelBounds(REF, 'delete-above', MAX);
  assert.equal(bounds.lower[4], MAX + 1);
  assert.ok(bounds.lower[4] > bounds.upper[4], '下界应高于上界，形成空区间');
});

test('buildChannelBounds: 不修改传入引用对象', () => {
  const ref = { profile: 'default', channel: 'session', channelId: 's1' };
  buildChannelBounds(ref, 'list-before', 5);
  assert.deepEqual(ref, { profile: 'default', channel: 'session', channelId: 's1' });
});
