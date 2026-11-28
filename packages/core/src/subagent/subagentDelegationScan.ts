/**
 * 主对话 Delegate 工具消息扫描与 L3 历史占位提取
 * (packages/core/src/subagent/subagentDelegationScan.ts)
 *
 * 【设计意图 (Why)】
 *   从已落盘或流式进行中的主对话 `delegate_task` 工具行中提取初始占位记录，
 *   并在用户点击轨迹行跳转按钮时提供 1:1 无歧义 `subagentId` 匹配。
 *
 * 【约束与规则 (Rules)】
 *   - 纯函数，零 DOM / React / Electron 依赖；
 *   - 共享状态规范化函数与 `subagentStore.ts` 复用同一份实现，禁止复制。
 */

import type {
  SubagentLifecycleStatus,
  SubagentPhaseHint,
  SubagentStatus,
  SubagentTaskState,
} from '../rpc/types.js';
import { normalizeEpochMs } from '../session/eventReducer.js';

export interface DelegationScanMessageInput {
  id: string;
  role: string;
  content?: string;
  timestamp?: number;
  toolCalls?: ReadonlyArray<{
    id: string;
    name: string;
    status?: string;
    args?: string;
    rawArgs?: unknown;
    output?: string;
    durationMs?: number;
    startTime?: number;
    subagentId?: string;
    delegationId?: string;
  }>;
}

export function isTerminalLifecycleStatus(status: SubagentLifecycleStatus): boolean {
  return (
    status === 'completed' ||
    status === 'failed' ||
    status === 'error' ||
    status === 'timeout' ||
    status === 'interrupted'
  );
}

export function lifecycleRank(status: SubagentLifecycleStatus): 0 | 1 | 2 {
  if (status === 'queued') return 0;
  if (status === 'running') return 1;
  return 2;
}

export function normalizeStatusToLifecycleAndHint(
  raw: SubagentStatus | string | null | undefined
): { lifecycle: SubagentLifecycleStatus; phaseHint: SubagentPhaseHint; compatStatus: SubagentStatus } {
  const s = typeof raw === 'string' ? raw.toLowerCase() : 'running';
  switch (s) {
    case 'queued':
      return { lifecycle: 'queued', phaseHint: 'queued', compatStatus: 'queued' };
    case 'requested':
      return { lifecycle: 'queued', phaseHint: 'queued', compatStatus: 'requested' };
    case 'thinking':
      return { lifecycle: 'running', phaseHint: 'thinking', compatStatus: 'thinking' };
    case 'tool_executing':
      return { lifecycle: 'running', phaseHint: 'tool', compatStatus: 'tool_executing' };
    case 'completed':
      return { lifecycle: 'completed', phaseHint: 'idle', compatStatus: 'completed' };
    case 'failed':
      return { lifecycle: 'failed', phaseHint: 'idle', compatStatus: 'failed' };
    case 'error':
      return { lifecycle: 'error', phaseHint: 'idle', compatStatus: 'error' };
    case 'timeout':
      return { lifecycle: 'timeout', phaseHint: 'idle', compatStatus: 'timeout' };
    case 'interrupted':
      return { lifecycle: 'interrupted', phaseHint: 'idle', compatStatus: 'interrupted' };
    default:
      return { lifecycle: 'running', phaseHint: 'progress', compatStatus: 'running' };
  }
}

export function defaultProgressForLifecycle(lifecycle: SubagentLifecycleStatus): number {
  if (lifecycle === 'completed') return 100;
  if (lifecycle === 'queued') return 0;
  if (lifecycle === 'running') return 10;
  return 100;
}

export function normalizeGoalKey(raw: string | null | undefined): string {
  return typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ').slice(0, 120) : '';
}

export function isSyntheticSubagentId(id: string | null | undefined): boolean {
  return typeof id === 'string' && id.startsWith('deleg:');
}

function parseToolArgsObject(rawArgs: unknown, argsText?: string): Record<string, unknown> | null {
  if (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)) {
    return rawArgs as Record<string, unknown>;
  }
  const str = typeof rawArgs === 'string' ? rawArgs : argsText;
  if (typeof str === 'string' && str.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(str);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    // gate-degrade: 工具 args 非合法 JSON 对象时回落 null（纯文本参数按无结构化目标处理）
    } catch {
      return null;
    }
  }
  return null;
}

