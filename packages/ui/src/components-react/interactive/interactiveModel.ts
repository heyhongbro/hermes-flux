/**
 * 交互停靠卡纯视图模型与防重入逻辑 (interactiveModel.ts)
 *
 * 【设计意图 (Why)】
 *   跨端（Desktop & Mobile）共享交互卡的状态归约、表单校验、外部 URL 安全校验、
 *   提问答案拼装以及单调提交闸门锁，彻底脱离 React 与 DOM，可直接走纯 Node 单测。
 *
 * 【约束与规则 (Rules)】
 *   - 严禁 import react / DOM；
 *   - `createPromptSubmitGate` 必须防御在途并发提交及失败恢复；
 *   - `isSafeExternalUrl` 只允许 `http:` / `https:` 协议。
 */

import type {
  ClarifyPrompt,
  ClarifyQuestion,
  ConnectionPrompt,
  CredentialPrompt,
  InteractivePrompt,
  InteractiveReplyPayload,
  WaitingPromptReason,
} from '@hermes-flux/core';
import type { I18nKey } from '../../i18n/index.js';

export type TranslateFn = (key: I18nKey, vars?: Record<string, string | number>) => string;

export interface PromptSubmitGate {
  tryAcquire: (canonicalKey: string) => number | null;
  release: (token: number) => void;
  isBusy: () => boolean;
}

/**
 * 交互回复防连击闸门锁：同一时刻只允许一条在途回复；异常恢复后可安全重试。
 */
export function createPromptSubmitGate(): PromptSubmitGate {
  let seq = 0;
  let activeToken: number | null = null;

  return {
    tryAcquire(canonicalKey: string): number | null {
      if (!canonicalKey || activeToken !== null) return null;
      seq += 1;
      activeToken = seq;
      return activeToken;
    },
    release(token: number): void {
      if (activeToken === token) {
        activeToken = null;
      }
    },
    isBusy(): boolean {
      return activeToken !== null;
    },
  };
}

export interface ClarifyDraftState {
  selectedByQuestion: Readonly<Record<string, string[]>>;
  otherEnabledByQuestion: Readonly<Record<string, boolean>>;
  otherTextByQuestion: Readonly<Record<string, string>>;
}

export function createEmptyClarifyDraft(): ClarifyDraftState {
  return {
    selectedByQuestion: {},
    otherEnabledByQuestion: {},
    otherTextByQuestion: {},
  };
}

export interface ClarifyDraftCacheEntry {
  draft: ClarifyDraftState;
  activeQIdx: number;
}

export interface ClarifyDraftCache {
  get: (key: string) => ClarifyDraftCacheEntry | undefined;
  set: (key: string, draft: ClarifyDraftState, activeQIdx: number) => void;
  delete: (key: string) => void;
  size: () => number;
  clear: () => void;
}

/**
 * 内存级有界 Clarify 草稿缓存（零持久化），防止切换会话浏览后台时丢失已选选项或自定义输入。
 */
export function createClarifyDraftCache(maxEntries = 32): ClarifyDraftCache {
  const store = new Map<string, ClarifyDraftCacheEntry>();
  const limit = Number.isFinite(maxEntries) ? Math.max(1, Math.floor(maxEntries)) : 32;

  return {
    get: (key: string) => {
      const entry = store.get(key);
      if (!entry) return undefined;
      store.delete(key);
      store.set(key, entry);
      return entry;
    },
    set: (key: string, draft: ClarifyDraftState, activeQIdx: number): void => {
      if (!key) return;
      store.delete(key);
      store.set(key, { draft, activeQIdx });
      while (store.size > limit) {
        const oldest = store.keys().next().value;
        if (oldest === undefined) break;
        store.delete(oldest);
      }
    },
    delete: (key: string): void => {
      store.delete(key);
    },
    size: () => store.size,
    clear: (): void => {
      store.clear();
    },
  };
}

/** 判定 Clarify 草稿是否含实质未提交内容（空默认态不占位 LRU 缓存）。 */
export function hasClarifyDraftContent(draft: ClarifyDraftState, activeQIdx = 0): boolean {
  if (activeQIdx > 0) return true;
  if (Object.values(draft.selectedByQuestion).some((items) => items.length > 0)) return true;
  if (Object.values(draft.otherEnabledByQuestion).some(Boolean)) return true;
  if (Object.values(draft.otherTextByQuestion).some((text) => text.length > 0)) return true;
  return false;
}

/** 仅在提交真实收敛或被宿主接受时清理缓存，失败/回滚时保留草稿。 */
export function shouldEvictClarifyDraftAfterSubmit(settled: boolean | void): boolean {
  return settled !== false;
}

