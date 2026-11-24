import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildConstellationGraph,
  buildConstellationGraphFromRest,
  buildConstellationGraphFromSkills,
  cleanLearningLabel,
  computeConstellationNodeRadius,
  extractConstellationSkillList,
  layoutConstellationWindow,
  layoutFullConstellationGraph,
  normalizeLearningProfile,
  normalizeNonZeroDelta,
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

test('REST 多 Bot 星图归一、技能清单排序与全量无分页不重叠布局', () => {
  assert.equal(normalizeLearningProfile(undefined), 'default');
  assert.equal(normalizeLearningProfile('  '), 'default');
  assert.equal(normalizeLearningProfile(' arch '), 'arch');

  const restDirect = buildConstellationGraphFromRest(
    {
      profile: 'arch',
      nodes: [
        {
          id: 'skill:deploy-flow',
          kind: 'skill',
          name: 'deploy-flow',
          label: 'deploy-flow',
          description: 'Deploy pipeline using docker-ops',
          category: 'ops',
          use_count: 18,
          related_skills: ['docker-ops'],
          tags: ['release'],
        },
        {
          id: 'skill:docker-ops',
          kind: 'skill',
          label: 'docker-ops',
          description: 'Container workflow',
          category: 'ops',
          call_count: 7,
        },
        {
          id: 'skill:lint-guard',
          kind: 'skill',
          label: 'lint-guard',
          description: 'Static checks',
          category: 'qa',
          uses: 24,
        },
        {
          id: 'memory:arch:1',
          kind: 'memory',
          label: '<!-- observed: 2026-11-01 -->  Prefer canary via deploy-flow',
          content: '<!-- observed: 2026-11-01 -->  Prefer canary via deploy-flow and docker-ops',
          category: 'ops',
          updated_at: '2026-11-01',
        },
      ],
      edges: [
        { from: 'skill:deploy-flow', to: 'skill:lint-guard', kind: 'skill_link', weight: 0.9 },
      ],
      axis: { start: '01 Nov', end: '24 Nov' },
    },
    'default',
  );

  assert.equal(restDirect.profile, 'arch');
  assert.equal(restDirect.source, 'rest-graph');
  assert.equal(restDirect.totalSkills, 3);
  assert.equal(restDirect.totalMemories, 1);
  assert.ok(restDirect.edges.some((e) => e.kind === 'skill-link' && e.source === 'skill:deploy-flow' && e.target === 'skill:docker-ops'));
  assert.ok(restDirect.edges.some((e) => e.kind === 'skill-link' && e.source === 'skill:deploy-flow' && e.target === 'skill:lint-guard' && e.weight === 0.9));
  assert.ok(restDirect.edges.some((e) => e.kind === 'mention' && e.source === 'memory:arch:1'));
  assert.equal(restDirect.nodes.find((n) => n.id === 'memory:arch:1')?.label.includes('<!--'), false);

  // { graph: ... } 包装与 { buckets } 兼容格式
  const restBuckets = buildConstellationGraphFromRest(
    {
      data: {
        count: 1,
        buckets: [
          {
            index: 0,
            label: '02 Nov',
            date: '02 Nov 2026',
            category: 'backend',
            nodes: [
              { id: 'skill:sql-tune', glyph: '●', label: 'sql-tune', fullLabel: 'sql-tune', meta: 'backend · x5', body: 'SQL tune', style: 'skill' },
            ],
          },
        ],
      },
    },
    'reviewer',
  );
  assert.equal(restBuckets.profile, 'reviewer');
  assert.equal(restBuckets.source, 'rest-graph');
  assert.equal(restBuckets.nodes[0]?.uses, 5);

  assert.equal(buildConstellationGraphFromRest(null, 'ops').nodes.length, 0);

  // 技能专属降级星图（绝不混入 memory）
  const skillOnly = buildConstellationGraphFromSkills(
    [
      { id: 'git-sync', label: 'git-sync', description: 'Sync repo', category: 'vcs', uses: 4 },
      { id: 'git-sync', label: 'dup' },
      { id: 'pr-review', label: 'pr-review', description: 'Depends on git-sync', category: 'vcs', uses: 11 },
    ],
    'reviewer',
  );
  assert.equal(skillOnly.profile, 'reviewer');
  assert.equal(skillOnly.source, 'profile-skills');
  assert.equal(skillOnly.totalSkills, 2);
  assert.equal(skillOnly.totalMemories, 0);
  assert.ok(skillOnly.edges.some((e) => e.kind === 'skill-link'));

  // 全量确定性非分页布局与碰撞分离
  assert.ok(computeConstellationNodeRadius('skill', 20) > computeConstellationNodeRadius('memory', 2));
  const fullA = layoutFullConstellationGraph(restDirect, { selectedId: 'skill:deploy-flow' });
  const fullB = layoutFullConstellationGraph(restDirect, { selectedId: 'skill:deploy-flow' });
  assert.deepEqual(fullA, fullB, '同输入布局必须严格确定');
  assert.equal(fullA.nodes.length, 4, '全量星图严禁分页截断');
  assert.equal(fullA.activeNode?.id, 'skill:deploy-flow');
  for (let i = 0; i < fullA.nodes.length; i++) {
    for (let j = i + 1; j < fullA.nodes.length; j++) {
      const a = fullA.nodes[i];
      const b = fullA.nodes[j];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      assert.ok(dist >= a.radius + b.radius + 36 - 0.1, `node overlap ${a.id} vs ${b.id}: ${dist}`);
    }
  }

  const skillFilterLayout = layoutFullConstellationGraph(restDirect, { filter: 'skill' });
  assert.equal(skillFilterLayout.nodes.length, 3);
  assert.equal(skillFilterLayout.activeNode?.id, 'skill:lint-guard');

  const emptyFull = layoutFullConstellationGraph(skillOnly, { filter: 'memory' });
  assert.equal(emptyFull.activeNode, null);
  assert.deepEqual(emptyFull.nodes, []);

  // 技能清单排序：uses 降序 -> linkCount 降序 -> label 升序
  const skillList = extractConstellationSkillList(restDirect);
  assert.deepEqual(
    skillList.map((s) => [s.skillName, s.uses]),
    [
      ['lint-guard', 24],
      ['deploy-flow', 18],
      ['docker-ops', 7],
    ],
  );
  assert.ok(skillList[1].relatedSkillIds.includes('skill:docker-ops'));
  assert.ok(skillList[1].relatedMemoryIds.includes('memory:arch:1'));
});

