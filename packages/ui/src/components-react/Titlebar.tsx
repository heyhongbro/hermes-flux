import * as React from 'react';
import type { RightPodMode, TitlebarConnectionStatus } from '@hermes-flux/core';
import type { LeftRailLayoutMode } from '../tokens/leftRailLayout.js';
import { t } from '../i18n/index.js';
import {
  CloseGlyph,
  MaximizeGlyph,
  MinimizeGlyph,
  PanelLeftGlyph,
  RestoreGlyph,
  SettingsGlyph,
  StatusPanelGlyph,
} from '../icons/titlebarGlyphs.js';
import {
  GatewayHealthPopover,
  type TitlebarGatewayHealthItem,
} from './GatewayHealthPopover.js';

export interface TitlebarProps {
  platform: 'windows' | 'macos' | 'linux' | 'ios' | 'android' | 'web';
  title?: string;
  isMaximized: boolean;
  gatewayConnected: boolean;
  /** 精细化连接状态点属性（reconnecting/syncing/partial 闪烁过渡；缺失时按 gatewayConnected 回退） */
  connectionStatus?: TitlebarConnectionStatus;
  /** 多网关健康明细（点击顶栏圆点打开 GatewayHealthPopover 展示） */
  gateways?: readonly TitlebarGatewayHealthItem[];
  /** 左栏折叠态：驱动顶栏左段宽度与折叠按钮呈现（快照单一供给，不读 DOM 属性）。 */
  leftRailCollapsed: boolean;
  /** 左侧栏布局模式：grouped 模式无微轨，折叠态顶栏左段只保留按钮容量宽度。 */
  leftRailLayout?: LeftRailLayoutMode;
  /** 检查舱折叠态：驱动标题居中基准（折叠时右舱不占位，标题不得再减 420px）。 */
  inspectorCollapsed: boolean;
  /** 右侧停靠舱四态标识（closed / status / subagent / files） */
  rightPodMode?: RightPodMode['kind'];
  /** 当前全局活跃（运行中/排队中）子 Agent 数：> 0 时仅呈现微妙指示点 */
  runningSubagentCount?: number;
  /** 处于专职智能体工位或群聊工位时，顶栏呈现真实头像或拼图微头像（现按裁决留空不渲染）。 */
  activeAvatar?:
    | { kind: 'bot'; avatar?: string; name: string }
    | { kind: 'group'; members: string[]; profiles: Array<{ name: string; avatar?: string; displayName?: string }> };
  onMinimize: () => void;
  onMaximize: () => void;
  onClose: () => void;
  onToggleLeftRail: () => void;
  onToggleInspector: () => void;
  onOpenSettings: () => void;
  onReconnectGateway?: (gatewayId: string) => void;
  onDisconnectGateway?: (gatewayId: string) => void;
  onManageGateways?: () => void;
}

/**
 * 设计意图 (Why)：
 *   1. 顶栏只承担窗口控制与全局开关；
 *   2. 用户 2026-11-21 明确裁决：顶部标题栏居中保持纯粹空白，内部头像与标题全部去除，消除视觉杂噪；
 *   3. 身份与会话上下文收敛到左轨导航与对话流中。
 * 防范的历史坑 (Pitfall)：
 *   1. 顶栏曾同时挂 profile 下拉与状态栏延迟读数，出现三处身份/延迟真值面互相漂移；
 *   2. macOS 交通灯曾由主进程与本组件各画一套，屏幕上出现 6 个圆点错位重叠（现统一保留系统原生三键）；
 *   3. 保留空容器 <div className="titlebar-center" /> 维持顶栏三段式弹性占位，防范左簇与右簇布局坍塌。
 * 约束与规则 (Rules)：
 *   1. 顶栏居中保持空白，严禁挂入任何头像或标题文字；
 *   2. 本组件不持有任何 profile 状态，标题与头像由快照单一供给；
 *   3. 顶栏读数只保留连接指示点，网关延迟数字已由用户裁决移除（2026-11-20），禁止再加回文字读数；
 *   4. 深浅色切换按钮已拔除——主题唯一入口收敛到设置中心，顶栏不再跑第二条换肤真值面；
 *   5. 左簇图标（☰ / 设置）与右簇图标（检查舱 / 窗控三键）共用同一 28px 热区与同一字形网格，
 *      保证顶栏内所有元素共享一条垂直中线。
 */
