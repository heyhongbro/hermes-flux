/**
 * 移动端无顶栏沉浸对话舞台 (MobileConversationScreen)
 *
 * 【设计意图 (Why)】
 *   1. 完全无顶部导航栏（Headerless Stage），释放每一毫米纵向阅读空间；
 *   2. 顶部安全区居中挂载桌面同源 `AgentPresence` 宿主 (`#react-conv-presence-host`)：
 *      采用柔和渐变遮罩衬托，上滑翻阅历史时平滑收敛为紧凑微胶囊 (`data-compact-presence="true"`),
 *      滚回底部或生成新回合时自动恢复舒展态；
 *   3. 中部复用标准 `#conversation-stream` 与 `#react-message-list-host`，确保 120 FPS
 *      TokenStreamWriter 流式直写与虚拟视口零差异复用；
 *   4. 底部挂载变形输入舱 `MobileMorphingComposer`（`inputId="mobile-stage-prompt-input"`），
 *      自动随 `--keyboard-height` 与安全区抬升避让。
 */

import * as React from 'react';
import type {
  BackgroundWaitingSummary,
  ClarifyPrompt,
  ConnectionPrompt,
  GatewayConnectionPhase,
  InteractivePrompt,
  InteractiveReplyPayload,
} from '@hermes-flux/core';
import { PanelRight } from 'lucide-react';
import { t } from '../../i18n/index.js';
import type { InputAttachmentItem } from '../../components/InputDock/InputDock.js';
import type { LeftRailActiveFocus } from '../leftRailModel.js';
import { ConnectionStatusPill } from '../ConnectionStatusPill.js';
import { InteractivePromptHost } from '../interactive/InteractivePromptHost.js';
import { BackgroundPromptTopPill } from '../interactive/BackgroundPromptTopPill.js';
import { shouldCompactStagePresence } from './mobileShellModel.js';
import type { MobileModelOption } from './types.js';
import { MobileMorphingComposer } from './MobileMorphingComposer.js';

export interface MobileConversationScreenProps {
  gatewayConnected: boolean;
  activeEntityGatewayOffline?: boolean;
  connectionPhase?: GatewayConnectionPhase;
  connectionReconnectAttempt?: number;
  connectionAuthError?: boolean;
  onRetryConnect?: () => void;
  activeFocus: LeftRailActiveFocus;
  activeBotDisplayName: string;
  isStreaming: boolean;
  messagesCount: number;
  selectedModel: string;
  currentProvider?: string;
  approvalMode?: 'manual' | 'smart' | 'off';
  interactivePrompts?: readonly InteractivePrompt[];
  activeInteractivePromptKey?: string | null;
  interactiveDockCollapsed?: boolean;
  backgroundWaitingSummaries?: readonly BackgroundWaitingSummary[];
  resolveWaitingEntityLabel?: (summary: BackgroundWaitingSummary) => string;
  availableModels: string[];
  modelDetails: MobileModelOption[];
  attachments: InputAttachmentItem[];
  dockNotice: string;
  sideAgentCapsules: Array<{
    id: string;
    kind: 'btw' | 'delegation';
    profile: string;
    question: string;
    answer?: string;
    status: string;
  }>;
  onSendMessage: (text: string) => void;
  onInterruptTurn: () => void;
  onSelectModel: (model: string, provider?: string) => void;
  onOpenApprovalSheet?: () => void;
  onReplyInteractive?: (prompt: InteractivePrompt, payload: InteractiveReplyPayload) => Promise<boolean | void>;
  onLockClarifyAnswer?: (prompt: ClarifyPrompt, questionId: string, answer: string) => Promise<void>;
  onOpenInteractiveExternalUrl?: (url: string) => void;
  onWakeConnection?: (prompt: ConnectionPrompt) => Promise<void>;
  onToggleInteractiveDockCollapsed?: (collapsed: boolean) => void;
  onSelectInteractivePrompt?: (canonicalKey: string) => void;
  onSelectWaitingSummary?: (summary: BackgroundWaitingSummary) => void;
  onRefreshModels?: () => void;
  onOpenAttachmentPicker: () => void;
  onRemoveAttachment: (id: string) => void;
  onOpenSettings: () => void;
  forceModelPickerOpen?: boolean;
  onModelPickerOpenChange?: (open: boolean) => void;
  externalModelPicker?: boolean;
  onStageReady?: () => void;
  onOpenInspector?: () => void;
  rollbackBanner?: { removedCount: number; anchorLabel: string } | null;
  onCancelRollback?: () => void;
  composerDraftOverride?: { text: string; version: number } | null;
}

