/**
 * 客户端缓存领域类型（packages/core/src/cache/types.ts）
 *
 * 【设计意图 (Why)】
 *   缓存层只做两件事：让冷启动不等网络、让离线有内容可看。
 *   为了做到这两件事，必须把"网关行"与"缓存行"的边界用类型钉死，
 *   否则实施时会出现"工具行被当成独立消息"、"群聊 seq 与单会话 rowId 混用"这类错。
 *
 * 【防范的历史坑 (Pitfall)】
 *   1. 单会话与群聊是两套互不兼容的消息来源：前者用 rowId，后者用 seq。
 *      历史上用单一 id 字段承载两者，导致群聊消息与单会话消息主键碰撞。
 *   2. `hidden` 在 REST 返回里是数字 0/1，不是布尔。直接当布尔用会在严格比较时出错。
 *   3. `last_active` 是秒级浮点，未归一化会导致列表倒挂。
 *
 * 【约束与规则 (Rules)】
 *   - 本文件只声明类型，零运行时代码；
 *   - 禁止 any / unknown 作为对外字段类型；
 *   - 时间戳统一毫秒整数。
 */

import type { MessageDisplayKind, MessageDisplayMetadata } from '../session/displayKind.js';
import type { MessageAttachmentItem } from '../session/messageAttachments.js';

/** 缓存信封版本。结构变更时提升，读到不匹配的值直接丢弃重建。 */
export const CACHE_SCHEMA_VERSION = 2 as const;

/** 未显式归属到独立网关实例时的默认本地通道/索引分桶标识。 */
export const DEFAULT_CACHE_GATEWAY_ID = '__default__' as const;

/** 跨机/单机群聊缓存的稳定哨兵分桶标识（避免 groups.promote 切主后历史消息孤儿化）。 */
export const ROOM_CACHE_GATEWAY_ID = '__room__' as const;

/** 消息所属通道。群聊与单会话的主键序号语义不同，必须显式区分。 */
export type CacheChannel = 'session' | 'room';

/** 解析缓存实体的权威分桶 `gatewayId`：群聊固定落入 `'__room__'`，缺失或空白回退 `'__default__'`。 */
export function resolveCacheGatewayId(input: {
  readonly channel?: CacheChannel;
  readonly kind?: 'session' | 'group';
  readonly gatewayId?: string;
}): string {
  if (input.channel === 'room' || input.kind === 'group') {
    return ROOM_CACHE_GATEWAY_ID;
  }
  const trimmed = typeof input.gatewayId === 'string' ? input.gatewayId.trim() : '';
  return trimmed || DEFAULT_CACHE_GATEWAY_ID;
}

/** 会话索引行：message 的入口，不含正文。 */
export interface CachedSessionSummary {
  /** stored_session_id 或 room_id */
  id: string;
  /** 归属网关实例 ID（群聊固定为 `'__room__'`，缺省兼容默认网关） */
  gatewayId?: string;
  /** 群聊权威代际（防止 promote 切主后低代际陈旧快照倒灌覆盖） */
  authorityEpoch?: number;
  /** 归属 profile；群聊房间固定为空串（hosted rooms 不属于任何 profile） */
  profile: string;
  kind: 'session' | 'group';
  title: string;
  /** 副标题，派生自真实最后一条消息 */
  preview?: string;
  /** 毫秒整数，已归一化 */
  timestamp: number;
  isArchived: boolean;
  hidden: boolean;
  pinned: boolean;
  unread: boolean;
  botName?: string;
  projectId?: string;
  /** 群聊游标，用于 groups.log 增量拉取 */
  latestSeq?: number;
  /** 群聊成员数 */
  memberCount?: number;
  /** 群聊成员名单，用于渲染拼图头像 */
  members?: string[];
}

/** Agent 索引行：左轨微轨与主工位卡的数据源。 */
export interface CachedAgentSummary {
  /** 网关侧唯一名 */
  name: string;
  /** 归属网关实例 ID */
  gatewayId?: string;
  displayName: string;
  description?: string;
  model?: string;
  /** 头像引用键，实体在头像表中 */
  avatar?: string;
  hasAvatar: boolean;
  /** 来源：last_session.last_active，毫秒整数 */
  lastSessionLastActive?: number;
}

/** 工具调用快照。arguments 保留原始 JSON 字符串，展示层再解析。 */
export interface CachedToolCall {
  toolId: string;
  name: string;
  argsText?: string;
  resultText?: string;
  status: 'running' | 'done' | 'error';
  imagePath?: string;
  inlineDiff?: string;
}