export function Titlebar({ platform, isMaximized, gatewayConnected, connectionStatus, gateways, leftRailCollapsed, leftRailLayout = 'dual-rail', inspectorCollapsed, rightPodMode, runningSubagentCount = 0, onMinimize, onMaximize, onClose, onToggleLeftRail, onToggleInspector, onOpenSettings, onReconnectGateway, onDisconnectGateway, onManageGateways }: TitlebarProps): React.ReactElement {
  const [healthPopoverOpen, setHealthPopoverOpen] = React.useState(false);
  const isWindows = platform === 'windows';
  const effectivePodMode = rightPodMode ?? (inspectorCollapsed === false ? 'files' : 'closed');
  const resolvedStatus = connectionStatus ?? (gatewayConnected ? 'connected' : 'offline');
  const statusTitle =
    resolvedStatus === 'connected'
      ? t('titlebar.online')
      : resolvedStatus === 'partial'
        ? t('titlebar.partialOffline')
        : resolvedStatus === 'reconnecting'
          ? t('conn.reconnecting')
          : resolvedStatus === 'syncing'
            ? t('conn.syncing')
            : t('titlebar.offline');
  const explicitGateways = gateways && gateways.length > 0 ? gateways : null;
  const effectiveGateways: readonly TitlebarGatewayHealthItem[] =
    explicitGateways ?? [
      {
        gatewayId: '__default__',
        name: t('gateway.localNode'),
        status: resolvedStatus,
        connected: gatewayConnected,
        routeKind: 'direct',
      },
    ];

  return <header className="flux-titlebar" data-testid="react-titlebar" data-left-rail-layout={leftRailLayout} data-left-rail-collapsed={leftRailCollapsed ? 'true' : 'false'} data-inspector-collapsed={inspectorCollapsed === false ? 'false' : 'true'} data-right-pod-mode={effectivePodMode}>
    <div className="titlebar-left">
      {/* macOS 交通灯由系统原生绘制（titleBarStyle: 'hiddenInset'），此处严禁再画一套。
          历史上系统三键与本组件自绘的三键同时存在，屏幕上出现 6 个圆点错位重叠。 */}
      <button id="toggle-left-rail-btn" className="icon-btn" title={t('titlebar.toggleLeftRail')} type="button" onClick={onToggleLeftRail}><PanelLeftGlyph /></button>
      <button id="btn-open-settings" className="icon-btn" title={t('titlebar.settings')} type="button" onClick={onOpenSettings}><SettingsGlyph /></button>
    </div>
    <div className="titlebar-center" />
    <div className="titlebar-right">
      <div className="relative flex items-center">
        <button
          id="titlebar-gateway-health-btn"
          type="button"
          className="icon-btn titlebar-connection-box"
          title={statusTitle}
          aria-label={statusTitle}
          aria-haspopup="dialog"
          aria-expanded={healthPopoverOpen}
          onClick={(event) => {
            event.stopPropagation?.();
            setHealthPopoverOpen((prev) => !prev);
          }}
        >
          <span className="titlebar-connection-indicator" data-connected={gatewayConnected} data-status={resolvedStatus} />
        </button>
        {healthPopoverOpen ? (
          <GatewayHealthPopover
            gateways={effectiveGateways}
            onReconnectGateway={explicitGateways ? onReconnectGateway : undefined}
            onDisconnectGateway={explicitGateways ? onDisconnectGateway : undefined}
            onManageGateways={onManageGateways ?? onOpenSettings}
            onClose={() => setHealthPopoverOpen(false)}
          />
        ) : null}
      </div>
      <button
        id="toggle-inspector-btn"
        className="icon-btn relative"
        data-testid="toggle-status-bar-btn"
        title={t('statusPod.toggleBtn')}
        type="button"
        onClick={onToggleInspector}
      >
        <StatusPanelGlyph />
        {gatewayConnected && runningSubagentCount > 0 ? <span className="titlebar-status-dot" aria-hidden="true" /> : null}
      </button>
      {isWindows && <div className="win-caption-controls">
        <button className="win-cap-btn" id="win-min-btn" title={t('titlebar.minimize')} type="button" onClick={onMinimize}><MinimizeGlyph /></button>
        <button className="win-cap-btn" id="win-max-btn" title={isMaximized ? t('titlebar.restore') : t('titlebar.maximize')} type="button" onClick={onMaximize}>{isMaximized ? <RestoreGlyph /> : <MaximizeGlyph />}</button>
        <button className="win-cap-btn win-cap-close" id="win-close-btn" title={t('titlebar.close')} type="button" onClick={onClose}><CloseGlyph /></button>
      </div>}
    </div>
  </header>;
}
