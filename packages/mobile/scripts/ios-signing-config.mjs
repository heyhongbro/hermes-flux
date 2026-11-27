/**
 * iOS Release 签名配置解析与 ExportOptions 生成器（只读探测，绝不泄露密钥或 .p8 内容）。
 *
 * 【设计意图 (Why)】
 *   Xcode 工程默认 `CODE_SIGN_IDENTITY = "Apple Development"` 仅满足开发构建；
 *   真机分发若无正式签名与 `ExportOptions.plist`（App Store Connect / Ad-Hoc / Enterprise），
 *   iOS 会阻止安装或在 7 天后失效并提示“未受信任的开发者”。
 *   本模块统一解析 `signing.local.xcconfig` 与环境变量，生成安全的 `xcodebuild` 参数与 plist。
 *
 * 【防范的历史坑 (Pitfall)】
 *   1. `project.pbxproj` 遗留已废弃的 `"iPhone Developer"` 签名标识，在现代 Xcode 中触发告警或签名失败；
 *   2. 将 `.p8` 私钥全文或 `.p12` 密码放进命令行参数或返回对象会导致 CI 日志泄露机密；
 *   3. Base64 证书/私钥常含 `/` 与 `data:...;base64,` 前缀，简单以 `/` 判文件路径会误判为文件缺失且回显密文；
 *   4. `APPLE_API_KEY` 仅配置一半字段时若静默忽略，会导致 `-exportArchive` 阶段才超时失败。
 *
 * 【约束与规则 (Rules)】
 *   - 严禁在返回结果、日志、错误或 CLI 参数数组中放入私钥正文、密码或 base64 密文；
 *   - 严格模式（`--require-signing`）下未就绪必须 fail-closed；
 *   - 生成的 `ExportOptions.plist` 必须执行 XML 转义，防止特殊字符破坏 plist 结构。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const ALLOWED_IOS_EXPORT_METHODS = ['app-store-connect', 'ad-hoc', 'enterprise', 'development'];

function isTruthyFlag(val) {
  if (typeof val !== 'string') return false;
  const normalized = val.trim().toLowerCase();
  return normalized === '1' || normalized === 'true';
}

/**
 * 判断凭据值是否为本地文件路径（精确区分含 `/` 的 Base64 密文、带参数 `data:` URI、PEM 与远程 URL）。
 * 注：与 desktop-signing-config.mjs 保持包内零依赖独立实现，确保 mobile/desktop 薄壳不互耦且各域 Stryker 沙盒可无构建独立执行。
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
 * 展开本地文件路径中的 `~/` 前缀，与 Node `fs.existsSync` 语义对齐。
 */
export function resolveLocalFilePath(rawPath, homedir = os.homedir()) {
  const trimmed = String(rawPath || '').trim();
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return path.join(homedir, trimmed.slice(2));
  }
  return trimmed;
}

/**
 * 解码 Base64 / `data:...;base64,` / PEM 格式的 App Store Connect `.p8` 私钥正文。
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
 * 将 `APPLE_API_KEY` 解析为安全的磁盘 `.p8` 文件路径（必要时写入 `0600` 临时文件并供 `finally` 清理）。
 */
export function prepareIosApiKeyPath({
  rawApiKey,
  keyId = 'key',
  tmpDir = os.tmpdir(),
  homedir = os.homedir(),
  writeFile = fs.writeFileSync,
} = {}) {
  const trimmed = String(rawApiKey || '').trim();
  if (!trimmed) {
    return { path: '', tempFile: '' };
  }
  if (looksLikeFilePath(trimmed)) {
    return { path: resolveLocalFilePath(trimmed, homedir), tempFile: '' };
  }
  const safeKeyId = String(keyId || 'key').replace(/[^A-Za-z0-9_-]/g, '') || 'key';
  const tempFile = path.join(
    tmpDir,
    `AuthKey_${safeKeyId}_${crypto.randomBytes(4).toString('hex')}.p8`,
  );
  writeFile(tempFile, decodeAppleApiKeyPem(trimmed), { mode: 0o600 });
  return { path: tempFile, tempFile };
}

