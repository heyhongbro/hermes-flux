import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import { buildConstellationGraph, layoutConstellationWindow } from '../../dist/index.js';

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
    { numRuns: 80 },
  );
});
