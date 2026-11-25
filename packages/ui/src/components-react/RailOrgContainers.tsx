/**
 * 左轨共享会话组织原语：项目/文件夹容器折叠节、hover「完成/恢复」胶囊与底部「已完成」抽屉
 *
 * 【设计意图 (Why)】
 *   让经典双轨 (`LeftRail.tsx`) 与单栏分组 (`GroupedLeftRail.tsx`) 共用同一套扁平顶级容器折叠渲染、
 *   hover「✓ 完成 / ↺ 恢复」动作胶囊及底部停靠「已完成」抽屉，杜绝双份同构样式与逻辑分叉。
 *
 * 【防范的历史坑 (Pitfall)】
 *   1. `<button>` 内部禁止嵌套第二个 `<button>`：容器标题行的折叠触发按钮与右侧 hover `+` 按钮
 *      必须作为同一容器下的兄弟元素排版，否则 React SSR 与浏览器水合将产生 DOM 结构错误；
 *   2. 严格遵守 4px 整数网格类名（禁止 `py-0.5`、`gap-1.5` 与任意值 `[...]`），自定义高度上限收口至 CSS；
 *   3. 容器标题严禁渲染计数数字角标，Bot 终身主工位严禁传入 `hoverAction`。
 *
 * 【约束与规则 (Rules)】
 *   - `DONE` 抽屉默认折叠（`expanded === false`），搜索命中时由视图模型自动设为 `effectiveExpanded`；
 *   - 「完成」按钮点击仅派发二次确认弹窗触发器，绝不直接调用归档接口。
 */

import * as React from 'react';
import { ChevronRight, Plus } from 'lucide-react';
import type { FolderColorToken } from '@hermes-flux/core';
import { t } from '../i18n/index.js';
import { Button } from './primitives/Button.js';
import { Tooltip } from './primitives/Tooltip.js';
import type { RailRowHoverAction } from './RailEntityRow.js';

/**
 * 构造行内右侧 hover「✓ 完成」/「↺ 恢复」极简哑光胶囊配置；缺省回调时返回 undefined。
 */
export function buildDoneHoverAction(params: {
  isDone: boolean;
  title: string;
  onRequestMarkDone?: () => void;
  onRestoreDone?: () => void;
}): RailRowHoverAction | undefined {
  if (params.isDone) {
    if (!params.onRestoreDone) return undefined;
    return {
      label: t('rail.restoreShort'),
      icon: 'restore',
      ariaLabel: t('rail.restoreAria', { name: params.title }),
      onAction: params.onRestoreDone,
    };
  }
  if (!params.onRequestMarkDone) return undefined;
  return {
    label: t('rail.markDoneShort'),
    icon: 'done',
    ariaLabel: t('rail.markDoneAria', { name: params.title }),
    onAction: params.onRequestMarkDone,
  };
}

export interface RailOrgContainerSectionProps {
  kind: 'project' | 'folder';
  id: string;
  containerId: string;
  name: string;
  color?: FolderColorToken;
  expanded: boolean;
  isSearching: boolean;
  isEmpty: boolean;
  onToggle?: () => void;
  onNewChat?: () => void;
  onOpenFolderMenu?: (x: number, y: number) => void;
  children: React.ReactNode;
}

