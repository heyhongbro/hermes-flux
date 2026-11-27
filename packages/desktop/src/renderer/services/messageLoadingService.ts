/**
 * Hermes Flux 消息加载、历史分页漫游与副标题同步服务（Message Loading Service）
 *
 * 【设计意图 (Why)】
 *   将首屏消息极速装载（loadMessages / loadMessagesInner，包含 0ms 内存秒开、IndexedDB 优先读与权威 REST 对齐）、
 *   历史向上分页漫游（loadOlderMessages，包含血缘追溯、游标对齐、高估回退重拉、挂载窗口位移与锚点保持）、
 *   消息原始行解析与归一化（parseRawMessages）、
 *   会话副标题向左轨反哺同步（syncActiveSessionPreviewToRail）以及
 *   游标状态生命周期管理（forgetOlderCursorState）从 index.ts 中彻底解耦。
 *   实现零 DOM 依赖（或具备脱离 DOM 纯逻辑单测性），确保核心历史分页与权威合并状态机具备可形式化验证性。
 *
 * 【防范的历史坑 (Pitfall)】
 *   1. 必须包含被上下文压缩归档的原始消息（includeCompacted: true），否则翻到压缩摘要节点就中断；
 *   2. 向上翻页网络失败绝不可判定为"已到最早"（Failure Is Not Empty），否则网络瞬断会导致更早历史永久丢失；
 *   3. 游标推进必须由 planOlderPagination 结合本地已覆盖行数计算，高估越界撞空时退回保守游标（planOlderZeroMessagesAction）；
 *   4. 切会话代际竞态：迟滞慢响应（Delayed Slow Response）必须由代际 generation 阻断，坚决不可污染新会话视口与缓存；
 *   5. 副标题反哺必须按 botName + sessionId 联合寻址，杜绝跨 Profile 同名 ID 篡改。
 *
 * 【约束与规则 (Rules)】
 *   1. 单向依赖：严禁反向 import index.js，所有状态读写与 UI 渲染通过 MessageLoadingDeps 依赖注入；
 *   2. 严格类型推导：0 TS 报错，严禁使用 `as any`；
 *   3. 加载态同步收敛：isLoadingOlder 必须在同步路径置 false 并触发 render，不可仅靠 requestAnimationFrame。
 */

import { resolveScopedEntityRuntimeKey, type AppState } from '../state/appState.js';
import {
  type HermesGatewayClient,
  type SessionMessagesOutcome,
  type SessionMessageRecord,
  type CacheChannelRef,
  type CacheService,
  type CachedMessageRow,
  type SessionHandleRegistry,
  type BotActivityRecord,
  type LiveStreamRegistry,
  readSessionHandles,
  extractResumeInflightState,
  resolveLineageChain,
  planOlderBatchPrependMerge,
  planOlderBatchPrependMergeDetailed,
  planOlderPagination,
  countLocalCoveredRows,
  syncActiveSessionToBot,
  reconcileAuthoritativeActivity,
  normalizeWorkspacePath,
  runGuarded,
  sortByDisplayAsc,
} from '@hermes-flux/core';
import type { MessageViewModel } from '@hermes-flux/ui';
import {
  parseTranscriptRows,
} from '../transcriptRows.js';
import {
  hasLegacyUnorderedCacheRows,
  computeHasOlderMessages,
  planOlderZeroMessagesAction,
  shouldTreatOlderDropAsExhausted,
  shouldKeepOlderMessagesAfterLoop,
} from '../messageWindow.js';
import {
  takeServerPriority,
  planSessionLoadMerge,
  extractDurableRowId,
  findLastDurableRowId,
} from '../rollbackTransaction.js';
import {
  toMessageViewModel,
} from '../cache/desktopCacheBridge.js';
import {
  describeRpcError,
} from './sessionOperationService.js';

export const INITIAL_WINDOW_PAGE_SIZE = 50;
export const OLDER_BATCH_PAGE_SIZE = 500;
export const MESSAGE_WINDOW_CAPACITY = 100;
export const INITIAL_RENDER_WINDOW = 30;
export const MESSAGE_CACHE_LIMIT = 500;

export interface MessageLoadingDeps {
  readonly getState: () => AppState;
  readonly getGatewayClient: () => HermesGatewayClient | null;
  readonly getClientForGateway?: (gatewayId?: string) => HermesGatewayClient | null;
  readonly render: () => void;

  readonly sessionMessagesCache: Map<string, MessageViewModel[]>;
  readonly cacheService: CacheService;
  readonly persistMessagesToCache: (channelRef: CacheChannelRef, messages: MessageViewModel[], fenceMax?: number) => void;

  // 提示词导航与视口管理
  readonly syncPromptNavigatorMeta: () => void;
  readonly syncPromptNavigatorFromScroll: () => void;
  readonly scrollStreamToBottom: (reason?: string) => void;
  readonly setPendingScrollToBottom: (val: boolean) => void;
  readonly isStreamNearBottom: (el: HTMLElement | null) => boolean;
  readonly captureStreamAnchor: () => unknown;
  readonly applyStreamAnchor: (anchor: unknown, maintainDistanceToBottom?: boolean) => void;

  // 消息窗口状态
  readonly getMessageWindowStart: () => number;
  readonly setMessageWindowStart: (val: number) => void;
  readonly getMessageWindowEnd: () => number;
  readonly setMessageWindowEnd: (val: number) => void;
  readonly setMessageWindowUserExpanded: (val: boolean) => void;
  readonly setCanvasStructureDirty?: (val: boolean) => void;
  readonly setSuppressPinBottomOnce?: (val: boolean) => void;

  // 会话与房间状态
  readonly isGroupConversationActive: (id: string) => boolean;
  readonly hostedRoomIds: Set<string>;
  readonly formatSessionTime: (timestamp: number) => string;
  readonly formatTimestamp: (ts: number | string) => string;

  // Bot 状态持久化
  readonly botActivityStore: {
    withActivityMap: <T>(fn: (map: Map<string, BotActivityRecord>) => T) => T;
    persist: () => void;
  };
  readonly botForeverChatCache: Map<string, string>;
  readonly sessionPreviewCache: Map<string, { lastActive: number; text: string; botName?: string }>;
  readonly persistSessionPreviewCache: () => void;

  // 流式与代际状态
  readonly getActiveStreamingStoredSessionId: () => string | null;
  readonly getLiveStreamRegistry?: () => LiveStreamRegistry;
  readonly getLiveStreamRegistryForGateway?: (gatewayId?: string) => LiveStreamRegistry | undefined;
  readonly defaultSessionHandleRegistry: SessionHandleRegistry;
  readonly getSessionHandleRegistryForGateway?: (gatewayId?: string) => SessionHandleRegistry;
  readonly activeRunningSessionIds: Set<string>;
  readonly activityTransitionTracker: { clear: (type: 'session' | 'group' | 'bot', id: string) => void };
  readonly getGeneration?: () => number;
  readonly onGenerationIncremented?: (gen: number) => void;

