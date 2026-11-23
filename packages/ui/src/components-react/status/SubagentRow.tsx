/**
 * 状态列表单行实体组件（单一可复用组件）
 *
 * 【设计意图 (Why)】
 *   运行中子 Agent、已结束子 Agent、群聊成员活跃共用极简单行几何：
 *   左图标点位 + 中单行标题 + 右侧极淡状态文字（运行中悬停显示中性停止键）。
 */

import * as React from 'react';
import { t } from '../../i18n/index.js';

export type SubagentRowVariant = 'active' | 'terminal' | 'room_member';
export type SubagentRowTone = 'running' | 'queued' | 'success' | 'danger' | 'muted';

export interface SubagentRowProps {
  variant: SubagentRowVariant;
  subagentId?: string;
  title: string;
  statusLabel: string;
  tone: SubagentRowTone;
  subtitle?: string;
  interruptPending?: boolean;
  onInspect?: () => void;
  onInterrupt?: () => void;
}

export function SubagentRow({
  variant,
  subagentId,
  title,
  statusLabel,
  tone,
  subtitle,
  interruptPending = false,
  onInspect,
  onInterrupt,
}: SubagentRowProps): React.ReactElement {
  const interactive = Boolean(onInspect) && variant !== 'room_member';
  const rowTooltip = subtitle ? `${title} · ${subtitle}` : title;
  const stateClass =
    tone === 'running' || tone === 'queued'
      ? 'sp-agent-state sp-agent-state--running'
      : 'sp-agent-state';

  const avatarGlyph =
    variant === 'room_member' ? (
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
        <circle cx="12" cy="7" r="4" />
      </svg>
    ) : (
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="11" width="18" height="10" rx="2" />
        <circle cx="12" cy="5" r="2" />
        <path d="M12 7v4" />
      </svg>
    );

  const innerContent = (
    <>
      <span className="sp-agent-avatar" aria-hidden="true">
        {avatarGlyph}
        <span className="sp-status-dot" data-tone={tone} />
      </span>
      <span className="sp-agent-goal">{title}</span>
      <span className={stateClass} data-tone={tone}>
        {statusLabel}
      </span>
    </>
  );

  return (
    <div
      className="sp-agent-row status-row"
      data-variant={variant}
      data-tone={tone}
      data-subagent-id={subagentId ?? ''}
    >
      {interactive ? (
        <button
          type="button"
          className="status-row__main"
          onClick={onInspect}
          title={rowTooltip}
        >
          {innerContent}
        </button>
      ) : (
        <div className="status-row__main status-row__main--readonly" title={rowTooltip}>
          {innerContent}
        </div>
      )}

      {variant === 'active' && onInterrupt ? (
        <button
          type="button"
          className="sp-stop-mini status-row__interrupt"
          disabled={interruptPending}
          onClick={(event) => {
            event.stopPropagation();
            onInterrupt();
          }}
          title={interruptPending ? t('statusPod.interrupting') : t('statusPod.interrupt')}
          aria-label={interruptPending ? t('statusPod.interrupting') : t('statusPod.interrupt')}
        >
          <span className="sp-stop-mini__glyph" aria-hidden="true">
            <svg width="7" height="7" viewBox="0 0 12 12" fill="currentColor">
              <rect x="2" y="2" width="8" height="8" rx="1.5" />
            </svg>
          </span>
        </button>
      ) : null}
    </div>
  );
}
