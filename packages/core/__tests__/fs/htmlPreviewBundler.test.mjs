/**
 * HTML / CSS / SVG 非破坏性派生内联器单测 (packages/core/__tests__/fs/htmlPreviewBundler.test.mjs)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildInlinedHtmlPreview,
  buildInlinedSvgPreview,
  decodeDataUrlUtf8,
  inlineCssRelativeAssets,
} from '../../dist/index.js';

function createMemoryFetcher(files, maxAssetBytes = 5 * 1024 * 1024) {
  return async (targetPath) => {
    const entry = files[targetPath];
    if (!entry) {
      return {
        ok: false,
        path: targetPath,
        mime: 'application/octet-stream',
        isText: false,
        byteSize: 0,
        source: 'error',
        error: 'asset_unavailable',
      };
    }
    if (entry.byteSize > maxAssetBytes) {
      return {
        ok: false,
        path: targetPath,
        mime: entry.mime,
        isText: entry.isText,
        byteSize: 0,
        source: 'error',
        error: 'asset_too_large',
      };
    }
    return {
      ok: true,
      path: targetPath,
      mime: entry.mime,
      isText: entry.isText,
      ...(entry.text !== undefined ? { text: entry.text } : {}),
      ...(entry.dataUrl !== undefined ? { dataUrl: entry.dataUrl } : {}),
      byteSize: entry.byteSize,
      source: 'local_fs',
    };
  };
}

test('inlineCssRelativeAssets: 嵌套 @import、字体/图片 url(...)、#id 矢量保留、注释屏蔽与死循环阻断', async () => {
  const files = {
    '/repo/styles/base.css': {
      mime: 'text/css; charset=utf-8',
      isText: true,
      text: '@import "./theme.css"; /* url("./ignored-comment.png") */ @font-face { src: url("../fonts/inter.woff2"); }',
      byteSize: 80,
    },
    '/repo/styles/theme.css': {
      mime: 'text/css; charset=utf-8',
      isText: true,
      text: '@import "./entry.css"; .card { background: url("../img/bg.png#layer"); mask: url("#clip"); }',
      byteSize: 70,
    },
    '/repo/fonts/inter.woff2': {
      mime: 'font/woff2',
      isText: false,
      dataUrl: 'data:font/woff2;base64,Rk9OVA==',
      byteSize: 12,
    },
    '/repo/img/bg.png': {
      mime: 'image/png',
      isText: false,
      dataUrl: 'data:image/png;base64,UE5H',
      byteSize: 8,
    },
  };

  const entryCss = [
    '@import "./base.css" screen;',
    '@import "https://cdn.example.com/reset.css";',
    '@import "../../../.env";',
    '.hero { background-image: url("https://cdn.example.com/hero.jpg"); }',
  ].join('\n');

  const out = await inlineCssRelativeAssets(entryCss, '/repo/styles/entry.css', {
    workspaceRoot: '/repo',
    assetFetcher: createMemoryFetcher(files),
  });

  assert.ok(out.includes('@media screen {'), '@import media 规则必须保留');
  assert.ok(out.includes('url("data:font/woff2;base64,Rk9OVA==")'));
  assert.ok(out.includes('url("data:image/png;base64,UE5H#layer")'));
  assert.ok(out.includes('mask: url("#clip")'), '页内 SVG #id 引用必须原样保留');
  assert.ok(out.includes('@import "https://cdn.example.com/reset.css";'), '外部 CSS CDN 必须直连保留');
  assert.ok(out.includes('url("https://cdn.example.com/hero.jpg")'), '外部图片 CDN 必须直连保留');
  assert.ok(out.includes('/* blocked @import: ../../../.env */'), '危险 @import 必须阻断');
  assert.ok(out.includes('/* url("./ignored-comment.png") */'), 'CSS 注释内容不得误改写');
  assert.ok(out.includes('skipped cyclic or deep @import'), '环形 @import 必须安全终止');
});

