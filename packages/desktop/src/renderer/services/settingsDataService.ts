/**
 * Hermes Flux 设置中心业务装配与数据服务（Settings Data Service）
 *
 * 【设计意图 (Why)】
 *   将设置中心数据装载（统一提供商表、自定义端点、订阅账号）、Bot 花名册与管理快照派生、
 *   全量设置快照构造、设置中心交互动作表（SettingsActions，涵盖端点 CRUD、提供商探针/启用/退出/多 Agent 绑定开关）、
 *   网关连接测试与配置提交、以及 React 设置弹窗的挂载与指纹防抖刷新彻底从 index.ts 中解耦。
 *   使复杂的设置中心领域逻辑与 UI 调度脱离宿主 DOM，具备高内聚性、可单测性与单向依赖纯度。
 *
 * 【防范的历史坑 (Pitfall)】
 *   1. 订阅与 Auth 共享 Profile 语义：订阅是账号级来源，登录态落在共享 auth，
 *      由 share_auth 回落到首个 profile；登录、轮询、退出都必须作用于 subscriptionProfileName，
 *      否则会把令牌签进一个不参与共享的 profile，导致其他 Agent 无法使用；
 *   2. 统一提供商表原始行落盘：端点与订阅的原始行必须落进快照，供编辑表单读取 base_url / has_api_key；
 *      若用归并后的视图反推，将导致编辑弹窗无法打开或选项缺失；
 *   3. 勾选 / 取消勾选某 Agent 绑定：判定全部交给 core 的 planBindingToggle，
 *      正在使用的 Agent 不允许取消（必须先改模型），自定义端点新增必须补密钥，判定严格遵守 classifyAttachWrite；
 *   4. 端点整体删除：作用范围取 view.agents 里 active/ready 的 Agent（配置集合），
 *      配置集合不完整时严禁执行删除，防止漏删却误报成功；
 *   5. 设置快照指纹防抖：关闭态零成本早退；开启态比对 JSON 字符串指纹，
 *      避免在流式输出期间每帧序列化与重渲染整棵 50+ provider 的设置树。
 *
 * 【约束与规则 (Rules)】
 *   1. 单向依赖：严禁反向 import index.js，所有外部状态读写与 UI 渲染通过 SettingsDataDeps 注入；
 *   2. 严格类型约束：0 TS 报错，严禁使用 `as any`；
 *   3. 零文本写死：通知、错误与占位提示统一走 deps.t 国际化输出。
 */

import type { AppState } from '../state/appState.js';
import type { HermesDesktopBridge } from '../../preload/index.js';
import {
  DEFAULT_CACHE_GATEWAY_ID,
  type BotDraftState,
  type CompleteSlashResult,
  type GatewayInstanceConfig,
  type GatewayPoolHealthSummary,
  type GatewayRuntimeSlot,
  type HermesGatewayClient,
  type ProfilesConfigureParams,
  ProfileService,
  formatModelDisplayName,
  projectBotRoster,
  normalizeEndpointId,
  planBindingToggle,
  planProviderRemoval,
  draftForBindingAttach,
  classifyAttachWrite,
} from '@hermes-flux/core';
import {
  mountSettingsModal,
  type BotDetailTab,
  type SettingsSectionId,
  type SettingsSnapshot,
  type SettingsActions,
  type BotExitTarget,
  type GatewayDraft,
  type StorageWriteFailure,
  type ToggleProviderAgentResult,
  type I18nKey,
  type FontPreferences,
  type ActivityIndicatorVariant,
  type ConversationOrgPrefs,
  type SkinId,
  applyConversationWidthMode,
  resolveConversationWidthMode,
  saveConversationWidthMode,
  applyLeftRailLayout,
  resolveLeftRailLayout,
  saveLeftRailLayout,
  safeSetItem,
  setLocale,
  messageKeyForVerdict,
} from '@hermes-flux/ui';
import {
  applyGatewayDraftToState,
  reportStorageFailure,
  resolveBotRoster,
  resolveProfileAvatarFromState,
} from './settingsStorageHelpers.js';
import { createProviderAdminRest } from '../providerAdminRest.js';
import { createProviderAdminController, planDeleteTarget } from '../providerAdminController.js';
import { createSettingsController, resolveGatewayPassword } from '../settingsController.js';
import { createBotManagementController, createBotWizardController } from '../botManagementController.js';
import { loadProviderCatalog } from '../providerCatalog.js';
import { loadGatewayConfigs, saveGatewayConfigs } from '../gateway/gatewayRegistryStore.js';
import { createProjectDirectoryActions } from './projectDirectoryActions.js';
import { createMcpOAuthActions } from './mcpOAuthService.js';
import { createSettingsGatewayController } from './settingsGatewayActions.js';
import { createSettingsExtensionsActions } from './settingsExtensionsActions.js';
import type { LearningService } from './learningService.js';

export interface GatewayConnectionTestResult {
  ok: boolean;
  message?: string;
  latency?: number;
  ticket?: string;
}

export interface SettingsDataDeps {
  readonly getState: () => AppState;
  readonly getGatewayClient: () => HermesGatewayClient | null;
  readonly getClientForGateway?: (gatewayId?: string) => HermesGatewayClient | null;
  readonly getGatewaySlot?: (gatewayId?: string) => GatewayRuntimeSlot | undefined;
  readonly getGatewayUrlForGateway?: (gatewayId?: string) => string;
  readonly getTicketForGateway?: (gatewayId?: string) => string | null;
  readonly isGatewayConnected?: (gatewayId?: string) => boolean;
  readonly getHealthSummary?: () => GatewayPoolHealthSummary | undefined;
  readonly getGatewayConfigs?: () => GatewayInstanceConfig[];
  readonly saveGatewayConfigs?: (configs: readonly GatewayInstanceConfig[]) => StorageWriteFailure;
  readonly syncConfiguredGateways?: (options?: {
    configs?: readonly GatewayInstanceConfig[];
    connectIds?: readonly string[];
    disconnectIds?: readonly string[];
  }) => Promise<void>;
  readonly connectGatewayInstance?: (gatewayId: string) => Promise<boolean>;
  readonly disconnectGatewayInstance?: (gatewayId: string) => boolean;
  readonly refreshGatewaySlot?: (gatewayId: string) => Promise<void>;
  readonly getDesktopApi?: () => HermesDesktopBridge | undefined;
  readonly getCurrentTicket: () => string | null;
  readonly getEffectiveUrl: (url: string) => string;
  readonly render: () => void;
  readonly t: (key: I18nKey, params?: Record<string, string | number>) => string;
  readonly describeRpcError: (error: unknown) => string;
  readonly showToast: (message: string, durationMs?: number) => void;
  readonly bootLog: { warn(message: string, meta?: Record<string, unknown>): void };
  readonly fetchModelOptions: (options?: { clearNotice?: boolean }) => Promise<void>;
  readonly fetchProfiles: (options?: { refresh?: boolean }) => Promise<void>;
  readonly testConnection: (url: string, user: string, pass: string) => Promise<GatewayConnectionTestResult>;
  readonly connect: () => Promise<void>;
  readonly disconnect: () => void;
  readonly getFontPreferences: () => FontPreferences;
  readonly setFontPreferences: (prefs: FontPreferences) => void;
  readonly applyFontPreferences: (prefs: FontPreferences) => void;
  readonly getActivityIndicatorVariant: () => ActivityIndicatorVariant;
  readonly setActivityIndicatorVariant: (variant: ActivityIndicatorVariant) => void;
  readonly saveActivityIndicatorVariant: (variant: ActivityIndicatorVariant) => void;
  readonly resolveActivityIndicatorVariant: (variant: string) => ActivityIndicatorVariant;
  readonly resolveSkinId: (theme: string) => SkinId;
  readonly writePresenceLayout: (layout: string) => void;
  readonly onPresenceLayoutChanged: () => void;
  readonly profileAvatarCache: Map<string, string>;
  readonly persistAvatarCache: () => void;
  readonly persistAgentsToCache?: (profiles: AppState['profiles']) => void;
  readonly fetchProjects?: (gatewayId?: string) => Promise<void>;
  readonly createProject?: (
    params: { name: string; path: string },
    gatewayId?: string,
  ) => Promise<{ ok: boolean; message?: string }>;
  readonly updateProject?: (
    projectId: string,
    patch: { name?: string; path?: string; boardSlug?: string },
    gatewayId?: string,
  ) => Promise<{ ok: boolean; message?: string }>;
  readonly deleteProject?: (projectId: string, gatewayId?: string) => Promise<{ ok: boolean; message?: string }>;
  readonly onOrgPrefsChange?: (patch: Partial<ConversationOrgPrefs>) => void;
  readonly learningService?: LearningService;
}

