/**
 * Stage 2B Settings Gateway Actions, Scoped Routing, Extensions, OAuth, Projects & Learning Tests
 * (packages/desktop/__tests__/unit/multi-gateway-stage2-settings.test.mjs)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveSelectedGatewayIdFromState,
  buildSettingsGatewayItems,
  createSettingsGatewayController,
} from '../../dist/renderer/services/settingsGatewayActions.mjs';
import { createSettingsDataService } from '../../dist/renderer/services/settingsDataService.mjs';
import { createSettingsExtensionsActions } from '../../dist/renderer/services/settingsExtensionsActions.mjs';
import { createMcpOAuthActions } from '../../dist/renderer/services/mcpOAuthService.mjs';
import { createProjectDirectoryActions } from '../../dist/renderer/services/projectDirectoryActions.mjs';
import { createProjectOperationService } from '../../dist/renderer/services/projectOperationService.mjs';
import { createLearningService } from '../../dist/renderer/services/learningService.mjs';

function flushMicrotasks() {
  return new Promise((resolve) => queueMicrotask(resolve));
}

function makeBaseState(overrides = {}) {
  return {
    platform: 'windows',
    theme: 'obsidian-gold',
    lang: 'zh',
    isMaximized: false,
    leftRailCollapsed: false,
    inspectorCollapsed: false,
    activeInspectorTab: 'files',
    activeSessionId: '',
    activeLiveSessionId: '',
    selectedModel: '',
    availableModels: [],
    modelDetails: [],
    modelCatalog: [],
    modelCatalogHash: '',
    currentProvider: '',
    profiles: [
      { name: 'alpha-bot', displayName: 'Alpha Bot', gatewayId: 'gw-a', isDefault: true, hasAvatar: false },
      { name: 'beta-bot', displayName: 'Beta Bot', gatewayId: 'gw-b', isDefault: false, hasAvatar: false },
    ],
    profileName: 'alpha-bot',
    projects: [],
    groupRooms: [],
    activeFocus: { type: 'session', sessionId: 's-1', gatewayId: 'gw-a' },
    activeGatewayId: 'gw-a',
    settingsGatewayId: '',
    sessionSearchQuery: '',
    isBotsGroupExpanded: true,
    isSessionsGroupExpanded: true,
    isGroupsGroupExpanded: false,
    isMoreSessionsExpanded: false,
    isNewTaskModalOpen: false,
    newTaskModalTab: 'solo',
    modelMenuOpen: false,
    collapsedProviders: [],
    isSettingsOpen: true,
    settingsSection: 'general',
    settingsScopedProfile: '',
    settingsProjects: { status: 'idle' },
    settingsProfiles: { status: 'idle' },
    settingsProviderViews: { status: 'idle' },
    settingsProviderFailures: [],
    settingsSubscriptionCatalog: { status: 'idle' },
    settingsCustomEndpoints: { status: 'idle' },
    settingsEndpointProfiles: {},
    settingsEndpointFailures: [],
    settingsProviderAdminBusy: false,
    settingsMcp: { status: 'idle' },
    settingsSkills: { status: 'idle' },
    settingsBusy: false,
    botManagementStatus: { status: 'uninitialized', activeBotId: '' },
    botManagementActiveBotId: '',
    botManagementDetail: undefined,
    botManagementError: undefined,
    botManagementConfirm: undefined,
    botDrafts: {},
    botManagementBusy: false,
    learningState: { status: 'idle' },
    learningDetail: { status: 'idle' },
    gatewayUrl: 'http://127.0.0.1:18642',
    username: 'admin',
    gatewayUsername: 'admin',
    password: 'pw',
    gatewayHasStoredPassword: true,
    gatewayConnected: true,
    gatewayConnecting: false,
    gatewayLatencyMs: 9,
    gatewayCount: 2,
    gatewayHealthSummary: undefined,
    conversationWidth: 'wide',
    leftRailLayout: 'dual-rail',
    presenceLayout: 'stage',
    appVersion: '0.1.0',
    ...overrides,
  };
}

test('settingsGatewayActions: selection, status projection, seeding, CRUD, toggle, connect/disconnect & test', async () => {
  const cfgs = [
    { id: 'gw-a', name: 'Alpha', url: 'http://127.0.0.1:18642', username: 'u1', enabled: true, routeKind: 'direct' },
    { id: 'gw-b', name: 'Beta', url: 'http://127.0.0.1:18643', username: 'u2', enabled: false, routeKind: 'direct' },
  ];
  assert.equal(resolveSelectedGatewayIdFromState(makeBaseState(), []), '');
  assert.equal(resolveSelectedGatewayIdFromState(makeBaseState({ settingsGatewayId: 'gw-b' }), cfgs), 'gw-b');
  assert.equal(resolveSelectedGatewayIdFromState(makeBaseState({ settingsGatewayId: 'missing', activeFocus: { type: 'session', sessionId: 's', gatewayId: 'gw-b' } }), cfgs), 'gw-b');
  assert.equal(
    resolveSelectedGatewayIdFromState(makeBaseState({ settingsGatewayId: '', activeFocus: { type: 'bot', botName: 'x' }, activeGatewayId: '' }), cfgs, {
      slots: [{ gatewayId: 'gw-b', connected: true }],
    }),
    'gw-b',
  );
  assert.equal(
    resolveSelectedGatewayIdFromState(makeBaseState({ settingsGatewayId: '', activeFocus: { type: 'bot', botName: 'x' }, activeGatewayId: '' }), cfgs, { slots: [] }),
    'gw-a',
  );

  const itemsAll = buildSettingsGatewayItems({
    configs: [
      { id: 'gw-conn', name: 'C', url: 'http://127.0.0.1:1', enabled: true, routeKind: 'direct' },
      { id: 'gw-auth', name: 'A', url: 'http://127.0.0.1:2', enabled: true, routeKind: 'direct' },
      { id: 'gw-reconn', name: 'R', url: 'http://127.0.0.1:3', enabled: true, routeKind: 'direct' },
      { id: 'gw-off', name: 'O', url: 'http://127.0.0.1:4', enabled: true, routeKind: 'direct' },
      { id: 'gw-dis', name: 'D', url: 'http://127.0.0.1:5', enabled: false, routeKind: 'direct' },
    ],
    state: makeBaseState(),
    health: {
      slots: [
        { gatewayId: 'gw-conn', connected: true, latencyMs: 11 },
        { gatewayId: 'gw-auth', connected: false, authError: true, reason: '401' },
        { gatewayId: 'gw-reconn', connected: false, status: 'reconnecting', reason: 'retry' },
        { gatewayId: 'gw-off', connected: false, status: 'offline' },
      ],
    },
  });
  assert.deepEqual(itemsAll.map((i) => i.status), ['connected', 'auth_error', 'connecting', 'offline', 'disabled']);
  assert.equal(itemsAll[0].isDefault, true);
  assert.equal(itemsAll[1].error, '401');

  // Single-gateway fallback statuses (connected, connecting, offline)
  const singleCfg = [{ id: 's1', name: 'S', url: 'http://127.0.0.1:9', enabled: true, routeKind: 'direct' }];
  assert.equal(buildSettingsGatewayItems({ configs: singleCfg, state: makeBaseState({ gatewayConnected: true, gatewayConnecting: false }) })[0].status, 'connected');
  assert.equal(buildSettingsGatewayItems({ configs: singleCfg, state: makeBaseState({ gatewayConnected: false, gatewayConnecting: true }) })[0].status, 'connecting');
  assert.equal(buildSettingsGatewayItems({ configs: singleCfg, state: makeBaseState({ gatewayConnected: false, gatewayConnecting: false }) })[0].status, 'offline');

  // Controller full CRUD lifecycle (including seeding primary from legacy state when configs is initially empty)
  let storedConfigs = [];
  const state = makeBaseState({ settingsGatewayId: '' });
  const syncCalls = [];
  const secretOps = [];
  const legacyDrafts = [];
  const connCalls = [];
  const desktopApi = {
    getGatewaySecret: async (key) => {
      secretOps.push(['get', key]);
      return 'stored-pw';
    },
    setGatewaySecret: async (key, pw) => secretOps.push(['set', key, pw]),
    deleteGatewaySecret: async (key) => secretOps.push(['del', key]),
  };
  let useConnectInstanceFn = true;
  const controller = createSettingsGatewayController({
    getState: () => state,
    getGatewayConfigs: () => storedConfigs,
    saveGatewayConfigs: (next) => {
      storedConfigs = [...next];
      return { ok: true };
    },
    getDesktopApi: () => desktopApi,
    testConnection: async (url, user, pass) => ({ ok: true, latency: 7, message: `${url}|${user}|${pass}` }),
    connect: async () => connCalls.push('legacy-connect'),
    disconnect: () => connCalls.push('legacy-disconnect'),
    syncConfiguredGateways: async (opts) => syncCalls.push(opts),
    connectGatewayInstance: (id) => (useConnectInstanceFn ? (connCalls.push(['inst-connect', id]), Promise.resolve(true)) : Promise.resolve(false)),
    disconnectGatewayInstance: (id) => (connCalls.push(['inst-disconnect', id]), true),
    render: () => {},
    t: (k) => k,
    bootLog: { warn: () => {} },
    showToast: () => {},
    runBusy: async (fn) => { await fn(); },
    applyLegacyGatewayDraft: (d) => {
      legacyDrafts.push(d);
      state.gatewayUrl = d.url;
      state.username = d.username;
      state.password = d.password;
      state.profileName = d.profileName;
    },
  });

  // Empty URL validation
  assert.deepEqual(await controller.actions.onAddGateway({ name: 'X', url: '   ', username: '', password: '', profileName: '' }), {
    ok: false,
    message: 'gateway.urlRequired',
  });
  assert.deepEqual(await controller.actions.onTestGatewayInstance({ name: '', url: '', username: '', password: '', profileName: '' }), {
    ok: false,
    message: 'gateway.urlRequired',
  });

  // Add second gateway while storedConfigs is empty -> seeds primary + adds Beta -> syncs multi-gw
  const addBeta = await controller.actions.onAddGateway({
    name: 'Beta',
    url: 'http://127.0.0.1:18643',
    username: 'bob',
    password: 'pw2',
    profileName: 'ops',
  });
  assert.equal(addBeta.ok, true);
  assert.equal(storedConfigs.length, 2);
  assert.equal(controller.getProfileNameForGateway(addBeta.gatewayId), 'ops');
  assert.equal(controller.getProfileNameForGateway('missing-gw'), 'alpha-bot');
  assert.equal(controller.getItems().length, 2);
  assert.ok(controller.getSelectedGatewayId());

  // Duplicate slug collision + symbol-only name ('gw') fallback + single-gw onAddGateway
  const dupRes = await controller.actions.onAddGateway({
    name: 'Beta',
    url: 'http://127.0.0.1:18644',
    username: '',
    password: '',
    profileName: '',
  });
  assert.equal(dupRes.gatewayId, 'beta-2');
  const dup2Res = await controller.actions.onAddGateway({
    name: 'Beta',
    url: 'http://127.0.0.1:18645',
    username: '',
    password: '',
    profileName: '',
  });
  assert.equal(dup2Res.gatewayId, 'beta-3');
  const symRes = await controller.actions.onAddGateway({
    name: '!!!',
    url: 'http://???',
    username: '',
    password: '',
    profileName: '',
  });
  assert.ok(symRes.ok);

  // onUpdateGateway: empty url, missing id, valid multi-gw update + clearing username & saving pw
  assert.deepEqual(await controller.actions.onUpdateGateway('beta', { name: 'B', url: '', username: '', password: '', profileName: '' }), {
    ok: false,
    message: 'gateway.urlRequired',
  });
  assert.deepEqual(await controller.actions.onUpdateGateway('no-such-id', { name: 'B', url: 'http://127.0.0.1:1', username: '', password: '', profileName: '' }), {
    ok: false,
    message: 'settings.loadFailed',
  });
  assert.deepEqual(
    await controller.actions.onUpdateGateway('beta', { name: 'Beta-Edited', url: 'http://127.0.0.1:18643', username: '', password: 'new-pw', profileName: 'custom' }),
    { ok: true },
  );

  // onTestGatewayInstance with stored password resolution
  const testStored = await controller.actions.onTestGatewayInstance({
    id: 'beta',
    name: 'Beta',
    url: 'http://127.0.0.1:18643',
    username: 'bob',
    password: '',
    profileName: 'default',
  });
  assert.equal(testStored.ok, true);
  assert.ok(testStored.message.includes('stored-pw'));

  // Toggle, connect instance, disconnect instance
  await controller.actions.onToggleGatewayEnabled('beta', false);
  await controller.actions.onToggleGatewayEnabled('beta', true);
  await controller.actions.onConnectGatewayInstance('beta');
  controller.actions.onDisconnectGatewayInstance('beta');

  // Connect/Disconnect/Test legacy
  controller.actions.onTestGateway({ url: 'http://127.0.0.1:18642', username: 'a', password: 'b', profileName: 'default' });
  await flushMicrotasks();
  controller.actions.onConnectGateway({ url: '', username: '', password: '', profileName: 'default' });
  assert.equal(state.testStatus.ok, false);
  controller.actions.onConnectGateway({ url: 'http://127.0.0.1:18642', username: 'a', password: 'b', profileName: 'default' });
  controller.actions.onDisconnectGateway();

  // Remove down to 1 gateway -> missing id, drop to 1 updates legacy fields, last gateway blocked
  assert.deepEqual(await controller.actions.onRemoveGateway('missing'), { ok: false, message: 'settings.loadFailed' });
  state.settingsGatewayId = dupRes.gatewayId;
  await controller.actions.onRemoveGateway(dupRes.gatewayId);
  await controller.actions.onRemoveGateway(dup2Res.gatewayId);
  await controller.actions.onRemoveGateway(symRes.gatewayId);
  await controller.actions.onRemoveGateway('beta');
  assert.equal(storedConfigs.length, 1);
  assert.deepEqual(await controller.actions.onRemoveGateway(storedConfigs[0].id), {
    ok: false,
    message: 'settings.gatewayRemoveLastHint',
  });

  // Single-gateway update & add when gatewayUrl was empty
  await controller.actions.onUpdateGateway(storedConfigs[0].id, {
    name: 'Solo',
    url: 'http://127.0.0.1:18642',
    username: '',
    password: '',
    profileName: 'default',
  });
  storedConfigs = [];
  state.gatewayUrl = '';
  await controller.actions.onAddGateway({
    name: 'First',
    url: 'http://127.0.0.1:18699',
    username: '',
    password: '',
    profileName: 'default',
  });
  assert.equal(storedConfigs.length, 1);
});

test('settingsDataService multi-gateway scoped routing, drafts isolation, learning forwarding, and snapshot projection', async () => {
  const state = makeBaseState({ settingsSection: 'projects', settingsGatewayId: 'gw-b' });
  const rpcA = [];
  const rpcB = [];
  const makeClient = (tag, log) => ({
    request: async (m, p) => {
      log.push([m, p]);
      if (m === 'profiles.list') return { profiles: [{ name: `${tag}-bot`, display_name: `${tag} Bot` }] };
      if (m === 'models.list' || m === 'providers.list') return { models: [], providers: [] };
      return {};
    },
    call: async (m, p) => {
      log.push([m, p]);
      if (m === 'mcp.servers.status') return { servers: [] };
      if (m === 'skills.manage') return { skills: {} };
      return {};
    },
  });
  const clientA = makeClient('alpha', rpcA);
  const clientB = makeClient('beta', rpcB);

  const slots = {
    'gw-a': { connected: true },
    'gw-b': { connected: false },
  };
  let isMultiConnected = { 'gw-a': true, 'gw-b': false };
  const learningCalls = [];
  const fetchedProjectsFor = [];
  const refreshedSlots = [];
  const cfgs = [
    { id: 'gw-a', name: 'Alpha', url: 'http://127.0.0.1:18642', username: 'a', enabled: true, routeKind: 'direct' },
    { id: 'gw-b', name: 'Beta', url: 'http://127.0.0.1:18643', username: 'b', enabled: true, routeKind: 'direct' },
  ];

  const svc = createSettingsDataService({
    getState: () => state,
    getGatewayClient: () => clientA,
    getClientForGateway: (id) => (id === 'gw-b' ? clientB : clientA),
    getGatewayConfigs: () => cfgs,
    saveGatewayConfigs: () => ({ ok: true }),
    getGatewaySlot: (id) => slots[id],
    getHealthSummary: () => ({
      slots: [
        { gatewayId: 'gw-a', connected: isMultiConnected['gw-a'], latencyMs: 5 },
        { gatewayId: 'gw-b', connected: isMultiConnected['gw-b'], latencyMs: 8 },
      ],
    }),
    isGatewayConnected: (id) => Boolean(isMultiConnected[id]),
    getGatewayUrlForGateway: (id) => cfgs.find((c) => c.id === id)?.url,
    getTicketForGateway: (id) => `tk-${id}`,
    getCurrentTicket: () => 'tk-legacy',
    getEffectiveUrl: (u) => u,
    fetchProjects: async (gwId) => fetchedProjectsFor.push(gwId),
    refreshGatewaySlot: async (gwId) => refreshedSlots.push(gwId),
    render: () => {},
    t: (k) => k,
    describeRpcError: (e) => String(e),
    showToast: () => {},
    bootLog: { warn: () => {} },
    fetchModelOptions: async () => {},
    fetchProfiles: async () => {},
    testConnection: async () => ({ ok: true }),
    connect: async () => {},
    disconnect: () => {},
    getFontPreferences: () => ({ uiFont: 'default', codeFont: 'default', sizeScale: 'medium' }),
    setFontPreferences: () => {},
    applyFontPreferences: () => {},
    getActivityIndicatorVariant: () => 'cloud',
    setActivityIndicatorVariant: () => {},
    saveActivityIndicatorVariant: () => {},
    resolveActivityIndicatorVariant: () => 'cloud',
    resolveSkinId: () => 'obsidian-gold',
    writePresenceLayout: () => {},
    onPresenceLayoutChanged: () => {},
    profileAvatarCache: new Map(),
    persistAvatarCache: () => {},
    persistAgentsToCache: () => {},
    learningService: {
      loadLearningGraph: async (o) => learningCalls.push(['graph', o]),
      loadLearningDetail: async (id, p, gw) => learningCalls.push(['detail', id, p, gw]),
      editLearningNode: async (id, c, p, gw) => (learningCalls.push(['edit', id, c, p, gw]), { ok: true }),
      deleteLearningNode: async (id, p, gw) => (learningCalls.push(['del', id, p, gw]), { ok: true }),
    },
  });

  // 1. ensureSettingsSectionData for 'projects' + 'providers' under multi-gateway
  svc.ensureSettingsSectionData('projects');
  svc.ensureSettingsSectionData('providers');
  await flushMicrotasks();
  assert.ok(fetchedProjectsFor.includes('gw-b'));

  // Implicit settingsGatewayId change (e.g. adding 2nd gateway) must invalidate cached settingsProjects and reload for new gw
  isMultiConnected['gw-b'] = true;
  state.settingsProjects = { status: 'ready', data: [{ id: 'p-a', name: 'Alpha Project', path: '/a' }] };
  state.settingsGatewayId = 'gw-a';
  svc.ensureSettingsSectionData('projects', false);
  await flushMicrotasks();
  assert.ok(fetchedProjectsFor.includes('gw-a'));
  state.settingsGatewayId = 'gw-b';
  isMultiConnected['gw-b'] = false;
  svc.ensureSettingsSectionData('projects', true);
  await flushMicrotasks();

  // 2. getSettingsSnapshot projects selected gw status across offline / connected / connecting
  assert.equal(svc.getSettingsSnapshot().gateway.status, 'disconnected');
  isMultiConnected['gw-b'] = true;
  assert.equal(svc.getSettingsSnapshot().gateway.status, 'connected');

  // 3. Switch gateway with dirty bot drafts saved & restored in botDraftsByGateway
  const actions = svc.createSettingsActions();
  state.settingsSection = 'agents';
  state.botDrafts = { 'beta-bot': { displayName: 'Draft Beta' } };
  actions.onSelectSettingsGateway('gw-b'); // no-op same gw
  actions.onSelectSettingsGateway('gw-a'); // prompts dirty exit
  actions.onConfirmBotExit('keep');
  assert.equal(state.settingsGatewayId, 'gw-a');
  assert.equal(state.gatewayCount, 2);

  // Save draft on gw-a -> switching back from 'agents' sees unsaved draft in botDraftsByGateway & confirms 'keep' to restore gw-b draft
  state.botDrafts = {};
  actions.onOpenAgent('alpha-bot');
  actions.onSelectSettingsGateway('gw-b'); // intercepted because botDraftsByGateway holds unsaved gw-b draft
  actions.onConfirmBotExit('keep');
  assert.equal(state.botDrafts['beta-bot']?.displayName, 'Draft Beta');
  // Switching when state.settingsSection !== 'agents' happens immediately without exit prompt
  state.settingsSection = 'projects';
  actions.onSelectSettingsGateway('gw-a');
  assert.equal(state.settingsGatewayId, 'gw-a');
  actions.onSelectSettingsGateway('gw-b');
  assert.equal(state.botDrafts['beta-bot']?.displayName, 'Draft Beta');
  state.botDrafts = {};
  actions.onLoadLearningGraph('beta-bot', true);
  actions.onLoadLearningDetail('n1', 'beta-bot');
  await actions.onEditLearningNode('n1', 'txt', 'beta-bot');
  await actions.onDeleteLearningNode('n1', 'beta-bot');
  assert.equal(learningCalls[0][1].gatewayId, 'gw-b');
  assert.equal(learningCalls[1][3], 'gw-b');

  // 4. openBotSettings cross-gateway switch + constellation tab + onCreated refreshGatewaySlot
  svc.openBotSettings('alpha-bot', { tab: 'constellation', gatewayId: 'gw-a' });
  await flushMicrotasks();
  assert.equal(state.settingsGatewayId, 'gw-a');

  // 5. Fallback botRoster tiers (settingsProfiles ready + fallback profile when empty)
  state.profiles = [];
  state.settingsProfiles = { status: 'ready', data: [{ name: 'sp-bot', displayName: 'SP' }] };
  assert.equal(svc.getSettingsSnapshot().bots[0].profile, 'sp-bot');
  state.settingsProfiles = { status: 'idle' };
  assert.equal(svc.getSettingsSnapshot().bots[0].profile, 'alpha-bot');

  // 6. Single-gateway mode learning & isGatewaySlot fallback check
  state.gatewayCount = 1;
  cfgs.splice(0, 2);
  actions.onLoadLearningDetail('n2', 'alpha-bot');
  await actions.onEditLearningNode('n2', 'c2', 'alpha-bot');
  await actions.onDeleteLearningNode('n2', 'alpha-bot');
});

test('settingsExtensionsActions, mcpOAuthService, projectDirectoryActions, projectOperationService & learningService multi-gw paths', async () => {
  const rpcCalls = [];
  const client = {
    request: async (m, p) => {
      rpcCalls.push([m, p]);
      if (m === 'mcp.catalog') return { servers: [] };
      if (m === 'mcp.servers.test') return { ok: true, tools: [] };
      if (m === 'skills.manage') return { skills: [] };
      return {};
    },
    call: async (m, p) => {
      rpcCalls.push([m, p]);
      if (m === 'projects.list') return { projects: [{ projectId: 'p-b', name: 'Beta Proj', primary_path: '/beta' }] };
      return {};
    },
  };
  const ext = createSettingsExtensionsActions({
    getGatewayClient: () => client,
    isConnected: () => true,
    getFallbackProfile: () => '',
    getActiveBotDetail: () => undefined,
    getSettingsSkills: () => ({ status: 'idle' }),
    getMcpStatus: () => 'idle',
    getSkillsStatus: () => 'idle',
    getSection: () => 'extensions',
    refreshActiveCapabilities: async () => {},
    loadExtensions: async () => {},
    t: (k) => k,
    describeRpcError: (e) => String(e),
    bootLog: { warn: () => {} },
  });
  await ext.onFetchMcpCatalog('');
  await ext.onAddMcpServer('', { name: 'srv1' });
  await ext.onRemoveMcpServer('', 'srv1');
  await ext.onTestMcpServer('', 'srv1');
  await ext.onSearchSkillsHub('', '');
  await ext.onInstallSkill('', 'sk1');
  await ext.onInspectSkill('', 'sk1', 'desc');
  assert.ok(rpcCalls.every(([, p]) => p.profile === 'default'));

  // mcpOAuthService without isGatewayConnected (uses state.gatewayConnected)
  const oauth = createMcpOAuthActions({
    getState: () => makeBaseState({ gatewayConnected: false }),
    getGatewayClient: () => client,
    describeRpcError: (e) => String(e),
    t: (k) => k,
    onNotify: () => {},
  });
  assert.equal((await oauth.onReloadMcp()).ok, false);

  // projectDirectoryActions with and without custom getGatewayUrl / isGatewayConnected
  const dirActsDefault = createProjectDirectoryActions({
    getState: () => makeBaseState({ gatewayConnected: true, gatewayUrl: 'http://127.0.0.1:8642' }),
    getGatewayClient: () => client,
    getEffectiveUrl: (u) => u,
  });
  const dirActsCustom = createProjectDirectoryActions({
    getState: () => makeBaseState(),
    getGatewayClient: () => client,
    getGatewayUrl: () => 'http://127.0.0.1:18643',
    isGatewayConnected: () => false,
    getEffectiveUrl: (u) => u,
  });
  assert.ok(dirActsDefault && dirActsCustom);

  // projectOperationService multi-gateway merge preserves other gateways' projects
  const pState = makeBaseState({
    gatewayCount: 2,
    projects: [{ id: 'p-a', name: 'Alpha Proj', path: '/alpha', gatewayId: 'gw-a', archived: false }],
  });
  const projSvc = createProjectOperationService({
    getState: () => pState,
    getGatewayClient: () => client,
    getClientForGateway: () => client,
    render: () => {},
    botActivityStore: { withActivityMap: () => {} },
    botForeverChatCache: new Map(),
    sessionMessagesCache: new Map(),
    formatSessionTime: () => '',
  });
  await projSvc.fetchProjects('gw-b');
  assert.equal(pState.projects.some((p) => p.id === 'p-a' && p.gatewayId === 'gw-a'), true);
  assert.equal(pState.projects.some((p) => p.id === 'p-b' && p.gatewayId === 'gw-b'), true);

  // learningService explicit gatewayId & getUrlForGateway / getTicketForGateway / getClientForGateway
  const lState = makeBaseState({ activeFocus: { type: 'bot', botName: 'b' }, activeGatewayId: '' });
  const lClientB = {
    request: async () => ({ nodes: [], edges: [] }),
    call: async () => ({ nodes: [], edges: [] }),
  };
  const learnSvc = createLearningService({
    getState: () => lState,
    render: () => {},
    getGatewayClient: () => null,
    getClientForGateway: (id) => (id === 'gw-b' ? lClientB : null),
    getDesktopApi: () => ({ httpProxy: async () => ({ nodes: [], edges: [], total_skills: 0 }) }),
    getUrlForGateway: (id) => (id === 'gw-b' ? 'http://127.0.0.1:18643' : ''),
    getTicketForGateway: (id) => (id === 'gw-b' ? 'tk-b' : ''),
    getEffectiveUrl: (u) => u,
    t: (k) => k,
    describeRpcError: (e) => String(e),
  });
  await learnSvc.loadLearningGraph({ profile: 'beta-bot', gatewayId: 'gw-b', force: true });
  assert.equal(lState.learningState.status, 'ready');
});

import {
  clearRuntimeGatewaySecrets,
  deleteGatewayPassword,
  resolveGatewayPassword,
  saveGatewayConfigs,
  saveGatewayPassword,
  upsertGatewayConfig,
} from '../../dist/renderer/gateway/gatewayRegistryStore.mjs';
import { createDesktopMultiGatewayWiring } from '../../dist/renderer/gateway/multiGatewayCoordinator.mjs';
import { LiveStreamRegistry, SessionHandleRegistry } from '@hermes-flux/core';

test('Stage 2B coverage top-up: registry upsert invalid, gateway actions fallback branches, dataService slot/wizard/project branches & extensions/dir/learning', async () => {
  // 1. gatewayRegistryStore upsertGatewayConfig & saveGatewayConfigs invalid entry
  assert.deepEqual(upsertGatewayConfig([], { id: '', name: '', url: '', routeKind: 'direct' }), []);
  const regMap = new Map();
  saveGatewayConfigs(
    [
      { id: 'gw-ok', name: 'OK', url: 'http://127.0.0.1:18642', enabled: true, routeKind: 'direct' },
      { id: '', name: 'Bad', url: '', enabled: true, routeKind: 'direct' },
    ],
    {
      setItem: (k, v) => regMap.set(k, v),
      removeItem: (k) => regMap.delete(k),
    },
  );
  assert.equal(JSON.parse(regMap.get('hermes_flux_gateways_v1')).length, 1);

  // 2. settingsGatewayActions remaining branches (getHealthSummary provided, empty username/password/profileName seed, empty name slug -> 'gw', omit connectGatewayInstance, disable via update, remove down to 1 with undefined username)
  let stored = [];
  const bareState = makeBaseState({
    settingsGatewayId: '',
    gatewayUrl: 'http://127.0.0.1:18642',
    username: '   ',
    password: '',
    profileName: '',
    gatewayHealthSummary: undefined,
  });
  const syncCalls = [];
  const gwCtrlBare = createSettingsGatewayController({
    getState: () => bareState,
    getGatewayConfigs: () => stored,
    saveGatewayConfigs: (next) => { stored = [...next]; return { ok: true }; },
    getHealthSummary: () => ({ slots: [{ gatewayId: 'explicit-gw', connected: true, latencyMs: 4 }] }),
    testConnection: async () => ({ ok: true, latency: 3 }),
    connect: async () => {},
    disconnect: () => {},
    syncConfiguredGateways: async (o) => syncCalls.push(o),
    render: () => {},
    t: (k) => k,
    bootLog: { warn: () => {} },
    showToast: () => {},
    runBusy: async (fn) => { await fn(); },
    applyLegacyGatewayDraft: () => {},
  });
  // Empty name + non-alnum url -> deriveGatewayShortLabel -> 'gw', explicit draft.id
  await gwCtrlBare.actions.onAddGateway({ name: '   ', url: '???', username: '', password: '', profileName: '' });
  await gwCtrlBare.actions.onAddGateway({ id: 'explicit-gw', name: 'Explicit', url: 'http://127.0.0.1:18655', username: 'bob', password: '', profileName: '' });
  assert.equal(gwCtrlBare.getProfileNameForGateway('explicit-gw'), 'default');
  assert.ok(gwCtrlBare.getItems().length >= 2);
  assert.ok(gwCtrlBare.getSelectedGatewayId());
  await gwCtrlBare.actions.onUpdateGateway('explicit-gw', { name: 'E2', url: 'http://127.0.0.1:18655', username: 'bob2', password: '', profileName: '', enabled: false });
  await gwCtrlBare.actions.onConnectGatewayInstance('explicit-gw'); // hits connectGatewayInstance omitted
  bareState.settingsGatewayId = stored[0].id;
  stored[0].username = 'keepuser';
  await gwCtrlBare.actions.onRemoveGateway(stored.at(-1).id);
  while (stored.length > 2) await gwCtrlBare.actions.onRemoveGateway(stored.at(-1).id);
  delete stored[0].username;
  await gwCtrlBare.actions.onRemoveGateway(stored[1].id); // dropping from 2 -> 1 sets state.username = '' when undefined
  assert.equal(bareState.username, '');

  // 3. settingsDataService branches: getGatewaySlot without isGatewayConnected, botWizard, connecting status, project CRUD wrappers, openAgent without multi-gw, fetchMcp empty profile
  const sState2 = makeBaseState({
    settingsGatewayId: 'gw-a',
    gatewayCount: 2,
    gatewayConnecting: true,
    gatewayConnected: false,
    profileName: '',
    profiles: [],
    settingsProfiles: { status: 'idle' },
    botManagementDetail: undefined,
    botManagementActiveBotId: '',
  });
  let wizardCreateCalls = 0;
  let projOpsCalls = [];
  const mockSlotClient = {
    request: async (m, p) => {
      if (m === 'profiles.create') { wizardCreateCalls += 1; return { created: true, name: p.name }; }
      if (m === 'profiles.configure') return { ok: true };
      if (m === 'profiles.list') return { profiles: [{ name: 'created-bot', display_name: 'Created Bot' }] };
      if (m === 'mcp.catalog') return { servers: [] };
      return {};
    },
    call: async () => ({}),
  };
  let slotConnected = false;
  let storedCfgs2 = [
    { id: 'gw-a', name: 'Alpha', url: 'http://127.0.0.1:18642', enabled: true, routeKind: 'direct' },
    { id: 'gw-b', name: 'Beta', url: 'http://127.0.0.1:18643', enabled: true, routeKind: 'direct' },
  ];
  const svcSlotOnly = createSettingsDataService({
    getState: () => sState2,
    getGatewayClient: () => mockSlotClient,
    getClientForGateway: () => mockSlotClient,
    getGatewayConfigs: () => storedCfgs2,
    saveGatewayConfigs: () => ({ ok: true }),
    getGatewaySlot: () => ({ connected: slotConnected }),
    getHealthSummary: () => ({ slots: [{ gatewayId: 'gw-a', connected: false, status: 'reconnecting' }] }),
    getCurrentTicket: () => 'tk',
    getEffectiveUrl: (u) => u,
    refreshGatewaySlot: async () => {},
    createProject: async (p, gw) => { projOpsCalls.push(['create', p, gw]); return { ok: true }; },
    updateProject: async (id, patch, gw) => { projOpsCalls.push(['update', id, patch, gw]); return { ok: true }; },
    deleteProject: async (id, gw) => { projOpsCalls.push(['delete', id, gw]); return { ok: true }; },
    render: () => {},
    t: (k) => k,
    describeRpcError: (e) => String(e),
    showToast: () => {},
    bootLog: { warn: () => {} },
    fetchModelOptions: async () => {},
    fetchProfiles: async () => {},
    testConnection: async () => ({ ok: true }),
    connect: async () => {},
    disconnect: () => {},
    getFontPreferences: () => ({ uiFont: 'default', codeFont: 'default', sizeScale: 'medium' }),
    setFontPreferences: () => {},
    applyFontPreferences: () => {},
    getActivityIndicatorVariant: () => 'cloud',
    setActivityIndicatorVariant: () => {},
    saveActivityIndicatorVariant: () => {},
    resolveActivityIndicatorVariant: () => 'cloud',
    resolveSkinId: () => 'obsidian-gold',
    writePresenceLayout: () => {},
    onPresenceLayoutChanged: () => {},
    profileAvatarCache: new Map(),
    persistAvatarCache: () => {},
    persistAgentsToCache: () => {},
  });
  const acts2 = svcSlotOnly.createSettingsActions();
  // getSettingsSnapshot while multi-gw status === 'connecting'
  assert.equal(svcSlotOnly.getSettingsSnapshot().gateway.status, 'connecting');
  // Trigger getSettingsSnapshot across all 3 single-gw statuses (connected, connecting, disconnected)
  storedCfgs2 = [];
  sState2.gatewayCount = 1;
  sState2.settingsGatewayId = '';
  sState2.gatewayConnected = true;
  sState2.gatewayConnecting = false;
  assert.equal(svcSlotOnly.getSettingsSnapshot().gateway.status, 'connected');
  sState2.gatewayConnected = false;
  sState2.gatewayConnecting = true;
  assert.equal(svcSlotOnly.getSettingsSnapshot().gateway.status, 'connecting');
  sState2.gatewayConnecting = false;
  assert.equal(svcSlotOnly.getSettingsSnapshot().gateway.status, 'disconnected');
  acts2.onOpenAgent('bot1');
  await acts2.onCreateProject({ name: 'P', path: '/p' });
  await acts2.onUpdateProject('p1', { name: 'P2' });
  await acts2.onDeleteProject('p1');
  assert.equal(projOpsCalls.length, 3);

  // Also test settingsDataService WITHOUT refreshGatewaySlot + valid botWizard submit + single-gw onStartLogin empty & custom profileName
  const minState = makeBaseState({
    gatewayCount: 1,
    settingsGatewayId: '',
    gatewayConnected: true,
    profiles: [],
    settingsProfiles: { status: 'idle' },
    profileName: '',
  });
  const minClient = {
    request: async (m, p) => {
      if (m === 'profiles.create') return { ok: true, name: p.name };
      if (m === 'profiles.configure') return { ok: true };
      if (m === 'profiles.list') return { profiles: [{ name: 'solo-new-bot', display_name: 'Solo New' }] };
      return {};
    },
    call: async () => ({}),
  };
  const svcNoRefresh = createSettingsDataService({
    getState: () => minState,
    getGatewayClient: () => minClient,
    getGatewayConfigs: () => [],
    saveGatewayConfigs: () => ({ ok: true }),
    getCurrentTicket: () => 'tk',
    getEffectiveUrl: (u) => u,
    render: () => {},
    t: (k) => k,
    describeRpcError: (e) => String(e),
    showToast: () => {},
    bootLog: { warn: () => {} },
    fetchModelOptions: async () => {},
    fetchProfiles: async () => {},
    testConnection: async () => ({ ok: true }),
    connect: async () => {},
    disconnect: () => {},
    getFontPreferences: () => ({ uiFont: 'default', codeFont: 'default', sizeScale: 'medium' }),
    setFontPreferences: () => {},
    applyFontPreferences: () => {},
    getActivityIndicatorVariant: () => 'cloud',
    setActivityIndicatorVariant: () => {},
    saveActivityIndicatorVariant: () => {},
    resolveActivityIndicatorVariant: () => 'cloud',
    resolveSkinId: () => 'obsidian-gold',
    writePresenceLayout: () => {},
    onPresenceLayoutChanged: () => {},
    profileAvatarCache: new Map(),
    persistAvatarCache: () => {},
    persistAgentsToCache: () => {},
  });
  const minActs = svcNoRefresh.createSettingsActions();
  await minActs.onStartLogin('openai');
  minState.profileName = 'solo-custom';
  await minActs.onStartLogin('openai');
  minActs.onOpenBotWizard('blank');
  minActs.onBotWizardDraftChange({ name: 'solo-new-bot', displayName: 'Solo New' });
  await minActs.onSubmitCreateBot();

  // Switch back to 2-gw & exercise getGatewaySlot connected true/false (lines 286-287) + botWizard + startLogin + refreshExtensions + onFetchMcpCatalog
  storedCfgs2 = [
    { id: 'gw-a', name: 'Alpha', url: 'http://127.0.0.1:18642', enabled: true, routeKind: 'direct' },
    { id: 'gw-b', name: 'Beta', url: 'http://127.0.0.1:18643', enabled: true, routeKind: 'direct' },
  ];
  sState2.gatewayCount = 2;
  sState2.settingsGatewayId = 'gw-a';
  await acts2.onFetchMcpCatalog(''); // hits line 286-287 false (`slotConnected = false`) & line 1416
  slotConnected = true;
  acts2.onRefreshExtensions(); // hits line 439 when fallback empty
  await acts2.onStartLogin('openai'); // hits line 342
  acts2.onOpenBotWizard('clone'); // hits line 639 & 645
  acts2.onBotWizardDraftChange({ name: 'created-bot', displayName: 'Created Bot' });
  await acts2.onSubmitCreateBot(); // hits line 657 (refreshGatewaySlot)
  assert.equal(wizardCreateCalls, 1);

  // scopedProfileName valid vs invalid in multi-gw (line 299)
  sState2.profiles = [{ name: 'real-bot', displayName: 'Real', gatewayId: 'gw-a' }];
  sState2.settingsScopedProfile = 'stale-bot';
  assert.equal(svcSlotOnly.getSettingsSnapshot().scopedProfile, 'real-bot');
  sState2.settingsScopedProfile = 'real-bot';
  assert.equal(svcSlotOnly.getSettingsSnapshot().scopedProfile, 'real-bot');

  // 4. settingsExtensionsActions with getFallbackProfile -> 'ops' + mcp.servers.test catch
  let throwTest = true;
  const extOps = createSettingsExtensionsActions({
    getGatewayClient: () => ({
      request: async (m, p) => {
        if (m === 'mcp.servers.test' && throwTest) throw new Error('test boom');
        return { servers: [], skills: [], ok: true };
      },
    }),
    isConnected: () => true,
    getFallbackProfile: () => 'ops',
    getActiveBotDetail: () => undefined,
    getSettingsSkills: () => ({ status: 'idle' }),
    getMcpStatus: () => 'idle',
    getSkillsStatus: () => 'idle',
    getSection: () => 'extensions',
    refreshActiveCapabilities: async () => {},
    loadExtensions: async () => {},
    t: (k) => k,
    describeRpcError: (e) => String(e),
    bootLog: { warn: () => {} },
  });
  await extOps.onFetchMcpCatalog('');
  await extOps.onAddMcpServer('', { name: 's' });
  await extOps.onRemoveMcpServer('', 's');
  const testFail = await extOps.onTestMcpServer('', 's');
  assert.equal(testFail.ok, false);
  await extOps.onSearchSkillsHub('', 'q');
  await extOps.onInstallSkill('', 'sk');
  await extOps.onInspectSkill('', 'sk');

  // 5. mcpOAuthService WITH isGatewayConnected: () => true (line 84)
  const oauthTrue = createMcpOAuthActions({
    getState: () => makeBaseState({ gatewayConnected: false }),
    getGatewayClient: () => ({ call: async () => ({ status: 'reloaded' }) }),
    isGatewayConnected: () => true,
    describeRpcError: (e) => String(e),
    t: (k) => k,
    onNotify: () => {},
  });
  assert.equal((await oauthTrue.onReloadMcp()).ok, true);

  // 6. projectDirectoryActions actually call onBrowseProjectDirectory (lines 46 & 53)
  const dirDef = createProjectDirectoryActions({
    getState: () => makeBaseState({ gatewayConnected: true, gatewayUrl: '' }),
    getGatewayClient: () => ({ request: async () => ({ stdout: '[]', code: 0 }) }),
    getEffectiveUrl: (u) => u,
  });
  const dirCust = createProjectDirectoryActions({
    getState: () => makeBaseState(),
    getGatewayClient: () => ({ request: async () => ({ stdout: '[]', code: 0 }) }),
    getGatewayUrl: () => 'http://127.0.0.1:18643',
    isGatewayConnected: () => true,
    getEffectiveUrl: (u) => u,
  });
  await dirDef.onBrowseProjectDirectory('/tmp');
  await dirCust.onBrowseProjectDirectory('/tmp');

  // 7. learningService resolveTargetGatewayId without explicit gatewayId & activeFocus.gatewayId (line 87)
  const learn2 = createLearningService({
    getState: () => makeBaseState({ activeFocus: { type: 'bot', botName: 'x' }, activeGatewayId: 'gw-b' }),
    render: () => {},
    getGatewayClient: () => ({ call: async () => ({ nodes: [], edges: [] }), request: async () => ({}) }),
    t: (k) => k,
    describeRpcError: (e) => String(e),
  });
  await learn2.loadLearningGraph({ profile: 'x' });
});

test('Non-keychain runtime gateway secret isolation & cross-origin fallback guard (Browser Live & Mobile)', async () => {
  clearRuntimeGatewaySecrets();
  const prevStorage = globalThis.localStorage;
  const lsData = new Map();
  globalThis.localStorage = {
    getItem: (k) => (lsData.has(k) ? lsData.get(k) : null),
    setItem: (k, v) => lsData.set(k, String(v)),
    removeItem: (k) => lsData.delete(k),
  };
  try {
    const alphaCfg = { id: '__default__', url: 'http://127.0.0.1:18642' };
    const betaCfg = { id: 'beta', url: 'http://127.0.0.1:18643' };

    // Save distinct secrets without OS keychain bridge -> isolated in runtime memory only (zero localStorage writes)
    await saveGatewayPassword(alphaCfg, 'alpha-pass', undefined);
    await saveGatewayPassword(betaCfg, 'beta-pass', undefined);
    assert.equal(lsData.size, 0);
    assert.equal(await resolveGatewayPassword(alphaCfg, undefined, ''), 'alpha-pass');
    assert.equal(await resolveGatewayPassword(betaCfg, undefined, 'alpha-pass'), 'beta-pass');

    // Throwing keychain bridge also falls back to runtime secret cleanly
    const throwingBridge = {
      getGatewaySecret: async () => { throw new Error('keychain locked'); },
      setGatewaySecret: async () => { throw new Error('keychain locked'); },
    };
    await saveGatewayPassword(betaCfg, 'beta-pass-2', throwingBridge);
    assert.equal(await resolveGatewayPassword(betaCfg, throwingBridge, 'alpha-pass'), 'beta-pass-2');

    // Deleting target gateway secret leaves primary untouched
    await deleteGatewayPassword(betaCfg, undefined);
    assert.equal(await resolveGatewayPassword(betaCfg, undefined, ''), '');
    assert.equal(await resolveGatewayPassword(alphaCfg, undefined, ''), 'alpha-pass');

    // Cross-origin fallback guard inside multiGatewayCoordinator: primary state.password must NEVER leak to secondary gateway
    const seenAuthPasswords = [];
    const coordState = makeBaseState({
      gatewayUrl: 'http://127.0.0.1:18642',
      username: 'alpha',
      password: 'alpha-only-password',
      gatewayCount: 2,
      activeFocus: { type: 'session', sessionId: 's1', gatewayId: '__default__' },
      activeGatewayId: '__default__',
      sessions: [],
    });
    const wiring = createDesktopMultiGatewayWiring({
      getState: () => coordState,
      render: () => {},
      getDesktopApi: () => ({
        authenticateGateway: async (opts) => {
          seenAuthPasswords.push([opts.url, opts.password]);
          return { ok: false, message: 'auth check captured', latency: 1 };
        },
      }),
      getFallbackHandleRegistry: () => new SessionHandleRegistry(),
      getFallbackLiveStreamRegistry: () => new LiveStreamRegistry(),
    });
    await wiring.syncConfiguredGateways({
      configs: [
        { id: '__default__', name: 'Alpha', url: 'http://127.0.0.1:18642', username: 'alpha', enabled: true, routeKind: 'direct' },
        { id: 'beta', name: 'Beta', url: 'http://127.0.0.1:18643', username: 'beta', enabled: true, routeKind: 'direct' },
      ],
      connectIds: ['__default__', 'beta'],
    });
    const alphaAuth = seenAuthPasswords.find(([u]) => u.includes('18642'));
    const betaAuth = seenAuthPasswords.find(([u]) => u.includes('18643'));
    assert.equal(alphaAuth?.[1], 'alpha-only-password');
    assert.equal(betaAuth?.[1], '');
  } finally {
    clearRuntimeGatewaySecrets();
    if (prevStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = prevStorage;
  }
});
