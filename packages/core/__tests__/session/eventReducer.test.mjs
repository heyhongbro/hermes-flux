import test from 'node:test';
import assert from 'node:assert/strict';
import { reduceGatewayEvent } from '../../dist/session/eventReducer.js';

const CTX = {
  activeSessionIds: ['live-42', '20261028_155631_8bcc62'],
  activeStreamingMessageId: 'ast-1',
};

test('Gateway event reducer - turn lifecycle', async (t) => {
  await t.test('message.complete terminates the turn, rewrites the final text and refreshes the rail', () => {
    // 1. Arrange
    const frame = {
      type: 'message.complete',
      session_id: 'live-42',
      payload: { text: '最终答复', usage: { total: 18 }, status: 'complete' },
    };

    // 2. Act
    const actions = reduceGatewayEvent(frame, CTX);

    // 3. Assert: the composer must be unlocked by this exact frame
    assert.deepEqual(
      actions.map((a) => a.type),
      ['replace-content', 'turn-completed', 'refresh-sessions'],
      'message.complete must replace content, unlock the turn and refresh sessions'
    );
    const replaced = actions.find((a) => a.type === 'replace-content');
    assert.equal(replaced.messageId, 'ast-1', 'Final text must target the streaming assistant message');
    assert.equal(replaced.text, '最终答复', 'Completion text is authoritative over coalesced deltas');
    const completed = actions.find((a) => a.type === 'turn-completed');
    assert.equal(completed.finalText, '最终答复', 'turn-completed must carry the final text');
    assert.equal(completed.sessionId, 'live-42', 'turn-completed must carry the frame session id');
  });

  await t.test('legacy session.idle / agent.turn_end frames are NOT turn terminators', () => {
    // 1. Arrange: the two event names the previous renderer relied on
    const legacyIdle = { type: 'session.idle', session_id: 'live-42', payload: {} };
    const legacyTurnEnd = { type: 'agent.turn_end', session_id: 'live-42', payload: {} };

    // 2. Act
    const idleActions = reduceGatewayEvent(legacyIdle, CTX);
    const turnEndActions = reduceGatewayEvent(legacyTurnEnd, CTX);

    // 3. Assert: neither is implemented by the gateway, so neither may unlock anything
    assert.deepEqual(idleActions, [], 'session.idle is not part of the gateway contract');
    assert.deepEqual(turnEndActions, [], 'agent.turn_end is not part of the gateway contract');
  });

  await t.test('message.complete without text unlocks the turn but keeps streamed deltas', () => {
    // 1. Arrange
    const frame = { type: 'message.complete', session_id: 'live-42', payload: { text: '', status: 'complete' } };

    // 2. Act
    const actions = reduceGatewayEvent(frame, CTX);

    // 3. Assert
    assert.deepEqual(actions.map((a) => a.type), ['turn-completed', 'refresh-sessions']);
    assert.equal(actions[0].finalText, undefined, 'Empty completion text must not overwrite the stream');
    assert.equal(actions[0].sessionId, 'live-42', 'turn-completed must carry the frame session id even without text');
  });

  await t.test('message.start re-arms the busy state', () => {
    // 1. Arrange
    const frame = { type: 'message.start', session_id: 'live-42', payload: {} };

    // 2. Act
    const actions = reduceGatewayEvent(frame, CTX);

    // 3. Assert
    assert.deepEqual(actions, [{ type: 'turn-started' }]);
  });
});

test('Gateway event reducer - session isolation and global broadcasts', async (t) => {
  await t.test('deltas of another conversation never leak into the focused one', () => {
    // 1. Arrange
    const foreign = { type: 'message.delta', session_id: 'other-session', payload: { text: 'leak' } };

    // 2. Act
    const actions = reduceGatewayEvent(foreign, CTX);

    // 3. Assert
    assert.deepEqual(actions, [], 'A foreign session stream must be discarded');
  });

  await t.test('the stored id of the focused conversation is accepted as an alias', () => {
    // 1. Arrange
    const aliased = { type: 'message.delta', session_id: '20261028_155631_8bcc62', payload: { text: 'hi' } };

    // 2. Act
    const actions = reduceGatewayEvent(aliased, CTX);

    // 3. Assert
    assert.deepEqual(actions, [{ type: 'append-content', messageId: 'ast-1', text: 'hi' }]);
  });

  await t.test('sessions.changed refreshes the rail even when no conversation is focused', () => {
    // 1. Arrange
    const emptyCtx = { activeSessionIds: [], activeStreamingMessageId: null };

    // 2. Act
    const actions = reduceGatewayEvent({ type: 'sessions.changed', payload: {} }, emptyCtx);

    // 3. Assert
    assert.deepEqual(actions, [{ type: 'refresh-sessions' }], 'sessions.changed is the rail refresh trigger');
  });

  await t.test('session.title carries the new title for the rail', () => {
    // 1. Arrange
    const frame = { type: 'session.title', session_id: 'live-42', payload: { session_id: 'live-42', title: '  修复右侧栏  ' } };

    // 2. Act
    const actions = reduceGatewayEvent(frame, CTX);

    // 3. Assert
    assert.deepEqual(actions, [{ type: 'session-title', sessionId: 'live-42', title: '修复右侧栏' }]);
  });

  await t.test('session.title with a blank title is dropped instead of blanking the rail', () => {
    // 1. Arrange
    const frame = { type: 'session.title', session_id: 'live-42', payload: { title: '   ' } };

    // 2. Act & Assert
    assert.deepEqual(reduceGatewayEvent(frame, CTX), []);
  });
});

