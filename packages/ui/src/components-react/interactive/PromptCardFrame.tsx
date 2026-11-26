/**
 * 输入舱上方可折叠停靠卡片外壳 (PromptCardFrame)
 *
 * 【设计意图 (Why)】
 *   所有阻塞式人机交互请求统一收敛为贴合输入舱上方的纯哑光停靠卡，彻底摒弃打断视线的居中弹窗
 *   与全屏 Bottom Sheet。折叠态保留标题与等待队列计数条，展开态呈现可滚动主体与吸底操作区；
 *   折叠仅隐藏主体（不卸载子组件），确保用户滚动查阅历史时手写答案或环境变量草稿不丢失。
 *
 * 【约束与规则 (Rules)】
 *   - 支持 `'desktop-dock' | 'mobile-dock'` 双形态；
 *   - 滚动内容区强制标记 `m-no-swipe` 与 `data-gesture-ignore="pan-x"`，防止触发移动端三屏横滑；
 *   - 严格使用语义 Design Tokens 与 `.flux-interact__*` 样式类，零硬编码色相与 infinite 动画。
 */

import * as React from 'react';
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  HelpCircle,
  KeyRound,
  Plug,
  ShieldAlert,
} from 'lucide-react';
import type { InteractivePrompt } from '@hermes-flux/core';
import { t } from '../../i18n/index.js';
import { Badge } from '../primitives/Badge.js';
import { Button } from '../primitives/Button.js';
import { Tooltip } from '../primitives/Tooltip.js';
import { resolvePromptHeaderInfo } from './interactiveModel.js';

export type DockSurfaceMode = 'desktop-dock' | 'mobile-dock';

export interface PromptCardFrameProps {
  surface: DockSurfaceMode;
  prompt: InteractivePrompt;
  queueIndex: number;
  queueLength: number;
  collapsed: boolean;
  headerSubtitle?: string;
  headerExtra?: React.ReactNode;
  errorMessage?: string | null;
  actions: React.ReactNode;
  children: React.ReactNode;
  onToggleCollapse: () => void;
  onSelectQueueIndex?: (idx: number) => void;
}

/** 单体等宽命令/启动预览框。 */
export function CodePreviewBox({
  label,
  ariaLabel,
  code,
}: {
  label?: string;
  ariaLabel?: string;
  code: string;
}): React.ReactElement {
  return (
    <div className="flux-interact__code-box">
      {label ? <div className="flux-interact__field-label">{label}</div> : null}
      <pre className="flux-interact__code-pre" aria-label={ariaLabel || label}>
        {code}
      </pre>
    </div>
  );
}

function PromptKindIcon({ prompt }: { prompt: InteractivePrompt }): React.ReactElement {
  switch (prompt.kind) {
    case 'clarify':
      return <HelpCircle size={14} className="shrink-0 text-warning" aria-hidden="true" />;
    case 'credential':
      return <KeyRound size={14} className="shrink-0 text-warning" aria-hidden="true" />;
    case 'connection':
      return <Plug size={14} className="shrink-0 text-primary" aria-hidden="true" />;
    default:
      return <ShieldAlert size={14} className="shrink-0 text-warning" aria-hidden="true" />;
  }
}

