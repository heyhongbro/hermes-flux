import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { REPO_ROOT, listSuiteFiles } from './test-targets.mjs';

const DOC_OR_TEMPLATE_RE = /\.(?:md|example)$/i;

export function resolveHookConcurrency(cpuCount = os.availableParallelism?.() ?? os.cpus().length) {
  const numeric = Number.isFinite(cpuCount) && cpuCount > 0 ? cpuCount : 4;
  return Math.max(2, Math.min(8, Math.floor(numeric * 0.75)));
}

export function isDocOrTemplate(file) {
  return (
    DOC_OR_TEMPLATE_RE.test(file) ||
    file === 'LICENSE' ||
    file === 'docs/invariants.json' ||
    file.startsWith('docs/')
  );
}

export function isTestOrFixture(file) {
  return (
    /^packages\/(?:core|ui|desktop|mobile)\/__tests__\//.test(file) ||
    file.startsWith('scripts/__tests__/') ||
    file.endsWith('.test.mjs')
  );
}

export function isWorkflow(file) {
  return file.startsWith('.github/workflows/');
}

export function isContractSurface(file) {
  return (
    file.startsWith('packages/core/__tests__/fixtures/gateway/') ||
    file.startsWith('scripts/contract/') ||
    file.startsWith('packages/core/src/rpc/')
  );
}

export function isGatewayDoc(file) {
  return file.startsWith('docs/gateway/');
}

export function isInvariantsSurface(file) {
  return (
    file === 'docs/invariants.json' ||
    file === 'docs/invariants.md' ||
    file === 'scripts/verify/invariant-map.mjs' ||
    file.startsWith('packages/core/__tests__/formal/')
  );
}

export function isCoverageScript(file) {
  return (
    file === 'scripts/verify/new-code-coverage.mjs' ||
    file === 'scripts/__tests__/gate-coverage-interceptor.test.mjs'
  );
}

export function isRootBuildConfig(file) {
  return (
    file === 'package.json' ||
    file === 'package-lock.json' ||
    /^tsconfig.*\.json$/i.test(file)
  );
}

