/**
 * HTML / CSS / SVG 派生预览资源内联器 (packages/core/src/fs/htmlPreviewBundler.ts)
 *
 * 【设计意图 (Why)】
 *   1. 在 Mobile (Capacitor) 或无自定义协议的静态沙箱宿主中，`iframe srcdoc` 无法发起相对路径请求；
 *   2. 独立 SVG 以 `<img src="data:image/svg+xml;...">` 预览时，浏览器出于安全隔离会阻断内部外部资源；
 *   3. 本模块以纯函数方式对派生副本重写 CSS `@import`/`url(...)`、`<link>`、`<script src>`、媒体属性与 SVG `<image>`，
 *      产出只读渲染副本，**绝不破坏或修改源文件与内存 `file.content`**。
 *
 * 【约束与规则 (Rules)】
 *   - 零 DOM / Node `fs` 依赖，纯异步文本转换；
 *   - 严格强制资产数量上限（默认 64）、单资产上限（5 MiB）与总内联体积预算（20 MiB），防止 OOM；
 *   - 递归 CSS `@import` 必须带环检测（`visitedPaths`）与最大深度（默认 4）；
 *   - 所有外部 CDN (`http(s)://`) 与页内锚点 (`#...`) 原样保留，不做代理重写。
 */

import { decodeDataUrlUtf8 } from './fileService.js';
import {
  DEFAULT_MAX_PREVIEW_ASSET_BYTES,
  encodeUtf8ToBase64,
  resolvePreviewAsset,
  resolvePreviewResourceRef,
  splitSrcsetCandidates,
  type ResolvePreviewAssetOptions,
  type ResolvedPreviewAssetResult,
} from './previewResourceResolver.js';

export const DEFAULT_MAX_BUNDLED_ASSETS = 64;
export const DEFAULT_MAX_BUNDLED_TOTAL_BYTES = 20 * 1024 * 1024;
export const DEFAULT_MAX_CSS_IMPORT_DEPTH = 4;

export interface PreviewBundlerOptions extends Omit<ResolvePreviewAssetOptions, 'maxBytes'> {
  documentPath: string;
  workspaceRoot?: string;
  maxAssets?: number;
  maxAssetBytes?: number;
  maxTotalBytes?: number;
  maxCssDepth?: number;
  assetFetcher?: (targetPath: string) => Promise<ResolvedPreviewAssetResult>;
}

export interface InlinedHtmlPreviewResult {
  html: string;
  inlinedCount: number;
  failedRefs: string[];
  totalBytes: number;
}

export interface InlinedSvgPreviewResult {
  dataUrl: string;
  inlinedCount: number;
  failedRefs: string[];
}

interface BundlerSessionState {
  workspaceRoot?: string;
  maxAssets: number;
  maxTotalBytes: number;
  maxCssDepth: number;
  inlinedCount: number;
  totalBytes: number;
  failedRefs: Set<string>;
  cache: Map<string, Promise<ResolvedPreviewAssetResult>>;
  fetchRaw: (targetPath: string) => Promise<ResolvedPreviewAssetResult>;
}

