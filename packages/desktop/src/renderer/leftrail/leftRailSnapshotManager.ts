/**
 * 左轨实体装饰与快照管理领域（Left Rail Snapshot Manager）
 *
 * 【设计意图 (Why)】
 *   将左轨微轨+抽屉的会话、群聊与 Agent 实体装饰、WeakMap 引用指纹复用、
 *   状态机过渡动画 Token 映射与快照判等逻辑从 `renderer/index.ts` 中完全解耦。
 *   实现零 DOM 依赖的纯数据流与缓存投影层，使左轨 42+ 个复杂实体在高频状态变迁
 *   （如流式 token 逐帧刷新、心跳探测、搜索过滤）下的引用稳定性可被单测直接验证。
 *
 * 【防范的历史坑 (Pitfall)】
 *   1. 必须使用源对象 + 渲染字段复合指纹：会话的 preview 与 timestamp 会原地被改写，
 *      如果只做初次缓存会导致标题和副标题无法更新；
 *   2. 数组引用稳定性：元素全等时复用前序数组引用，防止 React.memo 在深层对比时全部击穿；
 *   3. 三态隔离：会话、群聊、Agent 的未读/运行中状态严格按集合隔离，禁止跨域冒泡。
 *
 * 【约束与规则 (Rules)】
 *   1. 纯 TypeScript 领域模块，禁止任何 DOM 或平台特定 API 调用；
 *   2. 依赖项与外部状态全部通过 LeftRailSnapshotHost 注入；
 *   3. 严禁 `as any`，类型严格推导。
 */

import {
  buildLeftRailModel,
  buildGroupedLeftRailModel,
  resolveLeftRailLayout,
  type LeftRailLayoutMode,
  type LeftRailFolder,
  type LeftRailProject,
  type LeftRailSession,
  type LeftRailGroupRoom,
  type LeftRailProfile,
  type LeftRailActiveFocus,
  type LeftRailSnapshot,
  type OrgContainerCollapseState,
  type ActivityTransition,
  type ActivityIndicatorVariant,
  type DataPhase,
} from '@hermes-flux/ui';

import {
  normalizeOrgProfileName,
  resolveActivityState,
  type NormalizedSession,
  type AgentProfile,
  type ActivityState,
} from '@hermes-flux/core';
import type { WaitingPromptReason } from '@hermes-flux/core';

export interface RailDecorCacheEntry<T> {
  stamp: string;
  value: T;
}

export interface LeftRailSnapshotInputs {
  sessions: LeftRailSession[];
  groups: LeftRailGroupRoom[];
  profiles: LeftRailProfile[];
  projects?: LeftRailProject[];
  folders?: LeftRailFolder[];
  assignments?: Readonly<Record<string, string>>;
  doneRoomsMap?: Readonly<Record<string, number>>;
  containerCollapsed?: OrgContainerCollapseState;
  hiddenProjectIds?: readonly string[];
  showDoneSection?: boolean;
  doneLoading?: boolean;
  doneError?: string;
  activeSessionId: string;
  activeFocus: LeftRailActiveFocus;
  profileName: string;
  searchQuery: string;
  layout?: LeftRailLayoutMode;
  isBotsGroupExpanded?: boolean;
  isSessionsGroupExpanded: boolean;
  isGroupsGroupExpanded: boolean;
  error: string;
  collapsed: boolean;
  editingGroupRoomId?: string;
  profilesPhase: DataPhase;
  sessionsPhase: DataPhase;
  activityVariant: ActivityIndicatorVariant;
}

