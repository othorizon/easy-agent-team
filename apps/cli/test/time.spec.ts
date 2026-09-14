import { formatDate, formatDateTime } from '@eat/shared';
import { afterAll, describe, expect, it } from 'vitest';

// formatDate / formatDateTime 住在 packages/shared（三端共用），shared 自己没有测试跑器，照 git-url.spec.ts 的先例放在这里。
// Node 在运行时改 process.env.TZ 会重置默认时区，靠这个断言「按所在机器的时区换算」。
describe('formatDateTime / formatDate：按本地时区格式化（决策 49）', () => {
  const originalTz = process.env.TZ;
  afterAll(() => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  const instant = '2026-09-14T00:30:00.000Z';

  it.each([
    ['Asia/Shanghai', '2026-09-14 08:30', '2026-09-14'],
    ['UTC', '2026-09-14 00:30', '2026-09-14'],
    ['America/New_York', '2026-09-13 20:30', '2026-09-13'],
  ])('同一时刻在 %s 显示为本地时间（跨日也跟着变）', (tz, dateTime, date) => {
    process.env.TZ = tz;
    expect(formatDateTime(instant)).toBe(dateTime);
    expect(formatDate(instant)).toBe(date);
  });

  it('接受 Date 对象，输出与 ISO 字符串一致', () => {
    process.env.TZ = 'Asia/Shanghai';
    expect(formatDateTime(new Date(instant))).toBe('2026-09-14 08:30');
    expect(formatDate(new Date(instant))).toBe('2026-09-14');
  });

  it('月 / 日 / 时 / 分补零', () => {
    process.env.TZ = 'UTC';
    expect(formatDateTime('2026-01-05T03:07:00.000Z')).toBe('2026-01-05 03:07');
  });

  it.each([null, undefined, '', 'not-a-date'])('空值或无法解析回 —（%s）', (v) => {
    expect(formatDateTime(v)).toBe('—');
    expect(formatDate(v)).toBe('—');
  });
});
