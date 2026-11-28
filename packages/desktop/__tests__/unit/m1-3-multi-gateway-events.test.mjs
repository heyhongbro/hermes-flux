/**
 * M1.3 全链路跨网关事件流、流式注册表隔离与多端协调单测
 * (packages/desktop/__tests__/unit/m1-3-multi-gateway-events.test.mjs)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ActivityTransitionTracker,
  CacheService,
  LiveStreamRegistry,
  MemoryCacheStore,
  SessionHandleRegistry,
} from '@hermes-flux/core';
import {
  createInitialState,
  resolveActiveWorkspaceCwd,
  resolveScopedBotRuntimeKey,
  resolveScopedEntityRuntimeKey,
} from '../../dist/renderer/state/appState.mjs';
import {
  IndexWriteQueue,
  persistGroupsToCache,
  persistMultiGatewayAgentsToCache,
  persistMultiGatewaySessionsToCache,
  persistTurnToCache,
  restoreMultiGatewayCacheSnapshot,
  toAgentProfile,
  toNormalizedSession,
} from '../../dist/renderer/cache/desktopCacheBridge.mjs';
import {
  collectGatewayScopedSessionIds,
  createGatewayEventDispatcher,
  createLiveStreamCoordinator,
  extractGatewayFrameMeta,
  isFocusedOnBot,
  isFocusedOnEntity,
  resolveBotNameForSession,
} from '../../dist/renderer/gateway/gatewayEventDispatcher.mjs';
import {
  createDesktopMultiGatewayWiring,
  createMultiGatewayCoordinator,
  resolveActiveLiveSessionId,
} from '../../dist/renderer/gateway/multiGatewayCoordinator.mjs';
import { GATEWAY_REGISTRY_STORAGE_KEY } from '../../dist/renderer/gateway/gatewayRegistryStore.mjs';
import { createGroupOperationService } from '../../dist/renderer/services/groupOperationService.mjs';
import { createProfileManagementService } from '../../dist/renderer/services/profileManagementService.mjs';
import { createForegroundSyncCoordinator } from '../../dist/renderer/services/foregroundSyncCoordinator.mjs';
import { createConversationOrgCoordinator } from '../../dist/renderer/services/conversationOrgCoordinator.mjs';
import { createLeftRailController } from '../../dist/renderer/events/leftRailController.mjs';
import { createModalInteractionController } from '../../dist/renderer/events/modalInteractionController.mjs';
import { createConversationStreamController } from '../../dist/renderer/events/conversationStreamController.mjs';
import { createSessionDeliverableCoordinator } from '../../dist/renderer/services/mediaResolver.mjs';
import { createMobileShellCoordinator } from '../../dist/renderer/mobile/mobileShellCoordinator.mjs';
import { flushMicrotasks } from './helpers/gatewayDispatcherHarness.mjs';

function createMemoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
  };
}

class MockSocket {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  send(raw) {
    const frame = JSON.parse(raw);
    if (frame.id != null) {
      queueMicrotask(() => {
        this.onmessage?.({ data: JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: { ok: true } }) });
      });
    }
  }
  close(code = 1000, reason = 'closed') {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
}

test('M1.3 AppState resolveActiveWorkspaceCwd scopes sessionCwds and sessions by activeGw', () => {
  const state = createInitialState({ platform: 'win32' });
  state.gatewayCount = 2;
  state.activeGatewayId = 'gw-b';
  state.activeSessionId = 'shared-s';
  state.activeFocus = { type: 'session', sessionId: 'shared-s', gatewayId: 'gw-b' };
  state.sessionCwds = {
    'shared-s': '/legacy/raw',
    'gw-b::shared-s': '/work/gw-b',
  };
  assert.equal(resolveActiveWorkspaceCwd(state), '/work/gw-b');

  state.sessionCwds = { 'shared-s': '/legacy/raw' };
  assert.equal(resolveActiveWorkspaceCwd(state), '/legacy/raw');

  state.sessionCwds = {};
  state.sessions = [
    { id: 'shared-s', title: 'A', botName: 'default', gatewayId: 'gw-a', cwd: '/repo/a' },
    { id: 'shared-s', title: 'B', botName: 'default', gatewayId: 'gw-b', cwd: '/repo/b' },
  ];
  assert.equal(resolveActiveWorkspaceCwd(state), '/repo/b');

  state.sessions = [];
  state.archivedSessions = [{ id: 'shared-s', title: 'Arch', botName: 'default', gatewayId: 'gw-b', projectId: 'p-b' }];
  state.projects = [{ id: 'p-b', name: 'PB', path: '/proj/b' }];
  assert.equal(resolveActiveWorkspaceCwd(state), '/proj/b');

  // fallback to unscoped match when gateway has no matching tagged session
  state.activeFocus = { type: 'session', sessionId: 'shared-s', gatewayId: 'gw-c' };
  state.activeGatewayId = 'gw-c';
  assert.equal(resolveActiveWorkspaceCwd(state), '/proj/b');
});

test('M1.3 desktopCacheBridge multi-gateway bucketed persist and restore', async () => {
  const store = new MemoryCacheStore();
  const cacheService = new CacheService(store, { sessionCap: 200, messageCap: 500 });
  const queue = new IndexWriteQueue();

  assert.equal(
    toNormalizedSession({ gatewayId: '__default__', profile: 'default', kind: 'session', id: 's1', title: 'T', lastActive: 1000 }).gatewayId,
    undefined,
  );
  assert.equal(
    toNormalizedSession({ gatewayId: 'gw-b', profile: 'default', kind: 'session', id: 's2', title: 'T2', lastActive: 1000 }).gatewayId,
    'gw-b',
  );
  assert.equal(
    toAgentProfile({ gatewayId: 'gw-b', name: 'coder', displayName: 'Coder', description: '', model: 'm' }).gatewayId,
    'gw-b',
  );
  assert.equal(
    toAgentProfile({ gatewayId: '__default__', name: 'def', displayName: 'Def', description: '', model: 'm' }).gatewayId,
    undefined,
  );

  // < 2 fallback path
  persistMultiGatewaySessionsToCache(
    [{ id: 's-single', title: 'S1', botName: 'default', timestamp: 1000, time: '10:00', preview: '' }],
    cacheService,
    'default',
    queue,
    ['gw-a'],
    1,
  );
  persistMultiGatewayAgentsToCache(
    [{ name: 'def', displayName: 'Def', description: '', model: 'm' }],
    cacheService,
    ['gw-a'],
    1,
  );
  await flushMicrotasks();
  const singleSnap = await restoreMultiGatewayCacheSnapshot(cacheService, ['gw-a']);
  assert.equal(singleSnap.sessions.some((s) => s.id === 's-single'), true);
  assert.equal(singleSnap.agents.some((a) => a.name === 'def'), true);

  // Multi-gateway bucketed persist & restore + __room__ group bucket + turn cache
  persistMultiGatewaySessionsToCache(
    [
      { id: 'sa', title: 'A', botName: 'default', timestamp: 1000, time: '10:00', preview: '' }, // falls back to gatewayIds[0]
      { id: 'sb', title: 'B', botName: 'coder', gatewayId: 'gw-b', timestamp: 2000, time: '10:01', preview: '' },
    ],
    cacheService,
    'default',
    queue,
    ['gw-a', 'gw-b'],
    2,
  );
  persistGroupsToCache(
    [{ roomId: 'room-1', name: 'Room 1', members: ['coder', 'default'], createdAt: 100, updatedAt: 200, gatewayId: 'gw-b' }],
    cacheService,
    queue,
    '__room__',
  );
  persistMultiGatewayAgentsToCache(
    [
      { name: 'def-a', displayName: 'A', description: '', model: 'm' },
      { name: 'coder-b', displayName: 'B', description: '', model: 'm', gatewayId: 'gw-b' },
    ],
    cacheService,
    ['gw-a', 'gw-b'],
    2,
  );
  persistTurnToCache(
    'sb',
    null,
    [{ id: 'row-9', rowId: 9, role: 'assistant', content: 'hi', timestamp: '10:00', rawTimestamp: 1000 }],
    cacheService,
    false,
    'default',
    'gw-b',
  );
  await flushMicrotasks();

  const multiSnap = await restoreMultiGatewayCacheSnapshot(cacheService, ['gw-a', 'gw-b']);
  assert.equal(multiSnap.sessions.some((r) => r.kind === 'session' && r.id === 'sa' && r.gatewayId === 'gw-a'), true);
  assert.equal(multiSnap.sessions.some((r) => r.kind === 'session' && r.id === 'sb' && r.gatewayId === 'gw-b'), true);
  assert.equal(multiSnap.sessions.some((r) => r.kind === 'group' && r.id === 'room-1'), true);
  assert.equal(multiSnap.agents.some((a) => a.name === 'def-a' && a.gatewayId === 'gw-a'), true);
  assert.equal(multiSnap.agents.some((a) => a.name === 'coder-b' && a.gatewayId === 'gw-b'), true);
  const openedTurn = await cacheService.openChannel({ gatewayId: 'gw-b', profile: 'default', channel: 'session', channelId: 'sb' }, 10);
  assert.equal(openedTurn.rows.length, 1);
});

test('M1.3 liveStreamCoordinator helpers and gateway-isolated stream lifecycle', async () => {
  const st = createInitialState({ platform: 'win32' });
  st.gatewayCount = 2;
  st.activeGatewayId = 'gw-a';
  st.activeSessionId = 'shared-s';
  st.activeFocus = { type: 'session', sessionId: 'shared-s', gatewayId: 'gw-a' };

  assert.equal(isFocusedOnEntity(st, 'shared-s', 'gw-a'), true);
  assert.equal(isFocusedOnEntity(st, 'shared-s', 'gw-b'), false);
  assert.equal(isFocusedOnEntity(st, null, 'gw-a'), false);
  assert.equal(isFocusedOnEntity({ ...st, gatewayCount: 1 }, 'shared-s', 'gw-b'), true);

  st.activeFocus = { type: 'bot', botName: 'coder', gatewayId: 'gw-b' };
  st.activeGatewayId = 'gw-b';
  assert.equal(isFocusedOnBot(st, 'coder', 'gw-b'), true);
  assert.equal(isFocusedOnBot(st, 'coder', 'gw-a'), false);
  assert.equal(isFocusedOnBot({ ...st, gatewayCount: 1 }, 'coder', 'gw-a'), true);
  assert.equal(isFocusedOnBot(st, '', 'gw-b'), false);

  assert.deepEqual(
    collectGatewayScopedSessionIds(['gw-a::1', 'gw-b::2', 'gw-b::3', 'raw'], 'gw-b', 2),
    ['2', '3'],
  );
  assert.deepEqual(collectGatewayScopedSessionIds(['1', '2'], undefined, 1), ['1', '2']);

  assert.deepEqual(extractGatewayFrameMeta(null), { frameType: '', framePayload: null, rawFrameSessionId: '' });
  assert.deepEqual(
    extractGatewayFrameMeta({ event: 'message.delta', payload: { session_id: 's-nested' } }),
    { frameType: 'message.delta', framePayload: { session_id: 's-nested' }, rawFrameSessionId: 's-nested' },
  );
  assert.deepEqual(
    extractGatewayFrameMeta({ kind: 'pong', session_id: 's-top' }),
    { frameType: 'pong', framePayload: null, rawFrameSessionId: 's-top' },
  );

  const botForever = new Map([
    ['gw-a:coder', 'forever-shared'],
    ['gw-b:coder', 'forever-shared'],
    ['legacy-bot', 'forever-legacy'],
  ]);
  assert.equal(resolveBotNameForSession('forever-shared', botForever, st, 'gw-b'), 'coder');
  assert.equal(resolveBotNameForSession('forever-legacy', botForever, st, 'gw-a'), 'legacy-bot');
  st.activeSessionId = 'active-bot-sess';
  assert.equal(resolveBotNameForSession('active-bot-sess', botForever, st, 'gw-b'), 'coder');
  assert.equal(resolveBotNameForSession('active-bot-sess', botForever, st, 'gw-a'), null);

  // Coordinator end-to-end across focused GW-A and background GW-B with duplicate stored IDs
  st.gatewayCount = 2;
  st.activeGatewayId = 'gw-a';
  st.activeSessionId = 's-dup';
  st.activeFocus = { type: 'session', sessionId: 's-dup', gatewayId: 'gw-a' };
  st.sessions = [
    { id: 's-dup', title: 'A', botName: 'default', gatewayId: 'gw-a' },
    { id: 's-dup', title: 'B', botName: 'coder', gatewayId: 'gw-b' },
  ];
  st.messages = [];

  const regA = new LiveStreamRegistry();
  const regB = new LiveStreamRegistry();
  const handleA = new SessionHandleRegistry();
  const handleB = new SessionHandleRegistry();
  handleB.register({ storedId: 's-dup', liveId: 'live-b' });

  const cacheMap = new Map([['gw-a::s-dup', st.messages], ['gw-b::s-dup', []]]);
  const runningSess = new Set();
  const runningBots = new Set();
  let epoch = 1;

  const clientB = {
    async call(method) {
      if (method === 'session.resume') {
        return { session_id: 'live-b', running: true, inflight: { streaming: true, assistant: 'partial from resume' } };
      }
      return {};
    },
    async fetchSessionMessages() {
      return {
        status: 'success',
        messages: [{ id: 101, role: 'user', content: 'bg prompt from transcript' }],
      };
    },
  };

  const coord = createLiveStreamCoordinator({
    getConnectionEpoch: () => epoch,
    getState: () => st,
    getGatewayClient: () => null,
    getClientForGateway: (gw) => (gw === 'gw-b' ? clientB : null),
    getLiveStreamRegistry: () => regA,
    getLiveStreamRegistryForGateway: (gw) => (gw === 'gw-b' ? regB : regA),
    getSessionHandleRegistryForGateway: (gw) => (gw === 'gw-b' ? handleB : handleA),
    resolveBotNameForSession: (sid, gw) => (gw === 'gw-b' && sid === 's-dup' ? 'coder' : null),
    getSessionMessagesCache: () => cacheMap,
    getActiveRunningSessionIds: () => runningSess,
    getActiveRunningBotNames: () => runningBots,
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
  });

  assert.equal(coord.resolveStoredSessionId('live-b', 'gw-b'), 's-dup');
  const streamB = coord.ensureRemoteObserverStream('s-dup', 'live-b', { turnId: 'tb-1' }, 'gw-b');
  assert.ok(streamB);
  assert.equal(st.messages.length, 0, 'background gateway stream must not pollute focused GW-A st.messages');
  assert.equal(runningSess.has('gw-b::s-dup'), true);
  assert.equal(runningBots.has('gw-b:coder'), true);

  await flushMicrotasks();
  const bgMsgs = cacheMap.get('gw-b::s-dup');
  assert.equal(bgMsgs.some((m) => m.role === 'user' && m.content === 'bg prompt from transcript'), true);
  assert.equal(bgMsgs.some((m) => m.role === 'assistant' && m.content === 'partial from resume'), true);

  // Re-entering existing background stream with inflightUser text & turnId update
  coord.ensureRemoteObserverStream('s-dup', 'live-b', { turnId: 'tb-2', userText: 'ignored-if-synced' }, 'gw-b');
  assert.equal(
    coord.attachLiveTurnFromResume({
      storedSessionId: 's-dup',
      liveSessionId: 'live-b-new',
      resumeResult: { running: true, inflight: { streaming: true, assistant: 'partial from resume + more' } },
      gatewayId: 'gw-b',
    }),
    true,
  );
  coord.reconcileActiveTurnFromResume(
    's-dup',
    { sessionId: 'live-b-reconciled', running: true, inflight: { streaming: true, assistant: 'partial from resume + more!!' } },
    'gw-b',
  );
  assert.equal(regB.getBySession('s-dup')?.accumulatedText, 'partial from resume + more!!');

  // Attaching fresh stream when user IS focused on gw-b
  st.activeFocus = { type: 'session', sessionId: 's-fresh', gatewayId: 'gw-b' };
  st.activeSessionId = 's-fresh';
  st.activeGatewayId = 'gw-b';
  assert.equal(
    coord.attachLiveTurnFromResume({
      storedSessionId: 's-fresh',
      liveSessionId: 'live-fresh',
      resumeResult: { running: true, inflight: { streaming: true, user: 'user hi', assistant: 'reply hi' } },
      gatewayId: 'gw-b',
    }),
    true,
  );
  assert.equal(st.messages.some((m) => m.role === 'user' && m.content === 'user hi'), true);
  assert.equal(st.messages.some((m) => m.role === 'assistant' && m.content === 'reply hi'), true);

  // Unfocused attach on unregistered session
  coord.reconcileActiveTurnFromResume(
    's-unreg',
    { session_id: 'live-unreg', running: true, inflight: { streaming: true, assistant: 'a' } },
    'gw-a',
  );
  assert.equal(regA.hasSession('s-unreg'), true);
});

test('M1.3 GatewayEventDispatcher multi-gateway isolation, inspector gating, and reconnect hooks', () => {
  const state = createInitialState({ platform: 'win32' });
  state.gatewayCount = 2;
  state.activeGatewayId = 'gw-a';
  state.activeSessionId = 'shared-id';
  state.activeLiveSessionId = 'live-a';
  state.activeFocus = { type: 'session', sessionId: 'shared-id', gatewayId: 'gw-a' };
  state.sessions = [
    { id: 'shared-id', title: 'Title A', botName: 'default', gatewayId: 'gw-a', timestamp: 1, time: '1', preview: '' },
    { id: 'shared-id', title: 'Title B', botName: 'coder', gatewayId: 'gw-b', timestamp: 1, time: '1', preview: '' },
  ];
  state.messages = [{ id: 'ast-a', role: 'assistant', content: 'A content', timestamp: '10:00' }];

  const regA = new LiveStreamRegistry();
  const regB = new LiveStreamRegistry();
  const hA = new SessionHandleRegistry();
  const hB = new SessionHandleRegistry();
  hA.register({ storedId: 'shared-id', liveId: 'live-a' });
  hB.register({ storedId: 'shared-id', liveId: 'live-b' });

  const cacheMap = new Map([
    ['gw-a::shared-id', state.messages],
    ['gw-b::shared-id', [{ id: 'usr-b', role: 'user', content: 'hi B', timestamp: '10:00' }]],
  ]);
  const runningSess = new Set(['gw-a::shared-id']);
  const unreadSess = new Set();
  const runningBots = new Set();
  const unreadBots = new Set();
  const tracker = new ActivityTransitionTracker({ windowMs: 850 });
  const persistedTurns = [];
  const pushedTokens = [];
  let ctx = {
    activeStreamingMessageId: 'ast-a',
    activeStreamingStoredSessionId: 'shared-id',
    activeStreamingLiveId: 'live-a',
    activeStreamingBotName: null,
  };
  let projectFetches = 0;

  const dispatcher = createGatewayEventDispatcher({
    getState: () => state,
    getGatewayClient: () => null,
    getClientForGateway: () => null,
    setGatewayClient: () => {},
    getCurrentTicket: () => undefined,
    setCurrentTicket: () => {},
    getDesktopApi: () => undefined,
    getEffectiveUrl: (u) => u || '',
    testConnection: async () => ({ ok: true, message: '', latency: 1 }),
    completeEntityTurn: (_d, run, un, id, focused) => {
      run.delete(id);
      if (!focused) un.add(id);
    },
    getSessionHandleRegistry: () => hA,
    getSessionHandleRegistryForGateway: (gw) => (gw === 'gw-b' ? hB : hA),
    getLiveStreamRegistry: () => regA,
    getLiveStreamRegistryForGateway: (gw) => (gw === 'gw-b' ? regB : regA),
    resolveBotNameForSession: (_sid, gw) => (gw === 'gw-b' ? 'coder' : null),
    getSessionMessagesCache: () => cacheMap,
    getTokenCoalescer: () => ({
      push: (item) => pushedTokens.push(item),
      flush: () => {},
      clear: () => {},
      dropMessage: () => {},
    }),
    getActivityTransitionTracker: () => tracker,
    getBotActivityStore: () => ({ updateLatestActivity: () => {} }),
    getCacheService: () => ({}),
    getActiveRunningSessionIds: () => runningSess,
    getUnreadSessionIds: () => unreadSess,
    getActiveRunningBotNames: () => runningBots,
    getUnreadBotNames: () => unreadBots,
    getActiveRunningGroupRoomIds: () => new Set(),
    getUnreadGroupRoomIds: () => new Set(),
    getActiveStreamingContext: () => ctx,
    setActiveStreamingContext: (p) => { ctx = { ...ctx, ...p }; },
    getTurnStartedSessionId: () => 'shared-id',
    setTurnStartedSessionId: () => {},
    stopProfileAutoRefresh: () => {},
    startProfileAutoRefresh: () => {},
    stopAllGroupPollers: () => {},
    clearTransitionRefreshTimer: () => {},
    clearSessionsRefreshTimer: () => {},
    scheduleSessionsRefresh: () => {},
    persistTurnToCache: (sid, bot, _msgs, gw) => persistedTurns.push({ sid, bot, gw }),
    persistSessionsToCache: () => {},
    syncProfileLastMessages: () => {},
    syncAgentPresence: () => {},
    scheduleToolPatch: () => {},
    clearToolPatchQueue: () => {},
    stopRunningToolTimers: () => {},
    setMessageContent: () => {},
    toStoredSessionId: (id) => id,
    applyColdStartFocus: async () => {},
    fetchProfiles: async () => {},
    fetchSessions: async () => {},
    fetchGroupRooms: async () => {},
    fetchModelOptions: async () => {},
    fetchProjects: async () => { projectFetches += 1; },
    prefetchSlashCatalog: async () => {},
    armTurnWatchdog: () => {},
    feedTurnWatchdog: () => {},
    disarmTurnWatchdog: () => {},
    clearPresenceTerminal: () => {},
    armPresenceTerminal: () => {},
    setTimedDockNotice: () => {},
    render: () => {},
    t: (k, p) => `${k}:${p?.message ?? ''}`,
  });

  // 1. Background GW-B stream events must isolate by gateway and not clobber focused GW-A
  dispatcher.handleGatewayEvent(
    { type: 'message.start', session_id: 'live-b', payload: { turn_id: 't1', display_text: 'Run on B' } },
    'gw-b',
  );
  const bStream = regB.getBySession('shared-id');
  assert.ok(bStream);
  assert.equal(runningSess.has('gw-b::shared-id'), true);
  assert.equal(runningBots.has('gw-b:coder'), true);
  assert.equal(state.isStreaming, false, 'background GW-B start must not flip focused GW-A isStreaming');

  dispatcher.handleGatewayEvent(
    { type: 'message.delta', session_id: 'live-b', payload: { text: 'chunk-b', turn_id: 't1' } },
    'gw-b',
  );
  assert.equal(pushedTokens.some((t) => t.messageId === bStream.messageId && t.delta === 'chunk-b'), true);

  dispatcher.handleGatewayEvent(
    { type: 'tool.start', session_id: 'live-b', payload: { tool_id: 'tc-b', name: 'shell', args: '{"delegation_id":"del-1"}' } },
    'gw-b',
  );
  dispatcher.handleGatewayEvent(
    { type: 'tool.complete', session_id: 'live-b', payload: { tool_id: 'tc-b', result: { ok: true }, duration_s: 0.042 } },
    'gw-b',
  );
  const bgTool = cacheMap.get('gw-b::shared-id').find((m) => m.id === bStream.messageId)?.toolCalls?.[0];
  assert.equal(bgTool?.status, 'completed');
  assert.equal(bgTool?.delegationId, 'del-1');
  assert.equal(state.messages[0].toolCalls, undefined, 'focused GW-A message untouched');

  // Background inspector events & projects.changed from non-focused GW-B must be ignored
  dispatcher.handleGatewayEvent({ type: 'artifact.created', payload: { id: 'art-b', name: 'b.txt' } }, 'gw-b');
  dispatcher.handleGatewayEvent({ type: 'projects.changed' }, 'gw-b');
  assert.equal(state.artifacts.length, 0);
  assert.equal(projectFetches, 0);

  // session.title from GW-B only renames GW-B's copy of shared-id
  dispatcher.applyTurnActions([{ type: 'session-title', sessionId: 'shared-id', title: 'Renamed B' }], 'gw-b');
  assert.equal(state.sessions.find((s) => s.gatewayId === 'gw-a')?.title, 'Title A');
  assert.equal(state.sessions.find((s) => s.gatewayId === 'gw-b')?.title, 'Renamed B');

  // Turn complete on GW-B marks gw-b::shared-id & gw-b:coder unread without disturbing focused ctx
  dispatcher.handleGatewayEvent(
    { type: 'message.complete', session_id: 'live-b', payload: { text: 'Done on B' } },
    'gw-b',
  );
  assert.equal(unreadSess.has('gw-b::shared-id'), true);
  assert.equal(unreadBots.has('gw-b:coder'), true);
  assert.equal(persistedTurns.some((p) => p.sid === 'shared-id' && p.gw === 'gw-b'), true);
  assert.equal(ctx.activeStreamingStoredSessionId, 'shared-id', 'focused GW-A streaming context preserved');

  // Test turn-failed & reconnect helpers on background GW-B
  dispatcher.resumeReconnectStreaming('shared-id', 'live-b-2', { running: true, inflight: { streaming: true, assistant: 'resumed' } }, 'gw-b');
  assert.equal(regB.getBySession('shared-id')?.liveSessionId, 'live-b-2');
  dispatcher.applyTurnActions([{ type: 'turn-failed', sessionId: 'shared-id', message: 'boom' }], 'gw-b');
  assert.equal(runningSess.has('gw-b::shared-id'), false);
  dispatcher.resumeReconnectStreaming('shared-id', 'live-b-3', undefined, 'gw-b');
  dispatcher.finishReconnectStreaming('shared-id', 'gw-b');
  assert.equal(regB.hasSession('shared-id'), false);
});

test('M1.3 multiGatewayCoordinator per-gateway registries, refreshAllSlots, wakeAllSlots & legacy same-origin dedupe', async () => {
  const origWs = globalThis.WebSocket;
  const origLsDesc = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const sockets = [];
  const ls = createMemoryStorage({
    [GATEWAY_REGISTRY_STORAGE_KEY]: JSON.stringify([
      { id: 'gw-a', name: 'Alpha', url: 'http://127.0.0.1:8642' },
      { id: 'gw-b', name: 'Beta', url: 'http://127.0.0.1:8643' },
    ]),
  });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: ls });
  globalThis.WebSocket = class extends MockSocket {
    constructor(url) {
      super(url);
      sockets.push(this);
      queueMicrotask(() => this.open());
    }
  };
  let wiring;
  try {
    const state = createInitialState({ platform: 'win32' });
    state.gatewayUrl = 'http://127.0.0.1:8642/';
    const legacyHandle = new SessionHandleRegistry();
    const legacyStream = new LiveStreamRegistry();
    const forwarded = [];
    const serverReqs = [];
    let legacyConnected = true;
    const primaryClients = [];

    wiring = createDesktopMultiGatewayWiring({
      getState: () => state,
      getDesktopApi: () => ({
        authenticateGateway: async () => ({ ok: true, message: 'ok', latency: 1, ticket: 'tk' }),
      }),
      getFallbackHandleRegistry: () => legacyHandle,
      getFallbackLiveStreamRegistry: () => legacyStream,
      isLegacyClientConnected: () => legacyConnected,
      onPrimaryClientChange: (c) => primaryClients.push(c),
      onForwardSlotEvent: (params, gw) => forwarded.push({ gw, params }),
      onSlotServerRequest: (gw, req) => serverReqs.push({ gw, req }),
      render: () => {},
    });

    assert.equal(wiring.isMultiGatewayConfigured(), true);
    // Concurrent bootstrap calls share the same promise
    await Promise.all([wiring.bootstrap(), wiring.bootstrap()]);
    await flushMicrotasks();
    assert.equal(primaryClients.some(Boolean), true);
    assert.equal(wiring.coordinator.getConnectedClients().length, 2);

    const hA = wiring.coordinator.getHandleRegistry('gw-a');
    const hB = wiring.coordinator.getHandleRegistry('gw-b');
    const sA = wiring.coordinator.getLiveStreamRegistry('gw-a');
    const sB = wiring.coordinator.getLiveStreamRegistry('gw-b');
    assert.notEqual(hA, hB);
    assert.notEqual(sA, sB);
    assert.equal(wiring.coordinator.getHandleRegistry(), legacyHandle);
    assert.equal(wiring.coordinator.getLiveStreamRegistry(), legacyStream);

    // Same-origin legacy connected deduplicates Alpha events while Beta events forward with gw-b
    const sockA = sockets.find((s) => s.url.includes('8642'));
    const sockB = sockets.find((s) => s.url.includes('8643'));
    sockA.onmessage?.({ data: JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'ping-a' } }) });
    sockB.onmessage?.({ data: JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'ping-b' } }) });
    assert.equal(forwarded.some((e) => e.gw === 'gw-a'), false);
    assert.equal(forwarded.some((e) => e.gw === 'gw-b'), true);

    legacyConnected = false;
    sockA.onmessage?.({ data: JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'ping-a2' } }) });
    assert.equal(forwarded.some((e) => e.gw === 'gw-a'), true);

    await wiring.coordinator.refreshAllSlots();
    // Manual disconnect stays disconnected across wakeAllSlots; passive disconnect recovers on wakeAllSlots
    wiring.coordinator.disconnectGateway('gw-b');
    await wiring.wakeAllSlots('focus');
    await flushMicrotasks();
    assert.equal(wiring.coordinator.resolveClient('gw-b'), null);

    await wiring.coordinator.reconnectGateway('gw-b');
    await flushMicrotasks();
    assert.ok(wiring.coordinator.resolveClient('gw-b'));

    wiring.runtime.disconnectGateway('gw-b', false);
    await wiring.wakeAllSlots('focus');
    await flushMicrotasks();
    assert.ok(wiring.coordinator.resolveClient('gw-b'));

    // resolveActiveLiveSessionId uses per-gateway getHandleRegistry
    hB.register({ storedId: 'sess-b', liveId: 'live-b-cached' });
    state.activeSessionId = 'sess-b';
    state.activeLiveSessionId = '';
    state.activeGatewayId = 'gw-b';
    state.activeFocus = { type: 'session', sessionId: 'sess-b', gatewayId: 'gw-b' };
    const resolved = await resolveActiveLiveSessionId({
      getState: () => state,
      resolveClient: wiring.coordinator.resolveClient,
      sessionHandleRegistry: legacyHandle,
      getHandleRegistry: wiring.coordinator.getHandleRegistry,
      getGeneration: () => 1,
      describeRpcError: (e) => String(e),
    });
    assert.equal(resolved, 'live-b-cached');
  } finally {
    wiring?.runtime.dispose();
    globalThis.WebSocket = origWs;
    if (origLsDesc) Object.defineProperty(globalThis, 'localStorage', origLsDesc);
    else delete globalThis.localStorage;
  }
});

test('M1.3 services & controllers gateway propagation (group, profile, sync, org, leftRail, modal, media, mobile)', async () => {
  const state = createInitialState({ platform: 'win32' });
  state.gatewayCount = 2;
  state.gatewayConnected = true;
  state.activeGatewayId = 'gw-b';
  state.groupRooms = [
    { roomId: 'room-1', name: 'Room B', members: ['coder', 'arch'], createdAt: 1, updatedAt: 2, gatewayId: 'gw-b' },
  ];
  state.profiles = [
    { name: 'coder', displayName: 'Coder A', description: '', model: 'm', gatewayId: 'gw-a', avatar: 'av://a' },
    { name: 'coder', displayName: 'Coder B', description: '', model: 'm', gatewayId: 'gw-b' },
  ];
  state.sessions = [
    { id: 'sess-b', title: 'SB', botName: 'coder', gatewayId: 'gw-b', timestamp: 1, time: '10:00', preview: '' },
  ];

  let multiGroupRefreshCount = 0;
  const groupSvc = createGroupOperationService({
    getState: () => state,
    getGatewayClient: () => null,
    getClientForGateway: () => null,
    render: () => {},
    t: (k) => k,
    disarmRollbackOnLeave: () => {},
    unreadGroupRoomIds: new Set(),
    activeRunningGroupRoomIds: new Set(),
    activityTransitionTracker: new ActivityTransitionTracker({ windowMs: 850 }),
    turnExecutionService: {
      resetActiveGroupThread: () => {},
      syncGroupRoomLogsToState: () => {},
      refreshGroupRoomLog: async () => 0,
      sendGroupMessage: async () => {},
    },
    groupPollerManager: { isPolling: () => false, startAwaitReply: () => {}, stop: () => {}, stopAll: () => {} },
    persistGroupsToCache: () => {},
    resolveAgentAvatar: () => '',
    formatTimestamp: () => '10:00',
    nextLoadMessagesGeneration: () => 1,
    getCurrentLoadMessagesGeneration: () => 1,
    onMultiGatewayRefresh: async () => { multiGroupRefreshCount += 1; },
  });
  await groupSvc.fetchGroupRooms();
  assert.equal(multiGroupRefreshCount, 1);
  assert.equal(groupSvc.isHostedRoom('room-1'), true);
  state.activeFocus = { type: 'group', roomId: 'room-1', gatewayId: 'gw-b' };
  state.messages = [{ id: 'm1', role: 'assistant', sender: 'coder', content: 'hi', timestamp: '10:00' }];
  groupSvc.syncActiveGroupSpeakerFromMessages();
  assert.equal(state.activeGroupSpeaker, 'coder');

  // profileManagementService multi-gw refresh + per-gw getAsset + warmBotForeverChats
  let multiProfileRefresh = 0;
  const assetRequests = [];
  const clientA = {
    async call(m) {
      if (m === 'profiles.get_asset') assetRequests.push('gw-a');
      if (m === 'session.find_or_create') return { session_id: 'fc-a' };
      return {};
    },
    async request(m, p) {
      return this.call(m, p);
    },
    async fetchSessionMessages() { return { status: 'success', messages: [] }; },
  };
  const clientB = {
    async call(m) {
      if (m === 'profiles.get_asset') { assetRequests.push('gw-b'); return { data: 'ZmFrZQ==' }; }
      if (m === 'profiles.forever_chat' || m === 'session.resume') return { session_id: 'fc-b' };
      return {};
    },
    async request(m, p) {
      return this.call(m, p);
    },
    async fetchSessionMessages() {
      return { status: 'success', messages: [{ id: 1, content: 'hello bot', timestamp: 1700000000 }] };
    },
  };
  const profSvc = createProfileManagementService({
    getState: () => state,
    getGatewayClient: () => null,
    getClientForGateway: (gw) => (gw === 'gw-b' ? clientB : clientA),
    render: () => {},
    t: (k) => k,
    describeRpcError: (e) => String(e),
    botActivityStore: { updateLatestActivity: () => {} },
    unreadBotNames: new Set(),
    activityTransitionTracker: new ActivityTransitionTracker({ windowMs: 850 }),
    sessionMessagesCache: new Map(),
    syncProfileLastMessages: () => {},
    applyColdStartFocus: async () => {},
    cancelColdStartFocus: () => {},
    fetchSessions: async () => {},
    fetchModelOptions: async () => {},
    selectSession: async () => {},
    openGroupRoom: async () => {},
    restoreComposerFocus: () => {},
    disarmRollbackOnLeave: () => {},
    persistAgentsToCache: () => {},
    persistAvatarCache: () => {},
    nextLoadMessagesGeneration: () => 2,
    getCurrentLoadMessagesGeneration: () => 2,
    onMultiGatewayRefresh: async () => { multiProfileRefresh += 1; },
  });
  await profSvc.fetchProfiles({ refresh: false });
  assert.equal(multiProfileRefresh, 1);
  assert.equal(assetRequests.includes('gw-b'), true);

  // ForegroundSync passes gatewayId to openBotChat
  const openedBots = [];
  state.activeFocus = { type: 'bot', botName: 'coder', gatewayId: 'gw-b' };
  state.activeSessionId = '';
  const syncCoord = createForegroundSyncCoordinator({
    getState: () => state,
    render: () => {},
    fetchProfiles: async () => {},
    fetchSessions: async () => {},
    fetchGroupRooms: async () => {},
    prefetchSlashCatalog: async () => {},
    fetchModelOptions: async () => {},
    fetchProjects: async () => {},
    refreshActiveSession: async () => {},
    refreshGroupRoomLog: async () => 0,
    openBotChat: async (bot, gw) => openedBots.push([bot, gw]),
    getActiveViewContext: () => ({ isMobile: false, mobilePane: 'stage', homeTab: 'chats', botSubpage: null, settingsOpen: false, settingsSubpage: null }),
    hasUnsavedBotDrafts: () => false,
    quietSyncDelayMs: 5000,
    syncedFlashMs: 5000,
  });
  try {
    await syncCoord.syncOnConnected('connected');
  } finally {
    syncCoord.dispose();
  }
  assert.deepEqual(openedBots, [['coder', 'gw-b']]);

  // OrgCoordinator + LeftRailController + ModalInteractionController gatewayId pass-through
  const archivedCalls = [];
  const orgCoord = createConversationOrgCoordinator({
    getState: () => state,
    getGatewayClient: () => clientB,
    render: () => {},
    t: (k) => k,
    showToast: () => {},
    restoreComposerFocus: () => {},
    describeRpcError: (e) => String(e),
    setSessionArchived: async (id, arch, prof, gw) => {
      archivedCalls.push([id, arch, prof, gw]);
      return true;
    },
    fetchArchivedSessions: async () => {},
    openNewChatInContainer: () => {},
  });
  await orgCoord.markDoneConfirmed('session', 'sess-b', 'coder', 'gw-b');
  await orgCoord.restoreDone('session', 'sess-b', 'coder', 'gw-b');
  assert.deepEqual(archivedCalls, [
    ['sess-b', true, 'coder', 'gw-b'],
    ['sess-b', false, 'coder', 'gw-b'],
  ]);

  const railCalls = [];
  const railCtrl = createLeftRailController({
    getState: () => state,
    render: () => {},
    t: (k) => k,
    showToast: () => {},
    describeRpcError: (e) => String(e),
    getGatewayClient: () => clientB,
    getClientForGateway: () => clientB,
    groupRoomStore: {},
    cancelColdStartFocus: () => {},
    selectSession: () => {},
    openBotChat: () => {},
    openGroupRoom: () => {},
    fetchProjects: () => {},
    fetchGroupRooms: () => {},
    beginLeftRailResize: () => {},
    getActivityVariant: () => 'dot',
    activeRunningSessionIds: new Set(),
    unreadSessionIds: new Set(),
    getActiveStreamingStoredSessionId: () => null,
    activeRunningGroupRoomIds: new Set(),
    unreadGroupRoomIds: new Set(),
    activeRunningBotNames: new Set(),
    unreadBotNames: new Set(),
    resolveAgentAvatar: () => '',
    activityTransitionTracker: new ActivityTransitionTracker({ windowMs: 850 }),
    onRequestMarkDone: (k, id, title, p, gw) => railCalls.push(['mark', k, id, p, gw]),
    onRestoreDone: (k, id, p, gw) => railCalls.push(['restore', k, id, p, gw]),
    getMoveEntityContext: (k, id, p, gw) => {
      railCalls.push(['moveCtx', k, id, p, gw]);
      return { isDone: false, currentContainerId: null, hasCwdProjectMatch: false };
    },
  });
  const railActions = railCtrl.createLeftRailActions();
  railActions.onOpenSessionMenu('sess-b', 'SB', 0, 0, 'coder', 'gw-b');
  railActions.onOpenGroupMenu('room-1', 'RB', 0, 0, 'gw-b');
  railActions.onRequestMarkDone('session', 'sess-b', 'SB', 'coder', 'gw-b');
  railActions.onRestoreDone('session', 'sess-b', 'coder', 'gw-b');
  assert.equal(railCalls.some((c) => c[0] === 'mark' && c[4] === 'gw-b'), true);
  assert.equal(railCalls.some((c) => c[0] === 'restore' && c[4] === 'gw-b'), true);

  const openedGroups = [];
  const modalCtrl = createModalInteractionController({
    getState: () => state,
    commitState: (p) => Object.assign(state, p),
    requestRender: () => {},
    restoreComposerFocus: () => {},
    createNewSession: async () => null,
    deleteSession: async () => {},
    renameSession: async () => {},
    pinSession: async () => {},
    archiveSession: async () => {},
    exportMarkdown: async () => {},
    copySessionId: async () => {},
    openBotChat: async () => {},
    openBotSettings: () => {},
    openGroupRoom: async (rid, gw) => openedGroups.push([rid, gw]),
    createGroupRoom: async () => ({ room_id: 'new-room' }),
    disbandGroupRoom: async () => {},
    fetchGroupRooms: async () => {},
    t: (k) => k,
  });
  await modalCtrl.submitTaskModal({ mode: 'group', title: 'G', members: ['coder', 'arch'], gatewayId: 'gw-b' });
  assert.deepEqual(openedGroups, [['new-room', 'gw-b']]);

  // DeliverableCoordinator uses getGatewayUrlForGateway
  const verifiedUrls = [];
  state.isStreaming = false;
  state.messages = [{ id: 'm-deliv', role: 'assistant', content: 'Created file `src/app.ts`', timestamp: '10:00' }];
  state.activeFocus = { type: 'session', sessionId: 'sess-b', gatewayId: 'gw-b' };
  const deliv = createSessionDeliverableCoordinator({
    getState: () => state,
    getGatewayUrlForGateway: (gw) => `http://gateway-${gw || 'none'}:8642`,
    getDesktopApi: () => ({
      async httpProxy(req) {
        verifiedUrls.push(req.baseUrl);
        return { status: 200, body: '{}' };
      },
    }),
    onVerifiedPathsUpdated: () => {},
  });
  deliv.scheduleVerification();
  await flushMicrotasks();
  assert.equal(verifiedUrls.length > 0 && verifiedUrls[0] === 'http://gateway-gw-b:8642', true);

  // ConversationStreamController rollback cache scoping & MobileShellCoordinator multi-gw snapshot
  state.gatewayCount = 2;
  state.activeSessionId = 'sess-b';
  state.activeGatewayId = 'gw-b';
  state.activeEntityGatewayOffline = true;
  const streamMsgs = [{ id: 'u1', rowId: 1, role: 'user', content: 'hi', timestamp: '10:00' }];
  const streamCache = new Map([['gw-b::sess-b', streamMsgs]]);
  state.rollbackArmed = {
    sessionId: 'sess-b',
    targetId: 'u1',
    anchor: { kind: 'row', rowId: 1 },
    snapshot: streamMsgs,
    removedCount: 0,
    anchorLabel: '10:00',
  };
  const streamCtrl = createConversationStreamController({
    getState: () => state,
    render: () => {},
    safeCopyText: async () => true,
    syncScrollToEndVisibility: () => {},
    isSmoothScrollActive: () => false,
    setTimedDockNotice: () => {},
    isStreamingActiveForCurrentSession: () => false,
    t: (k) => k,
    getGatewayClient: () => null,
    getRpcCaller: () => ({ async request() { return {}; } }),
    getInteractiveService: () => ({}),
    selectSession: async () => {},
    scheduleSessionsRefresh: () => {},
    getSessionMessagesCache: () => streamCache,
    handleOpenFilePreview: () => {},
    syncPromptNavigatorFromScroll: () => {},
    onOpenSubagent: () => {},
    loadOlderMessages: async () => {},
    relocateMessageWindowToIndex: () => false,
    syncScrollTopToWindow: () => {},
    slideMessageWindowForward: () => {},
    expandMessageWindow: () => false,
    settleInitialBottom: () => {},
    scrollStreamToBottom: () => {},
    scheduleStreamBottomInset: () => {},
    layoutSignature: () => '',
    ensureLiveSessionId: async () => '',
    getMessageWindowStart: () => 0,
    getMessageWindowEnd: () => 10,
    isMessageWindowUserExpanded: () => false,
    setMessageWindowUserExpanded: () => {},
    getAverageRowHeightPx: () => 40,
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
    STICK_TO_BOTTOM_THRESHOLD_PX: 168,
    MESSAGE_WINDOW_CAPACITY: 120,
  });
  streamCtrl.handleRollbackCancel();
  assert.equal(Array.isArray(streamCache.get('gw-b::sess-b')), true);

  const mobCalls = [];
  const mobCoord = createMobileShellCoordinator({
    getState: () => state,
    render: () => {},
    leftRailController: railCtrl,
    resolveAgentAvatar: () => '',
    selectSession: async (id, opts) => mobCalls.push(['sel', id, opts]),
    openBotChat: async (p, gw) => mobCalls.push(['bot', p, gw]),
    openGroupRoom: async (rid, gw) => mobCalls.push(['grp', rid, gw]),
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
    getSettingsSnapshot: () => ({}),
    createSettingsActions: () => ({}),
    copyText: async () => true,
    syncReactMessageList: () => {},
    syncAgentPresenceHost: () => {},
    syncAgentPresence: () => {},
    t: (k) => k,
  });
  const mobSnap = mobCoord.buildSnapshot();
  assert.equal(mobSnap.gatewayCount, 2);
  assert.equal(mobSnap.activeEntityGatewayOffline, true);
  const mobActs = mobCoord.getActions();
  mobActs.onSelectSession('sess-b', 'coder', 'gw-b');
  mobActs.onSelectBot('coder', 'gw-b');
  mobActs.onSelectGroup('room-1', 'gw-b');
  assert.deepEqual(mobCalls, [
    ['sel', 'sess-b', { botName: 'coder', gatewayId: 'gw-b' }],
    ['bot', 'coder', 'gw-b'],
    ['grp', 'room-1', 'gw-b'],
  ]);
});
