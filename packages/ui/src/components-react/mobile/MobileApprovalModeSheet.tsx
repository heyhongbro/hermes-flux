/**
 * 移动端会话审批模式选择器 (MobileApprovalModeSheet)
 *
 * 【设计意图 (Why)】
 *   与桌面 InputDock 审批开关保持同一三态（manual / smart / off），采用轻量纯哑光选项列表卡片，
 *   挂载于 `.m-shell` 根部避免横滑 `transform` 包含块裁切。仅在 Bot/普通会话中露出，群聊隐藏。
 */

import * as React from 'react';
import { Check, Shield, X } from 'lucide-react';
import { t, type I18nKey } from '../../i18n/index.js';

export type MobileApprovalMode = 'manual' | 'smart' | 'off';

export interface MobileApprovalModeSheetProps {
  open: boolean;
  approvalMode: MobileApprovalMode;
  onSelectApprovalMode: (mode: MobileApprovalMode) => void;
  onClose: () => void;
}

const APPROVAL_OPTIONS: ReadonlyArray<{
  mode: MobileApprovalMode;
  labelKey: I18nKey;
  hintKey: I18nKey;
}> = [
  { mode: 'manual', labelKey: 'dock.approvalManual', hintKey: 'dock.approvalManualHint' },
  { mode: 'smart', labelKey: 'dock.approvalSmart', hintKey: 'dock.approvalSmartHint' },
  { mode: 'off', labelKey: 'dock.approvalOff', hintKey: 'dock.approvalOffHint' },
];

export function MobileApprovalModeSheet({
  open,
  approvalMode,
  onSelectApprovalMode,
  onClose,
}: MobileApprovalModeSheetProps): React.ReactElement | null {
  if (!open) return null;

  return (
    <div
      className="m-sheet-backdrop"
      data-sheet-kind="approval"
      data-testid="mobile-approval-picker-sheet"
      role="dialog"
      aria-modal="true"
      aria-label={t('dock.approval')}
      onClick={onClose}
    >
      <div className="m-bottom-sheet m-no-swipe" onClick={(e) => e.stopPropagation()}>
        <div className="m-sheet-handle" aria-hidden="true" />
        <div className="m-sheet-header">
          <span className="m-sheet-title inline-flex items-center gap-2">
            <Shield size={16} className="shrink-0 text-muted-foreground" aria-hidden="true" />
            <span>{t('dock.approval')}</span>
          </span>
          <button
            type="button"
            className="m-icon-btn"
            onClick={onClose}
            aria-label={t('mobile.common.close')}
          >
            <X size={18} />
          </button>
        </div>

        <div className="m-sheet-list">
          {APPROVAL_OPTIONS.map((opt) => {
            const active = approvalMode === opt.mode;
            return (
              <button
                key={opt.mode}
                type="button"
                className="m-sheet-option"
                data-approval-mode={opt.mode}
                data-active={active ? 'true' : 'false'}
                onClick={() => {
                  onSelectApprovalMode(opt.mode);
                  onClose();
                }}
              >
                <span className="m-sheet-option__main">
                  <span className="m-sheet-option__title">{t(opt.labelKey)}</span>
                  <span className="m-sheet-option__meta">{t(opt.hintKey)}</span>
                </span>
                {active ? <Check size={16} className="m-sheet-option__check" /> : null}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
