/**
 * 桌面端零缓冲流式媒体协议 (hermes-media://) 单测
 * (packages/desktop/__tests__/unit/mediaStreamProtocol.test.mjs)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  HERMES_MEDIA_SCHEME,
  createMediaStreamController,
  parseByteRangeHeader,
} from '../../dist/main/mediaStreamProtocol.mjs';

test('parseByteRangeHeader: 完整覆盖标准 Range、后缀 Range、开区间与非法/越界拒绝分支', () => {
  assert.equal(parseByteRangeHeader(null, 100), null);
  assert.equal(parseByteRangeHeader('', 100), null);
  assert.equal(parseByteRangeHeader('items=0-1', 100), null);
  assert.equal(parseByteRangeHeader('bytes=', 100), null);
  assert.equal(parseByteRangeHeader('bytes=0-1, 2-3', 100), null);

  assert.equal(parseByteRangeHeader('bytes=0-1', 0), 'invalid');
  assert.equal(parseByteRangeHeader('bytes=nope', 100), 'invalid');
  assert.equal(parseByteRangeHeader('bytes=-', 100), 'invalid');
  assert.equal(parseByteRangeHeader('bytes=-0', 100), 'invalid');
  assert.equal(parseByteRangeHeader('bytes=-abc', 100), 'invalid');
  assert.equal(parseByteRangeHeader('bytes=abc-10', 100), 'invalid');
  assert.equal(parseByteRangeHeader('bytes=10-abc', 100), 'invalid');
  assert.equal(parseByteRangeHeader('bytes=20-10', 100), 'invalid');
  assert.equal(parseByteRangeHeader('bytes=100-120', 100), 'invalid');

  assert.deepEqual(parseByteRangeHeader('bytes=0-9', 100), { start: 0, end: 9 });
  assert.deepEqual(parseByteRangeHeader('bytes=90-999', 100), { start: 90, end: 99 });
  assert.deepEqual(parseByteRangeHeader('bytes=90-', 100), { start: 90, end: 99 });
  assert.deepEqual(parseByteRangeHeader('bytes=-15', 100), { start: 85, end: 99 });
  assert.deepEqual(parseByteRangeHeader('bytes=-500', 100), { start: 0, end: 99 });
});

test('createMediaStreamController: buildStreamUrl 本地分片/远端网关/敏感隔离与协议请求全分支', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-media-test-'));
  const sampleVideoPath = path.join(tmpDir, 'demo-clip.mp4');
  const emptyVideoPath = path.join(tmpDir, 'empty-clip.mp4');
  const payload = Buffer.from('0123456789ABCDEF');
  fs.writeFileSync(sampleVideoPath, payload);
  fs.writeFileSync(emptyVideoPath, Buffer.alloc(0));

  try {
    let authState = { cookies: 'sid=gw-secret', origin: 'https://gw.example.com:9119' };
    const upstreamRequests = [];
    let upstreamMode = 'range206';

    const ctrl = createMediaStreamController({
      nonce: 'nonce-fixed',
      getGatewayAuth: () => authState,
      getFallbackCwd: () => tmpDir,
      resolveLocalFile: (rawPath, fallbackCwd) => {
        if (!rawPath) return null;
        if (rawPath.includes('outside')) return null;
        const candidate = path.isAbsolute(rawPath) ? rawPath : path.resolve(fallbackCwd || '', rawPath);
        return fs.existsSync(candidate) ? candidate : null;
      },
      fetchImpl: async (url, init) => {
        upstreamRequests.push({ url: String(url), method: init?.method, headers: init?.headers });
        if (upstreamMode === 'network-err') {
          throw new Error('ECONNRESET');
        }
        if (upstreamMode === 'html') {
          return new Response('<html><body>Login</body></html>', {
            status: 200,
            headers: { 'content-type': 'text/html; charset=utf-8' },
          });
        }
        if (upstreamMode === 'fallback404' && String(url).includes('/api/fs/download')) {
          return new Response('not found', { status: 404 });
        }
        if (upstreamMode === 'err500') {
          return new Response('server error', { status: 500 });
        }
        if (upstreamMode === 'encoded') {
          return new Response(Uint8Array.from([1, 2, 3]), {
            status: 200,
            headers: {
              'content-type': 'application/octet-stream',
              'content-encoding': 'gzip',
              'content-length': '3',
              etag: '"v1"',
            },
          });
        }
        return new Response(Uint8Array.from([65, 66, 67, 68]), {
          status: upstreamMode === 'range206' ? 206 : 200,
          headers: {
            'content-type': 'video/mp4',
            'content-length': '4',
            'content-range': 'bytes 2-5/16',
            'accept-ranges': 'bytes',
          },
        });
      },
    });

    // 1. buildStreamUrl 守卫与分级路由
    assert.equal(ctrl.buildStreamUrl({ filePath: '' }), null);
    assert.equal(ctrl.buildStreamUrl({ filePath: 'a\0b.mp4' }), null);
    assert.equal(ctrl.buildStreamUrl({ filePath: '/tmp/notes.md' }), null);
    assert.equal(ctrl.buildStreamUrl({ filePath: '/tmp/.env.mp4' }), null);
    assert.equal(ctrl.buildStreamUrl({ filePath: '/tmp/.env/video.mp4' }), null);

    const localUrl = ctrl.buildStreamUrl({ filePath: sampleVideoPath });
    assert.ok(localUrl && localUrl.startsWith(`${HERMES_MEDIA_SCHEME}://local/stream?`));

    const loopbackGatewayUrl = ctrl.buildStreamUrl({
      filePath: sampleVideoPath,
      gatewayUrl: 'http://127.0.0.1:9119',
    });
    assert.ok(loopbackGatewayUrl?.startsWith(`${HERMES_MEDIA_SCHEME}://local/stream?`));

    assert.equal(ctrl.buildStreamUrl({ filePath: '/missing/no-gateway.mp4' }), null);
    const savedWarnUrl = console.warn;
    console.warn = () => {};
    try {
      assert.equal(
        ctrl.buildStreamUrl({ filePath: '/remote/clip.mp4', gatewayUrl: 'http://[::1' }),
        null,
      );
    } finally {
      console.warn = savedWarnUrl;
    }
    assert.equal(
      ctrl.buildStreamUrl({ filePath: '/remote/clip.mp4', gatewayUrl: 'ftp://gw.example.com/v.mp4' }),
      null,
    );

    const gwUrl = ctrl.buildStreamUrl({
      filePath: '/opt/data/clip.mp4',
      gatewayUrl: 'wss://gw.example.com:9119/ws',
      profile: 'coder',
      sessionId: 'sess-1',
    });
    assert.ok(gwUrl && gwUrl.startsWith(`${HERMES_MEDIA_SCHEME}://gateway/stream?`));

    // 2. handleProtocolRequest 鉴权与非预期路由校验
    assert.equal((await ctrl.handleProtocolRequest(new Request('http://local/stream'))).status, 400);
    assert.equal(
      (await ctrl.handleProtocolRequest(new Request(`${HERMES_MEDIA_SCHEME}://local/stream?token=wrong&path=${encodeURIComponent(sampleVideoPath)}`))).status,
      403,
    );
    assert.equal(
      (await ctrl.handleProtocolRequest(new Request(`${HERMES_MEDIA_SCHEME}://local/stream?token=nonce-fixed&path=${encodeURIComponent('/tmp/.env')}`))).status,
      403,
    );
    assert.equal(
      (await ctrl.handleProtocolRequest(new Request(`${HERMES_MEDIA_SCHEME}://unknown/stream?token=nonce-fixed&path=${encodeURIComponent(sampleVideoPath)}`))).status,
      404,
    );

    // 3. 本地流式 Range 206 / 全量 200 / 空文件 200 / HEAD / 416 / 404
    const fullLocalRes = await ctrl.handleProtocolRequest(new Request(localUrl));
    assert.equal(fullLocalRes.status, 200);
    assert.equal(fullLocalRes.headers.get('accept-ranges'), 'bytes');
    assert.equal(fullLocalRes.headers.get('content-type'), 'video/mp4');
    assert.equal(await fullLocalRes.text(), '0123456789ABCDEF');

    const headLocalRes = await ctrl.handleProtocolRequest(new Request(localUrl, { method: 'HEAD' }));
    assert.equal(headLocalRes.status, 200);
    assert.equal(headLocalRes.headers.get('content-length'), '16');
    assert.equal(await headLocalRes.text(), '');

    const rangeLocalRes = await ctrl.handleProtocolRequest(
      new Request(localUrl, { headers: { Range: 'bytes=2-5' } }),
    );
    assert.equal(rangeLocalRes.status, 206);
    assert.equal(rangeLocalRes.headers.get('content-range'), 'bytes 2-5/16');
    assert.equal(await rangeLocalRes.text(), '2345');

    const headRangeRes = await ctrl.handleProtocolRequest(
      new Request(localUrl, { method: 'HEAD', headers: { Range: 'bytes=0-3' } }),
    );
    assert.equal(headRangeRes.status, 206);
    assert.equal(await headRangeRes.text(), '');

    const invalidRangeRes = await ctrl.handleProtocolRequest(
      new Request(localUrl, { headers: { Range: 'bytes=999-1000' } }),
    );
    assert.equal(invalidRangeRes.status, 416);
    assert.equal(invalidRangeRes.headers.get('content-range'), 'bytes */16');

    const emptyUrl = ctrl.buildStreamUrl({ filePath: emptyVideoPath });
    const emptyRes = await ctrl.handleProtocolRequest(new Request(emptyUrl));
    assert.equal(emptyRes.status, 200);
    assert.equal(emptyRes.headers.get('content-length'), '0');

    const missingLocalRes = await ctrl.handleProtocolRequest(
      new Request(`${HERMES_MEDIA_SCHEME}://local/stream?token=nonce-fixed&path=${encodeURIComponent(path.join(tmpDir, 'outside.mp4'))}`),
    );
    assert.equal(missingLocalRes.status, 404);

    // 非文件或 stat 异常覆盖
    const statThrowCtrl = createMediaStreamController({
      nonce: 'n2',
      getGatewayAuth: () => authState,
      getFallbackCwd: () => tmpDir,
      resolveLocalFile: () => sampleVideoPath,
      statFile: () => ({ size: 1, isFile: () => false }),
    });
    assert.equal(
      (await statThrowCtrl.handleProtocolRequest(new Request(`${HERMES_MEDIA_SCHEME}://local/stream?token=n2&path=${encodeURIComponent(sampleVideoPath)}`))).status,
      404,
    );

    // 4. 远端网关代理流：同源 Cookie + Range 透传 + 跨源隔离 + 404 回落 + HTML SPA 阻断
    const gw206 = await ctrl.handleProtocolRequest(new Request(gwUrl, { headers: { Range: 'bytes=2-5' } }));
    assert.equal(gw206.status, 206);
    assert.equal(gw206.headers.get('content-range'), 'bytes 2-5/16');
    assert.equal(upstreamRequests[0].headers.Cookie, 'sid=gw-secret');
    assert.equal(upstreamRequests[0].headers.Range, 'bytes=2-5');

    // 跨源不传 Cookie
    authState = { cookies: 'sid=other', origin: 'https://other.example.com' };
    const crossOriginUrl = ctrl.buildStreamUrl({
      filePath: '/opt/data/clip.mp4',
      gatewayUrl: 'https://gw.example.com:9119',
    });
    upstreamMode = 'fallback404';
    const fallbackOk = await ctrl.handleProtocolRequest(new Request(crossOriginUrl));
    assert.equal(fallbackOk.status, 200);
    assert.equal(upstreamRequests.at(-1).headers.Cookie, undefined);
    assert.ok(upstreamRequests.at(-1).url.includes('/api/files/download?path='));

    upstreamMode = 'encoded';
    const encodedRes = await ctrl.handleProtocolRequest(new Request(crossOriginUrl));
    assert.equal(encodedRes.status, 200);
    assert.equal(encodedRes.headers.get('content-length'), null);
    assert.equal(encodedRes.headers.get('content-type'), 'video/mp4');

    upstreamMode = 'html';
    assert.equal((await ctrl.handleProtocolRequest(new Request(crossOriginUrl))).status, 404);

    upstreamMode = 'err500';
    assert.equal((await ctrl.handleProtocolRequest(new Request(crossOriginUrl))).status, 500);

    upstreamMode = 'network-err';
    const savedWarn = console.warn;
    console.warn = () => {};
    try {
      assert.equal((await ctrl.handleProtocolRequest(new Request(crossOriginUrl))).status, 502);
    } finally {
      console.warn = savedWarn;
    }

    // Gateway query 参数校验分支
    assert.equal(
      (await ctrl.handleProtocolRequest(new Request(`${HERMES_MEDIA_SCHEME}://gateway/stream?token=nonce-fixed&path=/a.mp4`))).status,
      400,
    );
    assert.equal(
      (await ctrl.handleProtocolRequest(new Request(`${HERMES_MEDIA_SCHEME}://gateway/stream?token=nonce-fixed&path=/a.mp4&base=${encodeURIComponent('http://[bad')}`))).status,
      400,
    );
    assert.equal(
      (await ctrl.handleProtocolRequest(new Request(`${HERMES_MEDIA_SCHEME}://gateway/stream?token=nonce-fixed&path=/a.mp4&base=${encodeURIComponent('ftp://bad.example.com')}`))).status,
      403,
    );

    // 5. Gateway HEAD 请求显式取消上游响应体（不留未关闭流）
    let headBodyCanceled = false;
    const headCtrl = createMediaStreamController({
      nonce: 'n-head',
      getGatewayAuth: () => authState,
      getFallbackCwd: () => tmpDir,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'video/mp4', 'content-length': '2048' }),
        body: {
          cancel: async () => {
            headBodyCanceled = true;
          },
        },
      }),
    });
    const headGwUrl = headCtrl.buildStreamUrl({
      filePath: '/opt/data/clip.mp4',
      gatewayUrl: 'https://gw.example.com:9119',
    });
    const headGwRes = await headCtrl.handleProtocolRequest(new Request(headGwUrl, { method: 'HEAD' }));
    assert.equal(headGwRes.status, 200);
    assert.equal(headGwRes.headers.get('content-length'), '2048');
    assert.equal(await headGwRes.text(), '');
    assert.equal(headBodyCanceled, true, 'HEAD 请求必须显式取消上游响应流以防资源泄漏');

    // 6. 本地流背压 (pause/pull->resume)、error/end 与 cancel() destroy() 守卫全分支
    const { EventEmitter } = await import('node:events');
    let fakeDestroyed = false;
    let fakePaused = false;
    let fakeResumed = false;
    let fakeEmitter;
    const cancelCtrl = createMediaStreamController({
      nonce: 'n-cancel',
      getGatewayAuth: () => authState,
      getFallbackCwd: () => tmpDir,
      resolveLocalFile: () => sampleVideoPath,
      statFile: () => ({ size: 100, isFile: () => true }),
      createReadStream: () => {
        fakeEmitter = new EventEmitter();
        fakePaused = false;
        fakeResumed = false;
        fakeDestroyed = false;
        fakeEmitter.pause = () => { fakePaused = true; };
        fakeEmitter.resume = () => { fakeResumed = true; };
        fakeEmitter.destroy = () => { fakeDestroyed = true; };
        return fakeEmitter;
      },
    });
    const cancelUrl = cancelCtrl.buildStreamUrl({ filePath: sampleVideoPath });
    const cancelRes = await cancelCtrl.handleProtocolRequest(new Request(cancelUrl));
    // 推送 >1 块促使默认 HWM=1 的 ReadableStream desiredSize <= 0 -> pause()；再 read() 触发 pull() -> resume()
    fakeEmitter.emit('data', 'chunk-string-1');
    fakeEmitter.emit('data', Buffer.from('chunk-buf-2'));
    assert.equal(fakePaused, true, '背压水位满时必须调用 nodeStream.pause()');
    const reader = cancelRes.body.getReader();
    const firstChunk = await reader.read();
    assert.equal(new TextDecoder().decode(firstChunk.value), 'chunk-string-1');
    assert.equal(fakeResumed, true, '下游消费触发 pull() 时必须调用 nodeStream.resume()');
    await reader.cancel();
    assert.equal(fakeDestroyed, true, 'Web Stream cancel() 必须立刻销毁底层 Node ReadStream');
    fakeEmitter.emit('data', 'late-string-chunk');
    fakeEmitter.emit('end');
    fakeEmitter.emit('error', new Error('late error after cancel'));

    // error 事件传播与正常 end 收尾分支
    const errRes = await cancelCtrl.handleProtocolRequest(new Request(cancelUrl));
    const errReader = errRes.body.getReader();
    fakeEmitter.emit('error', new Error('disk i/o err'));
    await assert.rejects(() => errReader.read(), /disk i\/o err/);

    // statFile 抛错 (404) 与非法 URL 对象 (400)
    const statErrCtrl = createMediaStreamController({
      nonce: 'n-stat-err',
      getGatewayAuth: () => authState,
      getFallbackCwd: () => tmpDir,
      resolveLocalFile: () => sampleVideoPath,
      statFile: () => {
        throw new Error('ENOENT');
      },
    });
    assert.equal(
      (await statErrCtrl.handleProtocolRequest(new Request(`${HERMES_MEDIA_SCHEME}://local/stream?token=n-stat-err&path=${encodeURIComponent(sampleVideoPath)}`))).status,
      404,
    );
    assert.equal(
      (await cancelCtrl.handleProtocolRequest({ url: '://not-a-valid-url', method: 'GET', headers: new Headers() })).status,
      400,
    );

    // 7. 默认随机 nonce 生成、缺失 path 查询参数 (403)、.env.mp4 阻断 (403) 与网关缺省 content-type 回落检测 MIME
    const autoNonceCtrl = createMediaStreamController({
      getGatewayAuth: () => authState,
      getFallbackCwd: () => tmpDir,
      fetchImpl: async () =>
        new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: new Headers(),
        }),
    });
    const autoGwUrl = autoNonceCtrl.buildStreamUrl({
      filePath: '/opt/data/auto.webm',
      gatewayUrl: 'https://gw.example.com:9119',
    });
    assert.ok(autoGwUrl && autoGwUrl.includes('token='));
    const autoToken = new URL(autoGwUrl).searchParams.get('token');
    assert.ok(autoToken && autoToken.length >= 16);

    assert.equal(
      (await autoNonceCtrl.handleProtocolRequest(new Request(`${HERMES_MEDIA_SCHEME}://gateway/stream?token=${autoToken}`))).status,
      403,
    );
    assert.equal(
      (await autoNonceCtrl.handleProtocolRequest(new Request(`${HERMES_MEDIA_SCHEME}://local/stream?token=${autoToken}&path=${encodeURIComponent('sub/.env.mp4')}`))).status,
      403,
    );
    assert.equal(
      (await autoNonceCtrl.handleProtocolRequest(new Request(`${HERMES_MEDIA_SCHEME}://local/stream?token=${autoToken}&path=${encodeURIComponent('/out/pic.png')}`))).status,
      403,
    );
    const noCtRes = await autoNonceCtrl.handleProtocolRequest(new Request(autoGwUrl));
    assert.equal(noCtRes.status, 200);
    assert.equal(noCtRes.headers.get('content-type'), 'video/webm');
    await noCtRes.arrayBuffer();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
