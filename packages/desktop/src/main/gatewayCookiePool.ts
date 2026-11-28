/**
 * Electron 主进程多源 Cookie 池与 HTTP 代理目标安全校验
 *
 * 【设计意图 (Why)】
 *   1. 将历史单槽全局变量 `activeGatewayCookies` / `activeGatewayOrigin` 升级为按 `origin`
 *      物理分桶的 `GatewayCookiePool`，防止多网关并发连接、认证或拉流时 Cookie 互相覆盖或跨源泄漏；
 *   2. 在主进程 HTTP Proxy 边界强制校验目标 URL 与相对路径、阻断 `../` 路径穿越与任意 3xx
 *      跨域重定向窃取请求头/Cookie。
 *
 * 【防范的历史坑 (Pitfall)】
 *   1. 连接 Gateway B 后覆盖全局单槽 `activeGatewayOrigin`，导致 Gateway A 的 REST/媒体请求全部 401；
 *   2. 恶意反代或受损网关返回 302 Location 指向第三方地址时，Node `fetch` 默认 `redirect: 'follow'`
 *      会带着代理请求继续外发，存在请求/头信息外泄风险。
 *
 * 【约束与规则 (Rules)】
 *   - Cookie 仅向同 `origin`（scheme + host + port 小写一致）目标注入；
 *   - 任意 `3xx` 重定向必须阻断并显式抛错（Failure Is Not Empty）。
 */

export interface GatewayCookieSnapshot {
  readonly origin: string;
  readonly cookies: string;
}

/** 将网关地址规范化为无末尾斜杠的 `http://` 或 `https://` 基址。 */
export function normalizeGatewayBaseUrl(rawUrl: string): string {
  let base = (rawUrl || '').trim();
  if (!base) return '';
  if (base.startsWith('ws://')) base = base.replace('ws://', 'http://');
  if (base.startsWith('wss://')) base = base.replace('wss://', 'https://');
  if (!/^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(base)) {
    base = `https://${base}`;
  }
  return base.replace(/\/+$/, '');
}

/** 解析规范化 `origin`（小写）；非法 URL 返回空串。 */
export function getGatewayOrigin(rawUrl: string): string {
  try {
    return new URL(rawUrl).origin.toLowerCase();
  // gate-degrade: 非法 URL 无法解析 origin，返回空串按未配置或无匹配处理
  } catch {
    return '';
  }
}

/** 按目标网关 `origin` 独立存储认证 Cookie 的多源隔离池。 */
export class GatewayCookiePool {
  private readonly entries = new Map<string, string>();
  private latestOrigin = '';

  public set(gatewayUrl: string, cookies: string): void {
    if (!cookies) {
      this.clear(gatewayUrl);
      return;
    }
    const origin = getGatewayOrigin(gatewayUrl);
    if (!origin) return;
    this.entries.set(origin, cookies);
    this.latestOrigin = origin;
  }

  public clear(gatewayUrl: string): void {
    const origin = getGatewayOrigin(gatewayUrl);
    if (!origin) return;
    this.entries.delete(origin);
    if (this.latestOrigin === origin) {
      this.latestOrigin = '';
    }
  }

  public clearAll(): void {
    this.entries.clear();
    this.latestOrigin = '';
  }

  public getForUrl(targetUrl: string): string {
    const origin = getGatewayOrigin(targetUrl);
    if (!origin) return '';
    return this.entries.get(origin) ?? '';
  }

  public getSnapshot(targetOrigin?: string): GatewayCookieSnapshot {
    if (targetOrigin) {
      const normalized = getGatewayOrigin(targetOrigin);
      return {
        origin: normalized,
        cookies: this.entries.get(normalized) ?? '',
      };
    }
    if (!this.latestOrigin) {
      return { origin: '', cookies: '' };
    }
    return {
      origin: this.latestOrigin,
      cookies: this.entries.get(this.latestOrigin) ?? '',
    };
  }
}

export interface ValidatedProxyTarget {
  readonly baseUrl: string;
  readonly origin: string;
  readonly fullUrl: string;
}

function hasPathTraversalSegment(pathname: string): boolean {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  // gate-degrade: URL 解码失败属于恶意/畸形编码路径，按包含路径穿越直接拒绝
  } catch {
    return true;
  }
  const segments = decoded.replace(/\\/g, '/').split('/');
  return segments.some((seg) => seg === '..');
}

/**
 * 校验并拼接 `gateway:http-proxy` 目标 URL：
 * - 拒绝非 http(s) 基址、协议相对路径（`//...`）、绝对 URL 路径、CRLF/NUL 字符及 `..` 路径穿越；
 * - 确保最终 URL 的 `origin` 与请求指定的网关 `origin` 严格一致。
 */
export function validateGatewayProxyTarget(options: {
  baseUrl: string;
  path: string;
  params?: unknown;
}): ValidatedProxyTarget {
  const baseUrl = normalizeGatewayBaseUrl(options.baseUrl);
  if (!baseUrl) {
    throw new Error('未配置网关地址');
  }
  const parsedBase = new URL(baseUrl);
  if (parsedBase.protocol !== 'http:' && parsedBase.protocol !== 'https:') {
    throw new Error('仅支持 http/https 网关地址');
  }

  const rawPath = options.path;
  if (!rawPath || /[\r\n\0]/.test(rawPath)) {
    throw new Error('非法代理请求路径');
  }
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(rawPath) || rawPath.startsWith('//')) {
    throw new Error('非法代理路径：禁止跳转外部协议或主机');
  }

  const normalizedRel = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
  const pathWithoutQuery = normalizedRel.split('?')[0];
  if (hasPathTraversalSegment(pathWithoutQuery)) {
    throw new Error('非法代理路径：禁止路径穿越');
  }

  const target = new URL(normalizedRel, parsedBase.origin);
  if (target.origin !== parsedBase.origin) {
    throw new Error('非法代理路径：目标域与网关域不一致');
  }

  if (options.params && typeof options.params === 'object') {
    for (const [k, v] of Object.entries(options.params)) {
      if (typeof v !== 'undefined' && v !== null) {
        target.searchParams.append(k, String(v));
      }
    }
  }

  return {
    baseUrl: parsedBase.origin,
    origin: parsedBase.origin.toLowerCase(),
    fullUrl: target.toString(),
  };
}

/** 拦截并拒绝网关代理请求收到的 3xx HTTP 重定向。 */
export function assertNoProxyRedirect(
  _targetUrl: string,
  response: { status: number; headers?: { get(name: string): string | null } },
): void {
  if (response.status >= 300 && response.status < 400) {
    const loc = response.headers?.get('location') ?? '';
    throw new Error(`网关代理禁止重定向 HTTP ${response.status}${loc ? ` -> ${loc}` : ''}`);
  }
}
