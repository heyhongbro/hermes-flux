/**
 * 认知星图多网关隔离与变异边界补充测试
 * (packages/desktop/__tests__/unit/learning-service-multigateway.test.mjs)
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createLearningService } from '../../dist/renderer/services/learningService.mjs';
import {
  LearningRestError,
  createLearningRest,
  describeLearningRestError,
} from '../../dist/renderer/learningRest.mjs';

test('learningRest 补充边界：LearningRestError.name、HTTP 错误正则与 fetchNodeDetail', async () => {
  const err = new LearningRestError(403, 'forbidden');
  assert.equal(err.name, 'LearningRestError');
  assert.deepEqual(describeLearningRestError(err), { status: 403, message: 'forbidden' });
  assert.deepEqual(describeLearningRestError(new Error('IPC prefix HTTP 502:   bad gateway  ')), {
    status: 502,
    message: 'bad gateway',
  });
  assert.deepEqual(describeLearningRestError(new Error('HTTP 504:  ')), {
    status: 504,
    message: 'HTTP 504:',
  });
  assert.deepEqual(describeLearningRestError('  network reset  '), {
    status: 0,
    message: 'network reset',
  });

  let nextPayload = { nodes: [{ id: 's1', kind: 'learned-skill', label: 'S1' }] };
  const rest = createLearningRest({
    baseUrl: () => 'http://127.0.0.1:8080',
    ticket: () => 'tk-1',
    proxy: async () => nextPayload,
  });

  nextPayload = { id: 's1', kind: 'learned-skill', label: 'S1', content: '' };
  const detKind = await rest.fetchNodeDetail('alpha', 's1');
  assert.equal(detKind.ok, true);
  assert.equal(detKind.kind, 'skill');

  nextPayload = ['not-a-record'];
  const dArr = await rest.fetchNodeDetail('alpha', 'memory:1');
  assert.equal(dArr.ok, false);

  nextPayload = { ok: true };
  const dOkOnly = await rest.fetchNodeDetail('alpha', 'skill:1');
  assert.equal(dOkOnly.ok, true);

  nextPayload = { ok: false, id: 'skill:1', content: 'should fail' };
  const dForceFalse = await rest.fetchNodeDetail('alpha', 'skill:1');
  assert.equal(dForceFalse.ok, false);
});

test('createLearningService 多网关客户端、REST 适配器与前缀缓存栅栏严格隔离', async () => {
  const callsA = [];
  const callsB1 = [];
  const callsB2 = [];
  const callsDefault = [];
  const proxyCalls = [];

  const mkClient = (tag, sink) => ({
    call: async (method, params) => {
      sink.push([tag, method, params]);
      return { ok: true, count: 0, buckets: [] };
    },
  });

  const clientA = mkClient('gw-a', callsA);
  const clientB1 = mkClient('gw-b-1', callsB1);
  const clientB2 = mkClient('gw-b-2', callsB2);
  const defaultClient = mkClient('default', callsDefault);
  let activeB = clientB1;

  const state = {
    gatewayUrl: 'http://default-gw:8080',
    activeGatewayId: '',
    activeFocus: { type: 'session', sessionId: 's-1' },
    profileName: 'bot-a',
    profiles: [],
    learningState: { status: 'idle' },
    learningDetail: { status: 'ready', id: 'stale-n', kind: 'memory', label: 'stale', content: 'x', profile: 'other-bot' },
  };

  let renders = 0;
  let forceRestGraph = true;
  const service = createLearningService({
    getState: () => state,
    render: () => { renders += 1; },
    getGatewayClient: () => defaultClient,
    getClientForGateway: (gw) => (gw === 'gw-a' ? clientA : gw === 'gw-b' ? activeB : null),
    getUrlForGateway: (gw) => (gw === 'gw-b' ? 'http://gw-b:9000' : 'http://gw-a:9001'),
    getTicketForGateway: (gw) => (gw === 'gw-b' ? 'tk-b' : 'tk-a'),
    getCurrentTicket: () => 'tk-default',
    getDesktopApi: () => ({
      httpProxy: async (opts) => {
        proxyCalls.push(opts);
        if (opts.path === '/api/learning/graph') {
          return forceRestGraph ? { profile: opts.params.profile, nodes: [{ id: 'n1', label: opts.baseUrl }] } : { nodes: [] };
        }
        return { ok: true, id: 'n1', content: 'detail-body', kind: 'memory' };
      },
    }),
    t: (k) => k,
    describeRpcError: (e) => String(e),
  });

  // 1. 无 explicitGatewayId 且 activeFocus/activeGatewayId 为空 -> 走 state.gatewayUrl 与 getCurrentTicket & defaultClient
  await service.loadLearningGraph({ profile: 'bot-default' });
  assert.equal(proxyCalls.at(-1).baseUrl, 'http://default-gw:8080');
  assert.equal(proxyCalls.at(-1).ticket, 'tk-default');
  // 前置不同 profile 的 learningDetail 应被置回 idle
  assert.equal(state.learningDetail.status, 'idle');

  // 2. 分別加载 gw-a 与 gw-b 的 bot-a 缓存（走各自 REST baseUrl / ticket）
  await service.loadLearningGraph({ gatewayId: 'gw-a', profile: 'bot-a' });
  const aIdx = proxyCalls.length;
  assert.equal(proxyCalls[aIdx - 1].baseUrl, 'http://gw-a:9001');
  assert.equal(proxyCalls[aIdx - 1].ticket, 'tk-a');

  await service.loadLearningGraph({ gatewayId: 'gw-b', profile: 'bot-a' });
  const bIdx = proxyCalls.length;
  assert.equal(proxyCalls[bIdx - 1].baseUrl, 'http://gw-b:9000');
  assert.equal(proxyCalls[bIdx - 1].ticket, 'tk-b');

  // 3. 仅切换 gw-b 客户端（clientB1 -> clientB2），验证仅清理 gw-b:: 缓存而不破坏 gw-a:: 缓存
  activeB = clientB2;
  const beforeB2 = proxyCalls.length;
  await service.loadLearningGraph({ gatewayId: 'gw-b', profile: 'bot-a' });
  assert.equal(proxyCalls.length, beforeB2 + 1, 'gw-b 换新客户端后应重新拉取');

  state.learningDetail = { status: 'ready', id: 'old-b', kind: 'memory', label: 'old', content: 'c', profile: 'other' };
  const rendersBeforeCacheHit = renders;
  const beforeAHit = proxyCalls.length;
  await service.loadLearningGraph({ gatewayId: 'gw-a', profile: 'bot-a' });
  assert.equal(proxyCalls.length, beforeAHit, 'gw-a::bot-a 缓存不得被 gw-b syncClientFence 清空');
  assert.equal(state.learningDetail.status, 'idle', '命中图谱缓存时也必须重置跨 Bot detail');
  assert.equal(state.learningState.profile, 'bot-a');
  assert.ok(renders > rendersBeforeCacheHit);

  // 4. force=true 强制绕过缓存重拉
  await service.loadLearningGraph({ force: true, gatewayId: 'gw-a', profile: 'bot-a' });
  assert.equal(proxyCalls.length, beforeAHit + 1);

  // 5. getGatewayClient() 返回 null 而 getClientForGateway('gw-a') 有值时仍正常工作
  forceRestGraph = true;
  const gwOnlyService = createLearningService({
    getState: () => state,
    render: () => {},
    getGatewayClient: () => null,
    getClientForGateway: (gw) => (gw === 'gw-a' ? clientA : null),
    t: (k) => k,
    describeRpcError: (e) => String(e),
  });
  await gwOnlyService.loadLearningGraph({ force: true, gatewayId: 'gw-a', profile: 'default' });
  assert.equal(state.learningState.status, 'ready');
  assert.ok(callsA.some((c) => c[1] === 'learning.frames'));
});

test('createLearningService: fallback 解析、edit/delete 网关刷新路由与非默认 profile 缺失记忆分支', async () => {
  const wsCalls = [];
  const proxyLog = [];
  let endpointMissing = false;

  const clientGwA = {
    call: async (method, params) => {
      wsCalls.push(['gw-a', method, params]);
      if (method === 'profiles.describe') {
        return { name: 'AlphaBot', skills: [{ name: 'my-skill', enabled: true }, { name: 'empty-meta', enabled: true }] };
      }
      if (method === 'complete.slash') {
        return {
          items: [
            { kind: 'tool', text: '/my-skill', meta: 'wrong kind' },
            { kind: 'skill', text: 123, meta: 'wrong text type' },
            { kind: 'skill', text: '//empty-meta', meta: '   ' },
            { kind: 'skill', text: '///my-skill', meta: '  Trimmed Meta  ' },
          ],
        };
      }
      if (method === 'skills.manage') {
        return { name: '', description: '' };
      }
      if (method === 'command.dispatch') {
        return { type: 'skill', message: 'dispatch-only-body' };
      }
      if (method === 'learning.detail') {
        return { ok: true, id: params.id, label: '', content: '' };
      }
      return {};
    },
  };

  const state = {
    gatewayUrl: 'http://gw-a:8080',
    activeGatewayId: 'gw-a',
    activeFocus: { type: 'session', sessionId: 's-1', gatewayId: 'gw-a' },
    profileName: 'fallback-prof',
    profiles: [
      { name: 'AlphaBot', displayName: 'Alpha Display', avatar: 'av-alpha', isDefault: false },
    ],
    learningState: { status: 'ready', profile: 'state-prof', graph: { nodes: [], edges: [], skills: [] } },
    learningDetail: { status: 'idle' },
  };

  const serviceWithRest = createLearningService({
    getState: () => state,
    render: () => {},
    getGatewayClient: () => null,
    getClientForGateway: (gw) => (gw === 'gw-b' ? clientGwA : gw === 'gw-a' ? clientGwA : null),
    getUrlForGateway: (gw) => (gw === 'gw-b' ? 'http://gw-b:7777' : 'http://gw-a:8080'),
    getTicketForGateway: (gw) => (gw === 'gw-b' ? 'tk-b' : 'tk-a'),
    getDesktopApi: () => ({
      httpProxy: async (opts) => {
        proxyLog.push(opts);
        if (endpointMissing) throw new Error('HTTP 404: missing');
        return { ok: true, id: 'memory:m1', label: '', content: 'edited' };
      },
    }),
    t: (k) => k,
    describeRpcError: (e) => String(e),
  });

  // editLearningNode 无 explicitProfile 时取 learningState.profile ('state-prof') 并向 gw-b 刷新图与详情
  state.learningDetail = { status: 'ready', id: 'memory:m1', kind: 'memory', label: 'M1', content: 'old', profile: 'state-prof' };
  const editRes = await serviceWithRest.editLearningNode('memory:m1', 'new-body', undefined, 'gw-b');
  assert.equal(editRes.ok, true);
  assert.equal(proxyLog.filter((p) => p.baseUrl === 'http://gw-b:7777' && p.path === '/api/learning/graph').length, 1);
  assert.equal(proxyLog.filter((p) => p.baseUrl === 'http://gw-b:7777' && p.path === '/api/learning/node' && (p.method || 'GET') === 'GET').length, 1);
  assert.equal(proxyLog[0].params.profile, 'state-prof');

  // deleteLearningNode 携带 gw-b 且命中当前打开 detail 时清回 idle 并按 force 刷新 gw-b 图谱
  proxyLog.length = 0;
  const delRes = await serviceWithRest.deleteLearningNode('memory:m1', 'state-prof', 'gw-b');
  assert.equal(delRes.ok, true);
  assert.equal(state.learningDetail.status, 'idle');
  assert.equal(proxyLog.filter((p) => p.baseUrl === 'http://gw-b:7777' && p.path === '/api/learning/graph').length, 1);

  // REST 404 回退到 fetchProfileSkillsFallback + skills.manage / command.dispatch
  endpointMissing = true;
  await serviceWithRest.loadLearningGraph({ force: true, gatewayId: 'gw-b', profile: 'alphabot' });
  assert.equal(state.learningState.status, 'ready');
  const skillNode = state.learningState.graph.nodes.find((n) => n.id === 'skill:my-skill');
  assert.equal(skillNode?.description, 'Trimmed Meta');
  assert.equal(state.learningState.graph.source, 'profile-skills');
  assert.equal(state.learningState.graph.profile, 'alphabot');

  await serviceWithRest.loadLearningDetail('skill:my-skill:v2', 'alphabot', 'gw-b');
  assert.equal(state.learningDetail.status, 'ready');
  assert.equal(state.learningDetail.label, 'my-skill:v2');
  assert.equal(state.learningDetail.content, 'dispatch-only-body');
  assert.ok(wsCalls.some(([gw, m, p]) => gw === 'gw-a' && m === 'skills.manage' && p.query === 'my-skill:v2'));

  await serviceWithRest.loadLearningDetail('memory:missing', 'alphabot', 'gw-b');
  assert.equal(state.learningDetail.status, 'error');
  assert.equal(state.learningDetail.message, 'mobile.memory.loadError');

  // 无 REST 时：非 default 查 memory 返回 loadError；default 查裸 skill id 保留 kind='skill' 及回退 label/content
  const noRestSvc = createLearningService({
    getState: () => state,
    render: () => {},
    getGatewayClient: () => clientGwA,
    t: (k) => k,
    describeRpcError: (e) => String(e),
  });
  await noRestSvc.loadLearningDetail('memory:no-rest', 'alphabot');
  assert.equal(state.learningDetail.status, 'error');
  assert.equal(state.learningDetail.message, 'mobile.memory.loadError');

  await noRestSvc.loadLearningDetail('bare-skill', 'default');
  assert.equal(state.learningDetail.status, 'ready');
  assert.equal(state.learningDetail.kind, 'skill');
  assert.equal(state.learningDetail.label, 'bare-skill');
  assert.equal(state.learningDetail.content, '');
});
