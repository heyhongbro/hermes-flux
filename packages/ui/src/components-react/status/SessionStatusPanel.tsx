/**
 * 会话整体状态栏主视图（自上而下按内容自适应扩展：Agent 身份与环境 / 单行子 Agent / 紧凑用量与上下文）
 */

import * as React from 'react';
import { Network } from 'lucide-react';
import { isSyntheticSubagentId, type SubagentTaskState } from '@hermes-flux/core';
import { t } from '../../i18n/index.js';
import { renderBotAvatar, renderGroupCollageAvatar } from '../../utils/botAvatar.js';
import { ContextBreakdownDrawer } from './ContextBreakdownDrawer.js';
import { SubagentRow } from './SubagentRow.js';
import {
  formatTokenShort,
  groupActivityMeta,
  isActiveLifecycleStatus as isActiveStatus,
  statusMetaForLifecycle,
} from './statusFormatters.js';
import type { RightPodActions, RightPodSnapshot } from './types.js';

const DEFAULT_VISIBLE_ROWS = 3;

function sortSubagentTasks(subagents: readonly SubagentTaskState[]): {
  active: SubagentTaskState[];
  terminal: SubagentTaskState[];
} {
  const active: SubagentTaskState[] = [];
  const terminal: SubagentTaskState[] = [];
  for (const item of subagents) {
    if (isActiveStatus(item.lifecycleStatus)) {
      active.push(item);
    } else {
      terminal.push(item);
    }
  }
  active.sort((a, b) => a.startedAt - b.startedAt);
  terminal.sort((a, b) => (b.completedAt ?? b.updatedAt) - (a.completedAt ?? a.updatedAt));
  return { active, terminal };
}

export interface SessionStatusPanelProps {
  snapshot: RightPodSnapshot;
  actions: RightPodActions;
}

