import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ALLOWED_IOS_EXPORT_METHODS,
  assertIosSigningReady,
  buildIosXcodebuildArgs,
  decodeAppleApiKeyPem,
  isIosSigningRequired,
  looksLikeFilePath,
  parseIosBuildArgs,
  parseXcconfig,
  prepareIosApiKeyPath,
  renderIosExportOptionsPlist,
  resolveIosSigningStatus,
  resolveLocalFilePath,
} from '../../scripts/ios-signing-config.mjs';

test('iOS xcconfig 解析、路径展开与 Base64 密文判定', () => {
  assert.deepEqual(parseXcconfig(''), {});
  assert.deepEqual(parseXcconfig(null), {});
  assert.deepEqual(parseXcconfig(123), {});

  const parsed = parseXcconfig(
    [
      '// leading comment',
      '   ',
      'noEqualsHere',
      '=missingKey',
      '   =blankKey',
      'DEVELOPMENT_TEAM = TEAM123456 // inline note',
      'CODE_SIGN_STYLE = Manual',
      'IOS_EXPORT_METHOD = ad-hoc',
      'PROVISIONING_PROFILE_SPECIFIER = Hermes Flux AdHoc',
    ].join('\n'),
  );
  assert.deepEqual(parsed, {
    DEVELOPMENT_TEAM: 'TEAM123456',
    CODE_SIGN_STYLE: 'Manual',
    IOS_EXPORT_METHOD: 'ad-hoc',
    PROVISIONING_PROFILE_SPECIFIER: 'Hermes Flux AdHoc',
  });

  // 合成及真实 Base64（含 /、+、=、换行及带参数 data: URI）绝不得被误判为文件路径
  assert.equal(looksLikeFilePath(''), false);
  assert.equal(looksLikeFilePath('   '), false);
  assert.equal(looksLikeFilePath(null), false);
  assert.equal(looksLikeFilePath(123), false);
  assert.equal(looksLikeFilePath('  -----BEGIN PRIVATE KEY-----\nMIGT/abc+123=\n-----END PRIVATE KEY-----'), false);
  assert.equal(looksLikeFilePath('  https://example.com/AuthKey.p8  '), false);
  assert.equal(looksLikeFilePath('file:///tmp/cert.p12'), false);
  assert.equal(looksLikeFilePath('secret.p8.txt'), false);
  assert.equal(looksLikeFilePath('MIGTAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBHkwdwIBAQQg'), false);
  assert.equal(looksLikeFilePath('MIGT/abc+DEF45=='), false);
  assert.equal(looksLikeFilePath('MIGT/abcdef123=='), false);
  assert.equal(looksLikeFilePath('MIGT/abc+123DEF456/789ghi=='), false);
  assert.equal(looksLikeFilePath('MIGT/abc\nDEF456/789ghi+012=='), false);
  assert.equal(looksLikeFilePath('MIGT/abc+123DEF456789012'), false);
  assert.equal(looksLikeFilePath(`${'a'.repeat(30)}/${'b'.repeat(33)}`), false);
  assert.equal(looksLikeFilePath('MIGT/abcDEF456/789ghi012345678901234567890123456789012345678901234'), false);
  assert.equal(looksLikeFilePath('data:application/pkcs8;base64,MIGT/abc+123=='), false);
  assert.equal(looksLikeFilePath('data:text/plain;charset=utf-8;base64,MIGT/abc+123=='), false);

  assert.equal(looksLikeFilePath('certs/-----BEGIN/key'), true);
  assert.equal(looksLikeFilePath('certs/data:x;base64,abc'), true);
  assert.equal(looksLikeFilePath('certs/https://a'), true);
  assert.equal(looksLikeFilePath('certs/v1+build2'), true);
  assert.equal(looksLikeFilePath('certificates/dev'), true);
  assert.equal(looksLikeFilePath('certs/app+release'), true);
  assert.equal(looksLikeFilePath('certs/app+release+prod'), true);
  assert.equal(looksLikeFilePath('certs/app+release+profile'), true);
  assert.equal(looksLikeFilePath(`${'a'.repeat(30)}/${'b'.repeat(32)}`), true);
  assert.equal(looksLikeFilePath('/Users/runner/AuthKey_ABC.p8'), true);
  assert.equal(looksLikeFilePath('C:\\keys\\AuthKey.p8'), true);
  assert.equal(looksLikeFilePath('~/keys/AuthKey.p8'), true);
  assert.equal(looksLikeFilePath('~\\keys\\AuthKey.p8'), true);
  assert.equal(looksLikeFilePath('AuthKey.p8'), true);
  assert.equal(looksLikeFilePath('cert.mobileprovision'), true);
  assert.equal(looksLikeFilePath('certs/dev'), true);

  assert.equal(resolveLocalFilePath(), '');
  assert.equal(resolveLocalFilePath(''), '');
  assert.equal(resolveLocalFilePath('~/keys/AuthKey.p8', '/home/alice'), path.join('/home/alice', 'keys/AuthKey.p8'));
  assert.equal(resolveLocalFilePath('~\\keys\\AuthKey.p8', '/home/alice'), path.join('/home/alice', 'keys\\AuthKey.p8'));
  assert.equal(resolveLocalFilePath('  /abs/AuthKey.p8  ', '/home/alice'), '/abs/AuthKey.p8');

  const rawPem = '-----BEGIN PRIVATE KEY-----\nSECRET_LINE\n-----END PRIVATE KEY-----';
  const b64Pem = Buffer.from(rawPem, 'utf8').toString('base64');
  assert.equal(decodeAppleApiKeyPem(), '');
  assert.equal(decodeAppleApiKeyPem(`  ${rawPem}  `), rawPem);
  assert.equal(decodeAppleApiKeyPem(b64Pem), rawPem);
  assert.equal(decodeAppleApiKeyPem(`data:application/pkcs8;base64,${b64Pem}`), rawPem);
  assert.equal(decodeAppleApiKeyPem(`data:text/plain;charset=utf-8;base64,${b64Pem}`), rawPem);
});

