/**
 * Desktop（Windows / macOS）代码签名与公证配置解析器（只读探测，绝不泄露机密）。
 *
 * 【设计意图 (Why)】
 *   electron-builder 默认在未配置签名凭据时静默跳过签名与 Apple 公证（Notarization），
 *   导致正式打包产物一不小心就落盘成无签名/未公证包，在 Windows SmartScreen 和
 *   macOS Gatekeeper 上弹窗拦截或直接提示“已损坏”。
 *   本模块为打包脚本与 `signing:check` 诊断器提供唯一真值源，支持本地无凭据试打包、
 *   严格发行模式（`--require-signing`）fail-closed 拦截与零凭据泄露的参数拼装。
 *
 * 【防范的历史坑 (Pitfall)】
 *   1. 将 `CSC_LINK` / `WIN_CSC_LINK` base64 密文或口令写入状态返回值或 CLI 参数会在 CI 日志泄露；
 *   2. Base64 凭据常含 `/` 与 `data:...;base64,` 前缀，仅凭 `/` 判定文件路径会误拒合法 Base64；
 *   3. `electron-builder` 仅读取 `CSC_KEY_PASSWORD` 兜底而 `WIN_CSC_KEY_PASSWORD` 需由外层转发；
 *   4. `@electron/notarize` 仅支持 `.p8` 磁盘路径且只对 `.app` 装订公证票据（不直接装订 `.dmg`）；
 *   5. macOS 同时设 `APPLE_TEAM_ID`（iOS 复用）与 `APPLE_KEYCHAIN_PROFILE` 时不应误判为残缺 Apple ID。
 *
 * 【约束与规则 (Rules)】
 *   - 严禁在返回结果、日志、错误或 CLI 参数中出现任何口令、密钥内容、base64 证书或 Client Secret；
 *   - `electron-builder` 26.18.0 下 Windows 仅使用 `win.signtoolOptions` / `win.azureSignOptions`；
 *   - 严格模式下 Windows 拒绝 `unsigned`，macOS 拒绝 `unsigned` 与 `signed-only`（必须 `signed-and-notarized`）。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function isTruthyFlag(val) {
  if (typeof val !== 'string') return false;
  const normalized = val.trim().toLowerCase();
  return normalized === '1' || normalized === 'true';
}

/**
 * 判断凭据值是否为本地文件路径（精确区分含 `/` 的 Base64 密文、带参数 `data:` URI、PEM 与远程 URL）。
 * 注：与 ios-signing-config.mjs 保持包内零依赖独立实现，确保 desktop/mobile 薄壳不互耦且各域 Stryker 沙盒可无构建独立执行。
 */
export function looksLikeFilePath(value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (
    !trimmed ||
    /^-----BEGIN\b/i.test(trimmed) ||
    /^data:[^,]*;base64,/i.test(trimmed) ||
    /^(?:https?|file):\/\//i.test(trimmed)
  ) {
    return false;
  }
  const compact = trimmed.replace(/\s+/g, '');
  const looksLikeBase64Blob =
    compact.length >= 16 &&
    !/^[/.~]/.test(compact) &&
    !compact.includes('\\') &&
    !compact.includes(':') &&
    !/\.(?:p8|p12|pfx|pem|key|cer|mobileprovision)$/i.test(compact) &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(compact) &&
    (compact.endsWith('=') ||
      (compact.length % 4 !== 1 &&
        ((compact.includes('+') && compact.length >= 24) || compact.length >= 64)));
  if (looksLikeBase64Blob) {
    return false;
  }
  return (
    /[\\/]/.test(trimmed) ||
    trimmed.startsWith('~/') ||
    trimmed.startsWith('~\\') ||
    /\.(p8|p12|pfx|pem|key|cer|mobileprovision)$/i.test(trimmed)
  );
}

/**
 * 展开本地文件路径中的 `~/` 前缀，确保 `fs.existsSync` 可正确探测用户目录文件。
 */
