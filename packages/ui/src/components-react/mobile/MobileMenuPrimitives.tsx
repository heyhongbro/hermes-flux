/**
 * 移动端共享分组列表菜单与顶部悬浮导航原语 (MobileMenuPrimitives)
 *
 * 【设计意图 (Why)】
 *   严格遵守 UI 高度抽象与组件复用铁律：设置页分组菜单、Bot Hub 能力分组菜单、
 *   以及设置子页 / Bot 子页 / 检查舱阅读器的顶部悬浮返回栏共享同一套无胶水结构，
 *   避免多处重复拼装行距、圆角、阴影、Chevron 与 44pt 触控热区。
 *
 * 【防范的历史坑 (Pitfall)】
 *   1. `shouldCommit` 竞态令牌缺失时，快速切换 Bot 后迟到的 MCP 探活结果会覆盖新 Bot 的状态；
 *   2. 悬浮保存条若使用 `position: fixed` 置于 `transform` 祖先内或 `z-index >= 50`，会被裁切或压住弹窗。
 *
 * 【约束与规则 (Rules)】
 *   - 全部使用语义 CSS 类名与 Design Tokens，零硬编码色相、零内联魔法颜色；
 *   - 所有交互按钮与菜单行热区高度严格 `>= 44px`。
 */

import * as React from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { McpTestResultView } from '@hermes-flux/core';
import { t } from '../../i18n/index.js';

export interface MobileMenuGroupProps {
  title?: string;
  children: React.ReactNode;
}

export function MobileMenuGroup({ title, children }: MobileMenuGroupProps): React.ReactElement {
  return (
    <section className="m-menu-group">
      {title ? <h2 className="m-menu-group__title">{title}</h2> : null}
      {children}
    </section>
  );
}

export interface MobileMenuCardProps {
  children: React.ReactNode;
  className?: string;
}

export function MobileMenuCard({ children, className }: MobileMenuCardProps): React.ReactElement {
  return <div className={className ? `m-menu-card ${className}` : 'm-menu-card'}>{children}</div>;
}

export interface MobileMenuRowProps {
  icon: React.ReactNode;
  title: string;
  summary?: string;
  badge?: string;
  onClick: () => void;
  testId?: string;
  disabled?: boolean;
}

export function MobileMenuRow({
  icon,
  title,
  summary,
  badge,
  onClick,
  testId,
  disabled = false,
}: MobileMenuRowProps): React.ReactElement {
  return (
    <button
      type="button"
      className="m-menu-row"
      data-testid={testId}
      disabled={disabled}
      onClick={onClick}
    >
      <span className="m-menu-row__icon" aria-hidden="true">
        {icon}
      </span>
      <span className="m-menu-row__title">{title}</span>
      {badge ? <span className="m-menu-row__badge">{badge}</span> : null}
      {summary ? <span className="m-menu-row__summary">{summary}</span> : null}
      <ChevronRight size={16} className="m-menu-row__chevron" aria-hidden="true" />
    </button>
  );
}

export interface MobileFloatingBackBarProps {
  title?: string;
  onBack: () => void;
  backAriaLabel: string;
  backTestId?: string;
  rightAction?: React.ReactNode;
}

export function MobileFloatingBackBar({
  title,
  onBack,
  backAriaLabel,
  backTestId,
  rightAction,
}: MobileFloatingBackBarProps): React.ReactElement {
  return (
    <header className="m-float-back-bar m-no-swipe">
      <button
        type="button"
        className="m-float-circle-btn m-float-back-btn"
        data-testid={backTestId}
        aria-label={backAriaLabel}
        onClick={onBack}
      >
        <ChevronLeft size={20} strokeWidth={2} />
      </button>
      {title ? <div className="m-float-back-bar__title">{title}</div> : <span className="m-float-back-bar__spacer" />}
      {rightAction ? <div className="m-float-back-bar__right">{rightAction}</div> : <span className="m-float-back-bar__spacer-end" />}
    </header>
  );
}

