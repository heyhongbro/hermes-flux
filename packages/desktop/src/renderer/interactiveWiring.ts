/**
 * 桌面与移动端交互式停靠宿主装配模块 (Interactive Wiring)
 *
 * 【设计意图 (Why)】
 *   入口文件 `index.ts` 已逼近 1500 行工程门禁硬上限，因此将交互停靠卡宿主挂载
 *   （`#react-interactive-prompt-host`）、后台等待顶部提醒胶囊挂载
 *   （`#react-interactive-top-pill-host`）、Bot 终身会话表解析以及防偷焦的
 *   `[data-flux-island]` / 密码输入焦保护逻辑集中抽离至此模块。
 *
 * 【防范的历史坑 (Pitfall)】
 *   1. `mountInteractivePromptHost` 与 `mountInteractiveTopPill` 返回的是只读更新闭包 `() => void`，
 *      并非 `{ update, unmount }` 对象；当断连或视口切为 mobile 时通过返回空列表驱动 React 渲染 `null`；
 *   2. 视口模式判定必须使用统一 `resolveWorkspaceShellMode({ platform: state.platform, hasMobileBridge, search }) === 'desktop'`，
 *      严禁硬编码 `> 900` 像素阈值以免窄窗平板桌面偏移；
 *   3. `renderCoordinator.ts` 与 `restoreComposerFocus()` 会读取 `document.activeElement` 并回拉焦点，
 *      必须由 `isProtectedIslandFocus` 屏蔽 `[data-flux-island]` 及 `type === 'password'` 输入框；
 *   4. 外部授权链接 (`openExternalUrl`) 在唤起前必须经由 `isSafeExternalUrl` 二次校验。
 *
 * 【约束与规则 (Rules)】
 *   - 单向依赖：通过 Deps 回调接入主状态，禁止反向 import `index.ts`；
 *   - 0 TS 报错，严禁 `as any`。
 */

import type { BackgroundWaitingSummary, TurnAction } from '@hermes-flux/core';
import {
  isSafeExternalUrl,
  mountInteractivePromptHost,
  mountInteractiveTopPill,
  resolveWorkspaceShellMode,
  type InteractivePromptHostSnapshot,
  type InteractiveTopPillSnapshot,
  type MessageViewModel,
} from '@hermes-flux/ui';
import type { HermesDesktopBridge } from '../preload/index.js';
import type { AppState } from './state/appState.js';
import {
  createInteractivePromptService,
  type InteractivePromptService,
} from './services/interactivePromptService.js';
import { createLogger, type HermesGatewayClient, type SessionHandleRegistry } from '@hermes-flux/core';
import type { I18nKey } from '@hermes-flux/ui';

const interactiveLog = createLogger('interactive');

export interface InteractiveWiringDeps {
  readonly service: InteractivePromptService;
  readonly getState: () => AppState;
  readonly getDesktopApi: () => HermesDesktopBridge | undefined;
  readonly selectSession: (sessionId: string, opts?: { botName?: string }) => Promise<void> | void;
  readonly openBotChat: (botName: string) => Promise<void> | void;
  readonly openGroupRoom: (roomId: string) => Promise<void> | void;
  readonly syncStreamBottomInset: () => void;
  readonly render: () => void;
  readonly mountPromptHost?: typeof mountInteractivePromptHost;
  readonly mountTopPill?: typeof mountInteractiveTopPill;
}

/**
 * 延迟恢复桌面端输入框焦点（跳过受保护交互岛与密码输入）。
 */
export function scheduleRestoreComposerFocus(): void {
  if (typeof document === 'undefined' || isProtectedIslandFocus(document.activeElement)) return;
  setTimeout(() => {
    const input = document.getElementById('dock-prompt-input') as HTMLTextAreaElement | null;
    if (input && !isProtectedIslandFocus(document.activeElement) && document.activeElement !== input) {
      input.focus();
    }
  }, 30);
}

