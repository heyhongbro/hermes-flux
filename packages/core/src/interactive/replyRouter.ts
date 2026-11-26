/**
 * 交互式请求双路径应答路由器 (packages/core/src/interactive/replyRouter.ts)
 *
 * 【设计意图 (Why)】
 *   交互请求有两种生命态：
 *   1. 在线 WS 反向请求（当前 `socketGeneration` 仍与到达时一致且 `rpcId !== null`）：直接写回 JSON-RPC 2.0 result 帧；
 *   2. 断线重连恢复 / 事件驱动 / 群聊 / 套接字已切换：走显式 RPC
 *      (`request.answer` / `approval.respond` / `clarify.respond` / `connection.respond` / `groups.*`)。
 *   同时本模块严格隔离 Classic 与 Canonical (`hermes-gateway-v1`) 参数契约，杜绝混传触发 4000。
 *
 * 【防范的历史坑 (Pitfall)】
 *   1. 混用 `approval.respond` 参数：Classic 传 `execution_generation`/`prompt_id` 会报 4000，Canonical 缺失又无法匹配；
 *   2. Canonical `groups.approve` 仅允许 `'once' | 'deny'`，传入 `'session'`/`'always'` 会被拒绝；
 *   3. Multi-select `clarify` 答案若传数组会被 Pydantic 拒绝，必须序列化为逗号分隔字符串；取消全部时严禁携带 `answers` 字段；
 *   4. `vault.save_login` 必须将 `{ identifier, password }` 序列化进 `{ value: JSON.stringify(...) }`。
 */

import type { ClientCapabilitiesResult } from '../rpc/contracts/gateway-contract.generated.js';
import type { JsonRpcId } from '../rpc/serverRequestRouter.js';
import type { InteractivePrompt, InteractiveReplyPayload } from './types.js';

export type ResolvedReplyRoute =
  | {
      transport: 'ws_response';
      id: JsonRpcId;
      socketGeneration: number;
      method: string;
      result: Record<string, unknown>;
    }
  | {
      transport: 'rpc';
      method:
        | 'request.answer'
        | 'clarify.respond'
        | 'approval.respond'
        | 'connection.respond'
        | 'groups.approve'
        | 'groups.retry'
        | 'groups.discard';
      params: Record<string, unknown>;
    }
  | {
      transport: 'local_callback';
      outcome: 'confirm' | 'confirm_always' | 'cancel';
    };

/** 将单题或多选题选项与自定义补充序列化为网关要求的 string | null。 */
export function serializeClarifyAnswer(
  selected: readonly string[],
  customText = '',
  multiSelect = false,
): string | null {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const raw of selected) {
    const item = typeof raw === 'string' ? raw.trim() : '';
    if (item && !seen.has(item)) {
      seen.add(item);
      normalized.push(item);
    }
  }
  const custom = customText.trim();
  if (custom && !seen.has(custom)) {
    seen.add(custom);
    normalized.push(custom);
  }
  if (normalized.length === 0) return null;
  if (!multiSelect) return normalized[0];
  return normalized.join(', ');
}

function resolveSessionIdForPrompt(prompt: InteractivePrompt): string {
  if (prompt.scope.kind === 'session') {
    return prompt.scope.liveSessionId || prompt.scope.storedSessionId || '';
  }
  return '';
}

function resolveProfileForPrompt(prompt: InteractivePrompt): string | undefined {
  if (prompt.scope.kind === 'session' || prompt.scope.kind === 'group' || prompt.scope.kind === 'account') {
    return prompt.scope.profile;
  }
  return undefined;
}

/**
 * 为一条提交动作计算合法路由与严格对齐契约的参数载体。
 */
