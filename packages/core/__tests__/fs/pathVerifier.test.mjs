/**
 * 成果物父目录批量物理存在性核验单元测试
 * (packages/core/__tests__/fs/pathVerifier.test.mjs)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createDirectoryPathVerifier, groupPathsByParentDir } from '../../dist/fs/pathVerifier.js';

test('groupPathsByParentDir: 按父目录折叠候选路径并解析 cwd 相对路径，过滤占位与 OS 系统路径', () => {
  const grouped = groupPathsByParentDir(
    [
      '/opt/data/drafts/a.html',
      '/opt/data/drafts/b.md',
      '/opt/data/drafts/a.html',
      '/opt/data/drafts/img/timeline.png',
      'reports/summary.md',
      '/etc/hosts',
      '/path/to/fake.png',
      '/usr/bin/node',
    ],
    '/opt/workspace',
  );

  assert.equal(grouped.size, 3);
  assert.deepEqual(grouped.get('/opt/data/drafts'), ['/opt/data/drafts/a.html', '/opt/data/drafts/b.md']);
  assert.deepEqual(grouped.get('/opt/data/drafts/img'), ['/opt/data/drafts/img/timeline.png']);
  assert.deepEqual(grouped.get('/opt/workspace/reports'), ['reports/summary.md']);
  assert.equal(grouped.has('/etc'), false);
  assert.equal(grouped.has('/path/to'), false);
  assert.equal(grouped.has('/usr/bin'), false);
});

test('createDirectoryPathVerifier: 同父目录批量仅发起 1 次探针、LRU 缓存复用与并发合并', async () => {
  const listCalls = [];
  const verifier = createDirectoryPathVerifier({
    getPlatformBridge: () => ({
      async listDirectory(dirPath) {
        listCalls.push(dirPath);
        await new Promise((r) => setTimeout(r, 10));
        if (dirPath === '/opt/data/drafts') {
          return [
            { name: '2026-11-23-t3code-telemetry.html', path: `${dirPath}/2026-11-23-t3code-telemetry.html`, isDirectory: false },
            { name: '2026-11-23-t3code-xiaohongshu.md', path: `${dirPath}/2026-11-23-t3code-xiaohongshu.md`, isDirectory: false },
            { name: 'subdir.png', path: `${dirPath}/subdir.png`, isDirectory: true },
          ];
        }
        if (dirPath === '/opt/data/drafts/img') {
          return [{ name: 't3-timeline.png', path: `${dirPath}/t3-timeline.png`, isDirectory: false }];
        }
        if (dirPath === '/opt/ws/rel') {
          return [{ name: 'chart.png', path: `${dirPath}/chart.png`, isDirectory: false }];
        }
        return [];
      },
      async httpProxy() {
        throw new Error('should not hit httpProxy when listDirectory handles local_fs');
      },
    }),
  });

  // 并发调用同一目录下多个文件：每个目录仅 1 次物理列举请求，且目录项 (subdir.png) 严禁当文件放行
  const [res1, res2] = await Promise.all([
    verifier.verifyPathsExist(
      [
        '/opt/data/drafts/2026-11-23-t3code-telemetry.html',
        '/opt/data/drafts/2026-11-23-t3code-xiaohongshu.md',
        '/opt/data/drafts/subdir.png',
        '/opt/data/drafts/missing.md',
        '/opt/data/drafts/img/t3-timeline.png',
        'rel/chart.png',
      ],
      { cwd: '/opt/ws' },
    ),
    verifier.verifyPathsExist(['/opt/data/drafts/2026-11-23-t3code-telemetry.html'], { cwd: '/opt/ws' }),
  ]);

  assert.deepEqual(res1, [
    '/opt/data/drafts/2026-11-23-t3code-telemetry.html',
    '/opt/data/drafts/2026-11-23-t3code-xiaohongshu.md',
    '/opt/data/drafts/img/t3-timeline.png',
    'rel/chart.png',
  ]);
  assert.deepEqual(res2, ['/opt/data/drafts/2026-11-23-t3code-telemetry.html']);
  assert.equal(listCalls.filter((d) => d === '/opt/data/drafts').length, 1, '同父目录多候选与并发探测只能触发 1 次 listDirectory');

  // 再次验证命中 LRU 缓存，不新增 listDirectory 调用
  const beforeCount = listCalls.length;
  const cachedRes = await verifier.verifyPathsExist(['/opt/data/drafts/img/t3-timeline.png'], { cwd: '/opt/ws' });
  assert.deepEqual(cachedRes, ['/opt/data/drafts/img/t3-timeline.png']);
  assert.equal(listCalls.length, beforeCount);

  // clear() 后重新触发物理列举
  verifier.clear();
  await verifier.verifyPathsExist(['/opt/data/drafts/img/t3-timeline.png'], { cwd: '/opt/ws' });
  assert.equal(listCalls.length, beforeCount + 1);
});

test('createDirectoryPathVerifier: 远端 gateway_api 实证放行，缺失桥接/异常处理降级为空，禁 session_cache 自证', async () => {
  // 1. 远端 gateway_api
  const remoteVerifier = createDirectoryPathVerifier({
    getPlatformBridge: () => ({
      async httpProxy(opts) {
        if (opts.path.startsWith('/api/files')) {
          return {
            entries: [
              { name: 't3-timeline.png', type: 'file' },
              { name: 'folder', type: 'directory' },
            ],
          };
        }
        return { error: 'unsupported' };
      },
    }),
  });
  const remoteOut = await remoteVerifier.verifyPathsExist(
    ['/opt/out/t3-timeline.png', '/opt/out/folder'],
    { gatewayUrl: 'https://gw.example.com', profile: 'default' },
  );
  assert.deepEqual(remoteOut, ['/opt/out/t3-timeline.png']);

  // 2. 超过 128 个目录时正确淘汰最久未用 LRU 键并保持边界稳定
  const lruCalls = [];
  const lruVerifier = createDirectoryPathVerifier({
    getPlatformBridge: () => ({
      async listDirectory(dirPath) {
        lruCalls.push(dirPath);
        return [{ name: 'ok.png', path: `${dirPath}/ok.png`, isDirectory: false }];
      },
    }),
  });
  for (let i = 0; i < 130; i += 1) {
    await lruVerifier.verifyPathsExist([`/lru/d${i}/ok.png`]);
  }
  assert.equal(lruCalls.length, 130);
  // 最早的 d0 已被淘汰，重查会再次发起物理探测；最新的 d129 仍在缓存内
  await lruVerifier.verifyPathsExist(['/lru/d129/ok.png']);
  assert.equal(lruCalls.length, 130);
  await lruVerifier.verifyPathsExist(['/lru/d0/ok.png']);
  assert.equal(lruCalls.length, 131);

  // 3. 无桥接或桥接抛异常时安全返回空数组
  const noBridge = createDirectoryPathVerifier({ getPlatformBridge: () => null });
  assert.deepEqual(await noBridge.verifyPathsExist(['/opt/out/a.png']), []);

  const errBridge = createDirectoryPathVerifier({
    getPlatformBridge: () => ({
      async listDirectory() {
        throw new Error('permission denied');
      },
    }),
  });
  assert.deepEqual(await errBridge.verifyPathsExist(['/opt/out/a.png']), []);
});
