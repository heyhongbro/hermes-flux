/**
 * Hermes Flux 回合执行与队列控制服务（Turn Execution Service · D5）
 *
 * 【设计意图 (Why)】
 *   将消息发送路由分派（单聊、群聊、@提及外援/BTW、斜杠命令）、待发送队列提交与处理、
 *   回合超时看门狗定时器、多模态图片附件 Base64 挂载、回合用户主动中断与在场终态指示器管理
 *   从 index.ts 中彻底解耦。
 *   使得核心回合执行逻辑具备独立的生命周期管理与单向依赖注入纯度，可脱离 DOM 与全量工作台独立测试。
 *
 * 【防范的历史坑 (Pitfall)】
 *   1. 看门狗解除锁定后必须清空 turnStartedAt 与 turnStartedSessionId，否则在场指示器会携带超时的旧锚点算出虚高语气；
 *   2. 终态指示器写入前必须先清旧定时器；到期回调使用引用比较，避免并发或连续终态被提前抹掉；
 *   3. interruptTurn 必须向网关发送 session.interrupt，同时乐观清理客户端流式与超时定时器；
 *   4. sendGroupMessage 必须调用 groupRoomStore.sendMessage (groups.send)，严禁走 prompt.submit 触发 4001 session not found；
 *   5. sendMessage 中若挂起回滚提交失败，必须原子恢复 armedSnapshotForRestore，绝不让用户草稿与历史丢失。
 *
 * 【约束与规则 (Rules)】
 *   1. 严格单向依赖：严禁反向 import index.js，所有状态读写与宿主副作用一律经由 TurnExecutionDeps 注入；
 *   2. 严格类型约束：0 TS 报错，严禁使用 as any；
 *   3. 零文本写死：所有面向用户的提示与错误通知均经由 deps.t 国际化输出。
 */

import type { AppState } from '../state/appState.js';
import {
  type HermesGatewayClient,
  type IRpcCaller,
  type InteractiveService,
  type CacheService,
  type CacheChannelRef,
  type GroupRoomStore,
  type GroupMessageEntry,
  type ActivityTransitionTracker,
  type TokenCoalescer,
  type SessionHandleRegistry,
  type HandoffService,
  type AttachedImageResult,
  type FileAttachResult,
  type PromptSubmitResult,
  type LiveStreamRegistry,
  type WatchdogTimeoutReason,
  extractMessageAttachments,
  formatAttachmentPromptText,
  extractResumeInflightState,
  decideWatchdogProbeAction,
  GroupLogPollerManager,
  deriveSessionKind,
  planSendRoute,
  captureGroupLogBaseline,
  applyTurnStarted,
  applyTurnFailed,
  settleTurnTermination,
  resolveCutIndexByAnchor,
  SlidingActiveWatchdog,
} from '@hermes-flux/core';
import type { I18nKey, MessageViewModel } from '@hermes-flux/ui';
import type { SessionDraftStore } from '../persistence/sessionDrafts.js';
import type { BotActivityStore } from '../persistence/botActivityStore.js';

export function describeRpcError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object') {
    if ('message' in error && typeof error.message === 'string') return error.message;
    if ('code' in error && typeof error.code === 'number') return `RPC error ${error.code}`;
  }
  return String(error);
}

