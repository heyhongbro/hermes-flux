#!/usr/bin/env node
/**
 * 验证通用 `.agents/` 目录下的 Agent 规范与验证技能契约。
 *
 * 【设计意图 (Why)】
 *   审查者若具备文件编辑权限，就会在审查期间“边审边改”，导致审查结论失去独立性；
 *   同时工作区已迁移至工具无关的 `.agents/` 约定，不再绑定单一客户端配置，
 *   因此 Gate 2c 直接在 `.agents/` 规范文档与技能目录上执行确定性不变量检查。
 *
 * 【防范的历史坑 (Pitfall)】
 *   1. 若仅正则匹配 `action: edit` 与 `effect: deny`，可能把第一条 `action: edit`（effect: allow）
 *      与下一条 `action: subagent`（effect: deny）错配成通过；必须按同级 `- ` 条目逐块检查。
 *   2. 仅忽略整行 `#` 注释时，行尾内联注释（如 `effect: allow # effect: deny`）可绕过检查；
 *      必须先剥离引号外的内联注释，并按锚定 `key: value` 解析。
 *   3. 局部路径豁免（`resource: "README.md"`）或同文件中另有 `action: edit / effect: allow`
 *      均不构成只读保证；必须要求 `resource: "*"` 且禁止任何冲突的 edit allow 条目。
 *   4. 仅校验文件夹存在而不检查 `SKILL.md` 非空，在空目录或空文件时会静默假绿。
 *
 * 【约束与规则 (Rules)】
 *   1. 不绑定任何特定 AI 客户端配置文件，只校验 `.agents/` 通用资产；
 *   2. `flux-style-reviewer` 与 `flux-code-reviewer` 必须存在于 `.agents/agents/*.md`、
 *      拥有 YAML frontmatter、声明 `mode: subagent`、且在 `permissions` 中包含
 *      `action: edit` + `resource: "*"` + `effect: deny`（同时无冲突的非 deny `edit` 条目）；
 *   3. 三个核心验证技能（`verify-hermes-flux`、`verify-formal-invariants`、`verify-cache-invariants`）
 *      必须具备非空 `SKILL.md`。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '../..');

export const REQUIRED_REVIEWERS = ['flux-style-reviewer', 'flux-code-reviewer'];
export const REQUIRED_SKILLS = [
  'verify-hermes-flux',
  'verify-formal-invariants',
  'verify-cache-invariants',
];

/**
 * 剥离 YAML 行内位于引号外的 `#` 注释（YAML 要求 `#` 在行首或前接空白）。
 * @param {string} line
 * @returns {string}
 */
export function stripInlineComment(line) {
  let quote = '';
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote === '"') {
      if (ch === '\\') {
        i += 1;
        continue;
      }
      if (ch === '"') quote = '';
      continue;
    }
    if (quote === "'") {
      if (ch === "'" && line[i + 1] === "'") {
        i += 1;
        continue;
      }
      if (ch === "'") quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i);
    }
  }
  return line;
}

/**
 * 去除 YAML 标量首尾空白与成对引号。
 * @param {string} raw
 * @returns {string}
 */
export function unquoteYamlScalar(raw) {
  const trimmed = raw.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  return trimmed;
}

/**
 * 解析 frontmatter 顶层标量键的值；未找到时返回 null。
 * @param {string} frontmatter
 * @param {string} key
 * @returns {string|null}
 */
export function parseTopLevelScalar(frontmatter, key) {
  const re = new RegExp(`^${key}:\\s*(.*)$`);
  for (const rawLine of frontmatter.split(/\r?\n/)) {
    const clean = stripInlineComment(rawLine);
    if (clean.trim() === '') continue;
    const m = re.exec(clean);
    if (m) return unquoteYamlScalar(m[1]);
  }
  return null;
}

/**
 * 提取 Markdown 顶部的 YAML frontmatter 文本；缺失则返回 null。
 * @param {string} source
 * @returns {string|null}
 */
export function extractFrontmatter(source) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source);
  return match ? match[1] : null;
}

/**
 * 判断 frontmatter 的 permissions 列表中是否真正强制全局只读：
 * 1. 存在至少一条同块条目同时满足 `action: edit`、`resource: "*"`、`effect: deny`；
 * 2. 不存在任何 `action: edit` 且 `effect !== 'deny'` 的冲突放行条目。
 *
 * @param {string} frontmatter
 * @returns {boolean}
 */
