/**
 * Hermes Flux 数字员工与 Profile 管理服务（Profile Management Service）
 *
 * 【设计意图 (Why)】
 *   将 Agent Profile 列表拉取、定时静默轮询、头像资产多级缓存与持久化、
 *   Bot 终身主工位（Forever Chat）并发预热、主工位 0ms 秒开切换（openBotChat）、
 *   以及全局 Profile 切换彻底从 index.ts 中解耦。
 *   使数字员工领域模型与主工位状态机脱离 DOM 运行，具备可单测性与单向依赖纯度。
 *
 * 【防范的历史坑 (Pitfall)】
 *   1. 主工位预取时序：主工位预取（warmBotForeverChats）必须与头像拉取并行启动，
 *      任意一个头像请求慢或挂起绝不能阻塞 Forever Chat 缓存，否则首次点击 Agent 会掉回冷路径；
 *   2. 头像缓存与预取陷阱：严禁把预取放在头像缓存早退之后，否则第二次启动起预取被跳过；
 *   3. 终身主工位 0ms 瞬间秒开：内存缓存持有 Forever Chat ID 时瞬间切入；冷路径探查前必须先清空视口
 *      并置 messagesPhase = 'loading'，避免出现"新 Bot 标题 + 旧会话内容"闪烁并置；
 *   4. openBotChat 失败回退：冷路径解析失败时必须完整回退至进入前的焦点与 Profile，
 *      绝不能将用户困在空白工位或导致侧边栏选中错配；
 *   5. runGuarded 代际守卫：在异步拉取期间若用户已切换到其他 Bot 或会话，坚决丢弃迟到响应。
 *
 * 【约束与规则 (Rules)】
 *   1. 单向依赖：严禁反向 import index.js，所有外部状态读写与 UI 渲染通过 ProfileManagementDeps 注入；
 *   2. 严格类型约束：0 TS 报错，严禁使用 `as any`；
 *   3. 零文本写死：通知、错误提示通过 deps.t 国际化输出。
 */

import {
  resolveScopedBotRuntimeKey,
  resolveScopedEntityRuntimeKey,
  type AppState,
} from '../state/appState.js';
import {
  type HermesGatewayClient,
  type AgentProfile,
  type FluxLogger,
  type GuardedRunLogger,
  type SessionHandleRegistry,
  ProfileService,
  applyEnteredRead,
  runGuarded,
} from '@hermes-flux/core';
import type { I18nKey, MessageViewModel } from '@hermes-flux/ui';
import { profilesDiffer } from '../profileRefresh.js';
import type { BotActivityStore } from '../persistence/botActivityStore.js';

export type ProfileAnchorCapturer = () => unknown;

export interface ProfileManagementDeps {
  readonly getState: () => AppState;
  readonly getGatewayClient: () => HermesGatewayClient | null;
  readonly getClientForGateway?: (gatewayId?: string) => HermesGatewayClient | null;
  readonly getSessionHandleRegistryForGateway?: (gatewayId?: string) => SessionHandleRegistry;
  readonly onActiveFocusChanged?: () => void;
  readonly render: () => void;
  readonly t: (key: I18nKey, params?: Record<string, string | number>) => string;
  readonly describeRpcError: (error: unknown) => string;
  readonly botActivityStore: BotActivityStore;
  readonly unreadBotNames: Set<string>;
  readonly activityTransitionTracker: { clear(type: 'bot' | 'group' | 'session', id: string): void };
  readonly sessionMessagesCache: Map<string, MessageViewModel[]>;
  readonly syncProfileLastMessages: () => void;
  readonly applyColdStartFocus: () => Promise<void>;
  readonly cancelColdStartFocus: () => void;
  readonly fetchSessions: () => Promise<void>;
  readonly fetchModelOptions: (options?: { clearNotice?: boolean }) => Promise<void>;
  readonly selectSession: (sessionId: string, options?: { preserveFocus?: boolean; botName?: string; gatewayId?: string }) => Promise<void>;
  readonly openGroupRoom: (roomId: string, gatewayId?: string) => Promise<void>;
  readonly restoreComposerFocus: () => void;
  readonly disarmRollbackOnLeave: () => void;
  readonly persistAgentsToCache: (profiles: AgentProfile[]) => void;
  readonly persistAvatarCache: () => void;
  readonly profileAvatarCache?: Map<string, string>;
  readonly botForeverChatCache?: Map<string, string>;
  readonly nextLoadMessagesGeneration: () => number;
  readonly getCurrentLoadMessagesGeneration: () => number;
  readonly onProfilesFetched?: (profiles: AgentProfile[]) => void;
  readonly logSession?: Pick<FluxLogger, 'debug'> | GuardedRunLogger;
  readonly setPendingScrollToBottom?: (pending: boolean) => void;
  readonly onMultiGatewayRefresh?: () => Promise<void>;
  captureStreamAnchor?: ProfileAnchorCapturer;
}

