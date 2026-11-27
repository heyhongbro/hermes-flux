/**
 * 桌面端安全文档预览特权协议控制器 (Hermes Preview Protocol)
 *
 * 【设计意图 (Why)】
 *   HTML / SVG 等富文档在 `<iframe srcdoc="..." sandbox="allow-scripts">` 下处于 `about:srcdoc`
 *   空源环境中，导致文档内的 `./app.css`、`../img/chart.png`、`/assets/font.woff2`、`fetch('./data.json')`
 *   与 `<script type="module">` 全部失败。本控制器在 Electron 主进程注册特权方案
 *   `hermes-preview://<token>.preview/...`：
 *   1. 每个打开的预览页签获得唯一随机 hex `token`，入口文档按其工作区相对路径（Mode A）或
 *      虚拟文档根（Mode B）挂载，浏览器原生 URL 引擎自动完成 `./`、`../` 与 `/assets/` 解析；
 *   2. 入口 HTML 从 `entryContent` 直接响应，绝不破坏或篡改磁盘/远端源文件；
 *   3. 保持 `sandbox="allow-scripts"`（无 `allow-same-origin`）隔离，通过严格 CORS 响应头支持
 *      iframe 内同工作区字体的 `@font-face`、ESM 与 `fetch()`；外部 CDN `http(s)://` 由浏览器直连。
 *
 * 【防范的历史坑 (Pitfall)】
 *   1. 越权目录穿越与系统敏感盘读取：严格拦截 `.env` / `.env.*`（仅放行 `.env.example`）、`\0`、
 *      系统敏感根目录以及试图逃逸 `workspaceRoot` 的相对/符号链接路径；
 *   2. 跨源 Cookie 泄漏：远端网关代理仅当目标 `origin` 与当前登录网关 `activeGatewayOrigin`
 *      严格相等时才附加会话 `Cookie`；
 *   3. 网关 SPA HTML 回退劫持：非 `.html`/`.htm` 子资源若收到 `text/html` 回退页直接丢弃流并返 404，
 *      避免 CSS/JS 解析器吞入控制台 HTML；若网关返回 `text/plain` 或 `application/octet-stream`
 *      则以扩展名映射纠正 MIME（满足 `<script type="module">` 与 `<img src="*.svg">` 严格检查）。
 *
 * 【约束与规则 (Rules)】
 *   - 内存会话表严格限制上限（默认 64 条 LRU 淘汰），支持显式注销；
 *   - 支持 HTTP `Range` 分片返回 `206 Partial Content` 以便嵌套视频/音频可拖拽定位；
 *   - 禁止写入或修改磁盘上的任何源文件。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import type { Readable } from 'node:stream';
import {
  detectPreviewAssetMime,
  hasPreviewEnvSecretSegment,
  isLoopbackGatewayUrl,
  isPathWithinScope,
  isPreviewSystemSensitivePath,
  normalizeHttpBaseUrl,
  normalizeWorkspacePath,
  resolveDocumentDir,
  type PreviewSessionRegistration,
  type RegisterPreviewSessionOptions,
} from '@hermes-flux/core';
import {
  cancelBodySafely,
  parseByteRangeHeader,
  toWebReadableStream,
  type MediaStreamGatewayAuth,
} from './mediaStreamProtocol';
import { resolveSafeLocalSourceFile } from './workspaceFs';

export const HERMES_PREVIEW_SCHEME = 'hermes-preview';
export const DEFAULT_MAX_PREVIEW_SESSIONS = 64;

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Range, Content-Type, Accept',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges, Content-Type',
  'Cross-Origin-Resource-Policy': 'cross-origin',
};

export interface PreviewProtocolControllerDeps {
  getGatewayAuth: () => MediaStreamGatewayAuth;
  getFallbackCwd: () => string;
  maxSessions?: number;
  fetchImpl?: typeof fetch;
  resolveLocalFile?: (rawSourcePath: string | undefined, fallbackCwd?: string) => string | null;
  realpath?: (absPath: string) => string;
  statFile?: (absPath: string) => { size: number; isFile: () => boolean };
  createReadStream?: (absPath: string, opts?: { start?: number; end?: number }) => Readable;
}

export interface PreviewProtocolController {
  registerSession(options: RegisterPreviewSessionOptions): PreviewSessionRegistration | null;
  revokeSession(token: string): boolean;
  getSessionCount(): number;
  handleProtocolRequest(request: Request): Promise<Response>;
}

interface PreviewSessionRecord {
  token: string;
  entryPath: string;
  normalizedEntryPath: string;
  entryContent: string;
  workspaceRoot?: string;
  normalizedWorkspaceRoot?: string;
  gatewayUrl?: string;
  profile?: string;
  sessionId?: string;
  source?: RegisterPreviewSessionOptions['source'];
  mode: 'A' | 'B';
  entryUrlPathname: string;
}

interface ResolvedSessionTarget {
  targetPath?: string;
  isEntry?: boolean;
  blocked?: boolean;
}

function withCorsHeaders(extra?: Record<string, string> | Headers): Headers {
  const headers = new Headers(extra);
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    headers.set(key, value);
  }
  return headers;
}

function emptyResponse(status: number, extraHeaders?: Record<string, string>): Response {
  return new Response(null, {
    status,
    headers: withCorsHeaders(extraHeaders),
  });
}

function normalizeScopeCompare(rawPath: string): string {
  const norm = normalizeWorkspacePath(rawPath);
  if (/^[A-Za-z]:\//.test(norm)) {
    return `${norm[0].toLowerCase()}${norm.slice(1)}`;
  }
  return norm;
}

function encodePathnameSegments(posixPath: string): string {
  const leadingSlash = posixPath.startsWith('/');
  const parts = posixPath.split('/').filter((seg, idx) => !(idx === 0 && leadingSlash && seg === ''));
  const encoded = parts
    .filter((seg) => seg.length > 0)
    .map((seg) => (/^[A-Za-z]:$/.test(seg) ? seg : encodeURIComponent(seg)));
  return leadingSlash ? `/${encoded.join('/')}` : encoded.join('/');
}

function decodePathnameSafely(rawPathname: string): string | null {
  const rawSegments = rawPathname.split('/');
  const decodedSegments: string[] = [];
  for (let i = 0; i < rawSegments.length; i += 1) {
    const seg = rawSegments[i];
    if (i === 0 && seg === '') {
      decodedSegments.push('');
      continue;
    }
    if (!seg) {
      // 仅忽略末尾斜杠，保留路径中的空段，避免 `/__rel__//abs/path` 被折叠为相对路径而绕过根绝对路径阻断
      if (i === rawSegments.length - 1) continue;
      decodedSegments.push('');
      continue;
    }
    let decoded = seg;
    try {
      decoded = decodeURIComponent(seg);
    // gate-degrade: 非法 URL 百分号编码视为畸形请求路径并拒绝访问 (403)
    } catch {
      return null;
    }
    if (
      decoded.includes('\0') ||
      decoded === '..' ||
      decoded === '.' ||
      decoded.includes('/') ||
      decoded.includes('\\')
    ) {
      return null;
    }
    decodedSegments.push(decoded);
  }
  return decodedSegments.join('/') || '/';
}

function isHtmlAssetPath(targetPath: string): boolean {
  const clean = targetPath.split(/[?#]/)[0].trim().toLowerCase();
  return clean.endsWith('.html') || clean.endsWith('.htm') || clean.endsWith('.xhtml');
}

function stripOptionalPrefixSlash(val: string): string {
  return val.replace(/^\/+/, '');
}

/**
 * 构建支持受控预览会话、工作区相对路径映射与零源破坏响应的 `hermes-preview://` 协议控制器。
 */
