/**
 * 桌面端零缓冲流式媒体协议控制器 (Hermes Media Stream Protocol)
 *
 * 【设计意图 (Why)】
 *   解决大型视频成果物（数 MB 至数十 MB 以上）经 `gateway:http-proxy` / `fs:read-file`
 *   全量缓冲转 Base64 Data URL 带来的 10~90 秒无响应假死、IPC 大包阻塞及 30 秒超时截断问题：
 *   1. 通过 Electron 特权自定义协议 `hermes-media://` 直接向 `<video>` 暴露原生流式字节通道；
 *   2. 本地文件按 HTTP `Range` 分片 `fs.createReadStream({ start, end })` 返回 `206 Partial Content`；
 *   3. 远端网关文件透传 `Range` 请求头、同源 `Cookie` 与上游流式响应体 (`ReadableStream`)，
 *      实现秒开首帧与任意进度条拖拽定位（Zero-Buffer Streaming）。
 *
 * 【防范的历史坑 (Pitfall)】
 *   1. Cookie 跨源泄漏：仅当请求目标 `base` 与已认证的 `activeGatewayOrigin` 严格同源时才注入 Cookie；
 *   2. 恶意或非预期本地调用：协议仅响应携带本进程随机秘钥 `token` 的 URL，并经 `resolveSafeLocalSourceFile`
 *      阻断系统敏感根目录与 `.env*` 机密文件；
 *   3. 网关 SPA 回退劫持：上游返回 `text/html` 时必须丢弃响应体并转为 `404`，严禁把控制台网页喂给播放器。
 *
 * 【约束与规则 (Rules)】
 *   - 仅允许可内联播放的视频格式进入流式媒体协议；
 *   - 所有 4xx/5xx/HTML 分支必须在丢弃响应体后返回明确状态码（Failure Is Not Empty）。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import { Readable } from 'node:stream';
import {
  detectMediaMimeFromRequestPath,
  isLoopbackGatewayUrl,
  isVideoExtension,
  normalizeHttpBaseUrl,
} from '@hermes-flux/core';
import { resolveSafeLocalSourceFile } from './workspaceFs';

export const HERMES_MEDIA_SCHEME = 'hermes-media';

export interface MediaStreamGatewayAuth {
  cookies: string;
  origin: string;
}

export interface MediaStreamControllerDeps {
  getGatewayAuth: (targetOrigin?: string) => MediaStreamGatewayAuth;
  getFallbackCwd: () => string;
  nonce?: string;
  fetchImpl?: typeof fetch;
  resolveLocalFile?: (rawSourcePath: string | undefined, fallbackCwd?: string) => string | null;
  statFile?: (absPath: string) => { size: number; isFile: () => boolean };
  createReadStream?: (absPath: string, opts?: { start?: number; end?: number }) => Readable;
}

export interface BuildMediaStreamUrlOptions {
  filePath: string;
  gatewayUrl?: string;
  profile?: string;
  sessionId?: string;
}

export interface MediaStreamController {
  buildStreamUrl(options: BuildMediaStreamUrlOptions): string | null;
  handleProtocolRequest(request: Request): Promise<Response>;
}

function hasEnvSecretSegment(rawPath: string): boolean {
  return rawPath
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean)
    .some((seg) => {
      const lower = seg.trim().toLowerCase();
      return lower === '.env' || (lower.startsWith('.env.') && lower !== '.env.example');
    });
}

function isSafePathCandidate(filePath: string): boolean {
  const clean = (filePath || '').trim();
  if (!clean || clean.includes('\0')) return false;
  if (hasEnvSecretSegment(clean)) return false;
  return isVideoExtension(clean);
}

/**
 * 解析标准单区间 HTTP `Range: bytes=...` 请求头。
 * 多区间或非 `bytes=` 头按 RFC 9110 忽略并返回 `null`（回退全量 200）；非法或越界区间返回 `'invalid'`（416）。
 */
export function parseByteRangeHeader(
  rangeHeader: string | null | undefined,
  totalSize: number,
): { start: number; end: number } | 'invalid' | null {
  if (!rangeHeader || typeof rangeHeader !== 'string') return null;
  const trimmed = rangeHeader.trim();
  if (!trimmed.toLowerCase().startsWith('bytes=')) return null;
  const spec = trimmed.slice(6).trim();
  if (!spec || spec.includes(',')) return null;
  if (totalSize <= 0) return 'invalid';

  const dashIdx = spec.indexOf('-');
  if (dashIdx < 0) return 'invalid';
  const startRaw = spec.slice(0, dashIdx).trim();
  const endRaw = spec.slice(dashIdx + 1).trim();

  if (!startRaw && !endRaw) return 'invalid';

  if (!startRaw) {
    if (!/^\d+$/.test(endRaw)) return 'invalid';
    const suffix = Number(endRaw);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return 'invalid';
    const start = Math.max(0, totalSize - suffix);
    return { start, end: totalSize - 1 };
  }

  if (!/^\d+$/.test(startRaw)) return 'invalid';
  const start = Number(startRaw);
  if (!Number.isSafeInteger(start) || start < 0 || start >= totalSize) {
    return 'invalid';
  }

  if (!endRaw) {
    return { start, end: totalSize - 1 };
  }

  if (!/^\d+$/.test(endRaw)) return 'invalid';
  const rawEnd = Number(endRaw);
  if (!Number.isSafeInteger(rawEnd) || rawEnd < start) {
    return 'invalid';
  }

  return { start, end: Math.min(rawEnd, totalSize - 1) };
}

