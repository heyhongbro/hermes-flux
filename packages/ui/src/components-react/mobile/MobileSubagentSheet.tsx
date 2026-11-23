/**
 * 移动端子代理委派任务详情底部抽屉 (MobileSubagentSheet)
 *
 * 【设计意图 (Why)】
 *   对话区将子代理调用收敛为单条 `42px` 叠放头像状态条，避免并行执行树霸占移动竖屏。
 *   用户点击状态条时从底部滑出纯净哑光抽屉，清晰查看各子代理的任务目标、执行状态、
 *   实时输出与中断控制。
 */

import * as React from 'react';
import { Square, X } from 'lucide-react';
import { t } from '../../i18n/index.js';
import type { ConversationToolVM } from '../conversation/types.js';
import { ActivityIndicator } from '../primitives/ActivityIndicator.js';
import { parseSubagentToolArgs } from './mobileShellModel.js';
import type { MobileSubagentSheetState } from './types.js';

export interface MobileSubagentSheetProps {
  sheet: MobileSubagentSheetState | null;
  isStreaming: boolean;
  onClose: () => void;
  onInterruptTurn: () => void;
}

export function MobileSubagentSheet({
  sheet,
  isStreaming,
  onClose,
  onInterruptTurn,
}: MobileSubagentSheetProps): React.ReactElement | null {
  if (!sheet) return null;

  const hasRunning = sheet.tools.some((tool) => tool.status === 'running');

  return (
    <div
      className="m-sheet-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={t('mobile.trace.subagentSheetTitle')}
      onClick={onClose}
    >
      <div className="m-bottom-sheet m-subagent-sheet m-no-swipe" onClick={(e) => e.stopPropagation()}>
        <div className="m-sheet-handle" aria-hidden="true" />
        <div className="m-sheet-header">
          <span className="m-sheet-title">{t('mobile.trace.subagentSheetTitle')}</span>
          <button
            type="button"
            className="m-icon-btn"
            onClick={onClose}
            aria-label={t('mobile.common.close')}
          >
            <X size={18} />
          </button>
        </div>

        <div className="m-subagent-sheet__body">
          {sheet.tools.map((tool, index) => {
            const { title, task } = parseSubagentToolArgs(tool.name, tool.args, t('tool.agent'));
            const statusText =
              tool.status === 'running'
                ? t('mobile.trace.subagentStatusRunning')
                : tool.status === 'failed'
                  ? t('mobile.trace.subagentStatusFailed')
                  : t('mobile.trace.subagentStatusCompleted');
            return (
              <div key={tool.id || index} className="m-subagent-card" data-status={tool.status}>
                <div className="m-subagent-card__top">
                  <span className="m-subagent-card__name">{title}</span>
                  <span className="m-subagent-card__status">
                    {tool.status === 'running' ? (
                      <ActivityIndicator
                        state="running"
                        placement="inline"
                        entityKind="bot"
                        variant="prolate-lattice"
                      />
                    ) : (
                      statusText
                    )}
                  </span>
                </div>
                {task ? <p className="m-subagent-card__task">{task}</p> : null}
                {tool.output ? (
                  <pre className="m-subagent-card__output" data-gesture-ignore="pan-x">
                    {tool.output}
                  </pre>
                ) : null}
              </div>
            );
          })}
        </div>

        {hasRunning && isStreaming ? (
          <div className="m-subagent-sheet__footer">
            <button type="button" className="m-danger-btn" onClick={onInterruptTurn}>
              <Square size={12} fill="currentColor" aria-hidden="true" />
              <span>{t('mobile.trace.subagentInterrupt')}</span>
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
