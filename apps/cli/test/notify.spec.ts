import { afterEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Api } from '../src/client.js';
import { registerNotifyCommands } from '../src/commands/notify.js';

const users = [
  { id: 'one', name: '张三', email: 'zhang@example.com', role: 'member', status: 'active', notificationReady: true },
  { id: 'two', name: '李四', email: 'li@example.com', role: 'admin', status: 'disabled', notificationReady: false },
];
function setup() {
  const request = vi.fn().mockResolvedValue({ dryRun: true, title: '通知', recipients: [{ id: 'one', name: '张三', email: 'zhang@example.com', status: 'ready' }] });
  vi.spyOn(Api, 'fromSaved').mockReturnValue({ request } as unknown as Api);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const program = new Command(); registerNotifyCommands(program);
  return { request, log, run: (args: string[]) => program.parseAsync(args, { from: 'user' }) };
}
afterEach(() => { vi.restoreAllMocks(); process.exitCode = 0; });
describe('notify/users CLI', () => {
  it('普通用户响应不含 status 时仍正常查询，JSON 不补充状态字段', async () => {
    const { status, ...member } = users[0];
    const { request, log, run } = setup(); request.mockResolvedValue([member]);
    await run(['users', '--search', 'ZHANG@', '--json']);
    expect(JSON.parse(log.mock.calls[0][0])).toEqual([member]);
  });
  it('列表只显示五列，兼容管理员和旧服务端的状态字段并过滤禁用账号', async () => {
    const { request, log, run } = setup(); request.mockResolvedValue(users);
    await run(['users']);
    expect(log.mock.calls.map(call => call[0])).toEqual([
      '用户 ID\t姓名\t邮箱\t角色\t飞书通知', 'one\t张三\tzhang@example.com\t成员\t已就绪',
    ]);
  });
  it.each([[], ['--search', 'example.com'], ['--search', 'ZHANG@']])('users 只返回正常账号，支持搜索与 JSON：%j', async (...args) => {
    const { request, log, run } = setup(); request.mockResolvedValue(users);
    await run(['users', ...args, '--json']);
    expect(request).toHaveBeenCalledWith('GET', '/api/users');
    expect(JSON.parse(log.mock.calls[0][0])).toEqual([users[0]]);
  });
  it('重复 --to 保留多个目标，正文原样传递', async () => {
    const { request, run } = setup();
    await run(['notify', 'send', '--to', 'one', '--to', 'li@example.com', '--title', '通知', '--body', '**你好**\n- 内容', '--dry-run']);
    expect(request).toHaveBeenCalledWith('POST', '/api/notifications/send', {
      to: ['one', 'li@example.com'], all: false, title: '通知', body: '**你好**\n- 内容', dryRun: true,
    });
  });
  it('--all 不带默认空 to，UTF-8 文件保留换行和 Markdown', async () => {
    const { request, run } = setup(); const dir = mkdtempSync(join(tmpdir(), 'eat-notify-'));
    try {
      const path = join(dir, 'body.md'); writeFileSync(path, '**中文**\n```sh\neat users\n```\n');
      await run(['notify', 'send', '--all', '--title', '通知', '--body-file', path]);
      expect(request).toHaveBeenCalledWith('POST', '/api/notifications/send', expect.objectContaining({ all: true, body: '**中文**\n```sh\neat users\n```\n', dryRun: false }));
    } finally { rmSync(dir, { recursive: true }); }
  });
  it.each([
    ['--body', 'a', '--body-file', 'none', '--to', 'one'],
    ['--body', 'a'], ['--body', 'a', '--all', '--to', 'one'], ['--to', 'one'],
  ])('无效互斥或缺少参数不发送：%s', async (...args) => {
    const { request, run } = setup();
    await expect(run(['notify', 'send', '--title', '通知', ...args])).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
  it('混合失败返回非零退出码并逐项展示，不重发', async () => {
    const { request, log, run } = setup();
    request.mockResolvedValue({ dryRun: false, title: '通知', recipients: [
      { ...users[0], status: 'sent' }, { ...users[1], status: 'unavailable', reason: '账号已禁用' },
    ] });
    await run(['notify', 'send', '--all', '--title', '通知', '--body', '正文']);
    expect(process.exitCode).toBe(1); expect(request).toHaveBeenCalledTimes(1);
    expect(log.mock.calls.flat().join('\n')).toContain('无法投递');
  });
});
