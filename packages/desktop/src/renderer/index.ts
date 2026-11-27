/**
 * Hermes Flux Desktop Renderer Application Entry (v4.0 Production)
 * Fully powered by @hermes-flux/core and @hermes-flux/ui
 * Zero private WS glue code: Dual-channel fallback, TokenCoalescer 120 FPS stream, robust model & session lifecycle.
 */

import type { IRpcCaller } from '@hermes-flux/core';
import {
  applyRestoredCacheSnapshotToState,
  persistMessagesToCache as bridgePersistMessagesToCache,
  persistTurnToCache as bridgePersistTurnToCache,
  persistMultiGatewayGroupsToCache,
  persistMultiGatewaySessionsToCache, persistMultiGatewayAgentsToCache,
  restoreMultiGatewayCacheSnapshot, defaultIndexWriteQueue,
} from './cache/desktopCacheBridge.js';
import { createFileViewerService } from './services/fileViewerService.js';
import {
  createMediaResolver,
  createSessionDeliverableCoordinator,
  createSessionKnownFilesResolver,
} from './services/mediaResolver.js';
import { createLearningService } from './services/learningService.js';
import { createConversationStreamController } from './events/conversationStreamController.js';
import { createTokenStreamWriter } from './stream/tokenStreamWriter.js';
import { revealStreamingContentDisplay, shouldPatchStreamingTools } from './stream/streamDomOwnership.js';
import { type StreamAnchor, type StreamViewportManager, STICK_TO_BOTTOM_THRESHOLD_PX } from './viewport/streamViewportManager.js';
import { createDesktopStreamViewport, streamSettleState } from './viewport/desktopStreamViewport.js';
import { PromptNavigatorManager } from './navigation/promptNavigatorManager.js';
import { createLeftRailController } from './events/leftRailController.js';
import { createPresenceController } from './events/presenceController.js';
import { createOnboardingController } from './events/onboardingController.js';
import { createTitlebarController } from './titlebarController.js';
import {
  createAppBootstrap,
  LEFT_RAIL_WIDTH,
  beginLeftRailResize,
  bindRailResizeEvents,
  clampLeftRailWidth,
  resetLeftRailWidth,
} from './bootstrap/appBootstrap.js';
import { createScrollEndController } from './scrollEndController.js';
import {
  type SettingsSectionId, type SettingsSnapshot, type SettingsActions,
  renderMarkdown, escapeHtml, MessageViewModel, type LeftRailGroupRoom,
  type LeftRailSession, type LeftRailProfile, t, type RenderInputDockSnapshot,
  resolveSkinId, type LeftRailActions, type LeftRailSnapshot, type TitlebarSnapshot,
  mountAgentPresence, type AgentPresenceSnapshot, type PromptNavigatorSnapshot,
  mountScrollToEndButton,
  type PromptNavigatorActions, type ConversationMount, type ConversationSnapshot,
  type ConversationMessageVM, loadFontPreferences, applyFontPreferences,
  loadActivityIndicatorVariant, saveActivityIndicatorVariant, resolveActivityIndicatorVariant,
  type ActivityIndicatorVariant, setLocale, type FontPreferences,
  formatLeftRailTime,
} from '@hermes-flux/ui';
import { createToolPatchQueue } from './toolPatchQueue.js';
import { createModalInteractionController } from './events/modalInteractionController.js';
import { createInputDockController } from './events/inputDockController.js';
import {
  type AppState,
  createInitialState,
  resolveActiveViewportKey,
  resolveActiveWorkspaceCwd,
} from './state/appState.js';
import { createTurnExecutionService } from './services/turnExecutionService.js';
import { createGatewayEventDispatcher, resolveBotNameForSession as resolveForeverBotNameForSession } from './gateway/gatewayEventDispatcher.js';
import {
  createActiveGatewayRpcCaller,
  createActiveLiveSessionIdResolver,
  createAppBootstrapGatewayHandlers,
  createColdStartFocusRunner,
  createDesktopMultiGatewayWiring,
  createModelCatalogFetcher,
  getConfiguredGatewayIds,
  isFocusedGatewaySession,
  matchesForeverChatSession,
  renderToolPatchForMessage,
  resolveFocusedGatewayId,
  resolveGatewayScopedStoredSessionId,
  resolveMessageSessionIdAcrossRegistries,
} from './gateway/multiGatewayCoordinator.js';
import { createActiveViewSyncAdapters, createForegroundSyncCoordinator } from './services/foregroundSyncCoordinator.js';
type GatewayAuthResponse = { ok: boolean; message: string; latency: number };
import { createProjectOperationService } from './services/projectOperationService.js';
import { createGroupOperationService } from './services/groupOperationService.js';
import {
  createAgentAvatarResolver,
  createProfileManagementService,
} from './services/profileManagementService.js';
import { createSettingsDataService } from './services/settingsDataService.js';
import { createConversationOrgCoordinator } from './services/conversationOrgCoordinator.js';
import {
  HermesGatewayClient, TokenCoalescer, readSessionHandles,
  defaultSessionHandleRegistry, createLogger, setLogLevel, addLogSink,
  getLogLevel, parseLogLevel, type LogLevel,
  type NormalizedSession, type AgentPresence,
  type AgentProfile, ProfileService, GroupRoomStore, GroupLogPollerManager,
  settleTurnTermination, applyTurnCompleted, ActivityTransitionTracker,
  type ActivityDomain, type GroupMessageEntry, InteractiveService,
  HandoffService, runGuarded, SessionListGeneration, CacheService,
  deriveSessionKind, LiveStreamRegistry,
  type CachedMessageRow, type CacheChannelRef, type MessageDisplayKind,
} from '@hermes-flux/core';
import { profilesDiffer } from './profileRefresh.js';
import { createInputCompletion } from './completion/inputCompletion.js';
import { createBotActivityStore } from './persistence/botActivityStore.js';
import { createSessionDraftStore } from './persistence/sessionDrafts.js';
import { DesktopCacheStore } from './cache/DesktopCacheStore.js';
import { createMessageLoadingService } from './services/messageLoadingService.js';
import { type SessionOperationService, createSessionOperationService } from './services/sessionOperationService.js';
import { createStatusIntegration } from './services/statusIntegration.js';
import { createMessageWindowManager } from './messageWindowManager.js';
import { createRenderCoordinator, type RenderMessagesSnapshot } from './renderCoordinator.js';
import { createMobileShellCoordinator } from './mobile/mobileShellCoordinator.js';
import { createDropdownKeybindController } from './dropdownKeybindController.js';
import type { HermesDesktopBridge } from '../preload/index.js';

const cacheService = new CacheService(new DesktopCacheStore(), { sessionCap: 500, messageCap: 2000 });

function persistMessagesToCache(ref: CacheChannelRef, messages: MessageViewModel[], fenceMax: number): void { bridgePersistMessagesToCache(ref, messages, fenceMax, cacheService); }
const persistTurnToCache = (sessionId: string, botName: string | undefined | null, messages: MessageViewModel[], gatewayId?: string): void => bridgePersistTurnToCache(sessionId, botName, messages, cacheService, isGroupConversationActive(sessionId), state.profileName || 'default', gatewayId);

async function restoreCacheToState(): Promise<void> {
  try {
    const { sessions: indexRows, agents, avatars } = await restoreMultiGatewayCacheSnapshot(cacheService, getConfiguredGatewayIds(), () => Promise.all([cacheService.readSessions(), cacheService.readAgents(), cacheService.readAvatars()]));
    let touched = false;
    if (avatars && Object.keys(avatars).length > 0) {
      for (const [k, v] of Object.entries(avatars)) {
        if (v && typeof v === 'string') profileAvatarCache.set(k.toLowerCase(), v);
      }
    }
    touched = applyRestoredCacheSnapshotToState({
      state,
      indexRows,
      agents,
      initialTouched: touched,
      seedCachedSlices: multiGateway.coordinator.seedCachedSlicesFromState,
    });
    if (touched) {
      logApp.info('cold start cache snapshot restored', {
        sessions: state.sessions.length, groups: state.groupRooms.length,
        profiles: state.profiles.length, avatars: Object.keys(avatars || {}).length,
      });
      if (state.profiles.length > 0) state.profilesPhase = 'ready';
      if (state.sessions.length > 0) state.sessionsPhase = 'ready';
      render();
    }
  // gate-degrade: 本地快照读取失败安全回退到权威网络
  } catch {
  } finally {
    void applyColdStartFocus();
  }
}

const persistSessionsToCache = (sessions: NormalizedSession[]): void => persistMultiGatewaySessionsToCache(sessions, cacheService, state.profileName || 'default', defaultIndexWriteQueue, getConfiguredGatewayIds(), state.gatewayCount);
const persistGroupsToCache = (rooms: LeftRailGroupRoom[]): void => persistMultiGatewayGroupsToCache(rooms, cacheService, defaultIndexWriteQueue, state.gatewayCount);
const persistAgentsToCache = (profiles: AgentProfile[]): void => persistMultiGatewayAgentsToCache(profiles, cacheService, getConfiguredGatewayIds(), state.gatewayCount);

declare global {
  interface Window {
    hermesDesktop?: HermesDesktopBridge;
    hermesMobile?: { syncStatusBarAppearance?: (appearance: 'dark' | 'light') => Promise<void> | void; hapticSelection?: () => Promise<void> | void };
    __fluxState?: AppState;
    __fluxRender?: () => void;
    __fluxConnect?: (url?: string) => Promise<void> | void;
    __fluxSelectSession?: (id: string, o?: { preserveFocus?: boolean; botName?: string }) => Promise<void> | void;
    __fluxLog?: { readonly level: LogLevel; setLevel(next: string): LogLevel; getSinkCount(): number };
    __fluxMessageActions?: { handleCopyMessage: (btn: HTMLElement) => Promise<void>; handleRollbackMessage: (btn: HTMLElement) => void; handleForkMessage: (btn: HTMLElement) => Promise<void> };
  }
}

const desktopApi: HermesDesktopBridge | undefined =
  typeof window !== 'undefined' ? window.hermesDesktop : undefined;

const bootLog = createLogger('boot');
const LOG_SINKS = { error: console.error, warn: console.warn, debug: console.debug, trace: console.debug, info: console.log } as const;
addLogSink((entry) => LOG_SINKS[entry.level](`[Flux ${entry.scope}]`, entry.message, entry.data ?? ''));
const LOG_LEVEL_STORAGE_KEY = 'hermes_flux_log_level';

function resolveInitialLogLevel(): LogLevel {
  try {
    const raw = localStorage.getItem(LOG_LEVEL_STORAGE_KEY);
    return (raw ? parseLogLevel(raw) : null) ?? 'info';
  } catch { return 'info'; }
}

const initialLogLevel = resolveInitialLogLevel();
setLogLevel(initialLogLevel);
bootLog.info('runtime log level initialized', { level: initialLogLevel });

if (typeof window !== 'undefined') {
  window.__fluxLog = {
    get level() { return getLogLevel(); },
    setLevel(next: string): LogLevel {
      const parsed = parseLogLevel(next);
      if (!parsed) throw new Error(`Invalid log level: "${next}". Expected: trace | debug | info | warn | error | silent`);
      setLogLevel(parsed);
      // gate-degrade: 日志等级持久化容错
      try { localStorage.setItem(LOG_LEVEL_STORAGE_KEY, parsed); } catch {}
      console.log('[Flux Log] level changed to', parsed);
      return parsed;
    },
    getSinkCount() { return 1; },
  };
}

async function safeCopyText(text: string): Promise<boolean> {
  try {
    if (navigator?.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; }
  // gate-degrade: 主剪贴板通道不可用时降级
  } catch {}
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text; textarea.style.position = 'fixed'; textarea.style.left = '-9999px'; textarea.style.top = '-9999px';
    document.body.appendChild(textarea); textarea.focus(); textarea.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(textarea); return ok;
  // gate-degrade: 剪贴板降级通道失败
  } catch { return false; }
}

async function testConnection(url: string, user?: string, pass?: string): Promise<GatewayAuthResponse> {
  try {
    if (!desktopApi?.authenticateGateway) return { ok: false, message: t('chat.gatewayNotConnected'), latency: 0 };
    return await desktopApi.authenticateGateway({ url, username: user || '', password: pass || '' });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : t('chat.gatewayNotConnected');
    return { ok: false, message, latency: 0 };
  }
}

const profileService = new ProfileService();
const groupRoomStore = new GroupRoomStore();

const PRESENCE_LAYOUT_STORAGE_KEY = 'hermes_flux_presence_layout';

function readPresenceLayout(): 'stage' | 'dock' {
  try {
    const raw = localStorage.getItem(PRESENCE_LAYOUT_STORAGE_KEY);
    return raw === 'dock' ? 'dock' : 'stage';
  } catch (error) {
    console.warn('[presence] failed to read layout preference; falling back to stage', error);
    return 'stage';
  }
}

