/**
 * Hermes Flux Desktop Windows Packaging Automation Script
 * Packages Windows NSIS setup, portable .exe, green zip, or unpacked dir,
 * with fail-closed code-signing verification when `--require-signing` is set.
 */

import { execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertDesktopSigningReady,
  buildWindowsElectronBuilderArgs,
  evaluateWindowsAuthenticodeChecks,
  isDesktopSigningRequired,
  parseWinPackagerArgs,
  resolveWindowsPackagerEnv,
  resolveWindowsSigningStatus,
} from './desktop-signing-config.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const repoRoot = path.resolve(rootDir, '../..');

process.env.ELECTRON_MIRROR = process.env.ELECTRON_MIRROR || 'https://npmmirror.com/mirrors/electron/';
process.env.ELECTRON_BUILDER_BINARIES_MIRROR =
  process.env.ELECTRON_BUILDER_BINARIES_MIRROR || 'https://npmmirror.com/mirrors/electron-builder-binaries/';

const args = process.argv.slice(2);
const { isDirOnly, isDryRun, targetMode } = parseWinPackagerArgs(args);

const env = { ...process.env };
const signingRequired = isDesktopSigningRequired({ platform: 'windows', argv: args, env });
const signingStatus = resolveWindowsSigningStatus({ env });
const readiness = assertDesktopSigningReady({
  platform: 'windows',
  status: signingStatus,
  required: signingRequired,
});

console.log('[Hermes Flux Windows Packager]');
console.log(`  Target Platform: Windows x64 (${targetMode})`);

if (!readiness.ok) {
  console.error(`\n✖ ${readiness.error}\n`);
  process.exit(1);
}

if (signingStatus.mode === 'unsigned') {
  console.warn('\n====================================================================');
  console.warn('! WARNING [desktop:package:win]: 未配置 Windows 代码签名凭据');
  console.warn(`! 缺失项: ${signingStatus.missingFields.join(', ')}`);
  console.warn('! 生成的 .exe 将触发 SmartScreen“Windows 已保护你的电脑 / 未知发布者”告警。');
  console.warn('! 若需阻断未签名正式包，请使用 --require-signing 或 npm run package:desktop:win:release');
  console.warn('====================================================================\n');
} else {
  console.log(`  [win:package] Code signing: ${signingStatus.mode} (${signingStatus.source})`);
  if (signingStatus.installWarning) {
    console.warn(`  ! [win:package] 提示: ${signingStatus.installWarning}`);
  }
}

if (isDryRun) {
  console.log('  [win:package] --dry-run 模式：已完成签名配置与前置检查，未执行构建。');
  process.exit(0);
}

// 1. Ensure workspace core -> ui -> desktop bundles are freshly compiled (safe on clean checkout)
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

console.log('[Hermes Flux Windows Packager] Invoking electron-builder for win-x64...');

let outputDir = path.join(rootDir, 'release/app-win');
try {
  if (fs.existsSync(outputDir)) {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
} catch (_e) {
  // ignore lock cleanup errors; rotated dir handles Windows EBUSY below
}
if (fs.existsSync(outputDir)) {
  outputDir = path.join(rootDir, `release/app-win-${Date.now()}`);
}

const builderArgs = buildWindowsElectronBuilderArgs({
  outputDir,
  targetMode,
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

const builderEnv = resolveWindowsPackagerEnv({
  ...env,
  NODE_OPTIONS: '--max-old-space-size=8192',
});

const builderRes = spawnSync(process.execPath, [electronBuilderCli, ...builderArgs], {
  cwd: rootDir,
  stdio: 'inherit',
  env: builderEnv,
});

if (builderRes.error || builderRes.status !== 0) {
  console.error(`electron-builder exited with code ${builderRes.status}`);
  process.exit(builderRes.status || 1);
}

const unpackedDir = path.join(outputDir, 'win-unpacked');
const mainExe = path.join(unpackedDir, 'Hermes Flux.exe');

// 2. Post-build Authenticode verification on Windows hosts when signed
if (process.platform === 'win32' && signingStatus.mode !== 'unsigned') {
  const candidates = fs
    .readdirSync(outputDir)
    .filter((f) => f.toLowerCase().endsWith('.exe'))
    .map((f) => path.join(outputDir, f));
  if (fs.existsSync(mainExe)) candidates.push(mainExe);

  const checkResults = [];
  for (const exePath of candidates) {
    const escapedPath = exePath.replace(/'/g, "''");
    const psRes = spawnSync(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$sig = Get-AuthenticodeSignature -FilePath '${escapedPath}'; Write-Output ($sig.Status.ToString() + '|' + ($sig.SignerCertificate.Subject))`,
      ],
      { encoding: 'utf8' },
    );
    const out = (psRes.stdout || '').trim();
    const [rawStatus = '', subject = ''] = out.split('|');
    const status = rawStatus.trim() || 'Unknown';
    console.log(`  [win:package] Authenticode (${path.basename(exePath)}): ${status}${subject ? ` [${subject}]` : ''}`);
    checkResults.push({
      file: exePath,
      exitCode: psRes.status ?? 1,
      error: psRes.error,
      stdout: psRes.stdout || '',
    });
  }

  const checkSummary = evaluateWindowsAuthenticodeChecks({
    results: checkResults,
    signingRequired,
  });
  if (!checkSummary.ok) {
    console.error(`\n✖ ${checkSummary.error}\n`);
    process.exit(1);
  }
}

// 3. Generate portable zip archive from win-unpacked for default zip mode
if (targetMode === 'zip' && fs.existsSync(unpackedDir)) {
  console.log('\n[Hermes Flux Windows Packager] Compressing win-unpacked into portable green package...');
  const zipOutput = path.join(rootDir, 'release/Hermes-Flux-0.1.0-win-x64-portable.zip');
  const zipScript = path.join(rootDir, 'scripts/make-zip.py');

  try {
    const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
    execSync(`"${pythonCmd}" "${zipScript}" "${unpackedDir}" "${zipOutput}"`, { stdio: 'inherit' });
  } catch (err) {
    console.warn('Zip creation failed:', err);
  }
}

console.log('\n======================================================');
console.log('✔ Hermes Flux Desktop Windows delivery build ready!');
if (fs.existsSync(mainExe)) {
  console.log(`  1. Unpacked Binary: ${mainExe}`);
}
if (targetMode === 'zip') {
  console.log(`  2. Portable Green Zip: ${path.join(rootDir, 'release/Hermes-Flux-0.1.0-win-x64-portable.zip')}`);
} else {
  console.log(`  2. Output Directory: ${outputDir}`);
}
console.log('======================================================\n');
