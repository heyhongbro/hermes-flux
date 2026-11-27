/**
 * 审批与二次确认停靠卡片 (ApprovalCard)
 *
 * 【设计意图 (Why)】
 *   同一停靠卡同时承接：
 *   1. 命令行/文件编辑审批 (`approval`，复用 DiffBody 呈现 diff，标出 `smart_denied` 提示)；
 *   2. 多 Agent 群聊阻塞动作 (`group_action`，严格按 `prompt.choices` 暴露 once/deny，支持 retry 与卡片内联丢弃二次确认)；
 *   3. 高成本模型切换等同步确认 (`rpc_confirm`)。
 */

import * as React from 'react';
import { AlertTriangle, ShieldCheck } from 'lucide-react';
import type {
  ApprovalPrompt,
  GroupActionPrompt,
  InteractiveReplyPayload,
  RpcConfirmPrompt,
} from '@hermes-flux/core';
import { t } from '../../i18n/index.js';
import { Badge } from '../primitives/Badge.js';
import { Button } from '../primitives/Button.js';
import { DiffBody } from '../conversation/ToolOutput.js';
import { extractEditPreview, splitCompactHeaderSubtitle } from './interactiveModel.js';
import { CodePreviewBox, PromptCardFrame, type DockSurfaceMode } from './PromptCardFrame.js';

export type ApprovalLikePrompt = ApprovalPrompt | GroupActionPrompt | RpcConfirmPrompt;

export interface ApprovalCardProps {
  surface: DockSurfaceMode;
  prompt: ApprovalLikePrompt;
  queueIndex: number;
  queueLength: number;
  collapsed: boolean;
  submitting: boolean;
  localError: string | null;
  onToggleCollapse: () => void;
  onSelectQueueIndex?: (idx: number) => void;
  onSubmit: (payload: InteractiveReplyPayload) => Promise<boolean | void>;
}

function approvalChoiceLabel(choice: string): string {
  switch (choice) {
    case 'once':
      return t('interactive.approval.choiceOnce');
    case 'session':
      return t('interactive.approval.choiceSession');
    case 'workspace_session':
      return t('interactive.approval.choiceWorkspaceSession');
    case 'always':
      return t('interactive.approval.choiceAlways');
    case 'deny':
      return t('interactive.approval.choiceDeny');
    default:
      return choice;
  }
}