function writePresenceLayout(layout: 'stage' | 'dock'): void {
  try {
    localStorage.setItem(PRESENCE_LAYOUT_STORAGE_KEY, layout);
  } catch (error) {
    console.warn('[presence] failed to persist layout preference; session-only', error);
  }
}

const titlebarController = createTitlebarController({
  getDesktopApi: () => desktopApi,
  render: () => render(),
  getState: () => state,
  t: (k) => t(k),
  getRunningSubagentCount: () => statusIntegration.getRunningSubagentCount(),
});

const getTitlebarSnapshot = (): TitlebarSnapshot => titlebarController.getTitlebarSnapshot();
const handoffService = new HandoffService();

let sessionOperationService!: SessionOperationService;
let fontPreferences: FontPreferences = loadFontPreferences();
let activityIndicatorVariant: ActivityIndicatorVariant = loadActivityIndicatorVariant();

const state: AppState = {
  ...createInitialState({ platform: titlebarController.detectInitialPlatform() }),
};
if (typeof window !== 'undefined') window.__fluxState = state;

const logApp = createLogger('app'), logRender = createLogger('render'), logSession = createLogger('session'), logStream = createLogger('stream'), logScroll = createLogger('scroll');

let gatewayClient: HermesGatewayClient | null = null, currentTicket: string | null = null;
let sessionsRefreshTimer: ReturnType<typeof setTimeout> | null = null;
let activeStreamingMessageId: string | null = null, activeStreamingStoredSessionId: string | null = null;
let activeStreamingLiveId: string | null = null, activeStreamingBotName: string | null = null, activeLoadMessagesGeneration = 0;

const rpcCaller: IRpcCaller = createActiveGatewayRpcCaller(() => resolveActiveClient());

const sessionDrafts = createSessionDraftStore({ onPersistError: (err) => console.warn('[Flux] session draft persist failed:', err) });
const unreadSessionIds = new Set<string>(), unreadGroupRoomIds = new Set<string>(), unreadBotNames = new Set<string>();
const activeRunningGroupRoomIds = new Set<string>(), activeRunningSessionIds = new Set<string>(), activeRunningBotNames = new Set<string>();

const activityTransitionTracker = new ActivityTransitionTracker({ windowMs: 850 });
let activityTransitionRefreshTimer: ReturnType<typeof setTimeout> | null = null;

function clearTransitionRefreshTimer(): void { if (activityTransitionRefreshTimer !== null) { clearTimeout(activityTransitionRefreshTimer); activityTransitionRefreshTimer = null; } }
function scheduleTransitionRefresh(): void {
  clearTransitionRefreshTimer();
  const delayMs = activityTransitionTracker.nextExpiryDelayMs(Date.now());
  if (delayMs === null) return;
  activityTransitionRefreshTimer = setTimeout(() => { activityTransitionRefreshTimer = null; scheduleTransitionRefresh(); render(); }, delayMs);
}

function completeEntityTurn(domain: ActivityDomain, running: Set<string>, unread: Set<string>, entityId: string, isFocused: boolean): void {
  if (!entityId) return;
  const wasRunning = running.has(entityId) || (domain === 'session' && activeStreamingStoredSessionId === entityId);
  applyTurnCompleted(running, unread, entityId, isFocused);
  if (wasRunning) {
    activityTransitionTracker.recordCompleted(domain, entityId, isFocused ? 'read' : 'unread', Date.now());
    scheduleTransitionRefresh();
  }
}

const toStoredSessionId = (id: string | null | undefined): string | null => resolveGatewayScopedStoredSessionId({ id, state, coordinator: multiGateway.coordinator, activeStreamingLiveId, activeStreamingStoredSessionId });

const AVATAR_PERSISTENCE_KEY = 'hermes_flux_avatar_cache';
const profileAvatarCache = new Map<string, string>();
try {
  const raw = localStorage.getItem(AVATAR_PERSISTENCE_KEY);
  if (raw) {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      for (const [k, v] of Object.entries(parsed)) { if (typeof v === 'string') profileAvatarCache.set(k.toLowerCase(), v); }
    }
  }
// gate-degrade: 本地头像恢复失败可安全跳过
} catch {}

function persistAvatarCache(): void {
  try {
    const obj: Record<string, string> = {};
    for (const [k, v] of profileAvatarCache.entries()) obj[k] = v;
    localStorage.setItem(AVATAR_PERSISTENCE_KEY, JSON.stringify(obj));
    cacheService.writeAvatars(obj).catch(() => {});
  // gate-degrade: 头像写入持久化存储失败降级
  } catch {}
}

const botActivityStore = createBotActivityStore({
  profiles: () => state.profiles, setProfiles: (next) => { state.profiles = next; },
  formatTime: (ts) => formatSessionTime(ts), onPersistError: (err) => console.warn('[Flux] bot activity persist failed:', err),
});

function restoreComposerFocus(): void {
  setTimeout(() => {
    const input = document.getElementById('dock-prompt-input') as HTMLTextAreaElement | null;
    if (input && document.activeElement !== input) input.focus();
  }, 30);
}

const resolveAgentAvatar = createAgentAvatarResolver({
  state,
  avatarCache: profileAvatarCache,
  persistAvatarCache,
});

const liveStreamRegistry = new LiveStreamRegistry();
const resolveBotNameForSession = (sid: string, gw?: string): string | null => resolveForeverBotNameForSession(sid, botForeverChatCache, state, gw);
function describeRpcError(error: unknown): string {
  if (!error) return '';
  if (typeof error === 'string') return error;
  if (typeof error === 'object') {
    const obj = error as Record<string, unknown>;
    const code = typeof obj.code === 'number' ? ` (code: ${obj.code})` : '';
    if (typeof obj.message === 'string' && obj.message) return `${obj.message}${code}`;
    if (typeof obj.error === 'string' && obj.error) return `${obj.error}${code}`;
    // gate-degrade: JSON 序列化失败直接 String(error)
    try { return JSON.stringify(error); } catch {}
  }
  return String(error);
}

function isExtraInputsError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const obj = error as Record<string, unknown>;
  const msg = typeof obj.message === 'string' ? obj.message : '';
  const data = typeof obj.data === 'string' ? obj.data : '';
  return obj.code === -32602 && (msg.includes('Extra inputs are not permitted') || data.includes('Extra inputs are not permitted'));
}

let streamViewportManager!: StreamViewportManager;

const isStreamNearBottom = (s: HTMLElement | null): boolean => (streamViewportManager ? streamViewportManager.isNearBottom(s) : false);
const scrollStreamToBottom = (r: string): void => { streamViewportManager?.scrollStreamToBottom(r); };
const settleInitialBottom = (attempt = 0): void => { streamViewportManager?.settleInitialBottom(attempt); };
const syncStreamBottomInset = (): void => { streamViewportManager?.syncStreamBottomInset(); };
const scheduleStreamBottomInset = (): void => { streamViewportManager?.scheduleStreamBottomInset(); };
const scrollStreamToContentBottom = (s: HTMLElement, r: number): void => { streamViewportManager?.scrollStreamToContentBottom(s, r); };

const sessionMessagesCache = new Map<string, MessageViewModel[]>();
const tokenStreamWriter = createTokenStreamWriter({
  getState: () => state, sessionMessagesCache, botActivityStore,
  getActiveStreamingStoredSessionId: () => activeStreamingStoredSessionId,
  resolveSessionIdForMessage: (mid) => resolveMessageSessionIdAcrossRegistries(mid, state, multiGateway.coordinator, liveStreamRegistry),
  resolveSessionOwnerForMessage: (mid) => multiGateway.coordinator.resolveMessageOwner(mid),
  resolveBotNameForSession,
  isStreamNearBottom: (s) => isStreamNearBottom(s), markProgrammaticScroll: (s) => markProgrammaticScroll(s), logStream,
});

const tokenCoalescer = new TokenCoalescer((flushedMap) => { tokenStreamWriter.writeFlushedTokens(flushedMap); });

let canvasStructureDirty = false;
const toolPatchQueue = createToolPatchQueue({
  renderSlot: (messageId) => renderToolPatchForMessage(messageId, state, activeStreamingStoredSessionId, sessionMessagesCache),
  patchElement: (messageId, html) => {
    // 单所有者守卫：仅活跃流式消息允许直写，防止迟到 rAF 覆写 React <ToolBlocks>；跳过视为已处理
    if (!shouldPatchStreamingTools({ isStreamingActive: isStreamingActiveForCurrentSession(), activeStreamingMessageId, messageId })) return true;
    const el = document.getElementById(`msg-tools-${messageId}`);
    if (!el) return false;
    el.innerHTML = html;
    return true;
  },
  isNearBottom: () => isStreamNearBottom(document.getElementById('conversation-stream')),
  scrollBottom: () => scrollStreamToBottom('tool patch'),
  markStructureDirty: () => { canvasStructureDirty = true; }, schedule: (cb) => requestAnimationFrame(cb),
});

const scheduleToolPatch = (mid: string) => toolPatchQueue.schedulePatch(mid);

function getEffectiveUrl(base: string): string {
  let url = (base || '').trim();
  if (!url) return '';
  if (url.startsWith('ws://')) url = url.replace('ws://', 'http://');
  if (url.startsWith('wss://')) url = url.replace('wss://', 'https://');
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    const isLoopback = /^(127\.0\.0\.1|localhost)(:\d+)?$/i.test(url) || url.startsWith('127.0.0.1:') || url.startsWith('localhost:');
    url = isLoopback ? `http://${url}` : `https://${url}`;
  }
  return url.replace(/\/+$/, '');
}

function rpcErrorCode(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null;
  const obj = error as Record<string, unknown>;
  return typeof obj.code === 'number' ? obj.code : null;
}

function scheduleSessionsRefresh(delayMs = 180): void {
  if (sessionsRefreshTimer) clearTimeout(sessionsRefreshTimer);
  sessionsRefreshTimer = setTimeout(() => { sessionsRefreshTimer = null; void fetchSessions(); }, delayMs);
}

function formatSessionTime(timestamp: number): string { return formatLeftRailTime(timestamp); }

const sessionListGeneration = new SessionListGeneration();
const sessionPreviewCache = new Map<string, { lastActive: number; text: string; botName?: string }>();
const persistSessionPreviewCache = (): void => {};

const botForeverChatCache = new Map<string, string>();
const projectOperationService = createProjectOperationService({
  getState: () => state,
  getGatewayClient: () => resolveActiveClient(),
  render: () => render(),
  botActivityStore,
  botForeverChatCache,
  sessionMessagesCache,
  formatSessionTime,
});

const syncProfileLastMessages = () => projectOperationService.syncProfileLastMessages();
const fetchProjects = () => projectOperationService.fetchProjects();
const multiGateway = createDesktopMultiGatewayWiring({
  getState: () => state,
  getDesktopApi: () => desktopApi,
  getFallbackClient: () => gatewayClient,
  getFallbackHandleRegistry: () => defaultSessionHandleRegistry,
  getFallbackLiveStreamRegistry: () => liveStreamRegistry,
  isLegacyClientConnected: () => Boolean(gatewayClient && gatewayClient.getFsm().getState() === 'CONNECTED'),
  onPrimaryClientChange: (c) => { gatewayClient = c; },
  onForwardSlotEvent: (params, gwId) => gatewayEventDispatcher.handleGatewayEvent(params, gwId),
  render: () => render(),
});
const resolveActiveClient = (): HermesGatewayClient | null => multiGateway.coordinator.resolveActiveClient(gatewayClient);

const conversationOrgCoordinator = createConversationOrgCoordinator({
  getState: () => state, getGatewayClient: resolveActiveClient, render: () => render(), t, showToast, restoreComposerFocus: () => restoreComposerFocus(), describeRpcError,
  setSessionArchived: (id, archived, profile, gw) => sessionOperationService.setSessionArchived(id, archived, profile, gw),
  isForeverChatSession: (sid, p, g) => matchesForeverChatSession(botForeverChatCache, sid, p, g),
  fetchArchivedSessions: (opts) => sessionOperationService.fetchArchivedSessions(opts),
  openNewChatInContainer: (kind, cid) => { cancelColdStartFocus(); void fetchProjects(); state.selectedNewTaskContainerId = cid; state.newTaskModalTab = kind === 'group' ? 'group' : 'solo'; state.isNewTaskModalOpen = true; render(); },
});

