/**
 * 桌面与移动端统一交互式请求编排服务 (InteractivePromptService)
 *
 * 【设计意图 (Why)】
 *   将 Core 层无界状态机 `InteractiveRequestCoordinator` 接入渲染层真实生命周期：
 *   - 接管 WS 反向请求（`clarify` / `approval` / `secret` / `sudo` / `display.install.sudo` / `vault.*`）；
 *   - 在 `session.resume` / `approval.pending` / `groups.state` 返回前抓取并发围栏，防慢恢复抹杀实时卡片；
 *   - 统一封装 WS Result 与 RPC 降级提交路由（含 Classic 与 Canonical 隔离、socketGeneration 防串台、
 *     多步 `connection.respond` 部分收敛、`clarify.lock` 单题锁定与 `rpc_confirm` 贴舱停靠确认）；
 *   - 向左轨快照、Agent 在场指示器、看门狗探针、桌面贴舱停靠宿主及移动端 WorkspaceShell 同步等待状态。
 *
 * 【防范的历史坑 (Pitfall)】
 *   1. `live_ws` 反向请求若早于 `session.create` / `session.resume` 返回，只有 `liveSessionId` 没有 `storedSessionId`：
 *      通过 `bindSessionHandle(storedId, liveId)` 原位重键合并，防止停靠卡丢失或闪烁；
 *   2. 显式断连时必须调用 `coordinator.reset()` 并释放 `rpcConfirmResolvers`（绝不用 `cancelByRequestId` 污染 `terminalKeys`），
 *      既防切换模型悬垂，又确保同一网关重连后的同 ID 提示能正常恢复上屏；
 *   3. Classic 网关在 `running: true` 时单条 `pending_approval` 可能不全，必须在同一围栏内追加 `approval.pending` 探针（-32601 降级忽略）；
 *   4. 日志中严禁打印纯口令/密钥明文，一律经由 `redactInteractivePayload` 脱敏后再落日志。
 *
 * 【约束与规则 (Rules)】
 *   - 单向依赖：仅导入 `@hermes-flux/core` / `@hermes-flux/ui` 类型与状态类型，禁止反向 import `index.ts`；
 *   - 0 TS 报错，严禁 `as any`；
 *   - 绝不在本地或持久存储写入用户输入的敏感凭据。
 */

import {
  InteractiveRequestCoordinator,
  resolveReplyRoute,
  isIdempotentSettlementResponse,
  isRetryableTransportError,
  parseConnectionOperationTarget,
  redactInteractivePayload,
  resolveUnsupportedServerRequestResponse,
  type ActiveFocusDescriptor,
  type BackgroundWaitingSummary,
  type ClarifyLockResult,
  type ClarifyPrompt,
  type ConnectionOperationTarget,
  type ConnectionPrompt,
  type HermesGatewayClient,
  type InteractivePrompt,
  type InteractiveReplyPayload,
  type NormalizedGroupPendingAction,
  type ServerRequestFrame,
  type SessionHandleRegistry,
  type TurnAction,
  type WaitingPromptReason,
} from '@hermes-flux/core';
import { t as uiTranslate, type I18nKey } from '@hermes-flux/ui';
import type { AppState } from '../state/appState.js';

