/**
 * 移动端 Bot Hub 页：连续惯性头像轮播 + Bot 专属能力分组菜单 (MobileBotHubScreen)
 *
 * 【设计意图 (Why)】
 *   对标参考图将 Bot 管理从“大杂烩设置页”物理剥离出来，成为与“对话列表”并列的首页主枢纽：
 *   1. 顶部采用原生 `overflow-x: auto` + `scroll-snap-type: x mandatory` 连续惯性横向轮播全量 Bot，
 *      一拂手可顺滑跨越多个智能体并按距中心距离连续插值缩放（96px ↔ 58px），滑过中心时触发
 *      `onHapticSelection()` 微震（"滋滋"手感），松手停稳后提交 `onSelectBotSettle` 加载该 Bot 详情；
 *   2. 居中 Bot 名称与模型副标题下直接提供「进入主工位对话」胶囊钮，一触直达 Forever Chat；
 *   3. 下方严格遵循分组菜单式分层列表（身份/模型/Soul、能力与集成、知识与记忆）。
 *
 * 【防范的历史坑 (Pitfall)】
 *   1. `.m-bot-carousel-viewport` 作为滚动容器严禁自身声明 `transform`（防 WebKit 合成层退化），
 *      连续缩放效果只挂在每个槽位内层包装容器上；
 *   2. 轮播视口必须声明 `.m-no-swipe` 与 `data-gesture-ignore="pan-x"`，防止滑过智能体头像时误触三屏切换；
 *   3. 程序化同步 `scrollLeft` 不得触发回环 `onSelectBotSettle`：仅当滚动定位到不同于当前 `targetId` 的条目且稳定后才落盘。
 *
 * 【约束与规则 (Rules)】
 *   - 复用共享 `MobileMenuGroup` / `MobileMenuCard` / `MobileMenuRow` 与 `@hermes-flux/core` 草稿比较纯函数；
 *   - 离线/加载失败态显式展示提示或重试按钮（Failure Is Not Empty）。
 */

import * as React from 'react';
import {
  Blocks,
  Brain,
  Cpu,
  FileCode2,
  MessageSquare,
  Plug,
  UserRound,
  Wrench,
  X,
} from 'lucide-react';
import { draftFromDetail, isBotDraftDirty, type GatewayConnectionPhase } from '@hermes-flux/core';
import { t } from '../../i18n/index.js';
import { renderBotAvatar } from '../../utils/botAvatar.js';
import type { LeftRailProfile } from '../leftRailModel.js';
import type { BotRosterEntry, SettingsActions, SettingsSnapshot } from '../settings/settingsModel.js';
import {
  computeSoulLineCount,
  countEnabledCapabilities,
  resolveBotAvatar,
  resolveBotDisplayTitle,
} from '../settings/botPanelLogic.js';
import {
  MOBILE_BOT_CAROUSEL_STEP_PX,
  computeBotCarouselSlotVisual,
  resolveBotCarouselScrollIndex,
  resolveNearestBotIndex,
  resolveShortModelName,
  type MobileBotSubpage,
} from './mobileShellModel.js';
import { MobileBotSaveBar, MobileMenuCard, MobileMenuGroup, MobileMenuRow } from './MobileMenuPrimitives.js';
import type { MobileModelOption } from './types.js';

export interface MobileBotHubScreenProps {
  allProfiles: LeftRailProfile[];
  activeBotName: string;
  gatewayConnected: boolean;
  connectionPhase?: GatewayConnectionPhase;
  settingsSnapshot: SettingsSnapshot;
  modelDetails: MobileModelOption[];
  onSelectBotSubpage: (subpage: Exclude<MobileBotSubpage, null>) => void;
  onOpenBotChat: (botName: string) => void;
  onOpenSettingsGateway: () => void;
  onHapticSelection?: () => void;
  settingsActions: SettingsActions;
}

function clearTimerRef(ref: React.MutableRefObject<ReturnType<typeof setTimeout> | null>): void {
  if (ref.current !== null) {
    clearTimeout(ref.current);
    ref.current = null;
  }
}

