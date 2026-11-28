/**
 * 多网关连接相位收敛、焦点唤醒保护与渲染层文件日志落盘单测
 * (packages/desktop/__tests__/unit/multi-gateway-phase-and-log.test.mjs)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clearLogSinks,
  createLogger,
  setLogLevel,
} from '@hermes-flux/core';
import { GATEWAY_REGISTRY_STORAGE_KEY } from '../../dist/renderer/gateway/gatewayRegistryStore.mjs';
import { createDesktopMultiGatewayWiring } from '../../dist/renderer/gateway/multiGatewayCoordinator.mjs';
import {
  LOG_LEVEL_STORAGE_KEY,
  registerRendererLogSinks,
  resolveInitialLogLevel,
} from '../../dist/renderer/logBridge.mjs';
import { createInitialState } from '../../dist/renderer/state/appState.mjs';

function createMemoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => {
      map.set(k, String(v));
    },
    removeItem: (k) => {
      map.delete(k);
    },
  };
}

async function flushMicrotasks(rounds = 8) {
  for (let i = 0; i < rounds; i += 1) {
    await Promise.resolve();
  }
}

test('MultiGateway connectionPhase 收敛、首次连上触发 sync 与焦点切换/鉴权错误收敛', async () => {
  const prevWs = globalThis.WebSocket;
  const prevLs = globalThis.localStorage;

  const sockets = [];
  class ManualWs {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.closed = false;
      this.sent = [];
      this.onopen = null;
      this.onmessage = null;
      this.onclose = null;
      this.onerror = null;
      sockets.push(this);
    }
    openNow() {
      this.readyState = 1;
      this.onopen?.();
    }
    send(raw) {
      const f = JSON.parse(raw);
      this.sent.push(f);
      if (f.id != null) {
        queueMicrotask(() => {
          this.onmessage?.({ data: JSON.stringify({ jsonrpc: '2.0', id: f.id, result: { ok: true } }) });
        });
      }
    }
    close() {
      this.closed = true;
      this.readyState = 3;
      this.onclose?.({ code: 1000, reason: 'closed' });
    }
  }

  let authOkA = true;
  let authOkB = true;
  const connectedCallbacks = [];

  globalThis.WebSocket = ManualWs;
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: createMemoryStorage({
      [GATEWAY_REGISTRY_STORAGE_KEY]: JSON.stringify([
        { id: 'gw-a', name: 'Alpha', url: 'http://127.0.0.1:9119' },
        { id: 'gw-b', name: 'Beta', url: 'http://127.0.0.1:9120' },
      ]),
    }),
  });

  const state = createInitialState({ platform: 'darwin' });
  state.gatewayUrl = 'http://127.0.0.1:9119';
  state.connectionPhase = 'connecting';
  state.gatewayConnecting = true;
  state.activeGatewayId = 'gw-a';
  state.activeFocus = { type: 'session', sessionId: 's-a', gatewayId: 'gw-a' };

  const wiring = createDesktopMultiGatewayWiring({
    getState: () => state,
    getDesktopApi: () => ({
      authenticateGateway: async (opts) => {
        const isA = opts.url.includes('9119');
        const ok = isA ? authOkA : authOkB;
        return ok
          ? { ok: true, latency: 2, ticket: isA ? 'tk-a' : 'tk-b', message: 'ok' }
          : { ok: false, latency: 2, message: '401 Unauthorized' };
      },
    }),
    onMultiGatewayConnected: (gwId, isFirstOnline) => {
      connectedCallbacks.push({ gwId, isFirstOnline });
    },
    render: () => {},
  });

  try {
    // 1. bootstrap 启动：WebSocket 尚未 open 前仍处于 connecting，不抢跑触发 connected
    const pBoot = wiring.bootstrap();
    await flushMicrotasks();
    assert.equal(state.connectionPhase, 'connecting');
    assert.equal(connectedCallbacks.length, 0);

    // 2. 第一台网关 gw-a 握手完成 -> connectionPhase 收敛为 connected 且首次回调触发
    const sockA = sockets.find((s) => s.url.includes('9119'));
    sockA.openNow();
    await flushMicrotasks();
    await pBoot;
    assert.equal(state.gatewayConnected, true);
    assert.equal(state.connectionPhase, 'connected');
    assert.equal(state.gatewayConnecting, false);
    assert.deepEqual(connectedCallbacks, [{ gwId: 'gw-a', isFirstOnline: true }]);

    // 3. gw-b 若正在 CONNECTING，切换焦点到 gw-b 反映 connecting；wakeAllSlots('focus') 不得销毁在途 socket
    const sockCountBeforeWake = sockets.length;
    const sockB = sockets.find((s) => s.url.includes('9120'));
    assert.equal(sockB.closed, false);
    state.activeFocus = { type: 'session', sessionId: 's-b', gatewayId: 'gw-b' };
    state.activeGatewayId = 'gw-b';
    wiring.coordinator.refreshActiveOfflineState();
    assert.equal(state.connectionPhase, 'connecting');

    await wiring.wakeAllSlots('focus');
    assert.equal(sockB.closed, false, '在途 CONNECTING socket 不得在聚焦唤醒时被销毁重建');
    assert.equal(sockets.length, sockCountBeforeWake);

    // 4. gw-b 连上后收敛为 connected 并触发 focused onMultiGatewayConnected
    sockB.openNow();
    await flushMicrotasks();
    assert.equal(state.connectionPhase, 'connected');
    assert.equal(connectedCallbacks.at(-1)?.gwId, 'gw-b');

    // 5. 若 gw-b 发生 401 鉴权失败，焦点切到 gw-b 显示 offline + connectionAuthError=true；切回在线的 gw-a 立刻恢复 connected
    authOkB = false;
    wiring.coordinator.disconnectGateway('gw-b');
    await wiring.runtime.connectGateway('gw-b');
    assert.equal(state.connectionPhase, 'offline');
    assert.equal(state.connectionAuthError, true);

    state.activeFocus = { type: 'session', sessionId: 's-a', gatewayId: 'gw-a' };
    state.activeGatewayId = 'gw-a';
    wiring.coordinator.refreshActiveOfflineState();
    assert.equal(state.connectionPhase, 'connected');
    assert.equal(state.connectionAuthError, false);
  } finally {
    wiring.runtime.dispose();
    if (prevWs === undefined) delete globalThis.WebSocket;
    else globalThis.WebSocket = prevWs;
    if (prevLs === undefined) delete globalThis.localStorage;
    else Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: prevLs });
  }
});

test('logBridge: ?log= 优先级与 appendLog 双通道文件落盘转发', () => {
  clearLogSinks();
  try {
    const ls = createMemoryStorage({ [LOG_LEVEL_STORAGE_KEY]: 'warn' });
    assert.equal(resolveInitialLogLevel('?foo=1&log=debug', ls), 'debug');
    assert.equal(resolveInitialLogLevel('?log=trace', ls), 'trace');
    assert.equal(resolveInitialLogLevel('', ls), 'warn');
    assert.equal(resolveInitialLogLevel('', createMemoryStorage({})), 'info');
    assert.equal(
      resolveInitialLogLevel('', {
        getItem() {
          throw new Error('blocked storage');
        },
      }),
      'info',
    );

    const fileRecords = [];
    const consoleCalls = [];
    const mockConsole = {
      log: (...args) => consoleCalls.push(['info', ...args]),
      warn: (...args) => consoleCalls.push(['warn', ...args]),
      error: (...args) => consoleCalls.push(['error', ...args]),
      debug: (...args) => consoleCalls.push(['debug', ...args]),
    };

    setLogLevel('info');
    const reg = registerRendererLogSinks({
      desktopApi: {
        appendLog: (rec) => fileRecords.push(rec),
      },
      fileMinLevel: 'info',
      consoleImpl: mockConsole,
    });
    assert.equal(reg.sinkCount, 2);

    const log = createLogger('gateway');
    log.info('slot connected', { gatewayId: 'gw-a' });
    log.warn('auth warning', { status: 401 });
    log.debug('verbose frame ignored at info threshold', { id: 1 });

    assert.equal(fileRecords.length, 2);
    assert.equal(fileRecords[0].scope, 'gateway');
    assert.equal(fileRecords[0].level, 'info');
    assert.equal(fileRecords[1].level, 'warn');
    assert.equal(consoleCalls.length, 2);

    reg.dispose();

    const consoleOnly = registerRendererLogSinks({
      desktopApi: undefined,
      fileMinLevel: 'info',
      consoleImpl: mockConsole,
    });
    assert.equal(consoleOnly.sinkCount, 1);
    consoleOnly.dispose();
  } finally {
    clearLogSinks();
    setLogLevel('info');
  }
});
