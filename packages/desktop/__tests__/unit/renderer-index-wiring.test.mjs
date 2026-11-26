/**
 * 渲染进程入口装配守卫。
 *
 * 【设计意图 (Why)】
 *   历史坑：视口管理器曾漏掉实例化，`render()` 每帧调用 `captureStreamAnchor()` 直接
 *   TypeError，整屏白屏且在静态检查下完全不可见。这条测试守的是「入口装配真的能跑起来」。
 *
 * 【约束与规则 (Rules)】
 *   1. 必须真实 `require` 入口产物：静态断言拦不住「装配写在运行期才执行的路径」，
 *      而入口里 `captureStreamAnchor` / `feedTurnWatchdog` 的接线只在顶层对象字面量执行；
 *   2. 必须提供最小 window/document/localStorage 桩，否则模块级 DOM 访问直接抛错；
 *   3. 收尾 unref 残留 MessagePort，避免测试进程被句柄挂住。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

test('renderer index 顶层装配：入口必须真实构造视口管理器与看门狗接线', async (t) => {
  const windowListeners = new Map();
  if (!globalThis.window) {
    globalThis.window = {
      addEventListener: (ev, cb) => {
        const list = windowListeners.get(ev) || [];
        list.push(cb);
        windowListeners.set(ev, list);
      },
      removeEventListener: (ev, cb) => {
        const list = windowListeners.get(ev);
        if (list) windowListeners.set(ev, list.filter((fn) => fn !== cb));
      },
      hermesDesktop: {
        authenticateGateway: async () => ({ ok: true, message: 'ok', latency: 1, ticket: 'tk-wire' }),
        getSystemInfo: async () => ({ platform: 'win32', isMaximized: false }),
      },
    };
  } else if (!globalThis.window.hermesDesktop) {
    globalThis.window.hermesDesktop = {
      authenticateGateway: async () => ({ ok: true, message: 'ok', latency: 1, ticket: 'tk-wire' }),
      getSystemInfo: async () => ({ platform: 'win32', isMaximized: false }),
    };
  }
  if (!globalThis.document) {
    globalThis.document = {
      addEventListener: () => {},
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement: () => ({ style: {} }),
      documentElement: { style: { setProperty: () => {} }, dataset: {} },
    };
  }
  if (!globalThis.localStorage) {
    globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  }

  const source = fs.readFileSync(new URL('../../src/renderer/index.ts', import.meta.url), 'utf8');
  assert.match(
    source,
    /streamViewportManager = createDesktopStreamViewport\(\{/,
    '入口必须真实构造视口管理器，否则 render() 每帧都会 TypeError'
  );
  assert.match(source, /feedTurnWatchdog: \(\) => turnExecutionService\.feedTurnWatchdog\(\)/, '入口必须把喂狗通道接进事件分发器');
  // 【守卫】发送提示词后的贴底标记必须是单一真值源：历史坑是它被写进 index 的模块副本，
  // 而 renderCoordinator 读自己那份，导致「发送后从不贴底、流式不跟随」。
  assert.doesNotMatch(source, /let pendingScrollToBottom/, '禁止再声明待贴底的模块级副本');
  assert.doesNotMatch(source, /let suppressPinBottomOnce/, '禁止再声明抑制贴底的模块级副本');
  assert.match(
    source,
    /setPendingScrollToBottom: \(p\) => renderCoordinator\.setPendingScrollToBottom\(p\)/,
    '待贴底标记必须转发给渲染协调器',
  );
  // 【多流同步与唤醒接线守卫】校验 index.ts 将 LiveStreamRegistry、重连/watchdog 恢复与前台同步回调准确接入各服务
  assert.match(source, /const liveStreamRegistry = new LiveStreamRegistry\(\);/);
  assert.match(source, /resolveSessionIdForMessage: \(mid\) => liveStreamRegistry\.getSessionIdForMessage\(mid\), resolveBotNameForSession/);
  assert.match(source, /onActiveTurnDiscovered: \(p\) => gatewayEventDispatcher\.attachLiveTurnFromResume\(p\)/);
  assert.match(source, /onReenterSameSession: \(\) => \{ void messageLoadingService\.refreshActiveSession\(\{ checkLiveTurn: true \}\); \}, onSyncFocusedStream: \(sid\) => gatewayEventDispatcher\.syncFocusedStreamingProjection\(sid\)/);
  assert.match(source, /onWatchdogTurnStillRunning: \(sid, r\) => gatewayEventDispatcher\.reconcileActiveTurnFromResume\(sid, r\)/);
  assert.match(source, /onWatchdogTurnCompleted: \(sid\) => \{ if \(sid === state\.activeSessionId\) void messageLoadingService\.refreshActiveSession\(\{ forceRefreshAfterReconnect: true, checkLiveTurn: true \}\); \}/);
  assert.match(source, /onQueuedSubmitRace: \(sid\) => \{ if \(sid === state\.activeSessionId\) return messageLoadingService\.refreshActiveSession\(\{ forceRefreshAfterReconnect: true, checkLiveTurn: true \}\); \}/);
  assert.match(source, /getTurnStartedSessionId: \(\) => turnStartedSessionId/);
  assert.match(source, /onEnterStage: \(\) => \{ void messageLoadingService\.refreshActiveSession\(\{ checkLiveTurn: true \}\); \}/);
  assert.match(source, /resetActiveStreamingState:[\s\S]*?turnExecutionService\.disarmTurnWatchdog\(\)/);

  const req = createRequire(import.meta.url);
  try {
    assert.doesNotThrow(
      () => req('../../dist/renderer/index.js'),
      'renderer index.js 必须在 headless 运行时完成全部顶层装配而不抛错'
    );

    // 验证 ensureAgentPresenceHost 的移动端插槽保护（P-slot）：
    // 无 mobileSlot 时 ensureAgentPresenceHost 返回 null；带 mobileSlot='true' && isConnected=true 时直接返回该宿主
    const prevGetById = globalThis.document.getElementById;
    const prevGetComputedStyle = globalThis.getComputedStyle;
    const prevRaf = globalThis.requestAnimationFrame;
    globalThis.getComputedStyle = () => ({ paddingBottom: '0px', getPropertyValue: () => '' });
    globalThis.requestAnimationFrame = () => 1;
    const prevDocEl = globalThis.document.documentElement;
    globalThis.document.documentElement = {
      style: { setProperty() {}, getPropertyValue: () => '', removeProperty() {} },
      dataset: {},
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      setAttribute() {},
      getAttribute: () => null,
      removeAttribute() {},
    };
    const rootStub = {
      id: 'flux-app-root',
      style: { setProperty() {}, getPropertyValue: () => '', removeProperty() {} },
      dataset: {},
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      setAttribute() {},
      getAttribute: () => null,
      removeAttribute() {},
      insertAdjacentHTML() {},
      querySelector: (sel) => (sel === '.flux-body-container' ? rootStub : null),
      querySelectorAll: () => [],
      getBoundingClientRect: () => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 }),
    };
    const slotStub = {
      id: 'react-conv-presence-host',
      dataset: { mobileSlot: 'true' },
      isConnected: true,
      style: {},
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      setAttribute() {},
      getAttribute: () => null,
      removeAttribute() {},
      closest: () => null,
    };
    try {
      globalThis.document.getElementById = (id) => (id === 'flux-app-root' ? rootStub : null);
      assert.doesNotThrow(() => globalThis.window.__fluxRender?.(), '无 presence host 时渲染必须安全收尾');

      globalThis.window.__fluxState.gatewayConnected = true;
      assert.doesNotThrow(() => globalThis.window.__fluxRender?.(), '网关已连但无 presence host 时 render 应安全跳过');

      globalThis.document.getElementById = (id) => {
        if (id === 'flux-app-root') return rootStub;
        if (id === 'react-conv-presence-host') return { ...slotStub, dataset: {} };
        return null;
      };
      assert.throws(
        () => globalThis.window.__fluxRender?.(),
        /(?:Target container is not a DOM element|Minified React error #299)/,
        '缺少 data-mobile-slot="true" 的宿主在未复用短路时必须落入常规宿主处理',
      );

      globalThis.document.getElementById = (id) => {
        if (id === 'flux-app-root') return rootStub;
        if (id === 'react-conv-presence-host') return { ...slotStub, isConnected: false };
        return null;
      };
      assert.throws(
        () => globalThis.window.__fluxRender?.(),
        /Agent presence host must be connected before mounting/,
        '断连移动插槽不得命中已连接移动复用短路',
      );

      globalThis.document.getElementById = (id) => {
        if (id === 'flux-app-root') return rootStub;
        if (id === 'react-conv-presence-host') return slotStub;
        return null;
      };
      assert.throws(
        () => globalThis.window.__fluxRender?.(),
        /(?:Target container is not a DOM element|Minified React error #299)/,
        '带 data-mobile-slot="true" 的已连接宿主必须被 ensureAgentPresenceHost 直接透传给 mountAgentPresence',
      );

      // 触发桌面端 bindEvents() 中的 #dock-attach-file-btn 绑定并验证其可安全触发而不抛出
      const attachStub = { onclick: null };
      globalThis.document.getElementById = (id) => {
        if (id === 'flux-app-root') return rootStub;
        if (id === 'dock-attach-file-btn') return attachStub;
        return null;
      };
      const prevDeskUrl = globalThis.window.__fluxState.gatewayUrl;
      globalThis.window.__fluxState.gatewayUrl = '';
      globalThis.window.__fluxState.gatewayConnected = false;
      try {
        assert.doesNotThrow(() => globalThis.window.__fluxRender?.());
        if (typeof attachStub.onclick === 'function') {
          assert.doesNotThrow(() => attachStub.onclick());
        }
      } finally {
        globalThis.window.__fluxState.gatewayUrl = prevDeskUrl;
      }

      // 触发桌面与移动端回滚回填（onRefillMobileComposer false/true）与联网 __fluxMessageActions.handleForkMessage（覆盖 ensureLiveSessionId）
      const prevPlat = globalThis.window.__fluxState.platform;
      const prevFocus = globalThis.window.__fluxState.activeFocus;
      const prevSid = globalThis.window.__fluxState.activeSessionId;
      const prevLiveSid = globalThis.window.__fluxState.activeLiveSessionId;
      const prevMsgs = globalThis.window.__fluxState.messages;
      const prevSessions = globalThis.window.__fluxState.sessions;
      const prevConfirmModal = globalThis.window.__fluxState.confirmModal;
      const prevRollbackArmed = globalThis.window.__fluxState.rollbackArmed;
      const prevWs = globalThis.WebSocket;
      const prevFetch = globalThis.fetch;
      const prevQsa = globalThis.document.querySelectorAll;
      try {
        const rollbackBtn = {
          closest: () => null,
          getAttribute: (k) => (k === 'data-msg-id' ? 'm-refill-u' : k === 'data-row-id' ? '1' : null),
        };
        globalThis.window.__fluxState.platform = 'win32';
        globalThis.window.__fluxState.activeFocus = { type: 'session', sessionId: 's-refill' };
        globalThis.window.__fluxState.activeSessionId = 's-refill';
        globalThis.window.__fluxState.messages = [
          { id: 'm-refill-u', role: 'user', content: 'refill text', rowId: 1 },
          { id: 'm-refill-a', role: 'assistant', content: 'reply', rowId: 2 },
        ];
        assert.doesNotThrow(() => globalThis.window.__fluxMessageActions?.handleRollbackMessage(rollbackBtn));
        globalThis.window.__fluxState.rollbackArmed = null;

        globalThis.window.__fluxState.platform = 'android';
        globalThis.window.__fluxState.gatewayConnected = false;
        assert.doesNotThrow(() => globalThis.window.__fluxRender?.());
        globalThis.window.__fluxState.activeFocus = { type: 'session', sessionId: 's-refill' };
        globalThis.window.__fluxState.activeSessionId = 's-refill';
        globalThis.window.__fluxState.messages = [
          { id: 'm-refill-u', role: 'user', content: 'refill text', rowId: 1 },
          { id: 'm-refill-a', role: 'assistant', content: 'reply', rowId: 2 },
        ];
        assert.doesNotThrow(() => globalThis.window.__fluxMessageActions?.handleRollbackMessage(rollbackBtn));
        globalThis.window.__fluxState.rollbackArmed = null;

        let latestWs = null;
        class MockWiringWs {
          static CONNECTING = 0;
          static OPEN = 1;
          static CLOSING = 2;
          static CLOSED = 3;
          constructor(url) {
            latestWs = this;
            this.url = url;
            this.readyState = 0;
            this.onopen = null;
            this.onmessage = null;
            this.onclose = null;
            this.onerror = null;
            queueMicrotask(() => {
              this.readyState = 1;
              this.onopen?.();
            });
          }
          send(raw) {
            const parsed = JSON.parse(String(raw));
            const result =
              parsed.method === 'session.resume'
                ? { session_id: 'lv-wire', stored_session_id: 's-wire' }
                : parsed.method === 'session.fork' || parsed.method === 'session.branch'
                  ? { session_id: 'lv-forked', stored_session_id: 's-forked' }
                  : parsed.method === 'session.delete' || parsed.method === 'sessions.delete'
                    ? { ok: true, deleted: true }
                    : parsed.method === 'sessions.list'
                      ? { sessions: [] }
                      : parsed.method === 'prompt.submit'
                        ? { accepted: true }
                        : { pong: true, capabilities: {} };
            queueMicrotask(() => {
              this.onmessage?.({ data: JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result }) });
            });
          }
          close() {
            this.readyState = 3;
            this.onclose?.({ code: 1000, reason: 'closed' });
          }
        }
        globalThis.WebSocket = MockWiringWs;
        globalThis.fetch = async () => ({
          ok: true,
          status: 200,
          json: async () => ({ ticket: 'tk-wire' }),
        });
        await globalThis.window.__fluxConnect?.('http://127.0.0.1:8080');
        for (let i = 0; i < 6; i++) await Promise.resolve();
        globalThis.window.__fluxState.platform = 'win32';
        globalThis.window.__fluxState.activeFocus = { type: 'session', sessionId: 's-wire' };
        globalThis.window.__fluxState.activeSessionId = 's-wire';
        globalThis.window.__fluxState.activeLiveSessionId = '';
        globalThis.window.__fluxState.messages = [
          { id: 'm-refill-u', role: 'user', content: 'refill text', rowId: 1 },
          { id: 'm-refill-a', role: 'assistant', content: 'reply', rowId: 2 },
        ];
        await globalThis.window.__fluxMessageActions?.handleForkMessage(rollbackBtn);

        // 触发流式 tool.start -> toolPatchQueue.patchElement -> revealMobileTraceContainers (index.ts:411)
        globalThis.requestAnimationFrame = (cb) => {
          cb();
          return 1;
        };
        const toolSlotStub = { innerHTML: '', closest: () => null };
        globalThis.document.getElementById = (id) => {
          if (id === 'flux-app-root') return rootStub;
          if (typeof id === 'string' && id.startsWith('msg-tools-')) return toolSlotStub;
          return null;
        };
        latestWs?.onmessage?.({
          data: JSON.stringify({
            jsonrpc: '2.0',
            method: 'event',
            params: { event: 'turn.started', type: 'turn.started', session_id: 'lv-wire', turn_id: 't-wire' },
          }),
        });
        latestWs?.onmessage?.({
          data: JSON.stringify({
            jsonrpc: '2.0',
            method: 'event',
            params: { event: 'message.start', type: 'message.start', session_id: 'lv-wire', message_id: 'msg-tp-1', role: 'assistant' },
          }),
        });
        latestWs?.onmessage?.({
          data: JSON.stringify({
            jsonrpc: '2.0',
            method: 'event',
            params: { event: 'tool.start', type: 'tool.start', session_id: 'lv-wire', message_id: 'msg-tp-1', tool_id: 'tc-tp-1', name: 'bash', args: '{"command":"ls"}' },
          }),
        });
        for (let i = 0; i < 4; i++) await Promise.resolve();

        // 触发流式中的会话删除，验证 resetActiveStreamingState -> turnExecutionService.disarmTurnWatchdog() 真实执行不抛错
        const promptInputStub = {
          value: 'trigger stream',
          disabled: false,
          scrollHeight: 20,
          dataset: {},
          style: {},
          focus() {},
          setSelectionRange() {},
          addEventListener() {},
          removeEventListener() {},
          closest: () => null,
        };
        const sendBtnStub = { onclick: null, disabled: false, dataset: {}, closest: () => null };
        const confirmOkBtnStub = { onclick: null, dataset: {}, focus() {}, closest: () => null };
        const deleteSessionBtnStub = { dataset: { id: 's-wire' }, onclick: null, closest: () => null };
        const prevInnerGetById = globalThis.document.getElementById;
        globalThis.document.getElementById = (id) => {
          if (id === 'flux-app-root') return rootStub;
          if (id === 'dock-prompt-input') return promptInputStub;
          if (id === 'dock-send-btn') return sendBtnStub;
          if (id === 'btn-confirm-modal-ok') return confirmOkBtnStub;
          if (typeof id === 'string' && id.startsWith('msg-tools-')) return toolSlotStub;
          return null;
        };
        globalThis.document.querySelectorAll = (sel) => (sel === '.btn-delete-session' ? [deleteSessionBtnStub] : []);
        globalThis.window.__fluxState.sessions = [
          { id: 's-wire', title: 'Wire', botName: 'default' },
          { id: 's-keep', title: 'Keep', botName: 'default' },
        ];
        globalThis.window.__fluxState.activeFocus = { type: 'session', sessionId: 's-wire' };
        globalThis.window.__fluxState.activeSessionId = 's-wire';
        globalThis.window.__fluxState.isStreaming = false;
        globalThis.window.__fluxRender?.();
        assert.equal(typeof sendBtnStub.onclick, 'function');
        assert.equal(typeof deleteSessionBtnStub.onclick, 'function');
        sendBtnStub.onclick();
        for (let i = 0; i < 4; i++) await Promise.resolve();
        assert.equal(globalThis.window.__fluxState.isStreaming, true);
        deleteSessionBtnStub.onclick({ stopPropagation() {} });
        assert.equal(typeof confirmOkBtnStub.onclick, 'function');
        confirmOkBtnStub.onclick({ stopPropagation() {} });
        for (let i = 0; i < 8; i++) await Promise.resolve();
        assert.equal(globalThis.window.__fluxState.isStreaming, false);
        globalThis.document.getElementById = prevInnerGetById;
      } finally {
        if (globalThis.window.__fluxState) {
          globalThis.window.__fluxState.gatewayUrl = '';
        }
        await globalThis.window.__fluxConnect?.();
        for (const cb of windowListeners.get('offline') || []) {
          try { cb(); } catch {}
        }
        globalThis.WebSocket = prevWs;
        globalThis.fetch = prevFetch;
        globalThis.document.querySelectorAll = prevQsa;
        globalThis.window.__fluxState.platform = prevPlat;
        globalThis.window.__fluxState.activeFocus = prevFocus;
        globalThis.window.__fluxState.activeSessionId = prevSid;
        globalThis.window.__fluxState.activeLiveSessionId = prevLiveSid;
        globalThis.window.__fluxState.messages = prevMsgs;
        globalThis.window.__fluxState.sessions = prevSessions;
        globalThis.window.__fluxState.confirmModal = prevConfirmModal;
        globalThis.window.__fluxState.rollbackArmed = prevRollbackArmed;
      }
    } finally {
      for (const cb of windowListeners.get('beforeunload') || []) {
        try { cb(); } catch {}
      }
      if (globalThis.window.__fluxState) {
        globalThis.window.__fluxState.gatewayConnected = false;
      }
      globalThis.document.getElementById = prevGetById;
      globalThis.document.documentElement = prevDocEl;
      globalThis.getComputedStyle = prevGetComputedStyle;
      globalThis.requestAnimationFrame = prevRaf;
    }
  } finally {
    for (const h of process._getActiveHandles()) {
      if (h?.constructor?.name === 'MessagePort') {
        h.unref();
      }
    }
  }
});
