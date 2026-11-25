/**
 * 移动端表现壳薄协调适配器 (MobileShellCoordinator)
 *
 * 【设计意图 (Why)】
 *   将 `@hermes-flux/ui` 的纯表现壳 `MobileWorkspaceShell` 与既有的跨平台业务服务
 *   （`SessionOperationService` / `GroupOperationService` / `TurnExecutionService` /
 *   `SettingsDataService` / `FileViewerService` / `LeftRailController`）单向对接。
 *   桌面与移动共享 100% 领域模型、RPC 网关通信、状态存储与流式消息清单，
 *   本模块仅管理移动端专属的三屏瞬态导航状态、折叠偏好持久化和硬件返回栈路由。
 *
 * 【防范的历史坑 (Pitfall)】
 *   1. 在切换会战目标或提交新建首条消息时，必须先行收起 `newChatOpen` 并滑入 `stage` 屏，
 *      同时绝不可在群聊房间下调用 `createNewSession` 或 `prompt.submit`（严格三态隔离）；
 *   2. 移动端仅允许深邃哑光黑 (`obsidian-gold`) 与纯净浅白 (`jade-white`) 两套纯哑光皮肤，
 *      任何桌面扩展皮肤在进入移动模式时须归一化为对应极性的纯哑光皮肤；
 *   3. 离开 `newChat` 或点击 Bot 时保持受物理保护（严禁触发 `deleteSession`）；
 *   4. 所有持久化读/写包裹在容错函数内，避免无头/隐私模式 `SecurityError` 阻断首屏挂载。
 *
 * 【约束与规则 (Rules)】
 *   - 严禁反向 `import ../index.js`，全部宿主能力经由 `MobileShellCoordinatorDeps` 注入；
 *   - 严禁出现 `as any`；
 *   - 遵循三要素中文注释规范。
 */

import {
  DEFAULT_MOBILE_SECTIONS_COLLAPSED,
  buildMobileHomeModel,
  buildDeliverableListItems,
  inferMobileAppearanceFromTheme,
  mountMobileWorkspaceShell,
  resolveMobileSkinId,
  t,
  type ConversationToolVM,
  type ConversationOrgPrefs,
  type LeftRailProfile,
  type MediaLightboxItem,
  type MobileActionSheetState,
  type MobileAppearancePreference,
  type MobileBotSubpage,
  type MobileHomeTab,
  type MobileInspectorArtifactItem,
  type MobileInspectorReaderItem,
  type MobileInspectorTab,
  type MobileMediaLightboxState,
  type MobileNewChatStep,
  type MobilePaneId,
  type MobileSectionCollapsedState,
  type MobileSettingsSubpage,
  type MobileSubagentSheetState,
  type MobileWorkspaceActions,
  type MobileWorkspaceMount,
  type MobileWorkspaceSnapshot,
  type SettingsActions,
  type SettingsSectionId,
  type SettingsSnapshot,
} from '@hermes-flux/ui';
import {
  extractPathBasename,
  extractSessionDeliverables,
  formatFileSize,
  isImageExtension,
  isVideoExtension,
  normalizeOrgProfileName,
  type DeliverableItem,
} from '@hermes-flux/core';
import type { LeftRailController } from '../events/leftRailController.js';
import { openBrowserAttachmentPicker } from '../events/inputAttachmentPicker.js';
import { resolveActiveWorkspaceCwd, type AppState } from '../state/appState.js';
import type { ActiveViewContext } from '../services/foregroundSyncCoordinator.js';

export const MOBILE_SECTIONS_STORAGE_KEY = 'hermes_flux_mobile_sections';
export const MOBILE_APPEARANCE_STORAGE_KEY = 'hermes_flux_mobile_appearance';

