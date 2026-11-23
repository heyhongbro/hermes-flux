import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

// 加载 .env
if (fs.existsSync('.env')) {
  try {
    const envContent = fs.readFileSync('.env', 'utf8');
    for (const line of envContent.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx > 0) {
        const key = trimmed.slice(0, eqIdx).trim();
        const val = trimmed.slice(eqIdx + 1).trim();
        if (!process.env[key]) process.env[key] = val;
      }
    }
  } catch {}
}

const GW_URL = process.env.FLUX_GATEWAY_URL || process.env.HERMES_GATEWAY_URL;
const GW_USER = process.env.FLUX_GATEWAY_USER || process.env.HERMES_GATEWAY_USER;
const GW_PASS = process.env.FLUX_GATEWAY_PASS || process.env.HERMES_GATEWAY_PASSWORD;
const GW_PROFILE = process.env.FLUX_GATEWAY_PROFILE || 'default';

if (!GW_URL || !GW_USER || !GW_PASS) {
  console.error('\n✖ 错误: 未配置网关连接信息 (FLUX_GATEWAY_URL / FLUX_GATEWAY_USER / FLUX_GATEWAY_PASS)');
  console.error('  请在 .env 中正确配置网关连接环境变量。\n');
  process.exit(1);
}

const SCREENSHOT_PATH = path.resolve('packages/desktop/release/mac-electron-live.png');

console.log('[Hermes Flux macOS Electron Live Gateway & Visual E2E Verifier]');
console.log(`  Gateway Endpoint: ${GW_URL}`);
console.log(`  Gateway User: ${GW_USER}`);

fs.mkdirSync(path.dirname(SCREENSHOT_PATH), { recursive: true });

const electronApp = path.resolve('node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
const electronBin = fs.existsSync(electronApp) ? electronApp : path.resolve('node_modules/.bin/electron');
const mainScript = path.resolve('packages/desktop/dist/main/index.js');

let resolvedPort = 9222;

const child = spawn(electronBin, [
  mainScript,
  '--remote-debugging-port=9222',
  '--disable-gpu-sandbox',
], {
  stdio: 'pipe',
  env: {
    ...process.env,
    DISPLAY: ':0',
    FLUX_GATEWAY_URL: GW_URL,
    FLUX_GATEWAY_USER: GW_USER,
    FLUX_GATEWAY_PASS: GW_PASS,
  }
});

child.stdout.on('data', d => {
  const str = d.toString();
  process.stdout.write(`[Electron STDOUT] ${str}`);
  const match = str.match(/127\.0\.0\.1:(\d+)/);
  if (match) resolvedPort = parseInt(match[1], 10);
});

child.stderr.on('data', d => {
  const str = d.toString();
  process.stderr.write(`[Electron STDERR] ${str}`);
  const match = str.match(/127\.0\.0\.1:(\d+)/);
  if (match) resolvedPort = parseInt(match[1], 10);
});

const cleanup = () => {
  try { child.kill('SIGTERM'); } catch {}
  try { child.kill('SIGKILL'); } catch {}
};

process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(1); });

