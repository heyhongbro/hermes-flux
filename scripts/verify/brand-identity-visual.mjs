#!/usr/bin/env node
/**
 * Hermes Flux 品牌视觉与多态动效物理渲染验证（真实 Blink + 真实 dist 产物与皮肤 CSS）
 *
 * 【设计意图 (Why)】
 *   验证包豪斯折纸雨燕在真实 Blink 浏览器渲染下的全部用户可达态：
 *   1. 冷启动过渡屏（真实 packages/desktop/dist/renderer/index.html）：
 *      桌面 1280x800 与手机 390x844 安全区下居中无横向溢出，favicon 可加载，飞行动效运行；
 *   2. obsidian-gold（暗色）与 ayu-light（浅色）双皮肤下的真实 React 组件合集：
 *      - ConversationSkeleton (variant="mark", motion="fly", 无文本、无底框)
 *      - ConversationMessageList 空会话画布 (variant="badge", motion="glide", 带 FLUX 字标)
 *      - SettingsModal AboutPanel (variant="icon", motion="static", 无 FLUX 字标)
 *   3. 窗口隐藏态退化验证：写入 data-app-hidden="true" 后，实测计算样式
 *      animationPlayState === "paused" 且 willChange === "auto"（合成层释放）。
 *
 * 【约束与规则 (Rules)】
 *   - 绝不 mock 组件或皮肤 CSS，只驱动真实 dist 产物；
 *   - 临时目录严格建在 os.tmpdir() 并在 finally 清理，退出前显式发送 Browser.close；
 *   - 截图与 evidence.json 落盘至 artifacts/verification/brand-identity/，任一断言失败非零退出。
 */

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { ConversationSkeleton } from '../../packages/ui/dist/components-react/conversation/ConversationSkeleton.js';
import { ConversationMessageList } from '../../packages/ui/dist/components-react/conversation/ConversationMessageList.js';
import { SettingsModal } from '../../packages/ui/dist/components-react/settings/SettingsModal.js';
import { BrandSwiftMark } from '../../packages/ui/dist/icons/BrandMark.js';
import { setLocale } from '../../packages/ui/dist/i18n/index.js';

const uiRequire = createRequire(new URL('../../packages/ui/package.json', import.meta.url));
const React = uiRequire('react');
const { renderToStaticMarkup } = uiRequire('react-dom/server');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../..');
const RENDERER_DIST = path.join(REPO_ROOT, 'packages/desktop/dist/renderer');
const OUT_DIR = path.join(REPO_ROOT, 'artifacts/verification/brand-identity');

const BROWSER_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

function createSettingsSnapshot(theme) {
  return {
    isOpen: true,
    section: 'about',
    theme,
    locale: 'zh',
    fontPrefs: { uiFont: 'geist-sans', monoFont: 'jetbrains-mono', sizeScale: 'medium' },
    activityVariant: 'cloud',
    conversationWidth: 'wide',
    leftRailLayout: 'dual-rail',
    profiles: { status: 'ready', data: [] },
    bots: [],
    botManagement: {
      status: { status: 'idle', activeBotId: 'default' },
      roster: [],
      activeBotId: 'default',
      activeDetail: undefined,
      availableModels: [],
      activeDraft: undefined,
      wizard: {
        open: false,
        draft: {
          mode: 'blank', name: '', displayName: '', description: '', model: '', provider: '',
          cloneFrom: '', cloneChannels: false, mirrorCredentials: false,
        },
        busy: false,
      },
      exitPrompt: null,
      errorBanner: undefined,
      highlightBotId: undefined,
      isBusy: false,
    },
    scopedProfile: 'default',
    providerViews: { status: 'ready', data: [] },
    providerFailures: [],
    subscriptionCatalog: { status: 'ready', data: [] },
    customEndpoints: { status: 'ready', data: [] },
    endpointProfiles: {},
    endpointFailures: [],
    providerAdminBusy: false,
    mcp: { status: 'ready', data: [] },
    skills: { status: 'ready', data: [] },
    gateway: {
      url: 'http://127.0.0.1:9119',
      username: '',
      hasStoredPassword: false,
      profileName: 'default',
      status: 'connected',
      latencyMs: 12,
    },
    appVersion: '0.1.0',
    platform: 'win32',
    busy: false,
    presenceLayout: 'stage',
  };
}

