/**
 * Subagent Delegation State Controller & Stream Runtime
 * (packages/core/src/subagent/subagentStore.ts)
 *
 * 【设计意图 (Why)】
 *   统一沉淀多源（WS 实时事件 + `subagent.list` + `spawn_tree.load` + 主对话工具扫描）的子 Agent
 *   状态单调格、1:1 无歧义别名并入、`session.transcript` 分页排空及 `-32601 -> degraded_tail` 自愈降级，
 *   并与 `subagent.steer` / `subagent.interrupt` 控制契约对齐，零 DOM / React / Electron 依赖。
 *
 * 【防范的历史坑 (Pitfall)】
 *   1. `SubagentSnapshot` 不含 `task_index`：缺失 `task_index` 时多子任务并发下严禁盲并，仅 1:1 唯一匹配时并入。
 *   2. 乱序帧与切会话串台：使用终态吸收单调格 `mergeSubagentRecord` 与会话级代际栅栏（`sessionGeneration`）。
 *   3. 乐观谎言：调用 `interruptSubagent` 只置 `interruptPending`，必须等网关 `{ found: true }` 才落定终态。
 *   4. 时间戳混算：所有网关秒级时间统一经 `normalizeEpochMs` 转为毫秒。
 */

import type {
  FailedDelegation,
  SessionLiveInfo,
  StoredTranscriptResult,
  StoredTranscriptRow,
  SubagentActiveStatus,
  SubagentInterruptParams,
  SubagentInterruptResult,
  SubagentLifecycleStatus,
  SubagentListResult,
  SubagentLogEntry,
  SubagentPhaseHint,
  SubagentRecordSource,
  SubagentSnapshot,
  SubagentSpawnParams,
  SubagentStatus,
  SubagentSteerParams,
  SubagentSteerResult,
  SubagentTailResult,
  SubagentTaskState,
  SubagentTerminalStatus,
} from '../rpc/types.js';
import type { SubagentUpdateAction } from '../session/eventReducer.js';
import { normalizeEpochMs } from '../session/eventReducer.js';
import {
  defaultProgressForLifecycle,
  extractDelegationsFromMessages,
  isSyntheticSubagentId,
  isTerminalLifecycleStatus,
  lifecycleRank,
  matchSubagentForToolCall,
  normalizeGoalKey,
  normalizeStatusToLifecycleAndHint,
  type DelegationScanMessageInput,
} from './subagentDelegationScan.js';
export {
  extractDelegationsFromMessages,
  isSyntheticSubagentId,
  isTerminalLifecycleStatus,
  matchSubagentForToolCall,
  normalizeGoalKey,
  type DelegationScanMessageInput,
} from './subagentDelegationScan.js';
import { RingBuffer } from './ringBuffer.js';
import { createLogger } from '../log/logger.js';
import { UnsupportedCapabilityError } from '../rpc/errors.js';

const log = createLogger('subagent');

export interface ISubagentRpcBridge {
  request<TResult = unknown, TParams = unknown>(method: string, params?: TParams): Promise<TResult>;
}

export type SubagentStateListener = (tasks: ReadonlyMap<string, SubagentTaskState>) => void;
export type SubagentTailListener = (entry: SubagentLogEntry) => void;
export type SubagentAliasResolvedListener = (oldId: string, newId: string, parentSessionId: string) => void;

export type SubagentTranscriptStatus = 'idle' | 'loading' | 'ready' | 'degraded_tail' | 'error';

export interface SubagentTranscriptState {
  status: SubagentTranscriptStatus;
  rows: StoredTranscriptRow[];
  nextCursor: string | null;
  running: boolean;
  available: boolean;
  childSessionId?: string;
  transcriptUnsupported: boolean;
  error?: string;
  isIncrementalError?: boolean;
  updatedAt: number;
}

export interface SubagentInterruptOutcome {
  ok: boolean;
  reason?: 'not_found' | 'already_ended' | 'synthetic_id' | 'rpc_error';
  error?: string;
}

export type SubagentSteerOutcome =
  | { ok: true; status: 'queued' | 'rejected'; text: string }
  | { ok: false; error: string };

const SOURCE_PRIORITY: Record<SubagentRecordSource, number> = {
  live_event: 4,
  subagent_list: 3,
  spawn_tree: 2,
  transcript_scan: 1,
};

function mergeUniqueStrings(a?: readonly string[], b?: readonly string[]): string[] | undefined {
  if (!a?.length && !b?.length) return undefined;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of a ?? []) {
    if (item && !seen.has(item)) {
      seen.add(item);
      out.push(item);
    }
  }
  for (const item of b ?? []) {
    if (item && !seen.has(item)) {
      seen.add(item);
      out.push(item);
    }
  }
  return out.length > 0 ? out : undefined;
}

function buildRowDedupKey(row: StoredTranscriptRow, index: number): string {
  if (typeof row.row_id === 'number' && Number.isFinite(row.row_id)) {
    return `id:${row.row_id}`;
  }
  const textHead = typeof row.content === 'string' ? row.content.slice(0, 80) : '';
  return `fp:${index}:${row.role}:${row.timestamp ?? ''}:${row.row_kind}:${row.tool_call_id ?? ''}:${textHead}`;
}

function isMethodUnsupportedError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const rec = err as { code?: unknown; message?: unknown };
  if (rec.code === -32601) return true;
  if (typeof rec.message === 'string' && rec.message.includes('-32601')) return true;
  return false;
}

/**
 * 纯函数状态单调格合并（INV-SUBAGENT-02 / INV-SUBAGENT-03）：
 * - 状态按 `queued(0) < running(1) < terminal(2)` 单调跃迁，终态永不回退；
 * - 同秩时按来源优先级 `live_event > subagent_list > spawn_tree > transcript_scan` 融合，
 *   计数器取 `Math.max`，集合取去重并集，`interruptPending` 黏性保持直至进入终态。
 */