test('Gateway event reducer - negative and boundary inputs', async (t) => {
  await t.test('malformed frames yield no actions', () => {
    // 1. Arrange
    const samples = [null, undefined, 'event', 42, {}, { type: '' }, { payload: { text: 'x' } }];

    // 2. Act & Assert
    for (const sample of samples) {
      assert.deepEqual(reduceGatewayEvent(sample, CTX), [], `Frame ${JSON.stringify(sample)} must be ignored`);
    }
  });

  await t.test('a delta with no open assistant message is dropped', () => {
    // 1. Arrange
    const idleCtx = { activeSessionIds: ['live-42'], activeStreamingMessageId: null };

    // 2. Act
    const actions = reduceGatewayEvent({ type: 'message.delta', session_id: 'live-42', payload: { text: 'x' } }, idleCtx);

    // 3. Assert
    assert.deepEqual(actions, [], 'Deltas cannot be attached without an open message');
  });

  await t.test('error frames surface the gateway message and unlock the turn', () => {
    // 1. Arrange
    const frame = { type: 'error', payload: { message: 'gateway overloaded' } };

    // 2. Act
    const actions = reduceGatewayEvent(frame, CTX);

    // 3. Assert: Failure Is Not Empty — the reason must reach the user
    assert.deepEqual(actions, [{ type: 'turn-failed', message: 'gateway overloaded' }]);
  });

  await t.test('reasoning.delta and thinking.delta both feed the thought channel', () => {
    // 1. Arrange
    const modern = { type: 'reasoning.delta', session_id: 'live-42', payload: { text: '思考' } };
    const legacy = { type: 'thinking.delta', session_id: 'live-42', payload: { text: '思考' } };

    // 2. Act & Assert
    assert.deepEqual(reduceGatewayEvent(modern, CTX), [{ type: 'append-thought', messageId: 'ast-1', text: '思考' }]);
    assert.deepEqual(reduceGatewayEvent(legacy, CTX), [{ type: 'append-thought', messageId: 'ast-1', text: '思考' }]);
  });
});

