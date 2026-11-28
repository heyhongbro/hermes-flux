/**
 * 设置中心多网关实例管理动作与状态投影（Settings Gateway Actions）
 *
 * 【设计意图 (Why)】
 *   从 `settingsDataService.ts` 中抽离多网关注册表增删改查、启停开关、单节点建连/断开与
 *   设置作用域当前网关解析，避免 `settingsDataService.ts` 超过 1500 行门禁上限，
 *   并确保从单网关无缝升级到多网关时自动保留既有主节点及其 OS 密钥库口令。
 */

import {
  DEFAULT_CACHE_GATEWAY_ID,
  deriveGatewayShortLabel,
  type GatewayInstanceConfig,
  type GatewayPoolHealthSummary,
  type GatewayRuntimeSlot,
} from '@hermes-flux/core';
import type {
  GatewayDraft,
  GatewayInstanceDraft,
  I18nKey,
  SettingsActions,
  SettingsGatewayItem,
  SettingsGatewayStatus,
  StorageWriteFailure,
} from '@hermes-flux/ui';
import type { HermesDesktopBridge } from '../../preload/index.js';
import {
  deleteGatewayPassword,
  removeGatewayConfig,
  resolveGatewayPassword as resolveStoredGatewayPassword,
  saveGatewayPassword,
  setGatewayEnabled,
  upsertGatewayConfig,
} from '../gateway/gatewayRegistryStore.js';
import type { AppState } from '../state/appState.js';
import { reportStorageFailure } from './settingsStorageHelpers.js';

export interface GatewayTestResult {
  ok: boolean;
  message?: string;
  latency?: number;
}

export interface SettingsGatewayActionsDeps {
  readonly getState: () => AppState;
  readonly getGatewayConfigs: () => GatewayInstanceConfig[];
  readonly saveGatewayConfigs: (configs: readonly GatewayInstanceConfig[]) => StorageWriteFailure;
  readonly getGatewaySlot?: (gatewayId?: string) => GatewayRuntimeSlot | undefined;
  readonly getHealthSummary?: () => GatewayPoolHealthSummary | undefined;
  readonly getDesktopApi?: () => HermesDesktopBridge | undefined;
  readonly testConnection: (url: string, user: string, pass: string) => Promise<GatewayTestResult>;
  readonly connect: () => Promise<void>;
  readonly disconnect: () => void;
  readonly syncConfiguredGateways?: (options?: {
    configs?: readonly GatewayInstanceConfig[];
    connectIds?: readonly string[];
    disconnectIds?: readonly string[];
  }) => Promise<void>;
  readonly connectGatewayInstance?: (gatewayId: string) => Promise<boolean>;
  readonly disconnectGatewayInstance?: (gatewayId: string) => boolean;
  readonly render: () => void;
  readonly t: (key: I18nKey, params?: Record<string, string | number>) => string;
  readonly bootLog: { warn(message: string, meta?: Record<string, unknown>): void };
  readonly showToast: (message: string, durationMs?: number) => void;
  readonly runBusy: (task: () => Promise<void>) => Promise<void>;
  readonly applyLegacyGatewayDraft: (draft: GatewayDraft) => void;
}

export function resolveSelectedGatewayIdFromState(
  state: Pick<AppState, 'settingsGatewayId' | 'activeFocus' | 'activeGatewayId'>,
  configs: readonly GatewayInstanceConfig[],
  health?: GatewayPoolHealthSummary,
): string {
  if (configs.length === 0) return '';
  if (state.settingsGatewayId && configs.some((cfg) => cfg.id === state.settingsGatewayId)) {
    return state.settingsGatewayId;
  }
  const focused = state.activeFocus?.gatewayId || state.activeGatewayId;
  if (focused && configs.some((cfg) => cfg.id === focused)) {
    return focused;
  }
  const connectedSlot = health?.slots.find(
    (slot) => slot.connected && configs.some((cfg) => cfg.id === slot.gatewayId),
  );
  if (connectedSlot) return connectedSlot.gatewayId;
  return configs[0].id;
}