function parseJsonSafe(raw: string | undefined): Record<string, unknown> | null {
  if (!raw || !raw.trim().startsWith('{')) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  // gate-degrade: 工具 output 非合法 JSON 时回落 null，避免阻断历史工具行扫描
  } catch {
    return null;
  }
}

const DELEGATION_STATUS_ALIAS: Readonly<Record<string, SubagentStatus>> = {
  queued: 'queued',
  requested: 'requested',
  pending: 'queued',
  running: 'running',
  dispatched: 'running',
  started: 'running',
  in_progress: 'running',
  accepted: 'running',
  thinking: 'thinking',
  tool_executing: 'tool_executing',
  completed: 'completed',
  done: 'completed',
  ok: 'completed',
  success: 'completed',
  succeeded: 'completed',
  failed: 'failed',
  error: 'error',
  timeout: 'timeout',
  interrupted: 'interrupted',
  cancelled: 'interrupted',
  canceled: 'interrupted',
};

function mapDelegationStatusToken(rawStatus: string): SubagentStatus | undefined {
  return DELEGATION_STATUS_ALIAS[rawStatus.trim().toLowerCase()];
}

/**
 * 解析 `delegate_task` 工具调用的真实子代理生命周期状态
 *
 * 设计意图 (Why):
 *   异步委派工具在网关「派发回执」返回瞬间，外层工具行 `tc.status` 即变为 `'completed'`，
 *   但 `output` JSON 内明确携带 `{"status":"running"|"dispatched"|"queued"}` 或 `{"async":true}`，
 *   表示子代理仍在后台执行。
 *
 * 防范的历史坑 (Pitfall):
 *   仅凭 `tc.status === 'completed'` 会把未完结子代理误标成终态 `completed`（rank=2）；
 *   经单调合并守卫（INV-SUBAGENT-02）锁死后，后续真实 `subagent.list` (`running`, rank=1) 无法覆写，
 *   导致顶栏活跃微点与状态栏「进行中」列表永久丢失。
 *
 * 约束与规则 (Rules):
 *   - 优先信任结构化 `outputObj.status`（按别名表映射），次选 `outputObj.async === true`，最后回落 `tc.status`。
 */
export function resolveDelegationStatusFromTool(
  tcStatus: string | undefined,
  outputObj: Record<string, unknown> | null
): { lifecycle: SubagentLifecycleStatus; phaseHint: SubagentPhaseHint; compatStatus: SubagentStatus } {
  if (typeof outputObj?.status === 'string') {
    const mapped = mapDelegationStatusToken(outputObj.status);
    if (mapped) {
      return normalizeStatusToLifecycleAndHint(mapped);
    }
  }
  if (outputObj?.async === true && tcStatus !== 'failed' && tcStatus !== 'error') {
    return normalizeStatusToLifecycleAndHint('running');
  }
  if (tcStatus === 'failed' || tcStatus === 'error') {
    return normalizeStatusToLifecycleAndHint('failed');
  }
  if (tcStatus === 'completed') {
    return normalizeStatusToLifecycleAndHint('completed');
  }
  return normalizeStatusToLifecycleAndHint('running');
}

/**
 * L3 兜底扫描：从主对话 `delegate_task` 工具调用消息中纯提取历史子任务占位（零 UI 依赖）。
 */
