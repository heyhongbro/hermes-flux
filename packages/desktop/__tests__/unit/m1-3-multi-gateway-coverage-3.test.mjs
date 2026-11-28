/**
 * M1.3 100% 增量覆盖率与抽取函数精准闭环测试（Part 3）
 * (packages/desktop/__tests__/unit/m1-3-multi-gateway-coverage-3.test.mjs)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ActivityTransitionTracker,
  DEFAULT_CACHE_GATEWAY_ID,
  InteractiveService,
  LiveStreamRegistry,
  SessionHandleRegistry,
} from '@hermes-flux/core';
import { createInitialState } from '../../dist/renderer/state/appState.mjs';
import { applyRestoredCacheSnapshotToState } from '../../dist/renderer/cache/desktopCacheBridge.mjs';
import {
  GATEWAY_REGISTRY_STORAGE_KEY,
  loadGatewayConfigs,
} from '../../dist/renderer/gateway/gatewayRegistryStore.mjs';
import { createMultiGatewayRuntime } from '../../dist/renderer/gateway/multiGatewayRuntime.mjs';
import {
  createDesktopMultiGatewayWiring,
  createMultiGatewayCoordinator,
  getConfiguredGatewayIds,
  isFocusedGatewaySession,
  matchesForeverChatSession,
} from '../../dist/renderer/gateway/multiGatewayCoordinator.mjs';
import { createConversationOrgCoordinator } from '../../dist/renderer/services/conversationOrgCoordinator.mjs';
import {
  createAgentAvatarResolver,
  createProfileManagementService,
} from '../../dist/renderer/services/profileManagementService.mjs';
import { createTurnExecutionService } from '../../dist/renderer/services/turnExecutionService.mjs';
import { createLeftRailController } from '../../dist/renderer/events/leftRailController.mjs';
import { createMobileShellCoordinator } from '../../dist/renderer/mobile/mobileShellCoordinator.mjs';
import { flushMicrotasks } from './helpers/gatewayDispatcherHarness.mjs';
import { advanceTimers, createGate, createMockTurnDeps } from './helpers/turnExecutionHarness.mjs';

function createMemoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
  };
}

test('M1.3 coverage closure Part 3: cache restore, avatar resolver, pool owner, org restoreDone & mobile actions', async () => {
  const noop = () => {};

  // 1. gatewayRegistryStore malformed JSON catch branch (direct & bundled coordinator copy)
  assert.deepEqual(
    loadGatewayConfigs(createMemoryStorage({ [GATEWAY_REGISTRY_STORAGE_KEY]: '{not-valid-json' })),
    [],
  );
  const prevLS = globalThis.localStorage;
  try {
    globalThis.localStorage = createMemoryStorage({ [GATEWAY_REGISTRY_STORAGE_KEY]: '{broken-json' });
    assert.deepEqual(getConfiguredGatewayIds(), []);
  } finally {
    if (prevLS === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = prevLS;
  }

  // 2. multiGatewayRuntime setSlotSlice / seedSlotSliceIfEmpty uncached slot guards (direct & coordinator bundle)
  const rt = createMultiGatewayRuntime({
    getDesktopApi: () => undefined,
    resolvePassword: async () => '',
  });
  try {
    const viewAfterUnregisteredSlice = rt.setSlotSlice('not-synced', {});
    assert.equal(viewAfterUnregisteredSlice.effectiveGatewayCount, 0);
    assert.equal(
      rt.seedSlotSliceIfEmpty('not-synced', { profiles: [{ name: 'a', displayName: 'A' }] }),
      false,
    );
  } finally {
    rt.dispose();
  }
  const wiring = createDesktopMultiGatewayWiring({
    getState: () => ({
      activeFocus: { type: 'bot', botName: 'default' },
      gatewayCount: 0,
      profiles: [],
      sessions: [],
      groupRooms: [],
    }),
    getDesktopApi: () => undefined,
    render: noop,
  });
  try {
    assert.equal(wiring.runtime.setSlotSlice('not-synced', {}).effectiveGatewayCount, 0);
    assert.equal(
      wiring.runtime.setSlotSlice('not-synced', { profiles: [], sessions: [], groups: [] }).effectiveGatewayCount,
      0,
    );
  } finally {
    wiring.runtime.dispose();
  }

  // 3. multiGatewayCoordinator resolveMessageOwner & matchesForeverChatSession branches
  assert.equal(matchesForeverChatSession(new Map([['plain', 'f1']]), ''), false);
  assert.equal(
    matchesForeverChatSession(new Map([['plain', 'f1'], ['gw-a:bot', 'f2']]), 'f1', 'bot', 'gw-b'),
    false,
  );
  const coordState = {
    activeFocus: { type: 'bot', botName: 'default', gatewayId: 'gw-a' },
    activeGatewayId: 'gw-a',
    gatewayConnected: true,
    gatewayCount: 2,
    activeEntityGatewayOffline: false,
    profiles: [],
    sessions: [],
    groupRooms: [],
  };
  const fallbackStreamReg = new LiveStreamRegistry();
  const coord = createMultiGatewayCoordinator({
    runtime: {
      getSlot: () => undefined,
      getClient: () => null,
      getHealthSummary: () => ({ totalCount: 2, connectedCount: 2, allConnected: true, anyConnected: true, slots: [] }),
      buildAggregatedView: () => ({
        health: { totalCount: 2, connectedCount: 2, allConnected: true, anyConnected: true, slots: [] },
        profiles: [], sessions: [], groupRooms: [],
      }),
    },
    getState: () => coordState,
    render: noop,
    getFallbackLiveStreamRegistry: () => fallbackStreamReg,
  });
  assert.equal(coord.resolveMessageOwner(''), null);
  const streamA = coord.getLiveStreamRegistry('gw-a');
  const streamB = coord.getLiveStreamRegistry('gw-b');
  streamA.registerStream({ storedSessionId: 's-foc', liveSessionId: 'l-foc', messageId: 'm-foc', origin: 'local' });
  streamB.registerStream({ storedSessionId: 's-bg', liveSessionId: 'l-bg', messageId: 'm-bg', origin: 'remote' });
  fallbackStreamReg.registerStream({ storedSessionId: 's-fb', liveSessionId: 'l-fb', messageId: 'm-fb', origin: 'local' });

  assert.deepEqual(coord.resolveMessageOwner('m-foc'), { sessionId: 's-foc', gatewayId: 'gw-a' });
  assert.deepEqual(coord.resolveMessageOwner('m-bg'), { sessionId: 's-bg', gatewayId: 'gw-b' });
  assert.deepEqual(coord.resolveMessageOwner('m-fb'), { sessionId: 's-fb', gatewayId: 'gw-a' });
  coordState.activeFocus = { type: 'session', sessionId: '' };
  coordState.activeGatewayId = '';
  assert.equal(coord.resolveMessageOwner('m-miss'), null);
  const coordNoFb = createMultiGatewayCoordinator({
    runtime: {
      getSlot: () => undefined,
      getClient: () => null,
      getHealthSummary: () => ({ totalCount: 1, connectedCount: 0, allConnected: false, anyConnected: false, slots: [] }),
      buildAggregatedView: () => ({
        health: { totalCount: 1, connectedCount: 0, allConnected: false, anyConnected: false, slots: [] },
        profiles: [], sessions: [], groupRooms: [],
      }),
    },
    getState: () => coordState,
    render: noop,
  });
  assert.equal(coordNoFb.resolveMessageOwner('m-miss'), null);

  // 4. applyRestoredCacheSnapshotToState (all empty/non-empty & seed branches)
  const snapState = createInitialState({ platform: 'win32' });
  assert.equal(
    applyRestoredCacheSnapshotToState({
      state: snapState,
      indexRows: [
        { id: 's-r', gatewayId: 'gw-a', profile: 'default', kind: 'session', title: 'S', preview: 'P', timestamp: 1, isArchived: false, hidden: false, pinned: false, unread: false },
        { id: 'r-r', gatewayId: '__room__', profile: '', kind: 'group', title: 'G', preview: 'GP', timestamp: 2, isArchived: false, hidden: false, pinned: false, unread: false, members: ['default'] },
      ],
      agents: [{ name: 'default', displayName: 'A', gatewayId: 'gw-a', hasAvatar: false }],
      seedCachedSlices: () => true,
    }),
    true,
  );
  assert.equal(snapState.sessions.length, 1);
  assert.equal(snapState.groupRooms.length, 1);
  assert.equal(snapState.profiles.length, 1);
  // Existing non-empty state does not overwrite, seedCachedSlices returning false leaves false
  assert.equal(
    applyRestoredCacheSnapshotToState({
      state: snapState,
      indexRows: [
        { id: 's-r2', gatewayId: DEFAULT_CACHE_GATEWAY_ID, profile: 'default', kind: 'session', title: 'S2', timestamp: 3, isArchived: false, hidden: false, pinned: false, unread: false },
        { id: 'r-r2', gatewayId: '__room__', profile: '', kind: 'group', title: 'G2', timestamp: 4, isArchived: false, hidden: false, pinned: false, unread: false },
      ],
      agents: [{ name: 'b2', displayName: 'B2', hasAvatar: false }],
      seedCachedSlices: () => false,
    }),
    false,
  );
  const emptySnapState = createInitialState({ platform: 'win32' });
  assert.equal(
    applyRestoredCacheSnapshotToState({
      state: emptySnapState,
      indexRows: [],
      agents: [],
      initialTouched: true,
    }),
    true,
  );
  assert.equal(
    applyRestoredCacheSnapshotToState({
      state: emptySnapState,
      indexRows: [],
      agents: [],
    }),
    false,
  );

  // 5. conversationOrgCoordinator.restoreDone all branches on hidden / forever / missing target
  const orgState = createInitialState({ platform: 'win32' });
  orgState.sessions = [
    { id: 'hid-s', title: 'Hid', hidden: true, botName: 'default', timestamp: 1, time: '1', preview: '' },
    { id: 'fc-s', title: 'FC', hidden: false, botName: 'default', gatewayId: 'gw-a', timestamp: 1, time: '1', preview: '' },
    { id: 'norm-s', title: 'Norm', hidden: false, botName: 'default', timestamp: 1, time: '1', preview: '' },
  ];
  const orgCoord = createConversationOrgCoordinator({
    getState: () => orgState,
    getGatewayClient: () => null,
    render: noop,
    t: (k) => k,
    showToast: noop,
    restoreComposerFocus: noop,
    describeRpcError: (e) => String(e),
    setSessionArchived: async () => true,
    isForeverChatSession: (id, _p, gw) => (id === 'fc-s' && gw === 'gw-a') || (id === 'missing-fc' && gw === 'gw-b'),
    fetchArchivedSessions: async () => {},
    openNewChatInContainer: noop,
  });
  assert.equal(await orgCoord.restoreDone('session', 'hid-s'), false);
  assert.equal(await orgCoord.restoreDone('session', 'fc-s', 'default', 'gw-a'), false);
  assert.equal(await orgCoord.restoreDone('session', 'missing-fc', 'default', 'gw-b'), false);
  assert.equal(await orgCoord.restoreDone('session', 'norm-s'), true);

  // 6. profileManagementService readCachedAvatar (empty name, gatewayCount >= 2 vs < 2 vs undefined) + createAgentAvatarResolver
  const pmState = createInitialState({ platform: 'win32' });
  pmState.gatewayCount = 2;
  pmState.activeGatewayId = 'gw-a';
  const avatarCache = new Map([
    ['coder', 'unscoped-av'],
    ['gw-a:scoped', 'scoped-a-av'],
  ]);
  const pmSvcMulti = createProfileManagementService({
    getState: () => pmState,
    getGatewayClient: () => null,
    render: noop,
    t: (k) => k,
    describeRpcError: (e) => String(e),
    botActivityStore: { updateLatestActivity: noop },
    unreadBotNames: new Set(),
    activityTransitionTracker: new ActivityTransitionTracker({ windowMs: 850 }),
    sessionMessagesCache: new Map(),
    syncProfileLastMessages: noop,
    applyColdStartFocus: async () => {},
    cancelColdStartFocus: noop,
    fetchSessions: async () => {},
    fetchModelOptions: async () => {},
    selectSession: async () => {},
    openGroupRoom: async () => {},
    restoreComposerFocus: noop,
    disarmRollbackOnLeave: noop,
    persistAgentsToCache: noop,
    persistAvatarCache: noop,
    profileAvatarCache: avatarCache,
    nextLoadMessagesGeneration: () => 1,
    getCurrentLoadMessagesGeneration: () => 1,
    onMultiGatewayRefresh: async () => {
      pmState.profiles = [
        { name: '', displayName: 'EmptyName', gatewayId: 'gw-a' },
        { name: 'coder', displayName: 'CoderB', gatewayId: 'gw-b' },
      ];
    },
  });
  await pmSvcMulti.fetchProfiles();
  assert.equal(pmState.profiles.find((p) => p.name === 'coder')?.avatar, undefined);

  const singlePmState = createInitialState({ platform: 'win32' });
  singlePmState.gatewayCount = undefined;
  singlePmState.activeGatewayId = '';
  const pmSvcSingle = createProfileManagementService({
    getState: () => singlePmState,
    getGatewayClient: () => ({
      async listProfiles() {
        return [{ name: 'coder', displayName: 'CoderSingle', gatewayId: 'gw-a' }];
      },
      async getAsset() { return null; },
    }),
    render: noop,
    t: (k) => k,
    describeRpcError: (e) => String(e),
    botActivityStore: { updateLatestActivity: noop },
    unreadBotNames: new Set(),
    activityTransitionTracker: new ActivityTransitionTracker({ windowMs: 850 }),
    sessionMessagesCache: new Map(),
    syncProfileLastMessages: noop,
    applyColdStartFocus: async () => {},
    cancelColdStartFocus: noop,
    fetchSessions: async () => {},
    fetchModelOptions: async () => {},
    selectSession: async () => {},
    openGroupRoom: async () => {},
    restoreComposerFocus: noop,
    disarmRollbackOnLeave: noop,
    persistAgentsToCache: noop,
    persistAvatarCache: noop,
    profileAvatarCache: avatarCache,
    nextLoadMessagesGeneration: () => 1,
    getCurrentLoadMessagesGeneration: () => 1,
  });
  await pmSvcSingle.fetchProfiles();
  assert.equal(singlePmState.profiles[0].avatar, 'unscoped-av');

  let persistedAvatarCalls = 0;
  const resolverState = createInitialState({ platform: 'win32' });
  resolverState.gatewayCount = 2;
  resolverState.profiles = [
    { name: 'alpha', displayName: 'Alpha A', gatewayId: 'gw-a', avatar: 'av-alpha-a' },
    { name: 'alpha', displayName: '', gatewayId: 'gw-b', avatar: 'av-alpha-b' },
    { name: 'plain', displayName: 'Plain Bot', avatar: 'av-plain' },
    { name: 'gwonly', gatewayId: 'gw-a', avatar: 'av-gwonly' },
  ];
  const resolverCache = new Map([
    ['gw-a:cachedbot', 'cached-scoped'],
    ['unscopedhit', 'cached-unscoped'],
  ]);
  const resolveAvatar = createAgentAvatarResolver({
    state: resolverState,
    avatarCache: resolverCache,
    persistAvatarCache: () => { persistedAvatarCalls += 1; },
  });
  assert.equal(resolveAvatar(''), '');
  assert.equal(resolveAvatar('cachedbot', 'gw-a'), 'cached-scoped');
  assert.equal(resolveAvatar('unscopedhit', 'gw-b'), '');
  assert.equal(resolveAvatar('Alpha A', 'gw-a'), 'av-alpha-a');
  assert.equal(resolveAvatar('alpha', 'gw-b'), 'av-alpha-b');
  assert.equal(resolveAvatar('plain', 'gw-b'), 'av-plain');
  assert.equal(resolveAvatar('alpha', 'gw-missing'), '');
  resolverState.gatewayCount = 1;
  assert.equal(resolveAvatar('unscopedhit', 'gw-b'), 'cached-unscoped');
  assert.equal(resolveAvatar('Alpha A', 'gw-missing'), 'av-alpha-a');
  assert.equal(resolveAvatar('unknown', 'gw-b'), '');
  assert.equal(resolveAvatar('plain'), 'av-plain');
  assert.equal(resolveAvatar('gwonly'), 'av-gwonly');
  assert.equal(persistedAvatarCalls >= 6, true);

  // 7. mobileShellCoordinator group member resolution + archived onActionOpen + fallback done + folder create
  const mState = createInitialState({ platform: 'ios' });
  mState.gatewayCount = 2;
  mState.activeGatewayId = 'gw-b';
  mState.activeFocus = { type: 'group', roomId: 'r-m', gatewayId: 'gw-b' };
  mState.groupRooms = [
    { roomId: 'r-m', name: 'RoomA', members: ['coder'], createdAt: 1, updatedAt: 1, gatewayId: 'gw-a' },
    { roomId: 'r-m', name: 'RoomB', members: ['coder', 'AliasB', 'ghost'], createdAt: 1, updatedAt: 2, gatewayId: 'gw-b' },
    { roomId: 'r-fb', name: 'RoomFB', members: ['coder'], createdAt: 1, updatedAt: 1, gatewayId: 'gw-a' },
    { roomId: 'r-unscoped', name: 'RoomPlain', members: ['plainbot'], createdAt: 1, updatedAt: 1 },
  ];
  mState.profiles = [
    { name: 'coder', displayName: 'Coder A', gatewayId: 'gw-a', avatar: 'av-a' },
    { name: 'coder', displayName: 'Coder B', gatewayId: 'gw-b', avatar: 'av-b' },
    { name: 'b2', displayName: 'AliasB', gatewayId: 'gw-b' },
    { name: 'plainbot' },
  ];
  mState.sessions = [
    { id: 'live-1', title: 'L1', botName: 'coder', gatewayId: 'gw-b', timestamp: 3, time: '3', preview: '' },
    { id: 'live-only-a', title: 'LA', botName: 'coder', gatewayId: 'gw-a', timestamp: 3, time: '3', preview: '' },
  ];
  mState.archivedSessions = [
    { id: 'arch-1', title: 'A1', botName: 'other', gatewayId: 'gw-a', timestamp: 1, time: '1', preview: '' },
    { id: 'arch-2', title: 'A2', botName: 'coder', gatewayId: 'gw-b', timestamp: 2, time: '2', preview: '' },
  ];
  const mSelected = [];
  const mArchived = [];
  const mCreatedFolders = [];
  const mobileNoOrg = createMobileShellCoordinator({
    getState: () => mState,
    render: noop,
    leftRailController: {
      decorateRailProfiles: () => mState.profiles,
      decorateRailGroups: () => mState.groupRooms,
      decorateRailSessions: () => mState.sessions,
    },
    resolveAgentAvatar: (n, g) => `fb:${g || ''}:${n || ''}`,
    selectSession: async (id, o) => { mSelected.push([id, o?.botName, o?.gatewayId]); },
    openBotChat: async () => {},
    openGroupRoom: async () => {},
    createNewSession: async () => null,
    renameSession: async () => {},
    pinSession: async () => {},
    archiveSession: async (id, b, g) => { mArchived.push([id, b, g]); },
    deleteSession: async () => {},
    createFolder: async (name, target) => { mCreatedFolders.push([name, target]); return 'f-new'; },
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
    ensureSettingsSectionData: noop,
    copyText: async () => true,
    storage: createMemoryStorage(),
  });
  try {
    const snapB = mobileNoOrg.buildSnapshot();
    assert.equal(snapB.groupMembers?.length, 3);
    assert.equal(snapB.groupMembers?.[0].avatar, 'av-b');
    mState.activeFocus = { type: 'group', roomId: 'r-fb', gatewayId: 'gw-b' };
    assert.equal(mobileNoOrg.buildSnapshot().groupMembers?.length, 1);
    mState.activeGatewayId = '';
    mState.activeFocus = { type: 'group', roomId: 'r-unscoped' };
    assert.equal(mobileNoOrg.buildSnapshot().groupMembers?.length, 1);

    const actions = mobileNoOrg.getActions();
    actions.onActionOpen({ kind: 'session', id: 'live-1', title: 'L1', botName: 'coder', gatewayId: 'gw-b' });
    actions.onActionOpen({ kind: 'session', id: 'live-1', title: 'L1', botName: 'other-bot', gatewayId: 'gw-b' });
    actions.onActionOpen({ kind: 'session', id: 'arch-1', title: 'A1', botName: 'wanted-bot' });
    actions.onActionOpen({ kind: 'session', id: 'arch-2', title: 'A2', botName: 'wrong-bot', gatewayId: 'gw-b' });
    actions.onActionOpen({ kind: 'session', id: 'arch-2', title: 'A2', botName: 'coder', gatewayId: 'gw-b' });
    actions.onActionOpen({ kind: 'session', id: 'missing-arch', title: 'M', botName: 'coder', gatewayId: 'gw-b' });
    mState.archivedSessions = undefined;
    actions.onActionOpen({ kind: 'session', id: 'live-only-a', title: 'LA', botName: 'other-bot', gatewayId: 'gw-b' });
    actions.onActionMarkDone({ kind: 'session', id: 's-md', title: 'MD', botName: 'default', gatewayId: 'gw-b' });
    actions.onActionMarkDone({ kind: 'group', id: 'g-md', title: 'GMD', gatewayId: 'gw-b' });
    actions.onActionRestoreDone({ kind: 'session', id: 's-rd', title: 'RD', botName: 'default', gatewayId: 'gw-b' });
    actions.onActionRestoreDone({ kind: 'group', id: 'g-rd', title: 'GRD', gatewayId: 'gw-b' });
    actions.onActionCreateFolder('EmptyTarget', null);
    actions.onActionCreateFolder('ProtectedTarget', { kind: 'bot', id: 'default', title: 'B', isProtected: true });
    actions.onActionCreateFolder('BotUnprotected', { kind: 'bot', id: 'default', title: 'B' });
    actions.onActionCreateFolder('NoGwTarget', { kind: 'session', id: 's-ng', title: 'NG' });
    actions.onActionCreateFolder('GroupWithGw', { kind: 'group', id: 'g-gw', title: 'GG', gatewayId: 'gw-b' });
    await flushMicrotasks(4);

    assert.deepEqual(mSelected, [
      ['live-1', 'coder', 'gw-b'],
      ['live-1', 'other-bot', 'gw-b'],
      ['arch-1', 'wanted-bot', 'gw-a'],
      ['arch-2', 'wrong-bot', 'gw-b'],
      ['arch-2', 'coder', 'gw-b'],
      ['missing-arch', 'coder', 'gw-b'],
      ['live-only-a', 'other-bot', 'gw-b'],
    ]);
    assert.deepEqual(mArchived, [
      ['s-md', 'default', 'gw-b'],
      ['s-rd', 'default', 'gw-b'],
    ]);
    assert.deepEqual(mCreatedFolders, [
      ['EmptyTarget', null],
      ['ProtectedTarget', null],
      ['BotUnprotected', null],
      ['NoGwTarget', { kind: 'session', id: 's-ng', profile: undefined }],
      ['GroupWithGw', { kind: 'group', id: 'g-gw', profile: undefined, gatewayId: 'gw-b' }],
    ]);
  } finally {
    mobileNoOrg.dispose();
  }

  // 8. isFocusedGatewaySession + mobileShellCoordinator inspector/profile gateway scoping
  assert.equal(isFocusedGatewaySession({ activeSessionId: '', activeFocus: { type: 'bot', botName: 'a' }, activeGatewayId: 'gw-a' }, 's1', 'gw-a'), false);
  assert.equal(isFocusedGatewaySession({ activeSessionId: 's1', activeFocus: { type: 'session', sessionId: 's1' }, activeGatewayId: 'gw-a' }, ''), false);
  assert.equal(isFocusedGatewaySession({ activeSessionId: 's1', activeFocus: { type: 'session', sessionId: 's1', gatewayId: 'gw-a' }, activeGatewayId: 'gw-a' }, 's1'), true);
  assert.equal(isFocusedGatewaySession({ activeSessionId: 's1', activeFocus: { type: 'session', sessionId: 's1' }, activeGatewayId: '' }, 's1', 'gw-a'), true);
  assert.equal(isFocusedGatewaySession({ activeSessionId: 's1', activeFocus: { type: 'session', sessionId: 's1', gatewayId: 'gw-a' }, activeGatewayId: 'gw-a' }, 's1', 'gw-a'), true);
  assert.equal(isFocusedGatewaySession({ activeSessionId: 's1', activeFocus: { type: 'session', sessionId: 's1', gatewayId: 'gw-a' }, activeGatewayId: 'gw-a' }, 's1', 'gw-b'), false);

  const mScopeState = createInitialState({ platform: 'ios' });
  mScopeState.gatewayCount = 2;
  mScopeState.activeGatewayId = 'gw-b';
  mScopeState.profileName = 'coder';
  mScopeState.activeFocus = { type: 'session', sessionId: 's-col', gatewayId: 'gw-b' };
  mScopeState.sessions = [
    { id: 's-col', title: 'A', botName: 'coder', gatewayId: 'gw-a', timestamp: 1, time: '1', preview: '' },
    { id: 's-col', title: 'B', botName: 'beta-bot', gatewayId: 'gw-b', timestamp: 2, time: '2', preview: '' },
  ];
  mScopeState.profiles = [
    { name: 'coder', displayName: 'Coder A', gatewayId: 'gw-a' },
    { name: 'beta-bot', displayName: 'Beta B', gatewayId: 'gw-b' },
  ];
  const mScopeCoord = createMobileShellCoordinator({
    getState: () => mScopeState, render: noop,
    leftRailController: { decorateRailProfiles: () => mScopeState.profiles, decorateRailGroups: () => [], decorateRailSessions: () => mScopeState.sessions },
    resolveAgentAvatar: () => '', selectSession: async () => {}, openBotChat: async () => {}, openGroupRoom: async () => {},
    createNewSession: async () => null, renameSession: async () => {}, pinSession: async () => {}, archiveSession: async () => {},
    deleteSession: async () => {}, createGroupRoom: async () => null, confirmGroupRename: async () => {}, disbandGroupRoom: async () => {},
    fetchGroupRooms: async () => {}, routeSend: async () => {}, sendGroupMessage: async () => {}, interruptTurn: async () => {},
    switchModel: async () => {}, getSettingsSnapshot: () => ({}), createSettingsActions: () => ({}), ensureSettingsSectionData: noop,
    copyText: async () => true, storage: createMemoryStorage(),
  });
  try {
    const scopeSnap = mScopeCoord.buildSnapshot();
    assert.equal(scopeSnap.inspectorBotProfile, 'beta-bot');
    assert.equal(scopeSnap.inspectorBotLabel, 'Beta B');
    mScopeState.activeGatewayId = '';
    mScopeState.activeFocus = { type: 'session', sessionId: 's-col', gatewayId: 'gw-other' };
    mScopeState.sessions = [{ id: 's-col', title: 'Fallback', botName: 'coder', timestamp: 1, time: '1', preview: '' }];
    assert.equal(mScopeCoord.buildSnapshot().inspectorBotLabel, 'Coder A');
  } finally {
    mScopeCoord.dispose();
  }

  // 9. leftRailController inline rename stores & clears editingGroupGatewayId + sameLeftRailInputs cache check
  const lrState = createInitialState({ platform: 'win32' });
  lrState.gatewayCount = 2;
  lrState.groupRooms = [
    { roomId: 'r-col', name: 'RoomA', members: ['default'], updatedAt: 1, gatewayId: 'gw-a' },
    { roomId: 'r-col', name: 'RoomB', members: ['default'], updatedAt: 2, gatewayId: 'gw-b' },
  ];
  const renamedRooms = [];
  const lrCtrl = createLeftRailController({
    getState: () => lrState, render: noop, t: (k) => k, showToast: noop, describeRpcError: (e) => String(e),
    getGatewayClient: () => null, getClientForGateway: (gw) => ({ gw }),
    groupRoomStore: { renameRoom: async (id, name, client) => { renamedRooms.push([id, name, client.gw]); } },
    cancelColdStartFocus: noop, selectSession: noop, openBotChat: noop, openGroupRoom: noop, fetchProjects: noop,
    fetchGroupRooms: async () => {}, beginLeftRailResize: noop, getActivityVariant: () => 'cloud',
    activeRunningSessionIds: new Set(), unreadSessionIds: new Set(), getActiveStreamingStoredSessionId: () => null,
    activeRunningGroupRoomIds: new Set(), unreadGroupRoomIds: new Set(), activeRunningBotNames: new Set(), unreadBotNames: new Set(),
    resolveAgentAvatar: () => '', activityTransitionTracker: new ActivityTransitionTracker({ windowMs: 850 }),
  });
  const lrActions = lrCtrl.createLeftRailActions();
  lrActions.onStartGroupRename('r-col', 'gw-b');
  assert.equal(lrState.editingGroupRoomId, 'r-col');
  assert.equal(lrState.editingGroupGatewayId, 'gw-b');
  const snap1 = lrCtrl.getLeftRailSnapshot();
  assert.equal(snap1.editingGroupGatewayId, 'gw-b');
  assert.equal(lrCtrl.getLeftRailSnapshot(), snap1);
  lrState.editingGroupGatewayId = 'gw-a';
  const snapGwChanged = lrCtrl.getLeftRailSnapshot();
  assert.notEqual(snapGwChanged, snap1);
  assert.equal(snapGwChanged.editingGroupGatewayId, 'gw-a');
  lrActions.onCancelGroupRename();
  assert.equal(lrState.editingGroupGatewayId, undefined);
  lrActions.onStartGroupRename('r-col', 'gw-b');
  lrActions.onConfirmGroupRename('r-col', 'RoomB-New');
  await flushMicrotasks(4);
  assert.equal(lrState.editingGroupGatewayId, undefined);
  assert.deepEqual(renamedRooms, [['r-col', 'RoomB-New', 'gw-b']]);
  assert.equal(lrState.groupRooms[0].name, 'RoomA');
  assert.equal(lrState.groupRooms[1].name, 'RoomB-New');
});

test('M1.3 Review Fix: turnExecutionService cross-gateway fail/race/isStreaming/askSideAgent/routeSend/watchdog isolation', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_700_000_000_000 });
  let turnSvc;
  try {
    const regA = new LiveStreamRegistry();
    const regB = new LiveStreamRegistry();
    const enteredSubmitB = createGate();
    const gateSubmitB = createGate();
    let modeB = 'reject';
    let liveSeq = 0;
    const clientA = { call: async () => ({ status: 'streaming', user_row_id: 1 }) };
    const clientB = {
      call: async (method) => {
        if (method === 'prompt.submit') {
          enteredSubmitB.notify();
          await gateSubmitB.promise;
          if (modeB === 'reject') throw new Error('gw-b boom');
          return { status: 'queued', admission_id: 'adm-b', user_row_id: 88 };
        }
        if (method === 'session.resume') return { running: false };
        return {};
      },
    };
    const raceCallbacks = [];
    const wdCompleted = [];
    const btwCalls = [];
    const groupMsgs = [];
    const mock = createMockTurnDeps({
      state: {
        gatewayCount: 2, activeGatewayId: 'gw-b', activeSessionId: 'sess-col',
        activeFocus: { type: 'session', sessionId: 'sess-col', gatewayId: 'gw-b' },
        profiles: [
          { name: 'coder-a', displayName: 'CoderX', gatewayId: 'gw-a' },
          { name: 'coder-b', displayName: 'CoderX', gatewayId: 'gw-b' },
        ],
        groupRooms: [
          { roomId: 'r-col', name: 'RoomA', members: ['alpha'], lastMessage: '', updatedAt: 1, gatewayId: 'gw-a' },
          { roomId: 'r-col', name: 'RoomB', members: ['beta'], lastMessage: '', updatedAt: 2, gatewayId: 'gw-b' },
        ],
        sessions: [
          { id: 'sess-col', title: 'S A', botName: 'coder-a', gatewayId: 'gw-a', timestamp: 1, preview: '' },
          { id: 'sess-col', title: 'S B', botName: 'coder-b', gatewayId: 'gw-b', timestamp: 2, preview: '' },
        ],
      },
    });
    const { state, deps, activeStreamingContext } = mock;
    let activeClientMode = 'b';
    deps.getClientForGateway = (gw) => (gw === 'gw-a' ? clientA : clientB);
    deps.getLiveStreamRegistryForGateway = (gw) => (gw === 'gw-a' ? regA : regB);
    deps.getInteractiveService = () => ({
      truncateAndSubmit: async () => {
        if (activeClientMode === 'b') throw new Error('b-trunc-fail');
        return { status: 'streaming', user_row_id: 21 };
      },
    });
    deps.getHandoffService = () => ({
      onUserMessage: () => {},
      sendBtw: async (_lid, q, prof) => { btwCalls.push([prof, q]); return { task_id: 'btw-1' }; },
    });
    deps.getGroupRoomStore = () => ({
      getLogs: () => [],
      fetchLogs: async () => [],
      isHostedRoom: () => false,
      sendMessage: async (rid, text) => { groupMsgs.push([rid, text]); return { status: 'ok' }; },
    });
    deps.onQueuedSubmitRace = (sid, gw) => { raceCallbacks.push([sid, gw]); };
    deps.onWatchdogTurnCompleted = async (sid, gw) => { wdCompleted.push([sid, gw]); };
    deps.watchdogIdleTimeoutMs = 25;
    turnSvc = createTurnExecutionService(deps);

    // 1. Fail on gw-b after user switches focus to colliding sess-col on gw-a must NOT wipe gw-a UI state
    const pFailB = turnSvc.sendMessage('hello b');
    await enteredSubmitB.promise;
    assert.equal(turnSvc.isStreamingActiveForCurrentSession(), true);
    state.activeFocus = { type: 'session', sessionId: 'sess-col', gatewayId: 'gw-a' };
    state.activeGatewayId = 'gw-a';
    state.isStreaming = true;
    state.messages = [{ id: 'keep-a', role: 'user', content: 'A', timestamp: '10:00' }];
    assert.equal(turnSvc.isStreamingActiveForCurrentSession(), false, 'gw-a focus must not inherit gw-b streaming context');
    gateSubmitB.notify();
    await pFailB;
    assert.equal(state.isStreaming, true, 'gw-b failure must not clear gw-a isStreaming');
    assert.equal(state.presenceTerminal, undefined);
    assert.deepEqual(state.messages.map((m) => m.id), ['keep-a']);

    // Check remaining isStreamingActiveForCurrentSession branches
    activeStreamingContext().activeStreamingStoredSessionId = 'other';
    assert.equal(turnSvc.isStreamingActiveForCurrentSession(), false);
    activeStreamingContext().activeStreamingStoredSessionId = 'sess-col';
    activeStreamingContext().activeStreamingMessageId = null;
    assert.equal(turnSvc.isStreamingActiveForCurrentSession(), true);
    state.activeGatewayId = '';
    state.activeFocus = { type: 'session', sessionId: 'sess-col' };
    activeStreamingContext().activeStreamingMessageId = 'm-any';
    assert.equal(turnSvc.isStreamingActiveForCurrentSession(), true);
    state.gatewayCount = undefined;
    assert.equal(turnSvc.isStreamingActiveForCurrentSession(), true);
    state.gatewayCount = 1;
    state.activeFocus = { type: 'session', sessionId: 'sess-col', gatewayId: 'gw-a' };
    assert.equal(turnSvc.isStreamingActiveForCurrentSession(), true);
    state.isStreaming = false;
    assert.equal(turnSvc.isStreamingActiveForCurrentSession(), false);

    // 2. Queued submit race on gw-b while focused on gw-a must preserve gw-a messages/streaming/queue
    state.gatewayCount = 2;
    modeB = 'queued';
    const enteredRaceB = createGate();
    const gateRaceB = createGate();
    clientB.call = async (method) => {
      if (method === 'prompt.submit') {
        enteredRaceB.notify();
        await gateRaceB.promise;
        return { status: 'queued', admission_id: 'adm-b', user_row_id: 88 };
      }
      if (method === 'session.resume') return { running: false };
      return {};
    };
    state.activeFocus = { type: 'session', sessionId: 'sess-col', gatewayId: 'gw-b' };
    state.activeGatewayId = 'gw-b';
    const pRaceB = turnSvc.sendMessage('queued b');
    await enteredRaceB.promise;
    state.activeFocus = { type: 'session', sessionId: 'sess-col', gatewayId: 'gw-a' };
    state.activeGatewayId = 'gw-a';
    state.isStreaming = true;
    state.queuedMessages = [];
    state.messages = [{ id: 'stay-a', role: 'user', content: 'Stay A', timestamp: '10:00' }];
    gateRaceB.notify();
    await pRaceB;
    assert.equal(state.isStreaming, true);
    assert.equal(state.queuedMessages.length, 0);
    assert.deepEqual(state.messages.map((m) => m.id), ['stay-a']);
    assert.deepEqual(raceCallbacks, [['sess-col', 'gw-b']]);

    // Rollback submit hasOlderMessages isolation (background fail vs focused success)
    state.isStreaming = false;
    activeClientMode = 'a';
    state.hasOlderMessages = true;
    state.rollbackArmed = {
      sessionId: 'sess-col', targetId: 'stay-a', anchor: { kind: 'row', rowId: 10 },
      snapshot: [{ id: 'stay-a', rowId: 10, role: 'user', content: 'Stay A', timestamp: '10:00' }], removedCount: 0, anchorLabel: '#10',
    };
    await turnSvc.sendMessage('focused rollback submit');
    assert.equal(state.hasOlderMessages, false);

    // Background gw-b rollback submits while user focuses gw-a must preserve gw-a hasOlderMessages & messages
    state.isStreaming = false;
    const enteredTruncOk = createGate();
    const gateTruncOk = createGate();
    deps.getInteractiveService = () => ({
      truncateAndSubmit: async () => {
        enteredTruncOk.notify();
        await gateTruncOk.promise;
        return { status: 'streaming', user_row_id: 22 };
      },
    });
    state.activeFocus = { type: 'session', sessionId: 'sess-col', gatewayId: 'gw-b' };
    state.activeGatewayId = 'gw-b';
    state.activeSessionId = 'sess-col';
    state.hasOlderMessages = true;
    state.rollbackArmed = {
      sessionId: 'sess-col', targetId: 'm-b', anchor: { kind: 'row', rowId: 10 },
      snapshot: [{ id: 'm-b', rowId: 10, role: 'user', content: 'B', timestamp: '10:00' }], removedCount: 0, anchorLabel: '#10',
    };
    const pTruncOk = turnSvc.sendMessage('bg ok rollback');
    await enteredTruncOk.promise;
    state.activeFocus = { type: 'session', sessionId: 'sess-col', gatewayId: 'gw-a' };
    state.activeGatewayId = 'gw-a';
    state.hasOlderMessages = true;
    state.messages = [{ id: 'stay-a-2', role: 'user', content: 'Stay A2', timestamp: '10:01' }];
    gateTruncOk.notify();
    await pTruncOk;
    assert.equal(state.hasOlderMessages, true);

    state.isStreaming = false;
    const enteredTruncFail = createGate();
    const gateTruncFail = createGate();
    deps.getInteractiveService = () => ({
      truncateAndSubmit: async () => {
        enteredTruncFail.notify();
        await gateTruncFail.promise;
        throw new Error('bg-trunc-fail');
      },
    });
    state.activeFocus = { type: 'session', sessionId: 'sess-col', gatewayId: 'gw-b' };
    state.activeGatewayId = 'gw-b';
    state.rollbackArmed = {
      sessionId: 'sess-col', targetId: 'm-b', anchor: { kind: 'row', rowId: 10 },
      snapshot: [{ id: 'snap-b', rowId: 10, role: 'user', content: 'Snap B', timestamp: '10:00' }], removedCount: 0, anchorLabel: '#10',
    };
    const pTruncFail = turnSvc.sendMessage('bg fail rollback');
    await enteredTruncFail.promise;
    state.activeFocus = { type: 'session', sessionId: 'sess-col', gatewayId: 'gw-a' };
    state.activeGatewayId = 'gw-a';
    state.messages = [{ id: 'stay-a-3', role: 'user', content: 'Stay A3', timestamp: '10:02' }];
    gateTruncFail.notify();
    await pTruncFail;
    assert.deepEqual(state.messages.map((m) => m.id), ['stay-a-3']);
    state.isStreaming = false;

    // 3. askSideAgent & routeSend & watchdog gatewayId forwarding
    state.activeFocus = { type: 'session', sessionId: 'sess-col', gatewayId: 'gw-b' };
    state.activeGatewayId = 'gw-b';
    await turnSvc.askSideAgent('btw', 'CoderX', 'why?');
    await turnSvc.askSideAgent('btw', 'unlisted-bot', 'why-miss?');
    state.profiles = [...state.profiles, { name: 'plain-bot', displayName: 'PlainDisplay' }];
    state.activeFocus = { type: 'session', sessionId: 'sess-col' };
    state.activeGatewayId = '';
    await turnSvc.askSideAgent('btw', 'PlainDisplay', 'why-unscoped?');
    assert.deepEqual(btwCalls, [['coder-b', 'why?'], ['unlisted-bot', 'why-miss?'], ['plain-bot', 'why-unscoped?']]);
    state.activeFocus = { type: 'group', roomId: 'r-col', gatewayId: 'gw-b' };
    state.activeGatewayId = 'gw-b';
    await turnSvc.routeSend('@beta inspect');
    assert.equal(groupMsgs.length, 1);

    state.activeFocus = { type: 'session', sessionId: `wd-${++liveSeq}`, gatewayId: 'gw-b' };
    state.activeSessionId = state.activeFocus.sessionId;
    state.isStreaming = true;
    turnSvc.armTurnWatchdog();
    await advanceTimers(t, 30);
    assert.deepEqual(wdCompleted, [[state.activeFocus.sessionId, 'gw-b']]);
  } finally {
    turnSvc?.getGroupPollerManager().stopAll();
    turnSvc?.disarmTurnWatchdog(true);
    t.mock.timers.reset();
  }
});
