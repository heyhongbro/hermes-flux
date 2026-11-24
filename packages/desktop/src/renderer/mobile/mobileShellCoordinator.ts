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
  inferMobileAppearanceFromTheme,
  mountMobileWorkspaceShell,
  resolveMobileSkinId,
  t,
  type ConversationToolVM,
  type LeftRailProfile,
  type MobileActionSheetState,
  type MobileAppearancePreference,
  type MobileBotSubpage,
  type MobileHomeTab,
  type MobileInspectorReaderItem,
  type MobileInspectorTab,
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
import { extractPathBasename, formatFileSize, isImageExtension } from '@hermes-flux/core';
import type { LeftRailController } from '../events/leftRailController.js';
import { openBrowserAttachmentPicker } from '../events/inputAttachmentPicker.js';
import { resolveActiveWorkspaceCwd, type AppState } from '../state/appState.js';

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
  createNewSession: (opts?: { profile?: string; projectId?: string; title?: string }) => Promise<void>;
  renameSession: (id: string, currentTitle: string, nextTitleOverride: string) => Promise<void>;
  pinSession: (id: string) => Promise<void>;
  archiveSession: (id: string) => Promise<void>;
  deleteSession: (id: string) => Promise<void>;
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
  getActivePane(): MobilePaneId;
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
  let settingsSubpage: MobileSettingsSubpage = null;
  let botSubpage: MobileBotSubpage = null;
  let inspectorTab: MobileInspectorTab = 'artifacts';
  let inspectorReaderOpen = false;
  let inspectorReaderItem: MobileInspectorReaderItem | null = null;
  let openFileGen = 0;
  let subagentSheet: MobileSubagentSheetState | null = null;
  let actionSheet: MobileActionSheetState | null = null;

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
      homeModel,
      homeTab,
      allProfiles,
      groupAvatars: allProfiles,
      activePane,
      searchOpen,
      searchQuery: state.sessionSearchQuery,
      newChatOpen,
      newChatStep,
      newChatTargetKind,
      newChatTargetBot,
      newChatGroupMembers,
      newChatGroupName,
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
      artifacts: state.artifacts,
      gitDiffs: state.gitDiffs,
      openFiles: state.openFiles,
      fileTreeState: state.fileTreeState,
      fileTreeExpandedPaths: Array.from(state.fileTreeExpandedPaths),
      fileTreeFilterQuery: state.fileTreeFilterQuery,
      activeFilePath: state.activeFilePath,
      workspaceRootName: extractPathBasename(resolveActiveWorkspaceCwd(state) || '') || undefined,
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
      activePane = pane;
      inspectorReaderOpen = false;
      if (pane === 'inspector') {
        ensureInspectorTabData(inspectorTab);
      } else {
        openFileGen += 1;
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
      } else {
        activePane = 'stage';
        const targetSess = deps.getState().sessions.find((s) => s.id === sheet.id);
        void deps.selectSession(sheet.id, targetSess?.botName ? { botName: targetSess.botName } : undefined);
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
        void deps.archiveSession(sheet.id);
      }
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
      if (state.gatewayConnected) {
        deps.ensureSettingsSectionData('extensions');
      }
      deps.render();
    },
    onCloseNewChat: () => {
      newChatOpen = false;
      newChatStep = 'compose';
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
    onSubmitNewChatMessage: (text) => {
      const trimmed = text.trim();
      if (!trimmed && deps.getState().attachments.length === 0) return;
      const targetKind = newChatTargetKind;
      const targetBot = newChatTargetBot;
      const members = [...newChatGroupMembers];
      const title = newChatGroupName.trim() || t('mobile.newChat.groupDefaultName');

      newChatOpen = false;
      newChatStep = 'compose';
      activePane = 'stage';
      deps.render();

      void (async () => {
        try {
          if (targetKind === 'group' && members.length >= 2) {
            const created = await deps.createGroupRoom(title, members);
            const roomId = created?.room?.room_id || created?.room_id;
            await deps.fetchGroupRooms();
            if (roomId) {
              await deps.openGroupRoom(roomId);
              if (trimmed || deps.getState().attachments.length > 0) {
                await deps.sendGroupMessage(roomId, trimmed);
              }
            }
            return;
          }
          await deps.createNewSession({ profile: targetBot });
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
      const expectedGen = ++openFileGen;
      void (async () => {
        await deps.openWorkspaceFile?.(filePath);
        // 规则: 若在异步加载文件期间切换面板、Tab 或发起了更新的文件打开请求，丢弃过期结果，严禁回退 activeFilePath 错开别的文件
        if (expectedGen !== openFileGen || activePane !== 'inspector' || inspectorTab !== 'files') {
          return;
        }
        const state = deps.getState();
        const normalized = filePath.replace(/\\/g, '/');
        const target = state.openFiles.find(
          (f) => f.path === filePath || f.path.replace(/\\/g, '/') === normalized,
        );
        if (target) {
          const title = extractPathBasename(target.path) || target.path;
          inspectorReaderItem = {
            kind: 'files',
            title,
            subtitle: typeof target.byteSize === 'number' ? formatFileSize(target.byteSize) : target.path,
            content: target.content,
            filePath: target.path,
            isImage: isImageExtension(target.path),
            isBinary: target.isBinary,
            isTooLarge: target.isTooLarge,
            byteSize: target.byteSize,
            canDownload: true,
          };
          inspectorReaderOpen = true;
          deps.render();
        }
      })();
    },
    onDownloadInspectorFile: () => {
      if (!inspectorReaderItem?.filePath) return;
      void deps.downloadFile?.(inspectorReaderItem.filePath);
    },
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
      }
      deps.render();
    },
    onSetAppearancePreference: (pref) => {
      appearancePref = pref;
      writeStorage(deps.storage, MOBILE_APPEARANCE_STORAGE_KEY, pref);
      syncSkinAndStatusBar(true);
      deps.render();
    },
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
    getActivePane: () => activePane,
    dispose,
  };
}