test('Gateway event reducer - subagent delegation events', async (t) => {
  const CTX = {
    activeSessionIds: ['live-42'],
    activeStreamingMessageId: 'ast-1',
  };

  await t.test('subagent.spawn_requested produces structured subagent-spawn action', () => {
    const frame = {
      type: 'subagent.spawn_requested',
      session_id: 'live-42',
      payload: {
        subagent_id: 'sub-888',
        target_profile: 'arch-wang',
        task_title: '推演架构死锁',
      },
    };

    const actions = reduceGatewayEvent(frame, CTX);
    assert.equal(actions.length, 1);
    assert.deepEqual(actions[0], {
      type: 'subagent-spawn',
      subagentId: 'sub-888',
      profile: 'arch-wang',
      title: '推演架构死锁',
      parentSessionId: 'live-42',
      messageId: 'ast-1',
    });
  });

  await t.test('subagent.progress produces subagent-update and subagent-progress with sessionId', () => {
    const frame = {
      type: 'subagent.progress',
      session_id: 'live-42',
      payload: {
        subagent_id: 'sub-888',
        progress: 45,
        action: '正在分析 call stack',
      },
    };

    const actions = reduceGatewayEvent(frame, CTX);
    const update = actions.find((a) => a.type === 'subagent-update');
    const prog = actions.find((a) => a.type === 'subagent-progress');
    assert.ok(update, 'must emit subagent-update');
    assert.equal(update.subagentId, 'sub-888');
    assert.equal(update.sessionId, 'live-42');
    assert.equal(update.lifecycleStatus, 'running');
    assert.equal(update.phaseHint, 'progress');
    assert.deepEqual(prog, {
      type: 'subagent-progress',
      subagentId: 'sub-888',
      sessionId: 'live-42',
      progressPercent: 45,
      actionText: '正在分析 call stack',
    });
  });

  await t.test('subagent.log carries stdout and stderr with seq and normalized ms timestamp', () => {
    const frame = {
      type: 'subagent.log',
      session_id: 'live-42',
      payload: {
        subagent_id: 'sub-888',
        seq: 10,
        timestamp: 1000,
        text: 'build completed with 0 errors',
      },
    };

    const actions = reduceGatewayEvent(frame, CTX);
    assert.equal(actions.length, 1);
    assert.deepEqual(actions[0], {
      type: 'subagent-log',
      subagentId: 'sub-888',
      sessionId: 'live-42',
      entry: {
        seq: 10,
        timestamp: 1000000,
        kind: 'stdout',
        text: 'build completed with 0 errors',
      },
    });
  });

  await t.test('subagent.complete terminates subagent task WITHOUT polluting parent tool-complete', () => {
    const frame = {
      type: 'subagent.complete',
      session_id: 'live-42',
      payload: {
        subagent_id: 'sub-888',
        tool_call_id: 'call-1',
        output: '方案无死锁风险',
      },
    };

    const actions = reduceGatewayEvent(frame, CTX);
    assert.ok(actions.some((a) => a.type === 'subagent-update' && a.subagentId === 'sub-888' && a.lifecycleStatus === 'completed'));
    assert.ok(actions.some((a) => a.type === 'subagent-complete' && a.subagentId === 'sub-888' && a.sessionId === 'live-42'));
    assert.ok(actions.some((a) => a.type === 'subagent-log' && a.subagentId === 'sub-888'));
    assert.equal(
      actions.some((a) => a.type === 'tool-complete' || a.type === 'tool-start'),
      false,
      'subagent.complete 严禁发射父会话 tool-complete / tool-start'
    );
  });

  await t.test('subagent.tool consumes canonical tool_name/tool_preview and never emits parent tool-start', () => {
    const frame = {
      type: 'subagent.tool',
      session_id: 'live-42',
      payload: {
        delegation_id: 'deleg-canon',
        task_index: 1,
        goal: '审查配置权限',
        tool_name: 'read_file',
        tool_preview: 'packages/core/src/index.ts (L1-40)',
        tool_count: 3,
        files_read: ['packages/core/src/index.ts'],
      },
    };

    const actions = reduceGatewayEvent(frame, CTX);
    const update = actions.find((a) => a.type === 'subagent-update');
    const logEntry = actions.find((a) => a.type === 'subagent-log');
    assert.ok(update, 'must emit subagent-update');
    assert.equal(update.subagentId, 'deleg:deleg-canon:1');
    assert.equal(update.phaseHint, 'tool');
    assert.equal(update.toolName, 'read_file');
    assert.equal(update.toolPreview, 'packages/core/src/index.ts (L1-40)');
    assert.equal(update.toolCount, 3);
    assert.deepEqual(update.filesRead, ['packages/core/src/index.ts']);
    assert.ok(logEntry && logEntry.entry.text.includes('read_file'));
    assert.equal(actions.some((a) => a.type === 'tool-start' || a.type === 'tool-complete'), false);
  });

  await t.test('canonical subagent.spawn_requested without explicit subagent_id synthesizes deleg key', () => {
    const actions = reduceGatewayEvent(
      {
        type: 'subagent.spawn_requested',
        session_id: 'live-42',
        payload: {
          delegation_id: 'deleg-2',
          task_index: 0,
          goal: '检索状态机定义',
          model: 'claude-sonnet',
        },
      },
      CTX
    );
    assert.equal(actions.length, 1);
    assert.equal(actions[0].type, 'subagent-update');
    assert.equal(actions[0].subagentId, 'deleg:deleg-2:0');
    assert.equal(actions[0].lifecycleStatus, 'queued');
    assert.equal(actions[0].phaseHint, 'queued');
    assert.equal(actions[0].model, 'claude-sonnet');
  });

  await t.test('background session subagent.*/session.info/session.usage bypass focus filter; empty session dropped', () => {
    const bgSub = reduceGatewayEvent(
      {
        type: 'subagent.thinking',
        session_id: 'bg-session-99',
        payload: { subagent_id: 'sub-bg-1', text: '分析中' },
      },
      CTX
    );
    assert.ok(bgSub.some((a) => a.type === 'subagent-update' && a.sessionId === 'bg-session-99'));

    const bgInfo = reduceGatewayEvent(
      {
        type: 'session.info',
        session_id: 'bg-session-99',
        payload: { cwd: '/repo/demo', branch: 'main', model: 'gpt-5' },
      },
      CTX
    );
    assert.equal(bgInfo.length, 1);
    assert.equal(bgInfo[0].type, 'session-info');
    assert.equal(bgInfo[0].sessionId, 'bg-session-99');
    assert.equal(bgInfo[0].info.cwd, '/repo/demo');

    const bgUsage = reduceGatewayEvent(
      {
        type: 'session.usage',
        session_id: 'bg-session-99',
        payload: { usage: { input: 100, output: 50, context_used: 1200, context_max: 200000 } },
      },
      CTX
    );
    assert.equal(bgUsage.length, 1);
    assert.equal(bgUsage[0].type, 'session-usage');
    assert.equal(bgUsage[0].sessionId, 'bg-session-99');

    // Empty session_id must be dropped cleanly
    assert.deepEqual(reduceGatewayEvent({ type: 'session.info', session_id: '', payload: { cwd: '/x' } }, CTX), []);
    assert.deepEqual(reduceGatewayEvent({ type: 'session.usage', payload: { input_tokens: 1 } }, CTX), []);
    assert.deepEqual(reduceGatewayEvent({ type: 'subagent.start', payload: { subagent_id: 's1' } }, CTX), []);
  });

  await t.test('tool.end, tool.error 与复杂对象 output 格式化', () => {
    // 1. tool.end 支持且对象 output 自动 JSON.stringify 格式化
    const endFrame = {
      type: 'tool.end',
      session_id: 'live-42',
      payload: {
        id: 'tc-end-1',
        output: { status: 'success', linesModified: 42 },
      },
    };
    const endActions = reduceGatewayEvent(endFrame, CTX);
    assert.equal(endActions.length, 1);
    assert.equal(endActions[0].type, 'tool-complete');
    assert.equal(endActions[0].toolCallId, 'tc-end-1');
    assert.ok(endActions[0].output?.includes('"status": "success"'));
    assert.ok(endActions[0].output?.includes('"linesModified": 42'));

    // 2. tool.error 支持且从 error 字段安全取值
    const errFrame = {
      type: 'tool.error',
      session_id: 'live-42',
      payload: {
        id: 'tc-err-1',
        error: { code: -32000, message: 'Command timed out' },
      },
    };
    const errActions = reduceGatewayEvent(errFrame, CTX);
    assert.equal(errActions.length, 1);
    assert.equal(errActions[0].type, 'tool-complete');
    assert.equal(errActions[0].toolCallId, 'tc-err-1');
    assert.ok(errActions[0].output?.includes('Command timed out'));

    // 3. tool.complete 携带 image_path 与 inline_diff 时完整透传 imagePath 与 inlineDiff
    const imgFrame = {
      type: 'tool.complete',
      session_id: 'live-42',
      payload: {
        tool_id: 'tc-img-1',
        result_text: 'rendered',
        image_path: '/out/shot.png',
        inline_diff: '@@ -1 +1 @@\n-old\n+new',
      },
    };
    const imgActions = reduceGatewayEvent(imgFrame, CTX);
    assert.equal(imgActions.length, 1);
    assert.equal(imgActions[0].type, 'tool-complete');
    assert.equal(imgActions[0].toolCallId, 'tc-img-1');
    assert.equal(imgActions[0].imagePath, '/out/shot.png');
    assert.equal(imgActions[0].inlineDiff, '@@ -1 +1 @@\n-old\n+new');
  });
});

