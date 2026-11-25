/**
 * 桌面端与移动端交付物画廊 / 媒体灯箱 / 文件夹对齐真实 Blink CDP E2E 测试
 * (packages/desktop/__tests__/cdp/deliverables-and-folder-ux-cdp.test.mjs)
 *
 * 【设计意图 (Why)】
 *   1. 验证 Desktop (1280×820) 真实渲染链路：左轨项目/文件夹图标位于名称右侧、
 *      助手回合成果物画廊（3 图 / 视频 / 文件卡片）与裸 `MEDIA:` 文本彻底剥离、
 *      点击图片唤醒 MediaLightbox 缩放 (`125%`) / 鼠标拖拽平移 / 复位 (`100%`) / 翻页 (`2 / 3`) / `Escape` 关闭；
 *   2. 验证 Mobile (390×844, DPR=3, hasTouch) 真实渲染链路：首页项目/文件夹图标右对齐、
 *      进入会话再返回首页后所有列表行取消激活态并呈透明底 (`rgba(0, 0, 0, 0)`)、
 *      媒体灯箱全视口内按钮零溢出、检查舱 Artifacts 标签页渲染受沙箱隔离 (`sandbox="allow-scripts"`) 的亮白底 HTML 画布、
 *      以及 Markdown 渲染态 ⇄ 源码态切换。
 *
 * 【防范的历史坑 (Pitfall)】
 *   1. Mobile 选中已有活跃会话时，若未预设 `activeLiveSessionId` 与 `messages.length > 0`，`selectSession` 会异步清空消息流；
 *   2. `localStorage` / `theme` 跨端共用同源端口时须在切换 Mobile 前清空并预设纯哑光深色皮肤 `obsidian-gold`；
 *   3. 所有等待统一通过 `waitFor` 轮询真实 DOM 与样式属性，严禁无条件固定 sleep 赌渲染时序。
 *
 * 【约束与规则 (Rules)】
 *   - 全程驱动真实编译产物 (`packages/desktop/dist/renderer/index.html` 与 `packages/mobile/dist/index.html`)；
 *   - 捕获 5 张端到端截图存入 `artifacts/verification/deliverables-and-folder-ux/` 供视觉复核。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BROWSER_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
];

const DESKTOP_ENTRY = 'packages/desktop/dist/renderer/index.html';
const MOBILE_ENTRY = 'packages/mobile/dist/index.html';
const SCREENSHOT_DIR = path.resolve(process.cwd(), 'artifacts/verification/deliverables-and-folder-ux');

function toSvgDataUrl(label, bgHex, accentHex) {
  const svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="320" viewBox="0 0 480 320">',
    `<rect width="480" height="320" rx="16" fill="${bgHex}"/>`,
    `<rect x="24" y="24" width="432" height="272" rx="12" fill="none" stroke="${accentHex}" stroke-width="4"/>`,
    `<circle cx="140" cy="160" r="56" fill="${accentHex}" opacity="0.22"/>`,
    `<path d="M100 185 L165 130 L230 175 L310 110 L380 190" fill="none" stroke="${accentHex}" stroke-width="6" stroke-linecap="round"/>`,
    `<text x="240" y="260" font-family="sans-serif" font-size="24" font-weight="700" fill="${accentHex}" text-anchor="middle">${label}</text>`,
    '</svg>',
  ].join('');
  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
}

const SVG_DATA_URLS = [
  toSvgDataUrl('Architecture Diagram', '#10141d', '#d4a84f'),
  toSvgDataUrl('Render Benchmark', '#141a24', '#5ec2a6'),
  toSvgDataUrl('Layout Spec', '#1a1520', '#8ab4f8'),
];

const VIDEO_DATA_URL = `data:video/mp4;base64,${Buffer.from('ftypisom-mock-video-payload').toString('base64')}`;

const HTML_ARTIFACT = [
  '<!doctype html>',
  '<html lang="zh-CN">',
  '<head><meta charset="utf-8"><title>Demo Report</title>',
  '<style>body{font-family:system-ui,sans-serif;margin:24px;background:#ffffff;color:#18181b;}h1{font-size:20px;margin:0 0 8px;}p{color:#52525b;font-size:14px;}</style>',
  '</head>',
  '<body><main><h1>Hermes Flux Visual Deliverable</h1><p>Light canvas contrast verified inside sandboxed mobile inspector reader.</p></main></body>',
  '</html>',
].join('');

const MD_ARTIFACT = [
  '# Release Verification Notes',
  '',
  '- **Checklist**: Deliver 3 images, 1 HTML report, and 1 Markdown note.',
  '- **Theme**: Obsidian Gold Dark Mode',
].join('\n');

const MIME_MAP = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

function createStaticServer(rootDir) {
  return http.createServer((req, res) => {
    const reqPath = decodeURIComponent((req.url || '/').split('?')[0]);
    const cleanPath = reqPath === '/' ? `/${DESKTOP_ENTRY}` : reqPath;
    const filePath = path.join(rootDir, cleanPath);
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME_MAP[ext] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
  });
}

async function waitFor(probe, deadlineMs = 15000, intervalMs = 120) {
  const started = Date.now();
  let last;
  while (Date.now() - started < deadlineMs) {
    last = await probe();
    if (last) return last;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return null;
}

function createCdpClient(ws) {
  let msgId = 0;
  const pending = new Map();
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(String(event.data));
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) {
        reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      } else {
        resolve(msg.result);
      }
    }
  });
  return {
    send(method, params = {}) {
      const id = ++msgId;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    async evalVal(expression) {
      const res = await this.send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (res.exceptionDetails) {
        throw new Error(`Runtime exception: ${JSON.stringify(res.exceptionDetails)}`);
      }
      return res.result?.value;
    },
    async capturePng(filename) {
      const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
      const outPath = path.join(SCREENSHOT_DIR, filename);
      fs.writeFileSync(outPath, Buffer.from(data, 'base64'));
      return outPath;
    },
  };
}

function parseRgb(colorStr) {
  const m = String(colorStr || '').match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (!m) return null;
  return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]) };
}

test('CDP L6: Desktop 与 Mobile 文件夹对齐、回合交付物画廊、灯箱缩放平移、HTML 亮底对比与 Markdown 视图切换', async (t) => {
  const browserPath = BROWSER_CANDIDATES.find((p) => fs.existsSync(p));
  if (!browserPath) {
    t.skip('未检测到 Edge/Chrome，跳过 L6 Blink CDP 验证');
    return;
  }
  const rootDir = process.cwd();
  if (!fs.existsSync(path.join(rootDir, DESKTOP_ENTRY)) || !fs.existsSync(path.join(rootDir, MOBILE_ENTRY))) {
    t.skip('构建产物缺失，请先执行 npm run build && npm run build:mobile:assets');
    return;
  }

  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const server = createStaticServer(rootDir);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const httpPort = server.address().port;

  const probe = http.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const cdpPort = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));

  const userDataDir = path.resolve(os.tmpdir(), `flux-deliv-cdp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  const desktopUrl = `http://127.0.0.1:${httpPort}/${DESKTOP_ENTRY}`;
  const mobileUrl = `http://127.0.0.1:${httpPort}/${MOBILE_ENTRY}`;

  const proc = spawn(
    browserPath,
    [
      `--remote-debugging-port=${cdpPort}`,
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      `--user-data-dir=${userDataDir}`,
      '--window-size=1280,820',
      desktopUrl,
    ],
    { stdio: 'ignore' },
  );

  let ws = null;
  t.after(async () => {
    try {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ id: 999999, method: 'Browser.close' }));
        await new Promise((r) => setTimeout(r, 300));
        ws.close();
      }
    } catch {}
    try { proc.kill(); } catch {}
    try { server.close(); } catch {}
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}
  });

  const target = await waitFor(async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${cdpPort}/json`);
      const list = await res.json();
      return list.find((item) => item.type === 'page' && item.webSocketDebuggerUrl) || null;
    } catch {
      return null;
    }
  }, 15000, 150);
  assert.ok(target, 'Chromium CDP 调试端点必须正常就绪');

  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  const cdp = createCdpClient(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1280,
    height: 820,
    deviceScaleFactor: 1,
    mobile: false,
  });

  // ════════════════════════════════════════════════════════════════════════
  // Part 1: Desktop (1280×820) 文件夹对齐 + 回合交付物 + 媒体灯箱交互
  // ════════════════════════════════════════════════════════════════════════
  const desktopBooted = await waitFor(
    () => cdp.evalVal('Boolean(window.__fluxState && window.__fluxRender)'),
    15000,
    120,
  );
  assert.equal(desktopBooted, true, 'Desktop 渲染壳必须暴露 __fluxState 与 __fluxRender');

  const desktopAssistantContent = [
    '文件',
    '',
    '- 公众号：`/opt/data/projects/mp-langchao/drafts/2026-11-23-t3code-telemetry.html`',
    '- 小红书：/opt/data/projects/mp-langchao/drafts/2026-11-23-t3code-xiaohongshu.md',
    '- 信息图：`/opt/data/projects/mp-langchao/drafts/img/t3-timeline.png`',
    '',
    `MEDIA:${SVG_DATA_URLS[0]}`,
    `MEDIA:${SVG_DATA_URLS[1]}`,
    `MEDIA:${SVG_DATA_URLS[2]}`,
    `MEDIA:${VIDEO_DATA_URL}`,
    '参考只读源码 `/etc/hosts` 与 `/opt/data/secret.json`。',
  ].join('\n');

  await cdp.evalVal(`(() => {
    const s = window.__fluxState;
    s.gatewayConnected = true;
    s.theme = 'obsidian-gold';
    s.lang = 'zh';
    s.profileName = 'default';
    s.leftRailCollapsed = false;
    s.profiles = [{ name: 'default', displayName: 'Flux Assistant', isDefault: true, model: 'claude-3.7' }];
    s.projects = [{ id: 'proj-1', name: 'Flux Core', path: '/work/flux', archived: false }];
    s.orgFolders = [{ id: 'fld-1', name: '设计归档', color: 'warning', order: 0, createdAt: 1, updatedAt: 1 }];
    s.orgAssignments = { 'session:default:s-desk': 'fld-1' };
    s.orgContainerCollapsed = {};
    s.sessions = [
      { id: 's-proj', title: '架构讨论', botName: 'default', cwd: '/work/flux', updatedAt: 1730000001000 },
      { id: 's-desk', title: '交付物画廊与文件夹验货', botName: 'default', cwd: '/other', updatedAt: 1730000002000 },
    ];
    s.activeSessionId = 's-desk';
    s.activeLiveSessionId = 'live-s-desk';
    s.activeFocus = { type: 'session', sessionId: 's-desk', botName: 'default' };
    s.isStreaming = false;
    s.messages = [
      {
        id: 'd-u1',
        role: 'user',
        content: '请输出公众号 HTML、小红书 Markdown、Python 生成的信息图，外加三张高清图与演示视频。',
        timestamp: 1730000001000,
      },
      {
        id: 'd-a1',
        role: 'assistant',
        timestamp: 1730000002000,
        content: ${JSON.stringify(desktopAssistantContent)},
        toolCalls: [
          {
            id: 'tc-ro-cat',
            name: 'terminal',
            status: 'done',
            args: ${JSON.stringify(JSON.stringify({ command: 'cat /etc/hosts' }))},
            output: '/opt/data/secret.json',
          },
          {
            id: 'tc-ro-read',
            name: 'read_file',
            status: 'done',
            args: ${JSON.stringify(JSON.stringify({ path: '/opt/data/secret.json' }))},
          },
          {
            id: 'tc-html-1',
            name: 'write_file',
            status: 'done',
            args: ${JSON.stringify(JSON.stringify({ path: '/opt/data/projects/mp-langchao/drafts/2026-11-23-t3code-telemetry.html', content: HTML_ARTIFACT }))},
          },
          {
            id: 'tc-md-1',
            name: 'write_file',
            status: 'done',
            args: ${JSON.stringify(JSON.stringify({ path: '/opt/data/projects/mp-langchao/drafts/2026-11-23-t3code-xiaohongshu.md', content: MD_ARTIFACT }))},
          },
          {
            id: 'tc-py-img',
            name: 'execute_code',
            status: 'done',
            args: ${JSON.stringify(JSON.stringify({ command: 'python3 render_timeline.py' }))},
            output: 'Saved timeline to /opt/data/projects/mp-langchao/drafts/img/t3-timeline.png',
          },
        ],
      },
    ];
    window.__fluxRender();
    return true;
  })()`);

  const desktopDom = await waitFor(
    () =>
      cdp.evalVal(`(() => {
        const projHeader = document.querySelector('[data-container-kind="project"]');
        const fldHeader = document.querySelector('[data-container-kind="folder"]');
        const projIcon = document.querySelector('[data-container-kind="project"] [data-container-icon="project"]');
        const fldIcon = document.querySelector('[data-container-kind="folder"] [data-container-icon="folder"]');
        const gallery = document.querySelector('[data-testid="turn-deliverables-images"]');
        const imgs = Array.from(document.querySelectorAll('[data-testid="turn-deliverable-image"] img'));
        const inlineCards = Array.from(document.querySelectorAll('[data-deliverable-card="true"]'));
        const delivBox = document.querySelector('[data-testid="turn-deliverables"]');
        const footerBox = document.querySelector('[data-msg-id="d-a1"] .conv-message__footer');
        const railBadge = document.querySelector('#flux-inspector-rail [data-tab="artifacts"] [data-testid="desktop-artifacts-badge"]');
        if (!projHeader || !fldHeader || !gallery || imgs.length !== 3 || inlineCards.length !== 3 || !delivBox || !footerBox || !railBadge) return null;
        if (!imgs.every((img) => img.complete && img.naturalWidth > 0)) return null;
        return {
          hasProjIcon: Boolean(projIcon),
          hasFldIcon: Boolean(fldIcon),
          countAttr: gallery.getAttribute('data-count'),
          inlineSummary: inlineCards.map((el) => ({
            name: el.querySelector('.conv-inline-deliverable__name')?.textContent?.trim() || '',
            ext: el.querySelector('.conv-inline-deliverable__ext')?.textContent?.trim() || '',
            title: el.getAttribute('title') || '',
            height: el.getBoundingClientRect().height,
          })),
          imageCount: document.querySelectorAll('[data-testid="turn-deliverable-image"]').length,
          imageCardHeights: Array.from(document.querySelectorAll('[data-testid="turn-deliverable-image"]')).map((el) => el.getBoundingClientRect().height),
          videoCount: document.querySelectorAll('[data-testid="turn-deliverable-video"]').length,
          fileCount: document.querySelectorAll('[data-testid="turn-deliverable-file"]').length,
          delivBottom: delivBox.getBoundingClientRect().bottom,
          footerTop: footerBox.getBoundingClientRect().top,
          railBadgeText: railBadge.textContent?.trim() || '',
          hasRawMediaTag: (document.querySelector('#conversation-stream')?.innerText || '').includes('MEDIA:'),
        };
      })()`),
    15000,
    120,
  );
  assert.ok(desktopDom, 'Desktop 项目/文件夹容器与原地+隐式成果物必须在 DOM 上完整渲染');
  assert.equal(desktopDom.hasProjIcon, false, 'Desktop 项目标题旁不得保留后置文件夹图标');
  assert.equal(desktopDom.hasFldIcon, false, 'Desktop 文件夹标题旁不得保留后置文件夹图标');
  assert.deepEqual(
    desktopDom.inlineSummary.map((c) => c.name),
    ['2026-11-23-t3code-telemetry.html', '2026-11-23-t3code-xiaohongshu.md', 't3-timeline.png'],
    '正文内反引号与裸路径均须原地替换为仅显示文件名的小卡片',
  );
  for (const card of desktopDom.inlineSummary) {
    assert.ok(card.height > 0 && card.height <= 36, `桌面端原地小卡片须为紧凑高度 (<=36px)，实测 ${card.height}`);
    assert.ok(card.title.includes('/opt/data/'), '完整路径必须收进 tooltip title');
  }
  assert.equal(desktopDom.countAttr, 'multi');
  assert.equal(desktopDom.imageCount, 3, '仅未在正文出现的 3 张 MEDIA 图渲染于页脚上方');
  for (const h of desktopDom.imageCardHeights) {
    assert.ok(h > 0 && h <= 48, `图片成果物须使用紧凑小卡片而非大图块，实测 height=${h}`);
  }
  assert.equal(desktopDom.videoCount, 1);
  assert.equal(desktopDom.fileCount, 0, '正文已原地渲染的 HTML/MD 不得在底部再次重复展示');
  assert.ok(
    desktopDom.delivBottom <= desktopDom.footerTop + 2,
    `隐式成果物区域必须在时间页脚正上方 (delivBottom=${desktopDom.delivBottom} <= footerTop=${desktopDom.footerTop})`,
  );
  assert.equal(desktopDom.railBadgeText, '7', '右侧竖栏成果物入口角标必须准确计数为 7（排除只读工具文件）');
  assert.equal(desktopDom.hasRawMediaTag, false, '消息气泡正文不得残留裸 MEDIA: 指令文本');

  await cdp.capturePng('desktop-stage.png');

  // 点击第一张紧凑图片卡唤醒 MediaLightbox 并执行 放大 -> 拖拽平移 -> 截图 -> 重置 -> 下一张 -> Escape 关闭
  await cdp.evalVal(`document.querySelector('[data-testid="turn-deliverable-image"]')?.click()`);
  const lbReady = await waitFor(
    () => cdp.evalVal(`Boolean(document.querySelector('[data-testid="media-lightbox"]'))`),
    8000,
    80,
  );
  assert.equal(lbReady, true, '点击交付物图片必须弹出 MediaLightbox');

  await cdp.evalVal(`document.querySelector('[data-testid="lightbox-zoom-in"]')?.click()`);
  const zoomedLabel = await waitFor(
    () => cdp.evalVal(`document.querySelector('[data-testid="lightbox-zoom-label"]')?.textContent?.trim() === '125%'`),
    5000,
    60,
  );
  assert.equal(zoomedLabel, true, '点击放大按钮后缩放读数必须变为 125%');

  const stageInfo = await cdp.evalVal(`(() => {
    const stage = document.querySelector('.flux-lightbox__stage');
    const img = document.querySelector('.flux-lightbox__image');
    const r = stage?.getBoundingClientRect();
    return r ? { cx: r.left + r.width / 2, cy: r.top + r.height / 2, beforeTransform: img?.style.transform || '' } : null;
  })()`);
  assert.ok(stageInfo, '灯箱舞台必须具备有效几何矩形');

  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: stageInfo.cx,
    y: stageInfo.cy,
    button: 'left',
    clickCount: 1,
  });
  for (let step = 1; step <= 5; step += 1) {
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: stageInfo.cx + step * 14,
      y: stageInfo.cy + step * 9,
      button: 'left',
      buttons: 1,
    });
  }
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: stageInfo.cx + 70,
    y: stageInfo.cy + 45,
    button: 'left',
    clickCount: 1,
  });

  const pannedTransform = await waitFor(
    () =>
      cdp.evalVal(`(() => {
        const t = document.querySelector('.flux-lightbox__image')?.style.transform || '';
        return t && t !== ${JSON.stringify(stageInfo.beforeTransform)} ? t : null;
      })()`),
    5000,
    60,
  );
  assert.ok(pannedTransform && pannedTransform.includes('translate3d('), `放大后鼠标拖拽必须更新 translate3d 平移矩阵: ${pannedTransform}`);

  await cdp.capturePng('desktop-lightbox.png');

  await cdp.evalVal(`document.querySelector('[data-testid="lightbox-zoom-reset"]')?.click()`);
  const resetOk = await waitFor(
    () => cdp.evalVal(`document.querySelector('[data-testid="lightbox-zoom-label"]')?.textContent?.trim() === '100%'`),
    5000,
    60,
  );
  assert.equal(resetOk, true, '点击重置按钮后缩放必须恢复 100%');

  await cdp.evalVal(`document.querySelector('[data-testid="lightbox-next"]')?.click()`);
  const nextCounterOk = await waitFor(
    () => cdp.evalVal(`document.querySelector('[data-testid="lightbox-counter"]')?.textContent?.trim() === '2 / 4'`),
    5000,
    60,
  );
  assert.equal(nextCounterOk, true, '点击下一张后计数器必须切换为 2 / 4');

  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  const closedOk = await waitFor(
    () => cdp.evalVal(`!document.querySelector('[data-testid="media-lightbox"]')`),
    5000,
    60,
  );
  assert.equal(closedOk, true, '按 Escape 必须关闭 MediaLightbox');

  // 点击桌面右侧竖栏「成果物」入口 -> 展开同窗左侧纯文件名列表并验证过滤
  await cdp.evalVal(`document.querySelector('#flux-inspector-rail [data-tab="artifacts"]')?.click()`);
  const desktopArtifactsSidebar = await waitFor(
    () =>
      cdp.evalVal(`(() => {
        const pane = document.querySelector('[data-testid="desktop-artifacts-pane"]');
        if (!pane) return null;
        const rows = Array.from(pane.querySelectorAll('[data-testid="desktop-artifact-row"]'));
        if (rows.length === 0) return null;
        return rows.map((row) => ({
          label: row.querySelector('.inspector-tree-label')?.textContent?.trim() || '',
          ext: row.querySelector('.inspector-artifact-ext')?.textContent?.trim() || '',
          path: row.getAttribute('data-artifact-file') || '',
        }));
      })()`),
    8000,
    80,
  );
  assert.ok(desktopArtifactsSidebar && desktopArtifactsSidebar.length === 7, '桌面成果物侧边栏必须列出全部 7 项成果物');
  assert.equal(
    desktopArtifactsSidebar.some((r) => r.label.includes('/opt/data/')),
    false,
    '桌面成果物侧边栏仅展示文件名，绝不显示完整目录前缀',
  );
  assert.ok(
    desktopArtifactsSidebar.some((r) => r.label === 't3-timeline.png' && r.ext === 'PNG'),
    '桌面成果物侧边栏必须收录脚本生成的 t3-timeline.png 并标出 PNG 短徽标',
  );
  assert.equal(
    desktopArtifactsSidebar.some((r) => r.path.includes('/etc/hosts') || r.path.includes('secret.json')),
    false,
    '只读文件绝不得混入桌面成果物侧边栏',
  );
  await new Promise((r) => setTimeout(r, 260));
  await cdp.capturePng('desktop-artifacts-sidebar.png');

  await cdp.evalVal(`(() => {
    const inp = document.getElementById('inspector-artifacts-filter-input');
    if (!inp) return false;
    inp.value = 'timeline';
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  const filteredArtifactsCount = await waitFor(
    () => cdp.evalVal(`(() => {
      const rows = Array.from(document.querySelectorAll('[data-testid="desktop-artifact-row"]'));
      return rows.length === 1 ? rows[0].querySelector('.inspector-tree-label')?.textContent?.trim() : null;
    })()`),
    5000,
    60,
  );
  assert.equal(filteredArtifactsCount, 't3-timeline.png', '成果物侧边栏筛选框必须实时过滤并收敛到 t3-timeline.png');

  // ════════════════════════════════════════════════════════════════════════
  // Part 2: Mobile (390×844, DPR=3) 首页行高亮清理 + 灯箱边界 + HTML 亮底 + MD 切换
  // ════════════════════════════════════════════════════════════════════════
  await cdp.evalVal(`localStorage.clear(); localStorage.setItem('hermes_flux_theme', 'obsidian-gold'); localStorage.setItem('hermes_flux_mobile_appearance', 'dark');`);
  await cdp.send('Emulation.setUserAgentOverride', {
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
    platform: 'Android',
  });
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 3,
    mobile: true,
    hasTouch: true,
  });
  await cdp.send('Page.navigate', { url: mobileUrl });

  const mobileBooted = await waitFor(
    () => cdp.evalVal(`Boolean(window.__fluxState && window.__fluxRender && document.querySelector('.m-home'))`),
    15000,
    120,
  );
  assert.equal(mobileBooted, true, 'Mobile 壳必须正常加载 .m-home 并暴露 __fluxState');

  await cdp.evalVal(`(() => {
    const s = window.__fluxState;
    s.theme = 'obsidian-gold';
    s.lang = 'zh';
    s.gatewayConnected = true;
    s.profileName = 'default';
    s.profiles = [{ name: 'default', displayName: 'Flux Assistant', isDefault: true, model: 'claude-3.7' }];
    s.projects = [{ id: 'proj-m1', name: 'Mobile Core', path: '/work/mobile', archived: false }];
    s.orgFolders = [{ id: 'fld-m1', name: '移动设计归档', color: 'warning', order: 0, createdAt: 1, updatedAt: 1 }];
    s.orgAssignments = { 'session:default:s-m-fld': 'fld-m1' };
    s.orgContainerCollapsed = {};
    s.sessions = [
      { id: 's-m-proj', title: '项目排期会议', botName: 'default', cwd: '/work/mobile', updatedAt: 1730000010000 },
      { id: 's-m-fld', title: '视觉稿归档讨论', botName: 'default', cwd: '/other', updatedAt: 1730000020000 },
      { id: 's-m-stage', title: '多模态成果物验收', botName: 'default', cwd: '/other', updatedAt: 1730000030000 },
    ];
    s.activeSessionId = 's-m-stage';
    s.activeLiveSessionId = 'live-s-m-stage';
    s.activeFocus = { type: 'session', sessionId: 's-m-stage', botName: 'default' };
    s.isStreaming = false;
    s.messages = [
      {
        id: 'mm-u1',
        role: 'user',
        content: '请生成移动端三图画廊、HTML 报告和 Markdown 备忘录。',
        timestamp: 1730000031000,
      },
      {
        id: 'mm-a1',
        role: 'assistant',
        timestamp: 1730000032000,
        content: [
          '移动端成果物已齐备，可直接在对话和检查舱中查看：',
          'MEDIA:' + ${JSON.stringify(SVG_DATA_URLS[0])},
          'MEDIA:' + ${JSON.stringify(SVG_DATA_URLS[1])},
          'MEDIA:' + ${JSON.stringify(SVG_DATA_URLS[2])},
          '[demo.html](/out/demo.html)',
          '[notes.md](/out/notes.md)',
        ].join('\\n'),
        toolCalls: [
          {
            id: 'tc-m-html',
            name: 'write_file',
            status: 'done',
            args: ${JSON.stringify(JSON.stringify({ path: '/out/demo.html', content: HTML_ARTIFACT }))},
          },
          {
            id: 'tc-m-md',
            name: 'write_file',
            status: 'done',
            args: ${JSON.stringify(JSON.stringify({ path: '/out/notes.md', content: MD_ARTIFACT }))},
          },
        ],
      },
    ];
    window.__fluxRender();
    return true;
  })()`);

  const mobileHomeIcons = await waitFor(
    () =>
      cdp.evalVal(`(() => {
        const hasSessionRow = Boolean(document.querySelector('.m-section[data-section="sessions"] .m-entity-row'));
        if (!hasSessionRow) return null;
        return {
          hasProjIcon: Boolean(document.querySelector('[data-container-icon="project"]')),
          hasFldIcon: Boolean(document.querySelector('[data-container-icon="folder"]')),
          hasSessionRow,
        };
      })()`),
    15000,
    120,
  );
  assert.ok(mobileHomeIcons && mobileHomeIcons.hasSessionRow, 'Mobile 首页容器与普通会话行必须渲染');
  assert.equal(mobileHomeIcons.hasProjIcon, false, 'Mobile 项目标题旁不得保留后置文件夹图标');
  assert.equal(mobileHomeIcons.hasFldIcon, false, 'Mobile 自定义文件夹标题旁不得保留后置文件夹图标');

  // 点击进入会话舞台，随后按返回回到首页并断言全行取消激活且透明底
  await cdp.evalVal(`document.querySelector('.m-section[data-section="sessions"] .m-entity-row')?.click()`);
  const enteredStage = await waitFor(
    () => cdp.evalVal(`document.querySelector('.m-shell')?.getAttribute('data-active-pane') === 'stage'`),
    8000,
    80,
  );
  assert.equal(enteredStage, true, '点击 Mobile 首页会话行必须进入 stage 屏');

  await new Promise((r) => setTimeout(r, 250));
  await cdp.evalVal(`window.dispatchEvent(new CustomEvent('hermes-mobile-back', { cancelable: true }))`);
  const backHomeRows = await waitFor(
    () =>
      cdp.evalVal(`(() => {
        if (document.querySelector('.m-shell')?.getAttribute('data-active-pane') !== 'home') return null;
        const rows = Array.from(document.querySelectorAll('.m-entity-row'));
        if (rows.length === 0) return null;
        return rows.map((row) => ({
          active: row.getAttribute('data-active'),
          bg: window.getComputedStyle(row).backgroundColor,
        }));
      })()`),
    8000,
    80,
  );
  assert.ok(backHomeRows, '返回 Mobile 首页后必须能读取列表行状态');
  for (const row of backHomeRows) {
    assert.equal(row.active, 'false', `返回首页后每一行 data-active 必须为 false: ${JSON.stringify(row)}`);
    assert.equal(row.bg, 'rgba(0, 0, 0, 0)', `返回首页后每一行背景必须保持透明: ${JSON.stringify(row)}`);
  }
  await new Promise((r) => setTimeout(r, 260));
  await cdp.capturePng('mobile-home.png');

  // 重新进入 stage 验证紧凑交付物（原地小卡片 + 页脚上方小图卡）与移动端 MediaLightbox 视口边界
  await cdp.evalVal(`document.querySelector('.m-section[data-section="sessions"] .m-entity-row')?.click()`);
  const mobileDeliverablesOk = await waitFor(
    () =>
      cdp.evalVal(`(() => {
        if (document.querySelector('.m-shell')?.getAttribute('data-active-pane') !== 'stage') return null;
        const g = document.querySelector('[data-testid="turn-deliverables-images"]');
        const imgs = Array.from(document.querySelectorAll('[data-testid="turn-deliverable-image"] img'));
        const inlineCards = Array.from(document.querySelectorAll('[data-deliverable-card="true"]'));
        const delivBox = document.querySelector('[data-testid="turn-deliverables"]');
        const footerBox = document.querySelector('[data-msg-id="mm-a1"] .conv-message__footer');
        if (!g || imgs.length !== 3 || !imgs.every((i) => i.complete && i.naturalWidth > 0) || inlineCards.length !== 2 || !delivBox || !footerBox) return null;
        return {
          count: g.getAttribute('data-count'),
          inlineNames: inlineCards.map((c) => c.querySelector('.conv-inline-deliverable__name')?.textContent?.trim() || ''),
          inlineHeights: inlineCards.map((c) => c.getBoundingClientRect().height),
          imgCardHeights: Array.from(document.querySelectorAll('[data-testid="turn-deliverable-image"]')).map((el) => el.getBoundingClientRect().height),
          delivBottom: delivBox.getBoundingClientRect().bottom,
          footerTop: footerBox.getBoundingClientRect().top,
        };
      })()`),
    10000,
    100,
  );
  assert.ok(mobileDeliverablesOk, 'Mobile 舞台必须完整渲染正文原地卡片与 3 张紧凑小图卡');
  assert.equal(mobileDeliverablesOk.count, 'multi');
  assert.deepEqual(mobileDeliverablesOk.inlineNames, ['demo.html', 'notes.md']);
  for (const h of [...mobileDeliverablesOk.inlineHeights, ...mobileDeliverablesOk.imgCardHeights]) {
    assert.ok(h >= 34 && h <= 52, `移动端成果物紧凑小卡片高度须保持在 36~52px 区间，实测 ${h}`);
  }
  assert.ok(
    mobileDeliverablesOk.delivBottom <= mobileDeliverablesOk.footerTop + 2,
    `移动端隐式成果物区域必须在时间页脚正上方 (delivBottom=${mobileDeliverablesOk.delivBottom} <= footerTop=${mobileDeliverablesOk.footerTop})`,
  );

  await cdp.evalVal(`document.querySelector('[data-testid="turn-deliverable-image"]')?.click()`);
  const mobileLbGeom = await waitFor(
    () =>
      cdp.evalVal(`(() => {
        const root = document.querySelector('[data-testid="media-lightbox"]');
        if (!root) return null;
        const topbar = root.querySelector('.flux-lightbox__topbar');
        const toolbar = root.querySelector('.flux-lightbox__toolbar');
        const imgsLoaded = Array.from(root.querySelectorAll('img')).every((i) => i.complete && i.naturalWidth > 0);
        if (!topbar || !toolbar || !imgsLoaded) return null;
        const buttons = Array.from(root.querySelectorAll('button')).map((b) => {
          const r = b.getBoundingClientRect();
          return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
        });
        const tb = topbar.getBoundingClientRect();
        const tl = toolbar.getBoundingClientRect();
        return { tb, tl, buttons, vw: window.innerWidth, vh: window.innerHeight };
      })()`),
    8000,
    80,
  );
  assert.ok(mobileLbGeom, 'Mobile MediaLightbox 必须正常挂载与加载图像');
  for (const b of mobileLbGeom.buttons) {
    assert.ok(
      b.left >= -1 && b.right <= 391 && b.top >= -1 && b.bottom <= 845,
      `Mobile 灯箱控制按钮不得溢出 390×844 视口: ${JSON.stringify(b)}`,
    );
  }
  await cdp.capturePng('mobile-stage-lightbox.png');

  await cdp.evalVal(`window.dispatchEvent(new CustomEvent('hermes-mobile-back', { cancelable: true }))`);
  const mobileLbDismissed = await waitFor(
    () => cdp.evalVal(`!document.querySelector('[data-testid="media-lightbox"]')`),
    5000,
    60,
  );
  assert.equal(mobileLbDismissed, true, 'hermes-mobile-back 必须关闭 Mobile MediaLightbox');

  // 打开检查舱 -> 切换到 Artifacts Tab -> 打开 demo.html 校验亮白画布对比度与 sandbox 隔离
  await cdp.evalVal(`document.querySelector('[data-testid="mobile-stage-open-inspector"]')?.click()`);
  const inspectorReady = await waitFor(
    () => cdp.evalVal(`document.querySelector('.m-shell')?.getAttribute('data-active-pane') === 'inspector' && Boolean(document.querySelector('[data-testid="mobile-inspector-pane"]'))`),
    8000,
    80,
  );
  assert.equal(inspectorReady, true, '点击检查舱按钮必须滑入 Inspector 屏');

  await cdp.evalVal(`(() => {
    const segBtns = Array.from(document.querySelectorAll('.m-inspector__seg-btn'));
    if (segBtns[0]) segBtns[0].click();
    return true;
  })()`);

  const mobileArtCards = await waitFor(
    () =>
      cdp.evalVal(`(() => {
        const cards = Array.from(document.querySelectorAll('[data-testid="mobile-artifact-card"]'));
        if (cards.length < 2) return null;
        return cards.map((c) => (c.textContent || '').trim());
      })()`),
    8000,
    80,
  );
  assert.ok(mobileArtCards, 'Mobile Artifacts 列表必须渲染成果物卡片');
  assert.equal(
    mobileArtCards.some((txt) => txt.includes('/out/')),
    false,
    `Mobile Artifacts 卡片仅显示纯文件名，严禁显示完整目录路径: ${JSON.stringify(mobileArtCards)}`,
  );

  const htmlClicked = await waitFor(
    () =>
      cdp.evalVal(`(() => {
        const cards = Array.from(document.querySelectorAll('[data-testid="mobile-artifact-card"]'));
        const htmlCard = cards.find((c) => (c.textContent || '').includes('demo.html'));
        if (!htmlCard) return false;
        htmlCard.click();
        return true;
      })()`),
    8000,
    80,
  );
  assert.equal(htmlClicked, true, 'Artifacts 列表必须包含并打开 demo.html 卡片');

  const htmlFrameCheck = await waitFor(
    () =>
      cdp.evalVal(`(() => {
        const frame = document.querySelector('[data-testid="mobile-inspector-html-frame"]');
        if (!frame) return null;
        const wrap = frame.closest('.m-inspector__reader-html-wrap') || frame;
        return {
          sandbox: frame.getAttribute('sandbox') || '',
          frameBg: window.getComputedStyle(frame).backgroundColor,
          wrapBg: window.getComputedStyle(wrap).backgroundColor,
          theme: document.documentElement.dataset.theme || window.__fluxState?.theme || '',
        };
      })()`),
    8000,
    80,
  );
  assert.ok(htmlFrameCheck, 'HTML 检查舱预览 iframe 必须成功挂载');
  assert.equal(htmlFrameCheck.sandbox, 'allow-scripts', 'HTML iframe 必须严格锁定为 sandbox="allow-scripts" 且不得包含 allow-same-origin');
  const rgb = parseRgb(htmlFrameCheck.frameBg) || parseRgb(htmlFrameCheck.wrapBg);
  assert.ok(
    rgb && rgb.r >= 240 && rgb.g >= 240 && rgb.b >= 240,
    `暗色皮肤下 HTML iframe 必须具备独立亮白纸张背景以保障黑字对比度: ${JSON.stringify(htmlFrameCheck)}`,
  );

  await new Promise((r) => setTimeout(r, 250));
  await cdp.capturePng('mobile-inspector-html.png');

  // 关闭阅读器 -> 打开 notes.md 验证 Markdown 渲染态与源码态切换
  await cdp.evalVal(`window.dispatchEvent(new CustomEvent('hermes-mobile-back', { cancelable: true }))`);
  const readerClosed = await waitFor(
    () => cdp.evalVal(`document.querySelector('.m-inspector__reader')?.getAttribute('data-open') === 'false'`),
    5000,
    60,
  );
  assert.equal(readerClosed, true, '返回手势必须先关闭检查舱详情阅读器而非直接退出检查舱');

  const mdClicked = await waitFor(
    () =>
      cdp.evalVal(`(() => {
        const cards = Array.from(document.querySelectorAll('[data-testid="mobile-artifact-card"]'));
        const mdCard = cards.find((c) => (c.textContent || '').includes('notes.md'));
        if (!mdCard) return false;
        mdCard.click();
        return true;
      })()`),
    5000,
    80,
  );
  assert.equal(mdClicked, true, 'Artifacts 列表必须包含并打开 notes.md 卡片');

  const mdRendered = await waitFor(
    () =>
      cdp.evalVal(`(() => {
        const md = document.querySelector('[data-testid="mobile-inspector-markdown"]');
        const toggle = document.querySelector('[data-testid="mobile-inspector-toggle-view"]');
        return md && toggle ? { mdText: (md.textContent || '').trim() } : null;
      })()`),
    8000,
    80,
  );
  assert.ok(mdRendered && mdRendered.mdText.includes('Release Verification Notes'), 'Markdown 成果物默认必须渲染富文本阅读视图');

  await cdp.evalVal(`document.querySelector('[data-testid="mobile-inspector-toggle-view"]')?.click()`);
  const rawSourceOk = await waitFor(
    () =>
      cdp.evalVal(`(() => {
        const pre = document.querySelector('pre.m-inspector__reader-code');
        const hasMd = Boolean(document.querySelector('[data-testid="mobile-inspector-markdown"]'));
        return pre && !hasMd ? (pre.textContent || '') : null;
      })()`),
    5000,
    60,
  );
  assert.ok(rawSourceOk && rawSourceOk.includes('# Release Verification Notes'), '点击源码切换按钮后必须切换到原始 Markdown 源码视图');
});