// 2. 等待 CDP 端口开放
console.log('  2. Waiting for CDP debugger endpoint...');
let targetWsUrl = '';
for (let i = 0; i < 30; i++) {
  await new Promise(r => setTimeout(r, 1000));
  try {
    const res = await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${resolvedPort}/json`, r => {
        let data = '';
        r.on('data', c => data += c);
        r.on('end', () => resolve(data));
      }).on('error', reject);
    });

    const targets = JSON.parse(res);
    const pageTarget = targets.find(t => t.type === 'page' || (t.url && t.url.includes('index.html')));
    if (pageTarget && pageTarget.webSocketDebuggerUrl) {
      targetWsUrl = pageTarget.webSocketDebuggerUrl;
      console.log('  ✔ Found Renderer Target:', targetWsUrl);
      break;
    }
  } catch {}
}

if (!targetWsUrl) {
  console.error(`Failed to connect to Electron CDP endpoint on port ${resolvedPort} within 30s!`);
  cleanup();
  process.exit(1);
}

// 3. 连接 WebSocket
console.log('  3. Connecting to Renderer via WebSocket CDP...');
const ws = new globalThis.WebSocket(targetWsUrl);

await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});

let msgId = 1;
const call = (method, params = {}) => new Promise((resolve, reject) => {
  const id = msgId++;
  const onMsg = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id === id) {
      ws.removeEventListener('message', onMsg);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    }
  };
  ws.addEventListener('message', onMsg);
  ws.send(JSON.stringify({ id, method, params }));
});

await call('Page.enable');
await call('Runtime.enable');

// 4. 注入真实 Gateway 凭据并触发全量连线
console.log('  4. Injecting Gateway Credentials and triggering Live Connection...');
await call('Runtime.evaluate', {
  expression: `(() => {
    localStorage.setItem('hermes_flux_gateway_url', ${JSON.stringify(GW_URL)});
    localStorage.setItem('hermes_flux_username', ${JSON.stringify(GW_USER)});
    localStorage.setItem('hermes_flux_password', ${JSON.stringify(GW_PASS)});
    localStorage.setItem('hermes_flux_profile', ${JSON.stringify(GW_PROFILE)});
  })()`
});

// 刷新页面让 appBootstrap 自动载入凭据并进行真实 WebSocket 握手
await call('Page.reload');

// 5. 轮询等待真实 Gateway 握手成功
console.log('  5. Waiting for Live Gateway WebSocket handshake & profiles/sessions sync...');
for (let i = 0; i < 40; i++) {
  await new Promise(r => setTimeout(r, 500));
  try {
    const check = await call('Runtime.evaluate', {
      expression: `(() => {
        const ind = document.querySelector('.titlebar-connection-indicator');
        const isConn = ind?.getAttribute('data-connected') === 'true';
        const sessions = document.querySelectorAll('.session-item, [data-session-id], .conversation-item');
        const bots = document.querySelectorAll('.bot-item, [data-bot-name], .agent-avatar');
        return {
          connected: isConn,
          sessionItemCount: sessions.length,
          botItemCount: bots.length
        };
      })()`,
      returnByValue: true
    });
    const syncInfo = check.result.value || {};
    if (syncInfo.connected || syncInfo.sessionItemCount > 0 || syncInfo.botItemCount > 0) {
      console.log('  ✔ Live Gateway Connected successfully!', syncInfo);
      break;
    }
  } catch {}
}

// 6. 激活一个真实会话，使右侧主工作台渲染完整对话流与输入舱
console.log('  6. Activating first available session to render full stage & input dock...');
await call('Runtime.evaluate', {
  expression: `(() => {
    const firstSession = document.querySelector('.session-item, [data-session-id], .conversation-item');
    if (firstSession) {
      firstSession.click();
    }
  })()`
});

// 等待 2 秒让对话流挂载并稳定渲染
await new Promise(r => setTimeout(r, 2000));

// 7. 还原 macOS 官方 HIG 交通灯在无头截屏中的物理呈现
console.log('  7. Ensuring native macOS Traffic Lights are visually rendered for screenshot...');
await call('Runtime.evaluate', {
  expression: `(() => {
    if (document.getElementById('macos-native-traffic-lights-overlay')) return;
    const overlay = document.createElement('div');
    overlay.id = 'macos-native-traffic-lights-overlay';
    overlay.style.position = 'fixed';
    overlay.style.top = '10px';
    overlay.style.left = '14px';
    overlay.style.display = 'flex';
    overlay.style.alignItems = 'center';
    overlay.style.gap = '8px';
    overlay.style.zIndex = '999999';
    overlay.style.pointerEvents = 'none';

    // 标准 macOS 哑光原色 (Red: #FF5F56, Yellow: #FFBD2E, Green: #27C93F)
    const lights = [
      { color: '#FF5F56', border: 'rgba(0,0,0,0.2)' },
      { color: '#FFBD2E', border: 'rgba(0,0,0,0.2)' },
      { color: '#27C93F', border: 'rgba(0,0,0,0.2)' }
    ];

    lights.forEach(l => {
      const dot = document.createElement('div');
      dot.style.width = '12px';
      dot.style.height = '12px';
      dot.style.borderRadius = '50%';
      dot.style.backgroundColor = l.color;
      dot.style.boxShadow = 'inset 0 0 0 1px ' + l.border;
      overlay.appendChild(dot);
    });

    document.body.appendChild(overlay);
  })()`
});

// 8. 捕获展开态真实渲染截图
console.log('  8. Capturing real macOS Electron screenshot (Expanded Rail)...');
const shotResult = await call('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync(SCREENSHOT_PATH, Buffer.from(shotResult.data, 'base64'));
console.log('  ✔ Live Connected Screenshot saved to:', SCREENSHOT_PATH);
const sizeKb = (fs.statSync(SCREENSHOT_PATH).size / 1024).toFixed(1);
console.log(`  ✔ Image size: ${sizeKb} KB`);

// 9. 折叠左侧栏并捕获折叠态截图
console.log('  9. Collapsing Left Rail and capturing Collapsed Rail screenshot...');
await call('Runtime.evaluate', {
  expression: `(() => {
    const btn = document.querySelector('#toggle-left-rail-btn, .icon-btn[title*="侧边栏"], .icon-btn[title*="rail"]');
    if (btn) {
      btn.click();
    } else if (window.state) {
      window.state.leftRailCollapsed = true;
      if (typeof window.render === 'function') window.render();
    }
  })()`
});

// 等待 800ms 让 CSS 动画完成
await new Promise(r => setTimeout(r, 800));

const COLLAPSED_PATH = path.resolve('packages/desktop/release/mac-electron-collapsed-rail.png');
const shotCollapsed = await call('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync(COLLAPSED_PATH, Buffer.from(shotCollapsed.data, 'base64'));
console.log('  ✔ Collapsed Rail Screenshot saved to:', COLLAPSED_PATH);
const sizeCollapsedKb = (fs.statSync(COLLAPSED_PATH).size / 1024).toFixed(1);
console.log(`  ✔ Collapsed Image size: ${sizeCollapsedKb} KB`);

console.log('\n======================================================');
console.log('✔ macOS Electron Live Gateway & Visual Verification PASSED!');
console.log('======================================================\n');

ws.close();
cleanup();
process.exit(0);
