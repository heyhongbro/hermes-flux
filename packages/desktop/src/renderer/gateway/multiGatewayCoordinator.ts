/**
 * Desktop 多网关状态协调器与入口轻装接插件 (Multi-Gateway Coordinator · M1.3)
 *
 * 【设计意图 (Why)】
 *   将多网关聚合快照写入 `AppState`、聚焦实体的离线只读判别、顶栏单机重连/断开分发
 *   以及 `renderer/index.ts` 的冷启动初始化封装在本模块，避免 `index.ts` 突破 1500 行上限。
 *
 * 【防范的历史坑 (Pitfall)】
 *   1. 在两台网关并存时，用户点击另一台离线网关的缓存会话后，`state.gatewayConnected` 仍为
 *      `true`（因为另一台网关在线）；若不独立计算 `activeEntityGatewayOffline`，输入框仍可发送
 *      并误发往错误的在线节点；
 *   2. 单网关工作台退化（`totalCount <= 1`）时绝不能覆盖原有单机渐进同步状态，保持 100% 兼容。
 *
 * 【约束与规则 (Rules)】
 *   - 严禁出现 `as any`；
 *   - 头LESS/测试环境注入桩下（无真实 IPC/localStorage）安全初始化不抛错。
 */

import {
  LiveStreamRegistry,
  SessionHandleRegistry,
  modelCatalogFingerprint,
  normalizeGatewayOriginUrl,
  normalizeOrgProfileName,
  readSessionHandles,
  runGuarded,
  type AggregatedMultiGatewayView,
  type AgentProfile,
  type FluxLogger,
  type GatewayPoolHealthSummary,
  type GroupRoomSummary,
  type GuardedRunLogger,
  type HermesGatewayClient,
  type IRpcCaller,
  type IncomingServerRequest,
  type ModelCatalogEntry,
  type ModelDetail,
  type NormalizedSession,
  type ProbeOrWakeResult,
} from '@hermes-flux/core';
import { renderToolCapsuleSlot, type I18nKey, type MessageViewModel } from '@hermes-flux/ui';
import type { HermesDesktopBridge } from '../../preload/index.js';
import { resolveColdStartFocus } from '../coldStartFocus.js';
import { type AppState, resolveScopedEntityRuntimeKey } from '../state/appState.js';
import {
  loadGatewayConfigs,
  migrateLegacyGatewaySecrets,
  resolveGatewayPassword,
} from './gatewayRegistryStore.js';
import {
  createMultiGatewayRuntime,
  type MultiGatewayRuntime,
  type SlotSnapshotData,
} from './multiGatewayRuntime.js';

export type MultiGatewayCoordState = Pick<
  AppState,
  | 'activeFocus'
  | 'activeGatewayId'
  | 'gatewayConnected'
  | 'gatewayCount'
  | 'gatewayHealthSummary'
  | 'activeEntityGatewayOffline'
  | 'profiles'
  | 'sessions'
  | 'groupRooms'
> & {
  gatewayUrl?: string;
  profilesPhase?: AppState['profilesPhase'];
  sessionsPhase?: AppState['sessionsPhase'];
};

export interface MultiGatewayCoordinatorDeps {
  readonly runtime: Omit<MultiGatewayRuntime, 'seedSlotSliceIfEmpty'> &
    Partial<Pick<MultiGatewayRuntime, 'seedSlotSliceIfEmpty'>>;
  readonly getState: () => MultiGatewayCoordState;
  readonly render: () => void;
  readonly getFallbackClient?: () => HermesGatewayClient | null;
  readonly getFallbackHandleRegistry?: () => SessionHandleRegistry;
  readonly getFallbackLiveStreamRegistry?: () => LiveStreamRegistry;
  readonly onManageGateways?: () => void;
}

export type CachedSliceSeedSnapshot = {
  profiles?: readonly AgentProfile[];
  sessions?: readonly NormalizedSession[];
  groups?: readonly (GroupRoomSummary | MultiGatewayCoordState['groupRooms'][number])[];
};

export interface MultiGatewayCoordinator {
  syncPoolToState(): AggregatedMultiGatewayView;
  seedCachedSlicesFromState(snapshot?: CachedSliceSeedSnapshot): boolean;
  refreshActiveOfflineState(): boolean;
  getClientForGateway(gatewayId?: string): HermesGatewayClient | null;
  resolveClient(gatewayId?: string): HermesGatewayClient | null;
  resolveActiveClient(fallbackClient?: HermesGatewayClient | null): HermesGatewayClient | null;
  getActiveGatewayUrl(fallbackUrl?: string): string;
  getHandleRegistry(gatewayId?: string): SessionHandleRegistry;
  getActiveHandleRegistry(): SessionHandleRegistry;
  getLiveStreamRegistry(gatewayId?: string): LiveStreamRegistry | undefined;
  resolveMessageOwner(messageId: string): { sessionId: string; gatewayId?: string } | null;
  getConnectedClients(): Array<{ gatewayId: string; client: HermesGatewayClient }>;
  getGatewayUrl(gatewayId?: string): string;
  refreshSlotSlices(gatewayId: string): Promise<void>;
  refreshAllSlots(): Promise<void>;
  refreshAllSlotsIfMulti(isConfigured?: () => boolean): Promise<boolean>;
  reconnectGateway(gatewayId: string): Promise<boolean>;
  disconnectGateway(gatewayId: string): boolean;
  readonly onManageGateways?: () => void;
}

