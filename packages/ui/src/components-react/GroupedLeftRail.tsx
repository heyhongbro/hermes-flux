/**
 * 桌面端「分组列表」左侧栏（GroupedLeftRail，参考移动端首页三段分组布局）。
 *
 * 【设计意图 (Why)】
 *   在保留传统“微轨 + 抽屉”双轨布局的前提下，新增一套无独立 BOT 边栏、单栏整合
 *   「新建会话按钮 + 搜索框 + BOT / 群聊 / 普通会话 三段平滑折叠分组」的桌面左侧栏，
 *   并在设置 → 外观中开放用户自由切换。
 *
 * 【防范的历史坑 (Pitfall)】
 *   1. UI 高度抽象铁律：BOT、群聊与普通会话三类条目全部复用单一的 `RailEntityRow`，
 *      严禁为分组模式复制第二套行 JSX，防止底色、圆角与字号梯次漂移；
 *   2. 折叠几何差异：经典双轨折叠保留微轨（clamp(56px)+1px），本模式无微轨，
 *      折叠态必须彻底收拢至 0px（rail-collapsed），不渲染抽屉与拖拽把手；
 *   3. 三段标题严格不带数量数字，普通会话大标题严禁显示运行状态动画；
 *   4. 所有间距与圆角严格遵循 4px 整数网格与语义 Token，避免视觉契约违规。
 *
 * 【约束与规则 (Rules)】
 *   - 顶部提供显眼的「新建会话」主入口按钮，直接触发新版新建会话弹窗；
 *   - 分组顺序恒定：BOT → 群聊 → 普通会话；
 *   - 右键菜单严格遵守三态物理隔离（Bot 工位无删除/归档）。
 */

import * as React from 'react';
import { ChevronRight, Plus, Search, X } from 'lucide-react';
import { t } from '../i18n/index.js';
import { useMotionPresence } from '../motion/index.js';
import type { ActivityIndicatorVariant } from '../tokens/activityIndicator.js';
import { Button } from './primitives/Button.js';
import { Input } from './primitives/Input.js';
import { Skeleton } from './primitives/Skeleton.js';
import { Tooltip } from './primitives/Tooltip.js';
import { ActivityIndicator } from './primitives/ActivityIndicator.js';
import {
  Avatar,
  CollageAvatar,
  RailEntityRow,
  RenameGroup,
  type RailRowHoverAction,
} from './RailEntityRow.js';
import {
  RailDoneFooterSection,
  RailOrgContainerSection,
  buildDoneHoverAction,
} from './RailOrgContainers.js';
import { toSnippet, type LeftRailProfile } from './leftRailModel.js';
import type { LeftRailProps } from './LeftRail.js';
import type { GroupedLeftRailModel } from './groupedLeftRailModel.js';
import type {
  MobileBotRowVM,
  MobileGroupRowVM,
  MobileSessionRowVM,
} from './mobile/mobileShellModel.js';

export interface GroupedLeftRailProps extends LeftRailProps {
  groupedModel: GroupedLeftRailModel;
}

interface GroupedSectionProps {
  section: 'bots' | 'groups' | 'sessions';
  triggerId: string;
  listId: string;
  title: string;
  expanded: boolean;
  showRunningStatus: boolean;
  activityVariant?: ActivityIndicatorVariant;
  onToggle?: () => void;
  children: React.ReactNode;
}

function GroupedSection({
  section,
  triggerId,
  listId,
  title,
  expanded,
  showRunningStatus,
  activityVariant,
  onToggle,
  children,
}: GroupedSectionProps): React.ReactElement {
  return (
    <section className="flux-grouped-section mb-2" data-section={section} data-expanded={expanded ? 'true' : 'false'}>
      <button
        type="button"
        id={triggerId}
        aria-expanded={expanded}
        aria-controls={listId}
        aria-label={`${title} ${expanded ? t('rail.collapseSection') : t('rail.expandSection')}`}
        onClick={onToggle}
        className="flex min-h-8 w-full items-center gap-2 rounded-card px-2 py-1 text-left text-aux font-medium text-muted-foreground transition-colors hover:bg-card-hover hover:text-foreground"
      >
        <ChevronRight
          size={14}
          aria-hidden="true"
          className="flux-grouped-section__chevron shrink-0 text-muted-foreground"
        />
        <span className="truncate">{title}</span>
        {showRunningStatus ? (
          <span className="ml-auto flex shrink-0 items-center">
            <ActivityIndicator
              state="running"
              placement="inline"
              entityKind={section === 'bots' ? 'bot' : 'group'}
              variant={activityVariant}
            />
          </span>
        ) : null}
      </button>

      <div
        id={listId}
        aria-hidden={!expanded || undefined}
        className="flux-grouped-section__body"
        data-expanded={expanded ? 'true' : 'false'}
      >
        <div className="flux-grouped-section__body-inner">
          <div className="flex flex-col gap-1 pt-1">{children}</div>
        </div>
      </div>
    </section>
  );
}

