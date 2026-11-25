/**
 * Android Release Keystore 签名配置解析器（只读状态探测，绝不回传或打印口令）。
 *
 * 【设计意图 (Why)】
 *   构建脚本与单元测试复用同一份凭据探测规则，确保 Gradle 配置、本地构建横幅与
 *   CI 校验对 `keystore.properties` / `ANDROID_KEYSTORE_*` 的裁决口径完全一致。
 *
 * 【防范的历史坑 (Pitfall)】
 *   1. 旧版 `build.gradle` 无条件使用 `signingConfigs.debug` 打包 Release APK，且构建日志毫无提示；
 *   2. 探测状态对象若不小心带上密码字段，极易在控制台日志或 CI 产物中泄露签名密钥。
 *
 * 【约束与规则 (Rules)】
 *   - 严禁在返回结果、日志或异常信息中包含 `storePassword` / `keyPassword`；
 *   - 相对路径统一以 `androidDir` 为根解析，与 Gradle `rootProject.file(...)` 对齐。
 */

import fs from 'node:fs';
import path from 'node:path';

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

  return {
    mode: missingFields.length === 0 ? 'release' : 'debug-fallback',
    source,
    keystorePath: resolvedKeystorePath,
    keyAliasPresent: Boolean(keyAlias),
    missingFields,
  };
}
