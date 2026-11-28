/**
 * Markdown 渲染核心（对标 OpenChamber）。
 * 【设计意图 (Why)】此前 renderMarkdown 是 1200 行正则手写，边界情况（嵌套列表、表格对齐、
 *   流式未闭合、代码块内的特殊字符）持续出 bug，且每种元素各写一套内联样式，排版必然散。
 *   现在解析交给 marked，流式补全交给 remend，XSS 清洗交给 DOMPurify，
 *   我们只保留自己的排版 CSS 与「文件/URL 交互胶囊」这两个业务定制。
 * 【约束与规则 (Rules)】
 *   1. 渲染器只输出语义 HTML + 少量业务类名，禁止输出内联字号/行高/背景色；
 *   2. 行内 code 与文件引用不加底色与边框，类型识别交给文件图标；
 *   3. Node（SSR/测试）环境无 DOM，DOMPurify 不可用时不静默清空内容，直接返回已解析 HTML。
 */

import { marked, type Tokens } from 'marked';
import remend from 'remend';
import DOMPurify from 'dompurify';
import {
  classifyDeliverableKind,
  isVideoExtension,
  resolvePreviewResourceRef,
  splitSrcsetCandidates,
  stripMediaTags,
} from '@hermes-flux/core';
import { t } from '../i18n/index.js';
import { escapeHtml, isLikelyFilePath, isLikelyHttpUrl } from './text.js';
import { renderFileTypeIcon } from './fileTypeIcons.js';
import { isTouchedFileRef, normalizeFileRef } from './fileRefs.js';
import { formatDeliverableExtLabel, resolveDeliverableDisplayName } from './deliverableViewModel.js';
import { highlightCode, isHighlightReady } from './highlight.js';

/**
 * 当前渲染批次内「会话真实读写过的文件」「本回合确认的成果物文件」及「文档预览上下文」。
 * 【设计意图 (Why)】marked 的 renderer 在模块初始化时绑定，拿不到每次调用的参数；
 *   解析是同步的，用一次性的活动上下文传递上下文比给每个 renderer 再造一套实例更轻。
 * 【约束与规则 (Rules)】只在 renderMarkdownCore 内同步设置，finally 必须恢复原值。
 */
let activeKnownFiles: readonly string[] = [];
let activeDeliverableFiles: readonly string[] = [];
let activeDocumentBasePath = '';
let activeWorkspaceRoot = '';
let activeResolvedAssetUrls: Readonly<Record<string, string>> | undefined;

function fileRefLinked(ref: string): boolean {
  return isTouchedFileRef(ref, activeKnownFiles);
}

function matchDeliverableTarget(ref: string): string | null {
  if (!activeDeliverableFiles.length) return null;
  const target = normalizeFileRef(ref);
  if (!target) return null;

  const absolute = target.startsWith('/') || /^[a-zA-Z]:\//.test(target);
  const targetBase = target.split('/').pop() || target;
  const basenameMatches: string[] = [];

  for (const raw of activeDeliverableFiles) {
    const known = normalizeFileRef(raw);
    if (!known) continue;
    if (known === target) return raw;
    if (absolute && known.endsWith(target)) return raw;
    if (!absolute && target.includes('/') && known.endsWith(`/${target}`)) return raw;
    if (!absolute && !target.includes('/') && (known.split('/').pop() || known) === targetBase) {
      basenameMatches.push(raw);
    }
  }

  return basenameMatches.length === 1 ? basenameMatches[0] : null;
}

function isUnsafeMarkdownUri(raw: string, allowSafeDataUri: boolean): boolean {
  const compactLower = raw.replace(/[\u0000-\u0020]+/g, '').toLowerCase();
  if (
    compactLower.startsWith('javascript:') ||
    compactLower.startsWith('vbscript:') ||
    compactLower.startsWith('file:')
  ) {
    return true;
  }
  if (!compactLower.startsWith('data:')) return false;
  if (!allowSafeDataUri) return true;
  return /^data:(?:text\/html|application\/xhtml\+xml|text\/javascript|application\/javascript|application\/ecmascript|text\/ecmascript|application\/x-javascript)(?:[;,]|$)/.test(
    compactLower,
  );
}

function addClassToAttrs(attrs: string, className: string): string {
  const classRe = /(\sclass\s*=\s*)(?:"([^"]*)"|'([^']*)')/i;
  const m = classRe.exec(attrs);
  if (!m) {
    return `${attrs} class="${className}"`;
  }
  const existing = (m[2] ?? m[3]) || '';
  const tokens = existing.split(/\s+/).filter(Boolean);
  if (tokens.includes(className)) return attrs;
  return attrs.replace(classRe, () => `${m[1]}"${existing ? `${existing} ` : ''}${className}"`);
}

