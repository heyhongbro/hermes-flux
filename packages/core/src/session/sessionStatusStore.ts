/**
 * 会话整体状态、右侧停靠三态互斥与群聊活跃状态机 (packages/core/src/session/sessionStatusStore.ts)
 *
 * 【设计意图 (Why)】
 *   统一管理右侧停靠区的唯一真值状态（closed / status / subagent / files）、
 *   各作用域的会话环境（cwd / branch / model）、用量与上下文窗口百分比、
 *   可选自动压缩阈值比例、上下文分类明细及群聊成员实时活跃进度。
 *
 * 【防范的历史坑 (Pitfall)】
 *   1. Fail-Safe：usage / context_breakdown 瞬断或报错不得清零上一次有效用量（INV-SUBAGENT-04）。
 *   2. 阈值诚实性：未配置或非法阈值不得回落写死假默认值（如 0.85），必须返回 null 不画刻度。
 *   3. 幽灵下钻防护：切换会话时若停留在 subagent 详情页，必须退出子详情并归位至 returnTo（INV-SUBAGENT-05）。
 *
 * 【约束与规则 (Rules)】
 *   - 纯 TypeScript 无界实现，零 DOM / React / Electron 依赖；
 *   - 网关下发 Unix 秒时间统一经 `normalizeEpochMs` 归一为毫秒。
 */

import type {
  ContextCategory,
  ContextFileSource,
  GroupsStateResult,
  RoomMember,
  SessionContextBreakdownResult,
  SessionLiveInfo,
  SessionUsagePayload,
  SessionUsageResult,
} from '../rpc/types.js';
import { normalizeEpochMs } from './eventReducer.js';

export type ConversationModeKind = 'scratchpad' | 'bot_forever_chat' | 'group_room';

export type RightPodMode =
  | { kind: 'closed' }
  | { kind: 'status' }
  | { kind: 'subagent'; subagentId: string; returnTo: 'status' | 'closed' }
  | { kind: 'files'; returnTo?: 'status' | 'closed' };

export type RightPodAction =
  | { type: 'toggle-status-bar' }
  | { type: 'toggle-files' }
  | { type: 'open-files'; fromStatusBar?: boolean }
  | { type: 'back-from-files' }
  | { type: 'open-subagent'; subagentId: string }
  | { type: 'back-from-subagent' }
  | { type: 'resolve-subagent-id'; oldId: string; newId: string }
  | { type: 'close' }
  | { type: 'session-switched'; conversationMode: ConversationModeKind };

/**
 * 右侧停靠容器三态互斥状态机纯转移函数 (INV-SUBAGENT-05)。
 */
export function reduceRightPodMode(current: RightPodMode, action: RightPodAction): RightPodMode {
  switch (action.type) {
    case 'toggle-status-bar':
      if (current.kind === 'closed' || current.kind === 'files') {
        return { kind: 'status' };
      }
      return { kind: 'closed' };

    case 'toggle-files':
      if (current.kind === 'files') {
        return { kind: 'closed' };
      }
      return { kind: 'files', returnTo: 'closed' };

    case 'open-files': {
      const fromStatus = action.fromStatusBar ?? (current.kind === 'status' || current.kind === 'subagent');
      return { kind: 'files', returnTo: fromStatus ? 'status' : 'closed' };
    }

    case 'back-from-files':
      if (current.kind === 'files') {
        return current.returnTo === 'status' ? { kind: 'status' } : { kind: 'closed' };
      }
      return current;

    case 'open-subagent':
      if (!action.subagentId) return current;
      return {
        kind: 'subagent',
        subagentId: action.subagentId,
        returnTo: current.kind === 'status' || (current.kind === 'subagent' && current.returnTo === 'status')
          ? 'status'
          : 'closed',
      };

    case 'back-from-subagent':
      if (current.kind === 'subagent') {
        return current.returnTo === 'status' ? { kind: 'status' } : { kind: 'closed' };
      }
      return current;

    case 'resolve-subagent-id':
      if (current.kind === 'subagent' && current.subagentId === action.oldId && action.newId) {
        return { ...current, subagentId: action.newId };
      }
      return current;

    case 'close':
      return { kind: 'closed' };

    case 'session-switched':
      if (current.kind === 'subagent') {
        return current.returnTo === 'status' ? { kind: 'status' } : { kind: 'closed' };
      }
      return current;
  }
}

