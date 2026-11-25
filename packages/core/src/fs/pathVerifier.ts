/**
 * 成果物候选路径父目录批量物理存在性核验服务 (packages/core/src/fs/pathVerifier.ts)
 *
 * 【设计意图 (Why)】
 *   Hermes Gateway 没有 `artifacts.*` 原生聚合接口；Agent 运行脚本（如 Python/Shell）生成的图表与文件，
 *   有时只在回复正文里以反引号（如 `` `/opt/data/.../t3-timeline.png` ``）提及。
 *   为实现「不漏掉真实生成的文件，也绝不把示例代码路径或已删假路径误判为成果物」，
 *   本服务将同父目录下的候选路径折叠去重，通过本地 PAL `listDirectory` 或网关 `GET /api/files` / `/api/fs/list`
 *   一次性核验该目录下所有文件是否真实存在且非目录。
 *
 * 【防范的历史坑 (Pitfall)】
 *   1. 防循环自证铁律：调用 `resolveWorkspaceDirectory` 绝不允许传入 `fallbackPaths`，
 *      且严格只认 `source === 'local_fs' | 'gateway_api'` 物理结果，`session_cache` 一律丢弃；
 *   2. 同一目录下多份成果物与多次渲染绝不能重复打爆网关：内置有界 LRU 缓存（上限 128 个目录）与 in-flight 并发合并。
 *
 * 【约束与规则 (Rules)】
 *   - 零 DOM / React / Node 原生依赖；
 *   - 单文件探测失败必须静默降级为空集合，绝不阻塞主对话渲染。
 */

import type { IPlatformBridge } from '../pal/IPlatformBridge.js';
import { isExcludedSystemOrPlaceholderPath, normalizeDeliverableKey } from '../session/deliverables.js';
import { extractParentDirectoryPath } from './directoryPickerService.js';
import { extractPathBasename, joinWorkspacePath, normalizeWorkspacePath, resolveWorkspaceDirectory } from './fileTreeService.js';

const MAX_DIR_CACHE_ENTRIES = 128;

export interface PathVerifierScope {
  gatewayUrl?: string;
  profile?: string;
  cwd?: string;
}

export interface DirectoryPathVerifierDeps {
  getPlatformBridge: () => Pick<IPlatformBridge, 'listDirectory' | 'httpProxy'> | null | undefined;
}

export interface DirectoryPathVerifier {
  verifyPathsExist(candidatePaths: readonly string[], scope?: PathVerifierScope): Promise<string[]>;
  clear(): void;
}

interface CandidateDirBinding {
  originalPath: string;
  normalizedPath: string;
  parentDir: string;
  fileName: string;
}

function isAbsoluteWorkspacePath(raw: string): boolean {
  return raw.startsWith('/') || /^[A-Za-z]:\//.test(raw);
}

function resolveCandidateBinding(rawPath: string, cwd?: string): CandidateDirBinding | null {
  const key = normalizeDeliverableKey(rawPath);
  if (!key || isExcludedSystemOrPlaceholderPath(key)) return null;
  const resolved = !isAbsoluteWorkspacePath(key) && cwd
    ? joinWorkspacePath(cwd, key)
    : normalizeWorkspacePath(key);
  if (!resolved) return null;
  const parentDir = extractParentDirectoryPath(resolved);
  const fileName = extractPathBasename(resolved);
  if (!parentDir || !fileName) return null;
  return {
    originalPath: rawPath,
    normalizedPath: resolved,
    parentDir,
    fileName,
  };
}

/**
 * 将候选文件路径按父目录分组去重，使同一目录下的 N 个候选路径只需发起 1 次目录列举请求。
 */
