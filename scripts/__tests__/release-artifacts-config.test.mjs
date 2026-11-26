import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditWorkflow } from '../gates/verify-ci-workflow.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../..');

test('全端打包与签名工程资产结构及 release-build workflow 可移植性校验', () => {
  // 1. electron-builder.json 必须配置 SHA-256 + RFC3161 与 macOS Hardened Runtime + entitlements
  const ebConfig = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'packages/desktop/electron-builder.json'), 'utf8'),
  );
  assert.deepEqual(ebConfig.win?.signtoolOptions?.signingHashAlgorithms, ['sha256']);
  assert.equal(ebConfig.win?.signtoolOptions?.rfc3161TimeStampServer, 'http://timestamp.digicert.com');
  assert.equal(ebConfig.mac?.hardenedRuntime, true);
  assert.equal(ebConfig.mac?.gatekeeperAssess, false);
  assert.equal(ebConfig.mac?.entitlements, 'build/entitlements.mac.plist');
  assert.equal(ebConfig.mac?.entitlementsInherit, 'build/entitlements.mac.plist');
  // 本地无凭据试打包不得在静态配置强制阻断
  assert.equal(ebConfig.forceCodeSigning, undefined);
  assert.equal(ebConfig.mac?.notarize, undefined);

  // 2. macOS Hardened Runtime entitlements plist 必须声明 Electron JIT 与网络权限
  const macPlist = fs.readFileSync(
    path.join(REPO_ROOT, 'packages/desktop/build/entitlements.mac.plist'),
    'utf8',
  );
  for (const key of [
    'com.apple.security.cs.allow-jit',
    'com.apple.security.cs.allow-unsigned-executable-memory',
    'com.apple.security.cs.disable-library-validation',
    'com.apple.security.network.client',
  ]) {
    assert.ok(macPlist.includes(key), `entitlements.mac.plist 缺少 ${key}`);
  }

  // 3. iOS Xcode 工程必须清除已废弃的 iPhone Developer 签名标识，并忽略本地签名产物
  const pbxproj = fs.readFileSync(
    path.join(REPO_ROOT, 'packages/mobile/ios/App/App.xcodeproj/project.pbxproj'),
    'utf8',
  );
  assert.equal(pbxproj.includes('iPhone Developer'), false);
  assert.ok(pbxproj.includes('CODE_SIGN_IDENTITY = "Apple Development";'));

  const iosGitignore = fs.readFileSync(path.join(REPO_ROOT, 'packages/mobile/ios/.gitignore'), 'utf8');
  for (const entry of ['signing.local.xcconfig', 'ExportOptions.plist', '*.p12', '*.p8', '*.ipa']) {
    assert.ok(iosGitignore.includes(entry), `ios/.gitignore 缺少 ${entry}`);
  }

  // 4. Android build.gradle 必须包含严格签名 fail-closed 拦截
  const androidGradle = fs.readFileSync(
    path.join(REPO_ROOT, 'packages/mobile/android/app/build.gradle'),
    'utf8',
  );
  assert.ok(androidGradle.includes('requireReleaseSigning'));
  assert.ok(androidGradle.includes('throw new GradleException'));

  // 5. .github/workflows/release-build.yml 必须通过跨平台 CI 可移植性静态检查且修复 step-env/build 顺序缺陷
  const workflowSource = fs.readFileSync(
    path.join(REPO_ROOT, '.github/workflows/release-build.yml'),
    'utf8',
  );
  const audit = auditWorkflow(workflowSource);
  assert.deepEqual(audit.failures, []);
  assert.ok(audit.steps >= 18);
  assert.equal(workflowSource.includes('if: env.ANDROID_KEYSTORE_BASE64'), false, 'step 级 if 不得引用同 step env');
  assert.ok(workflowSource.includes('Build workspace layers'));

  // 6. package-mac.mjs 必须对 .app 校验 stapler（不可对未装订的 .dmg 调 stapler validate）
  const packageMacSource = fs.readFileSync(
    path.join(REPO_ROOT, 'packages/desktop/scripts/package-mac.mjs'),
    'utf8',
  );
  assert.ok(packageMacSource.includes("'stapler', 'validate', appPath"));
  assert.equal(packageMacSource.includes('dmgPath'), false);
});
