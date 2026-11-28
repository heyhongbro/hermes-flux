/**
 * 移动端即发新建会话页 (MobileNewChatSheet)
 *
 * 【设计意图 (Why)】
 *   1:1 遵循用户提供参考图交互架构：点击首屏 `＋` 后，底部升起圆角 Page Sheet：
 *   1. 第一步 (`compose`)：左上角 `[ 头像 智能体名 ⌄ ]` 纯哑光切换胶囊，下拉可选任意 Bot 或点击
 *      「发起多智能体群聊 ›」横向滑入第二步；中部居中留白舞台展示 78px 大圆头像/群拼贴、
 *      名称、简介与 `Plugins · MCP · Skills` 能力统计；底部直接放 `MobileMorphingComposer`，
 *      输入首条消息即自动建单聊或建群并平滑进入对话舞台；
 *   2. 第二步 (`group-members`)：横向推入多选参会智能体页面（支持可选群聊名称输入），
 *      确认后左上角切为拼贴群头像并回到第一步直接开聊。
 */

import * as React from 'react';
import { Check, ChevronDown, ChevronLeft, ChevronRight, Folder, Users, X } from 'lucide-react';
import { t } from '../../i18n/index.js';
import { renderBotAvatar, renderGroupCollageAvatar } from '../../utils/botAvatar.js';
import type { LeftRailProfile, LeftRailProject } from '../leftRailModel.js';
import {
  filterProfilesForGateway,
  filterProjectsForGateway,
  resolveActiveNewChatProjects,
  resolveInitialGatewayId,
  type NewChatGatewayOption,
} from '../newChatModel.js';
import type { InputAttachmentItem } from '../../components/InputDock/InputDock.js';
import type { MobileNewChatStep } from './mobileShellModel.js';
import type { MobileModelOption } from './types.js';
import { MobileMorphingComposer } from './MobileMorphingComposer.js';

export interface MobileNewChatSheetProps {
  open: boolean;
  step: MobileNewChatStep;
  targetKind: 'bot' | 'group';
  targetBot: string;
  groupMembers: string[];
  groupName: string;
  allProfiles: LeftRailProfile[];
  projects?: LeftRailProject[];
  selectedProjectId?: string;
  gateways?: readonly NewChatGatewayOption[];
  selectedGatewayId?: string;
  stats?: {
    pluginsCount: number;
    mcpCount: number;
    skillsCount: number;
  };
  gatewayConnected: boolean;
  selectedModel: string;
  currentProvider?: string;
  availableModels: string[];
  modelDetails: MobileModelOption[];
  attachments: InputAttachmentItem[];
  onClose: () => void;
  onSetStep: (step: MobileNewChatStep) => void;
  onSelectBot: (botName: string) => void;
  onSetGroupMembers: (members: string[]) => void;
  onSetGroupName: (name: string) => void;
  onSelectProject?: (projectId?: string) => void;
  onSelectGateway?: (gatewayId: string) => void;
  onSubmitFirstMessage: (text: string) => void;
  onSelectModel: (model: string, provider?: string) => void;
  onRefreshModels?: () => void;
  onOpenAttachmentPicker: () => void;
  onRemoveAttachment: (id: string) => void;
  forceModelPickerOpen?: boolean;
  onModelPickerOpenChange?: (open: boolean) => void;
  externalModelPicker?: boolean;
  forceProjectPickerOpen?: boolean;
  onProjectPickerOpenChange?: (open: boolean) => void;
}

