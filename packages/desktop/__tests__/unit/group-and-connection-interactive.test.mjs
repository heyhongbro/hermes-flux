/**
 * Slice 2 集成与领域契约单测：
 *   - GroupLogPollerManager.isBlocked 阻塞暂停与恢复
 *   - SessionStatusService 右舱关闭态 decoupled groups.state 轮询与 refreshGroupStateNow
 *   - InteractiveWiring 自动 connectors.operation.wake 监听退避 + Capacitor browserFinished 事件转发
 *   - McpOAuthService 严格 RPC 参数契约 (reload.mcp 无 profile, oauth.start 无 client_redirect_uri 且禁调 callback)
 *   - McpOAuthInlinePanel 无弹窗内联渲染与安全外链守卫
 *   - tool.output_risk 与 notification.show/clear 状态归约、去重桥及 ToolCapsule/ToolOutput 渲染
 *
 * (packages/desktop/__tests__/unit/group-and-connection-interactive.test.mjs)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { GroupLogPollerManager, reduceGatewayEvent } from '@hermes-flux/core';
import { McpOAuthInlinePanel, ToolCapsule, t } from '@hermes-flux/ui';
import { createMcpOAuthActions } from '../../dist/renderer/services/mcpOAuthService.mjs';
import { createSessionStatusService } from '../../dist/renderer/services/sessionStatusService.mjs';
import {
  applyToolOutputRiskAction,
  createGatewayNotificationBridge,
  createInteractiveWiring,
  syncInteractiveTopPillOffset,
} from '../../dist/renderer/interactiveWiring.mjs';
import { createInteractivePromptService } from '../../dist/renderer/services/interactivePromptService.mjs';
import { createCapacitorPlatformBridge } from '../../../mobile/dist/capacitor-bridge.mjs';

function makeBaseState(overrides = {}) {
  return {
    platform: 'windows',
    lang: 'zh',
    activeFocus: { type: 'session', sessionId: 'sess-1' },
    activeSessionId: 'sess-1',
    activeLiveSessionId: 'live-1',
    profileName: 'default',
    rightPodMode: { kind: 'closed' },
    inspectorCollapsed: true,
    gatewayConnected: true,
    sessions: [{ id: 'sess-1', title: 'Session 1', botName: 'default', hidden: false }],
    profiles: [{ name: 'default', displayName: 'Default' }],
    groupRooms: [{ roomId: 'room-1', name: 'Room 1', members: ['default'] }],
    messages: [],
    dockNotice: '',
    ...overrides,
  };
}

test('GroupLogPollerManager.isBlocked 在阻塞期间暂停轮次与停滞消耗，解除后正常完成', async () => {
  let blocked = true;
  let logs = [];
  let fetchCount = 0;
  let completed = 0;
  let failed = 0;
  const scheduled = [];
  let nextHandle = 1;

  const poller = new GroupLogPollerManager({
    fetchLogs: async () => {
      fetchCount += 1;
      return logs;
    },
    isFocused: () => true,
    isBlocked: () => blocked,
    onSyncLogs: () => {},
    onCompleted: () => {
      completed += 1;
    },
    onFailed: () => {
      failed += 1;
    },
    scheduler: {
      setTimeout(cb, delayMs) {
        const handle = nextHandle++;
        scheduled.push({ handle, cb, delayMs });
        return handle;
      },
      clearTimeout(handle) {
        const idx = scheduled.findIndex((item) => item.handle === handle);
        if (idx >= 0) scheduled.splice(idx, 1);
      },
    },
    maxRounds: 2,
    maxStagnantRounds: 2,
    intervalMs: 100,
    backoffIntervalMs: 400,
  });

  poller.startAwaitReply('room-1', { knownCount: 0, lastSeq: null, lastAssistantMessageId: null });
  for (let i = 0; i < 5; i += 1) {
    assert.equal(scheduled[0]?.delayMs, i === 0 ? 100 : 400);
    const task = scheduled.shift();
    task.cb();
    await Promise.resolve();
  }
  assert.equal(fetchCount, 0, '阻塞期禁止拉取与消耗 round/stagnantCount');
  assert.equal(failed, 0);

  blocked = false;
  logs = [{ messageId: 'a-1', role: 'assistant', seq: 2, content: 'ready' }];
  const tick = scheduled.shift();
  tick.cb();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(fetchCount, 1);
  assert.equal(completed, 1);
  assert.equal(failed, 0);
  poller.stopAll();
});

test('SessionStatusService 在右侧检查舱关闭时仍轮询 groups.state 并通知 pending_actions 与 refreshGroupStateNow', async () => {
  const state = makeBaseState({
    activeFocus: { type: 'group', roomId: 'room-1' },
    rightPodMode: { kind: 'closed' },
    inspectorCollapsed: true,
  });
  let stateCalls = 0;
  const seenActions = [];

  const service = createSessionStatusService({
    getState: () => state,
    getGatewayClient: () => ({
      async call(method, params) {
        assert.equal(method, 'groups.state');
        assert.deepEqual(params, { room_id: 'room-1' });
        stateCalls += 1;
        return {
          room: { room_id: 'room-1', name: 'Room 1', members: [{ member_id: 'm1', profile: 'coder' }] },
          driver_status: {
            running: true,
            working: true,
            blocked: true,
            pending_actions: [
              {
                kind: 'approval',
                request_id: `req-${stateCalls}`,
                member_id: 'm1',
                task_id: 'task-1',
                execution_generation: 3,
                command: 'ls -la',
                choices: ['once', 'session', 'always', 'deny'],
              },
            ],
            member_activity: [],
          },
        };
      },
    }),
    getSessionHandleRegistry: () => ({
      getRegisteredLiveId: () => null,
      toStoredId: (id) => id,
    }),
    getSessionMessagesCache: () => new Map(),
    isStreamingActiveForCurrentSession: () => false,
    getActiveStreamingStoredSessionId: () => null,
    getActiveStreamingMessageId: () => null,
    formatTimestamp: () => '12:00',
    scheduleToolPatch: () => {},
    syncReactMessageList: () => {},
    syncRightPod: () => {},
    syncTitlebar: () => {},
    openFilePreview: () => {},
    insertQuoteToComposer: () => {},
    onGroupPendingActions: (roomId, actions) => {
      seenActions.push({ roomId, count: actions.length, reqId: actions[0]?.kind === 'approval' ? actions[0].requestId : '' });
    },
    render: () => {},
  });

  service.onGroupActivated('room-1');
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(stateCalls >= 1, true, '右舱关闭态激活群聊时必须主动拉取 groups.state');
  assert.equal(seenActions[0]?.roomId, 'room-1');
  assert.equal(seenActions[0]?.reqId, 'req-1');

  await service.refreshGroupStateNow('room-1');
  assert.equal(seenActions.at(-1)?.reqId, 'req-2');
  service.dispose();
});

test('createInteractiveWiring 自动监听 focus/visibility/resume/browser-finished 防抖唤醒连接，且 Capacitor Bridge 转发 browserFinished', async (tc) => {
  const prevWindow = globalThis.window;
  const prevDocument = globalThis.document;
  const prevCustomEvent = globalThis.CustomEvent;
  const winListeners = new Map();
  const docListeners = new Map();
  let wakeCalls = 0;

  globalThis.CustomEvent = class FakeCustomEvent {
    constructor(type, init = {}) {
      this.type = type;
      this.detail = init.detail;
      this.defaultPrevented = false;
    }
    preventDefault() {
      this.defaultPrevented = true;
    }
  };
  globalThis.window = {
    location: { search: '' },
    innerWidth: 1280,
    addEventListener(type, fn) {
      if (!winListeners.has(type)) winListeners.set(type, new Set());
      winListeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      winListeners.get(type)?.delete(fn);
    },
    dispatchEvent(ev) {
      for (const fn of winListeners.get(ev.type) ?? []) fn(ev);
      return true;
    },
  };
  globalThis.document = {
    visibilityState: 'visible',
    addEventListener(type, fn) {
      if (!docListeners.has(type)) docListeners.set(type, new Set());
      docListeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      docListeners.get(type)?.delete(fn);
    },
    dispatchEvent(ev) {
      for (const fn of docListeners.get(ev.type) ?? []) fn(ev);
      return true;
    },
    getElementById: () => null,
  };

  tc.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const state = makeBaseState();
    const client = {
      getSocketGeneration: () => 1,
      getNegotiatedCapabilities: () => null,
      async call(method) {
        if (method === 'connectors.operation.wake') {
          wakeCalls += 1;
          return { ok: true };
        }
        return {};
      },
      sendServerResponse: () => {},
      sendServerError: () => {},
    };

    const service = createInteractivePromptService({
      getState: () => state,
      getGatewayClient: () => client,
      getSessionHandleRegistry: () => ({ toStoredId: (id) => id, toLiveId: (id) => id }),
      toStoredSessionId: (id) => id ?? null,
      resolveBotForeverSessionMap: () => new Map(),
      resolveBotNameForSession: () => null,
      describeRpcError: (e) => String(e),
      t: (k) => String(k),
      onPromptsChanged: () => {},
    });
    // 注册一条活跃 connection 以便 wakeActiveConnections 实际发出 RPC
    service.handleTurnAction({
      type: 'connection-request',
      sessionId: 'live-1',
      payload: {
        op_id: 'op-wake',
        seq: 1,
        deadline_at: 999999,
        timeout_seconds: 300,
        owner: { type: 'session', session_id: 'live-1' },
        targets: [{ name: 'github', kind: 'connector', action: 'authorize', state: 'pending' }],
      },
    });

    const wiring = createInteractiveWiring({
      service,
      getState: () => state,
      getDesktopApi: () => undefined,
      selectSession: () => {},
      openBotChat: () => {},
      openGroupRoom: () => {},
      syncStreamBottomInset: () => {},
      render: () => {},
    });

    let browserFinishedCb = null;
    createCapacitorPlatformBridge({
      platform: 'ios',
      isPluginAvailable: (name) => name === 'Browser',
      browser: {
        async open() {},
        async addListener(eventName, cb) {
          if (eventName === 'browserFinished') browserFinishedCb = cb;
          return { remove: async () => {} };
        },
      },
    });
    assert.equal(typeof browserFinishedCb, 'function');

    // 连续触发多个回归事件 -> 防抖合并为一次 wake
    globalThis.window.dispatchEvent(new globalThis.CustomEvent('focus'));
    globalThis.window.dispatchEvent(new globalThis.CustomEvent('hermes-mobile-resume'));
    browserFinishedCb();
    globalThis.document.visibilityState = 'hidden';
    globalThis.document.dispatchEvent({ type: 'visibilitychange' });
    assert.equal(wakeCalls, 0);

    tc.mock.timers.tick(650);
    await Promise.resolve();
    assert.equal(wakeCalls, 1, '防抖窗内多路唤醒必须合并为单次 connectors.operation.wake');

    // 断连态不触发、dispose 后彻底注销监听
    state.gatewayConnected = false;
    globalThis.window.dispatchEvent(new globalThis.CustomEvent('focus'));
    tc.mock.timers.tick(650);
    await Promise.resolve();
    assert.equal(wakeCalls, 1);

    state.gatewayConnected = true;
    wiring.dispose();
    globalThis.window.dispatchEvent(new globalThis.CustomEvent('hermes-mobile-browser-finished'));
    tc.mock.timers.tick(650);
    await Promise.resolve();
    assert.equal(wakeCalls, 1, 'dispose() 后必须解绑监听器与定时器');
  } finally {
    tc.mock.timers.reset();
    globalThis.window = prevWindow;
    globalThis.document = prevDocument;
    globalThis.CustomEvent = prevCustomEvent;
  }
});

test('createMcpOAuthActions 与 McpOAuthInlinePanel: 严守 reload.mcp / oauth.* 参数契约与零弹窗内联渲染', async () => {
  const rpcCalls = [];
  const openedUrls = [];
  const notices = [];
  let extRefreshes = 0;

  const actions = createMcpOAuthActions({
    getState: () => makeBaseState(),
    getGatewayClient: () => ({
      async call(method, params) {
        rpcCalls.push({ method, params });
        if (method === 'reload.mcp') {
          if (!params.confirm) {
            return { status: 'confirm_required', loaded_rev: 'rev-1', message: 'Needs confirm' };
          }
          return { status: 'reloaded', session: 'busy', loaded_rev: 'rev-1' };
        }
        if (method === 'mcp.servers.oauth.start') {
          return {
            ok: true,
            session_id: 'oauth-s1',
            auth_url: 'https://auth.example.com/authorize?code=1',
            flow: 'pkce',
          };
        }
        if (method === 'mcp.servers.oauth.poll') {
          return { ok: true, status: 'approved', session_id: 'oauth-s1' };
        }
        if (method === 'mcp.servers.oauth.cancel') {
          return { ok: true, status: 'cancelled' };
        }
        throw new Error(`unexpected rpc: ${method}`);
      },
    }),
    getDesktopApi: () => ({
      openExternal: async (url) => {
        openedUrls.push(url);
      },
    }),
    describeRpcError: (e) => String(e),
    t: (k, p) => t(k, p),
    onNotify: (msg) => notices.push(msg),
    onExtensionsChanged: () => {
      extRefreshes += 1;
    },
  });

  const confirmStep = await actions.onReloadMcp();
  assert.equal(confirmStep.ok, false);
  assert.equal(confirmStep.confirmRequired, true);
  assert.equal('profile' in rpcCalls[0].params, false, 'reload.mcp 严禁携带 profile');

  const applied = await actions.onReloadMcp({ confirm: true, always: true, rev: confirmStep.rev });
  assert.equal(applied.ok, true);
  assert.equal(applied.session, 'busy');
  assert.equal('profile' in rpcCalls[1].params, false);
  assert.ok(notices.includes(t('interactive.mcp.reloadBusy')));
  assert.equal(extRefreshes, 1);

  const started = await actions.onStartMcpOAuth('coder', 'linear');
  assert.equal(started.ok, true);
  assert.equal('client_redirect_uri' in rpcCalls[2].params, false, 'oauth.start 严禁传 client_redirect_uri');
  assert.deepEqual(rpcCalls[2].params, { profile: 'coder', name: 'linear' });
  assert.deepEqual(openedUrls, ['https://auth.example.com/authorize?code=1']);

  const polled = await actions.onPollMcpOAuth('coder', 'linear', 'oauth-s1');
  assert.equal(polled.status, 'approved');
  assert.deepEqual(rpcCalls[3].params, { profile: 'coder', name: 'linear', session_id: 'oauth-s1' });
  assert.equal(extRefreshes, 2);

  await actions.onCancelMcpOAuth('coder', 'linear', 'oauth-s1');
  assert.equal(rpcCalls.some((c) => c.method === 'mcp.servers.oauth.callback'), false, '绝不调用 mcp.servers.oauth.callback');

  const safeHtml = renderToStaticMarkup(
    React.createElement(McpOAuthInlinePanel, {
      profile: 'coder',
      actions: { onNotify: () => {}, onCopy: async () => true },
      state: {
        busy: false,
        reloadConfirm: { message: 'Confirm MCP reload?', rev: 'r1' },
        oauth: {
          name: 'linear',
          sessionId: 'oauth-s1',
          authUrl: 'javascript:alert(1)',
          status: 'pending',
        },
      },
      setState: () => {},
    }),
  );
  assert.equal(safeHtml.includes('role="dialog"'), false, 'MCP 重载确认与 OAuth 必须就地内联渲染，严禁弹窗');
  assert.ok(safeHtml.includes('Confirm MCP reload?'));
  assert.equal(safeHtml.includes(t('interactive.mcp.oauthOpenUrl')), false, 'javascript: 非法链接不得渲染打开按钮');
});

test('tool.output_risk 与 notification.show/clear 状态归约、去重桥及 ToolCapsule/ToolOutput 内联风险渲染', (tc) => {
  // 1. notification 无 session_id 也不被 activeSessionIds 拦截
  const showActions = reduceGatewayEvent(
    {
      type: 'notification.show',
      payload: { text: 'Disk usage high', level: 'warning', kind: 'health', ttl_ms: 90000, key: 'disk-1', detail: '92%' },
    },
    { activeSessionIds: ['sess-1'], activeStreamingMessageId: 'm-1' },
  );
  assert.equal(showActions.length, 1);
  assert.equal(showActions[0].type, 'notification-show');

  const clearActions = reduceGatewayEvent(
    { type: 'notification.clear', payload: { key: 'disk-1' } },
    { activeSessionIds: ['sess-1'], activeStreamingMessageId: 'm-1' },
  );
  assert.deepEqual(clearActions, [{ type: 'notification-clear', key: 'disk-1' }]);

  tc.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const shownNotices = [];
    let clearedCount = 0;
    const bridge = createGatewayNotificationBridge({
      setTimedDockNotice: (msg, dur) => shownNotices.push({ msg, dur }),
      clearTimedDockNotice: () => {
        clearedCount += 1;
      },
    });
    bridge.handleAction(showActions[0]);
    assert.deepEqual(shownNotices, [{ msg: 'Disk usage high · 92%', dur: 15000 }]);
    bridge.handleAction({ type: 'notification-clear', key: 'other-key' });
    assert.equal(clearedCount, 0);
    bridge.handleAction(clearActions[0]);
    assert.equal(clearedCount, 1);
    bridge.dispose();
  } finally {
    tc.mock.timers.reset();
  }

  // 2. tool.output_risk 挂载至对应工具胶囊与缓存并在 UI 渲染风险条
  const riskActions = reduceGatewayEvent(
    {
      type: 'tool.output_risk',
      session_id: 'live-1',
      payload: { tool_id: 'tc-risk', name: 'bash', risk: 'high', findings: ['AWS key detected'], redacted: true },
    },
    { activeSessionIds: ['live-1'], activeStreamingMessageId: 'm-1' },
  );
  assert.equal(riskActions.length, 1);
  const msg = {
    id: 'm-1',
    role: 'assistant',
    content: '',
    timestamp: '12:00',
    toolCalls: [{ id: 'tc-risk', name: 'bash', status: 'completed', args: '{"command":"env"}', output: '[REDACTED]' }],
  };
  const patchedIds = [];
  const changed = applyToolOutputRiskAction([msg], new Map(), 'm-1', riskActions[0], (mid) => patchedIds.push(mid));
  assert.equal(changed, true);
  assert.deepEqual(patchedIds, ['m-1']);
  assert.deepEqual(msg.toolCalls[0].riskInfo, {
    risk: 'high',
    findings: ['AWS key detected'],
    redacted: true,
  });

  const html = renderToStaticMarkup(
    React.createElement(ToolCapsule, {
      tool: msg.toolCalls[0],
      actionEnabled: true,
    }),
  );
  assert.ok(html.includes('conv-tool-risk-box'));
  assert.ok(html.includes('data-risk-level="high"'));
  assert.ok(html.includes('AWS key detected'));
  assert.ok(html.includes(t('interactive.toolRisk.redacted')));
});

test('syncInteractiveTopPillOffset 动态避让舞台在场指示与断连状态胶囊并在无遮挡时归位', () => {
  const prevDocument = globalThis.document;
  const attrs = new Map();
  const makeHost = ({ children = 0, classes = [], dataset = {} } = {}) => {
    const classSet = new Set(classes);
    return {
      childElementCount: children,
      firstElementChild: children > 0 ? {} : null,
      dataset: { ...dataset },
      classList: { contains: (c) => classSet.has(c) },
      setAttribute: (k, v) => attrs.set(k, v),
      removeAttribute: (k) => attrs.delete(k),
    };
  };

  let pillHost = makeHost();
  let connHost = null;
  let presenceHost = null;

  globalThis.document = {
    getElementById(id) {
      if (id === 'react-interactive-top-pill-host') return pillHost;
      if (id === 'react-conv-connection-host') return connHost;
      if (id === 'react-conv-presence-host') return presenceHost;
      return null;
    },
  };

  try {
    // 1. 无在场/断连胶囊 -> top-offset 保持清空
    syncInteractiveTopPillOffset();
    assert.equal(pillHost.dataset.topOffset, undefined);

    // 2. stage 在场指示非空且未被替换 -> below-presence
    presenceHost = makeHost({ children: 1 });
    syncInteractiveTopPillOffset();
    assert.equal(pillHost.dataset.topOffset, 'below-presence');

    // 3. 连接胶囊非空（并替换 presence）-> below-connection
    connHost = makeHost({ children: 1 });
    presenceHost.dataset.replaced = 'true';
    syncInteractiveTopPillOffset();
    assert.equal(pillHost.dataset.topOffset, 'below-connection');

    // 4. 连接胶囊消失 + 在场指示转为 dock 停靠 -> 归位清空
    connHost = makeHost({ children: 0 });
    presenceHost = makeHost({ children: 1, classes: ['presence-host--dock'], dataset: { replaced: 'false' } });
    syncInteractiveTopPillOffset();
    assert.equal(pillHost.dataset.topOffset, undefined);
  } finally {
    globalThis.document = prevDocument;
  }
});