export function extractDelegationsFromMessages(
  messages: readonly DelegationScanMessageInput[],
  sessionId: string
): SubagentTaskState[] {
  if (!sessionId || !Array.isArray(messages)) return [];
  const extracted: SubagentTaskState[] = [];
  const now = Date.now();

  for (const msg of messages) {
    if (!Array.isArray(msg.toolCalls)) continue;
    const msgTs = normalizeEpochMs(msg.timestamp) ?? now;
    for (const tc of msg.toolCalls) {
      if (tc.name !== 'delegate_task') continue;
      const argsObj = parseToolArgsObject(tc.rawArgs, tc.args);
      const outputObj = parseJsonSafe(tc.output);
      const startedAt = normalizeEpochMs(tc.startTime) ?? msgTs;
      const isSettledTool = tc.status === 'completed' || tc.status === 'failed' || tc.status === 'error';
      const baseNorm = resolveDelegationStatusFromTool(tc.status, outputObj);
      const baseLifecycle = baseNorm.lifecycle;

      const outputDelegationId =
        typeof outputObj?.delegation_id === 'string' ? outputObj.delegation_id : undefined;
      const delegationId = tc.delegationId || outputDelegationId || tc.id;
      const outputResults = Array.isArray(outputObj?.results)
        ? (outputObj.results as Array<Record<string, unknown>>)
        : null;
      const argTasks = Array.isArray(argsObj?.tasks)
        ? (argsObj.tasks as Array<Record<string, unknown>>)
        : null;

      if (outputResults && outputResults.length > 0) {
        outputResults.forEach((row, idx) => {
          const rowSubId = typeof row.subagent_id === 'string' && row.subagent_id ? row.subagent_id : '';
          const goal =
            (typeof row.goal === 'string' && row.goal) ||
            (typeof argTasks?.[idx]?.goal === 'string' ? (argTasks[idx].goal as string) : '') ||
            '委派子任务';
          const mappedRowStatus =
            typeof row.status === 'string'
              ? (mapDelegationStatusToken(row.status) ?? row.status)
              : baseLifecycle;
          const { lifecycle, phaseHint, compatStatus } = normalizeStatusToLifecycleAndHint(mappedRowStatus);
          const id = rowSubId || `deleg:${delegationId}:${idx}`;
          const summary =
            (typeof row.summary === 'string' && row.summary) ||
            (typeof row.result === 'string' && row.result) ||
            undefined;
          const error = typeof row.error === 'string' ? row.error : undefined;
          extracted.push({
            subagentId: id,
            parentSessionId: sessionId,
            goal,
            lifecycleStatus: lifecycle,
            phaseHint,
            source: 'transcript_scan',
            delegationId,
            taskIndex: typeof row.task_index === 'number' ? row.task_index : idx,
            ...(typeof row.child_session_id === 'string' ? { childSessionId: row.child_session_id } : {}),
            ...(typeof row.model === 'string' ? { model: row.model } : {}),
            toolCount: typeof row.tool_count === 'number' ? row.tool_count : 0,
            ...(summary !== undefined ? { summary, resultSummary: summary } : {}),
            ...(error !== undefined ? { error } : {}),
            startedAt,
            updatedAt: startedAt,
            ...(isTerminalLifecycleStatus(lifecycle) ? { completedAt: startedAt + (tc.durationMs ?? 0) } : {}),
            targetProfile: (typeof row.model === 'string' && row.model) || 'subagent',
            taskTitle: goal,
            status: compatStatus,
            progressPercent: defaultProgressForLifecycle(lifecycle),
            currentActionText: summary || error || '',
          });
        });
        continue;
      }

      if (argTasks && argTasks.length > 0) {
        argTasks.forEach((taskItem, idx) => {
          const goal =
            (typeof taskItem.goal === 'string' && taskItem.goal) ||
            (typeof taskItem.task === 'string' && taskItem.task) ||
            '委派子任务';
          const id = `deleg:${delegationId}:${idx}`;
          extracted.push({
            subagentId: id,
            parentSessionId: sessionId,
            goal,
            lifecycleStatus: baseLifecycle,
            phaseHint: baseNorm.phaseHint,
            source: 'transcript_scan',
            delegationId,
            taskIndex: idx,
            ...(typeof taskItem.model === 'string' ? { model: taskItem.model } : {}),
            toolCount: 0,
            startedAt,
            updatedAt: startedAt,
            ...(isTerminalLifecycleStatus(baseLifecycle) ? { completedAt: startedAt + (tc.durationMs ?? 0) } : {}),
            targetProfile: (typeof taskItem.model === 'string' && taskItem.model) || 'subagent',
            taskTitle: goal,
            status: baseNorm.compatStatus,
            progressPercent: defaultProgressForLifecycle(baseLifecycle),
            currentActionText: '',
          });
        });
        continue;
      }

      const singleGoal =
        (typeof argsObj?.goal === 'string' && argsObj.goal) ||
        (typeof argsObj?.task === 'string' && argsObj.task) ||
        (typeof outputObj?.goal === 'string' && outputObj.goal) ||
        '委派子任务';
      const explicitSubId =
        tc.subagentId ||
        (typeof outputObj?.subagent_id === 'string' && outputObj.subagent_id ? outputObj.subagent_id : '');
      const id = explicitSubId || `deleg:${delegationId}:0`;
      const summary =
        (typeof outputObj?.summary === 'string' && outputObj.summary) ||
        (isTerminalLifecycleStatus(baseLifecycle) && isSettledTool && tc.output && !outputObj ? tc.output : undefined);
      extracted.push({
        subagentId: id,
        parentSessionId: sessionId,
        goal: singleGoal,
        lifecycleStatus: baseLifecycle,
        phaseHint: baseNorm.phaseHint,
        source: 'transcript_scan',
        delegationId,
        taskIndex: 0,
        ...(typeof outputObj?.child_session_id === 'string' ? { childSessionId: outputObj.child_session_id } : {}),
        ...(typeof argsObj?.model === 'string' ? { model: argsObj.model } : {}),
        toolCount: 0,
        ...(summary !== undefined ? { summary, resultSummary: summary } : {}),
        startedAt,
        updatedAt: startedAt,
        ...(isTerminalLifecycleStatus(baseLifecycle) ? { completedAt: startedAt + (tc.durationMs ?? 0) } : {}),
        targetProfile: (typeof argsObj?.model === 'string' && argsObj.model) || 'subagent',
        taskTitle: singleGoal,
        status: baseNorm.compatStatus,
        progressPercent: defaultProgressForLifecycle(baseLifecycle),
        currentActionText: summary || '',
      });
    }
  }

  applyAsyncDelegationCompletions(messages, extracted, sessionId);

  return extracted;
}

