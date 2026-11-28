/**
 * M1.3 多网关并发池与聚合器形式化安全不变量证明（Property-Based Testing via fast-check）
 * (packages/core/__tests__/formal/multi-gateway-formal.test.mjs)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import {
  GatewayConnectionPool,
  aggregateMultiGatewaySnapshots,
  resolveAggregateTitlebarStatus,
  RPC_SOCKET_READY_STATE,
} from '../../dist/index.js';

function createDeterministicSocketFactory() {
  return () => ({
    readyState: RPC_SOCKET_READY_STATE.OPEN,
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null,
    send() {},
    close() {},
  });
}

test('INV-MULTIGW-01: 多网关运行时 Slot 操作严格物理隔离，断开/写入任意 Slot 绝不污染其余 Slot', () => {
  fc.assert(
    fc.property(
      fc.uniqueArray(fc.stringMatching(/^[a-z0-9-]{2,8}$/), { minLength: 2, maxLength: 5 }),
      fc.uniqueArray(fc.stringMatching(/^s-[a-z0-9]{2,6}$/), { minLength: 2, maxLength: 5 }),
      fc.integer({ min: 0, max: 100 }),
      (gwIds, sessIds, pickIdx) => {
        const pool = new GatewayConnectionPool({
          socketFactory: createDeterministicSocketFactory(),
          enableHeartbeat: false,
          enableLifecycleWake: false,
        });
        try {
          for (const id of gwIds) {
            pool.addGateway({ id, name: id, url: `http://${id}.local:8642` });
          }

          const victimIdx = pickIdx % gwIds.length;
          const victimId = gwIds[victimIdx];

          for (let i = 0; i < gwIds.length; i += 1) {
            const slot = pool.getSlot(gwIds[i]);
            assert.ok(slot);
            for (const sid of sessIds) {
              slot.runningSessionIds.add(sid);
              slot.sessionHandleRegistry.register({ liveId: `live-${i}-${sid}`, storedId: sid });
            }
          }

          // Disconnecting victim slot must wipe ONLY victim's state
          pool.disconnectGateway(victimId, true);
          assert.equal(pool.getSlot(victimId)?.runningSessionIds.size, 0);
          for (let i = 0; i < gwIds.length; i += 1) {
            if (i === victimIdx) continue;
            const survivor = pool.getSlot(gwIds[i]);
            assert.equal(survivor?.runningSessionIds.size, sessIds.length);
            for (const sid of sessIds) {
              assert.equal(survivor?.sessionHandleRegistry.getRegisteredLiveId(sid), `live-${i}-${sid}`);
            }
          }
        } finally {
          pool.disconnectAll(true);
        }
      },
    ),
    { numRuns: 100 },
  );
});

test('INV-MULTIGW-02: 跨网关 Room 去重满足输入排列无关性与最高 authorityEpoch 胜出', () => {
  const sliceSpecArb = fc.record({
    gatewayId: fc.constantFrom('gw-a', 'gw-b', 'gw-c', 'gw-d'),
    epoch: fc.integer({ min: 1, max: 50 }),
    updatedAt: fc.integer({ min: 1000, max: 9999 }),
    offline: fc.boolean(),
    roomId: fc.constantFrom('room-1', 'room-2'),
  });

  fc.assert(
    fc.property(
      fc.uniqueArray(sliceSpecArb, { selector: (s) => s.gatewayId, minLength: 2, maxLength: 4 }),
      (specs) => {
        const toSlices = (list) =>
          list.map((sp) => ({
            gatewayId: sp.gatewayId,
            name: sp.gatewayId,
            url: `http://${sp.gatewayId}.local:8642`,
            installId: `inst-${sp.gatewayId}`,
            fingerprint: `fp-${sp.gatewayId}`,
            connected: !sp.offline,
            offline: sp.offline,
            profiles: [{ name: 'default', displayName: 'Default', isDefault: true, timestamp: sp.updatedAt }],
            sessions: [],
            groups: [
              {
                roomId: sp.roomId,
                name: `Room-${sp.gatewayId}-ep${sp.epoch}`,
                members: ['default', 'helper'],
                createdAt: 100,
                updatedAt: sp.updatedAt,
                authorityGatewayId: sp.gatewayId,
                authorityEpoch: sp.epoch,
              },
            ],
          }));

        const forward = aggregateMultiGatewaySnapshots(toSlices(specs));
        const reversed = aggregateMultiGatewaySnapshots(toSlices([...specs].reverse()));

        assert.deepEqual(
          forward.groups.map((g) => ({ roomId: g.roomId, gatewayId: g.gatewayId, authorityEpoch: g.authorityEpoch })),
          reversed.groups.map((g) => ({ roomId: g.roomId, gatewayId: g.gatewayId, authorityEpoch: g.authorityEpoch })),
        );

        for (const group of forward.groups) {
          const peers = specs.filter((s) => s.roomId === group.roomId);
          const maxEpoch = Math.max(...peers.map((s) => s.epoch));
          assert.equal(group.authorityEpoch, maxEpoch);
        }
      },
    ),
    { numRuns: 150 },
  );
});

test('INV-MULTIGW-03: Clone 碰撞（同 installId + 异 fingerprint）严格隔离不合并；同源重复（同 fingerprint）安全去重；Titlebar 健康聚合单调保真', () => {
  fc.assert(
    fc.property(
      fc.boolean(),
      fc.array(
        fc.record({
          connected: fc.boolean(),
          syncing: fc.boolean(),
          reconnecting: fc.boolean(),
        }),
        { minLength: 2, maxLength: 5 },
      ),
      (sameFingerprint, statuses) => {
        const view = aggregateMultiGatewaySnapshots([
          {
            gatewayId: 'gw-1',
            name: 'Node 1',
            url: 'http://10.0.0.1:8642',
            installId: 'shared-install',
            fingerprint: 'fp-alpha',
            connected: true,
            profiles: [{ name: 'default', displayName: 'D1', isDefault: true }],
            sessions: [],
            groups: [],
          },
          {
            gatewayId: 'gw-2',
            name: 'Node 2',
            url: 'http://10.0.0.2:8642',
            installId: 'shared-install',
            fingerprint: sameFingerprint ? 'fp-alpha' : 'fp-beta',
            connected: true,
            profiles: [{ name: 'default', displayName: 'D2', isDefault: true }],
            sessions: [],
            groups: [],
          },
        ]);

        if (sameFingerprint) {
          assert.equal(view.effectiveGatewayCount, 1);
          assert.equal(view.collisions[0]?.kind, 'duplicate-gateway');
          assert.equal(view.profiles.length, 1);
        } else {
          assert.equal(view.effectiveGatewayCount, 2);
          assert.equal(view.collisions[0]?.kind, 'clone-collision');
          assert.equal(view.profiles.length, 2);
        }

        const slotHealths = statuses.map((s) => ({
          connected: s.connected,
          status: s.connected ? (s.syncing ? 'syncing' : 'connected') : s.reconnecting ? 'reconnecting' : 'offline',
        }));
        const agg = resolveAggregateTitlebarStatus(slotHealths);
        const online = slotHealths.filter((s) => s.connected).length;
        if (online > 0 && online < slotHealths.length) {
          assert.equal(agg, 'partial');
        } else if (online === slotHealths.length) {
          assert.ok(agg === 'connected' || agg === 'syncing');
        } else {
          assert.ok(agg === 'reconnecting' || agg === 'offline');
        }
      },
    ),
    { numRuns: 100 },
  );
});
