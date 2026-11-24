/**
 * 会话组织域纯函数状态机与三路 CAS 冲突合并（Zero Side-Effects）
 *
 * 【设计意图 (Why)】
 *   将文件夹 CRUD、单归属优先级裁决（assignments > cwd > 未分类）、Forever Chat 物理免疫、
 *   僵尸键 GC 与逐键乐观锁冲突合并收敛到纯函数层，确保 Desktop / Mobile / Formal Tests
 *   消费同一套无状态数学规则。
 *
 * 【防范的历史坑 (Pitfall)】
 *   1. Forever Chat 污染：即使调用方误传入 Bot 主工位的 key 或 hidden=true 会话，也必须物理拦截；
 *   2. 删除文件夹误删会话：删除文件夹仅允许解除 assignments 指向，绝不可触碰原会话或群聊；
 *   3. 移出自动匹配项目失败：用户把带项目 cwd 的会话“移回未分类”时，必须写入 '__none__' 哨兵，
 *      否则下一次列表刷新又会被 cwd 重新吸回项目。
 *
 * 【约束与规则 (Rules)】
 *   - 所有导出均为纯函数，返回不可变新快照，禁止原地修改入参；
 *   - 仅允许使用 4 个合法设计系统语义色 Token。
 */

import { matchProjectByCwd, type OrgProjectPathCandidate } from './pathMatch.js';
import {
  ORG_UNASSIGNED_SENTINEL,
  extractProjectIdFromContainer,
  isProjectContainerId,
  type FluxDoneRoomsMetaV1,
  type FluxFolderItem,
  type FluxFoldersMetaV1,
  type FolderColorToken,
  type OrgEntityKey,
  type ResolvedOrgContainer,
} from './types.js';

const VALID_COLORS = new Set<string>(['primary', 'success', 'warning', 'destructive']);

export function createEmptyFoldersMeta(): FluxFoldersMetaV1 {
  return { version: 1, folders: [], assignments: {} };
}

