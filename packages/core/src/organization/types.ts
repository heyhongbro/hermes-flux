/**
 * 会话组织域类型契约（自定义文件夹 · 项目归属 · 群聊已完成状态）
 *
 * 【设计意图 (Why)】
 *   在不修改 Hermes Gateway 后端的前提下，统一收敛普通会话（Scratchpad）与多 Agent 群聊（Group Room）
 *   的分类与完结态模型，并强制对专职 Bot 终身主工位（Forever Chat）实施物理免疫。
 *
 * 【防范的历史坑 (Pitfall)】
 *   1. P-009 / P-014 双 ID 混用：普通会话主键必须使用持久化 storedId，严禁传入临时 liveId；
 *   2. profileName 大小写漂移：若未先经 trim().toLowerCase() 归一化，会在 ui_meta 中生成大小写分裂的悬空键；
 *   3. 颜色 Token 幻觉：严禁出现设计系统未定义的 --info / --accent 或裸 #hex，仅允许 4 个标准语义 Token。
 *
 * 【约束与规则 (Rules)】
 *   - 零 DOM / 零 React / 零平台私有 API 依赖；
 *   - ui_meta 拆分为 hermes-flux-folders 与 hermes-flux-done-rooms 两个独立顶层键，最小化 CAS 冲突域。
 */

export type OrgEntityKey = `session:${string}:${string}` | `room:${string}`;

/** 显式移出 cwd 自动匹配项目的哨兵值 */
export const ORG_UNASSIGNED_SENTINEL = '__none__' as const;

/** 显式绑定项目容器前缀 */
export const PROJECT_CONTAINER_PREFIX = 'prj:' as const;

/** default Profile ui_meta 键名：自定义文件夹与实体显式归属 */
export const FOLDERS_UI_META_KEY = 'hermes-flux-folders' as const;

/** default Profile ui_meta 键名：群聊已完成（普通会话直接走原生 session.archive） */
export const DONE_ROOMS_UI_META_KEY = 'hermes-flux-done-rooms' as const;

/** 允许的文件夹语义色（对齐 docs/design-system/README.md；缺省为中性无色） */
export type FolderColorToken = 'primary' | 'success' | 'warning' | 'destructive';

export interface FluxFolderItem {
  id: string;
  name: string;
  color?: FolderColorToken;
  order: number;
  createdAt: number;
  updatedAt: number;
}

export interface FluxFoldersMetaV1 {
  version: 1;
  folders: FluxFolderItem[];
  /** OrgEntityKey -> folderId | 'prj:<projectId>' | '__none__' */
  assignments: Record<string, string>;
}

export interface FluxDoneRoomsMetaV1 {
  version: 1;
  /** roomId -> doneAt(ms) */
  done: Record<string, number>;
}

export interface ConversationOrgSnapshot {
  folders: FluxFolderItem[];
  assignments: Record<string, string>;
  doneRoomIds: string[];
  doneRoomsMap: Record<string, number>;
  foldersRevision?: number;
  doneRoomsRevision?: number;
}

export type ResolvedOrgContainer =
  | { kind: 'project'; projectId: string }
  | { kind: 'folder'; folderId: string }
  | null;

export interface ConversationOrgPort {
  loadSnapshot(forceRefresh?: boolean): Promise<ConversationOrgSnapshot>;
  saveFoldersMeta(
    updater: (current: FluxFoldersMetaV1) => FluxFoldersMetaV1,
    expectedRevision?: number
  ): Promise<{ meta: FluxFoldersMetaV1; revision?: number }>;
  saveDoneRoomsMeta(
    updater: (current: FluxDoneRoomsMetaV1) => FluxDoneRoomsMetaV1,
    expectedRevision?: number
  ): Promise<{ meta: FluxDoneRoomsMetaV1; revision?: number }>;
}

/** 归一化 Profile 名称（用于 OrgEntityKey 构造） */
export function normalizeOrgProfileName(profile?: string): string {
  const trimmed = (profile || '').trim().toLowerCase();
  return trimmed || 'default';
}

/** 构造普通会话的组织域唯一键（仅允许传 storedId） */
export function buildSessionEntityKey(profile: string | undefined, storedId: string): OrgEntityKey {
  const cleanId = storedId.trim();
  if (!cleanId) {
    throw new Error('storedId is mandatory for buildSessionEntityKey');
  }
  return `session:${normalizeOrgProfileName(profile)}:${cleanId}`;
}

/** 构造多 Agent 群聊的组织域唯一键 */
export function buildRoomEntityKey(roomId: string): OrgEntityKey {
  const cleanId = roomId.trim();
  if (!cleanId) {
    throw new Error('roomId is mandatory for buildRoomEntityKey');
  }
  return `room:${cleanId}`;
}

export function isProjectContainerId(containerId: string | null | undefined): boolean {
  return typeof containerId === 'string' && containerId.startsWith(PROJECT_CONTAINER_PREFIX);
}

export function toProjectContainerId(projectId: string): string {
  return `${PROJECT_CONTAINER_PREFIX}${projectId.trim()}`;
}

export function extractProjectIdFromContainer(containerId: string | null | undefined): string | null {
  if (!isProjectContainerId(containerId)) return null;
  const id = (containerId as string).slice(PROJECT_CONTAINER_PREFIX.length).trim();
  return id || null;
}
