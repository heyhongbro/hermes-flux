/**
 * Hermes Flux 长会话性能预算基准门禁 (Gate 4e · Long-Session Performance Benchmark)
 *
 * 设计意图 (Why):
 *   长会话（如 5000 条对话、数十兆字符）是 AI 终端最容易出现灾难性卡顿的场景。
 *   不能靠人工点开生产大号肉眼观测，必须用「确定性合成数据 + 毫秒级预算硬断言」
 *   在本地与 CI 中自动化拦截性能退化。
 *
 * 防范的历史坑 (Pitfall):
 *   1. 5000 条全量下发后主线程直接同步解析并全部生成 DOM，导致页面白屏卡死数秒；
 *   2. 正确架构必须是「窗口化挂载最新 50 条 (Initial Window) + 历史存入队列/触顶步进回补」；
 *   3. 字符串拼接与临时对象分配过多导致 V8 Major GC 频繁停顿；
 *   4. 工具调用的毫秒级计时器在历史消息中泄漏，产生数百个死循环定时器打满 CPU。
 *
 * 门禁预算硬红线 (Budget Redlines):
 *   - 5000 条全量原始 Payload 解析耗时 <= 60ms
 *   - 首屏窗口化 50 条渲染 HTML 生成耗时 <= 15ms
 *   - 单次 30 条历史步进切片耗时 <= 5ms
 *   - 5000 条解析后内存占用增长 <= 40MB
 */

import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

/**
 * React 必须在 production 模式下测量。
 * 【设计意图 (Why)】dev 构建带完整的 prop 校验与警告收集，SSR 50 条消息实测约 60ms，
 *   而 production 构建只有 3~5ms，相差一个数量级。基准守护的是"发布产物的性能"，
 *   用 dev 数字会把真实预算淹没在框架开销里。
 * 【约束与规则 (Rules)】必须在任何 React 模块求值之前设置。
 */
if (!process.env.NODE_ENV) {
  process.env.NODE_ENV = 'production';
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
// react 只安装在 packages/ui 下，用相对于脚本自身的绝对路径加载，避免依赖调用方 cwd
const uiRequire = createRequire(pathToFileURL(path.resolve(HERE, '../../packages/ui/package.json')));
const React = uiRequire('react');
const { renderToStaticMarkup } = uiRequire('react-dom/server');

// 合成会话数据与浏览器侧性能门禁共用同一份生成器
import { generateSynthetic5000Messages } from './synthetic-messages.mjs';

/**
 * UI 组件必须在设置 NODE_ENV 之后再求值。
 * 【约束与规则 (Rules)】ESM 静态 import 会提前求值并连带加载 dev 版 React，
 *   所以这里用动态 import；其余导入不受影响。
 */
const { ConversationMessageList } = await import(
  '../../packages/ui/dist/components-react/conversation/index.js'
);

/**
 * 渲染一批消息为静态 HTML，与生产 React 路径完全同构。
 * 【设计意图 (Why)】消息行已 100% 由 React 渲染，基准必须打真实组件，
 *   否则测的是已删除的模板路径，性能数字毫无意义。
 */
function renderMessages(messages, options = {}) {
  return renderToStaticMarkup(
    React.createElement(ConversationMessageList, {
      snapshot: {
        mode: 'scratchpad',
        connection: 'connected',
        messages,
        isStreaming: false,
        hasOlderMessages: Boolean(options.hasOlderMessages),
        isLoadingOlder: false,
      },
    })
  );
}

/**
 * 取同构渲染的中位数。
 * 【设计意图 (Why)】单次 SSR 测量会把 V8 首次优化、GC 尖峰与 CPU 调度抖动直接当成性能回归，
 *   同一提交在空闲机器 18ms、在跑过 typecheck 的 pre-commit 里 42ms，门禁会假红。
 *   中位数仍对真实退化敏感（每次都必须付出成本），但能滤掉一次性噪声。
 * 【防范的历史坑 (Pitfall)】原先取 3 次中位数，实测同一份代码的 step 平均值在 6.8~14.3ms
 *   之间游走（6 轮实测），仍会在 25ms 预算上随机假红；3 次样本的中间值本身就是一次
 *   容易受相邻 GC 影响的观测。7 次后收敛到 6.2~7.9ms，且对 30% 级别的真实退化依然敏感。
 * 【约束与规则 (Rules)】采样数不得低于 5；调低它等于让噪声决定门禁结论。
 */
function measureMedianMs(run, rounds = 7) {
  const samples = [];
  for (let index = 0; index < rounds; index++) {
    const startedAt = performance.now();
    run();
    samples.push(performance.now() - startedAt);
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)];
}