test('Gateway event contract guard - 事件 payload 必须落在契约白名单内', async (t) => {
  const { addLogSink, clearLogSinks, setLogLevel } = await import('../../dist/log/logger.js');
  const { resetEventContractReports } = await import('../../dist/session/eventReducer.js');

  function captureLogs(tt) {
    const records = [];
    const previous = setLogLevel('debug');
    clearLogSinks();
    addLogSink((r) => records.push(r), 'trace');
    tt.after(() => {
      clearLogSinks();
      setLogLevel(previous);
      resetEventContractReports();
    });
    return records;
  }

  await t.test('契约内的 payload 字段不产生告警', (tt) => {
    const records = captureLogs(tt);
    // message.delta 的契约字段是 text / rendered / verbose
    const actions = reduceGatewayEvent(
      { type: 'message.delta', session_id: 'live-42', payload: { text: '你好' } },
      CTX
    );
    assert.equal(actions.length, 1);
    assert.equal(actions[0].type, 'append-content');
    assert.equal(records.filter((r) => r.level === 'warn').length, 0, '合法字段不得告警');
  });

  await t.test('payload 出现契约外字段必须告警，但不中断事件流', (tt) => {
    const records = captureLogs(tt);
    const actions = reduceGatewayEvent(
      {
        type: 'message.delta',
        session_id: 'live-42',
        payload: { text: '你好', delta: '网关改名后的字段' },
      },
      CTX
    );

    // 行为不变：仍然按 text 解析
    assert.equal(actions.length, 1);
    assert.equal(actions[0].type, 'append-content');

    const warn = records.find((r) => r.level === 'warn' && r.message.includes('outside the gateway contract'));
    assert.ok(warn, '必须留下字段漂移的告警');
    assert.equal(warn.data.type, 'message.delta');
    assert.deepEqual(warn.data.unknownFields, ['delta']);
    assert.ok(warn.data.allowedFields.includes('text'));
  });

  await t.test('同一偏差只上报一次，避免高频事件刷爆日志', (tt) => {
    const records = captureLogs(tt);
    for (let i = 0; i < 5; i += 1) {
      reduceGatewayEvent(
        { type: 'message.delta', session_id: 'live-42', payload: { text: 'x', delta: 'y' } },
        CTX
      );
    }
    const warns = records.filter((r) => r.level === 'warn' && r.message.includes('outside the gateway contract'));
    assert.equal(warns.length, 1, `同一偏差只应上报一次，实际 ${warns.length} 次`);
  });

  await t.test('契约外的事件名只记 debug，不报错也不产生动作', (tt) => {
    const records = captureLogs(tt);
    const actions = reduceGatewayEvent(
      { type: 'brand.new.event', session_id: 'live-42', payload: { anything: 1 } },
      CTX
    );
    assert.deepEqual(actions, []);
    assert.equal(records.filter((r) => r.level === 'warn').length, 0, '未知事件不得告警');
    assert.ok(records.some((r) => r.level === 'debug' && r.message.includes('not in gateway contract')));
  });
});


