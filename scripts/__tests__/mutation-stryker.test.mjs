/**
 * Stryker 领域执行器 (`mutation-stryker.mjs`) 参数解析、预检与哨兵单测
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_IGNORE_PATTERNS,
  buildStrykerConfig,
  evaluateMutationReport,
  parseCliArgs,
  publishMutationReport,
  resolveDefaultConcurrency,
  validateDomainFiles,
} from '../gates/mutation-stryker.mjs';
import {
  parseChangedCliArgs,
  parseMutateSpec,
  parseUnifiedDiffHunks,
  selectAffectedDomains,
} from '../gates/mutation-stryker-changed.mjs';

test('parseCliArgs: 支持 --domain 后置 --concurrency 且默认按 CPU 核心数自适应并发', () => {
  assert.equal(resolveDefaultConcurrency(1), 2);
  assert.equal(resolveDefaultConcurrency(2), 2);
  assert.equal(resolveDefaultConcurrency(4), 3);
  assert.equal(resolveDefaultConcurrency(8), 6);
  assert.equal(resolveDefaultConcurrency(16), 6);

  const expectedDefault = resolveDefaultConcurrency(os.availableParallelism());
  const def = parseCliArgs([]);
  assert.deepEqual(def, { ok: true, action: 'run', domain: 'cache', concurrency: expectedDefault });

  const ordered = parseCliArgs(['--domain=coalesce', '--concurrency=4']);
  assert.deepEqual(ordered, { ok: true, action: 'run', domain: 'coalesce', concurrency: 4 });

  const reversed = parseCliArgs(['--concurrency=3', '--domain=cache']);
  assert.deepEqual(reversed, { ok: true, action: 'run', domain: 'cache', concurrency: 3 });

  const list = parseCliArgs(['--list']);
  assert.deepEqual(list, { ok: true, action: 'list' });
});

test('parseCliArgs: 拒绝非法并发、空域名、重复参数、未知标志及原型链属性', () => {
  for (const bad of [
    ['--concurrency=0'],
    ['--concurrency=-1'],
    ['--concurrency=2abc'],
    ['--concurrency=2.5'],
    ['--concurrency='],
    ['--domain='],
    ['--domain=cache', '--domain=coalesce'],
    ['--concurrency=2', '--concurrency=4'],
    ['--unknown-flag'],
    ['positional-arg'],
    ['--list', '--domain=cache'],
    ['--domain=toString'],
    ['--domain=constructor'],
    ['--domain=nonexistentDomain'],
  ]) {
    const res = parseCliArgs(bad);
    assert.equal(res.ok, false, `必须拒绝参数: ${JSON.stringify(bad)}`);
  }
});

test('validateDomainFiles: 正确剥离行/列后缀并拦截缺失文件', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-stryker-val-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const srcFile = path.join(tmpDir, 'packages/core/src/a.ts');
  const testFile = path.join(tmpDir, 'packages/core/__tests__/a.test.mjs');
  fs.mkdirSync(path.dirname(srcFile), { recursive: true });
  fs.mkdirSync(path.dirname(testFile), { recursive: true });
  fs.writeFileSync(srcFile, 'export const a = 1;\n', 'utf8');
  fs.writeFileSync(testFile, 'import "node:test";\n', 'utf8');

  const ok = validateDomainFiles(
    {
      mutate: [
        'packages/core/src/a.ts:10-20',
        'packages/core/src/a.ts:5:4-6:4',
        '!packages/core/src/ignored.ts',
        'packages/core/src/*.ts',
      ],
      testFiles: ['packages/core/__tests__/a.test.mjs'],
    },
    tmpDir,
  );
  assert.equal(ok.ok, true);
  assert.equal(ok.missing.length, 0);

  const bad = validateDomainFiles(
    {
      mutate: ['packages/core/src/missing.ts:1-10'],
      testFiles: ['packages/core/__tests__/missing.test.mjs'],
    },
    tmpDir,
  );
  assert.equal(bad.ok, false);
  assert.equal(bad.missing.length, 2);
  assert.deepEqual(
    bad.missing.map((m) => m.kind),
    ['mutate', 'testFile'],
  );
});

test('buildStrykerConfig: 隔离报告路径、保持 .stryker-tmp 与安全忽略白名单', () => {
  const cfg = buildStrykerConfig(
    'turnExecutionWatchdog',
    {
      mutate: ['packages/desktop/src/renderer/services/turnExecutionService.ts:232-486'],
      testFiles: ['packages/desktop/__tests__/unit/turnExecutionService.watchdog.test.mjs'],
      buildCommand: 'node scripts/gates/build-desktop-unit.mjs src/renderer/services/turnExecutionService.ts',
      ignorePatterns: ['!packages/ui/src/icons/brand/brandSpec.ts'],
    },
    { concurrency: 4, reportRelPath: 'reports/mutation/turnExecutionWatchdog.json' },
  );

  assert.equal(cfg.tempDirName, '.stryker-tmp');
  assert.equal(cfg.concurrency, 4);
  assert.equal(cfg.jsonReporter.fileName, 'reports/mutation/turnExecutionWatchdog.json');
  assert.deepEqual(cfg.plugins, ['@stryker-mutator/tap-runner']);
  assert.ok(!DEFAULT_IGNORE_PATTERNS.includes('**/dist/**'));
  assert.ok(!DEFAULT_IGNORE_PATTERNS.includes('packages/ui/src/icons/**'));
  assert.ok(cfg.ignorePatterns.includes('!packages/ui/src/icons/brand/brandSpec.ts'));
});

test('evaluateMutationReport: 对齐官方 8 态公式且堵住 Ignored 绕过与 RuntimeError', () => {
  const domainCfg = { minScore: 80 };

  // 1 个 Ignored + 9 个 NoCoverage -> 有效变异体 100% NoCoverage，必须被哨兵 2 拦下
  const allNoCovWithIgnored = evaluateMutationReport(
    {
      files: {
        'a.ts': {
          mutants: [
            { id: '1', status: 'Ignored' },
            { id: '2', status: 'NoCoverage', location: { start: { line: 10 } } },
            { id: '3', status: 'NoCoverage', location: { start: { line: 12 } } },
          ],
        },
      },
    },
    domainCfg,
  );
  assert.equal(allNoCovWithIgnored.ok, false);
  assert.equal(allNoCovWithIgnored.counts.totalValid, 2);
  assert.equal(allNoCovWithIgnored.counts.ignored, 1);
  assert.ok(allNoCovWithIgnored.failures.some((f) => f.includes('NoCoverage')));

  // CompileError / Ignored 不污染分母：8 Killed + 2 Survived + 5 CompileError + 2 Ignored = 80.00%
  const validPass = evaluateMutationReport(
    {
      files: {
        'a.ts': {
          mutants: [
            ...Array.from({ length: 8 }, (_, i) => ({ id: `k${i}`, status: 'Killed' })),
            ...Array.from({ length: 2 }, (_, i) => ({ id: `s${i}`, status: 'Survived' })),
            ...Array.from({ length: 5 }, (_, i) => ({ id: `c${i}`, status: 'CompileError' })),
            ...Array.from({ length: 2 }, (_, i) => ({ id: `i${i}`, status: 'Ignored' })),
          ],
        },
      },
    },
    domainCfg,
  );
  assert.equal(validPass.ok, true);
  assert.equal(validPass.counts.totalValid, 10);
  assert.equal(validPass.scores.mutationScore, 80);

  // RuntimeError 或 Pending 必须阻断
  const withRuntimeErr = evaluateMutationReport(
    {
      files: {
        'a.ts': {
          mutants: [
            { id: 'k1', status: 'Killed' },
            { id: 'r1', status: 'RuntimeError', location: { start: { line: 5 } }, statusReason: 'crash' },
          ],
        },
      },
    },
    { minScore: 50 },
  );
  assert.equal(withRuntimeErr.ok, false);
  assert.ok(withRuntimeErr.failures.some((f) => f.includes('RuntimeError=1')));
});

test('evaluateMutationReport: 区分 hitLimit 与 wallClockTimeout，拦截高并发假绿通胀', () => {
  // hitLimitTimeout（合法无限循环终止）不误杀
  const hitLimitPass = evaluateMutationReport(
    {
      files: {
        'a.ts': {
          mutants: [
            ...Array.from({ length: 7 }, (_, i) => ({ id: `k${i}`, status: 'Killed' })),
            { id: 'h1', status: 'Timeout', statusReason: 'Hit limit reached (101/100)' },
            { id: 's1', status: 'Survived' },
            { id: 's2', status: 'Survived' },
          ],
        },
      },
    },
    { minScore: 80 },
  );
  assert.equal(hitLimitPass.ok, true);
  assert.equal(hitLimitPass.counts.hitLimitTimeout, 1);
  assert.equal(hitLimitPass.counts.wallClockTimeout, 0);

  // wallClockTimeout 把原本 70% (< 80%) 拉高到 80% -> 必须被哨兵 4 Tier 2 拦截
  const inflated = evaluateMutationReport(
    {
      files: {
        'a.ts': {
          mutants: [
            ...Array.from({ length: 7 }, (_, i) => ({ id: `k${i}`, status: 'Killed' })),
            { id: 'w1', status: 'Timeout', location: { start: { line: 22 } } },
            { id: 's1', status: 'Survived' },
            { id: 's2', status: 'Survived' },
          ],
        },
      },
    },
    { minScore: 80 },
  );
  assert.equal(inflated.ok, false);
  assert.equal(inflated.counts.wallClockTimeout, 1);
  assert.equal(inflated.scores.scoreExcludingWallClock, 70);
  assert.ok(inflated.failures.some((f) => f.includes('通胀假绿')));

  // 若领域显式登记 maxWallClockTimeout 且有合法异步超时，则允许放行（但仍受 Tier 1 25% 上限保护）
  const allowedAsync = evaluateMutationReport(
    {
      files: {
        'a.ts': {
          mutants: [
            ...Array.from({ length: 7 }, (_, i) => ({ id: `k${i}`, status: 'Killed' })),
            { id: 'w1', status: 'Timeout', location: { start: { line: 22 } } },
            { id: 's1', status: 'Survived' },
            { id: 's2', status: 'Survived' },
          ],
        },
      },
    },
    { minScore: 80, maxWallClockTimeout: 1 },
  );
  assert.equal(allowedAsync.ok, true);

  // Tier 1 绝对阈值：零有效杀死仅靠墙钟超时，即使放开 maxWallClockTimeout 也必须拦截
  const zeroKilled = evaluateMutationReport(
    {
      files: {
        'a.ts': {
          mutants: [{ id: 'w1', status: 'Timeout' }],
        },
      },
    },
    { minScore: 80, maxWallClockTimeout: 5 },
  );
  assert.equal(zeroKilled.ok, false);
  assert.ok(zeroKilled.failures.some((f) => f.includes('墙钟超时异常飙升')));
});

test('publishMutationReport: 原子覆盖发布正式报告且清理临时文件，缺失源文件时显式抛错', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-stryker-pub-'));
  try {
    const tempReport = path.join(tmpDir, '.tmp-cache-1.json');
    const finalReport = path.join(tmpDir, 'nested', 'cache.json');
    fs.mkdirSync(path.dirname(finalReport), { recursive: true });
    fs.writeFileSync(finalReport, '{"stale":true}', 'utf8');
    fs.writeFileSync(tempReport, '{"fresh":true}', 'utf8');

    publishMutationReport(tempReport, finalReport);
    assert.equal(fs.existsSync(tempReport), false);
    assert.equal(fs.readFileSync(finalReport, 'utf8'), '{"fresh":true}');

    assert.throws(() => publishMutationReport(path.join(tmpDir, 'missing.json'), finalReport));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('parseMutateSpec 与 parseUnifiedDiffHunks: 精准解析行号区间与纯删除 hunk', () => {
  assert.equal(parseMutateSpec('!packages/core/src/a.ts'), null);
  assert.equal(parseMutateSpec('packages/core/src/*.ts'), null);
  assert.deepEqual(parseMutateSpec('packages/core/src/a.ts'), {
    file: 'packages/core/src/a.ts',
    startLine: null,
    endLine: null,
  });
  assert.deepEqual(parseMutateSpec('packages/desktop/src/svc.ts:232-486'), {
    file: 'packages/desktop/src/svc.ts',
    startLine: 232,
    endLine: 486,
  });
  assert.deepEqual(parseMutateSpec('packages/core/src/b.ts:10:2-20:8'), {
    file: 'packages/core/src/b.ts',
    startLine: 10,
    endLine: 20,
  });

  const diff = [
    'diff --git a/packages/desktop/src/svc.ts b/packages/desktop/src/svc.ts',
    '+++ b/packages/desktop/src/svc.ts',
    '@@ -240,0 +245,3 @@ fn',
    '@@ -800,2 +800,0 @@ del',
    'diff --git a/deleted.ts b/deleted.ts',
    '+++ /dev/null',
    '@@ -1,5 +0,0 @@ gone',
    'diff --git a/docs/readme.md b/docs/readme.md',
    '+++ b/docs/readme.md',
    '@@ -1 +1 @@',
  ].join('\n');
  const hunks = parseUnifiedDiffHunks(diff);
  assert.deepEqual(hunks.get('packages/desktop/src/svc.ts'), [
    [245, 247],
    [800, 801],
  ]);
  assert.equal(hunks.has('deleted.ts'), false);
  assert.deepEqual(hunks.get('docs/readme.md'), [[1, 1]]);
});

test('selectAffectedDomains: 按行号与测试文件精确命中，隔离无关域并显式上报未映射源码', () => {
  const miniDomains = {
    domFull: {
      title: 'Full File Domain',
      mutate: ['packages/core/src/cache/cacheMerge.ts'],
      testFiles: ['packages/core/__tests__/cache/cache-merge.test.mjs'],
    },
    domWatchdog: {
      title: 'Watchdog Slice',
      mutate: ['packages/desktop/src/renderer/services/turnExecutionService.ts:232-486'],
      testFiles: ['packages/desktop/__tests__/unit/turnExecutionService.watchdog.test.mjs'],
    },
    domSubmit: {
      title: 'Submit Slice',
      mutate: ['packages/desktop/src/renderer/services/turnExecutionService.ts:942-1016'],
      testFiles: ['packages/desktop/__tests__/unit/turnExecutionService.submit.test.mjs'],
    },
  };

  // 1. 同文件只改 L300 -> 仅命中 domWatchdog，绝不拉起 domSubmit
  const sliceHit = selectAffectedDomains(
    {
      changedFiles: ['packages/desktop/src/renderer/services/turnExecutionService.ts'],
      changedRangesByFile: new Map([['packages/desktop/src/renderer/services/turnExecutionService.ts', [[300, 305]]]]),
    },
    miniDomains,
  );
  assert.deepEqual(sliceHit.selectedDomains, ['domWatchdog']);
  assert.deepEqual(sliceHit.unmappedSourceFiles, []);

  // 2. 只改域测试文件 + 未映射源码 -> 命中对应域且 unmappedSourceFiles 可见
  const testAndUnmapped = selectAffectedDomains(
    {
      changedFiles: [
        'packages/core/__tests__/cache/cache-merge.test.mjs',
        'packages/ui/src/newWidget.tsx',
        'packages/core/src/types.d.ts',
      ],
      changedRangesByFile: new Map(),
    },
    miniDomains,
  );
  assert.deepEqual(testAndUnmapped.selectedDomains, ['domFull']);
  assert.deepEqual(testAndUnmapped.unmappedSourceFiles, ['packages/ui/src/newWidget.tsx']);

  // 3. 纯文档/门禁测试改动 -> 0 命中且 0 未映射源码
  const docsOnly = selectAffectedDomains(
    { changedFiles: ['docs/testing-strategy.md', 'scripts/__tests__/verify-ci-workflow.test.mjs'] },
    miniDomains,
  );
  assert.deepEqual(docsOnly.selectedDomains, []);
  assert.deepEqual(docsOnly.unmappedSourceFiles, []);
});

test('parseChangedCliArgs: 校验标志、PR_BASE_REF 与 MANUAL_MUTATION_DOMAIN', () => {
  const ciAuto = parseChangedCliArgs(
    ['--ci'],
    { PR_BASE_REF: 'main', MANUAL_MUTATION_DOMAIN: '' },
    { cache: {} },
  );
  assert.deepEqual(ciAuto, {
    ok: true,
    base: 'origin/main',
    concurrency: null,
    dryRun: false,
    ci: true,
    manualDomain: null,
  });

  const ciManual = parseChangedCliArgs(
    ['--ci', '--concurrency=4'],
    { PR_BASE_REF: 'dev/v0.1', MANUAL_MUTATION_DOMAIN: 'cache' },
    { cache: {} },
  );
  assert.equal(ciManual.ok, true);
  assert.equal(ciManual.manualDomain, 'cache');
  assert.equal(ciManual.concurrency, 4);

  for (const [args, env] of [
    [['--ci'], { MANUAL_MUTATION_DOMAIN: 'toString' }],
    [['--concurrency=0'], {}],
    [['--base='], {}],
    [['--unknown'], {}],
  ]) {
    assert.equal(parseChangedCliArgs(args, env, { cache: {} }).ok, false);
  }
});
