import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  PERF_BUDGET_LIMITS,
  evaluatePerfBudgets,
  formatPerfReportLines,
  runLongSessionPerfBenchmark,
} from '../gates/perf-benchmark.mjs';

/**
 * Gate 4e 长会话基准模式分流与预算守护测试。
 *
 * 【设计意图 (Why)】
 *   并发跑 `npm test` 时只应执行 `--smoke`（验证三阶段渲染与结构不变量可执行），
 *   而独占 CPU 的 `npm run test:perf` 必须坚持四项硬预算红线不被放宽。
 *   本测试用受控零预算与跨目录子进程实测，确保两条路径各自有效、互不退化。
 *
 * 【约束与规则 (Rules)】
 *   1. 禁止放宽 `PERF_BUDGET_LIMITS` 中的四项硬阈值（40MB / 50ms / 25ms / 60ms）；
 *   2. 子进程调用必须剥离 `NODE_TEST_CONTEXT`；
 *   3. 必须在 `npm run build` 生成 `packages/ui/dist` 后执行。
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../..');
const PERF_SCRIPT = path.join(REPO_ROOT, 'scripts/gates/perf-benchmark.mjs');
const STANDALONE_SCRIPT = path.join(REPO_ROOT, 'scripts/gates/perf-standalone.mjs');

function makePassingReport() {
  return {
    totalMessages: 5000,
    passed: true,
    budgets: {
      generation: { ms: 20, memMb: 2.2, limitMb: 40, passed: true },
      initialWindowRender: { ms: 5.8, limitMs: 50, htmlBytes: 1024, passed: true },
      prependPaging: { warmBestMs: 7.8, worstSingleMs: 21.9, limitMs: 25, hardLimitMs: 60, passed: true },
    },
  };
}

test('PERF_BUDGET_LIMITS 必须严格锚定四项硬预算，不得静默调松', () => {
  assert.deepEqual(PERF_BUDGET_LIMITS, {
    maxMemMb: 40,
    maxInitialWindowMs: 50,
    maxWarmBestMs: 25,
    maxWorstSingleMs: 60,
  });
});

test('evaluatePerfBudgets：全部达标返回空，任一项越界必报精确违规', () => {
  assert.deepEqual(evaluatePerfBudgets(makePassingReport()), []);

  const memBreach = makePassingReport();
  memBreach.budgets.generation.memMb = 40.1;
  const memViolations = evaluatePerfBudgets(memBreach);
  assert.equal(memViolations.length, 1);
  assert.match(memViolations[0], /内存增量 40\.1MB 突破了 40MB/);

  const winBreach = makePassingReport();
  winBreach.budgets.initialWindowRender.ms = 50.1;
  const winViolations = evaluatePerfBudgets(winBreach);
  assert.equal(winViolations.length, 1);
  assert.match(winViolations[0], /首屏最新 50 条渲染耗时 50\.1ms 突破了 50ms/);

  const warmBreach = makePassingReport();
  warmBreach.budgets.prependPaging.warmBestMs = 25.1;
  const warmViolations = evaluatePerfBudgets(warmBreach);
  assert.equal(warmViolations.length, 1);
  assert.match(warmViolations[0], /触顶步进回补最快耗时中位数 25\.1ms 突破 25ms/);

  const worstBreach = makePassingReport();
  worstBreach.budgets.prependPaging.worstSingleMs = 60.1;
  const worstViolations = evaluatePerfBudgets(worstBreach);
  assert.equal(worstViolations.length, 1);
  assert.match(worstViolations[0], /出现 60\.1ms 的单次渲染停顿（上限 60ms）/);
});

test('严格模式（enforceBudget: true）预算越界必须拒绝并附带完整三段报告', async () => {
  let caught = null;
  try {
    await runLongSessionPerfBenchmark({
      enforceBudget: true,
      limits: { maxMemMb: 0, maxInitialWindowMs: 0, maxWarmBestMs: 0, maxWorstSingleMs: 0 },
    });
  } catch (err) {
    caught = err;
  }

  assert.ok(caught, '零预算下严格模式必须抛出预算越界错误');
  assert.equal(caught.code, 'ERR_PERF_BUDGET');
  assert.match(caught.message, /\[Perf Budget Exceeded\]/);
  assert.ok(caught.report?.budgets?.generation, '失败异常必须附带内存驻留段落');
  assert.ok(caught.report?.budgets?.initialWindowRender, '失败异常必须附带首屏窗口段落');
  assert.ok(caught.report?.budgets?.prependPaging, '失败异常必须附带触顶步进段落');

  const lines = formatPerfReportLines(caught.report).join('\n');
  assert.match(lines, /5000 条内存驻留/);
  assert.match(lines, /50 条首屏窗口化/);
  assert.match(lines, /30 条触顶步进回补/);
});

test('冒烟模式（enforceBudget: false）零预算下仍完整执行并放行，且记录 violations', async () => {
  const report = await runLongSessionPerfBenchmark({
    enforceBudget: false,
    limits: { maxMemMb: 0, maxInitialWindowMs: 0, maxWarmBestMs: 0, maxWorstSingleMs: 0 },
  });

  assert.equal(report.totalMessages, 5000);
  assert.equal(report.passed, false);
  assert.ok(report.violations.length >= 3, `应记录越界明细，实际: ${report.violations.length}`);
  assert.ok(report.budgets.generation);
  assert.ok(report.budgets.initialWindowRender);
  assert.ok(report.budgets.prependPaging);
});

test('CLI --smoke 在非仓库目录也能独立执行并输出三行完整报告', () => {
  const env = { ...process.env, NODE_ENV: 'production', FORCE_COLOR: '0' };
  delete env.NODE_TEST_CONTEXT;

  const run = spawnSync(process.execPath, [PERF_SCRIPT, '--smoke'], {
    cwd: os.tmpdir(),
    env,
    encoding: 'utf8',
    timeout: 300000,
  });

  const out = `${run.stdout ?? ''}\n${run.stderr ?? ''}`;
  assert.equal(run.status, 0, `--smoke 退出码必须为 0，实际 ${run.status}\n${out}`);
  assert.ok(out.includes('5000 条内存驻留'), `输出必须包含内存驻留项\n${out}`);
  assert.ok(out.includes('50 条首屏窗口化'), `输出必须包含首屏窗口项\n${out}`);
  assert.ok(out.includes('30 条触顶步进回补'), `输出必须包含触顶步进项\n${out}`);
});

test('perf-standalone 严禁传入 --smoke，确保 test:perf 始终执行硬预算拦截', () => {
  const src = fs.readFileSync(STANDALONE_SCRIPT, 'utf8');
  assert.ok(!src.includes('--smoke'), 'perf-standalone.mjs 不得传入 --smoke');
});
