/**
 * 认知星图与记忆学习服务 (Learning Service)
 *
 * 【设计意图 (Why)】
 *   将网关 `learning.frames` / `learning.detail` / `learning.edit` / `learning.delete` RPC 封装为
 *   与 UI 表现壳完全解耦的纯控制器，同时供移动端检查舱「记忆」Tab 与 Bot Hub「长期记忆」复用：
 *   1. 使用自增代数令牌 (`framesGen` / `detailGen`) 丢弃乱序迟到的旧响应；
 *   2. 编辑或删除记忆条目后主动重新拉取星图快照，确保计数与连线视图实时对齐。
 *
 * 【防范的历史坑 (Pitfall)】
 *   - 严禁把本服务代码塞进已接近 1500 行上限的 `settingsDataService.ts`，独立拆文件保持 Gate 0 裕度；
 *   - 网关离线或异常时明确落入 `error` 相位并附带可展示错误信息（Failure Is Not Empty）。
 */

import {
  buildConstellationGraph,
  type HermesGatewayClient,
  type LearningDetailResult,
  type LearningFramesResult,
  type LearningMutationResult,
  type LearningNodeKind,
} from '@hermes-flux/core';
import type { I18nKey } from '@hermes-flux/ui';
import type { AppState } from '../state/appState.js';

export interface LearningServiceDeps {
  getState: () => AppState;
  render: () => void;
  getGatewayClient: () => HermesGatewayClient | null;
  t: (key: I18nKey, params?: Record<string, string | number>) => string;
  describeRpcError: (error: unknown) => string;
}

export interface LearningService {
  loadLearningGraph(force?: boolean): Promise<void>;
  loadLearningDetail(id: string): Promise<void>;
  editLearningNode(id: string, content: string): Promise<{ ok: boolean; message?: string }>;
  deleteLearningNode(id: string): Promise<{ ok: boolean; message?: string }>;
}

export function createLearningService(deps: LearningServiceDeps): LearningService {
  let framesGen = 0;
  let detailGen = 0;

  async function loadLearningGraph(force = false): Promise<void> {
    const state = deps.getState();
    if (!force && (state.learningState.status === 'ready' || state.learningState.status === 'loading')) {
      return;
    }

    const client = deps.getGatewayClient();
    if (!client) {
      ++framesGen;
      state.learningState = { status: 'error', message: deps.t('chat.gatewayNotConnected') };
      deps.render();
      return;
    }

    const expectedGen = ++framesGen;
    state.learningState = { status: 'loading' };
    deps.render();

    try {
      const res = await client.call<LearningFramesResult>('learning.frames', {
        cols: 40,
        rows: 16,
        frames: 1,
      });
      if (expectedGen !== framesGen || deps.getGatewayClient() !== client) return;
      deps.getState().learningState = {
        status: 'ready',
        graph: buildConstellationGraph(res),
      };
      deps.render();
    } catch (err) {
      if (expectedGen !== framesGen || deps.getGatewayClient() !== client) return;
      deps.getState().learningState = {
        status: 'error',
        message: deps.describeRpcError(err) || deps.t('mobile.memory.loadError'),
      };
      deps.render();
    }
  }

  async function loadLearningDetail(id: string): Promise<void> {
    const nodeId = id.trim();
    if (!nodeId) return;

    const client = deps.getGatewayClient();
    const state = deps.getState();
    if (!client) {
      ++detailGen;
      state.learningDetail = { status: 'error', id: nodeId, message: deps.t('chat.gatewayNotConnected') };
      deps.render();
      return;
    }

    const expectedGen = ++detailGen;
    state.learningDetail = { status: 'loading', id: nodeId };
    deps.render();

    try {
      const res = await client.call<LearningDetailResult>('learning.detail', { id: nodeId });
      if (expectedGen !== detailGen || deps.getGatewayClient() !== client) return;
      if (!res?.ok) {
        deps.getState().learningDetail = {
          status: 'error',
          id: nodeId,
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
      };
      deps.render();
    } catch (err) {
      if (expectedGen !== detailGen || deps.getGatewayClient() !== client) return;
      deps.getState().learningDetail = {
        status: 'error',
        id: nodeId,
        message: deps.describeRpcError(err) || deps.t('mobile.memory.loadError'),
      };
      deps.render();
    }
  }

  async function editLearningNode(id: string, content: string): Promise<{ ok: boolean; message?: string }> {
    const client = deps.getGatewayClient();
    if (!client) {
      return { ok: false, message: deps.t('chat.gatewayNotConnected') };
    }
    try {
      const res = await client.call<LearningMutationResult>('learning.edit', { id, content });
      if (deps.getGatewayClient() !== client) {
        return { ok: false, message: deps.t('chat.gatewayNotConnected') };
      }
      if (!res?.ok) {
        return { ok: false, message: res?.message || deps.t('settings.loadFailed') };
      }
      await loadLearningDetail(id);
      if (deps.getGatewayClient() !== client) {
        return { ok: true };
      }
      await loadLearningGraph(true);
      return { ok: true };
    } catch (err) {
      return { ok: false, message: deps.describeRpcError(err) };
    }
  }

  async function deleteLearningNode(id: string): Promise<{ ok: boolean; message?: string }> {
    const client = deps.getGatewayClient();
    if (!client) {
      return { ok: false, message: deps.t('chat.gatewayNotConnected') };
    }
    try {
      const res = await client.call<LearningMutationResult>('learning.delete', { id });
      if (deps.getGatewayClient() !== client) {
        return { ok: false, message: deps.t('chat.gatewayNotConnected') };
      }
      if (!res?.ok) {
        return { ok: false, message: res?.message || deps.t('settings.loadFailed') };
      }
      const state = deps.getState();
      if (state.learningDetail.status !== 'idle' && state.learningDetail.id === id) {
        ++detailGen;
        state.learningDetail = { status: 'idle' };
      }
      await loadLearningGraph(true);
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
