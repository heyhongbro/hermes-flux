/**
 * 移动端壳层视图模型与纯状态机（Mobile Shell ViewModel & State Machine）。
 *
 * 【设计意图 (Why)】
 *   遵循「底层 100% 同构共享，仅最上层表现壳按端分流」的架构原则，本模块以零 DOM / 零 React
 *   的纯 TypeScript 沉淀移动端五大核心裁决：
 *   1. `resolveWorkspaceShellMode`：依据运行平台、移动桥接注入与 URL 覆盖参数，决定启用移动端壳还是桌面端三栏；
 *   2. `resolveMobileSkinId` / `inferMobileAppearanceFromTheme`：收敛移动端纯哑光双皮肤（深邃哑光黑 / 暖白纸感）与跟随系统映射；
 *   3. `buildMobileHomeModel`：打破桌面左轨按单一 Bot 过滤会话的限制，聚合全量智能体、群聊与普通会话（普通会话自动继承归属 Bot 头像），并严格约束「标题无数量」「普通会话标题无状态动画」；
 *   4. `reduceMobileBackAction`：统一规范 Android 物理返回键与 iOS 边缘手势的多层退出优先级队列；
 *   5. 全量可被 Node 单元测试直接断言，具备 100% 变异杀伤力。
 *
 * 【防范的历史坑 (Pitfall)】
 *   1. 若桌面窄窗口被误判为 `mobile` 壳层，既有桌面 `@media (max-width: 768px)` 单测与桌面布局会被破坏；因此只有原生移动平台（android/ios）、Capacitor 移动桥接存在或显式 `?shell=mobile` 才切入移动壳；
 *   2. 普通会话行若直接读取 `session.botAvatar` 而在缓存恢复期该字段为空，列表头像会退化为默认图标；必须在构建模型时通过 `botName` 回查全量 `profiles` 补全归属 Bot 的头像与显示名；
 *   3. `普通会话` 分组标题禁止出现状态动画，哪怕折叠态下有会话正在执行——只有具体会话行与折叠态下的 `智能体 / 群聊` 分组标题才允许出现。
 *
 * 【约束与规则 (Rules)】
 *   - 严禁引入 `react`、DOM API 或 `@hermes-flux/desktop`；
 *   - 所有时间格式化与文案输出统一委托共享 helper（`formatLeftRailTime`、`toSnippet`）与 `I18nKey`。
 */

import { SKINS, SKIN_ALIASES } from '../../tokens/skins.js';
import type { I18nKey } from '../../i18n/index.js';
import type { OrgContainerCollapseState } from '../../tokens/conversationOrgPrefs.js';
import type { WaitingPromptReason } from '@hermes-flux/core';
import type { MobileActionSheetStep } from './types.js';
import {
  partitionRailOrgEntities,
  type PartitionedContainerBucket,
} from '../railOrgPartition.js';
import {
  formatLeftRailTime,
  toSnippet,
  type ActivityState,
  type ActivityTransition,
  type DataPhase,
  type LeftRailActiveFocus,
  type LeftRailFolder,
  type LeftRailGroupRoom,
  type LeftRailProfile,
  type LeftRailProject,
  type LeftRailSession,
} from '../leftRailModel.js';

export type WorkspaceShellMode = 'mobile' | 'desktop';
export type MobilePaneId = 'home' | 'stage' | 'inspector';
export type MobileHomeTab = 'chats' | 'bots';
export type MobileInspectorTab = 'artifacts' | 'diffs' | 'files' | 'memory';
export type MobileAppearancePreference = 'dark' | 'light' | 'system';
export type MobileSkinId = 'obsidian-gold' | 'jade-white';
export type MobileNewChatStep = 'compose' | 'group-members';
export type MobileSettingsSubpage =
  | 'appearance'
  | 'projects'
  | 'gateway'
  | 'providers'
  | 'extensions'
  | 'about'
  | null;
export type MobileBotSubpage = 'identity' | 'model' | 'soul' | 'skills' | 'toolsets' | 'mcp' | 'memory' | null;

export interface ShellModeResolveInput {
  platform: string;
  hasMobileBridge?: boolean;
  search?: string;
}

/**
 * 裁决工作台顶层表现壳模式：移动端原生/模拟进入 `mobile` 三屏手势壳，其余保持 `desktop` 三栏。
 */
export function resolveWorkspaceShellMode(input: ShellModeResolveInput): WorkspaceShellMode {
  if (input.search) {
    try {
      const normalized = input.search.startsWith('?') ? input.search : `?${input.search}`;
      const override = new URLSearchParams(normalized).get('shell');
      if (override === 'desktop') return 'desktop';
      if (override === 'mobile') return 'mobile';
    // gate-degrade: 非标准查询串解析异常时忽略 URL 覆盖，回落平台判定
    } catch {}
  }
  const normalizedPlatform = (input.platform || '').toLowerCase();
  if (normalizedPlatform === 'android' || normalizedPlatform === 'ios') {
    return 'mobile';
  }
  if (input.hasMobileBridge) {
    return 'mobile';
  }
  return 'desktop';
}

/**
 * 从任意皮肤 ID 推断移动端的二元极性（深邃哑光黑 或 暖白纸感）。
 */
export function inferMobileAppearanceFromTheme(theme: string | null | undefined): 'dark' | 'light' {
  const canonical = SKIN_ALIASES[theme || ''] ?? theme ?? 'obsidian-gold';
  const skin = SKINS[canonical];
  return skin?.variant === 'light' ? 'light' : 'dark';
}

/**
 * 移动端双皮肤唯一真值映射：`dark` -> `obsidian-gold`，`light` -> `jade-white`（纯净中性浅白）。
 *
 * 【设计意图 (Why)】`ayu-light` 带有明显的暖黄纸色偏（`#FDFAF4`），在移动端大面积留白与悬浮卡片下易显发黄；
 *   浅色极性统一切向 `jade-white`（`#F8F9FA` 中性白基底 + `#FFFFFF` 纯白浮层卡片），与悬浮控件一致呈现通透洁净感。
 */
