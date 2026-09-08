import { ChevronLeft, ChevronRight } from 'lucide-react';
import * as React from 'react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';

export const PAGE_SIZE_OPTIONS = [20, 50, 100];

/**
 * 页码序列：首末页恒显示，当前页左右各留一个，中间断开处用 '…'。
 * 总页数 ≤ 7 时全列出——这个规模下省略反而更难点。
 */
export function pageItems(page: number, pageCount: number): Array<number | '…'> {
  if (pageCount <= 7) return Array.from({ length: pageCount }, (_, i) => i + 1);
  const pages = new Set([1, pageCount, page, page - 1, page + 1]);
  const sorted = [...pages].filter((p) => p >= 1 && p <= pageCount).sort((a, b) => a - b);
  const out: Array<number | '…'> = [];
  let prev = 0;
  for (const p of sorted) {
    if (prev && p - prev > 1) out.push('…');
    out.push(p);
    prev = p;
  }
  return out;
}

/**
 * 列表分页条：左侧「共 N 条」+ 每页条数，右侧翻页与跳页。
 * 手机上逐个页码按钮太挤，换成「当前页 / 总页数」，翻页与跳页照旧可用。
 */
export function Pagination({
  total,
  page,
  pageSize,
  onPageChange,
  onPageSizeChange,
}: {
  total: number;
  page: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
}) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const [jump, setJump] = React.useState('');

  const go = (p: number) => onPageChange(Math.min(pageCount, Math.max(1, p)));
  const submitJump = () => {
    const n = Number(jump);
    if (Number.isInteger(n) && n >= 1 && n <= pageCount) go(n);
    setJump('');
  };

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t px-1 pt-3 text-sm">
      <div className="flex items-center gap-2 text-muted-foreground">
        <span className="tabular-nums">共 {total} 条</span>
        <Select value={String(pageSize)} onValueChange={(v) => onPageSizeChange(Number(v))}>
          <SelectTrigger className="h-8 w-[116px]" aria-label="每页条数">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PAGE_SIZE_OPTIONS.map((n) => (
              <SelectItem key={n} value={String(n)}>
                {n} 条/页
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex items-center gap-1">
        <Button variant="outline" size="icon-sm" disabled={page <= 1} onClick={() => go(page - 1)} aria-label="上一页">
          <ChevronLeft />
        </Button>
        {pageItems(page, pageCount).map((p, i) =>
          p === '…' ? (
            <span key={`gap-${i}`} className="hidden px-1 text-muted-foreground sm:inline">
              …
            </span>
          ) : (
            <Button
              key={p}
              variant={p === page ? 'default' : 'outline'}
              size="icon-sm"
              className="hidden tabular-nums sm:inline-flex"
              onClick={() => go(p)}
              aria-current={p === page ? 'page' : undefined}
            >
              {p}
            </Button>
          ),
        )}
        <span className="px-1 tabular-nums text-muted-foreground sm:hidden">
          {page} / {pageCount}
        </span>
        <Button
          variant="outline"
          size="icon-sm"
          disabled={page >= pageCount}
          onClick={() => go(page + 1)}
          aria-label="下一页"
        >
          <ChevronRight />
        </Button>
        {pageCount > 1 && (
          <div className="ml-2 flex items-center gap-1 text-muted-foreground">
            <span>跳至</span>
            <Input
              className="h-8 w-14 text-center tabular-nums"
              inputMode="numeric"
              value={jump}
              placeholder={String(page)}
              aria-label="跳转到第几页"
              onChange={(e) => setJump(e.target.value.replace(/\D/g, ''))}
              onKeyDown={(e) => e.key === 'Enter' && submitJump()}
              onBlur={submitJump}
            />
            <span>页</span>
          </div>
        )}
      </div>
    </div>
  );
}
