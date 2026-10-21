import { afterEach, describe, expect, it, vi } from 'vitest';
import { NewApiClient, NewApiError } from '../src/llm-gateway/newapi.client';

const client = new NewApiClient('https://newapi.example.test', 'test-access-token');
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('New API 限流提示', () => {
  it.each([null, '<html>Too many requests</html>', JSON.stringify({ error: 'test-access-token' })])(
    '空响应、HTML 与 JSON 限流响应都显示等待时间，不暴露上游内容', async (body) => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, {
        status: 429, headers: { 'Retry-After': '45' },
      })));
      const error = await client.key(1).catch(e => e);
      expect(error).toBeInstanceOf(NewApiError);
      expect(error.message).toBe('New API 请求过于频繁，已触发限流（HTTP 429），请在 45 秒后重试。');
      expect(error.uncertain).toBe(false);
      expect(error.missing).toBe(false);
    },
  );
  it('支持 HTTP 日期形式的 Retry-After', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-21T00:00:00Z'));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, {
      status: 429, headers: { 'Retry-After': 'Wed, 21 Oct 2026 00:01:30 GMT' },
    })));
    await expect(client.key(1)).rejects.toThrow('请在 90 秒后重试');
  });
  it.each([undefined, 'invalid', '-5', '0', 'Wed, 01 Jan 2020 00:00:00 GMT'])('没有有效等待时间 %s 时提示稍后重试', async retryAfter => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, {
      status: 429, headers: retryAfter ? { 'Retry-After': retryAfter } : {},
    })));
    await expect(client.key(1)).rejects.toThrow('New API 请求过于频繁，已触发限流（HTTP 429），请稍后重试，避免连续操作。');
  });
  it('正常导出仍读取完整 Key，其他非 JSON 错误保留原语义', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ success: true, data: { key: 'test-key' } })))
      .mockResolvedValueOnce(new Response('Bad gateway', { status: 502 }));
    vi.stubGlobal('fetch', fetch);
    await expect(client.key(1)).resolves.toBe('sk-test-key');
    const error = await client.key(1).catch(e => e);
    expect(error.message).toBe('New API 返回了无效响应');
    expect(error.uncertain).toBe(true);
  });
});
