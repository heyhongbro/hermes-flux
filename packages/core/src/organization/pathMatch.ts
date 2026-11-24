/**
 * 跨平台路径归一化与最长前缀项目匹配（零 DOM / 零 Node fs 依赖）
 *
 * 【设计意图 (Why)】
 *   会话的物理工作目录 cwd 来自网关 state.db，可能包含 Windows 反斜杠、尾斜杠、混合大小写
 *   或指向项目子目录。必须用纯函数精确裁决它是否归属于某个 Project。
 *
 * 【防范的历史坑 (Pitfall)】
 *   1. 字符串 startsWith 漏洞：`/work/app-v2` 绝不能误匹配 `/work/app`！必须校验严格目录边界；
 *   2. 嵌套项目抢占：父仓库 `/work/mono` 与子包项目 `/work/mono/packages/ui` 共存时，
 *      必须按归一化路径长度取最长前缀匹配，而非数组遍历首个命中；
 *   3. 归档项目污染：已归档（`archived === true`）的项目禁止再自动吸纳会话。
 *
 * 【约束与规则 (Rules)】
 *   - 复用 project/sessionProjectMatcher 中的路径清洗思路，Windows 盘符路径不区分大小写，POSIX 保留大小写；
 *   - 所有导出均为确定性纯函数。
 */

import { normalizeWorkspacePath } from '../fs/fileTreeService.js';

export interface OrgProjectPathCandidate {
  id: string;
  primaryPath?: string;
  /** 兼容 UI/Renderer 层的 `LeftRailProject.path` 字段（与 `primaryPath` 等价，防止仅传 `path` 时静默失配）。 */
  path?: string;
  additionalFolders?: readonly string[];
  archived?: boolean;
}

const WINDOWS_DRIVE_RE = /^[a-zA-Z]:(?:\/|$)/;

/**
 * 规范化目录路径用于精确比较与目录前缀匹配（自动消解 `.` / `..` 词法穿越段）。
 */
export function normalizePathForMatch(rawPath?: string): string {
  if (!rawPath || typeof rawPath !== 'string') return '';
  let normalized = normalizeWorkspacePath(rawPath);
  if (!normalized || normalized === '.') return '';

  if (/^[a-zA-Z]:$/.test(normalized)) {
    normalized = `${normalized}/`;
  }

  if (WINDOWS_DRIVE_RE.test(normalized)) {
    normalized = normalized.toLowerCase();
  }
  return normalized;
}

/**
 * 检查规范化后的 cwd 是否处于规范化后的 projectPath 内（等于或其子目录），严格防御前缀溢出。
 */
export function isPathWithinDirectory(normCwd: string, normDir: string): boolean {
  if (!normCwd || !normDir) return false;
  if (normCwd === normDir) return true;
  if (normDir === '/') return normCwd.startsWith('/');
  if (normDir.endsWith('/')) return normCwd.startsWith(normDir);
  return normCwd.startsWith(`${normDir}/`);
}

/**
 * 根据会话 cwd 在活跃项目中执行最长前缀匹配，未命中返回 null。
 */
export function matchProjectByCwd(
  cwd: string | undefined,
  projects: ReadonlyArray<OrgProjectPathCandidate>
): string | null {
  const normCwd = normalizePathForMatch(cwd);
  if (!normCwd) return null;

  let bestProjectId: string | null = null;
  let bestLength = -1;

  for (const project of projects) {
    if (!project?.id || project.archived) continue;
    const candidates: Array<string | undefined> = [
      project.primaryPath,
      project.path,
      ...(project.additionalFolders ?? []),
    ];
    for (const rawCandidate of candidates) {
      const normCandidate = normalizePathForMatch(rawCandidate);
      if (!normCandidate) continue;
      if (isPathWithinDirectory(normCwd, normCandidate) && normCandidate.length > bestLength) {
        bestLength = normCandidate.length;
        bestProjectId = project.id;
      }
    }
  }

  return bestProjectId;
}
