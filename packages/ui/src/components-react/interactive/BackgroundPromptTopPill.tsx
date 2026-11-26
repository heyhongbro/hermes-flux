/**
 * 后台会话等待处理顶部提醒胶囊 (BackgroundPromptTopPill)
 *
 * 【设计意图 (Why)】
 *   用户正在查看或操作会话 A 时，会话 B、某个专职 Bot 工位或群聊研讨室正因等待回答、
 *   审批、密钥或授权而被挂起。顶部居中浮出一枚轻量克制的哑光提醒胶囊，点击直接跳转对应会话
 *   并自动展开贴舱停靠卡，拒绝强行抢焦或打断弹窗。
 *
 * 【约束与规则 (Rules)】
 *   - 零 pop-up 弹窗；零 infinite 动画；
 *   - 全部使用 `t()` 与语义 Design Tokens / `.flux-interact__top-pill` / `.m-stage__top-pill`。
 */

import * as React from 'react';
import { ArrowRight } from 'lucide-react';
import type { BackgroundWaitingSummary } from '@hermes-flux/core';
import { t } from '../../i18n/index.js';
import { Button } from '../primitives/Button.js';
import { resolveWaitingStatusKey } from './interactiveModel.js';

export interface BackgroundPromptTopPillProps {
  surface: 'desktop' | 'mobile';
  summaries: readonly BackgroundWaitingSummary[];
  resolveEntityLabel: (summary: BackgroundWaitingSummary) => string;
  onSelectSummary: (summary: BackgroundWaitingSummary) => void;
}

export function BackgroundPromptTopPill({
  surface,
  summaries,
  resolveEntityLabel,
  onSelectSummary,
}: BackgroundPromptTopPillProps): React.ReactElement | null {
  if (summaries.length === 0) return null;

  const primary = summaries[0];
  const totalPrompts = summaries.reduce((acc, item) => acc + item.promptCount, 0);
  const entityLabel = resolveEntityLabel(primary) || primary.entityId;
  const reasonText = t(resolveWaitingStatusKey(primary.waitingReason, surface === 'mobile' ? 'mobile' : 'rail'));

  const message =
    totalPrompts > 1 || summaries.length > 1
      ? t('interactive.bgWaitingMulti', {
          entity: entityLabel,
          reason: reasonText,
          count: String(totalPrompts),
        })
      : t('interactive.bgWaitingSingle', {
          entity: entityLabel,
          reason: reasonText,
        });

  if (surface === 'mobile') {
    return (
      <button
        type="button"
        className="m-stage__top-pill m-no-swipe"
        data-testid="interactive-background-top-pill"
        data-waiting-count={totalPrompts}
        onClick={() => onSelectSummary(primary)}
      >
        <span className="flux-interact__status-dot" aria-hidden="true" />
        <span className="m-stage__top-pill-text">{message}</span>
        <span className="m-stage__top-pill-cta">
          {t('interactive.jumpToWaiting')}
          <ArrowRight size={13} aria-hidden="true" />
        </span>
      </button>
    );
  }

  return (
    <Button
      type="button"
      variant="secondary"
      size="xs"
      className="flux-interact__top-pill rounded-full shadow-card"
      data-testid="interactive-background-top-pill"
      data-waiting-count={totalPrompts}
      onClick={() => onSelectSummary(primary)}
    >
      <span className="flux-interact__status-dot" aria-hidden="true" />
      <span className="flux-interact__top-pill-text">{message}</span>
      <span className="flux-interact__top-pill-cta">
        {t('interactive.jumpToWaiting')}
        <ArrowRight size={12} aria-hidden="true" />
      </span>
    </Button>
  );
}