export interface InteractiveWiringController {
  syncHosts(): void;
  selectBackgroundSummary(summary: BackgroundWaitingSummary): void;
  openSafeExternalUrl(url: string): void;
  resolveEntityLabel(summary: BackgroundWaitingSummary): string;
  dispose(): void;
}

/**
 * 判定当前焦点是否位于受保护的 React 交互岛（停靠卡/弹窗等）或敏感密码输入框内部，
 * 为 true 时外层 `render()` 与 `restoreComposerFocus()` 严禁跨组件抢焦点或读取 `.value`。
 */
export function isProtectedIslandFocus(activeEl: Element | null | undefined): boolean {
  if (!activeEl) return false;
  if (typeof (activeEl as HTMLElement).closest === 'function') {
    if ((activeEl as HTMLElement).closest('[data-flux-island]')) {
      return true;
    }
  }
  if (
    typeof HTMLInputElement !== 'undefined' &&
    activeEl instanceof HTMLInputElement &&
    activeEl.type === 'password'
  ) {
    return true;
  }
  return false;
}

/**
 * 动态同步桌面端顶部待处理提醒胶囊的纵向避让偏移量。
 *
 * 【设计意图 (Why)】
 *   消除 `conversation.css` 中 `#react-interactive-top-pill-host[data-top-offset="below-presence"]`
 *   此前无 DOM 驱动的死选择器，并确保提醒胶囊与舞台中央的 ConnectionStatusPill（10px 起）
 *   或 stage 模式 AgentPresence（24px 起，含 56px 头像与文案）在纵向彻底避让不重叠。
 */
export function syncInteractiveTopPillOffset(): void {
  if (typeof document === 'undefined' || typeof document.getElementById !== 'function') {
    return;
  }
  const pillHost = document.getElementById('react-interactive-top-pill-host');
  if (!pillHost) return;

  const connHost = document.getElementById('react-conv-connection-host');
  const hasVisibleConnectionPill = Boolean(
    connHost &&
      ((typeof connHost.childElementCount === 'number' && connHost.childElementCount > 0) ||
        Boolean(connHost.firstElementChild)),
  );
  if (hasVisibleConnectionPill) {
    if (pillHost.dataset) {
      pillHost.dataset.topOffset = 'below-connection';
    } else {
      pillHost.setAttribute?.('data-top-offset', 'below-connection');
    }
    return;
  }

  const presenceHost = document.getElementById('react-conv-presence-host');
  const hasVisibleStagePresence = Boolean(
    presenceHost &&
      presenceHost.dataset?.mobileSlot !== 'true' &&
      !presenceHost.classList?.contains?.('presence-host--dock') &&
      presenceHost.dataset?.replaced !== 'true' &&
      ((typeof presenceHost.childElementCount === 'number' && presenceHost.childElementCount > 0) ||
        Boolean(presenceHost.firstElementChild)),
  );
  if (hasVisibleStagePresence) {
    if (pillHost.dataset) {
      pillHost.dataset.topOffset = 'below-presence';
    } else {
      pillHost.setAttribute?.('data-top-offset', 'below-presence');
    }
    return;
  }

  if (pillHost.dataset) {
    delete pillHost.dataset.topOffset;
  }
  pillHost.removeAttribute?.('data-top-offset');
}

export function resolveWaitingSummaryEntityLabel(
  state: AppState,
  summary: BackgroundWaitingSummary,
): string {
  if (summary.entityType === 'group') {
    return state.groupRooms.find((r) => r.roomId === summary.entityId)?.name || summary.entityId;
  }
  if (summary.entityType === 'bot') {
    return (
      state.profiles.find((p) => p.name === summary.entityId)?.displayName || summary.entityId
    );
  }
  const sess = state.sessions.find((s) => s.id === summary.entityId);
  return sess?.title || sess?.botDisplayName || sess?.botName || summary.entityId;
}

