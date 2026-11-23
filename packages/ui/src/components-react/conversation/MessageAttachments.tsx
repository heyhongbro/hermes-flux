/**
 * 跨端共享附件展示组件（输入舱待发区 + 用户消息气泡共源复用）
 *
 * 【设计意图 (Why)】
 *   统一 React 表现层在 Mobile 输入舱（`MobileMorphingComposer` `variant="composer"`）与
 *   全端会话流用户气泡（`MessageRow` `variant="bubble"`，桌面与移动共用）中的附件展示组件；
 *   同一份 `MessageAttachmentItem[]` 发出后保留图片缩略图与文件胶囊（支持点击图片就地放大收起，无需 `position: fixed` 逃逸）。
 *   注：桌面旧模板 `InputDock.renderAttachmentTray` 暂保留以遵守 `.template-inventory.json` 存量冻结及 `composer-dock.test.mjs` 契约。
 *
 * 【约束与规则 (Rules)】
 *   - 全部消费语义 Design Tokens，零硬编码色相；
 *   - 空数组直接返回 `null`；所有文案经 `t(...)` 输出。
 */

import * as React from 'react';
import { FileText, Image as ImageIcon, Paperclip, X } from 'lucide-react';
import { formatFileSize, type MessageAttachmentItem } from '@hermes-flux/core';
import { t } from '../../i18n/index.js';

export interface MessageAttachmentsProps {
  attachments: readonly MessageAttachmentItem[];
  variant: 'bubble' | 'composer';
  onRemove?: (id: string) => void;
}

export function MessageAttachments({
  attachments,
  variant,
  onRemove,
}: MessageAttachmentsProps): React.ReactElement | null {
  const [expandedId, setExpandedId] = React.useState<string | null>(null);
  if (attachments.length === 0) return null;

  return (
    <div
      className="conv-attachments"
      data-variant={variant}
      data-testid={variant === 'bubble' ? 'message-attachments-bubble' : 'message-attachments-composer'}
    >
      {attachments.map((att) => {
        const isImg = att.type === 'image';
        const sizeLabel = formatFileSize(att.sizeBytes);
        const expanded = variant === 'bubble' && expandedId === att.id;

        if (isImg && att.previewUrl) {
          return (
            <div
              key={att.id}
              className="conv-att-image-card"
              data-expanded={expanded ? 'true' : 'false'}
            >
              {variant === 'bubble' ? (
                <button
                  type="button"
                  className="conv-att-image-btn"
                  aria-label={t('conversation.attachmentPreview', { name: att.name })}
                  onClick={() => setExpandedId((prev) => (prev === att.id ? null : att.id))}
                >
                  <img className="conv-att-thumb__img" src={att.previewUrl} alt={att.name} />
                </button>
              ) : (
                <img className="conv-att-thumb__img" src={att.previewUrl} alt={att.name} />
              )}
              <span className="conv-att-image-name" title={att.name}>
                {att.name}
              </span>
              {onRemove ? (
                <button
                  type="button"
                  className="conv-att-remove"
                  onClick={() => onRemove(att.id)}
                  aria-label={t('common.remove')}
                >
                  <X size={12} />
                </button>
              ) : null}
            </div>
          );
        }

        const Icon = isImg ? ImageIcon : att.type === 'pdf' ? FileText : Paperclip;
        return (
          <div key={att.id} className="conv-att-file-chip">
            <Icon size={13} className="conv-att-file-chip__icon" aria-hidden="true" />
            <span className="conv-att-file-chip__name" title={att.name}>
              {att.name}
            </span>
            {sizeLabel ? <span className="conv-att-file-chip__size">{sizeLabel}</span> : null}
            {onRemove ? (
              <button
                type="button"
                className="conv-att-remove conv-att-remove--inline"
                onClick={() => onRemove(att.id)}
                aria-label={t('common.remove')}
              >
                <X size={12} />
              </button>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