export function PromptCardFrame({
  surface,
  prompt,
  queueIndex,
  queueLength,
  collapsed,
  headerSubtitle,
  headerExtra,
  errorMessage,
  actions,
  children,
  onToggleCollapse,
  onSelectQueueIndex,
}: PromptCardFrameProps): React.ReactElement {
  const { title, subtitle } = resolvePromptHeaderInfo(prompt, t);
  const canStepPrev = queueLength > 1 && queueIndex > 0;
  const canStepNext = queueLength > 1 && queueIndex + 1 < queueLength;

  if (collapsed) {
    return (
      <section
        className="flux-interact__card m-no-swipe"
        data-surface={surface}
        data-collapsed="true"
        data-prompt-kind={prompt.kind}
        data-gesture-ignore="pan-x"
        data-testid="interactive-prompt-card"
        aria-label={title}
      >
        <div className="flux-interact__collapsed-bar">
          <button
            type="button"
            className="flux-interact__collapsed-trigger"
            aria-expanded="false"
            data-testid="interactive-card-expand"
            onClick={onToggleCollapse}
          >
            <PromptKindIcon prompt={prompt} />
            <span className="flux-interact__collapsed-title">
              {t('interactive.collapsedSummary', { title: subtitle ? `${title} · ${subtitle}` : title })}
            </span>
          </button>
          <div className="flex shrink-0 items-center gap-1">
            {queueLength > 1 ? (
              <Badge variant="outline">
                {t('interactive.queueCounter', {
                  current: String(queueIndex + 1),
                  total: String(queueLength),
                })}
              </Badge>
            ) : null}
            <Tooltip content={t('interactive.expandCard')} placement="top" disabled={surface === 'mobile-dock'}>
              <Button
                type="button"
                variant="ghost"
                size={surface === 'mobile-dock' ? 'icon-sm' : 'icon-xs'}
                className={surface === 'mobile-dock' ? 'flux-interact__icon-btn m-interact__btn' : 'flux-interact__icon-btn'}
                aria-expanded="false"
                aria-label={t('interactive.expandCard')}
                onClick={onToggleCollapse}
              >
                <ChevronUp size={14} aria-hidden="true" />
              </Button>
            </Tooltip>
          </div>
        </div>
        {/* 保留内部草稿节点挂起隐藏，防止折叠浏览历史时丢失草稿 */}
        <div className="flux-interact__hidden-draft" hidden aria-hidden="true">
          {children}
        </div>
      </section>
    );
  }

  return (
    <section
      className="flux-interact__card m-no-swipe"
      data-surface={surface}
      data-collapsed="false"
      data-prompt-kind={prompt.kind}
      data-gesture-ignore="pan-x"
      data-testid="interactive-prompt-card"
      aria-label={title}
    >
      <header className="flux-interact__header">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <PromptKindIcon prompt={prompt} />
          <span className="flux-interact__title">{title}</span>
          {headerSubtitle ? <span className="flux-interact__subtitle">{headerSubtitle}</span> : null}
          {headerExtra}
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {queueLength > 1 ? (
            <div className="flux-interact__stepper">
              <Tooltip content={t('interactive.prevPrompt')} placement="top" disabled={surface === 'mobile-dock'}>
                <Button
                  type="button"
                  variant="ghost"
                  size={surface === 'mobile-dock' ? 'icon-sm' : 'icon-xs'}
                  className={surface === 'mobile-dock' ? 'flux-interact__icon-btn m-interact__btn' : 'flux-interact__icon-btn'}
                  disabled={!canStepPrev}
                  aria-label={t('interactive.prevPrompt')}
                  onClick={() => onSelectQueueIndex?.(Math.max(0, queueIndex - 1))}
                >
                  <ChevronLeft size={14} aria-hidden="true" />
                </Button>
              </Tooltip>
              <Badge variant="outline">
                {t('interactive.queueCounter', {
                  current: String(queueIndex + 1),
                  total: String(queueLength),
                })}
              </Badge>
              <Tooltip content={t('interactive.nextPrompt')} placement="top" disabled={surface === 'mobile-dock'}>
                <Button
                  type="button"
                  variant="ghost"
                  size={surface === 'mobile-dock' ? 'icon-sm' : 'icon-xs'}
                  className={surface === 'mobile-dock' ? 'flux-interact__icon-btn m-interact__btn' : 'flux-interact__icon-btn'}
                  disabled={!canStepNext}
                  aria-label={t('interactive.nextPrompt')}
                  onClick={() => onSelectQueueIndex?.(Math.min(queueLength - 1, queueIndex + 1))}
                >
                  <ChevronRight size={14} aria-hidden="true" />
                </Button>
              </Tooltip>
            </div>
          ) : null}

          <Tooltip content={t('interactive.collapseCard')} placement="top" disabled={surface === 'mobile-dock'}>
            <Button
              type="button"
              variant="ghost"
              size={surface === 'mobile-dock' ? 'icon-sm' : 'icon-xs'}
              className={surface === 'mobile-dock' ? 'flux-interact__icon-btn m-interact__btn' : 'flux-interact__icon-btn'}
              aria-expanded="true"
              aria-label={t('interactive.collapseCard')}
              data-testid="interactive-card-collapse"
              onClick={onToggleCollapse}
            >
              <ChevronDown size={14} aria-hidden="true" />
            </Button>
          </Tooltip>
        </div>
      </header>

      <div className="flux-interact__body m-no-swipe" data-gesture-ignore="pan-x">
        {children}
      </div>

      {errorMessage ? (
        <div className="flux-interact__error" role="alert" data-testid="interactive-card-error">
          {errorMessage}
        </div>
      ) : null}

      <footer className="flux-interact__footer">{actions}</footer>
    </section>
  );
}