export function mergeSubagentRecord(
  existing: SubagentTaskState | undefined,
  incoming: SubagentTaskState
): SubagentTaskState {
  if (!existing) {
    return { ...incoming };
  }

  const existingRank = lifecycleRank(existing.lifecycleStatus);
  const incomingRank = lifecycleRank(incoming.lifecycleStatus);

  let lifecycleStatus: SubagentLifecycleStatus;
  let status: SubagentStatus;
  let phaseHint: SubagentPhaseHint;
  if (incomingRank > existingRank) {
    lifecycleStatus = incoming.lifecycleStatus;
    status = incoming.status;
    phaseHint = incoming.phaseHint;
  } else if (existingRank > incomingRank) {
    lifecycleStatus = existing.lifecycleStatus;
    status = existing.status;
    phaseHint = existing.phaseHint;
  } else {
    // 同秩：若两方均为终态且非 completed，保留更先/更高优先级终态；运行期取更高优先级或更晚时间
    const incomingWins =
      SOURCE_PRIORITY[incoming.source] > SOURCE_PRIORITY[existing.source] ||
      (SOURCE_PRIORITY[incoming.source] === SOURCE_PRIORITY[existing.source] &&
        incoming.updatedAt >= existing.updatedAt);
    lifecycleStatus = incomingWins ? incoming.lifecycleStatus : existing.lifecycleStatus;
    status = incomingWins ? incoming.status : existing.status;
    phaseHint = incomingWins ? incoming.phaseHint : existing.phaseHint;
  }

  const terminal = isTerminalLifecycleStatus(lifecycleStatus);
  const incomingHigherPriority =
    SOURCE_PRIORITY[incoming.source] > SOURCE_PRIORITY[existing.source] ||
    (SOURCE_PRIORITY[incoming.source] === SOURCE_PRIORITY[existing.source] &&
      incoming.updatedAt >= existing.updatedAt);

  const source =
    SOURCE_PRIORITY[incoming.source] >= SOURCE_PRIORITY[existing.source]
      ? incoming.source
      : existing.source;

  const goal =
    (incoming.goal && (!existing.goal || SOURCE_PRIORITY[incoming.source] >= SOURCE_PRIORITY[existing.source])
      ? incoming.goal
      : existing.goal) || incoming.goal || existing.goal;

  const startedAt =
    existing.startedAt > 0 && incoming.startedAt > 0
      ? Math.min(existing.startedAt, incoming.startedAt)
      : existing.startedAt > 0
      ? existing.startedAt
      : incoming.startedAt;
  const updatedAt = Math.max(existing.updatedAt, incoming.updatedAt);
  const completedAt = terminal
    ? incoming.completedAt ?? existing.completedAt ?? updatedAt
    : undefined;

  const toolCount = Math.max(existing.toolCount, incoming.toolCount);
  const lastTool = incomingHigherPriority
    ? incoming.lastTool ?? existing.lastTool
    : existing.lastTool ?? incoming.lastTool;
  const currentActionText = incomingHigherPriority
    ? incoming.currentActionText || existing.currentActionText
    : existing.currentActionText || incoming.currentActionText;
  const summary = incoming.summary ?? existing.summary ?? incoming.resultSummary ?? existing.resultSummary;
  const error =
    lifecycleStatus === 'completed'
      ? undefined
      : (incomingHigherPriority ? incoming.error ?? existing.error : existing.error ?? incoming.error);

  const interruptPending = terminal
    ? false
    : incoming.interruptPending === false
    ? false
    : Boolean(existing.interruptPending || incoming.interruptPending);

  const progressPercent = terminal
    ? 100
    : Math.max(existing.progressPercent, incoming.progressPercent);

  const targetProfile = incoming.model || existing.model || incoming.targetProfile || existing.targetProfile || 'default';

  return {
    subagentId: incoming.subagentId,
    parentSessionId: incoming.parentSessionId || existing.parentSessionId,
    goal,
    lifecycleStatus,
    phaseHint,
    source,
    ...(incoming.delegationId || existing.delegationId ? { delegationId: incoming.delegationId || existing.delegationId } : {}),
    ...(incoming.taskIndex !== undefined || existing.taskIndex !== undefined
      ? { taskIndex: incoming.taskIndex ?? existing.taskIndex }
      : {}),
    ...(incoming.childSessionId || existing.childSessionId
      ? { childSessionId: incoming.childSessionId || existing.childSessionId }
      : {}),
    ...(incoming.model || existing.model ? { model: incoming.model || existing.model } : {}),
    ...(incoming.depth !== undefined || existing.depth !== undefined
      ? { depth: incoming.depth ?? existing.depth }
      : {}),
    ...(incoming.parentId || existing.parentId ? { parentId: incoming.parentId || existing.parentId } : {}),
    toolCount,
    ...(lastTool ? { lastTool } : {}),
    ...(mergeUniqueStrings(existing.toolNames, incoming.toolNames)
      ? { toolNames: mergeUniqueStrings(existing.toolNames, incoming.toolNames) }
      : {}),
    ...(mergeUniqueStrings(existing.filesRead, incoming.filesRead)
      ? { filesRead: mergeUniqueStrings(existing.filesRead, incoming.filesRead) }
      : {}),
    ...(mergeUniqueStrings(existing.filesWritten, incoming.filesWritten)
      ? { filesWritten: mergeUniqueStrings(existing.filesWritten, incoming.filesWritten) }
      : {}),
    ...(incoming.tokensInput !== undefined || existing.tokensInput !== undefined
      ? { tokensInput: Math.max(existing.tokensInput ?? 0, incoming.tokensInput ?? 0) }
      : {}),
    ...(incoming.tokensOutput !== undefined || existing.tokensOutput !== undefined
      ? { tokensOutput: Math.max(existing.tokensOutput ?? 0, incoming.tokensOutput ?? 0) }
      : {}),
    ...(incoming.tokensReasoning !== undefined || existing.tokensReasoning !== undefined
      ? { tokensReasoning: Math.max(existing.tokensReasoning ?? 0, incoming.tokensReasoning ?? 0) }
      : {}),
    ...(typeof incoming.acceptingSteer === 'boolean' || typeof existing.acceptingSteer === 'boolean'
      ? { acceptingSteer: incomingHigherPriority ? (incoming.acceptingSteer ?? existing.acceptingSteer) : (existing.acceptingSteer ?? incoming.acceptingSteer) }
      : {}),
    interruptPending,
    ...(incoming.durationSeconds !== undefined || existing.durationSeconds !== undefined
      ? { durationSeconds: incoming.durationSeconds ?? existing.durationSeconds }
      : {}),
    ...(summary !== undefined ? { summary, resultSummary: summary } : {}),
    ...(error !== undefined ? { error } : {}),
    startedAt,
    updatedAt,
    ...(completedAt !== undefined ? { completedAt } : {}),
    targetProfile,
    taskTitle: goal || '子任务执行',
    status,
    progressPercent,
    currentActionText,
  };
}

/**
 * 纯输入三源确定性合并与 1:1 无歧义并入函数（INV-SUBAGENT-03）。
 */
export function reconcileSubagentRecords(
  existingRecords: readonly SubagentTaskState[],
  incomingRecords: readonly SubagentTaskState[],
  aliasMap?: ReadonlyMap<string, string>
): {
  merged: SubagentTaskState[];
  resolvedAliases: Array<{ oldId: string; newId: string }>;
} {
  const byId = new Map<string, SubagentTaskState>();
  const resolvedAliases: Array<{ oldId: string; newId: string }> = [];

  for (const rec of existingRecords) {
    const canonicalId = aliasMap?.get(rec.subagentId) ?? rec.subagentId;
    const normalized = canonicalId === rec.subagentId ? rec : { ...rec, subagentId: canonicalId };
    byId.set(canonicalId, mergeSubagentRecord(byId.get(canonicalId), normalized));
  }

  for (const rawIncoming of incomingRecords) {
    const mappedId = aliasMap?.get(rawIncoming.subagentId) ?? rawIncoming.subagentId;
    const incoming = mappedId === rawIncoming.subagentId ? rawIncoming : { ...rawIncoming, subagentId: mappedId };

    if (byId.has(incoming.subagentId)) {
      byId.set(incoming.subagentId, mergeSubagentRecord(byId.get(incoming.subagentId), incoming));
      continue;
    }

    // 真实 subagent_id 抵达时尝试 1:1 无歧义合并合成记录
    let matchedSynthetic: SubagentTaskState | null = null;
    if (!isSyntheticSubagentId(incoming.subagentId) && incoming.delegationId) {
      const candidates: SubagentTaskState[] = [];
      for (const candidate of byId.values()) {
        if (
          isSyntheticSubagentId(candidate.subagentId) &&
          candidate.parentSessionId === incoming.parentSessionId &&
          candidate.delegationId === incoming.delegationId
        ) {
          candidates.push(candidate);
        }
      }

      if (incoming.taskIndex !== undefined) {
        const byIndex = candidates.filter((c) => c.taskIndex === incoming.taskIndex);
        if (byIndex.length === 1) matchedSynthetic = byIndex[0];
      } else if (candidates.length === 1) {
        // SubagentSnapshot 无 task_index：仅当同会话+同 delegation_id 下唯一存在且 goal 匹配时并入
        const only = candidates[0];
        if (!incoming.goal || !only.goal || normalizeGoalKey(only.goal) === normalizeGoalKey(incoming.goal)) {
          matchedSynthetic = only;
        }
      }
    }

    if (matchedSynthetic) {
      const oldId = matchedSynthetic.subagentId;
      byId.delete(oldId);
      const promoted = mergeSubagentRecord(
        { ...matchedSynthetic, subagentId: incoming.subagentId },
        incoming
      );
      byId.set(incoming.subagentId, promoted);
      resolvedAliases.push({ oldId, newId: incoming.subagentId });
    } else {
      byId.set(incoming.subagentId, { ...incoming });
    }
  }

  return {
    merged: Array.from(byId.values()).sort((a, b) => b.startedAt - a.startedAt),
    resolvedAliases,
  };
}