export function resolveMobileSkinId(
  preference: MobileAppearancePreference,
  systemPrefersDark: boolean,
): MobileSkinId {
  if (preference === 'light') return 'jade-white';
  if (preference === 'dark') return 'obsidian-gold';
  return systemPrefersDark ? 'obsidian-gold' : 'jade-white';
}

export interface MobileSectionCollapsedState {
  bots: boolean;
  groups: boolean;
  sessions: boolean;
}

export const DEFAULT_MOBILE_SECTIONS_COLLAPSED: MobileSectionCollapsedState = Object.freeze({
  bots: false,
  groups: false,
  sessions: false,
});

export interface MobileHomeModelInput {
  activeSessionId: string;
  activeFocus?: LeftRailActiveFocus;
  profiles: readonly LeftRailProfile[];
  groups: readonly LeftRailGroupRoom[];
  sessions: readonly LeftRailSession[];
  projects?: readonly LeftRailProject[];
  folders?: readonly LeftRailFolder[];
  assignments?: Readonly<Record<string, string>>;
  doneRoomIds?: readonly string[];
  doneRoomsMap?: Readonly<Record<string, number>>;
  containerCollapsed?: OrgContainerCollapseState;
  hiddenProjectIds?: readonly string[];
  showDoneSection?: boolean;
  doneLoading?: boolean;
  doneError?: string;
  profileName: string;
  searchQuery: string;
  gatewayCount?: number;
  collapsed: MobileSectionCollapsedState;
  profilesPhase?: DataPhase;
  sessionsPhase?: DataPhase;
  nowMs?: number;
}

export type MobileEntityKind = 'bot' | 'group' | 'session';

export interface MobileBotRowVM {
  kind: 'bot';
  id: string;
  title: string;
  subtitle: string;
  avatarUrl?: string;
  timeText: string;
  isDefault: boolean;
  isActive: boolean;
  gatewayId?: string;
  gatewayLabel?: string;
  gatewayOffline?: boolean;
  activityState: ActivityState;
  waitingReason?: WaitingPromptReason;
  activityTransition: ActivityTransition;
  activityTransitionToken?: number;
  statusTextKey: I18nKey | null;
  profile: LeftRailProfile;
}

export interface MobileGroupRowVM {
  kind: 'group';
  id: string;
  title: string;
  subtitle: string;
  members: string[];
  timeText: string;
  isActive: boolean;
  isDone?: boolean;
  containerId?: string | null;
  gatewayId?: string;
  gatewayLabel?: string;
  gatewayOffline?: boolean;
  crossGateway?: boolean;
  activityState: ActivityState;
  waitingReason?: WaitingPromptReason;
  activityTransition: ActivityTransition;
  activityTransitionToken?: number;
  statusTextKey: I18nKey | null;
  group: LeftRailGroupRoom;
}

export interface MobileSessionRowVM {
  kind: 'session';
  id: string;
  title: string;
  subtitle: string;
  ownerBotName: string;
  ownerBotDisplayName: string;
  ownerAvatarUrl?: string;
  timeText: string;
  isPinned: boolean;
  isActive: boolean;
  isDone?: boolean;
  containerId?: string | null;
  hasCwdProjectMatch?: boolean;
  gatewayId?: string;
  gatewayLabel?: string;
  gatewayOffline?: boolean;
  activityState: ActivityState;
  waitingReason?: WaitingPromptReason;
  activityTransition: ActivityTransition;
  activityTransitionToken?: number;
  statusTextKey: I18nKey | null;
  session: LeftRailSession;
}

export type MobileHomeContainerEntryVM = MobileGroupRowVM | MobileSessionRowVM;
export type MobileOrgContainerSectionVM = PartitionedContainerBucket<MobileHomeContainerEntryVM>;

export interface MobileSectionHeaderStatus {
  state: 'running' | 'waiting';
  waitingReason?: WaitingPromptReason;
  statusTextKey: I18nKey;
}

export interface MobileHomeSectionVM<TRow> {
  key: 'bots' | 'groups' | 'sessions';
  titleKey: I18nKey;
  isCollapsed: boolean;
  /** 搜索非空且存在命中项时强制展开视图，但保留持久化折叠状态不被覆盖 */
  effectiveExpanded: boolean;
  /** 严格约束：`sessions` 恒为 `null`；`bots`/`groups` 仅折叠且含运行中项时非空 */
  headerStatus: MobileSectionHeaderStatus | null;
  items: TRow[];
}

export interface MobileDoneSectionVM {
  key: 'done';
  titleKey: I18nKey;
  showSection: boolean;
  isCollapsed: boolean;
  effectiveExpanded: boolean;
  loading: boolean;
  error: string;
  items: MobileHomeContainerEntryVM[];
}

export interface MobileHomeModel {
  isMultiGateway: boolean;
  searchQuery: string;
  isSearching: boolean;
  botsSection: MobileHomeSectionVM<MobileBotRowVM>;
  projectSections: MobileOrgContainerSectionVM[];
  folderSections: MobileOrgContainerSectionVM[];
  groupsSection: MobileHomeSectionVM<MobileGroupRowVM>;
  sessionsSection: MobileHomeSectionVM<MobileSessionRowVM>;
  doneSection: MobileDoneSectionVM;
  showDoneSection: boolean;
  profilesPhase: DataPhase;
  sessionsPhase: DataPhase;
  hasAnyResult: boolean;
}