function stripAuthorInternalDataAttrs(htmlChunk: string): string {
  if (!/data-(?:preview-|deliverable-|media-src)/i.test(htmlChunk)) return htmlChunk;
  // Pitfall: SANITIZE_CONFIG 允许内部渲染器生成的 data-preview-* / data-deliverable-*，必须在 raw HTML 阶段先剥离作者手写注入属性
  return htmlChunk.replace(
    /<([A-Za-z][A-Za-z0-9:-]*)(\s+(?:"[^"]*"|'[^']*'|[^>"'])*)(\/?)>/g,
    (_fullTag, tagName: string, rawAttrs: string, selfClose: string) => {
      const cleaned = rawAttrs.replace(
        /\s+(?:data-preview-[a-z0-9-]+|data-deliverable-[a-z0-9-]+|data-media-src)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/gi,
        '',
      );
      return `<${tagName}${cleaned}${selfClose}>`;
    },
  );
}

/**
 * 将正文中命中的成果物路径原地替换为紧凑小卡片（桌面与移动端完全同构）。
 * 仅展示纯文件名 + 类型图标（图片预留 24px 缩略图槽位） + 短格式徽标，完整路径收进 hover tooltip。
 */
function renderInlineDeliverableCard(resolvedPath: string): string {
  const kind = classifyDeliverableKind(resolvedPath);
  const fileName = resolveDeliverableDisplayName(resolvedPath);
  const extLabel = formatDeliverableExtLabel(fileName, kind);
  const escapedPath = escapeHtml(resolvedPath);
  const escapedName = escapeHtml(fileName);
  const escapedExt = escapeHtml(extLabel);
  const leading =
    kind === 'image'
      ? `<span class="conv-inline-deliverable__thumb" data-deliverable-thumb="${escapedPath}">${renderFileTypeIcon(
          resolvedPath,
          'conv-inline-deliverable__thumb-fallback',
        )}</span>`
      : renderFileTypeIcon(resolvedPath, 'conv-inline-deliverable__icon');

  const previewAttr = kind === 'image' ? '' : ` data-preview-file="${escapedPath}"`;
  return `<button type="button" class="conv-inline-deliverable md-file-ref" data-deliverable-card="true" data-deliverable-kind="${escapeHtml(
    kind,
  )}" data-deliverable-path="${escapedPath}" data-deliverable-name="${escapedName}"${previewAttr} data-file-ref="${escapedPath}" title="${escapedPath}">${leading}<span class="conv-inline-deliverable__name">${escapedName}</span><span class="conv-inline-deliverable__ext">${escapedExt}</span><span class="conv-inline-deliverable__chevron" aria-hidden="true">›</span></button>`;
}

/**
 * 文件引用三种形态：
 *   1. 命中本回合成果物 → 原地紧凑小卡片；
 *   2. 会话里真实读写过（非成果物）→ 代码药丸 + 文件图标 + 点击预览；
 *   3. 只是正文里提到 → 普通代码药丸，不画下划线、不给指针光标。
 */
function renderFileRef(text: string, rawText: string): string {
  const deliverableTarget = matchDeliverableTarget(text);
  if (deliverableTarget) {
    return renderInlineDeliverableCard(deliverableTarget);
  }
  if (!fileRefLinked(text)) {
    return `<code class="md-code md-file-ref" data-file-ref="${escapeHtml(text)}">${escapeHtml(rawText)}</code>`;
  }
  const tip = t('inspector.clickToPreview', { file: text });
  return `<code class="md-code md-file-ref md-file-ref--linked tool-file-link content-interactive-link" data-preview-file="${escapeHtml(
    text
  )}" data-file-ref="${escapeHtml(text)}" title="${escapeHtml(tip)}">${renderFileTypeIcon(text)}${escapeHtml(rawText)}</code>`;
}

/**
 * 行内代码 / 文件引用 / URL 引用。
 * 【设计意图 (Why)】文件引用靠文件类型图标与可点击性识别，而不是靠无差别的下划线；
 *   只有 Agent 真正读写过的文件才允许变成链接。
 */
export function formatInlineCodeOrLink(rawText: string): string {
  const text = rawText.trim();
  const isHttp = isLikelyHttpUrl(text);
  const isFile = !isHttp && isLikelyFilePath(text);

  if (!isHttp && !isFile) {
    return `<code class="md-code">${escapeHtml(rawText)}</code>`;
  }

  if (isHttp) {
    const tip = t('inspector.clickToOpenLink', { url: text });
    return `<a class="md-link md-link--url tool-file-link content-interactive-link" data-preview-url="${escapeHtml(
      text
    )}" href="${escapeHtml(text)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(tip)}"><span class="md-link__icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg></span><span class="md-link__label">${escapeHtml(
      rawText
    )}</span></a>`;
  }

  return renderFileRef(text, rawText);
}

/** 单遍词法高亮（保留原有实现，shiki 需要异步管线，后续可替换）。 */
export function highlightCodeSyntax(code: string): string {
  if (!code) return '';

  const tokenRegex =
    /(\/\/[^\n]*|\{\/\*[\s\S]*?\*\/\}|\/\*[\s\S]*?\*\/)|(["'`][\s\S]*?["'`])|(<\/?[a-zA-Z0-9_-]+)|(\b[a-zA-Z0-9_-]+(?==))|\b(const|let|var|function|return|if|else|for|while|import|from|export|default|class|async|await|try|catch|type|interface|extends|implements)\b|\b(\d+)\b/g;

  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let output = '';

  while ((match = tokenRegex.exec(code)) !== null) {
    if (match.index > lastIndex) {
      output += escapeHtml(code.slice(lastIndex, match.index));
    }

    const [fullMatch, comment, stringLit, jsxTag, jsxAttr, keyword, numberLit] = match;

    if (comment) {
      output += `<span style="color: var(--hl-comment, var(--text-muted)); font-style: italic;">${escapeHtml(comment)}</span>`;
    } else if (stringLit) {
      output += `<span style="color: var(--hl-string, var(--accent));">${escapeHtml(stringLit)}</span>`;
    } else if (jsxTag) {
      output += `<span style="color: var(--hl-keyword, var(--accent)); font-weight: 600;">${escapeHtml(jsxTag)}</span>`;
    } else if (jsxAttr) {
      output += `<span style="color: var(--hl-type, var(--hl-number, var(--text-secondary)));">${escapeHtml(jsxAttr)}</span>`;
    } else if (keyword) {
      output += `<span style="color: var(--hl-keyword, var(--accent-dim)); font-weight: 600;">${escapeHtml(keyword)}</span>`;
    } else if (numberLit) {
      output += `<span style="color: var(--hl-number, var(--text-secondary));">${escapeHtml(numberLit)}</span>`;
    }

    lastIndex = tokenRegex.lastIndex;
  }

  if (lastIndex < code.length) {
    output += escapeHtml(code.slice(lastIndex));
  }

  return output;
}

const PLAIN_LANGUAGES = new Set(['log', 'txt', 'text', 'logcat', 'output', 'plaintext']);
const HIGHLIGHT_SIZE_LIMIT = 25000;

/**
 * 代码块：无表头的细边框容器 + 右上角复制按钮 + 可横向滚动的 pre。
 *
 * 【设计意图 (Why)】
 *   顶部语言条会让每个代码块都多出一条"假表头"，在连续阅读时形成一堵横向墙。
 *   语言信息已由代码本身表达，复制动作属于辅助操作，应当弱化并贴近内容右上角。
 *
 * 【约束与规则 (Rules)】
 *   1. 复制按钮必须保留 .md-codeblock__copy 与 data-md-copy，宿主事件委托依赖它；
 *   2. 按钮是容器的直接子元素，绝对定位在右上角，不参与文档流；
 *   3. 禁止在此处新增任何会撑高容器的横向条。
 */
function renderCodeBlock(code: string, rawLang: string | undefined): string {
  const lang = (rawLang || '').trim().toLowerCase();
  const isPlain = PLAIN_LANGUAGES.has(lang) || code.length > HIGHLIGHT_SIZE_LIMIT;
  // Shiki 覆盖主流语言；不在白名单时回退到轻量词法高亮，最后才纯文本
  const highlighted = isPlain ? null : highlightCode(code, lang);
  const body = highlighted ?? (isPlain ? escapeHtml(code) : highlightCodeSyntax(code));
  const langLabel = escapeHtml(lang || 'text');

  return `<div class="md-codeblock code-block-wrapper" data-lang="${langLabel}"><button type="button" class="md-codeblock__copy" data-md-copy="true" title="${escapeHtml(
    t('common.copy')
  )}" aria-label="${escapeHtml(t('common.copy'))}">${escapeHtml(
    t('common.copy')
  )}</button><pre class="md-pre"><code class="language-${langLabel}">${body}</code></pre></div>`;
}

const parser = marked.use({
  gfm: true,
  breaks: true,
  renderer: {
    code({ text, lang }: Tokens.Code) {
      return renderCodeBlock(text, lang);
    },
    codespan({ text }: Tokens.Codespan) {
      return formatInlineCodeOrLink(text);
    },
    link({ href, title, tokens }: Tokens.Link) {
      const target = href ?? '';
      const label = this.parser.parseInline(tokens);
      const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
      const trimmed = target.trim();
      if (isUnsafeMarkdownUri(trimmed, false)) {
        return label;
      }

      if (trimmed.startsWith('#') && activeDocumentBasePath) {
        return `<a class="md-link md-link--anchor" href="${escapeHtml(trimmed)}" data-preview-anchor="${escapeHtml(
          trimmed.slice(1)
        )}"${titleAttr}>${label}</a>`;
      }

      if (isLikelyHttpUrl(target)) {
        return `<a class="md-link md-link--url tool-file-link content-interactive-link" data-preview-url="${escapeHtml(
          target
        )}" href="${escapeHtml(target)}" target="_blank" rel="noopener noreferrer"${titleAttr}>${label}</a>`;
      }

      if (activeDocumentBasePath) {
        const ref = resolvePreviewResourceRef(target, {
          documentPath: activeDocumentBasePath,
          workspaceRoot: activeWorkspaceRoot || undefined,
        });
        if (ref.blocked) {
          return `<span class="md-link md-asset-blocked"${titleAttr}>${label}</span>`;
        }
        if ((ref.kind === 'relative' || ref.kind === 'root_relative') && ref.resolvedPath) {
          return `<a class="md-link md-link--file md-file-ref md-file-ref--linked tool-file-link content-interactive-link" data-preview-file="${escapeHtml(
            ref.resolvedPath
          )}" data-file-ref="${escapeHtml(target)}" href="${escapeHtml(target)}" target="_blank" rel="noopener noreferrer"${titleAttr}>${renderFileTypeIcon(
            ref.resolvedPath
          )}<span class="md-link__label">${label}</span></a>`;
        }
      }

      if (isLikelyFilePath(target)) {
        const deliverableTarget = matchDeliverableTarget(target);
        if (deliverableTarget) {
          return renderInlineDeliverableCard(deliverableTarget);
        }
        if (!fileRefLinked(target)) {
          return `<span class="md-link md-link--file md-file-ref" data-file-ref="${escapeHtml(target)}"${titleAttr}>${label}</span>`;
        }
        return `<a class="md-link md-link--file md-file-ref md-file-ref--linked tool-file-link content-interactive-link" data-preview-file="${escapeHtml(
          target
        )}" data-file-ref="${escapeHtml(target)}" href="${escapeHtml(target)}" target="_blank" rel="noopener noreferrer"${titleAttr}>${renderFileTypeIcon(
          target
        )}<span class="md-link__label">${label}</span></a>`;
      }
      return `<a class="md-link" href="${escapeHtml(target)}" target="_blank" rel="noopener noreferrer"${titleAttr}>${label}</a>`;
    },
    image({ href, title, text }: Tokens.Image) {
      const target = (href ?? '').trim();
      const lower = target.toLowerCase();
      if (!target || isUnsafeMarkdownUri(target, true)) {
        return escapeHtml(text || '');
      }
      const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
      const isDirectMedia =
        lower.startsWith('https://') ||
        lower.startsWith('http://') ||
        lower.startsWith('data:image/') ||
        lower.startsWith('blob:') ||
        lower.startsWith('hermes-media://') ||
        lower.startsWith('hermes-preview://');
      if (isDirectMedia) {
        return `<img class="md-inline-image" src="${escapeHtml(target)}" alt="${escapeHtml(
          text || ''
        )}" loading="lazy" data-media-src="${escapeHtml(target)}" data-media-name="${escapeHtml(
          text || ''
        )}"${titleAttr} />`;
      }

      if (activeDocumentBasePath || activeWorkspaceRoot) {
        const ref = resolvePreviewResourceRef(target, {
          documentPath: activeDocumentBasePath || (activeWorkspaceRoot ? `${activeWorkspaceRoot}/__session__.md` : ''),
          workspaceRoot: activeWorkspaceRoot || undefined,
        });
        if (ref.blocked) {
          return `<span class="md-asset-blocked" title="${escapeHtml(text || target)}">${escapeHtml(text || target)}</span>`;
        }
        if (ref.externalUrl) {
          return `<img class="md-inline-image" src="${escapeHtml(ref.externalUrl)}" alt="${escapeHtml(
            text || ''
          )}" loading="lazy" data-media-src="${escapeHtml(ref.externalUrl)}" data-media-name="${escapeHtml(
            text || ''
          )}"${titleAttr} />`;
        }
        if (ref.resolvedPath) {
          const preResolved = activeResolvedAssetUrls?.[ref.resolvedPath];
          if (isVideoExtension(ref.resolvedPath)) {
            return `<video class="md-inline-video" controls playsinline preload="metadata" data-preview-asset-path="${escapeHtml(
              ref.resolvedPath
            )}" data-preview-asset-raw="${escapeHtml(target)}"${
              preResolved ? ` src="${escapeHtml(preResolved)}"` : ''
            }></video>`;
          }
          const srcAttr = preResolved
            ? ` src="${escapeHtml(preResolved)}" data-media-src="${escapeHtml(preResolved)}"`
            : '';
          const pendingClass = preResolved ? '' : ' md-inline-image--pending';
          return `<img class="md-inline-image${pendingClass}"${srcAttr} alt="${escapeHtml(
            text || ''
          )}" loading="lazy" data-preview-asset-path="${escapeHtml(
            ref.resolvedPath
          )}" data-preview-asset-raw="${escapeHtml(target)}" data-media-name="${escapeHtml(
            text || ''
          )}"${titleAttr} />`;
        }
      }

      if (isLikelyFilePath(target)) {
        const deliverableTarget = matchDeliverableTarget(target);
        if (deliverableTarget) {
          return renderInlineDeliverableCard(deliverableTarget);
        }
        if (!fileRefLinked(target)) {
          return `<span class="md-link md-link--file md-file-ref" data-file-ref="${escapeHtml(target)}"${titleAttr}>${escapeHtml(text || target)}</span>`;
        }
        return `<a class="md-link md-link--file md-file-ref md-file-ref--linked tool-file-link content-interactive-link" data-preview-file="${escapeHtml(
          target
        )}" data-file-ref="${escapeHtml(target)}" href="${escapeHtml(
          target
        )}" target="_blank" rel="noopener noreferrer"${titleAttr}>${renderFileTypeIcon(
          target
        )}<span class="md-link__label">${escapeHtml(text || target)}</span></a>`;
      }
      return escapeHtml(text || '');
    },
    html({ text }: Tokens.HTML | Tokens.Tag) {
      return stripAuthorInternalDataAttrs(text);
    },
  },
});

/**
 * 把 TSV 表格转成 GFM 管道表格。
 * 【设计意图 (Why)】Agent 经常直接输出制表符分隔的对比表，marked 只认管道表格。
 * 【约束与规则 (Rules)】跳过围栏代码块内部；行首有缩进（列表/代码）不参与转换。
 */
function convertTsvTables(md: string): string {
  const lines = md.split('\n');
  const out: string[] = [];
  let inFence = false;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      out.push(line);
      i += 1;
      continue;
    }
    if (inFence) {
      out.push(line);
      i += 1;
      continue;
    }

    const isTsvRow = (value: string): boolean =>
      value.includes('\t') && !/^\s/.test(value) && value.trim().length > 0;

    if (!isTsvRow(line)) {
      out.push(line);
      i += 1;
      continue;
    }

    const block: string[] = [];
    while (i < lines.length && isTsvRow(lines[i])) {
      block.push(lines[i]);
      i += 1;
    }

    if (block.length < 2) {
      out.push(...block);
      continue;
    }

    const toRow = (value: string): string =>
      '| ' +
      value
        .split('\t')
        .map((cell) => cell.trim().replace(/\|/g, '\\|'))
        .join(' | ') +
      ' |';
    const columnCount = block[0].split('\t').length;

    out.push(toRow(block[0]));
    out.push('| ' + Array.from({ length: columnCount }, () => '---').join(' | ') + ' |');
    for (const row of block.slice(1)) out.push(toRow(row));
  }

  return out.join('\n');
}

/** 流式未闭合围栏补全：只有检测到奇数个 ``` 时才交给 remend，避免影响完整文本。 */
function healStreamingMarkdown(md: string): string {
  const fences = md.match(/```/g);
  if (!fences || fences.length % 2 === 0) return md;
  return remend(md);
}

const SANITIZE_CONFIG = {
  USE_PROFILES: { html: true, svg: true, svgFilters: true },
  ADD_TAGS: ['use', 'video', 'audio', 'source', 'picture', 'track'],
  ADD_ATTR: [
    'href',
    'xlink:href',
    'target',
    'src',
    'srcset',
    'sizes',
    'poster',
    'controls',
    'autoplay',
    'loop',
    'muted',
    'playsinline',
    'preload',
    'width',
    'height',
    'kind',
    'srclang',
    'default',
    'alt',
    'loading',
    'type',
    'title',
    'aria-label',
    'data-preview-file',
    'data-preview-url',
    'data-preview-anchor',
    'data-preview-asset-path',
    'data-preview-asset-raw',
    'data-preview-poster-path',
    'data-preview-srcset-paths',
    'data-preview-blocked',
    'data-file-ref',
    'data-icon',
    'data-media-src',
    'data-media-name',
    'data-deliverable-card',
    'data-deliverable-kind',
    'data-deliverable-path',
    'data-deliverable-name',
    'data-deliverable-thumb',
  ],
  ALLOWED_URI_REGEXP:
    /^(?:(?:https?|mailto|tel|blob):|data:(?:image\/(?:png|jpe?g|gif|webp|avif|svg\+xml|x-icon|bmp)|video\/|audio\/|font\/|application\/(?:font-|vnd\.ms-fontobject|octet-stream))|hermes-(?:media|preview):\/\/|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
  FORBID_TAGS: ['script', 'style'],
  FORBID_CONTENTS: ['script'],
};

function escapeRegExp(val: string): string {
  return val.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 将正文中未包裹反引号的裸路径（必须包含路径分隔符且位于围栏代码块/链接之外）自动包成 inline code，
 * 交给统一的 `codespan` 渲染为原地紧凑成果物小卡片。
 */
function wrapBareDeliverablePaths(md: string, deliverableFiles: readonly string[]): string {
  if (!md || deliverableFiles.length === 0) return md;
  const variants = new Set<string>();
  for (const raw of deliverableFiles) {
    const clean = (raw || '').trim();
    if (!clean) continue;
    const lower = clean.toLowerCase();
    if (lower.startsWith('http://') || lower.startsWith('https://') || lower.startsWith('data:') || lower.startsWith('blob:')) {
      continue;
    }
    const norm = clean.replace(/\\/g, '/');
    if (norm.includes('/')) {
      variants.add(clean);
      variants.add(norm);
    }
  }
  if (variants.size === 0) return md;

  const sorted = Array.from(variants).sort((a, b) => b.length - a.length);
  const pathAlt = sorted.map(escapeRegExp).join('|');
  const bareRe = new RegExp(
    `(^|[\\s(>\\[{"'：:，,;；、])(${pathAlt})(?=$|[\\s.,;:!?)'"\\]}。，；：、])`,
    'g',
  );
  const protectedRe = /(``+[^`\r\n]*``+|`[^`\r\n]+`|!?\[[^\]]*\]\([^)\r\n]*\)|<[^>\r\n]+>|(?:https?|ftp|blob|mailto|tel|javascript|vbscript|data):[^\s`"'<>()]+)/gi;

  const lines = md.split('\n');
  let inFence = false;
  const out = lines.map((line) => {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      return line;
    }
    if (inFence) return line;

    let result = '';
    let lastIdx = 0;
    let match: RegExpExecArray | null;
    protectedRe.lastIndex = 0;
    while ((match = protectedRe.exec(line)) !== null) {
      if (match.index > lastIdx) {
        result += line.slice(lastIdx, match.index).replace(bareRe, '$1`$2`');
      }
      result += match[0];
      lastIdx = protectedRe.lastIndex;
    }
    if (lastIdx < line.length) {
      result += line.slice(lastIdx).replace(bareRe, '$1`$2`');
    }
    return result;
  });

  return out.join('\n');
}

