/**
 * LiveStreamCoordinator 变异消杀全边界单测
 * (packages/desktop/__tests__/unit/liveStreamCoordinator.boundaries.test.mjs)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveStreamRegistry } from '@hermes-flux/core';
import { createLiveStreamCoordinator, resolveBotNameForSession } from '../../dist/renderer/gateway/gatewayEventDispatcher.mjs';
import { advanceTimers, flushMicrotasks } from './helpers/liveStreamHarness.mjs';

test('LiveStreamCoordinator 变异消杀全边界：resolveBot/resolveId/idleSync/userInsert/existingAttach/canReuseTail/observer', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_700_000_000_000 });
  let coord;
  let lightCoord;
  try {
  // 1. resolveBotNameForSession 在 focus.type==='bot' 但 activeSessionId !== storedSessionId 时绝不误归属 (L99)
  assert.equal(
    resolveBotNameForSession('sess-other', new Map(), {
      activeFocus: { type: 'bot', botName: 'focus-bot' },
      activeSessionId: 'sess-mine',
    }),
    null,
  );

  let client = {
    call: async (_m, p) => {
      if ('profile' in p && p.profile === 'extra-test') throw new Error('Extra inputs');
      return { running: true, inflight: { streaming: true, assistant: 'remote-ans' } };
    },
    fetchSessionMessages: async () => ({ status: 'success', messages: [] }),
  };
  let epoch = 1;
  let nearBottom = false;
  const calls = {
    refresh: [],
    dropQueued: [],
    setMsgContent: [],
    setTurnSid: [],
    ctxs: [],
    clearTerminal: 0,
    armWatchdog: 0,
    disarmWatchdog: 0,
    setUserExpanded: [],
    ensureWindow: [],
    setScrollBottom: [],
    forceSync: [],
    renders: 0,
    syncPresence: 0,
  };
  const sessionMessagesCache = new Map();
  const runningSessions = new Set();
  const runningBots = new Set();
  const reg = new LiveStreamRegistry();
  const state = {
    profileName: 'prof-def',
    sessions: [{ id: 'sess-p', title: 'P', botName: 'sess-bot', preview: '', timestamp: 0 }],
    activeSessionId: 'sess-1',
    activeLiveSessionId: 'live-raw',
    activeFocus: { type: 'session', sessionId: 'sess-1' },
    messages: [],
    gatewayConnected: true,
    isStreaming: false,
    turnStartedAt: undefined,
  };

  coord = createLiveStreamCoordinator({
    getConnectionEpoch: () => epoch,
    getState: () => state,
    getGatewayClient: () => client,
    getLiveStreamRegistry: () => reg,
    resolveBotNameForSession: (sid) => (sid === 'sess-late-bot' ? 'resolved-bot' : null),
    getSessionMessagesCache: () => sessionMessagesCache,
    getActiveRunningSessionIds: () => runningSessions,
    getActiveRunningBotNames: () => runningBots,
    setActiveStreamingContext: (p) => calls.ctxs.push(p),
    setTurnStartedSessionId: (id) => calls.setTurnSid.push(id),
    toStoredSessionId: (id) => (id === 'alias-live' ? 'sess-alias' : null),
    setMessageContent: (mid, text) => calls.setMsgContent.push([mid, text]),
    dropQueuedTokens: (mid) => calls.dropQueued.push(mid),
    armTurnWatchdog: () => { calls.armWatchdog += 1; },
    disarmTurnWatchdog: () => { calls.disarmWatchdog += 1; },
    clearPresenceTerminal: () => { calls.clearTerminal += 1; },
    syncAgentPresence: () => { calls.syncPresence += 1; },
    render: () => { calls.renders += 1; },
    refreshActiveSession: async (opts) => { calls.refresh.push(opts); },
    isStreamNearBottom: () => nearBottom,
    setPendingScrollToBottom: (v) => calls.setScrollBottom.push(v),
    setMessageWindowUserExpanded: (v) => calls.setUserExpanded.push(v),
    ensureMessageWindow: (n) => calls.ensureWindow.push(n),
    onForceSyncMessageList: (v) => calls.forceSync.push(v),
  });

  // 2. resolveStoredSessionId 四层解析顺序精确校验 (L123-139)
  reg.registerStream({ storedSessionId: 'sess-alias', liveSessionId: 'live-direct', messageId: 'm-al', origin: 'local' });
  assert.equal(coord.resolveStoredSessionId('sess-alias'), 'sess-alias');
  assert.equal(coord.resolveStoredSessionId('live-direct'), 'sess-alias');
  assert.equal(coord.resolveStoredSessionId('alias-live'), 'sess-alias');
  assert.equal(coord.resolveStoredSessionId('live-raw'), 'sess-1');
  assert.equal(coord.resolveStoredSessionId('totally-unknown'), 'totally-unknown');

  // 3. scheduleActiveSessionIdleSync 前置/后置守卫、{ checkLiveTurn: true } 实参与 clearActiveSessionSyncTimer 取消 (L110-112, L162-172)
  reg.clear();
  state.gatewayConnected = false;
  coord.scheduleActiveSessionIdleSync(5);
  state.gatewayConnected = true;
  state.activeFocus = { type: 'group', roomId: 'g1' };
  coord.scheduleActiveSessionIdleSync(5);
  state.activeFocus = { type: 'session', sessionId: 'sess-1' };
  state.isStreaming = true;
  coord.scheduleActiveSessionIdleSync(5);
  state.isStreaming = false;
  await advanceTimers(t, 5);
  assert.equal(calls.refresh.length, 0);

  // 定时器回调内部守卫（启动后变成 isStreaming 或 gatewayConnected=false）
  coord.scheduleActiveSessionIdleSync(10);
  state.isStreaming = true;
  await advanceTimers(t, 10);
  assert.equal(calls.refresh.length, 0);
  state.isStreaming = false;

  // clearActiveSessionSyncTimer 取消待触发定时
  coord.scheduleActiveSessionIdleSync(20);
  coord.clearActiveSessionSyncTimer();
  await advanceTimers(t, 20);
  assert.equal(calls.refresh.length, 0);

  // 正常触发必须传 { checkLiveTurn: true }
  coord.scheduleActiveSessionIdleSync(5);
  await advanceTimers(t, 4);
  assert.deepEqual(calls.refresh, [], '4ms 时延迟 5ms 的空闲同步定时器不得提前触发');
  await advanceTimers(t, 1);
  assert.deepEqual(calls.refresh, [{ checkLiveTurn: true }]);

  // 4. insertRemoteUserPromptIfMissing bindRowId 更新、非 bind 已存在、有效 rowId vs 无效 rowId 与递增 bubbleId (L211-232)
  reg.clear();
  reg.registerStream({ storedSessionId: 'sess-1', liveSessionId: 'l1', messageId: 'ast-u', origin: 'remote' });
  state.messages = [
    { id: 'u-match', role: 'user', content: 'same-u' },
    { id: 'ast-u', role: 'assistant', content: '' },
  ];
  assert.equal(coord.insertRemoteUserPromptIfMissing('sess-1', 'ast-u', 'same-u', 77), true);
  assert.equal(state.messages[0].rowId, 77);
  assert.equal(sessionMessagesCache.get('sess-1')[0].rowId, 77);
  assert.equal(reg.getBySession('sess-1').userMessageSynced, true);
  assert.equal(coord.insertRemoteUserPromptIfMissing('sess-1', 'ast-u', 'same-u'), false);

  state.messages = [{ id: 'ast-u', role: 'assistant', content: '' }];
  assert.equal(coord.insertRemoteUserPromptIfMissing('sess-1', 'ast-u', 'new-with-row', 88), true);
  assert.equal(state.messages[0].rowId, 88);
  assert.equal(coord.insertRemoteUserPromptIfMissing('sess-1', 'ast-u', 'new-bad-row', -5), true);
  const badRowBubble = state.messages.find((m) => m.content === 'new-bad-row');
  assert.equal('rowId' in badRowBubble, false);

  // 5. syncFocusedStreamingProjection 非空后台流不 disarmTurnWatchdog vs 空表 disarmTurnWatchdog (L259-290)
  reg.clear();
  reg.registerStream({ storedSessionId: 'sess-bg-active', liveSessionId: 'lb', messageId: 'mb', origin: 'remote' });
  const disBefore = calls.disarmWatchdog;
  coord.syncFocusedStreamingProjection('sess-1');
  assert.equal(state.isStreaming, false);
  assert.equal(calls.disarmWatchdog, disBefore, '后台仍有活跃流时不得撤防看门狗');
  reg.clear();
  coord.syncFocusedStreamingProjection('sess-1');
  assert.equal(calls.disarmWatchdog, disBefore + 1);

  // 6. attachLiveTurnFromResume 当 stream 已存在时 (L406-440 -> 消除 L410/L418/L419 NoCoverage!)
  // 6a) state.messages 已有 ast-exist 时补齐 late user 与 late assistant (L410-411)
  reg.clear();
  state.activeSessionId = 'sess-late-bot';
  state.messages = [{ id: 'ast-exist', role: 'assistant', content: '' }];
  sessionMessagesCache.delete('sess-late-bot');
  reg.registerStream({ storedSessionId: 'sess-late-bot', liveSessionId: 'old-l', messageId: 'ast-exist', origin: 'remote', initialContent: '' });
  const winBefore = calls.ensureWindow.length;
  const syncBefore = calls.forceSync.length;
  const renBefore = calls.renders;
  const presBefore = calls.syncPresence;
  assert.equal(
    coord.attachLiveTurnFromResume({
      storedSessionId: 'sess-late-bot',
      liveSessionId: 'new-l',
      resumeResult: { running: true, inflight: { streaming: true, user: 'u-late', assistant: 'a-late' } },
    }),
    true,
  );
  assert.equal(reg.getBySession('sess-late-bot').botName, 'resolved-bot');
  assert.equal(reg.getBySession('sess-late-bot').liveSessionId, 'new-l');
  assert.equal(reg.getBySession('sess-late-bot').userMessageSynced, true);
  assert.equal(runningSessions.has('sess-late-bot'), true);
  assert.equal(runningBots.has('resolved-bot'), true);
  assert.equal(state.messages.some((m) => m.role === 'user' && m.content === 'u-late'), true);
  assert.equal(state.messages.some((m) => m.id === 'ast-exist' && m.content === 'a-late'), true);
  assert.equal(calls.ensureWindow.length, winBefore + 1);
  assert.equal(calls.forceSync.length, syncBefore + 1);
  assert.equal(calls.renders, renBefore + 1);
  assert.equal(calls.syncPresence, presBefore + 1);

  // 6b) state.messages 缺失已注册气泡时 ensureAssistantMessagePresent 返回 true 触发 changed=true (L418-419)
  state.messages = [];
  sessionMessagesCache.delete('sess-late-bot');
  const renBeforeMiss = calls.renders;
  coord.attachLiveTurnFromResume({
    storedSessionId: 'sess-late-bot',
    liveSessionId: 'new-l',
    resumeResult: { running: true, inflight: { streaming: true, user: 'u-late', assistant: 'a-late' } },
  });
  assert.equal(state.messages.some((m) => m.id === 'ast-exist'), true);
  assert.equal(calls.renders, renBeforeMiss + 1);

  // unfocused existing stream 不触发前景 render/syncPresence (L430)
  const presBg = calls.syncPresence;
  const renBg = calls.renders;
  reg.registerStream({ storedSessionId: 'sess-unfocused-ex', liveSessionId: 'l-u', messageId: 'm-u', origin: 'remote' });
  sessionMessagesCache.set('sess-unfocused-ex', [{ id: 'm-u', role: 'assistant', content: 'old' }]);
  coord.attachLiveTurnFromResume({
    storedSessionId: 'sess-unfocused-ex',
    liveSessionId: 'l-u2',
    resumeResult: { running: true, inflight: { streaming: true, assistant: 'old+more' } },
  });
  assert.equal(calls.renders, renBg);
  assert.equal(calls.syncPresence, presBg);
  assert.equal(sessionMessagesCache.get('sess-unfocused-ex')[0].content, 'old+more');
  assert.equal(calls.dropQueued.includes('m-u'), true);

  // 7. attachLiveTurnFromResume 新流: running=false 返回 false (L399)、canReuseTail 真假分支与 empty inflightAssistant (L442-505)
  assert.equal(coord.attachLiveTurnFromResume({ storedSessionId: 'x', liveSessionId: 'lx', resumeResult: { running: false } }), false);
  reg.clear();
  state.activeSessionId = 'sess-reuse';
  state.messages = [{ id: 'tail-a', role: 'assistant', content: 'prefix' }];
  calls.dropQueued.length = 0;
  nearBottom = false;
  calls.setScrollBottom.length = 0;
  calls.setUserExpanded.length = 0;
  coord.attachLiveTurnFromResume({
    storedSessionId: 'sess-reuse',
    liveSessionId: 'l-reuse',
    resumeResult: { running: true, inflight: { streaming: true, user: 'u-r', assistant: 'prefix+more' } },
  });
  assert.equal(reg.getBySession('sess-reuse').messageId, 'tail-a');
  assert.equal(calls.dropQueued.includes('tail-a'), true);
  assert.equal(state.messages.some((m) => m.id === 'tail-a' && m.content === 'prefix+more'), true);
  assert.deepEqual(calls.setUserExpanded.slice(-1), [false]);
  assert.deepEqual(calls.setScrollBottom, [], 'nearBottom=false 时不得置起 setPendingScrollToBottom(true)');

  // 新流不可复用（tail 有 rowId）+ empty inflightAssistant (L462 '') + nearBottom=true + unfocused
  reg.clear();
  state.activeSessionId = 'sess-new-empty';
  state.messages = [{ id: 'tail-durable', role: 'assistant', rowId: 5, content: 'done' }];
  nearBottom = true;
  coord.attachLiveTurnFromResume({
    storedSessionId: 'sess-new-empty',
    liveSessionId: 'l-ne',
    resumeResult: { running: true, inflight: { streaming: true, assistant: '' } },
  });
  const spawnedMsg = state.messages.find((m) => m.id !== 'tail-durable');
  assert.equal(spawnedMsg?.role, 'assistant');
  assert.equal(spawnedMsg?.content, '');
  assert.equal(reg.getBySession('sess-new-empty').userMessageSynced, false);
  assert.deepEqual(calls.setScrollBottom, [true]);

  // 8. reconcileActiveTurnFromResume existing unfocused + running=false (L533-546) + ensureRemoteObserverStream unfocused/startInfo.userText (L560-618)
  const syncRecBefore = calls.forceSync.length;
  coord.reconcileActiveTurnFromResume('sess-unfocused-rec', { running: true, inflight: { streaming: true, assistant: 'init' } });
  coord.reconcileActiveTurnFromResume('sess-unfocused-rec', { running: true, session_id: 'sid-u', inflight: { streaming: true, assistant: 'init+next' } });
  assert.equal(calls.forceSync.length, syncRecBefore, 'unfocused reconcile 不得强制刷前台列表');
  assert.equal(sessionMessagesCache.get('sess-unfocused-rec').some((m) => m.content === 'init+next'), true);

  // existing focused stream 在 !isRunning 下不 crash 且保留 synced projection (L533, L543)
  state.activeSessionId = 'sess-new-empty';
  coord.reconcileActiveTurnFromResume('sess-new-empty', { running: false });

  // ensureRemoteObserverStream existing 聚焦流收到 late userText 必须同步列表并 render (L562-565)
  const fSyncEnsBefore = calls.forceSync.length;
  const renEnsBefore = calls.renders;
  coord.ensureRemoteObserverStream('sess-new-empty', 'l-ne2', { userText: 'late-observer-u' });
  assert.equal(calls.forceSync.length, fSyncEnsBefore + 1);
  assert.equal(calls.renders, renEnsBefore + 1);

  // ensureRemoteObserverStream 新聚焦流 nearBottom=false 时不得调用 setPendingScrollToBottom(true) (L609)
  reg.clear();
  state.activeSessionId = 'sess-obs-nb';
  state.messages = [];
  nearBottom = false;
  calls.setScrollBottom.length = 0;
  coord.ensureRemoteObserverStream('sess-obs-nb', 'live-obs-nb', { userText: 'prefilled-u', turnId: 't-obs' });
  assert.deepEqual(calls.setScrollBottom, []);
  assert.equal(reg.getBySession('sess-obs-nb').userMessageSynced, true);

  // 9. hydrateRemoteTurnUserMessage profile 从 state.sessions -> state.profileName -> 'default' 回退 + focused post-hydration sync (L333, L377-382)
  const sentProfiles = [];
  client = {
    call: async (_m, p) => {
      sentProfiles.push(p.profile);
      return { running: true, inflight: { streaming: true, user: 'u-hydrated', assistant: 'a-hydrated' } };
    },
    fetchSessionMessages: async () => ({ status: 'success', messages: [] }),
  };
  reg.clear();
  state.activeSessionId = 'sess-p';
  state.messages = [];
  const fHydBefore = calls.forceSync.length;
  coord.ensureRemoteObserverStream('sess-p', 'live-p');
  await flushMicrotasks();
  assert.equal(sentProfiles.at(-1), 'sess-bot');
  assert.ok(calls.forceSync.length > fHydBefore);
  assert.equal(state.messages.some((m) => m.role === 'user' && m.content === 'u-hydrated'), true);
  assert.equal(state.messages.some((m) => m.role === 'assistant' && m.content === 'a-hydrated'), true);

  // 10. 补充精确定向消杀（Hydration L116-384）
  // 10a) clearHydrationState 确实清空 hydratingRemoteSessions
  let pendResume;
  let resumeInvokeCount = 0;
  client = {
    call: async () => {
      resumeInvokeCount += 1;
      return new Promise((r) => { pendResume = r; });
    },
    fetchSessionMessages: async () => ({ status: 'success', messages: [] }),
  };
  reg.clear();
  coord.ensureRemoteObserverStream('sess-clr', 'live-clr');
  reg.removeSession('sess-clr');
  coord.ensureRemoteObserverStream('sess-clr', 'live-clr2'); // 被 hydratingRemoteSessions 去重阻塞
  assert.equal(resumeInvokeCount, 1);
  coord.clearHydrationState();
  reg.removeSession('sess-clr');
  coord.ensureRemoteObserverStream('sess-clr', 'live-clr3'); // 清空后允许重新触发
  assert.equal(resumeInvokeCount, 2);
  pendResume?.({ running: false });
  await flushMicrotasks();

  // 10b) resolveStoredSessionId hasSession vs liveSessionId vs mapped+hasSession vs uncached [] fallback (L123-147)
  reg.clear();
  sessionMessagesCache.delete('sess-uncached-brandnew');
  coord.ensureRemoteObserverStream('sess-uncached-brandnew', 'live-brandnew', { userText: 'hi' });
  assert.equal(sessionMessagesCache.get('sess-uncached-brandnew')[0].role, 'user');
  assert.equal(sessionMessagesCache.get('sess-uncached-brandnew')[1].role, 'assistant');

  // 使用专属轻量 coordinator 精确锁定 L124/L132/L170/L184/L222/L244-279/L304-382
  let lightConnected = true;
  let lightSessId = 'sess-l';
  let lightLiveId = 'live-l';
  let lightEpoch = 1;
  const lightRefresh = [];
  const lightSetMsg = [];
  const lightCtxs = [];
  const lightTurnSids = [];
  let lightClearTerm = 0;
  let lightArm = 0;
  let lightRenders = 0;
  let lightForceSync = 0;
  let lightUserWin = 0;
  let lightPresence = 0;
  let lightClient = null;
  const lightReg = new LiveStreamRegistry();
  const lightCache = new Map();
  const lightState = {
    profileName: 'def-p',
    sessions: [],
    get activeSessionId() { return lightSessId; },
    get activeLiveSessionId() { return lightLiveId; },
    set activeLiveSessionId(v) { lightLiveId = v; },
    activeFocus: { type: 'session', sessionId: 'sess-l' },
    messages: [{ id: 'u0', role: 'user', content: 'hi' }],
    get gatewayConnected() { return lightConnected; },
    isStreaming: false,
    turnStartedAt: undefined,
  };
  lightCoord = createLiveStreamCoordinator({
    getConnectionEpoch: () => lightEpoch,
    getState: () => lightState,
    getGatewayClient: () => lightClient,
    getLiveStreamRegistry: () => lightReg,
    getSessionMessagesCache: () => lightCache,
    getActiveRunningSessionIds: () => new Set(),
    getActiveRunningBotNames: () => new Set(),
    setActiveStreamingContext: (p) => lightCtxs.push(p),
    setTurnStartedSessionId: (id) => lightTurnSids.push(id),
    toStoredSessionId: (id) => (id === 'sess-reg' ? 'WRONG-MAP' : id === 'map-to-reg' ? 'sess-reg' : null),
    setMessageContent: (m, t) => lightSetMsg.push([m, t]),
    armTurnWatchdog: () => { lightArm += 1; },
    disarmTurnWatchdog: () => {},
    clearPresenceTerminal: () => { lightClearTerm += 1; },
    syncAgentPresence: () => { lightPresence += 1; },
    render: () => { lightRenders += 1; },
    refreshActiveSession: async (o) => { lightRefresh.push(o); },
    ensureMessageWindow: () => { lightUserWin += 1; },
    onForceSyncMessageList: () => { lightForceSync += 1; },
  });

  // L124 & L132 精确区分
  lightReg.registerStream({ storedSessionId: 'sess-reg', liveSessionId: 'live-reg', messageId: 'm-reg', origin: 'local' });
  assert.equal(lightCoord.resolveStoredSessionId('sess-reg'), 'sess-reg');
  lightSessId = 'sess-wrong-fallback';
  lightLiveId = 'map-to-reg';
  assert.equal(lightCoord.resolveStoredSessionId('map-to-reg'), 'sess-reg');

  // L170 定时器回调内 !gatewayConnected 与 !activeSessionId 检查
  lightConnected = true;
  lightSessId = 'sess-l';
  lightCoord.scheduleActiveSessionIdleSync(5);
  lightConnected = false;
  await advanceTimers(t, 5);
  assert.equal(lightRefresh.length, 0);
  lightConnected = true;
  lightCoord.scheduleActiveSessionIdleSync(5);
  lightSessId = '';
  await advanceTimers(t, 5);
  assert.equal(lightRefresh.length, 0);
  lightSessId = 'sess-l';

  // L184 去重 & L264-279 syncFocusedStreamingProjection 全字段断言
  lightReg.registerStream({ storedSessionId: 'sess-l', liveSessionId: 'live-l', messageId: 'm-l', botName: 'b-l', origin: 'local', startedAt: 555 });
  lightCoord.syncFocusedStreamingProjection('sess-l');
  assert.equal(lightState.messages.some((m) => m.id === 'm-l' && m.role === 'assistant'), true);
  assert.equal(lightClearTerm, 1);
  assert.equal(lightArm, 1);
  assert.equal(lightTurnSids.at(-1), 'sess-l');
  assert.deepEqual(lightCtxs.at(-1), {
    activeStreamingMessageId: 'm-l',
    activeStreamingStoredSessionId: 'sess-l',
    activeStreamingLiveId: 'live-l',
    activeStreamingBotName: 'b-l',
  });
  const countBeforeDupAst = lightState.messages.length;
  lightCoord.syncFocusedStreamingProjection('sess-l');
  assert.equal(lightState.messages.length, countBeforeDupAst);

  // L222 userRowId=0 / 1.5 不写入 rowId
  lightCoord.insertRemoteUserPromptIfMissing('sess-l', 'm-l', 'row-zero-u', 0);
  lightCoord.insertRemoteUserPromptIfMissing('sess-l', 'm-l', 'row-float-u', 1.5);
  assert.equal('rowId' in lightState.messages.find((m) => m.content === 'row-zero-u'), false);
  assert.equal('rowId' in lightState.messages.find((m) => m.content === 'row-float-u'), false);

  // L264-279 idle reset ctx 断言
  lightReg.removeSession('sess-l');
  lightCoord.syncFocusedStreamingProjection('sess-l');
  assert.equal(lightTurnSids.at(-1), null);
  assert.deepEqual(lightCtxs.at(-1), {
    activeStreamingMessageId: null,
    activeStreamingStoredSessionId: null,
    activeStreamingLiveId: null,
    activeStreamingBotName: null,
  });

  // L302-313 三级降级与 2nd 非 Extra 失败 + L335/L350/L353/L359/L377-381
  const lightCalls = [];
  const fetchOptsSeen = [];
  let resumeImpl = async (_m, p) => {
    lightCalls.push(p);
    if ('omit_messages' in p || 'profile' in p) throw new Error('Extra inputs are not permitted');
    return { running: true, inflight: { streaming: true, user: 'u-3rd', assistant: 'a-3rd' } };
  };
  let fetchImpl = async (_sid, opts) => {
    fetchOptsSeen.push(opts);
    return { status: 'success', messages: [] };
  };
  lightClient = {
    call: (m, p) => resumeImpl(m, p),
    fetchSessionMessages: (sid, opts) => fetchImpl(sid, opts),
  };
  lightState.messages = [];
  lightCache.clear();
  const winHydBefore = lightUserWin;
  const fsHydBefore = lightForceSync;
  const renHydBefore = lightRenders;
  const presHydBefore = lightPresence;
  lightCoord.ensureRemoteObserverStream('sess-l', 'live-l');
  await flushMicrotasks();
  assert.deepEqual(lightCalls, [
    { session_id: 'sess-l', profile: 'def-p', omit_messages: true },
    { session_id: 'sess-l', profile: 'def-p' },
    { session_id: 'sess-l' },
  ]);
  assert.equal(lightSetMsg.some(([mid, text]) => mid && text === 'a-3rd'), true);
  assert.equal(lightUserWin, winHydBefore + 2);
  assert.equal(lightForceSync, fsHydBefore + 2);
  assert.equal(lightRenders, renHydBefore + 2);
  assert.equal(lightPresence, presHydBefore + 2);

  // unfocused hydrateRemoteTurnUserMessage 返回 mutated=true 时写入后台缓存，但绝不触发前景 UI 刷新 (L377)
  const renBgSuccess = lightRenders;
  const fsBgSuccess = lightForceSync;
  const presBgSuccess = lightPresence;
  resumeImpl = async () => ({ running: true, inflight: { streaming: true, user: 'u-bg', assistant: 'a-bg' } });
  lightCoord.ensureRemoteObserverStream('sess-bg-hyd-ok', 'live-bg-hyd-ok');
  await flushMicrotasks();
  assert.equal(lightCache.get('sess-bg-hyd-ok').some((m) => m.content === 'u-bg'), true);
  assert.equal(lightCache.get('sess-bg-hyd-ok').some((m) => m.content === 'a-bg'), true);
  assert.equal(lightRenders, renBgSuccess);
  assert.equal(lightForceSync, fsBgSuccess);
  assert.equal(lightPresence, presBgSuccess);

  // 1st 非 Extra 错误仅发 1 次 RPC (L304) + 2nd 非 Extra 仅发 2 次 RPC (L312)
  lightCalls.length = 0;
  resumeImpl = async (_m, p) => {
    lightCalls.push(p);
    throw new Error('401 unauthorized');
  };
  lightCoord.ensureRemoteObserverStream('sess-bg-err1', 'live-bg-err1');
  await flushMicrotasks();
  assert.equal(lightCalls.length, 1);

  lightCalls.length = 0;
  const renUnf = lightRenders;
  const fsUnf = lightForceSync;
  const presUnf = lightPresence;
  resumeImpl = async (_m, p) => {
    lightCalls.push(p);
    if ('omit_messages' in p) throw new Error('Extra inputs are not permitted');
    throw new Error('503 unavailable');
  };
  lightCoord.ensureRemoteObserverStream('sess-bg-hyd', 'live-bg-hyd');
  await flushMicrotasks();
  assert.equal(lightCalls.length, 2);
  assert.equal(lightRenders, renUnf);
  assert.equal(lightForceSync, fsUnf);
  assert.equal(lightPresence, presUnf);

  // L335 (epoch changed while curStream alive) & L344 (!curStream.userMessageSynced) & L345-347 (fetchOpts) & L350/L352
  let relEpochResume;
  lightReg.clear();
  resumeImpl = () => new Promise((r) => { relEpochResume = r; });
  lightState.messages = [];
  lightCoord.ensureRemoteObserverStream('sess-l', 'live-l');
  lightEpoch += 1;
  relEpochResume({ running: true, inflight: { streaming: true, user: 'stale-ep-u', assistant: 'stale-ep-a' } });
  await flushMicrotasks();
  assert.equal(lightState.messages.some((m) => m.content === 'stale-ep-u'), false);

  // userMessageSynced 在 resume 期间被置为 true -> 不得发起冗余 fetchSessionMessages (L344)
  let relMarkSyncResume;
  fetchOptsSeen.length = 0;
  lightReg.clear();
  resumeImpl = () => new Promise((r) => { relMarkSyncResume = r; });
  lightCoord.ensureRemoteObserverStream('sess-l', 'live-l');
  lightReg.markUserSynced('sess-l');
  relMarkSyncResume({ running: true, inflight: { streaming: true } });
  await flushMicrotasks();
  assert.equal(fetchOptsSeen.length, 0);

  let relEpochFetch;
  let epochFetchEntered = false;
  lightReg.clear();
  resumeImpl = async () => ({ running: true, inflight: { streaming: true } });
  fetchImpl = (_sid, opts) => {
    fetchOptsSeen.push(opts);
    epochFetchEntered = true;
    return new Promise((r) => { relEpochFetch = r; });
  };
  lightState.messages = [];
  lightCoord.ensureRemoteObserverStream('sess-l', 'live-l');
  await flushMicrotasks();
  assert.equal(epochFetchEntered, true);
  assert.deepEqual(fetchOptsSeen.at(-1), { limit: 10, order: 'latest', profile: 'def-p' });
  lightEpoch += 1;
  relEpochFetch({ status: 'success', messages: [{ id: 'u-st-f', row_id: 1, role: 'user', content: 'stale-f-u' }] });
  await flushMicrotasks();
  assert.equal(lightState.messages.some((m) => m.content === 'stale-f-u'), false);

  // L352 fetch 在途时 stillStream messageId 被替换 -> 不得注入旧 user prompt
  let relSwapFetch;
  let swapFetchEntered = false;
  lightReg.clear();
  resumeImpl = async () => ({ running: true, inflight: { streaming: true } });
  fetchImpl = () => {
    swapFetchEntered = true;
    return new Promise((r) => { relSwapFetch = r; });
  };
  lightState.messages = [];
  lightCoord.ensureRemoteObserverStream('sess-l', 'live-l');
  await flushMicrotasks();
  assert.equal(swapFetchEntered, true);
  lightReg.registerStream({ storedSessionId: 'sess-l', liveSessionId: 'live-l', messageId: 'replaced-ast', origin: 'remote' });
  relSwapFetch({ status: 'success', messages: [{ id: 'u-sw-f', row_id: 1, role: 'user', content: 'swap-f-u' }] });
  await flushMicrotasks();
  assert.equal(lightState.messages.some((m) => m.content === 'swap-f-u'), false);

  // L353 outcome.status !== 'success' & L359 whitespace user content 忽略
  lightReg.clear();
  lightState.messages = [];
  fetchImpl = async () => ({ status: 'error', messages: [{ id: 'ue', row_id: 1, role: 'user', content: 'err-skip' }] });
  lightCoord.ensureRemoteObserverStream('sess-l', 'live-l');
  await flushMicrotasks();
  assert.equal(lightState.messages.some((m) => m.content === 'err-skip'), false);

  lightReg.clear();
  lightState.messages = [];
  fetchImpl = async () => ({ status: 'success', messages: [{ id: 'uw', row_id: 1, role: 'user', content: '   ' }] });
  lightCoord.ensureRemoteObserverStream('sess-l', 'live-l');
  await flushMicrotasks();
  assert.equal(lightState.messages.some((m) => m.role === 'user'), false);

  // 11. 补充精确定向消杀（Attach & Observer L402-617）
  nearBottom = false;
  client = null; // 避免 section 11 测试 observer 时意外触发 async hydration 干扰计数

  // 11a) attachLiveTurnFromResume existing: 空 liveSessionId 不覆盖、已有 botName 不被覆盖、已 synced user 不重复插、无变更不触发 ensureWindow/forceSync 但同步 isStreaming (L407-438)
  reg.clear();
  runningSessions.clear();
  runningBots.clear();
  state.activeSessionId = 'sess-ex-noop';
  state.isStreaming = false;
  state.messages = [{ id: 'ast-ex-n', role: 'assistant', content: 'done-txt' }];
  reg.registerStream({
    storedSessionId: 'sess-ex-noop',
    liveSessionId: 'keep-live-id',
    messageId: 'ast-ex-n',
    botName: 'orig-bot',
    origin: 'local', // userMessageSynced=true
    initialContent: 'done-txt',
  });
  const wNoop = calls.ensureWindow.length;
  const fsNoop = calls.forceSync.length;
  const renNoop = calls.renders;
  coord.attachLiveTurnFromResume({
    storedSessionId: 'sess-ex-noop',
    liveSessionId: '',
    botName: 'other-bot',
    resumeResult: { running: true, inflight: { streaming: true, user: 'ignored-dup-u', assistant: 'done-txt' } },
  });
  assert.equal(reg.getBySession('sess-ex-noop').liveSessionId, 'keep-live-id');
  assert.equal(reg.getBySession('sess-ex-noop').botName, 'orig-bot');
  assert.equal(state.messages.some((m) => m.content === 'ignored-dup-u'), false);
  assert.equal(state.isStreaming, true, 'existing focused attach 无内容变更时也必须同步焦点流式态 (L431)');
  assert.equal(calls.ensureWindow.length, wNoop);
  assert.equal(calls.forceSync.length, fsNoop);
  assert.equal(calls.renders, renNoop);

  // 11b) attachLiveTurnFromResume existing 仅 inflightAssistant 推进（L425 -> changed=true）
  coord.attachLiveTurnFromResume({
    storedSessionId: 'sess-ex-noop',
    liveSessionId: 'keep-live-id',
    resumeResult: { running: true, inflight: { streaming: true, assistant: 'done-txt+more' } },
  });
  assert.equal(calls.ensureWindow.length, wNoop + 1);
  assert.equal(calls.forceSync.length, fsNoop + 1);
  assert.equal(calls.renders, renNoop + 1);

  // 11c) attachLiveTurnFromResume 新流: tail.role='user' 不得误复用 (L447)、tail 比 inflight 更长保留 tail (L455)、空 liveId 回落 storedSessionId (L480) 与 unfocused 不刷 UI (L495)
  reg.clear();
  state.activeSessionId = 'sess-user-tail';
  state.messages = [{ id: 'u-tail', role: 'user', content: 'prefix' }];
  calls.forceSync.length = 0;
  const presAttachBefore = calls.syncPresence;
  const renAttachBefore = calls.renders;
  nearBottom = true;
  calls.setScrollBottom.length = 0;
  coord.attachLiveTurnFromResume({
    storedSessionId: 'sess-user-tail',
    liveSessionId: '',
    resumeResult: { running: true, inflight: { streaming: true, assistant: 'prefix+ai' } },
  });
  assert.notEqual(reg.getBySession('sess-user-tail').messageId, 'u-tail');
  assert.equal(reg.getBySession('sess-user-tail').liveSessionId, 'sess-user-tail');
  assert.deepEqual(calls.forceSync, [true]);
  assert.equal(calls.renders, renAttachBefore + 1);
  assert.equal(calls.syncPresence, presAttachBefore + 1);
  assert.deepEqual(calls.setScrollBottom, [true]);

  state.activeSessionId = 'sess-longer-tail';
  state.messages = [{ id: 'ast-long', role: 'assistant', content: 'already-longer-content' }];
  coord.attachLiveTurnFromResume({
    storedSessionId: 'sess-longer-tail',
    liveSessionId: 'l-long',
    resumeResult: { running: true, inflight: { streaming: true, assistant: 'already' } },
  });
  assert.equal(state.messages[0].id, 'ast-long');
  assert.equal(state.messages[0].content, 'already-longer-content');

  // unfocused 新流 attach 不调用前景 hooks (L495)
  const renUnfAt = calls.renders;
  const fsUnfAt = calls.forceSync.length;
  coord.attachLiveTurnFromResume({
    storedSessionId: 'sess-bg-at',
    liveSessionId: 'l-bg-at',
    resumeResult: { running: true, inflight: { streaming: true, user: 'u-bg-at', assistant: 'a-bg-at' } },
  });
  assert.equal(calls.renders, renUnfAt);
  assert.equal(calls.forceSync.length, fsUnfAt);

  // 11d) reconcileActiveTurnFromResume explicitLiveId 非字符串回退 (L523/L525)、running=false 不 touchActivity 但仍同步焦点 (L533/L543)
  reg.clear();
  state.activeSessionId = 'sess-rec-types';
  reg.registerStream({ storedSessionId: 'sess-rec-types', liveSessionId: 'init-l', messageId: 'm-rt', origin: 'local', nowMs: 100 });
  coord.reconcileActiveTurnFromResume('sess-rec-types', { running: true, session_id: 123, live_id: 'lid-ok', inflight: { streaming: true } });
  assert.equal(reg.getBySession('sess-rec-types').liveSessionId, 'lid-ok');
  coord.reconcileActiveTurnFromResume('sess-rec-types', { running: true, live_id: 456, sessionId: 'sid-ok', inflight: { streaming: true } });
  assert.equal(reg.getBySession('sess-rec-types').liveSessionId, 'sid-ok');

  // running=false 在 focused existing 上不刷新 lastActivityAt，但同步投影与 presence；unfocused 不同步 presence (L533, L537, L543)
  reg.getBySession('sess-rec-types').lastActivityAt = 100;
  state.isStreaming = false;
  const presRec = calls.syncPresence;
  const fsRec = calls.forceSync.length;
  const renRec = calls.renders;
  coord.reconcileActiveTurnFromResume('sess-rec-types', { running: false });
  assert.equal(reg.getBySession('sess-rec-types').lastActivityAt, 100);
  assert.equal(state.isStreaming, true);
  assert.equal(calls.syncPresence, presRec + 1);
  coord.reconcileActiveTurnFromResume('sess-rec-types', { running: true, inflight: { streaming: true, assistant: 'rec-delta' } });
  assert.equal(calls.forceSync.length, fsRec + 1);
  assert.equal(calls.renders, renRec + 1);

  reg.registerStream({ storedSessionId: 'sess-rec-unf', liveSessionId: 'l-ru', messageId: 'm-ru', origin: 'remote' });
  const presRecUnf = calls.syncPresence;
  coord.reconcileActiveTurnFromResume('sess-rec-unf', { running: false });
  assert.equal(calls.syncPresence, presRecUnf);

  // attach from reconcile when missing -> resolveBotNameForSession -> botName (L518)
  coord.reconcileActiveTurnFromResume('sess-late-bot', { running: true, session_id: 'l-lb', inflight: { streaming: true } });
  assert.equal(reg.getBySession('sess-late-bot').botName, 'resolved-bot');

  // 11e) ensureRemoteObserverStream: empty liveId 保底、unfocused existing 不刷前台、unfocused new 与 focused new 全参数校验 (L558-615)
  reg.clear();
  runningSessions.clear();
  runningBots.clear();
  state.activeSessionId = 'sess-obs-focus';
  state.messages = [];
  sessionMessagesCache.clear();

  // unfocused new bot stream
  const renObs = calls.renders;
  const fsObs = calls.forceSync.length;
  coord.ensureRemoteObserverStream('sess-late-bot', '', {});
  assert.equal(reg.getBySession('sess-late-bot').liveSessionId, 'sess-late-bot');
  assert.equal(runningSessions.has('sess-late-bot'), true);
  assert.equal(runningBots.has('resolved-bot'), true);
  assert.equal(sessionMessagesCache.get('sess-late-bot')?.[0]?.role, 'assistant');
  assert.equal(sessionMessagesCache.get('sess-late-bot')?.[0]?.content, '');
  assert.equal(calls.renders, renObs);
  assert.equal(calls.forceSync.length, fsObs);

  // unfocused existing with liveId='' & late userText 不刷前台 UI (L558, L562)
  coord.ensureRemoteObserverStream('sess-late-bot', '', { userText: 'u-unf-late' });
  assert.equal(reg.getBySession('sess-late-bot').liveSessionId, 'sess-late-bot');
  assert.equal(reg.getBySession('sess-late-bot').userMessageSynced, true);
  assert.equal(calls.renders, renObs);
  // already userMessageSynced 时再次传 userText 不重复插入 (L560)
  const bgLenBefore = sessionMessagesCache.get('sess-late-bot').length;
  coord.ensureRemoteObserverStream('sess-late-bot', 'new-bg-live', { userText: 'dup-ignored' });
  assert.equal(sessionMessagesCache.get('sess-late-bot').length, bgLenBefore);

  // focused new with nearBottom=true: ensureWindow/forceSync/render/setPendingScrollToBottom/setUserExpanded/syncPresence 全执行 (L605-614)
  nearBottom = true;
  calls.setScrollBottom.length = 0;
  calls.setUserExpanded.length = 0;
  const wObs = calls.ensureWindow.length;
  const fsObsFocus = calls.forceSync.length;
  const renObsFocus = calls.renders;
  const presObsFocus = calls.syncPresence;
  state.isStreaming = false;
  coord.ensureRemoteObserverStream('sess-obs-focus', 'live-obs-f', { turnId: 't-of', userText: 'u-of' });
  assert.equal(state.isStreaming, true, 'focused observer 必须激活前台投影 (L606)');
  assert.equal(reg.getBySession('sess-obs-focus').liveSessionId, 'live-obs-f');
  assert.equal(reg.getBySession('sess-obs-focus').turnId, 't-of');
  assert.deepEqual(calls.setUserExpanded.slice(-1), [false]);
  assert.equal(calls.ensureWindow.length, wObs + 1);
  assert.deepEqual(calls.setScrollBottom, [true]);
  assert.equal(calls.forceSync.length, fsObsFocus + 1);
  assert.equal(calls.renders, renObsFocus + 1);
  assert.equal(calls.syncPresence, presObsFocus + 1);

  // 11f) 补齐 existing observer 更新 non-empty liveId (L558)、new attach runningSessions/runningBots/already-present userSynced (L486/L489/L490) 与 startInfo.userText 不触发 hydration (L617)
  coord.ensureRemoteObserverStream('sess-obs-focus', 'live-obs-updated');
  assert.equal(reg.getBySession('sess-obs-focus').liveSessionId, 'live-obs-updated');
  coord.ensureRemoteObserverStream('sess-obs-focus', '');
  assert.equal(reg.getBySession('sess-obs-focus').liveSessionId, 'live-obs-updated');

  let hydUnexpected = 0;
  client = {
    call: async () => {
      hydUnexpected += 1;
      return { running: false };
    },
    fetchSessionMessages: async () => ({ status: 'success', messages: [] }),
  };
  coord.ensureRemoteObserverStream('sess-no-hyd', 'live-nh', { userText: 'prefilled-no-hyd' });
  assert.equal(hydUnexpected, 0, '已有 userText 置 userSynced=true 时绝不发起 hydration RPC (L617)');
  client = null;

  reg.clear();
  runningSessions.clear();
  runningBots.clear();
  state.activeSessionId = 'sess-bot-attach';
  state.messages = [
    { id: 'u-dup-attach', role: 'user', content: 'already-u' },
    { id: 'ast-tail-att', role: 'assistant', content: 'pre' },
  ];
  coord.attachLiveTurnFromResume({
    storedSessionId: 'sess-bot-attach',
    liveSessionId: 'l-ba',
    botName: 'att-bot',
    resumeResult: { running: true, inflight: { streaming: true, user: 'already-u', assistant: 'pre' } },
  });
  assert.equal(runningSessions.has('sess-bot-attach'), true);
  assert.equal(runningBots.has('att-bot'), true);
  assert.equal(reg.getBySession('sess-bot-attach').userMessageSynced, true, 'already-present 时 Boolean(inflightUser)||insertedUser 仍应为 true (L486)');
  runningBots.clear();
  coord.attachLiveTurnFromResume({
    storedSessionId: 'sess-nobot-attach',
    liveSessionId: 'l-nba',
    resumeResult: { running: true, inflight: { streaming: true, assistant: '' } },
  });
  assert.equal(runningBots.size, 0, 'resolvedBotName 为空时不得向 runningBots 写入 null (L490)');
  } finally {
    coord?.clearActiveSessionSyncTimer();
    coord?.clearHydrationState();
    lightCoord?.clearActiveSessionSyncTimer();
    lightCoord?.clearHydrationState();
    t.mock.timers.reset();
  }
});

test('LiveStreamCoordinator 多网关场景：resolveBotNameForSession / resolveStoredSessionId / hydration 按 gatewayId 严格隔离', async () => {
  const botCache = new Map([
    ['gw-a:alpha-bot', 's-dup'],
    ['gw-b:beta-bot', 's-dup'],
    ['legacy-bot', 's-leg'],
  ]);
  const baseFocusState = {
    gatewayCount: 2,
    activeGatewayId: 'gw-a',
    activeFocus: { type: 'bot', botName: 'focus-bot', gatewayId: 'gw-b' },
    activeSessionId: 's-dup',
  };
  assert.equal(resolveBotNameForSession('s-dup', botCache, baseFocusState), 'beta-bot');
  assert.equal(resolveBotNameForSession('s-dup', botCache, { ...baseFocusState, activeFocus: { type: 'session', sessionId: 's-dup' } }), 'alpha-bot');
  assert.equal(resolveBotNameForSession('s-dup', botCache, baseFocusState, 'gw-b'), 'beta-bot');
  assert.equal(resolveBotNameForSession('s-dup', botCache, baseFocusState, 'gw-a'), 'alpha-bot');
  assert.equal(resolveBotNameForSession('s-leg', botCache, baseFocusState, 'gw-a'), 'legacy-bot');
  assert.equal(resolveBotNameForSession('s-none', new Map(), baseFocusState, 'gw-a'), null, '不匹配的 activeFocus.gatewayId 不得返回 focus-bot');
  assert.equal(resolveBotNameForSession('s-none', new Map(), { ...baseFocusState, activeSessionId: 's-none' }, 'gw-b'), 'focus-bot');

  const resumeCalls = [];
  const cacheMap = new Map();
  const regA = new LiveStreamRegistry();
  const regB = new LiveStreamRegistry();
  const state = {
    gatewayCount: 2,
    gatewayConnected: true,
    profileName: 'def-prof',
    activeGatewayId: 'gw-a',
    activeSessionId: 's-dup',
    activeLiveSessionId: 'live-same',
    activeFocus: { type: 'session', sessionId: 's-dup', gatewayId: 'gw-a' },
    sessions: [
      { id: 's-dup', gatewayId: 'gw-a', botName: 'alpha-bot', title: 'A', preview: '', timestamp: 1 },
      { id: 's-dup', gatewayId: 'gw-b', botName: 'beta-bot', title: 'B', preview: '', timestamp: 2 },
    ],
    messages: [],
    isStreaming: false,
  };
  const clientA = { call: async (_m, p) => { resumeCalls.push(['gw-a', p]); return { running: false }; } };
  const clientB = { call: async (_m, p) => { resumeCalls.push(['gw-b', p]); return { running: true, inflight: { streaming: true, user: 'hi-b', assistant: '' } }; } };
  const coord = createLiveStreamCoordinator({
    getConnectionEpoch: () => 1,
    getState: () => state,
    getGatewayClient: () => clientA,
    getClientForGateway: (gw) => (gw === 'gw-a' ? clientA : gw === 'gw-b' ? clientB : null),
    getLiveStreamRegistry: () => regA,
    getLiveStreamRegistryForGateway: (gw) => (gw === 'gw-a' ? regA : gw === 'gw-b' ? regB : undefined),
    getSessionHandleRegistryForGateway: (gw) => ({
      toStoredId: (id) => (gw === 'gw-a' && id === 'h-a' ? 's-dup' : null),
      toLiveId: () => '',
      register: () => {},
      unregister: () => {},
      getLiveIds: () => [],
      clear: () => {},
    }),
    getSessionMessagesCache: () => cacheMap,
    getActiveRunningSessionIds: () => new Set(),
    getActiveRunningBotNames: () => new Set(),
    setActiveStreamingContext: () => {},
    setTurnStartedSessionId: () => {},
    toStoredSessionId: () => null,
    setMessageContent: () => {},
    clearPresenceTerminal: () => {},
    syncAgentPresence: () => {},
    render: () => {},
    armTurnWatchdog: () => {},
    disarmTurnWatchdog: () => {},
  });

  // activeLiveSessionId matches gw-a, NOT gw-b
  assert.equal(coord.resolveStoredSessionId('live-same', 'gw-b'), 'live-same', '非激活网关 gw-b 不得把同串 liveId 折叠成 activeSessionId');
  assert.equal(coord.resolveStoredSessionId('live-same', 'gw-a'), 's-dup');

  // syncFocusedStreamingProjection without gatewayId uses activeFocus.gatewayId (gw-a), ignoring regB
  regB.registerStream({ storedSessionId: 's-dup', liveSessionId: 'lv-b', messageId: 'm-b', origin: 'remote' });
  coord.syncFocusedStreamingProjection('s-dup');
  assert.equal(state.isStreaming, false, 'regB 的流不得投射到 gw-a 焦点');
  regB.removeSession('s-dup');

  // Hydration for gw-b picks clientB & beta-bot from gw-b session entry
  coord.ensureRemoteObserverStream('s-dup', 'lv-b-hyd', {}, 'gw-b');
  await flushMicrotasks();
  assert.equal(resumeCalls.length, 1);
  assert.equal(resumeCalls[0][0], 'gw-b');
  assert.equal(resumeCalls[0][1].profile, 'beta-bot');
  assert.equal(cacheMap.get('gw-b::s-dup')?.some((m) => m.role === 'user' && m.content === 'hi-b'), true);
  assert.equal(state.messages.length, 0);
});

test('LiveStreamCoordinator Hydration 变异边界强化：resolveBot/resolveId/idleSync/projection/fetchSessionMessages 回退与 epoch 守卫', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    // 1. resolveBotNameForSession gatewayCount=1 vs 2 边界及纯 key fallback
    const plainCache = new Map([['plain-bot', 's-plain']]);
    assert.equal(resolveBotNameForSession('s-plain', plainCache, { activeFocus: { type: 'bot', botName: 'f' } }), 'plain-bot');
    assert.equal(
      resolveBotNameForSession(
        's-miss',
        new Map(),
        { gatewayCount: 1, activeFocus: { type: 'bot', botName: 'focus-bot', gatewayId: 'gw-a' }, activeSessionId: 's-miss' },
        'gw-b',
      ),
      'focus-bot',
      'gatewayCount < 2 时忽略网关隔离并回退 focus-bot',
    );

    // 2. idleSync / projection / hydration 完整生命周期（onInteractiveResumeReconciled + fetchSessionMessages + inflightAssistant + epoch guard）
    const regA = new LiveStreamRegistry();
    const regB = new LiveStreamRegistry();
    const cacheMap = new Map();
    const reconciled = [];
    let epoch = 1;
    let clientMode = 'fetch-fallback';
    let refreshCalls = 0;
    let disarmCalls = 0;
    let ensureWindowLast = 0;
    let forceSyncLast = false;
    let renderCalls = 0;
    let syncPresenceCalls = 0;
    const setMsgCalls = [];
    const activeRunningSessions = new Set();
    const activeRunningBots = new Set();

    const state = {
      gatewayCount: 2,
      gatewayConnected: true,
      profileName: 'def-prof',
      activeGatewayId: 'gw-a',
      activeSessionId: 's-idle',
      activeLiveSessionId: 'lv-active',
      activeFocus: { type: 'session', sessionId: 's-idle' },
      sessions: [{ id: 's-hyd', gatewayId: 'gw-b', botName: 'beta-bot', title: 'B', preview: '', timestamp: 2 }],
      messages: [],
      isStreaming: true,
      turnStartedAt: 123,
    };

    const clientA = {
      call: async () => ({ running: false }),
    };
    const clientB = {
      call: async () => {
        if (clientMode === 'bump-epoch-resume') {
          epoch += 1;
        }
        return {
          session_id: 'lv-hyd-ret',
          stored_session_id: 's-hyd',
          running: true,
          inflight: { streaming: true, user: '', assistant: 'reconciled-assistant' },
        };
      },
      fetchSessionMessages: async () => {
        if (clientMode === 'bump-epoch-fetch') {
          epoch += 1;
        }
        return {
          status: 'success',
          messages: [
            { id: 'u-empty', row_id: 1, role: 'user', content: '   ' },
            { id: 'u-real', row_id: 42, role: 'user', content: 'fetched-user-prompt' },
          ],
        };
      },
    };

    const coord = createLiveStreamCoordinator({
      getConnectionEpoch: () => epoch,
      getState: () => state,
      getGatewayClient: () => clientA,
      getClientForGateway: (gw) => (gw === 'gw-a' ? clientA : gw === 'gw-b' ? clientB : null),
      getLiveStreamRegistry: () => regA,
      getLiveStreamRegistryForGateway: (gw) => (gw === 'gw-a' ? regA : gw === 'gw-b' ? regB : undefined),
      getSessionHandleRegistryForGateway: () => ({
        toStoredId: (id) => (id === 'h-mapped' ? 's-mapped' : null),
        toLiveId: () => '',
        register: () => {},
        unregister: () => {},
        getLiveIds: () => [],
        clear: () => {},
      }),
      getSessionMessagesCache: () => cacheMap,
      getActiveRunningSessionIds: () => activeRunningSessions,
      getActiveRunningBotNames: () => activeRunningBots,
      setActiveStreamingContext: () => {},
      setTurnStartedSessionId: () => {},
      toStoredSessionId: () => null,
      setMessageContent: (mid, text) => setMsgCalls.push({ mid, text }),
      clearPresenceTerminal: () => {},
      syncAgentPresence: () => { syncPresenceCalls += 1; },
      render: () => { renderCalls += 1; },
      armTurnWatchdog: () => {},
      disarmTurnWatchdog: () => { disarmCalls += 1; },
      refreshActiveSession: async () => { refreshCalls += 1; },
      ensureMessageWindow: (n) => { ensureWindowLast = n; },
      onForceSyncMessageList: (v) => { forceSyncLast = v; },
      onCaptureInteractiveFence: () => 7,
      onInteractiveResumeReconciled: (info) => reconciled.push(info),
    });

    // resolveStoredSessionId: mapped in streamRegistry & gatewayCount < 2 fallback
    regA.registerStream({ storedSessionId: 's-mapped', liveSessionId: 'lv-m', messageId: 'm-m', origin: 'remote' });
    assert.equal(coord.resolveStoredSessionId('lv-m', 'gw-a'), 's-mapped');
    assert.equal(coord.resolveStoredSessionId('h-mapped', 'gw-a'), 's-mapped');
    state.gatewayCount = 1;
    assert.equal(coord.resolveStoredSessionId('lv-active', 'gw-b'), 's-idle');
    state.gatewayCount = 2;
    regA.removeSession('s-mapped');

    // syncFocusedStreamingProjection(undefined): resets streaming state and disarms watchdog when focused reg is empty
    state.isStreaming = true;
    coord.syncFocusedStreamingProjection();
    assert.equal(state.isStreaming, false);
    assert.equal(disarmCalls, 1);

    // scheduleActiveSessionIdleSync skips if streamRegistry already has activeSessionId, triggers when absent
    regA.registerStream({ storedSessionId: 's-idle', liveSessionId: 'lv-i', messageId: 'm-i', origin: 'remote' });
    coord.scheduleActiveSessionIdleSync(30);
    t.mock.timers.tick(50);
    assert.equal(refreshCalls, 0);
    regA.removeSession('s-idle');

    coord.scheduleActiveSessionIdleSync(30);
    t.mock.timers.tick(50);
    assert.equal(refreshCalls, 1);

    // ensureRemoteObserverStream when focused on gw-b::s-hyd: fetchSessionMessages fallback + onInteractiveResumeReconciled + inflightAssistant
    state.activeFocus = { type: 'session', sessionId: 's-hyd', gatewayId: 'gw-b' };
    state.activeSessionId = 's-hyd';
    state.activeGatewayId = 'gw-b';
    coord.ensureRemoteObserverStream('s-hyd', 'lv-hyd', {}, 'gw-b');
    await flushMicrotasks();

    assert.equal(reconciled.length, 1);
    assert.equal(reconciled[0].storedSessionId, 's-hyd');
    assert.equal(reconciled[0].liveSessionId, 'lv-hyd-ret');
    assert.equal(reconciled[0].fence, 7);
    assert.equal(state.messages.some((m) => m.role === 'user' && m.content === 'fetched-user-prompt' && m.rowId === 42), true);
    assert.ok(setMsgCalls.some((c) => c.text === 'reconciled-assistant'));
    assert.ok(ensureWindowLast >= 2);
    assert.equal(forceSyncLast, true);
    assert.ok(renderCalls > 0);
    assert.ok(syncPresenceCalls > 0);

    // Epoch changed during fetchSessionMessages -> aborts before inserting
    regB.removeSession('s-hyd');
    cacheMap.delete('gw-b::s-hyd');
    state.messages = [];
    clientMode = 'bump-epoch-fetch';
    coord.ensureRemoteObserverStream('s-hyd', 'lv-hyd-2', {}, 'gw-b');
    await flushMicrotasks();
    assert.equal(state.messages.some((m) => m.role === 'user'), false);

    // Epoch changed during callSessionResumeQuick -> skips reconciler & fetchSessionMessages
    regB.removeSession('s-hyd');
    cacheMap.delete('gw-b::s-hyd');
    state.messages = [];
    clientMode = 'bump-epoch-resume';
    coord.ensureRemoteObserverStream('s-hyd', 'lv-hyd-3', {}, 'gw-b');
    await flushMicrotasks();
    assert.equal(state.messages.some((m) => m.role === 'user'), false);
  } finally {
    t.mock.timers.reset();
  }
});
