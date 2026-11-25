/**
 * Streaming Token Render Coalescing Engine 行为与变异杀伤力测试
 *
 * 【测试覆盖与变异杀伤点】
 *   1. 批量同步聚合：多个连续 push 在 flush() 时合流为单次 Map 提交；
 *   2. 思考过程与正文内容正交分流：thought 与 content 各自维护独立缓冲；
 *   3. 默认自适应节奏 (cadence=true)：长于 4 字符的分片按动态步长逐帧吐出；
 *   4. 关闭自适应节奏 (cadence=false)：长文本第一帧全量吐出，不分片；
 *   5. 动态自适应步长数学精确性：Math.max(2, Math.min(len, ceil(len / 6)))；
 *   6. 自动连环驱动：hasRemaining 为 true 时自动 scheduleStep 下一帧，直至消费完毕清空 entry；
 *   7. requestAnimationFrame / cancelAnimationFrame 交互与生命周期防御；
 *   8. clear() 与空 buffer 边界下的防重入与早退保护。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { TokenCoalescer } from '../../dist/coalesce/tokenCoalescer.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('TokenCoalescer Streaming Coalescing Engine Unit & Mutation Tests', async (t) => {
  await t.test('1. Coalescer 缓冲多个 delta 并在显式 flush() 时合并为单批次', () => {
    let flushedBatches = [];
    const coalescer = new TokenCoalescer((batch) => {
      flushedBatches.push(batch);
    });

    coalescer.push({ messageId: 'msg-1', delta: 'Hello ' });
    coalescer.push({ messageId: 'msg-1', delta: 'Hermes ' });
    coalescer.push({ messageId: 'msg-1', delta: 'World!' });

    assert.equal(flushedBatches.length, 0, 'flush 之前不得同步触发提交');

    coalescer.flush();

    assert.equal(flushedBatches.length, 1, '必须产生且仅产生 1 次 flush 提交');
    const msg1 = flushedBatches[0].get('msg-1');
    assert.ok(msg1, '批次必须包含 msg-1');
    assert.equal(msg1.content, 'Hello Hermes World!');
    assert.equal(msg1.thought, '');
  });

  await t.test('2. 独立区分思考串 (thought) 与正式回答 (content)', () => {
    let flushedBatches = [];
    const coalescer = new TokenCoalescer((batch) => {
      flushedBatches.push(batch);
    });

    coalescer.push({ messageId: 'msg-2', delta: 'Step 1... ', isThought: true });
    coalescer.push({ messageId: 'msg-2', delta: 'Step 2.', isThought: true });
    coalescer.push({ messageId: 'msg-2', delta: 'Answer.', isThought: false });

    coalescer.flush();

    assert.equal(flushedBatches.length, 1);
    const msg2 = flushedBatches[0].get('msg-2');
    assert.equal(msg2.thought, 'Step 1... Step 2.');
    assert.equal(msg2.content, 'Answer.');
  });

  await t.test('3. clear() 丢弃缓冲区并取消待执行帧，随后 flush() 不触发任何提交', () => {
    let flushedBatches = [];
    const coalescer = new TokenCoalescer((batch) => {
      flushedBatches.push(batch);
    });

    coalescer.push({ messageId: 'msg-3', delta: 'Discard me' });
    coalescer.clear();
    coalescer.flush();

    assert.equal(flushedBatches.length, 0, 'clear 后 flush 必须为空');
  });

  await t.test('4. 自适应节奏默认值：未传 options 时默认为 cadence=true，长文本逐帧分步吐出', async () => {
    const batches = [];
    // 默认 options，断言 cadence 默认开启
    const coalescer = new TokenCoalescer((batch) => {
      const entry = batch.get('msg-cadence-default');
      if (entry) batches.push(entry.content);
    });

    // 写入 24 个字符（> 4 字符，触发动态 cadence）
    // len=24: ceil(24/6) = 4, Math.max(2, Math.min(24, 4)) = 4
    coalescer.push({ messageId: 'msg-cadence-default', delta: '123456789012345678901234' });

    // 等待 1 帧执行（Node 环境下 setTimeout 16ms 步进）
    await sleep(35);

    assert.ok(batches.length >= 1, '第 1 帧必须吐出第一批数据');
    assert.equal(batches[0], '1234', '第 1 帧必须精确吐出前 4 个字符 (24/6=4)');
    assert.notEqual(batches[0], '123456789012345678901234', '默认 cadence 开启时不得一次性全吐');

    // 清理残余
    coalescer.clear();
  });

  await t.test('5. 关闭自适应节奏 (cadence=false)：长文本在第 1 帧即全量吐出', async () => {
    const batches = [];
    const coalescer = new TokenCoalescer(
      (batch) => {
        const entry = batch.get('msg-no-cadence');
        if (entry) batches.push(entry.content);
      },
      { cadence: false }
    );

    coalescer.push({ messageId: 'msg-no-cadence', delta: '12345678901234567890' });

    await sleep(35);

    assert.equal(batches.length, 1, '关闭 cadence 时第 1 帧必须一次性吐完全部');
    assert.equal(batches[0], '12345678901234567890');
    coalescer.clear();
  });

  await t.test('6. 动态步长数学精确性与多帧连续自驱动 (hasRemaining 循环)', async () => {
    const frames = [];
    const coalescer = new TokenCoalescer(
      (batch) => {
        const entry = batch.get('msg-math');
        if (entry) frames.push(entry.content);
      },
      { cadence: true }
    );

    // 写入 18 字符:
    // Frame 1: len=18, ceil(18/6)=3 -> stepSize=3. 吐出 3 字符，剩余 15
    // Frame 2: len=15, ceil(15/6)=3 -> stepSize=3. 吐出 3 字符，剩余 12
    // Frame 3: len=12, ceil(12/6)=2 -> stepSize=2. 吐出 2 字符，剩余 10
    coalescer.push({ messageId: 'msg-math', delta: 'abcdefghijklmnopqr' });

    // 轮询等待多帧自驱动调度消费完毕（最长 400ms）
    const start = Date.now();
    while (frames.join('').length < 18 && Date.now() - start < 400) {
      await sleep(25);
    }

    const reconstructed = frames.join('');
    assert.equal(reconstructed, 'abcdefghijklmnopqr', '多帧步进后所有字符必须按序保真合流');
    assert.ok(frames.length >= 3, `必须经历多帧自驱动调度，实际帧数: ${frames.length}`);
    assert.equal(frames[0], 'abc', '第 1 帧步长必须为 ceil(18/6) = 3');
    coalescer.clear();
  });

  await t.test('7. 短文本 (<= 4 字符) 与 thought 混合时单帧清空', async () => {
    const batches = [];
    const coalescer = new TokenCoalescer(
      (batch) => {
        const entry = batch.get('msg-short');
        if (entry) batches.push({ content: entry.content, thought: entry.thought });
      },
      { cadence: true }
    );

    // thought 包含长文本，content 仅 3 个字符
    coalescer.push({ messageId: 'msg-short', delta: 'Deep thought analysis', isThought: true });
    coalescer.push({ messageId: 'msg-short', delta: 'OK!', isThought: false });

    await sleep(35);

    assert.equal(batches.length, 1);
    assert.equal(batches[0].thought, 'Deep thought analysis', 'thought 必须在第 1 帧全量吐出并清空');
    assert.equal(batches[0].content, 'OK!', '短文本 <= 4 字符不拆分直接单帧吐出');
    coalescer.clear();
  });

  await t.test('8. requestAnimationFrame 与 cancelAnimationFrame 驱动与取消', async () => {
    // 模拟全局 requestAnimationFrame 环境
    let rafCallCount = 0;
    let cancelCallCount = 0;
    let queuedTick = null;

    const originalRaf = globalThis.requestAnimationFrame;
    const originalCancel = globalThis.cancelAnimationFrame;

    globalThis.requestAnimationFrame = (cb) => {
      rafCallCount += 1;
      queuedTick = cb;
      return 999;
    };
    globalThis.cancelAnimationFrame = (id) => {
      cancelCallCount += 1;
      assert.equal(id, 999);
      queuedTick = null;
    };

    try {
      let flushedContent = '';
      const coalescer = new TokenCoalescer((batch) => {
        const entry = batch.get('msg-raf');
        if (entry) flushedContent += entry.content;
      });

      coalescer.push({ messageId: 'msg-raf', delta: 'hello raf' });
      assert.equal(rafCallCount, 1, '必须通过 requestAnimationFrame 排队');

      // 再次连续 push，因 rafId !== null，防重入不再注册多余 rAF
      coalescer.push({ messageId: 'msg-raf', delta: ' again' });
      assert.equal(rafCallCount, 1, '调度重入防御：rafId 存在时不得重复注册 rAF');

      // 模拟调用 flush()：必须取消在途 rAF 并一次性同步清空
      coalescer.flush();
      assert.equal(cancelCallCount, 1, 'flush 必须调用 cancelAnimationFrame 取消在途帧');
      assert.equal(flushedContent, 'hello raf again', 'flush 必须全量提交');

      // 再次测试 clear 触发 cancelAnimationFrame
      coalescer.push({ messageId: 'msg-raf-2', delta: 'cancel test' });
      assert.equal(rafCallCount, 2);
      coalescer.clear();
      assert.equal(cancelCallCount, 2, 'clear 必须调用 cancelAnimationFrame');
    } finally {
      // 还原环境
      globalThis.requestAnimationFrame = originalRaf;
      globalThis.cancelAnimationFrame = originalCancel;
    }
  });

  await t.test('9. 边界空值早退：buffer 为空时 step 与 flush 不触发任何 onFlush 回调', () => {
    let called = false;
    const coalescer = new TokenCoalescer(() => {
      called = true;
    });

    // 初始空 flush
    coalescer.flush();
    assert.equal(called, false, '空 buffer 调用 flush 不得触发回调');

    // 再次清空
    coalescer.clear();
    assert.equal(called, false);
  });

  await t.test('10. dropMessage: 精确剔除目标消息并按空缓冲区复位 rAF 句柄', () => {
    const originalRaf = globalThis.requestAnimationFrame;
    const originalCancel = globalThis.cancelAnimationFrame;
    let nextId = 100;
    const activeIds = [];
    const canceledIds = [];

    globalThis.requestAnimationFrame = () => {
      const id = ++nextId;
      activeIds.push(id);
      return id;
    };
    globalThis.cancelAnimationFrame = (id) => {
      canceledIds.push(id);
    };

    try {
      const batches = [];
      const coalescer = new TokenCoalescer((batch) => batches.push(batch), { cadence: true });

      assert.equal(coalescer.dropMessage('missing-empty'), false);

      coalescer.push({ messageId: 'm1', delta: 'drop-me' });
      coalescer.push({ messageId: 'm2', delta: 'keep-me' });
      assert.equal(activeIds.length, 1);

      assert.equal(coalescer.dropMessage('non-existent'), false);
      assert.equal(coalescer.dropMessage('m1'), true);
      // 缓冲区仍有 m2 时严禁取消在途 rAF
      assert.equal(canceledIds.length, 0);
      coalescer.flush();
      assert.equal(batches.length, 1);
      assert.equal(batches[0].has('m1'), false);
      assert.deepEqual(batches[0].get('m2'), { content: 'keep-me', thought: '' });

      // 移除最后一条消息时必须取消 rAF 并清零 rafId，后续 push 必须能重新调度
      coalescer.push({ messageId: 'm-only', delta: 'abc' });
      assert.equal(activeIds.length, 2);
      const cancelBefore = canceledIds.length;
      assert.equal(coalescer.dropMessage('m-only'), true);
      assert.deepEqual(canceledIds.slice(cancelBefore), [102]);
      coalescer.push({ messageId: 'm-after', delta: 'xyz' });
      assert.equal(activeIds.length, 3, 'dropMessage 清空缓冲区必须复位 rafId 以便下次调度');
      coalescer.clear();
    } finally {
      globalThis.requestAnimationFrame = originalRaf;
      globalThis.cancelAnimationFrame = originalCancel;
    }

    // cancelAnimationFrame 缺失环境下仍可安全 drop
    const savedCancel = globalThis.cancelAnimationFrame;
    const savedRaf = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = () => 99;
    globalThis.cancelAnimationFrame = undefined;
    try {
      const c2 = new TokenCoalescer(() => {}, { cadence: true });
      c2.push({ messageId: 'm-noraf', delta: 'v' });
      assert.equal(c2.dropMessage('m-noraf'), true);
    } finally {
      globalThis.requestAnimationFrame = savedRaf;
      globalThis.cancelAnimationFrame = savedCancel;
    }
  });
});
