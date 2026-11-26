/**
 * MCP 重载确认与 OAuth 就地内联面板 (McpOAuthInlinePanel)
 *
 * 【设计意图 (Why)】
 *   在设置中心 ExtensionsPanel 内以纯哑光就地展开面板承载 `reload.mcp` 二次确认与
 *   `mcp.servers.oauth.*` 浏览器授权轮询，杜绝模态遮罩阻断设置上下文；同时将事件辅助函数与
 *   轮询清理逻辑抽离至此文件，使 `SettingsModal.tsx` 保持轻量且严格可控（≤ 1500 行）。
 *
 * 【约束与规则 (Rules)】
 *   1. 禁止渲染 `role="dialog"` 弹窗，全部就地渲染；
 *   2. 外部 URL 打开前强制经过 `isSafeExternalUrl` 校验；
 *   3. 所有文案通过 `t()` 与语义 Design Tokens 渲染。
 */

import * as React from 'react';
import { ExternalLink, KeyRound, ShieldAlert } from 'lucide-react';
import { t } from '../../i18n/index.js';
import { isSafeExternalUrl } from '../interactive/interactiveModel.js';
import { Badge } from '../primitives/Badge.js';
import { Button } from '../primitives/Button.js';
import { Surface } from '../primitives/Surface.js';
import type { SettingsActions } from './settingsModel.js';

export interface McpReloadConfirmState {
  message: string;
  rev?: string | null;
}

export interface McpOauthFlowView {
  name: string;
  sessionId: string;
  authUrl?: string;
  status: 'pending' | 'approved' | 'error';
  message?: string;
}

export interface McpOauthInlineState {
  busy: boolean;
  reloadConfirm: McpReloadConfirmState | null;
  oauth: McpOauthFlowView | null;
}

export async function triggerMcpReload(input: {
  actions: SettingsActions;
  setState: React.Dispatch<React.SetStateAction<McpOauthInlineState>>;
  confirm?: boolean;
  always?: boolean;
  rev?: string | null;
}): Promise<void> {
  if (!input.actions.onReloadMcp) return;
  input.setState((prev) => ({ ...prev, busy: true }));
  try {
    const res = await input.actions.onReloadMcp({
      confirm: input.confirm,
      always: input.always,
      rev: input.rev,
    });
    if (res.confirmRequired) {
      input.setState((prev) => ({
        ...prev,
        busy: false,
        reloadConfirm: {
          message: res.message || t('interactive.confirm.reloadMcpMessage'),
          rev: res.rev ?? null,
        },
      }));
      return;
    }
    input.setState((prev) => ({ ...prev, busy: false, reloadConfirm: null }));
    if (!res.ok && res.message) {
      input.actions.onNotify(res.message);
    }
  } finally {
    input.setState((prev) => (prev.busy ? { ...prev, busy: false } : prev));
  }
}

export async function startMcpOauthFlow(input: {
  profile: string;
  name: string;
  actions: SettingsActions;
  setState: React.Dispatch<React.SetStateAction<McpOauthInlineState>>;
}): Promise<void> {
  if (!input.actions.onStartMcpOAuth) return;
  input.setState((prev) => ({ ...prev, busy: true }));
  try {
    const res = await input.actions.onStartMcpOAuth(input.profile, input.name);
    if (!res.ok || !res.sessionId) {
      input.setState((prev) => ({
        ...prev,
        busy: false,
        oauth: {
          name: input.name,
          sessionId: '',
          status: 'error',
          message: res.message || t('settings.loadFailed'),
        },
      }));
      return;
    }
    input.setState((prev) => ({
      ...prev,
      busy: false,
      oauth: {
        name: input.name,
        sessionId: res.sessionId!,
        authUrl: res.authUrl,
        status: 'pending',
      },
    }));
  } finally {
    input.setState((prev) => (prev.busy ? { ...prev, busy: false } : prev));
  }
}

