/**
 * 桌面端协同服务与控制器增量覆盖补齐单测
 * (packages/desktop/__tests__/unit/desktop-interactive-coverage-edge.test.mjs)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { CacheService, LiveStreamRegistry } from '@hermes-flux/core';
import { revealMobileTraceContainers } from '../../dist/renderer/toolPatchQueue.mjs';
import { createConversationStreamController } from '../../dist/renderer/events/conversationStreamController.mjs';
import { createLeftRailController } from '../../dist/renderer/events/leftRailController.mjs';
import { LeftRailSnapshotManager } from '../../dist/renderer/leftrail/leftRailSnapshotManager.mjs';
import {
  createGatewayEventDispatcher,
  createLiveStreamCoordinator,
} from '../../dist/renderer/gateway/gatewayEventDispatcher.mjs';
import { createMobileShellCoordinator } from '../../dist/renderer/mobile/mobileShellCoordinator.mjs';
import { agentPresenceFingerprint } from '../../dist/renderer/presence/agentPresenceManager.mjs';
import { createForegroundSyncCoordinator } from '../../dist/renderer/services/foregroundSyncCoordinator.mjs';
import { createMessageLoadingService } from '../../dist/renderer/services/messageLoadingService.mjs';
import { createSessionOperationService } from '../../dist/renderer/services/sessionOperationService.mjs';
import { createSessionStatusService } from '../../dist/renderer/services/sessionStatusService.mjs';
import { createTurnExecutionService } from '../../dist/renderer/services/turnExecutionService.mjs';
import { StreamViewportManager } from '../../dist/renderer/viewport/streamViewportManager.mjs';
import { createRenderCoordinator } from '../../dist/renderer/renderCoordinator.mjs';
import {
  advanceTimers as advanceDispatcherTimers,
  createMockDispatcherDeps,
  flushMicrotasks,
} from './helpers/gatewayDispatcherHarness.mjs';
import { createMockTurnDeps, advanceTimers as advanceTurnTimers } from './helpers/turnExecutionHarness.mjs';

test('toolPatchQueue.revealMobileTraceContainers 与 conversationStreamController document===undefined 分支', () => {
  const attrs = new Map();
  const makeTarget = () => ({ setAttribute: (k, v) => attrs.set(k, v) });
  const elWithClosest = {
    closest: (sel) => (sel === '.m-trace-capsule' || sel === '.m-trace-stack' ? makeTarget() : null),
  };
  revealMobileTraceContainers(elWithClosest, '   ');
  assert.equal(attrs.size, 0);
  revealMobileTraceContainers({ closest: undefined }, '<span>ok</span>');
  revealMobileTraceContainers(elWithClosest, '<span>ok</span>');
  assert.equal(attrs.get('data-mobile-trace-empty'), 'false');

  const prevDoc = globalThis.document;
  globalThis.document = undefined;
  try {
    const state = {
      activeSessionId: 's1',
      activeFocus: { type: 'session', sessionId: 's1' },
      messages: [{ id: 'u1', role: 'user', content: 'hi' }],
      rollbackArmed: null,
    };
    const ctrl = createConversationStreamController({
      getState: () => state,
      render: () => {},
      safeCopyText: async () => true,
      setTimedDockNotice: () => {},
      isStreamingActiveForCurrentSession: () => false,
      t: (k) => k,
      getGatewayClient: () => null,
      getRpcCaller: () => null,
      getInteractiveService: () => null,
      selectSession: () => {},
      scheduleSessionsRefresh: () => {},
      getSessionMessagesCache: () => new Map(),
      handleOpenFilePreview: () => {},
      syncPromptNavigatorFromScroll: () => {},
      loadOlderMessages: async () => {},
      relocateMessageWindowToIndex: () => true,
      syncScrollTopToWindow: () => {},
      slideMessageWindowForward: () => {},
      expandMessageWindow: () => true,
      settleInitialBottom: () => {},
      scrollStreamToBottom: () => {},
      scheduleStreamBottomInset: () => {},
      layoutSignature: () => 'sig',
      ensureLiveSessionId: async () => '',
      getMessageWindowStart: () => 0,
      getMessageWindowEnd: () => 1,
      isMessageWindowUserExpanded: () => false,
      setMessageWindowUserExpanded: () => {},
      getAverageRowHeightPx: () => 96,
      isInitialBottomSettling: () => false,
      setInitialBottomSettling: () => {},
      getStreamScrollCooldown: () => false,
      setStreamScrollCooldown: () => {},
      getLastStreamScrollTop: () => 0,
      setLastStreamScrollTop: () => {},
      getProgrammaticScrollTarget: () => null,
      setProgrammaticScrollTarget: () => {},
      getProgrammaticScrollIgnoreUntil: () => 0,
      getLayoutDriftUntil: () => 0,
      getReaderScrolledSessionId: () => '',
      setReaderScrolledSessionId: () => {},
      setSettledLayoutSignature: () => {},
      isSessionEnterPending: () => false,
      cancelSessionEnter: () => {},
      STICK_TO_BOTTOM_THRESHOLD_PX: 48,
      MESSAGE_WINDOW_CAPACITY: 40,
    });
    ctrl.handleRollbackMessage({ getAttribute: (a) => (a === 'data-msg-id' ? 'u1' : null), closest: () => null });
    assert.equal(state.rollbackArmed, null);
    globalThis.document = { getElementById: () => null };
    ctrl.handleRollbackMessage({ getAttribute: (a) => (a === 'data-msg-id' ? 'u1' : null), closest: () => null });
    assert.equal(state.rollbackArmed, null);
  } finally {
    globalThis.document = prevDoc;
  }
});

test('leftRailController & LeftRailSnapshotManager 等待状态与 BotForeverSessionMap 分支全覆盖', () => {
  const baseHost = {
    getSessions: () => [
      { id: 's-for', botName: 'bot-a', title: 'Main', updatedAt: 1 },
      { id: 's-child', botName: 'bot-a', title: 'Child', updatedAt: 2 },
      { id: 's-dup-for', botName: 'bot-a', title: 'Dup', updatedAt: 3 },
      { id: 's-plain', botName: 'bot-b', title: 'Plain', updatedAt: 4 },
      { id: '', botName: 'bot-a', title: 'EmptyId', updatedAt: 5 },
    ],
    getArchivedSessions: () => [],
    getGroupRooms: () => [{ roomId: 'r-wait', name: 'WaitRoom', memberCount: 2 }],
    getProfiles: () => [
      { name: 'bot-a', displayName: 'Bot A' },
      { name: 'bot-b', displayName: 'Bot B' },
    ],
    getActiveSessionId: () => 's-for',
    getActiveFocus: () => ({ type: 'session', sessionId: 's-for' }),
    getProfileName: () => 'bot-a',
    getSearchQuery: () => '',
    isSessionsGroupExpanded: () => true,
    isGroupsGroupExpanded: () => true,
    getError: () => '',
    getCollapsed: () => false,
    getEditingGroupRoomId: () => undefined,
    getProfilesPhase: () => 'ready',
    getSessionsPhase: () => 'ready',
    getActivityVariant: () => 'halo',
    getActiveRunningSessionIds: () => new Set(),
    getUnreadSessionIds: () => new Set(),
    getActiveStreamingStoredSessionId: () => null,
    getActiveRunningGroupRoomIds: () => new Set(),
    getUnreadGroupRoomIds: () => new Set(),
    getActiveRunningBotNames: () => new Set(),
    getUnreadBotNames: () => new Set(),
    resolveAgentAvatar: () => '',
    resolveTransition: (_s, _i, st) => ({ state: st, transition: 'none', transitionToken: undefined }),
  };

  // 1. 缺省 getWaitingEntityMaps & getBotForeverSessionMap
  const mgrNoWait = new LeftRailSnapshotManager(baseHost);
  assert.equal(mgrNoWait.decorateSessions(10).every((s) => s.waitingReason === undefined), true);
  assert.equal(mgrNoWait.decorateGroups(10)[0].waitingReason, undefined);
  assert.equal(mgrNoWait.decorateProfiles(10)[0].waitingReason, undefined);

  // 2. 提供 waitingMaps + foreverMap (含主工位、子会话 waiting 及重复 botName 映射)
  const mgrWithWait = new LeftRailSnapshotManager({
    ...baseHost,
    getWaitingEntityMaps: () => ({
      sessionWaitingReasons: new Map([
        ['s-for', 'clarify'],
        ['s-child', 'approval'],
        ['s-dup-for', 'secret'],
      ]),
      groupWaitingReasons: new Map([['r-wait', 'confirm']]),
    }),
    getBotForeverSessionMap: () =>
      new Map([
        ['s-for', 'bot-a'],
        ['s-dup-for', 'bot-a'],
      ]),
  });
  const decSess = mgrWithWait.decorateSessions(20);
  const decGrp = mgrWithWait.decorateGroups(20);
  const decProf = mgrWithWait.decorateProfiles(20);
  assert.equal(decSess[0].waitingReason, 'clarify');
  assert.equal(decGrp[0].waitingReason, 'confirm');
  assert.equal(decProf[0].waitingReason, 'clarify');
  assert.equal(decProf[0].hasChildWaitingPrompt, true);
  assert.equal(decProf[1].waitingReason, undefined);

  // 3. LeftRailController 默认空 getWaitingEntityMaps / getBotForeverSessionMap 回落分支 (L127/131)
  const ctrlState = {
    sessions: [],
    groupRooms: [],
    profiles: [],
    activeSessionId: '',
    activeFocus: { type: 'session', sessionId: '' },
    profileName: 'default',
    sessionSearchQuery: '',
    leftRailLayout: 'dual-rail',
    isSessionsGroupExpanded: true,
    isGroupsGroupExpanded: true,
    leftRailCollapsed: false,
    profilesPhase: 'ready',
    sessionsPhase: 'ready',
  };
  const ctrl = createLeftRailController({
    getState: () => ctrlState,
    render: () => {},
    t: (k) => k,
    showToast: () => {},
    describeRpcError: String,
    getGatewayClient: () => null,
    groupRoomStore: { renameRoom: async () => {} },
    cancelColdStartFocus: () => {},
    selectSession: () => {},
    openBotChat: () => {},
    openGroupRoom: () => {},
    fetchProjects: () => {},
    fetchGroupRooms: () => {},
    beginLeftRailResize: () => {},
    getActivityVariant: () => 'halo',
    activeRunningSessionIds: new Set(),
    unreadSessionIds: new Set(),
    getActiveStreamingStoredSessionId: () => null,
    activeRunningGroupRoomIds: new Set(),
    unreadGroupRoomIds: new Set(),
    activeRunningBotNames: new Set(),
    unreadBotNames: new Set(),
    resolveAgentAvatar: () => '',
    activityTransitionTracker: { resolveTransition: (_s, _i, st) => ({ state: st, transition: 'none' }) },
  });
  assert.ok(ctrl.getLeftRailSnapshot());

  const ctrlWithMaps = createLeftRailController({
    getState: () => ctrlState,
    render: () => {},
    t: (k) => k,
    showToast: () => {},
    describeRpcError: String,
    getGatewayClient: () => null,
    groupRoomStore: { renameRoom: async () => {} },
    cancelColdStartFocus: () => {},
    selectSession: () => {},
    openBotChat: () => {},
    openGroupRoom: () => {},
    fetchProjects: () => {},
    fetchGroupRooms: () => {},
    beginLeftRailResize: () => {},
    getActivityVariant: () => 'halo',
    activeRunningSessionIds: new Set(),
    unreadSessionIds: new Set(),
    getActiveStreamingStoredSessionId: () => null,
    activeRunningGroupRoomIds: new Set(),
    unreadGroupRoomIds: new Set(),
    activeRunningBotNames: new Set(),
    unreadBotNames: new Set(),
    resolveAgentAvatar: () => '',
    activityTransitionTracker: { resolveTransition: (_s, _i, st) => ({ state: st, transition: 'none' }) },
    getWaitingEntityMaps: () => ({ sessionWaitingReasons: new Map([['s1', 'clarify']]), groupWaitingReasons: new Map() }),
    getBotForeverSessionMap: () => new Map([['s1', 'default']]),
  });
  assert.ok(ctrlWithMaps.getLeftRailSnapshot());
});

test('gatewayEventDispatcher & liveStreamCoordinator 交互动作、通知、风险与回调边界', async () => {
  const { deps, state } = createMockDispatcherDeps();
  const capturedActions = [];
  const notifications = [];
  let riskReturn = true;
  let clientCreatedCount = 0;
  let disconnectedCount = 0;

  deps.onInteractiveTurnAction = (a) => capturedActions.push(a);
  deps.onToolOutputRisk = () => riskReturn;
  deps.onGatewayNotification = (a) => notifications.push(a);
  deps.onGatewayClientCreated = () => {
    clientCreatedCount += 1;
  };
  deps.onGatewayDisconnect = () => {
    disconnectedCount += 1;
  };

  const dispatcher = createGatewayEventDispatcher(deps);
  try {
    dispatcher.applyTurnActions([
      { type: 'request-cancel', id: 'req-1', reason: 'done' },
      { type: 'approval-cancelled', sessionId: 'live-1', requestIds: ['a1'], cancelledCount: 1 },
      { type: 'connection-request', sessionId: 'live-1', payload: { op_id: 'op-1', seq: 1, deadline_at: 2, timeout_seconds: 10, targets: [] } },
      { type: 'connection-update', payload: { op_id: 'op-1', seq: 2, deadline_at: 2, settled: true, targets: [] } },
      { type: 'gateway-ready', replayEpoch: 'ep-1', sessionAuthority: true },
      { type: 'tool-output-risk', toolCallId: 'tc-1', risk: 'low', findings: [], redacted: false },
      { type: 'notification-show', text: 'hi', level: 'info', kind: 'notice' },
      { type: 'notification-clear', key: 'k1' },
    ]);
    riskReturn = false;
    dispatcher.applyTurnActions([{ type: 'tool-output-risk', toolCallId: 'tc-2', risk: 'low', findings: [], redacted: false }]);
    assert.equal(capturedActions.length, 5);
    assert.equal(notifications.length, 2);

    // 触发 connect -> onGatewayClientCreated + disconnect -> onGatewayDisconnect
    const prevWs = globalThis.WebSocket;
    globalThis.WebSocket = class {
      constructor() {
        this.readyState = 1;
      }
      send() {}
      close() {}
    };
    deps.testConnection = async () => ({ ok: true, latency: 1, ticket: '' });
    try {
      await dispatcher.connect('http://127.0.0.1:18888');
      assert.equal(clientCreatedCount, 1);
      dispatcher.disconnect();
      assert.equal(disconnectedCount, 1);
    } finally {
      globalThis.WebSocket = prevWs;
    }

    // liveStreamCoordinator onCaptureInteractiveFence / onInteractiveResumeReconciled 存在与缺失两支路
    const reg = new LiveStreamRegistry();
    const recCalls = [];
    const coord = createLiveStreamCoordinator({
      getConnectionEpoch: () => 1,
      getState: () => state,
      getGatewayClient: () => ({ call: async () => ({ running: false }), fetchSessionMessages: async () => ({ status: 'success', messages: [] }) }),
      getLiveStreamRegistry: () => reg,
      resolveBotNameForSession: () => null,
      getSessionMessagesCache: () => new Map(),
      getActiveRunningSessionIds: () => new Set(),
      getActiveRunningBotNames: () => new Set(),
      setActiveStreamingContext: () => {},
      setTurnStartedSessionId: () => {},
      toStoredSessionId: (id) => id,
      setMessageContent: () => {},
      dropQueuedTokens: () => {},
      armTurnWatchdog: () => {},
      disarmTurnWatchdog: () => {},
      clearPresenceTerminal: () => {},
      syncAgentPresence: () => {},
      render: () => {},
      refreshActiveSession: async () => {},
      isStreamNearBottom: () => false,
      setPendingScrollToBottom: () => {},
      setMessageWindowUserExpanded: () => {},
      ensureMessageWindow: () => {},
      onForceSyncMessageList: () => {},
      onCaptureInteractiveFence: () => 7,
      onInteractiveResumeReconciled: (p) => recCalls.push(p),
    });
    coord.ensureRemoteObserverStream('s-hyd', 'lv-hyd');
    await flushMicrotasks();
    assert.equal(recCalls.length, 1);

    // 无交互回调分支：onCaptureInteractiveFence 与 onInteractiveResumeReconciled 均省略
    const coordNoHooks = createLiveStreamCoordinator({
      getConnectionEpoch: () => 1,
      getState: () => state,
      getGatewayClient: () => ({ call: async () => ({ running: false }), fetchSessionMessages: async () => ({ status: 'success', messages: [] }) }),
      getLiveStreamRegistry: () => reg,
      resolveBotNameForSession: () => null,
      getSessionMessagesCache: () => new Map(),
      getActiveRunningSessionIds: () => new Set(),
      getActiveRunningBotNames: () => new Set(),
      setActiveStreamingContext: () => {},
      setTurnStartedSessionId: () => {},
      toStoredSessionId: (id) => id,
      setMessageContent: () => {},
      dropQueuedTokens: () => {},
      armTurnWatchdog: () => {},
      disarmTurnWatchdog: () => {},
      clearPresenceTerminal: () => {},
      syncAgentPresence: () => {},
      render: () => {},
      refreshActiveSession: async () => {},
      isStreamNearBottom: () => false,
      setPendingScrollToBottom: () => {},
      setMessageWindowUserExpanded: () => {},
      ensureMessageWindow: () => {},
      onForceSyncMessageList: () => {},
    });
    coordNoHooks.ensureRemoteObserverStream('s-hyd-2', 'lv-hyd-2');
    await flushMicrotasks();
    assert.equal(recCalls[0].fence, 7);
    coord.clearActiveSessionSyncTimer();
    coord.clearHydrationState();
  } finally {
    dispatcher.disconnect();
  }
});

test('mobileShellCoordinator 交互回调、location/matchMedia legacy addListener 与可选依赖边界', async () => {
  const prevLoc = globalThis.location;
  const prevWin = globalThis.window;
  let removedLegacy = 0;
  let legacyCb = null;
  let rendered = 0;
  const externalUrls = [];
  const waitingSelected = [];
  const approvals = [];
  const state = {
    platform: 'android',
    theme: 'obsidian-gold',
    lang: 'zh',
    gatewayConnected: true,
    gatewayConnecting: false,
    profileName: 'default',
    sessionSearchQuery: '',
    isSettingsOpen: false,
    settingsSection: 'appearance',
    activeFocus: { type: 'session', sessionId: 's1' },
    activeSessionId: 's1',
    isStreaming: false,
    messages: [],
    selectedModel: 'm',
    currentProvider: 'p',
    availableModels: [],
    modelDetails: [],
    attachments: [],
    dockNotice: '',
    artifacts: [],
    gitDiffs: [],
    openFiles: [],
    activeFilePath: '',
    fileTreeState: { status: 'idle' },
    fileTreeExpandedPaths: [],
    fileTreeFilterQuery: '',
    memories: [],
    learningState: { status: 'idle' },
    learningDetail: { status: 'idle' },
    groupRooms: [],
    profiles: [{ name: 'default', displayName: 'Default' }],
    sessions: [],
    sideAgentCapsules: [],
    profilesPhase: 'ready',
    sessionsPhase: 'ready',
    approvalMode: 'manual',
    orgContainerCollapsed: {},
    orgDoneRooms: {},
    orgFolders: [],
    orgAssignments: {},
    orgPrefs: {},
    doneLoading: false,
    settingsMcp: { status: 'idle', data: [] },
    settingsSkills: { status: 'idle', data: [] },
    settingsPlugins: { status: 'idle', data: [] },
  };

  delete globalThis.location;
  globalThis.window = {
    matchMedia: () => ({
      matches: true,
      addListener: (fn) => {
        legacyCb = fn;
      },
      removeListener: () => {
        removedLegacy += 1;
      },
    }),
  };
  try {
    const baseDeps = {
      getState: () => state,
      render: () => {
        rendered += 1;
      },
      leftRailController: {
        decorateRailProfiles: () => [],
        decorateRailGroups: () => [],
        decorateRailSessions: () => [],
      },
      resolveAgentAvatar: () => '',
      selectSession: async () => {},
      openBotChat: async () => {},
      openGroupRoom: async () => {},
      createNewSession: async () => null,
      renameSession: async () => {},
      pinSession: async () => {},
      archiveSession: async () => {},
      deleteSession: async () => {},
      createGroupRoom: async () => null,
      confirmGroupRename: async () => {},
      disbandGroupRoom: async () => {},
      fetchGroupRooms: async () => {},
      routeSend: async () => {},
      sendGroupMessage: async () => {},
      interruptTurn: async () => {},
      switchModel: async () => {},
      loadFileTree: async () => {},
      toggleFileTreeDir: async () => {},
      setFileTreeFilter: () => {},
      openWorkspaceFile: async () => {},
      downloadFile: async () => {},
      downloadMediaItem: async () => {},
      resolveMediaUrl: () => '',
      getSettingsSnapshot: () => ({}),
      createSettingsActions: () => ({}),
      ensureSettingsSectionData: async () => {},
      copyText: async () => true,
      syncReactMessageList: () => {},
      syncAgentPresenceHost: () => {},
      syncAgentPresence: () => {},
      storage: { getItem: () => null, setItem: () => {} },
    };

    const coordNoInteract = createMobileShellCoordinator(baseDeps);
    assert.equal(coordNoInteract.buildSnapshot().activeInteractivePromptKey, null);
    assert.equal(await coordNoInteract.getActions().onReplyInteractive({}, {}), false);
    await coordNoInteract.getActions().onLockClarifyAnswer({}, 'q1', 'a');
    coordNoInteract.getActions().onOpenInteractiveExternalUrl('https://x');
    await coordNoInteract.getActions().onWakeConnection({});
    coordNoInteract.getActions().onToggleInteractiveDockCollapsed(true);
    coordNoInteract.getActions().onSelectInteractivePrompt('k1');
    coordNoInteract.getActions().onSelectWaitingSummary({ scopeKey: 's1' });
    coordNoInteract.getActions().onSelectApprovalMode('smart');
    coordNoInteract.dispose();
    assert.equal(removedLegacy, 1);

    const prevRendered = rendered;
    globalThis.location = { search: '?mode=mobile' };
    const coordLoc = createMobileShellCoordinator(baseDeps);
    legacyCb?.();
    assert.ok(rendered > prevRendered);
    coordLoc.dispose();
    assert.equal(removedLegacy, 2);
    globalThis.location = undefined;

    const svcStub = {
      getActivePromptsForCurrentFocus: () => [{ canonicalKey: 'k1' }],
      getActivePromptKeyForCurrentFocus: () => 'k1',
      isCollapsedForCurrentFocus: () => true,
      getBackgroundWaitingSummaries: () => [{ scopeKey: 's1' }],
      submitReply: async () => true,
      lockClarifyAnswer: async () => {},
      wakeConnection: async () => {},
      setCollapsedForCurrentFocus: () => {},
      setActivePromptKeyForCurrentFocus: () => {},
    };
    const coordWithInteract = createMobileShellCoordinator({
      ...baseDeps,
      interactivePromptService: svcStub,
      switchApproval: async (m) => approvals.push(m),
      openInteractiveExternalUrl: (u) => externalUrls.push(u),
      onSelectWaitingSummary: (s) => waitingSelected.push(s),
    });
    assert.equal(coordWithInteract.buildSnapshot().interactiveDockCollapsed, true);
    assert.equal(await coordWithInteract.getActions().onReplyInteractive({}, {}), true);
    await coordWithInteract.getActions().onLockClarifyAnswer({}, 'q1', 'a');
    coordWithInteract.getActions().onOpenInteractiveExternalUrl('https://x');
    await coordWithInteract.getActions().onWakeConnection({});
    coordWithInteract.getActions().onToggleInteractiveDockCollapsed(false);
    coordWithInteract.getActions().onSelectInteractivePrompt('k1');
    coordWithInteract.getActions().onSelectWaitingSummary({ scopeKey: 's1' });
    coordWithInteract.getActions().onSelectApprovalMode('off');
    assert.deepEqual(externalUrls, ['https://x']);
    assert.equal(waitingSelected.length, 1);
    assert.deepEqual(approvals, ['off']);
    coordWithInteract.dispose();
    assert.ok(rendered >= 2);
  } finally {
    if (prevLoc !== undefined) globalThis.location = prevLoc;
    globalThis.window = prevWin;
  }
});

test('agentPresenceFingerprint(idle), foregroundSyncCoordinator(group), sessionOperationService, sessionStatusService, turnExecutionService, streamViewportManager & renderCoordinator 边界', async (t) => {
  // 1. agentPresenceFingerprint 全 kind (L104-111)
  const baseId = { kind: 'solo', name: 'default', displayName: 'Default' };
  for (const presence of [
    { kind: 'idle' },
    { kind: 'thinking' },
    { kind: 'waiting', reason: 'clarify' },
    { kind: 'tool', tool: 'bash', target: 'ls', runningCount: 1 },
    { kind: 'delegating', profile: 'coder', count: 2 },
    { kind: 'failed', message: 'boom' },
  ]) {
    assert.ok(agentPresenceFingerprint({ presence, identity: baseId, locale: 'zh-CN' }).length > 0);
  }

  // 2. foregroundSyncCoordinator refreshGroupState 缺失与存在
  const syncState = {
    gatewayConnected: true,
    manualDisconnected: false,
    connectionAuthError: false,
    connectionPhase: 'connected',
    activeFocus: { type: 'group', roomId: 'rm-1' },
    activeSessionId: '',
    isSettingsOpen: false,
    inspectorCollapsed: true,
    settingsSection: 'providers',
    rightPodMode: { kind: 'closed' },
    messages: [],
  };
  let refreshedGrp = 0;
  const baseSyncDeps = {
    getState: () => syncState,
    render: () => {},
    fetchProfiles: async () => {},
    fetchSessions: async () => {},
    fetchGroupRooms: async () => {},
    prefetchSlashCatalog: async () => {},
    fetchModelOptions: async () => {},
    fetchProjects: async () => {},
    refreshActiveSession: async () => {},
    refreshGroupRoomLog: async () => {},
    openBotChat: async () => {},
    getActiveViewContext: () => ({ isMobile: false, mobilePane: 'stage', homeTab: 'chats', botSubpage: null, settingsOpen: false, settingsSubpage: null }),
    hasUnsavedBotDrafts: () => false,
    getGroupRooms: () => [],
  };
  const fgNoGrp = createForegroundSyncCoordinator(baseSyncDeps);
  await fgNoGrp.syncOnConnected('connected');
  fgNoGrp.dispose();
  const fgWithGrp = createForegroundSyncCoordinator({
    ...baseSyncDeps,
    refreshGroupState: async () => {
      refreshedGrp += 1;
    },
  });
  await fgWithGrp.syncOnConnected('connected');
  fgWithGrp.dispose();
  assert.equal(refreshedGrp, 1);

  // 3. sessionOperationService: onSessionInteractiveBound + applyModelConfigSet + applyModelToLiveSession + switchModel + switchApproval
  let boundPairs = [];
  let configOutcome = async () => ({ confirm_required: true });
  let liveIdResult = 'live-op';
  const noticesOp = [];
  const opState = {
    activeSessionId: 's-op',
    activeLiveSessionId: 'live-op',
    profileName: '',
    profiles: [{ name: 'default', displayName: 'Default' }],
    sessions: [{ id: 's-op', title: 'S', botName: 'default' }],
    projects: [],
    pendingSessionIds: [],
    messages: [],
    selectedModel: 'gpt-old',
    recentModels: [],
    reasoningLevel: 'default',
    approvalMode: 'manual',
    dockNotice: '',
    modelMenuOpen: false,
    isStreaming: false,
    activeFocus: { type: 'session', sessionId: 's-op' },
    gatewayUrl: 'http://127.0.0.1:8080',
  };
  let requestRpcConfirmFn = undefined;
  const opSvc = createSessionOperationService({
    getState: () => opState,
    getGatewayClient: () => ({
      call: async (m, p) => {
        if (m === 'session.create') return { stored_session_id: 's-new', session_id: 'lv-new' };
        if (m === 'config.set') return await configOutcome(p);
        return {};
      },
      fetchSessionMessages: async () => ({ status: 'success', messages: [] }),
    }),
    getDesktopApi: () => undefined,
    getCurrentTicket: () => '',
    getEffectiveUrl: () => '',
    render: () => {},
    t: (k) => k,
    showToast: () => {},
    getInputValue: () => '',
    setInputValue: () => {},
    focusInput: () => {},
    getPromptInputValue: () => '',
    setPromptInputValue: () => {},
    focusPromptInput: () => {},
    restoreComposerFocus: () => {},
    sessionMessagesCache: new Map(),
    sessionDrafts: new Map(),
    sessionHandleRegistry: {
      clear() {},
      register() {},
      getStoredId: () => null,
      getRegisteredLiveId: () => null,
      toStoredId: (x) => x,
    },
    sessionListGeneration: { current: () => 0, next: () => 1, invalidateForDelete: () => {} },
    getActiveStreamingStoredSessionId: () => null,
    getActiveStreamingMessageId: () => null,
    getLiveStreamRegistry: () => ({ hasSession: () => false, getBySession: () => undefined }),
    activityTransitionTracker: { clear() {} },
    unreadSessionIds: new Set(),
    activeRunningSessionIds: new Set(),
    unreadBotNames: new Set(),
    unreadGroupRoomIds: new Set(),
    setPendingScrollToBottom: () => {},
    cancelSmoothScrollOnLeave: () => {},
    setLastMessagesSnapshot: () => {},
    captureStreamAnchor: () => null,
    beginSessionEnter: () => {},
    forgetOlderCursorState: () => {},
    incrementActiveLoadMessagesGeneration: () => 1,
    sessionPreviewCache: new Map(),
    formatSessionTime: () => '',
    resolveAgentAvatar: () => '',
    syncProfileLastMessages: () => {},
    logSessionWarn: () => {},
    logSessionDebug: () => {},
    openBotChat: async () => {},
    onReenterSameSession: () => {},
    onSyncFocusedStream: () => {},
    resetActiveStreamingState: () => {},
    scheduleToolPatch: () => {},
    persistSessionsToCache: () => {},
    loadMessages: async () => {},
    describeRpcError: String,
    ensureLiveSessionId: async () => liveIdResult,
    setTimedDockNotice: (msg, dur) => noticesOp.push([msg, dur]),
    clearTimedDockNotice: () => {},
    onSessionInteractiveBound: (st, lv) => boundPairs.push([st, lv]),
    get requestRpcConfirm() {
      return requestRpcConfirmFn;
    },
  });
  await opSvc.createNewSession();
  assert.deepEqual(boundPairs, [['s-new', 'lv-new']]);

  // confirm_required without requestRpcConfirm -> cancelled -> reverts switchModel
  await opSvc.switchModel('gpt-new');
  assert.equal(opState.selectedModel, 'gpt-old');

  // group focus -> early return keeping selector without sending config.set
  opState.activeFocus = { type: 'group', roomId: 'rm-1' };
  await opSvc.switchModel('gpt-group');
  assert.equal(opState.selectedModel, 'gpt-group');

  // confirm_required with session focus & cancel outcome -> reverts back
  opState.activeFocus = { type: 'session', sessionId: 's-op' };
  opState.selectedModel = 'gpt-old';
  requestRpcConfirmFn = async () => 'cancel';
  await opSvc.switchModel('gpt-new');
  assert.equal(opState.selectedModel, 'gpt-old');

  // confirm_required confirmed + warning; direct warning; error
  opState.activeFocus = { type: 'session', sessionId: 's-op' };
  opState.profileName = 'default';
  requestRpcConfirmFn = async () => 'confirm';
  configOutcome = async (p) =>
    p.confirm_expensive_model ? { warning: 'warn-after' } : { confirm_required: true };
  await opSvc.switchModel('gpt-new');
  assert.equal(opState.selectedModel, 'gpt-new');

  // applyModelConfigSet scope branches: group (roomId present / empty) & session without profile (L895-900)
  opState.activeFocus = { type: 'group', roomId: 'rm-grp-cfg' };
  await opSvc.applyModelToLiveSession('gpt-grp-1');
  opState.activeFocus = { type: 'group' };
  await opSvc.applyModelToLiveSession('gpt-grp-2');
  opState.activeFocus = { type: 'session', sessionId: 's-op' };
  opState.profileName = '';
  await opSvc.applyModelToLiveSession('gpt-noprof');
  opState.profileName = 'default';

  configOutcome = async () => ({ warning: 'warn-direct' });
  await opSvc.applyModelToLiveSession('gpt-warn');

  configOutcome = async () => {
    throw new Error('cfg boom');
  };
  await opSvc.applyModelToLiveSession('gpt-fail');
  assert.match(opState.dockNotice, /cfg boom/);
  await opSvc.switchModel('gpt-fail-2');
  assert.match(opState.dockNotice, /cfg boom/);

  // applyModelToLiveSession !model / !liveId & switchApproval !liveId & throw
  await opSvc.applyModelToLiveSession('');
  liveIdResult = '';
  await opSvc.applyModelToLiveSession('gpt-nolive');
  await opSvc.switchApproval('off');
  assert.equal(opState.approvalMode, 'manual');
  liveIdResult = 'live-op';
  await opSvc.switchApproval('smart');
  assert.equal(opState.approvalMode, 'manual');
  assert.match(opState.dockNotice, /Set approval mode failed/);

  // 4. sessionStatusService + turnExecutionService (with mock timers)
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_700_000_000_000 });
  const pendingCbCalls = [];
  const ssState = {
    lang: 'zh',
    activeFocus: { type: 'group', roomId: 'rm-ss' },
    activeSessionId: '',
    activeLiveSessionId: '',
    profileName: 'default',
    inspectorCollapsed: true,
    inspectorFullscreen: false,
    rightPodMode: { kind: 'closed' },
    sessions: [],
    profiles: [],
    groupRooms: [{ roomId: 'rm-ss', name: 'SS', members: [] }],
    messages: [],
  };
  let nextGroupStatePayload = null;
  const ssSvc = createSessionStatusService({
    getState: () => ssState,
    getGatewayClient: () => ({
      call: async () => nextGroupStatePayload,
      fetchSessionMessages: async () => ({ status: 'success', messages: [] }),
    }),
    getSessionHandleRegistry: () => ({ clear() {}, getStoredId: () => null, getRegisteredLiveId: () => null, register() {} }),
    getSessionMessagesCache: () => new Map(),
    isStreamingActiveForCurrentSession: () => false,
    getActiveStreamingStoredSessionId: () => null,
    getActiveStreamingMessageId: () => null,
    formatTimestamp: String,
    scheduleToolPatch: () => {},
    syncReactMessageList: () => {},
    syncRightPod: () => {},
    syncTitlebar: () => {},
    openFilePreview: () => {},
    insertQuoteToComposer: () => {},
    onGroupPendingActions: (r, a) => pendingCbCalls.push([r, a.length]),
    render: () => {},
  });
  ssSvc.onGroupActivated('rm-ss');
  await flushMicrotasks();
  assert.deepEqual(pendingCbCalls, [['rm-ss', 0]]);
  nextGroupStatePayload = { room: { room_id: 'rm-ss', members: [] }, driver_status: { member_activity: [] } };
  await ssSvc.refreshGroupStateNow('rm-ss');
  // Switch to different roomId -> L349 roomId !== roomId stops polling; empty roomId -> L368
  ssState.activeFocus = { type: 'group', roomId: 'other-rm' };
  t.mock.timers.tick(2500);
  await flushMicrotasks();
  ssSvc.syncPollingForCurrentMode();
  ssState.activeFocus = { type: 'group', roomId: '' };
  ssSvc.syncPollingForCurrentMode();
  ssState.activeFocus = { type: 'session', sessionId: 'other' };
  ssSvc.syncPollingForCurrentMode();
  ssSvc.dispose();

  const { deps: turnDeps, state: turnState } = createMockTurnDeps({
    gatewayClient: { call: async () => ({ running: true, inflight: { streaming: true } }) },
  });
  const turnFences = [];
  turnDeps.watchdogIdleTimeoutMs = 20;
  turnDeps.onCaptureInteractiveFence = () => 11;
  turnDeps.onInteractiveResumeReconciled = (x) => turnFences.push(x.fence);
  const turnSvc = createTurnExecutionService(turnDeps);
  turnState.isStreaming = true;
  turnSvc.armTurnWatchdog();
  await advanceTurnTimers(t, 20);
  turnSvc.disarmTurnWatchdog(true);
  t.mock.timers.reset();
  assert.deepEqual(turnFences, [11]);

  // 5. StreamViewportManager syncStreamBottomInset (interactive-prompt-host + no querySelector + no style + onViewportSettled)
  const prevResizeObs = globalThis.ResizeObserver;
  globalThis.ResizeObserver = undefined;
  try {
    const streamProps = new Map();
    const podProps = new Map();
    let settled = 0;
    const makeHost = (podObj, withSettled) => ({
      getActiveSessionId: () => 's1',
      getPresenceLayout: () => 'dock',
      isPromptJumpSettling: () => false,
      getMessageWindowEnd: () => 1,
      getTotalMessages: () => 1,
      layoutSignature: () => 'sig',
      getStreamElement: () => ({
        scrollTop: 100,
        scrollHeight: 100,
        clientHeight: 100,
        getBoundingClientRect: () => ({ bottom: 500 }),
        style: {
          setProperty: (k, v) => streamProps.set(k, v),
          getPropertyValue: (k) => streamProps.get(k) ?? '',
        },
      }),
      getMiddlePodElement: () => podObj,
      getInputDockElement: () => ({ getBoundingClientRect: () => ({ top: 450, height: 50 }) }),
      getVirtualWindowElement: () => ({ getBoundingClientRect: () => ({ bottom: 480 }) }),
      markProgrammaticScroll: () => {},
      onViewportSettled: withSettled ? () => { settled += 1; } : undefined,
      isInitialBottomSettling: () => false,
      setInitialBottomSettling: () => {},
      settleInitialBottom: () => {},
      isSessionEnterPending: () => true,
      requestAnimationFrame: (cb) => cb(),
    });
    const podFull = {
      style: { setProperty: (k, v) => podProps.set(k, v) },
      querySelector: () => ({ getBoundingClientRect: () => ({ top: 380, height: 70 }) }),
      getBoundingClientRect: () => ({ bottom: 500 }),
    };
    const sv1 = new StreamViewportManager(makeHost(podFull, true));
    sv1.syncStreamBottomInset();
    assert.equal(settled, 1);
    assert.equal(podProps.get('--flux-interactive-prompt-h'), '70px');

    const podBare = { getBoundingClientRect: () => ({ bottom: 500 }) };
    const bareHost = makeHost(podBare, false);
    bareHost.getVirtualWindowElement = () => ({ getBoundingClientRect: () => ({ bottom: 484 }) });
    const sv2 = new StreamViewportManager(bareHost);
    sv2.syncStreamBottomInset();
  } finally {
    globalThis.ResizeObserver = prevResizeObs;
  }

  // 6. renderCoordinator riskInfo VM + activeElement island protection (L559/597/895-909/1255)
  const prevDoc2 = globalThis.document;
  const prevHtmlIn = globalThis.HTMLInputElement;
  class MockPwInput {
    constructor() {
      this.tagName = 'INPUT';
      this.type = 'password';
      this.id = 'pw-1';
    }
    closest() {
      return null;
    }
  }
  globalThis.HTMLInputElement = MockPwInput;
  const rootStub = {
    querySelector: (sel) => (sel === '.flux-body-container' ? {} : null),
    querySelectorAll: () => [],
  };
  globalThis.document = {
    activeElement: new MockPwInput(),
    getElementById: (id) => (id === 'flux-app-root' ? rootStub : null),
    documentElement: {
      dataset: {},
      classList: { add() {}, remove() {} },
      getAttribute: () => null,
      setAttribute() {},
      style: { setProperty() {}, removeProperty() {}, getPropertyValue: () => '' },
    },
  };
  try {
    let interactiveSynced = 0;
    const rcState = {
      activeSessionId: 's1',
      activeFocus: { type: 'session', sessionId: 's1' },
      messages: [
        {
          id: 'm1',
          role: 'assistant',
          content: 'done',
          toolCalls: [
            { id: 't1', name: 'b', status: 'done', riskInfo: { risk: 'high', redacted: true, findings: ['k'] } },
            { id: 't2', name: 'c', status: 'done', riskInfo: { risk: 'low', redacted: false, findings: [] } },
            { id: 't3', name: 'd', status: 'done' },
          ],
        },
        { id: 'm-last', role: 'assistant', content: 'tail' },
      ],
      gatewayConnected: true,
      gatewayConnecting: false,
      hasOlderMessages: false,
      isLoadingOlder: false,
      messagesPhase: 'ready',
      profileName: 'default',
      lang: 'en',
      artifacts: [],
      attachments: [],
      availableModels: [],
      collapsedProviders: [],
      favoriteModels: [],
      gitDiffs: [],
      memories: [],
      mentionItems: [],
      modelCatalog: {},
      modelDetails: [],
      openFiles: [],
      queuedMessages: [],
      recentModels: [],
      sideAgentCapsules: [],
      slashItems: [],
      browserFrame: null,
      rollbackArmed: null,
      testStatus: null,
      activeFilePath: '',
      activeInspectorTab: 'files',
      approvalMode: 'manual',
      currentProvider: 'auto',
      dockNotice: '',
      fileSearchOpen: false,
      fileSearchQuery: '',
      fileShowLineNumbers: false,
      fileViewMode: 'preview',
      fileWordWrap: false,
      inspectorCollapsed: true,
      inspectorFullscreen: false,
      isMaximized: false,
      isSettingsOpen: false,
      leftRailCollapsed: false,
      mentionPopperOpen: false,
      modelMenuOpen: false,
      modelSearchQuery: '',
      selectedModel: 'auto',
      reasoningLevel: 'default',
      settingsSection: 'appearance',
      conversationWidth: 'wide',
      leftRailLayout: 'dual-rail',
      slashPopperOpen: false,
      theme: 'obsidian-gold',
      username: '',
      gatewayUrl: '',
      modelCatalogHash: '',
    };
    const rc = createRenderCoordinator({
      getState: () => rcState,
      messageWindowManager: {
        ensureMessageWindow() {},
        getMessageWindowStart: () => 0,
        getMessageWindowEnd: () => 2,
        computeContentOffsetPx: () => 0,
        computeVirtualHeightPx: () => 100,
        scheduleVirtualHeightSync() {},
        markProgrammaticScroll() {},
      },
      modalInteractionController: {
        renderTaskModalHtml: () => '',
        renderContextMenuHtml: () => '',
        renderConfirmModalHtml: () => '',
        updateModals() {},
      },
      isStreamingActiveForCurrentSession: () => false,
      resolveSessionKnownFiles: () => [],
      getTitlebarSnapshot: () => ({}),
      getLeftRailSnapshot: () => ({}),
      createLeftRailActions: () => ({}),
      getPromptNavigatorSnapshot: () => ({ entries: [] }),
      createPromptNavigatorActions: () => ({}),
      rebuildPromptEntries() {},
      syncPromptNavigatorMeta() {},
      syncPromptNavigator() {},
      syncReactSettings() {},
      ensureSettingsSectionData() {},
      syncAgentPresenceHost() {},
      syncAgentPresence() {},
      syncInteractiveHosts: () => {
        interactiveSynced += 1;
      },
      captureStreamAnchor: () => ({ id: 'm1', offset: 0 }),
      applyStreamAnchor() {},
      stabilizeStreamAnchor() {},
      scrollStreamToBottom() {},
      isStreamNearBottom: () => true,
      isSessionEnterPending: () => false,
      getPendingScrollToBottom: () => false,
      getInputDockSnapshot: () => ({}),
      renderInputDock: () => '',
      bindEvents() {},
      syncComposerPoppers() {},
      mountReactShellComponents() {},
      getTitlebarSnapshotSafe: () => ({}),
      getRightPodSnapshot: () => ({}),
      createRightPodActions: () => ({}),
      restoreComposerFocus() {},
      renderStatusBarHtml: () => '',
      renderAgentPresenceHtml: () => '',
      renderMarkdown: (s) => s,
      renderToolCapsuleSlot: () => '',
      renderMessagesListHtml: () => '',
      getLastInputDockSnapshot: () => null,
      setLastInputDockSnapshot() {},
      syncComposerBadges() {},
      scheduleRunningToolTimers() {},
      syncScrollToEndVisibility() {},
      syncStreamBottomInset() {},
      settleInitialBottom() {},
      logRender: { debug() {}, info() {}, warn() {}, error() {} },
      resolveMediaUrl: () => '',
      onOpenFile: async () => {},
      onDownloadMediaItem: async () => {},
      t: (k) => k,
    });
    const convSnap = rc.buildConversationSnapshot();
    assert.equal(convSnap.messages[0].toolCalls[0].riskInfo.redacted, true);
    assert.equal(convSnap.messages[0].toolCalls[1].riskInfo.redacted, false);
    rc.render();
    globalThis.document.activeElement = {
      tagName: 'INPUT',
      id: 'q',
      type: 'text',
      value: 'x',
      selectionStart: 1,
      selectionEnd: 1,
      closest: () => null,
    };
    rc.render();
    assert.ok(interactiveSynced >= 2);
  } finally {
    globalThis.document = prevDoc2;
    globalThis.HTMLInputElement = prevHtmlIn;
  }
});

test('MessageLoadingService loadMessagesInner 覆盖 onCaptureInteractiveFence 可选链双分支与对账回调', async () => {
  const reconciled = [];
  const makeMlService = (withInteractiveHooks) => {
    const mlState = {
      activeSessionId: '',
      activeLiveSessionId: '',
      activeFocus: { type: 'session', sessionId: 's-ml' },
      profileName: 'bot-ml',
      sessions: [{ id: 's-ml', botName: 'bot-ml', cwd: '' }],
      archivedSessions: [],
      messages: [],
      hasOlderMessages: false,
      dockNotice: '',
      sessionCwds: {},
      profiles: [],
    };
    const mlClient = {
      fetchSessionMessages: async () => ({ status: 'error', messages: [] }),
      call: async (method) => {
        if (method === 'session.resume') return { id: 's-ml', session_id: 'lv-ml' };
        return {};
      },
    };
    return {
      mlState,
      svc: createMessageLoadingService({
        getState: () => mlState,
        getGatewayClient: () => mlClient,
        render: () => {},
        sessionMessagesCache: new Map(),
        cacheService: {
          openChannel: async () => ({ rows: [], fenceMax: 0 }),
          dropChannel: async () => {},
          applyRemoteWindow: async () => {},
        },
        persistMessagesToCache: () => {},
        syncPromptNavigatorMeta: () => {},
        syncPromptNavigatorFromScroll: () => {},
        scrollStreamToBottom: () => {},
        setPendingScrollToBottom: () => {},
        isStreamNearBottom: () => true,
        captureStreamAnchor: () => null,
        applyStreamAnchor: () => {},
        getMessageWindowStart: () => 0,
        setMessageWindowStart: () => {},
        getMessageWindowEnd: () => 30,
        setMessageWindowEnd: () => {},
        setMessageWindowUserExpanded: () => {},
        isGroupConversationActive: () => false,
        hostedRoomIds: new Set(),
        formatSessionTime: () => '',
        formatTimestamp: () => '',
        botActivityStore: { withActivityMap: () => null, persist: () => {} },
        botForeverChatCache: new Map(),
        sessionPreviewCache: new Map(),
        persistSessionPreviewCache: () => {},
        getActiveStreamingStoredSessionId: () => null,
        defaultSessionHandleRegistry: {
          clear() {},
          register() {},
          getStoredId: () => null,
          getRegisteredLiveId: () => null,
          toLiveId: () => null,
        },
        activeRunningSessionIds: new Set(),
        activityTransitionTracker: { clear() {} },
        ...(withInteractiveHooks
          ? {
              onCaptureInteractiveFence: () => 5,
              onInteractiveResumeReconciled: (info) => reconciled.push(info),
            }
          : {}),
      }),
    };
  };

  const withHooks = makeMlService(true);
  await withHooks.svc.loadMessagesInner('s-ml', 'bot-ml');
  assert.equal(reconciled.length, 1);
  assert.equal(reconciled[0].fence, 5);
  assert.equal(reconciled[0].liveSessionId, 'lv-ml');

  const withoutHooks = makeMlService(false);
  await withoutHooks.svc.loadMessagesInner('s-ml', 'bot-ml');
  assert.equal(withoutHooks.mlState.activeLiveSessionId, 'lv-ml');
});

test('toolPatchQueue 无匹配祖先、liveStreamCoordinator 无钩子补齐与 StreamViewportManager 死区双向覆盖', async () => {
  // 1. toolPatchQueue.ts:40,42 closest 返回 null
  revealMobileTraceContainers({ closest: () => null }, '<span>plain</span>');

  // 2. liveStreamCoordinator.ts:348 无 onInteractiveResumeReconciled 与有回调且 handles 缺失双路
  const cacheMap = new Map();
  const regNoHooks = new LiveStreamRegistry();
  const baseCoordState = {
    activeSessionId: 'other-s',
    profileName: 'default',
    sessions: [],
    archivedSessions: [],
    messages: [],
    sessionCwds: {},
  };
  const coordNoHooks = createLiveStreamCoordinator({
    getConnectionEpoch: () => 1,
    getState: () => baseCoordState,
    getGatewayClient: () => ({
      call: async () => ({ running: false }),
      fetchSessionMessages: async () => ({ status: 'success', messages: [] }),
    }),
    getLiveStreamRegistry: () => regNoHooks,
    resolveBotNameForSession: () => null,
    getSessionMessagesCache: () => cacheMap,
    getActiveRunningSessionIds: () => new Set(),
    getActiveRunningBotNames: () => new Set(),
    setActiveStreamingContext: () => {},
    setTurnStartedSessionId: () => {},
    toStoredSessionId: (id) => id,
    setMessageContent: () => {},
    dropQueuedTokens: () => {},
    armTurnWatchdog: () => {},
    disarmTurnWatchdog: () => {},
    clearPresenceTerminal: () => {},
    syncAgentPresence: () => {},
    render: () => {},
    refreshActiveSession: async () => {},
  });
  coordNoHooks.ensureRemoteObserverStream('s-lsc-nh', 'lv-lsc-nh');
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  coordNoHooks.clearActiveSessionSyncTimer();
  coordNoHooks.clearHydrationState('s-lsc-nh');

  const reconciled = [];
  const regHooks = new LiveStreamRegistry();
  const coordWithHooks = createLiveStreamCoordinator({
    getConnectionEpoch: () => 1,
    getState: () => baseCoordState,
    getGatewayClient: () => ({
      call: async () => ({ running: false }),
      fetchSessionMessages: async () => ({ status: 'success', messages: [] }),
    }),
    getLiveStreamRegistry: () => regHooks,
    resolveBotNameForSession: () => null,
    getSessionMessagesCache: () => cacheMap,
    getActiveRunningSessionIds: () => new Set(),
    getActiveRunningBotNames: () => new Set(),
    setActiveStreamingContext: () => {},
    setTurnStartedSessionId: () => {},
    toStoredSessionId: (id) => id,
    setMessageContent: () => {},
    dropQueuedTokens: () => {},
    armTurnWatchdog: () => {},
    disarmTurnWatchdog: () => {},
    clearPresenceTerminal: () => {},
    syncAgentPresence: () => {},
    render: () => {},
    refreshActiveSession: async () => {},
    onCaptureInteractiveFence: () => 7,
    onInteractiveResumeReconciled: (info) => reconciled.push(info),
  });
  coordWithHooks.ensureRemoteObserverStream('s-lsc-wh', 'lv-lsc-wh');
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
  assert.equal(reconciled.length, 1);
  assert.equal(reconciled[0].storedSessionId, 's-lsc-wh');
  coordWithHooks.clearActiveSessionSyncTimer();

  // Handles truthy (id + session_id) and resumeRes=null paths on L345-354
  const regHandles = new LiveStreamRegistry();
  let resumePayload = { id: 's-lsc-h', session_id: 'lv-lsc-h', running: false };
  const coordHandles = createLiveStreamCoordinator({
    getConnectionEpoch: () => 1,
    getState: () => baseCoordState,
    getGatewayClient: () => ({
      call: async () => resumePayload,
      fetchSessionMessages: async () => ({ status: 'success', messages: [] }),
    }),
    getLiveStreamRegistry: () => regHandles,
    resolveBotNameForSession: () => null,
    getSessionMessagesCache: () => cacheMap,
    getActiveRunningSessionIds: () => new Set(),
    getActiveRunningBotNames: () => new Set(),
    setActiveStreamingContext: () => {},
    setTurnStartedSessionId: () => {},
    toStoredSessionId: (id) => id,
    setMessageContent: () => {},
    dropQueuedTokens: () => {},
    armTurnWatchdog: () => {},
    disarmTurnWatchdog: () => {},
    clearPresenceTerminal: () => {},
    syncAgentPresence: () => {},
    render: () => {},
    refreshActiveSession: async () => {},
    onCaptureInteractiveFence: () => 8,
    onInteractiveResumeReconciled: (info) => reconciled.push(info),
  });
  coordHandles.ensureRemoteObserverStream('s-lsc-h', 'lv-lsc-h');
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
  assert.equal(reconciled.length, 2);
  assert.equal(reconciled[1].liveSessionId, 'lv-lsc-h');
  resumePayload = null;
  coordHandles.ensureRemoteObserverStream('s-lsc-null', 'lv-lsc-null');
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
  resumePayload = { running: false };
  coordHandles.ensureRemoteObserverStream('', '');
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
  coordHandles.clearActiveSessionSyncTimer();

  // 3. StreamViewportManager.ts:467 Math.abs(need) > 4 与 <= 4 双向分支
  const styleVals = new Map([['--conv-gutter-bottom', '60px']]);
  let vwBottom = 700;
  const svm = new StreamViewportManager({
    getMiddlePodElement: () => ({
      getBoundingClientRect: () => ({ top: 0, bottom: 600, height: 600 }),
      querySelector: () => ({ getBoundingClientRect: () => ({ top: 520, bottom: 600, height: 80 }) }),
      style: { setProperty: () => {} },
    }),
    getInputDockElement: () => ({
      getBoundingClientRect: () => ({ top: 540, bottom: 600, height: 60 }),
    }),
    getVirtualWindowElement: () => ({
      getBoundingClientRect: () => ({ top: 0, bottom: vwBottom }),
    }),
    getStreamElement: () => ({
      scrollHeight: 500,
      scrollTop: 0,
      clientHeight: 500,
      getBoundingClientRect: () => ({ top: 0, bottom: 520 }),
      style: {
        getPropertyValue: (k) => styleVals.get(k) || '',
        setProperty: (k, v) => styleVals.set(k, v),
      },
    }),
    getActiveSessionId: () => 's-svm',
    getPresenceLayout: () => 'dock',
    isPromptJumpSettling: () => false,
    getMessageWindowEnd: () => 30,
    getTotalMessages: () => 10,
    layoutSignature: () => 'sig',
    markProgrammaticScroll: () => {},
  });
  // baseInset = (600 - 520) + 40 = 120; visibleBottom = 520 - 120 = 400; currentPx = 60
  svm.syncStreamBottomInset(); // need = 700 - 400 = 300 > 4 -> 60 + 300 = 360px
  assert.equal(styleVals.get('--conv-gutter-bottom'), '360px');
  vwBottom = 402; // need = 2 (<= 4) -> keeps max(baseInset=120, currentPx=360) = 360px
  svm.syncStreamBottomInset();
  assert.equal(styleVals.get('--conv-gutter-bottom'), '360px');
  styleVals.set('--conv-gutter-bottom', '80px'); // currentPx=80 < baseInset=120 when |need| <= 4
  svm.syncStreamBottomInset();
  assert.equal(styleVals.get('--conv-gutter-bottom'), '120px');
});
