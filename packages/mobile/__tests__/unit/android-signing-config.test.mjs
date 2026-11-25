import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
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
      '  ! indented bang',
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
    // 1. 缺省配置：安全回落 debug-fallback 且给出完整缺失项列表
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
