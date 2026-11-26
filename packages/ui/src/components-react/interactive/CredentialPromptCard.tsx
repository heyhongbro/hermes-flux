/**
 * 密钥与安全凭据填写停靠卡片 (CredentialPromptCard)
 *
 * 【设计意图 (Why)】
 *   统一承接 `secret`、`sudo`、`display.install.sudo`、`vault.code`、`vault.unlock_prompt`、
 *   `vault.save_login` 六大凭据反向请求；直接停靠在输入舱上方，支持展开浏览历史确认上下文。
 *
 * 【防范的历史坑 (Pitfall)】
 *   1. 输入控件强制绑定 `React.useId()` 动态 ID，杜绝静态 ID 与宿主 `renderCoordinator` 焦点快照冲突；
 *   2. 严禁把明文密钥存入 `localStorage`/草稿态；组件卸载或请求切换时立即清空 React 本地状态。
 */

import * as React from 'react';
import { Eye, EyeOff, KeyRound, Lock } from 'lucide-react';
import type { CredentialPrompt, InteractiveReplyPayload } from '@hermes-flux/core';
import { t } from '../../i18n/index.js';
import { Badge } from '../primitives/Badge.js';
import { Button } from '../primitives/Button.js';
import { Input } from '../primitives/Input.js';
import { buildCredentialSubmitPayload, splitCompactHeaderSubtitle } from './interactiveModel.js';
import { CodePreviewBox, PromptCardFrame, type DockSurfaceMode } from './PromptCardFrame.js';

export interface CredentialPromptCardProps {
  surface: DockSurfaceMode;
  prompt: CredentialPrompt;
  queueIndex: number;
  queueLength: number;
  collapsed: boolean;
  submitting: boolean;
  localError: string | null;
  onToggleCollapse: () => void;
  onSelectQueueIndex?: (idx: number) => void;
  onSubmit: (payload: InteractiveReplyPayload) => Promise<boolean | void>;
}

