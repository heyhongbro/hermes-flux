/**
 * 会话整体状态栏与子 Agent 监控协调服务
 * (packages/desktop/src/renderer/services/sessionStatusService.ts)
 *
 * 【设计意图 (Why)】
 *   集中管理 SessionStatusStore、SubagentStore、双 ID 就绪门控（liveId 严禁回落 state.activeLiveSessionId）、
 *   non-live (spawn_tree + L3 扫描) 与 7 项 live RPC 生命周期、别名迁徙同步及双路径工具行局部刷新。
 *
 * 【防范的历史坑 (Pitfall)】
 *   1. `resolveLiveSessionId` 仅从 `SessionHandleRegistry#getRegisteredLiveId` 取真值：handles === null 时
 *      `messageLoadingService` 会把 storedId 兜底写入 `state.activeLiveSessionId`，若读该字段会绕过门控直接撞 4001。
 *   2. 异步子 Agent 回调在回合已收口时，`toolPatchQueue` 会跳过非活跃流式消息，必须分流调 `syncReactMessageList(true)`。
 *   3. 切会话与断线必须立刻递增 `statusGeneration` 并清退全部轮询定时器，防跨会话污染与后台空转。
 */

import {
  buildGroupScopeKey,
  buildSessionScopeKey,
  extractCompressionThreshold,
  isSyntheticSubagentId,
  isTerminalLifecycleStatus,
  matchSubagentForToolCall,
  reduceRightPodMode,
  resolveEffectiveCompressionRatio,
  SessionStatusStore,
  SubagentStore,
  type ConversationModeKind,
  type DelegationScanMessageInput,
  type HermesGatewayClient,
  type ISubagentRpcBridge,
  type RightPodAction,
  type ScopedSessionStatus,
  type SessionHandleRegistry,
  type SessionLiveInfo,
  type StoredTranscriptRow,
  type SubagentTaskState,
  type TurnAction,
} from '@hermes-flux/core';
import {
  t,
  type I18nKey,
  type MessageViewModel,
  type RightPodActions,
  type RightPodSnapshot,
  type StatusSubjectIdentity,
} from '@hermes-flux/ui';
import type { AppState } from '../state/appState.js';
import { parseTranscriptRows } from '../transcriptRows.js';

export interface SessionStatusServiceDeps {
  readonly getState: () => AppState;
  readonly getGatewayClient: () => HermesGatewayClient | null;
  readonly getSessionHandleRegistry: () => SessionHandleRegistry;
  readonly getSessionMessagesCache: () => Map<string, MessageViewModel[]>;
  readonly isStreamingActiveForCurrentSession: () => boolean;
  readonly getActiveStreamingStoredSessionId: () => string | null;
  readonly getActiveStreamingMessageId: () => string | null;
  readonly formatTimestamp: (ts: number) => string;
  readonly scheduleToolPatch: (messageId: string) => void;
  readonly syncReactMessageList: (force?: boolean) => void;
  readonly syncRightPod: () => void;
  readonly syncTitlebar: () => void;
  readonly openFilePreview: (filePath: string) => Promise<void> | void;
  readonly insertQuoteToComposer: (text: string) => void;
  readonly onOpenConstellation?: (profileName: string) => void;
  readonly writeClipboardText?: (text: string) => Promise<void>;
  readonly setTimedDockNotice?: (msg: string, durationMs?: number) => void;
  readonly render: () => void;
  readonly t?: (key: I18nKey, params?: Record<string, string | number>) => string;
}

export interface SessionStatusService {
  readonly statusStore: SessionStatusStore;
  readonly subagentStore: SubagentStore;
  applyRightPodAction(action: RightPodAction): void;
  getRightPodSnapshot(): RightPodSnapshot;
  getRightPodActions(): RightPodActions;
  getRunningSubagentCount(): number;
  getLiveSessionId(storedSessionId: string): string | null;
  onConnected(): Promise<void>;
  onDisconnected(): void;
  onSessionActivated(storedSessionId: string, profile?: string): void;
  onSessionMessagesLoaded(storedSessionId: string): void;
  onLiveSessionReady(
    storedSessionId: string,
    liveSessionId: string,
    info?: SessionLiveInfo | null,
    profile?: string
  ): void;
  onGroupActivated(roomId: string): void;
  onSessionDeleted(storedSessionId: string): void;
  onGatewayTurnAction(action: TurnAction, toStoredSessionId: (id?: string | null) => string | null): void;
  openSubagent(subagentId: string): void;
  syncPollingForCurrentMode(): void;
  loadBreakdownForCurrentSession(): Promise<void>;
  dispose(): void;
}

const SUBAGENT_DETAIL_POLL_MS = 2500;
const GROUP_STATE_POLL_MS = 2500;
const MAX_SPAWN_TREE_LOAD = 5;

