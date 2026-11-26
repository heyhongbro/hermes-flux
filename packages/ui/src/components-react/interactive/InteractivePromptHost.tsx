/**
 * 交互停靠卡片统一调度宿主 (InteractivePromptHost)
 *
 * 【设计意图 (Why)】
 *   按 `activePrompt.canonicalKey` 为当前焦点作用域的待处理队列分发具体卡片
 *   （Clarify / Approval / Credential / Connection），管理提交锁与错误态展示，
 *   并在容器内绑定带 IME 保护的局部 `Escape` 收起快捷键（绝不挂全局裸键盘监听）。
 */

import * as React from 'react';
import type {
  ClarifyPrompt,
  ConnectionPrompt,
  InteractivePrompt,
  InteractiveReplyPayload,
} from '@hermes-flux/core';
import { t, type Locale } from '../../i18n/index.js';
import { createPromptSubmitGate } from './interactiveModel.js';
import type { DockSurfaceMode } from './PromptCardFrame.js';
import { ClarifyCard } from './ClarifyCard.js';
import { ApprovalCard } from './ApprovalCard.js';
import { CredentialPromptCard } from './CredentialPromptCard.js';
import { ConnectionPromptCard } from './ConnectionPromptCard.js';

export interface InteractivePromptHostProps {
  surface: DockSurfaceMode;
  prompts: readonly InteractivePrompt[];
  activeCanonicalKey?: string | null;
  collapsed?: boolean;
  locale?: Locale;
  onCollapsedChange?: (collapsed: boolean) => void;
  onSelectPrompt?: (canonicalKey: string) => void;
  onReply: (prompt: InteractivePrompt, payload: InteractiveReplyPayload) => Promise<boolean | void>;
  onLockClarifyAnswer?: (prompt: ClarifyPrompt, questionId: string, answer: string) => Promise<void>;
  onOpenExternalUrl?: (url: string) => void;
  onWakeConnection?: (prompt: ConnectionPrompt) => Promise<void>;
}

export function InteractivePromptHost({
  surface,
  prompts,
  activeCanonicalKey,
  collapsed = false,
  onCollapsedChange,
  onSelectPrompt,
  onReply,
  onLockClarifyAnswer,
  onOpenExternalUrl,
  onWakeConnection,
}: InteractivePromptHostProps): React.ReactElement | null {
  const [localCollapsed, setLocalCollapsed] = React.useState(false);
  const [submittingKey, setSubmittingKey] = React.useState<string | null>(null);
  const [errorByKey, setErrorByKey] = React.useState<Record<string, string | null>>({});
  const gateRef = React.useRef(createPromptSubmitGate());

  const isCollapsed = onCollapsedChange ? collapsed : localCollapsed;
  const setCollapsed = React.useCallback(
    (next: boolean) => {
      if (onCollapsedChange) {
        onCollapsedChange(next);
      } else {
        setLocalCollapsed(next);
      }
    },
    [onCollapsedChange],
  );

  if (prompts.length === 0) return null;

  const foundIdx = activeCanonicalKey
    ? prompts.findIndex((p) => p.canonicalKey === activeCanonicalKey)
    : -1;
  const activeIdx = foundIdx >= 0 ? foundIdx : 0;
  const activePrompt = prompts[activeIdx];
  const isSubmitting = submittingKey === activePrompt.canonicalKey || activePrompt.status === 'submitting';
  const localError = errorByKey[activePrompt.canonicalKey] ?? activePrompt.errorMessage ?? null;

  const handleSubmit = async (payload: InteractiveReplyPayload): Promise<boolean> => {
    const key = activePrompt.canonicalKey;
    const token = gateRef.current.tryAcquire(key);
    if (token === null) return false;
    setSubmittingKey(key);
    setErrorByKey((prev) => ({ ...prev, [key]: null }));
    try {
      const outcome = await onReply(activePrompt, payload);
      return outcome !== false;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err || 'Unknown error');
      setErrorByKey((prev) => ({ ...prev, [key]: t('interactive.submitFailed', { error: msg }) }));
      return false;
    } finally {
      gateRef.current.release(token);
      setSubmittingKey(null);
    }
  };

  const handleSelectQueueIndex = (idx: number): void => {
    const target = prompts[idx];
    if (target && onSelectPrompt) {
      onSelectPrompt(target.canonicalKey);
    }
  };

  const handleContainerKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape' && !isCollapsed) {
      event.stopPropagation();
      setCollapsed(true);
    }
  };

  const commonProps = {
    surface,
    queueIndex: activeIdx,
    queueLength: prompts.length,
    collapsed: isCollapsed,
    submitting: isSubmitting,
    localError,
    onToggleCollapse: () => setCollapsed(!isCollapsed),
    onSelectQueueIndex: handleSelectQueueIndex,
    onSubmit: handleSubmit,
  };

  return (
    <div
      className={surface === 'mobile-dock' ? 'm-interactive-dock m-no-swipe' : 'flux-interact__host'}
      data-surface={surface}
      data-flux-island="true"
      data-gesture-ignore="pan-x"
      onKeyDown={handleContainerKeyDown}
    >
      {activePrompt.kind === 'clarify' ? (
        <ClarifyCard
          key={activePrompt.canonicalKey}
          {...commonProps}
          prompt={activePrompt}
          onLockAnswer={
            onLockClarifyAnswer
              ? (qid, answer) => onLockClarifyAnswer(activePrompt, qid, answer)
              : undefined
          }
        />
      ) : activePrompt.kind === 'credential' ? (
        <CredentialPromptCard
          key={activePrompt.canonicalKey}
          {...commonProps}
          prompt={activePrompt}
        />
      ) : activePrompt.kind === 'connection' ? (
        <ConnectionPromptCard
          key={activePrompt.canonicalKey}
          {...commonProps}
          prompt={activePrompt}
          onOpenExternalUrl={onOpenExternalUrl}
          onWakeConnection={onWakeConnection ? () => onWakeConnection(activePrompt) : undefined}
        />
      ) : (
        <ApprovalCard
          key={activePrompt.canonicalKey}
          {...commonProps}
          prompt={activePrompt}
        />
      )}
    </div>
  );
}
