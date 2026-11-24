/**
 * 网关连接相位与恢复策略纯逻辑模型 (packages/core/src/rpc/connectionPhase.ts)
 *
 * 【设计意图 (Why)】
 *   将底层 WebSocket FSM 状态、冷启动退避重试、鉴权失效识别与"同步中 / 已同步"瞬时相位
 *   统一收敛为领域无关的 7 态纯类型与纯函数，供 Desktop / Mobile / Web 三端共享单一真值源。
 *
 * 【防范的历史坑 (Pitfall)】
 *   1. 旧实现把 HANDSHAKING 误当成已连接（导致发消息与切页抢跑在握手前报错），
 *      把 RECONNECTING 当成"既未连接也未连接中"（导致桌面端删光输入舱与消息流）；
 *   2. 401/凭据错误在旧设计下会被无限重连死循环或误判为临时断网；
 *   3. 错误分类正则若散落在 UI 层会触发源码中文/硬编码文案门禁。
 *
 * 【约束与规则 (Rules)】
 *   - 零 DOM / React / Electron 依赖；
 *   - authError 与 manualDisconnected 优先级恒高于瞬态重连；
 *   - resolveTitlebarConnectionStatus 对非重连断网收敛为 offline，不泄露中间相位。
 */

import type { FsmState } from './fsm.js';

export type GatewayConnectionPhase =
  | 'unconfigured'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'syncing'
  | 'synced'
  | 'offline';

export type ConnectionFailureKind = 'auth' | 'config' | 'transient';

export type TitlebarConnectionStatus = 'connected' | 'reconnecting' | 'syncing' | 'offline';

const COLD_START_BACKOFF_MS: readonly number[] = [1000, 2000, 4000, 8000, 15000];

const AUTH_ERROR_PATTERN =
  /\b40[13]\b|unauthorized|invalid credentials|invalid password|auth failed|authentication|认证失败|密码错误|用户名或密码|安全拦截/i;

const CONFIG_ERROR_PATTERN =
  /invalid url|请先填写网关地址|地址格式|url 格式/i;

/**
 * 判定网关认证/连接失败属于不可自动重试的凭据错误、配置错误还是可恢复的瞬态网络故障。
 */
export function classifyConnectionError(
  message: string | undefined,
  statusCode?: number,
): ConnectionFailureKind {
  if (statusCode === 401 || statusCode === 403) {
    return 'auth';
  }
  const text = typeof message === 'string' ? message.trim() : '';
  if (!text) {
    return 'transient';
  }
  if (AUTH_ERROR_PATTERN.test(text)) {
    return 'auth';
  }
  if (CONFIG_ERROR_PATTERN.test(text)) {
    return 'config';
  }
  return 'transient';
}

/**
 * 计算冷启动鉴权/探活失败后的退避重试间隔（毫秒）。
 */
export function computeColdStartRetryDelayMs(attempt: number): number {
  if (!Number.isFinite(attempt) || attempt <= 1) {
    return COLD_START_BACKOFF_MS[0];
  }
  const idx = Math.min(Math.floor(attempt) - 1, COLD_START_BACKOFF_MS.length - 1);
  return COLD_START_BACKOFF_MS[idx];
}

export interface ResolveConnectionPhaseInput {
  hasGatewayUrl: boolean;
  manualDisconnected: boolean;
  authError: boolean;
  fsmState: FsmState | null;
  isSyncing: boolean;
  isSyncedFlash: boolean;
  isColdStartRetrying: boolean;
  hasConnectedOnce?: boolean;
}

/**
 * 根据底层状态机与同步阶段归约出唯一权威的 UI 连接相位。
 */
export function resolveConnectionPhase(input: ResolveConnectionPhaseInput): GatewayConnectionPhase {
  if (!input.hasGatewayUrl) {
    return 'unconfigured';
  }
  if (input.manualDisconnected || input.authError) {
    return 'offline';
  }
  if (input.fsmState === 'CONNECTED') {
    if (input.isSyncing) return 'syncing';
    if (input.isSyncedFlash) return 'synced';
    return 'connected';
  }
  if (input.fsmState === 'RECONNECTING') {
    return 'reconnecting';
  }
  if (input.fsmState === 'CONNECTING' || input.fsmState === 'HANDSHAKING') {
    return input.isColdStartRetrying || input.hasConnectedOnce ? 'reconnecting' : 'connecting';
  }
  if (input.isColdStartRetrying) {
    return 'reconnecting';
  }
  return 'offline';
}

/**
 * 将 7 态连接相位映射为桌面极简顶栏状态点所需的 4 态属性。
 */
export function resolveTitlebarConnectionStatus(
  phase: GatewayConnectionPhase,
  gatewayConnected: boolean,
): TitlebarConnectionStatus {
  if (phase === 'syncing') return 'syncing';
  if (phase === 'connecting' || phase === 'reconnecting') return 'reconnecting';
  if (phase === 'connected' || phase === 'synced') return 'connected';
  return gatewayConnected ? 'connected' : 'offline';
}

/**
 * 判定 JSON-RPC 异常是否来自网关明确返回的业务/协议错误码（证明传输链路仍存活）。
 */
export function isLegacyRpcMethodError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  return typeof (err as { code?: unknown }).code === 'number';
}
