import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  assertDesktopSigningReady,
  buildMacElectronBuilderArgs,
  buildWindowsElectronBuilderArgs,
  decodeAppleApiKeyPem,
  evaluateWindowsAuthenticodeChecks,
  isDesktopSigningRequired,
  looksLikeFilePath,
  parseMacPackagerArgs,
  parseWinPackagerArgs,
  prepareMacNotarizeEnv,
  resolveLocalFilePath,
  resolveMacSigningStatus,
  resolveWindowsPackagerEnv,
  resolveWindowsSigningStatus,
} from '../../scripts/desktop-signing-config.mjs';

test('Desktop looksLikeFilePath 判定文件路径、~ 展开与真实 Base64 密文边界', () => {
  assert.equal(looksLikeFilePath(''), false);
  assert.equal(looksLikeFilePath('   '), false);
  assert.equal(looksLikeFilePath(null), false);
  assert.equal(looksLikeFilePath(123), false);
  assert.equal(looksLikeFilePath('  -----BEGIN CERTIFICATE-----\nMII/abc+123='), false);
  assert.equal(looksLikeFilePath('  https://certs.example.com/cert.pfx  '), false);
  assert.equal(looksLikeFilePath('file:///C:/certs/cert.pfx'), false);
  assert.equal(looksLikeFilePath('MIIDXTCCAkWgAwIBAgIJALa'), false);
  assert.equal(looksLikeFilePath('secret.p8.txt'), false);
  // 真实含 /、+、= 及换行与带参数 data: URI 的 Base64 不得被误判为路径
  assert.equal(looksLikeFilePath('MIIP/abc+DEF45=='), false);
  assert.equal(looksLikeFilePath('MIIP/abcdef123=='), false);
  assert.equal(looksLikeFilePath('MIIP12/abc+DEF456=='), false);
  assert.equal(looksLikeFilePath('MIIP12/abc\n+DEF456=='), false);
  assert.equal(looksLikeFilePath('MIGT/abc+123DEF456789012'), false);
  assert.equal(looksLikeFilePath(`${'a'.repeat(30)}/${'b'.repeat(33)}`), false);
  assert.equal(looksLikeFilePath('MIGT/abcDEF456/789ghi012345678901234567890123456789012345678901234'), false);
  assert.equal(looksLikeFilePath('data:application/x-pkcs12;base64,MII/abc+123=='), false);
  assert.equal(looksLikeFilePath('data:text/plain;charset=utf-8;base64,MII/abc+123=='), false);

  assert.equal(looksLikeFilePath('certs/-----BEGIN/key'), true);
  assert.equal(looksLikeFilePath('certs/data:x;base64,abc'), true);
  assert.equal(looksLikeFilePath('certs/https://a'), true);
  assert.equal(looksLikeFilePath('certs/v1+build2'), true);
  assert.equal(looksLikeFilePath('certificates/dev'), true);
  assert.equal(looksLikeFilePath('certs/app+release'), true);
  assert.equal(looksLikeFilePath('certs/app+release+prod'), true);
  assert.equal(looksLikeFilePath('certs/app+release+profile'), true);
  assert.equal(looksLikeFilePath(`${'a'.repeat(30)}/${'b'.repeat(32)}`), true);
  assert.equal(looksLikeFilePath('C:\\certs\\win.pfx'), true);
  assert.equal(looksLikeFilePath('/Users/ci/mac.p12'), true);
  assert.equal(looksLikeFilePath('./cert.p12'), true);
  assert.equal(looksLikeFilePath('../cert.pfx'), true);
  assert.equal(looksLikeFilePath('~/certs/win.pfx'), true);
  assert.equal(looksLikeFilePath('~\\certs\\win.pfx'), true);
  assert.equal(looksLikeFilePath('signing.pfx'), true);
  assert.equal(looksLikeFilePath('cert.mobileprovision'), true);
  assert.equal(looksLikeFilePath('certs/win'), true);

  assert.equal(resolveLocalFilePath(), '');
  assert.equal(resolveLocalFilePath(''), '');
  assert.equal(resolveLocalFilePath('~/certs/win.pfx', '/home/bob'), path.join('/home/bob', 'certs/win.pfx'));
  assert.equal(resolveLocalFilePath('~\\certs\\win.pfx', '/home/bob'), path.join('/home/bob', 'certs\\win.pfx'));
  assert.equal(resolveLocalFilePath('  /abs/win.pfx  ', '/home/bob'), '/abs/win.pfx');

  const rawPem = '-----BEGIN PRIVATE KEY-----\nMAC_P8_SECRET\n-----END PRIVATE KEY-----';
  const b64Pem = Buffer.from(rawPem, 'utf8').toString('base64');
  assert.equal(decodeAppleApiKeyPem(), '');
  assert.equal(decodeAppleApiKeyPem(`  ${rawPem}  `), rawPem);
  assert.equal(decodeAppleApiKeyPem(b64Pem), rawPem);
  assert.equal(decodeAppleApiKeyPem(`data:application/pkcs8;base64,${b64Pem}`), rawPem);
  assert.equal(decodeAppleApiKeyPem(`data:text/plain;charset=utf-8;base64,${b64Pem}`), rawPem);
});