  // 日志记录器
  readonly logSession?: {
    debug: (msg: string, ctx?: unknown) => void;
    info: (msg: string, ctx?: unknown) => void;
    warn: (msg: string, ctx?: unknown) => void;
    error: (msg: string, ctx?: unknown) => void;
  };
  readonly logScroll?: {
    debug: (msg: string, ctx?: unknown) => void;
    info: (msg: string, ctx?: unknown) => void;
    warn: (msg: string, ctx?: unknown) => void;
  };

  // 状态栏与子 Agent 监控协同回调
  readonly onSessionActivated?: (storedSessionId: string, profile?: string) => void;
  readonly onSessionMessagesLoaded?: (storedSessionId: string) => void;
  readonly onLiveSessionReady?: (
    storedSessionId: string,
    liveSessionId: string,
    info?: Record<string, unknown> | null,
    profile?: string,
  ) => void;
  readonly onReconnectStillStreaming?: (
    storedSessionId: string,
    liveSessionId: string,
    resumeResult?: Record<string, unknown>,
    gatewayId?: string,
  ) => void;
  readonly onReconnectStreamFinished?: (storedSessionId: string, gatewayId?: string) => void;
  readonly onActiveTurnDiscovered?: (input: {
    storedSessionId: string;
    liveSessionId: string;
    resumeResult: Record<string, unknown>;
    botName: string | null;
    gatewayId?: string;
  }) => void;
  readonly onForceSyncMessageList?: (force?: boolean) => void;

  // DOM 容器引用（可选）
  readonly getConversationStreamElement?: () => HTMLElement | null;
}

function areMessageListsEquivalent(prev: readonly MessageViewModel[], next: readonly MessageViewModel[]): boolean {
  if (prev.length !== next.length) return false;
  for (let i = 0; i < prev.length; i += 1) {
    const a = prev[i];
    const b = next[i];
    if (
      a.id !== b.id ||
      a.role !== b.role ||
      a.content !== b.content ||
      a.thought !== b.thought ||
      a.rowId !== b.rowId ||
      (a.toolCalls?.length ?? 0) !== (b.toolCalls?.length ?? 0)
    ) {
      return false;
    }
    if (a.toolCalls && b.toolCalls) {
      for (let j = 0; j < a.toolCalls.length; j += 1) {
        if (a.toolCalls[j].id !== b.toolCalls[j].id || a.toolCalls[j].status !== b.toolCalls[j].status) {
          return false;
        }
      }
    }
  }
  return true;
}

export class MessageLoadingService {
  /** 记录各会话已确认的服务端消息下界偏移量 */
  readonly sessionServerOffset = new Map<string, number>();

  /** 记录服务端确认的最少已知总条数 */
  readonly sessionAuthoritativeOffset = new Map<string, number>();

  /** 记录父会话血缘遍历游标 */
  readonly sessionParentOffsetMap = new Map<string, number>();

  /** 记录高估下界标记 */
  readonly sessionOvershootRetry = new Set<string>();

  /** 截断成功后的会话历史权威源标记：'server-priority' 时禁用本地更长保留 */
  readonly sessionHistoryTrust = new Map<string, 'server-priority'>();

  /** 标记会话当前从旧版未带 displaySeq 持久化缓存临时恢复 */
  readonly untrustedOrderCacheSessions = new Set<string>();

  /** 消息拉取代际计数器 */
  private activeLoadMessagesGeneration = 0;

  /** 上一次历史向上漫游请求启动时间戳（用于陈旧超时熔断） */
  private olderLoadingStartedAt = 0;

  private reconnectHooks: {
    onReconnectStillStreaming?: (
      storedSessionId: string,
      liveSessionId: string,
      resumeResult?: Record<string, unknown>,
      gatewayId?: string,
    ) => void;
    onReconnectStreamFinished?: (storedSessionId: string, gatewayId?: string) => void;
    onActiveTurnDiscovered?: (input: {
      storedSessionId: string;
      liveSessionId: string;
      resumeResult: Record<string, unknown>;
      botName: string | null;
      gatewayId?: string;
    }) => void;
    onForceSyncMessageList?: (force?: boolean) => void;
  } = {};

  constructor(private readonly deps: MessageLoadingDeps) {
    this.activeLoadMessagesGeneration = this.deps.getGeneration?.() ?? 0;
  }

  /** 注册断连重连期间的流式对账回调 */
  setReconnectHooks(hooks: {
    onReconnectStillStreaming?: (
      storedSessionId: string,
      liveSessionId: string,
      resumeResult?: Record<string, unknown>,
    ) => void;
    onReconnectStreamFinished?: (storedSessionId: string) => void;
    onActiveTurnDiscovered?: (input: {
      storedSessionId: string;
      liveSessionId: string;
      resumeResult: Record<string, unknown>;
      botName: string | null;
    }) => void;
    onForceSyncMessageList?: (force?: boolean) => void;
  }): void {
    this.reconnectHooks = hooks;
  }

  private resolveTargetClient(gatewayId?: string): HermesGatewayClient | null {
    return this.deps.getClientForGateway
      ? this.deps.getClientForGateway(gatewayId)
      : this.deps.getGatewayClient();
  }

  private scopedKey(sessionId: string, gatewayId?: string): string {
    return resolveScopedEntityRuntimeKey(sessionId, gatewayId, this.deps.getState().gatewayCount);
  }

  private resolveStreamRegistry(gatewayId?: string): LiveStreamRegistry | undefined {
    return this.deps.getLiveStreamRegistryForGateway?.(gatewayId) ?? this.deps.getLiveStreamRegistry?.();
  }

  private resolveHandleRegistry(gatewayId?: string): SessionHandleRegistry {
    return this.deps.getSessionHandleRegistryForGateway?.(gatewayId) ?? this.deps.defaultSessionHandleRegistry;
  }

  private findMatchingSession(
    state: AppState,
    sessionId: string,
    botName?: string,
    gatewayId?: string,
  ): AppState['sessions'][number] | undefined {
    const matchIn = (list: AppState['sessions'] | undefined) =>
      list?.find(
        (s) =>
          s.id === sessionId &&
          (!botName || s.botName === botName) &&
          (!gatewayId || !s.gatewayId || s.gatewayId === gatewayId),
      ) ||
      list?.find((s) => s.id === sessionId && (!gatewayId || !s.gatewayId || s.gatewayId === gatewayId));
    return matchIn(state.sessions) || matchIn(state.archivedSessions);
  }

