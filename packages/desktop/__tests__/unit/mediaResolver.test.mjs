/**
 * 渲染层媒体解析器与会话可点击文件集合推导服务单测 (Media Resolver Unit Test)
 * (packages/desktop/__tests__/unit/mediaResolver.test.mjs)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createMediaResolver,
  createSessionDeliverableCoordinator,
  createSessionKnownFilesResolver,
} from '../../dist/renderer/services/mediaResolver.mjs';

test('createMediaResolver: 直连安全媒体 URL 透传、第三方域名直通、网关同源走代理', async () => {
  const proxyCalls = [];
  const state = {
    gatewayUrl: '  https://gw.example.com///  ',
    profileName: 'arch',
    activeSessionId: 'sess-1',
    messages: [],
  };
  const resolver = createMediaResolver({
    getState: () => state,
    getGatewayClient: () => null,
    getDesktopApi: () => ({
      httpProxy: async (opts) => {
        proxyCalls.push(opts.path);
        if (opts.path.includes('read-text')) {
          if (opts.path.includes('trimmed')) return { text: '  data:image/png;base64,TRIM  ' };
          if (opts.path.includes('prefix-bad')) return { text: 'x-data:image/png;base64,AA==' };
          if (opts.path.includes('http-img')) return { text: 'http://public.example.com/a.jpg' };
          return { text: 'data:image/png;base64,R0lGODlh' };
        }
        return 'data:image/png;base64,R0lGODlh';
      },
    }),
  });

  // 1. 空值返回 null
  assert.equal(await resolver.resolveMediaUrl(''), null);
  assert.equal(await resolver.resolveMediaUrl('   '), null);

  // 2. data:image / data:video / blob 直接返回，不走网关代理；中间带 prefix 绝不能放行直通
  assert.equal(await resolver.resolveMediaUrl('data:image/png;base64,AA=='), 'data:image/png;base64,AA==');
  assert.equal(await resolver.resolveMediaUrl('data:video/mp4;base64,BB=='), 'data:video/mp4;base64,BB==');
  assert.equal(await resolver.resolveMediaUrl('blob:https://localhost/obj-1'), 'blob:https://localhost/obj-1');
  assert.equal(proxyCalls.length, 0);

  // 非开头出现 data:image/ 或 blob: 时仍需走代理
  await resolver.resolveMediaUrl('sub/data:image/png.png');
  assert.equal(proxyCalls.length >= 1, true);
  await resolver.resolveMediaUrl('sub/blob:a.png');

  // 3. 第三方 http / https 直通（不触发代理）
  const beforeExt = proxyCalls.length;
  assert.equal(
    await resolver.resolveMediaUrl('https://cdn.example.com/diagram.png'),
    'https://cdn.example.com/diagram.png',
  );
  assert.equal(
    await resolver.resolveMediaUrl('http://cdn.example.com/plain.png'),
    'http://cdn.example.com/plain.png',
  );
  assert.equal(proxyCalls.length, beforeExt);

  // gatewayUrl 为空或 undefined 时所有 http(s) 也直通
  const origGw = state.gatewayUrl;
  state.gatewayUrl = undefined;
  assert.equal(
    await resolver.resolveMediaUrl('http://static.example.com/clip.mp4'),
    'http://static.example.com/clip.mp4',
  );
  state.gatewayUrl = origGw;

  // 4. 相对路径 / 网关同源路径走代理、带 profile+session_id 参数、trim 空格并命中 LRU 缓存
  const beforeChart = proxyCalls.length;
  const resolved = await resolver.resolveMediaUrl('/out/chart.png');
  assert.equal(resolved, 'data:image/png;base64,R0lGODlh');
  const chartCalls = proxyCalls.slice(beforeChart);
  assert.equal(chartCalls.length, 1);
  assert.ok(chartCalls[0].includes('profile=arch') && chartCalls[0].includes('session_id=sess-1'));

  const cachedAgain = await resolver.resolveMediaUrl('/out/chart.png');
  assert.equal(cachedAgain, 'data:image/png;base64,R0lGODlh');
  assert.equal(proxyCalls.length, beforeChart + 1, '重复请求同路径必须命中内存 LRU 缓存');

  // 返回带首尾空白的 DataURL / 纯 http:// 图片允许放行；非前缀 DataURL 拒收
  assert.equal(await resolver.resolveMediaUrl('/out/trimmed.txt'), 'data:image/png;base64,TRIM');
  assert.equal(await resolver.resolveMediaUrl('/out/http-img.txt'), 'http://public.example.com/a.jpg');
  assert.equal(await resolver.resolveMediaUrl('/out/prefix-bad.txt'), null);

  // profileName/activeSessionId 为空时不拼 profile/session_id 查询串
  state.profileName = '';
  state.activeSessionId = '';
  const beforeNoMeta = proxyCalls.length;
  await resolver.resolveMediaUrl('/out/nometa.png');
  const noMetaCall = proxyCalls[beforeNoMeta];
  assert.equal(noMetaCall.includes('profile='), false);
  assert.equal(noMetaCall.includes('session_id='), false);

  // 网关同源 URL（大小写与尾斜杠归一化后仍命中同源代理路径，且先删后插）
  const gwBefore = proxyCalls.length;
  const gwSameOrigin = await resolver.resolveMediaUrl('HTTPS://GW.EXAMPLE.COM/api/fs/download?path=%2Fout%2Fgw.png');
  assert.equal(gwSameOrigin, 'data:image/png;base64,R0lGODlh');
  assert.equal(proxyCalls.length, gwBefore + 1);
});

test('createMediaResolver: 并发 in-flight 去重、LRU 64 条淘汰与异常/不安全结果隔离', async () => {
  let activeFetchCount = 0;
  const fetchLog = [];
  let failNext = false;
  let nextMode = 'image';

  const state = {
    gatewayUrl: 'https://gw.example.com',
    profileName: 'default',
    activeSessionId: 'sess-lru',
    messages: [],
  };

  let releaseInflight;
  let inflightGate = null;

  const resolver = createMediaResolver({
    getState: () => state,
    getGatewayClient: () => null,
    getDesktopApi: () => ({
      httpProxy: async ({ path: ep }) => {
        activeFetchCount += 1;
        fetchLog.push(ep);
        if (inflightGate) {
          await inflightGate;
        }
        if (failNext) {
          throw new Error('proxy timeout');
        }
        if (nextMode === 'html') {
          return 'data:text/html;base64,PGh0bWw+';
        }
        if (nextMode === 'binary') {
          return 'application/octet-stream-raw';
        }
        return `data:image/png;base64,IMG_${fetchLog.length}`;
      },
    }),
  });

  // 1. 并发请求同一路径仅触发一轮代理（in-flight 去重）
  inflightGate = new Promise((r) => {
    releaseInflight = r;
  });
  const p1 = resolver.resolveMediaUrl('/out/concurrent.png');
  const p2 = resolver.resolveMediaUrl('/out/concurrent.png');
  releaseInflight();
  inflightGate = null;
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1, r2);
  assert.ok(r1?.startsWith('data:image/png;base64,'));
  assert.equal(fetchLog.length, 1, '并发请求同一路径绝不能触发第二次代理');
  const fetchesForConcurrent = fetchLog.length;

  // 2. 不安全/非媒体结果（纯 HTML fallback 文本）返回 null 且不入缓存
  nextMode = 'html';
  assert.equal(await resolver.resolveMediaUrl('/out/bad-page.html'), null);
  nextMode = 'image';
  assert.equal(await resolver.resolveMediaUrl('/out/binary.exe'), null);

  // 3. 异常捕获（deps.getDesktopApi 抛错触发 catch L95-96 并记 warn 清理 inflight，允许后续恢复）
  const warns = [];
  const origWarn = console.warn;
  console.warn = (...args) => warns.push(args);
  let throwDeps = false;
  const errResolver = createMediaResolver({
    getState: () => state,
    getGatewayClient: () => null,
    getDesktopApi: () => {
      if (throwDeps) throw new Error('bridge exploded');
      return undefined;
    },
  });
  try {
    throwDeps = true;
    const crashed = await errResolver.resolveMediaUrl('https://gw.example.com/api/fs/download?path=crash.png');
    assert.equal(crashed, null);
    assert.ok(String(warns[0]?.[0] || '').includes('[mediaResolver]'));
    throwDeps = false;
    assert.equal(await errResolver.resolveMediaUrl('/out/no-bridge.png'), null);
  } finally {
    failNext = false;
    console.warn = origWarn;
  }
  const recovered = await resolver.resolveMediaUrl('/out/crash-retry.png');
  assert.ok(recovered?.startsWith('data:image/png;base64,'));

  // 4. 验证 MAX_CACHE_ENTRIES = 64 的严格 LRU 淘汰策略
  const lruState = {
    gatewayUrl: 'https://gw.example.com',
    profileName: 'lru',
    activeSessionId: 's-lru',
    messages: [],
  };
  const lruFetched = [];
  const lruResolver = createMediaResolver({
    getState: () => lruState,
    getGatewayClient: () => null,
    getDesktopApi: () => ({
      httpProxy: async ({ path: ep }) => {
        lruFetched.push(ep);
        return `data:image/png;base64,LRU_${lruFetched.length}`;
      },
    }),
  });

  for (let i = 0; i < 64; i += 1) {
    await lruResolver.resolveMediaUrl(`/out/item-${i}.png`);
  }
  const countAt64 = lruFetched.length;

  // 访问第 0 项将其晋升为最近使用，不增加网络请求
  const hit0 = await lruResolver.resolveMediaUrl('/out/item-0.png');
  assert.ok(hit0?.startsWith('data:image/png;base64,'));
  assert.equal(lruFetched.length, countAt64);

  // 插入第 65 项，淘汰最久未用的 item-1.png
  await lruResolver.resolveMediaUrl('/out/item-64.png');
  const countAfter65 = lruFetched.length;
  assert.ok(countAfter65 > countAt64);

  // item-0.png 仍在缓存中；item-1.png 已被淘汰必须重新触发代理
  assert.equal(await lruResolver.resolveMediaUrl('/out/item-0.png'), hit0);
  assert.equal(lruFetched.length, countAfter65, '晋升后的 item-0 必须保持缓存命中');

  await lruResolver.resolveMediaUrl('/out/item-1.png');
  assert.ok(lruFetched.length > countAfter65, '被 LRU 淘汰的 item-1 再次访问必须重拉');
  assert.ok(fetchesForConcurrent >= 1);
  assert.ok(activeFetchCount >= 1);
});

test('createSessionKnownFilesResolver: 按消息内容与工具引用记忆，合并读写与成果物路径', () => {
  let messages = [];
  const resolveKnownFiles = createSessionKnownFilesResolver(() => messages);
  assert.deepEqual(resolveKnownFiles(), [], '空消息初始化绝不可残留伪造路径');

  const toolCallsA = [
    { id: 't1', name: 'read_file', args: JSON.stringify({ path: '/repo/src/app.ts' }) },
  ];
  messages = [
    {
      id: 'm1',
      role: 'assistant',
      content: '查看 ![图](/out/diagram.png) 与 [/out/report.html](/out/report.html)',
      toolCalls: toolCallsA,
    },
  ];

  const first = resolveKnownFiles();
  assert.deepEqual([...first].sort(), ['/out/diagram.png', '/out/report.html', '/repo/src/app.ts']);

  // 引用未变（新数组包装旧 toolCalls & content）必须返回完全相同的缓存数组引用
  messages = [{ ...messages[0] }];
  const second = resolveKnownFiles();
  assert.equal(second, first, 'toolCalls 与 content 引用未变时必须直接复用缓存数组');

  // 仅更换 toolCalls 引用（正文相同）：必须重算并识别新工具文件
  const toolCallsB = [
    { id: 't2', name: 'write_file', args: JSON.stringify({ path: '/repo/src/only-tool.ts' }) },
  ];
  messages = [{ ...messages[0], toolCalls: toolCallsB }];
  const onlyToolChanged = resolveKnownFiles();
  assert.notEqual(onlyToolChanged, second);
  assert.ok(onlyToolChanged.includes('/repo/src/only-tool.ts'));
  assert.equal(onlyToolChanged.includes('/repo/src/app.ts'), false);

  // 仅更换 content（toolCalls 引用保持 toolCallsB 不变）：必须重算
  messages = [
    {
      ...messages[0],
      content: '已写入 [/out/report.html](/out/report.html)\nMEDIA:/out/clip.mp4',
      attachments: [{ id: 'att-1', name: 'snap.png', path: '/out/snap.png', previewUrl: 'data:image/png;base64,AA==' }],
    },
  ];
  const third = resolveKnownFiles();
  assert.notEqual(third, onlyToolChanged);
  assert.ok(third.includes('/repo/src/only-tool.ts'));
  assert.ok(third.includes('/out/report.html'));
  assert.ok(third.includes('/out/clip.mp4'));
  assert.ok(third.includes('/out/snap.png'));

  // 增加多条消息且首条不含 toolCalls、次条含 toolCalls（杀灭 every->some 与 ?? 变异体）
  messages = [
    { id: 'm-none', role: 'assistant', content: 'MEDIA:/out/no-tools.png' },
    { id: 'm-two', role: 'assistant', content: 'second', toolCalls: [{ id: 't3', name: 'write_file', args: '{"path":"/out/two.ts"}' }] },
  ];
  const fourth = resolveKnownFiles();
  assert.deepEqual([...fourth].sort(), ['/out/no-tools.png', '/out/two.ts']);

  // 仅第一条消息 toolCalls 相同而第二条 content 改变，同样必须重算
  messages = [
    messages[0],
    { ...messages[1], content: 'MEDIA:/out/second-updated.png' },
  ];
  const fifth = resolveKnownFiles();
  assert.notEqual(fifth, fourth);
  assert.ok(fifth.includes('/out/second-updated.png'));
});

test('createSessionDeliverableCoordinator: 聚合子代理写入、批量父目录物理核验与作用域切换隔离', async () => {
  const listCalls = [];
  let updateSignals = 0;
  let subagentPaths = ['/opt/out/subagent-report.md'];
  const state = {
    gatewayUrl: '',
    profileName: 'default',
    activeSessionId: 'sess-deliv-1',
    isStreaming: false,
    sessions: [{ id: 'sess-deliv-1', cwd: '/opt/ws' }],
    messages: [
      {
        id: 'm1',
        role: 'assistant',
        content: '产物见 `/opt/out/timeline.png` 与 `/opt/out/phantom.png`',
        toolCalls: [{ id: 't1', name: 'write_file', args: JSON.stringify({ path: '/opt/out/main.html' }) }],
      },
    ],
  };

  const coordinator = createSessionDeliverableCoordinator({
    getState: () => state,
    getDesktopApi: () => ({
      async listDirectory(dirPath) {
        listCalls.push(dirPath);
        if (dirPath === '/opt/out') {
          return [{ name: 'timeline.png', path: '/opt/out/timeline.png', isDirectory: false }];
        }
        return [];
      },
    }),
    getSubagentWrittenPaths: () => subagentPaths,
    onVerifiedPathsUpdated: () => {
      updateSignals += 1;
    },
  });

  // 未验证前：强证据 + 子代理写已入围，phantom 与未印证 timeline 暂不入围
  const before = coordinator.getSessionDeliverables();
  assert.deepEqual(
    before.map((d) => d.path).sort(),
    ['/opt/out/main.html', '/opt/out/subagent-report.md'],
  );

  // 触发物理存在性核验：仅发起 1 次 /opt/out 列举，证实 timeline.png 并丢弃 phantom.png
  coordinator.scheduleVerification();
  await new Promise((r) => setTimeout(r, 30));

  assert.deepEqual(listCalls, ['/opt/out']);
  assert.deepEqual(coordinator.getVerifiedPaths(), ['/opt/out/timeline.png']);
  assert.equal(updateSignals, 1);

  const after = coordinator.getSessionDeliverables();
  assert.ok(after.some((d) => d.path === '/opt/out/timeline.png' && d.source === 'verified_mention'));
  assert.equal(after.some((d) => d.path === '/opt/out/phantom.png'), false);

  // 切换会话作用域后已验证集合立刻隔离重置
  state.activeSessionId = 'sess-deliv-2';
  state.messages = [];
  subagentPaths = [];
  assert.deepEqual(coordinator.getVerifiedPaths(), []);
  assert.deepEqual(coordinator.getSessionDeliverables(), []);

  coordinator.clear();
});

test('mediaResolver & deliverables: wss:// 网关归一代理、toolCalls 原地变异失效缓存与晚到 cwd 重探', async () => {
  const proxyPaths = [];
  const stateWss = {
    gatewayUrl: 'wss://gw.example.com/',
    profileName: 'arch',
    activeSessionId: 's-wss',
    messages: [],
  };
  const wssResolver = createMediaResolver({
    getState: () => stateWss,
    getGatewayClient: () => null,
    getDesktopApi: () => ({
      httpProxy: async (opts) => {
        proxyPaths.push(opts.path);
        return 'data:image/png;base64,WSSOK';
      },
    }),
  });
  const wssImg = await wssResolver.resolveMediaUrl('https://gw.example.com/api/files/read?path=shot.png');
  assert.equal(wssImg, 'data:image/png;base64,WSSOK');
  assert.equal(proxyPaths.length, 1, 'wss:// 与同域 https:// 媒体链接必须走鉴权代理而非裸传外链');

  // 原地 push toolCalls 与原地写 inlineDiff 必须使 knownFiles 和 sessionDeliverables 缓存失效
  const stateMut = {
    gatewayUrl: '',
    profileName: 'default',
    activeSessionId: 's-mut',
    isStreaming: false,
    sessions: [{ id: 's-mut', cwd: '' }],
    messages: [{ id: 'm1', role: 'assistant', content: '参考 rel/chart.png', toolCalls: [] }],
  };
  const knownFiles = createSessionKnownFilesResolver(() => stateMut.messages);
  assert.deepEqual(knownFiles(), []);

  const listDirs = [];
  let updated = 0;
  const mutCoord = createSessionDeliverableCoordinator({
    getState: () => stateMut,
    getDesktopApi: () => ({
      async listDirectory(dirPath) {
        listDirs.push(dirPath);
        if (dirPath === '/opt/ws/rel') return [{ name: 'chart.png', path: '/opt/ws/rel/chart.png', isDirectory: false }];
        return [];
      },
    }),
    onVerifiedPathsUpdated: () => {
      updated += 1;
    },
  });
  assert.deepEqual(mutCoord.getSessionDeliverables(), []);

  // 就地修改 toolCalls 数组与字段，不更换 toolCalls 引用
  stateMut.messages[0].toolCalls.push({ id: 't-mut', name: 'edit_patch', args: JSON.stringify({ path: '/out/mut.ts' }), status: 'running' });
  assert.ok(knownFiles().includes('/out/mut.ts'), 'toolCalls.push 原地修改必须使 knownFiles 重算');
  assert.ok(mutCoord.getSessionDeliverables().some((d) => d.path === '/out/mut.ts'), 'getSessionDeliverables 不得被就地 push 缓存毒化');

  stateMut.messages[0].toolCalls[0].name = 'custom_tool';
  stateMut.messages[0].toolCalls[0].args = JSON.stringify({ path: '/out/by-diff.ts' });
  stateMut.messages[0].toolCalls[0].inlineDiff = '@@ -1 +1 @@\n-a\n+b';
  assert.ok(mutCoord.getSessionDeliverables().some((d) => d.path === '/out/by-diff.ts'), 'toolCall.inlineDiff 原地写入必须使缓存失效并入围成果物');

  // 初次在 !cwd 下调用 scheduleVerification 不应永久锁死相对路径，cwd 到位后应自动补探
  mutCoord.scheduleVerification();
  await new Promise((r) => setTimeout(r, 15));
  assert.deepEqual(listDirs, ['rel']);

  stateMut.sessions[0].cwd = '/opt/ws';
  mutCoord.scheduleVerification();
  await new Promise((r) => setTimeout(r, 25));
  assert.deepEqual(listDirs, ['rel', '/opt/ws/rel']);
  assert.ok(mutCoord.getVerifiedPaths().includes('rel/chart.png'));
  assert.equal(updated, 1);
});
