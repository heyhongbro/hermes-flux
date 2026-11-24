/**
 * 认知星图大尺寸节点/技能详情模态弹窗 (ConstellationNodeDetailDialog)
 *
 * 【设计意图 (Why)】
 *   用户点击星图下方的 Skill 列表或星图预览条后，打开大号独立阅读/编辑窗口（桌面端 1040×820 档、移动端近全屏）：
 *   1. 若节点为 `skill`，并行结合 `learningDetail`（`/api/learning/node`）与 `onInspectSkill`（完整 `SKILL.md`），
 *      复用全站唯一 `MarkdownBlock` 与 `splitSkillMarkdownFrontmatter` 呈现「优雅预览 / 原始源码」双视图；
 *   2. 在头部集中呈现所属类别、被调用次数 (`xN`)、更新日期以及可点击跳转的关联技能标签；
 *   3. 保持既有 `actionBusy` 并发锁、节点切换代数保护（`latestActiveIdRef` + `inspectSeqRef`）与两步删除确认契约。
 *
 * 【防范的历史坑 (Pitfall)】
 *   1. 在无 DOM 的 Node Hook 单测驱动下 `Radix Dialog` 的 Portal 与 DismissableLayer 副作用可能受限，
 *      这里在浏览器/Electron/Capacitor 中完整走共享 `<Dialog>`（`portal={false}`），
 *      在无 `document` 的纯 Node 驱动下平滑渲染同构静态容器，保证真实浏览器 Esc/焦点陷阱与纯 Node 单测全绿；
 *   2. 快速切换不同关联技能时必须递增 `inspectSeqRef` 丢弃迟到的 `onInspectSkill` 异步结果。
 */

import * as React from 'react';
import { ArrowLeft, BookOpen, Brain, Check, Copy, Pencil, RotateCw, Trash2 } from 'lucide-react';
import {
  normalizeLearningProfile,
  type ConstellationNode,
  type LearningDetailState,
  type SkillInspectView,
} from '@hermes-flux/core';
import { t } from '../../i18n/index.js';
import { Badge } from '../primitives/Badge.js';
import { Button } from '../primitives/Button.js';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../primitives/Dialog.js';
import { SegmentedControl } from '../settings/SegmentedControl.js';
import { SkillMarkdownView } from '../settings/SkillMarkdownView.js';
import type { SettingsActions } from '../settings/settingsModel.js';

export interface RelatedSkillChip {
  id: string;
  label: string;
  uses: number;
}

export interface ConstellationNodeDetailDialogProps {
  open: boolean;
  variant?: 'desktop' | 'mobile';
  node: ConstellationNode | null;
  targetProfile: string;
  learningDetail: LearningDetailState;
  relatedSkills: readonly RelatedSkillChip[];
  testIdPrefix: string;
  onClose: () => void;
  onSelectRelatedNode: (nodeId: string) => void;
  onSelectNodeDetail: (id: string, profile?: string) => void;
  onInspectSkill?: SettingsActions['onInspectSkill'];
  onSaveEdit?: (id: string, content: string, profile?: string) => Promise<{ ok: boolean; message?: string }>;
  onDeleteNode?: (id: string, profile?: string) => Promise<{ ok: boolean; message?: string }>;
  onCopyText?: (text: string) => void;
  onNotify?: (message: string) => void;
}