const ASYNC_BATCH_HEADER_RE = /^\[ASYNC DELEGATION BATCH COMPLETE\s*(?:—|--|-)\s*([A-Za-z0-9_:-]+)\]/m;
const ASYNC_BATCH_MODEL_RE = /^Role:\s*\S+\s+Model:\s*(\S+)(?:\s+Total duration:\s*(\d+(?:\.\d+)?)s)?/m;
const ASYNC_TASK_HEADER_RE =
  /^[ \t]*---\s*([^\r\n]*?)\s*TASK\s+(\d+)\s*\/\s*(\d+):\s*([\s\S]+?)\s+\(([^)\r\n]+)\)\s*---\s*$/gm;
const FULL_TRANSCRIPT_PATH_RE = /^[ \t]*Full live transcript\b[^:]*:\s*(\S+)\s*$/gm;

function mapAsyncCompletionStatus(rawStatus: string, marker: string): SubagentStatus {
  const s = rawStatus.trim().toLowerCase();
  if (s === 'cancelled' || s === 'canceled') return 'interrupted';
  if (s === 'timed_out') return 'timeout';
  if (s === 'done' || s === 'success' || s === 'succeeded') return 'completed';
  if (s === 'completed' || s === 'failed' || s === 'error' || s === 'timeout' || s === 'interrupted') {
    return s;
  }
  return /[✗✘×]/.test(marker) ? 'failed' : 'completed';
}

interface ParsedAsyncCompletionTask {
  delegationId: string;
  taskIndex: number;
  goal: string;
  status: SubagentStatus;
  durationSeconds?: number;
  apiCalls?: number;
  model?: string;
  summary: string;
  transcriptLogPath?: string;
}