/** 判定当前激活焦点所属的实体/节点是否处于离线只读态。 */
export function isActiveEntityGatewayOffline(
  state: Pick<
    MultiGatewayCoordState,
    'activeFocus' | 'activeGatewayId' | 'profiles' | 'sessions' | 'groupRooms'
  >,
  health?: GatewayPoolHealthSummary,
): boolean {
  const focus = state.activeFocus;
  const focusGw = focus.gatewayId || state.activeGatewayId;

  let entityOffline: boolean | undefined;
  if (focus.type === 'session') {
    const match = state.sessions.find(
      (s) => s.id === focus.sessionId && (!focusGw || !s.gatewayId || s.gatewayId === focusGw),
    );
    entityOffline = match?.gatewayOffline;
  } else if (focus.type === 'bot') {
    const match = state.profiles.find(
      (p) =>
        p.name.toLowerCase() === focus.botName.toLowerCase() &&
        (!focusGw || !p.gatewayId || p.gatewayId === focusGw),
    );
    entityOffline = match?.gatewayOffline;
  } else {
    const match = state.groupRooms.find(
      (g) => g.roomId === focus.roomId && (!focusGw || !g.gatewayId || g.gatewayId === focusGw),
    );
    entityOffline = match?.gatewayOffline;
  }

  if (entityOffline !== undefined) return entityOffline;
  if (focusGw && health) {
    const slot = health.slots.find((s) => s.gatewayId === focusGw);
    if (slot) return !slot.connected;
  }
  return false;
}

/** 按运行池槽位与回退状态解析指定网关的基础 HTTP URL。 */
export function resolveGatewayUrlFromRuntime(
  runtime: Pick<MultiGatewayRuntime, 'getSlot'>,
  getState: () => { gatewayUrl?: string },
  gatewayId?: string,
): string {
  if (gatewayId) {
    const slotUrl = runtime.getSlot(gatewayId)?.config.url;
    if (slotUrl) return slotUrl;
  }
  return runtime.getSlot()?.config.url || getState().gatewayUrl || '';
}