export interface MobileStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface MobileShellCoordinatorDeps {
  getState: () => AppState;
  render: () => void;
  leftRailController: Pick<
    LeftRailController,
    'decorateRailProfiles' | 'decorateRailGroups' | 'decorateRailSessions'
  >;
  resolveAgentAvatar: (name?: string) => string;
  selectSession: (id: string, opts?: { botName?: string }) => Promise<void>;
  openBotChat: (profile: string) => Promise<void>;
  openGroupRoom: (roomId: string) => Promise<void>;
  createNewSession: (opts?: { profile?: string; projectId?: string; containerId?: string; title?: string }) => Promise<string | null>;
  renameSession: (id: string, currentTitle: string, nextTitleOverride: string) => Promise<void>;
  pinSession: (id: string) => Promise<void>;
  archiveSession: (id: string, explicitProfile?: string) => Promise<void>;
  deleteSession: (id: string) => Promise<void>;
  onToggleContainer?: (containerId: string) => void;
  onRetryDoneSection?: () => void;
  onSearchQueryChanged?: (query: string) => void;
  markDoneConfirmed?: (kind: 'session' | 'group', id: string, profile?: string) => Promise<boolean>;
  restoreDone?: (kind: 'session' | 'group', id: string, profile?: string) => Promise<boolean>;
  moveEntityToFolder?: (kind: 'session' | 'group', id: string, containerId: string | null, profile?: string) => Promise<boolean>;
  createFolder?: (name: string, moveTarget?: { kind: 'session' | 'group'; id: string; profile?: string } | null) => Promise<string | null>;
  renameFolder?: (folderId: string, nextName: string) => Promise<boolean>;
  deleteFolder?: (folderId: string) => Promise<boolean>;
  assignNewEntityContainer?: (
    kind: 'session' | 'group',
    id: string,
    opts: { projectId?: string; containerId?: string },
  ) => Promise<void>;
  setOrgPrefs?: (patch: Partial<ConversationOrgPrefs>) => void;
  createGroupRoom: (
    title: string,
    members: string[],
  ) => Promise<{ room_id?: string; room?: { room_id?: string } } | null | undefined>;
  confirmGroupRename: (roomId: string, name: string) => Promise<void>;
  disbandGroupRoom: (roomId: string) => Promise<void>;
  fetchGroupRooms: () => Promise<void>;
  routeSend: (text: string) => Promise<void>;
  sendGroupMessage: (roomId: string, text: string) => Promise<void>;
  interruptTurn: () => Promise<void>;
  switchModel: (model: string, provider?: string) => Promise<void>;
  fetchModelOptions?: () => Promise<void> | void;
  openAttachmentPicker?: () => void;
  onFilesPicked?: (files: FileList | File[]) => Promise<void> | void;
  getSettingsSnapshot: () => SettingsSnapshot;
  createSettingsActions: () => SettingsActions;
  ensureSettingsSectionData: (section: SettingsSectionId, force?: boolean) => void;
  copyText: (text: string) => Promise<boolean>;
  onStageReady?: () => void;
  loadFileTree?: (force?: boolean) => Promise<void> | void;
  toggleFileTreeDir?: (dirPath: string) => Promise<void> | void;
  setFileTreeFilter?: (query: string) => void;
  openWorkspaceFile?: (filePath: string) => Promise<void> | void;
  downloadFile?: (filePath?: string) => Promise<void> | void;
  downloadMediaItem?: (item: MediaLightboxItem) => Promise<void> | void;
  resolveMediaUrl?: (pathOrUrl: string) => Promise<string | null>;
  getVerifiedDeliverablePaths?: () => readonly string[];
  getSubagentWrittenPaths?: () => readonly string[];
  getSessionDeliverables?: () => readonly DeliverableItem[];
  loadLearningGraph?: (
    forceOrOptions?: boolean | { profile?: string; force?: boolean },
    profile?: string,
  ) => Promise<void> | void;
  loadLearningDetail?: (id: string, profile?: string) => Promise<void> | void;
  editLearningNode?: (
    id: string,
    content: string,
    profile?: string,
  ) => Promise<{ ok: boolean; message?: string }>;
  deleteLearningNode?: (
    id: string,
    profile?: string,
  ) => Promise<{ ok: boolean; message?: string }>;
  triggerHapticSelection?: () => void;
  syncReactMessageList?: (force?: boolean) => void;
  syncAgentPresenceHost?: () => void;
  syncAgentPresence?: () => void;
  onEnterStage?: () => void;
  onRetryConnect?: () => Promise<void> | void;
  syncStatusBarAppearance?: (appearance: 'dark' | 'light') => void;
  getSystemPrefersDark?: () => boolean;
  storage?: MobileStorageLike;
  mountShell?: (
    host: HTMLElement,
    getSnapshot: () => MobileWorkspaceSnapshot,
    actions: MobileWorkspaceActions,
  ) => MobileWorkspaceMount;
  now?: () => number;
}

export interface MobileShellCoordinator {
  renderMobileShell(host: HTMLElement): void;
  buildSnapshot(): MobileWorkspaceSnapshot;
  getActions(): MobileWorkspaceActions;
  openSubagentDetail(payload: { messageId: string; tools: ConversationToolVM[] }): void;
  openFileInReader(filePath: string, previewUrl?: string): Promise<void>;
  openMediaLightbox(items: readonly MediaLightboxItem[], initialIndex: number): void;
  closeMediaLightbox(): void;
  getActivePane(): MobilePaneId;
  getActiveViewContext(): ActiveViewContext;
  dispose(): void;
}

function readStorage(storage: MobileStorageLike | undefined, key: string): string | null {
  try {
    if (storage) return storage.getItem(key);
    if (typeof localStorage !== 'undefined') return localStorage.getItem(key);
  // gate-degrade: 隐私模式或无存储环境时返回 null 使用默认值
  } catch {}
  return null;
}

function writeStorage(storage: MobileStorageLike | undefined, key: string, value: string): void {
  try {
    if (storage) {
      storage.setItem(key, value);
      return;
    }
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(key, value);
    }
  // gate-degrade: 存储不可用时本次会话内存保持即可，不得中断 UI 更新
  } catch {}
}

function loadCollapsedSections(storage?: MobileStorageLike): MobileSectionCollapsedState {
  const raw = readStorage(storage, MOBILE_SECTIONS_STORAGE_KEY);
  if (!raw) return { ...DEFAULT_MOBILE_SECTIONS_COLLAPSED };
  try {
    const parsed = JSON.parse(raw) as Partial<MobileSectionCollapsedState>;
    return {
      bots: Boolean(parsed.bots),
      groups: Boolean(parsed.groups),
      sessions: Boolean(parsed.sessions),
    };
  // gate-degrade: 损坏的 JSON 折叠缓存丢弃并回落默认全展开
  } catch {
    return { ...DEFAULT_MOBILE_SECTIONS_COLLAPSED };
  }
}

function loadAppearancePreference(
  storage: MobileStorageLike | undefined,
  currentTheme: string,
): MobileAppearancePreference {
  const saved = readStorage(storage, MOBILE_APPEARANCE_STORAGE_KEY);
  if (saved === 'dark' || saved === 'light' || saved === 'system') {
    return saved;
  }
  return inferMobileAppearanceFromTheme(currentTheme);
}

