import * as React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { StatusBar, type StatusBarProps } from './StatusBar.js';
import { Titlebar, type TitlebarProps } from './Titlebar.js';
import { LeftRail, type LeftRailProps } from './LeftRail.js';
import { NewChatDialog } from './NewChatDialog.js';
import type { NewChatDialogActions, NewChatDialogSnapshot } from './newChatModel.js';
import { RightPodRoot } from './status/RightPodRoot.js';
import type { RightPodActions, RightPodSnapshot } from './status/types.js';
import { InteractivePromptHost, type InteractivePromptHostProps } from './interactive/InteractivePromptHost.js';
import { BackgroundPromptTopPill, type BackgroundPromptTopPillProps } from './interactive/BackgroundPromptTopPill.js';

export type { RightPodActions, RightPodSnapshot };
export type InteractivePromptHostSnapshot = InteractivePromptHostProps;
export type InteractiveTopPillSnapshot = BackgroundPromptTopPillProps;
export type StatusBarSnapshot = Omit<StatusBarProps, 'onClickStatus'>;
export type TitlebarSnapshot = Omit<TitlebarProps, 'onMinimize' | 'onMaximize' | 'onClose' | 'onToggleLeftRail' | 'onToggleInspector' | 'onOpenSettings' | 'onReconnectGateway' | 'onDisconnectGateway' | 'onManageGateways'>;
export type ShellActions = Pick<TitlebarProps, 'onMinimize' | 'onMaximize' | 'onClose' | 'onToggleLeftRail' | 'onToggleInspector' | 'onOpenSettings' | 'onReconnectGateway' | 'onDisconnectGateway' | 'onManageGateways'>;
export type LeftRailSnapshot = Omit<LeftRailProps, 'onSelectSession' | 'onSelectBot' | 'onSelectGroup' | 'onOpenSessionMenu' | 'onOpenBotMenu' | 'onOpenGroupMenu' | 'onSearchChange' | 'onNewChat' | 'onToggleBots' | 'onToggleSessions' | 'onToggleGroups' | 'onStartGroupRename' | 'onConfirmGroupRename' | 'onCancelGroupRename' | 'onResizeStart' | 'onToggleContainer' | 'onToggleDoneSection' | 'onRetryDoneSection' | 'onRequestMarkDone' | 'onRestoreDone' | 'onOpenFolderMenu' | 'onOpenRailMenu' | 'onNewChatInContainer'>;
export type LeftRailActions = Pick<LeftRailProps, 'onSelectSession' | 'onSelectBot' | 'onSelectGroup' | 'onOpenSessionMenu' | 'onOpenBotMenu' | 'onOpenGroupMenu' | 'onSearchChange' | 'onNewChat' | 'onToggleBots' | 'onToggleSessions' | 'onToggleGroups' | 'onStartGroupRename' | 'onConfirmGroupRename' | 'onCancelGroupRename' | 'onResizeStart' | 'onToggleContainer' | 'onToggleDoneSection' | 'onRetryDoneSection' | 'onRequestMarkDone' | 'onRestoreDone' | 'onOpenFolderMenu' | 'onOpenRailMenu' | 'onNewChatInContainer'>;

function createUpdater(
  host: HTMLElement,
  initial: React.ReactElement,
  createRootForHost: (element: HTMLElement) => { render(value: React.ReactElement): void } = createRoot,
): (element: React.ReactElement) => void {
  return createShellMountUpdater(host, initial, createRootForHost);
}

export function getTitlebarSnapshot(snapshot: TitlebarSnapshot): TitlebarSnapshot {
  return { ...snapshot };
}

export function getStatusBarSnapshot(snapshot: StatusBarSnapshot): StatusBarSnapshot {
  return { ...snapshot };
}

export function createShellMountUpdater<T>(
  host: HTMLElement | null,
  initial: T,
  createRootForHost: (element: HTMLElement) => { render(value: T): void },
): (value: T) => void {
  if (!host || !host.isConnected) throw new Error('React shell host must be connected before mounting');
  const root = createRootForHost(host);
  root.render(initial);
  return (value) => root.render(value);
}

