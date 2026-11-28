/**
 * Subagent Three-Source Monotone Lattice Merge & 1:1 Unambiguous Reconciliation
 * (packages/core/src/subagent/subagentReconcile.ts)
 *
 * 【设计意图 (Why)】
 *   将多源（WS 实时事件 + `subagent.list` + `spawn_tree.load` + 主对话工具扫描）的状态单调格融合与
 *   合成记录 (`deleg:...`) 双向 1:1 并入逻辑从 `subagentStore.ts` 拆分独立，保持模块职责单一且符合行数门禁。
 */

import type {
  SubagentLifecycleStatus,
  SubagentPhaseHint,
  SubagentRecordSource,
  SubagentStatus,
  SubagentTaskState,
} from '../rpc/types.js';
import {
  isSyntheticSubagentId,
  isTerminalLifecycleStatus,
  lifecycleRank,
  normalizeGoalKey,
} from './subagentDelegationScan.js';

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
    ...(incoming.transcriptLogPath || existing.transcriptLogPath
      ? { transcriptLogPath: incoming.transcriptLogPath || existing.transcriptLogPath }
      : {}),
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

function isCompatibleTaskIndex(a?: number, b?: number): boolean {
  return a === undefined || b === undefined || a === b;
}

function resolveUniqueCandidateByGoal(
  candidates: readonly SubagentTaskState[],
  incoming: Pick<SubagentTaskState, 'parentSessionId' | 'goal' | 'taskIndex' | 'delegationId'>,
): SubagentTaskState | null {
  const goalKey = incoming.goal ? normalizeGoalKey(incoming.goal) : '';
  if (!goalKey) return null;
  const matched = candidates.filter((c) => {
    if (c.parentSessionId !== incoming.parentSessionId) return false;
    if (!c.goal || normalizeGoalKey(c.goal) !== goalKey) return false;
    // 仅在同一 delegationId 作用域或缺失 delegationId 时校对 taskIndex；不同工具调用各自的 0 基序号互不约束
    const differentDelegation = Boolean(c.delegationId && incoming.delegationId && c.delegationId !== incoming.delegationId);
    return differentDelegation || isCompatibleTaskIndex(c.taskIndex, incoming.taskIndex);
  });
  if (matched.length === 1) return matched[0];
  if (incoming.taskIndex !== undefined) {
    const exactTaskIdx = matched.filter((c) => c.taskIndex === incoming.taskIndex);
    if (exactTaskIdx.length === 1) return exactTaskIdx[0];
  }
  return null;
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

  // 统计同批尚未命中的目标键数量，防止同文案多实例在缺 delegation_id 时被误折叠
  const batchGoalCounts = new Map<string, number>();
  for (const rawIncoming of incomingRecords) {
    const mappedId = aliasMap?.get(rawIncoming.subagentId) ?? rawIncoming.subagentId;
    if (byId.has(mappedId) || !rawIncoming.goal) continue;
    const goalKey = normalizeGoalKey(rawIncoming.goal);
    if (!goalKey) continue;
    const kindKey = isSyntheticSubagentId(mappedId) ? 'syn' : 'real';
    const composite = `${kindKey}|${rawIncoming.parentSessionId}|${goalKey}`;
    batchGoalCounts.set(composite, (batchGoalCounts.get(composite) ?? 0) + 1);
  }

  const hasUniqueIncomingGoal = (rec: SubagentTaskState): boolean => {
    if (!rec.goal) return false;
    const goalKey = normalizeGoalKey(rec.goal);
    if (!goalKey) return false;
    const kindKey = isSyntheticSubagentId(rec.subagentId) ? 'syn' : 'real';
    return batchGoalCounts.get(`${kindKey}|${rec.parentSessionId}|${goalKey}`) === 1;
  };

  for (const rawIncoming of incomingRecords) {
    const mappedId = aliasMap?.get(rawIncoming.subagentId) ?? rawIncoming.subagentId;
    const incoming = mappedId === rawIncoming.subagentId ? rawIncoming : { ...rawIncoming, subagentId: mappedId };

    if (byId.has(incoming.subagentId)) {
      byId.set(incoming.subagentId, mergeSubagentRecord(byId.get(incoming.subagentId), incoming));
      continue;
    }

    // 反向场景：真实记录先进入 Store，后到的消息扫描产生合成记录（deleg:...）时并入真实记录，避免 1 个子任务显示为 2 条
    if (isSyntheticSubagentId(incoming.subagentId)) {
      const realCandidates: SubagentTaskState[] = [];
      for (const candidate of byId.values()) {
        if (!isSyntheticSubagentId(candidate.subagentId) && candidate.parentSessionId === incoming.parentSessionId) {
          realCandidates.push(candidate);
        }
      }
      let matchedReal: SubagentTaskState | null = null;
      const delegMatches = incoming.delegationId
        ? realCandidates.filter((c) => c.delegationId === incoming.delegationId)
        : [];
      if (delegMatches.length > 0) {
        if (incoming.taskIndex !== undefined) {
          const byIndex = delegMatches.filter((c) => c.taskIndex === incoming.taskIndex);
          if (byIndex.length === 1) matchedReal = byIndex[0];
        } else if (delegMatches.length === 1) {
          const only = delegMatches[0];
          if (!incoming.goal || !only.goal || normalizeGoalKey(only.goal) === normalizeGoalKey(incoming.goal)) {
            matchedReal = only;
          }
        }
      } else if (hasUniqueIncomingGoal(incoming)) {
        matchedReal = resolveUniqueCandidateByGoal(realCandidates, incoming);
      }

      if (matchedReal) {
        byId.set(
          matchedReal.subagentId,
          mergeSubagentRecord(matchedReal, { ...incoming, subagentId: matchedReal.subagentId }),
        );
        resolvedAliases.push({ oldId: incoming.subagentId, newId: matchedReal.subagentId });
        continue;
      }
      byId.set(incoming.subagentId, { ...incoming });
      continue;
    }

    // 真实 subagent_id 抵达时尝试 1:1 无歧义合并合成记录
    let matchedSynthetic: SubagentTaskState | null = null;
    const syntheticCandidates: SubagentTaskState[] = [];
    for (const candidate of byId.values()) {
      if (isSyntheticSubagentId(candidate.subagentId) && candidate.parentSessionId === incoming.parentSessionId) {
        syntheticCandidates.push(candidate);
      }
    }

    const candidates = incoming.delegationId
      ? syntheticCandidates.filter((c) => c.delegationId === incoming.delegationId)
      : [];

    if (candidates.length > 0) {
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
    } else if (hasUniqueIncomingGoal(incoming)) {
      // 网关与本地消息扫描 delegation_id 不一致或快照缺失 delegation_id 时，退化为同会话唯一 goal 1:1 并入
      matchedSynthetic = resolveUniqueCandidateByGoal(syntheticCandidates, incoming);
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
