/**
 * Hermes Flux 网关连接生命周期与 WebSocket 下行事件分发服务（Gateway Event Dispatcher · D6）
 *
 * 【设计意图 (Why)】
 *   将网关连接与断开生命周期管理（connect、disconnect、代际令牌维护）、下行事件解包流式分派
 *   （handleGatewayEvent、reduceGatewayEvent 消费、applyTurnActions、handleInspectorEvent）
 *   从 index.ts 中彻底解耦。
 *   使得下行网络事件通道与代际防污染机制可脱离 UI 单独验证，保证连接切换与重连时的绝对单调性与数据纯净度。
 *
 * 【防范的历史坑 (Pitfall)】
 *   1. 维护严格自增的 connectionEpoch 代际令牌，异步探测和重连回调若代际过期必须当场丢弃，防止迟到包污染当前连接；
 *   2. 120 FPS 流式双轨分流：高频增量数据（append-content、append-thought）只能推入 tokenCoalescer，绝对禁止触发全量 render；
 *   3. 工具插槽更新 tool-start / tool-complete 只能触发局部 scheduleToolPatch，严禁破坏 messagesChanged 短路逻辑；
 *   4. 断线 disconnect 时必须彻底清空全部活跃运行与未读集合（activeRunningSessionIds 等），否则重连后残留呼吸动效与未读绿点；
 *   5. 回合完成时，若用户已切走会话，绝不能拿当前视口的 state.messages 覆盖后台会话缓存，必须用 sessionMessagesCache 正确落盘。
 *
 * 【约束与规则 (Rules)】
 *   1. 单向依赖：严禁反向 import index.js，所有状态读取与外部调度通过 GatewayEventDispatcherDeps 注入；
 *   2. 严格类型约束：0 TS 报错，严禁使用 as any；
 *   3. 零文本写死：提示与错误文案统一走 deps.t 国际化字典输出。
 */

import type { AppState } from '../state/appState.js';
import type { HermesDesktopBridge } from '../../preload/index.js';
import {
  type HermesGatewayClient,
  type ProbeOrWakeResult,
  type TurnAction,
  type NormalizedSession,
  type SessionHandleRegistry,
  type ActivityTransitionTracker,
  type TokenCoalescer,
  type CacheChannelRef,
  type CacheService,
  type LiveStreamRegistry,
  HermesGatewayClient as GatewayClientImpl,
  classifyConnectionError,
  computeColdStartRetryDelayMs,
  resolveConnectionPhase,
  reduceGatewayEvent,
  applyTurnFailed,
  applySessionTitle,
} from '@hermes-flux/core';
import { safeSetItem, type I18nKey, type MessageViewModel, type StorageWriteFailure } from '@hermes-flux/ui';
import { bindTurnRowIds } from '../rollbackTransaction.js';
import type { ActiveStreamingContext } from '../services/turnExecutionService.js';
import { formatTimestamp } from '../services/turnExecutionService.js';
import type { BotActivityStore } from '../persistence/botActivityStore.js';
import { buildGatewayWsUrl, createGatewayReconnectResolver, type GatewayAuthResponse } from '../gatewayConnection.js';
import { createLiveStreamCoordinator } from './liveStreamCoordinator.js';

export { createLiveStreamCoordinator, resolveBotNameForSession } from './liveStreamCoordinator.js';

export type TurnWatchdogFeeder = () => void;

export interface GatewayEventDispatcherDeps {
  readonly getState: () => AppState;
  readonly getGatewayClient: () => HermesGatewayClient | null;
  readonly setGatewayClient: (client: HermesGatewayClient | null) => void;
  readonly getCurrentTicket: () => string | undefined;
  readonly setCurrentTicket: (ticket: string | undefined) => void;
  readonly getDesktopApi: () => HermesDesktopBridge | undefined;
  readonly getEffectiveUrl: (url?: string) => string;
  readonly testConnection: (url: string, user: string, pass: string) => Promise<GatewayAuthResponse>;
  readonly completeEntityTurn: (
    domain: 'session' | 'bot' | 'group',
    running: Set<string>,
    unread: Set<string>,
    entityId: string,
    focused: boolean
  ) => void;

  readonly getSessionHandleRegistry: () => SessionHandleRegistry;
  readonly getLiveStreamRegistry?: () => LiveStreamRegistry;
  readonly resolveBotNameForSession?: (storedSessionId: string) => string | null;
  readonly getSessionMessagesCache: () => Map<string, MessageViewModel[]>;
  readonly getTokenCoalescer: () => TokenCoalescer;
  readonly getActivityTransitionTracker: () => ActivityTransitionTracker;
  readonly getBotActivityStore: () => BotActivityStore;
  readonly getCacheService: () => CacheService;

  readonly getActiveRunningSessionIds: () => Set<string>;
  readonly getUnreadSessionIds: () => Set<string>;
  readonly getActiveRunningBotNames: () => Set<string>;
  readonly getUnreadBotNames: () => Set<string>;
  readonly getActiveRunningGroupRoomIds: () => Set<string>;
  readonly getUnreadGroupRoomIds: () => Set<string>;

  readonly getActiveStreamingContext: () => ActiveStreamingContext;
  readonly setActiveStreamingContext: (ctx: Partial<ActiveStreamingContext>) => void;
  readonly getTurnStartedSessionId: () => string | null;
  readonly setTurnStartedSessionId: (id: string | null) => void;

  readonly stopProfileAutoRefresh: () => void;
  readonly startProfileAutoRefresh: () => void;
  readonly stopAllGroupPollers: () => void;
  readonly clearTransitionRefreshTimer: () => void;
  readonly clearSessionsRefreshTimer: () => void;
  readonly scheduleSessionsRefresh: () => void;

  readonly persistTurnToCache: (targetSessionId: string, botName: string | null, msgs: MessageViewModel[]) => void;
  readonly persistSessionsToCache: (sessions: NormalizedSession[]) => void;
  readonly syncProfileLastMessages: () => void;
  readonly syncAgentPresence: () => void;
  readonly scheduleToolPatch: (messageId: string) => void;
  readonly clearToolPatchQueue?: () => void;
  readonly stopRunningToolTimers: () => void;
  readonly setMessageContent: (messageId: string, content: string) => void;
  readonly toStoredSessionId: (id: string | null | undefined) => string | null;

  readonly applyColdStartFocus: () => Promise<void>;
  readonly fetchProfiles: () => Promise<void>;
  readonly fetchSessions: () => Promise<void>;
  readonly fetchGroupRooms: () => Promise<void>;
  readonly fetchModelOptions: () => Promise<void>;
  readonly fetchProjects: () => Promise<void>;
  readonly prefetchSlashCatalog: () => Promise<void>;

  readonly armTurnWatchdog: () => void;
  feedTurnWatchdog?: TurnWatchdogFeeder;
  readonly disarmTurnWatchdog: () => void;
  readonly clearPresenceTerminal: () => void;
  readonly armPresenceTerminal: (terminal: NonNullable<AppState['presenceTerminal']>) => void;
  readonly setTimedDockNotice: (msg: string, durationMs?: number, options?: { skipRender?: boolean }) => void;

  readonly isStreamNearBottom?: () => boolean;
  readonly setPendingScrollToBottom?: (val: boolean) => void;
  readonly refreshActiveSession?: (opts?: { forceRefreshAfterReconnect?: boolean; checkLiveTurn?: boolean }) => Promise<void>;
  readonly onForceSyncMessageList?: (force?: boolean) => void;
  readonly ensureMessageWindow?: (totalCount: number) => void;
  readonly setMessageWindowUserExpanded?: (val: boolean) => void;

