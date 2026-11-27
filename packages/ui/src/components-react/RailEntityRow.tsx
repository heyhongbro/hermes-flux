/**
 * 左轨共享实体行与身份展示组件 (RailEntityRow / Avatar / CollageAvatar / RowTime / RenameGroup)。
 *
 * 【设计意图 (Why)】
 *   经典双轨左轨（LeftRail）与单栏分组左轨（GroupedLeftRail）以及新建会话弹窗共用同一套
 *   实体行、头像、拼贴头像、紧凑时间与群聊行内重命名组件，彻底消灭同构 JSX 重复，确保全端尺寸、
 *   间距、字体与交互反馈 100% 同源。
 *
 * 【防范的历史坑 (Pitfall)】
 *   1. 若双轨与分组模式各自维护一份实体行实现，很快会出现 active 底色、字重、时间右缘间距与骨架高度漂移；
 *   2. 圆形头像仅在明确传 `shape="circle"` 时启用（用于分组列表对标移动端首页质感与弹窗英雄区），
 *      经典双轨主工位卡保持既有 `'rounded'`（8px）形态不变，避免破坏既有回归基线。
 *
 * 【约束与规则 (Rules)】
 *   1. 尺寸与间距以普通会话为基准（min-h-12, px-2, py-1, gap-2）；
 *   2. 严格复用 primitives（Button / Input / Skeleton / ActivityIndicator），禁止自造样式轮子；
 *   3. 时间与摘要均为纯展示，禁止在渲染热路径引入 Intl。
 */

import * as React from 'react';
import { Check, RotateCcw, WifiOff } from 'lucide-react';
import { t } from '../i18n/index.js';
import { renderBotAvatar, renderGroupCollageAvatar } from '../utils/botAvatar.js';
import { Button } from './primitives/Button.js';
import { Input } from './primitives/Input.js';
import { Skeleton } from './primitives/Skeleton.js';
import { ActivityIndicator, type ActivityEntityKind } from './primitives/ActivityIndicator.js';
import type { ActivityIndicatorVariant } from '../tokens/activityIndicator.js';
import type { RailEntityGatewayBadge } from '../components/LeftRail/types.js';
import {
  formatLeftRailTime,
  type ActivityTransition,
  type LeftRailProfile,
  type LeftRailSession,
} from './leftRailModel.js';

/** 头像只复用既有资产管线（真实 <img> / 几何图腾 SVG），避免第二套身份渲染分叉。 */
export function Avatar({
  profile,
  size,
  shape = 'rounded',
}: {
  profile: Pick<LeftRailProfile, 'name' | 'displayName' | 'avatar'>;
  size: number | string;
  shape?: 'rounded' | 'circle';
}): React.ReactElement {
  return (
    <span
      aria-hidden="true"
      className="inline-flex shrink-0"
      dangerouslySetInnerHTML={{
        __html: renderBotAvatar(profile.name, profile.displayName, profile.avatar, size, shape),
      }}
    />
  );
}

/**
 * 群聊拼图头像。
 * 【设计意图】群聊没有单一身份，多人拼贴是它唯一可辨识的视觉签名，必须与其它行区分开。
 * 【约束与规则】资产管线复用 botAvatar 的单一实现，组件内不自造第二套头像逻辑。
 */
export function CollageAvatar({
  members,
  profiles,
  size,
  gatewayId,
}: {
  members: string[];
  profiles: LeftRailProfile[];
  size: number;
  gatewayId?: string;
}): React.ReactElement {
  return (
    <span
      aria-hidden="true"
      className="inline-flex shrink-0"
      dangerouslySetInnerHTML={{ __html: renderGroupCollageAvatar(members, profiles, size, gatewayId) }}
    />
  );
}

/**
 * 行内时间。
 * 【设计意图】优先展示上游已经格式化好的时间串（core 的 syncBotProfiles 产出 lastTime，
 *   壳层 fetchSessions 产出 time），只有在完全没有字符串时才用本地紧凑格式兜底。
 * 【约束与规则】时间是纯展示，禁止在这里做 Intl 或时区换算。
 */