/** 构建多网关协调器实例。 */
export function createMultiGatewayCoordinator(
  deps: MultiGatewayCoordinatorDeps,
): MultiGatewayCoordinator {
  const { runtime, getState, render } = deps;
  let hadMultiGatewayState = false;
  const fallbackHandleRegistry = new SessionHandleRegistry();
  const handleRegistries = new Map<string, SessionHandleRegistry>();
  const streamRegistries = new Map<string, LiveStreamRegistry>();

  function seedCachedSlicesFromState(snapshot?: CachedSliceSeedSnapshot): boolean {
    const state = getState();
    const health = runtime.getHealthSummary();
    if (health.totalCount < 2) return false;
    const srcProfiles = snapshot?.profiles ?? state.profiles;
    const srcSessions = snapshot?.sessions ?? state.sessions;
    const srcGroups = snapshot?.groups ?? state.groupRooms;
    let seededAny = false;
    for (const slotSummary of health.slots) {
      if (slotSummary.connected) continue;
      const gwId = slotSummary.gatewayId;
      const profiles = srcProfiles.filter((p) => p.gatewayId === gwId);
      const sessions = srcSessions.filter((s) => s.gatewayId === gwId);
      const groups: GroupRoomSummary[] = srcGroups
        .filter((g) => g.gatewayId === gwId)
        .map((g) => ({
          roomId: g.roomId,
          name: g.name,
          members: [...g.members],
          createdAt: g.createdAt ?? 0,
          updatedAt: g.updatedAt ?? 0,
          lastMessagePreview:
            'lastMessage' in g
              ? g.lastMessage
              : 'lastMessagePreview' in g
                ? g.lastMessagePreview
                : undefined,
          isDisbanded: 'isDisbanded' in g ? g.isDisbanded : undefined,
          gatewayId: gwId,
          gatewayLabel: g.gatewayLabel,
          gatewayOffline: g.gatewayOffline,
          crossGateway: g.crossGateway,
          authorityGatewayId: 'authorityGatewayId' in g ? g.authorityGatewayId : undefined,
          authorityEpoch: 'authorityEpoch' in g ? g.authorityEpoch : undefined,
        }));
      if (profiles.length === 0 && sessions.length === 0 && groups.length === 0) continue;
      if (runtime.seedSlotSliceIfEmpty?.(gwId, { profiles, sessions, groups })) {
        seededAny = true;
      }
    }
    if (seededAny) {
      syncPoolToState();
    }
    return seededAny;
  }

  function refreshActiveOfflineState(): boolean {
    const state = getState();
    const offline = isActiveEntityGatewayOffline(state, state.gatewayHealthSummary);
    state.activeEntityGatewayOffline = offline;
    return offline;
  }

  function syncPoolToState(): AggregatedMultiGatewayView {
    const state = getState();
    const health = runtime.getHealthSummary();
    const view = runtime.buildAggregatedView();

    state.gatewayHealthSummary = health.totalCount > 0 ? health : undefined;
    state.gatewayCount = view.effectiveGatewayCount > 0
      ? view.effectiveGatewayCount
      : Math.max(1, health.totalCount);

    if (view.isMultiGateway || health.totalCount >= 2) {
      hadMultiGatewayState = true;
      state.profiles = view.profiles;
      state.sessions = view.sessions;
      state.groupRooms = view.groups;
      state.gatewayConnected = health.onlineCount > 0;
    } else if (hadMultiGatewayState) {
      hadMultiGatewayState = false;
      state.profiles = view.profiles;
      state.sessions = view.sessions;
      state.groupRooms = view.groups;
      state.gatewayConnected = health.onlineCount > 0;
    }

    state.activeEntityGatewayOffline = isActiveEntityGatewayOffline(state, state.gatewayHealthSummary);
    return view;
  }

  function resolveClient(gatewayId?: string): HermesGatewayClient | null {
    if (gatewayId) {
      const slot = runtime.getSlot(gatewayId);
      if (slot) return slot.connected ? slot.client : null;
      return runtime.getHealthSummary().totalCount === 0
        ? (deps.getFallbackClient?.() ?? null)
        : null;
    }
    return runtime.getClient() ?? deps.getFallbackClient?.() ?? null;
  }

  function getHandleRegistry(gatewayId?: string): SessionHandleRegistry {
    if (gatewayId && ((getState().gatewayCount ?? 1) >= 2 || Boolean(runtime.getSlot(gatewayId)))) {
      let reg = handleRegistries.get(gatewayId);
      if (!reg) {
        reg = new SessionHandleRegistry();
        handleRegistries.set(gatewayId, reg);
      }
      return reg;
    }
    return deps.getFallbackHandleRegistry?.() ?? fallbackHandleRegistry;
  }

  function getLiveStreamRegistry(gatewayId?: string): LiveStreamRegistry | undefined {
    if (gatewayId && ((getState().gatewayCount ?? 1) >= 2 || Boolean(runtime.getSlot(gatewayId)))) {
      let reg = streamRegistries.get(gatewayId);
      if (!reg) {
        reg = new LiveStreamRegistry();
        streamRegistries.set(gatewayId, reg);
      }
      return reg;
    }
    return deps.getFallbackLiveStreamRegistry?.();
  }

  function resolveMessageOwner(messageId: string): { sessionId: string; gatewayId?: string } | null {
    if (!messageId) return null;
    const focusedGw = resolveFocusedGatewayId(getState());
    if (focusedGw) {
      const focusedSession = getLiveStreamRegistry(focusedGw)?.getSessionIdForMessage(messageId);
      if (focusedSession) return { sessionId: focusedSession, gatewayId: focusedGw };
    }
    for (const [gwId, reg] of streamRegistries.entries()) {
      if (gwId === focusedGw) continue;
      const sid = reg.getSessionIdForMessage(messageId);
      if (sid) return { sessionId: sid, gatewayId: gwId };
    }
    const fallbackSession = deps.getFallbackLiveStreamRegistry?.()?.getSessionIdForMessage(messageId);
    if (fallbackSession) return { sessionId: fallbackSession, gatewayId: focusedGw };
    return null;
  }

  function getConnectedClients(): Array<{ gatewayId: string; client: HermesGatewayClient }> {
    const summary = runtime.getHealthSummary();
    const out: Array<{ gatewayId: string; client: HermesGatewayClient }> = [];
    for (const s of summary.slots) {
      const slot = runtime.getSlot(s.gatewayId);
      if (slot && slot.connected) {
        out.push({ gatewayId: s.gatewayId, client: slot.client });
      }
    }
    return out;
  }

  function getGatewayUrl(gatewayId?: string): string {
    return resolveGatewayUrlFromRuntime(runtime, getState, gatewayId);
  }

  async function refreshSlotSlices(gatewayId: string): Promise<void> {
    const slot = runtime.getSlot(gatewayId);
    if (!slot || !slot.connected) return;
    const client = slot.client;

    const [profilesRes, groupsRes] = await Promise.allSettled([
      client.listProfiles(),
      slot.groupRoomStore.listRooms(client),
    ]);

    const patch: Partial<SlotSnapshotData> = {};
    const targetProfileNames = new Set<string>(['default']);
    if (profilesRes.status === 'fulfilled') {
      patch.profiles = profilesRes.value;
      for (const p of profilesRes.value) {
        if (p.name) targetProfileNames.add(p.name);
      }
    }
    if (groupsRes.status === 'fulfilled') {
      patch.groups = groupsRes.value
        .filter((r) => !r.isDisbanded)
        .map((r) => ({
          ...r,
          updatedAt: typeof r.updatedAt === 'number'
            ? (r.updatedAt > 1e11 ? r.updatedAt : r.updatedAt * 1000)
            : 0,
          createdAt: typeof r.createdAt === 'number'
            ? (r.createdAt > 1e11 ? r.createdAt : r.createdAt * 1000)
            : 0,
        }));
    }

    const sessionBatches = await Promise.allSettled(
      Array.from(targetProfileNames).map((pname) => client.listSessions(pname, 50)),
    );
    const collectedSessions: NormalizedSession[] = [];
    let anySessionsOk = false;
    for (const batch of sessionBatches) {
      if (batch.status === 'fulfilled' && batch.value.ok) {
        anySessionsOk = true;
        for (const s of batch.value.sessions) {
          if (!s.isArchived) collectedSessions.push(s);
        }
      }
    }
    if (anySessionsOk) {
      const deduped = new Map<string, NormalizedSession>();
      for (const s of collectedSessions) {
        deduped.set(`${normalizeOrgProfileName(s.botName)}::${s.id}`, s);
      }
      patch.sessions = Array.from(deduped.values());
    }

    if (patch.profiles !== undefined || patch.sessions !== undefined || patch.groups !== undefined) {
      runtime.setSlotSlice(gatewayId, patch);
    }
  }

  async function refreshAllSlots(): Promise<void> {
    const summary = runtime.getHealthSummary();
    await Promise.allSettled(
      summary.slots
        .filter((s) => s.connected)
        .map((s) => refreshSlotSlices(s.gatewayId)),
    );
    const st = getState();
    st.profilesPhase = 'ready';
    st.sessionsPhase = 'ready';
    syncPoolToState();
  }

  async function reconnectGateway(gatewayId: string): Promise<boolean> {
    const ok = await runtime.reconnectGateway(gatewayId);
    syncPoolToState();
    render();
    return ok;
  }

  function disconnectGateway(gatewayId: string): boolean {
    const ok = runtime.disconnectGateway(gatewayId, true);
    syncPoolToState();
    render();
    return ok;
  }

  function resolveActiveClient(fallbackClient: HermesGatewayClient | null = null): HermesGatewayClient | null {
    return resolveClient(resolveFocusedGatewayId(getState())) ?? fallbackClient;
  }

  function getActiveGatewayUrl(fallbackUrl = ''): string {
    return getGatewayUrl(resolveFocusedGatewayId(getState())) || fallbackUrl;
  }

  function getActiveHandleRegistry(): SessionHandleRegistry {
    return getHandleRegistry(resolveFocusedGatewayId(getState()));
  }

  async function refreshAllSlotsIfMulti(isConfigured?: () => boolean): Promise<boolean> {
    if ((getState().gatewayCount ?? 1) < 2 && !(isConfigured?.() ?? false)) {
      return false;
    }
    await refreshAllSlots();
    return true;
  }

  return {
    syncPoolToState,
    seedCachedSlicesFromState,
    refreshActiveOfflineState,
    getClientForGateway: resolveClient,
    resolveClient,
    resolveActiveClient,
    getActiveGatewayUrl,
    getHandleRegistry,
    getActiveHandleRegistry,
    getLiveStreamRegistry,
    resolveMessageOwner,
    getConnectedClients,
    getGatewayUrl,
    refreshSlotSlices,
    refreshAllSlots,
    refreshAllSlotsIfMulti,
    reconnectGateway,
    disconnectGateway,
    onManageGateways: deps.onManageGateways,
  };
}

