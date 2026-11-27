/**
 * Hermes Flux Desktop macOS Packaging & Notarization Script
 * Packages macOS .dmg/.zip (x64 / arm64 / universal) with Developer ID signing,
 * Hardened Runtime, Apple Notarization, and post-build codesign/spctl/stapler verification.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertDesktopSigningReady,
  buildMacElectronBuilderArgs,
  isDesktopSigningRequired,
  parseMacPackagerArgs,
  prepareMacNotarizeEnv,
  resolveMacSigningStatus,
} from './desktop-signing-config.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const repoRoot = path.resolve(rootDir, '../..');

function findMatchingFiles(dir, matcher, results = []) {
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (matcher(entry.name, entry.isDirectory())) {
      results.push(abs);
    } else if (entry.isDirectory()) {
      findMatchingFiles(abs, matcher, results);
    }
  }
  return results;
}

/**
 * 在 `try / finally` 保护下准备临时 `.p8`（若需）并调用 `electron-builder`，确保无论构建成败都必删除临时私钥。
 * 注意：绝不在 `try` 内调用 `process.exit`，以免跳过 `finally` 清理导致磁盘私钥残留。
 */
export function executeMacBuilderWithCleanup({
  env = process.env,
  targetRootDir = rootDir,
  electronBuilderCli,
  builderArgs,
  signingStatus,
  tmpDir,
  spawnFn = spawnSync,
  prepareNotarizeFn = prepareMacNotarizeEnv,
  existsFn = fs.existsSync,
  rmFn = fs.rmSync,
}) {
  let tempAuthKeyPath = '';
  try {
    const preparedNotarize =
      signingStatus?.mode === 'signed-and-notarized'
        ? prepareNotarizeFn({ env, ...(tmpDir ? { tmpDir } : {}) })
        : { env: { ...env }, tempAuthKeyPath: '' };
    tempAuthKeyPath = preparedNotarize.tempAuthKeyPath;

    const builderEnv = {
      ...preparedNotarize.env,
      NODE_OPTIONS: '--max-old-space-size=8192',
    };
    if (signingStatus?.mode === 'unsigned') {
      builderEnv.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
    }

    console.log('[Hermes Flux macOS Packager] Invoking electron-builder...');
    return spawnFn(process.execPath, [electronBuilderCli, ...builderArgs], {
      cwd: targetRootDir,
      stdio: 'inherit',
      env: builderEnv,
    });
  } finally {
    if (tempAuthKeyPath && existsFn(tempAuthKeyPath)) {
      rmFn(tempAuthKeyPath, { force: true });
    }
  }
}

