/**
 * 移动端全屏分层设置页 (MobileSettingsPage)
 *
 * 【设计意图 (Why)】
 *   贯彻「设置页收口统一系统/提供方配置，Bot 专属配置独立成页」与分级下钻菜单架构：
 *   1. 一级入口视图 (`subpage === null`)：仅呈现分组胶囊列表菜单
 *      （「系统与外观」→ 外观/字体/语言；「连接与模型服务」→ 网关连接 / 模型提供商；「扩展与关于」→ 全局扩展概览 / 关于），
 *      彻底告别把几十个表单与扩展全部堆在一个超长滚动页里的“大杂烩”；
 *   2. 二级详情子页 (`subpage !== null`)：全屏平滑展开，顶部配备共享悬浮返回胶囊 `MobileFloatingBackBar`；
 *      其中 `providers` 直连共享 `ProvidersAdminPanel`（零重复代码），`extensions` 共用 `McpAddDialog` / `SkillInstallDialog` / `SkillDetailDialog`。
 *
 * 【防范的历史坑 (Pitfall)】
 *   1. `.m-settings-page` 层级必须高于 `.m-bot-subpage`，确保从 Bot 模型子页跳转到全局提供商管理时可见且可逐级返回；
 *   2. 嵌入的桌面组件须在 `.m-settings-embedded-panel` 与窄屏弹窗约束下保持 `>=44px` 触控热区且无横向溢出。
 *
 * 【约束与规则 (Rules)】
 *   - 仅保留系统与全局服务配置，Bot 专属字段严禁回流此页。
 */

import * as React from 'react';
import {
  Blocks,
  Download,
  Info,
  KeyRound,
  Palette,
  Plug,
  Plus,
  RefreshCw,
  Trash2,
  Zap,
} from 'lucide-react';
import { t, type I18nKey } from '../../i18n/index.js';
import type { ActivityIndicatorVariant } from '../../tokens/activityIndicator.js';
import type { FontPreferences } from '../../tokens/fontPreferences.js';
import { ProvidersAdminPanel } from '../settings/ProvidersAdminPanel.js';
import { McpAddDialog } from '../settings/McpAddDialog.js';
import { McpRemoveConfirmDialog } from '../settings/McpRemoveConfirmDialog.js';
import { SkillDetailDialog } from '../settings/SkillDetailDialog.js';
import { SkillInstallDialog } from '../settings/SkillInstallDialog.js';
import type { SettingsActions, SettingsSnapshot } from '../settings/settingsModel.js';
import type { MobileAppearancePreference, MobileSettingsSubpage } from './mobileShellModel.js';
import {
  MobileFloatingBackBar,
  MobileMenuCard,
  MobileMenuGroup,
  MobileMenuRow,
  runMobileMcpRemove,
  runMobileMcpTest,
} from './MobileMenuPrimitives.js';

export interface MobileSettingsPageProps {
  open: boolean;
  subpage: MobileSettingsSubpage;
  appearancePref: MobileAppearancePreference;
  snapshot: SettingsSnapshot;
  onClose: () => void;
  onSelectSubpage: (subpage: MobileSettingsSubpage) => void;
  onSetAppearancePreference: (pref: MobileAppearancePreference) => void;
  settingsActions: SettingsActions;
}

const MOBILE_SKIN_LABEL_KEY: Record<
  MobileAppearancePreference,
  'mobile.settings.skinDark' | 'mobile.settings.skinLight' | 'mobile.settings.skinSystem'
> = {
  dark: 'mobile.settings.skinDark',
  light: 'mobile.settings.skinLight',
  system: 'mobile.settings.skinSystem',
};

const MOBILE_SKIN_OPTIONS: ReadonlyArray<{
  id: MobileAppearancePreference;
  labelKey: 'mobile.settings.skinDark' | 'mobile.settings.skinLight' | 'mobile.settings.skinSystem';
}> = [
  { id: 'dark', labelKey: MOBILE_SKIN_LABEL_KEY.dark },
  { id: 'light', labelKey: MOBILE_SKIN_LABEL_KEY.light },
  { id: 'system', labelKey: MOBILE_SKIN_LABEL_KEY.system },
];

