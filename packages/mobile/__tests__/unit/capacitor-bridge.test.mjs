/**
 * Hermes Flux Mobile Capacitor PlatformBridge 单元测试
 * (packages/mobile/__tests__/unit/capacitor-bridge.test.mjs)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function createDomEnv(initialStorage = {}, viewport = {}) {
  const prevWindow = globalThis.window;
  const prevDocument = globalThis.document;
  const store = new Map(Object.entries(initialStorage));
  const listeners = new Map();
  const vvListeners = new Map();
  const rootProps = new Map();

  const visualViewport = viewport.visualViewport
    ? {
        height: viewport.visualViewport.height,
        offsetTop: viewport.visualViewport.offsetTop ?? 0,
        addEventListener: (type, fn) => {
          if (!vvListeners.has(type)) vvListeners.set(type, []);
          vvListeners.get(type).push(fn);
        },
        emit: (type, nextProps = {}) => {
          Object.assign(visualViewport, nextProps);
          for (const fn of vvListeners.get(type) ?? []) {
            fn();
          }
        },
      }
    : undefined;

  const win = {
    innerWidth: 'innerWidth' in viewport ? viewport.innerWidth : 390,
    innerHeight: 'innerHeight' in viewport ? viewport.innerHeight : 844,
    visualViewport,
    localStorage: {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, val) => store.set(key, String(val)),
    },
    addEventListener: (type, fn) => {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    dispatchEvent: (ev) => {
      for (const fn of listeners.get(ev.type) ?? []) {
        fn(ev);
      }
      return !ev.defaultPrevented;
    },
  };

  globalThis.window = win;
  globalThis.document = {
    documentElement: {
      style: {
        setProperty: (name, val) => rootProps.set(name, val),
      },
    },
  };

  return {
    win,
    rootProps,
    emitResize: (nextWidth, nextHeight) => {
      win.innerWidth = nextWidth;
      win.innerHeight = nextHeight;
      win.dispatchEvent({ type: 'resize' });
    },
    restore: () => {
      globalThis.window = prevWindow;
      globalThis.document = prevDocument;
    },
  };
}

// 仅加载一次 ESM 产物（避免带 query 参数重导污染 V8 LCOV 记录），同时覆盖顶层自动注入分支
const bootstrapEnv = createDomEnv();
const {
  createCapacitorPlatformBridge,
  resolveCssKeyboardHeight,
  resolveVisualViewportKeyboardHeight,
} = await import('../../dist/capacitor-bridge.mjs');
const autoInjectedMobile = bootstrapEnv.win.hermesMobile;
const autoInjectedDesktop = bootstrapEnv.win.hermesDesktop;
bootstrapEnv.restore();

test('模块顶层 window 检测在首次加载时自动注入唯一全局入口与默认插件回退', async () => {
  assert.ok(autoInjectedMobile, 'window.hermesMobile 必须自动挂载');
  assert.equal(autoInjectedDesktop, autoInjectedMobile, 'window.hermesDesktop 必须指向同一桥实例');

  // 无 overrides 参数调一次，覆盖 `overrides?.app ?? App` 等默认回退分支
  const defaultBridge = createCapacitorPlatformBridge();
  const info = await defaultBridge.getSystemInfo();
  assert.equal(typeof info.platform, 'string');
});

test('createCapacitorPlatformBridge 支持 Android / iOS 平台识别与 UA 回落', async () => {
  const androidBridge = createCapacitorPlatformBridge({
    platform: 'android',
    isPluginAvailable: () => false,
    app: {
      getInfo: async () => ({ version: '2.4.0' }),
      minimizeApp: async () => {},
      addListener: async () => ({ remove: async () => {} }),
    },
  });
  const sysAndroid = await androidBridge.getSystemInfo();
  assert.equal(sysAndroid.platform, 'android');
  assert.equal(sysAndroid.appVersion, '2.4.0');
  assert.equal(sysAndroid.isMobile, true);
  assert.equal(sysAndroid.isDesktop, false);

  const iosFromUa = createCapacitorPlatformBridge({
    platform: 'web',
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)',
    isPluginAvailable: () => false,
    app: {
      getInfo: async () => {
        throw new Error('not available on web');
      },
      minimizeApp: async () => {
        throw new Error('unsupported');
      },
      addListener: async () => ({ remove: async () => {} }),
    },
  });
  const sysIos = await iosFromUa.getSystemInfo();
  assert.equal(sysIos.platform, 'ios');
  assert.equal(sysIos.appVersion, '0.1.0');
  await assert.doesNotReject(() => iosFromUa.minimize());
  await assert.doesNotReject(() => iosFromUa.close());
  assert.equal(await iosFromUa.maximize(), false);
  await assert.doesNotReject(() => iosFromUa.unmaximize());
  assert.equal(await iosFromUa.isMaximized(), false);
  await assert.doesNotReject(() => iosFromUa.activateWindow?.());
  assert.equal(typeof iosFromUa.onWindowStateChange(() => {}), 'function');

  const androidFromUa = createCapacitorPlatformBridge({
    platform: 'web',
    userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9)',
    isPluginAvailable: () => false,
    app: {
      getInfo: async () => ({ version: '' }),
      minimizeApp: async () => {},
      addListener: async () => ({ remove: async () => {} }),
    },
  });
  const sysAndroidUa = await androidFromUa.getSystemInfo();
  assert.equal(sysAndroidUa.platform, 'android');
  assert.equal(sysAndroidUa.appVersion, '0.1.0');

  const webFallback = createCapacitorPlatformBridge({
    platform: 'web',
    userAgent: 'CustomBrowser/1.0',
    isPluginAvailable: () => false,
    app: {
      getInfo: async () => ({ version: '1.0.0' }),
      minimizeApp: async () => {},
      addListener: async () => ({ remove: async () => {} }),
    },
  });
  assert.equal((await webFallback.getSystemInfo()).platform, 'web');

  // 覆盖 navigator 不可用时的 UA 安全回退分支
  const navDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value: undefined, configurable: true });
  try {
    const noNavBridge = createCapacitorPlatformBridge({ platform: 'web', isPluginAvailable: () => false });
    assert.equal((await noNavBridge.getSystemInfo()).platform, 'web');
  } finally {
    if (navDesc) Object.defineProperty(globalThis, 'navigator', navDesc);
  }
});

test('getDefaultGatewayConfig 遵循 hermes_flux_* 优先与 hermes_aura_* 兼容回退', async () => {
  const env1 = createDomEnv({
    hermes_flux_gateway_url: 'https://flux.example.com',
    hermes_aura_gateway_url: 'https://old.example.com',
    hermes_flux_profile: 'arch',
    hermes_aura_profile: 'legacy',
  });
  try {
    const b1 = createCapacitorPlatformBridge({ platform: 'android', isPluginAvailable: () => false });
    assert.deepEqual(await b1.getDefaultGatewayConfig(), {
      url: 'https://flux.example.com',
      key: '',
      profile: 'arch',
    });
  } finally {
    env1.restore();
  }

  const env2 = createDomEnv({
    hermes_aura_gateway_url: 'https://old.example.com',
    hermes_aura_profile: 'legacy',
  });
  try {
    const b2 = createCapacitorPlatformBridge({ platform: 'android', isPluginAvailable: () => false });
    assert.deepEqual(await b2.getDefaultGatewayConfig(), {
      url: 'https://old.example.com',
      key: '',
      profile: 'legacy',
    });
  } finally {
    env2.restore();
  }

  const env3 = createDomEnv({});
  try {
    const b3 = createCapacitorPlatformBridge({ platform: 'android', isPluginAvailable: () => false });
    assert.deepEqual(await b3.getDefaultGatewayConfig(), { url: '', key: '', profile: 'default' });
  } finally {
    env3.restore();
  }
});

test('StatusBar、Keyboard 软键盘避让与 Android backButton 返回消费闭环', async () => {
  const env = createDomEnv();
  try {
    const statusStyles = [];
    const appListeners = new Map();
    const kbListeners = new Map();
    let minimizeCalls = 0;
    let shouldThrowStatusBar = false;
    let shouldRejectMinimize = false;

    const bridge = createCapacitorPlatformBridge({
      platform: 'android',
      isPluginAvailable: (name) => name === 'StatusBar' || name === 'Keyboard' || name === 'App',
      statusBar: {
        setStyle: async ({ style }) => {
          if (shouldThrowStatusBar) throw new Error('status bar unsupported');
          statusStyles.push(style);
        },
      },
      keyboard: {
        addListener: async (eventName, cb) => {
          kbListeners.set(eventName, cb);
          return { remove: async () => {} };
        },
      },
      app: {
        getInfo: async () => ({ version: '0.1.0' }),
        minimizeApp: async () => {
          minimizeCalls += 1;
          if (shouldRejectMinimize) throw new Error('minimize rejected');
        },
        addListener: async (eventName, cb) => {
          appListeners.set(eventName, cb);
          return { remove: async () => {} };
        },
      },
    });

    await bridge.syncStatusBarAppearance?.('dark');
    await bridge.syncStatusBarAppearance?.('light');
    assert.deepEqual(statusStyles, ['DARK', 'LIGHT']);

    shouldThrowStatusBar = true;
    await assert.doesNotReject(() => bridge.syncStatusBarAppearance?.('dark'));

    // StatusBar 不可用时早退
    const noStatusBar = createCapacitorPlatformBridge({
      platform: 'ios',
      isPluginAvailable: () => false,
      statusBar: {
        setStyle: async () => {
          throw new Error('must not be called');
        },
      },
    });
    await assert.doesNotReject(() => noStatusBar.syncStatusBarAppearance?.('dark'));

    // Keyboard show/hide -> Android adjustResize 下保持 --keyboard-height 为 0px，仅老旧未收缩兜底
    // 1) willShow 在 Android 上一律输出 0px，防止布局未落定前 1 帧跳顶
    kbListeners.get('keyboardWillShow')?.({ keyboardHeight: 340 });
    assert.equal(env.rootProps.get('--keyboard-height'), '0px');

    // 2) 原生 SystemBars 已收缩 WebView (844 -> 504) -> didShow 仍锁死 0px
    env.emitResize(390, 504);
    kbListeners.get('keyboardDidShow')?.({ keyboardHeight: 340 });
    assert.equal(env.rootProps.get('--keyboard-height'), '0px');

    // 3) 隐藏键盘恢复高度，校验 keyboardWillHide & keyboardDidHide 归零与基线自愈
    kbListeners.get('keyboardWillHide')?.();
    assert.equal(env.rootProps.get('--keyboard-height'), '0px');
    env.win.innerHeight = 860;
    kbListeners.get('keyboardDidHide')?.();
    assert.equal(env.rootProps.get('--keyboard-height'), '0px');

    // 4) 极端未收缩老旧 ROM 回落场景（860 -> 860）：didShow 才允许注入 340px
    kbListeners.get('keyboardDidShow')?.({ keyboardHeight: 340 });
    assert.equal(env.rootProps.get('--keyboard-height'), '340px');
    kbListeners.get('keyboardDidHide')?.();
    assert.equal(env.rootProps.get('--keyboard-height'), '0px');

    // 5) 横屏/分屏宽度变化重设基准高度 + 同宽向上校准基线 + 无效 resize 值忽略
    env.emitResize(0, 0);
    env.emitResize(844, 390);
    env.emitResize(844, 360);
    kbListeners.get('keyboardDidShow')?.({ keyboardHeight: 220 });
    assert.equal(env.rootProps.get('--keyboard-height'), '220px');
    env.emitResize(844, 420);
    env.emitResize(844, 360);
    kbListeners.get('keyboardDidShow')?.({ keyboardHeight: 220 });
    assert.equal(env.rootProps.get('--keyboard-height'), '0px');

    // 6) info 缺失分支与无 document 降级
    kbListeners.get('keyboardDidShow')?.(undefined);
    assert.equal(env.rootProps.get('--keyboard-height'), '0px');

    const savedDoc = globalThis.document;
    globalThis.document = undefined;
    try {
      kbListeners.get('keyboardWillShow')?.({ keyboardHeight: 100 });
      kbListeners.get('keyboardWillHide')?.();
    } finally {
      globalThis.document = savedDoc;
    }

    // App foreground resume -> hermes-mobile-resume, background -> hermes-mobile-pause
    let resumeCount = 0;
    let pauseCount = 0;
    env.win.addEventListener('hermes-mobile-resume', () => {
      resumeCount += 1;
    });
    env.win.addEventListener('hermes-mobile-pause', () => {
      pauseCount += 1;
    });
    appListeners.get('appStateChange')?.({ isActive: false });
    assert.equal(resumeCount, 0);
    assert.equal(pauseCount, 1);
    appListeners.get('appStateChange')?.({ isActive: true });
    assert.equal(resumeCount, 1);

    // Android backButton：无消费者时退到后台；被 preventDefault 消费后绝不退后台
    appListeners.get('backButton')?.();
    assert.equal(minimizeCalls, 1);

    shouldRejectMinimize = true;
    appListeners.get('backButton')?.();
    shouldRejectMinimize = false;
    assert.equal(minimizeCalls, 2);

    env.win.addEventListener('hermes-mobile-back', (ev) => {
      ev.preventDefault();
    });
    appListeners.get('backButton')?.();
    assert.equal(minimizeCalls, 2, '当表现壳消费了返回事件后不得调用 minimizeApp');

    // window 定义与缺失两种环境下的剪贴板内存读写兜底 + backButton 安全早退
    assert.equal(await bridge.clipboardWrite('with-win'), true);
    assert.equal(await bridge.clipboardRead(), 'with-win');

    const savedWin = globalThis.window;
    globalThis.window = undefined;
    try {
      appListeners.get('backButton')?.();
      assert.equal(await bridge.clipboardWrite('no-win'), true);
      assert.equal(await bridge.clipboardRead(), '');
    } finally {
      globalThis.window = savedWin;
    }

    // addListener 拒绝时 .catch(() => {}) 吞错不断链
    createCapacitorPlatformBridge({
      platform: 'android',
      isPluginAvailable: () => true,
      keyboard: {
        addListener: async () => {
          throw new Error('kb listen rejected');
        },
      },
      app: {
        getInfo: async () => ({ version: '0.1.0' }),
        minimizeApp: async () => {},
        addListener: async () => {
          throw new Error('app listen rejected');
        },
      },
      network: {
        getStatus: async () => {
          throw new Error('net status rejected');
        },
        addListener: async () => {
          throw new Error('net listen rejected');
        },
      },
    });
    await new Promise((r) => setTimeout(r, 10));

    // minimizeApp 成功与失败均稳健
    await bridge.minimize();
    await bridge.close();
    assert.equal(minimizeCalls, 4);

    // HermesWsProxy UA 存在时暴露同源 WS 隧道重写钩子，缺失时不注入
    assert.equal(bridge.proxyWebSocketUrl, undefined);
    const proxiedBridge = createCapacitorPlatformBridge({
      platform: 'android',
      userAgent: 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 HermesWsProxy/43125',
      isPluginAvailable: () => false,
    });
    assert.equal(typeof proxiedBridge.proxyWebSocketUrl, 'function');
    assert.equal(
      proxiedBridge.proxyWebSocketUrl('ws://10.0.0.8:8642/api/ws?ticket=abc'),
      'ws://127.0.0.1:43125/__gw/ws?target=ws%3A%2F%2F10.0.0.8%3A8642%2Fapi%2Fws%3Fticket%3Dabc',
    );
  } finally {
    env.restore();
  }
});

test('resolveCssKeyboardHeight 与 resolveVisualViewportKeyboardHeight 精准区分 Android / iOS / Web 避让策略', () => {
  // 1. 零/负/非有限值一律归零
  assert.equal(
    resolveCssKeyboardHeight({
      isNativeAndroid: true,
      reportedKeyboardHeight: 0,
      baselineViewportHeight: 844,
      currentViewportHeight: 844,
      phase: 'didShow',
    }),
    0,
  );
  assert.equal(
    resolveCssKeyboardHeight({
      isNativeAndroid: false,
      reportedKeyboardHeight: Number.NaN,
      baselineViewportHeight: 844,
      currentViewportHeight: 844,
      phase: 'willShow',
    }),
    0,
  );
  assert.equal(
    resolveCssKeyboardHeight({
      isNativeAndroid: false,
      reportedKeyboardHeight: -20,
      baselineViewportHeight: 844,
      currentViewportHeight: 844,
      phase: 'didShow',
    }),
    0,
  );

  // 2. iOS (KeyboardResize.None) 全量注入键盘高度
  assert.equal(
    resolveCssKeyboardHeight({
      isNativeAndroid: false,
      reportedKeyboardHeight: 336.4,
      baselineViewportHeight: 844,
      currentViewportHeight: 844,
      phase: 'willShow',
    }),
    336,
  );
  assert.equal(
    resolveCssKeyboardHeight({
      isNativeAndroid: false,
      reportedKeyboardHeight: 336,
      baselineViewportHeight: 844,
      currentViewportHeight: 844,
      phase: 'didShow',
    }),
    336,
  );

  // 3. Android adjustResize：willShow 锁 0；已收缩（含 WebView < 140 三键导航栏场景）锁 0；小悬浮键盘 <80 锁 0
  assert.equal(
    resolveCssKeyboardHeight({
      isNativeAndroid: true,
      reportedKeyboardHeight: 340,
      baselineViewportHeight: 844,
      currentViewportHeight: 844,
      phase: 'willShow',
    }),
    0,
  );
  assert.equal(
    resolveCssKeyboardHeight({
      isNativeAndroid: true,
      reportedKeyboardHeight: 340,
      baselineViewportHeight: 844,
      currentViewportHeight: 504,
      phase: 'didShow',
    }),
    0,
  );
  // WebView < 140 且带 48px 导航栏：reported=340, actualShrink=292，绝不得相减成 48px 悬空缝
  assert.equal(
    resolveCssKeyboardHeight({
      isNativeAndroid: true,
      reportedKeyboardHeight: 340,
      baselineViewportHeight: 756,
      currentViewportHeight: 464,
      phase: 'didShow',
    }),
    0,
  );
  assert.equal(
    resolveCssKeyboardHeight({
      isNativeAndroid: true,
      reportedKeyboardHeight: 60,
      baselineViewportHeight: 844,
      currentViewportHeight: 844,
      phase: 'didShow',
    }),
    0,
  );
  assert.equal(
    resolveCssKeyboardHeight({
      isNativeAndroid: true,
      reportedKeyboardHeight: 340,
      baselineViewportHeight: 0,
      currentViewportHeight: 504,
      phase: 'didShow',
    }),
    0,
  );
  // 极端未收缩老旧 ROM 回退注入
  assert.equal(
    resolveCssKeyboardHeight({
      isNativeAndroid: true,
      reportedKeyboardHeight: 340,
      baselineViewportHeight: 844,
      currentViewportHeight: 844,
      phase: 'didShow',
    }),
    340,
  );

  // 4. Mobile Web visualViewport 求解
  assert.equal(resolveVisualViewportKeyboardHeight(844, 508, 0), 336);
  assert.equal(resolveVisualViewportKeyboardHeight(504, 504, 0), 0);
  assert.equal(resolveVisualViewportKeyboardHeight(844, 800, 0), 0);
  assert.equal(resolveVisualViewportKeyboardHeight(Number.NaN, 500, 0), 0);
});

test('iOS Keyboard 生命周期、resize-before-willShow 竞态、Mobile Web visualViewport 回退与原生配置契约', () => {
  // 1. Android resize 先于 keyboardWillShow 到达时，基线不被覆盖，仍锁死 0px
  const raceEnv = createDomEnv({}, { innerWidth: 390, innerHeight: 844 });
  try {
    const raceKb = new Map();
    createCapacitorPlatformBridge({
      platform: 'android',
      isPluginAvailable: (name) => name === 'Keyboard',
      keyboard: {
        addListener: async (eventName, cb) => {
          raceKb.set(eventName, cb);
          return { remove: async () => {} };
        },
      },
    });
    raceEnv.emitResize(390, 504);
    raceKb.get('keyboardWillShow')?.({ keyboardHeight: 340 });
    assert.equal(raceEnv.rootProps.get('--keyboard-height'), '0px');
    raceKb.get('keyboardDidShow')?.({ keyboardHeight: 340 });
    assert.equal(raceEnv.rootProps.get('--keyboard-height'), '0px');
  } finally {
    raceEnv.restore();
  }

  // 2. iOS KeyboardResize.None 完整生命周期
  const iosEnv = createDomEnv({}, { innerWidth: 390, innerHeight: 844 });
  try {
    const iosKb = new Map();
    createCapacitorPlatformBridge({
      platform: 'ios',
      isPluginAvailable: (name) => name === 'Keyboard',
      keyboard: {
        addListener: async (eventName, cb) => {
          iosKb.set(eventName, cb);
          return { remove: async () => {} };
        },
      },
    });
    iosKb.get('keyboardWillShow')?.({ keyboardHeight: 336 });
    assert.equal(iosEnv.rootProps.get('--keyboard-height'), '336px');
    iosKb.get('keyboardDidShow')?.({ keyboardHeight: 336 });
    assert.equal(iosEnv.rootProps.get('--keyboard-height'), '336px');
    iosKb.get('keyboardWillHide')?.();
    assert.equal(iosEnv.rootProps.get('--keyboard-height'), '0px');
    iosKb.get('keyboardDidHide')?.();
    assert.equal(iosEnv.rootProps.get('--keyboard-height'), '0px');
  } finally {
    iosEnv.restore();
  }

  // 3. Mobile Web 无 Keyboard 插件时走 visualViewport resize / scroll 同步
  const webEnv = createDomEnv(
    {},
    { innerWidth: 390, innerHeight: 844, visualViewport: { height: 844, offsetTop: 0 } },
  );
  try {
    createCapacitorPlatformBridge({
      platform: 'web',
      isPluginAvailable: () => false,
    });
    webEnv.win.visualViewport.emit('resize', { height: 508, offsetTop: 0 });
    assert.equal(webEnv.rootProps.get('--keyboard-height'), '336px');
    webEnv.win.visualViewport.emit('scroll', { height: 844, offsetTop: 0 });
    assert.equal(webEnv.rootProps.get('--keyboard-height'), '0px');
  } finally {
    webEnv.restore();
  }

  // 4. 无 window / 无数字尺寸分支
  const savedWin = globalThis.window;
  globalThis.window = undefined;
  try {
    createCapacitorPlatformBridge({ platform: 'web', isPluginAvailable: () => false });
  } finally {
    globalThis.window = savedWin;
  }

  // 5. AndroidManifest.xml 与 capacitor.config.json 原生契约守卫
  const here = path.dirname(fileURLToPath(import.meta.url));
  const manifestPath = path.resolve(here, '../../android/app/src/main/AndroidManifest.xml');
  const capConfigPath = path.resolve(here, '../../capacitor.config.json');
  const manifest = fs.readFileSync(manifestPath, 'utf8');
  const capConfig = JSON.parse(fs.readFileSync(capConfigPath, 'utf8'));

  assert.ok(
    manifest.includes('android:windowSoftInputMode="adjustResize"'),
    'AndroidManifest.xml 必须显式声明 android:windowSoftInputMode="adjustResize"',
  );
  assert.equal(
    capConfig?.plugins?.SystemBars?.initialViewportFitValueHint,
    'cover',
    'capacitor.config.json 必须声明 SystemBars.initialViewportFitValueHint="cover"',
  );
});

test('hapticSelection 与 saveFile remoteUrl 下载导出契约', async () => {
  let hapticCalls = 0;
  const hapticsBridge = createCapacitorPlatformBridge({
    platform: 'android',
    isPluginAvailable: (name) => name === 'Haptics',
    haptics: {
      selectionChanged: async () => {
        hapticCalls += 1;
      },
    },
  });
  await hapticsBridge.hapticSelection?.();
  assert.equal(hapticCalls, 1);

  const hapticThrowBridge = createCapacitorPlatformBridge({
    platform: 'android',
    isPluginAvailable: (name) => name === 'Haptics',
    haptics: {
      selectionChanged: async () => {
        throw new Error('vibrator missing');
      },
    },
  });
  await assert.doesNotReject(() => hapticThrowBridge.hapticSelection?.() ?? Promise.resolve());

  const hapticOffBridge = createCapacitorPlatformBridge({
    platform: 'web',
    isPluginAvailable: () => false,
  });
  await assert.doesNotReject(() => hapticOffBridge.hapticSelection?.() ?? Promise.resolve());

  // saveFile remoteUrl 失败回退外部浏览器分支（HTTP 非 200 & fetch 抛错）
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('500')) return { ok: false, status: 500 };
    return {
      ok: true,
      arrayBuffer: async () => new Uint8Array([72, 105]).buffer,
    };
  };
  try {
    const resFail = await hapticsBridge.saveFile({
      fileName: 'bad.bin',
      content: 'fallback',
      remoteUrl: 'https://gw.example/api/fs/raw?id=500',
    });
    assert.equal(resFail.success, true);
    assert.equal(resFail.filePath, 'https://gw.example/api/fs/raw?id=500');

    // HTTP 200 ArrayBuffer -> base64 -> Filesystem.writeFile（mock 无原生 plugin 时进入 catch error，也已验证 ArrayBuffer 编码分支）
    const resOkFetch = await hapticsBridge.saveFile({
      fileName: 'ok.bin',
      content: '',
      remoteUrl: 'https://gw.example/api/fs/raw?id=200',
    });
    assert.equal(typeof resOkFetch.success, 'boolean');

    // 无 remoteUrl：data URL 与纯文本两条 content 分支
    const resDataUrl = await hapticsBridge.saveFile({
      fileName: 'clip.txt',
      content: 'data:text/plain;base64,SGk=',
    });
    assert.equal(typeof resDataUrl.success, 'boolean');
    const resPlainText = await hapticsBridge.saveFile({
      fileName: 'plain.txt',
      content: 'hello world',
    });
    assert.equal(typeof resPlainText.success, 'boolean');

    // 非法协议/格式坏 remoteUrl 不得调用 fetch，sourcePath 空内容分支走 Filesystem.readFile 兜底
    let badRemoteFetched = false;
    globalThis.fetch = async () => {
      badRemoteFetched = true;
      return { ok: true, arrayBuffer: async () => new ArrayBuffer(0) };
    };
    const resBadScheme = await hapticsBridge.saveFile({
      fileName: 'bad-scheme.txt',
      content: '',
      remoteUrl: 'file:///etc/passwd',
    });
    assert.equal(resBadScheme.success, false);
    const resBadUrl = await hapticsBridge.saveFile({
      fileName: 'bad-url.txt',
      content: '',
      remoteUrl: 'http://[::1',
    });
    assert.equal(resBadUrl.success, false);
    assert.equal(badRemoteFetched, false);

    const resSourcePath = await hapticsBridge.saveFile({
      fileName: 'from-src.bin',
      content: '',
      sourcePath: '/cache/src.bin',
    });
    assert.equal(typeof resSourcePath.success, 'boolean');

    // 注入 filesystem & share Mock：覆盖 sourcePath 直读落盘（675-677）与成功返回路径
    const readCalls = [];
    const writeCalls = [];
    const shareCalls = [];
    const mockFsBridge = createCapacitorPlatformBridge({
      platform: 'android',
      isPluginAvailable: (name) => name === 'Haptics',
      filesystem: {
        readFile: async (opts) => {
          readCalls.push(opts);
          return { data: 'SGk=' };
        },
        writeFile: async (opts) => {
          writeCalls.push(opts);
          return { uri: `file:///docs/${opts.path}` };
        },
      },
      share: {
        share: async (opts) => {
          shareCalls.push(opts);
          return {};
        },
      },
    });
    const resMockSource = await mockFsBridge.saveFile({
      fileName: 'src.bin',
      content: '',
      sourcePath: '/cache/src.bin',
    });
    assert.equal(resMockSource.success, true);
    assert.equal(resMockSource.filePath, 'file:///docs/src.bin');
    assert.deepEqual(readCalls, [{ path: '/cache/src.bin' }]);
    assert.equal(writeCalls[0]?.data, 'SGk=');
    assert.equal(shareCalls[0]?.url, 'file:///docs/src.bin');
  } finally {
    globalThis.fetch = prevFetch;
  }
});

test('Capacitor Network 原生网络切换监听、getNetworkStatus 降级与鉴权请求超时保护', async () => {
  const env = createDomEnv();
  const prevFetch = globalThis.fetch;
  try {
    let networkListener = null;
    const dispatched = [];
    env.win.addEventListener('hermes-mobile-network-change', (ev) => {
      dispatched.push(ev.detail);
    });

    let statusCall = 0;
    const bridge = createCapacitorPlatformBridge({
      platform: 'ios',
      isPluginAvailable: (name) => name === 'Network',
      authTimeoutMs: 25,
      network: {
        getStatus: async () => {
          statusCall += 1;
          if (statusCall === 1) return { connected: true, connectionType: '' };
          if (statusCall === 2) return { connected: true, connectionType: 'wifi' };
          if (statusCall === 3) return { connected: true, connectionType: '' };
          throw new Error('network status unavailable');
        },
        addListener: async (_eventName, cb) => {
          networkListener = cb;
          return { remove: async () => {} };
        },
      },
    });

    await new Promise((r) => setTimeout(r, 10));

    // Wi-Fi -> Cellular 触发事件并保留 previousType
    networkListener?.({ connected: true, connectionType: 'cellular' });
    networkListener?.({ connected: false, connectionType: '' });
    assert.deepEqual(dispatched, [
      { connected: true, connectionType: 'cellular', previousType: 'unknown' },
      { connected: false, connectionType: 'unknown', previousType: 'cellular' },
    ]);

    // window 缺失时安全早退不抛错
    const savedWin = globalThis.window;
    globalThis.window = undefined;
    try {
      networkListener?.({ connected: true, connectionType: 'wifi' });
    } finally {
      globalThis.window = savedWin;
    }

    // getNetworkStatus 成功与降级分支
    assert.deepEqual(await bridge.getNetworkStatus?.(), { connected: true, connectionType: 'wifi' });
    assert.deepEqual(await bridge.getNetworkStatus?.(), { connected: true, connectionType: 'unknown' });

    const navDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    Object.defineProperty(globalThis, 'navigator', { value: { onLine: false }, configurable: true });
    assert.deepEqual(await bridge.getNetworkStatus?.(), { connected: false, connectionType: 'none' });
    Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true });
    assert.deepEqual(await bridge.getNetworkStatus?.(), { connected: true, connectionType: 'unknown' });
    Object.defineProperty(globalThis, 'navigator', { value: undefined, configurable: true });
    assert.deepEqual(await bridge.getNetworkStatus?.(), { connected: true, connectionType: 'unknown' });
    if (navDesc) Object.defineProperty(globalThis, 'navigator', navDesc);

    // authenticateGateway 超时中断必须及时 aborted 并返回 ok: false
    globalThis.fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('auth fetch aborted')));
      });
    const authRes = await bridge.authenticateGateway({
      url: 'https://gw.example',
      username: 'u',
      password: 'p',
    });
    assert.equal(authRes.ok, false);
    assert.match(authRes.message, /auth fetch aborted/);

    // 3 跳完整鉴权成功闭环（覆蓋 login + ws-ticket 正常响应路径）
    let hop = 0;
    globalThis.fetch = async (reqUrl) => {
      hop += 1;
      const u = String(reqUrl);
      if (u.endsWith('/api/status')) {
        return { ok: true, status: 200, json: async () => ({ auth_required: true, version: '0.24.0' }) };
      }
      if (u.endsWith('/auth/password-login')) {
        return { ok: true, status: 200 };
      }
      if (u.endsWith('/api/auth/ws-ticket')) {
        return { ok: true, status: 200, json: async () => ({ ticket: 'mobile-ticket-1' }) };
      }
      throw new Error(`unexpected url ${u}`);
    };
    const okAuth = await bridge.authenticateGateway({
      url: 'https://gw.example',
      username: 'u',
      password: 'p',
    });
    assert.equal(hop, 3);
    assert.equal(okAuth.ok, true);
    assert.equal(okAuth.ticket, 'mobile-ticket-1');

    // httpProxy 必须强制超时中止悬空请求，避免后台恢复后半开通道永久卡死
    const proxyTimeoutBridge = createCapacitorPlatformBridge({
      platform: 'ios',
      isPluginAvailable: () => false,
      httpProxyTimeoutMs: 25,
    });
    globalThis.fetch = (_reqUrl, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('httpProxy aborted by timeout')));
      });
    await assert.rejects(
      proxyTimeoutBridge.httpProxy({ baseUrl: 'https://gw.example', path: '/api/sessions' }),
      /httpProxy aborted by timeout/,
    );

    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ ok: true }),
    });
    assert.deepEqual(
      await proxyTimeoutBridge.httpProxy({ baseUrl: 'https://gw.example', path: '/api/sessions' }),
      { ok: true },
    );
  } finally {
    globalThis.fetch = prevFetch;
    env.restore();
  }
});