function toScanMessages(messages: readonly MessageViewModel[]): DelegationScanMessageInput[] {
  return messages.map((m) => ({
    id: m.id,
    role: m.role,
    timestamp: m.rawTimestamp,
    toolCalls: m.toolCalls?.map((tc) => ({
      id: tc.id,
      name: tc.name,
      status: tc.status,
      args: tc.args,
      rawArgs: tc.rawArgs,
      output: tc.output,
      durationMs: tc.durationMs,
      startTime: tc.startTime,
      subagentId: tc.subagentId,
      delegationId: tc.delegationId,
    })),
  }));
}

export function createSessionStatusService(deps: SessionStatusServiceDeps): SessionStatusService {
  const statusStore = new SessionStatusStore();
  const subagentStore = new SubagentStore(1000);
  const tr = deps.t ?? t;

  let statusGeneration = 0;
  let connectionGeneration = 0;
  let rightPodInert = false;
  let steerFeedback: RightPodSnapshot['steerFeedback'] = null;
  let detailPollTimer: ReturnType<typeof setInterval> | null = null;
  let groupPollTimer: ReturnType<typeof setInterval> | null = null;
  let cachedTranscriptRowsRef: readonly StoredTranscriptRow[] | null = null;
  let cachedTranscriptSubagentId: string | null = null;
  let cachedTranscriptMessages: MessageViewModel[] = [];

  const getCurrentScopeKey = (state: AppState): string | null => {
    if (state.activeFocus.type === 'group') {
      return state.activeFocus.roomId ? buildGroupScopeKey(state.activeFocus.roomId) : null;
    }
    return state.activeSessionId ? buildSessionScopeKey(state.activeSessionId) : null;
  };

  const getModeKind = (state: AppState): ConversationModeKind =>
    state.activeFocus.type === 'group'
      ? 'group_room'
      : state.activeFocus.type === 'bot'
      ? 'bot_forever_chat'
      : 'scratchpad';

  const resolveActiveProfile = (state: AppState, storedId?: string): string | undefined => {
    if (state.activeFocus.type === 'bot') return state.activeFocus.botName || state.profileName || undefined;
    if (storedId) {
      const s = state.sessions.find((item) => item.id === storedId);
      if (s?.botName) return s.botName;
    }
    return state.profileName || undefined;
  };

  const getLiveSessionId = (storedSessionId: string): string | null => {
    if (!storedSessionId) return null;
    // 严格仅查 SessionHandleRegistry，绝不读取兜底写入的 state.activeLiveSessionId
    return deps.getSessionHandleRegistry().getRegisteredLiveId(storedSessionId);
  };

  const createRpcBridge = (client: HermesGatewayClient): ISubagentRpcBridge => ({
    request<TResult = unknown, TParams = unknown>(method: string, params?: TParams): Promise<TResult> {
      return client.call<TResult>(method, params);
    },
  });

  const stopDetailPolling = (): void => {
    if (detailPollTimer !== null) {
      clearInterval(detailPollTimer);
      detailPollTimer = null;
    }
  };

  const stopGroupPolling = (): void => {
    if (groupPollTimer !== null) {
      clearInterval(groupPollTimer);
      groupPollTimer = null;
    }
  };

  const backfillToolRowsForSession = (storedSessionId: string): void => {
    const state = deps.getState();
    const sessionSubagents = subagentStore.getTasksBySession(storedSessionId);
    if (sessionSubagents.length === 0) return;

    const lists: Array<{ msgs: MessageViewModel[]; isFocused: boolean }> = [];
    if (state.activeFocus.type !== 'group' && state.activeSessionId === storedSessionId) {
      lists.push({ msgs: state.messages, isFocused: true });
    }
    const cached = deps.getSessionMessagesCache().get(storedSessionId);
    if (cached && cached !== state.messages) {
      lists.push({ msgs: cached, isFocused: false });
    }

    const activeStreamingMsgId = deps.getActiveStreamingMessageId();
    const isStreamingCurrent = deps.isStreamingActiveForCurrentSession();

    for (const { msgs, isFocused } of lists) {
      let anySettledChanged = false;
      for (const msg of msgs) {
        if (!msg.toolCalls || msg.toolCalls.length === 0) continue;
        let msgDirty = false;
        for (const tc of msg.toolCalls) {
          if (tc.name !== 'delegate_task') continue;
          const resolvedPrev = tc.subagentId ? subagentStore.resolveSubagentId(tc.subagentId) : undefined;
          const matched = resolvedPrev && resolvedPrev !== tc.subagentId
            ? resolvedPrev
            : matchSubagentForToolCall(
                { id: tc.id, args: tc.args, rawArgs: tc.rawArgs, subagentId: tc.subagentId, delegationId: tc.delegationId },
                sessionSubagents
              );
          if (matched && tc.subagentId !== matched) {
            tc.subagentId = matched;
            msgDirty = true;
          }
        }
        if (msgDirty && isFocused) {
          if (isStreamingCurrent && activeStreamingMsgId && msg.id === activeStreamingMsgId) {
            deps.scheduleToolPatch(msg.id);
          } else {
            anySettledChanged = true;
          }
        }
      }
      if (anySettledChanged && isFocused) {
        deps.syncReactMessageList(true);
      }
    }
  };

  const fetchChildMessagesFallback = async (
    childSessionId: string,
    profile?: string
  ): Promise<StoredTranscriptRow[] | null> => {
    const client = deps.getGatewayClient();
    if (!client || !childSessionId) return null;
    try {
      const outcome = await client.fetchSessionMessages(childSessionId, {
        limit: 100,
        order: 'latest',
        profile,
        includeCompacted: true,
      });
      if (outcome.status !== 'success' || outcome.messages.length === 0) return null;
      return outcome.messages.map((rec, idx) => ({
        row_id: typeof rec.row_id === 'number' ? rec.row_id : idx + 1,
        role: typeof rec.role === 'string' ? rec.role : 'assistant',
        row_kind: rec.row_kind === 'compaction' ? ('compaction' as const) : ('message' as const),
        content: typeof rec.content === 'string' ? rec.content : '',
        timestamp: typeof rec.timestamp === 'number' ? rec.timestamp : undefined,
        name: typeof rec.name === 'string' ? rec.name : undefined,
        tool_call_id: typeof rec.tool_call_id === 'string' ? rec.tool_call_id : undefined,
        args:
          rec.args && typeof rec.args === 'object' && !Array.isArray(rec.args)
            ? (rec.args as Record<string, unknown>)
            : undefined,
      }));
    // gate-degrade: 子 Agent 历史消息拉取尽力而为，失败时退回父会话记录
    } catch {
      return null;
    }
  };

  const loadSelectedSubagentTranscript = async (subagentId: string): Promise<void> => {
    const state = deps.getState();
    const client = deps.getGatewayClient();
    if (!client || state.activeFocus.type === 'group' || !state.activeSessionId) return;
    const storedId = state.activeSessionId;
    const profile = resolveActiveProfile(state, storedId);
    const liveId = getLiveSessionId(storedId);
    await subagentStore.loadSubagentTranscript({
      subagentId,
      storedSessionId: storedId,
      liveSessionId: liveId,
      profile,
      bridge: createRpcBridge(client),
      fetchChildMessages: fetchChildMessagesFallback,
    });
    deps.syncRightPod();
  };

  const ensureSubagentDetailPolling = (subagentId: string): void => {
    stopDetailPolling();
    void loadSelectedSubagentTranscript(subagentId);
    detailPollTimer = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      const state = deps.getState();
      if (state.rightPodMode.kind !== 'subagent') {
        stopDetailPolling();
        return;
      }
      const task = subagentStore.getTask(state.rightPodMode.subagentId);
      if (task && task.lifecycleStatus !== 'queued' && task.lifecycleStatus !== 'running') {
        const tsState = subagentStore.getTranscriptState(task.subagentId);
        if (tsState.status === 'ready' || tsState.status === 'degraded_tail') {
          stopDetailPolling();
          return;
        }
      }
      void loadSelectedSubagentTranscript(state.rightPodMode.subagentId);
    }, SUBAGENT_DETAIL_POLL_MS);
  };

  const refreshGroupState = async (roomId: string, expectedGen: number): Promise<void> => {
    const client = deps.getGatewayClient();
    const state = deps.getState();
    if (!client || !roomId) return;
    if (state.activeFocus.type !== 'group' || state.activeFocus.roomId !== roomId) return;
    try {
      const res = await client.call<Record<string, unknown>>('groups.state', { room_id: roomId });
      if (expectedGen !== statusGeneration) return;
      if (state.activeFocus.type !== 'group' || state.activeFocus.roomId !== roomId) return;
      statusStore.applyGroupState(roomId, res);
      deps.syncRightPod();
    } catch (err) {
      if (expectedGen !== statusGeneration) return;
      statusStore.applyGroupStateError(roomId, err instanceof Error ? err.message : String(err));
      deps.syncRightPod();
    }
  };

  const ensureGroupPolling = (roomId: string): void => {
    stopGroupPolling();
    const gen = statusGeneration;
    void refreshGroupState(roomId, gen);
    groupPollTimer = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      const state = deps.getState();
      if (state.activeFocus.type !== 'group' || state.activeFocus.roomId !== roomId || state.rightPodMode.kind === 'closed') {
        stopGroupPolling();
        return;
      }
      void refreshGroupState(roomId, gen);
    }, GROUP_STATE_POLL_MS);
  };

  const syncPollingForCurrentMode = (): void => {
    const state = deps.getState();
    if (state.rightPodMode.kind === 'subagent') {
      stopGroupPolling();
      subagentStore.setActiveTailTarget(state.rightPodMode.subagentId);
      ensureSubagentDetailPolling(state.rightPodMode.subagentId);
      return;
    }
    stopDetailPolling();
    subagentStore.setActiveTailTarget(null);
    if (state.activeFocus.type === 'group' && state.rightPodMode.kind === 'status') {
      ensureGroupPolling(state.activeFocus.roomId);
    } else {
      stopGroupPolling();
    }
  };

  const applyRightPodAction = (action: RightPodAction): void => {
    const state = deps.getState();
    const prev = state.rightPodMode;
    const next = reduceRightPodMode(prev, action);
    if (next.kind === 'closed') {
      rightPodInert = prev.kind === 'status' || prev.kind === 'subagent';
    } else {
      rightPodInert = false;
    }
    state.rightPodMode = next;
    state.inspectorCollapsed = next.kind === 'closed';
    if (next.kind === 'closed') {
      state.inspectorFullscreen = false;
    }
    syncPollingForCurrentMode();
    deps.render();
  };

  const openSubagent = (subagentId: string): void => {
    if (!subagentId) return;
    const canonical = subagentStore.resolveSubagentId(subagentId);
    applyRightPodAction({ type: 'open-subagent', subagentId: canonical });
  };

  const loadSpawnTreesNonLive = async (storedId: string, profile: string | undefined, expectedGen: number): Promise<void> => {
    const client = deps.getGatewayClient();
    if (!client || !storedId) return;
    try {
      const listRes = await client.listSpawnTrees(storedId, profile, MAX_SPAWN_TREE_LOAD);
      if (expectedGen !== statusGeneration || deps.getState().activeSessionId !== storedId) return;
      const entries = Array.isArray(listRes?.entries) ? listRes.entries.slice(0, MAX_SPAWN_TREE_LOAD) : [];
      const loadedRecords: Array<Record<string, unknown>> = [];
      for (const entry of entries) {
        if (!entry.path) continue;
        try {
          const loaded = await client.loadSpawnTree(entry.path, profile);
          if (expectedGen !== statusGeneration || deps.getState().activeSessionId !== storedId) return;
          if (Array.isArray(loaded?.subagents)) {
            loadedRecords.push(...loaded.subagents);
          } else if (loaded && typeof loaded === 'object') {
            loadedRecords.push(loaded as Record<string, unknown>);
          }
        // gate-degrade: 单个 spawn_tree 文件加载失败不阻断其余历史节点恢复
        } catch {}
      }
      if (loadedRecords.length > 0) {
        subagentStore.reconcileFromSpawnTree(storedId, loadedRecords);
        backfillToolRowsForSession(storedId);
        deps.syncRightPod();
        deps.syncTitlebar();
      }
    // gate-degrade: spawn_tree.list 非致命增强接口，失败时保留既有 L3/实时态
    } catch {}
  };

  const loadBreakdownForCurrentSession = async (): Promise<void> => {
    const state = deps.getState();
    const client = deps.getGatewayClient();
    if (!client || state.activeFocus.type === 'group' || !state.activeSessionId) return;
    const storedId = state.activeSessionId;
    const liveId = getLiveSessionId(storedId);
    if (!liveId) return;
    const profile = resolveActiveProfile(state, storedId);
    const scopeKey = buildSessionScopeKey(storedId);
    const expectedGen = statusGeneration;
    statusStore.setBreakdownLoading(scopeKey);
    deps.syncRightPod();
    try {
      const res = await client.getSessionContextBreakdown(liveId, profile);
      if (expectedGen !== statusGeneration || deps.getState().activeSessionId !== storedId) return;
      statusStore.applyContextBreakdown(scopeKey, res);
      deps.syncRightPod();
    } catch (err) {
      if (expectedGen !== statusGeneration) return;
      statusStore.applyBreakdownError(scopeKey, err instanceof Error ? err.message : String(err));
      deps.syncRightPod();
    }
  };

  const refreshLiveSessionTelemetry = async (
    storedId: string,
    liveId: string,
    profile: string | undefined,
    expectedGen: number
  ): Promise<void> => {
    const client = deps.getGatewayClient();
    if (!client || getLiveSessionId(storedId) !== liveId) return;
    const scopeKey = buildSessionScopeKey(storedId);

    const [usageRes] = await Promise.allSettled([
      client.getSessionUsage(liveId, profile),
      subagentStore.syncSessionSubagents(liveId, createRpcBridge(client), {
        storedSessionId: storedId,
        profile,
      }),
    ]);

    if (expectedGen !== statusGeneration || deps.getState().activeSessionId !== storedId) return;

    if (usageRes.status === 'fulfilled') {
      statusStore.applyUsagePayload(scopeKey, usageRes.value);
      const scope = statusStore.getScope(scopeKey);
      if (!scope?.usage?.contextMax && scope?.breakdown.status === 'idle') {
        void loadBreakdownForCurrentSession();
      }
    } else {
      statusStore.applyUsageError(
        scopeKey,
        usageRes.reason instanceof Error ? usageRes.reason.message : String(usageRes.reason)
      );
    }

    backfillToolRowsForSession(storedId);
    deps.syncRightPod();
    deps.syncTitlebar();
  };

  // 别名合并监听：synthesis -> real subagent_id 时同步更新 UI 下钻主键与主对话跳转按钮
  subagentStore.subscribeAliasResolved((oldId, newId, parentSessionId) => {
    const state = deps.getState();
    if (state.rightPodMode.kind === 'subagent' && state.rightPodMode.subagentId === oldId) {
      state.rightPodMode = reduceRightPodMode(state.rightPodMode, {
        type: 'resolve-subagent-id',
        oldId,
        newId,
      });
    }
    backfillToolRowsForSession(parentSessionId);
    deps.syncRightPod();
  });

  const onConnected = async (): Promise<void> => {
    const expectedConnGen = ++connectionGeneration;
    statusStore.setCompressionThreshold(null);
    const client = deps.getGatewayClient();
    const state = deps.getState();
    if (!client) {
      deps.syncRightPod();
      return;
    }
    try {
      const cfg = await client.fetchGatewayConfig(state.profileName || undefined);
      if (expectedConnGen !== connectionGeneration) return;
      statusStore.setCompressionThreshold(extractCompressionThreshold(cfg));
    // gate-degrade: 阈值配置获取失败时不绘虚假刻度线（严格保持 null）
    } catch {}
    if (expectedConnGen === connectionGeneration) {
      deps.syncRightPod();
    }
  };

  const onDisconnected = (): void => {
    connectionGeneration += 1;
    statusGeneration += 1;
    stopDetailPolling();
    stopGroupPolling();
    deps.getSessionHandleRegistry().clear?.();
    subagentStore.clearAll();
    statusStore.setCompressionThreshold(null);
    const state = deps.getState();
    if (state.rightPodMode.kind === 'subagent') {
      state.inspectorFullscreen = false;
      state.rightPodMode = reduceRightPodMode(state.rightPodMode, {
        type: 'session-switched',
        conversationMode: getModeKind(state),
      });
      state.inspectorCollapsed = state.rightPodMode.kind === 'closed';
    }
    cachedTranscriptRowsRef = null;
    cachedTranscriptSubagentId = null;
    cachedTranscriptMessages = [];
    rightPodInert = false;
    steerFeedback = null;
    deps.syncRightPod();
    deps.syncTitlebar();
  };

  const onSessionActivated = (storedSessionId: string, profile?: string): void => {
    statusGeneration += 1;
    const expectedGen = statusGeneration;
    stopDetailPolling();
    stopGroupPolling();
    steerFeedback = null;
    const state = deps.getState();
    if (state.rightPodMode.kind === 'subagent') {
      state.inspectorFullscreen = false;
    }
    state.rightPodMode = reduceRightPodMode(state.rightPodMode, {
      type: 'session-switched',
      conversationMode: getModeKind(state),
    });
    state.inspectorCollapsed = state.rightPodMode.kind === 'closed';

    if (storedSessionId) {
      if (state.messages.length > 0) {
        subagentStore.reconcileFromMessages(storedSessionId, toScanMessages(state.messages));
        backfillToolRowsForSession(storedSessionId);
      }
      void loadSpawnTreesNonLive(storedSessionId, profile ?? resolveActiveProfile(state, storedSessionId), expectedGen);
    }
    deps.syncRightPod();
    deps.syncTitlebar();
  };

  const onSessionMessagesLoaded = (storedSessionId: string): void => {
    const state = deps.getState();
    if (!storedSessionId || state.activeFocus.type === 'group' || state.activeSessionId !== storedSessionId) return;
    if (state.messages.length > 0) {
      subagentStore.reconcileFromMessages(storedSessionId, toScanMessages(state.messages));
      backfillToolRowsForSession(storedSessionId);
      deps.syncRightPod();
      deps.syncTitlebar();
    }
  };

  const onLiveSessionReady = (
    storedSessionId: string,
    liveSessionId: string,
    info?: SessionLiveInfo | null,
    profile?: string
  ): void => {
    if (!storedSessionId || !liveSessionId) return;
    const state = deps.getState();
    if (info && typeof info === 'object') {
      const rec = info as Record<string, unknown>;
      const resolvedInfo = (rec.info && typeof rec.info === 'object' ? rec.info : info) as SessionLiveInfo;
      statusStore.applySessionInfo(buildSessionScopeKey(storedSessionId), resolvedInfo);
    }
    if (state.activeFocus.type !== 'group' && state.activeSessionId === storedSessionId) {
      void refreshLiveSessionTelemetry(
        storedSessionId,
        liveSessionId,
        profile ?? resolveActiveProfile(state, storedSessionId),
        statusGeneration
      );
    }
  };

  const onGroupActivated = (roomId: string): void => {
    statusGeneration += 1;
    stopDetailPolling();
    stopGroupPolling();
    steerFeedback = null;
    const state = deps.getState();
    if (state.rightPodMode.kind === 'subagent') {
      state.inspectorFullscreen = false;
    }
    state.rightPodMode = reduceRightPodMode(state.rightPodMode, {
      type: 'session-switched',
      conversationMode: 'group_room',
    });
    state.inspectorCollapsed = state.rightPodMode.kind === 'closed';
    if (state.rightPodMode.kind === 'status' && roomId) {
      ensureGroupPolling(roomId);
    }
    deps.syncRightPod();
    deps.syncTitlebar();
  };

  const onSessionDeleted = (storedSessionId: string): void => {
    if (!storedSessionId) return;
    subagentStore.clearSession(storedSessionId);
    statusStore.deleteScope(buildSessionScopeKey(storedSessionId));
    if (deps.getState().activeSessionId === storedSessionId) {
      stopDetailPolling();
    }
    deps.syncRightPod();
    deps.syncTitlebar();
  };

  const onGatewayTurnAction = (
    action: TurnAction,
    toStoredSessionId: (id?: string | null) => string | null
  ): void => {
    const state = deps.getState();
    if (action.type === 'tool-start' && action.toolCall.name === 'delegate_task') {
      const targetStoredId = deps.getActiveStreamingStoredSessionId() ?? state.activeSessionId;
      if (targetStoredId) {
        backfillToolRowsForSession(targetStoredId);
      }
      return;
    }

    if (action.type === 'session-info') {
      const storedId = toStoredSessionId(action.sessionId) || action.sessionId;
      statusStore.applySessionInfo(buildSessionScopeKey(storedId), action.info);
      deps.syncRightPod();
      return;
    }

    if (action.type === 'session-usage') {
      const storedId = toStoredSessionId(action.sessionId) || action.sessionId;
      statusStore.applyUsagePayload(buildSessionScopeKey(storedId), action.payload);
      deps.syncRightPod();
      return;
    }

    if (action.type === 'subagent-update') {
      const storedId = toStoredSessionId(action.sessionId) || action.sessionId;
      subagentStore.applyEventUpdate({ ...action, sessionId: storedId });
      backfillToolRowsForSession(storedId);
      deps.syncRightPod();
      deps.syncTitlebar();
      return;
    }

    if (action.type === 'subagent-spawn') {
      const storedId = toStoredSessionId(action.parentSessionId) || action.parentSessionId;
      subagentStore.upsertTask({
        subagentId: action.subagentId,
        parentSessionId: storedId,
        targetProfile: action.profile,
        taskTitle: action.title,
        goal: action.title,
        lifecycleStatus: 'queued',
        phaseHint: 'queued',
        status: 'requested',
        source: 'live_event',
      });
      backfillToolRowsForSession(storedId);
      deps.syncRightPod();
      deps.syncTitlebar();
      return;
    }

    if (action.type === 'subagent-progress') {
      const storedId = action.sessionId ? toStoredSessionId(action.sessionId) || action.sessionId : state.activeSessionId;
      subagentStore.upsertTask({
        subagentId: action.subagentId,
        ...(storedId ? { parentSessionId: storedId } : {}),
        progressPercent: action.progressPercent,
        currentActionText: action.actionText,
        lifecycleStatus: 'running',
        phaseHint: 'progress',
        status: 'running',
        source: 'live_event',
      });
      deps.syncRightPod();
      return;
    }

    if (action.type === 'subagent-log') {
      subagentStore.appendLog(action.subagentId, action.entry);
      if (
        state.rightPodMode.kind === 'subagent' &&
        subagentStore.resolveSubagentId(state.rightPodMode.subagentId) ===
          subagentStore.resolveSubagentId(action.subagentId)
      ) {
        deps.syncRightPod();
      }
      return;
    }

    if (action.type === 'subagent-complete') {
      const storedId = action.sessionId ? toStoredSessionId(action.sessionId) || action.sessionId : state.activeSessionId;
      subagentStore.upsertTask({
        subagentId: action.subagentId,
        ...(storedId ? { parentSessionId: storedId } : {}),
        lifecycleStatus: action.lifecycleStatus ?? 'completed',
        phaseHint: 'idle',
        status: action.lifecycleStatus ?? 'completed',
        summary: action.summary,
        resultSummary: action.output ?? action.summary,
        completedAt: Date.now(),
        source: 'live_event',
      });
      deps.syncRightPod();
      deps.syncTitlebar();
      return;
    }

    if (action.type === 'subagent-failed') {
      const storedId = action.sessionId ? toStoredSessionId(action.sessionId) || action.sessionId : state.activeSessionId;
      subagentStore.upsertTask({
        subagentId: action.subagentId,
        ...(storedId ? { parentSessionId: storedId } : {}),
        lifecycleStatus: 'failed',
        phaseHint: 'idle',
        status: 'failed',
        error: action.error,
        completedAt: Date.now(),
        source: 'live_event',
      });
      deps.syncRightPod();
      deps.syncTitlebar();
    }
  };

  const resolveSubjectIdentity = (state: AppState, scope: ScopedSessionStatus | null): StatusSubjectIdentity => {
    const profiles = Array.isArray(state.profiles) ? state.profiles : [];
    const groupProfiles = profiles.map((p) => ({
      name: p.name,
      displayName: p.displayName,
      avatar: p.avatar,
    }));

    if (state.activeFocus.type === 'group') {
      const roomId = state.activeFocus.roomId;
      const room = Array.isArray(state.groupRooms)
        ? state.groupRooms.find((r) => r.roomId === roomId)
        : undefined;
      const groupMembers =
        Array.isArray(room?.members) && room.members.length > 0
          ? room.members
          : scope?.groupState?.memberActivity?.map((m) => m.profile || m.displayName || m.memberId) ?? [];
      const groupStateName =
        scope?.groupState?.name && scope.groupState.name !== roomId
          ? scope.groupState.name
          : undefined;
      return {
        kind: 'group',
        name: room?.name || groupStateName || scope?.groupState?.name || roomId || 'Group',
        profileName: roomId || 'group',
        groupMembers,
        groupProfiles,
      };
    }

    const targetProfile = resolveActiveProfile(state, state.activeSessionId) || state.profileName || 'default';
    const lower = targetProfile.toLowerCase();
    const matchedProfile =
      profiles.find((p) => p.name === targetProfile) ??
      profiles.find((p) => p.name.toLowerCase() === lower);
    return {
      kind: 'agent',
      name: matchedProfile?.displayName || targetProfile || scope?.projectName || 'Hermes',
      profileName: matchedProfile?.name || targetProfile || 'default',
      avatar: matchedProfile?.avatar,
    };
  };

  const getRightPodSnapshot = (): RightPodSnapshot => {
    const state = deps.getState();
    const convMode = getModeKind(state);
    const scopeKey = getCurrentScopeKey(state);
    const scope: ScopedSessionStatus | null = scopeKey ? statusStore.getScope(scopeKey) ?? null : null;
    const thresholdCfg = statusStore.getCompressionThreshold();
    const effectiveCompressionRatio = resolveEffectiveCompressionRatio(thresholdCfg, scope?.usage?.contextMax);
    const subject = resolveSubjectIdentity(state, scope);

    const subagents: SubagentTaskState[] =
      convMode === 'group_room' || !state.activeSessionId
        ? []
        : subagentStore.getTasksBySession(state.activeSessionId);

    let selectedSubagent: SubagentTaskState | null = null;
    let selectedTranscript: RightPodSnapshot['selectedTranscript'] = null;
    let selectedLogs: RightPodSnapshot['selectedLogs'] = [];
    let selectedMessages: MessageViewModel[] = [];

    if (state.rightPodMode.kind === 'subagent') {
      const canonicalId = subagentStore.resolveSubagentId(state.rightPodMode.subagentId);
      selectedSubagent = subagentStore.getTask(canonicalId) ?? null;
      selectedTranscript = subagentStore.getTranscriptState(canonicalId);
      selectedLogs = subagentStore.getLogs(canonicalId);

      if (selectedTranscript.rows.length > 0) {
        if (
          cachedTranscriptSubagentId === canonicalId &&
          cachedTranscriptRowsRef &&
          cachedTranscriptRowsRef.length === selectedTranscript.rows.length &&
          cachedTranscriptRowsRef[cachedTranscriptRowsRef.length - 1] ===
            selectedTranscript.rows[selectedTranscript.rows.length - 1]
        ) {
          selectedMessages = cachedTranscriptMessages;
        } else {
          selectedMessages = parseTranscriptRows(selectedTranscript.rows, {
            scope: { isGroupRoom: false, isBotRoom: false },
            formatTimestamp: deps.formatTimestamp,
          });
          cachedTranscriptSubagentId = canonicalId;
          cachedTranscriptRowsRef = selectedTranscript.rows;
          cachedTranscriptMessages = selectedMessages;
        }
      }
    }

    return {
      rightPodMode: state.rightPodMode,
      conversationMode: convMode,
      isStreaming: deps.isStreamingActiveForCurrentSession(),
      isFullscreen: Boolean(state.inspectorFullscreen),
      inert: rightPodInert && state.rightPodMode.kind === 'closed',
      subject,
      activeScopeKey: scopeKey ?? '',
      scope,
      effectiveCompressionRatio,
      subagents,
      selectedSubagent,
      selectedTranscript,
      selectedLogs,
      selectedMessages: selectedMessages.map((m) => ({
        id: m.id,
        rowId: m.rowId,
        role: m.role,
        content: m.content,
        sender: m.sender,
        senderAvatar: m.senderAvatar,
        model: m.model,
        thought: m.thought,
        thoughtDurationMs: m.thoughtDurationMs,
        durationMs: m.durationMs,
        timestamp: m.timestamp,
        displayKind: m.displayKind,
        displayMetadata: m.displayMetadata,
        toolCalls: m.toolCalls?.map((tc) => ({
          id: tc.id,
          name: tc.name,
          status: tc.status,
          args: tc.args,
          rawArgs: tc.rawArgs,
          output: tc.output,
          durationMs: tc.durationMs,
          startedAt: tc.startTime,
          subagentId: tc.subagentId,
          delegationId: tc.delegationId,
        })),
      })),
      listSyncError: state.activeSessionId ? subagentStore.getListSyncError(state.activeSessionId) : undefined,
      steerFeedback,
      locale: state.lang,
    };
  };

  const actions: RightPodActions = {
    onClose: () => applyRightPodAction({ type: 'close' }),
    onToggleFullscreen: () => {
      const state = deps.getState();
      state.inspectorFullscreen = !state.inspectorFullscreen;
      deps.render();
    },
    onOpenFilesAtPath: (filePath?: string) => {
      applyRightPodAction({ type: 'open-files', fromStatusBar: true });
      if (filePath) {
        void deps.openFilePreview(filePath);
      }
    },
    onOpenSubagent: (subagentId: string) => openSubagent(subagentId),
    onBackToStatus: () => applyRightPodAction({ type: 'back-from-subagent' }),
    onInterruptSubagent: (subagentId: string) => {
      const canonical = subagentStore.resolveSubagentId(subagentId);
      if (isSyntheticSubagentId(canonical)) {
        deps.setTimedDockNotice?.(tr('statusPod.subagentIdPending'), 2500);
        return;
      }
      const task = subagentStore.getTask(canonical);
      if (!task || isTerminalLifecycleStatus(task.lifecycleStatus)) {
        deps.setTimedDockNotice?.(tr('statusPod.notFoundOrEnded'), 2500);
        deps.syncRightPod();
        return;
      }
      const state = deps.getState();
      const client = deps.getGatewayClient();
      const liveId = state.activeSessionId ? getLiveSessionId(state.activeSessionId) : null;
      if (!client || !liveId || !state.activeSessionId) {
        deps.setTimedDockNotice?.(tr('statusPod.notFoundOrEnded'), 2500);
        return;
      }
      const profile = resolveActiveProfile(state, state.activeSessionId);
      const bridge = createRpcBridge(client);
      void subagentStore.interruptSubagent(canonical, bridge, { sessionId: liveId, profile }).then((outcome) => {
        if (!outcome.ok && outcome.reason === 'synthetic_id') {
          deps.setTimedDockNotice?.(tr('statusPod.subagentIdPending'), 2500);
        } else if (!outcome.ok && (outcome.reason === 'not_found' || outcome.reason === 'already_ended')) {
          deps.setTimedDockNotice?.(tr('statusPod.notFoundOrEnded'), 2500);
        } else if (!outcome.ok && outcome.error) {
          deps.setTimedDockNotice?.(outcome.error, 3000);
        }
        deps.syncRightPod();
        deps.syncTitlebar();
      });
      deps.syncRightPod();
    },
    onSteerSubagent: async (subagentId: string, instruction: string): Promise<boolean> => {
      const canonical = subagentStore.resolveSubagentId(subagentId);
      if (isSyntheticSubagentId(canonical)) {
        steerFeedback = {
          subagentId: canonical,
          status: 'error',
          message: tr('statusPod.subagentIdPending'),
          at: Date.now(),
        };
        deps.syncRightPod();
        return false;
      }
      const task = subagentStore.getTask(canonical);
      if (!task || isTerminalLifecycleStatus(task.lifecycleStatus)) {
        steerFeedback = {
          subagentId: canonical,
          status: 'error',
          message: tr('statusPod.notFoundOrEnded'),
          at: Date.now(),
        };
        deps.syncRightPod();
        return false;
      }
      const state = deps.getState();
      const client = deps.getGatewayClient();
      const liveId = state.activeSessionId ? getLiveSessionId(state.activeSessionId) : null;
      if (!client || !liveId || !state.activeSessionId) {
        steerFeedback = {
          subagentId: canonical,
          status: 'error',
          message: tr('statusPod.notFoundOrEnded'),
          at: Date.now(),
        };
        deps.syncRightPod();
        return false;
      }
      const profile = resolveActiveProfile(state, state.activeSessionId);
      const outcome = await subagentStore.steerSubagent(canonical, instruction, createRpcBridge(client), {
        sessionId: liveId,
        profile,
      });
      if (!outcome.ok) {
        steerFeedback = { subagentId: canonical, status: 'error', message: outcome.error, at: Date.now() };
        deps.syncRightPod();
        return false;
      }
      if (outcome.status === 'rejected') {
        steerFeedback = { subagentId: canonical, status: 'rejected', message: tr('statusPod.steerRejected'), at: Date.now() };
        deps.syncRightPod();
        return false;
      }
      steerFeedback = null;
      deps.syncRightPod();
      return true;
    },
    onLoadBreakdown: () => {
      void loadBreakdownForCurrentSession();
    },
    onCopyText: async (text: string): Promise<boolean> => {
      try {
        if (deps.writeClipboardText) {
          await deps.writeClipboardText(text);
          return true;
        }
        if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(text);
          return true;
        }
      // gate-degrade: 剪贴板写入失败或接口缺失时向用户显式提示失败并返回 false，禁止伪造“已复制”
      } catch {}
      deps.setTimedDockNotice?.(tr('statusPod.copyFailed'), 2500);
      return false;
    },
    onQuoteToMain: (text: string) => {
      deps.insertQuoteToComposer(text);
    },
    onOpenConstellation: deps.onOpenConstellation
      ? (profileName: string) => {
          deps.onOpenConstellation?.(profileName);
        }
      : undefined,
  };

  return {
    statusStore,
    subagentStore,
    applyRightPodAction,
    getRightPodSnapshot,
    getRightPodActions: () => actions,
    getRunningSubagentCount: () => subagentStore.getRunningCount(),
    getLiveSessionId,
    onConnected,
    onDisconnected,
    onSessionActivated,
    onSessionMessagesLoaded,
    onLiveSessionReady,
    onGroupActivated,
    onSessionDeleted,
    onGatewayTurnAction,
    openSubagent,
    syncPollingForCurrentMode,
    loadBreakdownForCurrentSession,
    dispose: () => {
      stopDetailPolling();
      stopGroupPolling();
    },
  };
}
