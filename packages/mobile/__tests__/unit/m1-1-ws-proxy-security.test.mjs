/**
 * M1.1 Mobile Capacitor Bridge & Android GatewayWsProxyServer Security Tests
 * (packages/mobile/__tests__/unit/m1-1-ws-proxy-security.test.mjs)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCapacitorPlatformBridge } from '../../dist/capacitor-bridge.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mobileDir = path.resolve(__dirname, '../..');

test('M1.1: capacitor-bridge 解析 HermesWsProxy/<port>/<nonce> 并在代理 WS URL 附加 token，同时兼容旧 UA', () => {
  const nonceBridge = createCapacitorPlatformBridge({
    platform: 'android',
    userAgent: 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 HermesWsProxy/43125/a1b2c3d4e5f60708',
    isPluginAvailable: () => false,
  });
  assert.equal(typeof nonceBridge.proxyWebSocketUrl, 'function');
  assert.equal(
    nonceBridge.proxyWebSocketUrl('ws://10.0.0.8:8642/api/ws?ticket=abc'),
    'ws://127.0.0.1:43125/__gw/ws?target=ws%3A%2F%2F10.0.0.8%3A8642%2Fapi%2Fws%3Fticket%3Dabc&token=a1b2c3d4e5f60708',
  );

  const legacyBridge = createCapacitorPlatformBridge({
    platform: 'android',
    userAgent: 'Mozilla/5.0 (Linux; Android 14) HermesWsProxy/43126',
    isPluginAvailable: () => false,
  });
  assert.equal(
    legacyBridge.proxyWebSocketUrl('ws://10.0.0.8:8642/api/ws?ticket=abc'),
    'ws://127.0.0.1:43126/__gw/ws?target=ws%3A%2F%2F10.0.0.8%3A8642%2Fapi%2Fws%3Fticket%3Dabc',
  );
});

test('M1.1: mobile authenticateGateway 从 /api/status 提取并透传 installId（免密与认证双路径）', async () => {
  const savedFetch = globalThis.fetch;
  try {
    const mobileBridge = createCapacitorPlatformBridge({
      platform: 'android',
      isPluginAvailable: () => false,
    });

    globalThis.fetch = async (url) => {
      if (String(url).endsWith('/api/status')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ auth_required: false, version: '0.25.0', install_id: 'mob-inst-free' }),
        };
      }
      throw new Error(`unexpected ${url}`);
    };
    const noAuth = await mobileBridge.authenticateGateway({ url: 'https://gw-free.example' });
    assert.equal(noAuth.ok, true);
    assert.equal(noAuth.installId, 'mob-inst-free');

    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.endsWith('/api/status')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ auth_required: true, version: '0.25.0', install_id: 'mob-inst-auth' }),
        };
      }
      if (u.endsWith('/auth/password-login')) {
        return { ok: true, status: 200, headers: new Headers() };
      }
      if (u.endsWith('/api/auth/ws-ticket')) {
        return { ok: true, status: 200, json: async () => ({ ticket: 'mob-tkt' }) };
      }
      throw new Error(`unexpected ${url}`);
    };
    const withAuth = await mobileBridge.authenticateGateway({
      url: 'https://gw-auth.example',
      username: 'u',
      password: 'p',
    });
    assert.equal(withAuth.ok, true);
    assert.equal(withAuth.installId, 'mob-inst-auth');
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test('M1.1: Android GatewayWsProxyServer 与 MainActivity 强制启动随机 nonce 鉴权、目标白名单与敏感地址阻断', () => {
  const proxyJava = fs.readFileSync(
    path.join(mobileDir, 'android/app/src/main/java/com/hermesflux/app/GatewayWsProxyServer.java'),
    'utf8',
  );
  const mainActivityJava = fs.readFileSync(
    path.join(mobileDir, 'android/app/src/main/java/com/hermesflux/app/MainActivity.java'),
    'utf8',
  );

  assert.match(proxyJava, /SecureRandom/, '必须用密码学强随机数生成启动 nonce');
  assert.match(proxyJava, /MessageDigest\.isEqual/, '必须使用常量时间比对校验 token');
  assert.match(proxyJava, /getAuthNonce\(\)/, '必须暴露只读 authNonce 供 MainActivity 注入 WebView UA');
  assert.match(proxyJava, /allowTargetOrigin\(/, '必须支持允许目标网关白名单控制');
  assert.match(proxyJava, /reqUri\.getQueryParameter\("token"\)/, '必须从查询参数校验 token');
  assert.match(proxyJava, /169\.254\./, '必须阻断云元数据 link-local SSRF 地址');
  assert.match(proxyJava, /\.\./, '必须校验路径穿越');

  assert.match(
    mainActivityJava,
    /wsProxyServer\.getAuthNonce\(\)/,
    'MainActivity 必须把每次启动的随机 nonce 注入 WebView User-Agent',
  );
});
