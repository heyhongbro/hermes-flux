/**
 * 移动端 Bot 专属详情子页与新建向导 (MobileBotSubpage & MobileBotWizardSheet)
 *
 * 【设计意图 (Why)】
 *   从 `MobileBotHubScreen` 的分级菜单点击进入，全屏悬浮滑入对应详情面板：
 *   1. `identity`：头像上传/恢复、显示名、职责描述、ID 复制与设为默认开关；
 *   2. `model`：按提供商分组筛选绑定该 Bot 的主推理模型，并直达全局提供商管理；
 *   3. `soul`：`SOUL.md` 等宽编辑器、快捷变量、角色模板与 64KB 字节预警；
 *   4. `skills` / `toolsets` / `mcp`：高密度可搜索过滤清单，复用 `@hermes-flux/core`
 *      与桌面端共享的 `McpAddDialog` / `McpRemoveConfirmDialog` / `SkillInstallDialog` / `SkillDetailDialog`；
 *   5. `memory`：展示终身主工位物理隔离说明与直达入口；
 *   6. `MobileBotWizardSheet`：支持空白创建 / 克隆已有数字员工。
 *
 * 【防范的历史坑 (Pitfall)】
 *   1. 离线或 `list_error` 下点击兜底花名册行进入子页时，`activeDetail` 为空，严禁永久停留在“正在加载...”，必须呈现明确错误与重试/连网入口（Failure Is Not Empty）；
 *   2. `.m-bot-subpage` 层级必须严格低于 `.m-settings-page`，否则从模型子页点击“管理全局模型提供商”时设置页会被压在子页之下；
 *   3. 删除 MCP 或 `wizard.busy` 在途提交时须清理陈旧探活缓存并拦截遮罩误关。
 *
 * 【约束与规则 (Rules)】
 *   - 复用的桌面弹窗须在窄屏保持零横向溢出且 `>=44px` 触控热区。
 */

import * as React from 'react';
import {
  Camera,
  Check,
  Copy,
  Download,
  Lock,
  Plus,
  RotateCcw,
  Search,
  Trash2,
  X,
  Zap,
} from 'lucide-react';
import {
  draftFromDetail,
  isBotDraftDirty,
  type BotCapabilityList,
  type BotDraftState,
  type LearningDetailState,
  type LearningLoadState,
  type McpTestResultView,
} from '@hermes-flux/core';
import { t, type I18nKey } from '../../i18n/index.js';
import { presentModel } from '../../lib/modelPresentation.js';
import { renderBotAvatar } from '../../utils/botAvatar.js';
import { AvatarProcessingError, cropAvatarToDataUrl } from '../../utils/cropAvatar.js';
import { Switch } from '../primitives/Switch.js';
import type { SettingsActions, SettingsSnapshot } from '../settings/settingsModel.js';
import {
  canResetBotAvatar,
  computeSoulByteLength,
  computeSoulLineCount,
  countEnabledCapabilities,
  filterCapabilities,
  insertTextAtSelection,
  isSoulOverLimit,
  resolveBotAvatar,
  resolveBotDisplayTitle,
  SOUL_SOFT_LIMIT_BYTES,
  toggleCapabilityId,
  type BotCapFilterMode,
} from '../settings/botPanelLogic.js';
import { McpAddDialog } from '../settings/McpAddDialog.js';
import { McpRemoveConfirmDialog } from '../settings/McpRemoveConfirmDialog.js';
import { SkillDetailDialog } from '../settings/SkillDetailDialog.js';
import { SkillInstallDialog } from '../settings/SkillInstallDialog.js';
import type { MobileBotSubpage } from './mobileShellModel.js';
import { MobileConstellationPanel } from './MobileConstellationPanel.js';
import {
  MobileBotSaveBar,
  MobileFloatingBackBar,
  MobileMenuCard,
  runMobileMcpRemove,
  runMobileMcpTest,
} from './MobileMenuPrimitives.js';

export interface MobileBotSubpagePanelProps {
  subpage: MobileBotSubpage;
  settingsSnapshot: SettingsSnapshot;
  settingsActions: SettingsActions;
  onBack: () => void;
  onOpenBotChat: (botName: string) => void;
  onOpenProviders: () => void;
  onOpenGateway?: () => void;
  learningState?: LearningLoadState;
  learningDetail?: LearningDetailState;
  onRefreshLearning?: () => void;
  onLoadLearningDetail?: (id: string) => void;
  onEditLearningNode?: (id: string, content: string) => Promise<{ ok: boolean; message?: string }>;
  onDeleteLearningNode?: (id: string) => Promise<{ ok: boolean; message?: string }>;
  onCopyText?: (text: string) => void;
  cropAvatarFn?: (file: File) => Promise<string>;
}

