/**
 * 文件预览相对路径解析与子资源拉取单测 (packages/core/__tests__/fs/previewResourceResolver.test.mjs)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectPreviewAssetMime,
  detectPreviewBinaryMimeFromRequestPath,
  encodeUtf8ToBase64,
  hasPreviewEnvSecretSegment,
  isInlineBinaryPreviewAssetMime,
  isPathWithinScope,
  isPreviewAssetPathAllowed,
  isPreviewSystemSensitivePath,
  isTextPreviewAssetMime,
  resolveDocumentDir,
  resolveEffectivePreviewScopeRoot,
  classifyPreviewResourceRef,
  resolvePreviewResourceRef,
  resolvePreviewAsset,
  splitSrcsetCandidates,
} from '../../dist/index.js';

test('MIME 探测、文本/内联二进制分类与 UTF-8 Base64 编码', () => {
  assert.equal(detectPreviewAssetMime(''), null);
  assert.equal(detectPreviewAssetMime('noext'), null);
  assert.equal(detectPreviewAssetMime('/'), null);
  assert.equal(detectPreviewAssetMime('./styles/app.css?v=1#hash'), 'text/css; charset=utf-8');
  assert.equal(detectPreviewAssetMime('/api/fs/download?path=%2Ffonts%2Finter.woff2'), 'font/woff2');
  assert.equal(detectPreviewAssetMime('audio/theme.mp3'), 'audio/mpeg');
  assert.equal(detectPreviewAssetMime(':::bad-url:::/icon.svg'), 'image/svg+xml');
  assert.equal(detectPreviewBinaryMimeFromRequestPath('/assets/hero.avif'), 'image/avif');
  assert.equal(detectPreviewBinaryMimeFromRequestPath('/app/index.html'), null);
  assert.equal(detectPreviewBinaryMimeFromRequestPath(''), null);
  assert.equal(detectPreviewBinaryMimeFromRequestPath(null), null);

  assert.equal(isTextPreviewAssetMime('text/css; charset=utf-8'), true);
  assert.equal(isTextPreviewAssetMime('application/javascript; charset=utf-8'), true);
  assert.equal(isTextPreviewAssetMime('application/json'), true);
  assert.equal(isTextPreviewAssetMime('application/xml'), true);
  assert.equal(isTextPreviewAssetMime('image/png'), false);
  assert.equal(isTextPreviewAssetMime(null), false);

  assert.equal(isInlineBinaryPreviewAssetMime('image/avif'), true);
  assert.equal(isInlineBinaryPreviewAssetMime('audio/mpeg'), true);
  assert.equal(isInlineBinaryPreviewAssetMime('video/mp4'), true);
  assert.equal(isInlineBinaryPreviewAssetMime('font/woff2'), true);
  assert.equal(isInlineBinaryPreviewAssetMime('application/font-woff'), true);
  assert.equal(isInlineBinaryPreviewAssetMime('application/vnd.ms-fontobject'), true);
  assert.equal(isInlineBinaryPreviewAssetMime('application/wasm'), true);
  assert.equal(isInlineBinaryPreviewAssetMime('text/plain'), false);
  assert.equal(isInlineBinaryPreviewAssetMime(null), false);

  const b64 = encodeUtf8ToBase64('你好, Hermes!');
  assert.equal(Buffer.from(b64, 'base64').toString('utf8'), '你好, Hermes!');
});

test('路径安全守卫、目录提取、资源分类与相对/根相对解析', () => {
  assert.equal(hasPreviewEnvSecretSegment('/repo/.env'), true);
  assert.equal(hasPreviewEnvSecretSegment('D:\\repo\\.env.production\\a'), true);
  assert.equal(hasPreviewEnvSecretSegment('/repo/.env.example'), false);

  assert.equal(isPreviewSystemSensitivePath('/'), true);
  assert.equal(isPreviewSystemSensitivePath('/etc/passwd'), true);
  assert.equal(isPreviewSystemSensitivePath('C:/Windows/System32/a.dll'), true);
  assert.equal(isPreviewSystemSensitivePath('C:/Program Files/app/a.txt'), true);
  assert.equal(isPreviewSystemSensitivePath('D:/work/proj/a.txt'), false);

  assert.equal(isPathWithinScope('D:/work/proj', 'd:/work/proj/sub/img.png'), true);
  assert.equal(isPathWithinScope('/work/proj', '/work/proj-other/img.png'), false);

  assert.equal(resolveDocumentDir('https://cdn.example.com/docs/a.html'), 'https://cdn.example.com/docs/');
  assert.equal(resolveDocumentDir('docs/readme.md', 'D:/repo'), 'D:/repo/docs');
  assert.equal(resolveDocumentDir('C:/root.html'), 'C:/');

  assert.equal(classifyPreviewResourceRef(''), 'empty');
  assert.equal(classifyPreviewResourceRef('#section-1'), 'anchor');
  assert.equal(classifyPreviewResourceRef('mailto:hi@example.com'), 'passthrough');
  assert.equal(classifyPreviewResourceRef('https://cdn.example.com/a.js'), 'external_http');
  assert.equal(classifyPreviewResourceRef('//cdn.example.com/a.js'), 'external_http');
  assert.equal(classifyPreviewResourceRef('data:image/png;base64,abc'), 'inline_data');
  assert.equal(classifyPreviewResourceRef('hermes-preview://tok.preview/a.css'), 'inline_data');
  assert.equal(classifyPreviewResourceRef('  JaVaScRiPt:alert(1)'), 'unsafe');
  assert.equal(classifyPreviewResourceRef('/assets/logo.png'), 'root_relative');
  assert.equal(classifyPreviewResourceRef('./img.png'), 'relative');

  const httpDocRel = resolvePreviewResourceRef('../img/pic.png', {
    documentPath: 'https://docs.example.com/v1/guide/page.md',
  });
  assert.equal(httpDocRel.kind, 'external_http');
  assert.equal(httpDocRel.externalUrl, 'https://docs.example.com/v1/img/pic.png');

  const rootRelInWs = resolvePreviewResourceRef('/assets/chart.svg?v=2#layer', {
    documentPath: 'D:/repo/docs/sub/report.html',
    workspaceRoot: 'D:/repo',
  });
  assert.equal(rootRelInWs.resolvedPath, 'D:/repo/assets/chart.svg');
  assert.equal(rootRelInWs.suffix, '?v=2#layer');

  const parentRel = resolvePreviewResourceRef('../shared/app.css', {
    documentPath: '/repo/docs/guide/readme.md',
    workspaceRoot: '/repo',
  });
  assert.equal(parentRel.resolvedPath, '/repo/docs/shared/app.css');

  const escapedRel = resolvePreviewResourceRef('../../../secret.txt', {
    documentPath: '/repo/docs/readme.md',
    workspaceRoot: '/repo',
  });
  assert.equal(escapedRel.blocked, true);

  const badPercent = resolvePreviewResourceRef('%E0%A4%A.png', {
    documentPath: '/repo/readme.md',
    workspaceRoot: '/repo',
  });
  assert.equal(badPercent.resolvedPath, '/repo/%E0%A4%A.png');

  const outsideWinDrive = resolvePreviewResourceRef('E:/other/a.png', {
    documentPath: 'D:/repo/readme.md',
    workspaceRoot: 'D:/repo',
  });
  assert.equal(outsideWinDrive.blocked, true);
});

test('resolvePreviewAsset 完整覆盖本地回环、视频流、远端网关四级回退、SPA 拦截与体积上限', async () => {
  const blocked = await resolvePreviewAsset('/work/.env.local', {});
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error, 'blocked_path');

  const outScope = await resolvePreviewAsset('/other/a.png', {
    workspaceRoot: '/work/repo',
    enforceWorkspaceScope: true,
  });
  assert.equal(outScope.ok, false);
  assert.equal(outScope.error, 'outside_workspace');

  const localTextRes = await resolvePreviewAsset('/work/repo/app.css', {
    platformBridge: {
      readFile: async () => 'body { color: red; }',
    },
  });
  assert.equal(localTextRes.ok, true);
  assert.equal(localTextRes.isText, true);
  assert.equal(localTextRes.text, 'body { color: red; }');
  assert.equal(localTextRes.source, 'local_fs');

  const localSvgRes = await resolvePreviewAsset('/work/repo/icon.svg', {
    platformBridge: {
      readFile: async () => '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
    },
  });
  assert.equal(localSvgRes.ok, true);
  assert.ok(localSvgRes.dataUrl?.startsWith('data:image/svg+xml;base64,'));
  assert.ok(localSvgRes.text?.includes('<svg'));

  const localFontRes = await resolvePreviewAsset('/work/repo/font.woff2', {
    platformBridge: {
      readFile: async () => 'data:font/woff2;base64,AAAA',
    },
  });
  assert.equal(localFontRes.ok, true);
  assert.equal(localFontRes.dataUrl, 'data:font/woff2;base64,AAAA');

  const streamVidRes = await resolvePreviewAsset('/work/repo/demo.mp4', {
    gatewayUrl: 'https://gw.example.com',
    allowVideoStreamUrl: true,
    platformBridge: {
      resolveMediaStreamUrl: async () => 'hermes-media://local/stream?token=1&path=demo.mp4',
    },
  });
  assert.equal(streamVidRes.ok, true);
  assert.equal(streamVidRes.source, 'local_fs');
  assert.equal(streamVidRes.dataUrl, 'hermes-media://local/stream?token=1&path=demo.mp4');

  // 远端文本资源：read-text 返回 SPA HTML 时回落 /api/files/read base64 data_url
  const gwTextRes = await resolvePreviewAsset('/work/repo/data.json', {
    gatewayUrl: 'https://gw.example.com',
    profile: 'bot-a',
    sessionId: 'sess-1',
    platformBridge: {
      httpProxy: async (opts) => {
        if (opts.path.startsWith('/api/fs/read-text')) {
          return { text: '<!doctype html><html><script src="/assets/index-123.js"></script></html>' };
        }
        if (opts.path.startsWith('/api/files/read')) {
          return {
            data_url: `data:application/json;base64,${Buffer.from('{"ok":true}').toString('base64')}`,
            size: 11,
          };
        }
        return null;
      },
    },
  });
  assert.equal(gwTextRes.ok, true);
  assert.equal(gwTextRes.text, '{"ok":true}');
  assert.equal(gwTextRes.source, 'gateway_api');

  // 远端文本超限与 unexpected_binary
  const tooLargeRes = await resolvePreviewAsset('/work/repo/big.css', {
    gatewayUrl: 'https://gw.example.com',
    maxBytes: 10,
    platformBridge: {
      httpProxy: async () => ({ byteSize: 999 }),
    },
  });
  assert.equal(tooLargeRes.ok, false);
  assert.equal(tooLargeRes.error, 'asset_too_large');

  const binaryConflictRes = await resolvePreviewAsset('/work/repo/weird.css', {
    gatewayUrl: 'https://gw.example.com',
    platformBridge: {
      httpProxy: async () => ({ binary: true }),
    },
  });
  assert.equal(binaryConflictRes.ok, false);
  assert.equal(binaryConflictRes.error, 'unexpected_binary');

  // 远端二进制音频：从 read-data-url 404 回落到 /api/fs/download 返回 Data URL
  const gwAudioRes = await resolvePreviewAsset('/work/repo/voice.mp3', {
    gatewayUrl: 'https://gw.example.com',
    platformBridge: {
      httpProxy: async (opts) => {
        if (opts.path.startsWith('/api/fs/download')) {
          return 'data:audio/mpeg;base64,SUQz';
        }
        throw new Error('404');
      },
    },
  });
  assert.equal(gwAudioRes.ok, true);
  assert.equal(gwAudioRes.dataUrl, 'data:audio/mpeg;base64,SUQz');

  // 会话工具缓存回落
  const toolFallback = await resolvePreviewAsset('/work/repo/notes.txt', {
    messages: [
      {
        toolCalls: [
          { name: 'read_file', args: '/work/repo/notes.txt', output: 'cached tool body' },
        ],
      },
    ],
  });
  assert.equal(toolFallback.ok, true);
  assert.equal(toolFallback.text, 'cached tool body');
  assert.equal(toolFallback.source, 'session_tool');
});

test('previewResourceResolver 边界分支与错误降级全覆盖', async () => {
  // detectPreviewAssetMime URL 解析失败回退
  assert.equal(detectPreviewAssetMime('http://[invalid-ipv6/icon.svg'), 'image/svg+xml');
  assert.equal(hasPreviewEnvSecretSegment(''), false);
  assert.equal(hasPreviewEnvSecretSegment(null), false);

  // isPathWithinScope 大小写与空路径边界
  assert.equal(isPathWithinScope('', '/a'), false);
  assert.equal(isPathWithinScope('/work/repo', '/work/repo'), true);
  assert.equal(isPathWithinScope('d:/repo', 'D:/repo/sub/a.png'), true);
  assert.equal(isPathWithinScope('C:/Repo', 'c:/Repo/sub/a.png'), true);
  assert.equal(isPathWithinScope('D:/', 'D:/sub/a.png'), true);
  assert.equal(isPathWithinScope('/', '/work/repo/a.png'), true);
  assert.equal(isPathWithinScope('/work/repo/', '/work/repo/a.png'), true);

  // resolveDocumentDir 全分支
  assert.equal(resolveDocumentDir('', '/repo'), '/repo');
  assert.equal(resolveDocumentDir('.', '/repo'), '/repo');
  assert.equal(resolveDocumentDir('readme.md'), '');
  assert.equal(resolveDocumentDir('/readme.md'), '/');
  assert.equal(resolveDocumentDir('https://[invalid', '/repo'), '/repo');
  assert.equal(resolveDocumentDir('docs/readme.md', '/repo/'), '/repo/docs');

  // classifyPreviewResourceRef 全部协议/形态
  assert.equal(classifyPreviewResourceRef(null), 'empty');
  assert.equal(classifyPreviewResourceRef('   '), 'empty');
  assert.equal(classifyPreviewResourceRef('bad\x07path.png'), 'unsafe');
  assert.equal(classifyPreviewResourceRef('\\assets\\a.png'), 'root_relative');
  assert.equal(classifyPreviewResourceRef('C:\\proj\\a.png'), 'root_relative');
  assert.equal(classifyPreviewResourceRef('custom+scheme:item'), 'passthrough');

  // resolvePreviewResourceRef 边界
  assert.equal(resolvePreviewResourceRef('', { documentPath: '/repo/a.md' }).kind, 'empty');
  const queryNoHash = resolvePreviewResourceRef('./a.png?v=1', {
    documentPath: 'docs/readme.md',
    workspaceRoot: '/repo/',
  });
  assert.equal(queryNoHash.resolvedPath, '/repo/docs/a.png');
  assert.equal(queryNoHash.suffix, '?v=1');

  assert.equal(
    resolvePreviewResourceRef('C:/repo/sub/a.png', {
      documentPath: 'C:/repo/docs/index.html',
      workspaceRoot: 'C:/repo',
    }).resolvedPath,
    'C:/repo/sub/a.png',
  );
  assert.equal(
    resolvePreviewResourceRef('/', {
      documentPath: '/repo/index.html',
      workspaceRoot: '/repo',
    }).blocked,
    true,
  );
  assert.equal(
    resolvePreviewResourceRef('../../outside.png', { documentPath: 'a.md' }).blocked,
    true,
  );
  assert.equal(
    resolvePreviewResourceRef('a.png', { documentPath: 'https://[::bad/page.html' }).blocked,
    true,
  );

  // resolvePreviewAsset 文本/二进制/DataURL 超限、SVG base64/非base64 与异常捕获
  const emptyTarget = await resolvePreviewAsset('', {});
  assert.equal(emptyTarget.ok, false);
  assert.equal(emptyTarget.error, 'blocked_path');

  const cssDataRes = await resolvePreviewAsset('/work/repo/app.css', {
    platformBridge: {
      readFile: async () => 'data:text/css,body%20%7B%20color%3A%20red%3B%20%7D',
    },
  });
  assert.equal(cssDataRes.ok, true);
  assert.equal(cssDataRes.text, 'body { color: red; }');

  const textOverLimit = await resolvePreviewAsset('/work/repo/big.css', {
    maxBytes: 4,
    platformBridge: {
      readFile: async () => 'body { color: black; }',
    },
  });
  assert.equal(textOverLimit.ok, false);
  assert.equal(textOverLimit.error, 'asset_too_large');

  const binSinglePad = await resolvePreviewAsset('/work/repo/p1.png', {
    maxBytes: 100,
    platformBridge: { readFile: async () => 'data:image/png;base64,QUI=' },
  });
  assert.equal(binSinglePad.ok, true);
  assert.equal(binSinglePad.byteSize, 2);

  const binDoublePadOver = await resolvePreviewAsset('/work/repo/p2.png', {
    maxBytes: 1,
    platformBridge: { readFile: async () => 'data:image/png;base64,QUJDREVGRw==' },
  });
  assert.equal(binDoublePadOver.ok, false);
  assert.equal(binDoublePadOver.error, 'asset_too_large');

  const binPlainUrlData = await resolvePreviewAsset('/work/repo/p3.png', {
    maxBytes: 100,
    platformBridge: { readFile: async () => 'data:image/png,PNG' },
  });
  assert.equal(binPlainUrlData.ok, true);
  assert.equal(binPlainUrlData.byteSize, 3);

  const binNoCommaData = await resolvePreviewAsset('/work/repo/p4.png', {
    platformBridge: { readFile: async () => 'data:image/png;base64' },
  });
  assert.equal(binNoCommaData.byteSize, 0);

  const svgBase64Local = await resolvePreviewAsset('/work/repo/logo.svg', {
    platformBridge: {
      readFile: async () =>
        `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>').toString('base64')}`,
    },
  });
  assert.equal(svgBase64Local.ok, true);
  assert.ok(svgBase64Local.text?.includes('<svg'));

  const localThrow = await resolvePreviewAsset('/work/repo/err.svg', {
    platformBridge: {
      readFile: async () => {
        throw new Error('io err');
      },
    },
    messages: [
      {
        toolCalls: [
          { name: 'read_file', args: '/work/repo/err.svg', output: '<svg id="t"/>' },
        ],
      },
    ],
  });
  assert.equal(localThrow.ok, true);
  assert.ok(localThrow.dataUrl?.startsWith('data:image/svg+xml;base64,'));

  const vidStreamErr = await resolvePreviewAsset('/work/repo/v.mp4', {
    gatewayUrl: 'https://gw.example.com',
    allowVideoStreamUrl: true,
    platformBridge: {
      resolveMediaStreamUrl: async () => {
        throw new Error('stream failed');
      },
    },
  });
  assert.equal(vidStreamErr.ok, false);

  const gwObjDownload = await resolvePreviewAsset('/work/repo/data2.css', {
    gatewayUrl: 'https://gw.example.com',
    platformBridge: {
      httpProxy: async (opts) => {
        if (opts.path.startsWith('/api/fs/download')) return { content: 'a{}' };
        throw new Error('404');
      },
    },
  });
  assert.equal(gwObjDownload.ok, true);
  assert.equal(gwObjDownload.text, 'a{}');

  const gwFilesReadOver = await resolvePreviewAsset('/work/repo/large.css', {
    gatewayUrl: 'https://gw.example.com',
    maxBytes: 2,
    platformBridge: {
      httpProxy: async (opts) => {
        if (opts.path.startsWith('/api/files/read')) return { size: 999 };
        throw new Error('404');
      },
    },
  });
  assert.equal(gwFilesReadOver.error, 'asset_too_large');

  const gwBinaryObj = await resolvePreviewAsset('/work/repo/x.bin', {
    gatewayUrl: 'https://gw.example.com',
    platformBridge: {
      httpProxy: async (opts) => {
        if (opts.path.includes('read-data-url')) return { dataUrl: 'data:application/octet-stream;base64,QUI=', byteSize: 2 };
        return null;
      },
    },
  });
  assert.equal(gwBinaryObj.ok, true);
  assert.equal(gwBinaryObj.byteSize, 2);

  // splitSrcsetCandidates 完整分支（空串、空项、Data URI 逗号保留、尾随不完整 data: 项）
  assert.deepEqual(splitSrcsetCandidates(''), []);
  assert.deepEqual(splitSrcsetCandidates('  , https://cdn.example.com/a.png 1x, data:image/png;base64,AA== 2x'), [
    'https://cdn.example.com/a.png 1x',
    'data:image/png;base64,AA== 2x',
  ]);
  assert.equal(splitSrcsetCandidates('data:image/png;base64').length, 1);

  // resolvePreviewResourceRef 与 resolvePreviewAsset 剩余边界分支
  assert.equal(
    resolvePreviewResourceRef(null, { documentPath: '/repo/a.md' }).kind,
    'empty',
  );
  assert.equal(
    resolvePreviewResourceRef('./a.png', { documentPath: '' }).resolvedPath,
    'a.png',
  );
  assert.equal(
    resolvePreviewResourceRef('/a/../../secret.txt', { documentPath: '/repo/a.md', workspaceRoot: '/repo' }).blockReason,
    'root_escape_traversal',
  );
  assert.equal(
    resolvePreviewResourceRef('/a/b/../c.png', { documentPath: '/repo/a.md', workspaceRoot: '/repo' }).resolvedPath,
    '/repo/a/c.png',
  );
  assert.equal(
    resolvePreviewResourceRef(':::[bad', { documentPath: 'https://[invalid' }).blockReason,
    'invalid_http_relative_ref',
  );
  assert.equal(
    resolvePreviewResourceRef('?v=1', { documentPath: '/repo/a.html', workspaceRoot: '/repo' }).blockReason,
    'secret_or_null_path',
  );
  assert.equal(
    resolvePreviewResourceRef('./icon.png', { documentPath: '/readme.md' }).resolvedPath,
    '/icon.png',
  );
  const relScoped = await resolvePreviewAsset('assets/a.png', {
    enforceWorkspaceScope: true,
    workspaceRoot: '/work/repo',
    platformBridge: { readFile: async () => 'data:image/png;base64,QUE=' },
  });
  assert.equal(relScoped.ok, true);
  const winOutScoped = await resolvePreviewAsset('E:/other/a.png', {
    enforceWorkspaceScope: true,
    workspaceRoot: 'D:/repo',
  });
  assert.equal(winOutScoped.error, 'outside_workspace');
});

test('previewResourceResolver: Executable data URI 阻断与工作区外文档独立 docDir 隔离', () => {
  const unsafeDataRefs = [
    'da\tta:text/html,<script>1</script>',
    'DATA:application/xhtml+xml;base64,PHN2Zy8+',
    'data:text/javascript,alert(1)',
    'data:application/javascript;base64,QQ==',
    'data:application/ecmascript,1',
    'data:text/ecmascript,1',
    'data:application/x-javascript,1',
  ];
  for (const ref of unsafeDataRefs) {
    assert.equal(classifyPreviewResourceRef(ref), 'unsafe', `应阻断危险 data URI: ${ref}`);
    const resolved = resolvePreviewResourceRef(ref, {
      documentPath: '/work/repo/doc.html',
      workspaceRoot: '/work/repo',
    });
    assert.equal(resolved.blocked, true);
    assert.equal(resolved.blockReason, 'unsafe_scheme_or_chars');
  }
  assert.equal(classifyPreviewResourceRef('data:image/png;base64,QUE='), 'inline_data');

  const outsideOpts = {
    documentPath: '/outside/notes/guide.md',
    workspaceRoot: '/work/repo',
  };
  const sibling = resolvePreviewResourceRef('./pic.png', outsideOpts);
  assert.equal(Boolean(sibling.blocked), false);
  assert.equal(sibling.resolvedPath, '/outside/notes/pic.png');

  const absSibling = resolvePreviewResourceRef('/outside/notes/sub/chart.png', outsideOpts);
  assert.equal(Boolean(absSibling.blocked), false);
  assert.equal(absSibling.resolvedPath, '/outside/notes/sub/chart.png');

  const relEscape = resolvePreviewResourceRef('../secret.txt', outsideOpts);
  assert.equal(relEscape.blocked, true);
  assert.equal(relEscape.blockReason, 'security_scope_blocked');

  const rootJumpToWs = resolvePreviewResourceRef('/assets/logo.png', outsideOpts);
  assert.equal(rootJumpToWs.blocked, true);
  assert.equal(rootJumpToWs.blockReason, 'security_scope_blocked');

  const directWsRead = resolvePreviewResourceRef('/work/repo/secret.txt', outsideOpts);
  assert.equal(directWsRead.blocked, true);
  assert.equal(directWsRead.blockReason, 'security_scope_blocked');

  const extCdn = resolvePreviewResourceRef('https://cdn.example.com/lib.js', outsideOpts);
  assert.equal(Boolean(extCdn.blocked), false);
  assert.equal(extCdn.kind, 'external_http');
  assert.equal(extCdn.externalUrl, 'https://cdn.example.com/lib.js');

  const winOutsideOpts = {
    documentPath: 'C:/outside/notes/doc.md',
    workspaceRoot: 'D:/work/repo',
  };
  assert.equal(resolvePreviewResourceRef('../secret.txt', winOutsideOpts).blocked, true);
  assert.equal(resolvePreviewResourceRef('D:/work/repo/a.png', winOutsideOpts).blocked, true);
  assert.equal(resolvePreviewResourceRef('./img.png', winOutsideOpts).resolvedPath, 'C:/outside/notes/img.png');
});

test('previewResourceResolver: 远端二进制 data_url / size / blob / 非法对象响应分支全覆盖', async () => {
  const dataUrlObjRes = await resolvePreviewAsset('/work/repo/img1.png', {
    gatewayUrl: 'https://gw.example.com',
    platformBridge: {
      httpProxy: async () => ({ data_url: 'blob:https://gw.example.com/1', size: 12 }),
    },
  });
  assert.equal(dataUrlObjRes.ok, true);
  assert.equal(dataUrlObjRes.dataUrl, 'blob:https://gw.example.com/1');
  assert.equal(dataUrlObjRes.byteSize, 12);

  const objMissThenStrMiss = await resolvePreviewAsset('/work/repo/img2.png', {
    gatewayUrl: 'https://gw.example.com',
    platformBridge: {
      httpProxy: async (opts) => {
        if (opts.path.startsWith('/api/fs/read-data-url')) return { ok: false, other: 1 };
        if (opts.path.startsWith('/api/files/read')) return 'plain-invalid-payload';
        return null;
      },
    },
  });
  assert.equal(objMissThenStrMiss.ok, false);

  // 裸文件名文档（docDir === '' 且 workspaceRoot === ''）必须阻断所有根相对/盘符路径
  const bareRootPic = resolvePreviewResourceRef('/Users/victim/secret.png', { documentPath: 'readme.md', workspaceRoot: '' });
  assert.equal(bareRootPic.blocked, true);
  assert.equal(bareRootPic.blockReason, 'security_scope_blocked');
  const bareDrivePic = resolvePreviewResourceRef('D:/secrets/key.png', { documentPath: 'readme.md', workspaceRoot: '' });
  assert.equal(bareDrivePic.blocked, true);
  assert.equal(bareDrivePic.blockReason, 'security_scope_blocked');
  assert.equal(resolvePreviewResourceRef('./sibling.png', { documentPath: 'readme.md', workspaceRoot: '' }).resolvedPath, 'sibling.png');

  // resolveEffectivePreviewScopeRoot & isPreviewAssetPathAllowed & resolvePreviewAsset 相对 .. 越权拦截
  assert.equal(resolveEffectivePreviewScopeRoot('', '/ws/'), '/ws');
  assert.equal(resolveEffectivePreviewScopeRoot('docs/a.md', '/ws'), '/ws');
  assert.equal(resolveEffectivePreviewScopeRoot('/ws/docs/a.md', '/ws'), '/ws');
  assert.equal(resolveEffectivePreviewScopeRoot('/ext/sub/a.md', '/ws'), '/ext/sub');

  assert.equal(isPreviewAssetPathAllowed('', { enforceWorkspaceScope: false }), false);
  assert.equal(isPreviewAssetPathAllowed('docs/a.png', { enforceWorkspaceScope: false }), true);
  assert.equal(isPreviewAssetPathAllowed('.env', { enforceWorkspaceScope: false }), false);
  assert.equal(isPreviewAssetPathAllowed('../secret.mp3', { workspaceRoot: '/ws', enforceWorkspaceScope: true }), false);
  assert.equal(isPreviewAssetPathAllowed('a/../../secret.mp3', { workspaceRoot: '/ws', enforceWorkspaceScope: true }), false);
  assert.equal(isPreviewAssetPathAllowed('/abs/a.mp3', { enforceWorkspaceScope: true }), false);
  assert.equal(isPreviewAssetPathAllowed('/other/a.mp3', { workspaceRoot: '/ws', enforceWorkspaceScope: true }), false);
  assert.equal(isPreviewAssetPathAllowed('/ws/a.mp3', { workspaceRoot: '/ws', enforceWorkspaceScope: true }), true);
  assert.equal(isPreviewAssetPathAllowed('media/a.mp3', { workspaceRoot: '/ws', enforceWorkspaceScope: true }), true);

  const relTraversalBlocked = await resolvePreviewAsset('../secret.mp3', {
    enforceWorkspaceScope: true,
    workspaceRoot: '/ws',
    platformBridge: { readFile: async () => 'data:audio/mpeg;base64,SUQz' },
  });
  assert.equal(relTraversalBlocked.ok, false);
  assert.equal(relTraversalBlocked.error, 'outside_workspace');
});