/** 扁平顶级网关项目 / 自定义文件夹可折叠分节。 */
export function RailOrgContainerSection({
  kind,
  id,
  containerId,
  name,
  expanded,
  isSearching,
  isEmpty,
  onToggle,
  onNewChat,
  onOpenFolderMenu,
  children,
}: RailOrgContainerSectionProps): React.ReactElement {
  const safeDomSuffix = containerId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const listId = `rail-container-list-${safeDomSuffix}`;

  return (
    <section
      className="flux-grouped-section mb-2"
      data-container-id={containerId}
      data-container-kind={kind}
      data-folder-id={kind === 'folder' ? id : undefined}
      data-expanded={expanded ? 'true' : 'false'}
    >
      <div
        className="group flex min-h-8 w-full items-center gap-1 rounded-card px-2 py-1 text-aux font-medium text-muted-foreground transition-colors hover:bg-card-hover hover:text-foreground"
        onContextMenu={(event) => {
          if (kind !== 'folder' || !onOpenFolderMenu) return;
          event.preventDefault();
          event.stopPropagation();
          onOpenFolderMenu(event.clientX, event.clientY);
        }}
      >
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={listId}
          aria-label={`${name} ${expanded ? t('rail.collapseSection') : t('rail.expandSection')}`}
          onClick={onToggle}
          className="flex min-h-7 min-w-0 flex-1 items-center gap-2 text-left"
        >
          <ChevronRight
            size={14}
            aria-hidden="true"
            className="flux-grouped-section__chevron shrink-0 text-muted-foreground"
          />
          <span className="truncate">{name}</span>
        </button>

        {onNewChat ? (
          <Tooltip content={t('rail.newChatInContainer', { name })} placement="top">
            <button
              type="button"
              data-testid={`rail-container-add-${containerId}`}
              aria-label={t('rail.newChatInContainer', { name })}
              onClick={(event) => {
                event.stopPropagation();
                onNewChat();
              }}
              className="relative flex size-6 shrink-0 items-center justify-center rounded-card text-muted-foreground opacity-0 transition-opacity hover:bg-card-active hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 after:absolute after:-inset-1 after:content-['']"
            >
              <Plus size={12} strokeWidth={2} aria-hidden="true" />
            </button>
          </Tooltip>
        ) : null}
      </div>

      <div
        id={listId}
        aria-hidden={!expanded || undefined}
        className="flux-grouped-section__body"
        data-expanded={expanded ? 'true' : 'false'}
      >
        <div className="flux-grouped-section__body-inner">
          <div className="flex flex-col gap-1 pt-1">
            {isEmpty && kind === 'folder' && !isSearching ? (
              <div className="px-3 py-1 text-caption text-muted-foreground">
                {t('rail.emptyFolderHint')}
              </div>
            ) : (
              children
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

export interface RailDoneFooterSectionProps {
  expanded: boolean;
  loading: boolean;
  error: string;
  isEmpty: boolean;
  className?: string;
  onToggle?: () => void;
  onRetry?: () => void;
  children: React.ReactNode;
}

/** 左轨底部固定「已完成」抽屉（无计数字、默认折叠、1px 发丝线隔离）。 */
export function RailDoneFooterSection({
  expanded,
  loading,
  error,
  isEmpty,
  className,
  onToggle,
  onRetry,
  children,
}: RailDoneFooterSectionProps): React.ReactElement {
  return (
    <section
      className={`flux-grouped-section flux-rail-done-footer shrink-0 border-t border-border-subtle bg-sidebar px-2 py-1${className ? ` ${className}` : ''}`}
      data-section="done"
      data-expanded={expanded ? 'true' : 'false'}
    >
      <button
        type="button"
        id="rail-done-accordion-trigger"
        data-testid="rail-done-toggle"
        aria-expanded={expanded}
        aria-controls="rail-done-nested-list"
        onClick={onToggle}
        className="flex min-h-8 w-full shrink-0 items-center gap-2 rounded-card px-2 py-1 text-left text-aux font-medium text-muted-foreground transition-colors hover:bg-card-hover hover:text-foreground"
      >
        <ChevronRight
          size={14}
          aria-hidden="true"
          className="flux-grouped-section__chevron shrink-0 text-muted-foreground"
        />
        <span className="truncate">{t('rail.done')}</span>
      </button>

      <div
        id="rail-done-nested-list"
        aria-hidden={!expanded || undefined}
        className="flux-grouped-section__body"
        data-expanded={expanded ? 'true' : 'false'}
      >
        <div className="flux-grouped-section__body-inner">
          <div className="flux-rail-done-footer__scroll scrollbar-thin flex flex-col gap-1 py-1">
            {loading ? (
              <div className="px-2 py-2 text-caption text-muted-foreground">{t('rail.doneLoading')}</div>
            ) : error ? (
              <div role="alert" className="mx-1 flex flex-col gap-2 rounded-card border border-border-strong bg-panel p-2 text-caption text-foreground">
                <span>{error}</span>
                {onRetry ? (
                  <Button
                    size="xs"
                    variant="secondary"
                    data-testid="rail-done-retry"
                    onClick={onRetry}
                  >
                    {t('rail.doneRetry')}
                  </Button>
                ) : null}
              </div>
            ) : isEmpty ? (
              <div className="px-2 py-2 text-caption text-muted-foreground">{t('rail.doneEmpty')}</div>
            ) : (
              children
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