const SETTINGS_ACTIONS = new Proxy({}, { get: () => () => {} });

function renderBrandScenesHtml(theme) {
  setLocale('zh-CN');
  const skeletonMarkup = renderToStaticMarkup(React.createElement(ConversationSkeleton));
  const emptyMarkup = renderToStaticMarkup(
    React.createElement(ConversationMessageList, {
      snapshot: {
        mode: 'scratchpad',
        connection: 'connected',
        messages: [],
        isStreaming: false,
        messagesPhase: 'ready',
      },
    }),
  );
  const aboutBadgeMarkup = renderToStaticMarkup(
    React.createElement(BrandSwiftMark, { variant: 'icon', motion: 'static', size: 64, decorative: false, label: 'Variant A' }),
  );
  const aboutModalMarkup = renderToStaticMarkup(
    React.createElement(SettingsModal, {
      snapshot: createSettingsSnapshot(theme),
      actions: SETTINGS_ACTIONS,
    }),
  );

  return `<!DOCTYPE html>
<html lang="zh-CN" data-theme="${theme}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
  <title>Hermes Flux Brand Identity Gallery (${theme})</title>
  <link rel="icon" type="image/svg+xml" href="/icons/brand/hermes-flux-icon.svg">
  <link rel="icon" type="image/png" sizes="32x32" href="/icons/brand/favicon-32.png">
  <link rel="stylesheet" href="/styles.css">
  <link rel="stylesheet" href="/conversation.css">
  <link rel="stylesheet" href="/tailwind.css">
  <style>
    html, body { margin: 0; padding: 0; height: auto; overflow: auto; background: var(--background); color: var(--foreground); }
    .verify-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 24px; padding: 24px; max-width: 1280px; margin: 0 auto; box-sizing: border-box; }
    .verify-card { background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius-panel); padding: 20px; display: flex; flex-direction: column; gap: 12px; }
    [data-verify-card="about"] { grid-column: 1 / -1; }
    .verify-card h2 { margin: 0; font-family: var(--font-sans); font-size: var(--fs-section); font-weight: 600; color: var(--foreground); }
    .verify-about-stage > [data-state="open"]:not([role="dialog"]), .verify-about-stage > .fixed.inset-0 { display: none !important; }
    .verify-about-stage [role="dialog"] { position: static !important; left: auto !important; top: auto !important; inset: auto !important; transform: none !important; translate: none !important; width: 100% !important; max-width: 100% !important; height: 420px !important; max-height: none !important; }
  </style>
</head>
<body>
  <div class="verify-grid">
    <section class="verify-card" data-verify-card="skeleton">
      <h2>Loading Skeleton (Mark · Fly)</h2>
      ${skeletonMarkup}
    </section>
    <section class="verify-card" data-verify-card="empty">
      <h2>Empty New Session (Badge + FLUX)</h2>
      ${emptyMarkup}
    </section>
    <section class="verify-card" data-verify-card="about">
      <h2>Variant A Icon &amp; About Panel</h2>
      <div style="display:flex;align-items:center;gap:12px;">${aboutBadgeMarkup}</div>
      <div class="verify-about-stage">${aboutModalMarkup}</div>
    </section>
  </div>
</body>
</html>`;
}

