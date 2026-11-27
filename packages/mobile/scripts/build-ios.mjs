import { execSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertIosSigningReady,
  buildIosXcodebuildArgs,
  isIosSigningRequired,
  parseIosBuildArgs,
  prepareIosApiKeyPath,
  renderIosExportOptionsPlist,
  resolveIosSigningStatus,
} from './ios-signing-config.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const mobileRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(mobileRoot, '../..');
const iosDir = path.join(mobileRoot, 'ios');

const argv = process.argv.slice(2);
const { isDryRun, exportMethodOverride } = parseIosBuildArgs(argv);

const env = { ...process.env };
const signingRequired = isIosSigningRequired({ argv, env });
const signingStatus = resolveIosSigningStatus({ iosDir, env, exportMethodOverride });
const readiness = assertIosSigningReady({ status: signingStatus, required: signingRequired });

console.log('[Hermes Flux Mobile iOS Builder]');

if (!readiness.ok) {
  console.error(`\n✖ ${readiness.error}\n`);
  process.exit(1);
}

if (signingStatus.mode === 'unsigned') {
  console.warn('\n====================================================================');
  console.warn('! WARNING [ios:build]: 未配置 Apple Developer Team / 签名凭据');
  console.warn(`! 缺失项: ${signingStatus.missingFields.join(', ')}`);
  console.warn('! 只能执行无签名编译校验，无法导出可在真机安装的已签名 .ipa。');
  console.warn('====================================================================\n');
} else {
  console.log(
    `  [ios:build] Signing ready: mode=${signingStatus.mode}, method=${signingStatus.exportMethod}, team=${signingStatus.teamId}`,
  );
  if (signingStatus.installWarning) {
    console.warn(`  ! [ios:build] 提示: ${signingStatus.installWarning}`);
  }
}

if (isDryRun) {
  console.log('  [ios:build] --dry-run 模式：已完成签名配置与前置检查，未执行 Xcode 构建。');
  process.exit(0);
}

if (process.platform !== 'darwin') {
  console.error('\n✖ [ios:build] iOS 原生编译与签名打包必须在 macOS（含 Xcode）上执行。');
  console.error('  可在本地通过 .env 中的 MAC_RUNNER_SSH 远端 Mac 节点构建，或使用 GitHub Actions release-build.yml (macos-latest)。');
  console.error('  详情请见 docs/testing/cross-platform-release-signing.md\n');
  process.exit(1);
}

// 0. Build shared workspace layers & mobile web assets
console.log('  0. Building core, ui, and renderer bundles...');
execSync('npm run build', { cwd: repoRoot, stdio: 'inherit' });

console.log('  1. Preparing mobile web assets...');
execSync(`node "${path.join(mobileRoot, 'scripts/prepare-assets.mjs')}"`, { stdio: 'inherit' });

console.log('  2. Syncing Capacitor assets & plugins to iOS native project...');
const capCandidates = [
  path.join(mobileRoot, 'node_modules/.bin/cap'),
  path.join(repoRoot, 'node_modules/.bin/cap'),
];
const capBin = capCandidates.find((candidate) => fs.existsSync(candidate));
if (capBin) {
  execSync(`"${capBin}" sync ios`, { cwd: mobileRoot, stdio: 'inherit' });
} else {
  execSync('npx cap sync ios', { cwd: mobileRoot, stdio: 'inherit' });
}

const projectPath = path.join(iosDir, 'App/App.xcodeproj');
const buildRoot = path.join(iosDir, 'App/build/release');
const archivePath = path.join(buildRoot, 'HermesFlux.xcarchive');
const exportPath = path.join(buildRoot, 'export');
fs.mkdirSync(buildRoot, { recursive: true });
fs.rmSync(archivePath, { recursive: true, force: true });
fs.rmSync(exportPath, { recursive: true, force: true });

if (signingStatus.mode === 'unsigned') {
  console.log('  3. Running unsigned xcodebuild verification (CODE_SIGNING_ALLOWED=NO)...');
  const unsignedBuild = spawnSync(
    'xcodebuild',
    ['-project', projectPath, '-scheme', 'App', '-destination', 'generic/platform=iOS', 'build', 'CODE_SIGNING_ALLOWED=NO'],
    { cwd: iosDir, stdio: 'inherit', env },
  );
  if (unsignedBuild.error || unsignedBuild.status !== 0) {
    console.error(`\n✖ xcodebuild unsigned build failed (status=${unsignedBuild.status})\n`);
    process.exit(1);
  }
  console.log('\n✔ iOS unsigned compile check passed (not distributable to real devices).\n');
  process.exit(0);
}

