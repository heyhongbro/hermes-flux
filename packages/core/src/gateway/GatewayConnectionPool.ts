/**
 * 多网关并发连接池与隔离运行时槽位 (packages/core/src/gateway/GatewayConnectionPool.ts)
 *
 * 【设计意图 (Why)】
 *   在多网关工作台下，客户端需同时维持 N 条独立 WebSocket 长连接、REST 代理闭包、
 *   句柄注册表（storedId <-> liveId）、流式增量注册表与 `gateway.ready` 权威协商态。
 *   `GatewayConnectionPool` 为每个 `gatewayId` 分配严格正交的 `GatewayRuntimeSlot`，
 *   做到“一网关一实例”，单机断线/鉴权失效/重启只重置对应槽位，绝不波及其余在线网关。
 *
 * 【防范的历史坑 (Pitfall)】
 *   1. 全局单例 Client + 全局 REST 代理会导致跨网关 Cookie/Ticket/Origin 串台；每个 Slot
 *      持有绑定自身 `gatewayId` 与 Origin 校验的 `restProxy` 闭包，跨域注入直接拒止；
 *   2. 两台网关的 `session_id`、`live_id`、Bot 名称（如均有 `default`）都会重名，
 *      因此 `sessionHandleRegistry`、`liveStreamRegistry`、`running*`/`unread*`、
 *      `turnOwner` 全部按 Slot 物理隔离，不得共享全局集合。
 *
 * 【约束与规则 (Rules)】
 *   - 零 DOM / React / Electron 依赖；
 *   - 显式失败（Failure Is Not Empty）：跨网关代理请求或鉴权失败必须显式记录与拒绝；
 *   - 支持注入 `socketFactory` 以支撑测试及后续 Stage 2 环回加密传输。
 */

import { GroupRoomStore } from '../group/groupService.js';
import type { GroupLogPollerManager } from '../group/groupLogPollerManager.js';
import {
  resolveAggregateTitlebarStatus,
  resolveConnectionPhase,
  resolveTitlebarConnectionStatus,
  type GatewayConnectionPhase,
} from '../rpc/connectionPhase.js';
import { HermesGatewayClient, type RestFallbackOptions } from '../rpc/client.js';
import type { ClientCapabilitiesParams } from '../rpc/contracts/gateway-contract.generated.js';
import { parseGatewayReadyParams, type IncomingServerRequest } from '../rpc/gatewayProtocol.js';
import type { ServerRequestFrame } from '../rpc/serverRequestRouter.js';
import type { RpcSocketFactory } from '../rpc/socket.js';
import { LiveStreamRegistry } from '../session/liveStreamSync.js';
import { SessionHandleRegistry } from '../session/sessionRegistry.js';
import {
  deriveGatewayShortLabel,
  normalizeGatewayOriginUrl,
  type AggregateGatewayHealth,
  type GatewayHealthStatus,
  type GatewayInstanceConfig,
  type GatewayInstanceId,
  type GatewayPoolHealthSummary,
  type GatewayRestProxy,
  type GatewayRestProxyRequest,
  type GatewayRouteKind,
  type GatewaySlotHealth,
} from './types.js';

export interface GatewayAuthAttemptResult {
  ok: boolean;
  ticket?: string;
  latency?: number;
  message?: string;
  installId?: string;
  authError?: boolean;
}

