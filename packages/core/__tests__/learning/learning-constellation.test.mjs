import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildConstellationGraph,
  cleanLearningLabel,
  layoutConstellationWindow,
  parseLearningUses,
} from '../../dist/index.js';

test('cleanLearningLabel 与 parseLearningUses 清洗 HTML 注释并提取使用次数', () => {
  assert.equal(
    cleanLearningLabel('<!-- observed: 2026-10-11 | status: active -->  你好  世界  '),
    '你好 世界',
  );
  assert.equal(cleanLearningLabel('<!-- observed: 2026-10-…'), '');
  assert.equal(parseLearningUses('wechat · 20 Oct 2026 · x29'), 29);
  assert.equal(parseLearningUses('profile memory · 27 Oct 2026'), 0);
  assert.equal(parseLearningUses(null), 0);
  assert.equal(parseLearningUses(`x${'9'.repeat(320)}`), 0);
});

test('buildConstellationGraph 构建去重节点、语义边及星图布局窗口全分支', () => {
  const result = {
    frames: [],
    legend: [],
    categories: [],
    summary: ['2 skills · 3 memories'],
    axis: { start: '19 Oct', end: '22 Nov' },
    count: 5,
    cols: 40,
    rows: 16,
    buckets: [
      {
        index: 0,
        label: '20 Oct',
        date: '20 Oct 2026',
        skills: 2,
        memories: 0,
        total: 2,
        category: 'software-development',
        color: '#fff',
        nodes: [
          {
            id: 'lity-gate-audit',
            glyph: '●',
            label: 'lity-gate-audit',
            fullLabel: 'lity-gate-audit',
            meta: 'software-development · x12',
            body: '',
            style: 'skill',
          },
          {
            id: 'lity-gate-audit', // duplicate id should be skipped
            glyph: '●',
            label: 'dup',
            fullLabel: 'dup',
            meta: '',
            body: '',
            style: 'skill',
          },
          {
            id: ' ', // empty id should be skipped
            glyph: '●',
            label: '',
            fullLabel: '',
            meta: '',
            body: '',
            style: 'skill',
          },
          {
            id: '', // missing-trim empty id
            glyph: '●',
            label: '',
            fullLabel: '',
            meta: '',
            body: '',
            style: 'skill',
          },
          {
            id: 'ultra-long-skill-identifier-over-limit',
            glyph: '●',
            label: 'ultra-long-skill-identifier-over-limit',
            fullLabel: 'ultra-long-skill-identifier-over-limit',
            meta: 'software-development · x4',
            body: '',
            style: 'skill',
          },
          {
            id: 'skill-alpha',
            glyph: '●',
            label: 'skill-alpha',
            fullLabel: 'skill-alpha',
            meta: '',
            body: '',
            style: 'skill',
          },
          {
            id: 'skill-beta',
            glyph: '●',
            label: 'skill-beta',
            fullLabel: 'skill-beta',
            meta: '',
            body: '',
            style: 'skill',
          },
          {
            id: 'skill-gamma',
            glyph: '●',
            label: 'skill-gamma',
            fullLabel: 'skill-gamma',
            meta: '',
            body: '',
            style: 'skill',
          },
          {
            id: 'skill-delta',
            glyph: '●',
            label: 'skill-delta',
            fullLabel: 'skill-delta',
            meta: '',
            body: '',
            style: 'skill',
          },
          {
            id: 'memory:same-bucket-mention',
            glyph: '◆',
            label: '<!-- observed: only comment -->',
            fullLabel: '',
            meta: '',
            body: '<!-- observed: only comment --> lity-gate-audit skill-alpha skill-beta skill-gamma skill-delta',
            style: 'memory',
          },
        ],
      },
      {
        index: 1,
        label: '27 Oct',
        date: '',
        skills: 0,
        memories: 7,
        total: 7,
        category: '',
        color: '#fff',
        nodes: [
          {
            id: 'memory:profile:1',
            glyph: '◆',
            label: '<!-- observed: 2026-10-…',
            fullLabel: '<!-- observed: 2026-10-11 --> 遵守 lity-gate-audit 门禁审查要求，确保全绿。',
            meta: 'profile · 27 Oct',
            body: '<!-- observed: 2026-10-11 --> 遵守 lity-gate-audit 门禁审查要求，确保全绿。',
            style: 'memory',
          },
          {
            id: 'memory:profile:2',
            glyph: '◆',
            label: '偏好中文交流',
            fullLabel: '偏好中文交流',
            meta: 'memory',
            body: '偏好中文交流',
            style: 'memory',
          },
          {
            id: 'memory:profile:3',
            glyph: '◆',
            label: '第三条同桶节点',
            fullLabel: '第三条同桶节点',
            meta: 'software-development',
            body: '第三条同桶节点',
            style: 'memory',
          },
          {
            id: 'memory:profile:4',
            glyph: '◆',
            label: '第四条同桶节点',
            fullLabel: '第四条同桶节点',
            meta: 'other',
            body: '第四条同桶节点',
            style: 'memory',
          },
          {
            id: 'memory:profile:5',
            glyph: '◆',
            label: '第五条同桶节点',
            fullLabel: '第五条同桶节点',
            meta: 'other',
            body: '第五条同桶节点',
            style: 'memory',
          },
          {
            id: 'memory:profile:6',
            glyph: '◆',
            label: '第六条同桶节点',
            fullLabel: '第六条同桶节点',
            meta: 'other',
            body: '第六条同桶节点',
            style: 'memory',
          },
          {
            id: 'memory:profile:7',
            glyph: '◆',
            label: '第七条同桶节点',
            fullLabel: '第七条同桶节点',
            meta: '',
            body: '',
            style: 'memory',
          },
        ],
      },
      {
        index: 2,
        label: '28 Oct',
        date: '28 Oct 2026',
        skills: 0,
        memories: 1,
        total: 1,
        category: 'other',
        color: '#fff',
        nodes: [
          {
            id: 'memory:profile:8',
            glyph: '◆',
            label: '',
            fullLabel: '',
            meta: '',
            body: '',
            style: 'memory',
          },
        ],
      },
    ],
  };

  const graph = buildConstellationGraph(result);
  assert.equal(graph.totalSkills, 6);
  assert.equal(graph.totalMemories, 9);
  assert.equal(graph.nodes.find((n) => n.id === 'memory:profile:1')?.label.startsWith('<!--'), false);
  assert.match(graph.nodes.find((n) => n.id === 'memory:profile:1')?.label || '', /^遵守 lity-gate-audit/);
  assert.equal(graph.nodes.find((n) => n.id === 'memory:profile:1')?.uses, 0);
  assert.equal(graph.nodes.find((n) => n.id === 'lity-gate-audit')?.uses, 12);
  assert.ok(graph.nodes.find((n) => n.id === 'ultra-long-skill-identifier-over-limit')?.label.endsWith('…'));
  assert.ok(graph.edges.some((e) => e.kind === 'mention' && e.source === 'memory:profile:1' && e.target === 'lity-gate-audit'));
  assert.ok(graph.edges.some((e) => e.kind === 'same-bucket'));

  // 缺省 options 时 page=0 / maxRingNodes=6 等默认参数全覆盖
  const defaultPage = layoutConstellationWindow(graph);
  assert.ok(defaultPage.activeNode !== null);
  assert.equal(defaultPage.currentPage, 0);

  // 布局：中心 + 邻近优先 + 翻页 + 过滤
  const page0 = layoutConstellationWindow(graph, {
    selectedId: 'memory:profile:1',
    filter: 'all',
    page: 0,
    maxRingNodes: 4,
  });
  assert.equal(page0.activeNode?.id, 'memory:profile:1');
  assert.equal(page0.positionedNodes.length, 5);
  assert.equal(page0.positionedNodes[0].isCenter, true);
  assert.equal(page0.positionedNodes[0].x, 50);
  assert.equal(page0.positionedNodes[1].id, 'lity-gate-audit');
  assert.equal(page0.totalPages, 4);
  assert.ok(page0.visibleEdges.length >= 1);

  const page2 = layoutConstellationWindow(graph, {
    selectedId: 'unknown-id',
    filter: 'skill',
    page: 5,
  });
  assert.equal(page2.activeNode?.id, 'lity-gate-audit');
  assert.equal(page2.filteredNodes.length, 6);
  assert.equal(page2.currentPage, 0);

  // 缺省 buckets 字段与缺省 nodes 字段的边界图谱
  assert.equal(buildConstellationGraph({ count: 0 }).nodes.length, 0);
  assert.equal(buildConstellationGraph({ count: 0, buckets: [{ index: 0, label: 'E', date: '', skills: 0, memories: 0, total: 0 }] }).nodes.length, 0);

  // 单节点独立分桶 + 同类别多节点：覆盖度数为 0 -> 1（line 221 false 不 break）到 1 -> 2（break）的补边路径
  const sparseGraph = buildConstellationGraph({
    count: 3,
    buckets: [
      { index: 0, label: 'D1', date: '', skills: 0, memories: 1, total: 1, category: 'ops', nodes: [{ id: 'm-a', glyph: '◆', label: 'A', fullLabel: 'A', meta: '', body: '', style: 'memory' }] },
      { index: 1, label: 'D2', date: '', skills: 0, memories: 1, total: 1, category: 'ops', nodes: [{ id: 'm-b', glyph: '◆', label: 'B', fullLabel: 'B', meta: '', body: '', style: 'memory' }] },
      { index: 2, label: 'D3', date: '', skills: 0, memories: 1, total: 1, category: 'ops', nodes: [{ id: 'm-c', glyph: '◆', label: 'C', fullLabel: 'C', meta: '', body: '', style: 'memory' }] },
    ],
  });
  assert.equal(sparseGraph.edges.filter((e) => e.kind === 'same-category').length >= 2, true);

  // 孤立节点同域匹配到已达度数上限 (MAX_EDGES_PER_NODE=4) 的目标时，tryAddEdge 拒绝建边且 line 221 仍保有 ?? 0 兜底
  const saturatedGraph = buildConstellationGraph({
    count: 6,
    buckets: [
      { index: 0, label: 'Iso', date: '', skills: 0, memories: 1, total: 1, category: 'ops', nodes: [{ id: 'memory:iso', glyph: '◆', label: '孤立', fullLabel: '孤立', meta: '', body: '', style: 'memory' }] },
      { index: 1, label: 'Sat', date: '', skills: 1, memories: 0, total: 1, category: 'ops', nodes: [{ id: 'sk-sat', glyph: '●', label: 'sk-sat', fullLabel: 'sk-sat', meta: '', body: '', style: 'skill' }] },
      {
        index: 2,
        label: 'Mentions',
        date: '',
        skills: 0,
        memories: 4,
        total: 4,
        category: 'other',
        nodes: [
          { id: 'memory:s1', glyph: '◆', label: '1', fullLabel: 'use sk-sat 1', meta: '', body: '', style: 'memory' },
          { id: 'memory:s2', glyph: '◆', label: '2', fullLabel: 'use sk-sat 2', meta: '', body: '', style: 'memory' },
          { id: 'memory:s3', glyph: '◆', label: '3', fullLabel: 'use sk-sat 3', meta: '', body: '', style: 'memory' },
          { id: 'memory:s4', glyph: '◆', label: '4', fullLabel: 'use sk-sat 4', meta: '', body: '', style: 'memory' },
        ],
      },
    ],
  });
  assert.equal(saturatedGraph.edges.some((e) => e.source === 'memory:iso' || e.target === 'memory:iso'), false);

  const emptyGraph = buildConstellationGraph({
    frames: [],
    legend: [],
    categories: [],
    buckets: [],
    summary: [],
    axis: { start: '', end: '' },
    count: 0,
    cols: 0,
    rows: 0,
  });
  const emptyLayout = layoutConstellationWindow(emptyGraph);
  assert.equal(emptyLayout.activeNode, null);
  assert.deepEqual(emptyLayout.positionedNodes, []);
});
