/**
 * Hermes Flux 全局连接与同步状态胶囊（ConnectionStatusPill）
 *
 * 【设计意图 (Why)】
 *   统一呈现冷启动连接、断线自动重连、恢复后静默同步、完成确认与离线/鉴权失败态：
 *   1. 在桌面端与移动端会话舞台中，活跃重连/同步时临时顶替顶部 AgentPresence 槽位；
 *   2. 在移动端首页 / Bot Hub / 检查舱 / 设置等非舞台页，以悬浮微章形式锚定顶栏下方；
 *   3. 严格复用 `useMotionPresence` 与纯 CSS 物理动画，不引入任何 `infinite` 门禁违规。
 *
 * 【防范的历史坑 (Pitfall)】
 *   1. 禁止在本文件中出现连字符前缀的工具类命名切片（避免触发 `react-shell.test.mjs` Tailwind 扫描）；
 *   2. 退场动画期间 `phase` 会瞬间切回 `'connected'`，必须缓存最后一次可见态，避免退场帧闪烁错误文案；
 *   3. `useMotionPresence` 的 options 对象必须在模块顶层冻结常量化，否则每次渲染都会重建控制器。
 *
 * 【约束与规则 (Rules)】
 *   - 所有用户可见文案必须通过 `t('conn.*')` 获取；
 *   - 非舞台页或退出动画收尾时必须回调 `onMountedChange?.(false)` 归还 Presence 槽位；
 *   - 严禁使用 `as any` 或内联硬编码色值。
 */

import * as React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { GatewayConnectionPhase } from '@hermes-flux/core';
import { t } from '../i18n/index.js';
import { useMotionPresence, type UseMotionPresenceOptions } from '../motion/useMotionPresence.js';

export type ConnectionPillLayout = 'stage' | 'floating';

export interface ConnectionStatusPillProps {
  readonly phase: GatewayConnectionPhase;
  readonly attempt?: number;
  readonly isAuthError?: boolean;
  readonly layout: ConnectionPillLayout;
  readonly compact?: boolean;
  readonly onRetry?: () => void;
  readonly onOpenSettings?: () => void;
  readonly onMountedChange?: (mounted: boolean) => void;
}

interface VisiblePillSnapshot {
  readonly phase: Exclude<GatewayConnectionPhase, 'connected' | 'unconfigured'>;
  readonly attempt: number;
  readonly isAuthError: boolean;
}

const PILL_MOTION_OPTIONS: UseMotionPresenceOptions = {
  durationEnter: 120,
  durationExit: 200,
  triggerProperty: 'opacity',
};

function isPillBeatPaused(): boolean {
  if (typeof document !== 'undefined') {
    if (document.hidden) return true;
    const root = document.documentElement;
    if (
      root?.getAttribute('data-page-hidden') === 'true' ||
      root?.getAttribute('data-app-hidden') === 'true'
    ) {
      return true;
    }
  }
  if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
    return true;
  }
  return false;
}

function useConnectionBeat(active: boolean): number {
  const [beat, setBeat] = React.useState(0);
  React.useEffect(() => {
    if (!active) return;
    let timer: ReturnType<typeof setInterval> | null = null;
    const stopTimer = (): void => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };
    const syncTimer = (): void => {
      if (isPillBeatPaused()) {
        stopTimer();
        return;
      }
      if (timer === null) {
        timer = setInterval(() => {
          if (isPillBeatPaused()) {
            stopTimer();
            return;
          }
          setBeat((prev) => (prev + 1) % 4);
        }, 650);
      }
    };
    syncTimer();
    const doc = typeof document !== 'undefined' ? document : null;
    doc?.addEventListener?.('visibilitychange', syncTimer);
    return () => {
      doc?.removeEventListener?.('visibilitychange', syncTimer);
      stopTimer();
    };
  }, [active]);
  return beat;
}

function isVisibleConnectionPhase(
  phase: GatewayConnectionPhase,
): phase is VisiblePillSnapshot['phase'] {
  return (
    phase === 'connecting' ||
    phase === 'reconnecting' ||
    phase === 'syncing' ||
    phase === 'synced' ||
    phase === 'offline'
  );
}

function resolveStatusLabel(snapshot: VisiblePillSnapshot): string {
  switch (snapshot.phase) {
    case 'connecting':
      return t('conn.connecting');
    case 'reconnecting':
      return snapshot.attempt > 1
        ? t('conn.reconnectingAttempt', { count: snapshot.attempt })
        : t('conn.reconnecting');
    case 'syncing':
      return t('conn.syncing');
    case 'synced':
      return t('conn.synced');
    case 'offline':
      return snapshot.isAuthError ? t('conn.authError') : t('conn.offline');
  }
}

