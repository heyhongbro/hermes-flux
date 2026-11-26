/**
 * MCP 服务器热重载确认与 OAuth 授权业务服务 (MCP OAuth Service)
 *
 * 【设计意图 (Why)】
 *   SettingsModal 扩展面板提供 `reload.mcp` 二次确认与 `mcp.servers.oauth.*` 浏览器授权流程，
 *   而 `settingsDataService.ts` 已逼近 1500 行工程门禁硬上限，因此将 MCP 重载与 OAuth
 *   状态调用收敛至此独立薄服务，供设置中心动作表展开复用并接受 Node 单测直接验证。
 *
 * 【防范的历史坑 (Pitfall)】
 *   1. `reload.mcp` 契约仅接受 `{ session_id?, confirm?, always?, rev? }`，严禁传 `profile` 字段，
 *      否则 StrictMode 网关会拒收并返回 Extra inputs 错误；
 *   2. `mcp.servers.oauth.start` 严禁传 `client_redirect_uri`，且前端绝不能主动调 `mcp.servers.oauth.callback`；
 *   3. 外链跳转必须先经过 `isSafeExternalUrl` 校验（仅放行 `http:` / `https:`）。
 *
 * 【约束与规则 (Rules)】
 *   - 0 TS 报错，严禁类型逃逸；
 *   - 单向依赖：不反向 import `index.ts` 或 `settingsDataService.ts`。
 */

import type {
  HermesGatewayClient,
  McpOauthCancelResult,
  McpOauthPollResult,
  McpOauthStartResult,
  ReloadMcpParams,
  ReloadMcpResult,
} from '@hermes-flux/core';
import {
  isSafeExternalUrl,
  type I18nKey,
  type McpOauthPollViewResult,
  type McpOauthStartViewResult,
  type McpReloadActionResult,
  type SettingsActionResult,
} from '@hermes-flux/ui';
import type { HermesDesktopBridge } from '../../preload/index.js';
import type { AppState } from '../state/appState.js';

export interface McpOAuthServiceDeps {
  readonly getState: () => AppState;
  readonly getGatewayClient: () => HermesGatewayClient | null;
  readonly getDesktopApi?: () => HermesDesktopBridge | undefined;
  readonly describeRpcError: (error: unknown) => string;
  readonly t: (key: I18nKey, params?: Record<string, string | number>) => string;
  readonly onNotify: (message: string) => void;
  readonly onExtensionsChanged?: () => void;
}

export interface McpOAuthActions {
  onReloadMcp: (options?: {
    confirm?: boolean;
    always?: boolean;
    rev?: string | null;
  }) => Promise<McpReloadActionResult>;
  onStartMcpOAuth: (profile: string, name: string) => Promise<McpOauthStartViewResult>;
  onPollMcpOAuth: (
    profile: string,
    name: string,
    sessionId: string,
  ) => Promise<McpOauthPollViewResult>;
  onCancelMcpOAuth: (
    profile: string,
    name: string,
    sessionId: string,
  ) => Promise<SettingsActionResult>;
  onOpenExternalUrl: (url: string) => void;
}

