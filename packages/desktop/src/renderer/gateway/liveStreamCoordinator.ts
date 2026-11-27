/**
 * Hermes Flux 多端/并发实时流式协同协调器 (Live Stream Coordinator)
 *
 * 【设计意图 (Why)】
 *   将断线/退出重进后的在途回合接管（`attachLiveTurnFromResume`）、看门狗探活前向对账
 *   （`reconcileActiveTurnFromResume`）、观察端远端发起流自动挂载与用户气泡/在途快照非阻塞补齐
 *   （`ensureRemoteObserverStream` / `hydrateRemoteTurnUserMessage`）、以及空闲期 `sessions.changed`
 *   防抖同步从 `gatewayEventDispatcher.ts` 拆出，确保模块高内聚且单文件规模严格可控。
 *
 * 【防范的历史坑 (Pitfall)】
 *   1. `session.resume` 在大历史会话上默认返回全量消息列表，非激活/轻量探测必须传 `omit_messages: true`
 *      并附带 `Extra inputs` 兼容降级，防止带宽与主线程解析阻塞；
 *   2. 远端补齐异步返回前流可能已被完成、切换或断连，`hydrateRemoteTurnUserMessage` 必须同时核对
 *      `connectionEpoch`、网关实例与 `stream.messageId` 三重守卫；
 *   3. `sessions.changed` 高频广播需防抖且仅在聚焦会话处于空闲态时刷新，避免与本地流式态产生竞态抖动。
 *
 * 【约束与规则 (Rules)】
 *   - 严格 TypeScript 类型推导，禁用不安全类型断言；
 *   - 单向依赖：仅依赖 `@hermes-flux/core`、`@hermes-flux/ui` 与注入回调；
 *   - 定时器统一 `.unref?.()` 并在断开时清理，杜绝测试进程句柄泄漏。
 */

import {
  type HermesGatewayClient,
  type LiveStreamRegistry,
  type LiveSessionStream,
  type SessionHandleRegistry,
  readSessionHandles,
  extractResumeInflightState,
  planRemoteUserPromptInsert,
} from '@hermes-flux/core';
import type { MessageViewModel } from '@hermes-flux/ui';
import {
  resolveScopedBotRuntimeKey,
  resolveScopedEntityRuntimeKey,
  type AppState,
} from '../state/appState.js';
import type { ActiveStreamingContext } from '../services/turnExecutionService.js';
import { formatTimestamp } from '../services/turnExecutionService.js';
import { parseTranscriptRows } from '../transcriptRows.js';

/** 判断入站事件或重连恢复是否归属于当前激活网关。 */
export function isSameActiveGateway(
  state: Pick<AppState, 'activeFocus' | 'activeGatewayId' | 'gatewayCount'>,
  gatewayId?: string,
): boolean {
  if (!gatewayId || (state.gatewayCount ?? 1) < 2) return true;
  const activeGw = state.activeFocus?.gatewayId || state.activeGatewayId;
  return !activeGw || activeGw === gatewayId;
}

/** 多网关下仅当会话 ID 与所属网关同源时才认定为当前聚焦会话。 */
export function isFocusedOnEntity(
  state: Pick<AppState, 'activeSessionId' | 'activeFocus' | 'activeGatewayId' | 'gatewayCount'>,
  sessionId: string | null | undefined,
  sourceGatewayId?: string,
): boolean {
  if (!sessionId || state.activeSessionId !== sessionId) return false;
  if ((state.gatewayCount ?? 1) < 2 || !sourceGatewayId) return true;
  return (state.activeFocus?.gatewayId || state.activeGatewayId) === sourceGatewayId;
}

/** 多网关下仅当 Bot 名与所属网关同源时才认定为当前聚焦 Bot。 */
export function isFocusedOnBot(
  state: Pick<AppState, 'activeFocus' | 'activeGatewayId' | 'gatewayCount'>,
  botName: string | null | undefined,
  sourceGatewayId?: string,
): boolean {
  if (!botName || state.activeFocus.type !== 'bot' || state.activeFocus.botName !== botName) return false;
  if ((state.gatewayCount ?? 1) < 2 || !sourceGatewayId) return true;
  return (state.activeFocus.gatewayId || state.activeGatewayId) === sourceGatewayId;
}