export interface ProfileManagementService {
  readonly botForeverChatCache: Map<string, string>;
  readonly profileAvatarCache: Map<string, string>;
  syncSessionBotDisplayNames(profiles: AgentProfile[]): void;
  fetchProfiles(options?: { refresh?: boolean }): Promise<void>;
  warmBotForeverChats(list: AgentProfile[], client: HermesGatewayClient | null): Promise<void>;
  startProfileAutoRefresh(): void;
  stopProfileAutoRefresh(): void;
  refreshProfilesFromServer(): Promise<void>;
  switchProfile(name: string): Promise<void>;
  openBotChat(botProfile: string, gatewayId?: string): Promise<void>;
}

export function createProfileManagementService(deps: ProfileManagementDeps): ProfileManagementService {
  const profileServicesByGateway = new Map<string, ProfileService>();
  const resolveProfileService = (gatewayId?: string): ProfileService => {
    const key = gatewayId || '';
    let svc = profileServicesByGateway.get(key);
    if (!svc) {
      svc = new ProfileService({
        handleRegistry: deps.getSessionHandleRegistryForGateway?.(gatewayId),
      });
      profileServicesByGateway.set(key, svc);
    }
    return svc;
  };
  const botForeverChatCache = deps.botForeverChatCache ?? new Map<string, string>();
  const profileAvatarCache = deps.profileAvatarCache ?? new Map<string, string>();

  const avatarCacheKey = (name: string, gatewayId?: string): string => {
    const clean = name.trim().toLowerCase();
    return gatewayId ? `${gatewayId}:${clean}` : clean;
  };
  const readCachedAvatar = (name?: string, gatewayId?: string): string | undefined => {
    if (!name) return undefined;
    if (gatewayId) {
      const scoped = profileAvatarCache.get(avatarCacheKey(name, gatewayId));
      if (scoped) return scoped;
      if ((deps.getState().gatewayCount ?? 1) >= 2) return undefined;
    }
    return profileAvatarCache.get(name.trim().toLowerCase());
  };
  const writeCachedAvatar = (p: Pick<AgentProfile, 'name' | 'displayName'>, url: string, gatewayId?: string): void => {
    profileAvatarCache.set(avatarCacheKey(p.name, gatewayId), url);
    if (p.displayName) profileAvatarCache.set(avatarCacheKey(p.displayName, gatewayId), url);
  };

  const PROFILE_REFRESH_INTERVAL_MS = 60_000;
  const PROFILE_REFRESH_MIN_GAP_MS = 15_000;
  let profileAutoRefreshTimer: ReturnType<typeof setInterval> | null = null;
  let lastProfileRefreshAt = 0;
  let profileRefreshInFlight = false;
  let profileFetchGeneration = 0;

  function syncSessionBotDisplayNames(profiles: AgentProfile[]): void {
    const state = deps.getState();
    for (const s of state.sessions) {
      if (!s.botName) continue;
      const needle = s.botName.toLowerCase();
      const profile = profiles.find(
        (p) => p.name.toLowerCase() === needle && (!s.gatewayId || !p.gatewayId || p.gatewayId === s.gatewayId),
      );
      if (profile && s.botDisplayName !== profile.displayName) {
        s.botDisplayName = profile.displayName;
      }
    }
  }

  async function fetchProfiles(options: { refresh?: boolean } = {}): Promise<void> {
    const state = deps.getState();
    const multiRefresh = (state.gatewayCount ?? 1) >= 2 ? deps.onMultiGatewayRefresh : undefined;
    const client = deps.getGatewayClient();
    if (!multiRefresh && !client) return;
    const generation = ++profileFetchGeneration;
    try {
      const prevProfiles = state.profiles;
      let list: AgentProfile[];
      if (multiRefresh) {
        await multiRefresh();
        if (generation !== profileFetchGeneration) return;
        list = deps.getState().profiles;
      } else {
        // !multiRefresh && !client 已提前 return，此处 client 类型非空
        list = await client!.listProfiles();
        if (generation !== profileFetchGeneration) return;
      }

      // 1. 命中持久缓存，0ms 秒开回填头像资产
      for (const p of list) {
        if (!p.avatar) {
          const gw = p.gatewayId || state.activeGatewayId;
          const cached = readCachedAvatar(p.name, gw) || (p.displayName ? readCachedAvatar(p.displayName, gw) : undefined);
          if (cached) p.avatar = cached;
        }
      }

      // 无论展示字段是否变化，先向会话组织协同器同步 ui_meta（文件夹 / 已完成群聊）
      deps.onProfilesFetched?.(list);

      // 定时/聚焦刷新：关键展示字段完全一致时直接返回，不产生 render、资产拉取与预取。
      if (options.refresh && !profilesDiffer(prevProfiles, list)) return;
      const profileTopologyChanged = options.refresh && (
        prevProfiles.length !== list.length
        || list.some((p) => !prevProfiles.some((old) => old.name === p.name && old.gatewayId === p.gatewayId))
      );

      state.profiles = list;
      // 数据已到达（含空列表）：无论内容如何都必须离开骨架相位，否则永久假加载。
      state.profilesPhase = 'ready';
      deps.persistAgentsToCache(list);
      syncSessionBotDisplayNames(list);
      deps.syncProfileLastMessages();
      deps.render();
      void deps.applyColdStartFocus();

      // 2. 已有头像只回填内存缓存；缺失的才向网关拉取 (profiles.get_asset)。
      for (const p of list) {
        if (!p.avatar) continue;
        writeCachedAvatar(p, p.avatar, p.gatewayId || state.activeGatewayId);
      }

      // 主工位预取必须与头像拉取并行启动：任意一个头像请求慢/挂起，都不能阻塞 Forever Chat 缓存
      void warmBotForeverChats(list, client);
      await Promise.allSettled(
        list.filter((p) => !p.avatar).map(async (p) => {
          if (generation !== profileFetchGeneration) return;
          const targetGw = p.gatewayId || state.activeGatewayId;
          const targetClient = (deps.getClientForGateway ? deps.getClientForGateway(targetGw) : null) ?? client;
          if (!targetClient) return;
          try {
            const assetBase64 = await resolveProfileService(targetGw).getAsset(p.name, 'avatar', targetClient);
            if (generation !== profileFetchGeneration) return;
            if (assetBase64) {
              const finalUrl = assetBase64.startsWith('data:')
                ? assetBase64
                : `data:image/png;base64,${assetBase64}`;
              p.avatar = finalUrl;
              writeCachedAvatar(p, finalUrl, targetGw);
              deps.persistAvatarCache();

              // 同步将真实头像回填到会话列表中对应 Bot 的所有会话项，彻底消除占位图腾
              for (const s of state.sessions) {
                if (
                  (!targetGw || !s.gatewayId || s.gatewayId === targetGw) &&
                  (s.botName === p.name || (s.botDisplayName && s.botDisplayName === p.displayName))
                ) {
                  s.botAvatar = finalUrl;
                }
              }
              deps.render();
            }
          } catch (e) {
            console.warn(`[Flux] profiles.get_asset failed for ${p.name}:`, e);
          }
        }),
      );

      if (profileTopologyChanged) void deps.fetchSessions();
    } catch (e) {
      console.warn('[Flux] fetchProfiles failed:', e);
      state.profilesPhase = 'ready';
      void deps.applyColdStartFocus();
      deps.render();
    }
  }

  async function warmBotForeverChats(
    list: AgentProfile[],
    client: HermesGatewayClient | null,
  ): Promise<void> {
    const queue = [...list];
    const worker = async (): Promise<void> => {
      for (;;) {
        const p = queue.shift();
        if (!p) return;
        const state = deps.getState();
        const targetGw = p.gatewayId || state.activeGatewayId;
        const cacheKey = resolveScopedBotRuntimeKey(p.name, targetGw, state.gatewayCount);
        if (botForeverChatCache.has(cacheKey)) continue;
        const targetClient = (deps.getClientForGateway ? deps.getClientForGateway(targetGw) : null) ?? client;
        if (!targetClient) continue;
        try {
          const forever = await resolveProfileService(targetGw).getOrCreateForeverChat(p.name, targetClient);
          if (!forever?.sessionId) continue;
          botForeverChatCache.set(cacheKey, forever.sessionId);
          const histRes = await targetClient.fetchSessionMessages(forever.sessionId, { limit: 1, offset: 0, order: 'latest', profile: p.name });
          if (histRes.status === 'success' && histRes.messages.length > 0) {
            const last = histRes.messages[0];
            const parts = Array.isArray(last.parts) ? (last.parts as Array<{ type?: string; text?: string }>) : [];
            const textPart = parts.find((pt) => pt.type === 'text');
            const previewText = textPart?.text || (typeof last.content === 'string' ? last.content : '');
            const ts = last.created_at || last.timestamp;
            const numTs = typeof ts === 'number' ? (ts > 1e11 ? ts : ts * 1000) : typeof ts === 'string' ? Date.parse(ts) || Date.now() : Date.now();
            deps.botActivityStore.updateLatestActivity(p.name, previewText, numTs, targetGw);
            deps.render();
          }
        // gate-degrade: 单条主工位探测失败按跳过处理，不影响其余 Bot 资产渲染
        } catch {
          // 容错放行
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, queue.length) }, () => worker()));
  }

  function stopProfileAutoRefresh(): void {
    if (profileAutoRefreshTimer) {
      clearInterval(profileAutoRefreshTimer);
      profileAutoRefreshTimer = null;
    }
  }

  function startProfileAutoRefresh(): void {
    stopProfileAutoRefresh();
    profileAutoRefreshTimer = setInterval(() => { void refreshProfilesFromServer(); }, PROFILE_REFRESH_INTERVAL_MS);
  }

  async function refreshProfilesFromServer(): Promise<void> {
    const client = deps.getGatewayClient();
    const state = deps.getState();
    if ((!client && (state.gatewayCount ?? 1) < 2) || !state.gatewayConnected || profileRefreshInFlight) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    const now = Date.now();
    if (now - lastProfileRefreshAt < PROFILE_REFRESH_MIN_GAP_MS) return;
    lastProfileRefreshAt = now;
    profileRefreshInFlight = true;
    try {
      await fetchProfiles({ refresh: true });
    // gate-degrade: 定时刷新失败保持现状，下一轮继续；连接态由 FSM 负责。
    } catch {
      // 定时刷新失败保持现状，下一轮继续；连接态由 FSM 负责。
    } finally {
      profileRefreshInFlight = false;
    }
  }

  async function switchProfile(name: string): Promise<void> {
    const state = deps.getState();
    if (!name || state.profileName === name) return;
    state.profileName = name;
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('hermes_flux_profile', name);
      localStorage.setItem('hermes_aura_profile', name);
    }
    deps.render();
    await Promise.allSettled([deps.fetchSessions(), deps.fetchModelOptions()]);
  }

  async function openBotChat(botProfile: string, gatewayId?: string): Promise<void> {
    if (!botProfile) return;
    deps.cancelColdStartFocus();

    const state = deps.getState();
    const matchedProfile =
      state.profiles.find(
        (p) => p.name === botProfile && (!gatewayId || !p.gatewayId || p.gatewayId === gatewayId),
      ) ?? state.profiles.find((p) => p.name === botProfile);
    const targetGw = gatewayId || matchedProfile?.gatewayId || state.activeGatewayId;
    const client = deps.getClientForGateway ? deps.getClientForGateway(targetGw) : deps.getGatewayClient();
    const outgoingFocus = state.activeFocus;
    const outgoingSessionId = state.activeSessionId;
    const outgoingGw = outgoingFocus?.gatewayId || state.activeGatewayId;
    if (outgoingSessionId) {
      deps.captureStreamAnchor?.();
    }
    const outgoingProfileName = state.profileName;
    const wasBotFocused =
      state.activeFocus.type === 'bot' &&
      state.activeFocus.botName === botProfile &&
      (!targetGw || !state.activeFocus.gatewayId || state.activeFocus.gatewayId === targetGw);

    state.profileName = botProfile;
    state.activeGatewayId = targetGw;
    deps.disarmRollbackOnLeave();
    state.activeFocus = targetGw ? { type: 'bot', botName: botProfile, gatewayId: targetGw } : { type: 'bot', botName: botProfile };
    deps.onActiveFocusChanged?.();
    const generation = deps.nextLoadMessagesGeneration();
    const guard = { sessionId: `bot:${targetGw || ''}::${botProfile}`, generation };
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('hermes_flux_profile', botProfile);
      localStorage.setItem('hermes_aura_profile', botProfile);
    }

    const botCacheKey = resolveScopedBotRuntimeKey(botProfile, targetGw, state.gatewayCount);
    applyEnteredRead(deps.unreadBotNames, botCacheKey);
    deps.activityTransitionTracker.clear('bot', botCacheKey);

    // 1. 若内存缓存已持有该 Bot（按 gatewayId 隔离）的 Forever Chat ID，0ms 瞬间秒开切入！
    const cachedSessionId = botForeverChatCache.get(botCacheKey);
    if (cachedSessionId) {
      const alreadyMounted = state.activeSessionId === cachedSessionId
        && Boolean(state.activeLiveSessionId)
        && state.messages.length > 0;
      void deps.selectSession(cachedSessionId, { preserveFocus: true, botName: botProfile, gatewayId: targetGw });
      void deps.fetchModelOptions({ clearNotice: true });
      if (alreadyMounted) {
        if (wasBotFocused) deps.restoreComposerFocus();
        deps.render();
      }
      return;
    }

    // 离线容错：缓存未命中且网关离线时仍允许更新焦点并加载本地持久主工位，等重连后再补拉权威会话
    if (!client) {
      const localForever = state.sessions.find(
        (s) => s.hidden && s.botName === botProfile && (!targetGw || !s.gatewayId || s.gatewayId === targetGw),
      );
      if (localForever) {
        void deps.selectSession(localForever.id, { preserveFocus: true, botName: botProfile, gatewayId: targetGw });
        return;
      }
      if (outgoingSessionId && state.messages.length > 0) {
        const outCacheKey = resolveScopedEntityRuntimeKey(outgoingSessionId, outgoingGw, state.gatewayCount);
        deps.sessionMessagesCache.set(outCacheKey, [...state.messages]);
      }
      state.messages = [];
      state.hasOlderMessages = false;
      state.isLoadingOlder = false;
      state.activeSessionId = '';
      state.activeLiveSessionId = '';
      state.messagesPhase = 'ready';
      deps.render();
      return;
    }

    // 2. 首次探查前清空视口并进入 loading
    if (outgoingSessionId && state.messages.length > 0) {
      const outCacheKey = resolveScopedEntityRuntimeKey(outgoingSessionId, outgoingGw, state.gatewayCount);
      deps.sessionMessagesCache.set(outCacheKey, [...state.messages]);
    }
    state.messages = [];
    state.hasOlderMessages = false;
    state.isLoadingOlder = false;
    state.activeSessionId = '';
    state.activeLiveSessionId = '';
    state.messagesPhase = 'loading';
    // 【规则】冷路径只声明 loading，不再预置「待贴底」：真正的视口裁决发生在
    // 解析出 foreverChat.sessionId 后由 selectSession 的进入计划统一给出。
    deps.render();

    try {
      const guarded = await runGuarded(
        guard,
        () => ({
          sessionId: `bot:${(state.activeFocus.gatewayId || state.activeGatewayId || '')}::${state.activeFocus.type === 'bot' ? state.activeFocus.botName : ''}`,
          generation: deps.getCurrentLoadMessagesGeneration(),
        }),
        () => undefined,
        () => resolveProfileService(targetGw).getOrCreateForeverChat(botProfile, client),
        deps.logSession,
      );
      if (guarded.status === 'discarded') return;
      const foreverChat = guarded.value;
      botForeverChatCache.set(botCacheKey, foreverChat.sessionId);

      state.activeGatewayId = targetGw;
      state.activeFocus = targetGw ? { type: 'bot', botName: botProfile, gatewayId: targetGw } : { type: 'bot', botName: botProfile };
      deps.onActiveFocusChanged?.();
      await deps.selectSession(foreverChat.sessionId, { preserveFocus: true, botName: botProfile, gatewayId: targetGw });
      if (
        state.activeFocus.type !== 'bot' ||
        state.activeFocus.botName !== botProfile ||
        (targetGw && state.activeFocus.gatewayId && state.activeFocus.gatewayId !== targetGw)
      ) {
        return;
      }
      state.activeGatewayId = targetGw;
      state.activeFocus = targetGw ? { type: 'bot', botName: botProfile, gatewayId: targetGw } : { type: 'bot', botName: botProfile };
      deps.render();
    } catch (err) {
      if (
        deps.getCurrentLoadMessagesGeneration() !== guard.generation ||
        state.activeFocus.type !== 'bot' ||
        state.activeFocus.botName !== botProfile
      ) {
        return;
      }
      console.error('[Flux] Failed to resolve Forever Chat for bot:', botProfile, err);
      state.dockNotice = deps.t('dock.enterBotChatFailed', { name: botProfile, error: deps.describeRpcError(err) });
      state.profileName = outgoingProfileName;
      state.activeGatewayId = outgoingGw;
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('hermes_flux_profile', outgoingProfileName);
        localStorage.setItem('hermes_aura_profile', outgoingProfileName);
      }
      if (outgoingFocus.type === 'session' && outgoingSessionId) {
        void deps.selectSession(outgoingSessionId, { gatewayId: outgoingGw });
      } else if (outgoingFocus.type === 'group') {
        void deps.openGroupRoom(outgoingFocus.roomId, outgoingGw);
      } else if (outgoingFocus.type === 'bot') {
        const outBotCacheKey = resolveScopedBotRuntimeKey(outgoingFocus.botName, outgoingGw, state.gatewayCount);
        const outgoingForeverId = botForeverChatCache.get(outBotCacheKey);
        if (outgoingForeverId) {
          state.activeFocus = outgoingGw
            ? { type: 'bot', botName: outgoingFocus.botName, gatewayId: outgoingGw }
            : { type: 'bot', botName: outgoingFocus.botName };
          void deps.selectSession(outgoingForeverId, { preserveFocus: true, botName: outgoingFocus.botName, gatewayId: outgoingGw });
          deps.render();
        } else {
          state.messagesPhase = 'ready';
          deps.render();
        }
      } else {
        state.messagesPhase = 'ready';
        deps.render();
      }
      return;
    }

    void deps.fetchModelOptions({ clearNotice: true });
  }

  return {
    botForeverChatCache,
    profileAvatarCache,
    syncSessionBotDisplayNames,
    fetchProfiles,
    warmBotForeverChats,
    startProfileAutoRefresh,
    stopProfileAutoRefresh,
    refreshProfilesFromServer,
    switchProfile,
    openBotChat,
  };
}