function createBundlerSession(options: PreviewBundlerOptions): BundlerSessionState {
  const maxAssetBytes = options.maxAssetBytes ?? DEFAULT_MAX_PREVIEW_ASSET_BYTES;
  const maxAssets = options.maxAssets ?? DEFAULT_MAX_BUNDLED_ASSETS;
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_BUNDLED_TOTAL_BYTES;
  const maxCssDepth = options.maxCssDepth ?? DEFAULT_MAX_CSS_IMPORT_DEPTH;

  const fetchImpl =
    options.assetFetcher ??
    ((targetPath: string) =>
      resolvePreviewAsset(targetPath, {
        ...options,
        maxBytes: maxAssetBytes,
        enforceWorkspaceScope: options.enforceWorkspaceScope,
      }));

  const cache = new Map<string, Promise<ResolvedPreviewAssetResult>>();
  const session: BundlerSessionState = {
    workspaceRoot: options.workspaceRoot,
    maxAssets,
    maxTotalBytes,
    maxCssDepth,
    inlinedCount: 0,
    totalBytes: 0,
    failedRefs: new Set<string>(),
    cache,
    fetchRaw: (targetPath: string) => {
      const hit = cache.get(targetPath);
      if (hit) return hit;
      const task = (async (): Promise<ResolvedPreviewAssetResult> => {
        if (session.inlinedCount >= session.maxAssets || session.totalBytes >= session.maxTotalBytes) {
          return {
            ok: false,
            path: targetPath,
            mime: 'application/octet-stream',
            isText: false,
            byteSize: 0,
            source: 'error',
            error: 'bundle_budget_exceeded',
          };
        }
        const res = await fetchImpl(targetPath);
        if (res.ok) {
          if (session.inlinedCount >= session.maxAssets || session.totalBytes + res.byteSize > session.maxTotalBytes) {
            return {
              ok: false,
              path: targetPath,
              mime: res.mime,
              isText: res.isText,
              byteSize: res.byteSize,
              source: 'error',
              error: 'bundle_budget_exceeded',
            };
          }
          session.inlinedCount += 1;
          session.totalBytes += res.byteSize;
        }
        return res;
      })();
      cache.set(targetPath, task);
      return task;
    },
  };
  return session;
}

function stripOuterQuotes(raw: string): { quote: string; value: string } {
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2)
  ) {
    return { quote: trimmed[0], value: trimmed.slice(1, -1) };
  }
  return { quote: '', value: trimmed };
}

function escapeHtmlAttrValue(val: string): string {
  return val
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function replaceAsync(
  input: string,
  regex: RegExp,
  replacer: (...args: string[]) => Promise<string>,
): Promise<string> {
  const re = new RegExp(regex.source, regex.flags);
  const matches: Array<{ index: number; len: number; args: string[] }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(input)) !== null) {
    matches.push({ index: m.index, len: m[0].length, args: [...m] });
  }
  if (matches.length === 0) return input;

  const replacements = await Promise.all(matches.map((hit) => replacer(...hit.args)));
  let out = '';
  let last = 0;
  for (let i = 0; i < matches.length; i += 1) {
    out += input.slice(last, matches[i].index);
    out += replacements[i];
    last = matches[i].index + matches[i].len;
  }
  out += input.slice(last);
  return out;
}

function maskCssComments(cssText: string): { masked: string; comments: string[] } {
  const comments: string[] = [];
  const masked = cssText.replace(/\/\*[\s\S]*?\*\//g, (comment) => {
    const idx = comments.length;
    comments.push(comment);
    return `/*__FLUX_CSS_COMMENT_${idx}__*/`;
  });
  return { masked, comments };
}

function unmaskCssComments(cssText: string, comments: string[]): string {
  if (comments.length === 0) return cssText;
  return cssText.replace(/\/\*__FLUX_CSS_COMMENT_(\d+)__\*\//g, (full, idxStr: string) => {
    const idx = Number(idxStr);
    return comments[idx] ?? full;
  });
}