const GroupedBotRow = React.memo(function GroupedBotRow({
  row,
  activityVariant,
  onSelect,
  onMenu,
}: {
  row: MobileBotRowVM;
  activityVariant?: ActivityIndicatorVariant;
  onSelect: () => void;
  onMenu: (x: number, y: number) => void;
}): React.ReactElement {
  return (
    <RailEntityRow
      className="rail-pinned-bot-row rail-grouped-bot-row"
      active={row.isActive}
      avatar={<Avatar profile={row.profile} size={36} shape="circle" />}
      title={row.title}
      subtitle={row.subtitle || t('rail.defaultBotSnippet')}
      timestamp={row.profile.timestamp}
      timeFallback={row.timeText}
      activityState={row.activityState}
      activityTransition={row.activityTransition}
      activityTransitionToken={row.activityTransitionToken}
      entityKind="bot"
      activityVariant={activityVariant}
      titleAttr={t('rail.enterBotChat', { name: row.title })}
      onClick={onSelect}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onMenu(event.clientX, event.clientY);
      }}
      dataAttributes={{
        'data-profile': row.id,
      }}
    />
  );
}, (prev, next) => prev.row === next.row && prev.activityVariant === next.activityVariant);

const GroupedGroupRow = React.memo(function GroupedGroupRow({
  row,
  profiles,
  editing,
  activityVariant,
  hoverAction,
  className,
  onSelect,
  onMenu,
  onConfirmRename,
  onCancelRename,
}: {
  row: MobileGroupRowVM;
  profiles: LeftRailProfile[];
  editing: boolean;
  activityVariant?: ActivityIndicatorVariant;
  hoverAction?: RailRowHoverAction;
  className?: string;
  onSelect: () => void;
  onMenu: (x: number, y: number) => void;
  onConfirmRename: (name: string) => void;
  onCancelRename: () => void;
}): React.ReactElement {
  if (editing) {
    return (
      <div
        className="rail-group-item rail-group-inline-rename-wrap active flex min-h-12 items-center rounded-card bg-card-active px-2"
        data-room-id={row.id}
      >
        <RenameGroup
          initialName={row.title}
          roomId={row.id}
          onConfirm={onConfirmRename}
          onCancel={onCancelRename}
        />
      </div>
    );
  }
  return (
    <RailEntityRow
      className={className ? `rail-group-item ${className}` : 'rail-group-item'}
      active={row.isActive}
      avatar={<CollageAvatar members={row.members} profiles={profiles} size={36} />}
      title={row.title}
      subtitle={row.subtitle || t('rail.groupsMembers', { count: String(row.members.length) })}
      timestamp={row.group.updatedAt || row.group.createdAt}
      timeFallback={row.timeText}
      activityState={row.activityState}
      activityTransition={row.activityTransition}
      activityTransitionToken={row.activityTransitionToken}
      entityKind="group"
      activityVariant={activityVariant}
      hoverAction={hoverAction}
      onClick={onSelect}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onMenu(event.clientX, event.clientY);
      }}
      dataAttributes={{
        'data-room-id': row.id,
      }}
    />
  );
}, (prev, next) =>
  prev.row === next.row &&
  prev.profiles === next.profiles &&
  prev.editing === next.editing &&
  prev.activityVariant === next.activityVariant &&
  prev.hoverAction?.label === next.hoverAction?.label &&
  prev.className === next.className);

