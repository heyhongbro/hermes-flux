/**
 * Hermes Flux Mobile PlatformBridge - Full E2E Headless CDP & Gateway Simulation Test
 * 
 * 【检验目标】
 * 1. 真实验证 packages/mobile/dist/index.html 在无头移动端浏览器中的渲染表现
 * 2. 真实验证 window.hermesMobile 与 window.hermesDesktop 是否正确注入并同构
 * 3. 真实启动本地 Gateway Mock HTTP 服务器，验证 authenticateGateway 与 httpProxy 的网络调用闭环
 * 4. 验证移动端视口（Pixel 8 390x844）下的几何约束：桌面三键物理剥离、对话流占满
 * 5. 断言零 PageError、零未捕获异常
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const EDGE_PATH = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const BROWSER_PATH = fs.existsSync(CHROME_PATH) ? CHROME_PATH : EDGE_PATH;
const CDP_PORT = 9366;

function sendWsTextFrame(socket, text) {
  const payload = Buffer.from(text, 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  socket.write(Buffer.concat([header, payload]));
}

function attachSimpleWsServer(httpServer, onJsonMessage) {
  httpServer.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    if (!key) {
      socket.destroy();
      return;
    }
    const accept = crypto
      .createHash('sha1')
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');
    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${accept}`,
        '\r\n',
      ].join('\r\n'),
    );

    let buffer = Buffer.alloc(0);
    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 2) {
        const opcode = buffer[0] & 0x0f;
        const masked = (buffer[1] & 0x80) !== 0;
        let len = buffer[1] & 0x7f;
        let offset = 2;
        if (len === 126) {
          if (buffer.length < 4) return;
          len = buffer.readUInt16BE(2);
          offset = 4;
        } else if (len === 127) {
          if (buffer.length < 10) return;
          len = Number(buffer.readBigUInt64BE(2));
          offset = 10;
        }
        const maskLen = masked ? 4 : 0;
        if (buffer.length < offset + maskLen + len) return;
        const mask = masked ? buffer.slice(offset, offset + 4) : null;
        const payload = Buffer.from(buffer.slice(offset + maskLen, offset + maskLen + len));
        if (mask) {
          for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
        }
        buffer = buffer.slice(offset + maskLen + len);
        if (opcode === 0x1) {
          try {
            onJsonMessage(JSON.parse(payload.toString('utf8')), (obj) =>
              sendWsTextFrame(socket, JSON.stringify(obj)),
            );
          } catch {}
        } else if (opcode === 0x8) {
          socket.end();
          return;
        }
      }
    });
  });
}

test('Capacitor Mobile PlatformBridge - Live Headless Mobile CDP & Gateway Test', async (t) => {
  if (!fs.existsSync(BROWSER_PATH)) {
    t.skip('Chrome/Edge browser not found on system');
    return;
  }

  const configSetCalls = [];
  const mockSessions = Array.from({ length: 18 }, (_, idx) => ({
    session_id: `sess_mob_${idx + 1}`,
    stored_session_id: `sess_mob_${idx + 1}`,
    title: idx === 0 ? 'Mobile Test Session' : `Session Item ${idx + 1}`,
    profile: 'default',
    last_active: Math.floor(Date.now() / 1000) - idx * 60,
  }));

  // 1. 启动真实的 Mock Gateway HTTP 服务
  const gatewayServer = http.createServer((req, res) => {
    const url = req.url?.split('?')[0] || '';
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-WS-Ticket');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (url === '/api/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        version: '0.22.5',
        auth_required: true,
      }));
      return;
    }

    if (url === '/auth/password-login') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          if (parsed.username === 'admin' && parsed.password === 'pass123') {
            res.setHeader('Set-Cookie', 'hermes_session=token-abc-123; Path=/; HttpOnly');
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, user: 'admin' }));
          } else {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
          }
        } catch {
          res.writeHead(400);
          res.end();
        }
      });
      return;
    }

    if (url === '/api/auth/ws-ticket') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ticket: 'ws-ticket-mobile-998877' }));
      return;
    }

    if (url === '/api/sessions') {
      const profileParam = new URL(req.url || '/api/sessions', 'http://127.0.0.1').searchParams.get('profile');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (profileParam !== null) {
        res.end(JSON.stringify({
          sessions: profileParam !== 'default' ? [] : mockSessions,
        }));
        return;
      }
      res.end(JSON.stringify({
        sessions: [
          { id: 'sess_mob_1', title: 'Mobile Test Session', created_at: Date.now() },
          { id: 'sess_mob_2', title: 'Second Session', created_at: Date.now() - 1000 },
        ],
      }));
      return;
    }

    if (url.startsWith('/api/sessions/') && url.endsWith('/messages')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ messages: [], pagination: { limit: 100, offset: 0, order: 'latest', returned: 0 } }));
      return;
    }

    res.writeHead(404);
    res.end('Not Found');
  });

  attachSimpleWsServer(gatewayServer, (msg, sendReply) => {
    const { id, method, params } = msg;
    if (method === 'ping') {
      sendReply({ jsonrpc: '2.0', id, result: { pong: true } });
    } else if (method === 'profiles.list') {
      sendReply({
        jsonrpc: '2.0',
        id,
        result: {
          profiles: [
            { name: 'default', display_name: 'Default Hub', is_default: true },
            { name: 'arch', display_name: 'Architect', is_default: false },
            { name: 'ops', display_name: 'Ops Guard', is_default: false },
          ],
        },
      });
    } else if (method === 'profiles.describe') {
      const botName = params?.name || 'default';
      const displayNames = { default: 'Default Hub', arch: 'Architect', ops: 'Ops Guard' };
      sendReply({
        jsonrpc: '2.0',
        id,
        result: {
          name: botName,
          display_name: displayNames[botName] || botName,
          description: '',
          soul: '# Soul',
          model: { provider: 'anthropic', default: 'anthropic/claude-sonnet-4' },
          toolsets: [],
          skills: [],
          mcp_servers: [],
        },
      });
    } else if (method === 'session.list') {
      sendReply({
        jsonrpc: '2.0',
        id,
        result: { sessions: params?.profile && params.profile !== 'default' ? [] : mockSessions },
      });
    } else if (method === 'model.options') {
      sendReply({
        jsonrpc: '2.0',
        id,
        result: {
          providers: [
            { slug: 'anthropic', name: 'Anthropic', authenticated: true, current: true, models: ['anthropic/claude-sonnet-4'] },
            { slug: 'openai', name: 'OpenAI', authenticated: true, models: ['openai/gpt-4o'] },
          ],
          model: 'anthropic/claude-sonnet-4',
          provider: 'anthropic',
        },
      });
    } else if (method === 'session.resume') {
      const stored = params?.session_id || 'sess_mob_1';
      sendReply({ jsonrpc: '2.0', id, result: { session_id: `live-${stored}`, stored_session_id: stored, running: false } });
    } else if (method === 'config.set') {
      configSetCalls.push(params);
      sendReply({ jsonrpc: '2.0', id, result: { key: params?.key, value: params?.value } });
    } else if (method === 'groups.list') {
      sendReply({ jsonrpc: '2.0', id, result: { rooms: [] } });
    } else {
      sendReply({ jsonrpc: '2.0', id, result: {} });
    }
  });

  await new Promise(r => gatewayServer.listen(0, '127.0.0.1', r));
  const gwPort = gatewayServer.address().port;
  const gwUrl = `http://127.0.0.1:${gwPort}`;

  // 2. 启动托管 packages/mobile/dist 的静态 Web 服务器
  const mobileDist = path.resolve('packages/mobile/dist');
  const webServer = http.createServer((req, res) => {
    let reqPath = decodeURIComponent(req.url?.split('?')[0] || '/');
    if (reqPath === '/') reqPath = '/index.html';
    const filePath = path.join(mobileDist, reqPath);

    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
    };
    res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
  });

  await new Promise(r => webServer.listen(0, '127.0.0.1', r));
  const webPort = webServer.address().port;
  const webUrl = `http://127.0.0.1:${webPort}/`;

  // 3. 启动无头 Edge 浏览器，配置 Android 移动视口与 UA
  const tmpUserDataDir = path.resolve(os.tmpdir(), `mobile-cdp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  const browserProc = spawn(BROWSER_PATH, [
    `--remote-debugging-port=${CDP_PORT}`,
    '--headless=new',
    `--user-data-dir=${tmpUserDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--window-size=390,844',
  ]);

  let ws = null;
  const cleanup = async () => {
    try { if (ws) ws.close(); } catch {}
    try {
      if (browserProc?.pid) {
        spawn('taskkill', ['/pid', String(browserProc.pid), '/f', '/t']);
      }
    } catch {}
    try { await new Promise(r => webServer.close(r)); } catch {}
    try { await new Promise(r => gatewayServer.close(r)); } catch {}
    try { fs.rmSync(tmpUserDataDir, { recursive: true, force: true }); } catch {}
  };

  t.after(cleanup);

  try {
    // 4. 等待 CDP 端口开放
  let connected = false;
  for (let i = 0; i < 30; i++) {
    try {
      const ver = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`).then(r => r.json());
      if (ver.webSocketDebuggerUrl) {
        connected = true;
        break;
      }
    } catch {}
    await new Promise(r => setTimeout(r, 200));
  }
  assert.ok(connected, 'CDP remote debugging port must be responsive');

  // 5. 发现页面并建立 WebSocket 连接
  const tabs = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then(r => r.json());
  const pageTab = tabs.find(t => t.type === 'page') || tabs[0];
  assert.ok(pageTab?.webSocketDebuggerUrl, 'Must locate a valid page target');

  ws = new WebSocket(pageTab.webSocketDebuggerUrl);
  await new Promise((resolve) => {
    if (ws.readyState === 1) resolve();
    else ws.addEventListener('open', resolve, { once: true });
  });

  let msgId = 1;
  const pendingRequests = new Map();
  const consoleMessages = [];
  const pageErrors = [];

  ws.addEventListener('message', (event) => {
    const raw = typeof event.data === 'string' ? event.data : event.data.toString();
    const msg = JSON.parse(raw);
    if (msg.id && pendingRequests.has(msg.id)) {
      const { resolve, reject } = pendingRequests.get(msg.id);
      pendingRequests.delete(msg.id);
      if (msg.error) reject(msg.error);
      else resolve(msg.result);
    }
    if (msg.method === 'Runtime.consoleAPICalled') {
      consoleMessages.push(msg.params);
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      pageErrors.push(msg.params);
    }
  });

  const send = (method, params = {}) => {
    const id = ++msgId;
    return new Promise((resolve, reject) => {
      pendingRequests.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  };

  // 6. 开启 Runtime、Page 与网络监听，并模拟 Pixel 8 移动视口
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Network.enable');

  try {
    await send('Browser.grantPermissions', {
      permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'],
      origin: webUrl,
    });
  } catch {}

  // 模拟真实 Pixel 8 移动设备指标 (390 x 844, DPR=3, Touch=true, Mobile=true)
  await send('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 3,
    mobile: true,
    hasTouch: true,
  });

  await send('Emulation.setUserAgentOverride', {
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36',
  });

  // 7. 导航至本地移动端页面
  await send('Page.navigate', { url: webUrl });
  await new Promise(r => setTimeout(r, 1500));

  // 8. 断言 1: 检验 window.hermesMobile 与 window.hermesDesktop 注入有效性
  const bridgeCheck = await send('Runtime.evaluate', {
    expression: `(() => {
      const hasMob = typeof window.hermesMobile === 'object' && window.hermesMobile !== null;
      const hasDesk = typeof window.hermesDesktop === 'object' && window.hermesDesktop !== null;
      const isSame = window.hermesMobile === window.hermesDesktop;
      const methods = [
        'getSystemInfo', 'minimize', 'maximize', 'unmaximize', 'close',
        'isMaximized', 'onWindowStateChange', 'getDefaultGatewayConfig',
        'authenticateGateway', 'httpProxy', 'openExternal', 'openFileDialog',
        'readFile', 'saveFile', 'clipboardWrite', 'clipboardRead', 'syncStatusBarAppearance',
        'setGatewaySecret', 'getGatewaySecret', 'deleteGatewaySecret'
      ];
      const missing = methods.filter(m => typeof window.hermesMobile[m] !== 'function');
      return { hasMob, hasDesk, isSame, missing };
    })()`,
    returnByValue: true,
  });

  assert.ok(bridgeCheck.result.value.hasMob, 'window.hermesMobile must be present in WebView');
  assert.ok(bridgeCheck.result.value.hasDesk, 'window.hermesDesktop must be bridged for renderer compatibility');
  assert.ok(bridgeCheck.result.value.isSame, 'window.hermesMobile and window.hermesDesktop must reference the same bridge');
  assert.equal(bridgeCheck.result.value.missing.length, 0, `All bridge methods must be implemented, missing: ${bridgeCheck.result.value.missing.join(', ')}`);

  // 8.1 真实调用 setGatewaySecret / getGatewaySecret / deleteGatewaySecret 闭环测试
  const secSet = await send('Runtime.evaluate', {
    expression: `window.hermesMobile.setGatewaySecret('gw-id:test-gw', 'super-secret-pwd')`,
    awaitPromise: true,
    returnByValue: true,
  });
  assert.equal(secSet.result.value, true, 'setGatewaySecret must return true');

  const secGet = await send('Runtime.evaluate', {
    expression: `window.hermesMobile.getGatewaySecret('gw-id:test-gw')`,
    awaitPromise: true,
    returnByValue: true,
  });
  assert.equal(secGet.result.value, 'super-secret-pwd', 'getGatewaySecret must return saved secret');

  const secDel = await send('Runtime.evaluate', {
    expression: `window.hermesMobile.deleteGatewaySecret('gw-id:test-gw')`,
    awaitPromise: true,
    returnByValue: true,
  });
  assert.equal(secDel.result.value, true, 'deleteGatewaySecret must return true');

  const secGetAfterDel = await send('Runtime.evaluate', {
    expression: `window.hermesMobile.getGatewaySecret('gw-id:test-gw')`,
    awaitPromise: true,
    returnByValue: true,
  });
  assert.equal(secGetAfterDel.result.value, null, 'getGatewaySecret after delete must return null');

  // 9. 断言 2: 检验 getSystemInfo() 返回移动端身份
  const sysInfo = await send('Runtime.evaluate', {
    expression: `window.hermesMobile.getSystemInfo()`,
    awaitPromise: true,
    returnByValue: true,
  });
  assert.equal(sysInfo.result.value.isMobile, true, 'isMobile must be true');
  assert.equal(sysInfo.result.value.isDesktop, false, 'isDesktop must be false');
  assert.ok(['android', 'ios', 'web'].includes(sysInfo.result.value.platform), 'Platform must be mobile/web');

  // 10. 断言 3: 真实调用 authenticateGateway 闭环测试
  const authGood = await send('Runtime.evaluate', {
    expression: `window.hermesMobile.authenticateGateway({
      url: '${gwUrl}',
      username: 'admin',
      password: 'pass123'
    })`,
    awaitPromise: true,
    returnByValue: true,
  });
  assert.equal(authGood.result.value.ok, true, 'authenticateGateway must succeed with valid credentials');
  assert.equal(authGood.result.value.ticket, 'ws-ticket-mobile-998877', 'Must receive WS ticket from simulated gateway');

  // 密码错误反向测试 (证伪能力)
  const authBad = await send('Runtime.evaluate', {
    expression: `window.hermesMobile.authenticateGateway({
      url: '${gwUrl}',
      username: 'admin',
      password: 'wrong_password'
    })`,
    awaitPromise: true,
    returnByValue: true,
  });
  assert.equal(authBad.result.value.ok, false, 'authenticateGateway must fail with wrong password');

  // 11. 断言 4: 真实调用 httpProxy 闭环拉取会话列表
  const proxyResult = await send('Runtime.evaluate', {
    expression: `window.hermesMobile.httpProxy({
      baseUrl: '${gwUrl}',
      path: '/api/sessions',
      method: 'GET'
    })`,
    awaitPromise: true,
    returnByValue: true,
  });
  assert.ok(Array.isArray(proxyResult.result.value.sessions), 'httpProxy must retrieve sessions array');
  assert.equal(proxyResult.result.value.sessions.length, 2, 'Must match mock gateway sessions count');

  // 12. 断言 5: 真实调用 clipboardWrite 验证剪贴板接口
  const clipResult = await send('Runtime.evaluate', {
    expression: `window.hermesMobile.clipboardWrite('Hello Hermes Mobile CDP')`,
    awaitPromise: true,
    returnByValue: true,
  });
  assert.equal(clipResult.result.value, true, 'clipboardWrite must return true');

  // 13. 断言 6: 移动视口几何物理断言
  const geometry = await send('Runtime.evaluate', {
    expression: `(() => {
      // 桌面窗口三键在 390px 视口下必须被完全隐藏 (display: none)
      const winButtons = document.querySelectorAll('.win-cap-btn, #btn-win-min, #btn-win-max, #btn-win-close');
      let visibleButtons = 0;
      winButtons.forEach(b => {
        const style = window.getComputedStyle(b);
        if (style.display !== 'none' && style.visibility !== 'hidden') visibleButtons++;
      });
      return {
        visibleButtons,
        scrollWidth: document.documentElement.scrollWidth,
        windowWidth: window.innerWidth
      };
    })()`,
    returnByValue: true,
  });
  assert.equal(geometry.result.value.visibleButtons, 0, 'Desktop window caption buttons must be completely stripped in mobile viewport');
  assert.ok(geometry.result.value.scrollWidth <= geometry.result.value.windowWidth + 2, 'No horizontal scroll overflow in mobile viewport');

  // 14. 断言 7: 真实 MobileWorkspaceShell 挂载、三段首屏、即发新建页下沉与 Android 返回栈验证
  const shellMount = await send('Runtime.evaluate', {
    expression: `(() => {
      const shell = document.querySelector('[data-testid="mobile-workspace-shell"]');
      const desktopBody = document.querySelector('.flux-body-container');
      const botsSec = document.querySelector('[data-section="bots"]');
      const groupsSec = document.querySelector('[data-section="groups"]');
      const sessionsSec = document.querySelector('[data-section="sessions"]');
      return {
        mounted: Boolean(shell),
        activePane: shell?.getAttribute('data-active-pane') || null,
        hasDesktopBody: Boolean(desktopBody),
        hasBots: Boolean(botsSec),
        hasGroups: Boolean(groupsSec),
        hasSessions: Boolean(sessionsSec),
      };
    })()`,
    returnByValue: true,
  });
  assert.equal(shellMount.result.value.mounted, true, 'MobileWorkspaceShell must mount on Android 390x844 viewport');
  assert.equal(shellMount.result.value.activePane, 'home', 'Initial pane must be home');
  assert.equal(shellMount.result.value.hasDesktopBody, false, 'Desktop 3-rail .flux-body-container must not mount on mobile');
  assert.equal(shellMount.result.value.hasBots, true);
  assert.equal(shellMount.result.value.hasGroups, false, 'Empty groupRooms must hide [data-section="groups"]');
  assert.equal(shellMount.result.value.hasSessions, true);

  // 14a. 验证悬浮顶栏胶囊、纯净浅白皮肤 (jade-white)、设置分级菜单与 Bot Hub 页面零横向溢出
  const floatTopCheck = await send('Runtime.evaluate', {
    expression: `(() => {
      const sw = document.querySelector('[data-testid="mobile-home-tab-switcher"]');
      const searchBtn = document.querySelector('[data-testid="mobile-search-trigger"]');
      const newBtn = document.querySelector('[data-testid="mobile-new-chat-trigger"]');
      const setBtn = document.querySelector('[data-testid="mobile-settings-trigger"]');
      const rSw = sw?.getBoundingClientRect();
      const rSet = setBtn?.getBoundingClientRect();
      return {
        hasSwitcher: Boolean(sw && searchBtn && newBtn && setBtn),
        switcherH: rSw?.height ?? 0,
        setW: rSet?.width ?? 0,
        setH: rSet?.height ?? 0,
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
      };
    })()`,
    returnByValue: true,
  });
  assert.equal(floatTopCheck.result.value.hasSwitcher, true, 'Floating home tab switcher & circular top buttons must render');
  assert.ok(floatTopCheck.result.value.switcherH >= 44, 'Floating switcher must meet >=44px touch height');
  assert.ok(floatTopCheck.result.value.setW >= 44 && floatTopCheck.result.value.setH >= 44, 'Floating settings button must be >=44x44');

  // 点开设置一级分级菜单 -> 进入 appearance 切换纯净浅白 -> 验证 jade-white (#F8F9FA = rgb(248, 249, 250)) -> 进入 providers 验证无溢出 -> 退出设置
  await send('Runtime.evaluate', {
    expression: `document.querySelector('[data-testid="mobile-settings-trigger"]')?.click()`,
  });
  await new Promise((r) => setTimeout(r, 150));

  const settingsMenuCheck = await send('Runtime.evaluate', {
    expression: `(() => {
      const settingsZ = Number(window.getComputedStyle(document.querySelector('.m-settings-page')).zIndex);
      const botSubZ = Number(window.getComputedStyle(document.querySelector('.m-bot-subpage')).zIndex);
      return {
        settingsAboveBotSubpage: Number.isFinite(settingsZ) && Number.isFinite(botSubZ) && botSubZ < settingsZ,
        settingsZ,
        botSubZ,
        hasAppearance: Boolean(document.querySelector('[data-testid="mobile-settings-row-appearance"]')),
        hasGateway: Boolean(document.querySelector('[data-testid="mobile-settings-row-gateway"]')),
        hasProviders: Boolean(document.querySelector('[data-testid="mobile-settings-row-providers"]')),
        hasExtensions: Boolean(document.querySelector('[data-testid="mobile-settings-row-extensions"]')),
        hasAbout: Boolean(document.querySelector('[data-testid="mobile-settings-row-about"]')),
        hasInlineGatewayInput: Boolean(document.querySelector('.m-settings-page input[type="url"]')),
      };
    })()`,
    returnByValue: true,
  });
  assert.equal(settingsMenuCheck.result.value.settingsAboveBotSubpage, true, `.m-settings-page zIndex (${settingsMenuCheck.result.value.settingsZ}) must exceed .m-bot-subpage zIndex (${settingsMenuCheck.result.value.botSubZ})`);
  assert.equal(settingsMenuCheck.result.value.hasAppearance && settingsMenuCheck.result.value.hasGateway && settingsMenuCheck.result.value.hasProviders && settingsMenuCheck.result.value.hasExtensions && settingsMenuCheck.result.value.hasAbout, true, 'Root settings must present grouped drill-down menu rows');
  assert.equal(settingsMenuCheck.result.value.hasInlineGatewayInput, false, 'Root settings must not inline-expand gateway form directly');

  await send('Runtime.evaluate', {
    expression: `document.querySelector('[data-testid="mobile-settings-row-appearance"]')?.click()`,
  });
  await new Promise((r) => setTimeout(r, 120));
  await send('Runtime.evaluate', {
    expression: `document.querySelector('[data-appearance-opt="light"]')?.click()`,
  });
  await new Promise((r) => setTimeout(r, 150));

  const crispWhiteCheck = await send('Runtime.evaluate', {
    expression: `(() => {
      const themeAttr = document.documentElement.getAttribute('data-theme');
      const bgToken = window.getComputedStyle(document.documentElement).getPropertyValue('--background').trim();
      const shellBg = window.getComputedStyle(document.querySelector('.m-shell')).backgroundColor;
      return { themeAttr, bgToken, shellBg };
    })()`,
    returnByValue: true,
  });
  assert.equal(crispWhiteCheck.result.value.themeAttr, 'jade-white', 'Mobile light preference must resolve to neutral crisp jade-white instead of yellowish ayu-light');
  assert.equal(crispWhiteCheck.result.value.shellBg, 'rgb(248, 249, 250)', 'Mobile shell background must compute to crisp #F8F9FA white');

  // 返回根目录 -> 进入 providers -> 退回关闭设置
  await send('Runtime.evaluate', {
    expression: `document.querySelector('[data-testid="mobile-settings-back"]')?.click()`,
  });
  await new Promise((r) => setTimeout(r, 100));
  await send('Runtime.evaluate', {
    expression: `document.querySelector('[data-testid="mobile-settings-row-providers"]')?.click()`,
  });
  await new Promise((r) => setTimeout(r, 120));
  const providersLayoutCheck = await send('Runtime.evaluate', {
    expression: `(() => {
      const panel = document.querySelector('[data-testid="mobile-settings-providers"]');
      const smallBtns = Array.from(panel?.querySelectorAll('button') || [])
        .filter((b) => {
          const r = b.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && (r.width < 44 || r.height < 44);
        })
        .map((b) => ({ text: b.textContent?.trim(), w: b.getBoundingClientRect().width, h: b.getBoundingClientRect().height }));
      return {
        hasProvidersPanel: Boolean(panel),
        smallBtns,
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
      };
    })()`,
    returnByValue: true,
  });
  assert.equal(providersLayoutCheck.result.value.hasProvidersPanel, true);
  assert.deepEqual(providersLayoutCheck.result.value.smallBtns, [], 'All visible embedded settings buttons must be >=44x44px');
  assert.ok(providersLayoutCheck.result.value.scrollWidth <= providersLayoutCheck.result.value.innerWidth + 2, 'Providers subpage must fit 390px viewport with zero horizontal overflow');

  // 退回菜单并进入 extensions，验证无横向溢出与按钮热区 >=44px
  await send('Runtime.evaluate', {
    expression: `document.querySelector('[data-testid="mobile-settings-back"]')?.click()`,
  });
  await new Promise((r) => setTimeout(r, 120));
  await send('Runtime.evaluate', {
    expression: `document.querySelector('[data-testid="mobile-settings-row-extensions"]')?.click()`,
  });
  await new Promise((r) => setTimeout(r, 120));
  const extensionsLayoutCheck = await send('Runtime.evaluate', {
    expression: `(() => {
      const smallPills = Array.from(document.querySelectorAll('.m-settings-embedded-panel button'))
        .filter((b) => {
          const r = b.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && (r.width < 44 || r.height < 44);
        })
        .map((b) => b.textContent?.trim());
      return {
        smallPills,
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
      };
    })()`,
    returnByValue: true,
  });
  assert.deepEqual(extensionsLayoutCheck.result.value.smallPills, [], 'Extensions subpage buttons must meet >=44x44px');
  assert.ok(extensionsLayoutCheck.result.value.scrollWidth <= extensionsLayoutCheck.result.value.innerWidth + 2, 'Extensions subpage must fit 390px viewport cleanly');

  await send('Runtime.evaluate', {
    expression: `document.querySelector('[data-testid="mobile-settings-back"]')?.click()`,
  });
  await new Promise((r) => setTimeout(r, 120));
  await send('Runtime.evaluate', {
    expression: `document.querySelector('[data-testid="mobile-settings-back"]')?.click()`,
  });
  await new Promise((r) => setTimeout(r, 160));
  const settingsClosedCheck = await send('Runtime.evaluate', {
    expression: `document.querySelector('.m-settings-page')?.getAttribute('data-open')`,
    returnByValue: true,
  });
  assert.equal(settingsClosedCheck.result.value, 'false', 'Two back clicks must close settings subpage then settings sheet');

  // 切换到 Bot Hub 页 -> 验证离线空态不伪造数据、>=44px 触控热区、零溢出、向导底栏与两段硬件返回栈
  await send('Runtime.evaluate', {
    expression: `document.querySelector('[data-testid="mobile-tab-bots"]')?.click()`,
  });
  await new Promise((r) => setTimeout(r, 150));

  const botHubCheck = await send('Runtime.evaluate', {
    expression: `(() => {
      const hub = document.querySelector('[data-testid="mobile-bot-hub"]');
      const createBtn = document.querySelector('[data-testid="mobile-bot-create-trigger"]');
      const rCreate = createBtn?.getBoundingClientRect();
      const emptyBox = hub?.querySelector('.m-bot-hub__empty');
      const offlineBanner = hub?.querySelector('.m-home__offline-banner');
      return {
        hasHub: Boolean(hub),
        hasCreateBtn: Boolean(createBtn),
        createW: rCreate?.width ?? 0,
        createH: rCreate?.height ?? 0,
        hasEmpty: Boolean(emptyBox),
        hasOfflineBanner: Boolean(offlineBanner),
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
      };
    })()`,
    returnByValue: true,
  });
  assert.equal(botHubCheck.result.value.hasHub, true, 'Switching to Bots tab must render MobileBotHubScreen');
  assert.equal(botHubCheck.result.value.hasCreateBtn, true, 'Bots tab must show + create Bot floating button');
  assert.ok(botHubCheck.result.value.createW >= 44 && botHubCheck.result.value.createH >= 44, 'Create Bot button must meet >=44x44 touch target');
  assert.equal(botHubCheck.result.value.hasEmpty && botHubCheck.result.value.hasOfflineBanner, true, 'Offline Bots tab with 0 profiles must show explicit empty & offline state');
  assert.ok(botHubCheck.result.value.scrollWidth <= botHubCheck.result.value.innerWidth + 2, 'Bot Hub must have zero horizontal overflow');

  await send('Runtime.evaluate', {
    expression: `document.querySelector('[data-testid="mobile-bot-create-trigger"]')?.click()`,
  });
  await new Promise((r) => setTimeout(r, 140));
  const wizardCheck = await send('Runtime.evaluate', {
    expression: `(() => {
      const sheet = document.querySelector('.m-bottom-sheet');
      const input = sheet?.querySelector('input.m-matte-input');
      return {
        hasSheet: Boolean(sheet),
        sheetBg: sheet ? window.getComputedStyle(sheet).backgroundColor : null,
        inputBg: input ? window.getComputedStyle(input).backgroundColor : null,
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
      };
    })()`,
    returnByValue: true,
  });
  assert.equal(wizardCheck.result.value.hasSheet, true, 'Clicking create Bot button must open MobileBotWizardSheet');
  assert.equal(wizardCheck.result.value.sheetBg, 'rgb(248, 249, 250)', 'Bottom sheet in jade-white must use --background (#F8F9FA) to contrast white inputs');
  assert.equal(wizardCheck.result.value.inputBg, 'rgb(255, 255, 255)', 'Inputs inside bottom sheet must use --card (#FFFFFF) in jade-white');
  assert.ok(wizardCheck.result.value.scrollWidth <= wizardCheck.result.value.innerWidth + 2, 'MobileBotWizardSheet must have zero horizontal overflow');

  // 连按两次硬件返回（逐帧等待状态提交）：第一次关 Bot 向导，第二次从 Bots tab 切回 Chats tab
  await send('Runtime.evaluate', {
    expression: `window.dispatchEvent(new CustomEvent('hermes-mobile-back', { cancelable: true }))`,
  });
  await new Promise((r) => setTimeout(r, 120));
  const wizardClosedCheck = await send('Runtime.evaluate', {
    expression: `({
      sheetGone: !document.querySelector('.m-bottom-sheet'),
      stillOnHub: Boolean(document.querySelector('[data-testid="mobile-bot-hub"]')),
    })`,
    returnByValue: true,
  });
  assert.equal(wizardClosedCheck.result.value.sheetGone && wizardClosedCheck.result.value.stillOnHub, true, 'First back must close Bot wizard while remaining on Bot Hub');

  await send('Runtime.evaluate', {
    expression: `window.dispatchEvent(new CustomEvent('hermes-mobile-back', { cancelable: true }))`,
  });
  await new Promise((r) => setTimeout(r, 140));
  const backToChatsCheck = await send('Runtime.evaluate', {
    expression: `Boolean(document.querySelector('[data-testid="mobile-new-chat-trigger"]'))`,
    returnByValue: true,
  });
  assert.equal(backToChatsCheck.result.value, true, 'Second back from Bots root tab must return to Chats tab');

  await send('Runtime.evaluate', {
    expression: `document.querySelector('[data-testid="mobile-new-chat-trigger"]')?.click()`,
  });
  await new Promise((r) => setTimeout(r, 150));

  const newChatOpenCheck = await send('Runtime.evaluate', {
    expression: `(() => {
      const sheet = document.querySelector('.m-page-sheet');
      const main = document.querySelector('.m-shell__main');
      return {
        sheetOpen: Boolean(sheet),
        mainSunk: main?.getAttribute('data-sunk') === 'true',
      };
    })()`,
    returnByValue: true,
  });
  assert.equal(newChatOpenCheck.result.value.sheetOpen, true, 'Clicking + must open instant New Chat page sheet');
  assert.equal(newChatOpenCheck.result.value.mainSunk, true, 'Main canvas must sink with scale(0.935) when sheet opens');

  const backSheetCheck = await send('Runtime.evaluate', {
    expression: `(() => {
      const ev = new CustomEvent('hermes-mobile-back', { cancelable: true });
      const notConsumed = window.dispatchEvent(ev);
      return { defaultPrevented: ev.defaultPrevented, notConsumed };
    })()`,
    returnByValue: true,
  });
  assert.equal(backSheetCheck.result.value.defaultPrevented, true, 'hermes-mobile-back must consume and close open New Chat sheet');
  await new Promise((r) => setTimeout(r, 150));

  const backRootCheck = await send('Runtime.evaluate', {
    expression: `(() => {
      const sheetStillOpen = Boolean(document.querySelector('.m-page-sheet'));
      const ev = new CustomEvent('hermes-mobile-back', { cancelable: true });
      const notConsumed = window.dispatchEvent(ev);
      return { sheetStillOpen, defaultPrevented: ev.defaultPrevented, notConsumed };
    })()`,
    returnByValue: true,
  });
  assert.equal(backRootCheck.result.value.sheetStillOpen, false, 'New Chat sheet must be closed after first back event');
  assert.equal(backRootCheck.result.value.defaultPrevented, false, 'Root home screen must leave back event unconsumed for minimizeApp');

  // 15. 断言 8: 验证中屏舞台 CSS 优先级、1 行输入舱高度与非桌面 ID 解耦（防 #dock-prompt-input 劫持）
  const stageGeometry = await send('Runtime.evaluate', {
    expression: `(() => {
      const stream = document.querySelector('#conversation-stream.m-stage__stream');
      const mobileInput = document.getElementById('mobile-stage-prompt-input');
      const legacyDockInput = document.getElementById('dock-prompt-input');
      const paddingTop = stream ? parseFloat(window.getComputedStyle(stream).paddingTop) : 0;
      const inputHeight = mobileInput ? mobileInput.getBoundingClientRect().height : 0;
      return {
        hasStream: Boolean(stream),
        paddingTop,
        hasMobileInput: Boolean(mobileInput),
        hasLegacyDockInput: Boolean(legacyDockInput),
        inputHeight,
      };
    })()`,
    returnByValue: true,
  });
  assert.equal(stageGeometry.result.value.hasStream, true, 'Mobile stage stream must mount');
  assert.ok(stageGeometry.result.value.paddingTop >= 88, `Mobile stage paddingTop must clear floating presence scrim (>=88px), got ${stageGeometry.result.value.paddingTop}`);
  assert.equal(stageGeometry.result.value.hasMobileInput, true, 'Mobile composer must use #mobile-stage-prompt-input');
  assert.equal(stageGeometry.result.value.hasLegacyDockInput, false, 'Mobile shell must not render desktop #dock-prompt-input');
  assert.ok(stageGeometry.result.value.inputHeight > 0 && stageGeometry.result.value.inputHeight < 50, `Collapsed mobile input pill height must stay compact (<50px), got ${stageGeometry.result.value.inputHeight}`);

  // 16. 断言 9: 软键盘避让物理几何回归断言（Android adjustResize 缩视口 / iOS --keyboard-height / 新建页避让 + overflow: clip 防滚移）
  // 16a. 滑动进入中屏 stage，验证 Android adjustResize 下（390x504 + --keyboard-height: 0px）输入舱贴底且不被顶到屏幕最顶端
  await send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: 320, y: 400 }],
  });
  await send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ x: 120, y: 400 }],
  });
  await send('Input.dispatchTouchEvent', {
    type: 'touchEnd',
    touchPoints: [],
  });
  await new Promise((r) => setTimeout(r, 420));

  await send('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 504,
    deviceScaleFactor: 3,
    mobile: true,
    hasTouch: true,
  });
  await send('Runtime.evaluate', {
    expression: `document.documentElement.style.setProperty('--keyboard-height', '0px')`,
  });
  await new Promise((r) => setTimeout(r, 150));

  const androidKbGeom = await send('Runtime.evaluate', {
    expression: `(() => {
      const dock = document.querySelector('.m-stage__composer-dock');
      const composer = document.querySelector('.m-stage .m-composer');
      const shell = document.querySelector('.m-shell');
      const main = document.querySelector('.m-shell__main');
      const pane = document.querySelector('.m-pane.m-stage');
      const cRect = composer ? composer.getBoundingClientRect() : null;
      const dRect = dock ? dock.getBoundingClientRect() : null;
      return {
        innerHeight: window.innerHeight,
        cRect: cRect ? { top: cRect.top, bottom: cRect.bottom, height: cRect.height } : null,
        dRect: dRect ? { top: dRect.top, bottom: dRect.bottom, height: dRect.height } : null,
        shellScrollLeft: shell?.scrollLeft ?? -1,
        shellScrollTop: shell?.scrollTop ?? -1,
        mainScrollLeft: main?.scrollLeft ?? -1,
        mainScrollTop: main?.scrollTop ?? -1,
        paneScrollLeft: pane?.scrollLeft ?? -1,
        paneScrollTop: pane?.scrollTop ?? -1,
      };
    })()`,
    returnByValue: true,
  });
  assert.equal(androidKbGeom.result.value.innerHeight, 504);
  assert.ok(
    androidKbGeom.result.value.cRect &&
      androidKbGeom.result.value.cRect.bottom <= 504 &&
      androidKbGeom.result.value.cRect.bottom >= 480 &&
      androidKbGeom.result.value.cRect.top >= 340,
    `Android adjustResize 下输入舱必须稳固贴在 504px 视口底部上方，不得被顶到顶部: ${JSON.stringify(androidKbGeom.result.value)}`,
  );
  assert.equal(androidKbGeom.result.value.shellScrollLeft, 0);
  assert.equal(androidKbGeom.result.value.shellScrollTop, 0);
  assert.equal(androidKbGeom.result.value.mainScrollLeft, 0);
  assert.equal(androidKbGeom.result.value.mainScrollTop, 0);
  assert.equal(androidKbGeom.result.value.paneScrollLeft, 0);
  assert.equal(androidKbGeom.result.value.paneScrollTop, 0);

  // 16b. iOS KeyboardResize.None 模拟：恢复 390x844 并等待 Chromium visualViewport resize 事件落定后注入 --keyboard-height: 336px
  await send('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 3,
    mobile: true,
    hasTouch: true,
  });
  await new Promise((r) => setTimeout(r, 120));
  await send('Runtime.evaluate', {
    expression: `document.documentElement.style.setProperty('--keyboard-height', '336px')`,
  });
  await new Promise((r) => setTimeout(r, 150));

  const iosKbGeom = await send('Runtime.evaluate', {
    expression: `(() => {
      const composer = document.querySelector('.m-stage .m-composer');
      const r = composer ? composer.getBoundingClientRect() : null;
      return r ? { top: r.top, bottom: r.bottom, height: r.height } : null;
    })()`,
    returnByValue: true,
  });
  assert.ok(
    iosKbGeom.result.value &&
      iosKbGeom.result.value.bottom <= 508 &&
      iosKbGeom.result.value.bottom >= 484,
    `iOS KeyboardResize.None 下输入舱底边必须紧贴 844-336=508px 上方: ${JSON.stringify(iosKbGeom.result.value)}`,
  );

  // 重置 --keyboard-height 并退回 home 屏
  await send('Runtime.evaluate', {
    expression: `(() => {
      document.documentElement.style.setProperty('--keyboard-height', '0px');
      window.dispatchEvent(new CustomEvent('hermes-mobile-back', { cancelable: true }));
    })()`,
  });
  await new Promise((r) => setTimeout(r, 200));

  // 16c. 打开新建会话 Page Sheet，缩小视口至 390x440 并在 Step 2 聚焦可编辑输入框，验证底栏不被挤出且 overflow: clip 不产生滚移
  await send('Runtime.evaluate', {
    expression: `document.querySelector('[data-testid="mobile-new-chat-trigger"]')?.click()`,
  });
  await new Promise((r) => setTimeout(r, 150));
  await send('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 440,
    deviceScaleFactor: 3,
    mobile: true,
    hasTouch: true,
  });
  await new Promise((r) => setTimeout(r, 150));

  const newChatKbGeom = await send('Runtime.evaluate', {
    expression: `(() => {
      const wrap = document.querySelector('.m-newchat__composer-wrap');
      const r = wrap ? wrap.getBoundingClientRect() : null;
      return r ? { top: r.top, bottom: r.bottom, height: r.height } : null;
    })()`,
    returnByValue: true,
  });
  assert.ok(
    newChatKbGeom.result.value &&
      newChatKbGeom.result.value.height > 0 &&
      newChatKbGeom.result.value.bottom <= 440 &&
      newChatKbGeom.result.value.top >= 220,
    `新建页键盘压缩视口(440px)下底部输入舱必须完整保留在视口底端: ${JSON.stringify(newChatKbGeom.result.value)}`,
  );

  // 切到 Step 2 聚焦输入框，验证父裁切层不发生 scrollLeft/scrollTop 错位
  await send('Runtime.evaluate', {
    expression: `(() => {
      document.querySelector('.m-target-pill')?.click();
      setTimeout(() => {
        document.querySelector('[data-testid="mobile-newchat-start-group"]')?.click();
        setTimeout(() => {
          const inp = document.querySelector('.m-newchat__step[data-active="true"] input.m-matte-input');
          inp?.focus();
        }, 50);
      }, 50);
    })()`,
  });
  await new Promise((r) => setTimeout(r, 250));

  const clipScrollCheck = await send('Runtime.evaluate', {
    expression: `(() => {
      const sheet = document.querySelector('.m-page-sheet');
      const shell = document.querySelector('.m-shell');
      const main = document.querySelector('.m-shell__main');
      return {
        sheetScrollLeft: sheet?.scrollLeft ?? -1,
        sheetScrollTop: sheet?.scrollTop ?? -1,
        shellScrollLeft: shell?.scrollLeft ?? -1,
        shellScrollTop: shell?.scrollTop ?? -1,
        mainScrollLeft: main?.scrollLeft ?? -1,
        mainScrollTop: main?.scrollTop ?? -1,
      };
    })()`,
    returnByValue: true,
  });
  assert.equal(clipScrollCheck.result.value.sheetScrollLeft, 0);
  assert.equal(clipScrollCheck.result.value.sheetScrollTop, 0);
  assert.equal(clipScrollCheck.result.value.shellScrollLeft, 0);
  assert.equal(clipScrollCheck.result.value.shellScrollTop, 0);
  assert.equal(clipScrollCheck.result.value.mainScrollLeft, 0);
  assert.equal(clipScrollCheck.result.value.mainScrollTop, 0);

  // 恢复视口并关闭新建页（逐帧等待两次返回生效：Step 2 -> Step 1 -> 彻底关闭）
  await send('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 3,
    mobile: true,
    hasTouch: true,
  });
  await send('Runtime.evaluate', {
    expression: `window.dispatchEvent(new CustomEvent('hermes-mobile-back', { cancelable: true }))`,
  });
  await new Promise((r) => setTimeout(r, 120));
  await send('Runtime.evaluate', {
    expression: `window.dispatchEvent(new CustomEvent('hermes-mobile-back', { cancelable: true }))`,
  });
  await new Promise((r) => setTimeout(r, 150));
  const newChatClosedAfterKb = await send('Runtime.evaluate', {
    expression: `Boolean(document.querySelector('.m-page-sheet'))`,
    returnByValue: true,
  });
  assert.equal(newChatClosedAfterKb.result.value, false, 'Two back events must close New Chat sheet before Bot carousel swipe test');

  // 16d. 连接模拟网关 WS，实测验证首页折叠/展开零横向飘移、Bot 头像左右滑动切换、对话/新建页模型选择器弹出可见与 config.set 真实生效
  await send('Runtime.evaluate', {
    expression: `(() => {
      window.__fluxState.username = 'admin';
      window.__fluxState.password = 'pass123';
      window.__fluxState.gatewayUrl = '${gwUrl}';
      window.__fluxState.sessions = [
        ...window.__fluxState.sessions,
      ];
      return window.__fluxConnect('${gwUrl}');
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });

  // 等待 profiles / sessions / modelOptions 到位
  for (let i = 0; i < 40; i++) {
    const ready = await send('Runtime.evaluate', {
      expression: `Boolean(
        window.__fluxState.gatewayConnected &&
        window.__fluxState.profiles.length >= 3 &&
        window.__fluxState.sessions.length >= 15 &&
        window.__fluxState.availableModels.length >= 2
      )`,
      returnByValue: true,
    });
    if (ready.result.value) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  await new Promise((r) => setTimeout(r, 200));

  // 给第一个 Bot 注入时间戳与副标题后折叠普通会话 -> 记录坐标 -> 展开使内容溢出 -> 断言 0px 横向偏移
  const driftCheck = await (async () => {
    await send('Runtime.evaluate', {
      expression: `(() => {
        window.__fluxState.profiles = window.__fluxState.profiles.map((p, idx) => ({
          ...p,
          lastTime: '15:42',
          lastMessage: idx === 0 ? '这是一段足够长的首页副标题用来检测展开折叠是否发生横向位移' : p.lastMessage,
        }));
        window.__fluxRender();
        const sessHeader = document.querySelector('[data-section="sessions"] .m-section__header');
        const sessSec = document.querySelector('[data-section="sessions"]');
        if (sessSec?.getAttribute('data-expanded') === 'true') sessHeader?.click();
      })()`,
    });
    await new Promise((r) => setTimeout(r, 360));

    const before = await send('Runtime.evaluate', {
      expression: `(() => {
        const scroll = document.querySelector('.m-home__scroll');
        const botRow = document.querySelector('.m-section[data-section="bots"] .m-entity-row');
        const timeEl = botRow?.querySelector('.m-entity-row__time');
        const subEl = botRow?.querySelector('.m-entity-row__subtitle');
        return {
          overflowCollapsed: scroll ? scroll.scrollHeight > scroll.clientHeight : false,
          rowWidth: botRow?.getBoundingClientRect().width ?? 0,
          timeRight: timeEl?.getBoundingClientRect().right ?? 0,
          subLeft: subEl?.getBoundingClientRect().left ?? 0,
          subWidth: subEl?.getBoundingClientRect().width ?? 0,
        };
      })()`,
      returnByValue: true,
    });

    await send('Runtime.evaluate', {
      expression: `document.querySelector('[data-section="sessions"] .m-section__header')?.click()`,
    });
    await new Promise((r) => setTimeout(r, 380));

    const after = await send('Runtime.evaluate', {
      expression: `(() => {
        const scroll = document.querySelector('.m-home__scroll');
        const botRow = document.querySelector('.m-section[data-section="bots"] .m-entity-row');
        const timeEl = botRow?.querySelector('.m-entity-row__time');
        const subEl = botRow?.querySelector('.m-entity-row__subtitle');
        return {
          overflowExpanded: scroll ? scroll.scrollHeight > scroll.clientHeight : false,
          rowWidth: botRow?.getBoundingClientRect().width ?? 0,
          timeRight: timeEl?.getBoundingClientRect().right ?? 0,
          subLeft: subEl?.getBoundingClientRect().left ?? 0,
          subWidth: subEl?.getBoundingClientRect().width ?? 0,
        };
      })()`,
      returnByValue: true,
    });

    return { before: before.result.value, after: after.result.value };
  })();

  assert.equal(driftCheck.after.overflowExpanded, true, 'Expanding 18 sessions must overflow .m-home__scroll vertically');
  assert.ok(
    Math.abs(driftCheck.after.timeRight - driftCheck.before.timeRight) < 0.5 &&
      Math.abs(driftCheck.after.subLeft - driftCheck.before.subLeft) < 0.5 &&
      Math.abs(driftCheck.after.rowWidth - driftCheck.before.rowWidth) < 0.5,
    `Home bot row must have 0px horizontal drift when toggling sessions section: ${JSON.stringify(driftCheck)}`,
  );

  // 16e. Bot Hub 头像轮播左右水平滑动切换实测
  await send('Runtime.evaluate', {
    expression: `document.querySelector('[data-testid="mobile-tab-bots"]')?.click()`,
  });
  await new Promise((r) => setTimeout(r, 260));

  const carouselRect = await send('Runtime.evaluate', {
    expression: `(() => {
      const hero = document.querySelector('.m-bot-hero');
      const el = document.querySelector('[data-testid="mobile-bot-carousel"]');
      const rHero = hero?.getBoundingClientRect();
      const r = el?.getBoundingClientRect();
      const name = document.querySelector('.m-bot-hub__name')?.textContent?.trim() || '';
      return {
        x: r ? Math.round(r.left + r.width / 2) : 0,
        y: r ? Math.round(r.top + r.height / 2) : 0,
        heroHeight: rHero?.height ?? 0,
        carouselHeight: r?.height ?? 0,
        name,
      };
    })()`,
    returnByValue: true,
  });
  const cX = carouselRect.result.value.x;
  const cY = carouselRect.result.value.y;
  const initialBotTitle = carouselRect.result.value.name;
  assert.ok(cX > 0 && cY > 0 && initialBotTitle.length > 0, 'Bot carousel must mount with initial bot title');
  assert.ok(
    carouselRect.result.value.heroHeight >= carouselRect.result.value.carouselHeight,
    `Bot hero container must not flex-shrink below carousel height: ${JSON.stringify(carouselRect.result.value)}`,
  );

  // 使用 touch 事件向左滑切换下一个 Bot，再向右滑切换回来
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: cX + 40, y: cY }] });
  await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: cX - 80, y: cY }] });
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await new Promise((r) => setTimeout(r, 160));
  const afterSwipeLeftBot = await send('Runtime.evaluate', {
    expression: `document.querySelector('.m-bot-hub__name')?.textContent?.trim() || ''`,
    returnByValue: true,
  });
  assert.notEqual(afterSwipeLeftBot.result.value, initialBotTitle, 'Swiping left on Bot carousel must switch to next bot');

  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: cX - 40, y: cY }] });
  await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: cX + 80, y: cY }] });
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await new Promise((r) => setTimeout(r, 160));
  const afterSwipeRightBot = await send('Runtime.evaluate', {
    expression: `document.querySelector('.m-bot-hub__name')?.textContent?.trim() || ''`,
    returnByValue: true,
  });
  assert.equal(afterSwipeRightBot.result.value, initialBotTitle, 'Swiping right on Bot carousel must return to previous bot');

  // 切回 Chats 并点首个普通会话进入舞台 -> 实测模型选择器位于视口内、可选、标签更新且向网关真实发送 config.set
  await send('Runtime.evaluate', {
    expression: `document.querySelector('[data-testid="mobile-tab-chats"]')?.click()`,
  });
  await new Promise((r) => setTimeout(r, 120));
  await send('Runtime.evaluate', {
    expression: `document.querySelector('.m-section[data-section="sessions"] .m-entity-row')?.click()`,
  });
  await new Promise((r) => setTimeout(r, 260));
  await send('Runtime.evaluate', {
    expression: `(() => {
      const inp = document.getElementById('mobile-stage-prompt-input');
      inp?.focus();
    })()`,
  });
  await new Promise((r) => setTimeout(r, 100));
  await send('Runtime.evaluate', {
    expression: `document.querySelector('.m-stage [data-testid="mobile-composer-model-pill"]')?.click()`,
  });
  await new Promise((r) => setTimeout(r, 180));

  const modelSheetGeom = await send('Runtime.evaluate', {
    expression: `(() => {
      const sheet = document.querySelector('[data-testid="mobile-model-picker-sheet"]');
      const track = document.querySelector('.m-shell__track');
      const box = sheet?.querySelector('.m-bottom-sheet');
      const rBox = box?.getBoundingClientRect();
      const opts = Array.from(sheet?.querySelectorAll('.m-sheet-option') || []).map((el) => {
        const r = el.getBoundingClientRect();
        return {
          id: el.getAttribute('data-model-id'),
          left: r.left,
          right: r.right,
          width: r.width,
          height: r.height,
        };
      });
      return {
        exists: Boolean(sheet),
        insideTrack: Boolean(sheet && track && track.contains(sheet)),
        boxRect: rBox ? { left: rBox.left, right: rBox.right, width: rBox.width, bottom: rBox.bottom } : null,
        opts,
      };
    })()`,
    returnByValue: true,
  });
  assert.equal(modelSheetGeom.result.value.exists, true, 'Model picker sheet must open when tapping model pill');
  assert.equal(modelSheetGeom.result.value.insideTrack, false, 'Model picker sheet must mount outside transformed .m-shell__track');
  assert.ok(
    modelSheetGeom.result.value.boxRect &&
      modelSheetGeom.result.value.boxRect.left >= -1 &&
      modelSheetGeom.result.value.boxRect.right <= 391 &&
      modelSheetGeom.result.value.boxRect.width >= 380,
    `Model bottom sheet must fit cleanly within 390px viewport: ${JSON.stringify(modelSheetGeom.result.value.boxRect)}`,
  );
  assert.ok(
    modelSheetGeom.result.value.opts.length >= 2 &&
      modelSheetGeom.result.value.opts.every((o) => o.left >= 0 && o.right <= 390 && o.height >= 44),
    `All model options must be visible inside [0, 390] viewport: ${JSON.stringify(modelSheetGeom.result.value.opts)}`,
  );

  await send('Runtime.evaluate', {
    expression: `document.querySelector('[data-testid="mobile-model-picker-sheet"] [data-model-id="openai/gpt-4o"]')?.click()`,
  });
  await new Promise((r) => setTimeout(r, 260));

  const afterSelectModel = await send('Runtime.evaluate', {
    expression: `({
      sheetGone: !document.querySelector('[data-testid="mobile-model-picker-sheet"]'),
      selectedModel: window.__fluxState.selectedModel,
      pillText: document.querySelector('.m-stage [data-testid="mobile-composer-model-pill"] .m-composer__model-label')?.textContent?.trim() || '',
    })`,
    returnByValue: true,
  });
  assert.equal(afterSelectModel.result.value.sheetGone, true, 'Selecting a model option must close picker sheet');
  assert.equal(afterSelectModel.result.value.selectedModel, 'openai/gpt-4o', 'Selecting model must update app state');
  assert.ok(afterSelectModel.result.value.pillText.length > 0 && afterSelectModel.result.value.pillText !== 'claude-sonnet-4', `Model pill label must update after selection, got: ${afterSelectModel.result.value.pillText}`);
  assert.ok(
    configSetCalls.some((c) => c?.key === 'model' && c?.value === 'openai/gpt-4o'),
    `Selecting model in active mobile session must transmit config.set to gateway, got: ${JSON.stringify(configSetCalls)}`,
  );

  // 17. 断言 10: 页面异常零容忍
  assert.equal(pageErrors.length, 0, `Page errors must be 0, encountered: ${JSON.stringify(pageErrors)}`);

  console.log('✔ All Mobile CDP, Soft Keyboard Geometry, Shell Gesture & Real Gateway assertions passed cleanly!');
  await cleanup();
} catch (err) {
  console.error('TEST ERROR TRACE:', err);
  await cleanup();
  throw err;
}
});
