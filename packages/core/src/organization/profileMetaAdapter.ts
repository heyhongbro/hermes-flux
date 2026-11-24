/**
 * 会话组织域 Gateway ui_meta 适配器与核心服务 (UiMetaConversationOrgAdapter & ConversationOrgService)
 *
 * 【设计意图 (Why)】
 *   以 ConversationOrgPort 抽象封装网关 default Profile 的 `ui_meta` 读写，实现：
 *   1. 双键隔离（hermes-flux-folders 与 hermes-flux-done-rooms）独立 CAS，修改文件夹与标记群聊完成互不冲突；
 *   2. 乐观锁冲突自动拉取远端最新状态 → 纯函数三路合并 → 带新 revision 重试（上限 3 次）；
 *   3. 未连网关时显式抛出错误，绝不静默伪造本地成功（Failure Is Not Empty）。
 *
 * 【防范的历史坑 (Pitfall)】
 *   1. 绝不直接手拼 profiles.configure 的其他字段（如 name 之外的 model/soul），仅提交目标 ui_meta 键；
 *   2. profiles.configure 返回 ok:true 但可能仅部分段成功，必须检查 applied.ui_meta_conflicts 与 ui_meta_revisions；
 *   3. 离线写失败后本地缓存不得被脏写覆盖。
 *
 * 【约束与规则 (Rules)】
 *   - 只通过 IRpcCaller 发起 RPC，严禁耦合 Electron / React / DOM；
 *   - 锚定在恒定存在的 'default' Profile 上，确保跨 Bot 与跨设备一致。
 */

import { normalizeAgentProfile } from '../rpc/profileNormalize.js';
import type {
  AgentProfile,
  IRpcCaller,
  ProfilesConfigureApplied,
  ProfilesConfigureParams,
  ProfilesConfigureResult,
  ProfilesListResult,
} from '../rpc/types.js';
import {
  createEmptyDoneRoomsMeta,
  createEmptyFoldersMeta,
  mergeDoneRoomsMetaForCas,
  mergeFoldersMetaForCas,
  parseDoneRoomsMeta,
  parseFoldersMeta,
  assignEntityInMeta,
  createFolderInMeta,
  deleteFolderInMeta,
  pruneStaleOrgKeys,
  renameFolderInMeta,
  setRoomDoneInMeta,
} from './reducer.js';
import {
  DONE_ROOMS_UI_META_KEY,
  FOLDERS_UI_META_KEY,
  type ConversationOrgPort,
  type ConversationOrgSnapshot,
  type FluxDoneRoomsMetaV1,
  type FluxFoldersMetaV1,
  type FolderColorToken,
  type OrgEntityKey,
} from './types.js';

const MAX_CAS_RETRIES = 3;

interface DefaultProfileOrgState {
  foldersMeta: FluxFoldersMetaV1;
  doneRoomsMeta: FluxDoneRoomsMetaV1;
  foldersRevision?: number;
  doneRoomsRevision?: number;
}

function extractFromProfiles(profiles: readonly AgentProfile[]): DefaultProfileOrgState {
  const defaultProfile =
    profiles.find((p) => p.name.toLowerCase() === 'default') ||
    profiles.find((p) => p.isDefault);
  const uiMeta = defaultProfile?.uiMeta;
  const revs = defaultProfile?.uiMetaRevisions;

  return {
    foldersMeta: parseFoldersMeta(uiMeta?.[FOLDERS_UI_META_KEY]),
    doneRoomsMeta: parseDoneRoomsMeta(uiMeta?.[DONE_ROOMS_UI_META_KEY]),
    foldersRevision: revs?.[FOLDERS_UI_META_KEY],
    doneRoomsRevision: revs?.[DONE_ROOMS_UI_META_KEY],
  };
}

function readAppliedObject(result: ProfilesConfigureResult): ProfilesConfigureApplied | null {
  if (!result || typeof result.applied !== 'object' || Array.isArray(result.applied)) {
    return null;
  }
  return result.applied;
}

export class UiMetaConversationOrgAdapter implements ConversationOrgPort {
  private readonly getBridge: () => IRpcCaller | null;
  private cachedState: DefaultProfileOrgState = {
    foldersMeta: createEmptyFoldersMeta(),
    doneRoomsMeta: createEmptyDoneRoomsMeta(),
  };

  constructor(getBridge: () => IRpcCaller | null) {
    this.getBridge = getBridge;
  }

  /** 从已拉取的花名册直接水合内存快照（避免重复发起 profiles.list） */
  public hydrateFromProfiles(profiles: readonly AgentProfile[]): ConversationOrgSnapshot {
    this.cachedState = extractFromProfiles(profiles);
    return this.toSnapshot(this.cachedState);
  }

  public getCachedSnapshot(): ConversationOrgSnapshot {
    return this.toSnapshot(this.cachedState);
  }