export interface GatewayRuntimeSlot {
  readonly gatewayId: GatewayInstanceId;
  config: GatewayInstanceConfig;
  client: HermesGatewayClient;
  readonly sessionHandleRegistry: SessionHandleRegistry;
  readonly liveStreamRegistry: LiveStreamRegistry;
  readonly groupRoomStore: GroupRoomStore;
  groupPollerManager?: GroupLogPollerManager;
  sessionAuthority: boolean;
  replayEpoch: string | null;
  installId?: string;
  ticket?: string;
  latencyMs?: number;
  phase: GatewayConnectionPhase;
  connected: boolean;
  reconnectAttempt: number;
  authError: boolean;
  manualDisconnected: boolean;
  hasConnectedOnce: boolean;
  reason: string;
  readonly botForeverChatCache: Map<string, string>;
  readonly runningSessionIds: Set<string>;
  readonly unreadSessionIds: Set<string>;
  readonly runningBotNames: Set<string>;
  readonly unreadBotNames: Set<string>;
  readonly runningGroupRoomIds: Set<string>;
  readonly unreadGroupRoomIds: Set<string>;
  readonly sessionTurnOwner: Map<string, string>;
  readonly botTurnOwner: Map<string, string>;
  readonly activeGroupThreadByRoom: Map<string, { threadId: string; updatedAt: number }>;
  readonly restProxy: GatewayRestProxy;
}

export interface GatewayConnectionPoolOptions {
  readonly socketFactory?: RpcSocketFactory;
  readonly resolveWsUrl?: (config: GatewayInstanceConfig, ticket?: string) => string;
  readonly authenticateGateway?: (
    config: GatewayInstanceConfig,
  ) => Promise<GatewayAuthAttemptResult>;
  readonly executeRestProxy?: (
    gatewayId: GatewayInstanceId,
    config: GatewayInstanceConfig,
    request: GatewayRestProxyRequest,
  ) => Promise<unknown>;
  readonly clientTimeoutMs?: number;
  readonly enableHeartbeat?: boolean;
  readonly enableLifecycleWake?: boolean;
  readonly clientCapabilities?: ClientCapabilitiesParams;
}

export type PoolSlotEventListener = (gatewayId: GatewayInstanceId, params: unknown) => void;
export type PoolServerRequestListener = (
  gatewayId: GatewayInstanceId,
  request: IncomingServerRequest,
  client: HermesGatewayClient,
) => Promise<unknown> | unknown;
export type PoolInteractiveRequestListener = (
  gatewayId: GatewayInstanceId,
  frame: ServerRequestFrame,
  client: HermesGatewayClient,
) => boolean | void;
export type PoolSocketClosedListener = (
  gatewayId: GatewayInstanceId,
  closedGeneration: number,
) => void;
export type PoolHealthListener = (summary: GatewayPoolHealthSummary) => void;

interface SlotInternalRecord {
  slot: GatewayRuntimeSlot;
  epoch: number;
  unbindClient: () => void;
}

