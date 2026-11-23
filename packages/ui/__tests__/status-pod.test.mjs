import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  ContextBreakdownDrawer,
  ConversationMessageList,
  RightPodRoot,
  StatusPanelGlyph,
  Titlebar,
  ToolBlocks,
  ToolCapsule,
  ToolSection,
  formatDurationSecondsCompact,
  formatElapsedCompact,
  renderInspectionPod,
  renderToolCapsuleSlot,
} from '../dist/index.js';
import { enStatusPod, zhStatusPod } from '../dist/i18n/messages/statusPod.js';

const ROOT = path.resolve(import.meta.dirname, '../../..');

function makeSnapshot(overrides = {}) {
  return {
    rightPodMode: { kind: 'status' },
    conversationMode: 'scratchpad',
    isStreaming: false,
    isFullscreen: false,
    subject: {
      kind: 'agent',
      name: '架构师 · 老王',
      profileName: 'architect',
    },
    scope: {
      scopeKey: 'session:sess-1',
      cwd: '/repo/hermes-flux',
      branch: 'feat/status-bar',
      model: 'claude-sonnet-4',
      usage: {
        input: 12000,
        output: 3400,
        reasoning: 0,
        calls: 4,
        cacheHitPct: 80,
        contextUsed: 491000,
        contextMax: 1000000,
        contextPercent: 49,
        contextEstimated: false,
        compressions: 1,
        updatedAt: Date.now(),
      },
      breakdown: {
        status: 'ready',
        categories: [
          { id: 'system_prompt', label: 'System Prompt', tokens: 20000, color: 'var(--context-usage-1)' },
          { id: 'conversation', label: 'Conversation', tokens: 180000, color: 'var(--context-usage-2)' },
        ],
        contextFiles: [{ label: 'AGENTS.md', path: 'AGENTS.md', chars: 4800, est_tokens: 1200, loaded: true, status: 'loaded' }],
        contextUsed: 200000,
        contextMax: 1000000,
        contextPercent: 20,
        contextEstimated: false,
        updatedAt: Date.now(),
      },
      groupState: null,
    },
    effectiveCompressionRatio: 0.5,
    subagents: [
      {
        subagentId: 'sub-run-1',
        parentSessionId: 'sess-1',
        goal: '审查状态栏并发竞态',
        lifecycleStatus: 'running',
        phaseHint: 'tool',
        source: 'live_event',
        toolCount: 4,
        lastTool: 'read_file',
        filesRead: ['packages/core/src/index.ts'],
        filesWritten: ['packages/ui/src/index.ts'],
        startedAt: Date.now() - 12_000,
        updatedAt: Date.now(),
        targetProfile: 'claude-sonnet-4',
        taskTitle: '审查状态栏并发竞态',
        status: 'running',
        progressPercent: 40,
        currentActionText: 'read_file: index.ts',
      },
      {
        subagentId: 'sub-done-1',
        parentSessionId: 'sess-1',
        goal: '统计设计 Token 合规性',
        lifecycleStatus: 'completed',
        phaseHint: 'idle',
        source: 'subagent_list',
        toolCount: 2,
        summary: '全部使用语义变量，0 违规。',
        startedAt: Date.now() - 60_000,
        updatedAt: Date.now() - 30_000,
        completedAt: Date.now() - 30_000,
        targetProfile: 'default',
        taskTitle: '统计设计 Token 合规性',
        status: 'completed',
        progressPercent: 100,
        currentActionText: '全部使用语义变量，0 违规。',
      },
    ],
    selectedSubagent: null,
    selectedTranscript: null,
    selectedLogs: [],
    selectedMessages: [],
    locale: 'zh-CN',
    ...overrides,
  };
}

const NOOP_ACTIONS = {
  onClose() {},
  onToggleFullscreen() {},
  onOpenFilesAtPath() {},
  onOpenSubagent() {},
  onBackToStatus() {},
  onInterruptSubagent() {},
  onSteerSubagent() {},
  onLoadBreakdown() {},
  onCopyText() {},
  onQuoteToMain() {},
};

