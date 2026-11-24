/**
 * 会话组织域核心服务与适配器单元测试（UiMetaConversationOrgAdapter + ConversationOrgService + PathMatch）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ConversationOrgService,
  DONE_ROOMS_UI_META_KEY,
  FOLDERS_UI_META_KEY,
  ORG_UNASSIGNED_SENTINEL,
  UiMetaConversationOrgAdapter,
  assignEntityInMeta,
  buildRoomEntityKey,
  buildSessionEntityKey,
  deleteFolderInMeta,
  isPathWithinDirectory,
  matchProjectByCwd,
  normalizePathForMatch,
  pruneStaleOrgKeys,
  resolveEntityContainer,
  toProjectContainerId,
} from '../../dist/index.js';

test('路径匹配器：Windows/POSIX 归一化、目录边界防护、最长前缀优胜与归档排除', () => {
  assert.equal(normalizePathForMatch('C:\\Work\\Hermes-App\\'), 'c:/work/hermes-app');
  assert.equal(normalizePathForMatch('/work/app///'), '/work/app');
  assert.equal(isPathWithinDirectory('/work/app-v2', '/work/app'), false, '兄妹前缀 /work/app-v2 不得误匹配 /work/app');
  assert.equal(isPathWithinDirectory('/work/app/src', '/work/app'), true);
  assert.equal(isPathWithinDirectory('c:/work/app/src/index.ts', 'c:/work/app'), true);

  const projects = [
    { id: 'mono', primaryPath: '/work/mono', archived: false },
    { id: 'mono-ui', primaryPath: '/work/mono/packages/ui', archived: false },
    { id: 'arch', primaryPath: '/work/mono/packages/ui/secret', archived: true },
    { id: 'with-extra', primaryPath: '/work/main', additionalFolders: ['/work/shared-lib'], archived: false },
  ];

  assert.equal(matchProjectByCwd('/work/mono/packages/core', projects), 'mono');
  assert.equal(matchProjectByCwd('/work/mono/packages/ui/src', projects), 'mono-ui', '嵌套项目必须由最长前缀胜出');
  assert.equal(matchProjectByCwd('/work/mono/packages/ui/secret/file', projects), 'mono-ui', 'archived 项目不得自动吸纳会话');
  assert.equal(matchProjectByCwd('/work/shared-lib/utils', projects), 'with-extra', 'additionalFolders 必须参与匹配');
  assert.equal(matchProjectByCwd('/work/mono-v2', projects), null, '严格边界检查防止前缀溢出');
});

test('容器归属裁决与纯函数变更：Bot 免疫、__none__ 哨兵、删文件夹保留实体、僵尸键清理', () => {
  const folder = { id: 'fld-1', name: '重点项目', order: 0, createdAt: 10, updatedAt: 10 };
  const projects = [{ id: 'p-1', primaryPath: '/work/p1', archived: false }];
  const sessionKey = buildSessionEntityKey('Default', 'sess-1');
  assert.equal(sessionKey, 'session:default:sess-1', 'profile 必须小写归一化');

  assert.equal(
    resolveEntityContainer({
      entityKey: sessionKey,
      cwd: '/work/p1',
      isForeverChat: true,
      folders: [folder],
      assignments: { [sessionKey]: 'fld-1' },
      projects,
    }),
    null,
    'Forever Chat 必须物理免疫任何文件夹与项目归属',
  );

  assert.throws(
    () =>
      assignEntityInMeta(
        { version: 1, folders: [folder], assignments: {} },
        { entityKey: sessionKey, containerId: 'fld-1', isForeverChat: true },
      ),
    /物理保护/,
  );

  assert.deepEqual(
    resolveEntityContainer({
      entityKey: sessionKey,
      cwd: '/work/p1',
      folders: [folder],
      assignments: { [sessionKey]: 'fld-1' },
      projects,
    }),
    { kind: 'folder', folderId: 'fld-1' },
    '显式文件夹归属优先级高于 cwd 自动匹配',
  );

  assert.equal(
    resolveEntityContainer({
      entityKey: sessionKey,
      cwd: '/work/p1',
      folders: [folder],
      assignments: { [sessionKey]: ORG_UNASSIGNED_SENTINEL },
      projects,
    }),
    null,
    '__none__ 哨兵必须阻断 cwd 自动吸附',
  );

  const metaWithRoom = {
    version: 1,
    folders: [folder, { id: 'fld-2', name: '保留区', order: 1, createdAt: 20, updatedAt: 20 }],
    assignments: {
      [sessionKey]: 'fld-1',
      [buildRoomEntityKey('room-1')]: 'fld-2',
      [buildSessionEntityKey('default', 'sess-2')]: toProjectContainerId('p-1'),
    },
  };
  const afterDelete = deleteFolderInMeta(metaWithRoom, 'fld-1');
  assert.equal(afterDelete.folders.length, 1);
  assert.equal(afterDelete.assignments[sessionKey], undefined);
  assert.equal(afterDelete.assignments[buildRoomEntityKey('room-1')], 'fld-2');
  assert.equal(afterDelete.assignments[buildSessionEntityKey('default', 'sess-2')], 'prj:p-1');

  const pruned = pruneStaleOrgKeys(
    {
      version: 1,
      folders: [folder],
      assignments: {
        'session:default:alive': 'fld-1',
        'session:default:dead': 'fld-1',
        'room:gone': 'fld-1',
        'session:default:alive-orphaned-proj': 'prj:gone-proj',
      },
    },
    { version: 1, done: { 'room-alive': 100, gone: 200 } },
    {
      validSessionKeys: new Set(['session:default:alive', 'session:default:alive-orphaned-proj']),
      validRoomIds: new Set(['room-alive']),
      validProjectIds: new Set(['p-1']),
    },
  );
  assert.equal(pruned.changed, true);
  assert.deepEqual(pruned.foldersMeta.assignments, { 'session:default:alive': 'fld-1' });
  assert.deepEqual(pruned.doneRoomsMeta.done, { 'room-alive': 100 });
});

test('UiMetaConversationOrgAdapter + ConversationOrgService: 双键隔离、CAS 冲突三路合流与失败显式拒绝', async () => {
  const rpcCalls = [];
  let remoteFolders = {
    version: 1,
    folders: [{ id: 'fld-remote', name: '远端目录', order: 0, createdAt: 5, updatedAt: 5 }],
    assignments: { 'session:default:remote-s': 'fld-remote' },
  };
  let remoteDoneRooms = { version: 1, done: { 'room-old': 500 } };
  let foldersRev = 1;
  let doneRev = 3;
  let conflictOnce = true;

  const clientCall = async (method, params) => {
    rpcCalls.push({ method, params });
    if (method === 'profiles.list') {
      return {
        profiles: [
          {
            name: 'default',
            is_default: true,
            ui_meta: {
              'unrelated-plugin-key': { keepMe: true },
              [FOLDERS_UI_META_KEY]: remoteFolders,
              [DONE_ROOMS_UI_META_KEY]: remoteDoneRooms,
            },
            ui_meta_revisions: {
              [FOLDERS_UI_META_KEY]: foldersRev,
              [DONE_ROOMS_UI_META_KEY]: doneRev,
            },
          },
        ],
      };
    }
    if (method === 'profiles.configure') {
      if (conflictOnce && params?.ui_meta?.[FOLDERS_UI_META_KEY]) {
        conflictOnce = false;
        // 模拟并发端刚刚新增了另一个文件夹并把版本推高到 2
        foldersRev = 2;
        remoteFolders = {
          version: 1,
          folders: [
            ...remoteFolders.folders,
            { id: 'fld-peer', name: '同事新建', order: 1, createdAt: 9, updatedAt: 9 },
          ],
          assignments: {
            ...remoteFolders.assignments,
            'room:peer-r': 'fld-peer',
          },
        };
        return {
          ok: false,
          applied: {
            ui_meta: false,
            ui_meta_conflicts: { [FOLDERS_UI_META_KEY]: { expected: 1, actual: 2 } },
          },
        };
      }
      if (params?.ui_meta?.[FOLDERS_UI_META_KEY]) {
        assert.equal(
          params.ui_meta_expected_revisions?.[FOLDERS_UI_META_KEY],
          foldersRev,
          'CAS 重试必须携带最新远端版本号',
        );
        assert.equal(params.model, undefined, 'profiles.configure 严禁附带 model 等非目标字段');
        assert.equal(params.soul, undefined, 'profiles.configure 严禁附带 soul 等非目标字段');
        assert.equal(params.ui_meta?.[DONE_ROOMS_UI_META_KEY], undefined, 'folders 与 doneRooms 必须双键隔离');
        remoteFolders = params.ui_meta[FOLDERS_UI_META_KEY];
        foldersRev += 1;
        return {
          ok: true,
          applied: {
            ui_meta: true,
            ui_meta_revisions: { [FOLDERS_UI_META_KEY]: foldersRev },
          },
        };
      }
      if (params?.ui_meta?.[DONE_ROOMS_UI_META_KEY]) {
        remoteDoneRooms = params.ui_meta[DONE_ROOMS_UI_META_KEY];
        doneRev += 1;
        return {
          ok: true,
          applied: {
            ui_meta: true,
            ui_meta_revisions: { [DONE_ROOMS_UI_META_KEY]: doneRev },
          },
        };
      }
    }
    throw new Error(`Unexpected RPC: ${method}`);
  };
  const client = {
    call: clientCall,
    request: clientCall,
  };

  let connected = true;
  const adapter = new UiMetaConversationOrgAdapter(() => (connected ? client : null));
  const service = new ConversationOrgService(adapter);

  const hydrated = adapter.hydrateFromProfiles([
    {
      name: 'default',
      displayName: 'Default',
      isDefault: true,
      uiMeta: {
        [FOLDERS_UI_META_KEY]: remoteFolders,
        [DONE_ROOMS_UI_META_KEY]: remoteDoneRooms,
        'malformed-unrelated': 'keep',
      },
      uiMetaRevisions: {
        [FOLDERS_UI_META_KEY]: 1,
        [DONE_ROOMS_UI_META_KEY]: 3,
      },
    },
  ]);
  assert.equal(hydrated.folders.length, 1);
  assert.deepEqual(hydrated.doneRoomIds, ['room-old']);

  // CAS 冲突后自动 reload + 3-way merge + retry，双方新建文件夹均保留
  const afterCreate = await service.createFolder('本地新目录');
  assert.equal(afterCreate.folders.some((f) => f.name === '同事新建'), true, '远端并发新建目录必须保留');
  assert.equal(afterCreate.folders.some((f) => f.name === '本地新目录'), true, '本地新建目录必须合入保存');
  assert.equal(afterCreate.assignments['room:peer-r'], 'fld-peer', '远端并发归属映射必须保留');

  // 群聊完成态独立写入 done-rooms 键
  const afterDone = await service.setRoomDone('room-new', true);
  assert.ok(typeof afterDone.doneRoomsMap['room-new'] === 'number' && afterDone.doneRoomsMap['room-new'] > 0);
  assert.equal(afterDone.doneRoomsMap['room-old'], 500);

  // 未连接时显式报错且不脏写本地缓存
  connected = false;
  const snapBeforeFail = adapter.getCachedSnapshot();
  await assert.rejects(() => service.createFolder('离线目录'), /未连接|not connected|Gateway/i);
  assert.deepEqual(adapter.getCachedSnapshot().folders, snapBeforeFail.folders, '离线写失败不得伪造本地成功态');

  // 畸形 ui_meta 安全降级为空结构
  const broken = adapter.hydrateFromProfiles([
    {
      name: 'default',
      displayName: 'Default',
      isDefault: true,
      uiMeta: {
        [FOLDERS_UI_META_KEY]: 'corrupted',
        [DONE_ROOMS_UI_META_KEY]: { done: { '': -1, valid: 'nan' } },
      },
    },
  ]);
  assert.deepEqual(broken.folders, []);
  assert.deepEqual(broken.doneRoomIds, []);
});

test('UiMetaConversationOrgAdapter: done-rooms CAS 冲突合并与重试耗尽 Fail-Closed', async () => {
  let doneRev = 1;
  let remoteDoneRooms = { version: 1, done: { 'room-peer': 100 } };
  let doneConflictOnce = true;

  const doneCasCall = async (method, params) => {
    if (method === 'profiles.list') {
      return {
        profiles: [
          {
            name: 'default',
            is_default: true,
            ui_meta: { [DONE_ROOMS_UI_META_KEY]: remoteDoneRooms },
            ui_meta_revisions: { [DONE_ROOMS_UI_META_KEY]: doneRev },
          },
        ],
      };
    }
    if (method === 'profiles.configure') {
      assert.equal(params.name, 'default');
      assert.equal(params.model, undefined);
      assert.equal(params.soul, undefined);
      if (doneConflictOnce) {
        doneConflictOnce = false;
        doneRev = 2;
        remoteDoneRooms = { version: 1, done: { 'room-peer': 100, 'room-remote-new': 250 } };
        return {
          ok: false,
          applied: {
            ui_meta: false,
            ui_meta_conflicts: { [DONE_ROOMS_UI_META_KEY]: { expected: 1, actual: 2 } },
          },
        };
      }
      assert.equal(params.ui_meta_expected_revisions?.[DONE_ROOMS_UI_META_KEY], 2);
      remoteDoneRooms = params.ui_meta[DONE_ROOMS_UI_META_KEY];
      doneRev = 3;
      return {
        ok: true,
        applied: {
          ui_meta: true,
          ui_meta_revisions: { [DONE_ROOMS_UI_META_KEY]: doneRev },
        },
      };
    }
    throw new Error(`Unexpected RPC: ${method}`);
  };
  const doneAdapter = new UiMetaConversationOrgAdapter(() => ({ call: doneCasCall, request: doneCasCall }));
  const doneService = new ConversationOrgService(doneAdapter);
  doneAdapter.hydrateFromProfiles([
    {
      name: 'default',
      displayName: 'Default',
      isDefault: true,
      uiMeta: { [DONE_ROOMS_UI_META_KEY]: remoteDoneRooms },
      uiMetaRevisions: { [DONE_ROOMS_UI_META_KEY]: 1 },
    },
  ]);

  const mergedDone = await doneService.setRoomDone('room-local', true);
  assert.ok(mergedDone.doneRoomsMap['room-remote-new'] === 250, 'CAS 重试必须保留远端并发完成群');
  assert.ok(typeof mergedDone.doneRoomsMap['room-local'] === 'number', 'CAS 重试必须保留本地新完成群');

  // 2. 连续 4 次（超过 MAX_CAS_RETRIES = 3）持续冲突必须 Fail-Closed 且不脏改缓存快照
  let alwaysConflictConfigureCount = 0;
  const exhaustedCall = async (method) => {
    if (method === 'profiles.list') {
      return {
        profiles: [
          {
            name: 'default',
            is_default: true,
            ui_meta: {
              [FOLDERS_UI_META_KEY]: {
                version: 1,
                folders: [{ id: 'fld-init', name: '初始目录', order: 0, createdAt: 1, updatedAt: 1 }],
                assignments: {},
              },
            },
            ui_meta_revisions: { [FOLDERS_UI_META_KEY]: 5 },
          },
        ],
      };
    }
    if (method === 'profiles.configure') {
      alwaysConflictConfigureCount += 1;
      return {
        ok: false,
        applied: {
          ui_meta: false,
          ui_meta_conflicts: { [FOLDERS_UI_META_KEY]: { expected: 5, actual: 6 } },
        },
      };
    }
    throw new Error(`Unexpected RPC: ${method}`);
  };
  const exhaustedAdapter = new UiMetaConversationOrgAdapter(() => ({
    call: exhaustedCall,
    request: exhaustedCall,
  }));
  const exhaustedService = new ConversationOrgService(exhaustedAdapter);
  await exhaustedAdapter.loadSnapshot(true);
  const beforeFailedFolders = exhaustedAdapter.getCachedSnapshot().folders;

  await assert.rejects(
    () => exhaustedService.createFolder('注定失败目录'),
    /重试|retry|conflict/i,
  );
  assert.equal(alwaysConflictConfigureCount, 4, '初始写 + 3 次重试共 4 次后应停止并报错');
  assert.deepEqual(
    exhaustedAdapter.getCachedSnapshot().folders,
    beforeFailedFolders,
    'CAS 重试耗尽时本地缓存快照不得被脏修改',
  );
});