function resolveGatewayItemStatus(
  cfg: GatewayInstanceConfig,
  slotHealth: GatewayPoolHealthSummary['slots'][number] | undefined,
  singleLegacyState: Pick<AppState, 'gatewayConnected' | 'gatewayConnecting'>,
  totalConfigs: number,
): SettingsGatewayStatus {
  if (cfg.enabled === false) return 'disabled';
  if (slotHealth) {
    if (slotHealth.connected) return 'connected';
    if (slotHealth.authError) return 'auth_error';
    if (slotHealth.status === 'reconnecting' || slotHealth.status === 'syncing') return 'connecting';
    return 'offline';
  }
  if (totalConfigs <= 1) {
    if (singleLegacyState.gatewayConnected) return 'connected';
    if (singleLegacyState.gatewayConnecting) return 'connecting';
  }
  return 'offline';
}

export function buildSettingsGatewayItems(input: {
  configs: readonly GatewayInstanceConfig[];
  state: Pick<AppState, 'gatewayConnected' | 'gatewayConnecting' | 'gatewayLatencyMs' | 'password' | 'profileName'>;
  health?: GatewayPoolHealthSummary;
  profileNamesByGateway?: ReadonlyMap<string, string>;
  hasPasswordByGateway?: ReadonlyMap<string, boolean>;
}): SettingsGatewayItem[] {
  const { configs, state, health, profileNamesByGateway, hasPasswordByGateway } = input;
  return configs.map((cfg, index) => {
    const slotHealth = health?.slots.find((slot) => slot.gatewayId === cfg.id);
    const status = resolveGatewayItemStatus(cfg, slotHealth, state, configs.length);
    const latencyMs =
      slotHealth?.latencyMs ??
      (configs.length <= 1 && state.gatewayConnected ? state.gatewayLatencyMs : undefined);
    const knownPassword =
      hasPasswordByGateway?.get(cfg.id) ?? (index === 0 ? Boolean(state.password) : false);
    return {
      id: cfg.id,
      name: cfg.name,
      url: cfg.url,
      username: cfg.username,
      profileName: profileNamesByGateway?.get(cfg.id) || (index === 0 ? state.profileName || 'default' : 'default'),
      enabled: cfg.enabled !== false,
      status,
      ...(typeof latencyMs === 'number' ? { latencyMs } : {}),
      ...(slotHealth?.reason && status !== 'connected' ? { error: slotHealth.reason } : {}),
      ...(index === 0 ? { isDefault: true } : {}),
      hasStoredPassword: knownPassword,
    };
  });
}

