/**
 * 左轨视图模型（纯函数，无 React、无 DOM）。
 *
 * 设计意图 (Why)：左轨的"呈现什么"是一套可穷举的派生子集（焦点解析 → 上下文隔离 → 搜索过滤 → 时间倒序），
 * 与"怎么画"彻底分层。模型定居此处后，React 组件只做映射，测试可直接对派生结果断言，无需切片字符串。
 * 防范的历史坑 (Pitfall)：模板时代把派生逻辑与 900 行 HTML 揉在同一函数里，任何改版都必须靠 substring 断言，
 * 一度出现"断言通过但界面错"的假绿。
 * 约束与规则 (Rules)：本模块禁止 import react / DOM；禁止推测数据管道（主工位卡数据仍由 core 的
 * botActivitySync 供给，这里只做展示层选择与排序）。
 */

import { t } from '../i18n/index.js';
import { resolveDataPhase, type DataPhase } from './loadPhase.js';
import type { OrgContainerCollapseState } from '../tokens/conversationOrgPrefs.js';
import {
  partitionRailOrgEntities,
  type PartitionedContainerBucket,
} from './railOrgPartition.js';
import type {
  ActivityState,
  ActivityTransition,
  LeftRailActiveFocus,
  LeftRailFolder,
  LeftRailGroupRoom,
  LeftRailProfile,
  LeftRailProject,
  LeftRailSession,
  RailEntityGatewayBadge,
  WaitingPromptReason,
} from '../components/LeftRail/types.js';

export type {
  ActivityState,
  ActivityTransition,
  DataPhase,
  LeftRailActiveFocus,
  LeftRailFolder,
  LeftRailGroupRoom,
  LeftRailProfile,
  LeftRailProject,
  LeftRailSession,
  RailEntityGatewayBadge,
  WaitingPromptReason,
};

export interface LeftRailSessionEntry {
  kind: 'session';
  session: LeftRailSession;
  isDone: boolean;
  containerId: string | null;
  hasCwdProjectMatch: boolean;
  sortTimestamp: number;
  isPinnedSort: boolean;
}

export interface LeftRailGroupEntry {
  kind: 'group';
  group: LeftRailGroupRoom;
  isDone: boolean;
  containerId: string | null;
  sortTimestamp: number;
  isPinnedSort: false;
}

export type LeftRailContainerEntry = LeftRailGroupEntry | LeftRailSessionEntry;
export type LeftRailContainerSection = PartitionedContainerBucket<LeftRailContainerEntry>;

export interface LeftRailModelInput {
  activeSessionId: string;
  activeFocus?: LeftRailActiveFocus;
  sessions: LeftRailSession[];
  profileName: string;
  profiles: LeftRailProfile[];
  groups: LeftRailGroupRoom[];
  projects?: LeftRailProject[];
  folders?: LeftRailFolder[];
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
  isSessionsGroupExpanded?: boolean;
  isGroupsGroupExpanded?: boolean;
  /** Agent 域首次到达相位；缺省 ready。 */
  profilesPhase?: DataPhase;
  /** 会话域首次到达相位；缺省 ready。 */
  sessionsPhase?: DataPhase;
  error?: string;
}

export interface LeftRailModel {
  isMultiGateway: boolean;
  currentFocus: LeftRailActiveFocus;
  selectedAgent: LeftRailProfile;
  isDefaultHq: boolean;
  defaultAgent: LeftRailProfile;
  otherAgents: LeftRailProfile[];
  allAgents: LeftRailProfile[];
  activeSessions: LeftRailSession[];
  archivedSessions: LeftRailSession[];
  visibleGroups: LeftRailGroupRoom[];
  projectContainers: LeftRailContainerSection[];
  folderContainers: LeftRailContainerSection[];
  unassignedGroups: LeftRailGroupRoom[];
  unassignedSessions: LeftRailSession[];
  doneItems: LeftRailContainerEntry[];
  doneIsCollapsed: boolean;
  doneEffectiveExpanded: boolean;
  showDoneSection: boolean;
  doneLoading: boolean;
  doneError: string;
  isSessionsOpen: boolean;
  isGroupsOpen: boolean;
  /** Agent 域首次到达相位：loading 时微轨与主工位卡只出骨架，不伪造默认助理。 */
  profilesPhase: DataPhase;
  /** 会话域首次到达相位：loading 时会话区只出骨架行，不说"暂无历史会话"。 */
  sessionsPhase: DataPhase;
  error: string;
}

