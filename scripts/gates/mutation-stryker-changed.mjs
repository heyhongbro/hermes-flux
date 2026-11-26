#!/usr/bin/env node
/**
 * 基于 PR / 分支变更集的按需 Stryker 变异测试调度器
 *
 * 【设计意图 (Why)】
 *   全量 32 个 Stryker 领域串行耗时过长，不适合每次 PR 全量重跑；
 *   本脚本只根据真实变更集（含源码改动行区间与测试文件变更）精准筛选命中的变异域并执行，
 *   实现“改哪个领域就验哪个域的变异杀伤力”，未命中的零额外开销（跳过冗余 build）。
 *
 * 【防范的历史坑 (Pitfall)】
 *   1. 只按文件名不判 hunk 行区间时，修改某文件 L100 处的 UI 辅助常量会把同文件下
 *      不相干的高耗时行区间域全部拉起；反之纯删除 hunk（`+newStart,0`）若不计区间则会被漏掉。
 *   2. 仅扫描源码不扫描 `testFiles` 会让人通过删减断言让测试变绿而绕过变异门禁。
 *   3. 遇到未知源码变更但未归属任何变异域时不得静默假绿，必须在日志与 Summary 中显式列出。
 *
 * 【约束与规则 (Rules)】
 *   - `git diff` 失败或参数非法时必须显式非零退出，禁止静默降级为 0 命中。
 *   - 导出纯函数 `parseMutateSpec`、`parseUnifiedDiffHunks`、`selectAffectedDomains`、
 *     `parseChangedCliArgs` 供单元测试严格校验。
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MUTATION_DOMAINS } from './lib/mutation-domains.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '../..');

const POSITIVE_INT_RE = /^[1-9]\d*$/;
const MUTATE_SPEC_RE = /^([^:]+?):(\d+)(?::\d+)?(?:-(\d+)(?::\d+)?)?$/;
const HUNK_HEADER_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;
const PRODUCT_SOURCE_RE = /^packages\/(?:core|ui|desktop|mobile)\/src\/.+\.(?:ts|tsx|mjs|js)$/;

const toPosix = (p) => String(p).replace(/\\/g, '/');

function unquoteGitPath(raw) {
  const trimmed = raw.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return trimmed;
}

/**
 * 解析一条 Stryker `mutate` 规则为 `{ file, startLine, endLine }`。
 * 忽略 `!` 排除项与含通配符路径，统一 POSIX 分隔符。
 */
export function parseMutateSpec(spec) {
  if (!spec || typeof spec !== 'string') return null;
  const trimmed = spec.trim();
  if (!trimmed || trimmed.startsWith('!')) return null;

  const normalized = toPosix(trimmed);
  const m = MUTATE_SPEC_RE.exec(normalized);
  if (m) {
    const file = m[1];
    if (/[*?[\]]/.test(file)) return null;
    const startLine = Number(m[2]);
    const endLine = m[3] ? Number(m[3]) : startLine;
    return {
      file,
      startLine: Math.min(startLine, endLine),
      endLine: Math.max(startLine, endLine),
    };
  }

  if (/[*?[\]]/.test(normalized)) return null;
  return { file: normalized, startLine: null, endLine: null };
}

/**
 * 解析 `git diff --unified=0` 文本，产出 `Map<file, Array<[startLine, endLine]>>`。
 * 对纯删除 hunk（`newCount === 0`）记录邻接区间 `[Math.max(1, newStart), Math.max(1, newStart + 1)]`，
 * 确保删除守卫行同样触发包含该行的变异域。
 */
export function parseUnifiedDiffHunks(diffText) {
  const rangesByFile = new Map();
  if (!diffText || typeof diffText !== 'string') return rangesByFile;

  let currentFile = null;
  for (const rawLine of diffText.split(/\r?\n/)) {
    if (rawLine.startsWith('+++ ')) {
      const target = rawLine.slice(4).trim();
      if (target === '/dev/null') {
        currentFile = null;
        continue;
      }
      const unquoted = toPosix(unquoteGitPath(target));
      currentFile = unquoted.startsWith('b/') ? unquoted.slice(2) : unquoted;
      if (!rangesByFile.has(currentFile)) rangesByFile.set(currentFile, []);
      continue;
    }

    if (!currentFile || !rawLine.startsWith('@@ ')) continue;
    const hm = HUNK_HEADER_RE.exec(rawLine);
    if (!hm) continue;
    const newStart = Number(hm[1]);
    const newCount = hm[2] !== undefined ? Number(hm[2]) : 1;
    const range =
      newCount === 0
        ? [Math.max(1, newStart), Math.max(1, newStart + 1)]
        : [Math.max(1, newStart), Math.max(1, newStart + newCount - 1)];
    rangesByFile.get(currentFile).push(range);
  }

  return rangesByFile;
}

function rangesOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart <= bEnd && aEnd >= bStart;
}

function isProductSourceFile(file) {
  return PRODUCT_SOURCE_RE.test(file) && !file.endsWith('.d.ts') && !file.endsWith('.generated.ts');
}

/**
 * 按变更文件清单与行区间精确筛选受影响 Stryker 领域，并收集未归属任何域的源码变更。
 */
export function selectAffectedDomains(
  { changedFiles = [], changedRangesByFile = new Map() },
  domains = MUTATION_DOMAINS,
) {
  const changedSet = new Set(changedFiles.map(toPosix).filter(Boolean));
  const selectedDomains = [];
  const details = [];
  const coveredSourceFiles = new Set();

  for (const [domain, cfg] of Object.entries(domains)) {
    const reasons = [];

    for (const rawSpec of cfg.mutate || []) {
      const parsed = parseMutateSpec(rawSpec);
      if (!parsed || !changedSet.has(parsed.file)) continue;

      if (parsed.startLine === null) {
        reasons.push(`mutate:${rawSpec}`);
        coveredSourceFiles.add(parsed.file);
        continue;
      }

      const hunks = changedRangesByFile.get(parsed.file);
      if (!hunks || hunks.length === 0) {
        reasons.push(`mutate:${rawSpec}`);
        coveredSourceFiles.add(parsed.file);
        continue;
      }

      if (hunks.some(([hs, he]) => rangesOverlap(hs, he, parsed.startLine, parsed.endLine))) {
        reasons.push(`mutate:${rawSpec}`);
        coveredSourceFiles.add(parsed.file);
      }
    }

    for (const rawTest of cfg.testFiles || []) {
      const posixTest = toPosix(rawTest);
      if (changedSet.has(posixTest)) {
        reasons.push(`test:${posixTest}`);
      }
    }

    if (reasons.length > 0) {
      selectedDomains.push(domain);
      details.push({
        domain,
        title: cfg.title || domain,
        reasons,
      });
    }
  }

  const unmappedSourceFiles = [...changedSet]
    .filter((file) => isProductSourceFile(file) && !coveredSourceFiles.has(file))
    .sort();

  return {
    selectedDomains,
    details,
    unmappedSourceFiles,
  };
}

/** 解析 CLI 参数与 CI 环境变量，严格拒绝重复参数、未知标志及非法域/并发 */
export function parseChangedCliArgs(
  argv = process.argv.slice(2),
  env = process.env,
  domains = MUTATION_DOMAINS,
) {
  let base = null;
  let concurrency = null;
  let dryRun = false;
  let ci = false;

  for (const arg of argv) {
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (arg === '--ci') {
      ci = true;
      continue;
    }
    if (arg.startsWith('--base=')) {
      if (base !== null) {
        return { ok: false, error: `参数 --base 重复出现: ${arg}` };
      }
      const value = arg.slice('--base='.length).trim();
      if (!value) {
        return { ok: false, error: '参数 --base 不能为空' };
      }
      base = value;
      continue;
    }
    if (arg.startsWith('--concurrency=')) {
      if (concurrency !== null) {
        return { ok: false, error: `参数 --concurrency 重复出现: ${arg}` };
      }
      const raw = arg.slice('--concurrency='.length).trim();
      if (!POSITIVE_INT_RE.test(raw)) {
        return { ok: false, error: `非法 --concurrency 值 "${raw}"，必须为正整数（如 2、4、6）` };
      }
      concurrency = Number(raw);
      continue;
    }
    return { ok: false, error: `未知参数: ${arg}` };
  }

  let manualDomain = null;
  if (ci) {
    const rawDomain = typeof env?.MANUAL_MUTATION_DOMAIN === 'string' ? env.MANUAL_MUTATION_DOMAIN.trim() : '';
    if (rawDomain) {
      if (!Object.hasOwn(domains, rawDomain)) {
        return { ok: false, error: `环境变量 MANUAL_MUTATION_DOMAIN 指定了未知领域: ${rawDomain}` };
      }
      manualDomain = rawDomain;
    }

    const prBaseRef = typeof env?.PR_BASE_REF === 'string' ? env.PR_BASE_REF.trim() : '';
    if (!base && prBaseRef) {
      base = prBaseRef.startsWith('origin/') ? prBaseRef : `origin/${prBaseRef}`;
    }
  }

  return {
    ok: true,
    base,
    concurrency,
    dryRun,
    ci,
    manualDomain,
  };
}