export function resolveLocalFilePath(rawPath, homedir = os.homedir()) {
  const trimmed = String(rawPath || '').trim();
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return path.join(homedir, trimmed.slice(2));
  }
  return trimmed;
}

/**
 * 解码 Base64 / `data:...;base64,` / PEM 格式的 Apple API Key（`.p8`）正文。
 */
export function decodeAppleApiKeyPem(rawApiKey) {
  const trimmed = String(rawApiKey || '').trim();
  if (/^-----BEGIN\b/i.test(trimmed)) {
    return trimmed;
  }
  const dataUriMatch = /^data:[^,]*;base64,([\s\S]+)$/i.exec(trimmed);
  const b64Payload = (dataUriMatch ? dataUriMatch[1] : trimmed).replace(/\s+/g, '');
  return Buffer.from(b64Payload, 'base64').toString('utf8');
}

/**
 * 为 `@electron/notarize` 准备磁盘 `.p8` 路径（若输入为 Base64/PEM 则写入 `0600` 临时文件并由调用方 `finally` 删除）。
 */
export function prepareMacNotarizeEnv({
  env = process.env,
  tmpDir = os.tmpdir(),
  homedir = os.homedir(),
  writeFile = fs.writeFileSync,
} = {}) {
  const rawApiKey = String(env.APPLE_API_KEY || '').trim();
  if (!rawApiKey) {
    return { env: { ...env }, tempAuthKeyPath: '' };
  }
  if (looksLikeFilePath(rawApiKey)) {
    return {
      env: { ...env, APPLE_API_KEY: resolveLocalFilePath(rawApiKey, homedir) },
      tempAuthKeyPath: '',
    };
  }
  const safeKeyId = String(env.APPLE_API_KEY_ID || 'key').replace(/[^A-Za-z0-9_-]/g, '') || 'key';
  const tempAuthKeyPath = path.join(
    tmpDir,
    `AuthKey_${safeKeyId}_${crypto.randomBytes(4).toString('hex')}.p8`,
  );
  writeFile(tempAuthKeyPath, decodeAppleApiKeyPem(rawApiKey), { mode: 0o600 });
  return {
    env: { ...env, APPLE_API_KEY: tempAuthKeyPath },
    tempAuthKeyPath,
  };
}

/**
 * 探测 Windows Authenticode / Azure Trusted Signing 配置状态。
 */
