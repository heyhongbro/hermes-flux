/**
 * 认知星图与记忆学习服务 (Learning Service)
 *
 * 【设计意图 (Why)】
 *   提供按 `profile` 物理隔离的多 Bot 认知星图读取、详情 inspect 与节点编辑/删除控制器，
 *   同时服务桌面端 BOT 配置中心 / 状态栏直达入口，以及移动端检查舱与 Bot Hub：
 *   1. 首选网关 Profile 隔离 REST 端点（`GET /api/learning/graph?profile=`、`GET/PUT/DELETE /api/learning/node`），
 *      确保每个数字员工严格读取自身 `HERMES_HOME` 下的技能与记忆星图，绝不串台到 `default` Bot；
 *   2. 维护按 `profile` 分桶的内存缓存与自增代际令牌（`framesGen` / `detailGen`），快速切换 Bot 秒开且迟到旧响应必丢弃；
 *   3. 仅当 REST 返回 404/405/501 时分级回退：
 *      - `default` Bot 回退 WS `learning.frames` / `learning.detail` / `learning.edit` / `learning.delete`；
 *      - 非 `default` Bot 严禁调用不带 `profile` 的 `learning.frames`，改为 `profiles.describe({ profile })` + `skills.manage`，
 *        宁可展示纯技能关系图谱也绝不把 `default` Bot 的认知内容冒充给其他 Bot。
 *
 * 【防范的历史坑 (Pitfall)】
 *   - 网关 WS `learning.frames` 契约白名单不含 `profile` 字段，曾导致移动端查看任意 Bot 认知星图全显示 DEFAULT BOT；
 *   - 客户端 `state.learningState` 过去未记录 `profile` 且缓存短路只看 `status === 'ready'`，切 Bot 不重拉；
 *   - 真实网络/鉴权失败（非 404/405/501）必须显式落入 `error` 相位并附带可展示错误信息（Failure Is Not Empty）。
 */

import {
  buildConstellationGraph,
  buildConstellationGraphFromRest,
  buildConstellationGraphFromSkills,
  normalizeLearningProfile,
  normalizeSkillInspectResult,
  parseBotDetail,
  type CompleteSlashResult,
  type ConstellationGraph,
  type HermesGatewayClient,
  type LearningDetailResult,
  type LearningFramesResult,
  type LearningMutationResult,
  type LearningNodeKind,
} from '@hermes-flux/core';
import type { I18nKey } from '@hermes-flux/ui';
import type { HermesDesktopBridge } from '../../preload/index.js';
import {
  createLearningRest,
  isLearningRestEndpointMissing,
  type LearningRest,
} from '../learningRest.js';
import type { AppState } from '../state/appState.js';

export interface LearningServiceDeps {
  getState: () => AppState;
  render: () => void;
  getGatewayClient: () => HermesGatewayClient | null;
  getDesktopApi?: () => HermesDesktopBridge | undefined;
  getCurrentTicket?: () => string | null;
  getEffectiveUrl?: (url?: string) => string;
  learningRest?: LearningRest;
  t: (key: I18nKey, params?: Record<string, string | number>) => string;
  describeRpcError: (error: unknown) => string;
}

export interface LoadLearningGraphOptions {
  profile?: string;
  force?: boolean;
}