function runGit(args) {
  return spawnSync('git', args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

function resolveDiffBase(explicitBase) {
  if (explicitBase) {
    const mb = runGit(['merge-base', 'HEAD', explicitBase]);
    if (mb.status === 0 && mb.stdout.trim()) return mb.stdout.trim();
    return explicitBase;
  }

  for (const ref of ['origin/main', 'main', 'origin/dev/v0.1']) {
    const mb = runGit(['merge-base', 'HEAD', ref]);
    if (mb.status === 0 && mb.stdout.trim()) return mb.stdout.trim();
  }
  return null;
}

function mergeRangeMaps(target, source) {
  for (const [file, ranges] of source.entries()) {
    if (!target.has(file)) target.set(file, []);
    target.get(file).push(...ranges);
  }
}

function appendStepSummary(markdown, env = process.env) {
  const summaryPath = typeof env.GITHUB_STEP_SUMMARY === 'string' ? env.GITHUB_STEP_SUMMARY.trim() : '';
  if (!summaryPath) return;
  fs.appendFileSync(summaryPath, `${markdown}\n`, 'utf8');
}

function main() {
  const req = parseChangedCliArgs(process.argv.slice(2), process.env, MUTATION_DOMAINS);
  if (!req.ok) {
    console.error(`✗ ${req.error}`);
    process.exit(1);
  }

  let baseLabel = req.manualDomain ? 'manual:workflow_dispatch' : '';
  let details = [];
  let unmappedSourceFiles = [];

  if (req.manualDomain) {
    details = [
      {
        domain: req.manualDomain,
        title: MUTATION_DOMAINS[req.manualDomain].title || req.manualDomain,
        reasons: ['manual:workflow_dispatch'],
      },
    ];
  } else {
    const resolvedBase = resolveDiffBase(req.base);
    if (!resolvedBase) {
      console.error('✗ 无法解析 Git 比较基线，请显式传入 --base=<ref>');
      process.exit(1);
    }
    baseLabel = resolvedBase;

    const changedSet = new Set();
    const changedRangesByFile = new Map();

    const diffArgs = req.ci
      ? ['diff', '--unified=0', '--diff-filter=ACMR', `${resolvedBase}...HEAD`]
      : ['diff', '--unified=0', '--diff-filter=ACMR', resolvedBase];

    const diffRes = runGit(diffArgs);
    if (diffRes.error || diffRes.signal || diffRes.status !== 0) {
      const reason = diffRes.error?.message || diffRes.signal || diffRes.stderr?.trim() || `exit ${diffRes.status}`;
      console.error(`✗ 执行 git diff 失败 (${diffArgs.join(' ')}): ${reason}`);
      process.exit(1);
    }
    const baseHunks = parseUnifiedDiffHunks(diffRes.stdout || '');
    for (const file of baseHunks.keys()) changedSet.add(file);
    mergeRangeMaps(changedRangesByFile, baseHunks);

    if (!req.ci) {
      const cachedRes = runGit(['diff', '--unified=0', '--cached', '--diff-filter=ACMR']);
      if (cachedRes.error || cachedRes.signal || cachedRes.status !== 0) {
        console.error(`✗ 读取暂存区 diff 失败: ${cachedRes.stderr || cachedRes.status}`);
        process.exit(1);
      }
      const cachedHunks = parseUnifiedDiffHunks(cachedRes.stdout || '');
      for (const file of cachedHunks.keys()) changedSet.add(file);
      mergeRangeMaps(changedRangesByFile, cachedHunks);

      const untrackedRes = runGit(['ls-files', '--others', '--exclude-standard']);
      if (untrackedRes.error || untrackedRes.signal || untrackedRes.status !== 0) {
        console.error(`✗ 枚举未跟踪文件失败: ${untrackedRes.stderr || untrackedRes.status}`);
        process.exit(1);
      }
      for (const line of (untrackedRes.stdout || '').split(/\r?\n/)) {
        const rel = toPosix(line.trim());
        if (rel) changedSet.add(rel);
      }
    }

    const selection = selectAffectedDomains(
      { changedFiles: [...changedSet], changedRangesByFile },
      MUTATION_DOMAINS,
    );
    details = selection.details;
    unmappedSourceFiles = selection.unmappedSourceFiles;
  }

  console.log(`PR / 变更集 Stryker 变异调度 (基线: ${baseLabel}${req.dryRun ? ', dry-run' : ''})`);
  if (details.length === 0) {
    console.log('  · 未命中任何已登记变异域，无需运行 Stryker（跳过构建与沙盒）');
  } else {
    console.log(`  · 命中 ${details.length} 个变异域:`);
    for (const item of details) {
      console.log(`    - [${item.domain}] ${item.title} (${item.reasons.join(', ')})`);
    }
  }
  if (unmappedSourceFiles.length > 0) {
    console.log(`  ! 未登记变异域的生产源码变更 (${unmappedSourceFiles.length} 个，显式可见):`);
    for (const f of unmappedSourceFiles) console.log(`    - ${f}`);
  }

  if (req.dryRun || details.length === 0) {
    appendStepSummary(
      [
        '## PR 变更集 Stryker 变异测试',
        '',
        `- 基线：\`${baseLabel}\``,
        `- 命中领域：${details.length === 0 ? '0（无受影响域，已跳过）' : details.map((d) => `\`${d.domain}\``).join(', ')}`,
        ...(unmappedSourceFiles.length > 0
          ? [`- 未登记变异域源码变更（${unmappedSourceFiles.length} 个）：${unmappedSourceFiles.map((f) => `\`${f}\``).join(', ')}`]
          : []),
        '',
      ].join('\n'),
    );
    return;
  }

  const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const needsShell = process.platform === 'win32' && /\.cmd$/i.test(NPM);
  console.log('\n正在构建全量产物 (npm run build)...');
  const buildRes = spawnSync(NPM, ['run', 'build'], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    shell: needsShell,
  });
  if (buildRes.error || buildRes.signal || buildRes.status !== 0) {
    console.error('✗ npm run build 失败，中止变更域 Stryker 执行');
    appendStepSummary('## PR 变更集 Stryker 变异测试\n\n- 状态：前置构建 `npm run build` 失败');
    process.exitCode = 1;
    return;
  }

  const strykerRunner = path.join(HERE, 'mutation-stryker.mjs');
  const outcomes = [];
  for (const item of details) {
    const runArgs = [strykerRunner, `--domain=${item.domain}`];
    if (req.concurrency !== null) runArgs.push(`--concurrency=${req.concurrency}`);
    const startedAt = Date.now();
    console.log(`\n=== 运行变异域 [${item.domain}] ===`);
    const res = spawnSync(process.execPath, runArgs, {
      cwd: REPO_ROOT,
      stdio: 'inherit',
    });
    const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
    const ok = !res.error && !res.signal && res.status === 0;
    outcomes.push({ ...item, ok, elapsedSec });
  }

  const failedCount = outcomes.filter((o) => !o.ok).length;
  appendStepSummary(
    [
      '## PR 变更集 Stryker 变异测试',
      '',
      `- 基线：\`${baseLabel}\` · 命中 ${outcomes.length} 域 · 失败 ${failedCount} 域`,
      '',
      '| 领域 | 触发原因 | 结果 | 耗时 |',
      '| --- | --- | --- | ---: |',
      ...outcomes.map(
        (o) => `| \`${o.domain}\` | ${o.reasons.join(', ')} | ${o.ok ? 'PASS' : 'FAIL'} | ${o.elapsedSec}s |`,
      ),
      ...(unmappedSourceFiles.length > 0
        ? ['', `- 未登记变异域源码变更（${unmappedSourceFiles.length} 个）：${unmappedSourceFiles.map((f) => `\`${f}\``).join(', ')}`]
        : []),
      '',
    ].join('\n'),
  );

  if (failedCount > 0) {
    console.error(`\n✗ PR 变更域变异测试失败：${failedCount} / ${outcomes.length} 个域未通过`);
    process.exitCode = 1;
    return;
  }
  console.log(`\n✓ PR 变更域变异测试全部通过（${outcomes.length} / ${outcomes.length} 域）`);
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