/** 根据内存会话映射构造 `storedSessionId -> botName`（仅收录专职 Bot 终身主工位 `isBotForever` / 缓存条目）。 */
export function collectBotForeverSessionMap(
  state: AppState,
  botForeverChatCache?: ReadonlyMap<string, string>,
): Map<string, string> {
  const map = new Map<string, string>();
  if (botForeverChatCache) {
    for (const [botName, sid] of botForeverChatCache.entries()) {
      if (sid && botName) map.set(sid, botName);
    }
  }
  for (const s of state.sessions) {
    if (s.id && s.botName && s.hidden && !map.has(s.id)) {
      map.set(s.id, s.botName);
    }
  }
  return map;
}

export function createInteractiveWiring(
  deps: InteractiveWiringDeps,
): InteractiveWiringController {
  let promptHostEl: HTMLElement | null = null;
  let updatePromptHost: (() => void) | null = null;
  let topPillHostEl: HTMLElement | null = null;
  let updateTopPill: (() => void) | null = null;
  let wakeTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleConnectionWake = (): void => {
    if (!deps.getState().gatewayConnected) return;
    if (wakeTimer !== null) {
      clearTimeout(wakeTimer);
    }
    wakeTimer = setTimeout(() => {
      wakeTimer = null;
      if (deps.getState().gatewayConnected) {
        void deps.service.wakeActiveConnections();
      }
    }, 600);
    if (typeof (wakeTimer as { unref?: () => void }).unref === 'function') {
      (wakeTimer as { unref: () => void }).unref();
    }
  };

  const handleVisibilityWake = (): void => {
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
      scheduleConnectionWake();
    }
  };

  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('focus', scheduleConnectionWake);
    window.addEventListener('hermes-mobile-resume', scheduleConnectionWake);
    window.addEventListener('hermes-mobile-browser-finished', scheduleConnectionWake);
  }
  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('visibilitychange', handleVisibilityWake);
  }

  const disposeWakeListeners = (): void => {
    if (wakeTimer !== null) {
      clearTimeout(wakeTimer);
      wakeTimer = null;
    }
    if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
      window.removeEventListener('focus', scheduleConnectionWake);
      window.removeEventListener('hermes-mobile-resume', scheduleConnectionWake);
      window.removeEventListener('hermes-mobile-browser-finished', scheduleConnectionWake);
    }
    if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
      document.removeEventListener('visibilitychange', handleVisibilityWake);
    }
  };

  const isDesktopSurfaceActive = (): boolean => {
    if (typeof window === 'undefined') return true;
    const hasMobileBridge = Boolean((window as { hermesMobile?: unknown }).hermesMobile);
    return (
      resolveWorkspaceShellMode({
        platform: deps.getState().platform,
        hasMobileBridge,
        search: typeof location !== 'undefined' ? location.search : '',
      }) === 'desktop'
    );
  };

  const openSafeExternalUrl = (url: string): void => {
    if (!isSafeExternalUrl(url)) return;
    const desktopApi = deps.getDesktopApi();
    if (desktopApi?.openExternal) {
      void desktopApi.openExternal(url);
      return;
    }
    if (typeof window !== 'undefined' && typeof window.open === 'function') {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  };

  const resolveEntityLabel = (summary: BackgroundWaitingSummary): string =>
    resolveWaitingSummaryEntityLabel(deps.getState(), summary);

  const selectBackgroundSummary = (summary: BackgroundWaitingSummary): void => {
    deps.service.expandScope(summary.scopeKey);
    if (summary.scope.kind === 'session') {
      deps.service.expandScope(`session:${summary.scope.storedSessionId || summary.entityId}`);
    }
    if (summary.entityType === 'group') {
      void deps.openGroupRoom(summary.entityId);
      return;
    }
    if (summary.entityType === 'bot') {
      void deps.openBotChat(summary.entityId);
      return;
    }
    const storedId = summary.scope.kind === 'session'
      ? (summary.scope.storedSessionId || summary.entityId)
      : summary.entityId;
    const sess = deps.getState().sessions.find((s) => s.id === storedId);
    void deps.selectSession(storedId, { botName: sess?.botName });
  };

  const buildPromptHostSnapshot = (): InteractivePromptHostSnapshot => {
    const state = deps.getState();
    const visible = Boolean(state.gatewayConnected && isDesktopSurfaceActive());
    return {
      surface: 'desktop-dock',
      prompts: visible ? deps.service.getActivePromptsForCurrentFocus() : [],
      activeCanonicalKey: visible ? deps.service.getActivePromptKeyForCurrentFocus() : null,
      collapsed: visible ? deps.service.isCollapsedForCurrentFocus() : false,
      locale: state.lang === 'en' ? 'en-US' : 'zh-CN',
      onCollapsedChange: (collapsed) => {
        deps.service.setCollapsedForCurrentFocus(collapsed);
        requestAnimationFrame(() => deps.syncStreamBottomInset());
      },
      onSelectPrompt: (canonicalKey) => {
        deps.service.setActivePromptKeyForCurrentFocus(canonicalKey);
      },
      onReply: (prompt, payload) => deps.service.submitReply(prompt, payload),
      onLockClarifyAnswer: (prompt, questionId, answer) =>
        deps.service.lockClarifyAnswer(prompt, questionId, answer),
      onOpenExternalUrl: openSafeExternalUrl,
      onWakeConnection: (prompt) => deps.service.wakeConnection(prompt),
    };
  };

  const buildTopPillSnapshot = (): InteractiveTopPillSnapshot => {
    const state = deps.getState();
    const visible = Boolean(state.gatewayConnected && isDesktopSurfaceActive());
    return {
      surface: 'desktop',
      summaries: visible ? deps.service.getBackgroundWaitingSummaries() : [],
      resolveEntityLabel,
      onSelectSummary: selectBackgroundSummary,
    };
  };

  const syncHosts = (): void => {
    if (typeof document === 'undefined') return;
    const desktopActive = isDesktopSurfaceActive();

    const nextPromptEl = desktopActive
      ? document.getElementById('react-interactive-prompt-host')
      : null;
    if (nextPromptEl) {
      if (nextPromptEl !== promptHostEl || !updatePromptHost) {
        promptHostEl = nextPromptEl;
        const mountPrompt = deps.mountPromptHost ?? mountInteractivePromptHost;
        updatePromptHost = mountPrompt(nextPromptEl, buildPromptHostSnapshot);
      } else {
        updatePromptHost();
      }
    } else if (updatePromptHost && promptHostEl?.isConnected) {
      updatePromptHost();
    } else {
      promptHostEl = null;
      updatePromptHost = null;
    }

    const nextPillEl = desktopActive
      ? document.getElementById('react-interactive-top-pill-host')
      : null;
    if (nextPillEl) {
      if (nextPillEl !== topPillHostEl || !updateTopPill) {
        topPillHostEl = nextPillEl;
        const mountPill = deps.mountTopPill ?? mountInteractiveTopPill;
        updateTopPill = mountPill(nextPillEl, buildTopPillSnapshot);
      } else {
        updateTopPill();
      }
    } else if (updateTopPill && topPillHostEl?.isConnected) {
      updateTopPill();
    } else {
      topPillHostEl = null;
      updateTopPill = null;
    }

    if (desktopActive) {
      syncInteractiveTopPillOffset();
      deps.syncStreamBottomInset();
    }
  };

  const dispose = (): void => {
    disposeWakeListeners();
    promptHostEl = null;
    updatePromptHost = null;
    topPillHostEl = null;
    updateTopPill = null;
  };

  return {
    syncHosts,
    selectBackgroundSummary,
    openSafeExternalUrl,
    resolveEntityLabel,
    dispose,
  };
}