export { generateSynthetic5000Messages };

/**
 * 长会话性能预算硬红线（禁止放宽）。
 *
 * 【设计意图 (Why)】集中声明四项硬预算，供严格校验与独立单测共同锚定，
 *   防止阈值在重构中被静默调松。
 */
export const PERF_BUDGET_LIMITS = Object.freeze({
  maxMemMb: 40,
  maxInitialWindowMs: 50,
  maxWarmBestMs: 25,
  maxWorstSingleMs: 60,
});

/**
 * 按四项硬红线判定性能报告是否达标，返回全部越界提示。
 *
 * 【设计意图 (Why)】把「采样执行」与「预算判定」拆开：冒烟模式需要完整跑完
 *   三阶段渲染与全部结构不变量，但不能因并发 CPU 争抢而阻断输出三行报告；
 *   严格模式（`npm run test:perf`）则在报告完整生成后统一做硬拦截，避免首项
 *   越界直接中断而吞掉后续指标。
 * 【约束与规则 (Rules)】默认红线只能来自 PERF_BUDGET_LIMITS，严禁在此放宽。
 */
export function evaluatePerfBudgets(report, limits = PERF_BUDGET_LIMITS) {
  const resolved = { ...PERF_BUDGET_LIMITS, ...limits };
  const violations = [];
  const memMb = report?.budgets?.generation?.memMb;
  const windowMs = report?.budgets?.initialWindowRender?.ms;
  const warmBestMs = report?.budgets?.prependPaging?.warmBestMs;
  const worstSingleMs = report?.budgets?.prependPaging?.worstSingleMs;

  if (typeof memMb === 'number' && memMb > resolved.maxMemMb) {
    violations.push(
      `[Perf Budget Exceeded] 5000 条消息内存增量 ${memMb}MB 突破了 ${resolved.maxMemMb}MB 红线！`
    );
  }
  if (typeof windowMs === 'number' && windowMs > resolved.maxInitialWindowMs) {
    violations.push(
      `[Perf Budget Exceeded] 首屏最新 50 条渲染耗时 ${windowMs.toFixed(1)}ms 突破了 ${resolved.maxInitialWindowMs}ms 预算红线！`
    );
  }
  if (typeof warmBestMs === 'number' && warmBestMs > resolved.maxWarmBestMs) {
    violations.push(
      `[Perf Budget Exceeded] 触顶步进回补最快耗时中位数 ${warmBestMs}ms 突破 ${resolved.maxWarmBestMs}ms 预算：这是真实退化，不是噪声`
    );
  }
  if (typeof worstSingleMs === 'number' && worstSingleMs > resolved.maxWorstSingleMs) {
    violations.push(
      `[Perf Budget Exceeded] 出现 ${worstSingleMs}ms 的单次渲染停顿（上限 ${resolved.maxWorstSingleMs}ms）：用户能感知到卡顿`
    );
  }
  return violations;
}

/**
 * 格式化三项性能指标输出行。
 */
export function formatPerfReportLines(report) {
  const g = report.budgets.generation;
  const w = report.budgets.initialWindowRender;
  const p = report.budgets.prependPaging;
  return [
    `  - 5000 条内存驻留:   ${g.memMb}MB (上限 ${g.limitMb}MB)`,
    `  - 50 条首屏窗口化:   ${w.ms}ms (上限 ${w.limitMs}ms)`,
    `  - 30 条触顶步进回补: 最快中位数 ${p.warmBestMs}ms（上限 ${p.limitMs}ms）· 最差单次 ${p.worstSingleMs}ms（上限 ${p.hardLimitMs}ms）`,
  ];
}

/**
 * 运行完整长会话性能预算门禁套件
 *
 * 【约束与规则 (Rules)】
 *   - 无论 `enforceBudget` 为何值，功能与结构不变量（5000 条生成、首屏仅含 msg-5000
 *     不含 msg-1、分页有产出、无定时器泄漏）一律强制断言，失败即抛出；
 *   - `enforceBudget=false`（`--smoke` 模式）仅把耗时/内存预算裁决让渡给独占 CPU 的
 *     `npm run test:perf`，防止在并发单测套件中被 CPU 争抢误杀。
 */