test('constellationLayout 与 learningConstellation 全分支边界与去重逻辑补完', () => {
  // 1. normalizeNonZeroDelta 零距奇点拆分与非零距直接保留
  const nonZero = normalizeNonZeroDelta(3, 4, 1.2);
  assert.deepEqual(nonZero, { dx: 3, dy: 4, dist: 5 });
  const zeroSplit = normalizeNonZeroDelta(0, 0, Math.PI / 3);
  assert.equal(zeroSplit.dist, 1);
  assert.ok(Math.abs(Math.hypot(zeroSplit.dx, zeroSplit.dy) - 1) < 1e-6);

  // 2. buildConstellationGraph: learned-skill, empty category, id 'skill:', edgeCap 与自环去重
  const nonArraySummary = 'not-array';
  const framesEdge = buildConstellationGraph({
    frames: [],
    legend: [],
    categories: [],
    summary: nonArraySummary,
    axis: { start: '', end: '' },
    count: 6,
    cols: 40,
    rows: 16,
    buckets: [
      {
        index: 0,
        label: '24 Nov',
        date: '',
        skills: 5,
        memories: 1,
        total: 6,
        category: null,
        color: null,
        nodes: [
          { id: 'skill:', glyph: '*', label: '<!-- ignored -->', meta: 'general · x3', style: 'learned-skill' },
          { id: 'skill:hub-alpha', glyph: '*', label: 'hub-alpha', meta: 'other · x10', style: '' },
          { id: 'memory:plain', glyph: 'o', label: 'plain memory', fullLabel: 'mentioNs hub-alpha', meta: '', style: '' },
          { id: 'other:custom', glyph: '*', label: 'custom', meta: '', style: 'custom' },
          { id: 'skill:solo-cap', glyph: '*', label: 'solo-cap', meta: 'catA · x2', style: 'skill' },
          { id: 'skill:cap-a', glyph: '*', label: 'cap-a', meta: 'catA · x1', style: 'skill' },
          { id: 'skill:cap-b', glyph: '*', label: 'cap-b', meta: 'catA · x1', style: 'skill' },
          { id: 'skill:cap-c', glyph: '*', label: 'cap-c', meta: 'catA · x1', style: 'skill' },
          { id: 'skill:cap-d', glyph: '*', label: 'cap-d', meta: 'catA · x1', style: 'skill' },
          { id: 'skill:cap-e', glyph: '*', label: 'cap-e', meta: 'catA · x1', style: 'skill' },
          { id: 'skill:iso-catB', glyph: '*', label: 'iso-catB', meta: 'catB · x1', style: 'skill' },
        ],
      },
    ],
  });
  assert.equal(framesEdge.summary.length, 0);
  assert.equal(framesEdge.nodes.find((n) => n.id === 'skill:')?.skillName, 'skill:');
  assert.equal(framesEdge.nodes.find((n) => n.id === 'memory:plain')?.kind, 'memory');
  assert.equal(framesEdge.nodes.find((n) => n.id === 'other:custom')?.kind, 'skill');

  // hub-to-hub 连接：每组 hub 度数未达上限时串联相邻类别中心
  const hubGraph = buildConstellationGraph({
    frames: [],
    legend: [],
    categories: [],
    summary: [],
    axis: { start: '', end: '' },
    count: 3,
    cols: 40,
    rows: 16,
    buckets: [
      {
        index: 0,
        label: '24 Nov',
        date: '',
        skills: 3,
        memories: 0,
        total: 3,
        category: null,
        color: null,
        nodes: [
          { id: 'skill:hub-x1', glyph: '*', label: 'hub-x1', meta: 'catX · x5', style: 'skill' },
          { id: 'skill:sub-x2', glyph: '*', label: 'sub-x2', meta: 'catX · x1', style: 'skill' },
          { id: 'skill:hub-y1', glyph: '*', label: 'hub-y1', meta: 'catY · x2', style: 'skill' },
        ],
      },
    ],
  });
  assert.ok(hubGraph.edges.some((e) => e.source === 'skill:hub-x1' && e.target === 'skill:hub-y1' && e.kind === 'skill-link'));

  // 3. buildConstellationGraphFromRest: buckets 畸形元素 + numeric/overflow strings + links 别名 + 边种类 + 度上限
  const fromRestBuckets = buildConstellationGraphFromRest(
    {
      buckets: [
        null,
        { label: 'b-empty' },
        {
          label: 'b1',
          date: '2026-11-24',
          nodes: [null, { id: 'skill:s1', full_label: 'Full s1', content: 'Body s1', kind: 'learned-skill', meta: 'sec · x2' }],
        },
      ],
      summary: ['valid', '', 123],
      axis: { start: 's', end: 'e' },
    },
    'arch',
  );
  assert.deepEqual(fromRestBuckets.summary, ['valid']);
  assert.equal(fromRestBuckets.nodes.length, 1);

  const restEdgeCases = buildConstellationGraphFromRest(
    {
      data: {
        nodes: [
          null,
          {},
          { slug: 'slug-skill', type: 'learned-skill', val: '12', bucket_index: 3, tags: ['ops', ''] },
          { slug: 'slug-skill', label: 'duplicate-ignored' },
          { id: 'mem:m1', kind: 'memory', fullLabel: 'Memory referencing slug-skill and zero calls', uses: '0', group: '   ' },
          { id: 'mem:m2', kind: 'memory', title: 'Mem Two', uses: '9'.repeat(400), domain: 'sec' },
          { id: 'mem:m3', kind: 'memory', label: 'Mem Three', domain: 'sec' },
          { id: 'mem:m4', kind: 'memory', label: 'Mem Four', domain: 'sec' },
          { id: 'skill:s-extra1', label: 's-extra1', domain: 'sec', related_skills: ['unknown-skill'] },
          { id: 'skill:s-extra2', label: 's-extra2', domain: 'sec' },
          { id: 'skill:s-extra3', label: 's-extra3', domain: 'sec' },
          { id: 'skill:s-extra4', label: 's-extra4', domain: 'sec' },
          { id: 'skill:s-extra5', label: 's-extra5', domain: 'sec' },
          { id: 'skill:s-extra6', label: 's-extra6', domain: 'sec' },
        ],
        links: [
          null,
          { from: 'missing-src', to: 'mem:m1', type: 'mention' },
          { from: 'mem:m1', to: 'mem:m1', type: 'mention' }, // self-loop skipped
          { from: 'mem:m1', to: 'mem:m2', relation: 'skill-related', score: 0.9 },
          { from: 'mem:m2', to: 'mem:m3', kind: 'same-bucket-time' },
          { from: 'mem:m3', to: 'mem:m4', kind: 'custom-other' },
          { from: 'mem:m1', to: 'mem:m3', kind: 'skill-depends', weight: 0.7 },
          { from: 'mem:m1', to: 'mem:m4', kind: 'mention' },
          { from: 'mem:m1', to: 'slug-skill', kind: 'mention' },
          { from: 'mem:m1', to: 'skill:s-extra1', kind: 'mention' },
          { from: 'mem:m1', to: 'skill:s-extra2', kind: 'mention' }, // exceeds MAX_REST_EDGES_PER_NODE=6
        ],
        summary: 'bad-summary',
        axisStart: 'a0',
        axisEnd: 'a1',
      },
    },
    'arch',
  );
  assert.equal(restEdgeCases.profile, 'arch');
  assert.equal(restEdgeCases.nodes.find((n) => n.id === 'slug-skill')?.uses, 12);
  assert.deepEqual(restEdgeCases.nodes.find((n) => n.id === 'slug-skill')?.tags, ['ops']);
  assert.equal(restEdgeCases.edges.find((e) => e.source === 'mem:m1' && e.target === 'mem:m2')?.weight, 0.9);
  assert.equal(restEdgeCases.edges.find((e) => e.source === 'mem:m2' && e.target === 'mem:m3')?.kind, 'same-bucket');
  assert.equal(restEdgeCases.edges.find((e) => e.source === 'mem:m3' && e.target === 'mem:m4')?.kind, 'same-category');
  assert.equal(restEdgeCases.axisStart, 'a0');
  assert.equal(restEdgeCases.axisEnd, 'a1');

  // 无 edges/links 且无 nodes / 有 summary 数组兜底
  const minimalRest = buildConstellationGraphFromRest({ nodes: [], summary: 'nope' });
  assert.deepEqual(minimalRest.edges, []);
  assert.deepEqual(minimalRest.summary, []);
  const noNodesRest = buildConstellationGraphFromRest({ links: [] }, 'arch');
  assert.deepEqual(noNodesRest.nodes, []);
  assert.deepEqual(noNodesRest.edges, []);
  const withSummaryRest = buildConstellationGraphFromRest(
    { nodes: [{ id: 'skill:s', label: 's' }], summary: ['Key pattern', '', 42] },
    'arch',
  );
  assert.deepEqual(withSummaryRest.summary, ['Key pattern']);

  // 4. buildConstellationGraphFromSkills 空 id、前缀 id、注释标题、负/NaN uses 与跨连上限
  const builtSkills = buildConstellationGraphFromSkills(
    [
      { id: '' },
      { id: 'skill:prefixed', label: '<!-- ignored -->', uses: -5 },
      { id: 'a', label: 'A', description: 'Calls prefixed and b and c and d', category: 'core', uses: 20 },
      { id: 'b', label: 'B', category: 'core', uses: 10 },
      { id: 'c', label: 'C', category: 'core', uses: 5 },
      { id: 'd', label: 'D', category: 'core', uses: 3 },
      { id: 'e', label: 'E', category: 'core', uses: 1 },
      { id: 'e', label: 'dup' },
    ],
    'arch',
  );
  assert.equal(builtSkills.nodes.find((n) => n.id === 'skill:prefixed')?.uses, 0);
  assert.ok(builtSkills.edges.some((e) => e.kind === 'skill-link'));

  // 5. layoutFullConstellationGraph padding 边界、selectedId 未命中排序、same-bucket 弹簧与 tie-breakers
  const tieGraph = {
    profile: 'arch',
    source: 'rest-graph',
    nodes: [
      { id: 'mem:z', kind: 'memory', label: 'Z', fullLabel: 'Z', preview: 'Z', category: '', date: '', uses: 1, meta: '', bucketIndex: 0 },
      { id: 'skill:same-b', kind: 'skill', skillName: 'same-b', label: 'same', fullLabel: 'same', preview: 'same', category: '   ', date: '', uses: 5, meta: '', bucketIndex: 0 },
      { id: 'skill:same-a', kind: 'skill', skillName: 'same-a', label: 'same', fullLabel: 'same', preview: 'same', category: ' ', date: '', uses: 5, meta: '', bucketIndex: 0 },
      { id: 'skill:deg-hi', kind: 'skill', skillName: 'deg-hi', label: 'deg-hi', fullLabel: 'deg-hi', preview: 'deg-hi', category: 'zeta', date: '', uses: 5, meta: '', bucketIndex: 0 },
      { id: 'skill:tie-links-b', kind: 'skill', skillName: 'tie-links-b', label: 'b-lbl', fullLabel: 'b-lbl', preview: 'b-lbl', category: 'alpha', date: '', uses: 5, meta: '', bucketIndex: 0 },
    ],
    edges: [
      { source: 'skill:deg-hi', target: 'skill:deg-hi', kind: 'skill-link' }, // self-loop filtered
      { source: 'skill:deg-hi', target: 'skill:same-a', kind: 'same-bucket' },
      { source: 'skill:deg-hi', target: 'skill:same-b', kind: 'same-category' },
      { source: 'mem:z', target: 'skill:deg-hi', kind: 'mention' },
    ],
    summary: [],
    totalSkills: 4,
    totalMemories: 1,
    totalSkillLinks: 0,
    axisStart: '',
    axisEnd: '',
  };
  const customPad = layoutFullConstellationGraph(tieGraph, { selectedId: 'non-existent', padding: 48 });
  assert.equal(customPad.activeNode?.id, 'skill:deg-hi');
  const smallPad = layoutFullConstellationGraph(tieGraph, { padding: 8 });
  assert.equal(smallPad.nodes.length, 5);
  const badPad = layoutFullConstellationGraph(tieGraph, { padding: Number.NaN });
  assert.equal(badPad.nodes.length, 5);
  const strPadding = '40';
  const strPad = layoutFullConstellationGraph(tieGraph, { padding: strPadding });
  assert.equal(strPad.nodes.length, 5);
  const singleNodeLayout = layoutFullConstellationGraph({ ...tieGraph, nodes: [tieGraph.nodes[0]], edges: [] });
  assert.equal(singleNodeLayout.nodes.length, 1);

  // 同 uses 与同成员数量的不同 category 集群排序 + 纯 same-id 技能摘要排序 + memory<->memory/缺失端点边
  const tieOnlyGraph = {
    profile: 'arch',
    source: 'rest-graph',
    nodes: [
      { id: 'skill:z-tie', kind: 'skill', skillName: 'z-tie', label: 'same', fullLabel: 'same', preview: 'same', category: 'cat-b', date: '', uses: 5, meta: '', bucketIndex: 0 },
      { id: 'skill:a-tie', kind: 'skill', skillName: 'a-tie', label: 'same', fullLabel: 'same', preview: 'same', category: 'cat-a', date: '', uses: 5, meta: '', bucketIndex: 0 },
      { id: 'mem:m1', kind: 'memory', label: 'm1', fullLabel: 'm1', preview: 'm1', category: 'cat-c', date: '', uses: 1, meta: '', bucketIndex: 0 },
      { id: 'mem:m2', kind: 'memory', label: 'm2', fullLabel: 'm2', preview: 'm2', category: 'cat-c', date: '', uses: 1, meta: '', bucketIndex: 0 },
    ],
    edges: [
      { source: 'skill:z-tie', target: 'skill:z-tie', kind: 'skill-link' },
      { source: 'missing-node', target: 'skill:a-tie', kind: 'skill-link' },
      { source: 'skill:a-tie', target: 'missing-node', kind: 'skill-link' },
      { source: 'mem:m1', target: 'mem:m2', kind: 'same-category' },
    ],
    summary: [],
    totalSkills: 2,
    totalMemories: 2,
    totalSkillLinks: 0,
    axisStart: '',
    axisEnd: '',
  };
  const tieClusters = layoutFullConstellationGraph(tieOnlyGraph);
  assert.equal(tieClusters.nodes.length, 4);
  const pureSummaries = extractConstellationSkillList(tieOnlyGraph);
  assert.deepEqual(
    pureSummaries.map((s) => s.node.id),
    ['skill:a-tie', 'skill:z-tie'],
    '同 uses/linkCount/label 必须按 id 升序排列',
  );
  // buildConstellationGraphFromSkills 空白 category 回 fallback 'skill'
  const fallbackCat = buildConstellationGraphFromSkills([{ id: 's-bare', category: '   ' }], 'arch');
  assert.equal(fallbackCat.nodes[0]?.category, 'skill');
});