export interface DesktopInteractiveSubsystemDeps {
  readonly getState: () => AppState;
  readonly getGatewayClient: () => HermesGatewayClient | null;
  readonly getDesktopApi: () => HermesDesktopBridge | undefined;
  readonly getSessionHandleRegistry: () => SessionHandleRegistry;
  readonly botForeverChatCache: ReadonlyMap<string, string>;
  readonly toStoredSessionId: (id?: string | null) => string | null;
  readonly resolveBotNameForSession: (storedSessionId: string) => string | null;
  readonly describeRpcError: (err: unknown) => string;
  readonly t: (key: I18nKey, params?: Record<string, string | number>) => string;
  readonly setTimedDockNotice: (msg: string, durationMs?: number) => void;
  readonly clearTimedDockNotice?: (options?: { skipRender?: boolean }) => void;
  readonly selectSession: (sessionId: string, opts?: { botName?: string }) => Promise<void> | void;
  readonly openBotChat: (botName: string) => Promise<void> | void;
  readonly openGroupRoom: (roomId: string) => Promise<void> | void;
  readonly syncAgentPresence: () => void;
  readonly syncStreamBottomInset: () => void;
  readonly render: () => void;
}

export interface DesktopInteractiveSubsystem {
  readonly service: InteractivePromptService;
  readonly wiring: InteractiveWiringController;
  readonly reconcileResume: (input: {
    client: HermesGatewayClient;
    storedSessionId: string;
    liveSessionId: string | null;
    profile?: string;
    resume: Record<string, unknown>;
    fence: number;
  }) => void;
  readonly attachClient: (client: HermesGatewayClient) => void;
  readonly getBotForeverSessionMap: () => Map<string, string>;
  readonly handleNotificationAction: (action: TurnAction) => void;
}

