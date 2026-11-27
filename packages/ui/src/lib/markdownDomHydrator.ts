/**
 * Markdown 渲染后 DOM 点击委托与相对资源异步水合共享内核
 * (packages/ui/src/lib/markdownDomHydrator.ts)
 *
 * 【设计意图 (Why)】
 *   消除 React 对话/移动端视图 (`MarkdownBlock.tsx`) 与桌面检查舱 (`previewAssetCoordinator.ts`)
 *   之间高度同构的 DOM 水合与链接/锚点/灯箱点击委托代码，保证双端行为 100% 一致：
 *   1. 点击复制代码块、`[data-preview-anchor]` 页内平滑跳转、`a[data-preview-file]` 相对文档打开、
 *      `.conv-inline-deliverable[data-deliverable-card]` 成果物及 `.md-inline-image[data-media-src]` 灯箱；
 *   2. 对 `[data-preview-asset-path]`、`[data-preview-poster-path]`、`[data-preview-srcset-paths]`
 *      去重异步水合真实媒体 URL，就地回填属性，绝不重刷外层容器以免丢失滚动位置。
 */

import { normalizeDeliverableKey, splitSrcsetCandidates } from '@hermes-flux/core';
import { handleCodeBlockCopyClick } from './codeCopy.js';

export const DIRECT_HYDRATE_IMAGE_URL_RE = /^(?:data:image\/|https?:\/\/|blob:|hermes-preview:\/\/)/i;
export const SAFE_HYDRATE_MEDIA_URL_RE =
  /^(?:data:(?:image|video|audio)\/|https?:\/\/|blob:|hermes-(?:media|preview):\/\/)/i;

export interface LightboxMediaPayload {
  id: string;
  src: string;
  path?: string;
  name: string;
  alt?: string;
}

export interface MarkdownPreviewClickOptions {
  turnImages?: readonly LightboxMediaPayload[];
  onOpenFile?: (filePath: string) => void;
  onOpenMediaLightbox?: (items: readonly LightboxMediaPayload[], initialIndex: number) => void;
}

export interface HydrateMarkdownDomOptions {
  root: HTMLElement;
  resolveAssetUrl: (assetPath: string, allowVideoStreamUrl: boolean) => Promise<string | null>;
  isCancelled?: () => boolean;
}

/**
 * 统一委托 Markdown 预览容器内的代码块复制、卡片、图片灯箱、页内锚点与相对文档跳转点击。
 */