/** 判断指定 sessionId 是否属于某 Bot（或任意 Bot）的 Forever Chat，兼容单/多网关复合键与跨网关冲突隔离。 */
export function matchesForeverChatSession(
  botForeverChatCache: ReadonlyMap<string, string>,
  sessionId: string,
  profile?: string,
  gatewayId?: string,
): boolean {
  if (!sessionId) return false;
  const norm = profile ? profile.trim().toLowerCase() : '';
  let sawScopedKey = false;
  for (const [k, v] of botForeverChatCache.entries()) {
    const colonIdx = k.indexOf(':');
    if (colonIdx > 0) {
      sawScopedKey = true;
      if (gatewayId && k.slice(0, colonIdx) !== gatewayId) continue;
      if (!norm || k.slice(colonIdx + 1).toLowerCase() === norm) {
        if (v === sessionId) return true;
      }
    }
  }
  if (gatewayId && sawScopedKey) return false;
  if (!norm) {
    for (const [k, v] of botForeverChatCache.entries()) {
      if (!k.includes(':') && v === sessionId) return true;
    }
    return false;
  }
  return botForeverChatCache.get(profile!) === sessionId || botForeverChatCache.get(norm) === sessionId;
}

/** 按当前焦点所属网关解析（必要时经 session.resume 激活）实时会话 liveId。 */
export async function resolveActiveLiveSessionId(deps: {
  readonly getState: () => Pick<
    AppState,
    'activeFocus' | 'activeGatewayId' | 'activeLiveSessionId' | 'activeSessionId' | 'gatewayCount' | 'sessions' | 'profileName'
  >;
  readonly resolveClient: (gatewayId?: string) => HermesGatewayClient | null;
  readonly sessionHandleRegistry: SessionHandleRegistry;
  readonly getHandleRegistry?: (gatewayId?: string) => SessionHandleRegistry;
  readonly getGeneration: () => number;
  readonly logSession?: Pick<FluxLogger, 'debug'> | GuardedRunLogger;
  readonly describeRpcError: (error: unknown) => string;
  readonly onCaptureInteractiveFence?: () => number;
  readonly onInteractiveResumeReconciled?: (input: {
    client: HermesGatewayClient;
    storedSessionId: string;
    liveSessionId: string | null;
    profile?: string;
    resume: Record<string, unknown>;
    fence: number;
  }) => void;
}): Promise<string> {
  const state = deps.getState();
  if (state.activeFocus.type === 'group') return '';
  if (state.activeLiveSessionId) return state.activeLiveSessionId;
  const activeGw = state.activeFocus.gatewayId || state.activeGatewayId;
  const client = deps.resolveClient(activeGw);
  if (!client || !state.activeSessionId) return '';
  const targetHandleRegistry = deps.getHandleRegistry ? deps.getHandleRegistry(activeGw) : deps.sessionHandleRegistry;
  const registered = deps.getHandleRegistry
    ? targetHandleRegistry.getRegisteredLiveId(state.activeSessionId)
    : (state.gatewayCount ?? 1) < 2 || !activeGw
      ? targetHandleRegistry.getRegisteredLiveId(state.activeSessionId)
      : '';
  if (registered) {
    state.activeLiveSessionId = registered;
    return registered;
  }
  const guard = { sessionId: state.activeSessionId, generation: deps.getGeneration() };
  try {
    const sess =
      state.sessions.find(
        (s) => s.id === guard.sessionId && (!activeGw || !s.gatewayId || s.gatewayId === activeGw),
      ) || state.sessions.find((s) => s.id === guard.sessionId);
    const prof =
      (state.activeFocus.type === 'bot' ? state.activeFocus.botName : sess?.botName) ||
      state.profileName ||
      'default';
    let res: Record<string, unknown> | null = null;
    const interactiveFence = deps.onCaptureInteractiveFence?.() ?? 0;
    try {
      res = await client.call<Record<string, unknown>>('session.resume', {
        session_id: guard.sessionId,
        profile: prof,
      });
    } catch (firstErr: unknown) {
      if (deps.describeRpcError(firstErr).includes('Extra inputs')) {
        res = await client.call<Record<string, unknown>>('session.resume', {
          session_id: guard.sessionId,
        });
      } else {
        throw firstErr;
      }
    }
    const parsed = readSessionHandles(res);
    if (res) {
      deps.onInteractiveResumeReconciled?.({
        client,
        storedSessionId: guard.sessionId,
        liveSessionId: parsed?.liveId ?? null,
        profile: prof,
        resume: res,
        fence: interactiveFence,
      });
    }
    if (parsed) {
      const handles = { liveId: parsed.liveId, storedId: guard.sessionId };
      targetHandleRegistry.register(handles);
      let liveId = '';
      await runGuarded(
        guard,
        () => ({ sessionId: deps.getState().activeSessionId, generation: deps.getGeneration() }),
        () => {
          deps.getState().activeLiveSessionId = handles.liveId;
          liveId = handles.liveId;
        },
        async () => undefined,
        deps.logSession,
      );
      return liveId;
    }
  } catch (e) {
    console.warn('[Flux] Failed to resolve live session id:', e);
  }
  return '';
}

