/**
 * Android Release Keystore 签名配置解析器（只读状态探测，绝不回传或打印口令）。
 *
 * 【设计意图 (Why)】
 *   构建脚本与单元测试复用同一份凭据探测规则，确保 Gradle 配置、本地构建横幅与
 *   CI 校验对 `keystore.properties` / `ANDROID_KEYSTORE_*` 的裁决口径完全一致，
 *   并在严格发布模式（`--require-signing`）下阻断静默回退 Debug 签名的风险。
 *
 * 【防范的历史坑 (Pitfall)】
 *   1. 旧版 `build.gradle` 无条件使用 `signingConfigs.debug` 打包 Release APK，且构建日志毫无提示；
 *   2. 探测状态对象若不小心带上密码字段，极易在控制台日志或 CI 产物中泄露签名密钥；
 *   3. 未在产后校验 APK 真实签名证书时，可能出现配置失效却悄悄落盘 `CN=Android Debug` 的假正式包。
 *
 * 【约束与规则 (Rules)】
 *   - 严禁在返回结果、日志或异常信息中包含 `storePassword` / `keyPassword`；
 *   - 相对路径统一以 `androidDir` 为根解析，与 Gradle `rootProject.file(...)` 对齐；
 *   - 严格模式缺失正式签名时必须显式 fail-closed（返回 `{ ok: false }`），绝不静默降级。
 */

import fs from 'node:fs';
import path from 'node:path';

function isTruthyFlag(val) {
  if (typeof val !== 'string') return false;
  const normalized = val.trim().toLowerCase();
  return normalized === '1' || normalized === 'true';
}

/**
 * 解析简单 `.properties` 文件键值对（忽略 `#`/`!` 注释与空行）。
 */
export function parseKeystoreProperties(content) {
  const result = {};
  if (!content || typeof content !== 'string') return result;
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    const eqIdx = line.indexOf('=');
    const colonIdx = line.indexOf(':');
    let sepIdx = -1;
    if (eqIdx >= 0 && colonIdx >= 0) {
      sepIdx = Math.min(eqIdx, colonIdx);
    } else {
      sepIdx = Math.max(eqIdx, colonIdx);
    }
    if (sepIdx <= 0) continue;
    const key = line.slice(0, sepIdx).trim();
    const value = line.slice(sepIdx + 1).trim();
    if (key) {
      result[key] = value;
    }
  }
  return result;
}

/**
 * 探测当前 Android 构建是否已具备完整正式 Release Keystore 凭据。
 */
export function resolveAndroidSigningStatus({ androidDir, env = process.env }) {
  const propsPath = path.join(androidDir, 'keystore.properties');
  const hasPropsFile = fs.existsSync(propsPath);
  const props = hasPropsFile ? parseKeystoreProperties(fs.readFileSync(propsPath, 'utf8')) : {};

  const storePathRaw = (props.storeFile || env.ANDROID_KEYSTORE_PATH || '').trim();
  const storePassword = (props.storePassword || env.ANDROID_KEYSTORE_PASSWORD || '').trim();
  const keyAlias = (props.keyAlias || env.ANDROID_KEY_ALIAS || '').trim();
  const keyPassword = (props.keyPassword || env.ANDROID_KEY_PASSWORD || '').trim();

  const resolvedKeystorePath = storePathRaw
    ? path.isAbsolute(storePathRaw)
      ? storePathRaw
      : path.resolve(androidDir, storePathRaw)
    : null;
  const keystoreExists = Boolean(resolvedKeystorePath && fs.existsSync(resolvedKeystorePath));

  const missingFields = [];
  if (!storePathRaw) missingFields.push('storeFile / ANDROID_KEYSTORE_PATH');
  else if (!keystoreExists) missingFields.push(`keystore file missing (${resolvedKeystorePath})`);
  if (!storePassword) missingFields.push('storePassword / ANDROID_KEYSTORE_PASSWORD');
  if (!keyAlias) missingFields.push('keyAlias / ANDROID_KEY_ALIAS');
  if (!keyPassword) missingFields.push('keyPassword / ANDROID_KEY_PASSWORD');

  const source = hasPropsFile && props.storeFile ? 'keystore.properties' : storePathRaw ? 'env' : 'none';
  const mode = missingFields.length === 0 ? 'release' : 'debug-fallback';

  return {
    mode,
    source,
    keystorePath: resolvedKeystorePath,
    keyAliasPresent: Boolean(keyAlias),
    missingFields,
    installWarning:
      mode === 'release'
        ? '已配置自有 Release Keystore，但 Android 15+/16+ 与国内厂商仍要求将 com.hermesflux.app + SHA-256 指纹备案至开发者平台方可消除侧载“开发者身份未验证”提示。'
        : '当前回退使用 Android Debug 调试证书签名；任意设备侧载均会触发“开发者身份未验证”拦截与无法覆盖升级。',
  };
}

/**
 * 判断本次 Android 构建是否启用严格正式签名门禁。
 */
export function isAndroidSigningRequired({ argv = [], env = process.env } = {}) {
  if (Array.isArray(argv) && argv.includes('--require-signing')) return true;
  return isTruthyFlag(env?.FLUX_REQUIRE_SIGNING) || isTruthyFlag(env?.ANDROID_REQUIRE_RELEASE_SIGNING);
}

/**
 * 校验 Android 签名状态是否满足发行门禁（strict 模式下拒绝 debug-fallback）。
 */