export function MobileConversationScreen({
  gatewayConnected,
  activeEntityGatewayOffline,
  connectionPhase,
  connectionReconnectAttempt,
  connectionAuthError,
  onRetryConnect,
  activeFocus,
  activeBotDisplayName,
  isStreaming,
  selectedModel,
  currentProvider,
  approvalMode = 'smart',
  interactivePrompts = [],
  activeInteractivePromptKey,
  interactiveDockCollapsed = false,
  backgroundWaitingSummaries = [],
  resolveWaitingEntityLabel,
  availableModels,
  modelDetails,
  attachments,
  dockNotice,
  sideAgentCapsules,
  onSendMessage,
  onInterruptTurn,
  onSelectModel,
  onOpenApprovalSheet,
  onReplyInteractive,
  onLockClarifyAnswer,
  onOpenInteractiveExternalUrl,
  onWakeConnection,
  onToggleInteractiveDockCollapsed,
  onSelectInteractivePrompt,
  onSelectWaitingSummary,
  onRefreshModels,
  onOpenAttachmentPicker,
  onRemoveAttachment,
  onOpenSettings,
  forceModelPickerOpen,
  onModelPickerOpenChange,
  externalModelPicker,
  onStageReady,
  onOpenInspector,
  rollbackBanner,
  onCancelRollback,
  composerDraftOverride,
}: MobileConversationScreenProps): React.ReactElement {
  const [compactPresence, setCompactPresence] = React.useState(false);
  const [pillMounted, setPillMounted] = React.useState(false);
  const showOfflineCard =
    !gatewayConnected &&
    (connectionPhase === undefined || connectionPhase === 'unconfigured');
  const effectiveDockNotice =
    dockNotice || (activeEntityGatewayOffline ? t('gateway.offlineReadOnlyNotice') : '');
  const streamRef = React.useRef<HTMLDivElement | null>(null);
  const paneRef = React.useRef<HTMLElement | null>(null);
  const composerDockRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    onStageReady?.();
  }, [onStageReady]);

  // 监测底部停靠舱（含交互停靠卡 + 输入舱 + 提示条）总高并写入 `--m-composer-dock-h`，同步避让聊天流底部
  React.useEffect(() => {
    const dockEl = composerDockRef.current;
    const paneEl = paneRef.current;
    if (!dockEl || !paneEl || typeof ResizeObserver === 'undefined') return;
    let lastH = -1;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const blockSize = entry.borderBoxSize?.[0]?.blockSize;
      const rawH = typeof blockSize === 'number' && blockSize > 0 ? blockSize : entry.contentRect.height;
      const nextH = Math.max(76, Math.ceil(rawH));
      if (nextH !== lastH) {
        lastH = nextH;
        paneEl.style.setProperty('--m-composer-dock-h', `${nextH}px`);
      }
    });
    observer.observe(dockEl);
    return () => observer.disconnect();
  }, []);

  // 软键盘弹起压缩对话流可视区时，若用户原本接近底部则等量推进 scrollTop 保持最新消息可见
  React.useEffect(() => {
    const el = streamRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    let prevClientHeight = el.clientHeight;
    const observer = new ResizeObserver(() => {
      const nextClientHeight = el.clientHeight;
      const delta = prevClientHeight - nextClientHeight;
      if (delta > 0) {
        const prevDist = el.scrollHeight - el.scrollTop - prevClientHeight;
        if (prevDist <= 180) {
          el.scrollTop = Math.max(0, Math.min(el.scrollHeight - nextClientHeight, el.scrollTop + delta));
        }
      }
      prevClientHeight = nextClientHeight;
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const handleStreamScroll = React.useCallback((event: React.UIEvent<HTMLDivElement>) => {
    const el = event.currentTarget;
    setCompactPresence(shouldCompactStagePresence(el.scrollHeight, el.scrollTop, el.clientHeight));
  }, []);

  React.useEffect(() => {
    if (isStreaming) {
      setCompactPresence(false);
    }
  }, [isStreaming]);

  const placeholder =
    activeFocus.type === 'group'
      ? t('mobile.stage.placeholderGroup')
      : t('mobile.stage.placeholder');

  return (
    <section
      ref={paneRef}
      className="m-pane m-stage flux-middle-pod"
      data-compact-presence={compactPresence ? 'true' : 'false'}
      data-has-top-pill={backgroundWaitingSummaries.length > 0 && onSelectWaitingSummary ? 'true' : 'false'}
      aria-label={activeBotDisplayName || t('mobile.section.sessions')}
    >
      <div className="m-stage__presence-scrim" data-compact={compactPresence ? 'true' : 'false'}>
        <div
          id="react-conv-presence-host"
          data-mobile-slot="true"
          data-replaced={pillMounted ? 'true' : 'false'}
          className="m-stage__presence-host"
        />
        {connectionPhase !== undefined ? (
          <ConnectionStatusPill
            phase={connectionPhase}
            attempt={connectionReconnectAttempt}
            isAuthError={connectionAuthError}
            layout="stage"
            compact={compactPresence}
            onRetry={onRetryConnect}
            onOpenSettings={onOpenSettings}
            onMountedChange={setPillMounted}
          />
        ) : null}
        {backgroundWaitingSummaries.length > 0 && onSelectWaitingSummary ? (
          <BackgroundPromptTopPill
            surface="mobile"
            summaries={backgroundWaitingSummaries}
            resolveEntityLabel={resolveWaitingEntityLabel ?? ((item) => item.entityId)}
            onSelectSummary={onSelectWaitingSummary}
          />
        ) : null}
        {onOpenInspector ? (
          <button
            type="button"
            className="m-float-circle-btn m-stage__inspector-btn m-no-swipe"
            data-testid="mobile-stage-open-inspector"
            aria-label={t('mobile.stage.openInspectorAria')}
            onClick={onOpenInspector}
          >
            <PanelRight size={18} strokeWidth={1.85} />
          </button>
        ) : null}
      </div>

      <div
        ref={streamRef}
        id="conversation-stream"
        className="conversation-stream m-stage__stream"
        onScroll={handleStreamScroll}
      >
        {showOfflineCard ? (
          <div className="m-stage__offline-card">
            <p className="m-stage__offline-title">{t('mobile.home.offlineTitle')}</p>
            <p className="m-stage__offline-hint">{t('mobile.stage.offlineHint')}</p>
            <button type="button" className="m-primary-btn" onClick={onOpenSettings}>
              {t('mobile.stage.openSettings')}
            </button>
          </div>
        ) : null}

        <div id="react-message-list-host" className="m-stage__msg-host" />

        {sideAgentCapsules.length > 0 ? (
          <div className="m-stage__capsules">
            {sideAgentCapsules.map((cap) => (
              <div key={cap.id} className="m-side-capsule" data-status={cap.status}>
                <span className="m-side-capsule__tag">{cap.profile}</span>
                <span className="m-side-capsule__text">{cap.answer || cap.question}</span>
              </div>
            ))}
          </div>
        ) : null}
      </div>

      <div ref={composerDockRef} className="m-stage__composer-dock">
        {effectiveDockNotice ? <div className="m-stage__notice">{effectiveDockNotice}</div> : null}
        {interactivePrompts.length > 0 && onReplyInteractive ? (
          <InteractivePromptHost
            surface="mobile-dock"
            prompts={interactivePrompts}
            activeCanonicalKey={activeInteractivePromptKey}
            collapsed={interactiveDockCollapsed}
            onCollapsedChange={onToggleInteractiveDockCollapsed}
            onSelectPrompt={onSelectInteractivePrompt}
            onReply={onReplyInteractive}
            onLockClarifyAnswer={onLockClarifyAnswer}
            onOpenExternalUrl={onOpenInteractiveExternalUrl}
            onWakeConnection={onWakeConnection}
          />
        ) : null}
        {rollbackBanner ? (
          <div className="m-stage__rollback-banner" data-testid="mobile-rollback-banner">
            <span className="m-stage__rollback-text">
              {t('chat.rollbackArmed', {
                count: rollbackBanner.removedCount,
                anchor: rollbackBanner.anchorLabel,
              })}
            </span>
            <button
              type="button"
              className="m-stage__rollback-cancel"
              data-action="rollback-cancel"
              data-testid="mobile-rollback-cancel"
              onClick={onCancelRollback}
            >
              {t('chat.rollbackCancel')}
            </button>
          </div>
        ) : null}
        <MobileMorphingComposer
          inputId="mobile-stage-prompt-input"
          placeholder={placeholder}
          isStreaming={isStreaming}
          disabled={!gatewayConnected || Boolean(activeEntityGatewayOffline)}
          selectedModel={selectedModel}
          currentProvider={currentProvider}
          approvalMode={approvalMode}
          hideApprovalMode={activeFocus.type === 'group'}
          availableModels={availableModels}
          modelDetails={modelDetails}
          attachments={attachments}
          onSend={onSendMessage}
          onStop={onInterruptTurn}
          onAttach={onOpenAttachmentPicker}
          onRemoveAttachment={onRemoveAttachment}
          onSelectModel={onSelectModel}
          onOpenApprovalSheet={onOpenApprovalSheet}
          onRefreshModels={onRefreshModels}
          forceModelPickerOpen={forceModelPickerOpen}
          onModelPickerOpenChange={onModelPickerOpenChange}
          externalModelPicker={externalModelPicker}
          draftOverride={composerDraftOverride}
        />
      </div>
    </section>
  );
}
