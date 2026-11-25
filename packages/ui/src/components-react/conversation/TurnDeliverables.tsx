/**
 * 回合隐式成果物紧凑小卡片组件 (TurnDeliverables)
 *
 * 【设计意图 (Why)】
 *   当 Agent 在正文外通过工具（`image_path`、`MEDIA:`、文件写入等）隐式产出了图片、视频或文档，
 *   而没有在正文文字里写出路径时，统一在最后一条助手消息「时间戳页脚正上方」以紧凑横向小卡片补充呈现：
 *   - 桌面与移动端使用完全一致的紧凑小卡片高度，图片仅用 24×24 缩略图 + 纯文件名 + 短格式徽标，绝不占大空间；
 *   - 已经在正文被原地替换成小卡片的文件由 `TurnGroup` 自动去重剔除，杜绝上下双份重复。
 *
 * 【防范的历史坑 (Pitfall)】
 *   1. 远端网关媒体不可直接塞进 `<img src>`，必须经 `resolveMediaUrl` 转 Data URL 并保留安全重试态；
 *   2. 图片与文档/视频均仅显示纯文件名，完整路径收敛于 hover `title` 与点击打开预览。
 */

import * as React from 'react';
import {
  ChevronRight,
  Download,
  FileCode2,
  FileText,
  Film,
  Globe,
  Image as ImageIcon,
  RotateCw,
} from 'lucide-react';
import { extractTurnDeliverables, normalizeDeliverableKey, type DeliverableItem } from '@hermes-flux/core';
import { formatDeliverableExtLabel, resolveDeliverableDisplayName } from '../../lib/deliverableViewModel.js';
import { t } from '../../i18n/index.js';
import type { ConversationMessageVM } from './types.js';
import type { MediaLightboxItem } from './MediaLightbox.js';

export interface TurnDeliverablesProps {
  messages: readonly ConversationMessageVM[];
  /** 预计算并已与正文原地引用去重后的成果物列表；省略时退化为直接从 messages 提取 */
  deliverables?: readonly DeliverableItem[];
  /** 回合完整图片列表，供点开紧凑图片卡片时传给 MediaLightbox 支持左右翻页 */
  allTurnImages?: readonly MediaLightboxItem[];
  isStreaming: boolean;
  resolveMediaUrl?: (pathOrUrl: string) => Promise<string | null>;
  onOpenFile?: (filePath: string, previewUrl?: string) => void;
  onOpenMediaLightbox?: (items: readonly MediaLightboxItem[], initialIndex: number) => void;
}

const DIRECT_URL_RE = /^(?:data:image\/|data:video\/|https?:\/\/|blob:|hermes-media:\/\/)/i;

function isDirectMediaUrl(val?: string): boolean {
  return Boolean(val && DIRECT_URL_RE.test(val.trim()));
}

function DeliverableFileIcon({ kind }: { kind: DeliverableItem['kind'] }): React.ReactElement {
  if (kind === 'html') return <Globe size={15} className="conv-deliverable-file__icon" aria-hidden="true" />;
  if (kind === 'video') return <Film size={15} className="conv-deliverable-file__icon" aria-hidden="true" />;
  if (kind === 'markdown' || kind === 'document') {
    return <FileText size={15} className="conv-deliverable-file__icon" aria-hidden="true" />;
  }
  return <FileCode2 size={15} className="conv-deliverable-file__icon" aria-hidden="true" />;
}