test('Windows 代码签名状态解析（Azure / PFX / Cert Store / Unsigned）与零密文泄露', () => {
  assert.equal(typeof resolveWindowsSigningStatus().mode, 'string');

  // 1. 缺省空配置 -> unsigned + SmartScreen 告警
  const empty = resolveWindowsSigningStatus({ env: {} });
  assert.equal(empty.mode, 'unsigned');
  assert.equal(empty.source, 'none');
  assert.equal(empty.azureOptions, null);
  assert.equal(empty.certificateSubjectName, null);
  assert.equal(empty.certificateSha1, null);
  assert.ok(empty.missingFields[0].includes('AZURE_SIGNING_*'));
  assert.ok(empty.installWarning.includes('SmartScreen'));

  // 2. Azure Trusted Signing（Client Secret 鉴权）
  const azureSecret = resolveWindowsSigningStatus({
    env: {
      AZURE_SIGNING_ENDPOINT: ' https://eus.codesigning.azure.net/ ',
      AZURE_SIGNING_ACCOUNT_NAME: 'hermes-acct',
      AZURE_SIGNING_CERT_PROFILE_NAME: 'hermes-profile',
      AZURE_SIGNING_PUBLISHER_NAME: 'CN=Hermes Flux, O=Hermes Flux, C=US',
      AZURE_TENANT_ID: 'tenant-1',
      AZURE_CLIENT_ID: 'client-1',
      AZURE_CLIENT_SECRET: 'super-azure-secret-value',
    },
  });
  assert.equal(azureSecret.mode, 'azure-trusted-signing');
  assert.equal(azureSecret.source, 'azure-env');
  assert.equal(azureSecret.installWarning, null);
  assert.deepEqual(azureSecret.missingFields, []);
  assert.deepEqual(azureSecret.azureOptions, {
    endpoint: 'https://eus.codesigning.azure.net/',
    codeSigningAccountName: 'hermes-acct',
    certificateProfileName: 'hermes-profile',
    publisherName: 'CN=Hermes Flux, O=Hermes Flux, C=US',
  });
  assert.equal(JSON.stringify(azureSecret).includes('super-azure-secret-value'), false);

  // 3. Azure Trusted Signing（OIDC Federated Token 与 CLI Auth 鉴权）
  const azureFed = resolveWindowsSigningStatus({
    env: {
      AZURE_SIGNING_ENDPOINT: 'https://eus.codesigning.azure.net/',
      AZURE_SIGNING_ACCOUNT_NAME: 'acct',
      AZURE_SIGNING_CERT_PROFILE_NAME: 'prof',
      AZURE_SIGNING_PUBLISHER_NAME: 'CN=Hermes Flux',
      AZURE_TENANT_ID: 't1',
      AZURE_CLIENT_ID: 'c1',
      AZURE_FEDERATED_TOKEN_FILE: '/var/run/token',
    },
  });
  assert.equal(azureFed.mode, 'azure-trusted-signing');

  const azureCli = resolveWindowsSigningStatus({
    env: {
      AZURE_SIGNING_ENDPOINT: 'https://eus.codesigning.azure.net/',
      AZURE_SIGNING_ACCOUNT_NAME: 'acct',
      AZURE_SIGNING_CERT_PROFILE_NAME: 'prof',
      AZURE_SIGNING_PUBLISHER_NAME: 'CN=Hermes Flux',
      AZURE_USE_CLI_AUTH: 'true',
    },
  });
  assert.equal(azureCli.mode, 'azure-trusted-signing');

  // 4. Azure 部分缺失 -> unsigned 且列出全部缺失字段
  const azurePartial = resolveWindowsSigningStatus({
    env: {
      AZURE_SIGNING_ENDPOINT: 'https://eus.codesigning.azure.net/',
      AZURE_TENANT_ID: 't1',
      AZURE_CLIENT_ID: 'c1',
    },
  });
  assert.equal(azurePartial.mode, 'unsigned');
  assert.equal(azurePartial.source, 'azure-env');
  assert.ok(azurePartial.missingFields.includes('AZURE_SIGNING_ACCOUNT_NAME'));
  assert.ok(azurePartial.missingFields.includes('AZURE_SIGNING_CERT_PROFILE_NAME'));
  assert.ok(azurePartial.missingFields.includes('AZURE_SIGNING_PUBLISHER_NAME'));
  assert.ok(azurePartial.missingFields.some((f) => f.includes('Azure Entra auth')));
  assert.ok(azurePartial.installWarning.includes('Azure Trusted Signing'));

  const azureOnlyPublisher = resolveWindowsSigningStatus({
    env: {
      AZURE_SIGNING_PUBLISHER_NAME: 'CN=Hermes',
      AZURE_USE_CLI_AUTH: '1',
    },
  });
  assert.equal(azureOnlyPublisher.mode, 'unsigned');
  assert.ok(azureOnlyPublisher.missingFields.includes('AZURE_SIGNING_ENDPOINT'));
  assert.equal(azureOnlyPublisher.missingFields.some((f) => f.includes('Azure Entra auth')), false);

  const azureMissingClientSecret = resolveWindowsSigningStatus({
    env: {
      AZURE_SIGNING_ENDPOINT: 'https://eus.codesigning.azure.net/',
      AZURE_SIGNING_ACCOUNT_NAME: 'acct',
      AZURE_SIGNING_CERT_PROFILE_NAME: 'prof',
      AZURE_SIGNING_PUBLISHER_NAME: 'CN=Hermes Flux',
      AZURE_TENANT_ID: 't1',
      AZURE_CLIENT_ID: 'c1',
    },
  });
  assert.equal(azureMissingClientSecret.mode, 'unsigned');
  assert.ok(azureMissingClientSecret.missingFields.some((f) => f.includes('Azure Entra auth')));

  const azureOnlyFedFile = resolveWindowsSigningStatus({
    env: {
      AZURE_SIGNING_ENDPOINT: 'https://eus.codesigning.azure.net/',
      AZURE_SIGNING_ACCOUNT_NAME: 'acct',
      AZURE_SIGNING_CERT_PROFILE_NAME: 'prof',
      AZURE_SIGNING_PUBLISHER_NAME: 'CN=Hermes Flux',
      AZURE_FEDERATED_TOKEN_FILE: '/var/run/token',
    },
  });
  assert.equal(azureOnlyFedFile.mode, 'unsigned');
  assert.ok(azureOnlyFedFile.missingFields.some((f) => f.includes('Azure Entra auth')));

  const azureOnlyClientSecret = resolveWindowsSigningStatus({
    env: {
      AZURE_SIGNING_ENDPOINT: 'https://eus.codesigning.azure.net/',
      AZURE_SIGNING_ACCOUNT_NAME: 'acct',
      AZURE_SIGNING_CERT_PROFILE_NAME: 'prof',
      AZURE_SIGNING_PUBLISHER_NAME: 'CN=Hermes Flux',
      AZURE_CLIENT_SECRET: 'secret-without-tenant-or-client',
    },
  });
  assert.equal(azureOnlyClientSecret.mode, 'unsigned');
  assert.ok(azureOnlyClientSecret.missingFields.some((f) => f.includes('Azure Entra auth')));

  const azureSecretMissingClient = resolveWindowsSigningStatus({
    env: {
      AZURE_SIGNING_ENDPOINT: 'https://eus.codesigning.azure.net/',
      AZURE_SIGNING_ACCOUNT_NAME: 'acct',
      AZURE_SIGNING_CERT_PROFILE_NAME: 'prof',
      AZURE_SIGNING_PUBLISHER_NAME: 'CN=Hermes Flux',
      AZURE_TENANT_ID: 't1',
      AZURE_CLIENT_SECRET: 'secret-without-client-id',
    },
  });
  assert.equal(azureSecretMissingClient.mode, 'unsigned');
  assert.ok(azureSecretMissingClient.missingFields.some((f) => f.includes('Azure Entra auth')));

  const azureFedMissingClient = resolveWindowsSigningStatus({
    env: {
      AZURE_SIGNING_ENDPOINT: 'https://eus.codesigning.azure.net/',
      AZURE_SIGNING_ACCOUNT_NAME: 'acct',
      AZURE_SIGNING_CERT_PROFILE_NAME: 'prof',
      AZURE_SIGNING_PUBLISHER_NAME: 'CN=Hermes Flux',
      AZURE_TENANT_ID: 't1',
      AZURE_FEDERATED_TOKEN_FILE: '/var/run/token',
    },
  });
  assert.equal(azureFedMissingClient.mode, 'unsigned');
  assert.ok(azureFedMissingClient.missingFields.some((f) => f.includes('Azure Entra auth')));

  const azureSecretMissingTenant = resolveWindowsSigningStatus({
    env: {
      AZURE_SIGNING_ENDPOINT: 'https://eus.codesigning.azure.net/',
      AZURE_SIGNING_ACCOUNT_NAME: 'acct',
      AZURE_SIGNING_CERT_PROFILE_NAME: 'prof',
      AZURE_SIGNING_PUBLISHER_NAME: 'CN=Hermes Flux',
      AZURE_CLIENT_ID: 'c1',
      AZURE_CLIENT_SECRET: 'secret-without-tenant',
    },
  });
  assert.equal(azureSecretMissingTenant.mode, 'unsigned');
  assert.ok(azureSecretMissingTenant.missingFields.some((f) => f.includes('Azure Entra auth')));

  const azureFedMissingTenant = resolveWindowsSigningStatus({
    env: {
      AZURE_SIGNING_ENDPOINT: 'https://eus.codesigning.azure.net/',
      AZURE_SIGNING_ACCOUNT_NAME: 'acct',
      AZURE_SIGNING_CERT_PROFILE_NAME: 'prof',
      AZURE_SIGNING_PUBLISHER_NAME: 'CN=Hermes Flux',
      AZURE_CLIENT_ID: 'c1',
      AZURE_FEDERATED_TOKEN_FILE: '/var/run/token',
    },
  });
  assert.equal(azureFedMissingTenant.mode, 'unsigned');
  assert.ok(azureFedMissingTenant.missingFields.some((f) => f.includes('Azure Entra auth')));

  // 5. PFX 真实含 / Base64、data: URI 与 ~/ 路径展开 + 密码零泄露
  const realB64Pfx = 'MIIBase64/Pfx+SecretPayload==';
  const pfxBase64 = resolveWindowsSigningStatus({
    env: {
      WIN_CSC_LINK: realB64Pfx,
      WIN_CSC_KEY_PASSWORD: 'pfx-secret-password',
    },
  });
  assert.equal(pfxBase64.mode, 'pfx-file');
  assert.equal(pfxBase64.source, 'WIN_CSC_LINK');
  assert.deepEqual(pfxBase64.missingFields, []);
  assert.ok(pfxBase64.installWarning.includes('OV'));
  assert.equal(JSON.stringify(pfxBase64).includes(realB64Pfx), false);
  assert.equal(JSON.stringify(pfxBase64).includes('pfx-secret-password'), false);

  const pfxDataUri = resolveWindowsSigningStatus({
    env: {
      WIN_CSC_LINK: `data:application/x-pkcs12;base64,${realB64Pfx}`,
      WIN_CSC_KEY_PASSWORD: 'pw',
    },
  });
  assert.equal(pfxDataUri.mode, 'pfx-file');
  assert.deepEqual(pfxDataUri.missingFields, []);

  const pfxTildePath = resolveWindowsSigningStatus({
    env: {
      CSC_LINK: '~/win-cert.pfx',
      CSC_KEY_PASSWORD: 'pw',
    },
    homedir: '/home/win',
    fileExists: (p) => p === path.join('/home/win', 'win-cert.pfx'),
  });
  assert.equal(pfxTildePath.mode, 'pfx-file');
  assert.equal(pfxTildePath.source, 'CSC_LINK');
  assert.deepEqual(pfxTildePath.missingFields, []);

  const pfxMissingFile = resolveWindowsSigningStatus({
    env: {
      WIN_CSC_LINK: './missing.pfx',
    },
    fileExists: () => false,
  });
  assert.equal(pfxMissingFile.mode, 'unsigned');
  assert.ok(pfxMissingFile.missingFields.includes('WIN_CSC_LINK file missing'));
  assert.ok(pfxMissingFile.missingFields.includes('WIN_CSC_KEY_PASSWORD / CSC_KEY_PASSWORD'));
  assert.ok(pfxMissingFile.installWarning.includes('SmartScreen'));

  const pfxExistsNoPassword = resolveWindowsSigningStatus({
    env: {
      WIN_CSC_LINK: './exists.pfx',
    },
    fileExists: () => true,
  });
  assert.equal(pfxExistsNoPassword.mode, 'unsigned');
  assert.deepEqual(pfxExistsNoPassword.missingFields, ['WIN_CSC_KEY_PASSWORD / CSC_KEY_PASSWORD']);
  assert.ok(pfxExistsNoPassword.installWarning.includes('SmartScreen'));

  const pfxPasswordOnly = resolveWindowsSigningStatus({
    env: {
      WIN_CSC_KEY_PASSWORD: 'only-password',
    },
  });
  assert.equal(pfxPasswordOnly.mode, 'unsigned');
  assert.ok(pfxPasswordOnly.missingFields.includes('WIN_CSC_LINK / CSC_LINK'));
  assert.ok(pfxPasswordOnly.installWarning.includes('SmartScreen'));

  // 6. Cert Store (EV 硬件加密狗 / 证书存储)
  const storeSha1 = resolveWindowsSigningStatus({
    env: { WIN_CSC_THUMBPRINT: 'AABBCCDD' },
  });
  assert.equal(storeSha1.mode, 'cert-store');
  assert.equal(storeSha1.source, 'WIN_CSC_SHA1');
  assert.equal(storeSha1.certificateSha1, 'AABBCCDD');
  assert.deepEqual(storeSha1.missingFields, []);
  assert.equal(storeSha1.installWarning, null);

  const storeSubject = resolveWindowsSigningStatus({
    env: { WIN_CSC_SUBJECT_NAME: 'Hermes Flux LLC' },
  });
  assert.equal(storeSubject.mode, 'cert-store');
  assert.equal(storeSubject.source, 'WIN_CSC_SUBJECT_NAME');
  assert.equal(storeSubject.certificateSubjectName, 'Hermes Flux LLC');
  assert.deepEqual(storeSubject.missingFields, []);
  assert.equal(storeSubject.installWarning, null);
});

