import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerPowerEvents } from '../../dist/main/powerEvents.mjs';

const require = createRequire(import.meta.url);
const Module = require('node:module');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, '../..');

test('powerEvents: registers suspend/resume/unlock-screen once and guards destroyed windows', () => {
  const listeners = new Map();
  const sent = [];
  const winState = {
    destroyed: false,
    webContentsDestroyed: false,
  };

  const mockMonitor = {
    on(event, fn) {
      listeners.set(event, fn);
    },
    removeListener(event, fn) {
      if (listeners.get(event) === fn) listeners.delete(event);
    },
  };

  const mockWindow = {
    isDestroyed: () => winState.destroyed,
    webContents: {
      isDestroyed: () => winState.webContentsDestroyed,
      send: (channel, kind) => sent.push({ channel, kind }),
    },
  };

  let activeWin = mockWindow;
  const cleanup = registerPowerEvents(mockMonitor, () => activeWin);

  listeners.get('suspend')?.();
  listeners.get('resume')?.();
  listeners.get('unlock-screen')?.();
  assert.deepEqual(sent, [
    { channel: 'system:power-event', kind: 'suspend' },
    { channel: 'system:power-event', kind: 'resume' },
    { channel: 'system:power-event', kind: 'unlock' },
  ]);

  // Guard: null window, destroyed window, destroyed webContents must not send
  activeWin = null;
  listeners.get('resume')?.();
  activeWin = mockWindow;
  winState.destroyed = true;
  listeners.get('resume')?.();
  winState.destroyed = false;
  winState.webContentsDestroyed = true;
  listeners.get('unlock-screen')?.();
  assert.equal(sent.length, 3);

  cleanup();
  assert.equal(listeners.size, 0);
});

function loadCjsWithElectronMock(cjsPath, mockElectron) {
  const prevLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return mockElectron;
    return prevLoad.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[require.resolve(cjsPath)];
    return require(cjsPath);
  } finally {
    Module._load = prevLoad;
  }
}

test('ipc fetchWithTimeout & gateway:authenticate 3-hop flow pass abort signal and clean timers', async () => {
  const handlers = new Map();
  const ipcMod = loadCjsWithElectronMock(path.join(desktopDir, 'dist/main/ipc.cjs'), {
    ipcMain: {
      handle: (ch, fn) => handlers.set(ch, fn),
      removeHandler: (ch) => handlers.delete(ch),
      on: () => {},
    },
    BrowserWindow: class {},
    shell: {},
    dialog: {},
    app: { getPath: () => '', isPackaged: false },
    clipboard: {},
  });

  // 1. Direct fetchWithTimeout branches
  const okRes = await ipcMod.fetchWithTimeout(
    'https://gw.example/api/status',
    { headers: { Accept: 'application/json' } },
    500,
    async (_url, init) => {
      assert.ok(init.signal instanceof AbortSignal);
      assert.equal(init.signal.aborted, false);
      return { ok: true, status: 200 };
    },
  );
  assert.equal(okRes.status, 200);

  await assert.rejects(
    ipcMod.fetchWithTimeout(
      'https://gw.example/api/status',
      undefined,
      15,
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new Error('aborted by timeout')));
        }),
    ),
    /aborted by timeout/,
  );

  await assert.rejects(
    ipcMod.fetchWithTimeout('https://gw.example/api/status', undefined, 500, async () => {
      throw new Error('ECONNREFUSED');
    }),
    /ECONNREFUSED/,
  );

  // 2. Register IPC handlers and invoke gateway:authenticate 3-hop auth path
  ipcMod.registerIpcHandlers({
    isDestroyed: () => false,
    isFullScreen: () => false,
    isMaximized: () => false,
    on: () => {},
    webContents: { send: () => {}, isDestroyed: () => false },
  });
  const authHandler = handlers.get('gateway:authenticate');
  assert.equal(typeof authHandler, 'function');

  const prevFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url, init) => {
      assert.ok(init?.signal instanceof AbortSignal);
      const u = String(url);
      if (u.endsWith('/api/status')) {
        return { ok: true, status: 200, json: async () => ({ auth_required: true, version: '0.24.0' }) };
      }
      if (u.endsWith('/auth/password-login')) {
        return { ok: true, status: 200, headers: new Headers({ 'set-cookie': 'sid=abc; Path=/; HttpOnly' }) };
      }
      if (u.endsWith('/api/auth/ws-ticket')) {
        return { ok: true, status: 200, json: async () => ({ ticket: 'desktop-ticket-1' }) };
      }
      throw new Error(`unexpected url ${u}`);
    };
    const res = await authHandler({}, { url: 'https://gw.example', username: 'u', password: 'p' });
    assert.equal(res.ok, true);
    assert.equal(res.ticket, 'desktop-ticket-1');

    let canceledCount = 0;
    globalThis.fetch = async () => ({
      ok: false,
      status: 503,
      body: { cancel: async () => { canceledCount += 1; } },
    });
    const statusFail = await authHandler({}, { url: 'https://gw.example', username: 'u', password: 'p' });
    assert.equal(statusFail.ok, false);
    assert.equal(canceledCount, 1);

    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.endsWith('/api/status')) {
        return { ok: true, status: 200, json: async () => ({ auth_required: true }) };
      }
      if (u.endsWith('/auth/password-login')) {
        return { ok: true, status: 200, headers: new Headers() };
      }
      return { ok: false, status: 500, body: { cancel: async () => { canceledCount += 1; } } };
    };
    const ticketFail = await authHandler({}, { url: 'https://gw.example', username: 'u', password: 'p' });
    assert.equal(ticketFail.ok, false);
    assert.equal(canceledCount, 2);
  } finally {
    globalThis.fetch = prevFetch;
  }
});