const GroupedSessionRow = React.memo(function GroupedSessionRow({
  row,
  activityVariant,
  hoverAction,
  className,
  onSelect,
  onMenu,
}: {
  row: MobileSessionRowVM;
  activityVariant?: ActivityIndicatorVariant;
  hoverAction?: RailRowHoverAction;
  className?: string;
  onSelect: () => void;
  onMenu: (x: number, y: number) => void;
}): React.ReactElement {
  return (
    <RailEntityRow
      className={className ? `session-item ${className}` : 'session-item'}
      active={row.isActive}
      avatar={
        <Avatar
          profile={{
            name: row.ownerBotName,
            displayName: row.ownerBotDisplayName,
            avatar: row.ownerAvatarUrl,
          }}
          size={36}
          shape="circle"
        />
      }
      title={row.title}
      subtitle={row.subtitle || toSnippet(row.title)}
      timestamp={row.session.timestamp}
      timeFallback={row.timeText}
      activityState={row.activityState}
      activityTransition={row.activityTransition}
      activityTransitionToken={row.activityTransitionToken}
      entityKind="session"
      activityVariant={activityVariant}
      hoverAction={hoverAction}
      onClick={onSelect}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onMenu(event.clientX, event.clientY);
      }}
      dataAttributes={{
        'data-id': row.id,
        'data-title': row.title,
        'data-bot': row.ownerBotName,
      }}
    />
  );
}, (prev, next) =>
  prev.row === next.row &&
  prev.activityVariant === next.activityVariant &&
  prev.hoverAction?.label === next.hoverAction?.label &&
  prev.className === next.className);

/**
 * 桌面端单栏分组左侧栏（BOT → 群聊 → 普通会话）。
 */