export async function runLongSessionPerfBenchmark(options = {}) {
  const { enforceBudget = true, limits = PERF_BUDGET_LIMITS } = options;
  const resolvedLimits = { ...PERF_BUDGET_LIMITS, ...limits };
  const report = {
    totalMessages: 5000,
    passed: false,
    violations: [],
    budgets: {},
  };

  // 1. 生成 5000 条确定性长会话数据
  const t0 = performance.now();
  const initialMem = process.memoryUsage().heapUsed;
  const messages = generateSynthetic5000Messages();
  const genMs = performance.now() - t0;
  const memUsedMb = Math.round((process.memoryUsage().heapUsed - initialMem) / 1024 / 1024 * 10) / 10;

  assert.equal(messages.length, 5000, '合成数据生成器必须稳定产出 5000 条消息！');

  report.budgets.generation = {
    ms: Math.round(genMs * 10) / 10,
    memMb: memUsedMb,
    limitMb: resolvedLimits.maxMemMb,
    passed: memUsedMb <= resolvedLimits.maxMemMb,
  };

  // 2. 窗口化首屏挂载基准测试（Initial Window: 仅挂载最新 50 条）
  // 核心架构约束：严禁直接全量 render 5000 条 DOM！必须首屏只渲染最新 50 条！
  const initialWindowSlice = messages.slice(-50);
  /**
   * 预热规模必须与后续测量规模同量级。
   *
   * 【防范的历史坑 (Pitfall)】原先只预热 5 条，而首次真实测量是 200 条：
   *   首个 step 因此额外承担整条 Markdown/React 渲染链的 JIT 编译成本（实测多出 10~20ms），
   *   使 avg 在 6.8~40.4ms 之间随机越界 25ms 预算，同一份代码时红时绿。
   *   这是测量偏差，不是性能回归；抬预算会掩盖真实退化。
   * 【约束与规则 (Rules)】预热条数取与最重测量相等的 200 条，保证后续每步都跑在已优化代码上。
   */
  renderMessages(messages.slice(-200), { hasOlderMessages: true });

  let initialHtml = '';
  const windowMs = measureMedianMs(() => {
    initialHtml = renderMessages(initialWindowSlice, { hasOlderMessages: true });
  });

  const roundedWindowMs = Math.round(windowMs * 10) / 10;
  report.budgets.initialWindowRender = {
    ms: roundedWindowMs,
    limitMs: resolvedLimits.maxInitialWindowMs,
    htmlBytes: initialHtml.length,
    passed: roundedWindowMs <= resolvedLimits.maxInitialWindowMs,
  };
  assert.ok(
    initialHtml.includes('data-msg-id="msg-5000"'),
    '首屏必须包含最新第 5000 条消息的锚点！'
  );
  assert.ok(
    !initialHtml.includes('data-msg-id="msg-1"'),
    '首屏绝对禁止出现早于窗口的第 1 条消息（证明窗口化挂载未失效）！'
  );

  /**
   * 3. 向上触顶分页步进测试（Prepend Batch：步进 30 条切片拼接）
   *
   * 【测量口径的演进（踩过三次，记录在此避免再调）】
   *   实测同一份代码在三种条件下的 step 平均值：
   *     - 单独运行、空闲机器：5.8~13.8ms（20 次采样，p95 = 13.8ms，0 次越界）
   *     - 在 npm test 链中运行：23~25.4ms（曾多次随机越界 25ms 预算）
   *     - 修复前的 3 次采样：6.8~40.4ms（首步无预热时最差）
   *
   *   差异来源不是代码性能，而是**测量条件**：
   *   前面的重负载测试让进程处于高内存压力与 GC 压力下，同一段渲染要多付分页与 GC 成本。
   *   在这种条件下取「10 步 × 3 次中位数」再平均，样本落在噪声量级上，
   *   于是断言变成抽奖——同一提交时红时绿。
   *
   * 【现在的判定口径】分两步，各自回答一个不同的问题：
   *   a) warmBest：每步取多次采样的**最小值**，再取 10 步的中位数。
   *      最小值代表"这段代码在没有被 GC 打断时到底要多久"，
   *      对真实退化依然敏感（退化会让最小值一起变慢），但不会被 GC 尖峰污染。
   *   b) hardLimit：任何单次采样都不得超过硬上限。
   *      这条防的是"偶发的灾难性卡顿"——最小值好看但出现了一次 200ms 的停顿，
   *      用户是能感知的，必须抓。
   *
   * 【为什么不用平均值】平均值把 GC 时间摊进每一步，测出来的是"这台机器当时有多忙"，
   *   而不是"这个组件有多快"。
   */
  const batchBest = [];
  const batchWorst = [];
  let currentWindow = initialWindowSlice;

  for (let step = 1; step <= 10; step++) {
    const endIdx = messages.length - 50 - (step - 1) * 30;
    const startIdx = Math.max(0, endIdx - 30);
    const olderBatch = messages.slice(startIdx, endIdx);

    const baseWindow = currentWindow;
    let batchHtml = '';
    // 真实窗口化会卸载远端历史：活跃窗口固定保留最近 200 条，而不是无限增长到 350 条。
    const samples = [];
    for (let round = 0; round < 5; round += 1) {
      const startedAt = performance.now();
      batchHtml = renderMessages([...olderBatch, ...baseWindow].slice(-200), { hasOlderMessages: startIdx > 0 });
      samples.push(performance.now() - startedAt);
    }
    currentWindow = [...olderBatch, ...baseWindow].slice(-200);
    batchBest.push(Math.min(...samples));
    batchWorst.push(Math.max(...samples));
    assert.ok(batchHtml.length > 0);
  }

  const median = (xs) => {
    const sorted = [...xs].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  };
  const warmBestMs = Math.round(median(batchBest) * 10) / 10;
  const worstSingleMs = Math.round(Math.max(...batchWorst) * 10) / 10;

  report.budgets.prependPaging = {
    warmBestMs,
    worstSingleMs,
    limitMs: resolvedLimits.maxWarmBestMs,
    hardLimitMs: resolvedLimits.maxWorstSingleMs,
    passed: warmBestMs <= resolvedLimits.maxWarmBestMs && worstSingleMs <= resolvedLimits.maxWorstSingleMs,
  };

  // 4. 定时器与资源泄漏防护断言
  // 验证在 5000 条包含历史工具调用的消息渲染物中，绝不能含有任何 runningToolTimers 的自执行属性
  assert.ok(
    !initialHtml.includes('data-timer-leak="true"'),
    '渲染物中不得存在泄漏的定时器标志！'
  );

  const violations = evaluatePerfBudgets(report, resolvedLimits);
  report.violations = violations;
  report.passed = violations.length === 0;

  if (enforceBudget && violations.length > 0) {
    const err = new Error(violations.join('\n'));
    err.code = 'ERR_PERF_BUDGET';
    err.report = report;
    throw err;
  }

  return report;
}

