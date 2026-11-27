/**
 * 交互式请求核心协调状态机 (InteractiveRequestCoordinator)
 *
 * 【设计意图 (Why)】
 *   统一收口跨传输通道的交互请求生命周期：
 *   - live WS 反向请求（clarify / approval / secret / sudo / display.install.sudo / vault.*）
 *   - 断线重连快照（session.resume / session.activate 的 pending_approval / open_requests / prompts / pending_connection / approval.pending）
 *   - 网关事件（request.cancel / approval.cancelled / connection.request / connection.update）
 *   - 多 Agent 群聊阻塞动作（groups.state driver_status.pending_actions）
 *   - 同步 RPC 门禁二次确认（confirm_expensive_model / groups.discard / reload.mcp）
 *
 * 【防范的历史坑 (Pitfall)】
 *   1. 慢 `session.resume` 竞态抹杀：在途 resume 返回空列表时误删刚通过 WS 抵达的实时审批卡。
 *      通过 `captureSyncFence` + 单调 `arrivalSeq` 彻底隔绝陈旧快照误删（对标 `INV-CACHE-01`）。
 *   2. `live_ws` 先于 `session.create`/`session.resume` 抵达时只有 `liveSessionId` 没有 `storedSessionId`：
 *      通过 `bindSessionHandle(storedId, liveId)` 原地重键并与已按 `storedId` 恢复的条目无损去重合并。
 *   3. `connection.respond` 是多步部分收敛（`settled: false` 时卡片不得提前关闭），且 `connection.update` 可能乱序：
 *      强制 `seq` 单调防回退，`settled: true` 进入终态吸收。
 *   4. 双端抢答 / 在途失败时的状态倒流：`settled` 与 `cancelled` 具有吸收律（Cancel-Dominates-Rollback）。
 *
 * 【约束与规则 (Rules)】
 *   - 零 DOM / 零 React / 零 Timer 依赖，全部时间通过显式参数 `nowMs` 注入；
 *   - 严禁把任何纯密钥/密码值写入持久存储或日志。
 */

import type {
  ConnectionOperationTarget,
  ConnectionRequestPayload,
  ConnectionUpdatePayload,
} from '../rpc/types.js';
import type { NormalizedGroupPendingAction } from '../session/sessionStatusStore.js';
import { normalizeEpochMs } from '../session/eventReducer.js';
import { parseConnectionRequestPayload } from './connectionParser.js';
import type {
  ApprovalPrompt,
  BackgroundWaitingSummary,
  ClarifyPrompt,
  ConnectionPrompt,
  ConnectionPromptOwner,
  CredentialPrompt,
  CredentialPromptMethod,
  GroupActionPrompt,
  InteractivePrompt,
  PromptOrigin,
  PromptScope,
  RpcConfirmPrompt,
  WaitingPromptReason,
} from './types.js';

export interface ActiveFocusDescriptor {
  type: 'session' | 'bot' | 'group';
  botName?: string;
  sessionId?: string;
  roomId?: string;
}

export interface UpsertLiveServerRequestInput {
  rpcId: string | number;
  socketGeneration: number;
  method: string;
  params: Record<string, unknown>;
  storedSessionId?: string | null;
  profile?: string;
  nowMs?: number;
  origin?: PromptOrigin;
  protocol?: 'classic' | 'canonical';
}

export interface ReconcileResumeInput {
  storedSessionId: string;
  liveSessionId: string | null;
  profile?: string;
  resume: Record<string, unknown> | null | undefined;
  fence: number;
  nowMs?: number;
}

const CREDENTIAL_METHODS: ReadonlySet<string> = new Set([
  'secret',
  'sudo',
  'display.install.sudo',
  'vault.code',
  'vault.unlock_prompt',
  'vault.save_login',
]);

function isCredentialMethod(method: string): method is CredentialPromptMethod {
  return CREDENTIAL_METHODS.has(method);
}