export interface LeftRailSnapshotHost {
  readonly getSessions: () => readonly NormalizedSession[];
  readonly getArchivedSessions?: () => readonly NormalizedSession[];
  readonly getGroupRooms: () => readonly LeftRailGroupRoom[];
  readonly getProfiles: () => readonly AgentProfile[];
  readonly getProjects?: () => readonly LeftRailProject[];
  readonly getFolders?: () => readonly LeftRailFolder[];
  readonly getAssignments?: () => Readonly<Record<string, string>>;
  readonly getDoneRoomsMap?: () => Readonly<Record<string, number>>;
  readonly getContainerCollapsed?: () => OrgContainerCollapseState;
  readonly getHiddenProjectIds?: () => readonly string[];
  readonly getShowDoneSection?: () => boolean;
  readonly getDoneLoading?: () => boolean;
  readonly getDoneError?: () => string;
  readonly getActiveSessionId: () => string;
  readonly getActiveFocus: () => LeftRailActiveFocus;
  readonly getProfileName: () => string;
  readonly getSearchQuery: () => string;
  readonly getLayout?: () => LeftRailLayoutMode;
  readonly isBotsGroupExpanded?: () => boolean;
  readonly isSessionsGroupExpanded: () => boolean;
  readonly isGroupsGroupExpanded: () => boolean;
  readonly getError: () => string;
  readonly isCollapsed: () => boolean;
  readonly getEditingGroupRoomId: () => string | undefined;
  readonly getProfilesPhase: () => DataPhase;
  readonly getSessionsPhase: () => DataPhase;
  readonly getActivityVariant: () => ActivityIndicatorVariant;
  readonly getActiveRunningSessionIds: () => ReadonlySet<string>;
  readonly getUnreadSessionIds: () => ReadonlySet<string>;
  readonly getActiveStreamingStoredSessionId: () => string | null;
  readonly getActiveRunningGroupRoomIds: () => ReadonlySet<string>;
  readonly getUnreadGroupRoomIds: () => ReadonlySet<string>;
  readonly getActiveRunningBotNames: () => ReadonlySet<string>;
  readonly getUnreadBotNames: () => ReadonlySet<string>;
  readonly getWaitingEntityMaps?: () => {
    sessionWaitingReasons: Map<string, WaitingPromptReason>;
    groupWaitingReasons: Map<string, WaitingPromptReason>;
  };
  readonly getBotForeverSessionMap?: () => ReadonlyMap<string, string>;
  readonly resolveAgentAvatar: (name?: string) => string;
  readonly resolveTransition: (
    scope: 'session' | 'bot' | 'group',
    id: string,
    state: ActivityState,
    now: number
  ) => { transition: ActivityTransition; transitionToken?: number };
}

/** 元素引用完全一致时复用旧数组，保证行组件收到的数组 prop 也稳定。 */
export function stableArray<T>(next: T[], previous: T[]): T[] {
  return next.length === previous.length && next.every((item, index) => item === previous[index])
    ? previous
    : next;
}

function sameShallowArray<T>(a?: readonly T[], b?: readonly T[]): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every((item, idx) => item === b[idx]);
}

export function sameLeftRailInputs(
  prev: LeftRailSnapshotInputs,
  next: LeftRailSnapshotInputs
): boolean {
  return (
    prev.sessions === next.sessions &&
    prev.groups === next.groups &&
    prev.profiles === next.profiles &&
    prev.activeSessionId === next.activeSessionId &&
    prev.activeFocus === next.activeFocus &&
    prev.profileName === next.profileName &&
    prev.searchQuery === next.searchQuery &&
    prev.layout === next.layout &&
    prev.isBotsGroupExpanded === next.isBotsGroupExpanded &&
    prev.isSessionsGroupExpanded === next.isSessionsGroupExpanded &&
    prev.isGroupsGroupExpanded === next.isGroupsGroupExpanded &&
    prev.error === next.error &&
    prev.collapsed === next.collapsed &&
    prev.profilesPhase === next.profilesPhase &&
    prev.sessionsPhase === next.sessionsPhase &&
    prev.activityVariant === next.activityVariant &&
    prev.editingGroupRoomId === next.editingGroupRoomId &&
    sameShallowArray(prev.projects, next.projects) &&
    sameShallowArray(prev.folders, next.folders) &&
    prev.assignments === next.assignments &&
    prev.doneRoomsMap === next.doneRoomsMap &&
    prev.containerCollapsed === next.containerCollapsed &&
    sameShallowArray(prev.hiddenProjectIds, next.hiddenProjectIds) &&
    prev.showDoneSection === next.showDoneSection &&
    prev.doneLoading === next.doneLoading &&
    prev.doneError === next.doneError
  );
}

export class LeftRailSnapshotManager {
  private railSessionDecorCache = new WeakMap<NormalizedSession, RailDecorCacheEntry<LeftRailSession>>();
  private railGroupDecorCache = new WeakMap<LeftRailGroupRoom, RailDecorCacheEntry<LeftRailGroupRoom>>();
  private railProfileDecorCache = new WeakMap<AgentProfile, RailDecorCacheEntry<LeftRailProfile>>();

