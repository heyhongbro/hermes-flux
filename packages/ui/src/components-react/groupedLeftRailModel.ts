/**
 * 桌面端「分组列表」左轨视图模型（纯函数，无 React / 无 DOM）。
 *
 * 【设计意图 (Why)】
 *   参考移动端首页的三段式分组会话模型（BOT / 群聊 / 普通会话），打破桌面经典双轨中
 *   "抽屉内容被左侧微轨选中 Bot 隔离过滤"的限制，让用户在单列中全览所有 BOT、群聊与跨 Bot 普通会话，
 *   并在每条普通会话上继承显示所属 Bot 头像。
 *
 * 【防范的历史坑 (Pitfall)】
 *   1. 为避免桌面分组模式与移动端首页各自维护一套排序、搜索自动展开、Bot 头像继承与
 *      分组标题运行指示规则，本模型直接委托共享 `buildMobileHomeModel` 投影核心三段，
 *      仅覆写桌面分组标题文案键并额外补充全量归档会话与错误信息；
 *   2. `sessions` 大标题严禁挂载运行状态指示器（`headerStatus` 恒为 `null`），
 *      `bots` 与 `groups` 仅在「已折叠且内部有运行中条目」时展示运行指示器，且三组标题均不得携带数量数字。
 *
 * 【约束与规则 (Rules)】
 *   - 严禁引入 react / DOM API；
 *   - 顺序恒定为：BOT → 群聊 → 普通会话；
 *   - 普通会话行强制继承所属 Bot 头像（未匹配回退默认 Bot 头像，禁止留空）。
 */

import { formatLeftRailTime, isSessionFocused } from './leftRailModel.js';
import type { OrgContainerCollapseState } from '../tokens/conversationOrgPrefs.js';
import type {
  DataPhase,
  LeftRailActiveFocus,
  LeftRailFolder,
  LeftRailGroupRoom,
  LeftRailProfile,
  LeftRailProject,
  LeftRailSession,
} from './leftRailModel.js';
import {
  buildMobileHomeModel,
  type MobileBotRowVM,
  type MobileDoneSectionVM,
  type MobileGroupRowVM,
  type MobileHomeModel,
  type MobileHomeSectionVM,
  type MobileOrgContainerSectionVM,
  type MobileSessionRowVM,
} from './mobile/mobileShellModel.js';

export interface GroupedLeftRailModelInput {
  activeSessionId: string;
  activeFocus?: LeftRailActiveFocus;
  sessions: readonly LeftRailSession[];
  profileName: string;
  profiles: readonly LeftRailProfile[];
  groups: readonly LeftRailGroupRoom[];
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
  searchQuery: string;
  gatewayCount?: number;
  isBotsGroupExpanded?: boolean;
  isGroupsGroupExpanded?: boolean;
  isSessionsGroupExpanded?: boolean;
  profilesPhase?: DataPhase;
  sessionsPhase?: DataPhase;
  error?: string;
  nowMs?: number;
}

export interface GroupedArchivedSessionVM {
  id: string;
  title: string;
  ownerBotName: string;
  ownerBotDisplayName: string;
  ownerAvatarUrl?: string;
  timeText: string;
  timestamp?: number;
  isActive: boolean;
  session: LeftRailSession;
}

export interface GroupedLeftRailModel {
  isMultiGateway: boolean;
  searchQuery: string;
  isSearching: boolean;
  botsSection: MobileHomeSectionVM<MobileBotRowVM>;
  projectSections: MobileOrgContainerSectionVM[];
  folderSections: MobileOrgContainerSectionVM[];
  groupsSection: MobileHomeSectionVM<MobileGroupRowVM>;
  sessionsSection: MobileHomeSectionVM<MobileSessionRowVM>;
  archivedSessions: GroupedArchivedSessionVM[];
  doneSection: MobileDoneSectionVM;
  showDoneSection: boolean;
  profilesPhase: DataPhase;
  sessionsPhase: DataPhase;
  hasAnyResult: boolean;
  error: string;
}

/**
 * 构建桌面端单栏分组左轨完整视图模型（纯函数）。
 * 复用 `buildMobileHomeModel` 保证移动端首页与桌面分组左轨 100% 同构投影。
 */
