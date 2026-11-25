/**
 * 移动端 React 表现壳组件、轨迹折叠胶囊与 CSS 哑光契约全覆盖测试
 * (packages/ui/__tests__/mobile-workspace-shell.test.mjs)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { setLocale, t } from '../dist/i18n/index.js';
import {
  DEFAULT_MOBILE_SECTIONS_COLLAPSED,
  MobileBotHubScreen,
  MobileBotSaveBar,
  MobileBotSubpagePanel,
  MobileBotWizardSheet,
  MobileConstellationPanel,
  MobileConversationScreen,
  MobileEntityRow,
  MobileHomeScreen,
  MobileInspectorScreen,
  MobileMenuCard,
  MobileModelPickerSheet,
  MobileMorphingComposer,
  MobileNewChatSheet,
  MobileSettingsPage,
  MobileSubagentSheet,
  MobileWorkspaceShell,
  buildMobileHomeModel,
  mountMobileWorkspaceShell,
  reduceMobileBackAction,
  runMobileMcpRemove,
  runMobileMcpTest,
} from '../dist/components-react/mobile/index.js';
import { AvatarProcessingError } from '../dist/utils/cropAvatar.js';
import {
  CompactTraceCapsule,
  ConversationMessageList,
  MessageAttachments,
  MessageRow,
  TurnGroup,
  isSubagentTool,
  partitionMobileTools,
} from '../dist/components-react/conversation/index.js';
import { renderGroupCollageAvatar } from '../dist/utils/botAvatar.js';
import {
  CognitiveSkillList,
  CognitiveStarMapCanvas,
  CognitiveStarMapPanel,
  ConstellationNodeDetailDialog,
} from '../dist/components-react/learning/index.js';
import { layoutFullConstellationGraph } from '@hermes-flux/core';

const NOW_MS = Date.UTC(2026, 10, 21, 10, 0, 0);

/**
 * 轻量同步 React 19 函数组件测试驱动：真实运行组件 Hook、memo 与子树事件回调。
 */
function createReactHookDriver(options = {}) {
  const { attachRefs = true, defaultClientWidth = 390, refOverrides = {} } = options;
  const slots = new Map();
  let pendingEffects = [];

  function makeMockRefEl(overrides = {}) {
    return {
      focusCalls: 0,
      focus() {
        this.focusCalls += 1;
      },
      blur() {},
      click() {},
      style: {},
      scrollHeight: 64,
      clientWidth: defaultClientWidth,
      clientHeight: 844,
      ...refOverrides,
      ...overrides,
    };
  }

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
      return {
        ...node,
        props: {
          ...node.props,
          children: resolve(node.props?.children, `${key}.frag`),
        },
      };
    }

    if (
      elType &&
      typeof elType === 'object' &&
      (elType.$$typeof === Symbol.for('react.context') || elType.$$typeof === Symbol.for('react.provider'))
    ) {
      const ctx = elType._context ?? elType;
      const prevVal = ctx._currentValue;
      ctx._currentValue = node.props?.value;
      try {
        return {
          ...node,
          props: {
            ...node.props,
            children: resolve(node.props?.children, `${key}.ctx`),
          },
        };
      } finally {
        ctx._currentValue = prevVal;
      }
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
          if (idx >= slot.states.length) {
            slot.states.push(typeof init === 'function' ? init() : init);
          }
          const setter = (next) => {
            slot.states[idx] = typeof next === 'function' ? next(slot.states[idx]) : next;
          };
          return [slot.states[idx], setter];
        },
        useReducer(reducer, initialArg, init) {
          const idx = sIdx++;
          if (idx >= slot.states.length) {
            slot.states.push(init ? init(initialArg) : initialArg);
          }
          const dispatch = (action) => {
            slot.states[idx] = reducer(slot.states[idx], action);
          };
          return [slot.states[idx], dispatch];
        },
        useImperativeHandle(ref, create) {
          if (typeof ref === 'function') ref(create());
          else if (ref) ref.current = create();
        },
        useTransition() {
          return [false, (fn) => fn()];
        },
        useDeferredValue(val) {
          return val;
        },
        use(usable) {
          return usable?._currentValue;
        },
        useRef(init) {
          const idx = rIdx++;
          if (idx >= slot.refs.length) {
            slot.refs.push({ current: init });
          }
          return slot.refs[idx];
        },
        useMemo(factory, deps) {
          const idx = mIdx++;
          if (idx >= slot.memos.length) {
            slot.memos.push({ value: factory(), deps });
          } else {
            const prev = slot.memos[idx];
            const changed = !deps || !prev.deps || deps.some((d, i) => !Object.is(d, prev.deps[i]));
            if (changed) {
              slot.memos[idx] = { value: factory(), deps };
            }
          }
          return slot.memos[idx].value;
        },
        useCallback(cb) {
          return cb;
        },
        useEffect: scheduleEffect,
        useLayoutEffect: scheduleEffect,
        useInsertionEffect: scheduleEffect,
        useDebugValue() {},
        useId() {
          return `id-${scopedKey}`;
        },
        useContext(ctx) {
          return ctx?._currentValue;
        },
        useSyncExternalStore(_sub, getSnap) {
          return getSnap();
        },
      };
      let rendered;
      try {
        rendered = compFn(node.props);
      } finally {
        internals.H = prevH;
      }
      return resolve(rendered, `${scopedKey}>${compFn.name || 'Fn'}`);
    }

    if (attachRefs) {
      const refObj = node.props?.ref ?? node.ref;
      if (refObj && typeof refObj === 'object' && !refObj.current) {
        refObj.current = makeMockRefEl();
      }
    }

    if (node.props && 'children' in node.props) {
      return {
        ...node,
        props: {
          ...node.props,
          children: resolve(node.props.children, key),
        },
      };
    }
    return node;
  }

  return {
    mount(renderFn) {
      let tree = null;
      const rerender = () => {
        pendingEffects = [];
        tree = resolve(renderFn(), 'root');
        const currentEffects = pendingEffects;
        pendingEffects = [];
        for (const effect of currentEffects) {
          effect();
        }
        return tree;
      };
      rerender();
      return {
        get tree() {
          return tree;
        },
        rerender,
        unmount() {
          for (const slot of slots.values()) {
            for (const entry of slot.effects) {
              if (typeof entry.cleanup === 'function') {
                entry.cleanup();
                entry.cleanup = undefined;
              }
            }
          }
        },
      };
    },
  };
}

function findAll(node, predicate, acc = []) {
  if (!node || typeof node !== 'object') return acc;
  if (Array.isArray(node)) {
    for (const item of node) findAll(item, predicate, acc);
    return acc;
  }
  if (predicate(node)) acc.push(node);
  if (node.props && 'children' in node.props) {
    findAll(node.props.children, predicate, acc);
  }
  return acc;
}

function createSampleData() {
  const profiles = [
    {
      name: 'default',
      displayName: '默认中枢',
      description: '统筹所有日常工作',
      isDefault: true,
      avatar: 'data:image/png;base64,abc',
      lastMessage: '准备完毕',
      timestamp: NOW_MS - 1000,
      activityState: 'running',
      activityTransition: 'start',
    },
    {
      name: 'arch',
      displayName: '架构老王',
      description: '代码审查与方案架构',
      lastMessage: '设计已更新',
      timestamp: NOW_MS - 2000,
      activityState: 'read',
    },
  ];
  const groups = [
    {
      roomId: 'room-1',
      name: '移动端架构小组',
      members: ['default', 'arch'],
      lastMessage: '对齐手势方案',
      updatedAt: NOW_MS - 1500,
      activityState: 'running',
    },
  ];
  const sessions = [
    {
      id: 'sess-1',
      title: '调试 WebSocket 状态机',
      botName: 'arch',
      preview: '检查重连时序',
      isPinned: true,
      timestamp: NOW_MS - 1200,
      activityState: 'running',
    },
  ];
  const homeModel = buildMobileHomeModel({
    activeSessionId: 'sess-1',
    profiles,
    groups,
    sessions,
    profileName: 'default',
    searchQuery: '',
    collapsed: DEFAULT_MOBILE_SECTIONS_COLLAPSED,
    nowMs: NOW_MS,
  });

  const snapshot = {
    platform: 'android',
    appVersion: '0.1.0',
    theme: 'obsidian-gold',
    appearancePref: 'dark',
    locale: 'zh',
    gatewayConnected: true,
    gatewayConnecting: false,
    homeModel,
    homeTab: 'chats',
    allProfiles: profiles,
    groupAvatars: profiles,
    activePane: 'home',
    searchOpen: false,
    searchQuery: '',
    newChatOpen: false,
    newChatStep: 'compose',
    newChatTargetKind: 'bot',
    newChatTargetBot: 'default',
    newChatGroupMembers: [],
    newChatGroupName: '',
    newChatStats: { pluginsCount: 5, mcpCount: 2, skillsCount: 12 },
    settingsOpen: false,
    settingsSubpage: null,
    botSubpage: null,
    settingsSnapshot: {
      isOpen: false,
      section: 'appearance',
      theme: 'obsidian-gold',
      locale: 'zh',
      fontPrefs: { uiFont: 'system', monoFont: 'jetbrains-mono', sizeScale: 'medium' },
      activityVariant: 'prolate-lattice',
      conversationWidth: 'wide',
      leftRailLayout: 'dual-rail',
      presenceLayout: 'stage',
      providers: { status: 'idle' },
      providerViews: { status: 'ready', data: [] },
      providerFailures: [],
      subscriptionCatalog: { status: 'ready', data: [] },
      customEndpoints: { status: 'ready', data: [] },
      endpointProfiles: {},
      endpointFailures: [],
      bots: profiles.map((p) => ({ profile: p.name, displayName: p.displayName, avatar: p.avatar })),
      scopedProfile: 'default',
      profiles: { status: 'ready', data: profiles },
      botManagement: {
        status: { status: 'editing', activeBotId: 'default' },
        activeBotId: 'default',
        roster: [
          { id: 'default', displayName: '默认中枢', model: 'anthropic/claude-sonnet-4', avatar: 'data:image/png;base64,abc', isDefault: true, hasDraft: false },
          { id: 'arch', displayName: '架构老王', model: 'openai/gpt-4o', avatar: '', isDefault: false, hasDraft: false },
          { id: 'ops', displayName: '运维官', model: '', avatar: '', isDefault: false, hasDraft: true },
        ],
        activeDetail: {
          id: 'default',
          displayName: '默认中枢',
          description: '统筹所有日常工作',
          model: 'anthropic/claude-sonnet-4',
          provider: 'anthropic',
          soul: '# Soul\nKeep concise',
          isDefault: true,
          avatar: 'data:image/png;base64,abc',
          toolsets: { authoritative: true, rows: [{ id: 't1', label: 'Terminal', enabled: true, description: 'shell' }] },
          skills: { authoritative: true, rows: [{ id: 'sk1', label: 'git-ops', enabled: true, description: 'git helper' }] },
          mcpServers: { authoritative: true, rows: [{ id: 'mcp1', label: 'fs', enabled: true, online: true, transport: 'stdio' }] },
        },
        availableModels: [
          { id: 'anthropic/claude-sonnet-4', name: 'Claude Sonnet 4', provider: 'anthropic', providerName: 'Anthropic' },
          { id: 'openai/gpt-4o', name: 'GPT-4o', provider: 'openai', providerName: 'OpenAI' },
        ],
        isBusy: false,
        wizard: {
          open: false,
          busy: false,
          draft: {
            mode: 'blank',
            name: '',
            displayName: '',
            description: '',
            model: '',
            provider: '',
            cloneFrom: '',
            cloneChannels: true,
            mirrorCredentials: true,
          },
        },
        exitPrompt: null,
      },
      providerAdminBusy: false,
      mcp: { status: 'ready', data: [{ name: 'fs', transport: 'stdio', toolCount: 3, connected: true }] },
      skills: { status: 'ready', data: [{ name: 'git', category: 'official' }] },
      gateway: {
        url: 'http://127.0.0.1:9119',
        username: 'admin',
        hasStoredPassword: true,
        profileName: 'default',
        latencyMs: 12,
        status: 'connected',
        test: { ok: true, message: 'OK 12ms' },
      },
      appVersion: '0.1.0',
      platform: 'android',
      busy: false,
    },
    activeFocus: { type: 'session', sessionId: 'sess-1' },
    activeSessionId: 'sess-1',
    activeBotName: 'default',
    activeBotDisplayName: '默认中枢',
    isStreaming: false,
    messagesCount: 2,
    selectedModel: 'anthropic/claude-sonnet-4',
    availableModels: ['anthropic/claude-sonnet-4', 'openai/gpt-4o'],
    modelDetails: [
      { id: 'anthropic/claude-sonnet-4', provider: 'anthropic', displayName: 'Claude Sonnet 4' },
    ],
    attachments: [],
    dockNotice: '',
    inspectorTab: 'artifacts',
    inspectorReaderOpen: false,
    inspectorReaderItem: null,
    artifacts: [{ id: 'a1', name: 'spec.md', type: 'markdown', size: '4 KB', preview: '# Spec' }],
    gitDiffs: [{ file: 'src/app.ts', additions: 10, deletions: 2, patch: '+ const a = 1;' }],
    openFiles: [{ id: 'f1', path: 'src/main.ts', content: 'export const x = 1;', language: 'typescript' }],
    fileTreeState: { status: 'idle' },
    fileTreeExpandedPaths: [],
    fileTreeFilterQuery: '',
    activeFilePath: '',
    workspaceRootName: 'repo',
    memories: [{ category: '偏好', content: '纯哑光设计', updated: '刚刚' }],
    learningState: { status: 'idle' },
    learningDetail: { status: 'idle' },
    groupMembers: [{ name: 'default', displayName: '默认中枢' }],
    subagentSheet: null,
    actionSheet: null,
    sideAgentCapsules: [{ id: 'c1', kind: 'btw', profile: 'arch', question: 'check?', answer: 'ok', status: 'done' }],
  };

  const log = [];
  const actions = {
    onSelectPane: (p) => log.push(['onSelectPane', p]),
    onSelectHomeTab: (tab) => log.push(['onSelectHomeTab', tab]),
    onSelectBotSubpage: (sp) => log.push(['onSelectBotSubpage', sp]),
    onOpenSettingsSubpage: (sp) => log.push(['onOpenSettingsSubpage', sp]),
    onSelectBot: (b) => log.push(['onSelectBot', b]),
    onSelectGroup: (g) => log.push(['onSelectGroup', g]),
    onSelectSession: (s, b) => log.push(['onSelectSession', s, b]),
    onToggleSection: (sec) => log.push(['onToggleSection', sec]),
    onOpenSearch: () => log.push(['onOpenSearch']),
    onCloseSearch: () => log.push(['onCloseSearch']),
    onSearchChange: (q) => log.push(['onSearchChange', q]),
    onOpenActionSheet: (sh) => log.push(['onOpenActionSheet', sh]),
    onCloseActionSheet: () => log.push(['onCloseActionSheet']),
    onActionOpen: (sh) => log.push(['onActionOpen', sh]),
    onActionRename: (sh, tNew) => log.push(['onActionRename', sh, tNew]),
    onActionPin: (sh) => log.push(['onActionPin', sh]),
    onActionArchive: (sh) => log.push(['onActionArchive', sh]),
    onActionDelete: (sh) => log.push(['onActionDelete', sh]),
    onActionDisband: (sh) => log.push(['onActionDisband', sh]),
    onOpenNewChat: () => log.push(['onOpenNewChat']),
    onCloseNewChat: () => log.push(['onCloseNewChat']),
    onSetNewChatStep: (s) => log.push(['onSetNewChatStep', s]),
    onSelectNewChatBot: (b) => log.push(['onSelectNewChatBot', b]),
    onSetNewChatGroupMembers: (m) => log.push(['onSetNewChatGroupMembers', m]),
    onSetNewChatGroupName: (n) => log.push(['onSetNewChatGroupName', n]),
    onSubmitNewChatMessage: (txt) => log.push(['onSubmitNewChatMessage', txt]),
    onSendMessage: (txt) => log.push(['onSendMessage', txt]),
    onInterruptTurn: () => log.push(['onInterruptTurn']),
    onSelectModel: (m, p) => log.push(['onSelectModel', m, p]),
    onOpenAttachmentPicker: () => log.push(['onOpenAttachmentPicker']),
    onRemoveAttachment: (id) => log.push(['onRemoveAttachment', id]),
    onOpenSubagentSheet: (sh) => log.push(['onOpenSubagentSheet', sh]),
    onCloseSubagentSheet: () => log.push(['onCloseSubagentSheet']),
    onStageReady: () => log.push(['onStageReady']),
    onSelectInspectorTab: (tab) => log.push(['onSelectInspectorTab', tab]),
    onOpenInspectorItem: (item) => log.push(['onOpenInspectorItem', item]),
    onCloseInspectorReader: () => log.push(['onCloseInspectorReader']),
    onCopyInspectorText: (txt) => log.push(['onCopyInspectorText', txt]),
    onLoadFileTree: (force) => log.push(['onLoadFileTree', force]),
    onToggleFileTreeDir: (dirPath) => log.push(['onToggleFileTreeDir', dirPath]),
    onFilterFileTree: (q) => log.push(['onFilterFileTree', q]),
    onOpenWorkspaceFile: (fp) => log.push(['onOpenWorkspaceFile', fp]),
    onDownloadInspectorFile: () => log.push(['onDownloadInspectorFile']),
    onRefreshLearning: () => log.push(['onRefreshLearning']),
    onLoadLearningDetail: (id) => log.push(['onLoadLearningDetail', id]),
    onHapticSelection: () => log.push(['onHapticSelection']),
    onOpenSettings: () => log.push(['onOpenSettings']),
    onCloseSettings: () => log.push(['onCloseSettings']),
    onSelectSettingsSubpage: (sp) => log.push(['onSelectSettingsSubpage', sp]),
    onSetAppearancePreference: (ap) => log.push(['onSetAppearancePreference', ap]),
    settingsActions: {
      onClose: () => log.push(['settings.onClose']),
      onSelectSection: () => {},
      onThemeChange: () => {},
      onLocaleChange: (loc) => log.push(['settings.onLocaleChange', loc]),
      onFontPrefsChange: () => {},
      onActivityVariantChange: () => {},
      onConversationWidthChange: () => {},
      onLeftRailLayoutChange: () => {},
      onPresenceLayoutChange: () => {},
      onRefreshProviders: () => {},
      onSaveProviderKey: async () => ({ ok: true }),
      onDisconnectProvider: async () => ({ ok: true }),
      onRefreshProfiles: () => {},
      onOpenAgent: () => {},
      onBotDraftChange: (id, patch) => log.push(['settings.onBotDraftChange', id, patch]),
      onSelectBotSettle: (id) => log.push(['settings.onSelectBotSettle', id]),
      onSaveBotConfig: async (id, opts) => {
        log.push(['settings.onSaveBotConfig', id, opts]);
        return { ok: true };
      },
      onResetBotDraft: (id) => log.push(['settings.onResetBotDraft', id]),
      onOpenBotWizard: (mode) => log.push(['settings.onOpenBotWizard', mode]),
      onCloseBotWizard: () => log.push(['settings.onCloseBotWizard']),
      onBotWizardDraftChange: (patch) => log.push(['settings.onBotWizardDraftChange', patch]),
      onSubmitCreateBot: async () => {
        log.push(['settings.onSubmitCreateBot']);
        return { ok: true };
      },
      onRetryBotList: () => log.push(['settings.onRetryBotList']),
      onDismissBotError: () => log.push(['settings.onDismissBotError']),
      onDismissBotConfirm: () => log.push(['settings.onDismissBotConfirm']),
      onConfirmBotExit: () => {},
      onCancelBotExit: () => {},
      onRegisterBotDirtyGuard: () => {},
      onRefreshExtensions: () => log.push(['settings.onRefreshExtensions']),
      onReloadSkills: async () => {
        log.push(['settings.onReloadSkills']);
        return { ok: true };
      },
      onReloadProviders: () => log.push(['settings.onReloadProviders']),
      onNotify: (msg) => log.push(['settings.onNotify', msg]),
      onCopy: async (txt) => {
        log.push(['settings.onCopy', txt]);
        return true;
      },
      onTestGateway: (draft) => log.push(['settings.onTestGateway', draft]),
      onConnectGateway: (draft) => log.push(['settings.onConnectGateway', draft]),
      onDisconnectGateway: () => log.push(['settings.onDisconnectGateway']),
      onSwitchDefaultAndDisableProvider: async () => ({ ok: true }),
    },
  };

  return { snapshot, actions, log };
}

test('CompactTraceCapsule 折叠态常驻流式锚点并切分普通工具与子代理委派', () => {
  setLocale('zh-CN');

  const mixed = [
    { id: 't1', name: 'read_file', status: 'completed', args: 'a.ts' },
    { id: 't2', name: 'delegate_task', status: 'running', args: JSON.stringify({ role: 'Code Reviewer' }) },
    { id: 't3', name: 'spawn_agent', status: 'completed', args: 'run' },
  ];
  assert.equal(isSubagentTool({ id: 'x', name: 'read_file', status: 'completed', args: '' }), false);
  assert.equal(isSubagentTool({ id: 'x', name: 'delegate_task', status: 'completed', args: '' }), true);
  assert.equal(isSubagentTool({ id: 'x', name: 'agent', status: 'completed', args: '' }), true);
  const part = partitionMobileTools(mixed);
  assert.equal(part.standardTools.length, 1);
  assert.equal(part.subagentTools.length, 2);

  // 非流式空轨迹返回 null
  assert.equal(
    renderToStaticMarkup(
      React.createElement(CompactTraceCapsule, {
        messageId: 'm-empty',
        thought: '',
        tools: [],
        isStreaming: false,
      }),
    ),
    '',
  );

  // 流式空轨迹必须常驻 #msg-thought-* 与 #msg-tools-* 锚点，防止直写丢失首帧
  const streamEmpty = renderToStaticMarkup(
    React.createElement(CompactTraceCapsule, {
      messageId: 'm-stream-0',
      thought: '',
      tools: [],
      isStreaming: true,
    }),
  );
  assert.ok(streamEmpty.includes('id="msg-thought-m-stream-0"'));
  assert.ok(streamEmpty.includes('id="msg-tools-m-stream-0"'));

  // 纯子代理无思考时同样保留锚点并渲染 42px 子代理条
  const subOnly = renderToStaticMarkup(
    React.createElement(CompactTraceCapsule, {
      messageId: 'm-sub',
      thought: '',
      tools: [
        { id: 's1', name: 'invoke_subagent', status: 'completed', args: JSON.stringify({ role: 'Stylist' }) },
        { id: 's2', name: 'ask_side_agent', status: 'completed', args: 'check' },
      ],
      isStreaming: false,
    }),
  );
  assert.ok(subOnly.includes('id="msg-thought-m-sub"'));
  assert.ok(subOnly.includes('m-subagent-bar'));
  assert.ok(subOnly.includes('协同 2 个子代理任务'));

  // 思考 + 普通工具 + 子代理：默认折叠，点击展开 + 点击子代理回调
  const driver = createReactHookDriver();
  let expandedState = false;
  const openedSubagents = [];
  const view = driver.mount(() =>
    React.createElement(CompactTraceCapsule, {
      messageId: 'm-full',
      thought: '先读配置再改样式',
      thoughtDurationMs: 2400,
      tools: mixed,
      isStreaming: expandedState,
      knownFiles: ['a.ts'],
      onOpenSubagentDetail: (p) => openedSubagents.push(p),
    }),
  );

  const tracePill = findAll(view.tree, (n) => n.props?.className === 'm-trace-pill')[0];
  assert.ok(tracePill);
  tracePill.props.onClick();
  view.rerender();
  const drawer = findAll(view.tree, (n) => n.props?.className === 'm-trace-drawer')[0];
  assert.equal(drawer.props['data-open'], 'true');

  const subBar = findAll(view.tree, (n) => n.props?.className === 'm-subagent-bar')[0];
  subBar.props.onClick();
  assert.equal(openedSubagents.length, 1);
  assert.equal(openedSubagents[0].messageId, 'm-full');

  // 仅思考（无时长 / 有时长）与仅普通工具分支
  const thoughtOnlyHtml = renderToStaticMarkup(
    React.createElement(CompactTraceCapsule, {
      messageId: 'm-t1',
      thought: '思考一下',
      tools: [],
      isStreaming: false,
    }),
  );
  assert.ok(thoughtOnlyHtml.includes('已记录推理过程'));
  const thoughtTimedHtml = renderToStaticMarkup(
    React.createElement(CompactTraceCapsule, {
      messageId: 'm-t2',
      thought: '思考两秒',
      thoughtDurationMs: 2000,
      tools: [],
      isStreaming: false,
    }),
  );
  assert.ok(thoughtTimedHtml.includes('已思考 2.0s'));
  const toolsOnlyHtml = renderToStaticMarkup(
    React.createElement(CompactTraceCapsule, {
      messageId: 'm-to',
      thought: '',
      tools: [{ id: 't1', name: 'grep', status: 'completed', args: 'x' }],
      isStreaming: false,
    }),
  );
  assert.ok(toolsOnlyHtml.includes('执行 1 步操作'));

  // MessageRow / TurnGroup / ConversationMessageList compactTrace 透传正反向检验
  const compactListHtml = renderToStaticMarkup(
    React.createElement(ConversationMessageList, {
      snapshot: {
        mode: 'normal',
        messages: [
          { id: 'u1', role: 'user', content: 'hi', displayKind: 'user' },
          {
            id: 'a1',
            role: 'assistant',
            content: 'done',
            displayKind: 'assistant',
            thought: 'plan',
            toolCalls: mixed,
          },
        ],
        isStreaming: false,
        gatewayConnected: true,
        compactTrace: true,
      },
      actions: {},
    }),
  );
  assert.ok(compactListHtml.includes('data-mobile-trace="a1"'));

  const desktopListHtml = renderToStaticMarkup(
    React.createElement(ConversationMessageList, {
      snapshot: {
        mode: 'normal',
        messages: [
          {
            id: 'a2',
            role: 'assistant',
            content: 'done',
            displayKind: 'assistant',
            thought: 'plan',
            toolCalls: [{ id: 't1', name: 'read_file', status: 'completed', args: 'a.ts' }],
          },
        ],
        isStreaming: false,
        gatewayConnected: true,
        compactTrace: false,
      },
      actions: {},
    }),
  );
  assert.equal(desktopListHtml.includes('data-mobile-trace='), false);

  // TurnGroup & MessageRow 直接覆盖 compactTrace 变更的 memo 比较分支
  const turnMsgs = [{ id: 'a1', role: 'assistant', content: 'ok', displayKind: 'assistant' }];
  const cbA = () => {};
  const cbB = () => {};
  const turnProps = {
    messages: turnMsgs,
    mode: 'normal',
    locale: 'zh',
    isLastTurn: true,
    isStreaming: false,
    compactTrace: false,
    onOpenSubagentDetail: cbA,
  };
  assert.ok(renderToStaticMarkup(React.createElement(TurnGroup, turnProps)).length > 0);
  assert.equal(TurnGroup.compare(turnProps, { ...turnProps }), true);
  assert.equal(TurnGroup.compare(turnProps, { ...turnProps, compactTrace: true }), false);
  assert.equal(TurnGroup.compare(turnProps, { ...turnProps, onOpenSubagentDetail: cbB }), false);
  const mrHtml = renderToStaticMarkup(
    React.createElement(MessageRow, {
      message: { id: 'a3', role: 'assistant', content: 'ok', displayKind: 'assistant', thought: 't' },
      mode: 'normal',
      isLastMessage: true,
      locale: 'zh',
      isStreaming: false,
      compactTrace: true,
    }),
  );
  assert.ok(mrHtml.includes('data-mobile-trace="a3"'));
});

test('MobileEntityRow 长按定时、位移取消、右键触发与卸载清理', () => {
  const prevSetTimeout = globalThis.setTimeout;
  const prevClearTimeout = globalThis.clearTimeout;
  const timers = new Map();
  let nextTimerId = 1;
  globalThis.setTimeout = (fn) => {
    const id = nextTimerId++;
    timers.set(id, fn);
    return id;
  };
  globalThis.clearTimeout = (id) => {
    timers.delete(id);
  };

  try {
    const driver = createReactHookDriver();
    let selected = 0;
    let longPressed = 0;
    let passLongPress = true;
    const view = driver.mount(() =>
      React.createElement(MobileEntityRow, {
        kind: 'session',
        entityId: 's-1',
        title: '会话A',
        subtitle: '摘要',
        timeText: '10:00',
        avatarHtml: '<svg/>',
        isActive: true,
        isPinned: true,
        activityState: 'running',
        activityTransition: 'start',
        onSelect: () => {
          selected += 1;
        },
        onLongPress: passLongPress
          ? () => {
              longPressed += 1;
            }
          : undefined,
      }),
    );

    const btn = findAll(view.tree, (n) => n.props?.className === 'm-entity-row')[0];
    // 普通点击
    btn.props.onClick();
    assert.equal(selected, 1);

    // 按下后移动超过 8px 取消长按
    btn.props.onPointerDown({ clientX: 10, clientY: 10 });
    assert.equal(timers.size, 1);
    btn.props.onPointerMove({ clientX: 25, clientY: 10 });
    assert.equal(timers.size, 0);
    // 无活跃 timer 时移动应安全早退
    btn.props.onPointerMove({ clientX: 30, clientY: 10 });

    // 按下后静止微移且松手前定时到期 -> 触发长按并吞掉后续 onClick
    btn.props.onPointerDown({ clientX: 10, clientY: 10 });
    btn.props.onPointerMove({ clientX: 12, clientY: 11 });
    assert.equal(timers.size, 1);
    for (const fn of timers.values()) fn();
    timers.clear();
    assert.equal(longPressed, 1);
    btn.props.onClick();
    assert.equal(selected, 1, '长按后的抬手点击不得重复进入会话');

    // 右键菜单直接触发长按
    let prevented = false;
    btn.props.onContextMenu({
      preventDefault() {
        prevented = true;
      },
    });
    assert.equal(prevented, true);
    assert.equal(longPressed, 2);

    // 按下但不松手即卸载，cleanup 必须清理 timer
    btn.props.onPointerDown({ clientX: 10, clientY: 10 });
    assert.equal(timers.size, 1);
    view.unmount();
    assert.equal(timers.size, 0);

    // 无 onLongPress 分支
    passLongPress = false;
    view.rerender();
    const btnNoLp = findAll(view.tree, (n) => n.props?.className === 'm-entity-row')[0];
    btnNoLp.props.onPointerDown({ clientX: 0, clientY: 0 });
    btnNoLp.props.onContextMenu({ preventDefault() {} });
    assert.equal(longPressed, 2);
  } finally {
    globalThis.setTimeout = prevSetTimeout;
    globalThis.clearTimeout = prevClearTimeout;
  }
});

