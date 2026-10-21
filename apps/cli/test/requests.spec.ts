import { afterEach, it, expect, vi } from 'vitest';
import { Command } from 'commander';
import { buildEatTools } from '@eat/shared';
import { Api } from '../src/client.js';
import { registerRequestCommands } from '../src/commands/requests.js';
import { envRequests } from '../src/commands/env.js';
import { dbList } from '../src/commands/db.js';
afterEach(() => vi.restoreAllMocks());
function fixture(data: unknown) {
  const request = vi.fn().mockResolvedValue(data),
    log = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(Api, 'fromSaved').mockReturnValue({ request } as unknown as Api);
  const run = async (...args: string[]) => {
    const p = new Command().exitOverride();
    registerRequestCommands(p);
    await p.parseAsync(['node', 'eat', 'requests', ...args]);
  };
  return { request, log, run };
}
it('统一查询只查询本人申请，并输出驳回原因和分页提示', async () => {
  const f = fixture({
    items: [{ id: 'one', type: 'env', targetName: '预发布配置', status: 'rejected', rejectionReason: '请补充用途' }],
    total: 21,
    page: 2,
  });
  await f.run('list', '--status', 'rejected', '--page', '2');
  expect(f.request).toHaveBeenCalledWith('GET', '/api/requests?scope=mine&status=rejected&page=2&pageSize=20');
  expect(f.log.mock.calls.flat().join('\n')).toContain('请补充用途');
  expect(f.log.mock.calls.flat().join('\n')).toContain('共 21 条');
});
it('详情显示审批人、未知历史和上一轮理由，支持 JSON', async () => {
  const data = {
    request: {
      id: 'one',
      type: 'app',
      targetName: '应用',
      status: 'rejected',
      reason: '部署',
      rejectionReason: null,
      decidedByName: null,
      decidedAt: null,
    },
    rounds: [
      { round: 2, status: 'rejected', reason: '第二次' },
      { round: 1, status: 'rejected', rejectionReason: '第一次理由' },
    ],
  };
  const f = fixture(data);
  await f.run('show', 'one');
  expect(f.log.mock.calls.flat().join('\n')).toContain('旧记录未保存');
  expect(f.log.mock.calls.flat().join('\n')).toContain('第一次理由');
  await f.run('show', 'one', '--json');
  expect(JSON.parse(f.log.mock.calls.at(-1)![0])).toEqual(data);
});
it('状态参数校验在发请求前完成，撤回与重新申请显式调用', async () => {
  const f = fixture({ request: { id: 'new' } });
  await expect(f.run('list', '--status', 'garbage')).rejects.toThrow();
  expect(f.request).not.toHaveBeenCalled();
  await f.run('withdraw', 'one');
  expect(f.request).toHaveBeenCalledWith('POST', '/api/requests/one/withdraw', {});
  await f.run('resubmit', 'one', '--reason', '修改后的用途');
  expect(f.request).toHaveBeenCalledWith('POST', '/api/requests/one/resubmit', { reason: '修改后的用途' });
});
it('旧环境变量和数据库命令同样显示理由', async () => {
  const f = fixture([
    {
      status: 'rejected',
      createdAt: new Date().toISOString(),
      environmentSlug: 'test',
      keys: ['TOKEN'],
      rejectionReason: '请先说明用途',
    },
  ]);
  await envRequests();
  expect(f.log.mock.calls.flat().join('\n')).toContain('请先说明用途');
  f.request.mockResolvedValue([
    { status: 'rejected', dbName: 'demo', instanceName: 'test', dbUser: 'member', rejectionReason: '请修改库名' },
  ]);
  await dbList();
  expect(f.log.mock.calls.flat().join('\n')).toContain('请修改库名');
});
it('两种 MCP 接入公开相同的统一申请查询工具', () => {
  const pick = (mode: 'local' | 'remote') =>
    buildEatTools(mode).filter((t) => ['list_requests', 'get_request_status'].includes(t.name));
  expect(pick('local')).toHaveLength(2);
  expect(pick('local')).toEqual(pick('remote'));
});