async function cancelBodySafely(res: Response): Promise<void> {
  const body = (res as { body?: { cancel?: () => Promise<unknown> } | null }).body;
  if (body && typeof body.cancel === 'function') {
    await body.cancel().catch(() => {});
  }
}

function toWebReadableStream(nodeStream: Readable): ReadableStream<Uint8Array> {
  let settled = false;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      nodeStream.on('data', (chunk: Buffer | Uint8Array | string) => {
        if (settled) return;
        const bytes =
          typeof chunk === 'string'
            ? new TextEncoder().encode(chunk)
            : new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
        controller.enqueue(bytes);
        if (Number(controller.desiredSize) <= 0) {
          nodeStream.pause();
        }
      });
      nodeStream.on('end', () => {
        if (settled) return;
        settled = true;
        controller.close();
      });
      nodeStream.on('error', (err) => {
        if (settled) return;
        settled = true;
        controller.error(err);
      });
    },
    pull() {
      if (!settled) {
        nodeStream.resume();
      }
    },
    cancel() {
      settled = true;
      nodeStream.destroy();
    },
  });
}

/**
 * 构建支持本地分片读流与远端网关透传的 `hermes-media://` 控制器。
 */
export function createMediaStreamController(deps: MediaStreamControllerDeps): MediaStreamController {
  const sessionNonce = deps.nonce || crypto.randomBytes(16).toString('hex');
  const fetchImpl = deps.fetchImpl ?? fetch;
  const resolveLocal = deps.resolveLocalFile ?? resolveSafeLocalSourceFile;
  const statFile = deps.statFile ?? ((p: string) => fs.statSync(p));
  const createStream =
    deps.createReadStream ??
    ((p: string, opts?: { start?: number; end?: number }) => fs.createReadStream(p, opts));

  function buildStreamUrl(options: BuildMediaStreamUrlOptions): string | null {
    const cleanPath = (options.filePath || '').trim();
    if (!isSafePathCandidate(cleanPath)) return null;

    const gatewayRaw = (options.gatewayUrl || '').trim();
    const fallbackCwd = deps.getFallbackCwd();
    const preferLocal = !gatewayRaw || isLoopbackGatewayUrl(gatewayRaw);

    if (preferLocal) {
      const localAbs = resolveLocal(cleanPath, fallbackCwd);
      if (localAbs) {
        const q = new URLSearchParams({ token: sessionNonce, path: cleanPath });
        return `${HERMES_MEDIA_SCHEME}://local/stream?${q.toString()}`;
      }
      if (!gatewayRaw) return null;
    }

    if (
      /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(gatewayRaw) &&
      !/^(?:https?|wss?):\/\//i.test(gatewayRaw)
    ) {
      return null;
    }

    const base = normalizeHttpBaseUrl(gatewayRaw);
    let parsedBase: URL;
    try {
      parsedBase = new URL(base);
    } catch (err) {
      console.warn('[mediaStreamProtocol] invalid gateway base URL:', base, err);
      return null;
    }

    const q = new URLSearchParams({
      token: sessionNonce,
      base: parsedBase.origin,
      path: cleanPath,
    });
    if (options.profile) q.set('profile', options.profile);
    if (options.sessionId) q.set('session_id', options.sessionId);
    return `${HERMES_MEDIA_SCHEME}://gateway/stream?${q.toString()}`;
  }

  async function serveLocalStream(request: Request, filePath: string, mime: string): Promise<Response> {
    const absPath = resolveLocal(filePath, deps.getFallbackCwd());
    if (!absPath) {
      return new Response(null, { status: 404 });
    }

    let totalSize = 0;
    try {
      const stat = statFile(absPath);
      if (!stat.isFile()) return new Response(null, { status: 404 });
      totalSize = stat.size;
    } catch {
      return new Response(null, { status: 404 });
    }

    const isHead = request.method.toUpperCase() === 'HEAD';
    const parsedRange = parseByteRangeHeader(request.headers.get('range'), totalSize);

    if (parsedRange === 'invalid') {
      return new Response(null, {
        status: 416,
        headers: {
          'Content-Range': `bytes */${totalSize}`,
          'Accept-Ranges': 'bytes',
        },
      });
    }

    if (parsedRange) {
      const chunkLen = parsedRange.end - parsedRange.start + 1;
      const body = isHead
        ? null
        : toWebReadableStream(createStream(absPath, { start: parsedRange.start, end: parsedRange.end }));
      return new Response(body, {
        status: 206,
        headers: {
          'Content-Type': mime,
          'Content-Length': String(chunkLen),
          'Content-Range': `bytes ${parsedRange.start}-${parsedRange.end}/${totalSize}`,
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'private, max-age=60',
        },
      });
    }

    const body = isHead || totalSize === 0 ? null : toWebReadableStream(createStream(absPath));
    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': mime,
        'Content-Length': String(totalSize),
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'private, max-age=60',
      },
    });
  }

  async function serveGatewayStream(request: Request, url: URL, filePath: string, videoMime: string): Promise<Response> {
    const baseRaw = (url.searchParams.get('base') || '').trim();
    if (!baseRaw) return new Response(null, { status: 400 });

    let parsedBase: URL;
    try {
      parsedBase = new URL(baseRaw);
    } catch {
      return new Response(null, { status: 400 });
    }
    if (parsedBase.protocol !== 'http:' && parsedBase.protocol !== 'https:') {
      return new Response(null, { status: 403 });
    }

    const profile = (url.searchParams.get('profile') || '').trim();
    const sessionId = (url.searchParams.get('session_id') || '').trim();
    const primaryQuery = new URLSearchParams({ path: filePath });
    if (profile) primaryQuery.set('profile', profile);
    if (sessionId) primaryQuery.set('session_id', sessionId);

    const primaryUrl = `${parsedBase.origin}/api/fs/download?${primaryQuery.toString()}`;
    const headers: Record<string, string> = {
      Origin: parsedBase.origin,
    };
    const rangeHeader = request.headers.get('range');
    if (rangeHeader) {
      headers['Range'] = rangeHeader;
    }
    const auth = deps.getGatewayAuth(parsedBase.origin);
    if (auth.cookies && auth.origin && parsedBase.origin.toLowerCase() === auth.origin.toLowerCase()) {
      headers['Cookie'] = auth.cookies;
    }

    const method = request.method.toUpperCase() === 'HEAD' ? 'HEAD' : 'GET';
    let upstreamRes: Response;
    try {
      upstreamRes = await fetchImpl(primaryUrl, {
        method,
        headers,
        redirect: 'manual',
        signal: request.signal,
      });
      if (upstreamRes.status === 404) {
        await cancelBodySafely(upstreamRes);
        const fallbackUrl = `${parsedBase.origin}/api/files/download?path=${encodeURIComponent(filePath)}`;
        upstreamRes = await fetchImpl(fallbackUrl, {
          method,
          headers,
          redirect: 'manual',
          signal: request.signal,
        });
      }
      if (upstreamRes.status >= 300 && upstreamRes.status < 400) {
        await cancelBodySafely(upstreamRes);
        return new Response(null, { status: 502 });
      }
    } catch (err) {
      console.warn('[mediaStreamProtocol] gateway stream request failed:', err);
      return new Response(null, { status: 502 });
    }

    if (!upstreamRes.ok) {
      await cancelBodySafely(upstreamRes);
      return new Response(null, { status: upstreamRes.status });
    }

    const rawCt = (upstreamRes.headers.get('content-type') || '').trim();
    const lowerCt = rawCt.toLowerCase();
    if (lowerCt.includes('text/html')) {
      await cancelBodySafely(upstreamRes);
      return new Response(null, { status: 404 });
    }

    const mime =
      rawCt && !lowerCt.startsWith('application/octet-stream')
        ? rawCt
        : videoMime;

    const respHeaders = new Headers({
      'Content-Type': mime,
      'Cache-Control': 'private, max-age=60',
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
      return new Response(null, { status: 400 });
    }

    if (parsedUrl.protocol !== `${HERMES_MEDIA_SCHEME}:`) {
      return new Response(null, { status: 400 });
    }

    if (parsedUrl.searchParams.get('token') !== sessionNonce) {
      return new Response(null, { status: 403 });
    }

    const filePath = (parsedUrl.searchParams.get('path') || '').trim();
    const videoMime = detectMediaMimeFromRequestPath(filePath);
    if (!videoMime || !isSafePathCandidate(filePath)) {
      return new Response(null, { status: 403 });
    }

    if (parsedUrl.hostname === 'local') {
      return await serveLocalStream(request, filePath, videoMime);
    }
    if (parsedUrl.hostname === 'gateway') {
      return await serveGatewayStream(request, parsedUrl, filePath, videoMime);
    }
    return new Response(null, { status: 404 });
  }

  return {
    buildStreamUrl,
    handleProtocolRequest,
  };
}