  private isSessionStreaming(sessionId: string, gatewayId?: string): boolean {
    const state = this.deps.getState();
    const sameFocusGw = !gatewayId || (state.activeFocus?.gatewayId || state.activeGatewayId) === gatewayId;
    return Boolean(
      this.resolveStreamRegistry(gatewayId)?.hasSession(sessionId) ||
      (sameFocusGw && this.deps.getActiveStreamingStoredSessionId() === sessionId),
    );
  }

  private resolveForeverBotName(sessionId: string, gatewayId?: string): string | null {
    const gwPrefix = gatewayId ? `${gatewayId.trim()}:` : '';
    if (gwPrefix) {
      for (const [bKey, foreverId] of this.deps.botForeverChatCache.entries()) {
        if (foreverId === sessionId && bKey.startsWith(gwPrefix)) {
          return bKey.slice(gwPrefix.length);
        }
      }
    }
    for (const [bKey, foreverId] of this.deps.botForeverChatCache.entries()) {
      if (foreverId !== sessionId) continue;
      const sepIdx = bKey.indexOf(':');
      return sepIdx >= 0 ? bKey.slice(sepIdx + 1) : bKey;
    }
    return null;
  }

  /** 获取当前代际计数 */
  getActiveLoadMessagesGeneration(): number {
    return this.activeLoadMessagesGeneration;
  }

  /** 步进代际计数（供外部切会话时主动失效迟滞请求） */
  incrementGeneration(): number {
    const next = ++this.activeLoadMessagesGeneration;
    this.deps.onGenerationIncremented?.(next);
    return next;
  }

  /** 标记会话以服务端权威为准（消费 server-priority） */
  markSessionServerPriority(sessionId: string, gatewayId?: string): void {
    this.sessionHistoryTrust.set(this.scopedKey(sessionId, gatewayId), 'server-priority');
  }

  /** 清理会话游标与高估回退标记 */
  forgetOlderCursorState(sessionId: string, gatewayId?: string): void {
    const scoped = this.scopedKey(sessionId, gatewayId);
    const keys = scoped !== sessionId ? [scoped, sessionId] : [scoped];
    for (const k of keys) {
      this.sessionServerOffset.delete(k);
      this.sessionAuthoritativeOffset.delete(k);
      this.sessionHistoryTrust.delete(k);
      this.untrustedOrderCacheSessions.delete(k);
      const prefix = `${k}:`;
      for (const retryKey of [...this.sessionOvershootRetry]) {
        if (retryKey.startsWith(prefix)) this.sessionOvershootRetry.delete(retryKey);
      }
    }
  }

  /** 同步不可信缓存排序标记 */
  syncUntrustedCacheOrderFlag(sessionId: string, rows: readonly CachedMessageRow[], gatewayId?: string): void {
    const key = this.scopedKey(sessionId, gatewayId);
    if (hasLegacyUnorderedCacheRows(rows)) {
      this.untrustedOrderCacheSessions.add(key);
    } else {
      this.untrustedOrderCacheSessions.delete(key);
    }
  }

  /** 判定当前会话是否仍存在尚未耗尽的父会话血缘段 */
  hasRemainingParentLineage(sessionId: string, gatewayId?: string): boolean {
    if (!sessionId) return false;
    const state = this.deps.getState();
    const key = this.scopedKey(sessionId, gatewayId);
    const parents = resolveLineageChain(sessionId, state.sessions).slice(1);
    return parents.some((id) => this.sessionServerOffset.get(`${key}:${id}:exhausted`) !== 1);
  }

  /** 解析网关原始消息行 */
  parseRawMessages(list: unknown[]): MessageViewModel[] {
    const state = this.deps.getState();
    return parseTranscriptRows(list, {
      scope: {
        isGroupRoom: state.activeFocus.type === 'group',
        isBotRoom: state.activeFocus.type === 'bot',
      },
      formatTimestamp: this.deps.formatTimestamp,
    });
  }

  /** 会话历史加载入口 */
  async loadMessages(sessionId: string, targetBotName?: string, gatewayId?: string): Promise<void> {
    const state = this.deps.getState();
    const targetGw = gatewayId ?? (state.activeFocus?.gatewayId || state.activeGatewayId);
    const cacheKey = sessionId ? resolveScopedEntityRuntimeKey(sessionId, targetGw, state.gatewayCount) : '';
    const cached = cacheKey ? this.deps.sessionMessagesCache.get(cacheKey) : undefined;
    const gatewayClient = this.resolveTargetClient(targetGw);
    /**
     * 【缓存批次不是终态 (Rules)】命中内存缓存只代表「可以立刻上屏」，不代表「权威最新页已到」。
     *   旧实现命中缓存就直接 `ready`，进入计划据此把缓存批次当终态收敛：
     *   REST 最新页随后到达（20 → 50）时计划已死，视口停在旧位置（实测 1400 而非 4200）。
     *   因此只有「无网关的纯离线读缓存」才允许立刻 ready；有网关时必须由
     *   `loadMessagesInner` 结束（REST 已返回或已判定失败）后的 finally 收敛。
     */
    state.messagesPhase = cached && cached.length > 0 && !gatewayClient ? 'ready' : 'loading';
    const expectedGeneration = this.activeLoadMessagesGeneration + 1;
    try {
      await this.loadMessagesInner(sessionId, targetBotName, undefined, targetGw);
    } finally {
      if (!sessionId || expectedGeneration === this.activeLoadMessagesGeneration) {
        state.messagesPhase = 'ready';
        this.deps.render();
      }
    }
  }

  private async callSessionResume(
    gatewayClient: HermesGatewayClient,
    sessionId: string,
    resolvedBotName: string,
    omitMessages: boolean,
  ): Promise<Record<string, unknown> | null> {
    try {
      if (omitMessages) {
        return await gatewayClient.call<Record<string, unknown>>('session.resume', {
          session_id: sessionId,
          profile: resolvedBotName,
          omit_messages: true,
        });
      }
      return await gatewayClient.call<Record<string, unknown>>('session.resume', {
        session_id: sessionId,
        profile: resolvedBotName,
      });
    } catch (firstErr: unknown) {
      if (!describeRpcError(firstErr).includes('Extra inputs')) {
        throw firstErr;
      }
      if (omitMessages) {
        try {
          return await gatewayClient.call<Record<string, unknown>>('session.resume', {
            session_id: sessionId,
            profile: resolvedBotName,
          });
        } catch (secondErr: unknown) {
          if (!describeRpcError(secondErr).includes('Extra inputs')) {
            throw secondErr;
          }
          return await gatewayClient.call<Record<string, unknown>>('session.resume', { session_id: sessionId });
        }
      }
      return await gatewayClient.call<Record<string, unknown>>('session.resume', { session_id: sessionId });
    }
  }

