/**
 * 顶栏聚合健康状态浮层 (L4 Popover · GatewayHealthPopover)
 *
 * 【设计意图 (Why)】
 *   顶栏右簇严格只展示 1 枚无数字无文字的健康圆点；点击该开关时，由此 L4 Popover
 *   展开所有已配置网关的名称、链路类型、毫秒延迟 / 重试状态、单节点重连/断开操作
 *   以及「管理网关」入口，避免顶栏文字堆叠与视觉噪音。
 *
 * 【防范的历史坑 (Pitfall)】
 *   1. Electron 无边框窗口顶栏处于 `-webkit-app-region: drag` 上下文，浮层容器必须声明
 *      `WebkitAppRegion: 'no-drag'` 否则内部按钮无法命中点击；
 *   2. 严格复用 `Button` 原语与语义 Token，严禁覆盖 Button 字号/高度或使用硬编码色值；
 *   3. 所有文本严格走 `t('gateway.*')`，禁止在组件中出现中文或测试用未注册类名。
 *
 * 【约束与规则 (Rules)】
 *   - 挂载 `data-flux-island=""` 启用 React 岛控件基线复位；
 *   - 支持 Escape 键与外部点击关闭，不泄漏 document 监听。
 */

import * as React from 'react';
import type { GatewayRouteKind, TitlebarConnectionStatus } from '@hermes-flux/core';
import { t, type I18nKey } from '../i18n/index.js';
import { Button } from './primitives/Button.js';

export interface TitlebarGatewayHealthItem {
  readonly gatewayId: string;
  readonly name: string;
  readonly shortLabel?: string;
  readonly status: TitlebarConnectionStatus;
  readonly connected: boolean;
  readonly latencyMs?: number;
  readonly routeKind?: GatewayRouteKind;
  readonly reconnectAttempt?: number;
  readonly authError?: boolean;
  readonly reason?: string;
}

export interface GatewayHealthPopoverProps {
  readonly gateways: readonly TitlebarGatewayHealthItem[];
  readonly onReconnectGateway?: (gatewayId: string) => void;
  readonly onDisconnectGateway?: (gatewayId: string) => void;
  readonly onManageGateways?: () => void;
  readonly onClose: () => void;
}

const ROUTE_LABEL_KEYS: Readonly<Record<GatewayRouteKind, I18nKey>> = {
  direct: 'gateway.routeDirect',
  lan: 'gateway.routeLan',
  relay: 'gateway.routeRelay',
};

/** 将底层链路枚举转换为本地化短文案，未知值透传原样避免空标签。 */
export function formatGatewayRouteLabel(routeKind?: string): string {
  if (!routeKind) return '';
  if (routeKind === 'direct' || routeKind === 'lan' || routeKind === 'relay') {
    return t(ROUTE_LABEL_KEYS[routeKind]);
  }
  return routeKind;
}

/** 依据单节点状态映射圆点语义背景类。 */
export function resolveGatewayDotToneClass(status: TitlebarConnectionStatus): string {
  if (status === 'connected') return 'bg-success';
  if (status === 'syncing') return 'bg-primary';
  if (status === 'reconnecting' || status === 'partial') return 'bg-warning';
  return 'bg-muted-foreground';
}

/** 派生单节点副行元数据（链路类型 + 延迟 / 重试 / 离线）。 */
export function formatGatewayHealthMeta(item: TitlebarGatewayHealthItem): string {
  const routeText = formatGatewayRouteLabel(item.routeKind || 'direct');
  if (item.connected) {
    if (typeof item.latencyMs === 'number' && Number.isFinite(item.latencyMs) && item.latencyMs > 0) {
      return `${routeText} · ${Math.round(item.latencyMs)}ms`;
    }
    return `${routeText} · ${t('titlebar.online')}`;
  }
  if (item.authError) {
    return `${routeText} · ${t('conn.authError')}`;
  }
  if (item.status === 'reconnecting' || (item.reconnectAttempt ?? 0) > 0) {
    return `${routeText} · ${t('conn.reconnectingAttempt', { count: item.reconnectAttempt || 1 })}`;
  }
  return `${routeText} · ${t('titlebar.offline')}`;
}

export function GatewayHealthPopover({
  gateways,
  onReconnectGateway,
  onDisconnectGateway,
  onManageGateways,
  onClose,
}: GatewayHealthPopoverProps): React.ReactElement {
  React.useEffect(() => {
    if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onClose();
        const trigger = document.getElementById('titlebar-gateway-health-btn');
        if (trigger && typeof trigger.focus === 'function') {
          trigger.focus();
        }
      }
    };
    const handlePointerDown = (event: Event): void => {
      const target = event.target as { closest?: (sel: string) => unknown } | null;
      if (target?.closest?.('[data-testid="gateway-health-popover"], #titlebar-gateway-health-btn')) {
        return;
      }
      onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('pointerdown', handlePointerDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('pointerdown', handlePointerDown);
    };
  }, [onClose]);

  return (
    <div
      data-flux-island=""
      data-testid="gateway-health-popover"
      role="dialog"
      aria-label={t('gateway.healthTitle')}
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      className="z-menu absolute right-0 top-full mt-1 w-64"
    >
      <div className="overflow-hidden rounded-panel border border-border-subtle bg-popover specular-top p-2 text-foreground shadow-window">
        <div className="px-2 py-1 text-caption font-semibold text-muted-foreground">
          {t('gateway.healthTitle')}
        </div>

        {gateways.length === 0 ? (
          <div className="px-2 py-2 text-aux text-muted-foreground">{t('gateway.emptyList')}</div>
        ) : (
          <div className="scrollbar-thin flex max-h-72 flex-col gap-1 overflow-y-auto">
            {gateways.map((item) => {
              const dotClass = resolveGatewayDotToneClass(item.status);
              const metaLine = formatGatewayHealthMeta(item);
              return (
                <div
                  key={item.gatewayId}
                  data-gateway-health-row={item.gatewayId}
                  className="flex items-center justify-between gap-2 rounded-card px-2 py-1 hover:bg-card-hover"
                >
                  <div className="flex min-w-0 flex-1 items-center gap-2">
                    <span className={`size-2 shrink-0 rounded-full ${dotClass}`} aria-hidden="true" />
                    <div className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-aux font-medium text-foreground">
                        {item.shortLabel || item.name}
                      </span>
                      <span className="truncate font-code text-caption text-muted-foreground tabular-nums">
                        {metaLine}
                      </span>
                    </div>
                  </div>
                  {item.connected
                    ? onDisconnectGateway && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="xs"
                          data-testid={`gw-health-action-${item.gatewayId}`}
                          onClick={() => onDisconnectGateway(item.gatewayId)}
                        >
                          {t('gateway.disconnect')}
                        </Button>
                      )
                    : onReconnectGateway && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="xs"
                          data-testid={`gw-health-action-${item.gatewayId}`}
                          onClick={() => onReconnectGateway(item.gatewayId)}
                        >
                          {t('gateway.reconnect')}
                        </Button>
                      )}
                </div>
              );
            })}
          </div>
        )}

        {onManageGateways ? (
          <div className="mt-1 border-t border-border-subtle pt-1">
            <Button
              type="button"
              variant="ghost"
              size="xs"
              data-testid="gw-health-manage-btn"
              className="w-full justify-start text-muted-foreground hover:text-foreground"
              onClick={() => {
                onClose();
                onManageGateways();
              }}
            >
              {t('gateway.manageGateways')}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
