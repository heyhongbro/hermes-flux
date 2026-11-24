import * as React from 'react';
import { BookOpen, Copy, RotateCcw, X } from 'lucide-react';
import type { SkillInspectView } from '@hermes-flux/core';
import { t } from '../../i18n/index.js';
import { Badge } from '../primitives/Badge.js';
import { Button } from '../primitives/Button.js';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../primitives/Dialog.js';
import { Skeleton } from '../primitives/Skeleton.js';
import { Tooltip } from '../primitives/Tooltip.js';
import { SegmentedControl } from './SegmentedControl.js';
import { SkillMarkdownView, type SkillMarkdownViewMode } from './SkillMarkdownView.js';
import type { SettingsActions } from './settingsModel.js';

/**
 * 技能完整说明与源码查看弹窗（格式化后优雅预览 / 格式化前原始源码切换）。
 *
 * 【设计意图 (Why)】
 *   Skill 文件本身是以 Markdown（含可选 YAML frontmatter）编写的能力规范。
 *   列表行只承载名称与一行简介，点击条目时在二级模态窗口中按双视图呈现：
 *   1. 「优雅预览」剥离顶层 frontmatter 元数据单独排版，正文复用全站唯一的
 *      `MarkdownBlock`（自带代码高亮与一键复制）；
 *   2. 「原始源码」保留未经解析的 `SKILL.md` 原文（含 frontmatter），方便审校与复制。
 *
 * 【约束与规则 (Rules)】
 *   1. 使用 `Dialog` 原语 + `portal={false}` + `max-h-modal-md` + `shrink-0` 滚动保护；
 *   2. 异步 inspect 内建自增序列令牌与 `try/catch/finally`，切技能或重试绝不串台或卡死；
 *   3. 所有文案走 `t()`，严禁硬编码实体称谓与原生调色板类名。
 */

export type { SkillMarkdownViewMode };

export interface SkillDetailDialogProps {
  skillName: string | null;
  targetProfile: string;
  fallbackDescription?: string;
  uses?: number;
  date?: string;
  relatedSkills?: ReadonlyArray<{ id: string; label: string; uses: number }>;
  onSelectRelatedSkill?: (id: string) => void;
  onClose: () => void;
  onInspectSkill?: SettingsActions['onInspectSkill'];
  onCopy?: SettingsActions['onCopy'];
  onNotify?: SettingsActions['onNotify'];
}

