/**
 * 右侧检查舱 Props 映射与竖向导轨 DOM 同步辅助模块 (InspectorDomHelper)
 *
 * 【设计意图 (Why)】
 *   把 `buildInspectorProps` 与 `#flux-inspector-rail` 竖向 Tab/计数徽标的增量 DOM 更新从
 *   `renderCoordinator.ts` 中拆分出来，维持主协调器简洁可读（< 1500 行）且无重复标志位逻辑。
 *
 * 【防范的历史坑 (Pitfall)】
 *   1. 检查舱局部更新时绝不能整块替换 `#flux-inspector-rail` 的 outerHTML，否则破坏展开动画；
 *      仅按需增删 `.active-tab` 类名与 `.vertical-tab-badge` 计数角标；
 *   2. 严禁出现 `as any`，全部使用安全 classList/dataset 访问器。
 *
 * 【约束与规则 (Rules)】
 *   - 仅依赖 `@hermes-flux/core`、`@hermes-flux/ui` 与本地 `appState.ts`。
 */

import { extractPathBasename, type DeliverableItem } from '@hermes-flux/core';
import { buildDeliverableListItems, renderInspectionPod } from '@hermes-flux/ui';
import { resolveActiveWorkspaceCwd, type AppState } from './state/appState.js';

export type InspectionPodSnapshotProps = Parameters<typeof renderInspectionPod>[0];

/** 安全切换元素 CSS 类名（兼容轻量测试 DOM 桩）。 */
export function setInspectorClassFlag(el: Element | null | undefined, cls: string, on: boolean): void {
  if (!el?.classList) return;
  if (typeof el.classList.toggle === 'function') {
    el.classList.toggle(cls, on);
  } else if (on) {
    el.classList.add(cls);
  } else {
    el.classList.remove(cls);
  }
}

/** 安全同步检查舱当前容器模式属性。 */
export function setInspectorPodModeAttr(el: HTMLElement, mode: string): void {
  if (el.dataset) el.dataset.podMode = mode;
  el.setAttribute?.('data-pod-mode', mode);
}

/** 构造传入 `renderInspectionPod` 的完整只读视图 Props。 */
export function buildInspectorProps(
  state: AppState,
  collapsed: boolean,
  getSessionDeliverables?: () => readonly DeliverableItem[],
): InspectionPodSnapshotProps {
  const cwd = resolveActiveWorkspaceCwd(state);
  const deliverables = getSessionDeliverables
    ? buildDeliverableListItems(getSessionDeliverables())
    : [];
  return {
    collapsed,
    podMode: state.rightPodMode?.kind ?? (collapsed ? 'closed' : 'files'),
    canReturnToStatus: state.rightPodMode?.kind === 'files' && state.rightPodMode?.returnTo === 'status',
    activeTab: state.activeInspectorTab,
    gatewayConnected: state.gatewayConnected,
    isFullscreen: state.inspectorFullscreen,
    openFiles: state.openFiles,
    activeFilePath: state.activeFilePath,
    viewMode: state.fileViewMode,
    showLineNumbers: state.fileShowLineNumbers,
    wordWrap: state.fileWordWrap,
    searchOpen: state.fileSearchOpen,
    searchQuery: state.fileSearchQuery,
    fileTreeState: state.fileTreeState ?? { status: 'idle' as const },
    fileTreeExpandedPaths: state.fileTreeExpandedPaths ?? [],
    fileTreeFilterQuery: state.fileTreeFilterQuery ?? '',
    fileTreeCollapsed: state.fileTreeCollapsed ?? false,
    workspaceRoot: cwd || (state.fileTreeState?.status === 'ready' ? state.fileTreeState.rootPath : undefined),
    workspaceRootName: extractPathBasename(
      cwd || (state.fileTreeState?.status === 'ready' ? state.fileTreeState.rootPath : ''),
    ),
    deliverables,
    artifactsFilterQuery: state.artifactsFilterQuery ?? '',
    artifacts: state.artifacts,
    browserFrame: state.browserFrame,
    gitDiffs: state.gitDiffs,
    memories: state.memories,
  };
}

/** 增量同步右侧竖向导轨 `#flux-inspector-rail` 的激活 Tab 高亮与成果物计数角标。 */
export function syncInspectorRailChrome(
  root: ParentNode,
  state: AppState,
  targetMode: string,
  deliverablesCount: number,
): void {
  const isPodFilesOpen = !state.inspectorCollapsed && targetMode === 'files';
  root.querySelectorAll('#flux-inspector-rail .vertical-tab-item').forEach((btn) => {
    const btnEl = btn as Partial<HTMLElement>;
    const btnTab = typeof btn.getAttribute === 'function' ? btn.getAttribute('data-tab') : btnEl.dataset?.tab;
    const active =
      isPodFilesOpen &&
      (btnTab === 'artifacts' ? state.activeInspectorTab === 'artifacts' : state.activeInspectorTab !== 'artifacts');
    setInspectorClassFlag(btn, 'active-tab', active);
    btn.setAttribute?.('aria-pressed', active ? 'true' : 'false');
    if (btnTab === 'artifacts' && typeof btn.querySelector === 'function') {
      let badge = btn.querySelector('.vertical-tab-badge') as HTMLElement | null;
      if (deliverablesCount > 0) {
        const label = deliverablesCount > 99 ? '99+' : String(deliverablesCount);
        if (!badge && typeof document !== 'undefined' && typeof btn.appendChild === 'function') {
          badge = document.createElement('span');
          badge.className = 'vertical-tab-badge';
          badge.setAttribute('data-testid', 'desktop-artifacts-badge');
          btn.appendChild(badge);
        }
        if (badge) badge.textContent = label;
      } else if (badge) {
        badge.remove();
      }
    }
  });
}
