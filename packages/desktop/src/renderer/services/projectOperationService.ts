/**
 * Hermes Flux 项目树管理与会话归属服务（Project Operation Service）
 *
 * 【设计意图 (Why)】
 *   将工程项目列表拉取、官方契约与 raw 接口兼容解析、项目与会话关联判定、
 *   以及专职智能体主工位与最新动态同步（syncProfileLastMessages）彻底从 index.ts 中解耦。
 *   使项目树生命周期与实体领域逻辑能够脱离宿主 DOM 运行，具备可单测性与单向依赖纯度。
 *
 * 【防范的历史坑 (Pitfall)】
 *   1. Failure Is Not Empty：网络或网关故障时绝不可将 state.projects 抹杀为空数组伪装成没有项目，
 *      必须保留上一轮拉取到的有效项目列表或提示错误，严禁静默覆盖为权威空；
 *   2. 历史上曾经在扫描普通会话池（state.sessions）拿取最新普通会话覆盖 Bot 卡片，
 *      导致用户在专职主工位聊天时，左上角卡片显示着另一个旁聊会话的时间和文案；
 *      因此 syncProfileLastMessages 必须仅且必须依据专职 Bot 本身主工位（Forever Chat）与活动记录同步；
 *   3. 官方契约容错兜底：若 ProjectService.listProjects 返回空，必须兜底尝试无参 projects.list，
 *      吸收不同版本网关在 projects 字段与 data 字段上的包装差异。
 *
 * 【约束与规则 (Rules)】
 *   1. 单向依赖：严禁反向 import index.js，所有外部状态读写与 UI 渲染通过 ProjectOperationDeps 注入；
 *   2. 严格类型约束：0 TS 报错，严禁使用 `as any`；
 *   3. 零文本写死：异常日志与提示保持标准格式。
 */

import type { AppState } from '../state/appState.js';
import {
  type HermesGatewayClient,
  type ProjectSummary,
  ProjectService,
  syncBotProfiles,
} from '@hermes-flux/core';
import type { MessageViewModel } from '@hermes-flux/ui';
import type { BotActivityStore } from '../persistence/botActivityStore.js';

export interface ProjectRawRecord {
  id?: string;
  projectId?: string;
  name?: string;
  slug?: string;
  board_slug?: string;
  boardSlug?: string;
  primary_path?: string;
  primaryPath?: string;
  path?: string;
  additional_folders?: string[];
  additionalFolders?: string[];
  icon?: string;
  color?: string;
  archived?: boolean;
}

export interface ProjectsListResponse {
  projects?: ProjectRawRecord[];
  data?: ProjectRawRecord[];
}

export interface ProjectOperationDeps {
  readonly getState: () => AppState;
  readonly getGatewayClient: () => HermesGatewayClient | null;
  readonly render: () => void;
  readonly botActivityStore: BotActivityStore;
  readonly botForeverChatCache: Map<string, string>;
  readonly sessionMessagesCache: Map<string, MessageViewModel[]>;
  readonly formatSessionTime: (timestamp: number) => string;
}

export interface ProjectOperationService {
  fetchProjects(): Promise<void>;
  createProject(params: { name: string; path: string }): Promise<{ ok: boolean; message?: string }>;
  updateProject(
    projectId: string,
    patch: { name?: string; path?: string; boardSlug?: string },
  ): Promise<{ ok: boolean; message?: string }>;
  deleteProject(projectId: string): Promise<{ ok: boolean; message?: string }>;
  syncProfileLastMessages(): void;
  getProjectService(): ProjectService;
}

