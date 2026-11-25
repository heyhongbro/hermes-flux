/**
 * 动态心跳滑动看门狗 (SlidingActiveWatchdog) 行为与时序测试
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { SlidingActiveWatchdog } from '../../dist/turn/slidingWatchdog.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('SlidingActiveWatchdog Unit & Timing Tests', async (t) => {
  await t.test('1. arm 后进入 armed 状态，disarm 优雅关闭', () => {
    let timeoutReason = null;
    const watchdog = new SlidingActiveWatchdog({
      idleTimeoutMs: 100,
      onTimeout: (r) => { timeoutReason = r; },
    });

    assert.equal(watchdog.getState(), 'idle');
    assert.equal(watchdog.getElapsedMs(), 0);
    assert.equal(watchdog.getIdleElapsedMs(), 0);
    assert.equal(watchdog.feed(), false, '未 armed 状态下喂狗返回 false');

    watchdog.arm();
    assert.equal(watchdog.getState(), 'armed');
    assert.ok(watchdog.getElapsedMs() >= 0);
    assert.ok(watchdog.getIdleElapsedMs() >= 0);

    watchdog.disarm();
    assert.equal(watchdog.getState(), 'disarmed');
    assert.equal(timeoutReason, null);
  });

  await t.test('2. 静默超时触发 inactivity 熔断', async () => {
    let timeoutReason = null;
    const watchdog = new SlidingActiveWatchdog({
      idleTimeoutMs: 50,
      hardLimitMs: 500,
      throttleMs: 10,
      onTimeout: (r) => { timeoutReason = r; },
    });

    watchdog.arm();
    await sleep(80);

    assert.equal(watchdog.getState(), 'expired');
    assert.equal(timeoutReason, 'inactivity');
    assert.equal(watchdog.feed(), false, '已 expired 状态下喂狗返回 false');
  });

  await t.test('3. 持续活跃喂狗可连续续期不中断（含 throttle 节流分支覆盖）', async () => {
    let timeoutReason = null;
    const watchdog = new SlidingActiveWatchdog({
      idleTimeoutMs: 60,
      hardLimitMs: 500,
      throttleMs: 30, // 30ms 节流
      onTimeout: (r) => { timeoutReason = r; },
    });

    watchdog.arm();
    // 连续两次立即喂狗，命中 throttleMs 分支
    const feed1 = watchdog.feed();
    const feed2 = watchdog.feed();
    assert.equal(feed1, true);
    assert.equal(feed2, true);

    // 每 20ms 喂一次狗，持续 120ms (远超过 60ms 的单次超时)
    for (let i = 0; i < 4; i++) {
      await sleep(20);
      watchdog.feed();
      assert.equal(watchdog.getState(), 'armed');
    }

    assert.equal(timeoutReason, null, '喂狗保活期间不得超时');
    watchdog.disarm();
  });

  await t.test('4. 达到绝对硬上限时强制触发 hard-limit 熔断', async () => {
    let timeoutReason = null;
    const watchdog = new SlidingActiveWatchdog({
      idleTimeoutMs: 60,
      hardLimitMs: 100, // 100ms 硬上限
      throttleMs: 10,
      onTimeout: (r) => { timeoutReason = r; },
    });

    watchdog.arm();
    // 即使一直喂狗，超过 100ms 也必须被硬上限熔断
    for (let i = 0; i < 6; i++) {
      await sleep(20);
      watchdog.feed();
    }

    assert.equal(watchdog.getState(), 'expired');
    assert.equal(timeoutReason, 'hard-limit');
  });

  await t.test('5. 默认参数构造与跨端定时器解耦', () => {
    const watchdog = new SlidingActiveWatchdog({
      onTimeout: () => {},
    });
    assert.equal(watchdog.getState(), 'idle');
    watchdog.arm();
    assert.equal(watchdog.getState(), 'armed');
    watchdog.disarm();
  });

  await t.test('6. 完整参数构造、防御性分支与异常容忍覆盖', () => {
    // 覆盖全量参数传入与极限边界 (53, 54, 55, 56)
    let mockTime = 100000;
    const watchdog = new SlidingActiveWatchdog({
      idleTimeoutMs: 200,
      hardLimitMs: 400,
      throttleMs: 50,
      now: () => ++mockTime,
      onTimeout: () => {},
    });
    assert.equal(watchdog.getState(), 'idle');
    watchdog.arm();
    assert.equal(watchdog.getState(), 'armed');
    assert.ok(watchdog.getElapsedMs() >= 0);

    // 覆盖 disarm 后的 handleTimeout (state !== 'armed')
    watchdog.disarm();
    Reflect.get(watchdog, 'handleTimeout').call(watchdog, 'inactivity');
    assert.equal(watchdog.getState(), 'disarmed');

    // 覆盖边界越界三元分支 (idle < 10, hard < idle, throttle < 0)
    const clampedWatchdog = new SlidingActiveWatchdog({
      idleTimeoutMs: -10,
      hardLimitMs: -50,
      throttleMs: -5,
      now: null,
      onTimeout: () => {},
    });
    assert.equal(clampedWatchdog.getState(), 'idle');
    clampedWatchdog.arm();
    assert.equal(clampedWatchdog.getState(), 'armed');

    // 覆盖 safeUnref 的各级容忍分支
    const safeUnref = Reflect.get(watchdog, 'safeUnref').bind(watchdog);
    safeUnref(null);
    safeUnref({});
    safeUnref({ unref: () => {} });
    assert.doesNotThrow(() => {
      safeUnref({
        unref() {
          throw new Error('mock unref error');
        },
      });
    });
  });
});

test('SlidingActiveWatchdog.renewIdle: idle/disarmed 不复活，armed/expired 受 hardLimitMs 封顶续期', () => {
  let now = 50_000;
  const reasons = [];
  const wd = new SlidingActiveWatchdog({
    idleTimeoutMs: 1_000,
    hardLimitMs: 5_000,
    throttleMs: 100,
    now: () => now,
    onTimeout: (r) => reasons.push(r),
  });

  // idle 态禁止续期
  assert.equal(wd.renewIdle(), false);
  assert.equal(wd.getState(), 'idle');

  wd.arm();
  assert.equal(wd.getElapsedMs(), 0);

  // 未超时 armed 态续期成功且保留总运行起点（elapsed 不清零，idleElapsed 归零）
  now += 600;
  assert.equal(wd.renewIdle(), true);
  assert.equal(wd.getState(), 'armed');
  assert.equal(wd.getElapsedMs(), 600);
  assert.equal(wd.getIdleElapsedMs(), 0);

  // 触发 hard-limit 时即使调用 renewIdle 也必须拒绝并停机
  now = 55_000;
  assert.equal(wd.renewIdle(), false);

  // 撤防后绝不可被 renewIdle 复活
  wd.disarm();
  assert.equal(wd.getState(), 'disarmed');
  assert.equal(wd.renewIdle(), false);
  assert.equal(wd.getState(), 'disarmed');
});


test('SlidingActiveWatchdog.renewIdle: expired (inactivity) 在未达 hardLimitMs 时可续期复活为 armed', async () => {
  const reasons = [];
  const wd = new SlidingActiveWatchdog({
    idleTimeoutMs: 25,
    hardLimitMs: 500,
    throttleMs: 5,
    onTimeout: (r) => reasons.push(r),
  });

  wd.arm();
  await sleep(55);
  assert.equal(wd.getState(), 'expired');
  assert.deepEqual(reasons, ['inactivity']);

  assert.equal(wd.renewIdle(), true, 'expired 态未超 hardLimitMs 时 renewIdle 必须允许续期');
  assert.equal(wd.getState(), 'armed');
  assert.ok(wd.getElapsedMs() >= 40, 'renewIdle 不得重置累计运行时长起点');
  wd.disarm();
});

test('SlidingActiveWatchdog.renewIdle: 续期后越过 hardLimitMs 时硬上限定时器必须触发 hard-limit 熔断', async () => {
  const reasons = [];
  const wd = new SlidingActiveWatchdog({
    idleTimeoutMs: 50,
    hardLimitMs: 130,
    throttleMs: 5,
    onTimeout: (r) => reasons.push(r),
  });

  wd.arm();
  await sleep(70);
  assert.deepEqual(reasons, ['inactivity']);
  assert.equal(wd.renewIdle(), true);
  assert.equal(wd.getState(), 'armed');

  // 单次 feed 即将 renewed idleTimer 推迟到 hardLimitMs (130ms) 之后，验证 hardTimer 精确触发
  await sleep(20);
  assert.equal(wd.feed(), true);

  await sleep(70);
  assert.deepEqual(reasons, ['inactivity', 'hard-limit']);
  assert.equal(wd.getState(), 'expired');
  wd.disarm();
});

test('SlidingActiveWatchdog 确定性时钟与定时器变异全消杀：默认上限/节流边界/清理句柄/unref/renewIdle 封顶与过期回调', () => {
  const origSetTimeout = globalThis.setTimeout;
  const origClearTimeout = globalThis.clearTimeout;
  let nextTimerId = 1;
  const activeTimers = new Map();
  const clearedIds = [];
  let unrefCount = 0;
  let unrefMode = 'count'; // 'count' | 'throw' | 'none'

  globalThis.setTimeout = (fn, delay) => {
    const id = nextTimerId++;
    const handle = { id, fn, delay };
    if (unrefMode === 'count') {
      handle.unref = () => { unrefCount += 1; };
    } else if (unrefMode === 'throw') {
      handle.unref = () => { throw new Error('no unref in browser'); };
    }
    activeTimers.set(id, handle);
    return handle;
  };
  globalThis.clearTimeout = (handle) => {
    if (handle && typeof handle === 'object' && 'id' in handle) {
      clearedIds.push(handle.id);
      activeTimers.delete(handle.id);
    }
  };

  try {
    // 1. 默认配置 hardLimitMs 必须保持 30 * 60_000 (1_800_000) 并执行 safeUnref
    const wdDef = new SlidingActiveWatchdog({ onTimeout: () => {} });
    wdDef.arm();
    const defDelays = [...activeTimers.values()].map((t) => t.delay);
    assert.deepEqual(defDelays, [60_000, 30 * 60_000]);
    assert.equal(unrefCount, 2);
    wdDef.disarm();
    assert.equal(activeTimers.size, 0, 'disarm 必须清空全部定时器句柄');

    // 2. 确定性时钟验证：重复 arm 清理旧定时器、throttle 严格 `<` 边界、时钟倒流 clamp 与 非 armed idleElapsedMs
    let now = 10_000;
    const firedReasons = [];
    const wd = new SlidingActiveWatchdog({
      idleTimeoutMs: 500,
      hardLimitMs: 1_000,
      throttleMs: 50,
      now: () => now,
      onTimeout: (r) => firedReasons.push(r),
    });
    assert.equal(wd.getIdleElapsedMs(), 0);

    wd.arm();
    const firstTimerCount = activeTimers.size;
    assert.equal(firstTimerCount, 2);
    const prevIds = [...activeTimers.keys()];
    wd.arm(); // 再次 arm 必须先 disarm 清空上一轮两个定时器
    for (const pid of prevIds) {
      assert.ok(clearedIds.includes(pid), `重复 arm 必须清理旧定时器 #${pid}`);
    }

    // dt = 49 < 50：必须被节流跳过，不得重建 idleTimer
    const beforeThrottleCount = clearedIds.length;
    const idleTimerBefore = [...activeTimers.values()].find((t) => t.delay === 500).id;
    now = 10_049;
    assert.equal(wd.feed(), true);
    assert.equal(clearedIds.length, beforeThrottleCount);

    // dt = 50 === throttleMs：必须精确放行重建 idleTimer 并再次 unref
    const unrefBeforeFeed = unrefCount;
    now = 10_050;
    assert.equal(wd.feed(), true);
    assert.ok(clearedIds.includes(idleTimerBefore));
    assert.equal(unrefCount, unrefBeforeFeed + 1);

    // 时钟微倒流时 getIdleElapsedMs 必须夹紧至 0
    now = 10_040;
    assert.equal(wd.getIdleElapsedMs(), 0);

    // 3. renewIdle 在 remainingHard < idleTimeoutMs 时截断 nextIdleDelay，并直接驱动 inactivity 回调与 unref
    now = 10_850; // elapsed = 850, remainingHard = 150 < idleTimeoutMs(500)
    const preRenewIds = [...activeTimers.keys()];
    const unrefBeforeRenew = unrefCount;
    assert.equal(wd.renewIdle(), true);
    for (const rid of preRenewIds) {
      assert.ok(clearedIds.includes(rid), 'renewIdle 必须先清理旧 timer 避免泄漏');
    }
    assert.equal(unrefCount, unrefBeforeRenew + 2);
    const renewedHandles = [...activeTimers.values()];
    assert.deepEqual(renewedHandles.map((t) => t.delay), [150, 150]);
    // 触发续期后的 idleTimer 回调，精确验证 reason === 'inactivity' 且清空全部定时器
    renewedHandles[0].fn();
    assert.deepEqual(firedReasons, ['inactivity']);
    assert.equal(wd.getState(), 'expired');
    assert.equal(wd.getIdleElapsedMs(), 0);
    assert.equal(activeTimers.size, 0, 'timeout 触发后必须清空定时器');

    // 4. remainingHard <= 0 时 renewIdle 清理并锁定为 expired（先重新 arm，将 state='armed' 且 clock 越过 hardLimit）
    wd.arm();
    const armedBeforeExpireIds = [...activeTimers.keys()];
    now += 2_000;
    assert.equal(wd.renewIdle(), false);
    for (const eid of armedBeforeExpireIds) {
      assert.ok(clearedIds.includes(eid), 'remainingHard<=0 拒绝续期时必须清理已挂起的定时器');
    }
    assert.equal(wd.getState(), 'expired');
    assert.equal(wd.getIdleElapsedMs(), 0);

    // 5. hardTimer 回调直接触发 hard-limit 并清空定时器
    wd.arm();
    const hardHandle = [...activeTimers.values()].find((t) => t.delay === 1_000);
    hardHandle.fn();
    assert.equal(wd.getState(), 'expired');
    assert.equal(activeTimers.size, 0);

    // 6. safeUnref 对抛错/缺失 unref 句柄在公开 arm()/disarm() 链路下的容忍度
    unrefMode = 'throw';
    wd.arm();
    wd.disarm();
    unrefMode = 'none';
    wd.arm();
    wd.disarm();
    assert.equal(wd.getIdleElapsedMs(), 0);
  } finally {
    globalThis.setTimeout = origSetTimeout;
    globalThis.clearTimeout = origClearTimeout;
  }
});