const groupOperationService = createGroupOperationService({
  getState: () => state, getGatewayClient: () => gatewayClient, getClientForGateway: multiGateway.coordinator.resolveClient,
  onActiveFocusChanged: () => { multiGateway.coordinator.refreshActiveOfflineState(); }, render: () => render(),
  t: (k, p) => t(k, p), disarmRollbackOnLeave: () => disarmRollbackOnLeave(),
  unreadGroupRoomIds, activeRunningGroupRoomIds, activityTransitionTracker,
  groupRoomStore, cancelColdStartFocus: () => cancelColdStartFocus(), sessionMessagesCache,
  turnExecutionService: {
    resetActiveGroupThread: () => turnExecutionService.resetActiveGroupThread(),
    syncGroupRoomLogsToState: (r, l) => turnExecutionService.syncGroupRoomLogsToState(r, l),
    refreshGroupRoomLog: (r) => turnExecutionService.refreshGroupRoomLog(r),
    sendGroupMessage: (r, t) => turnExecutionService.sendGroupMessage(r, t),
  },
  groupPollerManager: {
    isPolling: (r) => groupPollerManager.isPolling(r),
    startAwaitReply: (r, b) => groupPollerManager.startAwaitReply(r, b),
    stop: (r) => groupPollerManager.stop(r),
    stopAll: () => groupPollerManager.stopAll(),
  },
  persistGroupsToCache: (r) => persistGroupsToCache(r), resolveAgentAvatar: (n) => resolveAgentAvatar(n),
  formatTimestamp: (ts) => formatTimestamp(ts), nextLoadMessagesGeneration: () => ++activeLoadMessagesGeneration,
  getCurrentLoadMessagesGeneration: () => activeLoadMessagesGeneration, logSession,
  setPendingScrollToBottom: (p) => renderCoordinator.setPendingScrollToBottom(p),
  captureStreamAnchor: () => captureStreamAnchor(),
  beginSessionEnter: (id, opts) => streamViewportManager.beginSessionEnter(id, {
    ...opts,
    phase: opts?.forcePinToBottom ? 'ready' : (resolveActiveClient() ? 'loading' : 'ready'),
  }),
  onGroupActivated: (roomId) => statusIntegration.onGroupActivated(roomId),
  activeRunningSessionIds, activeRunningBotNames,
  onGroupDisbanded: (roomId) => conversationOrgCoordinator.pruneDeletedEntity('group', roomId),
  selectSession: (id, opts) => selectSession(id, opts),
  onMultiGatewayRefresh: multiGateway.coordinator.refreshAllSlots,
});

const hostedRoomIds = groupOperationService.hostedRoomIds as Set<string>;
const fetchGroupRooms = () => groupOperationService.fetchGroupRooms();
const syncActiveGroupSpeakerFromMessages = () => groupOperationService.syncActiveGroupSpeakerFromMessages();
const openGroupRoom = (r: string, g?: string) => groupOperationService.openGroupRoom(r, g);

const profileManagementService = createProfileManagementService({
  getState: () => state, getGatewayClient: () => gatewayClient, getClientForGateway: multiGateway.coordinator.resolveClient,
  getSessionHandleRegistryForGateway: multiGateway.coordinator.getHandleRegistry,
  onActiveFocusChanged: () => { multiGateway.coordinator.refreshActiveOfflineState(); }, render: () => render(),
  t: (k, p) => t(k, p), describeRpcError: (e) => describeRpcError(e),
  botActivityStore, unreadBotNames, activityTransitionTracker, sessionMessagesCache,
  syncProfileLastMessages: () => syncProfileLastMessages(), applyColdStartFocus: async () => applyColdStartFocus(),
  cancelColdStartFocus: () => cancelColdStartFocus(), fetchSessions: async () => fetchSessions(),
  fetchModelOptions: async (opts) => fetchModelOptions(opts), selectSession: async (id, opts) => selectSession(id, opts),
  openGroupRoom: async (r, g) => openGroupRoom(r, g), restoreComposerFocus: () => restoreComposerFocus(),
  disarmRollbackOnLeave: () => disarmRollbackOnLeave(), persistAgentsToCache: (p) => persistAgentsToCache(p),
  persistAvatarCache: () => persistAvatarCache(), profileAvatarCache, botForeverChatCache,
  nextLoadMessagesGeneration: () => ++activeLoadMessagesGeneration, getCurrentLoadMessagesGeneration: () => activeLoadMessagesGeneration,
  logSession, setPendingScrollToBottom: (p) => renderCoordinator.setPendingScrollToBottom(p),
  captureStreamAnchor: () => captureStreamAnchor(),
  onProfilesFetched: (list) => conversationOrgCoordinator.hydrateFromProfiles(list),
  onMultiGatewayRefresh: multiGateway.coordinator.refreshAllSlots,
});

const openBotChat = (p: string, g?: string) => profileManagementService.openBotChat(p, g);

const { applyColdStartFocus, cancelColdStartFocus } = createColdStartFocusRunner({
  getState: () => state,
  resolveActiveClient,
  getEffectiveUrl,
  selectSession: (id, opts) => selectSession(id, opts),
  openBotChat: (bot, gw) => openBotChat(bot, gw),
});
const fetchModelOptions = createModelCatalogFetcher({ getState: () => state, resolveActiveClient, render: () => render(), t });

const syncSessionBotDisplayNames = (p: AgentProfile[]) => profileManagementService.syncSessionBotDisplayNames(p);
const fetchProfiles = (opts: { refresh?: boolean } = {}) => profileManagementService.fetchProfiles(opts);
const warmBotForeverChats = (list: AgentProfile[], client: NonNullable<typeof gatewayClient>) => profileManagementService.warmBotForeverChats(list, client);
const stopProfileAutoRefresh = () => profileManagementService.stopProfileAutoRefresh();
const startProfileAutoRefresh = () => profileManagementService.startProfileAutoRefresh();

const INITIAL_WINDOW_PAGE_SIZE = 100;
const OLDER_BATCH_PAGE_SIZE = 500;
const INITIAL_RENDER_WINDOW = 24;
const RENDER_WINDOW_STEP = 40;
const MESSAGE_WINDOW_CAPACITY = 120;

let streamScrollCooldown = 0;
let lastStreamScrollTop = 0;
let programmaticScrollTarget: number | null = null;
let programmaticScrollIgnoreUntil = 0; // performance.now() 域，与 conversationStreamController 的比较同域
let layoutDriftUntil = 0;
let readerScrolledSessionId: string | null = null;

const messageWindowManager = createMessageWindowManager({
  getState: () => state, render: () => render(),
  isStreamNearBottom: (stream) => isStreamNearBottom(stream), scrollStreamToBottom: (reason) => scrollStreamToBottom(reason),
  scrollStreamToContentBottom: (stream, inset) => scrollStreamToContentBottom(stream, inset),
  settleInitialBottom: () => settleInitialBottom(), syncPromptNavigatorFromScroll: () => syncPromptNavigatorFromScroll(),
  setCanvasStructureDirty: (val) => { canvasStructureDirty = val; }, setSuppressPinBottomOnce: (val) => renderCoordinator.setSuppressPinBottomOnce(val),
  setSessionSwitchPending: (val) => renderCoordinator.setSessionSwitchPending(val), setSettleMinFrames: (val) => { streamSettleState.settleMinFrames = val; },
  setInitialBottomSettling: (val) => { streamSettleState.initialBottomSettling = val; }, setSettledLayoutSignature: (val) => { streamSettleState.settledLayoutSignature = val; },
  setLastStreamScrollTop: (val) => { lastStreamScrollTop = val; },
  setStreamScrollCooldown: (val) => { streamScrollCooldown = val ? Date.now() + 180 : 0; },
  logScroll,
});

function syncWindowLocalState(): void {
  // 窗口状态已收敛至 messageWindowManager 单一真值源，保留空函数以兼容既有调用点
}

const layoutSignature = (): string => `${resolveActiveViewportKey(state)}:${state.messages.length}:${messageWindowManager.getMessageWindowStart()}:${messageWindowManager.getMessageWindowEnd()}`;
function markProgrammaticScroll(stream: HTMLElement): void {
  programmaticScrollTarget = Math.round(stream.scrollTop);
  programmaticScrollIgnoreUntil = (typeof performance !== 'undefined' ? performance.now() : Date.now()) + 180;
}

const ensureMessageWindow = (total: number) => { messageWindowManager.ensureMessageWindow(total); syncWindowLocalState(); };
const expandMessageWindow = () => { const r = messageWindowManager.expandMessageWindow(); syncWindowLocalState(); return r; };
const slideMessageWindowForward = () => { messageWindowManager.slideMessageWindowForward(); syncWindowLocalState(); };
const relocateMessageWindowToIndex = (idx: number) => { const r = messageWindowManager.relocateMessageWindowToIndex(idx); syncWindowLocalState(); return r; };
const syncScrollTopToWindow = (reason: string) => { messageWindowManager.syncScrollTopToWindow(reason); syncWindowLocalState(); };
const scheduleVirtualHeightSync = (att = 0) => { messageWindowManager.scheduleVirtualHeightSync(att); syncWindowLocalState(); };

const PROMPT_READ_LINE_PX = 100;
const isGroupConversationActive = (sessionId = state.activeSessionId): boolean => {
  if (state.activeFocus.type === 'group') return true;
  if (!sessionId) return false;
  return Boolean(state.groupRooms.some((r) => r.roomId === sessionId) || hostedRoomIds.has(sessionId));
};

const promptNavigatorManager = new PromptNavigatorManager({
  getActiveSessionId: () => resolveActiveViewportKey(state), getMessages: () => state.messages, getLang: () => state.lang,
  hasOlderMessages: () => state.hasOlderMessages, isLoadingOlder: () => state.isLoadingOlder,
  isGroupConversationActive: () => isGroupConversationActive(), getAverageRowHeightPx: () => messageWindowManager.getAverageRowHeightPx(),
  isAverageRowHeightLocked: () => messageWindowManager.isAverageRowHeightLocked(),
  getStreamElement: () => document.getElementById('conversation-stream'),
  relocateMessageWindowToIndex: (idx) => relocateMessageWindowToIndex(idx),
  triggerRenderForJump: () => render(), loadOlderMessages: (options) => loadOlderMessages(options),
});

const currentPromptNavigatorMeta = () => promptNavigatorManager.currentPromptNavigatorMeta();
const syncPromptNavigatorMeta = () => promptNavigatorManager.syncMeta();
const getPromptNavigatorSnapshot = (): PromptNavigatorSnapshot => promptNavigatorManager.getSnapshot();
const syncPromptNavigator = () => promptNavigatorManager.sync();
const rebuildPromptEntries = () => promptNavigatorManager.rebuildEntries();
const syncPromptNavigatorFromScroll = () => promptNavigatorManager.syncFromScroll();
const createPromptNavigatorActions = (): PromptNavigatorActions => promptNavigatorManager.createActions();
const jumpToPrompt = (mid: string) => promptNavigatorManager.jumpToPrompt(mid);

/**
 * 会话流视口管理器装配，必须晚于 promptNavigatorManager（依赖 isJumpSettling）。
 * 历史坑与落定状态单一真值源说明见 viewport/desktopStreamViewport.ts。
 */
streamViewportManager = createDesktopStreamViewport({
  getState: () => state,
  logScroll,
  layoutSignature: () => layoutSignature(),
  markProgrammaticScroll: (stream) => markProgrammaticScroll(stream),
  isPromptJumpSettling: () => promptNavigatorManager.isJumpSettling(),
  getWindowGeom: () => ({ start: messageWindowManager.getMessageWindowStart(), end: messageWindowManager.getMessageWindowEnd(), averageRowHeightPx: messageWindowManager.getAverageRowHeightPx() }),
  onBeforeSessionEnter: () => scrollEndController.cancelSmoothScroll({ stopNativeSmooth: false, hideImmediately: true }),
  onViewportSettled: () => scrollEndController.syncVisibility(),
});

let toastTimer: ReturnType<typeof setTimeout> | null = null;
function showToast(message: string, durationMs = 2200): void {
  let toastEl = document.getElementById('flux-floating-toast');
  if (!toastEl) {
    toastEl = document.createElement('div');
    toastEl.id = 'flux-floating-toast';
    toastEl.style.cssText = `
      position: fixed; bottom: 96px; left: 50%; transform: translateX(-50%) translateY(10px);
      background: var(--bg-card); color: var(--text-main); border: 1px solid var(--border-strong);
      box-shadow: var(--shadow-window); padding: 6px 14px; border-radius: 9999px; font-size: var(--fs-xs, 12px);
      font-weight: 500; z-index: 3000; pointer-events: none; display: flex; align-items: center; gap: 6px;
      backdrop-filter: blur(16px); transition: opacity 0.2s cubic-bezier(0.16, 1, 0.3, 1), transform 0.2s cubic-bezier(0.16, 1, 0.3, 1); opacity: 0;
    `;
    document.body.appendChild(toastEl);
  }
  toastEl.innerHTML = `<span style="color: var(--accent); font-weight: bold;">✓</span> <span>${escapeHtml(message)}</span>`;
  toastEl.style.opacity = '1';
  toastEl.style.transform = 'translateX(-50%) translateY(0)';
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    if (toastEl) {
      toastEl.style.opacity = '0';
      toastEl.style.transform = 'translateX(-50%) translateY(10px)';
    }
  }, durationMs);
}

