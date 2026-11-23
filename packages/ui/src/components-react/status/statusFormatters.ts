/**
 * 状态栏与子 Agent 监控共享纯格式化与元数据映射助手
 *
 * 【设计意图 (Why)】
 *   消除 SessionStatusPanel、SubagentDetailView 与 ContextBreakdownDrawer 之间重复的
 *   耗时格式化、Token 简写及状态徽章/尾部日志枚举映射，保证三处界面展示 100% 单源一致，
 *   并彻底杜绝原始英文枚举裸露或无效 `startedAt <= 0` 触发天文数字计时串。
 */

import type { SubagentLifecycleStatus, SubagentLogEntry, SubagentTaskState } from '@hermes-flux/core';
import { t } from '../../i18n/index.js';
import type { SubagentRowTone } from './SubagentRow.js';

export function formatTokenShort(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens < 0) return '0';
  if (tokens >= 1_000_000) {
    const val = tokens / 1_000_000;
    return Number.isInteger(val) ? `${val}m` : `${val.toFixed(1)}m`;
  }
  if (tokens >= 1_000) {
    const val = Math.round(tokens / 1_000);
    return `${val}k`;
  }
  return String(Math.round(tokens));
}

export function formatDurationSecondsCompact(durationSeconds: number): string {
  if (!Number.isFinite(durationSeconds) || durationSeconds < 0) return '';
  const totalSec = Math.floor(durationSeconds);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const remSec = totalSec % 60;
  if (min < 60) return `${min}m${String(remSec).padStart(2, '0')}s`;
  const hrs = Math.floor(min / 60);
  return `${hrs}h${String(min % 60).padStart(2, '0')}m`;
}

export function formatElapsedCompact(startedAt: number, endAt: number): string {
  if (!Number.isFinite(startedAt) || startedAt <= 0 || !Number.isFinite(endAt)) return '';
  return formatDurationSecondsCompact(Math.max(0, (endAt - startedAt) / 1000));
}

export function isActiveLifecycleStatus(status: SubagentLifecycleStatus): boolean {
  return status === 'queued' || status === 'running';
}

export function resolveTaskDurationLabel(
  task: Pick<SubagentTaskState, 'lifecycleStatus' | 'durationSeconds' | 'startedAt' | 'completedAt' | 'updatedAt'>,
  now: number
): string | undefined {
  const active = isActiveLifecycleStatus(task.lifecycleStatus);
  if (!active && typeof task.durationSeconds === 'number' && Number.isFinite(task.durationSeconds) && task.durationSeconds >= 0) {
    return formatDurationSecondsCompact(task.durationSeconds) || undefined;
  }
  const endTs = active ? now : (task.completedAt ?? task.updatedAt);
  const formatted = formatElapsedCompact(task.startedAt, endTs);
  return formatted || undefined;
}

export function statusMetaForLifecycle(status: SubagentLifecycleStatus): { label: string; tone: SubagentRowTone } {
  switch (status) {
    case 'queued':
      return { label: t('statusPod.statusQueued'), tone: 'queued' };
    case 'running':
      return { label: t('statusPod.statusRunning'), tone: 'running' };
    case 'completed':
      return { label: t('statusPod.statusCompleted'), tone: 'success' };
    case 'failed':
      return { label: t('statusPod.statusFailed'), tone: 'danger' };
    case 'error':
      return { label: t('statusPod.statusError'), tone: 'danger' };
    case 'timeout':
      return { label: t('statusPod.statusTimeout'), tone: 'danger' };
    case 'interrupted':
      return { label: t('statusPod.statusInterrupted'), tone: 'muted' };
  }
}

export function isGroupActivityActive(rawStatus: string): boolean {
  const s = rawStatus.trim().toLowerCase();
  if (!s) return false;
  return !['completed', 'done', 'failed', 'error', 'timeout', 'timed_out', 'interrupted', 'cancelled', 'canceled', 'idle'].includes(s);
}

export function groupActivityMeta(rawStatus: string): { label: string; tone: SubagentRowTone } {
  const s = rawStatus.trim().toLowerCase();
  if (s === 'completed' || s === 'done') return { label: t('statusPod.statusCompleted'), tone: 'success' };
  if (s === 'failed' || s === 'error') return { label: t('statusPod.statusFailed'), tone: 'danger' };
  if (s === 'timeout' || s === 'timed_out') return { label: t('statusPod.statusTimeout'), tone: 'danger' };
  if (s === 'queued' || s === 'waiting' || s === 'pending') return { label: t('statusPod.statusQueued'), tone: 'queued' };
  if (s === 'interrupted' || s === 'cancelled' || s === 'canceled') {
    return { label: t('statusPod.statusInterrupted'), tone: 'muted' };
  }
  if (s === 'running' || s === 'active' || s === 'thinking' || s === 'tool_executing' || s === 'tool_calling' || s === 'busy' || s === 'working') {
    return { label: t('statusPod.statusRunning'), tone: 'running' };
  }
  return { label: t('statusPod.statusUnknown'), tone: 'running' };
}

export function tailKindLabel(kind: SubagentLogEntry['kind'] | string): string {
  switch (kind) {
    case 'stderr':
      return t('statusPod.tailKindStderr');
    case 'thought':
      return t('statusPod.tailKindThought');
    case 'tool_call':
      return t('statusPod.tailKindToolCall');
    case 'tool_result':
      return t('statusPod.tailKindToolResult');
    case 'status_change':
      return t('statusPod.tailKindStatus');
    case 'stdout':
    default:
      return t('statusPod.tailKindStdout');
  }
}