async function inlineCssWithState(
  cssText: string,
  cssFilePath: string,
  session: BundlerSessionState,
  visitedPaths: Set<string>,
  depth: number,
): Promise<string> {
  if (!cssText) return '';
  const { masked, comments } = maskCssComments(cssText);

  // 1. 递归处理 @import（支持 @import "x.css"; 与 @import url("x.css") screen;）
  const importRe = /@import\s+(?:url\(\s*([^)]+)\s*\)|("[^"]*"|'[^']*'))([^;\r\n]*);?/gi;
  const afterImport = await replaceAsync(
    masked,
    importRe,
    async (fullMatch, urlArg: string, strArg: string, mediaTail: string) => {
      const rawToken = urlArg || strArg;
      const { value: rawRef } = stripOuterQuotes(rawToken);
      const resolved = resolvePreviewResourceRef(rawRef, {
        documentPath: cssFilePath,
        workspaceRoot: session.workspaceRoot,
      });
      if (resolved.blocked) {
        session.failedRefs.add(rawRef);
        return `/* blocked @import: ${rawRef.replace(/\*\//g, '')} */`;
      }
      if (!resolved.resolvedPath) {
        return fullMatch;
      }
      if (depth >= session.maxCssDepth || visitedPaths.has(resolved.resolvedPath)) {
        return `/* skipped cyclic or deep @import: ${resolved.resolvedPath.replace(/\*\//g, '')} */`;
      }
      const asset = await session.fetchRaw(resolved.resolvedPath);
      if (!asset.ok || typeof asset.text !== 'string') {
        session.failedRefs.add(rawRef);
        return fullMatch;
      }
      const nextVisited = new Set(visitedPaths);
      nextVisited.add(resolved.resolvedPath);
      const nested = await inlineCssWithState(asset.text, resolved.resolvedPath, session, nextVisited, depth + 1);
      const media = (mediaTail || '').trim();
      return media ? `@media ${media} {\n${nested}\n}` : nested;
    },
  );

  // 2. 重写 CSS url(...) 相对引用（保留 #id 矢量引用与外链 CDN）
  const urlRe = /url\(\s*([^)]+?)\s*\)/gi;
  const afterUrls = await replaceAsync(afterImport, urlRe, async (fullMatch, innerRaw: string) => {
    const { value: rawRef } = stripOuterQuotes(innerRaw);
    const resolved = resolvePreviewResourceRef(rawRef, {
      documentPath: cssFilePath,
      workspaceRoot: session.workspaceRoot,
    });
    if (resolved.blocked) {
      session.failedRefs.add(rawRef);
      return 'url("")';
    }
    if (!resolved.resolvedPath) {
      return fullMatch;
    }
    const asset = await session.fetchRaw(resolved.resolvedPath);
    if (!asset.ok || !asset.dataUrl) {
      session.failedRefs.add(rawRef);
      return fullMatch;
    }
    const safeUrl = asset.dataUrl.replace(/"/g, '%22');
    return `url("${safeUrl}${resolved.suffix && resolved.suffix.startsWith('#') ? resolved.suffix : ''}")`;
  });

  return unmaskCssComments(afterUrls, comments);
}

/**
 * 纯函数将 CSS 中的相对 `@import` 与 `url(...)` 递归重写为可独立渲染的内联 CSS（不修改源文件）。
 */
export async function inlineCssRelativeAssets(
  cssText: string,
  cssFilePath: string,
  options: Omit<PreviewBundlerOptions, 'documentPath'> = {},
): Promise<string> {
  const session = createBundlerSession({ ...options, documentPath: cssFilePath });
  const visited = new Set<string>([cssFilePath]);
  return inlineCssWithState(cssText, cssFilePath, session, visited, 0);
}

interface ParsedHtmlAttr {
  name: string;
  lowerName: string;
  value: string | null;
  quote: '"' | "'" | '';
  raw: string;
}

function parseHtmlTagAttributes(attrSource: string): ParsedHtmlAttr[] {
  const attrs: ParsedHtmlAttr[] = [];
  const attrRe = /([A-Za-z_:][A-Za-z0-9_.:-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = attrRe.exec(attrSource)) !== null) {
    const name = m[1];
    let value: string | null = null;
    let quote: '"' | "'" | '' = '';
    if (typeof m[2] === 'string') {
      value = m[2];
      quote = '"';
    } else if (typeof m[3] === 'string') {
      value = m[3];
      quote = "'";
    } else if (typeof m[4] === 'string') {
      value = m[4];
      quote = '';
    }
    attrs.push({
      name,
      lowerName: name.toLowerCase(),
      value,
      quote,
      raw: m[0],
    });
  }
  return attrs;
}

function serializeHtmlAttrs(attrs: readonly ParsedHtmlAttr[]): string {
  return (
    ' ' +
    attrs
      .map((a) => (a.value === null ? a.name : `${a.name}="${escapeHtmlAttrValue(a.value)}"`))
      .join(' ')
  );
}

