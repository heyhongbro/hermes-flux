/**
 * 会话整体状态栏与子 Agent 监控协调服务单测 (SessionStatusService Unit Tests)
 * (packages/desktop/__tests__/unit/session-status-service.test.mjs)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionHandleRegistry } from '@hermes-flux/core';
import { createSessionStatusService } from '../../dist/renderer/services/sessionStatusService.mjs';

function createServiceHarness(overrides = {}) {
  const rpcCalls = [];
  const toolPatches = [];
  const reactListSyncs = [];
  let rightPodSyncs = 0;
  let titlebarSyncs = 0;
  let renders = 0;
  const openedFiles = [];
  const quotedTexts = [];
  const notices = [];
  const copiedTexts = [];

  const handleRegistry = new SessionHandleRegistry();
  const sessionMessagesCache = new Map();

  const state = {
    lang: 'zh',
    activeFocus: { type: 'session', sessionId: 'stored-1' },
    activeSessionId: 'stored-1',
    activeLiveSessionId: '',
    profileName: 'default',
    inspectorCollapsed: true,
    inspectorFullscreen: false,
    rightPodMode: { kind: 'closed' },
    sessions: [{ id: 'stored-1', botName: 'coder', title: 'S1' }],
    profiles: [{ name: 'default', displayName: 'Default Bot' }, { name: 'coder', displayName: '架构师 · 老王' }],
    groupRooms: [{ roomId: 'room-1', name: 'Arch Room', members: ['alice', 'bob'] }],
    messages: [],
    ...(overrides.state || {}),
  };

  let streaming = Boolean(overrides.streaming);
  let activeStreamingStoredSessionId = overrides.activeStreamingStoredSessionId ?? null;
  let activeStreamingMessageId = overrides.activeStreamingMessageId ?? null;
  let gatewayConnected = overrides.gatewayConnected ?? true;

  const gatewayClient = {
    async call(method, params) {
      rpcCalls.push({ method, params });
      if (overrides.onRpc) {
        return overrides.onRpc(method, params);
      }
      if (method === 'config.get') {
        return {
          compression: { enabled: true, threshold: 0.78 },
        };
      }
      if (method === 'session.usage') {
        return {
          context_used: 4200,
          context_max: 16000,
          input_tokens: 3000,
          output_tokens: 1200,
          estimated_cost_usd: 0.012,
        };
      }
      if (method === 'session.context_breakdown') {
        return {
          context_max: 16000,
          total_tokens: 4200,
          categories: [{ key: 'system', label: 'System', tokens: 1200 }],
          files: [{ path: 'README.md', label: 'README.md', est_tokens: 450 }],
        };
      }
      if (method === 'subagent.list') {
        return {
          subagents: [
            {
              subagent_id: 'sub-live-1',
              session_id: params?.session_id,
              target_profile: 'reviewer',
              goal: 'Check PR',
              lifecycle_status: 'running',
              progress_percent: 60,
              touched_files: ['packages/core/src/index.ts'],
            },
          ],
        };
      }
      if (method === 'spawn_tree.list') {
        return { entries: [{ path: 'spawn_tree/tree-1.json' }] };
      }
      if (method === 'spawn_tree.load') {
        return {
          subagents: [
            {
              subagent_id: 'sub-tree-1',
              goal: 'Historical scan',
              lifecycle_status: 'completed',
              summary: 'Done',
              touched_files: ['AGENTS.md'],
            },
          ],
        };
      }
      if (method === 'groups.state') {
        return {
          room: {
            room_id: params?.room_id ?? 'room-1',
            members: [{ member_id: 'm-alice', profile: 'alice', display_name: 'Alice' }],
          },
          driver_status: {
            round_status: 'running',
            member_activity: [{ member_id: 'm-alice', status: 'running', tool: 'read_file', started_at: 1700000000 }],
          },
        };
      }
      return { ok: true };
    },
    async fetchSessionMessages(childId) {
      rpcCalls.push({ method: 'REST.fetchSessionMessages', params: { childId } });
      return {
        status: 'success',
        messages: [
          { row_id: 1, role: 'user', content: 'Inspect core', timestamp: 1700000010 },
          { row_id: 2, role: 'assistant', content: 'Found invariant', timestamp: 1700000012 },
        ],
      };
    },
    async fetchGatewayConfig(profile) {
      return this.call('config.get', profile ? { profile } : {});
    },
    async getSessionUsage(sessionId, profile) {
      return this.call('session.usage', { session_id: sessionId, ...(profile ? { profile } : {}) });
    },
    async getSessionContextBreakdown(sessionId, profile) {
      return this.call('session.context_breakdown', { session_id: sessionId, ...(profile ? { profile } : {}) });
    },
    async compressSession(sessionId, profile) {
      return this.call('session.compress', { session_id: sessionId, ...(profile ? { profile } : {}) });
    },
    async fetchSubagentTranscript(sessionId, subagentId, cursor, profile) {
      return this.call('session.transcript', {
        session_id: sessionId,
        subagent_id: subagentId,
        ...(cursor !== undefined ? { cursor } : {}),
        ...(profile ? { profile } : {}),
      });
    },
    async listSpawnTrees(sessionId, profile, limit) {
      return this.call('spawn_tree.list', {
        session_id: sessionId,
        ...(profile ? { profile } : {}),
        ...(limit !== undefined ? { limit } : {}),
      });
    },
    async loadSpawnTree(treePath, profile) {
      return this.call('spawn_tree.load', { path: treePath, ...(profile ? { profile } : {}) });
    },
  };

  const service = createSessionStatusService({
    getState: () => state,
    getGatewayClient: () => (gatewayConnected ? gatewayClient : null),
    getSessionHandleRegistry: () => handleRegistry,
    getSessionMessagesCache: () => sessionMessagesCache,
    isStreamingActiveForCurrentSession: () => streaming,
    getActiveStreamingStoredSessionId: () => activeStreamingStoredSessionId,
    getActiveStreamingMessageId: () => activeStreamingMessageId,
    formatTimestamp: (ts) => `t:${ts}`,
    scheduleToolPatch: (mid) => toolPatches.push(mid),
    syncReactMessageList: (force) => reactListSyncs.push(Boolean(force)),
    syncRightPod: () => {
      rightPodSyncs += 1;
    },
    syncTitlebar: () => {
      titlebarSyncs += 1;
    },
    openFilePreview: (filePath) => {
      openedFiles.push(filePath);
    },
    insertQuoteToComposer: (text) => {
      quotedTexts.push(text);
    },
    writeClipboardText: async (text) => {
      copiedTexts.push(text);
    },
    setTimedDockNotice: (msg) => {
      notices.push(msg);
    },
    render: () => {
      renders += 1;
    },
    t: (key) => key,
  });

  return {
    service,
    state,
    handleRegistry,
    sessionMessagesCache,
    rpcCalls,
    toolPatches,
    reactListSyncs,
    getRightPodSyncs: () => rightPodSyncs,
    getTitlebarSyncs: () => titlebarSyncs,
    getRenders: () => renders,
    openedFiles,
    quotedTexts,
    notices,
    copiedTexts,
    setStreaming: (v) => {
      streaming = v;
    },
    setActiveStreamingMessage: (sid, mid) => {
      activeStreamingStoredSessionId = sid;
      activeStreamingMessageId = mid;
    },
    setGatewayConnected: (v) => {
      gatewayConnected = v;
    },
  };
}

test('SessionStatusService: strict 4001 gate ignores fallback state.activeLiveSessionId until registered', async () => {
  const h = createServiceHarness({
    state: {
      activeSessionId: 'stored-unregistered',
      // 模拟 handles === null 时 messageLoadingService 写入的兜底 storedId
      activeLiveSessionId: 'stored-unregistered',
      messages: [
        {
          id: 'msg-l3',
          role: 'assistant',
          content: '',
          toolCalls: [
            {
              id: 'tc-l3-1',
              name: 'delegate_task',
              status: 'completed',
              args: JSON.stringify({ goal: 'L3 recovery task', delegation_id: 'del-l3' }),
              output: JSON.stringify({ summary: 'recovered summary', subagent_id: 'sub-l3-1' }),
            },
          ],
        },
      ],
    },
  });

  try {
    h.service.onSessionActivated('stored-unregistered', 'coder');
    await h.service.loadBreakdownForCurrentSession();
    await h.service.getRightPodActions().onSteerSubagent('sub-l3-1', 'continue');
    h.service.getRightPodActions().onInterruptSubagent('sub-l3-1');
    await new Promise((r) => setTimeout(r, 20));

    const liveMethods = new Set([
      'session.usage',
      'session.context_breakdown',
      'subagent.list',
      'subagent.steer',
      'subagent.interrupt',
    ]);
    const forbiddenCalled = h.rpcCalls.filter((c) => liveMethods.has(c.method));
    assert.deepEqual(forbiddenCalled, [], '未在 HandleRegistry 登记真实 liveId 时，绝不可发任何 live session RPC（防 4001）');

    const nonLiveCalled = h.rpcCalls.map((c) => c.method);
    assert.ok(nonLiveCalled.includes('spawn_tree.list'), '非活跃会话允许走 spawn_tree.list 恢复历史树');
    assert.ok(nonLiveCalled.includes('spawn_tree.load'), '非活跃会话允许走 spawn_tree.load 加载树内容');

    const snap = h.service.getRightPodSnapshot();
    const ids = snap.subagents.map((s) => s.subagentId);
    assert.ok(ids.includes('sub-tree-1'), '必须合并 spawn_tree 恢复的子 Agent');
    assert.ok(ids.includes('sub-l3-1'), '必须合并 L3 消息扫描恢复的子 Agent');
  } finally {
    h.service.dispose();
  }
});

test('SessionStatusService:三态隔离与实时遥测刷新（normal/bot vs group_room）', async () => {
  const h = createServiceHarness();
  try {
    await h.service.onConnected();
    assert.equal(h.rpcCalls[0].method, 'config.get');

    // 注册真实 liveId 后触发 onLiveSessionReady（按真实契约传 nested info）
    h.handleRegistry.register({ storedId: 'stored-1', liveId: 'live-1' });
    h.service.onLiveSessionReady(
      'stored-1',
      'live-1',
      { info: { cwd: '/repo/demo', branch: 'feat/status', model: 'claude-sonnet', provider: 'anthropic' } },
      'coder',
    );
    await new Promise((r) => setTimeout(r, 25));

    const methods = h.rpcCalls.map((c) => c.method);
    assert.ok(methods.includes('session.usage'));
    assert.ok(methods.includes('subagent.list'));
    assert.equal(h.service.getRunningSubagentCount(), 1);

    let snap = h.service.getRightPodSnapshot();
    assert.equal(snap.conversationMode, 'scratchpad');
    assert.equal(snap.subject?.kind, 'agent');
    assert.equal(snap.subject?.name, '架构师 · 老王');
    assert.equal(snap.effectiveCompressionRatio, 0.78);
    assert.equal(snap.scope?.cwd, '/repo/demo', '必须从 session.resume/create 的 res.info 解包 cwd');
    assert.equal(snap.scope?.branch, 'feat/status', '必须从 res.info 解包 branch');
    assert.equal(snap.scope?.model, 'claude-sonnet', '必须从 res.info 解包 model');
    assert.equal(snap.scope?.usage?.contextUsed, 4200);
    assert.equal(snap.scope?.usage?.contextMax, 16000);

    // 打开状态栏再切入群聊：保留 status 模式，停止单聊遥测并改拉 groups.state
    h.service.applyRightPodAction({ type: 'toggle-status-bar' });
    assert.equal(h.state.rightPodMode.kind, 'status');

    h.rpcCalls.length = 0;
    h.state.activeFocus = { type: 'group', roomId: 'room-1' };
    h.service.onGroupActivated('room-1');
    await new Promise((r) => setTimeout(r, 25));

    assert.ok(h.rpcCalls.some((c) => c.method === 'groups.state' && c.params?.room_id === 'room-1'));
    assert.equal(h.rpcCalls.some((c) => c.method === 'session.usage'), false, 'group_room 绝不得请求 session.usage');
    snap = h.service.getRightPodSnapshot();
    assert.equal(snap.conversationMode, 'group_room');
    assert.deepEqual(snap.subagents, [], '群聊视口不得透传单聊子 Agent 列表');
    assert.equal(snap.scope?.groupState?.memberActivity?.[0]?.profile, 'alice');
  } finally {
    h.service.dispose();
  }
});

test('SessionStatusService: 双路径工具行回填（流式走 scheduleToolPatch，沉底走 syncReactMessageList）+ 别名迁徙', async () => {
  const h = createServiceHarness({
    streaming: true,
    activeStreamingStoredSessionId: 'stored-1',
    activeStreamingMessageId: 'msg-streaming',
    state: {
      activeSessionId: 'stored-1',
      rightPodMode: { kind: 'subagent', subagentId: 'deleg:del-dual:0', returnTo: 'status' },
      inspectorCollapsed: false,
      messages: [
        {
          id: 'msg-settled',
          role: 'assistant',
          content: 'earlier',
          toolCalls: [
            {
              id: 'tc-settled',
              name: 'delegate_task',
              status: 'completed',
              args: JSON.stringify({ goal: 'Settled subagent', delegation_id: 'del-settled' }),
            },
          ],
        },
        {
          id: 'msg-streaming',
          role: 'assistant',
          content: '',
          toolCalls: [
            {
              id: 'tc-live',
              name: 'delegate_task',
              status: 'running',
              args: JSON.stringify({ goal: 'Live subagent', delegation_id: 'del-dual' }),
            },
          ],
        },
      ],
    },
  });

  try {
    // 1. 先以无 subagentId 的 synthesis 任务建立合成节点，随后真 subagent_id 到达触发别名迁徙
    h.service.onGatewayTurnAction(
      {
        type: 'subagent-update',
        sessionId: 'live-1',
        status: 'running',
        lifecycleStatus: 'running',
        delegationId: 'del-dual',
        goal: 'Live subagent',
        phaseHint: 'running',
      },
      (id) => (id === 'live-1' ? 'stored-1' : id ?? null),
    );
    assert.ok(h.toolPatches.includes('msg-streaming'), '活跃流式消息必须走 scheduleToolPatch 增量打补丁');

    h.service.onGatewayTurnAction(
      {
        type: 'subagent-update',
        sessionId: 'live-1',
        subagentId: 'sub-real-dual',
        delegationId: 'del-dual',
        status: 'running',
        lifecycleStatus: 'running',
        goal: 'Live subagent',
        phaseHint: 'running',
      },
      (id) => (id === 'live-1' ? 'stored-1' : id ?? null),
    );
    assert.deepEqual(
      h.state.rightPodMode,
      { kind: 'subagent', subagentId: 'sub-real-dual', returnTo: 'status' },
      'synthesis -> real subagent_id 合并时必须迁移 UI 下钻主键',
    );
    assert.equal(h.state.messages[1].toolCalls[0].subagentId, 'sub-real-dual');

    // 别名日志到账必须经 resolveSubagentId 触发 syncRightPod
    h.service.onGatewayTurnAction(
      {
        type: 'subagent-log',
        subagentId: 'deleg:del-dual:0',
        entry: { seq: 11, timestamp: 1700000011, kind: 'stdout', text: 'alias resolved log' },
      },
      (id) => (id === 'live-1' ? 'stored-1' : id ?? null),
    );
    assert.ok(h.service.getRightPodSnapshot().selectedLogs.some((e) => e.text === 'alias resolved log'));

    // 2. 回合收口后非流式路径更新已落盘消息
    h.setStreaming(false);
    h.setActiveStreamingMessage(null, null);
    h.service.onGatewayTurnAction(
      {
        type: 'subagent-update',
        sessionId: 'live-1',
        subagentId: 'sub-settled-1',
        delegationId: 'del-settled',
        status: 'completed',
        goal: 'Settled subagent',
        phaseHint: 'idle',
      },
      (id) => (id === 'live-1' ? 'stored-1' : id ?? null),
    );
    assert.equal(h.state.messages[0].toolCalls[0].subagentId, 'sub-settled-1');
    assert.ok(h.reactListSyncs.includes(true), '非流式已落盘工具行回填必须强制 syncReactMessageList(true)');
  } finally {
    h.service.dispose();
  }
});

test('SessionStatusService: 快捷转发、断线与删会话完整清理状态', async () => {
  const h = createServiceHarness({
    onRpc: async (method) => {
      if (method === 'session.usage') return { context_used: 900, context_max: 16000 };
      if (method === 'subagent.list') return { subagents: [] };
      return {};
    },
  });

  try {
    h.handleRegistry.register({ storedId: 'stored-1', liveId: 'live-1' });
    assert.equal('onCompressSession' in h.service.getRightPodActions(), false, 'UI 动作层严禁暴露一键压缩动作');

    // 快捷动作与剪贴板 / 引用 / 文件预览转发
    h.service.getRightPodActions().onOpenFilesAtPath('src/a.ts');
    assert.deepEqual(h.openedFiles, ['src/a.ts']);
    h.service.getRightPodActions().onQuoteToMain('summary quote');
    assert.deepEqual(h.quotedTexts, ['summary quote']);
    await h.service.getRightPodActions().onCopyText('copied text');
    assert.deepEqual(h.copiedTexts, ['copied text']);

    // 删除会话与断线彻底清空状态
    h.service.onSessionDeleted('stored-1');
    assert.equal(h.service.getRightPodSnapshot().scope, null);
    h.service.onDisconnected();
    assert.equal(h.service.getRightPodSnapshot().steerFeedback, null);
  } finally {
    h.service.dispose();
  }
});

test('SessionStatusService: 终态 degraded_tail 停表去重不无限轮询', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let transcriptCalls = 0;
  let tailCalls = 0;
  const h = createServiceHarness({
    onRpc: async (method) => {
      if (method === 'config.get') return { compression: { enabled: true, threshold: 0.78 } };
      if (method === 'session.usage') return { context_used: 900, context_max: 16000 };
      if (method === 'subagent.list') {
        return {
          subagents: [
            {
              subagent_id: 'sub-term-tail',
              goal: 'Ended degraded task',
              status: 'completed',
            },
          ],
        };
      }
      if (method === 'spawn_tree.list') return { entries: [] };
      if (method === 'session.transcript') {
        transcriptCalls += 1;
        const err = new Error('Method not found');
        err.code = -32601;
        throw err;
      }
      if (method === 'subagent.tail') {
        tailCalls += 1;
        return {
          subagent_id: 'sub-term-tail',
          entries: [
            { seq: 1, timestamp: 1700000001, kind: 'tool_call', text: 'grep -rn statusPod' },
            { seq: 2, timestamp: 1700000002, kind: 'stdout', text: 'done' },
          ],
        };
      }
      return {};
    },
  });

  try {
    h.handleRegistry.register({ storedId: 'stored-1', liveId: 'live-1' });
    h.service.onLiveSessionReady('stored-1', 'live-1', { info: { cwd: '/repo/demo' } }, 'coder');
    await new Promise((r) => setTimeout(r, 25));

    h.service.openSubagent('sub-term-tail');
    await new Promise((r) => setTimeout(r, 30));

    const snapBefore = h.service.getRightPodSnapshot();
    assert.equal(snapBefore.selectedTranscript?.status, 'degraded_tail');
    assert.equal(snapBefore.selectedLogs.length, 2);
    assert.equal(tailCalls, 1);

    // 触发第一次 2500ms 轮询滴答后应立即停表，再过 10000ms 绝不再请求 subagent.tail
    t.mock.timers.tick(2600);
    await new Promise((r) => setTimeout(r, 20));
    const tailAfterFirstTick = tailCalls;
    t.mock.timers.tick(10000);
    await new Promise((r) => setTimeout(r, 20));

    assert.equal(transcriptCalls, 1);
    assert.equal(tailAfterFirstTick, 1, '终态 degraded_tail 首次轮询检查必须直接停表不再调 subagent.tail');
    assert.equal(tailCalls, 1, '停表后持续滴答绝不得重复拉取或堆叠日志');
    assert.equal(h.service.getRightPodSnapshot().selectedLogs.length, 2);
  } finally {
    h.service.dispose();
  }
});

test('SessionStatusService: 断线清句柄防 4001、终态与合成 deleg ID 拦截、阈值复位及剪贴板失败可见', async () => {
  let failConfig = false;
  let failCopy = false;
  const h = createServiceHarness({
    onRpc: async (method) => {
      if (method === 'config.get') {
        if (failConfig) throw new Error('config unavailable');
        return { compression: { enabled: true, threshold: 0.78 } };
      }
      if (method === 'session.usage') return { context_used: 900, context_max: 16000 };
      if (method === 'subagent.list') {
        return {
          subagents: [
            { subagent_id: 'sub-run-live', goal: 'Live job', status: 'running' },
            { subagent_id: 'sub-done-live', goal: 'Ended job', status: 'completed' },
          ],
        };
      }
      return {};
    },
  });

  // 替换可控制的剪贴板失败桩
  const baseActions = h.service.getRightPodActions();
  try {
    await h.service.onConnected();
    h.handleRegistry.register({ storedId: 'stored-1', liveId: 'live-1' });
    h.service.onLiveSessionReady('stored-1', 'live-1', { info: { cwd: '/repo/demo' } }, 'coder');
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(h.service.getRunningSubagentCount(), 1);
    assert.equal(h.service.getRightPodSnapshot().effectiveCompressionRatio, 0.78);

    // 1. 即使 liveId 已就绪，终态任务与合成 deleg:... ID 也绝不可发 steer/interrupt RPC
    h.service.subagentStore.upsertTask({
      subagentId: 'deleg:pending:0',
      parentSessionId: 'stored-1',
      status: 'running',
      goal: 'Pending id',
    });
    h.rpcCalls.length = 0;

    const okEnded = await baseActions.onSteerSubagent('sub-done-live', 'too late');
    baseActions.onInterruptSubagent('sub-done-live');
    const okSyn = await baseActions.onSteerSubagent('deleg:pending:0', 'too early');
    baseActions.onInterruptSubagent('deleg:pending:0');

    assert.equal(okEnded, false);
    assert.equal(okSyn, false);
    assert.equal(
      h.rpcCalls.some((c) => c.method === 'subagent.steer' || c.method === 'subagent.interrupt'),
      false,
      '终态与合成 deleg ID 即使持有有效 liveId 也严禁发 steer/interrupt RPC',
    );
    assert.ok(h.service.getRightPodSnapshot().steerFeedback);
    assert.ok(h.notices.length >= 2);

    // 2. 断线必须清空 liveId 注册表、活跃子 Agent、阈值与缓存，避免重连前误用旧句柄撞 4001
    h.service.onDisconnected();
    assert.equal(h.handleRegistry.getRegisteredLiveId('stored-1'), null);
    assert.equal(h.service.getLiveSessionId('stored-1'), null);
    assert.equal(h.service.getRunningSubagentCount(), 0);
    assert.equal(h.service.getRightPodSnapshot().effectiveCompressionRatio, null);

    h.rpcCalls.length = 0;
    await h.service.loadBreakdownForCurrentSession();
    assert.equal(h.rpcCalls.length, 0, '断线后句柄已清空，breakdown 严禁再发 4001 RPC');

    // 3. 重连后若 config.get 失败，阈值必须维持 null，不得残留上一个网关阈值
    failConfig = true;
    await h.service.onConnected();
    assert.equal(h.service.getRightPodSnapshot().effectiveCompressionRatio, null);

    // 4. 剪贴板失败必须返回 false 并提示（覆盖默认成功 + 异常拒绝分支）
    assert.equal(await baseActions.onCopyText('ok-copy'), true);
    failCopy = true;
  } finally {
    h.service.dispose();
  }

  // 独立验证 navigator/clipboard 抛错路径返回 false 且触发提示
  const notices2 = [];
  const hErr = createServiceHarness();
  try {
    hErr.dispose?.();
  } catch {}
  hErr.service.dispose();

  const { createSessionStatusService } = await import('../../dist/renderer/services/sessionStatusService.mjs');
  const { SessionHandleRegistry } = await import('@hermes-flux/core');
  const copyFailSvc = createSessionStatusService({
    getState: () => ({
      lang: 'zh',
      activeFocus: { type: 'session', sessionId: 's1' },
      activeSessionId: 's1',
      activeLiveSessionId: '',
      profileName: 'default',
      inspectorCollapsed: false,
      inspectorFullscreen: false,
      rightPodMode: { kind: 'status' },
      sessions: [],
      profiles: [],
      groupRooms: [],
      messages: [],
    }),
    getGatewayClient: () => null,
    getSessionHandleRegistry: () => new SessionHandleRegistry(),
    getSessionMessagesCache: () => new Map(),
    isStreamingActiveForCurrentSession: () => false,
    getActiveStreamingStoredSessionId: () => null,
    getActiveStreamingMessageId: () => null,
    formatTimestamp: (ts) => String(ts),
    scheduleToolPatch: () => {},
    syncReactMessageList: () => {},
    syncRightPod: () => {},
    syncTitlebar: () => {},
    openFilePreview: () => {},
    insertQuoteToComposer: () => {},
    writeClipboardText: async () => {
      if (failCopy) throw new Error('clipboard denied');
    },
    setTimedDockNotice: (msg) => notices2.push(msg),
    render: () => {},
    t: (key) => key,
  });
  try {
    assert.equal(await copyFailSvc.getRightPodActions().onCopyText('abc'), false);
    assert.deepEqual(notices2, ['statusPod.copyFailed']);
  } finally {
    copyFailSvc.dispose();
  }
});

test('SessionStatusService: onConnected 阈值不被并发切会话覆盖、断线退出 subagent 下钻且暴露 activeScopeKey', async () => {
  let resolveConfig;
  const h = createServiceHarness({
    state: {
      activeSessionId: 'stored-1',
      rightPodMode: { kind: 'subagent', subagentId: 'sub-1', returnTo: 'status' },
      inspectorCollapsed: false,
      inspectorFullscreen: true,
    },
    onRpc: async (method) => {
      if (method === 'config.get') {
        return new Promise((r) => {
          resolveConfig = r;
        });
      }
      if (method === 'spawn_tree.list') return { entries: [] };
      return {};
    },
  });

  try {
    // 1. 即使 scope 尚未建档，快照仍需稳定提供 activeScopeKey
    assert.equal(h.service.getRightPodSnapshot().activeScopeKey, 'session:stored-1');

    // 2. 发起 onConnected 后并发切换会话（递增 statusGeneration），阈值不得被误丢弃
    const connP = h.service.onConnected();
    h.state.activeSessionId = 'stored-2';
    h.state.activeFocus = { type: 'session', sessionId: 'stored-2' };
    h.service.onSessionActivated('stored-2', 'coder');
    resolveConfig({ compression: { enabled: true, threshold: 0.78 } });
    await connP;
    assert.equal(h.service.getRightPodSnapshot().effectiveCompressionRatio, 0.78, '并发切会话绝不可丢弃 config.get 压缩阈值');
    assert.equal(h.service.getRightPodSnapshot().activeScopeKey, 'session:stored-2');

    // 3. 在途 config.get 期间若发生 onDisconnected()，过期响应必须丢弃；且断线退出 subagent 下钻模式
    const connP2 = h.service.onConnected();
    h.state.rightPodMode = { kind: 'subagent', subagentId: 'sub-2', returnTo: 'status' };
    h.state.inspectorFullscreen = true;
    h.service.onDisconnected();
    assert.notEqual(h.state.rightPodMode.kind, 'subagent', '断线必须退出 subagent 详情页防孤立空屏');
    assert.equal(h.state.inspectorFullscreen, false);

    resolveConfig({ compression: { enabled: true, threshold: 0.65 } });
    await connP2;
    assert.equal(h.service.getRightPodSnapshot().effectiveCompressionRatio, null, '断线前在途 config.get 绝不可在断线后回写阈值');
  } finally {
    h.service.dispose();
  }
});
