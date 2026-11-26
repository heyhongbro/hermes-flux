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
  readSessionHandles,
  extractResumeInflightState,
  planRemoteUserPromptInsert,
} from '@hermes-flux/core';
import type { MessageViewModel } from '@hermes-flux/ui';
import type { AppState } from '../state/appState.js';
import type { ActiveStreamingContext } from '../services/turnExecutionService.js';
import { formatTimestamp } from '../services/turnExecutionService.js';
import { parseTranscriptRows } from '../transcriptRows.js';

export interface LiveStreamCoordinatorDeps {
  readonly getConnectionEpoch: () => number;
  readonly getState: () => AppState;
  readonly getGatewayClient: () => HermesGatewayClient | null;
  readonly getLiveStreamRegistry: () => LiveStreamRegistry | undefined;
  readonly resolveBotNameForSession?: (storedSessionId: string) => string | null;
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
  readonly onCaptureInteractiveFence?: () => number;
  readonly onInteractiveResumeReconciled?: (input: {
    client: HermesGatewayClient;
    storedSessionId: string;
    liveSessionId: string | null;
    profile?: string;
    resume: Record<string, unknown>;
    fence: number;
  }) => void;
}

export interface LiveStreamCoordinator {
  clearActiveSessionSyncTimer(): void;
  clearHydrationState(): void;
  resolveStoredSessionId(rawId?: string | null): string | null;
  scheduleActiveSessionIdleSync(delayMs?: number): void;
  insertRemoteUserPromptIfMissing(
    storedSessionId: string,
    assistantMessageId: string,
    userText: string,
    userRowId?: number | null,
  ): boolean;
  syncFocusedStreamingProjection(preferredSessionId?: string): void;
  attachLiveTurnFromResume(input: {
    storedSessionId: string;
    liveSessionId: string;
    resumeResult: Record<string, unknown>;
    botName?: string | null;
  }): boolean;
  reconcileActiveTurnFromResume(storedSessionId: string, resumeResult: Record<string, unknown>): void;
  ensureRemoteObserverStream(
    storedSessionId: string,
    liveSessionId: string,
    startInfo?: { turnId?: string; userText?: string },
  ): LiveSessionStream | undefined;
}

/** 解析会话归属的专职 Bot（Bot Forever Chat 映射或当前 Bot 焦点）。 */
export function resolveBotNameForSession(
  storedSessionId: string,
  botForeverChatCache: ReadonlyMap<string, string>,
  state: Pick<AppState, 'activeFocus' | 'activeSessionId'>,
): string | null {
  for (const [botName, foreverId] of botForeverChatCache.entries()) {
    if (foreverId === storedSessionId) return botName;
  }
  return state.activeFocus.type === 'bot' && state.activeSessionId === storedSessionId
    ? state.activeFocus.botName
    : null;
}

