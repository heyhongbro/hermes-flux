/**
 * 桌面端新建会话与多智能体群聊弹窗 (NewChatDialog)。
 *
 * 【设计意图 (Why)】
 *   1:1 借鉴移动端 `MobileNewChatSheet` 的极简两步选角流与纯哑光表面语言：
 *   1. 第一步 (`mode === 'solo'`，默认入口)：直接列出所有可用智能体，点击任一智能体名称立即创建并进入会话，无需点击确认；
 *      列表底部提供「发起多智能体群聊 ›」入口，点击切换至第二步多选成员；
 *   2. 第二步 (`mode === 'group'`)：顶部返回钮 + 无外框纯哑光内嵌列表 + 柔和选中态，选中 ≥2 位智能体后点击「确认创建」，
 *      自动由所选成员名称派生群聊标题，无需手工填写会话/群聊名称；
 *   3. 拒绝生硬盒中盒边框分割，统一使用 4px 整数网格留白与纯哑光表面阶梯拉开层级。
 *
 * 【防范的历史坑 (Pitfall)】
 *   1. 弹窗关闭时直接卸载内部主体 `NewChatDialogBody`，从根源消灭零帧闪回与跨次打开的陈旧锁/错误残留；
 *   2. 使用单调递增令牌锁 `createNewChatSubmitGate()` 拦截连击重入与在途关窗重开后的陈旧 finally 解锁；
 *   3. 提交期间锁定选角/工作区/切步控件，RPC 失败或 reject 时在弹窗内直接展示 `[data-testid="new-chat-error"]`
 *      高对比错误条（绝不藏到 backdrop 遮罩后的 dockNotice）；
 *   4. 所有图标按钮一律消费 `<Tooltip>`，严禁出现原生 `title` 黑块墨渍。
 *
 * 【约束与规则 (Rules)】
 *   - 关闭态返回 null；
 *   - `DialogContent` 全量收编 `primitives/Dialog`（`portal={false}`、唯一 `bg-backdrop/80` 遮罩、IME 保护 Esc）；
 *   - 所有文案全量走 `t()` 国际化字典。
 */

import * as React from 'react';
import { Check, ChevronLeft, ChevronRight, Users, X } from 'lucide-react';
import { t } from '../i18n/index.js';
import { Button } from './primitives/Button.js';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './primitives/Dialog.js';
import { Select } from './primitives/Select.js';
import { Tooltip } from './primitives/Tooltip.js';
import { Avatar, CollageAvatar } from './RailEntityRow.js';
import type { LeftRailProfile } from './leftRailModel.js';
import {
  buildAutoGroupTitle,
  buildNewChatSubmitPayload,
  createNewChatSubmitGate,
  resolveValidProjectId,
  toggleGroupMember,
  type NewChatDialogActions,
  type NewChatDialogSnapshot,
  type NewChatMode,
  type NewChatSubmitPayload,
} from './newChatModel.js';

export interface NewChatDialogProps {
  snapshot: NewChatDialogSnapshot;
  actions: NewChatDialogActions;
}

