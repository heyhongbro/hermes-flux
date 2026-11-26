/**
 * 流视口交互停靠高度监听、rAF 合流与空流回退专项测试
 * (Stream Viewport Interactive Inset & Anchor Fallback Test)
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { StreamViewportManager } from '../../dist/renderer/viewport/streamViewportManager.mjs';

function makeElementStub(height, top = 700, queryMap = {}) {
  const styles = new Map();
  return {
    scrollTop: 900,
    scrollHeight: 1000,
    clientHeight: 100,
    style: {
      setProperty: (k, v) => {
        styles.set(k, v);
      },
      getPropertyValue: (k) => styles.get(k) ?? '',
    },
    getBoundingClientRect: () => ({ top, bottom: top + height, height, left: 0, right: 400, width: 400 }),
    querySelector: (sel) => queryMap[sel] ?? null,
    setHeight(nextHeight, nextTop = top) {
      height = nextHeight;
      top = nextTop;
    },
  };
}

test('StreamViewportManager: syncStreamBottomInset ResizeObserver 绑定/去重/目标切换与回调重算', () => {
  const prevResizeObserver = globalThis.ResizeObserver;
  const prevDocument = globalThis.document;
  const instances = [];
  class MockResizeObserver {
    constructor(cb) {
      this.cb = cb;
      this.observed = [];
      this.disconnects = 0;
      instances.push(this);
    }
    observe(target) {
      this.observed.push(target);
    }
    disconnect() {
      this.disconnects += 1;
    }
    trigger() {
      this.cb([]);
    }
  }
  globalThis.ResizeObserver = MockResizeObserver;
  globalThis.document = { querySelector: () => null };

  try {
    const stream = makeElementStub(100, 0);
    const dock = makeElementStub(60, 740);
    let promptHost = makeElementStub(80, 660);
    const pod = makeElementStub(800, 0, {
      '#react-interactive-prompt-host': promptHost,
    });
    const podQuery = (sel) => (sel === '#react-interactive-prompt-host' ? promptHost : null);
    pod.querySelector = podQuery;

    const settledCalls = [];
    const host = {
      getActiveSessionId: () => 'sess-iv',
      getPresenceLayout: () => 'dock',
      isPromptJumpSettling: () => false,
      getMessageWindowEnd: () => 10,
      getTotalMessages: () => 10,
      layoutSignature: () => 'sig',
      getStreamElement: () => stream,
      getMiddlePodElement: () => pod,
      getInputDockElement: () => dock,
      getVirtualWindowElement: () => null,
      markProgrammaticScroll: () => {},
      onViewportSettled: () => settledCalls.push('settled'),
      requestAnimationFrame: (cb) => {
        cb();
        return 1;
      },
    };

    const manager = new StreamViewportManager(host);

    // 1. 首次挂载观察 dock 与 promptHost
    manager.syncStreamBottomInset();
    assert.equal(instances.length, 1);
    const ro = instances[0];
    assert.equal(ro.disconnects, 1);
    assert.deepEqual(ro.observed, [dock, promptHost]);
    assert.equal(stream.style.getPropertyValue('--conv-gutter-bottom'), '180px');
    assert.equal(settledCalls.length, 1);

    // 2. 目标未变化时不重复 disconnect / observe
    manager.syncStreamBottomInset();
    assert.equal(ro.disconnects, 1);
    assert.equal(ro.observed.length, 2);

    // 3. promptHost 尺寸变化并通过 ResizeObserver 回调触发重算
    promptHost.setHeight(120, 620);
    ro.trigger();
    assert.equal(stream.style.getPropertyValue('--conv-gutter-bottom'), '220px');
    assert.equal(settledCalls.length, 2);

    // 4. promptHost 切换为另一个 DOM 元素 -> 重新 disconnect 并观察新目标
    const promptHost2 = makeElementStub(50, 690);
    promptHost = promptHost2;
    ro.observed.length = 0;
    manager.syncStreamBottomInset();
    assert.equal(ro.disconnects, 2);
    assert.deepEqual(ro.observed, [dock, promptHost2]);
    assert.equal(stream.style.getPropertyValue('--conv-gutter-bottom'), '150px');

    // 5. promptHost 卸载变为 null -> 仅观察 dock
    promptHost = null;
    ro.observed.length = 0;
    manager.syncStreamBottomInset();
    assert.equal(ro.disconnects, 3);
    assert.deepEqual(ro.observed, [dock]);
    assert.equal(stream.style.getPropertyValue('--conv-gutter-bottom'), '100px');
  } finally {
    globalThis.ResizeObserver = prevResizeObserver;
    globalThis.document = prevDocument;
  }
});

test('StreamViewportManager: scheduleStreamBottomInset rAF 合流节流与 captureStreamAnchor 空流兜底', () => {
  const prevResizeObserver = globalThis.ResizeObserver;
  const prevDocument = globalThis.document;
  globalThis.ResizeObserver = undefined;
  globalThis.document = { querySelector: () => null };

  try {
    let currentStream = null;
    const stream = makeElementStub(100, 0);
    stream.scrollTop = 0; // 避免触发 settleInitialBottom 额外排队 rAF，仅验证 scheduleStreamBottomInset 合流
    const dock = makeElementStub(60, 740);
    const promptHost = makeElementStub(40, 700);
    const pod = makeElementStub(800, 0, {
      '#react-interactive-prompt-host': promptHost,
    });
    const rafQueue = [];

    const host = {
      getActiveSessionId: () => 'sess-raf',
      getPresenceLayout: () => 'stage',
      isPromptJumpSettling: () => false,
      getMessageWindowEnd: () => 5,
      getTotalMessages: () => 5,
      layoutSignature: () => 'sig',
      getStreamElement: () => currentStream,
      getMiddlePodElement: () => pod,
      getInputDockElement: () => dock,
      getVirtualWindowElement: () => null,
      markProgrammaticScroll: () => {},
      requestAnimationFrame: (cb) => {
        rafQueue.push(cb);
        return rafQueue.length;
      },
    };

    const manager = new StreamViewportManager(host);

    // stream 为 null 时 captureStreamAnchor 返回安全空锚点
    assert.deepEqual(manager.captureStreamAnchor(), {
      sessionId: 'sess-raf',
      id: null,
      offset: 0,
      rawScrollTop: 0,
    });

    // scheduleStreamBottomInset 在同帧多次调用合并为 1 个 rAF
    currentStream = stream;
    manager.scheduleStreamBottomInset();
    manager.scheduleStreamBottomInset();
    assert.equal(rafQueue.length, 1);

    // 消费帧后重放 inset 并清空合流锁，使下一帧可重新排队
    rafQueue.shift()();
    assert.equal(stream.style.getPropertyValue('--conv-gutter-bottom'), '132px');

    promptHost.setHeight(90, 650);
    manager.scheduleStreamBottomInset();
    assert.equal(rafQueue.length, 1);
    rafQueue.shift()();
    assert.equal(stream.style.getPropertyValue('--conv-gutter-bottom'), '182px');
  } finally {
    globalThis.ResizeObserver = prevResizeObserver;
    globalThis.document = prevDocument;
  }
});
