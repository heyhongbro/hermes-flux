/**
 * 设置持久化容错与网关草稿写入辅助（从 settingsDataService 解耦以控单文件规模）。
 *
 * 【设计意图 (Why)】
 *   隐私模式/禁用站点数据下 localStorage.setItem 会抛 SecurityError，配额满抛 QuotaExceededError。
 *   把容错日志上报与网关 8 键写入收敛至独立辅助模块，既保持单文件远低于 1500 行上限，
 *   又确保所有写入失败均有可观测降级（Failure Is Not Empty）。
 *
 * 【约束与规则 (Rules)】
 *   - `unavailable`（非浏览器/无 localStorage 环境）不属降级，保持静默；
 *   - `gateway` 写入属用户主动提交动作，非 unavailable 失败必须通过 showToast 提示一次。
 */

import { safeSetItem, type I18nKey, type StorageWriteFailure } from '@hermes-flux/ui';
import type { AppState } from '../state/appState.js';

export interface SettingsStorageHelpersDeps {
  readonly bootLog: { warn(message: string, meta?: Record<string, unknown>): void };
  readonly showToast: (message: string, durationMs?: number) => void;
  readonly t: (key: I18nKey, params?: Record<string, string | number>) => string;
}

/** 落盘失败的可观测降级策略（P-032）。 */
export function reportStorageFailure(
  deps: SettingsStorageHelpersDeps,
  scope: 'gateway' | 'theme' | 'locale',
  failure: StorageWriteFailure,
): void {
  if (failure.ok || failure.reason === 'unavailable') return;
  deps.bootLog.warn('settings persist failed', {
    scope,
    reason: failure.reason,
    error: String(failure.error),
  });
  if (scope === 'gateway') {
    deps.showToast(deps.t('settings.gatewayDraftPersistFailed'), 5000);
  }
}

/** 将网关连接表单草稿写入主/旧双前缀 8 个存储键（遇到 SecurityError 即短路）。 */
export function writeGatewayDraft(deps: SettingsStorageHelpersDeps, state: AppState): void {
  const entries: ReadonlyArray<readonly [string, string]> = [
    ['hermes_flux_gateway_url', state.gatewayUrl],
    ['hermes_aura_gateway_url', state.gatewayUrl],
    ['hermes_flux_username', state.username],
    ['hermes_aura_username', state.username],
    ['hermes_flux_password', state.password],
    ['hermes_aura_password', state.password],
    ['hermes_flux_profile', state.profileName],
    ['hermes_aura_profile', state.profileName],
  ];
  let failure: StorageWriteFailure = { ok: true };
  for (const [key, value] of entries) {
    const result = safeSetItem(key, value);
    if (result.ok) continue;
    if (failure.ok) failure = result;
    if (result.reason === 'security') break;
  }
  reportStorageFailure(deps, 'gateway', failure);
}

/** 从设置详情、花名册与大小写头像缓存三级来源解析指定 Bot 头像。 */
export function resolveProfileAvatarFromState(
  state: AppState,
  profileAvatarCache: Map<string, string>,
  botId: string,
): string | undefined {
  if (!botId) return undefined;
  const settingsRow =
    state.settingsProfiles.status === 'ready'
      ? state.settingsProfiles.data.find((item) => item.name === botId)
      : undefined;
  if (settingsRow?.avatar) return settingsRow.avatar;
  const profileRow = state.profiles.find((item) => item.name === botId);
  if (profileRow?.avatar) return profileRow.avatar;
  const cachedById = profileAvatarCache.get(botId.toLowerCase());
  if (cachedById) return cachedById;
  const displayName = settingsRow?.displayName || profileRow?.displayName;
  if (displayName) {
    const cachedByName = profileAvatarCache.get(displayName.toLowerCase());
    if (cachedByName) return cachedByName;
  }
  return undefined;
}

/** 根据在线档案列表派生设置中心消费的轻量花名册。 */
export function resolveBotRoster(
  state: AppState,
): Array<{ profile: string; displayName: string; avatar?: string }> {
  if (state.profiles.length === 0) {
    const name = state.profileName || 'default';
    return [{ profile: name, displayName: name }];
  }
  return state.profiles.map((profile) => ({
    profile: profile.name,
    displayName: profile.displayName || profile.name,
    avatar: profile.avatar,
  }));
}

/** 将网关连接表单草稿应用到内存状态并双前缀持久化。 */
export function applyGatewayDraftToState(
  deps: SettingsStorageHelpersDeps,
  state: AppState,
  draft: { url: string; username: string; profileName: string },
  resolvedPassword: string,
): void {
  state.gatewayUrl = draft.url.trim();
  state.username = draft.username;
  state.password = resolvedPassword;
  state.profileName = draft.profileName.trim() || 'default';
  // 内存态已更新：落盘失败不得中断后续 runBusy / connect（P-032）。
  writeGatewayDraft(deps, state);
}