export function resolveReplyRoute(
  prompt: InteractivePrompt,
  reply: InteractiveReplyPayload,
  currentSocketGeneration: number | null,
  _capabilities?: ClientCapabilitiesResult | null,
): ResolvedReplyRoute {
  if (prompt.kind === 'rpc_confirm' && reply.kind === 'rpc_confirm') {
    return { transport: 'local_callback', outcome: reply.outcome };
  }

  const canUseLiveWs =
    prompt.rpcId !== null &&
    prompt.socketGeneration !== null &&
    currentSocketGeneration !== null &&
    prompt.socketGeneration === currentSocketGeneration;

  if (prompt.kind === 'clarify' && reply.kind === 'clarify') {
    if (canUseLiveWs) {
      if (reply.cancelled) {
        return {
          transport: 'ws_response',
          id: prompt.rpcId as JsonRpcId,
          socketGeneration: prompt.socketGeneration as number,
          method: 'clarify',
          result: { outcome: 'cancelled' },
        };
      }
      return {
        transport: 'ws_response',
        id: prompt.rpcId as JsonRpcId,
        socketGeneration: prompt.socketGeneration as number,
        method: 'clarify',
        result: { answers: reply.answers ?? {}, outcome: 'submitted' },
      };
    }

    if (prompt.protocol === 'canonical' && prompt.promptId) {
      const sessionId = resolveSessionIdForPrompt(prompt);
      const firstQid = prompt.questions[0]?.qid ?? '';
      const answer = reply.cancelled
        ? ''
        : (reply.singleAnswer ?? (firstQid ? (reply.answers?.[firstQid] ?? '') : '') ?? '');
      return {
        transport: 'rpc',
        method: 'clarify.respond',
        params: {
          session_id: sessionId,
          execution_generation: prompt.executionGeneration ?? 0,
          prompt_id: prompt.promptId,
          answer,
        },
      };
    }

    const profile = resolveProfileForPrompt(prompt);
    const resultPayload: Record<string, unknown> = reply.cancelled
      ? { outcome: 'cancelled' }
      : { answers: reply.answers ?? {}, outcome: 'submitted' };
    return {
      transport: 'rpc',
      method: 'request.answer',
      params: {
        id: String(prompt.requestId),
        result: resultPayload,
        ...(profile ? { profile } : {}),
      },
    };
  }

  if (prompt.kind === 'approval' && reply.kind === 'approval') {
    if (canUseLiveWs) {
      return {
        transport: 'ws_response',
        id: prompt.rpcId as JsonRpcId,
        socketGeneration: prompt.socketGeneration as number,
        method: 'approval',
        result: {
          choice: reply.choice,
          ...(reply.all ? { all: true } : {}),
        },
      };
    }

    const sessionId = resolveSessionIdForPrompt(prompt);
    const profile = resolveProfileForPrompt(prompt);
    if (prompt.protocol === 'canonical' && prompt.promptId) {
      return {
        transport: 'rpc',
        method: 'approval.respond',
        params: {
          ...(profile ? { profile } : {}),
          session_id: sessionId,
          execution_generation: prompt.executionGeneration ?? 0,
          prompt_id: prompt.promptId,
          choice: String(reply.choice),
        },
      };
    }

    return {
      transport: 'rpc',
      method: 'approval.respond',
      params: {
        ...(profile ? { profile } : {}),
        session_id: sessionId,
        choice: String(reply.choice),
        ...(reply.all ? { all: true } : {}),
        ...(prompt.requestId && !prompt.requestId.startsWith('singleton:') ? { request_id: prompt.requestId } : {}),
      },
    };
  }

  if (prompt.kind === 'credential' && reply.kind === 'credential') {
    let serializedValue = reply.value;
    if (prompt.method === 'vault.save_login') {
      if (!reply.identifier && !reply.password && !reply.value) {
        serializedValue = '';
      } else if (reply.identifier !== undefined || reply.password !== undefined) {
        serializedValue = JSON.stringify({
          identifier: reply.identifier ?? '',
          password: reply.password ?? '',
        });
      }
    }

    if (canUseLiveWs) {
      return {
        transport: 'ws_response',
        id: prompt.rpcId as JsonRpcId,
        socketGeneration: prompt.socketGeneration as number,
        method: prompt.method,
        result: { value: serializedValue },
      };
    }

    const profile = resolveProfileForPrompt(prompt);
    return {
      transport: 'rpc',
      method: 'request.answer',
      params: {
        id: String(prompt.requestId),
        result: { value: serializedValue },
        ...(profile ? { profile } : {}),
      },
    };
  }

  if (prompt.kind === 'connection' && reply.kind === 'connection') {
    const profile = resolveProfileForPrompt(prompt);
    return {
      transport: 'rpc',
      method: 'connection.respond',
      params: {
        ...(profile ? { profile } : {}),
        owner: prompt.owner,
        op_id: prompt.opId,
        result: {
          ...(reply.targets ? { targets: reply.targets } : {}),
          ...(reply.settledBy ? { settled_by: reply.settledBy } : {}),
          ...(reply.said !== undefined ? { said: reply.said } : {}),
        },
      },
    };
  }

  if (prompt.kind === 'group_action' && reply.kind === 'group_action') {
    const profile = resolveProfileForPrompt(prompt);
    if (reply.action === 'retry') {
      return {
        transport: 'rpc',
        method: 'groups.retry',
        params: {
          ...(profile ? { profile } : {}),
          room_id: prompt.roomId,
          task_id: prompt.taskId,
          member_id: prompt.memberId,
          execution_generation: prompt.executionGeneration,
        },
      };
    }
    if (reply.action === 'discard') {
      return {
        transport: 'rpc',
        method: 'groups.discard',
        params: {
          ...(profile ? { profile } : {}),
          room_id: prompt.roomId,
          member_id: prompt.memberId,
          task_id: prompt.taskId,
          execution_generation: prompt.executionGeneration,
        },
      };
    }
    const rawChoice = reply.choice ?? 'once';
    const safeChoice =
      prompt.protocol === 'canonical' && rawChoice !== 'once' && rawChoice !== 'deny'
        ? 'once'
        : rawChoice;
    return {
      transport: 'rpc',
      method: 'groups.approve',
      params: {
        ...(profile ? { profile } : {}),
        room_id: prompt.roomId,
        member_id: prompt.memberId,
        task_id: prompt.taskId,
        execution_generation: prompt.executionGeneration,
        choice: safeChoice,
        request_id: prompt.requestId,
      },
    };
  }

  throw new Error(`Mismatched interactive reply kind "${reply.kind}" for prompt kind "${prompt.kind}"`);
}