/** 按网关前缀过滤并还原原始会话 ID 列表，防止跨网关活跃流集合互相串台。 */
export function collectGatewayScopedSessionIds(
  sessionIds: Iterable<string>,
  gatewayId: string | undefined,
  gatewayCount?: number,
): string[] {
  const result: string[] = [];
  if (!gatewayId || (gatewayCount ?? 1) < 2) {
    for (const id of sessionIds) result.push(id);
    return result;
  }
  const prefix = `${gatewayId}::`;
  for (const id of sessionIds) {
    if (id.startsWith(prefix)) result.push(id.slice(prefix.length));
  }
  return result;
}

/** 提取下行事件帧的类型、载荷与会话标识。 */
export function extractGatewayFrameMeta(params: unknown): {
  frameType: string;
  framePayload: Record<string, unknown> | null;
  rawFrameSessionId: string;
} {
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
  return { frameType, framePayload, rawFrameSessionId };
}

export interface LiveStreamCoordinatorDeps {
  readonly getConnectionEpoch: () => number;
  readonly getState: () => AppState;
  readonly getGatewayClient: () => HermesGatewayClient | null;
  readonly getClientForGateway?: (gatewayId?: string) => HermesGatewayClient | null;
  readonly getLiveStreamRegistry: () => LiveStreamRegistry | undefined;
  readonly getLiveStreamRegistryForGateway?: (gatewayId?: string) => LiveStreamRegistry | undefined;
  readonly getSessionHandleRegistryForGateway?: (gatewayId?: string) => SessionHandleRegistry;
  readonly resolveBotNameForSession?: (storedSessionId: string, gatewayId?: string) => string | null;
  readonly getSessionMessagesCache: () => Map<string, MessageViewModel[]>;
  readonly getActiveRunningSessionIds: () => Set<string>;
  readonly getActiveRunningBotNames: () => Set<string>;
  readonly setActiveStreamingContext: (ctx: Partial<ActiveStreamingContext>) => void;
  readonly setTurnStartedSessionId: (id: string | null) => void;
  readonly toStoredSessionId: (id: string | null | undefined) => string | null;
  readonly setMessageContent: (messageId: string, content: string) => void;
  readonly dropQueuedTokens?: (messageId: string) => void;
  readonly armTurnWatchdog: () => void;
  readonly disarmTurnWatchdog: () => void;
  readonly clearPresenceTerminal: () => void;
  readonly syncAgentPresence: () => void;
  readonly render: () => void;
  readonly refreshActiveSession?: (opts?: { forceRefreshAfterReconnect?: boolean; checkLiveTurn?: boolean }) => Promise<void>;
  readonly onForceSyncMessageList?: (force?: boolean) => void;
  readonly ensureMessageWindow?: (totalCount: number) => void;
  readonly setMessageWindowUserExpanded?: (val: boolean) => void;
  readonly isStreamNearBottom?: () => boolean;
  readonly setPendingScrollToBottom?: (val: boolean) => void;
}

export interface LiveStreamCoordinator {
  clearActiveSessionSyncTimer(): void;
  clearHydrationState(): void;
  resolveStoredSessionId(rawId?: string | null, gatewayId?: string): string | null;
  scheduleActiveSessionIdleSync(delayMs?: number): void;
  insertRemoteUserPromptIfMissing(
    storedSessionId: string,
    assistantMessageId: string,
    userText: string,
    userRowId?: number | null,
    gatewayId?: string,
  ): boolean;
  syncFocusedStreamingProjection(preferredSessionId?: string, gatewayId?: string): void;
  attachLiveTurnFromResume(input: {
    storedSessionId: string;
    liveSessionId: string;
    resumeResult: Record<string, unknown>;
    botName?: string | null;
    gatewayId?: string;
  }): boolean;
  reconcileActiveTurnFromResume(storedSessionId: string, resumeResult: Record<string, unknown>, gatewayId?: string): void;
  ensureRemoteObserverStream(
    storedSessionId: string,
    liveSessionId: string,
    startInfo?: { turnId?: string; userText?: string },
    gatewayId?: string,
  ): LiveSessionStream | undefined;
}