export function handleMarkdownPreviewClick(
  event: { target: EventTarget | null; preventDefault(): void; stopPropagation(): void },
  root: ParentNode | null,
  options: MarkdownPreviewClickOptions = {},
): boolean {
  void handleCodeBlockCopyClick(event.target);

  const elTarget =
    event.target && typeof (event.target as Element).closest === 'function'
      ? (event.target as Element)
      : null;
  if (!elTarget) return false;

  const card = elTarget.closest('.conv-inline-deliverable[data-deliverable-card]');
  if (card) {
    const kind = card.getAttribute('data-deliverable-kind') || '';
    const filePath =
      card.getAttribute('data-preview-file') || card.getAttribute('data-deliverable-path') || '';
    const fileName = card.getAttribute('data-deliverable-name') || filePath;
    if (kind === 'image' && filePath && options.onOpenMediaLightbox) {
      event.preventDefault();
      event.stopPropagation();
      const thumbImg = card.querySelector('img.conv-inline-deliverable__thumb-img');
      const thumbSrc = thumbImg?.getAttribute('src') || '';
      const list: readonly LightboxMediaPayload[] =
        options.turnImages && options.turnImages.length > 0
          ? options.turnImages
          : [{ id: `inline-${filePath}`, src: thumbSrc || filePath, path: filePath, name: fileName, alt: fileName }];
      const targetKey = normalizeDeliverableKey(filePath);
      const idx = list.findIndex((item) => normalizeDeliverableKey(item.path || item.src) === targetKey);
      options.onOpenMediaLightbox(list, Math.max(0, idx));
      return true;
    }
    if (filePath && options.onOpenFile) {
      event.preventDefault();
      event.stopPropagation();
      options.onOpenFile(filePath);
      return true;
    }
  }

  const imgTarget = elTarget.closest('.md-inline-image[data-media-src]');
  if (imgTarget && options.onOpenMediaLightbox) {
    const clickedSrc = imgTarget.getAttribute('data-media-src') || '';
    if (!clickedSrc) return false;
    event.preventDefault();
    event.stopPropagation();
    const allImgs = root ? Array.from(root.querySelectorAll('.md-inline-image[data-media-src]')) : [];
    const listSource = allImgs.length > 0 ? allImgs : [imgTarget];
    const items: LightboxMediaPayload[] = listSource.map((node, idx) => {
      const src = node.getAttribute('data-media-src') || '';
      const name = node.getAttribute('data-media-name') || `image-${idx + 1}`;
      return { id: `md-img-${idx}-${src}`, src, name, alt: name };
    });
    const clickedIndex = Math.max(0, listSource.indexOf(imgTarget));
    options.onOpenMediaLightbox(items, clickedIndex);
    return true;
  }

  const anchorEl = elTarget.closest('a[data-preview-anchor]');
  if (anchorEl && root) {
    const anchorTarget = anchorEl.getAttribute('data-preview-anchor') || '';
    if (anchorTarget) {
      event.preventDefault();
      let decoded = anchorTarget;
      try {
        decoded = decodeURIComponent(anchorTarget);
      // gate-degrade: 非法锚点转义序列保留原始字符串匹配标题 ID
      } catch {}
      const heading = Array.from(root.querySelectorAll('[id]')).find(
        (node) => node.id === anchorTarget || node.id === decoded,
      ) as (Element & { scrollIntoView?: (opts?: ScrollIntoViewOptions) => void }) | undefined;
      heading?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
      return true;
    }
  }

  const fileLinkEl = elTarget.closest('a[data-preview-file]');
  if (fileLinkEl && options.onOpenFile) {
    const targetPath = fileLinkEl.getAttribute('data-preview-file') || '';
    if (targetPath) {
      event.preventDefault();
      event.stopPropagation();
      options.onOpenFile(targetPath);
      return true;
    }
  }

  return false;
}

/**
 * 异步水合 Markdown 容器内的相对图片、视频/音频 source、poster、srcset 与成果物缩略图槽位。
 */
