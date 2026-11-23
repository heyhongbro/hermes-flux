/**
 * 移动端首屏：对话列表 + Bot Hub 双视图切换与悬浮顶栏 (MobileHomeScreen)
 *
 * 【设计意图 (Why)】
 *   1. 顶部全面取消传统实底矩形顶栏，升级为高透气“悬浮胶囊控制群”：
 *      - 左上悬浮胶囊切换器：[对话气泡] ⇄ [4点 Bot Hub 图标]；
 *      - 右上悬浮圆形按钮群：在「对话」页呈现 [搜索] [+] [设置]；在「Bot」页呈现 [新建 Bot +] [设置]；
 *   2. 「对话」页维持三段无分割线可折叠列表（智能体 / 群聊 / 普通会话）与统一 `MobileEntityRow`；
 *   3. 「Bot」页承接专职数字员工中心 `MobileBotHubScreen`（头像轮播 + 分组能力菜单）。
 *
 * 【防范的历史坑 (Pitfall)】
 *   1. 顶部悬浮控制群位于内容上方，所有滚动区必须预留顶部安全距离，且控制胶囊与分段按钮须声明 `.m-no-swipe` 与 `>=44px` 热区；
 *   2. 禁止用 `--panel` 叠压白底卡片造成浅色模式 `jade-white` 对比丢失。
 *
 * 【约束与规则 (Rules)】
 *   - 严格三态会话隔离（Bot / 群聊 / 普通会话）与 i18n 全覆盖。
 */

import * as React from 'react';
import { ChevronRight, MessageSquare, Plus, Search, Settings } from 'lucide-react';
import { t } from '../../i18n/index.js';
import { renderBotAvatar, renderGroupCollageAvatar } from '../../utils/botAvatar.js';
import { ActivityIndicator } from '../primitives/ActivityIndicator.js';
import type { LeftRailProfile } from '../leftRailModel.js';
import type { SettingsActions, SettingsSnapshot } from '../settings/settingsModel.js';
import type { MobileBotSubpage, MobileHomeModel, MobileHomeTab } from './mobileShellModel.js';
import { MobileEntityRow } from './MobileEntityRow.js';
import { MobileBotHubScreen } from './MobileBotHubScreen.js';
import type { MobileActionSheetState, MobileModelOption } from './types.js';

export interface MobileHomeScreenProps {
  homeTab: MobileHomeTab;
  model: MobileHomeModel;
  allProfiles: LeftRailProfile[];
  groupAvatars: LeftRailProfile[];
  activeBotName: string;
  gatewayConnected: boolean;
  gatewayConnecting: boolean;
  searchOpen: boolean;
  settingsSnapshot: SettingsSnapshot;
  modelDetails: MobileModelOption[];
  onSelectHomeTab: (tab: MobileHomeTab) => void;
  onSelectBotSubpage: (subpage: Exclude<MobileBotSubpage, null>) => void;
  onOpenSettings: () => void;
  onOpenSettingsGateway: () => void;
  onOpenSearch: () => void;
  onCloseSearch: () => void;
  onSearchChange: (value: string) => void;
  onOpenNewChat: () => void;
  onToggleSection: (section: 'bots' | 'groups' | 'sessions') => void;
  onSelectBot: (botName: string) => void;
  onSelectGroup: (roomId: string) => void;
  onSelectSession: (sessionId: string, botName?: string) => void;
  onOpenActionSheet: (sheet: MobileActionSheetState) => void;
  onHapticSelection?: () => void;
  settingsActions: SettingsActions;
}

/** 4 点棱形排列的 Bot Hub 图标（对齐参考图左上角分段开关形态） */
function BotHubDotsIcon(): React.ReactElement {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="12" cy="5.5" r="2.2" />
      <circle cx="5.5" cy="12" r="2.2" />
      <circle cx="18.5" cy="12" r="2.2" />
      <circle cx="12" cy="18.5" r="2.2" />
    </svg>
  );
}

