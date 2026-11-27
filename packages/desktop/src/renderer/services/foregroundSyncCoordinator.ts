/**
 * Hermes Flux 前后台协同同步协调器（Foreground Sync Coordinator）
 *
 * 【设计意图 (Why)】
 *   将断线重连 (`reconnected`)、冷启动连网 (`connected`) 与休眠/后台切回 (`resume-alive`)
 *   后的全视图无破坏数据刷新收敛为单一状态机：
 *   1. 单飞队列合并重复唤醒，并保证更强触发信号（reconnected > connected > resume-alive）不被吞掉；
 *   2. 300ms 静默门槛：热切屏探活极快完成时保持已连接态零闪烁；超过 300ms 或真正断线重连后
 *      进入 `syncing` 动效并展示 1100ms `synced` 确认微章；
 *   3. 视图感知刷新：仅静默更新用户当前驻留视图（对话流 / 群聊 / 离线直达 Bot / Bot Hub / 检查舱 / 设置），
 *      并在存在未保存草稿或正在编辑输入框时拒绝覆写用户输入。
 *
 * 【防范的历史坑 (Pitfall)】
 *   1. 旧实现断线重连后只拉列表而不刷当前会话，导致用户必须来回切屏才能看到新回复；
 *   2. 连续 focus / visibility / online 风暴下并发多次 sync 会交错写脏缓存，必须单飞退火与 3000ms 节流；
 *   3. `synced` 闪烁定时器未加 `.unref?.()` 会在 Node 单测结束后挂死进程。
 *
 * 【约束与规则 (Rules)】
 *   - 零 DOM 直接操作（仅通过注入回调读取编辑焦点并通知重绘）；
 *   - 单向依赖，严禁反向 import `index.ts`；
 *   - 导出闭包子函数不依赖 `this`，可直接作为引用传递给事件总线与测试。
 */

import { captureGroupLogBaseline, type GatewayConnectionPhase, type GroupLogPollEntry } from '@hermes-flux/core';
import type { SettingsSectionId } from '@hermes-flux/ui';
import type { AppState } from '../state/appState.js';
import type { SettingsDataService } from './settingsDataService.js';
import type { FileViewerService } from './fileViewerService.js';

export type ForegroundSyncTrigger = 'connected' | 'reconnected' | 'resume-alive';

export interface ActiveViewContext {
  isMobile: boolean;
  mobilePane: 'home' | 'stage' | 'inspector';
  homeTab: 'chats' | 'bots';
  botSubpage: string | null;
  settingsOpen: boolean;
  settingsSubpage: string | null;
}

export interface ForegroundSyncDeps {
  getState: () => AppState;
  render: () => void;
  fetchProfiles: () => Promise<void>;
  fetchSessions: () => Promise<void>;
  fetchGroupRooms: () => Promise<void>;
  prefetchSlashCatalog: () => Promise<void>;
  fetchModelOptions: () => Promise<void>;
  fetchProjects: () => Promise<void>;
  onReadyEnsureDoneSessions?: () => void;
  refreshConversationOrgIfStale?: () => void;
  refreshActiveSession: (opts?: { forceRefreshAfterReconnect?: boolean }) => Promise<void>;
  refreshGroupRoomLog: (roomId: string) => Promise<unknown>;
  ensureGroupPollerRunning?: (roomId: string) => void;
  openBotChat: (botName: string, gatewayId?: string) => Promise<void>;
  getActiveViewContext: () => ActiveViewContext;
  hasUnsavedBotDrafts: () => boolean;
  refreshBotHubView?: () => Promise<unknown> | void;
  refreshInspectorView?: () => Promise<void> | void;
  refreshSettingsView?: (subpage: string | null) => Promise<void> | void;
  isUserEditingInput?: () => boolean;
  resumeAliveThrottleMs?: number;
  quietSyncDelayMs?: number;
  syncedFlashMs?: number;
  now?: () => number;
}

export interface ForegroundSyncCoordinator {
  syncOnConnected(trigger: 'connected' | 'reconnected'): Promise<void>;
  syncOnResumeAlive(opts?: { force?: boolean }): Promise<void>;
  onAppPause(): void;
  dispose(): void;
}

const TRIGGER_WEIGHT: Readonly<Record<ForegroundSyncTrigger, number>> = {
  'resume-alive': 1,
  connected: 2,
  reconnected: 3,
};

function defaultIsUserEditingInput(): boolean {
  if (typeof document === 'undefined' || !document.activeElement) return false;
  const el = document.activeElement as HTMLElement;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || Boolean(el.isContentEditable);
}

/**
 * 创建前后台视图协同同步协调器。
 */
