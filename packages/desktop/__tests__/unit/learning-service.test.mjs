/**
 * 认知星图与记忆学习服务（Learning Service）行为单测
 * (packages/desktop/__tests__/unit/learning-service.test.mjs)
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createLearningService } from '../../dist/renderer/services/learningService.mjs';

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