const SUBPAGE_TITLE_KEY: Record<Exclude<MobileBotSubpage, null>, I18nKey> = {
  identity: 'mobile.botHub.rowIdentity',
  model: 'mobile.botHub.rowModel',
  soul: 'mobile.botHub.rowSoul',
  skills: 'mobile.botHub.rowSkills',
  toolsets: 'mobile.botHub.rowToolsets',
  mcp: 'mobile.botHub.rowMcp',
  memory: 'mobile.botHub.rowMemory',
};

export function MobileBotSubpagePanel({
  subpage,
  settingsSnapshot,
  settingsActions,
  onBack,
  onOpenBotChat,
  onOpenProviders,
  onOpenGateway,
  learningState,
  learningDetail,
  onRefreshLearning,
  onLoadLearningDetail,
  onEditLearningNode,
  onDeleteLearningNode,
  onCopyText,
  cropAvatarFn = cropAvatarToDataUrl,
}: MobileBotSubpagePanelProps): React.ReactElement {
  const view = settingsSnapshot.botManagement;
  const activeId = view.activeBotId;
  const targetBotId = activeId || view.roster[0]?.id || '';
  const gatewayConnected = settingsSnapshot.gateway.status === 'connected';
  const activeDetail = view.activeDetail;
  const draft: BotDraftState | null =
    view.activeDraft ?? (activeDetail ? draftFromDetail(activeDetail) : null);

  const dirty = Boolean(activeDetail && draft && isBotDraftDirty(activeDetail, draft));
  const saving = view.status.status === 'saving' || view.isBusy;

  const [modelQuery, setModelQuery] = React.useState('');
  const [capQuery, setCapQuery] = React.useState('');
  const [capFilter, setCapFilter] = React.useState<BotCapFilterMode>('all');
  const [copyDone, setCopyDone] = React.useState(false);
  const [mcpAddOpen, setMcpAddOpen] = React.useState(false);
  const [skillHubOpen, setSkillHubOpen] = React.useState(false);
  const [inspectingSkill, setInspectingSkill] = React.useState<{
    name: string;
    description?: string;
  } | null>(null);
  const [testingMcpId, setTestingMcpId] = React.useState<string | null>(null);
  const [mcpOverrides, setMcpOverrides] = React.useState<Record<string, McpTestResultView>>({});
  const [confirmRemoveMcp, setConfirmRemoveMcp] = React.useState<string | null>(null);
  const [removingMcp, setRemovingMcp] = React.useState(false);

  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const soulRef = React.useRef<HTMLTextAreaElement>(null);
  const probeEpochRef = React.useRef(0);

  React.useEffect(() => {
    setCapQuery('');
    setCapFilter('all');
    setModelQuery('');
  }, [subpage, activeId]);

  React.useEffect(() => {
    probeEpochRef.current += 1;
    setMcpOverrides({});
    setTestingMcpId(null);
    setConfirmRemoveMcp(null);
  }, [activeId]);

  const patchDraft = (patch: Partial<BotDraftState>): void => {
    if (!activeId || saving) return;
    settingsActions.onBotDraftChange(activeId, patch);
  };

  const handleCopyId = async (): Promise<void> => {
    if (!activeId) return;
    const copied = await settingsActions.onCopy(activeId);
    if (copied) {
      setCopyDone(true);
      settingsActions.onNotify(t('bot.copied'));
      setTimeout(() => setCopyDone(false), 1600);
    }
  };

  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const input = event.currentTarget;
    const file = input.files?.[0];
    input.value = '';
    if (!file || !activeId) return;
    try {
      const dataUrl = await cropAvatarFn(file);
      patchDraft({ avatar: { kind: 'replace', dataUrl } });
    } catch (err) {
      const code = err instanceof AvatarProcessingError ? err.code : null;
      const key: I18nKey =
        code === 'too-large'
          ? 'bot.avatarTooLarge'
          : code === 'invalid-type'
            ? 'bot.avatarInvalidType'
            : 'bot.avatarCropFailed';
      settingsActions.onNotify(t(key));
    }
  };

  const insertSoulText = (snippet: string): void => {
    if (!draft || saving) return;
    const node = soulRef.current;
    const nextEdit = insertTextAtSelection(draft.soul, snippet, node?.selectionStart, node?.selectionEnd);
    patchDraft({ soul: nextEdit.value });
  };

  const handleTestMcp = (name: string): Promise<void> => {
    const epoch = probeEpochRef.current;
    return runMobileMcpTest({
      targetProfile: activeId,
      serverName: name,
      busy: Boolean(testingMcpId),
      testServer: settingsActions.onTestMcpServer,
      notify: settingsActions.onNotify,
      setTesting: setTestingMcpId,
      shouldCommit: () => epoch === probeEpochRef.current,
      onResult: (result) => setMcpOverrides((prev) => ({ ...prev, [name]: result })),
    });
  };

  const handleConfirmRemoveMcp = (): Promise<void> =>
    runMobileMcpRemove({
      targetProfile: activeId,
      serverName: confirmRemoveMcp,
      busy: removingMcp,
      removeServer: settingsActions.onRemoveMcpServer,
      notify: settingsActions.onNotify,
      setRemoving: setRemovingMcp,
      onRemoved: (removedName) => {
        probeEpochRef.current += 1;
        setMcpOverrides((prev) => {
          const next = { ...prev };
          delete next[removedName];
          return next;
        });
        setConfirmRemoveMcp(null);
      },
    });

  const renderCapFilterBar = (total: number, enabledCount: number, rightAction?: React.ReactNode): React.ReactElement => {
    const filterModes: ReadonlyArray<readonly [BotCapFilterMode, string]> = [
      ['all', t('bot.capFilterAll', { count: total })],
      ['enabled', t('bot.capFilterEnabled', { count: enabledCount })],
      ['disabled', t('bot.capFilterDisabled', { count: Math.max(0, total - enabledCount) })],
    ];
    return (
      <div className="m-bot-cap-toolbar">
        <div className="m-bot-cap-toolbar__top">
          <div className="m-bot-search-wrap">
            <Search size={15} className="m-bot-search-wrap__icon" aria-hidden="true" />
            <input
              type="search"
              className="m-matte-input m-bot-search-wrap__input"
              value={capQuery}
              placeholder={t('bot.capSearchPlaceholder')}
              onChange={(e) => setCapQuery(e.target.value)}
            />
          </div>
          {rightAction}
        </div>
        <div className="m-bot-filter-pills" role="group">
          {filterModes.map(([mode, label]) => (
            <button
              key={mode}
              type="button"
              className="m-settings-chip-btn"
              data-active={capFilter === mode ? 'true' : 'false'}
              onClick={() => setCapFilter(mode)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
    );
  };

  const renderCapabilityRows = (
    list: BotCapabilityList,
    enabledIds: readonly string[],
    kind: 'skills' | 'toolsets' | 'mcp',
    onToggle: (id: string, next: boolean) => void,
  ): React.ReactElement => {
    const filtered = filterCapabilities(list.rows, enabledIds, capFilter, capQuery);
    const enabledSet = new Set(enabledIds);
    const readonly = saving || !list.authoritative;

    return (
      <>
        {!list.authoritative ? (
          <div className="m-bot-banner m-bot-banner--warn">{t('bot.capabilityReadonly')}</div>
        ) : null}
        {list.rows.length === 0 ? (
          <div className="m-bot-subpage__empty">
            {list.authoritative ? t('bot.capabilityNone') : t('bot.capabilityEmpty')}
          </div>
        ) : filtered.length === 0 ? (
          <div className="m-bot-subpage__empty">{t('bot.capEmptyFiltered')}</div>
        ) : (
          <MobileMenuCard>
            {filtered.map((row) => {
              const checked = enabledSet.has(row.id);
              const probe = kind === 'mcp' ? mcpOverrides[row.id] : undefined;
              const online = probe ? probe.ok : row.online;
              const statusText =
                kind === 'mcp'
                  ? online === undefined
                    ? t('bot.mcpUnknown')
                    : online
                      ? t('bot.mcpOnline')
                      : t('bot.mcpOffline')
                  : null;
              const toggleLabel =
                kind === 'skills'
                  ? t('bot.skillsToggleLabel', { name: row.label })
                  : kind === 'toolsets'
                    ? t('bot.toolsetToggleLabel', { name: row.label })
                    : t('bot.mcpToggleLabel', { name: row.label });

              return (
                <div key={row.id} className="m-bot-cap-row" data-bot-capability-row={row.id}>
                  {kind === 'skills' && settingsActions.onInspectSkill ? (
                    <button
                      type="button"
                      className="m-bot-cap-row__main"
                      onClick={() => setInspectingSkill({ name: row.id, description: row.description })}
                    >
                      <span className="m-bot-cap-row__title">{row.label}</span>
                      {row.description ? <span className="m-bot-cap-row__desc">{row.description}</span> : null}
                    </button>
                  ) : (
                    <div className="m-bot-cap-row__main">
                      <span className="m-bot-cap-row__title">{row.label}</span>
                      {(row.description || statusText) ? (
                        <span className="m-bot-cap-row__desc">
                          {[statusText, row.transport, row.description].filter(Boolean).join(' · ')}
                        </span>
                      ) : null}
                    </div>
                  )}

                  <div className="m-bot-cap-row__right">
                    {kind === 'mcp' && settingsActions.onTestMcpServer ? (
                      <button
                        type="button"
                        className="m-icon-btn"
                        aria-label={t('bot.mcpTestBtn')}
                        disabled={saving || testingMcpId === row.id}
                        onClick={() => void handleTestMcp(row.id)}
                      >
                        <Zap size={15} />
                      </button>
                    ) : null}
                    {kind === 'mcp' && settingsActions.onRemoveMcpServer ? (
                      <button
                        type="button"
                        className="m-icon-btn"
                        aria-label={t('bot.mcpRemoveBtn')}
                        disabled={saving || removingMcp}
                        onClick={() => setConfirmRemoveMcp(row.id)}
                      >
                        <Trash2 size={15} />
                      </button>
                    ) : null}
                    <Switch
                      checked={checked}
                      disabled={readonly}
                      aria-label={toggleLabel}
                      onCheckedChange={(next) => onToggle(row.id, next)}
                    />
                  </div>
                </div>
              );
            })}
          </MobileMenuCard>
        )}
      </>
    );
  };

  const renderBody = (): React.ReactNode => {
    if (!subpage) return null;

    if (!activeDetail || !draft) {
      if (!gatewayConnected) {
        return (
          <div className="m-bot-subpage__empty" data-testid="mobile-bot-subpage-offline">
            <p>{t('mobile.botHub.offlineHint')}</p>
            {onOpenGateway ? (
              <button type="button" className="m-secondary-btn" onClick={onOpenGateway}>
                {t('mobile.home.offlineAction')}
              </button>
            ) : null}
          </div>
        );
      }
      if (view.status.status === 'list_error') {
        return (
          <div className="m-bot-subpage__empty" data-testid="mobile-bot-subpage-error">
            <p>{view.status.message}</p>
            <button type="button" className="m-secondary-btn" onClick={settingsActions.onRetryBotList}>
              {t('bot.retry')}
            </button>
          </div>
        );
      }
      if (view.status.status === 'detail_error') {
        return (
          <div className="m-bot-subpage__empty" data-testid="mobile-bot-subpage-error">
            <p>{view.status.message}</p>
            {targetBotId ? (
              <button
                type="button"
                className="m-secondary-btn"
                onClick={() => settingsActions.onSelectBotSettle(targetBotId)}
              >
                {t('bot.retry')}
              </button>
            ) : null}
          </div>
        );
      }
      return (
        <div className="m-bot-subpage__empty">
          <p>{t('settings.loading')}</p>
        </div>
      );
    }

    if (subpage === 'identity') {
      const rosterAvatar = view.roster.find((r) => r.id === activeId)?.avatar;
      const effectiveAvatar = resolveBotAvatar(activeDetail.avatar || rosterAvatar, draft);
      const displayTitle = resolveBotDisplayTitle(activeDetail.displayName, activeId, draft);
      const canReset = canResetBotAvatar({
        activeId,
        hasDetail: true,
        draft,
        effectiveAvatar,
        locked: saving,
        status: view.status.status,
      });

      return (
        <div className="m-settings-card m-settings-card--form">
          <div className="m-bot-identity-avatar-row">
            <button
              type="button"
              className="m-bot-identity-avatar-btn"
              aria-label={t('bot.avatarUpload')}
              disabled={saving}
              onClick={() => fileInputRef.current?.click()}
            >
              <span
                aria-hidden="true"
                dangerouslySetInnerHTML={{
                  __html: renderBotAvatar(activeId, displayTitle, effectiveAvatar, 64, 'circle'),
                }}
              />
              <span className="m-bot-identity-avatar-cam" aria-hidden="true">
                <Camera size={14} />
              </span>
            </button>
            <div className="m-bot-identity-id-col">
              <div className="m-bot-identity-id-row">
                <code className="m-bot-id-code">{activeId}</code>
                <button
                  type="button"
                  className="m-icon-btn"
                  aria-label={copyDone ? t('bot.copied') : t('bot.copyId')}
                  onClick={() => void handleCopyId()}
                >
                  {copyDone ? <Check size={15} /> : <Copy size={15} />}
                </button>
              </div>
              {canReset ? (
                <button
                  type="button"
                  className="m-bot-link-btn"
                  onClick={() => patchDraft({ avatar: { kind: 'clear' } })}
                >
                  <RotateCcw size={13} aria-hidden="true" />
                  <span>{t('bot.avatarReset')}</span>
                </button>
              ) : null}
            </div>
          </div>

          <label className="m-settings-field">
            <span className="m-settings-field__label">{t('bot.nameLabel')}</span>
            <input
              type="text"
              className="m-matte-input"
              value={draft.displayName}
              placeholder={t('bot.namePlaceholder')}
              disabled={saving}
              onChange={(e) => patchDraft({ displayName: e.target.value })}
            />
          </label>

          <label className="m-settings-field">
            <span className="m-settings-field__label">{t('bot.descLabel')}</span>
            <textarea
              className="m-matte-input m-bot-textarea"
              rows={3}
              value={draft.description}
              placeholder={t('bot.descPlaceholder')}
              disabled={saving}
              onChange={(e) => patchDraft({ description: e.target.value })}
            />
          </label>

          <div className="m-settings-kv-row">
            <div>
              <div className="m-settings-kv-row__label">{t('bot.setDefault')}</div>
              <div className="m-settings-field__label">{t('bot.setDefaultHint')}</div>
            </div>
            <Switch
              checked={draft.isDefault}
              disabled={saving}
              aria-label={t('bot.setDefault')}
              onCheckedChange={(next) => patchDraft({ isDefault: next })}
            />
          </div>
        </div>
      );
    }

    if (subpage === 'model') {
      const needle = modelQuery.trim().toLowerCase();
      const filtered = view.availableModels.filter(
        (m) =>
          !needle ||
          m.id.toLowerCase().includes(needle) ||
          m.name.toLowerCase().includes(needle) ||
          m.providerName.toLowerCase().includes(needle),
      );
      const isOffline = Boolean(
        draft.model && !view.availableModels.some((opt) => opt.id === draft.model),
      );

      return (
        <>
          <div className="m-bot-search-wrap">
            <Search size={15} className="m-bot-search-wrap__icon" aria-hidden="true" />
            <input
              type="search"
              className="m-matte-input m-bot-search-wrap__input"
              value={modelQuery}
              placeholder={t('bot.modelSearchPlaceholder')}
              onChange={(e) => setModelQuery(e.target.value)}
            />
          </div>

          {isOffline ? (
            <div className="m-bot-banner m-bot-banner--warn">
              {t('bot.modelOffline', { model: draft.model })}
            </div>
          ) : null}

          {view.availableModels.length === 0 ? (
            <div className="m-bot-subpage__empty">
              <p>{t('bot.modelCatalogUnavailable')}</p>
              <p className="m-settings-field__label">{t('bot.modelCatalogHint')}</p>
            </div>
          ) : filtered.length === 0 ? (
            <div className="m-bot-subpage__empty">{t('bot.modelEmptySearch')}</div>
          ) : (
            <MobileMenuCard>
              {filtered.map((opt) => {
                const selected = draft.model === opt.id && (!draft.provider || draft.provider === opt.provider);
                const displayName = presentModel(opt.id, opt.providerName).name || opt.name;
                return (
                  <button
                    key={`${opt.provider}:${opt.id}`}
                    type="button"
                    className="m-menu-row m-bot-model-opt"
                    data-active={selected ? 'true' : 'false'}
                    onClick={() => patchDraft({ model: opt.id, provider: opt.provider })}
                  >
                    <span className="m-bot-model-opt__body">
                      <span className="m-menu-row__title">{displayName}</span>
                      <span className="m-bot-cap-row__desc">{opt.providerName || opt.provider}</span>
                    </span>
                    {selected ? <Check size={16} className="m-sheet-option__check" aria-hidden="true" /> : null}
                  </button>
                );
              })}
            </MobileMenuCard>
          )}

          <button
            type="button"
            className="m-secondary-btn"
            data-testid="mobile-bot-manage-providers"
            onClick={onOpenProviders}
          >
            {t('mobile.botHub.manageProviders')}
          </button>
        </>
      );
    }

    if (subpage === 'soul') {
      const soulBytes = computeSoulByteLength(draft.soul);
      const soulLines = computeSoulLineCount(draft.soul);
      const overLimit = isSoulOverLimit(soulBytes);
      return (
        <div className="m-settings-card m-settings-card--form">
          <div className="m-bot-filter-pills">
            <button
              type="button"
              className="m-settings-chip-btn"
              onClick={() => insertSoulText('{{user_name}}')}
            >
              {t('bot.soulVarUserShort')}
            </button>
            <button
              type="button"
              className="m-settings-chip-btn"
              onClick={() => insertSoulText('{{workspace_root}}')}
            >
              {t('bot.soulVarWorkspaceShort')}
            </button>
            <button
              type="button"
              className="m-settings-chip-btn"
              onClick={() => insertSoulText(t('bot.soulTemplateArchitectBody'))}
            >
              {t('bot.soulTemplateArchitect')}
            </button>
            <button
              type="button"
              className="m-settings-chip-btn"
              onClick={() => insertSoulText(t('bot.soulTemplateReviewerBody'))}
            >
              {t('bot.soulTemplateReviewer')}
            </button>
          </div>
          <textarea
            ref={soulRef}
            className="m-matte-input m-bot-soul-editor"
            rows={14}
            aria-label={t('bot.soulEditorLabel')}
            value={draft.soul}
            disabled={saving}
            onChange={(e) => patchDraft({ soul: e.target.value })}
          />
          <div className="m-settings-kv-row m-bot-soul-meta">
            <span className="m-settings-field__label">{t('bot.soulLines', { count: soulLines })}</span>
            <span className={overLimit ? 'm-settings-test-msg' : 'm-settings-field__label'}>
              {overLimit ? t('bot.soulLengthWarn') : t('bot.soulCount', { bytes: soulBytes })}
            </span>
          </div>
        </div>
      );
    }

    if (subpage === 'skills') {
      const enabledSkillIds = activeDetail.skills.rows
        .filter((r) => !draft.disabledSkills.includes(r.id))
        .map((r) => r.id);
      const enabledCount = countEnabledCapabilities(activeDetail.skills, enabledSkillIds);
      return (
        <>
          {renderCapFilterBar(
            activeDetail.skills.rows.length,
            enabledCount,
            settingsActions.onInstallSkill ? (
              <button
                type="button"
                className="m-bot-action-pill"
                onClick={() => setSkillHubOpen(true)}
              >
                <Download size={14} aria-hidden="true" />
                <span>{t('bot.skillInstallBtn')}</span>
              </button>
            ) : null,
          )}
          {renderCapabilityRows(activeDetail.skills, enabledSkillIds, 'skills', (id, next) => {
            const disabled = new Set(draft.disabledSkills);
            if (next) disabled.delete(id);
            else disabled.add(id);
            patchDraft({ disabledSkills: Array.from(disabled) });
          })}
        </>
      );
    }

    if (subpage === 'toolsets') {
      const enabledCount = countEnabledCapabilities(activeDetail.toolsets, draft.enabledToolsets);
      return (
        <>
          {renderCapFilterBar(activeDetail.toolsets.rows.length, enabledCount)}
          {renderCapabilityRows(activeDetail.toolsets, draft.enabledToolsets, 'toolsets', (id, next) => {
            patchDraft({
              enabledToolsets: toggleCapabilityId(activeDetail.toolsets, draft.enabledToolsets, id, next),
            });
          })}
        </>
      );
    }

    if (subpage === 'mcp') {
      const enabledCount = countEnabledCapabilities(activeDetail.mcpServers, draft.enabledMcpServers);
      return (
        <>
          {renderCapFilterBar(
            activeDetail.mcpServers.rows.length,
            enabledCount,
            settingsActions.onAddMcpServer ? (
              <button
                type="button"
                className="m-bot-action-pill"
                onClick={() => setMcpAddOpen(true)}
              >
                <Plus size={14} aria-hidden="true" />
                <span>{t('bot.mcpAddBtn')}</span>
              </button>
            ) : null,
          )}
          {renderCapabilityRows(activeDetail.mcpServers, draft.enabledMcpServers, 'mcp', (id, next) => {
            patchDraft({
              enabledMcpServers: toggleCapabilityId(activeDetail.mcpServers, draft.enabledMcpServers, id, next),
            });
          })}
        </>
      );
    }

    return (
      <>
        {learningState && onRefreshLearning && onLoadLearningDetail ? (
          <MobileConstellationPanel
            learningState={learningState}
            learningDetail={learningDetail ?? { status: 'idle' }}
            onRefresh={onRefreshLearning}
            onSelectNodeDetail={onLoadLearningDetail}
            onSaveEdit={onEditLearningNode}
            onDeleteNode={onDeleteLearningNode}
            onCopyText={onCopyText}
          />
        ) : null}
        <div className="m-settings-card m-settings-card--form">
          <div className="m-bot-memory-head">
            <Lock size={16} aria-hidden="true" />
            <span className="m-settings-kv-row__label">{t('bot.memoryTitle')}</span>
          </div>
          <div className="m-bot-hub__badge">{t('bot.memoryLocked')}</div>
          <p className="m-settings-field__label">{t('bot.memoryNotice')}</p>
          <button
            type="button"
            className="m-primary-btn"
            onClick={() => {
              onBack();
              onOpenBotChat(activeId);
            }}
          >
            {t('mobile.botHub.openBotChat')}
          </button>
        </div>
      </>
    );
  };

  const title = subpage ? t(SUBPAGE_TITLE_KEY[subpage]) : '';
  const installedMcp = new Set(activeDetail?.mcpServers.rows.map((r) => r.id) ?? []);
  const installedSkills = new Set(activeDetail?.skills.rows.map((r) => r.id) ?? []);

  return (
    <aside
      className="m-bot-subpage m-no-swipe flux-settings"
      data-open={subpage !== null ? 'true' : 'false'}
      data-subpage={subpage || ''}
      aria-hidden={subpage === null}
      role="dialog"
      aria-label={title || t('mobile.botHub.title')}
    >
      <MobileFloatingBackBar
        title={title}
        onBack={onBack}
        backAriaLabel={t('mobile.settings.backAria')}
        backTestId="mobile-bot-subpage-back"
      />

      <div className="m-bot-subpage__scroll">{renderBody()}</div>

      {subpage ? (
        <MobileBotSaveBar
          dirty={dirty}
          saving={saving}
          onReset={() => settingsActions.onResetBotDraft(activeId)}
          onSave={() => void settingsActions.onSaveBotConfig(activeId)}
        />
      ) : null}

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="m-hidden-anchor"
        tabIndex={-1}
        onChange={(e) => void handleFileChange(e)}
      />

      <McpAddDialog
        open={mcpAddOpen}
        targetProfile={activeId}
        targetLabel={activeDetail?.displayName || activeId}
        installedNames={installedMcp}
        onClose={() => setMcpAddOpen(false)}
        onFetchCatalog={settingsActions.onFetchMcpCatalog}
        onAddServer={settingsActions.onAddMcpServer}
        onNotify={settingsActions.onNotify}
      />

      <SkillInstallDialog
        open={skillHubOpen}
        targetProfile={activeId}
        installedNames={installedSkills}
        onClose={() => setSkillHubOpen(false)}
        onSearchSkills={settingsActions.onSearchSkillsHub}
        onInstallSkill={settingsActions.onInstallSkill}
        onNotify={settingsActions.onNotify}
      />

      <SkillDetailDialog
        skillName={inspectingSkill?.name ?? null}
        targetProfile={activeId}
        fallbackDescription={inspectingSkill?.description}
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
    </aside>
  );
}

export interface MobileBotWizardSheetProps {
  settingsSnapshot: SettingsSnapshot;
  settingsActions: SettingsActions;
}

export function MobileBotWizardSheet({
  settingsSnapshot,
  settingsActions,
}: MobileBotWizardSheetProps): React.ReactElement | null {
  const { wizard, roster } = settingsSnapshot.botManagement;
  if (!wizard.open) return null;
  const draft = wizard.draft;

  return (
    <div
      className="m-sheet-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={t('mobile.botHub.wizardTitle')}
      onClick={() => {
        if (!wizard.busy) settingsActions.onCloseBotWizard();
      }}
    >
      <div className="m-bottom-sheet m-no-swipe" onClick={(e) => e.stopPropagation()}>
        <div className="m-sheet-handle" aria-hidden="true" />
        <div className="m-sheet-header">
          <span className="m-sheet-title">{t('mobile.botHub.wizardTitle')}</span>
          <button
            type="button"
            className="m-icon-btn"
            aria-label={t('mobile.common.close')}
            disabled={wizard.busy}
            onClick={() => {
              if (!wizard.busy) settingsActions.onCloseBotWizard();
            }}
          >
            <X size={18} />
          </button>
        </div>

        <div className="m-settings-seg-row m-bot-wizard-modes" role="radiogroup">
          <button
            type="button"
            role="radio"
            aria-checked={draft.mode === 'blank'}
            className="m-settings-seg-btn"
            data-active={draft.mode === 'blank' ? 'true' : 'false'}
            onClick={() => settingsActions.onBotWizardDraftChange({ mode: 'blank' })}
          >
            {t('mobile.botHub.wizardBlank')}
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={draft.mode === 'clone'}
            className="m-settings-seg-btn"
            data-active={draft.mode === 'clone' ? 'true' : 'false'}
            onClick={() =>
              settingsActions.onBotWizardDraftChange({
                mode: 'clone',
                cloneFrom: draft.cloneFrom || roster[0]?.id || '',
              })
            }
          >
            {t('mobile.botHub.wizardClone')}
          </button>
        </div>

        <div className="m-sheet-list">
          <label className="m-settings-field">
            <span className="m-settings-field__label">{t('bot.idLabel')}</span>
            <input
              type="text"
              className="m-matte-input"
              value={draft.name}
              placeholder={t('bot.idPlaceholder')}
              onChange={(e) => settingsActions.onBotWizardDraftChange({ name: e.target.value })}
            />
          </label>
          <label className="m-settings-field">
            <span className="m-settings-field__label">{t('bot.nameLabel')}</span>
            <input
              type="text"
              className="m-matte-input"
              value={draft.displayName}
              placeholder={t('bot.namePlaceholder')}
              onChange={(e) => settingsActions.onBotWizardDraftChange({ displayName: e.target.value })}
            />
          </label>
          <label className="m-settings-field">
            <span className="m-settings-field__label">{t('bot.descLabel')}</span>
            <input
              type="text"
              className="m-matte-input"
              value={draft.description}
              placeholder={t('bot.descPlaceholder')}
              onChange={(e) => settingsActions.onBotWizardDraftChange({ description: e.target.value })}
            />
          </label>

          {draft.mode === 'clone' && roster.length > 0 ? (
            <>
              <label className="m-settings-field">
                <span className="m-settings-field__label">{t('bot.cloneFrom')}</span>
                <select
                  className="m-matte-input"
                  value={draft.cloneFrom}
                  onChange={(e) => settingsActions.onBotWizardDraftChange({ cloneFrom: e.target.value })}
                >
                  {roster.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.displayName || item.id}
                    </option>
                  ))}
                </select>
              </label>
              <div className="m-settings-kv-row">
                <span className="m-settings-kv-row__label">{t('bot.cloneChannels')}</span>
                <Switch
                  checked={draft.cloneChannels}
                  onCheckedChange={(next) => settingsActions.onBotWizardDraftChange({ cloneChannels: next })}
                />
              </div>
              <div className="m-settings-kv-row">
                <span className="m-settings-kv-row__label">{t('bot.mirrorCredentials')}</span>
                <Switch
                  checked={draft.mirrorCredentials}
                  onCheckedChange={(next) => settingsActions.onBotWizardDraftChange({ mirrorCredentials: next })}
                />
              </div>
            </>
          ) : null}

          {wizard.error ? <div className="m-settings-test-msg">{wizard.error}</div> : null}
        </div>

        <button
          type="button"
          className="m-primary-btn"
          disabled={wizard.busy}
          onClick={() => void settingsActions.onSubmitCreateBot()}
        >
          {wizard.busy ? t('bot.wizardCreating') : t('mobile.botHub.wizardSubmit')}
        </button>
      </div>
    </div>
  );
}
