/**
 * 渲染层预览资源协调器、FileViewerService 与 MobileShellCoordinator 预览投影同步单测
 * (packages/desktop/__tests__/unit/fileViewerPreviewAssets.test.mjs)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createFileViewerService } from '../../dist/renderer/services/fileViewerService.mjs';
import { createPreviewAssetCoordinator, resolveEffectiveScopeRoot } from '../../dist/renderer/services/previewAssetCoordinator.mjs';
import { createMediaResolver } from '../../dist/renderer/services/mediaResolver.mjs';
import { createMobileShellCoordinator } from '../../dist/renderer/mobile/mobileShellCoordinator.mjs';
import { buildInspectorProps } from '../../dist/renderer/inspectorDomHelper.mjs';

async function flushUntil(pred) {
  for (let i = 0; i < 60 && !pred(); i += 1) {
    await Promise.resolve();
  }
}

test('createPreviewAssetCoordinator & createFileViewerService: HTML Tier 1/2 非破坏性与会话吊销', async () => {
  const revokedTokens = [];
  const rawHtml = '<html><head><link rel="stylesheet" href="./app.css"></head><body><img src="./pic.png"></body></html>';

  const state = {
    inspectorCollapsed: true,
    inspectorFullscreen: false,
    activeInspectorTab: 'files',
    activeFilePath: '',
    fileViewMode: 'raw',
    fileShowLineNumbers: false,
    fileSearchOpen: false,
    fileSearchQuery: '',
    openFiles: [],
    artifacts: [],
    gatewayUrl: '',
    gatewayConnected: true,
    profileName: 'default',
    activeSessionId: 's1',
    sessionCwds: { s1: '/repo' },
    messages: [],
    rightPodMode: { kind: 'closed' },
    fileTreeState: { status: 'ready', rootPath: '/repo', source: 'local_fs', nodes: [] },
  };

  let registerShouldFail = false;
  const service = createFileViewerService({
    getState: () => state,
    render: () => {},
    getDesktopApi: () => ({
      readFile: async (p) => {
        if (p === '/repo/docs/page.html') return rawHtml;
        if (p === '/repo/docs/app.css') return 'body { color: red; }';
        if (p === '/repo/docs/pic.png') return 'data:image/png;base64,UE5H';
        if (p === '/repo/docs/chart.svg') {
          return '<svg xmlns="http://www.w3.org/2000/svg"><image href="./pic.png" /></svg>';
        }
        return null;
      },
      registerPreviewSession: async (opts) => {
        if (registerShouldFail) return null;
        return {
          token: 'tok-tier1',
          entryUrl: `hermes-preview://tok-tier1.preview/docs/page.html#${opts.entryPath ? '' : ''}`,
        };
      },
      revokePreviewSession: async (token) => {
        revokedTokens.push(token);
      },
    }),
    getGatewayClient: () => null,
    safeCopyText: async () => true,
    t: (k) => k,
  });

  // Tier 1 HTML：frameUrl 写入 openFile.preview，源码 content 字节不变
  await service.handleOpenFilePreview('/repo/docs/page.html');
  await flushUntil(() => state.openFiles.find((f) => f.path === '/repo/docs/page.html')?.preview?.frameUrl);

  const htmlEntry = state.openFiles.find((f) => f.path === '/repo/docs/page.html');
  assert.ok(htmlEntry);
  assert.equal(htmlEntry.content, rawHtml, '源码 content 必须保持原始 HTML');
  assert.equal(state.fileViewMode, 'rendered');
  assert.ok(htmlEntry.preview?.frameUrl?.startsWith('hermes-preview://tok-tier1.preview'));

  // 关闭页签主动吊销特权会话 token
  service.closeFileTab('/repo/docs/page.html');
  assert.deepEqual(revokedTokens, ['tok-tier1']);

  // Tier 2 回退（如 Mobile / 无特权协议宿主）：生成派生 inlinedHtml，原 content 依旧未变
  registerShouldFail = true;
  await service.handleOpenFilePreview('/repo/docs/page.html');
  await flushUntil(() => state.openFiles.find((f) => f.path === '/repo/docs/page.html')?.preview?.inlinedHtml);

  const tier2Entry = state.openFiles.find((f) => f.path === '/repo/docs/page.html');
  assert.equal(tier2Entry.content, rawHtml, 'Tier 2 回退不得篡改 openFile.content');
  assert.equal(tier2Entry.preview?.frameUrl, undefined);
  assert.ok(tier2Entry.preview?.inlinedHtml?.includes('body { color: red; }'));
  assert.ok(tier2Entry.preview?.inlinedHtml?.includes('data:image/png;base64,UE5H'));

  // SVG 相对 <image> 自动生成 inlinedImageUrl，保持原始 SVG XML 不变
  await service.handleOpenFilePreview('/repo/docs/chart.svg');
  await flushUntil(() => state.openFiles.find((f) => f.path === '/repo/docs/chart.svg')?.preview?.inlinedImageUrl);

  const svgEntry = state.openFiles.find((f) => f.path === '/repo/docs/chart.svg');
  assert.equal(
    svgEntry.content,
    '<svg xmlns="http://www.w3.org/2000/svg"><image href="./pic.png" /></svg>',
  );
  assert.ok(svgEntry.preview?.inlinedImageUrl?.startsWith('data:image/svg+xml;base64,'));
});

test('createPreviewAssetCoordinator: bindMarkdownContainer 异步 DOM 水合、锚点跳转、相对文档点击与灯箱', async () => {
  const openedFiles = [];
  const lightboxCalls = [];
  let scrolledTo = '';

  const state = {
    openFiles: [
      {
        path: '/repo/docs/readme.md',
        content: '# Doc\n![Img](./a.png)',
      },
    ],
    activeFilePath: '/repo/docs/readme.md',
    gatewayUrl: '',
    profileName: 'default',
    activeSessionId: 's1',
    sessionCwds: { s1: '/repo' },
    messages: [],
  };

  let renderCalled = 0;
  const coordinator = createPreviewAssetCoordinator({
    getState: () => state,
    render: () => {
      renderCalled += 1;
    },
    getDesktopApi: () => ({
      readFile: async (p) => {
        if (p === '/repo/docs/poster.jpg') return 'data:image/jpeg;base64,UE9TVEVS';
        if (p === '/repo/docs/a2x.png') return 'data:image/png;base64,QTJY';
        return null;
      },
    }),
    getGatewayClient: () => null,
    resolveMediaUrl: async (p) => {
      if (p === '/repo/docs/a.png') return 'data:image/png;base64,QUFB';
      if (p === '/repo/docs/poster.jpg') return 'data:image/jpeg;base64,UE9TVEVS';
      if (p === '/repo/docs/a2x.png') return 'data:image/png;base64,QTJY';
      return null;
    },
    onOpenFilePreview: async (p) => {
      openedFiles.push(p);
    },
    onOpenMediaLightbox: (items, idx) => {
      lightboxCalls.push({ items, idx });
    },
  });

  function makeInteractiveEl(tagName, attrs = {}) {
    const attrMap = new Map(Object.entries(attrs));
    const classes = new Set((attrs.class || '').split(/\s+/).filter(Boolean));
    const node = {
      tagName,
      id: attrs.id || '',
      classList: {
        add: (c) => classes.add(c),
        remove: (c) => classes.delete(c),
        has: (c) => classes.has(c),
      },
      getAttribute: (k) => (attrMap.has(k) ? attrMap.get(k) : null),
      setAttribute: (k, v) => attrMap.set(k, v),
      scrollIntoView: () => {
        scrolledTo = attrs.id || '';
      },
      closest(sel) {
        if (sel === 'a[data-preview-anchor]' && attrMap.has('data-preview-anchor')) return node;
        if (sel === 'a[data-preview-file]' && attrMap.has('data-preview-file')) return node;
        if (sel === '.md-inline-image[data-media-src]' && classes.has('md-inline-image') && attrMap.has('data-media-src')) {
          return node;
        }
        return null;
      },
    };
    return node;
  }

  const imgEl = makeInteractiveEl('IMG', {
    class: 'md-inline-image md-inline-image--pending',
    'data-preview-asset-path': '/repo/docs/a.png',
    'data-media-name': 'Img',
  });
  const missingImgEl = makeInteractiveEl('IMG', {
    class: 'md-inline-image md-inline-image--pending',
    'data-preview-asset-path': '/repo/docs/missing.png',
  });
  const srcsetEl = makeInteractiveEl('IMG', {
    'data-preview-srcset-paths': '/repo/docs/a.png|1x,/repo/docs/a2x.png|2x',
  });
  const videoEl = makeInteractiveEl('VIDEO', {
    'data-preview-poster-path': '/repo/docs/poster.jpg',
  });
  const headingEl = makeInteractiveEl('H2', { id: 'sec-1' });
  const anchorEl = makeInteractiveEl('A', { 'data-preview-anchor': 'sec-1' });
  const linkEl = makeInteractiveEl('A', { 'data-preview-file': '/repo/docs/other.md' });

  const mdContainer = {
    isConnected: true,
    getAttribute: (k) =>
      k === 'data-doc-path' ? '/repo/docs/readme.md' : k === 'data-workspace-root' ? '/repo' : null,
    querySelectorAll(sel) {
      if (sel === '[data-preview-asset-path]') return [imgEl, missingImgEl];
      if (sel === '[data-preview-poster-path]') return [videoEl];
      if (sel === '[data-preview-srcset-paths]') return [srcsetEl];
      if (sel === '[id]') return [headingEl];
      if (sel === '.md-inline-image[data-media-src]') return [imgEl];
      return [];
    },
    onclick: null,
  };

  coordinator.bindMarkdownContainer(mdContainer);
  await flushUntil(
    () =>
      Boolean(imgEl.getAttribute('src')) &&
      Boolean(srcsetEl.getAttribute('srcset')) &&
      Boolean(videoEl.getAttribute('poster')) &&
      missingImgEl.classList.has('md-inline-image--error'),
  );

  assert.equal(renderCalled, 0, 'Markdown 水合不得触发整面板 re-render 防止滚动复位');
  assert.equal(imgEl.getAttribute('src'), 'data:image/png;base64,QUFB');
  assert.equal(imgEl.classList.has('md-inline-image--pending'), false);
  assert.equal(missingImgEl.classList.has('md-inline-image--error'), true);
  assert.equal(srcsetEl.getAttribute('srcset'), 'data:image/png;base64,QUFB 1x, data:image/png;base64,QTJY 2x');
  assert.equal(videoEl.getAttribute('poster'), 'data:image/jpeg;base64,UE9TVEVS');
  assert.equal(state.openFiles[0].preview?.resolvedAssets['/repo/docs/a.png'], 'data:image/png;base64,QUFB');

  let prevented = false;
  mdContainer.onclick({
    target: anchorEl,
    preventDefault: () => { prevented = true; },
    stopPropagation: () => {},
  });
  assert.equal(prevented, true);
  assert.equal(scrolledTo, 'sec-1');

  mdContainer.onclick({
    target: linkEl,
    preventDefault: () => {},
    stopPropagation: () => {},
  });
  assert.deepEqual(openedFiles, ['/repo/docs/other.md']);

  mdContainer.onclick({
    target: imgEl,
    preventDefault: () => {},
    stopPropagation: () => {},
  });
  assert.equal(lightboxCalls.length, 1);
  assert.equal(lightboxCalls[0].items[0].src, 'data:image/png;base64,QUFB');
});

test('createMediaResolver & MobileShellCoordinator: 音频与原生 SVG 解析 + workspaceRoot / preview 同步', async () => {
  const state = {
    gatewayUrl: '',
    profileName: 'default',
    activeSessionId: 's1',
    sessionCwds: { s1: '/repo' },
    messages: [],
    profiles: [],
    sessions: [],
    groupRooms: [],
    activeFocus: { type: 'session', id: 's1', botName: 'default' },
    activeBotName: 'default',
    isStreaming: false,
    selectedModel: 'm',
    availableModels: [],
    modelDetails: [],
    attachments: [],
    dockNotice: '',
    gitDiffs: [],
    openFiles: [],
    artifacts: [],
    fileTreeState: { status: 'ready', rootPath: '/repo', source: 'local_fs', nodes: [] },
    fileTreeExpandedPaths: new Set(),
    fileTreeFilterQuery: '',
    activeFilePath: '',
    memories: [],
    learningState: { status: 'idle', nodes: [], edges: [] },
    learningDetail: { status: 'idle', nodeId: null, detail: null },
    sideAgentCapsules: [],
    settingsMcp: { status: 'ready', data: [] },
    settingsSkills: { status: 'ready', data: [] },
    settingsSnapshot: {},
    theme: 'obsidian-gold',
    lang: 'zh',
  };

  const resolver = createMediaResolver({
    getState: () => state,
    getDesktopApi: () => ({
      readFile: async (p) => {
        if (p === '/repo/clip.mp3') return 'data:audio/mpeg;base64,SUQz';
        if (p === '/repo/pic.svg') return '<svg xmlns="http://www.w3.org/2000/svg"><circle cx="1" cy="1" r="1"/></svg>';
        return null;
      },
    }),
    getGatewayClient: () => null,
  });

  const audioUrl = await resolver.resolveMediaUrl('/repo/clip.mp3');
  assert.equal(audioUrl, 'data:audio/mpeg;base64,SUQz');

  const svgUrl = await resolver.resolveMediaUrl('/repo/pic.svg');
  assert.ok(svgUrl?.startsWith('data:image/svg+xml;base64,'));

  let lastSnapshot = null;
  const mobileCoord = createMobileShellCoordinator({
    getState: () => state,
    render: () => {},
    leftRailController: {
      decorateRailProfiles: () => [],
      decorateRailGroups: () => [],
      decorateRailSessions: () => [],
    },
    resolveAgentAvatar: () => '',
    selectSession: async () => {},
    openBotChat: async () => {},
    openGroupRoom: async () => {},
    createNewSession: async () => null,
    renameSession: async () => {},
    pinSession: async () => {},
    archiveSession: async () => {},
    deleteSession: async () => {},
    createGroupRoom: async () => null,
    confirmGroupRename: async () => {},
    disbandGroupRoom: async () => {},
    fetchGroupRooms: async () => {},
    routeSend: async () => {},
    sendGroupMessage: async () => {},
    interruptTurn: async () => {},
    switchModel: async () => {},
    getSettingsSnapshot: () => ({}),
    createSettingsActions: () => ({}),
    ensureSettingsSectionData: () => {},
    copyText: async () => true,
    openWorkspaceFile: async (p) => {
      state.openFiles.push({
        path: p,
        content: '<html><img src="./a.png"></html>',
        preview: { inlinedHtml: '<html><img src="data:image/png;base64,QQ=="></html>' },
      });
    },
    mountShell: (_host, getSnapshot) => {
      lastSnapshot = getSnapshot();
      return {
        update: () => {
          lastSnapshot = getSnapshot();
        },
        unmount: () => {},
      };
    },
  });

  mobileCoord.renderMobileShell({});
  assert.equal(lastSnapshot.workspaceRoot, '/repo');

  mobileCoord.getActions().onSelectInspectorTab('files');
  await mobileCoord.openFileInReader('/repo/docs/report.html');
  const latestSnap = mobileCoord.buildSnapshot();
  assert.equal(latestSnap.inspectorReaderItem?.content, '<html><img src="./a.png"></html>');
  assert.equal(
    latestSnap.inspectorReaderItem?.preview?.inlinedHtml,
    '<html><img src="data:image/png;base64,QQ=="></html>',
  );

  // 再次 buildSnapshot 验证 preview/content 未变化时复用同对象，以及 isLoading 时保留旧内容
  const repeatedSnap = mobileCoord.buildSnapshot();
  assert.equal(repeatedSnap.inspectorReaderItem?.preview?.inlinedHtml, latestSnap.inspectorReaderItem?.preview?.inlinedHtml);
  state.openFiles[0].isLoading = true;
  state.openFiles[0].content = '';
  const loadingSnap = mobileCoord.buildSnapshot();
  assert.equal(loadingSnap.inspectorReaderItem?.content, '<html><img src="./a.png"></html>');
  state.openFiles[0].isLoading = false;
  state.openFiles[0].content = '<html><img src="./updated.png"></html>';
  const loadedSnap = mobileCoord.buildSnapshot();
  assert.equal(loadedSnap.inspectorReaderItem?.content, '<html><img src="./updated.png"></html>');

  // inspectorDomHelper: cwd 优先与 fileTreeState.rootPath 兜底及状态未就绪分支
  const propsWithCwd = buildInspectorProps(state, false);
  assert.equal(propsWithCwd.workspaceRoot, '/repo');
  const propsFromTree = buildInspectorProps(
    {
      ...state,
      sessionCwds: {},
      fileTreeState: { status: 'ready', rootPath: '/tree-root', source: 'local_fs', nodes: [] },
    },
    false,
  );
  assert.equal(propsFromTree.workspaceRoot, '/tree-root');
  const propsNoRoot = buildInspectorProps(
    {
      ...state,
      sessionCwds: {},
      fileTreeState: undefined,
    },
    true,
  );
  assert.equal(propsNoRoot.workspaceRoot, undefined);

  // mediaResolver: audio 缺失/命中、binary/tooLarge/directory 返回 null
  const audioMiss = await resolver.resolveMediaUrl('/repo/missing-audio.mp3');
  assert.equal(audioMiss, null);
  const resolved = await resolver.resolveMediaUrl('/repo/bin.mp3');
  assert.equal(resolved, null);
  const resolverExtra = createMediaResolver({
    getState: () => state,
    getGatewayClient: () => null,
    getDesktopApi: () => ({
      readFile: async (p) => {
        if (p === '/repo/voice.mp3') return 'data:audio/mpeg;base64,SUQz';
        if (p === '/repo/bin.exe') return '\u0000MZ';
        if (p === '/repo/big.txt') return 'x'.repeat(2 * 1024 * 1024);
        return '';
      },
    }),
  });
  assert.equal(await resolverExtra.resolveMediaUrl('/repo/voice.mp3'), 'data:audio/mpeg;base64,SUQz');
  assert.equal(await resolverExtra.resolveMediaUrl('/repo/bin.exe'), null);
  assert.equal(await resolverExtra.resolveMediaUrl('/repo/big.txt'), null);
  const emptyMedia = await resolver.resolveMediaUrl('/repo/empty.png');
  assert.equal(emptyMedia, null);
});

test('previewAssetCoordinator & fileViewerService: 更新已打开页签撤销旧会话、并发竞态丢弃、群聊配置与绑定边界', async () => {
  const revoked = [];
  let pendingResolver = null;
  let currentHtml = '<html><img src="./a.png"></html>';
  let throwOnRegister = false;

  const state = {
    inspectorCollapsed: true,
    inspectorFullscreen: false,
    activeInspectorTab: 'files',
    activeFocus: { type: 'group', id: 'g1', botName: '' },
    activeFilePath: '',
    fileViewMode: 'raw',
    fileShowLineNumbers: false,
    fileSearchOpen: false,
    fileSearchQuery: '',
    openFiles: [],
    artifacts: [],
    gatewayUrl: '',
    gatewayConnected: true,
    profileName: 'bot-x',
    activeSessionId: '',
    sessionCwds: {},
    messages: [],
    rightPodMode: { kind: 'closed' },
    fileTreeState: { status: 'ready', rootPath: '/ws-root', source: 'local_fs', nodes: [] },
  };

  let tokSeq = 0;
  const service = createFileViewerService({
    getState: () => state,
    render: () => {},
    getDesktopApi: () => ({
      readFile: async (p) => {
        if (p === '/ws-root/page.html') return currentHtml;
        if (p === '/ws-root/a.png') return 'data:image/png;base64,QQ==';
        if (p === '/ws-root/pure.svg') return '<svg xmlns="http://www.w3.org/2000/svg"><circle cx="1" cy="1" r="1"/></svg>';
        if (p === '/ws-root/empty.html') return '   ';
        return null;
      },
      registerPreviewSession: () => {
        if (throwOnRegister) return Promise.reject(new Error('ipc down'));
        tokSeq += 1;
        const tok = `tok-${tokSeq}`;
        if (pendingResolver) {
          return new Promise((resolve) => {
            pendingResolver = () => resolve({ token: tok, entryUrl: `hermes-preview://${tok}.preview/page.html` });
          });
        }
        return Promise.resolve({ token: tok, entryUrl: `hermes-preview://${tok}.preview/page.html` });
      },
      revokePreviewSession: async (t) => {
        revoked.push(t);
      },
    }),
    getGatewayClient: () => null,
    safeCopyText: async () => true,
    t: (k) => k,
  });

  // 打开并在内容变化后重载 -> 旧 token 必须被撤销
  await service.handleOpenFilePreview('/ws-root/page.html');
  await flushUntil(() => state.openFiles.find((f) => f.path === '/ws-root/page.html')?.preview?.previewToken === 'tok-1');

  currentHtml = '<html><img src="./b.png"></html>';
  await service.handleOpenFilePreview('/ws-root/page.html');
  await flushUntil(() => state.openFiles.find((f) => f.path === '/ws-root/page.html')?.preview?.previewToken === 'tok-2');
  assert.ok(revoked.includes('tok-1'));

  // 竞态撤销：registerPreviewSession 尚未返回前关闭页签 -> 过期 token 立即吊销
  pendingResolver = true;
  currentHtml = '<html>race</html>';
  await service.handleOpenFilePreview('/ws-root/page.html');
  const finishRace = pendingResolver;
  service.closeFileTab('/ws-root/page.html');
  finishRace();
  await flushUntil(() => revoked.includes('tok-3'));
  assert.ok(revoked.includes('tok-3'));

  // registerPreviewSession 抛错降级到 Tier 2，以及纯 SVG/空白 HTML 快速退出
  pendingResolver = null;
  throwOnRegister = true;
  currentHtml = '<html><img src="./a.png"></html>';
  await service.handleOpenFilePreview('/ws-root/page.html');
  await flushUntil(() => state.openFiles.find((f) => f.path === '/ws-root/page.html')?.preview?.inlinedHtml);
  await service.handleOpenFilePreview('/ws-root/pure.svg');
  await service.handleOpenFilePreview('/ws-root/empty.html');
  await flushUntil(() => state.openFiles.length >= 3);

  // 0. 同内容但 source 变化（local_fs -> gateway_api）也必须吊销旧预览并重建 + bindFileViewerEvents
  throwOnRegister = false;
  await service.handleOpenFilePreview('/ws-root/page.html');
  await flushUntil(() => state.openFiles.find((f) => f.path === '/ws-root/page.html')?.preview?.previewToken === 'tok-4');
  const oldPreviewTarget = state.openFiles.find((f) => f.path === '/ws-root/page.html');
  if (oldPreviewTarget) {
    oldPreviewTarget.source = 'gateway_api';
  }
  await service.handleOpenFilePreview('/ws-root/page.html');
  await flushUntil(() => state.openFiles.find((f) => f.path === '/ws-root/page.html')?.preview?.previewToken === 'tok-5');
  assert.ok(revoked.includes('tok-4'));

  const prevGlobalDoc = globalThis.document;
  let boundContainer = false;
  globalThis.document = {
    getElementById: () => null,
    querySelectorAll: (sel) => {
      if (sel === '.inspector-rendered-markdown') {
        boundContainer = true;
        return [{ isConnected: true, getAttribute: () => null, querySelectorAll: () => [] }];
      }
      return [];
    },
  };
  try {
    service.bindEvents();
  } finally {
    globalThis.document = prevGlobalDoc;
  }
  assert.equal(boundContainer, true);

  let rejectRegister = false;
  let returnNullRegister = false;
  let failRevoke = false;
  let blockRegister = null;
  let mediaThrow = false;
  let tokenNum = 0;
  let openedFromClick = '';
  const coordState = {
    openFiles: [
      {
        path: '/ws-root/doc.md',
        content: 'body',
        preview: { resolvedAssets: { '/ws-root/cached.png': 'data:image/png;base64,Q0FD' } },
      },
      { path: '/ws-root/noext', content: 'plain' },
      { path: '/ws-root/skip.ts', content: 'const x = 1;' },
      { path: '/ws-root/vid.html', content: 'x', isBinary: true },
      { path: '/ws-root/plain.html', content: '<div>no-rel</div>' },
      { path: '/ws-root/mut.html', content: '<img src="./uncached.png">' },
    ],
    activeFocus: { type: 'group', id: 'g1', botName: '' },
    gatewayUrl: '',
    profileName: 'p',
    activeSessionId: '',
    sessionCwds: {},
    fileTreeState: { status: 'ready', rootPath: '/ws-root', source: 'local_fs', nodes: [] },
    messages: [],
  };
  const coord = createPreviewAssetCoordinator({
    getState: () => coordState,
    render: () => {},
    getDesktopApi: () => ({
      registerPreviewSession: () => {
        if (returnNullRegister) return Promise.resolve(null);
        if (rejectRegister) return Promise.reject(new Error('ipc reject'));
        if (blockRegister) {
          return new Promise((resolve, reject) => {
            blockRegister = { resolve, reject };
          });
        }
        tokenNum += 1;
        return Promise.resolve({ token: `t-${tokenNum}`, entryUrl: `hermes-preview://t-${tokenNum}.preview/a.html` });
      },
      revokePreviewSession: (tok) => {
        revoked.push(tok);
        if (failRevoke) return Promise.reject(new Error('revoke err'));
        return Promise.resolve(true);
      },
      resolveMediaStreamUrl: async () => 'hermes-media://local/v.mp4',
      readFile: async (p) => {
        if (p === '/ws-root/uncached.png') return 'data:image/png;base64,VU5D';
        if (p === '/ws-root/pic2.png') return 'data:image/png;base64,UElDMg==';
        if (p === '/ws-root/err.png') throw new Error('read err');
        return null;
      },
    }),
    getGatewayClient: () => null,
    resolveMediaUrl: async (p) => {
      if (mediaThrow) throw new Error('media err');
      if (p === '/ws-root/fast.png') return 'data:image/png;base64,RkFTVA==';
      return null;
    },
    onOpenFilePreview: async (p) => {
      openedFromClick = p;
    },
  });
  await coord.prepareOpenFilePreview('');
  await coord.prepareOpenFilePreview('/ws-root/noext');
  await coord.prepareOpenFilePreview('/ws-root/skip.ts');
  await coord.prepareOpenFilePreview('/ws-root/vid.html');
  // Markdown 无 initial preview + 无 workspaceRoot 场景
  coordState.fileTreeState = { status: 'idle' };
  coordState.openFiles.push({ path: '/ws-root/md-fresh.md', content: '# md' });
  await coord.prepareOpenFilePreview('/ws-root/md-fresh.md');
  coordState.fileTreeState = { status: 'ready', rootPath: '/ws-root', source: 'local_fs', nodes: [] };
  await coord.prepareOpenFilePreview('/ws-root/doc.md');
  assert.equal(coordState.openFiles[0].preview?.workspaceRoot, '/ws-root');
  coord.revokeOpenFilePreview('');
  coord.revokeOpenFilePreview('/ws-root/never');

  // 多次 prepare 更换 token（旧 token 自动撤销）+ session 焦点空 profileName / 非 ready treeState + 内容变更取消
  coordState.activeFocus = { type: 'session', id: 's1', botName: '' };
  coordState.profileName = '';
  coordState.fileTreeState = { status: 'ready', rootPath: '', source: 'local_fs', nodes: [] };
  coordState.openFiles.push({ path: '/ws-root/a.html', content: '<html>ok</html>' });
  await coord.prepareOpenFilePreview('/ws-root/a.html');
  await coord.prepareOpenFilePreview('/ws-root/a.html');
  assert.ok(revoked.includes('t-1'));

  // 阻塞 registerPreviewSession 后 revoke -> 触发 line 196 撤销检查
  blockRegister = true;
  const inflightRevoke = coord.prepareOpenFilePreview('/ws-root/plain.html');
  const regHooks = blockRegister;
  coord.revokeOpenFilePreview('/ws-root/plain.html');
  regHooks.reject(new Error('late reject'));
  await inflightRevoke;
  blockRegister = null;

  // Tier 2 构建期间 content 被外部修改 -> findCurrentTarget() 返回 undefined (lines 139, 214)
  rejectRegister = true;
  const mutTask = coord.prepareOpenFilePreview('/ws-root/mut.html');
  coordState.openFiles.find((f) => f.path === '/ws-root/mut.html').content = 'changed';
  await mutTask;

  // registerPreviewSession 拒绝 -> Tier 2 且内容不变时 plain.html 不重设 preview；blocked.html 只改写拦截源码 (inlinedCount===0, html !== entryContent)
  coordState.fileTreeState = { status: 'idle' };
  await coord.prepareOpenFilePreview('/ws-root/plain.html');
  coordState.openFiles.push({ path: '/ws-root/blocked.html', content: '<img src="../.env">' });
  await coord.prepareOpenFilePreview('/ws-root/blocked.html');
  assert.ok(coordState.openFiles.find((f) => f.path === '/ws-root/blocked.html')?.preview?.inlinedHtml?.includes('src=""'));
  rejectRegister = false;

  const makeEl = (assetPath) => ({
    tagName: 'IMG',
    classList: { add(c) { this.lastClass = c; }, remove() {}, lastClass: '' },
    getAttribute: (k) => (k === 'data-preview-asset-path' ? assetPath : null),
    setAttribute(k, v) { if (k === 'src') this.src = v; },
    closest: () => null,
  });
  const cachedImg = makeEl('/ws-root/cached.png');
  const uncachedImg = makeEl('/ws-root/uncached.png');
  const fastImg = makeEl('/ws-root/fast.png');
  const errImg = makeEl('/ws-root/err.png');
  const clickDocEl = { closest: (sel) => (sel === 'a[data-preview-file]' ? { getAttribute: () => '/ws-root/next.md' } : null) };
  const mdContainer = {
    isConnected: true,
    getAttribute: (k) => (k === 'data-doc-path' ? '/ws-root/doc.md' : null),
    querySelectorAll: (sel) => (sel === '[data-preview-asset-path]' ? [cachedImg, uncachedImg, fastImg, errImg] : []),
  };
  coord.bindMarkdownContainer(mdContainer);
  mdContainer.onclick({ target: clickDocEl, preventDefault() {}, stopPropagation() {} });
  assert.equal(openedFromClick, '/ws-root/next.md');
  await flushUntil(() => Boolean(cachedImg.src) && Boolean(uncachedImg.src) && Boolean(fastImg.src) && Boolean(errImg.classList.lastClass));
  assert.equal(cachedImg.src, 'data:image/png;base64,Q0FD');
  assert.equal(uncachedImg.src, 'data:image/png;base64,VU5D');
  assert.equal(fastImg.src, 'data:image/png;base64,RkFTVA==');
  assert.equal(errImg.classList.lastClass, 'md-inline-image--error');

  // 重复水合相同 resolvedAsset 不重写入 + 无 data-doc-path + 目标文件已移除 + resolveMediaUrl 抛错走 catch
  const repeatFastImg = makeEl('/ws-root/fast.png');
  coord.bindMarkdownContainer({
    isConnected: true,
    getAttribute: (k) => (k === 'data-doc-path' ? '/ws-root/doc.md' : null),
    querySelectorAll: (sel) => (sel === '[data-preview-asset-path]' ? [repeatFastImg] : []),
  });
  await flushUntil(() => Boolean(repeatFastImg.src));

  mediaThrow = true;
  const noDocImg = makeEl('/ws-root/pic2.png');
  coord.bindMarkdownContainer({
    isConnected: true,
    getAttribute: () => null,
    querySelectorAll: (sel) => (sel === '[data-preview-asset-path]' ? [noDocImg] : []),
  });
  await flushUntil(() => noDocImg.classList.lastClass === 'md-inline-image--error');
  assert.equal(noDocImg.classList.lastClass, 'md-inline-image--error');
  mediaThrow = false;

  // 无 data-doc-path 但成功解析，以及 md-fresh.md 携带 gatewayUrl/activeSessionId 与无 preview 时 recordResolvedAsset 补全
  const noDocOkImg = makeEl('/ws-root/pic2.png');
  coord.bindMarkdownContainer({
    isConnected: true,
    getAttribute: () => null,
    querySelectorAll: (sel) => (sel === '[data-preview-asset-path]' ? [noDocOkImg] : []),
  });
  await flushUntil(() => noDocOkImg.src === 'data:image/png;base64,UElDMg==');

  coordState.openFiles.push({ path: '/ws-root/md-no-prev.md', content: 'hi' });
  coordState.gatewayUrl = 'http://127.0.0.1:8765';
  coordState.activeSessionId = 'sess-coord';
  const freshMdImg = makeEl('/ws-root/uncached.png');
  coord.bindMarkdownContainer({
    isConnected: true,
    getAttribute: (k) => (k === 'data-doc-path' ? '/ws-root/md-no-prev.md' : null),
    querySelectorAll: (sel) => (sel === '[data-preview-asset-path]' ? [freshMdImg] : []),
  });
  await flushUntil(() => Boolean(freshMdImg.src));
  assert.equal(coordState.openFiles.find((f) => f.path === '/ws-root/md-no-prev.md')?.preview?.resolvedAssets['/ws-root/uncached.png'], 'data:image/png;base64,VU5D');

  coordState.fileTreeState = { status: 'idle' };
  coordState.openFiles.push({ path: '/ws-root/md-with-prev-empty-ws.md', content: 'hi', preview: { resolvedAssets: {} } });
  const emptyWsPrevImg = makeEl('/ws-root/uncached.png');
  coord.bindMarkdownContainer({
    isConnected: true,
    getAttribute: (k) => (k === 'data-doc-path' ? '/ws-root/md-with-prev-empty-ws.md' : null),
    querySelectorAll: (sel) => (sel === '[data-preview-asset-path]' ? [emptyWsPrevImg] : []),
  });
  await flushUntil(() => Boolean(emptyWsPrevImg.src));

  // 最小 coordinator（省略 onOpenFilePreview / desktopApi 缺席 / resolveMediaUrl 缺席）
  const coordMin = createPreviewAssetCoordinator({
    getState: () => coordState,
    render: () => {},
    getDesktopApi: () => undefined,
    getGatewayClient: () => null,
  });
  const minImg = makeEl('/ws-root/uncached.png');
  const minContainer = {
    isConnected: true,
    getAttribute: () => null,
    querySelectorAll: (sel) => (sel === '[data-preview-asset-path]' ? [minImg] : []),
  };
  coordMin.bindMarkdownContainer(minContainer);
  minContainer.onclick({ target: clickDocEl, preventDefault() {}, stopPropagation() {} });
  await flushUntil(() => minImg.classList.lastClass === 'md-inline-image--error');

  // doc.md 已有 preview.workspaceRoot 时：无 workspaceRoot 仍保留旧 workspaceRoot + HTML registerPreviewSession 带 workspaceRoot/gatewayUrl 及返回 null 回落 Tier 2
  coordState.fileTreeState = { status: 'ready', rootPath: '/ws-root', source: 'local_fs', nodes: [] };
  await coord.prepareOpenFilePreview('/ws-root/doc.md');
  coordState.fileTreeState = { status: 'idle' };
  await coord.prepareOpenFilePreview('/ws-root/doc.md');
  const docPic2 = makeEl('/ws-root/pic2.png');
  coord.bindMarkdownContainer({
    isConnected: true,
    getAttribute: (k) => (k === 'data-doc-path' ? '/ws-root/doc.md' : null),
    querySelectorAll: (sel) => (sel === '[data-preview-asset-path]' ? [docPic2] : []),
  });
  await flushUntil(() => docPic2.src === 'data:image/png;base64,UElDMg==');

  coordState.fileTreeState = { status: 'ready', rootPath: '/ws-root', source: 'local_fs', nodes: [] };
  await coord.prepareOpenFilePreview('/ws-root/a.html');
  returnNullRegister = true;
  await coord.prepareOpenFilePreview('/ws-root/plain.html');
  returnNullRegister = false;

  // doc.md 移除时 recordResolvedAsset 安全返回
  coordState.openFiles = coordState.openFiles.filter((f) => f.path !== '/ws-root/doc.md');
  const removedDocImg = makeEl('/ws-root/uncached.png');
  coord.bindMarkdownContainer({
    isConnected: true,
    getAttribute: (k) => (k === 'data-doc-path' ? '/ws-root/doc.md' : null),
    querySelectorAll: (sel) => (sel === '[data-preview-asset-path]' ? [removedDocImg] : []),
  });
  await flushUntil(() => Boolean(removedDocImg.src));

  failRevoke = true;
  coord.revokeAll();
  assert.ok(revoked.includes('t-2'));
});

test('resolveEffectiveScopeRoot & createFileViewerService: 工作区外文档独立作用域与可播放音频预览', async () => {
  assert.equal(resolveEffectiveScopeRoot('', '/ws'), '/ws');
  assert.equal(resolveEffectiveScopeRoot('docs/a.md', '/ws'), '/ws');
  assert.equal(resolveEffectiveScopeRoot('/ws/docs/a.md', '/ws'), '/ws');
  assert.equal(resolveEffectiveScopeRoot('/ext/deliverable/doc.md', '/ws'), '/ext/deliverable');
  assert.equal(resolveEffectiveScopeRoot('C:\\ext\\deliverable\\doc.md', 'D:\\ws'), 'C:/ext/deliverable');

  const extHtml = '<html><head><link rel="stylesheet" href="../secret.css"></head><body><img src="./chart.png"><img src="/ws/secret.png"></body></html>';
  const extSvg = '<svg xmlns="http://www.w3.org/2000/svg"><image href="./icon.png" /><image href="../secret.png" /></svg>';
  const extState = {
    inspectorCollapsed: false,
    inspectorFullscreen: false,
    activeInspectorTab: 'files',
    activeFilePath: '',
    fileViewMode: 'raw',
    fileShowLineNumbers: false,
    fileSearchOpen: false,
    fileSearchQuery: '',
    openFiles: [
      { id: 'f-ext-html', path: '/ext/deliverable/report.html', content: extHtml, source: 'local_fs' },
      { id: 'f-ext-svg', path: '/ext/deliverable/badge.svg', content: extSvg, isImage: true, source: 'local_fs' },
      { id: 'f-ext-md', path: '/ext/deliverable/doc.md', content: '![pic](./pic.png)', source: 'local_fs' },
    ],
    artifacts: [],
    gatewayUrl: '',
    gatewayConnected: true,
    profileName: 'default',
    activeSessionId: 's1',
    sessionCwds: { s1: '/ws' },
    messages: [],
    rightPodMode: { kind: 'files' },
    fileTreeState: {
      status: 'ready',
      rootPath: '/ws',
      source: 'local_fs',
      nodes: [
        { name: 'media', path: 'media', type: 'directory', children: [{ name: 'missing.wav', path: 'media/missing.wav', type: 'file', size: 2048 }] },
      ],
    },
  };

  let proxyBase = '';
  const desktopApiMock = {
    readFile: async (p) => {
      if (p === '/ext/deliverable/chart.png') return 'data:image/png;base64,Q0hBUlQ=';
      if (p === '/ext/deliverable/icon.png') return 'data:image/png;base64,SUNPTg==';
      if (p === '/ext/deliverable/pic.png') return 'data:image/png;base64,UElD';
      if (p === '/ws/media/clip.mp3' || p === 'media/clip.mp3') {
        return 'data:audio/mpeg;base64,SUQz';
      }
      if (p === '/ws/secret.png' || p === '/ext/secret.png' || p === '/ext/secret.css') {
        return 'data:image/png;base64,U0VDUkVU';
      }
      return null;
    },
    readFileBinary: async (p) => {
      if (p === '/ws/media/clip.mp3' || p === 'media/clip.mp3') {
        return { dataUrl: 'data:audio/mpeg;base64,SUQz', byteSize: 4 };
      }
      return null;
    },
    httpProxy: async ({ url, path: reqPath }) => {
      proxyBase = `${url || ''}${reqPath || ''}`;
      if (proxyBase.includes('gw.ogg') && proxyBase.includes('/api/fs/read-data-url')) {
        return 'data:audio/ogg;base64,T2dn';
      }
      return '';
    },
  };

  const blockedOnlySvg = '<svg xmlns="http://www.w3.org/2000/svg"><image href="../.env" /></svg>';
  extState.openFiles.push({ id: 'f-svg-blk', path: '/ext/deliverable/blocked-only.svg', content: blockedOnlySvg, isImage: true, source: 'local_fs' });
  const mediaResolverCalls = [];
  const extCoord = createPreviewAssetCoordinator({
    getState: () => extState,
    render: () => {},
    getDesktopApi: () => desktopApiMock,
    getGatewayClient: () => null,
    resolveMediaUrl: async (p) => {
      mediaResolverCalls.push(p);
      if (p === '/ext/deliverable/pic.png') return 'data:image/png;base64,TUVESUE=';
      return 'data:image/png;base64,TEVBSw==';
    },
  });

  await extCoord.prepareOpenFilePreview('/ext/deliverable/report.html');
  const htmlFile = extState.openFiles.find((f) => f.path === '/ext/deliverable/report.html');
  assert.ok(htmlFile?.preview?.inlinedHtml?.includes('data:image/png;base64,Q0hBUlQ='));
  assert.equal(htmlFile?.preview?.inlinedHtml?.includes('U0VDUkVU'), false);

  await extCoord.prepareOpenFilePreview('/ext/deliverable/badge.svg');
  const svgFile = extState.openFiles.find((f) => f.path === '/ext/deliverable/badge.svg');
  assert.ok(svgFile?.preview?.inlinedImageUrl?.startsWith('data:image/svg+xml;base64,'));

  await extCoord.prepareOpenFilePreview('/ext/deliverable/blocked-only.svg');
  const blockedSvgFile = extState.openFiles.find((f) => f.path === '/ext/deliverable/blocked-only.svg');
  assert.ok(blockedSvgFile?.preview?.inlinedImageUrl?.startsWith('data:image/svg+xml;base64,'));
  assert.equal(Buffer.from(blockedSvgFile.preview.inlinedImageUrl.split(',')[1], 'base64').toString('utf8').includes('../.env'), false);

  const makeMockImg = (assetPath) => {
    const classes = new Set(['md-inline-image--pending']);
    const node = {
      tagName: 'IMG',
      src: '',
      attrs: { 'data-preview-asset-path': assetPath },
      classList: {
        remove(c) { classes.delete(c); },
        add(c) { classes.add(c); },
        has(c) { return classes.has(c); },
      },
      getAttribute(k) { return node.attrs[k] ?? null; },
      setAttribute(k, v) { node.attrs[k] = v; if (k === 'src') node.src = v; },
      closest() { return null; },
    };
    return node;
  };
  const extPicEl = makeMockImg('/ext/deliverable/pic.png');
  const blockedWsEl = makeMockImg('/ws/secret.png');
  const blockedRelEl = makeMockImg('../secret.png');
  const blockedEtcEl = makeMockImg('/etc/passwd');
  extCoord.bindMarkdownContainer({
    isConnected: true,
    getAttribute: (k) => (k === 'data-doc-path' ? '/ext/deliverable/doc.md' : k === 'data-workspace-root' ? '/ws' : null),
    querySelectorAll: (sel) => (sel === '[data-preview-asset-path]' ? [extPicEl, blockedWsEl, blockedRelEl, blockedEtcEl] : []),
  });
  await flushUntil(
    () =>
      extPicEl.src === 'data:image/png;base64,TUVESUE=' &&
      blockedWsEl.classList.has('md-inline-image--error') &&
      blockedRelEl.classList.has('md-inline-image--error') &&
      blockedEtcEl.classList.has('md-inline-image--error'),
  );
  assert.equal(extPicEl.src, 'data:image/png;base64,TUVESUE=');
  assert.deepEqual(mediaResolverCalls, ['/ext/deliverable/pic.png']);
  assert.equal(blockedWsEl.src, '');

  const svc = createFileViewerService({
    getState: () => extState,
    render: () => {},
    getDesktopApi: () => desktopApiMock,
    getGatewayClient: () => null,
    safeCopyText: async () => true,
    t: (k) => k,
  });

  await svc.handleOpenFilePreview('media/clip.mp3');
  const localAudio = extState.openFiles.find((f) => f.path === 'media/clip.mp3');
  assert.equal(localAudio?.isBinary, false);
  assert.equal(localAudio?.source, 'local_fs');
  assert.equal(localAudio?.content, 'data:audio/mpeg;base64,SUQz');

  extState.gatewayUrl = 'http://127.0.0.1:9100';
  await svc.handleOpenFilePreview('media/gw.ogg');
  const gwAudio = extState.openFiles.find((f) => f.path === 'media/gw.ogg');
  assert.equal(gwAudio?.isBinary, false);
  assert.equal(gwAudio?.source, 'gateway_api');
  assert.equal(gwAudio?.content, 'data:audio/ogg;base64,T2dn');

  await svc.handleOpenFilePreview('https://cdn.example.com/song.mp3');
  const cdnAudio = extState.openFiles.find((f) => f.path === 'https://cdn.example.com/song.mp3');
  assert.equal(cdnAudio?.isBinary, false);
  assert.equal(cdnAudio?.source, 'remote_http');
  assert.equal(cdnAudio?.content, 'https://cdn.example.com/song.mp3');

  await svc.handleOpenFilePreview('media/missing.wav');
  const missingAudio = extState.openFiles.find((f) => f.path === 'media/missing.wav');
  assert.equal(missingAudio?.isBinary, false);
  assert.equal(missingAudio?.isTooLarge, false);
  assert.equal(missingAudio?.source, 'local_fs');
  assert.equal(missingAudio?.content, '');
  assert.equal(missingAudio?.byteSize, 2048);

  await svc.handleOpenFilePreview('../secret.mp3');
  const blockedAudio = extState.openFiles.find((f) => f.path === '../secret.mp3');
  assert.equal(blockedAudio?.content, '');
  assert.equal(blockedAudio?.source, 'fallback');

  extState.sessionCwds = {};
  extState.gatewayUrl = '';
  await svc.handleOpenFilePreview('media/clip.mp3');
  assert.equal(extState.openFiles.find((f) => f.path === 'media/clip.mp3')?.content, 'data:audio/mpeg;base64,SUQz');

  extState.fileTreeState = { status: 'idle' };
  extState.openFiles.push({
    id: 'f-rel-md',
    path: 'docs/rel-only.md',
    content: '![pic](./rel.png)',
    source: 'local_fs',
    preview: { workspaceRoot: '/ws-kept' },
  });
  await extCoord.prepareOpenFilePreview('docs/rel-only.md');
  const relMd = extState.openFiles.find((f) => f.path === 'docs/rel-only.md');
  assert.equal(relMd?.preview?.workspaceRoot, '/ws-kept');
  const relPicEl = {
    tagName: 'IMG',
    src: '',
    attrs: { 'data-preview-asset-path': 'docs/rel.png' },
    classes: new Set(['md-inline-image--pending']),
    classList: {
      remove(c) { relPicEl.classes.delete(c); },
      add(c) { relPicEl.classes.add(c); },
    },
    getAttribute(k) { return relPicEl.attrs[k] ?? null; },
    setAttribute(k, v) { relPicEl.attrs[k] = v; if (k === 'src') relPicEl.src = v; },
    closest() { return null; },
  };
  const relCoord = createPreviewAssetCoordinator({
    getState: () => extState,
    render: () => {},
    getDesktopApi: () => ({ readFile: async (p) => (p === 'docs/rel.png' ? 'data:image/png;base64,UkVM' : null) }),
    getGatewayClient: () => null,
  });
  relCoord.bindMarkdownContainer({
    isConnected: true,
    getAttribute: (k) => (k === 'data-doc-path' ? 'docs/rel-only.md' : null),
    querySelectorAll: (sel) => (sel === '[data-preview-asset-path]' ? [relPicEl] : []),
  });
  await flushUntil(() => relPicEl.src === 'data:image/png;base64,UkVM');
  assert.equal(relMd?.preview?.resolvedAssets?.['docs/rel.png'], 'data:image/png;base64,UkVM');
  assert.equal(relMd?.preview?.workspaceRoot, '/ws-kept');

  extState.openFiles.push({
    id: 'f-rel-noprev',
    path: 'docs/rel-noprev.md',
    content: '![pic](./rel.png)',
    source: 'local_fs',
  });
  const relNoPrevEl = {
    tagName: 'IMG',
    src: '',
    attrs: { 'data-preview-asset-path': 'docs/rel.png' },
    classes: new Set(['md-inline-image--pending']),
    classList: {
      remove(c) { relNoPrevEl.classes.delete(c); },
      add(c) { relNoPrevEl.classes.add(c); },
    },
    getAttribute(k) { return relNoPrevEl.attrs[k] ?? null; },
    setAttribute(k, v) { relNoPrevEl.attrs[k] = v; if (k === 'src') relNoPrevEl.src = v; },
    closest() { return null; },
  };
  relCoord.bindMarkdownContainer({
    isConnected: true,
    getAttribute: (k) => (k === 'data-doc-path' ? 'docs/rel-noprev.md' : null),
    querySelectorAll: (sel) => (sel === '[data-preview-asset-path]' ? [relNoPrevEl] : []),
  });
  await flushUntil(() => relNoPrevEl.src === 'data:image/png;base64,UkVM');
  const relNoPrevFile = extState.openFiles.find((f) => f.path === 'docs/rel-noprev.md');
  assert.equal(relNoPrevFile?.preview?.workspaceRoot, undefined);
  assert.equal(relNoPrevFile?.preview?.resolvedAssets?.['docs/rel.png'], 'data:image/png;base64,UkVM');

  extState.openFiles.push({
    id: 'f-rel-emptyprev',
    path: 'docs/rel-emptyprev.md',
    content: '![pic](./rel.png)',
    source: 'local_fs',
    preview: { revision: 1 },
  });
  const relEmptyPrevEl = {
    tagName: 'IMG',
    src: '',
    attrs: { 'data-preview-asset-path': 'docs/rel.png' },
    classes: new Set(['md-inline-image--pending']),
    classList: {
      remove(c) { relEmptyPrevEl.classes.delete(c); },
      add(c) { relEmptyPrevEl.classes.add(c); },
    },
    getAttribute(k) { return relEmptyPrevEl.attrs[k] ?? null; },
    setAttribute(k, v) { relEmptyPrevEl.attrs[k] = v; if (k === 'src') relEmptyPrevEl.src = v; },
    closest() { return null; },
  };
  relCoord.bindMarkdownContainer({
    isConnected: true,
    getAttribute: (k) => (k === 'data-doc-path' ? 'docs/rel-emptyprev.md' : null),
    querySelectorAll: (sel) => (sel === '[data-preview-asset-path]' ? [relEmptyPrevEl] : []),
  });
  await flushUntil(() => relEmptyPrevEl.src === 'data:image/png;base64,UkVM');
  assert.equal(extState.openFiles.find((f) => f.path === 'docs/rel-emptyprev.md')?.preview?.resolvedAssets?.['docs/rel.png'], 'data:image/png;base64,UkVM');

  await svc.handleOpenFilePreview('media/missing-nosize.wav');
  const missingNoSize = extState.openFiles.find((f) => f.path === 'media/missing-nosize.wav');
  assert.equal(missingNoSize?.source, 'fallback');
  assert.equal(missingNoSize?.content, '');
  assert.equal(missingNoSize?.byteSize, undefined);
});