/** 读取 Git 暂存区全部变更文件路径（POSIX 相对路径），以及目前磁盘仍存在的文件集合 */
export function readStagedFiles(repoRoot = REPO_ROOT) {
  const out = execFileSync('git', ['diff', '--cached', '--name-only'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  const stagedSet = new Set();
  for (const rawLine of out.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    stagedSet.add(trimmed.split(path.sep).join('/'));
  }
  const stagedFiles = [...stagedSet].sort();
  const existingFiles = new Set(
    stagedFiles.filter((rel) => fs.existsSync(path.join(repoRoot, rel))),
  );
  return { stagedFiles, existingFiles };
}

/** 探测本地各 Workspace 的编译产物是否已在磁盘就绪 */
export function readDistReady(repoRoot = REPO_ROOT) {
  return {
    core: fs.existsSync(path.join(repoRoot, 'packages/core/dist/index.js')),
    ui: fs.existsSync(path.join(repoRoot, 'packages/ui/dist/index.js')),
    desktop:
      fs.existsSync(path.join(repoRoot, 'packages/desktop/dist/main/index.js')) &&
      fs.existsSync(path.join(repoRoot, 'packages/desktop/dist/renderer/index.js')),
  };
}

function fullGatePlan(npmCmd) {
  return {
    mode: 'full',
    summary: '全量门禁模式（PRECOMMIT_FULL=1）',
    gates: [
      { label: 'Gate 0/4 · 静态门禁（架构/失败静默/换肤/i18n/性能）', command: 'node', args: ['scripts/gates/run.mjs', '--staged'] },
      { label: 'Gate 0b · 网关契约一致性（方法名与字段白名单）', command: 'node', args: ['scripts/contract/verify.mjs'] },
      { label: 'Gate 0c · 探针覆盖率（每个调用点都要有真实响应证据）', command: 'node', args: ['scripts/contract/coverage.mjs'] },
      { label: 'Gate 0d · 接口文档与契约同步', command: 'node', args: ['scripts/contract/doc.mjs', '--check'] },
      { label: 'Gate 1 · 全栈严格类型', command: npmCmd, args: ['run', 'typecheck'] },
      { label: 'Gate 2 · 单元与不变量测试', command: npmCmd, args: ['test'] },
      { label: 'Gate 2b · 形式化安全不变量检验', command: npmCmd, args: ['run', 'verify:formal'] },
      { label: 'Gate 2c · 不变量映射表（Markdown 与 JSON 一致）', command: npmCmd, args: ['run', 'gates:invariants'] },
      { label: 'Gate 2d · 豁免敞口预算', command: npmCmd, args: ['run', 'gates:allow'] },
      { label: 'Gate 2g · 增量覆盖率拦截自证（行与分支覆盖杀伤力）', command: npmCmd, args: ['run', 'gates:coverage-proof'] },
    ],
  };
}

function appendMissingDistBuilds(gates, need, npmCmd) {
  if (need.core) {
    gates.push({ label: 'Build · 构建 core (@hermes-flux/core)', command: npmCmd, args: ['run', 'build:core'] });
  }
  if (need.ui) {
    gates.push({ label: 'Build · 构建 ui (@hermes-flux/ui)', command: npmCmd, args: ['run', 'build:ui'] });
  }
  if (need.desktop) {
    gates.push({ label: 'Build · 构建 desktop (Electron / Mobile 产物)', command: npmCmd, args: ['run', 'build:desktop'] });
  }
}

/**
 * 纯函数：根据暂存区变更文件清单，分层编排最小充分本地 pre-commit 门禁清单。
 */
export function planPreCommitGates(stagedFiles = [], opts = {}) {
  const npmCmd = opts.npmCmd ?? (process.platform === 'win32' ? 'npm.cmd' : 'npm');
  const env = opts.env ?? process.env;
  if (env?.PRECOMMIT_FULL === '1') {
    return fullGatePlan(npmCmd);
  }

  const files = [...new Set(stagedFiles.map((f) => String(f).replace(/\\/g, '/')).filter(Boolean))].sort();
  if (files.length === 0) {
    return { mode: 'empty', summary: '暂存区无改动文件', gates: [] };
  }

  const existingSet = opts.existingFiles instanceof Set
    ? opts.existingFiles
    : new Set(Array.isArray(opts.existingFiles) ? opts.existingFiles : files);
  const ready = {
    core: opts.distReady?.core ?? true,
    ui: opts.distReady?.ui ?? true,
    desktop: opts.distReady?.desktop ?? true,
  };
  const unitFiles = opts.unitFiles ?? listSuiteFiles('unit');
  const formalFiles = opts.formalFiles ?? listSuiteFiles('formal');
  const concurrency = opts.concurrency ?? resolveHookConcurrency();

  const allDocs = files.every(isDocOrTemplate);
  const hasInvariant = files.some(isInvariantsSurface);
  const hasGatewayDoc = files.some(isGatewayDoc);

  if (allDocs) {
    const gates = [
      { label: 'Gate 0/4 · 静态门禁（暂存区文档与注释合规）', command: 'node', args: ['scripts/gates/run.mjs', '--staged'] },
    ];
    if (hasInvariant) {
      gates.push({ label: 'Gate 2c · 不变量映射表（Markdown 与 JSON 一致）', command: npmCmd, args: ['run', 'gates:invariants'] });
    }
    if (hasGatewayDoc) {
      gates.push({ label: 'Gate 0d · 接口文档与契约同步', command: 'node', args: ['scripts/contract/doc.mjs', '--check'] });
    }
    return { mode: 'docs', summary: `纯文档与模板改动 (${files.length} 个文件)`, gates };
  }

  const hasTest = files.some(isTestOrFixture);
  const allDocsOrTests = files.every((f) => isDocOrTemplate(f) || isTestOrFixture(f));
  const hasContract = files.some(isContractSurface);

  if (hasTest && allDocsOrTests) {
    const gates = [
      { label: 'Gate 0/4 · 静态门禁（测试规模/规范与文档）', command: 'node', args: ['scripts/gates/run.mjs', '--staged'] },
    ];
    if (hasContract) {
      gates.push({ label: 'Gate 0b · 网关契约一致性（方法名与字段白名单）', command: 'node', args: ['scripts/contract/verify.mjs'] });
      gates.push({ label: 'Gate 0c · 探针覆盖率（每个调用点都要有真实响应证据）', command: 'node', args: ['scripts/contract/coverage.mjs'] });
      gates.push({ label: 'Gate 0d · 接口文档与契约同步', command: 'node', args: ['scripts/contract/doc.mjs', '--check'] });
    }
    if (hasInvariant) {
      gates.push({ label: 'Gate 2c · 不变量映射表（Markdown 与 JSON 一致）', command: npmCmd, args: ['run', 'gates:invariants'] });
    }

    const runnableTests = files.filter((f) => f.endsWith('.test.mjs') && existingSet.has(f));
    if (runnableTests.length > 0) {
      const hasCoreTests = runnableTests.some((f) => f.startsWith('packages/core/'));
      const hasUiTests = runnableTests.some((f) => f.startsWith('packages/ui/'));
      const hasDesktopOrMobileTests = runnableTests.some(
        (f) => f.startsWith('packages/desktop/') || f.startsWith('packages/mobile/'),
      );
      appendMissingDistBuilds(
        gates,
        {
          core: !ready.core && (hasCoreTests || hasUiTests || hasDesktopOrMobileTests),
          ui: !ready.ui && (hasUiTests || hasDesktopOrMobileTests),
          desktop: !ready.desktop && hasDesktopOrMobileTests,
        },
        npmCmd,
      );
      gates.push({
        label: `Gate 2 · 定向测试 (${runnableTests.length} 个改动测试文件, concurrency=${concurrency})`,
        command: 'node',
        args: ['--test', `--test-concurrency=${concurrency}`, ...runnableTests],
      });
    }

    gates.push({ label: 'Gate 2d · 豁免敞口预算', command: npmCmd, args: ['run', 'gates:allow'] });
    return { mode: 'tests', summary: `测试与夹具改动 (${files.length} 个文件)`, gates };
  }

  // Scoped tier: source code, scripts, hooks, workflows, or root build config
  const gates = [
    { label: 'Gate 0/4 · 静态门禁（架构/失败静默/换肤/i18n/性能）', command: 'node', args: ['scripts/gates/run.mjs', '--staged'] },
  ];

  const needsCiCheck = files.some(
    (f) =>
      isWorkflow(f) ||
      f === 'scripts/gates/verify-ci-workflow.mjs' ||
      f === 'scripts/gates/detect-ci-scope.mjs',
  );
  if (needsCiCheck) {
    gates.push({ label: 'Gate 0a · CI workflow 可移植性', command: npmCmd, args: ['run', 'gates:ci'] });
  }

  const hasProductSrc = files.some((f) => /^packages\/(?:core|ui|desktop|mobile)\/src\//.test(f));
  if (hasContract || hasProductSrc) {
    gates.push({ label: 'Gate 0b · 网关契约一致性（方法名与字段白名单）', command: 'node', args: ['scripts/contract/verify.mjs'] });
  }
  if (hasContract) {
    gates.push({ label: 'Gate 0c · 探针覆盖率（每个调用点都要有真实响应证据）', command: 'node', args: ['scripts/contract/coverage.mjs'] });
    gates.push({ label: 'Gate 0d · 接口文档与契约同步', command: 'node', args: ['scripts/contract/doc.mjs', '--check'] });
  }
  if (hasInvariant) {
    gates.push({ label: 'Gate 2c · 不变量映射表（Markdown 与 JSON 一致）', command: npmCmd, args: ['run', 'gates:invariants'] });
  }
  gates.push({ label: 'Gate 2d · 豁免敞口预算', command: npmCmd, args: ['run', 'gates:allow'] });

  if (files.some(isCoverageScript)) {
    gates.push({ label: 'Gate 2g · 增量覆盖率拦截自证（行与分支覆盖杀伤力）', command: npmCmd, args: ['run', 'gates:coverage-proof'] });
  }

  if (files.some(isRootBuildConfig)) {
    gates.push({ label: 'Gate 1 · 全栈严格类型', command: npmCmd, args: ['run', 'typecheck'] });
    gates.push({ label: 'Gate 1b · 全量构建', command: npmCmd, args: ['run', 'build'] });
    gates.push({ label: 'Gate 2 · 全量单元与集成测试', command: npmCmd, args: ['run', 'census'] });
    return { mode: 'scoped', summary: `根构建/配置改动 (${files.length} 个文件，运行全量构建与测试)`, gates };
  }

  const touched = {
    core: files.some((f) => f.startsWith('packages/core/')),
    ui: files.some((f) => f.startsWith('packages/ui/')),
    desktop: files.some((f) => /^packages\/desktop\/(?:src|scripts|__tests__)\//.test(f)),
    mobile: files.some((f) => /^packages\/mobile\//.test(f)),
    scripts: files.some((f) => f.startsWith('scripts/') || f.startsWith('.githooks/')),
    workflow: files.some(isWorkflow),
  };

  if (touched.core || touched.ui || touched.desktop || touched.mobile) {
    gates.push({ label: 'Gate 1 · 全栈严格类型', command: npmCmd, args: ['run', 'typecheck'] });
  }

  const needCore = touched.core || ((touched.ui || touched.desktop || touched.mobile) && !ready.core);
  const needUi =
    touched.ui ||
    (touched.core && (touched.ui || touched.desktop || touched.mobile)) ||
    ((touched.desktop || touched.mobile) && !ready.ui);
  const needDesktop = touched.desktop || touched.mobile || (touched.scripts && !ready.desktop);
  appendMissingDistBuilds(gates, { core: needCore, ui: needUi, desktop: needDesktop }, npmCmd);

  const scopedSet = new Set();
  const addPrefix = (list, prefix) => {
    for (const f of list) {
      if (f.startsWith(prefix)) scopedSet.add(f);
    }
  };
  if (touched.core) {
    addPrefix(unitFiles, 'packages/core/__tests__/');
    for (const f of formalFiles) scopedSet.add(f);
  }
  if (touched.ui) addPrefix(unitFiles, 'packages/ui/__tests__/');
  if (touched.desktop) addPrefix(unitFiles, 'packages/desktop/__tests__/unit/');
  if (touched.mobile) addPrefix(unitFiles, 'packages/mobile/__tests__/unit/');
  if (touched.scripts) addPrefix(unitFiles, 'scripts/__tests__/');
  if (!touched.scripts && touched.workflow) {
    const wfTest = 'scripts/__tests__/verify-ci-workflow.test.mjs';
    if (unitFiles.includes(wfTest)) scopedSet.add(wfTest);
  }

  const scopedTests = [...scopedSet].sort();
  if (scopedTests.length > 0) {
    gates.push({
      label: `Gate 2 · 受影响域单测 (${scopedTests.length} 个文件, concurrency=${concurrency})`,
      command: 'node',
      args: ['--test', `--test-concurrency=${concurrency}`, ...scopedTests],
    });
  }

  return { mode: 'scoped', summary: `受影响域分层校验 (${files.length} 个暂存文件)`, gates };
}
