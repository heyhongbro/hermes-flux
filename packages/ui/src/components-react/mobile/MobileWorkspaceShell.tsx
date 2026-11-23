/**
 * 移动端三屏连续跟手手势总壳层与挂载桥 (MobileWorkspaceShell)
 *
 * 【设计意图 (Why)】
 *   1. 三屏连续 1:1 跟手横向画布：左屏（会话列表首屏）⇄ 中屏（无顶栏对话舞台）⇄ 右屏（无顶栏检查舱）；
 *      使用 CSS Transform (`translate3d`) 与 `cubic-bezier(0.22, 1, 0.36, 1)` 阻尼过渡，
 *      边缘提供 `0.28` 橡皮筋阻力，代码横向滚动区与浮层自动豁免拖拽手势；
 *   2. 背景层级联景深动效：唤起新建会话页 / 子代理抽屉 / 长按操作面板时，主画布等比下沉至 `scale(0.935)`；
 *      全屏推入设置页时主画布平滑左移 `-26%` 视差退让；
 *   3. 统一接入 `hermes-mobile-back` 事件总线，经由纯状态机 `reduceMobileBackAction` 逐级消费
 *      Android 物理返回键与 iOS 返回手势。
 */

import * as React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Archive, ExternalLink, Pencil, Pin, ShieldAlert, Trash2, X } from 'lucide-react';
import { t } from '../../i18n/index.js';
import type { MobileWorkspaceActions, MobileWorkspaceSnapshot } from './types.js';
import {
  computeSwipeMove,
  reduceMobileBackAction,
  resolveSwipeReleaseEndX,
  resolveTrackTransform,
  settleSwipeRelease,
  type SwipeLockAxis,
} from './mobileShellModel.js';
import { MobileHomeScreen } from './MobileHomeScreen.js';
import { MobileConversationScreen } from './MobileConversationScreen.js';
import { MobileModelPickerSheet } from './MobileMorphingComposer.js';
import { MobileInspectorScreen } from './MobileInspectorScreen.js';
import { MobileNewChatSheet } from './MobileNewChatSheet.js';
import { MobileSubagentSheet } from './MobileSubagentSheet.js';
import { MobileSettingsPage } from './MobileSettingsPage.js';
import { MobileBotSubpagePanel, MobileBotWizardSheet } from './MobileBotSubpage.js';

export interface MobileWorkspaceShellProps {
  snapshot: MobileWorkspaceSnapshot;
  actions: MobileWorkspaceActions;
}

function shouldIgnoreSwipeTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest('[data-gesture-ignore="pan-x"], .m-no-swipe, input, textarea, select')) {
    return true;
  }
  const scrollBlock = target.closest('pre, code, .conv-code-block, table');
  if (scrollBlock && scrollBlock.scrollWidth > scrollBlock.clientWidth + 4) {
    return true;
  }
  return false;
}

