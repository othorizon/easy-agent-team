import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { Api } from '../src/client.js';
import { aliyunList, aliyunRequest, registerAliyunCommands } from '../src/commands/aliyun.js';
const one = { id: '11111111-1111-4111-8111-111111111111', policyName: 'eat-perm-report', description: '报表说明', purpose: '报表分析', dataScope: '范围A', connectionName: 'analytics', accountId: 'account-one', ownerName: 'Alice' };
function fixture(points = [one]) {
  const request = vi.fn(async (method: string, url: string) => method === 'GET' && url === '/api/aliyun/permissions' ? points : { requestId: 'request-id', grant: null });
  vi.spyOn(Api, 'fromSaved').mockReturnValue({ request } as unknown as Api); return request;
}
beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); });
it('list显示云账号、说明、用途、范围与Owner，支持JSON与按接入名称或云账号ID筛选', async () => {
  fixture(); await aliyunList();
  const output = vi.mocked(console.log).mock.calls.flat().join('\n');
  for (const text of ['eat-perm-report', 'analytics', 'account-one', '报表说明', '报表分析', '范围A', 'Alice']) expect(output).toContain(text);
  for (const account of ['analytics', 'account-one']) { vi.mocked(console.log).mockClear(); await aliyunList({ account, json: true }); expect(JSON.parse(vi.mocked(console.log).mock.calls[0][0] as string)).toEqual([one]); }
});
it('跨账号重名明确列出歧义且不发申请；按名称@接入或--account名/ID解析后只提交目标ID', async () => {
  const request = fixture([one, { ...one, id: '22222222-2222-4222-8222-222222222222', connectionName: 'production', accountId: 'account-two' }]);
  await expect(aliyunRequest('eat-perm-report', { reason: '季度统计' })).rejects.toThrow(/analytics.*production/);
  expect(request.mock.calls.filter(([m]) => m === 'POST')).toHaveLength(0);
  for (const ref of ['analytics', 'account-one']) await aliyunRequest('eat-perm-report', { reason: '季度统计', account: ref });
  await aliyunRequest('eat-perm-report@analytics', { reason: '季度统计' });
  expect(request.mock.calls.filter(([m]) => m === 'POST')).toHaveLength(3);
  for (const call of request.mock.calls.filter(([m]) => m === 'POST')) expect(call).toEqual(['POST', `/api/aliyun/permissions/${one.id}/requests`, { reason: '季度统计' }]);
});
it('无匹配与空原因不发申请，根命令只注册一次且保留grants/revoke/credentials/run', async () => {
  const request = fixture();
  await expect(aliyunRequest('missing', { reason: '统计' })).rejects.toThrow(/未找到.*开放/);
  await expect(aliyunRequest('eat-perm-report', { reason: ' ' })).rejects.toThrow();
  expect(request.mock.calls.filter(([m]) => m === 'POST')).toHaveLength(0);
  const program = new Command(); registerAliyunCommands(program);
  expect(program.commands).toHaveLength(1);
  expect(program.commands[0].commands.map(c => c.name())).toEqual(expect.arrayContaining(['list', 'request', 'grants', 'revoke', 'credentials', 'run']));
  await program.parseAsync(['aliyun', 'request', 'eat-perm-report', '--reason', '命令测试', '--account', 'analytics'], { from: 'user' });
  expect(request).toHaveBeenCalledWith('POST', `/api/aliyun/permissions/${one.id}/requests`, { reason: '命令测试' });
});
