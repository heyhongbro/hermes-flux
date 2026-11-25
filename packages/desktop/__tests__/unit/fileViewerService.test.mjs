/**
 * 多标签文件查看器与工件工具栏服务纯单测 (File Viewer Service Unit Test)
 * (packages/desktop/__tests__/unit/fileViewerService.test.mjs)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createFileViewerService } from '../../dist/renderer/services/fileViewerService.mjs';

function createMockDeps(overrides = {}) {
  let renderCount = 0;
  const copiedTexts = [];
  const externalOpened = [];

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
    gatewayUrl: 'http://127.0.0.1:8080',
    messages: [],
    ...(overrides.state || {}),
  };

  const desktopApi = overrides.desktopApi ?? {
    openExternal: async (filePath, content) => {
      externalOpened.push({ filePath, content });
    },
    saveFile: async (payload) => {
      return { success: true };
    },
  };

  const gatewayClient = 'gatewayClient' in overrides ? overrides.gatewayClient : {
    call: async () => ({}),
  };

  const deps = {
    getState: () => state,
    render: () => {
      renderCount += 1;
    },
    getDesktopApi: () => desktopApi,
    getGatewayClient: () => gatewayClient,
    safeCopyText: async (text) => {
      copiedTexts.push(text);
      return true;
    },
    t: (key) => key,
  };

  return {
    deps,
    state,
    desktopApi,
    getRenderCount: () => renderCount,
    copiedTexts,
    externalOpened,
  };
}

test('FileViewerService: handleOpenFilePreview 展开检查舱并挂载 HTML 原型为 rendered 视图', async () => {
  const { deps, state, getRenderCount } = createMockDeps();
  const service = createFileViewerService(deps);

  await service.handleOpenFilePreview('src/mock-design.html');

  assert.equal(state.inspectorCollapsed, false);
  assert.equal(state.activeInspectorTab, 'preview');
  assert.equal(state.activeFilePath, 'src/mock-design.html');
  assert.equal(state.fileViewMode, 'rendered');
  assert.equal(state.openFiles.length, 1);
  assert.equal(state.openFiles[0].path, 'src/mock-design.html');
  assert.equal(state.artifacts.length, 1);
  assert.equal(state.artifacts[0].name, 'src/mock-design.html');
  assert.ok(getRenderCount() >= 1);
});

test('FileViewerService: switchFileTab 切换活动文件标签', () => {
  const { deps, state, getRenderCount } = createMockDeps({
    state: {
      openFiles: [
        { path: 'a.ts', content: 'const a = 1;' },
        { path: 'b.ts', content: 'const b = 2;' },
      ],
      activeFilePath: 'a.ts',
    },
  });
  const service = createFileViewerService(deps);

  service.switchFileTab('b.ts');
  assert.equal(state.activeFilePath, 'b.ts');
  assert.equal(getRenderCount(), 1);
});

test('FileViewerService: closeFileTab 平滑迁移焦点，全部关闭后自动折叠检查舱', () => {
  const { deps, state, getRenderCount } = createMockDeps({
    state: {
      inspectorCollapsed: false,
      openFiles: [
        { path: 'a.ts', content: 'a' },
        { path: 'b.ts', content: 'b' },
      ],
      artifacts: [
        { name: 'a.ts', id: 'art-1', type: 'FILE', size: '' },
        { name: 'b.ts', id: 'art-2', type: 'FILE', size: '' },
      ],
      activeFilePath: 'a.ts',
    },
  });
  const service = createFileViewerService(deps);

  // 关闭 a.ts，焦点平移到 b.ts
  service.closeFileTab('a.ts');
  assert.equal(state.openFiles.length, 1);
  assert.equal(state.artifacts.length, 1);
  assert.equal(state.activeFilePath, 'b.ts');
  assert.equal(state.inspectorCollapsed, false);

  // 关闭 b.ts，全部清空，自动折叠检查舱
  service.closeFileTab('b.ts');
  assert.equal(state.openFiles.length, 0);
  assert.equal(state.artifacts.length, 0);
  assert.equal(state.activeFilePath, '');
  assert.equal(state.inspectorCollapsed, true);
  assert.equal(getRenderCount(), 2);
});

test('FileViewerService: toggleViewMode / toggleLineNumbers 模式切换', () => {
  const { deps, state } = createMockDeps({
    state: { fileViewMode: 'rendered', fileShowLineNumbers: false },
  });
  const service = createFileViewerService(deps);

  service.toggleViewMode();
  assert.equal(state.fileViewMode, 'raw');

  service.toggleLineNumbers();
  assert.equal(state.fileShowLineNumbers, true);
});

test('FileViewerService: 检索状态机 (toggle / close / setQuery)', () => {
  const { deps, state } = createMockDeps({
    state: { fileSearchOpen: false, fileSearchQuery: '' },
  });
  const service = createFileViewerService(deps);

  service.toggleFileSearch();
  assert.equal(state.fileSearchOpen, true);

  service.setFileSearchQuery('keyword');
  assert.equal(state.fileSearchQuery, 'keyword');

  service.closeFileSearch();
  assert.equal(state.fileSearchOpen, false);
  assert.equal(state.fileSearchQuery, '');
});

test('FileViewerService: copyFileContent / copyFilePath 复制活动文件', async () => {
  const { deps, copiedTexts } = createMockDeps({
    state: {
      openFiles: [{ path: 'test.txt', content: 'Hello Content' }],
      activeFilePath: 'test.txt',
    },
  });
  const service = createFileViewerService(deps);

  await service.copyFileContent();
  assert.deepEqual(copiedTexts, ['Hello Content']);

  await service.copyFilePath();
  assert.deepEqual(copiedTexts, ['Hello Content', 'test.txt']);
});

test('FileViewerService: closeInspector / toggleInspectorFullscreen / switchInspectorTab 控制检查舱尺寸与页签', () => {
  const { deps, state } = createMockDeps({
    state: {
      inspectorCollapsed: false,
      inspectorFullscreen: false,
      activeInspectorTab: 'files',
    },
  });
  const service = createFileViewerService(deps);

  service.toggleInspectorFullscreen();
  assert.equal(state.inspectorFullscreen, true);

  service.closeInspector();
  assert.equal(state.inspectorCollapsed, true);
  assert.equal(state.inspectorFullscreen, false);

  service.switchInspectorTab('artifacts');
  assert.equal(state.activeInspectorTab, 'artifacts');
});

test('FileViewerService: 文件树加载、懒加载子目录、过滤、面板折叠及并发代数防串台', async () => {
  const treeCalls = [];
  const subDirEntries = [{ name: 'leaf.ts', path: '/ws/sub/leaf.ts', isDirectory: false }];
  let resolveRootFirst;
  let rootCallCount = 0;

  const { deps, state } = createMockDeps({
    state: {
      activeSessionId: 's1',
      profileName: 'default',
      sessions: [
        {
          id: 's1',
          cwd: '/ws',
          toolCalls: [],
        },
      ],
      projects: [],
      messages: [
        {
          toolCalls: [
            { name: 'read_file', args: { path: '/ws/fallback.md' }, output: 'ok' },
            { name: 'write_file', args: JSON.stringify({ path: '/ws/alt.md' }) },
          ],
        },
      ],
      fileTreeState: { status: 'idle' },
      fileTreeExpandedPaths: [],
      fileTreeFilterQuery: '',
      fileTreeCollapsed: false,
      fileTreeLoadedCwd: '',
      openFiles: [{ path: '/ws/sub/leaf.ts', content: 'export {};' }],
      activeFilePath: '/ws/sub/leaf.ts',
    },
    desktopApi: {
      listDirectory: async (dirPath) => {
        treeCalls.push(dirPath ?? '');
        if (!dirPath || dirPath === '/ws') {
          rootCallCount += 1;
          if (rootCallCount === 1) {
            return new Promise((r) => { resolveRootFirst = r; });
          }
          return [
            { name: 'sub', path: '/ws/sub', isDirectory: true },
            { name: 'errDir', path: '/ws/errDir', isDirectory: true },
            { name: 'README.md', path: '/ws/README.md', isDirectory: false },
          ];
        }
        if (dirPath === '/ws/sub') return subDirEntries;
        throw new Error('dir failed');
      },
    },
    gatewayClient: {
      call: async () => ({ items: [{ text: '/ws/rpc.ts' }] }),
    },
  });

  const service = createFileViewerService(deps);

  // 1. 并发代数防串台：第一次慢响应到达时必须被丢弃
  const slowLoad = service.loadFileTree();
  assert.equal(state.fileTreeState.status, 'loading');
  // 重复非强刷同 CWD 在 loading 中跳过
  await service.loadFileTree();
  const fastLoad = service.loadFileTree(true);
  await fastLoad;
  resolveRootFirst([{ name: 'stale.ts', path: '/ws/stale.ts', isDirectory: false }]);
  await slowLoad;

  assert.equal(state.fileTreeState.status, 'ready');
  assert.equal(state.fileTreeState.nodes.some((n) => n.name === 'stale.ts'), false, '迟到响应不得覆盖新世代树');
  assert.ok(state.fileTreeExpandedPaths.includes('/ws/sub'), '激活文件的祖先目录必须自动展开');

  // 非强刷同 CWD ready 态跳过
  const prevCount = treeCalls.length;
  await service.loadFileTree();
  assert.equal(treeCalls.length, prevCount);

  // 2. 折叠与懒加载子目录
  await service.toggleDirectory('/ws/sub'); // 已因祖先自动展开，先收起
  assert.equal(state.fileTreeExpandedPaths.includes('/ws/sub'), false);
  await service.toggleDirectory('/ws/sub'); // 重新展开并懒加载 sub
  assert.equal(state.fileTreeExpandedPaths.includes('/ws/sub'), true);
  const subNode = state.fileTreeState.nodes.find((n) => n.name === 'sub');
  assert.equal(subNode?.childrenLoaded, true);
  assert.equal(subNode?.children?.[0].name, 'leaf.ts');

  // 2b. 子目录全失败时记录显式告警并收敛 childrenLoaded
  const savedWarn = console.warn;
  console.warn = () => {};
  const srvNoProxy = createFileViewerService({
    ...deps,
    getDesktopApi: () => ({ listDirectory: async () => { throw new Error('errDir blocked'); } }),
    getGatewayClient: () => null,
  });
  state.fileTreeState = {
    status: 'ready',
    rootPath: '/ws',
    source: 'local_fs',
    nodes: [{ name: 'errDir', path: '/ws/errDir', isDirectory: true, childrenLoaded: false }],
  };
  await srvNoProxy.toggleDirectory('/ws/errDir');
  assert.equal(state.fileTreeState.nodes[0].childrenLoaded, true);
  console.warn = savedWarn;

  // 3. 过滤与面板折叠切换
  service.setFileTreeFilter('leaf');
  assert.equal(state.fileTreeFilterQuery, 'leaf');

  service.toggleFileTreePane();
  assert.equal(state.fileTreeCollapsed, true);
  service.toggleFileTreePane();
  assert.equal(state.fileTreeCollapsed, false);

  // 4. 右侧常驻竖栏 toggleInspectorRailTab 切换
  state.inspectorCollapsed = true;
  service.toggleInspectorRailTab('preview');
  assert.equal(state.inspectorCollapsed, false);
  service.toggleInspectorRailTab('preview');
  assert.equal(state.inspectorCollapsed, true);
  state.inspectorCollapsed = false;
  state.activeInspectorTab = 'git';
  service.toggleInspectorRailTab('preview');
  assert.equal(state.activeInspectorTab, 'preview');

  // 5. 文件树就绪且未折叠时关闭最后一个文件 Tab，保持工具窗常开以便点选下一文件
  state.openFiles = [{ path: '/ws/sub/leaf.ts', content: '' }];
  state.artifacts = [];
  state.fileTreeCollapsed = false;
  service.closeFileTab('/ws/sub/leaf.ts');
  assert.equal(state.inspectorCollapsed, false, '文件树就绪且展开时关完标签页不得折叠工具窗');
});

test('FileViewerService: 根目录报错置 error 状态，以及 RPC complete.path 通道正常接通', async () => {
  const savedWarn = console.warn;
  console.warn = () => {};
  try {
    const rpcDeps = createMockDeps({
      state: {
        sessions: [{ id: 's1', cwd: '/ws' }],
        activeSessionId: 's1',
      },
      desktopApi: {},
      gatewayClient: {
        call: async () => ({ items: [{ text: '/ws/only-rpc.ts' }] }),
      },
    });
    const rpcService = createFileViewerService(rpcDeps.deps);
    await rpcService.loadFileTree(true);
    assert.equal(rpcDeps.state.fileTreeState.status, 'ready');
    assert.equal(rpcDeps.state.fileTreeState.source, 'gateway_rpc');

    const errDeps = createMockDeps({
      desktopApi: { listDirectory: async () => { throw new Error('disk io error'); } },
      gatewayClient: null,
    });
    const errService = createFileViewerService(errDeps.deps);
    await errService.loadFileTree(true);
    assert.equal(errDeps.state.fileTreeState.status, 'error');
    assert.equal(errDeps.state.fileTreeState.message, 'disk io error');
  } finally {
    console.warn = savedWarn;
  }
});

test('FileViewerService: bindEvents DOM 控件绑定覆盖文件树过滤/刷新/目录点击/文件打开与右竖栏', async () => {
  const savedDoc = globalThis.document;
  const elements = new Map();
  const makeEl = (id, dataset = {}) => ({
    id,
    dataset,
    value: '',
    style: {},
    selectionStart: 0,
    selectionEnd: 0,
    focus() {},
    onclick: null,
    oninput: null,
    closest: () => null,
  });

  const treeFilterEl = makeEl('inspector-tree-filter-input');
  treeFilterEl.value = 'app';
  const dirEl = makeEl('dir-row', { treeDir: '/ws/src' });
  const fileEl = makeEl('file-row', { treeFile: '/ws/README.md' });
  const railBtnEl = makeEl('rail-btn', { tab: 'preview' });
  const refreshBtn = makeEl('btn-file-tree-refresh');
  const retryBtn = makeEl('btn-file-tree-retry');
  const collapseBtn = makeEl('btn-file-tree-toggle');
  const expandBtn = makeEl('btn-file-tree-expand');
  const closeSearchBtn = makeEl('btn-close-search');

  for (const el of [treeFilterEl, refreshBtn, retryBtn, collapseBtn, expandBtn, closeSearchBtn]) {
    elements.set(el.id, el);
  }

  globalThis.document = {
    getElementById: (id) => elements.get(id) ?? null,
    querySelectorAll: (sel) => {
      if (sel === '[data-tree-dir]') return [dirEl];
      if (sel === '[data-tree-file]') return [fileEl];
      if (sel === '.vertical-tab-item') return [railBtnEl];
      return [];
    },
  };

  try {
    const { deps, state } = createMockDeps({
      state: {
        inspectorCollapsed: false,
        fileTreeState: { status: 'idle' },
        sessions: [{ id: 's1', cwd: '/ws' }],
        activeSessionId: 's1',
      },
      desktopApi: {
        listDirectory: async () => [{ name: 'README.md', path: '/ws/README.md', isDirectory: false }],
        readFile: async () => '# Readme',
      },
    });
    const service = createFileViewerService(deps);
    service.bindEvents();

    // 等 bindEvents 触发的初始自动加载落定
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(state.fileTreeState.status, 'ready');

    treeFilterEl.oninput();
    assert.equal(state.fileTreeFilterQuery, 'app');

    collapseBtn.onclick();
    assert.equal(state.fileTreeCollapsed, true);
    expandBtn.onclick();
    assert.equal(state.fileTreeCollapsed, false);

    refreshBtn.onclick();
    retryBtn.onclick();
    closeSearchBtn.onclick();
    await dirEl.onclick();
    await fileEl.onclick();
    assert.equal(state.activeFilePath, '/ws/README.md');

    railBtnEl.onclick();
    assert.equal(state.inspectorCollapsed, true);
  } finally {
    globalThis.document = savedDoc;
  }
});

test('FileViewerService: 补齐目录查找/回退/加载竞态/RPC/下载与 bindEvents 全边缘分支', async () => {
  const savedWarn = console.warn;
  console.warn = () => {};
  try {
    // 1. 深度嵌套目录查找、RPC completePath（loadFileTree + toggleDirectory）及过期树守护
    let rpcDirCalls = 0;
    let resolveSubRpc;
    const { deps: d1, state: s1 } = createMockDeps({
      state: {
        sessions: [{ id: 's1', cwd: '/ws' }],
        activeSessionId: 's1',
        profileName: 'p1',
        messages: [
          { toolCalls: undefined },
          { toolCalls: [{ name: 'read_file', args: undefined, output: { raw: true } }] },
        ],
        openFiles: [{ path: 'http://127.0.0.1/remote.txt', content: `${'inspector.remoteNotice'}\nline` }],
        activeFilePath: 'http://127.0.0.1/remote.txt',
      },
      desktopApi: {
        saveFile: async () => ({ success: true }),
      },
      gatewayClient: {
        call: async (_method, _params) => {
          rpcDirCalls += 1;
          if (rpcDirCalls === 1) return { items: [{ text: '/ws/sub/deep/leaf.ts' }] };
          if (rpcDirCalls === 2) {
            return new Promise((r) => { resolveSubRpc = r; });
          }
          return null;
        },
      },
    });
    // 第一轮保留 messages（含 toolCalls: undefined 及无 args/非字符串 output）测试 collectSessionFallbackPaths
    // 同时保持 fileTreeExpandedPaths = undefined、activeFilePath = '/ws/sub/leaf.ts' 触发祖先自动展开
    s1.fileTreeExpandedPaths = undefined;
    s1.fileTreeLoadedCwd = undefined;
    s1.fileTreeState = undefined;
    s1.activeFilePath = '/ws/sub/leaf.ts';
    delete d1.getDesktopApi().listDirectory;

    const srv1 = createFileViewerService(d1);
    await srv1.loadFileTree(); // RPC Tier 3 hit

    // 第二轮测 messages=undefined、openFiles=undefined、desktopApi=undefined、rpc返回null、targetCwd='' & res.rootPath=''
    const savedRpcDeps = createMockDeps({
      state: {
        sessions: [],
        activeSessionId: '',
        profileName: '',
        gatewayUrl: '',
        messages: undefined,
        openFiles: undefined,
        fileTreeLoadedCwd: undefined,
        fileTreeState: undefined,
      },
      gatewayClient: {
        call: async () => null,
      },
    });
    savedRpcDeps.deps.getDesktopApi = () => undefined;
    const srvEmptyRpc = createFileViewerService(savedRpcDeps.deps);
    await srvEmptyRpc.loadFileTree(); // completePath 返回 null -> 全链失败 -> error
    // ready 且 fileTreeLoadedCwd=undefined 与 targetCwd='' 对齐时不重刷
    savedRpcDeps.state.fileTreeState = { status: 'ready', rootPath: '', nodes: [], source: 'local_fs' };
    savedRpcDeps.state.fileTreeLoadedCwd = undefined;
    await srvEmptyRpc.loadFileTree(false);
    // fileTreeState=loading 且 fileTreeLoadedCwd=undefined 时再次 non-force 加载直接跳过
    savedRpcDeps.state.fileTreeState = { status: 'loading' };
    savedRpcDeps.state.fileTreeLoadedCwd = undefined;
    await srvEmptyRpc.loadFileTree(false);
    // desktopApi=undefined + res.rootPath='' + targetCwd='' 分支
    const srvRootEmpty = createFileViewerService({
      ...savedRpcDeps.deps,
      getDesktopApi: () => ({ listDirectory: async () => [] }),
    });
    await srvRootEmpty.loadFileTree(true);
    assert.equal(savedRpcDeps.state.fileTreeLoadedCwd, '');

    // 嵌套目录查找与空路径防护
    await srv1.toggleDirectory('');
    s1.fileTreeState = { status: 'loading' };
    await srv1.toggleDirectory('/ws/sub');
    s1.fileTreeState = {
      status: 'ready',
      rootPath: '/ws',
      source: 'local_fs',
      nodes: [
        {
          name: 'sub',
          path: '/ws/sub',
          isDirectory: true,
          childrenLoaded: true,
          children: [
            { name: 'deep', path: '/ws/sub/deep', isDirectory: true, childrenLoaded: false },
            { name: 'deep2', path: '/ws/sub/deep2', isDirectory: true, childrenLoaded: false },
          ],
        },
        { name: 'file.ts', path: '/ws/file.ts', isDirectory: false },
      ],
    };
    await srv1.toggleDirectory('/ws/missing');
    await srv1.toggleDirectory('/ws/file.ts');
    await srv1.toggleDirectory('/ws/sub'); // childrenLoaded === true -> skip async load

    // 子目录 RPC 异步返回前被新的 loadFileTree 作废
    const pendingDeep = srv1.toggleDirectory('/ws/sub/deep');
    s1.activeSessionId = '';
    s1.profileName = '';
    await srv1.loadFileTree(true);
    resolveSubRpc({ items: [{ text: '/ws/sub/deep/late.ts' }] });
    await pendingDeep;

    // toggleDirectory 测 desktopApi=undefined 与 completion=null（activeSessionId/profileName='')
    s1.fileTreeState = {
      status: 'ready',
      rootPath: '/ws',
      source: 'local_fs',
      nodes: [{ name: 'deep2', path: '/ws/sub/deep2', isDirectory: true, childrenLoaded: false }],
    };
    const srvNoBridgeRpc = createFileViewerService({
      ...d1,
      getDesktopApi: () => undefined,
    });
    await srvNoBridgeRpc.toggleDirectory('/ws/sub/deep2');

    // 另一个 toggleDirectory 返回时 latestTree 变为 error（非 ready）
    let resolveSub2;
    const { deps: d2, state: s2 } = createMockDeps({
      state: {
        sessions: [{ id: 's2', cwd: '/ws2' }],
        activeSessionId: 's2',
        fileTreeState: {
          status: 'ready',
          rootPath: '/ws2',
          source: 'local_fs',
          nodes: [{ name: 'dir', path: '/ws2/dir', isDirectory: true, childrenLoaded: false }],
        },
      },
      desktopApi: {
        listDirectory: async () => new Promise((r) => { resolveSub2 = r; }),
      },
      gatewayClient: null,
    });
    const srv2 = createFileViewerService(d2);
    const wait2 = srv2.toggleDirectory('/ws2/dir');
    s2.fileTreeState = { status: 'error', message: 'reset' };
    resolveSub2([{ name: 'x.ts', path: '/ws2/dir/x.ts', isDirectory: false }]);
    await wait2;

    // downloadFile remoteNotice + gatewayUrl 有值/空值 两分支
    s1.openFiles = [{ path: 'remote/log.txt', content: 'inspector.remoteNotice body' }];
    s1.activeFilePath = 'remote/log.txt';
    await srv1.downloadFile();
    s1.gatewayUrl = '';
    await srv1.downloadFile();

    // downloadFile remoteNotice + http 与普通分支也保持覆盖
    s1.openFiles = [{ path: 'https://example.com/a.txt', content: 'hello' }];
    s1.activeFilePath = 'https://example.com/a.txt';
    await srv1.downloadFile();
  } finally {
    console.warn = savedWarn;
  }

  // 2. bindEvents 在 fileTreeState=loading/ready/undefined 与收起态下的自动加载判断分支
  const savedDoc = globalThis.document;
  globalThis.document = {
    getElementById: () => null,
    querySelectorAll: () => [],
  };
  try {
    const { deps: dReady, state: sReady } = createMockDeps({
      state: {
        inspectorCollapsed: false,
        sessions: [{ id: 's1', cwd: '/ws' }],
        activeSessionId: 's1',
        fileTreeLoadedCwd: undefined,
        fileTreeState: undefined,
      },
      desktopApi: { listDirectory: async () => [] },
    });
    const srvReady = createFileViewerService(dReady);
    srvReady.bindEvents();
    sReady.fileTreeState = { status: 'loading' };
    sReady.fileTreeLoadedCwd = '/ws';
    srvReady.bindEvents();
  } finally {
    globalThis.document = savedDoc;
  }
});

test('FileViewerService: 目录点击展开、远程二进制/超大文件下载卡片与 #btn-preview-download-file 交互', async () => {
  const savedDoc = globalThis.document;
  const saveCalls = [];
  const copied = [];
  const elements = new Map();
  const createdLinks = [];
  const btnPreviewDl = { onclick: null, style: {} };
  elements.set('btn-preview-download-file', btnPreviewDl);

  globalThis.document = {
    getElementById: (id) => elements.get(id) ?? null,
    querySelectorAll: () => [],
    createElement: (tag) => {
      const node = { tag, href: '', download: '', clicked: false, click() { this.clicked = true; } };
      createdLinks.push(node);
      return node;
    },
    body: {
      appendChild() {},
      removeChild() {},
    },
  };

  try {
    const { deps, state } = createMockDeps({
      state: {
        inspectorCollapsed: true,
        gatewayUrl: 'wss://remote.example.com:9119',
        profileName: 'coder',
        activeSessionId: 'sess-9',
        fileTreeState: {
          status: 'ready',
          rootPath: '/opt/data/workspace',
          source: 'gateway_api',
          nodes: [
            { name: 'memory', path: '/opt/data/workspace/memory', isDirectory: true, childrenLoaded: true, children: [] },
            { name: 'installer.exe', path: '/opt/data/workspace/installer.exe', isDirectory: false, size: 2048000 },
            { name: 'huge.log', path: '/opt/data/workspace/huge.log', isDirectory: false, size: 4 * 1024 * 1024 },
          ],
        },
        fileTreeExpandedPaths: [],
        fileTreeCollapsed: true,
        openFiles: [],
        artifacts: [],
      },
      desktopApi: {
        saveFile: async (opts) => {
          saveCalls.push(opts);
          return { success: true };
        },
        httpProxy: async ({ path: ep }) => {
          if (ep.startsWith('/api/files?path=%2Fopt%2Fdata%2Fworkspace%2FunknownDir')) {
            return { path: '/opt/data/workspace/unknownDir', entries: [] };
          }
          throw new Error('404');
        },
      },
    });
    deps.safeCopyText = async (txt) => {
      copied.push(txt);
      return true;
    };

    const service = createFileViewerService(deps);

    // 1. 点击已知目录名（从消息链接触发）-> 自动展开目录而非误建文件页签；重复触发已展开目录分支亦保持安全
    await service.handleOpenFilePreview('/opt/data/workspace/memory');
    assert.equal(state.inspectorCollapsed, false);
    assert.equal(state.fileTreeCollapsed, false);
    assert.ok(state.fileTreeExpandedPaths.includes('/opt/data/workspace/memory'));
    assert.equal(state.openFiles.length, 0);
    await service.handleOpenFilePreview('/opt/data/workspace/memory');

    // 2. 点击未知目录路径且网关 /api/files 返回 entries -> 自动转回目录展开；且当文件树尚在 idle 且 expanded 为 undefined 时亦不崩溃
    state.fileTreeState = { status: 'idle' };
    state.fileTreeExpandedPaths = undefined;
    await service.handleOpenFilePreview('/opt/data/workspace/unknownDir');
    assert.equal(state.openFiles.length, 0);
    state.fileTreeState = {
      status: 'ready',
      rootPath: '/opt/data/workspace',
      source: 'gateway_api',
      nodes: [
        { name: 'memory', path: '/opt/data/workspace/memory', isDirectory: true, childrenLoaded: true, children: [] },
        { name: 'installer.exe', path: '/opt/data/workspace/installer.exe', isDirectory: false, size: 2048000 },
        { name: 'huge.log', path: '/opt/data/workspace/huge.log', isDirectory: false, size: 4 * 1024 * 1024 },
      ],
    };
    state.fileTreeExpandedPaths = undefined;
    await service.handleOpenFilePreview('/opt/data/workspace/unknownDir');

    // 3. 打开已知 .exe 二进制文件 -> 前置阻断，带 byteSize 与 isBinary 挂载
    await service.handleOpenFilePreview('/opt/data/workspace/installer.exe');
    assert.equal(state.openFiles.length, 1);
    assert.equal(state.openFiles[0].isBinary, true);
    assert.equal(state.openFiles[0].byteSize, 2048000);

    // copyFileContent 对二进制文件保护：不以空串污染剪贴板
    await service.copyFileContent();
    assert.equal(copied.length, 0);

    // 二次打开同路径刷新现有标签页分支
    await service.handleOpenFilePreview('/opt/data/workspace/installer.exe');
    assert.equal(state.openFiles.length, 1);

    // 打开超大文件 -> isTooLarge 标记
    await service.handleOpenFilePreview('/opt/data/workspace/huge.log');
    assert.equal(state.openFiles[1].isTooLarge, true);

    // bindEvents 绑定卡片内 #btn-preview-download-file 并透传 remoteUrl（远端文件不得下传 sourcePath 防本地重名劫持）
    service.bindEvents();
    assert.ok(typeof btnPreviewDl.onclick === 'function');
    btnPreviewDl.onclick();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(saveCalls.length, 1);
    assert.equal(
      saveCalls[0].remoteUrl,
      'https://remote.example.com:9119/api/fs/download?path=%2Fopt%2Fdata%2Fworkspace%2Fhuge.log&profile=coder&session_id=sess-9',
    );
    assert.equal(saveCalls[0].sourcePath, undefined);

    // 远端 gateway_api 已读文本（如与本地同名的 package.json）下载时不得带 sourcePath，否则会静默保存本地工作区同名文件
    state.openFiles.push({
      path: 'package.json',
      content: '{"remoteName":"from-gateway"}',
      source: 'gateway_api',
    });
    state.activeFilePath = 'package.json';
    await service.downloadFile();
    assert.equal(saveCalls.length, 2);
    assert.equal(saveCalls[1].sourcePath, undefined);
    assert.equal(saveCalls[1].content, '{"remoteName":"from-gateway"}');

    // 显式传入 targetPath 时，即使 state.activeFilePath 指向别的文件也必须精确下载目标文件
    state.openFiles.push({
      path: '/ws/explicit-target.txt',
      content: 'explicit body',
      source: 'gateway_api',
    });
    await service.downloadFile('/ws/explicit-target.txt');
    assert.equal(saveCalls.length, 3);
    assert.equal(saveCalls[2].fileName, 'explicit-target.txt');
    assert.equal(saveCalls[2].content, 'explicit body');

    // 显式传入不存在路径时早退，不误下 openFiles[0]；未传参且 activeFilePath 失配时才回落 openFiles[0]
    await service.downloadFile('/ws/does-not-exist.txt');
    assert.equal(saveCalls.length, 3);
    state.activeFilePath = '/ws/non-matching.txt';
    await service.downloadFile();
    assert.equal(saveCalls.length, 4);
    assert.equal(saveCalls[3].fileName, state.openFiles[0].path.split(/[/\\]/).pop());

    // desktopApi.saveFile 显式返回失败（非 canceled）或异常兜底、以及无 saveFile 时的 0 字节防呆拦截
    const failDesktopDeps = createMockDeps({
      state: {
        gatewayUrl: '',
        openFiles: [{ path: '/ws/empty.exe', content: '', isBinary: true, source: 'local_fs' }],
        activeFilePath: '/ws/empty.exe',
      },
      desktopApi: {
        saveFile: async () => ({ success: false, error: '无法读取本地源文件' }),
      },
    });
    await createFileViewerService(failDesktopDeps.deps).downloadFile();
    assert.equal(createdLinks.length, 0, 'saveFile 显式失败时不得回落触发浏览器 0 字节 Blob 下载');

    const throwDesktopDeps = createMockDeps({
      state: {
        gatewayUrl: '',
        openFiles: [{ path: '/ws/plain.txt', content: 'fallback body', source: 'local_fs' }],
        activeFilePath: '/ws/plain.txt',
      },
      desktopApi: {
        saveFile: async () => {
          throw new Error('ipc down');
        },
      },
    });
    await createFileViewerService(throwDesktopDeps.deps).downloadFile();
    assert.equal(createdLinks.length, 1);
    assert.equal(createdLinks[0].download, 'plain.txt');
    createdLinks.length = 0;

    // 无 saveFile 时浏览器 fallback 使用 remoteUrl 与 isDataUrl 下载，并对空内容二进制/超大文件阻断 0 字节 Blob
    const browserDeps = createMockDeps({
      state: {
        gatewayUrl: 'http://127.0.0.1:9119',
        openFiles: [{ path: '/opt/data/workspace/installer.exe', content: '', isBinary: true, byteSize: 4096 }],
        activeFilePath: '/opt/data/workspace/installer.exe',
      },
      desktopApi: {},
    });
    const browserSrv = createFileViewerService(browserDeps.deps);
    await browserSrv.downloadFile();
    assert.equal(createdLinks.length, 1);
    assert.equal(createdLinks[0].download, 'installer.exe');
    assert.match(createdLinks[0].href, /\/api\/fs\/download\?path=/);

    browserDeps.state.openFiles = [{ path: 'chart.png', content: 'data:image/png;base64,AAAA' }];
    browserDeps.state.activeFilePath = 'chart.png';
    await browserSrv.downloadFile();
    assert.equal(createdLinks[1].href, 'data:image/png;base64,AAAA');

    browserDeps.state.gatewayUrl = '';
    browserDeps.state.openFiles = [
      { path: '/ws/offline.exe', content: '', isBinary: true, source: 'local_fs' },
      { path: '/ws/offline.log', content: '', isTooLarge: true, source: 'local_fs' },
    ];
    browserDeps.state.activeFilePath = '/ws/offline.exe';
    await browserSrv.downloadFile();
    browserDeps.state.activeFilePath = '/ws/offline.log';
    await browserSrv.downloadFile();
    assert.equal(createdLinks.length, 2, '空内容二进制/超大文件在无 remoteUrl 时不得产出 0 字节 Blob 下载');

    // 防无限重入死循环回归：activeCwd 为空而服务端返回非空 rootPath（如 /opt/data）时，bindEvents 不得反复重拉 loadFileTree
    let rootFetchCount = 0;
    const loopGuardDeps = createMockDeps({
      state: {
        inspectorCollapsed: false,
        gatewayUrl: 'https://remote.example.com:9119',
        sessions: [],
        projects: [],
        fileTreeState: { status: 'idle' },
        fileTreeLoadedCwd: '',
      },
      desktopApi: {
        httpProxy: async ({ path: ep }) => {
          if (ep === '/api/files') {
            rootFetchCount += 1;
            return { path: '/opt/data', entries: [{ name: 'workspace', path: '/opt/data/workspace', is_directory: true }] };
          }
          return null;
        },
      },
    });
    const loopGuardSrv = createFileViewerService(loopGuardDeps.deps);
    loopGuardDeps.deps.render = () => loopGuardSrv.bindEvents();
    loopGuardSrv.bindEvents();
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(rootFetchCount, 1, '空 CWD 解析出非空服务端 rootPath 后，bindEvents 绝不得触发第二轮死循环加载');
    assert.equal(loopGuardDeps.state.fileTreeState.rootPath, '/opt/data');
    assert.equal(loopGuardDeps.state.fileTreeLoadedCwd, '');

    // 本地工作区命中 local_fs 的 .exe 即使连着远端网关也不得生成 remoteUrl，必须仅走 sourcePath 直拷
    const localSaveCalls = [];
    const localBinDeps = createMockDeps({
      state: {
        gatewayConnected: true,
        gatewayUrl: 'https://remote.example.com:9119',
        fileTreeState: {
          status: 'ready',
          source: 'local_fs',
          rootPath: '/ws',
          nodes: [{ name: 'local-app.exe', path: '/ws/local-app.exe', isDirectory: false, depth: 0, size: 1024 }],
        },
      },
      desktopApi: {
        saveFile: async (opts) => {
          localSaveCalls.push(opts);
          return { success: true };
        },
      },
    });
    const localBinSrv = createFileViewerService(localBinDeps.deps);
    await localBinSrv.handleOpenFilePreview('/ws/local-app.exe');
    assert.equal(localBinDeps.state.openFiles[0].source, 'local_fs');
    await localBinSrv.downloadFile();
    assert.equal(localSaveCalls.length, 1);
    assert.equal(localSaveCalls[0].sourcePath, '/ws/local-app.exe');
    assert.equal(localSaveCalls[0].remoteUrl, undefined, 'local_fs 文件下载不得附带 remoteUrl');

    // 未在树节点的 .exe：离线状态 (!gatewayConnected) 归入 local_fs，在线状态回落 fallback
    localBinDeps.state.gatewayConnected = false;
    await localBinSrv.handleOpenFilePreview('/ws/sub/offline.exe');
    assert.equal(localBinDeps.state.openFiles.at(-1).source, 'local_fs');

    localBinDeps.state.gatewayConnected = true;
    await localBinSrv.handleOpenFilePreview('/ws/sub/online-unindexed.exe');
    assert.equal(localBinDeps.state.openFiles.at(-1).source, 'fallback');

    localBinDeps.state.fileTreeState = { status: 'ready', source: 'gateway_api', rootPath: '/opt', nodes: [] };
    await localBinSrv.handleOpenFilePreview('/opt/remote.exe');
    assert.equal(localBinDeps.state.openFiles.at(-1).source, 'fallback');

    localBinDeps.state.fileTreeState = undefined;
    await localBinSrv.handleOpenFilePreview('/opt/no-tree.exe');
    assert.equal(localBinDeps.state.openFiles.at(-1).source, 'fallback');
  } finally {
    globalThis.document = savedDoc;
  }
});

test('FileViewerService: 状态栏切 Files 保留 returnTo，绑定返回状态按钮并在窄屏自动折叠树', async () => {
  let backCalls = 0;
  let stateChangeCalls = 0;
  const backBtn = { onclick: null };
  const savedDoc = globalThis.document;
  const savedWin = globalThis.window;

  globalThis.document = {
    getElementById: (id) => (id === 'btn-inspector-back-status' ? backBtn : null),
    querySelectorAll: () => [],
  };
  globalThis.window = { innerWidth: 390 };

  try {
    const { deps, state } = createMockDeps({
      state: {
        inspectorCollapsed: false,
        rightPodMode: { kind: 'status' },
        activeInspectorTab: 'preview',
        fileTreeCollapsed: false,
        fileTreeState: { status: 'ready', source: 'local_fs', rootPath: '/ws', nodes: [] },
      },
    });
    deps.onBackFromFiles = () => {
      backCalls += 1;
    };
    deps.onInspectorStateChange = () => {
      stateChangeCalls += 1;
    };
    const service = createFileViewerService(deps);

    service.toggleInspectorRailTab('preview');
    assert.deepEqual(state.rightPodMode, { kind: 'files', returnTo: 'status' });
    assert.equal(state.inspectorCollapsed, false);
    assert.ok(stateChangeCalls >= 1);

    service.bindEvents();
    assert.equal(typeof backBtn.onclick, 'function');
    backBtn.onclick();
    assert.equal(backCalls, 1);

    await service.handleOpenFilePreview('/ws/app.ts');
    assert.equal(state.fileTreeCollapsed, true, '窄屏<=768 打开文件时必须自动收起左侧文件树');
  } finally {
    globalThis.document = savedDoc;
    globalThis.window = savedWin;
  }
});

test('FileViewerService.downloadMedia: 不依赖 openFiles 直接保存 DataURL 与远端网关媒体', async () => {
  const savedCalls = [];
  const { deps } = createMockDeps({
    state: {
      openFiles: [],
      gatewayUrl: 'https://gw.example.com',
      profileName: 'coder',
      activeSessionId: 'sess-1',
    },
    desktopApi: {
      saveFile: async (opts) => {
        savedCalls.push(opts);
        return { success: true };
      },
    },
  });
  const srv = createFileViewerService(deps);

  await srv.downloadMedia({
    src: 'data:image/png;base64,iVBORw0KGgo=',
    name: 'chart.png',
  });
  assert.equal(savedCalls.length, 1);
  assert.equal(savedCalls[0].fileName, 'chart.png');
  assert.equal(savedCalls[0].isBase64, true);
  assert.equal(savedCalls[0].content, 'data:image/png;base64,iVBORw0KGgo=');

  await srv.downloadMedia({
    src: '/out/remote-shot.png',
    path: '/out/remote-shot.png',
    name: 'remote-shot.png',
  });
  assert.equal(savedCalls.length, 2);
  assert.equal(savedCalls[1].isBase64, false);
  assert.ok(savedCalls[1].remoteUrl.includes('/api/fs/download?path=%2Fout%2Fremote-shot.png'));
});

test('FileViewerService: onMobileOpenFile 跳转守卫与 downloadMedia 全媒体源/Capacitor/anchor兜底', async () => {
  const mobileRedirects = [];
  const anchorClicks = [];
  const savedCalls = [];
  const { deps, state } = createMockDeps({
    state: {
      openFiles: [{ path: '/ws/cached.ts', content: 'export const x = 1;' }],
      gatewayUrl: '',
    },
    desktopApi: {
      saveFile: async (opts) => {
        if (opts.fileName === 'throw.png') throw new Error('dialog canceled');
        savedCalls.push(opts);
        return { success: true };
      },
    },
  });
  deps.onMobileOpenFile = async (target, previewUrl) => {
    mobileRedirects.push({ target, previewUrl });
    return true;
  };
  const srv = createFileViewerService(deps);

  // 1. onMobileOpenFile 返回 true 时阻断桌面右栏展开；skipMobileRedirect=true 时跳过跳转直接打开
  await srv.handleOpenFilePreview('/out/mobile-doc.md', 'data:text/plain,hi');
  assert.deepEqual(mobileRedirects, [{ target: '/out/mobile-doc.md', previewUrl: 'data:text/plain,hi' }]);
  assert.equal(state.inspectorCollapsed, true);
  await srv.handleOpenFilePreview('/ws/cached.ts', undefined, { skipMobileRedirect: true });
  assert.equal(state.inspectorCollapsed, false);

  // 2. downloadMedia 空输入直接退出；命中 openFiles 走 downloadFile
  await srv.downloadMedia({ src: '', path: '' });
  await srv.downloadMedia({ src: '/ws/cached.ts', path: '/ws/cached.ts', name: 'cached.ts' });
  assert.equal(savedCalls.length, 1);
  assert.equal(savedCalls[0].fileName, 'cached.ts');

  // 3. https / sourcePath(无 gatewayUrl) / 缺 name / 无 profile 的网关下载分支
  await srv.downloadMedia({ src: 'data:image/png;base64,AA==' });
  state.gatewayUrl = 'https://gw.example.com';
  state.profileName = '';
  state.activeSessionId = '';
  await srv.downloadMedia({ src: '/out/x.png', path: '/out/x.png' });
  assert.ok(savedCalls.at(-1)?.remoteUrl?.includes('/api/fs/download?path=%2Fout%2Fx.png'));
  state.gatewayUrl = '';

  await srv.downloadMedia({ src: 'https://cdn.example.com/clip.mp4', name: 'clip.mp4' });
  assert.equal(savedCalls.at(-1)?.remoteUrl, 'https://cdn.example.com/clip.mp4');

  await srv.downloadMedia({ src: '/out/local.mp4', path: '/out/local.mp4', name: 'local.mp4' });
  assert.equal(savedCalls.at(-1)?.sourcePath, '/out/local.mp4');

  // 4. Desktop blob: 不进 native saveFile 而走 <a download>；Capacitor blob: 则进 native saveFile
  const savedDoc = globalThis.document;
  const savedWin = globalThis.window;
  const savedSetTimeout = globalThis.setTimeout;
  const btnMock = { style: { color: '' } };
  globalThis.document = {
    getElementById: (id) => (id === 'btn-file-download' ? btnMock : null),
    body: {
      appendChild() {},
      removeChild() {},
    },
    createElement(tag) {
      if (tag !== 'a') return {};
      const node = { href: '', download: '', click: () => anchorClicks.push({ href: node.href, download: node.download }) };
      return node;
    },
  };
  try {
    globalThis.setTimeout = (fn) => {
      if (typeof fn === 'function') fn();
      return 0;
    };
    globalThis.window = {};
    await srv.downloadMedia({ src: 'blob:https://app/desk-1', name: 'desk.png' });
    assert.equal(anchorClicks.at(-1)?.href, 'blob:https://app/desk-1');

    // native saveFile 抛错时回退 anchor 下载
    await srv.downloadMedia({ src: 'https://cdn.example.com/throw.png', name: 'throw.png' });
    assert.equal(anchorClicks.at(-1)?.download, 'throw.png');

    // Capacitor 原生态下 blob: 走 native saveFile 并触发按钮高亮与计时归零
    globalThis.window = { Capacitor: { isNativePlatform: () => true } };
    await srv.downloadMedia({ src: 'blob:https://app/mob-1', name: 'mob.mp4' });
    assert.equal(savedCalls.at(-1)?.content, 'blob:https://app/mob-1');
    assert.equal(btnMock.style.color, '');
  } finally {
    globalThis.setTimeout = savedSetTimeout;
    globalThis.document = savedDoc;
    globalThis.window = savedWin;
  }
});

test('FileViewerService: 成果物侧边栏 (artifacts) 开关对称、筛选与图片点击直达灯箱', async () => {
  const lightboxCalls = [];
  const savedDoc = globalThis.document;
  const savedWin = globalThis.window;

  const filterEl = { value: '', oninput: null, focus() {}, selectionStart: 0, selectionEnd: 0 };
  const imgArtEl = { dataset: { artifactFile: '/opt/out/timeline.png', artifactKind: 'image' }, onclick: null };
  const htmlArtEl = { dataset: { artifactFile: '/opt/out/report.html', artifactKind: 'html' }, onclick: null };
  const railPreviewBtn = { dataset: { tab: 'preview' }, onclick: null };
  const railArtifactsBtn = { dataset: { tab: 'artifacts' }, onclick: null };

  globalThis.document = {
    getElementById: (id) => (id === 'inspector-artifacts-filter-input' ? filterEl : null),
    querySelectorAll: (sel) => {
      if (sel === '[data-artifact-file]') return [imgArtEl, htmlArtEl];
      if (sel === '.vertical-tab-item') return [railPreviewBtn, railArtifactsBtn];
      return [];
    },
  };
  globalThis.window = { innerWidth: 1280 };

  try {
    const { deps, state, getRenderCount } = createMockDeps({
      state: {
        inspectorCollapsed: true,
        activeInspectorTab: 'preview',
        artifactsFilterQuery: '',
        openFiles: [],
        fileTreeCollapsed: false,
      },
      desktopApi: {
        readFile: async (p) => `<html>${p}</html>`,
      },
    });
    deps.getSessionDeliverables = () => [
      { id: 'd1', kind: 'image', path: '/opt/out/timeline.png', name: 'timeline.png', messageId: 'm1', source: 'turn_corroborated', previewUrl: 'data:image/png;base64,AA==' },
      { id: 'd2', kind: 'html', path: '/opt/out/report.html', name: 'report.html', messageId: 'm1', source: 'tool_write' },
    ];
    deps.onOpenMediaLightbox = (items, initialIndex) => {
      lightboxCalls.push({ items, initialIndex });
    };

    const srv = createFileViewerService(deps);
    srv.bindEvents();

    // 1. 点击竖栏成果物入口：展开并切到 artifacts；切到 preview 不关闭；再点 preview 才折叠
    railArtifactsBtn.onclick();
    assert.equal(state.inspectorCollapsed, false);
    assert.equal(state.activeInspectorTab, 'artifacts');
    railPreviewBtn.onclick();
    assert.equal(state.inspectorCollapsed, false);
    assert.equal(state.activeInspectorTab, 'preview');
    railArtifactsBtn.onclick();
    assert.equal(state.activeInspectorTab, 'artifacts');
    railArtifactsBtn.onclick();
    assert.equal(state.inspectorCollapsed, true, '再次点击当前激活成果物 Tab 应平滑收起面板');
    railArtifactsBtn.onclick();
    assert.equal(state.inspectorCollapsed, false);

    // 2. 筛选框触发 setArtifactsFilter
    const beforeRender = getRenderCount();
    filterEl.value = 'timeline';
    filterEl.oninput();
    assert.equal(state.artifactsFilterQuery, 'timeline');
    assert.ok(getRenderCount() > beforeRender);

    // 3. 点击成果物图片走共享 MediaLightbox，点击 HTML 保持在 artifacts Tab 打开右侧预览
    imgArtEl.onclick();
    assert.equal(lightboxCalls.length, 1);
    assert.equal(lightboxCalls[0].initialIndex, 0);
    assert.equal(lightboxCalls[0].items[0].path, '/opt/out/timeline.png');

    await htmlArtEl.onclick();
    assert.equal(state.activeInspectorTab, 'artifacts', '从成果物栏打开文件预览应保留 artifacts Tab');
    assert.equal(state.activeFilePath, '/opt/out/report.html');

    // 4. 关闭最后一个打开文件 Tab 时，只要处于 artifacts 浏览态且左侧栏未收起，面板必须保持常开
    srv.closeFileTab('/opt/out/report.html');
    assert.equal(state.openFiles.length, 0);
    assert.equal(state.inspectorCollapsed, false, '成果物栏处于打开浏览态时关完预览 Tab 不得自动折叠检查舱');
  } finally {
    globalThis.document = savedDoc;
    globalThis.window = savedWin;
  }
});

test('FileViewerService: 切换不同 Bot (同为空 CWD) 自动重拉工作区文件树，且点击慢速视频立刻展示加载态与支持下载/取消', async () => {
  const probedProfiles = [];
  let resolveSlowVideo;
  const slowVideoPromise = new Promise((r) => {
    resolveSlowVideo = r;
  });

  const { deps, state, getRenderCount } = createMockDeps({
    state: {
      inspectorCollapsed: false,
      rightPodMode: { kind: 'files', returnTo: 'closed' },
      activeFocus: { type: 'session', sessionId: 'bot-a-main' },
      activeSessionId: 'bot-a-main',
      profileName: 'botA',
      gatewayUrl: 'https://gw.example.com',
      sessions: [],
      projects: [{ id: 'p-unrelated', name: 'OtherProject', path: '/other/project' }],
      sessionCwds: {},
      fileTreeState: { status: 'idle' },
      fileTreeLoadedCwd: '',
    },
    desktopApi: {
      httpProxy: async ({ path: ep }) => {
        if (ep.startsWith('/api/fs/default-cwd?')) {
          const prof = new URLSearchParams(ep.split('?')[1]).get('profile') || '';
          probedProfiles.push(prof);
          return { cwd: `/opt/bots/${prof}` };
        }
        if (ep.includes('botA')) {
          return { path: '/opt/bots/botA', entries: [{ name: 'MEMORY_A.md', is_directory: false }] };
        }
        if (ep.includes('botB')) {
          return { path: '/opt/bots/botB', entries: [{ name: 'MEMORY_B.md', is_directory: false }] };
        }
        return null;
      },
      resolveMediaStreamUrl: async () => slowVideoPromise,
      saveFile: async () => ({ success: true }),
    },
  });

  const srv = createFileViewerService(deps);

  // 1. Bot A 尽管存在新建工程 /other/project，也不得被劫持，必须按 profile=botA 加载
  await srv.loadFileTree();
  assert.equal(probedProfiles.at(-1), 'botA');
  assert.equal(state.fileTreeState.rootPath, '/opt/bots/botA');
  assert.equal(state.fileTreeLoadedCwd, '');

  // 2. 切换到 Bot B（activeCwd 仍为空），scopeKey 变更触发重拉而不是复用 Bot A 的文件树
  state.profileName = 'botB';
  state.activeSessionId = 'bot-b-main';
  state.activeFocus = { type: 'session', sessionId: 'bot-b-main' };
  await srv.loadFileTree();
  assert.equal(probedProfiles.at(-1), 'botB');
  assert.equal(state.fileTreeState.rootPath, '/opt/bots/botB');

  // 3. 点击大视频时，在 resolveMediaStreamUrl 尚未返回前 0ms 插入 isLoading 占位并立即 render
  const beforeRender = getRenderCount();
  const openPromise = srv.handleOpenFilePreview('/opt/bots/botB/heavy-demo.mp4');
  assert.equal(state.activeInspectorTab, 'preview');
  assert.equal(state.openFiles.length, 1);
  assert.equal(state.openFiles[0].isLoading, true);
  assert.equal(state.openFiles[0].isVideo, true);
  assert.ok(getRenderCount() > beforeRender, '点击大视频后必须立即触发至少一次渲染显示加载态');

  resolveSlowVideo('hermes-media://gateway/?path=%2Fopt%2Fbots%2FbotB%2Fheavy-demo.mp4&token=t1');
  await openPromise;
  assert.equal(state.openFiles[0].isLoading, false);
  assert.ok(state.openFiles[0].content.startsWith('hermes-media://gateway/'));

  // 4. 正在加载另一个视频时关闭标签页，迟滞响应不得复活该标签
  let resolveCancelledVideo;
  const baseDesktopApi = deps.getDesktopApi();
  deps.getDesktopApi = () => ({
    ...baseDesktopApi,
    resolveMediaStreamUrl: () => new Promise((r) => { resolveCancelledVideo = r; }),
  });
  const srv2 = createFileViewerService(deps);
  const cancelledOpen = srv2.handleOpenFilePreview('/opt/bots/botB/cancelled.mp4');
  assert.equal(state.openFiles.length, 2);
  srv2.closeFileTab('/opt/bots/botB/cancelled.mp4');
  assert.equal(state.openFiles.length, 1);
  resolveCancelledVideo('hermes-media://gateway/?path=cancelled&token=t1');
  await cancelledOpen;
  assert.equal(state.openFiles.length, 1, '关闭中的视频加载完成后不得重新复活已关闭标签页');

  // 5. 下载守卫：Mobile blob: 大视频直传 blob 内容，失败远端视频拼装 remoteUrl 均不产生 0 字节下载
  const savedPayloads = [];
  const savedCap = globalThis.window;
  globalThis.window = { Capacitor: { isNativePlatform: () => true } };
  try {
    deps.getDesktopApi = () => ({
      saveFile: async (opts) => {
        savedPayloads.push(opts);
        return { success: true };
      },
    });
    const srvDl = createFileViewerService(deps);
    state.openFiles = [
      { path: '/out/mob.mp4', content: 'blob:https://localhost/v-big', isVideo: true, source: 'gateway_api' },
      { path: '/out/err.mp4', content: '', isVideo: true, source: 'gateway_api' },
      { path: '/out/stream.mp4', content: 'hermes-media://gateway/stream?path=%2Fout%2Fstream.mp4&token=t1', isVideo: true, source: 'gateway_api' },
      { path: '/ws/local.mp4', content: 'hermes-media://local/stream?path=%2Fws%2Flocal.mp4&token=t1', isVideo: true, source: 'local_fs' },
      { path: '/out/loading-gw.mp4', content: '', isVideo: true, isLoading: true, source: 'gateway_api' },
      { path: '/ws/loading-local.mp4', content: '', isVideo: true, isLoading: true, source: 'local_fs' },
    ];
    state.activeFilePath = '/out/mob.mp4';
    await srvDl.downloadFile();
    assert.equal(savedPayloads.at(-1).content, 'blob:https://localhost/v-big');

    state.activeFilePath = '/out/err.mp4';
    await srvDl.downloadFile();
    assert.ok(savedPayloads.at(-1).remoteUrl?.includes('/api/fs/download?path=%2Fout%2Ferr.mp4'));

    state.activeFilePath = '/out/stream.mp4';
    await srvDl.downloadFile();
    assert.ok(savedPayloads.at(-1).remoteUrl?.includes('/api/fs/download?path=%2Fout%2Fstream.mp4'));
    assert.equal(savedPayloads.at(-1).content, savedPayloads.at(-1).remoteUrl);
    assert.equal(savedPayloads.at(-1).sourcePath, undefined);

    state.activeFilePath = '/ws/local.mp4';
    await srvDl.downloadFile();
    assert.equal(savedPayloads.at(-1).sourcePath, '/ws/local.mp4');
    assert.equal(savedPayloads.at(-1).remoteUrl, undefined);
    assert.equal(savedPayloads.at(-1).content, '');

    state.activeFilePath = '/out/loading-gw.mp4';
    await srvDl.downloadFile();
    assert.ok(savedPayloads.at(-1).remoteUrl?.includes('/api/fs/download?path=%2Fout%2Floading-gw.mp4'));

    state.activeFilePath = '/ws/loading-local.mp4';
    await srvDl.downloadFile();
    assert.equal(savedPayloads.at(-1).sourcePath, '/ws/loading-local.mp4');
    assert.equal(savedPayloads.at(-1).content, '');
  } finally {
    globalThis.window = savedCap;
  }

  // 6. 并发竞态与群聊工作区隔离：Bot A (空 CWD) 处于 loading 期间切到 Bot B 必须作废旧请求并按 Bot B 重拉；群聊态非强制加载、目录展开、预览与下载均不泄露前置 Bot profile
  let resolveBotATree;
  const requestedProfiles = [];
  const groupProxyUrls = [];
  const groupSavedPayloads = [];
  const raceDeps = createMockDeps({
    state: {
      activeFocus: { type: 'session', sessionId: 'bot-a' },
      activeSessionId: 'bot-a',
      profileName: 'botA',
      gatewayUrl: 'https://gw.example.com',
      fileTreeState: { status: 'idle' },
      fileTreeLoadedCwd: '',
    },
    desktopApi: {
      httpProxy: async ({ path: ep }) => {
        if (raceDeps.state.activeFocus?.type === 'group') {
          groupProxyUrls.push(ep);
        }
        if (ep.startsWith('/api/fs/default-cwd?')) {
          const prof = new URLSearchParams(ep.split('?')[1]).get('profile') || '';
          requestedProfiles.push(prof);
          if (prof === 'botA') {
            return await new Promise((r) => {
              resolveBotATree = r;
            });
          }
          return { cwd: `/opt/bots/${prof}` };
        }
        return {
          path: '/opt/bots/botB',
          entries: [
            { name: 'sub', path: '/opt/bots/botB/sub', is_directory: true },
            { name: 'B.md', path: '/opt/bots/botB/B.md', is_directory: false },
          ],
        };
      },
      saveFile: async (opts) => {
        groupSavedPayloads.push(opts);
        return { success: true };
      },
    },
  });
  const srvRace = createFileViewerService(raceDeps.deps);
  const botAPromise = srvRace.loadFileTree();
  raceDeps.state.profileName = 'botB';
  raceDeps.state.activeSessionId = 'bot-b';
  raceDeps.state.activeFocus = { type: 'session', sessionId: 'bot-b' };
  const botBPromise = srvRace.loadFileTree();
  await botBPromise;
  resolveBotATree({ cwd: '/opt/bots/botA' });
  await botAPromise;
  assert.equal(raceDeps.state.fileTreeState.rootPath, '/opt/bots/botB', '迟到的 Bot A 目录加载不得覆盖当前 Bot B 文件树');

  raceDeps.state.activeFocus = { type: 'group', roomId: 'room-1' };
  raceDeps.state.activeSessionId = '';
  await srvRace.loadFileTree(); // 非 force 切换进群聊应重拉且不带 profile
  await srvRace.toggleDirectory('/opt/bots/botB/sub');
  await srvRace.handleOpenFilePreview('/opt/bots/botB/B.md');
  await srvRace.downloadMedia({ src: '/opt/group-art.png', path: '/opt/group-art.png' });
  assert.equal(requestedProfiles.filter((p) => p === 'botB').length, 1, '群聊态加载文件树不得携带上一位 Bot 的 profile 探测 default-cwd');
  assert.equal(groupProxyUrls.some((u) => u.includes('profile=botB')), false, '群聊态列目录与读取文件不得泄露前 Bot profile');
  assert.equal(groupSavedPayloads.at(-1).remoteUrl.includes('profile='), false, '群聊态 downloadMedia 不得泄露前 Bot profile');

  // 7. bindEvents: .inspector-rendered-markdown 点击委托 + [data-video-player="true"] onerror 回退 + handleOpenFilePreview catch 兜底
  const mdEl = { onclick: null };
  const vidEl = { onerror: null };
  const prevDoc7 = globalThis.document;
  globalThis.document = {
    getElementById: () => null,
    querySelectorAll: (sel) => {
      if (sel === '.inspector-rendered-markdown') return [mdEl];
      if (sel === '[data-video-player="true"]') return [vidEl];
      return [];
    },
  };
  try {
    const errDeps = createMockDeps({
      state: {
        inspectorCollapsed: true,
        openFiles: [{ path: '/out/stream.mp4', content: 'hermes-media://gateway/x.mp4', isVideo: true }],
        activeFilePath: '/out/stream.mp4',
      },
    });
    const errSrv = createFileViewerService(errDeps.deps);
    errSrv.bindEvents();
    mdEl.onclick({ target: { closest: () => null } });
    vidEl.onerror();
    assert.equal(errDeps.state.openFiles[0].content, '');
    assert.equal(errDeps.state.openFiles[0].isVideo, true);

    Object.defineProperty(errDeps.state, 'messages', {
      get() {
        throw new Error('corrupt messages');
      },
      configurable: true,
    });
    await errSrv.handleOpenFilePreview('/out/fail.md');
    assert.equal(errDeps.state.openFiles.at(-1).isLoading, false);
    assert.ok(errDeps.state.openFiles.at(-1).content.includes('inspector.remoteNotice'));

    await errSrv.handleOpenFilePreview('/out/fail.mp4');
    assert.equal(errDeps.state.openFiles.at(-1).isLoading, false);
    assert.equal(errDeps.state.openFiles.at(-1).isVideo, true);
    assert.equal(errDeps.state.openFiles.at(-1).content, '');

    // videoEl.onerror: activeFilePath 不匹配时回退到 openFiles[0]，且非视频 openFiles[0] 不被误改
    errDeps.state.openFiles = [{ path: '/out/fallback-vid.webm', content: 'https://cdn.example.com/v.webm', isVideo: false }];
    errDeps.state.activeFilePath = '/out/different-tab.md';
    vidEl.onerror();
    assert.equal(errDeps.state.openFiles[0].content, '');
    assert.equal(errDeps.state.openFiles[0].isVideo, true);

    errDeps.state.openFiles = [{ path: '/out/safe.md', content: '# Safe Markdown', isVideo: false }];
    errDeps.state.activeFilePath = '/out/different.md';
    vidEl.onerror();
    assert.equal(errDeps.state.openFiles[0].content, '# Safe Markdown', '非视频 openFiles[0] 不得被视频 onerror 覆盖清空');

    // handleOpenFilePreview 在 try 期间若标签被关闭导致 generation 失效，catch 不得报错或重写状态
    const staleCatchDeps = createMockDeps({
      state: {
        gatewayUrl: 'https://gw.example.com',
        profileName: 'coder',
        inspectorCollapsed: true,
        openFiles: [],
      },
    });
    const staleCatchSrv = createFileViewerService(staleCatchDeps.deps);
    let closedInsideTry = false;
    Object.defineProperty(staleCatchDeps.state, 'messages', {
      get() {
        if (!closedInsideTry) {
          closedInsideTry = true;
          staleCatchSrv.closeFileTab('/out/stale-err.md');
        }
        throw new Error('corrupt after close');
      },
      configurable: true,
    });
    await staleCatchSrv.handleOpenFilePreview('/out/stale-err.md');
    assert.equal(staleCatchDeps.state.openFiles.length, 0);
  } finally {
    globalThis.document = prevDoc7;
  }
});
