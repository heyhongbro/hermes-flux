#!/usr/bin/env node
/**
 * pre-commit 钩子（跨平台分层快速门禁）
 *
 * 设计意图 (Why):
 *   1. 全量 286+ 测试与全量构建交给 PR CI（Ubuntu/Windows 并行）和发版前 `npm run verify`；
 *   2. 本地 `pre-commit` 按暂存区实际改动范围自动分层（docs / tests / scoped），
 *      既守住契约、类型、静态规范与受影响域单测，又避免无改动包重复编译与回归阻塞开发；
 *   3. 如需在本地强行跑完整 10 道全量门禁，可设置环境变量 `PRECOMMIT_FULL=1`。
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  planPreCommitGates,
  readDistReady,
  readStagedFiles,
} from '../scripts/gates/lib/pre-commit-plan.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const C = {
  reset: '\u001b[0m',
  bold: '\u001b[1m',
  dim: '\u001b[2m',
  red: '\u001b[31m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  blue: '\u001b[36m',
};

function banner(text) {
  console.log(`\n${C.blue}▌${C.reset} ${C.bold}${text}${C.reset}`);
}

function run(gate) {
  banner(gate.label);
  const needsShell = process.platform === 'win32' && /\.cmd$/i.test(gate.command);
  const childEnv = { ...process.env };
  delete childEnv.NODE_TEST_CONTEXT;
  const result = spawnSync(gate.command, gate.args, {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    shell: needsShell,
    env: childEnv,
  });
  if (result.error) {
    console.error(`${C.red}✗ ${gate.label} 无法执行: ${result.error.message}${C.reset}`);
    return false;
  }
  return result.status === 0;
}

function main() {
  const gitDir = path.join(REPO_ROOT, '.git');
  const isRebasing = fs.existsSync(path.join(gitDir, 'rebase-merge')) || fs.existsSync(path.join(gitDir, 'rebase-apply'));
  const isMerging = fs.existsSync(path.join(gitDir, 'MERGE_HEAD'));
  if (isRebasing || isMerging) {
    console.log(`${C.dim}检测到正在执行 Git Rebase / Merge，自动放行 pre-commit 门禁${C.reset}`);
    process.exit(0);
  }

  const { stagedFiles, existingFiles } = readStagedFiles(REPO_ROOT);
  const distReady = readDistReady(REPO_ROOT);
  const plan = planPreCommitGates(stagedFiles, {
    existingFiles,
    distReady,
    env: process.env,
    npmCmd: NPM,
  });

  const startedAt = Date.now();
  console.log(`${C.bold}══════════════════════════════════════════════════${C.reset}`);
  console.log(`${C.bold}🛡️  Hermes Flux Gatekeeper · pre-commit [${plan.mode}]${C.reset}`);
  console.log(`${C.dim}   ${plan.summary}（全量回归请用 PRECOMMIT_FULL=1 或 npm run verify）${C.reset}`);
  console.log(`${C.bold}══════════════════════════════════════════════════${C.reset}`);

  if (plan.gates.length === 0) {
    console.log(`${C.dim}无待检门禁，放行${C.reset}`);
    process.exit(0);
  }

  const failures = [];
  for (const gate of plan.gates) {
    if (!run(gate)) failures.push(gate.label);
  }

  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`\n${C.bold}══════════════════════════════════════════════════${C.reset}`);
  if (failures.length > 0) {
    console.log(`${C.red}${C.bold}✗ 提交被拒绝，以下门禁未通过 (${elapsedSec}s)：${C.reset}`);
    for (const f of failures) console.log(`  ${C.red}·${C.reset} ${f}`);
    console.log(`\n${C.yellow}修复后重新提交。禁止使用 --no-verify 绕过。${C.reset}`);
    console.log(`${C.bold}══════════════════════════════════════════════════${C.reset}\n`);
    process.exit(1);
  }

  console.log(`${C.green}${C.bold}✓ [${plan.mode}] 门禁全部通过，允许提交 (${elapsedSec}s)${C.reset}`);
  console.log(`${C.bold}══════════════════════════════════════════════════${C.reset}\n`);
  process.exit(0);
}

try {
  main();
} catch (err) {
  console.error(`${C.red}✗ pre-commit 钩子异常: ${err.message}${C.reset}`);
  process.exit(1);
}
