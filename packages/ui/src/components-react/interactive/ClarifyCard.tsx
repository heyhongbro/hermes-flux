/**
 * Agent 提问停靠卡片 (ClarifyCard)
 *
 * 【设计意图 (Why)】
 *   贴合输入舱上方渲染提问列表，支持单题/多题、单选/多选选项与自由输入「其他」补充；
 *   题签支持逐题 `clarify.lock` 提前锁定答案；取消/跳过严格不携带 `answers`（{ outcome: 'cancelled' }）。
 *
 * 【防范的历史坑 (Pitfall)】
 *   1. 输入法组合态（isComposing / keyCode === 229）按 Enter 误提交，必须先放行组合键；
 *   2. 折叠卡仅视觉隐藏主体，不卸载组件，保留用户已选与草稿输入。
 */

import * as React from 'react';
import { Check, Lock } from 'lucide-react';
import type { ClarifyPrompt, InteractiveReplyPayload } from '@hermes-flux/core';
import { t } from '../../i18n/index.js';
import { Badge } from '../primitives/Badge.js';
import { Button } from '../primitives/Button.js';
import { Textarea } from '../primitives/Textarea.js';
import {
  buildClarifyReplyPayload,
  createClarifyDraftCache,
  createEmptyClarifyDraft,
  hasClarifyDraftContent,
  resolveClarifyQuestionAnswer,
  shouldEvictClarifyDraftAfterSubmit,
  type ClarifyDraftState,
} from './interactiveModel.js';
import { PromptCardFrame, type DockSurfaceMode } from './PromptCardFrame.js';

export interface ClarifyCardProps {
  surface: DockSurfaceMode;
  prompt: ClarifyPrompt;
  queueIndex: number;
  queueLength: number;
  collapsed: boolean;
  submitting: boolean;
  localError: string | null;
  onToggleCollapse: () => void;
  onSelectQueueIndex?: (idx: number) => void;
  onSubmit: (payload: InteractiveReplyPayload) => Promise<boolean | void>;
  onLockAnswer?: (questionId: string, answer: string) => Promise<void>;
}

const sharedClarifyDraftCache = createClarifyDraftCache(32);

