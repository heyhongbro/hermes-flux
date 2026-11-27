/**
 * 移动端表现壳完整快照与回调契约（Mobile Shell UI Contracts）。
 */

import type {
  BackgroundWaitingSummary,
  ClarifyPrompt,
  ConnectionPrompt,
  DeliverableKind,
  FileTreeLoadState,
  GatewayConnectionPhase,
  InteractivePrompt,
  InteractiveReplyPayload,
  LearningDetailState,
  LearningLoadState,
} from '@hermes-flux/core';
import type { InputAttachmentItem } from '../../components/InputDock/InputDock.js';
import type { LeftRailActiveFocus, LeftRailFolder, LeftRailGroupRoom, LeftRailProfile, LeftRailProject } from '../leftRailModel.js';
import type { ConversationToolVM } from '../conversation/types.js';
import type { MediaLightboxItem } from '../conversation/MediaLightbox.js';
import type { SettingsActions, SettingsSnapshot } from '../settings/settingsModel.js';
import type { ConversationOrgPrefs } from '../../tokens/conversationOrgPrefs.js';
import type { SkinId } from '../../tokens/skins.js';
import type { OpenFileItem, OpenFilePreviewProjection } from '../../lib/inspectorViewHelpers.js';
import type {
  MobileAppearancePreference,
  MobileBotSubpage,
  MobileEntityKind,
  MobileHomeModel,
  MobileHomeTab,
  MobileInspectorTab,
  MobileNewChatStep,
  MobilePaneId,
  MobileSettingsSubpage,
} from './mobileShellModel.js';

export interface MobileModelOption {
  id: string;
  provider?: string;
  providerName?: string;
  name?: string;
  displayName?: string;
  unavailable?: boolean;
}

export interface MobileInspectorReaderItem {
  kind: MobileInspectorTab;
  title: string;
  subtitle?: string;
  content: string;
  language?: string;
  isDiff?: boolean;
  filePath?: string;
  isImage?: boolean;
  isVideo?: boolean;
  isLoading?: boolean;
  isBinary?: boolean;
  isTooLarge?: boolean;
  byteSize?: number;
  canDownload?: boolean;
  preview?: OpenFilePreviewProjection;
}

export interface MobileInspectorArtifactItem {
  id: string;
  name: string;
  type: string;
  size: string;
  preview?: string;
  path?: string;
  kind?: DeliverableKind;
  previewUrl?: string;
}

export interface MobileMediaLightboxState {
  items: readonly MediaLightboxItem[];
  initialIndex: number;
}

export interface MobileSubagentSheetState {
  messageId: string;
  tools: ConversationToolVM[];
}

export type MobileActionSheetStep =
  | 'menu'
  | 'confirm-done'
  | 'move-folder'
  | 'new-folder'
  | 'rename-folder'
  | 'confirm-delete-folder';

export interface MobileActionSheetState {
  kind: MobileEntityKind | 'folder';
  id: string;
  title: string;
  botName?: string;
  isProtected?: boolean;
  isDone?: boolean;
  currentContainerId?: string | null;
  hasCwdProjectMatch?: boolean;
  step?: MobileActionSheetStep;
}

