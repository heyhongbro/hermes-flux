/**
 * 左轨交互控制器 (LeftRailController)
 *
 * 【设计意图 (Why)】
 *   将左侧微轨、抽屉折叠、群聊/会话/Agent 菜单弹出、快速新建任务、手风琴折叠、
 *   群聊乐观重命名及其失败回滚、以及高频实体装饰快照缓存逻辑，从 index.ts 抽离为
 *   独立自治的事件与动作协调器。
 *
 * 【防范的历史坑 (Pitfall)】
 *   1. 群聊乐观改名失败必须显式回滚，否则界面显示"改好了"而服务端还是旧名，刷新后打脸；
 *   2. 点击 Bot/群聊/会话一律不自动展开抽屉（leftRailCollapsed 不动），保留用户当前折叠意图；
 *   3. 宽度拖拽仅委托统一入口，避免内部重写几何；
 *   4. 单向 Deps 注入，严禁反向 import index.ts。
 *
 * 【约束与规则 (Rules)】
 *   - 0 TS 报错，严禁 as any；
 *   - 保持判别联合与不可变数据流更新。
 */

import type {
  HermesGatewayClient,
  GroupRoomStore,
  ActivityTransitionTracker,
  NormalizedSession,
} from '@hermes-flux/core';
import {
  saveGroupedRailSections,
  type LeftRailActions,
  type LeftRailFolder,
  type LeftRailProject,
  type LeftRailSnapshot,
  type LeftRailSession,
  type LeftRailGroupRoom,
  type LeftRailProfile,
  type OrgContainerCollapseState,
  type ActivityIndicatorVariant,
  type t,
} from '@hermes-flux/ui';
import type { AppState } from '../state/appState.js';
import { LeftRailSnapshotManager } from '../leftrail/leftRailSnapshotManager.js';

export interface LeftRailControllerDeps {
  getState: () => AppState;
  render: () => void;
  t: (key: Parameters<typeof t>[0], params?: Record<string, string | number>) => string;
  showToast: (message: string) => void;
  describeRpcError: (error: unknown) => string;
  getGatewayClient: () => HermesGatewayClient | null;
  groupRoomStore: GroupRoomStore;
  cancelColdStartFocus: () => void;
  selectSession: (id: string, opts?: { botName?: string }) => void | Promise<void>;
  openBotChat: (profile: string) => void | Promise<void>;
  openGroupRoom: (roomId: string) => void | Promise<void>;
  fetchProjects: () => void | Promise<void>;
  fetchGroupRooms: () => void | Promise<void>;
  beginLeftRailResize: (event: React.PointerEvent<HTMLDivElement>) => void;
  getActivityVariant: () => ActivityIndicatorVariant;
  activeRunningSessionIds: ReadonlySet<string>;
  unreadSessionIds: ReadonlySet<string>;
  getActiveStreamingStoredSessionId: () => string | null;
  activeRunningGroupRoomIds: ReadonlySet<string>;
  unreadGroupRoomIds: ReadonlySet<string>;
  activeRunningBotNames: ReadonlySet<string>;
  unreadBotNames: ReadonlySet<string>;
  resolveAgentAvatar: (name?: string) => string;
  activityTransitionTracker: ActivityTransitionTracker;
  onToggleContainer?: (containerId: string) => void;
  onRetryDoneSection?: () => void;
  onRequestMarkDone?: (entityKind: 'session' | 'group', id: string, title: string, profile?: string) => void;
  onRestoreDone?: (entityKind: 'session' | 'group', id: string, profile?: string) => void;
  onSearchQueryChanged?: (query: string) => void;
  getMoveEntityContext?: (entityKind: 'session' | 'group', id: string, profile?: string) => {
    isDone: boolean;
    currentContainerId: string | null;
    hasCwdProjectMatch: boolean;
  };
}

export class LeftRailController {
  private readonly deps: LeftRailControllerDeps;
  private readonly snapshotManager: LeftRailSnapshotManager;