  private lastDecoratedSessions: LeftRailSession[] = [];
  private lastDecoratedGroups: LeftRailGroupRoom[] = [];
  private lastDecoratedProfiles: LeftRailProfile[] = [];

  private lastLeftRailSnapshot: LeftRailSnapshot | null = null;
  private lastLeftRailInputs: LeftRailSnapshotInputs | null = null;

  constructor(private readonly host: LeftRailSnapshotHost) {}

  public decorateSessions(nowMs: number): LeftRailSession[] {
    const activeRaw = this.host.getSessions();
    const archivedRaw = this.host.getArchivedSessions?.() ?? [];
    const mergedRaw: NormalizedSession[] = [];
    const seenKeys = new Set<string>();
    for (const s of activeRaw) {
      if (!s?.id) continue;
      const key = `${normalizeOrgProfileName(s.botName)}::${s.id}`;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      mergedRaw.push(s);
    }
    for (const s of archivedRaw) {
      if (!s?.id) continue;
      const key = `${normalizeOrgProfileName(s.botName)}::${s.id}`;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      mergedRaw.push(s);
    }
    const runningIds = this.host.getActiveRunningSessionIds();
    const unreadIds = this.host.getUnreadSessionIds();
    const streamingId = this.host.getActiveStreamingStoredSessionId();
    const sessionWaitingReasons = this.host.getWaitingEntityMaps?.().sessionWaitingReasons;
    const waitingIds = sessionWaitingReasons ? new Set(sessionWaitingReasons.keys()) : undefined;

    const next = mergedRaw.map((s) => {
      const activityState = resolveActivityState(s.id, {
        waitingIds,
        runningIds,
        unreadIds,
        streamingId,
      });
      const waitingReason = sessionWaitingReasons?.get(s.id);
      const transitionRes = this.host.resolveTransition('session', s.id, activityState, nowMs);
      const activityTransition: ActivityTransition = transitionRes.transition;
      const activityTransitionToken = transitionRes.transitionToken;
      const cached = this.railSessionDecorCache.get(s);

      if (
        cached &&
        cached.value.title === s.title &&
        cached.value.preview === s.preview &&
        cached.value.time === s.time &&
        cached.value.timestamp === s.timestamp &&
        cached.value.isArchived === s.isArchived &&
        cached.value.cwd === s.cwd &&
        cached.value.isPinned === s.pinned &&
        cached.value.botName === s.botName &&
        cached.value.botDisplayName === s.botDisplayName &&
        cached.value.botAvatar === s.botAvatar &&
        cached.value.activityState === activityState &&
        cached.value.waitingReason === waitingReason &&
        cached.value.activityTransition === activityTransition &&
        cached.value.activityTransitionToken === activityTransitionToken
      ) {
        return cached.value;
      }
      const value: LeftRailSession = {
        ...s,
        isPinned: s.pinned,
        activityState,
        ...(waitingReason ? { waitingReason } : {}),
        activityTransition,
        activityTransitionToken,
      };
      this.railSessionDecorCache.set(s, { stamp: '', value });
      return value;
    });

    this.lastDecoratedSessions = stableArray(next, this.lastDecoratedSessions);
    return this.lastDecoratedSessions;
  }

  public decorateGroups(nowMs: number): LeftRailGroupRoom[] {
    const rawGroups = this.host.getGroupRooms();
    const runningIds = this.host.getActiveRunningGroupRoomIds();
    const unreadIds = this.host.getUnreadGroupRoomIds();
    const groupWaitingReasons = this.host.getWaitingEntityMaps?.().groupWaitingReasons;
    const waitingIds = groupWaitingReasons ? new Set(groupWaitingReasons.keys()) : undefined;

    const next = rawGroups.map((g) => {
      const activityState = resolveActivityState(g.roomId, {
        waitingIds,
        runningIds,
        unreadIds,
      });
      const waitingReason = groupWaitingReasons?.get(g.roomId);
      const transitionRes = this.host.resolveTransition('group', g.roomId, activityState, nowMs);
      const activityTransition: ActivityTransition = transitionRes.transition;
      const activityTransitionToken = transitionRes.transitionToken;
      const stamp = [
        g.name,
        (g.members || []).join('\u0002'),
        g.lastMessage,
        g.updatedAt,
        g.createdAt,
        activityState,
        waitingReason ?? '',
        activityTransition,
        activityTransitionToken ?? '',
      ].join('\u0001');

      const cached = this.railGroupDecorCache.get(g);
      if (cached && cached.stamp === stamp) return cached.value;

      const value: LeftRailGroupRoom = {
        ...g,
        activityState,
        ...(waitingReason ? { waitingReason } : {}),
        activityTransition,
        activityTransitionToken,
      };
      this.railGroupDecorCache.set(g, { stamp, value });
      return value;
    });

    this.lastDecoratedGroups = stableArray(next, this.lastDecoratedGroups);
    return this.lastDecoratedGroups;
  }