export interface MobileWorkspaceSnapshot {
  platform: string;
  appVersion?: string;
  theme: SkinId;
  appearancePref: MobileAppearancePreference;
  locale: 'zh' | 'en';
  gatewayConnected: boolean;
  gatewayConnecting: boolean;
  connectionPhase?: GatewayConnectionPhase;
  connectionReconnectAttempt?: number;
  connectionAuthError?: boolean;
  homeModel: MobileHomeModel;
  homeTab: MobileHomeTab;
  allProfiles: LeftRailProfile[];
  groupAvatars: LeftRailProfile[];
  projects?: LeftRailProject[];
  folders?: LeftRailFolder[];
  showDoneSection?: boolean;
  doneLoading?: boolean;
  doneError?: string;
  activePane: MobilePaneId;
  searchOpen: boolean;
  searchQuery: string;
  newChatOpen: boolean;
  newChatStep: MobileNewChatStep;
  newChatTargetKind: 'bot' | 'group';
  newChatTargetBot: string;
  newChatGroupMembers: string[];
  newChatGroupName: string;
  newChatProjectId?: string;
  newChatContainerId?: string;
  newChatStats?: {
    pluginsCount: number;
    mcpCount: number;
    skillsCount: number;
  };
  settingsOpen: boolean;
  settingsSubpage: MobileSettingsSubpage;
  botSubpage: MobileBotSubpage;
  settingsSnapshot: SettingsSnapshot;
  activeFocus: LeftRailActiveFocus;
  activeSessionId: string;
  activeBotName: string;
  activeBotDisplayName: string;
  inspectorBotProfile?: string;
  inspectorBotLabel?: string;
  isStreaming: boolean;
  messagesCount: number;
  selectedModel: string;
  currentProvider?: string;
  approvalMode?: 'manual' | 'smart' | 'off';
  interactivePrompts?: readonly InteractivePrompt[];
  activeInteractivePromptKey?: string | null;
  interactiveDockCollapsed?: boolean;
  backgroundWaitingSummaries?: readonly BackgroundWaitingSummary[];
  availableModels: string[];
  modelDetails: MobileModelOption[];
  attachments: InputAttachmentItem[];
  dockNotice: string;
  inspectorTab: MobileInspectorTab;
  inspectorReaderOpen: boolean;
  inspectorReaderItem: MobileInspectorReaderItem | null;
  artifacts: MobileInspectorArtifactItem[];
  gitDiffs: Array<{ file: string; additions: number; deletions: number; patch?: string }>;
  openFiles: OpenFileItem[];
  mediaLightbox?: MobileMediaLightboxState | null;
  fileTreeState: FileTreeLoadState;
  fileTreeExpandedPaths: string[];
  fileTreeFilterQuery: string;
  activeFilePath: string;
  workspaceRoot?: string;
  workspaceRootName?: string;
  memories: Array<{ category: string; content: string; updated?: string }>;
  learningState: LearningLoadState;
  learningDetail: LearningDetailState;
  groupMembers: Array<{ name: string; displayName: string; avatar?: string }>;
  subagentSheet: MobileSubagentSheetState | null;
  actionSheet: MobileActionSheetState | null;
  rollbackBanner?: { removedCount: number; anchorLabel: string } | null;
  stageComposerDraft?: { text: string; version: number } | null;
  sideAgentCapsules: Array<{
    id: string;
    kind: 'btw' | 'delegation';
    profile: string;
    question: string;
    answer?: string;
    status: string;
  }>;
}

export interface MobileWorkspaceActions {
  onSelectPane: (pane: MobilePaneId) => void;
  onSelectHomeTab: (tab: MobileHomeTab) => void;
  onSelectBotSubpage: (subpage: MobileBotSubpage) => void;
  onOpenSettingsSubpage: (subpage: MobileSettingsSubpage) => void;
  onSelectBot: (botName: string) => void;
  onSelectGroup: (roomId: string) => void;
  onSelectSession: (sessionId: string, botName?: string) => void;
  onToggleSection: (section: 'bots' | 'groups' | 'sessions') => void;
  onToggleContainer?: (containerId: string) => void;
  onToggleDoneSection?: () => void;
  onRetryDoneSection?: () => void;
  onOpenSearch: () => void;
  onCloseSearch: () => void;
  onSearchChange: (query: string) => void;
  onOpenActionSheet: (sheet: MobileActionSheetState) => void;
  onCloseActionSheet: () => void;
  onSetActionSheetStep?: (step: MobileActionSheetStep) => void;
  onActionOpen: (sheet: MobileActionSheetState) => void;
  onActionRename: (sheet: MobileActionSheetState, nextTitle: string) => void;
  onActionPin: (sheet: MobileActionSheetState) => void;
  onActionArchive: (sheet: MobileActionSheetState) => void;
  onActionMarkDone?: (sheet: MobileActionSheetState) => void;
  onActionRestoreDone?: (sheet: MobileActionSheetState) => void;
  onActionMoveToFolder?: (sheet: MobileActionSheetState, containerId: string | null) => void;
  onActionCreateFolder?: (name: string, moveTarget?: MobileActionSheetState | null) => void;
  onActionRenameFolder?: (folderId: string, nextName: string) => void;
  onActionDeleteFolder?: (folderId: string) => void;
  onActionDelete: (sheet: MobileActionSheetState) => void;
  onActionDisband: (sheet: MobileActionSheetState) => void;