/** 创建绑定静态依赖的实时会话 liveId 解析器，避免在组合根中包裹未执行的跨行对象字面量。 */
export function createActiveLiveSessionIdResolver(
  deps: Parameters<typeof resolveActiveLiveSessionId>[0],
): () => Promise<string> {
  return () => resolveActiveLiveSessionId(deps);
}

/** 为 `renderer/index.ts` 提供单行装配的多网关运行时+协调器组合根（冷启动零 TDZ，显式 bootstrap 启动）。 */
export function createDesktopMultiGatewayWiring(deps: {
  readonly getState: () => MultiGatewayCoordState;
  readonly getDesktopApi: () => HermesDesktopBridge | undefined;
  readonly render: () => void;
  readonly getFallbackClient?: () => HermesGatewayClient | null;
  readonly getFallbackHandleRegistry?: () => SessionHandleRegistry;
  readonly getFallbackLiveStreamRegistry?: () => LiveStreamRegistry;
  readonly getFallbackPassword?: () => string;
  readonly onManageGateways?: () => void;
  readonly onSlotEvent?: (gatewayId: string, params: unknown) => void;
  readonly onForwardActiveSlotEvent?: (params: unknown) => void;
  readonly onForwardSlotEvent?: (params: unknown, gatewayId?: string) => void;
  readonly onSlotServerRequest?: (
    gatewayId: string,
    request: IncomingServerRequest,
  ) => Promise<unknown> | unknown;
  readonly isLegacyClientConnected?: () => boolean;
  readonly onPrimaryClientChange?: (client: HermesGatewayClient | null) => void;
}): {
  readonly runtime: MultiGatewayRuntime;
  readonly coordinator: MultiGatewayCoordinator;
  bootstrap(): Promise<void>;
  isMultiGatewayConfigured(): boolean;
  wakeAllSlots(): Promise<ProbeOrWakeResult>;
} {
  let coordinatorRef: MultiGatewayCoordinator | null = null;
  let started = false;
  let bootstrapPromise: Promise<void> | null = null;
  const prevConnected = new Map<string, boolean>();
  const openConnectionSettings =
    deps.onManageGateways ??
    (() => {
      const st = deps.getState();
      if ('isSettingsOpen' in st) {
        (st as AppState).isSettingsOpen = true;
        (st as AppState).settingsSection = 'connection';
      }
      deps.render();
    });

  const runtime = createMultiGatewayRuntime({
    getDesktopApi: deps.getDesktopApi,
    resolvePassword: (cfg) => {
      const st = deps.getState();
      const fallbackPwd = deps.getFallbackPassword?.() ?? ('password' in st ? String((st as AppState).password || '') : '');
      return resolveGatewayPassword(cfg, deps.getDesktopApi(), fallbackPwd);
    },
    onSlotEvent: (gwId, params) => {
      deps.onSlotEvent?.(gwId, params);
      const st = deps.getState();
      const slotOrigin = normalizeGatewayOriginUrl(resolveGatewayUrlFromRuntime(runtime, deps.getState, gwId));
      const legacyOrigin = normalizeGatewayOriginUrl(st.gatewayUrl || '');
      const legacySameOriginActive = Boolean(
        deps.isLegacyClientConnected?.() && slotOrigin && legacyOrigin && slotOrigin === legacyOrigin,
      );
      if (deps.onForwardSlotEvent) {
        if (!legacySameOriginActive) {
          deps.onForwardSlotEvent(params, gwId);
        }
        return;
      }
      if (deps.onForwardActiveSlotEvent) {
        const activeGw = st.activeFocus?.gatewayId || st.activeGatewayId;
        const slotUrl = resolveGatewayUrlFromRuntime(runtime, deps.getState, gwId).replace(/\/+$/, '').toLowerCase();
        const legacyUrl = (st.gatewayUrl || '').replace(/\/+$/, '').toLowerCase();
        if (activeGw && activeGw === gwId && slotUrl !== legacyUrl) {
          deps.onForwardActiveSlotEvent(params);
        }
      }
    },
    onSlotServerRequest: deps.onSlotServerRequest,
    onHealthChange: (summary) => {
      if (!started) return;
      for (const slot of summary.slots) {
        const wasConnected = prevConnected.get(slot.gatewayId) ?? false;
        prevConnected.set(slot.gatewayId, slot.connected);
        if (!wasConnected && slot.connected) {
          void coordinatorRef?.refreshSlotSlices(slot.gatewayId);
        }
      }
      coordinatorRef?.syncPoolToState();
      if (isMultiGatewayConfigured()) {
        deps.onPrimaryClientChange?.(runtime.getClient());
      }
      deps.render();
    },
    onSlicesUpdated: () => {
      if (!started) return;
      coordinatorRef?.syncPoolToState();
      deps.render();
    },
  });

  const coordinator = createMultiGatewayCoordinator({
    runtime,
    getState: deps.getState,
    render: deps.render,
    getFallbackClient: deps.getFallbackClient,
    getFallbackHandleRegistry: deps.getFallbackHandleRegistry,
    getFallbackLiveStreamRegistry: deps.getFallbackLiveStreamRegistry,
    onManageGateways: openConnectionSettings,
  });
  coordinatorRef = coordinator;

  function isMultiGatewayConfigured(): boolean {
    return loadGatewayConfigs().length >= 2;
  }

  async function bootstrap(): Promise<void> {
    if (bootstrapPromise) return bootstrapPromise;
    bootstrapPromise = (async () => {
      started = true;
      const configured = loadGatewayConfigs();
      await migrateLegacyGatewaySecrets(configured, deps.getDesktopApi());
      if (configured.length >= 2) {
        runtime.syncGateways(configured);
        coordinator.seedCachedSlicesFromState();
        await runtime.connectAll();
        const st = deps.getState();
        st.profilesPhase = 'ready';
        st.sessionsPhase = 'ready';
        coordinator.syncPoolToState();
        deps.onPrimaryClientChange?.(runtime.getClient());
        deps.render();
      }
    })();
    try {
      await bootstrapPromise;
    } finally {
      bootstrapPromise = null;
    }
  }

  async function wakeAllSlots(): Promise<ProbeOrWakeResult> {
    const before = runtime.getHealthSummary();
    const offlineSlots = before.slots.filter((s) => !s.connected);
    await Promise.allSettled(
      offlineSlots.map((s) => runtime.reconnectGateway(s.gatewayId)),
    );
    coordinator.syncPoolToState();
    deps.render();
    const after = runtime.getHealthSummary();
    if (after.onlineCount === 0) return 'disconnected';
    if (offlineSlots.length > 0 && after.onlineCount < after.totalCount) return 'reconnecting';
    return 'alive';
  }

  return { runtime, coordinator, bootstrap, isMultiGatewayConfigured, wakeAllSlots };
}

