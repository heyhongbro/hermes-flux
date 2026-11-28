/**
 * 设置中心扩展域（MCP 服务器与技能 Hub）RPC 动作装配器
 *
 * 【设计意图 (Why)】
 *   从 `settingsDataService.ts` 中拆分出 MCP 与技能操作，使单文件行数远离 1500 行门禁，
 *   并全部通过 `getGatewayClient()` / `isConnected()` 路由到当前选中的网关实例。
 */

import {
  normalizeMcpCatalog,
  normalizeMcpTestResult,
  normalizeSkillInspectResult,
  normalizeSkillSearchResults,
  type BotDetailData,
  type HermesGatewayClient,
  type McpServerAddRpcParams,
} from '@hermes-flux/core';
import type { I18nKey, SettingsActions, SettingsLoadable, SkillRow } from '@hermes-flux/ui';

export interface SettingsExtensionsActionsDeps {
  readonly getGatewayClient: () => HermesGatewayClient | null;
  readonly isConnected: () => boolean;
  readonly getFallbackProfile: () => string;
  readonly getActiveBotDetail: () => BotDetailData | undefined;
  readonly getSettingsSkills: () => SettingsLoadable<SkillRow[]>;
  readonly getMcpStatus: () => 'idle' | 'loading' | 'ready' | 'error';
  readonly getSkillsStatus: () => 'idle' | 'loading' | 'ready' | 'error';
  readonly getSection: () => string;
  readonly refreshActiveCapabilities: (
    targetProfile: string,
    opts?: { addedMcpName?: string; removedMcpName?: string },
  ) => Promise<void>;
  readonly loadExtensions: () => Promise<void>;
  readonly t: (key: I18nKey, params?: Record<string, string | number>) => string;
  readonly describeRpcError: (error: unknown) => string;
  readonly bootLog: { warn(message: string, meta?: Record<string, unknown>): void };
}

export function createSettingsExtensionsActions(
  deps: SettingsExtensionsActionsDeps,
): Pick<
  SettingsActions,
  | 'onFetchMcpCatalog'
  | 'onAddMcpServer'
  | 'onRemoveMcpServer'
  | 'onTestMcpServer'
  | 'onSearchSkillsHub'
  | 'onInstallSkill'
  | 'onInspectSkill'
