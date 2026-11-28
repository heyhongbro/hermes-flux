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
import {
  isPreviewAssetPathAllowed,
  resolveEffectivePreviewScopeRoot,
} from '@hermes-flux/core';
import { renderMarkdown } from '../../components/MiddlePod/MiddlePod.js';
import { mountFileTypeSprite } from '../../lib/fileTypeIcons.js';
import {
  handleMarkdownPreviewClick,
  hydrateMarkdownPreviewAssets,
} from '../../lib/markdownDomHydrator.js';
import type { MediaLightboxItem } from './MediaLightbox.js';

export interface MarkdownBlockProps {
  content: string;
  /** 流式直写锚点 ID，缺省时不生成 */
  anchorId?: string;
  className?: string;
  /** 会话内 Agent 真实读写过的文件：只有命中集合的引用才可点击 */
  knownFiles?: readonly string[];
  /** 当前回合成果物文件路径：命中引用原地替换为紧凑小卡片 */
  deliverableFiles?: readonly string[];
  /** 文档预览基准路径（开启后解析 Markdown 相对路径图片/媒体/文档链接） */
  documentBasePath?: string;
  /** 工作区根目录（用于阻断 `../` 越权穿越，并解析 `/assets/...` 根相对引用） */
  workspaceRoot?: string;
  /** 同步预解析的子资源 URL 映射（resolvedPath -> URL） */
  resolvedAssetUrls?: Readonly<Record<string, string>>;
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
  documentBasePath,
  workspaceRoot,
  resolvedAssetUrls,
  turnImages,
  resolveMediaUrl,
  onOpenFile,
  onOpenMediaLightbox,
}: MarkdownBlockProps): React.ReactElement | null {
  const html = React.useMemo(
    () =>
      renderMarkdown(content, {
        knownFiles,
        deliverableFiles,
        documentBasePath,
        workspaceRoot,
        resolvedAssetUrls,
      }),
    [content, knownFiles, deliverableFiles, documentBasePath, workspaceRoot, resolvedAssetUrls],
  );
  const rootRef = React.useRef<HTMLDivElement | null>(null);

  const handleMarkdownClick = (event: React.MouseEvent<HTMLDivElement>): void => {
    handleMarkdownPreviewClick(event, rootRef.current, {
      turnImages,
      onOpenFile: onOpenFile ? (filePath) => onOpenFile(filePath) : undefined,
      onOpenMediaLightbox,
    });
  };

  // 文件类型图标依赖 document 中的 sprite；挂载一次即可，重复调用无副作用。
  React.useEffect(() => {
    mountFileTypeSprite();
  }, []);

  // 行内图片成果物 24×24 缩略图 & 文档相对媒体资源异步水合
  React.useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const effectiveScopeRoot = documentBasePath
      ? resolveEffectivePreviewScopeRoot(documentBasePath, workspaceRoot || '')
      : workspaceRoot || '';
    const enforceScope = Boolean(documentBasePath);
    return hydrateMarkdownPreviewAssets({
      root,
      resolveAssetUrl: (assetPath) => {
        if (!resolveMediaUrl) return Promise.resolve(null);
        if (
          !isPreviewAssetPathAllowed(assetPath, {
            workspaceRoot: enforceScope ? effectiveScopeRoot || undefined : undefined,
            enforceWorkspaceScope: enforceScope,
          })
        ) {
          return Promise.resolve(null);
        }
        return resolveMediaUrl(assetPath);
      },
    });
  }, [html, resolveMediaUrl, documentBasePath, workspaceRoot]);

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
