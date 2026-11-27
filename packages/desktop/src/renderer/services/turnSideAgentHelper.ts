/**
 * 回合执行服务的外援胶囊（`@Agent` BTW / 后台委派）与路由候选收集辅助模块。
 *
 * 【设计意图 (Why)】
 *   将外援提问请求（`sendBtw` / `prompt.background`）及状态胶囊生命周期定时器管理
 *   与群聊/全局 `@提及` 候选清单构建从 `turnExecutionService.ts` 拆出，保持主服务聚焦核心
 *   回合状态机与队列控制，并将单文件严格收敛在 1500 行工程门禁以内。
 *
 * 【防范的历史坑 (Pitfall)】
 *   1. 创建定时器后必须统一调用 `safeUnrefTimer`，防止未结束的 Node 测试进程因悬垂计时器卡住退出；
 *   2. 群聊房间的已知 `@` 成员名及全员广播词 `'all'` 必须纳入候选，保证 `planSendRoute` 精准分流。
 *
 * 【约束与规则 (Rules)】
 *   - 零 DOM 依赖、零 `as any`；
 *   - 所有用户可见提示经由 `t()` 输出。
 */

import type { HandoffService, HermesGatewayClient, IRpcCaller } from '@hermes-flux/core';
import type { I18nKey } from '@hermes-flux/ui';
import type { AppState } from '../state/appState.js';

export function safeUnrefTimer(timer: unknown): void {
  if (timer && typeof (timer as { unref?: () => void }).unref === 'function') {
    (timer as { unref: () => void }).unref();
  }
}

export function describeRpcError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object') {
    if ('message' in error && typeof error.message === 'string') return error.message;
    if ('code' in error && typeof error.code === 'number') return `RPC error ${error.code}`;
  }
  return String(error);
}

/** 为在途外援胶囊挂载慢响应提示与 10 分钟过期自动收口定时器。 */
export function armSideAgentCapsuleTimers(deps: {
  taskId: string;
  getState: () => AppState;
  render: () => void;
  t: (key: I18nKey, params?: Record<string, string | number>) => string;
}): void {
  const { taskId, getState, render, t } = deps;
  const state = getState();
  const cap = state.sideAgentCapsules.find((c) => c.id === taskId);
  if (!cap) return;
  cap.hintTimer = setTimeout(() => {
    const c = state.sideAgentCapsules.find((x) => x.id === taskId);
    if (c && c.status === 'pending') {
      c.notice = t('capsule.slowHint');
      render();
    }
  }, 15000);
  safeUnrefTimer(cap.hintTimer);
  cap.expireTimer = setTimeout(() => {
    const c = state.sideAgentCapsules.find((x) => x.id === taskId);
    if (c && c.status === 'pending') {
      c.status = 'expired';
      render();
    }
  }, 600000);
  safeUnrefTimer(cap.expireTimer);
}

/** 发起只读 BTW 或后台委派任务，并追加对应的追踪胶囊。 */
export async function executeAskSideAgent(deps: {
  kind: 'btw' | 'delegation';
  targetProfile: string;
  question: string;
  getState: () => AppState;
  resolveTargetClient: (gatewayId?: string) => HermesGatewayClient | null;
  resolveTargetRpcCaller: (client: HermesGatewayClient) => IRpcCaller;
  ensureLiveSessionId: () => Promise<string | null>;
  getHandoffService: () => HandoffService;
  setTimedDockNotice: (msg: string, durationMs?: number) => void;
  render: () => void;
  t: (key: I18nKey, params?: Record<string, string | number>) => string;
}): Promise<void> {
  const state = deps.getState();
  if (state.activeEntityGatewayOffline) {
    deps.setTimedDockNotice(deps.t('gateway.offlineReadOnlyNotice'));
    deps.render();
    return;
  }
  const targetGw = state.activeFocus?.gatewayId || state.activeGatewayId;
  const client = deps.resolveTargetClient(targetGw);
  if (!client) {
    deps.setTimedDockNotice(deps.t('chat.gatewayNotConnected'));
    return;
  }
  const liveId = await deps.ensureLiveSessionId();
  if (!liveId) {
    deps.setTimedDockNotice(deps.t('chat.forkNoLive'));
    deps.render();
    return;
  }

  const resolved =
    state.profiles.find(
      (p) =>
        (!targetGw || !p.gatewayId || p.gatewayId === targetGw) &&
        (p.name === deps.targetProfile || p.displayName === deps.targetProfile),
    )?.name || deps.targetProfile;

  try {
    let taskId: string;
    if (deps.kind === 'btw') {
      const res = await deps
        .getHandoffService()
        .sendBtw(liveId, deps.question, resolved, deps.resolveTargetRpcCaller(client));
      taskId = res.task_id;
    } else {
      const res = await client.call<{ task_id?: string }>('prompt.background', {
        session_id: liveId,
        text: deps.question,
        profile: resolved,
      });
      if (!res?.task_id) throw new Error('prompt.background missing task_id');
      taskId = res.task_id;
    }

    state.sideAgentCapsules = [
      ...state.sideAgentCapsules,
      {
        id: taskId,
        kind: deps.kind,
        profile: resolved,
        question: deps.question,
        status: 'pending',
        startedAt: Date.now(),
      },
    ];
    armSideAgentCapsuleTimers({
      taskId,
      getState: deps.getState,
      render: deps.render,
      t: deps.t,
    });
    deps.render();
  } catch (err) {
    state.sideAgentCapsules = [
      ...state.sideAgentCapsules,
      {
        id: `failed-${Date.now()}`,
        kind: deps.kind,
        profile: resolved,
        question: deps.question,
        status: 'failed',
        startedAt: Date.now(),
        notice: describeRpcError(err),
      },
    ];
    deps.render();
  }
}

/** 收集当前上下文（个人 Profile 列表 + 群聊房间成员与 `'all'`）的可路由 `@` 标识。 */
export function collectKnownSendProfiles(
  state: Pick<AppState, 'profiles' | 'activeFocus' | 'groupRooms'>,
): string[] {
  const knownProfiles = state.profiles.map((p) => p.name);
  for (const p of state.profiles) {
    if (p.displayName) knownProfiles.push(p.displayName);
  }
  const focus = state.activeFocus;
  if (focus.type === 'group' && focus.roomId) {
    const room = state.groupRooms.find(
      (r) => r.roomId === focus.roomId && (!focus.gatewayId || !r.gatewayId || r.gatewayId === focus.gatewayId),
    );
    if (room && Array.isArray(room.members)) {
      for (const m of room.members) {
        if (typeof m === 'string' && m && !knownProfiles.includes(m)) {
          knownProfiles.push(m);
        }
      }
    }
    if (!knownProfiles.includes('all')) {
      knownProfiles.push('all');
    }
  }
  return knownProfiles;
}