> {
  return {
    onFetchMcpCatalog: async (profile) => {
      const client = deps.getGatewayClient();
      if (!client || !deps.isConnected()) {
        return { ok: false, items: [], message: deps.t('settings.notConnected') };
      }
      const targetProfile = profile || deps.getFallbackProfile() || 'default';
      try {
        const result = await client.request('mcp.catalog', { profile: targetProfile });
        return { ok: true, items: normalizeMcpCatalog(result) };
      } catch (error) {
        return { ok: false, items: [], message: deps.describeRpcError(error) };
      }
    },

    onAddMcpServer: async (profile, params) => {
      const client = deps.getGatewayClient();
      if (!client || !deps.isConnected()) {
        return { ok: false, message: deps.t('settings.notConnected') };
      }
      const targetProfile = profile || deps.getFallbackProfile() || 'default';
      const rpcParams: McpServerAddRpcParams = {
        profile: targetProfile,
        name: params.name,
      };
      if (params.preset) rpcParams.preset = params.preset;
      if (params.config) rpcParams.config = params.config;
      if (params.bearer_token) rpcParams.bearer_token = params.bearer_token;
      try {
        const result = await client.request<{ ok?: boolean; name?: string }>('mcp.servers.add', rpcParams);
        if (result && result.ok === false) {
          return { ok: false, message: deps.t('settings.malformedResponse') };
        }
        const serverName = (typeof result?.name === 'string' && result.name) || params.name;
        await Promise.all([
          deps.refreshActiveCapabilities(targetProfile, { addedMcpName: serverName }),
          deps.getMcpStatus() === 'ready' || deps.getSection() === 'extensions'
            ? deps.loadExtensions()
            : Promise.resolve(),
        ]);
        return { ok: true, name: serverName };
      } catch (error) {
        return { ok: false, message: deps.describeRpcError(error) };
      }
    },

    onRemoveMcpServer: async (profile, name) => {
      const client = deps.getGatewayClient();
      if (!client || !deps.isConnected()) {
        return { ok: false, message: deps.t('settings.notConnected') };
      }
      const targetProfile = profile || deps.getFallbackProfile() || 'default';
      try {
        const result = await client.request<{ ok?: boolean }>('mcp.servers.remove', {
          profile: targetProfile,
          name,
        });
        if (result && result.ok === false) {
          return { ok: false, message: deps.t('settings.malformedResponse') };
        }
        await Promise.all([
          deps.refreshActiveCapabilities(targetProfile, { removedMcpName: name }),
          deps.getMcpStatus() === 'ready' || deps.getSection() === 'extensions'
            ? deps.loadExtensions()
            : Promise.resolve(),
        ]);
        return { ok: true };
      } catch (error) {
        return { ok: false, message: deps.describeRpcError(error) };
      }
    },

    onTestMcpServer: async (profile, name) => {
      const client = deps.getGatewayClient();
      if (!client || !deps.isConnected()) {
        return { ok: false, tools: [], oauthNeeded: false, error: deps.t('settings.notConnected') };
      }
      const targetProfile = profile || deps.getFallbackProfile() || 'default';
      try {
        const result = await client.request('mcp.servers.test', {
          profile: targetProfile,
          name,
        });
        return normalizeMcpTestResult(result);
      } catch (error) {
        return {
          ok: false,
          tools: [],
          oauthNeeded: false,
          error: deps.describeRpcError(error),
        };
      }
    },

    onSearchSkillsHub: async (profile, query, page = 1) => {
      const client = deps.getGatewayClient();
      if (!client || !deps.isConnected()) {
        return { ok: false, message: deps.t('settings.notConnected') };
      }
      const targetProfile = profile || deps.getFallbackProfile() || 'default';
      const trimmed = query.trim();
      try {
        const result = trimmed
          ? await client.request('skills.manage', {
              profile: targetProfile,
              action: 'search',
              query: trimmed,
              page,
              page_size: 20,
            })
          : await client.request('skills.manage', {
              profile: targetProfile,
              action: 'browse',
              page,
              page_size: 20,
            });
        const installed = new Set<string>();
        const activeDetail = deps.getActiveBotDetail();
        if (activeDetail?.id === targetProfile) {
          for (const row of activeDetail.skills.rows) installed.add(row.id);
        }
        const skillsLoad = deps.getSettingsSkills();
        if (skillsLoad.status === 'ready') {
          for (const row of skillsLoad.data) installed.add(row.name);
        }
        return { ok: true, data: normalizeSkillSearchResults(result, installed) };
      } catch (error) {
        return { ok: false, message: deps.describeRpcError(error) };
      }
    },

    onInstallSkill: async (profile, name) => {
      const client = deps.getGatewayClient();
      if (!client || !deps.isConnected()) {
        return { ok: false, message: deps.t('settings.notConnected') };
      }
      const targetProfile = profile || deps.getFallbackProfile() || 'default';
      try {
        const result = await client.request<{ installed?: boolean | null }>('skills.manage', {
          profile: targetProfile,
          action: 'install',
          query: name,
        });
        if (result && result.installed === false) {
          return { ok: false, message: deps.t('settings.malformedResponse') };
        }
        try {
          await client.request('skills.reload', { profile: targetProfile });
        // gate-degrade: 技能已写入磁盘但自动重载失败；记观测日志并允许用户后续手动刷新，不推翻安装成功结局。
        } catch (reloadErr) {
          deps.bootLog.warn('skills.reload after install failed', {
            profile: targetProfile,
            error: deps.describeRpcError(reloadErr),
          });
        }
        await Promise.all([
          deps.refreshActiveCapabilities(targetProfile),
          deps.getSkillsStatus() === 'ready' || deps.getSection() === 'extensions'
            ? deps.loadExtensions()
            : Promise.resolve(),
        ]);
        return { ok: true };
      } catch (error) {
        return { ok: false, message: deps.describeRpcError(error) };
      }
    },

    onInspectSkill: async (profile, skillName, fallbackDescription) => {
      const client = deps.getGatewayClient();
      if (!client || !deps.isConnected()) {
        return { ok: false, message: deps.t('settings.notConnected') };
      }
      const targetProfile = profile || deps.getFallbackProfile() || 'default';
      const trimmedName = skillName.trim();
      if (!trimmedName) {
        return { ok: false, message: deps.t('settings.malformedResponse') };
      }
      const [inspectRes, dispatchRes] = await Promise.allSettled([
        client.request('skills.manage', {
          profile: targetProfile,
          action: 'inspect',
          query: trimmedName,
        }),
        client.request('command.dispatch', {
          name: trimmedName,
          profile: targetProfile,
        }),
      ]);
      if (inspectRes.status === 'rejected' && dispatchRes.status === 'rejected') {
        return { ok: false, message: deps.describeRpcError(inspectRes.reason) };
      }
      return {
        ok: true,
        data: normalizeSkillInspectResult(trimmedName, {
          inspectPayload: inspectRes.status === 'fulfilled' ? inspectRes.value : undefined,
          dispatchPayload: dispatchRes.status === 'fulfilled' ? dispatchRes.value : undefined,
          fallbackDescription,
        }),
      };
    },
  };
}