test('Titlebar 状态栏入口与微指示点（严禁文本与数字）', () => {
  const idleHtml = renderToStaticMarkup(
    React.createElement(Titlebar, {
      platform: 'windows',
      isMaximized: false,
      gatewayConnected: true,
      leftRailCollapsed: false,
      inspectorCollapsed: true,
      rightPodMode: 'closed',
      runningSubagentCount: 0,
      onMinimize() {},
      onMaximize() {},
      onClose() {},
      onToggleLeftRail() {},
      onToggleInspector() {},
      onOpenSettings() {},
    })
  );
  assert.match(idleHtml, /data-right-pod-mode="closed"/);
  assert.match(idleHtml, /data-testid="toggle-status-bar-btn"/);
  assert.equal(idleHtml.includes('titlebar-status-dot'), false, '无运行中子 Agent 时不得渲染小绿点');

  const offlineActiveHtml = renderToStaticMarkup(
    React.createElement(Titlebar, {
      platform: 'macos',
      isMaximized: false,
      gatewayConnected: false,
      leftRailCollapsed: false,
      inspectorCollapsed: true,
      rightPodMode: 'closed',
      runningSubagentCount: 2,
      onMinimize() {},
      onMaximize() {},
      onClose() {},
      onToggleLeftRail() {},
      onToggleInspector() {},
      onOpenSettings() {},
    })
  );
  assert.equal(offlineActiveHtml.includes('titlebar-status-dot'), false, '断线状态下不得残留运行指示点');

  const activeHtml = renderToStaticMarkup(
    React.createElement(Titlebar, {
      platform: 'macos',
      isMaximized: false,
      gatewayConnected: true,
      leftRailCollapsed: false,
      inspectorCollapsed: false,
      rightPodMode: 'status',
      runningSubagentCount: 3,
      onMinimize() {},
      onMaximize() {},
      onClose() {},
      onToggleLeftRail() {},
      onToggleInspector() {},
      onOpenSettings() {},
    })
  );
  assert.match(activeHtml, /data-right-pod-mode="status"/);
  assert.match(activeHtml, /<span class="titlebar-status-dot" aria-hidden="true"><\/span>/);
  assert.equal(activeHtml.includes('>3<'), false, '顶栏开关严禁出现运行数量数字文本');
});

