/**
 * 多网关扁平配置注册表持久化与密钥解析 (Gateway Registry Store · M1.3)
 *
 * 【设计意图 (Why)】
 *   多网关工作台在 `localStorage` 只保存非敏感拓扑元数据（`hermes_flux_gateways_v1`），
 *   口令统一隔离写入宿主机 OS 安全密钥库（`safeStorage`）；同时为存量单网关用户
 *   提供冷启动零感知自动迁移（自动吸收 `hermes_flux_gateway_url` / `hermes_flux_username`）。
 *
 * 【防范的历史坑 (Pitfall)】
 *   1. 配置导出或 JSON 序列化误携明文 `password` 字段：入库前强行白名单洗净字段；
 *   2. 直接读取 `localStorage` 未捕获 `SecurityError`（隐私模式/禁站点数据）：读写均安全降级。
 *
 * 【约束与规则 (Rules)】
 *   - `localStorage` 绝不允许写入任何口令明文；
 *   - 单网关配置缺失时回退单机 legacy 存储键，无 URL 时返回空数组。
 */

import {
  DEFAULT_CACHE_GATEWAY_ID,
  deriveGatewayShortLabel,
  type GatewayInstanceConfig,
  type GatewayRouteKind,
} from '@hermes-flux/core';
import {
  safeSetItem,
  type StorageWriteFailure,
  type StorageWriteTarget,
} from '@hermes-flux/ui';
import type { HermesDesktopBridge } from '../../preload/index.js';
import {
  buildGatewaySecretKey,
  purgeLegacyPlaintextPasswords,
  type PlainStorageLike,
} from '../persistence/secretMigration.js';

export const GATEWAY_REGISTRY_STORAGE_KEY = 'hermes_flux_gateways_v1';

export interface RegistryStorageLike extends StorageWriteTarget {
  getItem?(key: string): string | null;
}

const VALID_ROUTES = new Set<GatewayRouteKind>(['direct', 'lan', 'relay']);

function resolveReadableStorage(storage?: RegistryStorageLike | null): RegistryStorageLike | null {
  if (storage === null) return null;
  if (storage !== undefined) return storage;
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  // gate-degrade: 禁用站点数据时读取 localStorage 属性本身抛 SecurityError，降级为空存储
  } catch {
    return null;
  }
}

function readKeySafe(storage: RegistryStorageLike, key: string): string | null {
  if (typeof storage.getItem !== 'function') return null;
  try {
    return storage.getItem(key);
  // gate-degrade: 单键读取异常时视为无保存值，不中断启动
  } catch {
    return null;
  }
}

function sanitizeGatewayConfig(raw: unknown): GatewayInstanceConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const rec = raw as Record<string, unknown>;
  const id = typeof rec.id === 'string' ? rec.id.trim() : '';
  const url = typeof rec.url === 'string' ? rec.url.trim() : '';
  if (!id || !url) return null;

  const shortAlias = typeof rec.shortAlias === 'string' && rec.shortAlias.trim() ? rec.shortAlias.trim() : undefined;
  const rawName = typeof rec.name === 'string' ? rec.name.trim() : '';
  const name = rawName || deriveGatewayShortLabel('', url, shortAlias);
  const username = typeof rec.username === 'string' && rec.username.trim() ? rec.username.trim() : undefined;
  const installId = typeof rec.installId === 'string' && rec.installId.trim() ? rec.installId.trim() : undefined;
  const fingerprint = typeof rec.fingerprint === 'string' && rec.fingerprint.trim() ? rec.fingerprint.trim() : undefined;
  const routeKind: GatewayRouteKind =
    typeof rec.routeKind === 'string' && VALID_ROUTES.has(rec.routeKind as GatewayRouteKind)
      ? (rec.routeKind as GatewayRouteKind)
      : 'direct';

  return {
    id,
    name,
    url,
    enabled: rec.enabled !== false,
    routeKind,
    ...(shortAlias ? { shortAlias } : {}),
    ...(username ? { username } : {}),
    ...(installId ? { installId } : {}),
    ...(fingerprint ? { fingerprint } : {}),
  };
}

/** 读取多网关列表（若尚未建立新表，则自动从 legacy 单网关存储键无损迁移一条默认节点）。 */
export function loadGatewayConfigs(storage?: RegistryStorageLike | null): GatewayInstanceConfig[] {
  const store = resolveReadableStorage(storage);
  if (!store) return [];

  const rawRegistry = readKeySafe(store, GATEWAY_REGISTRY_STORAGE_KEY);
  if (rawRegistry !== null) {
    try {
      const parsed: unknown = JSON.parse(rawRegistry);
      if (!Array.isArray(parsed)) return [];
      const sanitized: GatewayInstanceConfig[] = [];
      for (const item of parsed) {
        const entry = sanitizeGatewayConfig(item);
        if (entry) sanitized.push(entry);
      }
      return sanitized;
    // gate-degrade: 注册表 JSON 损坏时丢弃畸形内容回落空数组，等待用户重配
    } catch {
      return [];
    }
  }

  const legacyUrl = (
    readKeySafe(store, 'hermes_flux_gateway_url') ||
    readKeySafe(store, 'hermes_aura_gateway_url') ||
    ''
  ).trim();
  if (!legacyUrl) return [];

  const legacyUser = (
    readKeySafe(store, 'hermes_flux_username') ||
    readKeySafe(store, 'hermes_aura_username') ||
    ''
  ).trim();

  return [
    {
      id: DEFAULT_CACHE_GATEWAY_ID,
      name: deriveGatewayShortLabel('', legacyUrl),
      url: legacyUrl,
      enabled: true,
      routeKind: 'direct',
      ...(legacyUser ? { username: legacyUser } : {}),
    },
  ];
}

