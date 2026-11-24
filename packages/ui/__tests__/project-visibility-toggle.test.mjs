/**
 * 设置 → 项目「是否显示项目」开关及左轨/移动端过滤语义单测
 * (packages/ui/__tests__/project-visibility-toggle.test.mjs)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {
  setLocale,
  t,
  DEFAULT_CONVERSATION_ORG_PREFS,
  resolveConversationOrgPrefs,
  loadConversationOrgPrefs,
  saveConversationOrgPrefs,
  isProjectHidden,
  setProjectVisibility,
  buildLeftRailModel,
  buildGroupedLeftRailModel,
  buildMobileHomeModel,
} from '../dist/index.js';
import { partitionRailOrgEntities } from '../dist/components-react/railOrgPartition.js';
import { ProjectsPanel } from '../dist/components-react/settings/SettingsModal.js';
import { MobileSettingsPage } from '../dist/components-react/mobile/MobileSettingsPage.js';

function createMemoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
  };
}

function findAll(node, predicate, acc = []) {
  if (!node || typeof node !== 'object') return acc;
  if (Array.isArray(node)) {
    for (const item of node) findAll(item, predicate, acc);
    return acc;
  }
  if (predicate(node)) acc.push(node);
  if (node.props && 'children' in node.props) {
    findAll(node.props.children, predicate, acc);
  }
  return acc;
}

function createReactHookDriver() {
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
      let slot = slots.get(key);
      if (!slot) {
        slot = { states: [], refs: [], memos: [], effects: [] };
        slots.set(key, slot);
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
          return `id-${key}`;
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
      return resolve(rendered, `${key}>${compFn.name || 'Fn'}`);
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
      const rerender = () => {
        pendingEffects = [];
        tree = resolve(renderFn(), 'root');
        const currentEffects = pendingEffects;
        pendingEffects = [];
        for (const effect of currentEffects) effect();
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

test('conversationOrgPrefs: hiddenProjectIds 默认值、归一化去重、持久化与可见性切换纯函数', () => {
  assert.deepEqual(DEFAULT_CONVERSATION_ORG_PREFS.hiddenProjectIds, []);
  const norm = resolveConversationOrgPrefs({
    showDoneSection: false,
    hiddenProjectIds: [' p-1 ', '', 123, 'p-1', 'p-2'],
  });
  assert.deepEqual(norm, {
    showDoneSection: false,
    autoReopenOnSend: true,
    hiddenProjectIds: ['p-1', 'p-2'],
  });

  const store = createMemoryStorage();
  saveConversationOrgPrefs(norm, store);
  assert.deepEqual(loadConversationOrgPrefs(store).hiddenProjectIds, ['p-1', 'p-2']);

  assert.equal(isProjectHidden(norm, 'p-1'), true);
  assert.equal(isProjectHidden(norm, 'p-3'), false);

  const afterHideP3 = setProjectVisibility(norm, 'p-3', false);
  assert.deepEqual(afterHideP3.hiddenProjectIds, ['p-1', 'p-2', 'p-3']);
  assert.deepEqual(norm.hiddenProjectIds, ['p-1', 'p-2'], '纯函数不可原地篡改旧偏好');

  const afterShowP1 = setProjectVisibility(afterHideP3, 'p-1', true);
  assert.deepEqual(afterShowP1.hiddenProjectIds, ['p-2', 'p-3']);
});

test('partitionRailOrgEntities / LeftRail / Grouped / Mobile: 隐藏项目仅隐藏该项目文件夹与内部会话，项目外关联会话正常显示', () => {
  setLocale('zh-CN');
  const profiles = [{ name: 'default', displayName: '默认中枢', isDefault: true }];
  const projects = [
    { id: 'p-1', name: 'FluxCore', path: '/work/flux-core', archived: false },
    { id: 'p-2', name: 'OtherRepo', path: '/work/other', archived: false },
  ];
  const folders = [{ id: 'fld-1', name: '待办', order: 0 }];
  const groups = [
    { roomId: 'r-in-p1', name: 'P1 群聊', members: ['default'], updatedAt: 400 },
    { roomId: 'r-free', name: '自由群聊', members: ['default'], updatedAt: 350 },
  ];
  const sessions = [
    { id: 's-cwd-p1', title: 'P1 CWD 内会话', botName: 'default', cwd: '/work/flux-core/sub', projectId: 'p-1', timestamp: 500 },
    { id: 's-explicit-p1', title: 'P1 显式归属会话', botName: 'default', timestamp: 480 },
    { id: 's-detached-p1', title: 'P1 关联但在外', botName: 'default', cwd: '/work/flux-core/sub', projectId: 'p-1', timestamp: 460 },
    { id: 's-custom-folder', title: 'P1 关联但在自建目录', botName: 'default', cwd: '/work/flux-core', projectId: 'p-1', timestamp: 440 },
    { id: 's-in-p2', title: 'P2 内会话', botName: 'default', cwd: '/work/other', projectId: 'p-2', timestamp: 420 },
    { id: 's-done-p1', title: 'P1 已完成会话', botName: 'default', cwd: '/work/flux-core', projectId: 'p-1', isArchived: true, timestamp: 300 },
  ];
  const assignments = {
    'room:r-in-p1': 'prj:p-1',
    'session:default:s-explicit-p1': 'prj:p-1',
    'session:default:s-detached-p1': '__none__',
    'session:default:s-custom-folder': 'fld-1',
  };

  // 1. 隐藏前：两个项目文件夹都存在
  const visiblePartition = partitionRailOrgEntities({
    sessions,
    groups,
    projects,
    folders,
    assignments,
    hiddenProjectIds: [],
    searchQuery: '',
    matchesSessionSearch: () => true,
    matchesGroupSearch: () => true,
    mapSession: (s, meta) => ({ kind: 'session', id: s.id, sortTimestamp: s.timestamp || 0, isPinnedSort: false, meta }),
    mapGroup: (g, meta) => ({ kind: 'group', id: g.roomId, sortTimestamp: g.updatedAt || 0, isPinnedSort: false, meta }),
  });
  assert.deepEqual(visiblePartition.projectContainers.map((c) => c.id), ['p-1', 'p-2']);
  assert.deepEqual(
    visiblePartition.projectContainers[0].items.map((i) => i.id),
    ['s-cwd-p1', 's-explicit-p1', 'r-in-p1'],
  );

  // 2. 隐藏 p-1 后：p-1 文件夹及其内的 s-cwd-p1 / s-explicit-p1 / r-in-p1 隐藏；项目外关联会话仍正常显示
  const dualHidden = buildLeftRailModel({
    activeSessionId: '',
    sessions,
    profileName: 'default',
    profiles,
    groups,
    projects,
    folders,
    assignments,
    hiddenProjectIds: ['p-1'],
    searchQuery: '',
  });
  assert.deepEqual(dualHidden.projectContainers.map((c) => c.id), ['p-2']);
  assert.deepEqual(dualHidden.projectContainers[0].items.map((i) => i.kind === 'session' ? i.session.id : i.group.roomId), ['s-in-p2']);
  assert.deepEqual(dualHidden.unassignedSessions.map((s) => s.id), ['s-detached-p1']);
  assert.deepEqual(dualHidden.unassignedGroups.map((g) => g.roomId), ['r-free']);
  assert.deepEqual(dualHidden.folderContainers[0].items.map((i) => i.kind === 'session' ? i.session.id : i.group.roomId), ['s-custom-folder']);
  assert.deepEqual(dualHidden.doneItems.map((i) => i.kind === 'session' ? i.session.id : i.group.roomId), ['s-done-p1']);

  // 3. 搜索状态下同样遵循：p-1 文件夹与其内部会话不漏出，外部会话命中保留
  const dualSearch = buildLeftRailModel({
    activeSessionId: '',
    sessions,
    profileName: 'default',
    profiles,
    groups,
    projects,
    folders,
    assignments,
    hiddenProjectIds: ['p-1'],
    searchQuery: 'P1',
  });
  assert.deepEqual(dualSearch.projectContainers, []);
  assert.deepEqual(dualSearch.unassignedSessions.map((s) => s.id), ['s-detached-p1']);
  assert.deepEqual(dualSearch.folderContainers[0].items.map((i) => i.kind === 'session' ? i.session.id : i.group.roomId), ['s-custom-folder']);

  // 4. 分组左轨 & 移动端模型一致
  const groupedHidden = buildGroupedLeftRailModel({
    activeSessionId: '',
    sessions,
    profileName: 'default',
    profiles,
    groups,
    projects,
    folders,
    assignments,
    hiddenProjectIds: ['p-1'],
    searchQuery: '',
  });
  assert.deepEqual(groupedHidden.projectSections.map((s) => s.id), ['p-2']);
  assert.deepEqual(groupedHidden.sessionsSection.items.map((s) => s.id), ['s-detached-p1']);

  const mobileHidden = buildMobileHomeModel({
    activeSessionId: '',
    profiles,
    groups,
    sessions,
    projects,
    folders,
    assignments,
    hiddenProjectIds: ['p-1'],
    profileName: 'default',
    searchQuery: '',
    collapsed: { bots: false, groups: false, sessions: false },
  });
  assert.deepEqual(mobileHidden.projectSections.map((s) => s.id), ['p-2']);
  assert.deepEqual(mobileHidden.sessionsSection.items.map((s) => s.id), ['s-detached-p1']);
  assert.deepEqual(mobileHidden.folderSections[0].items.map((i) => i.id), ['s-custom-folder']);
});

test('Desktop ProjectsPanel 与 MobileSettingsPage 渲染每个项目的显隐开关并触发偏好更新', () => {
  setLocale('zh-CN');
  const orgPatchesDesktop = [];
  const orgPatchesMobile = [];
  const snapshot = {
    isOpen: true,
    section: 'projects',
    theme: 'obsidian-gold',
    locale: 'zh',
    fontPrefs: { uiFont: 'geist-sans', monoFont: 'jetbrains-mono', sizeScale: 'medium' },
    activityVariant: 'cloud',
    conversationWidth: 'wide',
    leftRailLayout: 'dual-rail',
    orgPrefs: { showDoneSection: true, autoReopenOnSend: true, hiddenProjectIds: ['p-2'] },
    projects: {
      status: 'ready',
      data: [
        { id: 'p-1', name: 'Alpha', path: '/work/alpha', archived: false },
        { id: 'p-2', name: 'Beta', path: '/work/beta', archived: false },
      ],
    },
    profiles: { status: 'ready', data: [] },
    mcp: { status: 'ready', data: [] },
    skills: { status: 'ready', data: [] },
    bots: [],
    scopedProfile: 'default',
    providerViews: { status: 'ready', data: [] },
    providerFailures: [],
    subscriptionCatalog: { status: 'ready', data: [] },
    customEndpoints: { status: 'ready', data: [] },
    endpointProfiles: {},
    endpointFailures: [],
    providerAdminBusy: false,
    gateway: { url: '', username: '', hasStoredPassword: false, profileName: 'default', status: 'connected', latencyMs: 1 },
    platform: 'desktop',
    busy: false,
    presenceLayout: 'stage',
  };

  const hadHtmlForm = 'HTMLFormElement' in globalThis;
  const prevHtmlForm = globalThis.HTMLFormElement;
  if (!hadHtmlForm) {
    globalThis.HTMLFormElement = class MockHTMLFormElement {};
  }

  try {
    const driver = createReactHookDriver();
    const desktopView = driver.mount(() =>
      React.createElement(ProjectsPanel, {
        snapshot,
        actions: {
          onConversationOrgPrefsChange: (patch) => orgPatchesDesktop.push(patch),
          onUpdateProject: async () => ({ ok: true }),
          onDeleteProject: async () => ({ ok: true }),
        },
      }),
    );
    const swP1 = findAll(desktopView.tree, (n) => n.props?.['data-settings-project-visible'] === 'p-1')[0];
    const swP2 = findAll(desktopView.tree, (n) => n.props?.['data-settings-project-visible'] === 'p-2')[0];
    assert.equal(swP1.props['aria-checked'], true);
    assert.equal(swP1.props['data-state'], 'checked');
    assert.equal(swP2.props['aria-checked'], false);
    assert.equal(swP2.props['data-state'], 'unchecked');
    assert.equal(swP1.props['aria-label'], t('settings.projectsShowInRailLabel', { name: 'Alpha' }));

    const syntheticEvent = { isPropagationStopped: () => false, stopPropagation: () => {} };
    swP1.props.onClick(syntheticEvent);
    swP2.props.onClick(syntheticEvent);
    assert.deepEqual(orgPatchesDesktop, [
      { hiddenProjectIds: ['p-2', 'p-1'] },
      { hiddenProjectIds: [] },
    ]);
    desktopView.unmount();

    const mobileDriver = createReactHookDriver();
    const mobileView = mobileDriver.mount(() =>
      React.createElement(MobileSettingsPage, {
        open: true,
        subpage: 'projects',
        appearancePref: 'dark',
        snapshot: { ...snapshot, platform: 'web' },
        onClose: () => {},
        onSelectSubpage: () => {},
        onSetAppearancePreference: () => {},
        onSetConversationOrgPrefs: (patch) => orgPatchesMobile.push(patch),
        settingsActions: {
          onUpdateProject: async () => ({ ok: true }),
          onDeleteProject: async () => ({ ok: true }),
        },
      }),
    );
    const mSwP1 = findAll(mobileView.tree, (n) => n.props?.['data-mobile-project-visible'] === 'p-1')[0];
    const mSwP2 = findAll(mobileView.tree, (n) => n.props?.['data-mobile-project-visible'] === 'p-2')[0];
    assert.equal(mSwP1.props['aria-checked'], true);
    assert.equal(mSwP1.props['data-state'], 'checked');
    assert.equal(mSwP2.props['aria-checked'], false);
    assert.equal(mSwP2.props['data-state'], 'unchecked');

    mSwP1.props.onClick();
    mSwP2.props.onClick();
    assert.deepEqual(orgPatchesMobile, [
      { hiddenProjectIds: ['p-2', 'p-1'] },
      { hiddenProjectIds: [] },
    ]);
    mobileView.unmount();
  } finally {
    if (hadHtmlForm) {
      globalThis.HTMLFormElement = prevHtmlForm;
    } else {
      delete globalThis.HTMLFormElement;
    }
  }
});