function padZero(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function formatClockTime(d: Date, withSeconds = false): string {
  const hh = padZero(d.getHours());
  const mm = padZero(d.getMinutes());
  if (!withSeconds) return `${hh}:${mm}`;
  const ss = padZero(d.getSeconds());
  return `${hh}:${mm}:${ss}`;
}

export function formatTimestamp(ts: number | string, now: Date = new Date()): string {
  if (!ts) return '';
  const date = typeof ts === 'number'
    ? new Date(ts > 1e11 ? ts : ts * 1000)
    : new Date(ts);
  if (Number.isNaN(date.getTime())) return '';
  const isToday =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  const timeStr = formatClockTime(date, false);
  return isToday ? timeStr : `${date.getMonth() + 1}/${date.getDate()} ${timeStr}`;
}

export interface ActiveStreamingContext {
  activeStreamingMessageId: string | null;
  activeStreamingStoredSessionId: string | null;
  activeStreamingLiveId: string | null;
  activeStreamingBotName: string | null;
}

export type TurnWatchdogTimeoutMs = number;

export interface TurnExecutionDeps {
  readonly getState: () => AppState;
  readonly getGatewayClient: () => HermesGatewayClient | null;
  readonly getRpcCaller: () => IRpcCaller;
  readonly getInteractiveService: () => InteractiveService;
  readonly getCacheService: () => CacheService;
  readonly getGroupRoomStore: () => GroupRoomStore;
  readonly getActivityTransitionTracker: () => ActivityTransitionTracker;
  readonly getTokenCoalescer: () => TokenCoalescer;
  readonly getSessionHandleRegistry: () => SessionHandleRegistry;
  readonly getSessionMessagesCache: () => Map<string, MessageViewModel[]>;
  readonly getSessionDrafts: () => SessionDraftStore;
  readonly getBotActivityStore: () => BotActivityStore;
  readonly getHandoffService: () => HandoffService;
  readonly completeEntityTurn: (
    domain: 'session' | 'bot' | 'group',
    running: Set<string>,
    unread: Set<string>,
    entityId: string,
    focused: boolean
  ) => void;

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
  readonly getLiveStreamRegistry?: () => LiveStreamRegistry;
  readonly resolveBotNameForSession?: (storedSessionId: string) => string | null;
  readonly onWatchdogTurnStillRunning?: (storedSessionId: string, resumeResult: Record<string, unknown>) => void;
  readonly onWatchdogTurnCompleted?: (storedSessionId: string) => Promise<void> | void;
  readonly onQueuedSubmitRace?: (storedSessionId: string) => Promise<void> | void;
  readonly watchdogHardLimitMs?: number;

  readonly getSessionHistoryTrust: () => Map<string, 'server-priority' | 'client-priority'>;
  readonly forgetOlderCursorState: (sessionId: string) => void;
  readonly createNewSession: () => Promise<void>;
  readonly ensureLiveSessionId: () => Promise<string | null>;
  readonly setMessageContent: (messageId: string, content: string) => void;
  readonly syncActiveGroupSpeakerFromMessages: () => void;
  readonly resolveAgentAvatar: (nameOrDisplayName?: string) => string;
  readonly scrollStreamToBottom: (reason: string) => void;
  readonly setPendingScrollToBottom: (val: boolean) => void;
  readonly isStreamNearBottom?: () => boolean;
  readonly clearToolPatchQueue?: () => void;
  readonly stopRunningToolTimers?: () => void;

  readonly runSlashCommand: (command: string) => Promise<void>;
  readonly enqueueDraft: () => Promise<void>;
  readonly handleQueueAction: (action: string, admissionId: string) => Promise<void>;

  readonly setMessageWindowUserExpanded?: (val: boolean) => void;
  readonly ensureMessageWindow?: (total: number) => void;

  readonly render: () => void;
  readonly t: (key: I18nKey, params?: Record<string, string | number>) => string;
  readonly logStream?: {
    info?: (msg: string, meta?: Record<string, unknown>) => void;
    warn?: (msg: string, meta?: Record<string, unknown>) => void;
    error?: (msg: string, meta?: Record<string, unknown>) => void;
  };
  watchdogIdleTimeoutMs?: TurnWatchdogTimeoutMs;
  readonly onBeforeSendEntity?: (kind: 'session' | 'group', id: string, profile?: string) => void;
}

export type TurnExecutionWatchdogFeeder = () => void;

export interface TurnExecutionService {
  armTurnWatchdog(): void;
  feedTurnWatchdog: TurnExecutionWatchdogFeeder;
  disarmTurnWatchdog(force?: boolean): void;
  isStreamingActiveForCurrentSession(): boolean;
  clearPresenceTerminal(): void;
  armPresenceTerminal(terminal: NonNullable<AppState['presenceTerminal']>): void;
  setTimedDockNotice(msg: string, durationMs?: number, options?: { skipRender?: boolean }): void;
  clearTimedDockNotice(options?: { skipRender?: boolean }): void;
  interruptTurn(): Promise<void>;
  sendGroupMessage(roomId: string, text: string): Promise<void>;
  syncGroupRoomLogsToState(roomId: string, logs: readonly GroupMessageEntry[]): void;
  refreshGroupRoomLog(roomId: string): Promise<number>;
  resetActiveGroupThread(): void;
  getGroupPollerManager(): GroupLogPollerManager<GroupMessageEntry>;
  sendMessage(text: string): Promise<void>;
  routeSend(text: string): Promise<void>;
  enqueueDraft(): Promise<void>;
  handleQueueAction(action: string, admissionId: string): Promise<void>;
  askSideAgent(kind: 'btw' | 'delegation', targetProfile: string, question: string): Promise<void>;
  armCapsuleTimers(taskId: string): void;
}

function safeUnref(timer: unknown): void {
  if (timer && typeof (timer as { unref?: () => void }).unref === 'function') {
    (timer as { unref: () => void }).unref();
  }
}

export function createTurnExecutionService(deps: TurnExecutionDeps): TurnExecutionService {
  const PRESENCE_TERMINAL_TTL_MS = 8_000;
  const GROUP_THREAD_GAP_MS = 15 * 60 * 1000;

  let presenceTerminalTimer: ReturnType<typeof setTimeout> | null = null;
  let dockNoticeDismissTimer: ReturnType<typeof setTimeout> | null = null;

  let activeGroupThreadId: string | null = null;
  let activeGroupThreadAt = 0;
  let nextTurnSeq = 0;
  const sessionTurnOwner = new Map<string, string>();
  const botTurnOwner = new Map<string, string>();

  const releaseTurnOwnership = (
    msgId: string | null | undefined,
    sessionId: string | null | undefined,
    botName: string | null | undefined,
  ): void => {
    if (!msgId) return;
    if (sessionId && sessionTurnOwner.get(sessionId) === msgId) {
      sessionTurnOwner.delete(sessionId);
    }
    if (botName && botTurnOwner.get(botName) === msgId) {
      botTurnOwner.delete(botName);
    }
  };

  // 【动态滑动看门狗】双层时序 + 权威探活续期：空闲静默先询问网关是否仍在运行，避免长耗时工具/深思考误杀
  let watchdogProbeGeneration = 0;
  let consecutiveProbeFailures = 0;

  function settleWatchdogTimeout(targetSessionOverride?: string | null): void {
    const state = deps.getState();
    const ctx = deps.getActiveStreamingContext();
    const streamRegistry = deps.getLiveStreamRegistry?.();
    const timedOutSessionId = targetSessionOverride ?? ctx.activeStreamingStoredSessionId;
    const streamEntry = timedOutSessionId ? streamRegistry?.getBySession(timedOutSessionId) : undefined;
    const timedOutBotName =
      streamEntry?.botName ??
      (ctx.activeStreamingStoredSessionId === timedOutSessionId ? ctx.activeStreamingBotName : null) ??
      (timedOutSessionId ? (deps.resolveBotNameForSession?.(timedOutSessionId) ?? null) : null);

    // 【贴底意图必须在 flush 改写 DOM 前捕获 (Why)】避免 flush 撑高容器后误判为非贴底，
    // 导致超时收口 render 把视口锁回上方。
    const wasNearBottomBeforeTimeout = deps.isStreamNearBottom?.() ?? false;
    deps.getTokenCoalescer().flush();
    deps.clearToolPatchQueue?.();
    deps.stopRunningToolTimers?.();
    if (timedOutSessionId && timedOutSessionId === state.activeSessionId && wasNearBottomBeforeTimeout) {
      deps.setPendingScrollToBottom(true);
    }
    settleTurnTermination({
      runningSessionIds: deps.getActiveRunningSessionIds(),
      runningBotNames: deps.getActiveRunningBotNames(),
      sessionId: timedOutSessionId,
      botName: timedOutBotName,
    });
    const timedOutMsgId =
      streamEntry?.messageId ??
      (!timedOutSessionId || timedOutSessionId === ctx.activeStreamingStoredSessionId ? ctx.activeStreamingMessageId : null);
    releaseTurnOwnership(timedOutMsgId, timedOutSessionId, timedOutBotName);
    if (timedOutSessionId) {
      streamRegistry?.removeSession(timedOutSessionId);
    }
    const tracker = deps.getActivityTransitionTracker();
    if (timedOutSessionId) tracker.clear('session', timedOutSessionId);
    if (timedOutBotName) tracker.clear('bot', timedOutBotName);

    const remainingStreams = streamRegistry?.listSessionIds() ?? [];
    if (!timedOutSessionId || timedOutSessionId === ctx.activeStreamingStoredSessionId) {
      deps.setActiveStreamingContext({
        activeStreamingMessageId: null,
        activeStreamingStoredSessionId: null,
        activeStreamingLiveId: null,
        activeStreamingBotName: null,
      });
    }
    const isFocusedTimeout = !timedOutSessionId
      ? state.activeFocus.type !== 'group'
      : timedOutSessionId === state.activeSessionId ||
        (!streamRegistry && timedOutSessionId === ctx.activeStreamingStoredSessionId && state.activeFocus.type !== 'group');
    if (isFocusedTimeout && (remainingStreams.length === 0 || !streamRegistry?.hasSession(state.activeSessionId))) {
      state.isStreaming = false;
      // 【在场指示器】看门狗解除锁定后回合已不在运行：时长锚点必须一并清空，
      // 否则指示器会拿着一个早已超时的锚点算出虚高的语气档。
      state.turnStartedAt = undefined;
      deps.setTurnStartedSessionId(null);
      state.dockNotice = deps.t('chat.watchdogTimeoutNotice');
    }
    deps.render();
    if (remainingStreams.length > 0) {
      slidingWatchdog.arm();
    }
  }

  async function callSessionResumeForProbe(
    client: NonNullable<ReturnType<TurnExecutionDeps['getGatewayClient']>>,
    storedSessionId: string,
    profile: string,
  ): Promise<Record<string, unknown>> {
    try {
      return await client.call<Record<string, unknown>>('session.resume', {
        session_id: storedSessionId,
        profile,
        omit_messages: true,
      });
    } catch (firstErr: unknown) {
      if (!describeRpcError(firstErr).includes('Extra inputs')) {
        throw firstErr;
      }
      try {
        return await client.call<Record<string, unknown>>('session.resume', {
          session_id: storedSessionId,
          profile,
        });
      } catch (secondErr: unknown) {
        if (!describeRpcError(secondErr).includes('Extra inputs')) {
          throw secondErr;
        }
        return await client.call<Record<string, unknown>>('session.resume', {
          session_id: storedSessionId,
        });
      }
    }
  }

  async function probeWatchdogAuthority(probeGen: number, targetStoredId: string): Promise<void> {
    const client = deps.getGatewayClient();
    const state = deps.getState();
    const streamBotName = deps.getLiveStreamRegistry?.().getBySession(targetStoredId)?.botName;
    const resolvedProfile =
      streamBotName ||
      (state.activeFocus.type === 'bot' && state.activeSessionId === targetStoredId
        ? state.activeFocus.botName
        : state.sessions.find((s) => s.id === targetStoredId)?.botName) ||
      deps.resolveBotNameForSession?.(targetStoredId) ||
      state.profileName ||
      'default';

    let resumeRes: Record<string, unknown> | null = null;
    let probeError = false;
    try {
      if (client && state.gatewayConnected !== false) {
        resumeRes = await callSessionResumeForProbe(client, targetStoredId, resolvedProfile);
      }
    } catch (err) {
      probeError = true;
      deps.logStream?.warn?.('watchdog authority probe failed', { sessionId: targetStoredId, error: describeRpcError(err) });
    }

    if (probeGen !== watchdogProbeGeneration) return;

    const inflight = extractResumeInflightState(resumeRes);
    const decision = decideWatchdogProbeAction({
      reason: 'inactivity',
      isGatewayConnected: Boolean(deps.getGatewayClient()) && deps.getState().gatewayConnected !== false,
      probeResult: resumeRes ? { isRunning: inflight.isRunning } : null,
      probeError,
      consecutiveProbeFailures,
    });

    if (decision === 'renew' || decision === 'defer-offline') {
      consecutiveProbeFailures = probeError || decision === 'defer-offline' ? consecutiveProbeFailures + 1 : 0;
      if (resumeRes && inflight.isRunning) {
        deps.onWatchdogTurnStillRunning?.(targetStoredId, resumeRes);
      }
      if (!slidingWatchdog.renewIdle()) {
        settleWatchdogTimeout(targetStoredId);
      }
      return;
    }

    consecutiveProbeFailures = 0;
    settleWatchdogTimeout(targetStoredId);
    if (decision === 'settle-completed') {
      void deps.onWatchdogTurnCompleted?.(targetStoredId);
    }
  }

  function pickLeastRecentlyActiveStreamId(): string | null {
    const streamRegistry = deps.getLiveStreamRegistry?.();
    if (!streamRegistry) return null;
    let oldestSid: string | null = null;
    let oldestAt = Infinity;
    for (const sid of streamRegistry.listSessionIds()) {
      const entry = streamRegistry.getBySession(sid);
      if (entry && entry.lastActivityAt < oldestAt) {
        oldestAt = entry.lastActivityAt;
        oldestSid = sid;
      }
    }
    return oldestSid;
  }

  function handleWatchdogTimeout(reason: WatchdogTimeoutReason): void {
    const state = deps.getState();
    const streamIds = deps.getLiveStreamRegistry?.().listSessionIds() ?? [];
    if (!state.isStreaming && streamIds.length === 0) return;

    const ctx = deps.getActiveStreamingContext();
    const targetStoredId =
      pickLeastRecentlyActiveStreamId() ||
      ctx.activeStreamingStoredSessionId ||
      (state.isStreaming ? state.activeSessionId : null) ||
      streamIds[0] ||
      null;
    const client = deps.getGatewayClient();
    const probeGen = ++watchdogProbeGeneration;

    if (reason === 'hard-limit' || !targetStoredId) {
      settleWatchdogTimeout(targetStoredId);
      return;
    }

    if (!client || state.gatewayConnected === false) {
      const offlineDecision = decideWatchdogProbeAction({
        reason,
        isGatewayConnected: false,
        consecutiveProbeFailures,
      });
      if (offlineDecision === 'defer-offline') {
        consecutiveProbeFailures += 1;
        if (slidingWatchdog.renewIdle()) return;
      }
      settleWatchdogTimeout(targetStoredId);
      return;
    }

    void probeWatchdogAuthority(probeGen, targetStoredId);
  }

  const slidingWatchdog = new SlidingActiveWatchdog({
    idleTimeoutMs: deps.watchdogIdleTimeoutMs ?? 60_000,
    hardLimitMs: deps.watchdogHardLimitMs ?? 120 * 60_000,
    throttleMs: 500,
    // 【显式注入系统时钟 (Rules)】生产构造必须走「时钟是函数」这条契约路径：
    //   留空会让同一份 core 源码在入口 bundle 里只走到回落分支，
    //   而增量覆盖率按源文件累加分支，另一条契约路径的缺席会把已测分支压成未覆盖。
    now: () => Date.now(),
    onTimeout: handleWatchdogTimeout,
  });

  function armTurnWatchdog(): void {
    watchdogProbeGeneration += 1;
    consecutiveProbeFailures = 0;
    slidingWatchdog.arm();
  }

  function feedTurnWatchdog(): void {
    consecutiveProbeFailures = 0;
    if (slidingWatchdog.getState() === 'expired') {
      watchdogProbeGeneration += 1;
      slidingWatchdog.renewIdle();
      return;
    }
    slidingWatchdog.feed();
  }

  function disarmTurnWatchdog(force = false): void {
    // 【多流并发守卫 (Why)】删除/中断某个会话时若 LiveStreamRegistry 中仍有其他后台活跃流，
    // 不得误关共享看门狗，否则后台流永久丧失探活与兜底能力；仅在无活跃流或显式 force 时撤防。
    if (!force && (deps.getLiveStreamRegistry?.().size() ?? 0) > 0) {
      return;
    }
    watchdogProbeGeneration += 1;
    consecutiveProbeFailures = 0;
    slidingWatchdog.disarm();
  }

  function isStreamingActiveForCurrentSession(): boolean {
    const state = deps.getState();
    if (!state.activeSessionId) return false;
    if (deps.getLiveStreamRegistry?.().hasSession(state.activeSessionId)) {
      return true;
    }
    const ctx = deps.getActiveStreamingContext();
    return Boolean(
      ctx.activeStreamingStoredSessionId &&
      ctx.activeStreamingStoredSessionId === state.activeSessionId &&
      state.isStreaming
    );
  }

  function clearPresenceTerminal(): void {
    if (presenceTerminalTimer) {
      clearTimeout(presenceTerminalTimer);
      presenceTerminalTimer = null;
    }
    deps.getState().presenceTerminal = undefined;
  }

  function armPresenceTerminal(terminal: NonNullable<AppState['presenceTerminal']>): void {
    if (presenceTerminalTimer) {
      clearTimeout(presenceTerminalTimer);
      presenceTerminalTimer = null;
    }
    const state = deps.getState();
    state.presenceTerminal = terminal;
    presenceTerminalTimer = setTimeout(() => {
      presenceTerminalTimer = null;
      if (state.presenceTerminal !== terminal) return;
      state.presenceTerminal = undefined;
      deps.render();
    }, PRESENCE_TERMINAL_TTL_MS);
    safeUnref(presenceTerminalTimer);
  }

  function setTimedDockNotice(msg: string, durationMs = 4000, options?: { skipRender?: boolean }): void {
    const state = deps.getState();
    state.dockNotice = msg;
    if (!options?.skipRender) {
      deps.render();
    }
    if (dockNoticeDismissTimer) {
      clearTimeout(dockNoticeDismissTimer);
      dockNoticeDismissTimer = null;
    }
    if (msg && durationMs > 0) {
      dockNoticeDismissTimer = setTimeout(() => {
        dockNoticeDismissTimer = null;
        if (state.dockNotice === msg) {
          state.dockNotice = '';
          deps.render();
        }
      }, durationMs);
      safeUnref(dockNoticeDismissTimer);
    }
  }

  function clearTimedDockNotice(options?: { skipRender?: boolean }): void {
    const state = deps.getState();
    state.dockNotice = '';
    if (dockNoticeDismissTimer) {
      clearTimeout(dockNoticeDismissTimer);
      dockNoticeDismissTimer = null;
    }
    if (!options?.skipRender) {
      deps.render();
    }
  }

  function syncGroupRoomLogsToState(roomId: string, logs: readonly GroupMessageEntry[]): void {
    if (!logs || logs.length === 0) return;
    const state = deps.getState();
    const lastEntry = logs[logs.length - 1];
    const targetRoom = state.groupRooms.find((r) => r.roomId === roomId);
    if (targetRoom && lastEntry) {
      targetRoom.lastMessage = lastEntry.text;
      const rawEntryTs = lastEntry.timestamp || Date.now();
      targetRoom.updatedAt = typeof rawEntryTs === 'number'
        ? (rawEntryTs > 1e11 ? rawEntryTs : rawEntryTs * 1000)
        : Date.now();
      state.groupRooms = [targetRoom, ...state.groupRooms.filter((r) => r.roomId !== roomId)];
    }
    if (state.activeFocus.type === 'group' && state.activeFocus.roomId === roomId) {
      state.messages = logs.map((entry, idx) => {
        const senderName = entry.senderProfile || 'Agent';
        const role = entry.actorKind === 'user' || entry.senderProfile === 'user' ? 'user' : 'assistant';
        const parsed = role === 'user' ? extractMessageAttachments(entry.text) : null;
        return {
          id: entry.messageId || `g_msg_${idx}`,
          role,
          content: parsed ? parsed.cleanText : entry.text,
          ...(parsed && parsed.attachments.length > 0 ? { attachments: parsed.attachments } : {}),
          sender: senderName,
          senderAvatar: deps.resolveAgentAvatar(senderName),
          timestamp: formatTimestamp(entry.timestamp || Date.now()),
        };
      });
      // 【跟随语义】后台轮询到新日志时只在用户本就贴底的情况下跟随；
      // 这里不再强置待贴底，交由 render 的 wasNearBottom（48px 安全区）自然判定，
      // 否则用户上翻阅读历史时会被每条新消息拽回底部。
      deps.syncActiveGroupSpeakerFromMessages();
      deps.render();
    }
  }

  const groupPollerManager = new GroupLogPollerManager<GroupMessageEntry>({
    fetchLogs: (roomId) => {
      const client = deps.getGatewayClient();
      if (!client) {
        return Promise.reject(new Error('Gateway not connected'));
      }
      return deps.getGroupRoomStore().fetchLogs(roomId, client);
    },
    isFocused: (roomId) => {
      const state = deps.getState();
      return state.activeFocus.type === 'group' && state.activeFocus.roomId === roomId;
    },
    onSyncLogs: (roomId, logs) => {
      syncGroupRoomLogsToState(roomId, logs);
    },
    onCompleted: (roomId, focused) => {
      deps.completeEntityTurn('group', deps.getActiveRunningGroupRoomIds(), deps.getUnreadGroupRoomIds(), roomId, focused);
      deps.render();
    },
    onFailed: (roomId) => {
      applyTurnFailed(deps.getActiveRunningGroupRoomIds(), roomId);
      deps.getActivityTransitionTracker().clear('group', roomId);
      deps.render();
    },
    maxRounds: 60,
    maxStagnantRounds: 45,
    intervalMs: 1500,
  });

  async function refreshGroupRoomLog(roomId: string): Promise<number> {
    const client = deps.getGatewayClient();
    if (!client) return 0;
    try {
      const logs = await deps.getGroupRoomStore().fetchLogs(roomId, client);
      syncGroupRoomLogsToState(roomId, logs);
      return logs.length;
    } catch (e) {
      console.warn('[Flux] refreshGroupRoomLog failed:', e);
      return 0;
    }
  }

  function toMessageAttachments(
    items: readonly AppState['attachments'][number][],
  ): MessageViewModel['attachments'] {
    if (items.length === 0) return undefined;
    return items.map(({ id, name, label, type, previewUrl, sizeBytes }) => ({
      id,
      name,
      label,
      type,
      previewUrl,
      sizeBytes,
    }));
  }

  async function sendGroupMessage(roomId: string, text: string): Promise<void> {
    const client = deps.getGatewayClient();
    if (!client) return;

    const state = deps.getState();
    deps.onBeforeSendEntity?.('group', roomId);
    const currentAttachments = [...state.attachments];
    state.attachments = [];
    const trimmed = text.trim();
    const finalText = formatAttachmentPromptText(trimmed, currentAttachments, deps.t('dock.attachmentHeader'));
    if (!finalText) return;

    const sentAttachments = toMessageAttachments(currentAttachments);
    const previewText = trimmed || currentAttachments.map((a) => a.name).join(', ');
    const now = Date.now();
    const threadId = activeGroupThreadId && now - activeGroupThreadAt < GROUP_THREAD_GAP_MS
      ? activeGroupThreadId
      : undefined;
    const groupRoomStore = deps.getGroupRoomStore();
    const baseline = captureGroupLogBaseline(groupRoomStore.getLogs(roomId));

    const userMsgId = `grp-usr-${now}`;
    state.messages.push({
      id: userMsgId,
      role: 'user',
      content: trimmed,
      attachments: sentAttachments,
      timestamp: formatTimestamp(now),
    });
    deps.setPendingScrollToBottom(true);

    // 即时更新该群聊最新消息副标题与时间戳，并排在列表最前
    const targetRoom = state.groupRooms.find((r) => r.roomId === roomId);
    if (targetRoom) {
      targetRoom.lastMessage = previewText;
      targetRoom.updatedAt = now;
      state.groupRooms = [targetRoom, ...state.groupRooms.filter((r) => r.roomId !== roomId)];
    }
    applyTurnStarted(deps.getActiveRunningGroupRoomIds(), deps.getUnreadGroupRoomIds(), roomId);
    deps.syncActiveGroupSpeakerFromMessages();
    deps.getActivityTransitionTracker().clear('group', roomId);

    deps.render();
    deps.scrollStreamToBottom('group message sent');

    try {
      const res = await groupRoomStore.sendMessage(roomId, finalText, 'user', client, { threadId });
      activeGroupThreadId = res.event?.payload?.thread_id || threadId || null;
      activeGroupThreadAt = now;

      void refreshGroupRoomLog(roomId);
      groupPollerManager.startAwaitReply(roomId, baseline);
    } catch (err) {
      applyTurnFailed(deps.getActiveRunningGroupRoomIds(), roomId);
      deps.getActivityTransitionTracker().clear('group', roomId);
      console.error('[Flux] groups.send failed:', err);
      setTimedDockNotice(deps.t('group.sendFailed', { error: describeRpcError(err) }));
      deps.render();
    }
  }

  async function interruptTurn(): Promise<void> {
    const state = deps.getState();
    const ctx = deps.getActiveStreamingContext();
    const targetLiveId = ctx.activeStreamingLiveId || state.activeLiveSessionId;
    const targetStoredId = ctx.activeStreamingStoredSessionId || state.activeSessionId;

    // 【贴底意图必须在 flush / setMessageContent 改写 DOM 之前捕获 (Why)】
    //   避免冲刷残留 token 或追加中断文案撑高容器后误判为非贴底，同时清理未执行的工具补丁队列与计时器。
    const wasNearBottomBeforeInterrupt = deps.isStreamNearBottom?.() ?? false;
    deps.getTokenCoalescer().flush();
    deps.clearToolPatchQueue?.();
    deps.stopRunningToolTimers?.();

    const isCurrent = ctx.activeStreamingStoredSessionId === state.activeSessionId;
    if (isCurrent && ctx.activeStreamingMessageId) {
      const target = state.messages.find((m) => m.id === ctx.activeStreamingMessageId);
      if (target) {
        if (!target.content) {
          target.content = deps.t('chat.interruptedEmpty');
        } else {
          target.content += deps.t('chat.interruptedSuffix');
        }
        deps.setMessageContent(ctx.activeStreamingMessageId, target.content);
      }
    } else if (targetStoredId && ctx.activeStreamingMessageId) {
      const cached = deps.getSessionMessagesCache().get(targetStoredId);
      const target = cached?.find((m) => m.id === ctx.activeStreamingMessageId);
      if (target) {
        target.content = target.content ? target.content + deps.t('chat.interruptedSuffix') : deps.t('chat.interruptedEmpty');
      }
    }

    // 【收敛运行中工具态 (Pitfall)】中断后若 toolCall 仍停留在 running，ToolBlocks 会持续空转 useNow 秒脉冲与旋转指示器。
    const settleRunningTools = (msgs: MessageViewModel[]): void => {
      const now = Date.now();
      for (const msg of msgs) {
        if (!msg.toolCalls) continue;
        for (const tc of msg.toolCalls) {
          if (tc.status === 'running') {
            tc.status = 'completed';
            if (tc.startTime && !tc.durationMs) {
              tc.durationMs = Math.max(100, now - tc.startTime);
            }
          }
        }
      }
    };
    if (isCurrent) {
      settleRunningTools(state.messages);
    }
    if (targetStoredId) {
      const cached = deps.getSessionMessagesCache().get(targetStoredId);
      if (cached && cached !== state.messages) {
        settleRunningTools(cached);
      }
    }

    if (isCurrent && wasNearBottomBeforeInterrupt) {
      deps.setPendingScrollToBottom(true);
    }

    const interruptedSessionId = ctx.activeStreamingStoredSessionId;
    const interruptedBotName = ctx.activeStreamingBotName;
    const interruptedGroupRoomId =
      !interruptedSessionId && !interruptedBotName && state.activeFocus.type === 'group'
        ? state.activeFocus.roomId
        : null;

    settleTurnTermination({
      runningSessionIds: deps.getActiveRunningSessionIds(),
      runningBotNames: deps.getActiveRunningBotNames(),
      runningGroupRoomIds: deps.getActiveRunningGroupRoomIds(),
      sessionId: interruptedSessionId,
      botName: interruptedBotName,
      groupRoomId: interruptedGroupRoomId,
    });
    releaseTurnOwnership(ctx.activeStreamingMessageId, interruptedSessionId, interruptedBotName);
    if (interruptedSessionId) {
      deps.getLiveStreamRegistry?.().removeSession(interruptedSessionId);
    }
    disarmTurnWatchdog();
    const tracker = deps.getActivityTransitionTracker();
    if (interruptedSessionId) tracker.clear('session', interruptedSessionId);
    if (interruptedBotName) tracker.clear('bot', interruptedBotName);
    if (interruptedGroupRoomId) {
      groupPollerManager.stop(interruptedGroupRoomId);
      tracker.clear('group', interruptedGroupRoomId);
    }

    state.isStreaming = false;
    state.turnStartedAt = undefined;
    deps.setTurnStartedSessionId(null);
    // 【在场指示器】用户主动中断：落中断终态（TTL 8s 自动退场），让「已停手」被看见一次
    armPresenceTerminal({ kind: 'interrupted' });
    deps.setActiveStreamingContext({
      activeStreamingMessageId: null,
      activeStreamingStoredSessionId: null,
      activeStreamingLiveId: null,
      activeStreamingBotName: null,
    });

    // setTimedDockNotice 内部已同步触发一次 render()，避免重复调用二次 render 提前消费贴底标记
    setTimedDockNotice(deps.t('chat.turnInterruptedNotice'));

    // 2. Notify remote gateway
    const client = deps.getGatewayClient();
    if (client && targetLiveId) {
      try {
        await client.call('session.interrupt', { session_id: targetLiveId });
      } catch (e) {
        console.warn('[Hermes Gateway] Remote interrupt notification ignored:', e);
      }
    }
  }

  async function sendMessage(text: string): Promise<void> {
    const state = deps.getState();
    const trimmed = text.trim();
    if (!trimmed && state.attachments.length === 0) return;

    const client = deps.getGatewayClient();
    if (!client) {
      setTimedDockNotice(deps.t('chat.sendGatewayNotConnected'));
      deps.render();
      return;
    }

    // 群聊房间必须走官方 groups.send
    if (state.activeFocus.type === 'group') {
      await sendGroupMessage(state.activeFocus.roomId, trimmed);
      return;
    }

    if (state.isStreaming) {
      setTimedDockNotice(deps.t('chat.turnGeneratingNotice'));
      deps.render();
      return;
    }

    if (!state.activeSessionId) {
      await deps.createNewSession();
    }
    if (state.activeFocus.type === 'session' && state.activeSessionId) {
      deps.onBeforeSendEntity?.('session', state.activeSessionId, state.profileName || undefined);
    }

    const liveId = await deps.ensureLiveSessionId();
    if (deps.getGatewayClient() !== client) {
      return;
    }
    if (!liveId) {
      setTimedDockNotice(deps.t('chat.noLiveChannelNotice'));
      deps.render();
      return;
    }

    state.dockNotice = '';

    // 挂起回滚事务处理
    const armed =
      state.rollbackArmed && state.rollbackArmed.sessionId === state.activeSessionId
        ? state.rollbackArmed
        : null;
    let armedSnapshotForRestore: MessageViewModel[] | null = null;
    let armedRowId: number | null = null;
    if (armed && armed.anchor.kind === 'row') {
      armedRowId = armed.anchor.rowId;
      armedSnapshotForRestore = armed.snapshot.map((m) => ({ ...m }));
      const cut = resolveCutIndexByAnchor(state.messages, armed.anchor);
      if (cut >= 0) {
        state.messages = state.messages.slice(0, cut);
      }
    }
    state.rollbackArmed = null;

    // 处理附件
    const currentAttachments = [...state.attachments];
    state.attachments = [];
    const finalText = formatAttachmentPromptText(trimmed, currentAttachments, deps.t('dock.attachmentHeader'));
    const previewText = trimmed || currentAttachments.map((a) => a.name).join(', ');
    const sentAttachments = toMessageAttachments(currentAttachments);

    if (state.activeSessionId) {
      const sessionDrafts = deps.getSessionDrafts();
      sessionDrafts.delete(state.activeSessionId);
    }

    const turnSeq = ++nextTurnSeq;
    const nowMs = Date.now();
    const userMsgId = `usr-${nowMs}-${turnSeq}`;
    const userMsg: MessageViewModel = {
      id: userMsgId,
      role: 'user',
      content: trimmed,
      attachments: sentAttachments,
      timestamp: formatClockTime(new Date(), true),
    };
    state.messages.push(userMsg);

    const assistantMsgId = `ast-${nowMs}-${turnSeq}`;
    const targetStoredSessionId = state.activeSessionId;
    deps.setActiveStreamingContext({
      activeStreamingMessageId: assistantMsgId,
      activeStreamingStoredSessionId: targetStoredSessionId,
      activeStreamingLiveId: liveId,
    });
    if (liveId && state.activeSessionId) {
      deps.getSessionHandleRegistry().register({ liveId, storedId: state.activeSessionId });
    }
    if (state.activeSessionId) {
      sessionTurnOwner.set(state.activeSessionId, assistantMsgId);
      applyTurnStarted(deps.getActiveRunningSessionIds(), deps.getUnreadSessionIds(), state.activeSessionId);
      deps.getActivityTransitionTracker().clear('session', state.activeSessionId);
      const activeSess = state.sessions.find((s) => s.id === state.activeSessionId);
      if (activeSess) {
        activeSess.preview = previewText;
        activeSess.timestamp = Date.now();
        activeSess.time = formatTimestamp(Date.now());
        state.sessions = [activeSess, ...state.sessions.filter((s) => s.id !== activeSess.id)];
      }
    }

    const currentFocus = state.activeFocus;
    const focusBotName = currentFocus.type === 'bot' ? currentFocus.botName : null;
    const submittedSessionBot = state.sessions.find((s) => s.id === targetStoredSessionId)?.botName || '';
    const submittedProfile = focusBotName || submittedSessionBot || state.profileName || '';
    const submittedProfileName = submittedProfile || 'default';
    deps.setActiveStreamingContext({ activeStreamingBotName: focusBotName });
    if (currentFocus.type === 'bot') {
      botTurnOwner.set(currentFocus.botName, assistantMsgId);
      applyTurnStarted(deps.getActiveRunningBotNames(), deps.getUnreadBotNames(), currentFocus.botName);
      deps.getActivityTransitionTracker().clear('bot', currentFocus.botName);
      deps.getBotActivityStore().updateLatestActivity(currentFocus.botName, previewText, Date.now());
    }

    const assistantMsg: MessageViewModel = {
      id: assistantMsgId,
      role: 'assistant',
      content: '',
      thought: '',
      timestamp: formatClockTime(new Date(), true),
    };
    state.messages.push(assistantMsg);

    deps.getLiveStreamRegistry?.().registerStream({
      storedSessionId: targetStoredSessionId,
      liveSessionId: liveId,
      messageId: assistantMsgId,
      botName: focusBotName,
      origin: 'local',
      startedAt: nowMs,
      userMessageSynced: true,
      nowMs,
    });

    deps.getSessionMessagesCache().set(state.activeSessionId, [...state.messages]);

    // 【主动意图对齐 (Why)】用户发出新 Prompt，明确要求观察最新回合。
    //   解除历史回溯冻结并强制将窗口对齐到尾部，保证新消息在 DOM 中存在，流式直写锚点可用。
    deps.setMessageWindowUserExpanded?.(false);
    deps.ensureMessageWindow?.(state.messages.length);

    state.isStreaming = true;
    state.turnStartedAt = Date.now();
    deps.setTurnStartedSessionId(state.activeSessionId);
    clearPresenceTerminal();
    deps.getTokenCoalescer().flush();
    deps.getTokenCoalescer().clear();
    armTurnWatchdog();
    deps.setPendingScrollToBottom(true);
    deps.render();
    deps.scrollStreamToBottom('message sent');
    deps.logStream?.info?.('turn started', { session: state.activeLiveSessionId, chars: finalText.length });

    const getOwnedSessionId = (): string =>
      targetStoredSessionId &&
      sessionTurnOwner.get(targetStoredSessionId) === assistantMsgId &&
      deps.getActiveRunningSessionIds().has(targetStoredSessionId)
        ? targetStoredSessionId
        : '';

    const getOwnedBotName = (): string =>
      focusBotName &&
      botTurnOwner.get(focusBotName) === assistantMsgId &&
      deps.getActiveRunningBotNames().has(focusBotName)
        ? focusBotName
        : '';

    const failSubmittedTurn = (assistantContent: string, terminalReason: string, rollbackReason: string): void => {
      if (deps.getGatewayClient() !== client) return;
      const ctxNow = deps.getActiveStreamingContext();
      const ownsStreamCtx = ctxNow.activeStreamingMessageId === assistantMsgId;
      const ownedSessionId = getOwnedSessionId();
      const ownedBotName = getOwnedBotName();
      if (!ownsStreamCtx && !ownedSessionId && !ownedBotName) return;

      assistantMsg.content = assistantContent;
      const isFocused = state.activeSessionId === targetStoredSessionId;
      if (ownedSessionId) {
        sessionTurnOwner.delete(ownedSessionId);
        deps.getLiveStreamRegistry?.().removeSession(ownedSessionId);
        applyTurnFailed(deps.getActiveRunningSessionIds(), ownedSessionId);
        deps.getActivityTransitionTracker().clear('session', ownedSessionId);
      }
      if (ownsStreamCtx) {
        if (isFocused) {
          state.isStreaming = false;
          armPresenceTerminal({ kind: 'failed', message: terminalReason });
        }
        deps.setActiveStreamingContext({
          activeStreamingMessageId: null,
          activeStreamingStoredSessionId: null,
          activeStreamingLiveId: null,
          activeStreamingBotName: null,
        });
        disarmTurnWatchdog();
      }
      if (ownedBotName) {
        botTurnOwner.delete(ownedBotName);
        applyTurnFailed(deps.getActiveRunningBotNames(), ownedBotName);
        deps.getActivityTransitionTracker().clear('bot', ownedBotName);
      }
      if (armedSnapshotForRestore && (ownsStreamCtx || ownedSessionId)) {
        if (targetStoredSessionId) {
          deps.getSessionMessagesCache().set(targetStoredSessionId, [...armedSnapshotForRestore]);
        }
        if (isFocused) {
          state.messages = armedSnapshotForRestore;
          setTimedDockNotice(deps.t('chat.rollbackFailed', { reason: rollbackReason }));
        }
      }
      deps.render();
    };

    try {
      // 挂载图片与文件附件（若存在）
      for (const att of currentAttachments) {
        if (att.type === 'image' && att.previewUrl?.startsWith('data:')) {
          const base64Data = att.previewUrl.split(',')[1];
          if (base64Data) {
            try {
              await client.call<AttachedImageResult>('image.attach_bytes', {
                session_id: liveId,
                content_base64: base64Data,
                filename: att.name,
              });
            } catch (e) {
              deps.logStream?.warn?.('image.attach_bytes failed, continuing with prompt manifest', { error: String(e) });
            }
          }
        } else if (att.type !== 'image' && att.contentBase64) {
          const dataUrl = att.contentBase64.startsWith('data:')
            ? att.contentBase64
            : `data:application/octet-stream;base64,${att.contentBase64}`;
          try {
            await client.call<FileAttachResult>('file.attach', {
              session_id: liveId,
              profile: submittedProfile || undefined,
              name: att.name,
              data_url: dataUrl,
            });
          } catch (e) {
            deps.logStream?.warn?.('file.attach failed, continuing with prompt manifest', { error: String(e) });
          }
        }
      }

      if (deps.getGatewayClient() !== client) {
        return;
      }
      const ctxAfterUpload = deps.getActiveStreamingContext();
      if (ctxAfterUpload.activeStreamingMessageId !== assistantMsgId) {
        if (getOwnedSessionId() || getOwnedBotName()) {
          failSubmittedTurn(deps.t('chat.interruptedEmpty'), 'superseded', 'superseded');
        }
        return;
      }

      let submitResult: PromptSubmitResult;
      if (armedRowId !== null) {
        submitResult = await deps.getInteractiveService().truncateAndSubmit(deps.getRpcCaller(), {
          sessionId: liveId,
          text: finalText,
          rowId: armedRowId,
        });
      } else {
        submitResult = await client.call<PromptSubmitResult>('prompt.submit', {
          session_id: liveId,
          text: finalText,
        });
      }

      if (deps.getGatewayClient() !== client) {
        return;
      }

      const acceptedStatuses = new Set(['streaming', 'queued', 'steered', 'redirected']);
      if (submitResult?.status && !acceptedStatuses.has(submitResult.status)) {
        const rejectedStatus = String(submitResult.status);
        failSubmittedTurn(
          deps.t('chat.gatewayNotAccepted', { status: rejectedStatus }),
          `status=${rejectedStatus}`,
          rejectedStatus,
        );
        return;
      }

      if (typeof submitResult?.user_row_id === 'number' && submitResult.user_row_id > 0) {
        userMsg.rowId = submitResult.user_row_id;
        if (targetStoredSessionId) {
          const cached = deps.getSessionMessagesCache().get(targetStoredSessionId);
          const cachedUser = cached?.find((m) => m.id === userMsg.id);
          if (cachedUser) cachedUser.rowId = submitResult.user_row_id;
        }
      }

      // 多端并发提交竞态收敛：另一端已先开启当前回合，网关把本次提交入队（queued）或注入（steered/redirected）。
      // 此时立即撤下本地误创建的空助手占位行（queued 连同用户行进 queuedMessages），并触发附着远端真实在途流。
      if (
        (submitResult?.status === 'queued' || submitResult?.status === 'steered' || submitResult?.status === 'redirected') &&
        targetStoredSessionId
      ) {
        const isQueuedRace = submitResult.status === 'queued';
        const stripIds = isQueuedRace ? new Set([userMsgId, assistantMsgId]) : new Set([assistantMsgId]);
        state.messages = state.messages.filter((m) => !stripIds.has(m.id));
        const cached = deps.getSessionMessagesCache().get(targetStoredSessionId);
        if (cached && cached !== state.messages) {
          deps.getSessionMessagesCache().set(
            targetStoredSessionId,
            cached.filter((m) => !stripIds.has(m.id)),
          );
        }
        releaseTurnOwnership(assistantMsgId, targetStoredSessionId, focusBotName);
        const registry = deps.getLiveStreamRegistry?.();
        if (registry?.getBySession(targetStoredSessionId)?.messageId === assistantMsgId) {
          registry.removeSession(targetStoredSessionId);
        }
        if (focusBotName && !registry?.hasSession(targetStoredSessionId)) {
          deps.getActiveRunningBotNames().delete(focusBotName);
          deps.getActivityTransitionTracker().clear('bot', focusBotName);
        }
        if (deps.getActiveStreamingContext().activeStreamingMessageId === assistantMsgId) {
          deps.setActiveStreamingContext({
            activeStreamingMessageId: null,
            activeStreamingStoredSessionId: null,
            activeStreamingLiveId: null,
            activeStreamingBotName: null,
          });
        }
        if (!registry?.hasSession(targetStoredSessionId)) {
          if (state.activeSessionId === targetStoredSessionId) {
            state.isStreaming = false;
            state.turnStartedAt = undefined;
            deps.setTurnStartedSessionId(null);
          }
          disarmTurnWatchdog();
        }
        if (isQueuedRace) {
          const admissionId = submitResult.admission_id || `queued-${nowMs}-${turnSeq}`;
          const existingQueue = Array.isArray(state.queuedMessages) ? state.queuedMessages : [];
          if (!existingQueue.some((q) => q.admissionId === admissionId)) {
            state.queuedMessages = [...existingQueue, { id: admissionId, admissionId, text: finalText }];
          }
        }
        deps.render();
        void deps.onQueuedSubmitRace?.(targetStoredSessionId);
        return;
      }

      if (armedRowId !== null && targetStoredSessionId) {
        deps.getSessionHistoryTrust().set(targetStoredSessionId, 'server-priority');
        deps.forgetOlderCursorState(targetStoredSessionId);
        if (state.activeSessionId === targetStoredSessionId) {
          state.hasOlderMessages = false;
        }

        let survivorMap: Map<number, number | null> | null = null;
        if (submitResult?.survivor_row_id_map && typeof submitResult.survivor_row_id_map === 'object') {
          survivorMap = new Map();
          for (const [k, v] of Object.entries(submitResult.survivor_row_id_map)) {
            const numKey = Number(k);
            if (Number.isFinite(numKey)) {
              survivorMap.set(numKey, typeof v === 'number' && Number.isFinite(v) ? v : null);
            }
          }
        }
        const truncateCacheRef: CacheChannelRef = {
          profile: submittedProfileName,
          channel: 'session',
          channelId: targetStoredSessionId,
        };
        const cacheService = deps.getCacheService();
        void cacheService.truncate(truncateCacheRef, armedRowId, survivorMap).catch((e) => {
          console.warn('[Flux:cache] truncate cache failed:', e);
        });
      }
    } catch (err) {
      console.error('[Hermes Gateway] prompt.submit failed:', err);
      const errMsg = describeRpcError(err);
      failSubmittedTurn(
        deps.t('chat.submitFailed', { error: errMsg }),
        errMsg,
        errMsg,
      );
    }
  }

  function armCapsuleTimers(taskId: string): void {
    const state = deps.getState();
    const cap = state.sideAgentCapsules.find((c) => c.id === taskId);
    if (!cap) return;
    cap.hintTimer = setTimeout(() => {
      const c = state.sideAgentCapsules.find((x) => x.id === taskId);
      if (c && c.status === 'pending') {
        c.notice = deps.t('capsule.slowHint');
        deps.render();
      }
    }, 15000);
    safeUnref(cap.hintTimer);
    cap.expireTimer = setTimeout(() => {
      const c = state.sideAgentCapsules.find((x) => x.id === taskId);
      if (c && c.status === 'pending') {
        c.status = 'expired';
        deps.render();
      }
    }, 600000);
    safeUnref(cap.expireTimer);
  }

  async function askSideAgent(
    kind: 'btw' | 'delegation',
    targetProfile: string,
    question: string
  ): Promise<void> {
    const client = deps.getGatewayClient();
    if (!client) {
      setTimedDockNotice(deps.t('chat.gatewayNotConnected'));
      return;
    }
    const liveId = await deps.ensureLiveSessionId();
    if (!liveId) {
      setTimedDockNotice(deps.t('chat.forkNoLive'));
      deps.render();
      return;
    }

    const state = deps.getState();
    const resolved =
      state.profiles.find((p) => p.name === targetProfile || p.displayName === targetProfile)?.name || targetProfile;

    try {
      let taskId: string;
      if (kind === 'btw') {
        const res = await deps.getHandoffService().sendBtw(liveId, question, resolved, deps.getRpcCaller());
        taskId = res.task_id;
      } else {
        const res = await client.call<{ task_id?: string }>('prompt.background', {
          session_id: liveId,
          text: question,
          profile: resolved,
        });
        if (!res?.task_id) throw new Error('prompt.background missing task_id');
        taskId = res.task_id;
      }

      state.sideAgentCapsules = [
        ...state.sideAgentCapsules,
        {
          id: taskId,
          kind,
          profile: resolved,
          question,
          status: 'pending',
          startedAt: Date.now(),
        },
      ];
      armCapsuleTimers(taskId);
      deps.render();
    } catch (err) {
      state.sideAgentCapsules = [
        ...state.sideAgentCapsules,
        {
          id: `failed-${Date.now()}`,
          kind,
          profile: resolved,
          question,
          status: 'failed',
          startedAt: Date.now(),
          notice: describeRpcError(err),
        },
      ];
      deps.render();
    }
  }

  async function routeSend(text: string): Promise<void> {
    const state = deps.getState();
    const sessionKind = deriveSessionKind(state.activeFocus);
    const knownProfiles = state.profiles.map((p) => p.name);
    for (const p of state.profiles) {
      if (p.displayName) knownProfiles.push(p.displayName);
    }
    // 群聊研讨室：将当前房间入驻成员与广播全员 token ('all') 纳入已知候选，保证 @ 路由精准收敛
    const focus = state.activeFocus;
    if (focus.type === 'group' && focus.roomId) {
      const room = state.groupRooms.find((r) => r.roomId === focus.roomId);
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
    const route = planSendRoute({
      text,
      sessionKind,
      knownProfiles,
      pickedMentionToken: state.pickedMention?.profile ?? null,
    });
    state.pickedMention = null;

    switch (route.kind) {
      case 'plain':
        if (route.text.startsWith('/') && deps.getGatewayClient()) {
          await deps.runSlashCommand(route.text);
          return;
        }
        await sendMessage(route.text);
        return;
      case 'group-message':
      case 'mention-group':
        if (state.activeFocus.type === 'group' && state.activeFocus.roomId) {
          await sendGroupMessage(state.activeFocus.roomId, route.text);
        } else {
          setTimedDockNotice(deps.t('group.sendFailed', { error: 'Active group room focus lost' }));
          deps.render();
        }
        return;
      case 'mention-btw':
        await askSideAgent('btw', route.targetProfile, route.cleanText);
        return;
      case 'mention-subagent':
        await askSideAgent('delegation', route.targetProfile, route.cleanText);
        return;
      default: {
        const exhaustive: never = route;
        void exhaustive;
        return;
      }
    }
  }

  function resetActiveGroupThread(): void {
    activeGroupThreadId = null;
    activeGroupThreadAt = 0;
  }

  return {
    armTurnWatchdog,
    feedTurnWatchdog,
    disarmTurnWatchdog,
    isStreamingActiveForCurrentSession,
    clearPresenceTerminal,
    armPresenceTerminal,
    setTimedDockNotice,
    clearTimedDockNotice,
    interruptTurn,
    sendGroupMessage,
    syncGroupRoomLogsToState,
    refreshGroupRoomLog,
    resetActiveGroupThread,
    getGroupPollerManager: () => groupPollerManager,
    sendMessage,
    routeSend,
    enqueueDraft: () => deps.enqueueDraft(),
    handleQueueAction: (action, admissionId) => deps.handleQueueAction(action, admissionId),
    askSideAgent,
    armCapsuleTimers,
  };
}