test('RightPodRoot & SessionStatusPanel：v3 极简卡片、Agent 头像名、默认3行折叠与无压缩按钮', () => {
  // 1. 默认最多显示 3 行（1 running + 2 terminal）、隐藏模式标签/模型名/压缩按钮、右侧克制状态文字无秒数
  const sixTerminal = Array.from({ length: 6 }, (_, i) => ({
    ...makeSnapshot().subagents[1],
    subagentId: `sub-done-${i}`,
    goal: `历史任务 #${i}`,
    durationSeconds: i === 0 ? 125.4 : 8.2,
    completedAt: Date.now() - i * 1000,
  }));
  const normalHtml = renderToStaticMarkup(
    React.createElement(RightPodRoot, {
      snapshot: makeSnapshot({ subagents: [makeSnapshot().subagents[0], ...sixTerminal] }),
      actions: NOOP_ACTIONS,
    })
  );
  assert.match(normalHtml, /data-flux-island=""/);
  assert.match(normalHtml, /data-testid="status-agent-row"/);
  assert.match(normalHtml, /架构师 · 老王/);
  assert.match(normalHtml, /<svg[^>]*viewBox="0 0 36 36"/, 'Agent 身份行必须复用渲染头像图腾');
  assert.equal(normalHtml.includes('Bot 主工位'), false, '严禁渲染 Bot 主工位 模式标签');
  assert.equal(normalHtml.includes('普通会话'), false, '严禁渲染 普通会话 模式标签');
  assert.equal(normalHtml.includes('claude-sonnet-4'), false, '状态栏主卡片与列表行严禁冗余模型名');
  assert.match(normalHtml, /data-testid="status-cwd-btn"/);
  assert.match(normalHtml, /feat\/status-bar/);
  assert.match(normalHtml, /data-testid="status-subagents-toggle"/);
  assert.match(normalHtml, /1 进行中 · 共 7/);
  assert.equal((normalHtml.match(/class="sp-agent-row /g) ?? []).length, 3, '默认仅渲染 3 行（1 进行中 + 2 已完成）');
  assert.match(normalHtml, /data-testid="status-toggle-more-terminal"/);
  assert.match(normalHtml, />显示更多</);
  assert.match(normalHtml, />进行中</);
  assert.match(normalHtml, />已完成</);
  assert.equal(normalHtml.includes('2m05s'), false, '主列表行不得显示秒数耗时');
  assert.equal(normalHtml.includes('125.4s'), false);
  assert.match(normalHtml, /data-testid="status-usage-strip"/);
  assert.match(normalHtml, /data-testid="status-context-trigger"/);
  assert.match(normalHtml, /data-testid="status-compression-tick"[^>]*style="left:50%"/);
  assert.equal(normalHtml.includes('status-compress-btn'), false, '严禁存在任何一键压缩上下文按钮');
  assert.equal(normalHtml.includes('立即压缩'), false);
  assert.equal(normalHtml.includes('压缩上下文'), false);

  // 2. 无阈值配置：不渲染虚假阈值刻度
  const noThresholdHtml = renderToStaticMarkup(
    React.createElement(RightPodRoot, {
      snapshot: makeSnapshot({ effectiveCompressionRatio: null, isStreaming: true }),
      actions: NOOP_ACTIONS,
    })
  );
  assert.equal(noThresholdHtml.includes('status-compression-tick'), false);

  // 3. 群聊研讨室：隐藏下区用量/上下文，展示只读 member_activity，不渲染子 Agent 中断按钮
  const groupHtml = renderToStaticMarkup(
    React.createElement(RightPodRoot, {
      snapshot: makeSnapshot({
        conversationMode: 'group_room',
        subject: {
          kind: 'group',
          name: '架构组',
          profileName: 'room-1',
          groupMembers: ['arch', 'sec'],
          groupProfiles: [],
        },
        scope: {
          scopeKey: 'group:room-1',
          cwd: '/repo/hermes-flux',
          usage: null,
          breakdown: { status: 'idle', categories: [], contextFiles: [], contextUsed: null, contextMax: null, contextPercent: null, contextEstimated: false, updatedAt: 0 },
          groupState: {
            roomId: 'room-1',
            name: '架构组',
            routing: 'round_robin',
            memberCount: 2,
            running: true,
            working: true,
            blocked: false,
            memberActivity: [
              { memberId: 'm1', displayName: '架构师', handle: 'arch', status: 'tool_calling', roundIndex: 2, tool: 'read_file', startedAt: Date.now() - 4000 },
              { memberId: 'm2', displayName: '安全官', handle: 'sec', status: 'mystery_phase', roundIndex: 2, startedAt: 0 },
            ],
            updatedAt: Date.now(),
          },
        },
        subagents: [],
      }),
      actions: NOOP_ACTIONS,
    })
  );
  assert.equal(groupHtml.includes('status-usage-zone'), false, '群聊必须隐藏全局用量与上下文区');
  assert.match(groupHtml, /data-variant="room_member"/);
  assert.match(groupHtml, /架构师/);
  assert.match(groupHtml, /进行中/);
  assert.match(groupHtml, /处理中/);
  assert.equal(groupHtml.includes('tool_calling'), false, '群聊成员状态必须本地化渲染，严禁裸露枚举');
  assert.equal(groupHtml.includes('mystery_phase'), false, '未知群聊成员状态严禁透传原始英文字符串');
  assert.equal(groupHtml.includes('status-row__interrupt'), false);
});

test('SubagentDetailView：自绘切换菜单、单色状态点文本、degraded_tail 与 readOnly 执行流隔离', () => {
  const snap = makeSnapshot();
  const activeDetailHtml = renderToStaticMarkup(
    React.createElement(RightPodRoot, {
      snapshot: makeSnapshot({
        rightPodMode: { kind: 'subagent', subagentId: 'sub-run-1', returnTo: 'status' },
        selectedSubagent: snap.subagents[0],
        selectedTranscript: {
          status: 'degraded_tail',
          rows: [],
          nextCursor: null,
          running: true,
          available: false,
          transcriptUnsupported: true,
          updatedAt: Date.now(),
        },
        selectedLogs: [{ seq: 1, timestamp: Date.now(), kind: 'tool_call', text: '[执行工具]: read_file' }],
      }),
      actions: NOOP_ACTIONS,
    })
  );
  assert.equal(activeDetailHtml.includes('<select'), false, '禁止原生 select 脱离暗黑皮肤');
  assert.match(activeDetailHtml, /aria-haspopup="listbox"/);
  assert.match(activeDetailHtml, /subagent-status-inline/);
  assert.match(activeDetailHtml, /进行中/);
  assert.match(activeDetailHtml, /data-testid="subagent-steer-input"/);
  assert.match(activeDetailHtml, /data-testid="subagent-detail-interrupt-btn"/);
  assert.match(activeDetailHtml, /subagent-degraded-banner/);
  assert.match(activeDetailHtml, /data-testid="subagent-tail-list"/);
  assert.match(activeDetailHtml, /\[工具\]/, '尾部日志 kind 必须本地化渲染为 [工具]');
  assert.equal(activeDetailHtml.includes('[tool_call]'), false, '尾部日志严禁裸露原始 [tool_call] 枚举');
  assert.equal(activeDetailHtml.includes('subagent-footer-terminal'), false);

  const lockedSteerHtml = renderToStaticMarkup(
    React.createElement(RightPodRoot, {
      snapshot: makeSnapshot({
        rightPodMode: { kind: 'subagent', subagentId: 'sub-run-1', returnTo: 'status' },
        selectedSubagent: {
          ...snap.subagents[0],
          acceptingSteer: false,
          tokensInput: 1500,
          tokensOutput: 420,
          tokensReasoning: 2100,
        },
      }),
      actions: NOOP_ACTIONS,
    })
  );
  assert.match(lockedSteerHtml, /data-testid="subagent-steer-disabled-notice"/);
  assert.match(lockedSteerHtml, /data-testid="subagent-steer-input"[^>]*disabled/);
  assert.match(lockedSteerHtml, /data-testid="subagent-steer-submit"[^>]*disabled/);
  assert.match(lockedSteerHtml, /data-testid="subagent-telemetry-tokens"/);
  assert.match(lockedSteerHtml, /输入 2k · 输出 420 · 推理 2k/);

  // 耗时格式化与 hXXm 补零、非法 startedAt<=0 守卫
  assert.equal(formatDurationSecondsCompact(125.4), '2m05s');
  assert.equal(formatDurationSecondsCompact(3900), '1h05m');
  assert.equal(formatElapsedCompact(0, Date.now()), '');

  const terminalDetailHtml = renderToStaticMarkup(
    React.createElement(RightPodRoot, {
      snapshot: makeSnapshot({
        rightPodMode: { kind: 'subagent', subagentId: 'sub-done-1', returnTo: 'status' },
        selectedSubagent: { ...snap.subagents[1], durationSeconds: 125.4 },
        selectedTranscript: {
          status: 'ready',
          rows: [],
          nextCursor: null,
          running: false,
          available: true,
          transcriptUnsupported: false,
          updatedAt: Date.now(),
        },
        selectedMessages: [
          {
            id: 'sub-msg-1',
            role: 'assistant',
            content: '已排查完毕',
            thought: '查看依赖',
            isStreaming: true,
            toolCalls: [{ id: 'tc-sub-1', name: 'delegate_task', status: 'completed', args: '{}', subagentId: 'nested-1' }],
          },
        ],
      }),
      actions: NOOP_ACTIONS,
    })
  );
  assert.equal(terminalDetailHtml.includes('subagent-steer-input'), false, '终态详情页严禁显示 steer 输入框');
  assert.match(terminalDetailHtml, /已完成/);
  assert.match(terminalDetailHtml, /2m05s/);
  assert.match(terminalDetailHtml, /data-testid="subagent-footer-terminal"/);
  assert.match(terminalDetailHtml, /data-testid="subagent-copy-summary-btn"/);
  assert.match(terminalDetailHtml, /data-testid="subagent-quote-btn"/);
  assert.equal(terminalDetailHtml.includes('id="msg-content-sub-msg-1"'), false, 'readOnly 详情流禁止复用主对话流式锚点 ID');
  assert.equal(terminalDetailHtml.includes('id="msg-tools-sub-msg-1"'), false);
  assert.equal(terminalDetailHtml.includes('data-open-subagent="nested-1"'), false, 'readOnly 执行流内禁止重复挂载可跳转外置按钮');
  assert.equal(terminalDetailHtml.includes('rollback-msg'), false, 'readOnly 执行流严禁出现回滚按钮');
  assert.equal(terminalDetailHtml.includes('fork-msg'), false, 'readOnly 执行流严禁出现分叉按钮');

  // 合成 ID（deleg:...）活跃态在状态栏不挂载中断键，下钻详情页锁住纠偏与中断直到真 subagent_id 分配
  const syntheticRowHtml = renderToStaticMarkup(
    React.createElement(RightPodRoot, {
      snapshot: makeSnapshot({
        subagents: [{ ...snap.subagents[0], subagentId: 'deleg:d-syn:0', goal: '等待分配真 ID' }],
      }),
      actions: NOOP_ACTIONS,
    })
  );
  assert.equal(syntheticRowHtml.includes('status-row__interrupt'), false, '合成 deleg ID 在列表行严禁提供终止按钮');

  const syntheticDetailAndPartialErrHtml = renderToStaticMarkup(
    React.createElement(RightPodRoot, {
      snapshot: makeSnapshot({
        rightPodMode: { kind: 'subagent', subagentId: 'deleg:d-syn:0', returnTo: 'status' },
        selectedSubagent: { ...snap.subagents[0], subagentId: 'deleg:d-syn:0' },
        selectedTranscript: {
          status: 'ready',
          rows: [],
          nextCursor: 'c2',
          running: true,
          available: true,
          transcriptUnsupported: false,
          isIncrementalError: true,
          error: 'Page 3 timeout',
          updatedAt: Date.now(),
        },
        selectedMessages: [
          { id: 'part-1', role: 'assistant', content: '已有增量内容', isStreaming: false },
        ],
      }),
      actions: NOOP_ACTIONS,
    })
  );
  assert.match(syntheticDetailAndPartialErrHtml, /data-testid="subagent-steer-disabled-notice"/);
  assert.match(syntheticDetailAndPartialErrHtml, /data-testid="subagent-steer-input"[^>]*disabled/);
  assert.match(syntheticDetailAndPartialErrHtml, /data-testid="subagent-steer-submit"[^>]*disabled/);
  assert.match(syntheticDetailAndPartialErrHtml, /data-testid="subagent-detail-interrupt-btn"[^>]*disabled/);
  assert.match(syntheticDetailAndPartialErrHtml, /data-testid="subagent-transcript-error"[^>]*>Page 3 timeout</);
  assert.match(syntheticDetailAndPartialErrHtml, /已有增量内容/);

  // ContextBreakdownDrawer 缓存分类存在时刷新失败必须同时保留缓存分类并显示内联错误
  const cachedBreakdownErrHtml = renderToStaticMarkup(
    React.createElement(ContextBreakdownDrawer, {
      breakdown: {
        ...snap.scope.breakdown,
        status: 'error',
        error: 'Refresh failed',
      },
      effectiveCompressionRatio: 0.78,
      onOpenFile() {},
    })
  );
  assert.match(cachedBreakdownErrHtml, /data-testid="context-breakdown-error"[^>]*>Refresh failed</);
  assert.match(cachedBreakdownErrHtml, /System Prompt/);
});

test('StreamRow 外置同级 action（含可展开 details 与静态 running div）、renderToolCapsuleSlot 与 compaction 行', () => {
  const staticToolHtml = renderToStaticMarkup(
    React.createElement(ToolCapsule, {
      tool: { id: 'dt-1', name: 'delegate_task', status: 'running', args: '{"goal":"审查后端"}', subagentId: 'deleg:d1:0' },
      actionEnabled: true,
    })
  );
  assert.match(staticToolHtml, /class="conv-row-shell" data-has-action="true"/);
  assert.match(staticToolHtml, /data-expandable="false"/);
  assert.match(staticToolHtml, /<div class="conv-row__action"><button[^>]*data-open-subagent="deleg:d1:0"/);

  const expandableToolHtml = renderToStaticMarkup(
    React.createElement(ToolCapsule, {
      tool: { id: 'dt-2', name: 'delegate_task', status: 'completed', args: '{"goal":"审查后端"}', output: '结果正常', subagentId: 'sub-9' },
      actionEnabled: true,
    })
  );
  assert.match(expandableToolHtml, /data-expandable="true"/);
  assert.ok(expandableToolHtml.indexOf('</details>') < expandableToolHtml.indexOf('data-open-subagent="sub-9"'));

  const slotHtml = renderToolCapsuleSlot({
    id: 'm-stream',
    role: 'assistant',
    content: '',
    timestamp: '10:00',
    toolCalls: [{ id: 'dt-3', name: 'delegate_task', status: 'running', args: '{}', subagentId: 'sub-slot-1' }],
  });
  assert.match(slotHtml, /data-open-subagent="sub-slot-1"/);

  const compactionHtml = renderToStaticMarkup(
    React.createElement(ConversationMessageList, {
      snapshot: {
        mode: 'scratchpad',
        connection: 'connected',
        isStreaming: false,
        messages: [{ id: 'cmp-1', role: 'user', content: '压缩后的历史上下文摘要', displayKind: 'compaction' }],
      },
    })
  );
  assert.match(compactionHtml, /data-role="compaction"/);
  assert.equal(compactionHtml.includes('conv-message__bubble'), false);
});

test('InspectionPod innerOnly / back-from-files 与 status-pod.css / i18n 静态守卫', () => {
  const withBackHtml = renderInspectionPod({
    collapsed: false,
    podMode: 'files',
    canReturnToStatus: true,
    gatewayConnected: true,
    openFiles: [{ path: 'README.md', content: '# Hi' }],
  });
  assert.match(withBackHtml, /id="btn-inspector-back-status"/);

  const innerOnlyHtml = renderInspectionPod({
    collapsed: false,
    innerOnly: true,
    canReturnToStatus: false,
    gatewayConnected: true,
    openFiles: [{ path: 'README.md', content: '# Hi' }],
  });
  assert.equal(innerOnlyHtml.includes('<aside'), false);
  assert.equal(innerOnlyHtml.includes('btn-inspector-back-status'), false);
  assert.match(innerOnlyHtml, /class="inspector-floating-window"/);

  // i18n 占位符双向对齐检验
  assert.deepEqual(Object.keys(zhStatusPod).sort(), Object.keys(enStatusPod).sort());
  for (const key of Object.keys(zhStatusPod)) {
    const zhVars = [...zhStatusPod[key].matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((m) => m[1]).sort();
    const enVars = [...enStatusPod[key].matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((m) => m[1]).sort();
    assert.deepEqual(zhVars, enVars, `${key} 中英文占位符不一致`);
  }

  // CSS Token 纯净性与移动端热区静态守卫
  const statusCss = fs.readFileSync(path.join(ROOT, 'packages/ui/src/styles/status-pod.css'), 'utf8');
  assert.equal(/#[0-9a-fA-F]{3,8}\b/.test(statusCss), false, 'status-pod.css 严禁任何硬编码 hex 色值');
  assert.equal(/\b(?:rgba?|hsla?)\s*\(/.test(statusCss), false, 'status-pod.css 严禁任何 rgb/hsl 硬编码色值');
  assert.equal(/@keyframes[\s\S]*infinite/i.test(statusCss), false, '严禁无限重复 keyframes 动画');
  assert.ok(statusCss.includes('::-webkit-scrollbar-button'), '必须隐藏 scrollbar-button');
  assert.ok(statusCss.includes('@supports not selector(::-webkit-scrollbar)'), '必须声明非 Chromium 退让');
  assert.ok(statusCss.includes('min-height: 44px;'), '必须覆盖移动端 44px 触控热区');
  assert.equal(/--context-usage-/.test(statusCss), false, '禁止引用未入 skins.ts 的幽灵 --context-usage-* 变量');
  assert.ok(statusCss.includes('height: auto;'), 'status 模式卡片必须按内容自适应高度，不得强行撑满全屏');
});