export interface CompressionThresholdConfig {
  /** 已启用且校正在 `(0, 1)` 的比例阈值（如 `0.5`） */
  ratio: number | null;
  /** 可选 token 硬上限（如 `500000`） */
  thresholdTokens: number | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function normalizeThresholdRatio(raw: unknown): number | null {
  const num = asFiniteNumber(raw);
  if (num === null || num <= 0) return null;
  if (num < 1) return num;
  if (num <= 100) return num / 100;
  return null;
}

/**
 * 从网关全局配置对象解析自动压缩阈值配置；缺失或显式关闭一律返回 null（严禁编造假默认值）。
 */
export function extractCompressionThreshold(rawConfig: unknown): CompressionThresholdConfig | null {
  const root = asRecord(rawConfig);
  if (!root) return null;
  const unwrapped = asRecord(root.config) ?? root;
  const comp = asRecord(unwrapped.compression) ?? asRecord(unwrapped.context_compression);

  if (comp && comp.enabled === false) {
    return null;
  }

  const ratioCandidates: unknown[] = comp
    ? [
        comp.threshold,
        comp.auto_compact_threshold,
        comp.trigger_ratio,
        comp.ratio,
      ]
    : [];
  const candidatesToCheck: unknown[] = ratioCandidates.some((v) => v !== undefined)
    ? ratioCandidates
    : [
        unwrapped.compression_threshold,
        unwrapped.auto_compact_threshold,
        unwrapped.context_compression_threshold,
      ];

  let ratio: number | null = null;
  for (const cand of candidatesToCheck) {
    const normalized = normalizeThresholdRatio(cand);
    if (normalized !== null) {
      ratio = normalized;
      break;
    }
  }

  const tokenRaw = comp
    ? asFiniteNumber(comp.threshold_tokens)
    : asFiniteNumber(unwrapped.compression_threshold_tokens);
  const thresholdTokens = tokenRaw !== null && tokenRaw > 0 ? Math.round(tokenRaw) : null;

  if (ratio === null && thresholdTokens === null) {
    return null;
  }
  return { ratio, thresholdTokens };
}

/**
 * 结合当前模型上下文窗口上限计算最终在进度条上展示的有效刻度比例 `(0, 1)`。
 */
export function resolveEffectiveCompressionRatio(
  cfg: CompressionThresholdConfig | null,
  contextMax: number | null | undefined
): number | null {
  if (!cfg) return null;
  const candidates: number[] = [];
  if (cfg.ratio !== null && cfg.ratio > 0 && cfg.ratio < 1) {
    candidates.push(cfg.ratio);
  }
  if (
    cfg.thresholdTokens !== null &&
    cfg.thresholdTokens > 0 &&
    typeof contextMax === 'number' &&
    Number.isFinite(contextMax) &&
    contextMax > 0
  ) {
    const tokenRatio = cfg.thresholdTokens / contextMax;
    if (tokenRatio > 0 && tokenRatio < 1) {
      candidates.push(tokenRatio);
    }
  }
  if (candidates.length === 0) return null;
  return Math.min(...candidates);
}

export interface SessionUsageView {
  model?: string;
  input: number;
  output: number;
  reasoning: number;
  calls: number;
  cacheHitPct: number | null;
  contextUsed: number | null;
  contextMax: number | null;
  contextPercent: number | null;
  contextEstimated: boolean;
  compressions: number;
  updatedAt: number;
}

export interface ContextBreakdownState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  categories: ContextCategory[];
  contextFiles: ContextFileSource[];
  contextUsed: number | null;
  contextMax: number | null;
  contextPercent: number | null;
  contextEstimated: boolean;
  error?: string;
  updatedAt: number;
}

export interface GroupMemberActivityView {
  memberId: string;
  displayName: string;
  handle?: string;
  profile?: string;
  status: string;
  roundIndex: number | null;
  tool?: string;
  startedAt?: number;
  progressAt?: number;
}

