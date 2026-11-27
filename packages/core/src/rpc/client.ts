/**
 * Hermes Gateway JSON-RPC 2.0 WebSocket Client
 */

import {
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcNotification,
  NormalizedSession,
  AgentProfile,
  SessionUsageResult,
  SessionContextBreakdownResult,
  SessionCompressResult,
  StoredTranscriptParams,
  StoredTranscriptResult,
  SpawnTreeListResult,
  SpawnTreeLoadResult,
} from './types.js';
import { WebSocketFsm, FsmState } from './fsm.js';
import { isLegacyRpcMethodError } from './connectionPhase.js';
import { createLogger } from '../log/logger.js';
import { redactInteractivePayload } from '../log/redact.js';
import { CONTRACT_METHODS } from './contracts/contractTable.generated.js';
import type {
  ClientCapabilitiesParams,
  ClientCapabilitiesResult,
} from './contracts/gateway-contract.generated.js';
import { EXTRA_METHODS } from './contracts/extraMethods.js';
import {
  RPC_SOCKET_READY_STATE,
  createBrowserRpcSocket,
  type IRpcSocket,
  type RpcSocketFactory,
  type RpcSocketMessageEvent,
} from './socket.js';
import {
  DEFAULT_GATEWAY_READY_STATE,
  buildSessionEventsSinceParams,
  executeServerRequestFrame,
  normalizeSessionEventsSinceResult,
  parseGatewayReadyParams,
  type DefaultServerRequestHandler,
  type GatewayMethodRequestHandler,
  type GatewayReadyState,
  type SessionEventsSinceNormalizedResult,
  type SessionEventsSinceQuery,
} from './gatewayProtocol.js';
import {
  describeRpcClientError as describeError,
  fetchGatewayConfigWithFallback,
  fetchLastMessageWithFallback,
  getModelCatalogWithFallback,
  listArchivedSessionsWithFallback,
  listProfilesWithFallback,
  listSessionsWithFallback,
  type ClientChannelTransport,
  type ModelCatalog,
  type RestFallbackHandler,
  type SessionListOutcome,
  type SessionMessageRecord,
  type SessionMessagesOutcome,
} from './clientChannelHelpers.js';
export type {
  ModelCatalog,
  RestFallbackHandler,
  RestFallbackOptions,
  SessionListOutcome,
  SessionMessageRecord,
  SessionMessagesOutcome,
} from './clientChannelHelpers.js';
import {
  buildJsonRpcErrorFrame,
  buildJsonRpcResultFrame,
  classifyJsonRpcFrame,
  negotiateClientCapabilities,
  type JsonRpcId,
  type ServerRequestFrame,
  type ServerRequestHandler,
} from './serverRequestRouter.js';

export type { JsonRpcId, ServerRequestFrame, ServerRequestHandler } from './serverRequestRouter.js';

const log = createLogger('rpc');

/** 单个 RPC 的参数脱敏口径：通用键名 + method 级额外字段。 */
function redactParams(method: string, params: unknown): unknown {
  return redactInteractivePayload(method, params);
}

/**
 * 契约守卫开关。
 *
 * 【规则 (Rules)】
 * 默认开启。仅在排障时可用 `FLUX_CONTRACT_GUARD=0` 临时关闭，
 * 关闭期间产生的 4000 错误仍必须落日志，不得作为长期方案。
 */
function contractGuardEnabled(): boolean {
  try {
    const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
    const value = proc?.env?.FLUX_CONTRACT_GUARD;
    if (value === '0' || value === 'false') return false;
  // gate-degrade: 浏览器环境没有 process.env，属于正常的不可达分支而非失败
  } catch {
    // 无 process 环境（浏览器）时保持开启
  }
  return true;
}

/**
 * 契约违规错误：请求字段不在网关契约白名单内。
 *
 * 【设计意图 (Why)】
 *   把"我们以为网关要什么"与"网关实际要什么"的差异，从运行时的
 *   `4000 Extra inputs are not permitted` 提前到发送前，并给出精确字段名。
 *
 * 【防范的历史坑 (Pitfall)】
 // gate-degrade: 连接已判定半开，close 失败也要继续走重连流程，不能卡在看门狗里
 *   profiles.get_asset 多传 `key` 被网关 4000 拒绝，调用方 catch 后返回 null，
 *   界面只表现为"没有头像"，排查成本极高。
 *
 * 【规则 (Rules)】
 *   该错误必须显式抛出，严禁被调用方降级为空数据。
 */
export class ContractViolationError extends Error {
  public readonly code = 'CONTRACT_VIOLATION';
  public readonly method: string;
  public readonly unknownFields: string[];
  public readonly allowedFields: string[];

  constructor(method: string, unknownFields: string[], allowedFields: string[]) {
    super(
      `RPC "${method}" 传入了网关契约未声明的字段 [${unknownFields.join(', ')}]，` +
        `允许字段为 [${allowedFields.join(', ') || '无'}]。请对照网关契约修正调用参数。`
    );
    this.name = 'ContractViolationError';
    this.method = method;
    this.unknownFields = unknownFields;
    this.allowedFields = allowedFields;
  }
}

export interface RpcClientOptions {
  url: string;
  /** 可选传输工厂；省略时默认走浏览器/宿主原生 WebSocket（阶段二可注入 E2EE 环回传输） */
  socketFactory?: RpcSocketFactory;
  /**
   * 每次断线重连或唤醒重连前调用，用于刷新一次性凭证（如 ws-ticket）并生成最新 WS URL。
   * 首次 connect() 直接使用 url；自第二次连接（重连）起优先调用本回调。
   */
  resolveUrl?: () => Promise<string | null>;
  /** 候选连接地址池，直连失败或重连时支持按优先级自动轮转（如 [LAN直连, Relay中继]） */
  candidateUrls?: string[];
  timeoutMs?: number;
  autoConnect?: boolean;
  /** 是否启用周期性心跳探测看门狗（默认开启） */
  enableHeartbeat?: boolean;
  /** 心跳探测周期（毫秒，默认 15000ms） */
  heartbeatIntervalMs?: number;
  /** 心跳超时判定阈值（毫秒，默认 5000ms） */
  heartbeatTimeoutMs?: number;
  /** 是否监听移动端/浏览器前后台可见性与网络状态实现即刻唤醒自愈（默认开启） */
  enableLifecycleWake?: boolean;
  /** 建连握手阶段声明的客户端反向请求能力，配置后在 HANDSHAKING 阶段自动协商 `client.capabilities` */
  clientCapabilities?: ClientCapabilitiesParams;
}