export { RingBuffer };

export class SubagentStore {
  private tasks = new Map<string, SubagentTaskState>();
  private tailBuffers = new Map<string, RingBuffer<SubagentLogEntry>>();
  private listeners = new Set<SubagentStateListener>();
  private tailListeners = new Map<string, Set<SubagentTailListener>>();
  private aliasListeners = new Set<SubagentAliasResolvedListener>();
  private activeTailSubagentId: string | null = null;
  private readonly subagentAliasMap = new Map<string, string>();
  private readonly transcriptStates = new Map<string, SubagentTranscriptState>();
  private readonly transcriptUnsupported = new Set<string>();
  private readonly sessionGenerations = new Map<string, number>();
  private readonly lastListSyncError = new Map<string, string>();
  private readonly seenTailSeqs = new Map<string, Set<number>>();
  private readonly lastTailSnapshotText = new Map<string, string>();
  private clearEpoch = 0;

  constructor(private readonly maxLogCapacity = 1000) {}

  public subscribe(listener: SubagentStateListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public subscribeAliasResolved(listener: SubagentAliasResolvedListener): () => void {
    this.aliasListeners.add(listener);
    return () => {
      this.aliasListeners.delete(listener);
    };
  }

  public subscribeTail(subagentId: string, listener: SubagentTailListener): () => void {
    const canonicalId = this.resolveSubagentId(subagentId);
    let set = this.tailListeners.get(canonicalId);
    if (!set) {
      set = new Set();
      this.tailListeners.set(canonicalId, set);
    }
    set.add(listener);

    return () => {
      const currentSet = this.tailListeners.get(canonicalId);
      if (currentSet) {
        currentSet.delete(listener);
        if (currentSet.size === 0) {
          this.tailListeners.delete(canonicalId);
        }
      }
    };
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener(this.tasks);
    }
  }

  public resolveSubagentId(id: string): string {
    let cur = id;
    const seen = new Set<string>();
    while (this.subagentAliasMap.has(cur) && !seen.has(cur)) {
      seen.add(cur);
      cur = this.subagentAliasMap.get(cur)!;
    }
    return cur;
  }

  public getSessionGeneration(sessionId: string): number {
    return this.sessionGenerations.get(sessionId) ?? 0;
  }

  public advanceSessionGeneration(sessionId: string): number {
    const next = this.getSessionGeneration(sessionId) + 1;
    this.sessionGenerations.set(sessionId, next);
    return next;
  }

  public getListSyncError(sessionId: string): string | undefined {
    return this.lastListSyncError.get(sessionId);
  }

  public getTasksBySession(sessionId: string): SubagentTaskState[] {
    const list: SubagentTaskState[] = [];
    for (const task of this.tasks.values()) {
      if (task.parentSessionId === sessionId) {
        list.push({ ...task });
      }
    }
    return list.sort((a, b) => b.startedAt - a.startedAt);
  }

  public getRunningCount(): number {
    let count = 0;
    for (const task of this.tasks.values()) {
      if (task.lifecycleStatus === 'queued' || task.lifecycleStatus === 'running') {
        count++;
      }
    }
    return count;
  }

  public getTask(subagentId: string): SubagentTaskState | undefined {
    const canonical = this.resolveSubagentId(subagentId);
    const task = this.tasks.get(canonical);
    return task ? { ...task } : undefined;
  }

  public getLogs(subagentId: string): SubagentLogEntry[] {
    const canonical = this.resolveSubagentId(subagentId);
    const buffer = this.tailBuffers.get(canonical);
    return buffer ? buffer.toArray() : [];
  }

  public getTranscriptState(subagentId: string): SubagentTranscriptState {
    const canonical = this.resolveSubagentId(subagentId);
    const state = this.transcriptStates.get(canonical);
    if (!state) {
      return {
        status: 'idle',
        rows: [],
        nextCursor: null,
        running: false,
        available: false,
        transcriptUnsupported: this.transcriptUnsupported.has(canonical),
        updatedAt: 0,
      };
    }
    return { ...state, rows: state.rows.slice() };
  }

  public setActiveTailTarget(subagentId: string | null): void {
    this.activeTailSubagentId = subagentId ? this.resolveSubagentId(subagentId) : null;
  }

  public getActiveTailTarget(): string | null {
    return this.activeTailSubagentId;
  }

  private migrateSubagentId(oldId: string, newId: string, parentSessionId: string): void {
    if (!oldId || !newId || oldId === newId) return;
    this.subagentAliasMap.set(oldId, newId);

    const oldBuffer = this.tailBuffers.get(oldId);
    if (oldBuffer) {
      let targetBuffer = this.tailBuffers.get(newId);
      if (!targetBuffer) {
        targetBuffer = new RingBuffer<SubagentLogEntry>(this.maxLogCapacity);
        this.tailBuffers.set(newId, targetBuffer);
      }
      for (const entry of oldBuffer.toArray()) {
        targetBuffer.push(entry);
      }
      this.tailBuffers.delete(oldId);
    }

    const oldTranscript = this.transcriptStates.get(oldId);
    if (oldTranscript && !this.transcriptStates.has(newId)) {
      this.transcriptStates.set(newId, oldTranscript);
    }
    this.transcriptStates.delete(oldId);

    if (this.transcriptUnsupported.has(oldId)) {
      this.transcriptUnsupported.add(newId);
    }

    const oldSeqs = this.seenTailSeqs.get(oldId);
    if (oldSeqs) {
      let targetSeqs = this.seenTailSeqs.get(newId);
      if (!targetSeqs) {
        targetSeqs = new Set<number>();
        this.seenTailSeqs.set(newId, targetSeqs);
      }
      for (const s of oldSeqs) {
        targetSeqs.add(s);
      }
      this.seenTailSeqs.delete(oldId);
    }
    const oldText = this.lastTailSnapshotText.get(oldId);
    if (oldText && !this.lastTailSnapshotText.has(newId)) {
      this.lastTailSnapshotText.set(newId, oldText);
    }
    this.lastTailSnapshotText.delete(oldId);

    const oldTailListeners = this.tailListeners.get(oldId);
    if (oldTailListeners) {
      let targetSet = this.tailListeners.get(newId);
      if (!targetSet) {
        targetSet = new Set();
        this.tailListeners.set(newId, targetSet);
      }
      for (const listener of oldTailListeners) {
        targetSet.add(listener);
      }
      this.tailListeners.delete(oldId);
    }

    if (this.activeTailSubagentId === oldId) {
      this.activeTailSubagentId = newId;
    }

    for (const listener of this.aliasListeners) {
      listener(oldId, newId, parentSessionId);
    }
  }