export function createMcpOAuthActions(deps: McpOAuthServiceDeps): McpOAuthActions {
  const openExternalUrl = (url: string): void => {
    if (!isSafeExternalUrl(url)) return;
    const desktopApi = deps.getDesktopApi?.();
    if (desktopApi?.openExternal) {
      void desktopApi.openExternal(url);
      return;
    }
    if (typeof window !== 'undefined' && typeof window.open === 'function') {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  };

  return {
    onReloadMcp: async (options) => {
      const client = deps.getGatewayClient();
      const state = deps.getState();
      if (!client || !state.gatewayConnected) {
        return { ok: false, message: deps.t('settings.notConnected') };
      }
      const params: ReloadMcpParams = {
        ...(state.activeLiveSessionId ? { session_id: state.activeLiveSessionId } : {}),
        ...(options?.confirm ? { confirm: true } : {}),
        ...(options?.always ? { always: true } : {}),
        ...(options?.rev ? { rev: options.rev } : {}),
      };
      try {
        const res = await client.call<ReloadMcpResult>('reload.mcp', params);
        if (res.status === 'confirm_required') {
          return {
            ok: false,
            confirmRequired: true,
            rev: res.loaded_rev ?? null,
            message: res.message || deps.t('interactive.confirm.reloadMcpMessage'),
          };
        }
        if (res.session === 'busy') {
          deps.onNotify(deps.t('interactive.mcp.reloadBusy'));
        } else {
          deps.onNotify(deps.t('interactive.mcp.reloaded'));
        }
        deps.onExtensionsChanged?.();
        return {
          ok: true,
          status: res.status,
          session: res.session ?? null,
          rev: res.loaded_rev ?? null,
          message: res.message ?? undefined,
        };
      } catch (error) {
        const msg = deps.describeRpcError(error);
        return { ok: false, message: deps.t('interactive.mcp.reloadFailed', { error: msg }) };
      }
    },

    onStartMcpOAuth: async (profile, name) => {
      const client = deps.getGatewayClient();
      const state = deps.getState();
      if (!client || !state.gatewayConnected) {
        return { ok: false, message: deps.t('settings.notConnected') };
      }
      const targetProfile = profile || state.profileName || 'default';
      try {
        const res = await client.call<McpOauthStartResult>('mcp.servers.oauth.start', {
          profile: targetProfile,
          name: name.trim(),
        });
        if (!res.ok || !res.session_id) {
          return { ok: false, message: deps.t('settings.malformedResponse') };
        }
        if (res.auth_url && isSafeExternalUrl(res.auth_url)) {
          openExternalUrl(res.auth_url);
        }
        deps.onNotify(deps.t('interactive.mcp.oauthStarted', { name: name.trim() }));
        return {
          ok: true,
          sessionId: res.session_id,
          authUrl: res.auth_url || undefined,
          flow: res.flow || undefined,
        };
      } catch (error) {
        return {
          ok: false,
          message: deps.t('interactive.mcp.oauthFailed', { error: deps.describeRpcError(error) }),
        };
      }
    },

    onPollMcpOAuth: async (profile, name, sessionId) => {
      const client = deps.getGatewayClient();
      const state = deps.getState();
      if (!client || !state.gatewayConnected) {
        return { ok: false, status: 'error', message: deps.t('settings.notConnected') };
      }
      const targetProfile = profile || state.profileName || 'default';
      try {
        const res = await client.call<McpOauthPollResult>('mcp.servers.oauth.poll', {
          profile: targetProfile,
          name: name.trim(),
          session_id: sessionId,
        });
        if (res.status === 'approved') {
          deps.onNotify(deps.t('interactive.mcp.oauthApproved'));
          deps.onExtensionsChanged?.();
        }
        return {
          ok: res.ok,
          status: res.status,
          sessionId: res.session_id ?? sessionId,
          authUrl: res.auth_url ?? undefined,
          message: res.error_message ?? undefined,
        };
      } catch (error) {
        return {
          ok: false,
          status: 'error',
          message: deps.t('interactive.mcp.oauthFailed', { error: deps.describeRpcError(error) }),
        };
      }
    },

    onCancelMcpOAuth: async (profile, name, sessionId) => {
      const client = deps.getGatewayClient();
      const state = deps.getState();
      if (!client || !state.gatewayConnected) {
        return { ok: false, message: deps.t('settings.notConnected') };
      }
      const targetProfile = profile || state.profileName || 'default';
      try {
        const res = await client.call<McpOauthCancelResult>('mcp.servers.oauth.cancel', {
          profile: targetProfile,
          name: name.trim(),
          session_id: sessionId,
        });
        return res.ok
          ? { ok: true }
          : { ok: false, message: res.error_message || deps.t('settings.loadFailed') };
      } catch (error) {
        return { ok: false, message: deps.describeRpcError(error) };
      }
    },

    onOpenExternalUrl: openExternalUrl,
  };
}
