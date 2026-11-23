import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  REPO_ROOT,
  verifyAgentConfig,
} from '../gates/verify-config.mjs';

/**
 * 通用 `.agents/` 配置校验器（Gate 2c）单元测试
 *
 * 【设计意图 (Why)】
 *   Gate 2c 在脱离特定客户端专有配置后，负责直接校验 `.agents/`
 *   中审查者的只读约束与验证技能完整性。本测试通过独立沙箱目录构造各类合法格式与安全绕过样本，
 *   确保门禁具备真实变异杀伤力：既放行合法 YAML 写法，也精准拦截越权与伪造。
 *
 * 【防范的历史坑 (Pitfall)】
 *   1. 禁止仅靠删除目录/导入常量做弱自证（否则从 REQUIRED_SKILLS 删掉条目测试仍全绿）；
 *   2. 禁止忽略行尾内联注释绕过（`effect: allow # effect: deny`）与局部 resource 放行；
 *   3. 必须覆盖空 SKILL.md、缺失 `.agents/` 目录、dedent 后孤立键值等关键边界。
 *
 * 【约束与规则 (Rules)】
 *   所有临时目录必须放在 `os.tmpdir()` 并用 `try/finally` 无条件清理；
 *   预期审查者与技能清单在测试内硬编码断言，不依赖被测模块导出的常量。
 */

const EXPECTED_REVIEWERS = ['flux-style-reviewer', 'flux-code-reviewer'];
const EXPECTED_SKILLS = [
  'verify-hermes-flux',
  'verify-formal-invariants',
  'verify-cache-invariants',
];

const VALID_REVIEWER_MD = `---
description: 只读审查者
mode: subagent
permissions:
  - action: edit
    resource: "*"
    effect: deny
  - action: subagent
    resource: "*"
    effect: deny
---

# Reviewer
`;

function createValidWorkspace(root) {
  for (const reviewer of EXPECTED_REVIEWERS) {
    const file = path.join(root, '.agents', 'agents', `${reviewer}.md`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, VALID_REVIEWER_MD, 'utf8');
  }
  for (const skill of EXPECTED_SKILLS) {
    const file = path.join(root, '.agents', 'skills', skill, 'SKILL.md');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `# ${skill}\n`, 'utf8');
  }
}