export interface SettingsDataService {
  scopedProfileName(): string;
  subscriptionProfileName(): string;
  botRoster(): Array<{ profile: string; displayName: string; avatar?: string }>;
  reloadProviderCatalog(): Promise<void>;
  openBotSettings(botId: string, options?: { tab?: BotDetailTab; gatewayId?: string }): void;
  getBotManagementSnapshot(): SettingsSnapshot['botManagement'];
  hasUnsavedBotDrafts(): boolean;
  getSettingsSnapshot(): SettingsSnapshot;
  ensureSettingsSectionData(section: SettingsSectionId, force?: boolean): void;
  createSettingsActions(): SettingsActions;
  /** 关闭设置中心的唯一出口（含脏稿拦截）；全局快捷键与标题栏都必须走这里。 */
  requestSettingsExit(target?: BotExitTarget): void;
  syncReactSettings(): void;
  getSettingsController(): ReturnType<typeof createSettingsController>;
  getProviderAdminController(): ReturnType<typeof createProviderAdminController>;
  getBotManagementController(): ReturnType<typeof createBotManagementController>;
}

export function createSettingsDataService(deps: SettingsDataDeps): SettingsDataService {
  const profileService = new ProfileService();

  let updateReactSettings: (() => void) | null = null;
  let lastSettingsSnapshotJson = '';
  let settingsController: ReturnType<typeof createSettingsController> | null = null;
  let providerAdminController: ReturnType<typeof createProviderAdminController> | null = null;
  let botManagementController: ReturnType<typeof createBotManagementController> | null = null;

  /**
   * 宿主级脏检查与待执行离场目标。
   *
   * 【设计意图】草稿池由控制器持有，但"离场前是否确认"属于宿主导航职责：
   *   由 BOT 面板注册一个只读探针，切导航 / 关弹窗 / Esc 统一走 requestSettingsExit，
   *   命中脏稿时把目标挂起，等用户在确认框里选「保留 / 放弃 / 取消」。
   * 【规则】目标只允许一个（后一次离场请求覆盖前一次），确认后必须立即清空，
   *   否则下一次打开设置会凭空弹出上一轮的确认框。
   */
  let botDirtyGuard: (() => boolean) | null = null;
  let pendingBotExit: BotExitTarget | null = null;
  let botTabRequestSeq = 0;
  let requestedBotTab: { tab: BotDetailTab; seq: number } | null = null;

  type BindingFlightResult = ToggleProviderAgentResult & {
    confirmRequired?: boolean;
    step?: 'switch' | 'disable';
  };

  let providerCatalogGen = 0;
  let providerCatalogInFlight = false;

  const inFlightProviderBindings = new Map<
    string,
    { signature: string; promise: Promise<BindingFlightResult> }
  >();

  const botDraftsByGateway = new Map<string, Record<string, BotDraftState>>();
  const getGatewayConfigsFn = (): GatewayInstanceConfig[] =>
    deps.getGatewayConfigs ? deps.getGatewayConfigs() : loadGatewayConfigs();
  const saveGatewayConfigsFn = (configs: readonly GatewayInstanceConfig[]): StorageWriteFailure =>
    deps.saveGatewayConfigs ? deps.saveGatewayConfigs(configs) : saveGatewayConfigs(configs);

  const applyGatewayDraft = (draft: GatewayDraft): void => {
    const state = deps.getState();
    applyGatewayDraftToState(deps, state, draft, resolveGatewayPassword(draft.password, state.password));
  };

  const gatewayController = createSettingsGatewayController({
    getState: deps.getState,
    getGatewayConfigs: getGatewayConfigsFn,
    saveGatewayConfigs: saveGatewayConfigsFn,
    getGatewaySlot: deps.getGatewaySlot,
    getHealthSummary: deps.getHealthSummary,
    getDesktopApi: deps.getDesktopApi,
    testConnection: deps.testConnection,
    connect: deps.connect,
    disconnect: deps.disconnect,
    syncConfiguredGateways: deps.syncConfiguredGateways,
    connectGatewayInstance: deps.connectGatewayInstance,
    disconnectGatewayInstance: deps.disconnectGatewayInstance,
    render: deps.render,
    t: deps.t,
    bootLog: deps.bootLog,
    showToast: deps.showToast,
    runBusy: (task) => getSettingsController().runBusy(task),
    applyLegacyGatewayDraft: applyGatewayDraft,
  });

  const resolveSelectedGatewayId = (): string => gatewayController.getSelectedGatewayId();
  const resolveGatewayBucketKey = (gatewayId?: string): string => gatewayId || DEFAULT_CACHE_GATEWAY_ID;

  const isMultiGatewayConfigMode = (): boolean => {
    const state = deps.getState();
    return getGatewayConfigsFn().length >= 2 || (state.gatewayCount ?? 1) >= 2;
  };

  function resolveSettingsClient(): HermesGatewayClient | null {
    const gwId = resolveSelectedGatewayId();
    if (gwId && deps.getClientForGateway && (getGatewayConfigsFn().length >= 2 || Boolean(deps.getGatewaySlot?.(gwId)))) {
      return deps.getClientForGateway(gwId);
    }
    return deps.getGatewayClient();
  }

  function resolveSettingsGatewayUrl(): string {
    const state = deps.getState();
    const gwId = resolveSelectedGatewayId();
    if (gwId) {
      const fromSlot = deps.getGatewayUrlForGateway?.(gwId) || getGatewayConfigsFn().find((c) => c.id === gwId)?.url;
      if (fromSlot) return fromSlot;
    }
    return state.gatewayUrl;
  }

  function resolveSettingsTicket(): string {
    const gwId = resolveSelectedGatewayId();
    if (gwId && deps.getTicketForGateway && getGatewayConfigsFn().length >= 2) {
      return deps.getTicketForGateway(gwId) ?? '';
    }
    return deps.getCurrentTicket() ?? '';
  }

  function isSettingsGatewayConnected(): boolean {
    const state = deps.getState();
    const gwId = resolveSelectedGatewayId();
    if (gwId && deps.isGatewayConnected && getGatewayConfigsFn().length >= 2) {
      return deps.isGatewayConnected(gwId);
    }
    if (gwId && getGatewayConfigsFn().length >= 2 && deps.getGatewaySlot?.(gwId)) {
      return Boolean(deps.getGatewaySlot(gwId)?.connected);
    }
    return Boolean(resolveSettingsClient()) && state.gatewayConnected;
  }

  const resolveProfileAvatar = (botId: string): string | undefined =>
    resolveProfileAvatarFromState(deps.getState(), deps.profileAvatarCache, botId);

  const scopedProfileName = (): string => {
    const state = deps.getState();
    const roster = botRoster();
    const scoped = state.settingsScopedProfile;
    if (scoped && (!isMultiGatewayConfigMode() || roster.some((b) => b.profile === scoped))) {
      return scoped;
    }
    if (!isMultiGatewayConfigMode() && state.profileName) {
      return state.profileName;
    }
    if (state.profileName && roster.some((b) => b.profile === state.profileName)) {
      return state.profileName;
    }
    return roster[0]?.profile || gatewayController.getProfileNameForGateway(resolveSelectedGatewayId());
  };

  const botRoster = () => {
    const state = deps.getState();
    if (!isMultiGatewayConfigMode()) {
      return resolveBotRoster(state);
    }
    const gwId = resolveSelectedGatewayId();
    const scopedProfiles = state.profiles.filter((item) => !gwId || item.gatewayId === gwId);
    if (scopedProfiles.length > 0) {
      return scopedProfiles.map((profile) => ({
        profile: profile.name,
        displayName: profile.displayName || profile.name,
        avatar: profile.avatar,
      }));
    }
    if (state.settingsProfiles.status === 'ready' && state.settingsProfiles.data.length > 0) {
      return state.settingsProfiles.data.map((row) => ({
        profile: row.name,
        displayName: row.displayName || row.name,
        avatar: row.avatar,
      }));
    }
    const fallbackProfile = gatewayController.getProfileNameForGateway(gwId);
    return [{ profile: fallbackProfile, displayName: fallbackProfile }];
  };

  function subscriptionProfileName(): string {
    return botRoster()[0]?.profile || deps.getState().profileName || 'default';
  }

  function syncLocale(): void {
    const state = deps.getState();
    setLocale(state.lang === 'en' ? 'en-US' : 'zh-CN');
  }

  function getProviderAdminController(): ReturnType<typeof createProviderAdminController> {
    if (providerAdminController) return providerAdminController;
    const desktopApi = deps.getDesktopApi?.();
    const rest = createProviderAdminRest({
      baseUrl: () => deps.getEffectiveUrl(resolveSettingsGatewayUrl()),
      ticket: () => resolveSettingsTicket(),
      proxy: (options) => {
        if (!desktopApi?.httpProxy) throw new Error('Desktop REST proxy is unavailable');
        return desktopApi.httpProxy(options);
      },
    });
    providerAdminController = createProviderAdminController({
      rest,
      render: () => deps.render(),
      describeError: (error) => deps.describeRpcError(error),
      getEndpoints: () => deps.getState().settingsCustomEndpoints,
      setEndpoints: (value) => { deps.getState().settingsCustomEndpoints = value; },
      getOauth: () => deps.getState().settingsSubscriptionCatalog,
      setOauth: (value) => { deps.getState().settingsSubscriptionCatalog = value; },
      setBusy: (busy) => { deps.getState().settingsProviderAdminBusy = busy; },
      notify: (message) => deps.showToast(message),
      warn: (message, meta) => deps.bootLog.warn(message, typeof meta === 'object' && meta ? meta as Record<string, unknown> : undefined),
      onCatalogChanged: () => { void deps.fetchModelOptions({ clearNotice: false }); },
    });
    return providerAdminController;
  }

  async function reloadProviderCatalog(): Promise<void> {
    const state = deps.getState();
    const requestGwId = resolveSelectedGatewayId();
    const agents = botRoster();
    const gen = ++providerCatalogGen;
    providerCatalogInFlight = true;
    try {
      if (state.settingsProviderViews.status !== 'ready') {
        state.settingsProviderViews = { status: 'loading' };
        deps.render();
      }
      const desktopApi = deps.getDesktopApi?.();
      const rest = createProviderAdminRest({
        baseUrl: () => deps.getEffectiveUrl(resolveSettingsGatewayUrl()),
        ticket: () => resolveSettingsTicket(),
        proxy: (options) => {
          if (!desktopApi?.httpProxy) throw new Error('Desktop REST proxy is unavailable');
          return desktopApi.httpProxy(options);
        },
      });
      const gatewayClient = resolveSettingsClient();
      const result = await loadProviderCatalog({
        agents,
        rest,
        rpc: {
          call: <T,>(method: string, params?: Record<string, unknown>) => {
            if (!gatewayClient) return Promise.reject(new Error(deps.t('settings.notConnected'))) as Promise<T>;
            return gatewayClient.call<T>(method, params);
          },
        },
        describeError: (error) => deps.describeRpcError(error),
      });
      if (gen !== providerCatalogGen || requestGwId !== resolveSelectedGatewayId()) return;
      state.settingsProviderViews = { status: 'ready', data: result.views };
      state.settingsProviderFailures = result.failed;
      state.settingsCustomEndpoints = { status: 'ready', data: result.endpoints.map((entry) => entry.row) };
      state.settingsEndpointProfiles = Object.fromEntries(
        result.endpoints.map((entry) => [normalizeEndpointId(entry.row.id), [...entry.profiles]]),
      );
      state.settingsEndpointFailures = result.endpointFailures;
      state.settingsSubscriptionCatalog = result.subscriptionsOk
        ? { status: 'ready', data: result.subscriptions }
        : { status: 'error', message: result.subscriptionsError || deps.t('settings.loadFailed') };
    } catch (error) {
      if (gen !== providerCatalogGen || requestGwId !== resolveSelectedGatewayId()) return;
      state.settingsProviderViews = { status: 'error', message: deps.describeRpcError(error) };
      state.settingsProviderFailures = [];
      state.settingsCustomEndpoints = { status: 'error', message: deps.describeRpcError(error) };
      state.settingsEndpointProfiles = {};
      state.settingsEndpointFailures = [];
      state.settingsSubscriptionCatalog = { status: 'error', message: deps.describeRpcError(error) };
    } finally {
      if (gen === providerCatalogGen) providerCatalogInFlight = false;
    }
    deps.render();
  }

  function getSettingsController(): ReturnType<typeof createSettingsController> {
    if (settingsController) return settingsController;
    const state = deps.getState();
    settingsController = createSettingsController({
      isConnected: () => isSettingsGatewayConnected(),
      profileName: () => gatewayController.getProfileNameForGateway(resolveSelectedGatewayId()),
      call: <T,>(method: string, params?: Record<string, unknown>) => {
        const client = resolveSettingsClient();
        if (!client) return Promise.reject(new Error(deps.t('settings.loadFailed'))) as Promise<T>;
        return client.call<T>(method, params);
      },
      render: () => deps.render(),
      translate: (key) => deps.t(key),
      describeError: (error) => deps.describeRpcError(error),
      getProfiles: () => state.settingsProfiles,
      setProfiles: (value) => { state.settingsProfiles = value; },
      getMcp: () => state.settingsMcp,
      setMcp: (value) => { state.settingsMcp = value; },
      getSkills: () => state.settingsSkills,
      setSkills: (value) => { state.settingsSkills = value; },
      setBusy: (busy) => { state.settingsBusy = busy; },
      onCatalogChanged: () => { void deps.fetchModelOptions({ clearNotice: false }); },
      notify: (message) => deps.showToast(message),
      warn: (message, meta) => deps.bootLog.warn(message, typeof meta === 'object' && meta ? meta as Record<string, unknown> : undefined),
    });
    return settingsController;
  }

  function getBotManagementController(): ReturnType<typeof createBotManagementController> {
    if (botManagementController) return botManagementController;
    const state = deps.getState();

    botManagementController = createBotManagementController({
      isConnected: () => isSettingsGatewayConnected(),
      loadProfiles: () => getSettingsController().loadProfiles(),
      getProfiles: () => state.settingsProfiles,
      getState: () => ({
        status: state.botManagementStatus,
        activeBotId: state.botManagementActiveBotId,
        activeDetail: state.botManagementDetail,
        drafts: state.botDrafts,
        errorBanner: state.botManagementError,
        confirmPending: state.botManagementConfirm,
        isBusy: state.botManagementBusy,
      }),
      setState: (patch) => {
        if (patch.status !== undefined) state.botManagementStatus = patch.status;
        if (patch.activeBotId !== undefined) state.botManagementActiveBotId = patch.activeBotId;
        if ('activeDetail' in patch) state.botManagementDetail = patch.activeDetail;
        if (patch.drafts !== undefined) {
          state.botDrafts = patch.drafts;
          botDraftsByGateway.set(resolveGatewayBucketKey(resolveSelectedGatewayId()), patch.drafts);
        }
        if ('errorBanner' in patch) state.botManagementError = patch.errorBanner;
        if ('confirmPending' in patch) state.botManagementConfirm = patch.confirmPending;
        if (patch.isBusy !== undefined) state.botManagementBusy = patch.isBusy;
      },
      describeBot: (botId, hint) => {
        const client = resolveSettingsClient();
        if (!client) return Promise.reject(new Error(deps.t('settings.notConnected')));
        const resolvedAvatar = resolveProfileAvatar(botId) || hint.avatar;
        return profileService.describeBot(
          botId,
          client,
          resolvedAvatar ? { ...hint, avatar: resolvedAvatar } : hint,
        );
      },
      fetchSkillInventory: async (botId) => {
        const client = resolveSettingsClient();
        if (!client) return null;
        try {
          const result = await client.request<{ skills?: Record<string, string[]> | null }>(
            'skills.manage',
            { profile: botId, action: 'list' },
          );
          const groups = result?.skills;
          if (!groups || typeof groups !== 'object') return null;
          const names: string[] = [];
          for (const value of Object.values(groups)) {
            if (!Array.isArray(value)) continue;
            for (const name of value) if (typeof name === 'string' && name) names.push(name);
          }
          return names;
        // gate-degrade: 技能目录读取失败只影响非权威清单的补全展示，界面会显示"清单读取不完整"；不阻塞 BOT 详情，也不伪装成空目录。
        } catch {
          return null;
        }
      },
      fetchSkillDescriptions: async (botId) => {
        const client = resolveSettingsClient();
        if (!client) return null;
        try {
          const result = await client.request<CompleteSlashResult>('complete.slash', {
            text: '/',
            profile: botId,
          });
          if (!Array.isArray(result?.items)) return null;
          const map: Record<string, string> = {};
          let count = 0;
          for (const item of result.items) {
            if (item?.kind !== 'skill' || typeof item.text !== 'string' || typeof item.meta !== 'string') continue;
            const key = item.text.replace(/^\/+/, '').trim();
            const desc = item.meta.trim();
            if (!key || !desc) continue;
            map[key] = desc;
            count += 1;
          }
          return count > 0 ? map : null;
        // gate-degrade: 技能简介补全失败只影响副标题展示，不阻塞技能开关清单与启用态管理。
        } catch {
          return null;
        }
      },
      fetchMcpStatus: async (botId) => {
        const client = resolveSettingsClient();
        if (!client) return null;
        try {
          const result = await client.request<{
            servers?: Array<{ name?: string; connected?: boolean; transport?: string; tools?: number }>;
          }>('mcp.servers.status', { profile: botId });
          if (!Array.isArray(result?.servers)) return null;
          return result.servers
            .filter((row) => typeof row?.name === 'string' && row.name)
            .map((row) => ({
              name: row.name as string,
              connected: row.connected === true,
              transport: typeof row.transport === 'string' ? row.transport : undefined,
              toolCount: typeof row.tools === 'number' ? row.tools : undefined,
            }));
        // gate-degrade: 探活失败等价于"状态未知"（online 保持 undefined），界面不得画红灯；已有清单照常展示。
        } catch {
          return null;
        }
      },
      configureBot: (params: ProfilesConfigureParams) => {
        const client = resolveSettingsClient();
        if (!client) return Promise.reject(new Error(deps.t('settings.notConnected')));
        return profileService.configureBot(params, client);
      },
      setAsset: (botId, dataUrl, clear) => {
        const client = resolveSettingsClient();
        if (!client) return Promise.reject(new Error(deps.t('settings.notConnected')));
        return profileService.setAsset(botId, 'avatar', dataUrl, client, { clear });
      },
      render: () => deps.render(),
      translate: (key) => deps.t(key),
      describeError: (error) => deps.describeRpcError(error),
      notify: (message) => deps.showToast(message),
      onProfilesChanged: () => {
        void deps.fetchProfiles();
        void reloadProviderCatalog();
      },
      onAvatarChanged: (botId, dataUrl) => {
        const syncCacheKey = (rawKey?: string): void => {
          if (!rawKey) return;
          const normalized = rawKey.toLowerCase();
          if (dataUrl) deps.profileAvatarCache.set(normalized, dataUrl);
          else deps.profileAvatarCache.delete(normalized);
        };

        syncCacheKey(botId);
        const profile = state.profiles.find((item) => item.name === botId);
        if (profile) {
          profile.avatar = dataUrl;
          profile.hasAvatar = Boolean(dataUrl);
          syncCacheKey(profile.displayName);
        }
        const settingsRow =
          state.settingsProfiles.status === 'ready'
            ? state.settingsProfiles.data.find((row) => row.name === botId)
            : undefined;
        syncCacheKey(settingsRow?.displayName);
        if (state.botManagementDetail?.id === botId) {
          syncCacheKey(state.botManagementDetail.displayName);
          state.botManagementDetail = { ...state.botManagementDetail, avatar: dataUrl };
        }
        if (state.settingsProfiles.status === 'ready') {
          state.settingsProfiles = {
            status: 'ready',
            data: state.settingsProfiles.data.map((row) =>
              row.name === botId ? { ...row, avatar: dataUrl, hasAvatar: Boolean(dataUrl) } : row,
            ),
          };
        }
        for (const session of state.sessions) {
          if (session.botName === botId) session.botAvatar = dataUrl;
        }
        deps.persistAvatarCache();
        deps.persistAgentsToCache?.(state.profiles);
      },
      schedule: (fn, ms) => {
        const timer = setTimeout(fn, ms);
        return () => clearTimeout(timer);
      },
    });
    return botManagementController;
  }

  const botWizardController = createBotWizardController({
    isConnected: () => isSettingsGatewayConnected(),
    getDefaultCloneFrom: () => {
      const st = deps.getState();
      return (
        st.botManagementActiveBotId ||
        (isMultiGatewayConfigMode() ? botRoster()[0]?.profile : st.profiles[0]?.name) ||
        'default'
      );
    },
    getExistingBotIds: () =>
      isMultiGatewayConfigMode()
        ? botRoster().map((p) => p.profile)
        : deps.getState().profiles.map((p) => p.name),
    createProfile: (params) => {
      const client = resolveSettingsClient();
      if (!client) throw new Error(deps.t('settings.notConnected'));
      return profileService.createProfile(params, client);
    },
    configureDisplayName: async (botId, displayName) => {
      const client = resolveSettingsClient();
      return client ? profileService.configureProfile(botId, { displayName }, client) : false;
    },
    onCreated: async (botId) => {
      const gwId = resolveSelectedGatewayId();
      if (gwId && deps.refreshGatewaySlot) {
        await deps.refreshGatewaySlot(gwId);
      } else {
        await deps.fetchProfiles({ refresh: true });
      }
      await getBotManagementController().loadRoster(true);
      getBotManagementController().selectBot(botId, { immediate: true });
    },
    render: deps.render,
    notify: (msg) => deps.showToast(msg),
    translate: (key) => deps.t(key),
    describeError: deps.describeRpcError,
  });

  function applySettingsGatewaySwitch(nextGatewayId: string): void {
    const state = deps.getState();
    const prevKey = resolveGatewayBucketKey(state.settingsGatewayId);
    if (Object.keys(state.botDrafts).length > 0) {
      botDraftsByGateway.set(prevKey, state.botDrafts);
    } else {
      botDraftsByGateway.delete(prevKey);
    }
    state.settingsGatewayId = nextGatewayId;
    const nextKey = resolveGatewayBucketKey(nextGatewayId);
    state.botDrafts = botDraftsByGateway.get(nextKey) ?? {};
    providerCatalogGen += 1;
    providerCatalogInFlight = false;
    state.settingsScopedProfile = '';
    state.settingsProjects = { status: 'idle' };
    state.settingsProfiles = { status: 'idle' };
    state.settingsProviderViews = { status: 'idle' };
    state.settingsProviderFailures = [];
    state.settingsCustomEndpoints = { status: 'idle' };
    state.settingsEndpointProfiles = {};
    state.settingsEndpointFailures = [];
    state.settingsSubscriptionCatalog = { status: 'idle' };
    state.settingsMcp = { status: 'idle' };
    state.settingsSkills = { status: 'idle' };
    state.botManagementStatus = { status: 'uninitialized' };
    state.botManagementActiveBotId = '';
    state.botManagementDetail = undefined;
    state.botManagementError = undefined;
    state.botManagementConfirm = undefined;
    state.learningState = { status: 'idle' };
    state.learningDetail = { status: 'idle' };
    lastSettingsSnapshotJson = '';
    ensureSettingsSectionData(state.settingsSection, true);
  }

  function requestSettingsExit(target: BotExitTarget = { kind: 'close' }): void {
    const state = deps.getState();
    if (state.settingsSection === 'agents' && hasUnsavedBotDrafts()) {
      pendingBotExit = target;
      deps.render();
      return;
    }
    performSettingsExit(target);
  }

  function hasUnsavedBotDrafts(): boolean {
    const state = deps.getState();
    if (botDirtyGuard?.() === true || Object.keys(state.botDrafts).length > 0) return true;
    for (const drafts of botDraftsByGateway.values()) {
      if (Object.keys(drafts).length > 0) return true;
    }
    return false;
  }

  function performSettingsExit(target: BotExitTarget): void {
    const state = deps.getState();
    pendingBotExit = null;
    if (target.kind === 'close') {
      state.isSettingsOpen = false;
      requestedBotTab = null;
    } else if (target.kind === 'gateway') {
      applySettingsGatewaySwitch(target.gatewayId);
    } else {
      state.settingsSection = target.section;
      ensureSettingsSectionData(target.section);
    }
    deps.render();
  }

  function openBotSettings(botId: string, options?: { tab?: BotDetailTab; gatewayId?: string }): void {
    const state = deps.getState();
    pendingBotExit = null;
    state.isSettingsOpen = true;
    state.settingsSection = 'agents';
    if (options?.gatewayId && options.gatewayId !== resolveSelectedGatewayId()) {
      applySettingsGatewaySwitch(options.gatewayId);
    }
    state.botManagementActiveBotId = botId;
    if (options?.tab) {
      botTabRequestSeq += 1;
      requestedBotTab = { tab: options.tab, seq: botTabRequestSeq };
    } else {
      requestedBotTab = null;
    }
    const status = state.botManagementStatus.status;
    ensureSettingsSectionData('agents');
    if (status !== 'uninitialized' && status !== 'fetching_list') {
      getBotManagementController().selectBot(botId, { immediate: true });
    }
    if (options?.tab === 'constellation') {
      const targetGw = isMultiGatewayConfigMode() ? resolveSelectedGatewayId() : '';
      void deps.learningService?.loadLearningGraph({
        profile: botId || state.profileName || 'default',
        ...(targetGw ? { gatewayId: targetGw } : {}),
        force: false,
      });
    }
    deps.render();
  }

  function getBotManagementSnapshot(): SettingsSnapshot['botManagement'] {
    const state = deps.getState();
    const roster: SettingsSnapshot['botManagement']['roster'] =
      state.settingsProfiles.status === 'ready'
        ? projectBotRoster(
            state.settingsProfiles.data.map((row) => ({
              name: row.name,
              displayName: row.displayName,
              model: row.model || state.profiles.find((item) => item.name === row.name)?.model || '',
              avatar: resolveProfileAvatar(row.name),
              isDefault: row.isDefault,
            })),
            state.botDrafts,
          )
        : [];

    const availableModels: SettingsSnapshot['botManagement']['availableModels'] = [];
    const seenModels = new Set<string>();
    if (state.settingsProviderViews.status === 'ready') {
      for (const view of state.settingsProviderViews.data) {
        if (view.availability !== 'active' && view.availability !== 'ready') continue;
        for (const modelId of view.models) {
          const key = `${view.id}\u0000${modelId}`;
          if (seenModels.has(key)) continue;
          seenModels.add(key);
          availableModels.push({
            id: modelId,
            name: formatModelDisplayName(modelId, view.name),
            provider: view.id,
            providerName: view.name,
          });
        }
      }
    }

    const detailAvatar = state.botManagementDetail
      ? resolveProfileAvatar(state.botManagementDetail.id) || state.botManagementDetail.avatar
      : undefined;

    return {
      status: state.botManagementStatus,
      roster,
      activeBotId: state.botManagementActiveBotId,
      activeDetail: state.botManagementDetail
        ? { ...state.botManagementDetail, avatar: detailAvatar }
        : undefined,
      availableModels,
      activeDraft: state.botManagementActiveBotId
        ? state.botDrafts[state.botManagementActiveBotId]
        : undefined,
      wizard: botWizardController.getState(),
      exitPrompt: pendingBotExit ? { target: pendingBotExit } : null,
      errorBanner: state.botManagementError,
      confirmPending: state.botManagementConfirm,
      highlightBotId: undefined,
      isBusy: state.botManagementBusy,
      requestedTab: requestedBotTab,
    };
  }

  function getSettingsSnapshot(): SettingsSnapshot {
    const state = deps.getState();
    if (!state.isSettingsOpen) pendingBotExit = null;
    const gateways = gatewayController.getItems();
    const selectedGatewayId = resolveSelectedGatewayId();
    const selectedGw = gateways.find((gw) => gw.id === selectedGatewayId) ?? gateways[0];
    const gatewayView =
      selectedGw && gateways.length >= 2
        ? {
            url: selectedGw.url,
            username: selectedGw.username || '',
            hasStoredPassword: Boolean(selectedGw.hasStoredPassword),
            profileName: selectedGw.profileName || botRoster()[0]?.profile || state.profileName,
            status: (
              selectedGw.status === 'connected'
                ? 'connected'
                : selectedGw.status === 'connecting'
                  ? 'connecting'
                  : 'disconnected'
            ) as 'connected' | 'connecting' | 'disconnected',
            latencyMs: selectedGw.latencyMs ?? 0,
            test: state.testStatus,
          }
        : {
            url: state.gatewayUrl,
            username: state.username,
            hasStoredPassword: Boolean(state.password),
            profileName: state.profileName,
            status: (
              state.gatewayConnected ? 'connected' : state.gatewayConnecting ? 'connecting' : 'disconnected'
            ) as 'connected' | 'connecting' | 'disconnected',
            latencyMs: state.gatewayLatencyMs,
            test: state.testStatus,
          };
    return {
      isOpen: state.isSettingsOpen,
      section: state.settingsSection,
      ...(gateways.length > 0 ? { gateways } : {}),
      ...(selectedGatewayId ? { selectedGatewayId } : {}),
      theme: state.theme,
      locale: state.lang === 'en' ? 'en' : 'zh',
      fontPrefs: deps.getFontPreferences(),
      activityVariant: deps.getActivityIndicatorVariant(),
      conversationWidth: state.conversationWidth,
      leftRailLayout: state.leftRailLayout,
      orgPrefs: state.orgPrefs,
      projects: state.settingsProjects,
      profiles: state.settingsProfiles,
      bots: botRoster(),
      botManagement: getBotManagementSnapshot(),
      learningState: state.learningState,
      learningDetail: state.learningDetail,
      scopedProfile: scopedProfileName(),
      providerViews: state.settingsProviderViews,
      providerFailures: state.settingsProviderFailures,
      subscriptionCatalog: state.settingsSubscriptionCatalog,
      customEndpoints: state.settingsCustomEndpoints,
      endpointProfiles: state.settingsEndpointProfiles,
      endpointFailures: state.settingsEndpointFailures,
      providerAdminBusy: state.settingsProviderAdminBusy,
      mcp: state.settingsMcp,
      skills: state.settingsSkills,
      gateway: gatewayView,
      appVersion: state.appVersion,
      platform: state.platform,
      busy: state.settingsBusy,
      presenceLayout: state.presenceLayout,
    };
  }

  function ensureSettingsSectionData(section: SettingsSectionId, force = false): void {
    const state = deps.getState();
    const gwId = resolveSelectedGatewayId() || undefined;
    if (section === 'projects') {
      if (force || state.settingsProjects.status === 'idle') void deps.fetchProjects?.(gwId);
      return;
    }
    if (section === 'agents') {
      getBotManagementController().ensureLoaded(force);
      if (force || state.settingsProviderViews.status === 'idle') {
        void reloadProviderCatalog();
      }
      return;
    }
    getSettingsController().ensureSection(section, force);
    if (section !== 'providers') return;
    if (force || state.profiles.length === 0 || (isMultiGatewayConfigMode() && state.settingsProfiles.status !== 'ready')) {
      void getSettingsController().loadProfiles();
    }
    if (force || (!providerCatalogInFlight && state.settingsProviderViews.status !== 'loading')) {
      void reloadProviderCatalog();
    }
  }

  function createSettingsActions(): SettingsActions {
    const state = deps.getState();
    return {
      onClose: () => {
        requestSettingsExit({ kind: 'close' });
      },
      onSelectSection: (section) => {
        if (deps.getState().settingsSection === section) return;
        requestSettingsExit({ kind: 'section', section });
      },
      onSelectSettingsGateway: (gatewayId) => {
        if (gatewayId === resolveSelectedGatewayId()) return;
        requestSettingsExit({ kind: 'gateway', gatewayId });
      },
      onThemeChange: (theme) => {
        state.theme = deps.resolveSkinId(theme);
        // 主题已在内存生效：写盘失败只影响下次启动的记忆，必须继续 render（P-032）。
        const primary = safeSetItem('hermes_flux_theme', state.theme);
        const legacy = safeSetItem('hermes_aura_theme', state.theme);
        reportStorageFailure(deps, 'theme', primary.ok ? legacy : primary);
        deps.render();
      },
      onPresenceLayoutChange: (layout) => {
        state.presenceLayout = layout === 'dock' ? 'dock' : 'stage';
        deps.writePresenceLayout(state.presenceLayout);
        deps.onPresenceLayoutChanged();
        deps.render();
      },
      onLocaleChange: (locale) => {
        state.lang = locale === 'en' ? 'en' : 'zh';
        // 语言已在内存生效：写盘失败只影响下次启动的记忆，必须继续 syncLocale + render（P-032）。
        reportStorageFailure(deps, 'locale', safeSetItem('hermes_flux_lang', state.lang));
        syncLocale();
        deps.render();
      },
      onFontPrefsChange: (prefs) => {
        deps.setFontPreferences(prefs);
        deps.applyFontPreferences(prefs);
        deps.render();
      },
      onActivityVariantChange: (variant) => {
        const activityIndicatorVariant = deps.resolveActivityIndicatorVariant(variant);
        deps.saveActivityIndicatorVariant(activityIndicatorVariant);
        deps.setActivityIndicatorVariant(activityIndicatorVariant);
        deps.render();
      },
      onConversationWidthChange: (width) => {
        const nextWidth = resolveConversationWidthMode(width);
        state.conversationWidth = nextWidth;
        saveConversationWidthMode(nextWidth);
        applyConversationWidthMode(nextWidth);
        deps.render();
      },
      onLeftRailLayoutChange: (layout) => {
        const nextLayout = resolveLeftRailLayout(layout);
        state.leftRailLayout = nextLayout;
        saveLeftRailLayout(nextLayout);
        applyLeftRailLayout(nextLayout);
        deps.render();
      },
      onConversationOrgPrefsChange: (patch) => deps.onOrgPrefsChange?.(patch),
      onRefreshProjects: () => { void deps.fetchProjects?.(resolveSelectedGatewayId() || undefined); },
      onCreateProject: deps.createProject ? (p) => deps.createProject!(p, resolveSelectedGatewayId() || undefined) : undefined,
      onUpdateProject: deps.updateProject ? (id, patch) => deps.updateProject!(id, patch, resolveSelectedGatewayId() || undefined) : undefined,
      onDeleteProject: deps.deleteProject ? (id) => deps.deleteProject!(id, resolveSelectedGatewayId() || undefined) : undefined,
      ...createProjectDirectoryActions({
        getState: deps.getState,
        getGatewayClient: resolveSettingsClient,
        getGatewayUrl: resolveSettingsGatewayUrl,
        isGatewayConnected: isSettingsGatewayConnected,
        getDesktopApi: deps.getDesktopApi,
        getEffectiveUrl: deps.getEffectiveUrl,
      }),
      onRefreshProfiles: () => { void getBotManagementController().loadRoster(true); },
      onScopeProfileChange: (profile) => {
        state.settingsScopedProfile = profile;
        deps.render();
      },
      onReloadProviders: () => {
        void reloadProviderCatalog();
      },
      onProbeEndpoint: (draft) => getProviderAdminController().probe(draft),
      onSaveEndpoint: async (draft, options) => {
        const targets = options.targetProfiles?.filter(Boolean) ?? [];
        const primary = targets[0] ?? scopedProfileName();
        const fanOutTo = targets.length > 0 ? targets.slice(1) : options.fanOutTo;
        const outcome = await getProviderAdminController().save(primary, draft, {
          fanOutTo,
          makeDefault: options.makeDefault,
          profileDisplayNames: Object.fromEntries(botRoster().map((bot) => [bot.profile, bot.displayName])),
        });
        if (outcome.currentOk === false) return { ok: false, message: outcome.current.message || deps.t('settings.saveFailed') };
        void reloadProviderCatalog();
        return { ok: true, fanOut: [outcome.current, ...outcome.fanOut] };
      },
      onActivateProvider: async (providerId, model, confirmExpensive) => {
        const controller = getProviderAdminController();
        const profile = scopedProfileName();
        const view = state.settingsProviderViews.status === 'ready'
          ? state.settingsProviderViews.data.find((item) => item.id === providerId)
          : undefined;
        const result = await controller.useMainModel(profile, {
          provider: providerId,
          model,
          baseUrl: view?.kind === 'custom' ? view.detail : undefined,
          confirmExpensive,
        });
        if (result.ok) {
          deps.showToast(deps.t('settings.providerUsed', { name: view?.name || providerId }));
          void reloadProviderCatalog();
        }
        return result;
      },
      onLogoutProvider: (providerId) =>
        new Promise((resolve) => {
          const controller = getProviderAdminController();
          const profileAtOpen = subscriptionProfileName();
          const target = planDeleteTarget(
            profileAtOpen,
            botRoster().find((bot) => bot.profile === profileAtOpen)?.displayName ?? profileAtOpen,
          );
          const view = state.settingsProviderViews.status === 'ready'
            ? state.settingsProviderViews.data.find((item) => item.id === providerId)
            : undefined;
          if (view?.manualHint) {
            state.confirmModal = {
              title: deps.t('settings.logoutConfirmTitle'),
              message: deps.t('settings.logoutManual', { command: view.manualHint }),
              confirmLabel: deps.t('settings.close'),
              cancelLabel: deps.t('settings.cancel'),
              isDanger: false,
              onConfirm: async () => resolve({ ok: false, cancelled: true }),
              onCancel: () => resolve({ ok: false, cancelled: true }),
            };
            deps.render();
            return;
          }
          state.confirmModal = {
            title: deps.t('settings.logoutConfirmTitle'),
            message: deps.t('settings.logoutConfirmMessage', { bot: target.displayName, name: view?.name || providerId }),
            confirmLabel: deps.t('settings.providerLogout'),
            cancelLabel: deps.t('settings.cancel'),
            isDanger: true,
            onConfirm: async () => {
              const result = await controller.logoutOauth(target.profile, providerId);
              if (result.ok) {
                deps.showToast(deps.t('settings.logoutDone', { name: view?.name || providerId }));
                void reloadProviderCatalog();
              }
              resolve(result);
            },
            onCancel: () => resolve({ ok: false, cancelled: true }),
          };
          deps.render();
        }),
      onStartLogin: (providerId) => getProviderAdminController().startLogin(subscriptionProfileName(), providerId),
      onPollLogin: (providerId, sessionId) =>
        getProviderAdminController().pollLogin(subscriptionProfileName(), providerId, sessionId),
      onCancelLogin: (sessionId) => getProviderAdminController().cancelLogin(subscriptionProfileName(), sessionId),
      onCopy: async (text) => {
        try {
          if (typeof navigator !== 'undefined' && navigator.clipboard) {
            await navigator.clipboard.writeText(text);
            return true;
          }
          return false;
        } catch (error) {
          deps.bootLog.warn('clipboard write failed', { error: deps.describeRpcError(error) });
          return false;
        }
      },
      onDeleteEndpoint: (id) =>
        new Promise((resolve) => {
          const controller = getProviderAdminController();
          const targetId = normalizeEndpointId(id);
          const view = state.settingsProviderViews.status === 'ready'
            ? state.settingsProviderViews.data.find((item) => normalizeEndpointId(item.id) === targetId)
            : undefined;
          if (!view) {
            deps.showToast(deps.t('settings.providerDeleteUnknown'));
            resolve({ ok: false, message: deps.t('settings.providerDeleteUnknown') });
            return;
          }

          if (state.settingsEndpointFailures.length > 0) {
            const names = state.settingsEndpointFailures.map((item) => item.displayName).join('、');
            deps.showToast(deps.t('settings.providerDeleteScopeIncomplete', { agents: names }));
            resolve({ ok: false, message: deps.t('settings.providerDeleteScopeIncomplete', { agents: names }) });
            return;
          }

          const plan = planProviderRemoval(view, state.settingsEndpointProfiles[targetId] ?? []);

          if (plan.kind === 'blocked-in-use') {
            const names = plan.agents
              .map((agent) => (agent.model ? `${agent.displayName}（${agent.model}）` : agent.displayName))
              .join('、');
            state.confirmModal = {
              title: deps.t('settings.providerDeleteBlockedTitle'),
              message: deps.t('settings.providerDeleteBlocked', { name: view.name, agents: names }),
              confirmLabel: deps.t('settings.close'),
              cancelLabel: deps.t('settings.cancel'),
              isDanger: false,
              onConfirm: async () => resolve({ ok: false, message: deps.t('settings.providerDeleteBlockedShort') }),
              onCancel: () => resolve({ ok: false, cancelled: true }),
            };
            deps.render();
            return;
          }

          if (plan.kind === 'empty') {
            deps.showToast(deps.t('settings.providerDeleteInconsistent'));
            resolve({ ok: false, message: deps.t('settings.providerDeleteInconsistent') });
            return;
          }

          const names = plan.profiles.map(
            (profile) => botRoster().find((bot) => bot.profile === profile)?.displayName || profile,
          );
          state.confirmModal = {
            title: deps.t('settings.providerDelete'),
            message: deps.t('settings.providerDeleteConfirm', { name: view.name, agents: names.join('、') }),
            confirmLabel: deps.t('settings.providerDelete'),
            cancelLabel: deps.t('settings.cancel'),
            isDanger: true,
            onConfirm: async () => {
              const result = await controller.remove(plan.profiles, view.id);
              if (result.ok) {
                deps.showToast(deps.t('settings.providerDeleted', { name: view.name }));
                void reloadProviderCatalog();
                resolve(result);
                return;
              }
              const detail = result.failed
                .map((item) => `${item.displayName}：${item.message || ''}`)
                .join('；');
              const message = result.failed.length > 0
                ? deps.t('settings.providerDeletePartial', { detail })
                : result.message || deps.t('settings.providerToggleFailed');
              void reloadProviderCatalog();
              resolve({ ok: false, message });
            },
            onCancel: () => resolve({ ok: false, cancelled: true }),
          };
          deps.render();
        }),
      onToggleProviderAgent: async (providerId, profile, nextChecked, apiKey) => {
        const controller = getProviderAdminController();
        const targetId = normalizeEndpointId(providerId);
        const view = state.settingsProviderViews.status === 'ready'
          ? state.settingsProviderViews.data.find((item) => normalizeEndpointId(item.id) === targetId)
          : undefined;
        if (!view) return { ok: false, message: deps.t('settings.providerDeleteUnknown') };

        const botDisplayName = botRoster().find((item) => item.profile === profile)?.displayName || profile;
        const plan = planBindingToggle(view, profile, nextChecked);
        switch (plan.kind) {
          case 'noop':
            return { ok: true };
          case 'unknown-profile':
            return { ok: false, message: deps.t('settings.providerToggleUnknownProfile', { profile: botDisplayName }) };
          case 'blocked-active':
            return { ok: false, message: deps.t('settings.providerToggleBlockedActive', { profile: botDisplayName }) };
          case 'blocked-error':
            return {
              ok: false,
              message: plan.message || deps.t('settings.providerToggleBlockedError', { profile: botDisplayName }),
            };
          case 'login-required':
            return { ok: false, message: deps.t('settings.providerToggleLoginRequired', { profile: botDisplayName }) };
          default:
            break;
        }

        const flightKey = `${targetId}\u0000${profile}`;
        const signature = plan.kind;
        const existing = inFlightProviderBindings.get(flightKey);
        if (existing) {
          if (existing.signature === signature) return existing.promise;
          return { ok: false, message: deps.t('settings.providerAttachBusy') };
        }

        const promise = (async (): Promise<ToggleProviderAgentResult> => {
          switch (plan.kind) {
            case 'detach': {
              const result = await controller.remove([profile], view.id);
              if (result.ok) {
                await reloadProviderCatalog();
                return { ok: true };
              }
              return { ok: false, message: result.message || deps.t('settings.providerToggleFailed') };
            }
            case 'attach': {
              const row = state.settingsCustomEndpoints.status === 'ready'
                ? state.settingsCustomEndpoints.data.find(
                    (item) => normalizeEndpointId(item.id) === targetId,
                  )
                : undefined;
              if (!row) return { ok: false, message: deps.t('settings.providerEditUnavailable') };
              let key = (apiKey ?? '').trim();
              if (!key) {
                const sources = (state.settingsEndpointProfiles[targetId] ?? [])
                  .filter((source) => source !== profile);
                const copied = await controller.resolveEndpointKey(view.id, sources);
                if (!copied.ok) {
                  if (copied.reason === 'no-readable-key') {
                    return {
                      ok: false,
                      needsKey: true,
                      message: deps.t('settings.providerToggleNeedsKey', { profile: botDisplayName }),
                    };
                  }
                  return { ok: false, message: copied.message || deps.t('settings.providerToggleFailed') };
                }
                key = copied.key;
              }
              const draft = draftForBindingAttach(row, view.models, key);
              const outcome = await controller.save(profile, draft, { fanOutTo: [], makeDefault: plan.makeDefault });
              const verdict = classifyAttachWrite(plan, outcome);
              if (verdict.kind === 'failed') {
                return { ok: false, message: outcome.current.message || deps.t('settings.providerToggleFailed') };
              }
              const verdictKey = messageKeyForVerdict(verdict);
              if (verdictKey) {
                await reloadProviderCatalog();
                return { ok: false, message: deps.t(verdictKey) };
              }
              await reloadProviderCatalog();
              return { ok: true };
            }
            case 'logout-subscription': {
              const result = await controller.logoutOauth(profile, view.id);
              if (result.ok) {
                await reloadProviderCatalog();
                return { ok: true };
              }
              return { ok: false, message: result.message || deps.t('settings.providerToggleFailed') };
            }
            default:
              return { ok: false, message: deps.t('settings.providerToggleFailed') };
          }
        })();

        const entry = { signature, promise };
        inFlightProviderBindings.set(flightKey, entry);
        try {
          return await promise;
        } finally {
          if (inFlightProviderBindings.get(flightKey) === entry) {
            inFlightProviderBindings.delete(flightKey);
          }
        }
      },
      onNotify: (message) => deps.showToast(message),
      /**
       * 就地先为 BOT 改选新默认提供方/模型，成功后再关闭原自定义端点（INV-SWITCH-01）。
       *
       * 【设计意图 (Why)】
       *   禁止直接对“当前默认提供方”执行关闭/移除；弹窗选定替补模型后必须在同一在途锁下严格串行完成两步。
       *
       * 【防范的历史坑 (Pitfall)】
       *   1. 第一步切换默认若因高价确认或网络拒绝未落盘，一旦并发或继续执行 DELETE，会让 BOT 断供且无可回滚；
       *   2. 服务层若依赖 UI 禁用而不校验 `disableView.kind !== 'custom'`，直接调用可能对订阅项误发 DELETE。
       *
       * 【约束与规则 (Rules)】
       *   1. 与 `inFlightProviderBindings` 共享互斥键，同签名并发复用、异方向返回 busy；
       *   2. 严格先调 `controller.useMainModel`，仅当 `switchResult.ok` 且非 `confirmRequired` 才调 `controller.remove`；
       *   3. 仅允许关闭 `kind === 'custom'` 端点；第一步成功而第二步失败时无条件刷新目录反映最新默认模型。
       */
      onSwitchDefaultAndDisableProvider: async ({
        profile,
        disableProviderId,
        newProviderId,
        newModel,
        confirmExpensive,
      }) => {
        const controller = getProviderAdminController();
        const disableTargetId = normalizeEndpointId(disableProviderId);
        const newTargetId = normalizeEndpointId(newProviderId);
        const views = state.settingsProviderViews.status === 'ready' ? state.settingsProviderViews.data : [];
        const disableView = views.find((item) => normalizeEndpointId(item.id) === disableTargetId);
        const newView = views.find((item) => normalizeEndpointId(item.id) === newTargetId);
        if (!disableView || !newView) {
          return { ok: false, step: 'switch', message: deps.t('settings.providerDeleteUnknown') };
        }
        if (disableView.kind !== 'custom') {
          return { ok: false, step: 'disable', message: deps.t('settings.providerToggleFailed') };
        }
        const model = newModel.trim();
        if (!model || disableTargetId === newTargetId) {
          return { ok: false, step: 'switch', message: deps.t('settings.providerToggleFailed') };
        }

        const flightKey = `${disableTargetId}\u0000${profile}`;
        const signature = `switch-disable:${newTargetId}:${model}:${Boolean(confirmExpensive)}`;
        const existing = inFlightProviderBindings.get(flightKey);
        if (existing) {
          if (existing.signature === signature) return existing.promise;
          return { ok: false, step: 'switch', message: deps.t('settings.providerAttachBusy') };
        }

        const promise = (async (): Promise<BindingFlightResult> => {
          // 1. 先切换目标 BOT 的默认提供方与模型；失败或要求高价确认时立即中止，绝不提前关闭原提供商。
          const switchResult = await controller.useMainModel(profile, {
            provider: newView.id,
            model,
            baseUrl: newView.kind === 'custom' && newView.detail ? newView.detail : undefined,
            confirmExpensive,
          });
          if (switchResult.confirmRequired) {
            return {
              ok: false,
              confirmRequired: true,
              step: 'switch',
              message: switchResult.confirmMessage || switchResult.message || deps.t('settings.providerExpensiveWarning'),
            };
          }
          if (!switchResult.ok) {
            return {
              ok: false,
              step: 'switch',
              message: switchResult.message || deps.t('settings.providerToggleFailed'),
            };
          }

          // 2. 第一步落盘后再关闭原提供商，并无条件重拉目录使主模型变更即时反映到 UI 与 BOT 配置。
          const removeResult = await controller.remove([profile], disableView.id);
          await reloadProviderCatalog();
          void deps.fetchProfiles();
          if (!removeResult.ok) {
            return {
              ok: false,
              step: 'disable',
              message: deps.t('settings.providerSwitchDoneDisableFailed', {
                detail: removeResult.message || deps.t('settings.providerToggleFailed'),
              }),
            };
          }
          return { ok: true };
        })();

        const entry = { signature, promise };
        inFlightProviderBindings.set(flightKey, entry);
        try {
          return await promise;
        } finally {
          if (inFlightProviderBindings.get(flightKey) === entry) {
            inFlightProviderBindings.delete(flightKey);
          }
        }
      },

      onBotDraftChange: (botId, patch) => getBotManagementController().updateDraft(botId, patch),
      onSelectBotSettle: (botId) => getBotManagementController().selectBot(botId),
      onSaveBotConfig: (botId, options) => getBotManagementController().saveBot(botId, options),
      onResetBotDraft: (botId) => getBotManagementController().resetDraft(botId),
      onOpenBotWizard: (mode) => botWizardController.open(mode),
      onCloseBotWizard: () => botWizardController.close(),
      onBotWizardDraftChange: (patch) => botWizardController.patchDraft(patch),
      onSubmitCreateBot: () => botWizardController.submit(),
      onRetryBotList: () => { void getBotManagementController().loadRoster(true); },
      onDismissBotError: () => getBotManagementController().dismissError(),
      onDismissBotConfirm: () => getBotManagementController().dismissConfirm(),
      onConfirmBotExit: (choice) => {
        const target = pendingBotExit;
        if (!target) return;
        if (choice === 'discard') {
          const ids = Object.keys(deps.getState().botDrafts);
          if (ids.length > 0) {
            const controller = getBotManagementController();
            for (const id of ids) controller.resetDraft(id);
          }
          botDraftsByGateway.clear();
        }
        performSettingsExit(target);
      },
      onCancelBotExit: () => {
        pendingBotExit = null;
        deps.render();
      },
      onRegisterBotDirtyGuard: (guard) => {
        botDirtyGuard = guard;
      },
      onOpenAgent: (name) => {
        openBotSettings(name, { gatewayId: resolveSelectedGatewayId() || undefined });
      },
      onRefreshExtensions: () => { void getSettingsController().loadExtensions(); },
      onReloadSkills: () => getSettingsController().reloadSkills(),
      ...createSettingsExtensionsActions({
        getGatewayClient: resolveSettingsClient,
        isConnected: isSettingsGatewayConnected,
        getFallbackProfile: () => gatewayController.getProfileNameForGateway(resolveSelectedGatewayId()),
        getActiveBotDetail: () => state.botManagementDetail,
        getSettingsSkills: () => state.settingsSkills,
        getMcpStatus: () => state.settingsMcp.status,
        getSkillsStatus: () => state.settingsSkills.status,
        getSection: () => state.settingsSection,
        refreshActiveCapabilities: (targetProfile, opts) => getBotManagementController().refreshActiveCapabilities(targetProfile, opts),
        loadExtensions: () => getSettingsController().loadExtensions(),
        t: deps.t,
        describeRpcError: deps.describeRpcError,
        bootLog: deps.bootLog,
      }),
      onLoadLearningGraph: (profile, force) => {
        const gatewayId = isMultiGatewayConfigMode() ? resolveSelectedGatewayId() : '';
        void deps.learningService?.loadLearningGraph({ profile, ...(gatewayId ? { gatewayId } : {}), force: Boolean(force) });
      },
      onLoadLearningDetail: (id, profile) => {
        const gw = isMultiGatewayConfigMode() ? resolveSelectedGatewayId() : '';
        void (gw ? deps.learningService?.loadLearningDetail(id, profile, gw) : deps.learningService?.loadLearningDetail(id, profile));
      },
      onEditLearningNode: (id, content, profile) => {
        if (!deps.learningService) return Promise.resolve({ ok: false, message: deps.t('settings.notConnected') });
        const gw = isMultiGatewayConfigMode() ? resolveSelectedGatewayId() : '';
        return gw ? deps.learningService.editLearningNode(id, content, profile, gw) : deps.learningService.editLearningNode(id, content, profile);
      },
      onDeleteLearningNode: (id, profile) => {
        if (!deps.learningService) return Promise.resolve({ ok: false, message: deps.t('settings.notConnected') });
        const gw = isMultiGatewayConfigMode() ? resolveSelectedGatewayId() : '';
        return gw ? deps.learningService.deleteLearningNode(id, profile, gw) : deps.learningService.deleteLearningNode(id, profile);
      },
      ...gatewayController.actions,
      ...createMcpOAuthActions({ getState: () => state, getGatewayClient: resolveSettingsClient, isGatewayConnected: isSettingsGatewayConnected, getDesktopApi: deps.getDesktopApi, describeRpcError: deps.describeRpcError, t: deps.t, onNotify: (msg) => deps.showToast(msg), onExtensionsChanged: () => { void getSettingsController().loadExtensions(); } }),
    };
  }

  function syncReactSettings(): void {
    if (typeof document === 'undefined') return;
    const host = document.getElementById('react-settings-host');
    if (!host) return;
    const state = deps.getState();
    if (!updateReactSettings) {
      updateReactSettings = mountSettingsModal(host, getSettingsSnapshot, createSettingsActions());
      lastSettingsSnapshotJson = '';
    }
    if (!state.isSettingsOpen) {
      if (lastSettingsSnapshotJson === '') return;
      lastSettingsSnapshotJson = '';
      updateReactSettings();
      return;
    }
    const snapshot = getSettingsSnapshot();
    const json = JSON.stringify(snapshot);
    if (json === lastSettingsSnapshotJson) return;
    lastSettingsSnapshotJson = json;
    updateReactSettings();
  }

  return {
    scopedProfileName,
    subscriptionProfileName,
    botRoster,
    reloadProviderCatalog,
    openBotSettings,
    getBotManagementSnapshot,
    hasUnsavedBotDrafts,
    getSettingsSnapshot,
    ensureSettingsSectionData,
    createSettingsActions,
    requestSettingsExit,
    syncReactSettings,
    getSettingsController,
    getProviderAdminController,
    getBotManagementController,
  };
}