export function ConstellationNodeDetailDialog({
  open,
  variant = 'desktop',
  node,
  targetProfile,
  learningDetail,
  relatedSkills,
  testIdPrefix,
  onClose,
  onSelectRelatedNode,
  onSelectNodeDetail,
  onInspectSkill,
  onSaveEdit,
  onDeleteNode,
  onCopyText,
  onNotify,
}: ConstellationNodeDetailDialogProps): React.ReactElement | null {
  const [viewMode, setViewMode] = React.useState<'rendered' | 'raw'>('rendered');
  const [editing, setEditing] = React.useState(false);
  const [editDraft, setEditDraft] = React.useState('');
  const [actionBusy, setActionBusy] = React.useState(false);
  const [actionError, setActionError] = React.useState('');
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const [skillInspectState, setSkillInspectState] = React.useState<{
    loading: boolean;
    data?: SkillInspectView;
  }>({ loading: false });

  const latestActiveIdRef = React.useRef<string | undefined>(undefined);
  latestActiveIdRef.current = node?.id;
  const inspectSeqRef = React.useRef(0);

  React.useEffect(() => {
    setEditing(false);
    setConfirmDelete(false);
    setActionError('');
    setViewMode('rendered');
  }, [node?.id, targetProfile, open]);

  React.useEffect(() => {
    const seq = ++inspectSeqRef.current;
    if (!open || !node || node.kind !== 'skill' || !onInspectSkill) {
      setSkillInspectState({ loading: false });
      return;
    }
    const skillName = (node.skillName || node.id.replace(/^skill:/i, '')).trim();
    if (!skillName) {
      setSkillInspectState({ loading: false });
      return;
    }
    setSkillInspectState({ loading: true });
    void (async () => {
      try {
        const res = await onInspectSkill(
          targetProfile,
          skillName,
          node.description || node.fullLabel,
        );
        if (seq !== inspectSeqRef.current) return;
        if (res?.ok && res.data) {
          setSkillInspectState({ loading: false, data: res.data });
        } else {
          setSkillInspectState({ loading: false });
        }
      // gate-degrade: skills.manage/command.dispatch 失败时平滑保留 learningDetail 或节点摘要
      } catch {
        if (seq === inspectSeqRef.current) {
          setSkillInspectState({ loading: false });
        }
      }
    })();
  }, [open, node, targetProfile, onInspectSkill]);

  if (!open || !node) return null;

  const detailProfileMatches =
    learningDetail.status !== 'idle' &&
    (!learningDetail.profile ||
      normalizeLearningProfile(learningDetail.profile) === normalizeLearningProfile(targetProfile));

  const resolvedDetail =
    detailProfileMatches && learningDetail.status === 'ready' && learningDetail.id === node.id
      ? learningDetail
      : null;
  const detailLoading =
    detailProfileMatches && learningDetail.status === 'loading' && learningDetail.id === node.id;
  const detailError =
    detailProfileMatches && learningDetail.status === 'error' && learningDetail.id === node.id
      ? learningDetail.message
      : '';

  const inspectMd = skillInspectState.data?.markdown ?? '';
  const learningMd = resolvedDetail?.content ?? '';
  const loadedContent =
    inspectMd.length >= learningMd.length && inspectMd.trim()
      ? inspectMd
      : learningMd || inspectMd;
  const detailContent = loadedContent || node.preview || node.fullLabel;

  const isLoadingBody =
    (detailLoading || (node.kind === 'skill' && skillInspectState.loading)) && !loadedContent.trim();
  const showDetailError = Boolean(detailError && !loadedContent.trim() && !isLoadingBody);
  const kindLabel = node.kind === 'skill' ? t('mobile.memory.kindSkill') : t('mobile.memory.kindMemory');
  const canEdit = Boolean(onSaveEdit && !editing && !detailLoading && !detailError && resolvedDetail);
  const compactBtnSize = variant === 'mobile' ? 'default' : 'xs';
  const actionBtnSize = variant === 'mobile' ? 'default' : 'sm';
  const stopMobileSwipeBubble = (event: React.PointerEvent<HTMLElement>): void => {
    if (variant === 'mobile') {
      event.stopPropagation();
    }
  };

  const startEdit = (): void => {
    setEditDraft(resolvedDetail?.content || detailContent);
    setActionError('');
    setConfirmDelete(false);
    setEditing(true);
  };

  const handleSave = async (): Promise<void> => {
    if (!onSaveEdit || actionBusy) return;
    const targetId = node.id;
    setActionBusy(true);
    setActionError('');
    try {
      const res = await onSaveEdit(targetId, editDraft, targetProfile);
      if (latestActiveIdRef.current !== targetId) return;
      if (res.ok) {
        setEditing(false);
      } else {
        setActionError(res.message || t('settings.loadFailed'));
      }
    } finally {
      setActionBusy(false);
    }
  };

  const handleDelete = async (): Promise<void> => {
    if (!onDeleteNode || actionBusy) return;
    const targetId = node.id;
    setActionBusy(true);
    setActionError('');
    try {
      const res = await onDeleteNode(targetId, targetProfile);
      if (res.ok) {
        if (!latestActiveIdRef.current || latestActiveIdRef.current === targetId) {
          setConfirmDelete(false);
          onClose();
        }
      } else if (latestActiveIdRef.current === targetId) {
        setActionError(res.message || t('settings.loadFailed'));
      }
    } finally {
      setActionBusy(false);
    }
  };

  const handleCopy = (copyFn: (text: string) => void): void => {
    copyFn(detailContent);
    onNotify?.(t('bot.copied'));
  };

  const hasDom = typeof document !== 'undefined';
  const HeaderTitle = hasDom ? DialogTitle : 'h2';
  const HeaderDesc = hasDom ? DialogDescription : 'p';

  const bodyContent = (
    <div
      data-testid={`${testIdPrefix}-detail`}
      data-flux-island=""
      className="flex min-h-0 flex-1 flex-col overflow-hidden"
    >
      <div className="flex shrink-0 items-start justify-between gap-3 px-5 pb-3 pt-5">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <button
            type="button"
            className="constellation-icon-btn shrink-0"
            data-testid={`${testIdPrefix}-detail-back`}
            aria-label={t('mobile.inspector.backToList')}
            disabled={actionBusy}
            onClick={() => {
              setEditing(false);
              setConfirmDelete(false);
              onClose();
            }}
          >
            <ArrowLeft size={18} aria-hidden="true" />
          </button>
          <span
            aria-hidden="true"
            className="mt-1 flex size-8 shrink-0 items-center justify-center rounded-card surface-raised text-primary"
          >
            {node.kind === 'skill' ? (
              <BookOpen aria-hidden="true" className="size-4" />
            ) : (
              <Brain aria-hidden="true" className="size-4" />
            )}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <HeaderTitle className="truncate text-title font-semibold text-foreground">
                {skillInspectState.data?.name || node.label}
              </HeaderTitle>
              <Badge variant="secondary">{kindLabel}</Badge>
              <Badge variant="secondary">{t('mobile.memory.usesCount', { count: node.uses })}</Badge>
              {node.category ? <Badge variant="secondary">{node.category}</Badge> : null}
              {node.date ? <Badge variant="secondary">{node.date}</Badge> : null}
              {skillInspectState.data?.source ? (
                <Badge variant="secondary">
                  {`${t('bot.skillMetaSource')}: ${skillInspectState.data.source}`}
                </Badge>
              ) : null}
            </div>
            <HeaderDesc className="mt-1 text-caption text-muted-foreground">
              {skillInspectState.data?.description || node.description || node.fullLabel}
            </HeaderDesc>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {onCopyText ? (
            <button
              type="button"
              className="constellation-icon-btn"
              aria-label={t('mobile.inspector.copyContent')}
              onClick={() => handleCopy(onCopyText)}
            >
              <Copy size={16} aria-hidden="true" />
            </button>
          ) : null}
          {canEdit ? (
            <button
              type="button"
              className="constellation-icon-btn"
              data-testid={`${testIdPrefix}-edit`}
              aria-label={t('mobile.memory.editBtn')}
              disabled={actionBusy}
              onClick={startEdit}
            >
              <Pencil size={16} aria-hidden="true" />
            </button>
          ) : null}
          {onDeleteNode && !editing ? (
            <button
              type="button"
              className="constellation-icon-btn"
              data-testid={`${testIdPrefix}-delete`}
              aria-label={t('mobile.memory.deleteBtn')}
              disabled={actionBusy}
              onClick={() => setConfirmDelete((prev) => !prev)}
            >
              <Trash2 size={16} aria-hidden="true" />
            </button>
          ) : null}
        </div>
      </div>

      {!editing && !isLoadingBody && !showDetailError && detailContent.trim() ? (
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 px-5 pb-2">
          <SegmentedControl
            value={viewMode}
            variant={variant === 'mobile' ? 'tabs' : 'compact'}
            options={[
              { value: 'rendered', label: t('mobile.memory.viewRendered') },
              { value: 'raw', label: t('mobile.memory.viewRaw') },
            ]}
            ariaLabel={t('bot.skillViewModeAria')}
            onChange={setViewMode}
          />
          <span className="constellation-bot-badge">{targetProfile}</span>
        </div>
      ) : null}

      {relatedSkills.length > 0 ? (
        <div className="px-5 pb-2">
          <div className="constellation-detail-relations">
            <span className="text-caption text-muted-foreground">
              {t('mobile.memory.relatedSkillsTitle')}
            </span>
            {relatedSkills.map((rel) => (
              <Button
                key={rel.id}
                type="button"
                variant="outline"
                size={compactBtnSize}
                data-testid={`${testIdPrefix}-related-${rel.id}`}
                disabled={actionBusy}
                onClick={() => onSelectRelatedNode(rel.id)}
              >
                <span>{rel.label}</span>
                {rel.uses > 0 ? <span className="font-code text-muted-foreground">{`x${rel.uses}`}</span> : null}
              </Button>
            ))}
          </div>
        </div>
      ) : null}

      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-5 pb-5 pt-2">
        {actionError ? (
          <div className="mb-3 rounded-panel border border-border-subtle bg-card px-4 py-3 text-caption text-destructive" role="alert">
            <span>{actionError}</span>
          </div>
        ) : null}

        {confirmDelete ? (
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-panel border border-border-strong surface-raised px-4 py-3" role="status">
            <span className="text-caption text-foreground">{t('mobile.memory.deleteConfirmTitle')}</span>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size={compactBtnSize}
                disabled={actionBusy}
                onClick={() => setConfirmDelete(false)}
              >
                {t('mobile.memory.cancelEditBtn')}
              </Button>
              <Button
                type="button"
                variant="destructive"
                size={compactBtnSize}
                data-testid={`${testIdPrefix}-delete-confirm`}
                disabled={actionBusy}
                onClick={() => void handleDelete()}
              >
                {t('mobile.memory.deleteConfirmBtn')}
              </Button>
            </div>
          </div>
        ) : null}

        {isLoadingBody ? (
          <p className="constellation-state__text py-6 text-center">{t('mobile.memory.detailLoading')}</p>
        ) : showDetailError ? (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-panel surface-raised px-4 py-3 text-caption text-destructive" role="alert">
            <span>{detailError}</span>
            <Button
              type="button"
              variant="outline"
              size={compactBtnSize}
              data-testid={`${testIdPrefix}-detail-retry`}
              onClick={() => onSelectNodeDetail(node.id, targetProfile)}
            >
              <RotateCw size={12} aria-hidden="true" />
              <span>{t('bot.retry')}</span>
            </Button>
          </div>
        ) : editing ? (
          <div className="flex flex-col gap-3">
            <textarea
              className="min-h-60 w-full rounded-panel border border-border-subtle bg-input p-3 font-code text-body text-foreground"
              value={editDraft}
              disabled={actionBusy}
              onChange={(e) => setEditDraft(e.target.value)}
            />
            <div className="flex items-center justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                size={actionBtnSize}
                disabled={actionBusy}
                onClick={() => setEditing(false)}
              >
                {t('mobile.memory.cancelEditBtn')}
              </Button>
              <Button
                type="button"
                size={actionBtnSize}
                data-testid={`${testIdPrefix}-save`}
                disabled={actionBusy}
                onClick={() => void handleSave()}
              >
                <Check size={14} aria-hidden="true" />
                <span>{actionBusy ? t('mobile.memory.savingBtn') : t('mobile.memory.saveBtn')}</span>
              </Button>
            </div>
          </div>
        ) : (
          <SkillMarkdownView
            markdown={detailContent}
            viewMode={viewMode}
            fallbackToRawPreWhenNoFrontmatter
          />
        )}
      </div>
    </div>
  );

  if (!hasDom) {
    return (
      <div
        role="dialog"
        aria-modal="true"
        data-variant={variant}
        data-constellation-detail-dialog="true"
        data-gesture-ignore={variant === 'mobile' ? 'pan-x' : undefined}
        className={
          variant === 'mobile'
            ? 'm-no-swipe flex h-modal-xl max-h-modal-xl w-modal-xl max-w-none flex-col gap-0 overflow-hidden rounded-window border border-border-subtle bg-popover p-0 text-foreground shadow-window'
            : 'flex h-modal-xl max-h-modal-xl w-modal-xl max-w-none flex-col gap-0 overflow-hidden rounded-window border border-border-subtle bg-popover p-0 text-foreground shadow-window'
        }
      >
        {bodyContent}
      </div>
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !actionBusy) onClose();
      }}
    >
      <DialogContent
        portal={variant === 'mobile'}
        overlayClassName={variant === 'mobile' ? 'm-no-swipe' : undefined}
        data-flux-island=""
        data-variant={variant}
        data-constellation-detail-dialog="true"
        data-gesture-ignore={variant === 'mobile' ? 'pan-x' : undefined}
        onPointerDown={stopMobileSwipeBubble}
        onPointerMove={stopMobileSwipeBubble}
        onPointerUp={stopMobileSwipeBubble}
        onPointerCancel={stopMobileSwipeBubble}
        onEscapeKeyDown={(event) => {
          if (actionBusy) event.preventDefault();
        }}
        className={
          variant === 'mobile'
            ? 'm-no-swipe flex h-modal-xl max-h-modal-xl w-modal-xl max-w-none flex-col gap-0 overflow-hidden rounded-window p-0'
            : 'flex h-modal-xl max-h-modal-xl w-modal-xl max-w-none flex-col gap-0 overflow-hidden rounded-window p-0'
        }
      >
        {bodyContent}
      </DialogContent>
    </Dialog>
  );
}
