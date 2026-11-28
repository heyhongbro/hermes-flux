/**
 * 设置中心提供商关键写入动作装配器（保存端点、切换主模型、切换默认并关闭）
 *
 * 【设计意图 (Why)】
 *   将与自定义端点写入和主模型对齐相关的多步事务动作从 `settingsDataService.ts` 拆出，
 *   控制单文件行数不触及 1500 行上限，并与 `onToggleProviderAgent` 共用 `inFlightProviderBindings` 互斥锁。
 */

import type { AppState } from '../state/appState.js';
import { normalizeEndpointId } from '@hermes-flux/core';
import type { I18nKey, SettingsActions, ToggleProviderAgentResult } from '@hermes-flux/ui';
import type { createProviderAdminController } from '../providerAdminController.js';

export type ProviderAdminController = ReturnType<typeof createProviderAdminController>;

export type BindingFlightResult = ToggleProviderAgentResult & {
  confirmRequired?: boolean;
  step?: 'switch' | 'disable';
};

export interface SettingsProviderActionsDeps {
  readonly getState: () => AppState;
  readonly getProviderAdminController: () => ProviderAdminController;
  readonly inFlightProviderBindings: Map<
    string,
    { signature: string; promise: Promise<BindingFlightResult> }
  >;
  readonly scopedProfileName: () => string;
  readonly botRoster: () => Array<{ profile: string; displayName: string; avatar?: string }>;
  readonly reloadProviderCatalog: () => Promise<void>;
  readonly fetchProfiles: (options?: { refresh?: boolean }) => Promise<void>;
  readonly showToast: (message: string, durationMs?: number) => void;
  readonly t: (key: I18nKey, params?: Record<string, string | number>) => string;
}

export function createSettingsProviderActions(
  deps: SettingsProviderActionsDeps,
): Pick<
  SettingsActions,
  'onSaveEndpoint' | 'onActivateProvider' | 'onSwitchDefaultAndDisableProvider'
> {
  return {
    onSaveEndpoint: async (draft, options) => {
      const controller = deps.getProviderAdminController();
      const targets = options.targetProfiles?.filter(Boolean) ?? [];
      const primary = targets[0] ?? deps.scopedProfileName();
      const fanOutTo = targets.length > 0 ? targets.slice(1) : options.fanOutTo;
      const outcome = await controller.save(primary, draft, {
        fanOutTo,
        makeDefault: options.makeDefault,
        fanOutMakeDefault: options.makeDefault,
        profileDisplayNames: Object.fromEntries(deps.botRoster().map((bot) => [bot.profile, bot.displayName])),
      });
      if (outcome.currentOk === false) return { ok: false, message: outcome.current.message || deps.t('settings.saveFailed') };
      if (options.makeDefault && draft.model.trim()) {
        // 部分网关对 custom-endpoints POST 的 make_default 不生效，显式兜底走 /api/model/set 对齐主模型。
        if (outcome.currentIsDefault === false) {
          await controller.useMainModel(primary, {
            provider: outcome.id,
            model: draft.model,
            baseUrl: draft.baseUrl,
          });
        }
        for (const item of outcome.fanOut) {
          if (item.ok && item.isCurrent === false) {
            await controller.useMainModel(item.profile, {
              provider: outcome.id,
              model: draft.model,
              baseUrl: draft.baseUrl,
            });
          }
        }
        void deps.fetchProfiles({ refresh: true });
      }
      void deps.reloadProviderCatalog();
      return { ok: true, fanOut: [outcome.current, ...outcome.fanOut] };
    },
    onActivateProvider: async (providerId, model, confirmExpensive) => {
      const state = deps.getState();
      const controller = deps.getProviderAdminController();
      const profile = deps.scopedProfileName();
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
        void deps.fetchProfiles({ refresh: true });
        void deps.reloadProviderCatalog();
      }
      return result;
    },
    onSwitchDefaultAndDisableProvider: async ({
      profile,
      disableProviderId,
      newProviderId,
      newModel,
      confirmExpensive,
    }) => {
      const state = deps.getState();
      const controller = deps.getProviderAdminController();
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
      const existing = deps.inFlightProviderBindings.get(flightKey);
      if (existing) {
        if (existing.signature === signature) return existing.promise;
        return { ok: false, step: 'switch', message: deps.t('settings.providerAttachBusy') };
      }

      const promise = (async (): Promise<BindingFlightResult> => {
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

        const removeResult = await controller.remove([profile], disableView.id);
        await deps.reloadProviderCatalog();
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
      deps.inFlightProviderBindings.set(flightKey, entry);
      try {
        return await promise;
      } finally {
        if (deps.inFlightProviderBindings.get(flightKey) === entry) {
          deps.inFlightProviderBindings.delete(flightKey);
        }
      }
    },
  };
}