function startStaticServer() {
  const mimeMap = {
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
  };

  const server = http.createServer((req, res) => {
    const reqUrl = new URL(req.url || '/', 'http://127.0.0.1');
    const urlPath = decodeURIComponent(reqUrl.pathname);

    // 拦截 index.js 让真实的 dist/renderer/index.html 停留在冷启动预挂载态以便验屏与实测计算样式
    if (urlPath === '/index.js' && reqUrl.searchParams.get('holdBoot') === '1') {
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
      res.end('/* hold pre-mount cold-boot splash for physical verification */');
      return;
    }
    if (urlPath === '/index.html' && reqUrl.searchParams.get('holdBoot') === '1') {
      const html = fs
        .readFileSync(path.join(RENDERER_DIST, 'index.html'), 'utf8')
        .replace('src="index.js"', 'src="index.js?holdBoot=1"');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }
    if (urlPath === '/scenes') {
      const theme = reqUrl.searchParams.get('theme') === 'ayu-light' ? 'ayu-light' : 'obsidian-gold';
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderBrandScenesHtml(theme));
      return;
    }

    const relPath = (urlPath === '/' ? 'index.html' : urlPath).replace(/^\/+/, '');
    const resolved = path.resolve(RENDERER_DIST, relPath);
    if (!resolved.startsWith(RENDERER_DIST + path.sep) && resolved !== path.join(RENDERER_DIST, 'index.html')) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    if (!fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    const ext = path.extname(resolved).toLowerCase();
    res.writeHead(200, { 'Content-Type': mimeMap[ext] || 'application/octet-stream' });
    fs.createReadStream(resolved).pipe(res);
  });

  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function waitForCdpTarget(port) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json`);
      if (res.ok) {
        const list = await res.json();
        const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
        if (page) return page.webSocketDebuggerUrl;
      }
    } catch {
      // 等待浏览器 CDP 端口就绪
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('Blink CDP target 15s 内未就绪');
}

async function main() {
  const startedAt = Date.now();
  const browserPath = BROWSER_CANDIDATES.find((p) => fs.existsSync(p));
  if (!browserPath) throw new Error('未检测到可用 Edge/Chrome 内核');
  if (!fs.existsSync(path.join(RENDERER_DIST, 'index.html'))) {
    throw new Error('缺少 packages/desktop/dist/renderer/index.html，请先执行 npm run build');
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const server = await startStaticServer();
  const basePort = server.address().port;

  const portProbe = http.createServer();
  await new Promise((r) => portProbe.listen(0, '127.0.0.1', r));
  const cdpPort = portProbe.address().port;
  await new Promise((r) => portProbe.close(r));

  const userDataDir = path.resolve(os.tmpdir(), `flux-verify-brand-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  const proc = spawn(
    browserPath,
    [
      `--remote-debugging-port=${cdpPort}`,
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      `--user-data-dir=${userDataDir}`,
      '--window-size=1280,800',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  let ws = null;
  try {
    const wsUrl = await waitForCdpTarget(cdpPort);
    ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve);
      ws.addEventListener('error', reject);
    });
    let seq = 1;
    const send = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = seq++;
        const onMsg = (ev) => {
          const msg = JSON.parse(ev.data);
          if (msg.id !== id) return;
          ws.removeEventListener('message', onMsg);
          if (msg.error) reject(new Error(msg.error.message));
          else resolve(msg.result);
        };
        ws.addEventListener('message', onMsg);
        ws.send(JSON.stringify({ id, method, params }));
      });

    const evalJs = async (expression) => {
      const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      return res.result.value;
    };

    const navigateAndWait = async (url, width, height) => {
      await send('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: width <= 480,
        screenWidth: width,
        screenHeight: height,
      });
      await send('Page.navigate', { url });
      await new Promise((r) => setTimeout(r, 700));
    };

    await send('Page.enable');

    // 1. 真实冷启动 index.html (桌面 1280x800 + 手机 390x844 安全区与无横向溢出)
    const baseUrl = `http://127.0.0.1:${basePort}`;
    await navigateAndWait(`${baseUrl}/index.html?holdBoot=1`, 1280, 800);
    const bootDesktop = await evalJs(`(() => {
      const splash = document.querySelector('[data-boot-splash="true"]');
      const rotor = splash?.querySelector('.flux-brand-swift__rotor');
      const swift = splash?.querySelector('.flux-brand-swift');
      const icons = [...document.querySelectorAll('link[rel="icon"]')].map((l) => l.getAttribute('href'));
      return {
        hasSplash: Boolean(splash),
        wordmark: splash?.querySelector('.flux-boot-splash__wordmark')?.textContent || '',
        icons,
        polygons: splash?.querySelectorAll('svg polygon').length || 0,
        hasShadow: Boolean(splash?.querySelector('.flux-brand-swift__shadow')),
        reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
        swiftDisplay: swift ? getComputedStyle(swift).display : '',
        rotorDisplay: rotor ? getComputedStyle(rotor).display : '',
        sheets: [...document.styleSheets].map((s) => ({ href: s.href, rules: s.cssRules?.length ?? -1 })),
        rotorBox: rotor ? rotor.getBoundingClientRect().toJSON() : null,
        rotorAnim: rotor ? getComputedStyle(rotor).animationName : '',
        rotorPlayState: rotor ? getComputedStyle(rotor).animationPlayState : '',
        rotorWillChange: rotor ? getComputedStyle(rotor).willChange : '',
        scrollOverflowX: document.documentElement.scrollWidth > window.innerWidth,
      };
    })()`);
    if (
      !bootDesktop.hasSplash ||
      bootDesktop.wordmark !== 'HERMES FLUX' ||
      bootDesktop.polygons !== 9 ||
      !bootDesktop.hasShadow ||
      bootDesktop.scrollOverflowX
    ) {
      throw new Error(`桌面冷启动闪屏断言失败: ${JSON.stringify(bootDesktop)}`);
    }
    if (bootDesktop.rotorAnim !== 'fluxSwiftFly' || bootDesktop.rotorPlayState !== 'running') {
      throw new Error(`冷启动飞行关键帧未激活: ${JSON.stringify(bootDesktop)}`);
    }
    const bootShot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    fs.writeFileSync(path.join(OUT_DIR, 'boot-splash.png'), Buffer.from(bootShot.data, 'base64'));

    // 验证隐屏态暂停 + will-change: auto 释放
    await evalJs(`document.documentElement.dataset.appHidden = 'true'`);
    await new Promise((r) => setTimeout(r, 80));
    const bootHidden = await evalJs(`(() => {
      const rotor = document.querySelector('[data-boot-splash="true"] .flux-brand-swift__rotor');
      return {
        playState: rotor ? getComputedStyle(rotor).animationPlayState : '',
        willChange: rotor ? getComputedStyle(rotor).willChange : '',
      };
    })()`);
    if (bootHidden.playState !== 'paused' || bootHidden.willChange !== 'auto') {
      throw new Error(`隐屏合成层释放失败: ${JSON.stringify(bootHidden)}`);
    }

    // 手机窄屏 390x844 无横向溢出检查
    await navigateAndWait(`${baseUrl}/index.html?holdBoot=1`, 390, 844);
    const bootMobile = await evalJs(`({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      splashHeight: Math.round(document.querySelector('[data-boot-splash="true"]')?.getBoundingClientRect().height || 0),
    })`);
    if (bootMobile.scrollWidth > bootMobile.innerWidth || bootMobile.splashHeight < Math.round(bootMobile.innerHeight * 0.95)) {
      throw new Error(`移动窄屏冷启动布局异常: ${JSON.stringify(bootMobile)}`);
    }

    // 检查 brand icon SVG / PNG HTTP 200 可达
    for (const href of bootDesktop.icons) {
      const resp = await fetch(`${baseUrl}/${href}`);
      if (resp.status !== 200) throw new Error(`Favicon 资源请求失败 (${href}): HTTP ${resp.status}`);
    }

    // 2. 暗色 (obsidian-gold) 与浅色 (ayu-light) 工作台三场景实时渲染截屏 + 物理验证
    const sceneChecks = {};
    for (const theme of ['obsidian-gold', 'ayu-light']) {
      await navigateAndWait(`${baseUrl}/scenes?theme=${theme}`, 1280, 1060);
      const metrics = await evalJs(`(() => {
        const skelMark = document.querySelector('[data-verify-card="skeleton"] .flux-brand-swift');
        const emptyBadge = document.querySelector('[data-verify-card="empty"] .flux-brand-swift');
        const aboutIcon = document.querySelector('[data-verify-card="about"] [data-settings-anchor="about-version"] .flux-brand-swift');
        const aboutStage = document.querySelector('.verify-about-stage');
        const aboutDialog = aboutStage?.querySelector('[role="dialog"]');
        const stageRect = aboutStage?.getBoundingClientRect();
        const dialogRect = aboutDialog?.getBoundingClientRect();
        const overlayEls = [...document.querySelectorAll('.verify-about-stage > .fixed.inset-0, .verify-about-stage > [data-state="open"]:not([role="dialog"])')];
        return {
          theme: document.documentElement.getAttribute('data-theme'),
          bg: getComputedStyle(document.body).backgroundColor,
          skelVariant: skelMark?.getAttribute('data-brand-variant'),
          skelMotion: skelMark?.getAttribute('data-brand-motion'),
          skelHasText: Boolean(skelMark?.querySelector('text')),
          skelPolygons: skelMark?.querySelectorAll('svg polygon').length || 0,
          skelHasShadow: Boolean(skelMark?.querySelector('.flux-brand-swift__shadow')),
          emptyVariant: emptyBadge?.getAttribute('data-brand-variant'),
          emptyMotion: emptyBadge?.getAttribute('data-brand-motion'),
          emptyWordmark: emptyBadge?.querySelector('text')?.textContent || '',
          emptyPolygons: emptyBadge?.querySelectorAll('svg polygon').length || 0,
          aboutVariant: aboutIcon?.getAttribute('data-brand-variant'),
          aboutHasText: Boolean(aboutIcon?.querySelector('text')),
          aboutPolygons: aboutIcon?.querySelectorAll('svg polygon').length || 0,
          aboutWidth: Math.round(aboutIcon?.getBoundingClientRect().width || 0),
          overlayCount: overlayEls.length,
          overlayHidden: overlayEls.length > 0 && overlayEls.every((el) => getComputedStyle(el).display === 'none'),
          aboutDialogInBounds: Boolean(
            stageRect &&
            dialogRect &&
            dialogRect.left >= stageRect.left - 2 &&
            dialogRect.right <= stageRect.right + 2 &&
            dialogRect.height >= 360,
          ),
          scrollOverflowX: document.documentElement.scrollWidth > window.innerWidth,
        };
      })()`);
      if (
        metrics.skelVariant !== 'mark' ||
        metrics.skelMotion !== 'fly' ||
        metrics.skelHasText ||
        metrics.skelPolygons !== 9 ||
        !metrics.skelHasShadow ||
        metrics.emptyVariant !== 'badge' ||
        metrics.emptyMotion !== 'glide' ||
        metrics.emptyWordmark !== 'FLUX' ||
        metrics.emptyPolygons !== 9 ||
        metrics.aboutVariant !== 'icon' ||
        metrics.aboutHasText ||
        metrics.aboutPolygons !== 9 ||
        metrics.aboutWidth !== 48 ||
        !metrics.overlayHidden ||
        !metrics.aboutDialogInBounds ||
        metrics.scrollOverflowX
      ) {
        throw new Error(`场景 ${theme} 品牌分流或几何断言失败: ${JSON.stringify(metrics)}`);
      }
      sceneChecks[theme] = metrics;
      const shot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
      const shotBuf = Buffer.from(shot.data, 'base64');
      fs.writeFileSync(path.join(OUT_DIR, theme === 'obsidian-gold' ? 'scenes-dark.png' : 'scenes-light.png'), shotBuf);
      if (theme === 'obsidian-gold') {
        fs.writeFileSync(path.join(OUT_DIR, 'screenshot.png'), shotBuf);
      }
    }

    const evidence = {
      featureId: 'brand-identity',
      status: 'PASSED',
      durationMs: Date.now() - startedAt,
      titlebarTitle: 'Hermes Flux Brand Identity Gallery',
      bootDesktop,
      bootHidden,
      bootMobile,
      sceneChecks,
      screenshots: ['screenshot.png', 'boot-splash.png', 'scenes-dark.png', 'scenes-light.png'],
    };
    fs.writeFileSync(path.join(OUT_DIR, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify(evidence, null, 2));
  } finally {
    try {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ id: 999999, method: 'Browser.close' }));
        await new Promise((r) => setTimeout(r, 200));
        ws.close();
      }
    } catch {
      // 忽略关闭期竞态断开
    }
    try {
      proc.kill();
    } catch {
      // 忽略已退出进程
    }
    try {
      server.close();
    } catch {
      // 忽略已关闭服务
    }
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      // Windows 临时句柄稍后自洁
    }
  }
}

main().catch((err) => {
  console.error('[brand-identity-visual] FAILED:', err);
  process.exit(1);
});
