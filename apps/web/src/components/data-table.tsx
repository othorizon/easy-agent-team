import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type Row,
  type RowData,
  type SortingState,
} from '@tanstack/react-table';
import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react';
import * as React from 'react';
import { cn } from '../lib/utils';
import { TableSkeleton } from './ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table';

/** 窄屏隐藏次要列的断点：低于该断点整列（表头 + 单元格）不显示 */
type HideBelow = 'sm' | 'md' | 'lg';

declare module '@tanstack/react-table' {
  interface ColumnMeta<TData extends RowData, TValue> {
    /** 表头与单元格共用的类名（列宽、对齐、nowrap 等） */
    className?: string;
    /** 只加在表头上的类名 */
    headerClassName?: string;
    /** 只加在单元格上的类名（颜色、截断等） */
    cellClassName?: string;
    hideBelow?: HideBelow;
  }
}

/* 类名写全，Tailwind 才扫得到 */
const HIDE_BELOW: Record<HideBelow, string> = {
  sm: 'hidden sm:table-cell',
  md: 'hidden md:table-cell',
  lg: 'hidden lg:table-cell',
};

export type DataTableColumn<T> = ColumnDef<T, unknown>;

/**
 * 控制台统一的数据表格（TanStack Table 驱动，样式沿用 ui/table）。
 *
 * - 列定义里用 `meta` 声明列宽 / 截断 / `hideBelow` 窄屏隐藏，不再在表头和单元格上各写一遍；
 * - 加载中渲染骨架，没有数据渲染 `empty`（不传则什么都不画，由页面自己决定）；
 * - 排序按列显式开启（`enableSorting: true` + accessor），默认全部关闭——多数清单的顺序是服务端定的；
 * - 只做客户端渲染与排序；需要分页的清单走服务端分页 + `components/pagination.tsx`。
 */
export function DataTable<T>({
  columns,
  data,
  loading,
  skeletonRows,
  empty,
  getRowId,
  className,
  rowClassName,
  initialSorting,
}: {
  columns: DataTableColumn<T>[];
  data: T[] | undefined;
  loading?: boolean;
  skeletonRows?: number;
  empty?: React.ReactNode;
  getRowId?: (row: T, index: number) => string;
  /** 加在 <table> 上，常用于 `min-w-[…]` 让窄屏横向滚动而不是挤成一团 */
  className?: string;
  rowClassName?: (row: Row<T>) => string | undefined;
  initialSorting?: SortingState;
}) {
  const [sorting, setSorting] = React.useState<SortingState>(initialSorting ?? []);
  const table = useReactTable({
    data: data ?? EMPTY,
    columns,
    getRowId,
    defaultColumn: { enableSorting: false },
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  if (loading) return <TableSkeleton rows={skeletonRows} />;
  const rows = table.getRowModel().rows;
  if (rows.length === 0 && empty !== undefined) return <>{empty}</>;

  return (
    <Table className={className}>
      <TableHeader>
        {table.getHeaderGroups().map((group) => (
          <TableRow key={group.id}>
            {group.headers.map((header) => {
              const meta = header.column.columnDef.meta;
              const sorted = header.column.getIsSorted();
              const label = header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext());
              return (
                <TableHead
                  key={header.id}
                  className={cn(meta?.hideBelow && HIDE_BELOW[meta.hideBelow], meta?.className, meta?.headerClassName)}
                  aria-sort={sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : undefined}
                >
                  {header.column.getCanSort() ? (
                    <button
                      type="button"
                      onClick={header.column.getToggleSortingHandler()}
                      className="-ml-1 inline-flex cursor-pointer items-center gap-1 rounded px-1 py-0.5 hover:bg-accent hover:text-foreground"
                    >
                      {label}
                      {sorted === 'asc' ? (
                        <ArrowUp className="size-3" />
                      ) : sorted === 'desc' ? (
                        <ArrowDown className="size-3" />
                      ) : (
                        <ChevronsUpDown className="size-3 opacity-50" />
                      )}
                    </button>
                  ) : (
                    label
                  )}
                </TableHead>
              );
            })}
          </TableRow>
        ))}
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.id} className={rowClassName?.(row)}>
            {row.getVisibleCells().map((cell) => {
              const meta = cell.column.columnDef.meta;
              return (
                <TableCell
                  key={cell.id}
                  className={cn(meta?.hideBelow && HIDE_BELOW[meta.hideBelow], meta?.className, meta?.cellClassName)}
                >
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </TableCell>
              );
            })}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

const EMPTY: never[] = [];
