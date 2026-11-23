/**
 * 移动端表现壳完整快照与回调契约（Mobile Shell UI Contracts）。
 */

import type {
  FileTreeLoadState,
  LearningDetailState,
  LearningLoadState,
} from '@hermes-flux/core';
import type { InputAttachmentItem } from '../../components/InputDock/InputDock.js';
import type { LeftRailActiveFocus, LeftRailGroupRoom, LeftRailProfile } from '../leftRailModel.js';
import type { ConversationToolVM } from '../conversation/types.js';
import type { SettingsActions, SettingsSnapshot } from '../settings/settingsModel.js';
import type { SkinId } from '../../tokens/skins.js';
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
  isBinary?: boolean;
  isTooLarge?: boolean;
  byteSize?: number;
  canDownload?: boolean;
}

export interface MobileSubagentSheetState {
  messageId: string;
  tools: ConversationToolVM[];
}

export interface MobileActionSheetState {
  kind: MobileEntityKind;
  id: string;
  title: string;
  isProtected?: boolean;
}

export interface MobileWorkspaceSnapshot {
  platform: string;
  appVersion?: string;
  theme: SkinId;
  appearancePref: MobileAppearancePreference;
  locale: 'zh' | 'en';
  gatewayConnected: boolean;
  gatewayConnecting: boolean;
  homeModel: MobileHomeModel;
  homeTab: MobileHomeTab;
  allProfiles: LeftRailProfile[];
  groupAvatars: LeftRailProfile[];
  activePane: MobilePaneId;
  searchOpen: boolean;
  searchQuery: string;
  newChatOpen: boolean;
  newChatStep: MobileNewChatStep;
  newChatTargetKind: 'bot' | 'group';
  newChatTargetBot: string;
  newChatGroupMembers: string[];
  newChatGroupName: string;
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
  isStreaming: boolean;
  messagesCount: number;
  selectedModel: string;
  currentProvider?: string;
  availableModels: string[];
  modelDetails: MobileModelOption[];
  attachments: InputAttachmentItem[];
  dockNotice: string;
  inspectorTab: MobileInspectorTab;
  inspectorReaderOpen: boolean;
  inspectorReaderItem: MobileInspectorReaderItem | null;
  artifacts: Array<{ id: string; name: string; type: string; size: string; preview?: string }>;
  gitDiffs: Array<{ file: string; additions: number; deletions: number; patch?: string }>;
  openFiles: Array<{ id?: string; path: string; content: string; language?: string; isDiff?: boolean }>;
  fileTreeState: FileTreeLoadState;
  fileTreeExpandedPaths: string[];
  fileTreeFilterQuery: string;
  activeFilePath: string;
  workspaceRootName?: string;
  memories: Array<{ category: string; content: string; updated?: string }>;
  learningState: LearningLoadState;
  learningDetail: LearningDetailState;
  groupMembers: Array<{ name: string; displayName: string; avatar?: string }>;
  subagentSheet: MobileSubagentSheetState | null;
  actionSheet: MobileActionSheetState | null;
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
  onOpenSearch: () => void;
  onCloseSearch: () => void;
  onSearchChange: (query: string) => void;
  onOpenActionSheet: (sheet: MobileActionSheetState) => void;
  onCloseActionSheet: () => void;
  onActionOpen: (sheet: MobileActionSheetState) => void;
  onActionRename: (sheet: MobileActionSheetState, nextTitle: string) => void;
  onActionPin: (sheet: MobileActionSheetState) => void;
  onActionArchive: (sheet: MobileActionSheetState) => void;
  onActionDelete: (sheet: MobileActionSheetState) => void;
  onActionDisband: (sheet: MobileActionSheetState) => void;

  onOpenNewChat: () => void;
  onCloseNewChat: () => void;
  onSetNewChatStep: (step: MobileNewChatStep) => void;
  onSelectNewChatBot: (botName: string) => void;
  onSetNewChatGroupMembers: (members: string[]) => void;
  onSetNewChatGroupName: (name: string) => void;
  onSubmitNewChatMessage: (text: string) => void;

  onSendMessage: (text: string) => void;
  onInterruptTurn: () => void;
  onSelectModel: (model: string, provider?: string) => void;
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
  onDownloadInspectorFile: () => void;
  onRefreshLearning: () => void;
  onLoadLearningDetail: (id: string) => void;
  onEditLearningNode?: (id: string, content: string) => Promise<{ ok: boolean; message?: string }>;
  onDeleteLearningNode?: (id: string) => Promise<{ ok: boolean; message?: string }>;
  onHapticSelection?: () => void;

  onOpenSettings: () => void;
  onCloseSettings: () => void;
  onSelectSettingsSubpage: (subpage: MobileSettingsSubpage) => void;
  onSetAppearancePreference: (pref: MobileAppearancePreference) => void;
  settingsActions: SettingsActions;
}

export type MobileGroupSummary = LeftRailGroupRoom;
