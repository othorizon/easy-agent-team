import { CalendarClock, X } from 'lucide-react';
import * as React from 'react';
import { formatDateTime } from '../lib/format';
import { cn } from '../lib/utils';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';
import { Skeleton } from './ui/skeleton';

/* 日历（react-day-picker + date-fns）只有点开选择器才用得到，单独拆包按需加载 */
const Calendar = React.lazy(() => import('./ui/calendar').then((m) => ({ default: m.Calendar })));

const DAY_MS = 86_400_000;

/** 授权有效期的常用档位：按「现在 + N 天」算，与手选日期互不影响 */
export const EXPIRY_PRESETS = [
  { label: '1 天', days: 1 },
  { label: '7 天', days: 7 },
  { label: '30 天', days: 30 },
  { label: '90 天', days: 90 },
];

function pad(n: number) {
  return String(n).padStart(2, '0');
}

function timeOf(d: Date) {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function withTime(day: Date, hhmm: string) {
  const [h, m] = hhmm.split(':').map(Number);
  const next = new Date(day);
  next.setHours(h || 0, m || 0, 0, 0);
  return next;
}

/**
 * 日期时间选择：替代各浏览器长得都不一样的 `datetime-local`。
 * 值是本地时区的 Date（提交时 `toISOString()`），可清空；
 * 选日期时沿用已选的时刻，没有就用 defaultTime（有效期默认到当天 23:59）。
 */
export function DateTimePicker({
  id,
  value,
  onChange,
  placeholder = '选择日期时间',
  clearable = true,
  presets,
  disablePast = true,
  defaultTime = '23:59',
  className,
  'aria-label': ariaLabel,
}: {
  id?: string;
  value: Date | undefined;
  onChange: (value: Date | undefined) => void;
  placeholder?: string;
  clearable?: boolean;
  presets?: { label: string; days: number }[];
  disablePast?: boolean;
  defaultTime?: string;
  className?: string;
  'aria-label'?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const time = value ? timeOf(value) : defaultTime;
  const today = React.useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }, []);

  return (
    <div className={cn('relative', className)}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            id={id}
            type="button"
            variant="outline"
            aria-label={ariaLabel}
            className={cn('w-full justify-start px-3 font-normal', !value && 'text-muted-foreground/70', clearable && value && 'pr-9')}
          >
            <CalendarClock className="text-muted-foreground" />
            {value ? formatDateTime(value) : placeholder}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto">
          {presets && presets.length > 0 && (
            <div className="flex flex-wrap gap-1.5 border-b p-3">
              {presets.map((p) => (
                <Button
                  key={p.days}
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    onChange(new Date(Date.now() + p.days * DAY_MS));
                    setOpen(false);
                  }}
                >
                  {p.label}
                </Button>
              ))}
            </div>
          )}
          <React.Suspense fallback={<Skeleton className="m-3 h-[17rem] w-[15.5rem]" />}>
            <Calendar
              mode="single"
              selected={value}
              defaultMonth={value}
              disabled={disablePast ? { before: today } : undefined}
              onSelect={(day) => day && onChange(withTime(day, time))}
            />
          </React.Suspense>
          <div className="flex items-center gap-2 border-t p-3">
            <label htmlFor={id ? `${id}-time` : undefined} className="text-sm text-muted-foreground">
              时间
            </label>
            <Input
              id={id ? `${id}-time` : undefined}
              aria-label="时间"
              type="time"
              className="h-8 w-28"
              value={time}
              onChange={(e) => e.target.value && onChange(withTime(value ?? today, e.target.value))}
            />
            <Button type="button" size="sm" className="ml-auto" onClick={() => setOpen(false)}>
              确定
            </Button>
          </div>
        </PopoverContent>
      </Popover>
      {clearable && value && (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="清除"
          className="absolute top-1/2 right-1 -translate-y-1/2 text-muted-foreground"
          onClick={() => onChange(undefined)}
        >
          <X />
        </Button>
      )}
    </div>
  );
}