export function RowTime({
  timestamp,
  fallback,
}: {
  timestamp?: number;
  fallback?: string;
}): React.ReactElement | null {
  const provided = (fallback || '').trim();
  const value = provided || formatLeftRailTime(timestamp);
  if (!value) return null;
  let iso: string | undefined;
  if (typeof timestamp === 'number' && Number.isFinite(timestamp) && timestamp !== 0) {
    const ms = timestamp > 1e11 ? timestamp : timestamp * 1000;
    const parsed = new Date(ms);
    if (Number.isFinite(parsed.getTime())) {
      iso = parsed.toISOString();
    }
  }
  return (
    <time className="shrink-0 font-code text-caption text-muted-foreground tabular-nums" dateTime={iso}>
      {value}
    </time>
  );
}

export interface RailRowHoverAction {
  label: string;
  ariaLabel: string;
  icon: 'done' | 'restore';
  onAction: () => void;
}

export interface RailEntityRowProps {
  className?: string;
  active: boolean;
  compact?: boolean;
  avatar?: React.ReactNode;
  title: string;
  subtitle?: string;
  timestamp?: number;
  timeFallback?: string;
  activityState?: LeftRailSession['activityState'];
  activityTransition?: ActivityTransition;
  activityTransitionToken?: number;
  entityKind?: ActivityEntityKind;
  activityVariant?: ActivityIndicatorVariant;
  titleAttr?: string;
  /** 多网关次级来源短标签（仅多网关模式传入；非紧凑行固定落在 Row 2 subtitle 左侧）。 */
  gatewayBadge?: RailEntityGatewayBadge;
  /** 骨架占位行：loading 时禁用点击、不渲染时间与活动点，仅保留头像槽位与两条占位条。 */
  loading?: boolean;
  /** 骨架行的 data-skeleton 标记（仅 loading 时输出），供探针区分会话行与主工位卡。 */
  skeletonSlot?: string;
  hoverAction?: RailRowHoverAction;
  onClick?: () => void;
  onContextMenu?: (event: React.MouseEvent) => void;
  dataAttributes?: Record<string, string>;
}

/** 统一实体来源短标签微标：桌面侧栏与移动端实体行共用同一发丝线微标样式。 */
export function EntityGatewayBadgePill({ badge }: { badge: RailEntityGatewayBadge }): React.ReactElement {
  return (
    <span
      data-gateway-badge={badge.label}
      className="inline-flex max-w-16 shrink-0 items-center gap-1 rounded-inner border border-border-subtle px-1 font-code text-micro text-muted-foreground"
    >
      {badge.offline ? (
        <WifiOff size={10} strokeWidth={2} className="shrink-0 text-muted-foreground" aria-hidden="true" />
      ) : null}
      <span className="truncate">{badge.label}</span>
    </span>
  );
}

/**
 * 左侧实体行通用组件 (RailEntityRow)。
 * 【设计意图】普通会话、群聊会话与 Agent 主工位卡片（双轨/分组双模式）共用唯一行容器，
 *   消除同构代码与尺寸/间距漂移。
 */
