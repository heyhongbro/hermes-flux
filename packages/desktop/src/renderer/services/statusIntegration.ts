/**
 * 状态栏与子 Agent 监控桌面端装配适配器 (Status Integration Adapter)
 *
 * 【设计意图 (Why)】
 *   把 `SessionStatusService` 的实例化、引用主对话输入框、顶栏/检查舱快捷动作路由
 *   以及跨服务回调收拢在本适配层，避免入口文件 `index.ts` 逼近 1500 行门禁上限，
 *   并维持严格的 `core -> ui -> desktop` 单向依赖方向。
 *
 * 【防范的历史坑 (Pitfall)】
 *   1. `statusIntegration` 构造早于部分后期控制器（`renderCoordinator`、`fileViewerService`、
 *      `inputDockController`），必须通过 getter 惰性读取并安全空保护。
 *   2. 引用子 Agent 摘要回主输入框时，除了改 `input.value` 还需调用 `syncComposerHeight`
 *      并恢复焦点，否则多行引用会被截断在单行高度。
 *
 * 【约束与规则 (Rules)】
 *   - 禁止反向 import `index.ts`；0 `as any`。
 */

import type {
  HermesGatewayClient,
  SessionHandleRegistry,
  SessionLiveInfo,
  TurnAction,
} from '@hermes-flux/core';
import type { I18nKey, MessageViewModel, RightPodActions, RightPodSnapshot } from '@hermes-flux/ui';
import type { AppState } from '../state/appState.js';
import { createSessionStatusService, type SessionStatusService } from './sessionStatusService.js';

export interface StatusIntegrationDeps {
  readonly getState: () => AppState;
  readonly getGatewayClient: () => HermesGatewayClient | null;
  readonly getSessionHandleRegistry: () => SessionHandleRegistry;
  readonly getSessionMessagesCache: () => Map<string, MessageViewModel[]>;
  readonly isStreamingActiveForCurrentSession: () => boolean;
  readonly getActiveStreamingStoredSessionId: () => string | null;
  readonly getActiveStreamingMessageId: () => string | null;
  readonly formatTimestamp: (ts: number) => string;
  readonly scheduleToolPatch: (messageId: string) => void;
  readonly syncReactMessageList: (force?: boolean) => void;
  readonly syncRightPod: () => void;
  readonly syncTitlebar: () => void;
  readonly openFilePreview: (filePath: string) => Promise<void> | void;
  readonly syncComposerHeight: (input: HTMLTextAreaElement | null) => void;
  readonly setTimedDockNotice: (msg: string, durationMs?: number) => void;
  readonly render: () => void;
  readonly t: (key: I18nKey, params?: Record<string, string | number>) => string;
  readonly writeClipboardText?: (text: string) => Promise<void>;
}

export interface StatusIntegration {
  readonly service: SessionStatusService;
  getRightPodSnapshot(): RightPodSnapshot;
  getRightPodActions(): RightPodActions;
  getRunningSubagentCount(): number;
  onToggleInspector(): void;
  onBackFromFiles(): void;
  onInspectorStateChange(): void;
  onOpenSubagent(subagentId: string): void;
  onConnected(): Promise<void>;
  onDisconnected(): void;
  onSessionActivated(storedSessionId: string, profile?: string): void;
  onSessionMessagesLoaded(storedSessionId: string): void;
  onLiveSessionReady(
    storedSessionId: string,
    liveSessionId: string,
    info?: Record<string, unknown> | null,
    profile?: string,
  ): void;
  onGroupActivated(roomId: string): void;
  onSessionDeleted(storedSessionId: string): void;
  onGatewayTurnAction(action: TurnAction, toStoredSessionId: (id?: string | null) => string | null): void;
  dispose(): void;
}

export function createStatusIntegration(deps: StatusIntegrationDeps): StatusIntegration {
  const insertQuoteToComposer = (text: string): void => {
    const trimmed = text.trim();
    if (!trimmed || typeof document === 'undefined') return;
    const input = document.getElementById('dock-prompt-input') as HTMLTextAreaElement | null;
    if (!input) return;
    const quoted = trimmed
      .split(/\r?\n/)
      .map((line) => `> ${line}`)
      .join('\n');
    const prefix = input.value ? `${input.value.replace(/\s+$/, '')}\n\n` : '';
    input.value = `${prefix}${quoted}\n\n`;
    const pos = input.value.length;
    input.focus();
    input.setSelectionRange?.(pos, pos);
    deps.syncComposerHeight(input);
  };

  const service = createSessionStatusService({
    getState: deps.getState,
    getGatewayClient: deps.getGatewayClient,
    getSessionHandleRegistry: deps.getSessionHandleRegistry,
    getSessionMessagesCache: deps.getSessionMessagesCache,
    isStreamingActiveForCurrentSession: deps.isStreamingActiveForCurrentSession,
    getActiveStreamingStoredSessionId: deps.getActiveStreamingStoredSessionId,
    getActiveStreamingMessageId: deps.getActiveStreamingMessageId,
    formatTimestamp: deps.formatTimestamp,
    scheduleToolPatch: deps.scheduleToolPatch,
    syncReactMessageList: deps.syncReactMessageList,
    syncRightPod: deps.syncRightPod,
    syncTitlebar: deps.syncTitlebar,
    openFilePreview: deps.openFilePreview,
    insertQuoteToComposer,
    writeClipboardText: deps.writeClipboardText,
    setTimedDockNotice: deps.setTimedDockNotice,
    render: deps.render,
    t: deps.t,
  });

  return {
    service,
    getRightPodSnapshot: () => service.getRightPodSnapshot(),
    getRightPodActions: () => service.getRightPodActions(),
    getRunningSubagentCount: () => service.getRunningSubagentCount(),
    onToggleInspector: () => service.applyRightPodAction({ type: 'toggle-status-bar' }),
    onBackFromFiles: () => service.applyRightPodAction({ type: 'back-from-files' }),
    onInspectorStateChange: () => {
      service.syncPollingForCurrentMode();
      deps.syncRightPod();
      deps.syncTitlebar();
    },
    onOpenSubagent: (subagentId: string) => service.openSubagent(subagentId),
    onConnected: () => service.onConnected(),
    onDisconnected: () => service.onDisconnected(),
    onSessionActivated: (storedSessionId: string, profile?: string) =>
      service.onSessionActivated(storedSessionId, profile),
    onSessionMessagesLoaded: (storedSessionId: string) =>
      service.onSessionMessagesLoaded(storedSessionId),
    onLiveSessionReady: (storedSessionId, liveSessionId, info, profile) =>
      service.onLiveSessionReady(storedSessionId, liveSessionId, (info ?? null) as SessionLiveInfo | null, profile),
    onGroupActivated: (roomId: string) => service.onGroupActivated(roomId),
    onSessionDeleted: (storedSessionId: string) => service.onSessionDeleted(storedSessionId),
    onGatewayTurnAction: (action, toStoredSessionId) =>
      service.onGatewayTurnAction(action, toStoredSessionId),
    dispose: () => service.dispose(),
  };
}