export function createForegroundSyncCoordinator(deps: ForegroundSyncDeps): ForegroundSyncCoordinator {
  const throttleMs = deps.resumeAliveThrottleMs ?? 3000;
  const quietDelayMs = deps.quietSyncDelayMs ?? 300;
  const syncedFlashMs = deps.syncedFlashMs ?? 1100;
  const nowFn = deps.now ?? (() => Date.now());
  const editingCheck = deps.isUserEditingInput ?? defaultIsUserEditingInput;

  let activePromise: Promise<void> | null = null;
  let queuedTrigger: ForegroundSyncTrigger | null = null;
  let lastResumeSyncAt = -Infinity;
  let quietTimer: ReturnType<typeof setTimeout> | null = null;
  let syncedTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const clearQuietTimer = (): void => {
    if (quietTimer) {
      clearTimeout(quietTimer);
      quietTimer = null;
    }
  };

  const clearSyncedTimer = (): void => {
    if (syncedTimer) {
      clearTimeout(syncedTimer);
      syncedTimer = null;
    }
  };

  const setPhaseIfStillOnline = (nextPhase: GatewayConnectionPhase): void => {
    const state = deps.getState();
    if (disposed || !state.gatewayConnected || state.manualDisconnected || state.connectionAuthError) {
      return;
    }
    if (state.connectionPhase !== nextPhase) {
      state.connectionPhase = nextPhase;
      deps.render();
    }
  };

  const refreshActiveViews = async (trigger: ForegroundSyncTrigger): Promise<void> => {
    const state = deps.getState();
    const forceReconnect = trigger === 'reconnected';

    const listsTask = Promise.allSettled([
      deps.fetchProfiles().then(() =>
        Promise.allSettled([
          deps.fetchSessions().then(() => {
            deps.onReadyEnsureDoneSessions?.();
          }),
          deps.fetchGroupRooms(),
          deps.prefetchSlashCatalog(),
        ]),
      ),
      deps.fetchModelOptions(),
      deps.fetchProjects(),
    ]);
    deps.refreshConversationOrgIfStale?.();

    let conversationTask: Promise<unknown> = Promise.resolve();
    if (state.activeFocus.type === 'group' && state.activeFocus.roomId) {
      const roomId = state.activeFocus.roomId;
      deps.ensureGroupPollerRunning?.(roomId);
      conversationTask = deps.refreshGroupRoomLog(roomId);
    } else if (state.activeFocus.type === 'bot' && !state.activeSessionId) {
      conversationTask = deps.openBotChat(state.activeFocus.botName, state.activeFocus.gatewayId);
    } else if (state.activeSessionId) {
      conversationTask = deps.refreshActiveSession({ forceRefreshAfterReconnect: forceReconnect });
    }

    const view = deps.getActiveViewContext();
    const auxTasks: Array<Promise<unknown>> = [];

    const inBotView =
      (view.isMobile && view.mobilePane === 'home' && view.homeTab === 'bots') ||
      Boolean(view.botSubpage);
    if (inBotView && !deps.hasUnsavedBotDrafts() && deps.refreshBotHubView) {
      auxTasks.push(Promise.resolve(deps.refreshBotHubView()));
    }

    const inInspector =
      (view.isMobile && view.mobilePane === 'inspector') ||
      (!view.isMobile && !state.inspectorCollapsed);
    if (inInspector && deps.refreshInspectorView) {
      auxTasks.push(Promise.resolve(deps.refreshInspectorView()));
    }

    const inSettings = view.settingsOpen || state.isSettingsOpen;
    if (inSettings && !editingCheck() && deps.refreshSettingsView) {
      auxTasks.push(Promise.resolve(deps.refreshSettingsView(view.settingsSubpage)));
    }

    await Promise.allSettled([listsTask, conversationTask, ...auxTasks]);
  };

  const runSingleFlight = async (initialTrigger: ForegroundSyncTrigger): Promise<void> => {
    let currentTrigger: ForegroundSyncTrigger | null = initialTrigger;

    while (currentTrigger) {
      const trigger = currentTrigger;
      currentTrigger = null;
      queuedTrigger = null;

      clearSyncedTimer();
      clearQuietTimer();

      let showedSyncing = false;
      if (trigger === 'connected' || trigger === 'reconnected') {
        showedSyncing = true;
        setPhaseIfStillOnline('syncing');
      } else {
        quietTimer = setTimeout(() => {
          quietTimer = null;
          if (disposed || !deps.getState().gatewayConnected) return;
          showedSyncing = true;
          setPhaseIfStillOnline('syncing');
        }, quietDelayMs);
        quietTimer.unref?.();
      }

      await refreshActiveViews(trigger);
      clearQuietTimer();
      if (disposed) {
        return;
      }

      // 若等待期间又有更强或后续请求排队，继续下一轮而不提前闪烁 synced
      if (queuedTrigger) {
        currentTrigger = queuedTrigger;
        continue;
      }

      if (showedSyncing || trigger === 'reconnected') {
        setPhaseIfStillOnline('synced');
        syncedTimer = setTimeout(() => {
          syncedTimer = null;
          setPhaseIfStillOnline('connected');
        }, syncedFlashMs);
        syncedTimer.unref?.();
      } else {
        setPhaseIfStillOnline('connected');
      }
    }
  };

  const scheduleSync = async (trigger: ForegroundSyncTrigger): Promise<void> => {
    if (disposed || !deps.getState().gatewayConnected) return;
    if (activePromise) {
      if (!queuedTrigger || TRIGGER_WEIGHT[trigger] >= TRIGGER_WEIGHT[queuedTrigger]) {
        queuedTrigger = trigger;
      }
      await activePromise;
      return;
    }
    activePromise = runSingleFlight(trigger).finally(() => {
      activePromise = null;
    });
    await activePromise;
  };

  const syncOnConnected = async (trigger: 'connected' | 'reconnected'): Promise<void> => {
    lastResumeSyncAt = nowFn();
    await scheduleSync(trigger);
  };

  const syncOnResumeAlive = async (opts?: { force?: boolean }): Promise<void> => {
    const now = nowFn();
    if (!opts?.force && now - lastResumeSyncAt < throttleMs) {
      return;
    }
    lastResumeSyncAt = now;
    await scheduleSync('resume-alive');
  };

  const onAppPause = (): void => {
    clearQuietTimer();
    clearSyncedTimer();
  };

  const dispose = (): void => {
    disposed = true;
    clearQuietTimer();
    clearSyncedTimer();
    queuedTrigger = null;
  };

  return {
    syncOnConnected,
    syncOnResumeAlive,
    onAppPause,
    dispose,
  };
}

