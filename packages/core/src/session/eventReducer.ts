/**
 * Gateway Downstream Event Reducer
 *
 * The Hermes Gateway pushes a single JSON-RPC notification `event` whose params
 * look like `{ type, payload, session_id }`. A conversation turn is terminated by
 * `message.complete` (verified against a live v0.22.5 gateway); `session.idle` and
 * `agent.turn_end` do not exist.
 *
 * This reducer is pure: it turns one gateway frame into an ordered list of UI
 * actions. Keeping it out of the renderer makes the turn lifecycle testable
 * without a DOM or a socket.
 *
 * 事件契约守卫 (Event Contract Guard):
 *   网关契约里有 72 个下行事件的 payload 定义（BackendGatewayEventMap）。
 *   本模块只消费其中一部分，但**任何**事件的 payload 字段都必须落在契约白名单内。
 *   历史上字段名靠猜，一旦网关改名（如 text -> delta），界面只会安静地空白。
 *   因此这里在解析前做一次字段校验，并把偏差写进日志，而不是让它静默发生。
 */

import { CONTRACT_EVENTS } from '../rpc/contracts/contractTable.generated.js';
import type {
  SessionLiveInfo,
  SessionUsagePayload,
  SubagentLifecycleStatus,
  SubagentPhaseHint,
  SubagentOutputTailEntry,
} from '../rpc/types.js';
import { createLogger } from '../log/logger.js';

const log = createLogger('events');

/**
 * 统一归一化网关时间戳为 Unix 毫秒。
 *
 * 【设计意图 (Why)】网关 `started_at`、`dispatched_at`、`completed_at`、`RoomMemberActivity.started_at/progress_at`
 * 与 `StoredTranscriptRow.timestamp` 均下发 Unix 秒（含浮点微秒），直接与 `Date.now()` 相减会让耗时慢 1000 倍。
 *
 * 【规则 (Rules)】
 * - `0 < num < 1e11` 判为秒，乘 1000 四舍五入为毫秒；`>= 1e11` 保留毫秒取整；
 * - 字符串仅接受可解析正日期；非法值或非正数一律返回 `undefined`。
 */
export function normalizeEpochMs(raw: unknown): number | undefined {
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw <= 0) return undefined;
    return raw < 1e11 ? Math.round(raw * 1000) : Math.round(raw);
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return undefined;
    const asNum = Number(trimmed);
    if (Number.isFinite(asNum) && asNum > 0) {
      return asNum < 1e11 ? Math.round(asNum * 1000) : Math.round(asNum);
    }
    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  }
  return undefined;
}

/** 已上报过的事件偏差，避免高频事件把日志刷爆 */
const reportedEventDrift = new Set<string>();
/** 已上报过的未知事件名 */
const reportedUnknownEvents = new Set<string>();

/**
 * 校验一个 event 帧的 payload 字段是否落在契约白名单内。
 * 只记日志，不改变解析行为——事件流不能因为一个多余字段就中断。
 */
function checkEventContract(type: string, payload: Record<string, unknown>): void {
  const spec = CONTRACT_EVENTS[type];
  if (!spec) {
    if (!reportedUnknownEvents.has(type)) {
      reportedUnknownEvents.add(type);
      log.debug('event type not in gateway contract (may be newer or internal)', { type });
    }
    return;
  }
  const allowed = new Set(spec.payload);
  const unknown = Object.keys(payload).filter((k) => !allowed.has(k));
  if (unknown.length === 0) return;
  const key = `${type}::${unknown.join(',')}`;
  if (reportedEventDrift.has(key)) return;
  reportedEventDrift.add(key);
  log.warn('event payload has fields outside the gateway contract', {
    type,
    payloadType: spec.payloadType,
    unknownFields: unknown,
    allowedFields: spec.payload,
  });
}

/** 仅供测试：清空上报去重状态 */
export function resetEventContractReports(): void {
  reportedEventDrift.clear();
  reportedUnknownEvents.clear();
}