export function createEmptyDoneRoomsMeta(): FluxDoneRoomsMetaV1 {
  return { version: 1, done: {} };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizeFolderColor(raw: unknown): FolderColorToken | undefined {
  return typeof raw === 'string' && VALID_COLORS.has(raw) ? (raw as FolderColorToken) : undefined;
}

/** 安全解析 ui_meta['hermes-flux-folders']；结构畸形时安全回落空表 */
export function parseFoldersMeta(raw: unknown): FluxFoldersMetaV1 {
  const obj = asRecord(raw);
  if (!obj) return createEmptyFoldersMeta();

  const folders: FluxFolderItem[] = [];
  const seenIds = new Set<string>();
  if (Array.isArray(obj.folders)) {
    for (let i = 0; i < obj.folders.length; i += 1) {
      const item = asRecord(obj.folders[i]);
      if (!item) continue;
      const id = typeof item.id === 'string' ? item.id.trim() : '';
      const name = typeof item.name === 'string' ? item.name.trim().slice(0, 40) : '';
      if (!id || !name || seenIds.has(id)) continue;
      seenIds.add(id);
      const color = normalizeFolderColor(item.color);
      folders.push({
        id,
        name,
        ...(color ? { color } : {}),
        order: typeof item.order === 'number' && Number.isFinite(item.order) ? item.order : i,
        createdAt: typeof item.createdAt === 'number' && Number.isFinite(item.createdAt) ? item.createdAt : 0,
        updatedAt: typeof item.updatedAt === 'number' && Number.isFinite(item.updatedAt) ? item.updatedAt : 0,
      });
    }
  }
  folders.sort((a, b) => a.order - b.order || a.createdAt - b.createdAt || a.id.localeCompare(b.id));

  const assignments: Record<string, string> = {};
  const rawAssignments = asRecord(obj.assignments);
  if (rawAssignments) {
    for (const [k, v] of Object.entries(rawAssignments)) {
      const cleanKey = k.trim();
      if (!cleanKey || typeof v !== 'string') continue;
      const cleanVal = v.trim();
      if (!cleanVal) continue;
      assignments[cleanKey] = cleanVal;
    }
  }

  return { version: 1, folders, assignments };
}

/** 安全解析 ui_meta['hermes-flux-done-rooms']；结构畸形时安全回落空表 */
export function parseDoneRoomsMeta(raw: unknown): FluxDoneRoomsMetaV1 {
  const obj = asRecord(raw);
  if (!obj) return createEmptyDoneRoomsMeta();

  const done: Record<string, number> = {};
  const rawDone = asRecord(obj.done);
  if (rawDone) {
    for (const [roomId, ts] of Object.entries(rawDone)) {
      const cleanId = roomId.trim();
      if (!cleanId) continue;
      if (typeof ts === 'number' && Number.isFinite(ts) && ts >= 0) {
        done[cleanId] = ts;
      }
    }
  }
  return { version: 1, done };
}

export interface ResolveEntityContainerInput {
  entityKey: OrgEntityKey;
  cwd?: string;
  isForeverChat?: boolean;
  hidden?: boolean;
  folders: ReadonlyArray<Pick<FluxFolderItem, 'id'>>;
  assignments: Readonly<Record<string, string>>;
  projects: ReadonlyArray<OrgProjectPathCandidate>;
}

/**
 * 裁决会话或群聊最终所属容器。
 * 优先级铁律：Forever Chat 免疫 (null) → 显式 assignments[key]（含 '__none__' 解绑哨兵） → cwd 最长前缀匹配项目 → null。
 */
export function resolveEntityContainer(input: ResolveEntityContainerInput): ResolvedOrgContainer {
  if (input.isForeverChat || input.hidden) {
    return null;
  }

  const assigned = input.assignments[input.entityKey];
  if (assigned === ORG_UNASSIGNED_SENTINEL) {
    return null;
  }

  if (assigned) {
    const prjId = extractProjectIdFromContainer(assigned);
    if (prjId) {
      const matchedActiveProject = input.projects.find((p) => p.id === prjId && !p.archived);
      if (matchedActiveProject) {
        return { kind: 'project', projectId: matchedActiveProject.id };
      }
      // 显式指定的项目已删除或归档：允许回落至 cwd 匹配（若仍命中另一活跃项目）或未分类
    } else if (input.folders.some((f) => f.id === assigned)) {
      return { kind: 'folder', folderId: assigned };
    }
  }

  const cwdMatchedProjectId = matchProjectByCwd(input.cwd, input.projects);
  if (cwdMatchedProjectId) {
    return { kind: 'project', projectId: cwdMatchedProjectId };
  }
  return null;
}

function generateFolderId(existingIds: ReadonlySet<string>, now: number): string {
  let seq = 0;
  let candidate = `fld_${now.toString(36)}`;
  while (existingIds.has(candidate)) {
    seq += 1;
    candidate = `fld_${now.toString(36)}_${seq}`;
  }
  return candidate;
}

export function createFolderInMeta(
  meta: FluxFoldersMetaV1,
  params: { id?: string; name: string; color?: FolderColorToken; now?: number }
): { meta: FluxFoldersMetaV1; folder: FluxFolderItem } {
  const cleanName = params.name.trim().slice(0, 40);
  if (!cleanName) {
    throw new Error('文件夹名称不能为空');
  }
  const now = params.now ?? Date.now();
  const existingIds = new Set(meta.folders.map((f) => f.id));
  const id = params.id?.trim() || generateFolderId(existingIds, now);
  if (existingIds.has(id)) {
    throw new Error(`文件夹 ID 冲突: ${id}`);
  }
  const maxOrder = meta.folders.reduce((max, f) => Math.max(max, f.order), -1);
  const folder: FluxFolderItem = {
    id,
    name: cleanName,
    ...(params.color ? { color: params.color } : {}),
    order: maxOrder + 1,
    createdAt: now,
    updatedAt: now,
  };
  return {
    meta: {
      version: 1,
      folders: [...meta.folders, folder],
      assignments: { ...meta.assignments },
    },
    folder,
  };
}

export function renameFolderInMeta(
  meta: FluxFoldersMetaV1,
  folderId: string,
  name: string,
  now: number = Date.now()
): FluxFoldersMetaV1 {
  const cleanName = name.trim().slice(0, 40);
  if (!cleanName) {
    throw new Error('文件夹名称不能为空');
  }
  const targetExists = meta.folders.some((f) => f.id === folderId);
  if (!targetExists) {
    throw new Error(`未找到指定文件夹: ${folderId}`);
  }
  return {
    version: 1,
    folders: meta.folders.map((f) =>
      f.id === folderId ? { ...f, name: cleanName, updatedAt: now } : f
    ),
    assignments: { ...meta.assignments },
  };
}

/**
 * 删除自定义文件夹，仅清除指向该文件夹的 assignments 映射，100% 保留内部会话与群聊。
 */
export function deleteFolderInMeta(
  meta: FluxFoldersMetaV1,
  folderId: string
): FluxFoldersMetaV1 {
  const nextAssignments: Record<string, string> = {};
  for (const [key, val] of Object.entries(meta.assignments)) {
    if (val !== folderId) {
      nextAssignments[key] = val;
    }
  }
  return {
    version: 1,
    folders: meta.folders.filter((f) => f.id !== folderId),
    assignments: nextAssignments,
  };
}

/**
 * 将普通会话或群聊移入目标容器（自定义文件夹 / 项目）或移出未分类。
 * 若该实体原本因 cwd 自动归属某个项目，而用户显式要求移回未分类（containerId === null），
 * 传入 hasCwdProjectMatch=true 会写入 '__none__' 解绑哨兵；否则直接删键保持稀疏存储。
 */
export function assignEntityInMeta(
  meta: FluxFoldersMetaV1,
  params: {
    entityKey: OrgEntityKey;
    containerId: string | null;
    isForeverChat?: boolean;
    hasCwdProjectMatch?: boolean;
  }
): FluxFoldersMetaV1 {
  if (params.isForeverChat) {
    throw new Error('专职 Bot 终身主工位受物理保护，不可移入文件夹或项目');
  }
  const nextAssignments = { ...meta.assignments };
  if (params.containerId === null || params.containerId === '') {
    if (params.hasCwdProjectMatch) {
      nextAssignments[params.entityKey] = ORG_UNASSIGNED_SENTINEL;
    } else {
      delete nextAssignments[params.entityKey];
    }
  } else {
    const cleanTarget = params.containerId.trim();
    const valid =
      cleanTarget === ORG_UNASSIGNED_SENTINEL ||
      isProjectContainerId(cleanTarget) ||
      meta.folders.some((f) => f.id === cleanTarget);
    if (!valid) {
      throw new Error(`目标文件夹不存在: ${cleanTarget}`);
    }
    nextAssignments[params.entityKey] = cleanTarget;
  }
  return {
    version: 1,
    folders: [...meta.folders],
    assignments: nextAssignments,
  };
}

export function setRoomDoneInMeta(
  meta: FluxDoneRoomsMetaV1,
  roomId: string,
  done: boolean,
  now: number = Date.now()
): FluxDoneRoomsMetaV1 {
  const cleanRoomId = roomId.trim();
  if (!cleanRoomId) {
    throw new Error('roomId is mandatory for setRoomDoneInMeta');
  }
  const nextDone = { ...meta.done };
  if (done) {
    nextDone[cleanRoomId] = now;
  } else {
    delete nextDone[cleanRoomId];
  }
  return {
    version: 1,
    done: nextDone,
  };
}

/**
 * 清理已删除会话/已解散群聊以及指向已不存在容器的悬空键，保持 profile.yaml 长期轻量干净。
 */
export function pruneStaleOrgKeys(
  foldersMeta: FluxFoldersMetaV1,
  doneRoomsMeta: FluxDoneRoomsMetaV1,
  options: {
    validSessionKeys?: ReadonlySet<string>;
    validRoomIds?: ReadonlySet<string>;
    validProjectIds?: ReadonlySet<string>;
  }
): {
  foldersMeta: FluxFoldersMetaV1;
  doneRoomsMeta: FluxDoneRoomsMetaV1;
  foldersChanged: boolean;
  doneRoomsChanged: boolean;
  changed: boolean;
} {
  const validFolderIds = new Set(foldersMeta.folders.map((f) => f.id));
  const nextAssignments: Record<string, string> = {};
  let foldersChanged = false;

  for (const [key, target] of Object.entries(foldersMeta.assignments)) {
    if (key.startsWith('session:') && options.validSessionKeys && !options.validSessionKeys.has(key)) {
      foldersChanged = true;
      continue;
    }
    if (key.startsWith('room:')) {
      const roomId = key.slice('room:'.length);
      if (options.validRoomIds && !options.validRoomIds.has(roomId)) {
        foldersChanged = true;
        continue;
      }
    }
    if (target !== ORG_UNASSIGNED_SENTINEL) {
      const prjId = extractProjectIdFromContainer(target);
      if (prjId) {
        if (options.validProjectIds && !options.validProjectIds.has(prjId)) {
          foldersChanged = true;
          continue;
        }
      } else if (!validFolderIds.has(target)) {
        foldersChanged = true;
        continue;
      }
    }
    nextAssignments[key] = target;
  }

  const nextDone: Record<string, number> = {};
  let doneRoomsChanged = false;
  for (const [roomId, ts] of Object.entries(doneRoomsMeta.done)) {
    if (options.validRoomIds && !options.validRoomIds.has(roomId)) {
      doneRoomsChanged = true;
      continue;
    }
    nextDone[roomId] = ts;
  }

  return {
    foldersMeta: foldersChanged
      ? { version: 1, folders: [...foldersMeta.folders], assignments: nextAssignments }
      : foldersMeta,
    doneRoomsMeta: doneRoomsChanged ? { version: 1, done: nextDone } : doneRoomsMeta,
    foldersChanged,
    doneRoomsChanged,
    changed: foldersChanged || doneRoomsChanged,
  };
}

/**
 * 逐键三路合并 hermes-flux-folders（CAS 冲突重试时保证多端增删不互相覆盖）。
 */
export function mergeFoldersMetaForCas(
  base: FluxFoldersMetaV1,
  remote: FluxFoldersMetaV1,
  local: FluxFoldersMetaV1
): FluxFoldersMetaV1 {
  const baseFolders = new Map(base.folders.map((f) => [f.id, f]));
  const remoteFolders = new Map(remote.folders.map((f) => [f.id, f]));
  const localFolders = new Map(local.folders.map((f) => [f.id, f]));
  const allFolderIds = new Set([...baseFolders.keys(), ...remoteFolders.keys(), ...localFolders.keys()]);

  const mergedFolders: FluxFolderItem[] = [];
  for (const id of allFolderIds) {
    const b = baseFolders.get(id);
    const r = remoteFolders.get(id);
    const l = localFolders.get(id);
    if (r && l) {
      mergedFolders.push(l.updatedAt >= r.updatedAt ? l : r);
    } else if (r && !l) {
      // 本地明确删除了 base 中存在的文件夹，且远端未在之后更新 -> 采纳本地删除；若远端更新过或新增 -> 保留远端
      if (!b || r.updatedAt > b.updatedAt) {
        mergedFolders.push(r);
      }
    } else if (!r && l) {
      // 远端明确删除了 base 中存在的文件夹，且本地未更新 -> 采纳远端删除；若本地新建或更新过 -> 保留本地
      if (!b || l.updatedAt > b.updatedAt) {
        mergedFolders.push(l);
      }
    }
  }
  mergedFolders.sort((a, b) => a.order - b.order || a.createdAt - b.createdAt || a.id.localeCompare(b.id));

  const validFolderSet = new Set(mergedFolders.map((f) => f.id));
  const allAssignKeys = new Set([
    ...Object.keys(base.assignments),
    ...Object.keys(remote.assignments),
    ...Object.keys(local.assignments),
  ]);
  const mergedAssignments: Record<string, string> = {};
  for (const key of allAssignKeys) {
    const bVal = base.assignments[key];
    const rVal = remote.assignments[key];
    const lVal = local.assignments[key];

    let chosen: string | undefined;
    if (lVal === rVal) {
      chosen = rVal;
    } else if (lVal !== bVal && rVal === bVal) {
      chosen = lVal;
    } else if (rVal !== bVal && lVal === bVal) {
      chosen = rVal;
    } else {
      // 双方同时修改同一个实体的归属：优先本地最新意图（触发冲突的当前客户端）
      chosen = lVal ?? rVal;
    }

    if (
      chosen &&
      (chosen === ORG_UNASSIGNED_SENTINEL || isProjectContainerId(chosen) || validFolderSet.has(chosen))
    ) {
      mergedAssignments[key] = chosen;
    }
  }

  return { version: 1, folders: mergedFolders, assignments: mergedAssignments };
}

/**
 * 逐键三路合并 hermes-flux-done-rooms（CAS 冲突重试时收敛）。
 */
export function mergeDoneRoomsMetaForCas(
  base: FluxDoneRoomsMetaV1,
  remote: FluxDoneRoomsMetaV1,
  local: FluxDoneRoomsMetaV1
): FluxDoneRoomsMetaV1 {
  const allIds = new Set([
    ...Object.keys(base.done),
    ...Object.keys(remote.done),
    ...Object.keys(local.done),
  ]);
  const merged: Record<string, number> = {};

  for (const id of allIds) {
    const b = base.done[id];
    const r = remote.done[id];
    const l = local.done[id];

    if (r !== undefined && l !== undefined) {
      merged[id] = Math.max(r, l);
    } else if (r !== undefined && l === undefined) {
      if (b === undefined || r > b) {
        merged[id] = r;
      }
    } else if (l !== undefined && r === undefined) {
      if (b === undefined || l > b) {
        merged[id] = l;
      }
    }
  }
  return { version: 1, done: merged };
}
