import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { executeMacBuilderWithCleanup } from '../../packages/desktop/scripts/package-mac.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../..');

const ANDROID_SCRIPT = path.join(REPO_ROOT, 'packages/mobile/scripts/build-android.mjs');
const IOS_SCRIPT = path.join(REPO_ROOT, 'packages/mobile/scripts/build-ios.mjs');
const WIN_SCRIPT = path.join(REPO_ROOT, 'packages/desktop/scripts/package-win.mjs');
const MAC_SCRIPT = path.join(REPO_ROOT, 'packages/desktop/scripts/package-mac.mjs');

function cleanSigningEnv(extra = {}) {
  const env = { ...process.env };
  for (const key of [
    'FLUX_REQUIRE_SIGNING',
    'ANDROID_REQUIRE_RELEASE_SIGNING',
    'ANDROID_KEYSTORE_PATH',
    'ANDROID_KEYSTORE_PASSWORD',
    'ANDROID_KEY_ALIAS',
    'ANDROID_KEY_PASSWORD',
    'IOS_REQUIRE_SIGNING',
    'IOS_DEVELOPMENT_TEAM',
    'IOS_SIGNING_STYLE',
    'IOS_EXPORT_METHOD',
    'IOS_CODE_SIGN_IDENTITY',
    'IOS_PROVISIONING_PROFILE_SPECIFIER',
    'MAC_REQUIRE_SIGNING',
    'WIN_REQUIRE_SIGNING',
    'CSC_LINK',
    'CSC_KEY_PASSWORD',
    'CSC_NAME',
    'WIN_CSC_LINK',
    'WIN_CSC_KEY_PASSWORD',
    'WIN_CSC_SHA1',
    'WIN_CSC_THUMBPRINT',
    'WIN_CSC_SUBJECT_NAME',
    'AZURE_SIGNING_ENDPOINT',
    'AZURE_SIGNING_ACCOUNT_NAME',
    'AZURE_SIGNING_CERT_PROFILE_NAME',
    'AZURE_SIGNING_PUBLISHER_NAME',
    'AZURE_TENANT_ID',
    'AZURE_CLIENT_ID',
    'AZURE_CLIENT_SECRET',
    'AZURE_FEDERATED_TOKEN_FILE',
    'AZURE_USE_CLI_AUTH',
    'APPLE_API_KEY',
    'APPLE_API_KEY_ID',
    'APPLE_API_ISSUER',
    'APPLE_ID',
    'APPLE_APP_SPECIFIC_PASSWORD',
    'APPLE_TEAM_ID',
    'APPLE_KEYCHAIN_PROFILE',
  ]) {
    delete env[key];
  }
  return { ...env, ...extra };
}