  onOpenNewChat: () => void;
  onCloseNewChat: () => void;
  onSetNewChatStep: (step: MobileNewChatStep) => void;
  onSelectNewChatBot: (botName: string) => void;
  onSetNewChatGroupMembers: (members: string[]) => void;
  onSetNewChatGroupName: (name: string) => void;
  onSelectNewChatProject?: (projectId?: string) => void;
  onSubmitNewChatMessage: (text: string) => void;

  onSendMessage: (text: string) => void;
  onInterruptTurn: () => void;
  onCancelRollback?: () => void;
  onSelectModel: (model: string, provider?: string) => void;
  onSelectApprovalMode?: (mode: 'manual' | 'smart' | 'off') => void;
  onReplyInteractive?: (prompt: InteractivePrompt, payload: InteractiveReplyPayload) => Promise<boolean | void>;
  onLockClarifyAnswer?: (prompt: ClarifyPrompt, questionId: string, answer: string) => Promise<void>;
  onOpenInteractiveExternalUrl?: (url: string) => void;
  onWakeConnection?: (prompt: ConnectionPrompt) => Promise<void>;
  onToggleInteractiveDockCollapsed?: (collapsed: boolean) => void;
  onSelectInteractivePrompt?: (canonicalKey: string) => void;
  onSelectWaitingSummary?: (summary: BackgroundWaitingSummary) => void;
  onRefreshModels?: () => void;
  onOpenAttachmentPicker: () => void;
  onRemoveAttachment: (id: string) => void;
  onOpenSubagentSheet: (sheet: MobileSubagentSheetState) => void;
  onCloseSubagentSheet: () => void;
  onStageReady?: () => void;

  onSelectInspectorTab: (tab: MobileInspectorTab) => void;
  onOpenInspectorItem: (item: MobileInspectorReaderItem) => void;
  onCloseInspectorReader: () => void;
  onCopyInspectorText: (text: string) => void;
  onLoadFileTree: (force?: boolean) => void;
  onToggleFileTreeDir: (dirPath: string) => void;
  onFilterFileTree: (query: string) => void;
  onOpenWorkspaceFile: (filePath: string) => void;
  onOpenArtifactFile?: (filePath: string, previewUrl?: string) => void;
  onDownloadInspectorFile: () => void;
  onOpenMediaLightbox?: (items: readonly MediaLightboxItem[], initialIndex: number) => void;
  onCloseMediaLightbox?: () => void;
  onDownloadMediaItem?: (item: MediaLightboxItem) => void;
  resolveMediaUrl?: (pathOrUrl: string) => Promise<string | null>;
  onEnsureLearning?: (profile: string) => void;
  onRefreshLearning: (profile?: string) => void;
  onLoadLearningDetail: (id: string, profile?: string) => void;
  onEditLearningNode?: (id: string, content: string, profile?: string) => Promise<{ ok: boolean; message?: string }>;
  onDeleteLearningNode?: (id: string, profile?: string) => Promise<{ ok: boolean; message?: string }>;
  onHapticSelection?: () => void;

  onOpenSettings: () => void;
  onCloseSettings: () => void;
  onSelectSettingsSubpage: (subpage: MobileSettingsSubpage) => void;
  onSetAppearancePreference: (pref: MobileAppearancePreference) => void;
  onSetConversationOrgPrefs?: (patch: Partial<ConversationOrgPrefs>) => void;
  onRetryConnect?: () => void;
  settingsActions: SettingsActions;
}

export type MobileGroupSummary = LeftRailGroupRoom;
