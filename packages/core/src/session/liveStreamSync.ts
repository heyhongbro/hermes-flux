/**
 * 多会话实时流式同步与多端协同纯状态领域 (Live Stream Sync & Multi-Client Authority)
 *
 * 【设计意图 (Why)】
 *   解决长耗时任务静默超时误杀、退出重进不续流、以及桌面端与移动端同时打开同一会话时的
 *   消息同步缺失与流式冲突问题：
 *   1. `LiveStreamRegistry` 按 `storedSessionId` 隔离追踪每条在途流及其 `(turnId, segment, segmentOffset)`
 *      增量游标，彻底取代全局单槽位假设，同时避免多端/重连/inflight 对账重复追加同一段文本；
 *   2. `extractResumeInflightState` 统一从 `session.resume` 权威载荷抽取在途气泡与归一化时间戳；
 *   3. `decideWatchdogProbeAction` 在看门狗空闲超时后基于网关在线态与 `session.resume` 权威结果裁决
 *      续期还是收敛，避免误杀慢工具调用或深思考任务；
 *   4. `planRemoteUserPromptInsert` 计算远端用户提问插入位置，确保观察端在已挂载 `#msg-content-*`
 *      流式助手行前非破坏性补齐用户气泡并保持幂等。
 *
 * 【防范的历史坑 (Pitfall)】
 *   1. 旧全局单槽 `activeStreamingMessageId` 导致两会话并发时 B 会话 delta 写入 A 会话气泡；
 *   2. `session.resume` 返回的 `turn_started_at` 为 Unix 秒，若直接参与毫秒相减会算出负值或千倍偏差，
 *      必须经 `normalizeEpochMs` 统一归一；
 *   3. 若将已领先本地流强行回退为较短的 `inflight.assistant` 慢快照，界面会出现文字倒流。
 *
 * 【约束与规则 (Rules)】
 *   - 纯 TypeScript 无 DOM / React / Electron 依赖；
 *   - `storedSessionId <-> messageId` 保持严格 1:1 双射（`registerStream` 自动覆盖同会话或同消息旧绑定）；
 *   - 严格 TypeScript 类型推导（禁用类型逃逸），全部外部入参做安全校验。
 */

import { normalizeEpochMs } from './eventReducer.js';

export type StreamOrigin = 'local' | 'remote';

export interface LiveSessionStream {
  readonly storedSessionId: string;
  liveSessionId: string;
  readonly messageId: string;
  botName: string | null;
  readonly origin: StreamOrigin;
  startedAt: number;
  turnId: string | null;
  segment: number;
  segmentOffset: number;
  accumulatedText: string;
  userMessageSynced: boolean;
  lastActivityAt: number;
}

export interface RegisterLiveStreamInput {
  storedSessionId: string;
  liveSessionId: string;
  messageId: string;
  botName?: string | null;
  origin: StreamOrigin;
  startedAt?: number;
  turnId?: string | null;
  initialContent?: string;
  userMessageSynced?: boolean;
  nowMs?: number;
}

export interface StreamDeltaInput {
  text: string | null;
  turnId?: string | null;
  segment?: number | null;
  offset?: number | null;
}

export interface AcceptDeltaResult {
  deltaToAppend: string;
  accepted: boolean;
  duplicate: boolean;
}

export interface AcceptInterimInput {
  text: string;
  alreadyStreamed: boolean;
  turnId?: string | null;
  segment?: number | null;
}

export interface AcceptInterimResult {
  deltaToAppend: string;
  accepted: boolean;
}

export interface ReconcileInflightResult {
  mode: 'noop' | 'append' | 'replace';
  text: string;
}

export interface ResumeInflightState {
  isRunning: boolean;
  turnStartedAtMs?: number;
  inflightUser: string;
  inflightAssistant: string;
  displayKind?: string;
  displayMetadata?: Record<string, unknown>;
  queuedUser?: string;
}

export interface WatchdogProbeDecisionInput {
  reason: 'inactivity' | 'hard-limit';
  isGatewayConnected: boolean;
  probeResult?: { isRunning: boolean } | null;
  probeError?: boolean;
  consecutiveProbeFailures: number;
  maxProbeFailures?: number;
  /** 该会话存在未解决的交互请求（clarify/approval/secret/connection）时禁止误判为闲置超时 */
  hasPendingInteractivePrompt?: boolean;
}

export type WatchdogProbeAction =
  | 'renew'
  | 'defer-offline'
  | 'settle-completed'
  | 'settle-timeout';

export type RemoteUserInsertPlan =
  | { kind: 'insert-before'; insertIndex: number }
  | { kind: 'already-present'; existingIndex: number; bindRowId?: number };

