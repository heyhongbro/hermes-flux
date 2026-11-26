import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  VALID_PLATFORMS,
  evaluateAllPlatformsSigning,
  formatSigningReport,
  parseSigningCheckArgs,
  runSigningCheck,
} from '../signing/check-signing.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHECK_SIGNING_SCRIPT = path.resolve(HERE, '../signing/check-signing.mjs');

test('signing:check CLI 参数解析与非法入参拒绝', () => {
  assert.deepEqual(VALID_PLATFORMS, ['all', 'android', 'ios', 'macos', 'windows']);
  assert.deepEqual(parseSigningCheckArgs(), {
    ok: true,
    platform: 'all',
    strict: false,
    json: false,
  });
  assert.deepEqual(parseSigningCheckArgs(['--platform= macOS ', '--strict', '--json']), {
    ok: true,
    platform: 'macos',
    strict: true,
    json: true,
  });

  const unknownFlag = parseSigningCheckArgs(['--bogus']);
  assert.equal(unknownFlag.ok, false);
  assert.equal(unknownFlag.error, '未知参数: --bogus');

  const unknownPlat = parseSigningCheckArgs(['--platform=linux']);
  assert.equal(unknownPlat.ok, false);
  assert.equal(unknownPlat.error, '未知平台 "linux"，允许值: all, android, ios, macos, windows');

  const dupPlat = parseSigningCheckArgs(['--platform=ios', '--platform=android']);
  assert.equal(dupPlat.ok, false);
  assert.equal(dupPlat.error, '参数 --platform 重复出现: --platform=android');
});

