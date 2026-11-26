#!/usr/bin/env node
/**
 * 基于 Stryker 的领域化变异测试执行器（Domain-Driven Mutation Runner）
 *
 * 【设计意图 (Why)】
 *   全量 15,000+ 变异体需跑数十分钟，无法放入常规流程。
 *   本脚本按领域（Domain）调度变异测试，支持：
 *     1. 默认或单领域运行：npm run mutation:stryker -- --domain=cache [--concurrency=2]
 *     2. 查看存量领域清单：npm run mutation:stryker -- --list
 *     3. 沙盒资产精准瘦身 + 临时配置/报告/保活文件全隔离，支持安全多域并行调度。
 *
 * 【防范的历史坑 (Pitfall)】
 *   1. 假 0 分假绿：按官方 mutation-testing-metrics 口径统计 8 类状态并设 5 道硬哨兵，
 *      防止 Ignored/RuntimeError 绕过 NoCoverage 哨兵或高并发墙钟超时通胀假绿。
 *   2. 多进程 TOCTOU 竞态：Stryker 的 TemporaryDirectory.dispose() 在 `.stryker-tmp` 为空时
 *      会 rmdir 父目录；保持 tempDirName='.stryker-tmp' 并写入进程级 `.hold-*` 保活文件，
 *      杜绝跨进程 `mkdir -> rmdir -> mkdtemp` 竞态及 `findNodeModulesList` 越界扫描。
 *   3. 配置/报告污染：动态配置写入 `os.tmpdir()` 并 `finally` 清理，JSON 报告按域落盘至
 *      `reports/mutation/<domain>.json`，严禁在仓库根写入 `.stryker*.tmp.json`。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MUTATION_DOMAINS } from './lib/mutation-domains.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '../..');

const C = {
  reset: '\u001b[0m',
  bold: '\u001b[1m',
  dim: '\u001b[2m',
  red: '\u001b[31m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  cyan: '\u001b[36m',
};

/**
 * 经全量 32 域核验的安全白名单 ignorePatterns：
 * 保留 `packages/{core,ui}/dist/**`、`packages/desktop/dist/renderer/** /*.mjs`、
 * `packages/desktop/__tests__/unit/helpers/**`、`packages/ui/src/icons/*.{ts,tsx}`、
 * `brandSpec.ts`、`brand-spec.json`。
 */
export const DEFAULT_IGNORE_PATTERNS = [
  'release/**',
  'packages/desktop/release/**',
  'artifacts/**',
  '.stryker-tmp/**',
  'dist/**',
  'reports/**',
  'coverage/**',
  'docs/**',
  'preview/**',
  '.agents/**',
  '.githooks/**',
  '.github/**',
  '.openchamber/**',
  '.opencode/**',
  '.playwright-mcp/**',
  '.ruff_cache/**',
  '.env',
  '.env.*',
  '*.log',
  'bun.lock',
  'stryker-output-*.json',
  'tmp-*.mjs',
  'packages/mobile/android/**',
  'packages/mobile/ios/**',
  'packages/mobile/dist/**',
  'packages/mobile/release/**',
  'packages/desktop/build/**',
  'packages/desktop/dist/build/**',
  'packages/desktop/dist/renderer/icons/**',
  'packages/desktop/dist/renderer/fonts/**',
  'packages/desktop/dist/renderer/index.js',
  'packages/desktop/dist/renderer/index.js.map',
  'packages/desktop/dist/renderer/tailwind.css',
  'packages/desktop/dist/renderer/conversation.css',
  'packages/desktop/dist/renderer/styles.css',
  'packages/desktop/dist/main/**',
  'packages/desktop/dist/preload/**',
  'packages/desktop/dist/**/*.map',
  'packages/ui/src/icons/lobe/**',
  'packages/desktop/__tests__/cdp/**',
  'packages/desktop/__tests__/e2e/**',
  '**/*.{psd,exe,dmg,zip,AppImage,apk,png,jpg,ico,icns,woff,woff2,ttf,otf}',
];

const POSITIVE_INT_RE = /^[1-9]\d*$/;
const MUTATE_RANGE_SUFFIX_RE = /:(?:\d+(?::\d+)?-\d+(?::\d+)?|\d+(?::\d+)?)$/;

