/**
 * Electron 主进程远程调试端口 (`9222`) 启动策略
 *
 * 【设计意图 (Why)】
 *   Electron 生产打包版本若无条件开启 `--remote-debugging-port=9222`，
 *   本机任意低权进程即可连接 CDP 读取 `localStorage` 与 `safeStorage` 会话并操控网关。
 *   改为仅开发环境（`!isPackaged`）默认启用，生产态默认彻底关闭。
 *
 * 【约束与规则 (Rules)】
 *   - `isPackaged === true` 默认返回 `null`，仅显式 `HERMES_FLUX_ALLOW_PACKAGED_DEBUG=1` 才允许指定端口；
 *   - 非法端口或 `'0'` / `'off'` 统一返回 `null`。
 */

export interface DebugPortPolicyInput {
  readonly isPackaged: boolean;
  readonly env?: Record<string, string | undefined>;
}

/** 解析当前进程是否应当开启 Electron remote-debugging-port，以及端口字符串。 */
export function resolveRemoteDebuggingPort(input: DebugPortPolicyInput): string | null {
  const env = input.env ?? {};
  if (input.isPackaged && env.HERMES_FLUX_ALLOW_PACKAGED_DEBUG !== '1') {
    return null;
  }
  const raw = env.HERMES_FLUX_REMOTE_DEBUG_PORT;
  if (raw === undefined) {
    return '9222';
  }
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed || trimmed === '0' || trimmed === 'off' || trimmed === 'false') {
    return null;
  }
  const num = Number(trimmed);
  if (!Number.isInteger(num) || num < 1 || num > 65535) {
    return null;
  }
  return String(num);
}
