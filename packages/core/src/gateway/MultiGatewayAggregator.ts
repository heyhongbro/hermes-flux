/**
 * 多网关纯扁平视图聚合器、克隆碰撞防护与群聊权威仲裁引擎
 * (packages/core/src/gateway/MultiGatewayAggregator.ts)
 *
 * 【设计意图 (Why)】
 *   多网关工作台禁止网关页签与隔离过滤栏，必须把多台网关返回的 Bot、会话、群聊合并为
 *   单一扁平视图，同时处理三大分布式并发边界：
 *   1. 同源重复接入（如同时配了 LAN IP 与中继地址，同 `installId` + 同硬件指纹）：自动识别去重，
 *      防止侧边栏出现双份完全一致的 Bot/会话；
 *   2. 虚拟机克隆碰撞（同 `installId` 但不同 `fingerprint`）：强制保持独立 `gatewayId` 物理隔离，
 *      严禁把克隆机误判为同一节点；
 *   3. 跨机群聊同步：同一 `roomId` 被多台参会网关同时返回时，按最高 `authorityEpoch` 仲裁胜出并保留单行。
 *
 * 【防范的历史坑 (Pitfall)】
 *   1. 若仅按输入数组顺序决定胜出者，断连重连顺序变化会导致列表实体随机跳变；
 *      所有碰撞仲裁、群聊去重与扁平排序均采用完全确定性、输入排列无关的全序比较；
 *   2. 离线网关条目绝不允许直接消失（Failure Is Not Empty），必须连同缓存继续上屏并标注 `gatewayOffline: true`。
 *
 * 【约束与规则 (Rules)】
 *   - 纯函数与零外部状态副作用；
 *   - 严禁修改输入 slice 对象，所有输出项均带稳定归属元数据。
 */

import type { AgentProfile, GroupRoomSummary, NormalizedSession } from '../rpc/types.js';
import {
  deriveGatewayShortLabel,
  normalizeGatewayOriginUrl,
  type GatewayRouteKind,
} from './types.js';

export interface GatewaySnapshotSlice {
  readonly gatewayId: string;
  readonly name: string;
  readonly shortAlias?: string;
  readonly url: string;
  readonly installId?: string;
  readonly fingerprint?: string;
  readonly connected: boolean;
  readonly offline?: boolean;
  readonly routeKind?: GatewayRouteKind;
  readonly profiles: readonly AgentProfile[];
  readonly sessions: readonly NormalizedSession[];
  readonly groups: readonly GroupRoomSummary[];
}

export interface GatewayIdentityCollision {
  readonly kind: 'duplicate-gateway' | 'clone-collision';
  readonly installId: string;
  readonly primaryGatewayId: string;
  readonly collidingGatewayId: string;
}

export interface AggregatedMultiGatewayView {
  readonly effectiveGatewayCount: number;
  readonly isMultiGateway: boolean;
  readonly collisions: GatewayIdentityCollision[];
  readonly profiles: AgentProfile[];
  readonly sessions: NormalizedSession[];
  readonly groups: GroupRoomSummary[];
}

function compareSlicePriority(a: GatewaySnapshotSlice, b: GatewaySnapshotSlice): number {
  const aOnline = a.connected && !a.offline ? 1 : 0;
  const bOnline = b.connected && !b.offline ? 1 : 0;
  if (aOnline !== bOnline) return bOnline - aOnline;
  const aHasInstall = (a.installId || '').trim() ? 1 : 0;
  const bHasInstall = (b.installId || '').trim() ? 1 : 0;
  if (aHasInstall !== bHasInstall) return bHasInstall - aHasInstall;
  const aOrigin = normalizeGatewayOriginUrl(a.url);
  const bOrigin = normalizeGatewayOriginUrl(b.url);
  if (aOrigin !== bOrigin) return aOrigin.localeCompare(bOrigin);
  return a.gatewayId.localeCompare(b.gatewayId);
}

/**
 * 检测多网关配置的身份碰撞：
 * - 同 `installId` + 不同 `fingerprint` ➔ `clone-collision`（双方严格物理隔离）；
 * - 同 `installId` + 相同 `fingerprint`（或相同归一化 URL）➔ `duplicate-gateway`（择优去重）。
 */