export function resolveWindowsSigningStatus({
  env = process.env,
  fileExists = fs.existsSync,
  homedir = os.homedir(),
} = {}) {
  const azureEndpoint = String(env.AZURE_SIGNING_ENDPOINT || '').trim();
  const azureAccount = String(env.AZURE_SIGNING_ACCOUNT_NAME || '').trim();
  const azureProfile = String(env.AZURE_SIGNING_CERT_PROFILE_NAME || '').trim();
  const azurePublisher = String(env.AZURE_SIGNING_PUBLISHER_NAME || '').trim();
  const anyAzure = Boolean(azureEndpoint || azureAccount || azureProfile || azurePublisher);

  if (anyAzure) {
    const missingFields = [];
    if (!azureEndpoint) missingFields.push('AZURE_SIGNING_ENDPOINT');
    if (!azureAccount) missingFields.push('AZURE_SIGNING_ACCOUNT_NAME');
    if (!azureProfile) missingFields.push('AZURE_SIGNING_CERT_PROFILE_NAME');
    if (!azurePublisher) missingFields.push('AZURE_SIGNING_PUBLISHER_NAME');

    const tenantId = String(env.AZURE_TENANT_ID || '').trim();
    const clientId = String(env.AZURE_CLIENT_ID || '').trim();
    const clientSecret = String(env.AZURE_CLIENT_SECRET || '').trim();
    const fedTokenFile = String(env.AZURE_FEDERATED_TOKEN_FILE || '').trim();
    const useCliAuth = isTruthyFlag(env.AZURE_USE_CLI_AUTH);

    const hasSecretAuth = Boolean(tenantId && clientId && clientSecret);
    const hasFederatedAuth = Boolean(tenantId && clientId && fedTokenFile);
    const hasAzureAuth = hasSecretAuth || hasFederatedAuth || useCliAuth;
    if (!hasAzureAuth) {
      missingFields.push(
        'Azure Entra auth (AZURE_TENANT_ID + AZURE_CLIENT_ID + AZURE_CLIENT_SECRET/AZURE_FEDERATED_TOKEN_FILE, or AZURE_USE_CLI_AUTH=1)',
      );
    }

    if (missingFields.length === 0) {
      return {
        mode: 'azure-trusted-signing',
        source: 'azure-env',
        azureOptions: {
          endpoint: azureEndpoint,
          codeSigningAccountName: azureAccount,
          certificateProfileName: azureProfile,
          publisherName: azurePublisher,
        },
        certificateSubjectName: null,
        certificateSha1: null,
        missingFields: [],
        installWarning: null,
      };
    }

    return {
      mode: 'unsigned',
      source: 'azure-env',
      azureOptions: null,
      certificateSubjectName: null,
      certificateSha1: null,
      missingFields,
      installWarning:
        'Azure Trusted Signing 配置不完整，Windows 产物将跳过签名并触发 Microsoft Defender SmartScreen“未知发布者”警告。',
    };
  }

  const winLink = String(env.WIN_CSC_LINK || '').trim();
  const globalLink = String(env.CSC_LINK || '').trim();
  const cscLink = winLink || globalLink;
  const cscPassword = String(env.WIN_CSC_KEY_PASSWORD || env.CSC_KEY_PASSWORD || '').trim();
  const linkSource = winLink ? 'WIN_CSC_LINK' : globalLink ? 'CSC_LINK' : 'env';

  if (cscLink || cscPassword) {
    const missingFields = [];
    const linkIsPath = looksLikeFilePath(cscLink);
    const linkFileOk = !linkIsPath || fileExists(resolveLocalFilePath(cscLink, homedir));
    if (!cscLink) missingFields.push('WIN_CSC_LINK / CSC_LINK');
    else if (!linkFileOk) missingFields.push('WIN_CSC_LINK file missing');
    if (!cscPassword) missingFields.push('WIN_CSC_KEY_PASSWORD / CSC_KEY_PASSWORD');

    if (missingFields.length === 0) {
      return {
        mode: 'pfx-file',
        source: linkSource,
        azureOptions: null,
        certificateSubjectName: null,
        certificateSha1: null,
        missingFields: [],
        installWarning:
          '已配置 PFX/P12 代码签名证书：若使用普通 OV 证书（非 EV 或 Azure Trusted Signing），新证书初期在部分 Windows 设备上仍可能提示 SmartScreen 声誉建立中。',
      };
    }

    return {
      mode: 'unsigned',
      source: linkSource,
      azureOptions: null,
      certificateSubjectName: null,
      certificateSha1: null,
      missingFields,
      installWarning:
        'Windows PFX 签名凭据不完整，产物将保持未签名状态并触发 SmartScreen“Windows 已保护你的电脑 / 未知发布者”拦截。',
    };
  }

  const sha1 = String(env.WIN_CSC_SHA1 || env.WIN_CSC_THUMBPRINT || '').trim();
  const subjectName = String(env.WIN_CSC_SUBJECT_NAME || '').trim();
  if (sha1 || subjectName) {
    return {
      mode: 'cert-store',
      source: sha1 ? 'WIN_CSC_SHA1' : 'WIN_CSC_SUBJECT_NAME',
      azureOptions: null,
      certificateSubjectName: subjectName || null,
      certificateSha1: sha1 || null,
      missingFields: [],
      installWarning: null,
    };
  }

  return {
    mode: 'unsigned',
    source: 'none',
    azureOptions: null,
    certificateSubjectName: null,
    certificateSha1: null,
    missingFields: [
      'AZURE_SIGNING_* (recommended), WIN_CSC_LINK + WIN_CSC_KEY_PASSWORD, or WIN_CSC_SHA1 / WIN_CSC_SUBJECT_NAME',
    ],
    installWarning:
      '当前未配置 Windows 代码签名凭据；安装包与可执行文件将触发 Microsoft Defender SmartScreen“Windows 已保护你的电脑 / 未知发布者”警告。',
  };
}