/** 卡片单行副标题分流：短文案纳入标题行省空间，超长描述完整回退正文区防截断丢字。 */
export function splitCompactHeaderSubtitle(
  raw?: string | null,
  inlineAllowed = true,
  maxLen = 80,
): { headerSubtitle?: string; bodyDescription?: string } {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (!trimmed) return {};
  if (inlineAllowed && trimmed.length <= maxLen) {
    return { headerSubtitle: trimmed };
  }
  return { bodyDescription: trimmed };
}

/** 根据题目配置（已锁定答案 / 选项 / 多选 / 自定义文本）解析当前回答文本。 */
export function resolveClarifyQuestionAnswer(
  question: ClarifyQuestion,
  lockedAnswers: Readonly<Record<string, string | null>>,
  draft: ClarifyDraftState,
  index: number,
): string {
  const qKey = question.qid || String(index);
  const locked = lockedAnswers[qKey];
  if (typeof locked === 'string' && locked.trim().length > 0) {
    return locked.trim();
  }

  const hasChoices = Array.isArray(question.choices) && question.choices.length > 0;
  if (!hasChoices) {
    return (draft.otherTextByQuestion[qKey] ?? '').trim();
  }

  const picked = (draft.selectedByQuestion[qKey] ?? []).filter((item) => item.trim().length > 0);
  const useOther = Boolean(draft.otherEnabledByQuestion[qKey]);
  const otherText = (draft.otherTextByQuestion[qKey] ?? '').trim();

  if (question.multi_select) {
    const combined = useOther && otherText ? [...picked, otherText] : picked;
    return combined.join(', ');
  }

  if (useOther) {
    return otherText;
  }
  return picked[0] ?? '';
}

/** 构建提交给 `clarify.respond` / WS `clarify` 反向响应的答案映射。 */
export function buildClarifyReplyPayload(
  prompt: ClarifyPrompt,
  draft: ClarifyDraftState,
): { payload: InteractiveReplyPayload | null; missingCount: number } {
  const questions = prompt.questions;
  if (questions.length === 0) {
    return { payload: null, missingCount: 1 };
  }

  const answers: Record<string, string | null> = {};
  let missingCount = 0;

  for (let i = 0; i < questions.length; i += 1) {
    const q = questions[i];
    const qKey = q.qid || String(i);
    const val = resolveClarifyQuestionAnswer(q, prompt.lockedAnswers, draft, i);
    if (!val) {
      missingCount += 1;
    } else {
      answers[qKey] = val;
    }
  }

  if (missingCount > 0) {
    return { payload: null, missingCount };
  }

  const singleKey = questions[0]?.qid || '0';
  return {
    missingCount: 0,
    payload: {
      kind: 'clarify',
      answers,
      ...(questions.length === 1 && answers[singleKey] ? { singleAnswer: answers[singleKey] ?? undefined } : {}),
    },
  };
}

/** 校验 `http:` / `https:` 安全外链，拦截 `javascript:` / `data:` / `file:`。 */
export function isSafeExternalUrl(rawUrl: string | null | undefined): boolean {
  if (!rawUrl || typeof rawUrl !== 'string') return false;
  const trimmed = rawUrl.trim();
  if (!trimmed) return false;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  // gate-degrade: URL 解析失败代表非法外链格式，直接拒绝放行
  } catch {
    return false;
  }
}

export interface CredentialDraftInput {
  value: string;
  identifier: string;
  password: string;
}

/** 构建并校验凭据/密钥类回复载荷；`vault.save_login` 自动编码双字段 JSON。 */
export function buildCredentialSubmitPayload(
  prompt: CredentialPrompt,
  draft: CredentialDraftInput,
): { valid: boolean; payload: InteractiveReplyPayload | null } {
  if (prompt.method === 'vault.save_login') {
    const idTrimmed = draft.identifier.trim();
    const pwd = draft.password;
    if (!idTrimmed || !pwd) {
      return { valid: false, payload: null };
    }
    return {
      valid: true,
      payload: {
        kind: 'credential',
        value: JSON.stringify({ identifier: idTrimmed, password: pwd }),
        identifier: idTrimmed,
        password: pwd,
      },
    };
  }

  const trimmed = prompt.method === 'vault.code' ? draft.value.trim() : draft.value;
  if (trimmed.trim().length === 0) {
    return { valid: false, payload: null };
  }
  return {
    valid: true,
    payload: {
      kind: 'credential',
      value: trimmed,
    },
  };
}

/** 校验单个 Connection 目标的必填环境变量是否已全部填入。 */
export function areRequiredConnectionEnvFilled(
  prompt: ConnectionPrompt,
  targetName: string,
  envDrafts: Readonly<Record<string, Readonly<Record<string, string>>>>,
): boolean {
  const target = prompt.targets.find((item) => item.name === targetName);
  if (!target || !Array.isArray(target.required_env)) return true;
  const values = envDrafts[targetName] ?? {};
  for (const field of target.required_env) {
    if (!field.required) continue;
    const raw = values[field.name] ?? field.default ?? '';
    if (String(raw).trim().length === 0) {
      return false;
    }
  }
  return true;
}

