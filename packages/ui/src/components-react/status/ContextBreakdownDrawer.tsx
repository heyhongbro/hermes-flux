/**
 * 上下文构成明细面板（只读展开，点击底部上下文条触发）
 *
 * 【设计意图 (Why)】
 *   网关返回 color 携带未入主题槽的幽灵变量，本组件严格忽略它，
 *   按 category.id 映射至 status-pod.css 已验证的主题语义类。
 */

import * as React from 'react';
import type { ContextBreakdownState } from '@hermes-flux/core';
import { t } from '../../i18n/index.js';
import { formatTokenShort } from './statusFormatters.js';

export { formatTokenShort };

function categoryClassForId(id: string): string {
  switch (id) {
    case 'system_prompt':
      return 'system';
    case 'tool_definitions':
      return 'tools';
    case 'rules':
      return 'rules';
    case 'subagent_definitions':
      return 'subagents';
    case 'memory':
      return 'memory';
    case 'conversation':
      return 'conversation';
    default:
      return 'other';
  }
}

function shortFileName(filePath: string): string {
  const parts = filePath.split(/[\\/]+/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : filePath;
}

export interface ContextBreakdownDrawerProps {
  breakdown: ContextBreakdownState;
  effectiveCompressionRatio?: number | null;
  onOpenFile: (path: string) => void;
}

export function ContextBreakdownDrawer({
  breakdown,
  effectiveCompressionRatio = null,
  onOpenFile,
}: ContextBreakdownDrawerProps): React.ReactElement {
  if (breakdown.status === 'loading' && breakdown.categories.length === 0) {
    return (
      <div className="sp-breakdown status-breakdown" data-testid="context-breakdown-drawer">
        <div className="status-breakdown__state">{t('statusPod.breakdownLoading')}</div>
      </div>
    );
  }

  if (breakdown.status === 'error' && breakdown.categories.length === 0) {
    return (
      <div className="sp-breakdown status-breakdown" data-testid="context-breakdown-drawer">
        <div className="status-breakdown__state status-breakdown__state--error">
          {breakdown.error || t('statusPod.breakdownEmpty')}
        </div>
      </div>
    );
  }

  if (breakdown.categories.length === 0) {
    return (
      <div className="sp-breakdown status-breakdown" data-testid="context-breakdown-drawer">
        <div className="status-breakdown__state">{t('statusPod.breakdownEmpty')}</div>
      </div>
    );
  }

  const ctxMax = breakdown.contextMax;
  const capText =
    typeof ctxMax === 'number' && ctxMax > 0
      ? effectiveCompressionRatio !== null && effectiveCompressionRatio > 0 && effectiveCompressionRatio < 1
        ? t('statusPod.breakdownCapWithThresholdMeta', {
            max: formatTokenShort(ctxMax),
            threshold: formatTokenShort(Math.round(ctxMax * effectiveCompressionRatio)),
          })
        : t('statusPod.breakdownCapMeta', { max: formatTokenShort(ctxMax) })
      : null;

  return (
    <div className="sp-breakdown status-breakdown" data-testid="context-breakdown-drawer">
      {breakdown.status === 'error' && breakdown.error ? (
        <div className="status-inline-warn" data-testid="context-breakdown-error">
          {breakdown.error}
        </div>
      ) : null}
      <div className="status-breakdown__rows">
        {breakdown.categories.map((cat) => (
          <div key={cat.id} className="status-breakdown__row">
            <span className="sp-bd-left">
              <span className={`status-breakdown__dot status-breakdown__cat--${categoryClassForId(cat.id)}`} aria-hidden="true" />
              <span className="status-breakdown__label" title={cat.label}>{cat.label}</span>
            </span>
            <span className="status-breakdown__value">{formatTokenShort(cat.tokens)}</span>
          </div>
        ))}
      </div>

      {breakdown.contextFiles.length > 0 ? (
        <div className="sp-bd-files status-breakdown__file-list">
          {breakdown.contextFiles.map((file, idx) => (
            <button
              key={`${file.path}-${idx}`}
              type="button"
              className="status-file-chip"
              onClick={() => onOpenFile(file.path)}
              title={file.path}
            >
              <span className="status-file-chip__name">{file.label || shortFileName(file.path)}</span>
              {typeof file.est_tokens === 'number' ? (
                <span className="status-file-chip__tok">· {formatTokenShort(file.est_tokens)}</span>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}

      {capText ? <div className="sp-bd-meta">{capText}</div> : null}
    </div>
  );
}
