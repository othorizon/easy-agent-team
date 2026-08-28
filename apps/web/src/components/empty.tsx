import { Inbox } from 'lucide-react';
import * as React from 'react';
import { cn } from '../lib/utils';

/** 空状态占位 */
export function Empty({
  text = '暂无数据',
  action,
  className,
}: {
  text?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-2 py-10 text-center', className)}>
      <Inbox className="size-8 text-muted-foreground/40" strokeWidth={1.5} />
      <div className="max-w-md text-sm leading-relaxed text-muted-foreground">{text}</div>
      {action && <div className="mt-1.5">{action}</div>}
    </div>
  );
}