  private mergeSessionRecords(sessionId: string, incomingRecords: SubagentTaskState[]): void {
    const existingForSession: SubagentTaskState[] = [];
    for (const t of this.tasks.values()) {
      if (t.parentSessionId === sessionId) {
        existingForSession.push(t);
      }
    }

    const { merged, resolvedAliases } = reconcileSubagentRecords(
      existingForSession,
      incomingRecords,
      this.subagentAliasMap
    );

    for (const { oldId, newId } of resolvedAliases) {
      this.tasks.delete(oldId);
      this.migrateSubagentId(oldId, newId, sessionId);
    }

    for (const item of merged) {
      this.tasks.set(item.subagentId, item);
    }
    this.notify();
  }

  /**
   * 写入或更新单个子代理记录（通过单调格 `mergeSubagentRecord` 保护终态不可倒退）。
   */
  public upsertTask(taskPatch: Partial<SubagentTaskState> & { subagentId: string }): SubagentTaskState {
    const now = Date.now();
    const canonicalId = this.resolveSubagentId(taskPatch.subagentId);
    const existing = this.tasks.get(canonicalId);

    const norm = normalizeStatusToLifecycleAndHint(
      taskPatch.lifecycleStatus ?? taskPatch.status ?? existing?.lifecycleStatus ?? existing?.status ?? 'running'
    );
    const goal =
      taskPatch.goal ?? taskPatch.taskTitle ?? existing?.goal ?? existing?.taskTitle ?? '子任务执行';
    const lastTool = taskPatch.lastTool ?? (taskPatch.phaseHint === 'tool' ? taskPatch.currentActionText : existing?.lastTool);
    const summary = taskPatch.summary ?? taskPatch.resultSummary ?? existing?.summary ?? existing?.resultSummary;

    const incoming: SubagentTaskState = {
      subagentId: canonicalId,
      parentSessionId: taskPatch.parentSessionId || existing?.parentSessionId || '',
      goal,
      lifecycleStatus: taskPatch.lifecycleStatus ?? norm.lifecycle,
      phaseHint: taskPatch.phaseHint ?? existing?.phaseHint ?? norm.phaseHint,
      source: taskPatch.source ?? existing?.source ?? 'live_event',
      ...(taskPatch.delegationId ?? existing?.delegationId ? { delegationId: taskPatch.delegationId ?? existing?.delegationId } : {}),
      ...(taskPatch.taskIndex !== undefined ? { taskIndex: taskPatch.taskIndex } : existing?.taskIndex !== undefined ? { taskIndex: existing.taskIndex } : {}),
      ...(taskPatch.childSessionId ?? existing?.childSessionId ? { childSessionId: taskPatch.childSessionId ?? existing?.childSessionId } : {}),
      ...(taskPatch.model ?? existing?.model ? { model: taskPatch.model ?? existing?.model } : {}),
      ...(taskPatch.depth !== undefined ? { depth: taskPatch.depth } : existing?.depth !== undefined ? { depth: existing.depth } : {}),
      ...(taskPatch.parentId ?? existing?.parentId ? { parentId: taskPatch.parentId ?? existing?.parentId } : {}),
      toolCount: taskPatch.toolCount ?? existing?.toolCount ?? 0,
      ...(lastTool ? { lastTool } : {}),
      ...(taskPatch.toolNames ?? existing?.toolNames ? { toolNames: taskPatch.toolNames ?? existing?.toolNames } : {}),
      ...(taskPatch.filesRead ?? existing?.filesRead ? { filesRead: taskPatch.filesRead ?? existing?.filesRead } : {}),
      ...(taskPatch.filesWritten ?? existing?.filesWritten ? { filesWritten: taskPatch.filesWritten ?? existing?.filesWritten } : {}),
      ...(taskPatch.tokensInput !== undefined ? { tokensInput: taskPatch.tokensInput } : existing?.tokensInput !== undefined ? { tokensInput: existing.tokensInput } : {}),
      ...(taskPatch.tokensOutput !== undefined ? { tokensOutput: taskPatch.tokensOutput } : existing?.tokensOutput !== undefined ? { tokensOutput: existing.tokensOutput } : {}),
      ...(taskPatch.tokensReasoning !== undefined ? { tokensReasoning: taskPatch.tokensReasoning } : existing?.tokensReasoning !== undefined ? { tokensReasoning: existing.tokensReasoning } : {}),
      ...(typeof taskPatch.acceptingSteer === 'boolean' ? { acceptingSteer: taskPatch.acceptingSteer } : typeof existing?.acceptingSteer === 'boolean' ? { acceptingSteer: existing.acceptingSteer } : {}),
      interruptPending: taskPatch.interruptPending ?? existing?.interruptPending ?? false,
      ...(taskPatch.durationSeconds !== undefined ? { durationSeconds: taskPatch.durationSeconds } : existing?.durationSeconds !== undefined ? { durationSeconds: existing.durationSeconds } : {}),
      ...(summary !== undefined ? { summary, resultSummary: summary } : {}),
      ...(taskPatch.error !== undefined ? { error: taskPatch.error } : existing?.error !== undefined ? { error: existing.error } : {}),
      startedAt: normalizeEpochMs(taskPatch.startedAt) ?? existing?.startedAt ?? now,
      updatedAt: normalizeEpochMs(taskPatch.updatedAt) ?? now,
      ...(normalizeEpochMs(taskPatch.completedAt) ?? existing?.completedAt
        ? { completedAt: normalizeEpochMs(taskPatch.completedAt) ?? existing?.completedAt }
        : {}),
      targetProfile: taskPatch.targetProfile || taskPatch.model || existing?.targetProfile || 'default',
      taskTitle: goal,
      status: taskPatch.status ?? norm.compatStatus,
      progressPercent:
        taskPatch.progressPercent !== undefined
          ? taskPatch.progressPercent
          : existing?.progressPercent ?? defaultProgressForLifecycle(taskPatch.lifecycleStatus ?? norm.lifecycle),
      currentActionText:
        taskPatch.currentActionText ?? existing?.currentActionText ?? lastTool ?? '',
    };

    if (incoming.parentSessionId) {
      this.mergeSessionRecords(incoming.parentSessionId, [incoming]);
      return this.tasks.get(canonicalId) ?? incoming;
    }

    const updated = mergeSubagentRecord(existing, incoming);
    this.tasks.set(canonicalId, updated);
    this.notify();
    return updated;
  }

