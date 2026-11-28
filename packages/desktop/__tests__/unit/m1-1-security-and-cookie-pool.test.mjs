/**
 * M1.1 Desktop Multi-Origin Cookie Pool, Proxy Security, Debug Port, SecretStore & Password Migration Tests
 * (packages/desktop/__tests__/unit/m1-1-security-and-cookie-pool.test.mjs)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
  GatewayCookiePool,
  normalizeGatewayBaseUrl,
  getGatewayOrigin,
  validateGatewayProxyTarget,
  assertNoProxyRedirect,
} from '../../dist/main/gatewayCookiePool.mjs';
import { resolveRemoteDebuggingPort } from '../../dist/main/debugPortPolicy.mjs';
import { createSecretStore } from '../../dist/main/secretStore.mjs';
import {
  HERMES_MEDIA_SCHEME,
  createMediaStreamController,
} from '../../dist/main/mediaStreamProtocol.mjs';
import {
  LEGACY_PASSWORD_STORAGE_KEYS,
  buildGatewaySecretKey,
  purgeLegacyPlaintextPasswords,
  hydrateOrMigrateGatewaySecret,
} from '../../dist/renderer/persistence/secretMigration.mjs';
import { writeGatewayDraft } from '../../dist/renderer/services/settingsStorageHelpers.mjs';
import { createOnboardingController } from '../../dist/renderer/events/onboardingController.mjs';
import { createGatewayEventDispatcher } from '../../dist/renderer/gateway/gatewayEventDispatcher.mjs';
import { createAppBootstrap } from '../../dist/renderer/bootstrap/appBootstrap.mjs';
import { createMockDispatcherDeps } from './helpers/gatewayDispatcherHarness.mjs';

const require = createRequire(import.meta.url);
const Module = require('node:module');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, '../..');

function loadCjsWithElectronMock(cjsPath, mockElectron) {
  const prevLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return mockElectron;
    return prevLoad.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[require.resolve(cjsPath)];
    return require(cjsPath);
  } finally {
    Module._load = prevLoad;
  }
}

function flushMicrotasks() {
  return new Promise((resolve) => queueMicrotask(resolve));
}

test('M1.1: GatewayCookiePool 多源隔离、按 origin 清除与 URL 校验防重定向窃取', () => {
  assert.equal(normalizeGatewayBaseUrl('ws://127.0.0.1:9119/'), 'http://127.0.0.1:9119');
  assert.equal(normalizeGatewayBaseUrl('wss://gw.example.com:9119///'), 'https://gw.example.com:9119');
  assert.equal(normalizeGatewayBaseUrl('example.com:9119'), 'https://example.com:9119');
  assert.equal(normalizeGatewayBaseUrl('   '), '');
  assert.equal(getGatewayOrigin('not a url :::'), '');

  const pool = new GatewayCookiePool();
  assert.deepEqual(pool.getSnapshot(), { cookies: '', origin: '' });

  pool.set('http://127.0.0.1:9119/api/status', 'sid=gw-a');
  pool.set('https://gw-b.example:8443', 'sid=gw-b');

  assert.equal(pool.getForUrl('http://127.0.0.1:9119/api/sessions'), 'sid=gw-a');
  assert.equal(pool.getForUrl('https://gw-b.example:8443/api/sessions'), 'sid=gw-b');
  assert.equal(pool.getForUrl('https://evil.example/api/sessions'), '');
  assert.equal(pool.getForUrl('invalid-url'), '');

  assert.deepEqual(pool.getSnapshot('http://127.0.0.1:9119'), {
    origin: 'http://127.0.0.1:9119',
    cookies: 'sid=gw-a',
  });
  assert.deepEqual(pool.getSnapshot(), {
    origin: 'https://gw-b.example:8443',
    cookies: 'sid=gw-b',
  });

  // 清除 A 不得影响 B；清除无效 URL 忽略；清除 latestOrigin 复位最新槽位
  pool.clear('not-a-url');
  pool.clear('http://127.0.0.1:9119');
  assert.equal(pool.getForUrl('http://127.0.0.1:9119/api/sessions'), '');
  assert.equal(pool.getForUrl('https://gw-b.example:8443/api/sessions'), 'sid=gw-b');

  pool.set('https://gw-c.example:8443', 'sid=gw-c');
  pool.clear('https://gw-c.example:8443');
  assert.deepEqual(pool.getSnapshot(), { origin: '', cookies: '' });

  // set 空串等价于清除
  pool.set('https://gw-b.example:8443', '');
  assert.equal(pool.getForUrl('https://gw-b.example:8443/api/sessions'), '');
  assert.deepEqual(pool.getSnapshot('https://missing.example'), {
    origin: 'https://missing.example',
    cookies: '',
  });

  pool.set('invalid-origin', 'sid=x');
  pool.set('http://127.0.0.1:9119', 'sid=re-added');
  pool.clearAll();
  assert.deepEqual(pool.getSnapshot(), { cookies: '', origin: '' });

  // validateGatewayProxyTarget 合法与危险路径拦截
  const valid = validateGatewayProxyTarget({
    baseUrl: 'ws://127.0.0.1:9119/',
    path: '/api/sessions?foo=bar',
    params: { profile: 'default', limit: 20, omitted: undefined },
  });
  assert.equal(valid.origin, 'http://127.0.0.1:9119');
  assert.equal(valid.fullUrl, 'http://127.0.0.1:9119/api/sessions?foo=bar&profile=default&limit=20');

  const validRel = validateGatewayProxyTarget({
    baseUrl: 'gw.example.com',
    path: 'api/config',
    params: { profile: 'coder' },
  });
  assert.equal(validRel.fullUrl, 'https://gw.example.com/api/config?profile=coder');

  for (const bad of [
    { baseUrl: '', path: '/api/status' },
    { baseUrl: 'ftp://gw.example.com', path: '/api/status' },
    { baseUrl: 'http://[::1', path: '/api/status' },
    { baseUrl: 'http://127.0.0.1:9119', path: '' },
    { baseUrl: 'http://127.0.0.1:9119', path: '/api/\r\nstatus' },
    { baseUrl: 'http://127.0.0.1:9119', path: '//evil.example/steal' },
    { baseUrl: 'http://127.0.0.1:9119', path: 'https://evil.example/steal' },
    { baseUrl: 'http://127.0.0.1:9119', path: '/api/../../etc/passwd' },
    { baseUrl: 'http://127.0.0.1:9119', path: '/api/%2e%2e/secret' },
    { baseUrl: 'http://127.0.0.1:9119', path: '/api/..\\secret' },
    { baseUrl: 'http://127.0.0.1:9119', path: '/api/%zz' },
    { baseUrl: 'http://127.0.0.1:9119', path: '/\\evil.example/steal' },
  ]) {
    assert.throws(() => validateGatewayProxyTarget(bad));
  }

  // assertNoProxyRedirect 拦截一切 3xx 跳转
  assert.doesNotThrow(() => assertNoProxyRedirect('https://gw.example/api', { status: 200 }));
  assert.doesNotThrow(() => assertNoProxyRedirect('https://gw.example/api', { status: 404 }));
  assert.throws(
    () =>
      assertNoProxyRedirect('https://gw.example/api', {
        status: 302,
        headers: new Headers({ location: 'https://evil.example/steal' }),
      }),
    /302/,
  );
  assert.throws(
    () =>
      assertNoProxyRedirect('https://gw.example/api', {
        status: 307,
        headers: undefined,
      }),
    /307/,
  );
});

test('M1.1: resolveRemoteDebuggingPort 生产打包默认关闭 9222 调试口', () => {
  assert.equal(resolveRemoteDebuggingPort({ isPackaged: false }), '9222');
  assert.equal(resolveRemoteDebuggingPort({ isPackaged: true, env: {} }), null);
  assert.equal(
    resolveRemoteDebuggingPort({ isPackaged: true, env: { HERMES_FLUX_REMOTE_DEBUG_PORT: '9222' } }),
    null,
    '打包版本未显式允许前即使传了端口也不得打开调试口',
  );
  assert.equal(
    resolveRemoteDebuggingPort({
      isPackaged: true,
      env: { HERMES_FLUX_ALLOW_PACKAGED_DEBUG: '1', HERMES_FLUX_REMOTE_DEBUG_PORT: '9229' },
    }),
    '9229',
  );
  assert.equal(resolveRemoteDebuggingPort({ isPackaged: false, env: {} }), '9222');
  assert.equal(
    resolveRemoteDebuggingPort({ isPackaged: false, env: { HERMES_FLUX_REMOTE_DEBUG_PORT: 'off' } }),
    null,
  );
  assert.equal(
    resolveRemoteDebuggingPort({ isPackaged: false, env: { HERMES_FLUX_REMOTE_DEBUG_PORT: '0' } }),
    null,
  );
  assert.equal(
    resolveRemoteDebuggingPort({ isPackaged: false, env: { HERMES_FLUX_REMOTE_DEBUG_PORT: '70000' } }),
    null,
  );
  assert.equal(
    resolveRemoteDebuggingPort({ isPackaged: false, env: { HERMES_FLUX_REMOTE_DEBUG_PORT: '9333' } }),
    '9333',
  );
});

test('M1.1: createSecretStore 加密持久化与无加密降级内存隔离（绝不落盘明文）', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-secret-store-'));
  const filePath = path.join(tmpDir, 'nested', 'gateway-secrets.json');

  const fakeCrypto = {
    isEncryptionAvailable: () => true,
    encryptString: (plain) => Buffer.from(`enc::${plain}`, 'utf8'),
    decryptString: (buf) => {
      const raw = buf.toString('utf8');
      if (!raw.startsWith('enc::')) throw new Error('bad ciphertext');
      return raw.slice(5);
    },
  };

  try {
    const store1 = createSecretStore({ filePath, ...fakeCrypto });
    assert.equal(await store1.setSecret('', 'x'), false);
    assert.equal(await store1.getSecret(''), null);
    assert.equal(await store1.deleteSecret(''), false);
    assert.equal(await store1.setSecret('gw:http://127.0.0.1:9119', 'super-top-secret'), true);

    const diskRaw = fs.readFileSync(filePath, 'utf8');
    assert.equal(diskRaw.includes('super-top-secret'), false, '磁盘文件绝不能包含明文口令');

    const store2 = createSecretStore({ filePath, ...fakeCrypto });
    assert.equal(await store2.getSecret('gw:http://127.0.0.1:9119'), 'super-top-secret');
    assert.equal(await store2.getSecret('gw:https://missing'), null);
    assert.equal(await store2.deleteSecret('gw:http://127.0.0.1:9119'), true);
    assert.equal(await store2.deleteSecret('gw:http://127.0.0.1:9119'), false);

    // 写入损坏条目测试恢复与异常捕获
    fs.writeFileSync(filePath, '{"broken-key": 123, "bad-cipher": "aGVsbG8="}', 'utf8');
    const storeCorruptEntry = createSecretStore({ filePath, ...fakeCrypto });
    assert.equal(await storeCorruptEntry.getSecret('bad-cipher'), null);

    fs.writeFileSync(filePath, '{not-json', 'utf8');
    const storeBadJson = createSecretStore({ filePath, ...fakeCrypto });
    assert.equal(await storeBadJson.getSecret('any'), null);

    fs.writeFileSync(filePath, '[]', 'utf8');
    const storeArrayJson = createSecretStore({ filePath, ...fakeCrypto });
    assert.equal(await storeArrayJson.getSecret('any'), null);

    // 不可加密环境：只存内存，不写文件
    const memFile = path.join(tmpDir, 'mem-only.json');
    const memStore = createSecretStore({
      filePath: memFile,
      isEncryptionAvailable: () => false,
      encryptString: fakeCrypto.encryptString,
      decryptString: fakeCrypto.decryptString,
    });
    assert.equal(await memStore.getSecret('missing-key'), null);
    assert.equal(await memStore.setSecret('gw:mem', 'mem-pass'), true);
    assert.equal(fs.existsSync(memFile), false, '系统密钥库不可用时严禁落盘明文');
    assert.equal(await memStore.getSecret('gw:mem'), 'mem-pass');
    assert.equal(await memStore.deleteSecret('gw:mem'), true);
    assert.equal(await memStore.deleteSecret('gw:mem'), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('M1.1: 明文密码清洗迁移、writeGatewayDraft 禁存 localStorage 与四入口无明文落盘', async () => {
  assert.equal(buildGatewaySecretKey(''), '');
  assert.equal(buildGatewaySecretKey('http://127.0.0.1:9119/api'), 'gw:http://127.0.0.1:9119');
  assert.equal(buildGatewaySecretKey('ws://127.0.0.1:9119/api'), 'gw:http://127.0.0.1:9119');
  assert.equal(buildGatewaySecretKey('wss://gw.example:9119/api'), 'gw:https://gw.example:9119');
  assert.equal(buildGatewaySecretKey('ftp://gw.example'), '');
  assert.equal(buildGatewaySecretKey('not-valid-url'), '');

  const map = new Map([
    ['hermes_flux_password', 'legacy-secret'],
    ['hermes_aura_password', 'legacy-old'],
  ]);
  const storage = {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => map.set(k, v),
    removeItem: (k) => map.delete(k),
  };

  assert.equal(purgeLegacyPlaintextPasswords(null), '');
  assert.equal(purgeLegacyPlaintextPasswords({}), '');
  const removedEmpty = purgeLegacyPlaintextPasswords(storage);
  assert.equal(removedEmpty, 'legacy-secret');
  for (const k of LEGACY_PASSWORD_STORAGE_KEYS) {
    assert.equal(map.has(k), false);
  }

  // 安全降级：抛出异常的 removeItem 不中断流程
  assert.equal(
    purgeLegacyPlaintextPasswords({
      getItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    }),
    '',
  );

  // hydrateOrMigrateGatewaySecret：迁移旧明文 / 从 safeStorage 水合
  const secretMap = new Map();
  const mockBridge = {
    setGatewaySecret: async (k, v) => {
      secretMap.set(k, v);
      return true;
    },
    getGatewaySecret: async (k) => secretMap.get(k) ?? null,
    deleteGatewaySecret: async (k) => secretMap.delete(k),
  };

  map.set('hermes_flux_password', 'migrated-pw');
  const migrated = await hydrateOrMigrateGatewaySecret({
    gatewayUrl: 'http://127.0.0.1:9119',
    storage,
    secretBridge: mockBridge,
  });
  assert.equal(migrated, 'migrated-pw');
  assert.equal(map.has('hermes_flux_password'), false);
  assert.equal(secretMap.get('gw:http://127.0.0.1:9119'), 'migrated-pw');

  const hydrated = await hydrateOrMigrateGatewaySecret({
    gatewayUrl: 'http://127.0.0.1:9119',
    storage,
    secretBridge: mockBridge,
  });
  assert.equal(hydrated, 'migrated-pw');

  const missingStored = await hydrateOrMigrateGatewaySecret({
    gatewayUrl: 'http://127.0.0.1:9119',
    storage,
    secretBridge: {
      getGatewaySecret: async () => null,
      setGatewaySecret: async () => true,
    },
  });
  assert.equal(missingStored, '');

  const noUrl = await hydrateOrMigrateGatewaySecret({
    gatewayUrl: '',
    storage,
    secretBridge: mockBridge,
  });
  assert.equal(noUrl, '');

  const failBridge = await hydrateOrMigrateGatewaySecret({
    gatewayUrl: 'http://127.0.0.1:9119',
    storage,
    secretBridge: {
      setGatewaySecret: async () => {
        throw new Error('fail');
      },
      getGatewaySecret: async () => {
        throw new Error('fail');
      },
    },
  });
  assert.equal(failBridge, '');

  // writeGatewayDraft 不写入密码到 localStorage，并同步密钥环
  const savedStorage = globalThis.localStorage;
  const hadStorage = 'localStorage' in globalThis;
  const warnings = [];
  const secretCalls = [];
  try {
    const lsMap = new Map([['hermes_flux_password', 'stale-plain']]);
    globalThis.localStorage = {
      getItem: (k) => lsMap.get(k) ?? null,
      setItem: (k, v) => lsMap.set(k, v),
      removeItem: (k) => lsMap.delete(k),
    };
    writeGatewayDraft(
      {
        bootLog: { warn: (...a) => warnings.push(a) },
        showToast: () => {},
        t: (k) => k,
        getDesktopApi: () => ({
          setGatewaySecret: async (k, v) => {
            secretCalls.push(['set', k, v]);
            return false;
          },
          deleteGatewaySecret: async (k) => {
            secretCalls.push(['del', k]);
            return true;
          },
        }),
      },
      {
        gatewayUrl: 'http://127.0.0.1:9119',
        username: 'alice',
        password: 'pw',
        profileName: 'default',
      },
    );
    await flushMicrotasks();
    assert.equal(lsMap.has('hermes_flux_password'), false);
    assert.equal(lsMap.has('hermes_aura_password'), false);
    assert.equal(lsMap.get('hermes_flux_gateway_url'), 'http://127.0.0.1:9119');
    assert.deepEqual(secretCalls[0], ['set', 'gw:http://127.0.0.1:9119', 'pw']);

    writeGatewayDraft(
      {
        bootLog: { warn: (...a) => warnings.push(a) },
        showToast: () => {},
        t: (k) => k,
        getDesktopApi: () => ({
          setGatewaySecret: async () => true,
          deleteGatewaySecret: async (k) => {
            secretCalls.push(['del', k]);
            return true;
          },
        }),
      },
      {
        gatewayUrl: 'http://127.0.0.1:9119',
        username: 'alice',
        password: '',
        profileName: 'default',
      },
    );
    await flushMicrotasks();
    assert.deepEqual(secretCalls[1], ['del', 'gw:http://127.0.0.1:9119']);

    writeGatewayDraft(
      {
        bootLog: { warn: (...a) => warnings.push(a) },
        showToast: () => {},
        t: (k) => k,
        getDesktopApi: () => ({
          setGatewaySecret: async () => true,
          deleteGatewaySecret: async () => true,
        }),
      },
      {
        gatewayUrl: '',
        username: 'alice',
        password: 'pw2',
        profileName: 'default',
      },
    );

    // 验证 setGatewaySecret throw 时只记 warn 不外抛
    writeGatewayDraft(
      {
        bootLog: { warn: (...a) => warnings.push(a) },
        showToast: () => {},
        t: (k) => k,
        getDesktopApi: () => ({
          setGatewaySecret: async () => {
            throw new Error('ipc down');
          },
          deleteGatewaySecret: async () => true,
        }),
      },
      {
        gatewayUrl: 'http://127.0.0.1:9119',
        username: 'alice',
        password: 'pw2',
        profileName: 'default',
      },
    );
    await flushMicrotasks();
    assert.ok(warnings.length >= 1);
  } finally {
    if (hadStorage) globalThis.localStorage = savedStorage;
    else delete globalThis.localStorage;
  }
});

test('M1.1: onboardingController / gatewayEventDispatcher / appBootstrap 密钥安全集成', async () => {
  const savedDoc = globalThis.document;
  const savedStorage = globalThis.localStorage;
  const hadDoc = 'document' in globalThis;
  const hadStorage = 'localStorage' in globalThis;

  try {
    const lsMap = new Map();
    globalThis.localStorage = {
      getItem: (k) => lsMap.get(k) ?? null,
      setItem: (k, v) => lsMap.set(k, v),
      removeItem: (k) => lsMap.delete(k),
    };

    const inputs = {
      'onboarding-gateway-url': { value: ' http://127.0.0.1:9119 ' },
      'onboarding-username': { value: 'bob' },
      'onboarding-password': { value: 'ob-secret' },
      'onboarding-profile-name': { value: 'coder' },
      'btn-test-connection': { innerText: 'Test Connection' },
      'btn-save-and-connect': {},
    };
    const mockDoc = {
      getElementById: (id) => inputs[id] ?? null,
      querySelectorAll: () => [],
    };
    globalThis.document = mockDoc;

    const obSecrets = [];
    const obState = { gatewayUrl: '', username: '', password: '', profileName: '', testStatus: null };
    const obCtrl = createOnboardingController({
      getState: () => obState,
      render: () => {},
      connect: () => {},
      testConnection: async () => ({ ok: true, latency: 5 }),
      switchApproval: async () => {},
      getDesktopApi: () => ({
        setGatewaySecret: async (k, v) => {
          obSecrets.push([k, v]);
          return true;
        },
        deleteGatewaySecret: async () => true,
      }),
      t: (k) => k,
    });
    obCtrl.bindDomEvents(mockDoc);
    inputs['onboarding-gateway-url'].oninput();
    inputs['onboarding-username'].oninput();
    inputs['onboarding-password'].oninput();
    inputs['onboarding-profile-name'].oninput();
    assert.equal(obState.password, 'ob-secret');
    assert.equal(lsMap.has('hermes_flux_password'), false);
    assert.equal(lsMap.has('hermes_aura_password'), false);

    await inputs['btn-test-connection'].onclick();
    assert.equal(lsMap.has('hermes_flux_password'), false);
    assert.equal(lsMap.has('hermes_aura_password'), false);
    assert.ok(obSecrets.some(([, v]) => v === 'ob-secret'));

    await inputs['btn-save-and-connect'].onclick();
    await flushMicrotasks();

    // gatewayEventDispatcher connect 写入 non-empty secret 且不落明文密码到 localStorage
    const dispSecrets = [];
    const { deps, state } = createMockDispatcherDeps();
    state.gatewayUrl = 'http://127.0.0.1:9119';
    state.username = 'bob';
    state.password = 'disp-secret';
    deps.getDesktopApi = () => ({
      setGatewaySecret: async (k, v) => {
        dispSecrets.push([k, v]);
        return true;
      },
      deleteGatewaySecret: async () => true,
    });
    deps.testConnection = async () => ({ ok: false, latency: 0, message: 'stop' });
    const dispatcher = createGatewayEventDispatcher(deps);
    await dispatcher.connect();
    await flushMicrotasks();
    assert.equal(lsMap.has('hermes_flux_password'), false);
    assert.equal(lsMap.has('hermes_aura_password'), false);
    assert.ok(dispSecrets.some(([k, v]) => k === 'gw:http://127.0.0.1:9119' && v === 'disp-secret'));
    dispatcher.disconnect();

    state.password = '';
    deps.getDesktopApi = () => ({});
    await dispatcher.connect();
    dispatcher.disconnect();

    state.gatewayUrl = 'bad url';
    state.password = 'x';
    await dispatcher.connect();
    dispatcher.disconnect();

    // appBootstrap 启动时自动从 secretBridge 水合 password (以及无 localStorage 分支)
    delete globalThis.document;
    const bootState = {
      theme: 'obsidian-gold',
      lang: 'zh',
      platform: 'windows',
      gatewayConnected: false,
      gatewayConnecting: false,
      profileName: 'default',
      messages: [],
      availableModels: [],
      modelCatalog: [],
      gatewayUrl: 'http://127.0.0.1:9119',
      password: '',
    };
    const bootstrap = createAppBootstrap({
      getState: () => bootState,
      render: () => {},
      getDesktopApi: () => ({
        getDefaultGatewayConfig: async () => ({ url: '', key: '', profile: 'default' }),
        getGatewaySecret: async (k) => (k === 'gw:http://127.0.0.1:9119' ? 'hydrated-boot-pw' : null),
        setGatewaySecret: async () => true,
      }),
      getGatewayClient: () => null,
      connect: () => {},
      restoreCacheToState: async () => {},
      refreshProfilesFromServer: async () => {},
      syncSystemWindow: async () => {},
      fontPreferences: { family: 'sans-serif', size: 14 },
      logBoot: () => {},
    });
    await bootstrap.init();
    assert.equal(bootState.password, 'hydrated-boot-pw');

    delete globalThis.localStorage;
    bootState.password = '';
    await bootstrap.init();
    assert.equal(bootState.password, 'hydrated-boot-pw');
  } finally {
    if (hadDoc) globalThis.document = savedDoc;
    else delete globalThis.document;
    if (hadStorage) globalThis.localStorage = savedStorage;
    else delete globalThis.localStorage;
  }
});

test('M1.1: mediaStreamProtocol 多网关按 origin 分桶附带 Cookie 并拦截 302 重定向', async () => {
  const pool = new GatewayCookiePool();
  pool.set('https://gw-a.example:9119', 'sid=cookie-a');
  pool.set('https://gw-b.example:9120', 'sid=cookie-b');

  let redirectMode = false;
  let canceledRedirectBody = false;
  const reqLog = [];

  const ctrl = createMediaStreamController({
    nonce: 'media-nonce',
    getGatewayAuth: (targetOrigin) => pool.getSnapshot(targetOrigin),
    getFallbackCwd: () => process.cwd(),
    fetchImpl: async (url, init) => {
      reqLog.push({ url: String(url), init });
      if (redirectMode) {
        return {
          ok: false,
          status: 302,
          headers: new Headers({ location: 'https://evil.example/leak' }),
          body: { cancel: async () => { canceledRedirectBody = true; } },
        };
      }
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { 'content-type': 'video/mp4' },
      });
    },
  });

  const urlA = ctrl.buildStreamUrl({ filePath: '/clip.mp4', gatewayUrl: 'https://gw-a.example:9119' });
  const urlB = ctrl.buildStreamUrl({ filePath: '/clip.mp4', gatewayUrl: 'https://gw-b.example:9120' });
  const resA = await ctrl.handleProtocolRequest(new Request(urlA));
  const resB = await ctrl.handleProtocolRequest(new Request(urlB));
  assert.equal(resA.status, 200);
  assert.equal(resB.status, 200);
  assert.equal(reqLog[0].init.headers.Cookie, 'sid=cookie-a');
  assert.equal(reqLog[1].init.headers.Cookie, 'sid=cookie-b');
  assert.equal(reqLog[0].init.redirect, 'manual');

  redirectMode = true;
  const redirRes = await ctrl.handleProtocolRequest(new Request(urlA));
  assert.equal(redirRes.status, 502);
  assert.equal(canceledRedirectBody, true);
});

test('M1.1: ipc.cjs / main/index.js / preload/index.js 多源代理、安全密钥 IPC 与打包调试口守卫', async () => {
  const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-m1-1-ipc-'));
  const prevFetch = globalThis.fetch;
  const handlers = new Map();
  let exposedBridge = null;

  try {
    const ipcMod = loadCjsWithElectronMock(path.join(desktopDir, 'dist/main/ipc.cjs'), {
      ipcMain: {
        handle: (ch, fn) => handlers.set(ch, fn),
        removeHandler: (ch) => handlers.delete(ch),
        on: () => {},
      },
      BrowserWindow: class {},
      shell: {},
      dialog: {
        showSaveDialog: async () => ({
          canceled: false,
          filePath: path.join(tmpUserData, 'saved.bin'),
        }),
      },
      app: { getPath: () => tmpUserData, getVersion: () => '0.1.0', isPackaged: false },
      clipboard: {},
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (s) => Buffer.from(`enc:${s}`, 'utf8'),
        decryptString: (b) => b.toString('utf8').replace(/^enc:/, ''),
      },
    });

    ipcMod.registerIpcHandlers({
      isDestroyed: () => false,
      isFullScreen: () => false,
      isMaximized: () => false,
      on: () => {},
      webContents: { send: () => {}, isDestroyed: () => false },
    });

    const auth = handlers.get('gateway:authenticate');
    const proxy = handlers.get('gateway:http-proxy');
    const saveFile = handlers.get('fs:save-file');
    const secretSet = handlers.get('secret:set');
    const secretGet = handlers.get('secret:get');
    const secretDelete = handlers.get('secret:delete');
    assert.ok(secretSet && secretGet && secretDelete);

    assert.equal(await secretSet({}, 'gw:https://a.local', 'pw-a'), true);
    assert.equal(await secretGet({}, 'gw:https://a.local'), 'pw-a');
    assert.equal(await secretDelete({}, 'gw:https://a.local'), true);

    const seenProxyCalls = [];
    globalThis.fetch = async (url, init) => {
      const u = String(url);
      seenProxyCalls.push({ url: u, headers: init?.headers || {}, redirect: init?.redirect });
      if (u === 'http://127.0.0.1:9119/api/status') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ auth_required: false, install_id: 'inst-gw-a', version: '0.25.0' }),
        };
      }
      if (u === 'http://127.0.0.1:9120/api/status') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ auth_required: true, install_id: 'inst-gw-b', version: '0.25.0' }),
        };
      }
      if (u === 'http://127.0.0.1:9120/auth/password-login') {
        return {
          ok: true,
          status: 200,
          headers: new Headers({ 'set-cookie': 'sid=cookie-b; Path=/; HttpOnly' }),
        };
      }
      if (u === 'http://127.0.0.1:9120/api/auth/ws-ticket') {
        return { ok: true, status: 200, json: async () => ({ ticket: 'tkt-b' }) };
      }
      if (u.endsWith('/api/redirect-302')) {
        return {
          ok: false,
          status: 302,
          headers: new Headers({ location: 'https://attacker.example/steal' }),
          body: { cancel: async () => {} },
        };
      }
      if (u.endsWith('/api/save-302')) {
        return {
          ok: false,
          status: 302,
          headers: new Headers({ location: 'https://attacker.example/steal' }),
          body: { cancel: async () => {} },
        };
      }
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ ok: true }),
      };
    };

    const resNoAuth = await auth({}, { url: 'http://127.0.0.1:9119' });
    assert.equal(resNoAuth.ok, true);
    assert.equal(resNoAuth.installId, 'inst-gw-a');

    const resB = await auth({}, { url: 'http://127.0.0.1:9120', username: 'u', password: 'p' });
    assert.equal(resB.ok, true);
    assert.equal(resB.installId, 'inst-gw-b');

    await proxy({}, { baseUrl: 'http://127.0.0.1:9119', path: '/api/sessions' });
    await proxy({}, { baseUrl: 'http://127.0.0.1:9120', path: '/api/sessions' });
    assert.equal(seenProxyCalls.at(-2).headers.Cookie, undefined);
    assert.equal(seenProxyCalls.at(-1).headers.Cookie, 'sid=cookie-b');
    assert.equal(seenProxyCalls.at(-1).redirect, 'manual');

    await assert.rejects(
      proxy({}, { baseUrl: 'http://127.0.0.1:9120', path: '/api/redirect-302' }),
      /302/,
    );
    await assert.rejects(
      proxy({}, { baseUrl: 'http://127.0.0.1:9120', path: '/../etc/passwd' }),
      /路径/,
    );

    const save302 = await saveFile(
      {},
      { fileName: 'x.bin', content: '', remoteUrl: 'http://127.0.0.1:9120/api/save-302' },
    );
    assert.equal(save302.success, false);
    assert.match(save302.error, /302|重定向/);

    // 校验 packaged mode 下 main/index.js 绝不附加 remote-debugging-port
    const packagedSwitches = [];
    loadCjsWithElectronMock(path.join(desktopDir, 'dist/main/index.js'), {
      protocol: { registerSchemesAsPrivileged: () => {}, handle: () => {} },
      app: {
        getPath: () => tmpUserData,
        getVersion: () => '0.1.0',
        isPackaged: true,
        requestSingleInstanceLock: () => true,
        quit: () => {},
        whenReady: () => new Promise(() => {}),
        on: () => {},
        commandLine: { appendSwitch: (k, v) => packagedSwitches.push([k, v]) },
      },
      BrowserWindow: class {},
      powerMonitor: { on: () => {}, removeListener: () => {} },
      ipcMain: { handle: () => {}, removeHandler: () => {}, on: () => {} },
      shell: {},
      dialog: {},
      clipboard: {},
      safeStorage: {
        isEncryptionAvailable: () => false,
        encryptString: () => Buffer.alloc(0),
        decryptString: () => '',
      },
    });
    assert.equal(
      packagedSwitches.some(([k]) => k === 'remote-debugging-port'),
      false,
      '生产打包版本不得开启 9222 调试口',
    );

    // 校验 preload 暴露 safeStorage IPC 方法并正确透传通道
    const invoked = [];
    loadCjsWithElectronMock(path.join(desktopDir, 'dist/preload/index.js'), {
      contextBridge: {
        exposeInMainWorld: (_n, api) => {
          exposedBridge = api;
        },
      },
      ipcRenderer: {
        invoke: async (ch, ...args) => {
          invoked.push([ch, args]);
          return handlers.get(ch)?.({}, ...args);
        },
        send: () => {},
        on: () => {},
        removeListener: () => {},
      },
    });
    assert.equal(await exposedBridge.setGatewaySecret('k1', 'v1'), true);
    assert.equal(await exposedBridge.getGatewaySecret('k1'), 'v1');
    assert.equal(await exposedBridge.deleteGatewaySecret('k1'), true);
    assert.deepEqual(invoked, [
      ['secret:set', ['k1', 'v1']],
      ['secret:get', ['k1']],
      ['secret:delete', ['k1']],
    ]);
  } finally {
    globalThis.fetch = prevFetch;
    fs.rmSync(tmpUserData, { recursive: true, force: true });
  }
});

test('M1.1: 源码静态安全守卫 — 禁无条件 9222 与禁 localStorage 明文密码写盘', () => {
  const mainIndexSrc = fs.readFileSync(path.join(desktopDir, 'src/main/index.ts'), 'utf8');
  assert.match(mainIndexSrc, /resolveRemoteDebuggingPort/);
  assert.doesNotMatch(mainIndexSrc, /^\s*app\.commandLine\.appendSwitch\('remote-debugging-port',\s*'9222'\)/m);

  const rendererFiles = [
    'src/renderer/events/onboardingController.ts',
    'src/renderer/gateway/gatewayEventDispatcher.ts',
    'src/renderer/services/settingsStorageHelpers.ts',
  ];
  for (const rel of rendererFiles) {
    const content = fs.readFileSync(path.join(desktopDir, rel), 'utf8');
    assert.equal(
      /setItem\([^)]*(?:hermes_flux_password|hermes_aura_password)/.test(content),
      false,
      `${rel} 禁止写入明文密码到 localStorage`,
    );
    assert.equal(
      /\['hermes_(?:flux|aura)_password'/.test(content),
      false,
      `${rel} 禁止将明文密码放进持久化键值表`,
    );
  }
});