async function resolveDataUriOrKeep(
  rawRef: string,
  session: BundlerSessionState,
  documentPath: string,
): Promise<{ dataUrl?: string; handled: boolean; blocked?: boolean }> {
  const resolved = resolvePreviewResourceRef(rawRef, {
    documentPath,
    workspaceRoot: session.workspaceRoot,
  });
  if (resolved.blocked) {
    session.failedRefs.add(rawRef);
    return { handled: true, blocked: true };
  }
  if (!resolved.resolvedPath) {
    return { handled: false };
  }
  const asset = await session.fetchRaw(resolved.resolvedPath);
  if (!asset.ok || !asset.dataUrl) {
    session.failedRefs.add(rawRef);
    return { handled: true };
  }
  const frag = resolved.suffix && resolved.suffix.startsWith('#') ? resolved.suffix : '';
  return { handled: true, dataUrl: `${asset.dataUrl}${frag}` };
}

async function rewriteSrcsetAttr(
  srcsetValue: string,
  session: BundlerSessionState,
  documentPath: string,
): Promise<string> {
  const parts = splitSrcsetCandidates(srcsetValue);
  const rewritten = await Promise.all(
    parts.map(async (part) => {
      const spIdx = part.search(/\s/);
      const ref = spIdx >= 0 ? part.slice(0, spIdx) : part;
      const descriptor = spIdx >= 0 ? part.slice(spIdx) : '';
      const resolved = await resolveDataUriOrKeep(ref, session, documentPath);
      if (resolved.dataUrl) {
        return `${resolved.dataUrl}${descriptor}`;
      }
      if (resolved.blocked) {
        return '';
      }
      return part;
    }),
  );
  return rewritten.filter(Boolean).join(', ');
}

const URL_ATTRS = new Set(['src', 'poster', 'href', 'xlink:href', 'data']);