/**
 * 解析 `.xcconfig` 键值对（忽略 `//` 注释与空行）。
 */
export function parseXcconfig(content) {
  const result = {};
  if (!content || typeof content !== 'string') return result;
  for (const rawLine of content.split(/\r?\n/)) {
    const commentIdx = rawLine.indexOf('//');
    const withoutComment = commentIdx >= 0 ? rawLine.slice(0, commentIdx) : rawLine;
    const line = withoutComment.trim();
    if (!line) continue;
    const eqIdx = line.indexOf('=');
    if (eqIdx <= 0) continue;
    const key = line.slice(0, eqIdx).trim();
    const value = line.slice(eqIdx + 1).trim();
    if (key) {
      result[key] = value;
    }
  }
  return result;
}

/**
 * 探测当前 iOS 构建是否具备正式分发签名凭据。
 */
export function resolveIosSigningStatus({
  iosDir,
  env = process.env,
  fileExists = fs.existsSync,
  readFile = fs.readFileSync,
  exportMethodOverride = '',
  homedir = os.homedir(),
} = {}) {
  const propsPath = iosDir ? path.join(iosDir, 'signing.local.xcconfig') : '';
  const hasXcconfig = Boolean(propsPath && fileExists(propsPath));
  const xcconfig = hasXcconfig ? parseXcconfig(readFile(propsPath, 'utf8')) : {};

  const teamId = String(env.IOS_DEVELOPMENT_TEAM || env.APPLE_TEAM_ID || xcconfig.DEVELOPMENT_TEAM || '').trim();
  const signingStyle = String(env.IOS_SIGNING_STYLE || xcconfig.CODE_SIGN_STYLE || 'automatic')
    .trim()
    .toLowerCase();
  const exportMethod = String(
    exportMethodOverride || env.IOS_EXPORT_METHOD || xcconfig.IOS_EXPORT_METHOD || 'app-store-connect',
  )
    .trim()
    .toLowerCase();
  const codeSignIdentity = String(env.IOS_CODE_SIGN_IDENTITY || xcconfig.CODE_SIGN_IDENTITY || '').trim();
  const provisioningProfileSpecifier = String(
    env.IOS_PROVISIONING_PROFILE_SPECIFIER || xcconfig.PROVISIONING_PROFILE_SPECIFIER || '',
  ).trim();

  const apiKey = String(env.APPLE_API_KEY || '').trim();
  const apiKeyId = String(env.APPLE_API_KEY_ID || '').trim();
  const apiIssuer = String(env.APPLE_API_ISSUER || '').trim();

  const missingFields = [];

  if (!ALLOWED_IOS_EXPORT_METHODS.includes(exportMethod)) {
    missingFields.push(`IOS_EXPORT_METHOD invalid (${exportMethod})`);
  }

  if (signingStyle !== 'automatic' && signingStyle !== 'manual') {
    missingFields.push(`IOS_SIGNING_STYLE invalid (${signingStyle})`);
  }

  if (!teamId) {
    missingFields.push('IOS_DEVELOPMENT_TEAM / APPLE_TEAM_ID / DEVELOPMENT_TEAM');
  }

  if (signingStyle === 'manual') {
    if (!codeSignIdentity) missingFields.push('IOS_CODE_SIGN_IDENTITY');
    if (!provisioningProfileSpecifier) missingFields.push('IOS_PROVISIONING_PROFILE_SPECIFIER');
  }

  let hasAppStoreConnectApiKey = false;
  const anyApiKeyField = Boolean(apiKey || apiKeyId || apiIssuer);
  if (anyApiKeyField) {
    const apiKeyIsPath = looksLikeFilePath(apiKey);
    const apiKeyFileOk = !apiKeyIsPath || fileExists(resolveLocalFilePath(apiKey, homedir));
    if (!apiKey) missingFields.push('APPLE_API_KEY');
    else if (!apiKeyFileOk) missingFields.push('APPLE_API_KEY file missing');
    if (!apiKeyId) missingFields.push('APPLE_API_KEY_ID');
    if (!apiIssuer) missingFields.push('APPLE_API_ISSUER');
    hasAppStoreConnectApiKey = Boolean(apiKey && apiKeyId && apiIssuer && apiKeyFileOk);
  }

  const envProvided = Boolean(
    String(env.IOS_DEVELOPMENT_TEAM || env.APPLE_TEAM_ID || '').trim() ||
      String(env.IOS_CODE_SIGN_IDENTITY || '').trim() ||
      String(env.IOS_PROVISIONING_PROFILE_SPECIFIER || '').trim(),
  );
  const xcconfigProvided = Boolean(
    String(xcconfig.DEVELOPMENT_TEAM || '').trim() ||
      String(xcconfig.CODE_SIGN_IDENTITY || '').trim() ||
      String(xcconfig.PROVISIONING_PROFILE_SPECIFIER || '').trim(),
  );
  const source = envProvided ? 'env' : xcconfigProvided ? 'signing.local.xcconfig' : 'none';

  const mode =
    missingFields.length === 0
      ? signingStyle === 'manual'
        ? 'distribution-manual'
        : 'distribution-automatic'
      : 'unsigned';

  let installWarning = null;
  if (mode === 'unsigned') {
    installWarning =
      '当前未配置 Apple Developer Team / 描述文件；iOS 无法生成可安装于未越狱真机的签名包（仅可执行无签名构建/模拟器运行）。';
  } else if (exportMethod === 'development') {
    installWarning =
      '当前为 development 开发签名：仅限已注册 UDID 设备，个人免费账号 7 天过期且首次启动需在“设置 -> 通用 -> VPN与设备管理”手动信任开发者。';
  } else if (exportMethod === 'ad-hoc') {
    installWarning =
      '当前为 ad-hoc 分发签名：仅允许已登记在描述文件内的 UDID 测试机安装，未登记的普通用户 iPhone 将直接安装失败。';
  } else if (exportMethod === 'enterprise') {
    installWarning =
      '当前为 enterprise 企业签名：脱离 App Store 分发时，首次安装仍会弹出“未受信任的企业级开发者”，需用户到“设置 -> 通用 -> VPN与设备管理”手动信任。';
  }

  return {
    mode,
    source,
    signingStyle,
    exportMethod,
    teamIdPresent: Boolean(teamId),
    teamId: teamId || null,
    hasAppStoreConnectApiKey,
    codeSignIdentityPresent: Boolean(codeSignIdentity),
    codeSignIdentity: codeSignIdentity || null,
    provisioningProfilePresent: Boolean(provisioningProfileSpecifier),
    provisioningProfileSpecifier: provisioningProfileSpecifier || null,
    missingFields,
    installWarning,
  };
}

