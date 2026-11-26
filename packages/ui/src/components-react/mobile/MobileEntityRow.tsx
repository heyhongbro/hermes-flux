/**
 * 移动端统一会话/群聊/智能体列表行组件 (MobileEntityRow)
 *
 * 【设计意图 (Why)】
 *   严格遵守 UI 高度抽象与组件复用铁律：首屏智能体、群聊与普通会话全部共用单一列表行原语，
 *   确保高度、内边距、头像槽位、`prolate-lattice` 状态指示器与时间列排版 100% 一致。
 *   普通会话强制传入归属 Bot 头像（由 `mobileShellModel` 解析），群聊传入成员拼贴头像。
 *
 * 【约束与规则 (Rules)】
 *   - 无底部分割线、静息态纯平无背景框与发光边；
 *   - 右侧状态动画固定复用 `ActivityIndicator variant="prolate-lattice"`，运行态紧随状态文案。
 */

import * as React from 'react';
import { ActivityIndicator, type ActivityEntityKind } from '../primitives/ActivityIndicator.js';
import type { ActivityState, ActivityTransition, WaitingPromptReason } from '../leftRailModel.js';

export interface MobileEntityRowProps {
  kind: ActivityEntityKind;
  entityId: string;
  title: string;
  subtitle?: string;
  timeText?: string;
  avatarHtml: string;
  isActive: boolean;
  isPinned?: boolean;
  activityState: ActivityState;
  waitingReason?: WaitingPromptReason;
  activityTransition: ActivityTransition;
  activityTransitionToken?: number;
  onSelect: () => void;
  onLongPress?: () => void;
}

const LONG_PRESS_MS = 480;
const MOVE_CANCEL_PX = 8;

export const MobileEntityRow = React.memo(function MobileEntityRow({
  kind,
  entityId,
  title,
  subtitle,
  timeText,
  avatarHtml,
  isActive,
  isPinned,
  activityState,
  waitingReason,
  activityTransition,
  activityTransitionToken,
  onSelect,
  onLongPress,
}: MobileEntityRowProps): React.ReactElement {
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const startPosRef = React.useRef<{ x: number; y: number } | null>(null);
  const longPressedRef = React.useRef(false);

  const clearTimer = React.useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  React.useEffect(() => clearTimer, [clearTimer]);

  const handlePointerDown = (event: React.PointerEvent<HTMLButtonElement>): void => {
    if (!onLongPress) return;
    longPressedRef.current = false;
    startPosRef.current = { x: event.clientX, y: event.clientY };
    clearTimer();
    timerRef.current = setTimeout(() => {
      longPressedRef.current = true;
      timerRef.current = null;
      onLongPress();
    }, LONG_PRESS_MS);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLButtonElement>): void => {
    const start = startPosRef.current;
    if (!start || timerRef.current === null) return;
    const dx = Math.abs(event.clientX - start.x);
    const dy = Math.abs(event.clientY - start.y);
    if (dx > MOVE_CANCEL_PX || dy > MOVE_CANCEL_PX) {
      clearTimer();
    }
  };

  const handleClick = (): void => {
    if (longPressedRef.current) {
      longPressedRef.current = false;
      return;
    }
    onSelect();
  };

  const handleContextMenu = (event: React.MouseEvent<HTMLButtonElement>): void => {
    if (!onLongPress) return;
    event.preventDefault();
    clearTimer();
    onLongPress();
  };

  return (
    <button
      type="button"
      className="m-entity-row"
      data-kind={kind}
      data-entity-id={entityId}
      data-active={isActive ? 'true' : 'false'}
      data-pinned={isPinned ? 'true' : 'false'}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={clearTimer}
      onPointerCancel={clearTimer}
      onContextMenu={handleContextMenu}
      onClick={handleClick}
    >
      <span
        className="m-entity-row__avatar"
        aria-hidden="true"
        dangerouslySetInnerHTML={{ __html: avatarHtml }}
      />
      <span className="m-entity-row__body">
        <span className="m-entity-row__top">
          <span className="m-entity-row__title">{title}</span>
          <span className="m-entity-row__right">
            <ActivityIndicator
              state={activityState}
              waitingReason={waitingReason}
              transition={activityTransition}
              transitionToken={activityTransitionToken}
              placement="inline"
              entityKind={kind}
              variant="prolate-lattice"
              className="m-entity-row__indicator"
            />
            {timeText ? <time className="m-entity-row__time">{timeText}</time> : null}
          </span>
        </span>
        {subtitle ? <span className="m-entity-row__subtitle">{subtitle}</span> : null}
      </span>
    </button>
  );
});