function withTempWorkspace(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-verify-config-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('真实仓库 .agents/ 配置必须通过 Gate 2c 校验', () => {
  const res = verifyAgentConfig(REPO_ROOT);
  assert.equal(res.ok, true, `真实仓库校验失败: ${res.errors.join('; ')}`);
  assert.deepEqual(res.reviewers, EXPECTED_REVIEWERS);
  assert.deepEqual(res.skills, EXPECTED_SKILLS);
});

test('缺少 .agents/ 目录时必须立即失败并给出明确错误', () => {
  withTempWorkspace((dir) => {
    const res = verifyAgentConfig(dir);
    assert.equal(res.ok, false);
    assert.ok(res.errors.some((e) => e.includes('.agents/')));
  });
});

test('合法边界写法（CRLF / 引号 / 内联注释 / 空行 / 零缩进 / 键序反转 / 嵌套列表）必须全部放行', () => {
  withTempWorkspace((dir) => {
    createValidWorkspace(dir);

    // 1. CRLF + 引号标量 + 有效行尾注释 + 空行/列0注释 + 键序反转 + 嵌套子列表
    const complexYaml = [
      '---',
      'mode: "subagent" # 仅允许子代理',
      'permissions:',
      '',
      '# 顶格注释行不得中断 permissions 块',
      '  - effect: "deny" # 先写 effect 再写 action',
      '    resource: "*"',
      '    tags:',
      '      - readonly',
      '      - audit',
      '    meta:',
      '      effect: allow',
      '    action: "edit"',
      '---',
      '# OK',
      '',
    ].join('\r\n');
    fs.writeFileSync(path.join(dir, '.agents/agents/flux-style-reviewer.md'), complexYaml, 'utf8');

    // 2. 零缩进 sequence（`-` 与 `permissions:` 同列）
    const zeroIndentYaml = `---
mode: subagent
permissions:
- action: edit
  resource: "*"
  effect: deny
---
`;
    fs.writeFileSync(path.join(dir, '.agents/agents/flux-code-reviewer.md'), zeroIndentYaml, 'utf8');

    const res = verifyAgentConfig(dir);
    assert.equal(res.ok, true, `合法边界配置被误杀: ${res.errors.join('; ')}`);
    assert.deepEqual(res.reviewers, EXPECTED_REVIEWERS);
    assert.deepEqual(res.skills, EXPECTED_SKILLS);
  });
});

test('缺少任一审查 Agent 规范（flux-style-reviewer / flux-code-reviewer）时必须失败', () => {
  for (const reviewer of EXPECTED_REVIEWERS) {
    withTempWorkspace((dir) => {
      createValidWorkspace(dir);
      fs.rmSync(path.join(dir, `.agents/agents/${reviewer}.md`));
      const res = verifyAgentConfig(dir);
      assert.equal(res.ok, false);
      assert.ok(res.errors.some((e) => e.includes(`${reviewer}.md`)));
    });
  }
});

test('审查 Agent 缺少 YAML frontmatter 或未声明 mode: subagent 时必须失败', () => {
  withTempWorkspace((dir) => {
    createValidWorkspace(dir);
    fs.writeFileSync(path.join(dir, '.agents/agents/flux-style-reviewer.md'), '# No frontmatter\n', 'utf8');
    const noFm = verifyAgentConfig(dir);
    assert.equal(noFm.ok, false);
    assert.ok(noFm.errors.some((e) => e.includes('YAML frontmatter')));

    fs.writeFileSync(
      path.join(dir, '.agents/agents/flux-style-reviewer.md'),
      VALID_REVIEWER_MD.replace('mode: subagent', 'mode: primary'),
      'utf8',
    );
    const wrongMode = verifyAgentConfig(dir);
    assert.equal(wrongMode.ok, false);
    assert.ok(wrongMode.errors.some((e) => e.includes('mode: subagent')));
  });
});

test('缺少 permissions 节或仅在 permissions 结束后出现孤立键值时必须失败', () => {
  withTempWorkspace((dir) => {
    createValidWorkspace(dir);
    fs.writeFileSync(
      path.join(dir, '.agents/agents/flux-code-reviewer.md'),
      `---
mode: subagent
description: 没有 permissions 节
---
`,
      'utf8',
    );
    const noPerms = verifyAgentConfig(dir);
    assert.equal(noPerms.ok, false);
    assert.ok(noPerms.errors.some((e) => e.includes('全局只读约束')));

    // dedent 离开 permissions 节后，后续顶层字段里的伪造行不得混入 permissions
    fs.writeFileSync(
      path.join(dir, '.agents/agents/flux-code-reviewer.md'),
      `---
mode: subagent
permissions:
  - action: subagent
    resource: "*"
    effect: deny
extra:
  - action: edit
    resource: "*"
    effect: deny
---
`,
      'utf8',
    );
    const afterDedent = verifyAgentConfig(dir);
    assert.equal(afterDedent.ok, false);
    assert.ok(afterDedent.errors.some((e) => e.includes('全局只读约束')));
  });
});

test('跨条目错配、行尾注释伪造、局部 resource、以及冲突 edit allow 均必须拦截', () => {
  const bypassCases = [
    [
      '跨条目错配',
      `---
mode: subagent
permissions:
  - action: edit
    resource: "*"
    effect: allow
  - action: subagent
    resource: "*"
    effect: deny
---
`,
    ],
    [
      '行尾注释伪造 deny',
      `---
mode: subagent
permissions:
  - action: edit
    resource: "*"
    effect: allow # effect: deny
---
`,
    ],
    [
      '局部路径 resource 放行',
      `---
mode: subagent
permissions:
  - action: edit
    resource: "README.md"
    effect: deny
---
`,
    ],
    [
      '存在冲突的 edit allow 条目',
      `---
mode: subagent
permissions:
  - action: edit
    resource: "*"
    effect: deny
  - action: edit
    resource: "packages/*"
    effect: allow
---
`,
    ],
  ];

  for (const [label, md] of bypassCases) {
    withTempWorkspace((dir) => {
      createValidWorkspace(dir);
      fs.writeFileSync(path.join(dir, '.agents/agents/flux-code-reviewer.md'), md, 'utf8');
      const res = verifyAgentConfig(dir);
      assert.equal(res.ok, false, `绕过场景「${label}」未被拦截`);
      assert.ok(res.errors.some((e) => e.includes('全局只读约束')));
    });
  }
});

test('任一核心验证技能缺失或 SKILL.md 为空/纯空白时必须失败', () => {
  for (const skill of EXPECTED_SKILLS) {
    withTempWorkspace((dir) => {
      createValidWorkspace(dir);
      fs.rmSync(path.join(dir, `.agents/skills/${skill}/SKILL.md`));
      const missingRes = verifyAgentConfig(dir);
      assert.equal(missingRes.ok, false, `缺失 ${skill} 时必须失败`);
      assert.ok(missingRes.errors.some((e) => e.includes(`${skill}/SKILL.md`)));
    });

    withTempWorkspace((dir) => {
      createValidWorkspace(dir);
      fs.writeFileSync(path.join(dir, `.agents/skills/${skill}/SKILL.md`), '   \n\t \n', 'utf8');
      const emptyRes = verifyAgentConfig(dir);
      assert.equal(emptyRes.ok, false, `空内容 ${skill} 时必须失败`);
      assert.ok(emptyRes.errors.some((e) => e.includes(`${skill}/SKILL.md`)));
    });
  }
});