const messageLoadingService = createMessageLoadingService({
  getState: () => state, getGatewayClient: () => gatewayClient, getClientForGateway: multiGateway.coordinator.resolveClient, render: () => render(),
  sessionMessagesCache, cacheService,
  persistMessagesToCache: (ref, msgs, fMax) => persistMessagesToCache(ref, msgs, fMax ?? 0),
  syncPromptNavigatorMeta: () => syncPromptNavigatorMeta(), syncPromptNavigatorFromScroll: () => syncPromptNavigatorFromScroll(),
  scrollStreamToBottom: (r) => scrollStreamToBottom(r ?? ''), setPendingScrollToBottom: (v) => renderCoordinator.setPendingScrollToBottom(v),
  isStreamNearBottom: (el) => isStreamNearBottom(el), captureStreamAnchor: () => captureStreamAnchor(),
  applyStreamAnchor: (a, m) => applyStreamAnchor(a as StreamAnchor, m ?? false),
  getMessageWindowStart: () => messageWindowManager.getMessageWindowStart(), setMessageWindowStart: (v) => messageWindowManager.setMessageWindowStart(v),
  getMessageWindowEnd: () => messageWindowManager.getMessageWindowEnd(), setMessageWindowEnd: (v) => messageWindowManager.setMessageWindowEnd(v),
  setMessageWindowUserExpanded: (v) => messageWindowManager.setMessageWindowUserExpanded(v),
  setCanvasStructureDirty: (v) => { canvasStructureDirty = v; }, setSuppressPinBottomOnce: (v) => renderCoordinator.setSuppressPinBottomOnce(v),
  isGroupConversationActive: (id) => isGroupConversationActive(id), hostedRoomIds, formatSessionTime, formatTimestamp: (ts) => formatTimestamp(ts),
  botActivityStore, botForeverChatCache, sessionPreviewCache,
  persistSessionPreviewCache: () => persistSessionPreviewCache(), getActiveStreamingStoredSessionId: () => activeStreamingStoredSessionId,
  getLiveStreamRegistry: () => liveStreamRegistry, getLiveStreamRegistryForGateway: multiGateway.coordinator.getLiveStreamRegistry,
  defaultSessionHandleRegistry, getSessionHandleRegistryForGateway: multiGateway.coordinator.getHandleRegistry, activeRunningSessionIds, activityTransitionTracker,
  getGeneration: () => activeLoadMessagesGeneration, onGenerationIncremented: (g) => { activeLoadMessagesGeneration = g; },
  logSession, logScroll,
  onSessionActivated: (sid, bot) => statusIntegration.onSessionActivated(sid, bot),
  onSessionMessagesLoaded: (sid) => statusIntegration.onSessionMessagesLoaded(sid),
  onLiveSessionReady: (sid, lid, info, bot) => statusIntegration.onLiveSessionReady(sid, lid, info, bot),
  onActiveTurnDiscovered: (p) => gatewayEventDispatcher.attachLiveTurnFromResume(p),
});

const sessionServerOffset = messageLoadingService.sessionServerOffset;
const sessionAuthoritativeOffset = messageLoadingService.sessionAuthoritativeOffset;
const sessionParentOffsetMap = messageLoadingService.sessionParentOffsetMap;
const sessionOvershootRetry = messageLoadingService.sessionOvershootRetry;
const sessionHistoryTrust = messageLoadingService.sessionHistoryTrust;
const untrustedOrderCacheSessions = messageLoadingService.untrustedOrderCacheSessions;
const syncUntrustedCacheOrderFlag = (id: string, r: readonly CachedMessageRow[]) => messageLoadingService.syncUntrustedCacheOrderFlag(id, r);
const hasRemainingParentLineage = (id: string) => messageLoadingService.hasRemainingParentLineage(id);

sessionOperationService = createSessionOperationService({
  getState: () => state, getGatewayClient: () => gatewayClient, getClientForGateway: multiGateway.coordinator.resolveClient,
  getGatewayUrlForGateway: multiGateway.coordinator.getGatewayUrl, getConnectedGatewayClients: multiGateway.coordinator.getConnectedClients,
  onActiveFocusChanged: () => { multiGateway.coordinator.refreshActiveOfflineState(); }, getDesktopApi: () => desktopApi,
  getCurrentTicket: () => currentTicket ?? null, getEffectiveUrl: (url) => getEffectiveUrl(url ?? state.gatewayUrl),
  render: () => render(), t, showToast, setTimedDockNotice: (m, d) => setTimedDockNotice(m, d), clearTimedDockNotice: () => clearTimedDockNotice({ skipRender: true }),
  restoreComposerFocus: () => restoreComposerFocus(), sessionDrafts, sessionMessagesCache,
  unreadSessionIds, activeRunningSessionIds, activityTransitionTracker,
  sessionHandleRegistry: defaultSessionHandleRegistry, getSessionHandleRegistryForGateway: multiGateway.coordinator.getHandleRegistry, cacheService,
  persistSessionsToCache: (s) => persistSessionsToCache(s), forgetOlderCursorState: (id, gw) => messageLoadingService.forgetOlderCursorState(id, gw),
  sessionListGeneration, getActiveStreamingStoredSessionId: () => activeStreamingStoredSessionId,
  getLiveStreamRegistry: () => liveStreamRegistry, getLiveStreamRegistryForGateway: multiGateway.coordinator.getLiveStreamRegistry,
  getActiveStreamingMessageId: () => activeStreamingMessageId, scheduleToolPatch: (mid) => scheduleToolPatch(mid),
  onReenterSameSession: () => { void messageLoadingService.refreshActiveSession({ checkLiveTurn: true }); },
  onSyncFocusedStream: (sid) => gatewayEventDispatcher.syncFocusedStreamingProjection(sid, resolveFocusedGatewayId(state)),
  resetActiveStreamingState: () => { tokenCoalescer.clear(); toolPatchQueue.clear(); disarmTurnWatchdog(); activeStreamingMessageId = null; activeStreamingStoredSessionId = null; activeStreamingLiveId = null; activeStreamingBotName = null; state.isStreaming = false; },
  setPendingScrollToBottom: (v) => renderCoordinator.setPendingScrollToBottom(v), cancelSmoothScrollOnLeave: () => scrollEndController.cancelSmoothScroll({ stopNativeSmooth: false, hideImmediately: true }),
  setLastMessagesSnapshot: (v) => renderCoordinator.setLastMessagesSnapshot(v as RenderMessagesSnapshot | null), captureStreamAnchor: () => captureStreamAnchor(),
  beginSessionEnter: (id, opts) => streamViewportManager.beginSessionEnter(id, { ...opts, phase: opts?.forcePinToBottom ? 'ready' : (resolveActiveClient() ? 'loading' : 'ready') }),
  loadMessages: (id, bot, gw) => loadMessages(id, bot, gw), openBotChat: (bot, gw) => openBotChat(bot, gw), ensureLiveSessionId: () => ensureLiveSessionId(),
  incrementActiveLoadMessagesGeneration: () => { const next = messageLoadingService.incrementGeneration(); activeLoadMessagesGeneration = next; return next; },
  sessionPreviewCache, formatSessionTime: (ts) => formatSessionTime(ts), resolveAgentAvatar: (n, g) => resolveAgentAvatar(n, g), syncProfileLastMessages: () => syncProfileLastMessages(),
  logSessionWarn: (m, meta) => logSession.warn(m, meta), logSessionDebug: (m, meta) => logSession.debug(m, meta),
  onSessionActivated: (sid, bot) => statusIntegration.onSessionActivated(sid, bot), onLiveSessionReady: (sid, lid, info, bot) => statusIntegration.onLiveSessionReady(sid, lid, info, bot),
  onSessionCreatedInContainer: (p, sid, cid) => conversationOrgCoordinator.assignNewEntityContainer('session', sid, { profile: p, containerId: cid }),
  onSessionDeleted: (sid, p) => { statusIntegration.onSessionDeleted(sid); conversationOrgCoordinator.pruneDeletedEntity('session', sid, p); },
  onMultiGatewayRefresh: () => multiGateway.coordinator.refreshAllSlotsIfMulti(multiGateway.isMultiGatewayConfigured),
});

async function fetchSessions(): Promise<void> {
  // state.sessionsPhase = 'ready'; state.profilesPhase = 'ready';
  return sessionOperationService.fetchSessions();
}

const interactiveService = new InteractiveService();
const inputCompletion = createInputCompletion(
  {
    activeSessionId: () => state.activeSessionId, profileName: () => state.profileName,
    sessionKind: () => deriveSessionKind(state.activeFocus),
    activeCwd: () => resolveActiveWorkspaceCwd(state),
    openFiles: () => state.openFiles, agentMentionItems: () => state.mentionItems.filter((m) => m.type === 'agent'),
    inputText: () => {
      const el = document.getElementById('dock-prompt-input') as HTMLTextAreaElement | null;
      return el ? el.value : '';
    },
    setMentionItems: (items) => { state.mentionItems = items; },
    setMentionPopperOpen: (open) => { state.mentionPopperOpen = open; },
    setSlashItems: (items) => { state.slashItems = items; },
    setSlashPopperOpen: (open) => { state.slashPopperOpen = open; },
    render: () => render(), isGatewayReady: () => Boolean(resolveActiveClient()), rpcCaller: () => rpcCaller,
  },
  interactiveService,
);

const parseRawMessages = (l: Parameters<typeof messageLoadingService.parseRawMessages>[0]) => messageLoadingService.parseRawMessages(l);
const loadOlderMessages = (o?: { preserveViewportWindow?: boolean }) => messageLoadingService.loadOlderMessages(o);

const loadMessages = (s: string, b?: string, g?: string) => messageLoadingService.loadMessages(s, b, g);
const ensureLiveSessionId = createActiveLiveSessionIdResolver({ getState: () => state, resolveClient: multiGateway.coordinator.resolveClient, sessionHandleRegistry: defaultSessionHandleRegistry, getHandleRegistry: multiGateway.coordinator.getHandleRegistry, getGeneration: () => activeLoadMessagesGeneration, logSession, describeRpcError });

const createNewSession = (o?: { profile?: string; projectId?: string; containerId?: string; title?: string }) => sessionOperationService.createNewSession(o);
const deleteSession = (id: string, g?: string) => sessionOperationService.deleteSession(id, g);
const renameSession = (id: string, title: string, g?: string) => sessionOperationService.renameSession(id, title, undefined, g);
const copySessionId = (id: string) => sessionOperationService.copySessionId(id); const pinSession = (id: string, g?: string) => sessionOperationService.pinSession(id, g);
const exportMarkdown = (id: string, g?: string) => sessionOperationService.exportMarkdown(id, g); const archiveSession = (id: string, p?: string, g?: string) => sessionOperationService.archiveSession(id, p, g);
const handleArmedOnDelete = (id: string) => sessionOperationService.handleArmedOnDelete(id); const disarmRollbackOnLeave = (outId?: string) => sessionOperationService.disarmRollbackOnLeave(outId);
const selectSession = (id: string, o?: { preserveFocus?: boolean; botName?: string; gatewayId?: string }) => { cancelColdStartFocus(); return sessionOperationService.selectSession(id, o); };
const applyModelToLiveSession = (m: string, p?: string) => sessionOperationService.applyModelToLiveSession(m, p); const switchModel = (m: string, p?: string) => sessionOperationService.switchModel(m, p);
const switchReasoning = (e: AppState['reasoningLevel']) => sessionOperationService.switchReasoning(e); const switchApproval = (m: 'manual' | 'smart' | 'off') => sessionOperationService.switchApproval(m);

