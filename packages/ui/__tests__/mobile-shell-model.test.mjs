/**
 * 移动端表现壳 ViewModel 与纯状态机单元测试 + 形式化不变量证明
 * (packages/ui/__tests__/mobile-shell-model.test.mjs)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';

import { setLocale } from '../dist/i18n/index.js';
import {
  DEFAULT_MOBILE_SECTIONS_COLLAPSED,
  MOBILE_BOT_CAROUSEL_STEP_PX,
  MOBILE_PANE_ORDER,
  buildBotCarouselWindow,
  buildMobileHomeModel,
  buildMobileModelPickerItems,
  computeBotCarouselDragOffset,
  computeBotCarouselSlotVisual,
  computeSwipeMove,
  inferMobileAppearanceFromTheme,
  paneIndexOf,
  parseSubagentToolArgs,
  reduceMobileBackAction,
  resolveBotCarouselScrollIndex,
  resolveMobileSkinId,
  resolveNearestBotIndex,
  resolveShortModelName,
  resolveSwipeReleaseEndX,
  resolveTrackTransform,
  resolveWorkspaceShellMode,
  settleBotCarouselSwipe,
  settleSwipeRelease,
  shouldCompactStagePresence,
} from '../dist/components-react/mobile/mobileShellModel.js';

const NOW_MS = Date.UTC(2026, 10, 21, 10, 0, 0);

test('resolveWorkspaceShellMode 裁决移动端与桌面端表现壳模式', () => {
  assert.equal(resolveWorkspaceShellMode({ platform: 'android' }), 'mobile');
  assert.equal(resolveWorkspaceShellMode({ platform: 'ANDROID' }), 'mobile');
  assert.equal(resolveWorkspaceShellMode({ platform: 'ios' }), 'mobile');
  assert.equal(resolveWorkspaceShellMode({ platform: 'web', hasMobileBridge: true }), 'mobile');
  assert.equal(resolveWorkspaceShellMode({ platform: 'windows' }), 'desktop');
  assert.equal(resolveWorkspaceShellMode({ platform: 'macos' }), 'desktop');
  assert.equal(resolveWorkspaceShellMode({ platform: '' }), 'desktop');

  // URL 查询参数 `?shell=...` 拥有最高优先级（有无前导 ? 均应生效）
  assert.equal(resolveWorkspaceShellMode({ platform: 'windows', search: '?shell=mobile' }), 'mobile');
  assert.equal(resolveWorkspaceShellMode({ platform: 'windows', search: 'shell=mobile' }), 'mobile');
  assert.equal(
    resolveWorkspaceShellMode({ platform: 'android', hasMobileBridge: true, search: '?shell=desktop' }),
    'desktop',
  );
  assert.equal(resolveWorkspaceShellMode({ platform: 'windows', search: '?foo=bar' }), 'desktop');

  // URLSearchParams 解析异常时安全回落平台判定
  const origUSP = globalThis.URLSearchParams;
  globalThis.URLSearchParams = function Broken() {
    throw new Error('bad query');
  };
  try {
    assert.equal(resolveWorkspaceShellMode({ platform: 'ios', search: '?shell=desktop' }), 'mobile');
  } finally {
    globalThis.URLSearchParams = origUSP;
  }
});

test('移动端双皮肤极性推演与 resolveMobileSkinId 映射', () => {
  assert.equal(inferMobileAppearanceFromTheme('jade-white'), 'light');
  assert.equal(inferMobileAppearanceFromTheme('ayu-light'), 'light');
  assert.equal(inferMobileAppearanceFromTheme('warm-paper'), 'light');
  assert.equal(inferMobileAppearanceFromTheme('obsidian-gold'), 'dark');
  assert.equal(inferMobileAppearanceFromTheme('midnight'), 'dark');
  assert.equal(inferMobileAppearanceFromTheme('unknown-skin'), 'dark');
  assert.equal(inferMobileAppearanceFromTheme(''), 'dark');
  assert.equal(inferMobileAppearanceFromTheme(undefined), 'dark');

  assert.equal(resolveMobileSkinId('light', true), 'jade-white');
  assert.equal(resolveMobileSkinId('dark', false), 'obsidian-gold');
  assert.equal(resolveMobileSkinId('system', true), 'obsidian-gold');
  assert.equal(resolveMobileSkinId('system', false), 'jade-white');
});

test('buildBotCarouselWindow 对称窗口裁决（0/1/2/3+ 个 Bot 及大小写/缺失回退）', () => {
  assert.deepEqual(buildBotCarouselWindow([], 'default'), {
    activeIndex: -1,
    current: null,
    prev: null,
    next: null,
    total: 0,
  });

  const one = [{ id: 'solo' }];
  assert.deepEqual(buildBotCarouselWindow(one, 'solo'), {
    activeIndex: 0,
    current: one[0],
    prev: null,
    next: null,
    total: 1,
  });

  const two = [{ id: 'alpha' }, { id: 'beta' }];
  assert.deepEqual(buildBotCarouselWindow(two, 'alpha'), {
    activeIndex: 0,
    current: two[0],
    prev: null,
    next: two[1],
    total: 2,
  });
  assert.deepEqual(buildBotCarouselWindow(two, 'BETA'), {
    activeIndex: 1,
    current: two[1],
    prev: two[0],
    next: null,
    total: 2,
  });

  const three = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.deepEqual(buildBotCarouselWindow(three, 'a'), {
    activeIndex: 0,
    current: three[0],
    prev: three[2],
    next: three[1],
    total: 3,
  });
  assert.deepEqual(buildBotCarouselWindow(three, 'b'), {
    activeIndex: 1,
    current: three[1],
    prev: three[0],
    next: three[2],
    total: 3,
  });
  assert.deepEqual(buildBotCarouselWindow(three, 'missing'), {
    activeIndex: 0,
    current: three[0],
    prev: three[2],
    next: three[1],
    total: 3,
  });
  assert.deepEqual(buildBotCarouselWindow(three, ''), {
    activeIndex: 0,
    current: three[0],
    prev: three[2],
    next: three[1],
    total: 3,
  });
});

test('buildMobileHomeModel 构建全量三段视图：无数量/普通会话标题无动画/头像继承归属 Bot', () => {
  setLocale('zh-CN');

  const model = buildMobileHomeModel({
    activeSessionId: 's-1',
    profiles: [
      {
        name: 'arch',
        displayName: '架构师',
        description: '设计架构',
        avatar: 'https://img.example/arch.png',
        lastMessage: '### 架构方案\n好的，已完成设计',
        timestamp: NOW_MS - 1000,
        activityState: 'unread',
        activityTransition: 'complete',
      },
      {
        name: 'default',
        displayName: '默认中枢',
        isDefault: true,
        avatar: 'https://img.example/default.png',
        lastTime: '09:50',
        timestamp: NOW_MS - 5000,
        activityState: 'running',
        activityTransition: 'start',
      },
      {
        name: 'ops',
        displayName: '运维官',
        description: '守护线上环境',
        timestamp: NOW_MS - 4000,
        activityState: 'read',
      },
      {
        name: 'alpha',
        displayName: '阿尔法',
        timestamp: NOW_MS - 5000,
      },
      {
        name: 'beta',
        timestamp: NOW_MS - 5000,
      },
      {
        name: 'zeta',
        timestamp: NOW_MS - 5000,
      },
    ],
    groups: [
      {
        roomId: 'g-1',
        name: '架构评审群',
        members: ['default', 'arch'],
        lastMessage: '讨论方案',
        updatedAt: NOW_MS - 2000,
        activityState: 'running',
      },
      {
        roomId: 'g-2',
        name: '值班群',
        members: [],
        createdAt: NOW_MS - 4000,
        activityState: 'unread',
      },
      {
        roomId: 'g-3',
        name: '',
      },
    ],
    sessions: [
      {
        id: 's-arch',
        title: '归档会话',
        botName: 'arch',
        isArchived: true,
        timestamp: NOW_MS,
      },
      {
        id: 's-1',
        title: '普通会话1',
        botName: 'arch',
        preview: '排查报错',
        timestamp: NOW_MS - 3000,
        activityState: 'running',
      },
      {
        id: 's-pinned',
        title: '置顶会话',
        botName: 'ops',
        botAvatar: 'https://img.example/ops-fallback.png',
        preview: '重要上下文',
        isPinned: true,
        time: '09:00',
        timestamp: NOW_MS - 9000,
        activityState: 'read',
      },
      {
        id: 's-orphan',
        title: '无归属会话',
        preview: '回落默认 Bot',
        timestamp: NOW_MS - 6000,
        activityState: 'unread',
      },
    ],
    profileName: 'default',
    searchQuery: '',
    collapsed: { bots: true, groups: true, sessions: true },
    profilesPhase: 'ready',
    sessionsPhase: 'ready',
    nowMs: NOW_MS,
  });

  // default 置顶排序第一，随后按时间/字母序
  assert.equal(model.botsSection.items[0].id, 'default');
  assert.equal(model.botsSection.items[0].isDefault, true);
  assert.equal(model.botsSection.items[0].statusTextKey, 'mobile.status.thinking');
  assert.equal(model.botsSection.items[1].id, 'arch');
  assert.equal(model.botsSection.items[1].statusTextKey, 'mobile.status.unread');
  assert.equal(model.botsSection.items[1].subtitle, '架构方案 好的，已完成设计');
  assert.equal(model.botsSection.items[2].id, 'ops');
  assert.equal(model.botsSection.items[2].statusTextKey, null);
  assert.equal(model.botsSection.items[2].subtitle, '守护线上环境');

  // 折叠且有 running 时，仅智能体与群聊大标题出现状态；普通会话大标题恒为 null
  assert.deepEqual(model.botsSection.headerStatus, { state: 'running', statusTextKey: 'mobile.status.thinking' });
  assert.deepEqual(model.groupsSection.headerStatus, { state: 'running', statusTextKey: 'mobile.status.collaborating' });
  assert.equal(model.sessionsSection.headerStatus, null);

  // 普通会话过滤掉已归档、置顶排最前，并强制继承归属 Bot 头像
  assert.deepEqual(
    model.sessionsSection.items.map((row) => row.id),
    ['s-pinned', 's-1', 's-orphan'],
  );
  assert.equal(model.sessionsSection.items[0].ownerAvatarUrl, 'https://img.example/ops-fallback.png');
  assert.equal(model.sessionsSection.items[0].isPinned, true);
  assert.equal(model.sessionsSection.items[1].ownerAvatarUrl, 'https://img.example/arch.png');
  assert.equal(model.sessionsSection.items[1].ownerBotDisplayName, '架构师');
  assert.equal(model.sessionsSection.items[1].isActive, true);
  assert.equal(model.sessionsSection.items[1].statusTextKey, 'mobile.status.executing');
  assert.equal(model.sessionsSection.items[2].ownerAvatarUrl, 'https://img.example/default.png');
  assert.equal(model.sessionsSection.items[2].statusTextKey, 'mobile.status.unread');
  assert.equal(model.hasAnyResult, true);

  // 搜索态强制展开命中的分区但不改写原始 collapsed 状态
  const searched = buildMobileHomeModel({
    activeSessionId: '',
    activeFocus: { type: 'group', roomId: 'g-1' },
    profiles: [{ name: 'default', displayName: '默认中枢' }],
    groups: [
      { roomId: 'g-1', name: '架构评审群', members: ['default'] },
      { roomId: 'g-empty', name: '' },
    ],
    sessions: [{ id: 's-1', title: '普通', botName: 'missing' }],
    profileName: 'default',
    searchQuery: '评审',
    collapsed: { ...DEFAULT_MOBILE_SECTIONS_COLLAPSED, groups: true, bots: true, sessions: true },
    nowMs: NOW_MS,
  });
  assert.equal(searched.isSearching, true);
  assert.equal(searched.groupsSection.isCollapsed, true);
  assert.equal(searched.groupsSection.effectiveExpanded, true);
  assert.equal(searched.groupsSection.items[0].isActive, true);
  assert.equal(searched.botsSection.effectiveExpanded, false);

  // 无 `nowMs` 时回落当前系统时钟
  const liveClockModel = buildMobileHomeModel({
    activeSessionId: '',
    profiles: [],
    groups: [],
    sessions: [],
    profileName: 'default',
    searchQuery: '',
    collapsed: DEFAULT_MOBILE_SECTIONS_COLLAPSED,
  });
  assert.equal(liveClockModel.hasAnyResult, false);

  // 空 profiles / 无匹配搜索回退
  const emptySearch = buildMobileHomeModel({
    activeSessionId: '',
    profiles: [],
    groups: [],
    sessions: [{ id: 's-x', title: 'x', botName: '' }],
    profileName: '',
    searchQuery: '不存在的词条',
    collapsed: DEFAULT_MOBILE_SECTIONS_COLLAPSED,
    nowMs: NOW_MS,
  });
  assert.equal(emptySearch.hasAnyResult, false);

  // activeFocus 回退到 bot 形态
  const botFocusModel = buildMobileHomeModel({
    activeSessionId: '',
    profiles: [{ name: 'custom-bot' }],
    groups: [],
    sessions: [{ id: 's-2', title: '普通2', botName: '' }],
    profileName: 'custom-bot',
    searchQuery: '',
    collapsed: DEFAULT_MOBILE_SECTIONS_COLLAPSED,
    nowMs: NOW_MS,
  });
  assert.equal(botFocusModel.botsSection.items[0].isActive, true);
  assert.equal(botFocusModel.sessionsSection.items[0].ownerBotName, 'default');
  assert.equal(botFocusModel.sessionsSection.items[0].ownerAvatarUrl, undefined);
});

test('属性测试 (fast-check)：普通会话大标题恒无动画且归属头像永不丢失', () => {
  fc.assert(
    fc.property(
      fc.array(
        fc.record({
          id: fc.string({ minLength: 1, maxLength: 8 }),
          title: fc.string({ maxLength: 12 }),
          botName: fc.constantFrom('default', 'arch', 'ops'),
          activityState: fc.constantFrom('read', 'unread', 'running'),
          isPinned: fc.boolean(),
          isArchived: fc.boolean(),
        }),
        { maxLength: 12 },
      ),
      fc.boolean(),
      fc.boolean(),
      fc.boolean(),
      fc.string({ maxLength: 6 }),
      (sessions, botsCollapsed, groupsCollapsed, sessionsCollapsed, searchQuery) => {
        const profiles = [
          { name: 'default', displayName: '默认', isDefault: true, avatar: 'av://default', activityState: 'read' },
          { name: 'arch', displayName: '架构', avatar: 'av://arch', activityState: 'running' },
          { name: 'ops', displayName: '运维', activityState: 'read' },
        ];
        const m = buildMobileHomeModel({
          activeSessionId: '',
          profiles,
          groups: [{ roomId: 'g1', name: '群1', members: ['arch'], activityState: 'running' }],
          sessions,
          profileName: 'default',
          searchQuery,
          collapsed: { bots: botsCollapsed, groups: groupsCollapsed, sessions: sessionsCollapsed },
          nowMs: NOW_MS,
        });

        assert.equal(m.sessionsSection.headerStatus, null);
        assert.equal(
          Boolean(m.botsSection.headerStatus),
          botsCollapsed && m.botsSection.items.some((r) => r.activityState === 'running'),
        );
        assert.equal(
          Boolean(m.groupsSection.headerStatus),
          groupsCollapsed && m.groupsSection.items.some((r) => r.activityState === 'running'),
        );

        const avatarByBot = new Map(profiles.map((p) => [p.name, p.avatar]));
        for (const row of m.sessionsSection.items) {
          const expected = avatarByBot.get(row.ownerBotName);
          if (expected) {
            assert.equal(row.ownerAvatarUrl, expected);
          }
        }
      },
    ),
    { numRuns: 100 },
  );
});

test('reduceMobileBackAction 严格遵循 10 层硬件返回栈优先级队列', () => {
  const base = {
    activePane: 'home',
    hasActionSheet: false,
    hasModelSheet: false,
    hasSubagentSheet: false,
    newChatOpen: false,
    newChatStep: 'compose',
    searchOpen: false,
    settingsOpen: false,
    settingsSubpage: null,
    inspectorReaderOpen: false,
  };

  assert.deepEqual(
    reduceMobileBackAction({ ...base, hasActionSheet: true, hasModelSheet: true }),
    { handled: true, effect: 'closeActionSheet' },
  );
  assert.deepEqual(
    reduceMobileBackAction({ ...base, hasModelSheet: true, hasSubagentSheet: true }),
    { handled: true, effect: 'closeModelSheet' },
  );
  assert.deepEqual(
    reduceMobileBackAction({ ...base, hasSubagentSheet: true, newChatOpen: true }),
    { handled: true, effect: 'closeSubagentSheet' },
  );
  assert.deepEqual(
    reduceMobileBackAction({ ...base, newChatOpen: true, newChatStep: 'group-members' }),
    { handled: true, effect: 'newChatBackToCompose' },
  );
  assert.deepEqual(
    reduceMobileBackAction({ ...base, newChatOpen: true, newChatStep: 'compose' }),
    { handled: true, effect: 'closeNewChatSheet' },
  );
  assert.deepEqual(
    reduceMobileBackAction({ ...base, searchOpen: true, settingsOpen: true }),
    { handled: true, effect: 'closeSearch' },
  );
  assert.deepEqual(
    reduceMobileBackAction({ ...base, settingsOpen: true, settingsSubpage: 'gateway' }),
    { handled: true, effect: 'settingsBackToRoot' },
  );
  assert.deepEqual(
    reduceMobileBackAction({ ...base, settingsOpen: true, settingsSubpage: null }),
    { handled: true, effect: 'closeSettings' },
  );
  assert.deepEqual(
    reduceMobileBackAction({ ...base, activePane: 'inspector', inspectorReaderOpen: true }),
    { handled: true, effect: 'closeInspectorReader' },
  );
  assert.deepEqual(
    reduceMobileBackAction({ ...base, activePane: 'inspector', inspectorReaderOpen: false }),
    { handled: true, effect: 'navigatePane', nextPane: 'stage' },
  );
  assert.deepEqual(
    reduceMobileBackAction({ ...base, activePane: 'stage' }),
    { handled: true, effect: 'navigatePane', nextPane: 'home' },
  );
  assert.deepEqual(
    reduceMobileBackAction({ ...base, botWizardOpen: true, newChatOpen: true }),
    { handled: true, effect: 'closeBotWizard' },
  );
  assert.deepEqual(
    reduceMobileBackAction({ ...base, homeTab: 'bots', botSubpage: 'soul' }),
    { handled: true, effect: 'botBackToRoot' },
  );
  assert.deepEqual(
    reduceMobileBackAction({ ...base, homeTab: 'bots', botSubpage: null }),
    { handled: true, effect: 'switchHomeTab', nextTab: 'chats' },
  );
  assert.deepEqual(
    reduceMobileBackAction(base),
    { handled: false, effect: 'minimizeApp' },
  );
});

test('三屏手势物理状态机：方向锁定、边界阻尼与速度落定', () => {
  assert.deepEqual(MOBILE_PANE_ORDER, ['home', 'stage', 'inspector']);
  assert.equal(paneIndexOf('home'), 0);
  assert.equal(paneIndexOf('stage'), 1);
  assert.equal(paneIndexOf('inspector'), 2);
  assert.equal(paneIndexOf('unknown'), 0);

  // 未达 8px 死区
  assert.deepEqual(
    computeSwipeMove({ activePane: 'home', dx: 4, dy: -5, locked: 'none' }),
    { nextLocked: 'none', stopTracking: false, didLockHorizontal: false, dragOffsetPx: 0 },
  );
  // 纵向占优锁定列表滚动
  assert.deepEqual(
    computeSwipeMove({ activePane: 'home', dx: 2, dy: 20, locked: 'none' }),
    { nextLocked: 'vertical', stopTracking: true, didLockHorizontal: false, dragOffsetPx: 0 },
  );
  // 已锁纵向后不产生位移
  assert.deepEqual(
    computeSwipeMove({ activePane: 'stage', dx: 40, dy: 0, locked: 'vertical' }),
    { nextLocked: 'vertical', stopTracking: false, didLockHorizontal: false, dragOffsetPx: 0 },
  );
  // 左边缘与右边缘 0.28 橡皮筋阻尼
  const leftOver = computeSwipeMove({ activePane: 'home', dx: 100, dy: 0, locked: 'none' });
  assert.equal(leftOver.didLockHorizontal, true);
  assert.equal(leftOver.nextLocked, 'horizontal');
  assert.ok(Math.abs(leftOver.dragOffsetPx - 28) < 1e-6);

  const rightOver = computeSwipeMove({ activePane: 'inspector', dx: -100, dy: 0, locked: 'horizontal' });
  assert.equal(rightOver.didLockHorizontal, false);
  assert.ok(Math.abs(rightOver.dragOffsetPx + 28) < 1e-6);

  const stageFree = computeSwipeMove({ activePane: 'stage', dx: -60, dy: 5, locked: 'horizontal' });
  assert.equal(stageFree.dragOffsetPx, -60);

  // settleSwipeRelease 翻页裁决与边界夹紧
  assert.equal(settleSwipeRelease({ activePane: 'home', totalDx: -120, durationMs: 300, viewportWidth: 400 }), 'stage');
  assert.equal(settleSwipeRelease({ activePane: 'home', totalDx: -40, durationMs: 80, viewportWidth: 400 }), 'stage');
  assert.equal(settleSwipeRelease({ activePane: 'stage', totalDx: 150, durationMs: 400, viewportWidth: 400 }), 'home');
  assert.equal(settleSwipeRelease({ activePane: 'stage', totalDx: 50, durationMs: 100, viewportWidth: 400 }), 'home');
  assert.equal(settleSwipeRelease({ activePane: 'stage', totalDx: 20, durationMs: 400, viewportWidth: 400 }), 'stage');
  assert.equal(settleSwipeRelease({ activePane: 'home', totalDx: 200, durationMs: 100, viewportWidth: 400 }), 'home');
  assert.equal(settleSwipeRelease({ activePane: 'inspector', totalDx: -200, durationMs: 100, viewportWidth: 0 }), 'inspector');

  // CSS transform
  assert.equal(resolveTrackTransform('home', false, 0), 'translate3d(0%, 0, 0)');
  assert.ok(resolveTrackTransform('stage', true, 24).includes('+ 24px'));
});

test('短模型名收敛、模型列表归一化、轮播拖拽物理与子代理参数解析', () => {
  const models = [
    { id: 'anthropic/claude-sonnet-4', provider: 'anthropic', name: 'anthropic/Claude Sonnet 4', displayName: 'Claude 4 Sonnet' },
    { id: 'shared-model', provider: 'p1', name: 'Shared (P1)' },
    { id: 'shared-model', provider: 'p2', name: 'Shared (P2)' },
    { id: 'openai/gpt-4o', name: 'OpenAI/GPT-4o' },
  ];
  assert.equal(resolveShortModelName('', models, '默认模型'), '默认模型');
  assert.equal(resolveShortModelName('anthropic/claude-sonnet-4', models, '默认'), 'Claude 4 Sonnet');
  assert.equal(resolveShortModelName('shared-model', models, '默认', 'p2'), 'Shared (P2)');
  assert.equal(resolveShortModelName('shared-model', models, '默认', 'missing'), 'Shared (P1)');
  assert.equal(resolveShortModelName('openai/gpt-4o', models, '默认'), 'GPT-4o');
  assert.equal(resolveShortModelName('google/gemini-2.5-pro', models, '默认'), 'gemini-2.5-pro');
  assert.equal(resolveShortModelName('local-qwen', models, '默认'), 'local-qwen');

  // buildMobileModelPickerItems 全分支（空id、重复key、多provider同名、不可用态、纯ID补齐、单选兜底与全空）
  const built = buildMobileModelPickerItems(
    ['', 'shared-model', 'bare-id'],
    [
      { id: '', provider: 'p1' },
      { id: 'shared-model', provider: 'p1', providerName: 'Prov One', displayName: 'Shared One' },
      { id: 'shared-model', provider: 'p1', providerName: 'Dup', displayName: 'Dup' },
      { id: 'shared-model', provider: 'p2', name: 'Shared Two', unavailable: true },
      { id: 'plain-id' },
    ],
    'shared-model',
    'p1',
  );
  assert.deepEqual(
    built.map((x) => [x.key, x.id, x.label, x.provider, x.providerLabel, x.active, x.unavailable]),
    [
      ['p1:shared-model', 'shared-model', 'Shared One', 'p1', 'Prov One', true, false],
      ['p2:shared-model', 'shared-model', 'Shared Two', 'p2', 'p2', false, true],
      [':plain-id', 'plain-id', 'plain-id', undefined, undefined, false, false],
      [':bare-id', 'bare-id', 'bare-id', undefined, undefined, false, false],
    ],
  );
  assert.deepEqual(buildMobileModelPickerItems([], [], 'only-selected'), [
    { key: ':only-selected', id: 'only-selected', label: 'only-selected', active: true, unavailable: false },
  ]);
  assert.deepEqual(buildMobileModelPickerItems([], [], ''), []);

  // Bot Hub 头像轮播水平拖动与松手裁决（阻尼、夹紧、距离/速度切页、无邻接项回弹）
  assert.ok(Math.abs(computeBotCarouselDragOffset(50, false, true) - 14) < 1e-6);
  assert.ok(Math.abs(computeBotCarouselDragOffset(-50, true, false) + 14) < 1e-6);
  assert.equal(computeBotCarouselDragOffset(200, true, true), 96);
  assert.equal(computeBotCarouselDragOffset(-200, true, true), -96);
  assert.equal(settleBotCarouselSwipe({ totalDx: -40, durationMs: 300, hasPrev: true, hasNext: true }), 'next');
  assert.equal(settleBotCarouselSwipe({ totalDx: -20, durationMs: 40, hasPrev: false, hasNext: true }), 'next');
  assert.equal(settleBotCarouselSwipe({ totalDx: 40, durationMs: 300, hasPrev: true, hasNext: true }), 'prev');
  assert.equal(settleBotCarouselSwipe({ totalDx: 20, durationMs: 40, hasPrev: true, hasNext: false }), 'prev');
  assert.equal(settleBotCarouselSwipe({ totalDx: -100, durationMs: 0, hasPrev: true, hasNext: false }), 'none');
  assert.equal(settleBotCarouselSwipe({ totalDx: 100, durationMs: 100, hasPrev: false, hasNext: true }), 'none');
  assert.equal(settleBotCarouselSwipe({ totalDx: 12, durationMs: 500, hasPrev: true, hasNext: true }), 'none');

  assert.equal(shouldCompactStagePresence(1000, 860, 100), false);
  assert.equal(shouldCompactStagePresence(1000, 700, 100), true);

  assert.deepEqual(parseSubagentToolArgs(undefined, '', '默认代理'), {
    title: '默认代理',
    task: '',
    summary: '默认代理',
  });
  assert.deepEqual(parseSubagentToolArgs('delegate_task', '   ', '默认代理'), {
    title: 'delegate_task',
    task: '',
    summary: 'delegate_task',
  });
  assert.deepEqual(
    parseSubagentToolArgs('delegate_task', JSON.stringify({ role: 'Code Reviewer', prompt: 'Review diff' }), 'Agent'),
    { title: 'Code Reviewer', task: 'Review diff', summary: 'Code Reviewer' },
  );
  assert.deepEqual(
    parseSubagentToolArgs('spawn_agent', JSON.stringify({ profile: 'qa', task: 'Run tests' }), 'Agent'),
    { title: 'qa', task: 'Run tests', summary: 'qa' },
  );
  assert.deepEqual(
    parseSubagentToolArgs('invoke_subagent', JSON.stringify({ TypeName: 'research', question: 'Find files' }), 'Agent'),
    { title: 'research', task: 'Find files', summary: 'research' },
  );
  assert.deepEqual(
    parseSubagentToolArgs('subagent', JSON.stringify({ title: 'Planner', description: 'Plan work' }), 'Agent'),
    { title: 'Planner', task: 'Plan work', summary: 'Planner' },
  );
  assert.deepEqual(
    parseSubagentToolArgs('subagent', JSON.stringify({ agent: 'SecOps', other: 1 }), 'Agent'),
    { title: 'SecOps', task: JSON.stringify({ agent: 'SecOps', other: 1 }), summary: 'SecOps' },
  );
  // JSON 无角色名 + 超 32 字符截断
  const noRoleLong = JSON.stringify({ foo: 'a-very-long-field-value-over-32-chars' });
  const parsedNoRole = parseSubagentToolArgs('delegate_task', noRoleLong, 'Agent');
  assert.equal(parsedNoRole.title, 'delegate_task');
  assert.ok(parsedNoRole.summary.endsWith('…'));

  // 非法 JSON 文本与短文本回落
  const invalidJson = parseSubagentToolArgs('delegate_task', '{broken\nsecond line', 'Agent');
  assert.deepEqual(invalidJson, { title: 'delegate_task', task: '{broken\nsecond line', summary: '{broken' });

  // 连续惯性轮播映射 & pointercancel 终点坐标归一化
  assert.equal(resolveBotCarouselScrollIndex(192, MOBILE_BOT_CAROUSEL_STEP_PX, 4), 2);
  assert.equal(resolveBotCarouselScrollIndex(-10, 96, 4), 0);
  assert.equal(resolveBotCarouselScrollIndex(999, 96, 4), 3);
  assert.equal(resolveBotCarouselScrollIndex(Number.NaN, 96, 4), 0);
  assert.equal(resolveBotCarouselScrollIndex(10, 0, 4), 0);
  assert.equal(resolveBotCarouselScrollIndex(10, 96, 0), 0);

  assert.equal(resolveNearestBotIndex(145, 96, 4), 2);
  assert.equal(resolveNearestBotIndex(0, 96, 0), 0);
  assert.equal(resolveNearestBotIndex(Number.NaN, 96, 3), 0);

  const centeredVis = computeBotCarouselSlotVisual(2, 2.1);
  assert.equal(centeredVis.isCentered, true);
  assert.ok(centeredVis.scale > 0.9);
  const edgeVis = computeBotCarouselSlotVisual(0, 2);
  assert.equal(edgeVis.isCentered, false);
  assert.equal(edgeVis.scale, 0.58);
  assert.equal(edgeVis.opacity, 0.46);

  assert.equal(resolveSwipeReleaseEndX('pointercancel', 0, 220), 220);
  assert.equal(resolveSwipeReleaseEndX('pointercancel', 0, 0), 0);
  assert.equal(resolveSwipeReleaseEndX('pointerup', 0, 220), 0);
});
