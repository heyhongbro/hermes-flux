/**
 * 移动端变形输入舱组件 (MobileMorphingComposer) 与顶部逃逸模型选择面板 (MobileModelPickerSheet)
 *
 * 【设计意图 (Why)】
 *   移动竖屏高度宝贵，输入框在静息未展开态收束为 `46px` 单行哑光胶囊（左附件 `+`、中单行输入、
 *   右发送/停止圆钮），最大化首屏对话可视区；点击聚焦或输入内容后平滑伸展为双层哑光输入卡，
 *   下方露出模型选择胶囊 (`[Model ▾]`) 与附件标签栏，兼顾高效率与低误触。
 *
 * 【防范的历史坑 (Pitfall)】
 *   1. `.m-shell__track`（300vw）与 `.m-newchat__track`（200vw）均使用 CSS `transform` 形成新的 `position: fixed` 包含块，
 *      若把 `.m-sheet-backdrop` 直接渲染在输入舱内部，整个底部模型弹窗会被拉宽至 `300vw` 并偏出屏幕视口（左侧选项看不见、右侧关闭按钮在屏外）；
 *      因此 `MobileWorkspaceShell` 传 `externalModelPicker={true}` 并把 `<MobileModelPickerSheet>` 提升挂载到 `.m-shell` 根节点；
 *   2. 触摸屏点击底部工具栏时 `<textarea>` 会先触发 `onBlur`，仅拦截 `onMouseDown` 无法阻断触控失焦；
 *      需同时结合 `onPointerDown` 与 `isExpanded = focused || modelPickerOpen || ...` 防止面板尚未打开工具栏先坍塌。
 *
 * 【约束与规则 (Rules)】
 *   - 纯平哑光，禁止边框荧光、顶部高光线或浮夸投影；
 *   - 所有交互热区 `>= 44px`，全量使用 `t(...)` 字典与语义 Design Tokens。
 */

import * as React from 'react';
import { ArrowUp, Check, ChevronDown, Plus, Shield, Square, X } from 'lucide-react';
import { t, type I18nKey } from '../../i18n/index.js';
import type { InputAttachmentItem } from '../../components/InputDock/InputDock.js';
import { MessageAttachments } from '../conversation/MessageAttachments.js';
import { buildMobileModelPickerItems, resolveShortModelName } from './mobileShellModel.js';
import type { MobileModelOption } from './types.js';

export interface MobileModelPickerSheetProps {
  open: boolean;
  selectedModel: string;
  currentProvider?: string;
  availableModels: string[];
  modelDetails: MobileModelOption[];
  onSelectModel: (model: string, provider?: string) => void;
  onClose: () => void;
  onRefreshModels?: () => void;
}

/**
 * 移动端模型选择底部抽屉：从 `.m-shell` 根部弹出，规避横滑 `transform` 包含块裁切。
 */