export interface GatewayNotificationBridge {
  handleAction(action: TurnAction): void;
  dispose(): void;
}

/** 网关主动推送 `notification.show` / `notification.clear` 的按 key 去重与有界 TTL 桥。 */
export function createGatewayNotificationBridge(deps: {
  readonly setTimedDockNotice: (msg: string, durationMs?: number) => void;
  readonly clearTimedDockNotice?: (options?: { skipRender?: boolean }) => void;
}): GatewayNotificationBridge {
  const activeKeys = new Map<string, ReturnType<typeof setTimeout>>();
  let currentKey: string | null = null;

  const clearKeyTimer = (k: string): void => {
    const existing = activeKeys.get(k);
    if (existing !== undefined) {
      clearTimeout(existing);
      activeKeys.delete(k);
    }
  };

  return {
    handleAction(action: TurnAction): void {
      if (action.type === 'notification-show') {
        const dedupeKey = action.key || action.id || `notice:${action.kind}:${action.level}`;
        clearKeyTimer(dedupeKey);
        const clampedTtl =
          typeof action.ttlMs === 'number' && Number.isFinite(action.ttlMs)
            ? Math.min(15_000, Math.max(2_000, Math.round(action.ttlMs)))
            : 5_000;
        const msg = action.detail ? `${action.text} · ${action.detail}` : action.text;
        currentKey = dedupeKey;
        deps.setTimedDockNotice(msg, clampedTtl);
        const timer = setTimeout(() => {
          activeKeys.delete(dedupeKey);
          if (currentKey === dedupeKey) {
            currentKey = null;
          }
        }, clampedTtl);
        if (typeof (timer as { unref?: () => void }).unref === 'function') {
          (timer as { unref: () => void }).unref();
        }
        activeKeys.set(dedupeKey, timer);
        return;
      }
      if (action.type === 'notification-clear') {
        clearKeyTimer(action.key);
        if (currentKey === action.key) {
          currentKey = null;
          deps.clearTimedDockNotice?.();
        }
      }
    },
    dispose(): void {
      for (const timer of activeKeys.values()) {
        clearTimeout(timer);
      }
      activeKeys.clear();
      currentKey = null;
    },
  };
}

