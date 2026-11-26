/**
 * 移动端 & 桌面端 UX 优化回归与变异杀伤测试：
 *   1. 群聊列表为空时桌面分组左轨与移动端首屏隐藏整个群聊分组（含项目/文件夹收纳边界）；
 *   2. 移动端连续多段推理/工具轨迹合并为单一按时间序分组的紧凑胶囊（含流式锚点与屏障隔离）；
 *   3. 移动端紧凑消息页脚（日期时间 + 复制 + `...` 浮层收纳回滚/Fork）、长按正文文本选择保留、全新回滚/Fork 图标。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  GroupedLeftRail,
  MobileHomeScreen,
  buildGroupedLeftRailModel,
  buildMobileHomeModel,
  setLocale,
} from '../dist/index.js';
import {
  CompactTraceCapsule,
  ConversationMessageFooter,
  ConversationMessageList,
  ToolCapsule,
  TurnGroup,
  consolidateMobileTurnTraces,
} from '../dist/components-react/conversation/index.js';

const NOW_MS = Date.UTC(2026, 10, 26, 12, 0, 0);

function createHookDriver(refOverrides = {}, { shallowComponents = [] } = {}) {
  const slots = new Map();
  let pendingEffects = [];
  const shallowSet = new Set(shallowComponents);

  function resolve(node, key = 'root') {
    if (node == null || typeof node === 'boolean' || typeof node === 'string' || typeof node === 'number') {
      return node;
    }
    if (Array.isArray(node)) {
      return node.map((item, idx) => resolve(item, `${key}[${idx}]`));
    }
    if (typeof node !== 'object') return node;

    const elType = node.type;
    if (typeof elType === 'symbol') {
      return { ...node, props: { ...node.props, children: resolve(node.props?.children, `${key}.frag`) } };
    }
    if (shallowSet.has(elType)) {
      return node;
    }
    const innerType =
      elType && typeof elType === 'object' && elType.$$typeof === Symbol.for('react.memo')
        ? elType.type
        : elType;
    const compFn =
      innerType && typeof innerType === 'object' && innerType.$$typeof === Symbol.for('react.forward_ref')
        ? (p) => innerType.render(p, p.ref ?? node.ref ?? null)
        : typeof innerType === 'function'
          ? innerType
          : null;

    if (compFn) {
      const scopedKey = node.key != null ? `${key}#k=${String(node.key)}` : key;
      let slot = slots.get(scopedKey);
      if (!slot) {
        slot = { states: [], refs: [], memos: [], effects: [] };
        slots.set(scopedKey, slot);
      }
      let sIdx = 0;
      let rIdx = 0;
      let mIdx = 0;
      let eIdx = 0;
      const internals = React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
      const prevH = internals.H;
      const scheduleEffect = (fn, deps) => {
        const idx = eIdx++;
        if (idx >= slot.effects.length) {
          slot.effects.push({ deps, cleanup: undefined, hasRun: false });
        }
        const entry = slot.effects[idx];
        const changed =
          !entry.hasRun ||
          deps === undefined ||
          entry.deps === undefined ||
          deps.length !== entry.deps.length ||
          deps.some((d, i) => !Object.is(d, entry.deps[i]));
        if (changed) {
          pendingEffects.push(() => {
            if (typeof entry.cleanup === 'function') {
              entry.cleanup();
              entry.cleanup = undefined;
            }
            entry.deps = deps;
            entry.hasRun = true;
            const cleanup = fn();
            if (typeof cleanup === 'function') entry.cleanup = cleanup;
          });
        }
      };
      internals.H = {
        useState(init) {
          const idx = sIdx++;
          if (idx >= slot.states.length) slot.states.push(typeof init === 'function' ? init() : init);
          return [slot.states[idx], (next) => { slot.states[idx] = typeof next === 'function' ? next(slot.states[idx]) : next; }];
        },
        useRef(init) {
          const idx = rIdx++;
          if (idx >= slot.refs.length) slot.refs.push({ current: init });
          return slot.refs[idx];
        },
        useMemo(factory, deps) {
          const idx = mIdx++;
          if (idx >= slot.memos.length) {
            slot.memos.push({ value: factory(), deps });
          } else {
            const prev = slot.memos[idx];
            if (!deps || !prev.deps || deps.some((d, i) => !Object.is(d, prev.deps[i]))) {
              slot.memos[idx] = { value: factory(), deps };
            }
          }
          return slot.memos[idx].value;
        },
        useCallback(cb) { return cb; },
        useEffect: scheduleEffect,
        useLayoutEffect: scheduleEffect,
        useInsertionEffect: scheduleEffect,
        useContext(ctx) { return ctx?._currentValue; },
        useId() { return `id-${scopedKey}`; },
      };
      let rendered;
      try {
        rendered = compFn(node.props);
      } finally {
        internals.H = prevH;
      }
      return resolve(rendered, `${scopedKey}>${compFn.name || 'Fn'}`);
    }

    const refObj = node.props?.ref ?? node.ref;
    if (refObj && typeof refObj === 'object' && !refObj.current) {
      refObj.current = { contains: () => false, ...refOverrides };
    }

    if (node.props && 'children' in node.props) {
      return { ...node, props: { ...node.props, children: resolve(node.props.children, key) } };
    }
    return node;
  }

  return {
    mount(renderFn) {
      let tree = null;
      const rerender = () => {
        pendingEffects = [];
        tree = resolve(renderFn(), 'root');
        const current = pendingEffects;
        pendingEffects = [];
        for (const fn of current) fn();
        return tree;
      };
      rerender();
      return {
        get tree() { return tree; },
        rerender,
        unmount() {
          for (const slot of slots.values()) {
            for (const entry of slot.effects) {
              if (typeof entry.cleanup === 'function') entry.cleanup();
            }
          }
        },
      };
    },
  };
}

function findAll(node, pred, acc = []) {
  if (node == null || typeof node !== 'object') return acc;
  if (Array.isArray(node)) {
    for (const item of node) findAll(item, pred, acc);
    return acc;
  }
  if (pred(node)) acc.push(node);
  if (node.props?.children) findAll(node.props.children, pred, acc);
  return acc;
}

const PROFILES = [
  { name: 'default', displayName: 'Default', isDefault: true, activityState: 'read', timestamp: NOW_MS - 1000 },
];

const NOOP = () => {};

test('1. 群聊列表为空时桌面端分组左轨与移动端首屏均隐藏整个群聊分组', () => {
  setLocale('zh-CN');

  const renderDesktopGrouped = (groups, extra = {}) => {
    const groupedModel = buildGroupedLeftRailModel({
      activeSessionId: '',
      profiles: PROFILES,
      groups,
      sessions: [],
      profileName: 'default',
      searchQuery: '',
      nowMs: NOW_MS,
      ...extra,
    });
    return renderToStaticMarkup(
      React.createElement(GroupedLeftRail, {
        model: {
          currentFocus: { type: 'bot', botName: 'default' },
          selectedAgent: PROFILES[0],
          isDefaultHq: true,
          defaultAgent: PROFILES[0],
          otherAgents: [],
          activeSessions: [],
          archivedSessions: [],
          visibleGroups: groups,
          projectContainers: [],
          folderContainers: [],
          unassignedGroups: groups,
          unassignedSessions: [],
          doneItems: [],
          doneIsCollapsed: true,
          doneEffectiveExpanded: false,
          showDoneSection: false,
          doneLoading: false,
          doneError: '',
          isSessionsOpen: true,
          isGroupsOpen: true,
          profilesPhase: 'ready',
          sessionsPhase: 'ready',
          error: '',
        },
        layout: 'grouped',
        groupedModel,
        collapsed: false,
        searchQuery: '',
        onSelectSession: NOOP,
        onSelectBot: NOOP,
        onSelectGroup: NOOP,
        onOpenSessionMenu: NOOP,
        onOpenBotMenu: NOOP,
        onOpenGroupMenu: NOOP,
        onSearchChange: NOOP,
        onNewChat: NOOP,
        onToggleSessions: NOOP,
        onToggleGroups: NOOP,
        onStartGroupRename: NOOP,
        onConfirmGroupRename: NOOP,
        onCancelGroupRename: NOOP,
        onResizeStart: NOOP,
      }),
    );
  };

  const renderMobileHome = (groups) => {
    const homeModel = buildMobileHomeModel({
      activeSessionId: '',
      profiles: PROFILES,
      groups,
      sessions: [],
      profileName: 'default',
      searchQuery: '',
      collapsed: { bots: false, groups: false, sessions: false },
      nowMs: NOW_MS,
    });
    return renderToStaticMarkup(
      React.createElement(MobileHomeScreen, {
        homeTab: 'chats',
        model: homeModel,
        allProfiles: PROFILES,
        groupAvatars: PROFILES,
        activeBotName: 'default',
        gatewayConnected: true,
        gatewayConnecting: false,
        searchOpen: false,
        settingsSnapshot: {
          locale: 'zh',
          appVersion: '0.1.0',
          busy: false,
          gateway: { url: '', username: '', status: 'connected' },
          mcp: { status: 'idle', data: [] },
          skills: { status: 'idle', data: [] },
          providerViews: { status: 'idle', data: [] },
          fontPrefs: { uiFont: 'system', monoFont: 'system', sizeScale: 'medium' },
          activityVariant: 'prolate-lattice',
        },
        modelDetails: [],
        onSelectHomeTab: NOOP,
        onSelectBotSubpage: NOOP,
        onOpenSettings: NOOP,
        onOpenSettingsGateway: NOOP,
        onOpenSearch: NOOP,
        onCloseSearch: NOOP,
        onSearchChange: NOOP,
        onOpenNewChat: NOOP,
        onToggleSection: NOOP,
        onSelectBot: NOOP,
        onSelectGroup: NOOP,
        onSelectSession: NOOP,
        onOpenActionSheet: NOOP,
        settingsActions: { onClose: NOOP },
      }),
    );
  };

  // 空群聊时不渲染群聊分组
  const emptyDesktop = renderDesktopGrouped([]);
  assert.equal(emptyDesktop.includes('rail-groups-accordion-trigger'), false);
  assert.equal(emptyDesktop.includes('暂无协同群聊'), false);

  const emptyMobile = renderMobileHome([]);
  assert.equal(emptyMobile.includes('data-section="groups"'), false);
  assert.equal(emptyMobile.includes('暂无协同群聊'), false);

  // 非空群聊正常渲染
  const groups = [{ roomId: 'r1', name: '架构研判群', members: ['default'], updatedAt: NOW_MS }];
  const withGroupsDesktop = renderDesktopGrouped(groups);
  assert.equal(withGroupsDesktop.includes('rail-groups-accordion-trigger'), true);
  assert.equal(withGroupsDesktop.includes('架构研判群'), true);

  const withGroupsMobile = renderMobileHome(groups);
  assert.equal(withGroupsMobile.includes('data-section="groups"'), true);
  assert.equal(withGroupsMobile.includes('架构研判群'), true);

  // 所有群聊均被归入文件夹时同样隐藏未归类群聊分组
  const assignedDesktop = renderDesktopGrouped(groups, {
    folders: [{ id: 'fld-1', name: '工作区', order: 0 }],
    assignments: { 'room:r1': 'fld-1' },
  });
  assert.equal(assignedDesktop.includes('rail-groups-accordion-trigger'), false);
  assert.equal(assignedDesktop.includes('架构研判群'), true);
});

test('2. 移动端连续多次推理过程与工具调用合并为单一按时间序分组胶囊，且流式锚点与屏障隔离不被破坏', () => {
  setLocale('zh-CN');

  // 2.1 复现截图场景：首条思考+工具后紧跟 12 条连续 thought-only，最后落盘正文
  const messages = [
    {
      id: 'm-0',
      role: 'assistant',
      content: '',
      thought: '第 1 段推理：先探测服务连通性',
      toolCalls: Array.from({ length: 14 }, (_, i) => ({
        id: `t-${i}`,
        name: 'terminal',
        status: 'completed',
        args: `cmd ${i}`,
      })),
    },
    ...Array.from({ length: 12 }, (_, idx) => ({
      id: `m-${idx + 1}`,
      role: 'assistant',
      content: '',
      thought: `第 ${idx + 2} 段推理：继续排查端口`,
    })),
    {
      id: 'm-13',
      rowId: 42,
      role: 'assistant',
      content: '能。而且不用绕腾讯云——直接连也通了，是端口的问题。',
      timestamp: '11/25 21:41',
    },
  ];

  const consolidated = consolidateMobileTurnTraces(messages, false);
  assert.equal(consolidated.length, 1, '13 段连续推理+工具必须合并到末条正文载具行');
  assert.equal(consolidated[0].message.id, 'm-13');
  assert.equal(consolidated[0].message.rowId, 42);
  assert.equal(consolidated[0].traceSteps?.length, 13);

  const html = renderToStaticMarkup(
    React.createElement(TurnGroup, {
      messages,
      mode: 'scratchpad',
      isLastTurn: true,
      isStreaming: false,
      compactTrace: true,
    }),
  );
  const pillCount = (html.match(/class="m-trace-pill"/g) ?? []).length;
  assert.equal(pillCount, 1, '全回合只能渲染 1 枚紧凑轨迹胶囊，严禁叠出十余条已记录推理过程');
  assert.equal(html.includes('已记录推理过程'), false);
  assert.equal(html.includes('0.8s'), false, '无耗时数据时不得伪造 0.8s 假时长');
  assert.ok(html.includes('已思考 · 执行 14 步操作'));
  assert.ok(html.includes('第 1 段推理：先探测服务连通性'));
  assert.ok(html.includes('第 13 段推理：继续排查端口'));
  assert.ok(html.includes('能。而且不用绕腾讯云——直接连也通了，是端口的问题。'));

  // 2.2 纯多段思考（无工具调用）：无时长汇总显示段数，有时长累加求和
  const thoughtMultiHtml = renderToStaticMarkup(
    React.createElement(CompactTraceCapsule, {
      messageId: 'm-multi',
      tools: [],
      isStreaming: false,
      steps: [
        { id: 's1', thought: '分析 A', tools: [] },
        { id: 's2', thought: '分析 B', tools: [] },
        { id: 's3', thought: '分析 C', tools: [] },
      ],
    }),
  );
  assert.ok(thoughtMultiHtml.includes('已记录 3 段推理过程'));
  assert.equal((thoughtMultiHtml.match(/class="m-trace-step"/g) ?? []).length, 3);

  setLocale('en-US');
  const enThoughtHtml = renderToStaticMarkup(
    React.createElement(CompactTraceCapsule, {
      messageId: 'm-en',
      tools: [],
      isStreaming: false,
      steps: [
        { id: 's1', thought: 'Step 1', tools: [] },
        { id: 's2', thought: 'Step 2', tools: [] },
      ],
    }),
  );
  assert.ok(enThoughtHtml.includes('2 reasoning steps'));
  setLocale('zh-CN');

  const timedMultiHtml = renderToStaticMarkup(
    React.createElement(CompactTraceCapsule, {
      messageId: 'm-timed',
      tools: [],
      isStreaming: false,
      steps: [
        { id: 's1', thought: 'A', thoughtDurationMs: 1200, tools: [] },
        { id: 's2', thought: 'B', thoughtDurationMs: 800, tools: [] },
      ],
    }),
  );
  assert.ok(timedMultiHtml.includes('已思考 2.0s'));

  // 2.3 中间夹杂正文与压缩/时间线屏障时分段合并，群聊发送者头像/昵称保留到承接行
  const interleaved = [
    { id: 'i1', role: 'assistant', sender: 'Arch', senderAvatar: 'av://arch', content: '', thought: 't1' },
    { id: 'i2', role: 'assistant', content: '中间回答', thought: 't2' },
    { id: 'i3', role: 'assistant', content: '', displayKind: 'compaction', displayMetadata: {} },
    { id: 'i4', role: 'assistant', content: '', thought: 't3' },
    { id: 'i5', role: 'assistant', content: '', thought: 't4', toolCalls: [{ id: 'dt', name: 'delegate_task', status: 'completed', args: '{"role":"Reviewer"}' }] },
  ];
  const interRows = consolidateMobileTurnTraces(interleaved, false);
  assert.equal(interRows.length, 3);
  assert.equal(interRows[0].message.sender, 'Arch');
  assert.equal(interRows[0].traceSteps?.length, 2);
  assert.equal(interRows[1].message.id, 'i3');
  assert.equal(interRows[2].message.id, 'i5');
  assert.equal(interRows[2].traceSteps?.length, 2);

  // 2.4 正在流式的末条消息绝不参与合并，直写锚点常驻
  const streamingConsolidated = consolidateMobileTurnTraces(
    [
      { id: 'st1', role: 'assistant', content: '', thought: '前置思考 1' },
      { id: 'st2', role: 'assistant', content: '', thought: '前置思考 2' },
      { id: 'st3', role: 'assistant', content: '', thought: '' },
    ],
    true,
  );
  assert.equal(streamingConsolidated.length, 2);
  assert.equal(streamingConsolidated[0].traceSteps?.length, 2);
  assert.equal(streamingConsolidated[1].message.id, 'st3');
  assert.equal(streamingConsolidated[1].traceSteps, undefined);

  const streamHtml = renderToStaticMarkup(
    React.createElement(TurnGroup, {
      messages: [
        { id: 'st1', role: 'assistant', content: '', thought: '前置思考 1' },
        { id: 'st2', role: 'assistant', content: '', thought: '前置思考 2' },
        { id: 'st3', role: 'assistant', content: '', thought: '' },
      ],
      mode: 'scratchpad',
      isLastTurn: true,
      isStreaming: true,
      compactTrace: true,
    }),
  );
  assert.ok(streamHtml.includes('id="msg-thought-st3"'));
  assert.ok(streamHtml.includes('id="msg-tools-st3"'));

  // 2.5 桌面端 compactTrace=false 保持原有行为不变
  const desktopHtml = renderToStaticMarkup(
    React.createElement(ConversationMessageList, {
      snapshot: {
        mode: 'scratchpad',
        connection: 'connected',
        isStreaming: false,
        compactTrace: false,
        messages,
      },
    }),
  );
  assert.equal(desktopHtml.includes('data-mobile-trace='), false);

  // 2.6 流式首帧空锚点与工具 DOM 所有权交接（无 .m-trace-dot，#msg-tools-* 按 streaming/settled 换 key）
  const emptyStreamingHtml = renderToStaticMarkup(
    React.createElement(CompactTraceCapsule, {
      messageId: 's-empty',
      thought: '',
      tools: [],
      isStreaming: true,
    }),
  );
  assert.ok(emptyStreamingHtml.includes('data-mobile-trace-empty="true"'));
  assert.ok(emptyStreamingHtml.includes('id="msg-thought-s-empty"'));
  assert.ok(emptyStreamingHtml.includes('id="msg-tools-s-empty"'));
  assert.ok(emptyStreamingHtml.includes('activity-pulse-indicator'));
  assert.equal(emptyStreamingHtml.includes('m-trace-dot'), false);

  const runningTool = { id: 'rt-1', name: 'terminal', status: 'running', args: '{"cmd":"ls"}' };
  const completedTool = { id: 'rt-1', name: 'terminal', status: 'completed', args: '{"cmd":"ls"}', output: 'ok' };
  const capsuleDriver = createHookDriver({}, { shallowComponents: [ToolCapsule] });
  let streamingMode = true;
  let readOnlyMode = true;
  let currentTools = [runningTool];
  const subDetailCalls = [];
  const subTool = { id: 'sub-1', name: 'delegate_task', status: 'running', args: '{"role":"Reviewer"}' };
  const capsuleView = capsuleDriver.mount(() =>
    React.createElement(CompactTraceCapsule, {
      messageId: 's-run',
      thought: '',
      tools: [...currentTools, subTool],
      isStreaming: streamingMode,
      readOnly: readOnlyMode,
      onOpenSubagentDetail: (payload) => subDetailCalls.push(payload),
    }),
  );
  const streamingToolsDiv = findAll(capsuleView.tree, (n) => n.props?.id === 'msg-tools-s-run')[0];
  assert.ok(streamingToolsDiv);
  assert.equal(streamingToolsDiv.key, 'tools-streaming');
  const streamingToolsChildren = Array.isArray(streamingToolsDiv.props.children)
    ? streamingToolsDiv.props.children.filter(Boolean)
    : streamingToolsDiv.props.children
      ? [streamingToolsDiv.props.children]
      : [];
  assert.equal(streamingToolsChildren.length, 0, '流式态 #msg-tools-* 必须保持零 React 子节点以免撞车 toolPatchQueue');

  // 折叠切换与子代理点击交互
  const tracePill = findAll(capsuleView.tree, (n) => n.props?.className === 'm-trace-pill')[0];
  assert.equal(tracePill.props['aria-expanded'], false);
  tracePill.props.onClick();
  capsuleView.rerender();
  assert.equal(findAll(capsuleView.tree, (n) => n.props?.className === 'm-trace-pill')[0].props['aria-expanded'], true);
  assert.equal(findAll(capsuleView.tree, (n) => n.props?.className === 'm-trace-capsule')[0].props['data-open'], 'true');

  findAll(capsuleView.tree, (n) => n.props?.className === 'm-subagent-bar')[0].props.onClick();
  assert.equal(subDetailCalls.length, 1);
  assert.equal(subDetailCalls[0].messageId, 's-run');
  assert.equal(subDetailCalls[0].tools[0].id, 'sub-1');

  // 流式收口后 key 从 tools-streaming 切换到 tools-settled 且透传 readOnly
  streamingMode = false;
  currentTools = [completedTool];
  capsuleView.rerender();
  const settledToolsDiv = findAll(capsuleView.tree, (n) => n.props?.id === 'msg-tools-s-run')[0];
  assert.equal(settledToolsDiv.key, 'tools-settled');
  const settledCapsules = findAll(settledToolsDiv, (n) => n.type === ToolCapsule);
  assert.equal(settledCapsules.length, 1);
  assert.equal(settledCapsules[0].props.actionEnabled, false, 'readOnly=true 时必须传入 actionEnabled=false');

  readOnlyMode = false;
  capsuleView.rerender();
  const writableCapsules = findAll(capsuleView.tree, (n) => n.type === ToolCapsule);
  assert.equal(writableCapsules[0].props.actionEnabled, true, 'readOnly=false 时必须传入 actionEnabled=true');
  capsuleView.unmount();
});

test('3 & 5. 移动端紧凑页脚（时间+复制+...浮层）、全新回滚/Fork 图标及长按复制 CSS 契约', async () => {
  setLocale('zh-CN');

  const userMsg = {
    id: 'u-1',
    rowId: 77,
    role: 'user',
    content: '帮我查一下端口',
    timestamp: '11/25 21:40',
  };
  const astMsg = {
    id: 'a-1',
    rowId: 78,
    role: 'assistant',
    content: '已排查完毕',
    model: 'claude-sonnet-4',
    durationMs: 1400,
    timestamp: '11/25 21:41',
  };

  // 3.1 桌面端：直接展示新样式图标（lucide-rotate-ccw & lucide-git-fork），无 ... 按钮
  const desktopFooterHtml = renderToStaticMarkup(
    React.createElement(ConversationMessageFooter, {
      message: astMsg,
      mode: 'scratchpad',
      role: 'assistant',
      meta: React.createElement('span', { className: 'model-tag' }, 'claude-sonnet-4'),
    }),
  );
  assert.ok(desktopFooterHtml.includes('data-action="copy-msg"'));
  assert.ok(desktopFooterHtml.includes('data-action="rollback-msg"'));
  assert.ok(desktopFooterHtml.includes('data-action="fork-msg"'));
  assert.ok(desktopFooterHtml.includes('lucide-rotate-ccw'), '桌面端回滚图标必须升级为 lucide RotateCcw');
  assert.ok(desktopFooterHtml.includes('lucide-git-fork'), '桌面端 Fork 图标必须升级为 lucide GitFork');
  assert.equal(desktopFooterHtml.includes('msg-more-actions-btn'), false);

  // 3.2 移动端普通会话（用户 + 助手）：默认只展示日期时间 + 复制 + ...，助手消息抑制模型/耗时元标签
  const mobileUserDefaultHtml = renderToStaticMarkup(
    React.createElement(ConversationMessageFooter, {
      message: userMsg,
      mode: 'scratchpad',
      role: 'user',
      compactActions: true,
    }),
  );
  assert.ok(mobileUserDefaultHtml.includes('11/25 21:40'));
  assert.ok(mobileUserDefaultHtml.includes('data-action="copy-msg"'));
  assert.ok(mobileUserDefaultHtml.includes('data-testid="msg-more-actions-btn"'));
  assert.equal(mobileUserDefaultHtml.includes('data-action="rollback-msg"'), false, '默认折叠时不得直接暴露回滚按钮');
  assert.equal(mobileUserDefaultHtml.includes('data-action="fork-msg"'), false, '默认折叠时不得直接暴露 Fork 按钮');

  const mobileAssistantDefaultHtml = renderToStaticMarkup(
    React.createElement(ConversationMessageFooter, {
      message: astMsg,
      mode: 'scratchpad',
      role: 'assistant',
      compactActions: true,
      meta: React.createElement('span', { className: 'model-tag' }, 'claude-sonnet-4'),
    }),
  );
  assert.ok(mobileAssistantDefaultHtml.includes('11/25 21:41'));
  assert.ok(mobileAssistantDefaultHtml.includes('data-action="copy-msg"'));
  assert.ok(mobileAssistantDefaultHtml.includes('data-testid="msg-more-actions-btn"'));
  assert.equal(mobileAssistantDefaultHtml.includes('claude-sonnet-4'), false, '移动端紧凑页脚必须抑制 model-tag');
  assert.equal(mobileAssistantDefaultHtml.includes('model-tag'), false);

  // 3.3 移动端 Bot 工位 / 群聊 / readOnly：只显示时间 + 复制，连 ... 按钮也不显示
  for (const [mode, readOnly] of [['foreground', false], ['group', false], ['scratchpad', true]]) {
    const restrictedHtml = renderToStaticMarkup(
      React.createElement(ConversationMessageFooter, {
        message: astMsg,
        mode,
        role: 'assistant',
        readOnly,
        compactActions: true,
      }),
    );
    assert.ok(restrictedHtml.includes('data-action="copy-msg"'));
    assert.equal(restrictedHtml.includes('msg-more-actions-btn'), false, `mode=${mode} readOnly=${readOnly} 禁止渲染更多菜单`);
  }

  // 3.4 交互测试：点开 ... 浮层展现带新图标的回滚与 Fork 按钮，点击菜单项经微任务自动收起，点外侧/Esc 收起
  const prevDoc = globalThis.document;
  const docListeners = new Map();
  globalThis.document = {
    addEventListener(type, fn) {
      if (!docListeners.has(type)) docListeners.set(type, new Set());
      docListeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      docListeners.get(type)?.delete(fn);
    },
  };

  try {
    let containsTarget = false;
    const driver = createHookDriver({ contains: () => containsTarget });
    const view = driver.mount(() =>
      React.createElement(ConversationMessageFooter, {
        message: astMsg,
        mode: 'scratchpad',
        role: 'assistant',
        compactActions: true,
      }),
    );

    const moreBtn = findAll(view.tree, (n) => n.props?.['data-testid'] === 'msg-more-actions-btn')[0];
    assert.ok(moreBtn);
    moreBtn.props.onClick();
    view.rerender();

    const menu = findAll(view.tree, (n) => n.props?.['data-testid'] === 'msg-more-actions-menu')[0];
    assert.ok(menu, '点击 ... 后必须展开操作浮层菜单');
    const menuItems = findAll(menu, (n) => n.type === 'button');
    assert.equal(menuItems.length, 2);
    assert.equal(menuItems[0].props['data-action'], 'rollback-msg');
    assert.equal(menuItems[0].props['data-msg-id'], 'a-1');
    assert.equal(menuItems[0].props['data-row-id'], 78);
    assert.equal(menuItems[1].props['data-action'], 'fork-msg');
    assert.equal(menuItems[1].props['data-msg-id'], 'a-1');

    // 点击菜单项后需通过 queueMicrotask 自动关菜单（同步期未提前卸载以保障点击事件冒泡）
    menuItems[0].props.onClick();
    await Promise.resolve();
    view.rerender();
    assert.equal(findAll(view.tree, (n) => n.props?.['data-testid'] === 'msg-more-actions-menu').length, 0);

    findAll(view.tree, (n) => n.props?.['data-testid'] === 'msg-more-actions-btn')[0].props.onClick();
    view.rerender();
    const reopenedItems = findAll(
      findAll(view.tree, (n) => n.props?.['data-testid'] === 'msg-more-actions-menu')[0],
      (n) => n.type === 'button',
    );
    reopenedItems[1].props.onClick();
    await Promise.resolve();
    view.rerender();
    assert.equal(findAll(view.tree, (n) => n.props?.['data-testid'] === 'msg-more-actions-menu').length, 0);

    // 重新打开后点击菜单内部元素时不因 outside pointerdown 提前关掉，保障原生 click 冒泡到 #conversation-stream
    findAll(view.tree, (n) => n.props?.['data-testid'] === 'msg-more-actions-btn')[0].props.onClick();
    view.rerender();
    containsTarget = true;
    for (const fn of docListeners.get('pointerdown') ?? []) fn({ target: {} });
    view.rerender();
    assert.ok(findAll(view.tree, (n) => n.props?.['data-testid'] === 'msg-more-actions-menu')[0]);

    // 点击外部关闭菜单
    containsTarget = false;
    for (const fn of docListeners.get('pointerdown') ?? []) fn({ target: {} });
    view.rerender();
    assert.equal(findAll(view.tree, (n) => n.props?.['data-testid'] === 'msg-more-actions-menu').length, 0);

    // 再次打开后按 Esc 关闭
    findAll(view.tree, (n) => n.props?.['data-testid'] === 'msg-more-actions-btn')[0].props.onClick();
    view.rerender();
    assert.ok(findAll(view.tree, (n) => n.props?.['data-testid'] === 'msg-more-actions-menu')[0]);
    for (const fn of docListeners.get('keydown') ?? []) fn({ key: 'Escape' });
    view.rerender();
    assert.equal(findAll(view.tree, (n) => n.props?.['data-testid'] === 'msg-more-actions-menu').length, 0);

    view.unmount();
  } finally {
    globalThis.document = prevDoc;
  }

  // 3.5 CSS 契约：保留正文长按文本选中 + 无重叠 44x44 热区 + 回滚取消 >=44px + 零 .m-trace-dot 无限关键帧
  const mobileCss = fs.readFileSync(
    path.resolve(import.meta.dirname, '../src/styles/mobile-shell.css'),
    'utf8',
  );
  const convCss = fs.readFileSync(
    path.resolve(import.meta.dirname, '../src/styles/conversation.css'),
    'utf8',
  );
  assert.match(mobileCss, /\.m-shell\s+\.conv-message__bubble[\s\S]*user-select:\s*text/);
  assert.match(mobileCss, /\.m-shell\s+\.conv-footer__menu-item[\s\S]*min-height:\s*44px/);
  assert.match(mobileCss, /\.m-shell\s+\.conv-message__actions\s*\{[\s\S]*gap:\s*12px/);
  assert.match(mobileCss, /\.m-shell\s+\.conv-message__actions\s*>\s*\.msg-action-btn[\s\S]*width:\s*32px/);
  assert.match(mobileCss, /\.m-shell\s+\.conv-footer__more-btn::before[\s\S]*inset:\s*-6px/);
  assert.match(mobileCss, /\.m-stage__rollback-cancel[\s\S]*min-height:\s*44px/);
  assert.equal(mobileCss.includes('.m-trace-dot'), false);
  assert.equal(mobileCss.includes('@keyframes m-pulse-dot'), false);
  assert.match(convCss, /\.conv-footer__menu\s*\{[\s\S]*background:\s*var\(--popover\)/);
  assert.match(convCss, /\.conv-footer__menu-item\s*\{/);
});