  constructor(deps: LeftRailControllerDeps) {
    this.deps = deps;
    this.snapshotManager = new LeftRailSnapshotManager({
      getSessions: () => deps.getState().sessions,
      getArchivedSessions: () => deps.getState().archivedSessions ?? [],
      getGroupRooms: () => deps.getState().groupRooms,
      getProfiles: () => deps.getState().profiles,
      getProjects: () => deps.getState().projects ?? [],
      getFolders: () => deps.getState().orgFolders ?? [],
      getAssignments: () => deps.getState().orgAssignments ?? {},
      getDoneRoomsMap: () => deps.getState().orgDoneRooms ?? {},
      getContainerCollapsed: () => deps.getState().orgContainerCollapsed ?? { done: true },
      getHiddenProjectIds: () => deps.getState().orgPrefs?.hiddenProjectIds ?? [],
      getShowDoneSection: () => deps.getState().orgPrefs?.showDoneSection ?? true,
      getDoneLoading: () => Boolean(deps.getState().doneLoading),
      getDoneError: () => deps.getState().doneError ?? '',
      getActiveSessionId: () => deps.getState().activeSessionId,
      getActiveFocus: () => deps.getState().activeFocus,
      getProfileName: () => deps.getState().profileName,
      getSearchQuery: () => deps.getState().sessionSearchQuery,
      getLayout: () => deps.getState().leftRailLayout,
      isBotsGroupExpanded: () => deps.getState().isBotsGroupExpanded !== false,
      isSessionsGroupExpanded: () => deps.getState().isSessionsGroupExpanded !== false,
      isGroupsGroupExpanded: () => deps.getState().isGroupsGroupExpanded !== false,
      getError: () => deps.getState().sessionListError,
      isCollapsed: () => deps.getState().leftRailCollapsed,
      getEditingGroupRoomId: () => deps.getState().editingGroupRoomId,
      getProfilesPhase: () => deps.getState().profilesPhase,
      getSessionsPhase: () => deps.getState().sessionsPhase,
      getActivityVariant: () => deps.getActivityVariant(),
      getActiveRunningSessionIds: () => deps.activeRunningSessionIds,
      getUnreadSessionIds: () => deps.unreadSessionIds,
      getActiveStreamingStoredSessionId: () => deps.getActiveStreamingStoredSessionId(),
      getActiveRunningGroupRoomIds: () => deps.activeRunningGroupRoomIds,
      getUnreadGroupRoomIds: () => deps.unreadGroupRoomIds,
      getActiveRunningBotNames: () => deps.activeRunningBotNames,
      getUnreadBotNames: () => deps.unreadBotNames,
      resolveAgentAvatar: (name) => deps.resolveAgentAvatar(name),
      resolveTransition: (scope, id, st, now) => deps.activityTransitionTracker.resolveTransition(scope, id, st, now),
    });
  }