function resolveWaitingMobileStatusKey(reason?: WaitingPromptReason): I18nKey {
  switch (reason) {
    case 'clarify':
      return 'mobile.status.waitingReply';
    case 'approval':
      return 'mobile.status.waitingApproval';
    case 'credential':
      return 'mobile.status.waitingCredential';
    case 'connection':
      return 'mobile.status.waitingConnection';
    case 'confirm':
      return 'mobile.status.waitingConfirm';
    default:
      return 'mobile.status.waiting';
  }
}

function resolveRowStatusKey(
  kind: MobileEntityKind,
  state: ActivityState,
  waitingReason?: WaitingPromptReason,
): I18nKey | null {
  if (state === 'waiting') {
    return resolveWaitingMobileStatusKey(waitingReason);
  }
  if (state === 'running') {
    if (kind === 'bot') return 'mobile.status.thinking';
    if (kind === 'group') return 'mobile.status.collaborating';
    return 'mobile.status.executing';
  }
  if (state === 'unread') {
    return 'mobile.status.unread';
  }
  return null;
}

function matchesSearch(query: string, fields: Array<string | undefined>): boolean {
  if (!query) return true;
  return fields.some((field) => Boolean(field && field.toLowerCase().includes(query)));
}

/**
 * 构建移动端首屏全量三段视图模型。
 *
 * 【规则】
 *   1. 大标题禁止带数量数字；
 *   2. 普通会话行头像强制从归属 Bot（`botName` 查表 `profiles`）继承，未匹配时回退至默认 Bot；
 *   3. `sessionsSection.headerStatus` 恒为 `null`，普通会话分区大标题不挂载状态动画。
 */