  public async loadSnapshot(forceRefresh = false): Promise<ConversationOrgSnapshot> {
    if (!forceRefresh && (this.cachedState.foldersRevision !== undefined || this.cachedState.doneRoomsRevision !== undefined)) {
      return this.toSnapshot(this.cachedState);
    }
    const bridge = this.requireBridge();
    const res = await bridge.request<ProfilesListResult>('profiles.list');
    if (!res || !Array.isArray(res.profiles)) {
      throw new Error('网关返回了非法的 profiles.list 响应数据结构');
    }
    const normalized = res.profiles.map((p) => normalizeAgentProfile(p));
    this.cachedState = extractFromProfiles(normalized);
    return this.toSnapshot(this.cachedState);
  }

  public async saveFoldersMeta(
    updater: (current: FluxFoldersMetaV1) => FluxFoldersMetaV1,
    expectedRevision?: number
  ): Promise<{ meta: FluxFoldersMetaV1; revision?: number }> {
    const bridge = this.requireBridge();
    let baseMeta = this.cachedState.foldersMeta;
    let rev = expectedRevision ?? this.cachedState.foldersRevision;
    let targetMeta = updater(baseMeta);

    for (let attempt = 0; attempt <= MAX_CAS_RETRIES; attempt += 1) {
      const result = await bridge.request<ProfilesConfigureResult, ProfilesConfigureParams>(
        'profiles.configure',
        {
          name: 'default',
          ui_meta: { [FOLDERS_UI_META_KEY]: targetMeta },
          ...(rev !== undefined ? { ui_meta_expected_revisions: { [FOLDERS_UI_META_KEY]: rev } } : {}),
        }
      );
      const applied = readAppliedObject(result);
      const hasConflict = Boolean(applied?.ui_meta_conflicts && FOLDERS_UI_META_KEY in applied.ui_meta_conflicts);

      if (!hasConflict && result?.ok !== false) {
        const nextRev = applied?.ui_meta_revisions?.[FOLDERS_UI_META_KEY] ?? rev;
        this.cachedState = {
          ...this.cachedState,
          foldersMeta: targetMeta,
          foldersRevision: nextRev,
        };
        return { meta: targetMeta, revision: nextRev };
      }

      if (!hasConflict) {
        const errDetail =
          (result && typeof (result as { error?: unknown }).error === 'string'
            ? (result as { error: string }).error
            : result?.confirm_message) || 'profiles.configure failed';
        throw new Error(errDetail);
      }

      if (attempt >= MAX_CAS_RETRIES) {
        throw new Error('文件夹配置在多次并发冲突重试后仍未能落盘，请稍后重试');
      }

      // 冲突时拉取最新远端状态并执行三路合并
      await this.loadSnapshot(true);
      const remoteMeta = this.cachedState.foldersMeta;
      rev = this.cachedState.foldersRevision;
      targetMeta = mergeFoldersMetaForCas(baseMeta, remoteMeta, targetMeta);
      baseMeta = remoteMeta;
    }

    throw new Error('文件夹配置写入失败');
  }

  public async saveDoneRoomsMeta(
    updater: (current: FluxDoneRoomsMetaV1) => FluxDoneRoomsMetaV1,
    expectedRevision?: number
  ): Promise<{ meta: FluxDoneRoomsMetaV1; revision?: number }> {
    const bridge = this.requireBridge();
    let baseMeta = this.cachedState.doneRoomsMeta;
    let rev = expectedRevision ?? this.cachedState.doneRoomsRevision;
    let targetMeta = updater(baseMeta);

    for (let attempt = 0; attempt <= MAX_CAS_RETRIES; attempt += 1) {
      const result = await bridge.request<ProfilesConfigureResult, ProfilesConfigureParams>(
        'profiles.configure',
        {
          name: 'default',
          ui_meta: { [DONE_ROOMS_UI_META_KEY]: targetMeta },
          ...(rev !== undefined ? { ui_meta_expected_revisions: { [DONE_ROOMS_UI_META_KEY]: rev } } : {}),
        }
      );
      const applied = readAppliedObject(result);
      const hasConflict = Boolean(applied?.ui_meta_conflicts && DONE_ROOMS_UI_META_KEY in applied.ui_meta_conflicts);

      if (!hasConflict && result?.ok !== false) {
        const nextRev = applied?.ui_meta_revisions?.[DONE_ROOMS_UI_META_KEY] ?? rev;
        this.cachedState = {
          ...this.cachedState,
          doneRoomsMeta: targetMeta,
          doneRoomsRevision: nextRev,
        };
        return { meta: targetMeta, revision: nextRev };
      }

      if (!hasConflict) {
        const errDetail =
          (result && typeof (result as { error?: unknown }).error === 'string'
            ? (result as { error: string }).error
            : result?.confirm_message) || 'profiles.configure failed';
        throw new Error(errDetail);
      }

      if (attempt >= MAX_CAS_RETRIES) {
        throw new Error('群聊完成状态在多次并发冲突重试后仍未能落盘，请稍后重试');
      }

      await this.loadSnapshot(true);
      const remoteMeta = this.cachedState.doneRoomsMeta;
      rev = this.cachedState.doneRoomsRevision;
      targetMeta = mergeDoneRoomsMetaForCas(baseMeta, remoteMeta, targetMeta);
      baseMeta = remoteMeta;
    }

    throw new Error('群聊完成状态写入失败');
  }

