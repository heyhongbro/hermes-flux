/**
 * Settings MCP OAuth 内联确认与轮询面板交互测试
 * 覆盖 McpOAuthInlinePanel, triggerMcpReload, startMcpOauthFlow 全分支
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {
  McpOAuthInlinePanel,
  startMcpOauthFlow,
  triggerMcpReload,
  setLocale,
} from '../dist/index.js';
import { createHookDriver, findAll, findByTestId, flushMicrotasks } from './helpers/reactHookDriver.mjs';

function makeStateUpdater(initial) {
  let state = initial;
  const setState = (updater) => {
    state = typeof updater === 'function' ? updater(state) : updater;
  };
  return { get: () => state, setState };
}

test('triggerMcpReload 与 startMcpOauthFlow 全返回分支及异常清理', async () => {
  setLocale('zh-CN');
  const notices = [];

  // Missing handler guards
  const s0 = makeStateUpdater({ busy: false, reloadConfirm: null, oauth: null });
  await triggerMcpReload({ actions: { onNotify: () => {} }, setState: s0.setState });
  await startMcpOauthFlow({ profile: 'default', name: 'm1', actions: {}, setState: s0.setState });
  assert.equal(s0.get().busy, false);

  // confirmRequired -> notify -> error cleanup
  const reloadCalls = [];
  let outcome = { confirmRequired: true, message: 'Need confirm', rev: 'r1' };
  const actions = {
    onNotify: (msg) => notices.push(msg),
    onReloadMcp: async (opts) => {
      reloadCalls.push(opts);
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
    onStartMcpOAuth: async (_p, _n) => {
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
  };

  await triggerMcpReload({ actions, setState: s0.setState });
  assert.deepEqual(s0.get().reloadConfirm, { message: 'Need confirm', rev: 'r1' });

  outcome = { confirmRequired: true };
  await triggerMcpReload({ actions, setState: s0.setState });
  assert.equal(s0.get().reloadConfirm.rev, null);

  outcome = { ok: false, message: 'reload failed' };
  await triggerMcpReload({ actions, setState: s0.setState, confirm: true, rev: 'r1' });
  assert.equal(s0.get().reloadConfirm, null);
  assert.deepEqual(notices, ['reload failed']);

  outcome = new Error('boom');
  await assert.rejects(() => triggerMcpReload({ actions, setState: s0.setState }), /boom/);
  assert.equal(s0.get().busy, false);

  // startMcpOauthFlow error & pending & throw
  outcome = { ok: false, message: '' };
  await startMcpOauthFlow({ profile: 'default', name: 'srv1', actions, setState: s0.setState });
  assert.equal(s0.get().oauth.status, 'error');

  outcome = { ok: true, sessionId: 'oa-1', authUrl: 'https://auth.example.com/go' };
  await startMcpOauthFlow({ profile: 'default', name: 'srv1', actions, setState: s0.setState });
  assert.equal(s0.get().oauth.status, 'pending');
  assert.equal(s0.get().oauth.sessionId, 'oa-1');

  outcome = new Error('oauth start fail');
  await assert.rejects(() => startMcpOauthFlow({ profile: 'default', name: 'srv1', actions, setState: s0.setState }), /oauth start fail/);
  assert.equal(s0.get().busy, false);
});

test('McpOAuthInlinePanel 确认重载、OAuth 轮询状态转移与取消外链降级', async (t) => {
  setLocale('zh-CN');
  t.mock.timers.enable({ apis: ['setInterval'] });
  const prevWin = globalThis.window;
  const winOpened = [];
  globalThis.window = { open: (...args) => winOpened.push(args) };

  try {
    const d = createHookDriver();
    let inlineState = { busy: false, reloadConfirm: null, oauth: null };
    const setInlineState = (updater) => {
      inlineState = typeof updater === 'function' ? updater(inlineState) : updater;
    };
    const reloads = [];
    const canceled = [];
    let pollResponses = [
      { status: 'pending' },
      { status: 'approved', message: '' },
    ];
    let pollIdx = 0;
    let onOpenExt = (url) => winOpened.push(['cb', url]);

    const actions = {
      onNotify: () => {},
      onReloadMcp: async (opts) => {
        reloads.push(opts);
        return { ok: true };
      },
      onPollMcpOAuth: async () => {
        const cur = pollResponses[pollIdx++];
        if (cur instanceof Error) throw cur;
        if (typeof cur === 'string') throw cur;
        return cur;
      },
      onCancelMcpOAuth: async (p, n, sid) => {
        canceled.push([p, n, sid]);
      },
      get onOpenExternalUrl() {
        return onOpenExt;
      },
    };

    const m = d.mount(() =>
      React.createElement(McpOAuthInlinePanel, {
        profile: 'default',
        actions,
        state: inlineState,
        setState: setInlineState,
      }),
    );
    assert.equal(m.tree, null);

    // 1. Reload confirm actions (confirm, confirm_always, cancel)
    inlineState = {
      busy: false,
      reloadConfirm: { message: 'Reload?', rev: 'r2' },
      oauth: {
        name: 'gh',
        sessionId: 'oa-1',
        authUrl: 'https://oauth.dev/a',
        status: 'pending',
      },
    };
    m.rerender();
    const btns = findAll(m.tree, (n) => n?.props?.onClick);
    // Confirm, Always, Reload-cancel, OpenUrl, OAuth-cancel
    btns[0].props.onClick();
    btns[1].props.onClick();
    btns[2].props.onClick(); // dismiss reloadConfirm
    btns[3].props.onClick(); // open external via actions.onOpenExternalUrl
    onOpenExt = undefined;
    btns[3].props.onClick(); // fallback window.open

    // 2. Polling effect transitions pending -> approved
    t.mock.timers.tick(2000);
    await flushMicrotasks();
    assert.equal(inlineState.oauth.status, 'pending');
    t.mock.timers.tick(2000);
    await flushMicrotasks();
    assert.equal(inlineState.oauth.status, 'approved');
    m.rerender();

    // Non-pending close button clears oauth
    const closeApprovedBtn = findAll(m.tree, (n) => n?.props?.onClick).pop();
    closeApprovedBtn.props.onClick();
    assert.equal(inlineState.oauth, null);

    // 3. Pending cancel button + polling Error catch
    inlineState = {
      busy: false,
      reloadConfirm: null,
      oauth: { name: 'gh', sessionId: 'oa-2', authUrl: 'https://oauth.dev/b', status: 'pending' },
    };
    pollResponses = [new Error('poll fail'), 'string error'];
    pollIdx = 0;
    m.rerender();
    const cancelPendingBtn = findAll(m.tree, (n) => n?.props?.onClick).pop();
    cancelPendingBtn.props.onClick();
    assert.equal(canceled.length, 1);

    inlineState = {
      busy: false,
      reloadConfirm: null,
      oauth: { name: 'gh', sessionId: 'oa-3', authUrl: 'https://oauth.dev/c', status: 'pending' },
    };
    m.rerender();
    t.mock.timers.tick(2000);
    await flushMicrotasks();
    assert.equal(inlineState.oauth.status, 'error');
    m.rerender();

    // 4. Stale button guards (L289/310) + polling race & unmount guards (L139/142/154/156)
    inlineState = {
      busy: false,
      reloadConfirm: null,
      oauth: { name: 'gh', sessionId: 'oa-stale', authUrl: 'https://oauth.dev/s', status: 'pending' },
    };
    m.rerender();
    const staleBtns = findAll(m.tree, (n) => n?.props?.onClick);
    inlineState.oauth.authUrl = '';
    staleBtns[staleBtns.length - 2].props.onClick(); // hits !target || !isSafeExternalUrl (L289)
    inlineState.oauth.sessionId = '';
    staleBtns[staleBtns.length - 1].props.onClick(); // hits !sid || !mcpName (L310)
    m.unmount();

    const d2 = createHookDriver();
    let resolvePoll;
    let rejectPoll;
    let sRace = {
      busy: false,
      reloadConfirm: null,
      oauth: { name: 'gh', sessionId: 'oa-r1', authUrl: '', status: 'pending' },
    };
    const raceActions = {
      onNotify: () => {},
      onPollMcpOAuth: () =>
        new Promise((res, rej) => {
          resolvePoll = res;
          rejectPoll = rej;
        }),
    };
    const mRace = d2.mount(() =>
      React.createElement(McpOAuthInlinePanel, {
        profile: 'default',
        actions: raceActions,
        state: sRace,
        setState: (u) => { sRace = typeof u === 'function' ? u(sRace) : u; },
      }),
    );
    t.mock.timers.tick(2000);
    sRace.oauth = { name: 'gh', sessionId: 'oa-changed', authUrl: '', status: 'pending' };
    resolvePoll({ status: 'approved' }); // sessionId mismatch -> L142
    await flushMicrotasks();

    t.mock.timers.tick(2000);
    sRace.oauth = { name: 'gh', sessionId: 'oa-changed-2', authUrl: '', status: 'pending' };
    rejectPoll(new Error('late reject')); // sessionId mismatch -> L156
    await flushMicrotasks();

    mRace.rerender();
    t.mock.timers.tick(2000);
    mRace.unmount();
    resolvePoll({ status: 'approved' }); // cancelled === true -> L139
    await flushMicrotasks();

    const d3 = createHookDriver();
    let sRace3 = { busy: false, reloadConfirm: null, oauth: { name: 'gh', sessionId: 'oa-r3', authUrl: '', status: 'pending' } };
    const mRace3 = d3.mount(() =>
      React.createElement(McpOAuthInlinePanel, {
        profile: 'default',
        actions: raceActions,
        state: sRace3,
        setState: (u) => { sRace3 = typeof u === 'function' ? u(sRace3) : u; },
      }),
    );
    t.mock.timers.tick(2000);
    mRace3.unmount();
    rejectPoll(new Error('unmounted reject')); // cancelled === true -> L154
    await flushMicrotasks();

    assert.ok(reloads.length === 2);
    assert.ok(winOpened.length === 2);
  } finally {
    globalThis.window = prevWin;
    t.mock.timers.reset();
  }
});