export function CredentialPromptCard({
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
}: CredentialPromptCardProps): React.ReactElement {
  const [value, setValue] = React.useState('');
  const [identifier, setIdentifier] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [showPlain, setShowPlain] = React.useState(false);
  const [validationError, setValidationError] = React.useState<string | null>(null);

  const primaryInputId = React.useId();
  const identifierInputId = React.useId();
  const passwordInputId = React.useId();

  React.useEffect(() => {
    setValue('');
    setIdentifier('');
    setPassword('');
    setShowPlain(false);
    setValidationError(null);
    return () => {
      setValue('');
      setIdentifier('');
      setPassword('');
    };
  }, [prompt.canonicalKey]);

  const btnSize = surface === 'mobile-dock' ? 'sm' : 'xs';
  const mobileBtnCls = surface === 'mobile-dock' ? 'm-interact__btn px-2 text-aux' : '';
  const inputSize = surface === 'mobile-dock' ? 'sm' : 'xs';
  const isSaveLogin = prompt.method === 'vault.save_login';
  const isCode = prompt.method === 'vault.code';
  const hasMetaBadges = Boolean(prompt.envVar || prompt.profileKey || prompt.site || prompt.backend);
  const { headerSubtitle: inlineSubtitle, bodyDescription } = splitCompactHeaderSubtitle(
    prompt.promptText,
    !isSaveLogin,
  );

  const handleSubmit = async (event?: React.FormEvent): Promise<void> => {
    event?.preventDefault();
    if (submitting) return;
    const built = buildCredentialSubmitPayload(prompt, { value, identifier, password });
    if (!built.valid || !built.payload) {
      setValidationError(t('interactive.credential.emptyError'));
      return;
    }
    setValidationError(null);
    await onSubmit(built.payload);
    setValue('');
    setIdentifier('');
    setPassword('');
  };

  const handleSkip = async (): Promise<void> => {
    if (submitting) return;
    setValidationError(null);
    setValue('');
    setIdentifier('');
    setPassword('');
    await onSubmit({ kind: 'credential', value: '' });
  };

  const actionsNode = (
    <>
      <Button
        type="button"
        variant="ghost"
        size={btnSize}
        className={mobileBtnCls}
        disabled={submitting}
        data-testid="interactive-credential-skip"
        onClick={() => void handleSkip()}
      >
        {t('interactive.credential.skip')}
      </Button>
      <Button
        type="button"
        variant="default"
        size={btnSize}
        className={mobileBtnCls}
        disabled={submitting}
        data-testid="interactive-credential-submit"
        onClick={() => void handleSubmit()}
      >
        {submitting ? t('interactive.submitting') : t('interactive.credential.submit')}
      </Button>
    </>
  );

  return (
    <PromptCardFrame
      surface={surface}
      prompt={prompt}
      queueIndex={queueIndex}
      queueLength={queueLength}
      collapsed={collapsed}
      headerSubtitle={inlineSubtitle}
      headerExtra={<Badge variant="outline">{prompt.method}</Badge>}
      errorMessage={localError || validationError}
      actions={actionsNode}
      onToggleCollapse={onToggleCollapse}
      onSelectQueueIndex={onSelectQueueIndex}
    >
      <form className="flux-interact__cred-form" onSubmit={(e) => void handleSubmit(e)}>
        {hasMetaBadges ? (
          <div className="flux-interact__meta-row">
            {prompt.envVar ? (
              <Badge variant="secondary">
                {t('interactive.credential.envVarLabel')}: {prompt.envVar}
              </Badge>
            ) : null}
            {prompt.profileKey ? (
              <Badge variant="secondary">
                {t('interactive.credential.profileKeyLabel')}: {prompt.profileKey}
              </Badge>
            ) : null}
            {prompt.site ? (
              <Badge variant="secondary">
                {t('interactive.credential.siteLabel')}: {prompt.site}
              </Badge>
            ) : null}
            {prompt.backend ? (
              <Badge variant="outline">
                {t('interactive.credential.backendLabel')}: {prompt.backend}
              </Badge>
            ) : null}
          </div>
        ) : null}

        {bodyDescription ? <p className="flux-interact__desc">{bodyDescription}</p> : null}
        {prompt.hint ? (
          <p className="flux-interact__hint">
            {t('interactive.credential.hintLabel')}: {prompt.hint}
          </p>
        ) : null}
        {prompt.originUrl ? <p className="flux-interact__hint">{prompt.originUrl}</p> : null}
        {prompt.command ? (
          <CodePreviewBox ariaLabel={t('interactive.approval.commandLabel')} code={prompt.command} />
        ) : null}

        {isSaveLogin ? (
          <div className="flux-interact__field-stack">
            <label htmlFor={identifierInputId} className="flux-interact__field-label">
              <KeyRound size={12} className="shrink-0" aria-hidden="true" />
              <span>{t('interactive.credential.identifierLabel')}</span>
            </label>
            <Input
              id={identifierInputId}
              type="text"
              size={inputSize}
              value={identifier}
              disabled={submitting}
              autoComplete="off"
              spellCheck={false}
              placeholder={t('interactive.credential.identifierPlaceholder')}
              onChange={(e) => {
                setValidationError(null);
                setIdentifier(e.currentTarget.value);
              }}
            />

            <label htmlFor={passwordInputId} className="flux-interact__field-label">
              <Lock size={12} className="shrink-0" aria-hidden="true" />
              <span>{t('interactive.credential.passwordLabel')}</span>
            </label>
            <div className="flux-interact__secret-row">
              <Input
                id={passwordInputId}
                type={showPlain ? 'text' : 'password'}
                size={inputSize}
                className="font-code"
                value={password}
                disabled={submitting}
                autoComplete="off"
                spellCheck={false}
                placeholder={t('interactive.credential.secretPlaceholder')}
                onChange={(e) => {
                  setValidationError(null);
                  setPassword(e.currentTarget.value);
                }}
              />
              <Button
                type="button"
                variant="outline"
                size={surface === 'mobile-dock' ? 'icon-sm' : 'icon-xs'}
                className={surface === 'mobile-dock' ? 'flux-interact__icon-btn m-interact__btn' : 'flux-interact__icon-btn'}
                aria-label={showPlain ? t('interactive.credential.hideSecret') : t('interactive.credential.showSecret')}
                aria-pressed={showPlain}
                onClick={() => setShowPlain((v) => !v)}
              >
                {showPlain ? <EyeOff size={14} aria-hidden="true" /> : <Eye size={14} aria-hidden="true" />}
              </Button>
            </div>
          </div>
        ) : (
          <div className="flux-interact__field-stack">
            <label htmlFor={primaryInputId} className="sr-only">
              {isCode
                ? t('interactive.credential.vaultCodeTitle')
                : t('interactive.credential.passwordLabel')}
            </label>
            <div className="flux-interact__secret-row">
              <Input
                id={primaryInputId}
                type={isCode ? 'text' : showPlain ? 'text' : 'password'}
                size={inputSize}
                className="font-code"
                value={value}
                disabled={submitting}
                inputMode={isCode ? 'numeric' : undefined}
                autoComplete={isCode ? 'one-time-code' : 'off'}
                spellCheck={false}
                placeholder={
                  isCode
                    ? t('interactive.credential.codePlaceholder')
                    : t('interactive.credential.secretPlaceholder')
                }
                onChange={(e) => {
                  setValidationError(null);
                  setValue(e.currentTarget.value);
                }}
              />
              {!isCode ? (
                <Button
                  type="button"
                  variant="outline"
                  size={surface === 'mobile-dock' ? 'icon-sm' : 'icon-xs'}
                  className={surface === 'mobile-dock' ? 'flux-interact__icon-btn m-interact__btn' : 'flux-interact__icon-btn'}
                  aria-label={showPlain ? t('interactive.credential.hideSecret') : t('interactive.credential.showSecret')}
                  aria-pressed={showPlain}
                  onClick={() => setShowPlain((v) => !v)}
                >
                  {showPlain ? <EyeOff size={14} aria-hidden="true" /> : <Eye size={14} aria-hidden="true" />}
                </Button>
              ) : null}
            </div>
          </div>
        )}

        <p className="flux-interact__security-note">{t('interactive.credential.securityNotice')}</p>
      </form>
    </PromptCardFrame>
  );
}
