/**
 * Desktop 多网关隔离运行时宿主适配器 (Multi-Gateway Runtime · M1.3)
 *
 * 【设计意图 (Why)】
 *   把核心层纯逻辑 `GatewayConnectionPool` 与 `aggregateMultiGatewaySnapshots`
 *   绑定到 Electron PAL 传输通道（`authenticateGateway`、`httpProxy`、`proxyWebSocketUrl`），
 *   并在本模块维护按 `gatewayId` 索引的快照缓存分片（`profiles`/`sessions`/`groups`），
 *   确保任意远端网关断线时其已缓存数据依然保留 `offline: true` 只读上屏。
 *
 * 【防范的历史坑 (Pitfall)】
 *   1. 旧架构假定全局只有单个 `gatewayClient` 与单条 `httpProxy` 通道，
 *      多网关并存时会出现 Cookie/Ticket/Origin 混用；每个 Slot 经 `GatewayConnectionPool`
 *      物理校验同源并独立取票；
 *   2. 删除一台网关或退化为 1 台网关时必须彻底清理对应 Slot 与切片缓存，防止孤儿轮询与幽灵列表项。
 *
 * 【约束与规则 (Rules)】
 *   - 严禁出现 `as any`；
 *   - 禁止操作 DOM 或直接依赖 `index.ts`，外部协作统一经 Deps 回调注入。
 */

import {
  GatewayConnectionPool,
  aggregateMultiGatewaySnapshots,
  buildSlotDefaultWsUrl,
  type AggregatedMultiGatewayView,
  type AgentProfile,
  type ClientCapabilitiesParams,
  type GatewayInstanceConfig,
  type GatewayInstanceId,
  type GatewayPoolHealthSummary,
  type GatewayRestProxyRequest,
  type GatewayRuntimeSlot,
  type GatewaySnapshotSlice,
  type GroupRoomSummary,
  type HermesGatewayClient,
  type IncomingServerRequest,
  type NormalizedSession,
  type ProbeOrWakeResult,
  type RpcSocketFactory,
  type ServerRequestFrame,
} from '@hermes-flux/core';
import type { HermesDesktopBridge } from '../../preload/index.js';

export interface SlotSnapshotData {
  profiles: readonly AgentProfile[];
  sessions: readonly NormalizedSession[];
  groups: readonly GroupRoomSummary[];
}

export interface MultiGatewayRuntimeDeps {
  readonly getDesktopApi: () => HermesDesktopBridge | undefined;
  readonly resolvePassword: (config: GatewayInstanceConfig) => Promise<string>;
  readonly onSlotEvent?: (gatewayId: GatewayInstanceId, params: unknown) => void;
  readonly onSlotServerRequest?: (
    gatewayId: GatewayInstanceId,
    request: IncomingServerRequest,
    client: HermesGatewayClient,
  ) => Promise<unknown> | unknown;
  readonly onSlotInteractiveRequest?: (
    gatewayId: GatewayInstanceId,
    frame: ServerRequestFrame,
    client: HermesGatewayClient,
  ) => boolean | void;
  readonly onSlotSocketClosed?: (
    gatewayId: GatewayInstanceId,
    closedGeneration: number,
  ) => void;
  readonly clientCapabilities?: ClientCapabilitiesParams;
  readonly onHealthChange?: (summary: GatewayPoolHealthSummary) => void;
  readonly onSlicesUpdated?: (view: AggregatedMultiGatewayView) => void;
  readonly socketFactory?: RpcSocketFactory;
  readonly clientTimeoutMs?: number;
  readonly enableHeartbeat?: boolean;
  readonly enableLifecycleWake?: boolean;
}