export function buildGroupedLeftRailModel(input: GroupedLeftRailModelInput): GroupedLeftRailModel {
  const botsCollapsed = input.isBotsGroupExpanded === false;
  const groupsCollapsed = input.isGroupsGroupExpanded === false;
  const sessionsCollapsed = input.isSessionsGroupExpanded === false;

  const home: MobileHomeModel = buildMobileHomeModel({
    activeSessionId: input.activeSessionId,
    activeFocus: input.activeFocus,
    profiles: input.profiles,
    groups: input.groups,
    sessions: input.sessions,
    projects: input.projects,
    folders: input.folders,
    assignments: input.assignments,
    doneRoomIds: input.doneRoomIds,
    doneRoomsMap: input.doneRoomsMap,
    containerCollapsed: input.containerCollapsed,
    hiddenProjectIds: input.hiddenProjectIds,
    showDoneSection: input.showDoneSection,
    doneLoading: input.doneLoading,
    doneError: input.doneError,
    profileName: input.profileName,
    searchQuery: input.searchQuery,
    gatewayCount: input.gatewayCount,
    collapsed: {
      bots: botsCollapsed,
      groups: groupsCollapsed,
      sessions: sessionsCollapsed,
    },
    profilesPhase: input.profilesPhase,
    sessionsPhase: input.sessionsPhase,
    nowMs: input.nowMs,
  });

  const query = (input.searchQuery || '').trim().toLowerCase();
  const nowDate = input.nowMs ? new Date(input.nowMs) : new Date();
  const currentFocus: LeftRailActiveFocus =
    input.activeFocus ||
    (input.activeSessionId
      ? { type: 'session', sessionId: input.activeSessionId }
      : { type: 'bot', botName: input.profileName || 'default' });

  const profileMap = new Map<string, LeftRailProfile>();
  for (const profile of input.profiles) {
    profileMap.set(profile.name.toLowerCase(), profile);
    if (profile.displayName) profileMap.set(profile.displayName.toLowerCase(), profile);
  }
  const defaultProfile = input.profiles.find((p) => p.isDefault || p.name.toLowerCase() === 'default');

  const archivedSessions: GroupedArchivedSessionVM[] = input.sessions
    .filter((s) => Boolean(s.isArchived) && !s.hidden && !s.isSubagent)
    .filter((s) => {
      if (!query) return true;
      const owner = profileMap.get((s.botName || 'default').toLowerCase()) ?? defaultProfile;
      return [s.title, s.preview, s.botDisplayName, owner?.displayName, s.botName].some(
        (field) => Boolean(field && field.toLowerCase().includes(query)),
      );
    })
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
    .map((s) => {
      const owner = profileMap.get((s.botName || 'default').toLowerCase()) ?? defaultProfile;
      const ownerBotName = owner?.name || s.botName || 'default';
      return {
        id: s.id,
        title: s.title,
        ownerBotName,
        ownerBotDisplayName: owner?.displayName || s.botDisplayName || ownerBotName,
        ownerAvatarUrl: owner?.avatar || s.botAvatar || undefined,
        timeText: s.time || formatLeftRailTime(s.timestamp, nowDate),
        timestamp: s.timestamp,
        isActive: isSessionFocused(currentFocus, s.id),
        session: s,
      };
    });

  return {
    isMultiGateway: home.isMultiGateway,
    searchQuery: home.searchQuery,
    isSearching: home.isSearching,
    botsSection: { ...home.botsSection, titleKey: 'rail.sectionBots' },
    projectSections: home.projectSections,
    folderSections: home.folderSections,
    groupsSection: { ...home.groupsSection, titleKey: 'rail.sectionGroups' },
    sessionsSection: { ...home.sessionsSection, titleKey: 'rail.sectionSessions' },
    archivedSessions,
    doneSection: { ...home.doneSection, titleKey: 'rail.done' },
    showDoneSection: home.showDoneSection,
    profilesPhase: home.profilesPhase,
    sessionsPhase: home.sessionsPhase,
    hasAnyResult: home.hasAnyResult,
    error: (input.error || '').trim(),
  };
}