/**
 * 探测 macOS Developer ID 代码签名与 Apple 公证（Notarization）配置状态。
 */
export function resolveMacSigningStatus({
  env = process.env,
  fileExists = fs.existsSync,
  homedir = os.homedir(),
} = {}) {
  const cscLink = String(env.CSC_LINK || '').trim();
  const cscPassword = String(env.CSC_KEY_PASSWORD || '').trim();
  const cscName = String(env.CSC_NAME || '').trim();

  const missingFields = [];
  let signingMethod = 'none';

  if (cscLink || cscPassword) {
    const linkIsPath = looksLikeFilePath(cscLink);
    const linkFileOk = !linkIsPath || fileExists(resolveLocalFilePath(cscLink, homedir));
    if (!cscLink) missingFields.push('CSC_LINK');
    else if (!linkFileOk) missingFields.push('CSC_LINK file missing');
    if (!cscPassword) missingFields.push('CSC_KEY_PASSWORD');
    if (cscLink && cscPassword && linkFileOk) {
      signingMethod = 'p12-csc-link';
    }
  } else if (cscName) {
    signingMethod = 'keychain-csc-name';
  } else {
    missingFields.push('CSC_LINK + CSC_KEY_PASSWORD (or CSC_NAME)');
  }

  const apiKey = String(env.APPLE_API_KEY || '').trim();
  const apiKeyId = String(env.APPLE_API_KEY_ID || '').trim();
  const apiIssuer = String(env.APPLE_API_ISSUER || '').trim();

  const appleId = String(env.APPLE_ID || '').trim();
  const applePass = String(env.APPLE_APP_SPECIFIC_PASSWORD || '').trim();
  const appleTeam = String(env.APPLE_TEAM_ID || '').trim();
  const keychainProfile = String(env.APPLE_KEYCHAIN_PROFILE || '').trim();

  let notarizeMethod = 'none';
  if (apiKey || apiKeyId || apiIssuer) {
    const apiKeyIsPath = looksLikeFilePath(apiKey);
    const apiKeyFileOk = !apiKeyIsPath || fileExists(resolveLocalFilePath(apiKey, homedir));
    if (!apiKey) missingFields.push('APPLE_API_KEY');
    else if (!apiKeyFileOk) missingFields.push('APPLE_API_KEY file missing');
    if (!apiKeyId) missingFields.push('APPLE_API_KEY_ID');
    if (!apiIssuer) missingFields.push('APPLE_API_ISSUER');
    if (apiKey && apiKeyId && apiIssuer && apiKeyFileOk) {
      notarizeMethod = 'app-store-connect-api-key';
    }
  } else if (appleId || applePass || (appleTeam && !keychainProfile)) {
    if (!appleId) missingFields.push('APPLE_ID');
    if (!applePass) missingFields.push('APPLE_APP_SPECIFIC_PASSWORD');
    if (!appleTeam) missingFields.push('APPLE_TEAM_ID');
    if (appleId && applePass && appleTeam) {
      notarizeMethod = 'apple-id';
    }
  } else if (keychainProfile) {
    notarizeMethod = 'keychain-profile';
  } else {
    missingFields.push(
      'APPLE_API_KEY + APPLE_API_KEY_ID + APPLE_API_ISSUER (or APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID, or APPLE_KEYCHAIN_PROFILE)',
    );
  }

  let mode = 'unsigned';
  if (signingMethod !== 'none' && notarizeMethod !== 'none') {
    mode = 'signed-and-notarized';
  } else if (signingMethod !== 'none') {
    mode = 'signed-only';
  }

  let installWarning = null;
  if (mode === 'unsigned') {
    installWarning =
      '当前未配置 macOS Developer ID 证书与 Apple 公证凭据；从浏览器下载后 macOS Gatekeeper 将拦截运行并提示“无法验证开发者”或“已损坏”。';
  } else if (mode === 'signed-only') {
    installWarning =
      '当前仅配置了代码签名、未完成 Apple 公证（Notarization）；从浏览器下载后 macOS Gatekeeper 仍会阻止打开并提示“无法检查是否包含恶意软件”。';
  }

  return {
    mode,
    signingMethod,
    notarizeMethod,
    missingFields,
    installWarning,
  };
}