/**
 * 解析 iOS 构建 CLI 参数。
 */
export function parseIosBuildArgs(argv = []) {
  const isDryRun = Array.isArray(argv) && argv.includes('--dry-run');
  const exportMethodArg = Array.isArray(argv)
    ? argv.find((a) => typeof a === 'string' && a.startsWith('--export-method='))
    : undefined;
  return {
    isDryRun,
    exportMethodOverride: exportMethodArg ? exportMethodArg.slice('--export-method='.length) : '',
  };
}

/**
 * 判断本次 iOS 构建是否启用严格正式签名门禁。
 */
export function isIosSigningRequired({ argv = [], env = process.env } = {}) {
  if (Array.isArray(argv) && argv.includes('--require-signing')) return true;
  return isTruthyFlag(env?.FLUX_REQUIRE_SIGNING) || isTruthyFlag(env?.IOS_REQUIRE_SIGNING);
}

/**
 * 校验 iOS 签名状态是否满足发行门禁。
 */
export function assertIosSigningReady({ status, required }) {
  if (!required || (status?.mode && status.mode !== 'unsigned')) {
    return { ok: true, mode: status?.mode ?? 'unsigned' };
  }
  const missing =
    Array.isArray(status?.missingFields) && status.missingFields.length > 0
      ? status.missingFields.join(', ')
      : 'iOS signing configuration missing';
  return {
    ok: false,
    error:
      `[ios:build] 已启用严格正式签名门禁，但缺少 Apple 正式签名凭据 (${missing})。` +
      '请配置 IOS_DEVELOPMENT_TEAM（或 packages/mobile/ios/signing.local.xcconfig）及相关凭据（详见 docs/testing/cross-platform-release-signing.md）。',
  };
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * 生成 `xcodebuild -exportArchive` 所需的 `ExportOptions.plist` XML 文本。
 */
export function renderIosExportOptionsPlist({
  bundleId = 'com.hermesflux.app',
  teamId,
  signingStyle = 'automatic',
  exportMethod = 'app-store-connect',
  provisioningProfileSpecifier = '',
  codeSignIdentity = '',
}) {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '\t<key>method</key>',
    `\t<string>${escapeXml(exportMethod)}</string>`,
    '\t<key>teamID</key>',
    `\t<string>${escapeXml(teamId)}</string>`,
    '\t<key>signingStyle</key>',
    `\t<string>${escapeXml(signingStyle)}</string>`,
  ];

  if (exportMethod === 'app-store-connect') {
    lines.push('\t<key>uploadSymbols</key>');
    lines.push('\t<true/>');
  }

  if (signingStyle === 'manual') {
    if (codeSignIdentity) {
      lines.push('\t<key>signingCertificate</key>');
      lines.push(`\t<string>${escapeXml(codeSignIdentity)}</string>`);
    }
    if (provisioningProfileSpecifier) {
      lines.push('\t<key>provisioningProfiles</key>');
      lines.push('\t<dict>');
      lines.push(`\t\t<key>${escapeXml(bundleId)}</key>`);
      lines.push(`\t\t<string>${escapeXml(provisioningProfileSpecifier)}</string>`);
      lines.push('\t</dict>');
    }
  }

  lines.push('</dict>', '</plist>', '');
  return lines.join('\n');
}

