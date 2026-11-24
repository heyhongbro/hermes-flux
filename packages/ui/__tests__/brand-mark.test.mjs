/**
 * Hermes Flux 品牌折纸雨燕 React 组件与多场景接入单元测试
 *
 * 【测试什么】
 *   1. `BrandSwiftMark` 与 `renderBrandSwiftHtml` 的三变体 (`icon` / `badge` / `mark`) 与
 *      三动效 (`static` / `glide` / `fly`) 正向渲染、默认参数与自定义属性；
 *   2. 边界与容错防护：脏/空 `idPrefix` 非空回退、`size <= 0`/`NaN` 安全回退、
 *      `className` & `label` HTML 实体转义、`decorative={false}` 默认 label；
 *   3. React 版与 HTML 字符串版 (`renderBrandSwiftHtml`) 全三态严格同构对拍；
 *   4. `ConversationSkeleton`、`ConversationMessageList`、`ConversationStage`、`MiddlePod`、
 *      `SettingsModal (About)` 全分支场景覆盖与变异杀伤力断言；
 *   5. `conversation.css` / `desktop/renderer/styles.css` 隐屏暂停、合成器 `will-change: auto`
 *      释放、唯一 `prefers-reduced-motion` 块、canonical `--border` 槽与冷启动安全区守卫。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { BrandSwiftMark, renderBrandSwiftHtml, BRAND_SPEC } from '../dist/icons/BrandMark.js';
import { ConversationSkeleton } from '../dist/components-react/conversation/ConversationSkeleton.js';
import { ConversationMessageList, ConversationStage } from '../dist/components-react/conversation/index.js';
import { renderConversationCanvas } from '../dist/components/MiddlePod/MiddlePod.js';
import { SettingsModal } from '../dist/components-react/settings/SettingsModal.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../..');

function baseSettingsSnapshot(overrides = {}) {
  return {
    isOpen: true,
    section: 'about',
    theme: 'obsidian-gold',
    locale: 'zh',
    fontPrefs: { uiFont: 'geist-sans', monoFont: 'jetbrains-mono', sizeScale: 'medium' },
    activityVariant: 'cloud',
    conversationWidth: 'wide',
    leftRailLayout: 'dual-rail',
    profiles: { status: 'ready', data: [] },
    bots: [],
    botManagement: {
      status: { status: 'idle', activeBotId: 'default' },
      roster: [],
      activeBotId: 'default',
      activeDetail: undefined,
      availableModels: [],
      activeDraft: undefined,
      wizard: {
        open: false,
        draft: {
          mode: 'blank',
          name: '',
          displayName: '',
          description: '',
          model: '',
          provider: '',
          cloneFrom: '',
          cloneChannels: false,
          mirrorCredentials: false,
        },
        busy: false,
      },
      exitPrompt: null,
      errorBanner: undefined,
      highlightBotId: undefined,
      isBusy: false,
    },
    scopedProfile: 'default',
    providerViews: { status: 'ready', data: [] },
    providerFailures: [],
    subscriptionCatalog: { status: 'ready', data: [] },
    customEndpoints: { status: 'ready', data: [] },
    endpointProfiles: {},
    endpointFailures: [],
    providerAdminBusy: false,
    mcp: { status: 'ready', data: [] },
    skills: { status: 'ready', data: [] },
    gateway: {
      url: 'http://127.0.0.1:9119',
      username: '',
      hasStoredPassword: false,
      profileName: 'default',
      status: 'connected',
      latencyMs: 18,
    },
    appVersion: '0.1.0',
    platform: 'windows',
    busy: false,
    presenceLayout: 'stage',
    ...overrides,
  };
}

const SETTINGS_ACTIONS = {
  onClose() {},
  onSelectSection() {},
  onThemeChange() {},
  onLocaleChange() {},
  onFontPrefsChange() {},
  onActivityVariantChange() {},
  onConversationWidthChange() {},
  onLeftRailLayoutChange() {},
  onPresenceLayoutChange() {},
  onRefreshProviders() {},
  onSaveProviderKey: async () => ({ ok: true }),
  onDisconnectProvider: async () => ({ ok: true }),
  onRefreshProfiles() {},
  onOpenAgent() {},
  onBotDraftChange() {},
  onSelectBotSettle() {},
  onSaveBotConfig: async () => ({ ok: true }),
  onResetBotDraft() {},
  onOpenBotWizard() {},
  onCloseBotWizard() {},
  onBotWizardDraftChange() {},
  onSubmitCreateBot: async () => ({ ok: false }),
  onRetryBotList() {},
  onDismissBotError() {},
  onDismissBotConfirm() {},
  onConfirmBotExit() {},
  onCancelBotExit() {},
  onRegisterBotDirtyGuard() {},
  onRefreshExtensions() {},
  onReloadSkills: async () => ({ ok: true }),
  onTestGateway() {},
  onConnectGateway() {},
  onDisconnectGateway() {},
  onSwitchDefaultAndDisableProvider: async () => ({ ok: true }),
};

function normalizeHtmlForParity(html, idPrefix) {
  return html
    .replace(/\s+/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/<(stop|feDropShadow|rect|polygon)\b([^>]*?)\s*\/>/g, '<$1$2></$1>')
    .replace(new RegExp(idPrefix, 'g'), 'PID')
    .replace(/style="([^"]*)"/g, (_, s) => `style="${s.replace(/:\s+/g, ':').replace(/;\s+/g, ';').replace(/;\s*$/, '').trim()}"`)
    .trim();
}

test('BrandSwiftMark：默认参数与三变体精确分流 (icon 无字 / badge 带 FLUX / mark 无底卡)', () => {
  const defaultHtml = renderToStaticMarkup(React.createElement(BrandSwiftMark));
  assert.ok(defaultHtml.includes('data-brand-variant="mark"'));
  assert.ok(defaultHtml.includes('data-brand-motion="static"'));
  assert.ok(defaultHtml.includes('width:64px;height:64px'));
  assert.ok(defaultHtml.includes('aria-hidden="true"'));
  assert.ok(!defaultHtml.includes('<rect'), 'mark 不得渲染背景卡片');
  assert.ok(!defaultHtml.includes('<text'), 'mark 不得渲染 FLUX 文字');

  const iconHtml = renderToStaticMarkup(
    React.createElement(BrandSwiftMark, { variant: 'icon', size: 48, className: 'shrink-0' }),
  );
  assert.ok(iconHtml.includes('data-brand-variant="icon"'));
  assert.ok(iconHtml.includes('class="flux-brand-swift shrink-0"'));
  assert.ok(iconHtml.includes(`rx="${BRAND_SPEC.squircleRx}"`), 'icon 圆角必须读取 BRAND_SPEC.squircleRx');
  assert.ok(!iconHtml.includes('<text'), 'icon (Variant A) 不得带 FLUX 文字');

  const badgeHtml = renderToStaticMarkup(
    React.createElement(BrandSwiftMark, {
      variant: 'badge',
      motion: 'glide',
      size: 76,
      decorative: false,
      label: 'Hermes Flux Brand',
      idPrefix: 'custom-badge',
    }),
  );
  assert.ok(badgeHtml.includes('data-brand-variant="badge"'));
  assert.ok(badgeHtml.includes('data-brand-motion="glide"'));
  assert.ok(badgeHtml.includes('role="img"'));
  assert.ok(badgeHtml.includes('aria-label="Hermes Flux Brand"'));
  assert.ok(badgeHtml.includes('FLUX</text>'), 'badge (Variant B) 必须包含 FLUX 字标');
  assert.ok(badgeHtml.includes('id="custom-badge-shadow"'), '传入 idPrefix 时必须沿用该前缀');
  assert.ok(!badgeHtml.includes('flux-brand-swift__shadow"'), 'glide 不应渲染飞行地面投影条');

  const staticHtml = renderToStaticMarkup(React.createElement(BrandSwiftMark, { variant: 'mark', motion: 'static' }));
  assert.ok(!staticHtml.includes('flux-brand-swift__shadow'), 'static 不应渲染飞行地面投影条');

  const flyReactHtml = renderToStaticMarkup(React.createElement(BrandSwiftMark, { variant: 'mark', motion: 'fly', size: 72 }));
  assert.ok(flyReactHtml.includes('class="flux-brand-swift__shadow"'), 'React motion="fly" 必须渲染飞行地面投影条');
});

test('BrandSwiftMark 与 renderBrandSwiftHtml：边界输入防御（空/脏 idPrefix、非法 size、实体转义、默认参数与默认 label）', () => {
  // React 分支：全非法字符 idPrefix 回退到非空 useId，非法 size 回落 64px，decorative=false 使用默认 label
  const dirtyReact = renderToStaticMarkup(
    React.createElement(BrandSwiftMark, {
      variant: 'icon',
      idPrefix: '!!!中文###',
      size: -12,
      decorative: false,
    }),
  );
  const shadowMatch = dirtyReact.match(/id="([^"]+-shadow)"/);
  assert.ok(shadowMatch && shadowMatch[1] !== '-shadow', '纯非法 idPrefix 必须回退至非空唯一前缀，禁止产生活塞碰撞 id="-shadow"');
  assert.ok(dirtyReact.includes('width:64px;height:64px'), '负数 size 必须回退至 64px');
  assert.ok(dirtyReact.includes('aria-label="Hermes Flux"'), 'decorative=false 缺省 label 时必须使用 "Hermes Flux"');

  // React 分支：NaN size 兜底
  const nanReact = renderToStaticMarkup(React.createElement(BrandSwiftMark, { size: Number.NaN }));
  assert.ok(nanReact.includes('width:64px;height:64px'));

  // HTML 分支：仅传 idPrefix 时验证默认 variant/motion/size/decorative 行为
  const defaultTplHtml = renderBrandSwiftHtml({ idPrefix: 'html-defaults' });
  assert.ok(defaultTplHtml.includes('data-brand-variant="mark"'), 'renderBrandSwiftHtml 缺省 variant 必须为 mark');
  assert.ok(defaultTplHtml.includes('data-brand-motion="static"'), 'renderBrandSwiftHtml 缺省 motion 必须为 static');
  assert.ok(defaultTplHtml.includes('style="width: 64px; height: 64px;"'), 'renderBrandSwiftHtml 缺省 size 必须为 64px');
  assert.ok(defaultTplHtml.includes('aria-hidden="true"'), 'renderBrandSwiftHtml 缺省 decorative 必须为 aria-hidden="true"');
  assert.ok(!defaultTplHtml.includes('<rect'), 'mark 缺省不得渲染背景卡片');
  assert.ok(!defaultTplHtml.includes('<text'), 'mark 缺省不得渲染 FLUX 文字');
  assert.ok(!defaultTplHtml.includes('flux-brand-swift__shadow'), 'static 缺省不得渲染飞行地面投影条');

  const a11yTplHtml = renderBrandSwiftHtml({ idPrefix: 'html-a11y', decorative: false });
  assert.ok(a11yTplHtml.includes('role="img" aria-label="Hermes Flux"'), 'renderBrandSwiftHtml 在 decorative=false 缺省 label 时必须回退为 "Hermes Flux"');

  // HTML 分支：空/全非法 idPrefix、size=0、motion="fly" 投影条与 className / label XSS 转义
  const dirtyHtml = renderBrandSwiftHtml({
    variant: 'badge',
    motion: 'fly',
    size: 0,
    className: 'cls-"bad"<tag>',
    decorative: false,
    label: 'Flight & <Badge>',
    idPrefix: '   !!!   ',
  });
  assert.ok(dirtyHtml.includes('id="hf-swift-shadow"'), '空或全非法 idPrefix 必须回退为 hf-swift');
  assert.ok(!dirtyHtml.includes('id="-shadow"'), '禁止产生空前缀 id="-shadow"');
  assert.ok(dirtyHtml.includes('width: 64px; height: 64px;'), 'size=0 必须回退 64px');
  assert.ok(dirtyHtml.includes('class="flux-brand-swift__shadow"'), 'HTML motion="fly" 必须渲染飞行地面投影条');
  assert.ok(dirtyHtml.includes('class="flux-brand-swift cls-&quot;bad&quot;&lt;tag&gt;"'), 'className 必须严格执行属性转义');
  assert.ok(dirtyHtml.includes('aria-label="Flight &amp; &lt;Badge&gt;"'), 'label 必须严格执行属性转义');
});

test('BrandSwiftMark 与 renderBrandSwiftHtml：直验 BRAND_SPEC 9 个共线折纸面、6 类语义分组与 3 组动效枢纽点', () => {
  const reactHtml = renderToStaticMarkup(
    React.createElement(BrandSwiftMark, { variant: 'mark', motion: 'fly', size: 64, idPrefix: 'spec-react' }),
  );
  const templateHtml = renderBrandSwiftHtml({ variant: 'mark', motion: 'fly', size: 64, idPrefix: 'spec-html' });

  const expectedParts = [...new Set(BRAND_SPEC.facets.map((f) => f.part))];
  assert.equal(BRAND_SPEC.facets.length, 9, 'BRAND_SPEC 真值表必须精确定义 9 个折纸多边形面');
  assert.equal(expectedParts.length, 6, 'BRAND_SPEC 必须覆盖 6 类语义分部 (body / wing-upper / wing-lower / tail / crest / highlight)');

  for (const [kind, markup] of [
    ['React', reactHtml],
    ['HTML', templateHtml],
  ]) {
    const polyMatches = markup.match(/<polygon\b/g) || [];
    assert.equal(polyMatches.length, BRAND_SPEC.facets.length, `${kind} 输出必须包含精确 9 个 <polygon>`);
    for (const facet of BRAND_SPEC.facets) {
      const pts = facet.points.map(([x, y]) => `${x},${y}`).join(' ');
      assert.ok(markup.includes(`points="${pts}"`), `${kind} 输出缺少切面 ${facet.id} (${pts})`);
    }
    for (const part of expectedParts) {
      assert.ok(markup.includes(`data-part="${part}"`), `${kind} 输出缺少语义分组 data-part="${part}"`);
    }
  }

  for (const pivotKey of ['wingUpper', 'wingLower', 'tail']) {
    const [px, py] = BRAND_SPEC.animationPivots[pivotKey];
    assert.ok(
      reactHtml.includes(`transform-origin:${px}px ${py}px`),
      `React 输出必须绑定 ${pivotKey} 枢纽点 ${px}px ${py}px`,
    );
    assert.ok(
      templateHtml.includes(`transform-origin: ${px}px ${py}px`),
      `HTML 输出必须绑定 ${pivotKey} 枢纽点 ${px}px ${py}px`,
    );
  }
});

test('renderBrandSwiftHtml 与 BrandSwiftMark：全三态 (icon / badge / mark) 与三动效同构对拍', () => {
  for (const variant of ['icon', 'badge', 'mark']) {
    for (const motion of ['static', 'glide', 'fly']) {
      const pid = `parity-${variant}-${motion}`;
      const jsxHtml = normalizeHtmlForParity(
        renderToStaticMarkup(
          React.createElement(BrandSwiftMark, { variant, motion, size: 72, idPrefix: pid }),
        ),
        pid,
      );
      const tplHtml = normalizeHtmlForParity(
        renderBrandSwiftHtml({ variant, motion, size: 72, idPrefix: pid }),
        pid,
      );
      assert.equal(tplHtml, jsxHtml, `变体 ${variant}/${motion} 的 HTML 构建器输出必须与 React 组件严格同构`);
    }
  }

  // 验证多实例无 ID 碰撞
  const twoInstances = renderToStaticMarkup(
    React.createElement(
      React.Fragment,
      null,
      React.createElement(BrandSwiftMark, { variant: 'mark', motion: 'fly', size: 56 }),
      React.createElement(BrandSwiftMark, { variant: 'badge', motion: 'static', size: 72 }),
    ),
  );
  const shadowIds = [...twoInstances.matchAll(/id="([^"]+-shadow)"/g)].map((m) => m[1]);
  assert.equal(shadowIds.length, 2);
  assert.notEqual(shadowIds[0], shadowIds[1]);
});

test('业务场景集成与变异杀伤：全分支覆盖 Conversation / MiddlePod / SettingsModal', () => {
  // 1. 加载骨架：带飞行雨燕且 zero conv-state/文案
  const skeletonHtml = renderToStaticMarkup(React.createElement(ConversationSkeleton));
  assert.ok(skeletonHtml.includes('data-conv-skeleton="true"'));
  assert.ok(skeletonHtml.includes('data-brand-variant="mark"'));
  assert.ok(skeletonHtml.includes('data-brand-motion="fly"'));
  assert.ok(!skeletonHtml.includes('<rect'));
  assert.ok(!skeletonHtml.includes('conv-state'));

  // 2. ConversationMessageList：loading 出飞行骨架，ready 且空出 badge + glide + FLUX
  const loadingListHtml = renderToStaticMarkup(
    React.createElement(ConversationMessageList, {
      snapshot: {
        mode: 'scratchpad',
        connection: 'connected',
        messages: [],
        isStreaming: false,
        messagesPhase: 'loading',
      },
    }),
  );
  assert.ok(loadingListHtml.includes('data-conv-skeleton="true"'));
  assert.ok(loadingListHtml.includes('data-brand-motion="fly"'));
  assert.ok(!loadingListHtml.includes('data-conv-state="empty"'));

  const emptyListHtml = renderToStaticMarkup(
    React.createElement(ConversationMessageList, {
      snapshot: {
        mode: 'scratchpad',
        connection: 'connected',
        messages: [],
        isStreaming: false,
        messagesPhase: 'ready',
      },
    }),
  );
  assert.ok(emptyListHtml.includes('data-conv-state="empty"'));
  assert.ok(emptyListHtml.includes('data-brand-variant="badge"'));
  assert.ok(emptyListHtml.includes('data-brand-motion="glide"'));
  assert.ok(emptyListHtml.includes('FLUX</text>'));

  // 3. ConversationStage 全四态分流
  const stageConnecting = renderToStaticMarkup(
    React.createElement(ConversationStage, {
      snapshot: { mode: 'scratchpad', connection: 'connecting', messages: [], isStreaming: false },
    }),
  );
  assert.ok(stageConnecting.includes('data-brand-variant="mark"'));
  assert.ok(stageConnecting.includes('data-brand-motion="fly"'));
  assert.ok(!stageConnecting.includes('<rect'));

  const stageDisconnected = renderToStaticMarkup(
    React.createElement(ConversationStage, {
      snapshot: { mode: 'scratchpad', connection: 'disconnected', messages: [], isStreaming: false },
    }),
  );
  assert.ok(stageDisconnected.includes('data-brand-variant="badge"'));
  assert.ok(stageDisconnected.includes('data-brand-motion="glide"'));
  assert.ok(stageDisconnected.includes('FLUX</text>'));

  const stageLoading = renderToStaticMarkup(
    React.createElement(ConversationStage, {
      snapshot: {
        mode: 'scratchpad',
        connection: 'connected',
        messages: [],
        isStreaming: false,
        messagesPhase: 'loading',
      },
    }),
  );
  assert.ok(stageLoading.includes('data-conv-skeleton="true"'));
  assert.ok(stageLoading.includes('data-brand-motion="fly"'));

  const stageEmpty = renderToStaticMarkup(
    React.createElement(ConversationStage, {
      snapshot: { mode: 'scratchpad', connection: 'connected', messages: [], isStreaming: false },
    }),
  );
  assert.ok(stageEmpty.includes('data-brand-variant="badge"'));
  assert.ok(stageEmpty.includes('data-brand-motion="glide"'));

  // 4. MiddlePod：严格校验 variant/motion/分支优先级与全 hidden 回落（任一篡改必红）
  const tplLoadingPriority = renderConversationCanvas({
    gatewayConnecting: true,
    messages: [],
    messagesPhase: 'loading',
  });
  assert.ok(tplLoadingPriority.includes('id="react-message-list-host"'), 'loading 相位优先级必须高于 gatewayConnecting');
  assert.ok(!tplLoadingPriority.includes('flux-conn-shadow'));

  const tplConn = renderConversationCanvas({ gatewayConnecting: true, messages: [] });
  assert.ok(tplConn.includes('data-brand-variant="mark"'), 'MiddlePod 连接中必须为无框 mark');
  assert.ok(tplConn.includes('data-brand-motion="fly"'));
  assert.ok(!tplConn.includes('<rect'));
  assert.ok(!tplConn.includes('⚡'));

  const tplOnboard = renderConversationCanvas({ gatewayConnected: false, messages: [] });
  assert.ok(tplOnboard.includes('id="flux-onboard-shadow"'));
  assert.ok(tplOnboard.includes('data-brand-variant="badge"'));
  assert.ok(tplOnboard.includes('data-brand-motion="static"'), '引导卡必须使用 static 静置态');
  assert.ok(tplOnboard.includes('FLUX</text>'));

  const tplWelcome = renderConversationCanvas({ gatewayConnected: true, messages: [], messagesPhase: 'ready' });
  assert.ok(tplWelcome.includes('data-brand-variant="badge"'));
  assert.ok(tplWelcome.includes('data-brand-motion="glide"'));
  assert.ok(tplWelcome.includes('FLUX</text>'));

  const tplAllHidden = renderConversationCanvas({
    gatewayConnected: true,
    messages: [{ id: 'h1', role: 'user', content: 'hidden', displayKind: 'hidden' }],
    messagesPhase: 'ready',
  });
  assert.ok(tplAllHidden.includes('id="flux-welcome-shadow"') && tplAllHidden.includes('data-brand-variant="badge"'));

  // 5. SettingsModal About：标题旁已有 Hermes Flux 字样，故使用 Variant A (icon，无文字)
  const aboutHtml = renderToStaticMarkup(
    React.createElement(SettingsModal, {
      snapshot: baseSettingsSnapshot({ section: 'about' }),
      actions: SETTINGS_ACTIONS,
    }),
  );
  assert.ok(aboutHtml.includes('data-settings-anchor="about-version"'));
  assert.ok(aboutHtml.includes('data-brand-variant="icon"'), '关于页必须渲染 Variant A 图标');
  assert.ok(!aboutHtml.includes('>FLUX</text>'), '关于页旁已有 Hermes Flux 文字，Icon 不得带 FLUX');
});

test('样式表守卫：隐屏暂停 + 合成层释放 (will-change: auto)、唯一 reduced-motion 块与安全区规则', () => {
  const convCss = fs.readFileSync(path.join(REPO_ROOT, 'packages/ui/src/styles/conversation.css'), 'utf8');
  const desktopCss = fs.readFileSync(path.join(REPO_ROOT, 'packages/desktop/src/renderer/styles.css'), 'utf8');

  // 1. 仅存在唯一末尾 reduced-motion 块（确保不破坏 activity-indicator-preference 守卫）
  const reduceIdx = convCss.lastIndexOf('@media (prefers-reduced-motion: reduce)');
  assert.ok(reduceIdx > -1);
  const reduceTail = convCss.slice(reduceIdx);
  assert.ok(reduceTail.includes('.flux-brand-swift[data-brand-motion="fly"] .flux-brand-swift__rotor'));
  assert.ok(reduceTail.includes('will-change: auto;'));

  // 2. 双隐藏属性暂停 + 释放合成层 will-change: auto
  for (const attr of [':root[data-app-hidden="true"]', ':root[data-page-hidden="true"]']) {
    assert.ok(convCss.includes(`${attr} .flux-brand-swift__rotor`), `缺少隐藏态暂停选择器: ${attr}`);
    assert.ok(
      convCss.includes(`${attr} .flux-brand-swift[data-brand-motion="fly"] .flux-brand-swift__rotor`),
      `隐藏态必须释放 .flux-brand-swift__rotor 的 will-change: auto (${attr})`,
    );
  }
  assert.ok(convCss.includes('animation-play-state: paused !important;'));

  // 3. 回退槽位使用 canonical --border，不再引用 legacy --border-medium
  const brandSection = convCss.slice(convCss.indexOf('.flux-brand-swift__shadow'), reduceIdx);
  assert.ok(brandSection.includes('background: var(--border);'), '低版本回退必须使用 --border 规范槽');
  assert.ok(!brandSection.includes('--border-medium'), '品牌样式段禁止新增 legacy --border-medium');

  // 4. 冷启动屏安全区与百分比高度（防 100vh 移动端溢裁）
  const splashIdx = desktopCss.indexOf('.flux-boot-splash {');
  assert.ok(splashIdx > -1);
  const splashRule = desktopCss.slice(splashIdx, desktopCss.indexOf('}', splashIdx) + 1);
  assert.ok(splashRule.includes('min-height: 100%;'));
  assert.ok(!splashRule.includes('min-height: 100vh;'), '.flux-boot-splash 禁止写死 100vh');
  assert.ok(splashRule.includes('env(safe-area-inset-top, 0px)'), '.flux-boot-splash 必须声明 safe-area 内边距避让');
});
