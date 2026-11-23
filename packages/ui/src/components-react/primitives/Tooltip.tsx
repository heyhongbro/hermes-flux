import * as React from 'react';
import type { TooltipPlacement } from '../../lib/globalTooltip.js';

export interface TooltipProps {
  /** 提示文案 */
  content: string;
  /** 首选展现方位，默认 top */
  placement?: TooltipPlacement;
  /** 子元素（单一 React 元素） */
  children: React.ReactElement<Record<string, unknown>>;
  /** 显式禁用提示 */
  disabled?: boolean;
}

/**
 * Hermes Flux React 声明式 Tooltip 微组件
 *
 * 【设计意图 (Why)】
 * 为 React 组件树提供干净声明式的 Tooltip 接入。
 * 自身不渲染额外的 DOM 节点包裹层，而是通过 React.cloneElement 为单个子元素注入
 * `data-tooltip` 与 `data-tooltip-placement` 属性，与底层全局单例 Tooltip 引擎无缝联动。
 * 彻底避免额外 div 破坏 flex/grid 栅格几何与布局流。
 *
 * 【约束规则 (Rules)】
 * 1. 纯表现层组件，只接受单个 React.ReactElement 子元素；
 * 2. 严禁渲染原生 title 属性，彻底消除浏览器黑框墨渍隐患；
 * 3. 对通用无角色容器（div/span/p）、表单控件（input/textarea/select）或已有 id /
 *    aria-label / aria-labelledby 的元素绝不注入 aria-label，防止覆盖关联 label 或污染无角色节点。
 */
export function Tooltip({
  content,
  placement = 'top',
  children,
  disabled = false,
}: TooltipProps): React.ReactElement {
  if (disabled || !content || !React.isValidElement(children)) {
    return children;
  }

  const childProps = children.props as Record<string, unknown>;
  const tag = typeof children.type === 'string' ? children.type : '';
  const skipAriaLabel =
    tag === 'div' ||
    tag === 'span' ||
    tag === 'p' ||
    tag === 'input' ||
    tag === 'textarea' ||
    tag === 'select' ||
    Boolean(childProps['aria-label'] || childProps['aria-labelledby'] || childProps.id);
  const injected: Record<string, unknown> = {
    'data-tooltip': content,
    'data-tooltip-placement': placement,
  };
  if (!skipAriaLabel) {
    injected['aria-label'] = content;
  }

  return React.cloneElement(children, injected as React.Attributes & Record<string, unknown>);
}