export type GroupApprovalModeChoice = 'once' | 'session' | 'always' | 'deny';

export type NormalizedGroupPendingAction =
  | {
      kind: 'approval';
      memberId: string;
      taskId: string;
      executionGeneration: number;
      requestId: string;
      command?: string;
      description?: string;
      toolName?: string;
      choices: GroupApprovalModeChoice[];
      allowSession?: boolean;
      allowPermanent?: boolean;
    }
  | {
      kind: 'retry' | 'prepare';
      memberId: string;
      taskId: string;
      executionGeneration: number;
      errorDetail?: string;
      rawKind?: string;
    };

export interface GroupRoomStatusView {
  roomId: string;
  name: string;
  routing?: string;
  memberCount: number;
  running: boolean;
  working: boolean;
  blocked: boolean;
  counts: Record<string, number>;
  pendingActions: NormalizedGroupPendingAction[];
  memberActivity: GroupMemberActivityView[];
  lastError?: string | null;
  updatedAt: number;
}

export type NormalizedApprovalMode = 'manual' | 'smart' | 'off';

export interface ScopedSessionStatus {
  scopeKey: string;
  cwd?: string;
  branch?: string;
  model?: string;
  provider?: string;
  projectName?: string;
  approvalMode?: NormalizedApprovalMode;
  usage: SessionUsageView | null;
  usageError?: string;
  breakdown: ContextBreakdownState;
  groupState: GroupRoomStatusView | null;
  groupError?: string;
}

export type SessionStatusListener = () => void;

export function normalizeSessionApprovalMode(info: SessionLiveInfo | Record<string, unknown> | null | undefined): NormalizedApprovalMode | undefined {
  if (!info || typeof info !== 'object') return undefined;
  const rec = info as Record<string, unknown>;
  const rawMode = rec.approval_mode;
  if (rawMode === 'manual' || rawMode === 'smart' || rawMode === 'off') {
    return rawMode;
  }
  if (rec.yolo === true) return 'off';
  if (rec.edit_approval_policy === 'ask') return 'manual';
  return undefined;
}

function normalizeGroupPendingActions(rawList: unknown): NormalizedGroupPendingAction[] {
  if (!Array.isArray(rawList)) return [];
  const out: NormalizedGroupPendingAction[] = [];
  for (const raw of rawList) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const item = raw as Record<string, unknown>;
    const rawKind = typeof item.kind === 'string' ? item.kind.trim() : '';
    const memberId = typeof item.member_id === 'string' ? item.member_id.trim() : '';
    const taskId = typeof item.task_id === 'string' ? item.task_id.trim() : '';
    const executionGeneration =
      typeof item.execution_generation === 'number' && Number.isFinite(item.execution_generation)
        ? item.execution_generation
        : 0;
    const requestId = typeof item.request_id === 'string' ? item.request_id.trim() : '';

    if (rawKind === 'approval' || requestId) {
      if (!taskId || !requestId) continue;
      const validChoices: GroupApprovalModeChoice[] = [];
      if (Array.isArray(item.choices)) {
        for (const c of item.choices) {
          if (c === 'once' || c === 'session' || c === 'always' || c === 'deny') {
            validChoices.push(c);
          }
        }
      }
      if (validChoices.length === 0) {
        validChoices.push('once');
        if (item.allow_session === true) validChoices.push('session');
        if (item.allow_permanent === true) validChoices.push('always');
        validChoices.push('deny');
      }
      out.push({
        kind: 'approval',
        memberId,
        taskId,
        executionGeneration,
        requestId,
        ...(typeof item.command === 'string' && item.command ? { command: item.command } : {}),
        ...(typeof item.description === 'string' && item.description ? { description: item.description } : {}),
        ...(typeof item.tool_name === 'string' && item.tool_name ? { toolName: item.tool_name } : {}),
        choices: validChoices,
        ...(typeof item.allow_session === 'boolean' ? { allowSession: item.allow_session } : {}),
        ...(typeof item.allow_permanent === 'boolean' ? { allowPermanent: item.allow_permanent } : {}),
      });
      continue;
    }

    if (taskId.startsWith('prepare:')) {
      out.push({
        kind: 'prepare',
        memberId,
        taskId,
        executionGeneration,
        ...(typeof item.error === 'string' && item.error ? { errorDetail: item.error } : {}),
        ...(rawKind ? { rawKind } : {}),
      });
      continue;
    }

    if (taskId) {
      const detail =
        (typeof item.error === 'string' && item.error) ||
        (typeof item.reason === 'string' && item.reason) ||
        (typeof item.message === 'string' && item.message) ||
        undefined;
      out.push({
        kind: 'retry',
        memberId,
        taskId,
        executionGeneration,
        ...(detail ? { errorDetail: detail } : {}),
        ...(rawKind ? { rawKind } : {}),
      });
    }
  }
  return out;
}
function createDefaultBreakdown(): ContextBreakdownState {
  return {
    status: 'idle',
    categories: [],
    contextFiles: [],
    contextUsed: null,
    contextMax: null,
    contextPercent: null,
    contextEstimated: false,
    updatedAt: 0,
  };
}