export function buildMobileHomeModel(input: MobileHomeModelInput): MobileHomeModel {
  const query = (input.searchQuery || '').trim().toLowerCase();
  const isSearching = query.length > 0;
  const nowDate = input.nowMs ? new Date(input.nowMs) : new Date();
  const currentFocus: LeftRailActiveFocus = input.activeFocus
    || (input.activeSessionId
      ? { type: 'session', sessionId: input.activeSessionId }
      : { type: 'bot', botName: input.profileName || 'default' });

  const isMultiGateway = (input.gatewayCount ?? 1) >= 2;
  const scopedProfileMap = new Map<string, LeftRailProfile>();
  const profileMap = new Map<string, LeftRailProfile>();
  for (const p of input.profiles) {
    const gwPrefix = p.gatewayId ? `${p.gatewayId.toLowerCase()}:` : '';
    if (gwPrefix) {
      scopedProfileMap.set(`${gwPrefix}${p.name.toLowerCase()}`, p);
      if (p.displayName) scopedProfileMap.set(`${gwPrefix}${p.displayName.toLowerCase()}`, p);
    }
    if (!profileMap.has(p.name.toLowerCase())) profileMap.set(p.name.toLowerCase(), p);
    if (p.displayName && !profileMap.has(p.displayName.toLowerCase())) {
      profileMap.set(p.displayName.toLowerCase(), p);
    }
  }
  const defaultProfile = input.profiles.find((p) => p.isDefault || p.name.toLowerCase() === 'default');
  const resolveOwnerProfile = (botName: string | undefined, gatewayId?: string): LeftRailProfile | undefined => {
    const ownerKey = (botName || 'default').toLowerCase();
    if (gatewayId) {
      const scoped = scopedProfileMap.get(`${gatewayId.toLowerCase()}:${ownerKey}`);
      if (scoped) return scoped;
    }
    return profileMap.get(ownerKey) ?? defaultProfile;
  };
  const sameOptionalGateway = (a?: string, b?: string): boolean => !a || !b || a === b;

  // 1. 智能体主工位行（全量 Bot，default 置顶其余按最近活跃排序）
  const sortedProfiles = [...input.profiles].sort((a, b) => {
    const aDef = a.isDefault || a.name.toLowerCase() === 'default' ? 1 : 0;
    const bDef = b.isDefault || b.name.toLowerCase() === 'default' ? 1 : 0;
    if (aDef !== bDef) return bDef - aDef;
    const diff = (b.timestamp || 0) - (a.timestamp || 0);
    if (diff !== 0) return diff;
    return (a.displayName || a.name).localeCompare(b.displayName || b.name);
  });

  const botRows: MobileBotRowVM[] = sortedProfiles
    .filter((p) => matchesSearch(query, [p.displayName, p.name, p.description, p.lastMessage, p.gatewayLabel]))
    .map((p) => {
      const activityState: ActivityState = p.activityState ?? 'read';
      const isActive =
        currentFocus.type === 'bot' &&
        currentFocus.botName.toLowerCase() === p.name.toLowerCase() &&
        sameOptionalGateway(currentFocus.gatewayId, p.gatewayId);
      return {
        kind: 'bot',
        id: p.name,
        title: p.displayName || p.name,
        subtitle: toSnippet(p.lastMessage) || toSnippet(p.description) || '',
        avatarUrl: p.avatar,
        timeText: p.lastTime || formatLeftRailTime(p.timestamp, nowDate),
        isDefault: Boolean(p.isDefault || p.name.toLowerCase() === 'default'),
        isActive,
        ...(p.gatewayId ? { gatewayId: p.gatewayId } : {}),
        ...(p.gatewayLabel ? { gatewayLabel: p.gatewayLabel } : {}),
        ...(p.gatewayOffline ? { gatewayOffline: true } : {}),
        activityState,
        waitingReason: p.waitingReason,
        activityTransition: p.activityTransition ?? 'none',
        activityTransitionToken: p.activityTransitionToken,
        statusTextKey: resolveRowStatusKey('bot', activityState, p.waitingReason),
        profile: p,
      };
    });

  // 2. 使用统一分桶引擎对项目、自定义文件夹、未分组群聊/普通会话及已完成项进行单归属归类
  const partitioned = partitionRailOrgEntities<MobileSessionRowVM, MobileGroupRowVM>({
    sessions: input.sessions,
    groups: input.groups,
    projects: input.projects,
    folders: input.folders,
    assignments: input.assignments,
    doneRoomIds: input.doneRoomIds,
    doneRoomsMap: input.doneRoomsMap,
    containerCollapsed: input.containerCollapsed,
    hiddenProjectIds: input.hiddenProjectIds,
    searchQuery: input.searchQuery,
    matchesGroupSearch: (g, q) => matchesSearch(q, [g.name, g.lastMessage, g.gatewayLabel, ...(g.members || [])]),
    matchesSessionSearch: (s, q) => {
      const owner = resolveOwnerProfile(s.botName, s.gatewayId);
      return matchesSearch(q, [s.title, s.preview, s.botDisplayName, owner?.displayName, s.botName, s.gatewayLabel]);
    },
    mapGroup: (g, meta) => {
      const activityState: ActivityState = g.activityState ?? 'read';
      const isActive =
        currentFocus.type === 'group' &&
        currentFocus.roomId === g.roomId &&
        sameOptionalGateway(currentFocus.gatewayId, g.gatewayId);
      const roomTs = g.updatedAt || g.createdAt || 0;
      return {
        kind: 'group',
        id: g.roomId,
        title: g.name,
        subtitle: toSnippet(g.lastMessage),
        members: g.members || [],
        timeText: formatLeftRailTime(roomTs || undefined, nowDate),
        isActive,
        isDone: meta.isDone,
        containerId: meta.containerId,
        ...(g.gatewayId ? { gatewayId: g.gatewayId } : {}),
        ...(g.gatewayLabel ? { gatewayLabel: g.gatewayLabel } : {}),
        ...(g.gatewayOffline ? { gatewayOffline: true } : {}),
        ...(g.crossGateway ? { crossGateway: true } : {}),
        activityState,
        waitingReason: g.waitingReason,
        activityTransition: g.activityTransition ?? 'none',
        activityTransitionToken: g.activityTransitionToken,
        statusTextKey: resolveRowStatusKey('group', activityState, g.waitingReason),
        group: g,
        sortTimestamp: roomTs,
        isPinnedSort: false,
      };
    },
    mapSession: (s, meta) => {
      const owner = resolveOwnerProfile(s.botName, s.gatewayId);
      const ownerBotName = owner?.name || s.botName || 'default';
      const ownerBotDisplayName = owner?.displayName || s.botDisplayName || ownerBotName;
      const ownerAvatarUrl = owner?.avatar || s.botAvatar || undefined;
      const activityState: ActivityState = s.activityState ?? 'read';
      const isActive =
        currentFocus.type === 'session' &&
        currentFocus.sessionId === s.id &&
        sameOptionalGateway(currentFocus.gatewayId, s.gatewayId);
      return {
        kind: 'session',
        id: s.id,
        title: s.title,
        subtitle: toSnippet(s.preview),
        ownerBotName,
        ownerBotDisplayName,
        ownerAvatarUrl,
        timeText: s.time || formatLeftRailTime(s.timestamp, nowDate),
        isPinned: Boolean(s.isPinned),
        isActive,
        isDone: meta.isDone,
        containerId: meta.containerId,
        hasCwdProjectMatch: meta.hasCwdProjectMatch,
        ...(s.gatewayId ? { gatewayId: s.gatewayId } : {}),
        ...(s.gatewayLabel ? { gatewayLabel: s.gatewayLabel } : {}),
        ...(s.gatewayOffline ? { gatewayOffline: true } : {}),
        activityState,
        waitingReason: s.waitingReason,
        activityTransition: s.activityTransition ?? 'none',
        activityTransitionToken: s.activityTransitionToken,
        statusTextKey: resolveRowStatusKey('session', activityState, s.waitingReason),
        session: s,
        sortTimestamp: s.timestamp || 0,
        isPinnedSort: Boolean(s.isPinned),
      };
    },
  });

  const groupRows = partitioned.unassignedGroups;
  const sessionRows = partitioned.unassignedSessions;
  const showDoneSection = input.showDoneSection !== false;

  const waitingBot = botRows.find((row) => row.activityState === 'waiting');
  const waitingGroup = groupRows.find((row) => row.activityState === 'waiting');
  const botsHasRunning = botRows.some((row) => row.activityState === 'running');
  const groupsHasRunning = groupRows.some((row) => row.activityState === 'running');
  const hasContainerItemHits =
    partitioned.projectContainers.some((c) => c.items.length > 0) ||
    partitioned.folderContainers.some((c) => c.items.length > 0);
  const hasVisibleEmptyContainers =
    !isSearching &&
    (partitioned.projectContainers.length > 0 || partitioned.folderContainers.length > 0);
  const hasDoneHits = showDoneSection && partitioned.doneItems.length > 0;

  return {
    isMultiGateway,
    searchQuery: input.searchQuery || '',
    isSearching,
    botsSection: {
      key: 'bots',
      titleKey: 'mobile.section.bots',
      isCollapsed: input.collapsed.bots,
      effectiveExpanded: isSearching ? botRows.length > 0 : !input.collapsed.bots,
      headerStatus:
        input.collapsed.bots && waitingBot
          ? {
              state: 'waiting',
              waitingReason: waitingBot.waitingReason,
              statusTextKey: resolveWaitingMobileStatusKey(waitingBot.waitingReason),
            }
          : input.collapsed.bots && botsHasRunning
            ? { state: 'running', statusTextKey: 'mobile.status.thinking' }
            : null,
      items: botRows,
    },
    projectSections: partitioned.projectContainers,
    folderSections: partitioned.folderContainers,
    groupsSection: {
      key: 'groups',
      titleKey: 'mobile.section.groups',
      isCollapsed: input.collapsed.groups,
      effectiveExpanded: isSearching ? groupRows.length > 0 : !input.collapsed.groups,
      headerStatus:
        input.collapsed.groups && waitingGroup
          ? {
              state: 'waiting',
              waitingReason: waitingGroup.waitingReason,
              statusTextKey: resolveWaitingMobileStatusKey(waitingGroup.waitingReason),
            }
          : input.collapsed.groups && groupsHasRunning
            ? { state: 'running', statusTextKey: 'mobile.status.collaborating' }
            : null,
      items: groupRows,
    },
    sessionsSection: {
      key: 'sessions',
      titleKey: 'mobile.section.sessions',
      isCollapsed: input.collapsed.sessions,
      effectiveExpanded: isSearching ? sessionRows.length > 0 : !input.collapsed.sessions,
      // 用户裁定：普通会话分组大标题绝不挂载运行态动画，状态只在具体会话行右侧展现
      headerStatus: null,
      items: sessionRows,
    },
    doneSection: {
      key: 'done',
      titleKey: 'mobile.home.sectionDone',
      showSection: showDoneSection,
      isCollapsed: partitioned.doneIsCollapsed,
      effectiveExpanded: partitioned.doneEffectiveExpanded,
      loading: Boolean(input.doneLoading),
      error: (input.doneError || '').trim(),
      items: partitioned.doneItems,
    },
    showDoneSection,
    profilesPhase: input.profilesPhase ?? 'ready',
    sessionsPhase: input.sessionsPhase ?? 'ready',
    hasAnyResult:
      botRows.length > 0 ||
      groupRows.length > 0 ||
      sessionRows.length > 0 ||
      hasContainerItemHits ||
      hasVisibleEmptyContainers ||
      hasDoneHits,
  };
}