export function ApprovalCard({
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
}: ApprovalCardProps): React.ReactElement {
  const [discardArmed, setDiscardArmed] = React.useState(false);
  const btnSize = surface === 'mobile-dock' ? 'sm' : 'xs';
  const mobileBtnCls = surface === 'mobile-dock' ? 'm-interact__btn px-2 text-aux' : '';

  if (prompt.kind === 'rpc_confirm') {
    const actionsNode = (
      <>
        <Button
          type="button"
          variant="ghost"
          size={btnSize}
          className={mobileBtnCls}
          disabled={submitting}
          data-testid="interactive-confirm-cancel"
          onClick={() => void onSubmit({ kind: 'rpc_confirm', outcome: 'cancel' })}
        >
          {prompt.cancelLabel || t('interactive.confirm.cancelBtn')}
        </Button>
        {prompt.secondaryConfirmLabel ? (
          <Button
            type="button"
            variant="secondary"
            size={btnSize}
            className={mobileBtnCls}
            disabled={submitting}
            data-testid="interactive-confirm-always"
            onClick={() => void onSubmit({ kind: 'rpc_confirm', outcome: 'confirm_always' })}
          >
            {prompt.secondaryConfirmLabel}
          </Button>
        ) : null}
        <Button
          type="button"
          variant="default"
          size={btnSize}
          className={mobileBtnCls}
          disabled={submitting}
          data-testid="interactive-confirm-accept"
          onClick={() => void onSubmit({ kind: 'rpc_confirm', outcome: 'confirm' })}
        >
          {prompt.confirmLabel || t('interactive.confirm.confirmBtn')}
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
        errorMessage={localError}
        actions={actionsNode}
        onToggleCollapse={onToggleCollapse}
        onSelectQueueIndex={onSelectQueueIndex}
      >
        <p className="flux-interact__desc">{prompt.message}</p>
      </PromptCardFrame>
    );
  }

  if (prompt.kind === 'group_action') {
    const isApproval = prompt.actionKind === 'approval';
    const actionsNode = isApproval ? (
      <>
        {prompt.choices.map((choice) => (
          <Button
            key={choice}
            type="button"
            variant={choice === 'deny' ? 'destructive' : 'default'}
            size={btnSize}
            className={mobileBtnCls}
            disabled={submitting}
            data-testid={`interactive-group-approve-${choice}`}
            onClick={() =>
              void onSubmit({
                kind: 'group_action',
                action: 'approve',
                choice:
                  choice === 'deny' || choice === 'session' || choice === 'always' || choice === 'once'
                    ? choice
                    : 'once',
              })
            }
          >
            {approvalChoiceLabel(choice)}
          </Button>
        ))}
      </>
    ) : discardArmed ? (
      <>
        <span className="flux-interact__inline-warn">{t('interactive.group.discardConfirmTitle')}</span>
        <Button
          type="button"
          variant="ghost"
          size={btnSize}
          className={mobileBtnCls}
          disabled={submitting}
          onClick={() => setDiscardArmed(false)}
        >
          {t('interactive.group.discardCancelBtn')}
        </Button>
        <Button
          type="button"
          variant="destructive"
          size={btnSize}
          className={mobileBtnCls}
          disabled={submitting}
          data-testid="interactive-group-discard-confirm"
          onClick={() => void onSubmit({ kind: 'group_action', action: 'discard' })}
        >
          {t('interactive.group.discardConfirmBtn')}
        </Button>
      </>
    ) : (
      <>
        <Button
          type="button"
          variant="destructive"
          size={btnSize}
          className={mobileBtnCls}
          disabled={submitting}
          data-testid="interactive-group-discard-arm"
          onClick={() => setDiscardArmed(true)}
        >
          {t('interactive.group.discardBtn')}
        </Button>
        <Button
          type="button"
          variant="default"
          size={btnSize}
          className={mobileBtnCls}
          disabled={submitting}
          data-testid="interactive-group-retry"
          onClick={() => void onSubmit({ kind: 'group_action', action: 'retry' })}
        >
          {t('interactive.group.retryBtn')}
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
        headerSubtitle={t('interactive.group.memberTask', { member: prompt.memberId, task: prompt.taskId })}
        headerExtra={
          <>
            <Badge variant="outline">{prompt.memberId}</Badge>
            {prompt.toolName ? <Badge variant="secondary">{prompt.toolName}</Badge> : null}
          </>
        }
        errorMessage={localError}
        actions={actionsNode}
        onToggleCollapse={onToggleCollapse}
        onSelectQueueIndex={onSelectQueueIndex}
      >
        {prompt.description ? <p className="flux-interact__desc">{prompt.description}</p> : null}
        {prompt.command ? (
          <CodePreviewBox ariaLabel={t('interactive.approval.commandLabel')} code={prompt.command} />
        ) : null}
        {prompt.errorDetail ? <p className="flux-interact__desc">{prompt.errorDetail}</p> : null}
      </PromptCardFrame>
    );
  }

  const editPreview = extractEditPreview(prompt.edit);
  const hasBodyArtifact = Boolean(prompt.command || editPreview.diff);
  const { headerSubtitle, bodyDescription } = splitCompactHeaderSubtitle(
    prompt.description,
    hasBodyArtifact,
  );
  const actionsNode = (
    <>
      {prompt.choices.map((choice) => {
        const variant =
          choice === 'deny'
            ? 'destructive'
            : choice === 'once'
              ? 'default'
              : 'secondary';
        return (
          <Button
            key={choice}
            type="button"
            variant={variant}
            size={btnSize}
            className={mobileBtnCls}
            disabled={submitting}
            data-testid={`interactive-approval-${choice}`}
            onClick={() => void onSubmit({ kind: 'approval', choice })}
          >
            {approvalChoiceLabel(choice)}
          </Button>
        );
      })}
    </>
  );

  return (
    <PromptCardFrame
      surface={surface}
      prompt={prompt}
      queueIndex={queueIndex}
      queueLength={queueLength}
      collapsed={collapsed}
      headerSubtitle={headerSubtitle}
      headerExtra={prompt.toolName ? <Badge variant="secondary">{prompt.toolName}</Badge> : undefined}
      errorMessage={localError}
      actions={actionsNode}
      onToggleCollapse={onToggleCollapse}
      onSelectQueueIndex={onSelectQueueIndex}
    >
      {prompt.smartDenied ? (
        <div className="flux-interact__notice-banner">
          <AlertTriangle size={14} className="shrink-0 text-warning" aria-hidden="true" />
          <span>{t('interactive.approval.smartDeniedHint')}</span>
        </div>
      ) : null}
      {bodyDescription ? <p className="flux-interact__desc">{bodyDescription}</p> : null}
      {prompt.command ? (
        <CodePreviewBox ariaLabel={t('interactive.approval.commandLabel')} code={prompt.command} />
      ) : null}
      {editPreview.diff ? (
        <div className="flux-interact__diff-wrap">
          <div className="flux-interact__field-label">
            <ShieldCheck size={12} className="shrink-0" aria-hidden="true" />
            <span>
              {editPreview.filePath
                ? `${t('interactive.approval.diffLabel')} · ${editPreview.filePath}`
                : t('interactive.approval.diffLabel')}
            </span>
          </div>
          <div className="flux-interact__diff-scroll">
            <DiffBody diff={editPreview.diff} />
          </div>
        </div>
      ) : null}
    </PromptCardFrame>
  );
}