function NewChatDialogBody({ snapshot, actions }: NewChatDialogProps): React.ReactElement {
  const { initialMode, profiles, projects, selectedProjectId, gatewayConnected } = snapshot;

  const [mode, setMode] = React.useState<NewChatMode>(initialMode);
  const [selectedMembers, setSelectedMembers] = React.useState<string[]>([]);
  const [projectId, setProjectId] = React.useState<string>(() =>
    resolveValidProjectId(projects, selectedProjectId),
  );
  const [submitting, setSubmitting] = React.useState<boolean>(false);
  const [submitError, setSubmitError] = React.useState<string | null>(null);

  const mountedRef = React.useRef<boolean>(true);
  const userPickedProjectRef = React.useRef<boolean>(false);
  const submitGateRef = React.useRef(createNewChatSubmitGate());

  React.useEffect(() => {
    mountedRef.current = true;
    const gate = submitGateRef.current;
    return () => {
      mountedRef.current = false;
      gate.reset();
    };
  }, []);

  React.useEffect(() => {
    if (!userPickedProjectRef.current && !projectId && projects.length > 0) {
      const valid = resolveValidProjectId(projects, selectedProjectId);
      if (valid) setProjectId(valid);
    }
  }, [projects, selectedProjectId, projectId]);

  const displayProfiles: LeftRailProfile[] =
    profiles.length > 0
      ? profiles
      : [
          {
            name: 'default',
            displayName: t('rail.defaultAssistant'),
            description: t('rail.defaultBotRole'),
            isDefault: true,
          },
        ];

  const isGroup = mode === 'group';
  const canSubmitGroup = gatewayConnected && selectedMembers.length >= 2;
  const resolvedGroupName = buildAutoGroupTitle(
    selectedMembers,
    displayProfiles,
    t('chat.defaultGroupTitle'),
  );

  const handleModeSwitch = (nextMode: NewChatMode): void => {
    if (submitting || nextMode === mode) return;
    setSubmitError(null);
    setMode(nextMode);
    actions.onModeChange?.(nextMode);
  };

  const runSubmit = async (payload: NewChatSubmitPayload): Promise<void> => {
    const gate = submitGateRef.current;
    const token = gate.begin();
    if (token === null) return;
    setSubmitError(null);
    setSubmitting(true);
    try {
      const result = await actions.onSubmit(payload);
      if (mountedRef.current && result && typeof result === 'object' && result.ok === false) {
        setSubmitError(result.error || t('newChat.createFailed'));
      }
    } catch (err) {
      if (mountedRef.current) {
        setSubmitError(err instanceof Error && err.message ? err.message : t('newChat.createFailed'));
      }
    } finally {
      if (gate.end(token) && mountedRef.current) {
        setSubmitting(false);
      }
    }
  };

  const handleSelectAgent = async (botName: string): Promise<void> => {
    if (!gatewayConnected || submitGateRef.current.isBusy()) return;
    const outcome = buildNewChatSubmitPayload({
      mode: 'solo',
      selectedBot: botName,
      selectedMembers: [],
      title: '',
      projectId,
      firstMessage: '',
    });
    if (!outcome.ok) return;
    await runSubmit(outcome.payload);
  };

  const handleConfirmGroup = async (): Promise<void> => {
    if (!canSubmitGroup || submitGateRef.current.isBusy()) return;
    const outcome = buildNewChatSubmitPayload({
      mode: 'group',
      selectedBot: selectedMembers[0] || 'default',
      selectedMembers,
      title: resolvedGroupName,
      firstMessage: '',
    });
    if (!outcome.ok) return;
    await runSubmit(outcome.payload);
  };

  const workspaceGroups =
    projects.length > 0
      ? [
          {
            label: '',
            options: [
              { value: '', label: t('modal.defaultWorkspace') },
              ...projects.map((p) => ({ value: p.id, label: p.name })),
            ],
          },
        ]
      : [];

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) actions.onClose();
      }}
    >
      <DialogContent
        portal={false}
        data-testid="new-chat-dialog"
        data-mode={mode}
        onEscapeKeyDown={(event) => {
          if (event.isComposing || event.keyCode === 229) {
            event.preventDefault();
          }
        }}
        style={{ width: 'calc(100vw - 32px)', maxWidth: '400px' }}
        className="flux-new-chat-dialog flex max-h-modal-sm flex-col gap-0 overflow-hidden rounded-window border-border-subtle bg-popover p-0"
      >
        {!isGroup ? (
          <>
            <header className="flex items-center justify-between gap-2 px-5 pb-2 pt-4">
              <DialogTitle className="truncate text-title font-semibold text-foreground">
                {t('newChat.dialogTitle')}
              </DialogTitle>
              <DialogDescription className="sr-only">{t('newChat.chooseAgent')}</DialogDescription>
              <Tooltip content={t('newChat.close')} placement="bottom">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={t('newChat.close')}
                  onClick={actions.onClose}
                  className="shrink-0 rounded-full text-muted-foreground hover:text-foreground"
                >
                  <X size={14} aria-hidden="true" />
                </Button>
              </Tooltip>
            </header>

            <div className="flex min-h-0 flex-1 flex-col gap-2 px-3 pb-3">
              {submitError ? (
                <div
                  role="alert"
                  data-testid="new-chat-error"
                  className="mx-2 rounded-panel bg-input px-3 py-2 text-caption text-destructive"
                >
                  {submitError}
                </div>
              ) : null}

              {!gatewayConnected ? (
                <div className="mx-2 rounded-panel bg-input px-3 py-2 text-caption text-warning">
                  {t('newChat.offlineHint')}
                </div>
              ) : null}

              {projects.length > 0 ? (
                <div className="px-1">
                  <Select
                    id="new-chat-project-select"
                    size="sm"
                    disabled={submitting}
                    value={projectId}
                    groups={workspaceGroups}
                    placeholder={t('modal.defaultWorkspace')}
                    ariaLabel={t('modal.workspaceLabel')}
                    contentClassName="w-menu-trigger"
                    onChange={(next) => {
                      userPickedProjectRef.current = true;
                      setProjectId(next);
                    }}
                  />
                </div>
              ) : null}

              <div className="px-2 pt-1 text-caption font-medium text-muted-foreground">
                {t('newChat.chooseAgent')}
              </div>

              <div
                role="list"
                className="scrollbar-thin flex max-h-picker-menu flex-col gap-1 overflow-y-auto"
              >
                {displayProfiles.map((profile) => (
                  <button
                    key={profile.name}
                    type="button"
                    data-new-chat-bot={profile.name}
                    disabled={!gatewayConnected || submitting}
                    onClick={() => void handleSelectAgent(profile.name)}
                    className="group flex min-h-12 w-full items-center gap-3 rounded-window px-3 py-2 text-left transition-colors hover:bg-card-hover active:bg-card-active disabled:pointer-events-none disabled:opacity-50"
                  >
                    <Avatar profile={profile} size={36} shape="circle" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-body font-medium text-foreground">
                        {profile.displayName || profile.name}
                      </span>
                      <span className="block truncate text-caption text-muted-foreground">
                        {(profile.description || '').trim() || t('newChat.noDescription')}
                      </span>
                    </span>
                    <ChevronRight
                      size={15}
                      aria-hidden="true"
                      className="shrink-0 text-muted-foreground transition-colors group-hover:text-foreground"
                    />
                  </button>
                ))}
              </div>

              <div className="pt-1">
                <button
                  type="button"
                  data-testid="new-chat-start-group"
                  disabled={submitting}
                  onClick={() => handleModeSwitch('group')}
                  className="group flex min-h-12 w-full items-center gap-3 rounded-window surface-raised px-3 py-2 text-left transition-colors hover:bg-card-hover active:bg-card-active disabled:pointer-events-none disabled:opacity-50"
                >
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary-subtle text-primary">
                    <Users size={16} aria-hidden="true" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-body font-medium text-foreground">
                      {t('newChat.startGroup')}
                    </span>
                    <span className="block truncate text-caption text-muted-foreground">
                      {t('newChat.startGroupDesc')}
                    </span>
                  </span>
                  <ChevronRight
                    size={15}
                    aria-hidden="true"
                    className="shrink-0 text-muted-foreground transition-colors group-hover:text-foreground"
                  />
                </button>
              </div>
            </div>
          </>
        ) : (
          <>
            <header className="flex items-center justify-between gap-2 px-4 pb-2 pt-4">
              <Tooltip content={t('newChat.back')} placement="bottom">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  data-testid="new-chat-back-btn"
                  aria-label={t('newChat.back')}
                  disabled={submitting}
                  onClick={() => handleModeSwitch('solo')}
                  className="shrink-0 rounded-full text-muted-foreground hover:text-foreground"
                >
                  <ChevronLeft size={16} aria-hidden="true" />
                </Button>
              </Tooltip>
              <DialogTitle className="min-w-0 flex-1 truncate text-title font-semibold text-foreground">
                {t('newChat.groupStepTitle')}
              </DialogTitle>
              <DialogDescription className="sr-only">{t('modal.selectMembers')}</DialogDescription>
              <Tooltip content={t('newChat.close')} placement="bottom">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={t('newChat.close')}
                  onClick={actions.onClose}
                  className="shrink-0 rounded-full text-muted-foreground hover:text-foreground"
                >
                  <X size={14} aria-hidden="true" />
                </Button>
              </Tooltip>
            </header>

            <div className="flex min-h-0 flex-1 flex-col gap-3 px-4 pb-3">
              {submitError ? (
                <div
                  role="alert"
                  data-testid="new-chat-error"
                  className="rounded-panel bg-input px-3 py-2 text-caption text-destructive"
                >
                  {submitError}
                </div>
              ) : null}

              <div className="flex items-center justify-between gap-3 px-1">
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  <CollageAvatar members={selectedMembers} profiles={displayProfiles} size={24} />
                  <span className="truncate text-aux font-medium text-foreground">
                    {resolvedGroupName}
                  </span>
                </div>
                <span className="shrink-0 text-caption text-muted-foreground">
                  {selectedMembers.length < 2
                    ? t('newChat.minMembersHint')
                    : t('newChat.selectedMembersCount', { count: String(selectedMembers.length) })}
                </span>
              </div>

              <div
                role="group"
                aria-label={t('modal.selectMembers')}
                className="scrollbar-thin flex max-h-picker-menu flex-col gap-1 overflow-y-auto rounded-window bg-input p-2"
              >
                {displayProfiles.map((profile) => {
                  const picked = selectedMembers.some(
                    (name) => name.toLowerCase() === profile.name.toLowerCase(),
                  );
                  return (
                    <button
                      key={profile.name}
                      type="button"
                      role="checkbox"
                      aria-checked={picked}
                      disabled={submitting}
                      data-new-chat-member={profile.name}
                      onClick={() => {
                        setSubmitError(null);
                        setSelectedMembers((prev) => toggleGroupMember(prev, profile.name));
                      }}
                      className={`flex min-h-12 w-full items-center gap-3 rounded-panel px-3 py-2 text-left transition-colors disabled:pointer-events-none disabled:opacity-50 ${
                        picked
                          ? 'bg-card text-foreground shadow-card'
                          : 'text-secondary-foreground hover:bg-card-hover hover:text-foreground'
                      }`}
                    >
                      <Avatar profile={profile} size={36} shape="circle" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-body font-medium text-foreground">
                          {profile.displayName || profile.name}
                        </span>
                        {(profile.description || '').trim() ? (
                          <span className="block truncate text-caption text-muted-foreground">
                            {profile.description}
                          </span>
                        ) : null}
                      </span>
                      <span
                        className={`flex size-5 shrink-0 items-center justify-center rounded-full border transition-colors ${
                          picked
                            ? 'border-primary bg-primary text-primary-foreground'
                            : 'border-border-strong bg-transparent'
                        }`}
                      >
                        {picked ? <Check size={12} strokeWidth={2.5} aria-hidden="true" /> : null}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            <footer className="flex items-center justify-between gap-3 px-4 pb-4 pt-2">
              {!gatewayConnected ? (
                <span className="truncate text-caption text-warning">{t('newChat.offlineHint')}</span>
              ) : (
                <span />
              )}
              <div className="flex shrink-0 items-center gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="rounded-panel text-secondary-foreground hover:text-foreground"
                  onClick={actions.onClose}
                >
                  {t('modal.cancel')}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  data-testid="new-chat-submit-btn"
                  disabled={!canSubmitGroup || submitting}
                  onClick={() => void handleConfirmGroup()}
                  className="rounded-panel bg-primary px-4 font-semibold text-primary-foreground hover:bg-primary-hover active:bg-primary-hover disabled:opacity-40"
                >
                  {selectedMembers.length >= 2
                    ? t('newChat.confirmCreateCount', { count: String(selectedMembers.length) })
                    : t('newChat.confirmCreate')}
                </Button>
              </div>
            </footer>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function NewChatDialog({ snapshot, actions }: NewChatDialogProps): React.ReactElement | null {
  if (!snapshot.isOpen) return null;
  return <NewChatDialogBody snapshot={snapshot} actions={actions} />;
}