test('reduceGatewayEvent: 覆盖 session.reclaimed、message.interim、流式保活与分段游标字段', () => {
  const ctx = {
    activeSessionIds: ['sess-1', 'live-1'],
    activeStreamingMessageId: 'ast-1',
  };

  // 1. session.reclaimed 全局广播不受 activeSessionIds 过滤影响
  assert.deepEqual(
    reduceGatewayEvent(
      {
        type: 'session.reclaimed',
        session_id: 'live-bg',
        payload: { stored_session_id: 'sess-bg', reason: 'idle_ttl' },
      },
      ctx,
    ),
    [{
      type: 'session-reclaimed',
      sessionId: 'live-bg',
      storedSessionId: 'sess-bg',
      reason: 'idle_ttl',
    }],
  );

  // 2. message.start 携带 turn_id 与提示词文本时向观察端透传
  assert.deepEqual(
    reduceGatewayEvent(
      {
        type: 'message.start',
        session_id: 'live-1',
        payload: { turn_id: 'turn-9', text: 'raw', display_text: 'shown' },
      },
      ctx,
    ),
    [{
      type: 'turn-started',
      turnId: 'turn-9',
      text: 'raw',
      displayText: 'shown',
    }],
  );

  // 3. message.delta 携带分段与偏移；text=null 退化为 stream-activity 保活
  assert.deepEqual(
    reduceGatewayEvent(
      {
        type: 'message.delta',
        session_id: 'live-1',
        payload: { turn_id: 'turn-9', segment: 1, offset: 4, text: 'hello' },
      },
      ctx,
    ),
    [{
      type: 'append-content',
      messageId: 'ast-1',
      text: 'hello',
      turnId: 'turn-9',
      segment: 1,
      offset: 4,
    }],
  );

  assert.deepEqual(
    reduceGatewayEvent(
      {
        type: 'message.delta',
        session_id: 'live-1',
        payload: { text: null },
      },
      ctx,
    ),
    [{ type: 'stream-activity', sessionId: 'live-1', eventType: 'message.delta' }],
  );

  // 4. message.interim 与多种工具/推理保活事件
  assert.deepEqual(
    reduceGatewayEvent(
      {
        type: 'message.interim',
        session_id: 'live-1',
        payload: { text: 'step 1', already_streamed: false, turn_id: 'turn-9', segment: 0 },
      },
      ctx,
    ),
    [{
      type: 'interim-content',
      messageId: 'ast-1',
      text: 'step 1',
      alreadyStreamed: false,
      turnId: 'turn-9',
      segment: 0,
    }],
  );

  for (const evtType of [
    'tool.progress',
    'tool.generating',
    'status.update',
    'reasoning.available',
    'agent.terminal.output',
    'browser.progress',
    'moa.phase',
  ]) {
    assert.deepEqual(
      reduceGatewayEvent({ type: evtType, session_id: 'live-1', payload: {} }, ctx),
      [{ type: 'stream-activity', sessionId: 'live-1', eventType: evtType }],
    );
  }

  // 5. tool.complete 将服务端 duration_s 折算为毫秒
  const toolDone = reduceGatewayEvent(
    {
      type: 'tool.complete',
      session_id: 'live-1',
      payload: { tool_id: 'tc-1', output: 'ok', duration_s: 2.345 },
    },
    ctx,
  );
  assert.deepEqual(toolDone, [{
    type: 'tool-complete',
    messageId: 'ast-1',
    toolCallId: 'tc-1',
    output: 'ok',
    durationMs: 2345,
  }]);
});

test('reduceGatewayEvent: activeSessionIds 为空数组（如群聊焦点或未激活列表）时严禁放行带 session_id 的回合事件', () => {
  const emptyCtx = { activeSessionIds: [], activeStreamingMessageId: null };
  assert.deepEqual(
    reduceGatewayEvent({ type: 'message.start', session_id: 'stray-sess', payload: { text: 'leak' } }, emptyCtx),
    [],
  );
  assert.deepEqual(
    reduceGatewayEvent({ type: 'message.delta', session_id: 'stray-sess', payload: { text: 'leak' } }, emptyCtx),
    [],
  );
  assert.deepEqual(
    reduceGatewayEvent({ type: 'message.complete', session_id: 'stray-sess', payload: { text: 'done' } }, emptyCtx),
    [],
  );
});


