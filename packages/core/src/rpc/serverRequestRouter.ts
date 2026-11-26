/**
 * JSON-RPC 2.0 服务端反向请求（Server → Client Request）帧分类与安全路由原语
 *
 * 【设计意图 (Why)】
 *   Hermes 网关会在工具执行或授权挂起期间，通过同一条 WebSocket 下发带 `id` 的反向请求
 *   （如 clarify / approval / secret / sudo / vault.* / display.install.sudo）。
 *   既往 `HermesGatewayClient.handleMessage` 将其误判为普通通知并静默丢弃 `id`，
 *   致使后端挂起等待直至 300s 超时。本模块把帧分类与降级规则下沉为纯逻辑，避免 `client.ts` 膨胀。
 *
 * 【防范的历史坑 (Pitfall)】
 *   1. 客户端/服务端 JSON-RPC ID 空间独立：若仅先查 `pendingRequests.has(data.id)` 再判 `method`，
 *      当服务端反向请求恰好复用同号数值 id 时，会被错认成客户端发起的 RPC 响应并把在途调用提前 resolve 掉；
 *      必须**优先判定 `typeof method === 'string'`**。
 *   2. 畸形帧带 `id: null` 与 `method` 时，`id !== undefined` 会误匹配；必须同时排除 `id === null`。
 *
 * 【约束与规则 (Rules)】
 *   - 纯 TypeScript，零 DOM / 零副作用；
 *   - 不支持的 `desktop_local` 与 Phase-3 延迟方法提供显式拒绝/空响应生成策略，严禁无限挂死网关。
 */

import type {
  ClientCapabilitiesParams,
  ClientCapabilitiesResult,
} from './contracts/gateway-contract.generated.js';

export type JsonRpcId = string | number;

export type ClassifiedJsonRpcFrame =
  | {
      kind: 'server-request';
      id: JsonRpcId;
      method: string;
      params: Record<string, unknown>;
    }
  | {
      kind: 'notification';
      method: string;
      params: unknown;
    }
  | {
      kind: 'response';
      id: JsonRpcId;
      result: unknown;
      error: unknown;
    }
  | { kind: 'ignore' };

export interface ServerRequestFrame {
  id: JsonRpcId;
  method: string;
  params: Record<string, unknown>;
  socketGeneration: number;
}

/** 返回 true 表示该处理器已认领该反向请求；未认领则由 client 显式回写 -32601。 */
export type ServerRequestHandler = (frame: ServerRequestFrame) => boolean | void;

/** 携带敏感凭据、响应不得写入明文日志的反向请求方法集合 */
export const SENSITIVE_SERVER_REQUEST_METHODS: ReadonlySet<string> = new Set([
  'secret',
  'sudo',
  'display.install.sudo',
  'vault.code',
  'vault.unlock_prompt',
  'vault.save_login',
]);

/** 仅桌面宿主本地桥接方法（移动端与未启用本地桥接桌面端显式拒绝） */
export const UNSUPPORTED_DESKTOP_LOCAL_METHODS: ReadonlySet<string> = new Set([
  'preview.act',
  'preview.read',
  'terminal.read',
  'window.read',
  'tour',
]);

/** Phase-3 延后实现的富交互卡（收到时礼貌关闭，不挂死网关） */
export const PHASE3_DEFERRED_SERVER_METHODS: ReadonlySet<string> = new Set([
  'setup_beat',
  'theme.pick',
  'theme.apply',
]);

export type UnsupportedServerReply =
  | { kind: 'ws_response'; result: Record<string, unknown> }
  | { kind: 'ws_error'; code: number; message: string };

function isValidJsonRpcId(id: unknown): id is JsonRpcId {
  return (typeof id === 'string' && id.length > 0) || (typeof id === 'number' && Number.isFinite(id));
}

/**
 * 分类一条已解析的 JSON-RPC 2.0 报文。
 * 严格优先检查 `method`，杜绝服务端请求 id 与本地在途 RPC `pendingRequests` 撞号串台。
 */