test('buildInlinedHtmlPreview: 内联 link/script/module/media/srcset/style，保留外链 CDN，不改动原始源码', async () => {
  const files = {
    '/repo/docs/app.css': {
      mime: 'text/css; charset=utf-8',
      isText: true,
      text: 'body { background: url("./bg.png"); }',
      byteSize: 32,
    },
    '/repo/docs/bg.png': {
      mime: 'image/png',
      isText: false,
      dataUrl: 'data:image/png;base64,Qkcx',
      byteSize: 6,
    },
    '/repo/docs/classic.js': {
      mime: 'application/javascript; charset=utf-8',
      isText: true,
      text: 'const tag = "</script><script>alert(1)"; window.x = 1;',
      byteSize: 52,
    },
    '/repo/docs/esm.mjs': {
      mime: 'application/javascript; charset=utf-8',
      isText: true,
      text: 'export const ok = true;',
      byteSize: 23,
    },
    '/repo/docs/poster.jpg': {
      mime: 'image/jpeg',
      isText: false,
      dataUrl: 'data:image/jpeg;base64,SlBH',
      byteSize: 6,
    },
    '/repo/docs/icon.png': {
      mime: 'image/png',
      isText: false,
      dataUrl: 'data:image/png;base64,SUNP',
      byteSize: 6,
    },
  };

  const rawHtml = `<!doctype html>
<html>
<head>
  <link rel="icon" href="./icon.png">
  <link rel="stylesheet" href="./app.css">
  <link rel="stylesheet" href="https://cdn.example.com/lib.css">
  <style>.badge { background: url("./icon.png"); }</style>
</head>
<body>
  <img src="./bg.png" srcset="./bg.png 1x, https://cdn.example.com/hires.png 2x">
  <img src="https://cdn.example.com/photo.png">
  <video poster="./poster.jpg"><source src="https://cdn.example.com/clip.mp4"></video>
  <img src="./../../../.env">
  <script src="./../../../.env"></script>
  <script src="./classic.js"></script>
  <script type="module" src="./esm.mjs"></script>
  <script src="https://cdn.example.com/analytics.js"></script>
</body>
</html>`;
  const snapshotBefore = rawHtml;

  const res = await buildInlinedHtmlPreview(rawHtml, {
    documentPath: '/repo/docs/report.html',
    workspaceRoot: '/repo',
    assetFetcher: createMemoryFetcher(files),
  });

  assert.equal(rawHtml, snapshotBefore, '原 HTML 字符串必须字节级不变');
  assert.ok(res.inlinedCount >= 5);
  assert.ok(
    res.html.includes('<style data-inlined-href="./app.css">body { background: url("data:image/png;base64,Qkcx"); }</style>'),
  );
  assert.ok(res.html.includes('<link rel="icon" href="data:image/png;base64,SUNP">'));
  assert.ok(res.html.includes('<link rel="stylesheet" href="https://cdn.example.com/lib.css">'));
  assert.ok(res.html.includes('https://cdn.example.com/analytics.js'));
  assert.ok(res.html.includes('https://cdn.example.com/photo.png'));
  assert.ok(res.html.includes('src="data:image/png;base64,Qkcx"'));
  assert.ok(res.html.includes('data:image/png;base64,Qkcx 1x, https://cdn.example.com/hires.png 2x'));
  assert.ok(res.html.includes('poster="data:image/jpeg;base64,SlBH"'));
  assert.ok(res.html.includes('<\\/script>'), '内联 classic script 内部 </script> 必须安全转义');
  assert.ok(
    res.html.includes('<script type="module" data-inlined-src="./esm.mjs">export const ok = true;</script>'),
    'type="module" 应保持 module 属性并安全内联模块代码',
  );
  assert.ok(res.html.includes('<!-- blocked script: ./../../../.env -->'));
  assert.ok(res.failedRefs.includes('./../../../.env'), '越界 .env 必须记录失败且不加载');
});