  /** 对当前激活会话发起无破坏静默增量刷新（前台唤醒/重连自愈专用） */
  async refreshActiveSession(opts?: { forceRefreshAfterReconnect?: boolean; checkLiveTurn?: boolean }): Promise<void> {
    const state = this.deps.getState();
    const sessionId = state.activeSessionId;
    if (!sessionId || this.deps.isGroupConversationActive(sessionId)) return;
    const targetGw = state.activeFocus?.gatewayId || state.activeGatewayId;
    const resolvedBotName = state.activeFocus.type === 'bot'
      ? state.activeFocus.botName
      : this.findMatchingSession(state, sessionId, undefined, targetGw)?.botName || state.profileName;
    await this.loadMessagesInner(sessionId, resolvedBotName, {
      silent: true,
      forceRefreshAfterReconnect: opts?.forceRefreshAfterReconnect,
      checkLiveTurn: opts?.checkLiveTurn,
    }, targetGw);
  }

  /** 会话历史加载内核 */
  async loadMessagesInner(
    sessionId: string,
    targetBotName?: string,
    opts?: { silent?: boolean; forceRefreshAfterReconnect?: boolean; checkLiveTurn?: boolean },
    gatewayId?: string,
  ): Promise<void> {
    const state = this.deps.getState();
    const targetGw = gatewayId ?? (state.activeFocus?.gatewayId || state.activeGatewayId);
    const gatewayClient = this.resolveTargetClient(targetGw);
    const cacheService = this.deps.cacheService;
    const silent = Boolean(opts?.silent);
    const forceRefreshAfterReconnect = Boolean(opts?.forceRefreshAfterReconnect);

    // 离线也允许打开会话：历史由持久化缓存提供
    if (!sessionId) {
      if (!silent) {
        state.messages = [];
        state.hasOlderMessages = false;
        this.deps.render();
      }
      return;
    }

    const currentGen = silent ? this.activeLoadMessagesGeneration : this.incrementGeneration();
    const loadStartedAt = performance.now();
    state.activeSessionId = sessionId;
    if (!silent && targetGw) {
      state.activeGatewayId = targetGw;
    }
    const cacheKey = resolveScopedEntityRuntimeKey(sessionId, targetGw, state.gatewayCount);

    // 精准解析当前会话归属的 Profile
    const resolvedBotName = targetBotName
      || this.findMatchingSession(state, sessionId, undefined, targetGw)?.botName
      || (state.activeFocus.type === 'bot' ? state.activeFocus.botName : state.profileName)
      || 'default';

    this.deps.onSessionActivated?.(sessionId, resolvedBotName);

    const cached = silent ? undefined : this.deps.sessionMessagesCache.get(cacheKey);
    if (!silent) {
      // 1. Instant Cache Hit (0ms)
      if (cached && cached.length > 0) {
        state.messages = [...cached];
        this.syncActiveSessionPreviewToRail(sessionId, state.messages, resolvedBotName, targetGw);
        state.hasOlderMessages = computeHasOlderMessages(
          state.messages,
          this.sessionServerOffset.get(cacheKey),
          INITIAL_WINDOW_PAGE_SIZE,
          this.hasRemainingParentLineage(sessionId, targetGw),
        );
        this.deps.render();
        this.deps.logSession?.debug('session rendered from cache', {
          sessionId,
          mounted: state.messages.length,
          ms: Math.round((performance.now() - loadStartedAt) * 10) / 10,
        });
      } else {
        state.messages = [];
        state.hasOlderMessages = false;
        this.deps.render();
      }
    }

    // 2. If this session is currently actively streaming:
    //    - 正常切换保留实时流缓冲区（若因重进清空 activeLiveSessionId 则立即恢复）；
    //    - 断连重连/重检后先调 session.resume 校验网关端是否仍在生成，已收口则清理本地卡死流态并重拉权威历史。
    let streamFinishedOnReconnect = false;
    const streamRegistry = this.resolveStreamRegistry(targetGw);
    const handleRegistry = this.resolveHandleRegistry(targetGw);
    if (this.isSessionStreaming(sessionId, targetGw)) {
      const shouldProbeLive = forceRefreshAfterReconnect || Boolean(opts?.checkLiveTurn);
      if (!shouldProbeLive) {
        const existingStream = streamRegistry?.getBySession(sessionId);
        if (!state.activeLiveSessionId) {
          state.activeLiveSessionId =
            existingStream?.liveSessionId || handleRegistry.toLiveId(sessionId) || sessionId;
        }
        if (existingStream) {
          state.isStreaming = true;
          if (!state.messages.some((m) => m.id === existingStream.messageId)) {
            state.messages = [
              ...state.messages,
              {
                id: existingStream.messageId,
                role: 'assistant',
                content: existingStream.accumulatedText,
                timestamp: this.deps.formatTimestamp(existingStream.startedAt),
              },
            ];
            this.deps.sessionMessagesCache.set(cacheKey, state.messages);
            this.deps.render();
          }
        }
        this.deps.logSession?.info('session is actively streaming, preserving live state', { sessionId });
        return;
      }
      if (!gatewayClient) return;
      try {
        const checkRes = await this.callSessionResume(
          gatewayClient,
          sessionId,
          resolvedBotName,
          Boolean(silent && state.messages.length > 0),
        );
        if (currentGen !== this.activeLoadMessagesGeneration || state.activeSessionId !== sessionId) return;
        const rawCheckInfo = (
          checkRes && typeof checkRes === 'object' && checkRes.info && typeof checkRes.info === 'object'
            ? checkRes.info
            : checkRes
        ) as Record<string, unknown>;
        const checkHandles = readSessionHandles(checkRes, sessionId);
        if (checkHandles) {
          handleRegistry.register(checkHandles);
          state.activeLiveSessionId = checkHandles.liveId;
          this.deps.onLiveSessionReady?.(checkHandles.storedId, checkHandles.liveId, rawCheckInfo, resolvedBotName);
        } else {
          state.activeLiveSessionId = sessionId;
        }
        const checkResumeState = extractResumeInflightState(checkRes);
        if (checkResumeState.isRunning && checkRes) {
          (this.reconnectHooks.onReconnectStillStreaming ?? this.deps.onReconnectStillStreaming)?.(
            sessionId,
            state.activeLiveSessionId,
            checkRes,
            targetGw,
          );
          return;
        }
        (this.reconnectHooks.onReconnectStreamFinished ?? this.deps.onReconnectStreamFinished)?.(sessionId, targetGw);
        streamFinishedOnReconnect = true;
      } catch (err) {
        this.deps.logSession?.debug('reconnect streaming reconciliation failed, preserving live buffer', { err });
        return;
      }
    }

    // 2.5 持久化缓存命中（内存未命中时）：先把历史读出来，再拉最新
    const cacheRef: CacheChannelRef = {
      ...(targetGw ? { gatewayId: targetGw } : {}),
      profile: resolvedBotName,
      channel: 'session',
      channelId: sessionId,
    };
    let cacheFenceMax = 0;
    if (!silent && (!cached || cached.length === 0)) {
      try {
        const opened = await this.deps.cacheService.openChannel(cacheRef, MESSAGE_CACHE_LIMIT);
        cacheFenceMax = opened.fenceMax;
        const stillCurrent = currentGen === this.activeLoadMessagesGeneration && state.activeSessionId === sessionId;
        if (opened.rows.length > 0 && stillCurrent && state.messages.length === 0) {
          this.syncUntrustedCacheOrderFlag(sessionId, opened.rows, targetGw);
          state.messages = sortByDisplayAsc(opened.rows).map(toMessageViewModel);
          this.deps.sessionMessagesCache.set(cacheKey, state.messages);
          this.sessionServerOffset.set(cacheKey, Math.max(
            this.sessionServerOffset.get(cacheKey) || 0,
            countLocalCoveredRows(state.messages, sessionId),
          ));
          state.hasOlderMessages = computeHasOlderMessages(
            state.messages,
            opened.rows.length,
            INITIAL_WINDOW_PAGE_SIZE,
            this.hasRemainingParentLineage(sessionId, targetGw),
          );
          this.deps.render();
          this.deps.logSession?.info('session rendered from persistent cache', {
            sessionId,
            mounted: state.messages.length,
            ms: Math.round((performance.now() - loadStartedAt) * 10) / 10,
          });
        }
      // gate-degrade: 本地缓存读取失败或未命中时平滑回退到远端 REST 拉取
      } catch {}
    }

    // 3. 无网关时到此为止：有缓存就已上屏，没有则保持空态
    if (!gatewayClient) {
      if (!silent) this.deps.render();
      return;
    }

    const dropStaleUncommittedTail = streamFinishedOnReconnect || silent;

    // 4. High-speed REST pagination: 50 items latest-first
    let fastLoaded = false;
    try {
      const outcome = await gatewayClient.fetchSessionMessages(sessionId, {
        limit: INITIAL_WINDOW_PAGE_SIZE,
        order: 'latest',
        profile: resolvedBotName,
        includeCompacted: true,
      });

      if (currentGen !== this.activeLoadMessagesGeneration || state.activeSessionId !== sessionId) {
        this.deps.logSession?.debug('discarded stale REST history due to session switch', { sessionId, currentGen });
        return;
      }

      if (outcome.status === 'success' && outcome.messages.length > 0) {
        const parsed = this.parseRawMessages(outcome.messages);
        const existing = this.deps.sessionMessagesCache.get(cacheKey);
        const sessionHistoryTrust = this.sessionHistoryTrust;
        const serverPriority = takeServerPriority(sessionHistoryTrust, cacheKey);
        const replaceUntrustedCache = this.untrustedOrderCacheSessions.delete(cacheKey);
        if (replaceUntrustedCache) {
          await cacheService.dropChannel(cacheRef);
          if (currentGen !== this.activeLoadMessagesGeneration || state.activeSessionId !== sessionId) return;
          cacheFenceMax = 0;
          this.sessionServerOffset.delete(cacheKey);
        }
        const merged = planSessionLoadMerge(
          parsed,
          existing,
          serverPriority || replaceUntrustedCache,
          { dropStaleUncommittedTail },
        );
        const existingLastDurableRowId =
          existing && existing.length > 0 ? findLastDurableRowId(existing) : undefined;
        const nonContiguousJump =
          !serverPriority &&
          !replaceUntrustedCache &&
          existingLastDurableRowId !== undefined &&
          merged.length === parsed.length &&
          typeof parsed[0]?.rowId === 'number' &&
          parsed[0].rowId! > existingLastDurableRowId + 1;
        this.deps.sessionMessagesCache.set(cacheKey, merged);
        this.deps.persistMessagesToCache(cacheRef, merged, cacheFenceMax);
        this.syncActiveSessionPreviewToRail(sessionId, merged, resolvedBotName, targetGw);
        const serverKnownCount = outcome.pagination?.returned ?? outcome.messages.length;
        this.sessionAuthoritativeOffset.set(
          cacheKey,
          nonContiguousJump
            ? serverKnownCount
            : Math.max(this.sessionAuthoritativeOffset.get(cacheKey) || 0, serverKnownCount),
        );
        if (nonContiguousJump) this.sessionServerOffset.delete(cacheKey);
        const localCoveredRows = countLocalCoveredRows(merged, sessionId);
        const currentKnown = Math.max(
          this.sessionServerOffset.get(cacheKey) || 0,
          serverKnownCount,
          localCoveredRows,
        );
        this.sessionServerOffset.set(cacheKey, currentKnown);
        const messagesChanged = !silent || !areMessageListsEquivalent(state.messages, merged);
        state.messages = merged;
        state.hasOlderMessages = merged.length > serverKnownCount
          ? true
          : computeHasOlderMessages(merged, serverKnownCount, INITIAL_WINDOW_PAGE_SIZE, this.hasRemainingParentLineage(sessionId, targetGw));
        if (!silent || messagesChanged) {
          state.dockNotice = '';
        }
        this.deps.onSessionMessagesLoaded?.(sessionId);
        if (streamFinishedOnReconnect) {
          (this.reconnectHooks.onForceSyncMessageList ?? this.deps.onForceSyncMessageList)?.(true);
        }
        if (!silent || messagesChanged || streamFinishedOnReconnect) {
          this.deps.render();
        }
        fastLoaded = true;

        this.deps.logSession?.info('session loaded via high-speed REST', {
          sessionId,
          returned: outcome.messages.length,
          mounted: parsed.length,
          ms: Math.round((performance.now() - loadStartedAt) * 10) / 10,
        });
      }
    } catch (err) {
      this.deps.logSession?.debug('fast REST load failed, falling back to session.resume', { err });
    }

    // 5. Background asynchronous session.resume for live session activation & handle resolution
    const resumePromise = (async () => {
      const rpcStartedAt = performance.now();
      try {
        const res = await this.callSessionResume(gatewayClient, sessionId, resolvedBotName, fastLoaded);

        if (currentGen !== this.activeLoadMessagesGeneration || state.activeSessionId !== sessionId) {
          return;
        }

        const rawInfo = (
          res && typeof res === 'object' && res.info && typeof res.info === 'object' ? res.info : res
        ) as Record<string, unknown>;
        const activeBeforeResume = this.findMatchingSession(state, sessionId, resolvedBotName, targetGw);
        const prevRecordedCwd = state.sessionCwds?.[cacheKey] || '';
        const prevSessionCwd = activeBeforeResume?.cwd || '';

        const handles = readSessionHandles(res, sessionId);
        if (handles) {
          handleRegistry.register(handles);
          state.activeLiveSessionId = handles.liveId;
          this.deps.onLiveSessionReady?.(handles.storedId, handles.liveId, rawInfo, resolvedBotName);
        } else {
          state.activeLiveSessionId = sessionId;
        }

        const rawResumedCwd = typeof rawInfo.cwd === 'string' ? rawInfo.cwd : typeof rawInfo.path === 'string' ? rawInfo.path : undefined;
        const resumedCwd = rawResumedCwd ? normalizeWorkspacePath(rawResumedCwd) : undefined;
        const resumedProjId = typeof rawInfo.project_id === 'string' ? rawInfo.project_id : typeof rawInfo.projectId === 'string' ? rawInfo.projectId : undefined;
        const resumedProjName = typeof rawInfo.project_name === 'string' ? rawInfo.project_name : typeof rawInfo.projectName === 'string' ? rawInfo.projectName : undefined;

        let changed = Boolean(
          resumedCwd && (prevRecordedCwd !== resumedCwd || prevSessionCwd !== resumedCwd),
        );
        if (resumedCwd && state.sessionCwds?.[cacheKey] !== resumedCwd) {
          state.sessionCwds = { ...(state.sessionCwds ?? {}), [cacheKey]: resumedCwd };
          changed = true;
        }
        const currentActive = this.findMatchingSession(state, sessionId, resolvedBotName, targetGw);
        if (currentActive) {
          if (resumedCwd && currentActive.cwd !== resumedCwd) {
            currentActive.cwd = resumedCwd;
            changed = true;
          }
          if (resumedProjId && !currentActive.projectId) {
            currentActive.projectId = resumedProjId;
            changed = true;
          }
          if (resumedProjName && !currentActive.projectName) {
            currentActive.projectName = resumedProjName;
            changed = true;
          }
        }
        if (changed) {
          this.deps.render();
        }

        if (!fastLoaded) {
          const list = Array.isArray(res?.messages) ? res.messages : Array.isArray(res?.history) ? res.history : [];
          if (list.length > 0) {
            const parsed = this.parseRawMessages(list);
            const existing = this.deps.sessionMessagesCache.get(cacheKey);
            const sessionHistoryTrust = this.sessionHistoryTrust;
            const wsServerPriority = takeServerPriority(sessionHistoryTrust, cacheKey);
            const replaceUntrustedCache = this.untrustedOrderCacheSessions.delete(cacheKey);
            if (replaceUntrustedCache) {
              await cacheService.dropChannel(cacheRef);
              if (currentGen !== this.activeLoadMessagesGeneration || state.activeSessionId !== sessionId) return;
              cacheFenceMax = 0;
              this.sessionServerOffset.delete(cacheKey);
            }
            const merged = planSessionLoadMerge(parsed, existing, wsServerPriority || replaceUntrustedCache);
            this.deps.sessionMessagesCache.set(cacheKey, merged);
            this.deps.persistMessagesToCache(cacheRef, merged, cacheFenceMax);
            this.syncActiveSessionPreviewToRail(sessionId, merged, resolvedBotName, targetGw);
            state.messages = merged;
            this.deps.onSessionMessagesLoaded?.(sessionId);
            this.sessionAuthoritativeOffset.set(
              cacheKey,
              Math.max(this.sessionAuthoritativeOffset.get(cacheKey) || 0, parsed.length),
            );
            this.sessionServerOffset.set(cacheKey, Math.max(
              this.sessionServerOffset.get(cacheKey) || 0,
              merged.length,
              countLocalCoveredRows(merged, sessionId),
            ));
            state.hasOlderMessages = computeHasOlderMessages(
              merged,
              merged.length,
              INITIAL_WINDOW_PAGE_SIZE,
              this.hasRemainingParentLineage(sessionId, targetGw),
            );
            this.deps.render();
          } else {
            const existing = this.deps.sessionMessagesCache.get(cacheKey);
            const sessionHistoryTrust = this.sessionHistoryTrust;
            takeServerPriority(sessionHistoryTrust, cacheKey);
            if (existing && existing.length > 0) {
              state.messages = [...existing];
              this.deps.render();
            }
          }
        }

        if (res && typeof res === 'object') {
          const resumeState = extractResumeInflightState(res);
          const reconciled = reconcileAuthoritativeActivity({
            runningIds: this.deps.activeRunningSessionIds,
            entityId: cacheKey,
            isGatewayRunning: Boolean(res.running),
            hasInflightStreaming: resumeState.isRunning,
            currentStreamingId: this.isSessionStreaming(sessionId, targetGw) ? cacheKey : this.deps.getActiveStreamingStoredSessionId(),
          });
          if (reconciled) {
            this.deps.activityTransitionTracker.clear('session', cacheKey);
            this.deps.logSession?.info('reconciled orphan running state via authoritative gateway status', { sessionId });
            this.deps.render();
          }
          if (resumeState.isRunning) {
            this.deps.activeRunningSessionIds.add(cacheKey);
            const activeHook = this.reconnectHooks.onActiveTurnDiscovered ?? this.deps.onActiveTurnDiscovered;
            activeHook?.({
              storedSessionId: sessionId,
              liveSessionId: state.activeLiveSessionId || sessionId,
              resumeResult: res,
              botName: this.resolveForeverBotName(sessionId, targetGw),
              gatewayId: targetGw,
            });
          }
        }

        this.deps.logSession?.debug('background session.resume activated', {
          sessionId,
          liveId: state.activeLiveSessionId,
          ms: Math.round((performance.now() - rpcStartedAt) * 10) / 10,
        });
      } catch (e) {
        if (!fastLoaded && currentGen === this.activeLoadMessagesGeneration && state.activeSessionId === sessionId) {
          console.warn('[Hermes Gateway] Failed to load messages via RPC fallback:', e);
          const errText = describeRpcError(e);
          state.messages = [];
          state.dockNotice = `Load session history failed: ${errText}`;
          this.deps.render();
        }
      }
    })();

    if (!fastLoaded) {
      await resumePromise;
    }
  }