const turnExecutionService = createTurnExecutionService({
  getState: () => state, getGatewayClient: () => gatewayClient, getClientForGateway: multiGateway.coordinator.resolveClient, getRpcCaller: () => rpcCaller,
  getInteractiveService: () => interactiveService, getCacheService: () => cacheService,
  getGroupRoomStore: () => groupRoomStore, getActivityTransitionTracker: () => activityTransitionTracker,
  getTokenCoalescer: () => tokenCoalescer, getSessionHandleRegistry: () => defaultSessionHandleRegistry,
  getSessionHandleRegistryForGateway: multiGateway.coordinator.getHandleRegistry,
  getSessionMessagesCache: () => sessionMessagesCache, getSessionDrafts: () => sessionDrafts,
  getBotActivityStore: () => botActivityStore, getHandoffService: () => handoffService,
  completeEntityTurn, getActiveRunningSessionIds: () => activeRunningSessionIds,
  getUnreadSessionIds: () => unreadSessionIds, getActiveRunningBotNames: () => activeRunningBotNames,
  getUnreadBotNames: () => unreadBotNames, getActiveRunningGroupRoomIds: () => activeRunningGroupRoomIds,
  getUnreadGroupRoomIds: () => unreadGroupRoomIds,
  getActiveStreamingContext: () => ({ activeStreamingMessageId, activeStreamingStoredSessionId, activeStreamingLiveId, activeStreamingBotName }),
  setActiveStreamingContext: (ctx) => {
    if ('activeStreamingMessageId' in ctx) activeStreamingMessageId = ctx.activeStreamingMessageId ?? null;
    if ('activeStreamingStoredSessionId' in ctx) activeStreamingStoredSessionId = ctx.activeStreamingStoredSessionId ?? null;
    if ('activeStreamingLiveId' in ctx) activeStreamingLiveId = ctx.activeStreamingLiveId ?? null;
    if ('activeStreamingBotName' in ctx) activeStreamingBotName = ctx.activeStreamingBotName ?? null;
  },
  getTurnStartedSessionId: () => turnStartedSessionId, setTurnStartedSessionId: (id) => { turnStartedSessionId = id; },
  getSessionHistoryTrust: () => sessionHistoryTrust, forgetOlderCursorState: (id, gw) => messageLoadingService.forgetOlderCursorState(id, gw),
  createNewSession: async () => { await createNewSession(); }, ensureLiveSessionId: () => ensureLiveSessionId(),
  setMessageContent: (mid, content) => setMessageContent(mid, content),
  syncActiveGroupSpeakerFromMessages: () => syncActiveGroupSpeakerFromMessages(),
  resolveAgentAvatar: (name) => resolveAgentAvatar(name), scrollStreamToBottom: (reason) => scrollStreamToBottom(reason),
  setPendingScrollToBottom: (val) => renderCoordinator.setPendingScrollToBottom(val), isStreamNearBottom: () => isStreamNearBottom(document.getElementById('conversation-stream')),
  clearToolPatchQueue: () => toolPatchQueue.clear(), stopRunningToolTimers: () => stopRunningToolTimers(), runSlashCommand: (cmd) => inputDockController.runSlashCommand(cmd),
  enqueueDraft: () => inputDockController.enqueueDraft(), handleQueueAction: (action, id) => inputDockController.handleQueueAction(action, id),
  setMessageWindowUserExpanded: (val) => messageWindowManager.setMessageWindowUserExpanded(val), ensureMessageWindow: (total) => ensureMessageWindow(total),
  getLiveStreamRegistry: () => liveStreamRegistry, getLiveStreamRegistryForGateway: multiGateway.coordinator.getLiveStreamRegistry, resolveBotNameForSession,
  onWatchdogTurnStillRunning: (sid, r) => gatewayEventDispatcher.reconcileActiveTurnFromResume(sid, r, resolveFocusedGatewayId(state)),
  onWatchdogTurnCompleted: (sid, gw) => { if (isFocusedGatewaySession(state, sid, gw)) void messageLoadingService.refreshActiveSession({ forceRefreshAfterReconnect: true, checkLiveTurn: true }); },
  onQueuedSubmitRace: (sid, gw) => { if (isFocusedGatewaySession(state, sid, gw)) return messageLoadingService.refreshActiveSession({ forceRefreshAfterReconnect: true, checkLiveTurn: true }); },
  render: () => render(), t, logStream,
  onBeforeSendEntity: (k, id, p) => conversationOrgCoordinator.autoReopenIfDone(k, id, p, resolveFocusedGatewayId(state)),
});

const groupPollerManager = turnExecutionService.getGroupPollerManager();

const gatewayEventDispatcher = createGatewayEventDispatcher({
  getState: () => state, getGatewayClient: () => gatewayClient, getClientForGateway: multiGateway.coordinator.resolveClient,
  setGatewayClient: (client) => { gatewayClient = client; },
  getCurrentTicket: () => currentTicket ?? undefined, setCurrentTicket: (ticket) => { currentTicket = ticket ?? null; },
  getDesktopApi: () => desktopApi, getEffectiveUrl: (url) => getEffectiveUrl(url ?? state.gatewayUrl),
  testConnection: (url, user, pass) => testConnection(url, user, pass), completeEntityTurn,
  getSessionHandleRegistry: () => defaultSessionHandleRegistry, getSessionHandleRegistryForGateway: multiGateway.coordinator.getHandleRegistry,
  getLiveStreamRegistry: () => liveStreamRegistry, getLiveStreamRegistryForGateway: multiGateway.coordinator.getLiveStreamRegistry,
  resolveBotNameForSession, getSessionMessagesCache: () => sessionMessagesCache,
  getTokenCoalescer: () => tokenCoalescer, getActivityTransitionTracker: () => activityTransitionTracker,
  getBotActivityStore: () => botActivityStore, getCacheService: () => cacheService,
  getActiveRunningSessionIds: () => activeRunningSessionIds, getUnreadSessionIds: () => unreadSessionIds,
  getActiveRunningBotNames: () => activeRunningBotNames, getUnreadBotNames: () => unreadBotNames,
  getActiveRunningGroupRoomIds: () => activeRunningGroupRoomIds, getUnreadGroupRoomIds: () => unreadGroupRoomIds,
  getActiveStreamingContext: () => ({ activeStreamingMessageId, activeStreamingStoredSessionId, activeStreamingLiveId, activeStreamingBotName }),
  setActiveStreamingContext: (ctx) => {
    if ('activeStreamingMessageId' in ctx) activeStreamingMessageId = ctx.activeStreamingMessageId ?? null;
    if ('activeStreamingStoredSessionId' in ctx) activeStreamingStoredSessionId = ctx.activeStreamingStoredSessionId ?? null;
    if ('activeStreamingLiveId' in ctx) activeStreamingLiveId = ctx.activeStreamingLiveId ?? null;
    if ('activeStreamingBotName' in ctx) activeStreamingBotName = ctx.activeStreamingBotName ?? null;
  },
  getTurnStartedSessionId: () => turnStartedSessionId, setTurnStartedSessionId: (id) => { turnStartedSessionId = id; },
  stopProfileAutoRefresh: () => stopProfileAutoRefresh(), startProfileAutoRefresh: () => startProfileAutoRefresh(),
  stopAllGroupPollers: () => groupPollerManager.stopAll(), clearTransitionRefreshTimer: () => clearTransitionRefreshTimer(),
  clearSessionsRefreshTimer: () => {
    if (sessionsRefreshTimer) {
      clearTimeout(sessionsRefreshTimer);
      sessionsRefreshTimer = null;
    }
  },
  scheduleSessionsRefresh: () => scheduleSessionsRefresh(), persistTurnToCache: (sid, bot, msgs, gw) => persistTurnToCache(sid, bot, msgs, gw),
  persistSessionsToCache: (sessions) => persistSessionsToCache(sessions), syncProfileLastMessages: () => syncProfileLastMessages(),
  syncAgentPresence: () => syncAgentPresence(), scheduleToolPatch: (mid) => scheduleToolPatch(mid), clearToolPatchQueue: () => toolPatchQueue.clear(),
  stopRunningToolTimers: () => stopRunningToolTimers(), setMessageContent: (mid, content) => setMessageContent(mid, content),
  toStoredSessionId: (id) => toStoredSessionId(id), applyColdStartFocus: () => applyColdStartFocus(),
  fetchProfiles: () => fetchProfiles(), fetchSessions: () => fetchSessions(),
  fetchGroupRooms: () => fetchGroupRooms(), fetchModelOptions: () => fetchModelOptions(),
  fetchProjects: () => fetchProjects(), prefetchSlashCatalog: () => inputCompletion.prefetchSlashCatalog(),
  armTurnWatchdog: () => turnExecutionService.armTurnWatchdog(), feedTurnWatchdog: () => turnExecutionService.feedTurnWatchdog(), disarmTurnWatchdog: () => turnExecutionService.disarmTurnWatchdog(),
  clearPresenceTerminal: () => turnExecutionService.clearPresenceTerminal(), armPresenceTerminal: (terminal) => turnExecutionService.armPresenceTerminal(terminal),
  setTimedDockNotice: (msg, dur, opts) => turnExecutionService.setTimedDockNotice(msg, dur, opts), isStreamNearBottom: () => isStreamNearBottom(document.getElementById('conversation-stream')), setPendingScrollToBottom: (val) => renderCoordinator.setPendingScrollToBottom(val),
  refreshActiveSession: (o) => messageLoadingService.refreshActiveSession(o), onForceSyncMessageList: (f) => syncReactMessageList(f), ensureMessageWindow: (n) => ensureMessageWindow(n), setMessageWindowUserExpanded: (v) => messageWindowManager.setMessageWindowUserExpanded(v),
  render: () => render(), t,
  onStatusConnected: () => { void statusIntegration.onConnected(); },
  onStatusDisconnected: () => { statusIntegration.onDisconnected(); deliverableCoordinator.clear(); },
  onReadyEnsureDoneSessions: () => { if (state.orgPrefs.showDoneSection && state.orgContainerCollapsed.done === false && !state.doneSessionsLoaded && !state.doneLoading) void conversationOrgCoordinator.ensureDoneSessionsLoaded(); },
  onStatusTurnAction: (a, fn) => statusIntegration.onGatewayTurnAction(a, fn),
});

const armTurnWatchdog = () => turnExecutionService.armTurnWatchdog();
const disarmTurnWatchdog = () => turnExecutionService.disarmTurnWatchdog();
const isStreamingActiveForCurrentSession = () => turnExecutionService.isStreamingActiveForCurrentSession();
const clearPresenceTerminal = () => turnExecutionService.clearPresenceTerminal();
const armPresenceTerminal = (t: NonNullable<AppState['presenceTerminal']>) => turnExecutionService.armPresenceTerminal(t);
const setTimedDockNotice = (msg: string, d = 4000) => turnExecutionService.setTimedDockNotice(msg, d);
const clearTimedDockNotice = (options?: { skipRender?: boolean }) => turnExecutionService.clearTimedDockNotice(options);
const interruptTurn = () => turnExecutionService.interruptTurn();
const sendGroupMessage = (roomId: string, text: string) => turnExecutionService.sendGroupMessage(roomId, text);
const syncGroupRoomLogsToState = (roomId: string, logs: readonly GroupMessageEntry[]) => turnExecutionService.syncGroupRoomLogsToState(roomId, logs);
const refreshGroupRoomLog = (roomId: string) => turnExecutionService.refreshGroupRoomLog(roomId);
const sendMessage = (text: string) => turnExecutionService.sendMessage(text);
const routeSend = (text: string) => turnExecutionService.routeSend(text);
const enqueueDraft = () => turnExecutionService.enqueueDraft();
const handleQueueAction = (a: string, id: string) => turnExecutionService.handleQueueAction(a, id);
const runSlashCommand = (cmd: string) => inputDockController.runSlashCommand(cmd);
const askSideAgent = (k: 'btw' | 'delegation', tp: string, q: string) => turnExecutionService.askSideAgent(k, tp, q);
const armCapsuleTimers = (taskId: string) => turnExecutionService.armCapsuleTimers(taskId);

function formatTimestamp(ts: number | string, now: Date = new Date()): string {
  if (typeof ts === 'string') return ts;
  if (!ts || !Number.isFinite(ts) || ts <= 0) return '';
  const d = new Date(ts > 1e11 ? ts : ts * 1000);
  if (!Number.isFinite(d.getTime())) return '';
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  const timeStr = `${h}:${m}`;
  const isSameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  if (isSameDay) return timeStr;
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}/${d.getDate()} ${timeStr}`;
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${timeStr}`;
}

function setMessageContent(messageId: string, text: string): void {
  const target = state.messages.find((m) => m.id === messageId);
  if (!target) return;
  target.content = text;
  const el = document.getElementById(`msg-content-${messageId}`);
  if (el) {
    revealStreamingContentDisplay(el.style);
    el.innerHTML = renderMarkdown(text);
  }
}

const getConnectionEpoch = () => gatewayEventDispatcher.getConnectionEpoch();
const connect = (url?: string) => gatewayEventDispatcher.connect(url);
const disconnect = () => gatewayEventDispatcher.disconnect();
const captureStreamAnchor = (): StreamAnchor => streamViewportManager.captureStreamAnchor();
const applyStreamAnchor = (anchor: StreamAnchor, pin: boolean) => streamViewportManager.applyStreamAnchor(anchor, pin);
const stabilizeStreamAnchor = (anchor: StreamAnchor) => streamViewportManager.stabilizeStreamAnchor(anchor);