/** 消息缓存行。主键五元组 (gatewayId, profile, channel, channelId, orderKey)。 */
export interface CachedMessageRow {
  /** 归属网关实例 ID（群聊固定 `'__room__'`，缺省回退 `'__default__'`） */
  gatewayId?: string;
  /** 群聊消息写入时的权威代际（可选） */
  authorityEpoch?: number;
  profile: string;
  channel: CacheChannel;
  channelId: string;
  /** session 为 rowId；room 为 seq。用于主键去重、围栏、截断与淘汰（注意：不保证与显示顺序单调）。 */
  orderKey: number;
  /**
   * 通道展示顺序号（从 1 递增）。
   *
   * 【设计意图 (Why)】网关 messages.id 在压缩搬运场景下与 display_order 不单调，
   *   直接按 orderKey 排序会把错序的首问搬到列表中间。
   *   把「展示顺序」从「主键/围栏键 orderKey」解耦，既保留定理 22~26，又还原真实顺序。
   * 【约束与规则 (Rules)】可选；缺失时（旧数据或纯离线测试）回退 orderKey。
   */
  displaySeq?: number;
  role: 'user' | 'assistant' | 'system';
  text: string;
  reasoning?: string;
  toolCalls?: CachedToolCall[];
  /** 毫秒整数 */
  timestamp: number;
  status: 'complete' | 'error' | 'interrupted';
  /** 正文因超长被截断 */
  truncated?: boolean;
  /**
   * 网关显示类型（见 session/displayKind.ts）。
   *
   * 【设计意图 (Why)】冷启动从 IndexedDB 还原时，机器信令行必须仍按原类型渲染，
   *   否则离线重开会把 `[System: ...]` 之类重新画成用户气泡。
   *
   * 【约束与规则 (Rules)】缺失即视作 'user'；旧缓存行无需迁移。
   */
  displayKind?: MessageDisplayKind;
  /** 窄化后的展示元数据（子代理完成数、后台进程标题等）。 */
  displayMetadata?: MessageDisplayMetadata;
  /** 随消息附带的图片/文件附件元数据。 */
  attachments?: MessageAttachmentItem[];
}

/** 通道引用：定位一个会话或一个房间的消息集合。 */
export interface CacheChannelRef {
  /** 归属网关 ID（支持多网关独立隔离，群聊固定 `'__room__'`） */
  gatewayId?: string;
  /** 群聊权威代际，用于防止低代际陈旧节点覆盖高代际缓存 */
  authorityEpoch?: number;
  profile: string;
  channel: CacheChannel;
  channelId: string;
}

/** 归一化消息缓存行的 5 元组 `gatewayId` 与可选群聊 `authorityEpoch`。 */
export function normalizeCachedMessageRow(
  row: CachedMessageRow,
  ref?: CacheChannelRef,
): CachedMessageRow {
  const gatewayId = resolveCacheGatewayId({
    channel: row.channel,
    gatewayId: row.gatewayId ?? ref?.gatewayId,
  });
  const authorityEpoch =
    typeof row.authorityEpoch === 'number'
      ? row.authorityEpoch
      : ref?.authorityEpoch;
  return {
    ...row,
    gatewayId,
    ...(typeof authorityEpoch === 'number' ? { authorityEpoch } : {}),
  };
}

/** 网关认证方式 */
export type GatewayAuthType = 'basic' | 'token' | 'none';

/** 单个网关连接档案配置实体 */
export interface GatewayConnectionProfile {
  id: string;
  name: string;
  url: string;
  authType: GatewayAuthType;
  username?: string;
  password?: string;
  token?: string;
  defaultProfile?: string;
  lastConnectedAt?: number;
  lastLatencyMs?: number;
  isDefault?: boolean;
}

/** 多网关注册表容器（存储在持久化信封中） */
export interface GatewayRosterState {
  activeGatewayId: string;
  defaultGatewayId: string;
  items: GatewayConnectionProfile[];
}

/** 持久化信封：所有索引类缓存统一使用，便于版本判定。 */
export interface CacheEnvelope<T> {
  v: number;
  savedAt: number;
  items: T;
}

/** 构造一个空信封。 */
export function createEnvelope<T>(items: T, savedAt: number): CacheEnvelope<T> {
  return { v: CACHE_SCHEMA_VERSION, savedAt, items };
}

/**
 * 判断信封是否可读。
 *
 * 【规则】版本不匹配一律视为不可读，由调用方丢弃重建；
 * 不写迁移代码——索引条目少，重建成本 = 一次网络请求。
 */
export function isReadableEnvelope(value: unknown): value is CacheEnvelope<unknown> {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return record.v === CACHE_SCHEMA_VERSION && 'items' in record;
}
