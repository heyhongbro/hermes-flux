/**
 * 消息页脚（时间 + 操作按钮）· 全场景唯一实现
 *
 * 设计意图(Why)：
 *   用户消息、Bot 主工位、群聊研讨室、普通会话的页脚形态必须完全相同，
 *   差异只允许出现在「有哪些按钮」和「左右对齐」上。
 *   曾各自手写一套，导致时间格式、按钮尺寸、hover 反馈三处漂移。
 *
 * 防范的历史坑(Pitfall)：
 *   - 时间戳在助手行与用户行各出现一次，相邻消息之间出现两个时间锚点；
 *   - 按钮 hover 用整块底色，深色主题下像一块补丁；
 *   - 页脚常显，视觉噪音盖过正文。
 *
 * 约束与规则(Rules)：
 *   1. 页脚默认透明，仅在消息 hover / 内部 focus 时整体浮现；触屏设备常显；
 *   2. 时间前必须带时钟图标，与 OpenChamber 的 message-footer 一致；
 *   3. 按钮 hover 只改文字颜色，不画背景块、不加边框；
 *   4. 保留 .conv-message__footer / .assistant-footer-bar / .msg-action-btn /
 *      .time-tag / data-action 等既有钩子，宿主事件委托与测试依赖它们。
 */

import * as React from 'react';
import { Copy, GitFork, MoreHorizontal, RotateCcw } from 'lucide-react';
import { t } from '../../i18n/index.js';
import type { ConversationMessageVM, ConversationMode } from './types.js';

function CopyIcon({ size = 13 }: { size?: number }): React.ReactElement {
  return <Copy size={size} strokeWidth={1.85} aria-hidden="true" />;
}

function RollbackIcon({ size = 13 }: { size?: number }): React.ReactElement {
  return <RotateCcw size={size} strokeWidth={1.85} aria-hidden="true" />;
}

function ForkIcon({ size = 13 }: { size?: number }): React.ReactElement {
  return <GitFork size={size} strokeWidth={1.85} aria-hidden="true" />;
}

/** 时间前的时钟图标：14px，与 OpenChamber message-footer 同尺寸 */
function ClockIcon(): React.ReactElement {
  return (
    <svg
      className="conv-footer__clock"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" />
      <polyline points="12 7.5 12 12 15 13.5" />
    </svg>
  );
}