export interface LearningService {
  loadLearningGraph(forceOrOptions?: boolean | LoadLearningGraphOptions, profile?: string): Promise<void>;
  loadLearningDetail(id: string, profile?: string): Promise<void>;
  editLearningNode(id: string, content: string, profile?: string): Promise<{ ok: boolean; message?: string }>;
  deleteLearningNode(id: string, profile?: string): Promise<{ ok: boolean; message?: string }>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function createLearningService(deps: LearningServiceDeps): LearningService {
  let framesGen = 0;
  let detailGen = 0;
  let lastClient: HermesGatewayClient | null = null;
  const graphCache = new Map<string, ConstellationGraph>();

  function syncClientFence(client: HermesGatewayClient | null): void {
    if (client === lastClient) return;
    lastClient = client;
    graphCache.clear();
  }

  function resolveRestAdapter(): LearningRest | null {
    if (deps.learningRest) return deps.learningRest;
    const api = deps.getDesktopApi?.();
    if (!api?.httpProxy) return null;
    const rawUrl = deps.getState().gatewayUrl;
    const resolvedUrl = deps.getEffectiveUrl ? deps.getEffectiveUrl(rawUrl) : (rawUrl || '').trim();
    if (!resolvedUrl) return null;
    return createLearningRest({
      baseUrl: () => {
        const currentUrl = deps.getState().gatewayUrl;
        return deps.getEffectiveUrl ? deps.getEffectiveUrl(currentUrl) : (currentUrl || '').trim();
      },
      ticket: () => deps.getCurrentTicket?.() || '',
      proxy: (opts) => api.httpProxy(opts),
    });
  }

  async function fetchProfileSkillsFallback(
    client: HermesGatewayClient,
    targetProfile: string,
  ): Promise<ConstellationGraph> {
    const state = deps.getState();
    const matched = state.profiles.find((p) => p.name.toLowerCase() === targetProfile.toLowerCase());
    const [describeRes, slashRes] = await Promise.all([
      client.call<Record<string, unknown>>('profiles.describe', { profile: targetProfile }),
      client
        .call<CompleteSlashResult>('complete.slash', { text: '/', profile: targetProfile })
        .catch(() => null),
    ]);
    const detail = parseBotDetail(describeRes, {
      id: targetProfile,
      displayName: matched?.displayName || targetProfile,
      avatar: matched?.avatar,
      isDefault: Boolean(matched?.isDefault),
    });
    const descMap = new Map<string, string>();
    if (slashRes && Array.isArray(slashRes.items)) {
      for (const item of slashRes.items) {
        if (item?.kind !== 'skill' || typeof item.text !== 'string' || typeof item.meta !== 'string') continue;
        const name = item.text.replace(/^\/+/, '').trim().toLowerCase();
        const meta = item.meta.trim();
        if (name && meta) descMap.set(name, meta);
      }
    }
    return buildConstellationGraphFromSkills(
      detail.skills.rows
        .filter((row) => row.enabled)
        .map((row) => ({
          id: row.id,
          label: row.label,
          description: row.description || descMap.get(row.id.toLowerCase()),
        })),
      targetProfile,
    );
  }

  async function loadLearningGraph(
    forceOrOptions: boolean | LoadLearningGraphOptions = false,
    explicitProfile?: string,
  ): Promise<void> {
    const force = typeof forceOrOptions === 'boolean' ? forceOrOptions : Boolean(forceOrOptions?.force);
    const optionProfile = typeof forceOrOptions === 'object' ? forceOrOptions?.profile : explicitProfile;

    const state = deps.getState();
    const targetProfile = normalizeLearningProfile(optionProfile ?? state.profileName);
    const client = deps.getGatewayClient();
    syncClientFence(client);

    const activeStateProfile =
      state.learningState.status !== 'idle' && state.learningState.profile
        ? normalizeLearningProfile(state.learningState.profile)
        : undefined;

    if (!force) {
      if (state.learningState.status === 'ready' && activeStateProfile === targetProfile) {
        return;
      }
      if (state.learningState.status === 'loading' && activeStateProfile === targetProfile) {
        return;
      }
      if (client && graphCache.has(targetProfile)) {
        const cached = graphCache.get(targetProfile)!;
        if (
          state.learningDetail.status !== 'idle' &&
          normalizeLearningProfile(state.learningDetail.profile) !== targetProfile
        ) {
          ++detailGen;
          state.learningDetail = { status: 'idle' };
        }
        state.learningState = { status: 'ready', profile: targetProfile, graph: cached };
        deps.render();
        return;
      }
    } else {
      graphCache.delete(targetProfile);
    }

    if (
      state.learningDetail.status !== 'idle' &&
      normalizeLearningProfile(state.learningDetail.profile) !== targetProfile
    ) {
      ++detailGen;
      state.learningDetail = { status: 'idle' };
    }

    if (!client) {
      ++framesGen;
      state.learningState = {
        status: 'error',
        profile: targetProfile,
        message: deps.t('chat.gatewayNotConnected'),
      };
      deps.render();
      return;
    }

    const expectedGen = ++framesGen;
    state.learningState = { status: 'loading', profile: targetProfile };
    deps.render();

    const isDefaultProfile = targetProfile.toLowerCase() === 'default';
    const rest = resolveRestAdapter();

    try {
      let graph: ConstellationGraph;
      if (rest) {
        try {
          const restPayload = await rest.fetchGraph(targetProfile);
          const rawRoot = asRecord(restPayload);
          const rawInner = rawRoot ? (asRecord(rawRoot.graph) ?? asRecord(rawRoot.data) ?? rawRoot) : null;
          const explicitReturnedProfile =
            (typeof rawInner?.profile === 'string' && rawInner.profile.trim()) ||
            (typeof rawRoot?.profile === 'string' && rawRoot.profile.trim()) ||
            '';
          if (
            explicitReturnedProfile &&
            normalizeLearningProfile(explicitReturnedProfile).toLowerCase() !== targetProfile.toLowerCase()
          ) {
            throw new Error(`Profile mismatch: expected ${targetProfile}, got ${explicitReturnedProfile}`);
          }
          graph = buildConstellationGraphFromRest(restPayload, targetProfile);
        } catch (restErr) {
          if (!isLearningRestEndpointMissing(restErr)) {
            throw restErr;
          }
          if (isDefaultProfile) {
            const wsRes = await client.call<LearningFramesResult>('learning.frames', {
              cols: 40,
              rows: 16,
              frames: 1,
            });
            graph = buildConstellationGraph(wsRes, targetProfile);
          } else {
            graph = await fetchProfileSkillsFallback(client, targetProfile);
          }
        }
      } else if (isDefaultProfile) {
        const res = await client.call<LearningFramesResult>('learning.frames', {
          cols: 40,
          rows: 16,
          frames: 1,
        });
        graph = buildConstellationGraph(res, targetProfile);
      } else {
        graph = await fetchProfileSkillsFallback(client, targetProfile);
      }

      if (expectedGen !== framesGen || deps.getGatewayClient() !== client) return;
      graphCache.set(targetProfile, graph);
      deps.getState().learningState = {
        status: 'ready',
        profile: targetProfile,
        graph,
      };
      deps.render();
    } catch (err) {
      if (expectedGen !== framesGen || deps.getGatewayClient() !== client) return;
      deps.getState().learningState = {
        status: 'error',
        profile: targetProfile,
        message: deps.describeRpcError(err) || deps.t('mobile.memory.loadError'),
      };
      deps.render();
    }
  }

  async function fetchSkillDetailWsFallback(
    client: HermesGatewayClient,
    nodeId: string,
    targetProfile: string,
  ): Promise<LearningDetailResult> {
    const skillName = nodeId.replace(/^skill:/i, '').trim();
    const [inspectRes, dispatchRes] = await Promise.allSettled([
      client.call('skills.manage', {
        profile: targetProfile,
        action: 'inspect',
        query: skillName,
      }),
      client.call('command.dispatch', {
        name: skillName,
        profile: targetProfile,
      }),
    ]);
    if (inspectRes.status === 'rejected' && dispatchRes.status === 'rejected') {
      throw inspectRes.reason;
    }
    const view = normalizeSkillInspectResult(skillName, {
      inspectPayload: inspectRes.status === 'fulfilled' ? inspectRes.value : undefined,
      dispatchPayload: dispatchRes.status === 'fulfilled' ? dispatchRes.value : undefined,
    });
    return {
      ok: Boolean(view.markdown || view.description),
      id: nodeId,
      kind: 'skill',
      label: view.name || skillName,
      content: view.markdown || view.description || '',
    };
  }

  async function loadLearningDetail(id: string, explicitProfile?: string): Promise<void> {
    const nodeId = id.trim();
    if (!nodeId) return;

    const client = deps.getGatewayClient();
    syncClientFence(client);
    const state = deps.getState();
    const activeGraphProfile =
      state.learningState.status !== 'idle' ? state.learningState.profile : undefined;
    const targetProfile = normalizeLearningProfile(explicitProfile ?? activeGraphProfile ?? state.profileName);

    if (!client) {
      ++detailGen;
      state.learningDetail = {
        status: 'error',
        id: nodeId,
        profile: targetProfile,
        message: deps.t('chat.gatewayNotConnected'),
      };
      deps.render();
      return;
    }

    const expectedGen = ++detailGen;
    state.learningDetail = { status: 'loading', id: nodeId, profile: targetProfile };
    deps.render();

    const isDefaultProfile = targetProfile.toLowerCase() === 'default';
    const rest = resolveRestAdapter();

    try {
      let res: LearningDetailResult;
      if (rest) {
        try {
          res = await rest.fetchNodeDetail(targetProfile, nodeId);
        } catch (restErr) {
          if (!isLearningRestEndpointMissing(restErr)) {
            throw restErr;
          }
          if (isDefaultProfile) {
            res = await client.call<LearningDetailResult>('learning.detail', { id: nodeId });
          } else if (!nodeId.startsWith('memory:')) {
            res = await fetchSkillDetailWsFallback(client, nodeId, targetProfile);
          } else {
            res = { ok: false, message: deps.t('mobile.memory.loadError') };
          }
        }
      } else if (isDefaultProfile) {
        res = await client.call<LearningDetailResult>('learning.detail', { id: nodeId });
      } else if (!nodeId.startsWith('memory:')) {
        res = await fetchSkillDetailWsFallback(client, nodeId, targetProfile);
      } else {
        res = { ok: false, message: deps.t('mobile.memory.loadError') };
      }

      if (expectedGen !== detailGen || deps.getGatewayClient() !== client) return;
      if (!res?.ok) {
        deps.getState().learningDetail = {
          status: 'error',
          id: nodeId,
          profile: targetProfile,
          message: res?.message || deps.t('mobile.memory.loadError'),
        };
        deps.render();
        return;
      }
      const kind: LearningNodeKind =
        res.kind === 'skill' || (!nodeId.startsWith('memory:') && res.kind !== 'memory')
          ? 'skill'
          : 'memory';
      deps.getState().learningDetail = {
        status: 'ready',
        id: res.id || nodeId,
        kind,
        label: res.label || nodeId,
        content: res.content || '',
        profile: targetProfile,
      };
      deps.render();
    } catch (err) {
      if (expectedGen !== detailGen || deps.getGatewayClient() !== client) return;
      deps.getState().learningDetail = {
        status: 'error',
        id: nodeId,
        profile: targetProfile,
        message: deps.describeRpcError(err) || deps.t('mobile.memory.loadError'),
      };
      deps.render();
    }
  }

  function resolveMutationProfile(explicitProfile?: string): string {
    const state = deps.getState();
    const fromState =
      state.learningState.status !== 'idle' ? state.learningState.profile : undefined;
    return normalizeLearningProfile(explicitProfile ?? fromState ?? state.profileName);
  }

  async function editLearningNode(
    id: string,
    content: string,
    explicitProfile?: string,
  ): Promise<{ ok: boolean; message?: string }> {
    const client = deps.getGatewayClient();
    syncClientFence(client);
    if (!client) {
      return { ok: false, message: deps.t('chat.gatewayNotConnected') };
    }
    const targetProfile = resolveMutationProfile(explicitProfile);
    const isDefaultProfile = targetProfile.toLowerCase() === 'default';
    const rest = resolveRestAdapter();

    try {
      let res: LearningMutationResult;
      if (rest) {
        try {
          res = await rest.editNode(targetProfile, id, content);
        } catch (restErr) {
          if (!isLearningRestEndpointMissing(restErr)) throw restErr;
          if (!isDefaultProfile) {
            return { ok: false, message: deps.t('mobile.memory.profileWriteUnsupported') };
          }
          res = await client.call<LearningMutationResult>('learning.edit', { id, content });
        }
      } else {
        if (!isDefaultProfile) {
          return { ok: false, message: deps.t('mobile.memory.profileWriteUnsupported') };
        }
        res = await client.call<LearningMutationResult>('learning.edit', { id, content });
      }

      if (deps.getGatewayClient() !== client) {
        return { ok: false, message: deps.t('chat.gatewayNotConnected') };
      }
      if (!res?.ok) {
        return { ok: false, message: res?.message || deps.t('settings.loadFailed') };
      }
      graphCache.delete(targetProfile);
      await loadLearningDetail(id, targetProfile);
      if (deps.getGatewayClient() !== client) {
        return { ok: true };
      }
      await loadLearningGraph({ profile: targetProfile, force: true });
      return { ok: true };
    } catch (err) {
      return { ok: false, message: deps.describeRpcError(err) };
    }
  }

  async function deleteLearningNode(
    id: string,
    explicitProfile?: string,
  ): Promise<{ ok: boolean; message?: string }> {
    const client = deps.getGatewayClient();
    syncClientFence(client);
    if (!client) {
      return { ok: false, message: deps.t('chat.gatewayNotConnected') };
    }
    const targetProfile = resolveMutationProfile(explicitProfile);
    const isDefaultProfile = targetProfile.toLowerCase() === 'default';
    const rest = resolveRestAdapter();

    try {
      let res: LearningMutationResult;
      if (rest) {
        try {
          res = await rest.deleteNode(targetProfile, id);
        } catch (restErr) {
          if (!isLearningRestEndpointMissing(restErr)) throw restErr;
          if (!isDefaultProfile) {
            return { ok: false, message: deps.t('mobile.memory.profileWriteUnsupported') };
          }
          res = await client.call<LearningMutationResult>('learning.delete', { id });
        }
      } else {
        if (!isDefaultProfile) {
          return { ok: false, message: deps.t('mobile.memory.profileWriteUnsupported') };
        }
        res = await client.call<LearningMutationResult>('learning.delete', { id });
      }

      if (deps.getGatewayClient() !== client) {
        return { ok: false, message: deps.t('chat.gatewayNotConnected') };
      }
      if (!res?.ok) {
        return { ok: false, message: res?.message || deps.t('settings.loadFailed') };
      }
      graphCache.delete(targetProfile);
      const state = deps.getState();
      if (state.learningDetail.status !== 'idle' && state.learningDetail.id === id) {
        ++detailGen;
        state.learningDetail = { status: 'idle' };
      }
      await loadLearningGraph({ profile: targetProfile, force: true });
      return { ok: true };
    } catch (err) {
      return { ok: false, message: deps.describeRpcError(err) };
    }
  }

  return {
    loadLearningGraph,
    loadLearningDetail,
    editLearningNode,
    deleteLearningNode,
  };
}
