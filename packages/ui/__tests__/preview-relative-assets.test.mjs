/**
 * Markdown 相对路径资源/链接渲染、InspectionPod 与移动端阅读器预览单测
 * (packages/ui/__tests__/preview-relative-assets.test.mjs)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { renderMarkdownCore } from '../dist/lib/markdown.js';
import { renderInspectorFileContent } from '../dist/lib/inspectorViewHelpers.js';
import { renderInspectionPod } from '../dist/components/InspectionPod/InspectionPod.js';
import { MobileInspectorScreen } from '../dist/components-react/mobile/MobileInspectorScreen.js';
import { MarkdownBlock } from '../dist/components-react/conversation/MarkdownBlock.js';
import { MediaLightbox } from '../dist/components-react/conversation/MediaLightbox.js';
import { getLocale, setLocale, t } from '../dist/i18n/index.js';
import {
  handleMarkdownPreviewClick,
  hydrateMarkdownPreviewAssets,
} from '../dist/lib/markdownDomHydrator.js';

function createLocalReactDriver(defaultHostRef = null) {
  const slots = new Map();
  let pendingEffects = [];
  function resolve(node, key = 'root') {
    if (node == null || typeof node === 'boolean' || typeof node === 'string' || typeof node === 'number') return node;
    if (Array.isArray(node)) return node.map((item, idx) => resolve(item, `${key}[${idx}]`));
    if (typeof node !== 'object') return node;
    const elType = node.type;
    if (typeof elType === 'symbol') {
      return { ...node, props: { ...node.props, children: resolve(node.props?.children, `${key}.f`) } };
    }
    const innerType =
      elType && typeof elType === 'object' && elType.$$typeof === Symbol.for('react.memo') ? elType.type : elType;
    const compFn = typeof innerType === 'function' ? innerType : null;
    if (compFn) {
      const scopedKey = node.key != null ? `${key}#${String(node.key)}` : key;
      let slot = slots.get(scopedKey);
      if (!slot) {
        slot = { states: [], refs: [], memos: [], effects: [] };
        slots.set(scopedKey, slot);
      }
      let sIdx = 0;
      let rIdx = 0;
      let mIdx = 0;
      let eIdx = 0;
      const internals = React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
      const prevH = internals.H;
      const scheduleEffect = (fn, deps) => {
        const idx = eIdx++;
        if (idx >= slot.effects.length) slot.effects.push({ deps, cleanup: undefined, hasRun: false });
        const entry = slot.effects[idx];
        const changed =
          !entry.hasRun || !deps || !entry.deps || deps.length !== entry.deps.length || deps.some((d, i) => !Object.is(d, entry.deps[i]));
        if (changed) {
          pendingEffects.push(() => {
            if (typeof entry.cleanup === 'function') entry.cleanup();
            entry.cleanup = undefined;
            entry.deps = deps;
            entry.hasRun = true;
            const cleanup = fn();
            if (typeof cleanup === 'function') entry.cleanup = cleanup;
          });
        }
      };
      internals.H = {
        useState(init) {
          const idx = sIdx++;
          if (idx >= slot.states.length) slot.states.push(typeof init === 'function' ? init() : init);
          const setter = (next) => {
            slot.states[idx] = typeof next === 'function' ? next(slot.states[idx]) : next;
          };
          return [slot.states[idx], setter];
        },
        useReducer(r, arg, init) {
          return this.useState(init ? init(arg) : arg);
        },
        useImperativeHandle() {},
        useTransition() {
          return [false, (fn) => fn()];
        },
        useDeferredValue: (v) => v,
        use: (u) => u?._currentValue,
        useRef(init) {
          const idx = rIdx++;
          if (idx >= slot.refs.length) slot.refs.push({ current: init });
          return slot.refs[idx];
        },
        useMemo(factory, deps) {
          const idx = mIdx++;
          if (idx >= slot.memos.length) slot.memos.push({ value: factory(), deps });
          else {
            const prev = slot.memos[idx];
            if (!deps || !prev.deps || deps.some((d, i) => !Object.is(d, prev.deps[i]))) {
              slot.memos[idx] = { value: factory(), deps };
            }
          }
          return slot.memos[idx].value;
        },
        useCallback: (cb) => cb,
        useEffect: scheduleEffect,
        useLayoutEffect: scheduleEffect,
        useInsertionEffect: scheduleEffect,
        useDebugValue() {},
        useId: () => `id-${scopedKey}`,
        useContext: (ctx) => ctx?._currentValue,
      };
      let out;
      try {
        out = resolve(compFn(node.props), scopedKey);
      } finally {
        internals.H = prevH;
      }
      return out;
    }
    if (typeof elType === 'string' && node.props?.ref && typeof node.props.ref === 'object') {
      node.props.ref.current = defaultHostRef ?? { isConnected: true, querySelectorAll: () => [] };
    }
    return { ...node, props: { ...node.props, children: resolve(node.props?.children, key) } };
  }
  const flush = () => {
    const queue = pendingEffects.splice(0);
    for (const run of queue) run();
  };
  let lastRenderFn = null;
  let tree = null;
  return {
    mount(renderFn) {
      lastRenderFn = renderFn;
      tree = resolve(renderFn());
      flush();
      return { tree };
    },
    rerender() {
      tree = resolve(lastRenderFn());
      flush();
      return tree;
    },
    unmount() {
      for (const s of slots.values()) {
        for (const e of s.effects) {
          if (typeof e.cleanup === 'function') e.cleanup();
        }
      }
    },
    findAll(node, pred, acc = []) {
      if (!node || typeof node !== 'object') return acc;
      if (pred(node)) acc.push(node);
      const kids = node.props?.children;
      if (Array.isArray(kids)) kids.forEach((k) => this.findAll(k, pred, acc));
      else if (kids) this.findAll(kids, pred, acc);
      return acc;
    },
  };
}

test('renderMarkdownCore: 开启 documentBasePath 后解析相对/根相对图片/视频/HTML媒体/文档链接/页内锚点并阻断越界', () => {
  const md = [
    '# Overview',
    '',
    '[Jump to section](#overview)',
    '[Next Guide](../guide/next.md)',
    '[Guide Bare](guide/intro.md)',
    '[Secret Leak](../../../.env)',
    '[CDN Site](https://example.com/docs)',
    '',
    '![Diagram](./assets/diagram.png)',
    '![Demo Video](./media/clip.mp4)',
    '![Blocked](../../.env.production)',
    '![CDN Img](https://cdn.example.com/pic.png)',
    '',
    '<img src="./assets/banner.png" srcset="./assets/banner.png 1x, ./assets/banner@2x.png 2x" alt="banner">',
    '<video poster="./assets/poster.jpg"><source src="./media/movie.mp4" type="video/mp4"></video>',
    '<audio controls src="./media/voice.mp3"></audio>',
    '<a href="./sibling.md">Raw Html Link</a>',
    '<a href="javascript:alert(1)">XSS</a>',
  ].join('\n');

  const firstHtml = renderMarkdownCore(md, {
    documentBasePath: '/repo/docs/index.md',
    workspaceRoot: '/repo',
  });

  assert.ok(firstHtml.includes('data-preview-anchor="overview"'), '页内锚点必须走 data-preview-anchor 且不带 target=_blank');
  assert.ok(firstHtml.includes('data-preview-file="/repo/guide/next.md"'), '相对 Markdown 文档链接必须解析为规范化工作区路径');
  assert.ok(firstHtml.includes('data-preview-file="/repo/docs/guide/intro.md"'), '裸相对文档路径在预览态下必须可点');
  assert.ok(firstHtml.includes('md-asset-blocked'), '越权 .env 链接与图片必须降级为拦截态');
  assert.ok(firstHtml.includes('data-preview-url="https://example.com/docs"'), '外链文档保持直连');
  assert.ok(firstHtml.includes('data-preview-asset-path="/repo/docs/assets/diagram.png"'), '相对图片必须产出待水合占位属性');
  assert.ok(firstHtml.includes('md-inline-image--pending'), '未水合图片带 pending 类且不发起 host 404 请求');
  assert.ok(firstHtml.includes('<video'), '相对视频应渲染为 <video>');
  assert.ok(firstHtml.includes('data-preview-asset-path="/repo/docs/media/clip.mp4"'));
  assert.ok(firstHtml.includes('src="https://cdn.example.com/pic.png"'), '外链 CDN 图片必须直连');
  assert.ok(firstHtml.includes('data-preview-srcset-paths="/repo/docs/assets/banner.png|1x,/repo/docs/assets/banner@2x.png|2x"'));
  assert.ok(firstHtml.includes('data-preview-poster-path="/repo/docs/assets/poster.jpg"'));
  assert.ok(firstHtml.includes('<audio'), '内嵌 HTML <audio> 必须保留');
  assert.ok(firstHtml.includes('data-preview-file="/repo/docs/sibling.md"'), '原始 HTML <a> 相对链接必须支持文档导航');
  assert.ok(!firstHtml.includes('javascript:alert(1)'), 'javascript: 协议必须彻底剥离');

  // 预解析 URL 命中时缓存键必须隔离并同步注入 src / srcset / media-src
  const hydratedHtml = renderMarkdownCore(md, {
    documentBasePath: '/repo/docs/index.md',
    workspaceRoot: '/repo',
    resolvedAssetUrls: {
      '/repo/docs/assets/diagram.png': 'data:image/png;base64,RElBRw==',
      '/repo/docs/assets/banner.png': 'data:image/png;base64,QjE=',
      '/repo/docs/assets/banner@2x.png': 'data:image/png;base64,QjI=',
      '/repo/docs/media/voice.mp3': 'hermes-preview://tok1.preview/docs/media/voice.mp3',
    },
  });

  assert.notEqual(hydratedHtml, firstHtml, 'resolvedAssetUrls 变化不得命中旧渲染缓存');
  assert.ok(hydratedHtml.includes('src="data:image/png;base64,RElBRw=="'));
  assert.ok(hydratedHtml.includes('srcset="data:image/png;base64,QjE= 1x, data:image/png;base64,QjI= 2x"'));
  assert.ok(hydratedHtml.includes('src="hermes-preview://tok1.preview/docs/media/voice.mp3"'));

  // 普通会话气泡（不传 documentBasePath）保持未读写相对路径不可点击的历史契约
  const chatHtml = renderMarkdownCore('Look [foo](./other.md) and ![img](./a.png)');
  assert.ok(!chatHtml.includes('data-preview-asset-path'));
  assert.ok(!chatHtml.includes('data-preview-file'));
});

test('renderInspectorFileContent & InspectionPod: HTML Tier 1/Tier 2 严格保持 sandbox="allow-scripts" 且源码非破坏', () => {
  const rawHtmlDoc = '<html><body><img src="./pic.png"></body></html>';

  // Tier 1: frameUrl 存在时必须用 src（不含 srcdoc），且 sandbox 不含 allow-same-origin
  const tier1Html = renderInspectorFileContent(
    {
      path: '/repo/docs/demo.html',
      content: rawHtmlDoc,
      preview: {
        frameUrl: 'hermes-preview://abc123.preview/docs/demo.html',
        inlinedHtml: '<html><body><img src="data:image/png;base64,AA=="></body></html>',
      },
    },
    { viewMode: 'rendered', showLineNumbers: false, wordWrap: true, searchQuery: '' },
  );
  assert.ok(tier1Html.includes('src="hermes-preview://abc123.preview/docs/demo.html"'));
  assert.equal(tier1Html.includes('srcdoc='), false, 'Tier 1 存在 frameUrl 时不得同时输出 srcdoc');
  assert.ok(tier1Html.includes('sandbox="allow-scripts"'));
  assert.equal(tier1Html.includes('allow-same-origin'), false);

  // Tier 2: 无 frameUrl 时使用派生 inlinedHtml，Raw 视图仍显示原始源码
  const fileWithTier2 = {
    path: '/repo/docs/demo.html',
    content: rawHtmlDoc,
    preview: {
      inlinedHtml: '<html><body><img src="data:image/png;base64,AA=="></body></html>',
    },
  };
  const tier2Rendered = renderInspectorFileContent(fileWithTier2, {
    viewMode: 'rendered',
    showLineNumbers: false,
    wordWrap: true,
    searchQuery: '',
  });
  assert.ok(tier2Rendered.includes('data:image/png;base64,AA=='));
  const rawView = renderInspectorFileContent(fileWithTier2, {
    viewMode: 'raw',
    showLineNumbers: true,
    wordWrap: false,
    searchQuery: '',
  });
  assert.ok(rawView.includes('./pic.png'), 'Raw 视图必须 100% 展示原始相对路径源码');

  // SVG 原始 XML 文本默认渲染为图像，切换 Raw 可见 XML 源码，若有 inlinedImageUrl 优先展示
  const svgFile = {
    path: '/repo/logo.svg',
    content: '<svg xmlns="http://www.w3.org/2000/svg"><image href="./a.png" /></svg>',
    preview: { inlinedImageUrl: 'data:image/svg+xml;base64,SU5MSU5FRA==' },
  };
  const svgRendered = renderInspectorFileContent(svgFile, {
    viewMode: 'rendered',
    showLineNumbers: false,
    wordWrap: false,
    searchQuery: '',
  });
  assert.ok(svgRendered.includes('src="data:image/svg+xml;base64,SU5MSU5FRA=="'));
  const svgRaw = renderInspectorFileContent(svgFile, {
    viewMode: 'raw',
    showLineNumbers: true,
    wordWrap: false,
    searchQuery: '',
  });
  assert.ok(svgRaw.includes('&lt;svg'));

  // 音频渲染与未就绪错误态
  const audioOk = renderInspectorFileContent(
    { path: '/repo/sound.mp3', content: 'data:audio/mpeg;base64,SUQz' },
    { viewMode: 'rendered', showLineNumbers: false, wordWrap: false, searchQuery: '' },
  );
  assert.ok(audioOk.includes('<audio controls'));
  const audioErr = renderInspectorFileContent(
    { path: '/repo/sound.mp3', content: '' },
    { viewMode: 'rendered', showLineNumbers: false, wordWrap: false, searchQuery: '' },
  );
  assert.ok(audioErr.includes('data-testid="inspector-audio-error"'));

  // InspectionPod 传递 workspaceRoot 到 Markdown 渲染上下文
  const podHtml = renderInspectionPod({
    collapsed: false,
    gatewayConnected: true,
    workspaceRoot: '/repo',
    activeFilePath: '/repo/docs/guide.md',
    viewMode: 'rendered',
    openFiles: [
      {
        path: '/repo/docs/guide.md',
        content: '![Pic](/assets/p.png)',
      },
    ],
  });
  assert.ok(podHtml.includes('data-workspace-root="/repo"'));
  assert.ok(podHtml.includes('data-preview-asset-path="/repo/assets/p.png"'));
});

test('MobileInspectorScreen: SSR 完整支持 frameUrl/inlinedHtml/SVG原始XML/音频与 Markdown 相对路径', () => {
  const baseProps = {
    activeFocus: { type: 'session', id: 's1', botName: 'default' },
    activeTab: 'files',
    readerOpen: true,
    artifacts: [],
    gitDiffs: [],
    openFiles: [],
    fileTreeState: { status: 'ready', rootPath: '/repo', source: 'local_fs', nodes: [] },
    fileTreeExpandedPaths: [],
    fileTreeFilterQuery: '',
    activeFilePath: '/repo/docs/page.html',
    workspaceRoot: '/repo',
    memories: [],
    learningState: { status: 'idle', nodes: [], edges: [] },
    learningDetail: { status: 'idle', nodeId: null, detail: null },
    groupMembers: [],
    onSelectTab: () => {},
    onOpenItem: () => {},
    onCloseReader: () => {},
    onCopyText: () => {},
    onLoadFileTree: () => {},
    onToggleFileTreeDir: () => {},
    onFilterFileTree: () => {},
    onOpenWorkspaceFile: () => {},
    onDownloadInspectorFile: () => {},
    onRefreshLearning: () => {},
    onLoadLearningDetail: () => {},
  };

  const htmlReaderMarkup = renderToStaticMarkup(
    React.createElement(MobileInspectorScreen, {
      ...baseProps,
      readerItem: {
        kind: 'files',
        title: 'page.html',
        filePath: '/repo/docs/page.html',
        content: '<p>raw</p>',
        preview: { frameUrl: 'hermes-preview://m1.preview/docs/page.html' },
      },
    }),
  );
  assert.ok(htmlReaderMarkup.includes('src="hermes-preview://m1.preview/docs/page.html"'));
  assert.ok(htmlReaderMarkup.includes('sandbox="allow-scripts"'));
  assert.equal(htmlReaderMarkup.includes('allow-same-origin'), false);

  const mdReaderMarkup = renderToStaticMarkup(
    React.createElement(MobileInspectorScreen, {
      ...baseProps,
      readerItem: {
        kind: 'files',
        title: 'readme.md',
        filePath: '/repo/docs/readme.md',
        content: '![Chart](./chart.png)\n\n[Next](./next.md)',
      },
    }),
  );
  assert.ok(mdReaderMarkup.includes('data-preview-asset-path="/repo/docs/chart.png"'));
  assert.ok(mdReaderMarkup.includes('data-preview-file="/repo/docs/next.md"'));

  const audioReaderMarkup = renderToStaticMarkup(
    React.createElement(MobileInspectorScreen, {
      ...baseProps,
      readerItem: {
        kind: 'files',
        title: 'voice.mp3',
        filePath: '/repo/voice.mp3',
        content: 'data:audio/mpeg;base64,SUQz',
      },
    }),
  );
  assert.ok(audioReaderMarkup.includes('data-testid="mobile-inspector-audio"'));

  const svgReaderMarkup = renderToStaticMarkup(
    React.createElement(MobileInspectorScreen, {
      ...baseProps,
      readerItem: {
        kind: 'files',
        title: 'vec.svg',
        filePath: '/repo/vec.svg',
        isImage: true,
        content: '<svg xmlns="http://www.w3.org/2000/svg"><circle cx="1" cy="1" r="1"/></svg>',
      },
    }),
  );
  assert.ok(svgReaderMarkup.includes('data:image/svg+xml;base64,'));
});

test('MarkdownBlock、markdownDomHydrator 与 MobileInspectorScreen SVG raw 切换 / Tier 2 inlinedHtml 交互分支', async () => {
  // 1. markdown.ts 原始 HTML 与非相对分支全覆盖
  const rawHtmlCases = renderMarkdownCore(
    [
      '[Mail](mailto:hi@example.com)',
      '![](../../.env)',
      '![Proto](//cdn.example.com/proto.png "ProtoTitle")',
      '![](//cdn.example.com/noalt.png)',
      '![Tit](./assets/tit.png "TitLabel")',
      '![](./assets/noalt.png)',
      '![NoRes](tel:123)',
      '<img src="../.env" alt="sec">',
      "<img src='./sq.png'>",
      '<img src="https://cdn.example.com/raw-tag.png">',
      '<video poster="https://cdn.example.com/p.jpg"><source src="https://cdn.example.com/v.mp4"></video>',
      '<img srcset="https://cdn.example.com/no-desc.png">',
      '<img srcset="./assets/tit.png">',
      '<img srcset="https://cdn.example.com/a.png 1x, data:image/png;base64,AA== 2x">',
      "<img srcset='./single-miss.png 1x'>",
      '<img srcset="../.env 1x">',
      '<img src=./unquoted.png alt="uq">',
      '<a name="top">Top</a>',
      '<a href="../.env">Blocked</a>',
      "<a href='./sq.md'>SQ</a>",
      '<a href=./uq.md>UQ</a>',
      '<a href="mailto:test@example.com">MailA</a>',
      '<a href="#sec-id">Local Anchor</a>',
      '<a href="./doc.md" data-preview-file="/repo/doc.md">PreTagged</a>',
    ].join('\n'),
    {
      documentBasePath: '/repo/guide.md',
      workspaceRoot: '',
      resolvedAssetUrls: { '/other.png': 'data:image/png;base64,AA==', '/repo/assets/tit.png': 'data:image/png;base64,VElU' },
    },
  );
  assert.ok(rawHtmlCases.includes('data-preview-blocked="true"'));
  assert.ok(rawHtmlCases.includes('data-media-src="https://cdn.example.com/raw-tag.png"'));
  assert.ok(rawHtmlCases.includes('data-media-src="https://cdn.example.com/proto.png"'));
  assert.ok(rawHtmlCases.includes('srcset="https://cdn.example.com/a.png 1x, data:image/png;base64,AA== 2x"'));
  assert.ok(rawHtmlCases.includes('data-preview-anchor="sec-id"'));
  assert.ok(rawHtmlCases.includes('data-preview-file="/repo/doc.md"'));

  // 2. inspectorViewHelpers query 剥离
  const imgWithQuery = renderInspectorFileContent(
    { path: '/repo/pic.png?v=2', content: 'data:image/png;base64,QQ==' },
    { viewMode: 'rendered', showLineNumbers: false, wordWrap: false, searchQuery: '' },
  );
  assert.ok(imgWithQuery.includes('src="data:image/png;base64,QQ=="'));

  // 3. markdownDomHydrator + MarkdownBlock React hook driver 全路径
  const scrolled = [];
  const openedFiles = [];
  const lightboxCalls = [];
  const makeNode = (tagName, attrs = {}) => {
    const attrMap = new Map(Object.entries(attrs));
    const classes = new Set((attrs.class || '').split(/\s+/).filter(Boolean));
    const node = {
      tagName,
      id: attrs.id || '',
      textContent: '',
      _parentMedia: null,
      children: [],
      classList: {
        add: (c) => classes.add(c),
        remove: (c) => classes.delete(c),
        has: (c) => classes.has(c),
      },
      getAttribute: (k) => (attrMap.has(k) ? attrMap.get(k) : null),
      setAttribute: (k, v) => attrMap.set(k, v),
      appendChild: (c) => node.children.push(c),
      scrollIntoView: () => scrolled.push(attrs.id || ''),
      querySelector: () => null,
      closest(sel) {
        if (sel === 'video, audio') return node._parentMedia;
        if (sel === '[data-deliverable-name]' && attrMap.has('data-deliverable-name')) return node;
        if (sel === '.conv-inline-deliverable[data-deliverable-card]' && classes.has('conv-inline-deliverable')) return node;
        if (sel === '.md-inline-image[data-media-src]' && classes.has('md-inline-image') && attrMap.has('data-media-src')) return node;
        if (sel === 'a[data-preview-anchor]' && tagName === 'A' && attrMap.has('data-preview-anchor')) return node;
        if (sel === 'a[data-preview-file]' && tagName === 'A' && attrMap.has('data-preview-file')) return node;
        return null;
      },
    };
    return node;
  };

  const thumbDirect = makeNode('SPAN', { 'data-deliverable-thumb': 'data:image/png;base64,RElS' });
  const thumbAsync = makeNode('SPAN', { 'data-deliverable-thumb': '/repo/thumb.png', 'data-deliverable-name': 'Thumb' });
  const thumbEmpty = makeNode('SPAN', { 'data-deliverable-thumb': '' });
  const videoEl = makeNode('VIDEO', { 'data-preview-poster-path': '/repo/poster.jpg' });
  let videoLoaded = false;
  videoEl.load = () => {
    videoLoaded = true;
  };
  const sourceEl = makeNode('SOURCE', { 'data-preview-asset-path': '/repo/clip.mp4' });
  sourceEl._parentMedia = videoEl;
  const imgAsset = makeNode('IMG', { class: 'md-inline-image md-inline-image--pending', 'data-preview-asset-path': '/repo/a.png' });
  const srcsetAsset = makeNode('IMG', {
    'data-preview-srcset-paths': 'literal:https://cdn.example.com/a.png 1x|,literal:data:image/png;base64,AA==|2x,/repo/b.png|3x',
  });
  const errImgAsset = makeNode('IMG', { class: 'md-inline-image md-inline-image--pending', 'data-preview-asset-path': '/repo/throw.png' });
  const emptyAsset = makeNode('IMG', { 'data-preview-asset-path': '' });
  const heading = makeNode('H2', { id: 'sec-1' });
  const badAnchorLink = makeNode('A', { 'data-preview-anchor': '%E0' });
  const anchorLink = makeNode('A', { 'data-preview-anchor': 'sec-1' });
  const docLink = makeNode('A', { 'data-preview-file': '/repo/next.md' });
  const delivImgCard = makeNode('SPAN', { class: 'conv-inline-deliverable', 'data-deliverable-card': 'true', 'data-deliverable-kind': 'image', 'data-deliverable-path': '/repo/img.png' });
  const delivDocCard = makeNode('SPAN', { class: 'conv-inline-deliverable', 'data-deliverable-card': 'true', 'data-deliverable-kind': 'code', 'data-preview-file': '/repo/code.ts' });

  const prevDoc = globalThis.document;
  globalThis.document = {
    createElement: (tag) => makeNode(tag.toUpperCase()),
    body: { appendChild: () => {} },
    getElementById: () => ({ nodeType: 1 }),
    querySelectorAll: () => [],
  };
  try {
    const fakeRoot = {
      isConnected: true,
      querySelectorAll(sel) {
        if (sel === '[data-deliverable-thumb]') return [thumbDirect, thumbAsync, thumbEmpty];
        if (sel === '[data-preview-asset-path]') return [sourceEl, imgAsset, errImgAsset, emptyAsset];
        if (sel === '[data-preview-poster-path]') return [videoEl];
        if (sel === '[data-preview-srcset-paths]') return [srcsetAsset];
        if (sel === '[id]') return [heading];
        if (sel === '.md-inline-image[data-media-src]') return [imgAsset];
        return [];
      },
    };

    const cleanup = hydrateMarkdownPreviewAssets({
      root: fakeRoot,
      resolveAssetUrl: async (p, isVid) => {
        if (p === '/repo/throw.png') throw new Error('boom');
        if (p === '/repo/clip.mp4' && isVid) return 'hermes-media://local/clip.mp4';
        if (p === '/repo/thumb.png') return 'data:image/png;base64,VEg=';
        if (p === '/repo/a.png') return 'data:image/png;base64,QUE=';
        if (p === '/repo/b.png') return 'data:image/png;base64,QkI=';
        if (p === '/repo/poster.jpg') return 'data:image/jpeg;base64,UE8=';
        return null;
      },
    });
    for (let i = 0; i < 30; i += 1) await Promise.resolve();

    assert.equal(thumbDirect.children.length, 1);
    assert.equal(thumbAsync.children.length, 1);
    assert.equal(videoLoaded, true);
    assert.equal(videoEl.getAttribute('poster'), 'data:image/jpeg;base64,UE8=');
    assert.equal(imgAsset.getAttribute('src'), 'data:image/png;base64,QUE=');
    assert.equal(errImgAsset.classList.has('md-inline-image--error'), true);
    assert.ok(srcsetAsset.getAttribute('srcset')?.includes('data:image/png;base64,AA== 2x'));
    assert.ok(srcsetAsset.getAttribute('srcset')?.includes('data:image/png;base64,QkI= 3x'));
    cleanup();

    // 空节点无操作分支
    const noopCleanup = hydrateMarkdownPreviewAssets({
      root: { isConnected: true, querySelectorAll: () => [] },
      resolveAssetUrl: async () => null,
    });
    noopCleanup();

    // click delegation 分支
    assert.equal(
      handleMarkdownPreviewClick({ target: null, preventDefault() {}, stopPropagation() {} }, fakeRoot, {}),
      false,
    );
    handleMarkdownPreviewClick(
      { target: delivImgCard, preventDefault() {}, stopPropagation() {} },
      fakeRoot,
      { onOpenMediaLightbox: (items, idx) => lightboxCalls.push({ items, idx }) },
    );
    handleMarkdownPreviewClick(
      { target: delivDocCard, preventDefault() {}, stopPropagation() {} },
      fakeRoot,
      { onOpenFile: (p) => openedFiles.push(p) },
    );
    handleMarkdownPreviewClick(
      { target: imgAsset, preventDefault() {}, stopPropagation() {} },
      fakeRoot,
      { onOpenMediaLightbox: (items, idx) => lightboxCalls.push({ items, idx }) },
    );
    handleMarkdownPreviewClick({ target: badAnchorLink, preventDefault() {}, stopPropagation() {} }, fakeRoot, {});
    handleMarkdownPreviewClick({ target: anchorLink, preventDefault() {}, stopPropagation() {} }, fakeRoot, {});
    handleMarkdownPreviewClick(
      { target: docLink, preventDefault() {}, stopPropagation() {} },
      fakeRoot,
      { onOpenFile: (p) => openedFiles.push(p) },
    );
    // 覆盖 turnImages 不含 path 字段、无 data-media-src / 无 data-media-name、allImgs 为空、空白 anchor/file 与无命中 click 返回 false
    assert.equal(
      handleMarkdownPreviewClick(
        { target: makeNode('P'), preventDefault() {}, stopPropagation() {} },
        fakeRoot,
        {},
      ),
      false,
    );
    assert.equal(
      handleMarkdownPreviewClick(
        {
          target: makeNode('IMG', { class: 'md-inline-image', 'data-media-src': '' }),
          preventDefault() {},
          stopPropagation() {},
        },
        fakeRoot,
        { onOpenMediaLightbox: () => {} },
      ),
      false,
    );
    const noNameImg = makeNode('IMG', { class: 'md-inline-image', 'data-media-src': 'https://cdn.example.com/nn.png' });
    const blankSrcSibling = makeNode('IMG', { class: 'md-inline-image', 'data-media-src': '' });
    handleMarkdownPreviewClick(
      { target: noNameImg, preventDefault() {}, stopPropagation() {} },
      { isConnected: true, querySelectorAll: () => [blankSrcSibling, noNameImg] },
      { onOpenMediaLightbox: (items, idx) => lightboxCalls.push({ items, idx }) },
    );
    handleMarkdownPreviewClick(
      { target: noNameImg, preventDefault() {}, stopPropagation() {} },
      null,
      { onOpenMediaLightbox: (items, idx) => lightboxCalls.push({ items, idx }) },
    );
    handleMarkdownPreviewClick(
      { target: delivImgCard, preventDefault() {}, stopPropagation() {} },
      fakeRoot,
      {
        turnImages: [{ id: 't1', src: '/repo/img.png', name: 'img' }],
        onOpenMediaLightbox: (items, idx) => lightboxCalls.push({ items, idx }),
      },
    );
    handleMarkdownPreviewClick(
      { target: makeNode('A', { 'data-preview-anchor': '' }), preventDefault() {}, stopPropagation() {} },
      fakeRoot,
      {},
    );
    handleMarkdownPreviewClick(
      { target: makeNode('A', { 'data-preview-file': '' }), preventDefault() {}, stopPropagation() {} },
      fakeRoot,
      { onOpenFile: (p) => openedFiles.push(p) },
    );

    // 覆盖 hydrator 剩余边界（已存在 src、poster 已存在/非法、srcset null 候选与无 descriptor、stale 丢弃）
    const alreadySrcImg = makeNode('IMG', { 'data-preview-asset-path': '/repo/a.png', src: 'data:image/png;base64,AA==' });
    const emptyPosterVid = makeNode('VIDEO', { 'data-preview-poster-path': '' });
    const badPosterVid = makeNode('VIDEO', { 'data-preview-poster-path': '/repo/badposter.jpg' });
    const emptySrcsetEl = makeNode('IMG', { 'data-preview-srcset-paths': '' });
    const partialSrcsetEl = makeNode('IMG', { 'data-preview-srcset-paths': '/repo/miss.png|2x,/repo/b.png|' });
    const badThumbSlot = makeNode('SPAN', { 'data-deliverable-thumb': '/repo/badthumb.png' });
    let staleFlag = false;
    hydrateMarkdownPreviewAssets({
      root: {
        isConnected: true,
        querySelectorAll(sel) {
          if (sel === '[data-deliverable-thumb]') return [badThumbSlot];
          if (sel === '[data-preview-asset-path]') return [alreadySrcImg, imgAsset];
          if (sel === '[data-preview-poster-path]') return [emptyPosterVid, badPosterVid];
          if (sel === '[data-preview-srcset-paths]') return [emptySrcsetEl, partialSrcsetEl];
          return [];
        },
      },
      isCancelled: () => staleFlag,
      resolveAssetUrl: async (p) => {
        if (p === '/repo/b.png') return 'data:image/png;base64,QkI=';
        if (p === '/repo/badposter.jpg' || p === '/repo/badthumb.png') return 'javascript:alert(1)';
        return null;
      },
    });
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    assert.equal(badThumbSlot.children.length, 0);
    assert.equal(badPosterVid.getAttribute('poster'), null);
    assert.equal(partialSrcsetEl.getAttribute('srcset'), 'data:image/png;base64,QkI=');

    staleFlag = false;
    const cancelMidRoot = {
      isConnected: true,
      querySelectorAll: (sel) =>
        sel === '[data-preview-asset-path]'
          ? [makeNode('AUDIO', { 'data-preview-asset-path': '/repo/a.mp3' })]
          : sel === '[data-preview-srcset-paths]'
            ? [makeNode('IMG', { 'data-preview-srcset-paths': '/repo/b.png|1x' })]
            : [],
    };
    const cancelFn = hydrateMarkdownPreviewAssets({
      root: cancelMidRoot,
      resolveAssetUrl: async () => 'data:image/png;base64,QkI=',
    });
    cancelFn();
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    assert.equal(scrolled[0], 'sec-1');
    assert.deepEqual(openedFiles, ['/repo/code.ts', '/repo/next.md']);
    assert.equal(lightboxCalls.length, 5);

    // 挂载 React MarkdownBlock 执行 useMemo / useEffect(rootRef.current != null) / onClick(有无 onOpenFile)
    const blockImgNode = makeNode('IMG', { 'data-preview-asset-path': '/repo/block.png' });
    const blockHostRef = {
      isConnected: true,
      querySelectorAll: (sel) => (sel === '[data-preview-asset-path]' ? [blockImgNode] : []),
    };
    const mdDriver = createLocalReactDriver(blockHostRef);
    const mdMount = mdDriver.mount(() =>
      React.createElement(MarkdownBlock, {
        content: '![Pic](./a.png)\n\n[Next](./next.md)',
        documentBasePath: '/repo/readme.md',
        workspaceRoot: '/repo',
        resolveMediaUrl: async () => 'data:image/png;base64,QkxL',
        onOpenFile: (p) => openedFiles.push(p),
      }),
    );
    for (let i = 0; i < 15; i += 1) await Promise.resolve();
    assert.equal(blockImgNode.getAttribute('src'), 'data:image/png;base64,QkxL');
    mdMount.tree.props.onClick({ target: docLink, preventDefault() {}, stopPropagation() {} });
    mdDriver.unmount();

    const block2ImgNode = makeNode('IMG', { 'data-preview-asset-path': '/repo/block2.png' });
    const block2HostRef = {
      isConnected: true,
      querySelectorAll: (sel) => (sel === '[data-preview-asset-path]' ? [block2ImgNode] : []),
    };
    const mdNoOptDriver = createLocalReactDriver(block2HostRef);
    mdNoOptDriver.mount(() =>
      React.createElement(MarkdownBlock, {
        content: '![Pic2](./b.png)',
        documentBasePath: '/repo/readme.md',
      }),
    );
    for (let i = 0; i < 15; i += 1) await Promise.resolve();
    assert.equal(block2ImgNode.classList.has('md-inline-image--error'), true);
    mdNoOptDriver.unmount();

    // 挂载 MobileInspectorScreen 验证 SVG 切换 Raw 与 Tier 2 inlinedHtml
    const mobDriver = createLocalReactDriver();
    const mobMount = mobDriver.mount(() =>
      React.createElement(MobileInspectorScreen, {
        activeFocus: { type: 'session', id: 's1', botName: 'default' },
        activeTab: 'files',
        readerOpen: true,
        readerItem: {
          kind: 'files',
          title: 'vec.svg',
          filePath: '/repo/vec.svg',
          isImage: true,
          content: '<svg xmlns="http://www.w3.org/2000/svg"><circle cx="1" cy="1" r="1"/></svg>',
        },
        artifacts: [],
        gitDiffs: [],
        openFiles: [],
        fileTreeState: { status: 'ready', rootPath: '/repo', source: 'local_fs', nodes: [] },
        fileTreeExpandedPaths: [],
        fileTreeFilterQuery: '',
        activeFilePath: '/repo/vec.svg',
        workspaceRoot: '/repo',
        memories: [],
        learningState: { status: 'idle', nodes: [], edges: [] },
        learningDetail: { status: 'idle', nodeId: null, detail: null },
        groupMembers: [],
        onSelectTab: () => {},
        onOpenItem: () => {},
        onCloseReader: () => {},
        onCopyText: () => {},
        onLoadFileTree: () => {},
        onToggleFileTreeDir: () => {},
        onFilterFileTree: () => {},
        onOpenWorkspaceFile: () => {},
        onDownloadInspectorFile: () => {},
        onRefreshLearning: () => {},
        onLoadLearningDetail: () => {},
      }),
    );
    const toggleBtns = mobDriver.findAll(
      mobMount.tree,
      (n) => n.props?.['data-testid'] === 'mobile-inspector-toggle-view',
    );
    assert.equal(toggleBtns.length, 1);
    toggleBtns[0].props.onClick();
    const rawTree = mobDriver.rerender();
    const rawCode = mobDriver.findAll(rawTree, (n) => n.props?.className === 'm-inspector__reader-code');
    assert.equal(rawCode.length, 1);
    mobDriver.unmount();

    // Tier 2 HTML srcDoc 回退渲染
    const tier2MobMarkup = renderToStaticMarkup(
      React.createElement(MobileInspectorScreen, {
        activeFocus: { type: 'session', id: 's1', botName: 'default' },
        activeTab: 'files',
        readerOpen: true,
        readerItem: {
          kind: 'files',
          title: 'page.html',
          filePath: '/repo/page.html',
          content: '<p>orig</p>',
          preview: { inlinedHtml: '<p>inlined</p>' },
        },
        artifacts: [],
        gitDiffs: [],
        openFiles: [],
        fileTreeState: { status: 'ready', rootPath: '/repo', source: 'local_fs', nodes: [] },
        fileTreeExpandedPaths: [],
        fileTreeFilterQuery: '',
        activeFilePath: '/repo/page.html',
        memories: [],
        learningState: { status: 'idle', nodes: [], edges: [] },
        learningDetail: { status: 'idle', nodeId: null, detail: null },
        groupMembers: [],
        onSelectTab: () => {},
        onOpenItem: () => {},
        onCloseReader: () => {},
        onCopyText: () => {},
        onLoadFileTree: () => {},
        onToggleFileTreeDir: () => {},
        onFilterFileTree: () => {},
        onOpenWorkspaceFile: () => {},
        onDownloadInspectorFile: () => {},
        onRefreshLearning: () => {},
        onLoadLearningDetail: () => {},
      }),
    );
    assert.ok(tier2MobMarkup.includes('inlined'));

    // MobileInspectorScreen: 不安全音频失败态（含 canDownload true/false）、inlinedImageUrl、HTML 无 frameUrl/inlinedHtml 回落
    const baseMobProps = {
      activeFocus: { type: 'session', id: 's1', botName: 'default' },
      activeTab: 'files',
      readerOpen: true,
      artifacts: [],
      gitDiffs: [],
      openFiles: [],
      fileTreeState: { status: 'ready', rootPath: '/repo', source: 'local_fs', nodes: [] },
      fileTreeExpandedPaths: [],
      fileTreeFilterQuery: '',
      activeFilePath: '/repo/a',
      memories: [],
      learningState: { status: 'idle', nodes: [], edges: [] },
      learningDetail: { status: 'idle', nodeId: null, detail: null },
      groupMembers: [],
      onSelectTab: () => {},
      onOpenItem: () => {},
      onCloseReader: () => {},
      onCopyText: () => {},
      onLoadFileTree: () => {},
      onToggleFileTreeDir: () => {},
      onFilterFileTree: () => {},
      onOpenWorkspaceFile: () => {},
      onDownloadInspectorFile: () => {},
      onRefreshLearning: () => {},
      onLoadLearningDetail: () => {},
    };
    const badAudioDlMarkup = renderToStaticMarkup(
      React.createElement(MobileInspectorScreen, {
        ...baseMobProps,
        readerItem: { kind: 'files', title: 'v.mp3', filePath: '/repo/v.mp3', content: 'javascript:bad', canDownload: true },
      }),
    );
    assert.ok(badAudioDlMarkup.includes('m-primary-btn'));
    const badAudioNoDlMarkup = renderToStaticMarkup(
      React.createElement(MobileInspectorScreen, {
        ...baseMobProps,
        readerItem: { kind: 'files', title: 'v.mp3', filePath: '/repo/v.mp3', content: 'javascript:bad', canDownload: false },
      }),
    );
    assert.equal(badAudioNoDlMarkup.includes('m-primary-btn'), false);
    const inlinedSvgMarkup = renderToStaticMarkup(
      React.createElement(MobileInspectorScreen, {
        ...baseMobProps,
        readerItem: {
          kind: 'files',
          title: 'logo.svg',
          filePath: '/repo/logo.svg',
          isImage: true,
          content: '<svg/>',
          preview: { inlinedImageUrl: 'data:image/svg+xml;base64,PHN2Zy8+' },
        },
      }),
    );
    assert.ok(inlinedSvgMarkup.includes('data:image/svg+xml;base64,PHN2Zy8+'));
    const plainHtmlFallbackMarkup = renderToStaticMarkup(
      React.createElement(MobileInspectorScreen, {
        ...baseMobProps,
        readerItem: { kind: 'files', title: 'raw.html', filePath: '/repo/raw.html', content: '<p>raw-doc</p>' },
      }),
    );
    assert.ok(plainHtmlFallbackMarkup.includes('raw-doc'));
  } finally {
    globalThis.document = prevDoc;
  }
});

test('markdown & markdownDomHydrator: 混淆可执行 data URI 阻断、md-asset-blocked 传播与 DOM replaceChild 兜底', async () => {
  // 1. 混淆可执行 data URI / file URI 在 link、image、原生 HTML <a> 中全面阻断
  const xssMd = [
    '[badLink](data:text/html,<script>alert(1)</script>)',
    '[badFile](file:///etc/passwd)',
    '![badImg](data:application/xhtml+xml;base64,PHN2Zy8+)',
    '![badJs](data:text/javascript,alert(1))',
    '<a href="da\tta:text/html,1">click</a>',
    '<img src="../.env">',
    '<img class="" src="../.env">',
    '<img class="hero" src="../.env">',
    "<img class='card' srcset='../.env 1x'>",
    '<img class="md-asset-blocked" src="../.env">',
    '<img class="a b" srcset="../.env 2x">',
  ].join('\n');
  const html = renderMarkdownCore(xssMd, {
    documentBasePath: '/repo/docs/guide.md',
    workspaceRoot: '/repo',
  });
  assert.equal(html.includes('text/html'), false);
  assert.equal(html.includes('xhtml+xml'), false);
  assert.equal(html.includes('text/javascript'), false);
  assert.equal(html.includes('file:///'), false);
  assert.ok(html.includes('class="md-asset-blocked"'));
  assert.ok(html.includes('class="hero md-asset-blocked"'));
  assert.ok(html.includes('class="card md-asset-blocked"'));
  assert.ok(html.includes('class="a b md-asset-blocked"'));
  assert.ok(html.includes('data-preview-blocked="true"'));

  const injHtml = renderMarkdownCore(
    [
      '<img data-preview-asset-path="/ws/secret.png">',
      '<a href="./x.md" data-preview-file="/etc/passwd">x</a>',
      '<a data-preview-file="/etc/passwd">y</a>',
      '<span data-deliverable-thumb="/etc/passwd"></span>',
      '<img data-media-src="/etc/passwd">',
      '<div>plain-raw</div>',
      '```html\n<img data-preview-asset-path="/ws/keep.png">\n```',
    ].join('\n\n'),
    { documentBasePath: '/repo/docs/guide.md', workspaceRoot: '/repo' },
  );
  assert.equal(injHtml.includes('data-preview-asset-path="/ws/secret.png"'), false);
  assert.equal(injHtml.includes('data-preview-file="/etc/passwd"'), false);
  assert.equal(injHtml.includes('data-deliverable-thumb="/etc/passwd"'), false);
  assert.equal(injHtml.includes('data-media-src="/etc/passwd"'), false);
  assert.ok(injHtml.includes('data-preview-file="/repo/docs/x.md"'));
  assert.ok(injHtml.includes('plain-raw'));
  assert.ok(injHtml.includes('data-preview-asset-path="/ws/keep.png"') || injHtml.includes('&quot;/ws/keep.png&quot;'));

  // 2. DOM 水合失败时通过 ownerDocument.createElement + parentNode.replaceChild 原地替换为占位胶囊
  const replacements = [];
  const makeNode = (tag, attrs) => {
    const cls = new Set(['md-inline-image--pending']);
    const node = {
      tagName: tag.toUpperCase(),
      attrs: { ...attrs },
      children: [],
      parentNode: null,
      ownerDocument: null,
      classList: {
        add(c) { cls.add(c); },
        remove(c) { cls.delete(c); },
        has(c) { return cls.has(c); },
      },
      getAttribute(k) { return node.attrs[k] ?? null; },
      setAttribute(k, v) { node.attrs[k] = v; },
      closest() { return null; },
    };
    return node;
  };
  const ownerDoc = {
    createElement(tag) {
      const el = { tagName: tag.toUpperCase(), className: '', textContent: '', attrs: {}, setAttribute(k, v) { el.attrs[k] = v; } };
      return el;
    },
  };
  const imgAltFail = makeNode('img', { 'data-preview-asset-path': '/repo/miss1.png', alt: 'Chart' });
  const imgRawFail = makeNode('img', { 'data-preview-asset-path': '/repo/miss2.png' });
  const audioWrap = makeNode('audio', {});
  const audioSrcFail = makeNode('source', { 'data-preview-asset-path': '/repo/miss.mp3', 'data-preview-asset-raw': './miss.mp3' });
  audioSrcFail.closest = (sel) => (sel.includes('audio') ? audioWrap : null);
  for (const n of [imgAltFail, imgRawFail, audioWrap]) {
    n.ownerDocument = ownerDoc;
    n.parentNode = {
      replaceChild(nextNode, prevNode) {
        replacements.push({ nextNode, prevNode });
      },
    };
  }
  const fallbackNoDom = makeNode('img', { 'data-preview-asset-path': '/repo/miss3.png' });
  const prevDoc = globalThis.document;
  globalThis.document = undefined;
  try {
    hydrateMarkdownPreviewAssets({
      root: {
        querySelectorAll: (sel) => (sel === '[data-preview-asset-path]' ? [imgAltFail, imgRawFail, audioSrcFail, fallbackNoDom] : []),
      },
      resolveAssetUrl: async () => null,
    });
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  } finally {
    globalThis.document = prevDoc;
  }
  assert.equal(replacements.length, 3);
  assert.equal(replacements[0].nextNode.className, 'md-asset-blocked');
  assert.equal(replacements[0].nextNode.attrs['data-preview-blocked'], 'true');
  assert.equal(replacements[0].nextNode.textContent, 'Chart');
  assert.equal(replacements[1].nextNode.textContent, '/repo/miss2.png');
  assert.equal(replacements[2].prevNode, audioWrap);
  assert.equal(replacements[2].nextNode.textContent, './miss.mp3');
  assert.equal(fallbackNoDom.classList.has('md-inline-image--error'), true);
});

test('Audio error i18n、MobileInspectorScreen openFiles preview/Copy、MediaLightbox 与 CSS/手势护栏', async () => {
  const prevLang = getLocale();
  setLocale('zh-CN');
  try {
    const zhErr = renderInspectorFileContent(
      { id: 'a1', path: '/repo/broken.mp3', content: '' },
      { viewMode: 'rendered' },
    );
    assert.ok(zhErr.includes('inspector-audio-error'));
    assert.ok(zhErr.includes(t('inspector.audioLoadError')));
    setLocale('en-US');
    const enErr = renderInspectorFileContent(
      { id: 'a1', path: '/repo/broken.mp3', content: '' },
      { viewMode: 'rendered' },
    );
    assert.ok(enErr.includes('Audio failed to load'));
    assert.ok(enErr.includes('Download to play locally.'));
  } finally {
    setLocale(prevLang);
  }

  const openedItems = [];
  const baseMobProps = {
    activeFocus: { type: 'session', id: 's1', botName: 'default' },
    activeTab: 'files',
    readerOpen: false,
    readerItem: null,
    artifacts: [],
    gitDiffs: [],
    openFiles: [
      {
        id: 'f1',
        path: '/repo/report.html',
        content: '<img src="./p.png">',
        language: 'html',
        preview: { inlinedHtml: '<img src="data:image/png;base64,QUE=">' },
      },
    ],
    fileTreeState: { status: 'ready', rootPath: '/repo', source: 'local_fs', nodes: [] },
    fileTreeExpandedPaths: [],
    fileTreeFilterQuery: '',
    activeFilePath: '/repo/report.html',
    memories: [],
    learningState: { status: 'idle', nodes: [], edges: [] },
    learningDetail: { status: 'idle', nodeId: null, detail: null },
    groupMembers: [],
    onSelectTab: () => {},
    onOpenItem: (item) => openedItems.push(item),
    onCloseReader: () => {},
    onCopyText: () => {},
    onLoadFileTree: () => {},
    onToggleFileTreeDir: () => {},
    onFilterFileTree: () => {},
    onOpenWorkspaceFile: () => {},
    onDownloadInspectorFile: () => {},
    onRefreshLearning: () => {},
    onLoadLearningDetail: () => {},
  };

  const driver = createLocalReactDriver();
  const findNodes = (node, pred, acc = []) => {
    if (!node || typeof node !== 'object') return acc;
    if (Array.isArray(node)) { node.forEach((n) => findNodes(n, pred, acc)); return acc; }
    if (pred(node)) acc.push(node);
    if (node.props?.children) findNodes(node.props.children, pred, acc);
    return acc;
  };
  const vList = driver.mount(() => React.createElement(MobileInspectorScreen, baseMobProps));
  const cards = findNodes(vList.tree, (n) => n.props?.className === 'm-inspector-card');
  assert.equal(cards.length, 1);
  cards[0].props.onClick();
  assert.equal(openedItems[0].preview?.inlinedHtml, '<img src="data:image/png;base64,QUE=">');
  assert.equal(openedItems[0].isImage, false);

  const imgListDriver = createLocalReactDriver();
  const imgListView = imgListDriver.mount(() =>
    React.createElement(MobileInspectorScreen, {
      ...baseMobProps,
      openFiles: [{ id: 'img1', path: '/repo/logo.svg', content: '<svg/>' }],
    }),
  );
  findNodes(imgListView.tree, (n) => n.props?.className === 'm-inspector-card')[0].props.onClick();
  assert.equal(openedItems[1].isImage, true);

  // MarkdownBlock 在 Mobile / 无协调器路径下也必须隔离 docDir 并先拦截越权资产再调用 resolveMediaUrl
  const blockScopedCalls = [];
  const makeScopeImg = (p) => {
    const cls = new Set(['md-inline-image--pending']);
    const el = {
      tagName: 'IMG',
      attrs: { 'data-preview-asset-path': p },
      classList: { remove(c) { cls.delete(c); }, add(c) { cls.add(c); }, has(c) { return cls.has(c); } },
      getAttribute(k) { return el.attrs[k] ?? null; },
      setAttribute(k, v) { el.attrs[k] = v; },
      closest() { return null; },
    };
    return el;
  };
  const okExtEl = makeScopeImg('/ext/pic.png');
  const badWsEl = makeScopeImg('/ws/secret.png');
  const badParentEl = makeScopeImg('../secret.png');
  const scopeHost = {
    isConnected: true,
    querySelectorAll: (sel) => (sel === '[data-preview-asset-path]' ? [okExtEl, badWsEl, badParentEl] : []),
  };
  const scopeDrv = createLocalReactDriver(scopeHost);
  scopeDrv.mount(() =>
    React.createElement(MarkdownBlock, {
      content: '![ok](./pic.png)',
      documentBasePath: '/ext/doc.md',
      workspaceRoot: '/ws',
      resolveMediaUrl: async (p) => {
        blockScopedCalls.push(p);
        return 'data:image/png;base64,T0s=';
      },
    }),
  );
  for (let i = 0; i < 15; i += 1) await Promise.resolve();
  assert.deepEqual(blockScopedCalls, ['/ext/pic.png']);
  assert.equal(okExtEl.getAttribute('src'), 'data:image/png;base64,T0s=');
  assert.equal(badWsEl.classList.has('md-inline-image--error'), true);
  assert.equal(badParentEl.classList.has('md-inline-image--error'), true);
  scopeDrv.unmount();

  const audioReaderHtml = renderToStaticMarkup(
    React.createElement(MobileInspectorScreen, {
      ...baseMobProps,
      readerOpen: true,
      readerItem: { kind: 'files', title: 'track.mp3', filePath: '/repo/track.mp3', content: 'data:audio/mpeg;base64,SUQz' },
    }),
  );
  assert.ok(audioReaderHtml.includes('data-testid="mobile-inspector-audio"'));
  assert.equal(audioReaderHtml.includes(t('mobile.inspector.copyContent')), false, '音频预览应隐藏复制按钮');

  const rawSvgReaderHtml = renderToStaticMarkup(
    React.createElement(MobileInspectorScreen, {
      ...baseMobProps,
      readerOpen: true,
      readerItem: { kind: 'files', title: 'logo.svg', filePath: '/repo/logo.svg', isImage: true, content: '<svg><rect/></svg>' },
    }),
  );
  assert.ok(rawSvgReaderHtml.includes(t('mobile.inspector.copyContent')), 'Raw SVG 文本应允许复制');

  const dataSvgReaderHtml = renderToStaticMarkup(
    React.createElement(MobileInspectorScreen, {
      ...baseMobProps,
      readerOpen: true,
      readerItem: { kind: 'files', title: 'logo.svg', filePath: '/repo/logo.svg', isImage: true, content: 'data:image/svg+xml;base64,PHN2Zy8+' },
    }),
  );
  assert.equal(dataSvgReaderHtml.includes(t('mobile.inspector.copyContent')), false, 'Data URI SVG 应隐藏复制按钮');

  const lbHtml = renderToStaticMarkup(
    React.createElement(MediaLightbox, {
      items: [{ id: '1', src: 'hermes-preview://tok.preview/pic.png', name: 'pic.png' }],
      initialIndex: 0,
      onClose: () => {},
    }),
  );
  assert.ok(lbHtml.includes('hermes-preview://tok.preview/pic.png'));

  const uiPkgRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
  const cssText = fs.readFileSync(path.join(uiPkgRoot, 'src/styles/conversation.css'), 'utf8');
  assert.ok(cssText.includes(':not([data-preview-blocked="true"])'));
  assert.ok(cssText.includes('.md-inline-video') && cssText.includes('max-height: 480px;'));
  assert.ok(cssText.includes('.flux-doc-markdown audio') && cssText.includes('width: min(480px, 100%);'));
  const shellText = fs.readFileSync(path.join(uiPkgRoot, 'src/components-react/mobile/MobileWorkspaceShell.tsx'), 'utf8');
  assert.ok(shellText.includes('input, textarea, select, video, audio'));
});