let tempAuthKeyPath = '';
let tempExportOptionsPath = '';

try {
  let authKeyPath = '';
  if (signingStatus.hasAppStoreConnectApiKey) {
    const prepared = prepareIosApiKeyPath({
      rawApiKey: env.APPLE_API_KEY,
      keyId: env.APPLE_API_KEY_ID,
    });
    authKeyPath = prepared.path;
    tempAuthKeyPath = prepared.tempFile;
  }

  tempExportOptionsPath = path.join(
    os.tmpdir(),
    `hermes-ios-export-${process.pid}-${crypto.randomBytes(4).toString('hex')}.plist`,
  );

  const { archiveArgs, exportArgs } = buildIosXcodebuildArgs({
    projectPath,
    scheme: 'App',
    archivePath,
    exportPath,
    exportOptionsPath: tempExportOptionsPath,
    status: signingStatus,
    authenticationKeyPath: authKeyPath,
    authenticationKeyId: String(env.APPLE_API_KEY_ID || '').trim(),
    authenticationKeyIssuerId: String(env.APPLE_API_ISSUER || '').trim(),
  });

  console.log('  3. Archiving iOS Release app with xcodebuild...');
  const archiveRes = spawnSync('xcodebuild', archiveArgs, { cwd: iosDir, stdio: 'inherit', env });
  if (archiveRes.error || archiveRes.status !== 0) {
    throw new Error(`xcodebuild archive failed (status=${archiveRes.status})`);
  }

  const plistContent = renderIosExportOptionsPlist({
    bundleId: 'com.hermesflux.app',
    teamId: signingStatus.teamId,
    signingStyle: signingStatus.signingStyle,
    exportMethod: signingStatus.exportMethod,
    provisioningProfileSpecifier: signingStatus.provisioningProfileSpecifier || '',
    codeSignIdentity: signingStatus.codeSignIdentity || '',
  });
  fs.writeFileSync(tempExportOptionsPath, plistContent, 'utf8');

  console.log(`  4. Exporting signed IPA (${signingStatus.exportMethod})...`);
  const exportRes = spawnSync('xcodebuild', exportArgs, { cwd: iosDir, stdio: 'inherit', env });
  if (exportRes.error || exportRes.status !== 0) {
    throw new Error(`xcodebuild -exportArchive failed (status=${exportRes.status})`);
  }

  const ipaFiles = fs.existsSync(exportPath)
    ? fs.readdirSync(exportPath).filter((name) => name.toLowerCase().endsWith('.ipa'))
    : [];
  if (ipaFiles.length === 0) {
    throw new Error(`xcodebuild -exportArchive succeeded but no .ipa was found in ${exportPath}`);
  }

  const generatedIpa = path.join(exportPath, ipaFiles[0]);
  const mobileReleaseDir = path.join(mobileRoot, 'release');
  const rootReleaseDir = path.join(repoRoot, 'release');
  const finalMobileIpa = path.join(mobileReleaseDir, 'Hermes-Flux-0.1.0-ios.ipa');
  const finalRootIpa = path.join(rootReleaseDir, 'Hermes-Flux-0.1.0-ios.ipa');
  fs.mkdirSync(mobileReleaseDir, { recursive: true });
  fs.mkdirSync(rootReleaseDir, { recursive: true });
  fs.copyFileSync(generatedIpa, finalMobileIpa);
  fs.copyFileSync(generatedIpa, finalRootIpa);

  const archivedApp = path.join(archivePath, 'Products/Applications/App.app');
  if (fs.existsSync(archivedApp)) {
    console.log('  5. Verifying iOS bundle signature via codesign...');
    const csRes = spawnSync('codesign', ['-dv', '--verbose=2', archivedApp], { stdio: 'inherit' });
    if (csRes.error || csRes.status !== 0) {
      throw new Error(`codesign verification failed on ${archivedApp}`);
    }
  }

  const ipaSizeMb = (fs.statSync(finalMobileIpa).size / 1024 / 1024).toFixed(2);
  console.log('\n======================================================');
  console.log('✔ Hermes Flux Mobile iOS IPA build ready!');
  console.log(`  Release IPA: ${finalMobileIpa} (${ipaSizeMb} MB)`);
  console.log(`  Review  IPA: ${finalRootIpa} (${ipaSizeMb} MB)`);
  console.log('======================================================\n');
} finally {
  if (tempAuthKeyPath && fs.existsSync(tempAuthKeyPath)) {
    fs.rmSync(tempAuthKeyPath, { force: true });
  }
  if (tempExportOptionsPath && fs.existsSync(tempExportOptionsPath)) {
    fs.rmSync(tempExportOptionsPath, { force: true });
  }
}