  createLeftRailActions(): LeftRailActions {
    const { deps } = this;
    const state = deps.getState();
    const persistGroupedSections = (): void => {
      if (state.leftRailLayout !== 'grouped') return;
      saveGroupedRailSections({
        bots: state.isBotsGroupExpanded !== false,
        groups: state.isGroupsGroupExpanded !== false,
        sessions: state.isSessionsGroupExpanded !== false,
      });
    };
    return {
      onSelectSession: (sessionId: string, botName?: string) => {
        deps.cancelColdStartFocus();
        void deps.selectSession(sessionId, { botName });
      },
      onSelectBot: (profileName: string) => {
        deps.cancelColdStartFocus();
        void deps.openBotChat(profileName);
      },
      onSelectGroup: (roomId: string) => {
        deps.cancelColdStartFocus();
        void deps.openGroupRoom(roomId);
      },
      onOpenSessionMenu: (sessionId: string, title: string, x: number, y: number, profile?: string) => {
        const entityCtx = deps.getMoveEntityContext?.('session', sessionId, profile);
        state.sessionContextMenu = {
          x,
          y,
          targetType: 'session',
          targetId: sessionId,
          targetName: title,
          sessionId,
          sessionTitle: title,
          sessionProfile: profile,
          ...entityCtx,
          projects: state.projects.filter((p) => !p.archived).map((p) => ({ id: p.id, name: p.name })),
          folders: state.orgFolders.map((f) => ({ id: f.id, name: f.name })),
        };
        deps.render();
      },
      onOpenBotMenu: (profileName: string, x: number, y: number) => {
        state.sessionContextMenu = { x, y, targetType: 'bot', targetId: profileName, targetName: profileName };
        deps.render();
      },
      onOpenGroupMenu: (roomId: string, name: string, x: number, y: number) => {
        const entityCtx = deps.getMoveEntityContext?.('group', roomId);
        state.sessionContextMenu = {
          x,
          y,
          targetType: 'group',
          targetId: roomId,
          targetName: name,
          ...entityCtx,
          projects: state.projects.filter((p) => !p.archived).map((p) => ({ id: p.id, name: p.name })),
          folders: state.orgFolders.map((f) => ({ id: f.id, name: f.name })),
        };
        deps.render();
      },
      onOpenFolderMenu: (folderId: string, name: string, x: number, y: number) => {
        state.sessionContextMenu = { x, y, targetType: 'folder', targetId: folderId, targetName: name };
        deps.render();
      },
      onOpenRailMenu: (x: number, y: number) => {
        state.sessionContextMenu = { x, y, targetType: 'rail', targetId: 'rail', targetName: 'rail' };
        deps.render();
      },
      onSearchChange: (value: string) => {
        state.sessionSearchQuery = value;
        deps.onSearchQueryChanged?.(value);
        deps.render();
      },
      onNewChat: (kind: 'session' | 'group') => {
        deps.cancelColdStartFocus();
        void deps.fetchProjects();
        state.selectedNewTaskContainerId = undefined;
        state.selectedNewTaskProjectId = undefined;
        state.newTaskModalTab = kind === 'group' ? 'group' : 'solo';
        state.isNewTaskModalOpen = true;
        deps.render();
      },
      onNewChatInContainer: (kind: 'session' | 'group', containerId: string) => {
        deps.cancelColdStartFocus();
        void deps.fetchProjects();
        state.selectedNewTaskProjectId = undefined;
        state.selectedNewTaskContainerId = containerId;
        state.newTaskModalTab = kind === 'group' ? 'group' : 'solo';
        state.isNewTaskModalOpen = true;
        deps.render();
      },
      onToggleContainer: (containerId: string) => {
        deps.onToggleContainer?.(containerId);
      },
      onToggleDoneSection: () => {
        deps.onToggleContainer?.('done');
      },
      onRetryDoneSection: () => {
        deps.onRetryDoneSection?.();
      },
      onRequestMarkDone: (entityKind: 'session' | 'group', id: string, title: string, profile?: string) => {
        deps.onRequestMarkDone?.(entityKind, id, title, profile);
      },
      onRestoreDone: (entityKind: 'session' | 'group', id: string, profile?: string) => {
        deps.onRestoreDone?.(entityKind, id, profile);
      },
      onToggleBots: () => {
        state.isBotsGroupExpanded = !state.isBotsGroupExpanded;
        persistGroupedSections();
        deps.render();
      },
      onToggleSessions: () => {
        state.isSessionsGroupExpanded = !state.isSessionsGroupExpanded;
        persistGroupedSections();
        deps.render();
      },
      onToggleGroups: () => {
        state.isGroupsGroupExpanded = !state.isGroupsGroupExpanded;
        persistGroupedSections();
        deps.render();
      },
      onStartGroupRename: (roomId: string) => {
        state.editingGroupRoomId = roomId;
        deps.render();
      },
      onConfirmGroupRename: (roomId: string, name: string) => {
        void this.confirmGroupRename(roomId, name);
      },
      onCancelGroupRename: () => {
        state.editingGroupRoomId = undefined;
        deps.render();
      },
      onResizeStart: (event: React.PointerEvent<HTMLDivElement>) => {
        deps.beginLeftRailResize(event);
      },
    };
  }

  async confirmGroupRename(roomId: string, name: string): Promise<void> {
    const { deps } = this;
    const state = deps.getState();
    const client = deps.getGatewayClient();
    const newName = name.trim();
    state.editingGroupRoomId = undefined;
    if (!newName || !client) {
      deps.render();
      return;
    }
    const previousName = state.groupRooms.find((r) => r.roomId === roomId)?.name;
    state.groupRooms = state.groupRooms.map((r) => (r.roomId === roomId ? { ...r, name: newName } : r));
    deps.render();
    try {
      await deps.groupRoomStore.renameRoom(roomId, newName, client);
      deps.showToast(deps.t('toast.groupRenamed'));
      await deps.fetchGroupRooms();
    } catch (err) {
      if (previousName !== undefined) {
        state.groupRooms = state.groupRooms.map((r) => (r.roomId === roomId ? { ...r, name: previousName } : r));
        deps.render();
      }
      deps.showToast(deps.t('ctx.groupRenameFailed', { error: deps.describeRpcError(err) }));
    }
  }

  decorateRailSessions(nowMs: number): LeftRailSession[] {
    return this.snapshotManager.decorateSessions(nowMs);
  }

  decorateRailGroups(nowMs: number): LeftRailGroupRoom[] {
    return this.snapshotManager.decorateGroups(nowMs);
  }

  decorateRailProfiles(nowMs: number): LeftRailProfile[] {
    return this.snapshotManager.decorateProfiles(nowMs);
  }

  getLeftRailSnapshot(): LeftRailSnapshot {
    return this.snapshotManager.getSnapshot();
  }
}

export function createLeftRailController(deps: LeftRailControllerDeps): LeftRailController {
  return new LeftRailController(deps);
}