/** 根据逻辑 CPU 核心数计算默认 Stryker worker 并发（封顶 6、保底 2，保留余量防 CPU 争抢导致墙钟超时） */
export function resolveDefaultConcurrency(cpuCount = os.availableParallelism()) {
  const numeric = Number.isFinite(cpuCount) ? cpuCount : 2;
  return Math.max(2, Math.min(6, Math.floor(numeric * 0.75)));
}

function printList() {
  console.log(`${C.cyan}${C.bold}Hermes Flux 变异测试存量领域清单 (Burndown Registry)${C.reset}\n`);
  console.log(`${'领域代码 (Domain)'.padEnd(26)} | ${'领域说明'.padEnd(36)} | ${'最低门禁分'}`);
  console.log(''.padEnd(80, '-'));
  for (const [key, d] of Object.entries(MUTATION_DOMAINS)) {
    console.log(`${key.padEnd(26)} | ${d.title.padEnd(36)} | ${d.minScore}%`);
  }
  console.log('\n运行单个领域: npm run mutation:stryker -- --domain=<name> [--concurrency=<N>]');
}

/**
 * 完整遍历 CLI 参数，严格校验 `--list`、`--domain=<name>`、`--concurrency=<N>`。
 *
 * 【约束与规则 (Rules)】
 *   1. 禁止早退：必须扫描全部参数，防止 `--domain=` 后置 `--concurrency=` 被静默忽略；
 *   2. 未知参数、空值、重复参数、非正整数并发与原型链域名键一律显式拒绝。
 */
export function parseCliArgs(argv = process.argv.slice(2), domains = MUTATION_DOMAINS) {
  let wantsList = false;
  let domain = null;
  let concurrency = null;

  for (const arg of argv) {
    if (arg === '--list') {
      wantsList = true;
      continue;
    }
    if (arg.startsWith('--domain=')) {
      if (domain !== null) {
        return { ok: false, error: `参数 --domain 重复出现: ${arg}` };
      }
      const value = arg.slice('--domain='.length);
      if (!value) {
        return { ok: false, error: '参数 --domain 不能为空' };
      }
      domain = value;
      continue;
    }
    if (arg.startsWith('--concurrency=')) {
      if (concurrency !== null) {
        return { ok: false, error: `参数 --concurrency 重复出现: ${arg}` };
      }
      const raw = arg.slice('--concurrency='.length);
      if (!POSITIVE_INT_RE.test(raw)) {
        return { ok: false, error: `非法 --concurrency 值 "${raw}"，必须为正整数（如 2、4）` };
      }
      concurrency = Number(raw);
      continue;
    }
    return { ok: false, error: `未知参数: ${arg}` };
  }

  if (wantsList) {
    if (domain !== null || concurrency !== null) {
      return { ok: false, error: '--list 不能与 --domain 或 --concurrency 混用' };
    }
    return { ok: true, action: 'list' };
  }

  const resolvedDomain = domain ?? 'cache';
  if (!Object.hasOwn(domains, resolvedDomain)) {
    return {
      ok: false,
      unknownDomain: resolvedDomain,
      error: `未知领域: ${resolvedDomain}`,
    };
  }

  return {
    ok: true,
    action: 'run',
    domain: resolvedDomain,
    concurrency: concurrency ?? resolveDefaultConcurrency(),
  };
}

/**
 * 在启动 Stryker 沙盒前预检领域配置的 mutate 与 testFiles 物理存在性。
 *
 * 【设计意图 (Why)】避免因路径过期（如重命名后未同步注册表）耗时建沙箱后才在 dry run 失败。
 */
export function validateDomainFiles(domainConfig, repoRoot = REPO_ROOT) {
  const missing = [];

  for (const raw of domainConfig.mutate || []) {
    if (!raw || raw.startsWith('!')) continue;
    const stripped = raw.replace(MUTATE_RANGE_SUFFIX_RE, '');
    if (/[*?[\]]/.test(stripped)) continue;
    const abs = path.join(repoRoot, stripped);
    if (!fs.existsSync(abs)) {
      missing.push({ kind: 'mutate', raw, resolved: stripped });
    }
  }

  for (const raw of domainConfig.testFiles || []) {
    if (!raw) continue;
    if (/[*?[\]]/.test(raw)) continue;
    const abs = path.join(repoRoot, raw);
    if (!fs.existsSync(abs)) {
      missing.push({ kind: 'testFile', raw, resolved: raw });
    }
  }

  return { ok: missing.length === 0, missing };
}