test('macOS Developer ID 签名、Apple 公证状态探测与临时 .p8 落盘', () => {
  // 1. 缺省空配置 -> unsigned
  const empty = resolveMacSigningStatus({ env: {} });
  assert.equal(empty.mode, 'unsigned');
  assert.equal(empty.signingMethod, 'none');
  assert.equal(empty.notarizeMethod, 'none');
  assert.equal(empty.missingFields.length, 2);
  assert.ok(empty.installWarning.includes('Gatekeeper'));

  // 2. 仅签名、无公证 -> signed-only（明确警告仍被 Gatekeeper 拦截）
  const signedOnly = resolveMacSigningStatus({
    env: { CSC_NAME: 'Hermes Flux Developer ID' },
  });
  assert.equal(signedOnly.mode, 'signed-only');
  assert.equal(signedOnly.signingMethod, 'keychain-csc-name');
  assert.equal(signedOnly.notarizeMethod, 'none');
  assert.ok(signedOnly.installWarning.includes('未完成 Apple 公证'));

  // 3. 真实含 / 的 Base64 P12 + App Store Connect API Key -> signed-and-notarized 且绝不泄露密文
  const realMacB64 = Buffer.from('-----BEGIN PRIVATE KEY-----\n>>>???<<<MAC_SECRET\n-----END PRIVATE KEY-----').toString('base64');
  assert.ok(realMacB64.includes('/'));
  const fullApiKey = resolveMacSigningStatus({
    env: {
      CSC_LINK: 'MIIP12/Secret+Blob==',
      CSC_KEY_PASSWORD: 'p12-password',
      APPLE_API_KEY: realMacB64,
      APPLE_API_KEY_ID: 'KEYID1',
      APPLE_API_ISSUER: 'ISSUER1',
    },
  });
  assert.equal(fullApiKey.mode, 'signed-and-notarized');
  assert.equal(fullApiKey.signingMethod, 'p12-csc-link');
  assert.equal(fullApiKey.notarizeMethod, 'app-store-connect-api-key');
  assert.deepEqual(fullApiKey.missingFields, []);
  assert.equal(fullApiKey.installWarning, null);
  const serializedMac = JSON.stringify(fullApiKey);
  assert.equal(serializedMac.includes('MIIP12/Secret+Blob=='), false);
  assert.equal(serializedMac.includes('p12-password'), false);
  assert.equal(serializedMac.includes(realMacB64), false);

  // 3b. prepareMacNotarizeEnv：Base64 落盘为 0600 临时 .p8 供 notarytool --key 消费
  assert.equal(typeof resolveMacSigningStatus().mode, 'string');
  assert.equal(prepareMacNotarizeEnv().tempAuthKeyPath, '');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-mac-notarize-'));
  try {
    const emptyPrep = prepareMacNotarizeEnv({ env: { APPLE_API_KEY: '   ' } });
    assert.equal(emptyPrep.tempAuthKeyPath, '');

    const diskPrep = prepareMacNotarizeEnv({
      env: { APPLE_API_KEY: '~/keys/AuthKey_DISK.p8' },
      homedir: '/home/mac',
    });
    assert.equal(diskPrep.tempAuthKeyPath, '');
    assert.equal(diskPrep.env.APPLE_API_KEY, path.join('/home/mac', 'keys/AuthKey_DISK.p8'));

    let capturedWriteOptions = null;
    const b64Prep = prepareMacNotarizeEnv({
      env: { APPLE_API_KEY: realMacB64, APPLE_API_KEY_ID: '../KEYID1' },
      tmpDir: tmpRoot,
      writeFile: (filePath, content, options) => {
        capturedWriteOptions = options;
        fs.writeFileSync(filePath, content, options);
      },
    });
    assert.deepEqual(capturedWriteOptions, { mode: 0o600 });
    assert.equal(path.dirname(b64Prep.tempAuthKeyPath), tmpRoot);
    assert.equal(path.basename(b64Prep.tempAuthKeyPath).startsWith('AuthKey_KEYID1_'), true);
    assert.equal(b64Prep.env.APPLE_API_KEY, b64Prep.tempAuthKeyPath);
    assert.ok(fs.readFileSync(b64Prep.tempAuthKeyPath, 'utf8').includes('MAC_SECRET'));

    const fallbackKeyIdPrep = prepareMacNotarizeEnv({
      env: { APPLE_API_KEY: realMacB64, APPLE_API_KEY_ID: '///' },
      tmpDir: tmpRoot,
    });
    assert.equal(path.basename(fallbackKeyIdPrep.tempAuthKeyPath).startsWith('AuthKey_key_'), true);

    const omittedKeyIdPrep = prepareMacNotarizeEnv({
      env: { APPLE_API_KEY: realMacB64 },
      tmpDir: tmpRoot,
    });
    assert.equal(path.basename(omittedKeyIdPrep.tempAuthKeyPath).startsWith('AuthKey_key_'), true);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }

  // 4. Apple ID 公证、Keychain Profile 公证及 APPLE_TEAM_ID 与 APPLE_KEYCHAIN_PROFILE 共存场景
  const fullAppleId = resolveMacSigningStatus({
    env: {
      CSC_NAME: 'Hermes Flux',
      APPLE_ID: 'dev@hermesflux.com',
      APPLE_APP_SPECIFIC_PASSWORD: 'xxxx-yyyy-zzzz-wwww',
      APPLE_TEAM_ID: 'TEAM1234',
    },
  });
  assert.equal(fullAppleId.mode, 'signed-and-notarized');
  assert.equal(fullAppleId.signingMethod, 'keychain-csc-name');
  assert.equal(fullAppleId.notarizeMethod, 'apple-id');
  assert.deepEqual(fullAppleId.missingFields, []);
  assert.equal(fullAppleId.installWarning, null);
  assert.equal(JSON.stringify(fullAppleId).includes('xxxx-yyyy-zzzz-wwww'), false);

  const fullProfileOnly = resolveMacSigningStatus({
    env: {
      CSC_NAME: 'Hermes Flux',
      APPLE_KEYCHAIN_PROFILE: 'hermes-notary-only',
    },
  });
  assert.equal(fullProfileOnly.mode, 'signed-and-notarized');
  assert.equal(fullProfileOnly.notarizeMethod, 'keychain-profile');
  assert.deepEqual(fullProfileOnly.missingFields, []);
  assert.equal(fullProfileOnly.installWarning, null);

  const fullProfileWithSharedTeamId = resolveMacSigningStatus({
    env: {
      CSC_NAME: 'Hermes Flux',
      APPLE_TEAM_ID: 'SHARED_IOS_TEAM_ID',
      APPLE_KEYCHAIN_PROFILE: 'hermes-notary',
    },
  });
  assert.equal(fullProfileWithSharedTeamId.mode, 'signed-and-notarized');
  assert.equal(fullProfileWithSharedTeamId.notarizeMethod, 'keychain-profile');
  assert.deepEqual(fullProfileWithSharedTeamId.missingFields, []);
  assert.equal(fullProfileWithSharedTeamId.installWarning, null);

  // 未配置 Developer ID 代码签名证书、仅配公证凭据时必须保持 unsigned（严禁误判 signed-and-notarized）
  const notarizeWithoutCertProfile = resolveMacSigningStatus({
    env: { APPLE_KEYCHAIN_PROFILE: 'hermes-notary' },
  });
  assert.equal(notarizeWithoutCertProfile.mode, 'unsigned');
  assert.equal(notarizeWithoutCertProfile.signingMethod, 'none');
  assert.equal(notarizeWithoutCertProfile.notarizeMethod, 'keychain-profile');
  assert.deepEqual(notarizeWithoutCertProfile.missingFields, ['CSC_LINK + CSC_KEY_PASSWORD (or CSC_NAME)']);
  assert.equal(
    assertDesktopSigningReady({ platform: 'macos', status: notarizeWithoutCertProfile, required: true }).ok,
    false,
  );

  const notarizeWithoutCertApiKey = resolveMacSigningStatus({
    env: {
      APPLE_API_KEY: realMacB64,
      APPLE_API_KEY_ID: 'KEYID1',
      APPLE_API_ISSUER: 'ISSUER1',
    },
  });
  assert.equal(notarizeWithoutCertApiKey.mode, 'unsigned');
  assert.equal(notarizeWithoutCertApiKey.signingMethod, 'none');
  assert.equal(notarizeWithoutCertApiKey.notarizeMethod, 'app-store-connect-api-key');
  assert.equal(
    assertDesktopSigningReady({ platform: 'macos', status: notarizeWithoutCertApiKey, required: true }).ok,
    false,
  );

  // 仅配置 APPLE_TEAM_ID（无 KEYCHAIN_PROFILE 与 APPLE_ID）必须保持 signed-only 且拒绝判为 notarized
  const teamIdAlone = resolveMacSigningStatus({
    env: {
      CSC_NAME: 'Hermes Flux',
      APPLE_TEAM_ID: 'TEAM_ONLY',
    },
  });
  assert.equal(teamIdAlone.mode, 'signed-only');
  assert.equal(teamIdAlone.notarizeMethod, 'none');
  assert.ok(teamIdAlone.missingFields.includes('APPLE_ID'));
  assert.ok(teamIdAlone.missingFields.includes('APPLE_APP_SPECIFIC_PASSWORD'));
  assert.equal(teamIdAlone.missingFields.includes('APPLE_TEAM_ID'), false);

  const teamPlusAppleIdOnly = resolveMacSigningStatus({
    env: {
      CSC_NAME: 'Hermes Flux',
      APPLE_TEAM_ID: 'TEAM1',
      APPLE_ID: 'dev@hermesflux.com',
    },
  });
  assert.equal(teamPlusAppleIdOnly.mode, 'signed-only');
  assert.equal(teamPlusAppleIdOnly.notarizeMethod, 'none');
  assert.deepEqual(teamPlusAppleIdOnly.missingFields, ['APPLE_APP_SPECIFIC_PASSWORD']);

  // 5. 半残/文件缺失路径检查
  const brokenPaths = resolveMacSigningStatus({
    env: {
      CSC_LINK: '/missing/cert.p12',
      APPLE_API_KEY: '/missing/AuthKey.p8',
    },
    fileExists: () => false,
  });
  assert.equal(brokenPaths.mode, 'unsigned');
  assert.equal(brokenPaths.signingMethod, 'none');
  assert.equal(brokenPaths.notarizeMethod, 'none');
  assert.ok(brokenPaths.missingFields.includes('CSC_LINK file missing'));
  assert.ok(brokenPaths.missingFields.includes('CSC_KEY_PASSWORD'));
  assert.ok(brokenPaths.missingFields.includes('APPLE_API_KEY file missing'));
  assert.ok(brokenPaths.missingFields.includes('APPLE_API_KEY_ID'));
  assert.ok(brokenPaths.missingFields.includes('APPLE_API_ISSUER'));

  const partialReverse = resolveMacSigningStatus({
    env: {
      CSC_KEY_PASSWORD: 'pw-only',
      APPLE_API_KEY_ID: 'id-only',
    },
  });
  assert.equal(partialReverse.mode, 'unsigned');
  assert.equal(partialReverse.signingMethod, 'none');
  assert.equal(partialReverse.notarizeMethod, 'none');
  assert.ok(partialReverse.missingFields.includes('CSC_LINK'));
  assert.ok(partialReverse.missingFields.includes('APPLE_API_KEY'));
  assert.ok(partialReverse.missingFields.includes('APPLE_API_ISSUER'));

  const validFilesMissingFields = resolveMacSigningStatus({
    env: {
      CSC_LINK: '/exists.p12',
      APPLE_API_KEY: '/exists.p8',
      APPLE_API_KEY_ID: 'KEY1',
    },
    fileExists: () => true,
  });
  assert.equal(validFilesMissingFields.mode, 'unsigned');
  assert.equal(validFilesMissingFields.signingMethod, 'none');
  assert.equal(validFilesMissingFields.notarizeMethod, 'none');
  assert.ok(validFilesMissingFields.missingFields.includes('CSC_KEY_PASSWORD'));
  assert.ok(validFilesMissingFields.missingFields.includes('APPLE_API_ISSUER'));

  const apiKeyFileMissingWithIds = resolveMacSigningStatus({
    env: {
      CSC_NAME: 'Hermes',
      APPLE_API_KEY: '/missing/Key.p8',
      APPLE_API_KEY_ID: 'KEY1',
      APPLE_API_ISSUER: 'ISS1',
    },
    fileExists: () => false,
  });
  assert.equal(apiKeyFileMissingWithIds.mode, 'signed-only');
  assert.equal(apiKeyFileMissingWithIds.notarizeMethod, 'none');

  const apiKeyIdsWithoutKey = resolveMacSigningStatus({
    env: {
      CSC_NAME: 'Hermes',
      APPLE_API_KEY_ID: 'KEY1',
      APPLE_API_ISSUER: 'ISS1',
    },
  });
  assert.equal(apiKeyIdsWithoutKey.mode, 'signed-only');
  assert.equal(apiKeyIdsWithoutKey.notarizeMethod, 'none');
  assert.deepEqual(apiKeyIdsWithoutKey.missingFields, ['APPLE_API_KEY']);

  const apiKeyMissingKeyId = resolveMacSigningStatus({
    env: {
      CSC_NAME: 'Hermes',
      APPLE_API_KEY: realMacB64,
      APPLE_API_ISSUER: 'ISS1',
    },
  });
  assert.equal(apiKeyMissingKeyId.mode, 'signed-only');
  assert.equal(apiKeyMissingKeyId.notarizeMethod, 'none');
  assert.deepEqual(apiKeyMissingKeyId.missingFields, ['APPLE_API_KEY_ID']);

  const partialAppleId = resolveMacSigningStatus({
    env: {
      CSC_LINK: '/exists.p12',
      CSC_KEY_PASSWORD: 'pw',
      APPLE_ID: 'a@b.com',
    },
    fileExists: (p) => p === '/exists.p12',
  });
  assert.equal(partialAppleId.mode, 'signed-only');
  assert.equal(partialAppleId.notarizeMethod, 'none');
  assert.ok(partialAppleId.missingFields.includes('APPLE_APP_SPECIFIC_PASSWORD'));
  assert.ok(partialAppleId.missingFields.includes('APPLE_TEAM_ID'));

  const partialAppleIdReverse = resolveMacSigningStatus({
    env: {
      CSC_NAME: 'Dev',
      APPLE_APP_SPECIFIC_PASSWORD: 'pw',
    },
  });
  assert.equal(partialAppleIdReverse.mode, 'signed-only');
  assert.equal(partialAppleIdReverse.notarizeMethod, 'none');
  assert.ok(partialAppleIdReverse.missingFields.includes('APPLE_ID'));
  assert.ok(partialAppleIdReverse.missingFields.includes('APPLE_TEAM_ID'));
});