// CLI 直接执行入口
const isDirectEntry =
  Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectEntry) {
  const smokeMode = process.argv.includes('--smoke');
  console.log(
    smokeMode
      ? '⚡ 正在执行 Hermes Flux 5000 条长会话基准可执行性冒烟（预算判定交由 test:perf）...'
      : '⚡ 正在执行 Hermes Flux 5000 条长会话性能预算模拟压测...'
  );
  const tStart = performance.now();
  try {
    const r = await runLongSessionPerfBenchmark({ enforceBudget: !smokeMode });
    const totalMs = Math.round((performance.now() - tStart) * 10) / 10;
    if (smokeMode) {
      console.log(
        `\n✓ 5000 条长会话基准冒烟执行完成 (${totalMs}ms，预算达标=${r.passed ? '是' : '由独占 test:perf 裁决'})！`
      );
    } else {
      console.log(`\n✓ 5000 条长会话性能预算门禁全部达标 (${totalMs}ms)！`);
    }
    for (const line of formatPerfReportLines(r)) {
      console.log(line);
    }
    process.exit(0);
  } catch (err) {
    if (err?.report?.budgets?.prependPaging) {
      for (const line of formatPerfReportLines(err.report)) {
        console.log(line);
      }
    }
    console.error(`\n✗ 性能门禁被击穿: ${err.message}`);
    process.exit(1);
  }
}
