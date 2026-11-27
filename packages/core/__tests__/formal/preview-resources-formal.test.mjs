/**
 * 文档预览相对资源路径解析与非破坏性内联变换形式化不变量证明
 * (packages/core/__tests__/formal/preview-resources-formal.test.mjs)
 *
 * 守卫 docs/invariants.json 中的 INV-FS-07 ~ INV-FS-08：
 *   - INV-FS-07: resolvePreviewResourceRef 安全域不逃逸 `workspaceRoot`，绝对放行外部 http(s) CDN，
 *     并严密阻断 `.env*`、系统敏感根目录、空字节与危险协议；
 *   - INV-FS-08: buildInlinedHtmlPreview / buildInlinedSvgPreview 严格保持输入源码非破坏性、
 *     环形 CSS `@import` 必定停机，且内联资产总数与总字节严格受预算上限约束。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import {
  buildInlinedHtmlPreview,
  buildInlinedSvgPreview,
  hasPreviewEnvSecretSegment,
  isPathWithinScope,
  isPreviewSystemSensitivePath,
  resolvePreviewResourceRef,
} from '../../dist/index.js';

const safeSegmentArb = fc
  .stringMatching(/^[a-zA-Z0-9_-]{1,10}$/)
  .filter((s) => s !== '.' && s !== '..');

test('INV-FS-07: 工作区内文档相对/根相对引用永不逃逸 workspaceRoot、不命中机密/系统盘，外部 CDN 原样放行', () => {
  const pathStepArb = fc.oneof(
    safeSegmentArb,
    fc.constant('.'),
    fc.constant('..'),
    fc.constant('.env'),
    fc.constant('.env.local'),
    fc.constant('.env.example'),
  );

  fc.assert(
    fc.property(
      fc.boolean(),
      fc.array(safeSegmentArb, { minLength: 1, maxLength: 3 }),
      fc.array(safeSegmentArb, { minLength: 0, maxLength: 3 }),
      fc.array(pathStepArb, { minLength: 1, maxLength: 6 }),
      fc.constantFrom('', '/', '\\'),
      (isWin, rootSegs, docSubDirs, refSegs, prefix) => {
        const workspaceRoot = isWin
          ? `D:/work/${rootSegs.join('/')}`
          : `/work/${rootSegs.join('/')}`;
        const docDir = docSubDirs.length > 0 ? `${workspaceRoot}/${docSubDirs.join('/')}` : workspaceRoot;
        const documentPath = `${docDir}/index.html`;
        const ref = `${prefix}${refSegs.join('/')}`;

        const res = resolvePreviewResourceRef(ref, { documentPath, workspaceRoot });
        if (!res.blocked && res.resolvedPath) {
          assert.equal(
            isPathWithinScope(workspaceRoot, res.resolvedPath),
            true,
            `Resolved path escaped workspaceRoot: ${ref} -> ${res.resolvedPath}`,
          );
          assert.equal(
            hasPreviewEnvSecretSegment(res.resolvedPath),
            false,
            `Resolved path contains secret .env segment: ${res.resolvedPath}`,
          );
          assert.equal(
            isPreviewSystemSensitivePath(res.resolvedPath),
            false,
            `Resolved path hit system sensitive root: ${res.resolvedPath}`,
          );
        }
      },
    ),
    { numRuns: 400 },
  );

  fc.assert(
    fc.property(
      fc.constantFrom('https://cdn.example.com', 'http://assets.example.org/lib', '//unpkg.com/pkg'),
      safeSegmentArb,
      safeSegmentArb,
      (origin, folder, file) => {
        const cdnUrl = `${origin}/${folder}/${file}.js?v=1`;
        const res = resolvePreviewResourceRef(cdnUrl, {
          documentPath: '/work/proj/docs/index.html',
          workspaceRoot: '/work/proj',
        });
        assert.equal(res.kind, 'external_http');
        assert.equal(res.blocked, undefined);
        assert.equal(res.externalUrl, cdnUrl.startsWith('//') ? `https:${cdnUrl}` : cdnUrl);
        assert.equal(res.resolvedPath, undefined);
      },
    ),
    { numRuns: 100 },
  );
});

test('INV-FS-07b: 危险 URI、空字节、.env* 与逃逸出工作区的向上穿越必被拦截', () => {
  fc.assert(
    fc.property(
      fc.constantFrom(
        'javascript:alert(1)',
        '  JaVaScRiPt:alert(1)',
        'vbscript:msgbox(1)',
        'file:///etc/passwd',
        'assets/\0secret.png',
        '.env',
        '.env.production',
        'sub/../../.env.local',
        '../../../../etc/passwd',
        '/../etc/passwd',
        'C:\\Windows\\System32\\drivers\\etc\\hosts',
      ),
      (badRef) => {
        const res = resolvePreviewResourceRef(badRef, {
          documentPath: '/work/proj/sub/doc.md',
          workspaceRoot: '/work/proj',
        });
        assert.equal(res.blocked, true, `Expected blocked for: ${badRef}`);
        assert.equal(res.resolvedPath, undefined);
      },
    ),
    { numRuns: 100 },
  );

  // 无工作区上下文时，Unix 系统敏感绝对路径亦必须拦截，且即使在工作区内也绝不会解析到操作系统 /etc/passwd
  const standaloneEtc = resolvePreviewResourceRef('/etc/passwd', {
    documentPath: '/work/proj/sub/doc.md',
  });
  assert.equal(standaloneEtc.blocked, true);
  assert.equal(standaloneEtc.resolvedPath, undefined);

  const inWsEtc = resolvePreviewResourceRef('/etc/passwd', {
    documentPath: '/work/proj/sub/doc.md',
    workspaceRoot: '/work/proj',
  });
  assert.equal(inWsEtc.resolvedPath, '/work/proj/etc/passwd');
  assert.equal(isPathWithinScope('/work/proj', inWsEtc.resolvedPath), true);
});

test('INV-FS-08: buildInlinedHtmlPreview/buildInlinedSvgPreview 在环形 CSS 与随机预算下保持非破坏性、停机与上限守恒', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.integer({ min: 1, max: 6 }),
      fc.integer({ min: 0, max: 5 }),
      fc.integer({ min: 50, max: 400 }),
      fc.array(safeSegmentArb, { minLength: 1, maxLength: 6 }),
      async (nodeCount, maxAssets, maxTotalBytes, names) => {
        const uniq = Array.from(new Set(names)).slice(0, nodeCount);
        const cssFiles = new Map();
        for (let i = 0; i < uniq.length; i += 1) {
          const next = uniq[(i + 1) % uniq.length];
          const p = `/work/proj/styles/${uniq[i]}.css`;
          cssFiles.set(p, `@import "./${next}.css"; .c${i} { background: url("../img/pic.png"); }`);
        }
        const entryCss = uniq[0] ? `./styles/${uniq[0]}.css` : './styles/a.css';
        const rawHtml =
          `<!doctype html><html><head>` +
          `<link rel="stylesheet" href="${entryCss}">` +
          `<script src="https://cdn.example.com/app.js"></script>` +
          `</head><body><img src="./img/pic.png"><img src="https://cdn.example.com/logo.png"></body></html>`;
        const originalSnapshot = rawHtml;
        const options = {
          documentPath: '/work/proj/index.html',
          workspaceRoot: '/work/proj',
          maxAssets,
          maxTotalBytes,
          maxCssDepth: 3,
          assetFetcher: async (targetPath) => {
            if (cssFiles.has(targetPath)) {
              const text = cssFiles.get(targetPath);
              return {
                ok: true,
                path: targetPath,
                mime: 'text/css; charset=utf-8',
                isText: true,
                text,
                byteSize: Buffer.byteLength(text, 'utf8'),
                source: 'local_fs',
              };
            }
            const dataUrl = 'data:image/png;base64,iVBORw0KGgo=';
            return {
              ok: true,
              path: targetPath,
              mime: 'image/png',
              isText: false,
              dataUrl,
              byteSize: 20,
              source: 'local_fs',
            };
          },
        };

        const htmlRes = await buildInlinedHtmlPreview(rawHtml, options);
        assert.equal(rawHtml, originalSnapshot, '原始 HTML 字符串不得被修改');
        assert.ok(htmlRes.inlinedCount <= maxAssets, `inlinedCount=${htmlRes.inlinedCount} > ${maxAssets}`);
        assert.ok(htmlRes.totalBytes <= maxTotalBytes, `totalBytes=${htmlRes.totalBytes} > ${maxTotalBytes}`);
        assert.ok(htmlRes.html.includes('https://cdn.example.com/app.js'), '外部 JS CDN 不得被移除或代理');
        assert.ok(htmlRes.html.includes('https://cdn.example.com/logo.png'), '外部图片 CDN 不得被移除或代理');

        const svgRaw = `<svg xmlns="http://www.w3.org/2000/svg"><image href="./img/pic.png" /><image href="https://cdn.example.com/icon.png" /></svg>`;
        const svgSnapshot = svgRaw;
        const svgRes = await buildInlinedSvgPreview(svgRaw, options);
        assert.equal(svgRaw, svgSnapshot, '原始 SVG 字符串不得被修改');
        assert.ok(svgRes !== null);
        assert.ok(svgRes.inlinedCount <= maxAssets);
      },
    ),
    { numRuns: 120 },
  );
});

test('形式化定理: 工作区外文档独立隔离于 docDir、绝不跳转进入 workspaceRoot 且可执行 data: 必被阻断', () => {
  const segArb = fc.stringMatching(/^[a-zA-Z0-9_-]{1,10}$/).filter((s) => !s.toLowerCase().startsWith('env'));
  const execMimeArb = fc.constantFrom(
    'text/html',
    'application/xhtml+xml',
    'text/javascript',
    'application/javascript',
    'application/ecmascript',
  );

  fc.assert(
    fc.property(segArb, segArb, segArb, execMimeArb, (extFolder, subFile, wsFile, execMime) => {
      const docPath = `/ext-root/${extFolder}/guide.md`;
      const docDir = `/ext-root/${extFolder}`;
      const workspaceRoot = '/main-workspace/repo';

      const okSibling = resolvePreviewResourceRef(`./${subFile}.png`, { documentPath: docPath, workspaceRoot });
      assert.equal(Boolean(okSibling.blocked), false);
      assert.ok(okSibling.resolvedPath && isPathWithinScope(docDir, okSibling.resolvedPath));

      const parentEscape = resolvePreviewResourceRef(`../${subFile}.txt`, { documentPath: docPath, workspaceRoot });
      assert.equal(parentEscape.blocked, true);

      const rootJump = resolvePreviewResourceRef(`/${wsFile}.png`, { documentPath: docPath, workspaceRoot });
      assert.equal(rootJump.blocked, true);
      assert.equal(isPathWithinScope(workspaceRoot, rootJump.resolvedPath || ''), false);

      const directWs = resolvePreviewResourceRef(`${workspaceRoot}/${wsFile}.png`, { documentPath: docPath, workspaceRoot });
      assert.equal(directWs.blocked, true);

      const unsafeData = resolvePreviewResourceRef(`da\tta:${execMime};base64,QQ==`, {
        documentPath: docPath,
        workspaceRoot,
      });
      assert.equal(unsafeData.blocked, true);

      const cdn = resolvePreviewResourceRef(`https://cdn.example.com/${subFile}.png`, {
        documentPath: docPath,
        workspaceRoot,
      });
      assert.equal(Boolean(cdn.blocked), false);
      assert.equal(cdn.kind, 'external_http');

      const bareUnixRoot = resolvePreviewResourceRef(`/Users/${wsFile}.png`, {
        documentPath: 'readme.md',
        workspaceRoot: '',
      });
      assert.equal(bareUnixRoot.blocked, true);

      const bareDriveRoot = resolvePreviewResourceRef(`D:/secrets/${wsFile}.png`, {
        documentPath: 'readme.md',
        workspaceRoot: '',
      });
      assert.equal(bareDriveRoot.blocked, true);
    }),
    { numRuns: 150 },
  );
});

test('形式化定理: 并发异步拉取下 buildInlinedHtmlPreview 严守 maxAssets 与 maxTotalBytes 上限', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.integer({ min: 0, max: 3 }),
      fc.integer({ min: 15, max: 80 }),
      async (maxAssets, maxTotalBytes) => {
        const html = '<img src="./0.png"><img src="./1.png"><img src="./2.png"><img src="./3.png">';
        const snapshot = html;
        const res = await buildInlinedHtmlPreview(html, {
          documentPath: '/repo/doc.html',
          workspaceRoot: '/repo',
          maxAssets,
          maxTotalBytes,
          assetFetcher: async (targetPath) => {
            await Promise.resolve();
            await Promise.resolve();
            return {
              ok: true,
              path: targetPath,
              mime: 'image/png',
              isText: false,
              dataUrl: 'data:image/png;base64,QUE=',
              byteSize: 20,
              source: 'local_fs',
            };
          },
        });
        assert.equal(html, snapshot);
        assert.ok(res.inlinedCount <= maxAssets, `concurrent inlinedCount=${res.inlinedCount} > ${maxAssets}`);
        assert.ok(res.totalBytes <= maxTotalBytes, `concurrent totalBytes=${res.totalBytes} > ${maxTotalBytes}`);
      },
    ),
    { numRuns: 80 },
  );
});
