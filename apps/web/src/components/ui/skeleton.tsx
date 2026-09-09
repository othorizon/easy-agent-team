import * as React from 'react';
import { cn } from '../../lib/utils';

function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div data-slot="skeleton" className={cn('animate-pulse rounded-md bg-muted', className)} {...props} />;
}

/** 表格加载骨架：几行灰条 */
function TableSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-2.5 py-1">
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-8 w-full" />
      ))}
    </div>
  );
}

/** 清单加载骨架：每行「标题 / 描述 / 元信息」三条灰条，行间分隔线与真实清单对齐 */
function ListSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="divide-y border-t">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="space-y-2.5 py-4">
          <Skeleton className="h-4 w-48 max-w-full" />
          <Skeleton className="h-3.5 w-full max-w-xl" />
          <Skeleton className="h-3 w-40" />
        </div>
      ))}
    </div>
  );
}

export { ListSkeleton, Skeleton, TableSkeleton };