export function createProjectOperationService(deps: ProjectOperationDeps): ProjectOperationService {
  const projectService = new ProjectService();

  function syncProfileLastMessages(): void {
    const state = deps.getState();
    deps.botActivityStore.withActivityMap((activityMap) => {
      state.profiles = syncBotProfiles({
        profiles: state.profiles,
        activityMap,
        foreverChatCache: deps.botForeverChatCache,
        sessionMessagesCache: deps.sessionMessagesCache,
        formatTime: deps.formatSessionTime,
      });
    });
  }

  async function fetchProjects(): Promise<void> {
    const client = deps.getGatewayClient();
    if (!client) return;
    const state = deps.getState();
    if (!state.settingsProjects || state.settingsProjects.status === 'idle') {
      state.settingsProjects = { status: 'loading' };
      deps.render();
    }
    try {
      let authoritative = false;
      let summaries: ProjectSummary[] = [];

      try {
        summaries = await projectService.listProjects(client, true);
        authoritative = true;
      } catch {
        // 容错兜底：若 Service 解析失败，尝试无参 raw 契约解析；结构非法时仍抛错触发 Failure Is Not Empty
        const rawRes = await client.call<ProjectsListResponse>('projects.list', {});
        const rawList = Array.isArray(rawRes?.projects)
          ? rawRes.projects
          : Array.isArray(rawRes?.data)
          ? rawRes.data
          : null;
        if (!rawList) {
          throw new Error('Malformed projects.list response: expected projects array');
        }
        authoritative = true;
        summaries = rawList.map((p) => {
          const boardSlug = p.boardSlug ?? p.board_slug;
          const additionalFolders = Array.isArray(p.additionalFolders)
            ? p.additionalFolders
            : Array.isArray(p.additional_folders)
              ? p.additional_folders
              : [];
          return {
            projectId: String(p.id || p.projectId || ''),
            name: String(p.name || p.id || 'Project'),
            slug: String(p.slug || p.name || p.id || 'project'),
            primaryPath: String(p.primary_path || p.primaryPath || p.path || ''),
            additionalFolders,
            ...(typeof boardSlug === 'string' && boardSlug ? { boardSlug } : {}),
            ...(typeof p.icon === 'string' && p.icon ? { icon: p.icon } : {}),
            ...(typeof p.color === 'string' && p.color ? { color: p.color } : {}),
            isActive: false,
            archived: Boolean(p.archived),
            createdAt: Date.now(),
            updatedAt: Date.now(),
          };
        });
      }

      if (authoritative) {
        const activeProjects = summaries
          .filter((s) => !s.archived && Boolean(s.projectId))
          .map((s) => ({
            id: s.projectId,
            name: s.name,
            path: s.primaryPath,
            ...(s.additionalFolders.length > 0 ? { additionalFolders: s.additionalFolders } : {}),
            ...(s.boardSlug ? { boardSlug: s.boardSlug } : {}),
            ...(s.icon ? { icon: s.icon } : {}),
            ...(s.color ? { color: s.color } : {}),
            archived: false,
          }));
        state.projects = activeProjects;
        state.settingsProjects = {
          status: 'ready',
          data: activeProjects.map((p) => ({
            id: p.id,
            name: p.name,
            path: p.path || '',
            ...(p.additionalFolders ? { additionalFolders: p.additionalFolders } : {}),
            ...(p.boardSlug ? { boardSlug: p.boardSlug } : {}),
            ...(p.icon ? { icon: p.icon } : {}),
            ...(p.color ? { color: p.color } : {}),
            archived: false,
          })),
        };
      }

      deps.render();
    } catch (e) {
      // Failure Is Not Empty: 网络或网关故障时绝不可将 state.projects 抹杀为空数组伪装成没有项目
      console.warn('[Flux] fetchProjects failed:', e);
      if (state.settingsProjects?.status !== 'ready') {
        state.settingsProjects = {
          status: 'error',
          message: e instanceof Error ? e.message : String(e),
        };
      }
      deps.render();
    }
  }

  async function createProject(params: { name: string; path: string }): Promise<{ ok: boolean; message?: string }> {
    const client = deps.getGatewayClient();
    if (!client) {
      return { ok: false, message: 'Gateway not connected' };
    }
    try {
      await projectService.createProject(
        { name: params.name.trim(), path: params.path.trim() },
        client,
        'default',
      );
      await fetchProjects();
      return { ok: true };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  async function updateProject(
    projectId: string,
    patch: { name?: string; path?: string; boardSlug?: string },
  ): Promise<{ ok: boolean; message?: string }> {
    const client = deps.getGatewayClient();
    if (!client) {
      return { ok: false, message: 'Gateway not connected' };
    }
    try {
      await projectService.updateProject(
        projectId,
        {
          ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
          ...(patch.boardSlug !== undefined ? { board_slug: patch.boardSlug } : {}),
        },
        client,
      );
      await fetchProjects();
      return { ok: true };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  async function deleteProject(projectId: string): Promise<{ ok: boolean; message?: string }> {
    const client = deps.getGatewayClient();
    if (!client) {
      return { ok: false, message: 'Gateway not connected' };
    }
    try {
      await projectService.deleteProject(projectId, client, 'default');
      await fetchProjects();
      return { ok: true };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  return {
    fetchProjects,
    createProject,
    updateProject,
    deleteProject,
    syncProfileLastMessages,
    getProjectService: () => projectService,
  };
}