export function RailEntityRow({
  className = '',
  active,
  compact,
  avatar,
  title,
  subtitle,
  timestamp,
  timeFallback,
  activityState,
  activityTransition,
  activityTransitionToken,
  entityKind,
  activityVariant,
  titleAttr,
  gatewayBadge,
  loading = false,
  skeletonSlot = 'session',
  hoverAction,
  onClick,
  onContextMenu,
  dataAttributes,
}: RailEntityRowProps): React.ReactElement {
  const isOffline = Boolean(gatewayBadge?.offline);
  const badgePill = gatewayBadge ? <EntityGatewayBadgePill badge={gatewayBadge} /> : null;

  const mainButton = (
    <button
      type="button"
      disabled={loading}
      aria-busy={loading}
      className={`${className} ${hoverAction && !loading ? '' : 'group '}relative flex w-full items-center gap-2 rounded-card px-2 py-1 text-left transition-colors duration-150 ${
        compact ? 'min-h-8' : 'min-h-12'
      } ${
        loading
          ? ''
          : active
            ? 'active bg-card-active text-foreground'
            : 'hover:bg-card-hover/80 text-secondary-foreground hover:text-foreground'
      }${!loading && isOffline ? ' opacity-60' : ''}`}
      title={titleAttr}
      onClick={loading ? undefined : onClick}
      onContextMenu={loading ? undefined : onContextMenu}
      {...(loading
        ? { 'data-skeleton': skeletonSlot }
        : {
            'data-entity-row': entityKind || 'entity',
            ...(isOffline ? { 'data-gateway-offline': 'true' } : {}),
            ...(dataAttributes || {}),
          })}
    >
      {avatar && <span aria-hidden="true" className="shrink-0 flex items-center justify-center">{avatar}</span>}
      {loading ? (
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          {/* h-5 / h-4 对齐真实行的 text-body(20px) 与 text-aux(18px) 行盒，骨架→真实行不跳动。 */}
          <Skeleton className="h-5 w-2/3 rounded-full" />
          <Skeleton className="h-4 w-1/2 rounded-full" />
        </span>
      ) : (
        <span className="flux-rail-entity-col flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex min-w-0 items-center justify-between gap-2">
            <span className="flex min-w-0 items-center gap-1">
              <span className="truncate text-body font-medium text-foreground">{title}</span>
              {compact && badgePill ? badgePill : null}
            </span>
            <span className="ml-auto flex shrink-0 items-center gap-1">
              <ActivityIndicator
                state={activityState}
                transition={activityTransition}
                transitionToken={activityTransitionToken}
                placement="inline"
                entityKind={entityKind}
                variant={activityVariant}
              />
              {hoverAction ? (
                <span className="group-hover:invisible group-focus-within:invisible">
                  <RowTime timestamp={timestamp} fallback={timeFallback} />
                </span>
              ) : (
                <RowTime timestamp={timestamp} fallback={timeFallback} />
              )}
            </span>
          </span>
          {!compact && (badgePill || subtitle) && (
            <span className="flex min-w-0 items-center gap-1">
              {badgePill}
              {subtitle ? (
                <span className="min-w-0 flex-1 truncate text-aux font-normal text-muted-foreground/90">
                  {subtitle}
                </span>
              ) : null}
            </span>
          )}
        </span>
      )}
    </button>
  );

  if (loading || !hoverAction) {
    return mainButton;
  }

  return (
    <div className="group relative flex w-full items-center" data-entity-row={entityKind || 'entity'}>
      {mainButton}
      <button
        type="button"
        data-row-hover-action={hoverAction.icon}
        aria-label={hoverAction.ariaLabel}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
        onClick={(event) => {
          event.stopPropagation();
          hoverAction.onAction();
        }}
        className="flux-row-hover-action absolute right-2 top-1/2 z-10 hidden min-h-7 shrink-0 -translate-y-1/2 cursor-pointer items-center gap-1 rounded-full border border-border-subtle bg-secondary px-2 py-1 text-micro font-medium text-secondary-foreground transition-colors hover:bg-card-active hover:text-foreground group-hover:inline-flex group-focus-within:inline-flex focus-visible:inline-flex focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {hoverAction.icon === 'done' ? (
          <Check size={11} strokeWidth={2.2} aria-hidden="true" />
        ) : (
          <RotateCcw size={11} strokeWidth={2.2} aria-hidden="true" />
        )}
        <span>{hoverAction.label}</span>
      </button>
    </div>
  );
}

/** 群聊行内重命名受控表单（双轨与分组模式复用同一交互与 ID 契约）。 */
export function RenameGroup({
  initialName,
  roomId,
  onConfirm,
  onCancel,
}: {
  initialName: string;
  roomId: string;
  onConfirm: (name: string) => void;
  onCancel: () => void;
}): React.ReactElement {
  const [value, setValue] = React.useState(initialName);
  return (
    <form
      className="flex min-w-0 flex-1 items-center gap-1"
      onSubmit={(event) => {
        event.preventDefault();
        onConfirm(value.trim());
      }}
    >
      <Input
        id={`rail-group-rename-input-${roomId}`}
        size="xs"
        className="rail-group-rename-input min-w-0 flex-1 rounded-inner border-primary bg-panel"
        value={value}
        onChange={(event) => setValue(event.currentTarget.value)}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            onCancel();
          }
        }}
        autoFocus
      />
      <Button
        type="submit"
        size="xs"
        className="btn-confirm-group-rename rounded-inner"
        title={t('common.confirm')}
      >
        {t('common.confirm')}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        className="btn-cancel-group-rename rounded-inner text-muted-foreground"
        title={t('common.cancel')}
        onClick={onCancel}
      >
        {t('common.cancel')}
      </Button>
    </form>
  );
}
