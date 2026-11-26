#!/usr/bin/env node
/**
 * 全平台（Android / iOS / macOS / Windows）发行签名与公证配置诊断工具。
 *
 * 【设计意图 (Why)】
 *   单一真值源复用各端签名探测模块，在本地开发机或 CI 打包前一次性检查四大平台是否已具备
 *   正式签名、Apple 公证（Notarization）与分发备案前置条件，避免“本地没配置却误以为打了正式包”。
 *
 * 【防范的历史坑 (Pitfall)】
 *   1. 各端签名规则散落在 Gradle、Xcode、electron-builder 与 CI 中，缺少统一体检入口；
 *   2. 诊断输出或 JSON 若直接透传原始环境变量，极易泄露口令、`.p8` 私钥或 `.pfx` base64 密文。
 *
 * 【约束与规则 (Rules)】
 *   - 严禁输出任何私钥、口令、Secret 或 base64 证书内容；
 *   - 缺省不传 `--strict` 时只报告状态并退出 0；传入 `--strict` 时只要任一目标平台未达到可发布态即非零退出；
 *   - 未知参数、重复参数或非法 `--platform` 值必须显式拒绝并退出 1。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveAndroidSigningStatus } from '../../packages/mobile/scripts/android-signing-config.mjs';
import { resolveIosSigningStatus } from '../../packages/mobile/scripts/ios-signing-config.mjs';
import {
  resolveMacSigningStatus,
  resolveWindowsSigningStatus,
} from '../../packages/desktop/scripts/desktop-signing-config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '../..');
export const VALID_PLATFORMS = ['all', 'android', 'ios', 'macos', 'windows'];

/**
 * 解析 CLI 参数：`[--platform=all|android|ios|macos|windows] [--strict] [--json]`。
 */
export function parseSigningCheckArgs(argv = process.argv.slice(2)) {
  let platform = null;
  let strict = false;
  let json = false;

  for (const arg of argv) {
    if (arg === '--strict') {
      strict = true;
      continue;
    }
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg.startsWith('--platform=')) {
      if (platform !== null) {
        return { ok: false, error: `参数 --platform 重复出现: ${arg}` };
      }
      const value = arg.slice('--platform='.length).trim().toLowerCase();
      if (!VALID_PLATFORMS.includes(value)) {
        return {
          ok: false,
          error: `未知平台 "${value}"，允许值: ${VALID_PLATFORMS.join(', ')}`,
        };
      }
      platform = value;
      continue;
    }
    return { ok: false, error: `未知参数: ${arg}` };
  }

  return {
    ok: true,
    platform: platform ?? 'all',
    strict,
    json,
  };
}

/**
 * 聚合评估指定平台的签名与公证就绪状态。
 */
export function evaluateAllPlatformsSigning({
  repoRoot = REPO_ROOT,
  env = process.env,
  platform = 'all',
  fileExists = fs.existsSync,
  readFile = fs.readFileSync,
} = {}) {
  const androidDir = path.join(repoRoot, 'packages/mobile/android');
  const iosDir = path.join(repoRoot, 'packages/mobile/ios');

  const targets =
    platform === 'all' ? ['android', 'ios', 'macos', 'windows'] : [platform];

  const platforms = {};
  for (const name of targets) {
    if (name === 'android') {
      const status = resolveAndroidSigningStatus({ androidDir, env });
      platforms.android = {
        ...status,
        releaseReady: status.mode === 'release',
      };
    } else if (name === 'ios') {
      const status = resolveIosSigningStatus({ iosDir, env, fileExists, readFile });
      platforms.ios = {
        ...status,
        releaseReady: status.mode !== 'unsigned',
      };
    } else if (name === 'macos') {
      const status = resolveMacSigningStatus({ env, fileExists });
      platforms.macos = {
        ...status,
        releaseReady: status.mode === 'signed-and-notarized',
      };
    } else if (name === 'windows') {
      const status = resolveWindowsSigningStatus({ env, fileExists });
      platforms.windows = {
        ...status,
        releaseReady: status.mode !== 'unsigned',
      };
    }
  }

  const values = Object.values(platforms);
  const ready = values.filter((item) => item.releaseReady).length;
  const total = values.length;

  return {
    ok: ready === total,
    platform,
    platforms,
    summary: {
      total,
      ready,
      notReady: total - ready,
    },
  };
}

/**
 * 格式化人类可读的四端签名体检报告。
 */
export function formatSigningReport(evaluation) {
  const lines = [
    'Hermes Flux 全平台发行签名与公证检查',
    `  范围: ${evaluation.platform} · 就绪: ${evaluation.summary.ready}/${evaluation.summary.total}`,
    '',
  ];

  const labels = {
    android: 'Android (APK/AAB)',
    ios: 'iOS (IPA / App Store / TestFlight)',
    macos: 'macOS (DMG/ZIP + Notarization)',
    windows: 'Windows (NSIS/Portable Authenticode)',
  };

  for (const [name, info] of Object.entries(evaluation.platforms)) {
    const badge = info.releaseReady ? '[READY]' : '[WARN] ';
    lines.push(`${badge} ${labels[name] ?? name}: mode=${info.mode}`);
    if (info.missingFields && info.missingFields.length > 0) {
      lines.push(`        缺失配置: ${info.missingFields.join(', ')}`);
    }
    if (info.installWarning) {
      lines.push(`        安装行为: ${info.installWarning}`);
    }
  }

  lines.push('');
  lines.push('完整配置与平台备案指引: docs/testing/cross-platform-release-signing.md');
  return lines.join('\n');
}

export function runSigningCheck({
  argv = [],
  env = process.env,
  repoRoot = REPO_ROOT,
  fileExists = fs.existsSync,
  readFile = fs.readFileSync,
} = {}) {
  const req = parseSigningCheckArgs(argv);
  if (!req.ok) {
    return { exitCode: 1, stdout: '', stderr: `✖ ${req.error}\n` };
  }

  const evaluation = evaluateAllPlatformsSigning({
    repoRoot,
    env,
    platform: req.platform,
    fileExists,
    readFile,
  });

  const stdout = req.json
    ? `${JSON.stringify(evaluation, null, 2)}\n`
    : `${formatSigningReport(evaluation)}\n`;

  if (req.strict && !evaluation.ok) {
    return {
      exitCode: 1,
      stdout,
      stderr: '✖ 严格签名检查未通过：存在未配置正式签名/公证的目标平台。\n',
    };
  }

  return { exitCode: 0, stdout, stderr: '' };
}

function main() {
  const res = runSigningCheck({
    argv: process.argv.slice(2),
    env: process.env,
    repoRoot: REPO_ROOT,
  });
  if (res.stdout) process.stdout.write(res.stdout);
  if (res.stderr) process.stderr.write(res.stderr);
  if (res.exitCode !== 0) process.exit(res.exitCode);
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