export interface TurnEventContext {
  /** Every id identifying the conversation currently on screen (live id + stored id). */
  activeSessionIds: readonly string[];
  /** Assistant message that streamed deltas belong to, or null when no turn is open. */
  activeStreamingMessageId: string | null;
}

export interface SubagentUpdateAction {
  type: 'subagent-update';
  sessionId: string;
  subagentId: string;
  delegationId?: string;
  taskIndex?: number;
  childSessionId?: string;
  goal?: string;
  lifecycleStatus?: SubagentLifecycleStatus;
  phaseHint?: SubagentPhaseHint;
  model?: string;
  depth?: number;
  parentId?: string;
  toolName?: string;
  toolPreview?: string;
  text?: string;
  summary?: string;
  error?: string;
  toolCount?: number;
  filesRead?: string[];
  filesWritten?: string[];
  tokensInput?: number;
  tokensOutput?: number;
  tokensReasoning?: number;
  durationSeconds?: number;
  acceptingSteer?: boolean;
  outputTail?: SubagentOutputTailEntry[];
  timestamp: number;
}

export type TurnAction =
  | {
      type: 'turn-started';
      turnId?: string;
      text?: string;
      displayText?: string;
      displayKind?: string;
    }
  | { type: 'turn-completed'; sessionId?: string; finalText?: string }
  | { type: 'turn-failed'; sessionId?: string; message: string }
  | { type: 'append-content'; messageId: string; text: string; turnId?: string; segment?: number; offset?: number }
  | { type: 'append-thought'; messageId: string; text: string }
  | {
      type: 'interim-content';
      messageId: string;
      text: string;
      alreadyStreamed: boolean;
      turnId?: string;
      segment?: number;
    }
  | { type: 'replace-content'; messageId: string; text: string }
  | { type: 'stream-activity'; sessionId: string; eventType: string }
  | { type: 'session-reclaimed'; sessionId: string; storedSessionId?: string; reason: string }
  | { type: 'tool-start'; messageId: string; toolCall: { id: string; name: string; args: string; title?: string } }
  | { type: 'tool-complete'; messageId: string; toolCallId: string; output?: string; durationMs?: number }
  | {
      /**
       * message.complete 携带的网关持久行地址：把 rowId 绑定回本地乐观行，
       * 使下一轮回滚/截断拥有可信锚点（D1 修复的落盘半环）。
       */
      type: 'persisted-turn';
      messageId: string;
      userRowId: number | null;
      assistantRowId: number | null;
      rowIds: number[];
    }
  | {
      type: 'subagent-spawn';
      subagentId: string;
      profile: string;
      title: string;
      parentSessionId: string;
      messageId?: string;
    }
  | {
      type: 'subagent-progress';
      subagentId: string;
      sessionId?: string;
      progressPercent: number;
      actionText: string;
    }
  | {
      type: 'subagent-log';
      subagentId: string;
      sessionId?: string;
      entry: {
        seq: number;
        timestamp: number;
        kind: 'stdout' | 'stderr' | 'thought' | 'tool_call' | 'tool_result' | 'status_change';
        text: string;
      };
    }
  | {
      type: 'subagent-complete';
      subagentId: string;
      sessionId?: string;
      lifecycleStatus?: SubagentLifecycleStatus;
      summary?: string;
      output?: string;
    }
  | {
      type: 'subagent-failed';
      subagentId: string;
      sessionId?: string;
      error: string;
    }
  | SubagentUpdateAction
  | { type: 'session-info'; sessionId: string; info: SessionLiveInfo }
  | { type: 'session-usage'; sessionId: string; payload: SessionUsagePayload }
  | { type: 'refresh-sessions' }
  | { type: 'session-title'; sessionId: string; title: string }
  | {
      /**
       * @Agent 旁路（BTW 只读外援 / background 子代理委派）应答到达。
       * 严禁写入 state.messages，仅供独立胶囊状态收敛，防上下文毒化。
       */
      type: 'side-agent-complete';
      channel: 'btw' | 'background';
      taskId: string;
      text: string;
    };

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const filtered = value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
  return filtered.length > 0 ? filtered : undefined;
}

