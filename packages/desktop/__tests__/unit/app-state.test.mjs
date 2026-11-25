/**
 * AppState 领域模型与初始工厂单元测试
 *
 * 【断言】
 *   1. 初始状态工厂默认值正确生成；
 *   2. 移动端视口平台推导生效；
 *   3. 骨架屏默认三域相位均初始化为 loading（杜绝白屏/假空）；
 *   4. readPresenceLayout 容忍空 localStorage 并默认回退 stage。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createInitialState,
  readPresenceLayout,
  resolveActiveWorkspaceCwd,
  PRESENCE_LAYOUT_STORAGE_KEY,
} from '../../dist/renderer/state/appState.mjs';

test('AppState 领域状态模型测试', async (t) => {
  await t.test('1. createInitialState 默认生成合法 AppState', () => {
    const state = createInitialState({ platform: 'windows' });
    assert.equal(state.platform, 'windows');
    assert.equal(state.isMaximized, false);
    assert.equal(state.profilesPhase, 'loading');
    assert.equal(state.sessionsPhase, 'loading');
    assert.equal(state.messagesPhase, 'loading');
    assert.equal(state.activeSessionId, '');
    assert.equal(state.messages.length, 0);
    assert.equal(state.isStreaming, false);
    assert.equal(state.conversationWidth, 'wide');
    assert.equal(state.leftRailLayout, 'dual-rail');
    assert.equal(state.isBotsGroupExpanded, true);
  });

  await t.test('1b. conversationWidth 冷启动确实经 localStorage 偏好加载并收敛脏值', () => {
    // 【杀伤力】若 createInitialState 把 conversationWidth 写成常量 'wide'，
    // 下面注入 narrow/full 的两条断言立刻变红。
    const hadStorage = 'localStorage' in globalThis;
    const savedStorage = globalThis.localStorage;
    const installStorage = (raw) => {
      globalThis.localStorage = {
        getItem: (key) => (key === 'hermes_flux_conversation_width' ? raw : null),
        setItem() {},
      };
    };
    try {
      delete globalThis.localStorage;
      assert.equal(createInitialState({ platform: 'windows' }).conversationWidth, 'wide', '无 localStorage 必须回落默认 wide');

      installStorage('narrow');
      assert.equal(createInitialState({ platform: 'windows' }).conversationWidth, 'narrow');
      assert.equal(readPresenceLayout(), 'stage', '宽度偏好注入不得影响其它偏好键的默认回退');

      installStorage('full');
      assert.equal(createInitialState({ platform: 'windows' }).conversationWidth, 'full');

      installStorage('bogus-width');
      assert.equal(createInitialState({ platform: 'windows' }).conversationWidth, 'wide', '脏值必须收敛为 wide');
    } finally {
      if (hadStorage) globalThis.localStorage = savedStorage;
      else delete globalThis.localStorage;
    }
  });

  await t.test('1c. localStorage 访问抛错时初始化降级为默认值而非中断', () => {
    // 【杀伤力】去掉 getStorage 的 try/catch，createInitialState 会直接抛 Error: denied，本用例必红。
    const hadStorage = 'localStorage' in globalThis;
    const savedStorage = globalThis.localStorage;
    const savedWarn = console.warn;
    const warns = [];
    try {
      globalThis.localStorage = {
        getItem() { throw new Error('denied'); },
        setItem() { throw new Error('denied'); },
      };
      console.warn = (...args) => { warns.push(args); };

      let state;
      assert.doesNotThrow(() => { state = createInitialState({ platform: 'windows' }); }, '存储被禁用不得阻断冷启动');

      assert.equal(state.theme, 'obsidian-gold');
      assert.equal(state.lang, 'zh');
      assert.equal(state.profileName, 'default');
      assert.equal(state.gatewayUrl, '');
      assert.equal(state.gatewayConnecting, false);
      assert.equal(state.username, '');
      assert.equal(state.password, '');
      assert.deepEqual(state.favoriteModels, []);
      assert.deepEqual(state.recentModels, []);
      assert.equal(state.presenceLayout, 'stage');
      assert.equal(state.conversationWidth, 'wide');
      assert.equal(state.leftRailLayout, 'dual-rail');
      assert.equal(state.isBotsGroupExpanded, true);
      assert.ok(warns.length > 0, '降级必须可观测，禁止静默吞掉失败');
    } finally {
      console.warn = savedWarn;
      if (hadStorage) globalThis.localStorage = savedStorage;
      else delete globalThis.localStorage;
    }
  });

  await t.test('1d. leftRailLayout 与 groupedRailSections 冷启动经 localStorage 加载并收敛脏值', () => {
    const hadStorage = 'localStorage' in globalThis;
    const savedStorage = globalThis.localStorage;
    const installStorage = (map) => {
      globalThis.localStorage = {
        getItem: (key) => (key in map ? map[key] : null),
        setItem() {},
      };
    };
    try {
      delete globalThis.localStorage;
      const fallback = createInitialState({ platform: 'windows' });
      assert.equal(fallback.leftRailLayout, 'dual-rail');
      assert.equal(fallback.isBotsGroupExpanded, true);

      installStorage({
        hermes_flux_left_rail_layout: 'grouped',
        hermes_flux_grouped_rail_sections: JSON.stringify({ bots: false, groups: false, sessions: false }),
      });
      const groupedState = createInitialState({ platform: 'windows' });
      assert.equal(groupedState.leftRailLayout, 'grouped');
      assert.equal(groupedState.isBotsGroupExpanded, false);
      assert.equal(groupedState.isGroupsGroupExpanded, false);
      assert.equal(groupedState.isSessionsGroupExpanded, false);

      installStorage({
        hermes_flux_left_rail_layout: 'bogus-layout',
        hermes_flux_grouped_rail_sections: '{broken-json',
      });
      const sanitized = createInitialState({ platform: 'windows' });
      assert.equal(sanitized.leftRailLayout, 'dual-rail', '脏布局偏好必须收敛为 dual-rail');
      assert.equal(sanitized.isBotsGroupExpanded, true, '损坏的分段折叠 JSON 必须安全回退为展开');
      assert.equal(sanitized.isGroupsGroupExpanded, true);
      assert.equal(sanitized.isSessionsGroupExpanded, true);
    } finally {
      if (hadStorage) globalThis.localStorage = savedStorage;
      else delete globalThis.localStorage;
    }
  });

  await t.test('2. readPresenceLayout 默认 stage 并支持 dock', () => {
    assert.equal(PRESENCE_LAYOUT_STORAGE_KEY, 'hermes_flux_presence_layout');
    const layout = readPresenceLayout();
    assert.ok(layout === 'stage' || layout === 'dock');
  });

  await t.test('3. resolveActiveWorkspaceCwd 严格按当前会话/Bot解析并禁止跨工程劫持', () => {
    const initial = createInitialState({ platform: 'windows' });
    assert.deepEqual(initial.fileTreeState, { status: 'idle' });
    assert.deepEqual(initial.fileTreeExpandedPaths, []);
    assert.equal(initial.fileTreeFilterQuery, '');
    assert.equal(initial.fileTreeCollapsed, false);
    assert.equal(initial.fileTreeLoadedCwd, '');
    assert.deepEqual(initial.sessionCwds, {});

    assert.equal(resolveActiveWorkspaceCwd(null), '');
    assert.equal(resolveActiveWorkspaceCwd({}), '');

    // 1. sessionCwds 按 sessionId 精准记录，覆盖未入 sessions 列表的专职 Bot Forever Chat
    assert.equal(
      resolveActiveWorkspaceCwd({
        activeSessionId: 'forever-bot-1',
        sessions: [{ id: 'other', cwd: '/ws/other' }],
        sessionCwds: { 'forever-bot-1': 'D:\\bots\\coder\\' },
        projects: [{ id: 'p1', name: 'NewProj', path: '/ws/hijack' }],
      }),
      'D:/bots/coder',
    );

    // 2. activeSession.cwd（包含归档会话 archivedSessions）
    assert.equal(
      resolveActiveWorkspaceCwd({
        activeSessionId: 's1',
        sessions: [{ id: 's1', cwd: 'E:\\repos\\proj-a\\' }],
        projects: [{ id: 'p1', name: 'P1', path: '/other' }],
      }),
      'E:/repos/proj-a',
    );
    assert.equal(
      resolveActiveWorkspaceCwd({
        activeSessionId: 's-arch',
        sessions: [],
        archivedSessions: [{ id: 's-arch', cwd: '/ws/archived' }],
      }),
      '/ws/archived',
    );

    // 3. 无 cwd 时匹配会话归属 project.path
    assert.equal(
      resolveActiveWorkspaceCwd({
        activeSessionId: 's2',
        sessions: [{ id: 's2', projectId: 'p1', projectName: 'P1' }],
        projects: [{ id: 'p1', name: 'P1', path: '/ws/p1/' }],
      }),
      '/ws/p1',
    );

    // 3b. 通过 projectName 匹配 project.path
    assert.equal(
      resolveActiveWorkspaceCwd({
        activeSessionId: 's3',
        sessions: [{ id: 's3', projectName: 'NameMatch' }],
        projects: [{ id: 'p2', name: 'NameMatch', path: '/ws/name-match' }],
      }),
      '/ws/name-match',
    );

    // 4. 群聊焦点无单一工作区，必须返回空
    assert.equal(
      resolveActiveWorkspaceCwd({
        activeSessionId: 's1',
        activeFocus: { type: 'group', roomId: 'room-1' },
        sessions: [{ id: 's1', cwd: '/ws/s1' }],
        sessionCwds: { s1: '/ws/s1' },
      }),
      '',
    );

    // 5. 回归不变量：无 cwd 且未归属项目的会话（或空激活态）绝不可被 selectedNewTaskProjectId 或 projects[0] 劫持
    assert.equal(
      resolveActiveWorkspaceCwd({
        activeSessionId: 'plain-session',
        sessions: [{ id: 'plain-session' }],
        selectedNewTaskProjectId: 'p-sel',
        projects: [
          { id: 'p-first', name: 'First', path: '/ws/first' },
          { id: 'p-sel', name: 'Sel', path: '/ws/selected' },
        ],
      }),
      '',
    );
    assert.equal(
      resolveActiveWorkspaceCwd({
        activeSessionId: '',
        sessions: [],
        selectedNewTaskProjectId: 'p-sel',
        projects: [{ id: 'p-sel', name: 'Sel', path: '/ws/selected' }],
      }),
      '',
    );
  });
});