test('signing:check 四端聚合诊断、精确格式化与零密钥泄露校验', () => {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-signing-doctor-'));
  try {
    const androidDir = path.join(tmpRepo, 'packages/mobile/android');
    const iosDir = path.join(tmpRepo, 'packages/mobile/ios');
    fs.mkdirSync(androidDir, { recursive: true });
    fs.mkdirSync(iosDir, { recursive: true });

    // 1. 全未配置与默认参数场景：ok=false 且精确验证文本报告结构
    assert.equal(typeof evaluateAllPlatformsSigning().ok, 'boolean');
    const defaultCheck = runSigningCheck({ repoRoot: tmpRepo, env: {} });
    assert.equal(defaultCheck.exitCode, 0);
    assert.ok(defaultCheck.stdout.includes('范围: all'));

    const noneEval = evaluateAllPlatformsSigning({ repoRoot: tmpRepo, env: {} });
    assert.equal(noneEval.ok, false);
    assert.equal(noneEval.platform, 'all');
    assert.deepEqual(noneEval.summary, { total: 4, ready: 0, notReady: 4 });
    assert.equal(noneEval.platforms.android.releaseReady, false);
    assert.equal(noneEval.platforms.ios.releaseReady, false);
    assert.equal(noneEval.platforms.macos.releaseReady, false);
    assert.equal(noneEval.platforms.windows.releaseReady, false);

    const noneReport = formatSigningReport(noneEval);
    const noneLines = noneReport.split('\n');
    assert.equal(noneLines[0], 'Hermes Flux 全平台发行签名与公证检查');
    assert.equal(noneLines[1], '  范围: all · 就绪: 0/4');
    assert.equal(noneLines[2], '');
    assert.ok(noneReport.includes('[WARN]  Android (APK/AAB): mode=debug-fallback'));
    assert.ok(noneReport.includes('[WARN]  iOS (IPA / App Store / TestFlight): mode=unsigned'));
    assert.ok(noneReport.includes('[WARN]  macOS (DMG/ZIP + Notarization): mode=unsigned'));
    assert.ok(noneReport.includes('[WARN]  Windows (NSIS/Portable Authenticode): mode=unsigned'));
    assert.ok(noneReport.includes('        缺失配置: '));
    assert.ok(noneReport.includes('        安装行为: '));
    assert.equal(noneLines.at(-2), '');
    assert.equal(noneLines.at(-1), '完整配置与平台备案指引: docs/testing/cross-platform-release-signing.md');

    // 1b. 未知自定义平台名回退标签 + 空 missingFields
    const customReport = formatSigningReport({
      platform: 'custom',
      summary: { total: 1, ready: 1, notReady: 0 },
      platforms: {
        custom: { mode: 'ready', releaseReady: true, missingFields: [], installWarning: null },
      },
    });
    assert.equal(
      customReport,
      [
        'Hermes Flux 全平台发行签名与公证检查',
        '  范围: custom · 就绪: 1/1',
        '',
        '[READY] custom: mode=ready',
        '',
        '完整配置与平台备案指引: docs/testing/cross-platform-release-signing.md',
      ].join('\n'),
    );

    // 2. macOS 仅签名无公证 -> releaseReady 必须为 false
    const macOnlyEval = evaluateAllPlatformsSigning({
      repoRoot: tmpRepo,
      env: { CSC_NAME: 'Hermes Dev' },
      platform: 'macos',
    });
    assert.equal(macOnlyEval.ok, false);
    assert.deepEqual(macOnlyEval.summary, { total: 1, ready: 0, notReady: 1 });
    assert.equal(macOnlyEval.platforms.macos.mode, 'signed-only');
    assert.equal(macOnlyEval.platforms.macos.releaseReady, false);

    // 3. 四端全部配置正式凭据 -> ok=true 且输出中绝不含任何密文
    const ksPath = path.join(androidDir, 'rel.keystore');
    fs.writeFileSync(ksPath, 'fake-keystore');
    const fullEnv = {
      ANDROID_KEYSTORE_PATH: ksPath,
      ANDROID_KEYSTORE_PASSWORD: 'SECRET_ANDROID_STORE_PW',
      ANDROID_KEY_ALIAS: 'hermes-rel',
      ANDROID_KEY_PASSWORD: 'SECRET_ANDROID_KEY_PW',
      IOS_DEVELOPMENT_TEAM: 'TEAM12345',
      CSC_LINK: 'SECRET_MAC_P12_BLOB',
      CSC_KEY_PASSWORD: 'SECRET_MAC_P12_PW',
      APPLE_API_KEY: 'SECRET_APPLE_P8_BLOB',
      APPLE_API_KEY_ID: 'KEY1',
      APPLE_API_ISSUER: 'ISSUER1',
      AZURE_SIGNING_ENDPOINT: 'https://eus.codesigning.azure.net/',
      AZURE_SIGNING_ACCOUNT_NAME: 'acct',
      AZURE_SIGNING_CERT_PROFILE_NAME: 'prof',
      AZURE_SIGNING_PUBLISHER_NAME: 'CN=Hermes Flux',
      AZURE_TENANT_ID: 'tenant',
      AZURE_CLIENT_ID: 'client',
      AZURE_CLIENT_SECRET: 'SECRET_AZURE_CLIENT_SECRET',
    };

    const allReadyEval = evaluateAllPlatformsSigning({ repoRoot: tmpRepo, env: fullEnv, platform: 'all' });
    assert.equal(allReadyEval.ok, true);
    assert.deepEqual(allReadyEval.summary, { total: 4, ready: 4, notReady: 0 });
    for (const key of ['android', 'ios', 'macos', 'windows']) {
      assert.equal(allReadyEval.platforms[key].releaseReady, true);
    }

    const fullReport = formatSigningReport(allReadyEval);
    assert.ok(fullReport.includes('[READY] Android (APK/AAB): mode=release'));
    assert.ok(fullReport.includes('[READY] iOS (IPA / App Store / TestFlight): mode=distribution-automatic'));
    assert.ok(fullReport.includes('[READY] macOS (DMG/ZIP + Notarization): mode=signed-and-notarized'));
    assert.ok(fullReport.includes('[READY] Windows (NSIS/Portable Authenticode): mode=azure-trusted-signing'));
    assert.equal(fullReport.includes('[WARN]'), false);
    assert.equal(fullReport.includes('缺失配置:'), false);

    const combinedOut = `${JSON.stringify(allReadyEval)}\n${fullReport}`;
    for (const secret of [
      'SECRET_ANDROID_STORE_PW',
      'SECRET_ANDROID_KEY_PW',
      'SECRET_MAC_P12_BLOB',
      'SECRET_MAC_P12_PW',
      'SECRET_APPLE_P8_BLOB',
      'SECRET_AZURE_CLIENT_SECRET',
    ]) {
      assert.equal(combinedOut.includes(secret), false, `不得泄露机密 ${secret}`);
    }

    // 3b. 通过仓库相对路径（keystore.properties + signing.local.xcconfig）聚合判定
    fs.writeFileSync(
      path.join(androidDir, 'keystore.properties'),
      'storeFile=rel.keystore\nstorePassword=pw\nkeyAlias=rel\nkeyPassword=pw\n',
    );
    fs.writeFileSync(path.join(iosDir, 'signing.local.xcconfig'), 'DEVELOPMENT_TEAM=TEAM_FROM_CFG\n');
    const configFilesEval = evaluateAllPlatformsSigning({ repoRoot: tmpRepo, env: {} });
    assert.equal(configFilesEval.platforms.android.mode, 'release');
    assert.equal(configFilesEval.platforms.android.source, 'keystore.properties');
    assert.equal(configFilesEval.platforms.android.releaseReady, true);
    assert.equal(configFilesEval.platforms.ios.mode, 'distribution-automatic');
    assert.equal(configFilesEval.platforms.ios.source, 'signing.local.xcconfig');
    assert.equal(configFilesEval.platforms.ios.releaseReady, true);
    fs.unlinkSync(path.join(androidDir, 'keystore.properties'));
    fs.unlinkSync(path.join(iosDir, 'signing.local.xcconfig'));

    // 4. 单平台过滤校验（ios / windows / android）
    const winSingle = evaluateAllPlatformsSigning({ repoRoot: tmpRepo, env: fullEnv, platform: 'windows' });
    assert.deepEqual(Object.keys(winSingle.platforms), ['windows']);
    assert.equal(winSingle.ok, true);

    const iosSingle = evaluateAllPlatformsSigning({ repoRoot: tmpRepo, env: fullEnv, platform: 'ios' });
    assert.deepEqual(Object.keys(iosSingle.platforms), ['ios']);
    assert.equal(iosSingle.ok, true);

    const androidSingle = evaluateAllPlatformsSigning({ repoRoot: tmpRepo, env: fullEnv, platform: 'android' });
    assert.deepEqual(Object.keys(androidSingle.platforms), ['android']);
    assert.equal(androidSingle.ok, true);

    // 5. runSigningCheck CLI 执行层（非严格 / JSON / 严格拦截 / 严格放行 / 非法参数）
    const badCli = runSigningCheck({ argv: ['--bad'], env: {}, repoRoot: tmpRepo });
    assert.equal(badCli.exitCode, 1);
    assert.equal(badCli.stdout, '');
    assert.equal(badCli.stderr, '✖ 未知参数: --bad\n');

    const jsonCli = runSigningCheck({ argv: ['--platform=ios', '--json'], env: {}, repoRoot: tmpRepo });
    assert.equal(jsonCli.exitCode, 0);
    assert.equal(jsonCli.stderr, '');
    const parsedJson = JSON.parse(jsonCli.stdout);
    assert.equal(parsedJson.platform, 'ios');
    assert.equal(parsedJson.ok, false);

    const strictFailCli = runSigningCheck({ argv: ['--strict'], env: {}, repoRoot: tmpRepo });
    assert.equal(strictFailCli.exitCode, 1);
    assert.ok(strictFailCli.stdout.includes('Hermes Flux 全平台发行签名与公证检查'));
    assert.equal(strictFailCli.stderr, '✖ 严格签名检查未通过：存在未配置正式签名/公证的目标平台。\n');

    const strictPassCli = runSigningCheck({ argv: ['--strict'], env: fullEnv, repoRoot: tmpRepo });
    assert.equal(strictPassCli.exitCode, 0);
    assert.equal(strictPassCli.stderr, '');
    assert.ok(strictPassCli.stdout.includes('就绪: 4/4'));

    // 6. 真实子进程入口 smoke（验证 isMainEntry 与 main 输出路径）
    const procOk = spawnSync(process.execPath, [CHECK_SIGNING_SCRIPT, '--platform=windows', '--json'], {
      env: { ...process.env, AZURE_SIGNING_ENDPOINT: '', WIN_CSC_LINK: '', WIN_CSC_SHA1: '', WIN_CSC_SUBJECT_NAME: '' },
      encoding: 'utf8',
    });
    assert.equal(procOk.status, 0);
    assert.equal(procOk.stderr, '');
    const procPayload = JSON.parse(procOk.stdout);
    assert.equal(procPayload.platform, 'windows');
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});