export function SessionStatusPanel({ snapshot, actions }: SessionStatusPanelProps): React.ReactElement {
  const [subagentsExpanded, setSubagentsExpanded] = React.useState(true);
  const [showAllTerminal, setShowAllTerminal] = React.useState(false);
  const [breakdownOpen, setBreakdownOpen] = React.useState(false);

  const isGroupRoom = snapshot.conversationMode === 'group_room';
  const scope = snapshot.scope;
  const activeScopeKey = snapshot.activeScopeKey ?? scope?.scopeKey ?? '';
  const subject = snapshot.subject;
  const { active, terminal } = React.useMemo(() => sortSubagentTasks(snapshot.subagents), [snapshot.subagents]);

  React.useEffect(() => {
    setBreakdownOpen(false);
    setShowAllTerminal(false);
    setSubagentsExpanded(true);
  }, [activeScopeKey]);

  const initialTerminalLimit = Math.max(0, DEFAULT_VISIBLE_ROWS - active.length);
  const visibleTerminal = showAllTerminal ? terminal : terminal.slice(0, initialTerminalLimit);
  const hasMoreTerminal = terminal.length > initialTerminalLimit;

  const subjectName = isGroupRoom
    ? subject?.name || scope?.groupState?.name || t('statusPod.groupMembersHeading')
    : subject?.name || scope?.projectName || 'Hermes';

  const avatarHtml = React.useMemo(() => {
    if (isGroupRoom || subject?.kind === 'group') {
      return renderGroupCollageAvatar(subject?.groupMembers ?? [], subject?.groupProfiles ?? [], 20);
    }
    return renderBotAvatar(subject?.profileName || 'default', subjectName, subject?.avatar, 20);
  }, [isGroupRoom, subject, subjectName]);

  const usage = scope?.usage ?? null;
  const ctxUsed = usage?.contextUsed ?? null;
  const ctxMax = usage?.contextMax ?? null;
  const ctxPct =
    usage?.contextPercent ??
    (ctxUsed !== null && ctxMax !== null && ctxMax > 0
      ? Math.max(0, Math.min(100, Math.round((ctxUsed / ctxMax) * 100)))
      : null);
  const clampedPct = ctxPct !== null ? Math.max(0, Math.min(100, ctxPct)) : 0;
  const thresholdRatio = snapshot.effectiveCompressionRatio;
  const thresholdPct = thresholdRatio !== null ? thresholdRatio * 100 : null;
  const fillZone =
    clampedPct >= 95
      ? 'danger'
      : thresholdPct !== null && clampedPct >= thresholdPct
      ? 'warn'
      : clampedPct >= 85
      ? 'warn'
      : 'normal';

  const handleToggleBreakdown = (): void => {
    const next = !breakdownOpen;
    setBreakdownOpen(next);
    if (next && (!scope || scope.breakdown.status === 'idle' || scope.breakdown.status === 'error')) {
      actions.onLoadBreakdown();
    }
  };

  return (
    <div className="status-pod-window" data-testid="session-status-panel" data-mode={snapshot.conversationMode}>
      {/* 上区：Agent 头像与名称 + 可点击工作区目录 + 条件 Git 分支 */}
      <header className="sp-section status-zone status-zone--top">
        <div className="sp-env-row sp-env-row--agent" data-testid="status-agent-row">
          <span
            className="sp-agent-head-avatar"
            aria-hidden="true"
            dangerouslySetInnerHTML={{ __html: avatarHtml }}
          />
          <span className="sp-env-label sp-env-strong" title={subjectName}>
            {subjectName}
          </span>
          {!isGroupRoom && subject?.kind !== 'group' && actions.onOpenConstellation ? (
            <button
              type="button"
              className="sp-env-action"
              data-testid="status-open-constellation-btn"
              title={t('statusPod.openConstellation')}
              aria-label={t('statusPod.openConstellation')}
              onClick={() => actions.onOpenConstellation?.(subject?.profileName || 'default')}
            >
              <Network size={12} aria-hidden="true" />
              <span>{t('statusPod.openConstellation')}</span>
            </button>
          ) : null}
        </div>

        {scope?.cwd ? (
          <button
            type="button"
            className="sp-env-row sp-env-row--clickable status-env-btn"
            data-testid="status-cwd-btn"
            onClick={() => actions.onOpenFilesAtPath(scope.cwd)}
            title={t('statusPod.clickToOpenFiles')}
          >
            <span className="sp-env-icon" aria-hidden="true">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
              </svg>
            </span>
            <span className="sp-env-label sp-env-mono">{scope.cwd}</span>
          </button>
        ) : null}

        {!isGroupRoom && scope?.branch ? (
          <div className="sp-env-row" data-testid="status-branch-row">
            <span className="sp-env-icon" aria-hidden="true">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <line x1="6" y1="3" x2="6" y2="15" />
                <circle cx="18" cy="6" r="3" />
                <circle cx="6" cy="18" r="3" />
                <path d="M18 9a9 9 0 0 1-9 9" />
              </svg>
            </span>
            <span className="sp-env-label sp-env-mono" title={scope.branch}>
              {scope.branch}
            </span>
          </div>
        ) : null}

        {isGroupRoom && scope?.groupState ? (
          <div className="sp-env-row">
            <span className="sp-env-icon" aria-hidden="true">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
                <circle cx="9" cy="7" r="4" />
                <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
                <path d="M16 3.13a4 4 0 0 1 0 7.75" />
              </svg>
            </span>
            <span className="sp-env-label sp-env-mono">
              {t('statusPod.groupMemberSummary', { count: String(scope.groupState.memberCount) })}
              {scope.groupState.routing ? ` · ${scope.groupState.routing}` : ''}
            </span>
          </div>
        ) : null}
      </header>

      {/* 中区：单行子 Agent 列表或群聊成员活跃列表 */}
      <section
        className="sp-section sp-section--sub status-zone status-zone--middle"
        aria-label={isGroupRoom ? t('statusPod.groupMembersHeading') : t('statusPod.subagentsHeading')}
      >
        {isGroupRoom ? (
          <>
            <div className="sp-sub-head sp-sub-head--static">
              <div className="sp-sub-head-left">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
                  <circle cx="9" cy="7" r="4" />
                  <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
                  <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                </svg>
                <span>{t('statusPod.groupMembersHeading')}</span>
              </div>
              {scope?.groupState?.blocked ? (
                <span className="sp-sub-head-right">{t('statusPod.groupBlocked')}</span>
              ) : null}
            </div>
            {scope?.groupError ? <div className="status-inline-warn">{scope.groupError}</div> : null}
            {scope?.groupState?.memberActivity && scope.groupState.memberActivity.length > 0 ? (
              <div className="status-row-list">
                {scope.groupState.memberActivity.map((member) => {
                  const meta = groupActivityMeta(member.status);
                  const subtitle = member.tool
                    ? member.tool
                    : member.roundIndex !== null
                    ? t('statusPod.groupRound', { round: String(member.roundIndex) })
                    : undefined;
                  return (
                    <SubagentRow
                      key={member.memberId}
                      variant="room_member"
                      title={member.displayName}
                      statusLabel={meta.label}
                      tone={meta.tone}
                      subtitle={subtitle}
                    />
                  );
                })}
              </div>
            ) : (
              <div className="status-empty">{t('statusPod.groupMembersEmpty')}</div>
            )}
          </>
        ) : (
          <>
            <button
              type="button"
              className="sp-sub-head status-section-toggle"
              aria-expanded={subagentsExpanded}
              data-testid="status-subagents-toggle"
              onClick={() => setSubagentsExpanded((prev) => !prev)}
            >
              <div className="sp-sub-head-left">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <rect x="3" y="11" width="18" height="10" rx="2" />
                  <circle cx="12" cy="5" r="2" />
                  <path d="M12 7v4" />
                </svg>
                <span>{t('statusPod.subagentsHeading')}</span>
              </div>
              <div className="sp-sub-head-right">
                <svg
                  className="sp-sub-chevron"
                  data-collapsed={subagentsExpanded ? undefined : 'true'}
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  aria-hidden="true"
                >
                  <path d="M6 9l6 6 6-6" />
                </svg>
              </div>
            </button>

            {subagentsExpanded ? (
              <>
                {snapshot.listSyncError ? <div className="status-inline-warn">{snapshot.listSyncError}</div> : null}

                {active.length === 0 && terminal.length === 0 ? (
                  <div className="status-empty">{t('statusPod.subagentsEmpty')}</div>
                ) : (
                  <>
                    <div className="status-row-list">
                      {active.map((task) => {
                        const meta = statusMetaForLifecycle(task.lifecycleStatus);
                        const subtitle = task.currentActionText || task.lastTool || undefined;
                        return (
                          <SubagentRow
                            key={task.subagentId}
                            variant="active"
                            subagentId={task.subagentId}
                            title={task.goal || task.taskTitle || task.subagentId}
                            statusLabel={meta.label}
                            tone={meta.tone}
                            subtitle={subtitle}
                            interruptPending={Boolean(task.interruptPending)}
                            onInspect={() => actions.onOpenSubagent(task.subagentId)}
                            onInterrupt={
                              isSyntheticSubagentId(task.subagentId)
                                ? undefined
                                : () => actions.onInterruptSubagent(task.subagentId)
                            }
                          />
                        );
                      })}

                      {visibleTerminal.map((task) => {
                        const meta = statusMetaForLifecycle(task.lifecycleStatus);
                        const subtitle = task.error || task.summary || task.lastTool || undefined;
                        return (
                          <SubagentRow
                            key={task.subagentId}
                            variant="terminal"
                            subagentId={task.subagentId}
                            title={task.goal || task.taskTitle || task.subagentId}
                            statusLabel={meta.label}
                            tone={meta.tone}
                            subtitle={subtitle}
                            onInspect={() => actions.onOpenSubagent(task.subagentId)}
                          />
                        );
                      })}
                    </div>

                    {hasMoreTerminal ? (
                      <button
                        type="button"
                        className="sp-more-btn status-more-btn"
                        onClick={() => setShowAllTerminal((prev) => !prev)}
                        data-testid="status-toggle-more-terminal"
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                          <line x1="5" y1="12" x2="19" y2="12" />
                          {showAllTerminal ? null : <line x1="12" y1="5" x2="12" y2="19" />}
                        </svg>
                        <span>{showAllTerminal ? t('statusPod.collapseTerminal') : t('statusPod.showMoreTerminal')}</span>
                      </button>
                    ) : null}
                  </>
                )}
              </>
            ) : null}
          </>
        )}
      </section>

      {/* 下区（仅非群聊）：紧凑单行上下文条（点击展开构成明细） */}
      {!isGroupRoom ? (
        <footer className="sp-section sp-section--bottom status-zone status-zone--bottom" data-testid="status-usage-zone">
          {scope?.usageError ? <div className="status-inline-warn">{scope.usageError}</div> : null}

          {ctxUsed !== null && ctxMax !== null && ctxMax > 0 ? (
            <button
              type="button"
              className="sp-ctx-trigger"
              data-testid="status-context-trigger"
              aria-expanded={breakdownOpen}
              title={t('statusPod.clickToToggleBreakdown')}
              onClick={handleToggleBreakdown}
            >
              <span className="sp-ctx-label">
                {t('statusPod.contextWindow')}
              </span>

              <div className="sp-bar-wrap">
                <div className="sp-bar-track">
                  <div
                    className="sp-bar-fill"
                    data-threshold-zone={fillZone}
                    style={{ width: `${ctxUsed > 0 ? Math.max(clampedPct, 2) : 0}%` }}
                  />
                </div>
                {thresholdPct !== null ? (
                  <span
                    className="sp-bar-tick"
                    data-testid="status-compression-tick"
                    style={{ left: `${thresholdPct}%` }}
                    title={t('statusPod.thresholdLabel', { pct: String(Math.round(thresholdPct)) })}
                    aria-label={t('statusPod.thresholdLabel', { pct: String(Math.round(thresholdPct)) })}
                  />
                ) : null}
              </div>

              <span className="sp-ctx-nums" data-testid="status-context-readout">
                {formatTokenShort(ctxUsed)} / {formatTokenShort(ctxMax)}
              </span>
            </button>
          ) : (
            <div className="status-context-empty">{t('statusPod.contextUnavailable')}</div>
          )}

          {breakdownOpen && scope ? (
            <ContextBreakdownDrawer
              breakdown={scope.breakdown}
              effectiveCompressionRatio={thresholdRatio}
              onOpenFile={(filePath) => actions.onOpenFilesAtPath(filePath)}
            />
          ) : null}
        </footer>
      ) : null}
    </div>
  );
}
