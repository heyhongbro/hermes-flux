/**
 * 项目工作目录树浏览与文件夹管理纯服务 (packages/core/src/fs/directoryPickerService.ts)
 *
 * 【设计意图 (Why)】
 *   为桌面端与移动端「设置 → 项目」提供统一的交互式目录树浏览、选中、直接新建文件夹与重命名能力，
 *   让用户不必在 `cwd` 输入框盲输路径即可可视化定位或就地整理项目目录。
 *
 * 【防范的历史坑 (Pitfall)】
 *   1. 远程非回环网关（如云端 Linux `/opt/data`）与本机（如 Windows）文件系统完全隔离：
 *      远程模式下严禁回落调用本地 `listDirectory` / `createDirectory`，防止把本机目录误当成远端 cwd；
 *   2. 网关 `/api/files` 未命中时某些反代会返回 200 OK + Dashboard SPA HTML，必须由 `isSpaFallbackHtml` 拦截；
 *   3. 目录名未做单段清洗直接拼接或传入 shell 会引发 `..` 越界、命令注入或覆盖已有目录（`-n`/`-e` 守卫）；
 *   4. 锁定根目录（如 `locked_root=/opt/data`）与系统敏感根目录严禁被重命名，否则会破坏宿主目录结构。
 *
 * 【约束与规则 (Rules)】
 *   - 纯 TypeScript 无界逻辑，零 DOM / React / Node 原生模块依赖，全部传输经 PAL 与回调注入；
 *   - 失败显式返回 `{ ok: false, error }`（Failure Is Not Empty），绝不静默伪造空列表或成功态。
 */

import type { IPlatformBridge } from '../pal/IPlatformBridge.js';
import { isPathWithinDirectory, normalizePathForMatch } from '../organization/pathMatch.js';
import { isSpaFallbackHtml } from './fileService.js';
import {
  extractPathBasename,
  isLoopbackGatewayUrl,
  joinWorkspacePath,
  normalizeWorkspacePath,
  parseGatewayFilesPayload,
} from './fileTreeService.js';

export interface ProjectDirectoryEntry {
  name: string;
  path: string;
}

export type ProjectDirectorySource = 'gateway_api' | 'local_fs';

export type BrowseProjectDirectoryResult =
  | {
      ok: true;
      currentPath: string;
      rootPath: string;
      parentPath: string | null;
      lockedRoot: string | null;
      defaultCwd: string | null;
      entries: ProjectDirectoryEntry[];
      source: ProjectDirectorySource;
      canCreate: boolean;
      canRename: boolean;
    }
  | {
      ok: false;
      error: string;
    };

export type ProjectDirectoryMutationResult =
  | { ok: true; path: string }
  | { ok: false; error: string };

export interface DirectoryNameValidationResult {
  ok: true;
  name: string;
}

export interface DirectoryNameValidationError {
  ok: false;
  reason: 'empty' | 'invalid_chars' | 'reserved' | 'secret';
}

export interface ProjectDirectoryServiceOptions {
  platformBridge?: Pick<
    IPlatformBridge,
    'listDirectory' | 'httpProxy' | 'createDirectory' | 'renameDirectory'
  > | null;
  gatewayUrl?: string;
  profile?: string;
  source?: ProjectDirectorySource;
  lockedRoot?: string | null;
  execShell?: (
    command: string,
    profile?: string,
  ) => Promise<{ stdout?: string; stderr?: string; code?: number }>;
}

