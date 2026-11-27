/**
 * Hermes Gateway 双通道（WebSocket + REST 兜底）领域查询辅助函数。
 *
 * 【设计意图 (Why)】
 *   将会话列表、归档查询、消息历史分页、最后一条消息摘要、模型目录聚合、
 *   Bot Profiles 拉取与全局配置读取等「先 WS 或先 REST、双路容错且不静默失败」的纯查询方法
 *   从 `client.ts` 中解耦出来，避免单文件突破 1500 行维护阈值，同时保持
 *   `HermesGatewayClient` 对外公共接口签名与类型导出 100% 不变。
 *
 * 【防范的历史坑 (Pitfall)】
 *   1. `/api/sessions` 在网关侧是顺序与 `last_active` 权威视图，而 WS `session.list` 缺失 `last_active`；
 *   2. 归档会话必须传 `archived: 'only'`，严禁 `include_archived` 或 `'true'`；
 *   3. `model.options` / `/api/model/options` 必须携带 `explicit_only`（WS `true` / REST `1`），防止泄露环境残留凭据。
 *
 * 【约束与规则 (Rules)】
 *   1. 纯无界 TypeScript，仅依赖 `ClientChannelTransport` 抽象，不持有 socket 或定时器状态；
 *   2. 契约方法调用保留 `.call(rpcMethod, ...)` 字面量形态，确保 `contract:verify` 与 `contract:coverage` 静态扫描命中。
 */

import type {
  AgentProfile,
  ModelDetail,
  NormalizedSession,
} from './types.js';
import type { FsmState } from './fsm.js';
import { extractAvailableModels, extractModelDetails, normalizeSessionsResult } from '../models/types.js';
import { buildModelCatalogView, type ModelCatalogEntry } from '../models/modelCatalog.js';
import { createLogger } from '../log/logger.js';
import { normalizeAgentProfile } from './profileNormalize.js';
import { extractInstallId } from './gatewayProtocol.js';

const log = createLogger('rpc');

export interface RestFallbackOptions {
  method?: string;
  params?: Record<string, unknown>;
  body?: unknown;
  headers?: Record<string, string>;
}

export type RestFallbackHandler = (path: string, options?: RestFallbackOptions) => Promise<unknown>;

/** Result of a session listing attempt, including why it failed when it did. */
export interface SessionListOutcome {
  sessions: NormalizedSession[];
  ok: boolean;
  error?: string;
}

export type SessionMessagesOutcome =
  | { status: 'success'; messages: SessionMessageRecord[]; pagination?: { returned?: number; total?: number } }
  | { status: 'error'; error: string };

export interface SessionMessageRecord {
  [key: string]: unknown;
}

/** Models plus the provider that owns the currently active one. */
export interface ModelCatalog {
  models: string[];
  details: ModelDetail[];
  /**
   * 归一化后的完整目录：扁平、带可读显示名与价格/能力元数据。
   *
   * 【设计意图 (Why)】
   *   `models` / `details` 是历史契约（只给 ID 与粗粒度详情），前端渲染时仍要自己拼字符串。
   *   `entries` 是新的权威视图：前端选择器、输入舱标签、设置页统一消费它，显示名不再各处漂移。
   *
   * 【规则 (Rules)】
   *   `entries` 是 `models` 的子集来源：`models` = entries 去重 id + （若不在其中）根层当前模型。
   *   当前模型可能因网关目录截断而缺失于 `providers[].models[]`，必须保留在 `models` 里，
   *   但**不为它伪造 entry**（无 provider 归属与价格，不能造可渲染条目）。
   */
  entries: ModelCatalogEntry[];
  currentModel: string;
  currentProvider: string;
  ok: boolean;
  error?: string;
}

export interface ClientChannelTransport {
  call<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;
  isSocketOpen(): boolean;
  getFsmState(): FsmState;
  getRestFallback(): RestFallbackHandler | null;
}

/** 将 RPC 或传输层异常收敛为可读错误描述。 */
export function describeRpcClientError(error: unknown): string {
  if (error && typeof error === 'object') {
    const candidate = error as { message?: unknown; code?: unknown; data?: unknown };
    if (typeof candidate.message === 'string' && candidate.message.trim()) {
      return candidate.message;
    }
    if (typeof candidate.code !== 'undefined') {
      return `RPC 错误 ${String(candidate.code)}`;
    }
  }
  return typeof error === 'string' ? error : '未知错误';
}

function legacyModelDetails(payload: unknown): ModelDetail[] {
  // 【规则】`extractModelDetails` 会把探针占位符 `<more:N>` 也当成模型，
  // 导致 details 里出现不可选的伪条目，与 entries 视图不一致。这里统一剔除。
  return extractModelDetails(payload).filter(
    (detail) => !detail.id.startsWith('<') && !detail.id.endsWith('>'),
  );
}