export interface MultiGatewayRuntime {
  syncGateways(configs: readonly GatewayInstanceConfig[]): void;
  connectAll(): Promise<PromiseSettledResult<boolean>[]>;
  connectGateway(gatewayId: GatewayInstanceId, wsUrlOverride?: string): Promise<boolean>;
  reconnectGateway(gatewayId: GatewayInstanceId): Promise<boolean>;
  wakeSlot(gatewayId: GatewayInstanceId, reason?: string): Promise<ProbeOrWakeResult>;
  disconnectGateway(gatewayId: GatewayInstanceId, manual?: boolean): boolean;
  disconnectAll(manual?: boolean): void;
  setSlotSlice(gatewayId: GatewayInstanceId, patch: Partial<SlotSnapshotData>): AggregatedMultiGatewayView;
  seedSlotSliceIfEmpty(gatewayId: GatewayInstanceId, patch: Partial<SlotSnapshotData>): boolean;
  getClient(gatewayId?: GatewayInstanceId): HermesGatewayClient | null;
  getSlot(gatewayId?: GatewayInstanceId): GatewayRuntimeSlot | undefined;
  getHealthSummary(): GatewayPoolHealthSummary;
  buildAggregatedView(): AggregatedMultiGatewayView;
  dispose(): void;
}

const EMPTY_SLICE: SlotSnapshotData = {
  profiles: [],
  sessions: [],
  groups: [],
};

function detectAuthFailureFlag(res: { message?: string; authError?: boolean }): boolean {
  if (typeof res.authError === 'boolean') return res.authError;
  return /auth|unauthori|password|credential|401/i.test(res.message || '');
}

