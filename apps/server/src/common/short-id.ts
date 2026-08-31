import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';

/** CLI 展示的 ID 前缀宽度：短 ID 查询至少要这么长，避免过短前缀命中一大片 */
export const SHORT_ID_MIN_LENGTH = 8;

const FULL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** UUID 前缀：首段 8 位必为 hex，更长的前缀才可能含连字符 */
const ID_PREFIX = /^[0-9a-f]{8}[0-9a-f-]*$/i;

/**
 * 把短 ID 前缀解析成完整 ID；完整 ID 原样放行。
 *
 * findByPrefix 只能在调用者有权访问的范围内匹配 —— 否则短 ID 会变成探测他人记录是否存在的手段。
 * 命中多条时不回候选清单：触发部署等入口给的本就是完整 ID，直接让调用方改用完整 ID 即可。
 */
export async function resolveShortId(
  raw: string,
  noun: string,
  findByPrefix: (prefix: string) => Promise<string[]>,
): Promise<string> {
  if (FULL_UUID.test(raw)) return raw;
  if (raw.length < SHORT_ID_MIN_LENGTH) {
    throw new BadRequestException({
      error: 'VALIDATION_FAILED',
      message: `ID 至少需要 ${SHORT_ID_MIN_LENGTH} 位（列表里展示的就是前 ${SHORT_ID_MIN_LENGTH} 位）`,
    });
  }
  if (!ID_PREFIX.test(raw)) throw new NotFoundException({ error: 'NOT_FOUND', message: `${noun}不存在` });

  // findByPrefix 只需回够判断歧义的条数（2 条即可），因此这里不报具体数量
  const ids = await findByPrefix(raw.toLowerCase());
  if (ids.length === 0) throw new NotFoundException({ error: 'NOT_FOUND', message: `${noun}不存在` });
  if (ids.length === 1) return ids[0];
  throw new ConflictException({
    error: 'AMBIGUOUS_ID',
    message: `ID 前缀 ${raw} 匹配到多条${noun}，请改用完整 ID 查询`,
  });
}