export function hydrateMarkdownPreviewAssets(options: HydrateMarkdownDomOptions): () => void {
  const { root, resolveAssetUrl } = options;
  if (typeof root.querySelectorAll !== 'function') {
    return () => {};
  }
  const thumbSlots = Array.from(root.querySelectorAll<HTMLElement>('[data-deliverable-thumb]'));
  const mediaEls = Array.from(root.querySelectorAll<HTMLElement>('[data-preview-asset-path]'));
  const posterEls = Array.from(root.querySelectorAll<HTMLElement>('[data-preview-poster-path]'));
  const srcsetEls = Array.from(root.querySelectorAll<HTMLElement>('[data-preview-srcset-paths]'));

  if (thumbSlots.length === 0 && mediaEls.length === 0 && posterEls.length === 0 && srcsetEls.length === 0) {
    return () => {};
  }

  let localCancelled = false;
  const isStale = () =>
    localCancelled ||
    Boolean(options.isCancelled?.()) ||
    ('isConnected' in root && root.isConnected === false);

  const dedupeCache = new Map<string, Promise<string | null>>();
  const resolveDeduped = (assetPath: string, allowVideoStreamUrl: boolean): Promise<string | null> => {
    const key = `${allowVideoStreamUrl ? 'v' : 's'}:${assetPath}`;
    const hit = dedupeCache.get(key);
    if (hit) return hit;
    const task = resolveAssetUrl(assetPath, allowVideoStreamUrl)
      // gate-degrade: 单个资源拉取失败仅标记自身占位失败态，不阻塞兄弟节点水合
      .catch(() => null);
    dedupeCache.set(key, task);
    return task;
  };

  const renderThumbIntoSlot = (slot: HTMLElement, srcUrl: string): void => {
    if (isStale() || !DIRECT_HYDRATE_IMAGE_URL_RE.test(srcUrl) || typeof document === 'undefined') return;
    const name = slot.closest('[data-deliverable-name]')?.getAttribute('data-deliverable-name') || 'image';
    const img = document.createElement('img');
    img.className = 'conv-inline-deliverable__thumb-img';
    img.src = srcUrl;
    img.alt = name;
    img.loading = 'lazy';
    slot.textContent = '';
    slot.appendChild(img);
  };

  for (const slot of thumbSlots) {
    const targetPath = slot.getAttribute('data-deliverable-thumb') || '';
    if (!targetPath) continue;
    if (DIRECT_HYDRATE_IMAGE_URL_RE.test(targetPath)) {
      renderThumbIntoSlot(slot, targetPath);
      continue;
    }
    void resolveDeduped(targetPath, false).then((resolved) => {
      if (resolved) renderThumbIntoSlot(slot, resolved);
    });
  }

  for (const el of mediaEls) {
    const assetPath = el.getAttribute('data-preview-asset-path') || '';
    const currentSrc = el.getAttribute('src') || '';
    if (!assetPath || (currentSrc && SAFE_HYDRATE_MEDIA_URL_RE.test(currentSrc))) continue;
    const tag = el.tagName.toLowerCase();
    const parentMedia = tag === 'source' ? el.closest('video, audio') : null;
    const allowVideoStreamUrl = tag === 'video' || parentMedia?.tagName.toLowerCase() === 'video';

    void resolveDeduped(assetPath, allowVideoStreamUrl).then((resolved) => {
      if (isStale()) return;
      if (resolved && SAFE_HYDRATE_MEDIA_URL_RE.test(resolved)) {
        el.setAttribute('src', resolved);
        el.classList.remove('md-inline-image--pending');
        if (tag === 'img') {
          el.setAttribute('data-media-src', resolved);
        }
        if (parentMedia && 'load' in parentMedia && typeof (parentMedia as HTMLMediaElement).load === 'function') {
          (parentMedia as HTMLMediaElement).load();
        }
      } else {
        const failureTarget = parentMedia ?? el;
        const altLabel =
          failureTarget.getAttribute('alt') ||
          el.getAttribute('data-preview-asset-raw') ||
          assetPath;
        const doc = failureTarget.ownerDocument ?? (typeof document !== 'undefined' ? document : null);
        if (
          doc &&
          typeof doc.createElement === 'function' &&
          failureTarget.parentNode &&
          typeof failureTarget.parentNode.replaceChild === 'function'
        ) {
          const placeholder = doc.createElement('span');
          placeholder.className = 'md-asset-blocked';
          placeholder.setAttribute('data-preview-blocked', 'true');
          placeholder.textContent = altLabel;
          failureTarget.parentNode.replaceChild(placeholder, failureTarget);
        } else {
          el.classList.remove('md-inline-image--pending');
          failureTarget.classList.add('md-inline-image--error');
        }
      }
    });
  }

  for (const el of posterEls) {
    const posterPath = el.getAttribute('data-preview-poster-path') || '';
    if (!posterPath || el.getAttribute('poster')) continue;
    void resolveDeduped(posterPath, false).then((resolved) => {
      if (!isStale() && resolved && DIRECT_HYDRATE_IMAGE_URL_RE.test(resolved)) {
        el.setAttribute('poster', resolved);
      }
    });
  }

  for (const el of srcsetEls) {
    const rawSpec = el.getAttribute('data-preview-srcset-paths') || '';
    if (!rawSpec) continue;
    const entries = splitSrcsetCandidates(rawSpec).map((entry) => {
      const pipeIdx = entry.lastIndexOf('|');
      return {
        pathOrLiteral: entry.slice(0, pipeIdx),
        desc: entry.slice(pipeIdx + 1),
      };
    });
    void Promise.all(
      entries.map(async ({ pathOrLiteral, desc }) => {
        if (pathOrLiteral.startsWith('literal:')) {
          const raw = pathOrLiteral.slice('literal:'.length);
          return desc ? `${raw} ${desc}` : raw;
        }
        const resolved = await resolveDeduped(pathOrLiteral, false);
        if (!resolved || !DIRECT_HYDRATE_IMAGE_URL_RE.test(resolved)) return null;
        return desc ? `${resolved} ${desc}` : resolved;
      }),
    ).then((parts) => {
      if (isStale()) return;
      const valid = parts.filter((p): p is string => Boolean(p));
      if (valid.length > 0) {
        el.setAttribute('srcset', valid.join(', '));
      }
    });
  }

  return () => {
    localCancelled = true;
  };
}
