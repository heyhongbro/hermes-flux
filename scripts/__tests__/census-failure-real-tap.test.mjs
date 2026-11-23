import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseTapFailures } from '../gates/census-check.mjs';

/**
 * 用真实 node:test 进程产出真实失败 TAP，验证失败提取器。
 *
 * 【设计意图 (Why)】
 *   前一版测试用的是手写 TAP 样本。手写样本永远"符合预期"，
 *   而真实 node:test 的 TAP 形态会随版本变化（父级用 `# Subtest:` 而非 `ok`）。
 *   只有让 node --test 真的跑一个会失败的测试文件，才能证明解析器对真实输出有效。
 *
 * 【防范的历史坑 (Pitfall)】
 *   上一版实现只跟 `ok` 行收集父级，实测真实输出里父级是 `# Subtest: outer`，
 *   于是失败名退化成 `inner case`，父级上下文整个丢失——而手写样本恰好
 *   写了 `ok` 风格的父级，把 bug 完全掩盖了。
 *
 * 【约束与规则 (Rules)】
 *   真实子进程测试；临时文件在 after 钩子清理。
 */

const tmpDirs = [];

test.after(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function runRealFailingTest(testBody) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-tap-'));
  tmpDirs.push(dir);
  const file = path.join(dir, 'sample.test.mjs');
  fs.writeFileSync(file, testBody);
  const env = { ...process.env, FORCE_COLOR: '0' };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', file], {
    encoding: 'utf8',
    timeout: 60000,
    env,
  });
  return `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
}

test('真实失败的 TAP 必须被提取出用例名与断言原因', () => {
  const out = runRealFailingTest(`
import test from 'node:test';
import assert from 'node:assert/strict';

test('outer suite', async (t) => {
  await t.test('inner case', () => {
    assert.equal(3, 4, 'deliberate failure');
  });
});
`);
  const failures = parseTapFailures(out);

  assert.ok(failures.length >= 1, `必须提取到失败用例，实际输出片段：\n${out.slice(0, 800)}`);

  const blob = failures.map((f) => `${f.name}\n${f.details.join('\n')}`).join('\n---\n');
  assert.match(blob, /inner case/, '必须包含失败用例名');
  assert.match(blob, /outer suite/, '必须包含父级用例名（层级不能丢）');
  assert.match(blob, /3|4/, '必须带出断言涉及的期望/实际值');
});

test('真实多行断言失败产出的 error: |- 必须提取完整错误原因而非裸 |-', () => {
  const out = runRealFailingTest(`
import test from 'node:test';
import assert from 'node:assert/strict';

test('multiline suite', async (t) => {
  await t.test('multiline case', () => {
    assert.ok(false, '第一行失败原因\\n第二行失败细节');
  });
});
`);
  const failures = parseTapFailures(out);
  assert.ok(failures.length >= 1, `必须提取到多行失败用例，实际输出片段：\n${out.slice(0, 800)}`);

  const target = failures.find((f) => f.name.includes('multiline case')) ?? failures[0];
  const blob = target.details.join('\n');
  assert.ok(!/^error: \|-$/m.test(blob), `不得只输出裸 error: |-\n${blob}`);
  assert.match(blob, /第一行失败原因/, `必须提取多行错误首行\n${blob}`);
  assert.match(blob, /第二行失败细节/, `必须提取多行错误次行\n${blob}`);
});

test('真实嵌套 TAP 输出作为失败文案时不得截断 code 或误生幽灵失败', () => {
  const out = runRealFailingTest(`
import test from 'node:test';
import assert from 'node:assert/strict';

test('outer real', async (t) => {
  await t.test('embedded tap case', () => {
    const fakeChildTap = ['# Subtest: inner phantom', 'not ok 1 - phantom', '...', 'ok 1 - done'].join('\\n');
    assert.ok(false, 'wrapped failure\\n' + fakeChildTap);
  });
});
`);
  const failures = parseTapFailures(out);
  const embedded = failures.find((f) => f.name.includes('embedded tap case'));
  assert.ok(embedded, `必须命中真实失败用例，实际: ${JSON.stringify(failures)}`);
  assert.ok(!failures.some((f) => f.name.includes('phantom')), `不得解析出幽灵失败: ${JSON.stringify(failures)}`);
  const blob = embedded.details.join('\n');
  assert.match(blob, /wrapped failure/, `必须保留错误首行\n${blob}`);
  assert.match(blob, /ERR_ASSERTION/, `内嵌 ... 之后的 code 不得丢失\n${blob}`);
});
