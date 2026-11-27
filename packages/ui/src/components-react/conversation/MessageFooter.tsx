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
import { MoreHorizontal } from 'lucide-react';
import { t } from '../../i18n/index.js';
import type { ConversationMessageVM, ConversationMode } from './types.js';

/**
 * 静态图标常量工厂（MessageFooter 热路径优化）
 *
 * 【设计意图 (Why)】
 *   5000 条长会话基准每次渲染 200 条消息页脚（= 600 个操作图标 + 200 个时钟图标）。
 *   直接使用 Lucide React 的 forwardRef 包装组件会额外触发 600 次组件协调；
 *   预生成保留 Lucide 同款路径与 `lucide lucide-*` 类名的静态 SVG 元素常量，兼顾像素一致与零分配热路径。
 * 【约束与规则 (Rules)】
 *   - 保持 `lucide lucide-copy` / `lucide lucide-rotate-ccw` / `lucide lucide-git-fork` 类名与 24×24 几何不变；
 *   - 桌面端页脚主函数保持零 React Hook，仅移动端 `CompactMoreActionsMenu` 持有浮层开关状态。
 */
function createFooterIcon(size: number, cls: string, body: React.ReactNode): React.ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.85"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cls}
      aria-hidden="true"
    >
      {body}
    </svg>
  );
}

const COPY_ICON_13 = createFooterIcon(
  13,
  'lucide lucide-copy',
  <>
    <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
    <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
  </>,
);

const ROLLBACK_PATHS = (
  <>
    <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
    <path d="M3 3v5h5" />
  </>
);

const FORK_PATHS = (
  <>
    <circle cx="12" cy="18" r="3" />
    <circle cx="6" cy="6" r="3" />
    <circle cx="18" cy="6" r="3" />
    <path d="M18 9v2c0 .6-.4 1-1 1H7c-.6 0-1-.4-1-1V9" />
    <path d="M12 12v3" />
  </>
);

const ROLLBACK_ICON_13 = createFooterIcon(13, 'lucide lucide-rotate-ccw', ROLLBACK_PATHS);
const ROLLBACK_ICON_15 = createFooterIcon(15, 'lucide lucide-rotate-ccw', ROLLBACK_PATHS);
const FORK_ICON_13 = createFooterIcon(13, 'lucide lucide-git-fork', FORK_PATHS);
const FORK_ICON_15 = createFooterIcon(15, 'lucide lucide-git-fork', FORK_PATHS);

/** 时间前的时钟图标：14px，与 OpenChamber message-footer 同尺寸 */
const CLOCK_ICON_14 = (
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

function CompactMoreActionsMenu({
  message,
}: {
  message: ConversationMessageVM;
}): React.ReactElement {
  const [menuOpen, setMenuOpen] = React.useState(false);
  const menuWrapRef = React.useRef<HTMLSpanElement | null>(null);

  React.useEffect(() => {
    if (!menuOpen || typeof document === 'undefined') return;
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
  }, [menuOpen]);

  return (
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
            {ROLLBACK_ICON_15}
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
            {FORK_ICON_15}
            <span>{t('chat.fork')}</span>
          </button>
        </div>
      ) : null}
    </span>
  );
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
  if (isStreaming) return null;

  const isUser = role === 'user';
  const showMutatingActions = mode === 'scratchpad' && !readOnly;

  const actions = compactActions ? (
    <span className="conv-message__actions conv-footer__actions">
      <ActionButton
        action="copy-msg"
        message={message}
        label={t('chat.copy')}
        onClick={onCopyMessage ? () => onCopyMessage(message.content) : undefined}
      >
        {COPY_ICON_13}
      </ActionButton>
      {showMutatingActions ? <CompactMoreActionsMenu message={message} /> : null}
    </span>
  ) : (
    <span className="conv-message__actions conv-footer__actions">
      <ActionButton
        action="copy-msg"
        message={message}
        label={t('chat.copy')}
        onClick={onCopyMessage ? () => onCopyMessage(message.content) : undefined}
      >
        {COPY_ICON_13}
      </ActionButton>
      {showMutatingActions ? (
        <ActionButton action="rollback-msg" message={message} label={t('chat.rollback')}>
          {ROLLBACK_ICON_13}
        </ActionButton>
      ) : null}
      {showMutatingActions ? (
        <ActionButton action="fork-msg" message={message} label={t('chat.fork')}>
          {FORK_ICON_13}
        </ActionButton>
      ) : null}
    </span>
  );

  // 每条消息都在自己页脚给出时间：用户与 Agent 输出共用同一时间样式
  const stamp = message.timestamp ? (
    <span className="conv-message__meta conv-footer__time time-tag">
      {CLOCK_ICON_14}
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
