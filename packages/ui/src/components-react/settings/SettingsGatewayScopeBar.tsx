import * as React from 'react';
import { Power, RefreshCw, Server, Settings2 } from 'lucide-react';
import { t, type I18nKey } from '../../i18n/index.js';
import { Button } from '../primitives/Button.js';
import { Select, type SelectOption } from '../primitives/Select.js';
import { Surface } from '../primitives/Surface.js';
import type { SettingsGatewayItem, SettingsGatewayStatus } from './settingsModel.js';

export interface SettingsGatewayScopeBarProps {
  gateways?: readonly SettingsGatewayItem[];
  selectedGatewayId?: string;
  onSelectGateway?: (gatewayId: string) => void;
  onConnectGateway?: (gatewayId: string) => Promise<void> | void;
  onToggleGatewayEnabled?: (gatewayId: string, enabled: boolean) => Promise<void> | void;
  onOpenGatewaySettings: () => void;
  /** BOT 管理主视图需要充满剩余高度以维持双栏独立滚动。 */
  fillHeight?: boolean;
  children: React.ReactNode;
}

const STATUS_META: Readonly<Record<SettingsGatewayStatus, { dotClass: string; labelKey: I18nKey }>> = {
  connected: { dotClass: 'bg-success', labelKey: 'settings.gatewayConnected' },
  connecting: { dotClass: 'bg-warning', labelKey: 'settings.gatewayConnecting' },
  offline: { dotClass: 'bg-destructive', labelKey: 'settings.gatewayDisconnected' },
  auth_error: { dotClass: 'bg-destructive', labelKey: 'settings.gatewayStatusAuthError' },
  disabled: { dotClass: 'bg-muted-foreground', labelKey: 'settings.gatewayStatusDisabled' },
};

function GatewayOptionContent({ gateway }: { gateway: SettingsGatewayItem }): React.ReactElement {
  const meta = STATUS_META[gateway.status];
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span className={`size-2 shrink-0 rounded-full ${meta.dotClass}`} aria-hidden="true" />
      <span className="truncate font-medium text-foreground">{gateway.name}</span>
      <span className="truncate font-code text-micro text-muted-foreground">{t(meta.labelKey)}</span>
    </span>
  );
}

/**
 * 网关作用域实例切换栏与离线/停用拦截守卫。
 *
 * 【设计意图】只在配置了 2 台以上网关时在作用域页面（项目 / 模型与提供方 / BOT / 扩展）
 * 顶部呈现下拉选择器，单网关用户保持零冗余视觉噪音；所选网关离线或停用时直接给出可恢复操作卡。
 */
export function SettingsGatewayScopeBar({
  gateways,
  selectedGatewayId,
  onSelectGateway,
  onConnectGateway,
  onToggleGatewayEnabled,
  onOpenGatewaySettings,
  fillHeight = false,
  children,
}: SettingsGatewayScopeBarProps): React.ReactElement {
  if (!gateways || gateways.length < 2) {
    return <>{children}</>;
  }

  const selected = gateways.find((gw) => gw.id === selectedGatewayId) ?? gateways[0];
  const byId = new Map<string, SettingsGatewayItem>(gateways.map((gw) => [gw.id, gw]));
  const options: SelectOption[] = gateways.map((gw) => ({
    value: gw.id,
    label: gw.name,
  }));

  const guardContent =
    selected.status === 'disabled' ? (
      <div className={fillHeight ? 'p-6' : ''} data-testid="settings-gateway-disabled-guard">
        <Surface level="raised" padding="loose" bordered={false} specular={false} className="flex flex-col gap-3 rounded-panel">
          <div className="flex items-start gap-3">
            <Power size={18} className="mt-1 shrink-0 text-muted-foreground" aria-hidden="true" />
            <div className="flex min-w-0 flex-col gap-1">
              <span className="text-body font-medium text-foreground">
                {t('settings.gatewayDisabledGuardTitle', { name: selected.name })}
              </span>
              <span className="text-caption text-muted-foreground">{t('settings.gatewayDisabledGuardDesc')}</span>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {onToggleGatewayEnabled ? (
              <Button
                type="button"
                size="sm"
                data-testid="settings-scope-enable-btn"
                onClick={() => {
                  void onToggleGatewayEnabled(selected.id, true);
                }}
              >
                {t('settings.gatewayEnableBtn')}
              </Button>
            ) : null}
            <Button type="button" variant="outline" size="sm" onClick={onOpenGatewaySettings}>
              <Settings2 size={13} aria-hidden="true" />
              {t('settings.gatewayOpenSettingsBtn')}
            </Button>
          </div>
        </Surface>
      </div>
    ) : selected.status !== 'connected' ? (
      <div className={fillHeight ? 'p-6' : ''} data-testid="settings-gateway-offline-guard">
        <Surface level="raised" padding="loose" bordered={false} specular={false} className="flex flex-col gap-3 rounded-panel">
          <div className="flex items-start gap-3">
            <Server size={18} className="mt-1 shrink-0 text-destructive" aria-hidden="true" />
            <div className="flex min-w-0 flex-col gap-1">
              <span className="text-body font-medium text-foreground">
                {t('settings.gatewayOfflineGuardTitle', { name: selected.name })}
              </span>
              <span className="text-caption text-muted-foreground">
                {selected.error || t('settings.gatewayOfflineGuardDesc')}
              </span>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {onConnectGateway ? (
              <Button
                type="button"
                size="sm"
                data-testid="settings-scope-reconnect-btn"
                disabled={selected.status === 'connecting'}
                onClick={() => {
                  void onConnectGateway(selected.id);
                }}
              >
                <RefreshCw size={13} aria-hidden="true" />
                {t('settings.gatewayReconnectBtn')}
              </Button>
            ) : null}
            <Button type="button" variant="outline" size="sm" onClick={onOpenGatewaySettings}>
              <Settings2 size={13} aria-hidden="true" />
              {t('settings.gatewayOpenSettingsBtn')}
            </Button>
          </div>
        </Surface>
      </div>
    ) : null;

  return (
    <div className={fillHeight ? 'flex h-full min-h-0 flex-col' : 'flex flex-col gap-4'}>
      <div
        data-testid="settings-gateway-scope-bar"
        className={`flex flex-wrap items-center justify-between gap-3 ${
          fillHeight ? 'border-b border-border-subtle px-6 py-3 shrink-0' : 'rounded-panel surface-raised px-4 py-3'
        }`}
      >
        <div className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 text-caption font-medium text-muted-foreground">
            {t('settings.gatewayScopeLabel')}
          </span>
          <Select
            id="settings-gateway-scope-select"
            data-testid="settings-gateway-select"
            size="sm"
            className="min-w-48 max-w-80"
            contentClassName="w-80"
            ariaLabel={t('settings.gatewayScopeLabel')}
            value={selected.id}
            disabled={!onSelectGateway}
            groups={[{ label: '', options }]}
            onChange={(nextId) => onSelectGateway?.(nextId)}
            renderValue={(val) => {
              const gw = byId.get(val) ?? selected;
              return <GatewayOptionContent gateway={gw} />;
            }}
            renderOption={(option) => {
              const gw = byId.get(option.value);
              return gw ? <GatewayOptionContent gateway={gw} /> : <span>{option.label}</span>;
            }}
          />
        </div>
        <span className="truncate font-code text-micro text-muted-foreground">{selected.url}</span>
      </div>

      {guardContent ?? (fillHeight ? <div className="flex-1 min-h-0">{children}</div> : children)}
    </div>
  );
}