export function buildStrykerConfig(domain, domainConfig, opts = {}) {
  const reportRelPath = opts.reportRelPath ?? `reports/mutation/${domain}.json`;
  const concurrency = opts.concurrency ?? resolveDefaultConcurrency();
  const extraIgnore = Array.isArray(domainConfig.ignorePatterns) ? domainConfig.ignorePatterns : [];
  const ignorePatterns = [...DEFAULT_IGNORE_PATTERNS];
  for (const p of extraIgnore) {
    if (!ignorePatterns.includes(p)) ignorePatterns.push(p);
  }

  return {
    /**
     * 【必须显式声明插件 (Why)】Stryker 10 在嵌套或非标准 node_modules 布局下
     *   可能找不到 `@stryker-mutator/tap-runner` 的自动发现入口，显式列出确保稳定加载。
     */
    plugins: ['@stryker-mutator/tap-runner'],
    testRunner: 'tap',
    tap: {
      testFiles: domainConfig.testFiles,
    },
    mutate: domainConfig.mutate,
    buildCommand: domainConfig.buildCommand || 'npm run build:core',
    reporters: ['progress', 'clear-text', 'json'],
    jsonReporter: {
      fileName: reportRelPath,
    },
    tempDirName: '.stryker-tmp',
    concurrency,
    timeoutMS: 15000,
    ignorePatterns,
    thresholds: {
      high: 80,
      low: 60,
      break: null,
    },
  };
}

function makeDiagnosticSample(filePath, mutant) {
  return {
    id: mutant.id ?? null,
    file: filePath,
    line: mutant.location?.start?.line ?? null,
    status: mutant.status ?? null,
    statusReason: mutant.statusReason ?? null,
  };
}

/**
 * 按 Stryker 官方 `mutation-testing-metrics` 口径评估 JSON 报告并执行 5 道硬哨兵。
 *
 * 【官方口径与防假绿规则 (Rules)】
 *   - totalValid = killed + timeout + survived + noCoverage（排除 CompileError/RuntimeError/Ignored/Pending）；
 *   - 将 Timeout 按 `statusReason` 是否以 `'Hit limit reached'` 开头拆为 hitLimitTimeout 与 wallClockTimeout；
 *   - 5 道硬哨兵同时拦截空结果、全 NoCoverage（防被 Ignored 绕过）、RuntimeError/Pending、
 *     高并发墙钟超时假绿通胀以及低于领域 minScore。
 */