export interface MobileBackNavState {
  activePane: MobilePaneId;
  homeTab?: MobileHomeTab;
  mediaLightboxOpen?: boolean;
  hasActionSheet: boolean;
  actionSheetStep?: MobileActionSheetStep;
  hasModelSheet: boolean;
  hasApprovalSheet?: boolean;
  hasSubagentSheet: boolean;
  hasExpandedInteractiveDock?: boolean;
  botWizardOpen?: boolean;
  newChatOpen: boolean;
  newChatStep: MobileNewChatStep;
  newChatProjectPickerOpen?: boolean;
  searchOpen: boolean;
  settingsOpen: boolean;
  settingsSubpage: MobileSettingsSubpage;
  botSubpage?: MobileBotSubpage;
  inspectorReaderOpen: boolean;
}

export type MobileBackAction =
  | { handled: true; effect: 'closeMediaLightbox' }
  | { handled: true; effect: 'actionSheetBackToMenu' }
  | { handled: true; effect: 'closeActionSheet' }
  | { handled: true; effect: 'closeModelSheet' }
  | { handled: true; effect: 'closeApprovalSheet' }
  | { handled: true; effect: 'closeSubagentSheet' }
  | { handled: true; effect: 'collapseInteractiveDock' }
  | { handled: true; effect: 'closeBotWizard' }
  | { handled: true; effect: 'closeNewChatProjectPicker' }
  | { handled: true; effect: 'newChatBackToCompose' }
  | { handled: true; effect: 'closeNewChatSheet' }
  | { handled: true; effect: 'closeSearch' }
  | { handled: true; effect: 'settingsBackToRoot' }
  | { handled: true; effect: 'closeSettings' }
  | { handled: true; effect: 'botBackToRoot' }
  | { handled: true; effect: 'closeInspectorReader' }
  | { handled: true; effect: 'navigatePane'; nextPane: 'stage' | 'home' }
  | { handled: true; effect: 'switchHomeTab'; nextTab: 'chats' }
  | { handled: false; effect: 'minimizeApp' };

/**
 * 移动端多层返回栈纯状态机：统一服务于 Android 硬件返回键与手势返回。
 */
export function reduceMobileBackAction(state: MobileBackNavState): MobileBackAction {
  if (state.mediaLightboxOpen) {
    return { handled: true, effect: 'closeMediaLightbox' };
  }
  if (state.hasActionSheet) {
    if (state.actionSheetStep && state.actionSheetStep !== 'menu') {
      return { handled: true, effect: 'actionSheetBackToMenu' };
    }
    return { handled: true, effect: 'closeActionSheet' };
  }
  if (state.hasModelSheet) return { handled: true, effect: 'closeModelSheet' };
  if (state.hasApprovalSheet) return { handled: true, effect: 'closeApprovalSheet' };
  if (state.hasSubagentSheet) return { handled: true, effect: 'closeSubagentSheet' };
  if (state.botWizardOpen) return { handled: true, effect: 'closeBotWizard' };
  if (state.newChatOpen) {
    if (state.newChatProjectPickerOpen) {
      return { handled: true, effect: 'closeNewChatProjectPicker' };
    }
    if (state.newChatStep === 'group-members') {
      return { handled: true, effect: 'newChatBackToCompose' };
    }
    return { handled: true, effect: 'closeNewChatSheet' };
  }
  if (state.searchOpen) return { handled: true, effect: 'closeSearch' };
  if (state.settingsOpen) {
    if (state.settingsSubpage !== null) {
      return { handled: true, effect: 'settingsBackToRoot' };
    }
    return { handled: true, effect: 'closeSettings' };
  }
  if (state.activePane === 'inspector') {
    if (state.inspectorReaderOpen) {
      return { handled: true, effect: 'closeInspectorReader' };
    }
    return { handled: true, effect: 'navigatePane', nextPane: 'stage' };
  }
  if (state.activePane === 'stage') {
    if (state.hasExpandedInteractiveDock) {
      return { handled: true, effect: 'collapseInteractiveDock' };
    }
    return { handled: true, effect: 'navigatePane', nextPane: 'home' };
  }
  if (state.homeTab === 'bots') {
    if (state.botSubpage != null) {
      return { handled: true, effect: 'botBackToRoot' };
    }
    return { handled: true, effect: 'switchHomeTab', nextTab: 'chats' };
  }
  return { handled: false, effect: 'minimizeApp' };
}

