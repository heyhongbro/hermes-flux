/**
 * 多网关并发连接与实体归属领域契约 (packages/core/src/gateway/types.ts)
 *
 * 【设计意图 (Why)】
 *   多网关架构下，单台电脑/移动设备可同时直连或经由 LAN / 中继接入多台 Hermes Gateway，
 *   每台网关都有独立的 `default` Bot 与自增数字 `sessionId`/`liveId`。
 *   本模块集中定义网关实例配置、健康状态、作用域复合键以及确定性短标签派生函数，
 *   消除跨网关实体撞名、URL 漂移导致缓存/权限误匹配的安全隐患。
 *
 * 【防范的历史坑 (Pitfall)】
 *   1. 用易变的 `gatewayUrl` 作为前端状态或缓存键：同一个家宽/局域网网关在直连 IP、
 *      mDNS 与中继域名之间切换后 URL 会变，导致头像/草稿/缓存全丢；必须锚定稳定的 `gatewayId`；
 *   2. UI 微标若手写字符串裁剪或从 URL 裸正则截断，容易出现不同组件展示口径不一致。
 *
 * 【约束与规则 (Rules)】
 *   - 零 DOM / React / Electron 依赖；
 *   - 严禁在前端配置与健康状态中携带明文密码字段；
 *   - 所有辅助函数均为确定性纯函数。
 */

import { DEFAULT_CACHE_GATEWAY_ID } from '../cache/types.js';

export type GatewayInstanceId = string;

export type GatewayRouteKind = 'direct' | 'lan' | 'relay';

export type GatewayHealthStatus = 'connected' | 'reconnecting' | 'syncing' | 'offline';

export type AggregateGatewayHealth = 'connected' | 'partial' | 'reconnecting' | 'syncing' | 'offline';

export interface GatewayInstanceConfig {
  id: GatewayInstanceId;
  name: string;
  shortAlias?: string;
  url: string;
  username?: string;
  installId?: string;
  fingerprint?: string;
  enabled?: boolean;
  routeKind?: GatewayRouteKind;
}

export interface GatewaySlotHealth {
  gatewayId: GatewayInstanceId;
  name: string;
  shortLabel: string;
  url: string;
  status: GatewayHealthStatus;
  connected: boolean;
  latencyMs?: number;
  routeKind: GatewayRouteKind;
  reconnectAttempt: number;
  authError: boolean;
  reason?: string;
  installId?: string;
}

export interface GatewayPoolHealthSummary {
  aggregateStatus: AggregateGatewayHealth;
  totalCount: number;
  onlineCount: number;
  slots: GatewaySlotHealth[];
}

export interface GatewayRestProxyRequest {
  baseUrl?: string;
  path: string;
  method?: string;
  ticket?: string;
  params?: Record<string, unknown>;
  body?: unknown;
}

export type GatewayRestProxy = (request: GatewayRestProxyRequest) => Promise<unknown>;

/**
 * 将网关地址归一化为小写 HTTP Origin（用于同源约束校验，而非缓存身份主键）。
 */
export function normalizeGatewayOriginUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) return '';
  const httpCandidate = trimmed.replace(/^ws(s?):\/\//i, 'http$1://');
  try {
    return new URL(httpCandidate).origin.toLowerCase();
  // gate-degrade: 非标准地址或相对占位无法 parse URL 时回退小写去尾斜杠字符串
  } catch {
    return httpCandidate.replace(/\/+$/, '').toLowerCase();
  }
}

/**
 * 构造按 `gatewayId` 隔离的会话/房间复合运行时键。
 */
export function scopedEntityKey(gatewayId: string | undefined, entityId: string): string {
  const gid = gatewayId ? gatewayId.trim() : '';
  return `${gid || DEFAULT_CACHE_GATEWAY_ID}::${entityId}`;
}

/**
 * 构造按 `gatewayId` 隔离的 Bot 复合键（解决多网关同名 `default` 冲突）。
 */
export function scopedBotKey(gatewayId: string | undefined, botName: string): string {
  const gid = gatewayId ? gatewayId.trim() : '';
  return `${gid || DEFAULT_CACHE_GATEWAY_ID}:${botName.trim().toLowerCase()}`;
}

/**
 * 为 UI 行次级徽标与健康浮层推导稳定的节点短别名。
 */
export function deriveGatewayShortLabel(name: string, url?: string, shortAlias?: string): string {
  const alias = shortAlias ? shortAlias.trim() : '';
  if (alias) return alias;
  const named = name.trim();
  if (named) return named;
  const rawUrl = url ? url.trim() : '';
  if (rawUrl) {
    try {
      const normalized = rawUrl.includes('://') ? rawUrl : `http://${rawUrl}`;
      return new URL(normalized).hostname;
    // gate-degrade: 异常 URL 字符串直接回退去空白原文作为短标，不丢弃用户可见线索
    } catch {
      return rawUrl;
    }
  }
  return 'Gateway';
}

/**
 * 为 56px 微轨站点卡右下角推导单色等宽首字符徽标（1 字符）。
 */
export function deriveGatewayMonogram(label: string): string {
  const trimmed = label.trim();
  if (!trimmed) return 'G';
  const [first] = Array.from(trimmed);
  return first.toUpperCase();
}
