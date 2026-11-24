/**
 * 认知星图 Profile 隔离 REST 适配器 (packages/desktop/src/renderer/learningRest.ts)
 *
 * 【设计意图 (Why)】
 *   网关 WebSocket 契约中的 `learning.frames` / `learning.detail` / `learning.edit` / `learning.delete`
 *   未开放 `profile` 参数，直接调用会始终落向网关默认的 `HERMES_HOME`。
 *   网关 Web Dashboard REST API（`/api/learning/graph`、`/api/learning/node`）原生支持按 `?profile=`
 *   隔离读取与维护每个 Bot 专属的记忆与技能星图。本适配器统一封装路径拼接、错误解析与返回归一。
 *
 * 【防范的历史坑 (Pitfall)】
 *   1. Electron 主进程 IPC 拒绝会包装成 `Error invoking remote method ...: Error: HTTP 404: ...`，
 *      不能锚定字符串行首提取状态码，必须在任意位置匹配 `HTTP <code>`；
 *   2. 404/405/501 表示旧版网关尚未提供该 REST 端点，可由服务层按规则安全回退；而 401/500/网络故障
 *      属于真实错误，绝不能误判为"接口不存在"而静默吞掉；
 *   3. 必须显式透传 `profile`，严禁依赖服务端进程默认值造成多 Bot 认知星图串台。
 *
 * 【约束与规则 (Rules)】
 *   - 零 React、零 DOM，通过注入的 `proxy` 与 `baseUrl` / `ticket` 运行；
 *   - 所有方法强制接收显式 `profile`。
 */

import type {
  LearningDetailResult,
  LearningMutationResult,
  LearningNodeKind,
} from '@hermes-flux/core';

export interface LearningRestProxyOptions {
  baseUrl: string;
  path: string;
  method?: string;
  ticket?: string;
  params?: Record<string, string | number | boolean>;
  body?: unknown;
}

export interface LearningRestDeps {
  baseUrl(): string;
  ticket(): string;
  proxy(options: LearningRestProxyOptions): Promise<unknown>;
}

export class LearningRestError extends Error {
  readonly status: number;
  readonly detail: string;

  constructor(status: number, detail: string) {
    super(detail || `HTTP ${status}`);
    this.name = 'LearningRestError';
    this.status = status;
    this.detail = detail;
  }
}

/** 从 Electron IPC 或 Capacitor proxy 异常中解析 HTTP 状态码与详情。 */
export function describeLearningRestError(error: unknown): { status: number; message: string } {
  if (error instanceof LearningRestError) {
    return { status: error.status, message: error.detail || error.message };
  }
  const text = error instanceof Error ? error.message : String(error || '');
  const match = /\bHTTP\s+(\d{3})\b[:\s]*([\s\S]*)$/i.exec(text.trim());
  if (match) {
    return { status: Number(match[1]), message: match[2].trim() || text.trim() };
  }
  return { status: 0, message: text.trim() };
}

/** 仅当服务端明确返回 404/405/501 时判定 REST 学习星图端点不可用。 */
export function isLearningRestEndpointMissing(error: unknown): boolean {
  const { status } = describeLearningRestError(error);
  return status === 404 || status === 405 || status === 501;
}

export interface LearningRest {
  fetchGraph(profile: string): Promise<unknown>;
  fetchNodeDetail(profile: string, id: string): Promise<LearningDetailResult>;
  editNode(profile: string, id: string, content: string): Promise<LearningMutationResult>;
  deleteNode(profile: string, id: string): Promise<LearningMutationResult>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function normalizeNodeKind(raw: unknown, id: string): LearningNodeKind {
  const val = asString(raw).toLowerCase();
  if (val === 'memory') return 'memory';
  if (val === 'skill' || val === 'learned-skill') return 'skill';
  return id.startsWith('memory:') ? 'memory' : 'skill';
}

export function createLearningRest(deps: LearningRestDeps): LearningRest {
  async function call(
    path: string,
    options: { method: string; params?: Record<string, string | number | boolean>; body?: unknown },
  ): Promise<unknown> {
    try {
      return await deps.proxy({
        baseUrl: deps.baseUrl(),
        path,
        method: options.method,
        ticket: deps.ticket(),
        params: options.params,
        body: options.body,
      });
    } catch (error) {
      const { status, message } = describeLearningRestError(error);
      throw new LearningRestError(status, message);
    }
  }

  return {
    async fetchGraph(profile: string): Promise<unknown> {
      return await call('/api/learning/graph', {
        method: 'GET',
        params: { profile },
      });
    },

    async fetchNodeDetail(profile: string, id: string): Promise<LearningDetailResult> {
      const payload = await call('/api/learning/node', {
        method: 'GET',
        params: { profile, id },
      });
      const root = asRecord(payload);
      if (!root) {
        return { ok: false, message: '' };
      }
      const node = asRecord(root.node) ?? root;
      const content =
        asString(node.content) ||
        asString(node.markdown) ||
        asString(node.body) ||
        asString(node.full_label) ||
        asString(node.fullLabel) ||
        asString(node.description);
      const label = asString(node.label) || asString(node.title) || asString(node.name) || id;
      const ok = root.ok === false ? false : Boolean(node.id || content || root.ok === true);
      return {
        ok,
        id: asString(node.id) || id,
        kind: normalizeNodeKind(node.kind ?? node.type ?? node.style, id),
        label,
        content,
        message: asString(root.message) || asString(root.detail) || undefined,
      };
    },

    async editNode(profile: string, id: string, content: string): Promise<LearningMutationResult> {
      const payload = await call('/api/learning/node', {
        method: 'PUT',
        params: { profile },
        body: { id, content, profile },
      });
      const root = asRecord(payload);
      if (!root) return { ok: true };
      return {
        ok: root.ok !== false,
        message: asString(root.message) || asString(root.detail) || undefined,
      };
    },

    async deleteNode(profile: string, id: string): Promise<LearningMutationResult> {
      const payload = await call('/api/learning/node', {
        method: 'DELETE',
        params: { profile, id },
      });
      const root = asRecord(payload);
      if (!root) return { ok: true };
      return {
        ok: root.ok !== false,
        message: asString(root.message) || asString(root.detail) || undefined,
      };
    },
  };
}
