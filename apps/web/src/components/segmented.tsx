import * as React from 'react';
import { cn } from '../lib/utils';

/**
 * 分段选择器（替代 antd Segmented），值支持任意可比较类型。
 *
 * 两个外观：`solid` 是默认的实心轨道（灰底 + 白色滑块），与 TabsList 长得一样；
 * `outline` 是描边轨道（透明底 + 灰色滑块），用于**与页签同处一行**的次级筛选——
 * 两个维度各自一个控件时，长得一样会让人分不清哪个是导航、哪个是筛选。
 */
export function Segmented<T extends string | number | boolean>({
  value,
  onChange,
  options,
  variant = 'solid',
  ariaLabel,
  className,
}: {
  value: T;
  onChange: (v: T) => void;
  options: Array<{ label: React.ReactNode; value: T }>;
  variant?: 'solid' | 'outline';
  ariaLabel?: string;
  className?: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={cn(
        'inline-flex w-fit max-w-full flex-wrap items-center gap-0.5 rounded-lg p-0.5',
        variant === 'solid' ? 'bg-muted' : 'border',
        className,
      )}
    >
      {options.map((opt, i) => {
        const active = opt.value === value;
        return (
          <button
            key={i}
            type="button"
            role="radio"
            aria-checked={active}
            className={cn(
              'inline-flex items-center gap-1 rounded-md px-3 py-1.5 text-sm transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/40 cursor-pointer',
              active
                ? variant === 'solid'
                  ? 'bg-card font-medium shadow-xs'
                  : 'bg-muted font-medium'
                : 'text-muted-foreground hover:text-foreground',
            )}
            onClick={() => onChange(opt.value)}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