function asStr(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asOptionalStr(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asBool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function extractApprovalChoices(rawChoices: unknown, allowSession?: boolean, allowPermanent?: boolean): string[] {
  const choices: string[] = [];
  if (Array.isArray(rawChoices)) {
    for (const item of rawChoices) {
      if (typeof item === 'string' && item.trim()) {
        choices.push(item.trim());
      }
    }
  }
  if (choices.length > 0) return choices;
  choices.push('once');
  if (allowSession) choices.push('session');
  if (allowPermanent) choices.push('always');
  choices.push('deny');
  return choices;
}

function buildSessionOwnerKey(storedSessionId: string | null, liveSessionId: string | null): string {
  return storedSessionId || liveSessionId || 'unknown';
}

function buildSessionPromptKey(ownerKey: string, suffix: string): string {
  return `session:${ownerKey}::${suffix}`;
}

function promptMatchesSession(prompt: InteractivePrompt, storedSessionId: string | null, liveSessionId: string | null): boolean {
  if (prompt.scope.kind !== 'session') return false;
  if (storedSessionId && prompt.scope.storedSessionId === storedSessionId) return true;
  if (liveSessionId && prompt.scope.liveSessionId === liveSessionId) return true;
  if (storedSessionId && prompt.scope.liveSessionId === storedSessionId && !prompt.scope.storedSessionId) return true;
  if (liveSessionId && prompt.scope.storedSessionId === liveSessionId) return true;
  return false;
}

function deriveWaitingReason(prompt: InteractivePrompt): WaitingPromptReason {
  return prompt.waitingReason;
}

function parseQuestionsFromParams(params: Record<string, unknown>, fallbackId: string): ClarifyPrompt['questions'] {
  if (Array.isArray(params.questions)) {
    const out: ClarifyPrompt['questions'] = [];
    for (let i = 0; i < params.questions.length; i += 1) {
      const q = asRecord(params.questions[i]);
      if (!q) continue;
      const qid = asStr(q.qid) || `q_${i}`;
      const question = asStr(q.question);
      const choices = Array.isArray(q.choices)
        ? q.choices.filter((c): c is string => typeof c === 'string')
        : null;
      const multiSelect = Boolean(q.multi_select);
      out.push({
        qid,
        question,
        ...(choices ? { choices } : {}),
        multi_select: multiSelect,
      });
    }
    if (out.length > 0) return out;
  }
  const singleQ = asStr(params.question);
  if (singleQ) {
    return [{
      qid: fallbackId || 'q_0',
      question: singleQ,
      ...(Array.isArray(params.choices)
        ? { choices: params.choices.filter((c): c is string => typeof c === 'string') }
        : {}),
      multi_select: Boolean(params.multi_select),
    }];
  }
  return [];
}

function parseLockedAnswers(raw: unknown): Record<string, string | null> {
  const rec = asRecord(raw);
  if (!rec) return {};
  const out: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(rec)) {
    if (v === null) out[k] = null;
    else if (typeof v === 'string') out[k] = v;
  }
  return out;
}

export class InteractiveRequestCoordinator {
  private readonly prompts = new Map<string, InteractivePrompt>();
  /** key -> 绑定的 server_requests 原始 id（approval 等请求 canonicalKey 用 params.request_id，request.cancel 则用 serverRequestId） */
  private readonly serverRequestIds = new Map<string, string>();
  /** 已终结的 connection op 最高 seq，防陈旧 resume 或乱序通知复活 */
  private readonly settledConnectionSeqs = new Map<string, number>();
  /** 最近已终结/已取消的 canonicalKey 集合，防迟滞回放与重复提交 */
  private readonly terminalKeys = new Map<string, 'settled' | 'cancelled'>();
  private arrivalSeq = 0;

  public captureSyncFence(): number {
    return this.arrivalSeq;
  }

  /**
   * 显式切换或完全断开网关连接时清理内存态：
   * 同步清空 prompts / serverRequestIds / settledConnectionSeqs / terminalKeys，
   * 避免后续重连到新会话或重新激活时被 terminalKeys 误吞。保留 arrivalSeq 单调递增。
   */
  public reset(): void {
    this.prompts.clear();
    this.serverRequestIds.clear();
    this.settledConnectionSeqs.clear();
    this.terminalKeys.clear();
  }

  public getPrompt(canonicalKey: string): InteractivePrompt | undefined {
    return this.prompts.get(canonicalKey);
  }

  public listUnresolvedPrompts(): InteractivePrompt[] {
    const out = Array.from(this.prompts.values());
    out.sort((a, b) => a.arrivalSeq - b.arrivalSeq);
    return out;
  }

  public upsertServerRequest(input: UpsertLiveServerRequestInput): InteractivePrompt | null {
    const nowMs = input.nowMs ?? Date.now();
    const { method, params, rpcId, socketGeneration } = input;
    const rawReqId = String(rpcId);
    const liveSessionId = asOptionalStr(params.session_id) ?? asOptionalStr(params.gateway_session_id) ?? null;
    const storedSessionId = input.storedSessionId ?? null;
    const ownerKey = buildSessionOwnerKey(storedSessionId, liveSessionId);
    const scope: PromptScope =
      method === 'display.install.sudo' && !storedSessionId && !liveSessionId
        ? { kind: 'app', ...(asOptionalStr(params.profile_key) ? { profileKey: asStr(params.profile_key) } : {}) }
        : {
            kind: 'session',
            storedSessionId,
            liveSessionId,
            ...(input.profile ? { profile: input.profile } : {}),
          };

    const protocol = input.protocol ?? 'classic';
    const origin = input.origin ?? 'live_ws';

    if (method === 'clarify') {
      const canonicalKey = buildSessionPromptKey(ownerKey, `clarify::${rawReqId}`);
      const existing = this.prompts.get(canonicalKey);
      const locked = parseLockedAnswers(params.answers);
      const questions = parseQuestionsFromParams(params, rawReqId);
      const prompt: ClarifyPrompt = {
        canonicalKey,
        requestId: rawReqId,
        kind: 'clarify',
        scope,
        waitingReason: 'clarify',
        status: existing && existing.status === 'submitting' ? 'submitting' : 'open',
        arrivalSeq: origin === 'live_ws' ? ++this.arrivalSeq : (existing?.arrivalSeq ?? ++this.arrivalSeq),
        createdAtMs: existing?.createdAtMs ?? nowMs,
        rpcId: origin === 'live_ws' ? rpcId : (existing?.rpcId ?? null),
        socketGeneration: origin === 'live_ws' ? socketGeneration : (existing?.socketGeneration ?? null),
        origin,
        protocol,
        questions,
        lockedAnswers: existing?.kind === 'clarify' ? { ...existing.lockedAnswers, ...locked } : locked,
      };
      this.serverRequestIds.set(canonicalKey, rawReqId);
      return this.commitUpsert(prompt);
    }

    if (method === 'approval') {
      const approvalReqId = asOptionalStr(params.request_id) ?? `singleton:${rawReqId}`;
      const canonicalKey = buildSessionPromptKey(ownerKey, `approval::${approvalReqId}`);
      const existing = this.prompts.get(canonicalKey);
      const allowSession = asBool(params.allow_session);
      const allowPermanent = asBool(params.allow_permanent);
      const prompt: ApprovalPrompt = {
        canonicalKey,
        requestId: approvalReqId,
        kind: 'approval',
        scope,
        waitingReason: 'approval',
        status: existing && existing.status === 'submitting' ? 'submitting' : 'open',
        arrivalSeq: origin === 'live_ws' ? ++this.arrivalSeq : (existing?.arrivalSeq ?? ++this.arrivalSeq),
        createdAtMs: existing?.createdAtMs ?? nowMs,
        rpcId: origin === 'live_ws' ? rpcId : (existing?.rpcId ?? null),
        socketGeneration: origin === 'live_ws' ? socketGeneration : (existing?.socketGeneration ?? null),
        origin,
        protocol,
        command: asOptionalStr(params.command),
        description: asOptionalStr(params.description),
        toolName: asOptionalStr(params.tool_name),
        choices: extractApprovalChoices(params.choices, allowSession, allowPermanent),
        ...(allowPermanent !== undefined ? { allowPermanent } : {}),
        ...(allowSession !== undefined ? { allowSession } : {}),
        ...(asBool(params.smart_denied) !== undefined ? { smartDenied: asBool(params.smart_denied) } : {}),
        ...(params.edit !== undefined ? { edit: asRecord(params.edit) } : {}),
      };
      this.serverRequestIds.set(canonicalKey, rawReqId);
      return this.commitUpsert(prompt);
    }

    if (isCredentialMethod(method)) {
      const canonicalKey =
        scope.kind === 'app'
          ? `app::cred::${method}::${rawReqId}`
          : buildSessionPromptKey(ownerKey, `cred::${method}::${rawReqId}`);
      const existing = this.prompts.get(canonicalKey);
      const prompt: CredentialPrompt = {
        canonicalKey,
        requestId: rawReqId,
        kind: 'credential',
        method,
        scope,
        waitingReason: 'credential',
        status: existing && existing.status === 'submitting' ? 'submitting' : 'open',
        arrivalSeq: origin === 'live_ws' ? ++this.arrivalSeq : (existing?.arrivalSeq ?? ++this.arrivalSeq),
        createdAtMs: existing?.createdAtMs ?? nowMs,
        rpcId: origin === 'live_ws' ? rpcId : (existing?.rpcId ?? null),
        socketGeneration: origin === 'live_ws' ? socketGeneration : (existing?.socketGeneration ?? null),
        origin,
        protocol,
        ...(asOptionalStr(params.env_var) ? { envVar: asStr(params.env_var) } : {}),
        ...(asOptionalStr(params.prompt) ? { promptText: asStr(params.prompt) } : {}),
        ...(asOptionalStr(params.command) ? { command: asStr(params.command) } : {}),
        ...(asOptionalStr(params.profile_key) ? { profileKey: asStr(params.profile_key) } : {}),
        ...(asOptionalStr(params.site) ? { site: asStr(params.site) } : {}),
        ...(asOptionalStr(params.hint) ? { hint: asStr(params.hint) } : {}),
        ...(asOptionalStr(params.origin) ? { originUrl: asStr(params.origin) } : {}),
        ...(asOptionalStr(params.backend) ? { backend: asStr(params.backend) } : {}),
        ...(asOptionalStr(params.display_name) ? { displayName: asStr(params.display_name) } : {}),
        ...(asRecord(params.metadata) ? { metadata: asRecord(params.metadata) } : {}),
      };
      this.serverRequestIds.set(canonicalKey, rawReqId);
      return this.commitUpsert(prompt);
    }

    return null;
  }

  private commitUpsert(incoming: InteractivePrompt): InteractivePrompt {
    const existing = this.prompts.get(incoming.canonicalKey);
    if (!existing) {
      // 终态已吸收的 key 仅允许 live_ws 新连接真正重新下发时重建（例如同 numeric id 新会话复用）
      const terminal = this.terminalKeys.get(incoming.canonicalKey);
      if (terminal && incoming.origin !== 'live_ws') {
        return { ...incoming, status: terminal };
      }
      this.terminalKeys.delete(incoming.canonicalKey);
      this.prompts.set(incoming.canonicalKey, incoming);
      return incoming;
    }

    const merged: InteractivePrompt = {
      ...existing,
      ...incoming,
      status: existing.status === 'submitting' ? 'submitting' : 'open',
      arrivalSeq:
        existing.rpcId !== null || incoming.rpcId !== null
          ? Math.max(existing.arrivalSeq, incoming.arrivalSeq)
          : existing.arrivalSeq,
      createdAtMs: existing.createdAtMs,
      rpcId: incoming.rpcId ?? existing.rpcId,
      socketGeneration: incoming.rpcId !== null ? incoming.socketGeneration : existing.socketGeneration,
      origin: existing.origin === 'live_ws' ? 'live_ws' : incoming.origin,
    } as InteractivePrompt;
    this.prompts.set(incoming.canonicalKey, merged);
    return merged;
  }

  /**
   * 当 session.create / session.resume 返回 (storedSessionId, liveSessionId) 时，
   * 将此前仅靠 liveSessionId 暂存的交互请求原位重键到 storedSessionId 并与恢复快照去重合并。
   */
  public bindSessionHandle(storedSessionId: string, liveSessionId: string): void {
    if (!storedSessionId || !liveSessionId) return;
    const entries = Array.from(this.prompts.entries());
    for (const [oldKey, prompt] of entries) {
      if (prompt.scope.kind !== 'session') continue;
      const matches =
        prompt.scope.liveSessionId === liveSessionId ||
        prompt.scope.storedSessionId === storedSessionId ||
        (prompt.scope.storedSessionId === null && prompt.scope.liveSessionId === liveSessionId);
      if (!matches) continue;

      const updatedScope: PromptScope = {
        ...prompt.scope,
        storedSessionId,
        liveSessionId,
      };
      // connection / rpc_confirm 主键跨端全局唯一（connection::opId / rpc-confirm::...），绑定句柄时只能原位回填 scope，严禁改写 canonicalKey
      const keepStableKey = prompt.kind === 'connection' || prompt.kind === 'rpc_confirm';
      const suffix = oldKey.slice(oldKey.indexOf('::') + 2);
      const newKey = keepStableKey ? oldKey : buildSessionPromptKey(storedSessionId, suffix);

      if (newKey === oldKey) {
        this.prompts.set(oldKey, { ...prompt, scope: updatedScope });
        continue;
      }

      const srvId = this.serverRequestIds.get(oldKey);
      this.prompts.delete(oldKey);
      this.serverRequestIds.delete(oldKey);
      if (srvId) this.serverRequestIds.set(newKey, srvId);

      const rebound = { ...prompt, canonicalKey: newKey, scope: updatedScope } as InteractivePrompt;
      const targetExisting = this.prompts.get(newKey);
      if (!targetExisting) {
        this.prompts.set(newKey, rebound);
      } else {
        const merged: InteractivePrompt = {
          ...targetExisting,
          ...rebound,
          scope: updatedScope,
          canonicalKey: newKey,
          status: targetExisting.status === 'submitting' || rebound.status === 'submitting' ? 'submitting' : 'open',
          rpcId: rebound.rpcId ?? targetExisting.rpcId,
          socketGeneration: rebound.rpcId !== null ? rebound.socketGeneration : targetExisting.socketGeneration,
          arrivalSeq: Math.max(rebound.arrivalSeq, targetExisting.arrivalSeq),
          createdAtMs: Math.min(rebound.createdAtMs, targetExisting.createdAtMs),
        } as InteractivePrompt;
        this.prompts.set(newKey, merged);
      }
    }
  }

  /**
   * 底层 WebSocket 断开/切换时，立即解绑所有过期 `rpcId` 与 `socketGeneration`，
   * 保留卡片在内存中待重连后走 RPC（request.answer / approval.respond / clarify.respond）或对账收敛。
   */
  public onSocketClosed(
    closedGeneration?: number,
    filter?: (prompt: InteractivePrompt) => boolean,
  ): void {
    for (const [key, prompt] of this.prompts.entries()) {
      if (prompt.rpcId === null) continue;
      if (closedGeneration !== undefined && prompt.socketGeneration !== closedGeneration) continue;
      if (filter && !filter(prompt)) continue;
      this.prompts.set(key, {
        ...prompt,
        rpcId: null,
        socketGeneration: null,
      });
    }
  }

  /**
   * 使用 `session.resume` / `session.activate` 快照做围栏式对账（INV-INTERACT-01）。
   */
  public reconcileFromResume(input: ReconcileResumeInput): void {
    const { storedSessionId, liveSessionId, profile, resume, fence } = input;
    const nowMs = input.nowMs ?? Date.now();
    if (!storedSessionId || !resume || typeof resume !== 'object') return;

    if (liveSessionId) {
      this.bindSessionHandle(storedSessionId, liveSessionId);
    }

    const info = asRecord(resume.info);
    const protocol: 'classic' | 'canonical' =
      info?.desktop_protocol === 'hermes-gateway-v1' ? 'canonical' : 'classic';
    const ownerKey = buildSessionOwnerKey(storedSessionId, liveSessionId);
    const presentKeys = new Set<string>();

    // 1. Canonical `prompts[]` (hermes-gateway-v1)
    if (Array.isArray(resume.prompts)) {
      for (const item of resume.prompts) {
        const rec = asRecord(item);
        if (!rec) continue;
        const promptId = asStr(rec.prompt_id);
        const kind = asStr(rec.kind);
        if (!promptId || (kind !== 'approval' && kind !== 'clarify')) continue;
        const execGen =
          typeof rec.execution_generation === 'number' && Number.isFinite(rec.execution_generation)
            ? rec.execution_generation
            : 0;
        const scope: PromptScope = {
          kind: 'session',
          storedSessionId,
          liveSessionId,
          ...(profile ? { profile } : {}),
        };
        if (kind === 'clarify') {
          const canonicalKey = buildSessionPromptKey(ownerKey, `clarify::${promptId}`);
          presentKeys.add(canonicalKey);
          const choices = Array.isArray(rec.choices)
            ? rec.choices.filter((c): c is string => typeof c === 'string')
            : null;
          this.commitUpsert({
            canonicalKey,
            requestId: promptId,
            kind: 'clarify',
            scope,
            waitingReason: 'clarify',
            status: 'open',
            arrivalSeq: ++this.arrivalSeq,
            createdAtMs: nowMs,
            rpcId: null,
            socketGeneration: null,
            origin: 'canonical_prompt',
            protocol: 'canonical',
            executionGeneration: execGen,
            promptId,
            questions: [
              {
                qid: promptId,
                question: asStr(rec.question),
                ...(choices ? { choices } : {}),
                multi_select: Boolean(rec.multi_select),
              },
            ],
            lockedAnswers: {},
          });
        } else {
          const canonicalKey = buildSessionPromptKey(ownerKey, `approval::${promptId}`);
          presentKeys.add(canonicalKey);
          this.commitUpsert({
            canonicalKey,
            requestId: promptId,
            kind: 'approval',
            scope,
            waitingReason: 'approval',
            status: 'open',
            arrivalSeq: ++this.arrivalSeq,
            createdAtMs: nowMs,
            rpcId: null,
            socketGeneration: null,
            origin: 'canonical_prompt',
            protocol: 'canonical',
            executionGeneration: execGen,
            promptId,
            command: asOptionalStr(rec.command),
            description: asOptionalStr(rec.description),
            choices: extractApprovalChoices(rec.choices),
            ...(rec.edit !== undefined ? { edit: asRecord(rec.edit) } : {}),
          });
        }
      }
    }

    // 2. Classic `pending_approval`
    const pendingApproval = asRecord(resume.pending_approval);
    if (pendingApproval) {
      const reqId = asOptionalStr(pendingApproval.request_id) ?? 'singleton:pending';
      const canonicalKey = buildSessionPromptKey(ownerKey, `approval::${reqId}`);
      presentKeys.add(canonicalKey);
      const allowSession = asBool(pendingApproval.allow_session);
      const allowPermanent = asBool(pendingApproval.allow_permanent);
      this.commitUpsert({
        canonicalKey,
        requestId: reqId,
        kind: 'approval',
        scope: {
          kind: 'session',
          storedSessionId,
          liveSessionId,
          ...(profile ? { profile } : {}),
        },
        waitingReason: 'approval',
        status: 'open',
        arrivalSeq: ++this.arrivalSeq,
        createdAtMs: nowMs,
        rpcId: null,
        socketGeneration: null,
        origin: 'pending_approval',
        protocol,
        command: asOptionalStr(pendingApproval.command),
        description: asOptionalStr(pendingApproval.description),
        toolName: asOptionalStr(pendingApproval.tool_name),
        choices: extractApprovalChoices(pendingApproval.choices, allowSession, allowPermanent),
        ...(allowPermanent !== undefined ? { allowPermanent } : {}),
        ...(allowSession !== undefined ? { allowSession } : {}),
        ...(asBool(pendingApproval.smart_denied) !== undefined
          ? { smartDenied: asBool(pendingApproval.smart_denied) }
          : {}),
        ...(pendingApproval.edit !== undefined ? { edit: asRecord(pendingApproval.edit) } : {}),
      });
    }

    // 3. `open_requests[]`
    if (Array.isArray(resume.open_requests)) {
      for (const rawEntry of resume.open_requests) {
        const entry = asRecord(rawEntry);
        if (!entry) continue;
        const entryId = asStr(entry.id);
        const method = asStr(entry.method);
        const params = asRecord(entry.params) ?? {};
        if (!entryId || !method) continue;
        const upserted = this.upsertServerRequest({
          rpcId: entryId,
          socketGeneration: -1,
          method,
          params,
          storedSessionId: method === 'display.install.sudo' && !params.session_id ? null : storedSessionId,
          profile,
          nowMs,
          origin: 'open_requests',
          protocol,
        });
        if (upserted) {
          presentKeys.add(upserted.canonicalKey);
        }
      }
    }

    // 4. `pending_connection`
    const parsedConn = parseConnectionRequestPayload(resume.pending_connection);
    if (parsedConn) {
      const conn = this.applyConnectionRequest(
        liveSessionId || storedSessionId,
        parsedConn,
        nowMs,
        profile,
        storedSessionId,
      );
      if (conn) {
        presentKeys.add(conn.canonicalKey);
      }
    }

    // 5. 围栏修剪：仅淘汰 snapshot 中明确缺失且 arrivalSeq <= fence 的陈旧 session 级条目
    for (const [key, prompt] of Array.from(this.prompts.entries())) {
      if (!promptMatchesSession(prompt, storedSessionId, liveSessionId)) continue;
      if (prompt.kind === 'rpc_confirm') continue;
      if (prompt.origin === 'approval_pending' && presentKeys.size === 0 && Boolean(resume.running)) {
        // approval.pending 后续探针可补充多条审批，保留当前在池审批不被本次 fence 提前清掉
        continue;
      }
      if (!presentKeys.has(key) && prompt.arrivalSeq <= fence && prompt.status === 'open') {
        this.prompts.delete(key);
        this.serverRequestIds.delete(key);
      }
    }
  }

  public reconcileApprovalPending(
    storedSessionId: string,
    liveSessionId: string | null,
    profile: string | undefined,
    approvals: readonly Record<string, unknown>[],
    _fence: number,
    nowMs = Date.now(),
  ): void {
    const ownerKey = buildSessionOwnerKey(storedSessionId, liveSessionId);
    for (let i = 0; i < approvals.length; i += 1) {
      const item = approvals[i];
      if (!item || typeof item !== 'object') continue;
      const reqId = asOptionalStr(item.request_id) ?? `singleton:pending-${i}`;
      const canonicalKey = buildSessionPromptKey(ownerKey, `approval::${reqId}`);
      const allowSession = asBool(item.allow_session);
      const allowPermanent = asBool(item.allow_permanent);
      this.commitUpsert({
        canonicalKey,
        requestId: reqId,
        kind: 'approval',
        scope: {
          kind: 'session',
          storedSessionId,
          liveSessionId,
          ...(profile ? { profile } : {}),
        },
        waitingReason: 'approval',
        status: 'open',
        arrivalSeq: ++this.arrivalSeq,
        createdAtMs: nowMs,
        rpcId: null,
        socketGeneration: null,
        origin: 'approval_pending',
        protocol: 'classic',
        command: asOptionalStr(item.command),
        description: asOptionalStr(item.description),
        toolName: asOptionalStr(item.tool_name),
        choices: extractApprovalChoices(item.choices, allowSession, allowPermanent),
        ...(allowPermanent !== undefined ? { allowPermanent } : {}),
        ...(allowSession !== undefined ? { allowSession } : {}),
        ...(asBool(item.smart_denied) !== undefined ? { smartDenied: asBool(item.smart_denied) } : {}),
        ...(item.edit !== undefined ? { edit: asRecord(item.edit) } : {}),
      });
    }
  }

  public applyConnectionRequest(
    frameSessionId: string | undefined,
    payload: ConnectionRequestPayload,
    nowMs = Date.now(),
    profile?: string,
    storedSessionId?: string | null,
  ): ConnectionPrompt | null {
    const opId = asStr(payload?.op_id);
    if (!opId) return null;
    const seq = typeof payload.seq === 'number' && Number.isFinite(payload.seq) ? payload.seq : 0;
    const settledSeq = this.settledConnectionSeqs.get(opId);
    if (settledSeq !== undefined && seq <= settledSeq) return null;

    const canonicalKey = `connection::${opId}`;
    const existing = this.prompts.get(canonicalKey);
    if (existing?.kind === 'connection' && seq < existing.seq) {
      return existing;
    }

    const owner: ConnectionPromptOwner = frameSessionId
      ? { type: 'session', session_id: frameSessionId }
      : { type: 'account' };
    const scope: PromptScope =
      owner.type === 'session'
        ? {
            kind: 'session',
            storedSessionId: storedSessionId ?? null,
            liveSessionId: owner.session_id,
            ...(profile ? { profile } : {}),
          }
        : { kind: 'account', ...(profile ? { profile } : {}) };

    const prompt: ConnectionPrompt = {
      canonicalKey,
      requestId: opId,
      kind: 'connection',
      scope,
      waitingReason: 'connection',
      status: existing && existing.status === 'submitting' ? 'submitting' : 'open',
      arrivalSeq: ++this.arrivalSeq,
      createdAtMs: existing?.createdAtMs ?? nowMs,
      rpcId: null,
      socketGeneration: null,
      origin: 'connection_event',
      protocol: 'classic',
      opId,
      seq,
      deadlineAtMs: normalizeEpochMs(payload.deadline_at) ?? nowMs + (payload.timeout_seconds ?? 300) * 1000,
      timeoutSeconds: payload.timeout_seconds ?? 300,
      owner,
      targets: Array.isArray(payload.targets) ? payload.targets.slice() : [],
      ...(payload.tool_call_id !== undefined ? { toolCallId: payload.tool_call_id } : {}),
      ...(payload.display?.suggested ? { suggestedDisplay: payload.display.suggested.slice() } : {}),
    };
    return this.commitUpsert(prompt) as ConnectionPrompt;
  }

  public applyConnectionUpdate(
    payload: ConnectionUpdatePayload,
    nowMs = Date.now(),
    profile?: string,
    storedSessionId?: string | null,
  ): void {
    const opId = asStr(payload?.op_id);
    if (!opId) return;
    const seq = typeof payload.seq === 'number' && Number.isFinite(payload.seq) ? payload.seq : 0;
    const settledSeq = this.settledConnectionSeqs.get(opId);
    if (settledSeq !== undefined && seq <= settledSeq) return;

    const canonicalKey = `connection::${opId}`;
    const existing = this.prompts.get(canonicalKey);
    if (existing?.kind === 'connection' && seq < existing.seq) {
      return;
    }

    if (payload.settled) {
      this.settledConnectionSeqs.set(opId, seq);
      this.confirmSettled(canonicalKey);
      return;
    }

    const owner: ConnectionPromptOwner =
      payload.owner?.type === 'session'
        ? { type: 'session', session_id: payload.owner.session_id }
        : { type: 'account' };
    const scope: PromptScope =
      owner.type === 'session'
        ? {
            kind: 'session',
            storedSessionId:
              existing?.scope.kind === 'session' ? (existing.scope.storedSessionId ?? storedSessionId ?? null) : (storedSessionId ?? null),
            liveSessionId: owner.session_id,
            ...(profile ? { profile } : {}),
          }
        : { kind: 'account', ...(profile ? { profile } : {}) };

    const updated: ConnectionPrompt = {
      canonicalKey,
      requestId: opId,
      kind: 'connection',
      scope,
      waitingReason: 'connection',
      status: existing && existing.status === 'submitting' ? 'submitting' : 'open',
      arrivalSeq: existing?.arrivalSeq ?? ++this.arrivalSeq,
      createdAtMs: existing?.createdAtMs ?? nowMs,
      rpcId: null,
      socketGeneration: null,
      origin: 'connection_event',
      protocol: 'classic',
      opId,
      seq,
      deadlineAtMs: normalizeEpochMs(payload.deadline_at) ?? (existing?.kind === 'connection' ? existing.deadlineAtMs : nowMs),
      timeoutSeconds: existing?.kind === 'connection' ? existing.timeoutSeconds : 300,
      owner,
      targets: Array.isArray(payload.targets) ? payload.targets.slice() : [],
      ...(existing?.kind === 'connection' && existing.toolCallId !== undefined ? { toolCallId: existing.toolCallId } : {}),
      ...(existing?.kind === 'connection' && existing.suggestedDisplay ? { suggestedDisplay: existing.suggestedDisplay } : {}),
    };
    this.commitUpsert(updated);
  }

  public applyConnectionRespondResult(
    opId: string,
    settled: boolean,
    updatedTargets?: ConnectionOperationTarget[],
  ): void {
    const canonicalKey = `connection::${opId}`;
    if (settled) {
      const existing = this.prompts.get(canonicalKey);
      const seq = existing?.kind === 'connection' ? existing.seq : 0;
      this.settledConnectionSeqs.set(opId, seq);
      this.confirmSettled(canonicalKey);
      return;
    }
    const existing = this.prompts.get(canonicalKey);
    if (!existing || existing.kind !== 'connection') return;
    this.prompts.set(canonicalKey, {
      ...existing,
      status: 'open',
      errorMessage: null,
      ...(updatedTargets ? { targets: updatedTargets } : {}),
    });
  }

  public applyClarifyLockResult(
    canonicalKey: string,
    questionId: string,
    answer: string | null,
    remaining?: readonly string[] | null,
  ): void {
    const existing = this.prompts.get(canonicalKey);
    if (!existing || existing.kind !== 'clarify') return;
    const nextLocked = { ...existing.lockedAnswers, [questionId]: answer };
    this.prompts.set(canonicalKey, {
      ...existing,
      lockedAnswers: nextLocked,
    });
    if (Array.isArray(remaining) && remaining.length === 0) {
      this.confirmSettled(canonicalKey);
    }
  }

  /**
   * 群聊房间 `groups.state pending_actions` 正交同步（INV-INTERACT-06）：
   * 仅读写 `group::<roomId>::*`，绝不污染或越权改写任何单聊会话。
   */
  public reconcileGroupPendingActions(
    roomId: string,
    profile: string | undefined,
    actions: readonly NormalizedGroupPendingAction[],
    protocol: 'classic' | 'canonical' = 'classic',
    nowMs = Date.now(),
  ): void {
    if (!roomId) return;
    const presentKeys = new Set<string>();
    const scope: PromptScope = { kind: 'group', roomId, ...(profile ? { profile } : {}) };

    for (const act of actions) {
      const key =
        act.kind === 'approval'
          ? `group::${roomId}::approval::${act.requestId}`
          : `group::${roomId}::${act.kind}::${act.taskId}`;
      presentKeys.add(key);
      const existing = this.prompts.get(key);
      const next: GroupActionPrompt = {
        canonicalKey: key,
        requestId: act.kind === 'approval' ? act.requestId : act.taskId,
        kind: 'group_action',
        scope,
        waitingReason: act.kind === 'approval' ? 'approval' : 'confirm',
        status: existing && existing.status === 'submitting' ? 'submitting' : 'open',
        arrivalSeq: existing?.arrivalSeq ?? ++this.arrivalSeq,
        createdAtMs: existing?.createdAtMs ?? nowMs,
        rpcId: null,
        socketGeneration: null,
        origin: 'group_state',
        protocol,
        roomId,
        actionKind: act.kind,
        memberId: act.memberId,
        taskId: act.taskId,
        executionGeneration: act.executionGeneration,
        ...(act.kind === 'approval'
          ? {
              command: act.command,
              description: act.description,
              toolName: act.toolName,
              choices:
                protocol === 'canonical'
                  ? act.choices.filter((c) => c === 'once' || c === 'deny')
                  : act.choices.slice(),
            }
          : {
              choices: [],
              errorDetail: act.errorDetail,
            }),
      };
      if (next.choices.length === 0 && next.actionKind === 'approval') {
        next.choices = ['once', 'deny'];
      }
      this.commitUpsert(next);
    }

    for (const [key, prompt] of Array.from(this.prompts.entries())) {
      if (prompt.scope.kind === 'group' && prompt.scope.roomId === roomId && !presentKeys.has(key)) {
        if (prompt.status === 'open') {
          this.prompts.delete(key);
        }
      }
    }
  }

  public addRpcConfirmPrompt(prompt: Omit<RpcConfirmPrompt, 'arrivalSeq' | 'status'>): RpcConfirmPrompt {
    const full: RpcConfirmPrompt = {
      ...prompt,
      status: 'open',
      arrivalSeq: ++this.arrivalSeq,
    };
    this.terminalKeys.delete(full.canonicalKey);
    this.prompts.set(full.canonicalKey, full);
    return full;
  }

  public beginSubmit(canonicalKey: string): boolean {
    const prompt = this.prompts.get(canonicalKey);
    if (!prompt || prompt.status !== 'open') return false;
    this.prompts.set(canonicalKey, {
      ...prompt,
      status: 'submitting',
      errorMessage: null,
    });
    return true;
  }

  public confirmSettled(canonicalKey: string): void {
    const prompt = this.prompts.get(canonicalKey);
    this.terminalKeys.set(canonicalKey, 'settled');
    this.serverRequestIds.delete(canonicalKey);
    if (!prompt) return;
    this.prompts.delete(canonicalKey);
  }

  /**
   * 仅当仍处于 `submitting` 时允许回滚为 `open`（Cancel-Dominates-Rollback，INV-INTERACT-02）。
   */
  public rollbackSubmit(canonicalKey: string, errorMessage: string): boolean {
    const prompt = this.prompts.get(canonicalKey);
    if (!prompt || prompt.status !== 'submitting') return false;
    this.prompts.set(canonicalKey, {
      ...prompt,
      status: 'open',
      errorMessage,
    });
    return true;
  }

  public cancelByRequestId(id: string, reason?: string): number {
    if (!id) return 0;
    const targetId = String(id);
    let count = 0;
    for (const [key, prompt] of Array.from(this.prompts.entries())) {
      const boundServerId = this.serverRequestIds.get(key);
      const matches =
        prompt.requestId === targetId ||
        String(prompt.rpcId) === targetId ||
        boundServerId === targetId;
      if (!matches) continue;
      this.terminalKeys.set(key, 'cancelled');
      this.serverRequestIds.delete(key);
      this.prompts.set(key, {
        ...prompt,
        status: 'cancelled',
        ...(reason ? { errorMessage: reason } : {}),
      });
      this.prompts.delete(key);
      count += 1;
    }
    return count;
  }

  public cancelApprovalsForSession(payload: {
    session_id?: string;
    stored_session_id?: string;
    request_ids?: string[];
    cancelled_count?: number;
    reason?: string;
  }): number {
    const liveId = payload.session_id || null;
    const storedId = payload.stored_session_id || null;
    const reqSet = new Set((payload.request_ids ?? []).map((id) => String(id)).filter(Boolean));
    const cancelledCount = payload.cancelled_count ?? reqSet.size;
    let cancelled = 0;

    for (const [key, prompt] of Array.from(this.prompts.entries())) {
      if (prompt.kind !== 'approval') continue;
      if (!promptMatchesSession(prompt, storedId, liveId)) continue;
      const boundServerId = this.serverRequestIds.get(key);
      const explicitMatch =
        reqSet.has(prompt.requestId) || (boundServerId ? reqSet.has(boundServerId) : false);
      const implicitMissingIdMatch =
        cancelledCount > 0 &&
        (reqSet.size === 0 || (reqSet.size < cancelledCount && prompt.requestId.startsWith('singleton:')));

      if (explicitMatch || implicitMissingIdMatch) {
        this.terminalKeys.set(key, 'cancelled');
        this.serverRequestIds.delete(key);
        this.prompts.set(key, {
          ...prompt,
          status: 'cancelled',
          ...(payload.reason ? { errorMessage: payload.reason } : {}),
        });
        this.prompts.delete(key);
        cancelled += 1;
      }
    }
    return cancelled;
  }

  /** 清空指定会话所有尚未完结的交互请求，并返回被清除的 canonicalKey 列表（用于 delete / interrupt 收尾） */
  public clearForSession(storedSessionId: string, liveSessionId?: string | null): string[] {
    const removedKeys: string[] = [];
    for (const [key, prompt] of Array.from(this.prompts.entries())) {
      if (promptMatchesSession(prompt, storedSessionId, liveSessionId ?? null)) {
        this.terminalKeys.set(key, 'cancelled');
        this.serverRequestIds.delete(key);
        this.prompts.delete(key);
        removedKeys.push(key);
      }
    }
    return removedKeys;
  }

  public getActivePromptsForFocus(
    focus: ActiveFocusDescriptor,
    activeSessionId: string,
    activeLiveSessionId: string,
  ): InteractivePrompt[] {
    const out: InteractivePrompt[] = [];
    for (const prompt of this.prompts.values()) {
      if (prompt.scope.kind === 'app' || prompt.scope.kind === 'account') {
        out.push(prompt);
        continue;
      }
      if (focus.type === 'group') {
        if (prompt.scope.kind === 'group' && prompt.scope.roomId === focus.roomId) {
          out.push(prompt);
        }
        continue;
      }
      if (promptMatchesSession(prompt, activeSessionId || null, activeLiveSessionId || null)) {
        out.push(prompt);
      }
    }
    out.sort((a, b) => a.arrivalSeq - b.arrivalSeq);
    return out;
  }

  public getBackgroundWaitingPrompts(
    focus: ActiveFocusDescriptor,
    activeSessionId: string,
    activeLiveSessionId: string,
    botForeverSessionIds?: ReadonlyMap<string, string>,
  ): BackgroundWaitingSummary[] {
    const grouped = new Map<string, BackgroundWaitingSummary>();

    for (const prompt of this.prompts.values()) {
      if (prompt.scope.kind === 'app' || prompt.scope.kind === 'account') continue;

      if (prompt.scope.kind === 'group') {
        if (focus.type === 'group' && focus.roomId === prompt.scope.roomId) continue;
        const scopeKey = `group:${prompt.scope.roomId}`;
        const cur = grouped.get(scopeKey);
        if (!cur) {
          grouped.set(scopeKey, {
            scopeKey,
            scope: prompt.scope,
            entityType: 'group',
            entityId: prompt.scope.roomId,
            waitingReason: deriveWaitingReason(prompt),
            promptCount: 1,
            oldestCreatedAtMs: prompt.createdAtMs,
          });
        } else {
          cur.promptCount += 1;
          cur.oldestCreatedAtMs = Math.min(cur.oldestCreatedAtMs, prompt.createdAtMs);
        }
        continue;
      }

      if (focus.type !== 'group' && promptMatchesSession(prompt, activeSessionId || null, activeLiveSessionId || null)) {
        continue;
      }

      const sid = prompt.scope.storedSessionId || prompt.scope.liveSessionId || '';
      if (!sid) continue;
      const botName = botForeverSessionIds?.get(sid);
      const entityType: 'bot' | 'session' = botName ? 'bot' : 'session';
      const entityId = botName ?? sid;
      const scopeKey = `${entityType}:${entityId}`;
      const cur = grouped.get(scopeKey);
      if (!cur) {
        grouped.set(scopeKey, {
          scopeKey,
          scope: prompt.scope,
          entityType,
          entityId,
          waitingReason: deriveWaitingReason(prompt),
          promptCount: 1,
          oldestCreatedAtMs: prompt.createdAtMs,
        });
      } else {
        cur.promptCount += 1;
        cur.oldestCreatedAtMs = Math.min(cur.oldestCreatedAtMs, prompt.createdAtMs);
      }
    }

    return Array.from(grouped.values()).sort((a, b) => a.oldestCreatedAtMs - b.oldestCreatedAtMs);
  }

  public hasPendingPromptForSession(storedSessionId: string, liveSessionId?: string | null): boolean {
    if (!storedSessionId && !liveSessionId) return false;
    for (const prompt of this.prompts.values()) {
      if (promptMatchesSession(prompt, storedSessionId || null, liveSessionId ?? null)) {
        return true;
      }
    }
    return false;
  }

  public getWaitingReasonForSession(
    storedSessionId: string,
    liveSessionId?: string | null,
  ): WaitingPromptReason | null {
    let earliest: InteractivePrompt | null = null;
    for (const prompt of this.prompts.values()) {
      if (!promptMatchesSession(prompt, storedSessionId || null, liveSessionId ?? null)) continue;
      if (!earliest || prompt.arrivalSeq < earliest.arrivalSeq) earliest = prompt;
    }
    return earliest ? earliest.waitingReason : null;
  }

  public getWaitingReasonForGroup(roomId: string): WaitingPromptReason | null {
    let earliest: InteractivePrompt | null = null;
    for (const prompt of this.prompts.values()) {
      if (prompt.scope.kind !== 'group' || prompt.scope.roomId !== roomId) continue;
      if (!earliest || prompt.arrivalSeq < earliest.arrivalSeq) earliest = prompt;
    }
    return earliest ? earliest.waitingReason : null;
  }

  public getWaitingReasonForFocus(
    focus: ActiveFocusDescriptor,
    activeSessionId: string,
    activeLiveSessionId: string,
  ): WaitingPromptReason | null {
    const active = this.getActivePromptsForFocus(focus, activeSessionId, activeLiveSessionId);
    return active.length > 0 ? active[0].waitingReason : null;
  }

  public getWaitingEntityMaps(): {
    sessionWaitingReasons: Map<string, WaitingPromptReason>;
    groupWaitingReasons: Map<string, WaitingPromptReason>;
  } {
    const sessionWaitingReasons = new Map<string, WaitingPromptReason>();
    const groupWaitingReasons = new Map<string, WaitingPromptReason>();
    for (const prompt of this.listUnresolvedPrompts()) {
      if (prompt.scope.kind === 'session') {
        const sid = prompt.scope.storedSessionId || prompt.scope.liveSessionId;
        if (sid && !sessionWaitingReasons.has(sid)) {
          sessionWaitingReasons.set(sid, prompt.waitingReason);
        }
      } else if (prompt.scope.kind === 'group') {
        if (!groupWaitingReasons.has(prompt.scope.roomId)) {
          groupWaitingReasons.set(prompt.scope.roomId, prompt.waitingReason);
        }
      }
    }
    return { sessionWaitingReasons, groupWaitingReasons };
  }
}