/** 读取已配置的多网关 ID 列表（供冷启动缓存恢复与分桶持久化复用）。 */
export function getConfiguredGatewayIds(): string[] {
  return loadGatewayConfigs().map((g) => g.id);
}

/** 提取当前激活实体或会话对应的目标网关 ID。 */
export function resolveFocusedGatewayId(
  state: Pick<AppState, 'activeGatewayId'> & { activeFocus?: Pick<AppState['activeFocus'], 'gatewayId'> | null },
): string | undefined {
  return state.activeFocus?.gatewayId || state.activeGatewayId;
}

/** 判定目标 sessionId + gatewayId 是否命中当前用户正在聚焦的前台会话。 */
export function isFocusedGatewaySession(
  state: Pick<AppState, 'activeSessionId' | 'activeGatewayId'> & { activeFocus?: Pick<AppState['activeFocus'], 'gatewayId'> | null },
  sessionId: string,
  gatewayId?: string,
): boolean {
  if (!sessionId || state.activeSessionId !== sessionId) return false;
  const focusedGw = resolveFocusedGatewayId(state);
  return !gatewayId || !focusedGw || gatewayId === focusedGw;
}

/** 通过动态解析的活跃客户端发起底层 RPC 请求。 */
export function requestActiveGatewayRpc<TResult = unknown, TParams = unknown>(
  resolveClient: () => HermesGatewayClient | null,
  method: string,
  params?: TParams,
  timeoutMs?: number,
): Promise<TResult> {
  const client = resolveClient();
  if (!client) return Promise.reject(new Error('Gateway client not connected'));
  return client.call<TResult>(method, params, timeoutMs);
}