/**
 * 构建按网关与 Bot 身份隔离的头像解析器（零 DOM，供渲染入口与各服务共享）。
 */
export function createAgentAvatarResolver(deps: {
  state: Pick<AppState, 'gatewayCount' | 'profiles'>;
  avatarCache: Map<string, string>;
  persistAvatarCache: () => void;
}): (nameOrDisplayName?: string, gatewayId?: string) => string {
  const { state, avatarCache, persistAvatarCache } = deps;
  return function resolveAgentAvatar(nameOrDisplayName?: string, gatewayId?: string): string {
    if (!nameOrDisplayName) return '';
    const key = nameOrDisplayName.trim().toLowerCase();
    if (gatewayId) {
      const scoped = avatarCache.get(`${gatewayId}:${key}`);
      if (scoped) return scoped;
    }
    const cached = !gatewayId || state.gatewayCount < 2 ? avatarCache.get(key) : undefined;
    if (cached) return cached;
    const match =
      state.profiles.find(
        (p) =>
          (!gatewayId || !p.gatewayId || p.gatewayId === gatewayId) &&
          (p.name.toLowerCase() === key || p.displayName?.toLowerCase() === key),
      ) ||
      (!gatewayId || state.gatewayCount < 2
        ? state.profiles.find((p) => p.name.toLowerCase() === key || p.displayName?.toLowerCase() === key)
        : undefined);
    if (match?.avatar) {
      const prefix = gatewayId || match.gatewayId ? `${gatewayId || match.gatewayId}:` : '';
      avatarCache.set(`${prefix}${key}`, match.avatar);
      avatarCache.set(`${prefix}${match.name.toLowerCase()}`, match.avatar);
      if (match.displayName) {
        avatarCache.set(`${prefix}${match.displayName.toLowerCase()}`, match.avatar);
      }
      persistAvatarCache();
      return match.avatar;
    }
    return '';
  };
}
