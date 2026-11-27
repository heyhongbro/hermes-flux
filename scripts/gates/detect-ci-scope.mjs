#!/usr/bin/env node
/**
 * CI 变更范围分级探针（docs-only 快速通道分流器）
 *
 * 【设计意图 (Why)】
 *   纯文档 / 开源声明 / 示例模板 PR（如只改 README、LICENSE、docs/*.md）无需拉起
 *   Windows Runner 与全量 286+ 测试及 Stryker 变异回归，在保证合规与门禁前提下节省 CI 等待。
 *   任何源码、单测、构建配置、脚本或 workflow 本身改动一律安全落回 `full` 全量矩阵。
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '../..');

export function isDocsOnlyPath(rel) {
  const p = String(rel || '').replace(/\\/g, '/').trim();
  if (!p) return false;
  if (/^README(?:\.[A-Za-z0-9-]+)?\.md$/.test(p)) return true;
  if (p === 'AGENTS.md' || p === 'LICENSE' || p === '.env.example') return true;
  if (/^packages\/mobile\/.*\.example$/.test(p)) return true;
  if (/^docs\/.*\.md$/.test(p)) return true;
  if (p === 'docs/invariants.json') return true;
  return false;
}

/**
 * 纯函数：判断 CI 运行范围应当为 `'docs'`（纯文档快速检查）还是 `'full'`（全量矩阵）。
 */
export function classifyCiScope(changedFiles = [], { eventName = 'pull_request' } = {}) {
  if (eventName !== 'pull_request') return 'full';
  if (!Array.isArray(changedFiles) || changedFiles.length === 0) return 'full';
  return changedFiles.every(isDocsOnlyPath) ? 'docs' : 'full';
}

function main() {
  const eventName = process.env.GITHUB_EVENT_NAME || '';
  const baseRefRaw = (process.env.GITHUB_BASE_REF || '').trim();
  let scope = 'full';
  let reason = `event=${eventName || 'local'}`;

  if (eventName === 'pull_request' && baseRefRaw) {
    const baseRef = baseRefRaw.startsWith('origin/') ? baseRefRaw : `origin/${baseRefRaw}`;
    try {
      const out = execFileSync('git', ['diff', '--name-only', `${baseRef}...HEAD`], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
      });
      const files = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      scope = classifyCiScope(files, { eventName });
      reason = `${files.length} changed file(s) vs ${baseRef}`;
    // gate-degrade: 若 CI 获取 PR diff 失败，必须安全退回到 full 全量门禁，禁止静默降级跳过检验
    } catch (err) {
      scope = 'full';
      reason = `git diff failed (${err.message}); defaulting to full`;
    }
  }

  const outputPath = (process.env.GITHUB_OUTPUT || '').trim();
  if (outputPath) {
    fs.appendFileSync(outputPath, `scope=${scope}\n`, 'utf8');
  }
  console.log(`[ci-scope] scope=${scope} (${reason})`);
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