function parseAsyncDelegationCompletionMessage(content: string): ParsedAsyncCompletionTask[] {
  if (!content || !content.includes('[ASYNC DELEGATION BATCH COMPLETE')) return [];
  const headerMatch = ASYNC_BATCH_HEADER_RE.exec(content);
  if (!headerMatch?.[1]) return [];
  const delegationId = headerMatch[1].trim();
  const modelMatch = ASYNC_BATCH_MODEL_RE.exec(content);
  const batchModel = modelMatch?.[1]?.trim() || undefined;
  const batchDuration = modelMatch?.[2] ? Number(modelMatch[2]) : undefined;

  const transcriptPaths: string[] = [];
  FULL_TRANSCRIPT_PATH_RE.lastIndex = 0;
  let pathMatch: RegExpExecArray | null;
  while ((pathMatch = FULL_TRANSCRIPT_PATH_RE.exec(content)) !== null) {
    if (pathMatch[1]) transcriptPaths.push(pathMatch[1].trim());
  }

  const headers: Array<{
    start: number;
    end: number;
    marker: string;
    taskIndex: number;
    goal: string;
    meta: string;
  }> = [];
  ASYNC_TASK_HEADER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ASYNC_TASK_HEADER_RE.exec(content)) !== null) {
    const oneBased = Number(m[2]);
    const taskIndex = Number.isFinite(oneBased) && oneBased > 0 ? oneBased - 1 : headers.length;
    headers.push({
      start: m.index,
      end: m.index + m[0].length,
      marker: m[1] || '',
      taskIndex,
      goal: (m[4] || '').trim(),
      meta: m[5] || '',
    });
  }

  const results: ParsedAsyncCompletionTask[] = [];
  for (let i = 0; i < headers.length; i += 1) {
    const cur = headers[i];
    const nextStart = i + 1 < headers.length ? headers[i + 1].start : content.length;
    const rawBody = content.slice(cur.end, nextStart);
    const cleanedBody = rawBody.replace(FULL_TRANSCRIPT_PATH_RE, '').trim();
    const statusMatch = /status\s*=\s*([a-zA-Z_-]+)/i.exec(cur.meta);
    const apiMatch = /api_calls\s*=\s*(\d+)/i.exec(cur.meta);
    const durMatch = /(?:^|[,\s])(\d+(?:\.\d+)?)s(?:$|[,\s])/i.exec(cur.meta);
    const status = mapAsyncCompletionStatus(statusMatch?.[1] || '', cur.marker);
    const durationSeconds = durMatch?.[1]
      ? Number(durMatch[1])
      : headers.length === 1 && typeof batchDuration === 'number' && Number.isFinite(batchDuration)
      ? batchDuration
      : undefined;
    const apiCalls = apiMatch?.[1] ? Number(apiMatch[1]) : undefined;

    const sectionPathMatch = /^[ \t]*Full live transcript\b[^:]*:\s*(\S+)\s*$/m.exec(rawBody);
    const matchedGlobalPath =
      transcriptPaths.find((p) => new RegExp(`/task-${cur.taskIndex}\\.log$`).test(p)) ??
      (headers.length === 1 ? transcriptPaths[0] : undefined);
    const transcriptLogPath = sectionPathMatch?.[1]?.trim() || matchedGlobalPath;

    results.push({
      delegationId,
      taskIndex: cur.taskIndex,
      goal: cur.goal || '委派子任务',
      status,
      ...(typeof durationSeconds === 'number' && Number.isFinite(durationSeconds) ? { durationSeconds } : {}),
      ...(typeof apiCalls === 'number' && Number.isFinite(apiCalls) ? { apiCalls } : {}),
      ...(batchModel ? { model: batchModel } : {}),
      summary: cleanedBody,
      ...(transcriptLogPath ? { transcriptLogPath } : {}),
    });
  }
  return results;
}

