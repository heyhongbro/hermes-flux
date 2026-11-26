import { execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertAndroidSigningReady,
  evaluateAndroidApkCertCheck,
  isAndroidSigningRequired,
  parseAndroidBuildArgs,
  resolveAndroidSigningStatus,
} from './android-signing-config.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const mobileRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(mobileRoot, '../..');
const androidDir = path.join(mobileRoot, 'android');

const argv = process.argv.slice(2);
const { isDryRun } = parseAndroidBuildArgs(argv);
const env = { ...process.env };
if (!env.ANDROID_HOME && process.env.LOCALAPPDATA) {
  env.ANDROID_HOME = path.join(process.env.LOCALAPPDATA, 'Android/Sdk');
}
if (!env.ANDROID_SDK_ROOT && env.ANDROID_HOME) {
  env.ANDROID_SDK_ROOT = env.ANDROID_HOME;
}

const signingRequired = isAndroidSigningRequired({ argv, env });
const signingStatus = resolveAndroidSigningStatus({ androidDir, env });
const readiness = assertAndroidSigningReady({ status: signingStatus, required: signingRequired });

console.log('[Hermes Flux Mobile Android Builder]');

if (!readiness.ok) {
  console.error(`\n✖ ${readiness.error}\n`);
  process.exit(1);
}

if (signingStatus.mode === 'release') {
  console.log(`  [android:build] Release signing: Release Keystore (${signingStatus.source}: ${signingStatus.keystorePath})`);
} else {
  console.warn('\n====================================================================');
  console.warn('! WARNING [android:build]: 未配置正式 Release Keystore，将回退 Debug 签名');
  console.warn(`! 缺失项: ${signingStatus.missingFields.join(', ')}`);
  console.warn('! 产物证书为 Android Debug，安装时必触发“开发者身份未验证”告警。');
  console.warn('! 若需阻断未签名正式包，请使用 --require-signing 或 npm run package:mobile:android:release');
  console.warn('====================================================================\n');
}

if (isDryRun) {
  console.log('  [android:build] --dry-run 模式：已完成签名配置与前置检查，未执行 Gradle 构建。');
  process.exit(0);
}

// 0. Build shared workspace layers (core -> ui -> desktop renderer)
console.log('  0. Building core, ui, and renderer bundles...');
execSync('npm run build', { cwd: repoRoot, stdio: 'inherit' });

// 1. Sync web assets
console.log('  1. Preparing mobile web assets...');
execSync(`node "${path.join(mobileRoot, 'scripts/prepare-assets.mjs')}"`, { stdio: 'inherit' });

// 2. Sync Capacitor
console.log('  2. Syncing Capacitor assets & plugins to Android native project...');
const capCandidates = [
  path.join(mobileRoot, 'node_modules/.bin/cap.cmd'),
  path.join(mobileRoot, 'node_modules/.bin/cap.exe'),
  path.join(mobileRoot, 'node_modules/.bin/cap'),
  path.join(repoRoot, 'node_modules/.bin/cap.cmd'),
  path.join(repoRoot, 'node_modules/.bin/cap.exe'),
  path.join(repoRoot, 'node_modules/.bin/cap'),
];
const capBin = capCandidates.find((candidate) => fs.existsSync(candidate));
if (capBin) {
  execSync(`"${capBin}" sync android`, { cwd: mobileRoot, stdio: 'inherit' });
} else {
  execSync('npx cap sync android', { cwd: mobileRoot, stdio: 'inherit' });
}

// 3. Assemble APK(s) with Gradle
console.log('  3. Assembling Android APKs with Gradle...');
const gradlewCmd = process.platform === 'win32' ? '.\\gradlew.bat' : './gradlew';
const gradleTasks = signingRequired ? '-PrequireReleaseSigning=true assembleRelease' : 'assembleRelease assembleDebug';
execSync(`${gradlewCmd} ${gradleTasks}`, { cwd: androidDir, stdio: 'inherit', env });

// 4. Copy artifacts to packages/mobile/release and workspace release/
const generatedReleaseApk = path.join(androidDir, 'app/build/outputs/apk/release/app-release.apk');
const generatedDebugApk = path.join(androidDir, 'app/build/outputs/apk/debug/app-debug.apk');
const mobileReleaseDir = path.join(mobileRoot, 'release');
const rootReleaseDir = path.join(repoRoot, 'release');
const finalReleaseApk = path.join(mobileReleaseDir, 'Hermes-Flux-0.1.0-release.apk');
const finalDebugApk = path.join(mobileReleaseDir, 'Hermes-Flux-0.1.0-debug.apk');
const finalRootAndroidApk = path.join(rootReleaseDir, 'Hermes-Flux-0.1.0-android.apk');

fs.mkdirSync(mobileReleaseDir, { recursive: true });
fs.mkdirSync(rootReleaseDir, { recursive: true });
fs.copyFileSync(generatedReleaseApk, finalReleaseApk);
fs.copyFileSync(generatedReleaseApk, finalRootAndroidApk);
if (!signingRequired && fs.existsSync(generatedDebugApk)) {
  fs.copyFileSync(generatedDebugApk, finalDebugApk);
}

// 5. Inspect APK signing certificate via keytool (and fail closed if debug cert slipped into strict release)
const keytoolBin = env.JAVA_HOME
  ? path.join(env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'keytool.exe' : 'keytool')
  : 'keytool';
const resolvedKeytool = fs.existsSync(keytoolBin) ? keytoolBin : 'keytool';
const keytoolRes = spawnSync(resolvedKeytool, ['-printcert', '-jarfile', finalReleaseApk], {
  encoding: 'utf8',
  env,
});

const certCheck = evaluateAndroidApkCertCheck({
  keytoolExitCode: keytoolRes.status,
  keytoolError: keytoolRes.error,
  stdout: keytoolRes.stdout,
  stderr: keytoolRes.stderr,
  signingRequired,
});

if (certCheck.certInfo) {
  console.log(`  [android:build] APK 签名所有者: ${certCheck.certInfo.owner ?? '未知'}`);
  console.log(`  [android:build] APK SHA-256 指纹: ${certCheck.certInfo.sha256 ?? '未解析'}`);
}
if (!certCheck.ok) {
  console.error(`\n✖ ${certCheck.error}\n`);
  process.exit(1);
}
if (certCheck.warning) {
  console.warn(`  ! [android:build] ${certCheck.warning}`);
} else {
  console.log(
    '  [android:build] 提示：请确认已将包名 com.hermesflux.app 与上述 SHA-256 指纹备案至 Google Android Developer Verification 及各厂商开放平台。',
  );
}

const releaseSizeMb = (fs.statSync(finalReleaseApk).size / 1024 / 1024).toFixed(2);
console.log(`\n======================================================`);
console.log(`✔ Hermes Flux Mobile Android APK build ready!`);
console.log(`  Release APK: ${finalReleaseApk} (${releaseSizeMb} MB)`);
console.log(`  Review  APK: ${finalRootAndroidApk} (${releaseSizeMb} MB)`);
if (!signingRequired && fs.existsSync(finalDebugApk)) {
  const debugSizeMb = (fs.statSync(finalDebugApk).size / 1024 / 1024).toFixed(2);
  console.log(`  Debug   APK: ${finalDebugApk} (${debugSizeMb} MB)`);
}
console.log(`======================================================\n`);
