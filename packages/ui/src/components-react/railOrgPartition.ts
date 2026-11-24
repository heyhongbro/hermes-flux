/**
 * 左轨与移动端主页共用的容器归类纯函数引擎（Projects / Custom Folders / Unassigned / Done）
 *
 * 【设计意图 (Why)】
 *   desktop 双轨 (`leftRailModel.ts`)、desktop 分组 (`groupedLeftRailModel.ts`)、
 *   以及移动端主页 (`mobileShellModel.ts`) 共用完全一致的三态隔离与扁平单归属分区法则，
 *   避免三份模型各自复制一套 `resolveEntityContainer` 分桶逻辑而产生行为漂移。
 *
 * 【防范的历史坑 (Pitfall)】
 *   1. 已归档项目 (`archived === true`) 不得参与容器渲染，也不得吸纳会话；
 *   2. Bot 终身主工位 (`hidden`) 与子代理 (`isSubagent`) 物理免疫，绝不进入项目/文件夹/已完成桶；
 *   3. 搜索高亮自动展开命中的项目/文件夹，但绝不篡改持久化的 `isCollapsed` 状态；
 *   4. 双轨模式下按当前 Bot 过滤内容时，已创建的全局自定义空文件夹必须保留占位，不得凭空消失。
 *
 * 【约束与规则 (Rules)】
 *   - 零 React/DOM 依赖，纯函数无副作用；
 *   - 归属裁决唯一委托 `@hermes-flux/core` 的 `resolveEntityContainer`。
 */

import {
  buildRoomEntityKey,
  buildSessionEntityKey,
  matchProjectByCwd,
  resolveEntityContainer,
  toProjectContainerId,
  type FolderColorToken,
} from '@hermes-flux/core';
import type {
  LeftRailFolder,
  LeftRailGroupRoom,
  LeftRailProject,
  LeftRailSession,
} from '../components/LeftRail/types.js';
import {
  DONE_CONTAINER_ID,
  isOrgContainerCollapsed,
  type OrgContainerCollapseState,
} from '../tokens/conversationOrgPrefs.js';

export type PartitionedEntry<TSessionVM, TGroupVM> =
  | (TGroupVM & { sortTimestamp: number; isPinnedSort: false })
  | (TSessionVM & { sortTimestamp: number; isPinnedSort: boolean });

export interface PartitionedContainerBucket<TEntry> {
  kind: 'project' | 'folder';
  id: string;
  containerId: string;
  name: string;
  path?: string;
  color?: FolderColorToken;
  isCollapsed: boolean;
  effectiveExpanded: boolean;
  items: TEntry[];
}

export interface PartitionRailOrgInput<TSessionVM, TGroupVM> {
  sessions: readonly LeftRailSession[];
  groups: readonly LeftRailGroupRoom[];
  projects?: readonly LeftRailProject[];
  folders?: readonly LeftRailFolder[];
  assignments?: Readonly<Record<string, string>>;
  doneRoomIds?: readonly string[];
  doneRoomsMap?: Readonly<Record<string, number>>;
  containerCollapsed?: OrgContainerCollapseState;
  /** 隐藏不展示项目文件夹（及该文件夹内部会话）的项目 ID 列表 */
  hiddenProjectIds?: readonly string[];
  searchQuery: string;
  matchesSessionSearch: (session: LeftRailSession, query: string) => boolean;
  matchesGroupSearch: (group: LeftRailGroupRoom, query: string) => boolean;
  mapSession: (
    session: LeftRailSession,
    meta: { isDone: boolean; containerId: string | null; hasCwdProjectMatch: boolean },
  ) => TSessionVM & { sortTimestamp: number; isPinnedSort: boolean };
  mapGroup: (
    group: LeftRailGroupRoom,
    meta: { isDone: boolean; containerId: string | null },
  ) => TGroupVM & { sortTimestamp: number; isPinnedSort: false };
}