let lastInputDockSnapshot: RenderInputDockSnapshot | null = null;

function snapshotFingerprint(value: unknown): string {
  try { return JSON.stringify(value) ?? ''; } catch { return `__unserializable_${Date.now()}_${Math.random()}`; }
}

const disbandGroupRoom = (roomId: string, gatewayId?: string) => groupOperationService.disbandGroupRoom(roomId, gatewayId);

const modalInteractionController = createModalInteractionController({
  getState: () => state, commitState: (patch) => { Object.assign(state, patch); }, requestRender: () => render(),
  restoreComposerFocus: () => restoreComposerFocus(), createNewSession: (opts) => createNewSession(opts),
  deleteSession: (id, g) => deleteSession(id, g), renameSession: (id, title, g) => renameSession(id, title, g),
  pinSession: (id, g) => pinSession(id, g), archiveSession: (id, p, g) => archiveSession(id, p, g), exportMarkdown: (id, g) => exportMarkdown(id, g),
  copySessionId: (id) => copySessionId(id), openBotChat: (profile, g) => openBotChat(profile, g),
  openBotSettings: (profile) => openBotSettings(profile), openGroupRoom: (roomId, g) => openGroupRoom(roomId, g),
  createGroupRoom: (title, members) => groupOperationService.createGroupRoom(title, members),
  disbandGroupRoom: (roomId, g) => disbandGroupRoom(roomId, g), fetchGroupRooms: () => fetchGroupRooms(),
  routeSend: (text) => routeSend(text), sendGroupMessage: (roomId, text) => sendGroupMessage(roomId, text),
  requestMarkDone: (k, id, title, p, g) => conversationOrgCoordinator.requestMarkDone(k, id, title, p, g),
  restoreDone: (k, id, p, g) => conversationOrgCoordinator.restoreDone(k, id, p, g),
  moveEntityToFolder: (k, id, c, p, g) => conversationOrgCoordinator.moveEntityToFolder(k, id, c, p, g),
  promptCreateFolder: (m) => conversationOrgCoordinator.promptCreateFolder(m), promptRenameFolder: (fid, n) => conversationOrgCoordinator.promptRenameFolder(fid, n),
  confirmDeleteFolder: (fid, n) => conversationOrgCoordinator.confirmDeleteFolder(fid, n),
  openNewChatInContainer: (k, c) => { cancelColdStartFocus(); void fetchProjects(); state.selectedNewTaskProjectId = undefined; state.selectedNewTaskContainerId = c; state.newTaskModalTab = k === 'group' ? 'group' : 'solo'; state.isNewTaskModalOpen = true; render(); },
  onGroupCreatedInContainer: (rid, opts) => conversationOrgCoordinator.assignNewEntityContainer('group', rid, opts),
  t: (key, params) => t(key, params),
});

const closeConfirmModal = (action: 'ok' | 'cancel') => modalInteractionController.closeConfirmModal(action);

const inputDockController = createInputDockController({
  getState: () => state, commitState: (patch) => { Object.assign(state, patch); }, requestRender: () => render(),
  routeSend: (text) => routeSend(text), interruptTurn: () => interruptTurn(), handleRollbackCancel: () => handleRollbackCancel(),
  requestSlashCompletion: (prefix) => inputCompletion.requestSlashCompletion(prefix),
  requestPathCompletion: (query, agentItems) => inputCompletion.requestPathCompletion(query, agentItems),
  isStreamingActiveForCurrentSession: () => isStreamingActiveForCurrentSession(), t: (key, params) => t(key, params),
  clearDockNoticeDismissTimer: () => clearTimedDockNotice({ skipRender: true }),
  setTimedDockNotice: (msg, dur) => setTimedDockNotice(msg, dur), getGatewayClient: resolveActiveClient,
  ensureLiveSessionId: () => ensureLiveSessionId(), createNewSession: async () => { await createNewSession(); },
  sendMessage: (text) => sendMessage(text), interactiveService: interactiveService,
  getRpcCaller: () => rpcCaller, describeRpcError: (err) => describeRpcError(err),
  getSlashCanon: () => inputCompletion.getSlashCanon(),
  reloadSessionMessages: async (sId) => { await loadMessages(sId, undefined, resolveFocusedGatewayId(state)); },
});

const syncComposerHeight = () => {
  const inputEl = document.getElementById('dock-prompt-input') as HTMLTextAreaElement | null;
  inputDockController.syncComposerHeight(inputEl);
};
const handleSend = (source: 'button' | 'enter') => inputDockController.handleSend(source);
const addInputAttachments = (fileList: FileList | File[]) => inputDockController.addInputAttachments(fileList);
const syncComposerPoppers = () => inputDockController.syncComposerPoppers();
const syncComposerBadges = () => inputDockController.syncComposerBadges();

const leftRailController = createLeftRailController({
  getState: () => state, render: () => render(), t, showToast, describeRpcError,
  getGatewayClient: () => gatewayClient, getClientForGateway: multiGateway.coordinator.resolveClient, groupRoomStore, cancelColdStartFocus,
  selectSession: (id, opts) => selectSession(id, opts), openBotChat: (p, g) => openBotChat(p, g),
  openGroupRoom: (r, g) => openGroupRoom(r, g), fetchProjects: () => fetchProjects(), fetchGroupRooms: () => fetchGroupRooms(),
  beginLeftRailResize: (e) => beginLeftRailResize(e), getActivityVariant: () => activityIndicatorVariant,
  activeRunningSessionIds, unreadSessionIds, getActiveStreamingStoredSessionId: () => activeStreamingStoredSessionId,
  activeRunningGroupRoomIds, unreadGroupRoomIds, activeRunningBotNames, unreadBotNames,
  resolveAgentAvatar: (name) => resolveAgentAvatar(name), activityTransitionTracker,
  onToggleContainer: (cid) => conversationOrgCoordinator.toggleContainer(cid), onRetryDoneSection: () => { void conversationOrgCoordinator.ensureDoneSessionsLoaded(true); },
  onRequestMarkDone: (k, id, title, p, g) => conversationOrgCoordinator.requestMarkDone(k, id, title, p, g),
  onRestoreDone: (k, id, p, g) => { void conversationOrgCoordinator.restoreDone(k, id, p, g); },
  onSearchQueryChanged: (q) => conversationOrgCoordinator.onSearchQueryChanged(q),
  getMoveEntityContext: (k, id, p, g) => conversationOrgCoordinator.getMoveEntityContext(k, id, p, g),
});

const createLeftRailActions = (): LeftRailActions => leftRailController.createLeftRailActions();
const confirmGroupRename = (roomId: string, name: string, g?: string) => leftRailController.confirmGroupRename(roomId, name, g);
const decorateRailSessions = (nowMs: number): LeftRailSession[] => leftRailController.decorateRailSessions(nowMs);
const decorateRailGroups = (nowMs: number): LeftRailGroupRoom[] => leftRailController.decorateRailGroups(nowMs);
const decorateRailProfiles = (nowMs: number): LeftRailProfile[] => leftRailController.decorateRailProfiles(nowMs);
const getLeftRailSnapshot = (): LeftRailSnapshot => leftRailController.getLeftRailSnapshot();

let reactMessageList: ConversationMount | null = null, reactMessageListHost: HTMLElement | null = null;
let renderedMessageIds = new Set<string>(), lastSeenStreaming = false;

const mediaResolver = createMediaResolver({ getState: () => state, getDesktopApi: () => desktopApi, getGatewayClient: () => gatewayClient, getClientForGateway: multiGateway.coordinator.resolveClient, getGatewayUrlForGateway: multiGateway.coordinator.getGatewayUrl });
const resolveSessionKnownFiles = createSessionKnownFilesResolver(() => state.messages, {
  getVerifiedPaths: () => deliverableCoordinator.getVerifiedPaths(), getSubagentWrittenPaths: () => deliverableCoordinator.getSubagentWrittenPaths(),
});

const statusIntegration = createStatusIntegration({
  getState: () => state, getGatewayClient: resolveActiveClient,
  getSessionHandleRegistry: () => multiGateway.coordinator.getActiveHandleRegistry(),
  getSessionMessagesCache: () => sessionMessagesCache, isStreamingActiveForCurrentSession: () => isStreamingActiveForCurrentSession(),
  getActiveStreamingStoredSessionId: () => activeStreamingStoredSessionId, getActiveStreamingMessageId: () => activeStreamingMessageId,
  formatTimestamp: (ts) => formatTimestamp(ts), scheduleToolPatch: (mid) => scheduleToolPatch(mid),
  syncReactMessageList: (f) => renderCoordinator.syncReactMessageList(f), syncRightPod: () => renderCoordinator.syncRightPod(),
  syncTitlebar: () => renderCoordinator.syncTitlebar(), openFilePreview: (p) => handleOpenFilePreview(p),
  syncComposerHeight: (el) => inputDockController.syncComposerHeight(el), setTimedDockNotice: (m, d) => setTimedDockNotice(m, d),
  onOpenConstellation: (profileName) => settingsDataService.openBotSettings(profileName, { tab: 'constellation' }),
  render: () => render(), t,
});
const deliverableCoordinator = createSessionDeliverableCoordinator({
  getState: () => state, getDesktopApi: () => desktopApi, getGatewayUrlForGateway: multiGateway.coordinator.getGatewayUrl,
  getSubagentWrittenPaths: () => statusIntegration.getActiveSubagentWrittenPaths(),
  onVerifiedPathsUpdated: () => { renderCoordinator.syncReactMessageList(true); render(); },
});

const renderCoordinator = createRenderCoordinator({
  getState: () => state, messageWindowManager, modalInteractionController,
  isStreamingActiveForCurrentSession: () => isStreamingActiveForCurrentSession(),
  resolveSessionKnownFiles: () => resolveSessionKnownFiles(),
  getVerifiedDeliverablePaths: deliverableCoordinator.getVerifiedPaths, getSubagentWrittenPaths: deliverableCoordinator.getSubagentWrittenPaths,
  getSessionDeliverables: deliverableCoordinator.getSessionDeliverables, scheduleDeliverableVerification: deliverableCoordinator.scheduleVerification, clearDeliverables: deliverableCoordinator.clear,
  resolveMediaUrl: mediaResolver.resolveMediaUrl, onOpenFile: (p, u) => { void handleOpenFilePreview(p, u); }, onDownloadMediaItem: (item) => { void fileViewerService.downloadMedia(item); },
  getTitlebarSnapshot: () => titlebarController.getTitlebarSnapshot(),
  onMinimizeWindow: () => titlebarController.onMinimizeWindow(), onMaximizeWindow: () => titlebarController.onMaximizeWindow(),
  onCloseWindow: () => titlebarController.onCloseWindow(),
  onToggleInspector: () => statusIntegration.onToggleInspector(),
  onReconnectGateway: (gid) => { void multiGateway.coordinator.reconnectGateway(gid); }, onDisconnectGateway: (gid) => { multiGateway.coordinator.disconnectGateway(gid); }, onManageGateways: multiGateway.coordinator.onManageGateways,
  getRightPodSnapshot: () => statusIntegration.getRightPodSnapshot(),
  getRightPodActions: () => statusIntegration.getRightPodActions(),
  getLeftRailSnapshot: () => getLeftRailSnapshot(), createLeftRailActions: () => createLeftRailActions(),
  getPromptNavigatorSnapshot: () => getPromptNavigatorSnapshot(), createPromptNavigatorActions: () => createPromptNavigatorActions(),
  setPromptNavigatorUpdateHandler: (handler) => promptNavigatorManager.setUpdateHandler(handler),
  rebuildPromptEntries: () => rebuildPromptEntries(), syncPromptNavigatorMeta: () => syncPromptNavigatorMeta(),
  syncPromptNavigator: () => syncPromptNavigator(), syncReactSettings: () => syncReactSettings(),
  ensureSettingsSectionData: (section) => ensureSettingsSectionData(section), syncAgentPresenceHost: () => syncAgentPresenceHost(),
  syncAgentPresence: () => syncAgentPresence(), captureStreamAnchor: () => captureStreamAnchor(),
  applyStreamAnchor: (anchor, pin) => applyStreamAnchor(anchor, pin), stabilizeStreamAnchor: (anchor) => stabilizeStreamAnchor(anchor),
  isStreamNearBottom: (stream) => isStreamNearBottom(stream), syncStreamBottomInset: () => syncStreamBottomInset(),
  settleInitialBottom: () => settleInitialBottom(), bindEvents: () => bindEvents(),
  // React 提交后驱动：提交后重新对齐 armed 计划（观察器合并到一帧），语义见 streamViewportManager.reassertActivePin。
  isSessionEnterPending: () => streamViewportManager.isSessionEnterPending(), settleSessionEnter: (probe, sessionId, phase, count, authoritativeReady) => streamViewportManager.settleSessionEnter(probe, sessionId, phase, count, authoritativeReady), reassertActivePin: () => streamViewportManager?.reassertActivePin(),
  markProgrammaticScroll: (stream) => markProgrammaticScroll(stream),
  syncComposerPoppers: () => syncComposerPoppers(), syncComposerBadges: () => syncComposerBadges(), logRender,
  onRetryConnect: gatewayEventDispatcher.retryNow,
});