function applyAsyncDelegationCompletions(
  messages: readonly DelegationScanMessageInput[],
  extracted: SubagentTaskState[],
  sessionId: string
): void {
  const byKey = new Map<string, number>();
  extracted.forEach((rec, idx) => {
    if (rec.delegationId) {
      byKey.set(`${rec.delegationId}:${rec.taskIndex ?? 0}`, idx);
    }
  });

  for (const msg of messages) {
    if (!msg || (msg.role !== 'user' && msg.role !== 'system') || typeof msg.content !== 'string') {
      continue;
    }
    const completedItems = parseAsyncDelegationCompletionMessage(msg.content);
    if (completedItems.length === 0) continue;

    const completedAtMs = msg.timestamp ? normalizeEpochMs(msg.timestamp) ?? 0 : 0;
    for (const item of completedItems) {
      const norm = normalizeStatusToLifecycleAndHint(item.status);
      const isFailure = norm.lifecycle !== 'completed';
      const durMs =
        typeof item.durationSeconds === 'number' && Number.isFinite(item.durationSeconds)
          ? Math.round(item.durationSeconds * 1000)
          : 0;
      const compositeKey = `${item.delegationId}:${item.taskIndex}`;
      const existingIdx = byKey.get(compositeKey);

      if (existingIdx !== undefined) {
        const prev = extracted[existingIdx];
        const doneAt =
          completedAtMs > 0
            ? completedAtMs
            : prev.startedAt > 0
            ? prev.startedAt + durMs
            : prev.updatedAt;
        const resolvedModel = prev.model || item.model;
        const toolCount = Math.max(prev.toolCount, item.apiCalls ?? 0);
        extracted[existingIdx] = {
          ...prev,
          lifecycleStatus: norm.lifecycle,
          phaseHint: norm.phaseHint,
          status: norm.compatStatus,
          progressPercent: 100,
          ...(resolvedModel ? { model: resolvedModel, targetProfile: resolvedModel } : {}),
          toolCount,
          ...(item.durationSeconds !== undefined ? { durationSeconds: item.durationSeconds } : {}),
          ...(item.summary ? { summary: item.summary, resultSummary: item.summary } : {}),
          ...(isFailure && item.summary ? { error: item.summary } : {}),
          ...(item.transcriptLogPath ? { transcriptLogPath: item.transcriptLogPath } : {}),
          updatedAt: Math.max(prev.updatedAt, doneAt),
          completedAt: doneAt,
          currentActionText: item.summary ? item.summary.split(/\r?\n/)[0].slice(0, 120) : prev.currentActionText,
        };
      } else {
        const id = `deleg:${item.delegationId}:${item.taskIndex}`;
        const doneAt = completedAtMs > 0 ? completedAtMs : 0;
        const startedAt = doneAt > 0 && durMs > 0 ? Math.max(1, doneAt - durMs) : doneAt;
        extracted.push({
          subagentId: id,
          parentSessionId: sessionId,
          goal: item.goal,
          lifecycleStatus: norm.lifecycle,
          phaseHint: norm.phaseHint,
          source: 'transcript_scan',
          delegationId: item.delegationId,
          taskIndex: item.taskIndex,
          ...(item.model ? { model: item.model } : {}),
          toolCount: item.apiCalls ?? 0,
          ...(item.durationSeconds !== undefined ? { durationSeconds: item.durationSeconds } : {}),
          ...(item.summary ? { summary: item.summary, resultSummary: item.summary } : {}),
          ...(isFailure && item.summary ? { error: item.summary } : {}),
          ...(item.transcriptLogPath ? { transcriptLogPath: item.transcriptLogPath } : {}),
          startedAt,
          updatedAt: doneAt,
          completedAt: doneAt,
          targetProfile: item.model || 'subagent',
          taskTitle: item.goal,
          status: norm.compatStatus,
          progressPercent: 100,
          currentActionText: item.summary ? item.summary.split(/\r?\n/)[0].slice(0, 120) : '',
        });
        byKey.set(compositeKey, extracted.length - 1);
      }
    }
  }
}

/**
 * 把某条 `delegate_task` 工具行无歧义绑定到对应的子 Agent `subagentId`。
 */
export function matchSubagentForToolCall(
  toolCall: { id: string; args?: string; rawArgs?: unknown; subagentId?: string; delegationId?: string },
  sessionSubagents: readonly SubagentTaskState[]
): string | undefined {
  if (toolCall.subagentId) {
    const direct = sessionSubagents.find((s) => s.subagentId === toolCall.subagentId);
    if (direct) return direct.subagentId;
  }

  const argsObj = parseToolArgsObject(toolCall.rawArgs, toolCall.args);
  const delegationId = toolCall.delegationId || (typeof argsObj?.delegation_id === 'string' ? argsObj.delegation_id : '');
  if (delegationId) {
    const byDeleg = sessionSubagents.filter(
      (s) => s.delegationId === delegationId || s.subagentId === `deleg:${delegationId}:0`
    );
    if (byDeleg.length === 1) return byDeleg[0].subagentId;
    const realNonSynth = byDeleg.find((s) => !isSyntheticSubagentId(s.subagentId));
    if (realNonSynth) return realNonSynth.subagentId;
    if (byDeleg.length > 0) return byDeleg[0].subagentId;
  }

  const goal = typeof argsObj?.goal === 'string' ? normalizeGoalKey(argsObj.goal) : '';
  if (goal) {
    const byGoal = sessionSubagents.filter((s) => normalizeGoalKey(s.goal) === goal);
    if (byGoal.length === 1) return byGoal[0].subagentId;
  }

  return undefined;
}
