/**
 * 状态栏与子 Agent 监控全链路物理验收（真实 Blink CDP）
 * (packages/desktop/__tests__/cdp/status-bar-subagent-monitor-cdp.test.mjs)
 *
 * 【设计意图 (Why)】
 *   直接驱动编译后的真实前端产物 packages/desktop/dist/renderer/index.html，
 *   配合本地 HTTP + RFC6455 WebSocket 模拟网关完成真实握手、REST 拉取、RPC 调用与事件推送，
 *   并在 1440×900（暗/亮双肤）与 390×844（移动端）视口下物理验证几何布局、交互隔离与出图存证。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const BROWSER_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];

const RENDERER_ENTRY = 'packages/desktop/dist/renderer/index.html';
const ARTIFACT_DIR = path.resolve(process.cwd(), 'artifacts/verification/status-bar-subagent-monitor');

function encodeWsFrame(textOrBuf, opcode = 0x01) {
  const payload = typeof textOrBuf === 'string' ? Buffer.from(textOrBuf, 'utf8') : textOrBuf;
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function decodeWsFrames(buffer, onFrame) {
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const b1 = buffer[offset];
    const b2 = buffer[offset + 1];
    const opcode = b1 & 0x0f;
    const masked = (b2 & 0x80) !== 0;
    let payloadLen = b2 & 0x7f;
    let cursor = offset + 2;
    if (payloadLen === 126) {
      if (cursor + 2 > buffer.length) break;
      payloadLen = buffer.readUInt16BE(cursor);
      cursor += 2;
    } else if (payloadLen === 127) {
      if (cursor + 8 > buffer.length) break;
      payloadLen = Number(buffer.readBigUInt64BE(cursor));
      cursor += 8;
    }
    const maskLen = masked ? 4 : 0;
    if (cursor + maskLen + payloadLen > buffer.length) break;
    let payload = buffer.subarray(cursor + maskLen, cursor + maskLen + payloadLen);
    if (masked) {
      const mask = buffer.subarray(cursor, cursor + 4);
      const decoded = Buffer.alloc(payloadLen);
      for (let i = 0; i < payloadLen; i += 1) {
        decoded[i] = payload[i] ^ mask[i % 4];
      }
      payload = decoded;
    }
    onFrame({ opcode, payload });
    offset = cursor + maskLen + payloadLen;
  }
  return buffer.subarray(offset);
}

function startMockGateway() {
  const recordedRpc = [];
  const wsClients = new Set();
  const state = {
    compressionThreshold: 0.78,
    compressions: 1,
    contextUsed: 9600,
    contextMax: 16000,
    subagents: [
      {
        subagent_id: 'sub-active-1',
        session_id: 'live-main-1',
        child_session_id: 'child-sess-active',
        delegation_id: 'del-active-1',
        goal: 'Audit live status pod state sync',
        status: 'running',
        model: 'claude-sonnet-4',
        tool_count: 4,
        last_tool: 'read_file: sessionStatusService.ts',
        accepting_steer: true,
        files_read: ['packages/desktop/src/renderer/services/sessionStatusService.ts'],
        files_written: ['packages/ui/src/components-react/status/SessionStatusPanel.tsx'],
        started_at: Math.floor((Date.now() - 18000) / 1000),
      },
      ...Array.from({ length: 6 }, (_, i) => ({
        subagent_id: `sub-done-${i + 1}`,
        session_id: 'live-main-1',
        ...(i === 0 ? { child_session_id: 'child-sess-done-1' } : {}),
        delegation_id: `del-done-${i + 1}`,
        goal: i === 0 ? 'Verify StatusBar token coverage' : `Completed check #${i + 1}`,
        status: i === 5 ? 'failed' : 'completed',
        model: 'claude-sonnet-4',
        tool_count: 3 + i,
        duration_seconds: 12.4 + i,
        summary: i === 0 ? 'All design tokens verified with 0 hardcoded colors.' : `Summary #${i + 1}`,
        error: i === 5 ? 'Timed out contacting remote peer' : undefined,
        files_written: i === 0 ? ['packages/ui/src/styles/status-pod.css'] : [],
        started_at: Math.floor((Date.now() - (120 + i * 30) * 1000) / 1000),
        completed_at: Math.floor((Date.now() - (90 + i * 25) * 1000) / 1000),
      })),
    ],
  };

  const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const reqUrl = new URL(req.url || '/', 'http://127.0.0.1');
    const pathname = reqUrl.pathname;
    const sendJson = (obj, statusCode = 200) => {
      res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(obj));
    };

    if (pathname === '/api/status') {
      sendJson({ status: 'ok', auth_required: false, version: '0.23.2' });
      return;
    }
    if (pathname === '/api/auth/ws-ticket') {
      sendJson({ ticket: 'mock-ticket' });
      return;
    }
    if (pathname === '/api/config') {
      sendJson({
        compression: state.compressionThreshold === null
          ? { enabled: false, threshold: null }
          : { enabled: true, threshold: state.compressionThreshold },
      });
      return;
    }
    if (pathname === '/api/sessions') {
      sendJson({
        sessions: [
          {
            session_id: 'stored-main-1',
            id: 'stored-main-1',
            title: 'Status Bar E2E Session',
            profile: 'default',
            cwd: '/ws/hermes-flux',
            model: 'claude-sonnet-4',
            last_active: Math.floor(Date.now() / 1000),
          },
        ],
        total: 1,
      });
      return;
    }
    if (pathname === '/api/model/options') {
      sendJson({
        providers: [{ slug: 'anthropic', name: 'Anthropic', models: ['claude-sonnet-4'] }],
        model: 'claude-sonnet-4',
        provider: 'anthropic',
      });
      return;
    }
    if (pathname === '/api/sessions/stored-main-1/messages') {
      const nowSec = Math.floor(Date.now() / 1000);
      sendJson({
        status: 'success',
        messages: [
          {
            row_id: 1,
            role: 'user',
            content: 'Inspect architecture and spawn background verification subagent.',
            timestamp: nowSec - 25,
          },
          {
            row_id: 2,
            role: 'assistant',
            content: 'Spawning subagent task to inspect status monitor integration.',
            timestamp: nowSec - 18,
            tool_calls: [
              {
                id: 'tc-main-del-1',
                name: 'delegate_task',
                arguments: {
                  goal: 'Audit live status pod state sync',
                  delegation_id: 'del-active-1',
                  subagent_id: 'sub-active-1',
                },
              },
            ],
          },
          {
            row_id: 3,
            role: 'tool',
            tool_call_id: 'tc-main-del-1',
            name: 'delegate_task',
            content: '{"status":"running","subagent_id":"sub-active-1"}',
            timestamp: nowSec - 17,
          },
        ],
        pagination: { returned: 3, has_more: false },
      });
      return;
    }
    if (pathname === '/api/sessions/child-sess-active/messages' || pathname === '/api/sessions/child-sess-done-1/messages') {
      const isDone = pathname.includes('child-sess-done-1');
      const nowSec = Math.floor(Date.now() / 1000);
      sendJson({
        status: 'success',
        messages: [
          {
            row_id: 10,
            role: 'user',
            content: isDone ? 'Check design token definitions in status-pod.css' : 'Inspect sessionStatusService invariants',
            timestamp: nowSec - 90,
          },
          {
            row_id: 11,
            role: 'assistant',
            content: isDone
              ? 'Verified `--fs-body`, `--fs-aux`, `--fs-caption` and zero hex literals.'
              : 'Tracing `getRegisteredLiveId` guard against 4001 error on non-live sessions.',
            timestamp: nowSec - 12,
          },
        ],
        pagination: { returned: 2, has_more: false },
      });
      return;
    }
    if (pathname === '/api/files') {
      sendJson({
        path: '/ws/hermes-flux',
        entries: [
          { name: 'status-pod.css', path: '/ws/hermes-flux/status-pod.css', is_directory: false, size: 128 },
          { name: 'demo.ts', path: '/ws/hermes-flux/demo.ts', is_directory: false, size: 64 },
        ],
      });
      return;
    }
    if (pathname === '/api/fs/read' || pathname === '/api/fs/content') {
      const filePath = reqUrl.searchParams.get('path') || '/ws/hermes-flux/demo.ts';
      sendJson({
        path: filePath,
        content: `// Preview of ${filePath}\nexport const statusPodVerified = true;\n`,
      });
      return;
    }
    sendJson({ ok: true });
  });

  function handleRpc(method, params = {}) {
    recordedRpc.push({ method, params });
    switch (method) {
      case 'ping':
        return { pong: true };
      case 'gateway.capabilities':
        return { per_session_exclusive_submit: true };
      case 'profiles.list':
        return {
          profiles: [
            { name: 'default', display_name: 'Default Bot', is_default: true },
            { name: 'architect', display_name: 'Architect', description: 'Systems' },
          ],
          install_id: 'mock-gw',
        };
      case 'profiles.describe':
        return { name: params.name || 'default', model: 'claude-sonnet-4' };
      case 'profiles.get_asset':
        return { found: false };
      case 'model.options':
        return {
          providers: [{ slug: 'anthropic', name: 'Anthropic', models: ['claude-sonnet-4'] }],
          model: 'claude-sonnet-4',
          provider: 'anthropic',
        };
      case 'config.get':
        return {
          config: {
            compression: state.compressionThreshold === null
              ? { enabled: false, threshold: null }
              : { enabled: true, threshold: state.compressionThreshold },
          },
        };
      case 'session.list':
        return {
          sessions: [
            {
              session_id: 'stored-main-1',
              title: 'Status Bar E2E Session',
              profile: 'default',
              cwd: '/ws/hermes-flux',
              last_active: Math.floor(Date.now() / 1000),
            },
          ],
        };
      case 'session.resume':
        return {
          session_id: 'live-main-1',
          stored_session_id: 'stored-main-1',
          running: false,
          info: {
            cwd: '/ws/hermes-flux',
            branch: 'feat/status-bar',
            model: 'claude-sonnet-4',
            provider: 'anthropic',
          },
        };
      case 'session.usage':
        return {
          session_id: 'live-main-1',
          input: 6800,
          output: 2800,
          cache_hit_pct: 64,
          context_used: state.contextUsed,
          context_max: state.contextMax,
          compressions: state.compressions,
        };
      case 'session.context_breakdown':
        return {
          context_max: state.contextMax,
          context_used: state.contextUsed,
          estimated_total: state.contextUsed,
          context_percent: Math.round((state.contextUsed / state.contextMax) * 100),
          categories: [
            { id: 'system_prompt', label: 'System Prompt', tokens: 1800, color: 'var(--info)' },
            { id: 'tool_definitions', label: 'Tools', tokens: 2400, color: 'var(--primary)' },
            { id: 'conversation', label: 'Conversation', tokens: Math.max(0, state.contextUsed - 4200), color: 'var(--success)' },
          ],
          context_files: [
            { path: '/ws/hermes-flux/demo.ts', label: 'demo.ts', chars: 1680, est_tokens: 420, loaded: true, status: 'loaded' },
          ],
        };
      case 'session.compress':
        state.compressions += 1;
        state.contextUsed = 4800;
        return { ok: true };
      case 'subagent.list':
        return { subagents: state.subagents };
      case 'spawn_tree.list':
        return {
          entries: [
            {
              path: '/ws/hermes-flux/.spawn_tree/main-1.json',
              session_id: 'stored-main-1',
              started_at: Math.floor((Date.now() - 180000) / 1000),
              finished_at: Math.floor((Date.now() - 60000) / 1000),
              count: 6,
            },
          ],
        };
      case 'spawn_tree.load':
        return {
          session_id: 'stored-main-1',
          subagents: state.subagents.filter((s) => s.status !== 'running'),
        };
      case 'subagent.steer':
        return { accepted: true, status: 'queued', subagent_id: params.subagent_id, text: params.text };
      case 'subagent.interrupt':
        return { ok: true };
      case 'subagent.tail':
        return {
          subagent_id: params.subagent_id,
          available: true,
          has_more: false,
          latest_seq: 2,
          entries: [
            { seq: 1, timestamp: Math.floor(Date.now() / 1000) - 4, kind: 'tool_call', text: 'grep -rn StatusPod packages/ui/src' },
            { seq: 2, timestamp: Math.floor(Date.now() / 1000) - 2, kind: 'stdout', text: 'Found 3 matched component files.' },
          ],
        };
      case 'session.transcript': {
        const err = new Error('Method not found');
        err.code = -32601;
        throw err;
      }
      case 'groups.list':
        return {
          rooms: [
            {
              room_id: 'room-1',
              name: 'Architecture Council',
              members: [
                { member_id: 'm1', profile: 'architect', display_name: 'Architect' },
                { member_id: 'm2', profile: 'default', display_name: 'Default Bot' },
              ],
            },
          ],
        };
      case 'groups.state':
        return {
          room: {
            room_id: 'room-1',
            members: [
              { member_id: 'm1', profile: 'architect', display_name: 'Architect' },
              { member_id: 'm2', profile: 'default', display_name: 'Default Bot' },
            ],
          },
          driver_status: {
            round_status: 'running',
            member_activity: [
              {
                member_id: 'm1',
                status: 'running',
                tool: 'read_file',
                round_index: 2,
                started_at: Math.floor(Date.now() / 1000) - 5,
              },
            ],
          },
        };
      case 'groups.log':
        return { logs: [] };
      case 'projects.list':
        return { projects: [] };
      default:
        return { ok: true };
    }
  }

  server.on('upgrade', (req, socket) => {
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
        '',
        '',
      ].join('\r\n'),
    );
    wsClients.add(socket);

    let pendingBuf = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      pendingBuf = decodeWsFrames(Buffer.concat([pendingBuf, chunk]), ({ opcode, payload }) => {
        if (opcode === 0x08) {
          socket.end();
          return;
        }
        if (opcode === 0x09) {
          socket.write(encodeWsFrame(payload, 0x0a));
          return;
        }
        if (opcode !== 0x01) return;
        let msg;
        try {
          msg = JSON.parse(payload.toString('utf8'));
        } catch {
          return;
        }
        if (!msg || typeof msg.method !== 'string') return;
        try {
          const result = handleRpc(msg.method, msg.params);
          socket.write(encodeWsFrame(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })));
        } catch (err) {
          socket.write(
            encodeWsFrame(
              JSON.stringify({
                jsonrpc: '2.0',
                id: msg.id,
                error: { code: err.code || -32000, message: err.message || 'error' },
              }),
            ),
          );
        }
      });
    });
    socket.on('close', () => wsClients.delete(socket));
    socket.on('error', () => wsClients.delete(socket));
  });

  return { server, recordedRpc, state };
}

test('status-bar-subagent-monitor: 全链路状态栏与子 Agent 监控物理验收（双肤 + 桌面/移动）', async (t) => {
  const browserPath = BROWSER_CANDIDATES.find((p) => fs.existsSync(p));
  if (!browserPath) {
    t.skip('未找到 Edge/Chrome');
    return;
  }
  const rootDir = process.cwd();
  if (!fs.existsSync(path.join(rootDir, RENDERER_ENTRY))) {
    t.skip('renderer 产物缺失，请先执行 npm run build');
    return;
  }

  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const mockGw = startMockGateway();
  await new Promise((r) => mockGw.server.listen(0, '127.0.0.1', r));
  const gwPort = mockGw.server.address().port;

  const staticServer = http.createServer((req, res) => {
    let reqPath = decodeURIComponent(req.url?.split('?')[0] || '/');
    if (reqPath === '/') reqPath = `/${RENDERER_ENTRY}`;
    const filePath = path.join(rootDir, reqPath);
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    const mime = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.svg': 'image/svg+xml',
      '.woff2': 'font/woff2',
    };
    res.writeHead(200, { 'Content-Type': mime[path.extname(filePath).toLowerCase()] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
  });
  await new Promise((r) => staticServer.listen(0, '127.0.0.1', r));
  const serverPort = staticServer.address().port;

  const portProbe = http.createServer();
  await new Promise((r) => portProbe.listen(0, '127.0.0.1', r));
  const cdpPort = portProbe.address().port;
  await new Promise((r) => portProbe.close(r));

  const tmpUserDataDir = path.resolve(os.tmpdir(), `flux-cdp-status-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  const proc = spawn(browserPath, [
    `--remote-debugging-port=${cdpPort}`,
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${tmpUserDataDir}`,
    '--window-size=1440,900',
    `http://127.0.0.1:${serverPort}/${RENDERER_ENTRY}`,
  ], { stdio: 'ignore' });

  let ws = null;
  t.after(async () => {
    try {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ id: 999999, method: 'Browser.close' }));
        await new Promise((r) => setTimeout(r, 400));
        ws.close();
      }
    // gate-degrade: CDP 关闭清理尽力释放句柄
    } catch {}
    try { proc.kill(); } catch {}
    try { staticServer.close(); } catch {}
    try { mockGw.server.close(); } catch {}
    try { fs.rmSync(tmpUserDataDir, { recursive: true, force: true }); } catch {}
  });

  let wsUrl = null;
  const startWait = Date.now();
  while (Date.now() - startWait < 15000 && !wsUrl) {
    try {
      const r = await fetch(`http://127.0.0.1:${cdpPort}/json`);
      if (r.ok) {
        const list = await r.json();
        const page = list.find((x) => x.type === 'page' && x.webSocketDebuggerUrl);
        if (page) wsUrl = page.webSocketDebuggerUrl;
      }
    // gate-degrade: CDP 端口就绪轮询容错
    } catch {}
    if (!wsUrl) await new Promise((r) => setTimeout(r, 200));
  }
  assert.ok(wsUrl, 'CDP target 必须可达');

  ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', rej);
  });

  let nextCmdId = 0;
  const pendingCmds = new Map();
  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pendingCmds.has(msg.id)) {
      const p = pendingCmds.get(msg.id);
      pendingCmds.delete(msg.id);
      msg.error ? p.rej(new Error(JSON.stringify(msg.error))) : p.res(msg.result);
    }
  });
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const id = ++nextCmdId;
      pendingCmds.set(id, { res, rej });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const out = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    return out.result?.value;
  };
  const captureShot = async (filename) => {
    const { data } = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(ARTIFACT_DIR, filename), Buffer.from(data, 'base64'));
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

  // 在新文档首行注入受控 localStorage + hermesDesktop HTTP 代理桥（WS 直连本地模拟网关）
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      localStorage.setItem('hermes_flux_gateway_url', 'http://127.0.0.1:${gwPort}');
      localStorage.setItem('hermes_flux_lang', 'zh');
      localStorage.setItem('hermes_flux_theme', 'obsidian-gold');
      window.hermesDesktop = {
        getSystemInfo: async () => ({ platform: 'windows', appVersion: '1.0.0' }),
        isMaximized: async () => false,
        onWindowStateChange: () => {},
        minimize: () => {},
        maximize: async () => false,
        close: () => {},
        getDefaultGatewayConfig: async () => ({ url: 'http://127.0.0.1:${gwPort}', profile: 'default' }),
        authenticateGateway: async () => ({ ok: true, latency: 8, ticket: 'mock-ticket', message: 'ok' }),
        httpProxy: async ({ baseUrl, path: p, method, params, body }) => {
          const u = new URL(p, baseUrl);
          if (params && typeof params === 'object') {
            for (const [k, v] of Object.entries(params)) {
              if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
            }
          }
          const resp = await fetch(u.toString(), {
            method: method || 'GET',
            headers: { 'Content-Type': 'application/json' },
            ...(body ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
          });
          return await resp.json();
        },
        readFile: async (filePath) => '// mock local file: ' + filePath + '\\nexport const ok = true;\\n',
        listDirectory: async (dirPath) => [
          { name: 'status-pod.css', path: dirPath + '/status-pod.css', isDirectory: false, size: 128 },
          { name: 'demo.ts', path: dirPath + '/demo.ts', isDirectory: false, size: 64 },
        ],
      };
    `,
  });

  await send('Page.reload', { ignoreCache: true });

  // 等待真实渲染器连上 mock 网关并激活会话 stored-main-1（或点选会话）
  const ready = await (async () => {
    for (let i = 0; i < 60; i += 1) {
      const ok = await evaluate(`(() => {
        const s = window.__fluxState;
        return Boolean(s && s.gatewayConnected && s.sessions && s.sessions.length > 0 && document.getElementById('toggle-inspector-btn'));
      })()`);
      if (ok) return true;
      await new Promise((r) => setTimeout(r, 200));
    }
    return false;
  })();
  assert.ok(ready, '真实 renderer 必须连上模拟网关并加载会话列表');

  await evaluate(`(async () => {
    if (window.__fluxState.activeSessionId !== 'stored-main-1') {
      await window.__fluxSelectSession('stored-main-1');
    }
    return true;
  })()`);

  const liveSynced = await (async () => {
    for (let i = 0; i < 50; i += 1) {
      const ok = await evaluate(`(() => {
        const dot = document.querySelector('#toggle-inspector-btn .titlebar-status-dot');
        const msgBtn = document.querySelector('[data-open-subagent="sub-active-1"]');
        return Boolean(dot && msgBtn);
      })()`);
      if (ok) return true;
      await new Promise((r) => setTimeout(r, 150));
    }
    return false;
  })();
  if (!liveSynced) {
    const diag = await evaluate(`(() => ({
      dot: Boolean(document.querySelector('#toggle-inspector-btn .titlebar-status-dot')),
      openSubagentBtns: [...document.querySelectorAll('[data-open-subagent]')].map((el) => el.getAttribute('data-open-subagent')),
      activeSessionId: window.__fluxState?.activeSessionId,
      liveSessionId: window.__fluxState?.liveSessionId,
      messagesLen: window.__fluxState?.messages?.length ?? 0,
      hasReactRoot: Boolean(document.getElementById('react-conversation-host')?.innerHTML),
    }))()`);
    assert.fail(`liveSynced timeout diag=${JSON.stringify(diag)} rpc=${JSON.stringify(mockGw.recordedRpc.map((r) => r.method))}`);
  }

  // 1. 默认收起 + 顶栏开关纯图标/微点 + 打开停靠状态栏
  const beforeOpen = await evaluate(`(() => {
    const pod = document.getElementById('flux-inspector-pod');
    const btn = document.getElementById('toggle-inspector-btn');
    const dot = btn?.querySelector('.titlebar-status-dot');
    const dotCs = dot ? getComputedStyle(dot) : null;
    return {
      podMode: pod?.dataset?.podMode,
      podDisplay: pod ? getComputedStyle(pod).display : null,
      btnText: btn?.textContent?.trim() ?? '',
      dotWidth: dotCs?.width,
      dotHeight: dotCs?.height,
    };
  })()`);
  assert.equal(beforeOpen.podMode, 'closed');
  assert.equal(beforeOpen.podDisplay, 'none');
  assert.equal(beforeOpen.btnText, '', '顶栏状态开关按钮严禁包含文字或数字');
  assert.equal(beforeOpen.dotWidth, '6px');
  assert.equal(beforeOpen.dotHeight, '6px');

  await evaluate(`(() => { document.getElementById('toggle-inspector-btn')?.click(); return true; })()`);
  await new Promise((r) => setTimeout(r, 300));

  const statusGeom = await evaluate(`(() => {
    const pod = document.getElementById('flux-inspector-pod');
    const win = document.querySelector('.status-pod-window');
    const mid = document.querySelector('.flux-middle-pod');
    const railBtns = [...document.querySelectorAll('#flux-inspector-rail .vertical-tab-item')];
    const activeRows = document.querySelectorAll('.status-row[data-variant="active"]').length;
    const termRowsBefore = document.querySelectorAll('.status-row[data-variant="terminal"]').length;
    const moreBtnText = document.querySelector('[data-testid="status-toggle-more-terminal"]')?.textContent?.trim() || '';
    const tick = document.querySelector('[data-testid="status-compression-tick"]');
    const desktopControlHeights = [
      '.conv-row__subagent-link',
      '.status-env-btn',
      '.status-section-toggle',
      '.status-row__main',
      '.status-row__interrupt',
      '.status-more-btn',
      '[data-testid="status-context-trigger"]',
    ].map((sel) => ({
      sel,
      h: document.querySelector(sel)?.getBoundingClientRect().height ?? 0,
    }));
    const agentRow = document.querySelector('[data-testid="status-agent-row"]');
    const topZoneText = document.querySelector('.status-zone--top')?.textContent || '';
    const midZoneText = document.querySelector('.status-zone--middle')?.textContent || '';
    const fullWinText = win?.textContent || '';
    return {
      podMode: pod?.dataset?.podMode,
      podRect: pod?.getBoundingClientRect().toJSON(),
      winRect: win?.getBoundingClientRect().toJSON(),
      midRect: mid?.getBoundingClientRect().toJSON(),
      agentName: agentRow?.textContent?.trim() || '',
      hasAgentAvatar: Boolean(agentRow?.querySelector('.sp-agent-head-avatar svg, .sp-agent-head-avatar img')),
      cwdText: document.querySelector('[data-testid="status-cwd-btn"]')?.textContent?.trim() || '',
      topZoneText,
      midZoneText,
      fullWinText,
      railCount: railBtns.length,
      railAnyActive: railBtns.some((b) => b.classList.contains('active-tab') || b.getAttribute('aria-pressed') === 'true'),
      activeRows,
      termRowsBefore,
      moreBtnText,
      hasMoreBtn: Boolean(moreBtnText),
      hasCompressBtn: Boolean(document.querySelector('[data-testid="status-compress-btn"]')),
      hasTick: Boolean(tick),
      tickLeft: tick?.style?.left || '',
      desktopControlHeights,
    };
  })()`);

  assert.equal(statusGeom.podMode, 'status');
  assert.ok(Math.abs(statusGeom.podRect.width - 288) <= 4, `状态栏默认宽度应为 ~288px，实测 ${statusGeom.podRect.width}`);
  assert.ok(
    statusGeom.winRect.height < statusGeom.podRect.height - 40,
    `状态卡片必须按内容自适应高度不得占满全屏留黑洞：window=${statusGeom.winRect.height}, pod=${statusGeom.podRect.height}`,
  );
  assert.ok(statusGeom.midRect.right <= statusGeom.podRect.left + 1, '状态栏必须把主对话区推窄，严禁悬浮遮挡');
  assert.ok(statusGeom.hasAgentAvatar, '顶行必须展示当前 Agent 头像');
  assert.ok(statusGeom.agentName.includes('Default Bot'), `顶行必须展示 Agent 名称: ${statusGeom.agentName}`);
  assert.equal(statusGeom.topZoneText.includes('普通会话'), false, '顶行严禁显示 普通会话 标签');
  assert.equal(statusGeom.topZoneText.includes('claude-sonnet-4'), false, '上区严禁显示模型名称');
  assert.equal(statusGeom.hasCompressBtn, false, '状态栏严禁出现压缩按钮');
  assert.equal(/立即压缩|压缩上下文/.test(statusGeom.fullWinText), false, '状态栏严禁出现压缩按钮文案');
  assert.ok(statusGeom.cwdText.includes('/ws/hermes-flux'), `cwd 必须从 res.info 解包渲染: ${statusGeom.cwdText}`);
  assert.ok(statusGeom.topZoneText.includes('feat/status-bar'), `branch 必须从 res.info 解包渲染: ${statusGeom.topZoneText}`);
  for (const item of statusGeom.desktopControlHeights) {
    assert.ok(item.h >= 28, `桌面端交互控件 ${item.sel} 高度必须 >= 28px，实测 ${item.h}`);
  }
  assert.equal(statusGeom.railCount, 1, '右侧微轨只能保留唯一文件按钮');
  assert.equal(statusGeom.railAnyActive, false, 'status 模式下文件图标严禁高亮');
  assert.equal(statusGeom.activeRows, 1);
  assert.equal(statusGeom.termRowsBefore, 2, '默认总共展示 3 行（1 进行中 + 2 已完成）');
  assert.equal(statusGeom.moreBtnText, '显示更多', '展开更多按钮文案必须为 显示更多');
  assert.equal(/\b\d+\.\d+s\b|\d+m\d+s/.test(statusGeom.midZoneText), false, '状态列表行不得显示秒数');
  assert.equal(statusGeom.hasTick, true, '配置含有效 threshold 时必须绘出压缩阈值刻线');

  await captureShot('01-desktop-dark-status-open.png');

  // 展开 显示更多 与上下文构成明细（验证卡片向下自动扩高且无压缩按钮）
  await evaluate(`(() => {
    document.querySelector('[data-testid="status-toggle-more-terminal"]')?.click();
    document.querySelector('[data-testid="status-context-trigger"]')?.click();
    return true;
  })()`);
  await new Promise((r) => setTimeout(r, 250));

  const expandedStatus = await evaluate(`(() => ({
    termRowsAfter: document.querySelectorAll('.status-row[data-variant="terminal"]').length,
    breakdownOpen: Boolean(document.querySelector('[data-testid="context-breakdown-drawer"]')),
    fileChipHeight: document.querySelector('.status-breakdown__file-list .status-file-chip')?.getBoundingClientRect().height ?? 0,
    hasCompressBtn: Boolean(document.querySelector('[data-testid="status-compress-btn"]')),
    expandedWindowHeight: document.querySelector('.status-pod-window')?.getBoundingClientRect().height ?? 0,
  }))()`);
  assert.equal(expandedStatus.termRowsAfter, 6);
  assert.equal(expandedStatus.breakdownOpen, true);
  assert.ok(expandedStatus.fileChipHeight >= 28, `file chip 高度必须 >= 28px，实测 ${expandedStatus.fileChipHeight}`);
  assert.equal(expandedStatus.hasCompressBtn, false);
  assert.ok(
    expandedStatus.expandedWindowHeight > statusGeom.winRect.height + 60,
    `展开后卡片必须随内容向下扩高：before=${statusGeom.winRect.height}, after=${expandedStatus.expandedWindowHeight}`,
  );
  await captureShot('02-desktop-dark-status-breakdown.png');

  // 验证无 threshold 时不绘刻线，测毕立即重连恢复 0.78 供浅色与移动端验收
  mockGw.state.compressionThreshold = null;
  await evaluate(`(() => {
    window.__fluxConnect();
    return true;
  })()`);
  await new Promise((r) => setTimeout(r, 350));
  await evaluate(`(async () => {
    if (window.__fluxState.rightPodMode.kind !== 'status') document.getElementById('toggle-inspector-btn')?.click();
    return true;
  })()`);
  await new Promise((r) => setTimeout(r, 200));
  const noTickVisible = await evaluate(`Boolean(document.querySelector('[data-testid="status-compression-tick"]'))`);
  assert.equal(noTickVisible, false, '网关无 threshold 时严禁硬编码渲染阈值刻线');
  mockGw.state.compressionThreshold = 0.78;
  await evaluate(`(() => {
    window.__fluxConnect();
    return true;
  })()`);
  await new Promise((r) => setTimeout(r, 350));
  await evaluate(`(async () => {
    if (window.__fluxState.rightPodMode.kind !== 'status') document.getElementById('toggle-inspector-btn')?.click();
    return true;
  })()`);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(await evaluate(`Boolean(document.querySelector('[data-testid="status-compression-tick"]'))`), true);

  // 2. 群聊三态隔离验收
  await evaluate(`(() => {
    const grp = document.querySelector('.rail-group-item[data-room-id="room-1"]');
    grp?.click();
    return true;
  })()`);
  await new Promise((r) => setTimeout(r, 300));
  const groupCheck = await evaluate(`(() => ({
    podMode: document.getElementById('flux-inspector-pod')?.dataset?.podMode,
    hasUsageZone: Boolean(document.querySelector('[data-testid="status-usage-zone"]')),
    text: document.querySelector('#react-right-pod-host')?.textContent || '',
  }))()`);
  assert.equal(groupCheck.podMode, 'status');
  assert.equal(groupCheck.hasUsageZone, false, '群聊态必须隐去底部用量与上下文条');
  assert.ok(groupCheck.text.includes('Architecture Council'), '群聊状态栏必须显示可读群聊名称');
  assert.ok(groupCheck.text.includes('Architect'), '群聊状态栏必须显示只读活跃成员');
  await captureShot('03-desktop-dark-group-status.png');

  // 3. 切回主会话并从主对话行直接下钻活跃子 Agent（自绘 listbox + Esc 隔离 + 纠偏）
  await evaluate(`(async () => {
    await window.__fluxSelectSession('stored-main-1');
    return true;
  })()`);
  await new Promise((r) => setTimeout(r, 350));
  await evaluate(`(() => {
    document.querySelector('[data-open-subagent="sub-active-1"]')?.click();
    return true;
  })()`);
  await new Promise((r) => setTimeout(r, 350));

  await evaluate(`(() => {
    document.querySelector('[data-testid="subagent-switcher-btn"]')?.click();
    return true;
  })()`);
  await new Promise((r) => setTimeout(r, 120));

  const detailActive = await evaluate(`(() => {
    const pod = document.getElementById('flux-inspector-pod');
    return {
      podMode: pod?.dataset?.podMode,
      hasNativeSelect: Boolean(document.querySelector('#react-right-pod-host select')),
      menuOpen: Boolean(document.querySelector('[data-testid="subagent-switcher-menu"]')),
      hasSteerInput: Boolean(document.querySelector('[data-testid="subagent-steer-input"]')),
      hasInterruptBtn: Boolean(document.querySelector('[data-testid="subagent-detail-interrupt-btn"]')),
      duplicateMsgAnchors: document.querySelectorAll('[data-testid="subagent-stream-canvas"] [id^="msg-"]').length,
      forbiddenActions: document.querySelectorAll('[data-testid="subagent-stream-canvas"] [data-action="rollback-msg"], [data-testid="subagent-stream-canvas"] [data-action="fork-msg"]').length,
    };
  })()`);
  assert.equal(detailActive.podMode, 'subagent');
  assert.equal(detailActive.hasNativeSelect, false, '严禁原生 select 下拉');
  assert.equal(detailActive.menuOpen, true);
  assert.equal(detailActive.hasSteerInput, true);
  assert.equal(detailActive.hasInterruptBtn, true);
  assert.equal(detailActive.duplicateMsgAnchors, 0, '只读执行流不得产出主对话同款 #msg-* 锚点');
  assert.equal(detailActive.forbiddenActions, 0, '只读执行流不得出现回滚/Fork按钮');

  // CDP 真实键盘发送 Escape：必须只关闭切换菜单，Pod 停留在 subagent 态
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await new Promise((r) => setTimeout(r, 150));

  const afterEsc = await evaluate(`(() => ({
    menuOpen: Boolean(document.querySelector('[data-testid="subagent-switcher-menu"]')),
    podMode: document.getElementById('flux-inspector-pod')?.dataset?.podMode,
    settingsOpen: Boolean(window.__fluxState?.isSettingsOpen),
  }))()`);
  assert.equal(afterEsc.menuOpen, false, 'Esc 必须关闭自绘切换菜单');
  assert.equal(afterEsc.podMode, 'subagent', 'Esc 不得连带关闭详情页');
  assert.equal(afterEsc.settingsOpen, false);

  // 真实输入框输入纠偏文本并提交，校验 subagent.steer RPC 与内联反馈
  await evaluate(`(() => {
    const inp = document.querySelector('[data-testid="subagent-steer-input"]');
    inp?.focus();
    return Boolean(inp);
  })()`);
  await send('Input.insertText', { text: 'Focus on token audit first' });
  await new Promise((r) => setTimeout(r, 80));
  await evaluate(`(() => {
    document.querySelector('[data-testid="subagent-steer-submit"]')?.click();
    return true;
  })()`);
  await new Promise((r) => setTimeout(r, 250));
  const steerFeedbackCheck = await evaluate(`(() => ({
    inputValue: document.querySelector('[data-testid="subagent-steer-input"]')?.value ?? null,
    feedbackText: document.querySelector('.subagent-steer-feedback')?.textContent?.trim() || '',
    feedbackStatus: document.querySelector('.subagent-steer-feedback')?.getAttribute('data-status') || '',
  }))()`);
  assert.ok(
    mockGw.recordedRpc.some((c) => c.method === 'subagent.steer' && c.params?.text === 'Focus on token audit first'),
    '提交纠偏消息必须触发真实 subagent.steer RPC',
  );
  assert.equal(steerFeedbackCheck.inputValue, '', '成功发送纠偏后输入框必须清空');
  assert.equal(steerFeedbackCheck.feedbackStatus, '', '正常 queued 不应弹出错误/拒绝横幅');

  // 桌面端全屏按钮验证（限定工作区与聊天区覆盖，不得遮挡左侧微轨）
  await evaluate(`(() => {
    document.querySelector('[data-testid="subagent-fullscreen-btn"]')?.click();
    return true;
  })()`);
  await new Promise((r) => setTimeout(r, 200));
  const fullscreenCheck = await evaluate(`(() => {
    const pod = document.getElementById('flux-inspector-pod');
    const leftRail = document.getElementById('flux-left-rail');
    return {
      hasFullscreenClass: Boolean(pod?.classList.contains('inspector-fullscreen')),
      leftRailWidth: leftRail?.getBoundingClientRect().width ?? 0,
    };
  })()`);
  assert.equal(fullscreenCheck.hasFullscreenClass, true, '点击全屏按钮必须进入 .inspector-fullscreen');
  assert.ok(fullscreenCheck.leftRailWidth > 0, '全屏模式必须保留左侧微轨可见');
  await evaluate(`(() => {
    document.querySelector('[data-testid="subagent-fullscreen-btn"]')?.click();
    return true;
  })()`);
  await new Promise((r) => setTimeout(r, 200));

  await captureShot('04-desktop-dark-subagent-active.png');

  // 先切换到无 child_session_id 的 sub-done-2 验证 session.transcript -32601 -> subagent.tail 降级通道
  await evaluate(`(() => {
    document.querySelector('[data-testid="subagent-switcher-btn"]')?.click();
    return true;
  })()`);
  await new Promise((r) => setTimeout(r, 120));
  await evaluate(`(() => {
    const items = [...document.querySelectorAll('.subagent-switcher__item')];
    const degradedItem = items.find((el) => el.textContent?.includes('Completed check #2'));
    degradedItem?.click();
    return true;
  })()`);
  await new Promise((r) => setTimeout(r, 300));
  const degradedCheck = await evaluate(`(() => ({
    hasDegradedBanner: Boolean(document.querySelector('.subagent-degraded-banner')),
    hasTailList: Boolean(document.querySelector('[data-testid="subagent-tail-list"]')),
    tailText: document.querySelector('[data-testid="subagent-tail-list"]')?.textContent || '',
  }))()`);
  assert.equal(degradedCheck.hasDegradedBanner, true, '无 child_session_id 且 session.transcript -32601 时必须显示降级提示横幅');
  assert.equal(degradedCheck.hasTailList, true, '降级态必须渲染 [data-testid="subagent-tail-list"]');
  assert.ok(degradedCheck.tailText.includes('[工具]'), '降级尾部 kind 必须本地化显示 [工具]');
  assert.equal(degradedCheck.tailText.includes('[tool_call]'), false, '降级尾部严禁裸露 [tool_call]');
  assert.ok(degradedCheck.tailText.includes('grep -rn StatusPod'), '降级尾部必须展示 subagent.tail 返回日志');

  // 切换到带 child_session_id 的终态子 Agent：无输入框、展示引用与复制
  await evaluate(`(() => {
    document.querySelector('[data-testid="subagent-switcher-btn"]')?.click();
    return true;
  })()`);
  await new Promise((r) => setTimeout(r, 120));
  await evaluate(`(() => {
    const items = [...document.querySelectorAll('.subagent-switcher__item')];
    const doneItem = items.find((el) => el.textContent?.includes('Verify StatusBar token coverage'));
    doneItem?.click();
    return true;
  })()`);
  await new Promise((r) => setTimeout(r, 300));

  const detailTerm = await evaluate(`(() => ({
    hasSteerInput: Boolean(document.querySelector('[data-testid="subagent-steer-input"]')),
    hasTerminalFooter: Boolean(document.querySelector('[data-testid="subagent-footer-terminal"]')),
    streamText: document.querySelector('[data-testid="subagent-stream-canvas"]')?.textContent || '',
  }))()`);
  assert.equal(detailTerm.hasSteerInput, false, '终态子 Agent 严禁渲染纠偏输入框');
  assert.equal(detailTerm.hasTerminalFooter, true);
  assert.ok(detailTerm.streamText.includes('zero hex literals'), 'child_session_id 必须经 REST 回落加载完整执行消息');

  await evaluate(`(() => {
    document.querySelector('[data-testid="subagent-quote-btn"]')?.click();
    return true;
  })()`);
  const quotedVal = await evaluate(`document.getElementById('dock-prompt-input')?.value || ''`);
  assert.ok(quotedVal.includes('All design tokens verified'), '引用到主对话必须追加 blockquote 至主输入舱');
  assert.ok(quotedVal.startsWith('> [Verify StatusBar token coverage]'), '单层引用严禁双 > 嵌套');
  assert.equal(quotedVal.includes('> >'), false, '严禁生成 > > 双层 blockquote');
  await captureShot('05-desktop-dark-subagent-terminal.png');

  // 返回状态栏 -> 点文件芯片进 Files -> 校验 #btn-inspector-back-status 往返闭环
  await evaluate(`(() => { document.querySelector('[data-testid="subagent-back-btn"]')?.click(); return true; })()`);
  await new Promise((r) => setTimeout(r, 150));
  await evaluate(`(() => {
    if (!document.querySelector('[data-testid="context-breakdown-drawer"]')) {
      document.querySelector('[data-testid="status-context-trigger"]')?.click();
    }
    return true;
  })()`);
  for (let i = 0; i < 10; i += 1) {
    const hasChip = await evaluate(`Boolean(document.querySelector('.status-breakdown__file-list .status-file-chip'))`);
    if (hasChip) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  await evaluate(`(() => {
    document.querySelector('.status-breakdown__file-list .status-file-chip')?.click();
    return true;
  })()`);
  await new Promise((r) => setTimeout(r, 250));
  const filesBackState = await evaluate(`(() => ({
    podMode: document.getElementById('flux-inspector-pod')?.dataset?.podMode,
    hasBackBtn: Boolean(document.getElementById('btn-inspector-back-status')),
    filesTabActive: Boolean(document.querySelector('#flux-inspector-rail .vertical-tab-item')?.classList.contains('active-tab')),
  }))()`);
  assert.equal(filesBackState.podMode, 'files');
  assert.equal(filesBackState.hasBackBtn, true);
  assert.equal(filesBackState.filesTabActive, true);
  await captureShot('06-desktop-dark-files-back-btn.png');

  await evaluate(`(() => { document.getElementById('btn-inspector-back-status')?.click(); return true; })()`);
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(await evaluate(`document.getElementById('flux-inspector-pod')?.dataset?.podMode`), 'status');

  // 4. 浅色皮肤 ayu-light 验证
  await evaluate(`(() => { window.__fluxState.theme = 'ayu-light'; window.__fluxRender(); return true; })()`);
  await new Promise((r) => setTimeout(r, 200));
  await captureShot('07-desktop-light-status.png');
  await evaluate(`(() => { document.querySelector('.status-row[data-variant="active"] .status-row__main')?.click(); return true; })()`);
  await new Promise((r) => setTimeout(r, 250));
  await captureShot('08-desktop-light-subagent.png');

  // 5. 移动端 390×844 适配验证（触摸热区 + Files 树选择后自动收起不遮挡预览）
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await evaluate(`(() => {
    window.__fluxState.theme = 'obsidian-gold';
    document.querySelector('[data-testid="subagent-back-btn"]')?.click();
    window.__fluxRender();
    return true;
  })()`);
  await new Promise((r) => setTimeout(r, 250));
  const mobileStatus = await evaluate(`(() => {
    const pod = document.getElementById('flux-inspector-pod');
    const win = document.querySelector('.status-pod-window');
    const toggleBtn = document.getElementById('toggle-inspector-btn');
    const rowMain = document.querySelector('.status-row[data-variant="active"] .status-row__main');
    const ctxTrigger = document.querySelector('[data-testid="status-context-trigger"]');
    const interruptBtn = document.querySelector('.status-row[data-variant="active"] .status-row__interrupt');
    return {
      podWidth: pod?.getBoundingClientRect().width ?? 0,
      winHeight: win?.getBoundingClientRect().height ?? 0,
      toggleHeight: toggleBtn?.getBoundingClientRect().height ?? 0,
      rowMainHeight: rowMain?.getBoundingClientRect().height ?? 0,
      ctxTriggerHeight: ctxTrigger?.getBoundingClientRect().height ?? 0,
      interruptHeight: interruptBtn?.getBoundingClientRect().height ?? 0,
    };
  })()`);
  assert.ok(mobileStatus.podWidth >= 320, `移动端状态栏应占满视口宽度，实测 ${mobileStatus.podWidth}`);
  assert.ok(mobileStatus.winHeight < 800, `移动端状态卡片也必须按内容贴合高度，实测 ${mobileStatus.winHeight}`);
  assert.ok(mobileStatus.rowMainHeight >= 44, `移动端状态行触摸热区必须 >= 44px，实测 ${mobileStatus.rowMainHeight}`);
  assert.ok(mobileStatus.ctxTriggerHeight >= 44, `移动端上下文触发区触摸热区必须 >= 44px，实测 ${mobileStatus.ctxTriggerHeight}`);
  assert.ok(mobileStatus.interruptHeight >= 44, `移动端停止按钮触摸热区必须 >= 44px，实测 ${mobileStatus.interruptHeight}`);
  await captureShot('09-mobile-status.png');

  // 在移动端切换到文件模式并点击文件节点，断言文件树自动折叠让位预览区
  await evaluate(`(() => {
    document.querySelector('#flux-inspector-rail .vertical-tab-item')?.click();
    return true;
  })()`);
  await new Promise((r) => setTimeout(r, 250));
  await evaluate(`(() => {
    window.__fluxState.fileTreeCollapsed = false;
    window.__fluxRender();
    return true;
  })()`);
  await new Promise((r) => setTimeout(r, 150));
  await evaluate(`(() => {
    document.querySelector('[data-tree-file]')?.click();
    return true;
  })()`);
  await new Promise((r) => setTimeout(r, 250));
  const mobileFilesCollapsed = await evaluate(`Boolean(window.__fluxState.fileTreeCollapsed)`);
  assert.equal(mobileFilesCollapsed, true, '390px 移动端选完文件后文件树必须自动折叠以免遮挡预览');
  await captureShot('10-mobile-files-selected.png');

  await send('Emulation.clearDeviceMetricsOverride');

  fs.writeFileSync(
    path.join(ARTIFACT_DIR, 'evidence.json'),
    `${JSON.stringify({
      feature: 'status-bar-subagent-monitor',
      status: 'PASSED',
      recordedAt: new Date().toISOString(),
      statusGeom,
      expandedStatus,
      detailActive,
      steerFeedbackCheck,
      fullscreenCheck,
      degradedCheck,
      detailTerm,
      filesBackState,
      mobileStatus,
      mobileFilesCollapsed,
      screenshots: [
        '01-desktop-dark-status-open.png',
        '02-desktop-dark-status-breakdown.png',
        '03-desktop-dark-group-status.png',
        '04-desktop-dark-subagent-active.png',
        '05-desktop-dark-subagent-terminal.png',
        '06-desktop-dark-files-back-btn.png',
        '07-desktop-light-status.png',
        '08-desktop-light-subagent.png',
        '09-mobile-status.png',
        '10-mobile-files-selected.png',
      ],
    }, null, 2)}\n`,
    'utf8',
  );
});