export function SkillDetailDialog({
  skillName,
  targetProfile,
  fallbackDescription,
  uses,
  date,
  relatedSkills,
  onSelectRelatedSkill,
  onClose,
  onInspectSkill,
  onCopy,
  onNotify,
}: SkillDetailDialogProps): React.ReactElement | null {
  const [viewMode, setViewMode] = React.useState<SkillMarkdownViewMode>('rendered');
  const [state, setState] = React.useState<{
    loading: boolean;
    data?: SkillInspectView;
    error?: string;
  }>({ loading: false });
  const seqRef = React.useRef(0);

  const loadSkill = React.useCallback(async () => {
    if (!skillName || !onInspectSkill) return;
    const seq = ++seqRef.current;
    setState({ loading: true });
    try {
      const result = await onInspectSkill(targetProfile, skillName, fallbackDescription);
      if (seq !== seqRef.current) return;
      if (!result.ok || !result.data) {
        setState({ loading: false, error: result.message || t('settings.loadFailed') });
        return;
      }
      setState({ loading: false, data: result.data });
    } catch (error) {
      if (seq !== seqRef.current) return;
      setState({
        loading: false,
        error: error instanceof Error && error.message ? error.message : t('settings.loadFailed'),
      });
    }
  }, [skillName, targetProfile, fallbackDescription, onInspectSkill]);

  React.useEffect(() => {
    if (!skillName) {
      seqRef.current += 1;
      setState({ loading: false });
      return;
    }
    setViewMode('rendered');
    void loadSkill();
  }, [skillName, loadSkill]);

  const data = state.data;
  const markdown = data?.markdown ?? '';

  if (!skillName) return null;

  const description = data?.description || fallbackDescription || '';

  const handleCopyMarkdown = async (): Promise<void> => {
    if (!markdown || !onCopy) return;
    const ok = await onCopy(markdown);
    if (ok) onNotify?.(t('bot.copied'));
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent
        portal={false}
        data-skill-detail-dialog="true"
        className="flex h-modal-xl max-h-modal-xl w-modal-xl max-w-none flex-col gap-0 overflow-hidden rounded-window p-0"
      >
        <div className="flex shrink-0 items-start justify-between gap-4 px-5 pb-2 pt-5">
          <div className="flex min-w-0 flex-1 items-start gap-3">
            <span
              aria-hidden="true"
              className="mt-1 flex size-8 shrink-0 items-center justify-center rounded-card surface-raised text-muted-foreground"
            >
              <BookOpen aria-hidden="true" className="size-4" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <DialogTitle className="truncate text-section font-semibold text-foreground">
                  {data?.name || skillName}
                </DialogTitle>
                {typeof uses === 'number' ? (
                  <Badge variant="secondary">{t('mobile.memory.usesCount', { count: uses })}</Badge>
                ) : null}
                {date ? <Badge variant="secondary">{date}</Badge> : null}
                {data?.source ? (
                  <Badge variant="secondary">{`${t('bot.skillMetaSource')}: ${data.source}`}</Badge>
                ) : null}
                {data?.category ? <Badge variant="secondary">{data.category}</Badge> : null}
                {data?.isPreview ? <Badge variant="secondary">{t('bot.skillInspectPreviewBadge')}</Badge> : null}
                {data?.tags?.map((tag) => (
                  <Badge key={tag} variant="secondary">
                    {tag}
                  </Badge>
                ))}
              </div>
              <DialogDescription className="mt-1 text-caption text-muted-foreground">
                {description || skillName}
              </DialogDescription>
              {relatedSkills && relatedSkills.length > 0 && onSelectRelatedSkill ? (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <span className="text-caption text-muted-foreground">{t('mobile.memory.relatedSkillsTitle')}</span>
                  {relatedSkills.map((rel) => (
                    <Button
                      key={rel.id}
                      type="button"
                      variant="outline"
                      size="xs"
                      onClick={() => onSelectRelatedSkill(rel.id)}
                    >
                      <span>{rel.label}</span>
                      {rel.uses > 0 ? <span className="font-code text-muted-foreground">{`x${rel.uses}`}</span> : null}
                    </Button>
                  ))}
                </div>
              ) : null}
            </div>
          </div>

          <Tooltip content={t('settings.close')} placement="bottom">
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={t('settings.close')}
              onClick={onClose}
              className="shrink-0"
            >
              <X aria-hidden="true" className="size-4" />
            </Button>
          </Tooltip>
        </div>

        <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 px-5 py-2">
          <SegmentedControl
            value={viewMode}
            options={[
              { value: 'rendered', label: t('bot.skillViewRendered') },
              { value: 'raw', label: t('bot.skillViewRaw') },
            ]}
            ariaLabel={t('bot.skillViewModeAria')}
            onChange={setViewMode}
          />
          {onCopy ? (
            <Button
              type="button"
              variant="outline"
              size="xs"
              disabled={!markdown || state.loading}
              onClick={() => {
                void handleCopyMarkdown();
              }}
              className="shrink-0"
            >
              <Copy aria-hidden="true" className="size-3" />
              <span>{t('bot.skillCopyMarkdown')}</span>
            </Button>
          ) : null}
        </div>

        <div
          data-skill-detail-scroll="true"
          className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-5 py-4"
        >
          {state.loading ? (
            <div className="flex flex-col gap-3" role="status" aria-label={t('bot.skillInspectLoading')}>
              <Skeleton className="h-5 w-48" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-5/6" />
              <Skeleton className="h-24 w-full" />
              <p className="text-caption text-muted-foreground">{t('bot.skillInspectLoading')}</p>
            </div>
          ) : state.error ? (
            <div
              role="alert"
              className="flex flex-wrap items-center justify-between gap-3 rounded-panel surface-raised px-4 py-3 text-caption text-destructive"
            >
              <span>{state.error}</span>
              <Button
                type="button"
                variant="outline"
                size="xs"
                onClick={() => {
                  void loadSkill();
                }}
                className="shrink-0"
              >
                <RotateCcw aria-hidden="true" className="size-3" />
                <span>{t('bot.retry')}</span>
              </Button>
            </div>
          ) : !markdown ? (
            <p className="rounded-panel surface-raised px-4 py-6 text-center text-caption text-muted-foreground">
              {t('bot.skillInspectEmpty')}
            </p>
          ) : (
            <SkillMarkdownView markdown={markdown} viewMode={viewMode} />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