test('Stryker 契约强化：constellationLayout 精确几何/度排序/技能摘要 与 learningConstellation 全消减规则', () => {
  // 1. computeConstellationNodeRadius 精确公式、整数截断与上下限夹紧
  assert.equal(computeConstellationNodeRadius('skill', 0), 22);
  assert.equal(computeConstellationNodeRadius('skill', -5), 22);
  assert.equal(computeConstellationNodeRadius('skill', Number.NaN), 22);
  assert.equal(computeConstellationNodeRadius('skill', 3.9), 30);
  assert.equal(computeConstellationNodeRadius('skill', 10000), 40);
  assert.equal(computeConstellationNodeRadius('memory', 0), 18);
  assert.equal(computeConstellationNodeRadius('memory', 3.7), 23);
  assert.equal(computeConstellationNodeRadius('memory', 10000), 26);

  // 2. normalizeNonZeroDelta 精确阈值 1e-4 与 fallbackSeed 角度
  assert.deepEqual(normalizeNonZeroDelta(1e-4, 0, Math.PI), { dx: 1e-4, dy: 0, dist: 1e-4 });
  const tiny = normalizeNonZeroDelta(1e-5, 0, Math.PI / 2);
  assert.equal(tiny.dist, 1);
  assert.ok(Math.abs(tiny.dx) < 1e-6 && Math.abs(tiny.dy - 1) < 1e-6);

  // 3. layoutFullConstellationGraph 空布局、精确 padding/画幅、选中节点置尾、degree/skillLinkCount/isNeighbor 与默认选中 4 级优先级
  const emptyLayout = layoutFullConstellationGraph({
    profile: 'arch',
    source: 'rest-graph',
    nodes: [],
    edges: [],
    summary: [],
    totalSkills: 0,
    totalMemories: 0,
    totalSkillLinks: 0,
    axisStart: '',
    axisEnd: '',
  });
  assert.deepEqual(emptyLayout, {
    nodes: [],
    edges: [],
    width: 640,
    height: 440,
    activeNode: null,
    connectedIds: [],
    skillLinkCount: 0,
    totalUses: 0,
  });

  // 默认 activeNode 四级排序：uses 优先 -> degree 优先 -> id 升序
  const denseNodes = Array.from({ length: 10 }, (_, idx) => ({
    id: `skill:n${idx}`,
    kind: 'skill',
    skillName: `n${idx}`,
    label: `node-${idx}`,
    fullLabel: `node-${idx}`,
    preview: `node-${idx}`,
    category: idx < 5 ? 'grpA' : 'grpB',
    date: '',
    uses: idx === 0 ? 12 : idx === 1 ? 12 : 4,
    meta: '',
    bucketIndex: 0,
  }));
  denseNodes.push({
    id: 'memory:hub-mem',
    kind: 'memory',
    label: 'm',
    fullLabel: 'm',
    preview: 'm',
    category: 'grpA',
    date: '',
    uses: 99,
    meta: '',
    bucketIndex: 0,
  });
  const denseEdges = [
    { source: 'skill:n1', target: 'skill:n2', kind: 'same-category' }, // both skills -> counted as skillLink even if kind=same-category
    { source: 'skill:n1', target: 'skill:n3', kind: 'skill-link' },
    { source: 'skill:n0', target: 'memory:hub-mem', kind: 'mention' },
    { source: 'skill:n1', target: 'memory:hub-mem', kind: 'mention' }, // n1 degree=3 > n0 degree=1 with same uses=12
    { source: 'skill:n2', target: 'skill:n4', kind: 'skill-link' },
    { source: 'skill:n4', target: 'skill:n5', kind: 'skill-link' },
    { source: 'skill:n5', target: 'skill:n6', kind: 'skill-link' },
    { source: 'skill:n6', target: 'skill:n7', kind: 'skill-link' },
    { source: 'skill:n7', target: 'skill:n8', kind: 'skill-link' },
    { source: 'skill:n8', target: 'skill:n9', kind: 'skill-link' },
  ];
  const denseGraph = {
    profile: 'arch',
    source: 'rest-graph',
    nodes: denseNodes,
    edges: denseEdges,
    summary: [],
    totalSkills: 10,
    totalMemories: 1,
    totalSkillLinks: 7,
    axisStart: '',
    axisEnd: '',
  };
  const denseLayout = layoutFullConstellationGraph(denseGraph, { padding: 24 });
  assert.equal(denseLayout.activeNode?.id, 'skill:n1', 'uses 相同时应选 degree 最高的 skill');
  assert.equal(denseLayout.nodes.at(-1)?.id, 'skill:n1', '选中节点必须放在 SVG 渲染数组最后居顶');
  assert.equal(denseLayout.nodes.at(-1)?.isSelected, true);
  assert.equal(denseLayout.skillLinkCount, 8, '两端都是 skill 且 kind!=skill-link 的边也计入 skillLinkCount');
  assert.equal(denseLayout.totalUses, 12 + 12 + 8 * 4 + 99);
  assert.deepEqual(new Set(denseLayout.connectedIds), new Set(['skill:n2', 'skill:n3', 'memory:hub-mem']));
  assert.equal(denseLayout.nodes.find((n) => n.id === 'skill:n2')?.isNeighbor, true);
  assert.equal(denseLayout.nodes.find((n) => n.id === 'skill:n9')?.isNeighbor, false);

  const minLeft = Math.min(...denseLayout.nodes.map((n) => n.x - n.radius));
  const minTop = Math.min(...denseLayout.nodes.map((n) => n.y - n.radius));
  const maxRight = Math.max(...denseLayout.nodes.map((n) => n.x + n.radius));
  const maxBottom = Math.max(...denseLayout.nodes.map((n) => n.y + n.radius));
  assert.ok(Math.abs(minLeft - 24) <= 0.02);
  assert.ok(Math.abs(minTop - 24) <= 0.02);
  assert.equal(denseLayout.width, Math.max(640, Math.ceil(maxRight + 24)));
  assert.equal(denseLayout.height, Math.max(440, Math.ceil(maxBottom + 24)));

  // exact id tiebreak & isolated padding below 24 falls back to DEFAULT_PADDING = 92
  const idTieLayout = layoutFullConstellationGraph(
    {
      ...denseGraph,
      nodes: [
        { id: 'skill:b', kind: 'skill', label: 'b', fullLabel: 'b', preview: 'b', category: 'c', date: '', uses: 5, meta: '', bucketIndex: 0 },
        { id: 'skill:a', kind: 'skill', label: 'a', fullLabel: 'a', preview: 'a', category: 'c', date: '', uses: 5, meta: '', bucketIndex: 0 },
      ],
      edges: [],
    },
    { padding: 23 },
  );
  assert.equal(idTieLayout.activeNode?.id, 'skill:a');
  const minLeftFallback = Math.min(...idTieLayout.nodes.map((n) => n.x - n.radius));
  assert.ok(Math.abs(minLeftFallback - 92) <= 0.02);

  // 4. extractConstellationSkillList 精确关联、x-skill: 锚点保留、空白回退 id、negative/float uses 与四级排序
  const listGraph = {
    profile: 'arch',
    source: 'rest-graph',
    nodes: [
      { id: 'x-skill:keep', kind: 'skill', skillName: '', label: 'keep', fullLabel: 'keep', preview: 'keep', category: 'ops', date: '', uses: -3, meta: '', bucketIndex: 0 },
      { id: 'skill:   ', kind: 'skill', skillName: '   ', label: 'blank-sk', fullLabel: 'blank', preview: 'blank', category: 'ops', date: '', uses: 5.9, meta: '', bucketIndex: 0 },
      { id: 'skill:hi', kind: 'skill', skillName: '  trimmed-hi  ', label: 'hi', fullLabel: 'hi', preview: 'hi', category: 'ops', date: '', uses: 5.9, meta: '', bucketIndex: 0 },
      { id: 'skill:peer', kind: 'skill', skillName: 'peer', label: 'peer', fullLabel: 'peer', preview: 'peer', category: 'ops', date: '', uses: 1, meta: '', bucketIndex: 0 },
      { id: 'mem:m-a', kind: 'memory', label: 'ma', fullLabel: 'ma', preview: 'ma', category: 'ops', date: '', uses: 1, meta: '', bucketIndex: 0 },
    ],
    edges: [
      { source: 'skill:hi', target: 'skill:peer', kind: 'skill-link' },
      { source: 'mem:m-a', target: 'skill:hi', kind: 'mention' },
    ],
    summary: [],
    totalSkills: 4,
    totalMemories: 1,
    totalSkillLinks: 1,
    axisStart: '',
    axisEnd: '',
  };
  const extracted = extractConstellationSkillList(listGraph);
  assert.equal(extracted[0]?.skillName, 'trimmed-hi');
  assert.equal(extracted[0]?.uses, 5);
  assert.equal(extracted[0]?.linkCount, 1);
  assert.deepEqual(extracted[0]?.relatedSkillIds, ['skill:peer']);
  assert.deepEqual(extracted[0]?.relatedMemoryIds, ['mem:m-a']);
  assert.equal(extracted.find((s) => s.node.id === 'x-skill:keep')?.skillName, 'x-skill:keep');
  assert.equal(extracted.find((s) => s.node.id === 'x-skill:keep')?.uses, 0);
  assert.equal(extracted.find((s) => s.node.id === 'skill:   ')?.skillName, 'skill:   ');

  // 5. learningConstellation 精细规则消减：cleanLearningLabel 双注释/标签前缀、parseLearningUses、date/label 全空、同域双技能 sparse 建边、REST 未知分类边与 dstLookup
  assert.equal(cleanLearningLabel('<!-- a -->First<!-- b --> Second'), 'First Second');
  assert.equal(parseLearningUses('x7'), 7);
  assert.equal(parseLearningUses('foo x14 bar'), 14);
  assert.equal(parseLearningUses('max5'), 0);

  const lcFrames = buildConstellationGraph(
    {
      summary: ['s1'],
      axis: { start: 'S', end: 'E' },
      buckets: [
        {
          index: 0,
          label: '',
          date: '',
          nodes: [
            { id: 'skill:sp-1', label: 'sp1', meta: 'unique-cat · x2', style: 'skill' },
            { id: 'skill:sp-2', label: 'sp2', meta: 'unique-cat · x1', style: 'skill' },
            { id: 'memory:m-d', label: 'mem-d', body: 'Detailed body differs from label', meta: 'other', style: 'memory' },
          ],
        },
        {
          index: 1,
          label: ' ',
          date: ' ',
          category: 'unique-cat',
          nodes: [
            { id: 'skill:ab', label: 'ab', meta: 'general', body: 'Calls sp-3', style: 'skill' },
            { id: 'skill:cd', label: 'xyz', meta: 'other', body: 'Uses abc and defg', style: 'skill' },
          ],
        },
      ],
    },
    '  arch  ',
  );
  assert.equal(lcFrames.profile, 'arch');
  assert.equal(lcFrames.source, 'ws-frames');
  assert.equal(lcFrames.axisStart, 'S');
  assert.equal(lcFrames.axisEnd, 'E');
  assert.equal(lcFrames.nodes.find((n) => n.id === 'skill:sp-1')?.date, '');
  assert.equal(lcFrames.nodes.find((n) => n.id === 'memory:m-d')?.description, 'Detailed body differs from label');
  assert.equal(lcFrames.nodes.find((n) => n.id === 'skill:sp-1')?.description, undefined);
  assert.ok(lcFrames.edges.some((e) => e.kind === 'skill-link' && ((e.source === 'skill:sp-1' && e.target === 'skill:sp-2') || (e.target === 'skill:sp-1' && e.source === 'skill:sp-2'))));

  const restRich = buildConstellationGraphFromRest(
    {
      nodes: [
        { id: 'skill:DeployTool', kind: 'skill', name: 'DeployTool', label: 'DeployTool', description: 'Deploy automation', uses: 15, category: 'ops' },
        { id: 'memory:ref-1', kind: 'memory', label: 'ref1', content: 'Notes', category: 'ops' },
        { id: 'memory:ref-2', kind: 'memory', label: 'ref2', content: 'More', category: 'ops' },
      ],
      edges: [
        { source: 'memory:ref-1', target: 'deploytool', kind: 'arbitrary-unknown' },
        { source: 'memory:ref-1', target: 'memory:ref-2', kind: 'arbitrary-unknown' },
        { source: 'deploytool', target: 'memory:ref-2', kind: 'time-window' },
      ],
      axisStart: 'A0',
      axisEnd: 'A1',
    },
    'arch',
  );
  assert.equal(restRich.axisStart, 'A0');
  assert.equal(restRich.axisEnd, 'A1');
  assert.equal(restRich.totalSkillLinks, 0);
  assert.equal(
    restRich.edges.find((e) => e.source === 'memory:ref-1' && e.target === 'skill:DeployTool')?.kind,
    'mention',
    '未知 rawKind 的异构连线必须判为 mention',
  );
  assert.equal(
    restRich.edges.find((e) => e.source === 'memory:ref-1' && e.target === 'memory:ref-2')?.kind,
    'same-category',
  );
  assert.equal(
    restRich.edges.find((e) => e.source === 'skill:DeployTool' && e.target === 'memory:ref-2')?.kind,
    'same-bucket',
  );

  // buildConstellationGraphFromSkills meta / uses=0 / description 精确断言
  const profileSkills = buildConstellationGraphFromSkills(
    [
      { id: 'skill:alpha', label: 'Alpha', description: 'Calls beta', category: 'devops', uses: 5 },
      { id: 'skill:beta', label: 'Beta', category: 'devops', uses: 0 },
    ],
    'ops-bot',
  );
  assert.equal(profileSkills.source, 'profile-skills');
  assert.equal(profileSkills.totalMemories, 0);
  assert.equal(profileSkills.totalSkillLinks, 1);
  assert.equal(profileSkills.nodes[0]?.meta, 'devops · x5');
  assert.equal(profileSkills.nodes[0]?.skillName, 'alpha');
  assert.equal(profileSkills.nodes[0]?.description, 'Calls beta');
  assert.equal(profileSkills.nodes[1]?.meta, 'devops');
  assert.equal(profileSkills.nodes[1]?.description, undefined);
  assert.deepEqual(profileSkills.summary, []);
  assert.equal(profileSkills.axisStart, '');
  assert.equal(profileSkills.axisEnd, '');
  assert.equal(profileSkills.nodes[0]?.date, '');
  assert.equal(profileSkills.nodes[0]?.bucketIndex, 0);
  assert.equal(profileSkills.nodes[1]?.bucketIndex, 1);

  // 6. 精准消减 constellationLayout 剩余 3 处孤立节点度数为 0 与派生 skillName / 非相同 label 排序断言
  const isolatedCheck = layoutFullConstellationGraph({
    profile: 'arch',
    source: 'rest-graph',
    nodes: [
      { id: 'skill:iso-sk', kind: 'skill', label: 'iso-sk', fullLabel: 'iso-sk', preview: 'iso-sk', category: 'ops', date: '', uses: 1, meta: '', bucketIndex: 0 },
    ],
    edges: [],
    summary: [],
    totalSkills: 1,
    totalMemories: 0,
    totalSkillLinks: 0,
    axisStart: '',
    axisEnd: '',
  });
  assert.equal(isolatedCheck.nodes[0]?.degree, 0);
  assert.equal(isolatedCheck.nodes[0]?.skillLinkCount, 0);
  const derivedSkillSummary = extractConstellationSkillList({
    profile: 'arch',
    source: 'rest-graph',
    nodes: [
      { id: 'skill:bare-derived', kind: 'skill', skillName: '', label: 'beta', fullLabel: 'b', preview: 'b', category: 'c', date: '', uses: 5, meta: '', bucketIndex: 0 },
      { id: 'skill:alpha-lbl', kind: 'skill', skillName: '', label: 'alpha', fullLabel: 'a', preview: 'a', category: 'c', date: '', uses: 5, meta: '', bucketIndex: 0 },
    ],
    edges: [],
    summary: [],
    totalSkills: 2,
    totalMemories: 0,
    totalSkillLinks: 0,
    axisStart: '',
    axisEnd: '',
  });
  assert.deepEqual(derivedSkillSummary.map((s) => s.skillName), ['alpha-lbl', 'bare-derived']);

  // 7. 精准消减 learningConstellation L151-725 全部可观测行为（cleanLearningLabel/parseLearningUses/sparse skill-link/cross-links 长度边界/REST 兼容桶/related_skills/fromSkills）
  assert.equal(cleanLearningLabel('<!-- leading -->Alpha   Beta\n\tGamma'), 'Alpha Beta Gamma');
  assert.equal(buildConstellationGraph({ count: 0 }, 'default').axisStart, '');
  assert.equal(buildConstellationGraph({ count: 0 }, 'default').axisEnd, '');

  // L329 sparse general-category skills in separate buckets -> 'skill-link' (fixes NoCoverage L329!)
  const sparseSkillsSameGenericCat = buildConstellationGraph({
    count: 2,
    buckets: [
      { index: 0, label: 'D1', date: 'D1', category: 'general', nodes: [{ id: 'skill:g1', label: 'g1', style: 'skill' }] },
      { index: 1, label: 'D2', date: 'D2', category: 'general', nodes: [{ id: 'skill:g2', label: 'g2', style: 'skill' }] },
      { index: 2, label: 'D3', date: 'D3', category: 'general', nodes: [{ id: 'memory:mem-as-sk', label: 'ms', style: 'learned-skill', body: 'ms body' }] },
    ],
  });
  assert.ok(sparseSkillsSameGenericCat.edges.some((e) => e.source === 'skill:g1' && e.target === 'skill:g2' && e.kind === 'skill-link'));
  assert.equal(sparseSkillsSameGenericCat.nodes.find((n) => n.id === 'memory:mem-as-sk')?.kind, 'skill');

  // addSkillCrossLinks 阈值 (bSkillName >= 3, bId >= 3 when different, bLabel >= 4) + memory mention skName >= 4 / skLabel >= 4 / skId
  const crossLenGraph = buildConstellationGraph({
    count: 6,
    buckets: [
      {
        index: 0,
        label: 'D',
        date: '',
        category: 'other',
        nodes: [
          { id: 'skill:xy', label: 'xy', style: 'skill', meta: 'general' },
          { id: 'skill:ab', label: 'ab', style: 'skill', meta: 'skill' },
          { id: 'skill:abc', label: 'lbl', style: 'skill', meta: 'memory' },
          { id: 'skill:skid-only', label: 'uniqLbl4', style: 'skill', meta: 'other' },
          { id: 'skill:caller', label: 'caller', body: 'mentions xy ab skill:abc uniqLbl4', style: 'skill', meta: 'other' },
          { id: 'memory:m-hit-skid', label: 'm', body: 'references skill:skid-only', style: 'memory', meta: 'other' },
          { id: 'memory:m-hit-lbl4', label: 'm2', body: 'mentions uniqlbl4 only', style: 'memory', meta: 'other' },
        ],
      },
    ],
  });
  assert.equal(crossLenGraph.edges.some((e) => e.source === 'skill:caller' && e.target === 'skill:xy'), false, 'id/name<3 不得触发互引');
  assert.ok(crossLenGraph.edges.some((e) => e.source === 'skill:caller' && e.target === 'skill:abc' && e.kind === 'skill-link'));
  assert.ok(crossLenGraph.edges.some((e) => e.source === 'memory:m-hit-skid' && e.target === 'skill:skid-only' && e.kind === 'mention'));
  assert.ok(crossLenGraph.edges.some((e) => e.source === 'memory:m-hit-lbl4' && e.target === 'skill:skid-only' && e.kind === 'mention'));

  // REST buckets 兼容全字段 + node 去重优先级（先到优先，dup 不覆盖，空白 id 跳过）+ fallback fullLabel/content/kind + related_skills 跨分类边 + unknown target lookup (kills L595 NoCoverage!)
  const restBucketsRich = buildConstellationGraphFromRest(
    {
      graph: {
        buckets: [
          {
            label: '03 Nov',
            date: '03 Nov 2026',
            category: 'infra',
            nodes: [
              { id: 'skill:k1', label: 'k1', fullLabel: 'Primary Full Label', meta: 'infra · x4', body: 'Body preferred' },
              { id: 'skill:k2', label: 'k2', full_label: 'Snake full', content: 'Snake content', type: 'learned-skill', meta: 'infra · x2' },
              { id: 'memory:k3', label: 'k3', kind: 'memory', meta: '  infra · detail  ' },
            ],
          },
        ],
        summary: ['Line A', 99, ''],
        axis: { start: '01', end: '03' },
      },
    },
    'arch',
  );
  assert.equal(restBucketsRich.axisStart, '01');
  assert.equal(restBucketsRich.axisEnd, '03');
  assert.deepEqual(restBucketsRich.summary, ['Line A']);
  assert.equal(restBucketsRich.nodes.find((n) => n.id === 'skill:k1')?.uses, 4);
  assert.equal(restBucketsRich.nodes.find((n) => n.id === 'skill:k1')?.fullLabel, 'Body preferred');
  assert.equal(restBucketsRich.nodes.find((n) => n.id === 'skill:k2')?.kind, 'skill');
  assert.equal(restBucketsRich.nodes.find((n) => n.id === 'skill:k2')?.fullLabel, 'Snake content');
  assert.equal(restBucketsRich.nodes.find((n) => n.id === 'skill:k2')?.bucketIndex, 0);
  assert.equal(restBucketsRich.nodes.find((n) => n.id === 'memory:k3')?.category, 'infra');

  // REST nodes: related_skills 跨分类专用边 + duplicate 不覆盖首项 + unknown target lookup (L595) + readNonNegInt 各别名 + score:NaN
  const restFieldsAll = buildConstellationGraphFromRest(
    {
      nodes: [
        { id: '   ', label: 'blank-skipped' },
        { id: 'skill:src-a', kind: 'skill', label: 'First Src', description: 'Src desc', domain: 'd1', useCount: 6, related_skills: ['dst-b', 'not-found'], created_at: '2026-11-20', tags: ['a', 123, 'b'] },
        { id: 'skill:src-a', kind: 'skill', label: 'Duplicate Ignored', domain: 'd2', useCount: 999 },
        { id: 'skill:dst-b', kind: 'skill', label: 'Dst B', domain: 'd2', callCount: 4, observed: '2026-11-21', summary: 'Summary body' },
        { id: 'skill:inv-c', kind: 'skill', label: 'Inv C', domain: 'd3', invocations: 3, body: 'Body c' },
        { id: 'memory:cnt-d', kind: 'memory', label: 'Cnt D', domain: 'd4', count: 2, date: '2026-11-22' },
        { id: 'memory:str-e', label: 'Str E', uses: -5, content: 'Mentions src-a explicitly' },
      ],
      edges: [
        { source: 'src-a', target: 'unknown-target-for-L595', kind: 'mention', score: Number.NaN },
        { source: 'memory:cnt-d', target: 'memory:str-e', kind: 'ref-use' },
        { source: 'memory:cnt-d', target: 'memory:cnt-d', kind: 'mention' },
      ],
    },
    'arch',
  );
  assert.equal(restFieldsAll.nodes.find((n) => n.id === 'skill:src-a')?.label, 'First Src', '重复节点必须保留首项');
  assert.equal(restFieldsAll.nodes.find((n) => n.id === 'skill:src-a')?.uses, 6);
  assert.equal(restFieldsAll.nodes.find((n) => n.id === 'skill:src-a')?.date, '2026-11-20');
  assert.equal(restFieldsAll.nodes.find((n) => n.id === 'skill:src-a')?.meta, 'd1 · x6');
  assert.deepEqual(restFieldsAll.nodes.find((n) => n.id === 'skill:src-a')?.tags, ['a', 'b']);
  assert.equal(restFieldsAll.nodes.find((n) => n.id === 'skill:dst-b')?.uses, 4);
  assert.equal(restFieldsAll.nodes.find((n) => n.id === 'skill:inv-c')?.uses, 3);
  assert.equal(restFieldsAll.nodes.find((n) => n.id === 'memory:cnt-d')?.uses, 2);
  assert.equal(restFieldsAll.nodes.find((n) => n.id === 'memory:str-e')?.uses, 0);
  assert.equal(restFieldsAll.nodes.find((n) => n.id === 'memory:str-e')?.kind, 'memory');
  assert.ok(
    restFieldsAll.edges.some((e) => e.source === 'skill:src-a' && e.target === 'skill:dst-b' && e.kind === 'skill-link'),
    '不同 domain 之间仅通过 related_skills 声明必须建 skill-link',
  );
  assert.equal(restFieldsAll.edges.some((e) => e.target === 'unknown-target-for-L595'), false);

  // buildConstellationGraphFromSkills: x-skill: keep + whitespace id skipped + invalid uses + empty edges count
  const fromSkillsStrict = buildConstellationGraphFromSkills(
    [
      { id: '   ', label: 'skip' },
      { id: 'x-skill:tool', label: 'tool', uses: 'invalid', category: 'ops' },
    ],
    'reviewer',
  );
  assert.equal(fromSkillsStrict.nodes.length, 1);
  assert.equal(fromSkillsStrict.nodes[0]?.skillName, 'x-skill:tool');
  assert.equal(fromSkillsStrict.nodes[0]?.uses, 0);
  assert.equal(fromSkillsStrict.totalSkillLinks, 0);
  assert.equal(fromSkillsStrict.nodes[0]?.fullLabel, 'tool');
  assert.equal(fromSkillsStrict.nodes[0]?.preview, 'tool');
  assert.equal(fromSkillsStrict.nodes[0]?.kind, 'skill');
  assert.equal(fromSkillsStrict.nodes[0]?.date, '');
  assert.deepEqual(fromSkillsStrict.summary, []);
  assert.equal(fromSkillsStrict.axisStart, '');
  assert.equal(fromSkillsStrict.axisEnd, '');
  assert.equal(
    buildConstellationGraphFromSkills([{ id: 'raw-only', uses: Number.NaN }], 'ops').nodes[0]?.fullLabel,
    'raw-only',
  );
  assert.equal(
    buildConstellationGraphFromSkills([{ id: 'neg-only', uses: -1 }], 'ops').nodes[0]?.uses,
    0,
  );
});