const INVALID_SEGMENT_RE = /[<>:"|?*\0\r\n/\\]/;

function compareCodePoint(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function isEnvSecretFolderName(name: string): boolean {
  const lower = name.trim().toLowerCase();
  return lower === '.env' || (lower.startsWith('.env.') && lower !== '.env.example');
}

/**
 * 校验待新建或重命名的单个目录名，拦截空串、`.`/`..`、斜杠、控制字符及 `.env*`。
 */
export function validateDirectoryName(
  rawName: string,
): DirectoryNameValidationResult | DirectoryNameValidationError {
  const name = String(rawName ?? '').trim();
  if (!name) {
    return { ok: false, reason: 'empty' };
  }
  if (name === '.' || name === '..') {
    return { ok: false, reason: 'reserved' };
  }
  if (INVALID_SEGMENT_RE.test(name) || /[\x00-\x1f]/.test(name)) {
    return { ok: false, reason: 'invalid_chars' };
  }
  if (isEnvSecretFolderName(name)) {
    return { ok: false, reason: 'secret' };
  }
  return { ok: true, name };
}

/** POSIX sh 单引号安全转义（禁止 shell 元字符注入与换行政令）。 */
export function posixQuoteShellArg(value: string): string {
  const str = String(value ?? '');
  if (/[\0\r\n]/.test(str)) {
    throw new Error('Path contains disallowed control characters');
  }
  return `'${str.replace(/'/g, `'\\''`)}'`;
}

/** 提取归一化父目录路径；根目录 `/` 或盘符根 `C:/` 返回空串 `''`。 */
export function extractParentDirectoryPath(rawPath: string): string {
  const norm = normalizeWorkspacePath(rawPath);
  if (!norm || norm === '/' || /^[A-Za-z]:\/$/.test(norm)) return '';
  const idx = norm.lastIndexOf('/');
  if (idx < 0) return '';
  if (idx === 0) return '/';
  const parent = norm.slice(0, idx);
  return /^[A-Za-z]:$/.test(parent) ? `${parent}/` : parent;
}

/** 判断目标目录是否属于系统敏感根目录或网关 `locked_root` 本身（禁止重命名）。 */
export function isProtectedRootDirectory(
  rawPath: string,
  lockedRoot?: string | null,
): boolean {
  const norm = normalizeWorkspacePath(rawPath);
  if (!norm || norm === '/' || /^[A-Za-z]:\/$/.test(norm)) return true;

  if (lockedRoot) {
    const normLocked = normalizePathForMatch(lockedRoot);
    if (normLocked && normalizePathForMatch(norm) === normLocked) {
      return true;
    }
  }

  const lower = norm.toLowerCase();
  const unixLike = lower.replace(/^[a-z]:/, '');
  const forbiddenSubtrees = ['/etc', '/proc', '/sys', '/dev', '/root'];
  if (forbiddenSubtrees.some((prefix) => unixLike === prefix || unixLike.startsWith(`${prefix}/`))) {
    return true;
  }
  const forbiddenExactRoots = ['/opt', '/usr', '/bin', '/sbin', '/var', '/home', '/users', 'c:/users', 'c:/windows', 'c:/program files', 'c:/program files (x86)'];
  if (forbiddenExactRoots.includes(lower)) return true;
  if (
    lower.startsWith('c:/windows/') ||
    lower.startsWith('c:/program files/') ||
    lower.startsWith('c:/program files (x86)/')
  ) {
    return true;
  }
  return false;
}

function hasTraversalSegment(rawPath: string): boolean {
  return String(rawPath || '')
    .replace(/\\/g, '/')
    .split('/')
    .some((seg) => seg === '.' || seg === '..');
}

function validateMkdirProxyResponse(
  raw: unknown,
  fallbackPath: string,
  lockedRoot?: string | null,
): ProjectDirectoryMutationResult {
  if (typeof raw === 'string') {
    if (isSpaFallbackHtml(raw, '/api/files/mkdir')) {
      return { ok: false, error: 'Gateway returned HTML fallback page for /api/files/mkdir' };
    }
    const obj = parseJsonObjectSafely(raw, '/api/files/mkdir');
    if (!obj) {
      return { ok: false, error: 'Gateway returned invalid non-JSON response for /api/files/mkdir' };
    }
    return validateMkdirProxyResponse(obj, fallbackPath, lockedRoot);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'Gateway returned invalid /api/files/mkdir response' };
  }
  const obj = raw as Record<string, unknown>;
  if (obj.ok === false || typeof obj.error === 'string' || typeof obj.detail === 'string') {
    const errText =
      (typeof obj.error === 'string' && obj.error.trim()) ||
      (typeof obj.detail === 'string' && obj.detail.trim()) ||
      (typeof obj.message === 'string' && obj.message.trim()) ||
      'Failed to create directory';
    return { ok: false, error: errText };
  }
  const returnedPath =
    typeof obj.path === 'string' && obj.path.trim() ? normalizeWorkspacePath(obj.path) : fallbackPath;
  if (
    lockedRoot &&
    !isPathWithinDirectory(normalizePathForMatch(returnedPath), normalizePathForMatch(lockedRoot))
  ) {
    return { ok: false, error: 'PATH_OUTSIDE_LOCKED_ROOT' };
  }
  return { ok: true, path: returnedPath };
}

function parseJsonObjectSafely(raw: unknown, probePath: string): Record<string, unknown> | null {
  if (!raw) return null;
  let parsed = raw;
  if (typeof raw === 'string') {
    if (isSpaFallbackHtml(raw, probePath)) return null;
    try {
      parsed = JSON.parse(raw);
    // gate-degrade: 非 JSON 响应或空体按 null 降级，交由上层 parseGatewayFilesPayload 或 Fallback 显式报错
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}

function toDirectoryEntries(
  items: ReadonlyArray<{ name: string; path: string; isDirectory: boolean }>,
): ProjectDirectoryEntry[] {
  const byPath = new Map<string, ProjectDirectoryEntry>();
  for (const item of items) {
    if (!item.isDirectory) continue;
    const normPath = normalizeWorkspacePath(item.path);
    const cleanName = (item.name || extractPathBasename(normPath)).trim();
    if (!normPath || !cleanName || cleanName === '.' || cleanName === '..' || cleanName === '.git') {
      continue;
    }
    if (!byPath.has(normPath)) {
      byPath.set(normPath, { name: cleanName, path: normPath });
    }
  }
  return Array.from(byPath.values()).sort(
    (a, b) => compareCodePoint(a.name, b.name) || compareCodePoint(a.path, b.path),
  );
}

function deriveLocalRoot(dirPath: string, entries: ReadonlyArray<ProjectDirectoryEntry>): string {
  const normDir = normalizeWorkspacePath(dirPath);
  if (normDir) return normDir;
  const first = entries[0]?.path;
  if (!first) return '';
  return extractParentDirectoryPath(first);
}

/**
 * 浏览指定目录的直接子目录列表。
 * 远程非回环网关仅走网关接口；回环本地网关在网关接口不可用时允许回退本地 PAL。
 */
export async function browseProjectDirectory(
  dirPath = '',
  options: ProjectDirectoryServiceOptions = {},
): Promise<BrowseProjectDirectoryResult> {
  if (dirPath.trim() && hasTraversalSegment(dirPath)) {
    return { ok: false, error: 'INVALID_DIRECTORY_PATH' };
  }
  const normTarget = normalizeWorkspacePath(dirPath);
  const bridge = options.platformBridge;
  const gatewayUrl = (options.gatewayUrl || '').trim();
  const profile = (options.profile || 'default').trim() || 'default';
  const isLoopback = !gatewayUrl || isLoopbackGatewayUrl(gatewayUrl);
  let lastError = '';

  if (bridge?.httpProxy && gatewayUrl) {
    let defaultCwd: string | null = null;
    if (!normTarget) {
      try {
        const cwdRaw = await bridge.httpProxy({
          baseUrl: gatewayUrl,
          path: '/api/fs/default-cwd',
          method: 'GET',
          params: { profile },
        });
        const cwdObj = parseJsonObjectSafely(cwdRaw, 'default-cwd.json');
        if (cwdObj && typeof cwdObj.cwd === 'string' && cwdObj.cwd.trim()) {
          defaultCwd = normalizeWorkspacePath(cwdObj.cwd);
        }
      // gate-degrade: default-cwd 仅作初始展开建议，失败时不阻断 /api/files 主目录树拉取
      } catch {
        // ignore optional default-cwd lookup failure
      }
    }

    const filesPath = normTarget
      ? `/api/files?path=${encodeURIComponent(normTarget)}`
      : '/api/files';
    try {
      const raw = await bridge.httpProxy({
        baseUrl: gatewayUrl,
        path: filesPath,
        method: 'GET',
      });
      const obj = parseJsonObjectSafely(raw, normTarget || 'files.json');
      const currentPath =
        (obj && typeof obj.path === 'string' ? normalizeWorkspacePath(obj.path) : '') || normTarget;
      const parsed = parseGatewayFilesPayload(raw, currentPath);
      if (parsed) {
        const rootPath =
          (obj && typeof obj.root === 'string' ? normalizeWorkspacePath(obj.root) : '') ||
          currentPath;
        const lockedRoot =
          obj && typeof obj.locked_root === 'string' && obj.locked_root.trim()
            ? normalizeWorkspacePath(obj.locked_root)
            : null;
        const parentPath =
          obj && typeof obj.parent === 'string' && obj.parent.trim()
            ? normalizeWorkspacePath(obj.parent)
            : extractParentDirectoryPath(currentPath) || null;
        return {
          ok: true,
          currentPath,
          rootPath,
          parentPath,
          lockedRoot,
          defaultCwd,
          entries: toDirectoryEntries(parsed),
          source: 'gateway_api',
          canCreate: true,
          canRename: Boolean(options.execShell || (isLoopback && bridge.renameDirectory)),
        };
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }

    try {
      const listRaw = await bridge.httpProxy({
        baseUrl: gatewayUrl,
        path: '/api/fs/list',
        method: 'GET',
        params: { path: normTarget || '.', profile },
      });
      const listObj = parseJsonObjectSafely(listRaw, normTarget || 'list.json');
      const resolvedCurrent =
        (listObj && typeof listObj.path === 'string' ? normalizeWorkspacePath(listObj.path) : '') ||
        normTarget ||
        defaultCwd ||
        '';
      const parsed = parseGatewayFilesPayload(listRaw, resolvedCurrent);
      if (parsed) {
        return {
          ok: true,
          currentPath: resolvedCurrent,
          rootPath: resolvedCurrent,
          parentPath: extractParentDirectoryPath(resolvedCurrent) || null,
          lockedRoot: null,
          defaultCwd,
          entries: toDirectoryEntries(parsed),
          source: 'gateway_api',
          canCreate: true,
          canRename: Boolean(options.execShell || (isLoopback && bridge.renameDirectory)),
        };
      }
    } catch (err) {
      if (!lastError) lastError = err instanceof Error ? err.message : String(err);
    }
  }

  if (isLoopback && bridge?.listDirectory) {
    try {
      const localEntries = await bridge.listDirectory(normTarget || undefined);
      if (Array.isArray(localEntries)) {
        const entries = toDirectoryEntries(localEntries);
        const currentPath = deriveLocalRoot(normTarget, entries);
        return {
          ok: true,
          currentPath,
          rootPath: currentPath,
          parentPath: extractParentDirectoryPath(currentPath) || null,
          lockedRoot: null,
          defaultCwd: currentPath || null,
          entries,
          source: 'local_fs',
          canCreate: Boolean(bridge.createDirectory),
          canRename: Boolean(bridge.renameDirectory),
        };
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }

  return {
    ok: false,
    error: lastError || 'Unable to list workspace directories',
  };
}

/**
 * 在指定父目录下新建子目录。
 */
export async function createProjectDirectory(
  parentPath: string,
  folderName: string,
  options: ProjectDirectoryServiceOptions = {},
): Promise<ProjectDirectoryMutationResult> {
  if (hasTraversalSegment(parentPath)) {
    return { ok: false, error: 'INVALID_PARENT_DIRECTORY' };
  }
  const normParent = normalizeWorkspacePath(parentPath);
  if (!normParent) {
    return { ok: false, error: 'Parent directory path is required' };
  }
  const validation = validateDirectoryName(folderName);
  if (!validation.ok) {
    return { ok: false, error: `INVALID_DIR_NAME:${validation.reason}` };
  }

  const targetPath = joinWorkspacePath(normParent, validation.name);
  if (
    options.lockedRoot &&
    !isPathWithinDirectory(normalizePathForMatch(targetPath), normalizePathForMatch(options.lockedRoot))
  ) {
    return { ok: false, error: 'PATH_OUTSIDE_LOCKED_ROOT' };
  }

  const bridge = options.platformBridge;
  const gatewayUrl = (options.gatewayUrl || '').trim();
  const isLoopback = !gatewayUrl || isLoopbackGatewayUrl(gatewayUrl);
  // 严格防降级隔离：非回环远端网关即使误传 source='local_fs' 也严禁写本机文件系统
  const preferLocal =
    isLoopback && (options.source === 'local_fs' || (!gatewayUrl && Boolean(bridge?.createDirectory)));

  const runLocalCreateDirectory = async (): Promise<ProjectDirectoryMutationResult> => {
    if (!bridge?.createDirectory) {
      return { ok: false, error: 'Directory creation is not supported by current host' };
    }
    try {
      const res = await bridge.createDirectory(normParent, validation.name);
      if (res?.ok && res.path) {
        return { ok: true, path: normalizeWorkspacePath(res.path) };
      }
      return { ok: false, error: res?.error || 'Failed to create directory' };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  };

  if (preferLocal) {
    return await runLocalCreateDirectory();
  }

  let proxyError: string | null = null;
  if (bridge?.httpProxy && gatewayUrl) {
    try {
      const raw = await bridge.httpProxy({
        baseUrl: gatewayUrl,
        path: '/api/files/mkdir',
        method: 'POST',
        body: { path: targetPath },
      });
      const validated = validateMkdirProxyResponse(raw, targetPath, options.lockedRoot);
      if (validated.ok || !isLoopback || !bridge?.createDirectory) {
        return validated;
      }
      proxyError = validated.error;
    } catch (err) {
      proxyError = err instanceof Error ? err.message : String(err);
      if (!isLoopback || !bridge?.createDirectory) {
        return { ok: false, error: proxyError };
      }
    }
  }

  if (isLoopback && bridge?.createDirectory) {
    return await runLocalCreateDirectory();
  }

  return { ok: false, error: proxyError || 'Gateway proxy unavailable' };
}

/**
 * 在同父目录下重命名子目录（严格拦截根目录、`locked_root`、重名覆盖与跨目录搬迁）。
 */
export async function renameProjectDirectory(
  dirPath: string,
  newName: string,
  options: ProjectDirectoryServiceOptions = {},
): Promise<ProjectDirectoryMutationResult> {
  if (hasTraversalSegment(dirPath)) {
    return { ok: false, error: 'INVALID_DIRECTORY_PATH' };
  }
  const normDir = normalizeWorkspacePath(dirPath);
  if (!normDir) {
    return { ok: false, error: 'Target directory path is required' };
  }
  const validation = validateDirectoryName(newName);
  if (!validation.ok) {
    return { ok: false, error: `INVALID_DIR_NAME:${validation.reason}` };
  }
  if (isProtectedRootDirectory(normDir, options.lockedRoot)) {
    return { ok: false, error: 'PROTECTED_ROOT_DIRECTORY' };
  }

  const parentDir = extractParentDirectoryPath(normDir);
  if (!parentDir) {
    return { ok: false, error: 'PROTECTED_ROOT_DIRECTORY' };
  }

  const targetPath = joinWorkspacePath(parentDir, validation.name);
  if (
    options.lockedRoot &&
    !isPathWithinDirectory(normalizePathForMatch(targetPath), normalizePathForMatch(options.lockedRoot))
  ) {
    return { ok: false, error: 'PATH_OUTSIDE_LOCKED_ROOT' };
  }
  if (targetPath === normDir) {
    return { ok: true, path: targetPath };
  }

  const bridge = options.platformBridge;
  const gatewayUrl = (options.gatewayUrl || '').trim();
  const isLoopback = !gatewayUrl || isLoopbackGatewayUrl(gatewayUrl);
  const isWinDrive = /^[A-Za-z]:\//.test(normDir);
  // 严格防降级隔离：仅当处于回环/本地形态时才允许调用宿主 PAL renameDirectory
  const preferLocal =
    isLoopback &&
    Boolean(bridge?.renameDirectory) &&
    (options.source === 'local_fs' || isWinDrive || !options.execShell);

  if (preferLocal) {
    if (!bridge?.renameDirectory) {
      return { ok: false, error: 'Directory rename is not supported by current host' };
    }
    try {
      const res = await bridge.renameDirectory(normDir, validation.name);
      if (res?.ok && res.path) {
        return { ok: true, path: normalizeWorkspacePath(res.path) };
      }
      return { ok: false, error: res?.error || 'Failed to rename directory' };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  if (options.execShell) {
    try {
      const oldQuoted = posixQuoteShellArg(normDir);
      const newQuoted = posixQuoteShellArg(targetPath);
      const command = `if [ -e ${newQuoted} -o -L ${newQuoted} ]; then echo "TARGET_EXISTS" >&2; exit 17; fi; mv -- ${oldQuoted} ${newQuoted}`;
      const result = await options.execShell(command, options.profile || 'default');
      if (result.code === 0) {
        return { ok: true, path: targetPath };
      }
      if (result.code === 17 || (result.stderr || '').includes('TARGET_EXISTS')) {
        return { ok: false, error: 'TARGET_EXISTS' };
      }
      return {
        ok: false,
        error: (result.stderr || result.stdout || `Shell exited with code ${result.code ?? 'unknown'}`).trim(),
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  return { ok: false, error: 'Directory rename is unavailable in current connection mode' };
}
