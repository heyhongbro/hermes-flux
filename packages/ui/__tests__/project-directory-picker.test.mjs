/**
 * 桌面与移动端共享 ProjectDirectoryPicker 组件及 Projects 面板端到端组件单测
 * (packages/ui/__tests__/project-directory-picker.test.mjs)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { setLocale, t } from '../dist/i18n/index.js';
import { ProjectDirectoryPicker } from '../dist/components-react/settings/ProjectDirectoryPicker.js';
import { ProjectsPanel, SettingsModal } from '../dist/components-react/settings/SettingsModal.js';
import { MobileSettingsPage } from '../dist/components-react/mobile/MobileSettingsPage.js';

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

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test('ProjectDirectoryPicker: 自动加载目录树、展开 defaultCwd、筛选、点选、新建文件夹与重命名前缀同步', async () => {
  setLocale('zh-CN');

  const fsTree = {
    '/opt/data': [
      { name: 'workspace', path: '/opt/data/workspace' },
      { name: 'archive', path: '/opt/data/archive' },
    ],
    '/opt/data/workspace': [
      { name: 'flux-app', path: '/opt/data/workspace/flux-app' },
      { name: 'docs', path: '/opt/data/workspace/docs' },
    ],
    '/opt/data/workspace/flux-app': [
      { name: 'packages', path: '/opt/data/workspace/flux-app/packages' },
    ],
  };

  let currentSelectedPath = '';
  const selectedEvents = [];
  const renamedEvents = [];
  const driver = createReactHookDriver();

  const view = driver.mount(() =>
    React.createElement(ProjectDirectoryPicker, {
      value: currentSelectedPath,
      isConnected: true,
      variant: 'desktop',
      onBrowse: async (dirPath) => {
        const target = dirPath || '/opt/data';
        return {
          ok: true,
          currentPath: target,
          rootPath: '/opt/data',
          parentPath: target === '/opt/data' ? null : '/opt/data',
          lockedRoot: '/opt/data',
          defaultCwd: '/opt/data/workspace',
          entries: fsTree[target] || [],
          source: 'gateway_api',
          canCreate: true,
          canRename: true,
        };
      },
      onCreateDirectory: async (parentPath, folderName) => {
        if ((fsTree[parentPath] || []).some((e) => e.name === folderName)) {
          return { ok: false, error: 'TARGET_EXISTS' };
        }
        const createdPath = `${parentPath}/${folderName}`;
        fsTree[parentPath] = [...(fsTree[parentPath] || []), { name: folderName, path: createdPath }];
        fsTree[createdPath] = [];
        return { ok: true, path: createdPath };
      },
      onRenameDirectory: async (dirPath, newName) => {
        const parent = dirPath.slice(0, dirPath.lastIndexOf('/'));
        const nextPath = `${parent}/${newName}`;
        fsTree[parent] = (fsTree[parent] || []).map((e) =>
          e.path === dirPath ? { name: newName, path: nextPath } : e,
        );
        fsTree[nextPath] = fsTree[dirPath] || [];
        delete fsTree[dirPath];
        return { ok: true, path: nextPath };
      },
      onSelectPath: (p, name) => {
        currentSelectedPath = p;
        selectedEvents.push([p, name]);
      },
      onPathRenamed: (oldP, newP) => {
        if (currentSelectedPath === oldP) currentSelectedPath = newP;
        renamedEvents.push([oldP, newP]);
      },
    }),
  );

  // useEffect 异步加载根目录并展开 defaultCwd
  await flush();
  view.rerender();
  await flush();
  view.rerender();

  assert.ok(findAll(view.tree, (n) => n.props?.['data-dir-select'] === '/opt/data/workspace/flux-app').length === 1);

  // 1. 展开 /opt/data/workspace/flux-app 懒加载子目录 packages
  const expandBtn = findAll(view.tree, (n) => n.props?.['data-dir-expand'] === '/opt/data/workspace/flux-app')[0];
  await expandBtn.props.onClick();
  await flush();
  view.rerender();
  assert.ok(findAll(view.tree, (n) => n.props?.['data-dir-select'] === '/opt/data/workspace/flux-app/packages').length === 1);

  // 2. 点击选中文件夹
  findAll(view.tree, (n) => n.props?.['data-dir-select'] === '/opt/data/workspace/flux-app')[0].props.onClick();
  view.rerender();
  assert.deepEqual(selectedEvents.at(-1), ['/opt/data/workspace/flux-app', 'flux-app']);

  // 3. 在选中的文件夹下新建子文件夹并自动选中
  findAll(view.tree, (n) => n.props?.['data-dir-create'] === '/opt/data/workspace/flux-app')[0].props.onClick();
  view.rerender();
  const createInput = findAll(view.tree, (n) => n.props?.['data-testid'] === 'dir-picker-create-input')[0];
  createInput.props.onChange({ currentTarget: { value: 'core-module' } });
  view.rerender();
  await findAll(view.tree, (n) => n.props?.['data-testid'] === 'dir-picker-create-confirm')[0].props.onClick();
  await flush();
  view.rerender();
  assert.equal(currentSelectedPath, '/opt/data/workspace/flux-app/core-module');
  assert.ok(findAll(view.tree, (n) => n.props?.['data-dir-select'] === '/opt/data/workspace/flux-app/core-module').length === 1);

  // 4. 非法文件夹名（.env / a/b）直接在 role="alert" 显示错误文案
  findAll(view.tree, (n) => n.props?.['data-testid'] === 'dir-picker-new-root-folder')[0].props.onClick();
  view.rerender();
  findAll(view.tree, (n) => n.props?.['data-testid'] === 'dir-picker-create-input')[0].props.onChange({
    currentTarget: { value: '.env.secret' },
  });
  view.rerender();
  await findAll(view.tree, (n) => n.props?.['data-testid'] === 'dir-picker-create-confirm')[0].props.onClick();
  view.rerender();
  const errEl = findAll(view.tree, (n) => n.props?.['data-testid'] === 'dir-picker-error')[0];
  assert.ok(errEl, '非法目录名必须渲染显式 error alert');

  // 5. 重命名子目录并同步更新 selected cwd
  findAll(view.tree, (n) => n.props?.['data-dir-rename'] === '/opt/data/workspace/flux-app/core-module')[0].props.onClick();
  view.rerender();
  findAll(view.tree, (n) => n.props?.['data-testid'] === 'dir-picker-rename-input')[0].props.onChange({
    currentTarget: { value: 'core-renamed' },
  });
  view.rerender();
  await findAll(view.tree, (n) => n.props?.['data-testid'] === 'dir-picker-rename-confirm')[0].props.onClick();
  await flush();
  view.rerender();
  assert.deepEqual(renamedEvents, [
    ['/opt/data/workspace/flux-app/core-module', '/opt/data/workspace/flux-app/core-renamed'],
  ]);
  assert.equal(currentSelectedPath, '/opt/data/workspace/flux-app/core-renamed');

  // 6. Filter 查询精确收窄结果
  findAll(view.tree, (n) => n.props?.['data-testid'] === 'dir-picker-filter')[0].props.onChange({
    currentTarget: { value: 'core-renamed' },
  });
  view.rerender();
  assert.equal(findAll(view.tree, (n) => n.props?.['data-dir-select'] === '/opt/data/archive').length, 0);
  assert.equal(findAll(view.tree, (n) => n.props?.['data-dir-select'] === '/opt/data/workspace/flux-app/core-renamed').length, 1);

  view.unmount();
});

test('ProjectDirectoryPicker 移动端变体热区 >=44px 且无 xs 按钮；Desktop/Mobile Projects 支持目录选填、重命名与删除二次确认文案', async () => {
  setLocale('zh-CN');

  const mobileHtml = renderToStaticMarkup(
    React.createElement(ProjectDirectoryPicker, {
      value: '',
      variant: 'mobile',
      isConnected: true,
      onBrowse: async () => ({
        ok: true,
        currentPath: '/opt/data',
        rootPath: '/opt/data',
        parentPath: null,
        lockedRoot: '/opt/data',
        defaultCwd: null,
        entries: [{ name: 'repo-one', path: '/opt/data/repo-one' }],
        source: 'gateway_api',
        canCreate: true,
        canRename: true,
      }),
      onSelectPath: () => {},
    }),
  );
  assert.ok(mobileHtml.includes('data-variant="mobile"'));
  assert.ok(mobileHtml.includes('data-flux-island'));
  assert.ok(mobileHtml.includes('m-dir-picker--mobile'));
  assert.equal(mobileHtml.includes('min-h-11'), false, 'mobile variant 应通过 CSS .m-dir-picker--mobile 统一约束热区，不得在 Button/Input 上写 min-h-11 高度覆盖');
  assert.equal(mobileHtml.includes('h-7'), false, 'mobile variant 不得降级渲染桌面 h-7(xs) 尺寸');

  // Desktop SettingsModal Projects: 徽章、重命名与删除二次确认文案
  const updateCalls = [];
  const driverDesktop = createReactHookDriver();
  const baseSnap = {
    isOpen: true,
    section: 'projects',
    theme: 'obsidian-gold',
    locale: 'zh',
    fontPrefs: { uiFont: 'geist-sans', monoFont: 'jetbrains-mono', sizeScale: 'medium' },
    activityVariant: 'cloud',
    conversationWidth: 'wide',
    leftRailLayout: 'dual-rail',
    projects: {
      status: 'ready',
      data: [
        {
          id: 'p-1',
          name: 'FluxRepo',
          path: '/opt/data/flux',
          boardSlug: 'flux-kanban',
          additionalFolders: ['/opt/data/docs'],
          archived: false,
        },
      ],
    },
    profiles: { status: 'idle' },
    mcp: { status: 'idle' },
    skills: { status: 'idle' },
    bots: [],
    botManagement: {
      status: { status: 'idle', activeBotId: 'default' },
      roster: [],
      activeBotId: 'default',
      availableModels: [],
      wizard: {
        open: false,
        draft: { mode: 'blank', name: '', displayName: '', description: '', model: '', provider: '', cloneFrom: '', cloneChannels: false, mirrorCredentials: false },
        busy: false,
      },
      exitPrompt: null,
      isBusy: false,
    },
    scopedProfile: 'default',
    providerViews: { status: 'idle' },
    providerFailures: [],
    subscriptionCatalog: { status: 'idle' },
    customEndpoints: { status: 'idle' },
    endpointProfiles: {},
    endpointFailures: [],
    providerAdminBusy: false,
    gateway: { url: 'http://127.0.0.1:9119', username: '', hasStoredPassword: false, profileName: 'default', status: 'connected', latencyMs: 12 },
    platform: 'windows',
    busy: false,
    presenceLayout: 'stage',
  };

  const baseActions = {
    onClose() {},
    onSelectSection() {},
    onThemeChange() {},
    onLocaleChange() {},
    onFontPrefsChange() {},
    onActivityVariantChange() {},
    onConversationWidthChange() {},
    onLeftRailLayoutChange() {},
    onPresenceLayoutChange() {},
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
    onScopeProfileChange() {},
    onReloadProviders() {},
    onProbeEndpoint: async () => ({ ok: true }),
    onSaveEndpoint: async () => ({ ok: true }),
    onDeleteEndpoint: async () => ({ ok: true }),
    onSwitchDefaultAndDisableProvider: async () => ({ ok: true }),
    onToggleProviderAgent: async () => ({ ok: true }),
    onActivateProvider: async () => ({ ok: true }),
    onStartLogin: async () => ({ ok: false }),
    onPollLogin: async () => ({ status: 'cancelled' }),
    onCancelLogin: async () => {},
    onLogoutProvider: async () => ({ ok: true }),
    onNotify() {},
    onCopy: async () => true,
    onCreateProject: async () => ({ ok: true }),
    onUpdateProject: async (id, patch) => {
      updateCalls.push([id, patch]);
      return { ok: true };
    },
    onDeleteProject: async () => ({ ok: true }),
    onBrowseProjectDirectory: async () => ({
      ok: true,
      currentPath: '/opt/data',
      rootPath: '/opt/data',
      parentPath: null,
      lockedRoot: '/opt/data',
      defaultCwd: '/opt/data/flux',
      entries: [{ name: 'flux', path: '/opt/data/flux' }],
      source: 'gateway_api',
      canCreate: true,
      canRename: true,
    }),
  };

  // 测试 MobileSettingsPage 项目 subpage：展示 boardSlug/additionalFolders、重命名与确认文案
  const mobileView = driverDesktop.mount(() =>
    React.createElement(MobileSettingsPage, {
      open: true,
      subpage: 'projects',
      appearancePref: 'dark',
      snapshot: baseSnap,
      onClose: () => {},
      onSelectSubpage: () => {},
      onSetAppearancePreference: () => {},
      settingsActions: baseActions,
    }),
  );
  await flush();
  mobileView.rerender();

  const projectsPanel = findAll(mobileView.tree, (n) => n.props?.['data-testid'] === 'mobile-settings-projects')[0];
  assert.ok(projectsPanel);
  assert.ok(projectsPanel.props.className.includes('flux-settings'));
  assert.ok(projectsPanel.props.className.includes('m-settings-embedded-panel'));
  assert.ok(findAll(mobileView.tree, (n) => n.props?.['data-testid'] === 'project-directory-picker').length === 1);
  // 点击目录行应自动填充 projectNameDraft 与 projectPathDraft
  findAll(mobileView.tree, (n) => n.props?.['data-dir-select'] === '/opt/data/flux')[0].props.onClick();
  mobileView.rerender();
  const nameInputs = findAll(mobileView.tree, (n) => n.props?.placeholder === t('settings.projectsNamePlaceholder'));
  const pathInputs = findAll(mobileView.tree, (n) => n.props?.placeholder === t('settings.projectsPathPlaceholder'));
  assert.equal(nameInputs[0].props.value, 'flux');
  assert.equal(pathInputs[0].props.value, '/opt/data/flux');

  // 点击重命名按钮并提交
  findAll(mobileView.tree, (n) => n.props?.['data-mobile-project-rename'] === 'p-1')[0].props.onClick();
  mobileView.rerender();
  findAll(mobileView.tree, (n) => n.props?.['data-testid'] === 'mobile-project-rename-input')[0].props.onChange({
    currentTarget: { value: 'FluxRepoRenamed' },
  });
  mobileView.rerender();
  await findAll(mobileView.tree, (n) => n.props?.['data-testid'] === 'mobile-project-rename-confirm')[0].props.onClick();
  await flush();
  mobileView.rerender();
  assert.deepEqual(updateCalls, [['p-1', { name: 'FluxRepoRenamed' }]]);

  // 点击删除图标显示 settings.projectsDeleteConfirm 文案
  findAll(mobileView.tree, (n) => n.props?.['aria-label'] === t('mobile.settings.projectsDelete'))[0].props.onClick();
  mobileView.rerender();
  const confirmAlert = findAll(mobileView.tree, (n) => n.props?.['data-testid'] === 'mobile-project-delete-confirm')[0];
  assert.ok(confirmAlert, '移动端删除项目确认时必须呈现确认提示条');

  mobileView.unmount();

  // Desktop SettingsModal & ProjectsPanel: 渲染徽章与目录选择器、自动回填名称、重命名与删除二次确认文案
  const desktopUpdates = [];
  const desktopActions = {
    ...baseActions,
    onUpdateProject: async (id, patch) => {
      desktopUpdates.push([id, patch]);
      return { ok: true };
    },
  };
  const modalHtml = renderToStaticMarkup(
    React.createElement(SettingsModal, {
      snapshot: baseSnap,
      actions: desktopActions,
    }),
  );
  assert.ok(modalHtml.includes('data-testid="project-directory-picker"'));
  assert.ok(modalHtml.includes('flux-kanban'));

  const desktopDriver = createReactHookDriver();
  const desktopView = desktopDriver.mount(() =>
    React.createElement(ProjectsPanel, {
      snapshot: baseSnap,
      actions: desktopActions,
    }),
  );
  await flush();
  desktopView.rerender();
  assert.ok(findAll(desktopView.tree, (n) => n.props?.['data-testid'] === 'project-directory-picker').length === 1);
  findAll(desktopView.tree, (n) => n.props?.['data-dir-select'] === '/opt/data/flux')[0].props.onClick();
  desktopView.rerender();
  const desktopNameInput = findAll(desktopView.tree, (n) => n.props?.id === 'settings-project-name')[0];
  const desktopPathInput = findAll(desktopView.tree, (n) => n.props?.id === 'settings-project-path')[0];
  assert.equal(desktopNameInput.props.value, 'flux');
  assert.equal(desktopPathInput.props.value, '/opt/data/flux');

  findAll(desktopView.tree, (n) => n.props?.['data-settings-project-rename'] === 'p-1')[0].props.onClick();
  desktopView.rerender();
  findAll(desktopView.tree, (n) => n.props?.['data-testid'] === 'settings-project-rename-input')[0].props.onChange({
    currentTarget: { value: 'DesktopRenamed' },
  });
  desktopView.rerender();
  await findAll(desktopView.tree, (n) => n.props?.['data-testid'] === 'settings-project-rename-confirm')[0].props.onClick();
  await flush();
  desktopView.rerender();
  assert.deepEqual(desktopUpdates, [['p-1', { name: 'DesktopRenamed' }]]);

  findAll(desktopView.tree, (n) => n.props?.['aria-label'] === t('settings.projectsDeleteBtn'))[0].props.onClick();
  desktopView.rerender();
  assert.ok(findAll(desktopView.tree, (n) => n.props?.['data-testid'] === 'settings-project-delete-confirm').length === 1);
  desktopView.unmount();
});
