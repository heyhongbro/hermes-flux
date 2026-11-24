import type {
  ConversationModeKind,
  RightPodMode,
  ScopedSessionStatus,
  SubagentLogEntry,
  SubagentTaskState,
  SubagentTranscriptState,
} from '@hermes-flux/core';
import type { ConversationMessageVM } from '../conversation/types.js';

export interface SteerFeedbackState {
  subagentId: string;
  status: 'rejected' | 'error';
  message: string;
  at: number;
}

export interface StatusSubjectIdentity {
  kind: 'agent' | 'group';
  name: string;
  profileName: string;
  avatar?: string;
  groupMembers?: string[];
  groupProfiles?: Array<{ name: string; displayName?: string; avatar?: string }>;
}

export interface RightPodSnapshot {
  rightPodMode: RightPodMode;
  conversationMode: ConversationModeKind;
  isStreaming: boolean;
  isFullscreen: boolean;
  inert?: boolean;
  subject?: StatusSubjectIdentity;
  activeScopeKey?: string;
  scope: ScopedSessionStatus | null;
  effectiveCompressionRatio: number | null;
  subagents: SubagentTaskState[];
  selectedSubagent: SubagentTaskState | null;
  selectedTranscript: SubagentTranscriptState | null;
  selectedLogs: SubagentLogEntry[];
  selectedMessages: ConversationMessageVM[];
  listSyncError?: string;
  steerFeedback?: SteerFeedbackState | null;
  locale?: string;
}

export interface RightPodActions {
  onClose: () => void;
  onToggleFullscreen: () => void;
  onOpenFilesAtPath: (filePath?: string) => void;
  onOpenSubagent: (subagentId: string) => void;
  onBackToStatus: () => void;
  onInterruptSubagent: (subagentId: string) => void;
  onSteerSubagent: (subagentId: string, instruction: string) => Promise<boolean | void> | boolean | void;
  onLoadBreakdown: () => void;
  onCopyText: (text: string) => Promise<boolean | void> | boolean | void;
  onQuoteToMain: (text: string) => void;
  onOpenConstellation?: (profileName: string) => void;
}