/**
 * 骨架清洗：把消息正文压成单行摘要。
 * 设计意图 (Why)：副标题的扫描价值是"快速定位聊到哪"，必须抹掉代码块与 Markdown 标题噪音。
 */
export function toSnippet(text: string | undefined, maxLen = 32): string {
  if (!text) return '';
  const cleaned = text
    .replace(/```[\s\S]*?```/g, t('common.codeBlock'))
    .replace(/^#+\s+/gm, '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return '';
  return cleaned.length <= maxLen ? cleaned : `${cleaned.slice(0, maxLen)}...`;
}

/**
 * 行内时间唯一真值格式化器（PR-3d 收敛）。
 * 规格：当日 HH:mm；昨天="昨天"；前天="前天"；同年更早 M/D；跨年 YYYY/M/D。
 * 设计意图 (Why)：时间只承担"多久以前"的定位，昨日/前日已含足够语义，时分是噪音；
 *   renderer 的 formatSessionTime 与 core 管道的 formatTime 注入全部委托本函数，
 *   全链路（session.time、profile.lastTime、行内兜底）从此同形。
 * 防范的历史坑 (Pitfall)：曾有两份格式化器（renderer 两段式"昨天 23:30" vs 本函数紧凑式），
 *   行组件优先上游字符串导致长格式永远赢、时间列撑宽挤标题（2026-11-04 用户实测）；
 *   也曾无条件本地覆盖上游时间，导致主工位卡与生产产物对不上。
 * 约束与规则 (Rules)：纯算术格式化，禁止 Intl / toLocaleString（渲染热路径）；
 *   修改输出规格必须同步 packages/core/__tests__/formal/rail-time-format-formal.test.mjs 定理。
 */
export function formatLeftRailTime(timestamp?: number, now: Date = new Date()): string {
  if (!timestamp || !Number.isFinite(timestamp) || timestamp <= 0) return '';
  if (!Number.isFinite(now?.getTime())) return '';
  const date = new Date(timestamp > 1e11 ? timestamp : timestamp * 1000);
  if (!Number.isFinite(date.getTime())) return '';
  if (date.getFullYear() !== now.getFullYear()) {
    return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
  }
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const dayBefore = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 2);
  const sameDay = (a: Date, b: Date): boolean => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (sameDay(date, now)) {
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  }
  if (sameDay(date, yesterday)) return t('time.yesterday');
  if (sameDay(date, dayBefore)) return t('time.dayBefore');
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

/** 单双网关统合来源微标构建（单网关严格返回 undefined，保证像素零变化）。 */
export function buildEntityGatewayBadge(
  isMultiGateway: boolean,
  gatewayLabel?: string,
  gatewayOffline?: boolean,
  crossGateway?: boolean,
): RailEntityGatewayBadge | undefined {
  if (!isMultiGateway || !gatewayLabel) return undefined;
  return {
    label: gatewayLabel,
    ...(gatewayOffline ? { offline: true } : {}),
    ...(crossGateway ? { crossGateway: true } : {}),
  };
}

function gatewayMatches(scopeGatewayId?: string, entityGatewayId?: string): boolean {
  if (!scopeGatewayId || !entityGatewayId) return true;
  return scopeGatewayId === entityGatewayId;
}

/** 会话归属判定：Default 中枢持有通用会话，专职 Bot 只持有自身名下会话；多网关时追加 gatewayId 隔离。 */
function belongsToAgent(session: LeftRailSession, agent: LeftRailProfile, isDefaultHq: boolean): boolean {
  if (!gatewayMatches(agent.gatewayId, session.gatewayId)) return false;
  const botName = (session.botName || 'default').toLowerCase();
  if (isDefaultHq) return botName === 'default' || !session.botName;
  const botDisplay = (session.botDisplayName || '').toLowerCase();
  const agentDisplay = (agent.displayName || '').toLowerCase();
  return botName === agent.name.toLowerCase() || (Boolean(agentDisplay) && botDisplay === agentDisplay);
}

/** 群聊归属判定：Default 中枢是主大厅，专职 Bot 只列自己参与的群；多网关时追加 gatewayId 匹配。 */
function groupBelongsToAgent(group: LeftRailGroupRoom, agent: LeftRailProfile, isDefaultHq: boolean): boolean {
  if (!gatewayMatches(agent.gatewayId, group.gatewayId)) return false;
  if (isDefaultHq) return true;
  const members = (group.members || []).map((m) => m.toLowerCase());
  return members.includes(agent.name.toLowerCase())
    || Boolean(agent.displayName) && members.includes((agent.displayName || '').toLowerCase());
}

function matchesQuery(query: string, ...fields: Array<string | undefined>): boolean {
  if (!query) return true;
  return fields.some((field) => (field || '').toLowerCase().includes(query));
}

/**
 * 从壳层的原始快照派生抽屉与微轨的完整视图模型。
 * 【约束与规则】纯函数；同样的输入必须给出逐字节一致的排序结果（排序键包含稳定兜底）。
 */
export function buildLeftRailModel(input: LeftRailModelInput): LeftRailModel {
  const query = (input.searchQuery || '').toLowerCase().trim();
  const error = (input.error || '').trim();
  const profiles = input.profiles || [];
  const sessions = input.sessions || [];
  const groups = input.groups || [];

  const currentFocus: LeftRailActiveFocus = input.activeFocus
    || (input.activeSessionId
      ? { type: 'session', sessionId: input.activeSessionId }
      : { type: 'bot', botName: input.profileName || 'default' });

  const activeSession = sessions.find(
    (s) => s.id === input.activeSessionId && gatewayMatches(currentFocus.gatewayId, s.gatewayId),
  );
  const currentAgentName = currentFocus.type === 'bot'
    ? currentFocus.botName
    : currentFocus.type === 'session'
      ? (activeSession?.botName || input.profileName || 'default')
      : (input.profileName || 'default');
  const currentGatewayId = currentFocus.gatewayId || activeSession?.gatewayId;

  const selectedAgent: LeftRailProfile = profiles.find(
    (p) => p.name.toLowerCase() === currentAgentName.toLowerCase() && gatewayMatches(currentGatewayId, p.gatewayId),
  )
    || profiles.find((p) => p.name.toLowerCase() === currentAgentName.toLowerCase())
    || profiles.find((p) => p.isDefault && gatewayMatches(currentGatewayId, p.gatewayId))
    || profiles.find((p) => p.isDefault)
    || {
      name: currentAgentName,
      displayName: currentAgentName === 'default' ? t('rail.defaultAssistant') : currentAgentName,
      avatar: '',
      lastMessage: '',
      lastTime: '',
      activityState: 'read',
      ...(currentGatewayId ? { gatewayId: currentGatewayId } : {}),
    };

  const defaultAgent: LeftRailProfile = profiles.find(
    (p) => (p.isDefault || p.name.toLowerCase() === 'default') && gatewayMatches(currentGatewayId, p.gatewayId),
  )
    || profiles.find((p) => p.isDefault || p.name.toLowerCase() === 'default')
    || {
      name: 'default',
      displayName: t('rail.defaultAssistant'),
      avatar: '',
      activityState: 'read',
    };

  const isDefaultHq = selectedAgent.name.toLowerCase() === 'default';
  const byNewest = <T extends { timestamp?: number }>(a: T, b: T): number => (b.timestamp || 0) - (a.timestamp || 0);
  const byRoomUpdated = (a: LeftRailGroupRoom, b: LeftRailGroupRoom): number =>
    (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0);

  const doneRoomSet = new Set(input.doneRoomIds || []);

  const scoped = sessions.filter((s) => belongsToAgent(s, selectedAgent, isDefaultHq));
  const activeSessions = scoped
    .filter((s) => !s.isArchived && !s.isDone && matchesQuery(query, s.title, s.preview, s.gatewayLabel))
    .sort(byNewest);
  const archivedSessions = scoped
    .filter((s) => Boolean(s.isArchived || s.isDone) && matchesQuery(query, s.title, s.gatewayLabel))
    .sort(byNewest);

  const agentScopedGroups = groups.filter((g) => groupBelongsToAgent(g, selectedAgent, isDefaultHq));
  const visibleGroups = agentScopedGroups
    .filter((g) => !g.isDone && !doneRoomSet.has(g.roomId))
    .filter((g) => matchesQuery(query, g.name, g.lastMessage, g.gatewayLabel))
    .sort(byRoomUpdated);

  const partitioned = partitionRailOrgEntities<LeftRailSessionEntry, LeftRailGroupEntry>({
    sessions: scoped,
    groups: agentScopedGroups,
    projects: input.projects,
    folders: input.folders,
    assignments: input.assignments,
    doneRoomIds: input.doneRoomIds,
    doneRoomsMap: input.doneRoomsMap,
    containerCollapsed: input.containerCollapsed,
    hiddenProjectIds: input.hiddenProjectIds,
    searchQuery: input.searchQuery,
    matchesSessionSearch: (s, q) => matchesQuery(q, s.title, s.preview, s.gatewayLabel),
    matchesGroupSearch: (g, q) => matchesQuery(q, g.name, g.lastMessage, g.gatewayLabel),
    mapSession: (s, meta) => ({
      kind: 'session',
      session: s,
      isDone: meta.isDone,
      containerId: meta.containerId,
      hasCwdProjectMatch: meta.hasCwdProjectMatch,
      sortTimestamp: s.timestamp || 0,
      isPinnedSort: Boolean(s.isPinned),
    }),
    mapGroup: (g, meta) => ({
      kind: 'group',
      group: g,
      isDone: meta.isDone,
      containerId: meta.containerId,
      sortTimestamp: g.updatedAt || g.createdAt || 0,
      isPinnedSort: false,
    }),
  });

  const isMultiGateway = (input.gatewayCount ?? 1) >= 2;
  const allAgents = profiles
    .filter((p) => matchesQuery(query, p.displayName, p.name, p.description, p.lastMessage, p.gatewayLabel))
    .sort((a, b) => {
      const gwCmp = (a.gatewayId || '').localeCompare(b.gatewayId || '');
      if (isMultiGateway && gwCmp !== 0) {
        return (b.timestamp || 0) - (a.timestamp || 0) || gwCmp;
      }
      const aDef = a.isDefault || a.name.toLowerCase() === 'default' ? 1 : 0;
      const bDef = b.isDefault || b.name.toLowerCase() === 'default' ? 1 : 0;
      return bDef - aDef || (b.timestamp || 0) - (a.timestamp || 0) || a.name.localeCompare(b.name);
    });

  const otherAgents = profiles
    .filter((p) => !p.isDefault && p.name.toLowerCase() !== 'default')
    .filter((p) => matchesQuery(query, p.displayName, p.name, p.description, p.lastMessage, p.gatewayLabel))
    .sort(byNewest);

  return {
    isMultiGateway,
    currentFocus,
    selectedAgent,
    isDefaultHq,
    defaultAgent,
    otherAgents,
    allAgents,
    activeSessions,
    archivedSessions,
    visibleGroups,
    projectContainers: partitioned.projectContainers,
    folderContainers: partitioned.folderContainers,
    unassignedGroups: partitioned.unassignedGroups.map((entry) => entry.group),
    unassignedSessions: partitioned.unassignedSessions.map((entry) => entry.session),
    doneItems: partitioned.doneItems,
    doneIsCollapsed: partitioned.doneIsCollapsed,
    doneEffectiveExpanded: partitioned.doneEffectiveExpanded,
    showDoneSection: input.showDoneSection !== false,
    doneLoading: Boolean(input.doneLoading),
    doneError: (input.doneError || '').trim(),
    isSessionsOpen: input.isSessionsGroupExpanded !== false,
    isGroupsOpen: input.isGroupsGroupExpanded !== false,
    profilesPhase: resolveDataPhase(input.profilesPhase),
    sessionsPhase: resolveDataPhase(input.sessionsPhase),
    error,
  };
}

/** 焦点归属判定：用于行高亮与激活指示条，避免组件内出现三重 if 链。 */
export function isSessionFocused(focus: LeftRailActiveFocus, sessionId: string, gatewayId?: string): boolean {
  return focus.type === 'session' && focus.sessionId === sessionId && gatewayMatches(focus.gatewayId, gatewayId);
}

export function isGroupFocused(focus: LeftRailActiveFocus, roomId: string, gatewayId?: string): boolean {
  return focus.type === 'group' && focus.roomId === roomId && gatewayMatches(focus.gatewayId, gatewayId);
}

export function isBotFocused(focus: LeftRailActiveFocus, botName: string, gatewayId?: string): boolean {
  return (
    focus.type === 'bot' &&
    focus.botName.toLowerCase() === botName.toLowerCase() &&
    gatewayMatches(focus.gatewayId, gatewayId)
  );
}

/**
 * 微轨 Agent 作用域活跃判定（纯函数）。
 * 设计意图 (Why)：微轨代表当前工作台的 Agent 主权上下文。无论用户处于该 Agent 的专属工位、
 *   该 Agent 名下的普通会话，还是在该 Agent 上下文下查看群聊，微轨对应的 Agent 头像必须持续保有选中高亮效果。
 * 防范的历史坑 (Pitfall)：曾仅匹配 focus.type === 'bot'，用户一旦点开普通会话或群聊微轨高亮立即熄灭，视觉锚点丢失。
 * 约束与规则 (Rules)：大小写不敏感匹配；找不到 session 时回退 selectedAgentName；多网关下附带 gatewayId 判定。
 */
export function isAgentScopeActive(params: {
  agentName: string;
  agentGatewayId?: string;
  focus: LeftRailActiveFocus;
  selectedAgentName: string;
  selectedAgentGatewayId?: string;
  activeSessionBotName?: string;
  activeSessionGatewayId?: string;
}): boolean {
  const target = params.agentName.toLowerCase();

  // 1. 焦点直接落在专职 Bot 工位
  if (params.focus.type === 'bot') {
    return (
      params.focus.botName.toLowerCase() === target &&
      gatewayMatches(params.focus.gatewayId, params.agentGatewayId)
    );
  }

  // 2. 焦点在普通会话：优先匹配该会话所属的 botName，其次匹配当前抽屉上下文的 selectedAgent
  if (params.focus.type === 'session') {
    const scopeGw = params.activeSessionGatewayId || params.focus.gatewayId || params.selectedAgentGatewayId;
    if (!gatewayMatches(scopeGw, params.agentGatewayId)) {
      return false;
    }
    if (params.activeSessionBotName) {
      return params.activeSessionBotName.toLowerCase() === target;
    }
    return params.selectedAgentName.toLowerCase() === target;
  }

  // 3. 焦点在群聊：微轨保持当前承载抽屉会话的 selectedAgent 选中态
  return (
    params.selectedAgentName.toLowerCase() === target &&
    gatewayMatches(params.focus.gatewayId || params.selectedAgentGatewayId, params.agentGatewayId)
  );
}
