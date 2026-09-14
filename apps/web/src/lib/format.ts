/**
 * 控制台唯一的时间格式化入口（决策 49）：绝对时间统一走 shared 的 formatDateTime（按浏览器本地时区
 * 出 YYYY-MM-DD HH:mm），相对时间用下面的 formatRelativeTime。别再在页面里 slice ISO 字符串。
 */
export { formatDateTime } from '@eat/shared';

/**
 * 相对时间：清单里「3 天前」比完整时间戳好扫，鼠标悬停再给完整时间。
 * 阈值故意粗：不到两天叫「昨天」、不到一年按月算，清单不是审计日志。
 */
export function formatRelativeTime(iso: string, now = Date.now()): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const minutes = Math.floor(Math.max(0, now - t) / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 2) return '昨天';
  if (days < 30) return `${days} 天前`;
  if (days < 365) return `${Math.floor(days / 30)} 个月前`;
  return `${Math.floor(days / 365)} 年前`;
}

