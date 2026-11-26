/**
 * LiveStreamSync 多会话实时流同步与权威决策单测
 * (packages/core/__tests__/session/liveStreamSync.test.mjs)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LiveStreamRegistry,
  TokenCoalescer,
  extractResumeInflightState,
  decideWatchdogProbeAction,
  planRemoteUserPromptInsert,
} from '../../dist/index.js';

test('LiveStreamRegistry: 注册、1:1 双射覆盖、查询与清理语义', () => {
  const reg = new LiveStreamRegistry();
  assert.equal(reg.size(), 0);
  assert.equal(reg.getBySession(null), undefined);
  assert.equal(reg.getByMessageId(undefined), undefined);
  assert.equal(reg.getSessionIdForMessage(undefined), null);
  assert.equal(reg.hasSession(null), false);

  const s1 = reg.registerStream({
    storedSessionId: 'sess-1',
    liveSessionId: '',
    messageId: 'msg-1',
    origin: 'local',
    nowMs: 1000,
  });
  assert.equal(s1.liveSessionId, 'sess-1');
  assert.equal(s1.userMessageSynced, true);
  assert.equal(reg.hasSession('sess-1'), true);
  assert.equal(reg.getSessionIdForMessage('msg-1'), 'sess-1');
  assert.equal(reg.getByMessageId('msg-1'), s1);

  // 同一 session 覆盖旧 messageId，旧 messageId 反向映射必须失效
  const s1Next = reg.registerStream({
    storedSessionId: 'sess-1',
    liveSessionId: 'live-1b',
    messageId: 'msg-1b',
    botName: 'arch-bot',
    origin: 'remote',
    startedAt: 900,
    initialContent: 'init',
    nowMs: 1100,
  });
  assert.equal(reg.getSessionIdForMessage('msg-1'), null);
  assert.equal(reg.getSessionIdForMessage('msg-1b'), 'sess-1');
  assert.equal(s1Next.userMessageSynced, false);
  assert.equal(s1Next.segmentOffset, 4);

  // 相同 messageId 迁移到新 session，旧 session 绑定被移除
  reg.registerStream({
    storedSessionId: 'sess-2',
    liveSessionId: 'live-2',
    messageId: 'msg-1b',
    origin: 'remote',
    nowMs: 1200,
  });
  assert.equal(reg.hasSession('sess-1'), false);
  assert.equal(reg.getBySession('sess-2')?.messageId, 'msg-1b');

  assert.equal(reg.updateLiveId('missing', 'lx'), false);
  assert.equal(reg.updateLiveId('sess-2', ''), false);
  assert.equal(reg.updateLiveId('sess-2', 'live-2-new'), true);
  assert.equal(reg.getBySession('sess-2')?.liveSessionId, 'live-2-new');

  assert.equal(reg.markUserSynced('missing'), false);
  assert.equal(reg.markUserSynced('sess-2'), true);
  assert.equal(reg.getBySession('sess-2')?.userMessageSynced, true);

  assert.equal(reg.touchActivity('missing', 1500), false);
  assert.equal(reg.touchActivity('sess-2', 1500), true);
  assert.equal(reg.getBySession('sess-2')?.lastActivityAt, 1500);

  assert.equal(reg.removeSession('missing'), undefined);
  assert.ok(reg.removeSession('sess-2'));
  assert.equal(reg.size(), 0);

  reg.registerStream({
    storedSessionId: 'sess-3',
    liveSessionId: 'live-3',
    messageId: 'msg-3',
    origin: 'local',
    nowMs: 1600,
  });
  reg.clear();
  assert.equal(reg.size(), 0);
  assert.deepEqual(reg.listSessionIds(), []);
});

test('LiveStreamRegistry.acceptDelta: (turnId, segment, offset) 去重、重叠裁切与段落换段符', () => {
  const reg = new LiveStreamRegistry();
  assert.deepEqual(reg.acceptDelta('missing', { text: 'a' }), {
    deltaToAppend: '',
    accepted: false,
    duplicate: false,
  });

  reg.registerStream({
    storedSessionId: 's1',
    liveSessionId: 'l1',
    messageId: 'm1',
    origin: 'remote',
    nowMs: 1000,
  });

  // text=null 或空串视为保活心跳
  assert.deepEqual(reg.acceptDelta('s1', { text: null }, 1100), {
    deltaToAppend: '',
    accepted: true,
    duplicate: false,
  });

  // 正常首片
  assert.deepEqual(reg.acceptDelta('s1', { turnId: 't1', segment: 0, offset: 0, text: 'Hello' }, 1200), {
    deltaToAppend: 'Hello',
    accepted: true,
    duplicate: false,
  });

  // 完全重复片必须丢弃
  assert.deepEqual(reg.acceptDelta('s1', { turnId: 't1', segment: 0, offset: 0, text: 'Hello' }, 1300), {
    deltaToAppend: '',
    accepted: false,
    duplicate: true,
  });

  // 部分重叠片必须只裁切增量后缀
  assert.deepEqual(reg.acceptDelta('s1', { turnId: 't1', segment: 0, offset: 3, text: 'lo World' }, 1400), {
    deltaToAppend: ' World',
    accepted: true,
    duplicate: false,
  });

  // 新 segment 从 offset=0 开始自动插入双换行分隔段落
  assert.deepEqual(reg.acceptDelta('s1', { turnId: 't1', segment: 1, offset: 0, text: 'Next' }, 1500), {
    deltaToAppend: '\n\nNext',
    accepted: true,
    duplicate: false,
  });

  // 迟到旧 segment 必须忽略
  assert.deepEqual(reg.acceptDelta('s1', { turnId: 't1', segment: 0, offset: 0, text: 'Stale' }, 1600), {
    deltaToAppend: '',
    accepted: false,
    duplicate: true,
  });

  // 切换 turnId 复位 segmentOffset 并接收（无 offset 分支）
  assert.deepEqual(reg.acceptDelta('s1', { turnId: 't2', segment: 0, text: '!' }, 1700), {
    deltaToAppend: '!',
    accepted: true,
    duplicate: false,
  });
  assert.equal(reg.getBySession('s1')?.accumulatedText, 'Hello World\n\nNext!');

  // re-enter 中途加入高 segment (offset > 0) 不得在半句话中间插 \n\n
  reg.registerStream({
    storedSessionId: 's2',
    liveSessionId: 'l2',
    messageId: 'm2',
    origin: 'remote',
    initialContent: 'Mid',
    turnId: 't1',
    nowMs: 2000,
  });
  reg.getBySession('s2').segment = 0;
  reg.getBySession('s2').segmentOffset = 0;
  const resumedSeg = reg.acceptDelta('s2', { turnId: 't1', segment: 1, offset: 3, text: 'Mid-tail' }, 2100);
  assert.equal(resumedSeg.deltaToAppend, 'Mid-tail');
});

test('LiveStreamRegistry.acceptInterim 与 reconcileInflightText: 阶段性正文补齐且不回退', () => {
  const reg = new LiveStreamRegistry();
  assert.deepEqual(reg.acceptInterim('missing', { text: 'x', alreadyStreamed: false }), {
    deltaToAppend: '',
    accepted: false,
  });
  assert.deepEqual(reg.reconcileInflightText('missing', 'abc'), { mode: 'noop', text: '' });

  reg.registerStream({
    storedSessionId: 's1',
    liveSessionId: 'l1',
    messageId: 'm1',
    origin: 'remote',
    nowMs: 1000,
  });
  reg.acceptDelta('s1', { turnId: 't1', segment: 1, offset: 0, text: 'Part 2' }, 1100);

  // 旧 segment interim 拒绝
  assert.deepEqual(reg.acceptInterim('s1', { turnId: 't1', segment: 0, text: 'Old', alreadyStreamed: false }), {
    deltaToAppend: '',
    accepted: false,
  });

  // alreadyStreamed 或已结尾匹配不再重复拼接
  assert.deepEqual(reg.acceptInterim('s1', { turnId: 't1', segment: 1, text: 'Part 2', alreadyStreamed: true }), {
    deltaToAppend: '',
    accepted: true,
  });
  assert.deepEqual(reg.acceptInterim('s1', { turnId: 't1', segment: 1, text: 'Part 2', alreadyStreamed: false }), {
    deltaToAppend: '',
    accepted: true,
  });

  // 未流式播出的 interim 追加并带段落间隔
  assert.deepEqual(reg.acceptInterim('s1', { turnId: 't1', segment: 2, text: 'Calling tool', alreadyStreamed: false }), {
    deltaToAppend: '\n\nCalling tool',
    accepted: true,
  });

  // reconcileInflightText 各路径
  assert.deepEqual(reg.reconcileInflightText('s1', reg.getBySession('s1').accumulatedText), {
    mode: 'noop',
    text: '',
  });
  assert.deepEqual(reg.reconcileInflightText('s1', 'Part'), { mode: 'noop', text: '' });
  assert.deepEqual(
    reg.reconcileInflightText('s1', `${reg.getBySession('s1').accumulatedText} + more`),
    { mode: 'append', text: ' + more' },
  );
  // 更长分叉文本触发 replace；更短分叉文本忽略
  assert.deepEqual(reg.reconcileInflightText('s1', 'Short'), { mode: 'noop', text: '' });
  const longerDiverged = 'A'.repeat(200);
  assert.deepEqual(reg.reconcileInflightText('s1', longerDiverged), {
    mode: 'replace',
    text: longerDiverged,
  });

  // 空流直接 replace
  reg.registerStream({ storedSessionId: 's-empty', liveSessionId: 'l-e', messageId: 'm-e', origin: 'remote' });
  assert.deepEqual(reg.reconcileInflightText('s-empty', 'Bootstrapped'), {
    mode: 'replace',
    text: 'Bootstrapped',
  });
});

test('extractResumeInflightState / decideWatchdogProbeAction / planRemoteUserPromptInsert 全分支校验', () => {
  assert.deepEqual(extractResumeInflightState(null), {
    isRunning: false,
    inflightUser: '',
    inflightAssistant: '',
  });

  const parsed = extractResumeInflightState({
    running: false,
    started_at: 1700000100,
    inflight: {
      streaming: true,
      user: 'hi agent',
      assistant: 'working...',
      display_kind: 'thinking',
      display_metadata: { step: 2 },
    },
    queued: { user: 'follow up' },
  });
  assert.equal(parsed.isRunning, true);
  assert.equal(parsed.turnStartedAtMs, 1700000100 * 1000);
  assert.equal(parsed.inflightUser, 'hi agent');
  assert.equal(parsed.inflightAssistant, 'working...');
  assert.equal(parsed.displayKind, 'thinking');
  assert.deepEqual(parsed.displayMetadata, { step: 2 });
  assert.equal(parsed.queuedUser, 'follow up');

  assert.equal(
    decideWatchdogProbeAction({
      reason: 'inactivity',
      isGatewayConnected: false,
      consecutiveProbeFailures: 1,
      maxProbeFailures: 2,
    }),
    'defer-offline',
  );
  assert.equal(
    decideWatchdogProbeAction({
      reason: 'inactivity',
      isGatewayConnected: false,
      consecutiveProbeFailures: 2,
      maxProbeFailures: 2,
    }),
    'settle-timeout',
  );
  assert.equal(
    decideWatchdogProbeAction({
      reason: 'inactivity',
      isGatewayConnected: true,
      probeError: true,
      consecutiveProbeFailures: 1,
    }),
    'renew',
  );
  assert.equal(
    decideWatchdogProbeAction({
      reason: 'inactivity',
      isGatewayConnected: true,
      probeError: true,
      consecutiveProbeFailures: 2,
    }),
    'settle-timeout',
  );

  // planRemoteUserPromptInsert: 跳过 hidden 行、按 rowId 去重并支持中间有助手行阻隔
  assert.equal(planRemoteUserPromptInsert([], { assistantMessageId: 'a1', userText: '   ' }), null);
  assert.equal(planRemoteUserPromptInsert([], { assistantMessageId: 'missing', userText: 'hi' }), null);
  assert.deepEqual(
    planRemoteUserPromptInsert(
      [
        { id: 'u1', role: 'user', content: 'same text' },
        { id: 'h1', role: 'system', content: 'meta', displayKind: 'hidden' },
        { id: 'a1', role: 'assistant', content: '' },
      ],
      { assistantMessageId: 'a1', userText: 'same text', userRowId: 88 },
    ),
    { kind: 'already-present', existingIndex: 0, bindRowId: 88 },
  );
  assert.deepEqual(
    planRemoteUserPromptInsert(
      [
        { id: 'u1', role: 'user', content: 'old question' },
        { id: 'a0', role: 'assistant', content: 'old answer' },
        { id: 'a1', role: 'assistant', content: '' },
      ],
      { assistantMessageId: 'a1', userText: 'new question' },
    ),
    { kind: 'insert-before', insertIndex: 2 },
  );
});

test('TokenCoalescer.dropMessage: 精确丢弃被对账覆盖的消息缓存，绝不污染其它会话队列', () => {
  const flushed = [];
  const coalescer = new TokenCoalescer((batch) => flushed.push(batch), { cadence: true });

  coalescer.push({ messageId: 'msg-reconcile', delta: '0123456789abcdef' });
  coalescer.push({ messageId: 'msg-other', delta: 'keep-me' });

  assert.equal(coalescer.dropMessage('msg-missing'), false);
  assert.equal(coalescer.dropMessage('msg-reconcile'), true);

  coalescer.flush();
  assert.equal(flushed.length, 1);
  assert.equal(flushed[0].has('msg-reconcile'), false, '已被丢弃的消息绝不得再次写入');
  assert.deepEqual(flushed[0].get('msg-other'), { content: 'keep-me', thought: '' });
});


test('TokenCoalescer.dropMessage 清空末条消息取消待调度帧 & 辅助纯函数剩余边界', () => {
  // 1. dropMessage 移除了最后一条消息导致 buffer.size === 0 时，必须取消 rAF 并阻止回调
  const origRaf = globalThis.requestAnimationFrame;
  const origCancel = globalThis.cancelAnimationFrame;
  let canceled = 0;
  globalThis.requestAnimationFrame = () => 777;
  globalThis.cancelAnimationFrame = (id) => {
    assert.equal(id, 777);
    canceled += 1;
  };
  try {
    const batches = [];
    const coalescer = new TokenCoalescer((b) => batches.push(b), { cadence: true });
    coalescer.push({ messageId: 'only-msg', delta: 'abcdef' });
    assert.equal(coalescer.dropMessage('only-msg'), true);
    assert.equal(canceled, 1, '移除末条缓冲消息必须立即 cancelAnimationFrame');
    coalescer.flush();
    assert.equal(batches.length, 0);
  } finally {
    globalThis.requestAnimationFrame = origRaf;
    globalThis.cancelAnimationFrame = origCancel;
  }

  // 2. extractResumeInflightState 毫秒时间戳直通与异常结构防御
  const msResume = extractResumeInflightState({
    running: true,
    turn_started_at: 1_700_000_000_456,
    inflight: { streaming: true, user: 123, assistant: null },
    queued: { user: 999 },
  });
  assert.equal(msResume.turnStartedAtMs, 1_700_000_000_456);
  assert.equal(msResume.inflightUser, '');
  assert.equal(msResume.inflightAssistant, '');
  assert.equal(msResume.queuedUser, undefined);

  // 3. decideWatchdogProbeAction hard-limit 与在线探活返回 running=true/false
  assert.equal(
    decideWatchdogProbeAction({ reason: 'hard-limit', isGatewayConnected: true }),
    'settle-timeout',
  );
  assert.equal(
    decideWatchdogProbeAction({ reason: 'inactivity', isGatewayConnected: true, probeResult: { isRunning: true } }),
    'renew',
  );
  assert.equal(
    decideWatchdogProbeAction({ reason: 'inactivity', isGatewayConnected: true, probeResult: { isRunning: false } }),
    'settle-completed',
  );
});

test('LiveStreamSync 变异消杀全边界：游标换行、注册 defaults、offset/interim/reconcile/extract/plan 精确守卫', () => {
  const reg = new LiveStreamRegistry();

  // 1. registerStream 默认值与同 session 同 messageId 重注册不误删自身
  const sDef = reg.registerStream({
    storedSessionId: 'sd',
    liveSessionId: 'ld',
    messageId: 'md',
    origin: 'local',
  });
  assert.equal(sDef.botName, null);
  assert.equal(sDef.turnId, null);
  assert.equal(sDef.startedAt, sDef.lastActivityAt);
  reg.registerStream({
    storedSessionId: 'sd',
    liveSessionId: 'ld-2',
    messageId: 'md',
    origin: 'local',
    nowMs: 5000,
  });
  assert.equal(reg.hasSession('sd'), true, '同 session 重注册同 messageId 不得自删');
  assert.equal(reg.removeSession('sd')?.messageId, 'md');
  assert.equal(reg.getSessionIdForMessage('md'), null, 'removeSession 必须清除反向映射');

  reg.registerStream({ storedSessionId: 'sc', liveSessionId: 'lc', messageId: 'mc', origin: 'local', nowMs: 10 });
  reg.clear();
  assert.equal(reg.getSessionIdForMessage('mc'), null, 'clear 必须清空反向映射');

  // 2. resolveIncomingTurnCursor + appendWithSegmentBoundary 全边界
  const st = reg.registerStream({
    storedSessionId: 's-cur',
    liveSessionId: 'l-cur',
    messageId: 'm-cur',
    origin: 'remote',
    turnId: 't1',
    nowMs: 100,
  });
  assert.deepEqual(reg.acceptDelta('s-cur', { text: '' }, 110), {
    deltaToAppend: '',
    accepted: true,
    duplicate: false,
  });
  // 空 turnId 不得覆盖已有 turnId，非有限/负 segment 不得触发 stale 或 new-segment
  reg.acceptDelta('s-cur', { turnId: 't1', segment: 1, offset: 0, text: 'Line1\n' }, 120);
  assert.equal(st.segment, 1);
  assert.equal(st.segmentOffset, 6);
  const badSegRes = reg.acceptDelta('s-cur', { turnId: '', segment: -1, offset: -5, text: 'A' }, 130);
  assert.equal(badSegRes.deltaToAppend, 'A');
  assert.equal(st.turnId, 't1');
  assert.equal(st.segment, 1);
  assert.equal(st.segmentOffset, 7);
  reg.acceptDelta('s-cur', { turnId: 't1', segment: Number.NaN, text: 'B' }, 140);
  assert.equal(st.segmentOffset, 8);
  // accumulated 末尾已有 \n 与 addition 开头有 \n 时不得再加 \n\n；高 segment offset=1 也不加
  const trailNl = reg.registerStream({
    storedSessionId: 's-nl',
    liveSessionId: 'l-nl',
    messageId: 'm-nl',
    origin: 'remote',
    turnId: 't1',
    initialContent: 'End\n',
  });
  assert.equal(
    reg.acceptDelta('s-nl', { turnId: 't1', segment: 1, offset: 0, text: 'NoGap' }).deltaToAppend,
    'NoGap',
  );
  assert.equal(
    reg.acceptDelta('s-nl', { turnId: 't1', segment: 2, offset: 0, text: '\nAlsoNoGap' }).deltaToAppend,
    '\nAlsoNoGap',
  );
  // turnId 切换且 rawSegment 分别为合法正整数 / 负整数
  reg.acceptDelta('s-nl', { turnId: 't2', segment: 3, offset: 0, text: 'T2' });
  assert.equal(trailNl.segment, 3);
  reg.acceptDelta('s-nl', { turnId: 't3', segment: -2, offset: 0, text: 'T3' });
  assert.equal(trailNl.segment, 0);
  assert.equal(trailNl.segmentOffset, 2);
  // offset=undefined/null 在 new-segment 触发 \n\n，offset=1 不触发
  assert.equal(reg.acceptDelta('s-nl', { turnId: 't3', segment: 1, text: 'NullOff' }).deltaToAppend, '\n\nNullOff');
  assert.equal(reg.acceptDelta('s-nl', { turnId: 't3', segment: 2, offset: 1, text: 'Off1' }).deltaToAppend, 'Off1');

  // 3. acceptInterim 空 text、segmentOffset 更新与 non-endsWith 场景
  reg.registerStream({ storedSessionId: 'si', liveSessionId: 'li', messageId: 'mi', origin: 'remote', initialContent: 'Alpha Beta' });
  const siStream = reg.getBySession('si');
  siStream.segmentOffset = 10;
  assert.deepEqual(reg.acceptInterim('si', { text: '', alreadyStreamed: false }), { deltaToAppend: '', accepted: true });
  assert.deepEqual(reg.acceptInterim('si', { segment: 0, text: 'Alpha', alreadyStreamed: false }), {
    deltaToAppend: '\n\nAlpha',
    accepted: true,
  });
  assert.equal(siStream.segmentOffset, 15);

  // 4. reconcileInflightText segmentOffset 累加与同长分叉拒绝回退
  assert.deepEqual(reg.reconcileInflightText('si', `${siStream.accumulatedText}++`), { mode: 'append', text: '++' });
  assert.equal(siStream.segmentOffset, 17);
  const eqDiverged = 'X'.repeat(siStream.accumulatedText.length);
  assert.deepEqual(reg.reconcileInflightText('si', eqDiverged), { mode: 'noop', text: '' });

  // 5. extractResumeInflightState 可选字段精确缺省、非对象拦截与数组拒绝
  const fnObj = Object.assign(() => {}, { running: true });
  assert.deepEqual(extractResumeInflightState(fnObj), { isRunning: false, inflightUser: '', inflightAssistant: '' });
  const emptyParsed = extractResumeInflightState({
    running: false,
    inflight: 'bad',
    queued: 'bad',
  });
  assert.equal('turnStartedAtMs' in emptyParsed, false);
  assert.equal('displayKind' in emptyParsed, false);
  assert.equal('displayMetadata' in emptyParsed, false);
  assert.equal('queuedUser' in emptyParsed, false);
  const badFields = extractResumeInflightState({
    running: false,
    inflight: { display_kind: '', display_metadata: ['arr'], user: '', assistant: '' },
    queued: { user: '' },
  });
  assert.equal('displayKind' in badFields, false);
  assert.equal('displayMetadata' in badFields, false);
  assert.equal('queuedUser' in badFields, false);

  // 6. decideWatchdogProbeAction 无 probeResult 回落 settle-completed，存在挂起交互卡时直接续期 renew
  assert.equal(
    decideWatchdogProbeAction({ reason: 'inactivity', isGatewayConnected: true, hasPendingInteractivePrompt: true }),
    'renew',
  );
  assert.equal(
    decideWatchdogProbeAction({ reason: 'inactivity', isGatewayConnected: true }),
    'settle-completed',
  );

  // 7. planRemoteUserPromptInsert 全条件防退化
  assert.deepEqual(
    planRemoteUserPromptInsert(
      [
        { id: 'u1', role: 'user', content: 'old question', rowId: 0 },
        { id: 'a0', role: 'assistant', content: 'sep' },
        { id: 'a1', role: 'assistant', content: '' },
      ],
      { assistantMessageId: 'a1', userText: 'old question', userRowId: 0 },
    ),
    { kind: 'insert-before', insertIndex: 2 },
  );
  assert.deepEqual(
    planRemoteUserPromptInsert(
      [
        { id: 'u1', role: 'user', content: '  spaced prompt  ' },
        { id: 'a1', role: 'assistant', content: '' },
      ],
      { assistantMessageId: 'a1', userText: ' spaced prompt ', userRowId: -1 },
    ),
    { kind: 'already-present', existingIndex: 0 },
  );
  assert.deepEqual(
    planRemoteUserPromptInsert(
      [
        { id: 'u1', role: 'user', content: 'other text', rowId: 77 },
        { id: 'a1', role: 'assistant', content: '' },
      ],
      { assistantMessageId: 'a1', userText: 'different prompt', userRowId: 77 },
    ),
    { kind: 'already-present', existingIndex: 0, bindRowId: 77 },
  );
  assert.deepEqual(
    planRemoteUserPromptInsert(
      [
        { id: 'u1', role: 'user', content: 'other text', rowId: 12 },
        { id: 'a1', role: 'assistant', content: '' },
      ],
      { assistantMessageId: 'a1', userText: 'fresh text', userRowId: 99 },
    ),
    { kind: 'insert-before', insertIndex: 1 },
  );
  assert.deepEqual(
    planRemoteUserPromptInsert(
      [
        { id: 'u1', role: 'user', content: 'other text' },
        { id: 'a1', role: 'assistant', content: '' },
      ],
      { assistantMessageId: 'a1', userText: 'fresh text', userRowId: 1.5 },
    ),
    { kind: 'insert-before', insertIndex: 1 },
  );
});
