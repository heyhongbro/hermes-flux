import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyConnectionError,
  computeColdStartRetryDelayMs,
  resolveConnectionPhase,
  resolveTitlebarConnectionStatus,
  isLegacyRpcMethodError,
} from '../../dist/index.js';

test('connectionPhase: classifyConnectionError distinguishes auth, config, and transient failures', () => {
  assert.equal(classifyConnectionError('anything', 401), 'auth');
  assert.equal(classifyConnectionError('anything', 403), 'auth');
  assert.equal(classifyConnectionError('HTTP 401 Unauthorized'), 'auth');
  assert.equal(classifyConnectionError('登录接口异常 HTTP 403'), 'auth');
  assert.equal(classifyConnectionError('认证失败: 用户名或密码错误'), 'auth');
  assert.equal(classifyConnectionError('invalid password'), 'auth');

  assert.equal(classifyConnectionError('请先填写网关地址'), 'config');
  assert.equal(classifyConnectionError('Invalid URL: bad host'), 'config');

  assert.equal(classifyConnectionError(undefined), 'transient');
  assert.equal(classifyConnectionError('   '), 'transient');
  assert.equal(classifyConnectionError('fetch failed: ECONNREFUSED'), 'transient');
});

test('connectionPhase: computeColdStartRetryDelayMs clamps bounds and grows monotonically', () => {
  assert.equal(computeColdStartRetryDelayMs(Number.NaN), 1000);
  assert.equal(computeColdStartRetryDelayMs(0), 1000);
  assert.equal(computeColdStartRetryDelayMs(1), 1000);
  assert.equal(computeColdStartRetryDelayMs(2), 2000);
  assert.equal(computeColdStartRetryDelayMs(3), 4000);
  assert.equal(computeColdStartRetryDelayMs(4), 8000);
  assert.equal(computeColdStartRetryDelayMs(5), 15000);
  assert.equal(computeColdStartRetryDelayMs(99), 15000);
});

test('connectionPhase: resolveConnectionPhase reduces all 7 phases accurately', () => {
  const base = {
    hasGatewayUrl: true,
    manualDisconnected: false,
    authError: false,
    fsmState: 'DISCONNECTED',
    isSyncing: false,
    isSyncedFlash: false,
    isColdStartRetrying: false,
    hasConnectedOnce: false,
  };

  assert.equal(resolveConnectionPhase({ ...base, hasGatewayUrl: false }), 'unconfigured');
  assert.equal(resolveConnectionPhase({ ...base, manualDisconnected: true, fsmState: 'CONNECTED' }), 'offline');
  assert.equal(resolveConnectionPhase({ ...base, authError: true, fsmState: 'RECONNECTING' }), 'offline');

  assert.equal(resolveConnectionPhase({ ...base, fsmState: 'CONNECTED' }), 'connected');
  assert.equal(resolveConnectionPhase({ ...base, fsmState: 'CONNECTED', isSyncing: true, isSyncedFlash: true }), 'syncing');
  assert.equal(resolveConnectionPhase({ ...base, fsmState: 'CONNECTED', isSyncedFlash: true }), 'synced');

  assert.equal(resolveConnectionPhase({ ...base, fsmState: 'RECONNECTING' }), 'reconnecting');
  assert.equal(resolveConnectionPhase({ ...base, fsmState: 'CONNECTING' }), 'connecting');
  assert.equal(resolveConnectionPhase({ ...base, fsmState: 'HANDSHAKING' }), 'connecting');
  assert.equal(resolveConnectionPhase({ ...base, fsmState: 'CONNECTING', hasConnectedOnce: true }), 'reconnecting');
  assert.equal(resolveConnectionPhase({ ...base, fsmState: 'HANDSHAKING', isColdStartRetrying: true }), 'reconnecting');

  assert.equal(resolveConnectionPhase({ ...base, fsmState: null, isColdStartRetrying: true }), 'reconnecting');
  assert.equal(resolveConnectionPhase({ ...base, fsmState: null, isColdStartRetrying: false }), 'offline');
});

test('connectionPhase: resolveTitlebarConnectionStatus & isLegacyRpcMethodError', () => {
  assert.equal(resolveTitlebarConnectionStatus('syncing', true), 'syncing');
  assert.equal(resolveTitlebarConnectionStatus('connecting', false), 'reconnecting');
  assert.equal(resolveTitlebarConnectionStatus('reconnecting', false), 'reconnecting');
  assert.equal(resolveTitlebarConnectionStatus('connected', true), 'connected');
  assert.equal(resolveTitlebarConnectionStatus('synced', true), 'connected');
  assert.equal(resolveTitlebarConnectionStatus('offline', false), 'offline');
  assert.equal(resolveTitlebarConnectionStatus('offline', true), 'connected');
  assert.equal(resolveTitlebarConnectionStatus('unconfigured', false), 'offline');

  assert.equal(isLegacyRpcMethodError(null), false);
  assert.equal(isLegacyRpcMethodError('timeout'), false);
  assert.equal(isLegacyRpcMethodError(new Error('network error')), false);
  assert.equal(isLegacyRpcMethodError({ code: -32601, message: 'Method not found' }), true);
});
