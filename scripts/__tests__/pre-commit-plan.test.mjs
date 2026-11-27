import test from 'node:test';
import assert from 'node:assert/strict';

import {
  planPreCommitGates,
  resolveHookConcurrency,
} from '../gates/lib/pre-commit-plan.mjs';
import { classifyCiScope, isDocsOnlyPath } from '../gates/detect-ci-scope.mjs';

const SAMPLE_UNITS = [
  'packages/core/__tests__/session/deliverables.test.mjs',
  'packages/ui/__tests__/code-copy.test.mjs',
  'packages/desktop/__tests__/unit/render-coordinator.test.mjs',
  'packages/mobile/__tests__/unit/android-signing-config.test.mjs',
  'scripts/__tests__/gate-census.test.mjs',
  'scripts/__tests__/verify-ci-workflow.test.mjs',
];

const SAMPLE_FORMAL = ['packages/core/__tests__/formal/ws-fsm-formal.test.mjs'];

const hasCmd = (plan, match) =>
  plan.gates.some((g) => `${g.command} ${g.args.join(' ')}`.includes(match));

test('pre-commit-plan · empty 与 PRECOMMIT_FULL=1 边界', () => {
  const empty = planPreCommitGates([], { unitFiles: SAMPLE_UNITS, formalFiles: SAMPLE_FORMAL });
  assert.equal(empty.mode, 'empty');
  assert.equal(empty.gates.length, 0);

  const full = planPreCommitGates(['README.md'], {
    env: { PRECOMMIT_FULL: '1' },
    npmCmd: 'npm',
  });
  assert.equal(full.mode, 'full');
  assert.equal(full.gates.length, 10);
  assert.equal(hasCmd(full, 'npm run verify:formal'), true);
});

test('pre-commit-plan · docs 档位按文档域最小运行，不触发编译与单测', () => {
  const plainDocs = planPreCommitGates(['README.md', 'README.zh-CN.md', 'LICENSE', '.env.example'], {
    npmCmd: 'npm',
    env: {},
  });
  assert.equal(plainDocs.mode, 'docs');
  assert.equal(plainDocs.gates.length, 1);
  assert.equal(hasCmd(plainDocs, 'scripts/gates/run.mjs --staged'), true);

  const invDocs = planPreCommitGates(['docs/invariants.json', 'docs/invariants.md'], {
    npmCmd: 'npm',
    env: {},
  });
  assert.equal(invDocs.mode, 'docs');
  assert.equal(hasCmd(invDocs, 'npm run gates:invariants'), true);
  assert.equal(hasCmd(invDocs, 'contract/doc.mjs'), false);

  const gwDocs = planPreCommitGates(['docs/gateway/sessions.md'], {
    npmCmd: 'npm',
    env: {},
  });
  assert.equal(gwDocs.mode, 'docs');
  assert.equal(hasCmd(gwDocs, 'scripts/contract/doc.mjs --check'), true);
  assert.equal(hasCmd(gwDocs, 'build:'), false);
});

test('pre-commit-plan · tests 档位只跑暂存存在单测、过滤已删除文件、按需补构建并检查契约', () => {
  const onlyUnit = planPreCommitGates(
    [
      'packages/core/__tests__/session/deliverables.test.mjs',
      'packages/core/__tests__/removed.test.mjs',
    ],
    {
      existingFiles: new Set(['packages/core/__tests__/session/deliverables.test.mjs']),
      distReady: { core: false, ui: true, desktop: true },
      concurrency: 6,
      npmCmd: 'npm',
      env: {},
    },
  );
  assert.equal(onlyUnit.mode, 'tests');
  assert.equal(hasCmd(onlyUnit, 'npm run build:core'), true);
  assert.equal(hasCmd(onlyUnit, 'npm run build:ui'), false);
  assert.equal(hasCmd(onlyUnit, '--test-concurrency=6 packages/core/__tests__/session/deliverables.test.mjs'), true);
  assert.equal(hasCmd(onlyUnit, 'removed.test.mjs'), false);
  assert.equal(hasCmd(onlyUnit, 'npm run gates:allow'), true);

  const gatewayFixture = planPreCommitGates(
    ['packages/core/__tests__/fixtures/gateway/index.json'],
    {
      distReady: { core: true, ui: true, desktop: true },
      npmCmd: 'npm',
      env: {},
    },
  );
  assert.equal(gatewayFixture.mode, 'tests');
  assert.equal(hasCmd(gatewayFixture, 'scripts/contract/verify.mjs'), true);
  assert.equal(hasCmd(gatewayFixture, 'scripts/contract/coverage.mjs'), true);
  assert.equal(hasCmd(gatewayFixture, 'scripts/contract/doc.mjs --check'), true);
  assert.equal(hasCmd(gatewayFixture, 'npm run build:'), false);
});