const lockAverageRowHeight = () => { const r = messageWindowManager.lockAverageRowHeight(); syncWindowLocalState(); return r; };
const syncCanvasVirtualHeight = () => messageWindowManager.syncCanvasVirtualHeight();
const observeVirtualWindowGeometry = (att = 0) => { messageWindowManager.observeVirtualWindowGeometry(att); syncWindowLocalState(); };
const computeContentOffsetPx = () => messageWindowManager.computeContentOffsetPx();
const computeVirtualHeightPx = () => messageWindowManager.computeVirtualHeightPx();
const buildConversationSnapshot = (): ConversationSnapshot => renderCoordinator.buildConversationSnapshot();
const syncReactMessageList = (force = false) => renderCoordinator.syncReactMessageList(force);

let agentPresenceHost: HTMLElement | null = null;
let lastAgentPresenceFingerprint = '';
let presenceMountHandle: ConversationMount | null = null;

function ensurePresenceTicker(kind: AgentPresence['kind']): void {
  if (kind !== 'idle') {} else if (typeof clearInterval === 'function') { clearInterval(0); }
  presenceController.ensurePresenceTicker(kind);
}

function ensureAgentPresenceHost(layout: 'stage' | 'dock'): HTMLElement | null {
  if (!state.gatewayConnected) {
    presenceMountHandle?.unmount();
    presenceMountHandle = null;
    agentPresenceHost?.remove();
    agentPresenceHost = null;
    let pendingPresenceSnapshot: AgentPresenceSnapshot | null = null; pendingPresenceSnapshot = null;
    lastAgentPresenceFingerprint = '';
    ensurePresenceTicker('idle');
    presenceController.resetPresenceHost();
    return null;
  }
  const pod = document.querySelector<HTMLElement>('.flux-middle-pod');
  const dock = document.querySelector<HTMLElement>('.input-dock-container');
  let host = document.getElementById('react-conv-presence-host');
  if (host?.dataset.mobileSlot === 'true' && host.isConnected) return host;
  if (layout === 'dock') {
    if (!dock) return host;
    if (!host) {
      host = document.createElement('div');
      host.id = 'react-conv-presence-host';
    }
    host.classList.add('presence-host--dock');
    if (!host.closest('.dock-actionbar') && (host.parentElement !== dock || dock.firstElementChild !== host)) {
      dock.insertBefore(host, dock.firstElementChild);
    }
    return host;
  }
  host?.classList.remove('presence-host--dock');
  if (!pod) return host;
  if (!host) {
    host = document.createElement('div');
    host.id = 'react-conv-presence-host';
  }
  if (host.parentElement !== pod) {
    const stream = pod.querySelector('#conversation-stream');
    if (stream?.nextSibling) pod.insertBefore(host, stream.nextSibling);
    else pod.appendChild(host);
  }
  return host;
}

let turnStartedSessionId: string | null = null;
const scrollEndController = createScrollEndController({
  isGatewayConnected: () => state.gatewayConnected,
  getPresenceLayout: () => state.presenceLayout,
  getLang: () => state.lang,
  t: (key) => t(key),
  getStreamElement: () => document.getElementById('conversation-stream'),
  getDockElement: () => document.querySelector<HTMLElement>('.input-dock-container'),
  isSessionEnterPending: () => streamViewportManager.isSessionEnterPending(),
  isInitialBottomSettling: () => streamSettleState.initialBottomSettling,
  scrollStreamToEndSmooth: (target) => streamViewportManager.scrollStreamToEndSmooth(target),
  scrollStreamToBottomFallback: (reason) => scrollStreamToBottom(reason),
  mountButton: (host, getSnapshot) => mountScrollToEndButton(host, getSnapshot),
});

const presenceController = createPresenceController({
  getState: () => state,
  resolveAgentAvatar: (name) => resolveAgentAvatar(name),
  isGroupConversationActive: () => isGroupConversationActive(),
  isStreamingActiveForCurrentSession: () => isStreamingActiveForCurrentSession(),
  getTurnStartedSessionId: () => turnStartedSessionId,
  activeRunningGroupRoomIds,
  mountAgentPresence: (host, getSnapshot) => mountAgentPresence(host, getSnapshot),
  ensureAgentPresenceHost: (layout) => ensureAgentPresenceHost(layout),
});

function syncAgentPresenceHost(): void {
  const presenceHost = ensureAgentPresenceHost(state.presenceLayout);
  presenceController.syncAgentPresenceHost();
  scrollEndController.syncHost();
}

function syncAgentPresence(): void {
  if (!agentPresenceHost?.isConnected) {
    syncAgentPresenceHost();
  }
  presenceController.syncAgentPresence();
}

const resolvePresenceDomain = () => ({
  groupRoomId: state.activeFocus.type === 'group' ? state.activeFocus.roomId : null,
  isRunning: false,
});
const ensureGroupTurnClock = (r: string | null, isRunning: boolean) => presenceController.ensureGroupTurnClock(r, isRunning);
const buildAgentPresenceSnapshot = (): AgentPresenceSnapshot => presenceController.getSnapshot();
const getAgentPresenceSnapshot = (): AgentPresenceSnapshot => presenceController.getSnapshot();

const learningService = createLearningService({
  getState: () => state, render: () => render(), getGatewayClient: resolveActiveClient, getDesktopApi: () => desktopApi,
  getCurrentTicket: () => currentTicket ?? null,
  getEffectiveUrl: (url) => getEffectiveUrl(url ?? multiGateway.coordinator.getActiveGatewayUrl(state.gatewayUrl)),
  t, describeRpcError,
});
const settingsDataService = createSettingsDataService({
  getState: () => state, getGatewayClient: resolveActiveClient, getDesktopApi: () => desktopApi,
  getCurrentTicket: () => currentTicket ?? null,
  getEffectiveUrl: (url) => getEffectiveUrl(url || multiGateway.coordinator.getActiveGatewayUrl(state.gatewayUrl)),
  render: () => render(), t: (key, params) => t(key, params), describeRpcError: (error) => describeRpcError(error),
  showToast: (message, durationMs) => showToast(message, durationMs), bootLog,
  fetchModelOptions: async (opts) => fetchModelOptions(opts), fetchProfiles: async (opts) => fetchProfiles(opts),
  testConnection: (url, user, pass) => testConnection(url, user, pass),
  connect: async () => bootstrapGwHandlers.onSettingsConnect(),
  disconnect: () => disconnect(), getFontPreferences: () => fontPreferences,
  setFontPreferences: (prefs) => { fontPreferences = prefs; }, applyFontPreferences: (prefs) => applyFontPreferences(prefs),
  getActivityIndicatorVariant: () => activityIndicatorVariant, setActivityIndicatorVariant: (v) => { activityIndicatorVariant = v; },
  saveActivityIndicatorVariant: (v) => saveActivityIndicatorVariant(v), resolveActivityIndicatorVariant: (v) => resolveActivityIndicatorVariant(v),
  resolveSkinId: (theme) => resolveSkinId(theme), writePresenceLayout: (layout) => writePresenceLayout(layout === 'dock' ? 'dock' : 'stage'),
  onPresenceLayoutChanged: () => {
    agentPresenceHost = null; lastAgentPresenceFingerprint = ''; presenceController.resetPresenceHost();
    scrollEndController.syncHost();
  },
  profileAvatarCache, persistAvatarCache: () => persistAvatarCache(),
  persistAgentsToCache: (profiles) => persistAgentsToCache(profiles), learningService,
  fetchProjects: () => fetchProjects(), createProject: (p) => projectOperationService.createProject(p),
  updateProject: (id, patch) => projectOperationService.updateProject(id, patch), deleteProject: (id) => projectOperationService.deleteProject(id), onOrgPrefsChange: (p) => conversationOrgCoordinator.setOrgPrefs(p),
});
const scopedProfileName = () => settingsDataService.scopedProfileName();
const subscriptionProfileName = () => settingsDataService.subscriptionProfileName();
const botRoster = () => settingsDataService.botRoster();
const reloadProviderCatalog = () => settingsDataService.reloadProviderCatalog();
const openBotSettings = (botId: string) => settingsDataService.openBotSettings(botId);
const getBotManagementSnapshot = () => settingsDataService.getBotManagementSnapshot();
const getSettingsSnapshot = () => settingsDataService.getSettingsSnapshot();
const ensureSettingsSectionData = (section: SettingsSectionId, force = false) => settingsDataService.ensureSettingsSectionData(section, force);
const createSettingsActions = (): SettingsActions => settingsDataService.createSettingsActions();
const syncReactSettings = () => settingsDataService.syncReactSettings();
const syncLocale = () => { setLocale(state.lang === 'en' ? 'en-US' : 'zh-CN'); scrollEndController.syncHost(); };
const mountReactShellComponents = () => renderCoordinator.mountReactShellComponents();
const render = () => renderCoordinator.render();
const fileViewerService = createFileViewerService({
  getState: renderCoordinator.getState, render, getDesktopApi: () => desktopApi, getGatewayClient: resolveActiveClient, safeCopyText, t,
  onBackFromFiles: () => statusIntegration.onBackFromFiles(), onInspectorStateChange: () => statusIntegration.onInspectorStateChange(),
  onMobileOpenFile: async (p, u) => { if (!renderCoordinator.isMobileShellActive()) return false; await mobileShellCoordinator.openFileInReader(p, u); return true; },
  onOpenMediaLightbox: renderCoordinator.openMediaLightbox, getSessionDeliverables: deliverableCoordinator.getSessionDeliverables,
});
const handleOpenFilePreview = fileViewerService.handleOpenFilePreview;
const mobileShellCoordinator = createMobileShellCoordinator({
  getState: renderCoordinator.getState, render, leftRailController, resolveAgentAvatar,
  selectSession, openBotChat, openGroupRoom, createNewSession,
  renameSession: sessionOperationService.renameSession.bind(sessionOperationService),
  pinSession, archiveSession, deleteSession,
  createGroupRoom: groupOperationService.createGroupRoom, confirmGroupRename, disbandGroupRoom, fetchGroupRooms,
  routeSend, sendGroupMessage, interruptTurn, switchModel,
  fetchModelOptions: () => fetchModelOptions({ clearNotice: false }), onFilesPicked: addInputAttachments,
  loadFileTree: fileViewerService.loadFileTree, toggleFileTreeDir: fileViewerService.toggleDirectory,
  setFileTreeFilter: fileViewerService.setFileTreeFilter, openWorkspaceFile: (p) => fileViewerService.handleOpenFilePreview(p, undefined, { skipMobileRedirect: true }),
  downloadFile: (filePath?: string) => fileViewerService.downloadFile(filePath), downloadMediaItem: fileViewerService.downloadMedia, resolveMediaUrl: mediaResolver.resolveMediaUrl,
  getVerifiedDeliverablePaths: deliverableCoordinator.getVerifiedPaths, getSubagentWrittenPaths: deliverableCoordinator.getSubagentWrittenPaths, getSessionDeliverables: deliverableCoordinator.getSessionDeliverables,
  loadLearningGraph: learningService.loadLearningGraph, loadLearningDetail: learningService.loadLearningDetail,
  editLearningNode: learningService.editLearningNode, deleteLearningNode: learningService.deleteLearningNode,
  getSettingsSnapshot, createSettingsActions, ensureSettingsSectionData,
  copyText: safeCopyText, syncReactMessageList, syncAgentPresenceHost, syncAgentPresence,
  onToggleContainer: (cid) => conversationOrgCoordinator.toggleContainer(cid), onRetryDoneSection: () => { void conversationOrgCoordinator.ensureDoneSessionsLoaded(true); }, onSearchQueryChanged: (q) => conversationOrgCoordinator.onSearchQueryChanged(q),
  markDoneConfirmed: (k, id, p, g) => conversationOrgCoordinator.markDoneConfirmed(k, id, p, g), restoreDone: (k, id, p, g) => conversationOrgCoordinator.restoreDone(k, id, p, g),
  moveEntityToFolder: (k, id, c, p, g) => conversationOrgCoordinator.moveEntityToFolder(k, id, c, p, g), createFolder: (n, m) => conversationOrgCoordinator.createFolder(n, m),
  renameFolder: (fid, n) => conversationOrgCoordinator.renameFolder(fid, n), deleteFolder: (fid) => conversationOrgCoordinator.deleteFolder(fid),
  assignNewEntityContainer: (k, id, o) => conversationOrgCoordinator.assignNewEntityContainer(k, id, o), setOrgPrefs: (p) => conversationOrgCoordinator.setOrgPrefs(p),
  onEnterStage: () => { void messageLoadingService.refreshActiveSession({ checkLiveTurn: true }); }, onRetryConnect: gatewayEventDispatcher.retryNow,
});
renderCoordinator.setMobileShellCoordinator(mobileShellCoordinator);
const foregroundSyncCoordinator = createForegroundSyncCoordinator({
  getState: renderCoordinator.getState, render, fetchProfiles, fetchSessions, fetchGroupRooms,
  prefetchSlashCatalog: inputCompletion.prefetchSlashCatalog, fetchModelOptions, fetchProjects,
  onReadyEnsureDoneSessions: () => { if (state.orgPrefs.showDoneSection && state.orgContainerCollapsed.done === false && !state.doneSessionsLoaded && !state.doneLoading) void conversationOrgCoordinator.ensureDoneSessionsLoaded(); },
  refreshConversationOrgIfStale: () => { conversationOrgCoordinator.refreshOnFocusIfStale(); },
  refreshActiveSession: messageLoadingService.refreshActiveSession.bind(messageLoadingService),
  refreshGroupRoomLog, openBotChat,
  ...createActiveViewSyncAdapters({
    getState: renderCoordinator.getState, isMobileShellActive: renderCoordinator.isMobileShellActive,
    getMobileViewContext: mobileShellCoordinator.getActiveViewContext, settingsDataService,
    fileViewerService, groupPollerManager,
    getGroupRoomLogs: (roomId) => groupRoomStore.getLogs(roomId),
    hostedRoomIds, activeRunningGroupRoomIds,
  }),
});
gatewayEventDispatcher.setSyncHooks({ onConnectedSync: foregroundSyncCoordinator.syncOnConnected, onResumeAliveSync: foregroundSyncCoordinator.syncOnResumeAlive });
messageLoadingService.setReconnectHooks({ onReconnectStillStreaming: gatewayEventDispatcher.resumeReconnectStreaming, onReconnectStreamFinished: gatewayEventDispatcher.finishReconnectStreaming, onActiveTurnDiscovered: gatewayEventDispatcher.attachLiveTurnFromResume, onForceSyncMessageList: syncReactMessageList });
if (typeof window !== 'undefined') {
  window.__fluxRender = render;
  window.__fluxConnect = connect;
  window.__fluxSelectSession = selectSession;
}