function resolveIncomingTurnCursor(
  stream: LiveSessionStream,
  rawTurnId: string | null | undefined,
  rawSegment: number | null | undefined,
): 'ok' | 'stale-segment' | 'new-segment' {
  const incomingTurnId = typeof rawTurnId === 'string' && rawTurnId ? rawTurnId : null;
  if (incomingTurnId) {
    if (stream.turnId === null) {
      stream.turnId = incomingTurnId;
    } else if (stream.turnId !== incomingTurnId) {
      stream.turnId = incomingTurnId;
      stream.segment =
        typeof rawSegment === 'number' && Number.isFinite(rawSegment) && rawSegment >= 0
          ? rawSegment
          : 0;
      stream.segmentOffset = 0;
      return 'ok';
    }
  }

  if (typeof rawSegment === 'number' && Number.isFinite(rawSegment) && rawSegment >= 0) {
    if (rawSegment < stream.segment) {
      return 'stale-segment';
    }
    if (rawSegment > stream.segment) {
      stream.segment = rawSegment;
      stream.segmentOffset = 0;
      return 'new-segment';
    }
  }
  return 'ok';
}

function appendWithSegmentBoundary(accumulated: string, addition: string, needsGap: boolean): string {
  if (
    needsGap &&
    accumulated.length > 0 &&
    !accumulated.endsWith('\n') &&
    !addition.startsWith('\n')
  ) {
    return `\n\n${addition}`;
  }
  return addition;
}

/**
 * 多会话并发流注册表（按 `storedSessionId` 隔离管理实时流与增量游标）。
 */
export class LiveStreamRegistry {
  private readonly streamsBySession = new Map<string, LiveSessionStream>();
  private readonly sessionByMessageId = new Map<string, string>();

  public registerStream(input: RegisterLiveStreamInput): LiveSessionStream {
    const now = input.nowMs ?? Date.now();
    const initialContent = input.initialContent ?? '';

    const prevForSession = this.streamsBySession.get(input.storedSessionId);
    if (prevForSession) {
      this.sessionByMessageId.delete(prevForSession.messageId);
    }

    const prevSessionOfMsg = this.sessionByMessageId.get(input.messageId);
    if (prevSessionOfMsg && prevSessionOfMsg !== input.storedSessionId) {
      this.streamsBySession.delete(prevSessionOfMsg);
    }

    const stream: LiveSessionStream = {
      storedSessionId: input.storedSessionId,
      liveSessionId: input.liveSessionId || input.storedSessionId,
      messageId: input.messageId,
      botName: input.botName ?? null,
      origin: input.origin,
      startedAt: input.startedAt ?? now,
      turnId: input.turnId ?? null,
      segment: 0,
      segmentOffset: initialContent.length,
      accumulatedText: initialContent,
      userMessageSynced: input.userMessageSynced ?? (input.origin === 'local'),
      lastActivityAt: now,
    };

    this.streamsBySession.set(input.storedSessionId, stream);
    this.sessionByMessageId.set(input.messageId, input.storedSessionId);
    return stream;
  }

  public getBySession(storedSessionId: string | null | undefined): LiveSessionStream | undefined {
    return storedSessionId ? this.streamsBySession.get(storedSessionId) : undefined;
  }

  public getByMessageId(messageId: string | null | undefined): LiveSessionStream | undefined {
    const sid = messageId ? this.sessionByMessageId.get(messageId) : undefined;
    return sid ? this.streamsBySession.get(sid) : undefined;
  }

  public getSessionIdForMessage(messageId: string | null | undefined): string | null {
    return messageId ? (this.sessionByMessageId.get(messageId) ?? null) : null;
  }

  public hasSession(storedSessionId: string | null | undefined): boolean {
    return Boolean(storedSessionId && this.streamsBySession.has(storedSessionId));
  }

  public listSessionIds(): string[] {
    return Array.from(this.streamsBySession.keys());
  }

  public size(): number {
    return this.streamsBySession.size;
  }

  public updateLiveId(storedSessionId: string, liveSessionId: string): boolean {
    const stream = this.streamsBySession.get(storedSessionId);
    if (!stream || !liveSessionId) return false;
    stream.liveSessionId = liveSessionId;
    return true;
  }

  public markUserSynced(storedSessionId: string): boolean {
    const stream = this.streamsBySession.get(storedSessionId);
    if (!stream) return false;
    stream.userMessageSynced = true;
    return true;
  }

  public touchActivity(storedSessionId: string, nowMs = Date.now()): boolean {
    const stream = this.streamsBySession.get(storedSessionId);
    if (!stream) return false;
    stream.lastActivityAt = nowMs;
    return true;
  }

