/**
 * 主进程窗口控制纯决策层：三向姿态裁定、标题栏图标语义与各端品牌图标路径解析。
 *
 * 断言口径：直接对纯函数做全姿态/全平台真值表断言，同时核实主进程接线真实存在，不启动 Electron。
 * 守护的不变量：
 *   1) 全屏优先级最高，任何"全屏 + 最大化"叠加都必须只退出全屏，不得触发 unmaximize；
 *   2) 三态决策必须覆盖且互斥，不存在"无所作为"的第四态；
 *   3) 标题栏"还原"图标在全屏与最大化两种姿态下都必须为真；
 *   4) Windows/Linux/macOS 开发态与打包态窗口/Dock 图标路径决策完整，且保留暗色启动防闪背景。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  resolveWindowToggle,
  resolveTitlebarMaximized,
  resolveWindowIconPath,
  resolveMacDockIconPath,
  applyMacDockIcon,
} from '../../dist/main/windowControl.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../../..');

const POSES = [
  { isFullScreen: false, isMaximized: false, expected: 'maximize', label: '普通窗口' },
  { isFullScreen: false, isMaximized: true, expected: 'unmaximize', label: '最大化窗口' },
  { isFullScreen: true, isMaximized: false, expected: 'exit-full-screen', label: '全屏窗口' },
  { isFullScreen: true, isMaximized: true, expected: 'exit-full-screen', label: '全屏且最大化叠加' },
];

test('resolveWindowToggle 四象限真值表：全屏优先且三态互斥', async (t) => {
  for (const pose of POSES) {
    await t.test(`${pose.label} → ${pose.expected}`, () => {
      const decision = resolveWindowToggle({
        isFullScreen: pose.isFullScreen,
        isMaximized: pose.isMaximized,
      });
      assert.equal(decision, pose.expected);
    });
  }
});

test('resolveWindowToggle 变异杀伤力：全屏判定不可被最大化判定吞掉', () => {
  const overlapped = resolveWindowToggle({ isFullScreen: true, isMaximized: true });
  assert.equal(overlapped, 'exit-full-screen');
  assert.notEqual(overlapped, 'unmaximize');
  assert.equal(resolveWindowToggle({ isFullScreen: false, isMaximized: true }), 'unmaximize');
});

test('resolveTitlebarMaximized：全屏与最大化共享"还原"图标语义', async (t) => {
  const cases = [
    { pose: { isFullScreen: false, isMaximized: false }, expected: false, label: '普通窗口' },
    { pose: { isFullScreen: false, isMaximized: true }, expected: true, label: '最大化窗口' },
    { pose: { isFullScreen: true, isMaximized: false }, expected: true, label: '全屏窗口' },
    { pose: { isFullScreen: true, isMaximized: true }, expected: true, label: '全屏且最大化叠加' },
  ];
  for (const item of cases) {
    await t.test(`${item.label} → ${String(item.expected)}`, () => {
      assert.equal(resolveTitlebarMaximized(item.pose), item.expected);
    });
  }
});

test('resolveTitlebarMaximized 变异杀伤力：丢掉全屏项即被抓住', () => {
  assert.equal(resolveTitlebarMaximized({ isFullScreen: true, isMaximized: false }), true);
});

test('退出全屏时序：从最大化态进全屏再退出必须继续呈现"还原"', () => {
  const afterLeaveFromMaximized = resolveTitlebarMaximized({ isFullScreen: false, isMaximized: true });
  assert.equal(afterLeaveFromMaximized, true, '最大化态退出全屏必须保持"还原"图标');

  const afterLeaveFromNormal = resolveTitlebarMaximized({ isFullScreen: false, isMaximized: false });
  assert.equal(afterLeaveFromNormal, false, '普通态退出全屏必须回到"最大化"图标');
  assert.equal(resolveTitlebarMaximized({ isFullScreen: true, isMaximized: false }), true);
});

test('resolveWindowIconPath：Win 用 icon.ico、Linux 用 icon.png、macOS 不传、缺失时返回 undefined', () => {
  const buildDir = path.join('tmp', 'build');
  const winIco = path.join(buildDir, 'icon.ico');
  const linuxPng = path.join(buildDir, 'icon.png');

  assert.equal(
    resolveWindowIconPath({ platform: 'win32', buildDir, fileExists: (p) => p === winIco }),
    winIco,
  );
  assert.equal(
    resolveWindowIconPath({ platform: 'win32', buildDir, fileExists: () => false }),
    undefined,
  );
  assert.equal(
    resolveWindowIconPath({ platform: 'linux', buildDir, fileExists: (p) => p === linuxPng }),
    linuxPng,
  );
  assert.equal(
    resolveWindowIconPath({ platform: 'linux', buildDir, fileExists: () => false }),
    undefined,
  );
  assert.equal(
    resolveWindowIconPath({ platform: 'darwin', buildDir, fileExists: () => true }),
    undefined,
    'macOS 窗口图标由 App Bundle 管理，禁止传入冗余文件图标',
  );
});

test('resolveMacDockIconPath & applyMacDockIcon：仅 macOS 未打包且 icon.png 存在时触发 setIcon', () => {
  const buildDir = path.join('tmp', 'build');
  const dockPng = path.join(buildDir, 'icon.png');

  assert.equal(
    resolveMacDockIconPath({ platform: 'darwin', isPackaged: false, buildDir, fileExists: (p) => p === dockPng }),
    dockPng,
  );
  assert.equal(
    resolveMacDockIconPath({ platform: 'darwin', isPackaged: false, buildDir, fileExists: () => false }),
    undefined,
  );
  assert.equal(
    resolveMacDockIconPath({ platform: 'darwin', isPackaged: true, buildDir, fileExists: () => true }),
    undefined,
  );
  assert.equal(
    resolveMacDockIconPath({ platform: 'win32', isPackaged: false, buildDir, fileExists: () => true }),
    undefined,
  );

  const calls = [];
  const applied = applyMacDockIcon({
    platform: 'darwin',
    isPackaged: false,
    buildDir,
    fileExists: (p) => p === dockPng,
    dock: { setIcon: (p) => calls.push(p) },
  });
  assert.equal(applied, dockPng);
  assert.deepEqual(calls, [dockPng]);

  // dock 缺失或非开发态严禁误调 setIcon
  const skippedCalls = [];
  assert.equal(
    applyMacDockIcon({
      platform: 'darwin',
      isPackaged: false,
      buildDir,
      fileExists: () => true,
      dock: undefined,
    }),
    undefined,
  );
  assert.equal(
    applyMacDockIcon({
      platform: 'darwin',
      isPackaged: true,
      buildDir,
      fileExists: () => true,
      dock: { setIcon: (p) => skippedCalls.push(p) },
    }),
    undefined,
  );
  assert.equal(skippedCalls.length, 0);
});

test('桌面主进程接线守卫：window.ts 与 index.ts 消费纯图标决策函数且保留防闪底色', () => {
  const winSrc = fs.readFileSync(path.join(REPO_ROOT, 'packages/desktop/src/main/window.ts'), 'utf8');
  const mainSrc = fs.readFileSync(path.join(REPO_ROOT, 'packages/desktop/src/main/index.ts'), 'utf8');

  assert.ok(winSrc.includes("resolveWindowIconPath"), 'window.ts 必须调用 resolveWindowIconPath');
  assert.ok(winSrc.includes("path.join(__dirname, '../build')"), 'window.ts 必须指向构建产物中的 build 目录');
  assert.ok(winSrc.includes('icon: resolvedWindowIcon'), 'window.ts 必须将解析图标传入 BrowserWindow');
  assert.ok(winSrc.includes("backgroundColor: '#090A0F'"), 'window.ts 必须维持暗色启动底色避免白屏闪烁');

  assert.ok(mainSrc.includes('applyMacDockIcon'), 'main/index.ts 必须调用 applyMacDockIcon');
  assert.ok(mainSrc.includes('isPackaged: app.isPackaged'), 'main/index.ts 必须将 app.isPackaged 传入 applyMacDockIcon');
  assert.ok(mainSrc.includes("path.join(__dirname, '../build')"), 'main/index.ts 必须指向构建产物中的 build 目录');
  assert.ok(mainSrc.includes('dock: app.dock'), 'main/index.ts 必须注入 app.dock');
});
