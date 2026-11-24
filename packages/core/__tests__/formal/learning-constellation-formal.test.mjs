import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import {
  buildConstellationGraph,
  buildConstellationGraphFromRest,
  extractConstellationSkillList,
  layoutConstellationWindow,
  layoutFullConstellationGraph,
} from '../../dist/index.js';

test('INV-LEARN-01: 学习星图构建恒去重、无 HTML 注释残留，且布局坐标严格落在 [0,100]', () => {
  fc.assert(
    fc.property(
      fc.array(
        fc.record({
          id: fc.stringMatching(/^(memory:profile:[0-9]{1,3}|skill-[a-z0-9]{1,8})$/),
          label: fc.oneof(
            fc.constant('<!-- observed: 2026-10-…'),
            fc.stringMatching(/^[a-zA-Z0-9 _-]{1,28}$/),
          ),
          body: fc.string({ maxLength: 40 }),
          style: fc.constantFrom('memory', 'skill'),
          meta: fc.constantFrom('profile · 27 Oct 2026', 'skills · 21 Nov 2026 · x7'),
        }),
        { maxLength: 20 },
      ),
      fc.integer({ min: 1, max: 6 }),
      (nodes, maxRingNodes) => {
        const graph = buildConstellationGraph({
          frames: [],
          legend: [],
          categories: [],
          summary: [],
          axis: { start: '', end: '' },
          count: nodes.length,
          cols: 40,
          rows: 16,
          buckets: [
            {
              index: 0,
              label: '27 Oct',
              date: '27 Oct 2026',
              skills: 0,
              memories: 0,
              total: nodes.length,
              category: 'general',
              color: null,
              nodes: nodes.map((n) => ({
                id: n.id,
                glyph: n.style === 'skill' ? '●' : '◆',
                label: n.label,
                fullLabel: `${n.label} ${n.body}`,
                meta: n.meta,
                body: n.body,
                style: n.style,
              })),
            },
          ],
        });

        const ids = graph.nodes.map((n) => n.id);
        assert.equal(new Set(ids).size, ids.length, '星图节点 id 必须去重');
        for (const n of graph.nodes) {
          assert.equal(n.label.includes('<!--'), false, '清洗后标签不得包含 HTML 注释起始符');
        }

        const layout = layoutConstellationWindow(graph, { maxRingNodes });
        assert.ok(layout.positionedNodes.length <= maxRingNodes + 1);
        for (const p of layout.positionedNodes) {
          assert.ok(p.x >= 0 && p.x <= 100, `x out of bounds: ${p.x}`);
          assert.ok(p.y >= 0 && p.y <= 100, `y out of bounds: ${p.y}`);
        }
      },
    ),
    { numRuns: 1000 },
  );
});

test('INV-LEARN-02: 全量无分页星图绝对不重叠、确定性有界，且跨 Bot REST 隔离与技能清单一致', () => {
  fc.assert(
    fc.property(
      fc.stringMatching(/^[a-z][a-z0-9-]{1,10}$/),
      fc.uniqueArray(
        fc.record({
          id: fc.stringMatching(/^(skill:[a-z0-9-]{2,8}|memory:[a-z0-9-]{2,8})$/),
          label: fc.stringMatching(/^[a-zA-Z0-9 _-]{2,18}$/),
          category: fc.constantFrom('ops', 'frontend', 'testing', 'general'),
          uses: fc.integer({ min: 0, max: 120 }),
        }),
        { selector: (item) => item.id, maxLength: 35 },
      ),
      fc.array(
        fc.record({
          srcIdx: fc.nat(34),
          dstIdx: fc.nat(34),
          kind: fc.constantFrom('skill_link', 'mention', 'same_bucket', 'same_category'),
        }),
        { maxLength: 60 },
      ),
      fc.constantFrom('all', 'skill', 'memory'),
      (profile, rawNodes, rawEdgeSpecs, filter) => {
        const edges = [];
        if (rawNodes.length > 0) {
          for (const spec of rawEdgeSpecs) {
            edges.push({
              source: rawNodes[spec.srcIdx % rawNodes.length].id,
              target: rawNodes[spec.dstIdx % rawNodes.length].id,
              kind: spec.kind,
            });
          }
        }

        const graph = buildConstellationGraphFromRest(
          {
            nodes: rawNodes.map((n) => ({
              id: n.id,
              kind: n.id.startsWith('skill:') ? 'skill' : 'memory',
              label: n.label,
              category: n.category,
              uses: n.uses,
            })),
            edges,
          },
          profile,
        );

        assert.equal(graph.profile, profile, '图谱必须严格保持传入 profile 归属');

        const layout1 = layoutFullConstellationGraph(graph, { filter });
        const layout2 = layoutFullConstellationGraph(graph, { filter });
        assert.deepEqual(layout1, layout2, '全量布局必须完全确定性一致');

        const expectedNodes =
          filter === 'all' ? graph.nodes : graph.nodes.filter((n) => n.kind === filter);
        assert.equal(layout1.nodes.length, expectedNodes.length, '全量星图不得分页丢弃节点');

        const placedIds = new Set(layout1.nodes.map((n) => n.id));
        for (const edge of layout1.edges) {
          assert.notEqual(edge.source, edge.target);
          assert.ok(placedIds.has(edge.source) && placedIds.has(edge.target), '边端点必须均存在于画布');
        }

        for (let i = 0; i < layout1.nodes.length; i++) {
          const a = layout1.nodes[i];
          assert.ok(Number.isFinite(a.x) && a.x >= 0 && a.x <= layout1.width, `x 越界: ${a.x}`);
          assert.ok(Number.isFinite(a.y) && a.y >= 0 && a.y <= layout1.height, `y 越界: ${a.y}`);
          for (let j = i + 1; j < layout1.nodes.length; j++) {
            const b = layout1.nodes[j];
            const dist = Math.hypot(a.x - b.x, a.y - b.y);
            assert.ok(
              dist >= a.radius + b.radius + 36 - 0.1,
              `节点最小硬碰撞间隙违背: ${a.id} vs ${b.id} dist=${dist}`,
            );
          }
        }

        const skillList = extractConstellationSkillList(graph);
        assert.equal(skillList.length, graph.totalSkills, '技能清单数必须精确匹配 totalSkills');
        for (let i = 1; i < skillList.length; i++) {
          assert.ok(skillList[i - 1].uses >= skillList[i].uses, '技能清单须按 uses 非递增排序');
        }
      },
    ),
    { numRuns: 1000 },
  );
});