const FONT_SIZE_OPTIONS: ReadonlyArray<{
  id: FontPreferences['sizeScale'];
  labelKey: 'settings.sizeSmall' | 'settings.sizeMedium' | 'settings.sizeLarge';
}> = [
  { id: 'small', labelKey: 'settings.sizeSmall' },
  { id: 'medium', labelKey: 'settings.sizeMedium' },
  { id: 'large', labelKey: 'settings.sizeLarge' },
];

const MOBILE_ACTIVITY_OPTIONS: ReadonlyArray<{
  id: ActivityIndicatorVariant;
  labelKey: I18nKey;
}> = [
  { id: 'prolate-lattice', labelKey: 'settings.activityProlateLattice' },
  { id: 'orbit', labelKey: 'settings.activityOrbit' },
  { id: 'synapse', labelKey: 'settings.activitySynapse' },
  { id: 'cloud', labelKey: 'settings.activityCloud' },
  { id: 'gyro', labelKey: 'settings.activityGyro' },
  { id: 'matrix', labelKey: 'settings.activityMatrix' },
];

const SUBPAGE_TITLE_KEY: Record<Exclude<MobileSettingsSubpage, null>, I18nKey> = {
  appearance: 'mobile.settings.rowAppearance',
  gateway: 'mobile.settings.rowGateway',
  providers: 'mobile.settings.rowProviders',
  extensions: 'mobile.settings.rowExtensions',
  about: 'mobile.settings.rowAbout',
};