test('四大打包入口脚本严格签名 fail-closed 与 dry-run 行为验证', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-entrypoints-'));
  try {
    // 1. Android build-android.mjs: --require-signing 无凭据阻断；--dry-run 支持 debug 告警与 release 放行且零泄露
    const androidFail = spawnSync(process.execPath, [ANDROID_SCRIPT, '--require-signing'], {
      cwd: REPO_ROOT,
      env: cleanSigningEnv(),
      encoding: 'utf8',
    });
    assert.equal(androidFail.status, 1);
    assert.ok(androidFail.stderr.includes('已启用严格正式签名门禁'));

    const androidDryWarn = spawnSync(process.execPath, [ANDROID_SCRIPT, '--dry-run'], {
      cwd: REPO_ROOT,
      env: cleanSigningEnv(),
      encoding: 'utf8',
    });
    assert.equal(androidDryWarn.status, 0);
    assert.ok(androidDryWarn.stderr.includes('Android Debug'));

    const dummyKeystore = path.join(tmpDir, 'hermes-release.keystore');
    fs.writeFileSync(dummyKeystore, 'mock-keystore');
    const androidDryPass = spawnSync(process.execPath, [ANDROID_SCRIPT, '--dry-run', '--require-signing'], {
      cwd: REPO_ROOT,
      env: cleanSigningEnv({
        ANDROID_KEYSTORE_PATH: dummyKeystore,
        ANDROID_KEYSTORE_PASSWORD: 'SUPER_SECRET_ANDROID_STORE_PW',
        ANDROID_KEY_ALIAS: 'hermes-release',
        ANDROID_KEY_PASSWORD: 'SUPER_SECRET_ANDROID_KEY_PW',
      }),
      encoding: 'utf8',
    });
    assert.equal(androidDryPass.status, 0);
    assert.ok(androidDryPass.stdout.includes('Release signing: Release Keystore'));
    assert.equal(androidDryPass.stdout.includes('SUPER_SECRET_ANDROID_STORE_PW'), false);
    assert.equal(androidDryPass.stdout.includes('SUPER_SECRET_ANDROID_KEY_PW'), false);

    // 2. iOS build-ios.mjs: unsigned + 含 Base64 APPLE_API_KEY 时绝不向 tmpdir 泄露 .p8 文件
    const iosTmpDir = fs.mkdtempSync(path.join(tmpDir, 'ios-dry-'));
    const realB64Key = Buffer.from('-----BEGIN PRIVATE KEY-----\nIOS_TEST/KEY\n-----END PRIVATE KEY-----').toString('base64');
    const iosDryUnsigned = spawnSync(process.execPath, [IOS_SCRIPT, '--dry-run'], {
      cwd: REPO_ROOT,
      env: cleanSigningEnv({
        TMP: iosTmpDir,
        TEMP: iosTmpDir,
        TMPDIR: iosTmpDir,
        APPLE_API_KEY: realB64Key,
        APPLE_API_KEY_ID: 'KEY1',
        APPLE_API_ISSUER: 'ISS1',
      }),
      encoding: 'utf8',
    });
    assert.equal(iosDryUnsigned.status, 0);
    assert.equal(fs.readdirSync(iosTmpDir).length, 0, 'unsigned dry-run 不得残留任何临时 .p8');

    const iosDryStrictFail = spawnSync(process.execPath, [IOS_SCRIPT, '--dry-run', '--require-signing'], {
      cwd: REPO_ROOT,
      env: cleanSigningEnv(),
      encoding: 'utf8',
    });
    assert.equal(iosDryStrictFail.status, 1);
    assert.ok(iosDryStrictFail.stderr.includes('已启用严格正式签名门禁'));

    const iosDryStrictPass = spawnSync(
      process.execPath,
      [IOS_SCRIPT, '--dry-run', '--require-signing', '--export-method=app-store-connect'],
      {
        cwd: REPO_ROOT,
        env: cleanSigningEnv({
          IOS_DEVELOPMENT_TEAM: 'TEAM123456',
          APPLE_API_KEY: realB64Key,
          APPLE_API_KEY_ID: 'KEY1',
          APPLE_API_ISSUER: 'ISS1',
        }),
        encoding: 'utf8',
      },
    );
    assert.equal(iosDryStrictPass.status, 0);
    assert.equal(iosDryStrictPass.stdout.includes(realB64Key), false);

    // 3. Windows package-win.mjs: dry-run 警告、strict 阻断及含 / Base64 PFX 放行
    const winDryWarn = spawnSync(process.execPath, [WIN_SCRIPT, '--dry-run'], {
      cwd: REPO_ROOT,
      env: cleanSigningEnv(),
      encoding: 'utf8',
    });
    assert.equal(winDryWarn.status, 0);
    assert.ok(winDryWarn.stderr.includes('SmartScreen'));

    const winDryStrictFail = spawnSync(process.execPath, [WIN_SCRIPT, '--dry-run', '--require-signing'], {
      cwd: REPO_ROOT,
      env: cleanSigningEnv(),
      encoding: 'utf8',
    });
    assert.equal(winDryStrictFail.status, 1);
    assert.ok(winDryStrictFail.stderr.includes('已启用严格正式签名门禁'));

    const winB64Pfx = 'MIIBase64/WinPfx+Blob==';
    const winDryStrictPass = spawnSync(process.execPath, [WIN_SCRIPT, '--dry-run', '--require-signing', '--nsis'], {
      cwd: REPO_ROOT,
      env: cleanSigningEnv({
        WIN_CSC_LINK: winB64Pfx,
        WIN_CSC_KEY_PASSWORD: 'SUPER_SECRET_WIN_PW',
      }),
      encoding: 'utf8',
    });
    assert.equal(winDryStrictPass.status, 0);
    assert.ok(winDryStrictPass.stdout.includes('Code signing: pfx-file'));
    assert.equal(winDryStrictPass.stdout.includes('SUPER_SECRET_WIN_PW'), false);
    assert.equal(winDryStrictPass.stdout.includes(winB64Pfx), false);

    // 4. macOS package-mac.mjs: signed-only 必须被 --require-signing 拦截；签名+公证组合放行且零泄露
    const macSignedOnlyFail = spawnSync(process.execPath, [MAC_SCRIPT, '--dry-run', '--require-signing'], {
      cwd: REPO_ROOT,
      env: cleanSigningEnv({ CSC_NAME: 'Hermes Dev ID' }),
      encoding: 'utf8',
    });
    assert.equal(macSignedOnlyFail.status, 1);
    assert.ok(macSignedOnlyFail.stderr.includes('需要 Developer ID 代码签名 + Apple 公证'));

    const macFullPass = spawnSync(process.execPath, [MAC_SCRIPT, '--dry-run', '--require-signing'], {
      cwd: REPO_ROOT,
      env: cleanSigningEnv({
        CSC_LINK: 'MIIBase64/MacP12+Blob==',
        CSC_KEY_PASSWORD: 'SUPER_SECRET_MAC_PW',
        APPLE_TEAM_ID: 'SHARED_TEAM',
        APPLE_KEYCHAIN_PROFILE: 'hermes-notary',
      }),
      encoding: 'utf8',
    });
    assert.equal(macFullPass.status, 0);
    assert.ok(macFullPass.stdout.includes('Signing & Notarization ready'));
    assert.equal(macFullPass.stdout.includes('SUPER_SECRET_MAC_PW'), false);

    // 5. package-mac.mjs executeMacBuilderWithCleanup：electron-builder 失败或抛错时也必经 finally 删除临时 .p8
    const macTmpDir = fs.mkdtempSync(path.join(tmpDir, 'mac-cleanup-'));
    const failRes = executeMacBuilderWithCleanup({
      env: {
        APPLE_API_KEY: realB64Key,
        APPLE_API_KEY_ID: 'MAC_KEY1',
        APPLE_API_ISSUER: 'ISS1',
      },
      targetRootDir: REPO_ROOT,
      electronBuilderCli: 'mock-eb-cli.js',
      builderArgs: ['--mac', '-c.mac.notarize=true'],
      signingStatus: { mode: 'signed-and-notarized' },
      tmpDir: macTmpDir,
      spawnFn: (_bin, _args, opts) => {
        const keyPath = opts.env.APPLE_API_KEY;
        assert.ok(keyPath.startsWith(macTmpDir));
        assert.equal(fs.existsSync(keyPath), true, '执行期间临时 .p8 必须可读');
        return { status: 1 };
      },
    });
    assert.equal(failRes.status, 1);
    assert.equal(fs.readdirSync(macTmpDir).length, 0, 'electron-builder 退出码非 0 后临时 .p8 必须被清理');

    assert.throws(
      () =>
        executeMacBuilderWithCleanup({
          env: {
            APPLE_API_KEY: realB64Key,
            APPLE_API_KEY_ID: 'MAC_KEY2',
          },
          targetRootDir: REPO_ROOT,
          electronBuilderCli: 'mock-eb-cli.js',
          builderArgs: ['--mac'],
          signingStatus: { mode: 'signed-and-notarized' },
          tmpDir: macTmpDir,
          spawnFn: () => {
            assert.equal(fs.readdirSync(macTmpDir).length, 1);
            throw new Error('simulated spawn crash');
          },
        }),
      /simulated spawn crash/,
    );
    assert.equal(fs.readdirSync(macTmpDir).length, 0, '子进程抛异常后临时 .p8 也必须被清理');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