function ActionButton({
  action,
  message,
  label,
  onClick,
  children,
}: {
  action: 'copy-msg' | 'rollback-msg' | 'fork-msg';
  message: ConversationMessageVM;
  label: string;
  onClick?: () => void;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <button
      type="button"
      className="msg-action-btn"
      data-action={action}
      data-msg-id={message.id}
      data-row-id={message.rowId ?? ''}
      data-content={message.content}
      data-tooltip={label}
      aria-label={label}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

export interface ConversationMessageFooterProps {
  message: ConversationMessageVM;
  mode: ConversationMode;
  /** 角色只决定对齐方向与默认操作集，不产生第二套结构 */
  role: 'user' | 'assistant';
  /** 助手行额外信息：模型徽标、生成耗时 */
  meta?: React.ReactNode;
  /** 流式思考/中间步骤不渲染页脚，由调用方控制 */
  isStreaming?: boolean;
  /** 只读详情流：隐藏回滚与分叉并直连复制回调 */
  readOnly?: boolean;
  /** 移动端紧凑模式：默认仅展示日期时间 + 复制按钮，将回滚与 Fork 收纳进 `...` 浮层菜单 */
  compactActions?: boolean;
  onCopyMessage?: (content: string) => void;
}

export function ConversationMessageFooter({
  message,
  mode,
  role,
  meta,
  isStreaming = false,
  readOnly = false,
  compactActions = false,
  onCopyMessage,
}: ConversationMessageFooterProps): React.ReactElement | null {
  const isUser = role === 'user';
  const showMutatingActions = mode === 'scratchpad' && !readOnly;
  const [menuOpen, setMenuOpen] = React.useState(false);
  const menuWrapRef = React.useRef<HTMLSpanElement | null>(null);

  React.useEffect(() => {
    if (!menuOpen || !showMutatingActions || typeof document === 'undefined') return;
    const handleOutside = (event: PointerEvent): void => {
      if (!menuWrapRef.current?.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setMenuOpen(false);
      }
    };
    document.addEventListener('pointerdown', handleOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handleOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [menuOpen, showMutatingActions]);

  if (isStreaming) return null;

  const actions = compactActions ? (
    <span className="conv-message__actions conv-footer__actions">
      <ActionButton
        action="copy-msg"
        message={message}
        label={t('chat.copy')}
        onClick={onCopyMessage ? () => onCopyMessage(message.content) : undefined}
      >
        <CopyIcon size={13} />
      </ActionButton>
      {showMutatingActions ? (
        <span
          ref={menuWrapRef}
          className="conv-footer__more-wrap m-no-swipe"
          data-open={menuOpen ? 'true' : 'false'}
        >
          <button
            type="button"
            className="msg-action-btn conv-footer__more-btn"
            data-testid="msg-more-actions-btn"
            aria-label={t('chat.moreActions')}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((prev) => !prev)}
          >
            <MoreHorizontal size={14} strokeWidth={1.85} aria-hidden="true" />
          </button>
          {menuOpen ? (
            <div
              className="conv-footer__menu m-no-swipe"
              role="menu"
              data-testid="msg-more-actions-menu"
            >
              <button
                type="button"
                role="menuitem"
                className="msg-action-btn conv-footer__menu-item"
                data-action="rollback-msg"
                data-msg-id={message.id}
                data-row-id={message.rowId ?? ''}
                data-content={message.content}
                aria-label={t('chat.rollback')}
                onClick={() => {
                  queueMicrotask(() => setMenuOpen(false));
                }}
              >
                <RollbackIcon size={15} />
                <span>{t('chat.rollback')}</span>
              </button>
              <button
                type="button"
                role="menuitem"
                className="msg-action-btn conv-footer__menu-item"
                data-action="fork-msg"
                data-msg-id={message.id}
                data-row-id={message.rowId ?? ''}
                data-content={message.content}
                aria-label={t('chat.fork')}
                onClick={() => {
                  queueMicrotask(() => setMenuOpen(false));
                }}
              >
                <ForkIcon size={15} />
                <span>{t('chat.fork')}</span>
              </button>
            </div>
          ) : null}
        </span>
      ) : null}
    </span>
  ) : (
    <span className="conv-message__actions conv-footer__actions">
      <ActionButton
        action="copy-msg"
        message={message}
        label={t('chat.copy')}
        onClick={onCopyMessage ? () => onCopyMessage(message.content) : undefined}
      >
        <CopyIcon />
      </ActionButton>
      {showMutatingActions ? (
        <ActionButton action="rollback-msg" message={message} label={t('chat.rollback')}>
          <RollbackIcon />
        </ActionButton>
      ) : null}
      {showMutatingActions ? (
        <ActionButton action="fork-msg" message={message} label={t('chat.fork')}>
          <ForkIcon />
        </ActionButton>
      ) : null}
    </span>
  );

  // 每条消息都在自己页脚给出时间：用户与 Agent 输出共用同一时间样式
  const stamp = message.timestamp ? (
    <span className="conv-message__meta conv-footer__time time-tag">
      <ClockIcon />
      {message.timestamp}
    </span>
  ) : null;

  const visibleMeta = compactActions ? undefined : meta;
  const info = visibleMeta || stamp ? (
    <span className="conv-footer__info">
      {visibleMeta}
      {stamp}
    </span>
  ) : null;

  return (
    <div
      className={`conv-message__footer conv-footer${isUser ? ' conv-footer--user' : ' conv-footer--assistant'}${isUser ? '' : ' assistant-footer-bar'}${compactActions ? ' conv-footer--compact' : ''}`}
    >
      {compactActions || isUser ? (
        <>
          {info}
          {actions}
        </>
      ) : (
        <>
          {actions}
          {info}
        </>
      )}
    </div>
  );
}