/** 双通道（REST 优先 + WS 兜底）拉取活跃会话列表并保留显式失败信息。 */
export async function listSessionsWithFallback(
  transport: ClientChannelTransport,
  profile = 'default',
  limit = 50,
): Promise<SessionListOutcome> {
  let lastError: string | undefined;
  const safeLimit = Math.max(1, Math.min(100, Math.floor(limit) || 50));
  const restFallbackHandler = transport.getRestFallback();

  if (restFallbackHandler) {
    try {
      const restResult = await restFallbackHandler('/api/sessions', {
        method: 'GET',
        params: { profile, limit: safeLimit },
      });
      const sessions = normalizeSessionsResult(restResult);
      // REST 是权威持久化视图：即便为空也代表"该 Profile 确实没有会话"
      return { sessions, ok: true };
    } catch (restErr) {
      lastError = describeRpcClientError(restErr);
      console.warn('[HermesGatewayClient] REST session.list failed, trying WS fallback:', lastError);
    }
  }

  if (transport.isSocketOpen()) {
    try {
      const wsResult = await transport.call<unknown>('session.list', { profile, limit: safeLimit });
      const sessions = normalizeSessionsResult(wsResult);
      return { sessions, ok: true };
    } catch (wsErr) {
      lastError = describeRpcClientError(wsErr);
      console.warn('[HermesGatewayClient] WS session.list also failed:', lastError);
    }
  } else if (!lastError) {
    lastError = `WebSocket 未连接 (当前状态: ${transport.getFsmState()})`;
  }

  return { sessions: [], ok: false, error: lastError ?? '网关未返回会话列表' };
}

/** 独立通过 REST 拉取已归档会话列表（WS-only 明确报失败而非伪造空态）。 */
export async function listArchivedSessionsWithFallback(
  transport: ClientChannelTransport,
  profile = 'default',
  limit = 50,
): Promise<SessionListOutcome> {
  const restFallbackHandler = transport.getRestFallback();
  if (!restFallbackHandler) {
    return {
      sessions: [],
      ok: false,
      error: 'WS-only 模式暂不支持拉取历史归档会话',
    };
  }
  const safeLimit = Math.max(1, Math.min(100, Math.floor(limit) || 50));
  try {
    const restResult = await restFallbackHandler('/api/sessions', {
      method: 'GET',
      params: { profile, limit: safeLimit, archived: 'only' },
    });
    if (typeof restResult === 'string') {
      return { sessions: [], ok: false, error: '网关返回非 JSON 已归档会话响应' };
    }
    if (restResult && typeof restResult === 'object' && !Array.isArray(restResult)) {
      const record = restResult as Record<string, unknown>;
      if (record.ok === false || typeof record.detail === 'string' || typeof record.error === 'string') {
        const msg =
          (typeof record.detail === 'string' && record.detail.trim()) ||
          (typeof record.error === 'string' && record.error.trim()) ||
          '网关拒绝返回已归档会话列表';
        return { sessions: [], ok: false, error: msg };
      }
      if (!Array.isArray(record.sessions) && !Array.isArray(record.data)) {
        return { sessions: [], ok: false, error: '网关未返回合法的已归档会话列表' };
      }
    } else if (!Array.isArray(restResult)) {
      return { sessions: [], ok: false, error: '网关未返回合法的已归档会话列表' };
    }
    const sessions = normalizeSessionsResult(restResult).map((s) => ({ ...s, isArchived: true }));
    return { sessions, ok: true };
  } catch (err) {
    const errorMsg = describeRpcClientError(err);
    log.warn('REST /api/sessions archived query failed:', errorMsg);
    return { sessions: [], ok: false, error: errorMsg };
  }
}

/** 获取指定会话的真实最后一条消息用于左轨副标题。 */
export async function fetchLastMessageWithFallback(
  transport: ClientChannelTransport,
  sessionId: string,
  options?: { profile?: string },
): Promise<{ text: string; timestamp: number; role: string } | null> {
  const restFallbackHandler = transport.getRestFallback();
  if (!restFallbackHandler || !sessionId) return null;
  try {
    const res = await restFallbackHandler(
      `/api/sessions/${encodeURIComponent(sessionId)}/messages`,
      {
        method: 'GET',
        params: {
          limit: 1,
          offset: 0,
          order: 'latest',
          ...(options?.profile ? { profile: options.profile } : {}),
        },
      },
    );
    const resObj = res && typeof res === 'object' ? (res as Record<string, unknown>) : null;
    const messages = Array.isArray(resObj?.messages) ? (resObj!.messages as Array<Record<string, unknown>>) : [];
    const last = messages[0];
    if (!last) return null;
    const rawText = typeof last.content === 'string' ? last.content : typeof last.text === 'string' ? last.text : '';
    const rawTs = typeof last.timestamp === 'number' ? last.timestamp : 0;
    const ts = rawTs > 1e11 ? rawTs : rawTs > 0 ? rawTs * 1000 : 0;
    return {
      text: rawText.replace(/\s+/g, ' ').trim(),
      timestamp: ts,
      role: typeof last.role === 'string' ? last.role : '',
    };
  // gate-degrade: 单条消息取失败时降级为"保留既有副标题"，不阻断列表主流程
  } catch (err) {
    console.warn('[HermesGatewayClient] fetchLastMessage failed:', describeRpcClientError(err), { sessionId });
    return null;
  }
}