export function buildSlotDefaultWsUrl(baseUrl: string, ticket?: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  const wsBase = trimmed.startsWith('ws://') || trimmed.startsWith('wss://')
    ? trimmed
    : trimmed.replace(/^http:\/\//i, 'ws://').replace(/^https:\/\//i, 'wss://');
  const full = wsBase.endsWith('/api/ws') ? wsBase : `${wsBase}/api/ws`;
  return ticket ? `${full}?ticket=${encodeURIComponent(ticket)}` : full;
}

function mapSlotStatus(slot: GatewayRuntimeSlot): GatewayHealthStatus {
  return resolveTitlebarConnectionStatus(slot.phase, slot.connected);
}

/**
 * 多网关并发连接池：统一管理隔离 Slot 的建连、重连、事件分流与健康聚合。
 */
export class GatewayConnectionPool {
  private readonly options: GatewayConnectionPoolOptions;
  private readonly slots = new Map<GatewayInstanceId, SlotInternalRecord>();
  private readonly eventListeners = new Set<PoolSlotEventListener>();
  private readonly serverRequestListeners = new Set<PoolServerRequestListener>();
  private readonly interactiveListeners = new Set<PoolInteractiveRequestListener>();
  private readonly socketClosedListeners = new Set<PoolSocketClosedListener>();
  private readonly healthListeners = new Set<PoolHealthListener>();

  constructor(options: GatewayConnectionPoolOptions = {}) {
    this.options = options;
  }

  public addGateway(config: GatewayInstanceConfig): GatewayRuntimeSlot {
    const existing = this.slots.get(config.id);
    if (existing) {
      this.updateGatewayConfig(config.id, config);
      return existing.slot;
    }

    const slotRef: { current: GatewayRuntimeSlot | null } = { current: null };
    const restProxy: GatewayRestProxy = async (request) => {
      const targetSlot = slotRef.current!;
      const expectedOrigin = normalizeGatewayOriginUrl(targetSlot.config.url);
      if (request.baseUrl) {
        const requestedOrigin = normalizeGatewayOriginUrl(request.baseUrl);
        if (requestedOrigin && expectedOrigin && requestedOrigin !== expectedOrigin) {
          throw new Error(
            `Cross-gateway REST proxy rejected for slot "${targetSlot.gatewayId}": expected ${expectedOrigin}, got ${requestedOrigin}`,
          );
        }
      }
      if (!this.options.executeRestProxy) {
        throw new Error(`REST proxy is unavailable for gateway "${targetSlot.gatewayId}"`);
      }
      return this.options.executeRestProxy(targetSlot.gatewayId, targetSlot.config, {
        ...request,
        baseUrl: targetSlot.config.url,
        ticket: request.ticket ?? targetSlot.ticket,
      });
    };

    const placeholderClient = this.instantiateClient(config, buildSlotDefaultWsUrl(config.url));
    const slot: GatewayRuntimeSlot = {
      gatewayId: config.id,
      config: { ...config },
      client: placeholderClient,
      sessionHandleRegistry: new SessionHandleRegistry(),
      liveStreamRegistry: new LiveStreamRegistry(),
      groupRoomStore: new GroupRoomStore(),
      sessionAuthority: false,
      replayEpoch: null,
      installId: config.installId,
      phase: config.url.trim() ? 'offline' : 'unconfigured',
      connected: false,
      reconnectAttempt: 0,
      authError: false,
      manualDisconnected: false,
      hasConnectedOnce: false,
      reason: '',
      botForeverChatCache: new Map(),
      runningSessionIds: new Set(),
      unreadSessionIds: new Set(),
      runningBotNames: new Set(),
      unreadBotNames: new Set(),
      runningGroupRoomIds: new Set(),
      unreadGroupRoomIds: new Set(),
      sessionTurnOwner: new Map(),
      botTurnOwner: new Map(),
      activeGroupThreadByRoom: new Map(),
      restProxy,
    };
    slotRef.current = slot;

    const record: SlotInternalRecord = {
      slot,
      epoch: 0,
      unbindClient: () => {},
    };
    this.slots.set(config.id, record);
    this.bindClientToSlot(record, placeholderClient);
    this.emitHealth();
    return slot;
  }

  public updateGatewayConfig(
    gatewayId: GatewayInstanceId,
    patch: Partial<GatewayInstanceConfig>,
  ): boolean {
    const record = this.slots.get(gatewayId);
    if (!record) return false;
    const prevOrigin = normalizeGatewayOriginUrl(record.slot.config.url);
    record.slot.config = { ...record.slot.config, ...patch };
    if (patch.installId !== undefined) {
      record.slot.installId = patch.installId;
    }
    const nextOrigin = normalizeGatewayOriginUrl(record.slot.config.url);
    if (patch.url !== undefined && nextOrigin !== prevOrigin) {
      record.slot.ticket = undefined;
      record.epoch += 1;
      record.unbindClient();
      record.slot.client.disconnect();
      record.slot.connected = false;
      record.slot.phase = record.slot.config.url.trim() ? 'offline' : 'unconfigured';
      this.clearSlotTransientState(record.slot);
    }
    this.emitHealth();
    return true;
  }

  public removeGateway(gatewayId: GatewayInstanceId): boolean {
    const record = this.slots.get(gatewayId);
    if (!record) return false;
    record.epoch += 1;
    record.unbindClient();
    record.slot.client.disconnect();
    this.clearSlotTransientState(record.slot);
    this.slots.delete(gatewayId);
    this.emitHealth();
    return true;
  }

  public getSlot(gatewayId: GatewayInstanceId): GatewayRuntimeSlot | undefined {
    return this.slots.get(gatewayId)?.slot;
  }

  public getPrimarySlot(): GatewayRuntimeSlot | undefined {
    return this.slots.values().next().value?.slot;
  }

  public listSlots(): GatewayRuntimeSlot[] {
    return Array.from(this.slots.values(), (entry) => entry.slot);
  }

  public size(): number {
    return this.slots.size;
  }

  public async connectGateway(
    gatewayId: GatewayInstanceId,
    wsUrlOverride?: string,
  ): Promise<boolean> {
    const record = this.slots.get(gatewayId);
    if (!record) return false;
    const { slot } = record;
    const epoch = ++record.epoch;
    slot.manualDisconnected = false;
    slot.authError = false;
    slot.reason = '';

    let wsUrl = wsUrlOverride || '';
    if (!wsUrl) {
      if (this.options.authenticateGateway) {
        slot.ticket = undefined;
        slot.phase = 'connecting';
        this.emitHealth();
        let auth: GatewayAuthAttemptResult;
        try {
          auth = await this.options.authenticateGateway(slot.config);
        } catch (err) {
          if (epoch !== record.epoch) return false;
          slot.connected = false;
          slot.phase = 'offline';
          slot.reason = err instanceof Error ? err.message : String(err);
          this.emitHealth();
          return false;
        }
        if (epoch !== record.epoch) return false;
        if (!auth.ok) {
          slot.connected = false;
          slot.authError = Boolean(auth.authError);
          slot.phase = 'offline';
          slot.reason = auth.message || 'Authentication failed';
          this.emitHealth();
          return false;
        }
        slot.ticket = auth.ticket;
        slot.latencyMs = auth.latency;
        if (auth.installId) slot.installId = auth.installId;
      }
      wsUrl = this.options.resolveWsUrl
        ? this.options.resolveWsUrl(slot.config, slot.ticket)
        : buildSlotDefaultWsUrl(slot.config.url, slot.ticket);
    }

    if (!wsUrl) {
      slot.phase = 'unconfigured';
      slot.connected = false;
      this.emitHealth();
      return false;
    }

    this.rebindSlotClient(record, wsUrl, Boolean(wsUrlOverride));
    slot.client.connect();
    return true;
  }

  public async connectAll(): Promise<PromiseSettledResult<boolean>[]> {
    const targets = this.listSlots()
      .filter((slot) => slot.config.enabled !== false)
      .map((slot) => this.connectGateway(slot.gatewayId));
    return Promise.allSettled(targets);
  }

  public disconnectGateway(gatewayId: GatewayInstanceId, manual = true): boolean {
    const record = this.slots.get(gatewayId);
    if (!record) return false;
    const { slot } = record;
    record.epoch += 1;
    slot.manualDisconnected = manual;
    slot.connected = false;
    slot.phase = 'offline';
    slot.reconnectAttempt = 0;
    slot.sessionAuthority = false;
    slot.replayEpoch = null;
    record.unbindClient();
    slot.client.disconnect();
    this.clearSlotTransientState(slot);
    this.emitHealth();
    return true;
  }

  public reconnectGateway(gatewayId: GatewayInstanceId): Promise<boolean> {
    return this.connectGateway(gatewayId);
  }

  public disconnectAll(manual = true): void {
    for (const id of this.slots.keys()) {
      this.disconnectGateway(id, manual);
    }
  }

  public getHealthSummary(): GatewayPoolHealthSummary {
    const slots: GatewaySlotHealth[] = this.listSlots().map((slot) => ({
      gatewayId: slot.gatewayId,
      name: slot.config.name,
      shortLabel: deriveGatewayShortLabel(slot.config.name, slot.config.url, slot.config.shortAlias),
      url: slot.config.url,
      status: mapSlotStatus(slot),
      connected: slot.connected,
      latencyMs: slot.latencyMs,
      routeKind: (slot.config.routeKind || 'direct') as GatewayRouteKind,
      reconnectAttempt: slot.reconnectAttempt,
      authError: slot.authError,
      reason: slot.reason || undefined,
      installId: slot.installId,
    }));

    const onlineCount = slots.filter((s) => s.connected).length;
    const aggregateStatus = resolveAggregateTitlebarStatus(slots) as AggregateGatewayHealth;
    return {
      aggregateStatus,
      totalCount: slots.length,
      onlineCount,
      slots,
    };
  }

  public onSlotEvent(listener: PoolSlotEventListener): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  public onSlotServerRequest(listener: PoolServerRequestListener): () => void {
    this.serverRequestListeners.add(listener);
    return () => {
      this.serverRequestListeners.delete(listener);
    };
  }

  public onSlotInteractiveRequest(listener: PoolInteractiveRequestListener): () => void {
    this.interactiveListeners.add(listener);
    return () => {
      this.interactiveListeners.delete(listener);
    };
  }

  public onSlotSocketClosed(listener: PoolSocketClosedListener): () => void {
    this.socketClosedListeners.add(listener);
    return () => {
      this.socketClosedListeners.delete(listener);
    };
  }

  public onHealthChange(listener: PoolHealthListener): () => void {
    this.healthListeners.add(listener);
    return () => {
      this.healthListeners.delete(listener);
    };
  }

  private clearSlotTransientState(slot: GatewayRuntimeSlot): void {
    slot.sessionHandleRegistry.clear();
    slot.liveStreamRegistry.clear();
    slot.runningSessionIds.clear();
    slot.unreadSessionIds.clear();
    slot.runningBotNames.clear();
    slot.unreadBotNames.clear();
    slot.runningGroupRoomIds.clear();
    slot.unreadGroupRoomIds.clear();
    slot.sessionTurnOwner.clear();
    slot.botTurnOwner.clear();
    slot.activeGroupThreadByRoom.clear();
    slot.groupPollerManager?.stopAll();
  }

  private instantiateClient(
    config: GatewayInstanceConfig,
    wsUrl: string,
    isManualOverride = false,
  ): HermesGatewayClient {
    const gatewayId = config.id;
    const shouldRefreshUrl =
      !isManualOverride && Boolean(this.options.authenticateGateway || this.options.resolveWsUrl);
    const client = new HermesGatewayClient({
      url: wsUrl || 'ws://127.0.0.1:0',
      socketFactory: this.options.socketFactory,
      autoConnect: false,
      timeoutMs: this.options.clientTimeoutMs ?? 25_000,
      enableHeartbeat: this.options.enableHeartbeat ?? true,
      enableLifecycleWake: this.options.enableLifecycleWake ?? true,
      clientCapabilities: this.options.clientCapabilities ?? {
        server_requests: true,
        desktop_local: false,
      },
      ...(shouldRefreshUrl
        ? {
            resolveUrl: async (): Promise<string | null> => {
              const rec = this.slots.get(gatewayId);
              if (!rec) return null;
              const { slot } = rec;
              const myEpoch = rec.epoch;
              if (this.options.authenticateGateway) {
                slot.ticket = undefined;
                let auth: GatewayAuthAttemptResult;
                try {
                  auth = await this.options.authenticateGateway(slot.config);
                } catch (err) {
                  if (myEpoch !== rec.epoch) return null;
                  slot.authError = false;
                  slot.reason = err instanceof Error ? err.message : String(err);
                  this.emitHealth();
                  return null;
                }
                if (myEpoch !== rec.epoch) return null;
                if (!auth.ok) {
                  slot.authError = Boolean(auth.authError);
                  slot.reason = auth.message || 'Authentication failed';
                  this.emitHealth();
                  return null;
                }
                slot.authError = false;
                slot.reason = '';
                slot.ticket = auth.ticket;
                slot.latencyMs = auth.latency;
                if (auth.installId) slot.installId = auth.installId;
              }
              const nextUrl = this.options.resolveWsUrl
                ? this.options.resolveWsUrl(slot.config, slot.ticket)
                : buildSlotDefaultWsUrl(slot.config.url, slot.ticket);
              return nextUrl || null;
            },
          }
        : {}),
    });
    if (this.options.executeRestProxy) {
      const restProxyFn = this.options.executeRestProxy;
      client.setRestFallbackHandler(async (path: string, opts?: RestFallbackOptions) => {
        const slot = this.slots.get(gatewayId)?.slot;
        return restProxyFn(gatewayId, slot ? slot.config : config, {
          baseUrl: slot ? slot.config.url : config.url,
          path,
          method: opts?.method,
          ticket: slot?.ticket,
          params: opts?.params,
          body: opts?.body,
        });
      });
    }
    return client;
  }

  private rebindSlotClient(
    record: SlotInternalRecord,
    wsUrl: string,
    isManualOverride = false,
  ): void {
    record.unbindClient();
    record.slot.client.disconnect();
    const nextClient = this.instantiateClient(record.slot.config, wsUrl, isManualOverride);
    record.slot.client = nextClient;
    this.bindClientToSlot(record, nextClient);
  }

  private bindClientToSlot(
    record: SlotInternalRecord,
    client: HermesGatewayClient,
  ): void {
    // Why: rebindSlotClient / disconnectGateway / removeGateway 在 disconnect() 前同步调用 unbindClient()，结构上杜绝旧 client 迟到回调。
    const { slot } = record;
    const unsubReady = client.onNotification('gateway.ready', (params: unknown) => {
      const ready = parseGatewayReadyParams(params);
      slot.sessionAuthority = ready.sessionAuthority;
      slot.replayEpoch = ready.replayEpoch;
    });

    const unsubEvent = client.onNotification('event', (params: unknown) => {
      for (const listener of this.eventListeners) {
        listener(slot.gatewayId, params);
      }
    });

    const unsubFsm = client.getFsm().onStateChange((fsmState) => {
      const isConnected = fsmState === 'CONNECTED';
      if (isConnected) {
        slot.hasConnectedOnce = true;
      }
      slot.connected = isConnected;
      slot.reconnectAttempt = isConnected ? 0 : client.getReconnectAttempt();
      slot.phase = resolveConnectionPhase({
        hasGatewayUrl: Boolean(slot.config.url.trim()),
        manualDisconnected: slot.manualDisconnected,
        authError: slot.authError,
        fsmState,
        isSyncing: slot.phase === 'syncing',
        isSyncedFlash: slot.phase === 'synced',
        isColdStartRetrying: false,
        hasConnectedOnce: slot.hasConnectedOnce,
      });
      this.emitHealth();
    });

    const unsubInteractiveReq = client.onServerRequest((frame) => {
      let claimed = false;
      for (const listener of this.interactiveListeners) {
        if (listener(slot.gatewayId, frame, client) === true) {
          claimed = true;
        }
      }
      return claimed;
    });

    const unsubServerReq = client.setDefaultServerRequestHandler(async (req) => {
      if (this.serverRequestListeners.size === 0) {
        const err: { code: number; message: string } = {
          code: -32601,
          message: `Method not found: ${req.method}`,
        };
        throw err;
      }
      let result: unknown;
      for (const listener of this.serverRequestListeners) {
        result = await listener(slot.gatewayId, req, client);
      }
      return result;
    });

    const unsubSocketClosed = client.onSocketClosed((closedGeneration) => {
      for (const listener of this.socketClosedListeners) {
        listener(slot.gatewayId, closedGeneration);
      }
    });

    record.unbindClient = () => {
      unsubReady();
      unsubEvent();
      unsubFsm();
      unsubInteractiveReq();
      unsubServerReq();
      unsubSocketClosed();
    };
  }

  private emitHealth(): void {
    if (this.healthListeners.size === 0) return;
    const summary = this.getHealthSummary();
    for (const listener of this.healthListeners) {
      listener(summary);
    }
  }
}