  private requireBridge(): IRpcCaller {
    const bridge = this.getBridge();
    if (!bridge) {
      throw new Error('网关未连接，无法同步文件夹或完成状态');
    }
    return bridge;
  }

  private toSnapshot(state: DefaultProfileOrgState): ConversationOrgSnapshot {
    return {
      folders: [...state.foldersMeta.folders],
      assignments: { ...state.foldersMeta.assignments },
      doneRoomIds: Object.keys(state.doneRoomsMeta.done),
      doneRoomsMap: { ...state.doneRoomsMeta.done },
      foldersRevision: state.foldersRevision,
      doneRoomsRevision: state.doneRoomsRevision,
    };
  }
}

/**
 * 面向表现与壳层的会话组织门面服务（串行化写队列 + 统一异常暴露）
 */
export class ConversationOrgService {
  private readonly port: ConversationOrgPort;
  private writeChain: Promise<unknown> = Promise.resolve();

  constructor(port: ConversationOrgPort) {
    this.port = port;
  }

  public async refresh(): Promise<ConversationOrgSnapshot> {
    return this.port.loadSnapshot(true);
  }

  public async createFolder(name: string, color?: FolderColorToken): Promise<ConversationOrgSnapshot> {
    return this.enqueue(async () => {
      await this.port.saveFoldersMeta((cur) => createFolderInMeta(cur, { name, color }).meta);
      return this.port.loadSnapshot(false);
    });
  }

  public async renameFolder(folderId: string, name: string): Promise<ConversationOrgSnapshot> {
    return this.enqueue(async () => {
      await this.port.saveFoldersMeta((cur) => renameFolderInMeta(cur, folderId, name));
      return this.port.loadSnapshot(false);
    });
  }

  public async deleteFolder(folderId: string): Promise<ConversationOrgSnapshot> {
    return this.enqueue(async () => {
      await this.port.saveFoldersMeta((cur) => deleteFolderInMeta(cur, folderId));
      return this.port.loadSnapshot(false);
    });
  }

  public async assignEntity(params: {
    entityKey: OrgEntityKey;
    containerId: string | null;
    isForeverChat?: boolean;
    hasCwdProjectMatch?: boolean;
  }): Promise<ConversationOrgSnapshot> {
    if (params.isForeverChat) {
      throw new Error('专职 Bot 终身主工位受物理保护，不可移入文件夹或项目');
    }
    return this.enqueue(async () => {
      await this.port.saveFoldersMeta((cur) => assignEntityInMeta(cur, params));
      return this.port.loadSnapshot(false);
    });
  }

  public async setRoomDone(roomId: string, done: boolean): Promise<ConversationOrgSnapshot> {
    return this.enqueue(async () => {
      await this.port.saveDoneRoomsMeta((cur) => setRoomDoneInMeta(cur, roomId, done));
      return this.port.loadSnapshot(false);
    });
  }

  public async pruneStale(options: {
    validSessionKeys?: ReadonlySet<string>;
    validRoomIds?: ReadonlySet<string>;
    validProjectIds?: ReadonlySet<string>;
  }): Promise<ConversationOrgSnapshot | null> {
    return this.enqueue(async () => {
      const snap = await this.port.loadSnapshot(false);
      const curFolders: FluxFoldersMetaV1 = {
        version: 1,
        folders: snap.folders,
        assignments: snap.assignments,
      };
      const curDone: FluxDoneRoomsMetaV1 = {
        version: 1,
        done: snap.doneRoomsMap,
      };
      const pruned = pruneStaleOrgKeys(curFolders, curDone, options);
      if (!pruned.changed) return null;

      if (pruned.foldersChanged) {
        await this.port.saveFoldersMeta(() => pruned.foldersMeta, snap.foldersRevision);
      }
      if (pruned.doneRoomsChanged) {
        await this.port.saveDoneRoomsMeta(() => pruned.doneRoomsMeta, snap.doneRoomsRevision);
      }
      return this.port.loadSnapshot(false);
    });
  }

  /** 将单个客户端内的写请求串行化，避免自发并发造成不必要的 CAS 冲突重试 */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.writeChain.then(task, task);
    this.writeChain = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }
}