export function groupPathsByParentDir(paths: readonly string[], cwd?: string): Map<string, string[]> {
  const grouped = new Map<string, string[]>();
  const seenPerDir = new Map<string, Set<string>>();

  for (const raw of paths) {
    const binding = resolveCandidateBinding(raw, cwd);
    if (!binding) continue;
    let bucket = grouped.get(binding.parentDir);
    let dedup = seenPerDir.get(binding.parentDir);
    if (!bucket || !dedup) {
      bucket = [];
      dedup = new Set<string>();
      grouped.set(binding.parentDir, bucket);
      seenPerDir.set(binding.parentDir, dedup);
    }
    if (!dedup.has(binding.originalPath)) {
      dedup.add(binding.originalPath);
      bucket.push(binding.originalPath);
    }
  }

  return grouped;
}

/**
 * 创建带并发去重与有界 LRU 目录缓存的路径实证核验器。
 */
export function createDirectoryPathVerifier(deps: DirectoryPathVerifierDeps): DirectoryPathVerifier {
  const dirFileCache = new Map<string, ReadonlySet<string>>();
  const inflight = new Map<string, Promise<ReadonlySet<string>>>();

  async function listVerifiedFilenamesInDir(
    parentDir: string,
    scope: PathVerifierScope,
  ): Promise<ReadonlySet<string>> {
    const gw = (scope.gatewayUrl || '').trim();
    const profile = (scope.profile || '').trim();
    const cacheKey = `${gw}|${profile}|${parentDir}`;

    const cached = dirFileCache.get(cacheKey);
    if (cached) {
      dirFileCache.delete(cacheKey);
      dirFileCache.set(cacheKey, cached);
      return cached;
    }

    const pending = inflight.get(cacheKey);
    if (pending) return pending;

    const task = (async (): Promise<ReadonlySet<string>> => {
      try {
        const bridge = deps.getPlatformBridge();
        if (!bridge) return new Set<string>();
        // 【防循环自证】严禁传入 fallbackPaths 与 completePath，只接纳物理存储层实证
        const res = await resolveWorkspaceDirectory(parentDir, {
          platformBridge: bridge,
          gatewayUrl: gw || undefined,
          profile: profile || undefined,
        });
        if ('error' in res || (res.source !== 'local_fs' && res.source !== 'gateway_api')) {
          return new Set<string>();
        }
        const names = new Set<string>();
        for (const node of res.nodes) {
          if (!node.isDirectory && node.name) {
            names.add(node.name);
          }
        }
        if (dirFileCache.size >= MAX_DIR_CACHE_ENTRIES) {
          const oldest = dirFileCache.keys().next().value;
          if (oldest) dirFileCache.delete(oldest);
        }
        dirFileCache.set(cacheKey, names);
        return names;
      // gate-degrade: 单次目录实证失败属于外设/权限正常边界，降级为空集不阻断主流程
      } catch {
        return new Set<string>();
      } finally {
        inflight.delete(cacheKey);
      }
    })();

    inflight.set(cacheKey, task);
    return task;
  }

  async function verifyPathsExist(
    candidatePaths: readonly string[],
    scope: PathVerifierScope = {},
  ): Promise<string[]> {
    if (!candidatePaths || candidatePaths.length === 0) return [];
    const grouped = groupPathsByParentDir(candidatePaths, scope.cwd);
    if (grouped.size === 0) return [];

    const dirEntries = await Promise.all(
      Array.from(grouped.keys()).map(async (parentDir) => {
        const existingNames = await listVerifiedFilenamesInDir(parentDir, scope);
        return [parentDir, existingNames] as const;
      }),
    );
    const existingByDir = new Map<string, ReadonlySet<string>>(dirEntries);

    const verified: string[] = [];
    for (const raw of candidatePaths) {
      const binding = resolveCandidateBinding(raw, scope.cwd);
      if (!binding) continue;
      const names = existingByDir.get(binding.parentDir);
      if (names?.has(binding.fileName)) {
        verified.push(raw);
      }
    }
    return verified;
  }

  function clear(): void {
    dirFileCache.clear();
  }

  return {
    verifyPathsExist,
    clear,
  };
}