function generateGatewayInstanceId(
  name: string,
  url: string,
  existing: readonly GatewayInstanceConfig[],
): string {
  const used = new Set(existing.map((item) => item.id));
  const rawSlug = (name.trim() || deriveGatewayShortLabel('', url))
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const base = rawSlug || 'gw';
  if (!used.has(base)) return base;
  let suffix = 2;
  while (used.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

export interface SettingsGatewayController {
  getItems(): SettingsGatewayItem[];
  getSelectedGatewayId(): string;
  getProfileNameForGateway(gatewayId?: string): string;
  actions: Pick<
    SettingsActions,
    | 'onAddGateway'
    | 'onUpdateGateway'
    | 'onRemoveGateway'
    | 'onToggleGatewayEnabled'
    | 'onConnectGatewayInstance'
    | 'onDisconnectGatewayInstance'
    | 'onTestGatewayInstance'
    | 'onTestGateway'
    | 'onConnectGateway'
    | 'onDisconnectGateway'
  >;
}

export function createSettingsGatewayController(
  deps: SettingsGatewayActionsDeps,
): SettingsGatewayController {
  const profileNamesByGateway = new Map<string, string>();
  const hasPasswordByGateway = new Map<string, boolean>();

  async function ensureSeedPrimaryConfig(configs: GatewayInstanceConfig[]): Promise<GatewayInstanceConfig[]> {
    if (configs.length > 0) return configs;
    const state = deps.getState();
    const url = state.gatewayUrl.trim();
    if (!url) return configs;
    const primary: GatewayInstanceConfig = {
      id: DEFAULT_CACHE_GATEWAY_ID,
      name: deriveGatewayShortLabel('', url),
      url,
      enabled: true,
      routeKind: 'direct',
      ...(state.username.trim() ? { username: state.username.trim() } : {}),
    };
    if (state.password) {
      await saveGatewayPassword(primary, state.password, deps.getDesktopApi?.());
      hasPasswordByGateway.set(primary.id, true);
    }
    if (state.profileName) {
      profileNamesByGateway.set(primary.id, state.profileName);
    }
    return [primary];
  }

  return {
    getItems: () => {
      const state = deps.getState();
      const configs = deps.getGatewayConfigs();
      return buildSettingsGatewayItems({
        configs,
        state,
        health: deps.getHealthSummary?.() ?? state.gatewayHealthSummary,
        profileNamesByGateway,
        hasPasswordByGateway,
      });
    },
    getSelectedGatewayId: () => {
      const state = deps.getState();
      return resolveSelectedGatewayIdFromState(
        state,
        deps.getGatewayConfigs(),
        deps.getHealthSummary?.() ?? state.gatewayHealthSummary,
      );
    },
    getProfileNameForGateway: (gatewayId) => {
      const stored = gatewayId ? profileNamesByGateway.get(gatewayId) : undefined;
      if (stored) {
        return stored;
      }
      return deps.getState().profileName || 'default';
    },
    actions: {
      onAddGateway: async (draft: GatewayInstanceDraft) => {
        const cleanUrl = draft.url.trim();
        if (!cleanUrl) {
          return { ok: false, message: deps.t('gateway.urlRequired') };
        }
        const seeded = await ensureSeedPrimaryConfig(deps.getGatewayConfigs());
        const id = draft.id?.trim() || generateGatewayInstanceId(draft.name, cleanUrl, seeded);
        const entry: GatewayInstanceConfig = {
          id,
          name: deriveGatewayShortLabel(draft.name, cleanUrl),
          url: cleanUrl,
          enabled: draft.enabled !== false,
          routeKind: 'direct',
          ...(draft.username.trim() ? { username: draft.username.trim() } : {}),
        };
        const nextConfigs = upsertGatewayConfig(seeded, entry);
        reportStorageFailure(deps, 'gateway', deps.saveGatewayConfigs(nextConfigs));
        profileNamesByGateway.set(id, draft.profileName.trim() || 'default');
        if (draft.password) {
          await saveGatewayPassword(entry, draft.password, deps.getDesktopApi?.());
          hasPasswordByGateway.set(id, true);
        }
        const state = deps.getState();
        if (nextConfigs.length === 1) {
          deps.applyLegacyGatewayDraft({
            url: cleanUrl,
            username: draft.username,
            password: draft.password,
            profileName: draft.profileName.trim() || 'default',
          });
        } else {
          await deps.syncConfiguredGateways?.({
            configs: nextConfigs,
            connectIds: nextConfigs.filter((c) => c.enabled !== false).map((c) => c.id),
          });
        }
        if (!state.settingsGatewayId) {
          state.settingsGatewayId = id;
        }
        deps.render();
        return { ok: true, gatewayId: id };
      },

      onUpdateGateway: async (gatewayId: string, draft: GatewayInstanceDraft) => {
        const cleanUrl = draft.url.trim();
        if (!cleanUrl) {
          return { ok: false, message: deps.t('gateway.urlRequired') };
        }
        const configs = deps.getGatewayConfigs();
        const existing = configs.find((c) => c.id === gatewayId);
        if (!existing) {
          return { ok: false, message: deps.t('settings.loadFailed') };
        }
        const updated: GatewayInstanceConfig = {
          ...existing,
          name: deriveGatewayShortLabel(draft.name, cleanUrl, existing.shortAlias),
          url: cleanUrl,
          enabled: draft.enabled !== false,
          ...(draft.username.trim() ? { username: draft.username.trim() } : { username: undefined }),
        };
        const nextConfigs = upsertGatewayConfig(configs, updated);
        reportStorageFailure(deps, 'gateway', deps.saveGatewayConfigs(nextConfigs));
        profileNamesByGateway.set(gatewayId, draft.profileName.trim() || 'default');
        if (draft.password) {
          await saveGatewayPassword(updated, draft.password, deps.getDesktopApi?.());
          hasPasswordByGateway.set(gatewayId, true);
        }
        if (nextConfigs.length <= 1) {
          deps.applyLegacyGatewayDraft({
            url: cleanUrl,
            username: draft.username,
            password: draft.password,
            profileName: draft.profileName.trim() || 'default',
          });
        }
        await deps.syncConfiguredGateways?.({
          configs: nextConfigs,
          connectIds: updated.enabled !== false ? [gatewayId] : [],
          disconnectIds: updated.enabled === false ? [gatewayId] : [],
        });
        deps.render();
        return { ok: true };
      },

      onRemoveGateway: async (gatewayId: string) => {
        const configs = deps.getGatewayConfigs();
        if (configs.length <= 1) {
          return { ok: false, message: deps.t('settings.gatewayRemoveLastHint') };
        }
        const target = configs.find((c) => c.id === gatewayId);
        if (!target) {
          return { ok: false, message: deps.t('settings.loadFailed') };
        }
        const nextConfigs = removeGatewayConfig(configs, gatewayId);
        reportStorageFailure(deps, 'gateway', deps.saveGatewayConfigs(nextConfigs));
        await deleteGatewayPassword(target, deps.getDesktopApi?.());
        hasPasswordByGateway.delete(gatewayId);
        profileNamesByGateway.delete(gatewayId);
        const state = deps.getState();
        if (state.settingsGatewayId === gatewayId) {
          state.settingsGatewayId = nextConfigs[0].id;
        }
        if (nextConfigs.length === 1) {
          state.gatewayUrl = nextConfigs[0].url;
          state.username = nextConfigs[0].username || '';
          state.gatewayCount = 1;
        }
        await deps.syncConfiguredGateways?.({
          configs: nextConfigs,
          disconnectIds: [gatewayId],
        });
        deps.render();
        return { ok: true };
      },

      onToggleGatewayEnabled: async (gatewayId: string, enabled: boolean) => {
        const configs = deps.getGatewayConfigs();
        const nextConfigs = setGatewayEnabled(configs, gatewayId, enabled);
        reportStorageFailure(deps, 'gateway', deps.saveGatewayConfigs(nextConfigs));
        await deps.syncConfiguredGateways?.({
          configs: nextConfigs,
          connectIds: enabled ? [gatewayId] : [],
          disconnectIds: enabled ? [] : [gatewayId],
        });
        deps.render();
      },

      onConnectGatewayInstance: async (gatewayId: string) => {
        if (deps.connectGatewayInstance) {
          await deps.connectGatewayInstance(gatewayId);
        } else {
          await deps.syncConfiguredGateways?.({ connectIds: [gatewayId] });
        }
        deps.render();
      },

      onDisconnectGatewayInstance: (gatewayId: string) => {
        deps.disconnectGatewayInstance?.(gatewayId);
        deps.render();
      },

      onTestGatewayInstance: async (draft: GatewayInstanceDraft) => {
        const cleanUrl = draft.url.trim();
        if (!cleanUrl) {
          return { ok: false, message: deps.t('gateway.urlRequired') };
        }
        let password = draft.password;
        if (!password && draft.id) {
          password = await resolveStoredGatewayPassword(
            { id: draft.id, url: cleanUrl },
            deps.getDesktopApi?.(),
            '',
          );
        }
        return await deps.testConnection(cleanUrl, draft.username, password);
      },

      onTestGateway: (draft: GatewayDraft) => {
        deps.applyLegacyGatewayDraft(draft);
        const state = deps.getState();
        void deps.runBusy(async () => {
          state.testStatus = await deps.testConnection(state.gatewayUrl, state.username, state.password);
        });
      },

      onConnectGateway: (draft: GatewayDraft) => {
        deps.applyLegacyGatewayDraft(draft);
        const state = deps.getState();
        if (!state.gatewayUrl) {
          state.testStatus = { ok: false, message: deps.t('gateway.urlRequired'), latency: 0 };
          deps.render();
          return;
        }
        void deps.connect();
      },

      onDisconnectGateway: () => {
        deps.disconnect();
      },
    },
  };
}
