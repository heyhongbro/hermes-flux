/**
 * 桌面与移动端交互停靠宿主装配、顶部避让偏移、焦点隔离与通知桥单测
 * (packages/desktop/__tests__/unit/interactive-wiring.test.mjs)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyToolOutputRiskAction,
  collectBotForeverSessionMap,
  createDesktopInteractiveSubsystem,
  createGatewayNotificationBridge,
  createInteractiveWiring,
  isProtectedIslandFocus,
  reconcileLiveSessionResume,
  resolveWaitingSummaryEntityLabel,
  scheduleRestoreComposerFocus,
  syncInteractiveTopPillOffset,
} from '../../dist/renderer/interactiveWiring.mjs';

function makeDomEl(overrides = {}) {
  const attrs = new Map(Object.entries(overrides.attrs ?? {}));
  return {
    dataset: overrides.dataset ?? {},
    childElementCount: overrides.childElementCount ?? 0,
    firstElementChild: overrides.firstElementChild ?? null,
    isConnected: overrides.isConnected ?? true,
    classList: { contains: (cls) => Boolean(overrides.classes?.includes(cls)) },
    setAttribute: (k, v) => attrs.set(k, v),
    getAttribute: (k) => attrs.get(k) ?? null,
    removeAttribute: (k) => attrs.delete(k),
    closest: (sel) => (overrides.closestMatch === sel ? {} : null),
    focus() {
      this.focused = true;
    },
    focused: false,
    _attrs: attrs,
  };
}

test('isProtectedIslandFocus & scheduleRestoreComposerFocus 精确保护交互岛与密码输入框', async (t) => {
  const prevDoc = globalThis.document;
  const prevHtmlInput = globalThis.HTMLInputElement;
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });

  class FakeInput {
    constructor(type) {
      this.type = type;
    }
  }
  globalThis.HTMLInputElement = FakeInput;
  try {
    assert.equal(isProtectedIslandFocus(null), false);
    assert.equal(isProtectedIslandFocus(makeDomEl({ closestMatch: '[data-flux-island]' })), true);
    assert.equal(isProtectedIslandFocus(new FakeInput('password')), true);
    assert.equal(isProtectedIslandFocus(new FakeInput('text')), false);

    // document === undefined 早退
    globalThis.document = undefined;
    scheduleRestoreComposerFocus();

    // 焦点已停留在受保护交互岛内时直接跳过不抢焦
    globalThis.document = {
      activeElement: new FakeInput('password'),
      getElementById: () => makeDomEl(),
    };
    scheduleRestoreComposerFocus();

    // 非受保护元素时延迟 30ms 将焦点拉回 #dock-prompt-input
    const dockInput = makeDomEl();
    globalThis.document = {
      activeElement: makeDomEl(),
      getElementById: (id) => (id === 'dock-prompt-input' ? dockInput : null),
    };
    scheduleRestoreComposerFocus();
    t.mock.timers.tick(30);
    await Promise.resolve();
    assert.equal(dockInput.focused, true);

    // 延迟期间焦点已落回 dockInput 时不重复聚焦
    globalThis.document = {
      activeElement: dockInput,
      getElementById: () => dockInput,
    };
    dockInput.focused = false;
    scheduleRestoreComposerFocus();
    t.mock.timers.tick(30);
    assert.equal(dockInput.focused, false);
  } finally {
    globalThis.HTMLInputElement = prevHtmlInput;
    globalThis.document = prevDoc;
    t.mock.timers.reset();
  }
});

test('syncInteractiveTopPillOffset 覆盖无DOM/无Host/dataset/setAttribute回退、connHost、presenceHost与清理', () => {
  const prevDoc = globalThis.document;
  try {
    globalThis.document = undefined;
    syncInteractiveTopPillOffset();

    globalThis.document = { getElementById: () => null };
    syncInteractiveTopPillOffset();

    // 1. connHost 存在且有子节点 -> below-connection（分别测试有 dataset 与无 dataset 回退）
    const pillWithDataset = makeDomEl();
    const pillNoDataset = { ...makeDomEl(), dataset: undefined };
    let currentPill = pillWithDataset;
    let connEl = makeDomEl({ childElementCount: 1 });
    let presEl = null;
    globalThis.document = {
      getElementById: (id) => {
        if (id === 'react-interactive-top-pill-host') return currentPill;
        if (id === 'react-conv-connection-host') return connEl;
        if (id === 'react-conv-presence-host') return presEl;
        return null;
      },
    };
    syncInteractiveTopPillOffset();
    assert.equal(pillWithDataset.dataset.topOffset, 'below-connection');

    currentPill = pillNoDataset;
    connEl = makeDomEl({ firstElementChild: {} });
    syncInteractiveTopPillOffset();
    assert.equal(pillNoDataset.getAttribute('data-top-offset'), 'below-connection');

    // 2. 无 connHost，stage presence 显现 -> below-presence（含 dataset 与 setAttribute 分支）
    connEl = null;
    presEl = makeDomEl({ firstElementChild: {} });
    currentPill = pillWithDataset;
    syncInteractiveTopPillOffset();
    assert.equal(pillWithDataset.dataset.topOffset, 'below-presence');

    currentPill = pillNoDataset;
    syncInteractiveTopPillOffset();
    assert.equal(pillNoDataset.getAttribute('data-top-offset'), 'below-presence');

    // 3. presence 为 mobileSlot / dock / replaced / 无子节点 -> 清空 topOffset
    presEl = makeDomEl({ childElementCount: 1, dataset: { mobileSlot: 'true' } });
    currentPill = pillWithDataset;
    syncInteractiveTopPillOffset();
    assert.equal(pillWithDataset.dataset.topOffset, undefined);

    presEl = makeDomEl({ childElementCount: 1, classes: ['presence-host--dock'] });
    syncInteractiveTopPillOffset();
    assert.equal(pillWithDataset.dataset.topOffset, undefined);

    presEl = makeDomEl({ childElementCount: 1, dataset: { replaced: 'true' } });
    syncInteractiveTopPillOffset();
    assert.equal(pillWithDataset.dataset.topOffset, undefined);

    currentPill = pillNoDataset;
    presEl = makeDomEl({ childElementCount: 0 });
    syncInteractiveTopPillOffset();
    assert.equal(pillNoDataset.getAttribute('data-top-offset'), null);
  } finally {
    globalThis.document = prevDoc;
  }
});

test('resolveWaitingSummaryEntityLabel & collectBotForeverSessionMap 全实体类型覆盖', () => {
  const state = {
    groupRooms: [{ roomId: 'rm-1', name: 'Arch Room' }],
    profiles: [{ name: 'coder', displayName: '架构师' }],
    sessions: [
      { id: 's-title', title: 'Custom Title', botDisplayName: 'B', botName: 'b' },
      { id: 's-bdisp', title: '', botDisplayName: 'Bot Display', botName: 'b' },
      { id: 's-bname', title: '', botDisplayName: '', botName: 'b-name' },
      { id: 's-forever', botName: 'coder', hidden: true },
    ],
  };
  assert.equal(resolveWaitingSummaryEntityLabel(state, { entityType: 'group', entityId: 'rm-1' }), 'Arch Room');
  assert.equal(resolveWaitingSummaryEntityLabel(state, { entityType: 'group', entityId: 'rm-miss' }), 'rm-miss');
  assert.equal(resolveWaitingSummaryEntityLabel(state, { entityType: 'bot', entityId: 'coder' }), '架构师');
  assert.equal(resolveWaitingSummaryEntityLabel(state, { entityType: 'bot', entityId: 'miss-bot' }), 'miss-bot');
  assert.equal(resolveWaitingSummaryEntityLabel(state, { entityType: 'session', entityId: 's-title' }), 'Custom Title');
  assert.equal(resolveWaitingSummaryEntityLabel(state, { entityType: 'session', entityId: 's-bdisp' }), 'Bot Display');
  assert.equal(resolveWaitingSummaryEntityLabel(state, { entityType: 'session', entityId: 's-bname' }), 'b-name');
  assert.equal(resolveWaitingSummaryEntityLabel(state, { entityType: 'session', entityId: 's-none' }), 's-none');

  const map = collectBotForeverSessionMap(state, new Map([['ops', 's-cache'], ['', 'bad']]));
  assert.equal(map.get('s-cache'), 'ops');
  assert.equal(map.get('s-forever'), 'coder');
  assert.equal(collectBotForeverSessionMap(state).get('s-forever'), 'coder');
});

test('createInteractiveWiring、createGatewayNotificationBridge、applyToolOutputRiskAction 与 createDesktopInteractiveSubsystem', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const prevWin = globalThis.window;
  const prevDoc = globalThis.document;
  const prevLoc = globalThis.location;
  const prevRaf = globalThis.requestAnimationFrame;

  const winListeners = new Map();
  const docListeners = new Map();
  const winOpened = [];
  let visState = 'hidden';
  let promptHostEl = makeDomEl({ isConnected: true });
  let pillHostEl = makeDomEl({ isConnected: true });

  globalThis.window = {
    addEventListener: (ev, fn) => {
      if (!winListeners.has(ev)) winListeners.set(ev, new Set());
      winListeners.get(ev).add(fn);
    },
    removeEventListener: (ev, fn) => winListeners.get(ev)?.delete(fn),
    open: (url, target, rel) => winOpened.push({ url, target, rel }),
    innerWidth: 1280,
  };
  globalThis.location = { search: '' };
  globalThis.requestAnimationFrame = (cb) => {
    cb();
    return 1;
  };
  globalThis.document = {
    get visibilityState() {
      return visState;
    },
    addEventListener: (ev, fn) => {
      if (!docListeners.has(ev)) docListeners.set(ev, new Set());
      docListeners.get(ev).add(fn);
    },
    removeEventListener: (ev, fn) => docListeners.get(ev)?.delete(fn),
    getElementById: (id) => {
      if (id === 'react-interactive-prompt-host') return promptHostEl;
      if (id === 'react-interactive-top-pill-host') return pillHostEl;
      return null;
    },
  };

  try {
    const state = {
      lang: 'en',
      platform: 'win32',
      gatewayConnected: false,
      activeFocus: { type: 'session', sessionId: 's-1' },
      activeSessionId: 's-1',
      activeLiveSessionId: 'lv-1',
      sessions: [{ id: 's-1', title: 'S1', botName: 'coder' }],
      profiles: [{ name: 'coder', displayName: 'Coder' }],
      groupRooms: [{ roomId: 'rm-1', name: 'Room 1' }],
    };

    const calls = { wake: 0, bottomInset: 0, render: 0, openExt: [], selSess: [], selBot: [], selGrp: [] };
    let desktopApi = { openExternal: async (u) => calls.openExt.push(u) };
    let getPromptSnap = null;
    let getPillSnap = null;
    let promptUpdateCalls = 0;
    let pillUpdateCalls = 0;

    const fakeService = {
      wakeActiveConnections: async () => {
        calls.wake += 1;
      },
      expandScope: () => {},
      getActivePromptsForCurrentFocus: () => [{ canonicalKey: 'k1' }],
      getActivePromptKeyForCurrentFocus: () => 'k1',
      isCollapsedForCurrentFocus: () => false,
      setCollapsedForCurrentFocus: () => {},
      setActivePromptKeyForCurrentFocus: () => {},
      submitReply: async () => true,
      lockClarifyAnswer: async () => {},
      wakeConnection: async () => {},
      getBackgroundWaitingSummaries: () => [{ scopeKey: 'session:s-1', entityType: 'session', entityId: 's-1', scope: { kind: 'session', storedSessionId: 's-1' } }],
    };

    const wiring = createInteractiveWiring({
      service: fakeService,
      getState: () => state,
      getDesktopApi: () => desktopApi,
      selectSession: (sid, o) => calls.selSess.push([sid, o]),
      openBotChat: (b) => calls.selBot.push(b),
      openGroupRoom: (r) => calls.selGrp.push(r),
      syncStreamBottomInset: () => {
        calls.bottomInset += 1;
      },
      render: () => {
        calls.render += 1;
      },
      mountPromptHost: (_el, reader) => {
        getPromptSnap = reader;
        return () => {
          promptUpdateCalls += 1;
        };
      },
      mountTopPill: (_el, reader) => {
        getPillSnap = reader;
        return () => {
          pillUpdateCalls += 1;
        };
      },
    });

    // visibilitychange hidden & disconnected focus skipped
    for (const fn of docListeners.get('visibilitychange') ?? []) fn();
    for (const fn of winListeners.get('focus') ?? []) fn();

    // connect -> fire twice to cover clearTimeout(wakeTimer), then disconnect before 600ms & reconnect
    state.gatewayConnected = true;
    for (const fn of winListeners.get('focus') ?? []) fn();
    visState = 'visible';
    for (const fn of docListeners.get('visibilitychange') ?? []) fn();
    t.mock.timers.tick(600);
    assert.equal(calls.wake, 1);

    for (const fn of winListeners.get('hermes-mobile-resume') ?? []) fn();
    state.gatewayConnected = false;
    t.mock.timers.tick(600);
    assert.equal(calls.wake, 1);

    // syncHosts mount -> update -> detached promptEl/pillEl update -> removed
    state.gatewayConnected = true;
    wiring.syncHosts();
    assert.ok(getPromptSnap);
    assert.ok(getPillSnap);
    const snap = getPromptSnap();
    assert.equal(snap.locale, 'en-US');
    snap.onCollapsedChange(true);
    snap.onSelectPrompt('k1');
    await snap.onReply({ canonicalKey: 'k1' }, { kind: 'clarify', answers: {} });
    await snap.onLockClarifyAnswer({ canonicalKey: 'k1' }, 'q1', 'a1');
    await snap.onWakeConnection({ canonicalKey: 'c1' });
    snap.onOpenExternalUrl('https://ok.dev');
    assert.deepEqual(calls.openExt, ['https://ok.dev']);
    snap.onOpenExternalUrl('javascript:bad');
    assert.equal(calls.openExt.length, 1);

    // desktopApi fallback -> window.open & missing window.open
    desktopApi = undefined;
    wiring.openSafeExternalUrl('https://win.dev');
    assert.equal(winOpened[0]?.url, 'https://win.dev');
    globalThis.window.open = undefined;
    wiring.openSafeExternalUrl('https://noop.dev');

    // topPill snapshot + selectBackgroundSummary group/bot/session(with&without storedSessionId, non-session scope)
    const pSnap = getPillSnap();
    assert.equal(pSnap.resolveEntityLabel({ entityType: 'session', entityId: 's-1' }), 'S1');
    pSnap.onSelectSummary({ scopeKey: 'group:rm-1', entityType: 'group', entityId: 'rm-1', scope: { kind: 'group', roomId: 'rm-1' } });
    pSnap.onSelectSummary({ scopeKey: 'bot:coder', entityType: 'bot', entityId: 'coder', scope: { kind: 'session', storedSessionId: 's-1' } });
    pSnap.onSelectSummary({ scopeKey: 'session:s-1', entityType: 'session', entityId: 's-1', scope: { kind: 'session', storedSessionId: '' } });
    pSnap.onSelectSummary({ scopeKey: 'session:s-missing', entityType: 'session', entityId: 's-missing', scope: { kind: 'account' } });
    assert.deepEqual(calls.selGrp, ['rm-1']);
    assert.deepEqual(calls.selBot, ['coder']);
    assert.equal(calls.selSess.length, 2);

    // 二次 syncHosts 命中 update，随后摘除节点再触发 connected keep / disconnected clear
    wiring.syncHosts();
    assert.equal(promptUpdateCalls, 1);
    assert.equal(pillUpdateCalls, 1);

    const savedPromptEl = promptHostEl;
    const savedPillEl = pillHostEl;
    promptHostEl = null;
    pillHostEl = null;
    wiring.syncHosts();
    assert.equal(promptUpdateCalls, 2);
    assert.equal(pillUpdateCalls, 2);

    savedPromptEl.isConnected = false;
    savedPillEl.isConnected = false;
    wiring.syncHosts();

    // mobile surface early exit (no syncInteractiveTopPillOffset) + disconnected zh-CN snapshot branch
    state.platform = 'android';
    wiring.syncHosts();
    state.gatewayConnected = false;
    state.lang = 'zh';
    const mobSnap = getPromptSnap();
    assert.equal(mobSnap.locale, 'zh-CN');
    assert.deepEqual(mobSnap.prompts, []);
    assert.deepEqual(getPillSnap().summaries, []);

    // schedule wake timer before dispose() so L215 clearTimeout runs cleanly
    state.gatewayConnected = true;
    for (const fn of winListeners.get('focus') ?? []) fn();
    wiring.dispose();

    // window undefined 与 location undefined/defined 覆盖 syncHosts / mountTopPill 默认路径 / isDesktopSurfaceActive
    globalThis.location = { search: '' };
    wiring.syncHosts();
    globalThis.location = undefined;
    promptHostEl = null;
    pillHostEl = makeDomEl({ isConnected: false });
    const pillDefaultWiring = createInteractiveWiring({
      service: fakeService,
      getState: () => ({ ...state, platform: 'win32', gatewayConnected: true }),
      getDesktopApi: () => undefined,
      selectSession: () => {},
      openBotChat: () => {},
      openGroupRoom: () => {},
      syncStreamBottomInset: () => {},
      render: () => {},
    });
    assert.throws(() => pillDefaultWiring.syncHosts(), /host must be connected/);
    pillDefaultWiring.dispose();

    globalThis.window = undefined;
    promptHostEl = makeDomEl({ isConnected: true });
    pillHostEl = null;
    const headlessWiring = createInteractiveWiring({
      service: fakeService,
      getState: () => ({ ...state, platform: 'win32', gatewayConnected: true }),
      getDesktopApi: () => undefined,
      selectSession: () => {},
      openBotChat: () => {},
      openGroupRoom: () => {},
      syncStreamBottomInset: () => {},
      render: () => {},
    });
    assert.throws(() => headlessWiring.syncHosts(), /(?:Minified React error|not a DOM element)/);
    globalThis.document = undefined;
    headlessWiring.syncHosts();
    headlessWiring.dispose();

    // notification bridge: dedupe, ttl clamp, auto-key, expiry, clear(match & mismatch, with/without clearTimedDockNotice), dispose
    const timedCalls = [];
    let clearedCount = 0;
    const bridge = createGatewayNotificationBridge({
      setTimedDockNotice: (msg, ms) => timedCalls.push({ msg, ms }),
      clearTimedDockNotice: () => {
        clearedCount += 1;
      },
    });
    bridge.handleAction({ type: 'notification-show', text: 'Hi', detail: 'Det', level: 'info', kind: 'notice', key: 'k1', ttlMs: 100 });
    bridge.handleAction({ type: 'notification-show', text: 'Hi2', level: 'warn', kind: 'toast', id: 'id2', ttlMs: 50_000 });
    bridge.handleAction({ type: 'notification-show', text: 'Auto', level: 'info', kind: 'notice' });
    bridge.handleAction({ type: 'notification-clear', key: 'unrelated' });
    assert.equal(clearedCount, 0);
    bridge.handleAction({ type: 'notification-clear', key: 'notice:notice:info' });
    assert.equal(clearedCount, 1);
    bridge.handleAction({ type: 'notification-show', text: 'Expire', key: 'k-exp', level: 'info', kind: 'notice', ttlMs: 2500 });
    t.mock.timers.tick(2500);
    // timer already expired -> clear should not call clearTimedDockNotice
    bridge.handleAction({ type: 'notification-clear', key: 'k-exp' });
    assert.equal(clearedCount, 1);
    bridge.handleAction({ type: 'notification-show', text: 'Keep', key: 'k-keep', level: 'info', kind: 'notice' });
    bridge.dispose();

    // applyToolOutputRiskAction: activeMessages & cachedMessagesBySession
    const activeMsgs = [
      { id: 'u1', toolCalls: [] },
      { id: 'm1', toolCalls: [{ id: 'tc1', name: 'bash', status: 'running' }] },
    ];
    const cacheMap = new Map([['s-cache', [{ id: 'mc1', toolCalls: [{ id: 'tc1', name: 'bash', status: 'running' }] }]]]);
    const patchedIds = [];
    const hit = applyToolOutputRiskAction(
      activeMsgs,
      cacheMap,
      'm1',
      { type: 'tool-output-risk', messageId: 'm1', toolCallId: 'tc1', risk: 'high', findings: ['f1'], redacted: true },
      (mid) => patchedIds.push(mid),
    );
    assert.equal(hit, true);
    assert.deepEqual(patchedIds, ['m1', 'mc1']);
    assert.equal(activeMsgs[1].toolCalls[0].riskInfo?.risk, 'high');

    // createDesktopInteractiveSubsystem full wiring
    let serverReqCb = null;
    let sockClosedCb = null;
    const subNotices = [];
    let presenceSyncs = 0;
    let subRenders = 0;
    const sub = createDesktopInteractiveSubsystem({
      getState: () => ({ ...state, gatewayConnected: true, platform: 'win32' }),
      getGatewayClient: () => null,
      getDesktopApi: () => undefined,
      getSessionHandleRegistry: () => ({ clear() {}, getStoredId: () => null, getRegisteredLiveId: () => null, register() {} }),
      toStoredSessionId: (id) => id ?? null,
      botForeverChatCache: new Map(),
      resolveBotNameForSession: () => null,
      describeRpcError: String,
      selectSession: () => {},
      openBotChat: () => {},
      openGroupRoom: () => {},
      syncStreamBottomInset: () => {},
      syncAgentPresence: () => {
        presenceSyncs += 1;
      },
      render: () => {
        subRenders += 1;
      },
      setTimedDockNotice: (msg, ms) => subNotices.push({ msg, ms }),
    });
    sub.attachClient({
      getNegotiatedCapabilities: () => null,
      getSocketGeneration: () => 1,
      sendServerResponse: () => true,
      sendServerError: () => true,
      onServerRequest: (fn) => {
        serverReqCb = fn;
        return () => {};
      },
      onSocketClosed: (fn) => {
        sockClosedCb = fn;
        return () => {};
      },
      call: async () => ({}),
    });
    assert.equal(
      serverReqCb({ kind: 'server-request', id: 'sreq-1', method: 'secret', params: { session_id: 's-1' }, socketGeneration: 1 }),
      true,
    );
    sockClosedCb(1);
    sub.reconcileResume({ storedSessionId: 's-1', liveSessionId: 'lv-1', resume: { running: false }, fence: 0 });
    const recCalls = [];
    const subSpy = { reconcileResume: (input) => recCalls.push(input) };
    reconcileLiveSessionResume({
      subsystem: subSpy,
      client: {},
      storedFallbackId: 's-fb',
      profile: 'default',
      resume: null,
      handles: null,
      fence: 1,
    });
    reconcileLiveSessionResume({
      subsystem: subSpy,
      client: {},
      storedFallbackId: 's-fb',
      profile: 'default',
      resume: { running: false },
      handles: null,
      fence: 2,
    });
    reconcileLiveSessionResume({
      subsystem: subSpy,
      client: {},
      storedFallbackId: 's-fb',
      profile: 'default',
      resume: { running: true },
      handles: { storedId: 's-h', liveId: 'lv-h' },
      fence: 3,
    });
    assert.equal(recCalls.length, 2);
    assert.deepEqual(
      recCalls.map((c) => [c.storedSessionId, c.liveSessionId, c.fence]),
      [
        ['s-fb', null, 2],
        ['s-h', 'lv-h', 3],
      ],
    );
    assert.ok(sub.getBotForeverSessionMap() instanceof Map);
    sub.handleNotificationAction({ type: 'notification-show', text: 'SubNotice', level: 'info', kind: 'notice' });
    assert.equal(subNotices.length, 1);
    assert.ok(presenceSyncs > 0 && subRenders > 0);
    sub.wiring.dispose();
  } finally {
    globalThis.window = prevWin;
    globalThis.document = prevDoc;
    globalThis.location = prevLoc;
    globalThis.requestAnimationFrame = prevRaf;
    t.mock.timers.reset();
  }
});