  readonly render: () => void;
  readonly t: (key: I18nKey, params?: Record<string, string | number>) => string;
  readonly onConnectedSync?: (trigger: 'connected' | 'reconnected') => Promise<void> | void;
  readonly onResumeAliveSync?: () => Promise<void> | void;
  readonly onStatusConnected?: () => void;
  readonly onStatusDisconnected?: () => void;
  readonly onReadyEnsureDoneSessions?: () => void;
  readonly onStatusTurnAction?: (
    action: TurnAction,
    toStoredSessionId: (id?: string | null) => string | null,
  ) => void;
}

export interface GatewayEventDispatcher {
  connect(targetUrl?: string): Promise<void>;
  disconnect(): void;
  wakeOrRetry(reason: string): Promise<ProbeOrWakeResult>;
  retryNow(): Promise<void>;
  markNetworkOffline(): void;
  setSyncHooks(hooks: {
    onConnectedSync?: GatewayEventDispatcherDeps['onConnectedSync'];
    onResumeAliveSync?: GatewayEventDispatcherDeps['onResumeAliveSync'];
  }): void;
  resumeReconnectStreaming(storedSessionId: string, liveSessionId: string, resumeResult?: Record<string, unknown>): void;
  finishReconnectStreaming(storedSessionId: string): void;
  attachLiveTurnFromResume(input: {
    storedSessionId: string;
    liveSessionId: string;
    resumeResult: Record<string, unknown>;
    botName?: string | null;
  }): boolean;
  reconcileActiveTurnFromResume(storedSessionId: string, resumeResult: Record<string, unknown>): void;
  syncFocusedStreamingProjection(preferredSessionId?: string): void;
  getConnectionEpoch(): number;
  handleGatewayEvent(params: unknown): void;
  applyTurnActions(actions: TurnAction[]): void;
  handleInspectorEvent(params: unknown): void;
}