  public applyEventUpdate(update: SubagentUpdateAction): SubagentTaskState {
    const resolvedId =
      update.subagentId ||
      (update.delegationId
        ? `deleg:${update.delegationId}:${update.taskIndex ?? 0}`
        : `deleg:goal:${normalizeGoalKey(update.goal) || 'unknown'}:${update.taskIndex ?? 0}`);
    const currentText =
      update.toolPreview || update.toolName || update.text || update.summary || update.error || '';
    const updated = this.upsertTask({
      subagentId: resolvedId,
      parentSessionId: update.sessionId,
      ...(update.delegationId ? { delegationId: update.delegationId } : {}),
      ...(update.taskIndex !== undefined ? { taskIndex: update.taskIndex } : {}),
      ...(update.childSessionId ? { childSessionId: update.childSessionId } : {}),
      ...(update.goal ? { goal: update.goal, taskTitle: update.goal } : {}),
      ...(update.lifecycleStatus ? { lifecycleStatus: update.lifecycleStatus, status: update.lifecycleStatus } : {}),
      ...(update.phaseHint ? { phaseHint: update.phaseHint } : {}),
      source: 'live_event',
      ...(update.model ? { model: update.model, targetProfile: update.model } : {}),
      ...(update.depth !== undefined ? { depth: update.depth } : {}),
      ...(update.parentId ? { parentId: update.parentId } : {}),
      ...(update.toolCount !== undefined ? { toolCount: update.toolCount } : {}),
      ...(update.toolName ? { lastTool: update.toolName, toolNames: [update.toolName] } : {}),
      ...(update.filesRead ? { filesRead: update.filesRead } : {}),
      ...(update.filesWritten ? { filesWritten: update.filesWritten } : {}),
      ...(update.tokensInput !== undefined ? { tokensInput: update.tokensInput } : {}),
      ...(update.tokensOutput !== undefined ? { tokensOutput: update.tokensOutput } : {}),
      ...(update.tokensReasoning !== undefined ? { tokensReasoning: update.tokensReasoning } : {}),
      ...(typeof update.acceptingSteer === 'boolean' ? { acceptingSteer: update.acceptingSteer } : {}),
      ...(update.durationSeconds !== undefined ? { durationSeconds: update.durationSeconds } : {}),
      ...(update.summary ? { summary: update.summary, resultSummary: update.summary } : {}),
      ...(update.error ? { error: update.error } : {}),
      ...(currentText ? { currentActionText: currentText } : {}),
      ...(update.lifecycleStatus && isTerminalLifecycleStatus(update.lifecycleStatus)
        ? { completedAt: update.timestamp }
        : {}),
      updatedAt: update.timestamp,
    });

    if (update.outputTail && update.outputTail.length > 0) {
      for (const row of update.outputTail) {
        this.appendLog(updated.subagentId, {
          seq: Date.now(),
          timestamp: update.timestamp,
          kind: row.is_error ? 'stderr' : 'tool_call',
          text: `${row.tool}: ${row.preview}`,
        });
      }
    }
    return updated;
  }

  public reconcileFromMessages(sessionId: string, messages: readonly DelegationScanMessageInput[]): SubagentTaskState[] {
    const records = extractDelegationsFromMessages(messages, sessionId);
    if (records.length > 0) {
      this.mergeSessionRecords(sessionId, records);
    }
    return this.getTasksBySession(sessionId);
  }

  public reconcileFromSpawnTree(sessionId: string, loadedSubagents: ReadonlyArray<Record<string, unknown>>): SubagentTaskState[] {
    if (!sessionId || !Array.isArray(loadedSubagents) || loadedSubagents.length === 0) {
      return this.getTasksBySession(sessionId);
    }
    const records: SubagentTaskState[] = [];
    for (const raw of loadedSubagents) {
      const id = typeof raw.subagent_id === 'string' && raw.subagent_id ? raw.subagent_id : '';
      const delegId = typeof raw.delegation_id === 'string' && raw.delegation_id ? raw.delegation_id : undefined;
      const taskIdx = typeof raw.task_index === 'number' ? raw.task_index : undefined;
      const goal = typeof raw.goal === 'string' ? raw.goal : typeof raw.title === 'string' ? raw.title : '子任务';
      const subagentId = id || (delegId ? `deleg:${delegId}:${taskIdx ?? normalizeGoalKey(goal)}` : '');
      if (!subagentId) continue;

      const norm = normalizeStatusToLifecycleAndHint(typeof raw.status === 'string' ? raw.status : 'completed');
      const startedAt = normalizeEpochMs(raw.started_at) ?? Date.now();
      const updatedAt = normalizeEpochMs(raw.updated_at) ?? normalizeEpochMs(raw.completed_at) ?? startedAt;
      const completedAt = normalizeEpochMs(raw.completed_at);

      records.push({
        subagentId,
        parentSessionId: sessionId,
        goal,
        lifecycleStatus: norm.lifecycle,
        phaseHint: norm.phaseHint,
        source: 'spawn_tree',
        ...(delegId ? { delegationId: delegId } : {}),
        ...(taskIdx !== undefined ? { taskIndex: taskIdx } : {}),
        ...(typeof raw.child_session_id === 'string' ? { childSessionId: raw.child_session_id } : {}),
        ...(typeof raw.model === 'string' ? { model: raw.model } : {}),
        ...(typeof raw.depth === 'number' ? { depth: raw.depth } : {}),
        ...(typeof raw.parent_id === 'string' ? { parentId: raw.parent_id } : {}),
        toolCount: typeof raw.tool_count === 'number' ? raw.tool_count : 0,
        ...(typeof raw.last_tool === 'string' ? { lastTool: raw.last_tool } : {}),
        ...(Array.isArray(raw.files_read) ? { filesRead: raw.files_read.filter((x: unknown): x is string => typeof x === 'string') } : {}),
        ...(Array.isArray(raw.files_written) ? { filesWritten: raw.files_written.filter((x: unknown): x is string => typeof x === 'string') } : {}),
        ...(typeof raw.summary === 'string' ? { summary: raw.summary, resultSummary: raw.summary } : {}),
        ...(typeof raw.error === 'string' ? { error: raw.error } : {}),
        startedAt,
        updatedAt,
        ...(completedAt !== undefined ? { completedAt } : isTerminalLifecycleStatus(norm.lifecycle) ? { completedAt: updatedAt } : {}),
        targetProfile: (typeof raw.model === 'string' && raw.model) || 'subagent',
        taskTitle: goal,
        status: norm.compatStatus,
        progressPercent: defaultProgressForLifecycle(norm.lifecycle),
        currentActionText: (typeof raw.summary === 'string' && raw.summary) || (typeof raw.last_tool === 'string' ? raw.last_tool : ''),
      });
    }

    if (records.length > 0) {
      this.mergeSessionRecords(sessionId, records);
    }
    return this.getTasksBySession(sessionId);
  }

  public appendLog(subagentId: string, entry: SubagentLogEntry): void {
    const canonical = this.resolveSubagentId(subagentId);
    let buffer = this.tailBuffers.get(canonical);
    if (!buffer) {
      buffer = new RingBuffer<SubagentLogEntry>(this.maxLogCapacity);
      this.tailBuffers.set(canonical, buffer);
    }
    buffer.push(entry);

    const listeners = this.tailListeners.get(canonical);
    if (listeners) {
      for (const listener of listeners) {
        listener(entry);
      }
    }
  }

  public async spawnSubagent(
    params: SubagentSpawnParams,
    bridge: ISubagentRpcBridge
  ): Promise<SubagentTaskState> {
    void bridge;
    log.error('subagent.spawn is not an RPC on this gateway', {
      parentSessionId: params.parent_session_id,
      targetProfile: params.target_profile,
      hint: '子代理由 Agent 通过 delegate_task 工具派生，客户端仅有 list/steer/interrupt/tail',
    });
    throw new UnsupportedCapabilityError(
      'subagent.spawn',
      '网关不提供 subagent.spawn RPC：子代理由 Agent 在回合内通过 delegate_task 工具派生，' +
        '客户端只能 subagent.list / steer / interrupt / tail。'
    );
  }