const MOBILE_SUBPAGE_TO_SECTION: Readonly<Record<string, SettingsSectionId>> = {
  appearance: 'appearance',
  gateway: 'connection',
  providers: 'providers',
  extensions: 'extensions',
  about: 'about',
};

export interface ActiveViewSyncAdapterDeps {
  getState: () => AppState;
  isMobileShellActive: () => boolean;
  getMobileViewContext: () => ActiveViewContext;
  settingsDataService: Pick<
    SettingsDataService,
    'hasUnsavedBotDrafts' | 'getBotManagementController' | 'ensureSettingsSectionData'
  >;
  fileViewerService: Pick<FileViewerService, 'loadFileTree'>;
  groupPollerManager: {
    isPolling(roomId: string): boolean;
    startAwaitReply(roomId: string, baseline: ReturnType<typeof captureGroupLogBaseline>): void;
  };
  getGroupRoomLogs: (roomId: string) => readonly GroupLogPollEntry[];
  hostedRoomIds: ReadonlySet<string>;
  activeRunningGroupRoomIds: ReadonlySet<string>;
}

/**
 * 构建前后台协同协调器所需的视图感知适配回调，供渲染入口零胶水装配。
 */
export function createActiveViewSyncAdapters(
  deps: ActiveViewSyncAdapterDeps,
): Pick<
  ForegroundSyncDeps,
  | 'getActiveViewContext'
  | 'hasUnsavedBotDrafts'
  | 'refreshBotHubView'
  | 'refreshInspectorView'
  | 'refreshSettingsView'
  | 'ensureGroupPollerRunning'
> {
  return {
    getActiveViewContext: () => ({
      ...deps.getMobileViewContext(),
      isMobile: deps.isMobileShellActive(),
    }),
    hasUnsavedBotDrafts: () => deps.settingsDataService.hasUnsavedBotDrafts(),
    refreshBotHubView: () => deps.settingsDataService.getBotManagementController().loadRoster(true),
    refreshInspectorView: () => {
      const state = deps.getState();
      if (deps.isMobileShellActive() || (state.rightPodMode?.kind ?? 'files') === 'files') {
        return deps.fileViewerService.loadFileTree(true);
      }
      return undefined;
    },
    refreshSettingsView: (subpage) => {
      const section = (subpage && MOBILE_SUBPAGE_TO_SECTION[subpage]) || deps.getState().settingsSection;
      deps.settingsDataService.ensureSettingsSectionData(section, true);
    },
    ensureGroupPollerRunning: (roomId) => {
      if (!deps.hostedRoomIds.has(roomId) || !deps.activeRunningGroupRoomIds.has(roomId)) {
        return;
      }
      if (deps.groupPollerManager.isPolling(roomId)) {
        return;
      }
      const sourceLogs = deps.getGroupRoomLogs(roomId);
      deps.groupPollerManager.startAwaitReply(roomId, captureGroupLogBaseline(sourceLogs));
    },
  };
}
