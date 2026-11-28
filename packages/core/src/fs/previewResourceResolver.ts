/**
 * 文件预览相对路径解析、安全边界守卫与子资源拉取器 (packages/core/src/fs/previewResourceResolver.ts)
 *
 * 【设计意图 (Why)】
 *   Markdown / HTML / SVG 预览时，文档内部的 `./img.png`、`../styles/app.css`、`/assets/logo.svg` 等
 *   相对路径必须基于「当前文档所在目录」及「工作区根目录」解析，绝不能把原始文件 `content` 原地改写，
 *   也不得落到壳页基准路径导致 404。
 *
 * 【防范的历史坑 (Pitfall)】
 *   1. `fileService.ts` 的 `BINARY_EXTENSIONS` 将字体（woff2/ttf）与音频（mp3/wav）判定为不可预览二进制，
 *      若 HTML/CSS 子资源复用 `resolveFileContent` 会被直接拦截；本模块提供专用的子资源拉取通道；
 *   2. `joinWorkspacePath` 会先归一化子串再拼接，导致 `../` 无法消解父目录；本模块先拼接再整体归一化；
 *   3. 必须严格拦截 `.env*`、系统敏感根目录与越出 `workspaceRoot` 的向上穿越。
 *
 * 【约束与规则 (Rules)】
 *   - 零 DOM / Node `fs` / `Buffer` 依赖，可在 Browser / Electron / Capacitor / Node 同构运行；
 *   - 所有操作均为只读解析，绝不修改原文件或源码字符串。
 */

import type { IPlatformBridge } from '../pal/IPlatformBridge.js';
import {
  PREVIEW_BINARY_EXT_MIME,
  decodeDataUrlUtf8,
  extractFileContentFromSessionTools,
  isDirectVideoStreamUrl,
  isSpaFallbackHtml,
  type SessionMessageWithTools,
} from './fileService.js';
import { isLoopbackGatewayUrl, normalizeWorkspacePath } from './fileTreeService.js';

export const DEFAULT_MAX_PREVIEW_ASSET_BYTES = 5 * 1024 * 1024;

export const PREVIEW_ASSET_MIME: Readonly<Record<string, string>> = {
  ...PREVIEW_BINARY_EXT_MIME,
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'application/javascript; charset=utf-8',
  mjs: 'application/javascript; charset=utf-8',
  cjs: 'application/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  map: 'application/json; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  vtt: 'text/vtt; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  markdown: 'text/markdown; charset=utf-8',
  yaml: 'text/yaml; charset=utf-8',
  yml: 'text/yaml; charset=utf-8',
};

export type PreviewResourceKind =
  | 'relative'
  | 'root_relative'
  | 'external_http'
  | 'inline_data'
  | 'anchor'
  | 'passthrough'
  | 'unsafe'
  | 'empty';

export interface PreviewResourceContext {
  documentPath: string;
  workspaceRoot?: string;
}

export interface ResolvedPreviewRef {
  kind: PreviewResourceKind;
  rawRef: string;
  resolvedPath?: string;
  suffix?: string;
  externalUrl?: string;
  blocked?: boolean;
  blockReason?: string;
}

export interface ResolvePreviewAssetOptions {
  platformBridge?: Pick<IPlatformBridge, 'readFile' | 'httpProxy' | 'resolveMediaStreamUrl'> | null;
  gatewayUrl?: string;
  profile?: string;
  sessionId?: string;
  sourceHint?: 'session_tool' | 'local_fs' | 'remote_http' | 'gateway_api' | 'fallback';
  messages?: SessionMessageWithTools[];
  workspaceRoot?: string;
  enforceWorkspaceScope?: boolean;
  maxBytes?: number;
  allowVideoStreamUrl?: boolean;
}

export interface ResolvedPreviewAssetResult {
  ok: boolean;
  path: string;
  mime: string;
  isText: boolean;
  text?: string;
  dataUrl?: string;
  byteSize: number;
  source: 'local_fs' | 'gateway_api' | 'session_tool' | 'error';
  error?: string;
}

