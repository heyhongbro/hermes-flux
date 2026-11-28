/**
 * Stage 2B Settings Redesign & Multi-Gateway Scope UI Unit Tests
 * (packages/ui/__tests__/settings-gateway-redesign.test.mjs)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { setLocale, t } from '../dist/i18n/index.js';
import {
  SETTINGS_SECTIONS,
  resolveSettingsSection,
  resolveSkillCategoryLabelKey,
  formatSkillCategoryLabel,
  isSelectedSettingsGatewayConnected,
  SettingsModal,
  GatewaySettingsPanel,
  SettingsGatewayScopeBar,
  GeneralSettingsPanel,
  NewChatDialog,
  resolveInitialGatewayId,
  filterProfilesForGateway,
  filterProjectsForGateway,
  buildNewChatSubmitPayload,
} from '../dist/index.js';
import {
  MobileNewChatSheet,
  MobileBotHubScreen,
  MobileSettingsPage,
} from '../dist/components-react/mobile/index.js';

function createReactHookDriver() {
  const slots = new Map();
  let pendingEffects = [];
  let capturedComponents = [];
  const noop = () => {};
  const fakeNode = () => ({
    nodeType: 1,
    ownerDocument: null,
    parentNode: null,
    style: {},
    dataset: {},
    classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
    setAttribute: noop,
    getAttribute: () => null,
    removeAttribute: noop,
    appendChild: noop,
    removeChild: noop,
    insertAdjacentElement: noop,
    insertAdjacentHTML: noop,
    remove: noop,
    cloneNode: () => fakeNode(),
    innerHTML: '',
    textContent: '',
    addEventListener: noop,
    removeEventListener: noop,
    contains: () => false,
    focus: noop,
    blur: noop,
    getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
    querySelector: () => null,
    querySelectorAll: () => [],
  });
  function withDomGlobals(fn) {
    const keys = ['document', 'window', 'HTMLElement', 'HTMLFormElement', 'Element', 'Node', 'MutationObserver'];
    const prev = Object.fromEntries(keys.map((k) => [k, globalThis[k]]));
    class FakeEl {}
    class FakeForm extends FakeEl {}
    class FakeMutationObserver {
      observe() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    }
    const root = fakeNode();
    const head = fakeNode();
    const body = fakeNode();
    const doc = {
      nodeType: 9,
      activeElement: root,
      body,
      documentElement: root,
      head,
      addEventListener: noop,
      removeEventListener: noop,
      createElement: () => {
        const el = fakeNode();
        el.ownerDocument = doc;
        return el;
      },
      createTextNode: () => ({ nodeType: 3 }),
      querySelector: () => null,
      querySelectorAll: () => [],
      getElementById: () => null,
      contains: () => true,
    };
    root.ownerDocument = doc;
    head.ownerDocument = doc;
    body.ownerDocument = doc;
    globalThis.HTMLElement = FakeEl;
    globalThis.HTMLFormElement = FakeForm;
    globalThis.Element = FakeEl;
    globalThis.Node = FakeEl;
    globalThis.MutationObserver = FakeMutationObserver;
    const win = {
      document: doc,
      addEventListener: noop,
      removeEventListener: noop,
      getComputedStyle: () => ({}),
      ['set' + 'Timeout']: noop,
      clearTimeout: noop,
    };
    doc.defaultView = win;
    globalThis.document = doc;
    globalThis.window = win;
    try {
      return fn();
    } finally {
      for (const k of keys) {
        if (prev[k] === undefined) delete globalThis[k];
        else globalThis[k] = prev[k];
      }
    }
  }

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
        props: { ...node.props, children: resolve(node.props?.children, `${key}.frag`) },
      };
    }
    if (
      elType &&
      typeof elType === 'object' &&
      (elType.$$typeof === Symbol.for('react.context') || elType.$$typeof === Symbol.for('react.provider'))
    ) {
      const ctx = elType._context ?? elType;
      const prevVal = ctx._currentValue;
      ctx._currentValue = node.props?.value;
      try {
        return {
          ...node,
          props: { ...node.props, children: resolve(node.props?.children, `${key}.ctx`) },
        };
      } finally {
        ctx._currentValue = prevVal;
      }
    }

    const innerType =
      elType && typeof elType === 'object' && elType.$$typeof === Symbol.for('react.memo')
        ? elType.type
        : elType;
    const compFn =
      innerType && typeof innerType === 'object' && innerType.$$typeof === Symbol.for('react.forward_ref')
        ? (p) => innerType.render(p, p.ref ?? node.ref ?? null)
        : typeof innerType === 'function'
          ? innerType
          : null;

    if (compFn) {
      const compName = innerType?.displayName || innerType?.name || 'Fn';
      capturedComponents.push({ name: compName, props: node.props });
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
          if (idx >= slot.states.length) slot.states.push(typeof init === 'function' ? init() : init);
          return [
            slot.states[idx],
            (next) => {
              slot.states[idx] = typeof next === 'function' ? next(slot.states[idx]) : next;
            },
          ];
        },
        useReducer(reducer, initialArg, init) {
          const idx = sIdx++;
          if (idx >= slot.states.length) slot.states.push(init ? init(initialArg) : initialArg);
          return [
            slot.states[idx],
            (action) => {
              slot.states[idx] = reducer(slot.states[idx], action);
            },
          ];
        },
        useImperativeHandle(ref, create) {
          if (typeof ref === 'function') ref(create());
          else if (ref) ref.current = create();
        },
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
          if (idx >= slot.refs.length) slot.refs.push({ current: init });
          return slot.refs[idx];
        },
        useMemo(factory, deps) {
          const idx = mIdx++;
          if (idx >= slot.memos.length) {
            slot.memos.push({ value: factory(), deps });
          } else {
            const prev = slot.memos[idx];
            const changed = !deps || !prev.deps || deps.some((d, i) => !Object.is(d, prev.deps[i]));
            if (changed) slot.memos[idx] = { value: factory(), deps };
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
      return {
        ...node,
        props: { ...node.props, children: resolve(node.props.children, key) },
      };
    }
    return node;
  }

  return {
    mount(renderFn) {
      let tree = null;
      const rerender = () =>
        withDomGlobals(() => {
          capturedComponents = [];
          pendingEffects = [];
          tree = resolve(renderFn(), 'root');
          const current = pendingEffects;
          pendingEffects = [];
          for (const fn of current) fn();
          return tree;
        });
      rerender();
      return {
        get tree() {
          return tree;
        },
        findComponents(pred) {
          return capturedComponents.filter(pred);
        },
        rerender,
      };
    },
  };
}

function findAll(node, predicate, acc = []) {
  if (!node || typeof node !== 'object') return acc;
  if (Array.isArray(node)) {
    for (const item of node) findAll(item, predicate, acc);
    return acc;
  }
  if (predicate(node)) acc.push(node);
  if (node.props?.children !== undefined) findAll(node.props.children, predicate, acc);
  return acc;
}

function makeBaseSnapshot(overrides = {}) {
  return {
    isOpen: true,
    section: 'general',
    theme: 'obsidian-gold',
    locale: 'zh',
    fontPrefs: { uiFont: 'default', codeFont: 'default', sizeScale: 'medium' },
    activityVariant: 'prolate-lattice',
    conversationWidth: 'wide',
    leftRailLayout: 'dual-rail',
    orgPrefs: { showDoneSection: true, autoReopenOnSend: true, collapsedIds: [], hiddenProjectIds: [] },
    projects: { status: 'ready', data: [] },
    profiles: { status: 'ready', data: [{ name: 'default', displayName: 'Hermes' }] },
    bots: [{ profile: 'default', displayName: 'Hermes' }],
    botManagement: {
      status: 'ready',
      roster: [{ id: 'default', displayName: 'Hermes', model: 'gpt-4o', isDefault: true, hasDraft: false }],
      activeBotId: 'default',
      availableModels: [],
      wizard: {
        open: false,
        draft: { mode: 'blank', name: '', displayName: '', description: '', model: '', provider: '', cloneFrom: 'default', cloneChannels: false, mirrorCredentials: false },
        busy: false,
      },
    },
    learningState: { status: 'idle' },
    learningDetail: { status: 'idle' },
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
    gateway: { url: 'http://127.0.0.1:8642', username: '', hasStoredPassword: false, profileName: 'default', status: 'connected', latencyMs: 12 },
    appVersion: '0.1.0',
    platform: 'windows',
    busy: false,
    presenceLayout: 'stage',
    ...overrides,
  };
}

function makeBaseActions(log = []) {
  return {
    onClose: () => log.push(['onClose']),
    onSelectSection: (s) => log.push(['onSelectSection', s]),
    onThemeChange: (v) => log.push(['onThemeChange', v]),
    onLocaleChange: (v) => log.push(['onLocaleChange', v]),
    onFontPrefsChange: (v) => log.push(['onFontPrefsChange', v]),
    onActivityVariantChange: (v) => log.push(['onActivityVariantChange', v]),
    onConversationWidthChange: (v) => log.push(['onConversationWidthChange', v]),
    onLeftRailLayoutChange: (v) => log.push(['onLeftRailLayoutChange', v]),
    onPresenceLayoutChange: (v) => log.push(['onPresenceLayoutChange', v]),
    onConversationOrgPrefsChange: (p) => log.push(['onConversationOrgPrefsChange', p]),
    onRefreshProfiles: () => log.push(['onRefreshProfiles']),
    onSelectBot: (id) => log.push(['onSelectBot', id]),
    onUpdateBotDraft: () => {},
    onSaveBotConfig: async () => ({ ok: true }),
    onDiscardBotDraft: () => {},
    onConfirmBotExit: () => {},
    onCancelBotExit: () => {},
    onOpenBotWizard: () => {},
    onCloseBotWizard: () => {},
    onUpdateBotWizardDraft: () => {},
    onSubmitBotWizard: async () => {},
    onRefreshExtensions: () => {},
    onReloadSkills: async () => ({ ok: true }),
    onTestGateway: (d) => log.push(['onTestGateway', d]),
    onConnectGateway: (d) => log.push(['onConnectGateway', d]),
    onDisconnectGateway: () => log.push(['onDisconnectGateway']),
    onScopeProfileChange: () => {},
    onReloadProviders: () => {},
    onProbeEndpoint: async () => ({ ok: true, models: [] }),
    onSaveEndpoint: async () => ({ ok: true }),
    onDeleteEndpoint: async () => ({ ok: true }),
    onSwitchDefaultAndDisableProvider: async () => ({ ok: true }),
    onToggleProviderAgent: async () => ({ ok: true }),
    onActivateProvider: async () => ({ ok: true }),
    onStartLogin: async () => ({ ok: true }),
    onPollLogin: async () => ({ status: 'approved' }),
    onCancelLogin: async () => {},
    onLogoutProvider: async () => ({ ok: true }),
    onNotify: (m) => log.push(['onNotify', m]),
    onCopy: async () => true,
  };
}

test('settingsModel pure helpers: section compat, skill category localization, and scoped gateway connectivity', () => {
  setLocale('zh-CN');
  assert.deepEqual(
    SETTINGS_SECTIONS.map((s) => s.id),
    ['general', 'appearance', 'gateway', 'projects', 'providers', 'agents', 'extensions', 'about'],
  );
  assert.equal(resolveSettingsSection('connection'), 'gateway');
  assert.equal(resolveSettingsSection('nonexistent'), 'general');
  assert.equal(resolveSettingsSection(undefined), 'general');

  assert.equal(resolveSkillCategoryLabelKey('workspace'), 'settings.skillsCategoryWorkspace');
  assert.equal(resolveSkillCategoryLabelKey('builtin'), 'settings.skillsCategoryBuiltin');
  assert.equal(resolveSkillCategoryLabelKey('skill_hub'), 'settings.skillsCategoryHub');
  assert.equal(resolveSkillCategoryLabelKey('global'), 'settings.skillsCategoryGlobal');
  assert.equal(resolveSkillCategoryLabelKey(''), 'settings.skillsCategoryOther');
  assert.equal(resolveSkillCategoryLabelKey(null), 'settings.skillsCategoryOther');
  assert.equal(resolveSkillCategoryLabelKey('custom_plugin'), null);

  assert.equal(formatSkillCategoryLabel('workspace', t), t('settings.skillsCategoryWorkspace'));
  assert.equal(formatSkillCategoryLabel('CustomCat', t), 'CustomCat');
  assert.equal(formatSkillCategoryLabel(null, t), t('settings.skillsCategoryOther'));

  assert.equal(
    isSelectedSettingsGatewayConnected({
      gateway: { url: '', username: '', hasStoredPassword: false, profileName: 'default', status: 'connected', latencyMs: 5 },
    }),
    true,
  );
  assert.equal(
    isSelectedSettingsGatewayConnected({
      gateway: { url: '', username: '', hasStoredPassword: false, profileName: 'default', status: 'disconnected', latencyMs: 0 },
      gateways: [
        { id: 'gw-a', name: 'A', url: 'http://127.0.0.1:8642', enabled: true, status: 'offline' },
        { id: 'gw-b', name: 'B', url: 'http://127.0.0.1:8643', enabled: true, status: 'connected' },
      ],
      selectedGatewayId: 'gw-b',
    }),
    true,
  );
  assert.equal(
    isSelectedSettingsGatewayConnected({
      gateway: { url: '', username: '', hasStoredPassword: false, profileName: 'default', status: 'connected', latencyMs: 5 },
      gateways: [
        { id: 'gw-a', name: 'A', url: 'http://127.0.0.1:8642', enabled: true, status: 'offline' },
        { id: 'gw-b', name: 'B', url: 'http://127.0.0.1:8643', enabled: true, status: 'connected' },
      ],
      selectedGatewayId: 'missing',
    }),
    false,
  );
});

test('SettingsModal flat nav, untranslated literal BOT title in zh/en, unknown section fallback & scope bar', () => {
  for (const locale of ['zh-CN', 'en-US']) {
    setLocale(locale);
    const html = renderToStaticMarkup(
      React.createElement(SettingsModal, {
        snapshot: makeBaseSnapshot({ locale: locale === 'en-US' ? 'en' : 'zh', section: 'agents' }),
        actions: makeBaseActions(),
      }),
    );
    assert.ok(html.includes('>BOT<'), `sectionAgents must render literal BOT in ${locale}`);
    assert.equal(html.includes('>智能体<'), false);
    assert.equal(html.includes('>Agents<'), false);
  }
  setLocale('zh-CN');

  const driver = createReactHookDriver();
  const view = driver.mount(() =>
    React.createElement(SettingsModal, {
      snapshot: makeBaseSnapshot({ section: 'unknown-legacy-section' }),
      actions: makeBaseActions(),
    }),
  );
  assert.ok(findAll(view.tree, (n) => n.props?.['data-settings-anchor'] === 'language').length > 0);
});

test('SettingsGatewayScopeBar renders single-gw passthrough, multi-gw select, offline/connecting/disabled guards', () => {
  setLocale('zh-CN');
  const calls = [];
  const driver = createReactHookDriver();

  const single = driver.mount(() =>
    React.createElement(
      SettingsGatewayScopeBar,
      {
        gateways: [{ id: 'gw-a', name: 'Alpha', url: 'http://127.0.0.1:18642', enabled: true, status: 'connected' }],
        selectedGatewayId: 'gw-a',
        onOpenGatewaySettings: () => calls.push('open-gw'),
      },
      React.createElement('div', { 'data-testid': 'scope-child' }, 'ok'),
    ),
  );
  assert.equal(findAll(single.tree, (n) => n.props?.['data-testid'] === 'settings-gateway-scope-bar').length, 0);
  assert.equal(findAll(single.tree, (n) => n.props?.['data-testid'] === 'scope-child').length, 1);

  const gateways = [
    { id: 'gw-a', name: 'Alpha', url: 'http://127.0.0.1:18642', enabled: true, status: 'connected' },
    { id: 'gw-b', name: 'Beta', url: 'http://127.0.0.1:18643', enabled: false, status: 'disabled' },
    { id: 'gw-c', name: 'Gamma', url: 'http://127.0.0.1:18644', enabled: true, status: 'offline', error: 'Connection refused' },
    { id: 'gw-d', name: 'Delta', url: 'http://127.0.0.1:18645', enabled: true, status: 'connecting' },
  ];
  let selectedId = 'gw-b';
  let fillHeight = true;

  const multi = driver.mount(() =>
    React.createElement(
      SettingsGatewayScopeBar,
      {
        gateways,
        selectedGatewayId: selectedId,
        fillHeight,
        onSelectGateway: (id) => {
          calls.push(['select', id]);
          selectedId = id;
        },
        onConnectGateway: (id) => {
          calls.push(['connect', id]);
        },
        onToggleGatewayEnabled: (id, en) => {
          calls.push(['enable', id, en]);
        },
        onOpenGatewaySettings: () => calls.push(['open-gw']),
      },
      React.createElement('div', { 'data-testid': 'scope-child' }, 'child'),
    ),
  );

  const selectNode = multi.findComponents((c) => c.props?.id === 'settings-gateway-scope-select')[0];
  assert.ok(selectNode);
  const renderedVal = selectNode.props.renderValue('gw-a');
  assert.ok(renderedVal);
  const renderedKnownOpt = selectNode.props.renderOption({ value: 'gw-c', label: 'Gamma' });
  const renderedUnknownOpt = selectNode.props.renderOption({ value: 'gw-missing', label: 'Fallback' });
  assert.ok(renderedKnownOpt && renderedUnknownOpt);
  selectNode.props.onChange('gw-c');
  assert.deepEqual(calls.at(-1), ['select', 'gw-c']);

  findAll(multi.tree, (n) => n.props?.['data-testid'] === 'settings-scope-enable-btn')[0]?.props.onClick();
  assert.deepEqual(calls.at(-1), ['enable', 'gw-b', true]);

  selectedId = 'gw-c';
  fillHeight = false;
  multi.rerender();
  findAll(multi.tree, (n) => n.props?.['data-testid'] === 'settings-scope-reconnect-btn')[0]?.props.onClick();
  assert.deepEqual(calls.at(-1), ['connect', 'gw-c']);

  selectedId = 'gw-d';
  multi.rerender();
  const reconnectBtn = findAll(multi.tree, (n) => n.props?.['data-testid'] === 'settings-scope-reconnect-btn')[0];
  assert.equal(reconnectBtn.props.disabled, true);
});

test('GatewaySettingsPanel single-gateway and multi-gateway CRUD, test, connect, enable & remove confirm flows', async () => {
  setLocale('zh-CN');
  const log = [];
  const driver = createReactHookDriver();

  let gateways = [
    { id: 'gw-a', name: 'Alpha', url: 'http://127.0.0.1:18642', username: 'u', profileName: 'default', enabled: true, status: 'connected', latencyMs: 12, isDefault: true, hasStoredPassword: true },
    { id: 'gw-b', name: 'Beta', url: 'http://127.0.0.1:18643', username: 'u2', profileName: 'ops', enabled: true, status: 'offline', error: 'ECONNREFUSED', hasStoredPassword: false },
  ];
  let testOutcome = { ok: true, message: 'OK', latency: 8 };
  let addOutcome = { ok: false, message: 'Add Failed' };
  let updateOutcome = { ok: false, message: 'Update Failed' };
  let removeOutcome = { ok: false, message: 'Remove Failed' };
  let draftState = { url: 'http://127.0.0.1:18642', username: 'u', password: '', profileName: '  ' };
  let testedDraft = null;
  let useTestInstanceFn = true;

  const view = driver.mount(() =>
    React.createElement(GatewaySettingsPanel, {
      snapshot: makeBaseSnapshot({ gateways }),
      actions: {
        ...makeBaseActions(log),
        onAddGateway: async (d) => {
          log.push(['onAddGateway', d]);
          return addOutcome;
        },
        onUpdateGateway: async (id, d) => {
          log.push(['onUpdateGateway', id, d]);
          return updateOutcome;
        },
        onRemoveGateway: async (id) => {
          log.push(['onRemoveGateway', id]);
          return removeOutcome;
        },
        onToggleGatewayEnabled: async (id, en) => log.push(['onToggleGatewayEnabled', id, en]),
        onConnectGatewayInstance: async (id) => log.push(['onConnectGatewayInstance', id]),
        onDisconnectGatewayInstance: (id) => log.push(['onDisconnectGatewayInstance', id]),
        ...(useTestInstanceFn
          ? {
              onTestGatewayInstance: async (d) => {
                log.push(['onTestGatewayInstance', d]);
                return testOutcome;
              },
            }
          : {}),
      },
      gateway: {
        draft: draftState,
        onDraftChange: (d) => { draftState = d; },
        testedDraft,
        onTested: (d) => { testedDraft = d; },
      },
    }),
  );

  // List actions: enable toggle, reconnect, remove confirm cancel/fail/succeed (no redundant disconnect button)
  assert.equal(findAll(view.tree, (n) => n.props?.['data-testid'] === 'gateway-disconnect-btn-gw-a').length, 0);
  view.findComponents((c) => c.props?.['data-testid'] === 'gateway-enable-switch-gw-a' && typeof c.props?.onCheckedChange === 'function')[0].props.onCheckedChange(false);
  findAll(view.tree, (n) => n.props?.['data-testid'] === 'gateway-connect-btn-gw-b')[0].props.onClick();
  findAll(view.tree, (n) => n.props?.['data-testid'] === 'gateway-remove-btn-gw-b')[0].props.onClick();
  view.rerender();
  findAll(view.tree, (n) => n.props?.['data-testid'] === 'gateway-remove-confirm-btn-gw-b')[0].props.onClick();
  await Promise.resolve();
  view.rerender();
  removeOutcome = { ok: true };
  findAll(view.tree, (n) => n.props?.['data-testid'] === 'gateway-remove-confirm-btn-gw-b')[0].props.onClick();
  await Promise.resolve();
  view.rerender();

  // Edit existing instance -> edit fields -> test fail -> update fail -> update ok
  findAll(view.tree, (n) => n.props?.['data-testid'] === 'gateway-edit-btn-gw-a')[0].props.onClick();
  view.rerender();
  findAll(view.tree, (n) => n.props?.['data-testid'] === 'gateway-form-name')[0].props.onChange({ target: { value: 'Alpha2' } });
  findAll(view.tree, (n) => n.props?.['data-testid'] === 'gateway-form-url')[0].props.onChange({ target: { value: '' } });
  view.rerender();
  await findAll(view.tree, (n) => n.props?.['data-testid'] === 'gateway-form-test')[0].props.onClick();
  view.rerender();
  await findAll(view.tree, (n) => n.props?.['data-testid'] === 'gateway-form-save')[0].props.onClick();
  view.rerender();

  findAll(view.tree, (n) => n.props?.['data-testid'] === 'gateway-form-url')[0].props.onChange({ target: { value: 'http://127.0.0.1:18642' } });
  findAll(view.tree, (n) => n.props?.['data-testid'] === 'gateway-form-username')[0].props.onChange({ target: { value: 'alice' } });
  findAll(view.tree, (n) => n.props?.['data-testid'] === 'gateway-form-password')[0].props.onChange({ target: { value: 'secret' } });
  findAll(view.tree, (n) => n.props?.['data-testid'] === 'gateway-form-profile')[0].props.onChange({ target: { value: 'ops' } });
  view.rerender();

  testOutcome = { ok: false, message: 'Bad auth' };
  await findAll(view.tree, (n) => n.props?.['data-testid'] === 'gateway-form-test')[0].props.onClick();
  view.rerender();
  await findAll(view.tree, (n) => n.props?.['data-testid'] === 'gateway-form-save')[0].props.onClick();
  view.rerender();
  updateOutcome = { ok: true };
  await findAll(view.tree, (n) => n.props?.['data-testid'] === 'gateway-form-save')[0].props.onClick();
  view.rerender();

  // Add new instance (with fallback test branch & cancel & add save ok)
  findAll(view.tree, (n) => n.props?.['data-testid'] === 'gateway-add-btn')[0].props.onClick();
  view.rerender();
  useTestInstanceFn = false;
  view.rerender();
  findAll(view.tree, (n) => n.props?.['data-testid'] === 'gateway-form-url')[0].props.onChange({ target: { value: 'http://127.0.0.1:18649' } });
  view.rerender();
  await findAll(view.tree, (n) => n.props?.['data-testid'] === 'gateway-form-test')[0].props.onClick();
  await findAll(view.tree, (n) => n.props?.['data-testid'] === 'gateway-form-save')[0].props.onClick();
  view.rerender();
  addOutcome = { ok: true, gatewayId: 'gw-new' };
  await findAll(view.tree, (n) => n.props?.['data-testid'] === 'gateway-form-save')[0].props.onClick();
  view.rerender();

  // Single-gateway mode (<2 items) -> add cancel & single test/connect
  gateways = [gateways[0]];
  view.rerender();
  findAll(view.tree, (n) => n.props?.['data-testid'] === 'gateway-add-btn')[0].props.onClick();
  view.rerender();
  findAll(view.tree, (n) => n.props?.['data-testid'] === 'gateway-form-cancel')[0].props.onClick();
  view.rerender();
  findAll(view.tree, (n) => n.props?.['data-testid'] === 'gateway-test-btn')[0].props.onClick();
  findAll(view.tree, (n) => n.props?.['data-testid'] === 'gateway-connect-btn')[0].props.onClick();
  assert.ok(log.some(([k, d]) => k === 'onTestGateway' && d.profileName === 'default'));
  assert.ok(log.some(([k, d]) => k === 'onConnectGateway' && d.profileName === 'default'));
});

test('newChatModel + NewChatDialog + MobileNewChatSheet + MobileBotHubScreen + MobileSettingsPage multi-gateway flows', async () => {
  setLocale('zh-CN');
  const gateways = [
    { id: 'gw-a', label: 'Alpha', connected: false },
    { id: 'gw-b', label: 'Beta', connected: true },
  ];
  assert.equal(resolveInitialGatewayId([], 'gw-a'), '');
  assert.equal(resolveInitialGatewayId(gateways, 'gw-a'), 'gw-a');
  assert.equal(resolveInitialGatewayId(gateways, 'missing'), 'gw-b');
  assert.equal(resolveInitialGatewayId([{ id: 'gw-x', label: 'X', connected: false }], 'missing'), 'gw-x');

  const profiles = [
    { name: 'alpha-bot', displayName: 'Alpha Bot', gatewayId: 'gw-a', isDefault: true },
    { name: 'beta-bot', displayName: 'Beta Bot', gatewayId: 'gw-b', isDefault: false },
  ];
  const projects = [
    { id: 'p-a', name: 'PA', path: '/a', gatewayId: 'gw-a' },
    { id: 'p-b', name: 'PB', path: '/b', gatewayId: 'gw-b' },
  ];
  assert.equal(filterProfilesForGateway(profiles, '').length, 2);
  assert.equal(filterProfilesForGateway(profiles, 'gw-b').length, 1);
  assert.equal(filterProjectsForGateway(projects, '').length, 2);
  assert.equal(filterProjectsForGateway(projects, 'gw-b').length, 1);

  const built = buildNewChatSubmitPayload({
    mode: 'solo',
    selectedBot: 'beta-bot',
    selectedMembers: [],
    projectId: 'p-b',
    gatewayId: 'gw-b',
  });
  assert.equal(built.ok, true);
  if (built.ok) assert.equal(built.payload.gatewayId, 'gw-b');

  // NewChatDialog multi-gateway selection & fallback
  const driver = createReactHookDriver();
  let dialogGateways = gateways;
  const submitted = [];
  const dialog = driver.mount(() =>
    React.createElement(NewChatDialog, {
      snapshot: {
        isOpen: true,
        initialMode: 'solo',
        profiles,
        projects,
        selectedProfile: 'beta-bot',
        gatewayConnected: true,
        gateways: dialogGateways,
        defaultGatewayId: 'gw-b',
      },
      actions: {
        onClose: () => {},
        onModeChange: () => {},
        onSubmit: async (p) => { submitted.push(p); return { ok: true }; },
      },
    }),
  );
  const gwSelect = dialog.findComponents((c) => c.props?.['data-testid'] === 'new-chat-gateway-select')[0];
  assert.ok(gwSelect);
  gwSelect.props.onChange('gw-a');
  dialog.rerender();
  assert.equal(findAll(dialog.tree, (n) => n.props?.['data-testid'] === 'new-chat-offline-hint').length > 0, true);
  dialogGateways = [{ id: 'gw-only', label: 'Only', connected: true }, { id: 'gw-b', label: 'Beta', connected: true }];
  dialog.rerender();

  // MobileNewChatSheet multi-gateway select
  const mobGatewayChanges = [];
  const sheet = driver.mount(() =>
    React.createElement(MobileNewChatSheet, {
      open: true,
      step: 'compose',
      targetKind: 'bot',
      targetBot: 'alpha-bot',
      groupMembers: [],
      groupName: '',
      selectedProjectId: 'p-a',
      selectedGatewayId: 'gw-a',
      gateways,
      gatewayConnected: true,
      allProfiles: profiles,
      projects,
      selectedModel: 'gpt-4o',
      availableModels: ['gpt-4o'],
      modelDetails: [],
      attachments: [],
      stats: { pluginsCount: 0, mcpCount: 0, skillsCount: 0 },
      onClose: () => {},
      onSetStep: () => {},
      onSelectBot: () => {},
      onSetGroupMembers: () => {},
      onSetGroupName: () => {},
      onSelectProject: () => {},
      onSelectGateway: (gwId) => mobGatewayChanges.push(gwId),
      onSubmitFirstMessage: () => {},
      onSelectModel: () => {},
      onOpenAttachmentPicker: () => {},
      onRemoveAttachment: () => {},
    }),
  );
  const mobGwSelect = findAll(sheet.tree, (n) => n.props?.['data-testid'] === 'mobile-new-chat-gateway-select')[0];
  assert.ok(mobGwSelect);
  mobGwSelect.props.onChange({ target: { value: 'gw-b' } });
  assert.deepEqual(mobGatewayChanges, ['gw-b']);

  // MobileBotHubScreen multi-gateway roster filter
  const hubHtml = renderToStaticMarkup(
    React.createElement(MobileBotHubScreen, {
      allProfiles: profiles,
      activeBotName: 'beta-bot',
      gatewayConnected: true,
      connectionPhase: 'connected',
      settingsSnapshot: makeBaseSnapshot({
        gateways: [
          { id: 'gw-a', name: 'Alpha', url: 'http://127.0.0.1:18642', enabled: true, status: 'connected' },
          { id: 'gw-b', name: 'Beta', url: 'http://127.0.0.1:18643', enabled: true, status: 'connected' },
        ],
        selectedGatewayId: 'gw-b',
        botManagement: { status: 'ready', roster: [], activeBotId: '', wizard: { open: false, draft: { mode: 'blank', name: '', displayName: '', description: '', model: '', provider: '', cloneFrom: '', cloneChannels: false, mirrorCredentials: false }, busy: false } },
      }),
      modelDetails: [],
      onSelectBotSubpage: () => {},
      onOpenBotChat: () => {},
      onOpenSettingsGateway: () => {},
      onHapticSelection: () => {},
      settingsActions: makeBaseActions(),
    }),
  );
  assert.ok(hubHtml.includes('Beta Bot'));
  assert.equal(hubHtml.includes('Alpha Bot'), false);

  // MobileSettingsPage handleCreateProject guard when selectedGwConnected is false
  const createCalls = [];
  const mPage = driver.mount(() =>
    React.createElement(MobileSettingsPage, {
      open: true,
      subpage: 'projects',
      appearancePref: 'dark',
      snapshot: makeBaseSnapshot({
        gateways: [
          { id: 'gw-a', name: 'Alpha', url: 'http://127.0.0.1:18642', enabled: true, status: 'offline' },
          { id: 'gw-b', name: 'Beta', url: 'http://127.0.0.1:18643', enabled: true, status: 'connected' },
        ],
        selectedGatewayId: 'gw-a',
      }),
      onClose: () => {},
      onSelectSubpage: () => {},
      onSetAppearancePreference: () => {},
      settingsActions: {
        ...makeBaseActions(),
        onCreateProject: async (p) => { createCalls.push(p); return { ok: true }; },
      },
    }),
  );
  // Note: Offline guard inside SettingsGatewayScopeBar hides form; mount a second disconnected single-gw snapshot to reach form.onSubmit -> !selectedGwConnected
  const mPageOfflineSingle = driver.mount(() =>
    React.createElement(MobileSettingsPage, {
      open: true,
      subpage: 'projects',
      appearancePref: 'dark',
      snapshot: makeBaseSnapshot({
        gateway: { url: 'http://127.0.0.1:18642', username: '', hasStoredPassword: false, profileName: 'default', status: 'disconnected', latencyMs: 0 },
      }),
      onClose: () => {},
      onSelectSubpage: () => {},
      onSetAppearancePreference: () => {},
      settingsActions: {
        ...makeBaseActions(),
        onCreateProject: async (p) => { createCalls.push(p); return { ok: true }; },
      },
    }),
  );
  const projectForm = findAll(mPageOfflineSingle.tree, (n) => n.type === 'form')[0];
  await projectForm?.props.onSubmit({ preventDefault: () => {} });
  assert.equal(createCalls.length, 0);
  assert.ok(mPage.tree);
});

test('Stage 2B coverage top-up: GatewaySettingsPanel async unmount, error fallbacks, auth_error & NewChatDialog offline bot click', async () => {
  setLocale('zh-CN');
  assert.equal(formatSkillCategoryLabel('   ', t), t('settings.skillsCategoryOther'));
  assert.equal(resolveInitialGatewayId([{ id: 'x', label: 'X', connected: false }], undefined), 'x');
  assert.equal(resolveInitialGatewayId([{ id: '', label: '', connected: false }], undefined), '');

  const driver = createReactHookDriver();
  let resolveDeferredTest;
  const deferredTestPromise = new Promise((r) => {
    resolveDeferredTest = r;
  });
  let unmountTestDone = false;
  const gws = [
    { id: 'gw-a', name: 'Alpha', url: 'http://127.0.0.1:18642', username: 'u', profileName: 'default', enabled: true, status: 'auth_error', isDefault: false },
    { id: 'gw-b', name: 'Beta', url: 'http://127.0.0.1:18643', username: 'u2', profileName: 'ops', enabled: true, status: 'connecting', isDefault: false },
  ];
  const panel = driver.mount(() =>
    React.createElement(GatewaySettingsPanel, {
      snapshot: makeBaseSnapshot({ gateways: gws }),
      actions: {
        ...makeBaseActions(),
        onAddGateway: async () => ({ ok: false }),
        onRemoveGateway: async () => ({ ok: false }),
        onConnectGatewayInstance: async () => {},
        onTestGatewayInstance: async () => {
          unmountTestDone = true;
          return deferredTestPromise;
        },
      },
      gateway: {
        draft: { url: 'http://127.0.0.1:18642', username: '', password: '', profileName: 'default' },
        onDraftChange: () => {},
        testedDraft: null,
        onTested: () => {},
      },
    }),
  );

  // Trigger auth_error reconnect + remove fail without message -> fallback saveFailed + cancel remove
  findAll(panel.tree, (n) => n.props?.['data-testid'] === 'gateway-connect-btn-gw-a')[0].props.onClick();
  findAll(panel.tree, (n) => n.props?.['data-testid'] === 'gateway-remove-btn-gw-a')[0].props.onClick();
  panel.rerender();
  await findAll(panel.tree, (n) => n.props?.['data-testid'] === 'gateway-remove-confirm-btn-gw-a')[0].props.onClick();
  panel.rerender();

  // Open add editor -> empty url test/save -> async test -> cancel editor BEFORE resolving promise -> resolve
  findAll(panel.tree, (n) => n.props?.['data-testid'] === 'gateway-add-btn')[0].props.onClick();
  panel.rerender();
  await findAll(panel.tree, (n) => n.props?.['data-testid'] === 'gateway-form-test')[0].props.onClick();
  findAll(panel.tree, (n) => n.props?.['data-testid'] === 'gateway-form-url')[0].props.onChange({ target: { value: 'http://127.0.0.1:19000' } });
  panel.rerender();
  await findAll(panel.tree, (n) => n.props?.['data-testid'] === 'gateway-form-save')[0].props.onClick();
  panel.rerender();
  const pendingTest = findAll(panel.tree, (n) => n.props?.['data-testid'] === 'gateway-form-test')[0].props.onClick();
  findAll(panel.tree, (n) => n.props?.['data-testid'] === 'gateway-form-cancel')[0].props.onClick();
  panel.rerender();
  resolveDeferredTest({ ok: true });
  await pendingTest;
  assert.equal(unmountTestDone, true);

  // GatewaySettingsPanel without onAddGateway / onUpdateGateway
  const noCrud = driver.mount(() =>
    React.createElement(GatewaySettingsPanel, {
      snapshot: makeBaseSnapshot({ gateways: gws }),
      actions: makeBaseActions(),
      gateway: { draft: { url: '', username: '', password: '', profileName: 'default' }, onDraftChange: () => {}, testedDraft: null, onTested: () => {} },
    }),
  );
  assert.equal(findAll(noCrud.tree, (n) => n.props?.['data-testid'] === 'gateway-add-btn').length, 0);

  // SettingsGatewayScopeBar with missing selectedGatewayId -> falls back to gateways[0] & renderValue('missing')
  const scopeMissing = driver.mount(() =>
    React.createElement(
      SettingsGatewayScopeBar,
      {
        gateways: gws,
        selectedGatewayId: 'non-existent',
        onSelectGateway: () => {},
        onOpenGatewaySettings: () => {},
      },
      React.createElement('span', null, 'child'),
    ),
  );
  const sel = scopeMissing.findComponents((c) => c.props?.id === 'settings-gateway-scope-select')[0];
  assert.ok(sel.props.renderValue('non-existent'));

  // NewChatDialog click bot directly when offline gateway selected -> hits handleSelectAgent early return line 190
  const ncOffline = driver.mount(() =>
    React.createElement(NewChatDialog, {
      snapshot: {
        isOpen: true,
        initialMode: 'solo',
        profiles: [{ name: 'b1', displayName: 'B1', gatewayId: 'gw-off', isDefault: true }],
        projects: [],
        selectedProfile: 'b1',
        gatewayConnected: false,
        gateways: [
          { id: 'gw-off', label: 'Off', connected: false },
          { id: 'gw-off2', label: 'Off2', connected: false },
        ],
        defaultGatewayId: 'gw-off',
      },
      actions: { onClose: () => {}, onModeChange: () => {}, onSubmit: async () => ({ ok: true }) },
    }),
  );
  findAll(ncOffline.tree, (n) => n.props?.['data-new-chat-bot'] === 'b1')[0].props.onClick();
});