export function classifyJsonRpcFrame(data: unknown): ClassifiedJsonRpcFrame {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { kind: 'ignore' };
  }
  const rec = data as Record<string, unknown>;
  const hasMethod = typeof rec.method === 'string' && rec.method.length > 0;
  const hasValidId = isValidJsonRpcId(rec.id);

  if (hasMethod) {
    if (hasValidId) {
      const rawParams = rec.params;
      const params =
        rawParams && typeof rawParams === 'object' && !Array.isArray(rawParams)
          ? (rawParams as Record<string, unknown>)
          : {};
      return {
        kind: 'server-request',
        id: rec.id as JsonRpcId,
        method: rec.method as string,
        params,
      };
    }
    return {
      kind: 'notification',
      method: rec.method as string,
      params: rec.params,
    };
  }

  if (hasValidId) {
    return {
      kind: 'response',
      id: rec.id as JsonRpcId,
      result: rec.result,
      error: rec.error,
    };
  }

  return { kind: 'ignore' };
}

/**
 * 为暂不承载或明确禁止的反向请求生成安全退场应答，避免服务端挂起等待 300s。
 */
export function resolveUnsupportedServerRequestResponse(
  method: string,
  capabilities: ClientCapabilitiesResult | null | undefined,
): UnsupportedServerReply | null {
  if (UNSUPPORTED_DESKTOP_LOCAL_METHODS.has(method)) {
    if (capabilities?.declines_not_shown) {
      return {
        kind: 'ws_error',
        code: -32601,
        message: `Desktop local bridge method "${method}" is not supported on this client`,
      };
    }
    return { kind: 'ws_response', result: { value: '' } };
  }

  if (!PHASE3_DEFERRED_SERVER_METHODS.has(method)) {
    return null;
  }

  if (capabilities?.declines_not_shown) {
    return {
      kind: 'ws_error',
      code: -32601,
      message: `Interactive method "${method}" is deferred on this client`,
    };
  }

  if (method === 'setup_beat') {
    return { kind: 'ws_response', result: {} };
  }
  if (method === 'theme.pick') {
    return { kind: 'ws_response', result: { cancelled: true } };
  }
  return { kind: 'ws_response', result: { value: '' } };
}

export interface CapabilitiesTransport {
  call<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;
}

/**
 * 握手阶段协商 `client.capabilities`：
 * 1. 先发送完整 `{ server_requests, desktop_local }`；
 * 2. 若老版本网关返回 `4000 Extra inputs`，自动降级为仅 `{ server_requests }` 重试一次；
 * 3. `-32601` 或其余非致命错误安全降级返回 `null`，不得阻塞正常建连。
 */
export async function negotiateClientCapabilities(
  transport: CapabilitiesTransport,
  caps: ClientCapabilitiesParams,
  timeoutMs = 3000,
): Promise<ClientCapabilitiesResult | null> {
  try {
    return await transport.call<ClientCapabilitiesResult>(
      'client.capabilities',
      {
        server_requests: caps.server_requests ?? true,
        desktop_local: caps.desktop_local ?? false,
      },
      timeoutMs,
    );
  } catch (err) {
    const rec = err && typeof err === 'object' ? (err as { code?: unknown; message?: unknown }) : {};
    const msg = typeof rec.message === 'string' ? rec.message : '';
    const isExtraInputs = rec.code === 4000 || msg.includes('Extra inputs');
    if (isExtraInputs) {
      try {
        return await transport.call<ClientCapabilitiesResult>(
          'client.capabilities',
          { server_requests: caps.server_requests ?? true },
          timeoutMs,
        );
      } catch { // gate-degrade: 老版本网关不识别 client.capabilities 参数，降级为无协商扩展继续建连
        return null;
      }
    }
    return null;
  }
}

export function buildJsonRpcResultFrame(id: JsonRpcId, result: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id, result });
}

export function buildJsonRpcErrorFrame(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: unknown,
): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    error: { code, message, ...(data !== undefined ? { data } : {}) },
  });
}
