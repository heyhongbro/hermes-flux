import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const mobileRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(mobileRoot, '../..');
const rendererDist = path.join(repoRoot, 'packages/desktop/dist/renderer');
const mobileDist = path.join(mobileRoot, 'dist');
const bridgeSrc = path.join(mobileRoot, 'src/capacitor-bridge.ts');

console.log('[Hermes Flux Mobile Assets Preparer]');
console.log(`  Source: ${rendererDist}`);
console.log(`  Target: ${mobileDist}`);

if (!fs.existsSync(rendererDist)) {
  console.error('Error: packages/desktop/dist/renderer does not exist! Run npm run build first.');
  process.exit(1);
}

// 1. Clean & recreate mobile dist
fs.rmSync(mobileDist, { recursive: true, force: true });
fs.mkdirSync(mobileDist, { recursive: true });

// 2. Copy desktop renderer bundle
fs.cpSync(rendererDist, mobileDist, { recursive: true });
console.log('  ✔ Desktop renderer assets mirrored.');

// 3. Compile capacitor-bridge.ts with esbuild (IIFE for WebView, ESM + sourcemap for Node unit tests & coverage)
console.log('  Compiling mobile platform bridge...');
const bridgeOut = path.join(mobileDist, 'capacitor-bridge.js');
const bridgeEsmOut = path.join(mobileDist, 'capacitor-bridge.mjs');

await build({
  entryPoints: [bridgeSrc],
  bundle: true,
  format: 'iife',
  outfile: bridgeOut,
  platform: 'browser',
  target: 'es2022',
  minify: false,
  sourcemap: true,
  // 外部依赖全部由 Capacitor 插件 node_modules 接入内联
  nodePaths: [path.join(mobileRoot, 'node_modules'), path.join(repoRoot, 'node_modules')],
});
await build({
  entryPoints: [bridgeSrc],
  bundle: true,
  format: 'esm',
  outfile: bridgeEsmOut,
  platform: 'node',
  target: 'node20',
  external: ['@capacitor/*'],
  minify: false,
  sourcemap: true,
});
console.log('  ✔ capacitor-bridge.js & capacitor-bridge.mjs compiled successfully.');

// 4. Inject capacitor-bridge.js into index.html before existing index.js & guarantee viewport-fit=cover
const htmlPath = path.join(mobileDist, 'index.html');
if (fs.existsSync(htmlPath)) {
  let html = fs.readFileSync(htmlPath, 'utf8');
  if (!html.includes('viewport-fit=cover')) {
    html = html.replace(
      /(<meta\s+name=["']viewport["']\s+content=["'][^"']*)/i,
      '$1, viewport-fit=cover'
    );
  }
  if (!html.includes('capacitor-bridge.js')) {
    html = html.replace(
      /<head>/i,
      `<head>\n    <!-- Mobile Platform Bridge Injected -->\n    <script src="capacitor-bridge.js"></script>`
    );
  }
  fs.writeFileSync(htmlPath, html, 'utf8');
  console.log('  ✔ capacitor-bridge.js & viewport-fit=cover reinforced in index.html.');
}

// 5. Append mobile-specific responsive & safe-area fallback styles into styles.css
const cssPath = path.join(mobileDist, 'styles.css');
if (fs.existsSync(cssPath)) {
  const mobileCss = `
/* ==========================================================================
   Hermes Flux Mobile Specific Geometry & Safe-Area Adjustments
   ========================================================================== */
:root {
  --keyboard-height: 0px;
}

/* 彻底剥离桌面窗口控制按键，确保移动 WebView 永不渲染 Windows 窗控 */
.win-cap-btn,
.flux-titlebar-controls,
.titlebar-controls,
.window-controls,
#btn-win-min,
#btn-win-max,
#btn-win-close {
  display: none !important;
}

@media (max-width: 768px) {
  /* 沉浸式标题栏安全区避让 (与桌面端 --geo-titlebar 同源) */
  .flux-titlebar,
  header.titlebar,
  #flux-titlebar {
    padding-top: env(safe-area-inset-top, 0px) !important;
    height: calc(var(--geo-titlebar, 32px) + 1px + env(safe-area-inset-top, 0px)) !important;
  }

  .input-dock-container,
  .composer-dock,
  #flux-input-dock {
    bottom: calc(max(env(safe-area-inset-bottom, 8px), var(--keyboard-height, 0px)) + 8px) !important;
    transition: bottom 0.2s cubic-bezier(0.16, 1, 0.3, 1);
  }

  #conversation-stream:not(.m-stage__stream),
  .conversation-stream:not(.m-stage__stream),
  .middle-pod:not(.m-stage) {
    width: 100vw !important;
    max-width: 100vw !important;
    padding-bottom: calc(180px + var(--keyboard-height, 0px)) !important;
  }
}
`;
  fs.appendFileSync(cssPath, mobileCss, 'utf8');
  console.log('  ✔ Mobile safe-area styles appended.');
}

console.log('✔ Mobile assets prepared and reinforced successfully.');
