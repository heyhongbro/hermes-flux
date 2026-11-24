/**
 * 项目工作目录树浏览器与文件夹 CRUD 动作装配器
 * (packages/desktop/src/renderer/services/projectDirectoryActions.ts)
 *
 * 【设计意图 (Why)】
 *   将 SettingsActions 中的目录浏览、新建子目录与文件夹重命名动作从 `settingsDataService.ts`
 *   抽离为独立高内聚模块，确保 `settingsDataService.ts` 严格维持在 1500 行门禁以内，
 *   并复用 Core `directoryPickerService` 的远端/回环隔离边界与 shell 安全转义。
 *
 * 【防范的历史坑 (Pitfall)】
 *   1. `settingsDataService.ts` 已接近 1500 行静态门禁上限，新增逻辑不得继续堆叠在同文件中；
 *   2. `shell.exec` 契约只在连接就绪时可调，断连态必须显式返回错误而非静默吞没。
 *
 * 【约束与规则 (Rules)】
 *   - 单向依赖：严禁反向 import `../index.js`；
 *   - 0 `as any`，全部异步交互经 PAL 与 `HermesGatewayClient` 桥接。
 */

import {
  browseProjectDirectory,
  createProjectDirectory,
  renameProjectDirectory,
  type HermesGatewayClient,
  type ProjectDirectorySource,
} from '@hermes-flux/core';
import type { SettingsActions } from '@hermes-flux/ui';
import type { HermesDesktopBridge } from '../../preload/index.js';
import type { AppState } from '../state/appState.js';

export interface ProjectDirectoryActionsDeps {
  readonly getState: () => AppState;
  readonly getGatewayClient: () => HermesGatewayClient | null;
  readonly getDesktopApi?: () => HermesDesktopBridge | undefined;
  readonly getEffectiveUrl: (url: string) => string;
}

export function createProjectDirectoryActions(
  deps: ProjectDirectoryActionsDeps,
): Pick<
  SettingsActions,
  'onBrowseProjectDirectory' | 'onCreateProjectDirectory' | 'onRenameProjectDirectory'
> {
  function buildExecShell() {
    const client = deps.getGatewayClient();
    const state = deps.getState();
    if (!client || !state.gatewayConnected) return undefined;
    return async (command: string, targetProfile?: string) =>
      await client.request<{ stdout?: string; stderr?: string; code?: number }>('shell.exec', {
        command,
        profile: targetProfile || state.profileName || 'default',
      });
  }

  return {
    onBrowseProjectDirectory: async (dirPath) => {
      const state = deps.getState();
      return await browseProjectDirectory(dirPath, {
        platformBridge: deps.getDesktopApi?.(),
        gatewayUrl: deps.getEffectiveUrl(state.gatewayUrl),
        profile: state.profileName || 'default',
        execShell: buildExecShell(),
      });
    },

    onCreateProjectDirectory: async (
      parentPath,
      folderName,
      options?: { source?: ProjectDirectorySource; lockedRoot?: string | null },
    ) => {
      const state = deps.getState();
      return await createProjectDirectory(parentPath, folderName, {
        platformBridge: deps.getDesktopApi?.(),
        gatewayUrl: deps.getEffectiveUrl(state.gatewayUrl),
        profile: state.profileName || 'default',
        source: options?.source,
        lockedRoot: options?.lockedRoot,
        execShell: buildExecShell(),
      });
    },

    onRenameProjectDirectory: async (
      dirPath,
      newName,
      options?: { source?: ProjectDirectorySource; lockedRoot?: string | null },
    ) => {
      const state = deps.getState();
      return await renameProjectDirectory(dirPath, newName, {
        platformBridge: deps.getDesktopApi?.(),
        gatewayUrl: deps.getEffectiveUrl(state.gatewayUrl),
        profile: state.profileName || 'default',
        source: options?.source,
        lockedRoot: options?.lockedRoot,
        execShell: buildExecShell(),
      });
    },
  };
}