/** 解析会话归属的专职 Bot（Bot Forever Chat 映射或当前 Bot 焦点，兼容多网关复合键）。 */
export function resolveBotNameForSession(
  storedSessionId: string,
  botForeverChatCache: ReadonlyMap<string, string>,
  state: Pick<AppState, 'activeFocus' | 'activeSessionId'> & Partial<Pick<AppState, 'activeGatewayId' | 'gatewayCount'>>,
  gatewayId?: string,
): string | null {
  const targetGw =
    gatewayId ??
    ((state.gatewayCount ?? 1) >= 2 ? (state.activeFocus.gatewayId || state.activeGatewayId) : undefined);
  let fallbackMatch: string | null = null;
  for (const [cacheKey, foreverId] of botForeverChatCache.entries()) {
    if (foreverId !== storedSessionId) continue;
    const colonIdx = cacheKey.indexOf(':');
    if (colonIdx > 0) {
      const keyGw = cacheKey.slice(0, colonIdx);
      const plainBot = cacheKey.slice(colonIdx + 1);
      if (gatewayId && keyGw !== gatewayId) continue;
      if (!targetGw || keyGw === targetGw) return plainBot;
      if (!fallbackMatch) fallbackMatch = plainBot;
    } else if (!fallbackMatch) {
      fallbackMatch = cacheKey;
    }
  }
  if (fallbackMatch) return fallbackMatch;
  if (state.activeFocus.type === 'bot' && state.activeSessionId === storedSessionId) {
    if (!gatewayId || (state.gatewayCount ?? 1) < 2 || !state.activeFocus.gatewayId || state.activeFocus.gatewayId === gatewayId) {
      return state.activeFocus.botName;
    }
  }
  return null;
}