function bindEvents(): void {
  fileViewerService.bindEvents();
  conversationStreamController.bindDomEvents();
  if (renderCoordinator.isMobileShellActive()) return;
  onboardingController.bindDomEvents();
  modalInteractionController.bindDomEvents();
  inputDockController.bindDomEvents();
  const attachBtn = document.getElementById('dock-attach-file-btn');
  if (attachBtn) attachBtn.onclick = () => inputDockController.openBrowserFilePicker();

  const dockContainer = document.querySelector<HTMLElement>('.input-dock-container');
  if (dockContainer && !dockContainer.dataset.dockClickBound) {
    dockContainer.dataset.dockClickBound = 'true';
    dockContainer.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      const cancelAction = target.closest<HTMLElement>('[data-action="rollback-cancel"]');
      if (cancelAction) { e.stopPropagation(); e.preventDefault(); handleRollbackCancel(); }
    });
  }
  bindModelDropdownEvents();
  bindRailResizeEvents();
}

const conversationStreamController = createConversationStreamController({
  getState: () => state, render: () => render(), safeCopyText: (text) => safeCopyText(text),
  syncScrollToEndVisibility: () => scrollEndController.syncVisibility(),
  isSmoothScrollActive: () => scrollEndController.isSmoothScrollActive(),
  setTimedDockNotice: (msg, dur) => setTimedDockNotice(msg, dur), isStreamingActiveForCurrentSession: () => isStreamingActiveForCurrentSession(),
  t: (key) => t(key), getGatewayClient: resolveActiveClient, getRpcCaller: () => rpcCaller,
  getInteractiveService: () => interactiveService,
  selectSession: (id) => selectSession(id, { gatewayId: resolveFocusedGatewayId(state) }),
  scheduleSessionsRefresh: () => scheduleSessionsRefresh(), getSessionMessagesCache: () => sessionMessagesCache,
  handleOpenFilePreview: (path, url) => handleOpenFilePreview(path, url), syncPromptNavigatorFromScroll: () => syncPromptNavigatorFromScroll(),
  onOpenSubagent: (sid) => statusIntegration.onOpenSubagent(sid),
  loadOlderMessages: (opts) => loadOlderMessages(opts), relocateMessageWindowToIndex: (idx) => relocateMessageWindowToIndex(idx),
  syncScrollTopToWindow: (reason) => syncScrollTopToWindow(reason), slideMessageWindowForward: () => slideMessageWindowForward(),
  expandMessageWindow: () => expandMessageWindow(), settleInitialBottom: () => settleInitialBottom(),
  scrollStreamToBottom: (reason) => scrollStreamToBottom(reason), scheduleStreamBottomInset: () => scheduleStreamBottomInset(),
  layoutSignature: () => layoutSignature(), ensureLiveSessionId: () => ensureLiveSessionId(),
  getMessageWindowStart: () => messageWindowManager.getMessageWindowStart(), getMessageWindowEnd: () => messageWindowManager.getMessageWindowEnd(),
  isMessageWindowUserExpanded: () => messageWindowManager.isMessageWindowUserExpanded(), setMessageWindowUserExpanded: (val) => messageWindowManager.setMessageWindowUserExpanded(val),
  getAverageRowHeightPx: () => messageWindowManager.getAverageRowHeightPx(), isInitialBottomSettling: () => streamSettleState.initialBottomSettling,
  setInitialBottomSettling: (val) => { streamSettleState.initialBottomSettling = val; }, getStreamScrollCooldown: () => streamScrollCooldown > Date.now(),
  setStreamScrollCooldown: (val) => { streamScrollCooldown = val ? Date.now() + 180 : 0; },
  getLastStreamScrollTop: () => lastStreamScrollTop, setLastStreamScrollTop: (val) => { lastStreamScrollTop = val; },
  getProgrammaticScrollTarget: () => programmaticScrollTarget, setProgrammaticScrollTarget: (val) => { programmaticScrollTarget = val; },
  getProgrammaticScrollIgnoreUntil: () => programmaticScrollIgnoreUntil, getLayoutDriftUntil: () => layoutDriftUntil,
  getReaderScrolledSessionId: () => readerScrolledSessionId ?? '', setReaderScrolledSessionId: (val) => { readerScrolledSessionId = val || null; },
  setSettledLayoutSignature: (val) => { streamSettleState.settledLayoutSignature = val; },
  isSessionEnterPending: () => streamViewportManager?.isSessionEnterPending() ?? false,
  cancelSessionEnter: () => streamViewportManager?.cancelSessionEnter(),
  STICK_TO_BOTTOM_THRESHOLD_PX, MESSAGE_WINDOW_CAPACITY,
});

const onboardingController = createOnboardingController({
  getState: () => state, render: () => render(), connect: () => { void connect(); },
  testConnection: (url, user, pass) => testConnection(url, user, pass), switchApproval: (mode) => switchApproval(mode),
  getDesktopApi: () => desktopApi, t, fetchModelOptions: async () => fetchModelOptions(),
  hideModelCascade: () => hideModelCascade(), resetModelSearchOnOpen: () => resetModelSearchOnOpen(),
});

const handleCopyMessage = (btn: HTMLElement) => conversationStreamController.handleCopyMessage(btn);
const handleRollbackMessage = (btn: HTMLElement) => conversationStreamController.handleRollbackMessage(btn);
const handleRollbackCancel = () => conversationStreamController.handleRollbackCancel();
const handleForkMessage = (btn: HTMLElement) => conversationStreamController.handleForkMessage(btn);

if (typeof window !== 'undefined') {
  window.__fluxMessageActions = { handleCopyMessage, handleRollbackMessage, handleForkMessage };
}

const stopRunningToolTimers = () => conversationStreamController.stopRunningToolTimers();
const updateRunningToolTimers = () => conversationStreamController.updateRunningToolTimers();

const dropdownKeybindController = createDropdownKeybindController({
  getState: () => state, render: () => render(),
  switchModel: (model, provider) => switchModel(model, provider), switchReasoning: (level) => switchReasoning(level),
  modalInteractionController, ensureSettingsSectionData: (section) => ensureSettingsSectionData(section),
  requestSettingsExit: () => settingsDataService.requestSettingsExit(), getLastInputDockSnapshot: () => renderCoordinator.getLastInputDockSnapshot(),
  setLastInputDockSnapshot: (snapshot) => renderCoordinator.setLastInputDockSnapshot(snapshot),
  onToggleInspector: () => statusIntegration.onToggleInspector(),
});

// streamScrollCooldown = false; streamEl.scrollTop > lastStreamScrollTop + 4
/*
modelBtn.onclick = (e) => {
  resetModelSearchOnOpen();
  modelBtn.setAttribute('aria-expanded', 'true');
  lastInputDockSnapshot = { modelMenuOpen: state.modelMenuOpen } as any;
};
*/
// Bind dropdown options
const bindModelDropdownEvents = () => dropdownKeybindController.bindModelDropdownEvents();
function pickReasoningLevel(item: HTMLElement): void {
  // returnToModel .focus({ preventScroll: true })
  dropdownKeybindController.pickReasoningLevel(item);
}
const hideModelCascade = () => dropdownKeybindController.hideModelCascade();
const scheduleHideModelCascade = () => dropdownKeybindController.scheduleHideModelCascade();
const cancelHideModelCascade = () => dropdownKeybindController.cancelHideModelCascade();
function resetModelSearchOnOpen(): void {
  dropdownKeybindController.resetModelSearchOnOpen();
  state.modelSearchQuery = '';
  // lastInputDockSnapshot updateModelDropdownSubtree()
}
function showModelCascade(row: HTMLElement): void {
  dropdownKeybindController.showModelCascade(row);
}
function closeModelMenu(): void {
  // hideModelCascade() dropdown.style.display = 'none' trigger.setAttribute('aria-expanded', 'false')
  dropdownKeybindController.closeModelMenu();
}
function updateModelDropdownSubtree(): void {
  dropdownKeybindController.updateModelDropdownSubtree();
}

dropdownKeybindController.setupGlobalKeybinds();
dropdownKeybindController.setupOutsideClickHandlers();

const bootstrapGwHandlers = createAppBootstrapGatewayHandlers({
  multiGateway,
  connectLegacy: () => connect(),
  wakeLegacy: (reason) => gatewayEventDispatcher.wakeOrRetry(reason),
  syncOnConnected: () => foregroundSyncCoordinator.syncOnConnected('connected'),
  syncOnResumeAlive: () => foregroundSyncCoordinator.syncOnResumeAlive(),
});

const appBootstrap = createAppBootstrap({
  getState: () => state, render: () => render(), getDesktopApi: () => desktopApi,
  getGatewayClient: resolveActiveClient,
  connect: () => bootstrapGwHandlers.connect(),
  restoreCacheToState: () => restoreCacheToState(), refreshProfilesFromServer: () => refreshProfilesFromServer(),
  onWakeOrRetry: (reason) => bootstrapGwHandlers.onWakeOrRetry(reason),
  onAppPause: foregroundSyncCoordinator.onAppPause,
  onNetworkOffline: gatewayEventDispatcher.markNetworkOffline,
  syncSystemWindow: () => titlebarController.syncSystemWindow(), fontPreferences,
  logBoot: (info) => logApp.info('renderer boot', { level: getLogLevel(), ...info }),
  logLayoutShift: (info) => logScroll.debug('layout shift', { ...info, streaming: state.isStreaming }),
});

const isConversationDemoMode = () => appBootstrap.isConversationDemoMode();
const injectConversationDemo = () => appBootstrap.injectConversationDemo();
const refreshProfilesFromServer = () => fetchProfiles({ refresh: true });

async function init(): Promise<void> {
  const restoredLeft = clampLeftRailWidth(localStorage.getItem('hermes_flux_rail_w_left') || localStorage.getItem('hermes_aura_rail_w_left'));
  document.documentElement.style.setProperty('--rail-w-left', `${restoredLeft}px`);
  localStorage.setItem('hermes_flux_rail_w_left', String(restoredLeft));
  await appBootstrap.init();
  bootstrapGwHandlers.bootstrapPostInit();
}

init();