export function MobileWorkspaceShell({ snapshot, actions }: MobileWorkspaceShellProps): React.ReactElement {
  const viewportRef = React.useRef<HTMLDivElement | null>(null);
  const [dragOffsetPx, setDragOffsetPx] = React.useState(0);
  const [isDragging, setIsDragging] = React.useState(false);
  const [renameMode, setRenameMode] = React.useState(false);
  const [renameDraft, setRenameDraft] = React.useState('');
  const [modelPickerOpen, setModelPickerOpen] = React.useState(false);

  const dragRef = React.useRef<{
    active: boolean;
    pointerId: number;
    startX: number;
    startY: number;
    startTime: number;
    lastX: number;
    lastTime: number;
    locked: SwipeLockAxis;
  }>({
    active: false,
    pointerId: -1,
    startX: 0,
    startY: 0,
    startTime: 0,
    lastX: 0,
    lastTime: 0,
    locked: 'none',
  });

  React.useEffect(() => {
    setRenameMode(false);
    setRenameDraft(snapshot.actionSheet?.title || '');
  }, [snapshot.actionSheet]);

  const botWizardOpen = Boolean(snapshot.settingsSnapshot.botManagement?.wizard?.open);
  const anySheetOpen =
    snapshot.newChatOpen || Boolean(snapshot.subagentSheet) || Boolean(snapshot.actionSheet) || botWizardOpen;

  // Android 物理返回键 / 系统返回统一归约分发
  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    const handleMobileBack = (event: Event): void => {
      const outcome = reduceMobileBackAction({
        activePane: snapshot.activePane,
        homeTab: snapshot.homeTab,
        hasActionSheet: Boolean(snapshot.actionSheet),
        hasModelSheet: modelPickerOpen,
        hasSubagentSheet: Boolean(snapshot.subagentSheet),
        botWizardOpen,
        newChatOpen: snapshot.newChatOpen,
        newChatStep: snapshot.newChatStep,
        searchOpen: snapshot.searchOpen,
        settingsOpen: snapshot.settingsOpen,
        settingsSubpage: snapshot.settingsSubpage,
        botSubpage: snapshot.botSubpage,
        inspectorReaderOpen: snapshot.inspectorReaderOpen,
      });

      if (!outcome.handled) return;
      event.preventDefault();

      switch (outcome.effect) {
        case 'closeActionSheet':
          actions.onCloseActionSheet();
          break;
        case 'closeModelSheet':
          setModelPickerOpen(false);
          break;
        case 'closeSubagentSheet':
          actions.onCloseSubagentSheet();
          break;
        case 'closeBotWizard':
          actions.settingsActions.onCloseBotWizard();
          break;
        case 'newChatBackToCompose':
          actions.onSetNewChatStep('compose');
          break;
        case 'closeNewChatSheet':
          actions.onCloseNewChat();
          break;
        case 'closeSearch':
          actions.onCloseSearch();
          break;
        case 'settingsBackToRoot':
          actions.onSelectSettingsSubpage(null);
          break;
        case 'closeSettings':
          actions.onCloseSettings();
          break;
        case 'botBackToRoot':
          actions.onSelectBotSubpage(null);
          break;
        case 'closeInspectorReader':
          actions.onCloseInspectorReader();
          break;
        case 'navigatePane':
          actions.onSelectPane(outcome.nextPane);
          break;
        case 'switchHomeTab':
          actions.onSelectHomeTab(outcome.nextTab);
          break;
      }
    };

    window.addEventListener('hermes-mobile-back', handleMobileBack);
    return () => window.removeEventListener('hermes-mobile-back', handleMobileBack);
  }, [snapshot, actions, modelPickerOpen, botWizardOpen]);

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (anySheetOpen || snapshot.settingsOpen || snapshot.searchOpen || snapshot.botSubpage !== null) return;
    if (event.button !== 0 && event.pointerType === 'mouse') return;
    if (shouldIgnoreSwipeTarget(event.target)) return;

    dragRef.current = {
      active: true,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startTime: Date.now(),
      lastX: event.clientX,
      lastTime: Date.now(),
      locked: 'none',
    };
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
    if (!drag.active || drag.pointerId !== event.pointerId) return;

    const move = computeSwipeMove({
      activePane: snapshot.activePane,
      dx: event.clientX - drag.startX,
      dy: event.clientY - drag.startY,
      locked: drag.locked,
    });
    drag.locked = move.nextLocked;
    if (move.stopTracking) {
      drag.active = false;
      return;
    }
    if (move.didLockHorizontal) {
      setIsDragging(true);
      try {
        event.currentTarget?.setPointerCapture?.(event.pointerId);
      // gate-degrade: 宿主或浏览器拒绝捕获 pointerId 时按普通滑动降级
      } catch {
      }
    }
    if (move.nextLocked !== 'horizontal') return;
    drag.lastX = event.clientX;
    drag.lastTime = Date.now();
    setDragOffsetPx(move.dragOffsetPx);
  };

  const finishDrag = (event: React.PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
    if (!drag.active || drag.pointerId !== event.pointerId) return;
    const wasHorizontal = drag.locked === 'horizontal';
    drag.active = false;
    drag.locked = 'none';
    setIsDragging(false);
    try {
      event.currentTarget?.releasePointerCapture?.(event.pointerId);
    // gate-degrade: 未曾锁定时 releasePointerCapture 会抛错，按无操作降级
    } catch {
      // 未锁定时释放捕获静默忽略
    }

    if (!wasHorizontal) {
      setDragOffsetPx(0);
      return;
    }

    const endX = resolveSwipeReleaseEndX(event.type, event.clientX, drag.lastX);
    const nextPane = settleSwipeRelease({
      activePane: snapshot.activePane,
      totalDx: endX - drag.startX,
      durationMs: Date.now() - drag.startTime,
      viewportWidth: viewportRef.current?.clientWidth || 390,
    });

    setDragOffsetPx(0);
    if (nextPane !== snapshot.activePane) {
      actions.onSelectPane(nextPane);
    }
  };

  const trackTransform = resolveTrackTransform(snapshot.activePane, isDragging, dragOffsetPx);

  const activeSheet = snapshot.actionSheet;

  return (
    <div
      className="m-shell"
      data-testid="mobile-workspace-shell"
      data-active-pane={snapshot.activePane}
      data-sheet-open={anySheetOpen ? 'true' : 'false'}
      data-settings-open={snapshot.settingsOpen ? 'true' : 'false'}
    >
      <div
        ref={viewportRef}
        className="m-shell__main"
        data-sunk={anySheetOpen ? 'true' : 'false'}
        data-pushed={snapshot.settingsOpen ? 'true' : 'false'}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={finishDrag}
        onPointerCancel={finishDrag}
      >
        <div
          className="m-shell__track"
          data-dragging={isDragging ? 'true' : 'false'}
          style={{ transform: trackTransform }}
        >
          <MobileHomeScreen
            homeTab={snapshot.homeTab}
            model={snapshot.homeModel}
            allProfiles={snapshot.allProfiles}
            groupAvatars={snapshot.groupAvatars}
            activeBotName={snapshot.activeBotName}
            gatewayConnected={snapshot.gatewayConnected}
            gatewayConnecting={snapshot.gatewayConnecting}
            searchOpen={snapshot.searchOpen}
            settingsSnapshot={snapshot.settingsSnapshot}
            modelDetails={snapshot.modelDetails}
            onSelectHomeTab={actions.onSelectHomeTab}
            onSelectBotSubpage={actions.onSelectBotSubpage}
            onOpenSettings={actions.onOpenSettings}
            onOpenSettingsGateway={() => actions.onOpenSettingsSubpage('gateway')}
            onOpenSearch={actions.onOpenSearch}
            onCloseSearch={actions.onCloseSearch}
            onSearchChange={actions.onSearchChange}
            onOpenNewChat={actions.onOpenNewChat}
            onToggleSection={actions.onToggleSection}
            onSelectBot={actions.onSelectBot}
            onSelectGroup={actions.onSelectGroup}
            onSelectSession={actions.onSelectSession}
            onOpenActionSheet={actions.onOpenActionSheet}
            onHapticSelection={actions.onHapticSelection}
            settingsActions={actions.settingsActions}
          />

          <MobileConversationScreen
            gatewayConnected={snapshot.gatewayConnected}
            activeFocus={snapshot.activeFocus}
            activeBotDisplayName={snapshot.activeBotDisplayName}
            isStreaming={snapshot.isStreaming}
            messagesCount={snapshot.messagesCount}
            selectedModel={snapshot.selectedModel}
            currentProvider={snapshot.currentProvider}
            availableModels={snapshot.availableModels}
            modelDetails={snapshot.modelDetails}
            attachments={snapshot.attachments}
            dockNotice={snapshot.dockNotice}
            sideAgentCapsules={snapshot.sideAgentCapsules}
            onSendMessage={actions.onSendMessage}
            onInterruptTurn={actions.onInterruptTurn}
            onSelectModel={actions.onSelectModel}
            onRefreshModels={actions.onRefreshModels}
            onOpenAttachmentPicker={actions.onOpenAttachmentPicker}
            onRemoveAttachment={actions.onRemoveAttachment}
            onOpenSettings={actions.onOpenSettings}
            forceModelPickerOpen={snapshot.newChatOpen ? false : modelPickerOpen}
            onModelPickerOpenChange={setModelPickerOpen}
            externalModelPicker={true}
            onStageReady={actions.onStageReady}
            onOpenInspector={() => actions.onSelectPane('inspector')}
          />

          <MobileInspectorScreen
            activeFocus={snapshot.activeFocus}
            activeTab={snapshot.inspectorTab}
            readerOpen={snapshot.inspectorReaderOpen}
            readerItem={snapshot.inspectorReaderItem}
            artifacts={snapshot.artifacts}
            gitDiffs={snapshot.gitDiffs}
            openFiles={snapshot.openFiles}
            fileTreeState={snapshot.fileTreeState}
            fileTreeExpandedPaths={snapshot.fileTreeExpandedPaths}
            fileTreeFilterQuery={snapshot.fileTreeFilterQuery}
            activeFilePath={snapshot.activeFilePath}
            workspaceRootName={snapshot.workspaceRootName}
            memories={snapshot.memories}
            learningState={snapshot.learningState}
            learningDetail={snapshot.learningDetail}
            groupMembers={snapshot.groupMembers}
            onSelectTab={actions.onSelectInspectorTab}
            onOpenItem={actions.onOpenInspectorItem}
            onCloseReader={actions.onCloseInspectorReader}
            onCopyText={actions.onCopyInspectorText}
            onBackToStage={() => actions.onSelectPane('stage')}
            onLoadFileTree={actions.onLoadFileTree}
            onToggleFileTreeDir={actions.onToggleFileTreeDir}
            onFilterFileTree={actions.onFilterFileTree}
            onOpenWorkspaceFile={actions.onOpenWorkspaceFile}
            onDownloadInspectorFile={actions.onDownloadInspectorFile}
            onRefreshLearning={actions.onRefreshLearning}
            onLoadLearningDetail={actions.onLoadLearningDetail}
            onEditLearningNode={actions.onEditLearningNode}
            onDeleteLearningNode={actions.onDeleteLearningNode}
          />
        </div>
      </div>

      <MobileNewChatSheet
        open={snapshot.newChatOpen}
        step={snapshot.newChatStep}
        targetKind={snapshot.newChatTargetKind}
        targetBot={snapshot.newChatTargetBot}
        groupMembers={snapshot.newChatGroupMembers}
        groupName={snapshot.newChatGroupName}
        allProfiles={snapshot.allProfiles}
        stats={snapshot.newChatStats}
        gatewayConnected={snapshot.gatewayConnected}
        selectedModel={snapshot.selectedModel}
        currentProvider={snapshot.currentProvider}
        availableModels={snapshot.availableModels}
        modelDetails={snapshot.modelDetails}
        attachments={snapshot.attachments}
        onClose={actions.onCloseNewChat}
        onSetStep={actions.onSetNewChatStep}
        onSelectBot={actions.onSelectNewChatBot}
        onSetGroupMembers={actions.onSetNewChatGroupMembers}
        onSetGroupName={actions.onSetNewChatGroupName}
        onSubmitFirstMessage={actions.onSubmitNewChatMessage}
        onSelectModel={actions.onSelectModel}
        onRefreshModels={actions.onRefreshModels}
        onOpenAttachmentPicker={actions.onOpenAttachmentPicker}
        onRemoveAttachment={actions.onRemoveAttachment}
        forceModelPickerOpen={snapshot.newChatOpen ? modelPickerOpen : false}
        onModelPickerOpenChange={setModelPickerOpen}
        externalModelPicker={true}
      />

      <MobileModelPickerSheet
        open={modelPickerOpen}
        selectedModel={snapshot.selectedModel}
        currentProvider={snapshot.currentProvider}
        availableModels={snapshot.availableModels}
        modelDetails={snapshot.modelDetails}
        onSelectModel={actions.onSelectModel}
        onClose={() => setModelPickerOpen(false)}
        onRefreshModels={actions.onRefreshModels}
      />

      <MobileSubagentSheet
        sheet={snapshot.subagentSheet}
        isStreaming={snapshot.isStreaming}
        onClose={actions.onCloseSubagentSheet}
        onInterruptTurn={actions.onInterruptTurn}
      />

      <MobileSettingsPage
        open={snapshot.settingsOpen}
        subpage={snapshot.settingsSubpage}
        appearancePref={snapshot.appearancePref}
        snapshot={snapshot.settingsSnapshot}
        onClose={actions.onCloseSettings}
        onSelectSubpage={actions.onSelectSettingsSubpage}
        onSetAppearancePreference={actions.onSetAppearancePreference}
        settingsActions={actions.settingsActions}
      />

      <MobileBotSubpagePanel
        subpage={snapshot.botSubpage}
        settingsSnapshot={snapshot.settingsSnapshot}
        settingsActions={actions.settingsActions}
        onBack={() => actions.onSelectBotSubpage(null)}
        onOpenBotChat={actions.onSelectBot}
        onOpenProviders={() => actions.onOpenSettingsSubpage('providers')}
        onOpenGateway={() => actions.onOpenSettingsSubpage('gateway')}
        learningState={snapshot.learningState}
        learningDetail={snapshot.learningDetail}
        onRefreshLearning={actions.onRefreshLearning}
        onLoadLearningDetail={actions.onLoadLearningDetail}
        onEditLearningNode={actions.onEditLearningNode}
        onDeleteLearningNode={actions.onDeleteLearningNode}
        onCopyText={actions.onCopyInspectorText}
      />

      <MobileBotWizardSheet
        settingsSnapshot={snapshot.settingsSnapshot}
        settingsActions={actions.settingsActions}
      />

      {activeSheet ? (
        <div
          className="m-sheet-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label={t('mobile.actionSheet.title')}
          onClick={actions.onCloseActionSheet}
        >
          <div className="m-bottom-sheet m-no-swipe" onClick={(e) => e.stopPropagation()}>
            <div className="m-sheet-handle" aria-hidden="true" />
            <div className="m-sheet-header">
              <span className="m-sheet-title">{activeSheet.title}</span>
              <button
                type="button"
                className="m-icon-btn"
                onClick={actions.onCloseActionSheet}
                aria-label={t('mobile.common.close')}
              >
                <X size={18} />
              </button>
            </div>

            {renameMode ? (
              <div className="m-action-sheet__rename">
                <input
                  type="text"
                  className="m-matte-input"
                  value={renameDraft}
                  placeholder={t('mobile.actionSheet.renamePrompt')}
                  onChange={(e) => setRenameDraft(e.target.value)}
                />
                <div className="m-settings-btn-row">
                  <button
                    type="button"
                    className="m-secondary-btn"
                    onClick={() => setRenameMode(false)}
                  >
                    {t('mobile.actionSheet.cancel')}
                  </button>
                  <button
                    type="button"
                    className="m-primary-btn"
                    onClick={() => {
                      const trimmed = renameDraft.trim();
                      if (trimmed) {
                        actions.onActionRename(activeSheet, trimmed);
                      }
                      actions.onCloseActionSheet();
                    }}
                  >
                    {t('mobile.actionSheet.rename')}
                  </button>
                </div>
              </div>
            ) : (
              <div className="m-sheet-list">
                <button
                  type="button"
                  className="m-sheet-option"
                  onClick={() => {
                    actions.onActionOpen(activeSheet);
                    actions.onCloseActionSheet();
                  }}
                >
                  <ExternalLink size={16} aria-hidden="true" />
                  <span className="m-sheet-option__title">{t('mobile.actionSheet.open')}</span>
                </button>

                {activeSheet.kind !== 'bot' ? (
                  <button
                    type="button"
                    className="m-sheet-option"
                    onClick={() => setRenameMode(true)}
                  >
                    <Pencil size={16} aria-hidden="true" />
                    <span className="m-sheet-option__title">{t('mobile.actionSheet.rename')}</span>
                  </button>
                ) : null}

                {activeSheet.kind === 'session' ? (
                  <>
                    <button
                      type="button"
                      className="m-sheet-option"
                      onClick={() => {
                        actions.onActionPin(activeSheet);
                        actions.onCloseActionSheet();
                      }}
                    >
                      <Pin size={16} aria-hidden="true" />
                      <span className="m-sheet-option__title">{t('mobile.actionSheet.pin')}</span>
                    </button>
                    <button
                      type="button"
                      className="m-sheet-option"
                      onClick={() => {
                        actions.onActionArchive(activeSheet);
                        actions.onCloseActionSheet();
                      }}
                    >
                      <Archive size={16} aria-hidden="true" />
                      <span className="m-sheet-option__title">{t('mobile.actionSheet.archive')}</span>
                    </button>
                    <button
                      type="button"
                      className="m-sheet-option m-sheet-option--danger"
                      onClick={() => {
                        actions.onActionDelete(activeSheet);
                        actions.onCloseActionSheet();
                      }}
                    >
                      <Trash2 size={16} aria-hidden="true" />
                      <span className="m-sheet-option__title">{t('mobile.actionSheet.delete')}</span>
                    </button>
                  </>
                ) : null}

                {activeSheet.kind === 'group' ? (
                  <button
                    type="button"
                    className="m-sheet-option m-sheet-option--danger"
                    onClick={() => {
                      actions.onActionDisband(activeSheet);
                      actions.onCloseActionSheet();
                    }}
                  >
                    <Trash2 size={16} aria-hidden="true" />
                    <span className="m-sheet-option__title">{t('mobile.actionSheet.disband')}</span>
                  </button>
                ) : null}

                {activeSheet.kind === 'bot' ? (
                  <div className="m-action-sheet__protected">
                    <ShieldAlert size={15} aria-hidden="true" />
                    <span>{t('mobile.actionSheet.protectedHint')}</span>
                  </div>
                ) : null}
              </div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export interface MobileWorkspaceMount {
  update: () => void;
  unmount: () => void;
}

/**
 * 移动端表现壳单根挂载桥：宿主只推新快照，保持 `#conversation-stream` 与内部节点引用稳定。
 */
export function mountMobileWorkspaceShell(
  host: HTMLElement,
  getSnapshot: () => MobileWorkspaceSnapshot,
  actions: MobileWorkspaceActions,
  createRootFn: (container: Element | DocumentFragment) => Pick<Root, 'render' | 'unmount'> = createRoot,
): MobileWorkspaceMount {
  if (!host || !host.isConnected) {
    throw new Error('Mobile workspace host must be connected before mounting');
  }
  const root = createRootFn(host);
  const renderShell = (): void => {
    root.render(<MobileWorkspaceShell snapshot={getSnapshot()} actions={actions} />);
  };
  renderShell();
  return {
    update: renderShell,
    unmount: () => root.unmount(),
  };
}