async function rewriteHtmlFragment(
  fragment: string,
  session: BundlerSessionState,
  documentPath: string,
): Promise<string> {
  // 匹配 <tag ...>（跳过 <!doctype ...> 与关闭标签 </...>）
  const tagRe = /<([A-Za-z][A-Za-z0-9:-]*)(\s+[^>]*?)?(\/?)>/g;
  return replaceAsync(fragment, tagRe, async (fullTag, tagName: string, rawAttrs: string, selfClose: string) => {
    if (!rawAttrs) return fullTag;
    const lowerTag = tagName.toLowerCase();
    const attrs = parseHtmlTagAttributes(rawAttrs);
    if (attrs.length === 0) return fullTag;

    // 1. <link rel="stylesheet" href="./..."> 替换为内联 <style>
    if (lowerTag === 'link') {
      const relAttr = attrs.find((a) => a.lowerName === 'rel');
      const relTokens = (relAttr?.value || '').toLowerCase().split(/\s+/).filter(Boolean);
      const hrefAttr = attrs.find((a) => a.lowerName === 'href');
      if (relTokens.includes('stylesheet') && !relTokens.includes('alternate') && hrefAttr?.value) {
        const res = resolvePreviewResourceRef(hrefAttr.value, {
          documentPath,
          workspaceRoot: session.workspaceRoot,
        });
        if (res.blocked) {
          session.failedRefs.add(hrefAttr.value);
          return `<!-- blocked stylesheet: ${escapeHtmlAttrValue(hrefAttr.value)} -->`;
        }
        if (res.resolvedPath) {
          const cssAsset = await session.fetchRaw(res.resolvedPath);
          if (cssAsset.ok && typeof cssAsset.text === 'string') {
            const inlinedCss = await inlineCssWithState(
              cssAsset.text,
              res.resolvedPath,
              session,
              new Set([res.resolvedPath]),
              0,
            );
            const mediaAttr = attrs.find((a) => a.lowerName === 'media')?.value?.trim();
            const wrappedCss = mediaAttr && mediaAttr !== 'all' ? `@media ${mediaAttr} {\n${inlinedCss}\n}` : inlinedCss;
            const safeBody = wrappedCss.replace(/<\/style/gi, '<\\/style');
            return `<style data-inlined-href="${escapeHtmlAttrValue(hrefAttr.value)}">${safeBody}</style>`;
          }
          session.failedRefs.add(hrefAttr.value);
          return fullTag;
        }
        return fullTag;
      }

      // icon / manifest 等仅重写相对 href，不把普通 <a> 导航链接内联
      if (
        hrefAttr?.value &&
        (relTokens.includes('icon') || relTokens.includes('shortcut') || relTokens.includes('apple-touch-icon'))
      ) {
        const iconRes = await resolveDataUriOrKeep(hrefAttr.value, session, documentPath);
        if (iconRes.dataUrl) {
          hrefAttr.value = iconRes.dataUrl;
          return `<${tagName}${serializeHtmlAttrs(attrs)}${selfClose}>`;
        }
        if (iconRes.blocked) {
          hrefAttr.value = '';
          return `<${tagName}${serializeHtmlAttrs(attrs)}${selfClose}>`;
        }
      }
      return fullTag;
    }

    // 2. 其他标签（含 <a> 以外的媒体/embed/object/image/feImage/use 以及 style="url(...)"）
    let changed = false;
    for (const attr of attrs) {
      if (attr.value === null) continue;
      if (attr.lowerName === 'style' && /url\s*\(/i.test(attr.value)) {
        const updatedStyle = await inlineCssWithState(
          attr.value,
          documentPath,
          session,
          new Set([documentPath]),
          0,
        );
        if (updatedStyle !== attr.value) {
          attr.value = updatedStyle;
          changed = true;
        }
        continue;
      }

      if (attr.lowerName === 'srcset' && (lowerTag === 'img' || lowerTag === 'source')) {
        const nextSrcset = await rewriteSrcsetAttr(attr.value, session, documentPath);
        if (nextSrcset !== attr.value) {
          attr.value = nextSrcset;
          changed = true;
        }
        continue;
      }

      if (!URL_ATTRS.has(attr.lowerName)) continue;
      // <a href="..."> 保留文档相对链接原样，避免误把整站页面转换成 data:
      if (lowerTag === 'a' && attr.lowerName === 'href') continue;

      const resolved = await resolveDataUriOrKeep(attr.value, session, documentPath);
      if (resolved.dataUrl) {
        attr.value = resolved.dataUrl;
        changed = true;
      } else if (resolved.blocked) {
        // Pitfall: URL_ATTRS covers href / poster / xlink:href / src 等多种可执行或外链载体，被安全拦截时必须全部清空而非只清空 src
        attr.value = '';
        changed = true;
      }
    }

    return changed ? `<${tagName}${serializeHtmlAttrs(attrs)}${selfClose}>` : fullTag;
  });
}

/**
 * 构建 HTML 文档的只读内联渲染副本（供 Mobile / 无自定义协议沙箱预览使用，不破坏原始源码）。
 */
export async function buildInlinedHtmlPreview(
  rawHtml: string,
  options: PreviewBundlerOptions,
): Promise<InlinedHtmlPreviewResult> {
  if (!rawHtml) {
    return { html: '', inlinedCount: 0, failedRefs: [], totalBytes: 0 };
  }

  const session = createBundlerSession(options);
  // 词法分段：严格隔离 <!-- 注释 -->、<script>...</script>、<style>...</style> 与普通 HTML 区域
  const blockRe = /(<!--[\s\S]*?-->|<script\b([^>]*)>([\s\S]*?)<\/script>|<style\b([^>]*)>([\s\S]*?)<\/style>)/gi;
  const parts: string[] = [];
  let cursor = 0;
  let m: RegExpExecArray | null;

  while ((m = blockRe.exec(rawHtml)) !== null) {
    if (m.index > cursor) {
      parts.push(await rewriteHtmlFragment(rawHtml.slice(cursor, m.index), session, options.documentPath));
    }

    const fullBlock = m[0];
    if (fullBlock.startsWith('<!--')) {
      parts.push(fullBlock);
    } else if (typeof m[2] === 'string') {
      // <script ...>...</script>
      const rawAttrs = m[2];
      const attrs = parseHtmlTagAttributes(rawAttrs);
      const srcAttr = attrs.find((a) => a.lowerName === 'src');
      if (srcAttr?.value) {
        const res = resolvePreviewResourceRef(srcAttr.value, {
          documentPath: options.documentPath,
          workspaceRoot: session.workspaceRoot,
        });
        if (res.blocked) {
          session.failedRefs.add(srcAttr.value);
          parts.push(`<!-- blocked script: ${escapeHtmlAttrValue(srcAttr.value)} -->`);
        } else if (res.resolvedPath) {
          const jsAsset = await session.fetchRaw(res.resolvedPath);
          if (jsAsset.ok && typeof jsAsset.text === 'string') {
            const filteredAttrs = attrs.filter((a) => a.lowerName !== 'src');
            const safeBody = jsAsset.text.replace(/<\/script/gi, '<\\/script');
            parts.push(`<script${serializeHtmlAttrs(filteredAttrs)} data-inlined-src="${escapeHtmlAttrValue(srcAttr.value)}">${safeBody}</script>`);
          } else {
            session.failedRefs.add(srcAttr.value);
            parts.push(fullBlock);
          }
        } else {
          parts.push(fullBlock);
        }
      } else {
        parts.push(fullBlock);
      }
    } else {
      // <style ...>...</style>
      const rawAttrs = m[4] ?? '';
      const innerCss = m[5] ?? '';
      const inlinedCss = await inlineCssWithState(
        innerCss,
        options.documentPath,
        session,
        new Set([options.documentPath]),
        0,
      );
      const safeCss = inlinedCss.replace(/<\/style/gi, '<\\/style');
      parts.push(`<style${rawAttrs}>${safeCss}</style>`);
    }

    cursor = m.index + fullBlock.length;
  }

  if (cursor < rawHtml.length) {
    parts.push(await rewriteHtmlFragment(rawHtml.slice(cursor), session, options.documentPath));
  }

  return {
    html: parts.join(''),
    inlinedCount: session.inlinedCount,
    failedRefs: Array.from(session.failedRefs),
    totalBytes: session.totalBytes,
  };
}

/**
 * 构建 SVG 文件的只读内联渲染 Data URL（仅当 SVG 含相对子资源时才触发重写；无相对引用返回 null）。
 */
export async function buildInlinedSvgPreview(
  rawSvgOrDataUrl: string,
  options: PreviewBundlerOptions,
): Promise<InlinedSvgPreviewResult | null> {
  if (!rawSvgOrDataUrl || typeof rawSvgOrDataUrl !== 'string') return null;

  let svgText = rawSvgOrDataUrl;
  if (rawSvgOrDataUrl.startsWith('data:image/svg+xml')) {
    const decoded = decodeDataUrlUtf8(rawSvgOrDataUrl);
    if (!decoded) return null;
    svgText = decoded;
  } else if (!rawSvgOrDataUrl.includes('<svg')) {
    return null;
  }

  // 快速探测：不含外部/相对引用特征时不额外构造副本
  if (!/(?:href|src|url\s*\(|<style)/i.test(svgText)) {
    return null;
  }

  const session = createBundlerSession(options);
  const styleBlockRe = /<style\b([^>]*)>([\s\S]*?)<\/style>/gi;
  const parts: string[] = [];
  let cursor = 0;
  let m: RegExpExecArray | null;

  while ((m = styleBlockRe.exec(svgText)) !== null) {
    if (m.index > cursor) {
      parts.push(await rewriteHtmlFragment(svgText.slice(cursor, m.index), session, options.documentPath));
    }
    const inlinedCss = await inlineCssWithState(
      m[2] ?? '',
      options.documentPath,
      session,
      new Set([options.documentPath]),
      0,
    );
    parts.push(`<style${m[1] ?? ''}>${inlinedCss.replace(/<\/style/gi, '<\\/style')}</style>`);
    cursor = m.index + m[0].length;
  }

  if (cursor < svgText.length) {
    parts.push(await rewriteHtmlFragment(svgText.slice(cursor), session, options.documentPath));
  }

  if (session.inlinedCount === 0 && session.failedRefs.size === 0) {
    return null;
  }

  const rewrittenSvg = parts.join('');
  return {
    dataUrl: `data:image/svg+xml;base64,${encodeUtf8ToBase64(rewrittenSvg)}`,
    inlinedCount: session.inlinedCount,
    failedRefs: Array.from(session.failedRefs),
  };
}