  /** 向上翻页加载更早的历史记录 */
  async loadOlderMessages(options?: { preserveViewportWindow?: boolean }): Promise<void> {
    const state = this.deps.getState();
    const targetGw = state.activeFocus?.gatewayId || state.activeGatewayId;
    const gatewayClient = this.resolveTargetClient(targetGw);
    const sessionId = state.activeSessionId;
    if (!sessionId || !gatewayClient) return;
    const cacheKey = resolveScopedEntityRuntimeKey(sessionId, targetGw, state.gatewayCount);

    if (state.isLoadingOlder) {
      if (performance.now() - this.olderLoadingStartedAt > 20000) {
        state.isLoadingOlder = false;
        this.deps.syncPromptNavigatorMeta();
      } else {
        return;
      }
    }

    if (this.deps.hostedRoomIds.has(sessionId) || this.deps.isGroupConversationActive(sessionId)) {
      state.isLoadingOlder = false;
      this.deps.syncPromptNavigatorMeta();
      return;
    }

    const resolvedProfile = this.findMatchingSession(state, sessionId, undefined, targetGw)?.botName
      || (state.activeFocus.type === 'bot' ? state.activeFocus.botName : state.profileName)
      || 'default';

    const guard = { sessionId, generation: this.activeLoadMessagesGeneration };
    const preserveViewportWindow = Boolean(options?.preserveViewportWindow);
    const streamEl = this.deps.getConversationStreamElement
      ? this.deps.getConversationStreamElement()
      : (typeof document !== 'undefined' ? document.getElementById('conversation-stream') : null);
    const wasNearBottomBeforeLoad = this.deps.isStreamNearBottom(streamEl);
    const render = (): void => this.deps.render();

    state.isLoadingOlder = true;
    this.olderLoadingStartedAt = performance.now();
    this.deps.syncPromptNavigatorMeta();
    const startedAt = performance.now();
    const anchor = this.deps.captureStreamAnchor();
    let fetchFailed = false;

    const sessionEarliestRowId = (): number | null => {
      for (const m of state.messages) {
        if (typeof m.rowId !== 'number' || m.rowId <= 0) continue;
        if (m.sessionId && m.sessionId !== sessionId) continue;
        return m.rowId;
      }
      return null;
    };

    const lineageChain = resolveLineageChain(sessionId, state.sessions);

    try {
      let batchAppended = false;

      // 0. 本地持久化缓存优先
      const oldestRowId = sessionEarliestRowId();
      if (typeof oldestRowId === 'number' && oldestRowId > 1) {
        try {
          const cacheRef: CacheChannelRef = {
            ...(targetGw ? { gatewayId: targetGw } : {}),
            profile: resolvedProfile,
            channel: 'session',
            channelId: sessionId,
          };
          const localOlderRows = await this.deps.cacheService.readOlderRows(cacheRef, oldestRowId, 100);
          if (localOlderRows.length > 0) {
            const cachedBatch = sortByDisplayAsc(localOlderRows).map(toMessageViewModel);
            const before = state.messages.length;
            state.messages = planOlderBatchPrependMerge(cachedBatch, state.messages, { timelineSessionId: sessionId, fallbackSessionId: sessionId });
            const added = state.messages.length - before;
            if (added > 0) {
              // 【纯原生流全量窗口 (Why)】messageWindowManager 已收敛为 [0, total] 全量挂载，
              //   若此处仍按 100 条截断 windowEnd，会导致 getMessageWindowEnd() < state.messages.length
              //   恒成立，滑回底部也无法清除 readerScrolledSessionId。
              if (!preserveViewportWindow || !wasNearBottomBeforeLoad) {
                this.deps.setMessageWindowUserExpanded(true);
              }
              this.deps.setMessageWindowStart(0);
              this.deps.setMessageWindowEnd(state.messages.length);
              this.deps.sessionMessagesCache.set(cacheKey, state.messages);
              state.hasOlderMessages = true;
              batchAppended = true;
            }
          }
        // gate-degrade: 本地缓存读取失败或未命中时平滑回退到远端 REST 拉取
        } catch {}
      }

      let attempts = 0;
      const MAX_PAGE_ATTEMPTS = 8;

      for (const targetId of lineageChain) {
        if (batchAppended || attempts >= MAX_PAGE_ATTEMPTS) break;

        const cursorKey = `${cacheKey}:${targetId}`;
        if (this.sessionServerOffset.get(`${cursorKey}:exhausted`) === 1) continue;

        while (attempts < MAX_PAGE_ATTEMPTS) {
          attempts += 1;

          const storedOffset = this.sessionParentOffsetMap.get(cursorKey)
            ?? (targetId === sessionId ? (this.sessionServerOffset.get(cacheKey) ?? 0) : 0);

          const earliestLocalRowId = targetId === sessionId ? sessionEarliestRowId() : null;
          const floorSuppressed = this.sessionOvershootRetry.has(cursorKey);
          const { queryOffset } = planOlderPagination({
            storedOffset,
            localCoveredRows: targetId === sessionId && !floorSuppressed
              ? countLocalCoveredRows(state.messages, sessionId)
              : 0,
            returned: 0,
            batchRowIds: [],
            earliestLocalRowId,
          });

          const guarded = await runGuarded<SessionMessagesOutcome>(
            guard,
            () => ({ sessionId: state.activeSessionId, generation: this.activeLoadMessagesGeneration }),
            () => undefined,
            () => gatewayClient.fetchSessionMessages(targetId, {
              limit: OLDER_BATCH_PAGE_SIZE,
              offset: queryOffset,
              order: 'latest',
              profile: resolvedProfile,
              includeCompacted: true,
            }),
            this.deps.logSession,
          );
          if (guarded.status === 'discarded') {
            state.isLoadingOlder = false;
            this.deps.syncPromptNavigatorMeta();
            return;
          }
          const outcome = guarded.value;

          if (outcome.status !== 'success') {
            fetchFailed = true;
            break;
          }
          if (outcome.messages.length === 0) {
            const zeroPlan = planOlderZeroMessagesAction({
              isTargetSelf: targetId === sessionId,
              floorSuppressed,
              queryOffset,
              safeFallbackOffset: this.sessionAuthoritativeOffset.get(cacheKey) ?? 0,
            });
            if (zeroPlan.action === 'retry-fallback') {
              this.sessionOvershootRetry.add(cursorKey);
              this.sessionParentOffsetMap.delete(cursorKey);
              this.sessionServerOffset.set(cacheKey, zeroPlan.fallbackOffset);
              continue;
            }
            this.sessionServerOffset.set(`${cursorKey}:exhausted`, 1);
            break;
          }

          const returned = outcome.pagination?.returned ?? outcome.messages.length;

          const payload = outcome.messages.filter((m: SessionMessageRecord) => {
            if (typeof m.display_kind === 'string' && m.display_kind.length > 0) return true;
            const text = typeof m.content === 'string' ? m.content : '';
            return !text.startsWith('[CONTEXT COMPACTION');
          });
          const batch = this.parseRawMessages(payload);

          const before = state.messages.length;
          const mergeResult = planOlderBatchPrependMergeDetailed(batch, state.messages, {
            timelineSessionId: targetId,
            fallbackSessionId: sessionId,
          });
          const added = mergeResult.merged.length - before;

          if (shouldTreatOlderDropAsExhausted(added, batch.length, mergeResult.droppedCount)) {
            this.deps.logSession?.warn('older batch fully dropped by earlier-boundary filter', {
              sessionId,
              targetId,
              queryOffset,
              returned,
              dropped: mergeResult.droppedCount,
            });
            this.sessionServerOffset.set(`${cursorKey}:exhausted`, 1);
            break;
          }

          const batchRowIds = outcome.messages
            .map((m: SessionMessageRecord) => extractDurableRowId(m))
            .filter((id: unknown): id is number => typeof id === 'number');
          const cursorPlan = planOlderPagination({
            storedOffset: queryOffset,
            localCoveredRows: 0,
            returned,
            batchRowIds,
            earliestLocalRowId: targetId === sessionId ? earliestLocalRowId : null,
          });
          this.sessionParentOffsetMap.set(cursorKey, cursorPlan.nextOffset);
          if (targetId === sessionId) {
            this.sessionServerOffset.set(cacheKey, cursorPlan.nextOffset);
            this.sessionAuthoritativeOffset.set(
              cacheKey,
              Math.max(this.sessionAuthoritativeOffset.get(cacheKey) || 0, cursorPlan.nextOffset),
            );
          }

          state.messages = mergeResult.merged;

          if (added <= 0) {
            if (returned < OLDER_BATCH_PAGE_SIZE) {
              this.sessionServerOffset.set(`${cursorKey}:exhausted`, 1);
              break;
            }
            continue;
          }

          // 【纯原生流全量窗口 (Why)】保持 [0, state.messages.length] 全量窗口，与 messageWindowManager 对齐
          if (!preserveViewportWindow || !wasNearBottomBeforeLoad) {
            this.deps.setMessageWindowUserExpanded(true);
          }
          this.deps.setMessageWindowStart(0);
          this.deps.setMessageWindowEnd(state.messages.length);
          this.deps.sessionMessagesCache.set(cacheKey, state.messages);

          if (targetId === sessionId) {
            const ownMessages = state.messages.filter((m) => !m.sessionId || m.sessionId === sessionId);
            this.deps.persistMessagesToCache(
              { ...(targetGw ? { gatewayId: targetGw } : {}), profile: resolvedProfile, channel: 'session', channelId: sessionId },
              ownMessages.slice(-MESSAGE_CACHE_LIMIT),
              0,
            );
          }

          if (returned < OLDER_BATCH_PAGE_SIZE) {
            this.sessionServerOffset.set(`${cursorKey}:exhausted`, 1);
          }
          const remainingUnexhausted = lineageChain.some(
            (id) => this.sessionServerOffset.get(`${cacheKey}:${id}:exhausted`) !== 1,
          );
          state.hasOlderMessages = returned >= OLDER_BATCH_PAGE_SIZE || remainingUnexhausted;
          batchAppended = true;
          break;
        }
      }

      if (batchAppended) {
        if (preserveViewportWindow) {
          this.deps.setCanvasStructureDirty?.(true);
          if (!wasNearBottomBeforeLoad) {
            this.deps.setSuppressPinBottomOnce?.(true);
          }
        }
        state.isLoadingOlder = false;
        render();
        this.deps.syncPromptNavigatorMeta();
        const reapplyAnchor = preserveViewportWindow && wasNearBottomBeforeLoad
          ? (): void => this.deps.applyStreamAnchor(anchor, true)
          : (): void => this.deps.applyStreamAnchor(anchor, false);
        reapplyAnchor();
        this.deps.syncPromptNavigatorFromScroll();
        if (typeof requestAnimationFrame !== 'undefined') {
          requestAnimationFrame(() => {
            reapplyAnchor();
            this.deps.syncPromptNavigatorFromScroll();
            requestAnimationFrame(reapplyAnchor);
          });
        }
        this.deps.logScroll?.debug('older batch prepended via element anchor', {
          totalLoaded: state.messages.length,
          ms: Math.round((performance.now() - startedAt) * 10) / 10,
        });
        return;
      }
    } catch (err) {
      console.warn('[Flux] loadOlderMessages failed:', err);
      fetchFailed = true;
    }

    const anyLineageRemaining = lineageChain.some(
      (id) => this.sessionServerOffset.get(`${cacheKey}:${id}:exhausted`) !== 1,
    );
    if (!shouldKeepOlderMessagesAfterLoop({ fetchFailed, anyLineageRemaining })) {
      state.hasOlderMessages = false;
    }
    state.isLoadingOlder = false;
    this.deps.render();
    this.deps.syncPromptNavigatorMeta();
  }

