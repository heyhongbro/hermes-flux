/**
 * 外部连接与能力授权停靠卡片 (ConnectionPromptCard)
 *
 * 【设计意图 (Why)】
 *   承接 `connection.request` / `connection.update` / `pending_connection` 多目标授权流程：
 *   展示扫描结论 (`scan`)、MCP 启动 preview (`launch`)、`required_env` 密钥表单、
 *   安全外链 OAuth 授权跳转 + 复制 + 手动/自动唤醒 (`connectors.operation.wake`)，
 *   并在 `connection.respond` 返回 `settled: false` 时继续停靠等待所有目标收敛。
 *
 * 【约束与规则 (Rules)】
 *   - 严禁 infinite CSS 动画（使用静态状态徽标）；
 *   - 仅放行 `http:` / `https:` 安全外链；
 *   - `required_env` 中的 `secret: true` 值不写死也不留存在草稿中，仅在内存中填写并提交。
 */

import * as React from 'react';
import { Check, Copy, ExternalLink, RefreshCw, ShieldAlert, ShieldCheck } from 'lucide-react';
import type {
  ConnectionOperationTarget,
  ConnectionPrompt,
  ConnectionTargetState,
  InteractiveReplyPayload,
} from '@hermes-flux/core';
import { t, type I18nKey } from '../../i18n/index.js';
import { Badge } from '../primitives/Badge.js';
import { Button } from '../primitives/Button.js';
import { Input } from '../primitives/Input.js';
import { areRequiredConnectionEnvFilled, isSafeExternalUrl } from './interactiveModel.js';
import { CodePreviewBox, PromptCardFrame, type DockSurfaceMode } from './PromptCardFrame.js';

export interface ConnectionPromptCardProps {
  surface: DockSurfaceMode;
  prompt: ConnectionPrompt;
  queueIndex: number;
  queueLength: number;
  collapsed: boolean;
  submitting: boolean;
  localError: string | null;
  onToggleCollapse: () => void;
  onSelectQueueIndex?: (idx: number) => void;
  onSubmit: (payload: InteractiveReplyPayload) => Promise<boolean | void>;
  onOpenExternalUrl?: (url: string) => void;
  onWakeConnection?: (prompt: ConnectionPrompt) => Promise<void>;
}

function targetStateKey(state: ConnectionTargetState): I18nKey {
  switch (state) {
    case 'initiated':
      return 'interactive.connection.stateInitiated';
    case 'connected':
      return 'interactive.connection.stateConnected';
    case 'skipped':
      return 'interactive.connection.stateSkipped';
    case 'failed':
      return 'interactive.connection.stateFailed';
    case 'expired':
      return 'interactive.connection.stateExpired';
    case 'not_connected':
      return 'interactive.connection.stateNotConnected';
    default:
      return 'interactive.connection.statePending';
  }
}

function isTargetTerminal(target: ConnectionOperationTarget): boolean {
  return target.state === 'connected' || target.state === 'skipped' || target.resolved === true;
}