export function MobileModelPickerSheet({
  open,
  selectedModel,
  currentProvider,
  availableModels,
  modelDetails,
  onSelectModel,
  onClose,
  onRefreshModels,
}: MobileModelPickerSheetProps): React.ReactElement | null {
  if (!open) return null;
  const items = buildMobileModelPickerItems(
    availableModels,
    modelDetails,
    selectedModel,
    currentProvider,
  );

  return (
    <div
      className="m-sheet-backdrop"
      data-sheet-kind="model"
      data-testid="mobile-model-picker-sheet"
      role="dialog"
      aria-modal="true"
      aria-label={t('mobile.stage.modelPickerTitle')}
      onClick={onClose}
    >
      <div className="m-bottom-sheet m-no-swipe" onClick={(e) => e.stopPropagation()}>
        <div className="m-sheet-handle" aria-hidden="true" />
        <div className="m-sheet-header">
          <span className="m-sheet-title">{t('mobile.stage.modelPickerTitle')}</span>
          <button
            type="button"
            className="m-icon-btn"
            onClick={onClose}
            aria-label={t('mobile.common.close')}
          >
            <X size={18} />
          </button>
        </div>
        {items.length === 0 ? (
          <div className="m-sheet-empty">
            <p>{t('mobile.stage.modelEmpty')}</p>
            {onRefreshModels ? (
              <button type="button" className="m-secondary-btn" onClick={onRefreshModels}>
                {t('bot.retry')}
              </button>
            ) : null}
          </div>
        ) : (
          <div className="m-sheet-list">
            {items.map((item) => (
              <button
                key={item.key}
                type="button"
                className="m-sheet-option"
                data-model-id={item.id}
                data-provider={item.provider || ''}
                data-active={item.active ? 'true' : 'false'}
                disabled={item.unavailable}
                aria-disabled={item.unavailable ? 'true' : 'false'}
                onClick={() => {
                  onSelectModel(item.id, item.provider);
                  onClose();
                }}
              >
                <span className="m-sheet-option__main">
                  <span className="m-sheet-option__title">{item.label}</span>
                  {item.providerLabel ? (
                    <span className="m-sheet-option__meta">{item.providerLabel}</span>
                  ) : null}
                </span>
                {item.unavailable ? (
                  <span className="m-sheet-option__badge">{t('dock.modelLockedBadge')}</span>
                ) : item.active ? (
                  <Check size={16} className="m-sheet-option__check" />
                ) : null}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export interface MobileMorphingComposerProps {
  inputId?: string;
  placeholder: string;
  isStreaming?: boolean;
  disabled?: boolean;
  selectedModel: string;
  currentProvider?: string;
  approvalMode?: 'manual' | 'smart' | 'off';
  hideApprovalMode?: boolean;
  availableModels: string[];
  modelDetails: MobileModelOption[];
  attachments: InputAttachmentItem[];
  onSend: (text: string) => void;
  onStop?: () => void;
  onAttach?: () => void;
  onRemoveAttachment?: (id: string) => void;
  onSelectModel: (model: string, provider?: string) => void;
  onOpenApprovalSheet?: () => void;
  onRefreshModels?: () => void;
  onModelPickerOpenChange?: (open: boolean) => void;
  forceModelPickerOpen?: boolean;
  externalModelPicker?: boolean;
  autoFocus?: boolean;
  draftOverride?: { text: string; version: number } | null;
}

export function MobileMorphingComposer({
  inputId,
  placeholder,
  isStreaming = false,
  disabled = false,
  selectedModel,
  currentProvider,
  approvalMode = 'smart',
  hideApprovalMode = false,
  availableModels,
  modelDetails,
  attachments,
  onSend,
  onStop,
  onAttach,
  onRemoveAttachment,
  onSelectModel,
  onOpenApprovalSheet,
  onRefreshModels,
  onModelPickerOpenChange,
  forceModelPickerOpen,
  externalModelPicker = false,
  autoFocus = false,
  draftOverride = null,
}: MobileMorphingComposerProps): React.ReactElement {
  const [text, setText] = React.useState('');
  const [focused, setFocused] = React.useState(false);
  const [localModelOpen, setLocalModelOpen] = React.useState(false);
  const textareaRef = React.useRef<HTMLTextAreaElement | null>(null);
  const blurTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastAppliedDraftVersionRef = React.useRef(0);

  const clearBlurTimer = React.useCallback((): void => {
    if (blurTimerRef.current !== null) {
      clearTimeout(blurTimerRef.current);
      blurTimerRef.current = null;
    }
  }, []);

  React.useEffect(() => clearBlurTimer, [clearBlurTimer]);

  const modelPickerOpen = forceModelPickerOpen !== undefined ? forceModelPickerOpen : localModelOpen;
  const setModelPickerOpen = React.useCallback(
    (next: boolean) => {
      setLocalModelOpen(next);
      onModelPickerOpenChange?.(next);
    },
    [onModelPickerOpenChange],
  );

  const isExpanded = focused || modelPickerOpen || text.trim().length > 0 || attachments.length > 0;
  const canSend = (text.trim().length > 0 || attachments.length > 0) && !disabled;

  const syncTextareaHeight = React.useCallback((el: HTMLTextAreaElement | null) => {
    if (!el) return;
    el.style.height = 'auto';
    const nextHeight = Math.min(132, Math.max(24, el.scrollHeight || 24));
    el.style.height = `${nextHeight}px`;
  }, []);

  React.useEffect(() => {
    syncTextareaHeight(textareaRef.current);
  }, [text, isExpanded, syncTextareaHeight]);

  React.useEffect(() => {
    if (autoFocus) {
      textareaRef.current?.focus();
    }
  }, [autoFocus]);

  React.useEffect(() => {
    if (!draftOverride || draftOverride.version <= 0) return;
    if (draftOverride.version === lastAppliedDraftVersionRef.current) return;
    lastAppliedDraftVersionRef.current = draftOverride.version;
    setText(draftOverride.text);
    setFocused(true);
    const el = textareaRef.current;
    if (el) {
      el.focus?.();
      const endPos = draftOverride.text.length;
      el.setSelectionRange?.(endPos, endPos);
    }
  }, [draftOverride]);

  const handleSubmit = (): void => {
    const trimmed = text.trim();
    if (!trimmed && attachments.length === 0) return;
    if (disabled) return;
    onSend(trimmed);
    setText('');
    setFocused(false);
    if (textareaRef.current) {
      textareaRef.current.style.height = '24px';
    }
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && !event.shiftKey) {
      // IME 输入法组合态禁止误发送
      if (event.nativeEvent.isComposing) return;
      event.preventDefault();
      handleSubmit();
    }
  };

  const modelAutoLabel = t('mobile.stage.modelAuto');
  const shortModel = React.useMemo(
    () => resolveShortModelName(selectedModel, modelDetails, modelAutoLabel, currentProvider),
    [selectedModel, modelDetails, modelAutoLabel, currentProvider],
  );

  const keepToolbarAlive = (event: { preventDefault: () => void }): void => {
    event.preventDefault();
    clearBlurTimer();
  };

  const handleOpenModelPicker = (): void => {
    clearBlurTimer();
    if (availableModels.length === 0 && modelDetails.length === 0) {
      onRefreshModels?.();
    }
    setModelPickerOpen(true);
  };

  const approvalLabelKey: I18nKey =
    approvalMode === 'manual'
      ? 'dock.approvalManual'
      : approvalMode === 'off'
        ? 'dock.approvalOff'
        : 'dock.approvalSmart';

  return (
    <>
      <div
        className="m-composer m-no-swipe"
        data-expanded={isExpanded ? 'true' : 'false'}
        data-disabled={disabled ? 'true' : 'false'}
      >
        {attachments.length > 0 ? (
          <div className="m-composer__attachments">
            <MessageAttachments
              attachments={attachments}
              variant="composer"
              onRemove={onRemoveAttachment}
            />
          </div>
        ) : null}

        <div className="m-composer__main">
          {!isExpanded ? (
            <button
              type="button"
              className="m-composer__plus-btn"
              onClick={onAttach}
              disabled={disabled}
              aria-label={t('mobile.stage.attachAria')}
            >
              <Plus size={18} strokeWidth={1.9} />
            </button>
          ) : null}

          <textarea
            ref={textareaRef}
            id={inputId}
            rows={1}
            className="m-composer__textarea"
            value={text}
            placeholder={placeholder}
            disabled={disabled}
            onFocus={() => {
              clearBlurTimer();
              setFocused(true);
            }}
            onBlur={() => {
              // 若用户点开底部按钮栏时不立刻坍塌
              clearBlurTimer();
              blurTimerRef.current = setTimeout(() => {
                blurTimerRef.current = null;
                if (document.activeElement !== textareaRef.current) {
                  setFocused(false);
                }
              }, 120);
            }}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={handleKeyDown}
          />

          {!isExpanded ? (
            isStreaming && onStop ? (
              <button
                type="button"
                className="m-composer__send-btn m-composer__send-btn--stop"
                onClick={onStop}
                aria-label={t('mobile.stage.stopAria')}
              >
                <Square size={12} fill="currentColor" />
              </button>
            ) : (
              <button
                type="button"
                className="m-composer__send-btn"
                data-ready="false"
                disabled
                onClick={handleSubmit}
                aria-label={t('mobile.stage.sendAria')}
              >
                <ArrowUp size={16} strokeWidth={2.2} />
              </button>
            )
          ) : null}
        </div>

        <div className="m-composer__toolbar" data-visible={isExpanded ? 'true' : 'false'}>
          <div className="m-composer__toolbar-left">
            <button
              type="button"
              className="m-composer__plus-btn"
              onMouseDown={keepToolbarAlive}
              onPointerDown={keepToolbarAlive}
              onClick={onAttach}
              disabled={disabled}
              aria-label={t('mobile.stage.attachAria')}
            >
              <Plus size={18} strokeWidth={1.9} />
            </button>

            <button
              type="button"
              className="m-composer__model-pill"
              data-testid="mobile-composer-model-pill"
              onMouseDown={keepToolbarAlive}
              onPointerDown={keepToolbarAlive}
              onClick={handleOpenModelPicker}
            >
              <span className="m-composer__model-label">{shortModel}</span>
              <ChevronDown size={13} aria-hidden="true" />
            </button>

            {!hideApprovalMode && onOpenApprovalSheet ? (
              <button
                type="button"
                className="m-composer__model-pill"
                data-testid="mobile-composer-approval-pill"
                aria-label={`${t('dock.approval')}: ${t(approvalLabelKey)}`}
                onMouseDown={keepToolbarAlive}
                onPointerDown={keepToolbarAlive}
                onClick={() => {
                  clearBlurTimer();
                  onOpenApprovalSheet();
                }}
              >
                <Shield size={13} aria-hidden="true" />
                <span className="m-composer__model-label">{t(approvalLabelKey)}</span>
              </button>
            ) : null}
          </div>

          {isStreaming && onStop ? (
            <button
              type="button"
              className="m-composer__send-btn m-composer__send-btn--stop"
              onMouseDown={keepToolbarAlive}
              onPointerDown={keepToolbarAlive}
              onClick={onStop}
              aria-label={t('mobile.stage.stopAria')}
            >
              <Square size={12} fill="currentColor" />
            </button>
          ) : (
            <button
              type="button"
              className="m-composer__send-btn"
              data-ready={canSend ? 'true' : 'false'}
              disabled={!canSend}
              onMouseDown={keepToolbarAlive}
              onPointerDown={keepToolbarAlive}
              onClick={handleSubmit}
              aria-label={t('mobile.stage.sendAria')}
            >
              <ArrowUp size={16} strokeWidth={2.2} />
            </button>
          )}
        </div>
      </div>

      {!externalModelPicker ? (
        <MobileModelPickerSheet
          open={modelPickerOpen}
          selectedModel={selectedModel}
          currentProvider={currentProvider}
          availableModels={availableModels}
          modelDetails={modelDetails}
          onSelectModel={onSelectModel}
          onClose={() => setModelPickerOpen(false)}
          onRefreshModels={onRefreshModels}
        />
      ) : null}
    </>
  );
}
