import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  assertAndroidSigningReady,
  evaluateAndroidApkCertCheck,
  findAndroidApksignerPath,
  isAndroidSigningRequired,
  parseAndroidBuildArgs,
  parseApkCertInfo,
  parseKeystoreProperties,
  resolveAndroidSigningStatus,
} from '../../scripts/android-signing-config.mjs';

test('Android Release Keystore 签名配置解析与密钥隔离守卫', () => {
  assert.deepEqual(parseKeystoreProperties(''), {});
  assert.deepEqual(parseKeystoreProperties(null), {});
  assert.deepEqual(parseKeystoreProperties(123), {});

  const parsed = parseKeystoreProperties(
    [
      '  # indented comment',
      '# commentedKey=badValue',
      '  ! indented bang',
      '! bangKey:badValue',
      '   ',
      '=orphanValue',
      '   =blankKey',
      'noSeparatorHere',
      'storeFile = C:\\keys\\rel:prod.keystore',
      'storePassword = super-secret-pass',
      'keyAlias : hermes=release',
      'keyPassword=key-secret-pass',
    ].join('\r\n'),
  );
  assert.deepEqual(parsed, {
    storeFile: 'C:\\keys\\rel:prod.keystore',
    storePassword: 'super-secret-pass',
    keyAlias: 'hermes=release',
    keyPassword: 'key-secret-pass',
  });

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-signing-'));
  try {
    // 1. 缺省配置：安全回落 debug-fallback 且给出完整缺失项列表与安装告警
    const emptyStatus = resolveAndroidSigningStatus({ androidDir: tmpRoot, env: {} });
    assert.equal(emptyStatus.mode, 'debug-fallback');
    assert.equal(emptyStatus.source, 'none');
    assert.equal(emptyStatus.keystorePath, null);
    assert.equal(emptyStatus.keyAliasPresent, false);
    assert.deepEqual(emptyStatus.missingFields, [
      'storeFile / ANDROID_KEYSTORE_PATH',
      'storePassword / ANDROID_KEYSTORE_PASSWORD',
      'keyAlias / ANDROID_KEY_ALIAS',
      'keyPassword / ANDROID_KEY_PASSWORD',
    ]);
    assert.ok(emptyStatus.installWarning.includes('Android Debug'));

    // 2. 通过 keystore.properties + 真实存在的 keystore 文件启用正式签名，且绝不泄露密码字段
    const fakeKeystore = path.join(tmpRoot, 'release.keystore');
    fs.writeFileSync(fakeKeystore, 'placeholder-keystore');
    fs.writeFileSync(
      path.join(tmpRoot, 'keystore.properties'),
      [
        'storeFile=release.keystore',
        'storePassword=secret-store-pw',
        'keyAlias=hermes-flux-release',
        'keyPassword=secret-key-pw',
      ].join('\n'),
    );
    const propsStatus = resolveAndroidSigningStatus({ androidDir: tmpRoot, env: {} });
    assert.equal(propsStatus.mode, 'release');
    assert.equal(propsStatus.source, 'keystore.properties');
    assert.equal(propsStatus.keystorePath, fakeKeystore);
    assert.equal(propsStatus.keyAliasPresent, true);
    assert.deepEqual(propsStatus.missingFields, []);
    assert.ok(propsStatus.installWarning.includes('SHA-256'));
    const serializedProps = JSON.stringify(propsStatus);
    assert.equal(serializedProps.includes('secret-store-pw'), false, '返回值不得泄露 storePassword');
    assert.equal(serializedProps.includes('secret-key-pw'), false, '返回值不得泄露 keyPassword');

    // 2b. keystore.properties 存在但未配置 storeFile 时，由环境变量补足必须识别为 source='env'
    fs.writeFileSync(path.join(tmpRoot, 'keystore.properties'), 'keyAlias=from-props\n');
    const mixedStatus = resolveAndroidSigningStatus({
      androidDir: tmpRoot,
      env: {
        ANDROID_KEYSTORE_PATH: `  ${fakeKeystore}  `,
        ANDROID_KEYSTORE_PASSWORD: '   ',
        ANDROID_KEY_PASSWORD: '  only-key-pw  ',
      },
    });
    assert.equal(mixedStatus.mode, 'debug-fallback');
    assert.equal(mixedStatus.source, 'env');
    assert.equal(mixedStatus.keystorePath, fakeKeystore);
    assert.equal(mixedStatus.keyAliasPresent, true);
    assert.deepEqual(mixedStatus.missingFields, ['storePassword / ANDROID_KEYSTORE_PASSWORD']);

    // 3. 当 keystore.properties 不存在时，支持 ANDROID_KEYSTORE_* 环境变量（绝对路径与空格裁剪）
    fs.unlinkSync(path.join(tmpRoot, 'keystore.properties'));
    const envStatus = resolveAndroidSigningStatus({
      androidDir: tmpRoot,
      env: {
        ANDROID_KEYSTORE_PATH: ` ${fakeKeystore} `,
        ANDROID_KEYSTORE_PASSWORD: ' env-store-pw ',
        ANDROID_KEY_ALIAS: ' hermes-ci ',
        ANDROID_KEY_PASSWORD: ' env-key-pw ',
      },
    });
    assert.equal(envStatus.mode, 'release');
    assert.equal(envStatus.source, 'env');
    assert.equal(envStatus.keystorePath, fakeKeystore);
    assert.equal(envStatus.keyAliasPresent, true);
    assert.deepEqual(envStatus.missingFields, []);
    assert.equal(JSON.stringify(envStatus).includes('env-store-pw'), false);

    // 4. keystore 路径不存在或仅空白时必须拒绝判为 release 并给出准确提示
    const missingFileStatus = resolveAndroidSigningStatus({
      androidDir: tmpRoot,
      env: {
        ANDROID_KEYSTORE_PATH: path.join(tmpRoot, 'does-not-exist.keystore'),
        ANDROID_KEYSTORE_PASSWORD: 'env-store-pw',
        ANDROID_KEY_ALIAS: '   ',
        ANDROID_KEY_PASSWORD: '   ',
      },
    });
    assert.equal(missingFileStatus.mode, 'debug-fallback');
    assert.equal(missingFileStatus.keyAliasPresent, false);
    assert.ok(missingFileStatus.missingFields.some((m) => m.includes('keystore file missing')));
    assert.ok(missingFileStatus.missingFields.includes('keyAlias / ANDROID_KEY_ALIAS'));
    assert.ok(missingFileStatus.missingFields.includes('keyPassword / ANDROID_KEY_PASSWORD'));
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('Android 严格正式签名门禁与 APK 证书指纹解析', () => {
  // 1. 严格模式开关判定
  assert.equal(isAndroidSigningRequired(), false);
  assert.equal(isAndroidSigningRequired({ argv: [], env: {} }), false);
  assert.equal(isAndroidSigningRequired({ env: { FLUX_REQUIRE_SIGNING: '1' } }), true);
  assert.equal(isAndroidSigningRequired({ argv: ['--require-signing'], env: {} }), true);
  assert.equal(isAndroidSigningRequired({ argv: [], env: { FLUX_REQUIRE_SIGNING: '1' } }), true);
  assert.equal(isAndroidSigningRequired({ argv: [], env: { FLUX_REQUIRE_SIGNING: ' TRUE ' } }), true);
  assert.equal(isAndroidSigningRequired({ argv: [], env: { ANDROID_REQUIRE_RELEASE_SIGNING: 'true' } }), true);
  assert.equal(isAndroidSigningRequired({ argv: [], env: { ANDROID_REQUIRE_RELEASE_SIGNING: '0' } }), false);
  assert.equal(isAndroidSigningRequired({ argv: null, env: { FLUX_REQUIRE_SIGNING: 1 } }), false);

  // 2. strict fail-closed 裁决
  const debugStatus = {
    mode: 'debug-fallback',
    missingFields: ['storeFile / ANDROID_KEYSTORE_PATH'],
  };
  assert.deepEqual(assertAndroidSigningReady({ status: debugStatus, required: false }), {
    ok: true,
    mode: 'debug-fallback',
  });
  const blocked = assertAndroidSigningReady({ status: debugStatus, required: true });
  assert.equal(blocked.ok, false);
  assert.ok(blocked.error.includes('storeFile / ANDROID_KEYSTORE_PATH'));
  assert.ok(blocked.error.includes('cross-platform-release-signing.md'));

  const emptyBlocked = assertAndroidSigningReady({ status: { mode: 'debug-fallback', missingFields: [] }, required: true });
  assert.equal(emptyBlocked.ok, false);
  assert.ok(emptyBlocked.error.includes('release keystore configuration missing'));

  assert.deepEqual(
    assertAndroidSigningReady({ status: { mode: 'release', missingFields: [] }, required: true }),
    { ok: true, mode: 'release' },
  );
  assert.deepEqual(assertAndroidSigningReady({ status: null, required: false }), {
    ok: true,
    mode: 'debug-fallback',
  });

  // 3. keytool -printcert 输出解析（区分 Debug 证书与正式 Release 证书）
  const debugKeytoolOut = [
    'Signer #1:',
    '',
    'Signature:',
    '',
    'Owner: C=US, O=Android, CN=Android Debug',
    'Issuer: C=US, O=Android, CN=Android Debug',
    'Certificate fingerprints:',
    '         SHA1: AA:BB:CC',
    '         SHA256: 01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF',
  ].join('\n');
  const parsedDebug = parseApkCertInfo(debugKeytoolOut);
  assert.equal(parsedDebug.owner, 'C=US, O=Android, CN=Android Debug');
  assert.equal(
    parsedDebug.sha256,
    '01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF',
  );
  assert.equal(parsedDebug.isDebugCert, true);

  // 4. apksigner verify --print-certs 输出解析（64位小写无冒号 hex 规范化为大写冒号分隔）
  const releaseApksignerOut = [
    'Signer #1 certificate DN: CN=Hermes Flux, O=Hermes Flux Studio, C=CN',
    'Signer #1 certificate SHA-256 digest: a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
  ].join('\n');
  const parsedRelease = parseApkCertInfo(releaseApksignerOut);
  assert.equal(parsedRelease.owner, 'CN=Hermes Flux, O=Hermes Flux Studio, C=CN');
  assert.equal(
    parsedRelease.sha256,
    'A1:B2:C3:D4:E5:F6:07:18:29:3A:4B:5C:6D:7E:8F:90:A1:B2:C3:D4:E5:F6:07:18:29:3A:4B:5C:6D:7E:8F:90',
  );
  assert.equal(parsedRelease.isDebugCert, false);

  // 5. 空/畸变输入容错
  assert.deepEqual(parseApkCertInfo(''), { owner: null, sha256: null, isDebugCert: false });
  assert.deepEqual(parseApkCertInfo(null), { owner: null, sha256: null, isDebugCert: false });
  assert.deepEqual(parseApkCertInfo('Owner:   \nSHA256: SHORTHEX'), {
    owner: null,
    sha256: null,
    isDebugCert: false,
  });
  assert.deepEqual(parseApkCertInfo('Owner: CN=Hermes\nSHA256: AA:BB:CC'), {
    owner: 'CN=Hermes',
    sha256: null,
    isDebugCert: false,
  });
  assert.deepEqual(parseApkCertInfo(`Owner: CN=Hermes\nSHA256: ${'A'.repeat(66)}`), {
    owner: 'CN=Hermes',
    sha256: null,
    isDebugCert: false,
  });
  const zhOwnerInfo = parseApkCertInfo(
    `所有者: CN=Hermes Zh, O=Studio\nSHA-256 digest: ${'B'.repeat(64)}`,
  );
  assert.equal(zhOwnerInfo.owner, 'CN=Hermes Zh, O=Studio');
  assert.equal(zhOwnerInfo.isDebugCert, false);
  assert.equal(zhOwnerInfo.sha256?.startsWith('BB:BB:BB'), true);

  // 6. Android CLI 参数解析与产后 keytool 证书核验（严格模式对异常/无签名/Debug 一律 fail-closed）
  assert.deepEqual(parseAndroidBuildArgs(), { isDryRun: false });
  assert.deepEqual(parseAndroidBuildArgs(null), { isDryRun: false });
  assert.deepEqual(parseAndroidBuildArgs(['--dry-run', '--require-signing']), { isDryRun: true });

  assert.equal(evaluateAndroidApkCertCheck().ok, true);
  const keytoolErrStrict = evaluateAndroidApkCertCheck({
    keytoolExitCode: 0,
    keytoolError: new Error('keytool missing'),
    signingRequired: true,
  });
  assert.equal(keytoolErrStrict.ok, false);
  assert.ok(keytoolErrStrict.error.includes('无法通过 keytool 核验 APK 签名证书 (keytool missing)'));

  const keytoolExitFallbackStrict = evaluateAndroidApkCertCheck({
    keytoolExitCode: 2,
    stderr: '',
    signingRequired: true,
  });
  assert.equal(keytoolExitFallbackStrict.ok, false);
  assert.ok(keytoolExitFallbackStrict.error.includes('(exit 2)'));

  const keytoolNonZeroNonStrict = evaluateAndroidApkCertCheck({
    keytoolExitCode: 2,
    stderr: 'not signed',
    signingRequired: false,
  });
  assert.equal(keytoolNonZeroNonStrict.ok, true);
  assert.ok(keytoolNonZeroNonStrict.warning.includes('not signed'));

  const debugStrict = evaluateAndroidApkCertCheck({
    keytoolExitCode: 0,
    stdout: debugKeytoolOut,
    signingRequired: true,
  });
  assert.equal(debugStrict.ok, false);
  assert.ok(debugStrict.error.includes('Android Debug'));

  const debugNonStrict = evaluateAndroidApkCertCheck({
    keytoolExitCode: 0,
    stdout: debugKeytoolOut,
    signingRequired: false,
  });
  assert.equal(debugNonStrict.ok, true);
  assert.ok(debugNonStrict.warning.includes('开发者身份未验证'));

  const unsignedStrictNoSha = evaluateAndroidApkCertCheck({
    keytoolExitCode: 0,
    stdout: 'Owner: CN=Hermes Flux\n',
    signingRequired: true,
  });
  assert.equal(unsignedStrictNoSha.ok, false);
  assert.ok(unsignedStrictNoSha.error.includes('SHA-256 指纹'));

  const unsignedStrictNoOwner = evaluateAndroidApkCertCheck({
    keytoolExitCode: 0,
    stdout: 'SHA256: A1:B2:C3:D4:E5:F6:07:18:29:3A:4B:5C:6D:7E:8F:90:A1:B2:C3:D4:E5:F6:07:18:29:3A:4B:5C:6D:7E:8F:90\n',
    signingRequired: true,
  });
  assert.equal(unsignedStrictNoOwner.ok, false);

  const unsignedNonStrict = evaluateAndroidApkCertCheck({
    keytoolExitCode: 0,
    stdout: 'Not a signed jar file',
    signingRequired: false,
  });
  assert.equal(unsignedNonStrict.ok, true);
  assert.ok(unsignedNonStrict.warning.includes('未能从 APK 解析出完整签名证书信息'));

  const validReleaseCheck = evaluateAndroidApkCertCheck({
    keytoolExitCode: 0,
    stdout: releaseApksignerOut,
    signingRequired: true,
  });
  assert.deepEqual(validReleaseCheck, {
    ok: true,
    certInfo: parsedRelease,
    error: null,
    warning: null,
  });

  // 7. findAndroidApksignerPath 探测 SDK build-tools 中最新版 apksigner
  assert.equal(findAndroidApksignerPath(''), null);
  assert.equal(findAndroidApksignerPath('/missing', { existsSync: () => false }), null);
  assert.equal(
    findAndroidApksignerPath('/sdk', {
      existsSync: (p) => p.endsWith('build-tools'),
      readdirSync: () => { throw new Error('eacces'); },
    }),
    null,
  );
  const pickedWin = findAndroidApksignerPath('C:\\Android\\Sdk', {
    platform: 'win32',
    existsSync: (p) => p.endsWith('build-tools') || p.includes('35.0.0') && p.endsWith('apksigner.bat'),
    readdirSync: () => ['34.0.0', '35.0.0'],
  });
  assert.equal(pickedWin, path.join('C:\\Android\\Sdk', 'build-tools', '35.0.0', 'apksigner.bat'));

  const pickedPosixMissing = findAndroidApksignerPath('/opt/android', {
    platform: 'linux',
    existsSync: (p) => p.endsWith('build-tools'),
    readdirSync: () => ['35.0.0'],
  });
  assert.equal(pickedPosixMissing, null);
});