export function assertAndroidSigningReady({ status, required }) {
  if (!required || status?.mode === 'release') {
    return { ok: true, mode: status?.mode ?? 'debug-fallback' };
  }
  const missing =
    Array.isArray(status?.missingFields) && status.missingFields.length > 0
      ? status.missingFields.join(', ')
      : 'release keystore configuration missing';
  return {
    ok: false,
    error:
      `[android:build] 已启用严格正式签名门禁，但缺少正式签名凭据 (${missing})。` +
      '请配置 packages/mobile/android/keystore.properties 或 ANDROID_KEYSTORE_* 环境变量（详见 docs/testing/cross-platform-release-signing.md）。',
  };
}

/**
 * 解析 `keytool -printcert -jarfile` 或 `apksigner verify --print-certs` 输出的证书摘要。
 */
export function parseApkCertInfo(output) {
  if (!output || typeof output !== 'string') {
    return { owner: null, sha256: null, isDebugCert: false };
  }

  let owner = null;
  const ownerMatch =
    /^[ \t]*(?:Owner|所有者)[ \t]*:[ \t]*([^\r\n]*)$/mi.exec(output) ||
    /^[ \t]*Signer #\d+ certificate DN[ \t]*:[ \t]*([^\r\n]*)$/mi.exec(output);
  if (ownerMatch) {
    owner = ownerMatch[1].trim() || null;
  }

  let sha256 = null;
  const shaMatch = /SHA-?256(?:\s+digest)?\s*:\s*([0-9a-fA-F:]+)/i.exec(output);
  if (shaMatch) {
    const cleanHex = shaMatch[1].replace(/:/g, '').toUpperCase();
    if (/^[0-9A-F]{64}$/.test(cleanHex)) {
      const pairs = [];
      for (let i = 0; i < cleanHex.length; i += 2) {
        pairs.push(cleanHex.slice(i, i + 2));
      }
      sha256 = pairs.join(':');
    }
  }

  const isDebugCert = Boolean(owner && /\bCN\s*=\s*Android Debug\b/i.test(owner));
  return { owner, sha256, isDebugCert };
}

/**
 * 解析 Android 构建 CLI 参数。
 */
export function parseAndroidBuildArgs(argv = []) {
  const list = Array.isArray(argv) ? argv : [];
  return {
    isDryRun: list.includes('--dry-run'),
  };
}

/**
 * 核验产出 APK 的 `keytool -printcert` 结果（严格模式下任何异常、无签名或 Debug 证书均 fail-closed）。
 */
export function evaluateAndroidApkCertCheck({
  keytoolExitCode = 1,
  keytoolError = null,
  stdout = '',
  stderr = '',
  signingRequired = false,
} = {}) {
  if (keytoolError || keytoolExitCode !== 0) {
    const detail = keytoolError?.message || String(stderr || '').trim() || `exit ${keytoolExitCode}`;
    if (signingRequired) {
      return {
        ok: false,
        certInfo: null,
        error: `[android:build] 严格门禁失败：无法通过 keytool 核验 APK 签名证书 (${detail})，拒绝发行！`,
        warning: null,
      };
    }
    return {
      ok: true,
      certInfo: null,
      error: null,
      warning: `无法通过 keytool 核验 APK 签名证书 (${detail})`,
    };
  }

  const certInfo = parseApkCertInfo(stdout);
  if (certInfo.isDebugCert) {
    if (signingRequired) {
      return {
        ok: false,
        certInfo,
        error: '[android:build] 严格门禁失败：产出 APK 仍为 Android Debug 调试签名，拒绝发行！',
        warning: null,
      };
    }
    return {
      ok: true,
      certInfo,
      error: null,
      warning: '实测证书为 Android Debug：侧载安装会提示“开发者身份未验证”。',
    };
  }

  if (!certInfo.owner || !certInfo.sha256) {
    if (signingRequired) {
      return {
        ok: false,
        certInfo,
        error: '[android:build] 严格门禁失败：未能从 APK 解析出有效签名所有者或 SHA-256 指纹，拒绝发行！',
        warning: null,
      };
    }
    return {
      ok: true,
      certInfo,
      error: null,
      warning: '未能从 APK 解析出完整签名证书信息（APK 可能未签名或格式异常）。',
    };
  }

  return {
    ok: true,
    certInfo,
    error: null,
    warning: null,
  };
}

/**
 * 探测 Android SDK build-tools 中最新的 apksigner 可执行文件（v2/v3 APK 签名校验必需）。
 */
export function findAndroidApksignerPath(
  androidHome,
  {
    existsSync = fs.existsSync,
    readdirSync = fs.readdirSync,
    platform = process.platform,
  } = {},
) {
  const home = typeof androidHome === 'string' ? androidHome.trim() : '';
  if (!home) return null;
  const buildToolsDir = path.join(home, 'build-tools');
  if (!existsSync(buildToolsDir)) return null;
  let versions = [];
  try {
    versions = readdirSync(buildToolsDir).sort((a, b) =>
      b.localeCompare(a, undefined, { numeric: true, sensitivity: 'base' }),
    );
  // gate-degrade: SDK build-tools 目录不可读时降级回退 keytool
  } catch {
    return null;
  }
  const names = platform === 'win32' ? ['apksigner.bat', 'apksigner'] : ['apksigner'];
  for (const ver of versions) {
    for (const name of names) {
      const candidate = path.join(buildToolsDir, ver, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}
