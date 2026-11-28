/**
 * Electron 主进程安全密钥库 (`safeStorage` 封装)
 *
 * 【设计意图 (Why)】
 *   替代桌面端渲染层历史把网关口令明文写入 `localStorage` 的安全债务：
 *   调用宿主系统密钥环（Windows DPAPI / macOS Keychain / Linux libsecret）
 *   将加密密文以 Base64 写入 `userData/gateway-secrets.json`（文件模式 `0600`）。
 *
 * 【防范的历史坑 (Pitfall)】
 *   某些无图形密钥环的 Linux 无头容器下 `safeStorage.isEncryptionAvailable()` 为 `false`；
 *   此时绝不可退化为"明文写盘"，必须仅保留在进程内存中，并在退出后自动销毁。
 *
 * 【约束与规则 (Rules)】
 *   - 磁盘文件中严禁出现任何明文密码；
 *   - 仅保留加密成功的条目；解密异常时安全删除/忽略单条损坏密文而非崩溃。
 */

import fs from 'node:fs';
import path from 'node:path';

export interface SecretStoreDeps {
  readonly filePath: string;
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

export interface SecretStore {
  setSecret(key: string, value: string): Promise<boolean>;
  getSecret(key: string): Promise<string | null>;
  deleteSecret(key: string): Promise<boolean>;
}

function readEncryptedMap(filePath: string): Record<string, string> {
  try {
    if (!fs.existsSync(filePath)) return {};
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'string') out[k] = v;
    }
    return out;
  // gate-degrade: 密钥文件损坏或不可解析时视为无历史密文，防止主进程启动与读取崩溃
  } catch {
    return {};
  }
}

function writeEncryptedMap(filePath: string, data: Record<string, string>): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
}

/** 创建基于 Electron `safeStorage` 的分键安全存储实例。 */
export function createSecretStore(deps: SecretStoreDeps): SecretStore {
  const memoryFallback = new Map<string, string>();

  return {
    async setSecret(key: string, value: string): Promise<boolean> {
      const normalizedKey = (key || '').trim();
      if (!normalizedKey) return false;
      memoryFallback.set(normalizedKey, value);
      if (!deps.isEncryptionAvailable()) {
        return true;
      }
      const existing = readEncryptedMap(deps.filePath);
      existing[normalizedKey] = deps.encryptString(value).toString('base64');
      writeEncryptedMap(deps.filePath, existing);
      return true;
    },

    async getSecret(key: string): Promise<string | null> {
      const normalizedKey = (key || '').trim();
      if (!normalizedKey) return null;
      const inMemory = memoryFallback.get(normalizedKey);
      if (inMemory !== undefined) {
        return inMemory;
      }
      if (!deps.isEncryptionAvailable()) {
        return null;
      }
      const existing = readEncryptedMap(deps.filePath);
      const encoded = existing[normalizedKey];
      if (!encoded) return null;
      try {
        const plain = deps.decryptString(Buffer.from(encoded, 'base64'));
        memoryFallback.set(normalizedKey, plain);
        return plain;
      // gate-degrade: 单条密文解密失败（系统密钥轮换或条目损坏）时视同缺失而非阻断读写
      } catch {
        return null;
      }
    },

    async deleteSecret(key: string): Promise<boolean> {
      const normalizedKey = (key || '').trim();
      if (!normalizedKey) return false;
      const removedMem = memoryFallback.delete(normalizedKey);
      if (!deps.isEncryptionAvailable()) {
        return removedMem;
      }
      const existing = readEncryptedMap(deps.filePath);
      if (!(normalizedKey in existing)) {
        return removedMem;
      }
      delete existing[normalizedKey];
      writeEncryptedMap(deps.filePath, existing);
      return true;
    },
  };
}
