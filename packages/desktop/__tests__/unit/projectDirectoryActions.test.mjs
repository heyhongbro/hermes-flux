/**
 * 桌面端设置中心工作目录树动作装配器单测
 * (packages/desktop/__tests__/unit/projectDirectoryActions.test.mjs)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createProjectDirectoryActions } from '../../dist/renderer/services/projectDirectoryActions.mjs';

function makeBaseState(overrides = {}) {
  return {
    gatewayUrl: 'https://remote.example.com:9119',
    gatewayConnected: true,
    profileName: 'research-bot',
    ...overrides,
  };
}

test('createProjectDirectoryActions: 远端网关转发 browse/create/rename 与 shell.exec Profile 路由', async () => {
  const rpcCalls = [];
  const proxyCalls = [];
  let localCreated = false;
  let localRenamed = false;

  const state = makeBaseState();
  const actions = createProjectDirectoryActions({
    getState: () => state,
    getGatewayClient: () => ({
      request: async (method, params) => {
        rpcCalls.push({ method, params });
        return { code: 0, stdout: '', stderr: '' };
      },
    }),
    getDesktopApi: () => ({
      httpProxy: async (opts) => {
        proxyCalls.push(opts);
        if (opts.path === '/api/fs/default-cwd') return { cwd: '/opt/data/workspace' };
        if (opts.path.startsWith('/api/files/mkdir')) return { ok: true, path: opts.body.path };
        return {
          path: '/opt/data',
          root: '/opt/data',
          locked_root: '/opt/data',
          entries: [{ name: 'workspace', path: '/opt/data/workspace', type: 'dir' }],
        };
      },
      createDirectory: async () => {
        localCreated = true;
        return { ok: true, path: 'C:/should-not-happen' };
      },
      renameDirectory: async () => {
        localRenamed = true;
        return { ok: true, path: 'C:/should-not-happen' };
      },
    }),
    getEffectiveUrl: (url) => `${url}/proxy-checked`,
  });

  const browseRes = await actions.onBrowseProjectDirectory('');
  assert.equal(browseRes.ok, true);
  assert.equal(browseRes.source, 'gateway_api');
  assert.equal(browseRes.canRename, true);
  assert.equal(proxyCalls[0].baseUrl, 'https://remote.example.com:9119/proxy-checked');
  assert.equal(proxyCalls[0].params.profile, 'research-bot');

  const createRes = await actions.onCreateProjectDirectory('/opt/data/workspace', 'new-repo', {
    source: 'local_fs',
    lockedRoot: '/opt/data',
  });
  assert.equal(localCreated, false, '非回环远端网关即使误传 local_fs 也不得写本机目录');
  assert.deepEqual(createRes, { ok: true, path: '/opt/data/workspace/new-repo' });

  const renameRes = await actions.onRenameProjectDirectory('/opt/data/workspace/old', 'next', {
    source: 'local_fs',
    lockedRoot: '/opt/data',
  });
  assert.equal(localRenamed, false, '非回环远端网关即使误传 local_fs 也不得重命名本机目录');
  assert.deepEqual(renameRes, { ok: true, path: '/opt/data/workspace/next' });
  assert.equal(rpcCalls.length, 1);
  assert.equal(rpcCalls[0].method, 'shell.exec');
  assert.equal(rpcCalls[0].params.profile, 'research-bot');
  assert.ok(rpcCalls[0].params.command.includes("mv -- '/opt/data/workspace/old' '/opt/data/workspace/next'"));
});

test('createProjectDirectoryActions: 断连态禁止组装 shell.exec 且回落 default profile', async () => {
  let rpcCalled = false;
  const state = makeBaseState({
    gatewayUrl: 'https://remote.example.com',
    gatewayConnected: false,
    profileName: '',
  });
  const actions = createProjectDirectoryActions({
    getState: () => state,
    getGatewayClient: () => ({
      request: async () => {
        rpcCalled = true;
        return { code: 0, stdout: '', stderr: '' };
      },
    }),
    getDesktopApi: () => undefined,
    getEffectiveUrl: (u) => u,
  });

  const browseErr = await actions.onBrowseProjectDirectory('');
  assert.equal(browseErr.ok, false);

  const renameErr = await actions.onRenameProjectDirectory('/opt/data/ws/a', 'b', {
    source: 'gateway_api',
    lockedRoot: '/opt/data',
  });
  assert.equal(rpcCalled, false, 'gatewayConnected=false 时严禁触发 shell.exec');
  assert.equal(renameErr.ok, false);

  // 重连但无 explicit profileName 时自动兜底 'default'
  state.gatewayConnected = true;
  let capturedProfile = '';
  const connectedActions = createProjectDirectoryActions({
    getState: () => state,
    getGatewayClient: () => ({
      request: async (_method, params) => {
        capturedProfile = params.profile;
        return { code: 0, stdout: '', stderr: '' };
      },
    }),
    getDesktopApi: () => undefined,
    getEffectiveUrl: (u) => u,
  });
  const renameOk = await connectedActions.onRenameProjectDirectory('/opt/data/ws/a', 'b', {
    source: 'gateway_api',
    lockedRoot: '/opt/data',
  });
  assert.deepEqual(renameOk, { ok: true, path: '/opt/data/ws/b' });
  assert.equal(capturedProfile, 'default');
});