export function MobileSettingsPage({
  open,
  subpage,
  appearancePref,
  snapshot,
  onClose,
  onSelectSubpage,
  onSetAppearancePreference,
  settingsActions,
}: MobileSettingsPageProps): React.ReactElement {
  const [urlDraft, setUrlDraft] = React.useState(snapshot.gateway.url);
  const [userDraft, setUserDraft] = React.useState(snapshot.gateway.username);
  const [passDraft, setPassDraft] = React.useState('');
  const [profileDraft, setProfileDraft] = React.useState(snapshot.gateway.profileName || 'default');

  const [mcpAddOpen, setMcpAddOpen] = React.useState(false);
  const [skillHubOpen, setSkillHubOpen] = React.useState(false);
  const [inspectingSkill, setInspectingSkill] = React.useState<string | null>(null);
  const [testingMcp, setTestingMcp] = React.useState<string | null>(null);
  const [confirmRemoveMcp, setConfirmRemoveMcp] = React.useState<string | null>(null);
  const [removingMcp, setRemovingMcp] = React.useState(false);

  React.useEffect(() => {
    setUrlDraft(snapshot.gateway.url);
    setUserDraft(snapshot.gateway.username);
    setProfileDraft(snapshot.gateway.profileName || 'default');
  }, [snapshot.gateway.url, snapshot.gateway.username, snapshot.gateway.profileName]);

  const statusText =
    snapshot.gateway.status === 'connected'
      ? t('mobile.settings.statusConnected')
      : snapshot.gateway.status === 'connecting'
        ? t('mobile.settings.statusConnecting')
        : t('mobile.settings.statusDisconnected');

  const mcpRows = snapshot.mcp.status === 'ready' ? snapshot.mcp.data : [];
  const skillsRows = snapshot.skills.status === 'ready' ? snapshot.skills.data : [];
  const providersCount = snapshot.providerViews.status === 'ready' ? snapshot.providerViews.data.length : 0;
  const targetProfile = snapshot.gateway.profileName || 'default';

  const appearanceSummary = `${t(MOBILE_SKIN_LABEL_KEY[appearancePref])} · ${snapshot.locale === 'en' ? t('mobile.settings.langEn') : t('mobile.settings.langZh')}`;
  const extensionsSummary = `${mcpRows.length} MCP · ${skillsRows.length} Skills`;

  const handleTestMcp = (name: string): Promise<void> =>
    runMobileMcpTest({
      targetProfile,
      serverName: name,
      busy: Boolean(testingMcp),
      testServer: settingsActions.onTestMcpServer,
      notify: settingsActions.onNotify,
      setTesting: setTestingMcp,
      onResult: () => settingsActions.onRefreshExtensions(),
    });

  const handleConfirmRemoveMcp = (): Promise<void> =>
    runMobileMcpRemove({
      targetProfile,
      serverName: confirmRemoveMcp,
      busy: removingMcp,
      removeServer: settingsActions.onRemoveMcpServer,
      notify: settingsActions.onNotify,
      setRemoving: setRemovingMcp,
      onRemoved: () => setConfirmRemoveMcp(null),
    });

  const renderRootMenu = (): React.ReactElement => (
    <>
      <MobileMenuGroup title={t('mobile.settings.groupSystem')}>
        <MobileMenuCard>
          <MobileMenuRow
            icon={<Palette size={18} strokeWidth={1.85} />}
            title={t('mobile.settings.rowAppearance')}
            summary={appearanceSummary}
            testId="mobile-settings-row-appearance"
            onClick={() => onSelectSubpage('appearance')}
          />
        </MobileMenuCard>
      </MobileMenuGroup>

      <MobileMenuGroup title={t('mobile.settings.groupConnectivity')}>
        <MobileMenuCard>
          <MobileMenuRow
            icon={<Plug size={18} strokeWidth={1.85} />}
            title={t('mobile.settings.rowGateway')}
            summary={statusText}
            testId="mobile-settings-row-gateway"
            onClick={() => onSelectSubpage('gateway')}
          />
          <MobileMenuRow
            icon={<KeyRound size={18} strokeWidth={1.85} />}
            title={t('mobile.settings.rowProviders')}
            summary={providersCount > 0 ? t('mobile.settings.providersCount', { count: providersCount }) : undefined}
            testId="mobile-settings-row-providers"
            onClick={() => onSelectSubpage('providers')}
          />
        </MobileMenuCard>
      </MobileMenuGroup>

      <MobileMenuGroup title={t('mobile.settings.groupAdvanced')}>
        <MobileMenuCard>
          <MobileMenuRow
            icon={<Blocks size={18} strokeWidth={1.85} />}
            title={t('mobile.settings.rowExtensions')}
            summary={extensionsSummary}
            testId="mobile-settings-row-extensions"
            onClick={() => onSelectSubpage('extensions')}
          />
          <MobileMenuRow
            icon={<Info size={18} strokeWidth={1.85} />}
            title={t('mobile.settings.rowAbout')}
            summary={`v${snapshot.appVersion || '0.1.0'}`}
            testId="mobile-settings-row-about"
            onClick={() => onSelectSubpage('about')}
          />
        </MobileMenuCard>
      </MobileMenuGroup>
    </>
  );

  const renderAppearanceSubpage = (): React.ReactElement => (
    <>
      <section className="m-settings-group">
        <h2 className="m-settings-group__title">{t('mobile.settings.skinGroup')}</h2>
        <div className="m-settings-card">
          <div className="m-settings-seg-row" role="radiogroup" aria-label={t('mobile.settings.skinGroup')}>
            {MOBILE_SKIN_OPTIONS.map((opt) => (
              <button
                key={opt.id}
                type="button"
                role="radio"
                aria-checked={appearancePref === opt.id}
                data-appearance-opt={opt.id}
                className="m-settings-seg-btn"
                data-active={appearancePref === opt.id ? 'true' : 'false'}
                onClick={() => onSetAppearancePreference(opt.id)}
              >
                {t(opt.labelKey)}
              </button>
            ))}
          </div>

          <div className="m-settings-kv-row">
            <span className="m-settings-kv-row__label">{t('mobile.settings.language')}</span>
            <div className="m-settings-lang-pills">
              <button
                type="button"
                className="m-settings-chip-btn"
                data-active={snapshot.locale === 'zh' ? 'true' : 'false'}
                onClick={() => settingsActions.onLocaleChange('zh')}
              >
                {t('mobile.settings.langZh')}
              </button>
              <button
                type="button"
                className="m-settings-chip-btn"
                data-active={snapshot.locale === 'en' ? 'true' : 'false'}
                onClick={() => settingsActions.onLocaleChange('en')}
              >
                {t('mobile.settings.langEn')}
              </button>
            </div>
          </div>
        </div>
      </section>

      <section className="m-settings-group">
        <h2 className="m-settings-group__title">{t('mobile.settings.fontSizeGroup')}</h2>
        <div className="m-settings-card">
          <div className="m-settings-seg-row" role="radiogroup" aria-label={t('mobile.settings.fontSizeGroup')}>
            {FONT_SIZE_OPTIONS.map((opt) => {
              const active = snapshot.fontPrefs.sizeScale === opt.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  className="m-settings-seg-btn"
                  data-active={active ? 'true' : 'false'}
                  onClick={() =>
                    settingsActions.onFontPrefsChange({
                      ...snapshot.fontPrefs,
                      sizeScale: opt.id,
                    })
                  }
                >
                  {t(opt.labelKey)}
                </button>
              );
            })}
          </div>
        </div>
      </section>

      <section className="m-settings-group">
        <h2 className="m-settings-group__title">{t('mobile.settings.activityGroup')}</h2>
        <div className="m-settings-card">
          <div className="m-bot-filter-pills">
            {MOBILE_ACTIVITY_OPTIONS.map((opt) => (
              <button
                key={opt.id}
                type="button"
                className="m-settings-chip-btn"
                data-active={snapshot.activityVariant === opt.id ? 'true' : 'false'}
                onClick={() => settingsActions.onActivityVariantChange(opt.id)}
              >
                {t(opt.labelKey)}
              </button>
            ))}
          </div>
        </div>
      </section>
    </>
  );

  const renderGatewaySubpage = (): React.ReactElement => (
    <section className="m-settings-group">
      <div className="m-settings-group__header">
        <h2 className="m-settings-group__title">{t('mobile.settings.gatewayGroup')}</h2>
        <span className="m-settings-status-pill" data-status={snapshot.gateway.status}>
          {statusText}
        </span>
      </div>
      <div className="m-settings-card m-settings-card--form">
        <label className="m-settings-field">
          <span className="m-settings-field__label">{t('mobile.settings.gatewayUrl')}</span>
          <input
            type="url"
            className="m-matte-input"
            value={urlDraft}
            onChange={(e) => setUrlDraft(e.target.value)}
          />
        </label>
        <label className="m-settings-field">
          <span className="m-settings-field__label">{t('mobile.settings.gatewayUser')}</span>
          <input
            type="text"
            className="m-matte-input"
            value={userDraft}
            onChange={(e) => setUserDraft(e.target.value)}
          />
        </label>
        <label className="m-settings-field">
          <span className="m-settings-field__label">{t('mobile.settings.gatewayPass')}</span>
          <input
            type="password"
            className="m-matte-input"
            value={passDraft}
            placeholder={snapshot.gateway.hasStoredPassword ? t('mobile.settings.gatewayPassPlaceholder') : ''}
            onChange={(e) => setPassDraft(e.target.value)}
          />
        </label>
        <label className="m-settings-field">
          <span className="m-settings-field__label">{t('mobile.settings.gatewayProfile')}</span>
          <input
            type="text"
            className="m-matte-input"
            value={profileDraft}
            onChange={(e) => setProfileDraft(e.target.value)}
          />
        </label>

        {snapshot.gateway.test?.message ? (
          <div className="m-settings-test-msg" data-ok={snapshot.gateway.test.ok ? 'true' : 'false'}>
            {snapshot.gateway.test.message}
          </div>
        ) : null}

        <div className="m-settings-btn-row">
          <button
            type="button"
            className="m-secondary-btn"
            onClick={() =>
              settingsActions.onTestGateway({
                url: urlDraft,
                username: userDraft,
                password: passDraft,
                profileName: profileDraft.trim() || 'default',
              })
            }
          >
            {t('mobile.settings.testBtn')}
          </button>
          <button
            type="button"
            className="m-primary-btn"
            onClick={() =>
              settingsActions.onConnectGateway({
                url: urlDraft,
                username: userDraft,
                password: passDraft,
                profileName: profileDraft.trim() || 'default',
              })
            }
          >
            {t('mobile.settings.connectBtn')}
          </button>
        </div>
        {snapshot.gateway.status === 'connected' ? (
          <button
            type="button"
            className="m-danger-btn"
            onClick={() => settingsActions.onDisconnectGateway()}
          >
            {t('mobile.settings.disconnectBtn')}
          </button>
        ) : null}
      </div>
    </section>
  );

  const renderProvidersSubpage = (): React.ReactElement => (
    <div className="flux-settings m-settings-embedded-panel" data-testid="mobile-settings-providers">
      <ProvidersAdminPanel snapshot={snapshot} actions={settingsActions} />
    </div>
  );

  const renderExtensionsSubpage = (): React.ReactElement => (
    <div className="flux-settings m-settings-embedded-panel">
      <section className="m-settings-group">
        <div className="m-settings-group__header">
          <h2 className="m-settings-group__title">{t('settings.mcpTitle')}</h2>
          <div className="m-bot-filter-pills">
            {settingsActions.onAddMcpServer ? (
              <button type="button" className="m-bot-action-pill" onClick={() => setMcpAddOpen(true)}>
                <Plus size={14} aria-hidden="true" />
                <span>{t('bot.mcpAddBtn')}</span>
              </button>
            ) : null}
            <button
              type="button"
              className="m-bot-action-pill"
              onClick={settingsActions.onRefreshExtensions}
            >
              <RefreshCw size={14} aria-hidden="true" />
              <span>{t('mobile.settings.refreshBtn')}</span>
            </button>
          </div>
        </div>
        {mcpRows.length === 0 ? (
          <div className="m-bot-subpage__empty">{t('settings.mcpEmpty')}</div>
        ) : (
          <MobileMenuCard>
            {mcpRows.map((row) => (
              <div key={row.name} className="m-bot-cap-row">
                <div className="m-bot-cap-row__main">
                  <span className="m-bot-cap-row__title">{row.name}</span>
                  <span className="m-bot-cap-row__desc">
                    {row.transport} · {t('settings.mcpToolCount', { count: row.toolCount })}
                  </span>
                </div>
                <div className="m-bot-cap-row__right">
                  {settingsActions.onTestMcpServer ? (
                    <button
                      type="button"
                      className="m-icon-btn"
                      aria-label={t('bot.mcpTestBtn')}
                      disabled={snapshot.busy || testingMcp === row.name}
                      onClick={() => void handleTestMcp(row.name)}
                    >
                      <Zap size={15} />
                    </button>
                  ) : null}
                  {settingsActions.onRemoveMcpServer ? (
                    <button
                      type="button"
                      className="m-icon-btn"
                      aria-label={t('bot.mcpRemoveBtn')}
                      disabled={snapshot.busy || removingMcp}
                      onClick={() => setConfirmRemoveMcp(row.name)}
                    >
                      <Trash2 size={15} />
                    </button>
                  ) : null}
                </div>
              </div>
            ))}
          </MobileMenuCard>
        )}
      </section>

      <section className="m-settings-group">
        <div className="m-settings-group__header">
          <h2 className="m-settings-group__title">{t('settings.skillsTitle')}</h2>
          <div className="m-bot-filter-pills">
            {settingsActions.onInstallSkill ? (
              <button type="button" className="m-bot-action-pill" onClick={() => setSkillHubOpen(true)}>
                <Download size={14} aria-hidden="true" />
                <span>{t('bot.skillInstallBtn')}</span>
              </button>
            ) : null}
            <button type="button" className="m-bot-action-pill" onClick={() => void settingsActions.onReloadSkills()}>
              <RefreshCw size={14} aria-hidden="true" />
              <span>{t('settings.skillsReload')}</span>
            </button>
          </div>
        </div>
        {skillsRows.length === 0 ? (
          <div className="m-bot-subpage__empty">{t('settings.skillsEmpty')}</div>
        ) : (
          <MobileMenuCard>
            {skillsRows.map((row) => (
              <MobileMenuRow
                key={row.name}
                icon={<Blocks size={17} strokeWidth={1.85} />}
                title={row.name}
                summary={row.category}
                onClick={() => setInspectingSkill(row.name)}
              />
            ))}
          </MobileMenuCard>
        )}
      </section>

      <McpAddDialog
        open={mcpAddOpen}
        targetProfile={targetProfile}
        targetLabel={targetProfile}
        installedNames={new Set(mcpRows.map((r) => r.name))}
        onClose={() => setMcpAddOpen(false)}
        onFetchCatalog={settingsActions.onFetchMcpCatalog}
        onAddServer={settingsActions.onAddMcpServer}
        onNotify={settingsActions.onNotify}
      />

      <SkillInstallDialog
        open={skillHubOpen}
        targetProfile={targetProfile}
        installedNames={new Set(skillsRows.map((r) => r.name))}
        onClose={() => setSkillHubOpen(false)}
        onSearchSkills={settingsActions.onSearchSkillsHub}
        onInstallSkill={settingsActions.onInstallSkill}
        onNotify={settingsActions.onNotify}
      />

      <SkillDetailDialog
        skillName={inspectingSkill}
        targetProfile={targetProfile}
        onClose={() => setInspectingSkill(null)}
        onInspectSkill={settingsActions.onInspectSkill}
        onCopy={settingsActions.onCopy}
        onNotify={settingsActions.onNotify}
      />

      <McpRemoveConfirmDialog
        serverName={confirmRemoveMcp}
        busy={removingMcp}
        onCancel={() => setConfirmRemoveMcp(null)}
        onConfirm={() => void handleConfirmRemoveMcp()}
      />
    </div>
  );

  const renderAboutSubpage = (): React.ReactElement => (
    <section className="m-settings-group">
      <div className="m-settings-card">
        <div className="m-settings-kv-row">
          <span className="m-settings-kv-row__label">{t('mobile.settings.version')}</span>
          <span className="m-settings-kv-row__val">{snapshot.appVersion || '0.1.0'}</span>
        </div>
        <div className="m-settings-kv-row">
          <span className="m-settings-kv-row__label">{t('mobile.settings.platform')}</span>
          <span className="m-settings-kv-row__val">{snapshot.platform}</span>
        </div>
        <div className="m-settings-kv-row">
          <span className="m-settings-kv-row__label">{t('mobile.settings.protocol')}</span>
          <span className="m-settings-kv-row__val">JSON-RPC 2.0</span>
        </div>
        {snapshot.gateway.status === 'connected' ? (
          <div className="m-settings-kv-row">
            <span className="m-settings-kv-row__label">{t('mobile.settings.latency')}</span>
            <span className="m-settings-kv-row__val">{snapshot.gateway.latencyMs} ms</span>
          </div>
        ) : null}
      </div>
    </section>
  );

  const renderContent = (): React.ReactElement => {
    switch (subpage) {
      case 'appearance':
        return renderAppearanceSubpage();
      case 'gateway':
        return renderGatewaySubpage();
      case 'providers':
        return renderProvidersSubpage();
      case 'extensions':
        return renderExtensionsSubpage();
      case 'about':
        return renderAboutSubpage();
      default:
        return renderRootMenu();
    }
  };

  const title = subpage ? t(SUBPAGE_TITLE_KEY[subpage]) : t('mobile.settings.title');

  return (
    <aside
      className="m-settings-page m-no-swipe"
      data-open={open ? 'true' : 'false'}
      data-subpage={subpage || 'root'}
      aria-hidden={!open}
      role="dialog"
      aria-label={title}
    >
      <MobileFloatingBackBar
        title={title}
        onBack={() => (subpage !== null ? onSelectSubpage(null) : onClose())}
        backAriaLabel={t('mobile.settings.backAria')}
        backTestId="mobile-settings-back"
      />

      <div className="m-settings-page__scroll">{renderContent()}</div>
    </aside>
  );
}