/** 返回与等待原因对应的状态指示词 i18n 键。 */
export function resolveWaitingStatusKey(
  reason: WaitingPromptReason,
  variant: 'rail' | 'mobile',
): I18nKey {
  if (variant === 'mobile') {
    switch (reason) {
      case 'clarify':
        return 'mobile.status.waitingReply';
      case 'approval':
        return 'mobile.status.waitingApproval';
      case 'credential':
        return 'mobile.status.waitingCredential';
      case 'connection':
        return 'mobile.status.waitingConnection';
      case 'confirm':
        return 'mobile.status.waitingConfirm';
      default:
        return 'mobile.status.waiting';
    }
  }

  switch (reason) {
    case 'clarify':
      return 'rail.activityStatusWaitingReply';
    case 'approval':
      return 'rail.activityStatusWaitingApproval';
    case 'credential':
      return 'rail.activityStatusWaitingCredential';
    case 'connection':
      return 'rail.activityStatusWaitingConnection';
    case 'confirm':
      return 'rail.activityStatusWaitingConfirm';
    default:
      return 'rail.activityStatusWaiting';
  }
}

/** 提取 `ApprovalPrompt.edit` 中的差异字符串与文件路径（兼容多字段形态）。 */
export function extractEditPreview(edit: Record<string, unknown> | null | undefined): {
  filePath?: string;
  diff?: string;
} {
  if (!edit || typeof edit !== 'object') return {};
  const pathVal =
    typeof edit.path === 'string'
      ? edit.path
      : typeof edit.file_path === 'string'
        ? edit.file_path
        : typeof edit.resolved_path === 'string'
          ? edit.resolved_path
          : undefined;
  if (typeof edit.diff === 'string' && edit.diff.trim().length > 0) {
    return { ...(pathVal ? { filePath: pathVal } : {}), diff: edit.diff };
  }
  if (typeof edit.patch === 'string' && edit.patch.trim().length > 0) {
    return { ...(pathVal ? { filePath: pathVal } : {}), diff: edit.patch };
  }
  const oldText = typeof edit.old_string === 'string' ? edit.old_string : typeof edit.old_text === 'string' ? edit.old_text : '';
  const newText = typeof edit.new_string === 'string' ? edit.new_string : typeof edit.new_text === 'string' ? edit.new_text : '';
  if (oldText || newText) {
    const minusLines = oldText ? oldText.split('\n').map((l) => `-${l}`).join('\n') : '';
    const plusLines = newText ? newText.split('\n').map((l) => `+${l}`).join('\n') : '';
    const synth = [minusLines, plusLines].filter(Boolean).join('\n');
    return { ...(pathVal ? { filePath: pathVal } : {}), diff: synth };
  }
  return pathVal ? { filePath: pathVal } : {};
}

/** 解析交互卡片标题与折叠态单行摘要。 */
export function resolvePromptHeaderInfo(
  prompt: InteractivePrompt,
  t: TranslateFn,
): { title: string; subtitle: string } {
  switch (prompt.kind) {
    case 'clarify': {
      const firstQ = prompt.questions[0]?.question?.trim() || '';
      return {
        title: t('interactive.clarify.title'),
        subtitle: firstQ,
      };
    }
    case 'approval': {
      const hasEdit = Boolean(prompt.edit);
      return {
        title: hasEdit ? t('interactive.approval.editTitle') : t('interactive.approval.title'),
        subtitle: prompt.command || prompt.description || prompt.toolName || '',
      };
    }
    case 'group_action':
      return {
        title:
          prompt.actionKind === 'approval'
            ? t('interactive.approval.groupTitle')
            : t('interactive.group.retryTitle'),
        subtitle: t('interactive.group.memberTask', { member: prompt.memberId, task: prompt.taskId }),
      };
    case 'credential': {
      const titleKey: I18nKey =
        prompt.method === 'sudo'
          ? 'interactive.credential.sudoTitle'
          : prompt.method === 'display.install.sudo'
            ? 'interactive.credential.displaySudoTitle'
            : prompt.method === 'vault.code'
              ? 'interactive.credential.vaultCodeTitle'
              : prompt.method === 'vault.unlock_prompt'
                ? 'interactive.credential.vaultUnlockTitle'
                : prompt.method === 'vault.save_login'
                  ? 'interactive.credential.vaultSaveTitle'
                  : 'interactive.credential.secretTitle';
      return {
        title: t(titleKey),
        subtitle: prompt.envVar || prompt.site || prompt.profileKey || prompt.promptText || '',
      };
    }
    case 'connection':
      return {
        title: t('interactive.connection.title'),
        subtitle: prompt.targets.map((target) => target.display || target.name).join(', '),
      };
    case 'rpc_confirm':
      return {
        title: prompt.title,
        subtitle: prompt.message,
      };
  }
}