  /** 将当前活动会话的最新真实消息与时间反哺给左侧栏对应的卡片实体 */
  syncActiveSessionPreviewToRail(sessionId: string, messages: MessageViewModel[], botName?: string, gatewayId?: string): void {
    if (!sessionId || messages.length === 0) return;
    const state = this.deps.getState();
    const targetGw = gatewayId ?? (state.activeFocus?.gatewayId || state.activeGatewayId);
    const cacheKey = this.scopedKey(sessionId, targetGw);

    const visibleMessages = messages.filter((m) => (m.displayKind ?? 'user') === 'user');
    if (visibleMessages.length === 0) return;

    // 1. 若当前会话为专职 Bot 的 Forever Chat，委托 core 领域逻辑更新
    const botRes = this.deps.botActivityStore.withActivityMap((activityMap) => syncActiveSessionToBot({
      sessionId,
      messages: visibleMessages,
      foreverChatCache: this.deps.botForeverChatCache,
      activeFocusBotName: state.activeFocus.type === 'bot' ? state.activeFocus.botName : undefined,
      profiles: state.profiles,
      activityMap,
      formatTime: this.deps.formatSessionTime,
      gatewayId: targetGw,
    }));
    if (botRes) {
      state.profiles = botRes.profiles;
      this.deps.botActivityStore.persist();
    }

    // 2. 若为普通会话，更新该普通会话的预览与时间戳
    const sess =
      state.sessions.find((s) => s.id === sessionId && (!botName || s.botName === botName) && (!targetGw || !s.gatewayId || s.gatewayId === targetGw))
      || state.sessions.find((s) => s.id === sessionId && (!targetGw || !s.gatewayId || s.gatewayId === targetGw))
      || state.sessions.find((s) => s.id === sessionId);
    if (sess) {
      const lastMsg = visibleMessages[visibleMessages.length - 1];
      const lastText = (lastMsg.content || lastMsg.thought || '').slice(0, 100).replace(/\s+/g, ' ').trim();
      const rawTs = lastMsg.rawTimestamp ?? Date.now();
      if (lastText) {
        sess.preview = lastText;
        sess.timestamp = rawTs;
        sess.time = this.deps.formatSessionTime(rawTs);
        this.deps.sessionPreviewCache.set(cacheKey, {
          lastActive: rawTs,
          text: lastText,
          botName: sess.botName,
        });
        this.deps.persistSessionPreviewCache();
      }
    }
  }
}

export function createMessageLoadingService(deps: MessageLoadingDeps): MessageLoadingService {
  return new MessageLoadingService(deps);
}