/**
 * 解析 Windows 打包 CLI 参数。
 */
export function parseWinPackagerArgs(argv = []) {
  const list = Array.isArray(argv) ? argv : [];
  const isDirOnly = list.includes('--dir');
  const isNsis = list.includes('--nsis');
  const isPortable = list.includes('--portable');
  const isDryRun = list.includes('--dry-run');
  const targetMode = isNsis ? 'nsis' : isPortable ? 'portable' : isDirOnly ? 'dir' : 'zip';
  return { isDirOnly, isNsis, isPortable, isDryRun, targetMode };
}

/**
 * 解析 macOS 打包 CLI 参数。
 */
export function parseMacPackagerArgs(argv = []) {
  const list = Array.isArray(argv) ? argv : [];
  const isDirOnly = list.includes('--dir');
  const isDryRun = list.includes('--dry-run');
  const archArg = list.find((a) => typeof a === 'string' && a.startsWith('--arch='));
  const arch = archArg ? archArg.slice('--arch='.length).trim() : '';
  return { isDirOnly, isDryRun, arch };
}

/**
 * 为 Windows `electron-builder` 子进程装配环境变量（转发 `WIN_CSC_KEY_PASSWORD` 至 `CSC_KEY_PASSWORD`）。
 */
export function resolveWindowsPackagerEnv(env = process.env) {
  const nextEnv = { ...env };
  const winKeyPw = String(nextEnv.WIN_CSC_KEY_PASSWORD || '').trim();
  const cscKeyPw = String(nextEnv.CSC_KEY_PASSWORD || '').trim();
  if (winKeyPw && !cscKeyPw) {
    nextEnv.CSC_KEY_PASSWORD = winKeyPw;
  }
  return nextEnv;
}

/**
 * 校验 Windows PowerShell `Get-AuthenticodeSignature` 结果。
 */
export function evaluateWindowsAuthenticodeChecks({
  results = [],
  signingRequired = false,
} = {}) {
  if (!Array.isArray(results) || results.length === 0) {
    if (signingRequired) {
      return {
        ok: false,
        error: '[win:package] 严格门禁失败：未找到任何可校验证书签名的 .exe 产物。',
      };
    }
    return { ok: true };
  }

  for (const item of results) {
    if (item.exitCode !== 0 || item.error) {
      if (signingRequired) {
        return {
          ok: false,
          error: `[win:package] 严格门禁失败：执行 Authenticode 校验异常 (${item.file})。`,
        };
      }
      continue;
    }
    const [rawStatus = '', subject = ''] = String(item.stdout || '').trim().split('|');
    const status = rawStatus.trim() || 'Unknown';
    if (signingRequired && status !== 'Valid') {
      return {
        ok: false,
        error: `[win:package] 严格门禁失败：${item.file} 签名校验状态为 ${status}（期望 Valid，Subject=${subject || 'none'}）。`,
      };
    }
  }
  return { ok: true };
}

/**
 * 判断 Desktop 打包是否启用严格正式签名门禁。
 */
export function isDesktopSigningRequired({ platform, argv = [], env = process.env } = {}) {
  if (Array.isArray(argv) && argv.includes('--require-signing')) return true;
  if (isTruthyFlag(env?.FLUX_REQUIRE_SIGNING)) return true;
  if (platform === 'windows') return isTruthyFlag(env?.WIN_REQUIRE_SIGNING);
  if (platform === 'macos') return isTruthyFlag(env?.MAC_REQUIRE_SIGNING);
  return false;
}

