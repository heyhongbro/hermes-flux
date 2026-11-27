/**
 * Hermes Flux Context Menu Component
 * Supports Session, Dedicated Bot and Multi-Agent Group context menus.
 *
 * 【设计意图 (Why)】
 *   右键上下文菜单与 React 浮层菜单统一纯哑光视觉语言（--popover 底色 + --border-subtle +
 *   --radius-panel 容器 + 4px 栅格菜单项），移除过时的毛玻璃、高饱和红底与 9px/12px 字面量。
 *
 * 【防范的历史坑 (Pitfall)】
 *   1. 三类实体的右键菜单曾各自内联 9px/12px/backdrop-filter 样式串，导致换肤漏风、字号与 4px 网格脱节；
 *   2. 传入的右键坐标若为 NaN/Infinity（测试夹具或异常事件），直接插值会破坏 `left`/`top` 内联样式；
 *      统一通过 `Number.isFinite` 归一化。
 *
 * 【约束与规则 (Rules)】
 *   1. 三种实体共用统一的容器与条目模板辅助函数，严禁复制 3 份几乎相同的样式串；
 *   2. 视觉样式收敛到 Desktop CSS `.flux-context-menu`，内联只保留实时坐标定位与层级。
 */

import { t } from '../../i18n/index.js';
import { escapeHtml } from '../../utils/html.js';

export interface ContextMenuFolderOption {
  id: string;
  name: string;
}

export interface ContextMenuProps {
  x: number;
  y: number;
  targetType: 'session' | 'bot' | 'group' | 'folder' | 'rail';
  targetId: string;
  targetName: string;
  sessionId?: string;
  sessionTitle?: string;
  sessionProfile?: string;
  gatewayId?: string;
  isDone?: boolean;
  currentContainerId?: string | null;
  hasCwdProjectMatch?: boolean;
  projects?: ReadonlyArray<ContextMenuFolderOption>;
  folders?: ReadonlyArray<ContextMenuFolderOption>;
}

interface ContextMenuItemSpec {
  action?: string;
  label: string;
  iconSvg?: string;
  danger?: boolean;
  dividerAfter?: boolean;
  isActive?: boolean;
  isSectionLabel?: boolean;
}

/** 渲染单个右键菜单项或分组小标题与分隔线，保证 role="menuitem" 与 4px 栅格统一样式。 */
function renderContextMenuItem(item: ContextMenuItemSpec): string {
  if (item.isSectionLabel) {
    return `<div class="ctx-section-label">${escapeHtml(item.label)}</div>`;
  }
  const cls = item.danger
    ? 'ctx-item ctx-danger-item'
    : item.isActive
      ? 'ctx-item ctx-item--active'
      : 'ctx-item';
  const divider = item.dividerAfter ? '<div class="ctx-divider" role="separator"></div>' : '';
  const safeAction = escapeHtml(item.action || '');
  const activeMark = item.isActive ? '<span class="ctx-item-check" aria-hidden="true">✓</span>' : '';
  return `
      <button type="button" role="menuitem" class="${cls}" data-action="${safeAction}">
        ${item.iconSvg || ''}
        <span class="ctx-item-label">${escapeHtml(item.label)}</span>
        ${activeMark}
      </button>
      ${divider}`;
}

/** 渲染右键菜单纯哑光浮层壳并夹紧有限像素坐标。 */
function renderContextMenuShell(ctx: ContextMenuProps, items: ContextMenuItemSpec[]): string {
  const x = Number.isFinite(ctx.x) ? Math.round(ctx.x) : 0;
  const y = Number.isFinite(ctx.y) ? Math.round(ctx.y) : 0;
  return `
    <div id="session-context-menu" role="menu" class="flux-context-menu" style="position: fixed; left: ${x}px; top: ${y}px; z-index: 2000;">
      ${items.map(renderContextMenuItem).join('')}
    </div>
  `;
}

const ICON_CHAT =
  '<svg class="ctx-item-icon ctx-item-icon--accent" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
const ICON_COPY =
  '<svg class="ctx-item-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
const ICON_EDIT =
  '<svg class="ctx-item-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>';
const ICON_TRASH =
  '<svg class="ctx-item-icon ctx-item-icon--danger" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>';
const ICON_PIN =
  '<svg class="ctx-item-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"/></svg>';
const ICON_EXPORT =
  '<svg class="ctx-item-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>';
const ICON_ARCHIVE =
  '<svg class="ctx-item-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></svg>';

const ICON_CHECK =
  '<svg class="ctx-item-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
const ICON_RESTORE =
  '<svg class="ctx-item-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>';
