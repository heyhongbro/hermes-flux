import * as React from 'react';
import { cn } from '../../lib/utils.js';

/**
 * 设置中心的分段选择控件（唯一实现，两档外观形态 + compact 态 GPU 滑块）。
 *
 * 【设计意图 (Why)】
 *   视角切换、量表档位、语言选择、添加弹窗双页签及技能详情模式切换共用同一语义与 ARIA 规范。
 *   把平滑滑移的 Glider 与双栏 tabs 形态收敛到唯一组件后，全局零样式双标。
 *
 * 【约束与规则 (Rules)】
 *   1. 只用语义 Token 与 4px 网格，不写色值、不用旧刻度；
 *   2. `compact`（默认）：无外框半透轨道（`bg-foreground/5`）+ min-h-9 轨道 + h-7 GPU 浮起滑块（`bg-popover`），确保在 5 套皮肤与 `SettingInset` 内外均拉开层次；
 *   3. `tabs`：满宽双栏无框哑光页签（36px 触控高度 + `surface-raised` 轨道 + `bg-popover` 选中页签）。
 */
export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  variant = 'compact',
  className = '',
}: {
  value: T;
  options: Array<{ value: T; label: string; icon?: React.ReactNode }>;
  onChange: (value: T) => void;
  ariaLabel: string;
  variant?: 'compact' | 'tabs';
  className?: string;
}): React.ReactElement {
  const trackRef = React.useRef<HTMLDivElement>(null);
  const btnRefs = React.useRef<Map<string, HTMLButtonElement>>(new Map());
  const [glider, setGlider] = React.useState<{ left: number; width: number } | null>(null);

  const measure = React.useCallback((): void => {
    if (variant === 'tabs') return;
    const activeBtn = btnRefs.current.get(value);
    if (!activeBtn || activeBtn.offsetWidth <= 0) {
      setGlider(null);
      return;
    }
    const next = { left: activeBtn.offsetLeft, width: activeBtn.offsetWidth };
    setGlider((prev) => (prev && prev.left === next.left && prev.width === next.width ? prev : next));
  }, [value, variant]);

  React.useLayoutEffect(() => {
    if (variant === 'tabs') return;
    measure();
    const track = trackRef.current;
    if (!track || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(track);
    for (const el of btnRefs.current.values()) observer.observe(el);
    return () => observer.disconnect();
  }, [measure, options, variant]);

  if (variant === 'tabs') {
    return (
      <div
        role="tablist"
        aria-label={ariaLabel}
        className={cn(
          options.length === 2 ? 'grid grid-cols-2' : 'flex',
          'w-full gap-1 rounded-panel surface-raised p-1',
          className,
        )}
      >
        {options.map((option) => {
          const active = option.value === value;
          return (
            <button
              key={option.value}
              type="button"
              role="tab"
              aria-selected={active}
              data-segmented-value={option.value}
              onClick={() => onChange(option.value)}
              className={cn(
                'flex h-9 flex-1 items-center justify-center gap-2 rounded-card text-body transition-colors',
                active
                  ? 'bg-popover font-semibold text-foreground shadow-card'
                  : 'font-medium text-secondary-foreground hover:bg-foreground/5 hover:text-foreground',
              )}
            >
              {option.icon ? <span aria-hidden="true" className="shrink-0">{option.icon}</span> : null}
              <span className="truncate">{option.label}</span>
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <div
      ref={trackRef}
      role="group"
      aria-label={ariaLabel}
      className={cn('relative inline-flex min-h-9 shrink-0 items-center gap-1 rounded-panel bg-foreground/5 p-1', className)}
    >
      {glider ? (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute left-0 top-1 h-7 rounded-card bg-popover shadow-card transition-transform duration-200 ease-out"
          style={{
            width: glider.width,
            transform: `translate3d(${glider.left}px, 0, 0)`,
          }}
        />
      ) : null}
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            ref={(el) => {
              if (el) btnRefs.current.set(option.value, el);
              else btnRefs.current.delete(option.value);
            }}
            type="button"
            aria-pressed={active}
            data-segmented-value={option.value}
            onClick={() => onChange(option.value)}
            className={`relative z-10 inline-flex h-7 items-center gap-1 whitespace-nowrap rounded-card px-3 text-caption transition-colors ${
              active
                ? `${glider ? '' : 'bg-popover shadow-card '}font-medium text-foreground`
                : 'text-secondary-foreground hover:bg-foreground/5 hover:text-foreground'
            }`}
          >
            {option.icon ? <span aria-hidden="true" className="shrink-0">{option.icon}</span> : null}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