/**
 * 校验 Windows / macOS 签名状态是否满足发行门禁（macOS 强制要求 signed-and-notarized）。
 */
export function assertDesktopSigningReady({ platform, status, required }) {
  if (!required) {
    return { ok: true, mode: status?.mode ?? 'unsigned' };
  }

  const isReady =
    platform === 'macos'
      ? status?.mode === 'signed-and-notarized'
      : Boolean(status?.mode && status.mode !== 'unsigned');

  if (isReady) {
    return { ok: true, mode: status.mode };
  }

  const missing =
    Array.isArray(status?.missingFields) && status.missingFields.length > 0
      ? status.missingFields.join(', ')
      : `${platform} signing configuration missing`;

  const prefix = platform === 'macos' ? '[desktop:package:mac]' : '[desktop:package:win]';
  const requirement =
    platform === 'macos'
      ? '需要 Developer ID 代码签名 + Apple 公证（Notarization）凭据'
      : '需要正式代码签名凭据';

  return {
    ok: false,
    error:
      `${prefix} 已启用严格正式签名门禁，但${requirement}未就绪 (${missing})。` +
      '请参考 docs/testing/cross-platform-release-signing.md 配置环境变量。',
  };
}

/**
 * 组装 Windows `electron-builder` 安全参数数组（绝不包含任何私钥/口令）。
 */
export function buildWindowsElectronBuilderArgs({
  outputDir,
  targetMode = 'zip',
  signingStatus,
  requireSigning = false,
}) {
  const args = ['--win'];
  if (targetMode === 'nsis') {
    args.push('nsis');
  } else if (targetMode === 'portable') {
    args.push('portable');
  }
  args.push('--x64', `-c.directories.output=${outputDir}`);

  if (targetMode === 'dir' || targetMode === 'zip') {
    args.push('--dir');
  }

  if (requireSigning) {
    args.push('-c.forceCodeSigning=true');
  }

  if (signingStatus?.mode === 'azure-trusted-signing' && signingStatus.azureOptions) {
    args.push(
      `-c.win.azureSignOptions.endpoint=${signingStatus.azureOptions.endpoint}`,
      `-c.win.azureSignOptions.codeSigningAccountName=${signingStatus.azureOptions.codeSigningAccountName}`,
      `-c.win.azureSignOptions.certificateProfileName=${signingStatus.azureOptions.certificateProfileName}`,
      `-c.win.azureSignOptions.publisherName=${signingStatus.azureOptions.publisherName}`,
    );
  } else if (signingStatus?.mode === 'cert-store') {
    if (signingStatus.certificateSha1) {
      args.push(`-c.win.signtoolOptions.certificateSha1=${signingStatus.certificateSha1}`);
    }
    if (signingStatus.certificateSubjectName) {
      args.push(`-c.win.signtoolOptions.certificateSubjectName=${signingStatus.certificateSubjectName}`);
    }
  }

  return args;
}

/**
 * 组装 macOS `electron-builder` 安全参数数组（动态切换公证与 forceCodeSigning，绝不包含密钥）。
 */
export function buildMacElectronBuilderArgs({
  outputDir,
  isDirOnly = false,
  arch = '',
  signingStatus,
  requireSigning = false,
}) {
  const args = ['--mac'];
  if (arch === 'x64') args.push('--x64');
  else if (arch === 'arm64') args.push('--arm64');
  else if (arch === 'universal') args.push('--universal');

  if (isDirOnly) {
    args.push('--dir');
  }

  args.push(`-c.directories.output=${outputDir}`);

  if (requireSigning) {
    args.push('-c.forceCodeSigning=true');
  }

  if (signingStatus?.mode === 'signed-and-notarized') {
    args.push('-c.mac.notarize=true');
  } else {
    args.push('-c.mac.notarize=false');
  }

  if (signingStatus?.mode === 'unsigned') {
    args.push('-c.mac.identity=null');
  }

  return args;
}