export interface MobileBotSaveBarProps {
  dirty: boolean;
  saving: boolean;
  onReset: () => void;
  onSave: () => void;
  testId?: string;
}

export function MobileBotSaveBar({
  dirty,
  saving,
  onReset,
  onSave,
  testId,
}: MobileBotSaveBarProps): React.ReactElement | null {
  if (!dirty && !saving) return null;
  return (
    <div className="m-bot-save-bar" role="status" data-testid={testId}>
      <span className="m-bot-save-bar__notice">{t('bot.draftNotice')}</span>
      <div className="m-bot-save-bar__actions">
        <button
          type="button"
          className="m-bot-save-bar__reset"
          disabled={saving}
          onClick={onReset}
        >
          {t('bot.resetBtn')}
        </button>
        <button
          type="button"
          className="m-bot-save-bar__submit"
          disabled={!dirty || saving}
          onClick={onSave}
        >
          {saving ? t('bot.saving') : t('bot.saveBtn')}
        </button>
      </div>
    </div>
  );
}

export interface RunMobileMcpTestOptions {
  targetProfile: string;
  serverName: string;
  busy: boolean;
  testServer?: (profile: string, name: string) => Promise<McpTestResultView>;
  notify: (message: string) => void;
  setTesting: (name: string | null) => void;
  shouldCommit?: () => boolean;
  onResult?: (result: McpTestResultView) => void;
}

/**
 * 共享 MCP 探测动作：统一 Settings 扩展子页与 Bot Hub MCP 子页的探活提示、状态回写与异常兜底。
 */
export async function runMobileMcpTest(opts: RunMobileMcpTestOptions): Promise<void> {
  if (!opts.targetProfile || !opts.testServer || opts.busy) return;
  const commit = opts.shouldCommit ?? (() => true);
  opts.setTesting(opts.serverName);
  opts.notify(t('bot.mcpTesting', { name: opts.serverName }));
  try {
    const result = await opts.testServer(opts.targetProfile, opts.serverName);
    if (!commit()) return;
    opts.onResult?.(result);
    if (result.oauthNeeded) {
      opts.notify(t('bot.mcpTestOauthNeeded', { name: opts.serverName }));
    } else if (result.ok) {
      opts.notify(t('bot.mcpTestOk', { name: opts.serverName, count: result.tools.length }));
    } else {
      opts.notify(
        t('bot.mcpTestFailed', {
          name: opts.serverName,
          message: result.error || t('settings.loadFailed'),
        }),
      );
    }
  } catch (error) {
    if (!commit()) return;
    opts.notify(
      t('bot.mcpTestFailed', {
        name: opts.serverName,
        message: error instanceof Error ? error.message : String(error),
      }),
    );
  } finally {
    if (commit()) opts.setTesting(null);
  }
}

export interface RunMobileMcpRemoveOptions {
  targetProfile: string;
  serverName: string | null;
  busy: boolean;
  removeServer?: (profile: string, name: string) => Promise<{ ok: boolean; message?: string | null }>;
  notify: (message: string) => void;
  setRemoving: (busy: boolean) => void;
  onRemoved: (serverName: string) => void;
}

/**
 * 共享 MCP 移除动作：统一确认删除回执与失败提示。
 */
export async function runMobileMcpRemove(opts: RunMobileMcpRemoveOptions): Promise<void> {
  if (!opts.targetProfile || !opts.serverName || !opts.removeServer || opts.busy) return;
  const targetName = opts.serverName;
  opts.setRemoving(true);
  try {
    const res = await opts.removeServer(opts.targetProfile, targetName);
    if (res.ok) {
      opts.notify(t('bot.mcpRemoved', { name: targetName }));
      opts.onRemoved(targetName);
    } else {
      opts.notify(t('bot.mcpRemoveFailed', { message: res.message || t('settings.loadFailed') }));
    }
  } catch (error) {
    opts.notify(
      t('bot.mcpRemoveFailed', { message: error instanceof Error ? error.message : String(error) }),
    );
  } finally {
    opts.setRemoving(false);
  }
}