export const TurnDeliverables = React.memo(function TurnDeliverables({
  messages,
  deliverables: precomputed,
  allTurnImages,
  isStreaming,
  resolveMediaUrl,
  onOpenFile,
  onOpenMediaLightbox,
}: TurnDeliverablesProps): React.ReactElement | null {
  const deliverables = React.useMemo(() => {
    if (precomputed) return precomputed;
    const inputs = messages.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      toolCalls: m.toolCalls?.map((tc) => ({
        id: tc.id,
        name: tc.name,
        status: tc.status,
        args: tc.args,
        rawArgs: tc.rawArgs,
        output: tc.output,
        imagePath: tc.imagePath,
        inlineDiff: tc.inlineDiff,
      })),
      attachments: m.attachments?.map((att) => ({
        id: att.id,
        name: att.name,
        type: att.type,
        previewUrl: att.previewUrl,
      })),
    }));
    return extractTurnDeliverables(inputs);
  }, [precomputed, messages]);

  const images = React.useMemo(() => deliverables.filter((d) => d.kind === 'image'), [deliverables]);
  const videos = React.useMemo(() => deliverables.filter((d) => d.kind === 'video'), [deliverables]);
  const files = React.useMemo(
    () => deliverables.filter((d) => d.kind !== 'image' && d.kind !== 'video'),
    [deliverables],
  );

  const [mediaUrls, setMediaUrls] = React.useState<Record<string, string>>({});
  const [failedMedia, setFailedMedia] = React.useState<Record<string, boolean>>({});
  const [loadingVideos, setLoadingVideos] = React.useState<Record<string, boolean>>({});
  const loadingVideosRef = React.useRef<Record<string, boolean>>({});
  const [expandedVideos, setExpandedVideos] = React.useState<Record<string, boolean>>({});
  const [retryToken, setRetryToken] = React.useState(0);

  // Why: 仅在挂载后自动预加载图片缩略图；视频文件可能较大，延后到用户点击展开时按需请求，防止首屏阻塞与重复流量浪费。
  React.useEffect(() => {
    if (!resolveMediaUrl || isStreaming) return;
    const pending = images.filter((item) => {
      if (mediaUrls[item.path] || failedMedia[item.path]) return false;
      if (isDirectMediaUrl(item.previewUrl)) return false;
      if (isDirectMediaUrl(item.path)) return false;
      return true;
    });
    if (pending.length === 0) return;

    let cancelled = false;
    for (const item of pending) {
      void resolveMediaUrl(item.path)
        .then((resolved) => {
          if (cancelled) return;
          if (resolved && isDirectMediaUrl(resolved)) {
            setMediaUrls((prev) => ({ ...prev, [item.path]: resolved }));
          } else {
            setFailedMedia((prev) => ({ ...prev, [item.path]: true }));
          }
        })
        .catch(() => {
          if (cancelled) return;
          setFailedMedia((prev) => ({ ...prev, [item.path]: true }));
        });
    }
    return () => {
      cancelled = true;
    };
  }, [images, resolveMediaUrl, isStreaming, mediaUrls, failedMedia, retryToken]);

  const requestVideoUrl = React.useCallback(
    (targetPath: string, resolver: NonNullable<TurnDeliverablesProps['resolveMediaUrl']>) => {
      if (loadingVideosRef.current[targetPath]) return;
      loadingVideosRef.current[targetPath] = true;
      setFailedMedia((prev) => {
        if (!prev[targetPath]) return prev;
        const next = { ...prev };
        delete next[targetPath];
        return next;
      });
      setLoadingVideos((prev) => ({ ...prev, [targetPath]: true }));
      void resolver(targetPath)
        .then((resolved) => {
          delete loadingVideosRef.current[targetPath];
          setLoadingVideos((prev) => {
            const next = { ...prev };
            delete next[targetPath];
            return next;
          });
          if (resolved && isDirectMediaUrl(resolved)) {
            setMediaUrls((prev) => ({ ...prev, [targetPath]: resolved }));
          } else {
            setFailedMedia((prev) => ({ ...prev, [targetPath]: true }));
          }
        })
        .catch(() => {
          delete loadingVideosRef.current[targetPath];
          setLoadingVideos((prev) => {
            const next = { ...prev };
            delete next[targetPath];
            return next;
          });
          setFailedMedia((prev) => ({ ...prev, [targetPath]: true }));
        });
    },
    [],
  );

  if (deliverables.length === 0) return null;

  const resolveDisplayUrl = (item: DeliverableItem): string => {
    if (failedMedia[item.path]) return '';
    if (mediaUrls[item.path]) return mediaUrls[item.path];
    if (isDirectMediaUrl(item.previewUrl)) return item.previewUrl as string;
    if (isDirectMediaUrl(item.path)) return item.path;
    return '';
  };

  const handleRetryMedia = (targetPath: string): void => {
    setFailedMedia((prev) => {
      const next = { ...prev };
      delete next[targetPath];
      return next;
    });
    setRetryToken((n) => n + 1);
  };

  const fallbackLightboxItems: MediaLightboxItem[] = images.map((img) => ({
    id: img.id,
    src: resolveDisplayUrl(img) || img.path,
    path: img.path,
    name: resolveDeliverableDisplayName(img.path, img.name),
    alt: resolveDeliverableDisplayName(img.path, img.name),
  }));
  const lightboxItems: MediaLightboxItem[] = (allTurnImages && allTurnImages.length > 0
    ? allTurnImages
    : fallbackLightboxItems
  ).map((it) => {
    const matchingMedia = it.path && mediaUrls[it.path] ? mediaUrls[it.path] : undefined;
    return matchingMedia ? { ...it, src: matchingMedia } : it;
  });

  const countAttr = images.length === 1 ? '1' : images.length === 2 ? '2' : 'multi';

  return (
    <div className="conv-deliverables" data-testid="turn-deliverables">
      <div className="conv-deliverables__cards" data-testid="turn-deliverables-list">
        {images.length > 0 ? (
          <div className="conv-deliverables__images" data-count={countAttr} data-testid="turn-deliverables-images">
            {images.map((img) => {
              const url = resolveDisplayUrl(img);
              const failed = Boolean(failedMedia[img.path]) && !url;
              const displayName = resolveDeliverableDisplayName(img.path, img.name);
              const extLabel = formatDeliverableExtLabel(displayName, 'image');
              const imgKey = normalizeDeliverableKey(img.path);
              const lbIndex = Math.max(
                0,
                lightboxItems.findIndex((it) => normalizeDeliverableKey(it.path || it.src) === imgKey),
              );

              if (failed) {
                return (
                  <div
                    key={img.id}
                    className="conv-deliverable-file-card conv-deliverable-file-card--image conv-deliverable-file-card--failed"
                    title={img.path}
                  >
                    <span className="conv-deliverable-image__thumb" aria-hidden="true">
                      <ImageIcon size={14} className="conv-deliverable-file__icon" />
                    </span>
                    <span className="conv-deliverable-file__name">{displayName}</span>
                    {resolveMediaUrl ? (
                      <button
                        type="button"
                        className="conv-deliverable-retry-btn"
                        onClick={() => handleRetryMedia(img.path)}
                      >
                        <RotateCw size={12} aria-hidden="true" />
                        <span>{t('conversation.deliverableRetry')}</span>
                      </button>
                    ) : null}
                    {onOpenFile ? (
                      <button
                        type="button"
                        className="conv-deliverable-retry-btn"
                        onClick={() => onOpenFile(img.path, img.previewUrl)}
                      >
                        <span>{t('conversation.deliverableOpen')}</span>
                      </button>
                    ) : null}
                  </div>
                );
              }

              return (
                <button
                  key={img.id}
                  type="button"
                  className="conv-deliverable-file-card conv-deliverable-file-card--image"
                  data-testid="turn-deliverable-image"
                  aria-label={t('conversation.attachmentPreview', { name: displayName })}
                  title={img.path}
                  onClick={() => {
                    if (onOpenMediaLightbox) {
                      onOpenMediaLightbox(lightboxItems, lbIndex);
                    } else {
                      onOpenFile?.(img.path, img.previewUrl);
                    }
                  }}
                >
                  <span className="conv-deliverable-image__thumb">
                    {url ? (
                      <img
                        className="conv-deliverable-image__img"
                        src={url}
                        alt={displayName}
                        loading="lazy"
                      />
                    ) : (
                      <ImageIcon size={14} className="conv-deliverable-file__icon" aria-hidden="true" />
                    )}
                  </span>
                  <span className="conv-deliverable-file__name">{displayName}</span>
                  <span className="conv-deliverable-file__ext">{extLabel}</span>
                  <ChevronRight size={14} className="conv-deliverable-file__chevron" aria-hidden="true" />
                </button>
              );
            })}
          </div>
        ) : null}

        {videos.map((vid) => {
          const url = resolveDisplayUrl(vid);
          const isVideoLoading = Boolean(loadingVideos[vid.path]);
          const failed = Boolean(failedMedia[vid.path]) && !url && !isVideoLoading;
          const displayName = resolveDeliverableDisplayName(vid.path, vid.name);
          const extLabel = formatDeliverableExtLabel(displayName, 'video');
          const isExpanded = Boolean(expandedVideos[vid.id]);
          const retryVideoHandler =
            isDirectMediaUrl(vid.previewUrl) || isDirectMediaUrl(vid.path)
              ? () => handleRetryMedia(vid.path)
              : resolveMediaUrl
                ? () => requestVideoUrl(vid.path, resolveMediaUrl)
                : null;
          return (
            <div key={vid.id} className="conv-deliverable-video-wrap" data-testid="turn-deliverable-video">
              <div className="conv-deliverable-file-card conv-deliverable-file-card--video" title={vid.path}>
                <button
                  type="button"
                  className="conv-deliverable-video__trigger"
                  onClick={() => {
                    if (url) {
                      setExpandedVideos((prev) => ({ ...prev, [vid.id]: !prev[vid.id] }));
                      return;
                    }
                    if (resolveMediaUrl) {
                      setExpandedVideos((prev) => ({ ...prev, [vid.id]: !prev[vid.id] }));
                      if (!isVideoLoading) {
                        requestVideoUrl(vid.path, resolveMediaUrl);
                      }
                      return;
                    }
                    onOpenFile?.(vid.path, vid.previewUrl);
                  }}
                >
                  <Film size={15} className="conv-deliverable-file__icon" aria-hidden="true" />
                  <span className="conv-deliverable-file__name">{displayName}</span>
                  <span className="conv-deliverable-file__ext">{extLabel}</span>
                  <ChevronRight size={14} className="conv-deliverable-file__chevron" aria-hidden="true" />
                </button>
                {failed && retryVideoHandler ? (
                  <button
                    type="button"
                    className="conv-deliverable-retry-btn"
                    onClick={() => {
                      setExpandedVideos((prev) => ({ ...prev, [vid.id]: true }));
                      retryVideoHandler();
                    }}
                  >
                    <RotateCw size={12} aria-hidden="true" />
                    <span>{t('conversation.deliverableRetry')}</span>
                  </button>
                ) : null}
                {onOpenFile ? (
                  <button
                    type="button"
                    className="conv-deliverable-retry-btn"
                    data-testid="turn-deliverable-video-open"
                    title={t('conversation.deliverableOpen')}
                    onClick={() => onOpenFile(vid.path, url || vid.previewUrl)}
                  >
                    <Download size={12} aria-hidden="true" />
                  </button>
                ) : null}
              </div>
              {isExpanded && url ? (
                <video
                  className="conv-deliverable-video__player"
                  controls
                  playsInline
                  preload="metadata"
                  src={url}
                  onError={() => {
                    setMediaUrls((prev) => {
                      if (!(vid.path in prev)) return prev;
                      const next = { ...prev };
                      delete next[vid.path];
                      return next;
                    });
                    setFailedMedia((prev) => ({ ...prev, [vid.path]: true }));
                  }}
                />
              ) : isExpanded && isVideoLoading ? (
                <div className="conv-deliverable-video__loading" data-testid="turn-deliverable-video-loading">
                  <span>{t('inspector.videoLoading')}</span>
                  <span className="conv-deliverable-video__loading-sub">{t('inspector.videoLoadingSub')}</span>
                </div>
              ) : isExpanded && failed ? (
                <div className="conv-deliverable-video__loading" data-testid="turn-deliverable-video-error">
                  <span>{t('inspector.videoLoadError')}</span>
                  <span className="conv-deliverable-video__loading-sub">{t('inspector.videoLoadErrorSub')}</span>
                </div>
              ) : null}
            </div>
          );
        })}

        {files.map((file) => {
          const displayName = resolveDeliverableDisplayName(file.path, file.name);
          const extLabel = formatDeliverableExtLabel(displayName, file.kind);
          return (
            <button
              key={file.id}
              type="button"
              className="conv-deliverable-file-card"
              data-preview-file={file.path}
              data-testid="turn-deliverable-file"
              title={file.path}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onOpenFile?.(file.path, file.previewUrl);
              }}
            >
              <DeliverableFileIcon kind={file.kind} />
              <span className="conv-deliverable-file__name">{displayName}</span>
              {extLabel ? <span className="conv-deliverable-file__ext">{extLabel}</span> : null}
              <ChevronRight size={14} className="conv-deliverable-file__chevron" aria-hidden="true" />
            </button>
          );
        })}
      </div>
    </div>
  );
});
