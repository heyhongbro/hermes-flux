/**
 * React Markdown 容器
 *
 * 设计意图(Why)：
 *   正文由现有 renderMarkdown 产出 HTML 字符串，这里只负责注入与排版约束；
 *   并承担行内图片成果物 24×24 缩略图的鉴权异步填充与原地小卡片点击分发。
 *
 * 约束与规则(Rules)：
 *   1. 只用 dangerouslySetInnerHTML 注入已渲染 HTML，不拼字符串；
 *   2. 每个块级元素的行高与字号由 CSS 统一收敛，禁止组件内写内联字号；
 *   3. 内容变化才重新渲染，避免每次父组件更新都重算 HTML。
 */

import * as React from 'react';
import { normalizeDeliverableKey } from '@hermes-flux/core';
import { renderMarkdown } from '../../components/MiddlePod/MiddlePod.js';
import { mountFileTypeSprite } from '../../lib/fileTypeIcons.js';
import { handleCodeBlockCopyClick } from '../../lib/codeCopy.js';
import type { MediaLightboxItem } from './MediaLightbox.js';

const DIRECT_IMAGE_URL_RE = /^(?:data:image\/|https?:\/\/|blob:)/i;

export interface MarkdownBlockProps {
  content: string;
  /** 流式直写锚点 ID，缺省时不生成 */
  anchorId?: string;
  className?: string;
  /** 会话内 Agent 真实读写过的文件：只有命中集合的引用才可点击 */
  knownFiles?: readonly string[];
  /** 当前回合成果物文件路径：命中引用原地替换为紧凑小卡片 */
  deliverableFiles?: readonly string[];
  /** 回合内图片成果物列表，供行内图片小卡片点击后平滑唤起灯箱并左右翻页 */
  turnImages?: readonly MediaLightboxItem[];
  /** 解析远端或本地媒体路径为可直接渲染的 Data URL / HTTP URL */
  resolveMediaUrl?: (pathOrUrl: string) => Promise<string | null>;
  /** 点击文档/代码类成果物小卡片时打开预览 */
  onOpenFile?: (filePath: string, previewUrl?: string) => void;
  /** 点击 Markdown 行内图片或图片成果物小卡片时打开悬浮灯箱 */
  onOpenMediaLightbox?: (items: readonly MediaLightboxItem[], initialIndex: number) => void;
}

