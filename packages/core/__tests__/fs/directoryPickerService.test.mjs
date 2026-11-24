/**
 * 项目目录树浏览、新建与重命名纯服务单元测试 (directoryPickerService.test.mjs)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  browseProjectDirectory,
  createProjectDirectory,
  extractParentDirectoryPath,
  isPathWithinDirectory,
  isProtectedRootDirectory,
  normalizePathForMatch,
  posixQuoteShellArg,
  renameProjectDirectory,
  validateDirectoryName,
} from '../../dist/index.js';

test('validateDirectoryName / posixQuoteShellArg / isProtectedRootDirectory 边界校验', () => {
  assert.deepEqual(validateDirectoryName(''), { ok: false, reason: 'empty' });
  assert.deepEqual(validateDirectoryName('   '), { ok: false, reason: 'empty' });
  assert.deepEqual(validateDirectoryName('.'), { ok: false, reason: 'reserved' });
  assert.deepEqual(validateDirectoryName('..'), { ok: false, reason: 'reserved' });
  assert.deepEqual(validateDirectoryName('.env'), { ok: false, reason: 'secret' });
  assert.deepEqual(validateDirectoryName('.env.prod'), { ok: false, reason: 'secret' });
  assert.deepEqual(validateDirectoryName('.env.example'), { ok: true, name: '.env.example' });
  assert.deepEqual(validateDirectoryName('a/b'), { ok: false, reason: 'invalid_chars' });
  assert.deepEqual(validateDirectoryName('a\\b'), { ok: false, reason: 'invalid_chars' });
  assert.deepEqual(validateDirectoryName('bad:name'), { ok: false, reason: 'invalid_chars' });
  assert.deepEqual(validateDirectoryName('  my-repo  '), { ok: true, name: 'my-repo' });

  assert.equal(posixQuoteShellArg("/opt/data/it's here"), "'/opt/data/it'\\''s here'");
  assert.throws(() => posixQuoteShellArg('/opt/data/bad\nline'));

  assert.equal(extractParentDirectoryPath('/opt/data/repo'), '/opt/data');
  assert.equal(extractParentDirectoryPath('/'), '');
  assert.equal(extractParentDirectoryPath('C:/Work/repo'), 'C:/Work');
  assert.equal(extractParentDirectoryPath('C:/Work'), 'C:/');
  assert.equal(extractParentDirectoryPath('C:/'), '');

  assert.equal(isProtectedRootDirectory('/'), true);
  assert.equal(isProtectedRootDirectory('C:/'), true);
  assert.equal(isProtectedRootDirectory('/opt/data', '/opt/data'), true);
  assert.equal(isProtectedRootDirectory('/opt/data/workspace/app', '/opt/data'), false);
  assert.equal(isProtectedRootDirectory('/etc/nginx'), true);
  assert.equal(isProtectedRootDirectory('C:/Windows/System32'), true);
});

test('browseProjectDirectory: 远程走 /api/files + /api/fs/default-cwd，支持回退 /api/fs/list 且拒绝跨隔离回落本地 FS', async () => {
  const proxyCalls = [];
  const remoteRes = await browseProjectDirectory('', {
    gatewayUrl: 'https://hermes.example.com',
    profile: 'default',
    platformBridge: {
      httpProxy: async (opts) => {
        proxyCalls.push({ method: opts.method, path: opts.path, params: opts.params });
        if (opts.path === '/api/fs/default-cwd') {
          return JSON.stringify({ cwd: '/opt/data/workspace', branch: 'main' });
        }
        if (opts.path === '/api/files') {
          return JSON.stringify({
            path: '/opt/data',
            parent: null,
            root: '/opt/data',
            locked_root: '/opt/data',
            entries: [
              { name: '.git', type: 'directory' },
              { name: 'workspace', type: 'directory' },
              { name: 'alpha', is_dir: true },
              { name: 'README.md', type: 'file' },
            ],
          });
        }
        throw new Error(`Unexpected path: ${opts.path}`);
      },
      listDirectory: async () => {
        throw new Error('Remote mode must never fall back to local listDirectory');
      },
    },
    execShell: async () => ({ stdout: '', code: 0 }),
  });

  assert.equal(remoteRes.ok, true);
  if (remoteRes.ok) {
    assert.equal(remoteRes.source, 'gateway_api');
    assert.equal(remoteRes.currentPath, '/opt/data');
    assert.equal(remoteRes.lockedRoot, '/opt/data');
    assert.equal(remoteRes.defaultCwd, '/opt/data/workspace');
    assert.deepEqual(remoteRes.entries, [
      { name: 'alpha', path: '/opt/data/alpha' },
      { name: 'workspace', path: '/opt/data/workspace' },
    ]);
    assert.equal(remoteRes.canCreate, true);
    assert.equal(remoteRes.canRename, true);
  }
  assert.equal(proxyCalls.some((c) => c.path === '/api/fs/default-cwd'), true);

  // /api/files 返回 SPA fallback HTML 时回退到 /api/fs/list
  const fallbackRes = await browseProjectDirectory('/opt/data/ws', {
    gatewayUrl: 'https://hermes.example.com',
    platformBridge: {
      httpProxy: async (opts) => {
        if (opts.path.startsWith('/api/files')) {
          return '<!DOCTYPE html><html><body>Dashboard</body></html>';
        }
        return JSON.stringify({
          path: '/opt/data/ws',
          entries: [{ name: 'repo-1', isDirectory: true, path: '/opt/data/ws/repo-1' }],
        });
      },
    },
  });
  assert.equal(fallbackRes.ok, true);
  if (fallbackRes.ok) {
    assert.equal(fallbackRes.currentPath, '/opt/data/ws');
    assert.deepEqual(fallbackRes.entries, [{ name: 'repo-1', path: '/opt/data/ws/repo-1' }]);
  }

  // 远程网关彻底报错时不得泄露本机 listDirectory 结果（Failure Is Not Empty）
  let localCalled = 0;
  const remoteErr = await browseProjectDirectory('', {
    gatewayUrl: 'https://hermes.example.com',
    platformBridge: {
      httpProxy: async () => {
        throw new Error('HTTP 502: Bad Gateway');
      },
      listDirectory: async () => {
        localCalled += 1;
        return [{ name: 'C-Local-Secret', path: 'C:/Local/Secret', isDirectory: true }];
      },
    },
  });
  assert.equal(remoteErr.ok, false);
  assert.equal(localCalled, 0);

  // 回环本地网关允许安全降级本地 PAL
  const localRes = await browseProjectDirectory('', {
    gatewayUrl: 'http://127.0.0.1:8080',
    platformBridge: {
      httpProxy: async () => {
        throw new Error('404');
      },
      listDirectory: async () => [
        { name: 'proj-a', path: 'D:\\work\\proj-a', isDirectory: true },
        { name: 'notes.txt', path: 'D:\\work\\notes.txt', isDirectory: false },
      ],
      createDirectory: async () => ({ ok: true, path: 'D:/work/new' }),
      renameDirectory: async () => ({ ok: true, path: 'D:/work/renamed' }),
    },
  });
  assert.equal(localRes.ok, true);
  if (localRes.ok) {
    assert.equal(localRes.source, 'local_fs');
    assert.equal(localRes.currentPath, 'D:/work');
    assert.deepEqual(localRes.entries, [{ name: 'proj-a', path: 'D:/work/proj-a' }]);
    assert.equal(localRes.canCreate, true);
    assert.equal(localRes.canRename, true);
  }
});

test('createProjectDirectory / renameProjectDirectory: 远程 mkdir / shell.exec、防越界、重名冲突与本地回环路由', async () => {
  const mkdirCalls = [];
  const createOk = await createProjectDirectory('/opt/data/workspace', 'new-app', {
    gatewayUrl: 'https://hermes.example.com',
    lockedRoot: '/opt/data',
    platformBridge: {
      httpProxy: async (opts) => {
        mkdirCalls.push(opts);
        return { ok: true };
      },
    },
  });
  assert.deepEqual(createOk, { ok: true, path: '/opt/data/workspace/new-app' });
  assert.equal(mkdirCalls[0].path, '/api/files/mkdir');
  assert.deepEqual(mkdirCalls[0].body, { path: '/opt/data/workspace/new-app' });

  const outsideCreate = await createProjectDirectory('/etc', 'hack', {
    gatewayUrl: 'https://hermes.example.com',
    lockedRoot: '/opt/data',
  });
  assert.deepEqual(outsideCreate, { ok: false, error: 'PATH_OUTSIDE_LOCKED_ROOT' });

  const shellCommands = [];
  const renameOk = await renameProjectDirectory('/opt/data/workspace/old app', "new'app", {
    gatewayUrl: 'https://hermes.example.com',
    profile: 'default',
    lockedRoot: '/opt/data',
    execShell: async (command, profile) => {
      shellCommands.push({ command, profile });
      return { code: 0, stdout: '', stderr: '' };
    },
  });
  assert.deepEqual(renameOk, { ok: true, path: "/opt/data/workspace/new'app" });
  assert.equal(shellCommands[0].profile, 'default');
  assert.ok(shellCommands[0].command.includes("mv -- '/opt/data/workspace/old app' '/opt/data/workspace/new'\\''app'"));

  const renameConflict = await renameProjectDirectory('/opt/data/workspace/old', 'existing', {
    gatewayUrl: 'https://hermes.example.com',
    lockedRoot: '/opt/data',
    execShell: async () => ({ code: 17, stderr: 'TARGET_EXISTS\n', stdout: '' }),
  });
  assert.deepEqual(renameConflict, { ok: false, error: 'TARGET_EXISTS' });

  const protectedErr = await renameProjectDirectory('/opt/data', 'other', {
    gatewayUrl: 'https://hermes.example.com',
    lockedRoot: '/opt/data',
  });
  assert.deepEqual(protectedErr, { ok: false, error: 'PROTECTED_ROOT_DIRECTORY' });

  // 本地 Windows 路径即便 gatewayUrl 为回环也路由到本地 PAL，避免调 bash mv 失败
  let localRenamed = null;
  const winRename = await renameProjectDirectory('D:/work/app', 'app-v2', {
    gatewayUrl: 'http://127.0.0.1:8080',
    platformBridge: {
      renameDirectory: async (dirPath, newName) => {
        localRenamed = { dirPath, newName };
        return { ok: true, path: 'D:/work/app-v2' };
      },
    },
  });
  assert.deepEqual(localRenamed, { dirPath: 'D:/work/app', newName: 'app-v2' });
  assert.deepEqual(winRename, { ok: true, path: 'D:/work/app-v2' });

  // 词法 .. / . 穿越段严禁绕过 lockedRoot 与根目录保护
  assert.deepEqual(
    await browseProjectDirectory('/opt/data/ws/../..', { gatewayUrl: 'https://hermes.example.com' }),
    { ok: false, error: 'INVALID_DIRECTORY_PATH' },
  );
  assert.deepEqual(
    await createProjectDirectory('/opt/data/ws/../../etc', 'hack', {
      gatewayUrl: 'https://hermes.example.com',
      lockedRoot: '/opt/data',
    }),
    { ok: false, error: 'INVALID_PARENT_DIRECTORY' },
  );
  assert.deepEqual(
    await renameProjectDirectory('/opt/data/.', 'pwned', {
      gatewayUrl: 'https://hermes.example.com',
      lockedRoot: '/opt/data',
    }),
    { ok: false, error: 'INVALID_DIRECTORY_PATH' },
  );
  assert.equal(
    isPathWithinDirectory(normalizePathForMatch('/opt/data/ws/../../etc/hack'), '/opt/data'),
    false,
  );

  // 非回环远端网关即便误传 source='local_fs' 也严禁触发本地 FS 写操作
  let remoteLeakCreate = false;
  let remoteLeakRename = false;
  const leakCreate = await createProjectDirectory('/opt/data/ws', 'sub', {
    gatewayUrl: 'https://hermes.example.com',
    source: 'local_fs',
    lockedRoot: '/opt/data',
    platformBridge: {
      createDirectory: async () => {
        remoteLeakCreate = true;
        return { ok: true, path: 'C:/leak' };
      },
    },
  });
  assert.equal(remoteLeakCreate, false);
  assert.equal(leakCreate.ok, false);

  const leakRename = await renameProjectDirectory('/opt/data/ws/a', 'b', {
    gatewayUrl: 'https://hermes.example.com',
    source: 'local_fs',
    lockedRoot: '/opt/data',
    platformBridge: {
      renameDirectory: async () => {
        remoteLeakRename = true;
        return { ok: true, path: 'C:/leak' };
      },
    },
    execShell: async () => ({ code: 0, stdout: '', stderr: '' }),
  });
  assert.equal(remoteLeakRename, false);
  assert.deepEqual(leakRename, { ok: true, path: '/opt/data/ws/b' });

  // /api/files/mkdir 返回 SPA HTML 或 200 { ok: false } 时绝不能静默返回 ok:true
  const mkdirHtmlFail = await createProjectDirectory('/opt/data/ws', 'sub', {
    gatewayUrl: 'https://hermes.example.com',
    lockedRoot: '/opt/data',
    platformBridge: {
      httpProxy: async () => '<!doctype html><html><body>Dashboard</body></html>',
    },
  });
  assert.equal(mkdirHtmlFail.ok, false);

  const mkdirErrJson = await createProjectDirectory('/opt/data/ws', 'sub', {
    gatewayUrl: 'https://hermes.example.com',
    lockedRoot: '/opt/data',
    platformBridge: {
      httpProxy: async () => ({ ok: false, error: 'PERMISSION_DENIED' }),
    },
  });
  assert.deepEqual(mkdirErrJson, { ok: false, error: 'PERMISSION_DENIED' });

  // Windows Program Files (x86) 子目录保护与远端重命名悬空符号链接守卫 (-o -L)
  assert.equal(isProtectedRootDirectory('C:/Program Files (x86)/App'), true);
  let capturedCmd = '';
  await renameProjectDirectory('/opt/data/ws/old', 'next', {
    gatewayUrl: 'https://hermes.example.com',
    lockedRoot: '/opt/data',
    execShell: async (cmd) => {
      capturedCmd = cmd;
      return { code: 0, stdout: '', stderr: '' };
    },
  });
  assert.ok(capturedCmd.includes('-o -L'));
});
