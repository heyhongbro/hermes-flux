import test from 'node:test';
import assert from 'node:assert/strict';
import { ProfileService } from '../../dist/profile/profileService.js';
import { defaultSessionHandleRegistry, SessionHandleRegistry } from '../../dist/session/sessionRegistry.js';
import {
  botActivityKey,
  applyBotActivity,
  syncBotProfiles,
  syncActiveSessionToBot,
} from '../../dist/profile/botActivitySync.js';

test('ProfileService - 专职 Bot 管理与 Forever Chat 终身主工位状态机', async (t) => {
  await t.test('1. listProfiles：获取专职 Bot 列表与内存缓存复用', async () => {
    const service = new ProfileService();
    let callCount = 0;
    const mockBridge = {
      async request(method) {
        assert.equal(method, 'profiles.list');
        callCount++;
        return {
          profiles: [
            { name: 'default', displayName: '主助理', isDefault: true },
            { name: 'arch-wang', displayName: '架构老王' },
          ],
        };
      },
    };

    const list1 = await service.listProfiles(mockBridge);
    assert.equal(list1.length, 2);
    assert.equal(callCount, 1);

    // 第二次调用命中内存缓存
    const list2 = await service.listProfiles(mockBridge);
    assert.equal(list2.length, 2);
    assert.equal(callCount, 1, '未强制刷新时必须复用内存缓存');

    // 强制刷新
    const list3 = await service.listProfiles(mockBridge, true);
    assert.equal(list3.length, 2);
    assert.equal(callCount, 2);

    // 负向测试：网关返回畸变数据结构
    await assert.rejects(
      () => service.listProfiles({ async request() { return {}; } }, true),
      /非法的 profiles.list 响应数据结构/
    );
  });

  await t.test('2. describeProfile：查询 Bot 专属沙箱档案与负向防护', async () => {
    const service = new ProfileService();
    const mockBridge = {
      async request(method, params) {
        assert.equal(method, 'profiles.describe');
        if (params.name === 'arch-wang') {
          return {
            profile: {
              name: 'arch-wang',
              displayName: '架构老王',
              systemPrompt: 'You are senior architect.',
              tools: ['bash', 'read_file'],
            },
          };
        }
        return { profile: null };
      },
    };

    const detail = await service.describeProfile('arch-wang', mockBridge);
    assert.equal(detail.name, 'arch-wang');
    assert.equal(detail.tools?.length, 2);

    // 负向：空名称或不存在
    await assert.rejects(() => service.describeProfile('', mockBridge), /Profile name is mandatory/);
    await assert.rejects(() => service.describeProfile('ghost-bot', mockBridge), /未找到 Bot 配置档/);
  });

  await t.test('3. createProfile 与 configureProfile：动态创建与属性配置', async () => {
    const service = new ProfileService();
    let createdName = '';
    let configuredParams = null;

    const mockBridge = {
      async request(method, params) {
        if (method === 'profiles.create') {
          createdName = params.name;
          return { ok: true, name: params.name };
        }
        if (method === 'profiles.configure') {
          configuredParams = params;
          // 官方契约结果字段是 ok/applied，不是 success
          return { ok: true, applied: ['description'] };
        }
        if (method === 'profiles.list') {
          return {
            profiles: [
              { name: 'sec-guard', display_name: '安全守卫' },
            ],
          };
        }
        throw new Error(`Unexpected call: ${method}`);
      },
    };

    // 正向创建
    const resCreate = await service.createProfile({ name: 'sec-guard', description: '安全守卫' }, mockBridge);
    assert.equal(resCreate.name, 'sec-guard');
    assert.equal(createdName, 'sec-guard');

    // 负向创建：名称为空
    await assert.rejects(() => service.createProfile({ name: '' }, mockBridge), /Bot profile name cannot be empty/);

    // 正向配置：字段必须扁平，不能包一层 patch
    const okConfig = await service.configureProfile('sec-guard', { description: '首席安全官' }, mockBridge);
    assert.equal(okConfig, true);
    assert.equal(configuredParams?.description, '首席安全官');
    assert.equal(configuredParams?.patch, undefined, 'patch 不是契约字段，会被网关 4000 拒绝');
    assert.equal(configuredParams?.name, 'sec-guard');
  });

  await t.test('4. getAsset 与 setAsset：Bot 头像与静态资产存取', async () => {
    const service = new ProfileService();
    let setKey = '';
    let setBase64 = '';
    const seenGetParams = [];

    const mockBridge = {
      async request(method, params) {
        if (method === 'profiles.get_asset') {
          seenGetParams.push(params);
          // 契约守卫：网关 Pydantic extra='forbid'，只允许 name + asset
          assert.deepEqual(
            Object.keys(params).sort(),
            ['asset', 'name'],
            'profiles.get_asset 只允许 { name, asset }，多传 key 会被网关 4000 拒绝'
          );
          if (params.asset === 'avatar') {
            return { found: true, mime: 'image/jpeg', data: 'data:image/jpeg;base64,AAAA' };
          }
          return { found: false };
        }
        if (method === 'profiles.set_asset') {
          // 契约字段是 asset + data，不是 key + base64
          assert.equal(params.key, undefined, 'key 不是契约字段（会触发 4000）');
          assert.equal(params.base64, undefined, 'base64 不是契约字段（会触发 4000）');
          setKey = params.asset;
          setBase64 = params.data;
          return { ok: true };
        }
        throw new Error(`Unexpected call: ${method}`);
      },
    };

    // 获取存在的资产
    const asset = await service.getAsset('arch-wang', 'avatar', mockBridge);
    assert.equal(asset, 'data:image/jpeg;base64,AAAA');
    assert.equal(seenGetParams.length, 1);

    // 网关明确 found=false 时返回 null（确实没有资产）
    const missing = await service.getAsset('arch-wang', 'missing.png', mockBridge);
    assert.equal(missing, null);

    // 契约错误必须显式抛出，严禁被吞成"没有头像"
    const failingBridge = {
      async request() {
        const err = new Error('invalid params: key: Extra inputs are not permitted');
        err.code = 4000;
        throw err;
      },
    };
    await assert.rejects(
      () => service.getAsset('arch-wang', 'avatar', failingBridge),
      /Extra inputs are not permitted/,
      'RPC 失败必须向上抛出，不能被伪装成无资产'
    );

    // 设置资产
    const ok = await service.setAsset('arch-wang', 'avatar.png', 'data:image/png;base64,BBBB', mockBridge);
    assert.equal(ok, true);
    assert.equal(setKey, 'avatar.png');
    assert.equal(setBase64, 'data:image/png;base64,BBBB');
  });

  await t.test('5. getOrCreateForeverChat：已有主工位时直接检索复用', async () => {
    const service = new ProfileService();
    let setHiddenCalled = false;
    const mockBridge = {
      async request(method, params) {
        if (method === 'session.list') {
          assert.equal(params.profile, 'arch-wang');
          return {
            sessions: [
              { id: 'sess-scratch-1', title: '临时调试' },
              { id: 'sess-bot-forever-chat', title: 'Bot Chat', created_at: 1000 },
            ],
          };
        }
        if (method === 'session.set_hidden') {
          setHiddenCalled = true;
          return { success: true };
        }
        throw new Error(`Unexpected call: ${method}`);
      },
    };

    const chat = await service.getOrCreateForeverChat('arch-wang', mockBridge);
    assert.equal(chat.sessionId, 'sess-bot-forever-chat');
    assert.equal(chat.title, 'Bot Chat');
    assert.equal(chat.isForeverChat, true);
    assert.equal(setHiddenCalled, false, '已有主工位无需重复 set_hidden');
  });

  await t.test('6. getOrCreateForeverChat：不存在时自动创建并设置 hidden=1', async () => {
    const service = new ProfileService();
    let createdPayload = null;
    let setHiddenPayload = null;

    const mockBridge = {
      async request(method, params) {
        if (method === 'session.list') {
          return { sessions: [] };
        }
        if (method === 'session.create') {
          createdPayload = params;
          return { session_id: 'sess-new-forever-chat' };
        }
        if (method === 'session.set_hidden') {
          setHiddenPayload = params;
          return { success: true };
        }
        throw new Error(`Unexpected call: ${method}`);
      },
    };

    const chat = await service.getOrCreateForeverChat('fe-zhang', mockBridge);
    assert.equal(chat.sessionId, 'sess-new-forever-chat');
    assert.equal(chat.isForeverChat, true);
    assert.equal(createdPayload?.title, 'Bot Chat');
    assert.equal(createdPayload?.profile, 'fe-zhang');
    assert.equal(setHiddenPayload?.session_id, 'sess-new-forever-chat');
    assert.equal(setHiddenPayload?.hidden, true);
  });

  await t.test('6.1 getOrCreateForeverChat：网关返回双 ID 时必须采纳 stored_session_id 作为永久工位并登记实时句柄', async () => {
    const service = new ProfileService();
    let hiddenTargetSessionId = '';
    let hiddenTargetProfile = '';
    const mockBridge = {
      async request(method, params) {
        if (method === 'session.list') {
          return { sessions: [] };
        }
        if (method === 'session.create') {
          return { session_id: 'live-short-123', stored_session_id: '20261124_stored_long_456' };
        }
        if (method === 'session.set_hidden') {
          hiddenTargetSessionId = params.session_id;
          hiddenTargetProfile = params.profile;
          return { success: true };
        }
        throw new Error(`Unexpected call: ${method}`);
      },
    };

    try {
      const chat = await service.getOrCreateForeverChat('new-bot-dual-id', mockBridge);
      assert.equal(chat.sessionId, '20261124_stored_long_456', '必须采纳 stored_session_id 作为主工位 ID');
      assert.equal(hiddenTargetSessionId, '20261124_stored_long_456', 'session.set_hidden 必须作用在 stored_session_id 上');
      assert.equal(hiddenTargetProfile, 'new-bot-dual-id', 'session.set_hidden 必须传递 profile 确保多 Bot 隔离寻址');
      assert.equal(defaultSessionHandleRegistry.getRegisteredLiveId('20261124_stored_long_456'), 'live-short-123', '必须在句柄表中登记实时通道 liveId');
      assert.equal(chat.isForeverChat, true);
    } finally {
      defaultSessionHandleRegistry.clear();
    }
  });

  await t.test('7. getOrCreateForeverChat：网络失败严禁伪装为空 (Failure Is Not Empty 显式抛出)', async () => {
    const service = new ProfileService();
    const failingBridge = {
      async request(method) {
        if (method === 'session.list') {
          throw new Error('Connection refused: Gateway offline');
        }
        throw new Error(`Unexpected method: ${method}`);
      },
    };

    // 严禁吞掉错误并创建重复的 Bot Chat，必须显式抛出
    await assert.rejects(
      () => service.getOrCreateForeverChat('arch-wang', failingBridge),
      /Connection refused: Gateway offline/
    );

    // 负向参数拦截
    await assert.rejects(
      () => service.getOrCreateForeverChat('', failingBridge),
      /Bot profile name is mandatory/
    );
  });

  await t.test('8. canCommitLongTermMemory 与 clearCache：记忆防毒化规则与缓存重置', () => {
    const service = new ProfileService();
    // 只有主工位可以写入 MEMORY.md
    assert.equal(service.canCommitLongTermMemory({ isForeverChat: true }), true);
    assert.equal(service.canCommitLongTermMemory({ isForeverChat: false }), false);
    assert.equal(service.canCommitLongTermMemory({}), false);

    service.clearCache();
  });

  await t.test('9. ProfileService({ handleRegistry })：多网关实例隔离注册表，不污染全局 defaultSessionHandleRegistry', async () => {
    const isolatedRegistry = new SessionHandleRegistry();
    const service = new ProfileService({ handleRegistry: isolatedRegistry });
    const mockBridge = {
      async request(method) {
        if (method === 'session.list') {
          return { sessions: [] };
        }
        if (method === 'session.create') {
          return { session_id: 'live-iso-forever', stored_session_id: 'sess-iso-forever' };
        }
        if (method === 'session.set_hidden') {
          return { success: true };
        }
        throw new Error(`Unexpected call: ${method}`);
      },
    };
    const chat = await service.getOrCreateForeverChat('iso-bot', mockBridge);
    assert.equal(chat.sessionId, 'sess-iso-forever');
    assert.equal(isolatedRegistry.getRegisteredLiveId('sess-iso-forever'), 'live-iso-forever');
    assert.equal(defaultSessionHandleRegistry.getRegisteredLiveId('sess-iso-forever'), null);
  });

  await t.test('10. botActivitySync：多网关 default Bot 物理隔离、Scoped 缓存与前缀剥离', () => {
    assert.equal(botActivityKey('default'), 'default');
    assert.equal(botActivityKey('default', 'gw-a'), 'gw-a:default');

    const baseProfiles = [
      { name: 'default', displayName: 'Master A', gatewayId: 'gw-a', description: 'desc-a' },
      { name: 'default', displayName: 'Master B', gatewayId: 'gw-b', description: 'desc-b' },
    ];
    const activityMap = new Map();
    const fmt = (ts) => `t:${ts}`;

    const noopRes = applyBotActivity({
      profiles: baseProfiles,
      activityMap,
      botName: '',
      text: 'ignored',
      timestamp: 1000,
      formatTime: fmt,
      gatewayId: 'gw-a',
    });
    assert.equal(noopRes.profiles.length, 2);

    const appliedA = applyBotActivity({
      profiles: baseProfiles,
      activityMap,
      botName: 'default',
      text: '  hello node A  ',
      timestamp: 1700000001000,
      formatTime: fmt,
      gatewayId: 'gw-a',
    });
    assert.equal(appliedA.updatedProfile?.gatewayId, 'gw-a');
    assert.equal(appliedA.updatedProfile?.lastMessage, 'hello node A');
    assert.equal(activityMap.get('gw-a:default')?.lastMessage, 'hello node A');
    assert.equal(activityMap.get('gw-b:default'), undefined);
    assert.equal(appliedA.profiles.find((p) => p.gatewayId === 'gw-b')?.lastMessage, undefined);

    const appliedByDisplay = applyBotActivity({
      profiles: baseProfiles,
      activityMap: new Map(),
      botName: 'Master A',
      text: 'via display',
      timestamp: 1700000001500,
      formatTime: fmt,
      gatewayId: 'gw-a',
    });
    assert.equal(appliedByDisplay.updatedProfile?.gatewayId, 'gw-a');
    assert.equal(appliedByDisplay.updatedProfile?.lastMessage, 'via display');

    const foreverChatCache = new Map([
      ['gw-a:other', 'other-sid'],
      ['gw-a:default', 'shared-forever'],
      ['gw-b:default', 'shared-forever'],
      ['gw-c:default', 'shared-forever'],
      ['solo-plain', 'solo-fc'],
    ]);
    const sessionMessagesCache = new Map([
      ['gw-a::shared-forever', [{ content: 'scoped A msg', timestamp: 1700000002000 }]],
      ['gw-b::shared-forever', [{ content: 'scoped B msg', timestamp: 1700000003000 }]],
      ['shared-forever', [{ content: 'unscoped collided msg', timestamp: 1700000009000 }]],
      ['solo-fc', [{ content: 'solo fc msg', timestamp: 1700000009500 }]],
    ]);

    const syncedA = syncBotProfiles({
      profiles: [
        { name: 'default', displayName: 'Master A', gatewayId: 'gw-a' },
        { name: 'default', displayName: 'Master C', gatewayId: 'gw-c' },
        { name: 'solo-plain', displayName: 'Solo Plain' },
      ],
      activityMap: new Map(),
      foreverChatCache,
      sessionMessagesCache,
      formatTime: fmt,
    });
    assert.equal(syncedA.find((p) => p.gatewayId === 'gw-a')?.lastMessage, 'scoped A msg');
    assert.equal(syncedA.find((p) => p.gatewayId === 'gw-c')?.lastMessage, 'unscoped collided msg');
    assert.equal(syncedA.find((p) => p.name === 'solo-plain')?.lastMessage, 'solo fc msg');

    const syncedAct = syncBotProfiles({
      profiles: [
        ...baseProfiles,
        { name: 'no-display-gw', gatewayId: 'gw-a', description: 'plain gw' },
        { name: 'unscoped-alias', displayName: 'AliasOnly' },
        { name: 'unscoped-plain', description: 'plain' },
      ],
      activityMap: new Map([
        ['gw-b:Master B', { lastMessage: 'alias B act', timestamp: 1700000005000 }],
        ['AliasOnly', { lastMessage: 'unscoped alias act', timestamp: 1700000004000 }],
      ]),
      foreverChatCache: new Map(),
      sessionMessagesCache: new Map(),
      formatTime: fmt,
    });
    assert.equal(syncedAct[0].gatewayId, 'gw-b');
    assert.equal(syncedAct[0].lastMessage, 'alias B act');
    assert.equal(syncedAct[1].lastMessage, 'unscoped alias act');
    assert.equal(syncedAct.find((p) => p.name === 'no-display-gw')?.lastMessage, 'plain gw');
    assert.equal(syncedAct.find((p) => p.name === 'unscoped-plain')?.lastMessage, 'plain');

    // syncActiveSessionToBot strips gatewayId: prefix and isolates cross-gateway foreverChatId collision
    const syncBMap = new Map();
    const syncB = syncActiveSessionToBot({
      sessionId: 'shared-forever',
      messages: [{ content: 'fresh turn on B', rawTimestamp: 1700000006 }],
      foreverChatCache,
      profiles: baseProfiles,
      activityMap: syncBMap,
      formatTime: fmt,
      gatewayId: 'gw-b',
    });
    assert.equal(syncB?.matchedBotName, 'default');
    assert.equal(syncBMap.get('gw-b:default')?.lastMessage, 'fresh turn on B');
    assert.equal(syncBMap.get('gw-a:default'), undefined);
    assert.equal(syncB?.profiles.find((p) => p.gatewayId === 'gw-a')?.lastMessage, undefined);

    // Unscoped key + fallback to activeFocusBotName + empty messages null guard
    const soloMap = new Map();
    const soloRes = syncActiveSessionToBot({
      sessionId: 'solo-f',
      messages: [{ content: 'solo msg', rawTimestamp: 1700000007000 }],
      foreverChatCache: new Map([['default', 'solo-f']]),
      profiles: [{ name: 'default', displayName: 'Solo' }],
      activityMap: soloMap,
      formatTime: fmt,
    });
    assert.equal(soloRes?.matchedBotName, 'default');
    assert.equal(soloMap.get('default')?.lastMessage, 'solo msg');

    const focusFallback = syncActiveSessionToBot({
      sessionId: 'unknown-sid',
      messages: [{ content: 'focus fallback', rawTimestamp: 1700000008000 }],
      foreverChatCache: new Map(),
      activeFocusBotName: 'default',
      profiles: baseProfiles,
      activityMap: new Map(),
      formatTime: fmt,
      gatewayId: 'gw-a',
    });
    assert.equal(focusFallback?.matchedBotName, 'default');
    assert.equal(
      syncActiveSessionToBot({
        sessionId: 'x',
        messages: [],
        foreverChatCache,
        profiles: baseProfiles,
        activityMap: new Map(),
        formatTime: fmt,
      }),
      null,
    );
  });
});