export function MobileHomeScreen({
  homeTab,
  model,
  allProfiles,
  groupAvatars,
  activeBotName,
  gatewayConnected,
  gatewayConnecting,
  searchOpen,
  settingsSnapshot,
  modelDetails,
  onSelectHomeTab,
  onSelectBotSubpage,
  onOpenSettings,
  onOpenSettingsGateway,
  onOpenSearch,
  onCloseSearch,
  onSearchChange,
  onOpenNewChat,
  onToggleSection,
  onSelectBot,
  onSelectGroup,
  onSelectSession,
  onOpenActionSheet,
  onHapticSelection,
  settingsActions,
}: MobileHomeScreenProps): React.ReactElement {
  const searchInputRef = React.useRef<HTMLInputElement | null>(null);

  React.useEffect(() => {
    if (searchOpen) {
      searchInputRef.current?.focus();
    }
  }, [searchOpen]);

  const { botsSection, groupsSection, sessionsSection } = model;

  return (
    <section className="m-pane m-home" aria-label={t('mobile.section.sessions')}>
      <header className="m-float-topbar">
        {homeTab === 'chats' && searchOpen ? (
          <div className="m-float-search-bar m-no-swipe">
            <Search size={16} className="m-home__search-icon" aria-hidden="true" />
            <input
              ref={searchInputRef}
              type="search"
              className="m-home__search-input"
              value={model.searchQuery}
              placeholder={t('mobile.home.searchPlaceholder')}
              onChange={(e) => onSearchChange(e.target.value)}
            />
            <button
              type="button"
              className="m-home__search-cancel"
              onClick={onCloseSearch}
            >
              {t('mobile.home.cancelSearch')}
            </button>
          </div>
        ) : (
          <>
            <div
              className="m-float-seg m-no-swipe"
              role="tablist"
              data-testid="mobile-home-tab-switcher"
              aria-label={t('mobile.botHub.title')}
            >
              <button
                type="button"
                role="tab"
                aria-selected={homeTab === 'chats'}
                aria-label={t('mobile.home.tabChats')}
                data-testid="mobile-tab-chats"
                className="m-float-seg__btn"
                data-active={homeTab === 'chats' ? 'true' : 'false'}
                onClick={() => onSelectHomeTab('chats')}
              >
                <MessageSquare size={17} strokeWidth={1.9} />
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={homeTab === 'bots'}
                aria-label={t('mobile.home.tabBots')}
                data-testid="mobile-tab-bots"
                className="m-float-seg__btn"
                data-active={homeTab === 'bots' ? 'true' : 'false'}
                onClick={() => onSelectHomeTab('bots')}
              >
                <BotHubDotsIcon />
              </button>
            </div>

            <div className="m-float-topbar__right m-no-swipe">
              {homeTab === 'chats' ? (
                <>
                  <button
                    type="button"
                    className="m-float-circle-btn"
                    data-testid="mobile-search-trigger"
                    aria-label={t('mobile.home.searchAria')}
                    onClick={onOpenSearch}
                  >
                    <Search size={18} strokeWidth={1.85} />
                  </button>
                  <button
                    type="button"
                    className="m-float-circle-btn"
                    data-testid="mobile-new-chat-trigger"
                    aria-label={t('mobile.home.newChatAria')}
                    onClick={onOpenNewChat}
                  >
                    <Plus size={20} strokeWidth={1.95} />
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="m-float-circle-btn"
                  data-testid="mobile-bot-create-trigger"
                  aria-label={t('mobile.home.createBotAria')}
                  onClick={() => settingsActions.onOpenBotWizard('blank')}
                >
                  <Plus size={20} strokeWidth={1.95} />
                </button>
              )}
              <button
                type="button"
                className="m-float-circle-btn"
                data-testid="mobile-settings-trigger"
                aria-label={t('mobile.home.settingsAria')}
                onClick={onOpenSettings}
              >
                <Settings size={18} strokeWidth={1.85} />
              </button>
            </div>
          </>
        )}
      </header>

      {homeTab === 'bots' ? (
        <MobileBotHubScreen
          allProfiles={allProfiles}
          activeBotName={activeBotName}
          gatewayConnected={gatewayConnected}
          settingsSnapshot={settingsSnapshot}
          modelDetails={modelDetails}
          onSelectBotSubpage={onSelectBotSubpage}
          onOpenBotChat={onSelectBot}
          onOpenSettingsGateway={onOpenSettingsGateway}
          onHapticSelection={onHapticSelection}
          settingsActions={settingsActions}
        />
      ) : (
        <div className="m-home__scroll">
        {!gatewayConnected ? (
          <button
            type="button"
            className="m-home__offline-banner"
            onClick={onOpenSettings}
          >
            <span className="m-home__offline-text">
              {gatewayConnecting ? t('mobile.settings.statusConnecting') : t('mobile.home.offlineTitle')}
            </span>
            <span className="m-home__offline-action">{t('mobile.home.offlineAction')}</span>
          </button>
        ) : null}

        {/* 1. 智能体分区 */}
        <div className="m-section" data-section="bots" data-expanded={botsSection.effectiveExpanded ? 'true' : 'false'}>
          <button
            type="button"
            className="m-section__header"
            aria-expanded={botsSection.effectiveExpanded}
            onClick={() => onToggleSection('bots')}
          >
            <ChevronRight size={14} className="m-section__chevron" aria-hidden="true" />
            <span className="m-section__title">{t(botsSection.titleKey)}</span>
            <span className="m-section__tail">
              {botsSection.headerStatus ? (
                <ActivityIndicator
                  state="running"
                  placement="inline"
                  entityKind="bot"
                  variant="prolate-lattice"
                />
              ) : null}
            </span>
          </button>

          <div className="m-section__body" data-expanded={botsSection.effectiveExpanded ? 'true' : 'false'}>
            <div className="m-section__body-inner">
              {botsSection.items.length === 0 ? (
                !model.isSearching ? <div className="m-section__empty">{t('mobile.home.emptyBots')}</div> : null
              ) : (
                botsSection.items.map((row) => (
                  <MobileEntityRow
                    key={`bot-${row.id}`}
                    kind="bot"
                    entityId={row.id}
                    title={row.title}
                    subtitle={row.subtitle}
                    timeText={row.timeText}
                    avatarHtml={renderBotAvatar(row.profile.name, row.profile.displayName, row.avatarUrl, 40, 'circle')}
                    isActive={row.isActive}
                    activityState={row.activityState}
                    activityTransition={row.activityTransition}
                    activityTransitionToken={row.activityTransitionToken}
                    onSelect={() => onSelectBot(row.id)}
                    onLongPress={() =>
                      onOpenActionSheet({ kind: 'bot', id: row.id, title: row.title, isProtected: true })
                    }
                  />
                ))
              )}
            </div>
          </div>
        </div>

        {/* 2. 群聊分区 */}
        <div className="m-section" data-section="groups" data-expanded={groupsSection.effectiveExpanded ? 'true' : 'false'}>
          <button
            type="button"
            className="m-section__header"
            aria-expanded={groupsSection.effectiveExpanded}
            onClick={() => onToggleSection('groups')}
          >
            <ChevronRight size={14} className="m-section__chevron" aria-hidden="true" />
            <span className="m-section__title">{t(groupsSection.titleKey)}</span>
            <span className="m-section__tail">
              {groupsSection.headerStatus ? (
                <ActivityIndicator
                  state="running"
                  placement="inline"
                  entityKind="group"
                  variant="prolate-lattice"
                />
              ) : null}
            </span>
          </button>

          <div className="m-section__body" data-expanded={groupsSection.effectiveExpanded ? 'true' : 'false'}>
            <div className="m-section__body-inner">
              {groupsSection.items.length === 0 ? (
                !model.isSearching ? <div className="m-section__empty">{t('mobile.home.emptyGroups')}</div> : null
              ) : (
                groupsSection.items.map((row) => (
                  <MobileEntityRow
                    key={`group-${row.id}`}
                    kind="group"
                    entityId={row.id}
                    title={row.title}
                    subtitle={row.subtitle || t('mobile.home.groupMembersCount', { count: row.members.length })}
                    timeText={row.timeText}
                    avatarHtml={renderGroupCollageAvatar(row.members, groupAvatars, 40)}
                    isActive={row.isActive}
                    activityState={row.activityState}
                    activityTransition={row.activityTransition}
                    activityTransitionToken={row.activityTransitionToken}
                    onSelect={() => onSelectGroup(row.id)}
                    onLongPress={() => onOpenActionSheet({ kind: 'group', id: row.id, title: row.title })}
                  />
                ))
              )}
            </div>
          </div>
        </div>

        {/* 3. 普通会话分区（大标题不显示状态动画，头像继承归属 Bot 头像） */}
        <div className="m-section" data-section="sessions" data-expanded={sessionsSection.effectiveExpanded ? 'true' : 'false'}>
          <button
            type="button"
            className="m-section__header"
            aria-expanded={sessionsSection.effectiveExpanded}
            onClick={() => onToggleSection('sessions')}
          >
            <ChevronRight size={14} className="m-section__chevron" aria-hidden="true" />
            <span className="m-section__title">{t(sessionsSection.titleKey)}</span>
          </button>

          <div className="m-section__body" data-expanded={sessionsSection.effectiveExpanded ? 'true' : 'false'}>
            <div className="m-section__body-inner">
              {sessionsSection.items.length === 0 ? (
                !model.isSearching ? <div className="m-section__empty">{t('mobile.home.emptySessions')}</div> : null
              ) : (
                sessionsSection.items.map((row) => (
                  <MobileEntityRow
                    key={`session-${row.id}`}
                    kind="session"
                    entityId={row.id}
                    title={row.title}
                    subtitle={row.subtitle}
                    timeText={row.timeText}
                    avatarHtml={renderBotAvatar(
                      row.ownerBotName,
                      row.ownerBotDisplayName,
                      row.ownerAvatarUrl,
                      40,
                      'circle',
                    )}
                    isActive={row.isActive}
                    isPinned={row.isPinned}
                    activityState={row.activityState}
                    activityTransition={row.activityTransition}
                    activityTransitionToken={row.activityTransitionToken}
                    onSelect={() => onSelectSession(row.id, row.ownerBotName)}
                    onLongPress={() => onOpenActionSheet({ kind: 'session', id: row.id, title: row.title })}
                  />
                ))
              )}
            </div>
          </div>
        </div>

        {model.isSearching && !model.hasAnyResult ? (
          <div className="m-home__search-empty">{t('mobile.home.emptySearch')}</div>
        ) : null}
        </div>
      )}
    </section>
  );
}