/** 构建面向 Desktop Renderer 的多网关连接池与聚合视图运行时。 */
export function createMultiGatewayRuntime(deps: MultiGatewayRuntimeDeps): MultiGatewayRuntime {
  const sliceCache = new Map<GatewayInstanceId, SlotSnapshotData>();

  const pool = new GatewayConnectionPool({
    socketFactory: deps.socketFactory,
    clientTimeoutMs: deps.clientTimeoutMs,
    enableHeartbeat: deps.enableHeartbeat,
    enableLifecycleWake: deps.enableLifecycleWake,
    clientCapabilities: deps.clientCapabilities,
    authenticateGateway: async (config) => {
      const desktopApi = deps.getDesktopApi();
      if (!desktopApi?.authenticateGateway) {
        return { ok: false, message: 'Gateway auth bridge unavailable', authError: false };
      }
      const password = await deps.resolvePassword(config);
      const res = await desktopApi.authenticateGateway({
        url: config.url,
        username: config.username || '',
        password,
      });
      return {
        ok: res.ok,
        ticket: res.ticket,
        latency: res.latency,
        message: res.message,
        installId: res.installId,
        authError: !res.ok && detectAuthFailureFlag(res),
      };
    },
    resolveWsUrl: (config, ticket) => {
      const raw = buildSlotDefaultWsUrl(config.url, ticket);
      if (!raw) return '';
      const proxy = deps.getDesktopApi()?.proxyWebSocketUrl;
      return proxy ? proxy(raw) : raw;
    },
    executeRestProxy: async (
      _gatewayId: GatewayInstanceId,
      config: GatewayInstanceConfig,
      request: GatewayRestProxyRequest,
    ) => {
      const desktopApi = deps.getDesktopApi();
      if (!desktopApi?.httpProxy) {
        throw new Error('Desktop httpProxy bridge unavailable');
      }
      return desktopApi.httpProxy({
        baseUrl: config.url,
        path: request.path,
        method: request.method,
        ticket: request.ticket,
        params: request.params,
        body: request.body,
      });
    },
  });

  const unsubHealth = pool.onHealthChange((summary) => {
    deps.onHealthChange?.(summary);
  });
  const unsubEvent = pool.onSlotEvent((gatewayId, params) => {
    deps.onSlotEvent?.(gatewayId, params);
  });
  const unsubServerReq = deps.onSlotServerRequest
    ? pool.onSlotServerRequest(deps.onSlotServerRequest)
    : () => {};
  const unsubInteractiveReq = deps.onSlotInteractiveRequest
    ? pool.onSlotInteractiveRequest(deps.onSlotInteractiveRequest)
    : () => {};
  const unsubSocketClosed = deps.onSlotSocketClosed
    ? pool.onSlotSocketClosed(deps.onSlotSocketClosed)
    : () => {};

  function syncGateways(configs: readonly GatewayInstanceConfig[]): void {
    const targetIds = new Set(configs.map((c) => c.id));
    for (const existing of pool.listSlots()) {
      if (!targetIds.has(existing.gatewayId)) {
        pool.removeGateway(existing.gatewayId);
        sliceCache.delete(existing.gatewayId);
      }
    }
    for (const cfg of configs) {
      if (pool.getSlot(cfg.id)) {
        pool.updateGatewayConfig(cfg.id, cfg);
      } else {
        pool.addGateway(cfg);
      }
      if (!sliceCache.has(cfg.id)) {
        sliceCache.set(cfg.id, { ...EMPTY_SLICE });
      }
    }
  }

  function buildAggregatedView(): AggregatedMultiGatewayView {
    const slices: GatewaySnapshotSlice[] = pool.listSlots().map((slot) => {
      const cached = sliceCache.get(slot.gatewayId) ?? EMPTY_SLICE;
      return {
        gatewayId: slot.gatewayId,
        name: slot.config.name,
        shortAlias: slot.config.shortAlias,
        url: slot.config.url,
        installId: slot.installId,
        fingerprint: slot.config.fingerprint,
        connected: slot.connected,
        offline: !slot.connected,
        routeKind: slot.config.routeKind,
        profiles: cached.profiles,
        sessions: cached.sessions,
        groups: cached.groups,
      };
    });
    return aggregateMultiGatewaySnapshots(slices);
  }

  function setSlotSlice(
    gatewayId: GatewayInstanceId,
    patch: Partial<SlotSnapshotData>,
  ): AggregatedMultiGatewayView {
    const prev = sliceCache.get(gatewayId) ?? EMPTY_SLICE;
    sliceCache.set(gatewayId, {
      profiles: patch.profiles ?? prev.profiles,
      sessions: patch.sessions ?? prev.sessions,
      groups: patch.groups ?? prev.groups,
    });
    const view = buildAggregatedView();
    deps.onSlicesUpdated?.(view);
    return view;
  }

  function seedSlotSliceIfEmpty(
    gatewayId: GatewayInstanceId,
    patch: Partial<SlotSnapshotData>,
  ): boolean {
    const prev = pool.getSlot(gatewayId) ? sliceCache.get(gatewayId) : undefined;
    if (!prev) return false;
    let nextProfiles = prev.profiles;
    let nextSessions = prev.sessions;
    let nextGroups = prev.groups;
    let changed = false;
    if (nextProfiles.length === 0 && patch.profiles && patch.profiles.length > 0) {
      nextProfiles = patch.profiles;
      changed = true;
    }
    if (nextSessions.length === 0 && patch.sessions && patch.sessions.length > 0) {
      nextSessions = patch.sessions;
      changed = true;
    }
    if (nextGroups.length === 0 && patch.groups && patch.groups.length > 0) {
      nextGroups = patch.groups;
      changed = true;
    }
    if (!changed) return false;
    sliceCache.set(gatewayId, {
      profiles: nextProfiles,
      sessions: nextSessions,
      groups: nextGroups,
    });
    return true;
  }

  function getClient(gatewayId?: GatewayInstanceId): HermesGatewayClient | null {
    if (gatewayId) {
      return pool.getSlot(gatewayId)?.client ?? null;
    }
    return pool.getPrimarySlot()?.client ?? null;
  }

  function getSlot(gatewayId?: GatewayInstanceId): GatewayRuntimeSlot | undefined {
    return gatewayId ? pool.getSlot(gatewayId) : pool.getPrimarySlot();
  }

  function dispose(): void {
    unsubHealth();
    unsubEvent();
    unsubServerReq();
    unsubInteractiveReq();
    unsubSocketClosed();
    pool.disconnectAll(true);
    sliceCache.clear();
  }

  return {
    syncGateways,
    connectAll: () => pool.connectAll(),
    connectGateway: (gatewayId, wsUrlOverride) => pool.connectGateway(gatewayId, wsUrlOverride),
    reconnectGateway: (gatewayId) => pool.reconnectGateway(gatewayId),
    wakeSlot: (gatewayId, reason) => pool.wakeSlot(gatewayId, reason),
    disconnectGateway: (gatewayId, manual = true) => pool.disconnectGateway(gatewayId, manual),
    disconnectAll: (manual = true) => pool.disconnectAll(manual),
    setSlotSlice,
    seedSlotSliceIfEmpty,
    getClient,
    getSlot,
    getHealthSummary: () => pool.getHealthSummary(),
    buildAggregatedView,
    dispose,
  };
}
