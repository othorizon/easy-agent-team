import { describe, expect, it } from 'vitest';
import { formatRemaining, parseTimeoutSeconds, remainingMs, resolveTimeoutMs, reusablePending } from '../src/commands/auth.js';

describe('resolveTimeoutMs：阻塞等待上限', () => {
  it('未指定时等到授权码过期', () => {
    expect(resolveTimeoutMs(undefined, 600)).toBe(600_000);
  });

  it('指定秒数按秒换算', () => {
    expect(resolveTimeoutMs('30', 600)).toBe(30_000);
    expect(resolveTimeoutMs('0', 600)).toBe(0);
  });

  it('不会超过授权码本身的有效期', () => {
    expect(resolveTimeoutMs('9999', 600)).toBe(600_000);
  });

  it('非法值直接报错而不是悄悄按 0 处理', () => {
    expect(() => resolveTimeoutMs('abc', 600)).toThrow(/非负秒数/);
    expect(() => resolveTimeoutMs('-5', 600)).toThrow(/非负秒数/);
  });

  it('校验可单独先做，免得非法参数白白作废一个设备码', () => {
    expect(parseTimeoutSeconds(undefined)).toBeNull();
    expect(parseTimeoutSeconds('30')).toBe(30);
    expect(() => parseTimeoutSeconds('abc')).toThrow(/非负秒数/);
  });
});

describe('remainingMs：待授权记录的剩余有效期', () => {
  const now = Date.parse('2026-09-20T10:00:00.000Z');

  it('未过期时给出剩余毫秒', () => {
    expect(remainingMs({ expiresAt: '2026-09-20T10:05:00.000Z' }, now)).toBe(300_000);
  });

  it('已过期回 0 而不是负数', () => {
    expect(remainingMs({ expiresAt: '2026-09-20T09:59:00.000Z' }, now)).toBe(0);
  });

  it('时间串坏掉按已过期处理', () => {
    expect(remainingMs({ expiresAt: 'not-a-date' }, now)).toBe(0);
  });
});

describe('formatRemaining', () => {
  it('分秒分开说', () => {
    expect(formatRemaining(600_000)).toBe('10 分 0 秒');
    expect(formatRemaining(61_000)).toBe('1 分 1 秒');
  });

  it('不足一分钟只说秒', () => {
    expect(formatRemaining(5_000)).toBe('5 秒');
    expect(formatRemaining(0)).toBe('0 秒');
  });
});

describe('reusablePending：沿用尚未完成的授权请求', () => {
  const now = Date.parse('2026-09-20T10:00:00.000Z');
  const pending = {
    serverUrl: 'https://eat.example.com',
    deviceCode: 'dc',
    userCode: 'AB12-CD34',
    verificationUri: 'https://eat.example.com/device?code=AB12-CD34',
    interval: 3,
    expiresAt: '2026-09-20T10:08:00.000Z',
  };

  it('同一平台、剩余时间够，就接着用（不作废已转告用户的短码）', () => {
    expect(reusablePending(pending, 'https://eat.example.com', {}, now)).toBe(pending);
  });

  it('没有待授权记录时自然要新发一个', () => {
    expect(reusablePending(null, 'https://eat.example.com', {}, now)).toBeNull();
  });

  it('--new 强制换新的', () => {
    expect(reusablePending(pending, 'https://eat.example.com', { new: true }, now)).toBeNull();
  });

  it('换了平台地址不能复用', () => {
    expect(reusablePending(pending, 'https://other.example.com', {}, now)).toBeNull();
  });

  it('只剩十几秒的码转告出去也来不及确认，换新的', () => {
    const almostGone = { ...pending, expiresAt: '2026-09-20T10:00:20.000Z' };
    expect(reusablePending(almostGone, 'https://eat.example.com', {}, now)).toBeNull();
  });
});