export function detectCloneCollisions(
  slices: readonly GatewaySnapshotSlice[],
): GatewayIdentityCollision[] {
  const { collisions } = partitionActiveAndDuplicateSlices(slices);
  return collisions;
}

function partitionActiveAndDuplicateSlices(slices: readonly GatewaySnapshotSlice[]): {
  activeSlices: GatewaySnapshotSlice[];
  collisions: GatewayIdentityCollision[];
} {
  const sorted = [...slices].sort(compareSlicePriority);
  const collisions: GatewayIdentityCollision[] = [];
  const primaryByIdentityKey = new Map<string, GatewaySnapshotSlice>();
  const primaryByOrigin = new Map<string, GatewaySnapshotSlice>();
  const firstByInstallId = new Map<string, GatewaySnapshotSlice>();
  const activeSlices: GatewaySnapshotSlice[] = [];

  for (const slice of sorted) {
    const installId = (slice.installId || '').trim();
    const fp = (slice.fingerprint || '').trim();
    const origin = normalizeGatewayOriginUrl(slice.url);

    if (installId) {
      const priorForInstall = firstByInstallId.get(installId);
      const isCloneCollision = Boolean(
        priorForInstall && fp && priorForInstall.fingerprint && priorForInstall.fingerprint.trim() !== fp,
      );
      if (isCloneCollision && priorForInstall) {
        collisions.push({
          kind: 'clone-collision',
          installId,
          primaryGatewayId: priorForInstall.gatewayId,
          collidingGatewayId: slice.gatewayId,
        });
      } else if (!priorForInstall) {
        firstByInstallId.set(installId, slice);
      }

      const identityKey = fp ? `${installId}::fp:${fp}` : `${installId}::same`;
      const existing = primaryByIdentityKey.get(identityKey);
      if (existing) {
        collisions.push({
          kind: 'duplicate-gateway',
          installId,
          primaryGatewayId: existing.gatewayId,
          collidingGatewayId: slice.gatewayId,
        });
        continue;
      }
      if (!isCloneCollision && origin) {
        const existingByUrl = primaryByOrigin.get(origin);
        if (existingByUrl) {
          collisions.push({
            kind: 'duplicate-gateway',
            installId: existingByUrl.installId || installId,
            primaryGatewayId: existingByUrl.gatewayId,
            collidingGatewayId: slice.gatewayId,
          });
          continue;
        }
      }
      primaryByIdentityKey.set(identityKey, slice);
      if (origin && !primaryByOrigin.has(origin)) {
        primaryByOrigin.set(origin, slice);
      }
      activeSlices.push(slice);
      continue;
    }

    if (origin) {
      const existingByUrl = primaryByOrigin.get(origin);
      if (existingByUrl) {
        collisions.push({
          kind: 'duplicate-gateway',
          installId: existingByUrl.installId || '',
          primaryGatewayId: existingByUrl.gatewayId,
          collidingGatewayId: slice.gatewayId,
        });
        continue;
      }
      primaryByOrigin.set(origin, slice);
    }

    activeSlices.push(slice);
  }

  return { activeSlices, collisions };
}

function compareGroupAuthority(
  a: { group: GroupRoomSummary; slice: GatewaySnapshotSlice },
  b: { group: GroupRoomSummary; slice: GatewaySnapshotSlice },
): number {
  const aEpoch = a.group.authorityEpoch ?? 0;
  const bEpoch = b.group.authorityEpoch ?? 0;
  if (aEpoch !== bEpoch) return bEpoch - aEpoch;

  const aOnline = a.slice.connected && !a.slice.offline ? 1 : 0;
  const bOnline = b.slice.connected && !b.slice.offline ? 1 : 0;
  if (aOnline !== bOnline) return bOnline - aOnline;

  const aIsAuth = a.group.authorityGatewayId === a.slice.gatewayId ? 1 : 0;
  const bIsAuth = b.group.authorityGatewayId === b.slice.gatewayId ? 1 : 0;
  if (aIsAuth !== bIsAuth) return bIsAuth - aIsAuth;

  const aUpdated = a.group.updatedAt || a.group.createdAt || 0;
  const bUpdated = b.group.updatedAt || b.group.createdAt || 0;
  if (aUpdated !== bUpdated) return bUpdated - aUpdated;

  return a.slice.gatewayId.localeCompare(b.slice.gatewayId);
}

