/**
 * Hermes Gateway 双向握手、断线增量补齐与实例标识纯协议辅助模块
 *
 * 【设计意图 (Why)】
 *   1. 将 `gateway.ready(session_authority, replay_epoch)` 解析、`session.events.since`
 *      Legacy (`last_seen`) vs Canonical (`last_sequence`) 双轨入参构建、双向反向请求
 *      应答帧编码以及 `install_id` 提取集中封装为纯函数，避免继续膨胀 `client.ts`；
 *   2. 为 M1.2/M1.3 多网关并发池与路由热切提供零丢消息协议契约基座。
 *
 * 【防范的历史坑 (Pitfall)】
 *   网关对 `session.events.since` 按 `session_authority` 区分字段校验；
 *   错误混淆 `last_seen` / `last_sequence` 或丢失 `replay_epoch` 会触发网关拒接或假重放。
 *
 * 【约束与规则 (Rules)】
 *   1. 纯函数与零外部状态副作用；
 *   2. 严格类型完备，严禁降级为任意类型逃逸。
 */

export interface GatewayReadyState {
  readonly replayEpoch: string | null;
  readonly sessionAuthority: boolean;
  readonly heartbeat: boolean | null;
  readonly changeEvents: boolean;
}

export const DEFAULT_GATEWAY_READY_STATE: GatewayReadyState = {
  replayEpoch: null,
  sessionAuthority: false,
  heartbeat: null,
  changeEvents: false,
};

/** 解析网关首帧 `gateway.ready` 通知载荷。 */
export function parseGatewayReadyParams(raw: unknown): GatewayReadyState {
  const rec = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  if (!rec) {
    return { ...DEFAULT_GATEWAY_READY_STATE };
  }
  const replayEpoch =
    typeof rec.replay_epoch === 'string' && rec.replay_epoch.trim()
      ? rec.replay_epoch.trim()
      : null;
  return {
    replayEpoch,
    sessionAuthority: rec.session_authority === true,
    heartbeat: typeof rec.heartbeat === 'boolean' ? rec.heartbeat : null,
    changeEvents: rec.change_events === true,
  };
}

export interface IncomingServerRequest {
  readonly id: string | number;
  readonly method: string;
  readonly params: unknown;
}

export type ServerRequestHandler<TParams = unknown, TResult = unknown> = (
  params: TParams,
  request: IncomingServerRequest,
) => Promise<TResult> | TResult;

export type DefaultServerRequestHandler<TResult = unknown> = (
  request: IncomingServerRequest,
) => Promise<TResult> | TResult;

/** 编码客户端响应服务端反向请求的成功 JSON-RPC 2.0 帧。 */
export function buildServerRequestSuccessFrame(id: string | number, result: unknown): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    result: result === undefined ? null : result,
  });
}

/** 编码客户端响应服务端反向请求的错误 JSON-RPC 2.0 帧。 */
export function buildServerRequestErrorFrame(id: string | number, err: unknown): string {
  const errRec =
    err && typeof err === 'object'
      ? (err as { code?: unknown; message?: unknown })
      : null;
  const code = typeof errRec?.code === 'number' ? errRec.code : -32000;
  let message = 'Server request handler failed';
  if (typeof errRec?.message === 'string' && errRec.message.trim()) {
    message = errRec.message;
  } else if (typeof err === 'string' && err.trim()) {
    message = err;
  }
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    error: { code, message },
  });
}

/** 执行单条服务端反向请求，并将结果或异常统一编码为 JSON-RPC 2.0 响应帧。 */
export async function executeServerRequestFrame(
  req: IncomingServerRequest,
  specificHandler: ServerRequestHandler | undefined,
  defaultHandler: DefaultServerRequestHandler | null,
): Promise<string> {
  if (!specificHandler && !defaultHandler) {
    return buildServerRequestErrorFrame(req.id, {
      code: -32601,
      message: `Method not found: ${req.method}`,
    });
  }
  try {
    const result = specificHandler
      ? await specificHandler(req.params, req)
      : await defaultHandler!(req);
    return buildServerRequestSuccessFrame(req.id, result);
  } catch (err) {
    return buildServerRequestErrorFrame(req.id, err);
  }
}

export interface SessionEventsSinceQuery {
  readonly sessionId: string;
  readonly profile?: string;
  readonly cursor?: number;
  readonly replayEpoch?: string | null;
  readonly sessionAuthority: boolean;
}

export interface SessionEventsSinceNormalizedResult {
  readonly events: Array<Record<string, unknown>>;
  readonly latestSeq: number;
  readonly truncated: boolean;
  readonly count: number;
  readonly epoch: string;
  readonly openRequests: Array<Record<string, unknown>>;
}

/** 根据握手期获取的 `sessionAuthority` 构造 `session.events.since` 精准白名单参数。 */
export function buildSessionEventsSinceParams(
  query: SessionEventsSinceQuery,
): Record<string, unknown> {
  const cursor = typeof query.cursor === 'number' ? query.cursor : 0;
  return {
    session_id: query.sessionId,
    ...(query.profile ? { profile: query.profile } : {}),
    ...(query.sessionAuthority ? { last_sequence: cursor } : { last_seen: cursor }),
    ...(query.replayEpoch !== undefined ? { replay_epoch: query.replayEpoch } : {}),
  };
}

/** 归一化 Legacy / Canonical 两种形态的 `session.events.since` 返回结果。 */
export function normalizeSessionEventsSinceResult(
  raw: unknown,
): SessionEventsSinceNormalizedResult {
  const rec = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const rawEvents = Array.isArray(rec.events) ? rec.events : [];
  const events = rawEvents.filter(
    (item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'),
  );
  const rawOpen = Array.isArray(rec.open_requests) ? rec.open_requests : [];
  const openRequests = rawOpen.filter(
    (item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'),
  );
  const latestSeq =
    typeof rec.latest_seq === 'number'
      ? rec.latest_seq
      : typeof rec.last_sequence === 'number'
        ? rec.last_sequence
        : 0;
  const epoch =
    typeof rec.replay_epoch === 'string'
      ? rec.replay_epoch
      : typeof rec.epoch === 'string'
        ? rec.epoch
        : '';

  return {
    events,
    latestSeq,
    truncated: rec.truncated === true,
    count: typeof rec.count === 'number' ? rec.count : events.length,
    epoch,
    openRequests,
  };
}

/** 从网关 `/api/status` 或 `profiles.list` 响应对象中提取规范化 `install_id`。 */
export function extractInstallId(raw: unknown): string | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const candidate = (raw as { install_id?: unknown }).install_id;
  if (typeof candidate !== 'string') return undefined;
  const trimmed = candidate.trim();
  return trimmed || undefined;
}
