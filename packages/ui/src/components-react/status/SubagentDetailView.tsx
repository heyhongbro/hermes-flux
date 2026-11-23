/**
 * 子 Agent 执行流下钻详情页（只读复刻 ConversationMessageList + 运行期干预 + 终态引用）
 *
 * 【防范的历史坑 (Pitfall)】
 *   1. P-029 键盘事件泄露：自绘切换菜单打开时按 Esc 必须 preventDefault()+stopPropagation()，
 *      防止冒泡到窗口层误触发退出全屏或关闭右侧栏；
 *   2. 禁止原生 select 下拉脱离暗黑皮肤；
 *   3. 已结束终态绝不渲染纠偏输入框。
 */

import * as React from 'react';
import { isSyntheticSubagentId } from '@hermes-flux/core';
import { t } from '../../i18n/index.js';
import { ConversationMessageList } from '../conversation/ConversationMessageList.js';
import { useNow } from '../conversation/useNow.js';
import {
  formatTokenShort,
  isActiveLifecycleStatus,
  resolveTaskDurationLabel,
  statusMetaForLifecycle,
  tailKindLabel,
} from './statusFormatters.js';
import type { RightPodActions, RightPodSnapshot } from './types.js';

function formatFinishClock(tsMs: number): string {
  const d = new Date(tsMs);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

function shortFileName(filePath: string): string {
  const parts = filePath.split(/[\\/]+/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : filePath;
}

export interface SubagentDetailViewProps {
  snapshot: RightPodSnapshot;
  actions: RightPodActions;
}

export function SubagentDetailView({ snapshot, actions }: SubagentDetailViewProps): React.ReactElement {
  const task = snapshot.selectedSubagent;
  const isActive = Boolean(task && isActiveLifecycleStatus(task.lifecycleStatus));
  const now = useNow(isActive);

  const [switcherOpen, setSwitcherOpen] = React.useState(false);
  const [activeIndex, setActiveIndex] = React.useState(0);
  const [steerInput, setSteerInput] = React.useState('');
  const [isSubmittingSteer, setIsSubmittingSteer] = React.useState(false);
  const [copiedSummary, setCopiedSummary] = React.useState(false);

  const switcherRef = React.useRef<HTMLDivElement | null>(null);
  const subagents = snapshot.subagents;

  React.useEffect(() => {
    if (!switcherOpen) return;
    const handlePointerDown = (event: PointerEvent): void => {
      if (switcherRef.current && !switcherRef.current.contains(event.target as Node)) {
        setSwitcherOpen(false);
      }
    };
    // 捕获阶段抢先消费 Escape，保证无论焦点在哪，一次 Esc 仅关闭子 Agent 切换菜单
    const handleWindowKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      setSwitcherOpen(false);
    };
    window.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('keydown', handleWindowKeyDown, true);
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('keydown', handleWindowKeyDown, true);
    };
  }, [switcherOpen]);

  React.useEffect(() => {
    setCopiedSummary(false);
    setSteerInput('');
    setIsSubmittingSteer(false);
  }, [task?.subagentId]);

  const handleSwitcherKeyDown = (event: React.KeyboardEvent): void => {
    if (!switcherOpen) {
      if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        const curIdx = Math.max(0, subagents.findIndex((s) => s.subagentId === task?.subagentId));
        setActiveIndex(curIdx);
        setSwitcherOpen(true);
      }
      return;
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setSwitcherOpen(false);
      return;
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((prev) => (subagents.length > 0 ? (prev + 1) % subagents.length : 0));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((prev) => (subagents.length > 0 ? (prev - 1 + subagents.length) % subagents.length : 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const target = subagents[activeIndex];
      if (target) {
        actions.onOpenSubagent(target.subagentId);
      }
      setSwitcherOpen(false);
    }
  };

  const isSynthetic = Boolean(task && isSyntheticSubagentId(task.subagentId));
  const steerDisabled = Boolean(isActive && (task?.acceptingSteer === false || isSynthetic));
  const interruptDisabled = Boolean(task?.interruptPending || isSynthetic);

  const handleSteerSubmit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (!task || !isActive || task.acceptingSteer === false || isSynthetic || isSubmittingSteer) return;
    const trimmed = steerInput.trim();
    if (!trimmed) return;
    setIsSubmittingSteer(true);
    try {
      const ok = await actions.onSteerSubagent(task.subagentId, trimmed);
      if (ok !== false) {
        setSteerInput('');
      }
    } finally {
      setIsSubmittingSteer(false);
    }
  };

  const handleStreamClick = (event: React.MouseEvent<HTMLDivElement>): void => {
    const target = event.target as HTMLElement | null;
    if (!target) return;
    const fileEl = target.closest('[data-preview-file]') as HTMLElement | null;
    const filePath = fileEl?.dataset?.previewFile;
    if (filePath) {
      event.preventDefault();
      actions.onOpenFilesAtPath(filePath);
    }
  };

  const transcript = snapshot.selectedTranscript;
  const elapsed = task ? (resolveTaskDurationLabel(task, now) ?? '') : '';
  const taskStatusMeta = task ? statusMetaForLifecycle(task.lifecycleStatus) : null;
  const hasTokenTelemetry = Boolean(
    task &&
      ((typeof task.tokensInput === 'number' && task.tokensInput > 0) ||
        (typeof task.tokensOutput === 'number' && task.tokensOutput > 0) ||
        (typeof task.tokensReasoning === 'number' && task.tokensReasoning > 0))
  );

  const summaryPayload = task?.summary || task?.resultSummary || task?.error || task?.goal || '';

  return (
    <div className="status-pod-window subagent-detail-window" data-testid="subagent-detail-view">
      {/* 顶栏：幽灵返回键 + 无框透明切换器 + 全屏（桌面） + 收起 */}
      <header className="subagent-detail-topbar">
        <button
          type="button"
          className="icon-btn subagent-btn-back"
          data-testid="subagent-back-btn"
          onClick={actions.onBackToStatus}
          title={t('statusPod.backToStatus')}
          aria-label={t('statusPod.backToStatus')}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>

        <div className="subagent-switcher" ref={switcherRef} onKeyDown={handleSwitcherKeyDown}>
          <button
            type="button"
            className="subagent-switcher__btn"
            aria-haspopup="listbox"
            aria-expanded={switcherOpen}
            data-testid="subagent-switcher-btn"
            onClick={() => {
              const curIdx = Math.max(0, subagents.findIndex((s) => s.subagentId === task?.subagentId));
              setActiveIndex(curIdx);
              setSwitcherOpen((prev) => !prev);
            }}
            title={task?.goal || t('statusPod.switchSubagent')}
          >
            {taskStatusMeta ? <span className="dot-inline" data-tone={taskStatusMeta.tone} aria-hidden="true" /> : null}
            <span className="subagent-switcher__label">{task?.goal || task?.taskTitle || task?.subagentId || t('statusPod.switchSubagent')}</span>
            {subagents.length > 1 ? (
              <svg className="subagent-switcher__caret" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <polyline points="6 9 12 15 18 9" />
              </svg>
            ) : null}
          </button>

          {switcherOpen && subagents.length > 0 ? (
            <ul className="subagent-switcher__menu" role="listbox" data-testid="subagent-switcher-menu">
              {subagents.map((item, idx) => {
                const selected = item.subagentId === task?.subagentId;
                const itemMeta = statusMetaForLifecycle(item.lifecycleStatus);
                return (
                  <li key={item.subagentId} role="option" aria-selected={selected}>
                    <button
                      type="button"
                      className={`subagent-switcher__item${selected ? ' is-selected' : ''}${idx === activeIndex ? ' is-focused' : ''}`}
                      onClick={() => {
                        actions.onOpenSubagent(item.subagentId);
                        setSwitcherOpen(false);
                      }}
                    >
                      <span className="dot-inline" data-tone={itemMeta.tone} aria-hidden="true" />
                      <span className="subagent-switcher__item-title">{item.goal || item.taskTitle || item.subagentId}</span>
                      <span className="subagent-switcher__item-status">{itemMeta.label}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </div>

        <div className="subagent-detail-topbar__controls">
          <button
            type="button"
            className="icon-btn subagent-btn-fullscreen"
            data-testid="subagent-fullscreen-btn"
            onClick={actions.onToggleFullscreen}
            title={snapshot.isFullscreen ? t('statusPod.exitFullscreen') : t('statusPod.enterFullscreen')}
          >
            {snapshot.isFullscreen ? (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <polyline points="4 14 10 14 10 20" />
                <polyline points="20 10 14 10 14 4" />
                <line x1="14" y1="10" x2="21" y2="3" />
                <line x1="3" y1="21" x2="10" y2="14" />
              </svg>
            ) : (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <polyline points="15 3 21 3 21 9" />
                <polyline points="9 21 3 21 3 15" />
                <line x1="21" y1="3" x2="14" y2="10" />
                <line x1="3" y1="21" x2="10" y2="14" />
              </svg>
            )}
          </button>
          <button
            type="button"
            className="icon-btn"
            data-testid="subagent-close-btn"
            onClick={actions.onClose}
            title={t('statusPod.close')}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      </header>

      {/* 遥测摘要与可点击单色文件标签 */}
      {task && taskStatusMeta ? (
        <section className="subagent-detail-telemetry">
          <div className="subagent-telemetry-pills">
            <span className="subagent-status-inline">
              <span className="dot-inline" data-tone={taskStatusMeta.tone} aria-hidden="true" />
              <span>{taskStatusMeta.label}</span>
            </span>
            {elapsed ? (
              <>
                <span aria-hidden="true">·</span>
                <span className="subagent-telemetry-meta">{elapsed}</span>
              </>
            ) : null}
          </div>

          {task.model || task.toolCount > 0 || hasTokenTelemetry ? (
            <div className="subagent-telemetry-pills">
              {task.model ? <span className="subagent-telemetry-meta">{task.model}</span> : null}
              {task.model && (task.toolCount > 0 || hasTokenTelemetry) ? <span aria-hidden="true">·</span> : null}
              {task.toolCount > 0 ? (
                <span className="subagent-telemetry-meta">{t('statusPod.toolsUsed', { count: String(task.toolCount) })}</span>
              ) : null}
              {task.toolCount > 0 && hasTokenTelemetry ? <span aria-hidden="true">·</span> : null}
              {hasTokenTelemetry ? (
                <span className="subagent-telemetry-meta" data-testid="subagent-telemetry-tokens">
                  {t('statusPod.inputTokens')} {formatTokenShort(task.tokensInput ?? 0)}
                  {' · '}
                  {t('statusPod.outputTokens')} {formatTokenShort(task.tokensOutput ?? 0)}
                  {typeof task.tokensReasoning === 'number' && task.tokensReasoning > 0
                    ? ` · ${t('statusPod.reasoningTokens')} ${formatTokenShort(task.tokensReasoning)}`
                    : ''}
                </span>
              ) : null}
            </div>
          ) : null}

          {((task.filesRead && task.filesRead.length > 0) || (task.filesWritten && task.filesWritten.length > 0)) ? (
            <div className="subagent-telemetry-files">
              {task.filesWritten?.map((fp) => (
                <button
                  key={`w:${fp}`}
                  type="button"
                  className="status-file-chip status-file-chip--written"
                  onClick={() => actions.onOpenFilesAtPath(fp)}
                  title={`${t('statusPod.filesWrittenLabel')}: ${fp}`}
                >
                  {shortFileName(fp)}
                </button>
              ))}
              {task.filesRead?.map((fp) => (
                <button
                  key={`r:${fp}`}
                  type="button"
                  className="status-file-chip"
                  onClick={() => actions.onOpenFilesAtPath(fp)}
                  title={`${t('statusPod.filesReadLabel')}: ${fp}`}
                >
                  {shortFileName(fp)}
                </button>
              ))}
            </div>
          ) : null}
        </section>
      ) : null}

      {/* 中部：复用主对话消息流（只读严格隔离），并在降级态渲染尾部日志 */}
      <div className="subagent-stream-canvas" onClick={handleStreamClick} data-testid="subagent-stream-canvas">
        {transcript?.status === 'degraded_tail' ? (
          <>
            <div className="subagent-degraded-banner">{t('statusPod.subagentDegradedBanner')}</div>
            {snapshot.selectedLogs.length > 0 ? (
              <div className="subagent-tail-list" data-testid="subagent-tail-list">
                {snapshot.selectedLogs.map((entry, idx) => (
                  <div key={`${entry.seq}-${idx}`} className="subagent-tail-line" data-kind={entry.kind}>
                    <span className="subagent-tail-line__kind">[{tailKindLabel(entry.kind)}]</span>
                    <span className="subagent-tail-line__body">{entry.text}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="conv-state" data-conv-state="empty">
                <div className="conv-state__title">{t('statusPod.subagentTailEmpty')}</div>
              </div>
            )}
          </>
        ) : transcript?.status === 'error' && snapshot.selectedMessages.length === 0 ? (
          <div className="subagent-degraded-banner subagent-degraded-banner--error" data-testid="subagent-transcript-error">
            {transcript.error || t('statusPod.subagentStreamEmpty')}
          </div>
        ) : (
          <>
            {transcript?.error && (transcript.status === 'error' || transcript.isIncrementalError) ? (
              <div className="subagent-degraded-banner subagent-degraded-banner--error" data-testid="subagent-transcript-error">
                {transcript.error}
              </div>
            ) : null}
            <ConversationMessageList
              snapshot={{
                mode: 'scratchpad',
                connection: 'connected',
                messages: snapshot.selectedMessages,
                messagesPhase: transcript?.status === 'loading' && snapshot.selectedMessages.length === 0 ? 'loading' : 'ready',
                isStreaming: isActive,
                locale: snapshot.locale,
                emptyTitle: t('statusPod.subagentStreamEmpty'),
              }}
              readOnly
              onCopyMessage={(content) => {
                void actions.onCopyText(content);
              }}
            />
          </>
        )}
      </div>

      {/* 底栏：紧凑单色极简按钮（无刺眼红绿边框底色） */}
      {task ? (
        isActive ? (
          <footer className="subagent-detail-footer" data-testid="subagent-footer-active">
            {snapshot.steerFeedback && snapshot.steerFeedback.subagentId === task.subagentId ? (
              <div className="subagent-steer-feedback" data-status={snapshot.steerFeedback.status}>
                {snapshot.steerFeedback.message}
              </div>
            ) : null}
            {steerDisabled ? (
              <div className="subagent-steer-notice" data-testid="subagent-steer-disabled-notice">
                {isSynthetic ? t('statusPod.subagentIdPending') : t('statusPod.steerNotAccepting')}
              </div>
            ) : null}
            <form className="subagent-steer-form" onSubmit={(e) => void handleSteerSubmit(e)}>
              <input
                type="text"
                className="subagent-steer__input"
                data-testid="subagent-steer-input"
                disabled={steerDisabled}
                value={steerInput}
                onChange={(e) => setSteerInput(e.target.value)}
                placeholder={
                  isSynthetic
                    ? t('statusPod.subagentIdPending')
                    : steerDisabled
                    ? t('statusPod.steerNotAccepting')
                    : t('statusPod.steerPlaceholder')
                }
              />
              <button
                type="submit"
                className="subagent-steer__submit sp-btn-xs sp-btn-xs--primary"
                data-testid="subagent-steer-submit"
                disabled={steerDisabled || isSubmittingSteer || !steerInput.trim()}
              >
                {t('statusPod.steerSend')}
              </button>
              <button
                type="button"
                className="subagent-steer__interrupt sp-btn-xs"
                data-testid="subagent-detail-interrupt-btn"
                disabled={interruptDisabled}
                title={isSynthetic ? t('statusPod.subagentIdPending') : task.interruptPending ? t('statusPod.interrupting') : t('statusPod.interrupt')}
                onClick={() => actions.onInterruptSubagent(task.subagentId)}
              >
                {task.interruptPending ? t('statusPod.interrupting') : t('statusPod.interrupt')}
              </button>
            </form>
          </footer>
        ) : (
          <footer className="subagent-detail-footer subagent-detail-footer--terminal" data-testid="subagent-footer-terminal">
            <span className="subagent-terminal-stamp">
              {t('statusPod.finishedAt', { time: formatFinishClock(task.completedAt ?? task.updatedAt) })}
            </span>
            <div className="subagent-terminal-actions">
              <button
                type="button"
                className="sp-btn-xs"
                data-testid="subagent-copy-summary-btn"
                onClick={async () => {
                  if (!summaryPayload) return;
                  const copied = await actions.onCopyText(summaryPayload);
                  if (copied !== false) {
                    setCopiedSummary(true);
                  }
                }}
              >
                {copiedSummary ? t('statusPod.copiedSummary') : t('statusPod.copySummary')}
              </button>
              <button
                type="button"
                className="sp-btn-xs sp-btn-xs--primary"
                data-testid="subagent-quote-btn"
                onClick={() => {
                  const statusLabel = taskStatusMeta?.label ?? task.lifecycleStatus;
                  const quoted = `[${task.goal || task.subagentId}] (${statusLabel})\n\n${summaryPayload}`;
                  actions.onQuoteToMain(quoted);
                }}
              >
                {t('statusPod.quoteToMain')}
              </button>
            </div>
          </footer>
        )
      ) : null}
    </div>
  );
}