test('iOS Release 签名状态探测、严格门禁与零私钥泄露', () => {
  const defaultCall = resolveIosSigningStatus();
  assert.equal(typeof defaultCall.mode, 'string');
  assert.equal(typeof defaultCall.exportMethod, 'string');

  assert.deepEqual(parseIosBuildArgs(), { isDryRun: false, exportMethodOverride: '' });
  assert.deepEqual(parseIosBuildArgs([]), { isDryRun: false, exportMethodOverride: '' });
  assert.deepEqual(parseIosBuildArgs(['--dry-run', '--export-method=ad-hoc']), {
    isDryRun: true,
    exportMethodOverride: 'ad-hoc',
  });
  assert.deepEqual(parseIosBuildArgs(null), { isDryRun: false, exportMethodOverride: '' });

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-ios-signing-'));
  try {
    // 1. 缺省空配置 -> unsigned 且含明确警告
    const empty = resolveIosSigningStatus({ iosDir: tmpRoot, env: {} });
    assert.equal(empty.mode, 'unsigned');
    assert.equal(empty.source, 'none');
    assert.equal(empty.signingStyle, 'automatic');
    assert.equal(empty.exportMethod, 'app-store-connect');
    assert.equal(empty.teamIdPresent, false);
    assert.equal(empty.teamId, null);
    assert.equal(empty.hasAppStoreConnectApiKey, false);
    assert.equal(empty.codeSignIdentityPresent, false);
    assert.equal(empty.codeSignIdentity, null);
    assert.equal(empty.provisioningProfilePresent, false);
    assert.equal(empty.provisioningProfileSpecifier, null);
    assert.deepEqual(empty.missingFields, ['IOS_DEVELOPMENT_TEAM / APPLE_TEAM_ID / DEVELOPMENT_TEAM']);
    assert.ok(empty.installWarning.includes('Apple Developer Team'));

    // 2. 通过 signing.local.xcconfig 配置 Automatic App Store Connect 签名 -> 无安装警告
    fs.writeFileSync(
      path.join(tmpRoot, 'signing.local.xcconfig'),
      'DEVELOPMENT_TEAM =   ABCDE12345  \nCODE_SIGN_IDENTITY =   Apple Distribution  \n',
    );
    const xcconfigStatus = resolveIosSigningStatus({ iosDir: tmpRoot, env: {} });
    assert.equal(xcconfigStatus.mode, 'distribution-automatic');
    assert.equal(xcconfigStatus.source, 'signing.local.xcconfig');
    assert.equal(xcconfigStatus.teamId, 'ABCDE12345');
    assert.equal(xcconfigStatus.codeSignIdentity, 'Apple Distribution');
    assert.equal(xcconfigStatus.installWarning, null);

    fs.writeFileSync(
      path.join(tmpRoot, 'signing.local.xcconfig'),
      'DEVELOPMENT_TEAM = TEAM_ONLY_XCCONFIG\n',
    );
    const xcconfigTeamOnly = resolveIosSigningStatus({ iosDir: tmpRoot, env: {} });
    assert.equal(xcconfigTeamOnly.source, 'signing.local.xcconfig');
    assert.equal(xcconfigTeamOnly.mode, 'distribution-automatic');
    assert.equal(xcconfigTeamOnly.teamId, 'TEAM_ONLY_XCCONFIG');

    fs.writeFileSync(
      path.join(tmpRoot, 'signing.local.xcconfig'),
      'PROVISIONING_PROFILE_SPECIFIER = ProfileFromXcconfig\n',
    );
    const xcconfigProfileOnly = resolveIosSigningStatus({ iosDir: tmpRoot, env: {} });
    assert.equal(xcconfigProfileOnly.source, 'signing.local.xcconfig');
    assert.equal(xcconfigProfileOnly.provisioningProfileSpecifier, 'ProfileFromXcconfig');

    const envIdentitySource = resolveIosSigningStatus({
      iosDir: null,
      env: { IOS_CODE_SIGN_IDENTITY: '  Apple Dist  ' },
    });
    assert.equal(envIdentitySource.source, 'env');
    assert.equal(envIdentitySource.codeSignIdentity, 'Apple Dist');

    const envProfileSource = resolveIosSigningStatus({
      iosDir: null,
      env: { IOS_PROVISIONING_PROFILE_SPECIFIER: '  EnvProfile  ' },
    });
    assert.equal(envProfileSource.source, 'env');
    assert.equal(envProfileSource.provisioningProfileSpecifier, 'EnvProfile');

    // 3. 环境变量覆盖为 Manual + App Store Connect API Key（含 ~/ 路径展开）且绝不泄露私钥
    const fakeP8 = path.join(tmpRoot, 'AuthKey_KEYID999.p8');
    fs.writeFileSync(fakeP8, '-----BEGIN PRIVATE KEY-----\nSECRET_KEY_BODY\n-----END PRIVATE KEY-----');
    const manualStatus = resolveIosSigningStatus({
      iosDir: tmpRoot,
      homedir: tmpRoot,
      env: {
        IOS_DEVELOPMENT_TEAM: 'TEAM999999',
        IOS_SIGNING_STYLE: '  MANUAL  ',
        IOS_EXPORT_METHOD: '  APP-STORE-CONNECT ',
        IOS_CODE_SIGN_IDENTITY: 'Apple Distribution: Hermes Flux',
        IOS_PROVISIONING_PROFILE_SPECIFIER: 'Hermes Flux AppStore Profile',
        APPLE_API_KEY: '~/AuthKey_KEYID999.p8',
        APPLE_API_KEY_ID: 'KEYID999',
        APPLE_API_ISSUER: '11111111-2222-3333-4444-555555555555',
      },
    });
    assert.equal(manualStatus.mode, 'distribution-manual');
    assert.equal(manualStatus.source, 'env');
    assert.equal(manualStatus.signingStyle, 'manual');
    assert.equal(manualStatus.exportMethod, 'app-store-connect');
    assert.equal(manualStatus.hasAppStoreConnectApiKey, true);
    assert.equal(manualStatus.codeSignIdentityPresent, true);
    assert.equal(manualStatus.provisioningProfilePresent, true);
    assert.equal(manualStatus.installWarning, null);
    assert.deepEqual(manualStatus.missingFields, []);
    const serializedManual = JSON.stringify(manualStatus);
    assert.equal(serializedManual.includes('SECRET_KEY_BODY'), false);
    assert.equal(serializedManual.includes('KEYID999'), false);
    assert.equal(serializedManual.includes('11111111-2222'), false);

    // 4. 真实含 / 与 + 的 Base64 APPLE_API_KEY 及 data: URI 不误判为文件缺失且密文不回流
    const realB64Key = Buffer.from('-----BEGIN PRIVATE KEY-----\n???>>><<<SECRET_P8_BODY\n-----END PRIVATE KEY-----').toString('base64');
    assert.ok(realB64Key.includes('/'));
    const base64ApiStatus = resolveIosSigningStatus({
      iosDir: tmpRoot,
      env: {
        APPLE_TEAM_ID: 'TEAM777777',
        APPLE_API_KEY: realB64Key,
        APPLE_API_KEY_ID: 'KEY777',
        APPLE_API_ISSUER: 'issuer-uuid-777',
      },
    });
    assert.equal(base64ApiStatus.mode, 'distribution-automatic');
    assert.equal(base64ApiStatus.source, 'env');
    assert.equal(base64ApiStatus.hasAppStoreConnectApiKey, true);
    assert.equal(JSON.stringify(base64ApiStatus).includes(realB64Key), false);

    const dataUriApiStatus = resolveIosSigningStatus({
      iosDir: tmpRoot,
      env: {
        APPLE_TEAM_ID: 'TEAM777777',
        APPLE_API_KEY: `data:application/pkcs8;base64,${realB64Key}`,
        APPLE_API_KEY_ID: 'KEY777',
        APPLE_API_ISSUER: 'issuer-uuid-777',
      },
    });
    assert.equal(dataUriApiStatus.mode, 'distribution-automatic');
    assert.equal(dataUriApiStatus.source, 'env');
    assert.equal(dataUriApiStatus.hasAppStoreConnectApiKey, true);

    const apiKeyOnlyNoTeam = resolveIosSigningStatus({
      iosDir: null,
      env: {
        APPLE_API_KEY: realB64Key,
        APPLE_API_KEY_ID: 'KEY777',
        APPLE_API_ISSUER: 'issuer-uuid-777',
      },
    });
    assert.equal(apiKeyOnlyNoTeam.mode, 'unsigned');
    assert.equal(apiKeyOnlyNoTeam.source, 'none');
    assert.equal(apiKeyOnlyNoTeam.hasAppStoreConnectApiKey, true);

    const apiKeyMissingIssuer = resolveIosSigningStatus({
      iosDir: null,
      env: {
        APPLE_TEAM_ID: 'TEAM777',
        APPLE_API_KEY: realB64Key,
        APPLE_API_KEY_ID: 'KEY777',
      },
    });
    assert.equal(apiKeyMissingIssuer.mode, 'unsigned');
    assert.equal(apiKeyMissingIssuer.hasAppStoreConnectApiKey, false);
    assert.deepEqual(apiKeyMissingIssuer.missingFields, ['APPLE_API_ISSUER']);

    const apiKeyIdsWithoutKey = resolveIosSigningStatus({
      iosDir: null,
      env: {
        APPLE_TEAM_ID: 'TEAM777',
        APPLE_API_KEY_ID: 'KEY777',
        APPLE_API_ISSUER: 'ISS777',
      },
    });
    assert.equal(apiKeyIdsWithoutKey.mode, 'unsigned');
    assert.equal(apiKeyIdsWithoutKey.hasAppStoreConnectApiKey, false);
    assert.deepEqual(apiKeyIdsWithoutKey.missingFields, ['APPLE_API_KEY']);

    const apiKeyMissingKeyId = resolveIosSigningStatus({
      iosDir: null,
      env: {
        APPLE_TEAM_ID: 'TEAM777',
        APPLE_API_KEY: realB64Key,
        APPLE_API_ISSUER: 'ISS777',
      },
    });
    assert.equal(apiKeyMissingKeyId.mode, 'unsigned');
    assert.equal(apiKeyMissingKeyId.hasAppStoreConnectApiKey, false);
    assert.deepEqual(apiKeyMissingKeyId.missingFields, ['APPLE_API_KEY_ID']);

    const apiKeyMissingFileWithIds = resolveIosSigningStatus({
      iosDir: null,
      fileExists: () => false,
      env: {
        APPLE_TEAM_ID: 'TEAM777',
        APPLE_API_KEY: '/missing/AuthKey.p8',
        APPLE_API_KEY_ID: 'KEY777',
        APPLE_API_ISSUER: 'ISS777',
      },
    });
    assert.equal(apiKeyMissingFileWithIds.mode, 'unsigned');
    assert.equal(apiKeyMissingFileWithIds.hasAppStoreConnectApiKey, false);
    assert.deepEqual(apiKeyMissingFileWithIds.missingFields, ['APPLE_API_KEY file missing']);

    // 4b. prepareIosApiKeyPath 路径展开、Base64 0600 落盘与 keyId 路径穿越防护
    assert.deepEqual(prepareIosApiKeyPath(), { path: '', tempFile: '' });
    assert.deepEqual(prepareIosApiKeyPath({ rawApiKey: '   ' }), { path: '', tempFile: '' });
    assert.deepEqual(prepareIosApiKeyPath({ rawApiKey: '~/AuthKey_KEYID999.p8', homedir: tmpRoot }), {
      path: fakeP8,
      tempFile: '',
    });
    let capturedIosWriteOpts = null;
    const materialized = prepareIosApiKeyPath({
      rawApiKey: realB64Key,
      keyId: '../evil/KEY777',
      tmpDir: tmpRoot,
      writeFile: (filePath, content, options) => {
        capturedIosWriteOpts = options;
        fs.writeFileSync(filePath, content, options);
      },
    });
    assert.deepEqual(capturedIosWriteOpts, { mode: 0o600 });
    assert.equal(path.dirname(materialized.tempFile), tmpRoot);
    assert.equal(path.basename(materialized.tempFile).startsWith('AuthKey_evilKEY777_'), true);
    assert.ok(fs.readFileSync(materialized.tempFile, 'utf8').includes('SECRET_P8_BODY'));

    const omittedKeyIdMat = prepareIosApiKeyPath({ rawApiKey: realB64Key, tmpDir: tmpRoot });
    assert.equal(path.basename(omittedKeyIdMat.tempFile).startsWith('AuthKey_key_'), true);

    const emptyKeyIdMat = prepareIosApiKeyPath({ rawApiKey: realB64Key, keyId: '', tmpDir: tmpRoot });
    assert.equal(path.basename(emptyKeyIdMat.tempFile).startsWith('AuthKey_key_'), true);

    const sanitizedEmptyKeyIdMat = prepareIosApiKeyPath({
      rawApiKey: realB64Key,
      keyId: '///',
      tmpDir: tmpRoot,
    });
    assert.equal(path.basename(sanitizedEmptyKeyIdMat.tempFile).startsWith('AuthKey_key_'), true);

    // 5. 不同 exportMethod 的安装提示差异（development / ad-hoc / enterprise）
    const devStatus = resolveIosSigningStatus({
      iosDir: tmpRoot,
      env: { IOS_DEVELOPMENT_TEAM: 'TEAM1' },
      exportMethodOverride: 'development',
    });
    assert.equal(devStatus.mode, 'distribution-automatic');
    assert.equal(devStatus.exportMethod, 'development');
    assert.ok(devStatus.installWarning.includes('7 天'));

    const adHocStatus = resolveIosSigningStatus({
      iosDir: tmpRoot,
      env: { IOS_DEVELOPMENT_TEAM: 'TEAM1' },
      exportMethodOverride: 'ad-hoc',
    });
    assert.equal(adHocStatus.mode, 'distribution-automatic');
    assert.equal(adHocStatus.exportMethod, 'ad-hoc');
    assert.ok(adHocStatus.installWarning.includes('UDID'));

    const entStatus = resolveIosSigningStatus({
      iosDir: tmpRoot,
      env: { IOS_DEVELOPMENT_TEAM: 'TEAM1' },
      exportMethodOverride: 'enterprise',
    });
    assert.equal(entStatus.mode, 'distribution-automatic');
    assert.equal(entStatus.exportMethod, 'enterprise');
    assert.ok(entStatus.installWarning.includes('企业签名'));

    assert.deepEqual(ALLOWED_IOS_EXPORT_METHODS, ['app-store-connect', 'ad-hoc', 'enterprise', 'development']);

    // 6. 缺省/非法配置报错明细：非法 exportMethod、非法 signingStyle、Manual 缺字段、API Key 半残与文件缺失（绝不回显路径值）
    const badStatus = resolveIosSigningStatus({
      iosDir: null,
      env: {
        IOS_SIGNING_STYLE: 'manual',
        IOS_EXPORT_METHOD: 'sideload-magic',
        APPLE_API_KEY: path.join(tmpRoot, 'secret-missing.p8'),
      },
    });
    assert.equal(badStatus.mode, 'unsigned');
    assert.equal(badStatus.hasAppStoreConnectApiKey, false);
    assert.ok(badStatus.missingFields.includes('IOS_EXPORT_METHOD invalid (sideload-magic)'));
    assert.ok(badStatus.missingFields.includes('IOS_DEVELOPMENT_TEAM / APPLE_TEAM_ID / DEVELOPMENT_TEAM'));
    assert.ok(badStatus.missingFields.includes('IOS_CODE_SIGN_IDENTITY'));
    assert.ok(badStatus.missingFields.includes('IOS_PROVISIONING_PROFILE_SPECIFIER'));
    assert.ok(badStatus.missingFields.includes('APPLE_API_KEY file missing'));
    assert.equal(JSON.stringify(badStatus).includes('secret-missing.p8'), false, '绝不可回显 APPLE_API_KEY 原文');
    assert.ok(badStatus.missingFields.includes('APPLE_API_KEY_ID'));
    assert.ok(badStatus.missingFields.includes('APPLE_API_ISSUER'));

    const invalidStyleStatus = resolveIosSigningStatus({
      iosDir: null,
      env: {
        IOS_DEVELOPMENT_TEAM: 'TEAM1',
        IOS_SIGNING_STYLE: 'bogus',
        APPLE_API_KEY_ID: 'ONLY_ID',
      },
    });
    assert.equal(invalidStyleStatus.mode, 'unsigned');
    assert.equal(invalidStyleStatus.source, 'env');
    assert.equal(invalidStyleStatus.hasAppStoreConnectApiKey, false);
    assert.ok(invalidStyleStatus.missingFields.includes('IOS_SIGNING_STYLE invalid (bogus)'));
    assert.ok(invalidStyleStatus.missingFields.includes('APPLE_API_KEY'));
    assert.ok(invalidStyleStatus.missingFields.includes('APPLE_API_ISSUER'));

    // 7. 严格模式开关与 fail-closed 断言
    assert.equal(isIosSigningRequired(), false);
    assert.equal(isIosSigningRequired({ argv: [], env: {} }), false);
    assert.equal(isIosSigningRequired({ argv: ['--require-signing'], env: {} }), true);
    assert.equal(isIosSigningRequired({ argv: [], env: { FLUX_REQUIRE_SIGNING: ' TRUE ' } }), true);
    assert.equal(isIosSigningRequired({ argv: [], env: { IOS_REQUIRE_SIGNING: ' 1 ' } }), true);
    assert.equal(isIosSigningRequired({ argv: [], env: { IOS_REQUIRE_SIGNING: ' false ' } }), false);
    assert.equal(isIosSigningRequired({ argv: [], env: { FLUX_REQUIRE_SIGNING: ' 0 ' } }), false);
    assert.equal(isIosSigningRequired({ argv: null, env: { IOS_REQUIRE_SIGNING: 1 } }), false);
    assert.equal(isIosSigningRequired({ argv: [], env: null }), false);

    assert.deepEqual(assertIosSigningReady({ status: empty, required: false }), {
      ok: true,
      mode: 'unsigned',
    });
    const iosBlocked = assertIosSigningReady({ status: empty, required: true });
    assert.equal(iosBlocked.ok, false);
    assert.ok(iosBlocked.error.includes('IOS_DEVELOPMENT_TEAM'));
    assert.ok(iosBlocked.error.includes('cross-platform-release-signing.md'));

    const iosEmptyBlocked = assertIosSigningReady({
      status: { mode: 'unsigned', missingFields: [] },
      required: true,
    });
    assert.equal(iosEmptyBlocked.ok, false);
    assert.ok(iosEmptyBlocked.error.includes('iOS signing configuration missing'));

    assert.deepEqual(assertIosSigningReady({ status: manualStatus, required: true }), {
      ok: true,
      mode: 'distribution-manual',
    });
    assert.deepEqual(assertIosSigningReady({ status: null, required: false }), {
      ok: true,
      mode: 'unsigned',
    });
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('iOS ExportOptions.plist XML 转义与 xcodebuild 安全参数构造', () => {
  const autoPlist = renderIosExportOptionsPlist({
    teamId: 'TEAM123&<>',
  });
  assert.equal(
    autoPlist,
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0">',
      '<dict>',
      '\t<key>method</key>',
      '\t<string>app-store-connect</string>',
      '\t<key>teamID</key>',
      '\t<string>TEAM123&amp;&lt;&gt;</string>',
      '\t<key>signingStyle</key>',
      '\t<string>automatic</string>',
      '\t<key>uploadSymbols</key>',
      '\t<true/>',
      '</dict>',
      '</plist>',
      '',
    ].join('\n'),
  );

  // automatic 模式下即便 status 携带手动字段也绝不可输出 signingCertificate 或 provisioningProfiles
  const autoWithExtraFields = renderIosExportOptionsPlist({
    teamId: 'TEAM123',
    signingStyle: 'automatic',
    codeSignIdentity: 'Apple Distribution',
    provisioningProfileSpecifier: 'Ignored_Manual_Profile',
  });
  assert.equal(autoWithExtraFields.includes('signingCertificate'), false);
  assert.equal(autoWithExtraFields.includes('provisioningProfiles'), false);
  assert.equal(autoWithExtraFields.includes('<true/>'), true);

  const manualPlist = renderIosExportOptionsPlist({
    bundleId: 'com.hermesflux.app',
    teamId: 'TEAM123',
    signingStyle: 'manual',
    exportMethod: 'ad-hoc',
    codeSignIdentity: 'Apple Distribution: "Hermes\'s"',
    provisioningProfileSpecifier: 'AdHoc_Profile',
  });
  assert.equal(
    manualPlist,
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0">',
      '<dict>',
      '\t<key>method</key>',
      '\t<string>ad-hoc</string>',
      '\t<key>teamID</key>',
      '\t<string>TEAM123</string>',
      '\t<key>signingStyle</key>',
      '\t<string>manual</string>',
      '\t<key>signingCertificate</key>',
      '\t<string>Apple Distribution: &quot;Hermes&apos;s&quot;</string>',
      '\t<key>provisioningProfiles</key>',
      '\t<dict>',
      '\t\t<key>com.hermesflux.app</key>',
      '\t\t<string>AdHoc_Profile</string>',
      '\t</dict>',
      '</dict>',
      '</plist>',
      '',
    ].join('\n'),
  );

  const manualBarePlist = renderIosExportOptionsPlist({
    teamId: 'TEAM123',
    signingStyle: 'manual',
    exportMethod: 'enterprise',
  });
  assert.equal(manualBarePlist.includes('signingCertificate'), false);
  assert.equal(manualBarePlist.includes('provisioningProfiles'), false);

  const manualDefaultBundleIdPlist = renderIosExportOptionsPlist({
    teamId: 'TEAM123',
    signingStyle: 'manual',
    exportMethod: 'ad-hoc',
    provisioningProfileSpecifier: 'DefaultBundleProfile',
  });
  assert.ok(manualDefaultBundleIdPlist.includes('\t\t<key>com.hermesflux.app</key>\n\t\t<string>DefaultBundleProfile</string>'));

  const unsignedArgs = buildIosXcodebuildArgs({
    projectPath: '/ios/App.xcodeproj',
    archivePath: '/out/App.xcarchive',
    exportPath: '/out/ipa',
    exportOptionsPath: '/tmp/ExportOptions.plist',
    status: { mode: 'unsigned' },
  });
  assert.deepEqual(unsignedArgs, {
    archiveArgs: [
      '-project',
      '/ios/App.xcodeproj',
      '-scheme',
      'App',
      '-configuration',
      'Release',
      '-destination',
      'generic/platform=iOS',
      '-archivePath',
      '/out/App.xcarchive',
      'archive',
      'CODE_SIGNING_ALLOWED=NO',
    ],
    exportArgs: [
      '-exportArchive',
      '-archivePath',
      '/out/App.xcarchive',
      '-exportPath',
      '/out/ipa',
      '-exportOptionsPlist',
      '/tmp/ExportOptions.plist',
    ],
  });

  const autoArgs = buildIosXcodebuildArgs({
    projectPath: '/ios/App.xcodeproj',
    scheme: 'CustomApp',
    archivePath: '/out/App.xcarchive',
    exportPath: '/out/ipa',
    exportOptionsPath: '/tmp/ExportOptions.plist',
    status: { mode: 'distribution-automatic', teamId: 'TEAM123' },
    authenticationKeyPath: '/tmp/AuthKey.p8',
    authenticationKeyId: 'KEY1',
    authenticationKeyIssuerId: 'ISS1',
  });
  assert.deepEqual(autoArgs, {
    archiveArgs: [
      '-project',
      '/ios/App.xcodeproj',
      '-scheme',
      'CustomApp',
      '-configuration',
      'Release',
      '-destination',
      'generic/platform=iOS',
      '-archivePath',
      '/out/App.xcarchive',
      'archive',
      'DEVELOPMENT_TEAM=TEAM123',
      'CODE_SIGN_STYLE=Automatic',
      '-allowProvisioningUpdates',
      '-authenticationKeyPath',
      '/tmp/AuthKey.p8',
      '-authenticationKeyID',
      'KEY1',
      '-authenticationKeyIssuerID',
      'ISS1',
    ],
    exportArgs: [
      '-exportArchive',
      '-archivePath',
      '/out/App.xcarchive',
      '-exportPath',
      '/out/ipa',
      '-exportOptionsPlist',
      '/tmp/ExportOptions.plist',
      '-allowProvisioningUpdates',
      '-authenticationKeyPath',
      '/tmp/AuthKey.p8',
      '-authenticationKeyID',
      'KEY1',
      '-authenticationKeyIssuerID',
      'ISS1',
    ],
  });

  const autoNoTeamNullStatus = buildIosXcodebuildArgs({
    projectPath: '/ios/App.xcodeproj',
    archivePath: '/out/App.xcarchive',
    exportPath: '/out/ipa',
    exportOptionsPath: '/tmp/ExportOptions.plist',
    status: null,
  });
  assert.deepEqual(autoNoTeamNullStatus.archiveArgs, [
    '-project',
    '/ios/App.xcodeproj',
    '-scheme',
    'App',
    '-configuration',
    'Release',
    '-destination',
    'generic/platform=iOS',
    '-archivePath',
    '/out/App.xcarchive',
    'archive',
    'CODE_SIGN_STYLE=Automatic',
    '-allowProvisioningUpdates',
  ]);
  assert.equal(autoNoTeamNullStatus.exportArgs.includes('-allowProvisioningUpdates'), false);

  const manualArgs = buildIosXcodebuildArgs({
    projectPath: '/ios/App.xcodeproj',
    archivePath: '/out/App.xcarchive',
    exportPath: '/out/ipa',
    exportOptionsPath: '/tmp/ExportOptions.plist',
    status: {
      mode: 'distribution-manual',
      teamId: 'TEAM456',
      codeSignIdentity: 'Apple Distribution',
      provisioningProfileSpecifier: 'AppStoreProfile',
    },
  });
  assert.deepEqual(manualArgs, {
    archiveArgs: [
      '-project',
      '/ios/App.xcodeproj',
      '-scheme',
      'App',
      '-configuration',
      'Release',
      '-destination',
      'generic/platform=iOS',
      '-archivePath',
      '/out/App.xcarchive',
      'archive',
      'DEVELOPMENT_TEAM=TEAM456',
      'CODE_SIGN_STYLE=Manual',
      'CODE_SIGN_IDENTITY=Apple Distribution',
      'PROVISIONING_PROFILE_SPECIFIER=AppStoreProfile',
    ],
    exportArgs: [
      '-exportArchive',
      '-archivePath',
      '/out/App.xcarchive',
      '-exportPath',
      '/out/ipa',
      '-exportOptionsPlist',
      '/tmp/ExportOptions.plist',
    ],
  });

  // API Key 三元组任一字段缺失时，绝不可输出残缺的 -authenticationKey* 参数
  for (const partialAuth of [
    { authenticationKeyPath: '/tmp/k.p8', authenticationKeyId: 'K1', authenticationKeyIssuerId: '' },
    { authenticationKeyPath: '/tmp/k.p8', authenticationKeyId: '', authenticationKeyIssuerId: 'I1' },
    { authenticationKeyPath: '', authenticationKeyId: 'K1', authenticationKeyIssuerId: 'I1' },
  ]) {
    const partialArgs = buildIosXcodebuildArgs({
      projectPath: '/ios/App.xcodeproj',
      archivePath: '/out/App.xcarchive',
      exportPath: '/out/ipa',
      exportOptionsPath: '/tmp/ExportOptions.plist',
      status: { mode: 'distribution-automatic', teamId: 'TEAM123' },
      ...partialAuth,
    });
    assert.equal(partialArgs.archiveArgs.includes('-authenticationKeyPath'), false);
    assert.equal(partialArgs.exportArgs.includes('-authenticationKeyPath'), false);
  }
});
