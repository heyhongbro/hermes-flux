/**
 * 会话创建载荷构建与 RPC 兼容重试辅助模块 (Session Create Payload Helpers)
 *
 * 【设计意图 (Why)】
 *   将 `session.create` 的三档契约兼容降级（`cwd + cwd_explicit` -> `cwd` -> 最小 `{ title, profile }`）
 *   与 RPC 错误描述纯函数从 `sessionOperationService.ts` 中抽离，使核心会话服务保持在 1500 行门禁以内，
 *   并允许多网关新建会话路由分支进行 100% 独立单元测试。
 *
 * 【约束与规则 (Rules)】
 *   - 严禁使用 `as any`；
 *   - 保持对旧网关 `Extra inputs` 的精确兼容重试语义，非 `Extra inputs` 错误直接原样抛出。
 */

import type { HermesGatewayClient } from '@hermes-flux/core';

export function rpcErrorCode(error: unknown): number | null {
  if (error instanceof Error && 'code' in error && typeof error.code === 'number') return error.code;
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'number') return error.code;
  return null;
}

export function describeRpcError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object') {
    if ('message' in error && typeof error.message === 'string') return error.message;
    if ('code' in error && typeof error.code === 'number') return `RPC error ${error.code}`;
  }
  return String(error);
}

export function isExtraInputsError(error: unknown): boolean {
  const msg = describeRpcError(error);
  return msg.includes('Extra inputs');
}

/**
 * 调用 `session.create`，并在老版本网关拒收 `cwd_explicit` 或 `cwd` 时自动逐档回退重发。
 */
export async function executeSessionCreateRpc(
  gatewayClient: HermesGatewayClient,
  input: {
    title: string;
    profile: string;
    cwd?: string;
  },
): Promise<Record<string, unknown> | null> {
  const createPayload: Record<string, unknown> = {
    title: input.title,
    profile: input.profile,
  };
  if (input.cwd) {
    createPayload.cwd = input.cwd;
    createPayload.cwd_explicit = true;
  }

  try {
    return await gatewayClient.call<Record<string, unknown>>('session.create', createPayload);
  } catch (firstErr) {
    if (!isExtraInputsError(firstErr)) throw firstErr;
    console.warn('[Flux] Gateway rejected extra params on session.create, retrying compatible payload');
    try {
      return await gatewayClient.call<Record<string, unknown>>('session.create', {
        title: input.title,
        profile: input.profile,
        ...(input.cwd ? { cwd: input.cwd } : {}),
      });
    } catch (secondErr) {
      if (!isExtraInputsError(secondErr)) throw secondErr;
      return await gatewayClient.call<Record<string, unknown>>('session.create', {
        title: input.title,
        profile: input.profile,
      });
    }
  }
}