  public decorateProfiles(nowMs: number): LeftRailProfile[] {
    const rawProfiles = this.host.getProfiles();
    const runningIds = this.host.getActiveRunningBotNames();
    const unreadIds = this.host.getUnreadBotNames();
    const sessionWaitingReasons = this.host.getWaitingEntityMaps?.().sessionWaitingReasons;
    const foreverMap = this.host.getBotForeverSessionMap?.();
    const botWaitingReasons = new Map<string, WaitingPromptReason>();
    const botForeverSidByName = new Map<string, string>();
    if (foreverMap) {
      for (const [sid, botName] of foreverMap.entries()) {
        botForeverSidByName.set(botName, sid);
        const reason = sessionWaitingReasons?.get(sid);
        if (reason && !botWaitingReasons.has(botName)) {
          botWaitingReasons.set(botName, reason);
        }
      }
    }
    const childWaitingBots = new Set<string>();
    if (sessionWaitingReasons && sessionWaitingReasons.size > 0) {
      for (const s of this.host.getSessions()) {
        if (!s?.id || !s.botName) continue;
        if (!sessionWaitingReasons.has(s.id)) continue;
        const foreverSid = botForeverSidByName.get(s.botName);
        if (s.id !== foreverSid) {
          childWaitingBots.add(s.botName);
        }
      }
    }
    const waitingIds = botWaitingReasons.size > 0 ? new Set(botWaitingReasons.keys()) : undefined;

    const next = rawProfiles.map((p) => {
      const avatar =
        p.avatar ||
        this.host.resolveAgentAvatar(p.name) ||
        (p.displayName ? this.host.resolveAgentAvatar(p.displayName) : '') ||
        '';
      const activityState = resolveActivityState(p.name, {
        waitingIds,
        runningIds,
        unreadIds,
      });
      const waitingReason = botWaitingReasons.get(p.name);
      const hasChildWaitingPrompt = childWaitingBots.has(p.name);
      const transitionRes = this.host.resolveTransition('bot', p.name, activityState, nowMs);
      const activityTransition: ActivityTransition = transitionRes.transition;
      const activityTransitionToken = transitionRes.transitionToken;
      const stamp = [
        p.name,
        p.displayName,
        avatar,
        p.description,
        p.lastMessage,
        p.lastTime,
        p.timestamp,
        p.isDefault ? 1 : 0,
        activityState,
        waitingReason ?? '',
        hasChildWaitingPrompt ? 1 : 0,
        activityTransition,
        activityTransitionToken ?? '',
      ].join('\u0001');

      const cached = this.railProfileDecorCache.get(p);
      if (cached && cached.stamp === stamp) return cached.value;

      const value: LeftRailProfile = {
        ...p,
        avatar,
        activityState,
        ...(waitingReason ? { waitingReason } : {}),
        ...(hasChildWaitingPrompt ? { hasChildWaitingPrompt: true } : {}),
        activityTransition,
        activityTransitionToken,
      };
      this.railProfileDecorCache.set(p, { stamp, value });
      return value;
    });

    this.lastDecoratedProfiles = stableArray(next, this.lastDecoratedProfiles);
    return this.lastDecoratedProfiles;
  }