/**
 * 清洗解析结果。
 * 【设计意图 (Why)】marked 允许内联 HTML，直接注入 innerHTML 存在 XSS 风险。
 * 【约束与规则 (Rules)】浏览器内必须清洗；Node（无 DOM）环境返回原 HTML，
 *   因为该路径只用于 SSR 字符串断言，不会进入真实 DOM。
 */
function sanitize(html: string): string {
  if (!DOMPurify.isSupported) return html;
  // DOMPurify 在 returnTrustedTypes 未开启时返回 string；String() 兼顾两种类型定义
  return String(DOMPurify.sanitize(html, SANITIZE_CONFIG));
}

const markdownRenderCache = new Map<string, string>();
const MARKDOWN_CACHE_MAX = 500;

export interface RenderMarkdownOptions {
  /** 会话内 Agent 真实读写过的文件；只有命中集合的引用才渲染为可点击 */
  knownFiles?: readonly string[];
  /** 当前回合已证实的成果物文件；命中引用原地替换为紧凑小卡片 */
  deliverableFiles?: readonly string[];
  /** 文档预览基准路径（开启后启用 Markdown 相对路径图片/媒体/文档链接解析） */
  documentBasePath?: string;
  /** 工作区根目录（用于阻断越权 `../` 穿越，并解析 `/assets/...` 根相对引用） */
  workspaceRoot?: string;
  /** 同步预解析的媒体资产 URL 映射（resolvedPath → dataUrl / 协议 URL） */
  resolvedAssetUrls?: Readonly<Record<string, string>>;
}