  public removeSession(storedSessionId: string): LiveSessionStream | undefined {
    const existing = this.streamsBySession.get(storedSessionId);
    if (!existing) return undefined;
    this.streamsBySession.delete(storedSessionId);
    if (this.sessionByMessageId.get(existing.messageId) === storedSessionId) {
      this.sessionByMessageId.delete(existing.messageId);
    }
    return existing;
  }

  public clear(): void {
    this.streamsBySession.clear();
    this.sessionByMessageId.clear();
  }

  /**
   * 消费一条流式增量分片，结合 `(turnId, segment, offset)` 严格去重与裁切重叠部分。
   */
  public acceptDelta(
    storedSessionId: string,
    chunk: StreamDeltaInput,
    nowMs = Date.now(),
  ): AcceptDeltaResult {
    const stream = this.streamsBySession.get(storedSessionId);
    if (!stream) {
      return { deltaToAppend: '', accepted: false, duplicate: false };
    }

    stream.lastActivityAt = nowMs;
    if (chunk.text === null || chunk.text === '') {
      return { deltaToAppend: '', accepted: true, duplicate: false };
    }

    const cursorState = resolveIncomingTurnCursor(stream, chunk.turnId, chunk.segment);
    if (cursorState === 'stale-segment') {
      return { deltaToAppend: '', accepted: false, duplicate: true };
    }

    let rawDelta: string;
    if (typeof chunk.offset === 'number' && Number.isFinite(chunk.offset) && chunk.offset >= 0) {
      const endOffset = chunk.offset + chunk.text.length;
      if (endOffset <= stream.segmentOffset) {
        return { deltaToAppend: '', accepted: false, duplicate: true };
      }
      rawDelta =
        chunk.offset < stream.segmentOffset
          ? chunk.text.slice(stream.segmentOffset - chunk.offset)
          : chunk.text;
      stream.segmentOffset = endOffset;
    } else {
      rawDelta = chunk.text;
      stream.segmentOffset += rawDelta.length;
    }

    const isSegmentStart = chunk.offset === undefined || chunk.offset === null || chunk.offset === 0;
    const deltaToAppend = appendWithSegmentBoundary(
      stream.accumulatedText,
      rawDelta,
      cursorState === 'new-segment' && isSegmentStart,
    );
    stream.accumulatedText += deltaToAppend;
    return { deltaToAppend, accepted: true, duplicate: false };
  }

  /**
   * 消费网关在调用工具前封存的阶段性文本 (`message.interim`)，未流式播出的段落补齐上屏，已播出则不重复。
   */
  public acceptInterim(
    storedSessionId: string,
    interim: AcceptInterimInput,
    nowMs = Date.now(),
  ): AcceptInterimResult {
    const stream = this.streamsBySession.get(storedSessionId);
    if (!stream) {
      return { deltaToAppend: '', accepted: false };
    }

    stream.lastActivityAt = nowMs;
    const cursorState = resolveIncomingTurnCursor(stream, interim.turnId, interim.segment);
    if (cursorState === 'stale-segment') {
      return { deltaToAppend: '', accepted: false };
    }

    if (interim.alreadyStreamed || !interim.text) {
      return { deltaToAppend: '', accepted: true };
    }

    if (stream.accumulatedText.endsWith(interim.text)) {
      return { deltaToAppend: '', accepted: true };
    }

    const deltaToAppend = appendWithSegmentBoundary(stream.accumulatedText, interim.text, true);
    stream.accumulatedText += deltaToAppend;
    stream.segmentOffset += interim.text.length;
    return { deltaToAppend, accepted: true };
  }

  /**
   * 用 `session.resume` 返回的 `inflight.assistant` 快照对账：仅向前补全，绝不回退已领先的本地流。
   */
  public reconcileInflightText(
    storedSessionId: string,
    inflightAssistant: string,
    nowMs = Date.now(),
  ): ReconcileInflightResult {
    const stream = this.streamsBySession.get(storedSessionId);
    if (!stream || !inflightAssistant) {
      return { mode: 'noop', text: '' };
    }

    stream.lastActivityAt = nowMs;
    if (inflightAssistant === stream.accumulatedText) {
      return { mode: 'noop', text: '' };
    }
    if (stream.accumulatedText.length === 0) {
      stream.accumulatedText = inflightAssistant;
      stream.segmentOffset = inflightAssistant.length;
      return { mode: 'replace', text: inflightAssistant };
    }
    if (inflightAssistant.startsWith(stream.accumulatedText)) {
      const missing = inflightAssistant.slice(stream.accumulatedText.length);
      stream.accumulatedText = inflightAssistant;
      stream.segmentOffset += missing.length;
      return { mode: 'append', text: missing };
    }
    if (stream.accumulatedText.startsWith(inflightAssistant)) {
      return { mode: 'noop', text: '' };
    }
    if (inflightAssistant.length > stream.accumulatedText.length) {
      stream.accumulatedText = inflightAssistant;
      stream.segmentOffset = inflightAssistant.length;
      return { mode: 'replace', text: inflightAssistant };
    }
    return { mode: 'noop', text: '' };
  }
}