export function ConnectionPromptCard({
  surface,
  prompt,
  queueIndex,
  queueLength,
  collapsed,
  submitting,
  localError,
  onToggleCollapse,
  onSelectQueueIndex,
  onSubmit,
  onOpenExternalUrl,
  onWakeConnection,
}: ConnectionPromptCardProps): React.ReactElement {
  const [envDrafts, setEnvDrafts] = React.useState<Record<string, Record<string, string>>>({});
  const [copiedTarget, setCopiedTarget] = React.useState<string | null>(null);
  const [validationError, setValidationError] = React.useState<string | null>(null);
  const inputIdPrefix = React.useId();

  React.useEffect(() => {
    setEnvDrafts({});
    setValidationError(null);
    return () => {
      setEnvDrafts({});
    };
  }, [prompt.canonicalKey]);

  const btnSize = surface === 'mobile-dock' ? 'sm' : 'xs';
  const mobileBtnCls = surface === 'mobile-dock' ? 'm-interact__btn px-2 text-aux' : '';

  const setEnvValue = (targetName: string, fieldName: string, value: string): void => {
    setValidationError(null);
    setEnvDrafts((prev) => ({
      ...prev,
      [targetName]: {
        ...(prev[targetName] ?? {}),
        [fieldName]: value,
      },
    }));
  };

  const handleApproveTarget = async (target: ConnectionOperationTarget): Promise<void> => {
    if (submitting) return;
    if (!areRequiredConnectionEnvFilled(prompt, target.name, envDrafts)) {
      setValidationError(t('interactive.connection.missingEnvError'));
      return;
    }
    setValidationError(null);
    const values = envDrafts[target.name];
    const hasEnv = Boolean(target.required_env && target.required_env.length > 0);
    const envPayload: Record<string, string> = {};
    if (hasEnv && target.required_env) {
      for (const field of target.required_env) {
        const val = values?.[field.name] ?? field.default ?? '';
        if (val !== '') envPayload[field.name] = val;
      }
    }
    await onSubmit({
      kind: 'connection',
      targets: [
        {
          name: target.name,
          status: 'approved',
          ...(Object.keys(envPayload).length > 0 ? { env: envPayload } : {}),
        },
      ],
    });
  };

  const handleSkipTarget = async (target: ConnectionOperationTarget): Promise<void> => {
    if (submitting) return;
    setValidationError(null);
    await onSubmit({
      kind: 'connection',
      targets: [{ name: target.name, status: 'skipped' }],
    });
  };

  const handleContinueTurn = async (): Promise<void> => {
    if (submitting) return;
    setValidationError(null);
    await onSubmit({ kind: 'connection', settledBy: 'continue' });
  };

  const handleCopyUrl = async (targetName: string, url: string): Promise<void> => {
    try {
      await navigator.clipboard?.writeText(url);
      setCopiedTarget(targetName);
    // gate-degrade: 剪贴板写入在无权限或无 Clipboard API 环境下降级忽略
    } catch {}
  };

  const actionsNode = (
    <Button
      type="button"
      variant="secondary"
      size={btnSize}
      className={mobileBtnCls}
      disabled={submitting}
      data-testid="interactive-connection-continue"
      onClick={() => void handleContinueTurn()}
    >
      {t('interactive.connection.continueTurn')}
    </Button>
  );

  return (
    <PromptCardFrame
      surface={surface}
      prompt={prompt}
      queueIndex={queueIndex}
      queueLength={queueLength}
      collapsed={collapsed}
      errorMessage={localError || validationError}
      actions={actionsNode}
      onToggleCollapse={onToggleCollapse}
      onSelectQueueIndex={onSelectQueueIndex}
    >
      <div className="flux-interact__conn-list">
        {prompt.targets.map((target) => {
          const rawConnectUrl = target.connect_url ?? null;
          const safeUrl = isSafeExternalUrl(rawConnectUrl) ? rawConnectUrl : null;
          const terminal = isTargetTerminal(target);
          return (
            <div key={target.name} className="flux-interact__conn-item">
              <div className="flux-interact__conn-head">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="truncate font-semibold text-body text-foreground">
                    {target.display || target.name}
                  </span>
                  <Badge variant="outline">{target.kind}</Badge>
                </div>
                <Badge variant={target.state === 'connected' ? 'default' : target.state === 'failed' ? 'destructive' : 'secondary'}>
                  {t(targetStateKey(target.state))}
                </Badge>
              </div>

              {target.description ? <p className="flux-interact__desc">{target.description}</p> : null}
              {target.instructions ? <p className="flux-interact__hint">{target.instructions}</p> : null}
              {target.detail ? <p className="flux-interact__hint">{target.detail}</p> : null}

              {target.scan ? (
                <div className="flux-interact__notice-banner">
                  {target.scan.status === 'passed' ? (
                    <ShieldCheck size={14} className="shrink-0 text-success" aria-hidden="true" />
                  ) : (
                    <ShieldAlert size={14} className="shrink-0 text-warning" aria-hidden="true" />
                  )}
                  <span>
                    {target.scan.status === 'passed'
                      ? t('interactive.connection.scanPassed')
                      : target.scan.status === 'warnings'
                        ? t('interactive.connection.scanWarnings')
                        : t('interactive.connection.scanFailed')}
                    {target.scan.summary ? ` · ${target.scan.summary}` : ''}
                  </span>
                </div>
              ) : null}

              {target.launch ? (
                <CodePreviewBox
                  label={`${t('interactive.connection.launchLabel')} (${target.launch.kind})`}
                  code={target.launch.target}
                />
              ) : null}

              {target.required_env && target.required_env.length > 0 && !terminal ? (
                <div className="flux-interact__field-stack">
                  {target.required_env.map((field) => {
                    const fieldId = `${inputIdPrefix}-${target.name}-${field.name}`;
                    const currentVal = envDrafts[target.name]?.[field.name] ?? field.default ?? '';
                    return (
                      <div key={field.name} className="flux-interact__field-stack">
                        <label htmlFor={fieldId} className="flux-interact__field-label">
                          <span>{field.name}{field.required ? ' *' : ''}</span>
                        </label>
                        {field.prompt ? <p className="flux-interact__hint">{field.prompt}</p> : null}
                        <Input
                          id={fieldId}
                          type={field.secret ? 'password' : 'text'}
                          size={surface === 'mobile-dock' ? 'sm' : 'xs'}
                          className="font-code"
                          value={currentVal}
                          disabled={submitting}
                          autoComplete="off"
                          spellCheck={false}
                          onChange={(e) => setEnvValue(target.name, field.name, e.currentTarget.value)}
                        />
                      </div>
                    );
                  })}
                </div>
              ) : null}

              {target.state === 'initiated' ? (
                <p className="flux-interact__hint">{t('interactive.connection.waitingOAuth')}</p>
              ) : null}

              {!terminal ? (
                <div className="flux-interact__conn-actions">
                  {safeUrl && onOpenExternalUrl ? (
                    <Button
                      type="button"
                      variant="default"
                      size={btnSize}
                      className={mobileBtnCls}
                      onClick={() => onOpenExternalUrl(safeUrl)}
                    >
                      <ExternalLink size={13} aria-hidden="true" />
                      <span>{t('interactive.connection.openBrowser')}</span>
                    </Button>
                  ) : null}
                  {safeUrl ? (
                    <Button
                      type="button"
                      variant="outline"
                      size={btnSize}
                      className={mobileBtnCls}
                      onClick={() => void handleCopyUrl(target.name, safeUrl)}
                    >
                      {copiedTarget === target.name ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
                      <span>{copiedTarget === target.name ? t('interactive.copied') : t('interactive.connection.copyUrl')}</span>
                    </Button>
                  ) : null}
                  {target.state === 'initiated' && onWakeConnection ? (
                    <Button
                      type="button"
                      variant="secondary"
                      size={btnSize}
                      className={mobileBtnCls}
                      disabled={submitting}
                      onClick={() => void onWakeConnection(prompt)}
                    >
                      <RefreshCw size={13} aria-hidden="true" />
                      <span>{t('interactive.connection.checkAuth')}</span>
                    </Button>
                  ) : null}
                  {target.state !== 'initiated' ? (
                    <Button
                      type="button"
                      variant="default"
                      size={btnSize}
                      className={mobileBtnCls}
                      disabled={submitting}
                      onClick={() => void handleApproveTarget(target)}
                    >
                      {t('interactive.connection.approveTarget')}
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    variant="ghost"
                    size={btnSize}
                    className={mobileBtnCls}
                    disabled={submitting}
                    onClick={() => void handleSkipTarget(target)}
                  >
                    {t('interactive.connection.skipTarget')}
                  </Button>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </PromptCardFrame>
  );
}