test('Stryker 契约强化 Part 2：learningConstellation 深层字段归一、长度边界与去重隔离', () => {
  // 1. clipLabel exact MAX_DISPLAY_LABEL_LEN = 26 边界
  const exact26 = 'x'.repeat(26);
  const over27 = 'y'.repeat(27);
  const clipped = buildConstellationGraphFromSkills(
    [
      { id: 'c26', label: exact26 },
      { id: 'c27', label: over27 },
    ],
    'ops',
  );
  assert.equal(clipped.nodes[0]?.label, exact26);
  assert.equal(clipped.nodes[0]?.label.length, 26);
  assert.equal(clipped.nodes[1]?.label, `${'y'.repeat(25)}…`);
  assert.equal(clipped.nodes[1]?.label.length, 26);

  // 2. addSkillCrossLinks 四类泛化类别 ('skill','memory','general','other') 各自隔离 + 长度 2 vs 3 与 3 vs 4 边界
  const genericIso = buildConstellationGraphFromSkills(
    [
      { id: 'g-sk-1', label: 'n1', category: 'SKILL' },
      { id: 'g-sk-2', label: 'n2', category: 'skill' },
      { id: 'g-mem-1', label: 'm1', category: 'MEMORY' },
      { id: 'g-mem-2', label: 'm2', category: 'memory' },
      { id: 'g-gen-1', label: 'g1', category: 'General' },
      { id: 'g-gen-2', label: 'g2', category: 'general' },
      { id: 'g-oth-1', label: 'o1', category: 'Other' },
      { id: 'g-oth-2', label: 'o2', category: 'other' },
      { id: 'zz', label: 'zz', category: 'other' }, // id/name length 2 (<3)
      { id: 'zzz', label: 'ab', category: 'other' }, // id length 3
      { id: 'w1', label: 'abc', category: 'other' }, // label length 3 (<4)
      { id: 'w2', label: 'abcd', category: 'other' }, // label length 4 (>=4)
      { id: 'caller', label: 'caller', description: 'Mentions zz zzz abc abcd', category: 'other' },
    ],
    'ops',
  );
  assert.equal(genericIso.edges.some((e) => e.source === 'skill:g-sk-1' || e.target === 'skill:g-sk-1'), false);
  assert.equal(genericIso.edges.some((e) => e.source === 'skill:g-mem-1' || e.target === 'skill:g-mem-1'), false);
  assert.equal(genericIso.edges.some((e) => e.source === 'skill:g-gen-1' || e.target === 'skill:g-gen-1'), false);
  assert.equal(genericIso.edges.some((e) => e.source === 'skill:g-oth-1' || e.target === 'skill:g-oth-1'), false);
  assert.equal(genericIso.edges.some((e) => e.target === 'skill:zz' || e.source === 'skill:zz'), false);
  assert.equal(genericIso.edges.some((e) => e.target === 'skill:w1' || e.source === 'skill:w1'), false);
  assert.ok(genericIso.edges.some((e) => e.source === 'skill:caller' && e.target === 'skill:zzz' && e.kind === 'skill-link'));
  assert.ok(genericIso.edges.some((e) => e.source === 'skill:caller' && e.target === 'skill:w2' && e.kind === 'skill-link'));

  // 3. buildConstellationGraph sparse degree break (停在 2 条边而不是全部连完), totalSkillLinks, memory mention skName=4/skLabel=4 vs 3
  const sparseCapGraph = buildConstellationGraph({
    count: 7,
    buckets: [
      { index: 0, label: 'L0', date: 'D0', category: 'solo-dom', nodes: [{ id: 'memory:anchor', label: 'anc', style: 'memory', body: 'uses abcd and wxyz only' }] },
      { index: 1, label: 'L1', date: 'D1', category: 'solo-dom', nodes: [{ id: 'memory:n1', label: 'n1', style: 'memory' }] },
      { index: 2, label: 'L2', date: 'D2', category: 'solo-dom', nodes: [{ id: 'memory:n2', label: 'n2', style: 'memory' }] },
      { index: 3, label: 'L3', date: 'D3', category: 'solo-dom', nodes: [{ id: 'memory:n3', label: 'n3', style: 'memory' }] },
      { index: 4, label: 'L4', date: 'D4', category: 'solo-dom', nodes: [{ id: 'memory:n4', label: 'n4', style: 'memory' }] },
      { index: 5, label: 'L5', date: 'D5', category: 'solo-dom', nodes: [{ id: 'memory:n5', label: 'n5', style: 'memory' }] },
      { index: 6, label: 'L6', date: '', category: 'other', nodes: [
        { id: 'skill:short3', label: 'abc', style: 'skill' },
        { id: 'skill:exact4n', label: 'abcd', style: 'skill' },
        { id: 'skill:s-wxyz', label: 'wxyz', style: 'skill' },
      ] },
    ],
  });
  const anchorDeg = sparseCapGraph.edges.filter(
    (e) => e.source === 'memory:anchor' || e.target === 'memory:anchor',
  ).length;
  assert.equal(anchorDeg, 2, '已具备 2 条 mention 边的节点不再触发 sparse same-category 补边');
  assert.equal(
    sparseCapGraph.edges.filter((e) => e.kind === 'same-category' && (e.source === 'memory:n1' || e.target === 'memory:n1')).length,
    2,
  );
  assert.equal(
    sparseCapGraph.edges.some((e) => e.source === 'memory:n1' && (e.target === 'memory:n4' || e.target === 'memory:n5')),
    false,
  );
  assert.equal(sparseCapGraph.totalSkillLinks, 2, '仅 skill<->skill 边计入 totalSkillLinks（不包含 memory->memory 与 mention）');
  assert.ok(sparseCapGraph.edges.length > sparseCapGraph.totalSkillLinks);
  assert.ok(sparseCapGraph.edges.some((e) => e.source === 'memory:anchor' && e.target === 'skill:exact4n' && e.kind === 'mention'));
  assert.ok(sparseCapGraph.edges.some((e) => e.source === 'memory:anchor' && e.target === 'skill:s-wxyz' && e.kind === 'mention'));

  // 4. buildConstellationGraphFromRest(null) 全结构校验 + root vs inner profile + REST 全部字段回退 + related_skills 在 'other' 分类中唯一建边
  assert.deepEqual(buildConstellationGraphFromRest(null, 'ops'), {
    profile: 'ops',
    source: 'rest-graph',
    nodes: [],
    edges: [],
    summary: [],
    totalSkills: 0,
    totalMemories: 0,
    totalSkillLinks: 0,
    axisStart: '',
    axisEnd: '',
  });
  assert.equal(buildConstellationGraphFromRest({ graph: { nodes: [] }, profile: 'from-root' }, 'def').profile, 'from-root');
  assert.equal(buildConstellationGraphFromRest({ graph: { profile: 'inner-p', nodes: [] }, profile: 'from-root' }, 'def').profile, 'inner-p');

  const restAllFallbacks = buildConstellationGraphFromRest(
    {
      nodes: [
        { id: 'skill:f1', kind: 'SKILL', fullLabel: 'FL1', label: 'L1', domain: 'other', related_skills: ['UPPER-F2', ''], skill_name: 'SK1', uses: '15.0' },
        { id: 'skill:f2', kind: 'learned-skill', full_label: 'FL2', title: 'T2', category: 'other', skillName: 'upper-f2', uses: ' 12abc ' },
        { id: 'skill:f3', description: 'DESC3', name: 'sk-name-3', category: 'other', call_count: 8, tags: ['   '] },
        { id: 'skill:f4', summary: 'SUM4', category: 'other', bucket_index: 9, uses: '   ' },
        { id: 'skill:f5', body: 'BODY5', category: 'other', uses: '10' },
        { id: 'skill:f6', content: 'CONT6', category: 'other', meta: 'cat6 · x3' },
        { id: 'memory:m-other', category: 'other', content: 'touches upper-f2 and sk-name-3', count: 1 },
      ],
      edges: [
        { source: 'memory:m-other', target: 'UPPER-F2', kind: 'explicit-type', score: 0.5 },
        { source: 'memory:m-other', target: 'skill:f1', weight: 0.8 },
      ],
    },
    'arch',
  );
  assert.equal(restAllFallbacks.nodes.find((n) => n.id === 'skill:f1')?.fullLabel, 'FL1');
  assert.equal(restAllFallbacks.nodes.find((n) => n.id === 'skill:f1')?.skillName, 'SK1');
  assert.equal(restAllFallbacks.nodes.find((n) => n.id === 'skill:f1')?.uses, 0, '非纯整数串 "15.0" 必须 rejected 回 0');
  assert.equal(restAllFallbacks.nodes.find((n) => n.id === 'skill:f2')?.fullLabel, 'FL2');
  assert.equal(restAllFallbacks.nodes.find((n) => n.id === 'skill:f2')?.label, 'T2');
  assert.equal(restAllFallbacks.nodes.find((n) => n.id === 'skill:f2')?.uses, 0, 'trailing abc 非纯数字必须回 0');
  assert.equal(restAllFallbacks.nodes.find((n) => n.id === 'skill:f3')?.fullLabel, 'DESC3');
  assert.equal(restAllFallbacks.nodes.find((n) => n.id === 'skill:f3')?.uses, 8);
  assert.equal(restAllFallbacks.nodes.find((n) => n.id === 'skill:f3')?.tags, undefined, '全空 tags 过滤后不得挂载空数组');
  assert.equal(restAllFallbacks.nodes.find((n) => n.id === 'skill:f4')?.fullLabel, 'SUM4');
  assert.equal(restAllFallbacks.nodes.find((n) => n.id === 'skill:f4')?.bucketIndex, 9);
  assert.equal(restAllFallbacks.nodes.find((n) => n.id === 'skill:f5')?.fullLabel, 'BODY5');
  assert.equal(restAllFallbacks.nodes.find((n) => n.id === 'skill:f5')?.uses, 10);
  assert.equal(restAllFallbacks.nodes.find((n) => n.id === 'skill:f6')?.uses, 3);
  assert.ok(
    restAllFallbacks.edges.some((e) => e.source === 'skill:f1' && e.target === 'skill:f2' && e.kind === 'skill-link'),
    'other 分类下禁止 addSkillCrossLinks 后，related_skills 是 f1->f2 的唯一边来源',
  );
  assert.equal(restAllFallbacks.totalSkillLinks, 1);

  // REST buckets: fullLabel without full_label, body without content, explicit bucket.index=7
  const restBucketFields = buildConstellationGraphFromRest(
    {
      buckets: [
        {
          index: 7,
          category: 'ops',
          nodes: [
            { id: 'skill:bk1', label: 'bk1', fullLabel: 'FullCamelOnly', body: 'BodyOnly', meta: 'ops · x1' },
          ],
        },
      ],
    },
    'ops',
  );
  assert.equal(restBucketFields.nodes[0]?.fullLabel, 'BodyOnly');
  assert.equal(restBucketFields.nodes[0]?.bucketIndex, 7);

  // 5. Part 3 精细消减：cleanLearningLabel 无空格拼接、extractCategory undefined、deriveSkillName ^skill 锚点、hub uses 最大选中、edgeCap 严格上限、REST auto addSkillCrossLinks 与 3-char label 不匹配
  assert.equal(cleanLearningLabel('alpha<!-- mid -->omega'), 'alpha omega');
  assert.equal('weight' in restBucketFields, false);

  const hubOrderAndRestLink = buildConstellationGraphFromRest(
    {
      nodes: [
        { id: 'skill:a-low', kind: 'skill', label: 'a-low', category: 'infra', uses: 1 },
        { id: 'skill:z-hub', kind: 'skill', label: 'z-hub', category: 'infra', uses: 20 },
        { id: 'skill:m-mid', kind: 'skill', label: 'm-mid', category: 'infra', uses: 5 },
        { id: 'skill:lbl-id', kind: 'skill', label: 'xyz', skillName: 'q', category: 'other' },
        { id: 'memory:no-hit', kind: 'memory', label: 'nh', content: 'has xyz inside', category: 'other' },
      ],
      edges: [
        { from: 'skill:a-low', to: 'skill:a-low', kind: 'skill-link' }, // self-loop dropped by tryAddEdge
        { from: 'memory:no-hit', to: 'skill:lbl-id', kind: 'mention' },
      ],
    },
    'arch',
  );
  assert.equal(hubOrderAndRestLink.edges.some((e) => e.source === e.target), false);
  assert.equal('weight' in (hubOrderAndRestLink.edges[0] || {}), false);
  assert.ok(
    hubOrderAndRestLink.edges.some((e) => e.source === 'skill:z-hub' && e.target === 'skill:a-low' && e.kind === 'skill-link'),
  );
  assert.ok(
    hubOrderAndRestLink.edges.some((e) => e.source === 'skill:z-hub' && e.target === 'skill:m-mid' && e.kind === 'skill-link'),
  );
  assert.equal(
    hubOrderAndRestLink.edges.some((e) => e.source === 'skill:a-low' && e.target === 'skill:m-mid'),
    false,
    '非 hub 之间不得互相直连，必须以 uses 最高的 z-hub 为中心',
  );

  // exact MAX_EDGES_PER_NODE = 4 封顶与 category undefined / x-skill: 锚点
  const capGraph = buildConstellationGraph({
    count: 6,
    buckets: [
      {
        index: 0,
        label: 'D',
        date: '',
        category: undefined,
        nodes: [
          { id: 'x-skill:keep', label: '<!-- c -->', meta: 'sec · x2', style: 'skill' },
          { id: 'skill:hub', label: 'hub', meta: 'ops', style: 'skill', body: 'uses skill:l1 skill:l2 skill:l3 skill:l4 skill:l5' },
          { id: 'skill:l1', label: 'l1', meta: 'ops', style: 'skill' },
          { id: 'skill:l2', label: 'l2', meta: 'ops', style: 'skill' },
          { id: 'skill:l3', label: 'l3', meta: 'ops', style: 'skill' },
          { id: 'skill:l4', label: 'l4', meta: 'ops', style: 'skill' },
          { id: 'skill:l5', label: 'l5', meta: 'ops', style: 'skill' },
        ],
      },
    ],
  });
  assert.equal(capGraph.nodes[0]?.category, 'sec');
  assert.equal(capGraph.nodes[0]?.skillName, 'x-skill:keep');
  assert.equal(capGraph.edges.filter((e) => e.source === 'skill:hub' || e.target === 'skill:hub').length, 4);

  // buildConstellationGraphFromSkills: missing id / missing category / string uses
  const missingSkillInputs = [
    { label: 'no-id' },
    { id: 'no-cat', uses: '10' },
  ];
  const fromMissing = buildConstellationGraphFromSkills(missingSkillInputs, 'arch');
  assert.equal(fromMissing.nodes.length, 1);
  assert.equal(fromMissing.nodes[0]?.id, 'skill:no-cat');
  assert.equal(fromMissing.nodes[0]?.category, 'skill');
  assert.equal(fromMissing.nodes[0]?.uses, 0);
});