function main() {
  const argv = process.argv.slice(2);
  const { isDirOnly, isDryRun, arch } = parseMacPackagerArgs(argv);

  const env = { ...process.env };
  const signingRequired = isDesktopSigningRequired({ platform: 'macos', argv, env });
  const signingStatus = resolveMacSigningStatus({ env });
  const readiness = assertDesktopSigningReady({
    platform: 'macos',
    status: signingStatus,
    required: signingRequired,
  });

  console.log('[Hermes Flux macOS Packager]');

  if (!readiness.ok) {
    console.error(`\n✖ ${readiness.error}\n`);
    process.exit(1);
  }

  if (signingStatus.mode !== 'signed-and-notarized') {
    console.warn('\n====================================================================');
    console.warn(`! WARNING [desktop:package:mac]: 当前签名/公证状态为 ${signingStatus.mode}`);
    console.warn(`! 缺失项: ${signingStatus.missingFields.join(', ')}`);
    console.warn(`! ${signingStatus.installWarning}`);
    console.warn('! 若需阻断未签名或未公证正式包，请使用 --require-signing 或 npm run package:desktop:mac:release');
    console.warn('====================================================================\n');
  } else {
    console.log(
      `  [mac:package] Signing & Notarization ready: signing=${signingStatus.signingMethod}, notarize=${signingStatus.notarizeMethod}`,
    );
  }

  if (isDryRun) {
    console.log('  [mac:package] --dry-run 模式：已完成签名与公证配置检查，未执行构建。');
    process.exit(0);
  }

  if (process.platform !== 'darwin') {
    console.error('\n✖ [mac:package] macOS 代码签名、公证与 DMG 打包必须在 macOS（darwin）主机上执行。');
    console.error('  可使用 .env 中的 MAC_RUNNER_SSH 远端 Mac 节点或 GitHub Actions release-build.yml (macos-latest)。');
    console.error('  详情请见 docs/testing/cross-platform-release-signing.md\n');
    process.exit(1);
  }

  // Ensure workspace core -> ui -> desktop bundles are freshly compiled (safe on clean checkout)
  const tscCliCandidates = [
    path.join(repoRoot, 'node_modules/typescript/bin/tsc'),
    path.join(rootDir, 'node_modules/typescript/bin/tsc'),
  ];
  const tscCli = tscCliCandidates.find((p) => fs.existsSync(p));
  if (!tscCli) {
    console.error('✖ 找不到 TypeScript CLI 入口，请先在仓库根执行 npm ci');
    process.exit(1);
  }
  const tscRes = spawnSync(
    process.execPath,
    [tscCli, '--build', 'packages/core/tsconfig.json', 'packages/ui/tsconfig.json'],
    { cwd: repoRoot, stdio: 'inherit', env },
  );
  if (tscRes.error || tscRes.status !== 0) {
    console.error(`Core/UI TypeScript build failed with code ${tscRes.status}`);
    process.exit(tscRes.status || 1);
  }

  const buildRes = spawnSync(process.execPath, ['scripts/build.mjs'], {
    cwd: rootDir,
    stdio: 'inherit',
    env,
  });
  if (buildRes.error || buildRes.status !== 0) {
    console.error(`Build failed with code ${buildRes.status}`);
    process.exit(buildRes.status || 1);
  }

  const outputDir = path.join(rootDir, 'release/app-mac');
  fs.rmSync(outputDir, { recursive: true, force: true });

  const builderArgs = buildMacElectronBuilderArgs({
    outputDir,
    isDirOnly,
    arch,
    signingStatus,
    requireSigning: signingRequired,
  });

  const electronBuilderCliCandidates = [
    path.join(repoRoot, 'node_modules/electron-builder/out/cli/cli.js'),
    path.join(rootDir, 'node_modules/electron-builder/out/cli/cli.js'),
  ];
  const electronBuilderCli = electronBuilderCliCandidates.find((p) => fs.existsSync(p));
  if (!electronBuilderCli) {
    console.error('✖ 找不到 electron-builder CLI 入口，请先在仓库根执行 npm ci');
    process.exit(1);
  }

  const builderRes = executeMacBuilderWithCleanup({
    env,
    targetRootDir: rootDir,
    electronBuilderCli,
    builderArgs,
    signingStatus,
  });

  if (builderRes?.error || builderRes?.status !== 0) {
    console.error(`electron-builder exited with code ${builderRes?.status}`);
    process.exit(builderRes?.status || 1);
  }

  if (signingStatus.mode !== 'unsigned') {
    const apps = findMatchingFiles(outputDir, (name, isDir) => isDir && name.endsWith('.app'));
    if (apps.length === 0) {
      console.error(`\n✖ [mac:package] 未找到已打包的 .app 产物用于校验签名 (${outputDir})\n`);
      process.exit(1);
    }
    for (const appPath of apps) {
      console.log(`  [mac:package] Verifying codesign: ${appPath}`);
      const cs = spawnSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath], {
        stdio: 'inherit',
      });
      if (cs.error || cs.status !== 0) {
        console.error(`\n✖ [mac:package] codesign 校验失败: ${appPath}\n`);
        process.exit(1);
      }
      if (signingStatus.mode === 'signed-and-notarized') {
        console.log(`  [mac:package] Assessing Gatekeeper / notarization ticket: ${appPath}`);
        const spctl = spawnSync('spctl', ['--assess', '--type', 'execute', '--verbose', appPath], {
          stdio: 'inherit',
        });
        if (spctl.error || spctl.status !== 0) {
          console.error(`\n✖ [mac:package] Gatekeeper spctl 校验失败: ${appPath}\n`);
          process.exit(1);
        }
        console.log(`  [mac:package] Validating stapled app ticket: ${appPath}`);
        const stapler = spawnSync('xcrun', ['stapler', 'validate', appPath], { stdio: 'inherit' });
        if (stapler.error || stapler.status !== 0) {
          console.error(`\n✖ [mac:package] xcrun stapler validate 失败: ${appPath}\n`);
          process.exit(1);
        }
      }
    }
  }

  console.log('\n======================================================');
  console.log('✔ Hermes Flux Desktop macOS delivery build ready!');
  console.log(`  Output Directory: ${outputDir}`);
  console.log('======================================================\n');
}

function isMainEntry() {
  if (!process.argv[1]) return false;
  const entry = path.resolve(process.argv[1]);
  if (!fs.existsSync(entry)) return false;
  return fs.realpathSync(entry) === fs.realpathSync(__filename);
}

if (isMainEntry()) {
  main();
}