export function createPreviewProtocolController(
  deps: PreviewProtocolControllerDeps,
): PreviewProtocolController {
  const maxSessions = Math.max(1, deps.maxSessions ?? DEFAULT_MAX_PREVIEW_SESSIONS);
  const fetchImpl = deps.fetchImpl ?? fetch;
  const resolveLocal = deps.resolveLocalFile ?? resolveSafeLocalSourceFile;
  const realpathFn = deps.realpath ?? ((p: string) => fs.realpathSync(p));
  const statFile = deps.statFile ?? ((p: string) => fs.statSync(p));
  const createStream =
    deps.createReadStream ??
    ((p: string, opts?: { start?: number; end?: number }) => fs.createReadStream(p, opts));

  const sessions = new Map<string, PreviewSessionRecord>();

  function touchSession(token: string): PreviewSessionRecord | undefined {
    const existing = sessions.get(token);
    if (!existing) return undefined;
    sessions.delete(token);
    sessions.set(token, existing);
    return existing;
  }

  function registerSession(options: RegisterPreviewSessionOptions): PreviewSessionRegistration | null {
    const rawEntry = typeof options?.entryPath === 'string' ? options.entryPath.trim() : '';
    const entryContent = typeof options?.entryContent === 'string' ? options.entryContent : null;
    if (!rawEntry || entryContent === null || rawEntry.includes('\0')) {
      return null;
    }
    if (hasPreviewEnvSecretSegment(rawEntry)) {
      return null;
    }

    const normalizedEntryPath = normalizeWorkspacePath(rawEntry.split(/[?#]/)[0]);
    if (!normalizedEntryPath) {
      return null;
    }
    const isAbsEntry = normalizedEntryPath.startsWith('/') || /^[A-Za-z]:\//.test(normalizedEntryPath);
    if (isAbsEntry && isPreviewSystemSensitivePath(normalizedEntryPath)) {
      return null;
    }

    const rawWorkspace = typeof options.workspaceRoot === 'string' ? options.workspaceRoot.trim() : '';
    let normalizedWorkspaceRoot: string | undefined;
    if (rawWorkspace && !rawWorkspace.includes('\0') && !hasPreviewEnvSecretSegment(rawWorkspace)) {
      const normRoot = normalizeWorkspacePath(rawWorkspace).replace(/\/+$/, '');
      if (normRoot && !isPreviewSystemSensitivePath(normRoot)) {
        normalizedWorkspaceRoot = normRoot;
      }
    }

    const token = crypto.randomBytes(16).toString('hex');
    const inWorkspace = Boolean(
      normalizedWorkspaceRoot && isPathWithinScope(normalizedWorkspaceRoot, normalizedEntryPath),
    );

    let mode: 'A' | 'B' = 'B';
    let entryUrlPathname = '';

    if (inWorkspace && normalizedWorkspaceRoot) {
      const cmpRoot = normalizeScopeCompare(normalizedWorkspaceRoot);
      const cmpEntry = normalizeScopeCompare(normalizedEntryPath);
      const prefixLen = cmpRoot.length + 1;
      const relPart = cmpEntry.length > prefixLen ? stripOptionalPrefixSlash(normalizedEntryPath.slice(prefixLen)) : '';
      if (relPart) {
        mode = 'A';
        entryUrlPathname = `/${encodePathnameSegments(relPart)}`;
      }
    }

    if (!entryUrlPathname) {
      mode = 'B';
      if (normalizedEntryPath.startsWith('/')) {
        entryUrlPathname = `/__doc__${encodePathnameSegments(normalizedEntryPath)}`;
      } else if (/^[A-Za-z]:\//.test(normalizedEntryPath)) {
        entryUrlPathname = `/__doc__/${encodePathnameSegments(normalizedEntryPath)}`;
      } else {
        entryUrlPathname = `/__rel__/${encodePathnameSegments(normalizedEntryPath)}`;
      }
    }

    while (sessions.size >= maxSessions) {
      const oldestKey = sessions.keys().next().value;
      sessions.delete(oldestKey as string);
    }

    const record: PreviewSessionRecord = {
      token,
      entryPath: normalizedEntryPath,
      normalizedEntryPath,
      entryContent,
      workspaceRoot: normalizedWorkspaceRoot,
      normalizedWorkspaceRoot,
      gatewayUrl: options.gatewayUrl?.trim() || undefined,
      profile: options.profile?.trim() || undefined,
      sessionId: options.sessionId?.trim() || undefined,
      source: options.source,
      mode,
      entryUrlPathname,
    };

    sessions.set(token, record);
    return {
      token,
      entryUrl: `${HERMES_PREVIEW_SCHEME}://${token}.preview${entryUrlPathname}`,
    };
  }

  function revokeSession(token: string): boolean {
    if (!token || typeof token !== 'string') return false;
    return sessions.delete(token);
  }

  function resolveSessionTarget(
    session: PreviewSessionRecord,
    rawPathname: string,
  ): ResolvedSessionTarget {
    if (rawPathname === session.entryUrlPathname) {
      return { targetPath: session.entryPath, isEntry: true };
    }

    const decodedPath = decodePathnameSafely(rawPathname);
    if (!decodedPath) {
      return { blocked: true };
    }
    if (hasPreviewEnvSecretSegment(decodedPath)) {
      return { blocked: true };
    }

    let candidate = '';
    if (session.mode === 'A' && session.normalizedWorkspaceRoot) {
      const rel = stripOptionalPrefixSlash(decodedPath);
      if (!rel) return {};
      candidate = normalizeWorkspacePath(`${session.normalizedWorkspaceRoot}/${rel}`);
    } else if (decodedPath === '/__doc__' || decodedPath.startsWith('/__doc__/')) {
      const rest = decodedPath.slice('/__doc__/'.length);
      if (!rest) return {};
      candidate = /^[A-Za-z]:\//.test(rest)
        ? normalizeWorkspacePath(rest)
        : normalizeWorkspacePath(`/${rest}`);
      const docDir = resolveDocumentDir(session.normalizedEntryPath);
      if (!docDir || !isPathWithinScope(docDir, candidate)) {
        return { blocked: true };
      }
    } else if (decodedPath === '/__rel__' || decodedPath.startsWith('/__rel__/')) {
      const rest = decodedPath.slice('/__rel__/'.length);
      if (!rest) return {};
      candidate = normalizeWorkspacePath(rest);
      const docDir = resolveDocumentDir(session.normalizedEntryPath);
      if (
        docDir
          ? !isPathWithinScope(docDir, candidate)
          : candidate === '..' ||
            candidate.startsWith('../') ||
            candidate.startsWith('/') ||
            /^[A-Za-z]:\//.test(candidate)
      ) {
        return { blocked: true };
      }
    } else {
      return { blocked: true };
    }

    if ((candidate.startsWith('/') || /^[A-Za-z]:\//.test(candidate)) && isPreviewSystemSensitivePath(candidate)) {
      return { blocked: true };
    }

    const isEntry = normalizeScopeCompare(candidate) === normalizeScopeCompare(session.normalizedEntryPath);
    return { targetPath: candidate, isEntry };
  }

  function isSymlinkWithinWorkspace(absPath: string, workspaceRoot: string): boolean {
    try {
      const realTarget = normalizeWorkspacePath(realpathFn(absPath));
      if (hasPreviewEnvSecretSegment(realTarget) || isPreviewSystemSensitivePath(realTarget)) {
        return false;
      }
      let realRoot = normalizeWorkspacePath(workspaceRoot);
      try {
        realRoot = normalizeWorkspacePath(realpathFn(workspaceRoot));
      // gate-degrade: 自定义 mock 根路径无物理 realpath 时沿用归一化工作区路径校验
      } catch {}
      return isPathWithinScope(realRoot, realTarget);
    // gate-degrade: 物理 realpath 探测异常时在无测试替身场景保守拒绝访问
    } catch {
      return false;
    }
  }

  async function serveLocalFile(
    request: Request,
    session: PreviewSessionRecord,
    targetPath: string,
    fallbackCwd: string,
  ): Promise<Response | null> {
    const absPath = resolveLocal(targetPath, fallbackCwd);
    if (!absPath) return null;

    let totalSize = 0;
    try {
      const stat = statFile(absPath);
      if (!stat.isFile()) return null;
      totalSize = stat.size;
    // gate-degrade: 本地物理文件缺失时返回 null，若存在网关配置则继续回退网关资源流
    } catch {
      return null;
    }

    let symlinkRoot = session.normalizedWorkspaceRoot ?? '';
    if (session.mode !== 'A') {
      const docDir = resolveDocumentDir(session.normalizedEntryPath);
      const isAbsDocDir = docDir.startsWith('/') || /^[A-Za-z]:\//.test(docDir);
      symlinkRoot = isAbsDocDir
        ? docDir
        : fallbackCwd
          ? normalizeWorkspacePath(docDir ? `${fallbackCwd}/${docDir}` : fallbackCwd)
          : '';
    }
    if (symlinkRoot && !isSymlinkWithinWorkspace(absPath, symlinkRoot)) {
      return emptyResponse(403);
    }

    const mime = detectPreviewAssetMime(targetPath) || 'application/octet-stream';
    const isHead = request.method.toUpperCase() === 'HEAD';
    const parsedRange = parseByteRangeHeader(request.headers.get('range'), totalSize);

    if (parsedRange === 'invalid') {
      return emptyResponse(416, {
        'Content-Range': `bytes */${totalSize}`,
        'Accept-Ranges': 'bytes',
      });
    }

    if (parsedRange) {
      const chunkLen = parsedRange.end - parsedRange.start + 1;
      const body = isHead
        ? null
        : toWebReadableStream(createStream(absPath, { start: parsedRange.start, end: parsedRange.end }));
      return new Response(body, {
        status: 206,
        headers: withCorsHeaders({
          'Content-Type': mime,
          'Content-Length': String(chunkLen),
          'Content-Range': `bytes ${parsedRange.start}-${parsedRange.end}/${totalSize}`,
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'no-store',
        }),
      });
    }

    const body = isHead || totalSize === 0 ? null : toWebReadableStream(createStream(absPath));
    return new Response(body, {
      status: 200,
      headers: withCorsHeaders({
        'Content-Type': mime,
        'Content-Length': String(totalSize),
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
      }),
    });
  }

  async function serveGatewayAsset(
    request: Request,
    session: PreviewSessionRecord,
    targetPath: string,
    gatewayRaw: string,
  ): Promise<Response> {
    const base = normalizeHttpBaseUrl(gatewayRaw);
    let parsedBase: URL;
    try {
      parsedBase = new URL(base);
    } catch {
      return emptyResponse(404);
    }

    const auth = deps.getGatewayAuth();
    const headers: Record<string, string> = {
      Origin: parsedBase.origin,
    };
    if (auth.cookies && auth.origin && parsedBase.origin.toLowerCase() === auth.origin.toLowerCase()) {
      headers.Cookie = auth.cookies;
    }
    const rangeHeader = request.headers.get('range');
    if (rangeHeader) {
      headers.Range = rangeHeader;
    }

    const q = new URLSearchParams({ path: targetPath });
    if (session.profile) q.set('profile', session.profile);
    if (session.sessionId) q.set('session_id', session.sessionId);

    const method = request.method.toUpperCase() === 'HEAD' ? 'HEAD' : 'GET';
    let upstreamRes: Response;
    try {
      const primaryUrl = `${parsedBase.origin}/api/fs/download?${q.toString()}`;
      upstreamRes = await fetchImpl(primaryUrl, {
        method,
        headers,
        signal: request.signal,
      });
      if (upstreamRes.status === 404) {
        await cancelBodySafely(upstreamRes);
        const fallbackUrl = `${parsedBase.origin}/api/files/download?path=${encodeURIComponent(targetPath)}`;
        upstreamRes = await fetchImpl(fallbackUrl, {
          method,
          headers,
          signal: request.signal,
        });
      }
    } catch (err) {
      console.warn('[previewProtocol] gateway asset fetch failed:', err);
      return emptyResponse(502);
    }

    if (!upstreamRes.ok) {
      await cancelBodySafely(upstreamRes);
      return emptyResponse(upstreamRes.status);
    }

    const rawCt = (upstreamRes.headers.get('content-type') || '').trim();
    const lowerCt = rawCt.toLowerCase();
    const htmlAllowed = isHtmlAssetPath(targetPath);
    if (!htmlAllowed && lowerCt.includes('text/html')) {
      await cancelBodySafely(upstreamRes);
      return emptyResponse(404);
    }

    const detectedMime = detectPreviewAssetMime(targetPath);
    const isGenericUpstream =
      !rawCt ||
      lowerCt.startsWith('application/octet-stream') ||
      lowerCt.startsWith('text/plain');
    const mime =
      detectedMime && (isGenericUpstream || !htmlAllowed)
        ? detectedMime
        : rawCt || detectedMime || 'application/octet-stream';

    const respHeaders = withCorsHeaders({
      'Content-Type': mime,
      'Cache-Control': 'no-store',
    });

    const hasEncoding = Boolean(upstreamRes.headers.get('content-encoding'));
    const forwardKeys = hasEncoding
      ? ['content-range', 'accept-ranges', 'etag', 'last-modified']
      : ['content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified'];
    for (const key of forwardKeys) {
      const val = upstreamRes.headers.get(key);
      if (val) respHeaders.set(key, val);
    }
    if (!respHeaders.has('accept-ranges')) {
      respHeaders.set('Accept-Ranges', 'bytes');
    }

    if (method === 'HEAD') {
      await cancelBodySafely(upstreamRes);
      return new Response(null, {
        status: upstreamRes.status,
        headers: respHeaders,
      });
    }

    return new Response(upstreamRes.body, {
      status: upstreamRes.status,
      headers: respHeaders,
    });
  }

  async function handleProtocolRequest(request: Request): Promise<Response> {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(request.url);
    } catch {
      return emptyResponse(400);
    }

    if (parsedUrl.protocol !== `${HERMES_PREVIEW_SCHEME}:`) {
      return emptyResponse(400);
    }

    const method = (request.method || 'GET').toUpperCase();
    if (method === 'OPTIONS') {
      return emptyResponse(204);
    }
    if (method !== 'GET' && method !== 'HEAD') {
      return emptyResponse(405);
    }

    const host = parsedUrl.hostname.toLowerCase();
    if (!host.endsWith('.preview')) {
      return emptyResponse(403);
    }
    const token = host.slice(0, -'.preview'.length);
    if (!token) {
      return emptyResponse(403);
    }

    const session = touchSession(token);
    if (!session) {
      return emptyResponse(404);
    }

    const resolved = resolveSessionTarget(session, parsedUrl.pathname);
    if (resolved.blocked) {
      return emptyResponse(403);
    }
    if (!resolved.targetPath) {
      return emptyResponse(404);
    }

    if (resolved.isEntry) {
      const entryBuffer = Buffer.from(session.entryContent, 'utf8');
      const headers = withCorsHeaders({
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': String(entryBuffer.byteLength),
        'Cache-Control': 'no-store',
      });
      return new Response(method === 'HEAD' ? null : entryBuffer, {
        status: 200,
        headers,
      });
    }

    const gatewayRaw = (session.gatewayUrl || '').trim();
    const preferLocal =
      !gatewayRaw || isLoopbackGatewayUrl(gatewayRaw) || session.source === 'local_fs';
    const fallbackCwd = session.workspaceRoot || deps.getFallbackCwd();

    if (preferLocal) {
      const localRes = await serveLocalFile(request, session, resolved.targetPath, fallbackCwd);
      if (localRes) return localRes;
      if (gatewayRaw) {
        return await serveGatewayAsset(request, session, resolved.targetPath, gatewayRaw);
      }
      return emptyResponse(404);
    }

    return await serveGatewayAsset(request, session, resolved.targetPath, gatewayRaw);
  }

  return {
    registerSession,
    revokeSession,
    getSessionCount: () => sessions.size,
    handleProtocolRequest,
  };
}
