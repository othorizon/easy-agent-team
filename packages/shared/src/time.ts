/**
 * 时间格式化（决策 49）：服务端一律 toISOString() 传绝对时刻，展示端按所在机器的时区换算——
 * 浏览器按用户本地时区、CLI 按终端所在机器、服务端自己要显示日期时按进程时区（容器 TZ）。
 * 刻意不用 toLocaleString：各浏览器 / Node 版本输出略有差异，固定成 YYYY-MM-DD HH:mm 更好扫。
 * 三端共用这一份，别再各自 slice ISO 字符串——那等于把 UTC 时刻当本地时间显示。
 */
export type DateInput = Date | string | null | undefined;

function parse(v: DateInput): Date | null {
  if (v === null || v === undefined || v === '') return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** 本地日期 `YYYY-MM-DD`；空值或无法解析回 `—` */
export function formatDate(v: DateInput): string {
  const d = parse(v);
  if (!d) return '—';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 本地日期时间 `YYYY-MM-DD HH:mm`；空值或无法解析回 `—` */
export function formatDateTime(v: DateInput): string {
  const d = parse(v);
  if (!d) return '—';
  return `${formatDate(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
