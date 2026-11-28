import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  MediaLightbox,
  TurnDeliverables,
  MessageAttachments,
  MarkdownBlock,
  ConversationMessageList,
  TurnGroup,
  clampLightboxScale,
  clampLightboxPan,
  computeLightboxDragDelta,
  computeLightboxSwipeResult,
  LIGHTBOX_MIN_SCALE,
  LIGHTBOX_MAX_SCALE,
} from '../dist/components-react/conversation/index.js';

function createReactHookDriver(driverOpts = {}) {
  const slots = new Map();
  let pendingEffects = [];

  function resolve(node, key = 'root') {
    if (node == null || typeof node === 'boolean' || typeof node === 'string' || typeof node === 'number') {
      return node;
    }
    if (Array.isArray(node)) {
      return node.map((item, idx) => resolve(item, `${key}[${idx}]`));
    }
    if (typeof node !== 'object') return node;

    const elType = node.type;
    if (typeof elType === 'symbol') {
      return {
        ...node,
        props: {
          ...node.props,
          children: resolve(node.props?.children, `${key}.frag`),
        },
      };
    }

    const innerType =
      elType && typeof elType === 'object' && elType.$$typeof === Symbol.for('react.memo')
        ? elType.type
        : elType;
    const compFn = typeof innerType === 'function' ? innerType : null;

    if (compFn) {
      const scopedKey = node.key != null ? `${key}#k=${String(node.key)}` : key;
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
        if (idx >= slot.effects.length) {
          slot.effects.push({ deps, cleanup: undefined, hasRun: false });
        }
        const entry = slot.effects[idx];
        const changed =
          !entry.hasRun ||
          deps === undefined ||
          entry.deps === undefined ||
          deps.length !== entry.deps.length ||
          deps.some((d, i) => !Object.is(d, entry.deps[i]));
        if (changed) {
          pendingEffects.push(() => {
            if (typeof entry.cleanup === 'function') {
              entry.cleanup();
              entry.cleanup = undefined;
            }
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
          if (idx >= slot.states.length) {
            slot.states.push(typeof init === 'function' ? init() : init);
          }
          const setter = (next) => {
            slot.states[idx] = typeof next === 'function' ? next(slot.states[idx]) : next;
          };
          return [slot.states[idx], setter];
        },
        useReducer(reducer, initialArg, init) {
          const idx = sIdx++;
          if (idx >= slot.states.length) {
            slot.states.push(init ? init(initialArg) : initialArg);
          }
          const dispatch = (action) => {
            slot.states[idx] = reducer(slot.states[idx], action);
          };
          return [slot.states[idx], dispatch];
        },
        useImperativeHandle() {},
        useTransition() {
          return [false, (fn) => fn()];
        },
        useDeferredValue(val) {
          return val;
        },
        use(usable) {
          return usable?._currentValue;
        },
        useRef(init) {
          const idx = rIdx++;
          if (idx >= slot.refs.length) {
            slot.refs.push({ current: init });
          }
          return slot.refs[idx];
        },
        useMemo(factory, deps) {
          const idx = mIdx++;
          if (idx >= slot.memos.length) {
            slot.memos.push({ value: factory(), deps });
          } else {
            const prev = slot.memos[idx];
            const changed = !deps || !prev.deps || deps.some((d, i) => !Object.is(d, prev.deps[i]));
            if (changed) {
              slot.memos[idx] = { value: factory(), deps };
            }
          }
          return slot.memos[idx].value;
        },
        useCallback(cb) {
          return cb;
        },
        useEffect: scheduleEffect,
        useLayoutEffect: scheduleEffect,
        useInsertionEffect: scheduleEffect,
        useDebugValue() {},
        useId() {
          return `id-${scopedKey}`;
        },
        useContext(ctx) {
          return ctx?._currentValue;
        },
        useSyncExternalStore(_sub, getSnap) {
          return getSnap();
        },
      };
      let rendered;
      try {
        rendered = compFn(node.props);
      } finally {
        internals.H = prevH;
      }
      return resolve(rendered, `${scopedKey}>${compFn.name || 'Fn'}`);
    }

    if (node.props && 'children' in node.props) {
      if (driverOpts.attachStageRef && node.props?.ref && typeof node.props.ref === 'object') {
        node.props.ref.current = driverOpts.attachStageRef;
      }
      return {
        ...node,
        props: {
          ...node.props,
          children: resolve(node.props.children, key),
        },
      };
    }
    if (driverOpts.attachStageRef && node.props?.ref && typeof node.props.ref === 'object') {
      node.props.ref.current = driverOpts.attachStageRef;
    }
    return node;
  }

  return {
    mount(renderFn) {
      let tree = null;
      const rerender = () => {
        pendingEffects = [];
        tree = resolve(renderFn(), 'root');
        const currentEffects = pendingEffects;
        pendingEffects = [];
        for (const effect of currentEffects) {
          effect();
        }
        return tree;
      };
      rerender();
      return {
        get tree() {
          return tree;
        },
        rerender,
        unmount() {
          for (const slot of slots.values()) {
            for (const entry of slot.effects) {
              if (typeof entry.cleanup === 'function') {
                entry.cleanup();
                entry.cleanup = undefined;
              }
            }
          }
        },
      };
    },
  };
}

function findAll(node, predicate, acc = []) {
  if (!node || typeof node === 'object' === false) return acc;
  if (Array.isArray(node)) {
    for (const item of node) findAll(item, predicate, acc);
    return acc;
  }
  if (predicate(node)) acc.push(node);
  if (node.props && 'children' in node.props) {
    findAll(node.props.children, predicate, acc);
  }
  if ('children' in node && node.children !== node.props?.children) {
    findAll(node.children, predicate, acc);
  }
  return acc;
}

test('MediaLightbox 纯数学缩放、平移与拖拽边界裁决', () => {
  // 1. 缩放钳位
  assert.equal(clampLightboxScale(0.1), LIGHTBOX_MIN_SCALE);
  assert.equal(clampLightboxScale(12), LIGHTBOX_MAX_SCALE);
  assert.equal(clampLightboxScale(1.75), 1.75);
  assert.equal(clampLightboxScale(Number.NaN), 1);

  // 2. 1x 未放大态平移严格归零；放大态被视口与倍率边界约束
  assert.deepEqual(clampLightboxPan(120, -80, 1, 400, 600), { x: 0, y: 0 });
  assert.deepEqual(clampLightboxPan(999, -999, 2, 400, 600), { x: 200, y: -300 });
  assert.deepEqual(clampLightboxPan(-60, 45, 2, 400, 600), { x: -60, y: 45 });

  // 3. 1x 态拖拽跟手与边缘橡皮筋阻尼（对齐 Bot 头像轮播手感）
  assert.equal(computeLightboxDragDelta(100, 0, 3), 28, '首张继续右拉触发 0.28 橡皮筋阻尼');
  assert.equal(computeLightboxDragDelta(-100, 0, 3), -100, '首张左滑无阻尼跟手切换下一张');
  assert.equal(computeLightboxDragDelta(-100, 2, 3), -28, '末张继续左滑触发阻尼');
  assert.equal(computeLightboxDragDelta(100, 0, 1), 28, '单图左右边缘同样保持弹性阻尼');

  // 4. 松手裁决：距离或轻拂速度达到阈值切换到上/下一张，大幅下拉关闭
  assert.deepEqual(
    computeLightboxSwipeResult({ totalDx: -70, totalDy: 5, durationMs: 250, currentIndex: 0, total: 3 }),
    { action: 'next', nextIndex: 1 },
  );
  assert.deepEqual(
    computeLightboxSwipeResult({ totalDx: -20, totalDy: 0, durationMs: 40, currentIndex: 0, total: 3 }),
    { action: 'next', nextIndex: 1 },
    '快速轻拂即使位移小也必须翻页',
  );
  assert.deepEqual(
    computeLightboxSwipeResult({ totalDx: 75, totalDy: 0, durationMs: 200, currentIndex: 2, total: 3 }),
    { action: 'prev', nextIndex: 1 },
  );
  assert.deepEqual(
    computeLightboxSwipeResult({ totalDx: 5, totalDy: 140, durationMs: 220, currentIndex: 1, total: 3 }),
    { action: 'close', nextIndex: 1 },
  );
  assert.deepEqual(
    computeLightboxSwipeResult({ totalDx: 80, totalDy: 0, durationMs: 200, currentIndex: 0, total: 1 }),
    { action: 'none', nextIndex: 0 },
  );
});

test('TurnDeliverables 回合末渲染 3 张图片画廊、视频与文档卡片，点击图片唤醒 MediaLightbox', () => {
  const openedLightboxes = [];
  const openedFiles = [];
  const html = renderToStaticMarkup(
    React.createElement(TurnDeliverables, {
      isStreaming: false,
      messages: [
        {
          id: 'ast-1',
          role: 'assistant',
          content: [
            '已生成三张架构图与一份原型文档：',
            '![img-1](https://cdn.example.com/a.png)',
            '![img-2](https://cdn.example.com/b.png)',
            '![img-3](https://cdn.example.com/c.png)',
            '[演示视频](https://cdn.example.com/demo.mp4)',
            '[报告](docs/report.html)',
          ].join('\n'),
          toolCalls: [
            {
              id: 'tc-vid',
              name: 'video_export',
              status: 'completed',
              args: JSON.stringify({ output_path: 'https://cdn.example.com/demo.mp4' }),
            },
          ],
        },
      ],
      onOpenFile: (path, url) => openedFiles.push({ path, url }),
      onOpenMediaLightbox: (items, idx) => openedLightboxes.push({ items, idx }),
    }),
  );

  assert.ok(html.includes('data-testid="turn-deliverables-images"'));
  assert.ok(html.includes('data-count="multi"'));
  assert.equal((html.match(/data-testid="turn-deliverable-image"/g) || []).length, 3, '3 张图片必须在回合末完整呈现');
  assert.ok(html.includes('data-testid="turn-deliverable-video"'), '视频产物必须呈现紧凑折叠卡');
  assert.ok(html.includes('demo.mp4'), '视频卡片必须展示清晰纯文件名');
  assert.ok(html.includes('report.html'), '生成文档必须渲染可点击成果物卡片');

  // 点击折叠视频卡片展开内置 <video> 播放器
  const vidDriver = createReactHookDriver();
  const vidView = vidDriver.mount(() =>
    React.createElement(TurnDeliverables, {
      isStreaming: false,
      messages: [
        {
          id: 'ast-vid',
          role: 'assistant',
          content: 'MEDIA:https://cdn.example.com/demo.mp4',
        },
      ],
    }),
  );
  assert.equal(findAll(vidView.tree, (n) => n.type === 'video').length, 0);
  findAll(vidView.tree, (n) => n.props?.className === 'conv-deliverable-video__trigger')[0].props.onClick();
  vidView.rerender();
  const videoNodes = findAll(vidView.tree, (n) => n.type === 'video');
  assert.equal(videoNodes.length, 1, '展开视频卡片后必须挂载原生 video 播放器');
  assert.equal(videoNodes[0].props.src, 'https://cdn.example.com/demo.mp4');
  vidView.unmount();

  // hook driver 校验：点击第 2 张图片触发 lightbox；点击文档卡片触发 onOpenFile
  const driver = createReactHookDriver();
  const view = driver.mount(() =>
    React.createElement(TurnDeliverables, {
      isStreaming: false,
      messages: [
        {
          id: 'ast-2',
          role: 'assistant',
          content: '![one](https://cdn.example.com/1.png)\n![two](https://cdn.example.com/2.png)\n[doc](docs/out.md)',
        },
      ],
      onOpenFile: (path, url) => openedFiles.push({ path, url }),
      onOpenMediaLightbox: (items, idx) => openedLightboxes.push({ items, idx }),
    }),
  );

  const imgBtns = findAll(view.tree, (n) => n.props?.['data-testid'] === 'turn-deliverable-image');
  assert.equal(imgBtns.length, 2);
  imgBtns[1].props.onClick();
  assert.equal(openedLightboxes.length, 1);
  assert.equal(openedLightboxes[0].idx, 1);
  assert.equal(openedLightboxes[0].items.length, 2);

  const fileBtns = findAll(view.tree, (n) => n.props?.['data-testid'] === 'turn-deliverable-file');
  assert.equal(fileBtns.length, 1);
  fileBtns[0].props.onClick({ preventDefault() {}, stopPropagation() {} });
  assert.deepEqual(openedFiles[0], { path: 'docs/out.md', url: undefined });
});

test('MediaLightbox 交互控制：放大、缩小、重置、前后切换、下载与关闭', () => {
  const items = [
    { id: '1', src: 'https://cdn.example.com/1.png', name: 'one.png' },
    { id: '2', src: 'https://cdn.example.com/2.png', name: 'two.png' },
    { id: '3', src: 'https://cdn.example.com/3.png', name: 'three.png' },
  ];
  let closed = 0;
  const downloaded = [];
  const driver = createReactHookDriver();
  const view = driver.mount(() =>
    React.createElement(MediaLightbox, {
      items,
      initialIndex: 0,
      onClose: () => {
        closed += 1;
      },
      onDownload: (it) => downloaded.push(it.id),
    }),
  );

  const zoomLabel = () => findAll(view.tree, (n) => n.props?.['data-testid'] === 'lightbox-zoom-label')[0]?.props?.children;
  const counterLabel = () => {
    const raw = findAll(view.tree, (n) => n.props?.['data-testid'] === 'lightbox-counter')[0]?.props?.children;
    return Array.isArray(raw) ? raw.join('') : String(raw || '');
  };

  assert.equal(zoomLabel(), '100%');
  assert.equal(counterLabel(), '1 / 3');

  // 放大两次 -> 150%，缩小一次 -> 125%，重置 -> 100%
  findAll(view.tree, (n) => n.props?.['data-testid'] === 'lightbox-zoom-in')[0].props.onClick();
  view.rerender();
  assert.equal(zoomLabel(), '125%');
  findAll(view.tree, (n) => n.props?.['data-testid'] === 'lightbox-zoom-in')[0].props.onClick();
  view.rerender();
  assert.equal(zoomLabel(), '150%');
  findAll(view.tree, (n) => n.props?.['data-testid'] === 'lightbox-zoom-out')[0].props.onClick();
  view.rerender();
  assert.equal(zoomLabel(), '125%');
  findAll(view.tree, (n) => n.props?.['data-testid'] === 'lightbox-zoom-reset')[0].props.onClick();
  view.rerender();
  assert.equal(zoomLabel(), '100%');

  // 下一张 + 下载 + 拖拽切第三张
  findAll(view.tree, (n) => n.props?.['data-testid'] === 'lightbox-next')[0].props.onClick({ stopPropagation() {} });
  view.rerender();
  assert.equal(counterLabel(), '2 / 3');
  findAll(view.tree, (n) => n.props?.['data-testid'] === 'lightbox-download')[0].props.onClick();
  assert.deepEqual(downloaded, ['2']);

  // 拖拽平移手势模拟：左拖 100px 切到第 3 张
  const stage = findAll(view.tree, (n) => typeof n.props?.className === 'string' && n.props.className.includes('flux-lightbox__stage'))[0];
  stage.props.onPointerDown({ pointerId: 1, button: 0, pointerType: 'touch', clientX: 220, clientY: 300, currentTarget: {} });
  view.rerender();
  stage.props.onPointerMove({ pointerId: 1, clientX: 120, clientY: 302 });
  view.rerender();
  stage.props.onPointerUp({ pointerId: 1, clientX: 120, clientY: 302, currentTarget: {} });
  view.rerender();
  assert.equal(counterLabel(), '3 / 3');

  // 放大到 2x 后拖动平移图片位置不重置为 1/3
  findAll(view.tree, (n) => n.props?.['data-testid'] === 'lightbox-zoom-in')[0].props.onClick();
  view.rerender();
  const stageZoomed = findAll(view.tree, (n) => typeof n.props?.className === 'string' && n.props.className.includes('flux-lightbox__stage'))[0];
  stageZoomed.props.onPointerDown({ pointerId: 2, button: 0, pointerType: 'touch', clientX: 200, clientY: 300, currentTarget: {} });
  view.rerender();
  stageZoomed.props.onPointerMove({ pointerId: 2, clientX: 240, clientY: 320 });
  view.rerender();
  const imgNode = findAll(view.tree, (n) => typeof n.props?.className === 'string' && n.props.className.includes('flux-lightbox__image'))[0];
  assert.ok(String(imgNode.props.style.transform).includes('translate3d(40px, 20px, 0) scale(1.25)'));
  stageZoomed.props.onPointerUp({ pointerId: 2, clientX: 240, clientY: 320, currentTarget: {} });
  view.rerender();
  assert.equal(counterLabel(), '3 / 3');

  // 点关闭按钮
  findAll(view.tree, (n) => n.props?.['data-testid'] === 'lightbox-close')[0].props.onClick();
  assert.equal(closed, 1);
  view.unmount();
});

test('回归守卫：MessageAttachments 空与非空切换 Hook 稳定 + TurnDeliverables 流式门控 + Lightbox 加载失败可重试', async () => {
  // 1. MessageAttachments 在空/非空切换下绝不可触发 Hook 顺序异常
  let atts = [];
  const driver = createReactHookDriver();
  const attView = driver.mount(() =>
    React.createElement(MessageAttachments, {
      attachments: atts,
      variant: 'bubble',
    }),
  );
  assert.equal(attView.tree, null);
  atts = [{ id: 'a1', name: 'shot.png', sizeBytes: 120, type: 'image', previewUrl: 'data:image/png;base64,AA==' }];
  attView.rerender();
  assert.equal(findAll(attView.tree, (n) => n.props?.className === 'conv-att-thumb__img').length, 1);
  atts = [];
  attView.rerender();
  assert.equal(attView.tree, null);
  attView.unmount();

  // 2. TurnDeliverables 在 isStreaming=true 时延后路径代理请求，结束流式后触发解析
  const resolveCalls = [];
  let streaming = true;
  const tdDriver = createReactHookDriver();
  const tdView = tdDriver.mount(() =>
    React.createElement(TurnDeliverables, {
      isStreaming: streaming,
      messages: [{ id: 's1', role: 'assistant', content: 'MEDIA:/out/stream.png' }],
      resolveMediaUrl: async (p) => {
        resolveCalls.push(p);
        return 'data:image/png;base64,BB==';
      },
    }),
  );
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(resolveCalls.length, 0, '流式未完成时不得提前代理请求未定型路径');
  streaming = false;
  tdView.rerender();
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(resolveCalls, ['/out/stream.png']);
  tdView.unmount();

  // 3. MediaLightbox 加载失败呈现显式错误态与可点击重试
  let attempt = 0;
  const lbDriver = createReactHookDriver();
  const lbView = lbDriver.mount(() =>
    React.createElement(MediaLightbox, {
      items: [{ id: 'p1', src: '/out/fail.png', path: '/out/fail.png', name: 'fail.png' }],
      initialIndex: 0,
      onClose: () => {},
      resolveMediaUrl: async () => {
        attempt += 1;
        if (attempt === 1) throw new Error('network error');
        return 'data:image/png;base64,CC==';
      },
    }),
  );
  await new Promise((r) => setTimeout(r, 10));
  lbView.rerender();
  const retryBtn = findAll(lbView.tree, (n) => n.props?.['data-testid'] === 'lightbox-retry')[0];
  assert.ok(retryBtn, 'resolveMediaUrl 失败时必须呈现显式错误与重试按钮');
  retryBtn.props.onClick({ stopPropagation() {} });
  lbView.rerender();
  await new Promise((r) => setTimeout(r, 10));
  lbView.rerender();
  assert.equal(
    findAll(lbView.tree, (n) => typeof n.props?.className === 'string' && n.props.className.includes('flux-lightbox__image'))[0]?.props?.src,
    'data:image/png;base64,CC==',
  );
  lbView.unmount();
});

test('MediaLightbox 全量交互：wheel/键盘快捷键/doubleClick/pinch+单指衔接/pointerCancel/无resolver失败态', async () => {
  const prevWin = globalThis.window;
  const winListeners = new Map();
  const stageListeners = new Map();
  const stageMock = {
    getBoundingClientRect: () => ({ width: 800, height: 600 }),
    addEventListener(type, fn) {
      stageListeners.set(type, fn);
    },
    removeEventListener(type) {
      stageListeners.delete(type);
    },
  };
  globalThis.window = {
    addEventListener(type, fn) {
      winListeners.set(type, fn);
    },
    removeEventListener(type) {
      winListeners.delete(type);
    },
  };

  try {
    // 1. 无 resolveMediaUrl 且 src 不安全时直接显式报错而非空白
    const errDriver = createReactHookDriver();
    const errView = errDriver.mount(() =>
      React.createElement(MediaLightbox, {
        items: [{ id: 'bad', src: 'javascript:alert(1)', name: 'bad.png' }],
        initialIndex: 0,
        onClose: () => {},
      }),
    );
    assert.ok(findAll(errView.tree, (n) => n.props?.className === 'flux-lightbox__error').length === 1);
    errView.unmount();

    // 2. resolveMediaUrl 返回非安全 URL（纯文本）进入显式错误态
    const badResDriver = createReactHookDriver();
    const badResView = badResDriver.mount(() =>
      React.createElement(MediaLightbox, {
        items: [{ id: 'p-bad', src: '/out/bad.png', path: '/out/bad.png', name: 'bad.png' }],
        initialIndex: 0,
        onClose: () => {},
        resolveMediaUrl: async () => 'not-a-valid-data-url',
      }),
    );
    await new Promise((r) => setTimeout(r, 10));
    badResView.rerender();
    assert.ok(findAll(badResView.tree, (n) => n.props?.['data-testid'] === 'lightbox-retry').length === 1);
    badResView.unmount();

    // 3. 多图完整手势与键盘交互
    let closed = 0;
    const items = [
      { id: '1', src: 'data:image/png;base64,A', name: '1.png' },
      { id: '2', src: 'data:image/png;base64,B', name: '2.png' },
      { id: '3', src: 'data:image/png;base64,C', name: '3.png' },
    ];
    const driver = createReactHookDriver({ attachStageRef: stageMock });
    const view = driver.mount(() =>
      React.createElement(MediaLightbox, {
        items,
        initialIndex: 1,
        onClose: () => {
          closed += 1;
        },
      }),
    );

    const flattenText = (val) => (Array.isArray(val) ? val.join('') : val);
    const getZoom = () =>
      flattenText(findAll(view.tree, (n) => n.props?.['data-testid'] === 'lightbox-zoom-label')[0]?.props?.children);
    const getCounter = () =>
      flattenText(findAll(view.tree, (n) => n.props?.className === 'flux-lightbox__counter')[0]?.props?.children);

    // 上一张按钮
    assert.equal(getCounter(), '2 / 3');
    findAll(view.tree, (n) => n.props?.['data-testid'] === 'lightbox-prev')[0].props.onClick({ stopPropagation() {} });
    view.rerender();
    assert.equal(getCounter(), '1 / 3');

    // wheel 向上滚放大、向下滚缩小并归零平移
    const wheelFn = stageListeners.get('wheel');
    assert.equal(typeof wheelFn, 'function');
    wheelFn({ deltaY: -120, preventDefault() {} });
    view.rerender();
    assert.equal(getZoom(), '125%');
    wheelFn({ deltaY: 120, preventDefault() {} });
    view.rerender();
    assert.equal(getZoom(), '100%');

    // onDoubleClick 放大至 225% 再双击复位至 100%
    const stage = findAll(view.tree, (n) => typeof n.props?.className === 'string' && n.props.className.includes('flux-lightbox__stage'))[0];
    stage.props.onDoubleClick();
    view.rerender();
    assert.equal(getZoom(), '225%');
    const stageZoomed = findAll(view.tree, (n) => typeof n.props?.className === 'string' && n.props.className.includes('flux-lightbox__stage'))[0];
    stageZoomed.props.onDoubleClick();
    view.rerender();
    assert.equal(getZoom(), '100%');

    // 键盘快捷键：ArrowRight / ArrowLeft / + / = / - / 0 / Escape
    winListeners.get('keydown')({ key: 'ArrowRight', preventDefault() {} });
    view.rerender();
    assert.equal(getCounter(), '2 / 3');
    winListeners.get('keydown')({ key: 'ArrowLeft', preventDefault() {} });
    view.rerender();
    assert.equal(getCounter(), '1 / 3');
    winListeners.get('keydown')({ key: '+', preventDefault() {} });
    view.rerender();
    assert.equal(getZoom(), '125%');
    winListeners.get('keydown')({ key: '=', preventDefault() {} });
    view.rerender();
    assert.equal(getZoom(), '150%');
    winListeners.get('keydown')({ key: '-', preventDefault() {} });
    view.rerender();
    assert.equal(getZoom(), '125%');
    winListeners.get('keydown')({ key: '0', preventDefault() {} });
    view.rerender();
    assert.equal(getZoom(), '100%');

    // 鼠标右键点击忽略 + 双指捏合放大 + 松开一指继续单指拖拽 + backdrop 防误触关闭
    const stageForGest = findAll(view.tree, (n) => typeof n.props?.className === 'string' && n.props.className.includes('flux-lightbox__stage'))[0];
    stageForGest.props.onPointerDown({ pointerId: 9, button: 2, pointerType: 'mouse', clientX: 10, clientY: 10, currentTarget: {} });
    stageForGest.props.onPointerDown({ pointerId: 10, button: 0, pointerType: 'touch', clientX: 100, clientY: 100, currentTarget: {} });
    stageForGest.props.onPointerDown({ pointerId: 11, button: 0, pointerType: 'touch', clientX: 200, clientY: 100, currentTarget: {} });
    stageForGest.props.onPointerMove({ pointerId: 11, clientX: 300, clientY: 100 });
    view.rerender();
    assert.equal(getZoom(), '200%');
    const stagePinch = findAll(view.tree, (n) => typeof n.props?.className === 'string' && n.props.className.includes('flux-lightbox__stage'))[0];
    stagePinch.props.onPointerUp({ pointerId: 10, clientX: 100, clientY: 100, currentTarget: {} });
    stagePinch.props.onPointerMove({ pointerId: 11, clientX: 340, clientY: 120 });
    stagePinch.props.onPointerUp({ pointerId: 11, clientX: 340, clientY: 120, currentTarget: {} });
    view.rerender();
    assert.equal(getZoom(), '200%');

    // 单指拖拽后 backdrop click 抑制一次关闭；onPointerCancel 清除状态后再点背景正常关闭
    const stageAfter = findAll(view.tree, (n) => typeof n.props?.className === 'string' && n.props.className.includes('flux-lightbox__stage'))[0];
    stageAfter.props.onClick({ target: stageMock, currentTarget: stageMock });
    assert.equal(closed, 0, '拖拽释放后的首击必须抑制误关灯箱');
    stageAfter.props.onPointerDown({ pointerId: 12, button: 0, pointerType: 'touch', clientX: 200, clientY: 200, currentTarget: {} });
    stageAfter.props.onPointerCancel({ pointerId: 12, clientX: 200, clientY: 200, currentTarget: {} });
    stageAfter.props.onClick({ target: stageMock, currentTarget: stageMock });
    assert.equal(closed, 1);

    winListeners.get('keydown')?.({ key: 'Escape', preventDefault() {} });
    assert.equal(closed, 2);

    // 按 '0' 复位到 1x 态后再测试竖直下滑关闭手势（L407-409） + 空 dragOrigin/未知指针/按钮点击保护
    winListeners.get('keydown')?.({ key: '0', preventDefault() {} });
    view.rerender();
    const swipeStage = findAll(view.tree, (n) => typeof n.props?.className === 'string' && n.props.className.includes('flux-lightbox__stage'))[0];
    swipeStage.props.onPointerDown({ pointerId: 20, button: 0, pointerType: 'mouse', target: { closest: () => ({}) }, clientX: 200, clientY: 100, currentTarget: {} });
    swipeStage.props.onPointerMove({ pointerId: 999, clientX: 200, clientY: 150 });
    swipeStage.props.onPointerUp({ pointerId: 999, clientX: 200, clientY: 150, currentTarget: {} });
    assert.equal(closed, 2);
    swipeStage.props.onPointerDown({ pointerId: 21, button: 0, pointerType: 'touch', clientX: 200, clientY: 100, currentTarget: {} });
    view.rerender();
    const swipeMove = findAll(view.tree, (n) => typeof n.props?.className === 'string' && n.props.className.includes('flux-lightbox__stage'))[0];
    swipeMove.props.onPointerMove({ pointerId: 21, clientX: 204, clientY: 260 });
    swipeMove.props.onPointerUp({ pointerId: 21, clientX: 204, clientY: 260, currentTarget: {} });
    assert.equal(closed, 3, '1x 态纵向滑动超过阈值必须关闭灯箱');
    view.unmount();

    // 空 items 与 pure helper 精确边界矩阵（杀死数学与正则变异体）
    assert.equal(renderToStaticMarkup(React.createElement(MediaLightbox, { items: [], initialIndex: 0, onClose: () => {} })), '');
    assert.deepEqual(clampLightboxPan(50, -50, 1.02, 400, 600), { x: 0, y: 0 }, 'scale === 1.02 必须归零平移');
    assert.notDeepEqual(clampLightboxPan(50, -50, 1.03, 400, 600), { x: 0, y: 0 }, 'scale > 1.02 必须允许平移');
    assert.deepEqual(clampLightboxPan(10, 10, 2, 0, 0), { x: 10, y: 10 });
    assert.equal(computeLightboxDragDelta(Number.NaN, 0, 3), 0);
    assert.equal(computeLightboxDragDelta(100, 0, 3), 28, '首张向右越界必须触发 0.28x 阻尼');
    assert.equal(computeLightboxDragDelta(-100, 0, 3), -100, '首张向左切下一张不得触发边缘阻尼');
    assert.equal(computeLightboxDragDelta(100, 1, 3), 100, '中间页向右不得阻尼');
    assert.equal(computeLightboxDragDelta(-100, 2, 3), -28, '末张向左越界必须阻尼');
    assert.equal(computeLightboxDragDelta(100, 2, 3), 100, '末张向右切上一张不得阻尼');
    assert.equal(computeLightboxDragDelta(100, 0, 1) < 50 && computeLightboxDragDelta(-100, 0, 1) > -50, true);
    assert.equal(computeLightboxDragDelta(0, 0, 1), 0);

    assert.equal(computeLightboxSwipeResult({ totalDx: 0, totalDy: 0, durationMs: 10, currentIndex: 0, total: 0 }).action, 'none');
    assert.equal(computeLightboxSwipeResult({ totalDx: 0, totalDy: 110, durationMs: 100, currentIndex: 1, total: 3 }).action, 'none');
    assert.equal(computeLightboxSwipeResult({ totalDx: 0, totalDy: 111, durationMs: 100, currentIndex: 1, total: 3 }).action, 'close');
    assert.equal(computeLightboxSwipeResult({ totalDx: 0, totalDy: -111, durationMs: 100, currentIndex: 1, total: 3 }).action, 'close');
    assert.equal(computeLightboxSwipeResult({ totalDx: 80, totalDy: 112, durationMs: 500, currentIndex: 0, total: 3 }).action, 'none');
    assert.equal(computeLightboxSwipeResult({ totalDx: 80, totalDy: 113, durationMs: 500, currentIndex: 0, total: 3 }).action, 'close');
    assert.equal(computeLightboxSwipeResult({ totalDx: -56, totalDy: 0, durationMs: 500, currentIndex: 0, total: 3 }).action, 'next');
    assert.equal(computeLightboxSwipeResult({ totalDx: -55, totalDy: 0, durationMs: 500, currentIndex: 0, total: 3 }).action, 'none');
    assert.equal(computeLightboxSwipeResult({ totalDx: -35, totalDy: 0, durationMs: 100, currentIndex: 0, total: 3 }).action, 'next');
    assert.equal(computeLightboxSwipeResult({ totalDx: -34, totalDy: 0, durationMs: 100, currentIndex: 0, total: 3 }).action, 'none');
    assert.equal(computeLightboxSwipeResult({ totalDx: 56, totalDy: 0, durationMs: 500, currentIndex: 1, total: 3 }).action, 'prev');
    assert.equal(computeLightboxSwipeResult({ totalDx: 55, totalDy: 0, durationMs: 500, currentIndex: 1, total: 3 }).action, 'none');
    assert.equal(computeLightboxSwipeResult({ totalDx: 35, totalDy: 0, durationMs: 100, currentIndex: 1, total: 3 }).action, 'prev');
    assert.equal(computeLightboxSwipeResult({ totalDx: 34, totalDy: 0, durationMs: 100, currentIndex: 1, total: 3 }).action, 'none');
    assert.equal(computeLightboxSwipeResult({ totalDx: 150, totalDy: 0, durationMs: 100, currentIndex: 1, total: 3 }).nextIndex, 0);
    assert.equal(computeLightboxSwipeResult({ totalDx: -150, totalDy: 0, durationMs: 100, currentIndex: 1, total: 3 }).nextIndex, 2);
    assert.equal(computeLightboxSwipeResult({ totalDx: -10, totalDy: 0, durationMs: 0, currentIndex: 0, total: 3 }).action, 'next', 'durationMs=0 钳制为 1ms，高速轻拂触发切换');
    assert.equal(computeLightboxSwipeResult({ totalDx: 150, totalDy: 0, durationMs: 100, currentIndex: 0, total: 2 }).action, 'none');
    assert.equal(computeLightboxSwipeResult({ totalDx: -150, totalDy: 0, durationMs: 100, currentIndex: 99, total: 2 }).nextIndex, 1);

    // SAFE_MEDIA_SRC_RE http:// 与非前缀阻断 + 按钮 disabled 边界（最小 1x / 最大 4x）+ DOM semantics 属性
    const boundDriver = createReactHookDriver();
    const boundView = boundDriver.mount(() =>
      React.createElement(MediaLightbox, {
        items: [
          { id: 'h1', src: 'http://cdn.example.com/plain.png', name: 'plain.png' },
          { id: 'h2', src: 'https://cdn.example.com/secure.png', name: 'secure.png' },
        ],
        initialIndex: 0,
        onClose: () => {},
      }),
    );
    const dialogRoot = findAll(boundView.tree, (n) => n.props?.['data-testid'] === 'media-lightbox')[0];
    assert.equal(dialogRoot.props.role, 'dialog');
    assert.equal(dialogRoot.props['aria-modal'], 'true');
    assert.equal(dialogRoot.props['data-gesture-ignore'], 'pan-x');
    assert.equal(findAll(boundView.tree, (n) => n.props?.['data-testid'] === 'lightbox-zoom-out')[0].props.disabled, false);
    assert.equal(findAll(boundView.tree, (n) => n.props?.['data-testid'] === 'lightbox-zoom-in')[0].props.disabled, false);
    for (let z = 0; z < 4; z += 1) {
      findAll(boundView.tree, (n) => n.props?.['data-testid'] === 'lightbox-zoom-out')[0].props.onClick();
      boundView.rerender();
    }
    assert.equal(findAll(boundView.tree, (n) => n.props?.['data-testid'] === 'lightbox-zoom-out')[0].props.disabled, true);
    const plainImg = findAll(boundView.tree, (n) => n.props?.className === 'flux-lightbox__image')[0];
    assert.equal(plainImg.props.src, 'http://cdn.example.com/plain.png');
    assert.equal(plainImg.props.draggable, false);
    assert.equal(plainImg.props.alt, 'plain.png');
    assert.equal(findAll(boundView.tree, (n) => n.props?.['data-testid'] === 'lightbox-prev').length, 0);
    assert.equal(findAll(boundView.tree, (n) => n.props?.['data-testid'] === 'lightbox-next').length, 1);
    for (let z = 0; z < 16; z += 1) {
      findAll(boundView.tree, (n) => n.props?.['data-testid'] === 'lightbox-zoom-in')[0].props.onClick();
      boundView.rerender();
    }
    assert.equal(findAll(boundView.tree, (n) => n.props?.['data-testid'] === 'lightbox-zoom-in')[0].props.disabled, true);
    assert.equal(findAll(boundView.tree, (n) => n.props?.['data-testid'] === 'lightbox-zoom-out')[0].props.disabled, false);
    boundView.unmount();

    const blockedPrefixHtml = renderToStaticMarkup(
      React.createElement(MediaLightbox, {
        items: [{ id: 'badp', src: 'foo/data:image/png;base64,AA==', name: 'badp.png' }],
        initialIndex: 0,
        onClose: () => {},
      }),
    );
    assert.ok(blockedPrefixHtml.includes('data-testid="lightbox-error"'));

    let finishPendingOk;
    let finishPendingErr;
    const cancelD1 = createReactHookDriver();
    const cancelV1 = cancelD1.mount(() =>
      React.createElement(MediaLightbox, {
        items: [{ id: 'pend-1', src: '/out/p1.png', path: '/out/p1.png', name: 'p1.png' }],
        initialIndex: -2,
        onClose: () => {},
        resolveMediaUrl: () => new Promise((r) => { finishPendingOk = r; }),
      }),
    );
    cancelV1.unmount();
    finishPendingOk('data:image/png;base64,ZZ');
    const cancelD2 = createReactHookDriver();
    const cancelV2 = cancelD2.mount(() =>
      React.createElement(MediaLightbox, {
        items: [{ id: 'pend-2', src: '/out/p2.png', path: '/out/p2.png', name: 'p2.png' }],
        initialIndex: 99,
        onClose: () => {},
        resolveMediaUrl: () => new Promise((_r, rej) => { finishPendingErr = rej; }),
      }),
    );
    cancelV2.unmount();
    finishPendingErr(new Error('late reject'));
    await new Promise((r) => setTimeout(r, 5));

    // 单张图时箭头切换安全锁定边界
    const singleDriver = createReactHookDriver();
    let singleClosed = 0;
    const sView = singleDriver.mount(() =>
      React.createElement(MediaLightbox, {
        items: [{ id: 'only', src: 'data:image/png;base64,AA==', name: 'only.png' }],
        initialIndex: 0,
        onClose: () => {
          singleClosed += 1;
        },
      }),
    );
    winListeners.get('keydown')?.({ key: 'ArrowRight', preventDefault() {} });
    winListeners.get('keydown')?.({ key: 'Escape', preventDefault() {} });
    assert.equal(singleClosed, 1);
    sView.unmount();
  } finally {
    globalThis.window = prevWin;
  }
});

test('TurnDeliverables 全数量/失败重试/视频/文档图标 + MarkdownBlock/MessageAttachments/ConversationMessageList/TurnGroup', async () => {
  // 1. TurnDeliverables 空态返回 null
  assert.equal(renderToStaticMarkup(React.createElement(TurnDeliverables, { messages: [] })), '');

  // 2. 1张、2张 data-count 与 placeholder / retry / video / html / markdown / document / file 全类型图标
  const oneImg = renderToStaticMarkup(
    React.createElement(TurnDeliverables, {
      messages: [{ id: 'm1', role: 'assistant', content: 'MEDIA:data:image/png;base64,AA==' }],
    }),
  );
  assert.ok(oneImg.includes('data-count="1"'));

  const twoImgs = renderToStaticMarkup(
    React.createElement(TurnDeliverables, {
      messages: [{ id: 'm2', role: 'assistant', content: 'MEDIA:data:image/png;base64,AA==\nMEDIA:data:image/png;base64,BB==' }],
    }),
  );
  assert.ok(twoImgs.includes('data-count="2"'));

  const openedFiles = [];
  let mediaResolveMode = 'reject';
  const tdDriver = createReactHookDriver();
  const tdView = tdDriver.mount(() =>
    React.createElement(TurnDeliverables, {
      isStreaming: false,
      messages: [
        {
          id: 'm3',
          role: 'assistant',
          content: [
            'MEDIA:/out/img-fail.png',
            'MEDIA:/out/vid-fail.mp4',
            '[页面](/out/app.html)',
            '[说明](/out/GUIDE.md)',
            '[文档](/out/spec.pdf)',
            'MEDIA:/out/archive.bin',
          ].join('\n'),
          toolCalls: [
            { id: 'w1', name: 'write_file', rawArgs: { path: '/out/app.html' } },
            { id: 'w2', name: 'write_file', rawArgs: { path: '/out/GUIDE.md' } },
            { id: 'w3', name: 'write_file', rawArgs: { path: '/out/script.ts' } },
          ],
        },
      ],
      resolveMediaUrl: async (p) => {
        if (mediaResolveMode === 'reject') throw new Error('offline');
        if (mediaResolveMode === 'null') return null;
        return p.endsWith('.mp4') ? 'data:video/mp4;base64,VV==' : 'data:image/png;base64,PP==';
      },
      onOpenFile: (p, url) => openedFiles.push({ p, url }),
    }),
  );

  // 未完成加载时渲染紧凑图片卡片（无媒体回调时点击回退 onOpenFile）
  const placeholders = findAll(tdView.tree, (n) => n.props?.['data-testid'] === 'turn-deliverable-image');
  assert.equal(placeholders.length, 1);
  placeholders[0].props.onClick();
  assert.equal(openedFiles[0]?.p, '/out/img-fail.png');

  await new Promise((r) => setTimeout(r, 15));
  tdView.rerender();

  // 解析失败后，图片立即可重试；视频卡片点击触发按需加载（加载中再点收起/重开不重复发请求），加载态转失败后同样显示 retry 按钮
  const initialVideoTrigger = findAll(tdView.tree, (n) => n.props?.className === 'conv-deliverable-video__trigger')[0];
  assert.ok(initialVideoTrigger, '视频卡片应存在于成果物列表中');
  initialVideoTrigger.props.onClick();
  tdView.rerender();
  assert.ok(
    findAll(tdView.tree, (n) => n.props?.['data-testid'] === 'turn-deliverable-video-loading').length === 1,
    '点击未解析的视频卡应立刻展开加载态提示',
  );
  // 同帧并发再点击一次（此时 loadingVideos[targetPath] 已置位），以及渲染后折叠重开
  initialVideoTrigger.props.onClick();
  findAll(tdView.tree, (n) => n.props?.className === 'conv-deliverable-video__trigger')[0].props.onClick();
  tdView.rerender();
  findAll(tdView.tree, (n) => n.props?.className === 'conv-deliverable-video__trigger')[0].props.onClick();
  tdView.rerender();
  await new Promise((r) => setTimeout(r, 15));
  tdView.rerender();

  const retryBtns = findAll(tdView.tree, (n) => n.props?.className === 'conv-deliverable-retry-btn');
  assert.ok(retryBtns.length >= 3);
  const openInErrBtns = retryBtns.filter((b) => String(b.props?.children?.props?.children || '').includes('打开') || b.props?.['data-testid'] === 'turn-deliverable-video-open');
  openInErrBtns.forEach((b) => b.props.onClick());

  // 切换到 null 返回并测试 resolve -> null 失败分支，随后切换 ok 并点击重试
  mediaResolveMode = 'null';
  const vidRetryOnly = retryBtns.filter(
    (b) => b.props?.['data-testid'] !== 'turn-deliverable-video-open',
  );
  vidRetryOnly.at(-1).props.onClick();
  tdView.rerender();
  await new Promise((r) => setTimeout(r, 15));
  tdView.rerender();
  mediaResolveMode = 'ok';
  const retryTextBtns = findAll(tdView.tree, (n) => n.props?.className === 'conv-deliverable-retry-btn').filter(
    (b) => b.props?.['data-testid'] !== 'turn-deliverable-video-open',
  );
  retryTextBtns.forEach((b) => b.props.onClick());
  tdView.rerender();
  await new Promise((r) => setTimeout(r, 15));
  tdView.rerender();
  assert.ok(findAll(tdView.tree, (n) => n.props?.['data-testid'] === 'turn-deliverable-image').length === 1);
  const readyVideoEl = findAll(tdView.tree, (n) => n.props?.className === 'conv-deliverable-video__player')[0];
  assert.ok(readyVideoEl, '点击 Retry 并解析成功后应挂载 video 播放器');
  readyVideoEl.props.onError();
  tdView.rerender();
  assert.ok(
    findAll(tdView.tree, (n) => n.props?.['data-testid'] === 'turn-deliverable-video-error').length === 1,
    '流式视频播放报错触发 onError 时必须回退显式错误与重试态',
  );
  const resolvedVidRetry = findAll(
    findAll(tdView.tree, (n) => n.props?.['data-testid'] === 'turn-deliverable-video')[0],
    (n) => n.props?.className === 'conv-deliverable-retry-btn',
  ).find((b) => b.props?.['data-testid'] !== 'turn-deliverable-video-open');
  resolvedVidRetry.props.onClick();
  tdView.rerender();
  await new Promise((r) => setTimeout(r, 15));
  tdView.rerender();
  assert.ok(findAll(tdView.tree, (n) => n.props?.className === 'conv-deliverable-video__player').length === 1);
  tdView.unmount();

  // TurnDeliverables resolve=null 分支(L122)、直连媒体豁免分支(L108-109)、无点文档扩展名回退(L302)与卸载 cancel 分支(L118/126)
  const nullTD = createReactHookDriver();
  const nullView = nullTD.mount(() =>
    React.createElement(TurnDeliverables, {
      isStreaming: false,
      messages: [
        {
          id: 'm-extra',
          role: 'assistant',
          content: [
            'MEDIA:/out/returns-null.png',
            'MEDIA:data:image/png;base64,DIRECT',
            'MEDIA:https://cdn.example.com/v.mp4',
            '[doc](/out/Report.pdf)',
          ].join('\n'),
          attachments: [
            { id: 'att-dir', name: 'direct.png', previewUrl: 'data:image/png;base64,AA==' },
            { id: 'att-nodot', name: 'Report', previewUrl: 'blob:https://app/nodot-doc' },
            { id: 'att-vid-blob', name: 'clip-att.mp4', type: 'video', previewUrl: 'blob:https://app/clip-att' },
          ],
        },
      ],
      resolveMediaUrl: async () => null,
    }),
  );
  await new Promise((r) => setTimeout(r, 15));
  nullView.rerender();
  assert.ok(findAll(nullView.tree, (n) => typeof n.props?.className === 'string' && n.props.className.includes('conv-deliverable-file-card--failed')).length >= 1);

  // 验证 TurnDeliverables 文件卡与视频卡片精确属性与 event.preventDefault/stopPropagation 调用
  const fileCardNodes = findAll(nullView.tree, (n) => n.props?.['data-testid'] === 'turn-deliverable-file');
  assert.ok(fileCardNodes.some((n) => n.props?.['data-preview-file'] === '/out/Report.pdf'));
  const extNodes = findAll(nullView.tree, (n) => n.props?.className === 'conv-deliverable-file__ext').map((n) => n.props?.children);
  assert.ok(extNodes.includes('PDF'));
  assert.ok(extNodes.includes('FILE'));

  findAll(nullView.tree, (n) => n.props?.className === 'conv-deliverable-video__trigger').forEach((tr) => tr.props.onClick());
  nullView.rerender();
  const directVidPlayers = findAll(nullView.tree, (n) => n.props?.className === 'conv-deliverable-video__player');
  const directVid = directVidPlayers.find((vp) => vp.props?.src === 'https://cdn.example.com/v.mp4');
  assert.ok(directVid, 'https 直连视频必须正常渲染播放节点');
  assert.ok(directVidPlayers.some((vp) => vp.props?.src === 'blob:https://app/clip-att'), 'blob 附件视频也必须正常渲染播放节点');
  assert.equal(directVid.props.controls, true);
  assert.equal(directVid.props.playsInline, true);

  // 直连 URL / blob 视频触发 onError 也必须屏蔽旧 src 并落地错误+重试态，点击重试恢复播放
  directVidPlayers.forEach((vp) => vp.props.onError());
  nullView.rerender();
  assert.ok(
    findAll(nullView.tree, (n) => n.props?.['data-testid'] === 'turn-deliverable-video-error').length >= 1,
    '直连 URL 视频报错触发 onError 时不得继续挂载损坏的 video 节点',
  );
  findAll(nullView.tree, (n) => n.props?.['data-testid'] === 'turn-deliverable-video').forEach((vc) => {
    const rb = findAll(vc, (n) => n.props?.className === 'conv-deliverable-retry-btn')[0];
    rb?.props?.onClick();
  });
  nullView.rerender();
  assert.ok(findAll(nullView.tree, (n) => n.props?.className === 'conv-deliverable-video__player').length >= 1);

  let preventedFile = false;
  let stoppedFile = false;
  fileCardNodes[0].props.onClick({
    preventDefault() { preventedFile = true; },
    stopPropagation() { stoppedFile = true; },
  });
  assert.equal(preventedFile && stoppedFile, true);
  nullView.unmount();

  const noResVidView = createReactHookDriver().mount(() =>
    React.createElement(TurnDeliverables, {
      isStreaming: false,
      messages: [{ id: 'm-nores-vid', role: 'assistant', content: 'MEDIA:/out/nores.mp4' }],
      onOpenFile: (p, pu) => openedFiles.push({ p, pu }),
    }),
  );
  findAll(noResVidView.tree, (n) => n.props?.className === 'conv-deliverable-video__trigger')[0].props.onClick();
  assert.equal(openedFiles.at(-1)?.p, '/out/nores.mp4');
  noResVidView.unmount();

  let tdOk;
  let tdErr;
  const cancelTD1 = createReactHookDriver().mount(() =>
    React.createElement(TurnDeliverables, {
      isStreaming: false,
      messages: [{ id: 'm-c1', role: 'assistant', content: 'MEDIA:/out/c1.png' }],
      resolveMediaUrl: () => new Promise((r) => { tdOk = r; }),
    }),
  );
  cancelTD1.unmount();
  tdOk('data:image/png;base64,AA==');

  const cancelTD2 = createReactHookDriver().mount(() =>
    React.createElement(TurnDeliverables, {
      isStreaming: false,
      messages: [{ id: 'm-c2', role: 'assistant', content: 'MEDIA:/out/c2.png' }],
      resolveMediaUrl: () => new Promise((_r, rej) => { tdErr = rej; }),
    }),
  );
  cancelTD2.unmount();
  tdErr(new Error('unmounted'));
  await new Promise((r) => setTimeout(r, 5));

  // 3. MarkdownBlock：空正文带 anchorId 输出 hidden 占位；行内图点击委托灯箱
  const prevElement = globalThis.Element;
  const mockImgEl = {
    closest(sel) {
      return sel.includes('.md-inline-image') ? this : null;
    },
    getAttribute(name) {
      if (name === 'data-media-src') return 'https://cdn.example.com/inline.png';
      if (name === 'data-media-name') return 'inline';
      return '';
    },
  };
  globalThis.Element = function MockElement() {};
  Object.setPrototypeOf(mockImgEl, globalThis.Element.prototype);

  try {
    const mdHidden = renderToStaticMarkup(
      React.createElement(MarkdownBlock, { content: '   ', anchorId: 'msg-content-x', className: 'extra' }),
    );
    assert.ok(mdHidden.includes('id="msg-content-x"') && mdHidden.includes('display:none'));

    const mdOpened = [];
    const mdDriver = createReactHookDriver({
      attachStageRef: { querySelectorAll: () => [mockImgEl] },
    });
    const mdView = mdDriver.mount(() =>
      React.createElement(MarkdownBlock, {
        content: '![inline](https://cdn.example.com/inline.png)',
        onOpenMediaLightbox: (items, idx) => mdOpened.push({ items, idx }),
      }),
    );
    let stopped = false;
    mdView.tree.props.onClick({
      target: mockImgEl,
      preventDefault() {},
      stopPropagation() {
        stopped = true;
      },
    });
    assert.equal(stopped, true);
    assert.equal(mdOpened[0]?.idx, 0);
    assert.equal(mdOpened[0]?.items[0]?.src, 'https://cdn.example.com/inline.png');
    mdView.unmount();
  } finally {
    globalThis.Element = prevElement;
  }

  // 4. MessageAttachments：带与不带 onOpenMediaLightbox 分流
  const attDelegated = [];
  const attDriver1 = createReactHookDriver();
  const attV1 = attDriver1.mount(() =>
    React.createElement(MessageAttachments, {
      attachments: [{ id: 'i1', name: 'a.png', sizeBytes: 10, type: 'image', previewUrl: 'data:image/png;base64,AA==' }],
      variant: 'bubble',
      onOpenMediaLightbox: (items, idx) => attDelegated.push({ items, idx }),
    }),
  );
  findAll(attV1.tree, (n) => n.props?.className === 'conv-att-image-btn')[0].props.onClick();
  assert.equal(attDelegated.length, 1);
  attV1.unmount();

  const attDriver2 = createReactHookDriver();
  const attV2 = attDriver2.mount(() =>
    React.createElement(MessageAttachments, {
      attachments: [{ id: 'i1', name: 'a.png', sizeBytes: 10, type: 'image', previewUrl: 'data:image/png;base64,AA==' }],
      variant: 'bubble',
    }),
  );
  findAll(attV2.tree, (n) => n.props?.className === 'conv-att-image-btn')[0].props.onClick();
  attV2.rerender();
  assert.equal(findAll(attV2.tree, (n) => n.props?.['data-expanded'] === 'true').length, 1);
  attV2.unmount();

  // 5. ConversationMessageList：宿主委派 vs 内置 Portal 灯箱回退 + TurnGroup memo 比较 imagePath
  const delegatedLb = [];
  const baseSnap = {
    mode: 'scratchpad',
    connection: 'connected',
    isStreaming: false,
    messages: [{ id: 'a1', role: 'assistant', content: 'MEDIA:data:image/png;base64,AA==\n\n已出图' }],
  };
  const listDriver1 = createReactHookDriver();
  const listV1 = listDriver1.mount(() =>
    React.createElement(ConversationMessageList, {
      snapshot: { ...baseSnap, onOpenMediaLightbox: (items, idx) => delegatedLb.push({ items, idx }) },
    }),
  );
  const delivBtn1 = findAll(listV1.tree, (n) => n.props?.['data-testid'] === 'turn-deliverable-image')[0];
  assert.ok(delivBtn1, 'ConversationMessageList 内必须渲染 TurnDeliverables 图片按钮');
  delivBtn1.props.onClick();
  assert.equal(delegatedLb.length, 1);
  listV1.unmount();

  const prevDoc = globalThis.document;
  globalThis.document = {
    body: { nodeType: 1 },
    getElementById: () => ({ id: 'flux-file-type-sprite' }),
  };
  try {
    const listDriver2 = createReactHookDriver();
    const listV2 = listDriver2.mount(() =>
      React.createElement(ConversationMessageList, { snapshot: baseSnap }),
    );
    const delivBtn2 = findAll(listV2.tree, (n) => n.props?.['data-testid'] === 'turn-deliverable-image')[0];
    delivBtn2.props.onClick();
    listV2.rerender();
    const portalNode = findAll(listV2.tree, (n) => n?.$$typeof === Symbol.for('react.portal'))[0];
    assert.ok(portalNode?.children?.props?.onClose, '未传 onOpenMediaLightbox 时必须渲染内置 MediaLightbox Portal');
    portalNode.children.props.onClose();
    listV2.rerender();
    listV2.unmount();
  } finally {
    globalThis.document = prevDoc;
  }

  assert.equal(typeof TurnGroup.compare, 'function');
  const sharedProps = {
    mode: 'scratchpad',
    isLastTurn: true,
    isStreaming: false,
    knownFiles: [],
    messages: [{ id: 'a1', role: 'assistant', content: 'hi', toolCalls: [{ id: 't1', name: 'draw', status: 'done', imagePath: '/out/1.png' }] }],
  };
  assert.equal(
    TurnGroup.compare(sharedProps, {
      ...sharedProps,
      messages: [{ id: 'a1', role: 'assistant', content: 'hi', toolCalls: [{ id: 't1', name: 'draw', status: 'done', imagePath: '/out/1.png' }] }],
    }),
    true,
  );
  assert.equal(
    TurnGroup.compare(sharedProps, {
      ...sharedProps,
      messages: [{ id: 'a1', role: 'assistant', content: 'hi', toolCalls: [{ id: 't1', name: 'draw', status: 'done', imagePath: '/out/2.png' }] }],
    }),
    false,
    'toolCalls.imagePath 变化必须触发 TurnGroup 重渲染',
  );
  assert.equal(
    TurnGroup.compare(sharedProps, {
      ...sharedProps,
      messages: [{ id: 'a1', role: 'assistant', content: 'hi', toolCalls: [{ id: 't1', name: 'draw', status: 'done', imagePath: '/out/1.png', inlineDiff: '+x' }] }],
    }),
    false,
    'toolCalls.inlineDiff 变化必须触发 TurnGroup 重渲染',
  );
  assert.equal(
    TurnGroup.compare(sharedProps, { ...sharedProps, verifiedDeliverablePaths: ['/out/extra.pdf'] }),
    false,
    'verifiedDeliverablePaths 引用变化必须触发 TurnGroup 重渲染',
  );

  // TurnGroup 子代理隔离与唯一纯文件名原地去重（正文 `out.html` 与底部不应重复出现）
  const dedupHtml = renderToStaticMarkup(
    React.createElement(TurnGroup, {
      mode: 'scratchpad',
      isLastTurn: true,
      isStreaming: false,
      subagentWrittenPaths: ['/out/sub.md'],
      messages: [
        {
          id: 'a-dedup',
          role: 'assistant',
          content: '请查看 `out.html`（普通回合不含委派工具）',
          toolCalls: [{ id: 'tc-w', name: 'write_file', status: 'done', args: JSON.stringify({ path: '/dir/out.html' }) }],
        },
      ],
    }),
  );
  assert.ok(dedupHtml.includes('data-deliverable-card="true"'), '唯一纯文件名引用应在正文就地成卡');
  assert.equal(dedupHtml.includes('data-testid="turn-deliverables"'), false, '已被正文纯文件名卡片覆盖的成果物禁止底部重复输出');
  assert.equal(dedupHtml.includes('sub.md'), false, '无 delegation 工具的普通回合严禁混入 subagentWrittenPaths');

  // MediaLightbox <img> onError 自动经 resolveMediaUrl 兜底（同源网关直链失败场景）及失败态切换
  const errDriver = createReactHookDriver();
  let errResolveCalls = 0;
  const errItems = [{ id: 'img-err', src: 'https://gw.example.com/media/a.png', path: '/ws/a.png', name: 'a.png' }];
  const errView = errDriver.mount(() =>
    React.createElement(MediaLightbox, {
      items: errItems,
      initialIndex: 0,
      onClose() {},
      resolveMediaUrl: async () => {
        errResolveCalls += 1;
        return null;
      },
    }),
  );
  const imgNode = findAll(errView.tree, (n) => n.type === 'img' && n.props?.className === 'flux-lightbox__image')[0];
  assert.equal(typeof imgNode?.props?.onError, 'function');
  imgNode.props.onError();
  await new Promise((r) => setTimeout(r, 10));
  errView.rerender();
  assert.equal(errResolveCalls, 1);
  assert.equal(findAll(errView.tree, (n) => n.props?.['data-testid'] === 'lightbox-error').length, 1);
  const retryErrBtn = findAll(errView.tree, (n) => n.props?.['data-testid'] === 'lightbox-retry')[0];
  retryErrBtn.props.onClick({ stopPropagation() {} });
  errView.rerender();
  errView.unmount();

  // MediaLightbox <img> onError 经 resolveMediaUrl 恢复后再失败及 reject 分支
  const recoverDriver = createReactHookDriver();
  const recoverItems = [{ id: 'img-rec', src: 'https://gw.example.com/media/b.png', path: '/ws/b.png', name: 'b.png' }];
  let recStep = 0;
  const recView = recoverDriver.mount(() =>
    React.createElement(MediaLightbox, {
      items: recoverItems,
      initialIndex: 0,
      onClose() {},
      resolveMediaUrl: async () => {
        recStep += 1;
        if (recStep === 1) return 'data:image/png;base64,RECOVERED';
        throw new Error('retry failed');
      },
    }),
  );
  findAll(recView.tree, (n) => n.type === 'img' && n.props?.className === 'flux-lightbox__image')[0].props.onError();
  await new Promise((r) => setTimeout(r, 10));
  recView.rerender();
  const recoveredImg = findAll(recView.tree, (n) => n.type === 'img' && n.props?.className === 'flux-lightbox__image')[0];
  assert.equal(recoveredImg.props.src, 'data:image/png;base64,RECOVERED');
  recoveredImg.props.onError();
  recView.rerender();
  assert.equal(findAll(recView.tree, (n) => n.props?.['data-testid'] === 'lightbox-error').length, 1);
  recView.unmount();

  // resolveMediaUrl 缺失时，<img> onError 也安全进入失败态（不崩溃）
  const noResolverDriver = createReactHookDriver();
  const noResolverItems = [{ id: 'img-no-res', src: 'https://cdn.example.com/missing.png', name: 'missing.png' }];
  const noResolverView = noResolverDriver.mount(() =>
    React.createElement(MediaLightbox, {
      items: noResolverItems,
      initialIndex: 0,
      onClose() {},
    }),
  );
  findAll(noResolverView.tree, (n) => n.type === 'img' && n.props?.className === 'flux-lightbox__image')[0].props.onError();
  noResolverView.rerender();
  assert.equal(findAll(noResolverView.tree, (n) => n.props?.['data-testid'] === 'lightbox-error').length, 1);
  noResolverView.unmount();

  // resolveMediaUrl 抛出异常时 onError 也进入失败态
  const rejectDriver = createReactHookDriver();
  const rejectItems = [{ id: 'img-rej', src: 'https://gw.example.com/media/c.png', path: '/ws/c.png', name: 'c.png' }];
  const rejectView = rejectDriver.mount(() =>
    React.createElement(MediaLightbox, {
      items: rejectItems,
      initialIndex: 0,
      onClose() {},
      resolveMediaUrl: async () => {
        throw new Error('network error');
      },
    }),
  );
  findAll(rejectView.tree, (n) => n.type === 'img' && n.props?.className === 'flux-lightbox__image')[0].props.onError();
  await new Promise((r) => setTimeout(r, 10));
  rejectView.rerender();
  assert.equal(findAll(rejectView.tree, (n) => n.props?.['data-testid'] === 'lightbox-error').length, 1);
  rejectView.unmount();

  // TurnDeliverables 图片缩略图 onError（包含已解析 URL 与直接预览 URL 两种状态）
  const tdErrDriver = createReactHookDriver();
  const tdErrDeliverables = [{ id: 'td-img', kind: 'image', path: '/ws/thumb.png', name: 'thumb.png', previewUrl: 'https://gw.example.com/thumb.png', messageId: 'm1', source: 'tool_image' }];
  const tdErrMessages = [];
  const tdErrView = tdErrDriver.mount(() =>
    React.createElement(TurnDeliverables, {
      isStreaming: false,
      deliverables: tdErrDeliverables,
      resolveMediaUrl: async () => null,
      messages: tdErrMessages,
    }),
  );
  const thumbImg = findAll(tdErrView.tree, (n) => n.type === 'img' && n.props?.className === 'conv-deliverable-image__img')[0];
  assert.equal(typeof thumbImg?.props?.onError, 'function');
  thumbImg.props.onError();
  await Promise.resolve();
  await Promise.resolve();
  tdErrView.rerender();
  assert.equal(findAll(tdErrView.tree, (n) => n.props?.className === 'conv-deliverable-retry-btn').length >= 1, true);
  tdErrView.unmount();

  const tdDirectDriver = createReactHookDriver();
  const tdDirectDeliverables = [{ id: 'td-img-2', kind: 'image', path: '/ws/thumb2.png', name: 'thumb2.png', messageId: 'm1', source: 'tool_image' }];
  const tdDirectMessages = [];
  const tdDirectView = tdDirectDriver.mount(() =>
    React.createElement(TurnDeliverables, {
      isStreaming: false,
      deliverables: tdDirectDeliverables,
      resolveMediaUrl: async () => 'data:image/png;base64,THUMB',
      messages: tdDirectMessages,
    }),
  );
  await new Promise((r) => setTimeout(r, 10));
  tdDirectView.rerender();
  const thumbImg2 = findAll(tdDirectView.tree, (n) => n.type === 'img' && n.props?.className === 'conv-deliverable-image__img')[0];
  thumbImg2.props.onError();
  tdDirectView.rerender();
  assert.equal(findAll(tdDirectView.tree, (n) => n.props?.className === 'conv-deliverable-retry-btn').length >= 1, true);
  tdDirectView.unmount();

  // TurnDeliverables: 直接预览 URL 加载失败后先走 resolveMediaUrl(img.path) 挽救再定成败；MediaLightbox: items 变更清缓存 & same-src URL 失败后回退 resolver
  const flushMicro = async () => {
    await Promise.resolve();
    await Promise.resolve();
  };
  const rescueDriver = createReactHookDriver();
  const rescueView = rescueDriver.mount(() =>
    React.createElement(TurnDeliverables, {
      isStreaming: false,
      deliverables: [{ id: 'td-rescue', kind: 'image', path: '/ws/rescue.png', name: 'rescue.png', previewUrl: 'http://127.0.0.1:8642/api/files/download?path=/ws/rescue.png', messageId: 'm1', source: 'tool_image' }],
      resolveMediaUrl: async (target) => (target === '/ws/rescue.png' ? 'data:image/png;base64,RESCUED' : null),
      messages: [],
    }),
  );
  const rescueImg = findAll(rescueView.tree, (n) => n.type === 'img' && n.props?.className === 'conv-deliverable-image__img')[0];
  rescueImg.props.onError();
  await flushMicro();
  rescueView.rerender();
  const updatedRescueImg = findAll(rescueView.tree, (n) => n.type === 'img' && n.props?.className === 'conv-deliverable-image__img')[0];
  assert.equal(updatedRescueImg?.props?.src, 'data:image/png;base64,RESCUED');
  rescueView.unmount();

  const lbResetDriver = createReactHookDriver();
  let lbItems = [{ id: 'img-same', src: '/ws/first.png', path: '/ws/first.png', name: 'first.png' }];
  const lbResetView = lbResetDriver.mount(() =>
    React.createElement(MediaLightbox, {
      items: lbItems,
      initialIndex: 0,
      onClose() {},
      resolveMediaUrl: async (target) => (target.includes('first') ? 'data:image/png;base64,FIRST' : 'data:image/png;base64,SECOND'),
    }),
  );
  await flushMicro();
  lbResetView.rerender();
  assert.equal(findAll(lbResetView.tree, (n) => n.type === 'img' && n.props?.className === 'flux-lightbox__image')[0]?.props?.src, 'data:image/png;base64,FIRST');
  lbItems = [{ id: 'img-same', src: '/ws/second.png', path: '/ws/second.png', name: 'second.png' }];
  lbResetView.rerender();
  await flushMicro();
  lbResetView.rerender();
  assert.equal(findAll(lbResetView.tree, (n) => n.type === 'img' && n.props?.className === 'flux-lightbox__image')[0]?.props?.src, 'data:image/png;base64,SECOND');
  // 已解析条目触发 onError 后进入错误态并可点击重试清缓存
  findAll(lbResetView.tree, (n) => n.type === 'img' && n.props?.className === 'flux-lightbox__image')[0].props.onError();
  lbResetView.rerender();
  const retryBtn = findAll(lbResetView.tree, (n) => n.props?.['data-testid'] === 'lightbox-retry')[0];
  assert.ok(retryBtn);
  retryBtn.props.onClick({ stopPropagation() {} });
  lbResetView.rerender();
  await flushMicro();
  lbResetView.rerender();
  assert.equal(findAll(lbResetView.tree, (n) => n.type === 'img' && n.props?.className === 'flux-lightbox__image')[0]?.props?.src, 'data:image/png;base64,SECOND');
  lbResetView.unmount();

  // TurnDeliverables: previewUrl onError 回退 resolveMediaUrl reject 分支
  const tdRejView = rescueDriver.mount(() =>
    React.createElement(TurnDeliverables, {
      isStreaming: false,
      deliverables: [{ id: 'td-rej', kind: 'image', path: '/ws/rej.png', name: 'rej.png', previewUrl: 'https://gw.example.com/rej.png', messageId: 'm1', source: 'tool_image' }],
      resolveMediaUrl: async () => { throw new Error('boom'); },
      messages: [],
    }),
  );
  findAll(tdRejView.tree, (n) => n.type === 'img' && n.props?.className === 'conv-deliverable-image__img')[0].props.onError();
  await flushMicro();
  tdRejView.rerender();
  assert.equal(findAll(tdRejView.tree, (n) => n.props?.className === 'conv-deliverable-retry-btn').length >= 1, true);
  tdRejView.unmount();

  // TurnDeliverables: 启动期 connection='connecting' 遇 401 失败后，当 connection 转为 'connected' 时自动清除失败态并重试成功
  let bootAuthed = false;
  let bootConn = 'connecting';
  const reconnectView = rescueDriver.mount(() =>
    React.createElement(TurnDeliverables, {
      isStreaming: false,
      connection: bootConn,
      deliverables: [{ id: 'td-boot', kind: 'image', path: '/opt/data/cache/boot.png', name: 'boot.png', messageId: 'm-boot', source: 'tool_image' }],
      resolveMediaUrl: async () => (bootAuthed ? 'data:image/png;base64,AFTERAUTH' : null),
      messages: [],
    }),
  );
  await flushMicro();
  reconnectView.rerender();
  assert.equal(findAll(reconnectView.tree, (n) => n.props?.className === 'conv-deliverable-retry-btn').length >= 1, true);
  bootAuthed = true;
  bootConn = 'connected';
  reconnectView.rerender();
  reconnectView.rerender();
  await flushMicro();
  reconnectView.rerender();
  const healedImg = findAll(reconnectView.tree, (n) => n.type === 'img' && n.props?.className === 'conv-deliverable-image__img')[0];
  assert.equal(healedImg?.props?.src, 'data:image/png;base64,AFTERAUTH');
  reconnectView.unmount();

  // TurnGroup: connection prop 变化触发 memo 重算并透传到 TurnDeliverables
  const tgDriver = createReactHookDriver();
  let tgConn = 'connecting';
  const tgView = tgDriver.mount(() =>
    React.createElement(TurnGroup, {
      messages: [
        {
          id: 'tg-msg-1',
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'tc-1', name: 'image_gen', status: 'completed', args: '', imagePath: '/opt/data/tg.png' }],
        },
      ],
      mode: 'scratchpad',
      connection: tgConn,
      isLastTurn: true,
      isStreaming: false,
      resolveMediaUrl: async () => 'data:image/png;base64,VEc=',
    }),
  );
  tgConn = 'connected';
  tgView.rerender();
  assert.ok(tgView.tree);
  tgView.unmount();
});