/**
 * 将多个网关运行时快照聚合为单一扁平多网关视图（严格支持 `gateways.length === 1` 退化）。
 */
export function aggregateMultiGatewaySnapshots(
  slices: readonly GatewaySnapshotSlice[],
): AggregatedMultiGatewayView {
  const { activeSlices, collisions } = partitionActiveAndDuplicateSlices(slices);
  const profiles: Array<AgentProfile & { gatewayId: string }> = [];
  const sessions: Array<NormalizedSession & { gatewayId: string }> = [];
  const groupBuckets = new Map<string, Array<{ group: GroupRoomSummary; slice: GatewaySnapshotSlice }>>();

  for (const slice of activeSlices) {
    const label = deriveGatewayShortLabel(slice.name, slice.url, slice.shortAlias);
    const offline = Boolean(slice.offline || !slice.connected);

    for (const profile of slice.profiles) {
      profiles.push({
        ...profile,
        gatewayId: slice.gatewayId,
        gatewayLabel: label,
        gatewayOffline: offline,
        gatewayRouteLabel: slice.routeKind,
      });
    }

    for (const session of slice.sessions) {
      sessions.push({
        ...session,
        gatewayId: slice.gatewayId,
        gatewayLabel: label,
        gatewayOffline: offline,
      });
    }

    for (const group of slice.groups) {
      let bucket = groupBuckets.get(group.roomId);
      if (!bucket) {
        bucket = [];
        groupBuckets.set(group.roomId, bucket);
      }
      bucket.push({ group, slice });
    }
  }

  profiles.sort((a, b) => {
    const tsDiff = (b.timestamp || 0) - (a.timestamp || 0);
    if (tsDiff !== 0) return tsDiff;
    const gwDiff = a.gatewayId.localeCompare(b.gatewayId);
    if (gwDiff !== 0) return gwDiff;
    return a.name.localeCompare(b.name);
  });

  sessions.sort((a, b) => {
    const pinDiff = (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0);
    if (pinDiff !== 0) return pinDiff;
    const tsDiff = (b.timestamp || 0) - (a.timestamp || 0);
    if (tsDiff !== 0) return tsDiff;
    const gwDiff = a.gatewayId.localeCompare(b.gatewayId);
    if (gwDiff !== 0) return gwDiff;
    return a.id.localeCompare(b.id);
  });

  const groups: GroupRoomSummary[] = [];
  for (const bucket of groupBuckets.values()) {
    bucket.sort(compareGroupAuthority);
    const winner = bucket[0];
    const label = deriveGatewayShortLabel(winner.slice.name, winner.slice.url, winner.slice.shortAlias);
    const offline = Boolean(winner.slice.offline || !winner.slice.connected);
    const maxEpoch = bucket.reduce((max, item) => Math.max(max, item.group.authorityEpoch ?? 0), 0);
    const distinctGateways = new Set(bucket.map((item) => item.slice.gatewayId)).size;

    groups.push({
      ...winner.group,
      gatewayId: winner.slice.gatewayId,
      gatewayLabel: label,
      gatewayOffline: offline,
      authorityGatewayId: winner.group.authorityGatewayId || winner.slice.gatewayId,
      ...(maxEpoch > 0 ? { authorityEpoch: maxEpoch } : {}),
      crossGateway: distinctGateways > 1 || Boolean(winner.group.crossGateway),
    });
  }

  groups.sort((a, b) => {
    const tsDiff = (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0);
    if (tsDiff !== 0) return tsDiff;
    return a.roomId.localeCompare(b.roomId);
  });

  return {
    effectiveGatewayCount: activeSlices.length,
    isMultiGateway: activeSlices.length >= 2,
    collisions,
    profiles,
    sessions,
    groups,
  };
}