test('pre-commit-plan · scoped 档位按变更包精确缩放构建、类型检查与受影响单测', () => {
  const coreOnly = planPreCommitGates(['packages/core/src/session/deliverables.ts'], {
    unitFiles: SAMPLE_UNITS,
    formalFiles: SAMPLE_FORMAL,
    distReady: { core: true, ui: true, desktop: true },
    concurrency: 6,
    npmCmd: 'npm',
    env: {},
  });
  assert.equal(coreOnly.mode, 'scoped');
  assert.equal(hasCmd(coreOnly, 'npm run typecheck'), true);
  assert.equal(hasCmd(coreOnly, 'npm run build:core'), true);
  assert.equal(hasCmd(coreOnly, 'npm run build:ui'), false);
  assert.equal(hasCmd(coreOnly, 'npm run build:desktop'), false);
  assert.equal(hasCmd(coreOnly, 'deliverables.test.mjs'), true);
  assert.equal(hasCmd(coreOnly, 'ws-fsm-formal.test.mjs'), true);
  assert.equal(hasCmd(coreOnly, 'render-coordinator.test.mjs'), false);

  const uiWithDesktop = planPreCommitGates(['packages/ui/src/tokens/skins.ts', 'packages/desktop/src/renderer/styles.css'], {
    unitFiles: SAMPLE_UNITS,
    formalFiles: SAMPLE_FORMAL,
    distReady: { core: false, ui: true, desktop: true },
    concurrency: 6,
    npmCmd: 'npm',
    env: {},
  });
  assert.equal(hasCmd(uiWithDesktop, 'npm run build:core'), true);
  assert.equal(hasCmd(uiWithDesktop, 'npm run build:ui'), true);
  assert.equal(hasCmd(uiWithDesktop, 'npm run build:desktop'), true);
  assert.equal(hasCmd(uiWithDesktop, 'code-copy.test.mjs'), true);
  assert.equal(hasCmd(uiWithDesktop, 'render-coordinator.test.mjs'), true);

  const wfOnly = planPreCommitGates(['.github/workflows/quality-gates.yml'], {
    unitFiles: SAMPLE_UNITS,
    formalFiles: SAMPLE_FORMAL,
    npmCmd: 'npm',
    env: {},
  });
  assert.equal(hasCmd(wfOnly, 'npm run gates:ci'), true);
  assert.equal(hasCmd(wfOnly, 'npm run typecheck'), false);
  assert.equal(hasCmd(wfOnly, 'verify-ci-workflow.test.mjs'), true);

  const covScript = planPreCommitGates(['scripts/verify/new-code-coverage.mjs'], {
    unitFiles: SAMPLE_UNITS,
    formalFiles: SAMPLE_FORMAL,
    distReady: { core: true, ui: true, desktop: true },
    npmCmd: 'npm',
    env: {},
  });
  assert.equal(hasCmd(covScript, 'npm run gates:coverage-proof'), true);
  assert.equal(hasCmd(covScript, 'gate-census.test.mjs'), true);

  const rootPkg = planPreCommitGates(['package.json', 'README.md'], {
    unitFiles: SAMPLE_UNITS,
    formalFiles: SAMPLE_FORMAL,
    npmCmd: 'npm',
    env: {},
  });
  assert.equal(hasCmd(rootPkg, 'npm run build'), true);
  assert.equal(hasCmd(rootPkg, 'npm run census'), true);

  assert.equal(resolveHookConcurrency(8), 6);
  assert.equal(resolveHookConcurrency(2), 2);
});

test('detect-ci-scope · 仅对纯文档/模板 PR 放行 docs 快速通道，其余全部落回 full', () => {
  assert.equal(isDocsOnlyPath('README.md'), true);
  assert.equal(isDocsOnlyPath('README.zh-CN.md'), true);
  assert.equal(isDocsOnlyPath('LICENSE'), true);
  assert.equal(isDocsOnlyPath('.env.example'), true);
  assert.equal(isDocsOnlyPath('packages/mobile/android/keystore.properties.example'), true);
  assert.equal(isDocsOnlyPath('docs/gateway/sessions.md'), true);
  assert.equal(isDocsOnlyPath('docs/invariants.json'), true);
  assert.equal(isDocsOnlyPath('packages/core/__tests__/fixtures/gateway/index.json'), false);

  assert.equal(
    classifyCiScope(['README.md', 'README.zh-CN.md', 'LICENSE', 'docs/quality-gates.md'], { eventName: 'pull_request' }),
    'docs',
  );
  assert.equal(
    classifyCiScope(['README.md'], { eventName: 'push' }),
    'full',
  );
  assert.equal(
    classifyCiScope(['README.md'], { eventName: 'workflow_dispatch' }),
    'full',
  );
  assert.equal(
    classifyCiScope([], { eventName: 'pull_request' }),
    'full',
  );
  assert.equal(
    classifyCiScope(['README.md', 'packages/core/src/rpc/client.ts'], { eventName: 'pull_request' }),
    'full',
  );
  assert.equal(
    classifyCiScope(['README.md', '.github/workflows/quality-gates.yml'], { eventName: 'pull_request' }),
    'full',
  );
});