export function evaluateMutationReport(report, domainConfig) {
  const files = report?.files && typeof report.files === 'object' ? report.files : {};
  let totalMutants = 0;
  let killed = 0;
  let hitLimitTimeout = 0;
  let wallClockTimeout = 0;
  let survived = 0;
  let noCoverage = 0;
  let runtimeErrors = 0;
  let compileErrors = 0;
  let ignored = 0;
  let pending = 0;
  let unknownStatus = 0;

  const samples = {
    wallClockTimeout: [],
    runtimeErrors: [],
    pending: [],
    unknownStatus: [],
  };

  const pushSample = (bucket, filePath, m) => {
    if (bucket.length < 3) {
      bucket.push(makeDiagnosticSample(filePath, m));
    }
  };

  for (const [filePath, fileData] of Object.entries(files)) {
    const mutants = Array.isArray(fileData?.mutants) ? fileData.mutants : [];
    totalMutants += mutants.length;
    for (const m of mutants) {
      switch (m?.status) {
        case 'Killed':
          killed += 1;
          break;
        case 'Timeout':
          if (typeof m.statusReason === 'string' && m.statusReason.startsWith('Hit limit reached')) {
            hitLimitTimeout += 1;
          } else {
            wallClockTimeout += 1;
            pushSample(samples.wallClockTimeout, filePath, m);
          }
          break;
        case 'Survived':
          survived += 1;
          break;
        case 'NoCoverage':
          noCoverage += 1;
          break;
        case 'RuntimeError':
          runtimeErrors += 1;
          pushSample(samples.runtimeErrors, filePath, m);
          break;
        case 'CompileError':
          compileErrors += 1;
          break;
        case 'Ignored':
          ignored += 1;
          break;
        case 'Pending':
          pending += 1;
          pushSample(samples.pending, filePath, m);
          break;
        default:
          unknownStatus += 1;
          pushSample(samples.unknownStatus, filePath, m || {});
          break;
      }
    }
  }

  const timeout = hitLimitTimeout + wallClockTimeout;
  const totalDetected = killed + timeout;
  const totalValid = killed + timeout + survived + noCoverage;
  const totalCovered = killed + timeout + survived;
  const mutationScore = totalValid > 0 ? (totalDetected / totalValid) * 100 : 0;
  const coveredScore = totalCovered > 0 ? (totalDetected / totalCovered) * 100 : 0;
  const scoreExcludingWallClock = totalValid > 0 ? ((killed + hitLimitTimeout) / totalValid) * 100 : 0;

  const failures = [];
  const warnings = [];

  // 哨兵 1：必须有有效变异体被生成并测试
  if (totalValid === 0) {
    failures.push('未找到任何有效变异体 (totalValid === 0)，请检查 mutate 配置路径或编译状态');
  }

  // 哨兵 2：绝不允许全部有效变异体处于 NoCoverage 状态（不可被 Ignored/RuntimeError 绕过）
  if (totalValid > 0 && noCoverage === totalValid) {
    failures.push('100% 有效变异体均为 NoCoverage，构建产物未被测试引用或 buildCommand 未生效！');
  }

  // 哨兵 3：不允许出现 Pending / RuntimeError / 未知状态
  if (pending > 0 || runtimeErrors > 0 || unknownStatus > 0) {
    failures.push(
      `存在异常变异体状态（RuntimeError=${runtimeErrors}, Pending=${pending}, Unknown=${unknownStatus}），测试环境或并发 worker 可能崩溃`,
    );
  }

  // 哨兵 4：两层墙钟超时防假绿哨兵
  if (wallClockTimeout > 0) {
    warnings.push(
      `检测到 ${wallClockTimeout} 个墙钟超时变异体 (wallClockTimeout)，请确认非高并发 CPU 争抢所致`,
    );
  }
  if (totalValid > 0 && ((killed === 0 && wallClockTimeout > 0) || wallClockTimeout / totalValid > 0.25)) {
    failures.push(
      `墙钟超时异常飙升（wallClockTimeout=${wallClockTimeout}, killed=${killed}, totalValid=${totalValid}），疑似零有效断言或并发饿死`,
    );
  } else {
    const maxWallClock = domainConfig.maxWallClockTimeout ?? 0;
    if (totalValid > 0 && wallClockTimeout > maxWallClock && scoreExcludingWallClock < domainConfig.minScore) {
      failures.push(
        `疑似高并发墙钟超时通胀假绿：wallClockTimeout=${wallClockTimeout} > 允许上限 ${maxWallClock}，` +
          `剔除墙钟超时后得分 ${scoreExcludingWallClock.toFixed(2)}% 低于门禁 ${domainConfig.minScore}%（请降 --concurrency 复测）`,
      );
    }
  }

  // 哨兵 5：领域专属门禁分
  if (totalValid > 0 && mutationScore < domainConfig.minScore) {
    failures.push(
      `变异杀死得分 ${mutationScore.toFixed(2)}% 低于领域门禁阈值 ${domainConfig.minScore}%`,
    );
  }

  return {
    ok: failures.length === 0,
    counts: {
      totalMutants,
      totalValid,
      totalCovered,
      killed,
      timeout,
      hitLimitTimeout,
      wallClockTimeout,
      survived,
      noCoverage,
      runtimeErrors,
      compileErrors,
      ignored,
      pending,
      unknownStatus,
    },
    scores: {
      mutationScore,
      coveredScore,
      scoreExcludingWallClock,
    },
    samples,
    warnings,
    failures,
  };
}

function formatSamples(label, items) {
  if (!items || items.length === 0) return;
  console.error(`    ${label} 样本（最多 3 条）:`);
  for (const s of items) {
    console.error(
      `      - [${s.id ?? '?'}] ${s.file}:${s.line ?? '?'}${s.status ? ` status=${s.status}` : ''}${s.statusReason ? ` (${s.statusReason})` : ''}`,
    );
  }
}

export function publishMutationReport(tempReportPath, finalReportPath) {
  fs.mkdirSync(path.dirname(finalReportPath), { recursive: true });
  const transientCodes = new Set(['EPERM', 'EACCES', 'EBUSY']);
  const maxAttempts = 5;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      fs.renameSync(tempReportPath, finalReportPath);
      return;
    } catch (err) {
      const code = err && typeof err === 'object' ? err.code : '';
      if (!transientCodes.has(code) || attempt === maxAttempts - 1) {
        throw err;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15 * (attempt + 1));
    }
  }
}