export function createLiveStreamCoordinator(deps: LiveStreamCoordinatorDeps): LiveStreamCoordinator {
  let remoteBubbleSeq = 0;
  const hydratingRemoteSessions = new Set<string>();
  let activeSessionSyncTimer: ReturnType<typeof setTimeout> | null = null;

  const resolveStreamRegistry = (gatewayId?: string): LiveStreamRegistry | undefined =>
    deps.getLiveStreamRegistryForGateway?.(gatewayId) ?? deps.getLiveStreamRegistry();

  const resolveClient = (gatewayId?: string): HermesGatewayClient | null =>
    deps.getClientForGateway ? deps.getClientForGateway(gatewayId) : deps.getGatewayClient();

  function clearActiveSessionSyncTimer(): void {
    if (activeSessionSyncTimer) {
      clearTimeout(activeSessionSyncTimer);
      activeSessionSyncTimer = null;
    }
  }

  function clearHydrationState(): void {
    hydratingRemoteSessions.clear();
  }

  function resolveStoredSessionId(rawId?: string | null, gatewayId?: string): string | null {
    if (!rawId) return null;
    const streamRegistry = resolveStreamRegistry(gatewayId);
    if (streamRegistry) {
      if (streamRegistry.hasSession(rawId)) return rawId;
      for (const sid of streamRegistry.listSessionIds()) {
        if (streamRegistry.getBySession(sid)?.liveSessionId === rawId) {
          return sid;
        }
      }
    }
    const mapped =
      (gatewayId ? deps.getSessionHandleRegistryForGateway?.(gatewayId).toStoredId(rawId) : null) ??
      deps.toStoredSessionId(rawId);
    if (mapped && streamRegistry?.hasSession(mapped)) {
      return mapped;
    }
    const state = deps.getState();
    const activeGw = state.activeFocus?.gatewayId || state.activeGatewayId;
    const matchesFocusGw = !gatewayId || (state.gatewayCount ?? 1) < 2 || activeGw === gatewayId;
    if (matchesFocusGw && state.activeLiveSessionId && rawId === state.activeLiveSessionId && state.activeSessionId) {
      return state.activeSessionId;
    }
    return mapped || rawId;
  }

  function readSessionMessages(storedSessionId: string, gatewayId?: string): MessageViewModel[] {
    const state = deps.getState();
    if (isFocusedOnEntity(state, storedSessionId, gatewayId)) {
      return state.messages;
    }
    const cacheKey = resolveScopedEntityRuntimeKey(storedSessionId, gatewayId, state.gatewayCount);
    return deps.getSessionMessagesCache().get(cacheKey) || [];
  }

  function commitSessionMessages(storedSessionId: string, nextMessages: MessageViewModel[], gatewayId?: string): void {
    const state = deps.getState();
    const cacheKey = resolveScopedEntityRuntimeKey(storedSessionId, gatewayId, state.gatewayCount);
    deps.getSessionMessagesCache().set(cacheKey, nextMessages);
    if (isFocusedOnEntity(state, storedSessionId, gatewayId)) {
      state.messages = nextMessages;
    }
  }

  function scheduleActiveSessionIdleSync(delayMs = 150): void {
    if (!deps.refreshActiveSession) return;
    const state = deps.getState();
    const activeGw = state.activeFocus?.gatewayId || state.activeGatewayId;
    const streamRegistry = resolveStreamRegistry(activeGw);
    if (!state.gatewayConnected || !state.activeSessionId || state.activeFocus.type === 'group') return;
    if (state.isStreaming || streamRegistry?.hasSession(state.activeSessionId)) return;
    const targetEpoch = deps.getConnectionEpoch();
    clearActiveSessionSyncTimer();
    activeSessionSyncTimer = setTimeout(() => {
      activeSessionSyncTimer = null;
      if (targetEpoch !== deps.getConnectionEpoch()) return;
      const curState = deps.getState();
      const curGw = curState.activeFocus?.gatewayId || curState.activeGatewayId;
      if (!curState.gatewayConnected || !curState.activeSessionId || curState.activeFocus.type === 'group') return;
      if (curState.isStreaming || resolveStreamRegistry(curGw)?.hasSession(curState.activeSessionId)) return;
      void deps.refreshActiveSession?.({ checkLiveTurn: true });
    }, delayMs);
    activeSessionSyncTimer.unref?.();
  }

  function ensureAssistantMessagePresent(
    storedSessionId: string,
    messageId: string,
    initialContent: string,
    startedAtMs: number,
    gatewayId?: string,
  ): boolean {
    const current = readSessionMessages(storedSessionId, gatewayId);
    if (current.some((m) => m.id === messageId)) return false;
    commitSessionMessages(storedSessionId, [
      ...current,
      {
        id: messageId,
        role: 'assistant',
        content: initialContent,
        timestamp: formatTimestamp(startedAtMs),
      },
    ], gatewayId);
    return true;
  }

  function insertRemoteUserPromptIfMissing(
    storedSessionId: string,
    assistantMessageId: string,
    userText: string,
    userRowId?: number | null,
    gatewayId?: string,
  ): boolean {
    const list = [...readSessionMessages(storedSessionId, gatewayId)];
    const plan = planRemoteUserPromptInsert(list, {
      assistantMessageId,
      userText,
      userRowId,
    });
    if (!plan) return false;
    const streamRegistry = resolveStreamRegistry(gatewayId);
    if (plan.kind === 'already-present') {
      if (plan.bindRowId !== undefined && list[plan.existingIndex]) {
        list[plan.existingIndex] = { ...list[plan.existingIndex], rowId: plan.bindRowId };
        commitSessionMessages(storedSessionId, list, gatewayId);
        streamRegistry?.markUserSynced(storedSessionId);
        return true;
      }
      streamRegistry?.markUserSynced(storedSessionId);
      return false;
    }
    const validRowId =
      typeof userRowId === 'number' && Number.isInteger(userRowId) && userRowId > 0 ? userRowId : undefined;
    list.splice(plan.insertIndex, 0, {
      id: `msg-remote-user-${storedSessionId}-${Date.now()}-${++remoteBubbleSeq}`,
      role: 'user',
      content: userText,
      ...(validRowId !== undefined ? { rowId: validRowId } : {}),
      timestamp: formatTimestamp(Date.now()),
    });
    commitSessionMessages(storedSessionId, list, gatewayId);
    streamRegistry?.markUserSynced(storedSessionId);
    return true;
  }

  function applyReconciledAssistantText(
    streamRegistry: LiveStreamRegistry,
    stream: LiveSessionStream,
    inflightAssistant: string,
    gatewayId?: string,
  ): boolean {
    const rec = streamRegistry.reconcileInflightText(stream.storedSessionId, inflightAssistant);
    if (rec.mode === 'noop') return false;
    const nextText = stream.accumulatedText;
    deps.dropQueuedTokens?.(stream.messageId);
    const state = deps.getState();
    if (isFocusedOnEntity(state, stream.storedSessionId, gatewayId)) {
      deps.setMessageContent(stream.messageId, nextText);
    }
    const cacheKey = resolveScopedEntityRuntimeKey(stream.storedSessionId, gatewayId, state.gatewayCount);
    const cached = deps.getSessionMessagesCache().get(cacheKey);
    const cachedMsg = cached?.find((m) => m.id === stream.messageId);
    if (cachedMsg) cachedMsg.content = nextText;
    return true;
  }

  function syncFocusedStreamingProjection(preferredSessionId?: string, gatewayId?: string): void {
    const state = deps.getState();
    const targetGw = gatewayId ?? (state.activeFocus?.gatewayId || state.activeGatewayId);
    const streamRegistry = resolveStreamRegistry(targetGw);
    if (!streamRegistry) return;
    const targetSid = preferredSessionId ?? state.activeSessionId;
    const stream = targetSid ? streamRegistry.getBySession(targetSid) : undefined;
    if (targetSid && stream && isFocusedOnEntity(state, targetSid, targetGw)) {
      ensureAssistantMessagePresent(targetSid, stream.messageId, stream.accumulatedText, stream.startedAt, targetGw);
      state.isStreaming = true;
      if (stream.liveSessionId) state.activeLiveSessionId = stream.liveSessionId;
      state.turnStartedAt = stream.startedAt;
      deps.setTurnStartedSessionId(stream.storedSessionId);
      deps.setActiveStreamingContext({
        activeStreamingMessageId: stream.messageId,
        activeStreamingStoredSessionId: stream.storedSessionId,
        activeStreamingLiveId: stream.liveSessionId,
        activeStreamingBotName: stream.botName,
      });
      deps.clearPresenceTerminal();
      deps.armTurnWatchdog();
      return;
    }
    if (!stream && (!targetSid || isFocusedOnEntity(state, targetSid, targetGw))) {
      state.isStreaming = false;
      state.turnStartedAt = undefined;
      deps.setTurnStartedSessionId(null);
      deps.setActiveStreamingContext({
        activeStreamingMessageId: null,
        activeStreamingStoredSessionId: null,
        activeStreamingLiveId: null,
        activeStreamingBotName: null,
      });
      if (streamRegistry.size() === 0) {
        deps.disarmTurnWatchdog();
      }
    }
  }

  async function callSessionResumeQuick(
    client: HermesGatewayClient,
    storedSessionId: string,
    profile: string,
  ): Promise<Record<string, unknown> | null> {
    try {
      return await client.call<Record<string, unknown>>('session.resume', {
        session_id: storedSessionId,
        profile,
        omit_messages: true,
      });
    } catch (firstErr: unknown) {
      const msg = firstErr instanceof Error ? firstErr.message : String(firstErr);
      if (!msg.includes('Extra inputs')) throw firstErr;
      try {
        return await client.call<Record<string, unknown>>('session.resume', {
          session_id: storedSessionId,
          profile,
        });
      } catch (secondErr: unknown) {
        const msg2 = secondErr instanceof Error ? secondErr.message : String(secondErr);
        if (!msg2.includes('Extra inputs')) throw secondErr;
        return await client.call<Record<string, unknown>>('session.resume', { session_id: storedSessionId });
      }
    }
  }

  async function hydrateRemoteTurnUserMessage(
    storedSessionId: string,
    assistantMessageId: string,
    botName: string | null,
    gatewayId?: string,
  ): Promise<void> {
    const initialState = deps.getState();
    const hydratingKey = resolveScopedEntityRuntimeKey(storedSessionId, gatewayId, initialState.gatewayCount);
    if (hydratingRemoteSessions.has(hydratingKey)) return;
    const client = resolveClient(gatewayId);
    const streamRegistry = resolveStreamRegistry(gatewayId);
    if (!client || !streamRegistry) return;

    hydratingRemoteSessions.add(hydratingKey);
    const targetEpoch = deps.getConnectionEpoch();
    try {
      const state = deps.getState();
      const matchedSession =
        state.sessions.find(
          (s) => s.id === storedSessionId && (!gatewayId || !s.gatewayId || s.gatewayId === gatewayId),
        ) ?? state.sessions.find((s) => s.id === storedSessionId);
      const resolvedProfile = botName || matchedSession?.botName || state.profileName || 'default';
      const resumeRes = await callSessionResumeQuick(client, storedSessionId, resolvedProfile);
      if (targetEpoch !== deps.getConnectionEpoch() || resolveClient(gatewayId) !== client) return;

      const curStream = streamRegistry.getBySession(storedSessionId);
      if (!curStream || curStream.messageId !== assistantMessageId) return;

      const resumeState = extractResumeInflightState(resumeRes);
      let mutated = false;
      if (resumeState.inflightUser && !curStream.userMessageSynced) {
        mutated = insertRemoteUserPromptIfMissing(
          storedSessionId,
          assistantMessageId,
          resumeState.inflightUser,
          undefined,
          gatewayId,
        );
      } else if (!curStream.userMessageSynced && typeof client.fetchSessionMessages === 'function') {
        const outcome = await client.fetchSessionMessages(storedSessionId, {
          limit: 10,
          order: 'latest',
          profile: resolvedProfile,
        });
        if (targetEpoch !== deps.getConnectionEpoch() || resolveClient(gatewayId) !== client) return;
        const stillStream = streamRegistry.getBySession(storedSessionId);
        if (!stillStream || stillStream.messageId !== assistantMessageId) return;
        if (outcome.status === 'success' && outcome.messages.length > 0) {
          const parsed = parseTranscriptRows(outcome.messages, {
            scope: { isGroupRoom: false, isBotRoom: Boolean(botName) },
            formatTimestamp,
          });
          for (let i = parsed.length - 1; i >= 0; i -= 1) {
            if (parsed[i].role === 'user' && parsed[i].content.trim()) {
              mutated = insertRemoteUserPromptIfMissing(
                storedSessionId,
                assistantMessageId,
                parsed[i].content,
                parsed[i].rowId,
                gatewayId,
              );
              break;
            }
          }
        }
      }

      if (resumeState.inflightAssistant) {
        mutated =
          applyReconciledAssistantText(streamRegistry, curStream, resumeState.inflightAssistant, gatewayId) || mutated;
      }

      if (mutated && isFocusedOnEntity(deps.getState(), storedSessionId, gatewayId)) {
        deps.ensureMessageWindow?.(readSessionMessages(storedSessionId, gatewayId).length);
        deps.onForceSyncMessageList?.(true);
        deps.render();
        deps.syncAgentPresence();
      }
    } catch (err) {
      console.debug('[live-stream] non-blocking remote hydration deferred', err);
    } finally {
      hydratingRemoteSessions.delete(hydratingKey);
    }
  }

  function attachLiveTurnFromResume(input: {
    storedSessionId: string;
    liveSessionId: string;
    resumeResult: Record<string, unknown>;
    botName?: string | null;
    gatewayId?: string;
  }): boolean {
    const state = deps.getState();
    const targetGw = input.gatewayId ?? (state.activeFocus?.gatewayId || state.activeGatewayId);
    const streamRegistry = resolveStreamRegistry(targetGw);
    if (!streamRegistry) return false;
    const resumeState = extractResumeInflightState(input.resumeResult);
    if (!resumeState.isRunning) return false;

    const scopedSessionKey = resolveScopedEntityRuntimeKey(input.storedSessionId, targetGw, state.gatewayCount);
    const resolvedBotName =
      input.botName ?? deps.resolveBotNameForSession?.(input.storedSessionId, targetGw) ?? null;
    const scopedBotKey = resolvedBotName
      ? resolveScopedBotRuntimeKey(resolvedBotName, targetGw, state.gatewayCount)
      : '';
    const existing = streamRegistry.getBySession(input.storedSessionId);
    const isFocused = isFocusedOnEntity(state, input.storedSessionId, targetGw);

    if (existing) {
      if (input.liveSessionId) streamRegistry.updateLiveId(input.storedSessionId, input.liveSessionId);
      if (!existing.botName && resolvedBotName) existing.botName = resolvedBotName;
      let changed = false;
      if (!existing.userMessageSynced && resumeState.inflightUser) {
        changed = insertRemoteUserPromptIfMissing(
          input.storedSessionId,
          existing.messageId,
          resumeState.inflightUser,
          undefined,
          targetGw,
        );
      }
      if (ensureAssistantMessagePresent(
        input.storedSessionId,
        existing.messageId,
        existing.accumulatedText,
        existing.startedAt,
        targetGw,
      )) {
        changed = true;
      }
      if (resumeState.inflightAssistant && applyReconciledAssistantText(
        streamRegistry,
        existing,
        resumeState.inflightAssistant,
        targetGw,
      )) {
        changed = true;
      }
      deps.getActiveRunningSessionIds().add(scopedSessionKey);
      const existingBotKey = existing.botName
        ? resolveScopedBotRuntimeKey(existing.botName, targetGw, state.gatewayCount)
        : '';
      if (existingBotKey) deps.getActiveRunningBotNames().add(existingBotKey);
      if (isFocused) {
        syncFocusedStreamingProjection(input.storedSessionId, targetGw);
        if (changed) {
          deps.ensureMessageWindow?.(readSessionMessages(input.storedSessionId, targetGw).length);
          deps.onForceSyncMessageList?.(true);
          deps.render();
        }
        deps.syncAgentPresence();
      }
      return true;
    }

    const list = [...readSessionMessages(input.storedSessionId, targetGw)];
    const startedAtMs = resumeState.turnStartedAtMs ?? Date.now();
    const tail = list.length > 0 ? list[list.length - 1] : undefined;
    const canReuseTail = Boolean(
      tail &&
      tail.role === 'assistant' &&
      tail.rowId === undefined &&
      (!resumeState.inflightAssistant || resumeState.inflightAssistant.startsWith(tail.content)),
    );
    const assistantMsg: MessageViewModel = canReuseTail && tail
      ? {
          ...tail,
          content:
            resumeState.inflightAssistant && resumeState.inflightAssistant.length > tail.content.length
              ? resumeState.inflightAssistant
              : tail.content,
        }
      : {
          id: `msg-live-${input.storedSessionId}-${Date.now()}-${++remoteBubbleSeq}`,
          role: 'assistant',
          content: resumeState.inflightAssistant || '',
          timestamp: formatTimestamp(startedAtMs),
        };
    if (canReuseTail) {
      deps.dropQueuedTokens?.(assistantMsg.id);
      list[list.length - 1] = assistantMsg;
    } else {
      list.push(assistantMsg);
    }
    commitSessionMessages(input.storedSessionId, list, targetGw);

    let insertedUser = false;
    if (resumeState.inflightUser) {
      insertedUser = insertRemoteUserPromptIfMissing(
        input.storedSessionId,
        assistantMsg.id,
        resumeState.inflightUser,
        undefined,
        targetGw,
      );
    }

    streamRegistry.registerStream({
      storedSessionId: input.storedSessionId,
      liveSessionId: input.liveSessionId || input.storedSessionId,
      messageId: assistantMsg.id,
      botName: resolvedBotName,
      origin: 'remote',
      startedAt: startedAtMs,
      initialContent: assistantMsg.content,
      userMessageSynced: Boolean(resumeState.inflightUser) || insertedUser,
    });

    deps.getActiveRunningSessionIds().add(scopedSessionKey);
    if (scopedBotKey) {
      deps.getActiveRunningBotNames().add(scopedBotKey);
    }

    if (isFocused) {
      const finalList = readSessionMessages(input.storedSessionId, targetGw);
      syncFocusedStreamingProjection(input.storedSessionId, targetGw);
      deps.setMessageWindowUserExpanded?.(false);
      deps.ensureMessageWindow?.(finalList.length);
      if (deps.isStreamNearBottom?.() ?? true) {
        deps.setPendingScrollToBottom?.(true);
      }
      deps.onForceSyncMessageList?.(true);
      deps.render();
      deps.syncAgentPresence();
    }
    return true;
  }

  function reconcileActiveTurnFromResume(
    storedSessionId: string,
    resumeResult: Record<string, unknown>,
    gatewayId?: string,
  ): void {
    const state = deps.getState();
    const targetGw = gatewayId ?? (state.activeFocus?.gatewayId || state.activeGatewayId);
    const streamRegistry = resolveStreamRegistry(targetGw);
    const handles = readSessionHandles(resumeResult, storedSessionId);
    const liveSessionId = handles?.liveId || storedSessionId;
    if (!streamRegistry?.hasSession(storedSessionId)) {
      attachLiveTurnFromResume({
        storedSessionId,
        liveSessionId,
        resumeResult,
        botName: deps.resolveBotNameForSession?.(storedSessionId, targetGw) ?? null,
        gatewayId: targetGw,
      });
      return;
    }
    const explicitLiveId =
      typeof resumeResult.session_id === 'string' && resumeResult.session_id
        ? resumeResult.session_id
        : typeof resumeResult.live_id === 'string' && resumeResult.live_id
          ? resumeResult.live_id
          : typeof resumeResult.sessionId === 'string' && resumeResult.sessionId
            ? resumeResult.sessionId
            : '';
    if (explicitLiveId) streamRegistry.updateLiveId(storedSessionId, explicitLiveId);
    const resumeState = extractResumeInflightState(resumeResult);
    const stream = streamRegistry.getBySession(storedSessionId);
    const focused = isFocusedOnEntity(deps.getState(), storedSessionId, targetGw);
    if (stream && resumeState.isRunning) {
      streamRegistry.touchActivity(storedSessionId);
      if (resumeState.inflightAssistant) {
        const changed = applyReconciledAssistantText(
          streamRegistry,
          stream,
          resumeState.inflightAssistant,
          targetGw,
        );
        if (changed && focused) {
          deps.onForceSyncMessageList?.(true);
          deps.render();
        }
      }
    }
    if (focused) {
      syncFocusedStreamingProjection(storedSessionId, targetGw);
      deps.syncAgentPresence();
    }
  }

  function ensureRemoteObserverStream(
    storedSessionId: string,
    liveSessionId: string,
    startInfo?: { turnId?: string; userText?: string },
    gatewayId?: string,
  ): LiveSessionStream | undefined {
    const state = deps.getState();
    const targetGw = gatewayId;
    const streamRegistry = resolveStreamRegistry(targetGw);
    if (!streamRegistry) return undefined;
    const scopedSessionKey = resolveScopedEntityRuntimeKey(storedSessionId, targetGw, state.gatewayCount);
    const existing = streamRegistry.getBySession(storedSessionId);
    if (existing) {
      if (liveSessionId) streamRegistry.updateLiveId(storedSessionId, liveSessionId);
      if (startInfo?.turnId && !existing.turnId) existing.turnId = startInfo.turnId;
      if (startInfo?.userText && !existing.userMessageSynced) {
        const inserted = insertRemoteUserPromptIfMissing(
          storedSessionId,
          existing.messageId,
          startInfo.userText,
          undefined,
          targetGw,
        );
        if (inserted && isFocusedOnEntity(deps.getState(), storedSessionId, targetGw)) {
          deps.ensureMessageWindow?.(readSessionMessages(storedSessionId, targetGw).length);
          deps.onForceSyncMessageList?.(true);
          deps.render();
        }
      }
      return existing;
    }

    const nowMs = Date.now();
    const list = [...readSessionMessages(storedSessionId, targetGw)];
    const assistantMsg: MessageViewModel = {
      id: `msg-live-${storedSessionId}-${nowMs}-${++remoteBubbleSeq}`,
      role: 'assistant',
      content: '',
      timestamp: formatTimestamp(nowMs),
    };
    list.push(assistantMsg);
    commitSessionMessages(storedSessionId, list, targetGw);

    let userSynced = false;
    if (startInfo?.userText) {
      userSynced = insertRemoteUserPromptIfMissing(
        storedSessionId,
        assistantMsg.id,
        startInfo.userText,
        undefined,
        targetGw,
      );
    }

    const botName = deps.resolveBotNameForSession?.(storedSessionId, targetGw) ?? null;
    const stream = streamRegistry.registerStream({
      storedSessionId,
      liveSessionId: liveSessionId || storedSessionId,
      messageId: assistantMsg.id,
      botName,
      origin: 'remote',
      startedAt: nowMs,
      turnId: startInfo?.turnId ?? null,
      initialContent: '',
      userMessageSynced: userSynced,
      nowMs,
    });

    deps.getActiveRunningSessionIds().add(scopedSessionKey);
    if (botName) {
      deps.getActiveRunningBotNames().add(resolveScopedBotRuntimeKey(botName, targetGw, state.gatewayCount));
    }

    if (isFocusedOnEntity(deps.getState(), storedSessionId, targetGw)) {
      syncFocusedStreamingProjection(storedSessionId, targetGw);
      deps.setMessageWindowUserExpanded?.(false);
      deps.ensureMessageWindow?.(readSessionMessages(storedSessionId, targetGw).length);
      if (deps.isStreamNearBottom?.() ?? true) {
        deps.setPendingScrollToBottom?.(true);
      }
      deps.onForceSyncMessageList?.(true);
      deps.render();
      deps.syncAgentPresence();
    }

    if (!userSynced) {
      void hydrateRemoteTurnUserMessage(storedSessionId, assistantMsg.id, botName, targetGw);
    }
    return stream;
  }

  return {
    clearActiveSessionSyncTimer,
    clearHydrationState,
    resolveStoredSessionId,
    scheduleActiveSessionIdleSync,
    insertRemoteUserPromptIfMissing,
    syncFocusedStreamingProjection,
    attachLiveTurnFromResume,
    reconcileActiveTurnFromResume,
    ensureRemoteObserverStream,
  };
}