test('Desktop 严格签名门禁、CLI 解析、env 转发、Authenticode 核验与参数拼装', () => {
  // 0. CLI 解析与 WIN_CSC_KEY_PASSWORD -> CSC_KEY_PASSWORD 转发及 Authenticode 校验
  assert.deepEqual(parseWinPackagerArgs(), {
    isDirOnly: false,
    isNsis: false,
    isPortable: false,
    isDryRun: false,
    targetMode: 'zip',
  });
  assert.deepEqual(parseWinPackagerArgs(null), {
    isDirOnly: false,
    isNsis: false,
    isPortable: false,
    isDryRun: false,
    targetMode: 'zip',
  });
  assert.deepEqual(parseWinPackagerArgs([]), {
    isDirOnly: false,
    isNsis: false,
    isPortable: false,
    isDryRun: false,
    targetMode: 'zip',
  });
  assert.deepEqual(parseWinPackagerArgs(['--nsis', '--dry-run']), {
    isDirOnly: false,
    isNsis: true,
    isPortable: false,
    isDryRun: true,
    targetMode: 'nsis',
  });
  assert.deepEqual(parseWinPackagerArgs(['--portable']), {
    isDirOnly: false,
    isNsis: false,
    isPortable: true,
    isDryRun: false,
    targetMode: 'portable',
  });
  assert.deepEqual(parseWinPackagerArgs(['--dir']), {
    isDirOnly: true,
    isNsis: false,
    isPortable: false,
    isDryRun: false,
    targetMode: 'dir',
  });

  assert.deepEqual(parseMacPackagerArgs(), { isDirOnly: false, isDryRun: false, arch: '' });
  assert.deepEqual(parseMacPackagerArgs(['--dir', '--dry-run', '--arch=universal']), {
    isDirOnly: true,
    isDryRun: true,
    arch: 'universal',
  });
  assert.deepEqual(parseMacPackagerArgs([123, '--arch=arm64']), {
    isDirOnly: false,
    isDryRun: false,
    arch: 'arm64',
  });
  assert.deepEqual(parseMacPackagerArgs(null), { isDirOnly: false, isDryRun: false, arch: '' });

  assert.equal(typeof resolveWindowsPackagerEnv(), 'object');
  assert.equal(resolveWindowsPackagerEnv({}).CSC_KEY_PASSWORD, undefined);
  assert.equal(resolveWindowsPackagerEnv({ CSC_KEY_PASSWORD: 'keep-me' }).CSC_KEY_PASSWORD, 'keep-me');
  const forwarded = resolveWindowsPackagerEnv({ WIN_CSC_KEY_PASSWORD: '  win-pw  ' });
  assert.equal(forwarded.CSC_KEY_PASSWORD, 'win-pw');
  const whitespaceOverwrite = resolveWindowsPackagerEnv({
    WIN_CSC_KEY_PASSWORD: 'win-pw',
    CSC_KEY_PASSWORD: '   ',
  });
  assert.equal(whitespaceOverwrite.CSC_KEY_PASSWORD, 'win-pw');
  const preserved = resolveWindowsPackagerEnv({
    WIN_CSC_KEY_PASSWORD: 'win-pw',
    CSC_KEY_PASSWORD: 'explicit-csc-pw',
  });
  assert.equal(preserved.CSC_KEY_PASSWORD, 'explicit-csc-pw');

  assert.deepEqual(evaluateWindowsAuthenticodeChecks(), { ok: true });
  assert.deepEqual(evaluateWindowsAuthenticodeChecks({ results: [], signingRequired: false }), { ok: true });
  const emptyWinFail = evaluateWindowsAuthenticodeChecks({ signingRequired: true });
  assert.equal(emptyWinFail.ok, false);
  assert.ok(emptyWinFail.error.includes('未找到'));

  assert.deepEqual(
    evaluateWindowsAuthenticodeChecks({
      results: [{ file: 'setup.exe', exitCode: 0, error: null, stdout: 'NotSigned' }],
    }),
    { ok: true },
  );

  const emptyStdoutFail = evaluateWindowsAuthenticodeChecks({
    results: [{ file: 'setup.exe', exitCode: 0, error: null, stdout: '' }],
    signingRequired: true,
  });
  assert.equal(emptyStdoutFail.ok, false);
  assert.ok(emptyStdoutFail.error.includes('Unknown'));
  assert.ok(emptyStdoutFail.error.includes('Subject=none'));

  const psErrFail = evaluateWindowsAuthenticodeChecks({
    results: [{ file: 'setup.exe', exitCode: 1, error: null, stdout: '' }],
    signingRequired: true,
  });
  assert.equal(psErrFail.ok, false);
  assert.ok(psErrFail.error.includes('Authenticode 校验异常'));

  const psThrownFail = evaluateWindowsAuthenticodeChecks({
    results: [{ file: 'setup.exe', exitCode: 0, error: new Error('ps crash'), stdout: '' }],
    signingRequired: true,
  });
  assert.equal(psThrownFail.ok, false);
  assert.ok(psThrownFail.error.includes('Authenticode 校验异常'));

  const psErrNonStrict = evaluateWindowsAuthenticodeChecks({
    results: [{ file: 'setup.exe', exitCode: 1, error: null, stdout: '' }],
    signingRequired: false,
  });
  assert.deepEqual(psErrNonStrict, { ok: true });

  const badSigNonStrict = evaluateWindowsAuthenticodeChecks({
    results: [{ file: 'setup.exe', exitCode: 0, error: null, stdout: 'HashMismatch|CN=Other' }],
    signingRequired: false,
  });
  assert.deepEqual(badSigNonStrict, { ok: true });

  const notSignedFail = evaluateWindowsAuthenticodeChecks({
    results: [{ file: 'setup.exe', exitCode: 0, error: null, stdout: 'NotSigned|' }],
    signingRequired: true,
  });
  assert.equal(notSignedFail.ok, false);
  assert.ok(notSignedFail.error.includes('NotSigned'));
  assert.ok(notSignedFail.error.includes('Subject=none'));

  const badSigFail = evaluateWindowsAuthenticodeChecks({
    results: [{ file: 'setup.exe', exitCode: 0, error: null, stdout: '|NoCert' }],
    signingRequired: true,
  });
  assert.equal(badSigFail.ok, false);
  assert.ok(badSigFail.error.includes('Unknown'));

  assert.deepEqual(
    evaluateWindowsAuthenticodeChecks({
      results: [{ file: 'setup.exe', exitCode: 0, error: null, stdout: 'Valid|CN=Hermes Flux\n' }],
      signingRequired: true,
    }),
    { ok: true },
  );

  // 1. 严格开关解析
  assert.equal(isDesktopSigningRequired(), false);
  assert.equal(isDesktopSigningRequired({ platform: 'windows', argv: [], env: {} }), false);
  assert.equal(isDesktopSigningRequired({ platform: 'windows', argv: ['--require-signing'], env: {} }), true);
  assert.equal(isDesktopSigningRequired({ platform: 'windows', argv: [], env: { FLUX_REQUIRE_SIGNING: '1' } }), true);
  assert.equal(isDesktopSigningRequired({ platform: 'windows', env: { WIN_REQUIRE_SIGNING: '1' } }), true);
  assert.equal(isDesktopSigningRequired({ platform: 'windows', argv: [], env: { WIN_REQUIRE_SIGNING: 'true' } }), true);
  assert.equal(isDesktopSigningRequired({ platform: 'windows', argv: [], env: { WIN_REQUIRE_SIGNING: '0' } }), false);
  assert.equal(isDesktopSigningRequired({ platform: 'macos', argv: [], env: { WIN_REQUIRE_SIGNING: 'true' } }), false);
  assert.equal(isDesktopSigningRequired({ platform: 'macos', argv: [], env: { MAC_REQUIRE_SIGNING: 'true' } }), true);
  assert.equal(isDesktopSigningRequired({ platform: 'linux', argv: [], env: { WIN_REQUIRE_SIGNING: 'true' } }), false);
  assert.equal(isDesktopSigningRequired({ platform: 'linux', argv: [], env: { MAC_REQUIRE_SIGNING: 'true' } }), false);
  assert.equal(isDesktopSigningRequired({ platform: 'macos', argv: null, env: { MAC_REQUIRE_SIGNING: '0' } }), false);

  // 2. fail-closed 裁决：Windows 拒绝 unsigned；macOS 同时拒绝 unsigned 与 signed-only
  assert.deepEqual(assertDesktopSigningReady({ platform: 'windows', status: { mode: 'unsigned' }, required: false }), {
    ok: true,
    mode: 'unsigned',
  });
  assert.deepEqual(assertDesktopSigningReady({ platform: 'windows', status: null, required: false }), {
    ok: true,
    mode: 'unsigned',
  });
  const winFail = assertDesktopSigningReady({
    platform: 'windows',
    status: { mode: 'unsigned', missingFields: ['WIN_CSC_LINK'] },
    required: true,
  });
  assert.equal(winFail.ok, false);
  assert.ok(winFail.error.includes('[desktop:package:win]'));
  assert.ok(winFail.error.includes('需要正式代码签名凭据'));
  assert.equal(winFail.error.includes('Apple 公证'), false);
  assert.ok(winFail.error.includes('WIN_CSC_LINK'));
  assert.ok(winFail.error.includes('cross-platform-release-signing.md'));

  const macSignedOnlyFail = assertDesktopSigningReady({
    platform: 'macos',
    status: { mode: 'signed-only', missingFields: [] },
    required: true,
  });
  assert.equal(macSignedOnlyFail.ok, false);
  assert.ok(macSignedOnlyFail.error.includes('[desktop:package:mac]'));
  assert.ok(macSignedOnlyFail.error.includes('需要 Developer ID 代码签名 + Apple 公证'));
  assert.ok(macSignedOnlyFail.error.includes('macos signing configuration missing'));

  const macUnsignedFail = assertDesktopSigningReady({
    platform: 'macos',
    status: { mode: 'unsigned', missingFields: ['CSC_NAME'] },
    required: true,
  });
  assert.equal(macUnsignedFail.ok, false);
  assert.ok(macUnsignedFail.error.includes('CSC_NAME'));

  const winNullRequiredFail = assertDesktopSigningReady({
    platform: 'windows',
    status: null,
    required: true,
  });
  assert.equal(winNullRequiredFail.ok, false);
  assert.ok(winNullRequiredFail.error.includes('windows signing configuration missing'));

  const macNullRequiredFail = assertDesktopSigningReady({
    platform: 'macos',
    status: null,
    required: true,
  });
  assert.equal(macNullRequiredFail.ok, false);
  assert.ok(macNullRequiredFail.error.includes('macos signing configuration missing'));

  assert.deepEqual(
    assertDesktopSigningReady({
      platform: 'macos',
      status: { mode: 'signed-and-notarized', missingFields: [] },
      required: true,
    }),
    { ok: true, mode: 'signed-and-notarized' },
  );
  assert.deepEqual(
    assertDesktopSigningReady({
      platform: 'windows',
      status: { mode: 'pfx-file', missingFields: [] },
      required: true,
    }),
    { ok: true, mode: 'pfx-file' },
  );

  // 3. Windows electron-builder 参数拼装（不泄露任何密码）
  const winAzureArgs = buildWindowsElectronBuilderArgs({
    outputDir: '/out/win',
    targetMode: 'nsis',
    signingStatus: {
      mode: 'azure-trusted-signing',
      azureOptions: {
        endpoint: 'https://eus.codesigning.azure.net/',
        codeSigningAccountName: 'acct',
        certificateProfileName: 'prof',
        publisherName: 'CN=Hermes Flux',
      },
    },
    requireSigning: true,
  });
  assert.deepEqual(winAzureArgs, [
    '--win',
    'nsis',
    '--x64',
    '-c.directories.output=/out/win',
    '-c.forceCodeSigning=true',
    '-c.win.azureSignOptions.endpoint=https://eus.codesigning.azure.net/',
    '-c.win.azureSignOptions.codeSigningAccountName=acct',
    '-c.win.azureSignOptions.certificateProfileName=prof',
    '-c.win.azureSignOptions.publisherName=CN=Hermes Flux',
  ]);

  const winPortableStoreArgs = buildWindowsElectronBuilderArgs({
    outputDir: '/out/win-p',
    targetMode: 'portable',
    signingStatus: {
      mode: 'cert-store',
      certificateSha1: 'SHA1HASH',
      certificateSubjectName: 'Hermes Flux',
    },
    requireSigning: false,
  });
  assert.deepEqual(winPortableStoreArgs, [
    '--win',
    'portable',
    '--x64',
    '-c.directories.output=/out/win-p',
    '-c.win.signtoolOptions.certificateSha1=SHA1HASH',
    '-c.win.signtoolOptions.certificateSubjectName=Hermes Flux',
  ]);

  const winZipArgs = buildWindowsElectronBuilderArgs({
    outputDir: '/out/win-z',
    signingStatus: { mode: 'unsigned' },
  });
  assert.deepEqual(winZipArgs, ['--win', '--x64', '-c.directories.output=/out/win-z', '--dir']);

  const winStorePartial = buildWindowsElectronBuilderArgs({
    outputDir: '/out/win-s',
    targetMode: 'dir',
    signingStatus: { mode: 'cert-store', certificateSha1: '', certificateSubjectName: '' },
  });
  assert.deepEqual(winStorePartial, ['--win', '--x64', '-c.directories.output=/out/win-s', '--dir']);

  const winAzureNullOpts = buildWindowsElectronBuilderArgs({
    outputDir: '/out/win-az-null',
    signingStatus: { mode: 'azure-trusted-signing', azureOptions: null },
  });
  assert.deepEqual(winAzureNullOpts, ['--win', '--x64', '-c.directories.output=/out/win-az-null', '--dir']);

  const winPfxIgnoreStore = buildWindowsElectronBuilderArgs({
    outputDir: '/out/win-pfx-ign',
    targetMode: 'nsis',
    signingStatus: { mode: 'pfx-file', certificateSha1: 'IGN', certificateSubjectName: 'IGN' },
  });
  assert.deepEqual(winPfxIgnoreStore, ['--win', 'nsis', '--x64', '-c.directories.output=/out/win-pfx-ign']);

  // 4. macOS electron-builder 参数拼装（动态控制 notarize 与 identity=null）
  const macNotarizedArgs = buildMacElectronBuilderArgs({
    outputDir: '/out/mac',
    arch: 'universal',
    signingStatus: { mode: 'signed-and-notarized' },
    requireSigning: true,
  });
  assert.deepEqual(macNotarizedArgs, [
    '--mac',
    '--universal',
    '-c.directories.output=/out/mac',
    '-c.forceCodeSigning=true',
    '-c.mac.notarize=true',
  ]);

  const macUnsignedDirArgs = buildMacElectronBuilderArgs({
    outputDir: '/out/mac-dir',
    isDirOnly: true,
    arch: 'arm64',
    signingStatus: { mode: 'unsigned' },
    requireSigning: false,
  });
  assert.deepEqual(macUnsignedDirArgs, [
    '--mac',
    '--arm64',
    '--dir',
    '-c.directories.output=/out/mac-dir',
    '-c.mac.notarize=false',
    '-c.mac.identity=null',
  ]);

  const macX64SignedOnlyArgs = buildMacElectronBuilderArgs({
    outputDir: '/out/mac-x64',
    arch: 'x64',
    signingStatus: { mode: 'signed-only' },
  });
  assert.deepEqual(macX64SignedOnlyArgs, [
    '--mac',
    '--x64',
    '-c.directories.output=/out/mac-x64',
    '-c.mac.notarize=false',
  ]);

  const macDefaultArchArgs = buildMacElectronBuilderArgs({
    outputDir: '/out/mac-noarch',
    signingStatus: { mode: 'signed-only' },
  });
  assert.deepEqual(macDefaultArchArgs, ['--mac', '-c.directories.output=/out/mac-noarch', '-c.mac.notarize=false']);
});