function rewriteMarkdownHtmlMedia(
  html: string,
  documentBasePath: string,
  workspaceRoot: string,
  resolvedUrls?: Readonly<Record<string, string>>,
): string {
  const withMedia = html.replace(
    /<(img|video|audio|source|track)\b([^>]*?)(\/?)>/gi,
    (_full, tagName: string, attrs: string, selfClose: string) => {
      let nextAttrs = attrs;
      const isImg = tagName.toLowerCase() === 'img';

      const rewriteSingleAttr = (attrName: 'src' | 'poster', attrStoreName: string): void => {
        const attrRe = new RegExp(`(\\s${attrName}\\s*=\\s*)(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
        const m = attrRe.exec(nextAttrs);
        if (!m) return;
        const rawVal = (m[2] ?? m[3] ?? m[4]).trim();
        const resolved = resolvePreviewResourceRef(rawVal, {
          documentPath: documentBasePath,
          workspaceRoot: workspaceRoot || undefined,
        });
        if (resolved.blocked) {
          nextAttrs = nextAttrs.replace(attrRe, () => ' data-preview-blocked="true"');
          nextAttrs = addClassToAttrs(nextAttrs, 'md-asset-blocked');
          return;
        }
        if (resolved.externalUrl) {
          const replacement = `${m[1]}"${escapeHtml(resolved.externalUrl)}"`;
          nextAttrs = nextAttrs.replace(attrRe, () => replacement);
          if (isImg && attrName === 'src' && !/\sdata-media-src=/i.test(nextAttrs)) {
            nextAttrs += ` data-media-src="${escapeHtml(resolved.externalUrl)}"`;
          }
          return;
        }
        if ((resolved.kind === 'relative' || resolved.kind === 'root_relative') && resolved.resolvedPath) {
          const pre = resolvedUrls?.[resolved.resolvedPath];
          if (pre) {
            const replacement = `${m[1]}"${escapeHtml(pre)}" ${attrStoreName}="${escapeHtml(resolved.resolvedPath)}"`;
            nextAttrs = nextAttrs.replace(attrRe, () => replacement);
            if (isImg && attrName === 'src' && !/\sdata-media-src=/i.test(nextAttrs)) {
              nextAttrs += ` data-media-src="${escapeHtml(pre)}"`;
            }
          } else {
            const replacement = ` ${attrStoreName}="${escapeHtml(resolved.resolvedPath)}" data-preview-asset-raw="${escapeHtml(rawVal)}"`;
            nextAttrs = nextAttrs.replace(attrRe, () => replacement);
          }
        }
      };

      rewriteSingleAttr('src', 'data-preview-asset-path');
      rewriteSingleAttr('poster', 'data-preview-poster-path');

      const srcsetRe = /(\ssrcset\s*=\s*)(?:"([^"]*)"|'([^']*)')/i;
      const sm = srcsetRe.exec(nextAttrs);
      if (sm) {
        const rawSet = sm[2] ?? sm[3];
        const candidates = splitSrcsetCandidates(rawSet);
        const readyParts: string[] = [];
        const pendingPairs: string[] = [];
        let allReady = candidates.length > 0;
        for (const candidate of candidates) {
          const [urlPart, ...descParts] = candidate.split(/\s+/);
          const descriptor = descParts.join(' ');
          const resolved = resolvePreviewResourceRef(urlPart, {
            documentPath: documentBasePath,
            workspaceRoot: workspaceRoot || undefined,
          });
          if (resolved.blocked) continue;
          if (resolved.externalUrl || resolved.kind === 'inline_data') {
            const finalUrl = resolved.externalUrl || urlPart;
            readyParts.push(descriptor ? `${finalUrl} ${descriptor}` : finalUrl);
            pendingPairs.push(`literal:${finalUrl}|${descriptor}`);
          } else if (resolved.resolvedPath) {
            const pre = resolvedUrls?.[resolved.resolvedPath];
            if (pre) {
              readyParts.push(descriptor ? `${pre} ${descriptor}` : pre);
            } else {
              allReady = false;
            }
            pendingPairs.push(`${resolved.resolvedPath}|${descriptor}`);
          }
        }
        if (allReady && readyParts.length > 0) {
          const replacement = `${sm[1]}"${escapeHtml(readyParts.join(', '))}"`;
          nextAttrs = nextAttrs.replace(srcsetRe, () => replacement);
        } else if (pendingPairs.length > 0) {
          const replacement = ` data-preview-srcset-paths="${escapeHtml(pendingPairs.join(','))}"`;
          nextAttrs = nextAttrs.replace(srcsetRe, () => replacement);
        } else {
          nextAttrs = nextAttrs.replace(srcsetRe, () => ' data-preview-blocked="true"');
          nextAttrs = addClassToAttrs(nextAttrs, 'md-asset-blocked');
        }
      }

      return `<${tagName}${nextAttrs}${selfClose}>`;
    },
  );

  return withMedia.replace(/<a\b([^>]*?)>/gi, (full, attrs: string) => {
    const hrefRe = /(\shref\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;
    const hm = hrefRe.exec(attrs);
    if (!hm) return full;
    const rawHref = (hm[2] ?? hm[3] ?? hm[4]).trim();
    const resolved = resolvePreviewResourceRef(rawHref, {
      documentPath: documentBasePath,
      workspaceRoot: workspaceRoot || undefined,
    });
    if (resolved.blocked || isUnsafeMarkdownUri(rawHref, false)) {
      const cleaned = addClassToAttrs(
        attrs
          .replace(hrefRe, () => '')
          .replace(/\starget\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, ''),
        'md-asset-blocked',
      );
      return `<a${cleaned} data-preview-blocked="true">`;
    }
    if (resolved.kind === 'anchor') {
      const cleaned = attrs.replace(/\starget\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
      const hasAnchor = /\sdata-preview-anchor=/i.test(cleaned);
      return `<a${cleaned}${hasAnchor ? '' : ` data-preview-anchor="${escapeHtml(rawHref.slice(1))}"`}>`;
    }
    if ((resolved.kind === 'relative' || resolved.kind === 'root_relative') && resolved.resolvedPath) {
      if (/\sdata-preview-file=/i.test(attrs)) return full;
      return `<a${attrs} data-preview-file="${escapeHtml(resolved.resolvedPath)}">`;
    }
    return full;
  });
}

export function renderMarkdownCore(md: string, options?: RenderMarkdownOptions): string {
  if (!md) return '';

  const knownFiles = options?.knownFiles ?? [];
  const deliverableFiles = options?.deliverableFiles ?? [];
  const docBasePath = options?.documentBasePath ?? '';
  const workspaceRoot = options?.workspaceRoot ?? '';
  const resolvedAssetUrls = options?.resolvedAssetUrls;
  // 同一段正文在不同会话、不同成果物集合或不同预览文档基准下渲染形态不同，缓存键必须全部纳入
  const knownKey = knownFiles.length ? [...knownFiles].sort().join('\u0001') : '';
  const delivKey = deliverableFiles.length ? [...deliverableFiles].sort().join('\u0001') : '';
  const assetEntries = resolvedAssetUrls
    ? Object.entries(resolvedAssetUrls).sort(([a], [b]) => a.localeCompare(b))
    : [];
  const assetKey = assetEntries.length
    ? assetEntries.map(([k, v]) => `${k}=${v}`).join('\u0001')
    : '';
  const cacheKey =
    knownKey || delivKey || docBasePath || workspaceRoot || assetKey
      ? `${md}\u0000${knownKey}\u0002${delivKey}\u0003${docBasePath}\u0004${workspaceRoot}\u0005${assetKey}`
      : md;
  const cached = markdownRenderCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const strippedMd = stripMediaTags(md).cleanText;
  if (!strippedMd) return '';
  const prelinkedMd = deliverableFiles.length > 0 ? wrapBareDeliverablePaths(strippedMd, deliverableFiles) : strippedMd;
  const normalized = convertTsvTables(healStreamingMarkdown(prelinkedMd));
  const previousKnownFiles = activeKnownFiles;
  const previousDeliverableFiles = activeDeliverableFiles;
  const previousDocBase = activeDocumentBasePath;
  const previousWorkspaceRoot = activeWorkspaceRoot;
  const previousResolvedAssets = activeResolvedAssetUrls;
  activeKnownFiles = knownFiles;
  activeDeliverableFiles = deliverableFiles;
  activeDocumentBasePath = docBasePath;
  activeWorkspaceRoot = workspaceRoot;
  activeResolvedAssetUrls = resolvedAssetUrls;
  let parsed: string;
  try {
    parsed = parser.parse(normalized) as string;
  } finally {
    activeKnownFiles = previousKnownFiles;
    activeDeliverableFiles = previousDeliverableFiles;
    activeDocumentBasePath = previousDocBase;
    activeWorkspaceRoot = previousWorkspaceRoot;
    activeResolvedAssetUrls = previousResolvedAssets;
  }
  const rewrittenMedia = docBasePath
    ? rewriteMarkdownHtmlMedia(parsed, docBasePath, workspaceRoot, resolvedAssetUrls)
    : parsed;
  const withClasses = rewrittenMedia
    .replace(/<table>/g, '<div class="md-table-wrap"><table class="md-table">')
    .replace(/<\/table>/g, '</table></div>')
    .replace(/<blockquote>/g, '<blockquote class="md-quote">')
    .replace(/<hr>/g, '<hr class="md-hr">');
  const result = sanitize(withClasses);

  // 引擎未预热时不要用回退高亮的 HTML 污染缓存，否则预热完成后仍会命中旧结果
  if (isHighlightReady()) {
    if (markdownRenderCache.size >= MARKDOWN_CACHE_MAX) {
      const oldestKey = markdownRenderCache.keys().next().value;
      if (oldestKey) markdownRenderCache.delete(oldestKey);
    }
    markdownRenderCache.set(cacheKey, result);
  }

  return result;
}
