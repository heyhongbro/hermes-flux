import * as React from 'react';
import { Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { t, type I18nKey } from '../../i18n/index.js';
import { Badge } from '../primitives/Badge.js';
import { Button } from '../primitives/Button.js';
import { Input } from '../primitives/Input.js';
import { Surface } from '../primitives/Surface.js';
import { Switch } from '../primitives/Switch.js';
import { SettingField, SettingInset, SettingTwoColumn } from './SettingRow.js';
import {
  isGatewayTestStale,
  type GatewayDraft,
  type GatewayInstanceDraft,
  type SettingsActions,
  type SettingsGatewayItem,
  type SettingsGatewayStatus,
  type SettingsSnapshot,
} from './settingsModel.js';

export interface GatewayFormBinding {
  draft: GatewayDraft;
  onDraftChange: (draft: GatewayDraft) => void;
  testedDraft: GatewayDraft | null;
  onTested: (draft: GatewayDraft) => void;
}

const GATEWAY_STATUS_META: Readonly<Record<SettingsGatewayStatus, { dotClass: string; labelKey: I18nKey }>> = {
  connected: { dotClass: 'bg-success', labelKey: 'settings.gatewayConnected' },
  connecting: { dotClass: 'bg-warning', labelKey: 'settings.gatewayConnecting' },
  offline: { dotClass: 'bg-destructive', labelKey: 'settings.gatewayDisconnected' },
  auth_error: { dotClass: 'bg-destructive', labelKey: 'settings.gatewayStatusAuthError' },
  disabled: { dotClass: 'bg-muted-foreground', labelKey: 'settings.gatewayStatusDisabled' },
};

interface InstanceEditorState {
  mode: 'add' | 'edit';
  editingId?: string;
  draft: GatewayInstanceDraft;
  hasStoredPassword?: boolean;
  saving: boolean;
  testing: boolean;
  testResult: { ok: boolean; message?: string; latency?: number } | null;
  testedFingerprint: string;
  error: string | null;
}

function editorFingerprint(draft: GatewayInstanceDraft): string {
  return JSON.stringify([draft.url.trim(), draft.username.trim(), draft.password, draft.profileName.trim()]);
}

function GatewayInstanceEditor({
  editor,
  onDraftChange,
  onCancel,
  onTest,
  onSave,
}: {
  editor: InstanceEditorState;
  onDraftChange: (patch: Partial<GatewayInstanceDraft>) => void;
  onCancel: () => void;
  onTest: () => void;
  onSave: () => void;
}): React.ReactElement {
  const { draft } = editor;
  const stale = editor.testResult !== null && editor.testedFingerprint !== editorFingerprint(draft);
  const busy = editor.saving || editor.testing;
  return (
    <Surface
      level="raised"
      padding="loose"
      bordered={false}
      specular={false}
      className="flex flex-col gap-4 rounded-panel"
      data-testid="gateway-editor-form"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-body font-medium text-foreground">
          {editor.mode === 'add' ? t('settings.gatewayAddTitle') : t('settings.gatewayEditTitle')}
        </span>
      </div>
      <div className="flex flex-col gap-3">
        <SettingField label={t('settings.gatewayNameLabel')} htmlFor="gateway-instance-name">
          <Input
            id="gateway-instance-name"
            data-testid="gateway-form-name"
            value={draft.name}
            disabled={busy}
            placeholder={t('settings.gatewayNamePlaceholder')}
            onChange={(event) => onDraftChange({ name: event.target.value })}
          />
        </SettingField>
        <SettingField label={t('settings.gatewayUrl')} htmlFor="gateway-instance-url">
          <Input
            id="gateway-instance-url"
            data-testid="gateway-form-url"
            value={draft.url}
            disabled={busy}
            placeholder={t('settings.gatewayUrlPlaceholder')}
            onChange={(event) => onDraftChange({ url: event.target.value })}
            className="font-code"
          />
        </SettingField>
        <SettingTwoColumn>
          <SettingField label={t('settings.gatewayUsername')} htmlFor="gateway-instance-username">
            <Input
              id="gateway-instance-username"
              data-testid="gateway-form-username"
              value={draft.username}
              disabled={busy}
              autoComplete="off"
              onChange={(event) => onDraftChange({ username: event.target.value })}
              className="font-code"
            />
          </SettingField>
          <SettingField label={t('settings.gatewayPassword')} htmlFor="gateway-instance-password">
            <Input
              id="gateway-instance-password"
              data-testid="gateway-form-password"
              type="password"
              value={draft.password}
              disabled={busy}
              autoComplete="new-password"
              placeholder={editor.hasStoredPassword ? t('settings.gatewayPasswordSaved') : undefined}
              onChange={(event) => onDraftChange({ password: event.target.value })}
              className="font-code"
            />
          </SettingField>
        </SettingTwoColumn>
        <SettingField label={t('settings.gatewayProfile')} htmlFor="gateway-instance-profile">
          <Input
            id="gateway-instance-profile"
            data-testid="gateway-form-profile"
            value={draft.profileName}
            disabled={busy}
            onChange={(event) => onDraftChange({ profileName: event.target.value })}
            className="font-code"
          />
        </SettingField>
      </div>

      {editor.testResult && !stale ? (
        <p className={`text-caption ${editor.testResult.ok ? 'text-success' : 'text-destructive'}`}>
          {editor.testResult.message || (editor.testResult.ok ? t('settings.testOk') : t('settings.testFailed'))}
        </p>
      ) : null}
      {editor.error ? <p className="text-caption text-destructive">{editor.error}</p> : null}

      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button type="button" variant="outline" size="sm" disabled={busy} data-testid="gateway-form-cancel" onClick={onCancel}>
          {t('settings.gatewayCancelBtn')}
        </Button>
        <Button type="button" variant="outline" size="sm" disabled={busy} data-testid="gateway-form-test" onClick={onTest}>
          {t('settings.testConnection')}
        </Button>
        <Button type="button" size="sm" disabled={busy} data-testid="gateway-form-save" onClick={onSave}>
          {t('settings.gatewaySaveBtn')}
        </Button>
      </div>
    </Surface>
  );
}

/**
 * 纯网关实例管理面板（支持单网关无缝兼容与多网关增删改查）。
 *
 * 【设计意图】严格只承载网关配置、启停与连通测试；不提供任何跨页跳转快捷链接。
 */
export function GatewaySettingsPanel({
  snapshot,
  actions,
  gateway,
}: {
  snapshot: SettingsSnapshot;
  actions: SettingsActions;
  gateway: GatewayFormBinding;
}): React.ReactElement {
  const gateways = snapshot.gateways ?? [];
  const isMultiGateway = gateways.length >= 2;

  const [editor, setEditor] = React.useState<InstanceEditorState | null>(null);
  const [confirmRemoveId, setConfirmRemoveId] = React.useState<string | null>(null);
  const [removingId, setRemovingId] = React.useState<string | null>(null);
  const [actionError, setActionError] = React.useState<string | null>(null);

  const openAddEditor = (): void => {
    setConfirmRemoveId(null);
    setActionError(null);
    setEditor({
      mode: 'add',
      draft: { name: '', url: '', username: '', password: '', profileName: 'default', enabled: true },
      saving: false,
      testing: false,
      testResult: null,
      testedFingerprint: '',
      error: null,
    });
  };

  const openEditEditor = (item: SettingsGatewayItem): void => {
    setConfirmRemoveId(null);
    setActionError(null);
    setEditor({
      mode: 'edit',
      editingId: item.id,
      hasStoredPassword: item.hasStoredPassword,
      draft: {
        id: item.id,
        name: item.name,
        url: item.url,
        username: item.username ?? '',
        password: '',
        profileName: item.profileName || 'default',
        enabled: item.enabled,
      },
      saving: false,
      testing: false,
      testResult: null,
      testedFingerprint: '',
      error: null,
    });
  };

  const handleTestEditor = async (): Promise<void> => {
    const current = editor;
    if (!current) return;
    if (!current.draft.url.trim()) {
      setEditor({ ...current, error: t('gateway.urlRequired') });
      return;
    }
    const fingerprint = editorFingerprint(current.draft);
    setEditor({ ...current, testing: true, error: null });
    if (actions.onTestGatewayInstance) {
      const res = await actions.onTestGatewayInstance(current.draft);
      setEditor((prev) =>
        prev
          ? {
              ...prev,
              testing: false,
              testedFingerprint: fingerprint,
              testResult: { ok: res.ok, message: res.message, latency: res.latency },
            }
          : null,
      );
      return;
    }
    gateway.onTested({
      url: current.draft.url,
      username: current.draft.username,
      password: current.draft.password,
      profileName: current.draft.profileName,
    });
    actions.onTestGateway({
      url: current.draft.url,
      username: current.draft.username,
      password: current.draft.password,
      profileName: current.draft.profileName,
    });
    setEditor((prev) => (prev ? { ...prev, testing: false } : null));
  };

  const handleSaveEditor = async (): Promise<void> => {
    const current = editor;
    if (!current) return;
    if (!current.draft.url.trim()) {
      setEditor({ ...current, error: t('gateway.urlRequired') });
      return;
    }
    setEditor({ ...current, saving: true, error: null });
    const submitFn =
      current.mode === 'add'
        ? actions.onAddGateway
        : actions.onUpdateGateway
          ? (draft: GatewayInstanceDraft) => actions.onUpdateGateway!(current.editingId!, draft)
          : undefined;
    const result = submitFn ? await submitFn(current.draft) : undefined;
    if (!result || result.ok) {
      setEditor(null);
      return;
    }
    setEditor((prev) =>
      prev ? { ...prev, saving: false, error: result.message || t('settings.saveFailed') } : null,
    );
  };

  const handleConfirmRemove = async (gatewayId: string, removeFn: NonNullable<SettingsActions['onRemoveGateway']>): Promise<void> => {
    setRemovingId(gatewayId);
    setActionError(null);
    const result = await removeFn(gatewayId);
    setRemovingId(null);
    if (result.ok) {
      setConfirmRemoveId(null);
    } else {
      setActionError(result.message || t('settings.saveFailed'));
    }
  };

  if (editor) {
    return (
      <div className="flex flex-col gap-5">
        <GatewayInstanceEditor
          editor={editor}
          onDraftChange={(patch) =>
            setEditor((prev) => (prev ? { ...prev, error: null, draft: { ...prev.draft, ...patch } } : null))
          }
          onCancel={() => setEditor(null)}
          onTest={() => {
            void handleTestEditor();
          }}
          onSave={() => {
            void handleSaveEditor();
          }}
        />
      </div>
    );
  }

  if (isMultiGateway) {
    const {
      onAddGateway,
      onToggleGatewayEnabled,
      onDisconnectGatewayInstance,
      onConnectGatewayInstance,
      onUpdateGateway,
      onRemoveGateway,
    } = actions;
    return (
      <div className="flex flex-col gap-5">
        <div className="flex items-center justify-between gap-3">
          <span className="text-caption text-muted-foreground">{t('settings.sectionGatewayDesc')}</span>
          {onAddGateway ? (
            <Button type="button" size="sm" variant="outline" data-testid="gateway-add-btn" onClick={openAddEditor}>
              <Plus size={13} aria-hidden="true" />
              {t('settings.gatewayAddBtn')}
            </Button>
          ) : null}
        </div>

        {actionError ? <p className="text-caption text-destructive">{actionError}</p> : null}

        <div className="flex flex-col gap-3" data-testid="gateway-list">
          {gateways.map((item) => {
            const meta = GATEWAY_STATUS_META[item.status];
            const confirming = confirmRemoveId === item.id;
            return (
              <Surface
                key={item.id}
                level="raised"
                padding="none"
                bordered={false}
                specular={false}
                className="flex flex-col gap-3 rounded-panel px-4 py-3"
                data-gateway-id={item.id}
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`size-2 shrink-0 rounded-full ${meta.dotClass}`} aria-hidden="true" />
                      <span className="truncate text-body font-medium text-foreground">{item.name}</span>
                      {item.isDefault ? <Badge variant="secondary">{t('settings.gatewayDefaultBadge')}</Badge> : null}
                      <span className="text-caption text-muted-foreground">{t(meta.labelKey)}</span>
                      {item.status === 'connected' && typeof item.latencyMs === 'number' ? (
                        <span className="font-code text-micro text-muted-foreground">{item.latencyMs}ms</span>
                      ) : null}
                    </div>
                    <span className="truncate font-code text-micro text-muted-foreground">{item.url}</span>
                    {item.error ? <span className="text-caption text-destructive">{item.error}</span> : null}
                  </div>

                  <div className="flex shrink-0 items-center gap-2">
                    {onToggleGatewayEnabled ? (
                      <Switch
                        checked={item.enabled}
                        aria-label={`${t('settings.gatewayEnabledLabel')} ${item.name}`}
                        data-testid={`gateway-enable-switch-${item.id}`}
                        onCheckedChange={(checked) => {
                          void onToggleGatewayEnabled(item.id, checked);
                        }}
                      />
                    ) : null}
                    {item.status === 'connected' && onDisconnectGatewayInstance ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        data-testid={`gateway-disconnect-btn-${item.id}`}
                        onClick={() => onDisconnectGatewayInstance(item.id)}
                      >
                        {t('settings.disconnect')}
                      </Button>
                    ) : item.enabled && onConnectGatewayInstance ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={item.status === 'connecting'}
                        data-testid={`gateway-connect-btn-${item.id}`}
                        onClick={() => {
                          void onConnectGatewayInstance(item.id);
                        }}
                      >
                        <RefreshCw size={12} aria-hidden="true" />
                        {item.status === 'offline' || item.status === 'auth_error'
                          ? t('settings.gatewayReconnectBtn')
                          : t('settings.gatewayConnectBtn')}
                      </Button>
                    ) : null}
                    {onUpdateGateway ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        aria-label={t('settings.gatewayEditBtn')}
                        data-testid={`gateway-edit-btn-${item.id}`}
                        onClick={() => openEditEditor(item)}
                      >
                        <Pencil size={13} aria-hidden="true" />
                      </Button>
                    ) : null}
                    {onRemoveGateway ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        aria-label={t('settings.gatewayRemoveBtn')}
                        data-testid={`gateway-remove-btn-${item.id}`}
                        disabled={removingId === item.id}
                        onClick={() => setConfirmRemoveId(confirming ? null : item.id)}
                      >
                        <Trash2 size={13} aria-hidden="true" />
                      </Button>
                    ) : null}
                  </div>
                </div>

                {confirming && onRemoveGateway ? (
                  <div
                    className="flex flex-wrap items-center justify-between gap-2 border-t border-border-subtle pt-3"
                    data-testid={`gateway-remove-confirm-${item.id}`}
                  >
                    <span className="text-caption text-destructive">
                      {t('settings.gatewayRemoveConfirm', { name: item.name })}
                    </span>
                    <div className="flex items-center gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={removingId === item.id}
                        onClick={() => setConfirmRemoveId(null)}
                      >
                        {t('settings.gatewayCancelBtn')}
                      </Button>
                      <Button
                        type="button"
                        variant="destructive"
                        size="sm"
                        disabled={removingId === item.id}
                        data-testid={`gateway-remove-confirm-btn-${item.id}`}
                        onClick={() => {
                          void handleConfirmRemove(item.id, onRemoveGateway);
                        }}
                      >
                        {t('settings.gatewayRemoveBtn')}
                      </Button>
                    </div>
                  </div>
                ) : null}
              </Surface>
            );
          })}
        </div>
      </div>
    );
  }

  const { draft, onDraftChange: setDraft, testedDraft } = gateway;
  const testStale = isGatewayTestStale(testedDraft, draft);
  const status = snapshot.gateway.status;
  const statusLabel =
    status === 'connected'
      ? t('settings.gatewayConnected')
      : status === 'connecting'
        ? t('settings.gatewayConnecting')
        : t('settings.gatewayDisconnected');
  const dotTone =
    status === 'connected' ? 'bg-success' : status === 'connecting' ? 'bg-warning' : 'bg-destructive';

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between gap-3 rounded-panel surface-raised px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className={`size-2 shrink-0 rounded-full ${dotTone}`} aria-hidden="true" />
          <span className="text-body text-foreground">{statusLabel}</span>
          {status === 'connected' ? (
            <span className="font-code text-caption text-muted-foreground">{snapshot.gateway.latencyMs}ms</span>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          {actions.onAddGateway ? (
            <Button variant="outline" size="sm" type="button" data-testid="gateway-add-btn" onClick={openAddEditor}>
              <Plus size={12} aria-hidden="true" />
              {t('settings.gatewayAddBtn')}
            </Button>
          ) : null}
          {status === 'connected' ? (
            <Button variant="outline" size="sm" type="button" onClick={actions.onDisconnectGateway}>
              {t('settings.disconnect')}
            </Button>
          ) : null}
        </div>
      </div>

      <SettingInset className="gap-3 py-4">
        <SettingField label={t('settings.gatewayUrl')} htmlFor="settings-gateway-url" anchorId="gateway-url">
          <Input
            id="settings-gateway-url"
            value={draft.url}
            placeholder={t('settings.gatewayUrlPlaceholder')}
            onChange={(event) => setDraft({ ...draft, url: event.target.value })}
            className="font-code"
          />
        </SettingField>
        <SettingTwoColumn>
          <SettingField label={t('settings.gatewayUsername')} htmlFor="settings-gateway-username" anchorId="gateway-username">
            <Input
              id="settings-gateway-username"
              value={draft.username}
              autoComplete="off"
              onChange={(event) => setDraft({ ...draft, username: event.target.value })}
              className="font-code"
            />
          </SettingField>
          <SettingField label={t('settings.gatewayPassword')} htmlFor="settings-gateway-password" anchorId="gateway-password">
            <Input
              id="settings-gateway-password"
              type="password"
              value={draft.password}
              autoComplete="new-password"
              placeholder={snapshot.gateway.hasStoredPassword ? t('settings.gatewayPasswordSaved') : undefined}
              onChange={(event) => setDraft({ ...draft, password: event.target.value })}
              className="font-code"
            />
          </SettingField>
        </SettingTwoColumn>
        <SettingField label={t('settings.gatewayProfile')} htmlFor="settings-gateway-profile" anchorId="gateway-profile">
          <Input
            id="settings-gateway-profile"
            value={draft.profileName}
            onChange={(event) => setDraft({ ...draft, profileName: event.target.value })}
            className="font-code"
          />
        </SettingField>
      </SettingInset>

      {snapshot.gateway.test && !testStale ? (
        <p className={`text-caption ${snapshot.gateway.test.ok ? 'text-success' : 'text-destructive'}`}>
          {snapshot.gateway.test.message || (snapshot.gateway.test.ok ? t('settings.testOk') : t('settings.testFailed'))}
        </p>
      ) : null}

      <div className="flex items-center justify-end gap-2">
        <Button
          variant="outline"
          type="button"
          data-testid="gateway-test-btn"
          disabled={snapshot.busy}
          onClick={() => {
            const normalized = { ...draft, profileName: draft.profileName.trim() || 'default' };
            gateway.onTested(normalized);
            actions.onTestGateway(normalized);
          }}
        >
          {t('settings.testConnection')}
        </Button>
        <Button
          type="button"
          data-testid="gateway-connect-btn"
          disabled={snapshot.busy}
          onClick={() => actions.onConnectGateway({ ...draft, profileName: draft.profileName.trim() || 'default' })}
        >
          {t('settings.saveAndConnect')}
        </Button>
      </div>
    </div>
  );
}