test('MobileWorkspaceShell 全三屏手势、返回键 10 级栈、新建/子代理/长按/设置全交互闭环', () => {
  setLocale('zh-CN');

  const prevWindow = globalThis.window;
  const prevDocument = globalThis.document;
  const prevElement = globalThis.Element;
  const prevCustomEvent = globalThis.CustomEvent;
  const prevSetTimeout = globalThis.setTimeout;
  const prevClearTimeout = globalThis.clearTimeout;
  const timeouts = [];
  const clearedTimeouts = [];
  const winListeners = new Map();

  class MockElement {
    constructor({ ignore = false, overflow = false, pre = overflow, clientWidth = 390 } = {}) {
      this._ignore = ignore;
      this._pre = pre;
      this.clientWidth = clientWidth;
      this.scrollWidth = overflow ? 600 : 200;
    }
    closest(sel) {
      if (this._ignore && sel.includes('pan-x')) return this;
      if (this._pre && sel.includes('pre')) return this;
      return null;
    }
  }

  globalThis.Element = MockElement;
  globalThis.CustomEvent = class MockCustomEvent {
    constructor(type, opts = {}) {
      this.type = type;
      this.cancelable = Boolean(opts.cancelable);
      this.defaultPrevented = false;
    }
    preventDefault() {
      if (this.cancelable) this.defaultPrevented = true;
    }
  };
  globalThis.setTimeout = (fn) => {
    timeouts.push(fn);
    return timeouts.length;
  };
  globalThis.clearTimeout = (id) => {
    if (typeof id === 'number') clearedTimeouts.push(id);
  };
  globalThis.document = { activeElement: null };
  globalThis.window = {
    addEventListener(type, fn) {
      if (!winListeners.has(type)) winListeners.set(type, []);
      winListeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      winListeners.set(
        type,
        (winListeners.get(type) ?? []).filter((f) => f !== fn),
      );
    },
    dispatchEvent(ev) {
      for (const fn of [...(winListeners.get(ev.type) ?? [])]) fn(ev);
      return !ev.defaultPrevented;
    },
  };

  try {
    const { snapshot, actions, log } = createSampleData();
    const driver = createReactHookDriver();
    const view = driver.mount(() => React.createElement(MobileWorkspaceShell, { snapshot, actions }));

    // 1. 首屏操作：设置 / 搜索 / 新建 / 分区折叠 / Bot与普通会话打开&长按
    const homeSettingsBtn = findAll(view.tree, (n) => n.props?.['data-testid'] === 'mobile-settings-trigger')[0];
    homeSettingsBtn.props.onClick();
    const homeSearchBtn = findAll(view.tree, (n) => n.props?.['data-testid'] === 'mobile-search-trigger')[0];
    homeSearchBtn.props.onClick();
    const homeNewBtn = findAll(view.tree, (n) => n.props?.['data-testid'] === 'mobile-new-chat-trigger')[0];
    homeNewBtn.props.onClick();
    findAll(view.tree, (n) => n.props?.className === 'm-section__header').forEach((h) => h.props.onClick());

    // 触发离线横幅 + 搜索栏分支
    snapshot.gatewayConnected = false;
    snapshot.searchOpen = true;
    snapshot.homeModel = {
      ...snapshot.homeModel,
      isSearching: true,
      hasAnyResult: false,
      botsSection: { ...snapshot.homeModel.botsSection, items: [], headerStatus: { state: 'running', statusTextKey: 'mobile.status.thinking' } },
      groupsSection: { ...snapshot.homeModel.groupsSection, items: [], headerStatus: { state: 'running', statusTextKey: 'mobile.status.collaborating' } },
      sessionsSection: { ...snapshot.homeModel.sessionsSection, items: [] },
    };
    view.rerender();
    findAll(view.tree, (n) => n.props?.className === 'm-home__search-input')[0]?.props.onChange({ target: { value: 'k' } });
    findAll(view.tree, (n) => n.props?.className === 'm-home__search-cancel')[0]?.props.onClick();
    findAll(view.tree, (n) => n.props?.className === 'm-home__offline-banner')[0]?.props.onClick();

    // 2. 手势滑动：在主舞台可拖拽切屏，忽略右击与豁免节点
    snapshot.gatewayConnected = true;
    snapshot.searchOpen = false;
    snapshot.activePane = 'home';
    view.rerender();

    const mainCanvas = findAll(view.tree, (n) => n.props?.className === 'm-shell__main')[0];
    mainCanvas.props.onPointerDown({ pointerId: 1, pointerType: 'mouse', button: 2, clientX: 200, clientY: 200 });
    mainCanvas.props.onPointerDown({ pointerId: 1, pointerType: 'touch', button: 0, clientX: 200, clientY: 200, target: new MockElement({ ignore: true }) });
    mainCanvas.props.onPointerDown({ pointerId: 1, pointerType: 'touch', button: 0, clientX: 200, clientY: 200, target: new MockElement({ overflow: true }) });

    // 纵向划动锁定后释放
    mainCanvas.props.onPointerDown({ pointerId: 2, pointerType: 'touch', button: 0, clientX: 200, clientY: 200, target: new MockElement() });
    mainCanvas.props.onPointerMove({ pointerId: 2, clientX: 202, clientY: 240 });
    mainCanvas.props.onPointerUp({ pointerId: 2, clientX: 202, clientY: 240 });

    // 正常横向向左滑超过阈值 -> 切到 stage
    mainCanvas.props.onPointerDown({ pointerId: 3, pointerType: 'touch', button: 0, clientX: 300, clientY: 200, target: new MockElement() });
    mainCanvas.props.onPointerMove({ pointerId: 3, clientX: 298, clientY: 200 }); // 死区内
    mainCanvas.props.onPointerMove({ pointerId: 3, clientX: 250, clientY: 202 }); // 锁水平
    mainCanvas.props.onPointerMove({ pointerId: 3, clientX: 160, clientY: 203 }); // 继续滑动
    mainCanvas.props.onPointerUp({ pointerId: 3, clientX: 140, clientY: 203 });
    assert.ok(log.some(([k, v]) => k === 'onSelectPane' && v === 'stage'));

    // 3. 新建会话 Page Sheet（Step 1 选择 Bot / 选人 / 提交，Step 2 多选群聊成员）
    snapshot.newChatOpen = true;
    snapshot.newChatStep = 'compose';
    view.rerender();
    findAll(view.tree, (n) => n.props?.className === 'm-target-pill')[0]?.props.onClick();
    view.rerender();
    findAll(view.tree, (n) => n.props?.className === 'm-target-dropdown__item')[0]?.props.onClick();
    findAll(view.tree, (n) => n.props?.['data-testid'] === 'mobile-newchat-start-group')[0]?.props.onClick();
    assert.ok(log.some(([k]) => k === 'onSetNewChatStep'));

    snapshot.newChatStep = 'group-members';
    snapshot.newChatTargetKind = 'group';
    snapshot.newChatGroupMembers = ['default', 'arch'];
    view.rerender();
    findAll(view.tree, (n) => n.props?.className === 'm-matte-input')[0]?.props.onChange({ target: { value: '核心群' } });
    findAll(view.tree, (n) => n.props?.className === 'm-member-pick-row').forEach((r) => r.props.onClick());
    findAll(view.tree, (n) => n.props?.['data-testid'] === 'mobile-confirm-group-members')[0]?.props.onClick();
    findAll(view.tree, (n) => n.props?.className === 'm-back-btn')[0]?.props.onClick();
    snapshot.newChatStep = 'compose';
    view.rerender();

    // 4. 变形输入舱：聚焦展开、输入、Enter 发送（含 IME 守卫）、附件移除、停止流式、模型选择抽屉
    snapshot.newChatOpen = false;
    snapshot.attachments = [{ id: 'att-1', name: 'notes.md', type: 'file' }];
    view.rerender();
    const ta = findAll(view.tree, (n) => n.type === 'textarea')[0];
    ta.props.onFocus();
    ta.props.onChange({ target: { value: '测试发送' } });
    ta.props.onKeyDown({ key: 'Enter', shiftKey: false, nativeEvent: { isComposing: true }, preventDefault() {} });
    view.rerender();
    const ta2 = findAll(view.tree, (n) => n.type === 'textarea')[0];
    ta2.props.onKeyDown({ key: 'Enter', shiftKey: false, nativeEvent: { isComposing: false }, preventDefault() {} });
    assert.ok(log.some(([k, txt]) => k === 'onSendMessage' && txt === '测试发送'));
    ta2.props.onBlur();
    while (timeouts.length > 0) timeouts.shift()();

    // 模型弹出与选择：验证 MobileWorkspaceShell 将 MobileModelPickerSheet 挂载于 .m-shell 根层（非 .m-shell__track 内部）、
    // 支持 onPointerDown / 不可用模型锁定徽标 / 空列表刷新动作与关闭按钮
    const modelPill = findAll(view.tree, (n) => n.props?.className === 'm-composer__model-pill')[0];
    modelPill.props.onPointerDown({ preventDefault() {} });
    modelPill.props.onMouseDown({ preventDefault() {} });
    modelPill.props.onClick();
    view.rerender();
    const trackNode = findAll(view.tree, (n) => n.props?.className === 'm-shell__track')[0];
    assert.equal(
      findAll(trackNode, (n) => n.props?.['data-testid'] === 'mobile-model-picker-sheet').length,
      0,
      'MobileModelPickerSheet 禁止留在带 transform 的 300vw .m-shell__track 内，防止弹窗偏出屏幕',
    );
    assert.equal(
      findAll(view.tree, (n) => n.props?.['data-testid'] === 'mobile-model-picker-sheet').length,
      1,
      'MobileModelPickerSheet 必须挂载于 .m-shell 根部',
    );
    const modelOpts = findAll(view.tree, (n) => n.props?.className === 'm-sheet-option');
    modelOpts[0]?.props.onClick();
    assert.ok(log.some(([k, m, p]) => k === 'onSelectModel' && m === 'anthropic/claude-sonnet-4' && p === 'anthropic'));
    view.rerender();

    // 空模型目录点开模型选择时触发 onRefreshModels，并在空态展示重试按钮与不可用选项锁标
    let refreshCount = 0;
    const savedModels = snapshot.availableModels;
    const savedDetails = snapshot.modelDetails;
    const savedSelModel = snapshot.selectedModel;
    actions.onRefreshModels = () => {
      refreshCount += 1;
    };
    snapshot.availableModels = [];
    snapshot.modelDetails = [];
    snapshot.selectedModel = '';
    view.rerender();
    findAll(view.tree, (n) => n.props?.className === 'm-composer__model-pill')[0]?.props.onClick();
    view.rerender();
    assert.equal(refreshCount, 1);
    const emptyRetry = findAll(view.tree, (n) => n.props?.className === 'm-sheet-empty')
      .flatMap((box) => findAll(box, (b) => b.type === 'button'))[0];
    emptyRetry?.props.onClick();
    assert.equal(refreshCount, 2);
    // 无 onRefreshModels 时不渲染重试按钮 + unavailable 选项带锁定徽标 + 带 provider 选项关闭按钮
    assert.equal(
      renderToStaticMarkup(
        React.createElement(MobileModelPickerSheet, {
          open: true,
          selectedModel: '',
          availableModels: [],
          modelDetails: [],
          onSelectModel: () => {},
          onClose: () => {},
        }),
      ).includes('m-secondary-btn'),
      false,
    );
    assert.ok(
      renderToStaticMarkup(
        React.createElement(MobileModelPickerSheet, {
          open: true,
          selectedModel: 'm-locked',
          availableModels: [],
          modelDetails: [{ id: 'm-locked', name: 'Locked M', unavailable: true }],
          onSelectModel: () => {},
          onClose: () => {},
        }),
      ).includes('m-sheet-option__badge'),
    );
    findAll(
      findAll(view.tree, (n) => n.props?.['data-testid'] === 'mobile-model-picker-sheet')[0],
      (n) => n.props?.className === 'm-icon-btn',
    )[0]?.props.onClick();
    view.rerender();
    snapshot.availableModels = savedModels;
    snapshot.modelDetails = savedDetails;
    snapshot.selectedModel = savedSelModel;
    view.rerender();

    // 流式停止按钮 + 附件删除 + 对话区滚动压缩
    snapshot.isStreaming = true;
    view.rerender();
    findAll(view.tree, (n) => String(n.props?.className || '').includes('conv-att-remove'))[0]?.props.onClick();
    findAll(view.tree, (n) => n.props?.className === 'm-composer__send-btn m-composer__send-btn--stop').forEach((b) =>
      b.props.onClick(),
    );
    const convStream = findAll(view.tree, (n) => n.props?.id === 'conversation-stream')[0];
    convStream.props.onScroll({ currentTarget: { scrollHeight: 1200, scrollTop: 100, clientHeight: 400 } });

    // 5. 子代理详情抽屉
    snapshot.subagentSheet = {
      messageId: 'm-1',
      tools: [
        { id: 's1', name: 'delegate_task', status: 'running', args: '{"role":"QA","prompt":"Verify"}', output: 'log' },
        { id: 's2', name: 'delegate_task', status: 'failed', args: '' },
      ],
    };
    view.rerender();
    findAll(view.tree, (n) => n.props?.className === 'm-subagent-sheet m-no-swipe')[0]?.props.onClick({ stopPropagation() {} });
    findAll(view.tree, (n) => n.props?.className === 'm-danger-btn')[0]?.props.onClick();

    // 6. 检查舱 4 Tab + 源码阅读器
    for (const tab of ['artifacts', 'diffs', 'files', 'memory']) {
      snapshot.inspectorTab = tab;
      snapshot.inspectorReaderOpen = tab === 'files';
      snapshot.inspectorReaderItem = tab === 'files' ? { kind: 'files', title: 'src/main.ts', subtitle: 'ts', content: 'code' } : null;
      view.rerender();
      findAll(view.tree, (n) => n.props?.className === 'm-inspector-card' && n.type === 'button')[0]?.props.onClick();
      findAll(view.tree, (n) => n.props?.className === 'm-inspector__seg-btn').forEach((b) => b.props.onClick());
    }
    findAll(view.tree, (n) => n.props?.['aria-label'] === '复制内容')[0]?.props.onClick();

    // 7. 设置页：分级入口菜单 -> appearance / gateway / about 子页全交互
    snapshot.settingsOpen = true;
    snapshot.settingsSubpage = null;
    view.rerender();
    findAll(view.tree, (n) => n.props?.['data-testid'] === 'mobile-settings-row-appearance')[0]?.props.onClick();
    assert.ok(log.some(([k, v]) => k === 'onSelectSettingsSubpage' && v === 'appearance'));
    snapshot.settingsSubpage = 'appearance';
    view.rerender();
    findAll(view.tree, (n) => n.props?.className === 'm-settings-seg-btn').forEach((b) => b.props.onClick());
    findAll(view.tree, (n) => n.props?.className === 'm-settings-chip-btn').forEach((b) => b.props.onClick());
    snapshot.settingsSubpage = 'gateway';
    view.rerender();
    findAll(view.tree, (n) => n.props?.className === 'm-settings-card m-settings-card--form')
      .flatMap((c) => findAll(c, (x) => x.type === 'input'))
      .forEach((inp) => inp.props.onChange({ target: { value: 'val' } }));
    findAll(view.tree, (n) => n.props?.['data-testid'] === 'mobile-settings-back')[0]?.props.onClick();

    // 8. 长按动作面板（Bot 保护态 / 群聊解散 / 普通会话重命名·置顶·归档·删除）
    for (const kind of ['bot', 'group', 'session']) {
      snapshot.actionSheet = { kind, id: 'item-1', title: '目标' };
      view.rerender();
      if (kind === 'session') {
        const renameTrigger = findAll(view.tree, (n) => n.props?.className === 'm-sheet-option')[1];
        renameTrigger?.props.onClick();
        view.rerender();
        const renameInput = findAll(view.tree, (n) => n.props?.className === 'm-action-sheet__rename')
          .flatMap((x) => findAll(x, (y) => y.type === 'input'))[0];
        renameInput?.props.onChange({ target: { value: '新名字' } });
        view.rerender();
        findAll(view.tree, (n) => n.props?.className === 'm-action-sheet__rename')
          .flatMap((x) => findAll(x, (y) => y.props?.className === 'm-primary-btn'))[0]
          ?.props.onClick();
      } else {
        findAll(view.tree, (n) => n.props?.className === 'm-sheet-option').forEach((opt) => opt.props.onClick());
      }
    }

    // 9. hermes-mobile-back 窗口事件全优先级消费验证
    const fireBack = () => {
      const ev = new globalThis.CustomEvent('hermes-mobile-back', { cancelable: true });
      return globalThis.window.dispatchEvent(ev);
    };
    snapshot.actionSheet = { kind: 'session', id: 's1', title: 'x' };
    view.rerender();
    assert.equal(fireBack(), false);

    snapshot.actionSheet = null;
    snapshot.subagentSheet = { messageId: 'm1', tools: [] };
    view.rerender();
    assert.equal(fireBack(), false);

    snapshot.subagentSheet = null;
    snapshot.newChatOpen = true;
    snapshot.newChatStep = 'group-members';
    view.rerender();
    assert.equal(fireBack(), false);

    snapshot.newChatStep = 'compose';
    view.rerender();
    assert.equal(fireBack(), false);

    snapshot.newChatOpen = false;
    snapshot.searchOpen = true;
    view.rerender();
    assert.equal(fireBack(), false);

    snapshot.searchOpen = false;
    snapshot.settingsOpen = true;
    snapshot.settingsSubpage = 'gateway';
    view.rerender();
    assert.equal(fireBack(), false);

    snapshot.settingsSubpage = null;
    view.rerender();
    assert.equal(fireBack(), false);

    snapshot.settingsOpen = false;
    snapshot.activePane = 'inspector';
    snapshot.inspectorReaderOpen = true;
    view.rerender();
    assert.equal(fireBack(), false);

    snapshot.inspectorReaderOpen = false;
    view.rerender();
    assert.equal(fireBack(), false);

    snapshot.activePane = 'home';
    view.rerender();
    assert.equal(fireBack(), true, 'root home 不得拦截返回键，应交由系统退回后台');

    view.unmount();

    // 10. mountMobileWorkspaceShell 正反向守卫（缺失/断连宿主抛错 + 注入 root 正常挂载/更新/卸载）
    assert.throws(() => mountMobileWorkspaceShell(null, () => snapshot, actions), /connected/);
    assert.throws(() => mountMobileWorkspaceShell({ isConnected: false }, () => snapshot, actions), /connected/);
    const renderedElements = [];
    let rootUnmounted = false;
    const mount = mountMobileWorkspaceShell(
      { isConnected: true },
      () => snapshot,
      actions,
      () => ({
        render(el) {
          renderedElements.push(el);
        },
        unmount() {
          rootUnmounted = true;
        },
      }),
    );
    mount.update();
    mount.unmount();
    assert.equal(renderedElements.length, 2);
    assert.equal(rootUnmounted, true);

    // 11. 补充覆盖 Inspector / Settings 空态及群成员边界
    const emptyInspectorHtml = renderToStaticMarkup(
      React.createElement(MobileInspectorScreen, {
        activeFocus: { type: 'group', roomId: 'r1' },
        activeTab: 'memory',
        readerOpen: false,
        readerItem: null,
        artifacts: [],
        gitDiffs: [],
        openFiles: [],
        fileTreeState: { status: 'idle' },
        fileTreeExpandedPaths: [],
        fileTreeFilterQuery: '',
        activeFilePath: '',
        memories: [],
        learningState: { status: 'idle' },
        learningDetail: { status: 'idle' },
        groupMembers: [],
        onSelectTab: () => {},
        onOpenItem: () => {},
        onCloseReader: () => {},
        onCopyText: () => {},
        onLoadFileTree: () => {},
        onToggleFileTreeDir: () => {},
        onFilterFileTree: () => {},
        onOpenWorkspaceFile: () => {},
        onDownloadInspectorFile: () => {},
        onRefreshLearning: () => {},
        onLoadLearningDetail: () => {},
      }),
    );
    assert.ok(emptyInspectorHtml.includes('暂无群聊成员'));

    const disconnectedSettingsHtml = renderToStaticMarkup(
      React.createElement(MobileSettingsPage, {
        open: true,
        subpage: null,
        appearancePref: 'system',
        snapshot: {
          ...snapshot.settingsSnapshot,
          gateway: { ...snapshot.settingsSnapshot.gateway, status: 'disconnected', hasStoredPassword: false, test: undefined },
          mcp: { status: 'idle' },
          skills: { status: 'idle' },
          profiles: { status: 'idle' },
        },
        onClose: () => {},
        onSelectSubpage: () => {},
        onSetAppearancePreference: () => {},
        settingsActions: actions.settingsActions,
      }),
    );
    assert.ok(disconnectedSettingsHtml.includes('未连接'));

    // 11b. 精确覆盖剩余 TSX 交互与呈现分支（100% 行与分支覆盖）
    assert.equal(isSubagentTool({ id: 'u1', name: '', status: 'completed', args: '' }), false);
    assert.equal(isSubagentTool({ id: 'u2', name: 'agent_worker', status: 'completed', args: '' }), true);

    const streamingThoughtHtml = renderToStaticMarkup(
      React.createElement(CompactTraceCapsule, {
        messageId: 'm-str-th',
        thought: '持续思考中',
        tools: [],
        isStreaming: true,
      }),
    );
    assert.ok(streamingThoughtHtml.includes('思考与执行中'));

    // MobileConversationScreen 群聊焦点占位文案
    const groupConvHtml = renderToStaticMarkup(
      React.createElement(MobileConversationScreen, {
        gatewayConnected: false,
        activeFocus: { type: 'group', roomId: 'room-1' },
        activeBotDisplayName: '架构群',
        isStreaming: false,
        messagesCount: 0,
        selectedModel: '',
        availableModels: [],
        modelDetails: [],
        attachments: [],
        dockNotice: '提示条',
        sideAgentCapsules: [{ id: 'sc1', kind: 'delegation', profile: 'qa', question: '仅有问题', status: 'running' }],
        onSendMessage: () => {},
        onInterruptTurn: () => {},
        onSelectModel: () => {},
        onOpenAttachmentPicker: () => {},
        onRemoveAttachment: () => {},
        onOpenSettings: () => {},
      }),
    );
    assert.ok(groupConvHtml.includes('向群聊发送消息'));
    assert.ok(groupConvHtml.includes('仅有问题'));

    // MobileInspectorScreen 四栏空态 + 群成员列表有值分支 + 未命名条目字段分支
    for (const tab of ['artifacts', 'diffs', 'files', 'memory']) {
      const html = renderToStaticMarkup(
        React.createElement(MobileInspectorScreen, {
          activeFocus: { type: 'session', sessionId: 's1' },
          activeTab: tab,
          readerOpen: false,
          readerItem: null,
          artifacts: [],
          gitDiffs: [],
          openFiles: [],
          fileTreeState: tab === 'files' ? { status: 'ready', nodes: [] } : { status: 'idle' },
          fileTreeExpandedPaths: [],
          fileTreeFilterQuery: '',
          activeFilePath: '',
          memories: [],
          learningState: tab === 'memory'
            ? { status: 'ready', graph: { nodes: [], edges: [], totalSkills: 0, totalMemories: 0, summaryLines: [], legend: [] } }
            : { status: 'idle' },
          learningDetail: { status: 'idle' },
          groupMembers: [],
          onSelectTab: () => {},
          onOpenItem: () => {},
          onCloseReader: () => {},
          onCopyText: () => {},
          onLoadFileTree: () => {},
          onToggleFileTreeDir: () => {},
          onFilterFileTree: () => {},
          onOpenWorkspaceFile: () => {},
          onDownloadInspectorFile: () => {},
          onRefreshLearning: () => {},
          onLoadLearningDetail: () => {},
        }),
      );
      assert.ok(html.includes('m-inspector__empty') || html.includes('m-constellation__state-text'));
    }
    const membersHtml = renderToStaticMarkup(
      React.createElement(MobileInspectorScreen, {
        activeFocus: { type: 'group', roomId: 'r1' },
        activeTab: 'memory',
        readerOpen: false,
        readerItem: null,
        artifacts: [{ id: 'a', name: 'x', type: 'md', size: '1K' }],
        gitDiffs: [{ file: 'f.ts', additions: 1, deletions: 0 }],
        openFiles: [{ path: 'f.ts', content: 'x' }],
        fileTreeState: { status: 'idle' },
        fileTreeExpandedPaths: [],
        fileTreeFilterQuery: '',
        activeFilePath: '',
        memories: [],
        learningState: { status: 'idle' },
        learningDetail: { status: 'idle' },
        groupMembers: [{ name: 'arch', displayName: '架构老王' }],
        onSelectTab: () => {},
        onOpenItem: () => {},
        onCloseReader: () => {},
        onCopyText: () => {},
        onLoadFileTree: () => {},
        onToggleFileTreeDir: () => {},
        onFilterFileTree: () => {},
        onOpenWorkspaceFile: () => {},
        onDownloadInspectorFile: () => {},
        onRefreshLearning: () => {},
        onLoadLearningDetail: () => {},
      }),
    );
    assert.ok(membersHtml.includes('架构老王'));

    // MobileSettingsPage 连接中 + 测试/连接/断开按钮 + 分级子页 (gateway / about / providers)
    const d2 = createReactHookDriver();
    const sView = d2.mount(() =>
      React.createElement(MobileSettingsPage, {
        open: true,
        subpage: 'gateway',
        appearancePref: 'dark',
        snapshot: {
          ...snapshot.settingsSnapshot,
          gateway: { ...snapshot.settingsSnapshot.gateway, status: 'connecting', test: { ok: false, message: 'fail' } },
          profiles: { status: 'ready', data: [{ name: 'bare', displayName: '' }] },
        },
        onClose: () => {},
        onSelectSubpage: () => {},
        onSetAppearancePreference: () => {},
        settingsActions: actions.settingsActions,
      }),
    );
    findAll(sView.tree, (n) => n.props?.className === 'm-secondary-btn')[0]?.props.onClick();
    findAll(sView.tree, (n) => n.props?.className === 'm-primary-btn')[0]?.props.onClick();
    sView.unmount();
    const d2Conn = createReactHookDriver();
    const sConnView = d2Conn.mount(() =>
      React.createElement(MobileSettingsPage, {
        open: true,
        subpage: 'gateway',
        appearancePref: 'dark',
        snapshot: snapshot.settingsSnapshot,
        onClose: () => {},
        onSelectSubpage: () => {},
        onSetAppearancePreference: () => {},
        settingsActions: actions.settingsActions,
      }),
    );
    findAll(sConnView.tree, (n) => n.props?.className === 'm-danger-btn')[0]?.props.onClick();
    sConnView.unmount();

    // MobileMorphingComposer: autoFocus=true, 非受控 modelPicker, availableModels=[], empty/disabled submit, blur stays focused
    const dComp = createReactHookDriver();
    let compDisabled = false;
    let compAvail = [];
    const cView = dComp.mount(() =>
      React.createElement(MobileMorphingComposer, {
        placeholder: '输入...',
        isStreaming: false,
        disabled: compDisabled,
        selectedModel: 'custom-model',
        availableModels: compAvail,
        modelDetails: [],
        attachments: [],
        onSend: () => {},
        onSelectModel: () => {},
        autoFocus: true,
      }),
    );
    const cta = findAll(cView.tree, (n) => n.type === 'textarea')[0];
    cta.props.ref.current.scrollHeight = 0;
    globalThis.document = { activeElement: cta.props.ref.current };
    cta.props.onBlur();
    while (timeouts.length > 0) timeouts.shift()();
    // 空内容与 disabled 守卫
    findAll(cView.tree, (n) => n.props?.className === 'm-composer__send-btn')[0]?.props.onClick();
    cta.props.onChange({ target: { value: 'hello' } });
    compDisabled = true;
    cView.rerender();
    findAll(cView.tree, (n) => n.props?.className === 'm-composer__send-btn')[0]?.props.onClick();
    // 打开非受控模型菜单 -> 点击关闭按钮 -> 再次打开 -> 点击蒙层关闭
    findAll(cView.tree, (n) => n.props?.className === 'm-composer__model-pill')[0]?.props.onClick();
    cView.rerender();
    findAll(cView.tree, (n) => n.props?.className === 'm-icon-btn')[0]?.props.onClick();
    cView.rerender();
    findAll(cView.tree, (n) => n.props?.className === 'm-composer__model-pill')[0]?.props.onClick();
    cView.rerender();
    findAll(cView.tree, (n) => n.props?.className === 'm-sheet-backdrop')[0]?.props.onClick();
    cView.unmount();

    // MobileNewChatSheet: 无 profiles 兜底 + 群聊标题与成员添加 + 首条发送
    const dNew = createReactHookDriver();
    const nView = dNew.mount(() =>
      React.createElement(MobileNewChatSheet, {
        open: true,
        step: 'compose',
        targetKind: 'group',
        targetBot: 'missing',
        groupMembers: ['default', 'arch'],
        groupName: '',
        allProfiles: [],
        gatewayConnected: true,
        selectedModel: 'anthropic/claude-sonnet-4',
        availableModels: ['anthropic/claude-sonnet-4'],
        modelDetails: [],
        attachments: [],
        onClose: () => {},
        onSetStep: () => {},
        onSelectBot: () => {},
        onSetGroupMembers: (m) => actions.onSetNewChatGroupMembers(m),
        onSetGroupName: () => {},
        onSubmitFirstMessage: (txt) => actions.onSubmitNewChatMessage(txt),
        onSelectModel: () => {},
        onOpenAttachmentPicker: () => {},
        onRemoveAttachment: () => {},
      }),
    );
    const nta = findAll(nView.tree, (n) => n.type === 'textarea')[0];
    nta.props.onChange({ target: { value: '从新建页发送' } });
    nView.rerender();
    findAll(nView.tree, (n) => n.props?.className === 'm-composer__send-btn')[0]?.props.onClick();
    assert.ok(log.some(([k, txt]) => k === 'onSubmitNewChatMessage' && txt === '从新建页发送'));
    nView.unmount();

    // MobileNewChatSheet Step 2 添加未选成员 (!exists) + 无描述 Bot
    const dNew2 = createReactHookDriver();
    const nView2 = dNew2.mount(() =>
      React.createElement(MobileNewChatSheet, {
        open: true,
        step: 'group-members',
        targetKind: 'bot',
        targetBot: 'missing',
        groupMembers: ['default'],
        groupName: '',
        allProfiles: [{ name: 'default', displayName: '默认', isDefault: true }, { name: 'arch', displayName: '架构' }],
        gatewayConnected: true,
        selectedModel: 'm',
        availableModels: ['m'],
        modelDetails: [],
        attachments: [],
        onClose: () => {},
        onSetStep: () => {},
        onSelectBot: () => {},
        onSetGroupMembers: (m) => actions.onSetNewChatGroupMembers(m),
        onSetGroupName: () => {},
        onSubmitFirstMessage: () => {},
        onSelectModel: () => {},
        onOpenAttachmentPicker: () => {},
        onRemoveAttachment: () => {},
      }),
    );
    findAll(nView2.tree, (n) => n.props?.className === 'm-member-pick-row')[1]?.props.onClick();
    nView2.unmount();

    // MobileSubagentSheet 非运行流式（全部完成时不显示中断按钮）+ 背景/关闭点击
    const dSub = createReactHookDriver();
    const subView = dSub.mount(() =>
      React.createElement(MobileSubagentSheet, {
        sheet: { messageId: 'm-done', tools: [{ id: 'x', name: 'delegate_task', status: 'completed', args: '' }] },
        isStreaming: true,
        onClose: () => {},
        onInterruptTurn: () => {},
      }),
    );
    assert.equal(findAll(subView.tree, (n) => n.props?.className === 'm-danger-btn').length, 0);
    findAll(subView.tree, (n) => n.props?.className === 'm-sheet-backdrop')[0]?.props.onClick();
    findAll(subView.tree, (n) => n.props?.className === 'm-icon-btn')[0]?.props.onClick();
    subView.unmount();

    // MobileWorkspaceShell 剩余边界分支：
    const dShell2 = createReactHookDriver();
    snapshot.actionSheet = { kind: 'session', id: 's-1', title: 'S1' };
    snapshot.activePane = 'inspector';
    snapshot.settingsOpen = false;
    snapshot.newChatOpen = false;
    snapshot.searchOpen = false;
    snapshot.subagentSheet = null;
    const s2 = dShell2.mount(() => React.createElement(MobileWorkspaceShell, { snapshot, actions }));
    // ActionSheet: 点击 打开 / 置顶 / 标记已完成(含二次确认) / 删除（含 --danger 类）/ 重命名（空保存与有效保存）
    const findSheetOpt = (actionName) =>
      findAll(
        s2.tree,
        (n) =>
          n.type === 'button' &&
          n.props?.['data-sheet-action'] === actionName,
      )[0];
    findSheetOpt('open')?.props.onClick(); // 打开
    findSheetOpt('pin')?.props.onClick(); // 置顶
    findSheetOpt('mark-done')?.props.onClick(); // 打开二次确认步
    s2.rerender();
    findAll(
      s2.tree,
      (n) => n.type === 'button' && n.props?.['data-testid'] === 'mobile-action-confirm-done-btn',
    )[0]?.props.onClick();
    assert.ok(log.some(([k]) => k === 'onActionArchive'));
    s2.rerender();
    findSheetOpt('delete')?.props.onClick(); // 删除会话 (session)
    assert.ok(log.some(([k]) => k === 'onActionDelete'));
    findSheetOpt('rename')?.props.onClick(); // 进入重命名模式
    s2.rerender();
    const renameBoxEmpty = findAll(s2.tree, (n) => n.props?.className === 'm-action-sheet__rename')[0];
    findAll(renameBoxEmpty, (n) => n.props?.className === 'm-matte-input')[0]?.props.onChange({ target: { value: '   ' } });
    s2.rerender();
    const renameBoxBlank = findAll(s2.tree, (n) => n.props?.className === 'm-action-sheet__rename')[0];
    findAll(renameBoxBlank, (n) => n.props?.className === 'm-primary-btn')[0]?.props.onClick(); // 空白名忽略保存
    assert.equal(log.some(([k]) => k === 'onActionRename'), false);
    findAll(renameBoxBlank, (n) => n.props?.className === 'm-matte-input')[0]?.props.onChange({ target: { value: '新名字' } });
    s2.rerender();
    const renameBoxValid = findAll(s2.tree, (n) => n.props?.className === 'm-action-sheet__rename')[0];
    findAll(renameBoxValid, (n) => n.props?.className === 'm-primary-btn')[0]?.props.onClick(); // 有效保存
    assert.ok(log.some(([k, , title]) => k === 'onActionRename' && title === '新名字'));
    findAll(renameBoxValid, (n) => n.props?.className === 'm-secondary-btn')[0]?.props.onClick(); // 取消重命名
    // ActionSheet 解散群聊 (group) 与背景/关闭按钮
    snapshot.actionSheet = { kind: 'group', id: 'room-1', title: '架构群' };
    s2.rerender();
    findAll(
      s2.tree,
      (n) => typeof n.props?.className === 'string' && n.props.className.includes('m-sheet-option--danger'),
    )[0]?.props.onClick();
    assert.ok(log.some(([k]) => k === 'onActionDisband'));
    findAll(s2.tree, (n) => n.props?.className === 'm-sheet-backdrop')[0]?.props.onClick();

    // settingsOpen 遮罩开启时忽略底层画布 pointerDown
    snapshot.actionSheet = null;
    snapshot.settingsOpen = true;
    s2.rerender();
    findAll(s2.tree, (n) => n.props?.className === 'm-shell__main')[0]?.props.onPointerDown({
      pointerId: 8,
      pointerType: 'touch',
      button: 0,
      clientX: 200,
      clientY: 200,
      target: new MockElement(),
    });
    snapshot.settingsOpen = false;
    s2.rerender();

    // 清理 actionSheet，测试 inspector 右边界橡皮筋 / 非溢流<pre> / 鼠标左键 / 轻点未滑动 / modelPicker 返回键消费
    const mc2 = findAll(s2.tree, (n) => n.props?.className === 'm-shell__main')[0];
    mc2.props.onPointerDown({
      pointerId: 81,
      pointerType: 'touch',
      button: 0,
      clientX: 200,
      clientY: 200,
      target: new MockElement({ pre: true, overflow: false }),
    });
    mc2.props.onPointerUp({ pointerId: 81, clientX: 200, clientY: 200 }); // 轻点未成水平拖拽 (!wasHorizontal)
    mc2.props.onPointerDown({ pointerId: 9, pointerType: 'mouse', button: 0, clientX: 200, clientY: 200, target: null });
    mc2.props.onPointerMove({ pointerId: 9, clientX: 160, clientY: 200 }); // 锁水平 + 越右界
    s2.rerender();
    assert.equal(findAll(s2.tree, (n) => n.props?.className === 'm-shell__track')[0]?.props['data-dragging'], 'true');
    mc2.props.onPointerMove({ pointerId: 999, clientX: 100, clientY: 200 }); // 错 pointerId 忽略
    mc2.props.onPointerUp({ pointerId: 9, clientX: 155, clientY: 200 }); // 小位移回弹停留在 inspector
    mc2.props.onPointerUp({ pointerId: 999, clientX: 100, clientY: 200 }); // 非活跃抬手忽略

    // 触发 modelPickerOpen = true 时按硬件返回键关闭模型选择器
    findAll(s2.tree, (n) => n.props?.className === 'm-composer__model-pill')[0]?.props.onClick();
    s2.rerender();
    assert.equal(fireBack(), false);
    s2.unmount();

    // window === undefined 安全挂载 + clientWidth === 0 回退 390
    const savedWin = globalThis.window;
    globalThis.window = undefined;
    try {
      const dNoWin = createReactHookDriver();
      const sNoWin = dNoWin.mount(() => React.createElement(MobileWorkspaceShell, { snapshot, actions }));
      sNoWin.unmount();
    } finally {
      globalThis.window = savedWin;
    }

    const dZero = createReactHookDriver({ defaultClientWidth: 0 });
    snapshot.activePane = 'home';
    const sZero = dZero.mount(() => React.createElement(MobileWorkspaceShell, { snapshot, actions }));
    const mcZero = findAll(sZero.tree, (n) => n.props?.className === 'm-shell__main')[0];
    mcZero.props.onPointerDown({ pointerId: 11, pointerType: 'touch', button: 0, clientX: 300, clientY: 200, target: new MockElement() });
    mcZero.props.onPointerMove({ pointerId: 11, clientX: 240, clientY: 200 });
    mcZero.props.onPointerMove({ pointerId: 11, clientX: 120, clientY: 200 });
    mcZero.props.onPointerUp({ pointerId: 11, clientX: 100, clientY: 200 });
    sZero.unmount();

    // CompactTraceCapsule 缺省 onOpenSubagentDetail 与空 tool.id 分支
    const dCapNoCb = createReactHookDriver();
    const capNoCb = dCapNoCb.mount(() =>
      React.createElement(CompactTraceCapsule, {
        messageId: 'm-no-cb',
        thought: '',
        tools: [{ id: '', name: 'delegate_task', status: 'completed', args: '' }],
        isStreaming: false,
      }),
    );
    findAll(capNoCb.tree, (n) => n.props?.className === 'm-subagent-bar')[0]?.props.onClick();
    capNoCb.unmount();

    // MobileMorphingComposer attachRefs=false / onRemoveAttachment=undefined / onStop=undefined / 无 provider 明细 / 失焦收缩 / 折叠态流式停止
    const dCompCollapsed = createReactHookDriver();
    const compCollapsedStop = dCompCollapsed.mount(() =>
      React.createElement(MobileMorphingComposer, {
        placeholder: '输入...',
        isStreaming: true,
        disabled: false,
        selectedModel: '',
        availableModels: [],
        modelDetails: [],
        attachments: [],
        forceModelPickerOpen: true,
        onSend: () => {},
        onStop: () => {},
        onSelectModel: () => {},
      }),
    );
    assert.ok(findAll(compCollapsedStop.tree, (n) => n.props?.className === 'm-composer__send-btn m-composer__send-btn--stop')[0]);
    compCollapsedStop.unmount();

    const dCompNoRef = createReactHookDriver({ attachRefs: false });
    const compNoRef = dCompNoRef.mount(() =>
      React.createElement(MobileMorphingComposer, {
        placeholder: '输入...',
        isStreaming: true,
        disabled: false,
        selectedModel: 'm1',
        availableModels: ['m1'],
        modelDetails: [{ id: 'm1', name: 'M1' }],
        attachments: [{ id: 'a1', name: 'img.png', kind: 'image', sizeBytes: 10 }],
        onSend: () => {},
        onSelectModel: () => {},
        autoFocus: true,
      }),
    );
    const ntaNoRef = findAll(compNoRef.tree, (n) => n.type === 'textarea')[0];
    ntaNoRef.props.onChange({ target: { value: 'abc' } });
    ntaNoRef.props.onFocus();
    compNoRef.rerender();
    globalThis.document = { activeElement: null };
    findAll(compNoRef.tree, (n) => n.type === 'textarea')[0].props.onBlur();
    while (timeouts.length > 0) timeouts.shift()();
    compNoRef.rerender();
    findAll(compNoRef.tree, (n) => n.props?.className === 'm-composer__model-pill')[0]?.props.onClick();
    compNoRef.rerender();
    const titleNode = findAll(compNoRef.tree, (n) => n.props?.className === 'm-sheet-option__title')[0];
    assert.equal(titleNode?.props.children, 'M1');
    findAll(compNoRef.tree, (n) => n.props?.className === 'm-sheet-option')[0]?.props.onClick();
    compNoRef.unmount();

    // MobileNewChatSheet 空目标与 bare-bot 无 displayName（Step 1 + Dropdown + Step 2）
    const dNewEmpty = createReactHookDriver();
    const nEmpty = dNewEmpty.mount(() =>
      React.createElement(MobileNewChatSheet, {
        open: true,
        step: 'compose',
        targetKind: 'bot',
        targetBot: '',
        groupMembers: [],
        groupName: '',
        allProfiles: [],
        gatewayConnected: true,
        selectedModel: 'm1',
        availableModels: ['m1'],
        modelDetails: [],
        attachments: [],
        onClose: () => {},
        onSetStep: () => {},
        onSelectBot: () => {},
        onSetGroupMembers: () => {},
        onSetGroupName: () => {},
        onSubmitFirstMessage: () => {},
        onSelectModel: () => {},
        onOpenAttachmentPicker: () => {},
        onRemoveAttachment: () => {},
      }),
    );
    nEmpty.unmount();

    const dNewBare = createReactHookDriver();
    const nBare = dNewBare.mount(() =>
      React.createElement(MobileNewChatSheet, {
        open: true,
        step: 'compose',
        targetKind: 'bot',
        targetBot: 'bare-bot',
        groupMembers: [],
        groupName: '',
        allProfiles: [{ name: 'bare-bot', displayName: '' }],
        gatewayConnected: true,
        selectedModel: 'm1',
        availableModels: ['m1'],
        modelDetails: [],
        attachments: [],
        onClose: () => {},
        onSetStep: () => {},
        onSelectBot: () => {},
        onSetGroupMembers: () => {},
        onSetGroupName: () => {},
        onSubmitFirstMessage: () => {},
        onSelectModel: () => {},
        onOpenAttachmentPicker: () => {},
        onRemoveAttachment: () => {},
      }),
    );
    findAll(nBare.tree, (n) => n.props?.className === 'm-target-pill')[0]?.props.onClick();
    nBare.rerender();
    nBare.unmount();

    const dNewBareStep2 = createReactHookDriver();
    const nBare2 = dNewBareStep2.mount(() =>
      React.createElement(MobileNewChatSheet, {
        open: true,
        step: 'group-members',
        targetKind: 'group',
        targetBot: 'bare-bot',
        groupMembers: [],
        groupName: '',
        allProfiles: [{ name: 'bare-bot', displayName: '' }],
        gatewayConnected: true,
        selectedModel: 'm1',
        availableModels: ['m1'],
        modelDetails: [],
        attachments: [],
        onClose: () => {},
        onSetStep: () => {},
        onSelectBot: () => {},
        onSetGroupMembers: () => {},
        onSetGroupName: () => {},
        onSubmitFirstMessage: () => {},
        onSelectModel: () => {},
        onOpenAttachmentPicker: () => {},
        onRemoveAttachment: () => {},
      }),
    );
    findAll(nBare2.tree, (n) => n.props?.className === 'm-member-pick-row')[0]?.props.onClick();
    nBare2.unmount();

    // MobileSettingsPage 空 appVersion / 英文 locale / hasStoredPassword=false 与空 profileName 网关连接/测试分支
    const dSetEmpty = createReactHookDriver();
    const setEmptyView = dSetEmpty.mount(() =>
      React.createElement(MobileSettingsPage, {
        open: true,
        subpage: 'gateway',
        appearancePref: 'system',
        snapshot: {
          ...snapshot.settingsSnapshot,
          locale: 'en',
          appVersion: '',
          gateway: {
            ...snapshot.settingsSnapshot.gateway,
            status: 'disconnected',
            profileName: '',
            hasStoredPassword: false,
            test: null,
          },
        },
        onClose: () => {},
        onSelectSubpage: () => {},
        onSetAppearancePreference: () => {},
        settingsActions: actions.settingsActions,
      }),
    );
    findAll(setEmptyView.tree, (n) => n.props?.className === 'm-secondary-btn')[0]?.props.onClick();
    findAll(setEmptyView.tree, (n) => n.props?.className === 'm-primary-btn')[0]?.props.onClick();
    setEmptyView.unmount();

    // MobileMorphingComposer onBlur -> 立即 onFocus 清除定时器（不坍塌）与 unmount 清理
    const dBlurCancel = createReactHookDriver();
    const blurCancelView = dBlurCancel.mount(() =>
      React.createElement(MobileMorphingComposer, {
        placeholder: '输入...',
        isStreaming: false,
        disabled: false,
        selectedModel: 'm1',
        availableModels: ['m1'],
        modelDetails: [],
        attachments: [],
        onSend: () => {},
        onSelectModel: () => {},
      }),
    );
    const clearedBefore = clearedTimeouts.length;
    const taBlur = findAll(blurCancelView.tree, (n) => n.type === 'textarea')[0];
    taBlur.props.onFocus();
    taBlur.props.onBlur();
    taBlur.props.onFocus();
    assert.ok(clearedTimeouts.length > clearedBefore, '再次聚焦必须取消 pending 失焦定时器');
    blurCancelView.rerender();
    assert.equal(findAll(blurCancelView.tree, (n) => n.props?.className === 'm-composer m-no-swipe')[0]?.props['data-expanded'], 'true');
    blurCancelView.unmount();

    // 群聊拼图头像纯哑光断言（零硬编码 rgba / 旧 --bg-card 令牌）
    const emptyCollageHtml = renderGroupCollageAvatar([], []);
    const duoCollageHtml = renderGroupCollageAvatar(['a', 'b'], []);
    assert.equal(emptyCollageHtml.includes('var(--bg-card)'), false);
    assert.equal(duoCollageHtml.includes('rgba('), false);

    // 12. SSR 确认移动端纯哑光 CSS 不含硬编码色相、高光线，且软键盘避让与防焦点滚移契约完备
    const mobileCss = fs
      .readFileSync(path.resolve(import.meta.dirname, '../src/styles/mobile-shell.css'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    assert.equal(/#[0-9a-fA-F]{3,8}\b/.test(mobileCss), false, 'mobile-shell.css 不得出现十六进制硬编码色相');
    assert.equal(/rgba?\(/i.test(mobileCss), false, 'mobile-shell.css 不得出现 rgb/rgba 硬编码色相');
    assert.equal(mobileCss.includes('inset 0 1px'), false, '移动端严禁顶部高光线');
    assert.ok(
      mobileCss.includes('--m-bottom-inset: max(env(safe-area-inset-bottom, 0px), var(--keyboard-height, 0px))'),
      'mobile-shell.css 必须统一使用 max() 计算底部避让 --m-bottom-inset',
    );
    assert.equal(
      /env\(safe-area-inset-bottom[^)]*\)\s*\+\s*var\(--keyboard-height/.test(mobileCss),
      false,
      '严禁将 safe-area-inset-bottom 与 --keyboard-height 相加造成双重偏移',
    );
    for (const sel of [
      '.m-home__scroll',
      '.m-bot-hub__scroll',
      '.m-bot-save-bar',
      '.m-stage__composer-dock',
      '.m-stage__stream',
      '.m-stage__notice',
      '.m-newchat__step',
      '.m-bottom-sheet',
      '.m-settings-page__scroll',
    ]) {
      const escaped = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const blockMatch = new RegExp(`${escaped}[^{]*\\{([^}]*)\\}`).exec(mobileCss);
      assert.ok(blockMatch && blockMatch[1].includes('var(--m-bottom-inset)'), `${sel} 必须消费 var(--m-bottom-inset)`);
    }
    for (const clipSel of ['.m-shell', '.m-shell__main', '.m-pane', '.m-page-sheet', '.m-inspector__viewport']) {
      const escaped = clipSel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const blockMatch = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(mobileCss);
      assert.ok(blockMatch && blockMatch[1].includes('overflow: clip;'), `${clipSel} 必须声明 overflow: clip`);
    }
    const heroMatch = /\.m-newchat__hero\s*\{([^}]*)\}/.exec(mobileCss);
    assert.ok(
      heroMatch && heroMatch[1].includes('min-height: 0;') && heroMatch[1].includes('overflow-y: auto;'),
      '.m-newchat__hero 必须声明 min-height: 0 与 overflow-y: auto 防键盘压扁时挤飞底部输入框',
    );

    // 13. MobileConversationScreen ResizeObserver 在键盘压缩视口时保持贴底可读、非贴底不劫持
    const prevResizeObserver = globalThis.ResizeObserver;
    const resizeCallbacks = [];
    let disconnected = false;
    globalThis.ResizeObserver = class {
      constructor(cb) {
        resizeCallbacks.push(cb);
      }
      observe() {}
      disconnect() {
        disconnected = true;
      }
    };
    try {
      const dConvResize = createReactHookDriver();
      const convView = dConvResize.mount(() =>
        React.createElement(MobileConversationScreen, {
          gatewayConnected: true,
          activeFocus: { type: 'session', sessionId: 's-ro' },
          activeBotDisplayName: '默认中枢',
          isStreaming: false,
          messagesCount: 2,
          selectedModel: 'm1',
          availableModels: ['m1'],
          modelDetails: [],
          attachments: [],
          dockNotice: '',
          sideAgentCapsules: [],
          onSendMessage: () => {},
          onInterruptTurn: () => {},
          onSelectModel: () => {},
          onOpenAttachmentPicker: () => {},
          onRemoveAttachment: () => {},
          onOpenSettings: () => {},
        }),
      );
      const streamNode = findAll(convView.tree, (n) => n.props?.id === 'conversation-stream')[0];
      const streamEl = streamNode.props.ref.current;
      streamEl.scrollHeight = 1200;
      streamEl.clientHeight = 400;
      streamEl.scrollTop = 320; // dist = 1200 - 320 - 844 = 36 <= 180 (near bottom, since initial prevClientHeight was 844)
      resizeCallbacks[resizeCallbacks.length - 1]();
      assert.equal(streamEl.scrollTop, 764, '接近底部时键盘弹起必须等量推进 scrollTop 保持最新消息可见');

      // 远离底部时不劫持用户浏览历史位置
      streamEl.scrollTop = 100;
      streamEl.clientHeight = 250; // delta = 150, prevDist = 1200 - 100 - 400 = 700 > 180
      resizeCallbacks[resizeCallbacks.length - 1]();
      assert.equal(streamEl.scrollTop, 100, '用户远离底部阅读历史时不得劫持 scrollTop');

      // 键盘收起视口变大时不做反向操作
      streamEl.clientHeight = 700;
      resizeCallbacks[resizeCallbacks.length - 1]();
      assert.equal(streamEl.scrollTop, 100);

      convView.unmount();
      assert.equal(disconnected, true, '卸载时必须断开 ResizeObserver');
    } finally {
      globalThis.ResizeObserver = prevResizeObserver;
    }
  } finally {
    globalThis.window = prevWindow;
    globalThis.document = prevDocument;
    globalThis.Element = prevElement;
    globalThis.CustomEvent = prevCustomEvent;
    globalThis.setTimeout = prevSetTimeout;
    globalThis.clearTimeout = prevClearTimeout;
  }
});

test('MobileBotHubScreen、MobileBotSubpage、MobileSettingsPage 分级菜单与悬浮顶栏交互全覆盖', async () => {
  setLocale('zh-CN');
  const prevWin = globalThis.window;
  const prevDoc = globalThis.document;
  const prevCustomEvent = globalThis.CustomEvent;
  const prevHTMLFormElement = globalThis.HTMLFormElement;
  const prevMutationObserver = globalThis.MutationObserver;
  const winListeners = new Map();
  globalThis.HTMLFormElement = class MockHTMLFormElement {};
  globalThis.MutationObserver = class MockMutationObserver {
    observe() {}
    disconnect() {}
  };
  const noopEl = {
    style: {},
    clientWidth: 390,
    clientHeight: 844,
    children: [],
    parentElement: null,
    parentNode: null,
    firstElementChild: null,
    lastElementChild: null,
    insertAdjacentElement() {},
    setAttribute() {},
    getAttribute() {
      return null;
    },
    hasAttribute() {
      return false;
    },
    removeAttribute() {},
    appendChild() {},
    removeChild() {},
    insertBefore() {},
    remove() {},
    contains() {
      return false;
    },
    focus() {},
    addEventListener() {},
    removeEventListener() {},
    querySelectorAll() {
      return [];
    },
  };

  globalThis.CustomEvent = class MockCustomEvent {
    constructor(type, opts = {}) {
      this.type = type;
      this.cancelable = Boolean(opts.cancelable);
      this.defaultPrevented = false;
    }
    preventDefault() {
      if (this.cancelable) this.defaultPrevented = true;
    }
  };
  globalThis.document = {
    activeElement: null,
    documentElement: { ...noopEl },
    head: { ...noopEl },
    body: { ...noopEl },
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {
      return true;
    },
    createElement() {
      return { ...noopEl };
    },
    createTextNode() {
      return { ...noopEl };
    },
    contains() {
      return false;
    },
    querySelectorAll() {
      return [];
    },
  };
  globalThis.window = {
    document: globalThis.document,
    innerWidth: 390,
    innerHeight: 844,
    setTimeout() {
      return 1;
    },
    clearTimeout() {},
    getComputedStyle() {
      return {
        animationName: 'none',
        paddingLeft: '0px',
        paddingTop: '0px',
        paddingRight: '0px',
        marginLeft: '0px',
        marginTop: '0px',
        marginRight: '0px',
      };
    },
    HTMLInputElement: class MockHTMLInputElement {
      get checked() {
        return false;
      }
      set checked(_v) {}
    },
    addEventListener(type, fn) {
      if (!winListeners.has(type)) winListeners.set(type, []);
      winListeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      winListeners.set(type, (winListeners.get(type) ?? []).filter((f) => f !== fn));
    },
    dispatchEvent(ev) {
      for (const fn of [...(winListeners.get(ev.type) ?? [])]) fn(ev);
      return !ev.defaultPrevented;
    },
  };

  try {
    const { snapshot, actions, log } = createSampleData();

    // 0. MobileMenuCard / MobileBotSaveBar / runMobileMcpTest / runMobileMcpRemove 直接单测
    assert.ok(
      renderToStaticMarkup(React.createElement(MobileMenuCard, { className: 'custom-card' }, 'ok')).includes(
        'm-menu-card custom-card',
      ),
    );
    assert.equal(
      renderToStaticMarkup(
        React.createElement(MobileBotSaveBar, {
          dirty: false,
          saving: false,
          onReset: () => {},
          onSave: () => {},
        }),
      ),
      '',
    );
    const savingBarHtml = renderToStaticMarkup(
      React.createElement(MobileBotSaveBar, {
        dirty: false,
        saving: true,
        onReset: () => {},
        onSave: () => {},
      }),
    );
    assert.ok(savingBarHtml.includes('disabled'));

    const mcpNotes = [];
    const testingStates = [];
    await runMobileMcpTest({
      targetProfile: '',
      serverName: 'fs',
      busy: false,
      testServer: async () => ({ ok: true, tools: [], oauthNeeded: false }),
      notify: (m) => mcpNotes.push(m),
      setTesting: (v) => testingStates.push(v),
    });
    await runMobileMcpTest({
      targetProfile: 'default',
      serverName: 'fs',
      busy: false,
      testServer: undefined,
      notify: (m) => mcpNotes.push(m),
      setTesting: (v) => testingStates.push(v),
    });
    await runMobileMcpTest({
      targetProfile: 'default',
      serverName: 'fs',
      busy: true,
      testServer: async () => ({ ok: true, tools: [], oauthNeeded: false }),
      notify: (m) => mcpNotes.push(m),
      setTesting: (v) => testingStates.push(v),
    });
    assert.equal(mcpNotes.length, 0);

    await runMobileMcpTest({
      targetProfile: 'default',
      serverName: 'fs',
      busy: false,
      testServer: async () => ({ ok: false, tools: [], oauthNeeded: false, error: '' }),
      notify: (m) => mcpNotes.push(m),
      setTesting: (v) => testingStates.push(v),
    });
    await runMobileMcpTest({
      targetProfile: 'default',
      serverName: 'fs',
      busy: false,
      testServer: async () => {
        throw 'string-failure';
      },
      notify: (m) => mcpNotes.push(m),
      setTesting: (v) => testingStates.push(v),
    });
    await runMobileMcpTest({
      targetProfile: 'default',
      serverName: 'fs',
      busy: false,
      shouldCommit: () => false,
      testServer: async () => ({ ok: true, tools: [], oauthNeeded: false }),
      notify: (m) => mcpNotes.push(m),
      setTesting: (v) => testingStates.push(v),
    });
    await runMobileMcpTest({
      targetProfile: 'default',
      serverName: 'fs',
      busy: false,
      shouldCommit: () => false,
      testServer: async () => {
        throw new Error('stale-err');
      },
      notify: (m) => mcpNotes.push(m),
      setTesting: (v) => testingStates.push(v),
    });
    assert.ok(mcpNotes.some((m) => m.includes('string-failure')));

    const rmNotes = [];
    await runMobileMcpRemove({
      targetProfile: '',
      serverName: 'fs',
      busy: false,
      removeServer: async () => ({ ok: true }),
      notify: (m) => rmNotes.push(m),
      setRemoving: () => {},
      onRemoved: () => {},
    });
    await runMobileMcpRemove({
      targetProfile: 'default',
      serverName: null,
      busy: false,
      removeServer: async () => ({ ok: true }),
      notify: (m) => rmNotes.push(m),
      setRemoving: () => {},
      onRemoved: () => {},
    });
    await runMobileMcpRemove({
      targetProfile: 'default',
      serverName: 'fs',
      busy: true,
      removeServer: async () => ({ ok: true }),
      notify: (m) => rmNotes.push(m),
      setRemoving: () => {},
      onRemoved: () => {},
    });
    assert.equal(rmNotes.length, 0);
    await runMobileMcpRemove({
      targetProfile: 'default',
      serverName: 'fs',
      busy: false,
      removeServer: async () => ({ ok: false, message: '' }),
      notify: (m) => rmNotes.push(m),
      setRemoving: () => {},
      onRemoved: () => {},
    });
    await runMobileMcpRemove({
      targetProfile: 'default',
      serverName: 'fs',
      busy: false,
      removeServer: async () => {
        throw new Error('rm-err');
      },
      notify: (m) => rmNotes.push(m),
      setRemoving: () => {},
      onRemoved: () => {},
    });
    await runMobileMcpRemove({
      targetProfile: 'default',
      serverName: 'fs',
      busy: false,
      removeServer: async () => {
        throw 'rm-string-err';
      },
      notify: (m) => rmNotes.push(m),
      setRemoving: () => {},
      onRemoved: () => {},
    });
    let removedCalled = false;
    await runMobileMcpRemove({
      targetProfile: 'default',
      serverName: 'fs',
      busy: false,
      removeServer: async () => ({ ok: true }),
      notify: (m) => rmNotes.push(m),
      setRemoving: () => {},
      onRemoved: () => {
        removedCalled = true;
      },
    });
    assert.equal(removedCalled, true);
    assert.ok(rmNotes.some((m) => m.includes('rm-string-err')));

    // 1. MobileHomeScreen 切换到 bots 视图与新建 Bot 触发
    const dHome = createReactHookDriver();
    snapshot.homeTab = 'chats';
    const homeView = dHome.mount(() =>
      React.createElement(MobileHomeScreen, {
        homeTab: snapshot.homeTab,
        model: snapshot.homeModel,
        allProfiles: snapshot.allProfiles,
        groupAvatars: snapshot.groupAvatars,
        activeBotName: snapshot.activeBotName,
        gatewayConnected: true,
        gatewayConnecting: false,
        searchOpen: false,
        settingsSnapshot: snapshot.settingsSnapshot,
        modelDetails: snapshot.modelDetails,
        onSelectHomeTab: actions.onSelectHomeTab,
        onSelectBotSubpage: actions.onSelectBotSubpage,
        onOpenSettings: actions.onOpenSettings,
        onOpenSettingsGateway: () => actions.onOpenSettingsSubpage('gateway'),
        onOpenSearch: actions.onOpenSearch,
        onCloseSearch: actions.onCloseSearch,
        onSearchChange: actions.onSearchChange,
        onOpenNewChat: actions.onOpenNewChat,
        onToggleSection: actions.onToggleSection,
        onSelectBot: actions.onSelectBot,
        onSelectGroup: actions.onSelectGroup,
        onSelectSession: actions.onSelectSession,
        onOpenActionSheet: actions.onOpenActionSheet,
        settingsActions: actions.settingsActions,
      }),
    );
    findAll(homeView.tree, (n) => n.props?.['data-testid'] === 'mobile-tab-bots')[0]?.props.onClick();
    assert.ok(log.some(([k, v]) => k === 'onSelectHomeTab' && v === 'bots'));
    snapshot.homeTab = 'bots';
    homeView.rerender();
    findAll(homeView.tree, (n) => n.props?.['data-testid'] === 'mobile-bot-create-trigger')[0]?.props.onClick();
    assert.ok(log.some(([k, v]) => k === 'settings.onOpenBotWizard' && v === 'blank'));
    homeView.unmount();

    // 2. MobileBotHubScreen 轮播切人、横幅、保存栏与回退 roster 全分支（带完整可证伪断言）
    log.length = 0;
    let hubState = {
      allProfiles: snapshot.allProfiles,
      activeBotName: 'default',
      gatewayConnected: false,
      settingsSnapshot: {
        ...snapshot.settingsSnapshot,
        botManagement: {
          ...snapshot.settingsSnapshot.botManagement,
          activeDraft: {
            ...snapshot.settingsSnapshot.botManagement.activeDetail,
            displayName: '改名中枢',
            disabledSkills: [],
            enabledToolsets: ['t1'],
            enabledMcpServers: ['mcp1'],
            avatar: { kind: 'unchanged' },
          },
          errorBanner: '同步错误',
          confirmPending: { message: '' },
          status: { status: 'detail_error', message: 'detail fail' },
        },
      },
    };
    const dHub = createReactHookDriver();
    const hubView = dHub.mount(() =>
      React.createElement(MobileBotHubScreen, {
        allProfiles: hubState.allProfiles,
        activeBotName: hubState.activeBotName,
        gatewayConnected: hubState.gatewayConnected,
        settingsSnapshot: hubState.settingsSnapshot,
        modelDetails: snapshot.modelDetails,
        onSelectBotSubpage: actions.onSelectBotSubpage,
        onOpenBotChat: actions.onSelectBot,
        onOpenSettingsGateway: () => actions.onOpenSettingsSubpage('gateway'),
        onHapticSelection: actions.onHapticSelection,
        settingsActions: actions.settingsActions,
      }),
    );
    // 索引 0 为当前中心 (default)：点 current 打开 identity 子页，点 next 切往 arch 并触发微震
    findAll(hubView.tree, (n) => n.props?.['data-testid'] === 'mobile-bot-current')[0]?.props.onClick();
    findAll(hubView.tree, (n) => n.props?.['data-testid'] === 'mobile-bot-next')[0]?.props.onClick();

    // 连续惯性横向滚动：onScroll 经 scrollLeft 连续映射中心缩放并触发 haptics 与防抖 settle
    const carousel = findAll(hubView.tree, (n) => n.props?.['data-testid'] === 'mobile-bot-carousel')[0];
    carousel.props.onScroll({ currentTarget: { scrollLeft: 184 } }); // idx 2 = ops (2 * 92px)
    hubView.rerender();
    assert.ok(log.some(([k]) => k === 'onHapticSelection'));
    // 快速滑回后停在新条目，120ms 防抖收敛到最终中心 Bot
    await new Promise((r) => setTimeout(r, 150));
    assert.ok(log.some(([k, v]) => k === 'settings.onSelectBotSettle' && v === 'ops'));

    // 停回当前已有 activeBotId ('default') 时不得重复下发无意义的 settle
    carousel.props.onScroll({ currentTarget: { scrollLeft: 0 } });
    await new Promise((r) => setTimeout(r, 150));

    // 桌面端鼠标左键横向拖拽 + 非左键/触控忽略 + 死区 + 错 pointerId + 释放异常降级 + 拖后吞误触点击
    carousel.props.onPointerDown({ button: 2, pointerType: 'mouse', pointerId: 1, clientX: 200 });
    carousel.props.onPointerDown({ button: 0, pointerType: 'touch', pointerId: 1, clientX: 200 });
    carousel.props.onPointerMove({ pointerId: 1, clientX: 120 });
    carousel.props.onPointerUp({ pointerId: 1, clientX: 120 });

    // 小位移未超 6px 死区
    carousel.props.onPointerDown({ button: 0, pointerType: 'mouse', pointerId: 2, clientX: 200 });
    carousel.props.onPointerMove({ pointerId: 2, clientX: 198 });
    carousel.props.onPointerMove({ pointerId: 99, clientX: 80 });
    carousel.props.onPointerUp({ pointerId: 99, clientX: 80 });
    carousel.props.onPointerUp({ pointerId: 2, clientX: 198 });

    // setPointerCapture 抛错时静默降级、onTouchStart 重置、以及程序化 scrollTo 期间的 mid-flight onScroll 抑制
    const denyCaptureTarget = {
      scrollLeft: 0,
      setPointerCapture() {
        throw new Error('capture denied');
      },
    };
    carousel.props.onPointerDown({
      button: 0,
      pointerType: 'mouse',
      pointerId: 33,
      clientX: 200,
      currentTarget: denyCaptureTarget,
    });
    carousel.props.onPointerMove({ pointerId: 33, clientX: 120, currentTarget: denyCaptureTarget });
    carousel.props.onPointerCancel({ pointerId: 33, clientX: 120, currentTarget: denyCaptureTarget });
    carousel.props.onTouchStart();
    await new Promise((r) => setTimeout(r, 15));

    // 当 viewportRef.current 带 scrollTo 时，非居中槽位点击走 smooth scrollTo 分支，并抑制远距中途 scroll
    const progViewport = findAll(hubView.tree, (n) => n.props?.['data-testid'] === 'mobile-bot-carousel')[0];
    const progRef = progViewport?.props?.ref ?? progViewport?.ref;
    let progScrolledTo = null;
    if (progRef?.current) {
      progRef.current.scrollTo = (opts) => {
        progScrolledTo = opts;
      };
    }
    const progSlotTarget =
      findAll(hubView.tree, (n) => n.props?.['data-testid'] === 'mobile-bot-next')[0] ??
      findAll(hubView.tree, (n) => n.props?.['data-testid'] === 'mobile-bot-prev')[0];
    assert.ok(progSlotTarget, '非居中槽位按钮必须存在');
    progSlotTarget.props.onClick();
    assert.ok(progScrolledTo && typeof progScrolledTo.left === 'number');
    // 程序化平滑滚动途经中间偏移时不得提前触发 settle；到达目标附近则放行
    carousel.props.onScroll({ currentTarget: { scrollLeft: progScrolledTo.left + 40 } });
    carousel.props.onScroll({ currentTarget: { scrollLeft: progScrolledTo.left } });
    await new Promise((r) => setTimeout(r, 15));

    // 左键拖拽超过死区：锁定捕获 -> 拖动 scrollLeft -> 释放（覆盖无 smooth scrollTo 分支与吞掉紧邻点击）
    let capturedPid = -1;
    const mockScroller = {
      scrollLeft: 0,
      setPointerCapture(pid) {
        capturedPid = pid;
      },
      releasePointerCapture() {
        throw new Error('not captured');
      },
    };
    carousel.props.onPointerDown({ button: 0, pointerType: 'mouse', pointerId: 3, clientX: 200, currentTarget: mockScroller });
    carousel.props.onPointerMove({ pointerId: 3, clientX: 100, currentTarget: mockScroller });
    assert.equal(capturedPid, 3);
    hubView.rerender();
    assert.equal(
      findAll(hubView.tree, (n) => n.props?.['data-testid'] === 'mobile-bot-carousel')[0]?.props['data-dragging'],
      'true',
    );
    carousel.props.onPointerUp({ pointerId: 3, clientX: 100, currentTarget: mockScroller });
    // 拖拽刚刚释放时，同帧误触点击 current 必须被吞掉而不进入子页
    const subpageCountBeforeSuppressedClick = log.filter(([k]) => k === 'onSelectBotSubpage').length;
    findAll(hubView.tree, (n) => n.props?.['data-testid'] === 'mobile-bot-current')[0]?.props.onClick();
    assert.equal(log.filter(([k]) => k === 'onSelectBotSubpage').length, subpageCountBeforeSuppressedClick);
    await new Promise((r) => setTimeout(r, 15));

    // 当 viewportRef.current 带 scrollTo 时，非居中槽位点击走 smooth scrollTo 分支
    const curViewport = findAll(hubView.tree, (n) => n.props?.['data-testid'] === 'mobile-bot-carousel')[0];
    const vpRef = curViewport?.props?.ref ?? curViewport?.ref;
    let slotScrolledTo = null;
    if (vpRef?.current) {
      vpRef.current.scrollTo = (opts) => {
        slotScrolledTo = opts;
      };
    }
    const slotTarget =
      findAll(hubView.tree, (n) => n.props?.['data-testid'] === 'mobile-bot-next')[0] ??
      findAll(hubView.tree, (n) => n.props?.['data-testid'] === 'mobile-bot-prev')[0];
    assert.ok(slotTarget, '非居中槽位按钮必须存在');
    slotTarget.props.onClick();
    assert.ok(slotScrolledTo && typeof slotScrolledTo.left === 'number');

    // attachRefs=false 时回退到 event.currentTarget 读取/滚动 + 非居中项 displayName 缺失回fallback bot.id
    const dBareHub = createReactHookDriver({ attachRefs: false });
    const bareHubView = dBareHub.mount(() =>
      React.createElement(MobileBotHubScreen, {
        allProfiles: [{ name: 'only-id', displayName: '', isDefault: true }],
        activeBotName: 'only-id',
        gatewayConnected: true,
        settingsSnapshot: {
          ...snapshot.settingsSnapshot,
          botManagement: {
            ...snapshot.settingsSnapshot.botManagement,
            activeBotId: 'only-id',
            roster: [
              { id: 'only-id', displayName: 'Primary', model: '', avatar: '', isDefault: true, hasDraft: false },
              { id: 'unnamed-bot', displayName: '', model: '', avatar: '', isDefault: false, hasDraft: false },
            ],
          },
        },
        modelDetails: [],
        onSelectBotSubpage: () => {},
        onOpenBotChat: () => {},
        onOpenSettingsGateway: () => {},
        settingsActions: actions.settingsActions,
      }),
    );
    const bareCarousel = findAll(bareHubView.tree, (n) => n.props?.['data-testid'] === 'mobile-bot-carousel')[0];
    let bareScrollTarget = null;
    const bareTarget = {
      scrollLeft: 0,
      scrollTo(opts) {
        bareScrollTarget = opts;
      },
    };
    bareCarousel.props.onPointerDown({ button: 0, pointerType: 'mouse', pointerId: 8, clientX: 200, currentTarget: bareTarget });
    bareCarousel.props.onPointerMove({ pointerId: 8, clientX: 130, currentTarget: bareTarget });
    bareCarousel.props.onPointerUp({ pointerId: 8, clientX: 130, currentTarget: bareTarget });
    assert.deepEqual(bareScrollTarget, { left: 96, behavior: 'smooth' });
    await new Promise((r) => setTimeout(r, 15));
    // attachRefs=false 下点击非居中槽位时 viewportRef.current 为 null -> 覆盖 scrollViewportTo(!el) 早退分支
    findAll(bareHubView.tree, (n) => n.props?.['data-testid'] === 'mobile-bot-next')[0]?.props.onClick();
    bareHubView.unmount();

    // 外部 settledIdx 变化且 el.scrollLeft 与目标相差 >1px 时，useEffect 主动对齐 scrollLeft（覆盖 line 152-153）
    if (vpRef?.current) {
      vpRef.current.scrollLeft = 0;
      const prevBotId = hubState.settingsSnapshot.botManagement.activeBotId;
      hubState = {
        ...hubState,
        settingsSnapshot: {
          ...hubState.settingsSnapshot,
          botManagement: { ...hubState.settingsSnapshot.botManagement, activeBotId: 'arch' },
        },
      };
      hubView.rerender();
      assert.equal(vpRef.current.scrollLeft, 96);
      hubState = {
        ...hubState,
        settingsSnapshot: {
          ...hubState.settingsSnapshot,
          botManagement: { ...hubState.settingsSnapshot.botManagement, activeBotId: prevBotId },
        },
      };
      hubView.rerender();
    }

    // 带 scrollTo 的正常鼠标拖移分支（覆盖 ref 无 scrollTo -> onScrollTo 回落与 ops 落定），随后滑回 default 验证保存栏与操作
    carousel.props.onPointerDown({ button: 0, pointerType: 'mouse', pointerId: 4, clientX: 280 });
    carousel.props.onPointerMove({ pointerId: 4, clientX: 90 });
    carousel.props.onPointerUp({ pointerId: 4, clientX: 90 });
    await new Promise((r) => setTimeout(r, 150));

    carousel.props.onTouchStart();
    carousel.props.onScroll({ currentTarget: { scrollLeft: 0 } });
    hubView.rerender();

    // 已位于 targetLeft ±1px 时，scrollViewportTo 不得触发 scrollTo 或残留 programmaticScrollTargetRef 锁死后续滚轮滚动
    if (vpRef?.current) {
      let samePosScrollCalls = 0;
      vpRef.current.scrollLeft = 0;
      vpRef.current.scrollTo = () => {
        samePosScrollCalls += 1;
      };
      carousel.props.onPointerDown({ button: 0, pointerType: 'mouse', pointerId: 14, clientX: 100 });
      carousel.props.onPointerMove({ pointerId: 14, clientX: 200 });
      carousel.props.onPointerUp({ pointerId: 14, clientX: 200 });
      assert.equal(samePosScrollCalls, 0);
      await new Promise((r) => setTimeout(r, 15));
      carousel.props.onScroll({ currentTarget: { scrollLeft: 192 } });
      await new Promise((r) => setTimeout(r, 150));
      assert.equal(log.at(-1)?.[0], 'settings.onSelectBotSettle');
      assert.equal(log.at(-1)?.[1], 'ops');
      carousel.props.onScroll({ currentTarget: { scrollLeft: 0 } });
      hubView.rerender();
    }

    findAll(hubView.tree, (n) => n.props?.['data-testid'] === 'mobile-bot-open-chat')[0]?.props.onClick();
    for (const rid of ['model', 'soul', 'identity', 'skills', 'toolsets', 'mcp', 'memory']) {
      findAll(hubView.tree, (n) => n.props?.['data-testid'] === `mobile-bot-row-${rid}`)[0]?.props.onClick();
    }
    findAll(hubView.tree, (n) => n.props?.className === 'm-bot-save-bar__reset')[0]?.props.onClick();
    findAll(hubView.tree, (n) => n.props?.className === 'm-bot-save-bar__submit')[0]?.props.onClick();
    findAll(hubView.tree, (n) => n.props?.['aria-label'] === '关闭错误提示')[0]?.props.onClick();
    findAll(hubView.tree, (n) => n.props?.className === 'm-home__offline-banner')[0]?.props.onClick();
    const warnBtns = findAll(hubView.tree, (n) => n.props?.className === 'm-bot-banner m-bot-banner--warn').flatMap(
      (b) => findAll(b, (x) => x.type === 'button'),
    );
    warnBtns.forEach((b) => b.props.onClick());
    findAll(hubView.tree, (n) => n.props?.children === '重试')[0]?.props.onClick();

    assert.equal(log.filter(([k]) => k === 'settings.onSelectBotSettle').length, 11, '四次槽位点击 + scroll 防抖 + 五次拖移/滚轮 + 重试必须触发 11 次 onSelectBotSettle（无重复定时器补发）');
    assert.deepEqual(
      log.filter(([k]) => k === 'onSelectBotSubpage').map(([, v]) => v),
      ['identity', 'model', 'soul', 'identity', 'skills', 'toolsets', 'mcp', 'memory'],
    );
    assert.ok(log.some(([k, v]) => k === 'onSelectBot' && v === 'default'));
    assert.ok(log.some(([k, v]) => k === 'settings.onResetBotDraft' && v === 'default'));
    assert.ok(log.some(([k, id, opts]) => k === 'settings.onSaveBotConfig' && id === 'default' && !opts));
    assert.ok(log.some(([k, id, opts]) => k === 'settings.onSaveBotConfig' && id === 'default' && opts?.confirmExpensive === true));
    assert.ok(log.some(([k]) => k === 'settings.onDismissBotError'));
    assert.ok(log.some(([k, v]) => k === 'onOpenSettingsSubpage' && v === 'gateway'));
    assert.ok(log.some(([k]) => k === 'settings.onDismissBotConfirm'));

    // Fallback roster (settingsProfiles ready + missing model + non-default), missing activeDetail, blank soul, 1-bot carousel
    hubState = {
      allProfiles: [
        { name: 'custom-one', displayName: '', isDefault: false, avatar: '' },
        { name: 'default', displayName: '默认', isDefault: true, avatar: 'av://d' },
      ],
      activeBotName: '',
      gatewayConnected: true,
      settingsSnapshot: {
        ...snapshot.settingsSnapshot,
        profiles: {
          status: 'ready',
          data: [
            { name: 'custom-one', model: 'openai/gpt-4o' },
            { name: 'default', model: '' },
          ],
        },
        botManagement: {
          ...snapshot.settingsSnapshot.botManagement,
          activeBotId: '',
          roster: [],
          activeDetail: {
            ...snapshot.settingsSnapshot.botManagement.activeDetail,
            id: 'other-bot',
          },
          activeDraft: undefined,
        },
      },
    };
    hubView.rerender();
    assert.equal(
      findAll(hubView.tree, (n) => n.props?.className === 'm-bot-hub__name')[0]?.props.children,
      'custom-one',
    );

    // 匹配 activeDetail + activeDraft=undefined + 空白 soul + activeBotId='' + activeBotName='solo'
    hubState = {
      allProfiles: [{ name: 'solo', displayName: '独行', isDefault: false }],
      activeBotName: 'solo',
      gatewayConnected: true,
      settingsSnapshot: {
        ...snapshot.settingsSnapshot,
        profiles: { status: 'idle' },
        botManagement: {
          ...snapshot.settingsSnapshot.botManagement,
          activeBotId: '',
          roster: [],
          activeDetail: {
            ...snapshot.settingsSnapshot.botManagement.activeDetail,
            id: 'solo',
            model: '',
            avatar: undefined,
            isDefault: false,
            soul: '   ',
          },
          activeDraft: undefined,
          confirmPending: { message: 'explicit warn' },
        },
      },
    };
    hubView.rerender();
    assert.equal(findAll(hubView.tree, (n) => n.props?.className === 'm-bot-hub__name')[0]?.props.children, '默认中枢');

    // roster item model === undefined 且 detail === undefined -> 命中 current.model ?? ''
    hubState = {
      allProfiles: [],
      activeBotName: 'undef-model',
      gatewayConnected: true,
      settingsSnapshot: {
        ...snapshot.settingsSnapshot,
        botManagement: {
          ...snapshot.settingsSnapshot.botManagement,
          activeBotId: 'undef-model',
          roster: [{ id: 'undef-model', displayName: '无模型', model: undefined, isDefault: false, hasDraft: false }],
          activeDetail: undefined,
          activeDraft: undefined,
        },
      },
    };
    hubView.rerender();
    assert.equal(findAll(hubView.tree, (n) => n.props?.className === 'm-bot-hub__model')[0]?.props.children, '跟随网关默认模型');
    hubView.unmount();

    // 空 roster + list_error 重试 + connected/loading
    log.length = 0;
    const emptyHubHtml = renderToStaticMarkup(
      React.createElement(MobileBotHubScreen, {
        allProfiles: [],
        activeBotName: '',
        gatewayConnected: false,
        settingsSnapshot: {
          ...snapshot.settingsSnapshot,
          botManagement: {
            ...snapshot.settingsSnapshot.botManagement,
            activeBotId: '',
            status: { status: 'list_error', message: 'fail' },
            roster: [],
          },
        },
        modelDetails: [],
        onSelectBotSubpage: () => {},
        onOpenBotChat: () => {},
        onOpenSettingsGateway: () => {},
        settingsActions: actions.settingsActions,
      }),
    );
    assert.ok(emptyHubHtml.includes('暂无智能体配置'));
    assert.ok(
      renderToStaticMarkup(
        React.createElement(MobileBotHubScreen, {
          allProfiles: [],
          activeBotName: '',
          gatewayConnected: true,
          settingsSnapshot: {
            ...snapshot.settingsSnapshot,
            botManagement: {
              ...snapshot.settingsSnapshot.botManagement,
              activeBotId: '',
              status: { status: 'loading' },
              roster: [],
            },
          },
          modelDetails: [],
          onSelectBotSubpage: () => {},
          onOpenBotChat: () => {},
          onOpenSettingsGateway: () => {},
          settingsActions: actions.settingsActions,
        }),
      ).includes('暂无智能体配置'),
    );

    // draft.provider 为 undefined 时回退 detail.provider，准确区分跨提供商同名模型展示标签
    const relayBotHtml = renderToStaticMarkup(
      React.createElement(MobileBotHubScreen, {
        allProfiles: snapshot.allProfiles,
        activeBotName: 'default',
        gatewayConnected: true,
        settingsSnapshot: {
          ...snapshot.settingsSnapshot,
          botManagement: {
            ...snapshot.settingsSnapshot.botManagement,
            activeBotId: 'default',
            activeDetail: {
              ...snapshot.settingsSnapshot.botManagement.activeDetail,
              model: 'openai/gpt-4o',
              provider: 'custom-relay',
            },
            activeDraft: {
              ...snapshot.settingsSnapshot.botManagement.activeDetail,
              model: 'openai/gpt-4o',
              provider: undefined,
              disabledSkills: [],
              enabledToolsets: ['t1'],
              enabledMcpServers: ['mcp1'],
              avatar: { kind: 'unchanged' },
            },
          },
        },
        modelDetails: [
          { id: 'openai/gpt-4o', provider: 'openai', displayName: 'Official GPT-4o' },
          { id: 'openai/gpt-4o', provider: 'custom-relay', displayName: 'Relay GPT-4o' },
        ],
        onSelectBotSubpage: () => {},
        onOpenBotChat: () => {},
        onOpenSettingsGateway: () => {},
        settingsActions: actions.settingsActions,
      }),
    );
    assert.ok(relayBotHtml.includes('Relay GPT-4o'), 'MobileBotHubScreen 必须优先匹配绑定 Provider 的模型名称');

    // 3. MobileBotSubpage 7 大子页 + 边界状态（含离线/list_error/同名跨提供商/移除清除mcpOverrides） + MobileBotWizardSheet
    log.length = 0;
    let curSubpage = 'identity';
    let curSnapshot = {
      ...snapshot.settingsSnapshot,
      botManagement: {
        ...snapshot.settingsSnapshot.botManagement,
        availableModels: [
          ...snapshot.settingsSnapshot.botManagement.availableModels,
          { id: 'openai/gpt-4o', name: 'GPT-4o Relay', provider: 'custom-relay', providerName: 'Custom Relay' },
        ],
        activeDraft: {
          ...snapshot.settingsSnapshot.botManagement.activeDetail,
          disabledSkills: ['sk1'],
          enabledToolsets: ['t1'],
          enabledMcpServers: ['mcp1'],
          avatar: { kind: 'unchanged' },
        },
      },
    };
    const mcpResults = [
      { ok: true, tools: ['a'], oauthNeeded: false },
      { ok: false, tools: [], oauthNeeded: true },
      { ok: false, tools: [], oauthNeeded: false, error: 'timeout' },
    ];
    let copyResult = true;
    let cropBehavior = async () => 'data:image/png;base64,CROPPED';
    const timeouts = [];
    const origSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (fn) => {
      timeouts.push(fn);
      return 1;
    };
    try {
      const subActions = {
        ...actions.settingsActions,
        onCopy: async (txt) => {
          log.push(['settings.onCopy', txt]);
          return copyResult;
        },
        onTestMcpServer: async () => {
          const next = mcpResults.shift();
          if (!next) throw new Error('network');
          return next;
        },
        onRemoveMcpServer: async () => ({ ok: true }),
        onInspectSkill: async () => ({ ok: true, data: { name: 'sk1', content: '# Skill' } }),
        onInstallSkill: async () => ({ ok: true }),
        onSearchSkillsHub: async () => ({ ok: true, items: [] }),
        onFetchMcpCatalog: async () => ({ ok: true, items: [] }),
        onAddMcpServer: async () => ({ ok: true }),
      };
      const dSub = createReactHookDriver();
      const subView = dSub.mount(() =>
        React.createElement(MobileBotSubpagePanel, {
          subpage: curSubpage,
          settingsSnapshot: curSnapshot,
          settingsActions: subActions,
          onBack: () => actions.onSelectBotSubpage(null),
          onOpenBotChat: actions.onSelectBot,
          onOpenProviders: () => actions.onOpenSettingsSubpage('providers'),
          onOpenGateway: () => actions.onOpenSettingsSubpage('gateway'),
          cropAvatarFn: (file) => cropBehavior(file),
        }),
      );

      const clickSwitch = (tree, ariaLabel) => {
        const sw = findAll(
          tree,
          (n) => n.type === 'button' && n.props?.role === 'switch' && n.props?.['aria-label'] === ariaLabel,
        )[0];
        sw?.props.onClick({ isPropagationStopped: () => false, stopPropagation() {} });
      };

      // identity 子页全动作
      findAll(subView.tree, (n) => n.props?.className === 'm-bot-identity-avatar-btn')[0]?.props.onClick();
      findAll(subView.tree, (n) => n.props?.className === 'm-bot-link-btn')[0]?.props.onClick();
      const copyBtn = findAll(subView.tree, (n) => n.props?.className === 'm-bot-identity-avatar-row').flatMap((r) =>
        findAll(r, (x) => x.props?.['aria-label'] === '复制 ID'),
      )[0];
      await copyBtn?.props.onClick();
      subView.rerender();
      timeouts.forEach((fn) => fn());
      subView.rerender();
      copyResult = false;
      await copyBtn?.props.onClick();
      const fileInput = findAll(subView.tree, (n) => n.type === 'input' && n.props?.type === 'file')[0];
      await fileInput.props.onChange({ currentTarget: { files: [], value: 'x' } });
      await fileInput.props.onChange({ currentTarget: { files: [{}], value: 'x' } });
      cropBehavior = async () => {
        throw new AvatarProcessingError('too-large', 'big');
      };
      await fileInput.props.onChange({ currentTarget: { files: [{}], value: 'x' } });
      cropBehavior = async () => {
        throw new AvatarProcessingError('invalid-type', 'bad');
      };
      await fileInput.props.onChange({ currentTarget: { files: [{}], value: 'x' } });
      cropBehavior = async () => {
        throw new Error('boom');
      };
      await fileInput.props.onChange({ currentTarget: { files: [{}], value: 'x' } });
      findAll(subView.tree, (n) => n.type === 'input' && n.props?.type === 'text')[0]?.props.onChange({
        target: { value: '新名字' },
      });
      findAll(subView.tree, (n) => n.props?.className === 'm-matte-input m-bot-textarea')[0]?.props.onChange({
        target: { value: '新描述' },
      });
      clickSwitch(subView.tree, '设为工作区默认 BOT');

      assert.ok(log.some(([k, v]) => k === 'settings.onCopy' && v === 'default'));
      assert.ok(log.some(([k, v]) => k === 'settings.onNotify' && v === t('bot.copied')));
      assert.ok(log.some(([k, v]) => k === 'settings.onNotify' && v === t('bot.avatarTooLarge')));
      assert.ok(log.some(([k, v]) => k === 'settings.onNotify' && v === t('bot.avatarInvalidType')));
      assert.ok(log.some(([k, v]) => k === 'settings.onNotify' && v === t('bot.avatarCropFailed')));
      assert.ok(log.some(([k, id, patch]) => k === 'settings.onBotDraftChange' && id === 'default' && patch.avatar?.kind === 'clear'));
      assert.ok(log.some(([k, id, patch]) => k === 'settings.onBotDraftChange' && id === 'default' && patch.avatar?.dataUrl === 'data:image/png;base64,CROPPED'));
      assert.ok(log.some(([k, id, patch]) => k === 'settings.onBotDraftChange' && id === 'default' && patch.displayName === '新名字'));
      assert.ok(log.some(([k, id, patch]) => k === 'settings.onBotDraftChange' && id === 'default' && patch.description === '新描述'));
      assert.ok(log.some(([k, id, patch]) => k === 'settings.onBotDraftChange' && id === 'default' && patch.isDefault === false));

      // activeDetail.avatar 缺失时回落 rosterAvatar 与 canReset=false 分支
      assert.ok(
        renderToStaticMarkup(
          React.createElement(MobileBotSubpagePanel, {
            subpage: 'identity',
            settingsSnapshot: {
              ...curSnapshot,
              botManagement: {
                ...curSnapshot.botManagement,
                activeDraft: { ...curSnapshot.botManagement.activeDraft, avatar: { kind: 'clear' } },
                activeDetail: { ...curSnapshot.botManagement.activeDetail, avatar: undefined },
              },
            },
            settingsActions: subActions,
            onBack: () => {},
            onOpenBotChat: () => {},
            onOpenProviders: () => {},
          }),
        ).includes('default'),
      );
      renderToStaticMarkup(
        React.createElement(MobileBotSubpagePanel, {
          subpage: 'identity',
          settingsSnapshot: {
            ...curSnapshot,
            botManagement: {
              ...curSnapshot.botManagement,
              roster: [],
              activeDraft: { ...curSnapshot.botManagement.activeDraft, avatar: { kind: 'unchanged' } },
              activeDetail: { ...curSnapshot.botManagement.activeDetail, avatar: undefined },
            },
          },
          settingsActions: subActions,
          onBack: () => {},
          onOpenBotChat: () => {},
          onOpenProviders: () => {},
        }),
      );

      // model 子页：同名模型跨提供商匹配（draft.provider 为空 vs 非空区分） + 搜索过滤 + 无结果
      curSubpage = 'model';
      curSnapshot = {
        ...curSnapshot,
        botManagement: {
          ...curSnapshot.botManagement,
          activeDraft: {
            ...curSnapshot.botManagement.activeDraft,
            model: 'openai/gpt-4o',
            provider: '',
          },
        },
      };
      subView.rerender();
      const emptyProvActive = findAll(subView.tree, (n) => n.props?.className === 'm-menu-row m-bot-model-opt' && n.props?.['data-active'] === 'true');
      assert.equal(emptyProvActive.length, 2, 'Empty draft.provider highlights matching model ID across providers');

      curSnapshot = {
        ...curSnapshot,
        botManagement: {
          ...curSnapshot.botManagement,
          activeDraft: {
            ...curSnapshot.botManagement.activeDraft,
            model: 'openai/gpt-4o',
            provider: 'custom-relay',
          },
        },
      };
      subView.rerender();
      const scopedProvActive = findAll(subView.tree, (n) => n.props?.className === 'm-menu-row m-bot-model-opt' && n.props?.['data-active'] === 'true');
      assert.equal(scopedProvActive.length, 1, 'Explicit draft.provider highlights only the matching provider row');

      findAll(subView.tree, (n) => n.props?.className === 'm-menu-row m-bot-model-opt')[1]?.props.onClick();
      findAll(subView.tree, (n) => n.props?.['data-testid'] === 'mobile-bot-manage-providers')[0]?.props.onClick();
      assert.ok(log.some(([k, id, patch]) => k === 'settings.onBotDraftChange' && id === 'default' && patch.model === 'openai/gpt-4o' && patch.provider === 'openai'));
      assert.ok(log.some(([k, v]) => k === 'onOpenSettingsSubpage' && v === 'providers'));

      findAll(subView.tree, (n) => n.type === 'input' && n.props?.type === 'search')[0]?.props.onChange({
        target: { value: 'gpt-4o' },
      });
      subView.rerender();
      findAll(subView.tree, (n) => n.type === 'input' && n.props?.type === 'search')[0]?.props.onChange({
        target: { value: 'no-such-model-xyz' },
      });
      subView.rerender();

      // soul 子页：超长预警 + 快捷芯片
      curSubpage = 'soul';
      curSnapshot = {
        ...curSnapshot,
        botManagement: {
          ...curSnapshot.botManagement,
          activeDraft: {
            ...curSnapshot.botManagement.activeDraft,
            soul: 'x'.repeat(70000),
          },
        },
      };
      subView.rerender();
      findAll(subView.tree, (n) => n.props?.className === 'm-settings-chip-btn').forEach((b) => b.props.onClick());
      findAll(subView.tree, (n) => n.props?.['aria-label'] === 'SOUL.md 提示词')[0]?.props.onChange({
        target: { value: 'updated soul' },
      });
      assert.ok(log.some(([k, id, patch]) => k === 'settings.onBotDraftChange' && id === 'default' && patch.soul === 'updated soul'));

      // skills 子页：启用切换（true & false）、过滤栏、安装/详情弹窗开关
      curSubpage = 'skills';
      subView.rerender();
      subView.rerender();
      clickSwitch(subView.tree, '启用 git-ops');
      assert.ok(log.some(([k, id, patch]) => k === 'settings.onBotDraftChange' && id === 'default' && Array.isArray(patch.disabledSkills) && patch.disabledSkills.length === 0));
      curSnapshot = {
        ...curSnapshot,
        botManagement: {
          ...curSnapshot.botManagement,
          activeDraft: { ...curSnapshot.botManagement.activeDraft, disabledSkills: [] },
        },
      };
      subView.rerender();
      clickSwitch(subView.tree, '启用 git-ops');
      assert.ok(log.some(([k, id, patch]) => k === 'settings.onBotDraftChange' && id === 'default' && patch.disabledSkills?.includes('sk1')));
      findAll(subView.tree, (n) => n.props?.className === 'm-bot-cap-row__main')[0]?.props.onClick();
      subView.rerender();
      assert.ok(findAll(subView.tree, (n) => n.props?.['data-skill-detail-dialog'] === 'true')[0]);
      findAll(subView.tree, (n) => n.props?.className === 'm-bot-action-pill')[0]?.props.onClick();
      subView.rerender();
      findAll(subView.tree, (n) => n.type === 'input' && n.props?.type === 'search')[0]?.props.onChange({
        target: { value: 'zzz-unmatched' },
      });
      findAll(subView.tree, (n) => n.props?.className === 'm-settings-chip-btn').forEach((b) => b.props.onClick());
      subView.rerender();

      // toolsets 子页：先二次 rerender 令 useEffect 清空 capQuery 后再切换 Switch
      curSubpage = 'toolsets';
      subView.rerender();
      subView.rerender();
      clickSwitch(subView.tree, '开关工具集 Terminal');
      assert.ok(log.some(([k, id, patch]) => k === 'settings.onBotDraftChange' && id === 'default' && Array.isArray(patch.enabledToolsets)));

      // mcp 子页：先权威态切换 Switch，再探测 4 态 + 添加弹窗 + 删除确认取消与确认（校验清除 mcpOverrides）
      curSubpage = 'mcp';
      curSnapshot = {
        ...curSnapshot,
        botManagement: {
          ...curSnapshot.botManagement,
          activeDetail: {
            ...curSnapshot.botManagement.activeDetail,
            mcpServers: {
              authoritative: true,
              rows: [
                { id: 'mcp1', label: 'fs', enabled: true, online: true, transport: 'stdio' },
                { id: 'mcp2', label: 'bad', enabled: false, online: false },
                { id: 'mcp3', label: 'unk', enabled: false },
              ],
            },
          },
        },
      };
      subView.rerender();
      subView.rerender();
      clickSwitch(subView.tree, '开关 MCP 服务器 fs');
      curSnapshot = {
        ...curSnapshot,
        botManagement: {
          ...curSnapshot.botManagement,
          activeDetail: {
            ...curSnapshot.botManagement.activeDetail,
            mcpServers: {
              ...curSnapshot.botManagement.activeDetail.mcpServers,
              authoritative: false,
            },
          },
        },
      };
      subView.rerender();
      const notifyCountBeforeMcp = log.filter(([k]) => k === 'settings.onNotify').length;
      const testBtn = findAll(subView.tree, (n) => n.props?.['aria-label'] === '测试连通')[0];
      await testBtn?.props.onClick();
      await testBtn?.props.onClick();
      await testBtn?.props.onClick();
      await testBtn?.props.onClick();
      subView.rerender();
      const mcpNotifies = log.filter(([k]) => k === 'settings.onNotify').slice(notifyCountBeforeMcp).map(([, msg]) => msg);
      assert.equal(mcpNotifies.length, 8, '4 MCP test probes emit 4 starting + 4 result notifications');
      assert.ok(
        mcpNotifies.some((m) => m.includes('timeout')) &&
          mcpNotifies.some((m) => m.includes('network')) &&
          mcpNotifies.some((m) => m === t('bot.mcpTestOk', { name: 'mcp1', count: 1 })) &&
          mcpNotifies.some((m) => m === t('bot.mcpTestOauthNeeded', { name: 'mcp1' })),
      );

      findAll(subView.tree, (n) => n.props?.className === 'm-bot-action-pill')[0]?.props.onClick();
      const rmTrigger = findAll(subView.tree, (n) => n.props?.['aria-label'] === t('bot.mcpRemoveBtn'))[0];
      assert.ok(rmTrigger, 'MCP remove trigger must exist in MobileBotSubpage');
      rmTrigger.props.onClick();
      subView.rerender();
      let rmDlg = findAll(subView.tree, (n) => n.props?.['data-mcp-remove-dialog'] === 'true')[0];
      assert.ok(rmDlg, 'McpRemoveConfirmDialog must open in MobileBotSubpage');
      findAll(rmDlg, (n) => n.type === 'button')[0]?.props.onClick();
      subView.rerender();
      rmTrigger.props.onClick();
      subView.rerender();
      rmDlg = findAll(subView.tree, (n) => n.props?.['data-mcp-remove-dialog'] === 'true')[0];
      await findAll(rmDlg, (n) => n.type === 'button')[1]?.props.onClick();
      subView.rerender();
      assert.ok(log.some(([k, v]) => k === 'settings.onNotify' && v === t('bot.mcpRemoved', { name: 'mcp1' })));
      assert.equal(findAll(subView.tree, (n) => n.props?.['data-mcp-remove-dialog'] === 'true').length, 0);

      // memory 子页
      curSubpage = 'memory';
      subView.rerender();
      findAll(subView.tree, (n) => n.props?.className === 'm-primary-btn')[0]?.props.onClick();
      findAll(subView.tree, (n) => n.props?.['data-testid'] === 'mobile-bot-subpage-back')[0]?.props.onClick();
      assert.ok(log.some(([k, v]) => k === 'onSelectBot' && v === 'default'));
      assert.ok(log.filter(([k, v]) => k === 'onSelectBotSubpage' && v === null).length >= 2);

      // offline / list_error / detail_error（Failure Is Not Empty）与 loading 态
      log.length = 0;
      curSubpage = 'identity';
      curSnapshot = {
        ...curSnapshot,
        gateway: { ...curSnapshot.gateway, status: 'disconnected' },
        botManagement: {
          ...curSnapshot.botManagement,
          activeBotId: '',
          roster: [{ id: 'fallback-bot', displayName: 'Fallback', model: '', avatar: '', isDefault: false, hasDraft: false }],
          activeDetail: undefined,
          activeDraft: undefined,
          status: { status: 'uninitialized' },
        },
      };
      subView.rerender();
      assert.ok(findAll(subView.tree, (n) => n.props?.['data-testid'] === 'mobile-bot-subpage-offline')[0]);
      findAll(subView.tree, (n) => n.props?.className === 'm-secondary-btn')[0]?.props.onClick();
      assert.ok(log.some(([k, v]) => k === 'onOpenSettingsSubpage' && v === 'gateway'));
      assert.equal(
        renderToStaticMarkup(
          React.createElement(MobileBotSubpagePanel, {
            subpage: 'identity',
            settingsSnapshot: curSnapshot,
            settingsActions: subActions,
            onBack: () => {},
            onOpenBotChat: () => {},
            onOpenProviders: () => {},
          }),
        ).includes('m-secondary-btn'),
        false,
        'Offline view without onOpenGateway must omit gateway action button',
      );

      curSnapshot = {
        ...curSnapshot,
        gateway: { ...curSnapshot.gateway, status: 'connected' },
        botManagement: {
          ...curSnapshot.botManagement,
          status: { status: 'list_error', message: 'roster fail' },
        },
      };
      subView.rerender();
      findAll(subView.tree, (n) => n.props?.children === t('bot.retry'))[0]?.props.onClick();
      assert.ok(log.some(([k]) => k === 'settings.onRetryBotList'));

      curSnapshot = {
        ...curSnapshot,
        botManagement: {
          ...curSnapshot.botManagement,
          status: { status: 'detail_error', message: 'broken detail' },
        },
      };
      subView.rerender();
      findAll(subView.tree, (n) => n.props?.children === t('bot.retry'))[0]?.props.onClick();
      assert.ok(log.some(([k, v]) => k === 'settings.onSelectBotSettle' && v === 'fallback-bot'));

      // detail_error 且无 activeId 与无 roster 项时隐藏重试按钮
      assert.equal(
        renderToStaticMarkup(
          React.createElement(MobileBotSubpagePanel, {
            subpage: 'identity',
            settingsSnapshot: {
              ...curSnapshot,
              botManagement: {
                ...curSnapshot.botManagement,
                activeBotId: '',
                roster: [],
                activeDetail: undefined,
                status: { status: 'detail_error', message: 'broken detail' },
              },
            },
            settingsActions: subActions,
            onBack: () => {},
            onOpenBotChat: () => {},
            onOpenProviders: () => {},
          }),
        ).includes('m-secondary-btn'),
        false,
      );

      curSubpage = null;
      subView.rerender();

      curSubpage = 'identity';
      curSnapshot = {
        ...curSnapshot,
        gateway: { ...curSnapshot.gateway, status: 'connected' },
        botManagement: {
          ...curSnapshot.botManagement,
          activeBotId: '',
          activeDetail: undefined,
          activeDraft: undefined,
          status: { status: 'loading' },
        },
      };
      subView.rerender();

      // saving=true + activeDraft=undefined + offline model + empty catalog + non-auth empty capabilities + no callbacks
      const bareActions = {
        ...subActions,
        onTestMcpServer: undefined,
        onRemoveMcpServer: undefined,
        onAddMcpServer: undefined,
        onInstallSkill: undefined,
        onInspectSkill: undefined,
      };
      const emptyCapsHtml = renderToStaticMarkup(
        React.createElement(MobileBotSubpagePanel, {
          subpage: 'model',
          settingsSnapshot: {
            ...snapshot.settingsSnapshot,
            botManagement: {
              ...snapshot.settingsSnapshot.botManagement,
              isBusy: true,
              availableModels: [],
              activeDraft: undefined,
              activeDetail: {
                ...snapshot.settingsSnapshot.botManagement.activeDetail,
                avatar: undefined,
                model: 'offline/missing-model',
                skills: { authoritative: false, rows: [{ id: 's-nodesc', label: 'NoDesc', enabled: true }] },
                toolsets: { authoritative: true, rows: [] },
                mcpServers: { authoritative: false, rows: [] },
              },
            },
          },
          settingsActions: bareActions,
          onBack: () => {},
          onOpenBotChat: () => {},
          onOpenProviders: () => {},
        }),
      );
      assert.ok(emptyCapsHtml.includes('m-bot-banner--warn'));

      for (const sp of ['skills', 'toolsets', 'mcp']) {
        renderToStaticMarkup(
          React.createElement(MobileBotSubpagePanel, {
            subpage: sp,
            settingsSnapshot: {
              ...snapshot.settingsSnapshot,
              botManagement: {
                ...snapshot.settingsSnapshot.botManagement,
                activeDraft: undefined,
                activeDetail: {
                  ...snapshot.settingsSnapshot.botManagement.activeDetail,
                  skills: { authoritative: false, rows: [{ id: 's-nodesc', label: 'NoDesc', enabled: true }] },
                  toolsets: { authoritative: true, rows: [] },
                  mcpServers: { authoritative: false, rows: [] },
                },
              },
            },
            settingsActions: bareActions,
            onBack: () => {},
            onOpenBotChat: () => {},
            onOpenProviders: () => {},
          }),
        );
      }

      // model option with empty providerName AND empty presentModel name -> opt.name fallback
      renderToStaticMarkup(
        React.createElement(MobileBotSubpagePanel, {
          subpage: 'model',
          settingsSnapshot: {
            ...snapshot.settingsSnapshot,
            botManagement: {
              ...snapshot.settingsSnapshot.botManagement,
              availableModels: [
                { id: 'plain', name: 'Plain', provider: 'custom-p', providerName: '' },
                { id: '', name: 'Unnamed Opt', provider: 'custom-p', providerName: '' },
              ],
            },
          },
          settingsActions: bareActions,
          onBack: () => {},
          onOpenBotChat: () => {},
          onOpenProviders: () => {},
        }),
      );

      // !activeId && !saving 保护（patchDraft & handleCopyId）
      log.length = 0;
      curSubpage = 'identity';
      curSnapshot = {
        ...curSnapshot,
        botManagement: {
          ...curSnapshot.botManagement,
          activeBotId: '',
          isBusy: false,
          status: { status: 'editing', activeBotId: '' },
          activeDetail: snapshot.settingsSnapshot.botManagement.activeDetail,
          activeDraft: {
            ...snapshot.settingsSnapshot.botManagement.activeDetail,
            disabledSkills: [],
            enabledToolsets: ['t1'],
            enabledMcpServers: ['mcp1'],
            avatar: { kind: 'unchanged' },
          },
        },
      };
      subView.rerender();
      findAll(subView.tree, (n) => n.props?.['aria-label'] === '复制 ID')[0]?.props.onClick();
      findAll(subView.tree, (n) => n.type === 'input' && n.props?.type === 'text')[0]?.props.onChange({
        target: { value: 'blocked' },
      });

      // saving=true 下禁用 save-bar 按钮，且 insertSoulText 被拦截；activeId 有效且 !saving 时正常派发重置/保存
      curSubpage = 'soul';
      curSnapshot = {
        ...curSnapshot,
        botManagement: {
          ...curSnapshot.botManagement,
          activeBotId: '',
          isBusy: true,
          activeDetail: snapshot.settingsSnapshot.botManagement.activeDetail,
          activeDraft: {
            ...snapshot.settingsSnapshot.botManagement.activeDetail,
            disabledSkills: [],
            enabledToolsets: ['t1'],
            enabledMcpServers: ['mcp1'],
            avatar: { kind: 'unchanged' },
          },
        },
      };
      subView.rerender();
      findAll(subView.tree, (n) => n.props?.className === 'm-settings-chip-btn').forEach((b) => b.props.onClick());
      const disabledReset = findAll(subView.tree, (n) => n.props?.className === 'm-bot-save-bar__reset')[0];
      const disabledSubmit = findAll(subView.tree, (n) => n.props?.className === 'm-bot-save-bar__submit')[0];
      assert.equal(disabledReset?.props.disabled, true);
      assert.equal(disabledSubmit?.props.disabled, true);
      assert.equal(log.length, 0, 'Guarded !activeId and saving=true states must emit zero mutating actions');

      curSnapshot = {
        ...curSnapshot,
        botManagement: {
          ...curSnapshot.botManagement,
          activeBotId: 'default',
          isBusy: false,
          activeDraft: {
            ...curSnapshot.botManagement.activeDetail,
            displayName: '可保存草稿',
            disabledSkills: [],
            enabledToolsets: ['t1'],
            enabledMcpServers: ['mcp1'],
            avatar: { kind: 'unchanged' },
          },
        },
      };
      subView.rerender();
      findAll(subView.tree, (n) => n.props?.className === 'm-bot-save-bar__reset')[0]?.props.onClick();
      findAll(subView.tree, (n) => n.props?.className === 'm-bot-save-bar__submit')[0]?.props.onClick();
      assert.ok(log.some(([k, id]) => k === 'settings.onResetBotDraft' && id === 'default'));
      assert.ok(log.some(([k, id]) => k === 'settings.onSaveBotConfig' && id === 'default'));
      subView.unmount();
    } finally {
      globalThis.setTimeout = origSetTimeout;
    }

    // MobileBotWizardSheet 全交互 + busy 关闭拦截 + open: false
    log.length = 0;
    assert.equal(
      renderToStaticMarkup(
        React.createElement(MobileBotWizardSheet, {
          settingsSnapshot: snapshot.settingsSnapshot,
          settingsActions: actions.settingsActions,
        }),
      ),
      '',
    );
    let wizBusy = false;
    let wizCloneFrom = '';
    let wizRoster = [{ id: 'default', displayName: '', model: '', avatar: '', isDefault: true, hasDraft: false }];
    const dWiz = createReactHookDriver();
    const wizView = dWiz.mount(() =>
      React.createElement(MobileBotWizardSheet, {
        settingsSnapshot: {
          ...snapshot.settingsSnapshot,
          botManagement: {
            ...snapshot.settingsSnapshot.botManagement,
            roster: wizRoster,
            wizard: {
              open: true,
              busy: wizBusy,
              error: 'name conflict',
              draft: {
                mode: 'clone',
                name: 'qa-bot',
                displayName: 'QA',
                description: 'Tester',
                model: '',
                provider: '',
                cloneFrom: wizCloneFrom,
                cloneChannels: true,
                mirrorCredentials: false,
              },
            },
          },
        },
        settingsActions: actions.settingsActions,
      }),
    );
    findAll(wizView.tree, (n) => n.props?.className === 'm-sheet-backdrop')[0]?.props.onClick();
    findAll(wizView.tree, (n) => n.props?.['aria-label'] === t('mobile.common.close'))[0]?.props.onClick();
    assert.equal(log.filter(([k]) => k === 'settings.onCloseBotWizard').length, 2);

    findAll(wizView.tree, (n) => n.props?.className === 'm-bottom-sheet m-no-swipe')[0]?.props.onClick({
      stopPropagation() {},
    });
    findAll(wizView.tree, (n) => n.props?.className === 'm-settings-seg-btn').forEach((b) => b.props.onClick());
    wizCloneFrom = 'default';
    wizView.rerender();
    findAll(wizView.tree, (n) => n.props?.className === 'm-settings-seg-btn')[1]?.props.onClick();
    wizCloneFrom = '';
    wizRoster = [];
    wizView.rerender();
    findAll(wizView.tree, (n) => n.props?.className === 'm-settings-seg-btn')[1]?.props.onClick();
    wizRoster = [{ id: 'default', displayName: '', model: '', avatar: '', isDefault: true, hasDraft: false }];
    wizView.rerender();
    findAll(wizView.tree, (n) => n.type === 'input' && n.props?.type === 'text').forEach((inp) =>
      inp.props.onChange({ target: { value: 'v' } }),
    );
    findAll(wizView.tree, (n) => n.type === 'select')[0]?.props.onChange({ target: { value: 'default' } });
    findAll(wizView.tree, (n) => n.type === 'button' && n.props?.role === 'switch').forEach((sw) =>
      sw.props.onClick({ isPropagationStopped: () => false, stopPropagation() {} }),
    );
    findAll(wizView.tree, (n) => n.props?.className === 'm-primary-btn')[0]?.props.onClick();
    assert.ok(log.some(([k]) => k === 'settings.onSubmitCreateBot'));

    wizBusy = true;
    wizView.rerender();
    const closeBeforeBusy = log.filter(([k]) => k === 'settings.onCloseBotWizard').length;
    findAll(wizView.tree, (n) => n.props?.className === 'm-sheet-backdrop')[0]?.props.onClick();
    const closeIconBusy = findAll(wizView.tree, (n) => n.props?.['aria-label'] === t('mobile.common.close'))[0];
    assert.equal(closeIconBusy?.props.disabled, true);
    closeIconBusy?.props.onClick();
    assert.equal(log.filter(([k]) => k === 'settings.onCloseBotWizard').length, closeBeforeBusy, 'wizard.busy=true must block backdrop and close icon');
    wizView.unmount();

    // 4. MobileSettingsPage 挂载级全交互与子页分支覆盖（带完整可证伪断言）
    log.length = 0;
    let sPage = null;
    let sSnapshot = {
      ...snapshot.settingsSnapshot,
      locale: 'en',
      gateway: { ...snapshot.settingsSnapshot.gateway, status: 'connecting', profileName: '' },
      providerViews: { status: 'ready', data: [{ id: 'openai', name: 'OpenAI' }] },
      appVersion: '',
    };
    const sActions = {
      ...actions.settingsActions,
      onFontPrefsChange: (next) => log.push(['settings.onFontPrefsChange', next]),
      onActivityVariantChange: (next) => log.push(['settings.onActivityVariantChange', next]),
      onTestMcpServer: async () => ({ ok: true, tools: ['a'], oauthNeeded: false }),
      onRemoveMcpServer: async () => ({ ok: true }),
      onInspectSkill: async () => ({ ok: true, data: { name: 'git', content: '# git' } }),
      onInstallSkill: async () => ({ ok: true }),
      onSearchSkillsHub: async () => ({ ok: true, items: [] }),
      onFetchMcpCatalog: async () => ({ ok: true, items: [] }),
      onAddMcpServer: async () => ({ ok: true }),
    };
    const dSet = createReactHookDriver();
    const setView = dSet.mount(() =>
      React.createElement(MobileSettingsPage, {
        open: true,
        subpage: sPage,
        appearancePref: 'light',
        snapshot: sSnapshot,
        onClose: actions.onCloseSettings,
        onSelectSubpage: actions.onOpenSettingsSubpage,
        onSetAppearancePreference: actions.onSetAppearancePreference,
        settingsActions: sActions,
      }),
    );
    findAll(setView.tree, (n) => n.props?.['data-testid'] === 'mobile-settings-back')[0]?.props.onClick();
    assert.ok(log.some(([k]) => k === 'onCloseSettings'));
    for (const rid of ['appearance', 'gateway', 'providers', 'extensions', 'about']) {
      findAll(setView.tree, (n) => n.props?.['data-testid'] === `mobile-settings-row-${rid}`)[0]?.props.onClick();
    }
    assert.deepEqual(
      log.filter(([k]) => k === 'onOpenSettingsSubpage').map(([, v]) => v),
      ['appearance', 'gateway', 'providers', 'extensions', 'about'],
    );

    sSnapshot = {
      ...snapshot.settingsSnapshot,
      locale: 'en',
      gateway: { ...snapshot.settingsSnapshot.gateway, status: 'disconnected', hasStoredPassword: false, test: undefined },
      providerViews: { status: 'idle' },
      appVersion: '',
    };
    sPage = 'appearance';
    setView.rerender();
    sSnapshot = { ...sSnapshot, locale: 'zh' };
    setView.rerender();
    findAll(setView.tree, (n) => n.props?.className === 'm-settings-seg-btn').forEach((b) => b.props.onClick());
    findAll(setView.tree, (n) => n.props?.className === 'm-settings-chip-btn').forEach((b) => b.props.onClick());
    findAll(setView.tree, (n) => n.props?.['data-testid'] === 'mobile-settings-back')[0]?.props.onClick();
    assert.ok(log.some(([k, v]) => k === 'onSetAppearancePreference' && v === 'dark'));
    assert.ok(log.some(([k]) => k === 'settings.onFontPrefsChange'));
    assert.ok(log.some(([k, v]) => k === 'settings.onLocaleChange' && v === 'en'));
    assert.ok(log.some(([k]) => k === 'settings.onActivityVariantChange'));
    assert.ok(log.some(([k, v]) => k === 'onOpenSettingsSubpage' && v === null));

    sPage = 'gateway';
    setView.rerender();
    findAll(setView.tree, (n) => n.type === 'input').forEach((inp, idx) =>
      inp.props.onChange({ target: { value: idx === 3 ? '   ' : 'val' } }),
    );
    setView.rerender();
    findAll(setView.tree, (n) => n.props?.className === 'm-secondary-btn')[0]?.props.onClick();
    findAll(setView.tree, (n) => n.props?.className === 'm-primary-btn')[0]?.props.onClick();
    assert.ok(log.some(([k, d]) => k === 'settings.onTestGateway' && d.profileName === 'default'));
    assert.ok(log.some(([k, d]) => k === 'settings.onConnectGateway' && d.profileName === 'default'));

    sPage = 'providers';
    setView.rerender();

    sPage = 'extensions';
    setView.rerender();
    findAll(setView.tree, (n) => n.props?.className === 'm-bot-action-pill').forEach((b) => b.props.onClick());
    assert.ok(log.some(([k]) => k === 'settings.onRefreshExtensions'));
    assert.ok(log.some(([k]) => k === 'settings.onReloadSkills'));
    setView.rerender();
    const extTestP = findAll(setView.tree, (n) => n.props?.['aria-label'] === '测试连通')[0]?.props.onClick();
    setView.rerender();
    await extTestP;
    const extRmTrigger = findAll(setView.tree, (n) => n.props?.['aria-label'] === t('bot.mcpRemoveBtn'))[0];
    assert.ok(extRmTrigger, 'MCP remove trigger must exist in MobileSettingsPage');
    extRmTrigger.props.onClick();
    setView.rerender();
    let extRmDlg = findAll(setView.tree, (n) => n.props?.['data-mcp-remove-dialog'] === 'true')[0];
    assert.ok(extRmDlg, 'McpRemoveConfirmDialog must open in MobileSettingsPage');
    findAll(extRmDlg, (n) => n.type === 'button')[0]?.props.onClick();
    setView.rerender();
    extRmTrigger.props.onClick();
    setView.rerender();
    extRmDlg = findAll(setView.tree, (n) => n.props?.['data-mcp-remove-dialog'] === 'true')[0];
    await findAll(extRmDlg, (n) => n.type === 'button')[1]?.props.onClick();
    assert.ok(log.some(([k, v]) => k === 'settings.onNotify' && v === t('bot.mcpRemoved', { name: 'fs' })));
    sSnapshot = { ...sSnapshot, busy: true };
    setView.rerender();
    sSnapshot = { ...sSnapshot, busy: false };
    setView.rerender();
    findAll(setView.tree, (n) => n.props?.className === 'm-menu-row')[0]?.props.onClick();
    setView.rerender();
    findAll(setView.tree, (n) => n.props?.children === '关闭' && n.type === 'button').forEach((b) => b.props.onClick?.());
    findAll(setView.tree, (n) => typeof n.props?.onOpenChange === 'function').forEach((dlg) => dlg.props.onOpenChange(false));

    sPage = 'about';
    setView.rerender();
    sSnapshot = snapshot.settingsSnapshot;
    sPage = 'about';
    setView.rerender();
    setView.unmount();

    // extensions 空列表与无操作回调分支
    const emptyExtHtml = renderToStaticMarkup(
      React.createElement(MobileSettingsPage, {
        open: true,
        subpage: 'extensions',
        appearancePref: 'dark',
        snapshot: {
          ...snapshot.settingsSnapshot,
          mcp: { status: 'ready', data: [] },
          skills: { status: 'ready', data: [] },
        },
        onClose: () => {},
        onSelectSubpage: () => {},
        onSetAppearancePreference: () => {},
        settingsActions: actions.settingsActions,
      }),
    );
    assert.ok(emptyExtHtml.includes('m-bot-subpage__empty'));

    // 5. MobileWorkspaceShell 新返回栈优先级 + 覆盖从 Bot 子页跳设置页的层级关系
    let shellSnap = {
      ...snapshot,
      homeTab: 'bots',
      botSubpage: 'soul',
      settingsOpen: false,
      newChatOpen: false,
      searchOpen: false,
      actionSheet: null,
      subagentSheet: null,
      activePane: 'home',
      settingsSnapshot: {
        ...snapshot.settingsSnapshot,
        botManagement: {
          ...snapshot.settingsSnapshot.botManagement,
          wizard: { ...snapshot.settingsSnapshot.botManagement.wizard, open: true },
        },
      },
    };
    const dShell = createReactHookDriver();
    const shellView = dShell.mount(() => React.createElement(MobileWorkspaceShell, { snapshot: shellSnap, actions }));
    const subPanelInShell = findAll(shellView.tree, (n) => typeof n.props?.onOpenGateway === 'function')[0];
    subPanelInShell?.props.onOpenGateway();
    assert.ok(log.some(([k, v]) => k === 'onOpenSettingsSubpage' && v === 'gateway'));

    const fireBack = () => window.dispatchEvent(new CustomEvent('hermes-mobile-back', { cancelable: true }));
    assert.equal(fireBack(), false, 'botWizardOpen 时返回键必须消费并关闭向导');
    assert.ok(log.some(([k]) => k === 'settings.onCloseBotWizard'));

    shellSnap = {
      ...shellSnap,
      settingsSnapshot: {
        ...shellSnap.settingsSnapshot,
        botManagement: {
          ...shellSnap.settingsSnapshot.botManagement,
          wizard: { ...shellSnap.settingsSnapshot.botManagement.wizard, open: false },
        },
      },
    };
    shellView.rerender();
    assert.equal(fireBack(), false, 'botSubpage 时返回键必须退回 Bot Hub');
    assert.ok(log.some(([k, v]) => k === 'onSelectBotSubpage' && v === null));

    shellSnap = { ...shellSnap, botSubpage: null };
    shellView.rerender();
    assert.equal(fireBack(), false, 'Bot Hub 根态按返回键应切回对话标签页');
    assert.ok(log.some(([k, v]) => k === 'onSelectHomeTab' && v === 'chats'));

    shellSnap = { ...shellSnap, homeTab: 'chats' };
    shellView.rerender();
    assert.equal(fireBack(), true, 'Chats 根态不得拦截返回键');
    shellView.unmount();

    // 6. 检查舱阅读器必须声明 m-no-swipe，且 mobile-shell.css 满足 save-bar/token/z-index 层级审查回归守卫
    const inspectorReaderHtml = renderToStaticMarkup(
      React.createElement(MobileInspectorScreen, {
        activeFocus: snapshot.activeFocus,
        activeTab: 'files',
        artifacts: snapshot.artifacts,
        gitDiffs: snapshot.gitDiffs,
        openFiles: snapshot.openFiles,
        fileTreeState: { status: 'idle' },
        fileTreeExpandedPaths: [],
        fileTreeFilterQuery: '',
        activeFilePath: '',
        memories: snapshot.memories,
        learningState: { status: 'idle' },
        learningDetail: { status: 'idle' },
        groupMembers: snapshot.groupMembers,
        readerOpen: true,
        readerItem: { title: 'src/main.ts', content: 'export const x = 1;' },
        onSelectTab: () => {},
        onOpenItem: () => {},
        onCloseReader: () => {},
        onCopyText: () => {},
        onLoadFileTree: () => {},
        onToggleFileTreeDir: () => {},
        onFilterFileTree: () => {},
        onOpenWorkspaceFile: () => {},
        onDownloadInspectorFile: () => {},
        onRefreshLearning: () => {},
        onLoadLearningDetail: () => {},
      }),
    );
    assert.ok(inspectorReaderHtml.includes('m-inspector__reader m-no-swipe'), 'Inspector reader must block horizontal shell swipe');

    const mobileCss = fs.readFileSync(path.resolve(import.meta.dirname, '../src/styles/mobile-shell.css'), 'utf8');
    assert.equal(/var\(--panel\)/.test(mobileCss), false, 'mobile-shell.css must not use var(--panel) inside white cards');
    assert.equal(/data-variant="light"/.test(mobileCss), false, 'mobile-shell.css must align to data-appearance="light"');
    const saveBarBlock = mobileCss.match(/\.m-bot-save-bar\s*\{[\s\S]*?\}/)?.[0] || '';
    assert.ok(saveBarBlock.includes('position: absolute;'), '.m-bot-save-bar must use position: absolute inside 100vw containers');
    assert.ok(saveBarBlock.includes('z-index: 30;'), '.m-bot-save-bar must keep z-index: 30 below z-50 dialogs');
    const settingsPageBlock = mobileCss.match(/\.m-settings-page,\s*\r?\n\.m-bot-subpage\s*\{[\s\S]*?\}/)?.[0] || '';
    const botSubpageBlock = mobileCss.match(/\}\s*\r?\n\.m-bot-subpage\s*\{([\s\S]*?)\}/)?.[1] || '';
    const backdropBlock = mobileCss.match(/\.m-page-sheet-backdrop,\s*\r?\n\.m-sheet-backdrop\s*\{[\s\S]*?\}/)?.[0] || '';
    const settingsZ = Number(settingsPageBlock.match(/z-index:\s*(\d+)/)?.[1] ?? 0);
    const botSubZ = Number(botSubpageBlock.match(/z-index:\s*(\d+)/)?.[1] ?? 0);
    const backdropZ = Number(backdropBlock.match(/z-index:\s*(\d+)/)?.[1] ?? 0);
    assert.ok(botSubZ > 0 && botSubZ < settingsZ && settingsZ < backdropZ, `Mobile overlay stacking order must obey botSub(${botSubZ}) < settings(${settingsZ}) < backdrop(${backdropZ})`);
    const modelBackdropZ = Number((mobileCss.match(/\.m-sheet-backdrop\[data-sheet-kind="model"\]\s*\{([\s\S]*?)\}/)?.[1] || '').match(/z-index:\s*(\d+)/)?.[1] ?? 0);
    assert.ok(modelBackdropZ > backdropZ, `Model picker sheet z-index (${modelBackdropZ}) must exceed page-sheet backdrop (${backdropZ})`);
    assert.ok(/\.m-shell::-webkit-scrollbar,\s*\r?\n\.m-shell \*::-webkit-scrollbar\s*\{[^}]*display:\s*none/.test(mobileCss), '.m-shell 必须全面剥离占位滚动条以消除展开折叠时的列表横向抖动');
    assert.ok(/\.m-section__body\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/.test(mobileCss), '.m-section__body 必须锁定单列 minmax(0, 1fr)');
  } finally {
    globalThis.window = prevWin;
    globalThis.document = prevDoc;
    globalThis.CustomEvent = prevCustomEvent;
    globalThis.HTMLFormElement = prevHTMLFormElement;
    globalThis.MutationObserver = prevMutationObserver;
  }
});

test('MessageAttachments、Inspector 文件树、认知星图与 Inspector 滑回/切屏全分支覆盖', async () => {
  // 1. MessageAttachments (empty / composer / bubble expand-collapse / pdf / file) + MessageRow + TurnGroup
  assert.equal(
    renderToStaticMarkup(React.createElement(MessageAttachments, { attachments: [], variant: 'bubble' })),
    '',
  );

  const removedIds = [];
  const dAtt = createReactHookDriver();
  const sampleAtts = [
    { id: 'img-1', name: 'snap.png', type: 'image', previewUrl: 'data:image/png;base64,AA', sizeBytes: 2048 },
    { id: 'img-noprev', name: 'empty.png', type: 'image' },
    { id: 'pdf-1', name: 'spec.pdf', type: 'pdf', sizeBytes: 1024 },
    { id: 'file-1', name: 'readme.md', type: 'file' },
  ];
  let variant = 'composer';
  let showRemove = true;
  const attView = dAtt.mount(() =>
    React.createElement(MessageAttachments, {
      attachments: sampleAtts,
      variant,
      onRemove: showRemove ? (id) => removedIds.push(id) : undefined,
    }),
  );
  // composer 下点两次移除（图片右上角 + 文件行内）
  findAll(attView.tree, (n) => n.type === 'button').forEach((btn) => btn.props.onClick());
  assert.deepEqual(removedIds, ['img-1', 'img-noprev', 'pdf-1', 'file-1']);

  variant = 'bubble';
  showRemove = false;
  attView.rerender();
  const imgBtn = findAll(attView.tree, (n) => n.props?.className === 'conv-att-image-btn')[0];
  imgBtn.props.onClick();
  attView.rerender();
  assert.equal(findAll(attView.tree, (n) => n.props?.className === 'conv-att-image-card')[0]?.props['data-expanded'], 'true');
  imgBtn.props.onClick();
  attView.rerender();
  assert.equal(findAll(attView.tree, (n) => n.props?.className === 'conv-att-image-card')[0]?.props['data-expanded'], 'false');
  attView.unmount();

  const rowHtml = renderToStaticMarkup(
    React.createElement(MessageRow, {
      message: { id: 'u-att', role: 'user', content: '', attachments: sampleAtts, displayKind: 'user' },
      isFirstInTurn: true,
      isLastInTurn: true,
      mode: 'scratchpad',
      isStreaming: false,
    }),
  );
  assert.ok(rowHtml.includes('message-attachments-bubble'));
  assert.ok(rowHtml.includes('snap.png'));

  const baseTurnMsg = { id: 'u1', role: 'user', content: 'hi', attachments: sampleAtts };
  assert.equal(
    TurnGroup.compare(
      { messages: [baseTurnMsg], mode: 'scratchpad', isLastTurn: true, isStreaming: false },
      { messages: [{ ...baseTurnMsg, attachments: [...sampleAtts] }], mode: 'scratchpad', isLastTurn: true, isStreaming: false },
    ),
    false,
    'TurnGroup memo compare 必须在 attachments 引用变化时返回 false',
  );

  // 2. MobileInspectorScreen: onBackToStage + 文件树加载/报错重试/空态/过滤/展开文件打开 + 图像/二进制/大文件/下载复制阅读器
  const inspCalls = [];
  const treeNodes = [
    {
      name: 'src',
      path: 'src',
      isDirectory: true,
      children: [
        { name: 'app.ts', path: 'src/app.ts', isDirectory: false, size: 512 },
        { name: 'logo.png', path: 'src/logo.png', isDirectory: false, size: 1024 },
      ],
    },
    { name: 'emptyDir', path: 'emptyDir', isDirectory: true, children: [] },
  ];
  let inspProps = {
    activeFocus: { type: 'session', sessionId: 's-1' },
    activeTab: 'files',
    readerOpen: false,
    readerItem: null,
    artifacts: [],
    gitDiffs: [],
    openFiles: [{ id: 'f1', path: 'notes.md', content: '# notes', language: 'markdown' }],
    fileTreeState: { status: 'loading' },
    fileTreeExpandedPaths: ['src'],
    fileTreeFilterQuery: '',
    activeFilePath: 'src/app.ts',
    workspaceRootName: 'hermes-flux',
    memories: [],
    learningState: { status: 'idle' },
    learningDetail: { status: 'idle' },
    groupMembers: [],
    onSelectTab: (tab) => inspCalls.push(['tab', tab]),
    onOpenItem: (it) => inspCalls.push(['openItem', it.title]),
    onCloseReader: () => inspCalls.push(['closeReader']),
    onCopyText: (txt) => inspCalls.push(['copy', txt]),
    onBackToStage: () => inspCalls.push(['backToStage']),
    onLoadFileTree: (force) => inspCalls.push(['loadTree', force]),
    onToggleFileTreeDir: (p) => inspCalls.push(['toggleDir', p]),
    onFilterFileTree: (q) => inspCalls.push(['filterTree', q]),
    onOpenWorkspaceFile: (p) => inspCalls.push(['openFile', p]),
    onDownloadInspectorFile: () => inspCalls.push(['download']),
    onRefreshLearning: () => inspCalls.push(['refreshLearning']),
    onLoadLearningDetail: (id) => inspCalls.push(['loadDetail', id]),
  };
  const dInsp = createReactHookDriver();
  const inspView = dInsp.mount(() => React.createElement(MobileInspectorScreen, inspProps));
  assert.ok(findAll(inspView.tree, (n) => n.props?.['data-testid'] === 'mobile-file-tree-loading')[0]);
  findAll(inspView.tree, (n) => n.props?.['data-testid'] === 'mobile-inspector-back-stage')[0]?.props.onClick();
  findAll(inspView.tree, (n) => n.props?.['data-testid'] === 'mobile-inspector-files-refresh')[0]?.props.onClick();
  findAll(inspView.tree, (n) => n.props?.['data-testid'] === 'mobile-inspector-files-filter')[0]?.props.onChange({ target: { value: 'app' } });
  assert.ok(inspCalls.some(([k]) => k === 'backToStage'));
  assert.ok(inspCalls.some(([k, v]) => k === 'loadTree' && v === true));
  assert.ok(inspCalls.some(([k, v]) => k === 'filterTree' && v === 'app'));

  inspProps = { ...inspProps, fileTreeState: { status: 'error', message: 'net err' } };
  inspView.rerender();
  findAll(inspView.tree, (n) => n.props?.['data-testid'] === 'mobile-file-tree-error')[0]
    && findAll(inspView.tree, (n) => n.props?.className === 'm-secondary-btn')[0]?.props.onClick();

  // openFiles fallback when nodes=[]
  inspProps = { ...inspProps, fileTreeState: { status: 'ready', nodes: [] } };
  inspView.rerender();
  findAll(inspView.tree, (n) => n.props?.className === 'm-inspector-card')[0]?.props.onClick();
  assert.ok(inspCalls.some(([k, v]) => k === 'openItem' && v === 'notes.md'));

  // ready with treeNodes & match filter & no-match filter
  inspProps = { ...inspProps, fileTreeState: { status: 'ready', nodes: treeNodes }, fileTreeFilterQuery: '' };
  inspView.rerender();
  findAll(inspView.tree, (n) => n.props?.['data-testid'] === 'mobile-tree-dir-src')[0]?.props.onClick();
  findAll(inspView.tree, (n) => n.props?.['data-testid'] === 'mobile-tree-file-src/app.ts')[0]?.props.onClick();
  assert.ok(inspCalls.some(([k, v]) => k === 'toggleDir' && v === 'src'));
  assert.ok(inspCalls.some(([k, v]) => k === 'openFile' && v === 'src/app.ts'));

  inspProps = { ...inspProps, fileTreeFilterQuery: 'zzz-nomatch' };
  inspView.rerender();
  assert.ok(findAll(inspView.tree, (n) => n.props?.className === 'm-inspector__empty').length > 0);

  // readerOpen: image / isImage+isTooLarge -> 下载回落 / isImage+plainText -> 文本阅读器 / isBinary / tooLarge / normal text + download + copy
  inspProps = {
    ...inspProps,
    readerOpen: true,
    readerItem: { kind: 'files', title: 'logo.png', content: 'data:image/png;base64,AA', isImage: true, canDownload: true },
  };
  inspView.rerender();
  assert.ok(findAll(inspView.tree, (n) => n.props?.className === 'm-inspector__reader-image')[0]);
  findAll(inspView.tree, (n) => n.props?.['data-testid'] === 'mobile-inspector-download')[0]?.props.onClick();

  inspProps = {
    ...inspProps,
    readerItem: { kind: 'files', title: 'huge.png', content: 'data:image/png;base64,AA', isImage: true, isTooLarge: true, canDownload: true },
  };
  inspView.rerender();
  assert.equal(findAll(inspView.tree, (n) => n.props?.className === 'm-inspector__reader-image').length, 0);

  inspProps = {
    ...inspProps,
    readerItem: { kind: 'files', title: 'fake.png', content: 'not-an-image-uri', isImage: true, canDownload: true },
  };
  inspView.rerender();
  assert.equal(findAll(inspView.tree, (n) => n.props?.className === 'm-inspector__reader-image').length, 0);
  assert.ok(findAll(inspView.tree, (n) => n.props?.className === 'm-inspector__reader-code')[0]);

  inspProps = {
    ...inspProps,
    readerItem: { kind: 'files', title: 'app.bin', content: '', isBinary: true, canDownload: true },
  };
  inspView.rerender();
  findAll(inspView.tree, (n) => n.props?.className === 'm-primary-btn')[0]?.props.onClick();

  inspProps = {
    ...inspProps,
    readerItem: { kind: 'files', title: 'big.log', content: 'Too large', isTooLarge: true, canDownload: false },
  };
  inspView.rerender();
  inspProps = {
    ...inspProps,
    readerItem: { kind: 'files', title: 'app.ts', content: 'const x = 1;', canDownload: true },
  };
  inspView.rerender();
  findAll(inspView.tree, (n) => n.props?.['aria-label'] === t('mobile.inspector.copyContent'))[0]?.props.onClick();
  assert.ok(inspCalls.some(([k, v]) => k === 'copy' && v === 'const x = 1;'));
  inspView.unmount();

  // 3. MobileConstellationPanel & MobileBotSubpagePanel(memory) 全状态/筛选/分页/详情编辑保存删除分支
  const constCalls = [];
  const makeNodes = (count) =>
    Array.from({ length: count }, (_, i) => ({
      id: i === 0 ? 'skill:git-ops' : `memory:m${i}`,
      kind: i === 0 ? 'skill' : 'memory',
      label: i === 0 ? 'git-ops' : `记忆条目 ${i}`,
      fullLabel: i === 0 ? 'git-ops full' : `记忆条目完整摘要 ${i}`,
      preview: `Preview text ${i}`,
      category: 'cat',
      date: i % 2 === 0 ? '2026-11-08' : '',
      uses: i,
      meta: '',
      bucketIndex: 0,
    }));
  const fullGraph = {
    nodes: makeNodes(9),
    edges: [
      { source: 'memory:m1', target: 'skill:git-ops', kind: 'mention' },
      { source: 'memory:m1', target: 'memory:m2', kind: 'same-bucket' },
    ],
    summary: ['1 learned skills · 8 memories'],
    totalSkills: 1,
    totalMemories: 8,
    axisStart: 'Nov 1',
    axisEnd: 'Nov 8',
  };
  let editResult = { ok: false, message: '' };
  let deleteResult = { ok: false, message: '' };
  let panelProps = {
    learningState: { status: 'loading' },
    learningDetail: { status: 'idle' },
    onRefresh: () => constCalls.push(['refresh']),
    onSelectNodeDetail: (id, prof) => constCalls.push(['selectDetail', id, prof]),
    onSaveEdit: async (id, c) => {
      constCalls.push(['saveEdit', id, c]);
      return editResult;
    },
    onDeleteNode: async (id) => {
      constCalls.push(['deleteNode', id]);
      return deleteResult;
    },
    onCopyText: (txt) => constCalls.push(['copy', txt]),
    footerHint: 'Bottom hint',
  };
  const dConst = createReactHookDriver();
  const constView = dConst.mount(() => React.createElement(MobileConstellationPanel, panelProps));
  assert.ok(findAll(constView.tree, (n) => n.props?.['data-testid'] === 'mobile-constellation-loading')[0]);

  panelProps = { ...panelProps, targetProfile: 'arch', targetBotLabel: 'Architect', learningState: { status: 'error', profile: 'arch', message: '' } };
  constView.rerender();
  assert.ok(findAll(constView.tree, (n) => n.props?.['data-testid'] === 'mobile-constellation-error')[0]);
  findAll(constView.tree, (n) => n.props?.['data-testid'] === 'mobile-constellation-retry')[0]?.props.onClick();

  // 跨 Bot 串台阻断守卫：targetProfile=arch 但 learningState 仍携带 default 图谱时，严禁渲染旧图谱并触发 onEnsureLoaded('arch')
  const ensureCalls = [];
  panelProps = {
    ...panelProps,
    targetProfile: 'arch',
    learningState: { status: 'ready', profile: 'default', graph: { ...fullGraph, profile: 'default' } },
    onEnsureLoaded: (prof) => ensureCalls.push(prof),
  };
  constView.rerender();
  assert.ok(
    findAll(constView.tree, (n) => n.props?.['data-testid'] === 'mobile-constellation-loading')[0],
    'learningState.profile 与 targetProfile 不一致时必须立即阻断进入加载态',
  );
  assert.ok(ensureCalls.includes('arch'));

  panelProps = {
    ...panelProps,
    targetProfile: 'arch',
    onEnsureLoaded: undefined,
    learningState: { status: 'ready', profile: 'arch', graph: { nodes: [], edges: [], summary: [], totalSkills: 0, totalMemories: 0, axisStart: '', axisEnd: '' } },
  };
  constView.rerender();
  assert.ok(findAll(constView.tree, (n) => n.props?.['data-testid'] === 'mobile-constellation-empty')[0]);

  // Ready with all 9 nodes (NO pagination), zoom controls, skill list & filters, node selection, detail edit & delete
  const enrichedGraph = {
    ...fullGraph,
    profile: 'arch',
    nodes: [
      {
        id: 'skill:git-ops',
        kind: 'skill',
        label: 'git-ops',
        fullLabel: 'git-ops workflow',
        preview: 'Git operations',
        category: 'vcs',
        date: '2026-11-08',
        uses: 14,
        meta: 'vcs · x14',
        bucketIndex: 0,
        skillName: 'git-ops',
      },
      {
        id: 'skill:code-audit',
        kind: 'skill',
        label: 'code-audit',
        fullLabel: 'code-audit workflow',
        preview: 'Audit helper',
        category: 'vcs',
        date: '2026-11-09',
        uses: 9,
        meta: 'vcs · x9',
        bucketIndex: 0,
        skillName: 'code-audit',
      },
      ...fullGraph.nodes.slice(1),
    ],
    edges: [
      { source: 'skill:git-ops', target: 'skill:code-audit', kind: 'skill-link' },
      ...fullGraph.edges,
    ],
    totalSkills: 2,
    totalSkillLinks: 1,
  };
  panelProps = { ...panelProps, learningState: { status: 'ready', profile: 'arch', graph: enrichedGraph } };
  constView.rerender();
  assert.ok(findAll(constView.tree, (n) => n.props?.['data-testid'] === 'mobile-constellation-panel')[0]);
  // 完整地图渲染全部节点，无分页控件
  assert.equal(findAll(constView.tree, (n) => n.props?.['aria-label'] === t('mobile.memory.nextPageAria')).length, 0);
  assert.equal(findAll(constView.tree, (n) => n.props?.['aria-label'] === t('mobile.memory.prevPageAria')).length, 0);
  for (const node of enrichedGraph.nodes) {
    assert.ok(
      findAll(constView.tree, (n) => n.props?.['data-testid'] === `mobile-constellation-node-${node.id}`)[0],
      `完整星图应直接展示全部节点: ${node.id}`,
    );
  }
  assert.ok(findAll(constView.tree, (n) => n.props?.['data-testid'] === 'mobile-constellation-skill-list')[0]);
  assert.ok(findAll(constView.tree, (n) => n.props?.['data-testid'] === 'mobile-constellation-skill-item-skill:git-ops')[0]);

  // 缩放控制：放大 / 缩小 / 居中重置
  const initialZoomText = findAll(constView.tree, (n) => n.props?.['data-testid'] === 'mobile-constellation-zoom-label')[0]?.props.children;
  findAll(constView.tree, (n) => n.props?.['data-testid'] === 'mobile-constellation-zoom-in')[0]?.props.onClick();
  constView.rerender();
  const zoomedInText = findAll(constView.tree, (n) => n.props?.['data-testid'] === 'mobile-constellation-zoom-label')[0]?.props.children;
  assert.notEqual(zoomedInText, initialZoomText);
  findAll(constView.tree, (n) => n.props?.['data-testid'] === 'mobile-constellation-zoom-out')[0]?.props.onClick();
  constView.rerender();
  findAll(constView.tree, (n) => n.props?.['data-testid'] === 'mobile-constellation-zoom-reset')[0]?.props.onClick();
  constView.rerender();

  // 星图选点 + 技能列表定位按钮 + 列表直达大详情弹窗
  findAll(constView.tree, (n) => n.props?.['data-testid'] === 'mobile-constellation-node-memory:m1')[0]?.props.onClick();
  constView.rerender();
  findAll(constView.tree, (n) => n.props?.['data-testid'] === 'mobile-constellation-skill-focus-skill:code-audit')[0]?.props.onClick();
  constView.rerender();
  findAll(constView.tree, (n) => n.props?.['data-testid'] === 'mobile-constellation-node-memory:m1')[0]?.props.onClick();
  constView.rerender();

  // 打开详情 -> loading -> error + retry -> ready -> edit(fail & ok) -> delete(cancel & fail & ok)
  findAll(constView.tree, (n) => n.props?.['data-testid'] === 'mobile-constellation-open-detail')[0]?.props.onClick();
  constView.rerender();
  assert.ok(findAll(constView.tree, (n) => n.props?.['data-testid'] === 'mobile-constellation-detail')[0]);

  const activeStarId = constCalls.find(([k]) => k === 'selectDetail')[1];
  assert.equal(constCalls.find(([k]) => k === 'selectDetail')[2], 'arch');
  panelProps = { ...panelProps, learningDetail: { status: 'loading', id: activeStarId, profile: 'arch' } };
  constView.rerender();
  assert.equal(findAll(constView.tree, (n) => n.props?.['data-testid'] === 'mobile-constellation-edit').length, 0);
  panelProps = { ...panelProps, learningDetail: { status: 'error', id: activeStarId, profile: 'arch', message: 'detail err' } };
  constView.rerender();
  assert.equal(findAll(constView.tree, (n) => n.props?.['data-testid'] === 'mobile-constellation-edit').length, 0);
  findAll(constView.tree, (n) => n.props?.['data-testid'] === 'mobile-constellation-detail-retry')[0]?.props.onClick();

  panelProps = { ...panelProps, learningDetail: { status: 'ready', id: activeStarId, kind: 'memory', label: 'M1', content: 'Detail text', profile: 'arch' } };
  constView.rerender();
  findAll(constView.tree, (n) => n.props?.['aria-label'] === t('mobile.inspector.copyContent'))[0]?.props.onClick();
  findAll(constView.tree, (n) => n.props?.['data-testid'] === 'mobile-constellation-edit')[0]?.props.onClick();
  constView.rerender();
  findAll(constView.tree, (n) => n.type === 'textarea')[0]?.props.onChange({ target: { value: 'Edited body' } });
  constView.rerender();
  // Save failure + in-flight actionBusy disables back/save + stale node resolution guard
  await findAll(constView.tree, (n) => n.props?.['data-testid'] === 'mobile-constellation-save')[0]?.props.onClick();
  constView.rerender();
  let releasePendingSave = null;
  panelProps = {
    ...panelProps,
    onSaveEdit: () =>
      new Promise((resolve) => {
        releasePendingSave = resolve;
      }),
  };
  constView.rerender();
  const busySaveP = findAll(constView.tree, (n) => n.props?.['data-testid'] === 'mobile-constellation-save')[0]?.props.onClick();
  constView.rerender();
  assert.equal(
    findAll(constView.tree, (n) => n.props?.['data-testid'] === 'mobile-constellation-detail-back')[0]?.props.disabled,
    true,
  );
  await findAll(constView.tree, (n) => n.props?.['data-testid'] === 'mobile-constellation-save')[0]?.props.onClick();
  releasePendingSave({ ok: false, message: 'busy-done' });
  await busySaveP;
  constView.rerender();

  // Stale node guard onSaveEdit: switch node while saving in-flight -> must not close or clobber new node
  let releaseStaleSave = null;
  panelProps = {
    ...panelProps,
    onSaveEdit: () =>
      new Promise((resolve) => {
        releaseStaleSave = resolve;
      }),
  };
  constView.rerender();
  const staleSaveP = findAll(constView.tree, (n) => n.props?.['data-testid'] === 'mobile-constellation-save')[0]?.props.onClick();
  findAll(constView.tree, (n) => n.props?.['data-testid'] === 'mobile-constellation-detail-back')[0]?.props.onClick();
  constView.rerender();
  findAll(constView.tree, (n) => n.props?.['data-testid'] === 'mobile-constellation-node-memory:m2')[0]?.props.onClick();
  constView.rerender();
  findAll(constView.tree, (n) => n.props?.['data-testid'] === 'mobile-constellation-open-detail')[0]?.props.onClick();
  constView.rerender();
  releaseStaleSave({ ok: true });
  await staleSaveP;
  constView.rerender();
  assert.ok(findAll(constView.tree, (n) => n.props?.['data-testid'] === 'mobile-constellation-detail')[0]);
  findAll(constView.tree, (n) => n.props?.['data-testid'] === 'mobile-constellation-node-memory:m1')[0]
    ?.props.onClick?.();
  panelProps = {
    ...panelProps,
    learningDetail: { status: 'ready', id: 'memory:m2', kind: 'memory', label: 'M2', content: 'Body 2', profile: 'arch' },
    onSaveEdit: async (id, c, prof) => {
      constCalls.push(['saveEdit', id, c, prof]);
      return editResult;
    },
  };
  constView.rerender();
  findAll(constView.tree, (n) => n.props?.['data-testid'] === 'mobile-constellation-edit')[0]?.props.onClick();
  constView.rerender();

  // Cancel edit then re-open & save success
  findAll(constView.tree, (n) => n.props?.children === t('mobile.memory.cancelEditBtn'))[0]?.props.onClick();
  constView.rerender();
  findAll(constView.tree, (n) => n.props?.['data-testid'] === 'mobile-constellation-edit')[0]?.props.onClick();
  constView.rerender();
  editResult = { ok: true };
  panelProps = {
    ...panelProps,
    onSaveEdit: async (id, c, prof) => {
      constCalls.push(['saveEdit', id, c, prof]);
      return editResult;
    },
  };
  constView.rerender();
  await findAll(constView.tree, (n) => n.props?.['data-testid'] === 'mobile-constellation-save')[0]?.props.onClick();
  constView.rerender();

  // Real deletion removes target node from learningState BEFORE resolving { ok: true } -> detail MUST close!
  findAll(constView.tree, (n) => n.props?.['data-testid'] === 'mobile-constellation-delete')[0]?.props.onClick();
  constView.rerender();
  let releaseRealDel = null;
  let deletedNodeId = '';
  panelProps = {
    ...panelProps,
    onDeleteNode: (id) =>
      new Promise((resolve) => {
        deletedNodeId = id;
        releaseRealDel = resolve;
      }),
  };
  constView.rerender();
  const realDelP = findAll(constView.tree, (n) => n.props?.['data-testid'] === 'mobile-constellation-delete-confirm')[0]?.props.onClick();
  constView.rerender();
  assert.equal(
    findAll(constView.tree, (n) => n.props?.['data-testid'] === 'mobile-constellation-detail-back')[0]?.props.disabled,
    true,
  );
  // 真实 deleteLearningNode 在远端成功删除后先刷新去掉已删节点，再 resolve { ok: true }
  panelProps = {
    ...panelProps,
    learningState: {
      status: 'ready',
      profile: 'arch',
      graph: {
        ...enrichedGraph,
        nodes: enrichedGraph.nodes.filter((n) => n.id !== deletedNodeId),
      },
    },
    learningDetail: { status: 'idle' },
  };
  constView.rerender();
  releaseRealDel({ ok: true });
  await realDelP;
  constView.rerender();
  assert.equal(
    findAll(constView.tree, (n) => n.props?.['data-testid'] === 'mobile-constellation-detail').length,
    0,
    '真删除移除节点并切走 activeNode 后，详情视图必须关闭回到星图',
  );

  // Stale error onDeleteNode: switch node while in-flight -> resolving { ok: false, message: 'stale-fail' } must NOT pollute new node
  panelProps = {
    ...panelProps,
    learningState: { status: 'ready', profile: 'arch', graph: enrichedGraph },
    learningDetail: { status: 'ready', id: 'memory:m1', kind: 'memory', label: 'M1', content: 'Body 1', profile: 'arch' },
  };
  constView.rerender();
  findAll(constView.tree, (n) => n.props?.['data-testid'] === 'mobile-constellation-node-memory:m1')[0]?.props.onClick();
  constView.rerender();
  findAll(constView.tree, (n) => n.props?.['data-testid'] === 'mobile-constellation-open-detail')[0]?.props.onClick();
  constView.rerender();
  findAll(constView.tree, (n) => n.props?.['data-testid'] === 'mobile-constellation-delete')[0]?.props.onClick();
  constView.rerender();
  let releaseStaleDelFail = null;
  panelProps = {
    ...panelProps,
    onDeleteNode: () =>
      new Promise((resolve) => {
        releaseStaleDelFail = resolve;
      }),
  };
  constView.rerender();
  const staleDelFailP = findAll(constView.tree, (n) => n.props?.['data-testid'] === 'mobile-constellation-delete-confirm')[0]?.props.onClick();
  findAll(constView.tree, (n) => n.props?.['data-testid'] === 'mobile-constellation-detail-back')[0]?.props.onClick();
  constView.rerender();
  // 点击技能列表卡片直接打开对应技能的大号详情弹窗并点击关联技能跳转
  findAll(constView.tree, (n) => n.props?.['data-testid'] === 'mobile-constellation-skill-item-skill:git-ops')[0]?.props.onClick();
  constView.rerender();
  releaseStaleDelFail({ ok: false, message: 'stale-fail' });
  await staleDelFailP;
  constView.rerender();
  assert.equal(
    findAll(constView.tree, (n) => n.props?.children === 'stale-fail').length,
    0,
    '切换节点后旧删除失败报错不得显示在新节点详情上',
  );
  findAll(constView.tree, (n) => n.props?.['data-testid'] === 'mobile-constellation-related-skill:code-audit')[0]?.props.onClick();
  constView.rerender();

  panelProps = {
    ...panelProps,
    onDeleteNode: async (id, prof) => {
      constCalls.push(['deleteNode', id, prof]);
      return deleteResult;
    },
  };
  constView.rerender();
  findAll(constView.tree, (n) => n.props?.['data-testid'] === 'mobile-constellation-delete')[0]?.props.onClick();
  constView.rerender();
  findAll(constView.tree, (n) => n.props?.children === t('mobile.memory.cancelEditBtn'))[0]?.props.onClick();
  constView.rerender();
  findAll(constView.tree, (n) => n.props?.['data-testid'] === 'mobile-constellation-delete')[0]?.props.onClick();
  constView.rerender();
  await findAll(constView.tree, (n) => n.props?.['data-testid'] === 'mobile-constellation-delete-confirm')[0]?.props.onClick();
  constView.rerender();
  let releasePendingDel = null;
  panelProps = {
    ...panelProps,
    onDeleteNode: () =>
      new Promise((resolve) => {
        releasePendingDel = resolve;
      }),
  };
  constView.rerender();
  const busyDelP = findAll(constView.tree, (n) => n.props?.['data-testid'] === 'mobile-constellation-delete-confirm')[0]?.props.onClick();
  constView.rerender();
  await findAll(constView.tree, (n) => n.props?.['data-testid'] === 'mobile-constellation-delete-confirm')[0]?.props.onClick();
  releasePendingDel({ ok: true });
  await busyDelP;
  constView.rerender();

  // Reopen detail and press back button + switch filter to empty skill/memory state
  findAll(constView.tree, (n) => n.props?.['data-testid'] === 'mobile-constellation-open-detail')[0]?.props.onClick();
  constView.rerender();
  findAll(constView.tree, (n) => n.props?.['data-testid'] === 'mobile-constellation-detail-back')[0]?.props.onClick();
  constView.rerender();
  findAll(constView.tree, (n) => n.props?.['data-testid'] === 'mobile-constellation-filter-skill')[0]?.props.onClick();
  constView.rerender();
  panelProps = {
    ...panelProps,
    learningState: { status: 'ready', profile: 'arch', graph: { nodes: makeNodes(3).slice(1), edges: [], summary: [], totalSkills: 0, totalMemories: 2, axisStart: '', axisEnd: '' } },
  };
  constView.rerender();
  assert.ok(findAll(constView.tree, (n) => n.props?.children === t('mobile.memory.emptyFilter'))[0]);
  constView.unmount();

  // 3b. CognitiveStarMapCanvas 手势(wheel/drag/5px防误触/右键忽略/pinch/双击/键盘)、CognitiveSkillList 搜索排序与切换清零、ConstellationNodeDetailDialog 并发 inspectSeq/profile隔离/raw视图
  const origDoc = globalThis.document;
  const origEl = globalThis.Element;
  globalThis.Element = class FakeDomEl {
    closest() {
      return null;
    }
  };
  globalThis.document = undefined;
  try {
    const sampleGraph = {
      profile: 'arch',
      source: 'rest-graph',
      nodes: [
        { id: 'skill:alpha-scan', kind: 'skill', label: 'alpha-scan', fullLabel: 'alpha-scan', preview: 'Scan alpha', category: 'sec', date: '2026-11-24', uses: 5, meta: 'sec · x5', bucketIndex: 0, skillName: 'alpha-scan' },
        { id: 'skill:zebra-ops', kind: 'skill', label: 'zebra-ops', fullLabel: 'zebra-ops', preview: 'Ops zebra', category: 'ops', date: '2026-11-24', uses: 15, meta: 'ops · x15', bucketIndex: 0, skillName: 'zebra-ops' },
        { id: 'skill:beta-link', kind: 'skill', label: 'beta-link', fullLabel: 'beta-link', preview: 'Link beta', category: 'sec', date: '2026-11-24', uses: 8, meta: 'sec · x8', bucketIndex: 0, skillName: 'beta-link' },
      ],
      edges: [
        { source: 'skill:beta-link', target: 'skill:alpha-scan', kind: 'skill-link' },
        { source: 'skill:beta-link', target: 'skill:zebra-ops', kind: 'skill-link' },
      ],
      summary: [],
      totalSkills: 3,
      totalMemories: 0,
      totalSkillLinks: 2,
      axisStart: '',
      axisEnd: '',
    };
    const canvasLayout = layoutFullConstellationGraph(sampleGraph);
    const canvasEvents = [];
    const dCanvas = createReactHookDriver();
    let canvasProps = {
      layout: canvasLayout,
      variant: 'mobile',
      testIdPrefix: 'cvs-test',
      selectedId: 'skill:zebra-ops',
      fitTriggerKey: 'arch:all:3:2',
      onSelectNode: (id) => canvasEvents.push(['select', id]),
      onOpenNodeDetail: (id) => canvasEvents.push(['open', id]),
    };
    const cvsView = dCanvas.mount(() => React.createElement(CognitiveStarMapCanvas, canvasProps));
    const stageEl = findAll(cvsView.tree, (n) => n.props?.['data-testid'] === 'cvs-test-stage')[0];
    const readScale = () =>
      Number.parseInt(
        String(findAll(cvsView.tree, (n) => n.props?.['data-testid'] === 'cvs-test-zoom-label')[0]?.props.children),
        10,
      );
    const s0 = readScale();
    let prevented = false;
    stageEl.props.onWheel({ deltaY: -120, clientX: 180, clientY: 160, preventDefault: () => { prevented = true; } });
    cvsView.rerender();
    assert.equal(prevented, true);
    const sZoomIn = readScale();
    assert.ok(sZoomIn > s0, '滚轮上滚必须放大画布');
    stageEl.props.onWheel({ deltaY: 0, clientX: 180, clientY: 160, preventDefault: () => {} });
    cvsView.rerender();
    assert.equal(readScale(), sZoomIn);
    stageEl.props.onWheel({ deltaY: 120, clientX: 180, clientY: 160, preventDefault: () => {} });
    cvsView.rerender();

    // 右键忽略；左键拖拽超过 5px 抑制随后单击；小于 5px 视为点击
    stageEl.props.onPointerDown({ pointerType: 'mouse', button: 2, pointerId: 1, clientX: 10, clientY: 10, target: null });
    stageEl.props.onPointerDown({ pointerType: 'mouse', button: 0, pointerId: 1, clientX: 10, clientY: 10, target: null });
    stageEl.props.onPointerMove({ pointerId: 1, clientX: 40, clientY: 50, currentTarget: {} });
    stageEl.props.onPointerUp({ pointerId: 1, clientX: 40, clientY: 50, currentTarget: {} });
    cvsView.rerender();
    const alphaNode = findAll(cvsView.tree, (n) => n.props?.['data-testid'] === 'cvs-test-node-skill:alpha-scan')[0];
    alphaNode.props.onClick();
    assert.equal(canvasEvents.length, 0, '超过 5px 拖拽收手后的顺带 click 必须被抑制');
    await new Promise((r) => setTimeout(r, 10));
    alphaNode.props.onClick();
    alphaNode.props.onDoubleClick();
    alphaNode.props.onKeyDown({ key: 'Enter', preventDefault: () => {} });
    alphaNode.props.onKeyDown({ key: ' ', preventDefault: () => {} });
    assert.deepEqual(canvasEvents, [
      ['select', 'skill:alpha-scan'],
      ['open', 'skill:alpha-scan'],
      ['select', 'skill:alpha-scan'],
      ['select', 'skill:alpha-scan'],
    ]);

    // 双指捏合缩放
    stageEl.props.onPointerDown({ pointerType: 'touch', button: 0, pointerId: 11, clientX: 100, clientY: 100, target: null });
    stageEl.props.onPointerDown({ pointerType: 'touch', button: 0, pointerId: 12, clientX: 150, clientY: 100, target: null });
    stageEl.props.onPointerMove({ pointerId: 12, clientX: 220, clientY: 100, currentTarget: {} });
    cvsView.rerender();
    assert.ok(readScale() > 0);
    stageEl.props.onPointerCancel({ pointerId: 11, currentTarget: {} });
    stageEl.props.onPointerUp({ pointerId: 12, currentTarget: {} });
    cvsView.unmount();

    // SkillList 搜索 / 空结果 / 排序切换 (uses -> links -> name) / 切换 Bot 时重置搜索词
    let starPanelProps = {
      targetProfile: 'arch',
      variant: 'mobile',
      testIdPrefix: 'lst-test',
      learningState: { status: 'ready', profile: 'arch', graph: sampleGraph },
      learningDetail: { status: 'idle' },
      onRefresh: () => {},
      onSelectNodeDetail: () => {},
    };
    const dPanelList = createReactHookDriver();
    const panelListView = dPanelList.mount(() => React.createElement(CognitiveStarMapPanel, starPanelProps));
    const readSkillOrder = () =>
      findAll(panelListView.tree, (n) => String(n.props?.['data-testid'] || '').startsWith('lst-test-skill-item-')).map(
        (n) => n.props['data-testid'],
      );
    assert.deepEqual(readSkillOrder(), [
      'lst-test-skill-item-skill:zebra-ops',
      'lst-test-skill-item-skill:beta-link',
      'lst-test-skill-item-skill:alpha-scan',
    ]);
    findAll(panelListView.tree, (n) => n.props?.['data-testid'] === 'lst-test-skill-sort-links')[0].props.onClick();
    panelListView.rerender();
    assert.equal(readSkillOrder()[0], 'lst-test-skill-item-skill:beta-link');
    findAll(panelListView.tree, (n) => n.props?.['data-testid'] === 'lst-test-skill-sort-name')[0].props.onClick();
    panelListView.rerender();
    assert.equal(readSkillOrder()[0], 'lst-test-skill-item-skill:alpha-scan');

    findAll(panelListView.tree, (n) => n.props?.['data-testid'] === 'lst-test-skill-search')[0].props.onChange({
      target: { value: 'missing-skill-xyz' },
    });
    panelListView.rerender();
    assert.ok(findAll(panelListView.tree, (n) => n.props?.children === t('mobile.memory.skillListEmpty'))[0]);

    // 切换 Bot 后 key={normalizedProfile} 必须重置搜索关键词
    starPanelProps = {
      ...starPanelProps,
      targetProfile: 'ops',
      learningState: { status: 'ready', profile: 'ops', graph: { ...sampleGraph, profile: 'ops' } },
    };
    panelListView.rerender();
    assert.equal(
      findAll(panelListView.tree, (n) => n.props?.['data-testid'] === 'lst-test-skill-search')[0]?.props.value,
      '',
      '切换目标 Bot 后技能搜索词必须清空',
    );
    panelListView.unmount();

    // ConstellationNodeDetailDialog: rendered/raw 切换、onInspectSkill merge + stale inspectSeqRef 丢弃、
    // learningDetail.profile 串台拦截、移动端禁用 xs/sm 且声明 m-no-swipe + pan-x
    let resolveSlowInspect = null;
    let resolveFastInspect = null;
    let inspectCalls = 0;
    let dlgProps = {
      open: true,
      variant: 'mobile',
      node: sampleGraph.nodes[0],
      targetProfile: 'arch',
      learningDetail: { status: 'ready', id: 'skill:alpha-scan', kind: 'skill', label: 'alpha-scan', content: '# Old Default', profile: 'default' },
      relatedSkills: [{ id: 'skill:beta-link', label: 'beta-link', uses: 8 }],
      testIdPrefix: 'dlg-test',
      onClose: () => {},
      onSelectRelatedNode: () => {},
      onSelectNodeDetail: () => {},
      onInspectSkill: () => {
        inspectCalls += 1;
        return new Promise((res) => {
          if (inspectCalls === 1) resolveSlowInspect = res;
          else resolveFastInspect = res;
        });
      },
    };
    const dDlg = createReactHookDriver();
    const dlgView = dDlg.mount(() => React.createElement(ConstellationNodeDetailDialog, dlgProps));
    // learningDetail.profile='default' 与 targetProfile='arch' 不匹配 -> 不得渲染 '# Old Default'
    assert.equal(JSON.stringify(dlgView.tree).includes('# Old Default'), false, '跨 profile 详请必须拦截');
    const dlgRoot = findAll(dlgView.tree, (n) => n.props?.['data-constellation-detail-dialog'] === 'true')[0];
    assert.ok(dlgRoot);
    assert.equal(dlgRoot.props['data-gesture-ignore'], 'pan-x');
    assert.ok(String(dlgRoot.props.className).includes('m-no-swipe'));
    const relBtn = findAll(dlgView.tree, (n) => n.props?.['data-testid'] === 'dlg-test-related-skill:beta-link')[0];
    assert.notEqual(relBtn.props.size, 'xs', '移动端详情弹窗按钮严禁传入 xs 尺寸');

    // 快速切到第二个 skill，旧 inspect 慢返回不得覆盖新 skill
    dlgProps = { ...dlgProps, node: sampleGraph.nodes[1] };
    dlgView.rerender();
    resolveFastInspect({ ok: true, data: { name: 'zebra-ops', markdown: '---\nowner: ops\n---\n# Fresh Zebra' } });
    await new Promise((r) => setTimeout(r, 0));
    dlgView.rerender();
    resolveSlowInspect({ ok: true, data: { name: 'alpha-scan', markdown: '# Stale Alpha' } });
    await new Promise((r) => setTimeout(r, 0));
    dlgView.rerender();
    const bodySnap = JSON.stringify(dlgView.tree);
    assert.ok(bodySnap.includes('Fresh Zebra') && bodySnap.includes('ops'), 'rendered 模式应呈现解析后的标题与 frontmatter 字段');
    assert.equal(bodySnap.includes('Stale Alpha'), false, '旧 inspectSeqRef 响应不得覆盖新节点');

    // 切换 rendered -> raw 视图
    const segBtns = findAll(dlgView.tree, (n) => n.props?.['data-segmented-value'] === 'raw');
    assert.ok(segBtns[0]);
    segBtns[0].props.onClick();
    dlgView.rerender();
    const rawEl = findAll(dlgView.tree, (n) => n.props?.['data-skill-markdown-raw'] === 'true')[0];
    assert.ok(rawEl);
    assert.ok(JSON.stringify(rawEl).includes('# Fresh Zebra'), 'raw 模式应保留原始 Markdown 源码');
    dlgView.unmount();
  } finally {
    globalThis.Element = origEl;
    globalThis.document = origDoc;
  }

  // TurnGroup.compare 覆盖 displayKind / displayMetadata / 全等返回 true 分支
  assert.equal(
    TurnGroup.compare(
      { messages: [{ ...baseTurnMsg, displayKind: 'user' }], mode: 'scratchpad', isLastTurn: true, isStreaming: false },
      { messages: [{ ...baseTurnMsg, displayKind: 'steer' }], mode: 'scratchpad', isLastTurn: true, isStreaming: false },
    ),
    false,
  );
  assert.equal(
    TurnGroup.compare(
      { messages: [{ ...baseTurnMsg, displayMetadata: { a: 1 } }], mode: 'scratchpad', isLastTurn: true, isStreaming: false },
      { messages: [{ ...baseTurnMsg, displayMetadata: { a: 2 } }], mode: 'scratchpad', isLastTurn: true, isStreaming: false },
    ),
    false,
  );
  assert.equal(
    TurnGroup.compare(
      { messages: [{ ...baseTurnMsg }], mode: 'scratchpad', isLastTurn: true, isStreaming: false },
      { messages: [{ ...baseTurnMsg }], mode: 'scratchpad', isLastTurn: true, isStreaming: false },
    ),
    true,
  );

  // MobileBotSubpagePanel memory subpage mounts MobileConstellationPanel (覆盖 learningDetail 缺省回落分支)
  const { snapshot, actions, log } = createSampleData();
  const subMemHtml = renderToStaticMarkup(
    React.createElement(MobileBotSubpagePanel, {
      subpage: 'memory',
      settingsSnapshot: snapshot.settingsSnapshot,
      settingsActions: actions.settingsActions,
      learningState: { status: 'ready', profile: 'default', graph: fullGraph },
      learningDetail: undefined,
      onRefreshLearning: () => {},
      onLoadLearningDetail: () => {},
      onBack: () => {},
      onOpenBotChat: () => {},
      onOpenProviders: () => {},
    }),
  );
  assert.ok(subMemHtml.includes('mobile-constellation-panel'));

  // 4. MobileWorkspaceShell: Stage/Inspector 右上角悬浮按钮、setPointerCapture/releasePointerCapture 与 pointercancel(clientX=0) 滑回
  const prevWin = globalThis.window;
  const prevEl = globalThis.Element;
  globalThis.Element = class MockEl {};
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  try {
    const shellSnap = { ...snapshot, activePane: 'stage', learningState: { status: 'ready', graph: fullGraph } };
    const dShell = createReactHookDriver();
    const shellView = dShell.mount(() => React.createElement(MobileWorkspaceShell, { snapshot: shellSnap, actions }));
    findAll(shellView.tree, (n) => n.props?.['data-testid'] === 'mobile-stage-open-inspector')[0]?.props.onClick();
    assert.ok(log.some(([k, v]) => k === 'onSelectPane' && v === 'inspector'));

    log.length = 0;
    shellSnap.activePane = 'inspector';
    shellView.rerender();
    findAll(shellView.tree, (n) => n.props?.['data-testid'] === 'mobile-inspector-back-stage')[0]?.props.onClick();
    assert.ok(log.some(([k, v]) => k === 'onSelectPane' && v === 'stage'));

    log.length = 0;
    const swipeMain = findAll(shellView.tree, (n) => n.props?.className === 'm-shell__main')[0];
    let releasedPid = -1;
    const mockTarget = {
      setPointerCapture(pid) {
        void pid;
      },
      releasePointerCapture(pid) {
        releasedPid = pid;
        throw new Error('release ignored');
      },
    };
    swipeMain.props.onPointerDown({ button: 0, pointerType: 'touch', pointerId: 9, clientX: 20, clientY: 180, target: null });
    swipeMain.props.onPointerMove({ pointerId: 9, clientX: 220, clientY: 180, currentTarget: mockTarget });
    swipeMain.props.onPointerCancel({ type: 'pointercancel', pointerId: 9, clientX: 0, currentTarget: mockTarget });
    assert.equal(releasedPid, 9);
    assert.ok(log.some(([k, v]) => k === 'onSelectPane' && v === 'stage'), 'pointercancel 归零 clientX 时必须用 lastX 向右滑回 stage');

    // setPointerCapture 抛错时必须静默降级不阻断横向滑动
    swipeMain.props.onPointerDown({ button: 0, pointerType: 'touch', pointerId: 10, clientX: 20, clientY: 180, target: null });
    swipeMain.props.onPointerMove({
      pointerId: 10,
      clientX: 120,
      clientY: 180,
      currentTarget: {
        setPointerCapture() {
          throw new Error('capture refused');
        },
      },
    });
    swipeMain.props.onPointerUp({ pointerId: 10, clientX: 220, clientY: 180, currentTarget: mockTarget });
    shellView.unmount();
  } finally {
    globalThis.Element = prevEl;
    globalThis.window = prevWin;
  }
});

test('移动端会话组织：扁平顶层分类、零内联完成钮、长按双步确认与项目/设置隔离', () => {
  setLocale('zh-CN');
  const { snapshot, actions, log } = createSampleData();
  const projects = [
    { id: 'prj-live', name: 'LiveMobile', path: '/work/mobile', archived: false },
    { id: 'prj-arch', name: 'OldMobile', path: '/work/old', archived: true },
  ];
  const folders = [{ id: 'fld-m1', name: '紧急修复', order: 0 }];
  const orgHome = buildMobileHomeModel({
    activeSessionId: 'sess-1',
    profiles: snapshot.allProfiles,
    groups: [{ roomId: 'room-1', name: '架构讨论群', members: ['default', 'arch'], updatedAt: NOW_MS - 500 }],
    sessions: [
      { id: 'sess-1', title: '调试任务', botName: 'arch', cwd: '/work/mobile/src', timestamp: NOW_MS - 1200 },
      { id: 'sess-fld', title: '文件夹任务', botName: 'default', timestamp: NOW_MS - 1800 },
      { id: 'sess-done-1', title: '已完结任务', botName: 'default', isArchived: true, timestamp: NOW_MS - 4000 },
    ],
    projects,
    folders,
    assignments: { 'session:default:sess-fld': 'fld-m1' },
    profileName: 'default',
    searchQuery: '',
    collapsed: { ...DEFAULT_MOBILE_SECTIONS_COLLAPSED, done: true },
    showDoneSection: true,
    nowMs: NOW_MS,
  });

  // 1. 扁平首页分区无数字计数角标，行内严禁渲染完成/文件夹按钮
  const homeHtml = renderToStaticMarkup(
    React.createElement(MobileHomeScreen, {
      homeTab: 'chats',
      model: orgHome,
      allProfiles: snapshot.allProfiles,
      groupAvatars: snapshot.groupAvatars,
      activeBotName: snapshot.activeBotName,
      gatewayConnected: true,
      gatewayConnecting: false,
      searchOpen: false,
      settingsSnapshot: snapshot.settingsSnapshot,
      modelDetails: snapshot.modelDetails,
      onSelectHomeTab: () => {},
      onSelectBotSubpage: () => {},
      onOpenSettings: () => {},
      onOpenSettingsGateway: () => {},
      onOpenSearch: () => {},
      onCloseSearch: () => {},
      onSearchChange: () => {},
      onOpenNewChat: () => {},
      onToggleSection: () => {},
      onToggleContainer: () => {},
      onToggleDoneSection: () => {},
      onSelectBot: () => {},
      onSelectGroup: () => {},
      onSelectSession: () => {},
      onOpenActionSheet: () => {},
      settingsActions: actions.settingsActions,
    }),
  );
  assert.ok(homeHtml.includes('LiveMobile'));
  assert.ok(homeHtml.includes('紧急修复'));
  assert.equal(homeHtml.includes('OldMobile'), false, '已归档项目不可展示在首页');
  assert.equal(homeHtml.includes('data-row-hover-action='), false, '移动端行内严禁渲染桌面 hover 完成钮');
  assert.equal(/>已完成\s*\(\d+\)/.test(homeHtml), false, '移动端已完成区严禁数字角标');

  // 2. 新建对话 Sheet：居中项目胶囊仅在存在活跃项目时展示且默认为「默认」
  const sheetCommonProps = {
    open: true,
    step: 'compose',
    targetKind: 'bot',
    targetBot: 'default',
    allProfiles: snapshot.allProfiles,
    groupMembers: [],
    groupName: '',
    stats: snapshot.newChatStats,
    gatewayConnected: true,
    selectedModel: snapshot.selectedModel,
    availableModels: snapshot.availableModels,
    modelDetails: snapshot.modelDetails,
    attachments: [],
    selectedProjectId: '',
    onClose: () => {},
    onSetStep: () => {},
    onSelectBot: () => {},
    onSetGroupMembers: () => {},
    onSetGroupName: () => {},
    onSelectProject: () => {},
    onSubmitFirstMessage: () => {},
    onSelectModel: () => {},
    onOpenAttachmentPicker: () => {},
    onRemoveAttachment: () => {},
  };
  const noProjSheet = renderToStaticMarkup(
    React.createElement(MobileNewChatSheet, {
      ...sheetCommonProps,
      projects: [{ id: 'prj-arch', name: 'OldMobile', path: '/work/old', archived: true }],
    }),
  );
  assert.equal(noProjSheet.includes('m-newchat__project-chip'), false, '无活跃项目时隐藏项目胶囊');

  const withProjSheet = renderToStaticMarkup(
    React.createElement(MobileNewChatSheet, {
      ...sheetCommonProps,
      projects,
    }),
  );
  assert.ok(withProjSheet.includes('m-newchat__project-chip'));
  assert.ok(withProjSheet.includes('默认'));

  // 3. MobileSettingsPage：工作台展示开关位于通用设置页，项目管理位于独立 projects 子页
  const mobileSettingsSnapshot = {
    ...snapshot.settingsSnapshot,
    orgPrefs: { showDoneSection: true, autoReopenOnSend: false },
    projects: { status: 'ready', data: projects },
  };
  const mobileSettingsActions = {
    ...actions.settingsActions,
    onCreateProject: async () => ({ ok: true }),
    onDeleteProject: async () => ({ ok: true }),
    onRefreshProjects: () => {},
  };
  const settingsMenuHtml = renderToStaticMarkup(
    React.createElement(MobileSettingsPage, {
      open: true,
      subpage: null,
      appearancePref: 'dark',
      snapshot: mobileSettingsSnapshot,
      onClose: () => {},
      onSelectSubpage: () => {},
      onSetAppearancePreference: () => {},
      onSetConversationOrgPrefs: () => {},
      settingsActions: mobileSettingsActions,
    }),
  );
  assert.ok(settingsMenuHtml.includes(t('mobile.settings.rowProjects')));
  assert.equal(settingsMenuHtml.includes('LiveMobile'), false, '主设置菜单不直接堆叠项目条目');

  const settingsMainHtml = renderToStaticMarkup(
    React.createElement(MobileSettingsPage, {
      open: true,
      subpage: 'appearance',
      appearancePref: 'dark',
      snapshot: mobileSettingsSnapshot,
      onClose: () => {},
      onSelectSubpage: () => {},
      onSetAppearancePreference: () => {},
      onSetConversationOrgPrefs: () => {},
      settingsActions: mobileSettingsActions,
    }),
  );
  assert.ok(settingsMainHtml.includes(t('mobile.settings.orgGroup')));
  assert.ok(settingsMainHtml.includes(t('mobile.settings.showDoneSection')));
  assert.ok(settingsMainHtml.includes(t('mobile.settings.autoReopenOnSend')));
  assert.equal(settingsMainHtml.includes('LiveMobile'), false, '外观/通用页不混合网关项目列表');

  const settingsProjHtml = renderToStaticMarkup(
    React.createElement(MobileSettingsPage, {
      open: true,
      subpage: 'projects',
      appearancePref: 'dark',
      snapshot: mobileSettingsSnapshot,
      onClose: () => {},
      onSelectSubpage: () => {},
      onSetAppearancePreference: () => {},
      onSetConversationOrgPrefs: () => {},
      settingsActions: mobileSettingsActions,
    }),
  );
  assert.ok(settingsProjHtml.includes('LiveMobile'));
  assert.equal(settingsProjHtml.includes('OldMobile'), false);
  assert.equal(settingsProjHtml.includes(t('mobile.settings.showDoneSection')), false, '项目子页严禁包含工作台展示开关');

  // 4. 长按 Action Sheet：完成二次确认、移动到文件夹与 Bot 物理免疫
  const dSheet = createReactHookDriver();
  const markDoneLog = [];
  const moveLog = [];
  const deleteFolderLog = [];
  let sheetSnapshot = {
    ...snapshot,
    folders,
    actionSheet: { kind: 'session', id: 'sess-1', title: '调试任务', isDone: false },
  };
  const sheetActions = {
    ...actions,
    onActionMarkDone: (sh) => markDoneLog.push(sh.id),
    onActionMoveToFolder: (sh, cid) => moveLog.push([sh.id, cid]),
    onActionDeleteFolder: (fid) => deleteFolderLog.push(fid),
  };
  const prevWin = globalThis.window;
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  try {
    const view = dSheet.mount(() => React.createElement(MobileWorkspaceShell, { snapshot: sheetSnapshot, actions: sheetActions }));
    const markBtn = findAll(view.tree, (n) => n.props?.['data-sheet-action'] === 'mark-done')[0];
    assert.ok(markBtn, '会话长按菜单必须含「标记已完成」');
    markBtn.props.onClick();
    view.rerender();
    assert.equal(markDoneLog.length, 0, '未点击二次确认前绝不可直接标记完成');
    const confirmBtn = findAll(view.tree, (n) => n.props?.['data-testid'] === 'mobile-action-confirm-done-btn')[0];
    assert.ok(confirmBtn, '必须进入内联二次确认步骤');
    confirmBtn.props.onClick();
    view.rerender();
    assert.deepEqual(markDoneLog, ['sess-1']);

    sheetSnapshot = { ...sheetSnapshot, actionSheet: null };
    view.rerender();
    sheetSnapshot = { ...sheetSnapshot, actionSheet: { kind: 'session', id: 'sess-1', title: '调试任务', isDone: false } };
    view.rerender();
    findAll(view.tree, (n) => n.props?.['data-sheet-action'] === 'move-folder')[0].props.onClick();
    view.rerender();
    findAll(view.tree, (n) => n.props?.['data-folder-target'] === 'fld-m1')[0].props.onClick();
    assert.deepEqual(moveLog, [['sess-1', 'fld-m1']]);

    sheetSnapshot = { ...sheetSnapshot, actionSheet: null };
    view.rerender();
    sheetSnapshot = { ...sheetSnapshot, actionSheet: { kind: 'folder', id: 'fld-m1', title: '紧急修复' } };
    view.rerender();
    findAll(view.tree, (n) => n.props?.['data-sheet-action'] === 'delete-folder')[0].props.onClick();
    view.rerender();
    findAll(view.tree, (n) => n.props?.['data-testid'] === 'mobile-action-confirm-delete-folder-btn')[0].props.onClick();
    assert.deepEqual(deleteFolderLog, ['fld-m1']);

    sheetSnapshot = { ...sheetSnapshot, actionSheet: null };
    view.rerender();
    sheetSnapshot = { ...sheetSnapshot, actionSheet: { kind: 'bot', id: 'default', title: '默认中枢', isProtected: true } };
    view.rerender();
    assert.equal(findAll(view.tree, (n) => n.props?.['data-sheet-action'] === 'mark-done').length, 0);
    assert.equal(findAll(view.tree, (n) => n.props?.['data-sheet-action'] === 'move-folder').length, 0);
    assert.deepEqual(markDoneLog, ['sess-1'], 'Bot 主工位受保护，不得触发 markDone');
    assert.deepEqual(moveLog, [['sess-1', 'fld-m1']], 'Bot 主工位受保护，不得触发 moveToFolder');
    view.unmount();
  } finally {
    globalThis.window = prevWin;
  }
});

test('记忆图谱组件全分支补充：ResizeObserver/拖拽/捏合、清单平局排序、hasDom弹窗Esc与Bot/Inspector档案兜底', async () => {
  const origDoc = globalThis.document;
  const origEl = globalThis.Element;
  const origRO = globalThis.ResizeObserver;

  try {
    // 1. CognitiveStarMapCanvas: ResizeObserver 尺寸同步(>2px 更新 / <=2px 跳过 / disconnect) + <40 尺寸跳过 + 无 ResizeObserver 分支
    let rectBox = { width: 520, height: 360, left: 12, top: 18 };
    let roCallback = null;
    let roDisconnected = 0;
    globalThis.ResizeObserver = class MockRO {
      constructor(cb) {
        roCallback = cb;
      }
      observe() {}
      disconnect() {
        roDisconnected += 1;
      }
    };
    globalThis.Element = class MockEl {
      constructor(hasCtrl = false) {
        this._ctrl = hasCtrl;
      }
      closest(sel) {
        return this._ctrl && sel === '[data-constellation-controls="true"]' ? this : null;
      }
    };

    const canvasGraph = {
      profile: 'arch',
      source: 'rest-graph',
      nodes: [
        { id: 'skill:very-long-skill-name-exceeds-18-chars', kind: 'skill', label: 'very-long-skill-name-exceeds-18-chars', fullLabel: 'Long', preview: 'Long', category: 'eng', date: '', uses: 9, meta: '', bucketIndex: 0, skillName: 'very-long-skill-name-exceeds-18-chars' },
        { id: 'skill:beta', kind: 'skill', label: 'beta', fullLabel: 'beta', preview: 'beta', category: 'eng', date: '', uses: 4, meta: '', bucketIndex: 0, skillName: 'beta' },
      ],
      edges: [
        { source: 'skill:very-long-skill-name-exceeds-18-chars', target: 'skill:beta', kind: 'skill-link' },
        { source: 'skill:beta', target: 'skill:very-long-skill-name-exceeds-18-chars', kind: 'mention' },
      ],
      summary: [],
      totalSkills: 2,
      totalMemories: 0,
      totalSkillLinks: 1,
      axisStart: '',
      axisEnd: '',
    };
    const baseLayout = layoutFullConstellationGraph(canvasGraph);
    // 注入合成 missing activePosNode 与 missing edge endpoint 以覆盖防御性渲染分支
    const syntheticLayout = {
      ...baseLayout,
      activeNode: { ...baseLayout.nodes[0], id: 'skill:ghost-active' },
      edges: [
        ...baseLayout.edges,
        { source: 'skill:missing', target: 'skill:beta', kind: 'skill-link' },
        { source: 'skill:beta', target: 'skill:missing-dst', kind: 'skill-link' },
      ],
    };

    const drvRO = createReactHookDriver({
      attachRefs: true,
      refOverrides: { getBoundingClientRect: () => rectBox },
    });
    const cvsView = drvRO.mount(() =>
      React.createElement(CognitiveStarMapCanvas, {
        layout: syntheticLayout,
        variant: 'mobile',
        testIdPrefix: 'cvs-adv',
        fitTriggerKey: 'arch:all',
        onSelectNode: () => {},
        onOpenNodeDetail: () => {},
      }),
    );
    const svgViewBox = () =>
      findAll(cvsView.tree, (n) => n.type === 'svg' && n.props?.className === 'constellation-svg')[0]?.props?.viewBox;
    assert.equal(svgViewBox(), '0 0 360 380');
    cvsView.rerender();
    assert.equal(svgViewBox(), '0 0 520 360');
    // <=2px 变化保持 prev 不变; >2px 变化更新 viewportSize; <=40px 忽略
    rectBox = { width: 521, height: 361, left: 12, top: 18 };
    roCallback?.();
    cvsView.rerender();
    assert.equal(svgViewBox(), '0 0 520 360');
    rectBox = { width: 600, height: 420, left: 12, top: 18 };
    roCallback?.();
    cvsView.rerender();
    assert.equal(svgViewBox(), '0 0 600 420');
    rectBox = { width: 20, height: 20, left: 0, top: 0 };
    roCallback?.();
    cvsView.rerender();
    assert.equal(svgViewBox(), '0 0 600 420');
    assert.ok(JSON.stringify(cvsView.tree).includes('…'), '超 18 字符标签必须截断展示省略号');

    const stage = findAll(cvsView.tree, (n) => n.props?.['data-testid'] === 'cvs-adv-stage')[0];
    // 非 Element target + closest 命中 controls 早退（并释放 pointerId 1 以免后续误判双指捏合）
    stage.props.onPointerDown({ pointerId: 1, pointerType: 'touch', clientX: 10, clientY: 10, target: {} });
    stage.props.onPointerUp({ pointerId: 1, currentTarget: {} });
    stage.props.onPointerDown({ pointerId: 2, pointerType: 'touch', clientX: 10, clientY: 10, target: new globalThis.Element(true) });
    // 未登记 pointerId 与 inactive pan 早退
    stage.props.onPointerMove({ pointerId: 999, clientX: 20, clientY: 20 });
    stage.props.onPointerDown({ pointerId: 3, pointerType: 'touch', clientX: 10, clientY: 10, target: new globalThis.Element(false) });
    stage.props.onPointerMove({ pointerId: 3, clientX: 11, clientY: 11 }); // < 5px 触发 !pan.moved 早退
    stage.props.onPointerMove({
      pointerId: 3,
      clientX: 40,
      clientY: 40,
      currentTarget: {
        setPointerCapture() {
          throw new Error('no capture');
        },
      },
    });
    // pan.moved 已为 true 后的连续移动、拖拽中 data-dragging='true' 及抛出 releasePointerCapture 分支
    stage.props.onPointerMove({ pointerId: 3, clientX: 55, clientY: 55, currentTarget: null });
    cvsView.rerender();
    const draggingStage = findAll(cvsView.tree, (n) => n.props?.['data-testid'] === 'cvs-adv-stage')[0];
    assert.equal(draggingStage?.props['data-dragging'], 'true');
    stage.props.onPointerUp({
      pointerId: 3,
      currentTarget: {
        releasePointerCapture() {
          throw new Error('no release');
        },
      },
    });
    // currentTarget=null / currentTarget={} / 正常不抛错 capture 与 release / 未移动(!moved)抬起分支
    stage.props.onPointerDown({ pointerId: 4, pointerType: 'touch', clientX: 10, clientY: 10, target: null });
    stage.props.onPointerMove({ pointerId: 4, clientX: 40, clientY: 40, currentTarget: null });
    stage.props.onPointerUp({ pointerId: 4, currentTarget: null });
    stage.props.onPointerDown({ pointerId: 5, pointerType: 'touch', clientX: 10, clientY: 10, target: null });
    stage.props.onPointerMove({ pointerId: 5, clientX: 40, clientY: 40, currentTarget: {} });
    stage.props.onPointerUp({ pointerId: 5, currentTarget: {} });
    stage.props.onPointerDown({ pointerId: 6, pointerType: 'touch', clientX: 10, clientY: 10, target: null });
    stage.props.onPointerMove({ pointerId: 6, clientX: 40, clientY: 40, currentTarget: { setPointerCapture() {} } });
    stage.props.onPointerUp({ pointerId: 6, currentTarget: { releasePointerCapture() {} } });
    stage.props.onPointerDown({ pointerId: 7, pointerType: 'touch', clientX: 10, clientY: 10, target: null });
    stage.props.onPointerUp({ pointerId: 7, currentTarget: { releasePointerCapture() {} } });
    // 无 getBoundingClientRect 时滚轮与双指捏合兜底
    rectBox = undefined;
    const drvNoRect = createReactHookDriver({
      attachRefs: true,
      refOverrides: { getBoundingClientRect: () => ({ width: 20, height: 20 }) },
    });
    globalThis.ResizeObserver = undefined;
    const cvsNoRO = drvNoRect.mount(() =>
      React.createElement(CognitiveStarMapCanvas, {
        layout: baseLayout,
        variant: 'desktop',
        testIdPrefix: 'cvs-noro',
        fitTriggerKey: 'arch:all',
        onSelectNode: () => {},
        onOpenNodeDetail: () => {},
      }),
    );
    const stageNoRO = findAll(cvsNoRO.tree, (n) => n.props?.['data-testid'] === 'cvs-noro-stage')[0];
    // 捏合无 rect / 滚轮无 rect
    stageNoRO.props.onWheel({ deltaY: -100, clientX: 100, clientY: 100, preventDefault: () => {} });
    stageNoRO.props.onPointerDown({ pointerId: 11, pointerType: 'touch', clientX: 50, clientY: 50, target: null });
    stageNoRO.props.onPointerDown({ pointerId: 12, pointerType: 'touch', clientX: 120, clientY: 50, target: null });
    stageNoRO.props.onPointerMove({ pointerId: 12, clientX: 180, clientY: 80 });
    stageNoRO.props.onPointerMove({ pointerId: 11, clientX: 40, clientY: 40 });
    stageNoRO.props.onPointerUp({ pointerId: 12, currentTarget: {} });
    stageNoRO.props.onPointerMove({ pointerId: 11, clientX: 10, clientY: 10 }); // pinch ended => pan inactive
    stageNoRO.props.onPointerCancel({ pointerId: 11, currentTarget: {} });
    cvsNoRO.unmount();

    cvsView.unmount();
    assert.equal(roDisconnected, 1, '卸载画布时必须调用 ResizeObserver.disconnect()');

    // 2. CognitiveSkillList: uses 相等按 linkCount 降序，再相等按 label 升序，以及空 description/preview
    const drvList = createReactHookDriver();
    const listView = drvList.mount(() =>
      React.createElement(CognitiveSkillList, {
        skills: [
          {
            node: { id: 'skill:b', kind: 'skill', label: 'b-skill', fullLabel: 'b', preview: '', category: 'eng', date: '', uses: 10, meta: '', bucketIndex: 0, skillName: 'b' },
            skillName: 'b',
            uses: 10,
            relatedSkillIds: [],
            relatedMemoryIds: [],
            linkCount: 1,
          },
          {
            node: { id: 'skill:c', kind: 'skill', label: 'a-skill', fullLabel: 'a', preview: '', description: '', category: 'eng', date: '', uses: 10, meta: '', bucketIndex: 0, skillName: 'c' },
            skillName: 'c',
            uses: 10,
            relatedSkillIds: [],
            relatedMemoryIds: [],
            linkCount: 1,
          },
          {
            node: { id: 'skill:top-links', kind: 'skill', label: 'z-skill', fullLabel: 'z', preview: 'z', category: 'eng', date: '', uses: 10, meta: '', bucketIndex: 0, skillName: 'top' },
            skillName: 'top',
            uses: 10,
            relatedSkillIds: ['x', 'y'],
            relatedMemoryIds: [],
            linkCount: 2,
          },
        ],
        testIdPrefix: 'lst-tie',
        onOpenSkillDetail: () => {},
        onFocusSkillOnMap: () => {},
      }),
    );
    const orderedIds = findAll(listView.tree, (n) => String(n.props?.['data-testid'] || '').startsWith('lst-tie-skill-item-')).map(
      (n) => n.props['data-testid'],
    );
    assert.deepEqual(orderedIds, [
      'lst-tie-skill-item-skill:top-links',
      'lst-tie-skill-item-skill:c',
      'lst-tie-skill-item-skill:b',
    ]);
    listView.unmount();

    // 3. CognitiveStarMapPanel: filter === 'memory' 时点击 skill-focus 自动切回 'all'
    const panelFocusGraph = layoutFullConstellationGraph({
      profile: 'arch',
      source: 'rest-graph',
      nodes: [
        { id: 'skill:s1', kind: 'skill', label: 's1', fullLabel: 's1', preview: 's1', category: 'eng', date: '', uses: 5, meta: '', bucketIndex: 0, skillName: 's1' },
        { id: 'memory:m1', kind: 'memory', label: 'm1', fullLabel: 'm1', preview: 'm1', category: 'eng', date: '', uses: 1, meta: '', bucketIndex: 0 },
      ],
      edges: [],
      summary: [],
      totalSkills: 1,
      totalMemories: 1,
      totalSkillLinks: 0,
      axisStart: '',
      axisEnd: '',
    });
    const drvPanel = createReactHookDriver();
    const panelView = drvPanel.mount(() =>
      React.createElement(CognitiveStarMapPanel, {
        targetProfile: 'arch',
        variant: 'mobile',
        testIdPrefix: 'pnl-foc',
        learningState: { status: 'ready', profile: 'arch', graph: { profile: 'arch', source: 'rest-graph', nodes: panelFocusGraph.nodes, edges: [], summary: [], totalSkills: 1, totalMemories: 1, totalSkillLinks: 0, axisStart: '', axisEnd: '' } },
        learningDetail: { status: 'idle' },
        onRefresh: () => {},
        onSelectNodeDetail: () => {},
      }),
    );
    findAll(panelView.tree, (n) => n.props?.['data-testid'] === 'pnl-foc-filter-memory')[0]?.props.onClick();
    panelView.rerender();
    findAll(panelView.tree, (n) => n.props?.['data-testid'] === 'pnl-foc-skill-focus-skill:s1')[0]?.props.onClick();
    panelView.rerender();
    assert.equal(
      findAll(panelView.tree, (n) => n.props?.['data-testid'] === 'pnl-foc-filter-all')[0]?.props['data-active'],
      'true',
    );
    panelView.unmount();

    // 4. ConstellationNodeDetailDialog: empty skillName ('skill:'), preview==='' fallback fullLabel,
    //    empty resolvedDetail.content startEdit, copy without onNotify, desktop swipe noop & hasDom=true Dialog/Escape 守卫
    const runShallowHooks = (fn, slotsArr = [], effectsArr = []) => {
      let sIdx = 0;
      let rIdx = 0;
      let mIdx = 0;
      const internals = React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
      const prevH = internals.H;
      internals.H = {
        useState(init) {
          const i = sIdx++;
          if (!(i in slotsArr)) slotsArr[i] = typeof init === 'function' ? init() : init;
          return [slotsArr[i], (u) => { slotsArr[i] = typeof u === 'function' ? u(slotsArr[i]) : u; }];
        },
        useRef(init) {
          const i = rIdx++;
          const base = sIdx + rIdx;
          if (!(base in slotsArr)) slotsArr[base] = { current: init };
          return slotsArr[base];
        },
        useMemo(f) {
          mIdx++;
          return f();
        },
        useCallback(c) { return c; },
        useEffect(f) { effectsArr.push(f); },
        useLayoutEffect() {},
        useInsertionEffect() {},
        useReducer(r, a, i) { return [i ? i(a) : a, () => {}]; },
        useId() { return 'id-shallow'; },
        useContext(c) { return c?._currentValue; },
        useSyncExternalStore(_s, g) { return g(); },
        useImperativeHandle() {},
        useDebugValue() {},
        useTransition() { return [false, (c) => c()]; },
        useDeferredValue(v) { return v; },
        use(u) { return u?._currentValue; },
      };
      try {
        return fn();
      } finally {
        internals.H = prevH;
      }
    };

    let closeCalls = 0;
    let copyText = '';
    const dlgSlots = [];
    let dlgEffects = [];
    let releaseSlowSave = null;
    const bareSkillNode = {
      id: 'skill:',
      kind: 'skill',
      label: 'bare-skill',
      fullLabel: 'Bare Full Label Fallback',
      preview: '',
      category: 'eng',
      date: '',
      uses: 1,
      meta: '',
      bucketIndex: 0,
      skillName: '',
    };
    let notifyCount = 0;
    const renderDlg = (
      variant,
      learningDetail,
      onSaveEdit,
      nodeOverride = bareSkillNode,
      notifyFn = undefined,
      relatedList = [],
      inspectPayload = { name: 'bare-skill', markdown: '' },
    ) => {
      dlgEffects = [];
      const el = runShallowHooks(
        () =>
          ConstellationNodeDetailDialog({
            open: true,
            variant,
            node: nodeOverride,
            targetProfile: 'arch',
            learningDetail,
            relatedSkills: relatedList,
            testIdPrefix: 'dlg-dom',
            onClose: () => { closeCalls += 1; },
            onSelectRelatedNode: () => {},
            onSelectNodeDetail: () => {},
            onInspectSkill: async () => ({ ok: true, data: inspectPayload }),
            onSaveEdit,
            onCopyText: (txt) => { copyText = txt; },
            onNotify: notifyFn,
          }),
        dlgSlots,
        dlgEffects,
      );
      for (const ef of dlgEffects) ef();
      return el;
    };

    globalThis.document = { addEventListener() {}, removeEventListener() {} };
    // a) hasDom=true + variant='desktop': 检查 Dialog portal=false, stopMobileSwipeBubble 不拦截 desktop, copy 无 onNotify, empty resolvedDetail.content 走 detailContent
    const desktopTree = renderDlg(
      'desktop',
      { status: 'ready', id: 'skill:', kind: 'skill', label: 'bare-skill', content: '', profile: 'arch' },
      () => new Promise((res) => { releaseSlowSave = res; }),
    );
    const deskContent = findAll(desktopTree, (n) => n.props?.['data-constellation-detail-dialog'] === 'true')[0];
    assert.equal(deskContent.props.portal, false);
    deskContent.props.onPointerDown({ stopPropagation() { throw new Error('desktop must not stopPropagation'); } });
    findAll(desktopTree, (n) => n.props?.['aria-label'] === t('mobile.inspector.copyContent'))[0]?.props.onClick();
    assert.equal(copyText, 'Bare Full Label Fallback');

    // mobile 非编辑态 + skillInspectState.data.source/description + empty category/date + uses=0 关联芯片
    const richSlots = [];
    const renderRichMobile = () => {
      const richEffects = [];
      const tree = runShallowHooks(
        () =>
          ConstellationNodeDetailDialog({
            open: true,
            variant: 'mobile',
            node: { ...bareSkillNode, id: 'skill:rich', skillName: 'rich', category: '', date: '' },
            targetProfile: 'arch',
            learningDetail: { status: 'ready', id: 'skill:rich', kind: 'skill', label: 'rich', content: '# Rich Body', profile: 'arch' },
            relatedSkills: [{ id: 'skill:zero', label: 'zero', uses: 0 }, { id: 'skill:three', label: 'three', uses: 3 }],
            testIdPrefix: 'dlg-rich',
            onClose: () => {},
            onSelectRelatedNode: () => {},
            onSelectNodeDetail: () => {},
            onInspectSkill: async () => ({
              ok: true,
              data: { name: 'rich', source: 'local', description: 'inspected desc', markdown: '# Inspected Body' },
            }),
          }),
        richSlots,
        richEffects,
      );
      for (const ef of richEffects) ef();
      return tree;
    };
    renderRichMobile();
    await Promise.resolve();
    await Promise.resolve();
    const inspectedMobileTree = renderRichMobile();
    const inspectedJson = JSON.stringify(inspectedMobileTree);
    assert.ok(inspectedJson.includes('local'));
    assert.ok(inspectedJson.includes('inspected desc'));

    // 空 detailContent branch (line 315 falsy 4th conjunct) + copy WITH onNotify
    const emptyBodySlots = [];
    const emptyBodyTree = runShallowHooks(
      () =>
        ConstellationNodeDetailDialog({
          open: true,
          variant: 'desktop',
          node: { ...bareSkillNode, id: 'memory:empty', kind: 'memory', preview: '', fullLabel: '' },
          targetProfile: 'arch',
          learningDetail: { status: 'idle' },
          relatedSkills: [],
          testIdPrefix: 'dlg-empty',
          onClose: () => {},
          onSelectRelatedNode: () => {},
          onSelectNodeDetail: () => {},
        }),
      emptyBodySlots,
      [],
    );
    assert.equal(findAll(emptyBodyTree, (n) => n.props?.['data-skill-markdown-rendered'] === 'true').length, 0);

    // Dialog onOpenChange(false) & onEscapeKeyDown in idle vs actionBusy
    desktopTree.props.onOpenChange(true);
    assert.equal(closeCalls, 0);
    desktopTree.props.onOpenChange(false);
    assert.equal(closeCalls, 1);
    let escPrevented = false;
    deskContent.props.onEscapeKeyDown({ preventDefault() { escPrevented = true; } });
    assert.equal(escPrevented, false);

    // 点 edit 并提交触发 actionBusy = true，随后在 busy 态拦截 onOpenChange(false) 与 onEscapeKeyDown + mobile stopPropagation + onNotify
    findAll(desktopTree, (n) => n.props?.['data-testid'] === 'dlg-dom-edit')[0]?.props.onClick();
    const editingTree = renderDlg(
      'mobile',
      { status: 'ready', id: 'skill:', kind: 'skill', label: 'bare-skill', content: '', profile: 'arch' },
      () => new Promise((res) => { releaseSlowSave = res; }),
      bareSkillNode,
      () => { notifyCount += 1; },
    );
    findAll(editingTree, (n) => n.props?.['aria-label'] === t('mobile.inspector.copyContent'))[0]?.props.onClick();
    assert.equal(notifyCount, 1);
    let stoppedMob = false;
    const editingContent = findAll(editingTree, (n) => n.props?.['data-constellation-detail-dialog'] === 'true')[0];
    editingContent.props.onPointerDown({ stopPropagation() { stoppedMob = true; } });
    assert.equal(stoppedMob, true);
    const pendingSave = findAll(editingTree, (n) => n.props?.['data-testid'] === 'dlg-dom-save')[0]?.props.onClick();
    const busyMobileTree = renderDlg(
      'mobile',
      { status: 'ready', id: 'skill:', kind: 'skill', label: 'bare-skill', content: '', profile: 'arch' },
      () => new Promise((res) => { releaseSlowSave = res; }),
    );
    const mobContent = findAll(busyMobileTree, (n) => n.props?.['data-constellation-detail-dialog'] === 'true')[0];
    assert.equal(mobContent.props.portal, true);
    busyMobileTree.props.onOpenChange(false);
    assert.equal(closeCalls, 1, 'actionBusy 期间不可关闭');
    mobContent.props.onEscapeKeyDown({ preventDefault() { escPrevented = true; } });
    assert.equal(escPrevented, true, 'actionBusy 期间 Esc 必须 preventDefault');
    releaseSlowSave?.({ ok: true });
    await pendingSave;

    // 5. MobileBotSubpage & MobileInspectorScreen profile fallback 分支
    const { snapshot, actions } = createSampleData();
    const subFallback = renderToStaticMarkup(
      React.createElement(MobileBotSubpagePanel, {
        subpage: 'memory',
        settingsSnapshot: {
          ...snapshot.settingsSnapshot,
          botManagement: {
            ...snapshot.settingsSnapshot.botManagement,
            activeBotId: 'fallback-bot',
            roster: [{ id: 'fallback-bot', displayName: '', model: '', isDefault: false, hasDraft: false }],
            activeDetail: { ...snapshot.settingsSnapshot.botManagement.activeDetail, id: 'fallback-bot', displayName: '' },
          },
        },
        settingsActions: actions.settingsActions,
        learningState: { status: 'ready', profile: 'fallback-bot', graph: { profile: 'fallback-bot', source: 'rest-graph', nodes: baseLayout.nodes, edges: [], summary: [], totalSkills: 2, totalMemories: 0, totalSkillLinks: 1, axisStart: '', axisEnd: '' } },
        onRefreshLearning: () => {},
        onLoadLearningDetail: () => {},
        onBack: () => {},
        onOpenBotChat: () => {},
        onOpenProviders: () => {},
      }),
    );
    assert.ok(subFallback.includes('fallback-bot'));

    const inspBaseProps = {
      activeTab: 'memory',
      readerOpen: false,
      readerItem: null,
      artifacts: [],
      gitDiffs: [],
      openFiles: [],
      fileTreeState: { status: 'idle' },
      fileTreeExpandedPaths: [],
      fileTreeFilterQuery: '',
      workspaceRootName: 'hermes-flux',
      memories: [],
      learningState: { status: 'ready', profile: 'default', graph: { profile: 'default', source: 'rest-graph', nodes: baseLayout.nodes, edges: [], summary: [], totalSkills: 2, totalMemories: 0, totalSkillLinks: 1, axisStart: '', axisEnd: '' } },
      learningDetail: { status: 'idle' },
      groupMembers: [],
      onSelectTab: () => {},
      onBackToStage: () => {},
      onRefreshLearning: () => {},
      onLoadLearningDetail: () => {},
      onOpenFile: () => {},
      onLoadFileTree: () => {},
      onToggleFileTreeDir: () => {},
      onFilterFileTree: () => {},
      onCloseReader: () => {},
      onDownloadFile: () => {},
      onCopyContent: () => {},
    };
    const inspSessionFallback = renderToStaticMarkup(
      React.createElement(MobileInspectorScreen, {
        ...inspBaseProps,
        activeFocus: { type: 'session', sessionId: 's1' },
      }),
    );
    assert.ok(inspSessionFallback.includes('data-profile="default"'));
    const inspBotNamed = renderToStaticMarkup(
      React.createElement(MobileInspectorScreen, {
        ...inspBaseProps,
        activeFocus: { type: 'bot', botName: 'bot-a' },
        learningState: { status: 'ready', profile: 'bot-a', graph: { profile: 'bot-a', source: 'rest-graph', nodes: baseLayout.nodes, edges: [], summary: [], totalSkills: 2, totalMemories: 0, totalSkillLinks: 1, axisStart: '', axisEnd: '' } },
      }),
    );
    assert.ok(inspBotNamed.includes('data-profile="bot-a"'));
    const inspBotEmpty = renderToStaticMarkup(
      React.createElement(MobileInspectorScreen, {
        ...inspBaseProps,
        activeFocus: { type: 'bot', botName: '' },
      }),
    );
    assert.ok(inspBotEmpty.includes('data-profile="default"'));
  } finally {
    globalThis.document = origDoc;
    globalThis.Element = origEl;
    globalThis.ResizeObserver = origRO;
  }
});

test('移动端体验修复 Regression：容器 icon 后置、首屏无持续选中深底、灯箱返回键优先级与 HTML/Markdown/视频阅读器', () => {
  const sample = createSampleData();
  const activeHomeModel = {
    ...sample.snapshot.homeModel,
    projectSections: [
      {
        kind: 'project',
        id: 'p-1',
        containerId: 'prj:p-1',
        name: 'MobileProject',
        isCollapsed: false,
        effectiveExpanded: true,
        items: [
          {
            kind: 'session',
            id: 's-proj',
            title: 'Project Session',
            subtitle: 'sub',
            ownerBotName: 'default',
            ownerBotDisplayName: 'Default',
            timeText: '10:00',
            isPinned: false,
            isActive: true,
            containerId: 'prj:p-1',
            activityState: 'read',
            activityTransition: 'none',
            statusTextKey: null,
            session: { id: 's-proj', title: 'Project Session' },
          },
        ],
      },
    ],
    folderSections: [
      {
        kind: 'folder',
        id: 'fld-mob',
        containerId: 'fld-mob',
        name: 'MobileCustomFolder',
        color: 'success',
        isCollapsed: false,
        effectiveExpanded: true,
        items: [],
      },
    ],
  };

  // Issue 1 & Issue 2: 首屏 DOM 图标位置在标题后 + 即使 model 标 active 移动端首页所有行也不高亮保持 data-active="false"
  const homeMarkup = renderToStaticMarkup(
    React.createElement(MobileHomeScreen, {
      homeTab: 'chats',
      model: activeHomeModel,
      allProfiles: sample.snapshot.allProfiles,
      groupAvatars: sample.snapshot.groupAvatars,
      activeBotName: 'default',
      gatewayConnected: true,
      gatewayConnecting: false,
      searchOpen: false,
      settingsSnapshot: sample.snapshot.settingsSnapshot,
      modelDetails: [],
      onSelectHomeTab: () => {},
      onSelectBotSubpage: () => {},
      onOpenSettings: () => {},
      onOpenSettingsGateway: () => {},
      onOpenSearch: () => {},
      onCloseSearch: () => {},
      onSearchChange: () => {},
      onOpenNewChat: () => {},
      onToggleSection: () => {},
      onSelectBot: () => {},
      onSelectGroup: () => {},
      onSelectSession: () => {},
      onOpenActionSheet: () => {},
      settingsActions: sample.actions.settingsActions,
    }),
  );
  const projTitlePos = homeMarkup.indexOf('MobileProject');
  const projIconPos = homeMarkup.indexOf('data-container-icon="project"');
  assert.ok(projTitlePos > -1 && projIconPos > -1 && projTitlePos < projIconPos, '移动端项目图标必须位于名称之后');
  const fldTitlePos = homeMarkup.indexOf('MobileCustomFolder');
  const fldIconPos = homeMarkup.indexOf('data-container-icon="folder"');
  assert.ok(fldTitlePos > -1 && fldIconPos > -1 && fldTitlePos < fldIconPos, '移动端文件夹图标必须位于名称之后');
  assert.ok(homeMarkup.includes('m-section__folder-icon--success'), '移动端文件夹颜色类名必须保留');
  assert.equal(homeMarkup.includes('class="m-entity-row" data-active="true"'), false, '移动端首页列表不得保留持久化深底选中态');

  const mobileCss = fs.readFileSync(path.resolve(import.meta.dirname, '../src/styles/mobile-shell.css'), 'utf8');
  assert.equal(
    /\.m-entity-row\[data-active="true"\]/.test(mobileCss),
    false,
    'mobile-shell.css 不得再定义 .m-entity-row[data-active="true"] 持久高亮背景',
  );
  const destructiveColorIdx = mobileCss.indexOf('.m-section__folder-icon--destructive');
  const dupFolderRuleIdx = mobileCss.indexOf('.m-section__folder-icon {', destructiveColorIdx);
  assert.equal(
    dupFolderRuleIdx,
    -1,
    'mobile-shell.css 不得在颜色修饰类之后重定义 .m-section__folder-icon 覆盖文件夹色',
  );
  assert.ok(mobileCss.includes('color-scheme: light;') && mobileCss.includes('background: Canvas;'), 'HTML 预览 iframe 必须保证亮色纸底');

  // Issue 4a: 物理返回键最高优先关闭悬浮图片灯箱
  const backRes = reduceMobileBackAction({
    activePane: 'stage',
    mediaLightboxOpen: true,
    hasActionSheet: true,
    hasModelSheet: false,
    hasSubagentSheet: false,
    newChatOpen: false,
    newChatStep: 'compose',
    searchOpen: false,
    settingsOpen: false,
    settingsSubpage: null,
    inspectorReaderOpen: false,
  });
  assert.deepEqual(backRes, { handled: true, effect: 'closeMediaLightbox' });

  // Issue 4b: MobileInspectorScreen 成果物列表与 HTML / Markdown / Video / Image 阅读器
  const lightboxCalls = [];
  const wsOpenCalls = [];
  const artifactsMarkup = renderToStaticMarkup(
    React.createElement(MobileInspectorScreen, {
      activeFocus: { type: 'session', sessionId: 's-1' },
      activeTab: 'artifacts',
      readerOpen: false,
      readerItem: null,
      artifacts: [
        { id: 'd1', name: 'chart.png', type: 'PNG', size: '', path: '/out/chart.png', kind: 'image', previewUrl: 'data:image/png;base64,AA==' },
        { id: 'd2', name: 'demo.html', type: 'HTML', size: '', path: '/out/demo.html', kind: 'html' },
      ],
      gitDiffs: [],
      openFiles: [],
      fileTreeState: { status: 'idle' },
      fileTreeExpandedPaths: [],
      fileTreeFilterQuery: '',
      activeFilePath: '',
      memories: [],
      learningState: { status: 'idle', profile: 'default' },
      learningDetail: { status: 'idle' },
      groupMembers: [],
      onSelectTab: () => {},
      onOpenItem: () => {},
      onCloseReader: () => {},
      onCopyText: () => {},
      onLoadFileTree: () => {},
      onToggleFileTreeDir: () => {},
      onFilterFileTree: () => {},
      onOpenWorkspaceFile: (p) => wsOpenCalls.push(p),
      onDownloadInspectorFile: () => {},
      onOpenMediaLightbox: (items, idx) => lightboxCalls.push({ items, idx }),
    }),
  );
  assert.equal((artifactsMarkup.match(/data-testid="mobile-artifact-card"/g) || []).length, 2);
  assert.ok(artifactsMarkup.includes('chart.png') && artifactsMarkup.includes('PNG'));
  assert.ok(artifactsMarkup.includes('demo.html') && artifactsMarkup.includes('HTML'));
  assert.equal(artifactsMarkup.includes('>/out/chart.png<'), false, '移动端成果物卡不得在可见区重复渲染完整目录路径');

  // HTML reader -> sandbox="allow-scripts" iframe + view toggle
  const htmlReaderMarkup = renderToStaticMarkup(
    React.createElement(MobileInspectorScreen, {
      activeFocus: { type: 'session', sessionId: 's-1' },
      activeTab: 'artifacts',
      readerOpen: true,
      readerItem: { kind: 'artifacts', title: 'demo.html', filePath: '/out/demo.html', content: '<h1>Hello</h1>', canDownload: true },
      artifacts: [],
      gitDiffs: [],
      openFiles: [],
      fileTreeState: { status: 'idle' },
      fileTreeExpandedPaths: [],
      fileTreeFilterQuery: '',
      activeFilePath: '/out/demo.html',
      memories: [],
      learningState: { status: 'idle', profile: 'default' },
      learningDetail: { status: 'idle' },
      groupMembers: [],
      onSelectTab: () => {},
      onOpenItem: () => {},
      onCloseReader: () => {},
      onCopyText: () => {},
      onLoadFileTree: () => {},
      onToggleFileTreeDir: () => {},
      onFilterFileTree: () => {},
      onOpenWorkspaceFile: () => {},
      onDownloadInspectorFile: () => {},
    }),
  );
  assert.ok(htmlReaderMarkup.includes('data-testid="mobile-inspector-html-frame"'));
  assert.ok(htmlReaderMarkup.includes('sandbox="allow-scripts"'));
  assert.equal(htmlReaderMarkup.includes('allow-same-origin'), false, 'HTML sandbox 严禁开放 allow-same-origin');
  assert.ok(htmlReaderMarkup.includes('data-testid="mobile-inspector-toggle-view"'));

  // Video reader -> <video controls>
  const videoReaderMarkup = renderToStaticMarkup(
    React.createElement(MobileInspectorScreen, {
      activeFocus: { type: 'session', sessionId: 's-1' },
      activeTab: 'files',
      readerOpen: true,
      readerItem: { kind: 'files', title: 'demo.mp4', filePath: '/out/demo.mp4', isVideo: true, content: 'data:video/mp4;base64,AAA', canDownload: true },
      artifacts: [],
      gitDiffs: [],
      openFiles: [],
      fileTreeState: { status: 'idle' },
      fileTreeExpandedPaths: [],
      fileTreeFilterQuery: '',
      activeFilePath: '/out/demo.mp4',
      memories: [],
      learningState: { status: 'idle', profile: 'default' },
      learningDetail: { status: 'idle' },
      groupMembers: [],
      onSelectTab: () => {},
      onOpenItem: () => {},
      onCloseReader: () => {},
      onCopyText: () => {},
      onLoadFileTree: () => {},
      onToggleFileTreeDir: () => {},
      onFilterFileTree: () => {},
      onOpenWorkspaceFile: () => {},
      onDownloadInspectorFile: () => {},
    }),
  );
  assert.ok(videoReaderMarkup.includes('data-testid="mobile-inspector-video"'));
  assert.ok(videoReaderMarkup.includes('<video '));
});

test('MobileInspectorScreen 与 MobileWorkspaceShell 媒体成果物点击、Markdown切换、视频图标与返回关灯箱', () => {
  const collect = (node, pred, acc = []) => {
    if (!node || typeof node !== 'object') return acc;
    if (Array.isArray(node)) {
      node.forEach((n) => collect(n, pred, acc));
      return acc;
    }
    if (pred(node)) acc.push(node);
    if (node.props && 'children' in node.props) collect(node.props.children, pred, acc);
    return acc;
  };

  // 1. artifacts Tab 全类型图标、图片直进灯箱、优先 onOpenArtifactFile / 次选 onOpenWorkspaceFile / 无 path 兜底 onOpenItem
  const lightboxCalls = [];
  const artifactOpenCalls = [];
  const wsOpenCalls = [];
  const itemOpenCalls = [];
  const baseProps = {
    activeFocus: { type: 'session', sessionId: 's-1' },
    activeTab: 'artifacts',
    readerOpen: false,
    readerItem: null,
    artifacts: [
      { id: 'i1', name: 'shot.png', type: 'PNG', size: '', path: '/out/shot.png', kind: 'image', previewUrl: 'data:image/png;base64,AA==' },
      { id: 'v1', name: 'clip.mp4', type: 'MP4', size: '', path: '/out/clip.mp4', kind: 'video' },
      { id: 'h1', name: 'page.html', type: 'HTML', size: '', path: '/out/page.html', kind: 'html' },
      { id: 'd1', name: 'spec.pdf', type: 'PDF', size: '', path: '/out/spec.pdf', kind: 'document' },
      { id: 'f1', name: 'inline-note.md', type: 'MD', size: '', content: '# raw note' },
    ],
    gitDiffs: [],
    openFiles: [],
    fileTreeState: {
      status: 'ready',
      source: 'gateway_api',
      rootPath: '/out',
      nodes: [{ name: 'clip.mp4', path: '/out/clip.mp4', kind: 'file', size: 2048 }],
    },
    fileTreeExpandedPaths: [],
    fileTreeFilterQuery: '',
    activeFilePath: '',
    memories: [],
    learningState: { status: 'idle', profile: 'default' },
    learningDetail: { status: 'idle' },
    groupMembers: [],
    onSelectTab: () => {},
    onOpenItem: (it) => itemOpenCalls.push(it),
    onCloseReader: () => {},
    onCopyText: () => {},
    onLoadFileTree: () => {},
    onToggleFileTreeDir: () => {},
    onFilterFileTree: () => {},
    onOpenWorkspaceFile: (p) => wsOpenCalls.push(p),
    onOpenArtifactFile: (p, url) => artifactOpenCalls.push({ p, url }),
    onDownloadInspectorFile: () => {},
    onOpenMediaLightbox: (items, idx) => lightboxCalls.push({ items, idx }),
  };

  const d1 = createReactHookDriver();
  const v1 = d1.mount(() => React.createElement(MobileInspectorScreen, baseProps));
  const cards = collect(v1.tree, (n) => n.props?.['data-testid'] === 'mobile-artifact-card');
  assert.equal(cards.length, 5);
  cards[0].props.onClick();
  assert.equal(lightboxCalls.length, 1);
  assert.equal(lightboxCalls[0].items[0].path, '/out/shot.png');
  cards[1].props.onClick();
  assert.equal(artifactOpenCalls.at(-1)?.p, '/out/clip.mp4');
  cards[4].props.onClick();
  assert.equal(itemOpenCalls.length, 1);
  assert.equal(itemOpenCalls[0].title, 'inline-note.md');
  v1.unmount();

  // 无 onOpenArtifactFile 时，有 path 走 onOpenWorkspaceFile
  const d2 = createReactHookDriver();
  const v2 = d2.mount(() =>
    React.createElement(MobileInspectorScreen, {
      ...baseProps,
      onOpenArtifactFile: undefined,
      activeTab: 'files',
    }),
  );
  // 顺带验证 files Tab 对 .mp4 文件名渲染视频行
  assert.ok(collect(v2.tree, (n) => n.props?.['data-testid'] === 'mobile-tree-file-/out/clip.mp4').length === 1);
  v2.unmount();

  const d2b = createReactHookDriver();
  const v2b = d2b.mount(() =>
    React.createElement(MobileInspectorScreen, {
      ...baseProps,
      onOpenArtifactFile: undefined,
    }),
  );
  collect(v2b.tree, (n) => n.props?.['data-testid'] === 'mobile-artifact-card')[2].props.onClick();
  assert.deepEqual(wsOpenCalls, ['/out/page.html']);
  v2b.unmount();

  // 2. Markdown 阅读器：默认 rendered，连续切换 rendered <-> raw 覆盖往返标签与状态翻转
  const dMd = createReactHookDriver();
  const vMd = dMd.mount(() =>
    React.createElement(MobileInspectorScreen, {
      ...baseProps,
      readerOpen: true,
      readerItem: { kind: 'artifacts', title: 'notes.md', filePath: '/out/notes.md', content: '# 标题', canDownload: true },
    }),
  );
  assert.ok(collect(vMd.tree, (n) => n.props?.['data-testid'] === 'mobile-inspector-markdown').length === 1);
  const toggleBtnRendered = collect(vMd.tree, (n) => n.props?.['data-testid'] === 'mobile-inspector-toggle-view')[0];
  const labelWhenRendered = toggleBtnRendered.props['aria-label'];
  toggleBtnRendered.props.onClick();
  vMd.rerender();
  assert.ok(collect(vMd.tree, (n) => n.props?.className === 'm-inspector__reader-code').length === 1);
  const toggleBtnRaw = collect(vMd.tree, (n) => n.props?.['data-testid'] === 'mobile-inspector-toggle-view')[0];
  assert.notEqual(toggleBtnRaw.props['aria-label'], labelWhenRendered);
  toggleBtnRaw.props.onClick();
  vMd.rerender();
  assert.ok(collect(vMd.tree, (n) => n.props?.['data-testid'] === 'mobile-inspector-markdown').length === 1);
  vMd.unmount();

  // 3. 图片阅读器点击放大打开灯箱
  const lbImgClicks = [];
  const dImg = createReactHookDriver();
  const vImg = dImg.mount(() =>
    React.createElement(MobileInspectorScreen, {
      ...baseProps,
      onOpenMediaLightbox: (items, idx) => lbImgClicks.push({ items, idx }),
      readerOpen: true,
      readerItem: {
        kind: 'files',
        title: 'pic.png',
        filePath: '/out/pic.png',
        isImage: true,
        content: 'data:image/png;base64,AA==',
      },
    }),
  );
  collect(vImg.tree, (n) => n.props?.className === 'm-inspector__reader-image-btn')[0].props.onClick();
  assert.equal(lbImgClicks[0]?.items[0]?.filePath ?? lbImgClicks[0]?.items[0]?.path, '/out/pic.png');
  vImg.unmount();

  // 4. MobileWorkspaceShell: Android 系统返回键优先关闭 MediaLightbox
  const { snapshot, actions } = createSampleData();
  let closedLb = 0;
  const shellSnap = {
    ...snapshot,
    mediaLightbox: {
      items: [{ id: 'lb1', src: 'data:image/png;base64,AA==', name: 'lb.png' }],
      initialIndex: 0,
    },
  };
  const shellActions = {
    ...actions,
    onCloseMediaLightbox: () => {
      closedLb += 1;
    },
  };
  const prevWin = globalThis.window;
  const winListeners = new Map();
  globalThis.window = {
    addEventListener(type, fn) {
      winListeners.set(type, fn);
    },
    removeEventListener(type) {
      winListeners.delete(type);
    },
  };
  try {
    const dShell = createReactHookDriver();
    const vShell = dShell.mount(() => React.createElement(MobileWorkspaceShell, { snapshot: shellSnap, actions: shellActions }));
    let prevented = false;
    winListeners.get('hermes-mobile-back')?.({ preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
    assert.equal(closedLb, 1);
    vShell.unmount();
  } finally {
    globalThis.window = prevWin;
  }
});
