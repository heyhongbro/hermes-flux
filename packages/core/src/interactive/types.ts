/**
 * 统一交互式请求领域模型 (packages/core/src/interactive/types.ts)
 *
 * 【设计意图 (Why)】
 *   Hermes Gateway 的人机交互入口分散在 WS 反向请求（clarify / approval / secret / sudo /
 *   vault.* / display.install.sudo）、事件流（connection.request / connection.update）、
 *   群聊驱动状态（groups.state pending_actions）以及同步 RPC 二次确认（confirm_expensive_model / reload.mcp）。
 *   统一收敛为强类型判别联合 `InteractivePrompt`，供 Core 协调器与跨端停靠卡单一真值消费。
 *
 * 【约束与规则 (Rules)】
 *   - 纯 TypeScript 无界模型，零 DOM / React / Node 依赖；
 *   - `scope` 强制区分 session / group / account / app 四域，保障三态物理正交隔离。
 */

import type {
  ApprovalChoice,
  ClarifyQuestion,
  ConnectionOperationTarget,
} from '../rpc/types.js';
import type { WaitingPromptReason } from '../session/activityState.js';

export type { WaitingPromptReason } from '../session/activityState.js';

export type CredentialPromptMethod =
  | 'secret'
  | 'sudo'
  | 'display.install.sudo'
  | 'vault.code'
  | 'vault.unlock_prompt'
  | 'vault.save_login';

export type PromptScope =
  | { kind: 'session'; storedSessionId: string | null; liveSessionId: string | null; profile?: string }
  | { kind: 'group'; roomId: string; profile?: string }
  | { kind: 'account'; profile?: string }
  | { kind: 'app'; profileKey?: string };

export type PromptOrigin =
  | 'live_ws'
  | 'open_requests'
  | 'pending_approval'
  | 'canonical_prompt'
  | 'approval_pending'
  | 'connection_event'
  | 'group_state'
  | 'rpc_confirm';

export type InteractivePromptStatus = 'open' | 'submitting' | 'settled' | 'cancelled';

export interface InteractivePromptBase {
  canonicalKey: string;
  requestId: string;
  scope: PromptScope;
  waitingReason: WaitingPromptReason;
  status: InteractivePromptStatus;
  arrivalSeq: number;
  createdAtMs: number;
  rpcId: string | number | null;
  socketGeneration: number | null;
  origin: PromptOrigin;
  protocol: 'classic' | 'canonical';
  executionGeneration?: number;
  errorMessage?: string | null;
}

export interface ClarifyPrompt extends InteractivePromptBase {
  kind: 'clarify';
  questions: ClarifyQuestion[];
  lockedAnswers: Record<string, string | null>;
  promptId?: string;
}

export interface ApprovalPrompt extends InteractivePromptBase {
  kind: 'approval';
  command?: string;
  description?: string;
  toolName?: string;
  choices: string[];
  allowPermanent?: boolean;
  allowSession?: boolean;
  smartDenied?: boolean;
  edit?: Record<string, unknown> | null;
  promptId?: string;
}

export interface CredentialPrompt extends InteractivePromptBase {
  kind: 'credential';
  method: CredentialPromptMethod;
  envVar?: string;
  promptText?: string;
  command?: string;
  profileKey?: string;
  site?: string;
  hint?: string;
  originUrl?: string;
  backend?: string;
  displayName?: string;
  metadata?: Record<string, unknown> | null;
}

export type ConnectionPromptOwner =
  | { type: 'session'; session_id: string }
  | { type: 'account' };

export interface ConnectionPrompt extends InteractivePromptBase {
  kind: 'connection';
  opId: string;
  seq: number;
  deadlineAtMs: number;
  timeoutSeconds: number;
  owner: ConnectionPromptOwner;
  targets: ConnectionOperationTarget[];
  toolCallId?: string | null;
  suggestedDisplay?: string[];
}

export interface GroupActionPrompt extends InteractivePromptBase {
  kind: 'group_action';
  roomId: string;
  actionKind: 'approval' | 'retry' | 'prepare';
  memberId: string;
  taskId: string;
  executionGeneration: number;
  command?: string;
  description?: string;
  toolName?: string;
  choices: string[];
  errorDetail?: string;
}

export interface RpcConfirmPrompt extends InteractivePromptBase {
  kind: 'rpc_confirm';
  confirmKind: 'expensive_model' | 'group_discard' | 'reload_mcp';
  title: string;
  message: string;
  confirmLabel?: string;
  secondaryConfirmLabel?: string;
  cancelLabel?: string;
  metadata?: Record<string, unknown>;
}

export type InteractivePrompt =
  | ClarifyPrompt
  | ApprovalPrompt
  | CredentialPrompt
  | ConnectionPrompt
  | GroupActionPrompt
  | RpcConfirmPrompt;

export type InteractiveReplyPayload =
  | {
      kind: 'clarify';
      cancelled?: boolean;
      answers?: Record<string, string | null>;
      singleAnswer?: string;
    }
  | {
      kind: 'approval';
      choice: ApprovalChoice | string;
      all?: boolean;
    }
  | {
      kind: 'credential';
      value: string;
      identifier?: string;
      password?: string;
    }
  | {
      kind: 'connection';
      targets?: Array<{
        name: string;
        status: 'approved' | 'skipped';
        detail?: string | null;
        env?: Record<string, string> | null;
      }>;
      settledBy?: 'all_resolved' | 'continue' | 'deadline' | 'interrupt' | null;
      said?: string | null;
    }
  | {
      kind: 'group_action';
      action: 'approve' | 'retry' | 'discard';
      choice?: ApprovalChoice;
    }
  | {
      kind: 'rpc_confirm';
      outcome: 'confirm' | 'confirm_always' | 'cancel';
    };

export interface BackgroundWaitingSummary {
  scopeKey: string;
  scope: PromptScope;
  entityType: 'session' | 'bot' | 'group';
  entityId: string;
  waitingReason: WaitingPromptReason;
  promptCount: number;
  oldestCreatedAtMs: number;
}
