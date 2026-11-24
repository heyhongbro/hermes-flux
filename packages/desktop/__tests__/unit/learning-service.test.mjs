/**
 * 认知星图与记忆学习服务（Learning Service）行为单测
 * (packages/desktop/__tests__/unit/learning-service.test.mjs)
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createLearningService } from '../../dist/renderer/services/learningService.mjs';
import {
  LearningRestError,
  createLearningRest,
  describeLearningRestError,
  isLearningRestEndpointMissing,
} from '../../dist/renderer/learningRest.mjs';

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createHarness(clientImpl = null) {
  let renders = 0;
  const state = {
    learningState: { status: 'idle' },
    learningDetail: { status: 'idle' },
  };
  const service = createLearningService({
    getState: () => state,
    render: () => { renders += 1; },
    getGatewayClient: () => clientImpl,
    t: (k) => k,
    describeRpcError: (err) => (err instanceof Error ? err.message : String(err || '')),
  });
  return {
    state,
    getRenders: () => renders,
    service,
  };
}

test('createLearningService: !client 断连取消在途请求与 deleteLearningNode 使在途 detail 失效', async () => {
  let activeClient = null;
  const state = {
    learningState: { status: 'idle' },
    learningDetail: { status: 'idle' },
  };
  const service = createLearningService({
    state,
    getState: () => state,
    render: () => {},
    getGatewayClient: () => activeClient,
    t: (k) => k,
    describeRpcError: (e) => String(e),
  });

  const dGraphSlow = createDeferred();
  const dDetSlow = createDeferred();
  const dDetDel = createDeferred();
  let detSeq = 0;
  activeClient = {
    call: async (method) => {
      if (method === 'learning.frames') return dGraphSlow.promise;
      if (method === 'learning.detail') {
        detSeq += 1;
        return detSeq === 1 ? dDetSlow.promise : dDetDel.promise;
      }
      if (method === 'learning.delete') return { ok: true };
      return {};
    },
  };

  // 1. frames 请求途中变为 !client 后再触发 loadLearningGraph -> 后续旧响应不得覆写 error 态
  const pGraphSlow = service.loadLearningGraph(true);
  activeClient = null;
  await service.loadLearningGraph(true);
  assert.equal(state.learningState.status, 'error');
  dGraphSlow.resolve({ count: 1, buckets: [{ index: 0, nodes: [{ id: 'memory:late', label: 'late', style: 'memory', body: 'x' }] }] });
  await pGraphSlow;
  assert.equal(state.learningState.status, 'error');

  // 2. detail 请求途中变为 !client 后再触发 loadLearningDetail -> 旧响应不得覆写 error 态
  activeClient = {
    call: async (method) => {
      if (method === 'learning.detail') return dDetSlow.promise;
      return {};
    },
  };
  const pDetSlow = service.loadLearningDetail('memory:1');
  activeClient = null;
  await service.loadLearningDetail('memory:2');
  assert.equal(state.learningDetail.status, 'error');
  dDetSlow.resolve({ ok: true, id: 'memory:1', kind: 'memory', label: 'm1', content: 'stale' });
  await pDetSlow;
  assert.equal(state.learningDetail.status, 'error');

  // 3. detail 加载期间触发 deleteLearningNode -> 必须递增 detailGen 丢弃迟到详情
  activeClient = {
    call: async (method) => {
      if (method === 'learning.detail') return dDetDel.promise;
      if (method === 'learning.delete') return { ok: true };
      if (method === 'learning.frames') return { count: 0, buckets: [] };
      return {};
    },
  };
  const pDetBeforeDel = service.loadLearningDetail('memory:9');
  const delRes = await service.deleteLearningNode('memory:9');
  assert.equal(delRes.ok, true);
  assert.equal(state.learningDetail.status, 'idle');
  dDetDel.resolve({ ok: true, id: 'memory:9', kind: 'memory', label: 'm9', content: 'resurrected' });
  await pDetBeforeDel;
  assert.equal(state.learningDetail.status, 'idle');

  // 4. 请求途中 disconnect() 置空 client 并清空 state -> 在途 resolve 与 reject 均不得覆写 { status: 'idle' }
  const dGraphDisc = createDeferred();
  const dGraphDiscRej = createDeferred();
  const dDetDisc = createDeferred();
  const dDetDiscRej = createDeferred();
  const dEditDisc = createDeferred();
  const dDelDisc = createDeferred();
  let discGraphSeq = 0;
  let discDetSeq = 0;
  activeClient = {
    call: async (method) => {
      if (method === 'learning.frames') {
        discGraphSeq += 1;
        return discGraphSeq === 1 ? dGraphDisc.promise : dGraphDiscRej.promise;
      }
      if (method === 'learning.detail') {
        discDetSeq += 1;
        return discDetSeq === 1 ? dDetDisc.promise : dDetDiscRej.promise;
      }
      if (method === 'learning.edit') return dEditDisc.promise;
      if (method === 'learning.delete') return dDelDisc.promise;
      return {};
    },
  };

  const pG1 = service.loadLearningGraph(true);
  activeClient = null;
  state.learningState = { status: 'idle' };
  dGraphDisc.resolve({ count: 1, buckets: [{ index: 0, nodes: [{ id: 'memory:x', label: 'x', style: 'memory', body: 'x' }] }] });
  await pG1;
  assert.deepEqual(state.learningState, { status: 'idle' });

  activeClient = {
    call: async () => dGraphDiscRej.promise,
  };
  const pG2 = service.loadLearningGraph(true);
  activeClient = null;
  state.learningState = { status: 'idle' };
  dGraphDiscRej.reject(new Error('Client disconnected'));
  await pG2;
  assert.deepEqual(state.learningState, { status: 'idle' });

  activeClient = {
    call: async () => dDetDisc.promise,
  };
  const pD1 = service.loadLearningDetail('memory:d1');
  activeClient = null;
  state.learningDetail = { status: 'idle' };
  dDetDisc.resolve({ ok: true, id: 'memory:d1', kind: 'memory', label: 'd1', content: 'x' });
  await pD1;
  assert.deepEqual(state.learningDetail, { status: 'idle' });

  activeClient = {
    call: async () => dDetDiscRej.promise,
  };
  const pD2 = service.loadLearningDetail('memory:d2');
  activeClient = null;
  state.learningDetail = { status: 'idle' };
  dDetDiscRej.reject(new Error('Client disconnected'));
  await pD2;
  assert.deepEqual(state.learningDetail, { status: 'idle' });

  // editLearningNode / deleteLearningNode 等待期间断连 -> 返回离线错误且不触发后续重拉
  let mutationRefreshCalled = false;
  activeClient = {
    call: async (method) => {
      if (method === 'learning.edit') return dEditDisc.promise;
      if (method === 'learning.delete') return dDelDisc.promise;
      mutationRefreshCalled = true;
      return {};
    },
  };
  const pEditDisc = service.editLearningNode('memory:e1', 'new');
  activeClient = null;
  dEditDisc.resolve({ ok: true });
  assert.deepEqual(await pEditDisc, { ok: false, message: 'chat.gatewayNotConnected' });

  activeClient = {
    call: async (method) => {
      if (method === 'learning.delete') return dDelDisc.promise;
      mutationRefreshCalled = true;
      return {};
    },
  };
  const pDelDisc = service.deleteLearningNode('memory:e1');
  activeClient = null;
  dDelDisc.resolve({ ok: true });
  assert.deepEqual(await pDelDisc, { ok: false, message: 'chat.gatewayNotConnected' });
  assert.equal(mutationRefreshCalled, false);

  // editLearningNode 成功后在 loadLearningDetail 途中断连 -> 直接返回 { ok: true }，不得继续触发 loadLearningGraph 将 learningState 覆写为 error
  const dDetailMidDisc = createDeferred();
  let framesCalledAfterDetailDisc = false;
  activeClient = {
    call: async (method) => {
      if (method === 'learning.edit') return { ok: true };
      if (method === 'learning.detail') return dDetailMidDisc.promise;
      if (method === 'learning.frames') framesCalledAfterDetailDisc = true;
      return {};
    },
  };
  const pEditMidDisc = service.editLearningNode('memory:e2', 'updated');
  await new Promise((r) => setTimeout(r, 5));
  activeClient = null;
  state.learningState = { status: 'idle' };
  state.learningDetail = { status: 'idle' };
  dDetailMidDisc.resolve({ ok: true, id: 'memory:e2', kind: 'memory', label: 'e2', content: 'updated' });
  assert.deepEqual(await pEditMidDisc, { ok: true });
  assert.equal(framesCalledAfterDetailDisc, false);
  assert.deepEqual(state.learningState, { status: 'idle' });
});

test('createLearningService 全分支：图谱加载/防重入/代数丢弃/详情/编辑保存与删除清除', async () => {
  // 1. 网关离线分支
  const off = createHarness(null);
  await off.service.loadLearningGraph();
  assert.equal(off.state.learningState.status, 'error');
  await off.service.loadLearningDetail('   ');
  assert.equal(off.state.learningDetail.status, 'idle');
  await off.service.loadLearningDetail('memory:1');
  assert.equal(off.state.learningDetail.status, 'error');
  assert.equal((await off.service.editLearningNode('memory:1', 'x')).ok, false);
  assert.equal((await off.service.deleteLearningNode('memory:1')).ok, false);

  // 2. 在线全分支：frames + 代数乱序丢弃 + error 回落
  let framesHandler;
  let detailHandler;
  let editHandler;
  let deleteHandler;
  const client = {
    call: async (method, params) => {
      if (method === 'learning.frames') return framesHandler(params);
      if (method === 'learning.detail') return detailHandler(params);
      if (method === 'learning.edit') return editHandler(params);
      if (method === 'learning.delete') return deleteHandler(params);
      return {};
    },
  };
  const on = createHarness(client);

  const d1 = createDeferred();
  const d2 = createDeferred();
  let frameCallCount = 0;
  framesHandler = () => {
    frameCallCount += 1;
    return frameCallCount === 1 ? d1.promise : d2.promise;
  };
  const pSlow = on.service.loadLearningGraph(true);
  // loading 时非 force 重入必须直接返回
  await on.service.loadLearningGraph(false);
  assert.equal(frameCallCount, 1);

  const pFast = on.service.loadLearningGraph(true);
  d2.resolve({
    count: 2,
    summary: ['1 learned skills · 1 memories'],
    buckets: [
      {
        index: 0,
        nodes: [
          { id: 'skill:alpha', label: 'alpha', style: 'learned-skill', body: '<!-- uses: 2 --> Skill body' },
          { id: 'memory:1', label: 'mem1', style: 'memory', body: 'Mem body' },
        ],
      },
    ],
  });
  await pFast;
  d1.resolve({ count: 0, buckets: [] });
  await pSlow;
  assert.equal(on.state.learningState.status, 'ready');
  assert.equal(on.state.learningState.graph.nodes.length, 2);

  // ready 时非 force 不重拉
  await on.service.loadLearningGraph(false);
  assert.equal(frameCallCount, 2);

  // frames 乱序异常 vs 当代异常（含空 err 描述回退）
  const eSlow = createDeferred();
  const eFast = createDeferred();
  framesHandler = () => {
    frameCallCount += 1;
    return frameCallCount === 3 ? eSlow.promise : eFast.promise;
  };
  const pErrSlow = on.service.loadLearningGraph(true);
  const pErrFast = on.service.loadLearningGraph(true);
  eFast.reject('');
  await pErrFast;
  assert.equal(on.state.learningState.status, 'error');
  assert.equal(on.state.learningState.message, 'mobile.memory.loadError');
  eSlow.reject(new Error('stale err'));
  await pErrSlow;

  // 3. loadLearningDetail 全分支（!ok, skill/memory, 乱序, 异常回落）
  const dd1 = createDeferred();
  const dd2 = createDeferred();
  let detCount = 0;
  detailHandler = () => {
    detCount += 1;
    return detCount === 1 ? dd1.promise : dd2.promise;
  };
  const dp1 = on.service.loadLearningDetail('skill:alpha');
  const dp2 = on.service.loadLearningDetail('memory:1');
  dd2.resolve({ ok: true, id: '', kind: undefined, label: '', content: '' });
  await dp2;
  dd1.resolve({ ok: false, message: 'stale' });
  await dp1;
  assert.equal(on.state.learningDetail.status, 'ready');
  assert.equal(on.state.learningDetail.id, 'memory:1');
  assert.equal(on.state.learningDetail.kind, 'memory');

  detailHandler = async () => ({ ok: false, message: '' });
  await on.service.loadLearningDetail('skill:alpha');
  assert.equal(on.state.learningDetail.status, 'error');
  assert.equal(on.state.learningDetail.message, 'mobile.memory.loadError');

  const de1 = createDeferred();
  const de2 = createDeferred();
  let deIdx = 0;
  detailHandler = () => (++deIdx === 1 ? de1.promise : de2.promise);
  const dep1 = on.service.loadLearningDetail('skill:alpha');
  const dep2 = on.service.loadLearningDetail('skill:alpha');
  de2.reject('');
  await dep2;
  de1.reject(new Error('old detail error'));
  await dep1;
  assert.equal(on.state.learningDetail.status, 'error');
  assert.equal(on.state.learningDetail.message, 'mobile.memory.loadError');

  detailHandler = async () => ({ ok: true, id: 'skill:alpha', kind: 'skill', label: 'alpha', content: 'Full skill' });
  await on.service.loadLearningDetail('skill:alpha');
  assert.equal(on.state.learningDetail.kind, 'skill');

  // 非 memory: 前缀但 kind 明确为 'memory' vs kind 缺失回落 'skill'
  detailHandler = async () => ({ ok: true, id: 'custom-node', kind: 'memory', label: 'C', content: 'Mem' });
  await on.service.loadLearningDetail('custom-node');
  assert.equal(on.state.learningDetail.kind, 'memory');
  detailHandler = async () => ({ ok: true, id: 'custom-node', label: 'C', content: 'Skill' });
  await on.service.loadLearningDetail('custom-node');
  assert.equal(on.state.learningDetail.kind, 'skill');

  // 4. editLearningNode 与 deleteLearningNode
  framesHandler = async () => ({ count: 1, buckets: [{ index: 0, nodes: [{ id: 'skill:alpha', label: 'alpha', style: 'learned-skill', body: 'Updated' }] }] });
  editHandler = async () => ({ ok: false });
  assert.equal((await on.service.editLearningNode('skill:alpha', 'x')).message, 'settings.loadFailed');
  editHandler = async () => {
    throw new Error('edit err');
  };
  assert.equal((await on.service.editLearningNode('skill:alpha', 'x')).message, 'edit err');
  editHandler = async () => ({ ok: true });
  assert.equal((await on.service.editLearningNode('skill:alpha', 'Updated')).ok, true);

  deleteHandler = async () => ({ ok: false, message: '' });
  assert.equal((await on.service.deleteLearningNode('skill:alpha')).message, 'settings.loadFailed');
  deleteHandler = async () => ({ ok: false, message: 'denied' });
  assert.equal((await on.service.deleteLearningNode('skill:alpha')).message, 'denied');
  deleteHandler = async () => {
    throw new Error('del err');
  };
  assert.equal((await on.service.deleteLearningNode('skill:alpha')).message, 'del err');
  deleteHandler = async () => ({ ok: true });
  // 先删非当前 detail 节点，detail 不清空；再删当前 detail 节点，detail 清回 idle
  assert.equal((await on.service.deleteLearningNode('memory:other')).ok, true);
  assert.equal(on.state.learningDetail.status, 'ready');
  detailHandler = async () => ({ ok: true, id: 'skill:alpha', kind: 'skill', label: 'alpha', content: 'Full skill' });
  await on.service.loadLearningDetail('skill:alpha');
  assert.equal((await on.service.deleteLearningNode('skill:alpha')).ok, true);
  assert.equal(on.state.learningDetail.status, 'idle');
  // status 已是 idle 时再次删除节点仍安全成功
  assert.equal((await on.service.deleteLearningNode('skill:alpha')).ok, true);
});

test('learningRest 错误解析与 IPC 包装异常分类', () => {
  assert.deepEqual(
    describeLearningRestError(new Error("Error invoking remote method 'gateway:httpProxy': Error: HTTP 404: Not Found")),
    { status: 404, message: 'Not Found' },
  );
  assert.equal(isLearningRestEndpointMissing(new LearningRestError(404, 'Not Found')), true);
  assert.equal(isLearningRestEndpointMissing(new LearningRestError(405, 'Method Not Allowed')), true);
  assert.equal(isLearningRestEndpointMissing(new LearningRestError(501, 'Not Implemented')), true);
  assert.equal(isLearningRestEndpointMissing(new LearningRestError(401, 'Unauthorized')), false);
  assert.equal(isLearningRestEndpointMissing(new LearningRestError(500, 'Server Error')), false);
});

test('createLearningService: 多 Bot Profile 物理隔离、缓存隔离、跨 Bot 乱序围栏与 REST 404 分级回退', async () => {
  const calls = [];
  const state = {
    gatewayUrl: 'http://127.0.0.1:8789',
    profileName: 'default',
    profiles: [
      { name: 'default', displayName: 'DEFAULT BOT', isDefault: true },
      { name: 'arch', displayName: 'Architect Bot', isDefault: false },
    ],
    learningState: { status: 'idle' },
    learningDetail: { status: 'idle' },
  };
  let client = {
    call: async (method, params) => {
      calls.push(['ws', method, params]);
      if (method === 'learning.frames') {
        return {
          count: 1,
          buckets: [{ index: 0, nodes: [{ id: 'skill:default-only', label: 'default-only', style: 'skill', body: 'Default skill' }] }],
        };
      }
      if (method === 'profiles.describe') {
        return {
          name: params.profile,
          skills: [
            { name: 'arch-review', enabled: true, description: 'Architecture audit via git-diff' },
            { name: 'git-diff', enabled: true, description: 'Inspect diffs' },
          ],
        };
      }
      if (method === 'skills.manage') {
        return { ok: true, markdown: '# arch-review\nDetailed skill guide' };
      }
      if (method === 'command.dispatch') {
        return { ok: true, output: 'Usage guide' };
      }
      if (method === 'learning.detail') {
        return { ok: true, id: params.id, kind: 'skill', label: 'default-only', content: 'Default WS detail' };
      }
      if (method === 'learning.edit' || method === 'learning.delete') {
        return { ok: true };
      }
      return {};
    },
  };

  let proxyHandler = async ({ path, method, params, body }) => {
    calls.push(['rest', method || 'GET', path, params, body]);
    const prof = params?.profile || 'default';
    if (path === '/api/learning/graph') {
      return {
        profile: prof,
        nodes: [
          {
            id: `skill:${prof}-skill`,
            kind: 'skill',
            label: `${prof}-skill`,
            description: `Exclusive to ${prof}`,
            uses: prof === 'arch' ? 12 : 3,
          },
          {
            id: `memory:${prof}:1`,
            kind: 'memory',
            label: `Memory for ${prof}`,
            body: `Uses skill:${prof}-skill`,
          },
        ],
        edges: [],
      };
    }
    if (path === '/api/learning/node' && (method || 'GET') === 'GET') {
      return { ok: true, node: { id: params.id, kind: 'skill', label: `${prof}:${params.id}`, content: `# Content for ${prof}` } };
    }
    if (path === '/api/learning/node' && (method === 'PUT' || method === 'DELETE')) {
      return { ok: true };
    }
    throw new Error(`HTTP 404: unexpected ${path}`);
  };

  const service = createLearningService({
    getState: () => state,
    render: () => {},
    getGatewayClient: () => client,
    getDesktopApi: () => ({ httpProxy: (opts) => proxyHandler(opts) }),
    getCurrentTicket: () => 't-1',
    getEffectiveUrl: (u) => u,
    t: (k) => k,
    describeRpcError: (e) => (e instanceof Error ? e.message : String(e || '')),
  });

  // 1. 不同 Bot 加载各自 REST 图谱，绝不串台，且命中缓存
  await service.loadLearningGraph({ profile: 'default' });
  assert.equal(state.learningState.status, 'ready');
  assert.equal(state.learningState.profile, 'default');
  assert.equal(state.learningState.graph.nodes[0].id, 'skill:default-skill');

  await service.loadLearningGraph({ profile: 'arch' });
  assert.equal(state.learningState.status, 'ready');
  assert.equal(state.learningState.profile, 'arch');
  assert.equal(state.learningState.graph.profile, 'arch');
  assert.equal(state.learningState.graph.nodes[0].id, 'skill:arch-skill');

  // 非强制切回 default 命中缓存，不重发 REST
  const beforeCacheCount = calls.length;
  await service.loadLearningGraph({ profile: 'default' });
  assert.equal(calls.length, beforeCacheCount);
  assert.equal(state.learningState.profile, 'default');
  assert.equal(state.learningState.graph.nodes[0].id, 'skill:default-skill');

  // REST 节点详情、编辑与删除透传正确 profile
  await service.loadLearningDetail('skill:arch-skill', 'arch');
  assert.equal(state.learningDetail.status, 'ready');
  assert.equal(state.learningDetail.profile, 'arch');
  assert.equal(state.learningDetail.content, '# Content for arch');
  assert.deepEqual(await service.editLearningNode('skill:arch-skill', 'Updated arch skill', 'arch'), { ok: true });
  assert.ok(calls.some((c) => c[0] === 'rest' && c[1] === 'PUT' && c[3]?.profile === 'arch'));
  assert.deepEqual(await service.deleteLearningNode('skill:arch-skill', 'arch'), { ok: true });
  assert.ok(calls.some((c) => c[0] === 'rest' && c[1] === 'DELETE' && c[3]?.profile === 'arch'));

  // 2. Client 实例变更后缓存自动清空
  const nextClient = { call: client.call };
  client = nextClient;
  const beforeReconnectCalls = calls.length;
  await service.loadLearningGraph({ profile: 'default' });
  assert.ok(calls.length > beforeReconnectCalls, '新 gatewayClient 必须清空缓存重拉');

  // 3. 跨 Bot 慢响应乱序抵达不得覆写新 Bot 状态
  const slowDefault = createDeferred();
  const fastArch = createDeferred();
  proxyHandler = async ({ params }) =>
    params?.profile === 'arch' ? fastArch.promise : slowDefault.promise;
  const pDefault = service.loadLearningGraph({ profile: 'default', force: true });
  const pArch = service.loadLearningGraph({ profile: 'arch', force: true });
  fastArch.resolve({
    profile: 'arch',
    nodes: [{ id: 'skill:arch-fresh', kind: 'skill', label: 'arch-fresh', uses: 9 }],
    edges: [],
  });
  await pArch;
  slowDefault.resolve({
    profile: 'default',
    nodes: [{ id: 'skill:default-stale', kind: 'skill', label: 'default-stale', uses: 1 }],
    edges: [],
  });
  await pDefault;
  assert.equal(state.learningState.profile, 'arch');
  assert.equal(state.learningState.graph.nodes[0].id, 'skill:arch-fresh');

  // 4. 非 404 错误 (HTTP 500) 必须显式落入 error，严禁静默降级
  proxyHandler = async () => {
    throw new Error('HTTP 500: Internal gateway failure');
  };
  await service.loadLearningGraph({ profile: 'arch', force: true });
  assert.equal(state.learningState.status, 'error');
  assert.equal(state.learningState.profile, 'arch');
  assert.match(state.learningState.message, /Internal gateway failure/);

  // 5. REST 返回 404 时：
  //    - non-default Bot 绝不调 learning.frames，改用 profiles.describe({ profile }) 构建专属技能图；
  //    - non-default 写操作（edit/delete）显式拒绝，避免错写到 default Bot！
  calls.length = 0;
  proxyHandler = async () => {
    throw new Error("Error invoking remote method 'gateway:httpProxy': Error: HTTP 404: Not Found");
  };
  await service.loadLearningGraph({ profile: 'arch', force: true });
  assert.equal(state.learningState.status, 'ready');
  assert.equal(state.learningState.profile, 'arch');
  assert.equal(state.learningState.graph.source, 'profile-skills');
  assert.ok(state.learningState.graph.nodes.some((n) => n.id === 'skill:arch-review'));
  assert.equal(
    calls.some((c) => c[0] === 'ws' && c[1] === 'learning.frames'),
    false,
    '非 default Bot 在 REST 404 时绝不能回退到无 profile 的 learning.frames',
  );

  // non-default REST 404 时查 skill 详情走 skills.manage(profile)，memory 详情报错，edit/delete 显式拒绝
  await service.loadLearningDetail('skill:arch-review', 'arch');
  assert.equal(state.learningDetail.status, 'ready');
  assert.match(state.learningDetail.content, /Detailed skill guide/);
  await service.loadLearningDetail('memory:arch:1', 'arch');
  assert.equal(state.learningDetail.status, 'error');
  const blockedEdit = await service.editLearningNode('skill:arch-review', 'new body', 'arch');
  assert.equal(blockedEdit.ok, false);
  assert.equal(blockedEdit.message, 'mobile.memory.profileWriteUnsupported');
  const blockedDelete = await service.deleteLearningNode('skill:arch-review', 'arch');
  assert.equal(blockedDelete.ok, false);
  assert.equal(blockedDelete.message, 'mobile.memory.profileWriteUnsupported');

  // default Bot REST 404 时安全回退 WS learning.*
  await service.loadLearningGraph({ profile: 'default', force: true });
  assert.equal(state.learningState.status, 'ready');
  assert.equal(state.learningState.graph.nodes[0].id, 'skill:default-only');
  assert.ok(calls.some((c) => c[0] === 'ws' && c[1] === 'learning.frames'));

  // createLearningRest 独立构造与非对象容错
  const rawRest = createLearningRest({
    baseUrl: () => 'http://127.0.0.1:8789',
    ticket: () => '',
    proxy: async () => null,
  });
  assert.deepEqual(await rawRest.editNode('arch', 'id-1', 'c'), { ok: true });
  assert.deepEqual(await rawRest.deleteNode('arch', 'id-1'), { ok: true });
  assert.equal((await rawRest.fetchNodeDetail('arch', 'id-1')).ok, false);
});

test('learningRest 全分支解析与 learningService complete.slash / 串台阻断 / 降级读写全路径', async () => {
  // 1. describeLearningRestError 非 HTTP / 非 Error 异常分支
  assert.deepEqual(describeLearningRestError(new Error('socket hangup')), {
    status: 0,
    message: 'socket hangup',
  });
  assert.deepEqual(describeLearningRestError('raw network down'), {
    status: 0,
    message: 'raw network down',
  });

  // 2. createLearningRest 全 payload 形态归并与显式失败透传
  let mockRestRes = null;
  const rest = createLearningRest({
    baseUrl: () => 'http://127.0.0.1:8789',
    ticket: () => 'tk',
    proxy: async () => {
      if (mockRestRes instanceof Error) throw mockRestRes;
      return mockRestRes;
    },
  });

  mockRestRes = {
    id: 'deploy-tool',
    kind: 'learned-skill',
    title: 'Deploy Tool',
    markdown: '# Deploy Markdown',
  };
  assert.deepEqual(await rest.fetchNodeDetail('arch', 'deploy-tool'), {
    ok: true,
    id: 'deploy-tool',
    kind: 'skill',
    label: 'Deploy Tool',
    content: '# Deploy Markdown',
    message: undefined,
  });

  mockRestRes = {
    node: {
      id: 'mem-flat',
      style: 'memory',
      name: 'Mem Name',
      full_label: 'Full memory label',
    },
  };
  assert.deepEqual(await rest.fetchNodeDetail('arch', 'mem-flat'), {
    ok: true,
    id: 'mem-flat',
    kind: 'memory',
    label: 'Mem Name',
    content: 'Full memory label',
    message: undefined,
  });

  mockRestRes = { ok: false, detail: 'forbidden node' };
  assert.equal((await rest.fetchNodeDetail('arch', 'x')).ok, false);
  assert.equal((await rest.editNode('arch', 'x', 'b')).ok, false);
  assert.equal((await rest.editNode('arch', 'x', 'b')).message, 'forbidden node');
  assert.deepEqual(await rest.deleteNode('arch', 'x'), { ok: false, message: 'forbidden node' });

  // 3. complete.slash 使用契约 CompletionItem { text, meta, kind } + filter kind === 'skill'
  //    以及 fetchSkillDetailWsFallback (command.dispatch 单侧降级 / 双失败报错) 和 !rest 路径
  const wsCalls = [];
  let dispatchFail = false;
  let inspectFail = true;
  const stateNoRest = {
    gatewayUrl: 'http://127.0.0.1:8789',
    profileName: 'default',
    profiles: [{ name: 'arch', displayName: 'Architect', isDefault: false }],
    learningState: { status: 'idle' },
    learningDetail: { status: 'idle' },
  };
  const wsClient = {
    call: async (method, params) => {
      wsCalls.push([method, params]);
      if (method === 'profiles.describe') {
        return {
          name: params.profile,
          skills: [
            { name: 'arch-review', enabled: true },
            { name: 'help', enabled: true },
          ],
        };
      }
      if (method === 'complete.slash') {
        return {
          items: [
            { text: '/arch-review', meta: 'Contract slash skill desc', kind: 'skill' },
            { text: '/help', meta: 'Built-in command must be ignored', kind: 'command' },
          ],
        };
      }
      if (method === 'skills.manage') {
        if (inspectFail) throw new Error('inspect down');
        return { ok: true, markdown: 'From inspect' };
      }
      if (method === 'command.dispatch') {
        if (dispatchFail) throw new Error('dispatch down');
        return { type: 'skill', message: '# Dispatch fallback body' };
      }
      if (method === 'learning.detail') {
        return { ok: true, id: params.id, kind: 'memory', label: 'Def M', content: 'Default mem body' };
      }
      if (method === 'learning.edit' || method === 'learning.delete') {
        return { ok: true };
      }
      return {};
    },
  };

  const svcNoRest = createLearningService({
    getState: () => stateNoRest,
    render: () => {},
    getGatewayClient: () => wsClient,
    t: (k) => k,
    describeRpcError: (e) => (e instanceof Error ? e.message : String(e || '')),
  });

  await svcNoRest.loadLearningGraph({ profile: 'arch', force: true });
  assert.equal(stateNoRest.learningState.status, 'ready');
  const slashSkill = stateNoRest.learningState.graph.nodes.find((n) => n.id === 'skill:arch-review');
  const ignoredCmd = stateNoRest.learningState.graph.nodes.find((n) => n.id === 'skill:help');
  assert.equal(slashSkill?.description, 'Contract slash skill desc', 'complete.slash 必须按 CompletionItem.text 匹配技能简介');
  assert.equal(ignoredCmd?.description, undefined, 'kind=command 的 slash 项不得污染同名技能说明');

  // 无 REST 时非 default 查 skill：skills.manage 失败但 command.dispatch 成功时平顺降级
  await svcNoRest.loadLearningDetail('skill:arch-review', 'arch');
  assert.equal(stateNoRest.learningDetail.status, 'ready');
  assert.equal(stateNoRest.learningDetail.content, '# Dispatch fallback body');

  // 双失败必须显式落入 error
  dispatchFail = true;
  await svcNoRest.loadLearningDetail('skill:arch-review', 'arch');
  assert.equal(stateNoRest.learningDetail.status, 'error');
  assert.match(stateNoRest.learningDetail.message, /inspect down/);

  // 无 REST 时非 default 写操作拒绝
  assert.equal((await svcNoRest.editLearningNode('skill:arch-review', 'x', 'arch')).message, 'mobile.memory.profileWriteUnsupported');
  assert.equal((await svcNoRest.deleteLearningNode('skill:arch-review', 'arch')).message, 'mobile.memory.profileWriteUnsupported');

  // 4. REST 显式返回错误 profile（疑似忽略 ?profile= 返回 default）必须拒绝缓存并报错
  let restGraphResponse = {
    profile: 'default',
    nodes: [{ id: 'skill:default-leak', kind: 'skill', label: 'default-leak', uses: 99 }],
    edges: [],
  };
  let restErrMode = null;
  const stateWithRest = {
    gatewayUrl: 'http://127.0.0.1:8789',
    profileName: 'default',
    profiles: [],
    learningState: { status: 'idle' },
    learningDetail: { status: 'idle' },
  };
  const svcWithRest = createLearningService({
    getState: () => stateWithRest,
    render: () => {},
    getGatewayClient: () => wsClient,
    getDesktopApi: () => ({
      httpProxy: async ({ path }) => {
        if (restErrMode === '404') throw new Error('HTTP 404: Missing');
        if (restErrMode === '500') throw new Error('HTTP 500: Boom');
        if (path === '/api/learning/graph') return restGraphResponse;
        throw new Error('HTTP 500: Boom');
      },
    }),
    t: (k) => k,
    describeRpcError: (e) => (e instanceof Error ? e.message : String(e || '')),
  });

  await svcWithRest.loadLearningGraph({ profile: 'arch', force: true });
  assert.equal(stateWithRest.learningState.status, 'error', 'REST 返回不匹配 profile 时必须拒绝并进入 error');
  assert.match(stateWithRest.learningState.message, /Profile mismatch/);
  restErrMode = null;
  // 验证上一次失败没有污染 arch 缓存
  restGraphResponse = {
    profile: 'arch',
    nodes: [{ id: 'skill:arch-ok', kind: 'skill', label: 'arch-ok', uses: 4 }],
    edges: [],
  };
  await svcWithRest.loadLearningGraph({ profile: 'arch', force: false });
  assert.equal(stateWithRest.learningState.status, 'ready');
  assert.equal(stateWithRest.learningState.graph.nodes[0].id, 'skill:arch-ok');

  // 5. REST 500 在详情/编辑/删除上报错，REST 404 在 default 上安全回退 WS learning.detail/edit/delete
  restErrMode = '500';
  await svcWithRest.loadLearningDetail('memory:m1', 'default');
  assert.equal(stateWithRest.learningDetail.status, 'error');
  assert.match(stateWithRest.learningDetail.message, /Boom/);
  assert.match((await svcWithRest.editLearningNode('memory:m1', 'x', 'default')).message, /Boom/);
  assert.match((await svcWithRest.deleteLearningNode('memory:m1', 'default')).message, /Boom/);

  restErrMode = '404';
  wsCalls.length = 0;
  await svcWithRest.loadLearningDetail('memory:def-1', 'default');
  assert.equal(stateWithRest.learningDetail.status, 'ready');
  assert.equal(stateWithRest.learningDetail.content, 'Default mem body');
  assert.equal((await svcWithRest.editLearningNode('memory:def-1', 'edit body', 'default')).ok, true);
  assert.equal((await svcWithRest.deleteLearningNode('memory:def-1', 'default')).ok, true);
  assert.ok(wsCalls.some(([m]) => m === 'learning.detail'));
  assert.ok(wsCalls.some(([m]) => m === 'learning.edit'));
  assert.ok(wsCalls.some(([m]) => m === 'learning.delete'));
});

test('learningRest 错误构造/字段归一与 learningService cache-detail清理/resolveRestAdapter 全分支覆盖', async () => {
  // 1. LearningRestError 空 detail & 非 Error 异常 & HTTP 无详情行
  const bareErr = new LearningRestError(502, '');
  assert.equal(bareErr.message, 'HTTP 502');
  assert.deepEqual(describeLearningRestError(bareErr), { status: 502, message: 'HTTP 502' });
  assert.deepEqual(describeLearningRestError(null), { status: 0, message: '' });
  assert.deepEqual(describeLearningRestError(new Error('HTTP 404')), { status: 404, message: 'HTTP 404' });

  // fetchNodeDetail: kind 未传时分别按 memory: 与 skill: 推断，以及 ok: true / 空对象分支
  const responses = [
    { ok: true, markdown: '# M' },
    { id: 'skill:bare', body: 'body' },
    {},
    { ok: false, content: 'denied' },
  ];
  const rest = createLearningRest({
    baseUrl: () => 'http://127.0.0.1:8789',
    ticket: () => 't1',
    proxy: async () => responses.shift(),
  });
  const memDetail = await rest.fetchNodeDetail('arch', 'memory:m9');
  assert.equal(memDetail.kind, 'memory');
  assert.equal(memDetail.ok, true);
  const skillDetail = await rest.fetchNodeDetail('arch', 'skill:bare');
  assert.equal(skillDetail.kind, 'skill');
  assert.equal(skillDetail.ok, true);
  const emptyObj = await rest.fetchNodeDetail('arch', 'skill:empty');
  assert.equal(emptyObj.ok, false);
  const explicitFalse = await rest.fetchNodeDetail('arch', 'skill:denied');
  assert.equal(explicitFalse.ok, false);

  // 2. learningService: 命中缓存时若 learningDetail 属于不同 profile 则递增 detailGen 并清空；
  //    通过 getDesktopApi().httpProxy 自动构造 restAdapter（覆盖有/无 getEffectiveUrl、空 URL 退化及无 rest 读非 default memory）
  let effectiveGateway = '';
  let useEffectiveUrl = true;
  const wsClient = {
    async call(method) {
      if (method === 'skills.manage') return { skills: [{ name: 'empty-skill' }] };
      if (method === 'command.dispatch') throw new Error('dispatch rejected');
      if (method === 'profiles.describe') return { profile: { name: 'arch' }, skills: [] };
      return {};
    },
  };
  let curClient = wsClient;
  const st = {
    gatewayUrl: '  ',
    profileName: 'default',
    profiles: [],
    learningState: { status: 'idle' },
    learningDetail: { status: 'idle' },
  };
  const svc = createLearningService({
    getState: () => st,
    render: () => {},
    getGatewayClient: () => curClient,
    getDesktopApi: () => ({
      httpProxy: async ({ path, params }) => {
        if (path === '/api/learning/graph' && params.profile === 'null-graph') return null;
        if (path === '/api/learning/graph') {
          return {
            profile: String(params.profile),
            nodes: [{ id: `skill:${params.profile}`, kind: 'skill', label: String(params.profile), uses: 1 }],
            edges: [],
          };
        }
        return {};
      },
    }),
    getEffectiveUrl: (u) => (useEffectiveUrl ? effectiveGateway : (u || '').trim()),
    t: (k) => k,
    describeRpcError: (e) => (e instanceof Error ? e.message : String(e || '')),
  });

  // 空 effectiveUrl => resolveRestAdapter 返回 null；非 default profile 读取 memory: 节点报错
  await svc.loadLearningDetail('memory:arch-1', 'arch');
  assert.equal(st.learningDetail.status, 'error');
  assert.equal(st.learningDetail.message, 'mobile.memory.loadError');

  // fetchSkillDetailWsFallback: inspect 仅含空 name、dispatch 被 reject => ok=false 走 error
  await svc.loadLearningDetail('skill:empty-skill', 'arch');
  assert.equal(st.learningDetail.status, 'error');

  // 配好有效 gatewayUrl 并验证 null restPayload 与无 getEffectiveUrl 回退
  effectiveGateway = 'http://127.0.0.1:8789';
  await svc.loadLearningGraph({ profile: 'null-graph', force: true });
  assert.equal(st.learningState.status, 'ready');
  assert.equal(st.learningState.graph.nodes.length, 0);

  st.gatewayUrl = ' http://127.0.0.1:8789 ';
  useEffectiveUrl = false;
  await svc.loadLearningGraph({ profile: 'arch', force: true });
  await svc.loadLearningGraph({ profile: 'default', force: true });
  // 此时 cache 已有 arch 与 default，state.learningState.profile === 'default'
  st.learningDetail = { status: 'ready', id: 'memory:old', kind: 'memory', label: 'old', content: 'x', profile: 'default' };
  await svc.loadLearningGraph({ profile: 'arch', force: false });
  assert.equal(st.learningState.profile, 'arch');
  assert.equal(st.learningDetail.status, 'idle', '命中跨 profile 图缓存时必须清理旧 profile 的 learningDetail');

  // 无 getEffectiveUrl 回调配置 + gatewayUrl 为 undefined / 字符串双分支 + rawInner.profile 为空透传 rawRoot.profile + 无 getDesktopApi 分支
  const stDirect = {
    gatewayUrl: undefined,
    profileName: 'default',
    profiles: [],
    learningState: { status: 'idle' },
    learningDetail: { status: 'idle' },
  };
  let rootOnlyPayload = { graph: { profile: '   ', nodes: [] }, profile: 'arch' };
  const svcNoEffective = createLearningService({
    getState: () => stDirect,
    render: () => {},
    getGatewayClient: () => wsClient,
    getDesktopApi: () => ({
      httpProxy: async () => rootOnlyPayload,
    }),
    t: (k) => k,
    describeRpcError: (e) => String(e),
  });
  await svcNoEffective.loadLearningGraph({ profile: 'default', force: true });
  assert.equal(stDirect.learningState.status, 'ready');

  stDirect.gatewayUrl = 'http://127.0.0.1:8790';
  await svcNoEffective.loadLearningGraph({ profile: 'arch', force: true });
  assert.equal(stDirect.learningState.status, 'ready');
  assert.equal(stDirect.learningState.profile, 'arch');

  stDirect.gatewayUrl = undefined;
  rootOnlyPayload = { profile: 'default', nodes: [], edges: [] };
  const svcWithUndefinedEffective = createLearningService({
    getState: () => stDirect,
    render: () => {},
    getGatewayClient: () => wsClient,
    getDesktopApi: () => ({ httpProxy: async () => rootOnlyPayload }),
    getEffectiveUrl: (u) => {
      if (u === undefined) return 'http://127.0.0.1:8791';
      stDirect.gatewayUrl = undefined;
      return 'http://127.0.0.1:8791';
    },
    t: (k) => k,
    describeRpcError: (e) => String(e),
  });
  await svcWithUndefinedEffective.loadLearningGraph({ profile: 'default', force: true });
  assert.equal(stDirect.learningState.status, 'ready');

  // 无 getDesktopApi 回调与无 httpProxy 对象双分支兜底：必须清空既有状态并实际触发 WS learning.frames 回退
  let fallbackFramesCalls = 0;
  const wsTrackClient = {
    async call(method, params) {
      if (method === 'learning.frames') {
        fallbackFramesCalls += 1;
        return {
          count: 1,
          buckets: [{ index: 0, nodes: [{ id: 'skill:ws-fb', label: 'ws-fb', style: 'skill', body: 'ok' }] }],
        };
      }
      return wsClient.call(method, params);
    },
  };
  stDirect.learningState = { status: 'idle' };
  const svcBaseUrlUndef = createLearningService({
    getState: () => stDirect,
    render: () => {},
    getGatewayClient: () => wsTrackClient,
    t: (k) => k,
    describeRpcError: (e) => String(e),
  });
  await svcBaseUrlUndef.loadLearningGraph({ profile: 'default', force: true });
  assert.equal(fallbackFramesCalls, 1);
  assert.equal(stDirect.learningState.status, 'ready');
  assert.equal(stDirect.learningState.graph.source, 'ws-frames');

  const stNoProxy = {
    gatewayUrl: 'http://127.0.0.1:8793',
    profileName: 'default',
    profiles: [],
    learningState: { status: 'idle' },
    learningDetail: { status: 'idle' },
  };
  const svcNoHttpProxy = createLearningService({
    getState: () => stNoProxy,
    render: () => {},
    getGatewayClient: () => wsTrackClient,
    getDesktopApi: () => ({}),
    t: (k) => k,
    describeRpcError: (e) => String(e),
  });
  await svcNoHttpProxy.loadLearningGraph({ profile: 'default', force: true });
  assert.equal(fallbackFramesCalls, 2);
  assert.equal(stNoProxy.learningState.status, 'ready');
  assert.equal(stNoProxy.learningState.graph.source, 'ws-frames');

  // 直接注入 deps.learningRest 短路分支
  const injectedCalls = [];
  const svcInjectedRest = createLearningService({
    getState: () => stDirect,
    render: () => {},
    getGatewayClient: () => wsClient,
    learningRest: createLearningRest({
      baseUrl: () => 'http://127.0.0.1:8794',
      ticket: () => '',
      proxy: async (opts) => {
        injectedCalls.push(opts.params?.profile);
        return { profile: 'arch', nodes: [{ id: 'skill:inj', kind: 'skill', label: 'inj', uses: 3 }], edges: [] };
      },
    }),
    t: (k) => k,
    describeRpcError: (e) => String(e),
  });
  await svcInjectedRest.loadLearningGraph({ profile: 'arch', force: true });
  assert.deepEqual(injectedCalls, ['arch']);
  assert.equal(stDirect.learningState.graph.nodes[0].id, 'skill:inj');

  // 无 getEffectiveUrl 且 gatewayUrl 在 resolveRestAdapter 读为有效串、在 baseUrl() 调用时读为 undefined（覆盖 (currentUrl || '').trim()）
  let urlReads = 0;
  let seenBaseUrl = 'unset';
  const stDynamicUrl = {
    get gatewayUrl() {
      urlReads += 1;
      return urlReads === 1 ? 'http://127.0.0.1:8792' : undefined;
    },
    profileName: 'default',
    profiles: [],
    learningState: { status: 'idle' },
    learningDetail: { status: 'idle' },
  };
  const svcFlipUrl = createLearningService({
    getState: () => stDynamicUrl,
    render: () => {},
    getGatewayClient: () => wsClient,
    getDesktopApi: () => ({
      httpProxy: async (opts) => {
        seenBaseUrl = opts.baseUrl;
        return { profile: 'default', nodes: [] };
      },
    }),
    t: (k) => k,
    describeRpcError: (e) => String(e),
  });
  await svcFlipUrl.loadLearningGraph({ profile: 'default', force: true });
  assert.equal(seenBaseUrl, '');
  assert.equal(stDynamicUrl.learningState.status, 'ready');
});

test('Stryker 契约强化：learningRest 参数完整性、多行错误解析与 learningService 渲染/参数/缓存淘汰闭环', async () => {
  // 1. describeLearningRestError 多行 HTTP 与前导词边界 + normalizeNodeKind 全变体 + fetchNodeDetail 边界字段
  assert.deepEqual(
    describeLearningRestError(new Error('prefix HTTP 503: Temporarily unavailable\nRetry-After: 5')),
    { status: 503, message: 'Temporarily unavailable\nRetry-After: 5' },
  );
  assert.deepEqual(describeLearningRestError(new Error('HTTP 503 Bad Gateway')), {
    status: 503,
    message: 'Bad Gateway',
  });
  assert.deepEqual(describeLearningRestError(new Error('notHTTP 500: ignore prefix')), {
    status: 0,
    message: 'notHTTP 500: ignore prefix',
  });

  const restCalls = [];
  let restNext = null;
  const strictRest = createLearningRest({
    baseUrl: () => 'http://127.0.0.1:8795',
    ticket: () => 'tk-strict',
    proxy: async (opts) => {
      restCalls.push(opts);
      return typeof restNext === 'function' ? restNext(opts) : restNext;
    },
  });

  restNext = { nodes: [] };
  await strictRest.fetchGraph('arch');
  assert.deepEqual(restCalls.at(-1), {
    baseUrl: 'http://127.0.0.1:8795',
    path: '/api/learning/graph',
    method: 'GET',
    ticket: 'tk-strict',
    params: { profile: 'arch' },
    body: undefined,
  });

  restNext = { node: { kind: 'skill', label: 'Named', markdown: '' } };
  const skillEmptyContent = await strictRest.fetchNodeDetail('arch', 'memory:forced');
  assert.deepEqual(skillEmptyContent, {
    ok: false,
    id: 'memory:forced',
    kind: 'skill',
    label: 'Named',
    content: '',
    message: undefined,
  });

  restNext = { ok: false, message: 'explicit msg', detail: 'secondary detail' };
  const explicitMsgDetail = await strictRest.fetchNodeDetail('arch', 'skill:m');
  assert.deepEqual(explicitMsgDetail, {
    ok: false,
    id: 'skill:m',
    kind: 'skill',
    label: 'skill:m',
    content: '',
    message: 'explicit msg',
  });

  restNext = { ok: true, id: 'fallback-top', type: 'memory', content: 'Body text' };
  const okViaContent = await strictRest.fetchNodeDetail('arch', 'skill:arg');
  assert.equal(okViaContent.ok, true);
  assert.equal(okViaContent.kind, 'memory');

  restNext = { ok: true };
  await strictRest.editNode('arch', 'n-1', 'new body');
  assert.deepEqual(restCalls.at(-1), {
    baseUrl: 'http://127.0.0.1:8795',
    path: '/api/learning/node',
    method: 'PUT',
    ticket: 'tk-strict',
    params: { profile: 'arch' },
    body: { id: 'n-1', content: 'new body', profile: 'arch' },
  });

  await strictRest.deleteNode('arch', 'n-1');
  assert.deepEqual(restCalls.at(-1), {
    baseUrl: 'http://127.0.0.1:8795',
    path: '/api/learning/node',
    method: 'DELETE',
    ticket: 'tk-strict',
    params: { profile: 'arch', id: 'n-1' },
    body: undefined,
  });

  // 2. learningService render 计数、WS exact RPC 参数、profiles matched metadata 透传、cache/detailGen 围栏与 edit/delete 返回码
  let renders = 0;
  const rpcLog = [];
  const httpLog = [];
  let httpMode = 'ok';
  let slowDetailDeferred = null;
  const state = {
    gatewayUrl: '  http://127.0.0.1:8796  ',
    profileName: 'fallback-prof',
    profiles: [
      { name: 'ARCH', displayName: 'Arch Title', avatar: 'av://arch', isDefault: true },
      { name: 'default', displayName: 'Default', isDefault: true },
    ],
    learningState: { status: 'idle' },
    learningDetail: { status: 'idle' },
  };
  let client = {
    call: async (method, params) => {
      rpcLog.push([method, params]);
      if (method === 'learning.frames') {
        return {
          count: 1,
          buckets: [{ index: 0, nodes: [{ id: 'skill:d1', label: 'd1', style: 'skill', body: 'D1' }] }],
        };
      }
      if (method === 'profiles.describe') {
        return { name: '', skills: [{ name: 'inspect-only', enabled: true }] };
      }
      if (method === 'complete.slash') {
        return {
          items: [
            { text: '///inspect-only', meta: '  Slash trimmed meta  ', kind: 'skill' },
            { text: '/ignored-empty', meta: '   ', kind: 'skill' },
          ],
        };
      }
      if (method === 'skills.manage') {
        return { ok: true, markdown: '# Inspect Markdown' };
      }
      if (method === 'command.dispatch') {
        throw new Error('no dispatch');
      }
      if (method === 'learning.detail') {
        if (slowDetailDeferred) return slowDetailDeferred.promise;
        return { ok: true, id: params.id, kind: 'skill', label: 'd1', content: 'Det content' };
      }
      if (method === 'learning.edit' || method === 'learning.delete') {
        return { ok: true };
      }
      return {};
    },
  };

  const svc = createLearningService({
    getState: () => state,
    render: () => {
      renders += 1;
    },
    getGatewayClient: () => client,
    getDesktopApi: () => ({
      httpProxy: async (opts) => {
        httpLog.push(opts);
        if (httpMode === '404') throw new Error('HTTP 404: Not Found');
        if (httpMode === 'edit-fail-msg') return { ok: false, message: 'read-only rest' };
        if (httpMode === 'edit-fail-empty') return { ok: false };
        if (httpMode === 'edit-throw') throw new Error('HTTP 500: write err');
        if (httpMode === 'del-fail-empty') return { ok: false };
        if (httpMode === 'del-throw') throw new Error('HTTP 500: del err');
        if (opts.path === '/api/learning/graph') {
          return {
            graph: {
              profile: opts.params.profile,
              nodes: [{ id: `skill:${opts.params.profile}`, kind: 'skill', label: opts.params.profile, uses: 1 }],
              edges: [],
            },
          };
        }
        return { ok: true, node: { id: opts.params.id, kind: 'skill', label: opts.params.id, content: 'REST body' } };
      },
    }),
    getCurrentTicket: () => 'tk-svc',
    t: (k) => k,
    describeRpcError: (e) => (e instanceof Error ? e.message : String(e || '')),
  });

  // 验证 getEffectiveUrl 缺省 .trim() 与 ticket 透传 + loading -> ready render 计数递增
  const r0 = renders;
  await svc.loadLearningGraph({ profile: 'arch', force: true });
  assert.equal(httpLog[0].baseUrl, 'http://127.0.0.1:8796');
  assert.equal(httpLog[0].ticket, 'tk-svc');
  assert.ok(renders >= r0 + 2, 'loadLearningGraph 必须触发 loading 与 ready 两次 render');

  // REST 错误分支与不匹配 profile 拒绝时，learningDetail 清除 + renders 递增
  state.learningDetail = { status: 'ready', id: 'skill:arch', kind: 'skill', label: 'arch', content: 'c', profile: 'arch' };
  const rErr = renders;
  httpMode = 'edit-throw';
  await svc.loadLearningGraph({ profile: 'arch', force: true });
  assert.equal(state.learningState.status, 'error');
  assert.ok(renders > rErr);

  // REST 写入失败各种形态 (ok:false message / ok:false empty / throw)
  httpMode = 'edit-fail-msg';
  assert.deepEqual(await svc.editLearningNode('skill:arch', 'x', 'arch'), { ok: false, message: 'read-only rest' });
  httpMode = 'edit-fail-empty';
  assert.deepEqual(await svc.editLearningNode('skill:arch', 'x', 'arch'), { ok: false, message: 'settings.loadFailed' });
  httpMode = 'edit-throw';
  assert.match((await svc.editLearningNode('skill:arch', 'x', 'arch')).message, /write err/);
  httpMode = 'del-fail-empty';
  assert.deepEqual(await svc.deleteLearningNode('skill:arch', 'arch'), { ok: false, message: 'settings.loadFailed' });
  httpMode = 'del-throw';
  assert.match((await svc.deleteLearningNode('skill:arch', 'arch')).message, /del err/);

  // 正常 REST edit + 缓存淘汰验证（断连跳过 loadLearningGraph 后缓存必须已删，后续 force:false 重拉）
  httpMode = 'ok';
  await svc.loadLearningGraph({ profile: 'arch', force: true });
  const graphCountBeforeEdit = httpLog.filter((x) => x.path === '/api/learning/graph').length;
  assert.deepEqual(await svc.editLearningNode('skill:arch', 'updated', 'arch'), { ok: true });
  assert.ok(httpLog.filter((x) => x.path === '/api/learning/graph').length > graphCountBeforeEdit);

  // 同 profile 命中缓存时不得误清空同 profile learningDetail，仅跨 profile 才清；且未传 profile 时 loadLearningDetail 继承 state.learningState.profile
  await svc.loadLearningDetail('skill:arch');
  assert.equal(state.learningDetail.profile, 'arch');
  await svc.loadLearningGraph({ profile: 'arch', force: false });
  assert.equal(state.learningDetail.status, 'ready', '同 profile 命中缓存不得清除当前详情');

  // REST 404 下 WS exact params 验证：profiles.describe / complete.slash / skills.manage / command.dispatch / learning.detail / edit / delete
  httpMode = '404';
  rpcLog.length = 0;
  await svc.loadLearningGraph({ profile: 'arch', force: true });
  const descCall = rpcLog.find(([m]) => m === 'profiles.describe');
  const slashCall = rpcLog.find(([m]) => m === 'complete.slash');
  assert.deepEqual(descCall?.[1], { profile: 'arch' });
  assert.deepEqual(slashCall?.[1], { text: '/', profile: 'arch' });
  assert.equal(
    state.learningState.graph.nodes.find((n) => n.id === 'skill:inspect-only')?.description,
    'Slash trimmed meta',
  );

  // 忽略非法空白 nodeId 的 loadLearningDetail
  const rIgnore = renders;
  await svc.loadLearningDetail('   ');
  assert.equal(renders, rIgnore);

  await svc.loadLearningDetail('skill:inspect-only', 'arch');
  assert.deepEqual(rpcLog.find(([m]) => m === 'skills.manage')?.[1], {
    profile: 'arch',
    action: 'inspect',
    query: 'inspect-only',
  });
  assert.deepEqual(rpcLog.find(([m]) => m === 'command.dispatch')?.[1], {
    name: 'inspect-only',
    profile: 'arch',
  });
  assert.equal(state.learningDetail.status, 'ready');
  assert.equal(state.learningDetail.content, '# Inspect Markdown');

  await svc.loadLearningGraph({ profile: 'default', force: true });
  await svc.loadLearningDetail('skill:d1', 'default');
  assert.deepEqual(rpcLog.find(([m]) => m === 'learning.detail')?.[1], { id: 'skill:d1' });
  await svc.editLearningNode('skill:d1', 'edited-def', 'default');
  assert.deepEqual(rpcLog.find(([m]) => m === 'learning.edit')?.[1], { id: 'skill:d1', content: 'edited-def' });
  await svc.deleteLearningNode('skill:d1', 'default');
  assert.deepEqual(rpcLog.find(([m]) => m === 'learning.delete')?.[1], { id: 'skill:d1' });

  // 3. 精准消减剩余变异体：whitespace gatewayUrl、undefined ticket、method:'GET'、enabled:false 过滤、in-flight loading 与显式 explicitProfile
  assert.deepEqual(describeLearningRestError(new Error('HTTP 503:   trimmed body  \n')), {
    status: 503,
    message: 'trimmed body',
  });
  assert.deepEqual(describeLearningRestError(new Error('HTTP 404: part1:part2')), {
    status: 404,
    message: 'part1:part2',
  });

  restNext = { ok: true, id: 'empty-ok' };
  const okOnlyTrue = await strictRest.fetchNodeDetail('arch', 'skill:empty-ok');
  assert.equal(okOnlyTrue.ok, true);
  assert.equal(restCalls.at(-1)?.method, 'GET');

  restNext = null;
  assert.deepEqual(await strictRest.fetchNodeDetail('arch', 'skill:null'), { ok: false, message: '' });

  restNext = { id: 'only-id', kind: 'learned-skill', content: '' };
  const viaIdAndKind = await strictRest.fetchNodeDetail('arch', 'only-id');
  assert.equal(viaIdAndKind.ok, true);
  assert.equal(viaIdAndKind.kind, 'skill');

  // whitespace-only gatewayUrl 且无 getEffectiveUrl -> 不构造 REST 适配器，直接走 WS
  const wsDirectCalls = [];
  const wsFilteredClient = {
    async call(method, params) {
      wsDirectCalls.push([method, params]);
      if (method === 'profiles.describe') {
        return {
          name: 'arch',
          skills: [
            { name: 'enabled-one', enabled: true },
            { name: 'disabled-one', enabled: false },
          ],
        };
      }
      if (method === 'complete.slash') {
        return {
          items: [
            null,
            { text: '/enabled-one  ', meta: '  spaced desc  ', kind: 'skill' },
          ],
        };
      }
      if (method === 'learning.detail') {
        return new Promise(() => {}); // pending for in-flight loading state check
      }
      return {};
    },
  };
  const stWsTrim = {
    gatewayUrl: '   ',
    profileName: 'default',
    profiles: [],
    learningState: { status: 'idle' },
    learningDetail: { status: 'idle' },
  };
  let proxyUnexpected = false;
  const svcWsTrim = createLearningService({
    getState: () => stWsTrim,
    render: () => {},
    getGatewayClient: () => wsFilteredClient,
    getDesktopApi: () => ({
      httpProxy: async () => {
        proxyUnexpected = true;
        return {};
      },
    }),
    getCurrentTicket: () => undefined,
    t: (k) => k,
    describeRpcError: (e) => String(e),
  });
  await svcWsTrim.loadLearningGraph(true, 'arch');
  assert.equal(proxyUnexpected, false, '纯空白 gatewayUrl 不得触发 REST 请求');
  assert.equal(stWsTrim.learningState.profile, 'arch');
  assert.equal(stWsTrim.learningState.graph.nodes.some((n) => n.id === 'skill:disabled-one'), false);
  assert.equal(
    stWsTrim.learningState.graph.nodes.find((n) => n.id === 'skill:enabled-one')?.description,
    'spaced desc',
  );
  // loadLearningGraph() 无参默认 force=false 在同 profile ready 态下不重复请求
  stWsTrim.profileName = 'arch';
  const beforeNoArg = wsDirectCalls.length;
  await svcWsTrim.loadLearningGraph();
  assert.equal(wsDirectCalls.length, beforeNoArg);

  // ticket fallback '' 当 getCurrentTicket 返回 undefined
  stWsTrim.gatewayUrl = 'http://127.0.0.1:8798';
  let capturedTicket = 'unset';
  const svcEmptyTicket = createLearningService({
    getState: () => stWsTrim,
    render: () => {},
    getGatewayClient: () => wsFilteredClient,
    getDesktopApi: () => ({
      httpProxy: async (opts) => {
        capturedTicket = opts.ticket;
        return { profile: 'arch', nodes: [] };
      },
    }),
    getCurrentTicket: () => undefined,
    t: (k) => k,
    describeRpcError: (e) => String(e),
  });
  await svcEmptyTicket.loadLearningGraph({ profile: 'arch', force: true });
  assert.equal(capturedTicket, '');

  // in-flight loading state profile & 跨 profile cache hit 时丢弃正在进行中的旧 profile detail
  let releaseGraph2;
  let releaseDet2;
  const stInFlight = {
    gatewayUrl: 'http://127.0.0.1:8799',
    profileName: 'default',
    profiles: [],
    learningState: { status: 'idle' },
    learningDetail: { status: 'idle' },
  };
  const svcInFlight = createLearningService({
    getState: () => stInFlight,
    render: () => {},
    getGatewayClient: () => wsFilteredClient,
    learningRest: createLearningRest({
      baseUrl: () => 'http://127.0.0.1:8799',
      ticket: () => '',
      proxy: async ({ path, params }) => {
        if (path === '/api/learning/graph') {
          if (params.profile === 'cached-p2') return { profile: 'cached-p2', nodes: [] };
          return new Promise((res) => {
            releaseGraph2 = res;
          });
        }
        return new Promise((res) => {
          releaseDet2 = res;
        });
      },
    }),
    t: (k) => k,
    describeRpcError: (e) => String(e),
  });
  await svcInFlight.loadLearningGraph({ profile: 'cached-p2', force: true });
  const pLoadingGraph = svcInFlight.loadLearningGraph({ profile: 'p1', force: true });
  assert.deepEqual(stInFlight.learningState, { status: 'loading', profile: 'p1' });
  const pLoadingDet = svcInFlight.loadLearningDetail('skill:x', 'p1');
  assert.deepEqual(stInFlight.learningDetail, { status: 'loading', id: 'skill:x', profile: 'p1' });
  await svcInFlight.loadLearningGraph({ profile: 'cached-p2', force: false });
  assert.equal(stInFlight.learningDetail.status, 'idle');
  releaseDet2?.({ ok: true, id: 'skill:x', kind: 'skill', label: 'x', content: 'late detail' });
  releaseGraph2?.({ profile: 'p1', nodes: [{ id: 'skill:late', kind: 'skill', label: 'late', uses: 1 }] });
  await Promise.all([pLoadingDet, pLoadingGraph]);
  assert.equal(stInFlight.learningDetail.status, 'idle', '切回缓存 profile 后迟到的旧 detail 不得写入');
});
