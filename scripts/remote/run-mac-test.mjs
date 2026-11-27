/**
 * Hermes Flux Remote macOS Automation Runner
 * 
 * 【设计意图 (Why)】
 *   将局域网内的 macOS 机器作为无头测试节点（Headless Mac Runner），
 *   在当前开发机上一键触发远程构建、原生 Electron 拉起、真实 CDP 断言并回传物理渲染截图。
 * 
 * 【安全与环境隔离规则 (Rules)】
 *   - 绝不硬编码任何主机名、IP、用户名或凭据；
 *   - 严格读取 .env 中的 MAC_RUNNER_SSH 与 MAC_RUNNER_WORKSPACE；
 *   - 环境变量缺失时显式提示并安全退出（Failure Is Not Empty）。
 */

import { execSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

// 优先通过 Node 原生机制加载 .env
if (fs.existsSync('.env')) {
  try {
    const envContent = fs.readFileSync('.env', 'utf8');
    for (const line of envContent.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx > 0) {
        const key = trimmed.slice(0, eqIdx).trim();
        const val = trimmed.slice(eqIdx + 1).trim();
        if (!process.env[key]) process.env[key] = val;
      }
    }
  } catch {}
}

const MAC_HOST = process.env.MAC_RUNNER_SSH;
const REMOTE_DIR = process.env.MAC_RUNNER_WORKSPACE || '~/workspace/hermes-flux';
const LOCAL_SCREENSHOT = path.resolve('artifacts/mac-electron-live.png');
const LOCAL_COLLAPSED = path.resolve('artifacts/mac-electron-collapsed-rail.png');

console.log('[Hermes Flux Remote macOS Automation Runner]');

if (!MAC_HOST) {
  console.error('\n✖ 错误: 未配置 MAC_RUNNER_SSH 环境变量。');
  console.error('  请在项目根目录的 .env 文件中配置：');
  console.error('    MAC_RUNNER_SSH=username@ip');
  console.error('    MAC_RUNNER_WORKSPACE=~/workspace/hermes-flux');
  console.error('  详情请参考 .env.example\n');
  process.exit(1);
}

console.log(`  Target Node: ${MAC_HOST}`);
console.log(`  Remote Workspace: ${REMOTE_DIR}`);

fs.mkdirSync(path.dirname(LOCAL_SCREENSHOT), { recursive: true });

try {
  // 1. 同步测试脚本至远程 Mac
  console.log('  1. Syncing verification script to Mac...');
  execSync(`scp scripts/verify/verify-mac-electron.mjs ${MAC_HOST}:${REMOTE_DIR}/scripts/verify/verify-mac-electron.mjs`, {
    stdio: 'inherit'
  });

  // 2. 在 Mac 上拉取最新代码、执行构建与原生 E2E 测试
  console.log('  2. Pulling latest code and executing native macOS Electron test on remote host...');
  execSync(`ssh ${MAC_HOST} "cd ${REMOTE_DIR} && git pull origin dev/v0.1 && npm run build && node scripts/verify/verify-mac-electron.mjs"`, {
    stdio: 'inherit'
  });

  // 3. 将物理截图回传至本地
  console.log('  3. Fetching captured screenshots from Mac...');
  execSync(`scp ${MAC_HOST}:${REMOTE_DIR}/packages/desktop/release/mac-electron-live.png "${LOCAL_SCREENSHOT}"`, {
    stdio: 'inherit'
  });
  execSync(`scp ${MAC_HOST}:${REMOTE_DIR}/packages/desktop/release/mac-electron-collapsed-rail.png "${LOCAL_COLLAPSED}"`, {
    stdio: 'inherit'
  });

  const sizeKb = (fs.statSync(LOCAL_SCREENSHOT).size / 1024).toFixed(1);
  const sizeColKb = (fs.statSync(LOCAL_COLLAPSED).size / 1024).toFixed(1);
  console.log('\n======================================================');
  console.log('✔ Remote macOS Automation Finished Successfully!');
  console.log(`  Expanded Screenshot: ${LOCAL_SCREENSHOT} (${sizeKb} KB)`);
  console.log(`  Collapsed Screenshot: ${LOCAL_COLLAPSED} (${sizeColKb} KB)`);
  console.log('======================================================\n');
} catch (err) {
  console.error('\n✖ Remote macOS verification failed:', err.message);
  process.exit(1);
}
