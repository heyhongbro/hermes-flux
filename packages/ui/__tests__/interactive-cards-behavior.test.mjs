/**
 * 交互停靠卡 React 组件 Hook/事件 全行为测试
 * 覆盖：PromptCardFrame, BackgroundPromptTopPill, ApprovalCard, ClarifyCard,
 *       ConnectionPromptCard, CredentialPromptCard, InteractivePromptHost
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {
  ApprovalCard,
  BackgroundPromptTopPill,
  ClarifyCard,
  ConnectionPromptCard,
  CredentialPromptCard,
  InteractivePromptHost,
  PromptCardFrame,
  setLocale,
  t,
} from '../dist/index.js';
import { createHookDriver, findAll, findByTestId, flushMicrotasks } from './helpers/reactHookDriver.mjs';

const SCOPE = { kind: 'session', storedSessionId: 's-1', liveSessionId: 'lv-1', profile: 'default' };
const basePrompt = (overrides) => ({
  canonicalKey: `k-${overrides.kind}-${overrides.requestId || '1'}`,
  requestId: overrides.requestId || 'req-1',
  scope: SCOPE,
  waitingReason: 'approval',
  status: 'open',
  arrivalSeq: 1,
  createdAtMs: 1000,
  rpcId: 'req-1',
  socketGeneration: 1,
  origin: 'live_ws',
  protocol: 'classic',
  ...overrides,
});

test('BackgroundPromptTopPill 与 PromptCardFrame 双端及步进边界', () => {
  setLocale('zh-CN');
  const d = createHookDriver();
  let selected = null;
  let collapsedToggles = 0;
  let selectedIdx = -1;

  const summary1 = {
    scopeKey: 'session:s-2',
    entityType: 'session',
    entityId: 's-2',
    scope: { kind: 'session', storedSessionId: 's-2', liveSessionId: null, profile: 'default' },
    waitingReason: 'clarify',
    promptCount: 1,
    earliestArrivalSeq: 2,
  };
  const summary2 = { ...summary1, scopeKey: 'bot:coder', entityType: 'bot', entityId: 'coder', promptCount: 2 };

  const nullMount = d.mount(() =>
    React.createElement(BackgroundPromptTopPill, {
      surface: 'desktop',
      summaries: [],
      resolveEntityLabel: () => 'S2',
      onSelectSummary: (s) => { selected = s; },
    }),
  );
  assert.equal(nullMount.tree, null);

  const mobMount = d.mount(() =>
    React.createElement(BackgroundPromptTopPill, {
      surface: 'mobile',
      summaries: [summary1],
      resolveEntityLabel: () => '',
      onSelectSummary: (s) => { selected = s; },
    }),
  );
  const mobBtn = findByTestId(mobMount.tree, 'interactive-background-top-pill');
  assert.ok(mobBtn);
  mobBtn.props.onClick();
  assert.equal(selected, summary1);

  const deskMount = d.mount(() =>
    React.createElement(BackgroundPromptTopPill, {
      surface: 'desktop',
      summaries: [summary1, summary2],
      resolveEntityLabel: () => 'Session Two',
      onSelectSummary: (s) => { selected = s; },
    }),
  );
  const deskBtn = findByTestId(deskMount.tree, 'interactive-background-top-pill');
  assert.equal(deskBtn.props['data-waiting-count'], 3);
  deskBtn.props.onClick();
  assert.equal(selected, summary1);

  const appPrompt = basePrompt({ kind: 'approval', choices: ['once'] });
  for (const surface of ['desktop-dock', 'mobile-dock']) {
    const collapsedMount = d.mount(() =>
      React.createElement(PromptCardFrame, {
        surface,
        prompt: appPrompt,
        queueIndex: 0,
        queueLength: 2,
        collapsed: true,
        headerSubtitle: 'sub',
        onToggleCollapse: () => { collapsedToggles += 1; },
        children: React.createElement('span', null, 'draft'),
      }),
    );
    findByTestId(collapsedMount.tree, 'interactive-card-expand').props.onClick();

    const expandedMount = d.mount(() =>
      React.createElement(PromptCardFrame, {
        surface,
        prompt: appPrompt,
        queueIndex: 1,
        queueLength: 2,
        collapsed: false,
        headerSubtitle: 'sub',
        errorMessage: 'err',
        onToggleCollapse: () => { collapsedToggles += 1; },
        onSelectQueueIndex: (idx) => { selectedIdx = idx; },
        actions: React.createElement('span', null, 'act'),
        children: React.createElement('span', null, 'body'),
      }),
    );
    findByTestId(expandedMount.tree, 'interactive-card-collapse').props.onClick();
    const stepBtns = findAll(expandedMount.tree, (n) => typeof n?.props?.onClick === 'function' && (n.props['aria-label'] === t('interactive.prevPrompt') || n.props['aria-label'] === t('interactive.nextPrompt')));
    for (const b of stepBtns) b.props.onClick();
  }
  assert.equal(collapsedToggles, 4);
  assert.equal(selectedIdx, 1);
});

test('ApprovalCard 全类型、未知 choice 回退与 discard 二次确认分支', async () => {
  setLocale('zh-CN');
  const submitted = [];
  const d = createHookDriver();

  // rpc_confirm
  const rpcPrompt = basePrompt({
    kind: 'rpc_confirm',
    waitingReason: 'confirm',
    rpcMethod: 'config.set',
    title: 'Confirm?',
    message: 'Expensive model',
    confirmLabel: 'Yes',
    secondaryConfirmLabel: 'Always',
    cancelLabel: 'No',
  });
  const rpcMount = d.mount(() =>
    React.createElement(ApprovalCard, {
      surface: 'mobile-dock',
      prompt: rpcPrompt,
      queueIndex: 0,
      queueLength: 1,
      collapsed: false,
      submitting: false,
      localError: null,
      onToggleCollapse: () => {},
      onSubmit: async (p) => { submitted.push(p); },
    }),
  );
  findByTestId(rpcMount.tree, 'interactive-confirm-cancel').props.onClick();
  findByTestId(rpcMount.tree, 'interactive-confirm-always').props.onClick();
  findByTestId(rpcMount.tree, 'interactive-confirm-accept').props.onClick();

  // group_action approval with custom fallback choice + workspace_session
  const grpAppPrompt = basePrompt({
    kind: 'group_action',
    actionKind: 'approval',
    memberId: 'm1',
    taskId: 't1',
    toolName: 'bash',
    command: 'ls',
    description: 'run',
    choices: ['workspace_session', 'custom_unknown', 'deny'],
  });
  const grpAppMount = d.mount(() =>
    React.createElement(ApprovalCard, {
      surface: 'desktop-dock',
      prompt: grpAppPrompt,
      queueIndex: 0,
      queueLength: 1,
      collapsed: false,
      submitting: false,
      localError: null,
      onToggleCollapse: () => {},
      onSubmit: async (p) => { submitted.push(p); },
    }),
  );
  findByTestId(grpAppMount.tree, 'interactive-group-approve-workspace_session').props.onClick();
  findByTestId(grpAppMount.tree, 'interactive-group-approve-deny').props.onClick();

  // group_action retry -> arm -> cancel -> re-arm -> confirm -> retry
  const grpRetryPrompt = basePrompt({
    kind: 'group_action',
    actionKind: 'retry',
    memberId: 'm1',
    taskId: 't1',
    errorDetail: 'timeout',
    choices: [],
  });
  const grpRetryMount = d.mount(() =>
    React.createElement(ApprovalCard, {
      surface: 'mobile-dock',
      prompt: grpRetryPrompt,
      queueIndex: 0,
      queueLength: 1,
      collapsed: false,
      submitting: false,
      localError: null,
      onToggleCollapse: () => {},
      onSubmit: async (p) => { submitted.push(p); },
    }),
  );
  findByTestId(grpRetryMount.tree, 'interactive-group-discard-arm').props.onClick();
  grpRetryMount.rerender();
  const cancelDiscardBtn = findAll(
    grpRetryMount.tree,
    (n) => typeof n?.props?.onClick === 'function' && JSON.stringify(n.props.children).includes(t('interactive.group.discardCancelBtn')),
  )[0];
  cancelDiscardBtn.props.onClick();
  grpRetryMount.rerender();
  findByTestId(grpRetryMount.tree, 'interactive-group-discard-arm').props.onClick();
  grpRetryMount.rerender();
  findByTestId(grpRetryMount.tree, 'interactive-group-discard-confirm').props.onClick();
  grpRetryMount.rerender();
  // Still testable when retry clicked in non-armed state
  const dRetry2 = createHookDriver();
  const grpRetryMount2 = dRetry2.mount(() =>
    React.createElement(ApprovalCard, {
      surface: 'desktop-dock',
      prompt: grpRetryPrompt,
      queueIndex: 0,
      queueLength: 1,
      collapsed: false,
      submitting: false,
      localError: null,
      onToggleCollapse: () => {},
      onSubmit: async (p) => { submitted.push(p); },
    }),
  );
  findByTestId(grpRetryMount2.tree, 'interactive-group-retry').props.onClick();

  // regular approval: smartDenied + diff without filePath + command + no-body case
  const regApp = basePrompt({
    kind: 'approval',
    smartDenied: true,
    description: 'short desc',
    edit: { diff: '-a\n+b' },
    choices: ['once', 'session', 'deny'],
  });
  const regMount = d.mount(() =>
    React.createElement(ApprovalCard, {
      surface: 'mobile-dock',
      prompt: regApp,
      queueIndex: 0,
      queueLength: 1,
      collapsed: false,
      submitting: false,
      localError: null,
      onToggleCollapse: () => {},
      onSubmit: async (p) => { submitted.push(p); },
    }),
  );
  findByTestId(regMount.tree, 'interactive-approval-once').props.onClick();

  const dFilePath = createHookDriver();
  const editWithPath = basePrompt({
    kind: 'approval',
    toolName: 'bash',
    command: 'cat a.ts',
    edit: { path: 'src/a.ts', diff: '-x\n+y' },
    choices: ['once'],
  });
  const fpMount = dFilePath.mount(() =>
    React.createElement(ApprovalCard, {
      surface: 'desktop-dock',
      prompt: editWithPath,
      queueIndex: 0,
      queueLength: 1,
      collapsed: false,
      submitting: false,
      localError: null,
      onToggleCollapse: () => {},
      onSubmit: async () => {},
    }),
  );
  assert.ok(JSON.stringify(fpMount.tree).includes('src/a.ts'));

  // Minimal approval without toolName / command / description / edit + with localError
  const dMinApp = createHookDriver();
  const minAppMount = dMinApp.mount(() =>
    React.createElement(ApprovalCard, {
      surface: 'desktop-dock',
      prompt: basePrompt({ kind: 'approval', choices: ['once'] }),
      queueIndex: 0,
      queueLength: 1,
      collapsed: false,
      submitting: false,
      localError: 'app-err',
      onToggleCollapse: () => {},
      onSubmit: async () => {},
    }),
  );
  assert.ok(JSON.stringify(minAppMount.tree).includes('app-err'));

  await flushMicrotasks();
  assert.ok(submitted.some((p) => p.kind === 'rpc_confirm' && p.outcome === 'cancel'));
  assert.ok(submitted.some((p) => p.kind === 'group_action' && p.action === 'approve' && p.choice === 'once'));
  assert.ok(submitted.some((p) => p.kind === 'group_action' && p.action === 'discard'));
  assert.ok(submitted.some((p) => p.kind === 'group_action' && p.action === 'retry'));
  assert.ok(submitted.some((p) => p.kind === 'approval' && p.choice === 'once'));
});

test('ClarifyCard 选项、Other、锁定、快捷键与草稿重置全交互驱动', async () => {
  setLocale('zh-CN');
  const d = createHookDriver();
  const submitted = [];
  const locked = [];
  let submitResult = false;
  let prompt = basePrompt({
    kind: 'clarify',
    waitingReason: 'clarify',
    canonicalKey: 'cl-1',
    questions: [
      { qid: 'q0', question: 'Q0?', choices: ['A', 'B'], multi_select: true },
      { qid: 'q1', question: 'Q1?', choices: ['X', 'Y'], multi_select: false },
      { qid: 'q2', question: 'Q2 locked?', choices: null, multi_select: false },
    ],
    lockedAnswers: { q2: 'locked text' },
  });
  let submitting = false;

  const m = d.mount(() =>
    React.createElement(ClarifyCard, {
      surface: 'mobile-dock',
      prompt,
      queueIndex: 0,
      queueLength: 1,
      collapsed: false,
      submitting,
      localError: null,
      onToggleCollapse: () => {},
      onSubmit: async (p) => {
        submitted.push(p);
        return submitResult;
      },
      onLockAnswer: async (qid, ans) => {
        locked.push([qid, ans]);
      },
    }),
  );

  // Submit empty -> validation error
  await findByTestId(m.tree, 'interactive-clarify-submit').props.onClick();
  m.rerender();

  // Select choice A twice (toggle on/off), select B, toggle other, type other text
  const choiceBtns = () => findAll(m.tree, (n) => n?.type === 'button' && n?.props?.className === 'flux-interact__choice-chip');
  choiceBtns()[0].props.onClick();
  m.rerender();
  choiceBtns()[0].props.onClick(); // toggle off
  m.rerender();
  choiceBtns()[1].props.onClick();
  m.rerender();
  choiceBtns()[2].props.onClick(); // toggleOther multi
  m.rerender();

  const ta = () => findAll(m.tree, (n) => n?.props?.onKeyDown && n?.props?.onChange)[0];
  ta().props.onChange({ currentTarget: { value: 'custom0' } });
  m.rerender();

  // Composing Enter ignored, Shift+Enter ignored, Enter locks & advances to q1
  ta().props.onKeyDown({ key: 'Enter', shiftKey: false, nativeEvent: { isComposing: true }, preventDefault() {} });
  ta().props.onKeyDown({ key: 'Enter', shiftKey: true, nativeEvent: { isComposing: false }, preventDefault() {} });
  ta().props.onKeyDown({ key: 'Enter', shiftKey: false, nativeEvent: { isComposing: false }, preventDefault() {} });
  await flushMicrotasks();
  m.rerender();
  assert.deepEqual(locked, [['q0', 'B, custom0']]);

  // Now on q1 (single select): toggleOther on then off, switch to temporary canonicalKey then back to cl-1 to hit restored draft, then pick X and lock
  choiceBtns()[2].props.onClick(); // toggleOther single ON
  m.rerender();
  choiceBtns()[2].props.onClick(); // toggleOther single OFF (covers L130 false branch)
  m.rerender();
  const savedCl1 = prompt;
  prompt = { ...savedCl1, canonicalKey: 'cl-other-temp' };
  m.rerender();
  m.rerender();
  prompt = savedCl1; // switches back while draft cached in sharedClarifyDraftCache (covers L75-76 restored branch)
  m.rerender();
  m.rerender();
  choiceBtns()[0].props.onClick(); // single choice X clears otherEnabled
  m.rerender();
  const nextBtn = findAll(
    m.tree,
    (n) => typeof n?.props?.onClick === 'function' && JSON.stringify(n.props.children).includes(t('interactive.nextPrompt')),
  )[0];
  await nextBtn.props.onClick();
  await flushMicrotasks();
  m.rerender();

  // Click tab 0 and tab 1, then press Enter on non-next last question / submit all
  const tabs = findAll(m.tree, (n) => n?.props?.role === 'tab');
  assert.equal(tabs.length, 3);
  tabs[1].props.onClick();
  m.rerender();

  // Submit -> settled=false keeps draft; then settled=true evicts draft
  await findByTestId(m.tree, 'interactive-clarify-submit').props.onClick();
  await flushMicrotasks();
  submitResult = true;
  await findByTestId(m.tree, 'interactive-clarify-submit').props.onClick();
  await flushMicrotasks();
  await findByTestId(m.tree, 'interactive-clarify-cancel').props.onClick();
  await flushMicrotasks();

  // Cover Enter calling handleSubmitAll directly on single freeform question
  prompt = basePrompt({
    kind: 'clarify',
    waitingReason: 'clarify',
    canonicalKey: 'cl-2',
    questions: [{ qid: '', question: 'Single free?', choices: null }],
    lockedAnswers: {},
  });
  m.rerender();
  ta().props.onChange({ currentTarget: { value: 'single ans' } });
  m.rerender();
  ta().props.onKeyDown({ key: 'Enter', shiftKey: false, nativeEvent: { isComposing: false }, preventDefault() {} });
  await flushMicrotasks();

  // Multi-question with empty qid -> tabKey / qKey fallback '0' & Next button consistency
  prompt = basePrompt({
    kind: 'clarify',
    waitingReason: 'clarify',
    canonicalKey: 'cl-blank-qid',
    questions: [
      { qid: '', question: 'Blank 0?', choices: null },
      { qid: 'q-second', question: 'Second?', choices: null },
    ],
    lockedAnswers: {},
  });
  m.rerender();
  m.rerender();
  ta().props.onChange({ currentTarget: { value: 'fallback ans' } });
  m.rerender();
  const nextBlankBtn = findAll(
    m.tree,
    (n) => typeof n?.props?.onClick === 'function' && JSON.stringify(n.props.children).includes(t('interactive.nextPrompt')),
  )[0];
  await nextBlankBtn.props.onClick();
  await flushMicrotasks();
  assert.deepEqual(locked.at(-1), ['0', 'fallback ans']);

  prompt = { ...prompt, lockedAnswers: { '0': 'fallback ans' } };
  m.rerender();
  findAll(m.tree, (n) => n?.props?.role === 'tab')[0].props.onClick();
  m.rerender();
  const lockedBox = findAll(m.tree, (n) => n?.props?.className === 'flux-interact__locked-answer')[0];
  assert.ok(lockedBox);
  assert.equal(lockedBox.props.children, 'fallback ans');

  // Empty questions fallback (!currentQ) + submitting=true guard
  prompt = { ...prompt, canonicalKey: 'cl-3', questions: [] };
  submitting = true;
  m.rerender();
  await findByTestId(m.tree, 'interactive-clarify-submit').props.onClick();
  await findByTestId(m.tree, 'interactive-clarify-cancel').props.onClick();
  assert.ok(submitted.length >= 3);
});

test('ConnectionPromptCard & CredentialPromptCard 全分支、剪贴板降级、校验与清理', async () => {
  setLocale('zh-CN');
  const d = createHookDriver();
  const prevNav = globalThis.navigator;
  let clipboardThrows = false;
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      clipboard: {
        writeText: async () => {
          if (clipboardThrows) throw new Error('denied');
        },
      },
    },
  });

  try {
    const connSubmits = [];
    const opened = [];
    const woken = [];
    let connPrompt = basePrompt({
      kind: 'connection',
      waitingReason: 'connection',
      canonicalKey: 'conn-1',
      targets: [
        {
          name: 'gh',
          kind: 'oauth',
          state: 'pending',
          connect_url: 'https://github.com/login',
          description: 'desc',
          instructions: 'inst',
          detail: 'detail',
          scan: { status: 'warnings', summary: 'minor' },
          launch: { kind: 'url', target: 'https://github.com/login' },
          required_env: [
            { name: 'TOKEN', required: true, secret: true, prompt: 'token' },
            { name: 'OPT', required: false, default: 'v' },
            { name: 'OPT_EMPTY', required: false },
          ],
        },
        { name: 'init', kind: 'oauth', state: 'initiated', connect_url: 'javascript:bad', scan: { status: 'failed' } },
        { name: 'ok', kind: 'oauth', state: 'connected', scan: { status: 'passed', summary: 'clean' } },
        { name: 'no_url', kind: 'oauth', state: 'pending', required_env: [{ name: 'OPT_NO_DEF', required: false }] },
        { name: 'sk', kind: 'oauth', state: 'skipped' },
        { name: 'fl', kind: 'oauth', state: 'failed' },
        { name: 'ex', kind: 'oauth', state: 'expired' },
        { name: 'nc', kind: 'oauth', state: 'not_connected' },
      ],
    });
    let connSubmitting = false;
    const connMount = d.mount(() =>
      React.createElement(ConnectionPromptCard, {
        surface: 'mobile-dock',
        prompt: connPrompt,
        queueIndex: 0,
        queueLength: 1,
        collapsed: false,
        submitting: connSubmitting,
        localError: null,
        onToggleCollapse: () => {},
        onSubmit: async (p) => { connSubmits.push(p); },
        onOpenExternalUrl: (u) => opened.push(u),
        onWakeConnection: async (p) => { woken.push(p.canonicalKey); },
      }),
    );

    const findBtnByText = (text) =>
      findAll(connMount.tree, (n) => n?.props?.onClick && JSON.stringify(n.props.children).includes(text))[0];

    // Approve without TOKEN -> validationError
    await findBtnByText(t('interactive.connection.approveTarget')).props.onClick();
    connMount.rerender();

    // Fill TOKEN & approve -> submits env
    const envInput = findAll(connMount.tree, (n) => n?.props?.onChange && n?.props?.type === 'password')[0];
    envInput.props.onChange({ currentTarget: { value: 'tok-123' } });
    connMount.rerender();
    await findBtnByText(t('interactive.connection.approveTarget')).props.onClick();

    // Open external url, copy ok & copy throw, wake, skip, continue
    findBtnByText(t('interactive.connection.openBrowser')).props.onClick();
    await findBtnByText(t('interactive.connection.copyUrl')).props.onClick();
    connMount.rerender();
    clipboardThrows = true;
    await findBtnByText(t('interactive.copied')).props.onClick();
    await findBtnByText(t('interactive.connection.checkAuth')).props.onClick();
    await findBtnByText(t('interactive.connection.skipTarget')).props.onClick();
    await findByTestId(connMount.tree, 'interactive-connection-continue').props.onClick();

    // Approve no_url target where envPayload ends up empty, plus submitting=true guards (fresh tree closures)
    const approveBtns = findAll(connMount.tree, (n) => n?.props?.onClick && JSON.stringify(n.props.children).includes(t('interactive.connection.approveTarget')));
    await approveBtns[1].props.onClick();
    connSubmitting = true;
    connMount.rerender();
    await findAll(connMount.tree, (n) => n?.props?.onClick && JSON.stringify(n.props.children).includes(t('interactive.connection.approveTarget')))[0].props.onClick();
    await findByTestId(connMount.tree, 'interactive-connection-continue').props.onClick();
    await findBtnByText(t('interactive.connection.skipTarget')).props.onClick();

    connPrompt = { ...connPrompt, canonicalKey: 'conn-2' };
    connMount.rerender();
    connMount.unmount();

    assert.deepEqual(opened, ['https://github.com/login']);
    assert.deepEqual(woken, ['conn-1']);
    assert.ok(connSubmits.some((p) => p.targets?.[0]?.status === 'approved' && p.targets[0].env?.TOKEN === 'tok-123'));
    assert.ok(connSubmits.some((p) => p.targets?.[0]?.status === 'skipped'));
    assert.ok(connSubmits.some((p) => p.settledBy === 'continue'));

    // CredentialPromptCard: vault.save_login, vault.code, secret
    const credSubmits = [];
    let credPrompt = basePrompt({
      kind: 'credential',
      waitingReason: 'credential',
      canonicalKey: 'cr-1',
      method: 'vault.save_login',
      promptText: 'Login required',
      envVar: 'E',
      profileKey: 'P',
      site: 'S',
      backend: 'B',
      hint: 'H',
      originUrl: 'https://s.test',
      command: 'cmd',
    });
    let credSubmitting = false;
    let credSurface = 'desktop-dock';
    const credMount = d.mount(() =>
      React.createElement(CredentialPromptCard, {
        surface: credSurface,
        prompt: credPrompt,
        queueIndex: 0,
        queueLength: 1,
        collapsed: false,
        submitting: credSubmitting,
        localError: null,
        onToggleCollapse: () => {},
        onSubmit: async (p) => { credSubmits.push(p); },
      }),
    );
    credSurface = 'mobile-dock';
    credMount.rerender();
    // Submit invalid empty -> error, fill identifier & password, toggle eye, form submit
    await findByTestId(credMount.tree, 'interactive-credential-submit').props.onClick();
    credMount.rerender();
    const credInputs = () => findAll(credMount.tree, (n) => typeof n?.props?.onChange === 'function');
    credInputs()[0].props.onChange({ currentTarget: { value: 'alice' } });
    credInputs()[1].props.onChange({ currentTarget: { value: 'pw' } });
    credMount.rerender();
    const eyeBtn = findAll(credMount.tree, (n) => n?.props?.['aria-pressed'] !== undefined)[0];
    eyeBtn.props.onClick();
    credMount.rerender();
    const formEl = findAll(credMount.tree, (n) => n?.type === 'form' && n?.props?.onSubmit)[0];
    await formEl.props.onSubmit({ preventDefault() {} });
    await findByTestId(credMount.tree, 'interactive-credential-skip').props.onClick();

    // vault.code + secret toggle
    for (const method of ['vault.code', 'sudo']) {
      credPrompt = { ...credPrompt, canonicalKey: `cr-${method}`, method };
      credMount.rerender();
      const inp = findAll(credMount.tree, (n) => typeof n?.props?.onChange === 'function')[0];
      inp.props.onChange({ currentTarget: { value: '9999' } });
      credMount.rerender();
      if (method === 'sudo') {
        const sEye = findAll(credMount.tree, (n) => n?.props?.['aria-pressed'] !== undefined)[0];
        sEye.props.onClick();
        credMount.rerender();
      }
      await findByTestId(credMount.tree, 'interactive-credential-submit').props.onClick();
    }
    credSubmitting = true;
    credMount.rerender();
    await findAll(credMount.tree, (n) => n?.type === 'form' && n?.props?.onSubmit)[0].props.onSubmit({ preventDefault() {} });
    await findByTestId(credMount.tree, 'interactive-credential-skip').props.onClick();

    // Minimal secret prompt with localError & no metadata badges + desktop-dock toggle showPlain back to false
    credSubmitting = false;
    credSurface = 'desktop-dock';
    credPrompt = basePrompt({
      kind: 'credential',
      waitingReason: 'credential',
      canonicalKey: 'cr-min',
      method: 'secret',
    });
    const dMinCred = createHookDriver();
    const minCredMount = dMinCred.mount(() =>
      React.createElement(CredentialPromptCard, {
        surface: 'desktop-dock',
        prompt: credPrompt,
        queueIndex: 0,
        queueLength: 1,
        collapsed: false,
        submitting: false,
        localError: 'cred failed',
        onToggleCollapse: () => {},
        onSubmit: async (p) => { credSubmits.push(p); },
      }),
    );
    const minEye = findAll(minCredMount.tree, (n) => n?.props?.['aria-pressed'] !== undefined)[0];
    minEye.props.onClick();
    minCredMount.rerender();
    findAll(minCredMount.tree, (n) => n?.props?.['aria-pressed'] !== undefined)[0].props.onClick();
    minCredMount.rerender();
    minCredMount.unmount();

    // Partial metadata badges (hasMetaBadges=true while individual badges take : null branches)
    for (const extra of [{ envVar: 'ONLY_ENV' }, { site: 'only.site' }]) {
      const partMount = createHookDriver().mount(() =>
        React.createElement(CredentialPromptCard, {
          surface: 'desktop-dock',
          prompt: basePrompt({ kind: 'credential', waitingReason: 'credential', canonicalKey: `cr-${Object.keys(extra)[0]}`, method: 'secret', ...extra }),
          queueIndex: 0,
          queueLength: 1,
          collapsed: false,
          submitting: false,
          localError: null,
          onToggleCollapse: () => {},
          onSubmit: async () => true,
        }),
      );
      partMount.unmount();
    }

    credMount.unmount();
    assert.ok(credSubmits.length >= 4);
  } finally {
    if (prevNav === undefined) {
      delete globalThis.navigator;
    } else {
      Object.defineProperty(globalThis, 'navigator', { configurable: true, value: prevNav });
    }
  }
});

test('InteractivePromptHost 受控/非受控折叠、队列选择、Escape 与防重入异常捕获', async () => {
  setLocale('zh-CN');
  const d = createHookDriver();
  const p1 = basePrompt({ kind: 'approval', canonicalKey: 'k-1', choices: ['once'] });
  const p2 = basePrompt({ kind: 'clarify', canonicalKey: 'k-2', questions: [{ qid: 'q', question: 'Q', choices: null }], lockedAnswers: {} });

  // Empty prompts returns null
  const emptyHost = d.mount(() =>
    React.createElement(InteractivePromptHost, { surface: 'desktop-dock', prompts: [], locale: 'zh', onReply: async () => true }),
  );
  assert.equal(emptyHost.tree, null);

  // Uncontrolled collapse + Escape + double submit lock + throw recovery
  let resolveSlow;
  let callIdx = 0;
  let selectedPrompt = null;
  let curPrompts = [p1, p2];
  const unctrlHost = d.mount(() =>
    React.createElement(InteractivePromptHost, {
      surface: 'desktop-dock',
      prompts: curPrompts,
      activeCanonicalKey: 'missing-key',
      locale: 'zh',
      onSelectPrompt: (k) => { selectedPrompt = k; },
      onReply: async () => {
        callIdx += 1;
        if (callIdx === 1 || callIdx === 5) return await new Promise((r) => { resolveSlow = r; });
        if (callIdx === 2) return false;
        if (callIdx === 3) throw new Error('reply exploded');
        throw '';
      },
    }),
  );
  const container = () => findAll(unctrlHost.tree, (n) => n?.props?.['data-flux-island'] === 'true' && typeof n?.props?.onKeyDown === 'function')[0];
  container().props.onKeyDown({ key: 'Escape', nativeEvent: { isComposing: true }, stopPropagation() {} });
  container().props.onKeyDown({ key: 'Escape', keyCode: 229, nativeEvent: { isComposing: false }, stopPropagation() {} });
  container().props.onKeyDown({ key: 'Enter', nativeEvent: { isComposing: false }, stopPropagation() {} });
  container().props.onKeyDown({ key: 'Escape', nativeEvent: { isComposing: false }, stopPropagation() {} });
  unctrlHost.rerender();
  findByTestId(unctrlHost.tree, 'interactive-card-expand').props.onClick();
  unctrlHost.rerender();

  // Select prompt via queue next stepper
  const nextBtn = findAll(unctrlHost.tree, (n) => n?.props?.['aria-label'] === t('interactive.nextPrompt'))[0];
  nextBtn.props.onClick();
  assert.equal(selectedPrompt, 'k-2');

  // Re-acquire lock while slow submit is in flight
  const btn = () => findByTestId(unctrlHost.tree, 'interactive-approval-once');
  btn().props.onClick();
  await flushMicrotasks();
  btn().props.onClick(); // blocked by gateRef
  resolveSlow(true);
  await flushMicrotasks();
  unctrlHost.rerender();

  btn().props.onClick(); // false outcome
  await flushMicrotasks();
  btn().props.onClick(); // throws Error -> sets localError (L88-90)
  await flushMicrotasks();
  unctrlHost.rerender();
  btn().props.onClick(); // throws '' -> fallback 'Unknown error' (L88)
  await flushMicrotasks();
  unctrlHost.rerender();

  // Start callIdx 5 on p1, submit on p1, then immediately start another submit on p2 while p1 switched -> L93 false branch
  btn().props.onClick();
  const slowResolve1 = resolveSlow;
  curPrompts = [{ ...p1, canonicalKey: 'k-other' }];
  unctrlHost.rerender();
  btn().props.onClick();
  slowResolve1(true);
  resolveSlow(true);
  await flushMicrotasks();

  // Controlled collapse path
  let ctrlCollapsed = false;
  const ctrlHost = d.mount(() =>
    React.createElement(InteractivePromptHost, {
      surface: 'desktop-dock',
      prompts: [p1],
      collapsed: ctrlCollapsed,
      onCollapsedChange: (next) => { ctrlCollapsed = next; },
      locale: 'zh',
      onReply: async () => true,
    }),
  );
  findAll(ctrlHost.tree, (n) => n?.props?.['data-flux-island'] === 'true' && typeof n?.props?.onKeyDown === 'function')[0].props.onKeyDown({
    key: 'Escape',
    nativeEvent: { isComposing: false },
    stopPropagation() {},
  });
  assert.equal(ctrlCollapsed, true);
});
