/**
 * 渲染层历史明文网关口令清洗与 OS 安全密钥环迁移辅助
 *
 * 【设计意图 (Why)】
 *   旧版渲染层曾在 `localStorage` 中以明文持久化 `hermes_flux_password` / `hermes_aura_password`。
 *   本模块确保：
 *   1. 新写入路径绝不再将网关口令写入 `localStorage`；
 *   2. 任意读取、连接或启动路径遇到历史残留明文键时，立即迁移到宿主安全密钥库（`safeStorage`）
 *      并物理清除 `localStorage` 中的旧明文键。
 */

import type { HermesDesktopBridge } from '../../preload/index.js';

export const LEGACY_PASSWORD_STORAGE_KEYS = [
  'hermes_flux_password',
  'hermes_aura_password',
] as const;

export interface PlainStorageLike {
  getItem?(key: string): string | null;
  removeItem?(key: string): void;
}

/** 按网关规范化 `origin` 生成安全密钥库键名；URL 非法或为空时返回空串。 */
export function buildGatewaySecretKey(rawGatewayUrl: string): string {
  const raw = (rawGatewayUrl || '').trim();
  if (!raw) return '';
  let normalized = raw;
  if (normalized.startsWith('ws://')) normalized = normalized.replace('ws://', 'http://');
  else if (normalized.startsWith('wss://')) normalized = normalized.replace('wss://', 'https://');
  try {
    const parsed = new URL(normalized);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return '';
    }
    return `gw:${parsed.origin.toLowerCase()}`;
  // gate-degrade: 非法网关 URL 无法构造域级密钥键名，返回空串跳过持久化
  } catch {
    return '';
  }
}

/** 读取并立即物理清除 `localStorage` 中的遗留明文密码键，返回非空遗留值（如有）。 */
export function purgeLegacyPlaintextPasswords(
  storage: PlainStorageLike | undefined | null = typeof localStorage !== 'undefined' ? localStorage : null,
): string {
  if (!storage) return '';
  let captured = '';
  for (const key of LEGACY_PASSWORD_STORAGE_KEYS) {
    try {
      const value = storage.getItem?.(key);
      if (!captured && value) captured = value;
      storage.removeItem?.(key);
    // gate-degrade: 若宿主存储被隐私策略锁定，清理异常不应阻断启动或登录流程
    } catch {
      // ignore storage policy lock
    }
  }
  return captured;
}

/**
 * 启动期按网关地址同步安全凭据：
 * - 若发现历史遗留 `localStorage` 明文口令，立即转存到主进程 `safeStorage` 并抹除明文；
 * - 否则从 `safeStorage` 读取已保存的密文口令注入内存态 `state.password`。
 */
export async function hydrateOrMigrateGatewaySecret(options: {
  gatewayUrl: string;
  initialPassword?: string;
  storage?: PlainStorageLike | null;
  secretBridge?: Pick<HermesDesktopBridge, 'setGatewaySecret' | 'getGatewaySecret'>;
}): Promise<string> {
  const purged = purgeLegacyPlaintextPasswords(options.storage);
  const effectiveLegacy = options.initialPassword || purged;
  const secretKey = buildGatewaySecretKey(options.gatewayUrl);
  if (!secretKey || !options.secretBridge) {
    return effectiveLegacy;
  }
  try {
    if (effectiveLegacy) {
      await options.secretBridge.setGatewaySecret?.(secretKey, effectiveLegacy);
      return effectiveLegacy;
    }
    const stored = await options.secretBridge.getGatewaySecret?.(secretKey);
    return stored ?? '';
  // gate-degrade: 安全密钥库 IPC 异常时回退返回内存/遗留口令，不阻断启动流程
  } catch {
    return effectiveLegacy;
  }
}