function normalizeGoalKey(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ').slice(0, 120);
}

function normalizeSubagentTerminalOrLiveStatus(raw: unknown): SubagentLifecycleStatus | undefined {
  const s = asText(raw).toLowerCase();
  if (
    s === 'queued' ||
    s === 'running' ||
    s === 'completed' ||
    s === 'failed' ||
    s === 'error' ||
    s === 'timeout' ||
    s === 'interrupted'
  ) {
    return s;
  }
  if (s === 'requested') return 'queued';
  if (s === 'thinking' || s === 'tool_executing') return 'running';
  return undefined;
}

function formatEventToolOutput(val: unknown): string | undefined {
  if (val === null || val === undefined) return undefined;
  if (typeof val === 'string') return val;
  try {
    return JSON.stringify(val, null, 2);
  } catch {
    return String(val);
  }
}

/**
 * 将 `subagent.*` 下行载荷归约为结构化的 `SubagentUpdateAction`。
 * 优先消费契约 `SubagentEventPayload` 字段（`tool_name`, `tool_preview`, `goal`, `text`, `summary`）。
 */
export function reduceSubagentEvent(
  type: string,
  payload: Record<string, unknown>,
  sessionId: string
): SubagentUpdateAction | null {
  if (!sessionId) return null;
  const delegationId = asText(payload.delegation_id) || undefined;
  const taskIndex = asFiniteNumber(payload.task_index);
  const goal =
    asText(payload.goal) || asText(payload.title) || asText(payload.task_title) || undefined;
  const explicitId = asText(payload.subagent_id) || asText(payload.id);
  const syntheticId = delegationId
    ? taskIndex !== undefined
      ? `deleg:${delegationId}:${taskIndex}`
      : `deleg:${delegationId}:${normalizeGoalKey(goal ?? '')}`
    : '';
  const subagentId = explicitId || syntheticId;
  if (!subagentId) return null;

  let lifecycleStatus = normalizeSubagentTerminalOrLiveStatus(payload.status);
  let phaseHint: SubagentPhaseHint | undefined;
  if (type === 'subagent.spawn_requested') {
    lifecycleStatus = lifecycleStatus ?? 'queued';
    phaseHint = 'queued';
  } else if (type === 'subagent.start') {
    lifecycleStatus = lifecycleStatus ?? 'running';
    phaseHint = 'queued';
  } else if (type === 'subagent.thinking') {
    lifecycleStatus = lifecycleStatus ?? 'running';
    phaseHint = 'thinking';
  } else if (type === 'subagent.tool') {
    lifecycleStatus = lifecycleStatus ?? 'running';
    phaseHint = 'tool';
  } else if (type === 'subagent.progress') {
    lifecycleStatus = lifecycleStatus ?? 'running';
    phaseHint = 'progress';
  } else if (type === 'subagent.complete') {
    lifecycleStatus = lifecycleStatus ?? 'completed';
    phaseHint = 'idle';
  } else if (type === 'subagent.failed') {
    lifecycleStatus = 'failed';
    phaseHint = 'idle';
  }

  const toolName =
    asText(payload.tool_name) || asText(payload.name) || asText(payload.tool) || undefined;
  const toolPreview =
    asText(payload.tool_preview) || asText(payload.action) || asText(payload.current_action) || undefined;
  const text = asText(payload.text) || undefined;
  const summary =
    asText(payload.summary) || formatEventToolOutput(payload.output ?? payload.result) || undefined;
  const error = asText(payload.error) || (lifecycleStatus && lifecycleStatus !== 'completed' && lifecycleStatus !== 'queued' && lifecycleStatus !== 'running' ? asText(payload.message) || undefined : undefined);

  const outputTail = Array.isArray(payload.output_tail)
    ? (payload.output_tail.filter(
        (entry): entry is SubagentOutputTailEntry =>
          Boolean(entry && typeof entry === 'object' && typeof (entry as SubagentOutputTailEntry).tool === 'string')
      ))
    : undefined;

  return {
    type: 'subagent-update',
    sessionId,
    subagentId,
    ...(delegationId ? { delegationId } : {}),
    ...(taskIndex !== undefined ? { taskIndex } : {}),
    ...(asText(payload.child_session_id) ? { childSessionId: asText(payload.child_session_id) } : {}),
    ...(goal ? { goal } : {}),
    ...(lifecycleStatus ? { lifecycleStatus } : {}),
    ...(phaseHint ? { phaseHint } : {}),
    ...(asText(payload.model) ? { model: asText(payload.model) } : {}),
    ...(asFiniteNumber(payload.depth) !== undefined ? { depth: asFiniteNumber(payload.depth) } : {}),
    ...(asText(payload.parent_id) ? { parentId: asText(payload.parent_id) } : {}),
    ...(toolName ? { toolName } : {}),
    ...(toolPreview ? { toolPreview } : {}),
    ...(text ? { text } : {}),
    ...(summary ? { summary } : {}),
    ...(error ? { error } : {}),
    ...(asFiniteNumber(payload.tool_count) !== undefined ? { toolCount: asFiniteNumber(payload.tool_count) } : {}),
    ...(asStringArray(payload.files_read) ? { filesRead: asStringArray(payload.files_read) } : {}),
    ...(asStringArray(payload.files_written) ? { filesWritten: asStringArray(payload.files_written) } : {}),
    ...(asFiniteNumber(payload.input_tokens) !== undefined ? { tokensInput: asFiniteNumber(payload.input_tokens) } : {}),
    ...(asFiniteNumber(payload.output_tokens) !== undefined ? { tokensOutput: asFiniteNumber(payload.output_tokens) } : {}),
    ...(asFiniteNumber(payload.reasoning_tokens) !== undefined ? { tokensReasoning: asFiniteNumber(payload.reasoning_tokens) } : {}),
    ...(asFiniteNumber(payload.duration_seconds) !== undefined ? { durationSeconds: asFiniteNumber(payload.duration_seconds) } : {}),
    ...(typeof payload.accepting_steer === 'boolean' ? { acceptingSteer: payload.accepting_steer } : {}),
    ...(outputTail && outputTail.length > 0 ? { outputTail } : {}),
    timestamp: normalizeEpochMs(payload.timestamp) ?? Date.now(),
  };
}

