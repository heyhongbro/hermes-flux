/**
 * Hermes Flux 会话组织域协同编排器（Conversation Organization Coordinator）
 *
 * 【设计意图 (Why)】
 *   统一协调桌面端与移动端共享的「已完成 = 归档」「平铺顶级项目 / 自定义文件夹」「发送自动恢复」
 *   以及与 Gateway `default` Profile `ui_meta` 的 CAS 同步状态流。
 *   同时保持 `renderer/index.ts` 与 `settingsDataService.ts` 严格在 1500 行门禁以内。
 *
 * 【防范的历史坑 (Pitfall)】
 *   1. 引用稳定性：仅当 `orgFolders / orgAssignments / orgDoneRooms` 内容真实发生变化时才替换
 *      `AppState` 上的引用并触发 `render()`，保护 `LeftRailSnapshotManager` 记忆化不被无谓击穿；
 *   2. 归档会话惰性拉取未就绪（`!state.doneSessionsLoaded`）时，删除普通会话绝不可调用全量 `pruneStale({ validSessionKeys })`，
 *      否则会把尚未拉取到本地的已归档会话关联误删；仅精确清除当前被删条目键；
 *   3. `BOT` 终身主工位 (`hidden === true`) 物理免疫，绝不可弹标记完成框、修改完成态或移入文件夹；
 *   4. 「标记已完成」必须先经二次确认弹窗（移动端在长按 ActionSheet 内部确认），`session.archive`
 *      或 `profiles.configure` 失败时严禁伪造本地状态。
 *
 * 【约束与规则 (Rules)】
 *   - 单向依赖：严禁反向 `import ../index.js`，所有能力由 `ConversationOrgCoordinatorDeps` 注入；
 *   - 严禁 `as any`，全部文案经由 `deps.t` 国际化字典输出。
 */

import {
  ConversationOrgService,
  UiMetaConversationOrgAdapter,
  buildRoomEntityKey,
  buildSessionEntityKey,
  matchProjectByCwd,
  normalizeOrgProfileName,
  resolveEntityContainer,
  toProjectContainerId,
  type AgentProfile,
  type ConversationOrgSnapshot,
  type HermesGatewayClient,
} from '@hermes-flux/core';
import {
  resolveConversationOrgPrefs,
  saveConversationOrgPrefs,
  saveOrgContainerCollapseState,
  setOrgContainerCollapsed,
  type ConversationOrgPrefs,
  type I18nKey,
  type LeftRailFolder,
} from '@hermes-flux/ui';
import type { AppState } from '../state/appState.js';

export interface ConversationOrgCoordinatorDeps {
  readonly getState: () => AppState;
  readonly getGatewayClient: () => HermesGatewayClient | null;
  readonly render: () => void;
  readonly t: (key: I18nKey, params?: Record<string, string | number>) => string;
  readonly showToast: (message: string, durationMs?: number) => void;
  readonly restoreComposerFocus: () => void;
  readonly describeRpcError: (error: unknown) => string;
  readonly setSessionArchived: (id: string, archived: boolean, profile?: string, gatewayId?: string) => Promise<boolean>;
  readonly isForeverChatSession?: (sessionId: string, profile?: string, gatewayId?: string) => boolean;
  readonly fetchArchivedSessions: (options?: { force?: boolean }) => Promise<void>;
  readonly refreshProfilesFromServer?: () => Promise<void>;
  readonly openNewChatInContainer: (kind: 'session' | 'group', containerId: string) => void;
  readonly promptText?: (title: string, defaultValue?: string) => string | null;
  readonly storage?: {
    getItem: (key: string) => string | null;
    setItem: (key: string, value: string) => void;
  };
  readonly now?: () => number;
}