export const ConnectionStatusPill: React.FC<ConnectionStatusPillProps> = ({
  phase,
  attempt = 0,
  isAuthError = false,
  layout,
  compact = false,
  onRetry,
  onOpenSettings,
  onMountedChange,
}) => {
  const isVisible = isVisibleConnectionPhase(phase);
  const lastVisibleRef = React.useRef<VisiblePillSnapshot>({
    phase: isVisible ? phase : 'connecting',
    attempt,
    isAuthError,
  });

  if (isVisible) {
    lastVisibleRef.current = { phase, attempt, isAuthError };
  }

  const { isMounted, motionProps } = useMotionPresence(
    isVisible,
    PILL_MOTION_OPTIONS,
  );

  const onMountedChangeRef = React.useRef(onMountedChange);
  onMountedChangeRef.current = onMountedChange;

  React.useEffect(() => {
    onMountedChangeRef.current?.(isMounted);
  }, [isMounted]);

  React.useEffect(() => {
    return () => {
      onMountedChangeRef.current?.(false);
    };
  }, []);

  const display = lastVisibleRef.current;
  const beatActive =
    isMounted &&
    (display.phase === 'connecting' || display.phase === 'reconnecting' || display.phase === 'syncing');
  const beat = useConnectionBeat(beatActive);

  if (!isMounted) {
    return null;
  }

  const label = resolveStatusLabel(display);
  const showSettingsAction =
    display.phase === 'offline' && display.isAuthError && typeof onOpenSettings === 'function';
  const showRetryAction =
    !showSettingsAction &&
    typeof onRetry === 'function' &&
    (display.phase === 'offline' || (display.phase === 'reconnecting' && display.attempt >= 3));

  const className = [
    'conn-pill',
    `conn-pill--${layout}`,
    compact ? 'conn-pill--compact' : '',
    'm-no-swipe',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className={className}
      role="status"
      aria-live="polite"
      data-phase={display.phase}
      data-beat={String(beat)}
      data-layout={layout}
      data-compact={compact ? 'true' : 'false'}
      data-auth-error={display.isAuthError ? 'true' : 'false'}
      data-gesture-ignore="pan-x"
      {...motionProps}
    >
      <span className="conn-pill__indicator" aria-hidden="true">
        {display.phase === 'connecting' || display.phase === 'reconnecting' ? (
          <>
            <span className="conn-pill__ring" />
            <span className="conn-pill__dot" />
          </>
        ) : display.phase === 'syncing' ? (
          <span className="conn-pill__wave">
            <span className="conn-pill__bar" />
            <span className="conn-pill__bar" />
            <span className="conn-pill__bar" />
          </span>
        ) : display.phase === 'synced' ? (
          <span className="conn-pill__check">
            <svg viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="2.2 6.3 4.9 9 9.8 3.2" />
            </svg>
          </span>
        ) : (
          <span className="conn-pill__dot conn-pill__dot--static" />
        )}
      </span>
      <span className="conn-pill__label">{label}</span>
      {showSettingsAction ? (
        <button
          type="button"
          className="conn-pill__action m-no-swipe"
          data-gesture-ignore="pan-x"
          onClick={onOpenSettings}
        >
          {t('conn.settings')}
        </button>
      ) : null}
      {showRetryAction ? (
        <button
          type="button"
          className="conn-pill__action m-no-swipe"
          data-gesture-ignore="pan-x"
          onClick={onRetry}
        >
          {t('conn.retry')}
        </button>
      ) : null}
    </div>
  );
};

export interface ConnectionStatusPillHandle {
  update(): void;
  unmount(): void;
}

/**
 * 在独立 React Island 宿主节点挂载连接状态胶囊，供桌面端舞台直接同步。
 */
export function mountConnectionStatusPill(
  host: HTMLElement,
  getProps: () => ConnectionStatusPillProps,
  createRootFn: (container: Element | DocumentFragment) => Pick<Root, 'render' | 'unmount'> = createRoot,
): ConnectionStatusPillHandle {
  if (!host || !host.isConnected) {
    throw new Error('Connection status pill host must be connected before mounting');
  }
  const root = createRootFn(host);
  const renderCurrent = (): void => {
    root.render(React.createElement(ConnectionStatusPill, getProps()));
  };
  renderCurrent();
  return {
    update: renderCurrent,
    unmount: () => {
      root.unmount();
    },
  };
}