export function McpOAuthInlinePanel({
  profile,
  actions,
  state,
  setState,
}: {
  profile: string;
  actions: SettingsActions;
  state: McpOauthInlineState;
  setState: React.Dispatch<React.SetStateAction<McpOauthInlineState>>;
}): React.ReactElement | null {
  const oauthSessionId = state.oauth?.sessionId ?? '';
  const oauthName = state.oauth?.name ?? '';
  const oauthStatus = state.oauth?.status;

  React.useEffect(() => {
    if (!oauthSessionId || !oauthName || oauthStatus !== 'pending' || !actions.onPollMcpOAuth) {
      return;
    }
    let cancelled = false;
    const pollOnce = async (): Promise<void> => {
      try {
        const res = await actions.onPollMcpOAuth!(profile, oauthName, oauthSessionId);
        if (cancelled) return;
        if (res.status !== 'pending') {
          setState((prev) => {
            if (!prev.oauth || prev.oauth.sessionId !== oauthSessionId) return prev;
            return {
              ...prev,
              oauth: {
                ...prev.oauth,
                status: res.status,
                message: res.message,
              },
            };
          });
        }
      } catch (err) {
        if (cancelled) return;
        setState((prev) => {
          if (!prev.oauth || prev.oauth.sessionId !== oauthSessionId) return prev;
          return {
            ...prev,
            oauth: {
              ...prev.oauth,
              status: 'error',
              message: err instanceof Error ? err.message : String(err),
            },
          };
        });
      }
    };
    const timer = setInterval(() => {
      void pollOnce();
    }, 2000);
    if (typeof (timer as { unref?: () => void }).unref === 'function') {
      (timer as { unref: () => void }).unref();
    }
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [profile, oauthSessionId, oauthName, oauthStatus, actions.onPollMcpOAuth, setState]);

  if (!state.reloadConfirm && !state.oauth) return null;

  return (
    <div className="flex flex-col gap-3" data-testid="settings-mcp-inline-panel">
      {state.reloadConfirm ? (
        <Surface
          level="raised"
          padding="normal"
          specular={false}
          className="flex flex-col gap-2"
          data-testid="settings-mcp-reload-confirm"
        >
          <div className="flex items-center gap-2 text-caption font-medium text-warning">
            <ShieldAlert size={14} aria-hidden="true" />
            <span>{t('interactive.confirm.reloadMcpTitle')}</span>
          </div>
          <p className="m-0 text-aux text-foreground">{state.reloadConfirm.message}</p>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              disabled={state.busy}
              onClick={() => {
                void triggerMcpReload({
                  actions,
                  setState,
                  confirm: true,
                  rev: state.reloadConfirm?.rev,
                });
              }}
            >
              {t('interactive.confirm.confirmBtn')}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={state.busy}
              onClick={() => {
                void triggerMcpReload({
                  actions,
                  setState,
                  confirm: true,
                  always: true,
                  rev: state.reloadConfirm?.rev,
                });
              }}
            >
              {t('interactive.confirm.confirmAlwaysBtn')}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={state.busy}
              onClick={() => setState((prev) => ({ ...prev, reloadConfirm: null }))}
            >
              {t('interactive.confirm.cancelBtn')}
            </Button>
          </div>
        </Surface>
      ) : null}

      {state.oauth ? (
        <Surface
          level="raised"
          padding="normal"
          specular={false}
          className="flex flex-col gap-2"
          data-testid="settings-mcp-oauth-panel"
        >
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <KeyRound size={14} className="text-warning" aria-hidden="true" />
              <span className="text-caption font-medium text-foreground">{state.oauth.name}</span>
            </div>
            <Badge
              variant={
                state.oauth.status === 'approved'
                  ? 'secondary'
                  : state.oauth.status === 'error'
                    ? 'destructive'
                    : 'outline'
              }
            >
              {state.oauth.status === 'approved'
                ? t('interactive.mcp.oauthApproved')
                : state.oauth.status === 'error'
                  ? t('interactive.connection.stateFailed')
                  : t('interactive.mcp.oauthPolling')}
            </Badge>
          </div>

          {state.oauth.status === 'pending' ? (
            <p className="m-0 text-aux text-muted-foreground">{t('interactive.mcp.oauthPolling')}</p>
          ) : null}

          {state.oauth.message ? (
            <p className="m-0 text-aux text-destructive">{state.oauth.message}</p>
          ) : null}

          <div className="flex flex-wrap items-center gap-2">
            {state.oauth.authUrl && isSafeExternalUrl(state.oauth.authUrl) ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  const target = state.oauth?.authUrl;
                  if (!target || !isSafeExternalUrl(target)) return;
                  if (actions.onOpenExternalUrl) {
                    actions.onOpenExternalUrl(target);
                  } else if (typeof window !== 'undefined' && typeof window.open === 'function') {
                    window.open(target, '_blank', 'noopener,noreferrer');
                  }
                }}
              >
                <ExternalLink size={12} aria-hidden="true" />
                {t('interactive.mcp.oauthOpenUrl')}
              </Button>
            ) : null}

            {state.oauth.status === 'pending' && actions.onCancelMcpOAuth && state.oauth.sessionId ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => {
                  const sid = state.oauth?.sessionId;
                  const mcpName = state.oauth?.name;
                  if (!sid || !mcpName) return;
                  void actions.onCancelMcpOAuth?.(profile, mcpName, sid);
                  setState((prev) => ({ ...prev, oauth: null }));
                }}
              >
                {t('interactive.mcp.oauthCancel')}
              </Button>
            ) : (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setState((prev) => ({ ...prev, oauth: null }))}
              >
                {t('interactive.confirm.cancelBtn')}
              </Button>
            )}
          </div>
        </Surface>
      ) : null}
    </div>
  );
}