export interface ConversationOrgCoordinator {
  hydrateFromProfiles(profiles: readonly AgentProfile[]): void;
  setOrgPrefs(patch: Partial<ConversationOrgPrefs>): void;
  toggleContainer(containerId: string): void;
  ensureDoneSessionsLoaded(force?: boolean): Promise<void>;
  onSearchQueryChanged(query: string): void;
  requestMarkDone(kind: 'session' | 'group', id: string, title: string, profile?: string, gatewayId?: string): void;
  markDoneConfirmed(kind: 'session' | 'group', id: string, profile?: string, gatewayId?: string): Promise<boolean>;
  restoreDone(kind: 'session' | 'group', id: string, profile?: string, gatewayId?: string): Promise<boolean>;
  autoReopenIfDone(kind: 'session' | 'group', id: string, profile?: string, gatewayId?: string): void;
  createFolder(
    name: string,
    moveTarget?: { kind: 'session' | 'group'; id: string; profile?: string; gatewayId?: string } | null,
  ): Promise<string | null>;
  renameFolder(folderId: string, nextName: string): Promise<boolean>;
  deleteFolder(folderId: string): Promise<boolean>;
  moveEntityToFolder(
    kind: 'session' | 'group',
    id: string,
    containerId: string | null,
    profile?: string,
    gatewayId?: string,
  ): Promise<boolean>;
  assignNewEntityContainer(
    kind: 'session' | 'group',
    id: string,
    opts: { projectId?: string; containerId?: string; profile?: string },
  ): Promise<void>;
  pruneDeletedEntity(kind: 'session' | 'group', id: string, profile?: string, gatewayId?: string): void;
  promptCreateFolder(moveTarget?: { kind: 'session' | 'group'; id: string; profile?: string; gatewayId?: string } | null): void;
  promptRenameFolder(folderId: string, currentName: string): void;
  confirmDeleteFolder(folderId: string, name: string): void;
  refreshOnFocusIfStale(): void;
  getMoveEntityContext(kind: 'session' | 'group', id: string, profile?: string, gatewayId?: string): {
    isDone: boolean;
    currentContainerId: string | null;
    hasCwdProjectMatch: boolean;
  };
}

const FOCUS_ORG_REFRESH_INTERVAL_MS = 30_000;