  /**
   * 向运行中的子代理发送干预纠偏指令 (subagent.steer)
   */
  public async steerSubagent(
    subagentId: string,
    instruction: string,
    bridge: ISubagentRpcBridge,
    options?: { sessionId?: string; profile?: string }
  ): Promise<SubagentSteerOutcome> {
    const expectedEpoch = this.clearEpoch;
    const canonical = this.resolveSubagentId(subagentId);
    if (isSyntheticSubagentId(canonical)) {
      return { ok: false, error: `Subagent ID not yet assigned: ${canonical}` };
    }
    const task = this.tasks.get(canonical);
    if (!task) {
      return { ok: false, error: `Subagent task not found: ${subagentId}` };
    }
    if (isTerminalLifecycleStatus(task.lifecycleStatus)) {
      return { ok: false, error: `Subagent task already ended: ${canonical}` };
    }
    const sessionId = options?.sessionId || task.parentSessionId;
    if (!sessionId) {
      return { ok: false, error: `Subagent session not found: ${subagentId}` };
    }

    this.appendLog(canonical, {
      seq: Date.now(),
      timestamp: Date.now(),
      kind: 'status_change',
      text: `[用户实时干预指令]: ${instruction}`,
    });

    try {
      const res = await bridge.request<SubagentSteerResult, SubagentSteerParams>('subagent.steer', {
        subagent_id: canonical,
        session_id: sessionId,
        ...(options?.profile ? { profile: options.profile } : {}),
        text: instruction,
      });

      if (this.clearEpoch !== expectedEpoch) {
        return { ok: false, error: 'Subagent store cleared' };
      }

      const status: 'queued' | 'rejected' =
        res.status === 'rejected'
          ? 'rejected'
          : res.accepted || res.status === 'queued'
          ? 'queued'
          : 'rejected';
      const echoedText = typeof res.text === 'string' && res.text ? res.text : instruction;

      if (status === 'queued' && this.tasks.has(canonical)) {
        this.upsertTask({
          subagentId: canonical,
          currentActionText: `已下发干预指令: ${echoedText.slice(0, 30)}...`,
        });
      }

      return { ok: true, status, text: echoedText };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      if (this.clearEpoch !== expectedEpoch) {
        return { ok: false, error: errorMsg };
      }
      this.appendLog(canonical, {
        seq: Date.now(),
        timestamp: Date.now(),
        kind: 'stderr',
        text: `纠偏指令发送失败: ${errorMsg}`,
      });
      return { ok: false, error: errorMsg };
    }
  }

  /**
   * 中断终止正在执行的子代理 (subagent.interrupt)
   * 【约束】绝不在 RPC 返回前预设 `completedAt` 或落定 `'interrupted'`：
   *   - `found: true` 才收口为 `'interrupted'` + `completedAt` 并返 `{ ok: true }`；
   *   - `found: false` 清除 `interruptPending`，返 `{ ok: false, reason: 'not_found' }` 并触发列表对账；
   *   - 异常抛错回滚 `interruptPending = false`，写 stderr 日志，返 `{ ok: false, reason: 'rpc_error', error }`。
   */
  public async interruptSubagent(
    subagentId: string,
    bridge: ISubagentRpcBridge,
    options?: { sessionId?: string; profile?: string }
  ): Promise<SubagentInterruptOutcome> {
    const expectedEpoch = this.clearEpoch;
    const canonical = this.resolveSubagentId(subagentId);
    if (isSyntheticSubagentId(canonical)) {
      return { ok: false, reason: 'synthetic_id' };
    }
    const task = this.tasks.get(canonical);
    const sessionId = options?.sessionId || task?.parentSessionId;
    if (!task || !sessionId) {
      return { ok: false, reason: 'not_found' };
    }
    if (isTerminalLifecycleStatus(task.lifecycleStatus)) {
      return { ok: false, reason: 'already_ended' };
    }

    this.tasks.set(canonical, { ...task, interruptPending: true, updatedAt: Date.now() });
    this.notify();

    try {
      const res = await bridge.request<SubagentInterruptResult, SubagentInterruptParams>('subagent.interrupt', {
        subagent_id: canonical,
        session_id: sessionId,
        ...(options?.profile ? { profile: options.profile } : {}),
      });

      if (this.clearEpoch !== expectedEpoch) {
        return { ok: false, reason: 'not_found' };
      }

      const found = typeof res?.found === 'boolean' ? res.found : Boolean(res?.interrupted);
      if (found) {
        const now = Date.now();
        this.upsertTask({
          subagentId: canonical,
          lifecycleStatus: 'interrupted',
          status: 'interrupted',
          phaseHint: 'idle',
          interruptPending: false,
          completedAt: now,
          currentActionText: '用户已终止任务',
          updatedAt: now,
        });
        return { ok: true };
      }

      const current = this.tasks.get(canonical);
      if (current) {
        this.tasks.set(canonical, { ...current, interruptPending: false, updatedAt: Date.now() });
        this.notify();
      }
      void this.syncSessionSubagents(sessionId, bridge, {
        ...options,
        storedSessionId: task.parentSessionId,
      });
      return { ok: false, reason: 'not_found' };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (this.clearEpoch !== expectedEpoch) {
        return { ok: false, reason: 'rpc_error', error: errMsg };
      }
      const current = this.tasks.get(canonical);
      if (current) {
        this.tasks.set(canonical, { ...current, interruptPending: false, updatedAt: Date.now() });
        this.notify();
      }
      this.appendLog(canonical, {
        seq: Date.now(),
        timestamp: Date.now(),
        kind: 'stderr',
        text: `终止指令发送失败: ${errMsg}`,
      });
      return { ok: false, reason: 'rpc_error', error: errMsg };
    }
  }

  /**
   * 同步列表失败处理（INV-SUBAGENT-07）：保留既有已观察子任务，不致空。
   */
  public applyListSyncError(sessionId: string, errorMessage: string): void {
    if (!sessionId) return;
    this.lastListSyncError.set(sessionId, errorMessage || 'subagent.list failed');
    this.notify();
  }