/** React 岛只持有具名宿主，避免后续模板局部更新销毁组件与事件。 */
export function mountStatusBar(host: HTMLElement, getSnapshot: () => StatusBarSnapshot, onClickStatus: StatusBarProps['onClickStatus']): () => void {
  const update = createUpdater(host, <StatusBar {...getSnapshot()} onClickStatus={onClickStatus} />);
  return () => update(<StatusBar {...getSnapshot()} onClickStatus={onClickStatus} />);
}

/** 快照更新只改变 props，平台操作通过壳传入的真实回调执行。 */
export function mountTitlebar(host: HTMLElement, getSnapshot: () => TitlebarSnapshot, actions: ShellActions): () => void {
  const render = (): React.ReactElement => <Titlebar {...getSnapshot()} {...actions} />;
  const update = createUpdater(host, render());
  return () => update(render());
}

/**
 * 左轨挂载桥。
 * 【设计意图】快照与回调分离：壳层每次 render 只推新快照，React 侧按 props diff 更新，宿主节点引用不变。
 * 【防范的历史坑】模板时代每帧对 #flux-left-rail 做 outerHTML 替换，导致搜索输入、滚动位置、行内重命名被重建。
 * 【约束与规则】挂载前宿主必须已连接（createShellMountUpdater 内断言），且该宿主不得再被任何 innerHTML 覆写。
 */
export function mountLeftRail(host: HTMLElement, getSnapshot: () => LeftRailSnapshot, actions: LeftRailActions): () => void {
  const render = (): React.ReactElement => <LeftRail {...getSnapshot()} {...actions} />;
  const update = createUpdater(host, render());
  return () => update(render());
}

/**
 * 右侧状态栏与子 Agent 监控持久挂载桥（仅挂载 #react-right-pod-host 内部，宿主只切 data-pod-mode）。
 */
export function mountRightPod(host: HTMLElement, getSnapshot: () => RightPodSnapshot, actions: RightPodActions): () => void {
  const render = (): React.ReactElement => <RightPodRoot snapshot={getSnapshot()} actions={actions} />;
  const update = createUpdater(host, render());
  return () => update(render());
}

/**
 * 新建会话/群聊 React 弹窗持久挂载桥（portal={false} 挂载于独立 [data-flux-island] 宿主）。
 */
export function mountNewChatDialog(
  host: HTMLElement,
  getSnapshot: () => NewChatDialogSnapshot,
  actions: NewChatDialogActions,
): () => void {
  const render = (): React.ReactElement => <NewChatDialog snapshot={getSnapshot()} actions={actions} />;
  const update = createUpdater(host, render());
  return () => update(render());
}

/** 输入舱上方可折叠交互停靠卡宿主挂载桥（仅挂载 #react-interactive-prompt-host）。 */
export function mountInteractivePromptHost(
  host: HTMLElement,
  getSnapshot: () => InteractivePromptHostSnapshot,
  createRootForHost: (element: HTMLElement) => { render(value: React.ReactElement): void } = createRoot,
): () => void {
  const render = (): React.ReactElement => <InteractivePromptHost {...getSnapshot()} />;
  const update = createUpdater(host, render(), createRootForHost);
  return () => update(render());
}

/** 后台会话等待处理顶部提醒胶囊挂载桥（仅挂载 #react-interactive-top-pill-host）。 */
export function mountInteractiveTopPill(
  host: HTMLElement,
  getSnapshot: () => InteractiveTopPillSnapshot,
  createRootForHost: (element: HTMLElement) => { render(value: React.ReactElement): void } = createRoot,
): () => void {
  const render = (): React.ReactElement => <BackgroundPromptTopPill {...getSnapshot()} />;
  const update = createUpdater(host, render(), createRootForHost);
  return () => update(render());
}