export function createLiveStreamCoordinator(deps: LiveStreamCoordinatorDeps): LiveStreamCoordinator {
  let remoteBubbleSeq = 0;
  const hydratingRemoteSessions = new Set<string>();
  let activeSessionSyncTimer: ReturnType<typeof setTimeout> | null = null;

  function clearActiveSessionSyncTimer(): void {
    if (activeSessionSyncTimer) {
      clearTimeout(activeSessionSyncTimer);
      activeSessionSyncTimer = null;
    }
  }

  function clearHydrationState(): void {
    hydratingRemoteSessions.clear();
  }

  function resolveStoredSessionId(rawId?: string | null): string | null {
    if (!rawId) return null;
    const streamRegistry = deps.getLiveStreamRegistry();
    if (streamRegistry) {
      if (streamRegistry.hasSession(rawId)) return rawId;
      for (const sid of streamRegistry.listSessionIds()) {
        if (streamRegistry.getBySession(sid)?.liveSessionId === rawId) {
          return sid;
        }
      }
    }
    const mapped = deps.toStoredSessionId(rawId);
    if (mapped && streamRegistry?.hasSession(mapped)) {
      return mapped;
    }
    const state = deps.getState();
    if (state.activeLiveSessionId && rawId === state.activeLiveSessionId && state.activeSessionId) {
      return state.activeSessionId;
    }
    return mapped || rawId;
  }

  function readSessionMessages(storedSessionId: string): MessageViewModel[] {
    const state = deps.getState();
    if (storedSessionId === state.activeSessionId) {
      return state.messages;
    }
    return deps.getSessionMessagesCache().get(storedSessionId) || [];
  }

  function commitSessionMessages(storedSessionId: string, nextMessages: MessageViewModel[]): void {
    const state = deps.getState();
    deps.getSessionMessagesCache().set(storedSessionId, nextMessages);
    if (storedSessionId === state.activeSessionId) {
      state.messages = nextMessages;
    }
  }

  function scheduleActiveSessionIdleSync(delayMs = 150): void {
    if (!deps.refreshActiveSession) return;
    const state = deps.getState();
    const streamRegistry = deps.getLiveStreamRegistry();
    if (!state.gatewayConnected || !state.activeSessionId || state.activeFocus.type === 'group') return;
    if (state.isStreaming || streamRegistry?.hasSession(state.activeSessionId)) return;
    const targetEpoch = deps.getConnectionEpoch();
    clearActiveSessionSyncTimer();
    activeSessionSyncTimer = setTimeout(() => {
      activeSessionSyncTimer = null;
      if (targetEpoch !== deps.getConnectionEpoch()) return;
      const curState = deps.getState();
      if (!curState.gatewayConnected || !curState.activeSessionId || curState.activeFocus.type === 'group') return;
      if (curState.isStreaming || deps.getLiveStreamRegistry()?.hasSession(curState.activeSessionId)) return;
      void deps.refreshActiveSession?.({ checkLiveTurn: true });
    }, delayMs);
    activeSessionSyncTimer.unref?.();
  }

  function ensureAssistantMessagePresent(
    storedSessionId: string,
    messageId: string,
    initialContent: string,
    startedAtMs: number,
  ): boolean {
    const current = readSessionMessages(storedSessionId);
    if (current.some((m) => m.id === messageId)) return false;
    commitSessionMessages(storedSessionId, [
      ...current,
      {
        id: messageId,
        role: 'assistant',
        content: initialContent,
        timestamp: formatTimestamp(startedAtMs),
      },
    ]);
    return true;
  }

  function insertRemoteUserPromptIfMissing(
    storedSessionId: string,
    assistantMessageId: string,
    userText: string,
    userRowId?: number | null,
  ): boolean {
    const list = [...readSessionMessages(storedSessionId)];
    const plan = planRemoteUserPromptInsert(list, {
      assistantMessageId,
      userText,
      userRowId,
    });
    if (!plan) return false;
    const streamRegistry = deps.getLiveStreamRegistry();
    if (plan.kind === 'already-present') {
      if (plan.bindRowId !== undefined && list[plan.existingIndex]) {
        list[plan.existingIndex] = { ...list[plan.existingIndex], rowId: plan.bindRowId };
        commitSessionMessages(storedSessionId, list);
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
    commitSessionMessages(storedSessionId, list);
    streamRegistry?.markUserSynced(storedSessionId);
    return true;
  }

  function applyReconciledAssistantText(
    streamRegistry: LiveStreamRegistry,
    stream: LiveSessionStream,
    inflightAssistant: string,
  ): boolean {
    const rec = streamRegistry.reconcileInflightText(stream.storedSessionId, inflightAssistant);
    if (rec.mode === 'noop') return false;
    const nextText = stream.accumulatedText;
    deps.dropQueuedTokens?.(stream.messageId);
    if (stream.storedSessionId === deps.getState().activeSessionId) {
      deps.setMessageContent(stream.messageId, nextText);
    }
    const cached = deps.getSessionMessagesCache().get(stream.storedSessionId);
    const cachedMsg = cached?.find((m) => m.id === stream.messageId);
    if (cachedMsg) cachedMsg.content = nextText;
    return true;
  }

  function syncFocusedStreamingProjection(preferredSessionId?: string): void {
    const streamRegistry = deps.getLiveStreamRegistry();
    if (!streamRegistry) return;
    const state = deps.getState();
    const targetSid = preferredSessionId ?? state.activeSessionId;
    const stream = targetSid ? streamRegistry.getBySession(targetSid) : undefined;
    if (targetSid && stream && targetSid === state.activeSessionId) {
      ensureAssistantMessagePresent(targetSid, stream.messageId, stream.accumulatedText, stream.startedAt);
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
    if (!stream && (!targetSid || targetSid === state.activeSessionId)) {
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
  ): Promise<void> {
    if (hydratingRemoteSessions.has(storedSessionId)) return;
    const client = deps.getGatewayClient();
    const streamRegistry = deps.getLiveStreamRegistry();
    if (!client || !streamRegistry) return;

    hydratingRemoteSessions.add(storedSessionId);
    const targetEpoch = deps.getConnectionEpoch();
    try {
      const state = deps.getState();
      const resolvedProfile =
        botName || state.sessions.find((s) => s.id === storedSessionId)?.botName || state.profileName || 'default';
      const interactiveFence = deps.onCaptureInteractiveFence?.() ?? 0;
      const resumeRes = await callSessionResumeQuick(client, storedSessionId, resolvedProfile);
      if (resumeRes) {
        const handles = readSessionHandles(resumeRes, storedSessionId);
        deps.onInteractiveResumeReconciled?.({
          client,
          storedSessionId: handles?.storedId || storedSessionId,
          liveSessionId: handles?.liveId ?? null,
          profile: resolvedProfile,
          resume: resumeRes,
          fence: interactiveFence,
        });
      }
      if (targetEpoch !== deps.getConnectionEpoch() || deps.getGatewayClient() !== client) return;

      const curStream = streamRegistry.getBySession(storedSessionId);
      if (!curStream || curStream.messageId !== assistantMessageId) return;

      const resumeState = extractResumeInflightState(resumeRes);
      let mutated = false;
      if (resumeState.inflightUser && !curStream.userMessageSynced) {
        mutated = insertRemoteUserPromptIfMissing(storedSessionId, assistantMessageId, resumeState.inflightUser);
      } else if (!curStream.userMessageSynced && typeof client.fetchSessionMessages === 'function') {
        const outcome = await client.fetchSessionMessages(storedSessionId, {
          limit: 10,
          order: 'latest',
          profile: resolvedProfile,
        });
        if (targetEpoch !== deps.getConnectionEpoch() || deps.getGatewayClient() !== client) return;
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
              );
              break;
            }
          }
        }
      }

      if (resumeState.inflightAssistant) {
        mutated =
          applyReconciledAssistantText(streamRegistry, curStream, resumeState.inflightAssistant) || mutated;
      }

      if (mutated && storedSessionId === deps.getState().activeSessionId) {
        deps.ensureMessageWindow?.(readSessionMessages(storedSessionId).length);
        deps.onForceSyncMessageList?.(true);
        deps.render();
        deps.syncAgentPresence();
      }
    } catch (err) {
      console.debug('[live-stream] non-blocking remote hydration deferred', err);
    } finally {
      hydratingRemoteSessions.delete(storedSessionId);
    }
  }

  function attachLiveTurnFromResume(input: {
    storedSessionId: string;
    liveSessionId: string;
    resumeResult: Record<string, unknown>;
    botName?: string | null;
  }): boolean {
    const streamRegistry = deps.getLiveStreamRegistry();
    if (!streamRegistry) return false;
    const resumeState = extractResumeInflightState(input.resumeResult);
    if (!resumeState.isRunning) return false;

    const state = deps.getState();
    const resolvedBotName = input.botName ?? deps.resolveBotNameForSession?.(input.storedSessionId) ?? null;
    const existing = streamRegistry.getBySession(input.storedSessionId);
    const isFocused = input.storedSessionId === state.activeSessionId;

    if (existing) {
      if (input.liveSessionId) streamRegistry.updateLiveId(input.storedSessionId, input.liveSessionId);
      if (!existing.botName && resolvedBotName) existing.botName = resolvedBotName;
      let changed = false;
      if (!existing.userMessageSynced && resumeState.inflightUser) {
        changed = insertRemoteUserPromptIfMissing(input.storedSessionId, existing.messageId, resumeState.inflightUser);
      }
      if (ensureAssistantMessagePresent(
        input.storedSessionId,
        existing.messageId,
        existing.accumulatedText,
        existing.startedAt,
      )) {
        changed = true;
      }
      if (resumeState.inflightAssistant && applyReconciledAssistantText(
        streamRegistry,
        existing,
        resumeState.inflightAssistant,
      )) {
        changed = true;
      }
      deps.getActiveRunningSessionIds().add(input.storedSessionId);
      if (existing.botName) deps.getActiveRunningBotNames().add(existing.botName);
      if (isFocused) {
        syncFocusedStreamingProjection(input.storedSessionId);
        if (changed) {
          deps.ensureMessageWindow?.(readSessionMessages(input.storedSessionId).length);
          deps.onForceSyncMessageList?.(true);
          deps.render();
        }
        deps.syncAgentPresence();
      }
      return true;
    }

    const list = [...readSessionMessages(input.storedSessionId)];
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
    commitSessionMessages(input.storedSessionId, list);

    let insertedUser = false;
    if (resumeState.inflightUser) {
      insertedUser = insertRemoteUserPromptIfMissing(input.storedSessionId, assistantMsg.id, resumeState.inflightUser);
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

    deps.getActiveRunningSessionIds().add(input.storedSessionId);
    if (resolvedBotName) {
      deps.getActiveRunningBotNames().add(resolvedBotName);
    }

    if (isFocused) {
      const finalList = readSessionMessages(input.storedSessionId);
      syncFocusedStreamingProjection(input.storedSessionId);
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

  function reconcileActiveTurnFromResume(storedSessionId: string, resumeResult: Record<string, unknown>): void {
    const streamRegistry = deps.getLiveStreamRegistry();
    const handles = readSessionHandles(resumeResult, storedSessionId);
    const liveSessionId = handles?.liveId || storedSessionId;
    if (!streamRegistry?.hasSession(storedSessionId)) {
      attachLiveTurnFromResume({
        storedSessionId,
        liveSessionId,
        resumeResult,
        botName: deps.resolveBotNameForSession?.(storedSessionId) ?? null,
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
    if (stream && resumeState.isRunning) {
      streamRegistry.touchActivity(storedSessionId);
      if (resumeState.inflightAssistant) {
        const changed = applyReconciledAssistantText(streamRegistry, stream, resumeState.inflightAssistant);
        if (changed && storedSessionId === deps.getState().activeSessionId) {
          deps.onForceSyncMessageList?.(true);
          deps.render();
        }
      }
    }
    if (storedSessionId === deps.getState().activeSessionId) {
      syncFocusedStreamingProjection(storedSessionId);
      deps.syncAgentPresence();
    }
  }

  function ensureRemoteObserverStream(
    storedSessionId: string,
    liveSessionId: string,
    startInfo?: { turnId?: string; userText?: string },
  ): LiveSessionStream | undefined {
    const streamRegistry = deps.getLiveStreamRegistry();
    if (!streamRegistry) return undefined;
    const existing = streamRegistry.getBySession(storedSessionId);
    if (existing) {
      if (liveSessionId) streamRegistry.updateLiveId(storedSessionId, liveSessionId);
      if (startInfo?.turnId && !existing.turnId) existing.turnId = startInfo.turnId;
      if (startInfo?.userText && !existing.userMessageSynced) {
        const inserted = insertRemoteUserPromptIfMissing(storedSessionId, existing.messageId, startInfo.userText);
        if (inserted && storedSessionId === deps.getState().activeSessionId) {
          deps.ensureMessageWindow?.(readSessionMessages(storedSessionId).length);
          deps.onForceSyncMessageList?.(true);
          deps.render();
        }
      }
      return existing;
    }

    const nowMs = Date.now();
    const list = [...readSessionMessages(storedSessionId)];
    const assistantMsg: MessageViewModel = {
      id: `msg-live-${storedSessionId}-${nowMs}-${++remoteBubbleSeq}`,
      role: 'assistant',
      content: '',
      timestamp: formatTimestamp(nowMs),
    };
    list.push(assistantMsg);
    commitSessionMessages(storedSessionId, list);

    let userSynced = false;
    if (startInfo?.userText) {
      userSynced = insertRemoteUserPromptIfMissing(storedSessionId, assistantMsg.id, startInfo.userText);
    }

    const botName = deps.resolveBotNameForSession?.(storedSessionId) ?? null;
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

    deps.getActiveRunningSessionIds().add(storedSessionId);
    if (botName) deps.getActiveRunningBotNames().add(botName);

    const state = deps.getState();
    if (storedSessionId === state.activeSessionId) {
      syncFocusedStreamingProjection(storedSessionId);
      deps.setMessageWindowUserExpanded?.(false);
      deps.ensureMessageWindow?.(readSessionMessages(storedSessionId).length);
      if (deps.isStreamNearBottom?.() ?? true) {
        deps.setPendingScrollToBottom?.(true);
      }
      deps.onForceSyncMessageList?.(true);
      deps.render();
      deps.syncAgentPresence();
    }

    if (!userSynced) {
      void hydrateRemoteTurnUserMessage(storedSessionId, assistantMsg.id, botName);
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