export interface BotCarouselWindow<T extends { id: string }> {
  activeIndex: number;
  current: T | null;
  prev: T | null;
  next: T | null;
  total: number;
}

/**
 * 计算 Bot 页顶部居中头像轮播的当前焦距窗口（居中主头像 + 左右淡化相邻头像）。
 *
 * 【设计意图 (Why)】
 *   居中主头像与两侧可点击预览头像严格对称排布；仅有 1 个或 2 个 Bot 时避免首尾重复渲染同一实体，
 *   >= 3 个 Bot 时启用循环邻接索引实现无缝轮播切换。
 * 【防范的历史坑 (Pitfall)】
 *   若 2 个 Bot 也做双向取模，`prev` 和 `next` 会同时指向同一个相邻 Bot，画面左右出现两个完全一样的头像；
 *   若 `activeBotId` 暂未命中花名册（例如刚删除或大小写差异），必须回落到索引 `0` 防止主舞台空白。
 * 【约束与规则 (Rules)】
 *   - 匹配 `id` 时忽略大小写；
 *   - 纯函数、零副作用，不修改输入 `roster`。
 */
export function buildBotCarouselWindow<T extends { id: string }>(
  roster: readonly T[],
  activeBotId: string,
): BotCarouselWindow<T> {
  const total = roster.length;
  if (total === 0) {
    return { activeIndex: -1, current: null, prev: null, next: null, total: 0 };
  }
  const normalizedTarget = (activeBotId || '').toLowerCase();
  const matchedIdx = roster.findIndex((item) => item.id.toLowerCase() === normalizedTarget);
  const activeIndex = matchedIdx >= 0 ? matchedIdx : 0;
  const current = roster[activeIndex];

  if (total === 1) {
    return { activeIndex, current, prev: null, next: null, total };
  }
  if (total === 2) {
    return {
      activeIndex,
      current,
      prev: activeIndex === 1 ? roster[0] : null,
      next: activeIndex === 0 ? roster[1] : null,
      total,
    };
  }
  return {
    activeIndex,
    current,
    prev: roster[(activeIndex - 1 + total) % total],
    next: roster[(activeIndex + 1) % total],
    total,
  };
}

export const MOBILE_PANE_ORDER: readonly MobilePaneId[] = ['home', 'stage', 'inspector'];
export const MOBILE_EDGE_DAMPING = 0.28;
export const MOBILE_LOCK_THRESHOLD_PX = 8;
export const MOBILE_COMMIT_RATIO = 0.28;
export const MOBILE_FLICK_VELOCITY_PX_MS = 0.35;
export const MOBILE_STAGE_COMPACT_SCROLL_THRESHOLD_PX = 140;
export const MOBILE_CAROUSEL_LOCK_PX = 8;
export const MOBILE_CAROUSEL_COMMIT_PX = 36;
export const MOBILE_CAROUSEL_FLICK_VELOCITY_PX_MS = 0.25;
export const MOBILE_CAROUSEL_MAX_OFFSET_PX = 96;
export const MOBILE_BOT_CAROUSEL_STEP_PX = 96;

/**
 * 将 Bot 头像横向轮播的 scrollLeft 映射为连续浮点索引，用于平滑缩放与透明度插值。
 */
export function resolveBotCarouselScrollIndex(
  scrollLeft: number,
  stepPx: number,
  total: number,
): number {
  if (total <= 0 || stepPx <= 0 || !Number.isFinite(scrollLeft)) return 0;
  return Math.max(0, Math.min(total - 1, scrollLeft / stepPx));
}

/**
 * 将 Bot 头像横向轮播的 scrollLeft 就近吸附为当前居中的整数 Bot 索引。
 */
export function resolveNearestBotIndex(
  scrollLeft: number,
  stepPx: number,
  total: number,
): number {
  if (total <= 0 || stepPx <= 0 || !Number.isFinite(scrollLeft)) return 0;
  return Math.max(0, Math.min(total - 1, Math.round(scrollLeft / stepPx)));
}

/**
 * 计算轮播槽位距居中焦点的连续缩放倍率与透明度，中心越近越清晰饱满。
 */
export function computeBotCarouselSlotVisual(
  index: number,
  scrollIndex: number,
): { scale: number; opacity: number; isCentered: boolean } {
  const dist = Math.abs(index - scrollIndex);
  const clamped = Math.min(1.5, dist);
  const scale = Number(Math.max(0.58, 1 - clamped * 0.36).toFixed(3));
  const opacity = Number(Math.max(0.45, 1 - clamped * 0.36).toFixed(3));
  return {
    scale,
    opacity,
    isCentered: dist < 0.35,
  };
}

/**
 * 归一化横滑松手终点 X 坐标：WebView 偶发 `pointercancel` 时可能将 `clientX` 归零，
 * 此时优先回落最后一次真实追踪坐标 `lastTrackedX`，避免误算整屏反向位移。
 */
export function resolveSwipeReleaseEndX(
  eventType: string,
  clientX: number,
  lastTrackedX: number,
): number {
  if (eventType === 'pointercancel' && clientX === 0 && lastTrackedX !== 0) {
    return lastTrackedX;
  }
  return clientX;
}

export interface MobileModelPickerItem {
  key: string;
  id: string;
  label: string;
  provider?: string;
  providerLabel?: string;
  active: boolean;
  unavailable: boolean;
}

export type SwipeLockAxis = 'none' | 'horizontal' | 'vertical';

export interface SwipeMoveInput {
  activePane: MobilePaneId;
  dx: number;
  dy: number;
  locked: SwipeLockAxis;
}

export interface SwipeMoveResult {
  nextLocked: SwipeLockAxis;
  stopTracking: boolean;
  didLockHorizontal: boolean;
  dragOffsetPx: number;
}

