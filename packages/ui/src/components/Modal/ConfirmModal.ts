/**
 * Hermes Flux 二次确认对话框组件 (ConfirmModal)
 *
 * 【设计意图 (Why)】
 * 彻底废除浏览器与操作系统原生的同步阻塞式 `window.confirm()`。
 * 保持对话框在纯 DOM 树中渲染，既与全局纯哑光极客美学完全融合，
 * 又从物理层面杜绝了 Win32 原生模态框导致的 Chromium 宿主窗口脱敏与光标静默抑制。
 *
 * 【防范的历史坑 (Pitfall)】
 * 1. 规避原生 confirm 弹窗关闭后 Windows 窗口焦点丢失至虚空、Blink Caret 停振；
 * 2. 主确认/取消操作按钮热区严格保持 >= 44px/44pt，右上角关闭图标按钮 >= 32px（满足桌面端 28px 下限）；
 * 3. 必须支持快捷键 Esc 取消与 Enter 确认，绑定 `aria-labelledby` / `aria-describedby` 无障碍语义，并废除 `!important` 与 `brightness(1.08)` 对浅色对比度的破坏。
 *
 * 【约束与规则 (Rules)】
 * - 纯 UI 表现层标准模板，零平台私有调用；
 * - 样式完全使用主题 Tokens（`--destructive` / `--primary`），零硬编码色值。
 */

import { t } from '../../i18n/index.js';
import { escapeHtml } from '../../utils/html.js';

export interface ConfirmModalProps {
  isOpen: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  isDanger?: boolean;
}

export function renderConfirmModal(props?: ConfirmModalProps): string {
  if (!props || !props.isOpen) return '';

  const safeTitle = escapeHtml(props.title || t('common.confirm'));
  const safeMessage = escapeHtml(props.message || '');
  const confirmText = escapeHtml(props.confirmLabel || (props.isDanger ? t('ctx.delete') : t('common.confirm')));
  const cancelText = escapeHtml(props.cancelLabel || t('common.cancel'));

  return `
    <div id="flux-confirm-modal-overlay" role="presentation" style="
      position: fixed;
      inset: 0;
      pointer-events: auto;
      background: var(--backdrop);
      z-index: 2500;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 16px;
      animation: flux-fade-in var(--duration-enter) cubic-bezier(0.16, 1, 0.3, 1);
    ">
      <div id="flux-confirm-modal-card" role="dialog" aria-modal="true" aria-labelledby="flux-confirm-modal-title" aria-describedby="flux-confirm-modal-desc" style="
        width: 100%;
        max-width: 420px;
        background: var(--popover);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-window);
        box-shadow: var(--shadow-window);
        overflow: hidden;
        display: flex;
        flex-direction: column;
        user-select: none;
      ">
        <!-- Header (pure matte, zero slice border) -->
        <div style="
          padding: 20px 24px 0;
          display: flex;
          align-items: center;
          justify-content: space-between;
        ">
          <div id="flux-confirm-modal-title" style="font-size: var(--fs-section); font-weight: 600; color: var(--foreground); display: flex; align-items: center; gap: 8px;">
            ${
              props.isDanger
                ? `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color: var(--destructive);"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`
                : `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color: var(--primary);"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`
            }
            <span>${safeTitle}</span>
          </div>
          <button id="btn-confirm-modal-close" class="flux-confirm-close" type="button" aria-label="${cancelText}" style="
            border: none;
            cursor: pointer;
            width: 32px;
            height: 32px;
            display: flex;
            align-items: center;
            justify-content: center;
            border-radius: var(--radius-card);
          ">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
          </button>
        </div>

        <!-- Body Message -->
        <div id="flux-confirm-modal-desc" style="padding: 12px 24px 20px; font-size: var(--fs-body); line-height: 1.6; color: var(--secondary-foreground); word-break: break-word;">
          ${safeMessage}
        </div>

        <!-- Footer Actions (Flat Tinted confirmation matching Button.tsx) -->
        <div style="
          padding: 0 24px 20px;
          display: flex;
          align-items: center;
          justify-content: flex-end;
          gap: 8px;
        ">
          <button id="btn-confirm-modal-cancel" class="flux-confirm-cancel" type="button" style="
            padding: 0 16px;
            min-height: 44px;
            border: 1px solid transparent;
            border-radius: var(--radius-card);
            font-size: var(--fs-aux);
            font-weight: 500;
            cursor: pointer;
          ">${cancelText}</button>
          <button id="btn-confirm-modal-ok" class="flux-confirm-ok${props.isDanger ? ' flux-confirm-ok--danger' : ''}" type="button" style="
            padding: 0 16px;
            min-height: 44px;
            border-radius: var(--radius-card);
            font-size: var(--fs-aux);
            font-weight: 600;
            cursor: pointer;
          ">${confirmText}</button>
        </div>
      </div>
    </div>
  `;
}