const ICON_FOLDER =
  '<svg class="ctx-item-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>';
const ICON_FOLDER_PLUS =
  '<svg class="ctx-item-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 10v6"/><path d="M9 13h6"/><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>';
const ICON_PROJECT =
  '<svg class="ctx-item-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="13" r="2"/><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/><path d="M14 13h3"/><path d="M7 13h3"/></svg>';
const ICON_PLUS =
  '<svg class="ctx-item-icon ctx-item-icon--accent" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="M12 5v14"/></svg>';

function buildFolderMenuItems(ctx: ContextMenuProps): ContextMenuItemSpec[] {
  const projects = ctx.projects || [];
  const folders = ctx.folders || [];
  const items: ContextMenuItemSpec[] = [
    { isSectionLabel: true, label: t('ctx.moveToFolder') },
    ...projects.map((proj) => {
      const containerId = proj.id.startsWith('prj:') ? proj.id : `prj:${proj.id}`;
      return {
        action: `move-folder:${containerId}`,
        label: proj.name,
        iconSvg: ICON_PROJECT,
        isActive: ctx.currentContainerId === containerId,
      };
    }),
    ...folders.map((folder) => ({
      action: `move-folder:${folder.id}`,
      label: folder.name,
      iconSvg: ICON_FOLDER,
      isActive: ctx.currentContainerId === folder.id,
    })),
  ];
  if (ctx.currentContainerId) {
    items.push({
      action: 'move-folder:__unassign__',
      label: t('ctx.removeFromFolder'),
      iconSvg: ICON_RESTORE,
    });
  }
  items.push({
    action: 'new-folder-and-move',
    label: t('ctx.newFolder'),
    iconSvg: ICON_FOLDER_PLUS,
    dividerAfter: true,
  });
  return items;
}

export function renderContextMenu(ctx?: ContextMenuProps): string {
  if (!ctx) return '';

  if (ctx.targetType === 'rail') {
    return renderContextMenuShell(ctx, [
      { action: 'new-folder', label: t('ctx.newFolder'), iconSvg: ICON_FOLDER_PLUS },
    ]);
  }

  if (ctx.targetType === 'folder') {
    return renderContextMenuShell(ctx, [
      { action: 'folder-new-chat', label: t('rail.newChatInContainer', { name: ctx.targetName }), iconSvg: ICON_PLUS },
      { action: 'folder-rename', label: t('ctx.renameFolder'), iconSvg: ICON_EDIT, dividerAfter: true },
      { action: 'folder-delete', label: t('ctx.deleteFolder'), iconSvg: ICON_TRASH, danger: true },
    ]);
  }

  if (ctx.targetType === 'bot') {
    return renderContextMenuShell(ctx, [
      { action: 'bot-chat', label: t('ctx.botChat'), iconSvg: ICON_CHAT },
      { action: 'copy-id', label: t('ctx.copyId'), iconSvg: ICON_COPY, dividerAfter: true },
      { action: 'bot-edit', label: t('ctx.botConfig'), iconSvg: ICON_EDIT },
    ]);
  }

  const folderItems = buildFolderMenuItems(ctx);

  if (ctx.targetType === 'group') {
    return renderContextMenuShell(ctx, [
      { action: 'group-rename', label: t('ctx.rename'), iconSvg: ICON_EDIT },
      { action: 'copy-id', label: t('ctx.copyId'), iconSvg: ICON_COPY, dividerAfter: true },
      ...folderItems,
      ctx.isDone
        ? { action: 'restore-active', label: t('rail.restoreAction'), iconSvg: ICON_RESTORE }
        : { action: 'mark-done', label: t('rail.markDoneAction'), iconSvg: ICON_CHECK },
      { action: 'disband-group', label: t('ctx.disbandGroup'), iconSvg: ICON_TRASH, danger: true },
    ]);
  }

  return renderContextMenuShell(ctx, [
    { action: 'rename', label: t('ctx.rename'), iconSvg: ICON_EDIT },
    { action: 'copy-id', label: t('ctx.copySessionId'), iconSvg: ICON_COPY },
    { action: 'pin', label: t('ctx.pin'), iconSvg: ICON_PIN },
    { action: 'export', label: t('ctx.export'), iconSvg: ICON_EXPORT, dividerAfter: true },
    ...folderItems,
    ctx.isDone
      ? { action: 'restore-active', label: t('rail.restoreAction'), iconSvg: ICON_RESTORE }
      : { action: 'mark-done', label: t('rail.markDoneAction'), iconSvg: ICON_CHECK },
    { action: 'delete', label: t('ctx.delete'), iconSvg: ICON_TRASH, danger: true },
  ]);
}