export function MobileNewChatSheet({
  open,
  step,
  targetKind,
  targetBot,
  groupMembers,
  groupName,
  allProfiles,
  projects = [],
  selectedProjectId,
  gateways = [],
  selectedGatewayId,
  stats,
  gatewayConnected,
  selectedModel,
  currentProvider,
  availableModels,
  modelDetails,
  attachments,
  onClose,
  onSetStep,
  onSelectBot,
  onSetGroupMembers,
  onSetGroupName,
  onSelectProject,
  onSelectGateway,
  onSubmitFirstMessage,
  onSelectModel,
  onRefreshModels,
  onOpenAttachmentPicker,
  onRemoveAttachment,
  forceModelPickerOpen,
  onModelPickerOpenChange,
  externalModelPicker,
  forceProjectPickerOpen,
  onProjectPickerOpenChange,
}: MobileNewChatSheetProps): React.ReactElement | null {
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const [localProjectPickerOpen, setLocalProjectPickerOpen] = React.useState(false);

  const projectPickerControlled = typeof forceProjectPickerOpen === 'boolean';
  const isProjectPickerOpen = projectPickerControlled
    ? Boolean(forceProjectPickerOpen)
    : localProjectPickerOpen;
  const setProjectPickerOpen = (next: boolean): void => {
    if (!projectPickerControlled) {
      setLocalProjectPickerOpen(next);
    }
    onProjectPickerOpenChange?.(next);
  };

  React.useEffect(() => {
    if (!open) {
      setPickerOpen(false);
      setLocalProjectPickerOpen(false);
    }
  }, [open]);

  if (!open) return null;

  const isMultiGateway = gateways.length >= 2;
  const effectiveGatewayId = isMultiGateway
    ? resolveInitialGatewayId(gateways, selectedGatewayId)
    : '';
  const activeGateway = isMultiGateway
    ? gateways.find((g) => g.id === effectiveGatewayId)
    : undefined;
  const effectiveGatewayConnected = activeGateway ? activeGateway.connected : gatewayConnected;
  const scopedProfiles = filterProfilesForGateway(
    allProfiles,
    isMultiGateway ? effectiveGatewayId : undefined,
  );
  const scopedProjects = filterProjectsForGateway(
    projects,
    isMultiGateway ? effectiveGatewayId : undefined,
  );

  const activeProjects = resolveActiveNewChatProjects(scopedProjects);
  const selectedProject = activeProjects.find((p) => p.id === selectedProjectId);

  const activeProfile =
    scopedProfiles.find((p) => p.name.toLowerCase() === targetBot.toLowerCase()) ||
    scopedProfiles.find((p) => p.isDefault) ||
    scopedProfiles[0] || {
      name: targetBot || 'default',
      displayName: targetBot || t('rail.defaultAssistant'),
      avatar: '',
      description: '',
    };

  const isGroupMode = targetKind === 'group' && groupMembers.length >= 2;
  const resolvedGroupName = groupName.trim() || t('mobile.newChat.groupDefaultName');
  const heroTitle = isGroupMode ? resolvedGroupName : activeProfile.displayName || activeProfile.name;
  const heroDesc = isGroupMode
    ? t('mobile.home.groupMembersCount', { count: groupMembers.length })
    : (activeProfile.description || '').trim() || t('mobile.newChat.noDescription');

  const smallAvatarHtml = isGroupMode
    ? renderGroupCollageAvatar(groupMembers, scopedProfiles, 24)
    : renderBotAvatar(activeProfile.name, activeProfile.displayName, activeProfile.avatar, 24, 'circle');

  const heroAvatarHtml = isGroupMode
    ? renderGroupCollageAvatar(groupMembers, scopedProfiles, 78)
    : renderBotAvatar(activeProfile.name, activeProfile.displayName, activeProfile.avatar, 78, 'circle');

  const renderGatewaySelectRow = (testId: string): React.ReactNode => {
    if (!isMultiGateway) return null;
    return (
      <label className="m-settings-field" style={{ paddingInline: '16px', marginBottom: '6px' }}>
        <span className="m-settings-field__label">{t('mobile.newChat.gatewayLabel')}</span>
        <select
          className="m-matte-input"
          data-testid={testId}
          aria-label={t('mobile.newChat.gatewayLabel')}
          value={effectiveGatewayId}
          onChange={(e) => {
            setPickerOpen(false);
            setProjectPickerOpen(false);
            onSelectGateway?.(e.target.value);
          }}
        >
          {gateways.map((gw) => (
            <option key={gw.id} value={gw.id}>
              {gw.connected ? gw.label : `${gw.label} (${t('settings.gatewayDisconnected')})`}
            </option>
          ))}
        </select>
      </label>
    );
  };

  const toggleMember = (name: string): void => {
    const exists = groupMembers.includes(name);
    if (exists) {
      onSetGroupMembers(groupMembers.filter((m) => m !== name));
    } else {
      onSetGroupMembers([...groupMembers, name]);
    }
  };

  return (
    <div
      className="m-page-sheet-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={t('mobile.newChat.sheetTitle')}
      onClick={onClose}
    >
      <div
        className="m-page-sheet m-no-swipe"
        data-step={step}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="m-sheet-handle" aria-hidden="true" />

        <div className="m-newchat__track" data-step={step}>
          {/* Step 1: 选定对象 + 中央人物舞台 + 底部即发输入框 */}
          <div className="m-newchat__step" data-active={step === 'compose' ? 'true' : 'false'}>
            <header className="m-newchat__header">
              <button
                type="button"
                className="m-target-pill"
                aria-expanded={pickerOpen}
                onClick={() => setPickerOpen((prev) => !prev)}
              >
                <span
                  className="m-target-pill__avatar"
                  aria-hidden="true"
                  dangerouslySetInnerHTML={{ __html: smallAvatarHtml }}
                />
                <span className="m-target-pill__name">{heroTitle}</span>
                <ChevronDown size={14} className="m-target-pill__caret" aria-hidden="true" />
              </button>

              <button
                type="button"
                className="m-icon-btn"
                aria-label={t('mobile.newChat.closeAria')}
                onClick={onClose}
              >
                <X size={20} strokeWidth={1.8} />
              </button>
            </header>

            {pickerOpen ? (
              <div className="m-target-dropdown" role="menu">
                <div className="m-target-dropdown__title">{t('mobile.newChat.switchTarget')}</div>
                <div className="m-target-dropdown__list">
                  {scopedProfiles.map((profile) => {
                    const selected = !isGroupMode && profile.name === activeProfile.name;
                    return (
                      <button
                        key={profile.name}
                        type="button"
                        role="menuitem"
                        className="m-target-dropdown__item"
                        data-selected={selected ? 'true' : 'false'}
                        onClick={() => {
                          onSelectBot(profile.name);
                          setPickerOpen(false);
                        }}
                      >
                        <span
                          className="m-target-dropdown__avatar"
                          aria-hidden="true"
                          dangerouslySetInnerHTML={{
                            __html: renderBotAvatar(profile.name, profile.displayName, profile.avatar, 28, 'circle'),
                          }}
                        />
                        <span className="m-target-dropdown__name">{profile.displayName || profile.name}</span>
                        {selected ? <Check size={15} className="m-sheet-option__check" /> : null}
                      </button>
                    );
                  })}
                </div>
                <button
                  type="button"
                  className="m-target-dropdown__group-btn"
                  data-testid="mobile-newchat-start-group"
                  onClick={() => {
                    setPickerOpen(false);
                    if (groupMembers.length === 0) {
                      const seed = scopedProfiles.slice(0, 2).map((p) => p.name);
                      onSetGroupMembers(seed);
                    }
                    onSetStep('group-members');
                  }}
                >
                  <Users size={15} aria-hidden="true" />
                  <span>{t('mobile.newChat.startGroup')}</span>
                  <ChevronRight size={15} aria-hidden="true" />
                </button>
              </div>
            ) : null}

            {renderGatewaySelectRow('mobile-new-chat-gateway-select')}
            {!effectiveGatewayConnected ? (
              <div
                data-testid="mobile-new-chat-offline-hint"
                className="m-newchat__hint"
                style={{ paddingInline: '16px', color: 'var(--warning)' }}
              >
                {t('mobile.newChat.gatewayOfflineHint')}
              </div>
            ) : null}

            <div className="m-newchat__hero">
              <div
                className="m-newchat__hero-avatar"
                aria-hidden="true"
                dangerouslySetInnerHTML={{ __html: heroAvatarHtml }}
              />
              <h2 className="m-newchat__hero-title">{heroTitle}</h2>
              <p className="m-newchat__hero-desc">{heroDesc}</p>
              {stats ? (
                <div className="m-newchat__hero-stats">
                  {t('mobile.newChat.statsLine', {
                    plugins: stats.pluginsCount,
                    mcp: stats.mcpCount,
                    skills: stats.skillsCount,
                  })}
                </div>
              ) : null}
              {activeProjects.length > 0 ? (
                <button
                  type="button"
                  className="m-newchat__project-chip"
                  data-testid="mobile-newchat-project-chip"
                  aria-label={t('mobile.newChat.projectLabel')}
                  aria-expanded={isProjectPickerOpen}
                  onClick={() => {
                    setPickerOpen(false);
                    setProjectPickerOpen(!isProjectPickerOpen);
                  }}
                >
                  <Folder size={13} aria-hidden="true" />
                  <span>
                    {selectedProject ? selectedProject.name : t('mobile.newChat.projectChipDefault')}
                  </span>
                  <ChevronDown size={13} aria-hidden="true" />
                </button>
              ) : null}
            </div>

            {isProjectPickerOpen && activeProjects.length > 0 ? (
              <div
                className="m-sheet-backdrop"
                role="dialog"
                aria-modal="true"
                aria-label={t('mobile.newChat.projectPickerTitle')}
                onClick={() => setProjectPickerOpen(false)}
              >
                <div className="m-bottom-sheet m-no-swipe" onClick={(e) => e.stopPropagation()}>
                  <div className="m-sheet-handle" aria-hidden="true" />
                  <div className="m-sheet-header">
                    <span className="m-sheet-title">{t('mobile.newChat.projectPickerTitle')}</span>
                    <button
                      type="button"
                      className="m-icon-btn"
                      aria-label={t('mobile.common.close')}
                      onClick={() => setProjectPickerOpen(false)}
                    >
                      <X size={18} />
                    </button>
                  </div>
                  <div className="m-sheet-list">
                    <button
                      type="button"
                      className="m-sheet-option"
                      data-active={!selectedProject ? 'true' : 'false'}
                      data-newchat-project-opt=""
                      onClick={() => {
                        onSelectProject?.(undefined);
                        setProjectPickerOpen(false);
                      }}
                    >
                      <Folder size={16} aria-hidden="true" />
                      <span className="m-sheet-option__title">{t('mobile.newChat.projectChipDefault')}</span>
                      {!selectedProject ? <Check size={16} className="m-sheet-option__check" /> : null}
                    </button>
                    {activeProjects.map((proj) => {
                      const picked = proj.id === selectedProject?.id;
                      return (
                        <button
                          key={proj.id}
                          type="button"
                          className="m-sheet-option"
                          data-active={picked ? 'true' : 'false'}
                          data-newchat-project-opt={proj.id}
                          onClick={() => {
                            onSelectProject?.(proj.id);
                            setProjectPickerOpen(false);
                          }}
                        >
                          <Folder size={16} aria-hidden="true" />
                          <span className="m-sheet-option__main">
                            <span className="m-sheet-option__title">{proj.name}</span>
                            {proj.path ? <span className="m-sheet-option__meta">{proj.path}</span> : null}
                          </span>
                          {picked ? <Check size={16} className="m-sheet-option__check" /> : null}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            ) : null}

            <div className="m-newchat__composer-wrap">
              <MobileMorphingComposer
                placeholder={t('mobile.newChat.composerPlaceholder', { target: heroTitle })}
                disabled={!effectiveGatewayConnected}
                selectedModel={selectedModel}
                currentProvider={currentProvider}
                availableModels={availableModels}
                modelDetails={modelDetails}
                attachments={attachments}
                onSend={(text) => {
                  onSubmitFirstMessage(text);
                }}
                onAttach={onOpenAttachmentPicker}
                onRemoveAttachment={onRemoveAttachment}
                onSelectModel={onSelectModel}
                onRefreshModels={onRefreshModels}
                forceModelPickerOpen={forceModelPickerOpen}
                onModelPickerOpenChange={onModelPickerOpenChange}
                externalModelPicker={externalModelPicker}
              />
            </div>
          </div>

          {/* Step 2: 发起多智能体群聊 —— 选择参会智能体 */}
          <div className="m-newchat__step" data-active={step === 'group-members' ? 'true' : 'false'}>
            <header className="m-newchat__header m-newchat__header--step2">
              <button
                type="button"
                className="m-back-btn"
                onClick={() => onSetStep('compose')}
              >
                <ChevronLeft size={18} strokeWidth={2} />
                <span>{t('mobile.newChat.backStep')}</span>
              </button>
              <span className="m-newchat__step-title">{t('mobile.newChat.pickMembersTitle')}</span>
              <span className="m-newchat__step-spacer" />
            </header>

            <div className="m-newchat__group-body">
              {renderGatewaySelectRow('mobile-new-chat-group-gateway-select')}
              <input
                type="text"
                className="m-matte-input"
                value={groupName}
                placeholder={t('mobile.newChat.groupNamePlaceholder')}
                onChange={(e) => onSetGroupName(e.target.value)}
              />
              <p className="m-newchat__hint">{t('mobile.newChat.pickMembersHint')}</p>

              <div className="m-newchat__member-list">
                {scopedProfiles.map((profile) => {
                  const picked = groupMembers.includes(profile.name);
                  return (
                    <button
                      key={profile.name}
                      type="button"
                      className="m-member-pick-row"
                      data-picked={picked ? 'true' : 'false'}
                      onClick={() => toggleMember(profile.name)}
                    >
                      <span
                        className="m-entity-row__avatar"
                        aria-hidden="true"
                        dangerouslySetInnerHTML={{
                          __html: renderBotAvatar(profile.name, profile.displayName, profile.avatar, 36, 'circle'),
                        }}
                      />
                      <span className="m-member-pick-row__info">
                        <span className="m-member-pick-row__name">{profile.displayName || profile.name}</span>
                        {profile.description ? (
                          <span className="m-member-pick-row__desc">{profile.description}</span>
                        ) : null}
                      </span>
                      <span className="m-member-pick-row__check" data-picked={picked ? 'true' : 'false'}>
                        {picked ? <Check size={14} strokeWidth={2.5} /> : null}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="m-newchat__group-footer">
              <button
                type="button"
                className="m-primary-btn"
                data-testid="mobile-confirm-group-members"
                disabled={groupMembers.length < 2}
                onClick={() => onSetStep('compose')}
              >
                {t('mobile.newChat.confirmGroup', { count: groupMembers.length })}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