/**
 * 探测预览子资源路径或请求 URL 的完整 MIME 类型（覆盖网页文本、媒体、字体与 WASM）。
 */
export function detectPreviewAssetMime(pathOrQuery: string): string | null {
  if (!pathOrQuery || typeof pathOrQuery !== 'string') return null;
  const extractExt = (candidate: string): string => {
    const clean = candidate.split(/[?#]/)[0];
    const base = clean.split(/[/\\]/).pop() || '';
    const dotIdx = base.lastIndexOf('.');
    if (dotIdx <= 0) return '';
    return base.slice(dotIdx + 1).toLowerCase();
  };
  try {
    const parsed = new URL(pathOrQuery, 'https://localhost');
    const queryTarget = parsed.searchParams.get('path');
    if (queryTarget) {
      const qMime = PREVIEW_ASSET_MIME[extractExt(queryTarget)];
      if (qMime) return qMime;
    }
    return PREVIEW_ASSET_MIME[extractExt(parsed.pathname)] ?? null;
  // gate-degrade: 非标准路径或特殊字符解析失败时直接回落扩展名查表
  } catch {
    return PREVIEW_ASSET_MIME[extractExt(pathOrQuery)] ?? null;
  }
}

/**
 * 判断 MIME 是否属于可 UTF-8 文本读取的网页子资源。
 */
export function isTextPreviewAssetMime(mime: string | null): boolean {
  if (!mime) return false;
  const lower = mime.split(';')[0].trim().toLowerCase();
  return (
    lower.startsWith('text/') ||
    lower === 'application/javascript' ||
    lower === 'application/json' ||
    lower === 'application/xml'
  );
}

/**
 * 判断 MIME 是否属于内联二进制/媒体资源（图片/视频/音频/字体/WASM）。
 */
export function isInlineBinaryPreviewAssetMime(mime: string | null): boolean {
  if (!mime) return false;
  const lower = mime.split(';')[0].trim().toLowerCase();
  return (
    lower.startsWith('image/') ||
    lower.startsWith('video/') ||
    lower.startsWith('audio/') ||
    lower.startsWith('font/') ||
    lower.startsWith('application/font-') ||
    lower === 'application/vnd.ms-fontobject' ||
    lower === 'application/wasm' ||
    lower === 'application/octet-stream'
  );
}

/**
 * 检测路径中是否包含敏感 `.env` / `.env.*`（仅允许 `.env.example`）。
 */
export function hasPreviewEnvSecretSegment(rawPath: string): boolean {
  if (!rawPath || typeof rawPath !== 'string') return false;
  return rawPath
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean)
    .some((seg) => {
      const lower = seg.trim().toLowerCase();
      return lower === '.env' || (lower.startsWith('.env.') && lower !== '.env.example');
    });
}

/**
 * 检测归一化路径是否落入系统敏感根目录或系统目录（`/etc`, `/proc`, `C:/Windows` 等）。
 */
export function isPreviewSystemSensitivePath(rawPath: string): boolean {
  const norm = normalizeWorkspacePath(rawPath).replace(/\/+$/, '');
  if (!norm || norm === '/' || /^[A-Za-z]:$/.test(norm)) return true;
  const lower = norm.toLowerCase();
  const unixLike = lower.replace(/^[a-z]:/, '');
  const unixForbidden = ['/etc', '/proc', '/sys', '/dev', '/root'];
  if (unixForbidden.some((prefix) => unixLike === prefix || unixLike.startsWith(`${prefix}/`))) {
    return true;
  }
  const winForbidden = ['c:/windows', 'c:/program files', 'c:/program files (x86)'];
  return winForbidden.some((prefix) => lower === prefix || lower.startsWith(`${prefix}/`));
}

function normalizeScopeCompare(rawPath: string): string {
  const norm = normalizeWorkspacePath(rawPath);
  if (!norm) return '';
  return /^[A-Za-z]:\//.test(norm) ? `${norm[0].toLowerCase()}${norm.slice(1)}` : norm;
}

/**
 * 判断候选路径是否严格位于指定根作用域目录内部（兼容 Windows 盘符大小写差异）。
 */
export function isPathWithinScope(rootPath: string, candidatePath: string): boolean {
  const root = normalizeScopeCompare(rootPath);
  const candidate = normalizeScopeCompare(candidatePath);
  if (!root || !candidate) return false;
  if (root === candidate) return true;
  const prefix = root.endsWith('/') ? root : `${root}/`;
  return candidate.startsWith(prefix);
}

/**
 * 提取文档路径所在的基准目录（支持 POSIX、Windows 盘符、相对路径及 HTTP URL）。
 */
export function resolveDocumentDir(documentPath: string, workspaceRoot?: string): string {
  const raw = (documentPath || '').trim();
  const normRoot = workspaceRoot ? normalizeWorkspacePath(workspaceRoot) : '';
  if (!raw) return normRoot;

  if (/^https?:\/\//i.test(raw)) {
    try {
      return new URL('.', raw).href;
    // gate-degrade: 非法 HTTP 文档 URL 时回落工作区根目录
    } catch {
      return normRoot;
    }
  }

  const clean = raw.split(/[?#]/)[0];
  let normDoc = normalizeWorkspacePath(clean);
  if (!normDoc || normDoc === '.') return normRoot;

  const isAbs = normDoc.startsWith('/') || /^[A-Za-z]:\//.test(normDoc);
  if (!isAbs && normRoot) {
    normDoc = normalizeWorkspacePath(normRoot.endsWith('/') ? `${normRoot}${normDoc}` : `${normRoot}/${normDoc}`);
  }

  const lastSlash = normDoc.lastIndexOf('/');
  if (lastSlash < 0) return normRoot;
  if (lastSlash === 0) return '/';
  const dir = normDoc.slice(0, lastSlash);
  return /^[A-Za-z]:$/.test(dir) ? `${dir}/` : dir;
}

/**
 * 推导当前文档的有效根目录作用域：工作区内/相对路径使用工作区根，工作区外绝对交付物仅锁定到其自身父目录。
 */
export function resolveEffectivePreviewScopeRoot(filePath: string, globalWorkspaceRoot = ''): string {
  const normGlobal = normalizeWorkspacePath(globalWorkspaceRoot);
  if (!filePath) return normGlobal;
  const normFile = normalizeWorkspacePath(filePath);
  const isAbs = normFile.startsWith('/') || /^[A-Za-z]:\//.test(normFile);
  if (!isAbs) return normGlobal;
  if (normGlobal && isPathWithinScope(normGlobal, normFile)) return normGlobal;
  return resolveDocumentDir(normFile, '');
}

/**
 * 校验待水合/待读取资产路径是否满足安全字符与作用域边界，防止相对 `..` 逃逸与跨区越权。
 */
export function isPreviewAssetPathAllowed(
  rawPath: string,
  options: { workspaceRoot?: string; enforceWorkspaceScope?: boolean } = {},
): boolean {
  const cleanTarget = (rawPath || '').split(/[?#]/)[0].trim();
  if (
    !cleanTarget ||
    cleanTarget.includes('\0') ||
    hasPreviewEnvSecretSegment(cleanTarget) ||
    isPreviewSystemSensitivePath(cleanTarget)
  ) {
    return false;
  }
  if (!options.enforceWorkspaceScope) return true;
  const normTarget = normalizeWorkspacePath(cleanTarget);
  if (normTarget === '..' || normTarget.startsWith('../')) {
    return false;
  }
  if (normTarget.startsWith('/') || /^[A-Za-z]:\//.test(normTarget)) {
    return Boolean(options.workspaceRoot && isPathWithinScope(options.workspaceRoot, normTarget));
  }
  return true;
}

/**
 * 对资源引用字符串进行安全分类，区分相对路径、根相对路径、外部 CDN、内联数据与危险协议。
 */
export function classifyPreviewResourceRef(rawRef: string): PreviewResourceKind {
  if (typeof rawRef !== 'string') return 'empty';
  const trimmed = rawRef.trim();
  if (!trimmed) return 'empty';
  if (/[\x00-\x1f]/.test(trimmed)) return 'unsafe';
  if (trimmed.startsWith('#')) return 'anchor';

  const compactLower = trimmed.replace(/[\u0000-\u0020]+/g, '').toLowerCase();
  if (
    compactLower.startsWith('javascript:') ||
    compactLower.startsWith('vbscript:') ||
    compactLower.startsWith('file:') ||
    /^data:(?:text\/html|application\/xhtml\+xml|text\/javascript|application\/javascript|application\/ecmascript|text\/ecmascript|application\/x-javascript)(?:[;,]|$)/.test(
      compactLower,
    )
  ) {
    return 'unsafe';
  }
  if (/^(?:mailto|tel):/i.test(trimmed)) return 'passthrough';
  if (/^https?:\/\//i.test(trimmed) || trimmed.startsWith('//')) return 'external_http';
  if (/^(?:data:|blob:|hermes-media:\/\/|hermes-preview:\/\/)/i.test(trimmed)) return 'inline_data';
  if (/^[A-Za-z]:[\\/]/.test(trimmed)) return 'root_relative';
  if (trimmed.startsWith('/') || trimmed.startsWith('\\')) return 'root_relative';
  if (/^[a-zA-Z][a-zA-Z\d+.-]+:/.test(trimmed)) return 'passthrough';
  return 'relative';
}

/**
 * 按 HTML `srcset` 语法拆分候选项，避免误将 `data:image/...;base64,<payload>` 中的逗号截断。
 */
export function splitSrcsetCandidates(rawValue: string): string[] {
  if (!rawValue) return [];
  const rawParts = rawValue.split(',');
  const merged: string[] = [];
  for (let i = 0; i < rawParts.length; i += 1) {
    const piece = rawParts[i].trim();
    if (!piece) continue;
    if (/^(?:literal:)?data:[^|]*$/i.test(piece) && i + 1 < rawParts.length) {
      merged.push(`${piece},${rawParts[i + 1].trim()}`);
      i += 1;
      continue;
    }
    merged.push(piece);
  }
  return merged;
}

function splitPathAndSuffix(ref: string): { pathPart: string; suffix: string } {
  const qIdx = ref.indexOf('?');
  const hIdx = ref.indexOf('#');
  let cut = -1;
  if (qIdx >= 0 && hIdx >= 0) cut = Math.min(qIdx, hIdx);
  else cut = qIdx >= 0 ? qIdx : hIdx;
  if (cut < 0) return { pathPart: ref, suffix: '' };
  return { pathPart: ref.slice(0, cut), suffix: ref.slice(cut) };
}

function hasRootEscapeTraversal(rawPosixPath: string): boolean {
  let depth = 0;
  for (const seg of rawPosixPath.replace(/\\/g, '/').split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      depth -= 1;
      if (depth < 0) return true;
      continue;
    }
    depth += 1;
  }
  return false;
}

/**
 * 解析文档内的相对/绝对资源引用为受保护的工作区路径或透传外部 URL。
 */
export function resolvePreviewResourceRef(
  rawRef: string,
  context: PreviewResourceContext,
): ResolvedPreviewRef {
  const kind = classifyPreviewResourceRef(rawRef);
  const trimmed = typeof rawRef === 'string' ? rawRef.trim() : '';

  if (kind === 'empty' || kind === 'anchor' || kind === 'passthrough' || kind === 'inline_data') {
    return { kind, rawRef };
  }
  if (kind === 'unsafe') {
    return { kind, rawRef, blocked: true, blockReason: 'unsafe_scheme_or_chars' };
  }
  if (kind === 'external_http') {
    const externalUrl = trimmed.startsWith('//') ? `https:${trimmed}` : trimmed;
    return { kind, rawRef, externalUrl };
  }

  const docRaw = (context.documentPath || '').trim();
  if (/^https?:\/\//i.test(docRaw)) {
    try {
      const resolvedUrl = new URL(trimmed, docRaw).href;
      return { kind: 'external_http', rawRef, externalUrl: resolvedUrl };
    } catch {
      return { kind, rawRef, blocked: true, blockReason: 'invalid_http_relative_ref' };
    }
  }

  const { pathPart, suffix } = splitPathAndSuffix(trimmed);
  let decodedPath = pathPart;
  try {
    decodedPath = decodeURIComponent(pathPart);
  // gate-degrade: 非法 URL 百分号序列保留原始字符以供后续安全检查
  } catch {
    decodedPath = pathPart;
  }

  if (
    !decodedPath ||
    decodedPath.includes('\0') ||
    hasPreviewEnvSecretSegment(pathPart) ||
    hasPreviewEnvSecretSegment(decodedPath)
  ) {
    return { kind, rawRef, blocked: true, blockReason: 'secret_or_null_path' };
  }

  const normWorkspaceRoot = context.workspaceRoot ? normalizeWorkspacePath(context.workspaceRoot) : '';
  const docClean = docRaw.split(/[?#]/)[0];
  let normDoc = normalizeWorkspacePath(docClean);
  const docIsRel = Boolean(normDoc && !normDoc.startsWith('/') && !/^[A-Za-z]:\//.test(normDoc));
  if (docIsRel && normWorkspaceRoot) {
    normDoc = normalizeWorkspacePath(
      normWorkspaceRoot.endsWith('/') ? `${normWorkspaceRoot}${normDoc}` : `${normWorkspaceRoot}/${normDoc}`,
    );
  }
  const docInWorkspace = Boolean(normWorkspaceRoot && normDoc && isPathWithinScope(normWorkspaceRoot, normDoc));
  const docDir = resolveDocumentDir(normDoc, normWorkspaceRoot);
  // Why: 作用域锚定遵循“工作区内锁定到 workspaceRoot，工作区外锁定到当前文档目录 docDir”，避免工作区外文档通过 / 跳入工作区或通过 ../ 越权向上遍历
  const scopeRoot = docInWorkspace ? normWorkspaceRoot : docDir;

  let resolved = '';
  if (kind === 'root_relative') {
    const posixDecoded = decodedPath.replace(/\\/g, '/');
    const isWinDrive = /^[A-Za-z]:\//.test(posixDecoded);
    if (!isWinDrive && hasRootEscapeTraversal(posixDecoded)) {
      return { kind, rawRef, blocked: true, blockReason: 'root_escape_traversal' };
    }
    const normCand = normalizeWorkspacePath(posixDecoded);
    if (docInWorkspace) {
      if (isPathWithinScope(normWorkspaceRoot, normCand)) {
        resolved = normCand;
      } else if (isWinDrive) {
        return { kind, rawRef, blocked: true, blockReason: 'outside_workspace_drive' };
      } else {
        const sub = normCand.replace(/^\/+/, '');
        resolved = sub
          ? normalizeWorkspacePath(normWorkspaceRoot.endsWith('/') ? `${normWorkspaceRoot}${sub}` : `${normWorkspaceRoot}/${sub}`)
          : '';
      }
    } else if (!docDir) {
      return { kind, rawRef, blocked: true, blockReason: 'security_scope_blocked' };
    } else {
      resolved = normCand;
    }
  } else {
    const posixDecoded = decodedPath.replace(/\\/g, '/');
    if (docDir) {
      resolved = normalizeWorkspacePath(docDir.endsWith('/') ? `${docDir}${posixDecoded}` : `${docDir}/${posixDecoded}`);
    } else {
      resolved = normalizeWorkspacePath(posixDecoded);
      if (resolved === '..' || resolved.startsWith('../')) {
        return { kind, rawRef, blocked: true, blockReason: 'traversal_outside_root' };
      }
    }
  }

  if (
    !resolved ||
    hasPreviewEnvSecretSegment(resolved) ||
    isPreviewSystemSensitivePath(resolved) ||
    (scopeRoot && !isPathWithinScope(scopeRoot, resolved))
  ) {
    return { kind, rawRef, blocked: true, blockReason: 'security_scope_blocked' };
  }

  return {
    kind,
    rawRef,
    resolvedPath: resolved,
    ...(suffix ? { suffix } : {}),
  };
}

/**
 * 跨端 UTF-8 -> Base64 编码器（零 Node `Buffer` 依赖，兼容浏览器与 Node 20+）。
 */
export function encodeUtf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

function estimateDataUrlByteSize(dataUrl: string): number {
  const commaIdx = dataUrl.indexOf(',');
  if (commaIdx < 0) return 0;
  const meta = dataUrl.slice(0, commaIdx).toLowerCase();
  const body = dataUrl.slice(commaIdx + 1);
  if (meta.includes(';base64')) {
    const padding = body.endsWith('==') ? 2 : body.endsWith('=') ? 1 : 0;
    return Math.max(0, Math.floor((body.length * 3) / 4) - padding);
  }
  return new TextEncoder().encode(body).byteLength;
}

function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

function buildErrorResult(path: string, mime: string, isText: boolean, error: string): ResolvedPreviewAssetResult {
  return {
    ok: false,
    path,
    mime,
    isText,
    byteSize: 0,
    source: 'error',
    error,
  };
}

function buildTextSuccessResult(
  path: string,
  mime: string,
  text: string,
  source: 'local_fs' | 'gateway_api' | 'session_tool',
  maxBytes: number,
  byteSizeOverride?: number,
): ResolvedPreviewAssetResult {
  const byteSize = byteSizeOverride ?? utf8ByteLength(text);
  if (byteSize > maxBytes) {
    return buildErrorResult(path, mime, true, 'asset_too_large');
  }
  return {
    ok: true,
    path,
    mime,
    isText: true,
    text,
    byteSize,
    source,
  };
}

function buildDataUrlSuccessResult(
  path: string,
  mime: string,
  dataUrl: string,
  source: 'local_fs' | 'gateway_api',
  maxBytes: number,
  byteSizeOverride?: number,
): ResolvedPreviewAssetResult {
  const byteSize =
    byteSizeOverride ??
    (dataUrl.startsWith('data:') ? estimateDataUrlByteSize(dataUrl) : 0);
  if (byteSize > maxBytes) {
    return buildErrorResult(path, mime, false, 'asset_too_large');
  }
  const isSvg = mime.split(';')[0].trim().toLowerCase() === 'image/svg+xml';
  let normalizedUrl = dataUrl;
  let decodedSvgText: string | undefined;
  if (isSvg && !dataUrl.startsWith('data:') && dataUrl.includes('<svg')) {
    const trimmedSvg = dataUrl.trim();
    decodedSvgText = trimmedSvg;
    normalizedUrl = `data:image/svg+xml;base64,${encodeUtf8ToBase64(trimmedSvg)}`;
  } else if (isSvg && dataUrl.startsWith('data:')) {
    decodedSvgText = decodeDataUrlUtf8(dataUrl) ?? undefined;
  }
  return {
    ok: true,
    path,
    mime,
    isText: false,
    ...(decodedSvgText !== undefined ? { text: decodedSvgText } : {}),
    dataUrl: normalizedUrl,
    byteSize,
    source,
  };
}

/**
 * 统一拉取 HTML/CSS/SVG/Markdown 预览所需的相对子资源（不受 BINARY_EXTENSIONS 误拦截）。
 */
export async function resolvePreviewAsset(
  targetPath: string,
  options: ResolvePreviewAssetOptions = {},
): Promise<ResolvedPreviewAssetResult> {
  const cleanTarget = (targetPath || '').trim();
  const detectedMime = detectPreviewAssetMime(cleanTarget) || 'application/octet-stream';
  const isSvg = detectedMime === 'image/svg+xml';
  const isText = isTextPreviewAssetMime(detectedMime);
  const isVideo = detectedMime.startsWith('video/');
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_PREVIEW_ASSET_BYTES;

  if (
    !cleanTarget ||
    cleanTarget.includes('\0') ||
    hasPreviewEnvSecretSegment(cleanTarget) ||
    isPreviewSystemSensitivePath(cleanTarget)
  ) {
    return buildErrorResult(cleanTarget, detectedMime, isText, 'blocked_path');
  }

  if (
    options.enforceWorkspaceScope &&
    !isPreviewAssetPathAllowed(cleanTarget, {
      workspaceRoot: options.workspaceRoot,
      enforceWorkspaceScope: true,
    })
  ) {
    return buildErrorResult(cleanTarget, detectedMime, isText, 'outside_workspace');
  }

  const preferLocal =
    !options.gatewayUrl ||
    isLoopbackGatewayUrl(options.gatewayUrl) ||
    options.sourceHint === 'local_fs';

  // 1. 本地 PAL 文件读取（回环或本地目录模式优先）
  if (preferLocal && options.platformBridge?.readFile) {
    try {
      const localVal = await options.platformBridge.readFile(cleanTarget);
      if (typeof localVal === 'string') {
        if (isText) {
          const text = localVal.startsWith('data:') ? decodeDataUrlUtf8(localVal) : localVal;
          if (text !== null) {
            return buildTextSuccessResult(cleanTarget, detectedMime, text, 'local_fs', maxBytes);
          }
        } else if (localVal.startsWith('data:') || localVal.startsWith('blob:')) {
          return buildDataUrlSuccessResult(cleanTarget, detectedMime, localVal, 'local_fs', maxBytes);
        } else if (isSvg && localVal.includes('<svg')) {
          return buildDataUrlSuccessResult(cleanTarget, detectedMime, localVal, 'local_fs', maxBytes);
        }
      }
    // gate-degrade: 本地读取失败或未命中时继续回落远程网关与工具缓存
    } catch {}
  }

  // 2. 视频流直连 URL（仅当调用方显式允许非内联流式协议时）
  if (isVideo && options.allowVideoStreamUrl && options.platformBridge?.resolveMediaStreamUrl) {
    try {
      const streamUrl = await options.platformBridge.resolveMediaStreamUrl({
        filePath: cleanTarget,
        gatewayUrl: options.gatewayUrl,
        profile: options.profile,
        sessionId: options.sessionId,
      });
      if (streamUrl && isDirectVideoStreamUrl(streamUrl)) {
        return {
          ok: true,
          path: cleanTarget,
          mime: detectedMime,
          isText: false,
          dataUrl: streamUrl,
          byteSize: 0,
          source: streamUrl.startsWith('hermes-media://local/') || !options.gatewayUrl ? 'local_fs' : 'gateway_api',
        };
      }
    // gate-degrade: 流式视频通道不可用时继续走网关代理拉取
    } catch {}
  }

  // 3. 远端网关代理拉取（严格绕开 BINARY_EXTENSIONS 阻断，同时守卫 SPA 回退与体积预算）
  if (options.platformBridge?.httpProxy && options.gatewayUrl) {
    const fsParams = new URLSearchParams({ path: cleanTarget });
    if (options.profile) fsParams.set('profile', options.profile);
    if (options.sessionId) fsParams.set('session_id', options.sessionId);
    const fsQuery = fsParams.toString();
    const encTarget = encodeURIComponent(cleanTarget);

    if (isText) {
      try {
        const res = await options.platformBridge.httpProxy({
          baseUrl: options.gatewayUrl,
          path: `/api/fs/read-text?${fsQuery}`,
          method: 'GET',
        });
        if (res && typeof res === 'object') {
          const rec = res as Record<string, unknown>;
          const recSize = typeof rec.byteSize === 'number' && Number.isFinite(rec.byteSize) ? rec.byteSize : undefined;
          if (rec.binary === true) {
            return buildErrorResult(cleanTarget, detectedMime, true, 'unexpected_binary');
          }
          if (rec.truncated === true || (recSize !== undefined && recSize > maxBytes)) {
            return buildErrorResult(cleanTarget, detectedMime, true, 'asset_too_large');
          }
          if (typeof rec.text === 'string' && !isSpaFallbackHtml(rec.text, cleanTarget)) {
            return buildTextSuccessResult(cleanTarget, detectedMime, rec.text, 'gateway_api', maxBytes, recSize);
          }
        }
      } catch (err) {
        console.warn('[previewResourceResolver] /api/fs/read-text failed:', cleanTarget, err);
      }

      try {
        const res = await options.platformBridge.httpProxy({
          baseUrl: options.gatewayUrl,
          path: `/api/files/read?path=${encTarget}`,
          method: 'GET',
        });
        if (res && typeof res === 'object') {
          const rec = res as Record<string, unknown>;
          const recSize = typeof rec.size === 'number' && Number.isFinite(rec.size) ? rec.size : undefined;
          if (recSize !== undefined && recSize > maxBytes) {
            return buildErrorResult(cleanTarget, detectedMime, true, 'asset_too_large');
          }
          if (typeof rec.data_url === 'string') {
            const decoded = decodeDataUrlUtf8(rec.data_url);
            if (decoded !== null && !isSpaFallbackHtml(decoded, cleanTarget)) {
              return buildTextSuccessResult(cleanTarget, detectedMime, decoded, 'gateway_api', maxBytes, recSize);
            }
          }
        }
      } catch (err) {
        console.warn('[previewResourceResolver] /api/files/read failed:', cleanTarget, err);
      }

      for (const endpoint of [`/api/fs/download?${fsQuery}`, `/api/files/download?path=${encTarget}`]) {
        try {
          const res = await options.platformBridge.httpProxy({
            baseUrl: options.gatewayUrl,
            path: endpoint,
            method: 'GET',
          });
          const text = typeof res === 'string'
            ? res
            : res && typeof (res as Record<string, unknown>).content === 'string'
              ? String((res as Record<string, unknown>).content)
              : null;
          if (
            typeof text === 'string' &&
            !text.includes('Cannot GET') &&
            !text.includes('404 Not Found') &&
            !isSpaFallbackHtml(text, cleanTarget)
          ) {
            return buildTextSuccessResult(cleanTarget, detectedMime, text, 'gateway_api', maxBytes);
          }
        } catch (err) {
          console.warn('[previewResourceResolver] text download fallback failed:', endpoint, err);
        }
      }
    } else {
      const endpoints = [
        `/api/fs/read-data-url?${fsQuery}`,
        `/api/files/read?path=${encTarget}`,
        `/api/fs/download?${fsQuery}`,
        `/api/files/download?path=${encTarget}`,
      ];
      for (const endpoint of endpoints) {
        try {
          const res = await options.platformBridge.httpProxy({
            baseUrl: options.gatewayUrl,
            path: endpoint,
            method: 'GET',
          });
          const rec = res && typeof res === 'object' ? (res as Record<string, unknown>) : null;
          const candidate =
            rec && typeof rec.dataUrl === 'string'
              ? rec.dataUrl
              : rec && typeof rec.data_url === 'string'
                ? rec.data_url
                : typeof res === 'string'
                  ? res
                  : '';
          const recSize = rec
            ? typeof rec.byteSize === 'number'
              ? rec.byteSize
              : typeof rec.size === 'number'
                ? rec.size
                : undefined
            : undefined;
          if (!candidate || isSpaFallbackHtml(candidate, cleanTarget)) continue;
          if (
            candidate.startsWith('data:') ||
            candidate.startsWith('blob:') ||
            (isSvg && candidate.includes('<svg'))
          ) {
            return buildDataUrlSuccessResult(cleanTarget, detectedMime, candidate, 'gateway_api', maxBytes, recSize);
          }
        } catch (err) {
          console.warn('[previewResourceResolver] binary endpoint failed:', endpoint, err);
        }
      }
    }
  }

  // 4. 非回环模式下若本地也有桥接且前面远端未命中，允许最后探测一次会话工具产物
  if ((isText || isSvg) && options.messages && options.messages.length > 0) {
    const cached = extractFileContentFromSessionTools(cleanTarget, options.messages);
    if (cached !== null) {
      if (isSvg) {
        return buildDataUrlSuccessResult(cleanTarget, detectedMime, cached, 'local_fs', maxBytes);
      }
      return buildTextSuccessResult(cleanTarget, detectedMime, cached, 'session_tool', maxBytes);
    }
  }

  return buildErrorResult(cleanTarget, detectedMime, isText, 'asset_unavailable');
}