  /**
   * 从网关拉取并同步指定会话的子代理列表（受 `sessionGeneration` 代际围栏保护，INV-SUBAGENT-01）
   */
  public async syncSessionSubagents(
    sessionId: string,
    bridge: ISubagentRpcBridge,
    options?: { storedSessionId?: string; profile?: string; expectedGeneration?: number }
  ): Promise<void> {
    if (!sessionId) return;
    const storedSessionId = options?.storedSessionId || sessionId;
    const expectedEpoch = this.clearEpoch;
    const expectedGen = options?.expectedGeneration ?? this.getSessionGeneration(storedSessionId);

    try {
      const params: { session_id: string; profile?: string } = { session_id: sessionId };
      if (options?.profile) params.profile = options.profile;
      const res = await bridge.request<SubagentListResult>('subagent.list', params);

      // 代际栅栏（INV-SUBAGENT-01）：切会话或全局清空后慢响应一律丢弃
      if (this.clearEpoch !== expectedEpoch || this.getSessionGeneration(storedSessionId) !== expectedGen) {
        return;
      }

      this.lastListSyncError.delete(storedSessionId);
      const batch: SubagentTaskState[] = [];
      const now = Date.now();

      if (res && Array.isArray(res.subagents)) {
        for (const item of res.subagents) {
          const snap = item as SubagentSnapshot & {
            parent_session_id?: string;
            profile?: string;
            title?: string;
            progress?: number;
            current_action?: string;
            updated_at?: number;
          };
          const norm = normalizeStatusToLifecycleAndHint(snap.status ?? 'running');
          const goal = snap.goal || snap.title || '子任务';
          const startedAt = normalizeEpochMs(snap.started_at) ?? now;
          const updatedAt = normalizeEpochMs(snap.updated_at) ?? now;
          batch.push({
            subagentId: snap.subagent_id,
            parentSessionId: snap.parent_session_id || storedSessionId,
            goal,
            lifecycleStatus: norm.lifecycle,
            phaseHint: norm.phaseHint,
            source: 'subagent_list',
            ...(snap.delegation_id ? { delegationId: snap.delegation_id } : {}),
            ...(snap.child_session_id ? { childSessionId: snap.child_session_id } : {}),
            ...(snap.model ? { model: snap.model } : {}),
            ...(typeof snap.depth === 'number' ? { depth: snap.depth } : {}),
            ...(snap.parent_id ? { parentId: snap.parent_id } : {}),
            toolCount: typeof snap.tool_count === 'number' ? snap.tool_count : 0,
            ...(snap.last_tool ? { lastTool: snap.last_tool, toolNames: [snap.last_tool] } : {}),
            ...(typeof snap.accepting_steer === 'boolean' ? { acceptingSteer: snap.accepting_steer } : {}),
            startedAt,
            updatedAt,
            ...(isTerminalLifecycleStatus(norm.lifecycle) ? { completedAt: updatedAt } : {}),
            targetProfile: snap.profile || snap.model || 'default',
            taskTitle: goal,
            status: norm.compatStatus,
            progressPercent: typeof snap.progress === 'number' ? snap.progress : defaultProgressForLifecycle(norm.lifecycle),
            currentActionText: snap.current_action || snap.last_tool || '',
          });
        }
      }

      if (res && Array.isArray(res.delegations)) {
        for (const failed of res.delegations as FailedDelegation[]) {
          const synthId = `deleg:${failed.delegation_id}:${failed.task_index ?? normalizeGoalKey(failed.goal)}`;
          const norm = normalizeStatusToLifecycleAndHint(failed.status || 'failed');
          const startedAt = normalizeEpochMs(failed.dispatched_at) ?? now;
          const completedAt = normalizeEpochMs(failed.completed_at) ?? startedAt;
          batch.push({
            subagentId: synthId,
            parentSessionId: storedSessionId,
            goal: failed.goal || '子任务失败',
            lifecycleStatus: norm.lifecycle === 'running' || norm.lifecycle === 'queued' ? 'failed' : norm.lifecycle,
            phaseHint: 'idle',
            source: 'subagent_list',
            delegationId: failed.delegation_id,
            ...(typeof failed.task_index === 'number' ? { taskIndex: failed.task_index } : {}),
            toolCount: 0,
            ...(failed.error ? { error: failed.error } : {}),
            startedAt,
            updatedAt: completedAt,
            completedAt,
            targetProfile: 'subagent',
            taskTitle: failed.goal || '子任务失败',
            status: 'failed',
            progressPercent: 100,
            currentActionText: failed.error || '',
          });
        }
      }

      if (batch.length > 0) {
        this.mergeSessionRecords(storedSessionId, batch);
      }
    } catch (err) {
      if (this.clearEpoch !== expectedEpoch || this.getSessionGeneration(storedSessionId) !== expectedGen) {
        return;
      }
      this.applyListSyncError(storedSessionId, err instanceof Error ? err.message : String(err));
      log.debug('subagent.list sync failed (keeping cached tasks)', err);
    }
  }

  /**
   * 穿透加载子代理对话流（`session.transcript` 20 页游标排空 + `-32601` 降级与自愈升级）
   */
  public async loadSubagentTranscript(options: {
    subagentId: string;
    storedSessionId: string;
    liveSessionId?: string | null;
    profile?: string;
    bridge: ISubagentRpcBridge;
    childSessionId?: string;
    fetchChildMessages?: (childSessionId: string, profile?: string) => Promise<StoredTranscriptRow[] | null>;
    maxPages?: number;
  }): Promise<SubagentTranscriptState> {
    const canonical = this.resolveSubagentId(options.subagentId);
    const task = this.tasks.get(canonical);
    const parentSessionId = task?.parentSessionId || options.storedSessionId;
    const expectedEpoch = this.clearEpoch;
    const expectedGen = this.getSessionGeneration(parentSessionId);
    const isStale = (): boolean =>
      this.clearEpoch !== expectedEpoch || this.getSessionGeneration(parentSessionId) !== expectedGen;
    const prevState = this.transcriptStates.get(canonical);
    const knownChildId = options.childSessionId || task?.childSessionId || prevState?.childSessionId;

    const tryChildRestAndDegrade = async (
      running: boolean,
      errorMessage?: string
    ): Promise<SubagentTranscriptState> => {
      if (knownChildId && options.fetchChildMessages) {
        try {
          const restRows = await options.fetchChildMessages(knownChildId, options.profile);
          if (isStale()) {
            return this.getTranscriptState(canonical);
          }
          if (Array.isArray(restRows) && restRows.length > 0) {
            const readyState: SubagentTranscriptState = {
              status: 'ready',
              rows: restRows,
              nextCursor: null,
              running,
              available: true,
              childSessionId: knownChildId,
              transcriptUnsupported: true,
              updatedAt: Date.now(),
            };
            this.transcriptStates.set(canonical, readyState);
            this.notify();
            return readyState;
          }
        } catch (restErr) {
          log.debug('child session REST fallback unavailable', restErr);
        }
      }

      if (options.liveSessionId && !isSyntheticSubagentId(canonical)) {
        await this.loadSubagentTail(canonical, options.bridge, 100, {
          sessionId: options.liveSessionId,
          profile: options.profile,
        });
        if (isStale()) {
          return this.getTranscriptState(canonical);
        }
      }

      const degraded: SubagentTranscriptState = {
        status: 'degraded_tail',
        rows: prevState?.rows ?? [],
        nextCursor: null,
        running,
        available: false,
        ...(knownChildId ? { childSessionId: knownChildId } : {}),
        transcriptUnsupported: this.transcriptUnsupported.has(canonical),
        ...(errorMessage ? { error: errorMessage } : {}),
        updatedAt: Date.now(),
      };
      this.transcriptStates.set(canonical, degraded);
      this.notify();
      return degraded;
    };

    if (this.transcriptUnsupported.has(canonical) || isSyntheticSubagentId(canonical)) {
      const running = task ? task.lifecycleStatus === 'queued' || task.lifecycleStatus === 'running' : false;
      return tryChildRestAndDegrade(running);
    }

    this.transcriptStates.set(canonical, {
      status: prevState?.status === 'ready' ? 'ready' : 'loading',
      rows: prevState?.rows ?? [],
      nextCursor: prevState?.nextCursor ?? null,
      running: prevState?.running ?? false,
      available: prevState?.available ?? false,
      ...(knownChildId ? { childSessionId: knownChildId } : {}),
      transcriptUnsupported: false,
      updatedAt: Date.now(),
    });
    this.notify();

    const maxPages = Math.max(1, Math.min(20, options.maxPages ?? 20));
    let cursor: string | null = prevState?.nextCursor ?? null;
    let accumulated: StoredTranscriptRow[] = prevState?.rows ? prevState.rows.slice() : [];
    const seenKeys = new Set<string>(accumulated.map((row, i) => buildRowDedupKey(row, i)));
    const seenCursors = new Set<string>();
    let pageBaseIndex = cursor === null ? 0 : accumulated.length;
    let lastResult: StoredTranscriptResult | null = null;

    for (let page = 0; page < maxPages; page++) {
      try {
        const res = await options.bridge.request<StoredTranscriptResult>('session.transcript', {
          session_id: options.storedSessionId,
          subagent_id: canonical,
          order: 'oldest',
          ...(options.profile ? { profile: options.profile } : {}),
          ...(cursor ? { cursor } : {}),
        });

        if (isStale()) {
          return this.getTranscriptState(canonical);
        }

        lastResult = res;
        if (res.child_session_id) {
          this.upsertTask({ subagentId: canonical, childSessionId: res.child_session_id });
        }

        if (res.reset) {
          accumulated = [];
          seenKeys.clear();
          pageBaseIndex = 0;
        }

        const pageRows = Array.isArray(res.rows) ? res.rows : [];
        for (let i = 0; i < pageRows.length; i++) {
          const key = buildRowDedupKey(pageRows[i], pageBaseIndex + i);
          if (!seenKeys.has(key)) {
            seenKeys.add(key);
            accumulated.push(pageRows[i]);
          }
        }
        pageBaseIndex += pageRows.length;

        if (res.available === false && accumulated.length === 0) {
          return tryChildRestAndDegrade(Boolean(res.running));
        }

        const nextCursor = typeof res.next_cursor === 'string' && res.next_cursor ? res.next_cursor : null;
        if (!nextCursor || seenCursors.has(nextCursor)) {
          cursor = null;
          break;
        }
        seenCursors.add(nextCursor);
        cursor = nextCursor;
      } catch (err) {
        if (isStale()) {
          return this.getTranscriptState(canonical);
        }

        if (isMethodUnsupportedError(err)) {
          this.transcriptUnsupported.add(canonical);
          const running = task ? task.lifecycleStatus === 'queued' || task.lifecycleStatus === 'running' : false;
          return tryChildRestAndDegrade(running, err instanceof Error ? err.message : String(err));
        }

        const msg = err instanceof Error ? err.message : String(err);
        if (accumulated.length > 0) {
          const partialState: SubagentTranscriptState = {
            status: 'ready',
            rows: accumulated,
            nextCursor: cursor,
            running: Boolean(lastResult?.running),
            available: true,
            ...(knownChildId || lastResult?.child_session_id ? { childSessionId: lastResult?.child_session_id || knownChildId } : {}),
            transcriptUnsupported: false,
            error: msg,
            isIncrementalError: true,
            updatedAt: Date.now(),
          };
          this.transcriptStates.set(canonical, partialState);
          this.notify();
          return partialState;
        }

        const errState: SubagentTranscriptState = {
          status: 'error',
          rows: [],
          nextCursor: null,
          running: false,
          available: false,
          ...(knownChildId ? { childSessionId: knownChildId } : {}),
          transcriptUnsupported: false,
          error: msg,
          updatedAt: Date.now(),
        };
        this.transcriptStates.set(canonical, errState);
        this.notify();
        return errState;
      }
    }

    const ready: SubagentTranscriptState = {
      status: 'ready',
      rows: accumulated,
      nextCursor: cursor,
      running: Boolean(lastResult?.running),
      available: lastResult?.available !== false,
      ...(knownChildId || lastResult?.child_session_id ? { childSessionId: lastResult?.child_session_id || knownChildId } : {}),
      transcriptUnsupported: false,
      updatedAt: Date.now(),
    };
    this.transcriptStates.set(canonical, ready);
    this.notify();
    return ready;
  }