export function createConversationOrgCoordinator(
  deps: ConversationOrgCoordinatorDeps,
): ConversationOrgCoordinator {
  const adapter = new UiMetaConversationOrgAdapter(() => deps.getGatewayClient());
  const orgService = new ConversationOrgService(adapter);

  let lastFoldersStamp = '[]';
  let lastAssignmentsStamp = '{}';
  let lastDoneRoomsStamp = '{}';
  let lastFocusRefreshAt = 0;

  function applyOrgSnapshotToState(snap: ConversationOrgSnapshot): boolean {
    const state = deps.getState();
    let changed = false;

    const mappedFolders: LeftRailFolder[] = snap.folders.map((f, idx) => ({
      id: f.id,
      name: f.name,
      color: f.color,
      order: idx,
    }));
    const foldersStamp = JSON.stringify(mappedFolders);
    if (foldersStamp !== lastFoldersStamp) {
      lastFoldersStamp = foldersStamp;
      state.orgFolders = mappedFolders;
      changed = true;
    }

    const assignmentsStamp = JSON.stringify(snap.assignments);
    if (assignmentsStamp !== lastAssignmentsStamp) {
      lastAssignmentsStamp = assignmentsStamp;
      state.orgAssignments = { ...snap.assignments };
      changed = true;
    }

    const doneRoomsStamp = JSON.stringify(snap.doneRoomsMap);
    if (doneRoomsStamp !== lastDoneRoomsStamp) {
      lastDoneRoomsStamp = doneRoomsStamp;
      state.orgDoneRooms = { ...snap.doneRoomsMap };
      changed = true;
    }

    return changed;
  }

  function findSessionById(id: string, profile?: string, gatewayId?: string) {
    const state = deps.getState();
    const targetProfile = profile ? normalizeOrgProfileName(profile) : null;
    const match = (s: { id: string; botName?: string; gatewayId?: string }) =>
      s.id === id &&
      (!targetProfile || normalizeOrgProfileName(s.botName) === targetProfile) &&
      (!gatewayId || !s.gatewayId || s.gatewayId === gatewayId);
    return state.sessions.find(match) || state.archivedSessions.find(match);
  }

  function resolveSessionBotName(id: string, explicitProfile?: string, gatewayId?: string): string {
    if (explicitProfile) return explicitProfile;
    const sess = findSessionById(id, undefined, gatewayId);
    return sess?.botName || 'default';
  }

  function isForeverSession(id: string, profile?: string, gatewayId?: string): boolean {
    const target = findSessionById(id, profile, gatewayId);
    return Boolean(target?.hidden || deps.isForeverChatSession?.(id, profile, target?.gatewayId || gatewayId));
  }

  function hydrateFromProfiles(profiles: readonly AgentProfile[]): void {
    const snap = adapter.hydrateFromProfiles(profiles);
    if (applyOrgSnapshotToState(snap)) {
      deps.render();
    }
  }

  function setOrgPrefs(patch: Partial<ConversationOrgPrefs>): void {
    const state = deps.getState();
    const nextPrefs = resolveConversationOrgPrefs({
      ...state.orgPrefs,
      ...patch,
    });
    state.orgPrefs = nextPrefs;
    saveConversationOrgPrefs(nextPrefs, deps.storage);
    deps.render();
  }

  async function ensureDoneSessionsLoaded(force = false): Promise<void> {
    const state = deps.getState();
    if (!deps.getGatewayClient() || !state.gatewayConnected) return;
    if (!force && (state.doneSessionsLoaded || state.doneLoading)) return;
    await deps.fetchArchivedSessions({ force });
  }

  function toggleContainer(containerId: string): void {
    const state = deps.getState();
    const currentlyCollapsed = Boolean(state.orgContainerCollapsed[containerId] ?? (containerId === 'done'));
    const nextState = setOrgContainerCollapsed(
      state.orgContainerCollapsed,
      containerId,
      !currentlyCollapsed,
    );
    state.orgContainerCollapsed = nextState;
    saveOrgContainerCollapseState(nextState, deps.storage);
    deps.render();

    if (containerId === 'done' && currentlyCollapsed && !state.doneSessionsLoaded && !state.doneLoading) {
      void ensureDoneSessionsLoaded();
    }
  }

  function onSearchQueryChanged(query: string): void {
    const state = deps.getState();
    if (query.trim().length === 0) return;
    if (!state.orgPrefs.showDoneSection) return;
    if (!state.doneSessionsLoaded && !state.doneLoading) {
      void ensureDoneSessionsLoaded();
    }
  }

  async function markDoneConfirmed(
    kind: 'session' | 'group',
    id: string,
    profile?: string,
    gatewayId?: string,
  ): Promise<boolean> {
    if (kind === 'session') {
      const target = findSessionById(id, profile, gatewayId);
      if (!target || target.hidden || deps.isForeverChatSession?.(id, profile, target.gatewayId || gatewayId)) return false;
      return deps.setSessionArchived(id, true, target.botName || profile, target.gatewayId || gatewayId);
    }
    try {
      const snap = await orgService.setRoomDone(id, true);
      applyOrgSnapshotToState(snap);
      deps.render();
      return true;
    } catch (err) {
      deps.showToast(deps.t('rail.orgSyncFailed', { detail: deps.describeRpcError(err) }));
      return false;
    }
  }

  async function restoreDone(
    kind: 'session' | 'group',
    id: string,
    profile?: string,
    gatewayId?: string,
  ): Promise<boolean> {
    if (kind === 'session') {
      const target = findSessionById(id, profile, gatewayId);
      if (target?.hidden || deps.isForeverChatSession?.(id, profile, target?.gatewayId || gatewayId)) return false;
      return deps.setSessionArchived(id, false, target?.botName || profile, target?.gatewayId || gatewayId);
    }
    try {
      const snap = await orgService.setRoomDone(id, false);
      applyOrgSnapshotToState(snap);
      deps.render();
      return true;
    } catch (err) {
      deps.showToast(deps.t('rail.orgSyncFailed', { detail: deps.describeRpcError(err) }));
      return false;
    }
  }

  function requestMarkDone(
    kind: 'session' | 'group',
    id: string,
    title: string,
    profile?: string,
    gatewayId?: string,
  ): void {
    const state = deps.getState();
    let resolvedGatewayId = gatewayId;
    if (kind === 'session') {
      const target = findSessionById(id, profile, gatewayId);
      if (!target || target.hidden || deps.isForeverChatSession?.(id, profile)) return;
      resolvedGatewayId = resolvedGatewayId || target.gatewayId;
    }
    const label = title || id;
    state.confirmModal = {
      title: deps.t('rail.confirmDoneTitle'),
      message:
        kind === 'group'
          ? deps.t('rail.confirmDoneGroup', { name: label })
          : deps.t('rail.confirmDoneSession', { name: label }),
      confirmLabel: deps.t('rail.markDoneAction'),
      cancelLabel: deps.t('common.cancel'),
      isDanger: false,
      onConfirm: () => {
        deps.restoreComposerFocus();
        void markDoneConfirmed(kind, id, profile, resolvedGatewayId);
      },
      onCancel: () => {
        deps.restoreComposerFocus();
      },
    };
    deps.render();
  }

  function autoReopenIfDone(kind: 'session' | 'group', id: string, profile?: string, gatewayId?: string): void {
    const state = deps.getState();
    if (!id || !state.orgPrefs.autoReopenOnSend) return;
    if (kind === 'session') {
      const targetProfile = profile ? normalizeOrgProfileName(profile) : null;
      const matchSess = (s: { id: string; botName?: string; gatewayId?: string }) =>
        s.id === id &&
        (!targetProfile || normalizeOrgProfileName(s.botName) === targetProfile) &&
        (!gatewayId || !s.gatewayId || s.gatewayId === gatewayId);
      const archivedMatch = state.archivedSessions.find(matchSess);
      const flaggedMatch = state.sessions.find((s) => Boolean(s.isArchived) && matchSess(s));
      const matched = archivedMatch || flaggedMatch;
      if (matched) {
        void restoreDone('session', id, matched.botName || profile, matched.gatewayId || gatewayId);
      }
      return;
    }
    if (Boolean(state.orgDoneRooms[id])) {
      void restoreDone('group', id, undefined, gatewayId);
    }
  }

  async function moveEntityToFolder(
    kind: 'session' | 'group',
    id: string,
    containerId: string | null,
    profile?: string,
    gatewayId?: string,
  ): Promise<boolean> {
    const state = deps.getState();
    if (kind === 'session') {
      if (isForeverSession(id, profile, gatewayId)) return false;
      const target = findSessionById(id, profile, gatewayId);
      const resolvedGw = target?.gatewayId || gatewayId;
      const entityKey = buildSessionEntityKey(resolveSessionBotName(id, profile, resolvedGw), id);
      const hasCwdProjectMatch = Boolean(matchProjectByCwd(target?.cwd, state.projects));
      try {
        const snap = await orgService.assignEntity({
          entityKey,
          containerId,
          isForeverChat: false,
          hasCwdProjectMatch,
        });
        applyOrgSnapshotToState(snap);
        deps.render();
        return true;
      } catch (err) {
        deps.showToast(deps.t('rail.orgSyncFailed', { detail: deps.describeRpcError(err) }));
        return false;
      }
    }

    const entityKey = buildRoomEntityKey(id);
    try {
      const snap = await orgService.assignEntity({
        entityKey,
        containerId,
        isForeverChat: false,
        hasCwdProjectMatch: false,
      });
      applyOrgSnapshotToState(snap);
      deps.render();
      return true;
    } catch (err) {
      deps.showToast(deps.t('rail.orgSyncFailed', { detail: deps.describeRpcError(err) }));
      return false;
    }
  }

  async function createFolder(
    name: string,
    moveTarget?: { kind: 'session' | 'group'; id: string; profile?: string; gatewayId?: string } | null,
  ): Promise<string | null> {
    const trimmed = name.trim();
    if (!trimmed) return null;
    try {
      const prevIds = new Set(adapter.getCachedSnapshot().folders.map((f) => f.id));
      const snap = await orgService.createFolder(trimmed);
      applyOrgSnapshotToState(snap);
      const created =
        snap.folders.find((f) => !prevIds.has(f.id)) ??
        snap.folders[snap.folders.length - 1] ??
        null;
      deps.render();
      if (created && moveTarget) {
        await moveEntityToFolder(moveTarget.kind, moveTarget.id, created.id, moveTarget.profile, moveTarget.gatewayId);
      }
      return created?.id ?? null;
    } catch (err) {
      deps.showToast(deps.t('rail.orgSyncFailed', { detail: deps.describeRpcError(err) }));
      return null;
    }
  }

  async function renameFolder(folderId: string, nextName: string): Promise<boolean> {
    const trimmed = nextName.trim();
    if (!folderId || !trimmed) return false;
    try {
      const snap = await orgService.renameFolder(folderId, trimmed);
      applyOrgSnapshotToState(snap);
      deps.render();
      return true;
    } catch (err) {
      deps.showToast(deps.t('rail.orgSyncFailed', { detail: deps.describeRpcError(err) }));
      return false;
    }
  }

  async function deleteFolder(folderId: string): Promise<boolean> {
    if (!folderId) return false;
    try {
      const snap = await orgService.deleteFolder(folderId);
      applyOrgSnapshotToState(snap);
      deps.render();
      return true;
    } catch (err) {
      deps.showToast(deps.t('rail.orgSyncFailed', { detail: deps.describeRpcError(err) }));
      return false;
    }
  }

  async function assignNewEntityContainer(
    kind: 'session' | 'group',
    id: string,
    opts: { projectId?: string; containerId?: string; profile?: string },
  ): Promise<void> {
    const state = deps.getState();
    const isCustomFolder = Boolean(
      opts.containerId && state.orgFolders.some((f) => f.id === opts.containerId),
    );
    if (kind === 'session') {
      if (isCustomFolder && opts.containerId) {
        await moveEntityToFolder('session', id, opts.containerId, opts.profile);
      }
      return;
    }

    const targetContainer = isCustomFolder && opts.containerId
      ? opts.containerId
      : opts.projectId
        ? toProjectContainerId(opts.projectId)
        : '';
    if (!targetContainer) return;

    try {
      const snap = await orgService.assignEntity({
        entityKey: buildRoomEntityKey(id),
        containerId: targetContainer,
        isForeverChat: false,
        hasCwdProjectMatch: false,
      });
      applyOrgSnapshotToState(snap);
      deps.render();
    } catch {
      // 两阶段写容错：群聊主体已在网关落盘，归属同步失败仅提示告警，不回滚或误报建群失败
      deps.showToast(deps.t('rail.groupFolderPostAssignWarning'));
    }
  }

  function pruneDeletedEntity(kind: 'session' | 'group', id: string, profile?: string, gatewayId?: string): void {
    const state = deps.getState();
    if (!deps.getGatewayClient() || !state.gatewayConnected) return;

    if (kind === 'group') {
      const validRoomIds = new Set(
        state.groupRooms.filter((r) => r.roomId !== id).map((r) => r.roomId),
      );
      void orgService
        .pruneStale({ validRoomIds })
        .then((snap) => {
          if (snap && applyOrgSnapshotToState(snap)) deps.render();
        })
        // gate-degrade: 远端解散后 ui_meta 幽灵键垃圾回收属后台最佳努力，失败不阻塞用户交互
        .catch(() => undefined);
      return;
    }

    const deletedKey = buildSessionEntityKey(resolveSessionBotName(id, profile, gatewayId), id);
    if (state.sessionsPhase === 'ready' && state.doneSessionsLoaded) {
      const validSessionKeys = new Set<string>();
      for (const s of [...state.sessions, ...state.archivedSessions]) {
        const candidateKey = buildSessionEntityKey(s.botName || 'default', s.id);
        if (candidateKey === deletedKey) continue;
        validSessionKeys.add(candidateKey);
      }
      void orgService
        .pruneStale({ validSessionKeys })
        .then((snap) => {
          if (snap && applyOrgSnapshotToState(snap)) deps.render();
        })
        // gate-degrade: 删除会话后 ui_meta 映射垃圾回收属后台清理，失败不回滚删库结果
        .catch(() => undefined);
      return;
    }

    if (state.orgAssignments[deletedKey]) {
      void orgService
        .assignEntity({ entityKey: deletedKey, containerId: null, isForeverChat: false, hasCwdProjectMatch: false })
        .then((snap) => {
          if (applyOrgSnapshotToState(snap)) deps.render();
        })
        // gate-degrade: 未加载全部归档前仅清理单条显式归属，失败容错忽略
        .catch(() => undefined);
    }
  }

  function promptCreateFolder(
    moveTarget?: { kind: 'session' | 'group'; id: string; profile?: string; gatewayId?: string } | null,
  ): void {
    if (deps.promptText) {
      const inputName = deps.promptText(deps.t('ctx.folderNamePrompt'), '');
      if (!inputName || !inputName.trim()) return;
      void createFolder(inputName, moveTarget);
      return;
    }
    const state = deps.getState();
    const promptLabel = deps.t('ctx.folderNamePrompt');
    state.confirmModal = {
      title: deps.t('ctx.newFolder'),
      message: promptLabel,
      confirmLabel: deps.t('common.confirm'),
      cancelLabel: deps.t('common.cancel'),
      isDanger: false,
      inputPlaceholder: promptLabel,
      inputDefaultValue: '',
      inputLabel: promptLabel,
      onConfirm: (rawValue) => {
        deps.restoreComposerFocus();
        const nextName = (rawValue ?? '').trim();
        if (!nextName) return;
        void createFolder(nextName, moveTarget);
      },
      onCancel: () => {
        deps.restoreComposerFocus();
      },
    };
    deps.render();
  }

  function promptRenameFolder(folderId: string, currentName: string): void {
    if (deps.promptText) {
      const nextName = deps.promptText(deps.t('ctx.folderRenamePrompt'), currentName);
      if (!nextName || !nextName.trim() || nextName.trim() === currentName) return;
      void renameFolder(folderId, nextName);
      return;
    }
    const state = deps.getState();
    const promptLabel = deps.t('ctx.folderRenamePrompt');
    state.confirmModal = {
      title: deps.t('ctx.renameFolder'),
      message: promptLabel,
      confirmLabel: deps.t('common.confirm'),
      cancelLabel: deps.t('common.cancel'),
      isDanger: false,
      inputPlaceholder: promptLabel,
      inputDefaultValue: currentName,
      inputLabel: promptLabel,
      onConfirm: (rawValue) => {
        deps.restoreComposerFocus();
        const nextName = (rawValue ?? '').trim();
        if (!nextName || nextName === currentName) return;
        void renameFolder(folderId, nextName);
      },
      onCancel: () => {
        deps.restoreComposerFocus();
      },
    };
    deps.render();
  }

  function confirmDeleteFolder(folderId: string, name: string): void {
    const state = deps.getState();
    state.confirmModal = {
      title: deps.t('ctx.confirmDeleteFolderTitle'),
      message: deps.t('ctx.confirmDeleteFolder', { name: name || folderId }),
      confirmLabel: deps.t('ctx.deleteFolder'),
      cancelLabel: deps.t('common.cancel'),
      isDanger: true,
      onConfirm: () => {
        deps.restoreComposerFocus();
        void deleteFolder(folderId);
      },
      onCancel: () => {
        deps.restoreComposerFocus();
      },
    };
    deps.render();
  }

  function refreshOnFocusIfStale(): void {
    const state = deps.getState();
    if (!deps.getGatewayClient() || !state.gatewayConnected || state.isStreaming) return;
    const nowMs = deps.now ? deps.now() : Date.now();
    if (nowMs - lastFocusRefreshAt < FOCUS_ORG_REFRESH_INTERVAL_MS) return;
    lastFocusRefreshAt = nowMs;
    if (state.doneSessionsLoaded) {
      void ensureDoneSessionsLoaded(true);
    }
  }

  function getMoveEntityContext(kind: 'session' | 'group', id: string, profile?: string, gatewayId?: string) {
    const state = deps.getState();
    const target = kind === 'session' ? findSessionById(id, profile, gatewayId) : undefined;
    const key =
      kind === 'group'
        ? buildRoomEntityKey(id)
        : buildSessionEntityKey(target?.botName || profile || 'default', id);
    const resolved = resolveEntityContainer({
      entityKey: key,
      cwd: kind === 'session' ? target?.cwd : undefined,
      folders: state.orgFolders,
      assignments: state.orgAssignments,
      projects: state.projects,
    });
    const currentContainerId =
      resolved?.kind === 'project'
        ? toProjectContainerId(resolved.projectId)
        : resolved?.kind === 'folder'
          ? resolved.folderId
          : null;
    const hasCwdProjectMatch =
      kind === 'session' ? Boolean(matchProjectByCwd(target?.cwd, state.projects)) : false;
    return {
      isDone: kind === 'group' ? Boolean(state.orgDoneRooms[id]) : Boolean(target?.isArchived),
      currentContainerId,
      hasCwdProjectMatch,
    };
  }

  return {
    hydrateFromProfiles,
    setOrgPrefs,
    toggleContainer,
    ensureDoneSessionsLoaded,
    onSearchQueryChanged,
    requestMarkDone,
    markDoneConfirmed,
    restoreDone,
    autoReopenIfDone,
    createFolder,
    renameFolder,
    deleteFolder,
    moveEntityToFolder,
    assignNewEntityContainer,
    pruneDeletedEntity,
    promptCreateFolder,
    promptRenameFolder,
    confirmDeleteFolder,
    refreshOnFocusIfStale,
    getMoveEntityContext,
  };
}