export function ClarifyCard({
  surface,
  prompt,
  queueIndex,
  queueLength,
  collapsed,
  submitting,
  localError,
  onToggleCollapse,
  onSelectQueueIndex,
  onSubmit,
  onLockAnswer,
}: ClarifyCardProps): React.ReactElement {
  const draftCacheKey = `${prompt.canonicalKey}::${prompt.createdAtMs}`;
  const loadedKeyRef = React.useRef<string>(draftCacheKey);
  const [draft, setDraft] = React.useState<ClarifyDraftState>(
    () => sharedClarifyDraftCache.get(draftCacheKey)?.draft ?? createEmptyClarifyDraft(),
  );
  const [activeQIdx, setActiveQIdx] = React.useState<number>(
    () => sharedClarifyDraftCache.get(draftCacheKey)?.activeQIdx ?? 0,
  );
  const [validationError, setValidationError] = React.useState<string | null>(null);
  const textareaId = React.useId();

  React.useEffect(() => {
    if (loadedKeyRef.current !== draftCacheKey) {
      loadedKeyRef.current = draftCacheKey;
      const restored = sharedClarifyDraftCache.get(draftCacheKey);
      setDraft(restored?.draft ?? createEmptyClarifyDraft());
      setActiveQIdx(restored?.activeQIdx ?? 0);
      setValidationError(null);
      return;
    }
    if (hasClarifyDraftContent(draft, activeQIdx)) {
      sharedClarifyDraftCache.set(draftCacheKey, draft, activeQIdx);
    } else {
      sharedClarifyDraftCache.delete(draftCacheKey);
    }
  }, [draftCacheKey, draft, activeQIdx]);

  const questions = prompt.questions;
  const safeQIdx = Math.max(0, Math.min(questions.length - 1, activeQIdx));
  const currentQ = questions[safeQIdx];
  const qKey = currentQ ? currentQ.qid || String(safeQIdx) : '0';
  const btnSize = surface === 'mobile-dock' ? 'sm' : 'xs';
  const mobileBtnCls = surface === 'mobile-dock' ? 'm-interact__btn px-2 text-aux' : '';

  const currentAnswerText = currentQ
    ? resolveClarifyQuestionAnswer(currentQ, prompt.lockedAnswers, draft, safeQIdx)
    : '';
  const isCurrentLocked = currentQ
    ? typeof prompt.lockedAnswers[qKey] === 'string' && prompt.lockedAnswers[qKey] !== null
    : false;

  const toggleChoice = (qKey: string, choice: string, multiSelect: boolean): void => {
    setValidationError(null);
    setDraft((prev) => {
      const current = prev.selectedByQuestion[qKey] ?? [];
      if (!multiSelect) {
        return {
          ...prev,
          selectedByQuestion: { ...prev.selectedByQuestion, [qKey]: [choice] },
          otherEnabledByQuestion: { ...prev.otherEnabledByQuestion, [qKey]: false },
        };
      }
      const exists = current.includes(choice);
      const nextList = exists ? current.filter((item) => item !== choice) : [...current, choice];
      return {
        ...prev,
        selectedByQuestion: { ...prev.selectedByQuestion, [qKey]: nextList },
      };
    });
  };

  const toggleOther = (qKey: string, multiSelect: boolean): void => {
    setValidationError(null);
    setDraft((prev) => {
      const nextEnabled = !prev.otherEnabledByQuestion[qKey];
      return {
        ...prev,
        selectedByQuestion: multiSelect
          ? prev.selectedByQuestion
          : nextEnabled
            ? { ...prev.selectedByQuestion, [qKey]: [] }
            : prev.selectedByQuestion,
        otherEnabledByQuestion: { ...prev.otherEnabledByQuestion, [qKey]: nextEnabled },
      };
    });
  };

  const setOtherText = (qKey: string, value: string): void => {
    setValidationError(null);
    setDraft((prev) => ({
      ...prev,
      otherEnabledByQuestion: { ...prev.otherEnabledByQuestion, [qKey]: true },
      otherTextByQuestion: { ...prev.otherTextByQuestion, [qKey]: value },
    }));
  };

  const handleLockAndNext = async (qId: string, answer: string): Promise<void> => {
    if (onLockAnswer) {
      await onLockAnswer(qId, answer);
    }
    if (safeQIdx + 1 < questions.length) {
      setActiveQIdx(safeQIdx + 1);
    }
  };

  const handleSubmitAll = async (): Promise<void> => {
    if (submitting) return;
    const built = buildClarifyReplyPayload(prompt, draft);
    if (!built.payload) {
      setValidationError(t('interactive.clarify.emptyHint'));
      return;
    }
    setValidationError(null);
    const settled = await onSubmit(built.payload);
    if (shouldEvictClarifyDraftAfterSubmit(settled)) {
      sharedClarifyDraftCache.delete(draftCacheKey);
    }
  };

  const handleCancelAll = async (): Promise<void> => {
    if (submitting) return;
    setValidationError(null);
    const settled = await onSubmit({ kind: 'clarify', cancelled: true });
    if (shouldEvictClarifyDraftAfterSubmit(settled)) {
      sharedClarifyDraftCache.delete(draftCacheKey);
    }
  };

  const mergedError = localError || validationError;

  const handleTextareaKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (questions.length > 1 && safeQIdx < questions.length - 1 && onLockAnswer && currentAnswerText) {
        void handleLockAndNext(qKey, currentAnswerText);
      } else {
        void handleSubmitAll();
      }
    }
  };
  const hasChoices = Boolean(currentQ?.choices && currentQ.choices.length > 0);
  const isMulti = Boolean(currentQ?.multi_select);
  const selectedChoices = draft.selectedByQuestion[qKey] ?? [];
  const otherEnabled = Boolean(draft.otherEnabledByQuestion[qKey]);
  const otherText = draft.otherTextByQuestion[qKey] ?? '';

  const actionsNode = (
    <>
      <Button
        type="button"
        variant="ghost"
        size={btnSize}
        className={mobileBtnCls}
        disabled={submitting}
        data-testid="interactive-clarify-cancel"
        onClick={() => void handleCancelAll()}
      >
        {t('interactive.clarify.skipAll')}
      </Button>
      <Button
        type="button"
        variant="default"
        size={btnSize}
        className={mobileBtnCls}
        disabled={submitting}
        data-testid="interactive-clarify-submit"
        onClick={() => void handleSubmitAll()}
      >
        {submitting ? t('interactive.submitting') : t('interactive.clarify.submit')}
      </Button>
    </>
  );

  return (
    <PromptCardFrame
      surface={surface}
      prompt={prompt}
      queueIndex={queueIndex}
      queueLength={queueLength}
      collapsed={collapsed}
      errorMessage={mergedError}
      actions={actionsNode}
      onToggleCollapse={onToggleCollapse}
      onSelectQueueIndex={onSelectQueueIndex}
    >
      {questions.length > 1 ? (
        <div className="flux-interact__tabs" role="tablist">
          {questions.map((q, idx) => {
            const tabKey = q.qid || String(idx);
            const locked = typeof prompt.lockedAnswers[tabKey] === 'string' && prompt.lockedAnswers[tabKey] !== null;
            return (
              <button
                key={tabKey}
                type="button"
                role="tab"
                aria-selected={idx === safeQIdx}
                className="flux-interact__tab"
                data-active={idx === safeQIdx ? 'true' : 'false'}
                onClick={() => setActiveQIdx(idx)}
              >
                {locked ? <Lock size={11} aria-hidden="true" /> : null}
                <span>{t('interactive.clarify.questionTab', { index: String(idx + 1) })}</span>
              </button>
            );
          })}
        </div>
      ) : null}

      {currentQ ? (
        <div className="flux-interact__question-block">
          <div className="flux-interact__question-head">
            <p className="flux-interact__question-text">{currentQ.question}</p>
            <div className="flex shrink-0 items-center gap-1">
              {isMulti ? <Badge variant="secondary">{t('interactive.clarify.multiSelectHint')}</Badge> : null}
              {isCurrentLocked ? (
                <Badge variant="default">
                  <Lock size={10} className="mr-1" aria-hidden="true" />
                  {t('interactive.clarify.lockedBadge')}
                </Badge>
              ) : null}
            </div>
          </div>

          {isCurrentLocked ? (
            <div className="flux-interact__locked-answer">
              {prompt.lockedAnswers[currentQ.qid]}
            </div>
          ) : (
            <>
              {hasChoices ? (
                <div className="flux-interact__choices">
                  {currentQ.choices?.map((choice) => {
                    const active = selectedChoices.includes(choice);
                    return (
                      <button
                        key={choice}
                        type="button"
                        className="flux-interact__choice-chip"
                        data-selected={active ? 'true' : 'false'}
                        disabled={submitting}
                        aria-pressed={active}
                        onClick={() => toggleChoice(qKey, choice, isMulti)}
                      >
                        {active ? <Check size={12} className="shrink-0" aria-hidden="true" /> : null}
                        <span>{choice}</span>
                      </button>
                    );
                  })}
                  <button
                    type="button"
                    className="flux-interact__choice-chip"
                    data-selected={otherEnabled ? 'true' : 'false'}
                    disabled={submitting}
                    aria-pressed={otherEnabled}
                    onClick={() => toggleOther(qKey, isMulti)}
                  >
                    <span>{t('interactive.clarify.otherOption')}</span>
                  </button>
                </div>
              ) : null}

              {(!hasChoices || otherEnabled) ? (
                <Textarea
                  id={textareaId}
                  size={surface === 'mobile-dock' ? 'sm' : 'xs'}
                  className="font-ui"
                  value={otherText}
                  disabled={submitting}
                  placeholder={t('interactive.clarify.otherPlaceholder')}
                  onChange={(e) => setOtherText(qKey, e.currentTarget.value)}
                  onKeyDown={handleTextareaKeyDown}
                />
              ) : null}

              {questions.length > 1 && onLockAnswer && currentAnswerText ? (
                <div className="flex justify-end pt-1">
                  <Button
                    type="button"
                    variant="secondary"
                    size={btnSize}
                    className={mobileBtnCls}
                    disabled={submitting}
                    onClick={() => void handleLockAndNext(qKey, currentAnswerText)}
                  >
                    {t('interactive.nextPrompt')}
                  </Button>
                </div>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </PromptCardFrame>
  );
}