/** 将 `tool.output_risk` 安全风险分级与发现摘要挂载到目标工具胶囊并触发局部/react 刷新。 */
export function applyToolOutputRiskAction(
  activeMessages: MessageViewModel[],
  cachedMessagesBySession: ReadonlyMap<string, MessageViewModel[]>,
  activeStreamingMessageId: string | null,
  action: Extract<TurnAction, { type: 'tool-output-risk' }>,
  scheduleToolPatch?: (messageId: string) => void,
): boolean {
  let updated = false;
  const applyToList = (list: MessageViewModel[]) => {
    for (const msg of list) {
      if (!msg.toolCalls || msg.toolCalls.length === 0) continue;
      if (action.messageId && activeStreamingMessageId && msg.id === activeStreamingMessageId) {
        // prefer matching tool call directly across all messages in session
      }
      const tc = msg.toolCalls.find((t) => t.id === action.toolCallId);
      if (tc) {
        tc.riskInfo = {
          risk: action.risk,
          findings: [...action.findings],
          redacted: action.redacted,
        };
        scheduleToolPatch?.(msg.id);
        updated = true;
      }
    }
  };
  applyToList(activeMessages);
  for (const list of cachedMessagesBySession.values()) {
    applyToList(list);
  }
  return updated;
}

/** 一步完成交互提示服务与桌面/移动双宿主桥的懒惰绑定，减轻入口文件体积。 */
export function createDesktopInteractiveSubsystem(
  deps: DesktopInteractiveSubsystemDeps,
): DesktopInteractiveSubsystem {
  let wiring: InteractiveWiringController | null = null;
  const service = createInteractivePromptService({
    getState: deps.getState,
    getGatewayClient: deps.getGatewayClient,
    getSessionHandleRegistry: deps.getSessionHandleRegistry,
    toStoredSessionId: deps.toStoredSessionId,
    resolveBotForeverSessionMap: () => collectBotForeverSessionMap(deps.getState(), deps.botForeverChatCache),
    resolveBotNameForSession: deps.resolveBotNameForSession,
    describeRpcError: deps.describeRpcError,
    t: deps.t,
    logDebug: (message, meta) => interactiveLog.debug(message, meta),
    logWarn: (message, meta) => interactiveLog.warn(message, meta),
    onTerminalSubmitNotice: (msg) => deps.setTimedDockNotice(msg, 5000),
    onPromptsChanged: () => {
      wiring?.syncHosts();
      deps.syncAgentPresence();
      deps.render();
    },
  });
  const notificationBridge = createGatewayNotificationBridge({
    setTimedDockNotice: deps.setTimedDockNotice,
    clearTimedDockNotice: deps.clearTimedDockNotice,
  });
  const baseWiring = createInteractiveWiring({
    service,
    getState: deps.getState,
    getDesktopApi: deps.getDesktopApi,
    selectSession: deps.selectSession,
    openBotChat: deps.openBotChat,
    openGroupRoom: deps.openGroupRoom,
    syncStreamBottomInset: deps.syncStreamBottomInset,
    render: deps.render,
  });
  wiring = {
    ...baseWiring,
    dispose: () => {
      baseWiring.dispose();
      notificationBridge.dispose();
    },
  };
  return {
    service,
    wiring,
    reconcileResume: (input) => {
      service.reconcileSessionResume(input);
      void service.probeClassicPendingApprovalsIfRunning(input);
    },
    attachClient: (client) => {
      client.onServerRequest((req) => service.handleServerRequest(req, client));
      client.onSocketClosed((gen) => service.handleSocketClosed(gen));
    },
    getBotForeverSessionMap: () => collectBotForeverSessionMap(deps.getState(), deps.botForeverChatCache),
    handleNotificationAction: (action) => notificationBridge.handleAction(action),
  };
}

/** 协调 session.resume 响应后的交互式状态恢复，将 handles 解析分支收敛至纯辅助函数 */
export function reconcileLiveSessionResume(params: {
  subsystem: Pick<DesktopInteractiveSubsystem, 'reconcileResume'>;
  client: HermesGatewayClient;
  storedFallbackId: string;
  profile: string;
  resume: Record<string, unknown> | null;
  handles: { storedId: string; liveId: string } | null;
  fence: number;
}): void {
  const { subsystem, client, storedFallbackId, profile, resume, handles, fence } = params;
  if (!resume || typeof resume !== 'object') return;
  subsystem.reconcileResume({
    client,
    storedSessionId: handles ? handles.storedId : storedFallbackId,
    liveSessionId: handles ? handles.liveId : null,
    profile,
    resume,
    fence,
  });
}
