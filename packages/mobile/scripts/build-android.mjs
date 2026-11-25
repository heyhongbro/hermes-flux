import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveAndroidSigningStatus } from './android-signing-config.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const mobileRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(mobileRoot, '../..');

console.log('[Hermes Flux Mobile Android Builder]');

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

// 3. Assemble Release + Debug APKs with Gradle
console.log('  3. Assembling Android Release & Debug APKs with Gradle...');
const androidDir = path.join(mobileRoot, 'android');
const gradlewCmd = process.platform === 'win32' ? '.\\gradlew.bat' : './gradlew';

const env = { ...process.env };
if (!env.ANDROID_HOME && process.env.LOCALAPPDATA) {
  env.ANDROID_HOME = path.join(process.env.LOCALAPPDATA, 'Android/Sdk');
}
if (!env.ANDROID_SDK_ROOT && env.ANDROID_HOME) {
  env.ANDROID_SDK_ROOT = env.ANDROID_HOME;
}

const signingStatus = resolveAndroidSigningStatus({ androidDir, env });
if (signingStatus.mode === 'release') {
  console.log(`  [android:build] Release signing: Release Keystore (${signingStatus.source}: ${signingStatus.keystorePath})`);
} else {
  console.warn(
    `  [android:build] WARNING: Release APK will fall back to Debug Keystore (${signingStatus.missingFields.join(', ')}) — Android will warn "开发者身份未验证". Configure keystore.properties or ANDROID_KEYSTORE_* (see docs/testing/android-release-signing.md).`,
  );
}

execSync(`${gradlewCmd} assembleRelease assembleDebug`, { cwd: androidDir, stdio: 'inherit', env });

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
fs.copyFileSync(generatedDebugApk, finalDebugApk);

const releaseSizeMb = (fs.statSync(finalReleaseApk).size / 1024 / 1024).toFixed(2);
const debugSizeMb = (fs.statSync(finalDebugApk).size / 1024 / 1024).toFixed(2);
console.log(`\n======================================================`);
console.log(`✔ Hermes Flux Mobile Android APK build ready!`);
console.log(`  Release APK: ${finalReleaseApk} (${releaseSizeMb} MB)`);
console.log(`  Review  APK: ${finalRootAndroidApk} (${releaseSizeMb} MB)`);
console.log(`  Debug   APK: ${finalDebugApk} (${debugSizeMb} MB)`);
console.log(`======================================================\n`);