export interface PartitionRailOrgResult<TSessionVM, TGroupVM> {
  projectContainers: PartitionedContainerBucket<PartitionedEntry<TSessionVM, TGroupVM>>[];
  folderContainers: PartitionedContainerBucket<PartitionedEntry<TSessionVM, TGroupVM>>[];
  unassignedGroups: TGroupVM[];
  unassignedSessions: TSessionVM[];
  doneItems: PartitionedEntry<TSessionVM, TGroupVM>[];
  doneIsCollapsed: boolean;
  doneEffectiveExpanded: boolean;
}

function compareContainerEntries<TSessionVM, TGroupVM>(
  a: PartitionedEntry<TSessionVM, TGroupVM>,
  b: PartitionedEntry<TSessionVM, TGroupVM>,
): number {
  const pinDiff = (b.isPinnedSort ? 1 : 0) - (a.isPinnedSort ? 1 : 0);
  if (pinDiff !== 0) return pinDiff;
  return (b.sortTimestamp || 0) - (a.sortTimestamp || 0);
}

/**
 * 执行普通会话 + 群聊单归属分桶与已完成统一收口。
 */
export function partitionRailOrgEntities<TSessionVM, TGroupVM>(
  input: PartitionRailOrgInput<TSessionVM, TGroupVM>,
): PartitionRailOrgResult<TSessionVM, TGroupVM> {
  const query = (input.searchQuery || '').trim().toLowerCase();
  const isSearching = query.length > 0;
  const hiddenProjectSet = new Set(
    (input.hiddenProjectIds || []).map((id) => id.trim()).filter(Boolean),
  );
  const activeProjects = (input.projects || []).filter((p) => p && !p.archived && p.id);
  const sortedFolders = [...(input.folders || [])]
    .filter((f) => Boolean(f && f.id && f.name))
    .map((f, idx) => ({
      ...f,
      order: typeof f.order === 'number' && Number.isFinite(f.order) ? f.order : idx,
    }))
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));

  const assignments = input.assignments || {};
  const doneRoomSet = new Set(input.doneRoomIds || []);

  const projectBucketMap = new Map<string, PartitionedEntry<TSessionVM, TGroupVM>[]>();
  for (const project of activeProjects) {
    projectBucketMap.set(project.id, []);
  }
  const folderBucketMap = new Map<string, PartitionedEntry<TSessionVM, TGroupVM>[]>();
  for (const folder of sortedFolders) {
    folderBucketMap.set(folder.id, []);
  }

  const unassignedGroupsRaw: Array<TGroupVM & { sortTimestamp: number; isPinnedSort: false }> = [];
  const unassignedSessionsRaw: Array<TSessionVM & { sortTimestamp: number; isPinnedSort: boolean }> = [];
  const doneItems: PartitionedEntry<TSessionVM, TGroupVM>[] = [];

  for (const group of input.groups) {
    const isDone = Boolean(group.isDone) || doneRoomSet.has(group.roomId);
    const cleanRoomId = (group.roomId || '').trim();
    const entityKey = cleanRoomId ? buildRoomEntityKey(cleanRoomId) : '';
    const resolved = entityKey
      ? resolveEntityContainer({
          entityKey,
          folders: sortedFolders,
          assignments,
          projects: activeProjects,
        })
      : null;
    const containerId =
      resolved?.kind === 'project'
        ? toProjectContainerId(resolved.projectId)
        : resolved?.kind === 'folder'
          ? resolved.folderId
          : null;

    if (!input.matchesGroupSearch(group, query)) continue;

    const mapped = input.mapGroup(group, { isDone, containerId });
    if (isDone) {
      const doneAt = input.doneRoomsMap?.[group.roomId];
      doneItems.push({
        ...mapped,
        sortTimestamp: doneAt && Number.isFinite(doneAt) ? doneAt : mapped.sortTimestamp,
      });
      continue;
    }

    if (resolved?.kind === 'project') {
      projectBucketMap.get(resolved.projectId)?.push(mapped);
    } else if (resolved?.kind === 'folder') {
      folderBucketMap.get(resolved.folderId)?.push(mapped);
    } else {
      unassignedGroupsRaw.push(mapped);
    }
  }

  for (const session of input.sessions) {
    if (session.hidden || session.isSubagent) continue;
    const isDone = Boolean(session.isArchived || session.isDone);
    const cleanSessionId = (session.id || '').trim();
    const entityKey = cleanSessionId ? buildSessionEntityKey(session.botName, cleanSessionId) : '';
    const hasCwdProjectMatch = Boolean(matchProjectByCwd(session.cwd, activeProjects));
    const resolved = entityKey
      ? resolveEntityContainer({
          entityKey,
          cwd: session.cwd,
          isForeverChat: Boolean(session.hidden),
          hidden: Boolean(session.hidden),
          folders: sortedFolders,
          assignments,
          projects: activeProjects,
        })
      : null;
    const containerId =
      resolved?.kind === 'project'
        ? toProjectContainerId(resolved.projectId)
        : resolved?.kind === 'folder'
          ? resolved.folderId
          : null;

    if (!input.matchesSessionSearch(session, query)) continue;

    const mapped = input.mapSession(session, { isDone, containerId, hasCwdProjectMatch });
    if (isDone) {
      doneItems.push(mapped);
      continue;
    }

    if (resolved?.kind === 'project') {
      projectBucketMap.get(resolved.projectId)?.push(mapped);
    } else if (resolved?.kind === 'folder') {
      folderBucketMap.get(resolved.folderId)?.push(mapped);
    } else {
      unassignedSessionsRaw.push(mapped);
    }
  }

  unassignedGroupsRaw.sort((a, b) => (b.sortTimestamp || 0) - (a.sortTimestamp || 0));
  unassignedSessionsRaw.sort(compareContainerEntries);
  doneItems.sort((a, b) => (b.sortTimestamp || 0) - (a.sortTimestamp || 0));

  const projectContainers: PartitionedContainerBucket<PartitionedEntry<TSessionVM, TGroupVM>>[] = [];
  for (const project of activeProjects) {
    if (hiddenProjectSet.has(project.id)) continue;
    const items = (projectBucketMap.get(project.id) || []).sort(compareContainerEntries);
    if (isSearching && items.length === 0) continue;
    const containerId = toProjectContainerId(project.id);
    const isCollapsed = isOrgContainerCollapsed(input.containerCollapsed, containerId);
    projectContainers.push({
      kind: 'project',
      id: project.id,
      containerId,
      name: project.name,
      path: project.path,
      isCollapsed,
      effectiveExpanded: isSearching ? items.length > 0 : !isCollapsed,
      items,
    });
  }

  const folderContainers: PartitionedContainerBucket<PartitionedEntry<TSessionVM, TGroupVM>>[] = [];
  for (const folder of sortedFolders) {
    const items = (folderBucketMap.get(folder.id) || []).sort(compareContainerEntries);
    if (isSearching && items.length === 0) continue;
    const containerId = folder.id;
    const isCollapsed = isOrgContainerCollapsed(input.containerCollapsed, containerId);
    folderContainers.push({
      kind: 'folder',
      id: folder.id,
      containerId,
      name: folder.name,
      color: folder.color,
      isCollapsed,
      effectiveExpanded: isSearching ? items.length > 0 : !isCollapsed,
      items,
    });
  }

  const doneIsCollapsed = isOrgContainerCollapsed(input.containerCollapsed, DONE_CONTAINER_ID);

  return {
    projectContainers,
    folderContainers,
    unassignedGroups: unassignedGroupsRaw,
    unassignedSessions: unassignedSessionsRaw,
    doneItems,
    doneIsCollapsed,
    doneEffectiveExpanded: isSearching ? doneItems.length > 0 : !doneIsCollapsed,
  };
}