/** 持久化多网关列表（严格过滤所有非白名单字段，绝不落盘密码）。 */
export function saveGatewayConfigs(
  configs: readonly GatewayInstanceConfig[],
  storage?: RegistryStorageLike | null,
): StorageWriteFailure {
  if (storage === null) {
    return { ok: false, reason: 'unavailable', error: null };
  }
  const clean: GatewayInstanceConfig[] = [];
  for (const cfg of configs) {
    const entry = sanitizeGatewayConfig(cfg);
    if (entry) clean.push(entry);
  }
  return safeSetItem(GATEWAY_REGISTRY_STORAGE_KEY, JSON.stringify(clean), storage);
}

/** 新增或按 `id` 更新单台网关配置，返回新数组。 */
export function upsertGatewayConfig(
  configs: readonly GatewayInstanceConfig[],
  entry: GatewayInstanceConfig,
): GatewayInstanceConfig[] {
  const clean = sanitizeGatewayConfig(entry);
  if (!clean) return [...configs];
  const exists = configs.some((item) => item.id === clean.id);
  if (!exists) return [...configs, clean];
  return configs.map((item) => (item.id === clean.id ? clean : item));
}

/** 按 `id` 删除一台网关配置，返回新数组。 */
export function removeGatewayConfig(
  configs: readonly GatewayInstanceConfig[],
  gatewayId: string,
): GatewayInstanceConfig[] {
  return configs.filter((item) => item.id !== gatewayId);
}

/** 切换单台网关启停状态，返回新数组。 */
export function setGatewayEnabled(
  configs: readonly GatewayInstanceConfig[],
  gatewayId: string,
  enabled: boolean,
): GatewayInstanceConfig[] {
  return configs.map((item) => (item.id === gatewayId ? { ...item, enabled } : item));
}

/** 生成绑定网关实例主键的安全密钥库索引（避免 URL 变更丢密钥）。 */
export function buildGatewaySecretIdKey(gatewayId: string): string {
  const clean = (gatewayId || '').trim();
  return clean ? `gw-id:${clean}` : '';
}

/** 按「实例 ID 主键 ➔ 遗留 Origin 键 ➔ 显式兜底值」顺序从 OS 密钥库解析网关口令。 */
export async function resolveGatewayPassword(
  config: Pick<GatewayInstanceConfig, 'id' | 'url'>,
  secretBridge?: Pick<HermesDesktopBridge, 'getGatewaySecret'> | null,
  fallbackPassword = '',
): Promise<string> {
  if (!secretBridge?.getGatewaySecret) return fallbackPassword;
  try {
    const idKey = buildGatewaySecretIdKey(config.id);
    if (idKey) {
      const byId = await secretBridge.getGatewaySecret(idKey);
      if (byId) return byId;
    }
    const originKey = buildGatewaySecretKey(config.url);
    if (originKey) {
      const byOrigin = await secretBridge.getGatewaySecret(originKey);
      if (byOrigin) return byOrigin;
    }
    return fallbackPassword;
  // gate-degrade: 安全密钥库 IPC 不可用时回退兜底密码或空串，防止阻塞并发连接
  } catch {
    return fallbackPassword;
  }
}

/** 将网关口令同步写入安全密钥库（口令为空时执行双键抹除）。 */
export async function saveGatewayPassword(
  config: Pick<GatewayInstanceConfig, 'id' | 'url'>,
  password: string,
  secretBridge?: Partial<Pick<HermesDesktopBridge, 'setGatewaySecret' | 'deleteGatewaySecret'>> | null,
): Promise<void> {
  if (!secretBridge) return;
  const keys = [buildGatewaySecretIdKey(config.id), buildGatewaySecretKey(config.url)].filter(Boolean);
  for (const key of keys) {
    try {
      if (password) {
        await secretBridge.setGatewaySecret?.(key, password);
      } else {
        await secretBridge.deleteGatewaySecret?.(key);
      }
    // gate-degrade: 密钥环写入单键失败不阻塞剩余密钥或内存连接
    } catch {
      // safeStorage write failure intentionally isolated per key
    }
  }
}

/** 删除指定网关在安全密钥库中的所有关联凭证。 */
export async function deleteGatewayPassword(
  config: Pick<GatewayInstanceConfig, 'id' | 'url'>,
  secretBridge?: Pick<HermesDesktopBridge, 'deleteGatewaySecret'> | null,
): Promise<void> {
  await saveGatewayPassword(config, '', secretBridge);
}

/** 启动迁移：若存储中仍残留遗留明文口令键，转写入安全密钥库（主键与 Origin 键）并立即抹除明文。 */
export async function migrateLegacyGatewaySecrets(
  configs: readonly GatewayInstanceConfig[],
  secretBridge?: Partial<Pick<HermesDesktopBridge, 'setGatewaySecret' | 'deleteGatewaySecret'>> | null,
  storage?: PlainStorageLike | null,
): Promise<string> {
  const legacyPassword = purgeLegacyPlaintextPasswords(storage);
  if (!legacyPassword || !secretBridge) {
    return legacyPassword;
  }
  for (const cfg of configs) {
    await saveGatewayPassword(cfg, legacyPassword, secretBridge);
  }
  return legacyPassword;
}