function createEmptyScope(scopeKey: string): ScopedSessionStatus {
  return {
    scopeKey,
    usage: null,
    breakdown: createDefaultBreakdown(),
    groupState: null,
  };
}

export function buildSessionScopeKey(storedSessionId: string): string {
  return `session:${storedSessionId}`;
}

export function buildGroupScopeKey(roomId: string): string {
  return `group:${roomId}`;
}

function resolveMemberName(member: RoomMember | undefined, memberId: string): { displayName: string; handle?: string; profile?: string } {
  const displayName =
    (typeof member?.display_name === 'string' && member.display_name.trim()) ||
    (typeof member?.handle === 'string' && member.handle.trim()) ||
    (typeof member?.profile === 'string' && member.profile.trim()) ||
    memberId;
  return {
    displayName,
    ...(typeof member?.handle === 'string' && member.handle ? { handle: member.handle } : {}),
    ...(typeof member?.profile === 'string' && member.profile ? { profile: member.profile } : {}),
  };
}

export class SessionStatusStore {
  private readonly scopes = new Map<string, ScopedSessionStatus>();
  private readonly listeners = new Set<SessionStatusListener>();
  private compressionThreshold: CompressionThresholdConfig | null = null;

  public subscribe(listener: SessionStatusListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  private ensureScope(scopeKey: string): ScopedSessionStatus {
    let scope = this.scopes.get(scopeKey);
    if (!scope) {
      scope = createEmptyScope(scopeKey);
      this.scopes.set(scopeKey, scope);
    }
    return scope;
  }

  public getScope(scopeKey: string): ScopedSessionStatus | undefined {
    const scope = this.scopes.get(scopeKey);
    if (!scope) return undefined;
    return {
      ...scope,
      usage: scope.usage ? { ...scope.usage } : null,
      breakdown: {
        ...scope.breakdown,
        categories: scope.breakdown.categories.slice(),
        contextFiles: scope.breakdown.contextFiles.slice(),
      },
      groupState: scope.groupState
        ? {
            ...scope.groupState,
            memberActivity: scope.groupState.memberActivity.slice(),
            pendingActions: scope.groupState.pendingActions.slice(),
            counts: { ...scope.groupState.counts },
          }
        : null,
    };
  }

  public setCompressionThreshold(cfg: CompressionThresholdConfig | null): void {
    this.compressionThreshold = cfg;
    this.notify();
  }

  public getCompressionThreshold(): CompressionThresholdConfig | null {
    return this.compressionThreshold;
  }

  public deleteScope(scopeKey: string): void {
    if (this.scopes.delete(scopeKey)) {
      this.notify();
    }
  }

  public applySessionInfo(scopeKey: string, info: SessionLiveInfo | null | undefined): void {
    if (!scopeKey || !info || typeof info !== 'object') return;
    const scope = this.ensureScope(scopeKey);

    if (typeof info.cwd === 'string' && info.cwd.trim()) {
      scope.cwd = info.cwd.trim();
    }
    if (typeof info.branch === 'string') {
      scope.branch = info.branch.trim() || undefined;
    } else if (info.branch === null) {
      scope.branch = undefined;
    }
    if (typeof info.model === 'string' && info.model.trim()) {
      scope.model = info.model.trim();
    }
    if (typeof info.provider === 'string' && info.provider.trim()) {
      scope.provider = info.provider.trim();
    }
    if (info.project && typeof info.project.name === 'string' && info.project.name.trim()) {
      scope.projectName = info.project.name.trim();
    }
    const nextApprovalMode = normalizeSessionApprovalMode(info);
    if (nextApprovalMode) {
      scope.approvalMode = nextApprovalMode;
    }

    if (info.usage) {
      this.mergeUsageIntoScope(scope, info.usage, undefined);
    }
    this.notify();
  }

  /**
   * 合并 `session.usage` 下行帧（`SessionUsagePayload`）或 `session.usage` RPC 响应（`SessionUsageResult`）。
   * 严格优先消费契约权威字段 `payload.usage` (`Usage | null`)，缺失时兼容顶层字段。
   */
  public applyUsagePayload(
    scopeKey: string,
    payload: SessionUsagePayload | SessionUsageResult | null | undefined
  ): void {
    if (!scopeKey || !payload || typeof payload !== 'object') return;
    const scope = this.ensureScope(scopeKey);
    const hasNested = 'usage' in payload && payload.usage && typeof payload.usage === 'object';
    const primary = hasNested
      ? (payload as SessionUsagePayload).usage!
      : (payload as SessionUsageResult);
    const topCompat = payload as SessionUsagePayload;
    this.mergeUsageIntoScope(scope, primary, topCompat);
    scope.usageError = undefined;
    this.notify();
  }

  private mergeUsageIntoScope(
    scope: ScopedSessionStatus,
    primary: Partial<SessionUsageResult>,
    topCompat?: SessionUsagePayload
  ): void {
    const prev = scope.usage;
    const model =
      (typeof primary.model === 'string' && primary.model.trim()) ||
      (typeof topCompat?.model === 'string' && topCompat.model.trim()) ||
      scope.model;
    if (model) {
      scope.model = model;
    }

    const input = asFiniteNumber(primary.input) ?? asFiniteNumber(topCompat?.input_tokens) ?? prev?.input ?? 0;
    const output = asFiniteNumber(primary.output) ?? asFiniteNumber(topCompat?.output_tokens) ?? prev?.output ?? 0;
    const reasoning = asFiniteNumber(primary.reasoning) ?? asFiniteNumber(topCompat?.reasoning_tokens) ?? prev?.reasoning ?? 0;
    const calls = asFiniteNumber(primary.calls) ?? asFiniteNumber(topCompat?.api_calls) ?? prev?.calls ?? 0;
    const compressions = asFiniteNumber(primary.compressions) ?? asFiniteNumber(topCompat?.compression_count) ?? prev?.compressions ?? 0;

    let cacheHitPct = asFiniteNumber(primary.cache_hit_pct);
    if (cacheHitPct === null) {
      const cacheRead = asFiniteNumber(primary.cache_read) ?? asFiniteNumber(topCompat?.cache_read_tokens) ?? 0;
      const prompt = asFiniteNumber(primary.prompt) ?? asFiniteNumber(topCompat?.prompt_tokens) ?? input;
      if (cacheRead > 0 && prompt > 0) {
        cacheHitPct = Math.max(0, Math.min(100, Math.round((cacheRead / prompt) * 100)));
      } else {
        cacheHitPct = prev?.cacheHitPct ?? null;
      }
    }

    const rawCtxMax =
      asFiniteNumber(primary.context_max) ??
      asFiniteNumber(topCompat?.config_context_length) ??
      asFiniteNumber(topCompat?.context_length);
    const rawCtxUsed =
      asFiniteNumber(primary.context_used) ??
      asFiniteNumber(topCompat?.context_tokens);
    const rawCtxPct = asFiniteNumber(primary.context_percent);

    // Phase 0 实证：`session.usage` 在 resume 刚建立且未发新回合时 omit context_max/context_used，
    // 若已从 `session.context_breakdown` 或前一次非零读数拿到有效窗口值则保留之，避免零闪退。
    // 反之若收到新的非零窗口用量但省略了 context_percent（如 compress 后刷新 usage），必须按最新比例重算，严禁沿用旧百分比。
    const hasFreshWindowUsage =
      (rawCtxUsed !== null && (rawCtxUsed > 0 || (rawCtxMax !== null && rawCtxMax > 0))) ||
      (rawCtxMax !== null && rawCtxMax > 0);
    const contextMax =
      rawCtxMax !== null && rawCtxMax > 0
        ? rawCtxMax
        : (prev?.contextMax ?? scope.breakdown.contextMax ?? null);
    const contextUsed =
      rawCtxUsed !== null && (rawCtxUsed > 0 || (rawCtxMax !== null && rawCtxMax > 0))
        ? rawCtxUsed
        : (prev?.contextUsed ?? scope.breakdown.contextUsed ?? null);

    let contextPercent: number | null;
    if (rawCtxPct !== null && (rawCtxPct > 0 || (rawCtxMax !== null && rawCtxMax > 0))) {
      contextPercent = rawCtxPct;
    } else if (hasFreshWindowUsage && contextUsed !== null && contextMax !== null && contextMax > 0) {
      contextPercent = Math.max(0, Math.min(100, Math.round((contextUsed / contextMax) * 100)));
    } else {
      contextPercent = prev?.contextPercent ?? scope.breakdown.contextPercent ?? null;
    }

    scope.usage = {
      ...(model ? { model } : {}),
      input,
      output,
      reasoning,
      calls,
      cacheHitPct,
      contextUsed,
      contextMax,
      contextPercent,
      contextEstimated:
        typeof primary.context_estimated === 'boolean'
          ? primary.context_estimated
          : (prev?.contextEstimated ?? scope.breakdown.contextEstimated),
      compressions,
      updatedAt: Date.now(),
    };
  }

  /**
   * 用量请求 Fail-Safe（INV-SUBAGENT-04）：仅写错误标记，严禁清空既有有效用量读数。
   */
  public applyUsageError(scopeKey: string, errorMessage: string): void {
    if (!scopeKey) return;
    const scope = this.ensureScope(scopeKey);
    scope.usageError = errorMessage || 'usage unavailable';
    this.notify();
  }

  public setBreakdownLoading(scopeKey: string): void {
    if (!scopeKey) return;
    const scope = this.ensureScope(scopeKey);
    scope.breakdown = {
      ...scope.breakdown,
      status: 'loading',
      error: undefined,
    };
    this.notify();
  }

  public applyContextBreakdown(scopeKey: string, result: SessionContextBreakdownResult): void {
    if (!scopeKey || !result || typeof result !== 'object') return;
    const scope = this.ensureScope(scopeKey);
    if (typeof result.model === 'string' && result.model.trim()) {
      scope.model = result.model.trim();
    }
    const ctxMax = asFiniteNumber(result.context_max);
    const ctxUsed = asFiniteNumber(result.context_used) ?? asFiniteNumber(result.estimated_total);
    const ctxPct = asFiniteNumber(result.context_percent);

    scope.breakdown = {
      status: 'ready',
      categories: Array.isArray(result.categories) ? result.categories.slice() : [],
      contextFiles: Array.isArray(result.context_files) ? result.context_files.slice() : [],
      contextUsed: ctxUsed,
      contextMax: ctxMax !== null && ctxMax > 0 ? ctxMax : scope.breakdown.contextMax,
      contextPercent: ctxPct,
      contextEstimated: Boolean(result.context_estimated),
      error: undefined,
      updatedAt: Date.now(),
    };

    // 若 usage 尚缺上下文上限（例如刚 resume 完未发回合），同步用 breakdown 实测值回填
    if (ctxMax !== null && ctxMax > 0) {
      const prevUsage = scope.usage;
      if (!prevUsage) {
        scope.usage = {
          ...(scope.model ? { model: scope.model } : {}),
          input: 0,
          output: 0,
          reasoning: 0,
          calls: 0,
          cacheHitPct: null,
          contextUsed: ctxUsed,
          contextMax: ctxMax,
          contextPercent:
            ctxPct ?? (ctxUsed !== null ? Math.max(0, Math.min(100, Math.round((ctxUsed / ctxMax) * 100))) : null),
          contextEstimated: Boolean(result.context_estimated),
          compressions: 0,
          updatedAt: Date.now(),
        };
      } else if (!prevUsage.contextMax || prevUsage.contextMax <= 0) {
        scope.usage = {
          ...prevUsage,
          contextUsed: ctxUsed ?? prevUsage.contextUsed,
          contextMax: ctxMax,
          contextPercent: ctxPct ?? prevUsage.contextPercent,
          contextEstimated: Boolean(result.context_estimated),
          updatedAt: Date.now(),
        };
      }
    }
    this.notify();
  }

  public applyBreakdownError(scopeKey: string, errorMessage: string): void {
    if (!scopeKey) return;
    const scope = this.ensureScope(scopeKey);
    scope.breakdown = {
      ...scope.breakdown,
      status: 'error',
      error: errorMessage || 'context_breakdown unavailable',
    };
    this.notify();
  }

  public applyGroupState(roomId: string, result: GroupsStateResult | null | undefined): void {
    if (!roomId || !result || typeof result !== 'object') return;
    const scopeKey = buildGroupScopeKey(roomId);
    const scope = this.ensureScope(scopeKey);

    const roomMembers = Array.isArray(result.room?.members) ? result.room!.members : [];
    const memberMap = new Map<string, RoomMember>();
    for (const m of roomMembers) {
      if (m.member_id) memberMap.set(m.member_id, m);
      if (m.profile) memberMap.set(m.profile, m);
      if (m.handle) memberMap.set(m.handle, m);
    }

    const driver = result.driver_status;
    const rawActivities = Array.isArray(driver?.member_activity) ? driver!.member_activity : [];
    const memberActivity: GroupMemberActivityView[] = rawActivities.map((act) => {
      const meta = resolveMemberName(memberMap.get(act.member_id), act.member_id);
      return {
        memberId: act.member_id,
        displayName: meta.displayName,
        ...(meta.handle ? { handle: meta.handle } : {}),
        ...(meta.profile ? { profile: meta.profile } : {}),
        status: act.status || 'running',
        roundIndex: typeof act.round_index === 'number' ? act.round_index : null,
        ...(typeof act.tool === 'string' && act.tool ? { tool: act.tool } : {}),
        ...(normalizeEpochMs(act.started_at) ? { startedAt: normalizeEpochMs(act.started_at) } : {}),
        ...(normalizeEpochMs(act.progress_at) ? { progressAt: normalizeEpochMs(act.progress_at) } : {}),
      };
    });

    const pendingActions = normalizeGroupPendingActions(driver?.pending_actions);
    const counts: Record<string, number> = {};
    if (driver?.counts && typeof driver.counts === 'object' && !Array.isArray(driver.counts)) {
      for (const [k, v] of Object.entries(driver.counts)) {
        if (typeof v === 'number' && Number.isFinite(v)) counts[k] = v;
      }
    }

    scope.groupState = {
      roomId: result.room?.room_id || result.room_id || roomId,
      name: result.room?.name || result.name || roomId,
      routing: result.context?.routing ?? undefined,
      memberCount: roomMembers.length || (Array.isArray(result.members) ? result.members.length : 0),
      running: Boolean(driver?.running),
      working: Boolean(driver?.working),
      blocked: Boolean(driver?.blocked),
      counts,
      pendingActions,
      memberActivity,
      lastError: driver?.last_error ?? null,
      updatedAt: Date.now(),
    };
    scope.groupError = undefined;
    this.notify();
  }

  public applyGroupStateError(roomId: string, errorMessage: string): void {
    if (!roomId) return;
    const scope = this.ensureScope(buildGroupScopeKey(roomId));
    scope.groupError = errorMessage || 'groups.state unavailable';
    this.notify();
  }
}