export function hasReadOnlyEditDeny(frontmatter) {
  const lines = frontmatter.split(/\r?\n/);
  let inPermissions = false;
  let permIndent = -1;
  let itemIndent = -1;
  let currentBlock = null;
  const blocks = [];

  const flushBlock = () => {
    if (currentBlock !== null) {
      blocks.push(currentBlock);
      currentBlock = null;
    }
  };

  for (const rawLine of lines) {
    const clean = stripInlineComment(rawLine);
    if (clean.trim() === '') continue;

    const indent = clean.length - clean.trimStart().length;

    if (!inPermissions) {
      if (/^\s*permissions:\s*$/.test(clean)) {
        inPermissions = true;
        permIndent = indent;
        itemIndent = -1;
      }
      continue;
    }

    const isListDash = /^\s*-(?:\s|$)/.test(clean);
    if (indent < permIndent || (indent === permIndent && !isListDash)) {
      flushBlock();
      inPermissions = false;
      continue;
    }

    if (isListDash) {
      if (itemIndent === -1) itemIndent = indent;
      if (indent < itemIndent) {
        flushBlock();
        inPermissions = false;
        continue;
      }
      if (indent === itemIndent) {
        flushBlock();
        currentBlock = [];
        const restRaw = clean.slice(indent + 1);
        const restTrim = restRaw.trimStart();
        if (restTrim !== '') {
          const keyIndent = indent + 1 + (restRaw.length - restTrim.length);
          currentBlock.push({ indent: keyIndent, text: restTrim.trimEnd() });
        }
        continue;
      }
    }

    if (currentBlock !== null) {
      currentBlock.push({ indent, text: clean.trim() });
    }
  }
  flushBlock();

  const parsedBlocks = blocks.map((entryLines) => {
    const fields = Object.create(null);
    let blockKeyIndent = -1;
    for (const item of entryLines) {
      const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(item.text);
      if (!kv) continue;
      if (blockKeyIndent === -1) blockKeyIndent = item.indent;
      if (item.indent !== blockKeyIndent) continue;
      fields[kv[1]] = unquoteYamlScalar(kv[2]);
    }
    return fields;
  });

  const hasConflictingEdit = parsedBlocks.some(
    (b) => b.action === 'edit' && b.effect !== 'deny',
  );
  if (hasConflictingEdit) return false;

  return parsedBlocks.some(
    (b) => b.action === 'edit' && b.resource === '*' && b.effect === 'deny',
  );
}

/**
 * 校验指定仓库根目录下的 `.agents/` 规范与技能契约。
 *
 * @param {string} [repoRoot]
 * @returns {{ ok: boolean, errors: string[], reviewers: string[], skills: string[] }}
 */
export function verifyAgentConfig(repoRoot = REPO_ROOT) {
  const errors = [];
  const verifiedReviewers = [];
  const verifiedSkills = [];

  const agentsDir = path.join(repoRoot, '.agents');
  if (!fs.existsSync(agentsDir)) {
    errors.push('缺少通用 Agent 目录: .agents/');
    return { ok: false, errors, reviewers: verifiedReviewers, skills: verifiedSkills };
  }

  for (const reviewer of REQUIRED_REVIEWERS) {
    const relPath = `.agents/agents/${reviewer}.md`;
    const absPath = path.join(repoRoot, relPath);
    if (!fs.existsSync(absPath)) {
      errors.push(`缺少审查 Agent 规范: ${relPath}`);
      continue;
    }

    const content = fs.readFileSync(absPath, 'utf8');
    const fm = extractFrontmatter(content);
    if (!fm) {
      errors.push(`${relPath} 缺少 YAML frontmatter`);
      continue;
    }

    if (parseTopLevelScalar(fm, 'mode') !== 'subagent') {
      errors.push(`${relPath} 的 frontmatter 必须声明 mode: subagent`);
      continue;
    }

    if (!hasReadOnlyEditDeny(fm)) {
      errors.push(`${relPath} 的 frontmatter 必须配置全局只读约束 (action: edit / resource: "*" / effect: deny)`);
      continue;
    }

    verifiedReviewers.push(reviewer);
  }

  for (const skill of REQUIRED_SKILLS) {
    const relPath = `.agents/skills/${skill}/SKILL.md`;
    const absPath = path.join(repoRoot, relPath);
    if (!fs.existsSync(absPath)) {
      errors.push(`缺少核心验证技能说明: ${relPath}`);
      continue;
    }
    const content = fs.readFileSync(absPath, 'utf8').trim();
    if (!content) {
      errors.push(`验证技能说明为空: ${relPath}`);
      continue;
    }
    verifiedSkills.push(skill);
  }

  return {
    ok: errors.length === 0,
    errors,
    reviewers: verifiedReviewers,
    skills: verifiedSkills,
  };
}

function main() {
  const result = verifyAgentConfig(REPO_ROOT);
  if (!result.ok) {
    console.error('✖ .agents/ 配置与只读审查契约校验失败：');
    for (const err of result.errors) {
      console.error(`  - ${err}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log('✓ .agents/ 通用 Agent 规范校验通过');
  console.log(`  只读审查者 (${result.reviewers.length}): ${result.reviewers.join(', ')}`);
  console.log(`  验证技能 (${result.skills.length}): ${result.skills.join(', ')}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main();
}