export function createGatewayEventDispatcher(deps: GatewayEventDispatcherDeps): GatewayEventDispatcher {
  let connectionEpoch = 0;
  let coldStartRetryTimer: ReturnType<typeof setTimeout> | null = null;
  let coldStartRetryAttempt = 0;
  let inFlightAuthEpoch = 0;
  let inFlightAuthStartedAt = 0;
  let dynamicOnConnectedSync: GatewayEventDispatcherDeps['onConnectedSync'];
  let dynamicOnResumeAliveSync: GatewayEventDispatcherDeps['onResumeAliveSync'];

  const TURN_STREAM_EVENT_TYPES = new Set([
    'message.start',
    'message.delta',
    'message.interim',
    'thinking.delta',
    'reasoning.delta',
    'tool.start',
    'tool.complete',
    'tool.end',
    'tool.error',
  ]);

  const liveCoord = createLiveStreamCoordinator({
    getConnectionEpoch: () => connectionEpoch,
    getState: () => deps.getState(),
    getGatewayClient: () => deps.getGatewayClient(),
    getLiveStreamRegistry: () => deps.getLiveStreamRegistry?.(),
    resolveBotNameForSession: deps.resolveBotNameForSession,
    getSessionMessagesCache: () => deps.getSessionMessagesCache(),
    getActiveRunningSessionIds: () => deps.getActiveRunningSessionIds(),
    getActiveRunningBotNames: () => deps.getActiveRunningBotNames(),
    setActiveStreamingContext: (ctx) => deps.setActiveStreamingContext(ctx),
    setTurnStartedSessionId: (id) => deps.setTurnStartedSessionId(id),
    toStoredSessionId: (id) => deps.toStoredSessionId(id),
    setMessageContent: (mid, content) => deps.setMessageContent(mid, content),
    dropQueuedTokens: (mid) => deps.getTokenCoalescer().dropMessage?.(mid),
    armTurnWatchdog: () => deps.armTurnWatchdog(),
    disarmTurnWatchdog: () => deps.disarmTurnWatchdog(),
    clearPresenceTerminal: () => deps.clearPresenceTerminal(),
    syncAgentPresence: () => deps.syncAgentPresence(),
    render: () => deps.render(),
    refreshActiveSession: deps.refreshActiveSession,
    onForceSyncMessageList: deps.onForceSyncMessageList,
    ensureMessageWindow: deps.ensureMessageWindow,
    setMessageWindowUserExpanded: deps.setMessageWindowUserExpanded,
    isStreamNearBottom: deps.isStreamNearBottom,
    setPendingScrollToBottom: deps.setPendingScrollToBottom,
  });

  function clearColdStartRetryTimer(): void {
    if (coldStartRetryTimer) {
      clearTimeout(coldStartRetryTimer);
      coldStartRetryTimer = null;
    }
  }

  function handleInspectorEvent(params: unknown): void {
    if (!params || typeof params !== 'object') return;
    const frame = params as { type?: unknown; payload?: Record<string, unknown> };
    const type = typeof frame.type === 'string' ? frame.type : '';
    const payload = frame.payload || {};
    if (!type) return;

    const state = deps.getState();

    if (type === 'artifact.created' || type === 'artifact.updated') {
      const id = typeof payload.id === 'string' ? payload.id : '';
      const name = typeof payload.name === 'string' ? payload.name : '';
      if (!id || !name) return;
      const existing = state.artifacts.find((a) => a.id === id);
      if (existing) {
        Object.assign(existing, payload);
      } else {
        state.artifacts.unshift({
          id,
          name,
          type: typeof payload.type === 'string' ? payload.type : 'FILE',
          size: typeof payload.size === 'string' ? payload.size : '1KB',
          preview: typeof payload.preview === 'string' ? payload.preview : '',
        });
      }
      deps.render();
      return;
    }

    if ((type === 'browser.frame' || type === 'browser.navigate') && payload.url) {
      const url = typeof payload.url === 'string' ? payload.url : '';
      const title = typeof payload.title === 'string' ? payload.title : 'Page';
      const screenshotUrl = typeof payload.screenshotUrl === 'string'
        ? payload.screenshotUrl
        : (typeof payload.screenshot === 'string' ? payload.screenshot : undefined);
      state.browserFrame = {
        url,
        title,
        screenshotUrl,
      };
      deps.render();
      return;
    }

    if ((type === 'git.diff' || type === 'workspace.diff') && Array.isArray(payload.diffs)) {
      state.gitDiffs = payload.diffs;
      deps.render();
    }
  }

  function applyTurnActionsInternal(actions: TurnAction[], sourceStoredSessionId: string | null): void {
    let needsRender = false;
    let finalReplace: { messageId: string; text: string } | null = null;
    const state = deps.getState();
    const ctx = deps.getActiveStreamingContext();
    const streamRegistry = deps.getLiveStreamRegistry?.();

    for (const action of actions) {
      switch (action.type) {
        case 'turn-started': {
          const targetStartedId = sourceStoredSessionId || ctx.activeStreamingStoredSessionId || state.activeSessionId;
          const startedStream = targetStartedId ? streamRegistry?.getBySession(targetStartedId) : undefined;
          if (startedStream && action.turnId && !startedStream.turnId) {
            startedStream.turnId = action.turnId;
          }
          const remotePromptText = action.displayText || action.text;
          if (startedStream && remotePromptText && !startedStream.userMessageSynced) {
            if (liveCoord.insertRemoteUserPromptIfMissing(
              startedStream.storedSessionId,
              startedStream.messageId,
              remotePromptText,
            )) {
              if (startedStream.storedSessionId === state.activeSessionId) {
                deps.onForceSyncMessageList?.(true);
                needsRender = true;
              }
            }
          }
          if (!sourceStoredSessionId || targetStartedId === state.activeSessionId) {
            if (!state.isStreaming) {
              state.isStreaming = true;
              needsRender = true;
            }
            state.turnStartedAt = startedStream?.startedAt ?? Date.now();
            deps.setTurnStartedSessionId(targetStartedId);
            deps.clearPresenceTerminal();
          }
          deps.armTurnWatchdog();
          break;
        }

        case 'append-content': {
          const contentStream = streamRegistry?.getByMessageId(action.messageId);
          if (contentStream) {
            const deltaRes = streamRegistry?.acceptDelta(contentStream.storedSessionId, {
              text: action.text,
              turnId: action.turnId,
              segment: action.segment,
              offset: action.offset,
            });
            if (!deltaRes || !deltaRes.accepted || !deltaRes.deltaToAppend) break;
            deps.feedTurnWatchdog?.();
            deps.getTokenCoalescer().push({
              messageId: action.messageId,
              delta: deltaRes.deltaToAppend,
              isThought: false,
            });
            break;
          }
          deps.feedTurnWatchdog?.();
          deps.getTokenCoalescer().push({ messageId: action.messageId, delta: action.text, isThought: false });
          break;
        }

        case 'append-thought': {
          const thoughtStream = streamRegistry?.getByMessageId(action.messageId);
          if (thoughtStream) {
            streamRegistry?.touchActivity(thoughtStream.storedSessionId);
          }
          deps.feedTurnWatchdog?.();
          deps.getTokenCoalescer().push({ messageId: action.messageId, delta: action.text, isThought: true });
          break;
        }

        case 'interim-content': {
          deps.feedTurnWatchdog?.();
          const interimStream = streamRegistry?.getByMessageId(action.messageId);
          if (interimStream) {
            const res = streamRegistry?.acceptInterim(interimStream.storedSessionId, {
              text: action.text,
              alreadyStreamed: action.alreadyStreamed,
              turnId: action.turnId,
              segment: action.segment,
            });
            if (res?.accepted && res.deltaToAppend) {
              deps.getTokenCoalescer().push({
                messageId: action.messageId,
                delta: res.deltaToAppend,
                isThought: false,
              });
            }
          }
          break;
        }

        case 'stream-activity': {
          const activitySid = liveCoord.resolveStoredSessionId(action.sessionId);
          const touched = activitySid ? Boolean(streamRegistry?.touchActivity(activitySid)) : false;
          if (
            touched ||
            (activitySid && (
              activitySid === ctx.activeStreamingStoredSessionId ||
              deps.getActiveRunningSessionIds().has(activitySid)
            ))
          ) {
            deps.feedTurnWatchdog?.();
          }
          break;
        }

        case 'tool-start': {
          deps.feedTurnWatchdog?.();
          const now = Date.now();
          let parsedRawArgs: Record<string, unknown> | undefined;
          let parsedDelegationId: string | undefined;
          const rawArgsInput: unknown = action.toolCall.args;
          if (typeof rawArgsInput === 'string') {
            const trimmedArgs = rawArgsInput.trim();
            if (trimmedArgs.startsWith('{')) {
              try {
                const obj: unknown = JSON.parse(trimmedArgs);
                if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
                  parsedRawArgs = obj as Record<string, unknown>;
                }
              // gate-degrade: 工具参数非合法 JSON 时保留原始字符串，不阻断工具展示
              } catch {}
            }
          } else if (rawArgsInput && typeof rawArgsInput === 'object' && !Array.isArray(rawArgsInput)) {
            parsedRawArgs = rawArgsInput as Record<string, unknown>;
          }
          if (parsedRawArgs) {
            const rawDid = parsedRawArgs.delegation_id ?? parsedRawArgs.delegationId;
            if (typeof rawDid === 'string' && rawDid) {
              parsedDelegationId = rawDid;
            }
          }
          const ownerSessionId = streamRegistry?.getSessionIdForMessage(action.messageId) ?? ctx.activeStreamingStoredSessionId;
          if (ownerSessionId) streamRegistry?.touchActivity(ownerSessionId);
          const target = !ownerSessionId || ownerSessionId === state.activeSessionId
            ? state.messages.find((m) => m.id === action.messageId)
            : undefined;
          if (target) {
            if (!target.toolCalls) target.toolCalls = [];
            if (!target.toolCalls.some((tc) => tc.id === action.toolCall.id)) {
              target.toolCalls.push({
                id: action.toolCall.id,
                name: action.toolCall.name,
                status: 'running',
                args: action.toolCall.args,
                ...(parsedRawArgs ? { rawArgs: parsedRawArgs } : {}),
                ...(parsedDelegationId ? { delegationId: parsedDelegationId } : {}),
                startTime: now,
              });
            }
            deps.scheduleToolPatch(action.messageId);
          }
          if (ownerSessionId) {
            const cached = deps.getSessionMessagesCache().get(ownerSessionId);
            const cachedTarget = cached?.find((m) => m.id === action.messageId);
            if (cachedTarget) {
              if (!cachedTarget.toolCalls) cachedTarget.toolCalls = [];
              if (!cachedTarget.toolCalls.some((t) => t.id === action.toolCall.id)) {
                cachedTarget.toolCalls.push({
                  id: action.toolCall.id,
                  name: action.toolCall.name,
                  status: 'running',
                  args: action.toolCall.args,
                  ...(parsedRawArgs ? { rawArgs: parsedRawArgs } : {}),
                  ...(parsedDelegationId ? { delegationId: parsedDelegationId } : {}),
                  startTime: now,
                });
              }
            }
          }
          if (action.toolCall.name === 'delegate_task') {
            deps.onStatusTurnAction?.(action, deps.toStoredSessionId);
          }
          break;
        }

        case 'tool-complete': {
          deps.feedTurnWatchdog?.();
          const now = Date.now();
          const updateTc = (target?: MessageViewModel) => {
            if (target && target.toolCalls) {
              const tc = target.toolCalls.find((t) => action.toolCallId && t.id === action.toolCallId);
              if (tc) {
                tc.status = 'completed';
                if (action.output) {
                  tc.output = typeof action.output === 'object' ? JSON.stringify(action.output, null, 2) : String(action.output);
                }
                const serverMs = action.durationMs;
                if (typeof serverMs === 'number' && serverMs >= 0) {
                  tc.durationMs = tc.durationMs !== undefined ? Math.max(tc.durationMs, serverMs) : serverMs;
                } else if (tc.startTime) {
                  const computed = Math.max(100, now - tc.startTime);
                  tc.durationMs = tc.durationMs !== undefined ? Math.max(tc.durationMs, computed) : computed;
                }
              }
            }
          };

          const toolOwnerId = streamRegistry?.getSessionIdForMessage(action.messageId) ?? ctx.activeStreamingStoredSessionId;
          if (toolOwnerId) streamRegistry?.touchActivity(toolOwnerId);
          const target = !toolOwnerId || toolOwnerId === state.activeSessionId
            ? state.messages.find((m) => m.id === action.messageId)
            : undefined;
          if (target) {
            updateTc(target);
            deps.scheduleToolPatch(action.messageId);
          }
          if (toolOwnerId) {
            const cached = deps.getSessionMessagesCache().get(toolOwnerId);
            updateTc(cached?.find((m) => m.id === action.messageId));
          }
          break;
        }

        case 'persisted-turn': {
          const persistOwnerId = streamRegistry?.getSessionIdForMessage(action.messageId) ?? ctx.activeStreamingStoredSessionId ?? state.activeSessionId;
          let changed = !persistOwnerId || persistOwnerId === state.activeSessionId
            ? bindTurnRowIds({
                messages: state.messages,
                assistantMessageId: action.messageId,
                userRowId: action.userRowId,
                assistantRowId: action.assistantRowId,
                rowIds: action.rowIds,
              })
            : false;

          if (persistOwnerId) {
            const cached = deps.getSessionMessagesCache().get(persistOwnerId);
            if (cached && (persistOwnerId !== state.activeSessionId || cached !== state.messages)) {
              const cachedChanged = bindTurnRowIds({
                messages: cached,
                assistantMessageId: action.messageId,
                userRowId: action.userRowId,
                assistantRowId: action.assistantRowId,
                rowIds: action.rowIds,
              });
              if (cachedChanged) changed = true;
            }
          }

          if (changed) {
            needsRender = true;
            const ownerStream = persistOwnerId ? streamRegistry?.getBySession(persistOwnerId) : undefined;
            const ownerBotName = ownerStream?.botName ?? (persistOwnerId === ctx.activeStreamingStoredSessionId ? ctx.activeStreamingBotName : null);
            const msgsToPersist = persistOwnerId === state.activeSessionId ? state.messages : (deps.getSessionMessagesCache().get(persistOwnerId) || []);
            if (persistOwnerId && msgsToPersist.length > 0) {
              deps.persistTurnToCache(persistOwnerId, ownerBotName, msgsToPersist);
            }
          }
          break;
        }

        case 'replace-content':
          finalReplace = { messageId: action.messageId, text: action.text };
          break;

        case 'turn-completed': {
          // 【贴底意图必须在 flush / finalReplace 改写 DOM 之前捕获 (Why)】
          //   flush() 与 setMessageContent() 会瞬间撑高 #msg-content-*，若等到 render()
          //   再测 isStreamNearBottom，新增高度超过 168px 就会被误判为「用户不在底部」，
          //   从而把视口锁回上方的用户提示词位置。
          const wasNearBottomBeforeSettle = deps.isStreamNearBottom?.() ?? false;
          deps.getTokenCoalescer().flush();
          // 【清理未执行的工具补丁 rAF (Pitfall)】防止回合结束后迟到 rAF 覆写 React 接管的 #msg-tools-*
          deps.clearToolPatchQueue?.();
          deps.stopRunningToolTimers();
          const rawTargetId = sourceStoredSessionId || action.sessionId || ctx.activeStreamingStoredSessionId;
          const completedTargetId = deps.toStoredSessionId(liveCoord.resolveStoredSessionId(rawTargetId) || rawTargetId);
          const completedStream = completedTargetId ? streamRegistry?.removeSession(completedTargetId) : undefined;
          const completedBotName =
            completedStream?.botName ??
            (completedTargetId === ctx.activeStreamingStoredSessionId ? ctx.activeStreamingBotName : null);
          const replaceTargetId = completedTargetId || ctx.activeStreamingStoredSessionId;
          if (finalReplace) {
            const replacement = finalReplace;
            if (!replaceTargetId || replaceTargetId === state.activeSessionId || !streamRegistry) {
              deps.setMessageContent(replacement.messageId, replacement.text);
            }
            if (replaceTargetId) {
              const cached = deps.getSessionMessagesCache().get(replaceTargetId);
              const target = cached?.find((m) => m.id === replacement.messageId);
              if (target) target.content = replacement.text;
            }
          }
          const isFocused = !completedTargetId || completedTargetId === state.activeSessionId;
          const markCompletedTools = (msgs: MessageViewModel[]) => {
            for (const msg of msgs) {
              if (msg.toolCalls) {
                for (const tc of msg.toolCalls) {
                  if (tc.status === 'running') {
                    tc.status = 'completed';
                    if (tc.startTime && !tc.durationMs) {
                      tc.durationMs = Math.max(100, Date.now() - tc.startTime);
                    }
                  }
                }
              }
            }
          };
          if (isFocused) markCompletedTools(state.messages);
          if (completedTargetId) {
            const cached = deps.getSessionMessagesCache().get(completedTargetId);
            if (cached && (!isFocused || cached !== state.messages)) markCompletedTools(cached);
            const isSessionFocused = completedTargetId === state.activeSessionId;
            if (isSessionFocused && wasNearBottomBeforeSettle) {
              deps.setPendingScrollToBottom?.(true);
            }
            deps.completeEntityTurn('session', deps.getActiveRunningSessionIds(), deps.getUnreadSessionIds(), completedTargetId, isSessionFocused);
            if (isSessionFocused) {
              deps.getSessionMessagesCache().set(completedTargetId, [...state.messages]);
            }
            const msgsToPersist = isSessionFocused ? state.messages : (deps.getSessionMessagesCache().get(completedTargetId) || []);
            if (msgsToPersist.length > 0) {
              deps.persistTurnToCache(completedTargetId, completedBotName, msgsToPersist);
            }
            const completedSess = state.sessions.find((s) => s.id === completedTargetId);
            if (completedSess) {
              const finalMsg = isSessionFocused
                ? (state.messages.length > 0 ? state.messages[state.messages.length - 1] : null)
                : (deps.getSessionMessagesCache().get(completedTargetId)?.slice(-1)[0] || null);
              if (finalMsg?.content) {
                completedSess.preview = finalMsg.content;
              }
              completedSess.timestamp = Date.now();
              completedSess.time = formatTimestamp(Date.now());
              state.sessions = [completedSess, ...state.sessions.filter((s) => s.id !== completedSess.id)];
              deps.persistSessionsToCache(state.sessions);
            }
            if (isSessionFocused && !finalReplace && !completedStream && action.finalText) {
              liveCoord.scheduleActiveSessionIdleSync(0);
            }
          }
          if (completedBotName) {
            const isBotFocused = state.activeFocus.type === 'bot' && state.activeFocus.botName === completedBotName;
            const finalMsg = isBotFocused
              ? (state.messages.length > 0 ? state.messages[state.messages.length - 1] : null)
              : (completedTargetId ? deps.getSessionMessagesCache().get(completedTargetId)?.slice(-1)[0] || null : null);
            if (finalMsg?.content) {
              deps.getBotActivityStore().updateLatestActivity(completedBotName, finalMsg.content, Date.now());
            }
            deps.completeEntityTurn('bot', deps.getActiveRunningBotNames(), deps.getUnreadBotNames(), completedBotName, isBotFocused);
            if (ctx.activeStreamingBotName === completedBotName) {
              deps.setActiveStreamingContext({ activeStreamingBotName: null });
            }
          }
          deps.syncProfileLastMessages();
          const matchesProjectedCtx = Boolean(
            ctx.activeStreamingStoredSessionId && ctx.activeStreamingStoredSessionId === completedTargetId,
          );
          if (matchesProjectedCtx) {
            deps.setActiveStreamingContext({
              activeStreamingMessageId: null,
              activeStreamingStoredSessionId: null,
              activeStreamingLiveId: null,
              activeStreamingBotName: null,
            });
          }
          if (isFocused) {
            if (streamRegistry && state.activeSessionId && streamRegistry.hasSession(state.activeSessionId)) {
              liveCoord.syncFocusedStreamingProjection(state.activeSessionId);
            } else {
              state.isStreaming = false;
              state.turnStartedAt = undefined;
              deps.setTurnStartedSessionId(null);
              deps.clearPresenceTerminal();
              if (!streamRegistry || streamRegistry.size() === 0) {
                deps.disarmTurnWatchdog();
              }
            }
          } else if (
            streamRegistry
            && streamRegistry.size() === 0
            && !state.isStreaming
            && !deps.getActiveStreamingContext().activeStreamingStoredSessionId
          ) {
            deps.disarmTurnWatchdog();
          }
          needsRender = true;
          break;
        }

        case 'turn-failed': {
          const wasNearBottomBeforeFail = deps.isStreamNearBottom?.() ?? false;
          deps.getTokenCoalescer().flush();
          deps.clearToolPatchQueue?.();
          deps.stopRunningToolTimers();
          const rawFailedId = sourceStoredSessionId || action.sessionId || ctx.activeStreamingStoredSessionId;
          const failedTargetId = deps.toStoredSessionId(liveCoord.resolveStoredSessionId(rawFailedId) || rawFailedId);
          const failedStream = failedTargetId ? streamRegistry?.removeSession(failedTargetId) : undefined;
          const failedBotName =
            failedStream?.botName ??
            (failedTargetId === ctx.activeStreamingStoredSessionId ? ctx.activeStreamingBotName : null);
          const failedMsgId =
            failedStream?.messageId ??
            (failedTargetId === ctx.activeStreamingStoredSessionId || !failedTargetId ? ctx.activeStreamingMessageId : null);
          const isFocusedFailed = !failedTargetId || failedTargetId === state.activeSessionId;
          const pendingMsg = failedMsgId
            ? (state.messages.find((m) => m.id === failedMsgId) ??
              (failedTargetId ? deps.getSessionMessagesCache().get(failedTargetId)?.find((m) => m.id === failedMsgId) : undefined))
            : undefined;
          if (pendingMsg && !pendingMsg.content) {
            pendingMsg.content = deps.t('chat.turnFailedPrefix', { message: action.message });
          }
          if (failedTargetId) {
            if (failedTargetId === state.activeSessionId && wasNearBottomBeforeFail) {
              deps.setPendingScrollToBottom?.(true);
            }
            applyTurnFailed(deps.getActiveRunningSessionIds(), failedTargetId);
            deps.getActivityTransitionTracker().clear('session', failedTargetId);
          }
          if (failedBotName) {
            applyTurnFailed(deps.getActiveRunningBotNames(), failedBotName);
            deps.getActivityTransitionTracker().clear('bot', failedBotName);
            if (ctx.activeStreamingBotName === failedBotName) {
              deps.setActiveStreamingContext({ activeStreamingBotName: null });
            }
          }
          deps.syncProfileLastMessages();
          const matchesProjectedCtx = Boolean(
            ctx.activeStreamingStoredSessionId && ctx.activeStreamingStoredSessionId === failedTargetId,
          );
          if (matchesProjectedCtx) {
            deps.setActiveStreamingContext({
              activeStreamingMessageId: null,
              activeStreamingStoredSessionId: null,
              activeStreamingLiveId: null,
              activeStreamingBotName: null,
            });
          }
          if (isFocusedFailed) {
            if (streamRegistry && state.activeSessionId && streamRegistry.hasSession(state.activeSessionId)) {
              liveCoord.syncFocusedStreamingProjection(state.activeSessionId);
            } else {
              state.isStreaming = false;
              state.turnStartedAt = undefined;
              deps.setTurnStartedSessionId(null);
              deps.armPresenceTerminal({ kind: 'failed', message: action.message });
              // 【消除同步双 render (Pitfall)】setTimedDockNotice 默认会立即调用 render()，
              // 会提前消费 pendingScrollToBottom 并让批末 deps.render() 落在 messagesChanged=false 路径；
              // 传 skipRender: true 仅落盘通知与倒计时，由批末统一执行唯一一次 render()。
              deps.setTimedDockNotice(action.message, undefined, { skipRender: true });
              if (!streamRegistry || streamRegistry.size() === 0) {
                deps.disarmTurnWatchdog();
              }
            }
          } else if (
            streamRegistry
            && streamRegistry.size() === 0
            && !state.isStreaming
            && !deps.getActiveStreamingContext().activeStreamingStoredSessionId
          ) {
            deps.disarmTurnWatchdog();
          }
          needsRender = true;
          break;
        }

        case 'session-reclaimed': {
          const reclaimedSid = liveCoord.resolveStoredSessionId(action.storedSessionId || action.sessionId);
          const reclaimedStream = reclaimedSid ? streamRegistry?.removeSession(reclaimedSid) : undefined;
          if (reclaimedSid) {
            deps.getActiveRunningSessionIds().delete(reclaimedSid);
            deps.getActivityTransitionTracker().clear('session', reclaimedSid);
          }
          if (reclaimedStream?.botName) {
            deps.getActiveRunningBotNames().delete(reclaimedStream.botName);
            deps.getActivityTransitionTracker().clear('bot', reclaimedStream.botName);
          }
          if (reclaimedSid && reclaimedSid === state.activeSessionId) {
            state.activeLiveSessionId = '';
            liveCoord.syncFocusedStreamingProjection(reclaimedSid);
            void deps.refreshActiveSession?.({ forceRefreshAfterReconnect: true, checkLiveTurn: true });
          } else if (reclaimedSid && reclaimedSid === ctx.activeStreamingStoredSessionId) {
            liveCoord.syncFocusedStreamingProjection(state.activeSessionId);
          }
          needsRender = true;
          break;
        }

        case 'refresh-sessions':
          deps.scheduleSessionsRefresh();
          liveCoord.scheduleActiveSessionIdleSync();
          break;

        case 'session-title':
          state.sessions = applySessionTitle(state.sessions, action.sessionId, action.title);
          needsRender = true;
          break;

        case 'side-agent-complete': {
          const capsule = state.sideAgentCapsules.find((c) => c.id === action.taskId);
          if (capsule) {
            capsule.status = action.text ? 'done' : 'failed';
            capsule.answer = action.text || undefined;
            if (capsule.hintTimer) { clearTimeout(capsule.hintTimer); capsule.hintTimer = undefined; }
            if (capsule.expireTimer) { clearTimeout(capsule.expireTimer); capsule.expireTimer = undefined; }
            needsRender = true;
          }
          break;
        }

        case 'session-info':
        case 'session-usage':
        case 'subagent-update':
        case 'subagent-spawn':
        case 'subagent-progress':
        case 'subagent-log':
        case 'subagent-complete':
        case 'subagent-failed': {
          deps.onStatusTurnAction?.(action, deps.toStoredSessionId);
          const rawSid = action.type === 'subagent-spawn' ? action.parentSessionId : action.sessionId;
          const storedSid = liveCoord.resolveStoredSessionId(rawSid);
          if (storedSid) {
            if (action.type === 'session-info') {
              const infoRec = action.info as Record<string, unknown>;
              const infoRunning = Boolean(infoRec?.running || infoRec?.streaming);
              if (infoRunning) {
                if (
                  streamRegistry?.touchActivity(storedSid) ||
                  storedSid === ctx.activeStreamingStoredSessionId ||
                  deps.getActiveRunningSessionIds().has(storedSid)
                ) {
                  deps.feedTurnWatchdog?.();
                }
                if (storedSid === state.activeSessionId && streamRegistry && !streamRegistry.hasSession(storedSid)) {
                  liveCoord.scheduleActiveSessionIdleSync(50);
                }
              }
            } else if (streamRegistry?.touchActivity(storedSid) || storedSid === ctx.activeStreamingStoredSessionId) {
              deps.feedTurnWatchdog?.();
            }
          }
          break;
        }
      }
    }

    if (needsRender) deps.render();
    deps.syncAgentPresence();
  }

  function applyTurnActions(actions: TurnAction[]): void {
    applyTurnActionsInternal(actions, null);
  }

  function handleGatewayEvent(params: unknown): void {
    const runningStoredIds = Array.from(deps.getActiveRunningSessionIds());
    const registry = deps.getSessionHandleRegistry();
    const runningLiveIds = registry.getLiveIds(runningStoredIds);
    const state = deps.getState();
    const ctx = deps.getActiveStreamingContext();
    const streamRegistry = deps.getLiveStreamRegistry?.();
    const registeredStoredIds = streamRegistry ? streamRegistry.listSessionIds() : [];
    const registeredLiveIds = [
      ...registry.getLiveIds(registeredStoredIds),
      ...registeredStoredIds.map((sid) => streamRegistry?.getBySession(sid)?.liveSessionId || ''),
    ];

    const frameRec = params && typeof params === 'object' ? (params as Record<string, unknown>) : null;
    const frameType =
      frameRec && typeof frameRec.type === 'string'
        ? frameRec.type
        : frameRec && typeof frameRec.event === 'string'
          ? frameRec.event
          : frameRec && typeof frameRec.kind === 'string'
            ? frameRec.kind
            : '';
    const framePayload =
      frameRec && frameRec.payload && typeof frameRec.payload === 'object' && !Array.isArray(frameRec.payload)
        ? (frameRec.payload as Record<string, unknown>)
        : null;
    const rawFrameSessionId =
      frameRec && typeof frameRec.session_id === 'string' && frameRec.session_id
        ? frameRec.session_id
        : framePayload && typeof framePayload.session_id === 'string' && framePayload.session_id
          ? framePayload.session_id
          : '';
    const frameStoredId = rawFrameSessionId ? liveCoord.resolveStoredSessionId(rawFrameSessionId) : null;

    const activeLiveMapped = state.activeSessionId ? registry.toLiveId(state.activeSessionId) : null;
    const activeStoredMapped = state.activeLiveSessionId ? registry.toStoredId(state.activeLiveSessionId) : null;
    const streamingLiveMapped = ctx.activeStreamingStoredSessionId ? registry.toLiveId(ctx.activeStreamingStoredSessionId) : null;
    const streamingStoredMapped = ctx.activeStreamingLiveId ? registry.toStoredId(ctx.activeStreamingLiveId) : null;

    const activeIds = [
      state.activeLiveSessionId,
      state.activeSessionId,
      activeLiveMapped,
      activeStoredMapped,
      ctx.activeStreamingLiveId,
      ctx.activeStreamingStoredSessionId,
      streamingLiveMapped,
      streamingStoredMapped,
      ...runningStoredIds,
      ...runningLiveIds,
      ...registeredStoredIds,
      ...registeredLiveIds,
    ].filter((id): id is string => Boolean(id));

    let frameStream = streamRegistry && frameStoredId ? streamRegistry.getBySession(frameStoredId) : undefined;
    if (streamRegistry && rawFrameSessionId && frameStoredId && !frameStream && TURN_STREAM_EVENT_TYPES.has(frameType)) {
      const isFocusedFrame =
        frameStoredId === state.activeSessionId ||
        (Boolean(state.activeLiveSessionId) && rawFrameSessionId === state.activeLiveSessionId);
      const isKnownSession =
        state.sessions.some((s) => s.id === frameStoredId) ||
        Boolean(deps.resolveBotNameForSession?.(frameStoredId)) ||
        deps.getActiveRunningSessionIds().has(frameStoredId);
      const shouldAttach =
        isFocusedFrame ||
        deps.getActiveRunningSessionIds().has(frameStoredId) ||
        (frameType === 'message.start' && isKnownSession);
      if (shouldAttach) {
        const startUserText =
          frameType === 'message.start'
            ? (typeof framePayload?.display_text === 'string' && framePayload.display_text
                ? framePayload.display_text
                : typeof framePayload?.text === 'string'
                  ? framePayload.text
                  : undefined)
            : undefined;
        const startTurnId =
          typeof framePayload?.turn_id === 'string' && framePayload.turn_id ? framePayload.turn_id : undefined;
        frameStream = liveCoord.ensureRemoteObserverStream(frameStoredId, rawFrameSessionId, {
          turnId: startTurnId,
          userText: startUserText,
        });
        activeIds.push(rawFrameSessionId, frameStoredId);
      }
    }

    const resolvedStreamingMessageId = streamRegistry && frameStoredId
      ? (frameStream?.messageId ?? (frameStoredId === ctx.activeStreamingStoredSessionId ? ctx.activeStreamingMessageId : null))
      : ctx.activeStreamingMessageId;

    const actions = reduceGatewayEvent(params, {
      activeSessionIds: Array.from(new Set(activeIds)),
      activeStreamingMessageId: resolvedStreamingMessageId,
    });
    if (actions.length > 0) applyTurnActionsInternal(actions, frameStoredId);

    if (params && typeof params === 'object') {
      const evtName =
        'event' in params && typeof params.event === 'string'
          ? params.event
          : 'type' in params && typeof params.type === 'string'
            ? params.type
            : 'kind' in params && typeof params.kind === 'string'
              ? params.kind
              : '';
      if (evtName === 'projects.changed') {
        void deps.fetchProjects();
      }
    }

    handleInspectorEvent(params);
  }

  async function connect(targetUrl?: string): Promise<void> {
    const epoch = ++connectionEpoch;
    inFlightAuthEpoch = 0;
    inFlightAuthStartedAt = 0;
    clearColdStartRetryTimer();
    deps.stopProfileAutoRefresh();
    let hasConnectedOnce = false;

    const oldClient = deps.getGatewayClient();
    if (oldClient) {
      oldClient.disconnect();
      deps.setGatewayClient(null);
    }

    const state = deps.getState();
    state.activeLiveSessionId = '';
    deps.getSessionHandleRegistry().clear?.();
    deps.onStatusDisconnected?.();
    if (targetUrl) {
      state.gatewayUrl = targetUrl;
    }
    state.manualDisconnected = false;
    state.connectionAuthError = false;
    state.connectionReason = '';

    const effectiveUrl = deps.getEffectiveUrl(state.gatewayUrl);
    const hasUrl = Boolean(effectiveUrl);

    const syncConnectionPhaseField = (
      fsmState: 'DISCONNECTED' | 'CONNECTING' | 'HANDSHAKING' | 'CONNECTED' | 'RECONNECTING' | null,
    ): void => {
      state.connectionPhase = resolveConnectionPhase({
        hasGatewayUrl: hasUrl,
        manualDisconnected: state.manualDisconnected,
        authError: state.connectionAuthError,
        fsmState,
        isSyncing: state.connectionPhase === 'syncing',
        isSyncedFlash: state.connectionPhase === 'synced',
        isColdStartRetrying: coldStartRetryTimer !== null,
        hasConnectedOnce,
      });
    };

    if (!effectiveUrl) {
      coldStartRetryAttempt = 0;
      state.gatewayConnected = false;
      state.gatewayConnecting = false;
      state.connectionReconnectAttempt = 0;
      state.connectionPhase = 'unconfigured';
      state.profilesPhase = 'ready';
      state.sessionsPhase = 'ready';
      state.messagesPhase = 'ready';
      state.testStatus = undefined;
      void deps.applyColdStartFocus();
      deps.render();
      return;
    }

    // 连接成功后回写配置（P-032）：写盘失败只影响下次启动的记忆，不得中断连接流程。
    // 该路径是连接成功的副作用而非用户主动保存，失败只记日志、不弹窗打扰。
    let persistFailure: StorageWriteFailure = { ok: true };
    const persistedEntries: ReadonlyArray<readonly [string, string]> = [
      ['hermes_flux_gateway_url', state.gatewayUrl],
      ['hermes_flux_username', state.username],
      ['hermes_flux_password', state.password],
      ['hermes_flux_profile', state.profileName],
      ['hermes_aura_gateway_url', state.gatewayUrl],
      ['hermes_aura_username', state.username],
      ['hermes_aura_password', state.password],
      ['hermes_aura_profile', state.profileName],
    ];
    for (const [key, value] of persistedEntries) {
      const result = safeSetItem(key, value);
      if (!result.ok && persistFailure.ok) persistFailure = result;
      // 与 settingsDataService.writeGatewayDraft 同策略：SecurityError 不可恢复，首个失败即短路。
      if (!result.ok && result.reason === 'security') break;
    }
    if (!persistFailure.ok && persistFailure.reason !== 'unavailable') {
      console.warn('[gateway] failed to persist connection config; memory state is still active', {
        reason: persistFailure.reason,
        error: String(persistFailure.error),
      });
    }

    const triggerConnectedSync = (trigger: 'connected' | 'reconnected'): void => {
      const connectedSync = dynamicOnConnectedSync ?? deps.onConnectedSync;
      if (connectedSync) {
        void connectedSync(trigger);
        return;
      }
      Promise.allSettled([
        deps.fetchProfiles().then(() => Promise.allSettled([
          deps.fetchSessions().then(() => {
            deps.onReadyEnsureDoneSessions?.();
          }),
          deps.fetchGroupRooms(),
          deps.prefetchSlashCatalog(),
        ])),
        deps.fetchModelOptions(),
        deps.fetchProjects(),
      ]);
    };

    const scheduleColdStartRetry = (reasonMsg: string): void => {
      const kind = classifyConnectionError(reasonMsg);
      state.gatewayConnecting = false;
      state.gatewayConnected = false;
      state.connectionReason = reasonMsg;
      if (kind === 'auth' || kind === 'config') {
        state.connectionAuthError = kind === 'auth';
        coldStartRetryAttempt = 0;
        state.connectionReconnectAttempt = 0;
        state.connectionPhase = 'offline';
        return;
      }
      coldStartRetryAttempt += 1;
      state.connectionAuthError = false;
      state.connectionReconnectAttempt = coldStartRetryAttempt;
      state.connectionPhase = 'reconnecting';
      const delayMs = computeColdStartRetryDelayMs(coldStartRetryAttempt);
      coldStartRetryTimer = setTimeout(() => {
        coldStartRetryTimer = null;
        if (epoch !== connectionEpoch || state.manualDisconnected || state.connectionAuthError) return;
        void connect();
      }, delayMs);
      coldStartRetryTimer.unref?.();
    };

    state.gatewayConnecting = true;
    state.connectionPhase = coldStartRetryAttempt > 0 ? 'reconnecting' : 'connecting';
    state.testStatus = undefined;
    deps.render();

    try {
      inFlightAuthEpoch = epoch;
      inFlightAuthStartedAt = Date.now();
      let test: GatewayAuthResponse;
      try {
        test = await deps.testConnection(
          state.gatewayUrl,
          state.username,
          state.password
        );
      } finally {
        if (inFlightAuthEpoch === epoch) {
          inFlightAuthEpoch = 0;
          inFlightAuthStartedAt = 0;
        }
      }

      if (epoch !== connectionEpoch) return;

      state.gatewayLatencyMs = test.latency;
      state.testStatus = test;

      if (!test.ok) {
        state.profilesPhase = 'ready';
        state.sessionsPhase = 'ready';
        state.messagesPhase = 'ready';
        scheduleColdStartRetry(test.message);
        void deps.applyColdStartFocus();
        deps.render();
        return;
      }

      coldStartRetryAttempt = 0;
      state.connectionReconnectAttempt = 0;
      deps.setCurrentTicket(test.ticket);

      const baseUrl = effectiveUrl;
      const desktopApi = deps.getDesktopApi();
      const buildWsUrl = (ticket?: string): string =>
        buildGatewayWsUrl(baseUrl, ticket, desktopApi?.proxyWebSocketUrl);

      const client = new GatewayClientImpl({
        url: buildWsUrl(test.ticket),
        resolveUrl: createGatewayReconnectResolver({
          epoch,
          getCurrentEpoch: () => connectionEpoch,
          authenticate: () => deps.testConnection(state.gatewayUrl, state.username, state.password),
          buildUrl: buildWsUrl,
          onRefreshed: (refreshed: GatewayAuthResponse) => {
            state.gatewayLatencyMs = refreshed.latency;
            state.testStatus = refreshed;
            if (refreshed.ok) {
              deps.setCurrentTicket(refreshed.ticket);
              return;
            }
            if (classifyConnectionError(refreshed.message) === 'auth') {
              state.connectionAuthError = true;
              state.connectionReason = refreshed.message;
              state.gatewayConnected = false;
              state.gatewayConnecting = false;
              state.connectionPhase = 'offline';
              client.disconnect();
              deps.render();
            }
          },
          fallbackErrorMessage: deps.t('chat.gatewayNotConnected'),
        }),
        autoConnect: false,
        enableLifecycleWake: false,
        timeoutMs: 25000,
      });

      deps.setGatewayClient(client);

      if (desktopApi?.httpProxy) {
        client.setRestFallbackHandler(async (path, opts) => {
          return await desktopApi.httpProxy({
            baseUrl,
            path,
            method: opts?.method,
            ticket: deps.getCurrentTicket(),
            params: opts?.params,
            body: opts?.body,
          });
        });
      }

      client.onNotification('event', (params: unknown) => {
        handleGatewayEvent(params);
      });

      client.getFsm().onStateChange((fsmState) => {
        if (epoch !== connectionEpoch) return;

        const isConnected = fsmState === 'CONNECTED';
        const isConnecting = fsmState === 'CONNECTING' || fsmState === 'HANDSHAKING' || fsmState === 'RECONNECTING';
        const nextAttempt = fsmState === 'CONNECTED' ? 0 : client.getReconnectAttempt();
        const prevPhase = state.connectionPhase;
        const prevAttempt = state.connectionReconnectAttempt;
        const wasConnected = state.gatewayConnected;

        state.gatewayConnected = isConnected;
        state.gatewayConnecting = isConnecting;
        state.connectionReconnectAttempt = nextAttempt;
        if (isConnected) {
          state.connectionAuthError = false;
          state.connectionReason = '';
          if (!(dynamicOnConnectedSync ?? deps.onConnectedSync)) {
            state.connectionPhase = 'connected';
          }
        } else {
          if (state.connectionPhase === 'syncing' || state.connectionPhase === 'synced') {
            state.connectionPhase = 'reconnecting';
          }
          syncConnectionPhaseField(fsmState);
        }

        if (wasConnected && !isConnected) {
          // 断连瞬间必须同步清零 live 句柄，绝不能被 settings 编辑早退分支跳过
          state.activeLiveSessionId = '';
          deps.getSessionHandleRegistry().clear?.();
          deps.onStatusDisconnected?.();
        }

        const phaseOrAttemptChanged = prevPhase !== state.connectionPhase || prevAttempt !== nextAttempt;
        if (wasConnected !== isConnected || !isConnected || phaseOrAttemptChanged) {
          const isUserEditing =
            typeof document !== 'undefined' &&
            document.activeElement &&
            (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA');
          if (state.isSettingsOpen && isUserEditing && !isConnected) {
            return;
          }

          deps.render();
        }

        if (isConnected && !wasConnected) {
          const syncTrigger = hasConnectedOnce ? 'reconnected' : 'connected';
          hasConnectedOnce = true;
          deps.onStatusConnected?.();
          deps.startProfileAutoRefresh();
          triggerConnectedSync(syncTrigger);
        }
      });

      client.connect();
    } catch (err: unknown) {
      if (epoch !== connectionEpoch) return;
      console.error('[Flux Connect] Connection failed:', err);
      const errMsg = err instanceof Error ? err.message : String(err);
      state.testStatus = {
        ok: false,
        message: deps.t('chat.wsHandshakeFailed', { error: errMsg || deps.t('chat.networkError') }),
        latency: 0,
      };
      state.profilesPhase = 'ready';
      state.sessionsPhase = 'ready';
      state.messagesPhase = 'ready';
      scheduleColdStartRetry(errMsg || deps.t('chat.networkError'));
    }

    deps.render();
  }

  function disconnect(): void {
    connectionEpoch++;
    inFlightAuthEpoch = 0;
    inFlightAuthStartedAt = 0;
    clearColdStartRetryTimer();
    liveCoord.clearActiveSessionSyncTimer();
    liveCoord.clearHydrationState();
    deps.getLiveStreamRegistry?.().clear();
    coldStartRetryAttempt = 0;
    deps.stopProfileAutoRefresh();
    const client = deps.getGatewayClient();
    if (client) {
      client.disconnect();
      deps.setGatewayClient(null);
    }
    deps.getTokenCoalescer().clear();
    deps.clearToolPatchQueue?.();
    deps.disarmTurnWatchdog();
    deps.stopAllGroupPollers();
    deps.getActivityTransitionTracker().clearAll();
    deps.clearTransitionRefreshTimer();
    deps.setActiveStreamingContext({
      activeStreamingMessageId: null,
      activeStreamingStoredSessionId: null,
      activeStreamingLiveId: null,
      activeStreamingBotName: null,
    });
    deps.getActiveRunningSessionIds().clear();
    deps.getUnreadSessionIds().clear();
    deps.getActiveRunningBotNames().clear();
    deps.getUnreadBotNames().clear();
    deps.getActiveRunningGroupRoomIds().clear();
    deps.getUnreadGroupRoomIds().clear();
    deps.getSessionHandleRegistry().clear?.();
    deps.clearSessionsRefreshTimer();

    const state = deps.getState();
    state.manualDisconnected = true;
    state.gatewayConnected = false;
    state.gatewayConnecting = false;
    state.connectionReconnectAttempt = 0;
    state.connectionPhase = deps.getEffectiveUrl(state.gatewayUrl) ? 'offline' : 'unconfigured';
    state.gatewayLatencyMs = 0;
    state.messagesPhase = 'ready';
    state.sessions = [];
    state.archivedSessions = [];
    state.doneSessionsLoaded = false;
    state.doneLoading = false;
    state.doneError = '';
    state.orgFolders = [];
    state.orgAssignments = {};
    state.orgDoneRooms = {};
    state.settingsProjects = { status: 'idle' };
    state.messages = [];
    state.rollbackArmed = null;
    state.activeSessionId = '';
    state.activeLiveSessionId = '';
    state.pendingSessionIds = [];
    state.isStreaming = false;
    state.modelMenuOpen = false;
    state.sessionListError = '';
    state.dockNotice = '';
    state.learningState = { status: 'idle' };
    state.learningDetail = { status: 'idle' };
    deps.onStatusDisconnected?.();
    deps.render();
  }

  async function wakeOrRetry(reason: string): Promise<ProbeOrWakeResult> {
    const state = deps.getState();
    if (!deps.getEffectiveUrl(state.gatewayUrl) || state.manualDisconnected || state.connectionAuthError) {
      return 'disconnected';
    }
    const client = deps.getGatewayClient();
    if (!client) {
      // connect() 与 disconnect() 都会同步清零 inFlightAuthEpoch / inFlightAuthStartedAt，
      // 因此此处非零即代表当前代际的首跳鉴权确仍在途；手动点击 retryNow ('manual-retry') 允许立即抢占。
      if (
        reason !== 'manual-retry' &&
        inFlightAuthStartedAt > 0 &&
        Date.now() - inFlightAuthStartedAt < 8_000
      ) {
        return 'reconnecting';
      }
      clearColdStartRetryTimer();
      coldStartRetryAttempt = 0;
      state.connectionReconnectAttempt = 0;
      state.connectionPhase = 'reconnecting';
      deps.render();
      void connect();
      return 'reconnecting';
    }
    const result = await client.probeOrWake(reason);
    if (result === 'alive') {
      const resumeAliveSync = dynamicOnResumeAliveSync ?? deps.onResumeAliveSync;
      void resumeAliveSync?.();
    }
    return result;
  }

  function setSyncHooks(hooks: {
    onConnectedSync?: GatewayEventDispatcherDeps['onConnectedSync'];
    onResumeAliveSync?: GatewayEventDispatcherDeps['onResumeAliveSync'];
  }): void {
    dynamicOnConnectedSync = hooks.onConnectedSync;
    dynamicOnResumeAliveSync = hooks.onResumeAliveSync;
  }

  function resumeReconnectStreaming(
    storedSessionId: string,
    liveSessionId: string,
    resumeResult?: Record<string, unknown>,
  ): void {
    const streamRegistry = deps.getLiveStreamRegistry?.();
    if (streamRegistry) {
      if (resumeResult) {
        liveCoord.attachLiveTurnFromResume({
          storedSessionId,
          liveSessionId,
          resumeResult,
          botName: deps.resolveBotNameForSession?.(storedSessionId) ?? null,
        });
      } else if (streamRegistry.hasSession(storedSessionId)) {
        streamRegistry.updateLiveId(storedSessionId, liveSessionId);
        liveCoord.syncFocusedStreamingProjection(storedSessionId);
      }
      return;
    }
    if (deps.getActiveStreamingContext().activeStreamingStoredSessionId === storedSessionId) {
      deps.setActiveStreamingContext({ activeStreamingLiveId: liveSessionId });
      deps.armTurnWatchdog();
    }
  }

  function finishReconnectStreaming(storedSessionId: string): void {
    const streamRegistry = deps.getLiveStreamRegistry?.();
    const removedStream = streamRegistry?.removeSession(storedSessionId);
    if (removedStream) {
      deps.getTokenCoalescer().dropMessage?.(removedStream.messageId);
    }
    if (!streamRegistry || streamRegistry.size() === 0) {
      deps.getTokenCoalescer().clear();
    }
    deps.clearToolPatchQueue?.();
    deps.stopRunningToolTimers();
    if (removedStream?.botName) {
      deps.getActiveRunningBotNames().delete(removedStream.botName);
    }
    if (deps.getActiveStreamingContext().activeStreamingStoredSessionId === storedSessionId) {
      deps.setActiveStreamingContext({
        activeStreamingMessageId: null,
        activeStreamingStoredSessionId: null,
        activeStreamingLiveId: null,
        activeStreamingBotName: null,
      });
    }
    const state = deps.getState();
    if (state.activeSessionId === storedSessionId || !streamRegistry || streamRegistry.size() === 0) {
      state.isStreaming = false;
      state.turnStartedAt = undefined;
      deps.setTurnStartedSessionId(null);
    }
    if (!streamRegistry || streamRegistry.size() === 0) {
      deps.disarmTurnWatchdog();
    }
    deps.getActiveRunningSessionIds().delete(storedSessionId);
  }

  async function retryNow(): Promise<void> {
    const state = deps.getState();
    state.manualDisconnected = false;
    state.connectionAuthError = false;
    state.connectionReason = '';
    coldStartRetryAttempt = 0;
    state.connectionReconnectAttempt = 0;
    await wakeOrRetry('manual-retry');
  }

  function markNetworkOffline(): void {
    const state = deps.getState();
    if (!deps.getEffectiveUrl(state.gatewayUrl) || state.manualDisconnected || state.connectionAuthError) return;
    if (state.connectionPhase !== 'reconnecting') {
      state.connectionPhase = 'reconnecting';
      deps.render();
    }
  }

  return {
    connect,
    disconnect,
    wakeOrRetry,
    retryNow,
    markNetworkOffline,
    setSyncHooks,
    resumeReconnectStreaming,
    finishReconnectStreaming,
    attachLiveTurnFromResume: liveCoord.attachLiveTurnFromResume,
    reconcileActiveTurnFromResume: liveCoord.reconcileActiveTurnFromResume,
    syncFocusedStreamingProjection: liveCoord.syncFocusedStreamingProjection,
    getConnectionEpoch: () => connectionEpoch,
    handleGatewayEvent,
    applyTurnActions,
    handleInspectorEvent,
  };
}
