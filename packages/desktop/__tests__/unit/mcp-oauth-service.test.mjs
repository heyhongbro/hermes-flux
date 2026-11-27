/**
 * MCP 服务器热重载确认与 OAuth 授权服务全路径单元测试
 * (packages/desktop/__tests__/unit/mcp-oauth-service.test.mjs)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createMcpOAuthActions } from '../../dist/renderer/services/mcpOAuthService.mjs';

function tMock(key, params) {
  return params ? `${key}:${JSON.stringify(params)}` : key;
}

test('createMcpOAuthActions: 断连守卫、外链安全校验、reload.mcp 与 OAuth start/poll/cancel 全路径', async () => {
  const notifications = [];
  let extChangedCount = 0;
  let connected = false;
  let client = null;
  let desktopApi = undefined;
  let activeLiveSessionId = null;
  let profileName = '';

  const stateGetter = () => ({
    gatewayConnected: connected,
    activeLiveSessionId,
    profileName,
  });

  const actions = createMcpOAuthActions({
    getState: stateGetter,
    getGatewayClient: () => client,
    getDesktopApi: () => desktopApi,
    describeRpcError: (err) => (err instanceof Error ? err.message : String(err)),
    t: tMock,
    onNotify: (msg) => notifications.push(msg),
    onExtensionsChanged: () => {
      extChangedCount += 1;
    },
  });

  // 1. 外链跳转：屏蔽不安全 scheme，优先走 desktopApi.openExternal，其次 window.open
  const desktopOpened = [];
  desktopApi = { openExternal: async (url) => desktopOpened.push(url) };
  actions.onOpenExternalUrl('javascript:alert(1)');
  assert.deepEqual(desktopOpened, []);
  actions.onOpenExternalUrl('https://oauth.example.com/auth');
  assert.deepEqual(desktopOpened, ['https://oauth.example.com/auth']);

  desktopApi = undefined;
  const prevWin = globalThis.window;
  const winOpened = [];
  globalThis.window = {
    open: (url, target, rel) => {
      winOpened.push({ url, target, rel });
    },
  };
  try {
    actions.onOpenExternalUrl('http://localhost:8080/cb');
    assert.deepEqual(winOpened, [
      { url: 'http://localhost:8080/cb', target: '_blank', rel: 'noopener,noreferrer' },
    ]);
    // 无 desktopApi 且 window.open 缺失时不报错
    globalThis.window = {};
    actions.onOpenExternalUrl('https://ok.example.com');
  } finally {
    globalThis.window = prevWin;
  }

  // 2. 断连状态下四大动作直接返回 notConnected
  assert.deepEqual(await actions.onReloadMcp(), { ok: false, message: 'settings.notConnected' });
  assert.deepEqual(await actions.onStartMcpOAuth('default', 'gh'), {
    ok: false,
    message: 'settings.notConnected',
  });
  assert.deepEqual(await actions.onPollMcpOAuth('default', 'gh', 's1'), {
    ok: false,
    status: 'error',
    message: 'settings.notConnected',
  });
  assert.deepEqual(await actions.onCancelMcpOAuth('default', 'gh', 's1'), {
    ok: false,
    message: 'settings.notConnected',
  });

  // 3. 已连接路径：逐一验证成功、confirm_required、busy、malformed 与异常
  connected = true;
  const calls = [];
  let nextImpl = async () => ({});
  client = {
    call: async (method, params) => {
      calls.push({ method, params });
      return await nextImpl(method, params);
    },
  };

  // onReloadMcp: confirm_required 无 message 回 fallback
  nextImpl = async () => ({ status: 'confirm_required' });
  const rConfirmDef = await actions.onReloadMcp();
  assert.equal(rConfirmDef.ok, false);
  assert.equal(rConfirmDef.confirmRequired, true);
  assert.equal(rConfirmDef.rev, null);
  assert.equal(rConfirmDef.message, 'interactive.confirm.reloadMcpMessage');

  // onReloadMcp: confirm_required 带自定义 message/rev + 传 confirm/always/rev/session_id
  activeLiveSessionId = 'live-mcp';
  nextImpl = async () => ({ status: 'confirm_required', loaded_rev: 'r2', message: 'Custom?' });
  const rConfirmCustom = await actions.onReloadMcp({ confirm: true, always: true, rev: 'r1' });
  assert.equal(rConfirmCustom.rev, 'r2');
  assert.equal(rConfirmCustom.message, 'Custom?');
  assert.deepEqual(calls.at(-1).params, {
    session_id: 'live-mcp',
    confirm: true,
    always: true,
    rev: 'r1',
  });

  // onReloadMcp: busy vs normal + throws
  nextImpl = async () => ({ status: 'ok', session: 'busy', loaded_rev: 'r3', message: 'busy-msg' });
  const rBusy = await actions.onReloadMcp();
  assert.equal(rBusy.ok, true);
  assert.equal(notifications.at(-1), 'interactive.mcp.reloadBusy');

  nextImpl = async () => ({ status: 'ok' });
  const rOk = await actions.onReloadMcp();
  assert.equal(rOk.ok, true);
  assert.equal(rOk.session, null);
  assert.equal(rOk.message, undefined);
  assert.equal(notifications.at(-1), 'interactive.mcp.reloaded');

  nextImpl = async () => {
    throw new Error('reload boom');
  };
  const rErr = await actions.onReloadMcp();
  assert.equal(rErr.ok, false);
  assert.match(rErr.message || '', /reload boom/);

  // onStartMcpOAuth: profile 空回退到 state.profileName || 'default'，malformed、安全/不安全外链与 throw
  profileName = '';
  nextImpl = async () => ({ ok: false });
  assert.deepEqual(await actions.onStartMcpOAuth('', ' gh '), {
    ok: false,
    message: 'settings.malformedResponse',
  });
  assert.equal(calls.at(-1).params.profile, 'default');

  desktopOpened.length = 0;
  desktopApi = { openExternal: async (url) => desktopOpened.push(url) };
  nextImpl = async () => ({
    ok: true,
    session_id: 'oa-1',
    auth_url: 'https://auth.example.com/start',
    flow: 'pkce',
  });
  const sOk = await actions.onStartMcpOAuth('p-custom', ' linear ');
  assert.equal(sOk.ok, true);
  assert.equal(sOk.sessionId, 'oa-1');
  assert.deepEqual(desktopOpened, ['https://auth.example.com/start']);

  nextImpl = async () => ({ ok: true, session_id: 'oa-2', auth_url: 'javascript:bad' });
  const sUnsafe = await actions.onStartMcpOAuth('p-custom', 'bad');
  assert.equal(sUnsafe.ok, true);
  assert.equal(desktopOpened.length, 1);

  nextImpl = async () => {
    throw new Error('start boom');
  };
  const sErr = await actions.onStartMcpOAuth('p-custom', 'err');
  assert.equal(sErr.ok, false);
  assert.match(sErr.message || '', /start boom/);

  // onPollMcpOAuth: approved + pending + throw
  const beforeExt = extChangedCount;
  nextImpl = async () => ({ ok: true, status: 'approved' });
  const pApp = await actions.onPollMcpOAuth('', 'gh', 'oa-1');
  assert.equal(pApp.ok, true);
  assert.equal(pApp.sessionId, 'oa-1');
  assert.equal(extChangedCount, beforeExt + 1);

  nextImpl = async () => ({
    ok: false,
    status: 'failed',
    session_id: 'oa-1b',
    auth_url: 'https://retry',
    error_message: 'denied',
  });
  const pFail = await actions.onPollMcpOAuth('p-1', 'gh', 'oa-1');
  assert.equal(pFail.status, 'failed');
  assert.equal(pFail.message, 'denied');

  nextImpl = async () => {
    throw new Error('poll boom');
  };
  const pErr = await actions.onPollMcpOAuth('p-1', 'gh', 'oa-1');
  assert.equal(pErr.status, 'error');
  assert.match(pErr.message || '', /poll boom/);

  // onCancelMcpOAuth: ok / ok:false(with/without error_message) / throw
  nextImpl = async () => ({ ok: true });
  assert.deepEqual(await actions.onCancelMcpOAuth('', 'gh', 'oa-1'), { ok: true });

  nextImpl = async () => ({ ok: false, error_message: 'cancel rejected' });
  assert.deepEqual(await actions.onCancelMcpOAuth('p-1', 'gh', 'oa-1'), {
    ok: false,
    message: 'cancel rejected',
  });

  nextImpl = async () => ({ ok: false });
  assert.deepEqual(await actions.onCancelMcpOAuth('p-1', 'gh', 'oa-1'), {
    ok: false,
    message: 'settings.loadFailed',
  });

  nextImpl = async () => {
    throw new Error('cancel boom');
  };
  const cErr = await actions.onCancelMcpOAuth('p-1', 'gh', 'oa-1');
  assert.equal(cErr.ok, false);
  assert.equal(cErr.message, 'cancel boom');
});
