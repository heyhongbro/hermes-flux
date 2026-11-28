/**
 * RPC 客户端抽象传输接口 (`IRpcSocket`) 与浏览器默认实现
 *
 * 【设计意图 (Why)】
 *   将 `HermesGatewayClient` 从全局 `WebSocket` 单例解耦出来，
 *   为阶段二电子主进程 / 移动端原生 `Noise_IK` E2EE 环回传输注入铺平接口契约，
 *   同时让核心 RPC 状态机与协议测试能在无全局 `WebSocket` 环境下 100% 确定性运行。
 *
 * 【防范的历史坑 (Pitfall)】
 *   直接把 `WebSocket` 类常量（`WebSocket.OPEN`）写死在状态判断分支里，
 *   在 Node 测试或抽象传输层注入场景会因 `ReferenceError: WebSocket is not defined` 崩溃。
 *
 * 【约束与规则 (Rules)】
 *   1. 纯 TypeScript 零宿主/DOM 依赖；
 *   2. 就绪态常量统一读取 `RPC_SOCKET_READY_STATE`，严禁直读全局 `WebSocket.OPEN`。
 */

export const RPC_SOCKET_READY_STATE = {
  CONNECTING: 0,
  OPEN: 1,
  CLOSING: 2,
  CLOSED: 3,
} as const;

export interface RpcSocketMessageEvent {
  readonly data: unknown;
}

/** 逆变兼容 DOM WebSocket (`Event`/`MessageEvent`/`CloseEvent`) 与无 DOM 抽象回调参数。 */
export type RpcSocketEventInput = never;

export interface IRpcSocket {
  readonly readyState: number;
  onopen: ((event: RpcSocketEventInput) => void) | null;
  onmessage: ((event: RpcSocketMessageEvent & RpcSocketEventInput) => void) | null;
  onerror: ((event: RpcSocketEventInput) => void) | null;
  onclose: ((event: RpcSocketEventInput) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type RpcSocketFactory = (url: string) => IRpcSocket;

/** 默认直连工厂：使用当前运行时的全局 WebSocket 实现。 */
export function createBrowserRpcSocket(url: string): IRpcSocket {
  if (typeof WebSocket === 'undefined') {
    throw new Error('[HermesGatewayClient] WebSocket runtime is unavailable');
  }
  return new WebSocket(url);
}