export interface SwipeReleaseInput {
  activePane: MobilePaneId;
  totalDx: number;
  durationMs: number;
  viewportWidth: number;
}

export interface ParsedSubagentToolArgs {
  title: string;
  task: string;
  summary: string;
}

/**
 * 返回三屏顺序数组中的索引；非法值安全回落至首屏 `0`。
 */
export function paneIndexOf(pane: MobilePaneId): number {
  const idx = MOBILE_PANE_ORDER.indexOf(pane);
  return idx >= 0 ? idx : 0;
}

/**
 * 裁决水平拖拽中的方向锁与边界橡皮筋阻尼位移，保证斜滑优先让位于列表纵向滚动。
 */
export function computeSwipeMove(input: SwipeMoveInput): SwipeMoveResult {
  let nextLocked = input.locked;
  let didLockHorizontal = false;
  if (nextLocked === 'none') {
    if (
      Math.abs(input.dx) < MOBILE_LOCK_THRESHOLD_PX &&
      Math.abs(input.dy) < MOBILE_LOCK_THRESHOLD_PX
    ) {
      return { nextLocked: 'none', stopTracking: false, didLockHorizontal: false, dragOffsetPx: 0 };
    }
    if (Math.abs(input.dy) > Math.abs(input.dx) * 0.9) {
      return {
        nextLocked: 'vertical',
        stopTracking: true,
        didLockHorizontal: false,
        dragOffsetPx: 0,
      };
    }
    nextLocked = 'horizontal';
    didLockHorizontal = true;
  }

  if (nextLocked !== 'horizontal') {
    return { nextLocked, stopTracking: false, didLockHorizontal: false, dragOffsetPx: 0 };
  }

  const currentIdx = paneIndexOf(input.activePane);
  const isOverLeft = currentIdx === 0 && input.dx > 0;
  const isOverRight = currentIdx === MOBILE_PANE_ORDER.length - 1 && input.dx < 0;
  return {
    nextLocked,
    stopTracking: false,
    didLockHorizontal,
    dragOffsetPx: isOverLeft || isOverRight ? input.dx * MOBILE_EDGE_DAMPING : input.dx,
  };
}

/**
 * 根据滑动距离比例与惯性速度，裁决松手后落定的目标屏幕。
 */
export function settleSwipeRelease(input: SwipeReleaseInput): MobilePaneId {
  const dt = Math.max(1, input.durationMs);
  const velocity = input.totalDx / dt;
  const width = Math.max(1, input.viewportWidth || 390);
  const ratio = input.totalDx / width;
  const currentIdx = paneIndexOf(input.activePane);

  let targetIdx = currentIdx;
  if (ratio <= -MOBILE_COMMIT_RATIO || velocity <= -MOBILE_FLICK_VELOCITY_PX_MS) {
    targetIdx = Math.min(MOBILE_PANE_ORDER.length - 1, currentIdx + 1);
  } else if (ratio >= MOBILE_COMMIT_RATIO || velocity >= MOBILE_FLICK_VELOCITY_PX_MS) {
    targetIdx = Math.max(0, currentIdx - 1);
  }
  return MOBILE_PANE_ORDER[targetIdx];
}

/**
 * 计算三屏横向滑轨 CSS `translate3d` 表达式。
 */
export function resolveTrackTransform(
  activePane: MobilePaneId,
  isDragging: boolean,
  dragOffsetPx: number,
): string {
  const paneIdx = paneIndexOf(activePane);
  const basePct = -((paneIdx * 100) / MOBILE_PANE_ORDER.length);
  return isDragging
    ? `translate3d(calc(${basePct}% + ${dragOffsetPx}px), 0, 0)`
    : `translate3d(${basePct}%, 0, 0)`;
}

/**
 * 将完整模型标识（如 `anthropic/claude-sonnet-4`）收敛为移动端紧凑短名。
 *
 * 【设计意图 (Why)】多 Provider 同时提供同名模型时优先匹配 `currentProvider`，防止标签误显别的 Provider。
 * 【防范的历史坑 (Pitfall)】仅按模型 ID 匹配在存在中继/多网关配置时会张冠李戴，导致胶囊与当前绑定提供方不一致。
 * 【约束与规则 (Rules)】纯函数、不修改入参；`model` 为空时直接回落 `fallbackLabel`。
 */
export function resolveShortModelName(
  model: string,
  details: ReadonlyArray<{ id: string; provider?: string; name?: string; displayName?: string }>,
  fallbackLabel: string,
  currentProvider?: string,
): string {
  if (!model) return fallbackLabel;
  const detail =
    (currentProvider
      ? details.find((d) => d.id === model && d.provider === currentProvider)
      : undefined) ?? details.find((d) => d.id === model);
  const label = detail?.displayName || detail?.name || model;
  const slashIdx = label.lastIndexOf('/');
  return slashIdx >= 0 ? label.slice(slashIdx + 1) : label;
}

/**
 * 归一化移动端输入舱底部模型选择列表。
 *
 * 【设计意图 (Why)】与桌面 `resolveModelPickerRows` 保持同一真值口径：优先消费包含 Provider 与可用状态的 `modelDetails`，
 *   再补齐仅存在于 `availableModels` 中的模型 ID，按 `${provider}:${id}` 去重以区分多 Provider 同名模型。
 * 【防范的历史坑 (Pitfall)】仅按 `id` 遍历会在多 Provider 下产生 React duplicate key 或丢失 `provider` / `unavailable` 元数据。
 * 【规则】纯函数、不修改入参；列表全空时仅当 `selectedModel` 非空才保留单条兜底项，绝不伪造虚构模型。
 */