/**
 * 从 `session.resume` 响应中规范化提取在途回合状态与时间戳。
 */
export function extractResumeInflightState(res: unknown): ResumeInflightState {
  if (!res || typeof res !== 'object') {
    return { isRunning: false, inflightUser: '', inflightAssistant: '' };
  }
  const rec = res as Record<string, unknown>;
  const inflight =
    rec.inflight && typeof rec.inflight === 'object'
      ? (rec.inflight as Record<string, unknown>)
      : null;
  const queued =
    rec.queued && typeof rec.queued === 'object'
      ? (rec.queued as Record<string, unknown>)
      : null;

  const isRunning = Boolean(rec.running || inflight?.streaming);
  const turnStartedAtMs = normalizeEpochMs(rec.turn_started_at ?? rec.started_at);
  const inflightUser = typeof inflight?.user === 'string' ? inflight.user : '';
  const inflightAssistant = typeof inflight?.assistant === 'string' ? inflight.assistant : '';
  const displayKind =
    typeof inflight?.display_kind === 'string' && inflight.display_kind
      ? inflight.display_kind
      : undefined;
  const displayMetadata =
    inflight?.display_metadata &&
    typeof inflight.display_metadata === 'object' &&
    !Array.isArray(inflight.display_metadata)
      ? (inflight.display_metadata as Record<string, unknown>)
      : undefined;
  const queuedUser = typeof queued?.user === 'string' ? queued.user : undefined;

  return {
    isRunning,
    ...(turnStartedAtMs !== undefined ? { turnStartedAtMs } : {}),
    inflightUser,
    inflightAssistant,
    ...(displayKind ? { displayKind } : {}),
    ...(displayMetadata ? { displayMetadata } : {}),
    ...(queuedUser ? { queuedUser } : {}),
  };
}

/**
 * 看门狗超时后的权威探测决策表：先询问网关是否仍在运行，避免慢工具与长思考期间误杀。
 */
export function decideWatchdogProbeAction(input: WatchdogProbeDecisionInput): WatchdogProbeAction {
  if (input.reason === 'hard-limit') {
    return 'settle-timeout';
  }
  if (input.hasPendingInteractivePrompt) {
    return 'renew';
  }
  const maxFailures = input.maxProbeFailures ?? 2;
  if (!input.isGatewayConnected) {
    return input.consecutiveProbeFailures < maxFailures ? 'defer-offline' : 'settle-timeout';
  }
  if (input.probeError) {
    return input.consecutiveProbeFailures < maxFailures ? 'renew' : 'settle-timeout';
  }
  if (input.probeResult?.isRunning) {
    return 'renew';
  }
  return 'settle-completed';
}

/**
 * 计算远端发起流式回合时用户消息的非破坏性插入计划，保障在活跃流式助手气泡前插入且幂等不重复。
 */
export function planRemoteUserPromptInsert<
  T extends { id: string; role: string; content: string; rowId?: number; displayKind?: string },
>(
  messages: readonly T[],
  params: { assistantMessageId: string; userText: string; userRowId?: number | null },
): RemoteUserInsertPlan | null {
  const trimmedUser = params.userText.trim();
  if (!trimmedUser) return null;

  const assistantIdx = messages.findIndex((m) => m.id === params.assistantMessageId);
  if (assistantIdx < 0) return null;

  const validRowId =
    typeof params.userRowId === 'number' && Number.isInteger(params.userRowId) && params.userRowId > 0
      ? params.userRowId
      : undefined;

  for (let i = assistantIdx - 1; i >= 0; i -= 1) {
    const candidate = messages[i];
    if (candidate.displayKind === 'hidden') continue;
    if (candidate.role !== 'user') break;
    const rowMatched = validRowId !== undefined && candidate.rowId === validRowId;
    const contentMatched = candidate.content.trim() === trimmedUser;
    if (rowMatched || contentMatched) {
      return {
        kind: 'already-present',
        existingIndex: i,
        ...(validRowId !== undefined ? { bindRowId: validRowId } : {}),
      };
    }
    break;
  }

  return {
    kind: 'insert-before',
    insertIndex: assistantIdx,
  };
}
