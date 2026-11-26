/**
 * 移动端组件与状态模型交互覆盖补充测试
 * 覆盖 MobileApprovalModeSheet, MobileConversationScreen, MobileHomeScreen,
 * MobileMorphingComposer, MobileWorkspaceShell, mobileShellModel, CompactTraceCapsule
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {
  CompactTraceCapsule,
  MobileApprovalModeSheet,
  MobileConversationScreen,
  MobileHomeScreen,
  MobileMorphingComposer,
  MobileWorkspaceShell,
  buildMobileHomeModel,
  consolidateMobileTurnTraces,
  reduceMobileBackAction,
  setLocale,
} from '../dist/index.js';
import { createHookDriver, findAll, findByTestId } from './helpers/reactHookDriver.mjs';

test('mobileShellModel: waiting 状态折叠标题、rowWaiting 与 reduceMobileBackAction hasApprovalSheet', () => {
  setLocale('zh-CN');

  for (const reason of ['clarify', 'approval', 'credential', 'connection', 'confirm', undefined]) {
    const model = buildMobileHomeModel({
      profiles: [
        { name: 'b1', displayName: 'B1', isDefault: true, activityState: 'waiting', waitingReason: reason },
      ],
      groups: [
        { roomId: 'g1', name: 'G1', members: ['b1'], activityState: 'waiting', waitingReason: reason },
      ],
      sessions: [
        { id: 's1', title: 'S1', botName: 'b1', timestamp: 1, activityState: 'waiting', waitingReason: reason },
      ],
      collapsed: { bots: true, groups: true, sessions: false },
      activeFocus: { type: 'session', sessionId: 's1' },
      searchQuery: '',
    });
    assert.equal(model.botsSection.headerStatus?.state, 'waiting');
    assert.equal(model.groupsSection.headerStatus?.state, 'waiting');
    assert.equal(model.sessionsSection.items[0].activityState, 'waiting');
  }

  assert.deepEqual(
    reduceMobileBackAction({
      activePane: 'stage',
      hasActionSheet: false,
      hasModelSheet: false,
      hasApprovalSheet: true,
      hasSubagentSheet: false,
      newChatOpen: false,
      newChatStep: 'compose',
      searchOpen: false,
      settingsOpen: false,
      settingsSubpage: null,
      inspectorReaderOpen: false,
    }),
    { handled: true, effect: 'closeApprovalSheet' },
  );
});

test('CompactTraceCapsule 与 consolidateMobileTurnTraces sender 回填与空尾分支', () => {
  setLocale('zh-CN');
  const d = createHookDriver();

  // firstPendingMsg has sender, lastPendingMsg omits sender -> copies sender onto flushed carrier
  const flushedRows = consolidateMobileTurnTraces(
    [
      { id: 'u1', role: 'assistant', displayKind: 'assistant', sender: 'Coder', senderAvatar: 'av.png', thought: 't1', content: '' },
      { id: 'u2', role: 'assistant', displayKind: 'assistant', toolCalls: [{ id: 'tc1', name: 'read_file', status: 'done' }], content: '' },
    ],
    false,
  );
  assert.equal(flushedRows.length, 1);
  assert.equal(flushedRows[0].message.sender, 'Coder');

  // attachment barrier & empty rows fallback -> 必须满足 messages.length > 1 && messages[0].role === 'assistant' 才进入主循环 (L107/152/153)
  const barrierRows = consolidateMobileTurnTraces(
    [
      { id: 'b0', role: 'assistant', displayKind: 'assistant', content: '' },
      { id: 'b1', role: 'assistant', displayKind: 'assistant', attachments: [{ id: 'a1', name: 'x.txt', size: 10, kind: 'text' }], content: '' },
      { id: 'b2', role: 'assistant', displayKind: 'assistant', attachments: [], content: 'done' },
    ],
    false,
  );
  assert.equal(barrierRows.length, 2);
  const emptyTraceRows = consolidateMobileTurnTraces(
    [
      { id: 'emp1', role: 'assistant', displayKind: 'assistant', attachments: [], content: '' },
      { id: 'emp2', role: 'assistant', displayKind: 'assistant', content: '' },
    ],
    false,
  );
  assert.equal(emptyTraceRows.length, 1);
  assert.equal(emptyTraceRows[0].message.id, 'emp2');

  // isStreaming with both thought and done standard tool (L273) & empty rows fallback
  const m1 = d.mount(() =>
    React.createElement(CompactTraceCapsule, {
      messageId: 'm-stream',
      thought: '',
      tools: [],
      isStreaming: true,
    }),
  );
  assert.ok(m1.tree);
  const d1b = createHookDriver();
  const m1b = d1b.mount(() =>
    React.createElement(CompactTraceCapsule, {
      messageId: 'm-stream-full',
      thought: 'still thinking',
      tools: [{ id: 't-done', name: 'bash', status: 'done' }],
      isStreaming: true,
    }),
  );
  assert.ok(m1b.tree);

  const m2 = d.mount(() =>
    React.createElement(CompactTraceCapsule, {
      messageId: 'm-multi',
      steps: [
        { id: 'st-empty', thought: '', tools: [] },
        { id: 'st-full', thought: 'step think', tools: [{ id: 'tc2', name: 'bash', status: 'done' }] },
      ],
      isStreaming: false,
    }),
  );
  assert.ok(m2.tree);
});

test('MobileApprovalModeSheet, MobileConversationScreen, MobileHomeScreen 与 MobileMorphingComposer', () => {
  setLocale('zh-CN');
  const d = createHookDriver();
  const prevRO = globalThis.ResizeObserver;
  const roInstances = [];
  class MockResizeObserver {
    constructor(cb) {
      this.cb = cb;
      roInstances.push(this);
    }
    observe() {}
    disconnect() {}
  }
  globalThis.ResizeObserver = MockResizeObserver;

  try {
    // 1. MobileApprovalModeSheet click
    let chosenMode = '';
    let sheetClosed = 0;
    const sheetMount = d.mount(() =>
      React.createElement(MobileApprovalModeSheet, {
        open: true,
        approvalMode: 'manual',
        onSelectApprovalMode: (mode) => { chosenMode = mode; },
        onClose: () => { sheetClosed += 1; },
      }),
    );
    const smartOpt = findAll(sheetMount.tree, (n) => n?.props?.['data-approval-mode'] === 'smart')[0];
    smartOpt.props.onClick();
    assert.equal(chosenMode, 'smart');
    assert.equal(sheetClosed, 1);

    // 2. MobileConversationScreen ResizeObserver & rollbackBanner
    let panePropsSet = [];
    const screenD = createHookDriver({
      style: { setProperty: (k, v) => panePropsSet.push([k, v]) },
      clientHeight: 500,
      scrollHeight: 1000,
      scrollTop: 400,
    });
    const screenMount = screenD.mount(() =>
      React.createElement(MobileConversationScreen, {
        gatewayConnected: true,
        connectionPhase: 'connected',
        activeFocus: { type: 'session', sessionId: 's1' },
        agentPresence: { kind: 'idle', text: '' },
        botRoster: [],
        messages: [],
        hasOlderMessages: false,
        isLoadingOlder: false,
        isStreaming: false,
        selectedModel: 'auto',
        approvalMode: 'manual',
        availableModels: [],
        modelDetails: [],
        attachments: [],
        dockNotice: '',
        sideAgentCapsules: [],
        rollbackBanner: { removedCount: 2, anchorLabel: '#1' },
        composerDraftOverride: null,
        onSendMessage: () => {},
        onInterruptTurn: () => {},
        onOpenAttachmentPicker: () => {},
        onRemoveAttachment: () => {},
        onSelectModel: () => {},
        onSelectApprovalMode: () => {},
        onCancelRollback: () => {},
        onLoadOlderMessages: () => {},
        onCopyMessage: () => {},
        onRollbackMessage: () => {},
        onForkMessage: () => {},
        onOpenFile: () => {},
        onDownloadMedia: () => {},
      }),
    );
    // Fire both ResizeObservers (dockEl with borderBoxSize and contentRect, streamEl)
    if (roInstances[0]) {
      roInstances[0].cb([{ borderBoxSize: [{ blockSize: 120 }], contentRect: { height: 100 } }]);
      roInstances[0].cb([{ borderBoxSize: [], contentRect: { height: 95 } }]);
      roInstances[0].cb([]);
    }
    if (roInstances[1]) {
      roInstances[1].cb([]);
    }
    screenMount.unmount();
    assert.ok(panePropsSet.length >= 2);

    // 2b. MobileConversationScreen without rollbackBanner + with interactivePromptHost + backgroundWaiting without custom resolver + dockNotice
    const screenD2 = createHookDriver({ style: { setProperty() {} } });
    screenD2.mount(() =>
      React.createElement(MobileConversationScreen, {
        gatewayConnected: true,
        connectionPhase: 'connected',
        activeFocus: { type: 'group', roomId: 'g1' },
        agentPresence: { kind: 'idle', text: '' },
        botRoster: [],
        messages: [],
        messagesCount: 0,
        hasOlderMessages: false,
        isLoadingOlder: false,
        isStreaming: false,
        selectedModel: 'auto',
        approvalMode: 'manual',
        interactivePrompts: [{
          canonicalKey: 'k-mcs',
          requestId: 'r-mcs',
          kind: 'approval',
          scope: { kind: 'group', roomId: 'g1' },
          waitingReason: 'approval',
          status: 'open',
          arrivalSeq: 1,
          createdAtMs: 1,
          rpcId: 'r-mcs',
          socketGeneration: 1,
          origin: 'live_ws',
          protocol: 'classic',
          choices: ['once'],
        }],
        backgroundWaitingSummaries: [{
          scopeKey: 'session:s-fb',
          entityType: 'session',
          entityId: 's-fb',
          scope: { kind: 'session', storedSessionId: 's-fb', liveSessionId: null, profile: 'default' },
          waitingReason: 'clarify',
          promptCount: 1,
          earliestArrivalSeq: 1,
        }],
        availableModels: [],
        modelDetails: [],
        attachments: [],
        dockNotice: 'warn notice',
        sideAgentCapsules: [],
        rollbackBanner: null,
        onSendMessage: () => {},
        onInterruptTurn: () => {},
        onOpenAttachmentPicker: () => {},
        onRemoveAttachment: () => {},
        onSelectModel: () => {},
        onReplyInteractive: async () => true,
        onSelectWaitingSummary: () => {},
        onLoadOlderMessages: () => {},
        onCopyMessage: () => {},
        onRollbackMessage: () => {},
        onForkMessage: () => {},
        onOpenFile: () => {},
        onDownloadMedia: () => {},
        onOpenSettings: () => {},
      }),
    );

    // 2c. MobileConversationScreen without onSelectWaitingSummary / onReplyInteractive + synced pill + sideAgentCapsules
    const screenD3 = createHookDriver({ style: { setProperty() {} } });
    const m3 = screenD3.mount(() =>
      React.createElement(MobileConversationScreen, {
        gatewayConnected: false,
        connectionPhase: 'synced',
        activeFocus: { type: 'bot', botName: 'b1' },
        agentPresence: { kind: 'thinking', text: 'Working' },
        botRoster: [],
        messages: [],
        messagesCount: 0,
        hasOlderMessages: false,
        isLoadingOlder: false,
        isStreaming: false,
        selectedModel: 'auto',
        approvalMode: 'manual',
        interactivePrompts: [{
          canonicalKey: 'k-mcs-nohandler',
          requestId: 'r-mcs-nohandler',
          kind: 'approval',
          scope: { kind: 'session', storedSessionId: 's-mcs', liveSessionId: null, profile: 'b1' },
          waitingReason: 'approval',
          status: 'open',
          arrivalSeq: 1,
          createdAtMs: 1,
          rpcId: 'r-mcs-nohandler',
          socketGeneration: 1,
          origin: 'live_ws',
          protocol: 'classic',
          choices: ['once'],
        }],
        backgroundWaitingSummaries: [{
          scopeKey: 'session:s-fb2',
          entityType: 'session',
          entityId: 's-fb2',
          scope: { kind: 'session', storedSessionId: 's-fb2', liveSessionId: null, profile: 'b1' },
          waitingReason: 'clarify',
          promptCount: 1,
          earliestArrivalSeq: 1,
        }],
        availableModels: [],
        modelDetails: [],
        attachments: [],
        dockNotice: '',
        sideAgentCapsules: [
          { id: 'c1', profile: 'helper', status: 'done', answer: 'done ans', question: 'q1' },
          { id: 'c2', profile: 'helper', status: 'running', answer: '', question: 'q2' },
        ],
        rollbackBanner: null,
        onSendMessage: () => {},
        onInterruptTurn: () => {},
        onOpenAttachmentPicker: () => {},
        onRemoveAttachment: () => {},
        onSelectModel: () => {},
        onLoadOlderMessages: () => {},
        onCopyMessage: () => {},
        onRollbackMessage: () => {},
        onForkMessage: () => {},
        onOpenFile: () => {},
        onDownloadMedia: () => {},
        onOpenSettings: () => {},
      }),
    );
    // Fire onScroll for compactPresence=true AND rerender so pillMounted=true propagates
    const streamNode3 = findAll(m3.tree, (n) => n?.props?.id === 'conversation-stream' && typeof n?.props?.onScroll === 'function')[0];
    streamNode3.props.onScroll({ currentTarget: { scrollHeight: 2000, scrollTop: 0, clientHeight: 500 } });
    m3.rerender();
    assert.equal(findAll(m3.tree, (n) => n?.props?.id === 'react-conv-presence-host')[0]?.props?.['data-replaced'], 'true');
    m3.unmount();

    // 2d. MobileConversationScreen with connectionPhase=undefined -> showOfflineCard=true & pill : null (L232, L260)
    const screenD4 = createHookDriver({ style: { setProperty() {} } });
    const m4 = screenD4.mount(() =>
      React.createElement(MobileConversationScreen, {
        gatewayConnected: false,
        connectionPhase: undefined,
        activeFocus: { type: 'bot', botName: 'b1' },
        agentPresence: { kind: 'idle', text: '' },
        botRoster: [],
        messages: [],
        messagesCount: 0,
        hasOlderMessages: false,
        isLoadingOlder: false,
        isStreaming: false,
        selectedModel: 'auto',
        approvalMode: 'manual',
        availableModels: [],
        modelDetails: [],
        attachments: [],
        dockNotice: '',
        sideAgentCapsules: [],
        rollbackBanner: null,
        onSendMessage: () => {},
        onInterruptTurn: () => {},
        onOpenAttachmentPicker: () => {},
        onRemoveAttachment: () => {},
        onSelectModel: () => {},
        onLoadOlderMessages: () => {},
        onCopyMessage: () => {},
        onRollbackMessage: () => {},
        onForkMessage: () => {},
        onOpenFile: () => {},
        onDownloadMedia: () => {},
        onOpenSettings: () => {},
      }),
    );
    m4.unmount();

    // 3. MobileHomeScreen waiting banner without custom resolver
    const homeModel = buildMobileHomeModel({
      profiles: [{ name: 'b1', displayName: 'B1', isDefault: true }],
      groups: [],
      sessions: [],
      collapsed: { bots: false, groups: false, sessions: false },
      activeFocus: { type: 'bot', botName: 'b1' },
      searchQuery: '',
    });
    let pickedWait = null;
    const homeMount = d.mount(() =>
      React.createElement(MobileHomeScreen, {
        homeTab: 'chats',
        model: homeModel,
        allProfiles: [{ name: 'b1', displayName: 'B1', isDefault: true }],
        groupAvatars: [{ name: 'b1', displayName: 'B1', isDefault: true }],
        activeBotName: 'b1',
        gatewayConnected: true,
        gatewayConnecting: false,
        connectionPhase: 'connected',
        searchOpen: false,
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
          bots: [],
          scopedProfile: 'b1',
          profiles: { status: 'ready', data: [] },
          botManagement: { status: { status: 'editing', activeBotId: 'b1' }, activeBotId: 'b1', roster: [], activeDetail: null, availableModels: [], isBusy: false, wizard: { open: false, busy: false, draft: { mode: 'blank', name: '', displayName: '', description: '', model: '', provider: '', cloneFrom: '', cloneChannels: true, mirrorCredentials: true } }, exitPrompt: null },
          providerAdminBusy: false,
          mcp: { status: 'ready', data: [] },
          skills: { status: 'ready', data: [] },
          gateway: { url: '', username: '', hasStoredPassword: false, profileName: 'b1', latencyMs: 0, status: 'connected' },
          appVersion: '0.1.0',
          platform: 'android',
          busy: false,
        },
        modelDetails: [],
        backgroundWaitingSummaries: [{
          scopeKey: 'session:s-wait',
          entityType: 'session',
          entityId: 's-wait',
          scope: { kind: 'session', storedSessionId: 's-wait', liveSessionId: null, profile: 'default' },
          waitingReason: 'approval',
          promptCount: 1,
          earliestArrivalSeq: 1,
        }],
        onSelectWaitingSummary: (s) => { pickedWait = s; },
        onSelectHomeTab: () => {},
        onSelectBotSubpage: () => {},
        onOpenNewChat: () => {},
        onOpenSearch: () => {},
        onCloseSearch: () => {},
        onSearchChange: () => {},
        onToggleSection: () => {},
        onSelectBot: () => {},
        onSelectGroup: () => {},
        onSelectSession: () => {},
        onOpenActionSheet: () => {},
        onOpenSettings: () => {},
        onOpenSettingsGateway: () => {},
        onToggleContainer: () => {},
        onToggleDoneSection: () => {},
        onRetryDoneSection: () => {},
        settingsActions: { onNotify: () => {} },
      }),
    );
    findByTestId(homeMount.tree, 'mobile-home-waiting-banner').props.onClick();
    assert.equal(pickedWait.entityId, 's-wait');

    // 4. MobileMorphingComposer draftOverride, approvalMode variants, approval pill click
    let openedApprovalSheet = 0;
    let draft = { text: 'v1', version: 1 };
    let mode = 'off';
    const compD = createHookDriver({ style: {}, focus() {}, setSelectionRange() {} });
    const compMount = compD.mount(() =>
      React.createElement(MobileMorphingComposer, {
        inputId: 'm-comp',
        placeholder: 'Ask',
        isStreaming: false,
        disabled: false,
        selectedModel: 'gpt',
        approvalMode: mode,
        availableModels: ['gpt'],
        modelDetails: [],
        attachments: [],
        draftOverride: draft,
        onSend: () => {},
        onAttach: () => {},
        onRemoveAttachment: () => {},
        onSelectModel: () => {},
        onOpenApprovalSheet: () => { openedApprovalSheet += 1; },
      }),
    );
    draft = { text: 'v1', version: 1 }; // same version -> early return
    mode = 'smart';
    compMount.rerender();
    findByTestId(compMount.tree, 'mobile-composer-approval-pill').props.onClick();
    assert.equal(openedApprovalSheet, 1);

    // hideApprovalMode=true & onOpenApprovalSheet omitted (L394/402)
    const compD2 = createHookDriver({ style: {}, focus() {}, setSelectionRange() {} });
    const compHidden = compD2.mount(() =>
      React.createElement(MobileMorphingComposer, {
        inputId: 'm-comp-h',
        placeholder: 'Ask',
        isStreaming: false,
        disabled: false,
        selectedModel: 'gpt',
        approvalMode: 'manual',
        hideApprovalMode: true,
        availableModels: ['gpt'],
        modelDetails: [],
        attachments: [],
        onSend: () => {},
        onSelectModel: () => {},
      }),
    );
    assert.equal(findByTestId(compHidden.tree, 'mobile-composer-approval-pill'), null);

    // hideApprovalMode=false & onOpenApprovalSheet omitted -> hits L402 short-circuit false branch
    const compD3 = createHookDriver({ style: {}, focus() {}, setSelectionRange() {} });
    const compNoSheet = compD3.mount(() =>
      React.createElement(MobileMorphingComposer, {
        inputId: 'm-comp-ns',
        placeholder: 'Ask',
        isStreaming: false,
        disabled: false,
        selectedModel: 'gpt',
        approvalMode: 'manual',
        hideApprovalMode: false,
        availableModels: ['gpt'],
        modelDetails: [],
        attachments: [],
        onSend: () => {},
        onSelectModel: () => {},
      }),
    );
    assert.equal(findByTestId(compNoSheet.tree, 'mobile-composer-approval-pill'), null);

    // isStreaming=true with and without onStop while collapsed -> covers L344 -> L402
    const compD4 = createHookDriver({ style: {}, focus() {}, setSelectionRange() {} });
    compD4.mount(() =>
      React.createElement(MobileMorphingComposer, {
        inputId: 'm-comp-st1',
        placeholder: 'Ask',
        isStreaming: true,
        disabled: false,
        selectedModel: 'gpt',
        approvalMode: 'manual',
        hideApprovalMode: false,
        availableModels: ['gpt'],
        modelDetails: [],
        attachments: [],
        onSend: () => {},
        onStop: () => {},
        onSelectModel: () => {},
      }),
    );
    const compD5 = createHookDriver({ style: {}, focus() {}, setSelectionRange() {} });
    compD5.mount(() =>
      React.createElement(MobileMorphingComposer, {
        inputId: 'm-comp-st2',
        placeholder: 'Ask',
        isStreaming: true,
        disabled: false,
        selectedModel: 'gpt',
        approvalMode: 'manual',
        hideApprovalMode: false,
        availableModels: ['gpt'],
        modelDetails: [],
        attachments: [],
        onSend: () => {},
        onSelectModel: () => {},
      }),
    );
  } finally {
    globalThis.ResizeObserver = prevRO;
  }
});

test('MobileWorkspaceShell resolveWaitingEntityLabel 全分支与 hermes-back interactive dock 折叠', () => {
  setLocale('zh-CN');
  const prevWin = globalThis.window;
  const winListeners = new Map();
  globalThis.window = {
    innerWidth: 390,
    addEventListener: (ev, cb) => {
      const arr = winListeners.get(ev) || [];
      arr.push(cb);
      winListeners.set(ev, arr);
    },
    removeEventListener: (ev, cb) => {
      const arr = winListeners.get(ev);
      if (arr) winListeners.set(ev, arr.filter((x) => x !== cb));
    },
  };

  try {
    const homeModel = buildMobileHomeModel({
      profiles: [
        { name: 'bot-a', displayName: 'Bot Alpha', isDefault: true },
        { name: 'bot-nodisp', displayName: '', isDefault: false },
      ],
      groups: [
        { roomId: 'grp-top', name: 'Top Group', members: ['bot-a'] },
        { roomId: 'grp-proj', name: 'Proj Group', members: ['bot-a'], containerId: 'proj-1' },
      ],
      sessions: [
        { id: 'sess-top', title: 'Top Session', botName: 'bot-a', timestamp: 10 },
        { id: 'sess-proj', title: 'Proj Session', botName: 'bot-a', timestamp: 9, containerId: 'proj-1' },
      ],
      projects: [{ id: 'proj-1', name: 'P1', path: '/p1' }],
      assignments: { 'grp:grp-proj': 'prj:proj-1', 'sess:sess-proj': 'prj:proj-1' },
      collapsed: { bots: false, groups: false, sessions: false },
      activeFocus: { type: 'session', sessionId: 'sess-top' },
      searchQuery: '',
    });
    homeModel.projectSections[0].items.push(
      { kind: 'group', id: 'grp-proj-only', title: 'Proj Group Only', members: [] },
      { kind: 'group', id: 'grp-empty-title', title: '', members: [] },
      { kind: 'session', id: 'sess-proj-only', title: 'Proj Session Only', timestamp: 1 },
      { kind: 'session', id: 'sess-empty-title', title: '', timestamp: 1 },
    );

    const d = createHookDriver({ style: {} });
    const toggledDock = [];
    const selectedSumm = [];
    const samplePrompt = {
      canonicalKey: 'k-cl-mob',
      requestId: 'r-cl-mob',
      kind: 'clarify',
      scope: { kind: 'session', storedSessionId: 'sess-top', liveSessionId: 'lv-top', profile: 'bot-a' },
      waitingReason: 'clarify',
      status: 'open',
      arrivalSeq: 1,
      createdAtMs: 1,
      rpcId: 'r-cl-mob',
      socketGeneration: 1,
      origin: 'live_ws',
      protocol: 'classic',
      questions: [{ qid: 'q0', question: 'Q?', choices: ['Yes', 'No'] }],
      lockedAnswers: {},
    };
    const settingsSnapshot = {
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
      bots: [{ profile: 'bot-a', displayName: 'Bot Alpha', avatar: '' }],
      scopedProfile: 'bot-a',
      profiles: { status: 'ready', data: [{ name: 'bot-a', displayName: 'Bot Alpha', isDefault: true }] },
      botManagement: {
        status: { status: 'editing', activeBotId: 'bot-a' },
        activeBotId: 'bot-a',
        roster: [],
        activeDetail: null,
        availableModels: [],
        isBusy: false,
        wizard: { open: false, busy: false, draft: { mode: 'blank', name: '', displayName: '', description: '', model: '', provider: '', cloneFrom: '', cloneChannels: true, mirrorCredentials: true } },
        exitPrompt: null,
      },
      providerAdminBusy: false,
      mcp: { status: 'ready', data: [] },
      skills: { status: 'ready', data: [] },
      gateway: { url: 'http://127.0.0.1:8080', username: '', hasStoredPassword: false, profileName: 'bot-a', latencyMs: 1, status: 'connected' },
      appVersion: '0.1.0',
      platform: 'android',
      busy: false,
    };
    let promptsForShell = [];
    const summaryCases = [
      [{ scopeKey: 'bot:bot-a', entityType: 'bot', entityId: 'bot-a', scope: { kind: 'session', storedSessionId: 'sb', liveSessionId: null, profile: 'bot-a' }, waitingReason: 'clarify', promptCount: 1, earliestArrivalSeq: 1 }, 'Bot Alpha'],
      [{ scopeKey: 'bot:bot-nodisp', entityType: 'bot', entityId: 'bot-nodisp', scope: { kind: 'session', storedSessionId: 'sbn', liveSessionId: null, profile: 'bot-nodisp' }, waitingReason: 'clarify', promptCount: 1, earliestArrivalSeq: 1.5 }, 'bot-nodisp'],
      [{ scopeKey: 'bot:bot-miss', entityType: 'bot', entityId: 'bot-miss', scope: { kind: 'session', storedSessionId: 'sbm', liveSessionId: null, profile: 'bot-miss' }, waitingReason: 'clarify', promptCount: 1, earliestArrivalSeq: 2 }, 'bot-miss'],
      [{ scopeKey: 'group:grp-top', entityType: 'group', entityId: 'grp-top', scope: { kind: 'group', roomId: 'grp-top' }, waitingReason: 'approval', promptCount: 1, earliestArrivalSeq: 3 }, 'Top Group'],
      [{ scopeKey: 'group:grp-proj', entityType: 'group', entityId: 'grp-proj', scope: { kind: 'group', roomId: 'grp-proj' }, waitingReason: 'approval', promptCount: 1, earliestArrivalSeq: 4 }, 'Proj Group'],
      [{ scopeKey: 'group:grp-proj-only', entityType: 'group', entityId: 'grp-proj-only', scope: { kind: 'group', roomId: 'grp-proj-only' }, waitingReason: 'approval', promptCount: 1, earliestArrivalSeq: 4.2 }, 'Proj Group Only'],
      [{ scopeKey: 'group:grp-empty-title', entityType: 'group', entityId: 'grp-empty-title', scope: { kind: 'group', roomId: 'grp-empty-title' }, waitingReason: 'approval', promptCount: 1, earliestArrivalSeq: 4.5 }, 'grp-empty-title'],
      [{ scopeKey: 'group:grp-miss', entityType: 'group', entityId: 'grp-miss', scope: { kind: 'group', roomId: 'grp-miss' }, waitingReason: 'approval', promptCount: 1, earliestArrivalSeq: 5 }, 'grp-miss'],
      [{ scopeKey: 'session:sess-top', entityType: 'session', entityId: 'sess-top', scope: { kind: 'session', storedSessionId: 'sess-top', liveSessionId: null, profile: 'bot-a' }, waitingReason: 'approval', promptCount: 1, earliestArrivalSeq: 6 }, 'Top Session'],
      [{ scopeKey: 'session:sess-proj', entityType: 'session', entityId: 'sess-proj', scope: { kind: 'session', storedSessionId: 'sess-proj', liveSessionId: null, profile: 'bot-a' }, waitingReason: 'approval', promptCount: 1, earliestArrivalSeq: 7 }, 'Proj Session'],
      [{ scopeKey: 'session:sess-proj-only', entityType: 'session', entityId: 'sess-proj-only', scope: { kind: 'session', storedSessionId: 'sess-proj-only', liveSessionId: null, profile: 'bot-a' }, waitingReason: 'approval', promptCount: 1, earliestArrivalSeq: 7.2 }, 'Proj Session Only'],
      [{ scopeKey: 'session:sess-empty-title', entityType: 'session', entityId: 'sess-empty-title', scope: { kind: 'session', storedSessionId: 'sess-empty-title', liveSessionId: null, profile: 'bot-a' }, waitingReason: 'approval', promptCount: 1, earliestArrivalSeq: 7.5 }, 'sess-empty-title'],
      [{ scopeKey: 'session:sess-miss', entityType: 'session', entityId: 'sess-miss', scope: { kind: 'session', storedSessionId: 'sess-miss', liveSessionId: null, profile: 'bot-a' }, waitingReason: 'approval', promptCount: 1, earliestArrivalSeq: 8 }, 'sess-miss'],
    ];
    let summariesForShell = [summaryCases[0][0]];
    const shellMount = d.mount(() =>
      React.createElement(MobileWorkspaceShell, {
        snapshot: {
          activePane: 'stage',
          homeTab: 'chats',
          searchOpen: false,
          searchQuery: '',
          newChatOpen: false,
          newChatStep: 'compose',
          settingsOpen: false,
          settingsSubpage: null,
          botSubpage: null,
          inspectorReaderOpen: false,
          inspectorReaderItem: null,
          inspectorTab: 'artifacts',
          gatewayConnected: true,
          gatewayConnecting: false,
          connectionPhase: 'connected',
          activeFocus: { type: 'session', sessionId: 'sess-top' },
          homeModel,
          allProfiles: [
            { name: 'bot-a', displayName: 'Bot Alpha' },
            { name: 'bot-nodisp', displayName: '' },
          ],
          groupAvatars: [{ name: 'bot-a', displayName: 'Bot Alpha' }],
          activeBotName: 'bot-a',
          activeBotDisplayName: 'Bot Alpha',
          allProjects: [{ id: 'proj-1', name: 'P1', path: '/p1' }],
          agentPresence: { kind: 'idle', text: '' },
          messages: [],
          messagesCount: 0,
          hasOlderMessages: false,
          isLoadingOlder: false,
          isStreaming: false,
          selectedModel: 'auto',
          approvalMode: 'manual',
          availableModels: [],
          modelDetails: [],
          attachments: [],
          dockNotice: '',
          sideAgentCapsules: [],
          artifacts: [],
          gitDiffs: [],
          memories: [],
          fileTreeState: { status: 'idle', entries: [] },
          fileTreeExpandedPaths: [],
          fileTreeFilterQuery: '',
          openFiles: [],
          activeFilePath: '',
          workspaceRootName: 'repo',
          learningState: { status: 'idle' },
          learningDetail: { status: 'idle' },
          groupMembers: [],
          subagentSheet: null,
          actionSheet: null,
          settingsSnapshot,
          interactivePrompts: promptsForShell,
          interactiveDockCollapsed: false,
          get backgroundWaitingSummaries() {
            return summariesForShell;
          },
        },
        actions: {
          onSelectPane: () => {},
          onSelectHomeTab: () => {},
          onOpenNewChat: () => {},
          onCloseNewChat: () => {},
          onSetNewChatStep: () => {},
          onCreateSoloChat: async () => {},
          onCreateGroupChat: async () => {},
          onOpenSearch: () => {},
          onCloseSearch: () => {},
          onSearchChange: () => {},
          onToggleSection: () => {},
          onSelectBot: () => {},
          onSelectGroup: () => {},
          onSelectSession: () => {},
          onOpenEntityMenu: () => {},
          onCloseActionSheet: () => {},
          onPerformEntityAction: async () => {},
          onToggleContainer: () => {},
          onNewChatInContainer: () => {},
          onRetryDoneSection: () => {},
          onOpenSettings: () => {},
          onCloseSettings: () => {},
          onSelectSettingsSubpage: () => {},
          onSelectBotSubpage: () => {},
          onOpenConnect: () => {},
          onSendMessage: () => {},
          onInterruptTurn: () => {},
          onOpenAttachmentPicker: () => {},
          onRemoveAttachment: () => {},
          onSelectModel: () => {},
          onSelectApprovalMode: () => {},
          onLoadOlderMessages: () => {},
          onCopyMessage: () => {},
          onRollbackMessage: () => {},
          onForkMessage: () => {},
          onOpenFile: () => {},
          onDownloadMedia: () => {},
          onCloseSubagentSheet: () => {},
          onSelectInspectorTab: () => {},
          onToggleFileDir: () => {},
          onSetFileFilterQuery: () => {},
          onOpenInspectorFile: () => {},
          onCloseInspectorReader: () => {},
          onToggleInteractiveDockCollapsed: (v) => toggledDock.push(v),
          onSelectWaitingSummary: (s) => selectedSumm.push(s.entityId),
          settingsActions: {
            onNotify: () => {},
            onCloseBotWizard: () => {},
          },
        },
      }),
    );

    const pill = findByTestId(shellMount.tree, 'interactive-background-top-pill');
    assert.ok(pill);
    assert.match(JSON.stringify(pill.props), /Bot Alpha/);
    const homeBanner = findByTestId(shellMount.tree, 'mobile-home-waiting-banner');
    assert.ok(homeBanner);

    // Traverse every entityType & container fallback through live rerenders
    for (const [summary, expected] of summaryCases) {
      summariesForShell = [summary];
      shellMount.rerender();
      const curPill = findByTestId(shellMount.tree, 'interactive-background-top-pill');
      const curBanner = findByTestId(shellMount.tree, 'mobile-home-waiting-banner');
      assert.ok(JSON.stringify(curPill.props).includes(expected));
      assert.ok(JSON.stringify(curBanner.props).includes(expected));
    }

    // Open approval sheet -> hermes-mobile-back closes approval sheet
    findByTestId(shellMount.tree, 'mobile-composer-approval-pill').props.onClick();
    shellMount.rerender();
    for (const cb of winListeners.get('hermes-mobile-back') || []) {
      cb({ preventDefault() {} });
    }
    shellMount.rerender();

    // Non-empty expanded interactive dock -> hermes-mobile-back collapses dock
    promptsForShell = [samplePrompt];
    shellMount.rerender();
    for (const cb of winListeners.get('hermes-mobile-back') || []) {
      cb({ preventDefault() {} });
    }
    assert.deepEqual(toggledDock, [true]);

    shellMount.unmount();
  } finally {
    globalThis.window = prevWin;
  }
});