export type ProbeOrWakeResult = 'alive' | 'reconnecting' | 'disconnected';

export class HermesGatewayClient {
  private url: string;
  private socketFactory?: RpcSocketFactory;
  private resolveUrl?: () => Promise<string | null>;
  private initialUrlConsumed = false;
  private isResolvingUrl = false;
  private connectEpoch = 0;
  private candidateUrls: string[] = [];
  private currentCandidateIndex = 0;
  private timeoutMs: number;
  private ws: IRpcSocket | null = null;
  private nextId = 1;
  private restFallbackHandler: RestFallbackHandler | null = null;
  private pendingRequests = new Map<
    string | number,
    {
      resolve: (result: unknown) => void;
      reject: (error: unknown) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private notificationHandlers = new Map<string, Set<(params: unknown) => void>>();
  private serverRequestHandlers = new Map<string, GatewayMethodRequestHandler>();
  private defaultServerRequestHandler: DefaultServerRequestHandler | null = null;
  private gatewayReadyState: GatewayReadyState = { ...DEFAULT_GATEWAY_READY_STATE };
  private gatewayInstallId: string | undefined = undefined;
  private serverRequestListeners = new Set<ServerRequestHandler>();
  private socketClosedListeners = new Set<(closedGeneration: number) => void>();
  private socketGeneration = 0;
  private clientCapabilities?: ClientCapabilitiesParams;
  private negotiatedCapabilities: ClientCapabilitiesResult | null = null;
  private fsm: WebSocketFsm;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionalClose = false;
  private connectStartedAt = 0;
  private activeProbePromise: Promise<ProbeOrWakeResult> | null = null;

  // 心跳看门狗状态
  private enableHeartbeat: boolean;
  private heartbeatIntervalMs: number;
  private heartbeatTimeoutMs: number;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimeoutHandle: ReturnType<typeof setTimeout> | null = null;

  // 移动端/跨端前后台生命周期唤醒
  private enableLifecycleWake: boolean;
  private visibilityListener: (() => void) | null = null;
  private onlineListener: (() => void) | null = null;

  constructor(options: RpcClientOptions) {
    this.url = options.url;
    this.socketFactory = options.socketFactory;
    this.resolveUrl = options.resolveUrl;
    this.candidateUrls = options.candidateUrls && options.candidateUrls.length > 0
      ? [...options.candidateUrls]
      : [options.url];
    this.timeoutMs = options.timeoutMs ?? 15000;
    this.enableHeartbeat = options.enableHeartbeat ?? true;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 15000;
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 5000;
    this.enableLifecycleWake = options.enableLifecycleWake ?? true;
    this.clientCapabilities = options.clientCapabilities;

    this.fsm = new WebSocketFsm({
      heartbeatIntervalMs: this.heartbeatIntervalMs,
      heartbeatTimeoutMs: this.heartbeatTimeoutMs,
    });

    this.setupLifecycleListeners();

    if (options.autoConnect) {
      this.connect();
    }
  }

  public setRestFallbackHandler(handler: RestFallbackHandler | null): void {
    this.restFallbackHandler = handler;
  }

  public getSocket(): IRpcSocket | null {
    return this.ws;
  }

  public getRawWebSocket(): IRpcSocket | null {
    return this.ws;
  }

  public getGatewayReadyState(): GatewayReadyState {
    return { ...this.gatewayReadyState };
  }

  public isSessionAuthority(): boolean {
    return this.gatewayReadyState.sessionAuthority;
  }

  public getReplayEpoch(): string | null {
    return this.gatewayReadyState.replayEpoch;
  }

  public getInstallId(): string | undefined {
    return this.gatewayInstallId;
  }

  public setInstallId(installId: string | undefined): void {
    const trimmed = typeof installId === 'string' ? installId.trim() : '';
    this.gatewayInstallId = trimmed || undefined;
  }

  public getFsm(): WebSocketFsm {
    return this.fsm;
  }

  public getState(): FsmState {
    return this.fsm.getState();
  }

  public getSocketGeneration(): number {
    return this.socketGeneration;
  }

  public getNegotiatedCapabilities(): ClientCapabilitiesResult | null {
    return this.negotiatedCapabilities ? { ...this.negotiatedCapabilities } : null;
  }

  public onServerRequest(handler: ServerRequestHandler): () => void;
  /** 注册服务端反向请求的单播处理器；返回注销闭包。 */
  public onServerRequest<TParams = unknown, TResult = unknown>(
    method: string,
    handler: GatewayMethodRequestHandler<TParams, TResult>,
  ): () => void;
  public onServerRequest<TParams = unknown, TResult = unknown>(
    methodOrHandler: string | ServerRequestHandler,
    maybeHandler?: GatewayMethodRequestHandler<TParams, TResult>,
  ): () => void {
    if (typeof methodOrHandler === 'function') {
      this.serverRequestListeners.add(methodOrHandler);
      return () => {
        this.serverRequestListeners.delete(methodOrHandler);
      };
    }
    const typedHandler = maybeHandler as GatewayMethodRequestHandler;
    this.serverRequestHandlers.set(methodOrHandler, typedHandler);
    return () => {
      if (this.serverRequestHandlers.get(methodOrHandler) === typedHandler) {
        this.serverRequestHandlers.delete(methodOrHandler);
      }
    };
  }

  public onSocketClosed(handler: (closedGeneration: number) => void): () => void {
    this.socketClosedListeners.add(handler);
    return () => {
      this.socketClosedListeners.delete(handler);
    };
  }

  public sendServerResponse(
    id: JsonRpcId,
    result: unknown,
    expectedSocketGeneration?: number,
    methodForRedaction?: string,
  ): boolean {
    if (!this.ws || this.ws.readyState !== RPC_SOCKET_READY_STATE.OPEN) return false;
    if (expectedSocketGeneration !== undefined && expectedSocketGeneration !== this.socketGeneration) {
      log.warn('dropping stale server response across socket generation', { id, expectedSocketGeneration, currentSocketGeneration: this.socketGeneration });
      return false;
    }
    log.debug('server request response sent', { id, method: methodForRedaction, result: redactInteractivePayload(methodForRedaction ?? '', result) });
    try {
      this.ws.send(buildJsonRpcResultFrame(id, result));
      return true;
    } catch (err) {
      log.warn('sendServerResponse failed', { id, method: methodForRedaction, err });
      return false;
    }
  }

  public sendServerError(id: JsonRpcId, code: number, message: string, data?: unknown, expectedSocketGeneration?: number): boolean {
    if (!this.ws || this.ws.readyState !== RPC_SOCKET_READY_STATE.OPEN) return false;
    if (expectedSocketGeneration !== undefined && expectedSocketGeneration !== this.socketGeneration) return false;
    try {
      this.ws.send(buildJsonRpcErrorFrame(id, code, message, data));
      return true;
    } catch (err) {
      log.warn('sendServerError failed', { id, code, err });
      return false;
    }
  }

  private bumpSocketGeneration(): void {
    const closingGen = this.socketGeneration;
    this.socketGeneration += 1;
    this.negotiatedCapabilities = null;
    this.socketClosedListeners.forEach((fn) => fn(closingGen));
  }

  public getReconnectAttempt(): number {
    return this.fsm.getAttemptCount();
  }

  public getActiveUrl(): string {
    return this.url;
  }

  public getCandidateUrls(): string[] {
    return [...this.candidateUrls];
  }

  /**
   * 设计意图 (Why):
   *   在移动端或弱网环境下，长连接容易因网络抖动发生直连超时，
   *   通过在重连阶段轮换候选地址（如 [LAN直连, Relay中继]），提供多级网络冗余兜底。
   *
   * 防范的历史坑 (Pitfall):
   *   若单一死守失效的 LAN IP（如离开了工位 Wi-Fi），重连只会死循环超时直至用户手动重启。
   *
   * 约束与规则 (Rules):
   *   - 仅在配置了多于 1 个候选地址时进行循环轮转；
   *   - 轮换后立即更新 this.url 为当前候选。
   */
  public rotateCandidate(): string {
    if (this.candidateUrls.length <= 1) return this.url;
    this.currentCandidateIndex = (this.currentCandidateIndex + 1) % this.candidateUrls.length;
    this.url = this.candidateUrls[this.currentCandidateIndex];
    return this.url;
  }

  /**
   * 设计意图 (Why):
   *   注册移动端/Web 浏览器生命周期事件监听（visibilitychange 和 online）。
   *   当 App 从后台切到前台或网络断开恢复时，触发毫秒级即刻唤醒重连。
   *
   * 防范的历史坑 (Pitfall):
   *   移动操作系统（iOS/Android）在 App 切后台或锁屏时会强行冻结或掐断 WebSocket 连接。
   *   若依赖原生 Exponential Backoff，用户重新打开 App 经常需要干等 10~30 秒才能恢复连接。
   *
   * 约束与规则 (Rules):
   *   - 兼容非 DOM/Node.js 运行环境（安全校验 typeof document !== 'undefined'）；
   *   - 必须保存 listener 引用以便在 disconnect() 时彻底解绑，防止内存泄漏。
   */
  private setupLifecycleListeners(): void {
    if (!this.enableLifecycleWake) return;

    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      this.visibilityListener = () => {
        if (document.visibilityState === 'visible') {
          this.wakeImmediately('visibilitychange:visible');
        }
      };
      document.addEventListener('visibilitychange', this.visibilityListener);
    }

    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      this.onlineListener = () => {
        this.wakeImmediately('network:online');
      };
      window.addEventListener('online', this.onlineListener);
    }
  }

  private teardownLifecycleListeners(): void {
    if (this.visibilityListener && typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
      document.removeEventListener('visibilitychange', this.visibilityListener);
      this.visibilityListener = null;
    }
    if (this.onlineListener && typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
      window.removeEventListener('online', this.onlineListener);
      this.onlineListener = null;
    }
  }

  /**
   * 设计意图 (Why):
   *   前台唤醒或网络恢复触发时，主动打破指数退避休眠，以 0ms 延迟立即发起重连。
   *
   * 防范的历史坑 (Pitfall):
   *   若正在连接或已经处于握手态，盲目重连会导致重复创建 WebSocket 形成脑裂；
   *   若不重置退避计数器（resetAttempts），后续正常断线依然会被污染残留的高延迟。
   *
   * 约束与规则 (Rules):
   *   - 已处于 CONNECTED 或 HANDSHAKING 时无操作直接返回；
   *   - 必须清理已调度的 reconnectTimer 定时器；
   *   - 必须调用 fsm.resetAttempts() 清空退避累积。
   */
  public wakeImmediately(reason = 'manual'): void {
    if (this.intentionalClose) return;
    const current = this.fsm.getState();
    if (current === 'CONNECTED' || current === 'HANDSHAKING') {
      return;
    }

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.fsm.resetAttempts();
    this.connect();
  }

  private teardownDeadSocket(reason: string): void {
    this.connectEpoch++;
    this.isResolvingUrl = false;
    this.activeProbePromise = null;
    this.stopHeartbeat();
    const oldSocket = this.ws;
    this.ws = null;
    this.bumpSocketGeneration();
    this.clearPendingRequests(reason);
    if (oldSocket) {
      try {
        oldSocket.close();
      } catch (err) {
        // gate-degrade: 强制拆除死连接时 close() 抛错不影响后续重建
        log.debug('close() on stale/dead socket failed', err);
      }
    }
  }

  /**
   * 主动探活或打破退避休眠立即唤醒重连。
   *
   * 【设计意图 (Why)】
   *   移动端切回前台、桌面休眠唤醒或静默切换 Wi-Fi/5G 时，底层 TCP 套接字常处于"半开"状态，
   *   而 client FSM 仍停留在 CONNECTED（甚至无感挂在 CONNECTING/HANDSHAKING）。
   *   本方法通过单飞短超时 ping 探活，一旦发现链路失效或握手卡死，立即拆除半开连接并重置退避重连。
   *
   * 【防范的历史坑 (Pitfall)】
   *   1. 卡在 CONNECTING/HANDSHAKING 时严禁调用 disconnect()（会永久置 intentionalClose=true 导致无法恢复）；
   *   2. 卡在 isResolvingUrl=true 时必须重置标志并递增 connectEpoch，防止迟到回调篡改新连接。
   *
   * 【约束与规则 (Rules)】
   *   - CONNECTED 态发往同一步并发探活必须单飞去重；
   *   - legacy 网关返回数字型 JSON-RPC 错误码（如 -32601）判定为传输存活 ('alive')。
   */
  public async probeOrWake(
    reason = 'manual',
    opts: { probeTimeoutMs?: number; staleConnectingMs?: number } = {},
  ): Promise<ProbeOrWakeResult> {
    if (this.intentionalClose) return 'disconnected';

    const probeTimeoutMs = opts.probeTimeoutMs ?? 2500;
    const staleConnectingMs = opts.staleConnectingMs ?? 5000;
    const current = this.fsm.getState();

    if (current === 'CONNECTED') {
      if (this.activeProbePromise) {
        return this.activeProbePromise;
      }
      if (!this.ws || this.ws.readyState !== RPC_SOCKET_READY_STATE.OPEN) {
        this.teardownDeadSocket(`Socket not open on probe (${reason})`);
        this.fsm.transitionTo('RECONNECTING');
        this.wakeImmediately(reason);
        return 'reconnecting';
      }
      const probeSocket = this.ws;
      let probePromise: Promise<ProbeOrWakeResult> | null = null;
      probePromise = (async (): Promise<ProbeOrWakeResult> => {
        try {
          await this.call('ping', {}, probeTimeoutMs);
          return 'alive';
        } catch (err) {
          if (isLegacyRpcMethodError(err)) {
            return 'alive';
          }
          if (this.intentionalClose) {
            return 'disconnected';
          }
          if (this.ws !== probeSocket) {
            return 'reconnecting';
          }
          log.warn('active probe ping failed, recycling dead connection', { reason, err });
          this.teardownDeadSocket(`Probe failed (${reason})`);
          this.fsm.transitionTo('RECONNECTING');
          this.wakeImmediately(reason);
          return 'reconnecting';
        } finally {
          if (this.activeProbePromise === probePromise) {
            this.activeProbePromise = null;
          }
        }
      })();
      this.activeProbePromise = probePromise;
      return probePromise;
    }

    if (current === 'CONNECTING' || current === 'HANDSHAKING') {
      if (Date.now() - this.connectStartedAt < staleConnectingMs) {
        return 'reconnecting';
      }
      log.warn('stale connecting/handshaking detected on wake, resetting socket', { reason, state: current });
      this.teardownDeadSocket(`Stale ${current} reset (${reason})`);
      this.fsm.transitionTo('RECONNECTING');
      this.wakeImmediately(reason);
      return 'reconnecting';
    }

    this.wakeImmediately(reason);
    return 'reconnecting';
  }

  /**
   * 设计意图 (Why):
   *   在长连接成功建立后启动周期性应用层心跳看门狗。
   *
   * 防范的历史坑 (Pitfall):
   *   1. 移动网络与 NAT 路由存在短生存期的半开连接陷阱（客户端认为连接正常但网关已死）。
   *      若无周期性心跳应答超时检测，客户端将永久挂在假在线状态无法感知断网。
   *   2. 曾使用不存在的方法名 `system.ping`：网关直接返回 -32601，
   *      而 `.finally` 又把超时看门狗清掉，导致看门狗**从未真正生效**。
   *      正确方法是网关在 `tui_gateway/methods_voice.py` 单独注册的 `ping`
   *      （返回 `{ pong: true }`，专门用于 sleep/wake 后的半开探测）。
   *   3. 失败分支也曾无条件清理看门狗：传输层超时被当作"有应答"处理，
   *      半开连接永远不会被主动关闭。只有「服务器确实回了包」才允许清理。
   *
   * 约束与规则 (Rules):
   *   - 仅在 CONNECTED 状态下运行；
   *   - 发起 ping 后必须设置超时看门狗，超时未应答直接主动 close() 销毁死连接触发重连自愈；
   *   - 只有收到服务器响应（成功或带 JSON-RPC 错误码）才清理看门狗；
   *     传输层失败一律保留看门狗，让它把死连接关掉。
   */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    if (!this.enableHeartbeat) return;

    this.heartbeatTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== RPC_SOCKET_READY_STATE.OPEN || this.fsm.getState() !== 'CONNECTED') {
        return;
      }

      this.heartbeatTimeoutHandle = setTimeout(() => {
        log.warn('heartbeat watchdog timeout, terminating half-open connection', {
          heartbeatTimeoutMs: this.heartbeatTimeoutMs,
          state: this.fsm.getState(),
        });
        this.stopHeartbeat();
        if (this.ws) {
          try {
            this.ws.close();
          } catch (err) {
            // gate-degrade: 连接已判定半开，close 失败也要继续走重连流程，不能卡在看门狗里
            log.debug('close() on half-open socket failed', err);
          }
        }
      }, this.heartbeatTimeoutMs);

      this.call('ping', {})
        .then(() => {
          this.clearHeartbeatTimeout();
        })
        .catch((err: unknown) => {
          const code = (err as { code?: unknown } | null)?.code;
          // 服务器回了 JSON-RPC 错误码说明链路是活的，可以清理看门狗；
          // 传输层超时/断开则保留看门狗，交给它关闭死连接。
          if (typeof code === 'number') {
            this.clearHeartbeatTimeout();
            return;
          }
          log.warn('heartbeat ping failed without server response', err);
        });
    }, this.heartbeatIntervalMs);
  }

  private clearHeartbeatTimeout(): void {
    if (this.heartbeatTimeoutHandle) {
      clearTimeout(this.heartbeatTimeoutHandle);
      this.heartbeatTimeoutHandle = null;
    }
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.heartbeatTimeoutHandle) {
      clearTimeout(this.heartbeatTimeoutHandle);
      this.heartbeatTimeoutHandle = null;
    }
  }

  /**
   * 发起 WebSocket 连接。
   *
   * 【设计意图 (Why)】
   *   新版 Hermes 网关（v0.23.1+）的 `/api/auth/ws-ticket` 为 30s 短效且严格一次性消费：
   *   初次建连或握手失败后一旦断开，重连若复用旧 URL 里的旧 ticket 会被网关永久返回 403。
   *
   * 【防范的历史坑 (Pitfall)】
   *   构造器同步将 ticket 写死进 `this.url`，导致网络抖动、心跳超时或唤醒重连时一直拿着
   *   已消费/过期的 `?ticket=...` 死循环重连。
   *
   * 【约束与规则 (Rules)】
   *   - 首次建连直接使用构造传入的 `this.url`（保持同步建连行为与测试兼容）；
   *   - 自第二次尝试起，若配置了 `resolveUrl` 则先递增 `connectEpoch` 异步刷新最新 ticket URL；
   *   - 任何时候调用 `disconnect()` 均递增 `connectEpoch`，彻底废止在途异步回调。
   */
  public connect(): void {
    if (!this.socketFactory && typeof WebSocket === 'undefined') {
      console.warn('[HermesGatewayClient] WebSocket runtime is unavailable');
      return;
    }

    if (
      this.ws &&
      (this.ws.readyState === RPC_SOCKET_READY_STATE.OPEN ||
        this.ws.readyState === RPC_SOCKET_READY_STATE.CONNECTING)
    ) {
      return;
    }

    if (this.isResolvingUrl) {
      return;
    }

    this.intentionalClose = false;
    this.connectStartedAt = Date.now();
    this.fsm.transitionTo('CONNECTING');

    if (this.initialUrlConsumed && this.resolveUrl) {
      const myEpoch = ++this.connectEpoch;
      this.isResolvingUrl = true;
      void this.resolveAndOpenWebSocket(myEpoch);
      return;
    }

    this.initialUrlConsumed = true;
    this.openWebSocket(this.url);
  }

  private async resolveAndOpenWebSocket(myEpoch: number): Promise<void> {
    try {
      const nextUrl = await this.resolveUrl?.();
      if (this.intentionalClose || myEpoch !== this.connectEpoch) {
        return;
      }
      this.isResolvingUrl = false;
      if (!nextUrl) {
        this.scheduleReconnect();
        return;
      }
      this.url = nextUrl;
      this.openWebSocket(nextUrl);
    } catch (err) {
      if (this.intentionalClose || myEpoch !== this.connectEpoch) {
        return;
      }
      this.isResolvingUrl = false;
      log.warn('resolveUrl failed before reconnect, scheduling retry', err);
      this.scheduleReconnect();
    }
  }

  private completeHandshake(socket: IRpcSocket): void {
    if (this.intentionalClose || this.ws !== socket) return;
    log.info('handshake ok, connected');
    // ping 确认连通即立即完成握手晋升 CONNECTED，能力协商随后异步并发执行，
    // 既避免未实现 client.capabilities 的旧版网关/离线夹具卡死在 CONNECTING 3s，又不影响后续反向请求到达前完成能力声明。
    this.fsm.transitionTo('CONNECTED');
    this.startHeartbeat();
    if (this.clientCapabilities) {
      void negotiateClientCapabilities(
        this,
        this.clientCapabilities,
        Math.min(this.heartbeatTimeoutMs, 3000),
      ).then((caps) => {
        if (this.intentionalClose || this.ws !== socket) return;
        this.negotiatedCapabilities = caps;
      });
    }
  }

  private openWebSocket(targetUrl: string): void {
    this.connectStartedAt = Date.now();
    this.socketGeneration += 1;
    this.negotiatedCapabilities = null;
    try {
      const socket = this.socketFactory
        ? this.socketFactory(targetUrl)
        : createBrowserRpcSocket(targetUrl);
      this.ws = socket;

      socket.onopen = () => {
        if (this.intentionalClose || this.ws !== socket) return;
        this.connectStartedAt = Date.now();
        this.fsm.transitionTo('HANDSHAKING');
        log.info('websocket open, handshaking', { url: targetUrl });
        // 握手探针：网关 `ping` 返回 { pong: true }，是最轻量的存活确认
        const handshakeTimeoutMs = Math.min(this.heartbeatTimeoutMs, 5000);
        this.call('ping', {}, handshakeTimeoutMs)
          .then(() => {
            if (this.intentionalClose || this.ws !== socket) return;
            void this.completeHandshake(socket);
          })
          .catch((err: unknown) => {
            if (this.intentionalClose || this.ws !== socket) return;
            // 仅当老版本网关回包了数字型 JSON-RPC 错误码（如 -32601）才证明传输已连通；
            // 传输超时/断连必须关掉半开套接字并调度重连，防止"假在线"。
            if (isLegacyRpcMethodError(err)) {
              log.warn('handshake ping returned RPC error, proceeding as connected', err);
              void this.completeHandshake(socket);
              return;
            }
            log.warn('handshake ping failed, closing socket and scheduling reconnect', err);
            this.ws = null;
            this.bumpSocketGeneration();
            this.clearPendingRequests('Handshake ping failed');
            try {
              socket.close();
            } catch (closeErr) {
              // gate-degrade: 握手失败关闭半开套接字异常时仍继续调度重连
              log.debug('close() on failed handshake socket failed', closeErr);
            }
            this.scheduleReconnect();
          });
      };

      socket.onmessage = (event: RpcSocketMessageEvent) => {
        if (this.intentionalClose || this.ws !== socket) return;
        this.handleMessage(event.data);
      };

      socket.onerror = (err) => {
        if (this.ws !== socket) return;
        console.warn('[HermesGatewayClient] WebSocket error:', err);
      };

      socket.onclose = () => {
        if (this.ws !== socket) return;
        this.stopHeartbeat();
        this.ws = null;
        this.bumpSocketGeneration();
        this.clearPendingRequests('WebSocket closed');
        if (!this.intentionalClose) {
          this.scheduleReconnect();
        } else {
          this.fsm.transitionTo('DISCONNECTED');
        }
      };
    } catch (err) {
      console.error('[HermesGatewayClient] Failed to instantiate WebSocket:', err);
      this.stopHeartbeat();
      this.scheduleReconnect();
    }
  }

  private clearPendingRequests(reason = 'Connection closed'): void {
    for (const [, req] of this.pendingRequests.entries()) {
      clearTimeout(req.timer);
      req.reject(new Error(reason));
    }
    this.pendingRequests.clear();
  }

  public disconnect(): void {
    this.intentionalClose = true;
    this.connectEpoch++;
    this.isResolvingUrl = false;
    this.activeProbePromise = null;
    this.stopHeartbeat();
    this.teardownLifecycleListeners();
    this.clearPendingRequests('Client disconnected');
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.gatewayReadyState = { ...DEFAULT_GATEWAY_READY_STATE };
    this.bumpSocketGeneration();
    this.fsm.transitionTo('DISCONNECTED');
  }

  private scheduleReconnect(): void {
    this.stopHeartbeat();
    this.fsm.transitionTo('RECONNECTING');

    // 轮换至下一个候选地址（若配置了多候选）
    if (this.candidateUrls.length > 1) {
      this.rotateCandidate();
    }

    const delay = this.fsm.getNextBackoffMs();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, delay);
  }

  /**
   * 发送前契约守卫：字段白名单校验。
   *
   * 【设计意图 (Why)】
   * 网关对入参执行 Pydantic `extra='forbid'`，多写一个字段就是 4000。
   * 把这一步提前到本地，能让错误在开发期就带着精确字段名暴露，
   * 而不是等网关拒绝、再被上层 catch 降级成"没数据"。
   *
   * 【防范的历史坑 (Pitfall)】
   * profiles.get_asset 多传 key、groups.send 平铺 text、
   * subagent.steer 传 instruction 等，全部属于此类静默失败。
   *
   * 【规则 (Rules)】
   * - 契约快照里没有登记的方法只记 debug 日志放行（可能是网关新增方法）；
   * - 可通过 FLUX_CONTRACT_GUARD=0 临时关闭（仅限排障，禁止长期关闭）；
   * - 违规必须抛出 ContractViolationError，不允许静默丢弃字段后继续发送。
   */
  private validateContract(method: string, params: unknown): void {
    if (!contractGuardEnabled()) return;
    if (!params || typeof params !== 'object' || Array.isArray(params)) return;

    const spec = CONTRACT_METHODS[method] ?? EXTRA_METHODS[method];
    if (!spec) {
      log.debug('contract: method not in snapshot, allowing through', { method });
      return;
    }

    const allowed = new Set<string>(spec.params);
    const unknownFields = Object.keys(params as Record<string, unknown>).filter((key) => !allowed.has(key));
    if (unknownFields.length === 0) return;

    const error = new ContractViolationError(method, unknownFields, spec.params as string[]);
    log.error('contract violation', {
      method,
      unknownFields,
      allowedFields: spec.params,
      // 契约违规发生在参数已被接收之后，日志同样可能带明文凭据，必须同口径脱敏。
      params: redactParams(method, params),
    });
    throw error;
  }

  /**
   * 慢速长耗时 RPC 默认超时时间表（单位：毫秒）。
   *
   * 【设计意图 (Why)】
   *   大上下文提炼压缩（session.compress）、执行外部斜杠技能与压缩指令（slash.exec）等操作
   *   依赖服务端大语言模型真实推理。在数十轮、数万 Token 的对话历史下，服务端推理耗时通常在 20s ~ 90s 之间。
   *   全局默认的 25s 超时会在服务端生成完成前单方面超时熔断，造成前端误报失败且丢失状态重拉。
   *
   * 【防范的历史坑 (Pitfall)】
   *   硬编码统一短超时会导致所有慢速操作在大上下文下 100% 报 timed out after 25000ms。
   *
   * 【约束与规则 (Rules)】
   *   - 显式传入 timeoutMs 优先；
   *   - 命中 LONG_RUNNING_METHOD_TIMEOUT_MS 查表次之；
   *   - 其余普通快速查询保持默认 this.timeoutMs。
   */
  public static readonly LONG_RUNNING_METHOD_TIMEOUT_MS: Readonly<Record<string, number>> = {
    'slash.exec': 120_000,
    'command.dispatch': 120_000,
    'session.compress': 120_000,
    'prompt.submit': 180_000,
    'cli.exec': 120_000,
  };

  public call<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    // 契约校验失败必须以 rejected promise 形式返回，保证调用方的
    // `await` / `.catch()` 语义统一，不会出现"同步抛错绕过 catch"的漏洞。
    try {
      this.validateContract(method, params);
    } catch (err) {
      return Promise.reject(err);
    }
    const id = this.nextId++;
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    };

    // 【规则】params 必须先过脱敏：model.save_key 的 api_key、登录密码、token
    // 一旦进入文件日志就是明文凭据泄露（见 log/redact.ts 的历史坑说明）。
    // mcp.servers.set_api_key 的凭据字段名是 value，单看键名无法判定，按 method 补。
    log.debug('rpc call', {
      id,
      method,
      params: redactParams(method, params),
    });

    const effectiveTimeout = timeoutMs ?? HermesGatewayClient.LONG_RUNNING_METHOD_TIMEOUT_MS[method] ?? this.timeoutMs;

    return new Promise<T>((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== RPC_SOCKET_READY_STATE.OPEN) {
        log.warn('rpc call rejected: socket not open', { method, state: this.fsm.getState() });
        return reject(new Error(`WebSocket is not connected (current state: ${this.fsm.getState()})`));
      }

      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        log.warn('rpc call timed out', { id, method, timeoutMs: effectiveTimeout });
        reject(new Error(`RPC request '${method}' with id ${id} timed out after ${effectiveTimeout}ms`));
      }, effectiveTimeout);
      if (typeof (timer as { unref?: () => void }).unref === 'function') {
        (timer as { unref: () => void }).unref();
      }

      this.pendingRequests.set(id, {
        resolve: resolve as (result: unknown) => void,
        reject,
        timer,
      });

      try {
        this.ws.send(JSON.stringify(request));
      } catch (sendErr) {
        clearTimeout(timer);
        this.pendingRequests.delete(id);
        reject(sendErr instanceof Error ? sendErr : new Error(String(sendErr)));
      }
    });
  }

  /**
   * IRpcCaller adaptation for direct plug-in compatibility with ProfileService, ProjectService and GroupRoomStore
   */
  public request<TResult = unknown, TParams = unknown>(method: string, params?: TParams, timeoutMs?: number): Promise<TResult> {
    return this.call<TResult>(method, params, timeoutMs);
  }

  public onNotification<T = unknown>(method: string, handler: (params: T) => void): () => void {
    if (!this.notificationHandlers.has(method)) {
      this.notificationHandlers.set(method, new Set());
    }
    const handlers = this.notificationHandlers.get(method)!;
    handlers.add(handler as (params: unknown) => void);

    return () => {
      handlers.delete(handler as (params: unknown) => void);
    };
  }

  /** 注册或替换兜底服务端反向请求处理器；返回注销闭包。 */
  public setDefaultServerRequestHandler(handler: DefaultServerRequestHandler | null): () => void {
    this.defaultServerRequestHandler = handler;
    return () => {
      if (this.defaultServerRequestHandler === handler) {
        this.defaultServerRequestHandler = null;
      }
    };
  }

  /** 向网关声明客户端能力（如支持双向反向请求），返回网关协商结果。 */
  public negotiateCapabilities(params: ClientCapabilitiesParams): Promise<ClientCapabilitiesResult> {
    return this.call<ClientCapabilitiesResult>('client.capabilities', params);
  }

  /** 按 `session_authority` 语义拉取断线期间遗漏的会话增量事件并归一化结果。 */
  public async fetchSessionEventsSince(
    query: Omit<SessionEventsSinceQuery, 'sessionAuthority'> & { sessionAuthority?: boolean },
  ): Promise<SessionEventsSinceNormalizedResult> {
    const params = buildSessionEventsSinceParams({
      sessionId: query.sessionId,
      profile: query.profile,
      cursor: query.cursor,
      replayEpoch:
        query.replayEpoch !== undefined
          ? query.replayEpoch
          : (this.gatewayReadyState.replayEpoch ?? undefined),
      sessionAuthority: query.sessionAuthority ?? this.gatewayReadyState.sessionAuthority,
    });
    const raw = await this.call<unknown>('session.events.since', params);
    return normalizeSessionEventsSinceResult(raw);
  }

  private dispatchServerRequest(id: string | number, method: string, params: unknown): void {
    const specificHandler = this.serverRequestHandlers.get(method);
    const defaultHandler = this.defaultServerRequestHandler;
    void executeServerRequestFrame({ id, method, params }, specificHandler, defaultHandler).then(
      (frame) => {
        if (this.ws && this.ws.readyState === RPC_SOCKET_READY_STATE.OPEN) {
          this.ws.send(frame);
        }
      },
    );
  }

  private get channelTransport(): ClientChannelTransport {
    return {
      call: <T = unknown>(method: string, params?: unknown, timeoutMs?: number) =>
        this.call<T>(method, params, timeoutMs),
      isSocketOpen: () => Boolean(this.ws && this.ws.readyState === RPC_SOCKET_READY_STATE.OPEN),
      getFsmState: () => this.fsm.getState(),
      getRestFallback: () => this.restFallbackHandler,
    };
  }

  public async listSessions(profile = 'default', limit = 50): Promise<SessionListOutcome> {
    return listSessionsWithFallback(this.channelTransport, profile, limit);
  }

  public async listSessionsSafe(profile = 'default', limit = 50): Promise<NormalizedSession[]> {
    const outcome = await this.listSessions(profile, limit);
    return outcome.sessions;
  }

  public async listArchivedSessions(profile = 'default', limit = 50): Promise<SessionListOutcome> {
    return listArchivedSessionsWithFallback(this.channelTransport, profile, limit);
  }

  public async fetchSessionMessages(
    sessionId: string,
    options: {
      limit?: number;
      offset?: number;
      order?: 'latest' | 'oldest';
      profile?: string;
      includeCompacted?: boolean;
    } = {},
  ): Promise<SessionMessagesOutcome> {
    if (!this.restFallbackHandler) {
      return { status: 'error', error: '未注入 REST 通信代理处理器' };
    }
    try {
      const res = await this.restFallbackHandler(
        `/api/sessions/${encodeURIComponent(sessionId)}/messages`,
        {
          method: 'GET',
          params: {
            limit: options.limit ?? 50,
            offset: options.offset ?? 0,
            order: options.order ?? 'latest',
            ...(options.profile ? { profile: options.profile } : {}),
            ...(options.includeCompacted ? { include_compacted: true } : {}),
          },
        },
      );
      const resObj = res && typeof res === 'object' ? (res as { messages?: unknown; pagination?: unknown }) : null;
      if (!resObj || !Array.isArray(resObj.messages)) return { status: 'error', error: '消息响应格式无效' };
      const messages = resObj.messages.filter((message): message is SessionMessageRecord => Boolean(message && typeof message === 'object'));
      if (messages.length !== resObj.messages.length) return { status: 'error', error: '消息记录格式无效' };
      const pag = resObj.pagination && typeof resObj.pagination === 'object'
        ? (resObj.pagination as { returned?: unknown; total?: unknown })
        : null;
      return {
        status: 'success',
        messages,
        ...(pag
          ? {
              pagination: {
                ...(typeof pag.returned === 'number' ? { returned: pag.returned } : {}),
                ...(typeof pag.total === 'number' ? { total: pag.total } : {}),
              },
            }
          : {}),
      };
    } catch (err) {
      return { status: 'error', error: describeError(err) };
    }
  }

  public async fetchLastMessage(
    sessionId: string,
    options?: { profile?: string },
  ): Promise<{ text: string; timestamp: number; role: string } | null> {
    return fetchLastMessageWithFallback(this.channelTransport, sessionId, options);
  }

  public async getModelCatalog(profile = 'default', fallbackModels: string[] = []): Promise<ModelCatalog> {
    return getModelCatalogWithFallback(this.channelTransport, profile, fallbackModels);
  }

  public async getModelOptionsSafe(profile = 'default', fallbackModels: string[] = []): Promise<string[]> {
    const catalog = await this.getModelCatalog(profile, fallbackModels);
    return catalog.models;
  }

  public async listProfiles(): Promise<AgentProfile[]> {
    const { profiles, installId } = await listProfilesWithFallback(this.channelTransport);
    if (installId) {
      this.gatewayInstallId = installId;
    }
    return profiles;
  }

  public async fetchGatewayConfig(profile?: string): Promise<Record<string, unknown>> {
    return fetchGatewayConfigWithFallback(this.channelTransport, profile);
  }

  public async getSessionUsage(liveSessionId: string, profile?: string): Promise<SessionUsageResult> {
    return this.call<SessionUsageResult>('session.usage', {
      session_id: liveSessionId,
      ...(profile ? { profile } : {}),
    });
  }

  public async getSessionContextBreakdown(
    liveSessionId: string,
    profile?: string
  ): Promise<SessionContextBreakdownResult> {
    return this.call<SessionContextBreakdownResult>('session.context_breakdown', {
      session_id: liveSessionId,
      ...(profile ? { profile } : {}),
    });
  }

  public async compressSession(
    liveSessionId: string,
    profile?: string,
    focusTopic?: string
  ): Promise<SessionCompressResult> {
    return this.call<SessionCompressResult>('session.compress', {
      session_id: liveSessionId,
      ...(profile ? { profile } : {}),
      ...(focusTopic ? { focus_topic: focusTopic } : {}),
    });
  }

  public async fetchSubagentTranscript(params: StoredTranscriptParams): Promise<StoredTranscriptResult> {
    return this.call<StoredTranscriptResult>('session.transcript', {
      session_id: params.session_id,
      ...(params.profile ? { profile: params.profile } : {}),
      ...(params.subagent_id ? { subagent_id: params.subagent_id } : {}),
      ...(params.cursor !== undefined ? { cursor: params.cursor } : {}),
      ...(typeof params.limit === 'number' ? { limit: params.limit } : {}),
      ...(params.order ? { order: params.order } : {}),
      ...(typeof params.inline_images === 'boolean' ? { inline_images: params.inline_images } : {}),
    });
  }

  public async listSpawnTrees(sessionId?: string, profile?: string, limit?: number): Promise<SpawnTreeListResult> {
    return this.call<SpawnTreeListResult>('spawn_tree.list', {
      ...(sessionId ? { session_id: sessionId } : {}),
      ...(profile ? { profile } : {}),
      ...(typeof limit === 'number' ? { limit } : {}),
    });
  }

  public async loadSpawnTree(path: string, profile?: string): Promise<SpawnTreeLoadResult> {
    return this.call<SpawnTreeLoadResult>('spawn_tree.load', {
      path,
      ...(profile ? { profile } : {}),
    });
  }

  private handleMessage(raw: unknown): void {
    if (typeof raw !== 'string') return;
    try {
      const frame = classifyJsonRpcFrame(JSON.parse(raw));
      if (frame.kind === 'server-request') {
        log.debug('server request received', {
          id: frame.id,
          method: frame.method,
          params: redactInteractivePayload(frame.method, frame.params),
        });
        let claimed = false;
        for (const listener of this.serverRequestListeners) {
          try {
            if (listener({ ...frame, socketGeneration: this.socketGeneration }) === true) {
              claimed = true;
            }
          } catch (listenerErr) {
            log.warn('server request listener threw', { id: frame.id, method: frame.method, listenerErr });
          }
        }
        if (claimed) return;
        if (this.serverRequestHandlers.has(frame.method) || this.defaultServerRequestHandler) {
          this.dispatchServerRequest(frame.id, frame.method, frame.params);
          return;
        }
        this.sendServerError(frame.id, -32601, `Unhandled server request: ${frame.method}`, undefined, this.socketGeneration);
        return;
      }
      if (frame.kind === 'response') {
        const pending = this.pendingRequests.get(frame.id);
        if (!pending) return;
        this.pendingRequests.delete(frame.id);
        clearTimeout(pending.timer);
        if (frame.error) {
          pending.reject(frame.error);
        } else {
          pending.resolve(frame.result);
        }
        return;
      }
      if (frame.kind === 'notification') {
        if (frame.method === 'gateway.ready') {
          this.gatewayReadyState = parseGatewayReadyParams(frame.params);
        }
        const handlers = this.notificationHandlers.get(frame.method);
        if (handlers) {
          handlers.forEach((fn) => fn(frame.params));
        }
      }
    } catch (e) {
      console.warn('[HermesGatewayClient] JSON parse error on message:', e);
    }
  }
}