function acquireHoldFile(dir, filePath) {
  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.writeFileSync(filePath, `${process.pid}\n`, 'utf8');
  } catch (err) {
    if (err && typeof err === 'object' && err.code === 'ENOENT') {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(filePath, `${process.pid}\n`, 'utf8');
    } else {
      throw err;
    }
  }
}

function formatDisplayArg(arg) {
  const rel = path.relative(REPO_ROOT, arg);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    return arg;
  }
  return rel;
}

function main() {
  const req = parseCliArgs(process.argv.slice(2), MUTATION_DOMAINS);
  if (!req.ok) {
    console.error(`${C.red}✗ ${req.error}${C.reset}`);
    if (req.unknownDomain) printList();
    process.exit(1);
  }

  if (req.action === 'list') {
    printList();
    return;
  }

  const domainConfig = MUTATION_DOMAINS[req.domain];
  const fileCheck = validateDomainFiles(domainConfig, REPO_ROOT);
  if (!fileCheck.ok) {
    console.error(`${C.red}✗ 领域 [${req.domain}] 配置路径缺失，无法启动 Stryker:${C.reset}`);
    for (const item of fileCheck.missing) {
      console.error(`  - [${item.kind}] ${item.raw} (解析路径: ${item.resolved})`);
    }
    process.exit(1);
  }

  console.log(`${C.cyan}${C.bold}Stryker 领域化自动化变异测试${C.reset}`);
  console.log(`  目标领域: ${C.bold}${domainConfig.title}${C.reset} [${req.domain}]`);
  console.log(`  并发度:   ${req.concurrency}`);
  console.log(`  变异目标: ${domainConfig.mutate.join(', ')}`);
  console.log(`  驱动测试: ${domainConfig.testFiles.join(', ')}\n`);

  const uniqueSuffix = `${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const tempReportRelPath = `reports/mutation/.tmp-${req.domain}-${uniqueSuffix}.json`;
  const tempReportFile = path.join(REPO_ROOT, tempReportRelPath);
  const reportFile = path.join(REPO_ROOT, 'reports', 'mutation', `${req.domain}.json`);
  const dynamicConfig = path.join(os.tmpdir(), `hermes-stryker-${req.domain}-${uniqueSuffix}.json`);
  const strykerTmpDir = path.join(REPO_ROOT, '.stryker-tmp');
  const holdFile = path.join(strykerTmpDir, `.hold-${uniqueSuffix}`);

  const config = buildStrykerConfig(req.domain, domainConfig, {
    concurrency: req.concurrency,
    reportRelPath: tempReportRelPath,
  });

  const strykerBin = path.join(REPO_ROOT, 'node_modules/@stryker-mutator/core/bin/stryker.js');
  const args = [strykerBin, 'run', dynamicConfig];
  console.log(`执行命令: node ${args.map(formatDisplayArg).join(' ')}`);

  const start = Date.now();
  let runResult;
  let report;
  try {
    try {
      fs.writeFileSync(dynamicConfig, JSON.stringify(config, null, 2), 'utf8');
      acquireHoldFile(strykerTmpDir, holdFile);

      runResult = spawnSync(process.execPath, args, {
        cwd: REPO_ROOT,
        stdio: 'inherit',
        env: { ...process.env, FORCE_COLOR: '1' },
      });
    } finally {
      if (fs.existsSync(dynamicConfig)) {
        try {
          fs.rmSync(dynamicConfig, { force: true });
        } catch (err) {
          console.warn(`${C.yellow}! 清理临时配置失败 (${dynamicConfig}): ${err.message}${C.reset}`);
        }
      }
      if (fs.existsSync(holdFile)) {
        try {
          fs.rmSync(holdFile, { force: true });
        } catch (err) {
          console.warn(`${C.yellow}! 清理保活占位文件失败 (${holdFile}): ${err.message}${C.reset}`);
        }
      }
    }

    const durationSec = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`\nStryker 变异测试完成，耗时: ${durationSec}s`);

    if (runResult.error || runResult.signal || runResult.status !== 0) {
      const reason = runResult.error
        ? `error=${runResult.error.message}`
        : runResult.signal
          ? `signal=${runResult.signal}`
          : `exitCode=${runResult.status}`;
      console.error(`${C.red}✗ Stryker 执行异常退出 (${reason})，拒绝读取不完整报告${C.reset}`);
      process.exitCode = 1;
      return;
    }

    if (!fs.existsSync(tempReportFile)) {
      console.error(`${C.red}✗ 错误: 未生成临时变异报告 ${tempReportFile}${C.reset}`);
      process.exitCode = 1;
      return;
    }

    try {
      report = JSON.parse(fs.readFileSync(tempReportFile, 'utf8'));
    } catch (err) {
      console.error(`${C.red}✗ 错误: 解析变异报告失败 (${tempReportFile}): ${err.message}${C.reset}`);
      process.exitCode = 1;
      return;
    }

    try {
      publishMutationReport(tempReportFile, reportFile);
    } catch (err) {
      console.error(`${C.red}✗ 错误: 发布变异报告失败 (${reportFile}): ${err.message}${C.reset}`);
      process.exitCode = 1;
      return;
    }
  } finally {
    if (fs.existsSync(tempReportFile)) {
      try {
        fs.rmSync(tempReportFile, { force: true });
      } catch (err) {
        console.warn(`${C.yellow}! 清理临时变异报告失败 (${tempReportFile}): ${err.message}${C.reset}`);
      }
    }
  }

  const evaluation = evaluateMutationReport(report, domainConfig);
  const { counts, scores, samples, warnings, failures } = evaluation;

  console.log(`\n${C.bold}变异度量统计 [${req.domain}]:${C.reset}`);
  console.log(`  总有效变异 (Total Valid):      ${counts.totalValid} (原始总数: ${counts.totalMutants})`);
  console.log(`  成功杀死数 (Killed):           ${C.green}${counts.killed}${C.reset}`);
  console.log(
    `  超时变异体 (Timeout):          ${counts.wallClockTimeout > 0 ? C.yellow : C.cyan}${counts.timeout}${C.reset} ` +
      `(HitLimit=${counts.hitLimitTimeout}, WallClock=${counts.wallClockTimeout})`,
  );
  console.log(`  存活变异体 (Survived):         ${counts.survived > 0 ? C.yellow : C.green}${counts.survived}${C.reset}`);
  console.log(`  未覆盖变异 (NoCoverage):       ${counts.noCoverage > 0 ? C.red : C.green}${counts.noCoverage}${C.reset}`);
  if (
    counts.runtimeErrors > 0 ||
    counts.compileErrors > 0 ||
    counts.ignored > 0 ||
    counts.pending > 0 ||
    counts.unknownStatus > 0
  ) {
    console.log(
      `  其他状态统计:                  RuntimeError=${counts.runtimeErrors}, CompileError=${counts.compileErrors}, ` +
        `Ignored=${counts.ignored}, Pending=${counts.pending}, Unknown=${counts.unknownStatus}`,
    );
  }
  console.log(
    `  全量变异得分 (Mutation Score): ${scores.mutationScore >= domainConfig.minScore ? C.green : C.red}${scores.mutationScore.toFixed(2)}%${C.reset}`,
  );
  console.log(
    `  被测变异得分 (Covered Score):  ${scores.coveredScore >= domainConfig.minScore ? C.green : C.red}${scores.coveredScore.toFixed(2)}%${C.reset}`,
  );
  console.log(`  剔除墙钟得分 (Excl. Wall):     ${scores.scoreExcludingWallClock.toFixed(2)}%`);

  for (const w of warnings) {
    console.warn(`${C.yellow}! 告警: ${w}${C.reset}`);
  }
  if (counts.wallClockTimeout > 0) {
    formatSamples('WallClock Timeout', samples.wallClockTimeout);
  }

  if (!evaluation.ok) {
    for (const f of failures) {
      console.error(`${C.red}✗ 门禁失败: ${f}${C.reset}`);
    }
    formatSamples('RuntimeError', samples.runtimeErrors);
    formatSamples('Pending', samples.pending);
    formatSamples('UnknownStatus', samples.unknownStatus);
    process.exit(1);
  }

  console.log(
    `\n${C.green}✓ 领域 [${req.domain}] 变异测试门禁通过（得分 ${scores.mutationScore.toFixed(2)}% ≥ ${domainConfig.minScore}%）${C.reset}`,
  );
}

function isMainEntry() {
  if (!process.argv[1]) return false;
  const entry = path.resolve(process.argv[1]);
  if (!fs.existsSync(entry)) return false;
  return fs.realpathSync(entry) === fs.realpathSync(fileURLToPath(import.meta.url));
}

if (isMainEntry()) {
  main();
}
