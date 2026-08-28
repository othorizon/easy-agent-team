import * as React from 'react';
import { cn } from '../lib/utils';

/** 分段选择器（替代 antd Segmented），值支持任意可比较类型 */
export function Segmented<T extends string | number | boolean>({
  value,
  onChange,
  options,
  className,
}: {
  value: T;
  onChange: (v: T) => void;
  options: Array<{ label: React.ReactNode; value: T }>;
  className?: string;
}) {
  return (
    <div
      role="radiogroup"
      className={cn('inline-flex w-fit max-w-full flex-wrap items-center gap-0.5 rounded-lg bg-muted p-0.5', className)}
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
              'rounded-md px-3 py-1.5 text-sm transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/40 cursor-pointer',
              active ? 'bg-card font-medium shadow-xs' : 'text-muted-foreground hover:text-foreground',
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