  /**
   * 穿透加载子代理的历史日志 (subagent.tail)
   */
  public async loadSubagentTail(
    subagentId: string,
    bridge: ISubagentRpcBridge,
    limit = 100,
    options?: { sessionId?: string; profile?: string }
  ): Promise<SubagentLogEntry[]> {
    const canonical = this.resolveSubagentId(subagentId);
    const task = this.tasks.get(canonical);
    const expectedEpoch = this.clearEpoch;
    const parentSessionId = task?.parentSessionId;
    const expectedGen = parentSessionId ? this.getSessionGeneration(parentSessionId) : undefined;
    try {
      const res = await bridge.request<SubagentTailResult>('subagent.tail', {
        subagent_id: canonical,
        session_id: options?.sessionId || task?.parentSessionId,
        ...(options?.profile ? { profile: options.profile } : {}),
      });
      if (
        this.clearEpoch !== expectedEpoch ||
        (parentSessionId && this.getSessionGeneration(parentSessionId) !== expectedGen)
      ) {
        return this.getLogs(canonical);
      }
      if (res && Array.isArray(res.entries)) {
        let seen = this.seenTailSeqs.get(canonical);
        if (!seen) {
          seen = new Set(this.getLogs(canonical).map((e) => e.seq));
          this.seenTailSeqs.set(canonical, seen);
        }
        for (const entry of res.entries) {
          if (seen.has(entry.seq)) continue;
          seen.add(entry.seq);
          this.appendLog(canonical, entry);
        }
      } else if (res && typeof res.text === 'string' && res.text) {
        const prevText = this.lastTailSnapshotText.get(canonical);
        if (res.text !== prevText) {
          const delta =
            prevText && res.text.startsWith(prevText)
              ? res.text.slice(prevText.length).trim()
              : res.text;
          this.lastTailSnapshotText.set(canonical, res.text);
          if (delta) {
            this.appendLog(canonical, {
              seq: Date.now(),
              timestamp: Date.now(),
              kind: 'stdout',
              text: delta,
            });
          }
        }
      }
    } catch (err) {
      log.warn('subagent.tail failed', { subagentId: canonical, limit, err });
    }
    return this.getLogs(canonical);
  }

  public clearSession(sessionId: string): void {
    this.advanceSessionGeneration(sessionId);
    this.lastListSyncError.delete(sessionId);
    const idsToDelete: string[] = [];
    for (const [id, task] of this.tasks.entries()) {
      if (task.parentSessionId === sessionId) {
        idsToDelete.push(id);
      }
    }
    for (const id of idsToDelete) {
      this.tasks.delete(id);
      this.tailBuffers.delete(id);
      this.tailListeners.delete(id);
      this.transcriptStates.delete(id);
      this.transcriptUnsupported.delete(id);
      this.seenTailSeqs.delete(id);
      this.lastTailSnapshotText.delete(id);
      if (this.activeTailSubagentId === id) {
        this.activeTailSubagentId = null;
      }
    }
    for (const [alias, canonical] of this.subagentAliasMap.entries()) {
      if (idsToDelete.includes(canonical) || idsToDelete.includes(alias)) {
        this.subagentAliasMap.delete(alias);
      }
    }
    if (idsToDelete.length > 0) {
      this.notify();
    }
  }

  /** 清空全部会话子 Agent 缓存（断线 / 重连初始化使用） */
  public clearAll(): void {
    this.clearEpoch += 1;
    const sessionsToBump = new Set<string>(this.sessionGenerations.keys());
    for (const task of this.tasks.values()) {
      if (task.parentSessionId) {
        sessionsToBump.add(task.parentSessionId);
      }
    }
    for (const sid of sessionsToBump) {
      this.advanceSessionGeneration(sid);
    }

    const hadState =
      this.tasks.size > 0 ||
      this.lastListSyncError.size > 0 ||
      this.activeTailSubagentId !== null;

    this.tasks.clear();
    this.tailBuffers.clear();
    this.tailListeners.clear();
    this.transcriptStates.clear();
    this.transcriptUnsupported.clear();
    this.seenTailSeqs.clear();
    this.lastTailSnapshotText.clear();
    this.subagentAliasMap.clear();
    this.lastListSyncError.clear();
    this.activeTailSubagentId = null;

    if (hadState) {
      this.notify();
    }
  }
}

export type { SessionLiveInfo };