/**
 * 组装 `xcodebuild archive` 与 `-exportArchive` 安全参数数组（绝不包含密钥内容）。
 */
export function buildIosXcodebuildArgs({
  projectPath,
  scheme = 'App',
  archivePath,
  exportPath,
  exportOptionsPath,
  status,
  authenticationKeyPath = '',
  authenticationKeyId = '',
  authenticationKeyIssuerId = '',
}) {
  const authArgs =
    authenticationKeyPath && authenticationKeyId && authenticationKeyIssuerId
      ? [
          '-authenticationKeyPath',
          authenticationKeyPath,
          '-authenticationKeyID',
          authenticationKeyId,
          '-authenticationKeyIssuerID',
          authenticationKeyIssuerId,
        ]
      : [];

  const archiveArgs = [
    '-project',
    projectPath,
    '-scheme',
    scheme,
    '-configuration',
    'Release',
    '-destination',
    'generic/platform=iOS',
    '-archivePath',
    archivePath,
    'archive',
  ];

  if (status?.mode === 'unsigned') {
    archiveArgs.push('CODE_SIGNING_ALLOWED=NO');
  } else {
    if (status?.teamId) {
      archiveArgs.push(`DEVELOPMENT_TEAM=${status.teamId}`);
    }
    if (status?.mode === 'distribution-manual') {
      archiveArgs.push(
        'CODE_SIGN_STYLE=Manual',
        `CODE_SIGN_IDENTITY=${status.codeSignIdentity}`,
        `PROVISIONING_PROFILE_SPECIFIER=${status.provisioningProfileSpecifier}`,
      );
    } else {
      archiveArgs.push('CODE_SIGN_STYLE=Automatic', '-allowProvisioningUpdates');
    }
    archiveArgs.push(...authArgs);
  }

  const exportArgs = [
    '-exportArchive',
    '-archivePath',
    archivePath,
    '-exportPath',
    exportPath,
    '-exportOptionsPlist',
    exportOptionsPath,
  ];
  if (status?.mode === 'distribution-automatic') {
    exportArgs.push('-allowProvisioningUpdates');
  }
  exportArgs.push(...authArgs);

  return { archiveArgs, exportArgs };
}