/** 构建委托给动态活跃客户端的 IRpcCaller 适配器。 */
export function createActiveGatewayRpcCaller(resolveClient: () => HermesGatewayClient | null): IRpcCaller {
  return {
    request: <TResult = unknown, TParams = unknown>(
      method: string,
      params?: TParams,
      timeoutMs?: number,
    ): Promise<TResult> => requestActiveGatewayRpc<TResult, TParams>(resolveClient, method, params, timeoutMs),
  };
}

/** 将网关侧实时短 ID 按当前焦点网关句柄表归一化为持久化会话 ID。 */
export function resolveGatewayScopedStoredSessionId(input: {
  id: string | null | undefined;
  state: Pick<
    AppState,
    'sessions' | 'gatewayCount' | 'activeFocus' | 'activeGatewayId' | 'activeLiveSessionId' | 'activeSessionId'
  >;
  coordinator: Pick<MultiGatewayCoordinator, 'getHandleRegistry'>;
  activeStreamingLiveId: string | null;
  activeStreamingStoredSessionId: string | null;
}): string | null {
  const { id, state, coordinator, activeStreamingLiveId, activeStreamingStoredSessionId } = input;
  if (!id) return null;
  const activeGw = resolveFocusedGatewayId(state);
  const known = state.sessions
    .filter((s) => !activeGw || (state.gatewayCount ?? 1) < 2 || !s.gatewayId || s.gatewayId === activeGw)
    .map((s) => s.id);
  const resolved = coordinator.getHandleRegistry(activeGw).toStoredId(id, known);
  if (resolved && resolved !== id) return resolved;
  if (activeStreamingLiveId && id === activeStreamingLiveId && activeStreamingStoredSessionId) {
    return activeStreamingStoredSessionId;
  }
  if (state.activeLiveSessionId && id === state.activeLiveSessionId && state.activeSessionId) {
    return state.activeSessionId;
  }
  return id;
}

/** 按当前焦点网关（及单机兜底表）反查流式消息所属会话 ID。 */
export function resolveMessageSessionIdAcrossRegistries(
  messageId: string,
  state: Pick<AppState, 'activeFocus' | 'activeGatewayId'>,
  coordinator: Pick<MultiGatewayCoordinator, 'getLiveStreamRegistry'>,
  fallbackRegistry: LiveStreamRegistry,
): string | null {
  return (
    coordinator.getLiveStreamRegistry(resolveFocusedGatewayId(state))?.getSessionIdForMessage(messageId) ??
    fallbackRegistry.getSessionIdForMessage(messageId)
  );
}

/** 渲染聚焦或同源多网关缓存中的工具胶囊插槽。 */
export function renderToolPatchForMessage(
  messageId: string,
  state: Pick<AppState, 'messages' | 'activeFocus' | 'activeGatewayId' | 'gatewayCount'>,
  activeStreamingStoredSessionId: string | null,
  sessionMessagesCache: ReadonlyMap<string, MessageViewModel[]>,
  renderSlot: (msg: MessageViewModel) => string = renderToolCapsuleSlot,
): string {
  const activeGw = resolveFocusedGatewayId(state);
  const activeCacheKey = activeStreamingStoredSessionId
    ? resolveScopedEntityRuntimeKey(activeStreamingStoredSessionId, activeGw, state.gatewayCount)
    : '';
  const msg =
    state.messages.find((m) => m.id === messageId) ||
    (activeCacheKey ? sessionMessagesCache.get(activeCacheKey)?.find((m) => m.id === messageId) : undefined);
  return msg ? renderSlot(msg) : '';
}

/** 创建冷启动默认焦点裁剪执行器（支持多网关路由并保证三域就绪前不封存）。 */
export function createColdStartFocusRunner(deps: {
  readonly getState: () => Pick<
    AppState,
    'activeFocus' | 'profilesPhase' | 'gatewayUrl' | 'gatewayCount' | 'gatewayConnected' | 'profileName' | 'profiles' | 'sessions'
  >;
  readonly resolveActiveClient: () => HermesGatewayClient | null;
  readonly getEffectiveUrl: (url: string) => string;
  readonly selectSession: (id: string, opts?: { gatewayId?: string }) => Promise<void>;
  readonly openBotChat: (botName: string, gatewayId?: string) => Promise<void>;
  readonly getStorageItem?: (key: string) => string | null;
}): { applyColdStartFocus(): Promise<void>; cancelColdStartFocus(): void } {
  let coldStartFocusPending = true;
  let coldStartFocusApplied = false;
  const { resolveActiveClient, getEffectiveUrl } = deps;
  const readStorage = deps.getStorageItem ?? ((key: string) => (typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null));
  function cancelColdStartFocus(): void { coldStartFocusPending = false; }

  async function applyColdStartFocus(): Promise<void> {
    const state = deps.getState();
    if (!coldStartFocusPending || coldStartFocusApplied) return;
    if (state.activeFocus.type === 'group') return;
    if (state.profilesPhase !== 'ready') return;
    if (!resolveActiveClient() || (!getEffectiveUrl(state.gatewayUrl) && (state.gatewayCount ?? 1) < 2) || !state.gatewayConnected) return;
    const storedProfileName = readStorage('hermes_flux_profile') || readStorage('hermes_aura_profile') || (state.profileName !== 'default' ? state.profileName : undefined);
    const target = resolveColdStartFocus({
      profiles: state.profiles,
      sessions: state.sessions,
      savedProfileName: storedProfileName,
    });
    if (target.kind === 'none') return;
    coldStartFocusApplied = true;
    if (target.kind === 'session') {
      const matched = state.sessions.find((s) => s.id === target.sessionId);
      await deps.selectSession(target.sessionId, matched?.gatewayId ? { gatewayId: matched.gatewayId } : undefined);
      return;
    }
    const matchedBot = state.profiles.find((p) => p.name === target.botName);
    await deps.openBotChat(target.botName, matchedBot?.gatewayId);
  }

  return { applyColdStartFocus, cancelColdStartFocus };
}