/**
 * 判断跨端竞争抢答导致的无害已结响应：另一端已响应时，视为本地已收敛而非报错重开卡片。
 */
export function isIdempotentSettlementResponse(method: string, result: unknown): boolean {
  if (!result || typeof result !== 'object') return false;
  const rec = result as Record<string, unknown>;
  if (method === 'request.answer' || method === 'clarify.lock') {
    return rec.status === 'expired';
  }
  if (method === 'clarify.respond') {
    return rec.status === 'already_resolved' || rec.status === 'resolved';
  }
  if (method === 'approval.respond') {
    return rec.status === 'already_resolved' || rec.resolved === 0;
  }
  return false;
}

/**
 * 判定提交错误是否允许回滚卡片重填（仅可恢复传输/超时错回滚，终态协议拒绝如 4000/4001/expired 不回滚）。
 */
export function isRetryableTransportError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return true;
  const rec = err as { code?: unknown; message?: unknown };
  if (typeof rec.code === 'number') {
    // 契约参数/未知方法/无效会话等终态 RPC 错误不可重试；仅 -32000 临时繁忙可按文案区分
    if (rec.code === 4000 || rec.code === 4001 || rec.code === -32601 || rec.code === -32602 || rec.code === -32600) {
      return false;
    }
  }
  const msg = typeof rec.message === 'string' ? rec.message.toLowerCase() : '';
  if (msg.includes('expired') || msg.includes('already_resolved') || msg.includes('contract')) {
    return false;
  }
  return true;
}