test('buildInlinedSvgPreview: 内联 SVG <image href/xlink:href> 与内嵌 <style>，纯矢量 SVG 返回 null', async () => {
  const pureSvg = '<svg xmlns="http://www.w3.org/2000/svg"><circle cx="10" cy="10" r="5" /></svg>';
  const noOp = await buildInlinedSvgPreview(pureSvg, { documentPath: '/repo/a.svg' });
  assert.equal(noOp, null);

  const svgWithImg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
    <style>.bg { background: url("./tile.png"); }</style>
    <image href="./chart.png" width="100" height="80" />
    <image xlink:href="https://cdn.example.com/ext.png" width="20" height="20" />
  </svg>`;
  const encodedInput = `data:image/svg+xml;base64,${Buffer.from(svgWithImg, 'utf8').toString('base64')}`;

  const res = await buildInlinedSvgPreview(encodedInput, {
    documentPath: '/repo/diagrams/flow.svg',
    workspaceRoot: '/repo',
    assetFetcher: createMemoryFetcher({
      '/repo/diagrams/tile.png': {
        mime: 'image/png',
        isText: false,
        dataUrl: 'data:image/png;base64,VElMRQ==',
        byteSize: 8,
      },
      '/repo/diagrams/chart.png': {
        mime: 'image/png',
        isText: false,
        dataUrl: 'data:image/png;base64,Q0hBUlQ=',
        byteSize: 8,
      },
    }),
  });

  assert.ok(res !== null);
  assert.equal(res.inlinedCount, 2);
  const decodedSvg = decodeDataUrlUtf8(res.dataUrl);
  assert.ok(decodedSvg && decodedSvg.includes('data:image/png;base64,Q0hBUlQ='));
  assert.ok(decodedSvg.includes('data:image/png;base64,VElMRQ=='));
  assert.ok(decodedSvg.includes('https://cdn.example.com/ext.png'));
});

test('htmlPreviewBundler 预算封顶、未命中回退、属性引号与边界分支全覆盖', async () => {
  // 空输入与无 SVG 文本边界
  assert.deepEqual(await buildInlinedHtmlPreview('', { documentPath: '/repo/empty.html' }), {
    html: '',
    inlinedCount: 0,
    failedRefs: [],
    totalBytes: 0,
  });
  assert.equal(await inlineCssRelativeAssets('', '/repo/empty.css'), '');
  assert.equal(await buildInlinedSvgPreview(null, { documentPath: '/repo/a.svg' }), null);
  assert.equal(await buildInlinedSvgPreview('<div>no svg</div>', { documentPath: '/repo/a.svg' }), null);
  assert.equal(await buildInlinedSvgPreview('data:image/svg+xml;base64,!!!', { documentPath: '/repo/a.svg' }), null);
  assert.equal(
    await buildInlinedSvgPreview('<svg><style>.a { color: red; }</style></svg>', { documentPath: '/repo/a.svg' }),
    null,
  );
  assert.equal(
    await buildInlinedSvgPreview('<svg><image href="https://cdn.example.com/e.png"/></svg>', {
      documentPath: '/repo/a.svg',
    }),
    null,
  );

  // 预算上限（maxAssets / maxTotalBytes）、缺失资产、媒体查询与内联 style="url(...)"
  const files = {
    '/repo/p.css': { mime: 'text/css; charset=utf-8', isText: true, text: '.p{color:blue}/*__FLUX_CSS_COMMENT_99__*/', byteSize: 14 },
    '/repo/small.png': { mime: 'image/png', isText: false, dataUrl: 'data:image/png;base64,QQ==', byteSize: 4 },
    '/repo/heavy.png': { mime: 'image/png', isText: false, dataUrl: 'data:image/png;base64,QUJDREVGRw==', byteSize: 500 },
    '/repo/sprite.svg': { mime: 'image/svg+xml', isText: false, dataUrl: 'data:image/svg+xml;base64,PHN2Zy8+', byteSize: 8 },
    '/repo/note.txt': { mime: 'text/plain; charset=utf-8', isText: true, text: 'plain', byteSize: 5 },
  };
  const fetcher = createMemoryFetcher(files);

  const cssMissing = await inlineCssRelativeAssets(
    '/* outer */ @import "./missing.css"; .m { background: url(./missing.png); } .s { color: url("../.env"); }',
    '/repo/styles/a.css',
    { workspaceRoot: '/repo', assetFetcher: fetcher },
  );
  assert.ok(cssMissing.includes('/* outer */'));
  assert.ok(cssMissing.includes('@import "./missing.css"'));
  assert.ok(cssMissing.includes('url(./missing.png)'));

  const cssUnmatchedToken = await inlineCssRelativeAssets(
    '.k { content: "x"; } /*__FLUX_CSS_COMMENT_99__*/ @import "./p.css";',
    '/repo/root.css',
    { workspaceRoot: '/repo', assetFetcher: fetcher },
  );
  assert.ok(cssUnmatchedToken.includes('/*__FLUX_CSS_COMMENT_99__*/'));

  const complexHtml = `<!doctype html>
  <html>
  <head>
    <link href="./missing.css">
    <link rel="canonical" href="./print.html">
    <link rel="stylesheet" href="./.env">
    <link rel="stylesheet" href="./missing.css">
    <link rel="stylesheet" href="./p.css" media="print">
  </head>
  <body>
    <!-- keep html comment -->
    <div>plain</div>
    <span   >ws-only</span>
    <div style="background: url(https://cdn.example.com/bg.png)">ext-bg</div>
    <a href="./other.html">nav link</a>
    <img src=./small.png srcset="  ">
    <img srcset="./small.png">
    <img src='./missing.png' style="background-image: url(./small.png)">
    <img src="./note.txt">
    <svg><use href="./sprite.svg#icon-1"></use></svg>
    <video controls poster="./small.png"></video>
    <img src="./heavy.png">
    <img src="./../.env">
    <script defer>window.inlineOnly = 1;</script>
    <script src="./missing.js"></script>
  </body>
  </html>`;

  const limitedRes = await buildInlinedHtmlPreview(complexHtml, {
    documentPath: '/repo/index.html',
    workspaceRoot: '/repo',
    maxAssets: 5,
    maxTotalBytes: 60,
    assetFetcher: fetcher,
  });

  assert.ok(limitedRes.html.includes('<link rel="canonical" href="./print.html">'));
  assert.ok(limitedRes.html.includes('<!-- blocked stylesheet: ./.env -->'));
  assert.ok(limitedRes.html.includes('@media print {'));
  assert.ok(limitedRes.html.includes('url(&quot;data:image/png;base64,QQ==&quot;)'));
  assert.ok(limitedRes.html.includes('data:image/svg+xml;base64,PHN2Zy8+#icon-1'));
  assert.ok(limitedRes.html.includes('<video controls poster="data:image/png;base64,QQ==">'));
  assert.ok(limitedRes.html.includes('src=""'));
  assert.ok(limitedRes.html.includes('<script src="./missing.js"></script>'));
  assert.ok(limitedRes.failedRefs.includes('./missing.css'));
  assert.ok(limitedRes.failedRefs.includes('./heavy.png'));
  assert.ok(limitedRes.failedRefs.includes('./note.txt'));
  assert.ok(limitedRes.totalBytes <= 60);

  const zeroBudgetRes = await buildInlinedHtmlPreview('<img src="./small.png">', {
    documentPath: '/repo/index.html',
    maxAssets: 0,
    assetFetcher: fetcher,
  });
  assert.equal(zeroBudgetRes.inlinedCount, 0);
  assert.ok(zeroBudgetRes.failedRefs.includes('./small.png'));
});

test('htmlPreviewBundler: 并发拉取严格守住 maxAssets/maxTotalBytes 上限且清空全部被拦截载体属性', async () => {
  const files = {
    '/repo/a.png': { mime: 'image/png', dataUrl: 'data:image/png;base64,QUE=', byteSize: 20 },
    '/repo/b.png': { mime: 'image/png', dataUrl: 'data:image/png;base64,QUI=', byteSize: 20 },
    '/repo/c.png': { mime: 'image/png', dataUrl: 'data:image/png;base64,QUM=', byteSize: 20 },
    '/repo/ok.mp4': { mime: 'video/mp4', dataUrl: 'data:video/mp4;base64,TVA0', byteSize: 12 },
  };
  const concurrentFetcher = async (targetPath) => {
    await Promise.resolve();
    await Promise.resolve();
    const entry = files[targetPath];
    if (!entry) {
      return {
        ok: false,
        path: targetPath,
        mime: 'application/octet-stream',
        isText: false,
        byteSize: 0,
        source: 'error',
        error: 'not_found',
      };
    }
    return {
      ok: true,
      path: targetPath,
      mime: entry.mime,
      isText: false,
      dataUrl: entry.dataUrl,
      byteSize: entry.byteSize,
      source: 'local_fs',
    };
  };

  const countLimited = await buildInlinedHtmlPreview('<img src="./a.png"><img src="./b.png"><img src="./c.png">', {
    documentPath: '/repo/index.html',
    maxAssets: 1,
    maxTotalBytes: 200,
    assetFetcher: concurrentFetcher,
  });
  assert.equal(countLimited.inlinedCount, 1);
  assert.equal(countLimited.failedRefs.length, 2);

  const bytesLimited = await buildInlinedHtmlPreview('<img src="./a.png"><img src="./b.png">', {
    documentPath: '/repo/index.html',
    maxAssets: 5,
    maxTotalBytes: 25,
    assetFetcher: concurrentFetcher,
  });
  assert.equal(bytesLimited.inlinedCount, 1);
  assert.equal(bytesLimited.totalBytes, 20);
  assert.deepEqual(bytesLimited.failedRefs, ['./b.png']);

  const blockedAttrsHtml = [
    '<link rel="icon" href="../.env">',
    '<link rel="stylesheet" href="javascript:alert(1)">',
    '<script src="data:text/javascript,alert(1)"></script>',
    '<video poster="../.env"><source src="./ok.mp4"></video>',
    '<img srcset="../.env 1x, ./a.png 2x">',
    '<svg><image href="file:///etc/passwd" /><use xlink:href="data:text/html;base64,PHNjcmlwdD4xPC9zY3JpcHQ+"></use></svg>',
  ].join('');
  const blockedRes = await buildInlinedHtmlPreview(blockedAttrsHtml, {
    documentPath: '/repo/index.html',
    workspaceRoot: '/repo',
    maxAssets: 8,
    assetFetcher: concurrentFetcher,
  });
  assert.ok(blockedRes.failedRefs.includes('../.env'));
  assert.ok(blockedRes.failedRefs.includes('javascript:alert(1)'));
  assert.ok(blockedRes.failedRefs.includes('file:///etc/passwd'));
  assert.ok(blockedRes.failedRefs.some((r) => r.startsWith('data:text/html')));
  assert.equal(blockedRes.html.includes('href="../.env"'), false);
  assert.equal(blockedRes.html.includes('poster="../.env"'), false);
  assert.equal(blockedRes.html.includes('href="javascript:alert(1)"'), false);
  assert.equal(blockedRes.html.includes('src="data:text/javascript'), false);
  assert.equal(blockedRes.html.includes('file:///'), false);
  assert.equal(blockedRes.html.includes('data:text/html'), false);
  assert.ok(blockedRes.html.includes('<link rel="icon" href="">'));
  assert.ok(blockedRes.html.includes('<!-- blocked stylesheet: javascript:alert(1) -->'));
  assert.ok(blockedRes.html.includes('<!-- blocked script: data:text/javascript,alert(1) -->'));
  assert.ok(blockedRes.html.includes('srcset="data:image/png;base64,QUE= 2x"'));
  assert.ok(blockedRes.html.includes('poster=""'));
  assert.ok(blockedRes.html.includes('href=""'));
  assert.ok(blockedRes.html.includes('xlink:href=""'));
  assert.ok(blockedRes.html.includes('data:video/mp4;base64,TVA0'));

  const blockedCss = await inlineCssRelativeAssets(
    '@import "file:///etc/passwd"; .x { background: url("file:///etc/passwd"); }',
    '/repo/index.css',
    { workspaceRoot: '/repo', assetFetcher: concurrentFetcher },
  );
  assert.equal(blockedCss.includes('@import "file:///'), false);
  assert.equal(blockedCss.includes('url("file:///'), false);
  assert.ok(blockedCss.includes('/* blocked @import: file:///etc/passwd */'));
  assert.ok(blockedCss.includes('url("")'));
});
