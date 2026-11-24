/**
 * 项目树管理与会话归属服务（Project Operation Service · D15）纯逻辑单测
 * (packages/desktop/__tests__/unit/projectOperationService.test.mjs)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createProjectOperationService } from '../../dist/renderer/services/projectOperationService.mjs';

function createMockProjectDeps(overrides = {}) {
  let renderCount = 0;
  const state = {
    projects: [
      { id: 'initial-proj', name: 'Initial Project', path: '/workspace/initial' },
    ],
    profiles: [
      { name: 'bot-1', displayName: 'Bot 1', lastActive: 0, preview: '' },
      { name: 'bot-2', displayName: 'Bot 2', lastActive: 0, preview: '' },
    ],
    sessions: [
      { id: 'sess-1', title: 'Side Chat', botName: 'bot-1', preview: 'Side task preview', timestamp: 999999 },
    ],
    ...(overrides.state || {}),
  };

  const botActivityMap = new Map([
    ['bot-1', { lastMessage: 'Forever Chat Activity', timestamp: 1234567890 }],
  ]);

  const botActivityStore = {
    withActivityMap: (fn) => fn(botActivityMap),
    updateLatestActivity: (botName, text, timestamp) => {
      botActivityMap.set(botName, { text, timestamp });
    },
  };

  const botForeverChatCache = new Map([
    ['bot-1', 'forever-sess-bot-1'],
  ]);

  const sessionMessagesCache = new Map();

  const gatewayClient = overrides.gatewayClient ?? {
    call: async (method) => {
      if (method === 'projects.list') {
        return {
          projects: [
            { id: 'p1', name: 'Project Alpha', path: '/path/alpha' },
            { id: 'p2', name: 'Project Beta', path: '/path/beta' },
          ],
        };
      }
      return null;
    },
  };

  return {
    getState: () => state,
    getGatewayClient: () => gatewayClient,
    render: () => { renderCount++; },
    getRenderCount: () => renderCount,
    botActivityStore,
    botForeverChatCache,
    sessionMessagesCache,
    formatSessionTime: (ts) => `TIME:${ts}`,
  };
}

test('projectOperationService: fetchProjects normal resolution and mapping', async () => {
  const deps = createMockProjectDeps();
  const service = createProjectOperationService(deps);

  await service.fetchProjects();

  const state = deps.getState();
  assert.equal(state.projects.length, 2);
  assert.equal(state.projects[0].id, 'p1');
  assert.equal(state.projects[0].name, 'Project Alpha');
  assert.equal(state.projects[0].path, '/path/alpha');
  assert.equal(deps.getRenderCount() > 0, true);
});

test('projectOperationService: fetchProjects handles network failure with Failure Is Not Empty', async () => {
  const deps = createMockProjectDeps({
    gatewayClient: {
      call: async () => {
        throw new Error('Network timeout');
      },
    },
  });
  const service = createProjectOperationService(deps);

  await service.fetchProjects();

  const state = deps.getState();
  // 必须保留先前的项目，严禁抹杀为空
  assert.equal(state.projects.length, 1);
  assert.equal(state.projects[0].id, 'initial-proj');
  assert.equal(deps.getRenderCount() > 0, true);
});

test('projectOperationService: syncProfileLastMessages uses botActivity and foreverChatCache without being polluted by side sessions', () => {
  const deps = createMockProjectDeps();
  const service = createProjectOperationService(deps);

  service.syncProfileLastMessages();

  const state = deps.getState();
  const bot1 = state.profiles.find((p) => p.name === 'bot-1');
  assert.ok(bot1);
  // 必须来自 Forever Chat 活动，绝不能被普通旁聊 'Side task preview' 覆盖
  assert.equal(bot1.lastMessage, 'Forever Chat Activity');
  assert.equal(bot1.lastTime, 'TIME:1234567890');
});

test('projectOperationService: archived 项目过滤、畸形负载 Failure Is Not Empty 与 create/deleteProject', async () => {
  // 1. 仅保留未归档项目
  const withArchivedDeps = createMockProjectDeps({
    gatewayClient: {
      call: async (method) => {
        if (method === 'projects.list') {
          return {
            projects: [
              { id: 'p-live', name: 'Live Project', primary_path: '/work/live', archived: false },
              { id: 'p-arch', name: 'Archived Project', primary_path: '/work/old', archived: true },
            ],
          };
        }
        return {};
      },
    },
  });
  await createProjectOperationService(withArchivedDeps).fetchProjects();
  assert.deepEqual(
    withArchivedDeps.getState().projects.map((p) => p.id),
    ['p-live'],
    'archived: true 项目绝不能进入活跃项目列表',
  );

  // 2. 网关返回非法的空对象 {} 时，fallback 必须抛错触发 Failure Is Not Empty（保留既有项目或置 error）
  const malformedCachedDeps = createMockProjectDeps({
    gatewayClient: {
      call: async () => ({}),
    },
  });
  await createProjectOperationService(malformedCachedDeps).fetchProjects();
  assert.equal(malformedCachedDeps.getState().projects[0].id, 'initial-proj', '畸形响应绝不可将现有项目列表抹空');
  assert.equal(malformedCachedDeps.getState().settingsProjects.status, 'error');

  // 3. createProject 与 deleteProject 调用对应网关 RPC 并刷新列表
  const calls = [];
  let serverProjects = [{ id: 'p-1', name: 'One', primary_path: '/work/one', archived: false }];
  const crudRpc = async (method, params) => {
    calls.push({ method, params });
    if (method === 'projects.list') return { projects: serverProjects };
    if (method === 'projects.create') {
      serverProjects = [
        ...serverProjects,
        { id: 'p-2', name: params.name, primary_path: params.primary_path || params.path, archived: false },
      ];
      return { project: serverProjects[1] };
    }
    if (method === 'projects.delete') {
      serverProjects = serverProjects.filter((p) => p.id !== (params.project_id || params.id));
      return { ok: true };
    }
    return {};
  };
  const crudDeps = createMockProjectDeps({
    gatewayClient: {
      call: crudRpc,
      request: crudRpc,
    },
  });
  const crudSvc = createProjectOperationService(crudDeps);
  const createRes = await crudSvc.createProject({ name: 'Two', path: '/work/two' });
  assert.equal(createRes.ok, true);
  assert.equal(calls.some((c) => c.method === 'projects.create'), true);
  assert.equal(crudDeps.getState().projects.length, 2);

  // raw projects.list 响应保留 boardSlug / additionalFolders，并支持 updateProject 更新名称
  const updateCalls = [];
  let updatedOnce = false;
  const metaDeps = createMockProjectDeps({
    gatewayClient: {
      call: async (method, params) => {
        if (method === 'projects.list') {
          if (params?.profile) {
            throw new Error('force raw fallback');
          }
          return {
            projects: [
              {
                id: 'p-meta',
                name: updatedOnce ? 'RenamedRepo' : 'OriginalRepo',
                primary_path: '/work/meta',
                additional_folders: ['/work/meta-docs'],
                board_slug: 'meta-board',
                icon: 'folder',
                color: 'primary',
                archived: false,
              },
            ],
          };
        }
        return {};
      },
      request: async (method, params) => {
        updateCalls.push({ method, params });
        if (method === 'projects.update') {
          updatedOnce = true;
          return { project: { id: 'p-meta', name: params?.name || 'RenamedRepo' } };
        }
        if (method === 'projects.list') {
          if (!updatedOnce) {
            throw new Error('force raw');
          }
          return {
            projects: [
              {
                id: 'p-meta',
                name: 'RenamedRepo',
                primary_path: '/work/meta',
                additional_folders: ['/work/meta-docs'],
                board_slug: 'meta-board',
                icon: 'folder',
                color: 'primary',
                archived: false,
              },
            ],
          };
        }
        return {};
      },
    },
  });
  const metaSvc = createProjectOperationService(metaDeps);
  await metaSvc.fetchProjects();
  assert.equal(metaDeps.getState().projects[0].boardSlug, 'meta-board');
  assert.deepEqual(metaDeps.getState().projects[0].additionalFolders, ['/work/meta-docs']);
  assert.equal(metaDeps.getState().settingsProjects?.data?.[0]?.boardSlug, 'meta-board');

  const updRes = await metaSvc.updateProject('p-meta', { name: 'RenamedRepo' });
  assert.equal(updRes.ok, true);
  assert.equal(updateCalls.some((c) => c.method === 'projects.update' && c.params?.name === 'RenamedRepo'), true);
  assert.equal(metaDeps.getState().projects[0].name, 'RenamedRepo');

  const deleteRes = await crudSvc.deleteProject('p-1');
  assert.equal(deleteRes.ok, true);
  assert.equal(calls.some((c) => c.method === 'projects.delete'), true);
  assert.deepEqual(crudDeps.getState().projects.map((p) => p.id), ['p-2']);
});