test('reduceGatewayEvent: 缺省/边界字段组合覆盖 (turn-started / delta / interim / tool.complete)', () => {
  const ctx = {
    activeSessionIds: ['sess-1', 'live-1'],
    activeStreamingMessageId: 'ast-1',
  };
  const emptyMsgCtx = {
    activeSessionIds: ['sess-1', 'live-1'],
    activeStreamingMessageId: null,
  };

  // message.start 无元信息 / 仅 text / 仅 display_text 兜底
  assert.deepEqual(
    reduceGatewayEvent({ type: 'message.start', session_id: 'live-1', payload: {} }, ctx),
    [{ type: 'turn-started' }],
  );
  assert.deepEqual(
    reduceGatewayEvent({ type: 'message.start', session_id: 'live-1', payload: { text: 'r-txt' } }, ctx),
    [{ type: 'turn-started', text: 'r-txt' }],
  );
  assert.deepEqual(
    reduceGatewayEvent({ type: 'message.start', session_id: 'live-1', payload: { display_text: 'd-txt' } }, ctx),
    [{ type: 'turn-started', displayText: 'd-txt' }],
  );

  // message.delta 无分段偏移 / 非法非空 text
  assert.deepEqual(
    reduceGatewayEvent({ type: 'message.delta', session_id: 'live-1', payload: { text: 'plain' } }, ctx),
    [{ type: 'append-content', messageId: 'ast-1', text: 'plain' }],
  );
  assert.deepEqual(
    reduceGatewayEvent({ type: 'message.delta', session_id: 'live-1', payload: { text: 123 } }, ctx),
    [],
  );

  // message.interim 非字符串 text 归一为空串透传 & 无 turnId/segment 透传 & already_streamed=true
  assert.deepEqual(
    reduceGatewayEvent({ type: 'message.interim', session_id: 'live-1', payload: { text: null } }, ctx),
    [{ type: 'interim-content', messageId: 'ast-1', text: '', alreadyStreamed: false }],
  );
  assert.deepEqual(
    reduceGatewayEvent(
      { type: 'message.interim', session_id: 'live-1', payload: { text: 'step', already_streamed: true } },
      emptyMsgCtx,
    ),
    [{ type: 'stream-activity', sessionId: 'live-1', eventType: 'message.interim' }],
  );

  // tool.complete 缺省 duration_s 时省略 durationMs 字段而不产出 NaN
  assert.deepEqual(
    reduceGatewayEvent(
      { type: 'tool.complete', session_id: 'live-1', payload: { tool_id: 'tc-2', output: 'ok' } },
      ctx,
    ),
    [{ type: 'tool-complete', messageId: 'ast-1', toolCallId: 'tc-2', output: 'ok' }],
  );

  // 保活分支全路径覆盖：frameSessionId 为空时回落 ctx.activeSessionIds[0]，双方均为空则静默丢弃
  const fallbackOnlyCtx = { activeSessionIds: ['sess-fb'], activeStreamingMessageId: null };
  const noSessionCtx = { activeSessionIds: [], activeStreamingMessageId: null };

  assert.deepEqual(
    reduceGatewayEvent({ type: 'message.delta', payload: { text: null } }, fallbackOnlyCtx),
    [{ type: 'stream-activity', sessionId: 'sess-fb', eventType: 'message.delta' }],
  );
  assert.deepEqual(
    reduceGatewayEvent({ type: 'message.delta', payload: { text: null } }, noSessionCtx),
    [],
  );

  assert.deepEqual(
    reduceGatewayEvent({ type: 'message.interim', payload: { text: 'step' } }, fallbackOnlyCtx),
    [{ type: 'stream-activity', sessionId: 'sess-fb', eventType: 'message.interim' }],
  );
  assert.deepEqual(
    reduceGatewayEvent({ type: 'message.interim', payload: { text: 'step' } }, noSessionCtx),
    [],
  );

  assert.deepEqual(
    reduceGatewayEvent({ type: 'tool.generating', session_id: 'live-1', payload: {} }, {
      activeSessionIds: ['live-1'],
      activeStreamingMessageId: null,
    }),
    [{ type: 'stream-activity', sessionId: 'live-1', eventType: 'tool.generating' }],
  );
  assert.deepEqual(
    reduceGatewayEvent({ type: 'tool.progress', payload: {} }, fallbackOnlyCtx),
    [{ type: 'stream-activity', sessionId: 'sess-fb', eventType: 'tool.progress' }],
  );
  assert.deepEqual(
    reduceGatewayEvent({ type: 'status.update', payload: {} }, noSessionCtx),
    [],
  );
});

