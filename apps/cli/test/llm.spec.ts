import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, statSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { Api } from '../src/client.js';
import { llmExport, llmAction, registerLlmCommands } from '../src/commands/llm.js';
import { llmAmountToQuota, llmDisplayQuota } from '@eat/shared';
const request = vi.fn();
afterEach(() => {
  vi.restoreAllMocks();
  request.mockReset();
});

describe('LLM 网关 CLI', () => {
  it('按实例比例换算，不硬编码倍率，拒绝无效金额', () => {
    const currency = { quotaPerUnit: 1000, currency: 'CNY', exchangeRate: 2.5 };
    expect(llmAmountToQuota('2.5', currency)).toBe(1000);
    expect(llmDisplayQuota(1000, currency)).toContain('2.5');
    expect(() => llmAmountToQuota('-1', currency)).toThrow();
    expect(() => llmAmountToQuota('abc', currency)).toThrow();
    expect(() => llmAmountToQuota('99999999999999999999999', currency)).toThrow();
  });
  it('仅注册个人命令，不提供管理员调额或设置命令', () => {
    const program = new Command();
    registerLlmCommands(program);
    const llm = program.commands[0];
    expect(llm.commands.map((c) => c.name())).toEqual(['status', 'models', 'usage', 'retry', 'key']);
    expect(llm.commands.find((c) => c.name() === 'key')?.commands.map((c) => c.name())).toContain('export');
    expect(llm.commands.map((c) => c.name())).not.toContain('quota');
  });
  it('show 默认只读取状态并显示掩码，不请求明文接口', async () => {
    vi.spyOn(Api, 'fromSaved').mockReturnValue({ request } as any);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    request.mockResolvedValue({ configured: true, key: { status: 'active', maskedKey: 'sk-ab****cd' },
      totalQuota: 100, usedQuota: 20, remainingQuota: 80, giftClaimed: true,
      currency: { quotaPerUnit: 1000, currency: 'USD', exchangeRate: 1 }, apiBaseUrl: 'https://model.test/v1' });
    const program = new Command();
    registerLlmCommands(program);
    await program.parseAsync(['llm', 'key', 'show'], { from: 'user' });
    expect(request).toHaveBeenCalledExactlyOnceWith('GET', '/api/llm-gateway');
    expect(JSON.stringify(log.mock.calls)).toContain('sk-ab****cd');
  });
  it('show --reveal 只输出完整 Key，失败时不输出任何值', async () => {
    vi.spyOn(Api, 'fromSaved').mockReturnValue({ request } as any);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const run = () => {
      const program = new Command();
      registerLlmCommands(program);
      return program.parseAsync(['llm', 'key', 'show', '--reveal'], { from: 'user' });
    };
    request.mockResolvedValue({ key: 'sk-example-complete-key', apiBaseUrl: 'https://model.test/v1' });
    await run();
    expect(request).toHaveBeenCalledExactlyOnceWith('POST', '/api/llm-gateway/key/reveal', {});
    expect(log.mock.calls).toEqual([['sk-example-complete-key']]);
    log.mockClear();
    request.mockRejectedValue(new Error('New API 请求过于频繁，已触发限流（HTTP 429），请在 45 秒后重试。'));
    await expect(run()).rejects.toThrow('请在 45 秒后重试');
    expect(log).not.toHaveBeenCalled();
  });
  it('导出密钥到新建 0600 文件，不回显明文，也不覆盖已有文件', async () => {
    vi.spyOn(Api, 'fromSaved').mockReturnValue({ request } as any);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const dir = mkdtempSync(join(tmpdir(), 'eat-llm-'));
    const file = join(dir, 'client.json');
    try {
      request.mockResolvedValue({ key: 'test-secret-value', apiBaseUrl: 'https://model.test/v1' });
      await llmExport({ out: file });
      expect(JSON.parse(readFileSync(file, 'utf8')).apiKey).toBe('test-secret-value');
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(JSON.stringify(log.mock.calls)).not.toContain('test-secret-value');
      await expect(llmExport({ out: file })).rejects.toThrow();
      expect(request).toHaveBeenCalledTimes(1);
      const failed = join(dir, 'failed.json');
      request.mockRejectedValue(new Error('offline'));
      await expect(llmExport({ out: failed })).rejects.toThrow('offline');
      expect(existsSync(failed)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('重试传入的操作标识，不改变加款或建 Key 的身份', async () => {
    vi.spyOn(Api, 'fromSaved').mockReturnValue({ request } as any);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    request.mockResolvedValue({ configured: false });
    await llmAction('create', { requestId: '1234' });
    expect(request).toHaveBeenCalledWith('POST', '/api/llm-gateway/key', { requestId: '1234' });
  });
});