export function GroupedLeftRail(props: GroupedLeftRailProps): React.ReactElement {
  const { groupedModel } = props;
  const {
    botsSection,
    projectSections,
    folderSections,
    groupsSection,
    sessionsSection,
    doneSection,
    showDoneSection,
  } = groupedModel;
  const profilesLoading = groupedModel.profilesPhase === 'loading';
  const sessionsLoading = groupedModel.sessionsPhase === 'loading';
  const drawerPresence = useMotionPresence(!props.collapsed);
  const railWidth = props.collapsed ? '0px' : 'var(--rail-w-left, 264px)';

  const renderMixedEntry = (
    item: MobileGroupRowVM | MobileSessionRowVM,
    isDoneRow: boolean,
  ): React.ReactElement => {
    const rowClass = isDoneRow ? 'opacity-75' : undefined;
    if (item.kind === 'group') {
      return (
        <GroupedGroupRow
          key={`${isDoneRow ? 'done-' : ''}group-${item.id}`}
          row={item}
          profiles={props.groupAvatars || []}
          editing={props.editingGroupRoomId === item.id}
          activityVariant={props.activityVariant}
          className={rowClass}
          hoverAction={buildDoneHoverAction({
            isDone: isDoneRow,
            title: item.title,
            onRequestMarkDone: props.onRequestMarkDone
              ? () => props.onRequestMarkDone?.('group', item.id, item.title)
              : undefined,
            onRestoreDone: props.onRestoreDone
              ? () => props.onRestoreDone?.('group', item.id)
              : undefined,
          })}
          onSelect={() => props.onSelectGroup(item.id)}
          onMenu={(x, y) => props.onOpenGroupMenu(item.id, item.title, x, y)}
          onConfirmRename={(name) => props.onConfirmGroupRename(item.id, name)}
          onCancelRename={props.onCancelGroupRename}
        />
      );
    }
    return (
      <GroupedSessionRow
        key={`${isDoneRow ? 'done-' : ''}session-${item.ownerBotName || 'default'}-${item.id}`}
        row={item}
        activityVariant={props.activityVariant}
        className={rowClass}
        hoverAction={buildDoneHoverAction({
          isDone: isDoneRow,
          title: item.title,
          onRequestMarkDone: props.onRequestMarkDone
            ? () => props.onRequestMarkDone?.('session', item.id, item.title, item.ownerBotName)
            : undefined,
          onRestoreDone: props.onRestoreDone
            ? () => props.onRestoreDone?.('session', item.id, item.ownerBotName)
            : undefined,
        })}
        onSelect={() => props.onSelectSession(item.id, item.ownerBotName)}
        onMenu={(x, y) => props.onOpenSessionMenu(item.id, item.title, x, y, item.ownerBotName)}
      />
    );
  };

  return (
    <aside
      id="flux-left-rail"
      data-testid="react-left-rail"
      data-rail-layout="grouped"
      className={`flux-left-rail relative flex h-full flex-col overflow-hidden bg-sidebar ${
        props.collapsed ? 'rail-collapsed border-r-0' : 'border-r border-border-subtle'
      }`}
      style={{ flex: `0 0 ${railWidth}`, width: railWidth, minWidth: railWidth, maxWidth: railWidth }}
    >
      {drawerPresence.isMounted && (
        <div
          className="flux-context-drawer flex min-h-0 w-full min-w-0 flex-1 flex-col overflow-hidden bg-sidebar"
          {...drawerPresence.motionProps}
        >
          {/* 顶部操作区：单行纯哑光胶囊搜索框 + 圆形新建会话按钮（同步让出右侧 6px 拖拽把手带） */}
          <div className="flux-grouped-top-actions flex items-center gap-2 px-2 py-2">
            <div className="relative min-w-0 flex-1">
              <Search
                size={14}
                strokeWidth={1.8}
                aria-hidden="true"
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                id="session-search-input"
                size="sm"
                aria-label={t('rail.searchPlaceholder')}
                placeholder={t('rail.searchShortPlaceholder')}
                value={props.searchQuery}
                onChange={(event) => props.onSearchChange(event.currentTarget.value)}
                className={`h-8 w-full rounded-full border border-border-subtle bg-card pl-8 text-aux text-foreground shadow-card transition-colors placeholder:text-muted-foreground hover:border-border focus-visible:border-border-strong focus-visible:ring-0 ${
                  props.searchQuery ? 'pr-8' : 'pr-3'
                }`}
              />
              {props.searchQuery ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={t('rail.clearSearch')}
                  className="absolute right-1 top-1/2 -translate-y-1/2 rounded-full text-muted-foreground hover:text-foreground"
                  onClick={() => props.onSearchChange('')}
                >
                  <X size={12} aria-hidden="true" />
                </Button>
              ) : null}
            </div>

            <Tooltip content={t('rail.newChat')} placement="bottom">
              <Button
                id="rail-grouped-new-chat-btn"
                data-testid="rail-new-chat-btn"
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={t('rail.newChat')}
                className="shrink-0 rounded-full border border-border-subtle bg-card text-foreground shadow-card transition-colors hover:border-border hover:bg-card-hover active:bg-card-active"
                onClick={() => props.onNewChat('session')}
              >
                <Plus size={16} strokeWidth={2} aria-hidden="true" />
              </Button>
            </Tooltip>
          </div>

          <div
            id="session-list-container"
            className="session-scroll-area scrollbar-none min-h-0 flex-1 overflow-y-auto px-2 pb-3"
            onContextMenu={(event) => {
              if (!props.onOpenRailMenu) return;
              if (
                event.target instanceof Element &&
                event.target.closest(
                  '[data-section="bots"], [data-entity-row], [data-container-id], .rail-pinned-bot-row, .session-item, .rail-group-item, button, input',
                )
              ) {
                return;
              }
              event.preventDefault();
              props.onOpenRailMenu(event.clientX, event.clientY);
            }}
          >
            {groupedModel.error ? (
              <div
                id="session-list-error"
                role="alert"
                className="m-1 rounded-card border border-border-strong bg-panel p-2 text-aux text-foreground"
              >
                {groupedModel.error}
              </div>
            ) : null}

            {/* 1. BOT 分组 */}
            <GroupedSection
              section="bots"
              triggerId="rail-bots-accordion-trigger"
              listId="rail-bots-nested-list"
              title={t(botsSection.titleKey)}
              expanded={botsSection.effectiveExpanded}
              showRunningStatus={Boolean(botsSection.headerStatus)}
              activityVariant={props.activityVariant}
              onToggle={props.onToggleBots}
            >
              {profilesLoading ? (
                <>
                  {[0, 1].map((slot) => (
                    <RailEntityRow
                      key={`bot-skeleton-${slot}`}
                      active={false}
                      loading
                      skeletonSlot="bot"
                      avatar={<Skeleton className="size-9 shrink-0 rounded-full" />}
                      title=""
                    />
                  ))}
                </>
              ) : botsSection.items.length === 0 ? (
                !groupedModel.isSearching ? (
                  <div className="px-2 py-2 text-caption text-muted-foreground">{t('rail.emptyBots')}</div>
                ) : null
              ) : (
                botsSection.items.map((row) => (
                  <GroupedBotRow
                    key={`bot-${row.id}`}
                    row={row}
                    activityVariant={props.activityVariant}
                    onSelect={() => props.onSelectBot(row.id)}
                    onMenu={(x, y) => props.onOpenBotMenu(row.id, x, y)}
                  />
                ))
              )}
            </GroupedSection>

            {/* 2. 扁平顶级项目 + 自定义文件夹 */}
            {[...projectSections, ...folderSections].map((bucket) => (
              <RailOrgContainerSection
                key={bucket.containerId}
                kind={bucket.kind}
                id={bucket.id}
                containerId={bucket.containerId}
                name={bucket.name}
                color={bucket.color}
                expanded={bucket.effectiveExpanded}
                isSearching={groupedModel.isSearching}
                isEmpty={bucket.items.length === 0}
                onToggle={() => props.onToggleContainer?.(bucket.containerId)}
                onNewChat={
                  props.onNewChatInContainer
                    ? () => props.onNewChatInContainer?.('session', bucket.containerId)
                    : undefined
                }
                onOpenFolderMenu={
                  bucket.kind === 'folder' && props.onOpenFolderMenu
                    ? (x, y) => props.onOpenFolderMenu?.(bucket.id, bucket.name, x, y)
                    : undefined
                }
              >
                {bucket.items.map((item) => renderMixedEntry(item, false))}
              </RailOrgContainerSection>
            ))}

            {/* 3. 未归类群聊分组（群聊列表为空或全部已归入项目/文件夹时自动隐藏整个群聊分组） */}
            {groupsSection.items.length > 0 && (
              <GroupedSection
                section="groups"
                triggerId="rail-groups-accordion-trigger"
                listId="rail-groups-nested-list"
                title={t(groupsSection.titleKey)}
                expanded={groupsSection.effectiveExpanded}
                showRunningStatus={Boolean(groupsSection.headerStatus)}
                activityVariant={props.activityVariant}
                onToggle={props.onToggleGroups}
              >
                {groupsSection.items.map((row) => renderMixedEntry(row, false))}
              </GroupedSection>
            )}

            {/* 4. 未归类普通会话分组（大标题严禁显示状态动画；行头像继承所属 Bot 头像） */}
            <GroupedSection
              section="sessions"
              triggerId="rail-sessions-accordion-trigger"
              listId="rail-sessions-nested-list"
              title={t(sessionsSection.titleKey)}
              expanded={sessionsSection.effectiveExpanded}
              showRunningStatus={false}
              activityVariant={props.activityVariant}
              onToggle={props.onToggleSessions}
            >
              {sessionsLoading ? (
                <>
                  {[0, 1, 2].map((slot) => (
                    <RailEntityRow
                      key={`session-skeleton-${slot}`}
                      className="session-item"
                      active={false}
                      loading
                      skeletonSlot="session"
                      avatar={<Skeleton className="size-9 shrink-0 rounded-full" />}
                      title=""
                    />
                  ))}
                </>
              ) : sessionsSection.items.length > 0 ? (
                sessionsSection.items.map((row) => renderMixedEntry(row, false))
              ) : !groupedModel.isSearching && projectSections.length === 0 && folderSections.length === 0 ? (
                <div className="flex flex-col items-center gap-1 px-2 py-4 text-center">
                  <span className="text-aux text-muted-foreground">
                    {groupedModel.error ? t('rail.errorTitle') : t('rail.emptyTitle')}
                  </span>
                  <span className="text-caption text-muted-foreground">
                    {groupedModel.error ? t('rail.errorSub') : t('rail.emptySub')}
                  </span>
                </div>
              ) : null}
            </GroupedSection>

            {groupedModel.isSearching && !groupedModel.hasAnyResult ? (
              <div className="px-2 py-4 text-center text-caption text-muted-foreground">
                {t('rail.emptySearch')}
              </div>
            ) : null}
          </div>

          {showDoneSection ? (
            <RailDoneFooterSection
              expanded={doneSection.effectiveExpanded}
              loading={doneSection.loading}
              error={doneSection.error}
              isEmpty={doneSection.items.length === 0}
              onToggle={props.onToggleDoneSection ?? (() => props.onToggleContainer?.('done'))}
              onRetry={props.onRetryDoneSection}
            >
              {doneSection.items.map((item) => renderMixedEntry(item, true))}
            </RailDoneFooterSection>
          ) : null}
        </div>
      )}

      {!props.collapsed && (
        <div
          className="rail-resize-handle absolute right-0 top-0 z-50 h-full cursor-col-resize touch-none"
          data-rail-handle="left"
          role="separator"
          aria-orientation="vertical"
          tabIndex={0}
          title={t('rail.resizeHandleTitle')}
          onPointerDown={props.onResizeStart}
        />
      )}
    </aside>
  );
}