/**
 * Reduces one gateway `event` notification into UI actions.
 *
 * Returns an empty array for frames that do not concern this client, are
 * malformed, or are events the desktop shell does not consume yet.
 */
export function reduceGatewayEvent(params: unknown, ctx: TurnEventContext): TurnAction[] {
  const frame = asRecord(params);
  const type = asText(frame.type);
  if (!type) return [];

  const payload = asRecord(frame.payload);
  const frameSessionId = asText(frame.session_id);

  // 契约守卫：payload 字段必须落在网关事件契约内（只记日志，不中断事件流）
  checkEventContract(type, payload);

  // --- Global broadcasts: independent of which conversation is focused ------
  if (type === 'sessions.changed') {
    return [{ type: 'refresh-sessions' }];
  }

  if (type === 'session.title') {
    const sessionId = frameSessionId || asText(payload.session_id);
    const title = asText(payload.title).trim();
    if (!sessionId || !title) return [];
    return [{ type: 'session-title', sessionId, title }];
  }

  if (type === 'session.reclaimed') {
    const sessionId = frameSessionId || asText(payload.session_id);
    const storedSessionId = asText(payload.stored_session_id) || undefined;
    const resolvedId = sessionId || storedSessionId;
    if (!resolvedId) return [];
    return [{
      type: 'session-reclaimed',
      sessionId: resolvedId,
      ...(storedSessionId ? { storedSessionId } : {}),
      reason: asText(payload.reason),
    }];
  }

  if (type === 'error') {
    const message = asText(payload.message) || '网关返回了未标注内容的系统错误';
    const action: TurnAction = { type: 'turn-failed', message };
    if (frameSessionId) action.sessionId = frameSessionId;
    return [action];
  }

  // 会话级元信息与用量遥测按 session_id 定向归属，后台会话同样入账，空 session_id 丢弃
  if (type === 'session.info') {
    const sessionId = frameSessionId || asText(payload.session_id);
    if (!sessionId) return [];
    return [{ type: 'session-info', sessionId, info: payload as SessionLiveInfo }];
  }

  if (type === 'session.usage') {
    const sessionId = frameSessionId || asText(payload.session_id);
    if (!sessionId) return [];
    return [{ type: 'session-usage', sessionId, payload: payload as SessionUsagePayload }];
  }

  // 子代理事件按所属父会话入账：必须在 activeSessionIds 焦点过滤之前分发以支持后台进度统计，
  // 严禁转译成主对话 tool-start / tool-complete 污染父对话工具胶囊。
  if (type.startsWith('subagent.')) {
    const sessionId = frameSessionId || asText(payload.session_id);
    if (!sessionId) return [];

    const isFocused = !ctx.activeSessionIds.length || ctx.activeSessionIds.includes(sessionId);
    const subagentId = asText(payload.subagent_id) || asText(payload.id);
    const actions: TurnAction[] = [];

    if (type === 'subagent.spawn_requested') {
      const hasCanonicalFields = Boolean(
        asText(payload.goal) ||
          asText(payload.delegation_id) ||
          asFiniteNumber(payload.task_index) !== undefined ||
          asText(payload.model) ||
          asText(payload.child_session_id)
      );
      if (hasCanonicalFields) {
        const update = reduceSubagentEvent(type, payload, sessionId);
        if (update) actions.push(update);
      } else if (subagentId) {
        const profile = asText(payload.profile) || asText(payload.target_profile) || 'default';
        const title = asText(payload.title) || asText(payload.task_title) || '子代理任务';
        actions.push({
          type: 'subagent-spawn',
          subagentId,
          profile,
          title,
          parentSessionId: sessionId,
          messageId: isFocused && ctx.activeStreamingMessageId ? ctx.activeStreamingMessageId : undefined,
        });
      }
      return actions;
    }

    if (type === 'subagent.log' || type === 'subagent.stdout' || type === 'subagent.stderr') {
      if (!subagentId) return [];
      const text = asText(payload.text) || asText(payload.line) || asText(payload.content);
      const kind = type === 'subagent.stderr' ? 'stderr' : 'stdout';
      const ts = normalizeEpochMs(payload.timestamp) ?? Date.now();
      return [{
        type: 'subagent-log',
        subagentId,
        sessionId,
        entry: {
          seq: typeof payload.seq === 'number' ? payload.seq : ts,
          timestamp: ts,
          kind,
          text,
        },
      }];
    }

    const update = reduceSubagentEvent(type, payload, sessionId);
    if (update) {
      actions.push(update);
    }

    const effectiveId = update?.subagentId || subagentId;
    if (!effectiveId) {
      return actions;
    }

    if (type === 'subagent.progress') {
      const progressPercent = typeof payload.progress === 'number'
        ? payload.progress
        : typeof payload.percent === 'number'
        ? payload.percent
        : 0;
      const actionText =
        asText(payload.tool_preview) ||
        asText(payload.action) ||
        asText(payload.text) ||
        asText(payload.current_action);
      actions.push({
        type: 'subagent-progress',
        subagentId: effectiveId,
        sessionId,
        progressPercent,
        actionText,
      });
    } else if (type === 'subagent.tool') {
      const name = asText(payload.tool_name) || asText(payload.name) || asText(payload.tool) || '工具执行';
      const preview = asText(payload.tool_preview) || asText(payload.text);
      const args = preview || (
        typeof payload.args === 'string'
          ? payload.args
          : typeof payload.arguments === 'string'
          ? payload.arguments
          : JSON.stringify(payload.args || payload.parameters || payload.input || {})
      );
      const ts = normalizeEpochMs(payload.timestamp) ?? Date.now();
      actions.push({
        type: 'subagent-log',
        subagentId: effectiveId,
        sessionId,
        entry: {
          seq: ts,
          timestamp: ts,
          kind: 'tool_call',
          text: preview ? `[执行工具]: ${name} — ${preview}` : `[执行工具]: ${name}(${args})`,
        },
      });
    } else if (type === 'subagent.complete') {
      const summary =
        asText(payload.summary) || formatEventToolOutput(payload.output ?? payload.result ?? payload.text);
      const ts = normalizeEpochMs(payload.timestamp) ?? Date.now();
      actions.push({
        type: 'subagent-complete',
        subagentId: effectiveId,
        sessionId,
        lifecycleStatus: update?.lifecycleStatus ?? 'completed',
        summary,
        output: summary,
      });
      actions.push({
        type: 'subagent-log',
        subagentId: effectiveId,
        sessionId,
        entry: {
          seq: ts,
          timestamp: ts,
          kind: 'status_change',
          text: `[子代理完成]: ${summary ? summary.slice(0, 300) : '已完成'}`,
        },
      });
    } else if (type === 'subagent.failed') {
      const error = asText(payload.error) || asText(payload.message) || '子代理执行异常';
      actions.push({
        type: 'subagent-failed',
        subagentId: effectiveId,
        sessionId,
        error,
      });
    }

    return actions;
  }

  // --- Turn-scoped events: ignore streams belonging to other sessions ------
  if (frameSessionId && !ctx.activeSessionIds.includes(frameSessionId)) {
    return [];
  }

  const messageId = ctx.activeStreamingMessageId;

  switch (type) {
    case 'message.start': {
      const turnId = asText(payload.turn_id) || undefined;
      const text = asText(payload.text) || undefined;
      const displayText = asText(payload.display_text) || undefined;
      const displayKind = asText(payload.display_kind) || undefined;
      return [{
        type: 'turn-started',
        ...(turnId ? { turnId } : {}),
        ...(text ? { text } : {}),
        ...(displayText ? { displayText } : {}),
        ...(displayKind ? { displayKind } : {}),
      }];
    }

    case 'btw.complete':
    case 'background.complete': {
      const taskId = asText(payload.task_id);
      if (!taskId) return [];
      return [{
        type: 'side-agent-complete',
        channel: type === 'btw.complete' ? 'btw' : 'background',
        taskId,
        text: asText(payload.text),
      }];
    }

    case 'message.delta': {
      if (payload.text === null) {
        const sid = frameSessionId || ctx.activeSessionIds[0] || '';
        return sid ? [{ type: 'stream-activity', sessionId: sid, eventType: type }] : [];
      }
      const text = asText(payload.text);
      if (!text || !messageId) return [];
      const turnId = asText(payload.turn_id) || undefined;
      const segment = asFiniteNumber(payload.segment);
      const offset = asFiniteNumber(payload.offset);
      return [{
        type: 'append-content',
        messageId,
        text,
        ...(turnId ? { turnId } : {}),
        ...(segment !== undefined ? { segment } : {}),
        ...(offset !== undefined ? { offset } : {}),
      }];
    }

    case 'message.interim': {
      const text = asText(payload.text);
      const alreadyStreamed = Boolean(payload.already_streamed);
      const turnId = asText(payload.turn_id) || undefined;
      const segment = asFiniteNumber(payload.segment);
      if (messageId) {
        return [{
          type: 'interim-content',
          messageId,
          text,
          alreadyStreamed,
          ...(turnId ? { turnId } : {}),
          ...(segment !== undefined ? { segment } : {}),
        }];
      }
      const sid = frameSessionId || ctx.activeSessionIds[0] || '';
      return sid ? [{ type: 'stream-activity', sessionId: sid, eventType: type }] : [];
    }

    case 'thinking.delta':
    case 'reasoning.delta': {
      const text = asText(payload.text);
      if (!text || !messageId) return [];
      return [{ type: 'append-thought', messageId, text }];
    }

    case 'tool.progress':
    case 'tool.generating':
    case 'status.update':
    case 'reasoning.available':
    case 'agent.terminal.output':
    case 'browser.progress':
    case 'moa.phase':
    case 'moa.progress':
    case 'moa.reference':
    case 'moa.aggregating': {
      const sid = frameSessionId || ctx.activeSessionIds[0] || '';
      return sid ? [{ type: 'stream-activity', sessionId: sid, eventType: type }] : [];
    }

    case 'tool.start': {
      const actions: TurnAction[] = [];
      // 契约权威键是 tool_id（ToolStartPayload）；旧实现读 payload.id 恒空，
      // 时间戳兜底导致 complete 永不匹配 start、胶囊状态错乱的根因之一。
      const toolId =
        asText(payload.tool_id) || asText(payload.id) || asText(payload.tool_call_id) || `tool-${Date.now()}`;
      const name = asText(payload.name) || asText(payload.tool) || '工具执行';
      const args = typeof payload.args === 'string'
        ? payload.args
        : typeof payload.arguments === 'string'
        ? payload.arguments
        : JSON.stringify(payload.args || payload.parameters || payload.input || {});

      if (messageId) {
        actions.push({ type: 'tool-start', messageId, toolCall: { id: toolId, name, args } });
      }
      return actions;
    }

    case 'tool.complete':
    case 'tool.end':
    case 'tool.error': {
      const actions: TurnAction[] = [];
      // ToolCompletePayload 权威键同样是 tool_id，与 start 保持同一主键才能精确配对
      const toolCallId = asText(payload.tool_id) || asText(payload.id) || asText(payload.tool_call_id) || '';
      const output = formatEventToolOutput(payload.output ?? payload.result ?? payload.text ?? payload.error);
      const durationSec = asFiniteNumber(payload.duration_s);
      const durationMs = durationSec !== undefined && durationSec >= 0 ? Math.round(durationSec * 1000) : undefined;

      if (messageId) {
        actions.push({
          type: 'tool-complete',
          messageId,
          toolCallId,
          output,
          ...(durationMs !== undefined ? { durationMs } : {}),
        });
      }
      return actions;
    }

    case 'message.complete': {
      const finalText = asText(payload.text);
      const actions: TurnAction[] = [];
      // The completion payload carries the authoritative text of the turn; it
      // corrects any delta that was dropped while the socket was flapping.
      if (finalText && messageId) {
        actions.push({ type: 'replace-content', messageId, text: finalText });
      }
      // persisted_turn 是回合落盘后的权威行地址（user_row_id / final_assistant_row_id），
      // 渲染层据此把网关 rowId 绑定到本地乐观行，这是回滚截断锚点的唯一合法来源之一。
      const persisted = asRecord(payload.persisted_turn);
      const userRowId = typeof persisted.user_row_id === 'number' ? persisted.user_row_id : null;
      const assistantRowId =
        typeof persisted.final_assistant_row_id === 'number' ? persisted.final_assistant_row_id : null;
      const rowIds = Array.isArray(persisted.row_ids)
        ? persisted.row_ids.filter((v): v is number => typeof v === 'number')
        : [];
      if (messageId && (userRowId !== null || assistantRowId !== null || rowIds.length > 0)) {
        actions.push({ type: 'persisted-turn', messageId, userRowId, assistantRowId, rowIds });
      }
      const completeAction: TurnAction = { type: 'turn-completed' };
      if (frameSessionId) completeAction.sessionId = frameSessionId;
      if (finalText) completeAction.finalText = finalText;
      actions.push(completeAction);
      // The turn usually produced the first persisted message of a new session,
      // so the rail must be refreshed at the same moment the composer unlocks.
      actions.push({ type: 'refresh-sessions' });
      return actions;
    }

    default:
      return [];
  }
}