export interface RpcConfirmRequestOptions {
  readonly scope: InteractivePrompt['scope'];
  readonly confirmKind: 'expensive_model' | 'group_discard' | 'reload_mcp';
  readonly key: string;
  readonly title: string;
  readonly message: string;
  readonly confirmLabel?: string;
  readonly secondaryConfirmLabel?: string;
  readonly cancelLabel?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface InteractivePromptServiceDeps {
  readonly getState: () => AppState;
  readonly getGatewayClient: () => HermesGatewayClient | null;
  readonly getSessionHandleRegistry: () => SessionHandleRegistry;
  readonly toStoredSessionId: (id?: string | null) => string | null;
  readonly resolveBotForeverSessionMap: () => ReadonlyMap<string, string>;
  readonly resolveBotNameForSession: (storedSessionId: string) => string | null;
  readonly describeRpcError: (err: unknown) => string;
  readonly t?: (key: I18nKey, params?: Record<string, string | number>) => string;
  readonly openExternalUrl?: (url: string) => void | Promise<void>;
  readonly onTerminalSubmitNotice?: (message: string) => void;
  readonly onPromptsChanged: () => void;
  readonly logDebug?: (message: string, meta?: Record<string, unknown>) => void;
  readonly logWarn?: (message: string, meta?: Record<string, unknown>) => void;
  readonly now?: () => number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function buildInteractiveScopeKey(focus: ActiveFocusDescriptor, activeSessionId: string): string {
  if (focus.type === 'group') {
    return `group:${focus.roomId || ''}`;
  }
  if (focus.type === 'bot') {
    return activeSessionId ? `session:${activeSessionId}` : `bot:${focus.botName || ''}`;
  }
  return `session:${activeSessionId || focus.sessionId || ''}`;
}

export interface InteractivePromptService {
  readonly coordinator: InteractiveRequestCoordinator;
  subscribe(listener: () => void): () => void;
  captureSyncFence(): number;
  getProtocolForSession(storedOrLiveId: string | null | undefined): 'classic' | 'canonical';
  getGatewayProtocol(): 'classic' | 'canonical';
  handleServerRequest(frame: ServerRequestFrame, client: HermesGatewayClient): boolean;
  handleSocketClosed(closedGeneration?: number): void;
  resetOnDisconnect(): void;
  bindSessionHandle(storedSessionId: string, liveSessionId: string): void;
  reconcileSessionResume(input: {
    storedSessionId: string;
    liveSessionId: string | null;
    profile?: string;
    resume: Record<string, unknown> | null | undefined;
    fence: number;
  }): void;
  probeClassicPendingApprovalsIfRunning(input: {
    client: HermesGatewayClient;
    storedSessionId: string;
    liveSessionId: string | null;
    profile?: string;
    resume: Record<string, unknown> | null | undefined;
    fence: number;
  }): Promise<void>;
  reconcileGroupState(
    roomId: string,
    actions: readonly NormalizedGroupPendingAction[],
    profile?: string,
    protocolOverride?: 'classic' | 'canonical',
  ): void;
  handleTurnAction(action: TurnAction): void;
  clearSession(storedSessionId: string, liveSessionId?: string | null): void;
  submitReply(prompt: InteractivePrompt, payload: InteractiveReplyPayload): Promise<boolean>;
  lockClarifyAnswer(prompt: ClarifyPrompt, questionId: string, answer: string): Promise<void>;
  wakeConnection(prompt: ConnectionPrompt): Promise<void>;
  wakeActiveConnections(): Promise<void>;
  requestRpcConfirm(options: RpcConfirmRequestOptions): Promise<'confirm' | 'confirm_always' | 'cancel'>;
  getActivePromptsForCurrentFocus(): InteractivePrompt[];
  getBackgroundWaitingSummaries(): BackgroundWaitingSummary[];
  hasPendingPromptForSession(storedSessionId: string, liveSessionId?: string | null): boolean;
  hasPendingPromptForGroup(roomId: string): boolean;
  getWaitingReasonForCurrentFocus(): WaitingPromptReason | null;
  getWaitingEntityMaps(): {
    sessionWaitingReasons: Map<string, WaitingPromptReason>;
    groupWaitingReasons: Map<string, WaitingPromptReason>;
  };
  isCollapsedForCurrentFocus(): boolean;
  setCollapsedForCurrentFocus(collapsed: boolean): void;
  expandScope(scopeKey: string): void;
  getActivePromptKeyForCurrentFocus(): string | null;
  setActivePromptKeyForCurrentFocus(canonicalKey: string): void;
}

export function createInteractivePromptService(
  deps: InteractivePromptServiceDeps,
): InteractivePromptService {
  const coordinator = new InteractiveRequestCoordinator();
  const listeners = new Set<() => void>();
  const collapsedByScope = new Map<string, boolean>();
  const activeKeyByScope = new Map<string, string>();
  const sessionProtocols = new Map<string, 'classic' | 'canonical'>();
  let gatewayProtocol: 'classic' | 'canonical' = 'classic';
  const rpcConfirmResolvers = new Map<
    string,
    { resolve: (outcome: 'confirm' | 'confirm_always' | 'cancel') => void }
  >();
  const clarifyLockInFlight = new Set<string>();
  const tr = deps.t ?? uiTranslate;

  const nowMs = (): number => deps.now?.() ?? Date.now();

  const notify = (): void => {
    for (const listener of Array.from(listeners)) {
      listener();
    }
    deps.onPromptsChanged();
  };

  const toCoreFocus = (state: AppState): ActiveFocusDescriptor => {
    if (state.activeFocus.type === 'group') {
      return { type: 'group', roomId: state.activeFocus.roomId };
    }
    if (state.activeFocus.type === 'bot') {
      return { type: 'bot', botName: state.activeFocus.botName };
    }
    return { type: 'session', sessionId: state.activeFocus.sessionId };
  };

  const getCurrentScopeKey = (): string => {
    const state = deps.getState();
    return buildInteractiveScopeKey(toCoreFocus(state), state.activeSessionId);
  };

  const getProtocolForSession = (storedOrLiveId: string | null | undefined): 'classic' | 'canonical' => {
    if (!storedOrLiveId) return gatewayProtocol;
    const direct = sessionProtocols.get(storedOrLiveId);
    if (direct) return direct;
    const stored = deps.toStoredSessionId(storedOrLiveId);
    const mapped = stored ? sessionProtocols.get(stored) : undefined;
    if (mapped) {
      return mapped;
    }
    return gatewayProtocol;
  };

  const resolveProfileHint = (storedSessionId: string | null, rawProfile?: string): string | undefined => {
    if (rawProfile) return rawProfile;
    if (storedSessionId) {
      const bot = deps.resolveBotNameForSession(storedSessionId);
      if (bot) return bot;
    }
    const profile = deps.getState().profileName;
    return profile || undefined;
  };

  const handleServerRequest = (frame: ServerRequestFrame, client: HermesGatewayClient): boolean => {
    const unsupported = resolveUnsupportedServerRequestResponse(
      frame.method,
      client.getNegotiatedCapabilities(),
    );
    if (unsupported) {
      if (unsupported.kind === 'ws_response') {
        client.sendServerResponse(
          frame.id,
          unsupported.result,
          frame.socketGeneration,
          frame.method,
        );
        return true;
      }
      client.sendServerError(
        frame.id,
        unsupported.code,
        unsupported.message,
        undefined,
        frame.socketGeneration,
      );
      return true;
    }
    const rawLiveId =
      asOptionalString(frame.params.session_id) ?? asOptionalString(frame.params.gateway_session_id);
    const storedSessionId = rawLiveId ? deps.toStoredSessionId(rawLiveId) : null;
    const profile = resolveProfileHint(storedSessionId, asOptionalString(frame.params.profile));
    const protocol = getProtocolForSession(storedSessionId || rawLiveId);

    const prompt = coordinator.upsertServerRequest({
      rpcId: frame.id,
      socketGeneration: frame.socketGeneration,
      method: frame.method,
      params: frame.params,
      storedSessionId,
      profile,
      nowMs: nowMs(),
      origin: 'live_ws',
      protocol,
    });
    if (!prompt) {
      return false;
    }

    deps.logDebug?.('received interactive server request', {
      method: frame.method,
      rpcId: frame.id,
      canonicalKey: prompt.canonicalKey,
      params: redactInteractivePayload(frame.method, frame.params),
    });

    notify();
    return true;
  };

  const handleSocketClosed = (closedGeneration?: number): void => {
    coordinator.onSocketClosed(closedGeneration);
    notify();
  };

  const resetOnDisconnect = (): void => {
    coordinator.reset();
    for (const [key, waiter] of Array.from(rpcConfirmResolvers.entries())) {
      rpcConfirmResolvers.delete(key);
      waiter.resolve('cancel');
    }
    gatewayProtocol = 'classic';
    sessionProtocols.clear();
    notify();
  };

  const bindSessionHandle = (storedSessionId: string, liveSessionId: string): void => {
    if (!storedSessionId || !liveSessionId) return;
    coordinator.bindSessionHandle(storedSessionId, liveSessionId);
    const proto = sessionProtocols.get(liveSessionId) ?? sessionProtocols.get(storedSessionId);
    if (proto) {
      sessionProtocols.set(storedSessionId, proto);
      sessionProtocols.set(liveSessionId, proto);
    }
    notify();
  };

  const reconcileSessionResume = (input: {
    storedSessionId: string;
    liveSessionId: string | null;
    profile?: string;
    resume: Record<string, unknown> | null | undefined;
    fence: number;
  }): void => {
    const info = asRecord(input.resume?.info);
    if (info) {
      const proto: 'classic' | 'canonical' =
        info.desktop_protocol === 'hermes-gateway-v1' ? 'canonical' : 'classic';
      if (proto === 'canonical') {
        gatewayProtocol = 'canonical';
      }
      sessionProtocols.set(input.storedSessionId, proto);
      if (input.liveSessionId) {
        sessionProtocols.set(input.liveSessionId, proto);
      }
    }
    coordinator.reconcileFromResume({
      storedSessionId: input.storedSessionId,
      liveSessionId: input.liveSessionId,
      profile: input.profile,
      resume: input.resume,
      fence: input.fence,
      nowMs: nowMs(),
    });
    notify();
  };

  const probeClassicPendingApprovalsIfRunning = async (input: {
    client: HermesGatewayClient;
    storedSessionId: string;
    liveSessionId: string | null;
    profile?: string;
    resume: Record<string, unknown> | null | undefined;
    fence: number;
  }): Promise<void> => {
    const resume = input.resume;
    if (!resume || !Boolean(resume.running)) return;
    const info = asRecord(resume.info);
    if (info?.desktop_protocol === 'hermes-gateway-v1') return;

    const targetSessionId = input.liveSessionId || input.storedSessionId;
    if (!targetSessionId) return;

    try {
      const res = await input.client.call<{ approvals?: Array<Record<string, unknown>> }>(
        'approval.pending',
        {
          session_id: targetSessionId,
          ...(input.profile ? { profile: input.profile } : {}),
        },
        8000,
      );
      if (Array.isArray(res?.approvals)) {
        coordinator.reconcileApprovalPending(
          input.storedSessionId,
          input.liveSessionId,
          input.profile,
          res.approvals,
          input.fence,
          nowMs(),
        );
        notify();
      }
    // gate-degrade: 老版本网关未实现 approval.pending 时降级为仅依赖 session.resume 快照，非 -32601 记录告警便于排障
    } catch (err) {
      const errCode = (err as { code?: unknown } | null | undefined)?.code;
      const meta = {
        storedSessionId: input.storedSessionId,
        code: typeof errCode === 'number' ? errCode : undefined,
        message: deps.describeRpcError(err),
      };
      if (errCode === -32601) {
        deps.logDebug?.('approval.pending unsupported (-32601), falling back to session.resume', meta);
      } else {
        deps.logWarn?.('probeClassicPendingApprovalsIfRunning failed', meta);
      }
    }
  };

  const reconcileGroupState = (
    roomId: string,
    actions: readonly NormalizedGroupPendingAction[],
    profile?: string,
    protocolOverride?: 'classic' | 'canonical',
  ): void => {
    const protocol = protocolOverride ?? gatewayProtocol;
    coordinator.reconcileGroupPendingActions(
      roomId,
      profile,
      actions,
      protocol,
      nowMs(),
    );
    notify();
  };

  const handleTurnAction = (action: TurnAction): void => {
    switch (action.type) {
      case 'gateway-ready': {
        gatewayProtocol = action.sessionAuthority === true ? 'canonical' : 'classic';
        return;
      }
      case 'session-info': {
        const proto: 'classic' | 'canonical' =
          action.info?.desktop_protocol === 'hermes-gateway-v1' ? 'canonical' : 'classic';
        if (proto === 'canonical') {
          gatewayProtocol = 'canonical';
        }
        sessionProtocols.set(action.sessionId, proto);
        const stored = deps.toStoredSessionId(action.sessionId);
        if (stored) sessionProtocols.set(stored, proto);
        return;
      }
      case 'request-cancel': {
        const cancelled = coordinator.cancelByRequestId(action.id, action.reason);
        if (cancelled > 0) notify();
        return;
      }
      case 'approval-cancelled': {
        const cancelled = coordinator.cancelApprovalsForSession({
          session_id: action.sessionId,
          stored_session_id:
            action.storedSessionId ?? deps.toStoredSessionId(action.sessionId) ?? undefined,
          request_ids: action.requestIds,
          cancelled_count: action.cancelledCount,
          reason: action.reason,
        });
        if (cancelled > 0) notify();
        return;
      }
      case 'connection-request': {
        const storedSessionId = action.sessionId ? deps.toStoredSessionId(action.sessionId) : null;
        const profile = resolveProfileHint(storedSessionId);
        const prompt = coordinator.applyConnectionRequest(
          action.sessionId,
          action.payload,
          nowMs(),
          profile,
          storedSessionId,
        );
        if (prompt) notify();
        return;
      }
      case 'connection-update': {
        const liveId =
          action.payload.owner?.type === 'session' ? action.payload.owner.session_id : undefined;
        const storedSessionId = liveId ? deps.toStoredSessionId(liveId) : null;
        const profile = resolveProfileHint(storedSessionId);
        coordinator.applyConnectionUpdate(action.payload, nowMs(), profile, storedSessionId);
        notify();
        return;
      }
      default:
        return;
    }
  };

  const clearSession = (storedSessionId: string, liveSessionId?: string | null): void => {
    const removedKeys = coordinator.clearForSession(storedSessionId, liveSessionId);
    for (const key of removedKeys) {
      const waiter = rpcConfirmResolvers.get(key);
      if (waiter) {
        rpcConfirmResolvers.delete(key);
        waiter.resolve('cancel');
      }
    }
    collapsedByScope.delete(`session:${storedSessionId}`);
    activeKeyByScope.delete(`session:${storedSessionId}`);
    notify();
  };

  const dispatchRpcRoute = async (
    client: HermesGatewayClient,
    prompt: InteractivePrompt,
    method: string,
    params: Record<string, unknown>,
  ): Promise<boolean> => {
    deps.logDebug?.('submitting interactive rpc route', {
      method,
      canonicalKey: prompt.canonicalKey,
      params: redactInteractivePayload(method, params),
    });

    try {
      const res = await client.call<Record<string, unknown>>(method, params, 25000);
      if (method === 'connection.respond' && prompt.kind === 'connection') {
        const rec = asRecord(res);
        const opId = prompt.opId;
        const settled = Boolean(rec?.settled);
        const updatedTargets = Array.isArray(rec?.targets)
          ? rec.targets
              .map(parseConnectionOperationTarget)
              .filter((item): item is ConnectionOperationTarget => item !== null)
          : undefined;
        coordinator.applyConnectionRespondResult(opId, settled, updatedTargets);
        notify();
        return true;
      }

      if (isIdempotentSettlementResponse(method, res)) {
        coordinator.confirmSettled(prompt.canonicalKey);
        notify();
        return true;
      }

      coordinator.confirmSettled(prompt.canonicalKey);
      notify();
      return true;
    } catch (err) {
      const errText = deps.describeRpcError(err);
      deps.logWarn?.('interactive rpc submission failed', {
        method,
        canonicalKey: prompt.canonicalKey,
        error: errText,
      });

      if (isRetryableTransportError(err)) {
        coordinator.rollbackSubmit(prompt.canonicalKey, errText);
        notify();
        return false;
      }

      // 非可重试终态协议错误（4000/4001/expired/already_resolved）立即收敛避免死循环重试，
      // 但若非 benign 幂等状态则显式通过顶部提示条曝光错误
      coordinator.confirmSettled(prompt.canonicalKey);
      notify();
      const lower = errText.toLowerCase();
      if (!lower.includes('already') && !lower.includes('expired')) {
        deps.onTerminalSubmitNotice?.(errText);
      }
      return true;
    }
  };

  const submitReply = async (
    prompt: InteractivePrompt,
    payload: InteractiveReplyPayload,
  ): Promise<boolean> => {
    if (!coordinator.beginSubmit(prompt.canonicalKey)) {
      return false;
    }
    notify();

    const client = deps.getGatewayClient();
    const currentSocketGen = client ? client.getSocketGeneration() : null;
    const caps = client?.getNegotiatedCapabilities() ?? null;
    const route = resolveReplyRoute(prompt, payload, currentSocketGen, caps);

    if (route.transport === 'local_callback') {
      const waiter = rpcConfirmResolvers.get(prompt.canonicalKey);
      rpcConfirmResolvers.delete(prompt.canonicalKey);
      coordinator.confirmSettled(prompt.canonicalKey);
      notify();
      waiter?.resolve(route.outcome);
      return true;
    }

    if (!client) {
      coordinator.rollbackSubmit(prompt.canonicalKey, tr('chat.gatewayNotConnected'));
      notify();
      return false;
    }

    if (route.transport === 'ws_response') {
      deps.logDebug?.('sending interactive ws response', {
        method: route.method,
        rpcId: route.id,
        result: redactInteractivePayload(route.method, route.result),
      });
      const sent = client.sendServerResponse(
        route.id,
        route.result,
        route.socketGeneration,
        route.method,
      );
      if (sent) {
        coordinator.confirmSettled(prompt.canonicalKey);
        notify();
        return true;
      }
      // 套接字 generation 在点击瞬间发生切代，自动无缝切走 RPC 补发通路
      const fallbackRoute = resolveReplyRoute(
        { ...prompt, rpcId: null, socketGeneration: null },
        payload,
        currentSocketGen,
        caps,
      ) as Extract<ReturnType<typeof resolveReplyRoute>, { transport: 'rpc' }>;
      return await dispatchRpcRoute(client, prompt, fallbackRoute.method, fallbackRoute.params);
    }

    return await dispatchRpcRoute(client, prompt, route.method, route.params);
  };

  const lockClarifyAnswer = async (
    prompt: ClarifyPrompt,
    questionId: string,
    answer: string,
  ): Promise<void> => {
    const client = deps.getGatewayClient();
    if (!client || prompt.protocol === 'canonical') return;
    const lockKey = `${prompt.canonicalKey}::${questionId}`;
    if (clarifyLockInFlight.has(lockKey)) return;
    clarifyLockInFlight.add(lockKey);
    const profile = prompt.scope.kind === 'session' ? prompt.scope.profile : undefined;
    try {
      const res = await client.call<ClarifyLockResult>('clarify.lock', {
        request_id: prompt.requestId,
        question_id: questionId,
        answer,
        ...(profile ? { profile } : {}),
      }, 15000);
      if (res?.status === 'expired') {
        coordinator.confirmSettled(prompt.canonicalKey);
      } else {
        coordinator.applyClarifyLockResult(
          prompt.canonicalKey,
          questionId,
          answer,
          res?.remaining ?? null,
        );
      }
      notify();
    } catch (err) {
      deps.logWarn?.('clarify.lock failed', {
        requestId: prompt.requestId,
        questionId,
        error: deps.describeRpcError(err),
      });
    } finally {
      clarifyLockInFlight.delete(lockKey);
    }
  };

  const wakeConnection = async (prompt: ConnectionPrompt): Promise<void> => {
    const client = deps.getGatewayClient();
    if (!client) return;
    const profile =
      prompt.scope.kind === 'session' || prompt.scope.kind === 'account'
        ? prompt.scope.profile
        : undefined;
    try {
      await client.call(
        'connectors.operation.wake',
        {
          ...(profile ? { profile } : {}),
          op_id: prompt.opId,
        },
        15000,
      );
    } catch (err) {
      deps.logWarn?.('connectors.operation.wake failed', {
        opId: prompt.opId,
        error: deps.describeRpcError(err),
      });
    }
  };

  const wakeActiveConnections = async (): Promise<void> => {
    const unresolved = coordinator.listUnresolvedPrompts();
    const conns = unresolved.filter((p): p is ConnectionPrompt => p.kind === 'connection');
    for (const conn of conns) {
      await wakeConnection(conn);
    }
  };

  const requestRpcConfirm = (
    options: RpcConfirmRequestOptions,
  ): Promise<'confirm' | 'confirm_always' | 'cancel'> => {
    const existing = rpcConfirmResolvers.get(options.key);
    if (existing) {
      existing.resolve('cancel');
      rpcConfirmResolvers.delete(options.key);
    }
    return new Promise((resolve) => {
      const canonicalKey = options.key;
      rpcConfirmResolvers.set(canonicalKey, { resolve });
      coordinator.addRpcConfirmPrompt({
        canonicalKey,
        requestId: canonicalKey,
        kind: 'rpc_confirm',
        scope: options.scope,
        waitingReason: 'confirm',
        createdAtMs: nowMs(),
        rpcId: null,
        socketGeneration: null,
        origin: 'rpc_confirm',
        protocol: 'classic',
        confirmKind: options.confirmKind,
        title: options.title,
        message: options.message,
        ...(options.confirmLabel ? { confirmLabel: options.confirmLabel } : {}),
        ...(options.secondaryConfirmLabel
          ? { secondaryConfirmLabel: options.secondaryConfirmLabel }
          : {}),
        ...(options.cancelLabel ? { cancelLabel: options.cancelLabel } : {}),
        ...(options.metadata ? { metadata: options.metadata } : {}),
      });
      if (options.scope.kind === 'session') {
        const sid = options.scope.storedSessionId || options.scope.liveSessionId || '';
        if (sid) collapsedByScope.set(`session:${sid}`, false);
      } else if (options.scope.kind === 'group') {
        collapsedByScope.set(`group:${options.scope.roomId}`, false);
      }
      activeKeyByScope.set(getCurrentScopeKey(), canonicalKey);
      notify();
    });
  };

  const getActivePromptsForCurrentFocus = (): InteractivePrompt[] => {
    const state = deps.getState();
    return coordinator.getActivePromptsForFocus(
      toCoreFocus(state),
      state.activeSessionId,
      state.activeLiveSessionId,
    );
  };

  const getBackgroundWaitingSummaries = (): BackgroundWaitingSummary[] => {
    const state = deps.getState();
    return coordinator.getBackgroundWaitingPrompts(
      toCoreFocus(state),
      state.activeSessionId,
      state.activeLiveSessionId,
      deps.resolveBotForeverSessionMap(),
    );
  };

  const hasPendingPromptForSession = (
    storedSessionId: string,
    liveSessionId?: string | null,
  ): boolean => coordinator.hasPendingPromptForSession(storedSessionId, liveSessionId);

  const hasPendingPromptForGroup = (roomId: string): boolean =>
    Boolean(roomId && coordinator.getWaitingEntityMaps().groupWaitingReasons.has(roomId));

  const getWaitingReasonForCurrentFocus = (): WaitingPromptReason | null => {
    const state = deps.getState();
    return coordinator.getWaitingReasonForFocus(
      toCoreFocus(state),
      state.activeSessionId,
      state.activeLiveSessionId,
    );
  };

  const getWaitingEntityMaps = () => coordinator.getWaitingEntityMaps();

  const isCollapsedForCurrentFocus = (): boolean => {
    return collapsedByScope.get(getCurrentScopeKey()) ?? false;
  };

  const setCollapsedForCurrentFocus = (collapsed: boolean): void => {
    collapsedByScope.set(getCurrentScopeKey(), collapsed);
    notify();
  };

  const expandScope = (scopeKey: string): void => {
    collapsedByScope.set(scopeKey, false);
    notify();
  };

  const getActivePromptKeyForCurrentFocus = (): string | null => {
    const prompts = getActivePromptsForCurrentFocus();
    if (prompts.length === 0) return null;
    const saved = activeKeyByScope.get(getCurrentScopeKey());
    if (saved && prompts.some((p) => p.canonicalKey === saved)) {
      return saved;
    }
    return prompts[0].canonicalKey;
  };

  const setActivePromptKeyForCurrentFocus = (canonicalKey: string): void => {
    activeKeyByScope.set(getCurrentScopeKey(), canonicalKey);
    notify();
  };

  return {
    coordinator,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    captureSyncFence: () => coordinator.captureSyncFence(),
    getProtocolForSession,
    getGatewayProtocol: () => gatewayProtocol,
    handleServerRequest,
    handleSocketClosed,
    resetOnDisconnect,
    bindSessionHandle,
    reconcileSessionResume,
    probeClassicPendingApprovalsIfRunning,
    reconcileGroupState,
    handleTurnAction,
    clearSession,
    submitReply,
    lockClarifyAnswer,
    wakeConnection,
    wakeActiveConnections,
    requestRpcConfirm,
    getActivePromptsForCurrentFocus,
    getBackgroundWaitingSummaries,
    hasPendingPromptForSession,
    hasPendingPromptForGroup,
    getWaitingReasonForCurrentFocus,
    getWaitingEntityMaps,
    isCollapsedForCurrentFocus,
    setCollapsedForCurrentFocus,
    expandScope,
    getActivePromptKeyForCurrentFocus,
    setActivePromptKeyForCurrentFocus,
  };
}