test('main/index wires powerMonitor into registerPowerEvents inside app.whenReady', async () => {
  const tempUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-main-boot-'));
  const appListeners = new Map();
  const powerListeners = new Map();
  const sentToWindow = [];

  class MockBrowserWindow {
    static getAllWindows() {
      return [this._instance];
    }
    constructor() {
      MockBrowserWindow._instance = this;
      this.webContents = {
        isDestroyed: () => false,
        send: (ch, payload) => sentToWindow.push({ ch, payload }),
        on() {},
        isDevToolsOpened: () => false,
        closeDevTools() {},
        openDevTools() {},
        focus() {},
      };
    }
    loadFile() { return Promise.resolve(); }
    once() {}
    on() {}
    isDestroyed() { return false; }
    isMinimized() { return false; }
    isMaximized() { return false; }
    isFullScreen() { return false; }
    restore() {}
    focus() {}
    show() {}
  }

  try {
    const registeredSchemes = [];
    loadCjsWithElectronMock(path.join(desktopDir, 'dist/main/index.js'), {
      protocol: {
        registerSchemesAsPrivileged: (schemes) => {
          registeredSchemes.push(...schemes);
        },
        handle: () => {},
      },
      app: {
        getPath: () => tempUserData,
        getVersion: () => '0.1.0',
        isPackaged: false,
        requestSingleInstanceLock: () => true,
        quit: () => {},
        whenReady: () => Promise.resolve(),
        on: (ev, fn) => appListeners.set(ev, fn),
        commandLine: { appendSwitch: () => {} },
      },
      BrowserWindow: MockBrowserWindow,
      powerMonitor: {
        on: (ev, fn) => powerListeners.set(ev, fn),
        removeListener: (ev, fn) => {
          if (powerListeners.get(ev) === fn) powerListeners.delete(ev);
        },
      },
      ipcMain: { handle: () => {}, removeHandler: () => {}, on: () => {} },
      shell: {},
      dialog: {},
      clipboard: {},
      screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1440, height: 900 } }) },
      nativeImage: {
        createFromPath: () => ({
          isEmpty: () => true,
          resize() {
            return this;
          },
          setTemplateImage() {},
        }),
      },
      Tray: class {
        setToolTip() {}
        setContextMenu() {}
        on() {}
        destroy() {}
      },
      Menu: { buildFromTemplate: () => ({}) },
    });

    await new Promise((r) => setTimeout(r, 20));
    assert.equal(registeredSchemes[0]?.scheme, 'hermes-media');
    assert.equal(registeredSchemes[0]?.privileges?.stream, true);
    powerListeners.get('resume')?.();
    assert.deepEqual(sentToWindow, [{ ch: 'system:power-event', payload: 'resume' }]);
    appListeners.get('before-quit')?.();
    await new Promise((r) => setTimeout(r, 15));
  } finally {
    fs.rmSync(tempUserData, { recursive: true, force: true });
  }
});

test('preload bridge: exposes onPowerEvent subscribing/unsubscribing system:power-event', () => {
  let exposedBridge = null;
  const listeners = new Map();
  loadCjsWithElectronMock(path.join(desktopDir, 'dist/preload/index.js'), {
    contextBridge: {
      exposeInMainWorld: (_name, api) => {
        exposedBridge = api;
      },
    },
    ipcRenderer: {
      invoke: async () => undefined,
      send: () => {},
      on: (ch, fn) => {
        listeners.set(ch, fn);
      },
      removeListener: (ch, fn) => {
        if (listeners.get(ch) === fn) listeners.delete(ch);
      },
    },
  });

  assert.equal(typeof exposedBridge?.onPowerEvent, 'function');
  const events = [];
  const off = exposedBridge.onPowerEvent((kind) => events.push(kind));
  listeners.get('system:power-event')?.({}, 'resume');
  listeners.get('system:power-event')?.({}, 'suspend');
  assert.deepEqual(events, ['resume', 'suspend']);
  off();
  assert.equal(listeners.has('system:power-event'), false);
});
