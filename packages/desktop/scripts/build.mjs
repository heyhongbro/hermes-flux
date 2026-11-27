/**
 * Hermes Flux Desktop Fast esbuild Pipeline
 */

import esbuild from 'esbuild';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

/**
 * 校验 workspace 包的 dist 不比源码陈旧。
 *
 * 【设计意图 (Why)】入口 bundle 现在从 `@hermes-flux/core` / `@hermes-flux/ui` 的 dist
 *   解析依赖（构建脚本第 3 步会注明原因）。而 `desktop run start` 与打包脚本只跑本文件、
 *   不会重建 core/ui：改了 core 源码却直接打包，会把过期实现静默打进产物，
 *   现象是"改了代码但运行时没变"。这里把它变成一次明确失败。
 *
 * 【约束与规则 (Rules)】只比 mtime，不做内容哈希；分不出差异时宁可放行也不误报。
 */
function assertWorkspaceDistFresh(pkgName) {
  const pkgRoot = path.join(rootDir, '..', pkgName);
  const distEntry = path.join(pkgRoot, 'dist/index.js');
  if (!fs.existsSync(distEntry)) {
    throw new Error(`[Hermes Flux Build] 缺少 ${pkgName}/dist/index.js：请先执行 npm run build:core && npm run build:ui`);
  }
  const distMtime = fs.statSync(distEntry).mtimeMs;
  let newest = 0;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(entry.name)) continue;
      const mtime = fs.statSync(abs).mtimeMs;
      if (mtime > newest) newest = mtime;
    }
  };
  const srcDir = path.join(pkgRoot, 'src');
  if (fs.existsSync(srcDir)) walk(srcDir);
  if (newest > distMtime) {
    throw new Error(
      `[Hermes Flux Build] ${pkgName} 的 dist 落后于源码：请先执行 npm run build:core && npm run build:ui`,
    );
  }
}

async function runBoundedPool(tasks, workerCount) {
  let cursor = 0;
  async function worker() {
    while (cursor < tasks.length) {
      const task = tasks[cursor++];
      await esbuild.build(task);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(workerCount, tasks.length) }, () => worker()),
  );
}

function copyIfChanged(src, dst, force = false) {
  if (!force && fs.existsSync(dst)) {
    const srcStat = fs.statSync(src);
    const dstStat = fs.statSync(dst);
    if (srcStat.size === dstStat.size && srcStat.mtimeMs <= dstStat.mtimeMs) {
      return false;
    }
  }
  fs.copyFileSync(src, dst);
  return true;
}

function getNewestMtime(dir, extRe) {
  let newest = 0;
  if (!fs.existsSync(dir)) return newest;
  const walk = (cur) => {
    for (const entry of fs.readdirSync(cur, { withFileTypes: true })) {
      const abs = path.join(cur, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!extRe.test(entry.name)) continue;
      const mtime = fs.statSync(abs).mtimeMs;
      if (mtime > newest) newest = mtime;
    }
  };
  walk(dir);
  return newest;
}

function isTailwindUpToDate(repoDir, outCssPath, force = false) {
  if (force || !fs.existsSync(outCssPath)) return false;
  const outStat = fs.statSync(outCssPath);
  if (outStat.size <= 0) return false;

  const entryFile = path.join(repoDir, 'packages/ui/src/tailwind-entry.css');
  let newestInput = fs.existsSync(entryFile) ? fs.statSync(entryFile).mtimeMs : 0;
  newestInput = Math.max(
    newestInput,
    getNewestMtime(path.join(repoDir, 'packages/ui/src'), /\.(ts|tsx|css)$/),
    getNewestMtime(path.join(repoDir, 'packages/desktop/src/renderer'), /\.(ts|tsx|html|css)$/),
  );
  return newestInput <= outStat.mtimeMs;
}