/** 双通道（WS 优先 + REST 兜底）读取归一化模型目录，失败时显式返回 `ok: false`。 */
export async function getModelCatalogWithFallback(
  transport: ClientChannelTransport,
  profile = 'default',
  fallbackModels: string[] = [],
): Promise<ModelCatalog> {
  let lastError: string | undefined;
  const restFallbackHandler = transport.getRestFallback();

  if (transport.isSocketOpen()) {
    try {
      const res = await transport.call<Record<string, unknown>>('model.options', { profile, explicit_only: true });
      const view = buildModelCatalogView(res);
      if (view.ok) {
        return {
          models: view.models,
          details: legacyModelDetails(res),
          entries: view.entries,
          currentModel: view.currentModel,
          currentProvider: view.currentProvider,
          ok: true,
        };
      }
      lastError = view.error;
    } catch (wsErr) {
      lastError = describeRpcClientError(wsErr);
      console.warn('[HermesGatewayClient] WS model.options failed, trying REST fallback:', lastError);
    }
  } else {
    lastError = `WebSocket 未连接 (当前状态: ${transport.getFsmState()})`;
  }

  if (restFallbackHandler) {
    try {
      const restResult = await restFallbackHandler('/api/model/options', {
        method: 'GET',
        params: { profile, explicit_only: 1 },
      });
      const view = buildModelCatalogView(restResult);
      if (view.ok) {
        return {
          models: view.models,
          details: legacyModelDetails(restResult),
          entries: view.entries,
          currentModel: view.currentModel,
          currentProvider: view.currentProvider,
          ok: true,
        };
      }
      lastError = view.error ?? 'REST 模型接口返回为空';
    } catch (restErr) {
      lastError = describeRpcClientError(restErr);
      console.warn('[HermesGatewayClient] REST model fallback also failed:', lastError);
    }
  }

  return {
    models: extractAvailableModels(null, fallbackModels),
    details: [],
    entries: [],
    currentModel: '',
    currentProvider: '',
    ok: false,
    error: lastError ?? '网关未返回模型列表',
  };
}

/** 拉取网关已配置的 Agent Profiles 并附带提取出的 `installId`。 */
export async function listProfilesWithFallback(
  transport: ClientChannelTransport,
): Promise<{ profiles: AgentProfile[]; installId?: string }> {
  try {
    const res = await transport.call<Record<string, unknown> | unknown[]>('profiles.list', {});
    const installId = extractInstallId(res) ?? undefined;
    const list = Array.isArray(res)
      ? res
      : Array.isArray((res as Record<string, unknown>)?.profiles)
        ? ((res as Record<string, unknown>).profiles as unknown[])
        : [];
    return {
      profiles: list.map((item: unknown) => normalizeAgentProfile(item)),
      installId,
    };
  } catch (e) {
    console.warn('[HermesGatewayClient] profiles.list failed, returning default profile:', e);
    return {
      profiles: [
        { name: 'default', displayName: '通用助手 (Default)', description: '默认通用智能体', isDefault: true },
      ],
    };
  }
}

/** 拉取网关全局配置快照，自动兼容 REST 顶层字典与 WS `config.get { key: 'full' }` 包裹结构。 */
export async function fetchGatewayConfigWithFallback(
  transport: ClientChannelTransport,
  profile?: string,
): Promise<Record<string, unknown>> {
  let lastError: unknown;
  const restFallbackHandler = transport.getRestFallback();
  if (restFallbackHandler) {
    try {
      const rest = await restFallbackHandler('/api/config', {
        method: 'GET',
        ...(profile ? { params: { profile } } : {}),
      });
      if (rest && typeof rest === 'object' && !Array.isArray(rest)) {
        const obj = rest as Record<string, unknown>;
        return obj.config && typeof obj.config === 'object' && !Array.isArray(obj.config)
          ? (obj.config as Record<string, unknown>)
          : obj;
      }
    } catch (err) {
      lastError = err;
      log.warn('REST /api/config failed, trying config.get WS fallback', err);
    }
  }

  if (transport.isSocketOpen()) {
    const wsRes = await transport.call<Record<string, unknown>>('config.get', {
      key: 'full',
      ...(profile ? { profile } : {}),
    });
    if (wsRes && typeof wsRes === 'object') {
      const cfg = (wsRes as { config?: unknown }).config;
      if (cfg && typeof cfg === 'object' && !Array.isArray(cfg)) {
        return cfg as Record<string, unknown>;
      }
      return wsRes;
    }
  }

  if (lastError) {
    throw lastError instanceof Error ? lastError : new Error(describeRpcClientError(lastError));
  }
  throw new Error('网关未连接且无法读取配置');
}