export function createMobileShellCoordinator(deps: MobileShellCoordinatorDeps): MobileShellCoordinator {
  const initialState = deps.getState();
  let activePane: MobilePaneId = 'home';
  let homeTab: MobileHomeTab = 'chats';
  let searchOpen = false;
  let collapsed = loadCollapsedSections(deps.storage);
  let appearancePref: MobileAppearancePreference = loadAppearancePreference(deps.storage, initialState.theme);
  let newChatOpen = false;
  let newChatStep: MobileNewChatStep = 'compose';
  let newChatTargetKind: 'bot' | 'group' = 'bot';
  let newChatTargetBot = initialState.profileName || 'default';
  let newChatGroupMembers: string[] = [];
  let newChatGroupName = '';
  let newChatProjectId: string | undefined = undefined;
  let settingsSubpage: MobileSettingsSubpage = null;
  let botSubpage: MobileBotSubpage = null;
  let inspectorTab: MobileInspectorTab = 'artifacts';
  let inspectorReaderOpen = false;
  let inspectorReaderItem: MobileInspectorReaderItem | null = null;
  let openFileGen = 0;
  let subagentSheet: MobileSubagentSheetState | null = null;
  let actionSheet: MobileActionSheetState | null = null;
  let mediaLightbox: MobileMediaLightboxState | null = null;

  let mountHandle: MobileWorkspaceMount | null = null;
  let mountedHost: HTMLElement | null = null;
  let lastSyncedBarAppearance: 'dark' | 'light' | null = null;

  const getPrefersDark = (): boolean => {
    if (deps.getSystemPrefersDark) return deps.getSystemPrefersDark();
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      return window.matchMedia('(prefers-color-scheme: dark)').matches;
    }
    return true;
  };

  const syncSkinAndStatusBar = (persistTheme = false): void => {
    const state = deps.getState();
    const resolvedSkin = resolveMobileSkinId(appearancePref, getPrefersDark());
    if (state.theme !== resolvedSkin) {
      state.theme = resolvedSkin;
    }
    if (persistTheme) {
      writeStorage(deps.storage, 'hermes_flux_theme', resolvedSkin);
      writeStorage(deps.storage, 'hermes_aura_theme', resolvedSkin);
    }
    const barAppearance = inferMobileAppearanceFromTheme(resolvedSkin) === 'light' ? 'light' : 'dark';
    if (lastSyncedBarAppearance !== barAppearance) {
      lastSyncedBarAppearance = barAppearance;
      if (deps.syncStatusBarAppearance) {
        deps.syncStatusBarAppearance(barAppearance);
      } else if (typeof window !== 'undefined' && window.hermesMobile?.syncStatusBarAppearance) {
        void window.hermesMobile.syncStatusBarAppearance(barAppearance);
      }
    }
  };

  syncSkinAndStatusBar(false);

  const resolveInspectorBotProfile = (state: AppState): string => {
    const focus = state.activeFocus;
    if (focus.type === 'bot') {
      return focus.botName || state.profileName || 'default';
    }
    if (focus.type === 'session') {
      const targetSession = state.sessions.find((s) => s.id === focus.sessionId);
      if (targetSession?.botName) return targetSession.botName;
    }
    return state.profileName || 'default';
  };

  const resolveBotHubTargetProfile = (state: AppState): string =>
    state.botManagementActiveBotId ||
    state.profiles.find((p) => p.isDefault)?.name ||
    state.profileName ||
    'default';

  const resolveInspectorGroupMembers = (state: AppState): Array<{ name: string; displayName: string; avatar?: string }> => {
    const focus = state.activeFocus;
    if (focus.type !== 'group') return [];
    const room = state.groupRooms.find((r) => r.roomId === focus.roomId);
    if (!room) return [];
    return room.members.map((memberName) => {
      const profile = state.profiles.find(
        (p) => p.name.toLowerCase() === memberName.toLowerCase() || p.displayName?.toLowerCase() === memberName.toLowerCase(),
      );
      return {
        name: profile?.name || memberName,
        displayName: profile?.displayName || memberName,
        avatar: profile?.avatar || deps.resolveAgentAvatar(memberName),
      };
    });
  };

  const buildArtifactsList = (state: AppState): MobileInspectorArtifactItem[] => {
    const derived = deps.getSessionDeliverables
      ? deps.getSessionDeliverables()
      : extractSessionDeliverables(
          state.messages.map((m) => ({
            id: m.id,
            role: m.role,
            content: m.content,
            toolCalls: m.toolCalls?.map((tc) => ({
              id: tc.id,
              name: tc.name,
              status: tc.status,
              args: tc.args,
              rawArgs: tc.rawArgs,
              output: tc.output,
              imagePath: tc.imagePath,
              inlineDiff: tc.inlineDiff,
            })),
            attachments: m.attachments?.map((att) => ({
              id: att.id,
              name: att.name,
              type: att.type,
              previewUrl: att.previewUrl,
            })),
          })),
          {
            verifiedExistingPaths: deps.getVerifiedDeliverablePaths?.(),
            subagentWrittenPaths: deps.getSubagentWrittenPaths?.(),
          },
        );
    return buildDeliverableListItems(derived);
  };

  const resolveNewChatStats = (state: AppState): MobileWorkspaceSnapshot['newChatStats'] => {
    const mcpCount = state.settingsMcp.status === 'ready' ? state.settingsMcp.data.length : undefined;
    const skillsCount = state.settingsSkills.status === 'ready' ? state.settingsSkills.data.length : undefined;
    const detail = state.botManagementDetail;
    const targetDetail =
      detail && detail.id.toLowerCase() === newChatTargetBot.toLowerCase() ? detail : null;
    if (!targetDetail && mcpCount === undefined && skillsCount === undefined) {
      return undefined;
    }
    return {
      pluginsCount: targetDetail ? targetDetail.toolsets.rows.filter((ts) => ts.enabled).length : 0,
      mcpCount: targetDetail ? targetDetail.mcpServers.rows.filter((m) => m.enabled).length : (mcpCount ?? 0),
      skillsCount: targetDetail ? targetDetail.skills.rows.filter((s) => s.enabled).length : (skillsCount ?? 0),
    };
  };

  function buildSnapshot(): MobileWorkspaceSnapshot {
    syncSkinAndStatusBar(false);
    const state = deps.getState();
    const nowMs = deps.now ? deps.now() : Date.now();
    const allProfiles: LeftRailProfile[] = deps.leftRailController.decorateRailProfiles(nowMs);
    const decoratedGroups = deps.leftRailController.decorateRailGroups(nowMs);
    const decoratedSessions = deps.leftRailController.decorateRailSessions(nowMs);

    const homeModel = buildMobileHomeModel({
      activeSessionId: state.activeSessionId,
      activeFocus: state.activeFocus,
      profiles: allProfiles,
      groups: decoratedGroups,
      sessions: decoratedSessions,
      projects: state.projects ?? [],
      folders: state.orgFolders ?? [],
      assignments: state.orgAssignments ?? {},
      doneRoomsMap: state.orgDoneRooms ?? {},
      containerCollapsed: state.orgContainerCollapsed ?? { done: true },
      hiddenProjectIds: state.orgPrefs?.hiddenProjectIds ?? [],
      showDoneSection: state.orgPrefs?.showDoneSection ?? true,
      doneLoading: state.doneLoading,
      doneError: state.doneError,
      profileName: state.profileName,
      searchQuery: state.sessionSearchQuery,
      collapsed,
      profilesPhase: state.profilesPhase,
      sessionsPhase: state.sessionsPhase,
      nowMs,
    });

    const activeProfile =
      allProfiles.find((p) => p.name.toLowerCase() === (state.profileName || 'default').toLowerCase()) ||
      allProfiles.find((p) => p.isDefault);
    const inspectorBotProfile = resolveInspectorBotProfile(state);
    const inspectorMatched = allProfiles.find(
      (p) => p.name.toLowerCase() === inspectorBotProfile.toLowerCase(),
    );

    const modelDetails: MobileWorkspaceSnapshot['modelDetails'] =
      Array.isArray(state.modelCatalog) && state.modelCatalog.length > 0
        ? state.modelCatalog.map((d) => ({
            id: d.id,
            provider: d.providerSlug,
            providerName: d.providerName,
            name: d.name,
            displayName: d.displayName,
            unavailable: d.unavailable,
          }))
        : state.modelDetails.map((d) => ({
            id: d.id,
            provider: d.provider,
            name: d.name,
            displayName: d.displayName,
          }));

    return {
      platform: state.platform,
      appVersion: state.appVersion,
      theme: state.theme,
      appearancePref,
      locale: state.lang === 'en' ? 'en' : 'zh',
      gatewayConnected: state.gatewayConnected,
      gatewayConnecting: state.gatewayConnecting,
      connectionPhase: state.connectionPhase,
      connectionReconnectAttempt: state.connectionReconnectAttempt,
      connectionAuthError: state.connectionAuthError,
      homeModel,
      homeTab,
      allProfiles,
      groupAvatars: allProfiles,
      projects: state.projects ?? [],
      folders: state.orgFolders ?? [],
      showDoneSection: state.orgPrefs?.showDoneSection ?? true,
      doneLoading: state.doneLoading,
      doneError: state.doneError,
      activePane,
      searchOpen,
      searchQuery: state.sessionSearchQuery,
      newChatOpen,
      newChatStep,
      newChatTargetKind,
      newChatTargetBot,
      newChatGroupMembers,
      newChatGroupName,
      newChatProjectId,
      newChatStats: resolveNewChatStats(state),
      settingsOpen: state.isSettingsOpen,
      settingsSubpage,
      botSubpage,
      settingsSnapshot: deps.getSettingsSnapshot(),
      activeFocus: state.activeFocus,
      activeSessionId: state.activeSessionId,
      activeBotName: state.profileName || 'default',
      activeBotDisplayName: activeProfile?.displayName || state.profileName || 'default',
      inspectorBotProfile,
      inspectorBotLabel: inspectorMatched?.displayName || inspectorBotProfile,
      isStreaming: state.isStreaming,
      messagesCount: state.messages.length,
      selectedModel: state.selectedModel,
      currentProvider: state.currentProvider,
      availableModels: state.availableModels,
      modelDetails,
      attachments: state.attachments,
      dockNotice: state.dockNotice,
      inspectorTab,
      inspectorReaderOpen,
      inspectorReaderItem,
      artifacts: buildArtifactsList(state),
      gitDiffs: state.gitDiffs,
      openFiles: state.openFiles,
      mediaLightbox,
      fileTreeState: state.fileTreeState,
      fileTreeExpandedPaths: Array.from(state.fileTreeExpandedPaths),
      fileTreeFilterQuery: state.fileTreeFilterQuery,
      activeFilePath: state.activeFilePath,
      workspaceRootName:
        extractPathBasename(
          resolveActiveWorkspaceCwd(state) ||
            (state.fileTreeState?.status === 'ready' ? state.fileTreeState.rootPath : '') ||
            '',
        ) || undefined,
      memories: state.memories,
      learningState: state.learningState,
      learningDetail: state.learningDetail,
      groupMembers: resolveInspectorGroupMembers(state),
      subagentSheet,
      actionSheet,
      sideAgentCapsules: state.sideAgentCapsules.map((c) => ({
        id: c.id,
        kind: c.kind,
        profile: c.profile,
        question: c.question,
        answer: c.answer,
        status: c.status,
      })),
    };
  }

  /**
   * 按需加载 Bot Hub 配置域；若上次因离线停留在 `list_error`，则强制重拉花名册。
   *
   * 【设计意图 (Why)】防止用户断线停留在 Bot Hub 时连上网关后仍卡在旧 `list_error` 状态无法恢复。
   * 【防范的历史坑 (Pitfall)】仅在 Tab 切换传 `force` 会遗漏“留在 Bot Hub 点击离线横幅连网 -> 关设置”与直接进子页两条路径。
   * 【约束与规则 (Rules)】仅当 `botManagementStatus?.status === 'list_error'` 时传递 `force = true`，避免正常态重复拉取。
   */
  const ensureBotHubData = (): void => {
    const shouldRetryList = deps.getState().botManagementStatus?.status === 'list_error';
    deps.ensureSettingsSectionData('agents', shouldRetryList);
  };

  const ensureInspectorTabData = (tab: MobileInspectorTab): void => {
    const state = deps.getState();
    if (tab === 'files') {
      void deps.loadFileTree?.(false);
    } else if (tab === 'memory' && state.activeFocus.type !== 'group') {
      void deps.loadLearningGraph?.({ profile: resolveInspectorBotProfile(state), force: false });
    }
  };

  const resolveActiveLearningProfile = (explicitProfile?: string): string => {
    const trimmed = explicitProfile?.trim();
    if (trimmed) return trimmed;
    const state = deps.getState();
    return botSubpage === 'memory'
      ? resolveBotHubTargetProfile(state)
      : resolveInspectorBotProfile(state);
  };

  const baseSettingsActions = deps.createSettingsActions();

  const actions: MobileWorkspaceActions = {
    onSelectPane: (pane) => {
      const prevPane = activePane;
      activePane = pane;
      inspectorReaderOpen = false;
      openFileGen += 1;
      if (pane === 'inspector') {
        ensureInspectorTabData(inspectorTab);
      } else if (pane === 'stage' && prevPane !== 'stage') {
        deps.onEnterStage?.();
      }
      deps.render();
    },
    onSelectHomeTab: (tab) => {
      homeTab = tab;
      botSubpage = null;
      if (tab === 'bots') {
        searchOpen = false;
        ensureBotHubData();
      }
      deps.render();
    },
    onSelectBotSubpage: (subpage) => {
      botSubpage = subpage;
      if (subpage !== null) {
        ensureBotHubData();
      }
      if (subpage === 'memory') {
        void deps.loadLearningGraph?.({
          profile: resolveBotHubTargetProfile(deps.getState()),
          force: false,
        });
      }
      deps.render();
    },
    onOpenSettingsSubpage: (subpage) => {
      const state = deps.getState();
      state.isSettingsOpen = true;
      settingsSubpage = subpage;
      if (subpage === 'providers') {
        deps.ensureSettingsSectionData('providers');
      } else if (subpage === 'extensions') {
        deps.ensureSettingsSectionData('extensions');
      } else if (subpage === 'projects') {
        deps.ensureSettingsSectionData('projects');
      } else {
        deps.ensureSettingsSectionData(state.settingsSection);
      }
      deps.render();
    },
    onSelectBot: (botName) => {
      activePane = 'stage';
      void deps.openBotChat(botName);
      deps.render();
    },
    onSelectGroup: (roomId) => {
      activePane = 'stage';
      void deps.openGroupRoom(roomId);
      deps.render();
    },
    onSelectSession: (sessionId, botName) => {
      activePane = 'stage';
      void deps.selectSession(sessionId, { botName });
      deps.render();
    },
    onToggleSection: (section) => {
      collapsed = { ...collapsed, [section]: !collapsed[section] };
      writeStorage(deps.storage, MOBILE_SECTIONS_STORAGE_KEY, JSON.stringify(collapsed));
      deps.render();
    },
    onToggleContainer: (containerId) => {
      deps.onToggleContainer?.(containerId);
    },
    onToggleDoneSection: () => {
      deps.onToggleContainer?.('done');
    },
    onRetryDoneSection: () => {
      deps.onRetryDoneSection?.();
    },
    onOpenSearch: () => {
      searchOpen = true;
      deps.render();
    },
    onCloseSearch: () => {
      searchOpen = false;
      deps.getState().sessionSearchQuery = '';
      deps.render();
    },
    onSearchChange: (query) => {
      deps.getState().sessionSearchQuery = query;
      deps.onSearchQueryChanged?.(query);
      deps.render();
    },
    onOpenActionSheet: (sheet) => {
      actionSheet = sheet;
      deps.render();
    },
    onCloseActionSheet: () => {
      actionSheet = null;
      deps.render();
    },
    onActionOpen: (sheet) => {
      actionSheet = null;
      if (sheet.kind === 'bot') {
        activePane = 'stage';
        void deps.openBotChat(sheet.id);
      } else if (sheet.kind === 'group') {
        activePane = 'stage';
        void deps.openGroupRoom(sheet.id);
      } else if (sheet.kind !== 'folder') {
        activePane = 'stage';
        const curState = deps.getState();
        const targetProfile = sheet.botName ? normalizeOrgProfileName(sheet.botName) : null;
        const matchSess = (s: { id: string; botName?: string }) =>
          s.id === sheet.id && (!targetProfile || normalizeOrgProfileName(s.botName) === targetProfile);
        const targetSess =
          curState.sessions.find(matchSess) ||
          (curState.archivedSessions || []).find(matchSess) ||
          curState.sessions.find((s) => s.id === sheet.id) ||
          (curState.archivedSessions || []).find((s) => s.id === sheet.id);
        const resolvedBot = sheet.botName || targetSess?.botName;
        void deps.selectSession(sheet.id, resolvedBot ? { botName: resolvedBot } : undefined);
      }
      deps.render();
    },
    onActionRename: (sheet, nextTitle) => {
      if (sheet.isProtected) return;
      if (sheet.kind === 'group') {
        void deps.confirmGroupRename(sheet.id, nextTitle);
      } else if (sheet.kind === 'session') {
        void deps.renameSession(sheet.id, sheet.title, nextTitle);
      }
    },
    onActionPin: (sheet) => {
      if (sheet.isProtected) return;
      if (sheet.kind === 'session') {
        void deps.pinSession(sheet.id);
      }
    },
    onActionArchive: (sheet) => {
      if (sheet.isProtected) return;
      if (sheet.kind === 'session') {
        void deps.archiveSession(sheet.id, sheet.botName);
      }
    },
    onActionMarkDone: (sheet) => {
      if (sheet.isProtected || (sheet.kind !== 'session' && sheet.kind !== 'group')) return;
      if (deps.markDoneConfirmed) {
        void deps.markDoneConfirmed(sheet.kind, sheet.id, sheet.botName);
      } else if (sheet.kind === 'session') {
        void deps.archiveSession(sheet.id, sheet.botName);
      }
    },
    onActionRestoreDone: (sheet) => {
      if (sheet.isProtected || (sheet.kind !== 'session' && sheet.kind !== 'group')) return;
      if (deps.restoreDone) {
        void deps.restoreDone(sheet.kind, sheet.id, sheet.botName);
      } else if (sheet.kind === 'session') {
        void deps.archiveSession(sheet.id, sheet.botName);
      }
    },
    onActionMoveToFolder: (sheet, containerId) => {
      if (sheet.isProtected || (sheet.kind !== 'session' && sheet.kind !== 'group')) return;
      void deps.moveEntityToFolder?.(sheet.kind, sheet.id, containerId, sheet.botName);
    },
    onActionCreateFolder: (name, moveTarget) => {
      const target =
        moveTarget && !moveTarget.isProtected && (moveTarget.kind === 'session' || moveTarget.kind === 'group')
          ? { kind: moveTarget.kind, id: moveTarget.id, profile: moveTarget.botName }
          : null;
      void deps.createFolder?.(name, target);
    },
    onActionRenameFolder: (folderId, nextName) => {
      void deps.renameFolder?.(folderId, nextName);
    },
    onActionDeleteFolder: (folderId) => {
      void deps.deleteFolder?.(folderId);
    },
    onActionDelete: (sheet) => {
      // 三态物理保护：Bot 终身主工位严禁触发删除
      if (sheet.isProtected) return;
      if (sheet.kind === 'session') {
        void deps.deleteSession(sheet.id);
      }
    },
    onActionDisband: (sheet) => {
      if (sheet.isProtected) return;
      if (sheet.kind === 'group') {
        const currentFocus = deps.getState().activeFocus;
        const shouldLeaveToHome = (activePane === 'stage' || activePane === 'inspector')
          && currentFocus.type === 'group' && currentFocus.roomId === sheet.id;
        const promise = deps.disbandGroupRoom(sheet.id);
        void Promise.resolve(promise).then(() => {
          if (shouldLeaveToHome) {
            activePane = 'home';
          }
          deps.render();
        }).catch((err: unknown) => {
          const errorMessage = err instanceof Error ? err.message : String(err);
          deps.getState().dockNotice = t('ctx.disbandGroupFailed', { error: errorMessage });
          deps.render();
        });
      }
    },
    onOpenNewChat: () => {
      const state = deps.getState();
      newChatOpen = true;
      newChatStep = 'compose';
      newChatTargetKind = 'bot';
      newChatTargetBot = state.profileName || state.profiles.find((p) => p.isDefault)?.name || 'default';
      newChatGroupMembers = [];
      newChatGroupName = '';
      newChatProjectId = undefined;
      if (state.gatewayConnected) {
        deps.ensureSettingsSectionData('extensions');
      }
      deps.render();
    },
    onCloseNewChat: () => {
      newChatOpen = false;
      newChatStep = 'compose';
      newChatProjectId = undefined;
      deps.render();
    },
    onSetNewChatStep: (step) => {
      newChatStep = step;
      if (step === 'group-members' && newChatGroupMembers.length >= 2) {
        newChatTargetKind = 'group';
      }
      deps.render();
    },
    onSelectNewChatBot: (botName) => {
      newChatTargetKind = 'bot';
      newChatTargetBot = botName || 'default';
      deps.render();
    },
    onSetNewChatGroupMembers: (members) => {
      newChatGroupMembers = members;
      if (members.length >= 2) {
        newChatTargetKind = 'group';
      }
      deps.render();
    },
    onSetNewChatGroupName: (name) => {
      newChatGroupName = name;
      deps.render();
    },
    onSelectNewChatProject: (projectId) => {
      newChatProjectId = projectId || undefined;
      deps.render();
    },
    onSubmitNewChatMessage: (text) => {
      const trimmed = text.trim();
      if (!trimmed && deps.getState().attachments.length === 0) return;
      const targetKind = newChatTargetKind;
      const targetBot = newChatTargetBot;
      const targetProjectId = newChatProjectId;
      const members = [...newChatGroupMembers];
      const title = newChatGroupName.trim() || t('mobile.newChat.groupDefaultName');

      newChatOpen = false;
      newChatStep = 'compose';
      newChatProjectId = undefined;
      activePane = 'stage';
      deps.render();

      void (async () => {
        try {
          if (targetKind === 'group' && members.length >= 2) {
            const created = await deps.createGroupRoom(title, members);
            const roomId = created?.room?.room_id || created?.room_id;
            await deps.fetchGroupRooms();
            if (roomId) {
              if (targetProjectId) {
                await deps.assignNewEntityContainer?.('group', roomId, { projectId: targetProjectId });
              }
              await deps.openGroupRoom(roomId);
              if (trimmed || deps.getState().attachments.length > 0) {
                await deps.sendGroupMessage(roomId, trimmed);
              }
            }
            return;
          }
          const createdSessionId = await deps.createNewSession({ profile: targetBot, projectId: targetProjectId });
          if (!createdSessionId) return;
          await deps.routeSend(trimmed);
        } catch (err) {
          // gate-degrade: 新建会话或群聊异步创建/首句发送失败时记录告警，防止未捕获 Promise 拒绝
          console.warn('[MobileShell] submit new chat failed:', err);
        }
      })();
    },
    onSendMessage: (text) => {
      void deps.routeSend(text);
    },
    onInterruptTurn: () => {
      void deps.interruptTurn();
    },
    onSelectModel: (model, provider) => {
      void deps.switchModel(model, provider);
    },
    onRefreshModels: () => {
      void deps.fetchModelOptions?.();
    },
    onOpenAttachmentPicker: () => {
      if (deps.openAttachmentPicker) {
        deps.openAttachmentPicker();
        return;
      }
      openBrowserAttachmentPicker((picked) => {
        void deps.onFilesPicked?.(picked);
      });
    },
    onRemoveAttachment: (id) => {
      const state = deps.getState();
      state.attachments = state.attachments.filter((a) => a.id !== id);
      deps.render();
    },
    onOpenSubagentSheet: (sheet) => {
      subagentSheet = sheet;
      deps.render();
    },
    onCloseSubagentSheet: () => {
      subagentSheet = null;
      deps.render();
    },
    onStageReady: () => {
      deps.onStageReady?.();
      deps.syncReactMessageList?.(true);
      deps.syncAgentPresenceHost?.();
      deps.syncAgentPresence?.();
    },
    onSelectInspectorTab: (tab) => {
      openFileGen += 1;
      inspectorTab = tab;
      inspectorReaderOpen = false;
      ensureInspectorTabData(tab);
      deps.render();
    },
    onOpenInspectorItem: (item) => {
      openFileGen += 1;
      inspectorReaderItem = item;
      inspectorReaderOpen = true;
      deps.render();
    },
    onCloseInspectorReader: () => {
      openFileGen += 1;
      inspectorReaderOpen = false;
      deps.render();
    },
    onCopyInspectorText: (text) => {
      void deps.copyText(text);
    },
    onLoadFileTree: (force) => {
      void deps.loadFileTree?.(force);
    },
    onToggleFileTreeDir: (dirPath) => {
      void deps.toggleFileTreeDir?.(dirPath);
    },
    onFilterFileTree: (query) => {
      deps.setFileTreeFilter?.(query);
    },
    onOpenWorkspaceFile: (filePath) => {
      void loadAndOpenReader(filePath, { switchToInspector: false, allowArtifactsTab: false });
    },
    onOpenArtifactFile: (filePath, previewUrl) => {
      void openFileInReader(filePath, previewUrl);
    },
    onDownloadInspectorFile: () => {
      if (!inspectorReaderItem?.filePath) return;
      void deps.downloadFile?.(inspectorReaderItem.filePath);
    },
    onOpenMediaLightbox: (items, initialIndex) => {
      openMediaLightbox(items, initialIndex);
    },
    onCloseMediaLightbox: () => {
      closeMediaLightbox();
    },
    onDownloadMediaItem: (item) => {
      if (deps.downloadMediaItem) {
        void deps.downloadMediaItem(item);
        return;
      }
      const target = item.path || item.src;
      if (target) void deps.downloadFile?.(target);
    },
    resolveMediaUrl: deps.resolveMediaUrl,
    onEnsureLearning: (profile) => {
      void deps.loadLearningGraph?.({ profile: resolveActiveLearningProfile(profile), force: false });
    },
    onRefreshLearning: (profile) => {
      void deps.loadLearningGraph?.({ profile: resolveActiveLearningProfile(profile), force: true });
    },
    onLoadLearningDetail: (id, profile) => {
      void deps.loadLearningDetail?.(id, resolveActiveLearningProfile(profile));
    },
    onEditLearningNode: deps.editLearningNode
      ? (id, content, profile) => deps.editLearningNode!(id, content, resolveActiveLearningProfile(profile))
      : undefined,
    onDeleteLearningNode: deps.deleteLearningNode
      ? (id, profile) => deps.deleteLearningNode!(id, resolveActiveLearningProfile(profile))
      : undefined,
    onHapticSelection: () => {
      if (deps.triggerHapticSelection) {
        deps.triggerHapticSelection();
        return;
      }
      if (typeof window !== 'undefined' && window.hermesMobile?.hapticSelection) {
        void window.hermesMobile.hapticSelection();
      }
    },
    onOpenSettings: () => {
      const state = deps.getState();
      state.isSettingsOpen = true;
      settingsSubpage = null;
      deps.ensureSettingsSectionData(state.settingsSection);
      if (state.gatewayConnected) {
        deps.ensureSettingsSectionData('extensions');
        deps.ensureSettingsSectionData('providers');
      }
      deps.render();
    },
    onCloseSettings: () => {
      const state = deps.getState();
      state.isSettingsOpen = false;
      settingsSubpage = null;
      if (homeTab === 'bots' && state.gatewayConnected) {
        ensureBotHubData();
      }
      deps.render();
    },
    onSelectSettingsSubpage: (subpage) => {
      settingsSubpage = subpage;
      if (subpage === 'providers') {
        deps.ensureSettingsSectionData('providers');
      } else if (subpage === 'extensions') {
        deps.ensureSettingsSectionData('extensions');
      } else if (subpage === 'projects') {
        deps.ensureSettingsSectionData('projects');
      }
      deps.render();
    },
    onSetConversationOrgPrefs: (patch) => {
      deps.setOrgPrefs?.(patch);
    },
    onSetAppearancePreference: (pref) => {
      appearancePref = pref;
      writeStorage(deps.storage, MOBILE_APPEARANCE_STORAGE_KEY, pref);
      syncSkinAndStatusBar(true);
      deps.render();
    },
    onRetryConnect: deps.onRetryConnect,
    settingsActions: {
      ...baseSettingsActions,
      onSelectBotSettle: (botId) => {
        baseSettingsActions.onSelectBotSettle?.(botId);
        if (botSubpage === 'memory') {
          void deps.loadLearningGraph?.({ profile: botId, force: false });
        }
      },
    },
  };

  async function loadAndOpenReader(
    filePath: string,
    opts: { switchToInspector: boolean; allowArtifactsTab: boolean },
  ): Promise<void> {
    const cleanPath = (filePath || '').trim();
    if (!cleanPath) return;
    const expectedGen = ++openFileGen;
    const initialState = deps.getState();
    const initialNorm = cleanPath.replace(/\\/g, '/');
    const cachedReady = initialState.openFiles.find(
      (f) =>
        (f.path === cleanPath || f.path.replace(/\\/g, '/') === initialNorm) &&
        !f.isLoading &&
        f.source !== 'fallback' &&
        (Boolean(f.content) || Boolean(f.isBinary) || Boolean(f.isTooLarge)),
    );
    if (opts.switchToInspector) {
      activePane = 'inspector';
      if (inspectorTab !== 'artifacts' && inspectorTab !== 'files') {
        inspectorTab = 'files';
      }
    }
    const tabAllowedBeforeAwait =
      inspectorTab === 'files' || (opts.allowArtifactsTab && inspectorTab === 'artifacts');
    if (activePane !== 'inspector' || !tabAllowedBeforeAwait) {
      return;
    }
    const title = extractPathBasename(cleanPath);
    inspectorReaderItem = cachedReady
      ? {
          kind: inspectorTab === 'artifacts' ? 'artifacts' : 'files',
          title: extractPathBasename(cachedReady.path),
          subtitle:
            typeof cachedReady.byteSize === 'number'
              ? formatFileSize(cachedReady.byteSize)
              : cachedReady.path,
          content: cachedReady.content,
          filePath: cachedReady.path,
          isImage: isImageExtension(cachedReady.path),
          isVideo: cachedReady.isVideo ?? isVideoExtension(cachedReady.path),
          isBinary: cachedReady.isBinary,
          isTooLarge: cachedReady.isTooLarge,
          isLoading: false,
          byteSize: cachedReady.byteSize,
          canDownload: true,
        }
      : {
          kind: inspectorTab === 'artifacts' ? 'artifacts' : 'files',
          title,
          subtitle: cleanPath,
          content: '',
          filePath: cleanPath,
          isImage: isImageExtension(cleanPath),
          isVideo: isVideoExtension(cleanPath),
          isLoading: true,
          canDownload: true,
        };
    inspectorReaderOpen = true;
    deps.render();

    let openFailed = false;
    try {
      await deps.openWorkspaceFile?.(cleanPath);
    } catch (err) {
      openFailed = true;
      console.warn('[MobileShellCoordinator] openWorkspaceFile failed:', err);
    }
    const tabAllowed = inspectorTab === 'files' || (opts.allowArtifactsTab && inspectorTab === 'artifacts');
    // 规则: 若异步加载期间离开了检查舱、切换了非授权 Tab 或发起更新的文件请求，丢弃过期结果
    if (expectedGen !== openFileGen || activePane !== 'inspector' || !tabAllowed) {
      return;
    }
    const state = deps.getState();
    const normalized = cleanPath.replace(/\\/g, '/');
    const target = state.openFiles.find(
      (f) => f.path === cleanPath || f.path.replace(/\\/g, '/') === normalized,
    );
    if (target) {
      const targetTitle = extractPathBasename(target.path);
      inspectorReaderItem = {
        kind: inspectorTab === 'artifacts' ? 'artifacts' : 'files',
        title: targetTitle,
        subtitle: typeof target.byteSize === 'number' ? formatFileSize(target.byteSize) : target.path,
        content: target.content,
        filePath: target.path,
        isImage: isImageExtension(target.path),
        isVideo: target.isVideo ?? isVideoExtension(target.path),
        isBinary: target.isBinary,
        isTooLarge: target.isTooLarge,
        isLoading: target.isLoading,
        byteSize: target.byteSize,
        canDownload: true,
      };
      inspectorReaderOpen = true;
      deps.render();
    } else if (openFailed) {
      const isVideoTarget = isVideoExtension(cleanPath);
      inspectorReaderItem = {
        kind: inspectorTab === 'artifacts' ? 'artifacts' : 'files',
        title,
        subtitle: cleanPath,
        content: isVideoTarget ? '' : `// ${cleanPath}\n\n${t('inspector.remoteNotice')}`,
        filePath: cleanPath,
        isImage: isImageExtension(cleanPath),
        isVideo: isVideoTarget,
        isLoading: false,
        canDownload: true,
      };
      inspectorReaderOpen = true;
      deps.render();
    } else {
      inspectorReaderItem = null;
      inspectorReaderOpen = false;
      deps.render();
    }
  }

  async function openFileInReader(filePath: string, previewUrl?: string): Promise<void> {
    const clean = (filePath || previewUrl || '').trim();
    if (!clean) return;
    if (isImageExtension(clean)) {
      const title = extractPathBasename(clean) || clean;
      openMediaLightbox(
        [{ id: `mobile-img-${clean}`, src: previewUrl || clean, path: clean, name: title, alt: title }],
        0,
      );
      return;
    }
    await loadAndOpenReader(clean, { switchToInspector: true, allowArtifactsTab: true });
  }

  function openMediaLightbox(items: readonly MediaLightboxItem[], initialIndex: number): void {
    if (!items || items.length === 0) return;
    mediaLightbox = { items, initialIndex };
    deps.render();
  }

  function closeMediaLightbox(): void {
    if (!mediaLightbox) return;
    mediaLightbox = null;
    deps.render();
  }

  function renderMobileShell(host: HTMLElement): void {
    const mounter = deps.mountShell ?? mountMobileWorkspaceShell;
    if (!mountHandle || mountedHost !== host) {
      mountHandle?.unmount();
      mountedHost = host;
      mountHandle = mounter(host, buildSnapshot, actions);
      return;
    }
    mountHandle.update();
  }

  function openSubagentDetail(payload: { messageId: string; tools: ConversationToolVM[] }): void {
    actions.onOpenSubagentSheet(payload);
  }

  function dispose(): void {
    mountHandle?.unmount();
    mountHandle = null;
    mountedHost = null;
  }

  return {
    renderMobileShell,
    buildSnapshot,
    getActions: () => actions,
    openSubagentDetail,
    openFileInReader,
    openMediaLightbox,
    closeMediaLightbox,
    getActivePane: () => activePane,
    getActiveViewContext: () => ({
      isMobile: true,
      mobilePane: activePane,
      homeTab,
      botSubpage,
      settingsOpen: deps.getState().isSettingsOpen,
      settingsSubpage,
    }),
    dispose,
  };
}
