import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');

/**
 * 增量覆盖率拦截器自证与证伪测试 (Self-Proof / Mutation Verification)
 *
 * 【设计意图 (Why)】
 *   拦截器本身的价值在于「未覆盖代码/分支低于红线必拦截、达标后放行」。
 *   若拦截器无法在真实反例下变红，它就是假门禁。
 *   本测试用真实产物与测试用例验证拦截器的三项核心性质：
 *     1. 新增代码行低于 90% 红线（或未导入）时，拦截器必须硬阻断；
 *     2. 95.8% / 91.4% 覆盖率在默认 90% 红线下放行，但在 `--min-branch=95` 下必精准定位未闭合分支并阻断；
 *     3. 跨平台可移植性，不产生未捕获异常。
 */

test('拦截器证伪实证 1：存在未覆盖行且低于 90% 时必须阻断并报告未执行或未导入', () => {
  const r = spawnSync(
    process.execPath,
    [
      'scripts/verify/new-code-coverage.mjs',
      '--probe-files=packages/core/src/agent/agentPresence.ts',
      '--test-files=packages/core/__tests__/profile/botManagement.test.mjs',
    ],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );

  // 必须退出非 0
  assert.equal(r.status, 1, '未覆盖代码时门禁必须退出 1');
  assert.match(
    r.stdout,
    /(Line Coverage < 90%|没有任何测试 import 它)/,
    '必须明确报告未执行行或未被测试引用',
  );
  assert.match(
    r.stdout,
    /✘ 增量覆盖不达标/,
    '必须明确输出增量覆盖不达标标识',
  );
});

test('拦截器证伪实证 2：90% 默认红线放行与高阈值精准分支拦截', () => {
  const args = [
    'scripts/verify/new-code-coverage.mjs',
    '--probe-files=packages/core/src/agent/agentPresence.ts',
    '--test-files=packages/core/__tests__/agent/agentPresence.test.mjs',
  ];
  const rDefault = spawnSync(process.execPath, args, { cwd: REPO_ROOT, encoding: 'utf8' });
  assert.equal(rDefault.status, 0, `默认 90% 红线应放行，实际输出:\n${rDefault.stdout}\n${rDefault.stderr}`);
  assert.match(rDefault.stdout, /✔ 增量覆盖达标/);

  const rStrict = spawnSync(process.execPath, [...args, '--min-branch=95'], { cwd: REPO_ROOT, encoding: 'utf8' });
  assert.equal(rStrict.status, 1, '分支覆盖低于 --min-branch=95 时门禁必须退出 1');
  assert.match(
    rStrict.stdout,
    /Branch Coverage < 95%/,
    '必须明确报告分支覆盖未达 95%',
  );
  // 动态定位三元运算符单侧未命中分支（steps.length > 0 ? steps : [1]），避免前置类型/逻辑追加导致行号漂移假红
  const presenceLines = fs
    .readFileSync(path.join(REPO_ROOT, 'packages/core/src/agent/agentPresence.ts'), 'utf8')
    .split(/\r?\n/);
  const ternaryIdx = presenceLines.findIndex((line) => line.includes('steps.length > 0 ? steps : [1]'));
  assert.ok(ternaryIdx >= 0, '预期能在 agentPresence.ts 中找到目标三元表达式');
  const expectedLine = ternaryIdx + 1;
  assert.match(
    rStrict.stdout,
    new RegExp(`行：.*${expectedLine}`),
    `必须精准定位到未覆盖分支所在的源码行号 ${expectedLine}`,
  );
});

test('拦截器健壮性：基线比对与参数解析在无源码变动时安全退出 0', () => {
  // 【约束与规则 (Rules)】必须显式声明"本次改动集为空"：
  //   直接拿 `--base=HEAD` 跑，结论会依赖运行者的工作区是否干净，本地未提交时必然假红，
  //   而这条测试要守的是"空改动集 + 基线参数解析"这条路径本身。
  const r = spawnSync(
    process.execPath,
    ['scripts/verify/new-code-coverage.mjs', '--base=HEAD', '--probe-files='],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );

  assert.equal(r.status, 0, '比对无变动基线时应正常放行退出 0');
  assert.match(
    r.stdout,
    /无需判定/,
    '无受控源码改动时应输出无需判定提示',
  );
});

test('拦截器纯类型边界：仅含 TypeScript interface/type 声明的文件不计入未执行代码假红', () => {
  const r = spawnSync(
    process.execPath,
    [
      'scripts/verify/new-code-coverage.mjs',
      '--probe-files=packages/core/src/pal/IPlatformBridge.ts',
    ],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );

  assert.equal(r.status, 0, `纯接口声明文件应退出 0，实际输出:\n${r.stdout}\n${r.stderr}`);
});
