/**
 * 桌面端安全文档预览特权协议控制器 (hermes-preview://) 单测
 * (packages/desktop/__tests__/unit/previewProtocol.test.mjs)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import {
  HERMES_PREVIEW_SCHEME,
  createPreviewProtocolController,
} from '../../dist/main/previewProtocol.mjs';

test('previewProtocol: Mode A 工作区路径解析、入口原文响应、Range 206 流、CORS 与安全防线', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-preview-proto-'));
  try {
    const docsDir = path.join(tmpDir, 'docs');
    const assetsDir = path.join(tmpDir, 'assets');
    fs.mkdirSync(docsDir, { recursive: true });
    fs.mkdirSync(assetsDir, { recursive: true });

    const entryHtmlPath = path.join(docsDir, 'report.html');
    const stylePath = path.join(docsDir, 'app.css');
    const fontPath = path.join(assetsDir, 'font.woff2');
    const envPath = path.join(tmpDir, '.env');

    const rawHtml = '<!doctype html><html><link rel="stylesheet" href="./app.css"><img src="/assets/font.woff2"></html>';
    fs.writeFileSync(entryHtmlPath, rawHtml, 'utf8');
    fs.writeFileSync(stylePath, 'body { color: #111; }', 'utf8');
    fs.writeFileSync(fontPath, Buffer.from('0123456789ABCDEF'));
    fs.writeFileSync(envPath, 'API_KEY=secret', 'utf8');

    const controller = createPreviewProtocolController({
      getGatewayAuth: () => ({ cookies: '', origin: '' }),
      getFallbackCwd: () => tmpDir,
      maxSessions: 2,
    });

    assert.equal(controller.registerSession({ entryPath: '', entryContent: 'x' }), null);
    assert.equal(controller.registerSession({ entryPath: envPath, entryContent: 'SECRET' }), null);
    assert.equal(controller.registerSession({ entryPath: '/etc/passwd', entryContent: 'root' }), null);

    const reg = controller.registerSession({
      entryPath: entryHtmlPath,
      entryContent: rawHtml,
      workspaceRoot: tmpDir,
    });
    assert.ok(reg !== null);
    assert.ok(reg.entryUrl.startsWith(`${HERMES_PREVIEW_SCHEME}://${reg.token}.preview/docs/report.html`));

    // OPTIONS preflight 支持 sandbox="allow-scripts" 内的 CORS
    const preflight = await controller.handleProtocolRequest(new Request(reg.entryUrl, { method: 'OPTIONS' }));
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), '*');
    assert.equal(preflight.headers.get('cross-origin-resource-policy'), 'cross-origin');

    // 不允许 POST/PUT
    const postRes = await controller.handleProtocolRequest(new Request(reg.entryUrl, { method: 'POST' }));
    assert.equal(postRes.status, 405);

    // 入口 HTML 直接返回内存原文，零破坏磁盘
    const entryRes = await controller.handleProtocolRequest(new Request(reg.entryUrl));
    assert.equal(entryRes.status, 200);
    assert.equal(entryRes.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(await entryRes.text(), rawHtml);

    // 相对样式表
    const cssUrl = new URL('./app.css', reg.entryUrl).href;
    const cssRes = await controller.handleProtocolRequest(new Request(cssUrl));
    assert.equal(cssRes.status, 200);
    assert.equal(cssRes.headers.get('content-type'), 'text/css; charset=utf-8');
    assert.equal(await cssRes.text(), 'body { color: #111; }');

    // 根相对 + HTTP Range 206 分片 + 非法 Range 416
    const fontUrl = new URL('/assets/font.woff2', reg.entryUrl).href;
    const rangeRes = await controller.handleProtocolRequest(
      new Request(fontUrl, { headers: { Range: 'bytes=2-5' } }),
    );
    assert.equal(rangeRes.status, 206);
    assert.equal(rangeRes.headers.get('content-type'), 'font/woff2');
    assert.equal(rangeRes.headers.get('content-range'), 'bytes 2-5/16');
    assert.equal(await rangeRes.text(), '2345');

    const headRangeRes = await controller.handleProtocolRequest(
      new Request(fontUrl, { method: 'HEAD', headers: { Range: 'bytes=0-1' } }),
    );
    assert.equal(headRangeRes.status, 206);
    assert.equal(headRangeRes.headers.get('content-length'), '2');

    const badRangeRes = await controller.handleProtocolRequest(
      new Request(fontUrl, { headers: { Range: 'bytes=999-1000' } }),
    );
    assert.equal(badRangeRes.status, 416);

    // HEAD 请求无 body
    const headFont = await controller.handleProtocolRequest(new Request(fontUrl, { method: 'HEAD' }));
    assert.equal(headFont.status, 200);
    assert.equal(headFont.headers.get('content-length'), '16');

    // .env*、百分号编码穿越、非法 token 阻断
    const envRes = await controller.handleProtocolRequest(
      new Request(new URL('/.env', reg.entryUrl).href),
    );
    assert.equal(envRes.status, 403);

    const encodedTraversal = await controller.handleProtocolRequest(
      new Request(`${HERMES_PREVIEW_SCHEME}://${reg.token}.preview/%2e%2e/.env`),
    );
    assert.equal(encodedTraversal.status, 403);

    const wrongHost = await controller.handleProtocolRequest(
      new Request(`${HERMES_PREVIEW_SCHEME}://bad.host/docs/app.css`),
    );
    assert.equal(wrongHost.status, 403);

    // LRU 淘汰上限 (maxSessions = 2)
    const reg2 = controller.registerSession({ entryPath: stylePath, entryContent: '2', workspaceRoot: tmpDir });
    const reg3 = controller.registerSession({ entryPath: fontPath, entryContent: '3', workspaceRoot: tmpDir });
    assert.ok(reg2 && reg3);
    assert.equal(controller.getSessionCount(), 2);
    const evictedRes = await controller.handleProtocolRequest(new Request(reg.entryUrl));
    assert.equal(evictedRes.status, 404);

    assert.equal(controller.revokeSession(reg3.token), true);
    assert.equal(controller.revokeSession(reg3.token), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('previewProtocol: Mode A 符号链接逃逸阻断、Mode B 作用域边界与远端网关 Cookie/MIME 纠正', async () => {
  let seenCookie = null;
  let seenUrl = '';
  const controller = createPreviewProtocolController({
    getGatewayAuth: () => ({
      cookies: 'hermes_session=abc',
      origin: 'https://gw.example.com',
    }),
    getFallbackCwd: () => '/repo',
    realpath: (p) => {
      if (p.includes('escaped-link.css')) return '/etc/shadow';
      return p;
    },
    resolveLocalFile: (raw) => (raw?.includes('escaped-link.css') ? '/repo/docs/escaped-link.css' : null),
    statFile: () => ({ size: 10, isFile: () => true }),
    fetchImpl: async (url, init) => {
      seenUrl = String(url);
      seenCookie = init?.headers && 'Cookie' in init.headers ? init.headers.Cookie : null;
      if (seenUrl.includes('/api/fs/download')) {
        return new Response(null, { status: 404 });
      }
      if (seenUrl.includes('missing.js')) {
        return new Response('<html>SPA fallback</html>', {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      }
      if (seenUrl.includes('sub.html')) {
        return new Response('<h1>Sub Page</h1>', {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      }
      return new Response('export const x = 1;', {
        status: 200,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    },
  });

  // Mode A 符号链接逃逸拒绝 403
  const symReg = controller.registerSession({
    entryPath: '/repo/docs/index.html',
    entryContent: '<html></html>',
    workspaceRoot: '/repo',
  });
  const symRes = await controller.handleProtocolRequest(
    new Request(new URL('./escaped-link.css', symReg.entryUrl).href),
  );
  assert.equal(symRes.status, 403);

  // Mode B 绝对路径与根相对防逃逸
  const modeB = controller.registerSession({
    entryPath: '/external/folder/demo.html',
    entryContent: '<html>ok</html>',
    gatewayUrl: 'https://gw.example.com',
    profile: 'default',
  });
  assert.ok(modeB.entryUrl.includes('/__doc__/external/folder/demo.html'));

  const escapeRoot = await controller.handleProtocolRequest(
    new Request(`${HERMES_PREVIEW_SCHEME}://${modeB.token}.preview/Users/victim/.ssh/id_rsa`),
  );
  assert.equal(escapeRoot.status, 403);

  // 远端网关 /api/fs/download 404 回退 /api/files/download + MIME 纠偏 (text/plain -> application/javascript)
  const modJs = await controller.handleProtocolRequest(
    new Request(new URL('./main.mjs', modeB.entryUrl).href),
  );
  assert.equal(modJs.status, 200);
  assert.equal(seenCookie, 'hermes_session=abc');
  assert.ok(seenUrl.includes('/api/files/download'));
  assert.equal(modJs.headers.get('content-type'), 'application/javascript; charset=utf-8');

  // 非 HTML 子资源遇到 SPA fallback 必须返 404
  const spaReject = await controller.handleProtocolRequest(
    new Request(new URL('./missing.js', modeB.entryUrl).href),
  );
  assert.equal(spaReject.status, 404);

  // .html 子页面允许正常返回 text/html
  const subHtml = await controller.handleProtocolRequest(
    new Request(new URL('./sub.html', modeB.entryUrl).href),
  );
  assert.equal(subHtml.status, 200);
  assert.equal(await subHtml.text(), '<h1>Sub Page</h1>');

  // 跨源网关禁止带 Cookie
  const crossOrigin = controller.registerSession({
    entryPath: 'rel/page.html',
    entryContent: '<html></html>',
    gatewayUrl: 'https://other-gw.example.com',
  });
  assert.ok(crossOrigin.entryUrl.includes('/__rel__/rel/page.html'));
  await controller.handleProtocolRequest(
    new Request(new URL('./app.js', crossOrigin.entryUrl).href),
  );
  assert.equal(seenCookie, null, '跨源网关请求绝不能携带 authenticatedOrigin Cookie');
});

test('previewProtocol: Windows 路径 Mode A/B、编码异常、符号链接报错、0字节与上游网关异常分支全覆盖', async () => {
  const controller = createPreviewProtocolController({
    getGatewayAuth: () => ({ cookies: '', origin: '' }),
    getFallbackCwd: () => 'D:/work',
    realpath: (p) => {
      if (p.includes('throw-realpath')) throw new Error('EPERM');
      return p;
    },
    resolveLocalFile: (raw) => {
      if (raw?.includes('empty.txt')) return 'd:/work/empty.txt';
      if (raw?.includes('notfile.bin')) return 'd:/work/notfile.bin';
      if (raw?.includes('throwstat.bin')) return 'd:/work/throwstat.bin';
      if (raw?.includes('throw-realpath')) return 'd:/work/throw-realpath.css';
      return null;
    },
    statFile: (absPath) => {
      if (absPath.includes('notfile.bin')) return { size: 0, isFile: () => false };
      if (absPath.includes('throwstat.bin')) throw new Error('ENOENT');
      if (absPath.includes('empty.txt')) return { size: 0, isFile: () => true };
      return { size: 12, isFile: () => true };
    },
    fetchImpl: async (url) => {
      const s = String(url);
      if (s.includes('net-err.css')) throw new Error('network down');
      if (s.includes('srv-500.css')) return new Response(null, { status: 500 });
      if (s.includes('gz.js')) {
        return new Response('export const z = 1;', {
          status: 200,
          headers: {
            'content-encoding': 'gzip',
            'content-type': 'application/octet-stream',
            etag: '"v1"',
          },
        });
      }
      return new Response(new Uint8Array([1, 2]), { status: 200 });
    },
  });

  // 异常 URL / 非 preview 协议 / 空 host / 未知 session
  assert.equal((await controller.handleProtocolRequest({ url: 'not a valid url' })).status, 400);
  assert.equal((await controller.handleProtocolRequest(new Request('https://example.com/a'))).status, 400);
  assert.equal((await controller.handleProtocolRequest(new Request(`${HERMES_PREVIEW_SCHEME}://.preview/a`))).status, 403);
  assert.equal(controller.revokeSession(null), false);

  // 空路径/工作区边界/Windows 盘符 Mode B
  const winModeA = controller.registerSession({
    entryPath: 'D:\\work\\docs\\page.html',
    entryContent: '<html>ok</html>',
    workspaceRoot: 'd:/work/',
  });
  assert.ok(winModeA.entryUrl.includes('/docs/page.html'));
  assert.equal((await controller.handleProtocolRequest(new Request(winModeA.entryUrl, { method: 'HEAD' }))).status, 200);
  assert.equal((await controller.handleProtocolRequest(new Request(`${HERMES_PREVIEW_SCHEME}://${winModeA.token}.preview/`))).status, 404);
  assert.equal((await controller.handleProtocolRequest(new Request(`${HERMES_PREVIEW_SCHEME}://${winModeA.token}.preview/%E0`))).status, 403);
  assert.equal((await controller.handleProtocolRequest(new Request(`${HERMES_PREVIEW_SCHEME}://${winModeA.token}.preview/empty.txt`))).status, 200);
  assert.equal((await controller.handleProtocolRequest(new Request(`${HERMES_PREVIEW_SCHEME}://${winModeA.token}.preview/notfile.bin`))).status, 404);
  assert.equal((await controller.handleProtocolRequest(new Request(`${HERMES_PREVIEW_SCHEME}://${winModeA.token}.preview/throwstat.bin`))).status, 404);
  assert.equal((await controller.handleProtocolRequest(new Request(`${HERMES_PREVIEW_SCHEME}://${winModeA.token}.preview/throw-realpath.css`))).status, 403);

  const winModeB = controller.registerSession({
    entryPath: 'E:/ext/docs/index.html',
    entryContent: '<html>winB</html>',
    workspaceRoot: 'D:/work',
    gatewayUrl: 'http://[::bad',
  });
  assert.ok(winModeB.entryUrl.includes('/__doc__/E:/ext/docs/index.html'));
  assert.equal((await controller.handleProtocolRequest(new Request(`${HERMES_PREVIEW_SCHEME}://${winModeB.token}.preview/__doc__/`))).status, 404);
  assert.equal((await controller.handleProtocolRequest(new Request(`${HERMES_PREVIEW_SCHEME}://${winModeB.token}.preview/__doc__/F:/unrelated/a.css`))).status, 403);
  assert.equal((await controller.handleProtocolRequest(new Request(`${HERMES_PREVIEW_SCHEME}://${winModeB.token}.preview/other.css`))).status, 403);
  assert.equal((await controller.handleProtocolRequest(new Request(new URL('./missing.png', winModeB.entryUrl).href))).status, 404);

  const relSession = controller.registerSession({
    entryPath: 'docs/sub.html',
    entryContent: '<html>rel</html>',
    gatewayUrl: 'https://gw.example.com',
    sessionId: 'sess-99',
  });
  assert.equal((await controller.handleProtocolRequest(new Request(`${HERMES_PREVIEW_SCHEME}://${relSession.token}.preview/__rel__/`))).status, 404);
  assert.equal((await controller.handleProtocolRequest(new Request(`${HERMES_PREVIEW_SCHEME}://${relSession.token}.preview/outside.css`))).status, 403);
  assert.equal((await controller.handleProtocolRequest(new Request(new URL('./net-err.css', relSession.entryUrl).href))).status, 502);
  assert.equal((await controller.handleProtocolRequest(new Request(new URL('./srv-500.css', relSession.entryUrl).href))).status, 500);

  const gzRes = await controller.handleProtocolRequest(
    new Request(new URL('./gz.js', relSession.entryUrl).href, {
      method: 'HEAD',
      headers: { Range: 'bytes=0-1' },
    }),
  );
  assert.equal(gzRes.status, 200);
  assert.equal(gzRes.headers.get('etag'), '"v1"');

  const binUnknownMime = await controller.handleProtocolRequest(
    new Request(new URL('./raw.custombin', relSession.entryUrl).href),
  );
  assert.equal(binUnknownMime.status, 200);
  assert.equal(binUnknownMime.headers.get('content-type'), 'application/octet-stream');

  // decodePathnameSafely 畸形段 (%2e%2e%2f)、registerSession 缺参 / 等于根、realpath(root) 抛错回退、回环缺失本地文件转网关
  const loopController = createPreviewProtocolController({
    getGatewayAuth: () => ({ cookies: '', origin: '' }),
    getFallbackCwd: () => 'D:/',
    realpath: (p) => {
      if (p === 'D:/' || p === 'd:/') throw new Error('no root realpath');
      return p;
    },
    resolveLocalFile: (raw) => (raw?.includes('missing-local.css') ? 'D:/sub/missing-local.css' : null),
    statFile: () => {
      throw new Error('ENOENT');
    },
    fetchImpl: async () => new Response('.ok{}', { status: 200, headers: { 'content-type': 'text/css' } }),
  });

  assert.equal(loopController.registerSession(null), null);
  assert.equal(loopController.registerSession({ entryPath: 'a.html' }), null);
  assert.equal(loopController.registerSession({ entryPath: '?onlyquery', entryContent: '<html></html>' }), null);
  assert.equal(loopController.registerSession({ entryPath: '   /   ', workspaceRoot: 'D:/' }), null);

  // Mode A: workspaceRoot 本身 realpath 抛错兜底 (catch {})、本地 null 返回 404、未知扩展名本地 MIME 兜底
  const modeANoRealpath = createPreviewProtocolController({
    getGatewayAuth: () => ({ cookies: '', origin: '' }),
    getFallbackCwd: () => 'E:/work-no-realpath',
    realpath: (p) => {
      if (p === 'E:/work-no-realpath') throw new Error('EPERM root');
      return p;
    },
    resolveLocalFile: (raw) => (raw?.includes('empty.custombin') ? 'E:/work-no-realpath/empty.custombin' : null),
    statFile: () => ({ size: 0, isFile: () => true }),
  });
  const modeAReg = modeANoRealpath.registerSession({
    entryPath: 'E:/work-no-realpath/docs/a.html',
    entryContent: '<html>ok</html>',
    workspaceRoot: 'E:/work-no-realpath',
  });
  assert.equal((await modeANoRealpath.handleProtocolRequest(new Request(new URL('./empty.custombin', modeAReg.entryUrl).href))).headers.get('content-type'), 'application/octet-stream');
  assert.equal((await modeANoRealpath.handleProtocolRequest(new Request(new URL('./missing.png', modeAReg.entryUrl).href))).status, 404);

  const eqRoot = loopController.registerSession({ entryPath: 'E:/repo', entryContent: '<html>root</html>', workspaceRoot: 'E:/repo' });
  assert.ok(eqRoot.entryUrl.includes('/__doc__/E:/repo'));

  const rootDoc = loopController.registerSession({ entryPath: '/rootpage.html', entryContent: '<html>rootpage</html>' });
  assert.equal((await loopController.handleProtocolRequest(new Request(`${HERMES_PREVIEW_SCHEME}://${rootDoc.token}.preview/__doc__/etc/passwd`))).status, 403);

  const driveModeA = loopController.registerSession({
    entryPath: 'D:/sub/a.html',
    entryContent: '<html>drive</html>',
    workspaceRoot: 'D:/',
    gatewayUrl: 'http://127.0.0.1:8765',
  });
  assert.ok(driveModeA.entryUrl.includes('/sub/a.html'));
  assert.equal((await loopController.handleProtocolRequest({ url: `${HERMES_PREVIEW_SCHEME}://${driveModeA.token}.preview/sub/%2e%2e%2fsecret.txt`, headers: new Headers() })).status, 403);
  assert.equal((await loopController.handleProtocolRequest(new Request(new URL('./missing-local.css', driveModeA.entryUrl).href))).status, 200);

  const badGwSession = loopController.registerSession({
    entryPath: 'D:/sub/badgw.html',
    entryContent: '<html>badgw</html>',
    workspaceRoot: 'D:/',
    gatewayUrl: 'http://[::bad',
  });
  assert.equal((await loopController.handleProtocolRequest(new Request(new URL('./missing-local.css', badGwSession.entryUrl).href))).status, 404);
});

test('previewProtocol: Mode B /__rel__/ 越权阻断、符号链接双态逃逸防护与无 fallbackCwd 兜底', async () => {
  const realMap = new Map([
    ['d:/ext/docs', 'd:/ext/docs'],
    ['d:/ext/docs/ok.png', 'd:/ext/docs/ok.png'],
    ['d:/ext/docs/evil.png', 'd:/secrets/key.txt'],
    ['d:/work', 'd:/work'],
    ['d:/work/sub', 'd:/work/sub'],
    ['d:/work/sub/nested', 'd:/work/sub/nested'],
    ['d:/work/sub/nested/ok.js', 'd:/work/sub/nested/ok.js'],
    ['d:/work/sub/ok.js', 'd:/work/sub/ok.js'],
    ['d:/work/sub/evil.css', 'd:/work/secret.css'],
    ['d:/work/app.css', 'd:/work/app.css'],
    ['d:/work/escape.css', 'd:/outside/escape.css'],
  ]);

  const localMap = new Map([
    ['ok.png', 'd:/ext/docs/ok.png'],
    ['evil.png', 'd:/ext/docs/evil.png'],
    ['sub/nested/ok.js', 'd:/work/sub/nested/ok.js'],
    ['sub/ok.js', 'd:/work/sub/ok.js'],
    ['sub/evil.css', 'd:/work/sub/evil.css'],
    ['app.css', 'd:/work/app.css'],
    ['escape.css', 'd:/work/escape.css'],
  ]);

  const controller = createPreviewProtocolController({
    getGatewayAuth: () => ({ cookies: '', origin: '' }),
    getFallbackCwd: () => 'D:/work',
    realpath: (p) => realMap.get(p.replace(/\\/g, '/').toLowerCase()) || p,
    resolveLocalFile: (raw) => {
      const norm = String(raw || '').replace(/\\/g, '/').toLowerCase();
      for (const [suffix, abs] of localMap.entries()) {
        if (norm.endsWith(suffix)) return abs;
      }
      return null;
    },
    statFile: () => ({ size: 5, isFile: () => true }),
    readFileStream: () => Readable.from([Buffer.from('asset')]),
  });

  // 1. Mode B 相对路径子目录 (docDir = 'sub/nested')：合法相对允许，向上 ../ 与 %2e%2e 阻断
  const subRelSession = controller.registerSession({
    entryPath: 'sub/nested/index.html',
    entryContent: '<html>sub</html>',
  });
  assert.equal((await controller.handleProtocolRequest(new Request(`${HERMES_PREVIEW_SCHEME}://${subRelSession.token}.preview/__rel__/sub/nested/ok.js`))).status, 200);
  assert.equal((await controller.handleProtocolRequest(new Request(new URL('../evil.css', subRelSession.entryUrl).href))).status, 403);
  assert.equal((await controller.handleProtocolRequest(new Request(`${HERMES_PREVIEW_SCHEME}://${subRelSession.token}.preview/__rel__/%2e%2e/outside.txt`))).status, 403);

  // 2. Mode B 根层相对文档 (docDir = '')：允许同级资源，阻断 '..' 与 '../...'
  const rootRelSession = controller.registerSession({
    entryPath: 'index.html',
    entryContent: '<html>root</html>',
  });
  assert.equal((await controller.handleProtocolRequest(new Request(`${HERMES_PREVIEW_SCHEME}://${rootRelSession.token}.preview/__rel__/app.css`))).status, 200);
  assert.equal((await controller.handleProtocolRequest(new Request(`${HERMES_PREVIEW_SCHEME}://${rootRelSession.token}.preview/__rel__/%2e%2e`))).status, 403);
  assert.equal((await controller.handleProtocolRequest(new Request(`${HERMES_PREVIEW_SCHEME}://${rootRelSession.token}.preview/__rel__/%2e%2e%2fsecret.txt`))).status, 403);
  assert.equal((await controller.handleProtocolRequest(new Request(`${HERMES_PREVIEW_SCHEME}://${rootRelSession.token}.preview/__rel__/escape.css`))).status, 403);
  assert.equal((await controller.handleProtocolRequest(new Request(`${HERMES_PREVIEW_SCHEME}://${rootRelSession.token}.preview/__rel__//Users/victim/secret.txt`))).status, 403);
  assert.equal((await controller.handleProtocolRequest(new Request(`${HERMES_PREVIEW_SCHEME}://${rootRelSession.token}.preview/__rel__/D:/secrets/key.txt`))).status, 403);

  // 3. Mode B 绝对路径外部文档：校验 symlinkRoot = docDir
  const absExtSession = controller.registerSession({
    entryPath: 'D:/ext/docs/index.html',
    entryContent: '<html>ext</html>',
    workspaceRoot: 'E:/other-ws',
  });
  assert.equal((await controller.handleProtocolRequest(new Request(new URL('./ok.png', absExtSession.entryUrl).href))).status, 200);
  assert.equal((await controller.handleProtocolRequest(new Request(new URL('./evil.png', absExtSession.entryUrl).href))).status, 403);

  // 4. Mode B 相对路径子目录 symlink 检查 (symlinkRoot = D:/work/sub)
  const relSubSymlinkSession = controller.registerSession({
    entryPath: 'sub/index.html',
    entryContent: '<html>sub2</html>',
  });
  assert.equal((await controller.handleProtocolRequest(new Request(new URL('./ok.js', relSubSymlinkSession.entryUrl).href))).status, 200);
  assert.equal((await controller.handleProtocolRequest(new Request(new URL('./evil.css', relSubSymlinkSession.entryUrl).href))).status, 403);

  // 5. Mode B 无 fallbackCwd 兜底分支 (symlinkRoot = '')
  const noCwdController = createPreviewProtocolController({
    getGatewayAuth: () => ({ cookies: '', origin: '' }),
    getFallbackCwd: () => '',
    resolveLocalFile: () => 'd:/any/app.css',
    statFile: () => ({ size: 5, isFile: () => true }),
    readFileStream: () => Readable.from([Buffer.from('okcss')]),
  });
  const noCwdRel = noCwdController.registerSession({
    entryPath: 'index.html',
    entryContent: '<html>nocwd</html>',
  });
  assert.equal((await noCwdController.handleProtocolRequest(new Request(new URL('./app.css', noCwdRel.entryUrl).href))).status, 200);

  // 6. Mode B 远端专有文件：resolveLocalFile 返回本地候选路径但物理 stat/realpath 均抛 ENOENT 时必须优雅回落网关返回 200（不可误判 403）
  const remoteOnlyController = createPreviewProtocolController({
    getGatewayAuth: () => ({ cookies: '', origin: '' }),
    getFallbackCwd: () => 'D:/work',
    resolveLocalFile: () => 'D:/work/docs/remote-only.css',
    statFile: () => {
      throw new Error('ENOENT');
    },
    realpath: () => {
      throw new Error('ENOENT');
    },
    fetchImpl: async () => new Response('.remote{color:blue}', { status: 200, headers: { 'content-type': 'text/css' } }),
  });
  const remoteOnlySession = remoteOnlyController.registerSession({
    entryPath: 'docs/report.html',
    entryContent: '<html>remote</html>',
    gatewayUrl: 'http://127.0.0.1:9001',
  });
  const remoteCssRes = await remoteOnlyController.handleProtocolRequest(
    new Request(new URL('./remote-only.css', remoteOnlySession.entryUrl).href),
  );
  assert.equal(remoteCssRes.status, 200);
  assert.equal(await remoteCssRes.text(), '.remote{color:blue}');
});