async function buildAll() {
  const forceFullBuild = process.env.FORCE_FULL_BUILD === '1';
  console.log(`[Hermes Flux Build] Starting esbuild compilation${forceFullBuild ? ' (FORCE_FULL_BUILD=1)' : ''}...`);
  const startTime = Date.now();

  assertWorkspaceDistFresh('core');
  assertWorkspaceDistFresh('ui');

  // Ensure base dist renderer directory exists before Tailwind CLI writes tailwind.css
  fs.mkdirSync(path.join(rootDir, 'dist/renderer'), { recursive: true });

  // Tailwind v4 从 UI 组件源码扫描类名，并保留皮肤变量的运行时解析。
  // 设计意图(Why)：跨包管理器稳健的调用方式是直接 spawn CLI 的 JS 入口，不依赖 .bin shim 的平台后缀。
  // 防范的历史坑(Pitfall)：初版写死根 node_modules/.bin/tailwindcss.cmd，该路径在本仓库布局下根本不存在，build 必炸。
  const repoDir = path.resolve(rootDir, '..', '..');
  const tailwindOutCss = path.join(rootDir, 'dist/renderer/tailwind.css');
  if (isTailwindUpToDate(repoDir, tailwindOutCss, forceFullBuild)) {
    console.log('  ✔ Tailwind design tokens up-to-date (skipped)');
  } else {
    const tailwindCliCandidates = [
      path.join(repoDir, 'packages', 'ui', 'node_modules', '@tailwindcss', 'cli', 'dist', 'index.mjs'),
      path.join(repoDir, 'node_modules', '@tailwindcss', 'cli', 'dist', 'index.mjs'),
    ];
    const tailwindCli = tailwindCliCandidates.find((p) => fs.existsSync(p));
    if (!tailwindCli) throw new Error('未找到 @tailwindcss/cli 入口，请先在仓库根执行 npm ci');
    const tailwind = spawnSync(process.execPath, [
      tailwindCli,
      '-i', path.join(repoDir, 'packages/ui/src/tailwind-entry.css'),
      '-o', tailwindOutCss,
      '--minify',
    ], { cwd: repoDir, encoding: 'utf8' });
    if (tailwind.error || tailwind.signal || tailwind.status !== 0) {
      const detail = tailwind.error?.message || tailwind.signal || tailwind.stderr || `exit ${tailwind.status}`;
      throw new Error(`Tailwind CSS build failed: ${detail}`);
    }
    console.log('  ✔ Tailwind design tokens compiled');
  }

  /**
   * 独立产物共享的运行时外部依赖。
   *
   * 【设计意图 (Why)】两个理由必须同时成立：
   *   1. 打进产物会把 React 的 CJS 依赖塞进 ESM，Node 直接 import 就炸 "Dynamic require of util"；
   *   2. 内联后同一份 core 源码会出现在多个产物的 sourcemap 里，增量覆盖率按「源文件 + 行」
   *      累加分支，某个 bundle 未执行的分支会把已测分支压成未覆盖（实测：botManagementController
   *      内联副本曾让 slidingWatchdog 的一条已测分支长期报红）。
   */
  const SHARED_RUNTIME_EXTERNALS = ['@hermes-flux/core', '@hermes-flux/ui'];
  const nodeModuleTask = (entryRel, outRel, external = SHARED_RUNTIME_EXTERNALS) => ({
    entryPoints: [path.join(rootDir, entryRel)],
    outfile: path.join(rootDir, outRel),
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'esm',
    ...(external ? { external } : {}),
    sourcemap: true,
  });

  const esbuildTasks = [
    // 1. Build Main Process
    {
      entryPoints: [path.join(rootDir, 'src/main/index.ts')],
      outfile: path.join(rootDir, 'dist/main/index.js'),
      bundle: true,
      platform: 'node',
      target: 'node20',
      format: 'cjs',
      external: ['electron'],
      sourcemap: true,
    },
    // 2. Build Preload Script
    {
      entryPoints: [path.join(rootDir, 'src/preload/index.ts')],
      outfile: path.join(rootDir, 'dist/preload/index.js'),
      bundle: true,
      platform: 'node',
      target: 'node20',
      format: 'cjs',
      external: ['electron'],
      sourcemap: true,
    },
    // 3. Build Renderer Script
    {
      entryPoints: [path.join(rootDir, 'src/renderer/index.ts')],
      outfile: path.join(rootDir, 'dist/renderer/index.js'),
      bundle: true,
      platform: 'browser',
      target: 'es2022',
      format: 'esm',
      sourcemap: true,
      // 【设计意图 (Why)】React 的 development 构建会保留 DevTools 提示、双调用 render 与额外校验，
      // 实测会把一次会话切换的渲染成本放大近一倍。桌面产物默认走 production，
      // 需要调试 React 警告时用 NODE_ENV=development 重新构建即可。
      define: {
        'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV === 'development' ? 'development' : 'production'),
      },
      /**
       * 【跨包依赖走编译产物 (Why)】core / ui 直接以源码内联时，入口 bundle 的 sourcemap
       *   会把整棵 core/ui 源树再映射一次；增量覆盖率按「源文件 + 行」累加分支，
       *   入口里未执行的函数会给已测分支贡献一条 taken=0，门禁因此对同一行反复报红
       *   （实测 renderer/index.js 让 slidingWatchdog 的一条已覆盖分支长期判红）。
       *   这里改用一份不带 `paths` 的运行时 tsconfig：`@hermes-flux/*` 按包入口解析到
       *   各自 dist，映射落点不再指向 src；运行时语义不变。
       * 【约束与规则 (Rules)】该 tsconfig 只服务入口 bundle，
       *   类型检查仍以 tsconfig.json 的唯一真值为准，禁止在运行时配置里加 paths。
       */
      tsconfig: path.join(rootDir, 'tsconfig.runtime.json'),
      /**
       * 【切断对上游 sourcemap 的追溯 (Why)】esbuild 会读取输入文件末尾的
       *   `//# sourceMappingURL=`，并把映射一路追回 core/ui 的 src。
       *   入口 bundle 因此再次映射整棵跨包源树，未执行函数的分支会给已测分支贡献 taken=0。
       *   剥掉这一行注释后，映射落点停在 dist 文件本身，门禁不再按 src 重复计数。
       */
      plugins: [
        {
          name: 'strip-upstream-sourcemap-comment',
          setup(build) {
            build.onLoad({ filter: /packages[\\/](core|ui)[\\/]dist[\\/].*\.js$/ }, (args) => ({
              contents: fs.readFileSync(args.path, 'utf8').replace(/\/\/# sourceMappingURL=.*$/m, ''),
              loader: 'js',
            }));
          },
        },
      ],
    },
    // 3.1 Build Message Actions Module (for runtime & test execution)
    nodeModuleTask('src/renderer/messageActions.ts', 'dist/renderer/messageActions.mjs', null),

    // 3b. 交互区纯逻辑模块（回滚事务 + 工具补丁队列 + 热路径模块）
    ...['rollbackTransaction', 'toolPatchQueue', 'conversationPush', 'settingsController'].map((name) =>
      nodeModuleTask(`src/renderer/${name}.ts`, `dist/renderer/${name}.mjs`),
    ),
    ...[
      'messageWindow',
      'profileRefresh',
      'promptNavigator',
      'coldStartFocus',
      'providerAdminController',
      'providerAdminRest',
      'learningRest',
      'providerCatalog',
      'gatewayConnection',
      'queueControl',
      'slashVisibility',
      'botManagementController',
      'scrollEndController',
    ].map((moduleName) => nodeModuleTask(`src/renderer/${moduleName}.ts`, `dist/renderer/${moduleName}.mjs`)),

    // 主进程单测独立产物
    nodeModuleTask('src/main/cookieHeader.ts', 'dist/main/cookieHeader.mjs', null),
    nodeModuleTask('src/main/workspaceFs.ts', 'dist/main/workspaceFs.mjs', null),
    nodeModuleTask('src/main/mediaStreamProtocol.ts', 'dist/main/mediaStreamProtocol.mjs', ['@hermes-flux/core']),
    nodeModuleTask('src/main/previewProtocol.ts', 'dist/main/previewProtocol.mjs', ['@hermes-flux/core']),
    nodeModuleTask('src/main/powerEvents.ts', 'dist/main/powerEvents.mjs', null),
    nodeModuleTask('src/main/windowControl.ts', 'dist/main/windowControl.mjs', null),
    {
      entryPoints: [path.join(rootDir, 'src/main/ipc.ts')],
      outfile: path.join(rootDir, 'dist/main/ipc.cjs'),
      bundle: true,
      platform: 'node',
      target: 'node20',
      format: 'cjs',
      external: ['electron'],
      sourcemap: true,
    },

    // transcriptRows 等多入口单测产物
    {
      entryPoints: [
        path.join(rootDir, 'src/renderer/transcriptRows.ts'),
        path.join(rootDir, 'src/renderer/slashCatalog.ts'),
        path.join(rootDir, 'src/renderer/mentionToken.ts'),
      ],
      outdir: path.join(rootDir, 'dist/renderer'),
      outExtension: { '.js': '.mjs' },
      bundle: true,
      platform: 'node',
      target: 'node20',
      format: 'esm',
      external: ['@hermes-flux/ui', '@hermes-flux/core'],
      sourcemap: true,
    },

    // 持久化领域模块
    nodeModuleTask('src/renderer/persistence/persistedJson.ts', 'dist/renderer/persistence/persistedJson.mjs', null),
    nodeModuleTask('src/renderer/persistence/botActivityStore.ts', 'dist/renderer/persistence/botActivityStore.mjs'),
    nodeModuleTask('src/renderer/persistence/sessionDrafts.ts', 'dist/renderer/persistence/sessionDrafts.mjs', null),

    // 各子领域控制器与管理器
    nodeModuleTask('src/renderer/completion/inputCompletion.ts', 'dist/renderer/completion/inputCompletion.mjs', ['@hermes-flux/ui', '@hermes-flux/core']),
    nodeModuleTask('src/renderer/cache/desktopCacheBridge.ts', 'dist/renderer/cache/desktopCacheBridge.mjs'),
    nodeModuleTask('src/renderer/presence/agentPresenceManager.ts', 'dist/renderer/presence/agentPresenceManager.mjs'),
    nodeModuleTask('src/renderer/navigation/promptNavigatorManager.ts', 'dist/renderer/navigation/promptNavigatorManager.mjs'),
    nodeModuleTask('src/renderer/cascade/modelCascadeManager.ts', 'dist/renderer/cascade/modelCascadeManager.mjs'),
    nodeModuleTask('src/renderer/viewport/streamViewportManager.ts', 'dist/renderer/viewport/streamViewportManager.mjs'),
    nodeModuleTask('src/renderer/viewport/postCommitPinObservers.ts', 'dist/renderer/viewport/postCommitPinObservers.mjs'),

    // 桌面壳视口装配：外部化 ./streamViewportManager.mjs 防止重复进入覆盖率分支计数
    {
      entryPoints: [path.join(rootDir, 'src/renderer/viewport/desktopStreamViewport.ts')],
      outfile: path.join(rootDir, 'dist/renderer/viewport/desktopStreamViewport.mjs'),
      bundle: true,
      platform: 'node',
      target: 'node20',
      format: 'esm',
      external: SHARED_RUNTIME_EXTERNALS,
      sourcemap: true,
      plugins: [{
        name: 'external-stream-viewport-manager',
        setup(pluginBuild) {
          pluginBuild.onResolve({ filter: /^\.\/streamViewportManager\.js$/ }, () => ({
            path: './streamViewportManager.mjs',
            external: true,
          }));
        },
      }],
    },

    // 状态、左轨、检查舱、弹窗、输入与服务层
    nodeModuleTask('src/renderer/leftrail/leftRailSnapshotManager.ts', 'dist/renderer/leftrail/leftRailSnapshotManager.mjs'),
    nodeModuleTask('src/renderer/state/appState.ts', 'dist/renderer/state/appState.mjs'),
    nodeModuleTask('src/renderer/inspector/inspectorController.ts', 'dist/renderer/inspector/inspectorController.mjs'),
    nodeModuleTask('src/renderer/events/leftRailController.ts', 'dist/renderer/events/leftRailController.mjs'),
    nodeModuleTask('src/renderer/events/presenceController.ts', 'dist/renderer/events/presenceController.mjs'),
    nodeModuleTask('src/renderer/events/modalInteractionController.ts', 'dist/renderer/events/modalInteractionController.mjs'),
    nodeModuleTask('src/renderer/events/inputDockController.ts', 'dist/renderer/events/inputDockController.mjs'),
    nodeModuleTask('src/renderer/events/slashCommandRunner.ts', 'dist/renderer/events/slashCommandRunner.mjs'),
    nodeModuleTask('src/renderer/services/sessionOperationService.ts', 'dist/renderer/services/sessionOperationService.mjs'),
    nodeModuleTask('src/renderer/services/messageLoadingService.ts', 'dist/renderer/services/messageLoadingService.mjs'),
    nodeModuleTask('src/renderer/services/turnExecutionService.ts', 'dist/renderer/services/turnExecutionService.mjs'),
    nodeModuleTask('src/renderer/gateway/gatewayEventDispatcher.ts', 'dist/renderer/gateway/gatewayEventDispatcher.mjs'),
    nodeModuleTask('src/renderer/messageWindowManager.ts', 'dist/renderer/messageWindowManager.mjs'),
    nodeModuleTask('src/renderer/services/foregroundSyncCoordinator.ts', 'dist/renderer/services/foregroundSyncCoordinator.mjs'),
    nodeModuleTask('src/renderer/renderCoordinator.ts', 'dist/renderer/renderCoordinator.mjs'),
    nodeModuleTask('src/renderer/inspectorDomHelper.ts', 'dist/renderer/inspectorDomHelper.mjs'),

    // 移动端表现壳薄协调适配器与 Capacitor 原生桥独立产物
    nodeModuleTask('src/renderer/mobile/mobileShellCoordinator.ts', 'dist/renderer/mobile/mobileShellCoordinator.mjs'),
    {
      entryPoints: [path.join(repoDir, 'packages/mobile/src/capacitor-bridge.ts')],
      outfile: path.join(repoDir, 'packages/mobile/dist/capacitor-bridge.mjs'),
      bundle: true,
      platform: 'node',
      target: 'node20',
      format: 'esm',
      external: ['@capacitor/*'],
      sourcemap: true,
    },

    // 模型下拉与全局热键控制器
    nodeModuleTask('src/renderer/dropdownKeybindController.ts', 'dist/renderer/dropdownKeybindController.mjs'),

    // Batch 6 服务
    ...[
      'projectOperationService',
      'projectDirectoryActions',
      'groupOperationService',
      'profileManagementService',
      'settingsDataService',
      'learningService',
      'sessionStatusService',
      'statusIntegration',
      'conversationOrgCoordinator',
      'interactivePromptService',
      'mcpOAuthService',
    ].map((serviceName) =>
      nodeModuleTask(`src/renderer/services/${serviceName}.ts`, `dist/renderer/services/${serviceName}.mjs`),
    ),

    // Batch 7 服务与控制器
    nodeModuleTask('src/renderer/interactiveWiring.ts', 'dist/renderer/interactiveWiring.mjs'),
    nodeModuleTask('src/renderer/services/fileViewerService.ts', 'dist/renderer/services/fileViewerService.mjs'),
    nodeModuleTask('src/renderer/services/previewAssetCoordinator.ts', 'dist/renderer/services/previewAssetCoordinator.mjs'),
    nodeModuleTask('src/renderer/services/mediaResolver.ts', 'dist/renderer/services/mediaResolver.mjs'),
    nodeModuleTask('src/renderer/titlebarController.ts', 'dist/renderer/titlebarController.mjs'),
    nodeModuleTask('src/renderer/bootstrap/appBootstrap.ts', 'dist/renderer/bootstrap/appBootstrap.mjs'),
    nodeModuleTask('src/renderer/events/conversationStreamController.ts', 'dist/renderer/events/conversationStreamController.mjs'),
    nodeModuleTask('src/renderer/events/onboardingController.ts', 'dist/renderer/events/onboardingController.mjs'),
    nodeModuleTask('src/renderer/stream/tokenStreamWriter.ts', 'dist/renderer/stream/tokenStreamWriter.mjs'),
    nodeModuleTask('src/renderer/stream/streamDomOwnership.ts', 'dist/renderer/stream/streamDomOwnership.mjs'),
  ];

  // 启动并行 esbuild 池前统一预建全部唯一输出目录，避免并发写同目录时竞争建目录
  const outDirs = new Set(
    esbuildTasks.map((task) => (task.outfile ? path.dirname(task.outfile) : task.outdir)),
  );
  for (const dir of outDirs) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const concurrency = Math.max(4, Math.min(8, os.availableParallelism?.() ?? os.cpus().length ?? 4));
  await runBoundedPool(esbuildTasks, concurrency);
  console.log(`  ✔ ${esbuildTasks.length} esbuild bundles compiled (concurrency=${concurrency})`);

  // 4. Copy static assets incrementally
  copyIfChanged(
    path.join(rootDir, 'src/renderer/index.html'),
    path.join(rootDir, 'dist/renderer/index.html'),
    forceFullBuild,
  );
  copyIfChanged(
    path.join(rootDir, 'src/renderer/styles.css'),
    path.join(rootDir, 'dist/renderer/styles.css'),
    forceFullBuild,
  );

  // 对话区、右侧状态栏与移动端壳样式资产来自 UI 包，供 desktop 与 web/mobile 共用。
  copyIfChanged(
    path.join(repoDir, 'packages', 'ui', 'src', 'styles', 'conversation.css'),
    path.join(rootDir, 'dist/renderer', 'conversation.css'),
    forceFullBuild,
  );
  copyIfChanged(
    path.join(repoDir, 'packages', 'ui', 'src', 'styles', 'status-pod.css'),
    path.join(rootDir, 'dist/renderer', 'status-pod.css'),
    forceFullBuild,
  );
  copyIfChanged(
    path.join(repoDir, 'packages', 'ui', 'src', 'styles', 'mobile-shell.css'),
    path.join(rootDir, 'dist/renderer', 'mobile-shell.css'),
    forceFullBuild,
  );

  // 模型厂商图标资产同样来自 UI 包：组件以 `icons/lobe/<slug>.svg` 相对 index.html 引用，
  // 因此必须原样落在渲染产物根目录下，桌面（file://）与浏览器直跑（HTTP 静态服务）才都能解析。
  const vendorIconSourceDir = path.join(repoDir, 'packages', 'ui', 'src', 'icons', 'lobe');
  const vendorIconTargetDir = path.join(rootDir, 'dist', 'renderer', 'icons', 'lobe');
  fs.mkdirSync(vendorIconTargetDir, { recursive: true });
  let copiedVendorIcons = 0;
  let skippedVendorIcons = 0;
  for (const name of fs.readdirSync(vendorIconSourceDir)) {
    if (!name.endsWith('.svg')) continue;
    if (copyIfChanged(path.join(vendorIconSourceDir, name), path.join(vendorIconTargetDir, name), forceFullBuild)) {
      copiedVendorIcons += 1;
    } else {
      skippedVendorIcons += 1;
    }
  }
  // 【规则】MIT 要求所有副本随附许可声明：图标资产进了分发产物，LICENSE 必须同行，
  // 否则安装包里只有一堆无出处的品牌矢量图。
  const vendorIconLicense = path.join(vendorIconSourceDir, 'LICENSE');
  if (!fs.existsSync(vendorIconLicense)) throw new Error('缺少 lobe 图标 LICENSE，禁止在无许可声明的情况下分发品牌资产');
  copyIfChanged(vendorIconLicense, path.join(vendorIconTargetDir, 'LICENSE'), forceFullBuild);
  console.log(`  ✔ Model vendor icons ready (${copiedVendorIcons} copied, ${skippedVendorIcons} cached; +LICENSE)`);

  // 品牌折纸雨燕矢量资产与 favicon 拷贝到渲染产物根目录 icons/brand/（desktop 与 mobile 共用）。
  const brandIconSourceDir = path.join(repoDir, 'packages', 'ui', 'src', 'icons', 'brand');
  const brandIconTargetDir = path.join(rootDir, 'dist', 'renderer', 'icons', 'brand');
  fs.mkdirSync(brandIconTargetDir, { recursive: true });
  let copiedBrandIcons = 0;
  let skippedBrandIcons = 0;
  for (const name of fs.readdirSync(brandIconSourceDir)) {
    if (!name.endsWith('.svg') && !name.endsWith('.png')) continue;
    if (copyIfChanged(path.join(brandIconSourceDir, name), path.join(brandIconTargetDir, name), forceFullBuild)) {
      copiedBrandIcons += 1;
    } else {
      skippedBrandIcons += 1;
    }
  }
  console.log(`  ✔ Brand identity assets ready (${copiedBrandIcons} copied, ${skippedBrandIcons} cached)`);

  // 字体清单由 scripts/font-manifest.json 提供（与 tokens/fonts.ts 的 source 字段一一对应）。
  // 只拷贝 latin 子集；中文继续走系统字体，避免引入 MB 级 CJK 字重。
  const fontTargetDir = path.join(rootDir, 'dist/renderer/fonts');
  fs.mkdirSync(fontTargetDir, { recursive: true });
  const fontManifest = JSON.parse(
    fs.readFileSync(path.join(rootDir, 'scripts', 'font-manifest.json'), 'utf8')
  );
  let copiedFonts = 0;
  let skippedFonts = 0;
  let missingFonts = 0;
  const workspaceRoot = path.resolve(rootDir, '..', '..');
  for (const { packageName, filePrefix, weights } of fontManifest.sources) {
    const localFilesDir = path.join(rootDir, 'node_modules', packageName, 'files');
    const hoistedFilesDir = path.join(workspaceRoot, 'node_modules', packageName, 'files');
    const filesDir = fs.existsSync(localFilesDir) ? localFilesDir : hoistedFilesDir;
    for (const weight of weights) {
      const name = `${filePrefix}-latin-${weight}-normal.woff2`;
      const source = path.join(filesDir, name);
      if (!fs.existsSync(source)) {
        missingFonts += 1;
        continue;
      }
      if (copyIfChanged(source, path.join(fontTargetDir, name), forceFullBuild)) {
        copiedFonts += 1;
      } else {
        skippedFonts += 1;
      }
    }
  }
  console.log(`  ✔ Web fonts ready (${copiedFonts} copied, ${skippedFonts} cached, ${missingFonts} missing)`);

  // 5. Ship the brand icons next to the compiled main process
  const iconDir = path.join(rootDir, 'build');
  const iconTargets = ['icon.ico', 'icon.png'];
  const shippedIcons = iconTargets.filter((name) => fs.existsSync(path.join(iconDir, name)));
  if (shippedIcons.length > 0) {
    fs.mkdirSync(path.join(rootDir, 'dist/build'), { recursive: true });
    for (const name of shippedIcons) {
      copyIfChanged(path.join(iconDir, name), path.join(rootDir, 'dist/build', name), forceFullBuild);
    }
  }
  console.log(`  ✔ Static renderer assets ready (icons: ${shippedIcons.join(', ') || 'none'})`);

  const elapsed = Date.now() - startTime;
  console.log(`[Hermes Flux Build] Compilation complete in ${elapsed}ms`);
}

buildAll().catch((err) => {
  console.error('[Hermes Flux Build] Build failed:', err);
  process.exit(1);
});