  public getSnapshot(): LeftRailSnapshot {
    const nowMs = Date.now();
    const sessions = this.decorateSessions(nowMs);
    const groups = this.decorateGroups(nowMs);
    const profiles = this.decorateProfiles(nowMs);
    const layout = resolveLeftRailLayout(this.host.getLayout?.());
    const isBotsGroupExpanded = this.host.isBotsGroupExpanded ? this.host.isBotsGroupExpanded() : true;

    const inputs: LeftRailSnapshotInputs = {
      sessions,
      groups,
      profiles,
      projects: this.host.getProjects ? [...(this.host.getProjects() ?? [])] : undefined,
      folders: this.host.getFolders ? [...(this.host.getFolders() ?? [])] : undefined,
      assignments: this.host.getAssignments?.(),
      doneRoomsMap: this.host.getDoneRoomsMap?.(),
      containerCollapsed: this.host.getContainerCollapsed?.(),
      hiddenProjectIds: this.host.getHiddenProjectIds ? [...(this.host.getHiddenProjectIds() ?? [])] : undefined,
      showDoneSection: this.host.getShowDoneSection?.(),
      doneLoading: this.host.getDoneLoading?.(),
      doneError: this.host.getDoneError?.(),
      activeSessionId: this.host.getActiveSessionId(),
      activeFocus: this.host.getActiveFocus(),
      profileName: this.host.getProfileName(),
      searchQuery: this.host.getSearchQuery(),
      layout,
      isBotsGroupExpanded,
      isSessionsGroupExpanded: this.host.isSessionsGroupExpanded(),
      isGroupsGroupExpanded: this.host.isGroupsGroupExpanded(),
      error: this.host.getError(),
      collapsed: this.host.isCollapsed(),
      editingGroupRoomId: this.host.getEditingGroupRoomId(),
      profilesPhase: this.host.getProfilesPhase(),
      sessionsPhase: this.host.getSessionsPhase(),
      activityVariant: this.host.getActivityVariant(),
    };

    if (
      this.lastLeftRailSnapshot &&
      this.lastLeftRailInputs &&
      sameLeftRailInputs(this.lastLeftRailInputs, inputs)
    ) {
      return this.lastLeftRailSnapshot;
    }

    this.lastLeftRailInputs = inputs;
    const groupedModel =
      layout === 'grouped'
        ? buildGroupedLeftRailModel({
            activeSessionId: inputs.activeSessionId,
            activeFocus: inputs.activeFocus,
            sessions,
            profileName: inputs.profileName,
            profiles,
            groups,
            projects: inputs.projects,
            folders: inputs.folders,
            assignments: inputs.assignments,
            doneRoomsMap: inputs.doneRoomsMap,
            containerCollapsed: inputs.containerCollapsed,
            hiddenProjectIds: inputs.hiddenProjectIds,
            showDoneSection: inputs.showDoneSection,
            doneLoading: inputs.doneLoading,
            doneError: inputs.doneError,
            searchQuery: inputs.searchQuery,
            isBotsGroupExpanded,
            isGroupsGroupExpanded: inputs.isGroupsGroupExpanded,
            isSessionsGroupExpanded: inputs.isSessionsGroupExpanded,
            profilesPhase: inputs.profilesPhase,
            sessionsPhase: inputs.sessionsPhase,
            error: inputs.error,
            nowMs,
          })
        : undefined;

    this.lastLeftRailSnapshot = {
      model: buildLeftRailModel({
        activeSessionId: inputs.activeSessionId,
        activeFocus: inputs.activeFocus,
        sessions,
        profileName: inputs.profileName,
        profiles,
        groups,
        projects: inputs.projects,
        folders: inputs.folders,
        assignments: inputs.assignments,
        doneRoomsMap: inputs.doneRoomsMap,
        containerCollapsed: inputs.containerCollapsed,
        hiddenProjectIds: inputs.hiddenProjectIds,
        showDoneSection: inputs.showDoneSection,
        doneLoading: inputs.doneLoading,
        doneError: inputs.doneError,
        searchQuery: inputs.searchQuery,
        isSessionsGroupExpanded: inputs.isSessionsGroupExpanded,
        isGroupsGroupExpanded: inputs.isGroupsGroupExpanded,
        profilesPhase: inputs.profilesPhase,
        sessionsPhase: inputs.sessionsPhase,
        error: inputs.error,
      }),
      layout,
      groupedModel,
      collapsed: inputs.collapsed,
      searchQuery: inputs.searchQuery,
      editingGroupRoomId: inputs.editingGroupRoomId,
      groupAvatars: profiles,
      activityVariant: inputs.activityVariant,
    };

    return this.lastLeftRailSnapshot;
  }
}