test('reduceGatewayEvent 变异消杀全边界：side-agent/tool.start/tool.complete/error/reclaimed/display_kind/moa', () => {
  const ctx = { activeSessionIds: ['live-1'], activeStreamingMessageId: 'ast-1' };
  const emptyMsgCtx = { activeSessionIds: ['live-1'], activeStreamingMessageId: null };

  // 1. session.reclaimed 空 ID 严格返回 [] (L405)
  assert.deepEqual(reduceGatewayEvent({ type: 'session.reclaimed', payload: {} }, ctx), []);

  // 2. error 缺省 message 返回中文默认错误提示 (L415)
  assert.deepEqual(
    reduceGatewayEvent({ type: 'error', session_id: 'live-1', payload: {} }, ctx),
    [{ type: 'turn-failed', message: '网关返回了未标注内容的系统错误', sessionId: 'live-1' }],
  );

  // 3. message.start with vs without display_kind (L586, L592)
  assert.deepEqual(
    reduceGatewayEvent({ type: 'message.start', session_id: 'live-1', payload: { display_kind: 'thinking' } }, ctx),
    [{ type: 'turn-started', displayKind: 'thinking' }],
  );
  assert.deepEqual(
    reduceGatewayEvent({ type: 'message.start', session_id: 'live-1', payload: { display_kind: '' } }, ctx),
    [{ type: 'turn-started' }],
  );

  // 4. btw.complete / background.complete (L596-606)
  assert.deepEqual(reduceGatewayEvent({ type: 'btw.complete', payload: {} }, ctx), []);
  assert.deepEqual(
    reduceGatewayEvent({ type: 'btw.complete', payload: { task_id: 't-b', text: 'ans-b' } }, ctx),
    [{ type: 'side-agent-complete', channel: 'btw', taskId: 't-b', text: 'ans-b' }],
  );
  assert.deepEqual(
    reduceGatewayEvent({ type: 'background.complete', payload: { task_id: 't-bg', text: 'ans-bg' } }, ctx),
    [{ type: 'side-agent-complete', channel: 'background', taskId: 't-bg', text: 'ans-bg' }],
  );

  // 5. thinking.delta / reasoning.delta 空 text / 无 messageId 拒绝与正常透传 (L650)
  assert.deepEqual(reduceGatewayEvent({ type: 'thinking.delta', session_id: 'live-1', payload: { text: '' } }, ctx), []);
  assert.deepEqual(reduceGatewayEvent({ type: 'thinking.delta', session_id: 'live-1', payload: { text: 'th' } }, emptyMsgCtx), []);
  assert.deepEqual(
    reduceGatewayEvent({ type: 'reasoning.delta', session_id: 'live-1', payload: { text: 're' } }, ctx),
    [{ type: 'append-thought', messageId: 'ast-1', text: 're' }],
  );

  // 6. moa.* 事件保活透传 (L661-665)
  for (const evt of ['moa.phase', 'moa.progress', 'moa.reference']) {
    assert.deepEqual(
      reduceGatewayEvent({ type: evt, session_id: 'live-1', payload: {} }, ctx),
      [{ type: 'stream-activity', sessionId: 'live-1', eventType: evt }],
    );
  }

  // 7. tool.start 全主/备键降级与空 messageId 忽略 (L668-685)
  assert.deepEqual(reduceGatewayEvent({ type: 'tool.start', session_id: 'live-1', payload: {} }, emptyMsgCtx), []);
  const sByToolId = reduceGatewayEvent(
    { type: 'tool.start', session_id: 'live-1', payload: { tool_id: 'tid-1', name: 'bash', args: '{"cmd":"ls"}' } },
    ctx,
  );
  assert.deepEqual(sByToolId, [{ type: 'tool-start', messageId: 'ast-1', toolCall: { id: 'tid-1', name: 'bash', args: '{"cmd":"ls"}' } }]);
  const sById = reduceGatewayEvent(
    { type: 'tool.start', session_id: 'live-1', payload: { id: 'tid-2', tool: 'read', arguments: 'raw-args' } },
    ctx,
  );
  assert.deepEqual(sById, [{ type: 'tool-start', messageId: 'ast-1', toolCall: { id: 'tid-2', name: 'read', args: 'raw-args' } }]);
  const sByCallId = reduceGatewayEvent(
    { type: 'tool.start', session_id: 'live-1', payload: { tool_call_id: 'tid-3', args: { k: 1 } } },
    ctx,
  );
  assert.deepEqual(sByCallId, [{ type: 'tool-start', messageId: 'ast-1', toolCall: { id: 'tid-3', name: '工具执行', args: '{"k":1}' } }]);
  const sByParams = reduceGatewayEvent(
    { type: 'tool.start', session_id: 'live-1', payload: { parameters: { p: 2 } } },
    ctx,
  );
  assert.match(sByParams[0].toolCall.id, /^tool-\d+$/);
  assert.equal(sByParams[0].toolCall.args, '{"p":2}');
  const sByInput = reduceGatewayEvent(
    { type: 'tool.start', session_id: 'live-1', payload: { input: { i: 3 } } },
    ctx,
  );
  assert.equal(sByInput[0].toolCall.args, '{"i":3}');
  const sEmptyArgs = reduceGatewayEvent({ type: 'tool.start', session_id: 'live-1', payload: {} }, ctx);
  assert.equal(sEmptyArgs[0].toolCall.args, '{}');

  // 8. tool.complete / tool.end / tool.error 耗时 duration_s=0 / <0 / 缺 messageId (L692-705)
  assert.deepEqual(
    reduceGatewayEvent({ type: 'tool.complete', session_id: 'live-1', payload: { duration_s: 0 } }, ctx),
    [{ type: 'tool-complete', messageId: 'ast-1', toolCallId: '', output: undefined, durationMs: 0 }],
  );
  assert.deepEqual(
    reduceGatewayEvent({ type: 'tool.end', session_id: 'live-1', payload: { tool_id: 'tx', duration_s: -1, result: 'r' } }, ctx),
    [{ type: 'tool-complete', messageId: 'ast-1', toolCallId: 'tx', output: 'r' }],
  );
  assert.deepEqual(
    reduceGatewayEvent({ type: 'tool.complete', session_id: 'live-1', payload: { tool_id: 'tx', output: 'ok' } }, emptyMsgCtx),
    [],
  );

  // 9. connection.request / connection.update / gateway.ready 全边界覆盖
  assert.deepEqual(reduceGatewayEvent({ type: 'connection.request', session_id: 'live-1', payload: {} }, ctx), []);
  const reqNoSess = reduceGatewayEvent(
    { type: 'connection.request', payload: { op_id: 'op-a', seq: 1, deadline_at: 100, timeout_seconds: 60, targets: [] } },
    ctx,
  );
  assert.equal(reqNoSess[0]?.type, 'connection-request');
  assert.equal('sessionId' in reqNoSess[0], false);

  assert.deepEqual(reduceGatewayEvent({ type: 'connection.update', session_id: 'live-1', payload: {} }, ctx), []);
  const updWithSess = reduceGatewayEvent(
    { type: 'connection.update', session_id: 'live-1', payload: { op_id: 'op-a', seq: 2, deadline_at: 100, settled: false, targets: [] } },
    ctx,
  );
  assert.equal(updWithSess[0]?.type, 'connection-update');
  assert.equal(updWithSess[0]?.sessionId, 'live-1');
  const updNoSess = reduceGatewayEvent(
    { type: 'connection.update', payload: { op_id: 'op-a', seq: 3, deadline_at: 100, settled: true, targets: [] } },
    ctx,
  );
  assert.equal('sessionId' in updNoSess[0], false);

  const gr1 = reduceGatewayEvent({ type: 'gateway.ready', payload: { replay_epoch: 'e1', session_authority: true } }, ctx);
  assert.deepEqual(gr1, [{ type: 'gateway-ready', replayEpoch: 'e1', sessionAuthority: true }]);
  const gr2 = reduceGatewayEvent({ type: 'gateway.ready', payload: { replay_epoch: 'e2', session_authority: null } }, ctx);
  assert.deepEqual(gr2, [{ type: 'gateway-ready', replayEpoch: 'e2', sessionAuthority: null }]);
  const gr3 = reduceGatewayEvent({ type: 'gateway.ready', payload: { replay_epoch: 'e3', session_authority: 'bad' } }, ctx);
  assert.deepEqual(gr3, [{ type: 'gateway-ready', replayEpoch: 'e3' }]);

  // 10. notification.show / notification.clear / tool.output_risk 全分支覆盖
  assert.deepEqual(reduceGatewayEvent({ type: 'notification.show', payload: { text: '   ' } }, ctx), []);
  const nFull = reduceGatewayEvent(
    {
      type: 'notification.show',
      payload: { text: ' hello ', ttl_ms: 2500, key: 'k1', id: 'n1', detail: 'det', level: 'warn', kind: 'toast' },
    },
    ctx,
  );
  assert.deepEqual(nFull, [
    { type: 'notification-show', text: 'hello', level: 'warn', kind: 'toast', ttlMs: 2500, key: 'k1', id: 'n1', detail: 'det' },
  ]);
  const nMin = reduceGatewayEvent({ type: 'notification.show', payload: { text: 'ok' } }, ctx);
  assert.deepEqual(nMin, [{ type: 'notification-show', text: 'ok', level: 'info', kind: 'notice' }]);

  assert.deepEqual(reduceGatewayEvent({ type: 'notification.clear', payload: { key: '  ' } }, ctx), []);
  assert.deepEqual(
    reduceGatewayEvent({ type: 'notification.clear', payload: { key: ' k1 ' } }, ctx),
    [{ type: 'notification-clear', key: 'k1' }],
  );

  assert.deepEqual(reduceGatewayEvent({ type: 'tool.output_risk', session_id: 'live-1', payload: {} }, ctx), []);
  const rFull = reduceGatewayEvent(
    {
      type: 'tool.output_risk',
      session_id: 'live-1',
      payload: { tool_id: 'tc-1', name: 'bash', risk: 'high', findings: ['secret'], redacted: true },
    },
    ctx,
  );
  assert.deepEqual(rFull, [
    {
      type: 'tool-output-risk',
      sessionId: 'live-1',
      messageId: 'ast-1',
      toolCallId: 'tc-1',
      toolName: 'bash',
      risk: 'high',
      findings: ['secret'],
      redacted: true,
    },
  ]);
  const rById = reduceGatewayEvent(
    { type: 'tool.output_risk', payload: { id: 'tc-2' } },
    { ...ctx, activeSessionId: null, activeSessionIds: [] },
  );
  assert.equal(rById[0]?.toolCallId, 'tc-2');
  const rByCallId = reduceGatewayEvent(
    { type: 'tool.output_risk', session_id: 'live-1', payload: { tool_call_id: 'tc-3' } },
    ctx,
  );
  assert.deepEqual(rByCallId, [
    { type: 'tool-output-risk', sessionId: 'live-1', messageId: 'ast-1', toolCallId: 'tc-3', risk: 'medium', findings: [], redacted: false },
  ]);
});
