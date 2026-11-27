/**
 * 交互停靠卡、顶部提醒胶囊与四态waiting指示器 · UI 表现层及纯模型契约测试
 * (packages/ui/__tests__/interactive-prompts.test.mjs)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { serializeClarifyAnswer } from '@hermes-flux/core';
import {
  createPromptSubmitGate,
  createClarifyDraftCache,
  createEmptyClarifyDraft,
  hasClarifyDraftContent,
  shouldEvictClarifyDraftAfterSubmit,
  splitCompactHeaderSubtitle,
  resolveClarifyQuestionAnswer,
  buildClarifyReplyPayload,
  isSafeExternalUrl,
  buildCredentialSubmitPayload,
  areRequiredConnectionEnvFilled,
  resolveWaitingStatusKey,
  extractEditPreview,
  resolvePromptHeaderInfo,
  InteractivePromptHost,
  BackgroundPromptTopPill,
  ActivityIndicator,
  AgentPresence,
  MobileApprovalModeSheet,
  setLocale,
  t,
} from '../dist/index.js';

function makeScope(storedSessionId = 'sess-1') {
  return { kind: 'session', storedSessionId, liveSessionId: 'live-1', profile: 'default' };
}

test('interactiveModel: 纯模型契约与防连击锁/URL校验/凭据序列化', () => {
  const gate = createPromptSubmitGate();
  const tok1 = gate.tryAcquire('k1');
  assert.ok(typeof tok1 === 'number');
  assert.equal(gate.isBusy(), true);
  assert.equal(gate.tryAcquire('k2'), null, '在途期间必须拦截并发重入');
  gate.release(tok1);
  assert.equal(gate.isBusy(), false);

  assert.equal(isSafeExternalUrl('https://github.com/login/oauth'), true);
  assert.equal(isSafeExternalUrl('http://127.0.0.1:8080/cb'), true);
  assert.equal(isSafeExternalUrl('javascript:alert(1)'), false);
  assert.equal(isSafeExternalUrl('data:text/html,xss'), false);
  assert.equal(isSafeExternalUrl('file:///etc/passwd'), false);

  assert.equal(serializeClarifyAnswer(['OptA', 'OptB'], 'Extra', true), 'OptA, OptB, Extra');
  assert.equal(serializeClarifyAnswer(['Single'], 'Extra', false), 'Single');
  assert.equal(serializeClarifyAnswer([], '', false), null);

  const clarifyPrompt = {
    canonicalKey: 'session:sess-1::clarify::r1',
    requestId: 'r1',
    kind: 'clarify',
    scope: makeScope(),
    waitingReason: 'clarify',
    status: 'open',
    arrivalSeq: 1,
    createdAtMs: 1000,
    rpcId: 'r1',
    socketGeneration: 1,
    origin: 'live_ws',
    protocol: 'classic',
    questions: [
      { qid: 'q1', question: 'Q1?', choices: ['A', 'B'], multi_select: false },
      { qid: 'q2', question: 'Q2?', choices: ['X', 'Y'], multi_select: true },
    ],
    lockedAnswers: { q1: 'A' },
  };
  const replyOut = buildClarifyReplyPayload(clarifyPrompt, {
    selectedByQuestion: { q2: ['X', 'Y'] },
    otherEnabledByQuestion: {},
    otherTextByQuestion: {},
  });
  assert.equal(replyOut.missingCount, 0);
  assert.equal(replyOut.payload?.kind, 'clarify');
  if (replyOut.payload?.kind === 'clarify') {
    assert.deepEqual(replyOut.payload.answers, { q1: 'A', q2: 'X, Y' });
  }

  const vaultSavePrompt = {
    canonicalKey: 'session:sess-1::cred::vault.save_login::v1',
    requestId: 'v1',
    kind: 'credential',
    method: 'vault.save_login',
    scope: makeScope(),
    waitingReason: 'credential',
    status: 'open',
    arrivalSeq: 2,
    createdAtMs: 1000,
    rpcId: 'v1',
    socketGeneration: 1,
    origin: 'live_ws',
    protocol: 'classic',
    site: 'github.com',
  };
  assert.equal(
    buildCredentialSubmitPayload(vaultSavePrompt, { value: '', identifier: 'alice', password: '' }).valid,
    false,
  );
  const validSave = buildCredentialSubmitPayload(vaultSavePrompt, {
    value: '',
    identifier: 'alice',
    password: 'pw',
  });
  assert.equal(validSave.valid, true);
  assert.equal(validSave.payload?.identifier, 'alice');
  assert.equal(validSave.payload?.password, 'pw');

  const connPrompt = {
    canonicalKey: 'connection::op1',
    requestId: 'op1',
    kind: 'connection',
    scope: makeScope(),
    waitingReason: 'connection',
    status: 'open',
    arrivalSeq: 3,
    createdAtMs: 1000,
    rpcId: null,
    socketGeneration: null,
    origin: 'connection_event',
    protocol: 'classic',
    opId: 'op1',
    seq: 1,
    deadlineAtMs: 2000,
    timeoutSeconds: 300,
    owner: { type: 'session', session_id: 'live-1' },
    targets: [
      {
        name: 'linear',
        kind: 'mcp',
        action: 'install',
        state: 'pending',
        required_env: [{ name: 'LINEAR_KEY', prompt: 'API Key', secret: true, required: true }],
      },
    ],
  };
  assert.equal(areRequiredConnectionEnvFilled(connPrompt, 'linear', {}), false);
  assert.equal(
    areRequiredConnectionEnvFilled(connPrompt, 'linear', { linear: { LINEAR_KEY: 'sk-1' } }),
    true,
  );
  assert.equal(resolveWaitingStatusKey('clarify', 'rail'), 'rail.activityStatusWaitingReply');
  assert.equal(resolveWaitingStatusKey('credential', 'mobile'), 'mobile.status.waitingCredential');

  const preview = extractEditPreview({ file_path: 'src/a.ts', diff: '@@ -1 +1 @@\n-old\n+new' });
  assert.equal(preview.filePath, 'src/a.ts');
  assert.ok(preview.diff?.includes('+new'));
  const hdr = resolvePromptHeaderInfo(clarifyPrompt, t);
  assert.ok(hdr.title.length > 0 && hdr.subtitle.includes('Q1'));
});

test('InteractivePromptHost: 停靠渲染所有 6 类交互卡片并支持折叠草稿保留与零弹窗约束', () => {
  const noop = async () => {};
  const prompts = [
    {
      canonicalKey: 'k-clarify',
      requestId: 'req-c',
      kind: 'clarify',
      scope: makeScope(),
      waitingReason: 'clarify',
      status: 'open',
      arrivalSeq: 1,
      createdAtMs: 1000,
      rpcId: 'req-c',
      socketGeneration: 1,
      origin: 'live_ws',
      protocol: 'classic',
      questions: [{ qid: 'q1', question: 'Pick env?', choices: ['prod', 'dev'], multi_select: false }],
      lockedAnswers: {},
    },
    {
      canonicalKey: 'k-approval',
      requestId: 'req-a',
      kind: 'approval',
      scope: makeScope(),
      waitingReason: 'approval',
      status: 'open',
      arrivalSeq: 2,
      createdAtMs: 1001,
      rpcId: 'req-a',
      socketGeneration: 1,
      origin: 'live_ws',
      protocol: 'classic',
      command: 'git push --force',
      smartDenied: true,
      choices: ['once', 'session', 'deny'],
      edit: { path: 'src/main.ts', diff: '@@ -1,1 +1,1 @@\n-a\n+b' },
    },
    {
      canonicalKey: 'k-cred',
      requestId: 'req-s',
      kind: 'credential',
      method: 'vault.save_login',
      scope: makeScope(),
      waitingReason: 'credential',
      status: 'open',
      arrivalSeq: 3,
      createdAtMs: 1002,
      rpcId: 'req-s',
      socketGeneration: 1,
      origin: 'live_ws',
      protocol: 'classic',
      site: 'github.com',
      displayName: 'GitHub',
    },
    {
      canonicalKey: 'k-conn',
      requestId: 'op-1',
      kind: 'connection',
      scope: makeScope(),
      waitingReason: 'connection',
      status: 'open',
      arrivalSeq: 4,
      createdAtMs: 1003,
      rpcId: null,
      socketGeneration: null,
      origin: 'connection_event',
      protocol: 'classic',
      opId: 'op-1',
      seq: 1,
      deadlineAtMs: 2000,
      timeoutSeconds: 300,
      owner: { type: 'session', session_id: 'live-1' },
      targets: [
        {
          name: 'github',
          kind: 'connector',
          action: 'authorize',
          state: 'pending',
          connect_url: 'https://github.com/login/device',
          user_code: 'ABCD-1234',
        },
      ],
    },
    {
      canonicalKey: 'k-group',
      requestId: 'g-1',
      kind: 'group_action',
      scope: { kind: 'group', roomId: 'room-1' },
      waitingReason: 'confirm',
      status: 'open',
      arrivalSeq: 5,
      createdAtMs: 1004,
      rpcId: null,
      socketGeneration: null,
      origin: 'group_state',
      protocol: 'canonical',
      roomId: 'room-1',
      actionKind: 'retry',
      memberId: 'bot-a',
      taskId: 't1',
      executionGeneration: 2,
      choices: [],
      errorDetail: 'rate limited',
    },
    {
      canonicalKey: 'k-rpc',
      requestId: 'r-1',
      kind: 'rpc_confirm',
      scope: makeScope(),
      waitingReason: 'confirm',
      status: 'open',
      arrivalSeq: 6,
      createdAtMs: 1005,
      rpcId: null,
      socketGeneration: null,
      origin: 'rpc_confirm',
      protocol: 'classic',
      confirmKind: 'expensive_model',
      title: 'Expensive Model',
      message: 'Confirm switching?',
    },
  ];

  for (const active of prompts) {
    const html = renderToStaticMarkup(
      React.createElement(InteractivePromptHost, {
        surface: 'desktop-dock',
        prompts,
        activeCanonicalKey: active.canonicalKey,
        collapsed: false,
        locale: 'zh',
        onReply: noop,
      }),
    );
    assert.equal(html.includes('role="dialog"'), false, '交互停靠卡严禁以 modal/dialog 弹出');
    assert.ok(html.includes('flux-interact__host'), '必须渲染交互宿主容器');
    assert.ok(html.includes('data-surface="desktop-dock"'), '必须带桌面停靠表面语义');
    assert.ok(html.includes('flux-interact__stepper'), '多待处理请求时必须渲染队列步进器');
  }

  // 折叠态必须保留 [hidden] DOM 子树以保留草稿
  const collapsedHtml = renderToStaticMarkup(
    React.createElement(InteractivePromptHost, {
      surface: 'mobile-dock',
      prompts: [prompts[0]],
      activeCanonicalKey: 'k-clarify',
      collapsed: true,
      onCollapsedChange: () => {},
      locale: 'zh',
      onReply: noop,
    }),
  );
  assert.ok(collapsedHtml.includes('data-collapsed="true"'));
  assert.ok(collapsedHtml.includes('hidden=""') || collapsedHtml.includes('hidden'));
  assert.ok(collapsedHtml.includes('Pick env?'), '折叠后仍须保留提问 DOM 以防草稿丢失');
});

test('BackgroundPromptTopPill, ActivityIndicator(waiting), AgentPresence(waiting) 与 MobileApprovalModeSheet', () => {
  const pillHtml = renderToStaticMarkup(
    React.createElement(BackgroundPromptTopPill, {
      surface: 'desktop',
      summaries: [
        {
          scopeKey: 'session:bg-1',
          scope: makeScope('bg-1'),
          entityType: 'bot',
          entityId: 'coder',
          waitingReason: 'approval',
          promptCount: 2,
          oldestCreatedAtMs: 1000,
        },
      ],
      resolveEntityLabel: (s) => `Bot:${s.entityId}`,
      onSelectSummary: () => {},
    }),
  );
  assert.ok(pillHtml.includes('Bot:coder'));
  assert.ok(pillHtml.includes('2'));

  const indicatorHtml = renderToStaticMarkup(
    React.createElement(ActivityIndicator, {
      state: 'waiting',
      waitingReason: 'credential',
      placement: 'inline',
    }),
  );
  assert.ok(indicatorHtml.includes('data-status="waiting"'));
  assert.ok(indicatorHtml.includes('data-waiting-reason="credential"'));
  assert.equal(indicatorHtml.includes('<svg'), false, 'ActivityIndicator(waiting) 禁止内联 SVG');

  const presenceHtml = renderToStaticMarkup(
    React.createElement(AgentPresence, {
      snapshot: {
        presence: { kind: 'waiting', reason: 'approval', sinceMs: 5000 },
        identity: { kind: 'solo', name: 'flux', displayName: 'Flux' },
        locale: 'zh',
      },
    }),
  );
  assert.ok(presenceHtml.includes('data-presence="waiting"'));
  assert.ok(presenceHtml.includes(t('presence.waiting.approval')));

  const sheetHtml = renderToStaticMarkup(
    React.createElement(MobileApprovalModeSheet, {
      open: true,
      approvalMode: 'smart',
      onSelectApprovalMode: () => {},
      onClose: () => {},
    }),
  );
  assert.ok(sheetHtml.includes('data-sheet-kind="approval"'));
  assert.ok(sheetHtml.includes('data-approval-mode="smart" data-active="true"'));
});

test('createClarifyDraftCache 与紧凑卡片副标题分流/失败保留契约', () => {
  const cache = createClarifyDraftCache(2);
  const empty = createEmptyClarifyDraft();
  assert.equal(hasClarifyDraftContent(empty, 0), false, '全空默认草稿不得占位缓存');
  assert.equal(hasClarifyDraftContent(empty, 1), true);
  assert.equal(shouldEvictClarifyDraftAfterSubmit(false), false, '提交失败/回滚严禁清除草稿缓存');
  assert.equal(shouldEvictClarifyDraftAfterSubmit(true), true);
  assert.equal(shouldEvictClarifyDraftAfterSubmit(undefined), true);

  // NaN / 负数边界应回退至安全正容量而非破坏 LRU 淘汰
  const nanCache = createClarifyDraftCache(Number.NaN);
  assert.equal(nanCache.size(), 0);
  const d1 = { ...createEmptyClarifyDraft(), selectedByQuestion: { q0: ['Option Alpha'] } };
  const d2 = { ...createEmptyClarifyDraft(), otherEnabledByQuestion: { q0: true }, otherTextByQuestion: { q0: 'custom' } };
  const d3 = { ...createEmptyClarifyDraft(), selectedByQuestion: { q1: ['Beta'] } };
  assert.equal(hasClarifyDraftContent(d1, 0), true);
  assert.equal(hasClarifyDraftContent(d2, 0), true);

  cache.set('k1::100', d1, 0);
  cache.set('k2::200', d2, 1);
  assert.equal(cache.size(), 2);
  // 仅读取 k1 也必须刷新其 LRU 热度，后续写入 k3 应淘汰 k2
  assert.deepEqual(cache.get('k1::100'), { draft: d1, activeQIdx: 0 });
  cache.set('k3::300', d3, 0);
  assert.equal(cache.size(), 2);
  assert.equal(cache.get('k2::200'), undefined);
  assert.equal(cache.get('k1::100')?.activeQIdx, 0);
  assert.deepEqual(cache.get('k3::300')?.draft, d3);

  cache.delete('k1::100');
  assert.equal(cache.get('k1::100'), undefined);
  cache.clear();
  assert.equal(cache.size(), 0);

  // <=80 短描述收敛至 headerSubtitle，>80 长描述回退正文防截断丢字
  const shortSplit = splitCompactHeaderSubtitle('short rule', true);
  assert.deepEqual(shortSplit, { headerSubtitle: 'short rule' });
  const longText = 'A'.repeat(81);
  const longSplit = splitCompactHeaderSubtitle(longText, true);
  assert.deepEqual(longSplit, { bodyDescription: longText });

  const longApprovalHtml = renderToStaticMarkup(
    React.createElement(InteractivePromptHost, {
      surface: 'desktop-dock',
      prompts: [
        {
          canonicalKey: 'k-app-long',
          requestId: 'req-long',
          kind: 'approval',
          scope: makeScope(),
          waitingReason: 'approval',
          status: 'open',
          arrivalSeq: 1,
          createdAtMs: 1000,
          rpcId: 'req-long',
          socketGeneration: 1,
          origin: 'live_ws',
          protocol: 'classic',
          command: 'ls -la',
          description: longText,
          choices: ['once', 'session', 'workspace_session', 'always', 'deny'],
        },
      ],
      locale: 'zh',
      onReply: async () => false,
    }),
  );
  assert.equal(longApprovalHtml.includes('flux-interact__subtitle'), false, '超长审批说明不得硬挤进单行截断副标题');
  assert.ok(longApprovalHtml.includes('flux-interact__desc') && longApprovalHtml.includes(longText));

  const shortCredHtml = renderToStaticMarkup(
    React.createElement(InteractivePromptHost, {
      surface: 'mobile-dock',
      prompts: [
        {
          canonicalKey: 'k-cred-short',
          requestId: 'req-cs',
          kind: 'credential',
          method: 'secret',
          scope: makeScope(),
          waitingReason: 'credential',
          status: 'open',
          arrivalSeq: 2,
          createdAtMs: 1001,
          rpcId: 'req-cs',
          socketGeneration: 1,
          origin: 'live_ws',
          protocol: 'classic',
          promptText: 'Token needed',
        },
      ],
      locale: 'zh',
      onReply: async () => false,
    }),
  );
  assert.ok(shortCredHtml.includes('flux-interact__subtitle') && shortCredHtml.includes('Token needed'));
});

test('interactiveModel 全边界与分支覆盖（draft/clarify/credential/connection/edit/header/status）', () => {
  setLocale('zh-CN');

  // 1. ClarifyDraftCache empty key, size limit & hasClarifyDraftContent / shouldEvict
  const emptyDraft = createEmptyClarifyDraft();
  assert.equal(hasClarifyDraftContent(emptyDraft, 0), false);
  assert.equal(hasClarifyDraftContent(emptyDraft, 1), true);
  assert.equal(hasClarifyDraftContent({ ...emptyDraft, otherEnabledByQuestion: { q0: true } }), true);
  assert.equal(hasClarifyDraftContent({ ...emptyDraft, otherTextByQuestion: { q0: 'abc' } }), true);
  assert.equal(shouldEvictClarifyDraftAfterSubmit(false), false);
  assert.equal(shouldEvictClarifyDraftAfterSubmit(undefined), true);
  assert.equal(shouldEvictClarifyDraftAfterSubmit(true), true);

  const c1 = createClarifyDraftCache(1);
  c1.set('', emptyDraft, 0);
  assert.equal(c1.size(), 0);
  c1.set('a', emptyDraft, 0);
  c1.set('b', emptyDraft, 0);
  assert.equal(c1.size(), 1);
  assert.equal(c1.get('a'), undefined);

  assert.deepEqual(splitCompactHeaderSubtitle(null), {});
  assert.deepEqual(splitCompactHeaderSubtitle('   '), {});

  // 2. resolveClarifyQuestionAnswer & buildClarifyReplyPayload 全分支
  assert.equal(
    resolveClarifyQuestionAnswer({ qid: '', question: 'Freeform?', choices: null }, {}, emptyDraft, 2),
    '',
  );
  assert.equal(
    resolveClarifyQuestionAnswer(
      { qid: '', question: 'Freeform?', choices: [] },
      {},
      { ...emptyDraft, otherTextByQuestion: { '2': ' typed ' } },
      2,
    ),
    'typed',
  );
  assert.equal(
    resolveClarifyQuestionAnswer(
      { qid: 'q-s', question: 'Single?', choices: ['A', 'B'] },
      {},
      { ...emptyDraft, otherEnabledByQuestion: { 'q-s': true }, otherTextByQuestion: { 'q-s': 'custom' } },
      0,
    ),
    'custom',
  );
  assert.equal(
    resolveClarifyQuestionAnswer(
      { qid: 'q-s', question: 'Single empty', choices: ['A', 'B'] },
      {},
      emptyDraft,
      0,
    ),
    '',
  );
  assert.equal(
    resolveClarifyQuestionAnswer(
      { qid: 'q-m', question: 'Multi+other', choices: ['X', 'Y'], multi_select: true },
      {},
      {
        selectedByQuestion: { 'q-m': ['X'] },
        otherEnabledByQuestion: { 'q-m': true },
        otherTextByQuestion: { 'q-m': 'Z' },
      },
      0,
    ),
    'X, Z',
  );
  assert.equal(
    resolveClarifyQuestionAnswer(
      { qid: 'q-m', question: 'Multi empty other', choices: ['X'], multi_select: true },
      {},
      {
        selectedByQuestion: { 'q-m': ['X'] },
        otherEnabledByQuestion: { 'q-m': true },
        otherTextByQuestion: { 'q-m': '  ' },
      },
      0,
    ),
    'X',
  );

  const emptyQPrompt = {
    canonicalKey: 'k-cl-0',
    requestId: 'r0',
    kind: 'clarify',
    scope: makeScope(),
    waitingReason: 'clarify',
    status: 'open',
    arrivalSeq: 1,
    createdAtMs: 1,
    rpcId: 'r0',
    socketGeneration: 1,
    origin: 'live_ws',
    protocol: 'classic',
    questions: [],
    lockedAnswers: {},
  };
  assert.deepEqual(buildClarifyReplyPayload(emptyQPrompt, emptyDraft), { payload: null, missingCount: 1 });

  const noQidPrompt = {
    ...emptyQPrompt,
    questions: [
      { qid: '', question: 'Q0', choices: null },
      { qid: '', question: 'Q1', choices: ['A'] },
    ],
  };
  assert.deepEqual(buildClarifyReplyPayload(noQidPrompt, emptyDraft), { payload: null, missingCount: 2 });
  assert.deepEqual(
    buildClarifyReplyPayload(noQidPrompt, {
      selectedByQuestion: { '1': ['A'] },
      otherEnabledByQuestion: {},
      otherTextByQuestion: { '0': 'ans0' },
    }),
    { missingCount: 0, payload: { kind: 'clarify', answers: { '0': 'ans0', '1': 'A' } } },
  );

  // 3. isSafeExternalUrl & buildCredentialSubmitPayload & areRequiredConnectionEnvFilled
  assert.equal(isSafeExternalUrl('not a valid url://///'), false);
  assert.equal(isSafeExternalUrl('   '), false);
  assert.equal(isSafeExternalUrl(null), false);

  const baseCred = {
    canonicalKey: 'k-cr',
    requestId: 'r-cr',
    kind: 'credential',
    scope: makeScope(),
    waitingReason: 'credential',
    status: 'open',
    arrivalSeq: 1,
    createdAtMs: 1,
    rpcId: 'r-cr',
    socketGeneration: 1,
    origin: 'live_ws',
    protocol: 'classic',
    promptText: '',
  };
  assert.equal(
    buildCredentialSubmitPayload({ ...baseCred, method: 'vault.save_login' }, { value: '', identifier: ' ', password: 'p' }).valid,
    false,
  );
  assert.equal(
    buildCredentialSubmitPayload({ ...baseCred, method: 'vault.code' }, { value: '  ', identifier: '', password: '' }).valid,
    false,
  );
  assert.deepEqual(
    buildCredentialSubmitPayload({ ...baseCred, method: 'vault.code' }, { value: ' 4242 ', identifier: '', password: '' }),
    { valid: true, payload: { kind: 'credential', value: '4242' } },
  );
  assert.deepEqual(
    buildCredentialSubmitPayload({ ...baseCred, method: 'sudo' }, { value: 'sec ', identifier: '', password: '' }),
    { valid: true, payload: { kind: 'credential', value: 'sec ' } },
  );

  const connPrompt = {
    canonicalKey: 'k-cn',
    requestId: 'r-cn',
    kind: 'connection',
    scope: makeScope(),
    waitingReason: 'connection',
    status: 'open',
    arrivalSeq: 1,
    createdAtMs: 1,
    rpcId: 'r-cn',
    socketGeneration: 1,
    origin: 'live_ws',
    protocol: 'classic',
    targets: [
      { name: 'no-env', kind: 'oauth', state: 'pending' },
      {
        name: 'with-env',
        kind: 'oauth',
        state: 'pending',
        required_env: [
          { name: 'OPT', required: false },
          { name: 'REQ_DEF', required: true, default: 'def' },
          { name: 'REQ_EMPTY', required: true },
        ],
      },
    ],
  };
  assert.equal(areRequiredConnectionEnvFilled(connPrompt, 'missing', {}), true);
  assert.equal(areRequiredConnectionEnvFilled(connPrompt, 'no-env', {}), true);
  assert.equal(areRequiredConnectionEnvFilled(connPrompt, 'with-env', {}), false);
  assert.equal(
    areRequiredConnectionEnvFilled(connPrompt, 'with-env', { 'with-env': { REQ_EMPTY: 'ok' } }),
    true,
  );

  // 4. resolveWaitingStatusKey 全枚举与默认分支
  for (const variant of ['mobile', 'rail']) {
    for (const reason of ['clarify', 'approval', 'credential', 'connection', 'confirm', 'other']) {
      assert.ok(resolveWaitingStatusKey(reason, variant));
    }
  }

  // 5. extractEditPreview 全变体
  assert.deepEqual(extractEditPreview(null), {});
  assert.deepEqual(extractEditPreview({ file_path: 'a.ts', diff: 'd1' }), { filePath: 'a.ts', diff: 'd1' });
  assert.deepEqual(extractEditPreview({ resolved_path: 'b.ts', patch: 'p1' }), { filePath: 'b.ts', diff: 'p1' });
  assert.deepEqual(extractEditPreview({ diff: 'd-only' }), { diff: 'd-only' });
  assert.deepEqual(extractEditPreview({ patch: 'p-only' }), { diff: 'p-only' });
  assert.deepEqual(extractEditPreview({ old_string: 'a', new_string: 'b' }), { diff: '-a\n+b' });
  assert.deepEqual(extractEditPreview({ old_text: 'x' }), { diff: '-x' });
  assert.deepEqual(extractEditPreview({ new_text: 'y', path: 'c.ts' }), { filePath: 'c.ts', diff: '+y' });
  assert.deepEqual(extractEditPreview({ path: 'only.ts' }), { filePath: 'only.ts' });
  assert.deepEqual(extractEditPreview({}), {});

  // 6. resolvePromptHeaderInfo 全分支
  assert.equal(resolvePromptHeaderInfo(emptyQPrompt, t).subtitle, '');
  assert.equal(
    resolvePromptHeaderInfo(
      { ...emptyQPrompt, kind: 'approval', choices: ['once'], edit: { diff: 'x' } },
      t,
    ).subtitle,
    '',
  );
  assert.equal(
    resolvePromptHeaderInfo(
      { ...emptyQPrompt, kind: 'group_action', actionKind: 'approval', memberId: 'm1', taskId: 't1', choices: ['once'] },
      t,
    ).title,
    t('interactive.approval.groupTitle'),
  );
  assert.equal(
    resolvePromptHeaderInfo(
      { ...emptyQPrompt, kind: 'group_action', actionKind: 'retry', memberId: 'm1', taskId: 't1', choices: ['once'] },
      t,
    ).title,
    t('interactive.group.retryTitle'),
  );
  for (const method of ['sudo', 'display.install.sudo', 'vault.code', 'vault.unlock_prompt', 'vault.save_login', 'secret']) {
    const info = resolvePromptHeaderInfo({ ...baseCred, method }, t);
    assert.ok(info.title.length > 0);
  }
  assert.equal(resolvePromptHeaderInfo({ ...baseCred, method: 'secret', site: 's.com' }, t).subtitle, 's.com');
  assert.equal(resolvePromptHeaderInfo({ ...baseCred, method: 'secret', profileKey: 'pk' }, t).subtitle, 'pk');
  assert.equal(resolvePromptHeaderInfo({ ...baseCred, method: 'secret', promptText: 'pt' }, t).subtitle, 'pt');
  assert.equal(resolvePromptHeaderInfo({ ...baseCred, method: 'secret' }, t).subtitle, '');
});