export function buildMobileModelPickerItems(
  availableModels: readonly string[],
  modelDetails: ReadonlyArray<{
    id: string;
    provider?: string;
    providerName?: string;
    name?: string;
    displayName?: string;
    unavailable?: boolean;
  }>,
  selectedModel: string,
  currentProvider?: string,
): MobileModelPickerItem[] {
  const items: MobileModelPickerItem[] = [];
  const seenKeys = new Set<string>();
  const seenIds = new Set<string>();

  for (const detail of modelDetails) {
    if (!detail.id) continue;
    const prov = detail.provider || '';
    const key = `${prov}:${detail.id}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    seenIds.add(detail.id);
    items.push({
      key,
      id: detail.id,
      label: detail.displayName || detail.name || detail.id,
      provider: detail.provider,
      providerLabel: detail.providerName || detail.provider,
      active:
        detail.id === selectedModel &&
        (!currentProvider || !prov || prov === currentProvider),
      unavailable: Boolean(detail.unavailable),
    });
  }

  for (const id of availableModels) {
    if (!id || seenIds.has(id)) continue;
    seenIds.add(id);
    items.push({
      key: `:${id}`,
      id,
      label: id,
      active: id === selectedModel,
      unavailable: false,
    });
  }

  if (items.length === 0 && selectedModel) {
    items.push({
      key: `:${selectedModel}`,
      id: selectedModel,
      label: selectedModel,
      active: true,
      unavailable: false,
    });
  }

  return items;
}

/**
 * 计算 Bot Hub 顶部头像轮播水平跟手偏移，缺省邻接侧施加橡皮筋阻尼并限幅。
 *
 * 【设计意图 (Why)】滑向左/右缺失邻接 Bot 时提供明确物理边界阻尼反馈，避免头像被拖出视区。
 * 【防范的历史坑 (Pitfall)】若不对单/双 Bot 边界做阻尼与位移限幅，滑动会把唯一头像拖出可视裁剪区造成空白闪烁。
 * 【约束与规则 (Rules)】纯函数、零副作用，输出严格钳位在 `[-MOBILE_CAROUSEL_MAX_OFFSET_PX, MOBILE_CAROUSEL_MAX_OFFSET_PX]`。
 */
export function computeBotCarouselDragOffset(
  dx: number,
  hasPrev: boolean,
  hasNext: boolean,
): number {
  const hitEdge = (dx > 0 && !hasPrev) || (dx < 0 && !hasNext);
  const scaled = hitEdge ? dx * MOBILE_EDGE_DAMPING : dx;
  return Math.max(-MOBILE_CAROUSEL_MAX_OFFSET_PX, Math.min(MOBILE_CAROUSEL_MAX_OFFSET_PX, scaled));
}

/**
 * 根据水平拖拽距离与松手惯性速度裁决 Bot Hub 轮播切换方向（上一个 / 下一个 / 回弹保持）。
 *
 * 【设计意图 (Why)】统一度量轮播拖拽距离与快速轻拂速度（flick velocity），确保短距快滑也能顺畅切人。
 * 【防范的历史坑 (Pitfall)】若只判断固定像素阈值而不计入速度，`fling` 手势会被回弹吞掉；未检查 `hasPrev`/`hasNext` 则会在空位切出未定义目标。
 * 【约束与规则 (Rules)】仅当目标侧确实存在相邻 Bot（`hasNext` / `hasPrev` 为真）时才触发切换；对 `durationMs` 做最小 `1ms` 保护防止除零。
 */
export function settleBotCarouselSwipe(input: {
  totalDx: number;
  durationMs: number;
  hasPrev: boolean;
  hasNext: boolean;
}): 'prev' | 'next' | 'none' {
  const dt = Math.max(1, input.durationMs);
  const velocity = input.totalDx / dt;
  if (
    input.hasNext &&
    (input.totalDx <= -MOBILE_CAROUSEL_COMMIT_PX || velocity <= -MOBILE_CAROUSEL_FLICK_VELOCITY_PX_MS)
  ) {
    return 'next';
  }
  if (
    input.hasPrev &&
    (input.totalDx >= MOBILE_CAROUSEL_COMMIT_PX || velocity >= MOBILE_CAROUSEL_FLICK_VELOCITY_PX_MS)
  ) {
    return 'prev';
  }
  return 'none';
}

/**
 * 对话流上滑距底超过阈值时收敛顶部居中头像状态胶囊。
 */
export function shouldCompactStagePresence(
  scrollHeight: number,
  scrollTop: number,
  clientHeight: number,
): boolean {
  return scrollHeight - scrollTop - clientHeight > MOBILE_STAGE_COMPACT_SCROLL_THRESHOLD_PX;
}

/**
 * 统一解析子代理委派工具的参数载荷，供折叠胶囊摘要与详情抽屉共享。
 */
export function parseSubagentToolArgs(
  toolName: string | undefined,
  args: string | undefined,
  fallbackTitle: string,
): ParsedSubagentToolArgs {
  const titleFallback = toolName || fallbackTitle;
  const raw = (args || '').trim();
  if (!raw) {
    return { title: titleFallback, task: '', summary: titleFallback };
  }
  let parsedRole: string | null = null;
  let resolvedTask = raw;
  try {
    if (raw.startsWith('{')) {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const role = parsed.role ?? parsed.profile ?? parsed.agent ?? parsed.TypeName ?? parsed.title;
      const prompt = parsed.prompt ?? parsed.task ?? parsed.question ?? parsed.description;
      if (typeof role === 'string' && role.trim()) {
        parsedRole = role.trim();
      }
      if (typeof prompt === 'string') {
        resolvedTask = prompt.trim();
      }
    }
  // gate-degrade: 参数非合法 JSON 时按纯文本截取摘要
  } catch {}
  const firstLine = raw.split('\n')[0].trim();
  const summary = parsedRole
    ? parsedRole.slice(0, 32)
    : firstLine.length > 32
      ? `${firstLine.slice(0, 32)}…`
      : firstLine;
  return {
    title: parsedRole ?? titleFallback,
    task: resolvedTask,
    summary,
  };
}