/** 创建模型目录拉取器，失连或失败时必须清空陈旧目录与指纹。 */
export function createModelCatalogFetcher(deps: {
  readonly getState: () => Pick<
    AppState,
    'profileName' | 'availableModels' | 'modelDetails' | 'modelCatalog' | 'modelCatalogHash' | 'currentProvider' | 'selectedModel' | 'dockNotice'
  >;
  readonly resolveActiveClient: () => HermesGatewayClient | null;
  readonly render: () => void;
  readonly t: (key: I18nKey) => string;
}): (options?: { clearNotice?: boolean }) => Promise<void> {
  return async function fetchModelOptions(options: { clearNotice?: boolean } = {}): Promise<void> {
    const state = deps.getState();
    const client = deps.resolveActiveClient();
    if (!client) {
      state.availableModels = [];
      state.modelDetails = [];
      state.modelCatalog = [];
      state.modelCatalogHash = '';
      state.dockNotice = deps.t('chat.gatewayNotConnected');
      deps.render();
      return;
    }
    const catalog = await client.getModelCatalog(state.profileName || 'default');
    if (!catalog.ok) {
      state.availableModels = [];
      state.modelDetails = [];
      state.modelCatalog = [];
      state.modelCatalogHash = '';
      state.dockNotice = catalog.error || deps.t('chat.gatewayNotConnected');
      deps.render();
      return;
    }
    state.availableModels = catalog.models;
    state.modelDetails = catalog.details;
    state.modelCatalog = catalog.entries;
    state.modelCatalogHash = modelCatalogFingerprint(catalog.entries);
    state.currentProvider = catalog.currentProvider;
    if (catalog.currentModel) state.selectedModel = catalog.currentModel;
    else if (!state.selectedModel && catalog.models.length > 0) state.selectedModel = catalog.models[0];
    if (options.clearNotice !== false) state.dockNotice = '';
    deps.render();
  };
}

/** 解析会话/群聊进入视口阶段：强贴底或无活跃客户端时直接 ready，其余先进入 loading 等待权威页。 */
export function resolveSessionEnterPhase(
  forcePinToBottom: boolean | undefined,
  hasActiveClient: boolean,
): 'loading' | 'ready' {
  return forcePinToBottom ? 'ready' : hasActiveClient ? 'loading' : 'ready';
}

/** 创建冷启动/休眠恢复期单双模网关生命周期编排适配器。 */
export function createAppBootstrapGatewayHandlers(deps: {
  readonly multiGateway: {
    isMultiGatewayConfigured(): boolean;
    bootstrap(): Promise<void>;
    wakeAllSlots(): Promise<ProbeOrWakeResult | void>;
  };
  readonly connectLegacy: () => Promise<void> | void;
  readonly wakeLegacy: (reason: string) => Promise<ProbeOrWakeResult>;
  readonly syncOnConnected: () => Promise<void> | void;
  readonly syncOnResumeAlive: () => Promise<void> | void;
}): {
  connect(): void;
  onWakeOrRetry(reason: string): Promise<ProbeOrWakeResult>;
  onSettingsConnect(): Promise<void>;
  bootstrapPostInit(): void;
} {
  return {
    connect(): void {
      if (deps.multiGateway.isMultiGatewayConfigured()) {
        void deps.multiGateway.bootstrap().then(() => deps.syncOnConnected());
        return;
      }
      void deps.connectLegacy();
    },
    async onWakeOrRetry(reason: string): Promise<ProbeOrWakeResult> {
      if (deps.multiGateway.isMultiGatewayConfigured()) {
        const res = (await deps.multiGateway.wakeAllSlots()) ?? 'alive';
        if (res !== 'disconnected') {
          await deps.syncOnResumeAlive();
        }
        return res;
      }
      return deps.wakeLegacy(reason);
    },
    async onSettingsConnect(): Promise<void> {
      if (deps.multiGateway.isMultiGatewayConfigured()) {
        await deps.multiGateway.bootstrap();
        return;
      }
      await deps.connectLegacy();
    },
    bootstrapPostInit(): void {
      if (!deps.multiGateway.isMultiGatewayConfigured()) {
        void deps.multiGateway.bootstrap();
      }
    },
  };
}