export function MarkdownBlock({
  content,
  anchorId,
  className,
  knownFiles,
  deliverableFiles,
  turnImages,
  resolveMediaUrl,
  onOpenFile,
  onOpenMediaLightbox,
}: MarkdownBlockProps): React.ReactElement | null {
  const html = React.useMemo(
    () => renderMarkdown(content, { knownFiles, deliverableFiles }),
    [content, knownFiles, deliverableFiles],
  );
  const rootRef = React.useRef<HTMLDivElement | null>(null);

  const handleMarkdownClick = (event: React.MouseEvent<HTMLDivElement>): void => {
    void handleCodeBlockCopyClick(event.target);

    const card =
      event.target instanceof Element
        ? event.target.closest<HTMLElement>('.conv-inline-deliverable[data-deliverable-card]')
        : null;
    if (card) {
      const kind = card.getAttribute('data-deliverable-kind') || '';
      const filePath =
        card.getAttribute('data-preview-file') || card.getAttribute('data-deliverable-path') || '';
      const fileName = card.getAttribute('data-deliverable-name') || filePath;
      if (kind === 'image' && filePath && onOpenMediaLightbox) {
        event.preventDefault();
        event.stopPropagation();
        const thumbImg = card.querySelector<HTMLImageElement>('img.conv-inline-deliverable__thumb-img');
        const thumbSrc = thumbImg?.src || '';
        const list = turnImages && turnImages.length > 0
          ? turnImages
          : [{ id: `inline-${filePath}`, src: thumbSrc || filePath, path: filePath, name: fileName, alt: fileName }];
        const targetKey = normalizeDeliverableKey(filePath);
        const idx = list.findIndex((item) => normalizeDeliverableKey(item.path || item.src) === targetKey);
        onOpenMediaLightbox(list, Math.max(0, idx));
        return;
      }
      if (filePath && onOpenFile) {
        event.preventDefault();
        event.stopPropagation();
        onOpenFile(filePath);
        return;
      }
    }

    const target = event.target instanceof Element ? event.target.closest<HTMLElement>('.md-inline-image[data-media-src]') : null;
    if (target && onOpenMediaLightbox) {
      event.preventDefault();
      event.stopPropagation();
      const clickedSrc = target.getAttribute('data-media-src') || '';
      if (!clickedSrc) return;
      const allImgs = Array.from(
        rootRef.current?.querySelectorAll<HTMLElement>('.md-inline-image[data-media-src]') ?? [target],
      );
      const items: MediaLightboxItem[] = allImgs.map((el, idx) => {
        const src = el.getAttribute('data-media-src') || '';
        const name = el.getAttribute('data-media-name') || `image-${idx + 1}`;
        return { id: `md-img-${idx}-${src}`, src, name, alt: name };
      });
      const clickedIndex = Math.max(0, allImgs.indexOf(target));
      onOpenMediaLightbox(items, clickedIndex);
    }
  };

  // 文件类型图标依赖 document 中的 sprite；挂载一次即可，重复调用无副作用。
  React.useEffect(() => {
    mountFileTypeSprite();
  }, []);

  // 行内图片成果物 24×24 缩略图异步按需解析（仅当 DOM 存在 data-deliverable-thumb 槽位时）
  React.useEffect(() => {
    const root = rootRef.current;
    if (!root || typeof document === 'undefined') return;
    const slots = Array.from(root.querySelectorAll<HTMLElement>('[data-deliverable-thumb]'));
    if (slots.length === 0) return;

    let cancelled = false;
    const renderImgIntoSlot = (slot: HTMLElement, srcUrl: string): void => {
      if (cancelled || !DIRECT_IMAGE_URL_RE.test(srcUrl)) return;
      const name = slot.closest('[data-deliverable-name]')?.getAttribute('data-deliverable-name') || 'image';
      const img = document.createElement('img');
      img.className = 'conv-inline-deliverable__thumb-img';
      img.src = srcUrl;
      img.alt = name;
      img.loading = 'lazy';
      slot.textContent = '';
      slot.appendChild(img);
    };

    for (const slot of slots) {
      const targetPath = slot.getAttribute('data-deliverable-thumb') || '';
      if (!targetPath) continue;
      if (DIRECT_IMAGE_URL_RE.test(targetPath)) {
        renderImgIntoSlot(slot, targetPath);
        continue;
      }
      if (!resolveMediaUrl) continue;
      void resolveMediaUrl(targetPath)
        .then((resolved) => {
          if (resolved) renderImgIntoSlot(slot, resolved);
        })
        // gate-degrade: 缩略图拉取失败保留安全占位图标，用户仍可点击卡片重试预览
        .catch(() => {});
    }

    return () => {
      cancelled = true;
    };
  }, [html, resolveMediaUrl]);

  // 纯工具消息没有正文时不要渲染空容器，否则会在 flex 布局里多占一个块间距。
  // 【流式锚点契约】但「有 anchorId」的行必须保住锚点：tokenStreamWriter 只 patch 已存在节点，
  // 它没有 render / mount 能力，流式首帧正文必然为空，此处 return null 会让后续每一帧直写空转。
  // 锚点以 display:none 隐形存在、首帧直写时由 writer 的 none→block 翻牌点亮：
  // 既保住直写通道，又不产生任何可见空容器/块间距（89ca860 的意图不回潮）。
  if (!content.trim()) {
    if (!anchorId) return null;
    return <div ref={rootRef} id={anchorId} className={`conv-markdown${className ? ` ${className}` : ''}`} style={{ display: 'none' }} onClick={handleMarkdownClick} />;
  }
  return (
    <div
      ref={rootRef}
      id={anchorId}
      className={`conv-markdown${className ? ` ${className}` : ''}`}
      onClick={handleMarkdownClick}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