function toFallbackRoster(
  profiles: readonly LeftRailProfile[],
  settingsProfiles: SettingsSnapshot['profiles'],
): BotRosterEntry[] {
  const modelMap = new Map<string, string>();
  if (settingsProfiles.status === 'ready') {
    for (const sp of settingsProfiles.data) {
      if (sp.model) modelMap.set(sp.name.toLowerCase(), sp.model);
    }
  }
  return profiles.map((p) => ({
    id: p.name,
    displayName: p.displayName || p.name,
    model: modelMap.get(p.name.toLowerCase()) || '',
    avatar: p.avatar,
    isDefault: Boolean(p.isDefault || p.name.toLowerCase() === 'default'),
    hasDraft: false,
  }));
}

export function MobileBotHubScreen({
  allProfiles,
  activeBotName,
  gatewayConnected,
  connectionPhase,
  settingsSnapshot,
  modelDetails,
  onSelectBotSubpage,
  onOpenBotChat,
  onOpenSettingsGateway,
  onHapticSelection,
  settingsActions,
}: MobileBotHubScreenProps): React.ReactElement {
  const view = settingsSnapshot.botManagement;
  const roster = view.roster.length > 0 ? view.roster : toFallbackRoster(allProfiles, settingsSnapshot.profiles);
  const targetId = view.activeBotId || activeBotName || roster[0]?.id || '';
  const matchedIdx = roster.findIndex((b) => b.id.toLowerCase() === targetId.toLowerCase());
  const settledIdx = matchedIdx >= 0 ? matchedIdx : 0;

  const viewportRef = React.useRef<HTMLDivElement | null>(null);
  const settleTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const movedResetTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const programmaticScrollTargetRef = React.useRef<number | null>(null);
  const lastPreviewIdxRef = React.useRef(settledIdx);
  const [visualScrollIdx, setVisualScrollIdx] = React.useState(settledIdx);
  const [previewIdx, setPreviewIdx] = React.useState(settledIdx);
  const [isDraggingMouse, setIsDraggingMouse] = React.useState(false);

  const mouseDragRef = React.useRef<{
    active: boolean;
    pointerId: number;
    startX: number;
    startScrollLeft: number;
    moved: boolean;
  }>({
    active: false,
    pointerId: -1,
    startX: 0,
    startScrollLeft: 0,
    moved: false,
  });

  React.useEffect(() => () => {
    clearTimerRef(settleTimerRef);
    clearTimerRef(movedResetTimerRef);
  }, []);

  React.useEffect(() => {
    clearTimerRef(settleTimerRef);
    programmaticScrollTargetRef.current = null;
    lastPreviewIdxRef.current = settledIdx;
    setPreviewIdx(settledIdx);
    setVisualScrollIdx(settledIdx);
    const el = viewportRef.current;
    if (el) {
      const targetScrollLeft = settledIdx * MOBILE_BOT_CAROUSEL_STEP_PX;
      if (Math.abs(el.scrollLeft - targetScrollLeft) > 1) {
        el.scrollLeft = targetScrollLeft;
      }
    }
  }, [settledIdx, roster.length]);

  const scheduleSettle = React.useCallback(
    (nextIdx: number): void => {
      clearTimerRef(settleTimerRef);
      settleTimerRef.current = setTimeout(() => {
        settleTimerRef.current = null;
        const candidate = roster[nextIdx];
        if (candidate && candidate.id.toLowerCase() !== targetId.toLowerCase()) {
          settingsActions.onSelectBotSettle(candidate.id);
        }
      }, 120);
    },
    [roster, targetId, settingsActions],
  );

  const applyScrollPosition = React.useCallback(
    (scrollLeft: number): void => {
      const continuousIdx = resolveBotCarouselScrollIndex(
        scrollLeft,
        MOBILE_BOT_CAROUSEL_STEP_PX,
        roster.length,
      );
      const nearestIdx = resolveNearestBotIndex(
        scrollLeft,
        MOBILE_BOT_CAROUSEL_STEP_PX,
        roster.length,
      );
      setVisualScrollIdx(continuousIdx);
      const progTarget = programmaticScrollTargetRef.current;
      if (progTarget !== null) {
        if (Math.abs(scrollLeft - progTarget) <= 2) {
          programmaticScrollTargetRef.current = null;
        }
        return;
      }
      if (nearestIdx !== lastPreviewIdxRef.current) {
        lastPreviewIdxRef.current = nearestIdx;
        setPreviewIdx(nearestIdx);
        onHapticSelection?.();
      }
      scheduleSettle(nearestIdx);
    },
    [roster.length, onHapticSelection, scheduleSettle],
  );

  const handleViewportScroll = (event: React.UIEvent<HTMLDivElement>): void => {
    applyScrollPosition(event.currentTarget.scrollLeft);
  };

  // 桌面鼠标环境无原生横向惯性手势时，允许左键拖拽横向驱动 scrollLeft
  const handleMousePointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.pointerType !== 'mouse' || event.button !== 0) return;
    const el = viewportRef.current ?? event.currentTarget;
    clearTimerRef(settleTimerRef);
    clearTimerRef(movedResetTimerRef);
    programmaticScrollTargetRef.current = null;
    mouseDragRef.current = {
      active: true,
      pointerId: event.pointerId,
      startX: event.clientX,
      startScrollLeft: el?.scrollLeft ?? settledIdx * MOBILE_BOT_CAROUSEL_STEP_PX,
      moved: false,
    };
  };

  const handleMousePointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const drag = mouseDragRef.current;
    if (!drag.active || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.startX;
    if (!drag.moved && Math.abs(dx) >= 6) {
      drag.moved = true;
      setIsDraggingMouse(true);
      try {
        event.currentTarget?.setPointerCapture?.(event.pointerId);
      // gate-degrade: 宿主或浏览器拒绝捕获 pointerId 时按普通拖拽降级
      } catch {
      }
    }
    if (!drag.moved) return;
    const maxScroll = Math.max(0, (roster.length - 1) * MOBILE_BOT_CAROUSEL_STEP_PX);
    const nextLeft = Math.max(0, Math.min(maxScroll, drag.startScrollLeft - dx));
    const el = viewportRef.current ?? event.currentTarget;
    if (el) el.scrollLeft = nextLeft;
    applyScrollPosition(nextLeft);
  };

  const scrollViewportTo = (el: HTMLDivElement | null, targetLeft: number): void => {
    if (!el) return;
    if (Math.abs(el.scrollLeft - targetLeft) <= 1) {
      programmaticScrollTargetRef.current = null;
      return;
    }
    if (typeof el.scrollTo === 'function') {
      programmaticScrollTargetRef.current = targetLeft;
      el.scrollTo({ left: targetLeft, behavior: 'smooth' });
    } else {
      programmaticScrollTargetRef.current = null;
      el.scrollLeft = targetLeft;
    }
  };

  const handleMousePointerEnd = (event: React.PointerEvent<HTMLDivElement>): void => {
    const drag = mouseDragRef.current;
    if (!drag.active || drag.pointerId !== event.pointerId) return;
    const wasMoved = drag.moved;
    drag.active = false;
    setIsDraggingMouse(false);
    try {
      event.currentTarget?.releasePointerCapture?.(event.pointerId);
    // gate-degrade: 未曾捕获 pointerId 时 releasePointerCapture 会抛错，按无操作降级
    } catch {
    }
    if (!wasMoved) return;
    clearTimerRef(settleTimerRef);
    clearTimerRef(movedResetTimerRef);
    const dx = event.clientX - drag.startX;
    const maxScroll = Math.max(0, (roster.length - 1) * MOBILE_BOT_CAROUSEL_STEP_PX);
    const nextLeft = Math.max(0, Math.min(maxScroll, drag.startScrollLeft - dx));
    const nearestIdx = resolveNearestBotIndex(nextLeft, MOBILE_BOT_CAROUSEL_STEP_PX, roster.length);
    scrollViewportTo(viewportRef.current ?? event.currentTarget, nearestIdx * MOBILE_BOT_CAROUSEL_STEP_PX);
    lastPreviewIdxRef.current = nearestIdx;
    setPreviewIdx(nearestIdx);
    setVisualScrollIdx(nearestIdx);
    const candidate = roster[nearestIdx];
    if (candidate && candidate.id.toLowerCase() !== targetId.toLowerCase()) {
      settingsActions.onSelectBotSettle(candidate.id);
    }
    movedResetTimerRef.current = setTimeout(() => {
      movedResetTimerRef.current = null;
      mouseDragRef.current.moved = false;
    }, 0);
  };

  const displayIdx = Math.max(0, Math.min(roster.length - 1, previewIdx));
  const current = roster.length > 0 ? roster[displayIdx] : null;

  const detail =
    current && view.activeDetail && view.activeDetail.id.toLowerCase() === current.id.toLowerCase()
      ? view.activeDetail
      : undefined;
  const draft = detail ? (view.activeDraft ?? draftFromDetail(detail)) : null;
  const dirty = Boolean(detail && draft && isBotDraftDirty(detail, draft));
  const saving = view.status.status === 'saving' || view.isBusy;

  const showOfflineBanner =
    !gatewayConnected && (connectionPhase === undefined || connectionPhase === 'unconfigured');

  if (!current) {
    return (
      <div className="m-bot-hub__scroll" data-testid="mobile-bot-hub">
        {showOfflineBanner ? (
          <button
            type="button"
            className="m-home__offline-banner"
            onClick={onOpenSettingsGateway}
          >
            <span className="m-home__offline-text">{t('mobile.botHub.offlineHint')}</span>
            <span className="m-home__offline-action">{t('mobile.home.offlineAction')}</span>
          </button>
        ) : null}
        <div className="m-bot-hub__empty">
          <p>{t('mobile.botHub.emptyBots')}</p>
          {view.status.status === 'list_error' ? (
            <button type="button" className="m-secondary-btn" onClick={settingsActions.onRetryBotList}>
              {t('bot.retry')}
            </button>
          ) : null}
        </div>
      </div>
    );
  }

  const currentAvatar = resolveBotAvatar(detail?.avatar || current.avatar, draft ?? undefined);
  const currentTitle = resolveBotDisplayTitle(detail?.displayName || current.displayName, current.id, draft ?? undefined);
  const boundModelId = draft?.model ?? current.model ?? '';
  const boundProvider = draft?.provider ?? detail?.provider;
  const modelSummary = boundModelId
    ? resolveShortModelName(boundModelId, modelDetails, boundModelId, boundProvider)
    : t('bot.modelDefault');

  const soulSummary = draft
    ? draft.soul.trim()
      ? t('mobile.botHub.soulLinesSummary', { lines: computeSoulLineCount(draft.soul) })
      : t('mobile.botHub.soulEmptySummary')
    : undefined;

  const skillsSummary =
    detail && draft
      ? t('mobile.botHub.enabledRatio', {
          enabled: detail.skills.rows.filter((r) => !draft.disabledSkills.includes(r.id)).length,
          total: detail.skills.rows.length,
        })
      : undefined;

  const toolsetsSummary =
    detail && draft
      ? t('mobile.botHub.enabledRatio', {
          enabled: countEnabledCapabilities(detail.toolsets, draft.enabledToolsets),
          total: detail.toolsets.rows.length,
        })
      : undefined;

  const mcpSummary =
    detail && draft
      ? t('mobile.botHub.enabledRatio', {
          enabled: countEnabledCapabilities(detail.mcpServers, draft.enabledMcpServers),
          total: detail.mcpServers.rows.length,
        })
      : undefined;

  return (
    <div className="m-bot-hub" data-testid="mobile-bot-hub">
      <div className="m-bot-hub__scroll">
        {showOfflineBanner ? (
          <button
            type="button"
            className="m-home__offline-banner"
            onClick={onOpenSettingsGateway}
          >
            <span className="m-home__offline-text">{t('mobile.botHub.offlineHint')}</span>
            <span className="m-home__offline-action">{t('mobile.home.offlineAction')}</span>
          </button>
        ) : null}

        {view.errorBanner ? (
          <div className="m-bot-banner m-bot-banner--error" role="alert">
            <span className="m-bot-banner__text">{view.errorBanner}</span>
            <button
              type="button"
              className="m-icon-btn"
              aria-label={t('bot.errorBannerDismiss')}
              onClick={settingsActions.onDismissBotError}
            >
              <X size={16} />
            </button>
          </div>
        ) : null}

        {view.confirmPending ? (
          <div className="m-bot-banner m-bot-banner--warn" role="status">
            <span className="m-bot-banner__text">{view.confirmPending.message || t('bot.confirmRequired')}</span>
            <div className="m-settings-btn-row">
              <button type="button" className="m-secondary-btn" onClick={settingsActions.onDismissBotConfirm}>
                {t('bot.confirmDismiss')}
              </button>
              <button
                type="button"
                className="m-primary-btn"
                onClick={() => void settingsActions.onSaveBotConfig(current.id, { confirmExpensive: true })}
              >
                {t('bot.confirmSave')}
              </button>
            </div>
          </div>
        ) : null}

        {view.status.status === 'detail_error' ? (
          <div className="m-bot-banner m-bot-banner--error" role="alert">
            <span className="m-bot-banner__text">{view.status.message}</span>
            <button
              type="button"
              className="m-secondary-btn"
              onClick={() => settingsActions.onSelectBotSettle(current.id)}
            >
              {t('bot.retry')}
            </button>
          </div>
        ) : null}

        {/* 顶部全量连续惯性轮播（支持一拂跨多人滑动 + 中心缩放 + 点击聚焦/下钻） */}
        <div className="m-bot-hero">
          <div
            ref={viewportRef}
            className="m-bot-carousel-viewport m-no-swipe"
            data-gesture-ignore="pan-x"
            data-testid="mobile-bot-carousel"
            data-dragging={isDraggingMouse ? 'true' : 'false'}
            onScroll={handleViewportScroll}
            onTouchStart={() => {
              programmaticScrollTargetRef.current = null;
            }}
            onPointerDown={handleMousePointerDown}
            onPointerMove={handleMousePointerMove}
            onPointerUp={handleMousePointerEnd}
            onPointerCancel={handleMousePointerEnd}
          >
            <div className="m-bot-carousel-track">
              {roster.map((bot, idx) => {
                const visual = computeBotCarouselSlotVisual(idx, visualScrollIdx);
                const isCentered = idx === displayIdx;
                const itemTitle = isCentered ? currentTitle : bot.displayName || bot.id;
                const itemAvatar = isCentered ? currentAvatar : bot.avatar;
                const itemTestId = isCentered
                  ? 'mobile-bot-current'
                  : idx === displayIdx - 1
                    ? 'mobile-bot-prev'
                    : idx === displayIdx + 1
                      ? 'mobile-bot-next'
                      : `mobile-bot-item-${idx}`;
                return (
                  <button
                    key={bot.id}
                    type="button"
                    className="m-bot-carousel__slot"
                    data-testid={itemTestId}
                    data-bot-id={bot.id}
                    data-active={isCentered ? 'true' : 'false'}
                    aria-label={itemTitle}
                    onClick={() => {
                      if (mouseDragRef.current.moved) {
                        mouseDragRef.current.moved = false;
                        return;
                      }
                      if (isCentered) {
                        onSelectBotSubpage('identity');
                        return;
                      }
                      clearTimerRef(settleTimerRef);
                      scrollViewportTo(viewportRef.current, idx * MOBILE_BOT_CAROUSEL_STEP_PX);
                      lastPreviewIdxRef.current = idx;
                      setPreviewIdx(idx);
                      setVisualScrollIdx(idx);
                      onHapticSelection?.();
                      settingsActions.onSelectBotSettle(bot.id);
                    }}
                  >
                    <span
                      className="m-bot-carousel__avatar-scale"
                      data-centered={visual.isCentered ? 'true' : 'false'}
                      style={{
                        transform: `scale(${visual.scale})`,
                        opacity: visual.opacity,
                      }}
                    >
                      <span
                        className="m-bot-carousel__avatar-wrap"
                        aria-hidden="true"
                        dangerouslySetInnerHTML={{
                          __html: renderBotAvatar(bot.id, itemTitle, itemAvatar, 96, 'circle'),
                        }}
                      />
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <h2 className="m-bot-hub__name">{currentTitle}</h2>
          <div className="m-bot-hub__meta">
            {(draft?.isDefault ?? current.isDefault) ? (
              <span className="m-bot-hub__badge">{t('bot.defaultBadge')}</span>
            ) : null}
            <span className="m-bot-hub__model">{modelSummary}</span>
          </div>
          <button
            type="button"
            className="m-bot-hub__chat-btn"
            data-testid="mobile-bot-open-chat"
            onClick={() => onOpenBotChat(current.id)}
          >
            <MessageSquare size={14} aria-hidden="true" />
            <span>{t('mobile.botHub.startChat')}</span>
          </button>
        </div>

        {/* 核心分组菜单 */}
        <div className="m-bot-hub__menus">
          <MobileMenuGroup>
            <MobileMenuCard>
              <MobileMenuRow
                icon={<Cpu size={18} strokeWidth={1.85} />}
                title={t('mobile.botHub.rowModel')}
                summary={modelSummary}
                testId="mobile-bot-row-model"
                onClick={() => onSelectBotSubpage('model')}
              />
              <MobileMenuRow
                icon={<FileCode2 size={18} strokeWidth={1.85} />}
                title={t('mobile.botHub.rowSoul')}
                summary={soulSummary}
                testId="mobile-bot-row-soul"
                onClick={() => onSelectBotSubpage('soul')}
              />
              <MobileMenuRow
                icon={<UserRound size={18} strokeWidth={1.85} />}
                title={t('mobile.botHub.rowIdentity')}
                summary={current.id}
                testId="mobile-bot-row-identity"
                onClick={() => onSelectBotSubpage('identity')}
              />
            </MobileMenuCard>
          </MobileMenuGroup>

          <MobileMenuGroup title={t('mobile.botHub.groupIntegrations')}>
            <MobileMenuCard>
              <MobileMenuRow
                icon={<Blocks size={18} strokeWidth={1.85} />}
                title={t('mobile.botHub.rowSkills')}
                summary={skillsSummary}
                testId="mobile-bot-row-skills"
                onClick={() => onSelectBotSubpage('skills')}
              />
              <MobileMenuRow
                icon={<Wrench size={18} strokeWidth={1.85} />}
                title={t('mobile.botHub.rowToolsets')}
                summary={toolsetsSummary}
                testId="mobile-bot-row-toolsets"
                onClick={() => onSelectBotSubpage('toolsets')}
              />
              <MobileMenuRow
                icon={<Plug size={18} strokeWidth={1.85} />}
                title={t('mobile.botHub.rowMcp')}
                summary={mcpSummary}
                testId="mobile-bot-row-mcp"
                onClick={() => onSelectBotSubpage('mcp')}
              />
            </MobileMenuCard>
          </MobileMenuGroup>

          <MobileMenuGroup title={t('mobile.botHub.groupWork')}>
            <MobileMenuCard>
              <MobileMenuRow
                icon={<Brain size={18} strokeWidth={1.85} />}
                title={t('mobile.botHub.rowMemory')}
                summary={t('mobile.botHub.memoryProtectedSummary')}
                testId="mobile-bot-row-memory"
                onClick={() => onSelectBotSubpage('memory')}
              />
            </MobileMenuCard>
          </MobileMenuGroup>
        </div>
      </div>

      <MobileBotSaveBar
        dirty={dirty}
        saving={saving}
        testId="mobile-bot-save-bar"
        onReset={() => settingsActions.onResetBotDraft(current.id)}
        onSave={() => void settingsActions.onSaveBotConfig(current.id)}
      />
    </div>
  );
}
