import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AliyunCredentials, AliyunGrantInfo } from '@eat/shared';
import { Command } from 'commander';
import { Api } from '../src/client.js';
import { aliyunCredentials, aliyunRun, aliyunGrants, aliyunRevoke, registerAliyunCommands } from '../src/commands/aliyun.js';
const credential: AliyunCredentials = { connectionId: 'c1', connectionName: 'cloud-one', accountId: 'account-one', defaultRegion: 'cn-hangzhou', identityId: 'identity', accessKeyId: 'personal-ak', accessKeySecret: 'personal-sk', generation: 1, readyAt: new Date(0).toISOString() };
const grant = (accountId = 'account-one', connectionName = 'cloud-one', connectionId = 'c1') => ({ id: 'g1', permissionId: 'p1', policyName: 'eat-perm-read', state: 'active', accountId, connectionId, connectionName } as AliyunGrantInfo);
function fixture(grants = [grant()], key = credential) {
  const request = vi.fn(async (method: string, url: string) => {
    if (method === 'GET' && url === '/api/aliyun/grants') return { grants, accounts: [] };
    if (method === 'POST' && /credentials/.test(url)) return key;
    throw new Error(`unexpected ${method} ${url}`);
  });
  vi.spyOn(Api, 'fromSaved').mockReturnValue({ request } as unknown as Api);
  return request;
}
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'eat-aliyun-')); vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { process.exitCode = 0; vi.unstubAllEnvs(); vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });
it('只在一个有权云账号时可省略；接入名称与云账号ID均可，歧义或无权不取凭证不启动命令', async () => {
  const request = fixture();
  for (const account of [undefined, 'cloud-one', 'account-one']) await aliyunCredentials({ account });
  expect(request.mock.calls.filter(([m]) => m === 'POST')).toHaveLength(3);
  request.mockClear();
  await expect(aliyunRun('missing', [process.execPath, '-e', 'process.exit(77)'])).rejects.toThrow(/没有.*授权.*申请/);
  expect(request.mock.calls.filter(([m]) => m === 'POST')).toHaveLength(0);
  fixture([grant(), grant('account-two', 'cloud-two', 'c2')]);
  await expect(aliyunRun(undefined, [process.execPath, '-e', 'process.exit(77)'])).rejects.toThrow(/多个.*cloud-one.*cloud-two/);
  expect(process.exitCode).not.toBe(77);
});
it('真实子进程使用个人AK覆盖默认profile和残留STS、角色，父环境与目录不变、无文件且透传退出码', async () => {
  fixture();
  vi.stubEnv('ALIBABA_CLOUD_ACCESS_KEY_ID', 'parent-ak');
  vi.stubEnv('ALIBABA_CLOUD_SECURITY_TOKEN', 'old-token');
  vi.stubEnv('ALIBABA_CLOUD_ROLE_ARN', 'old-role');
  vi.stubEnv('OSS_SESSION_TOKEN', 'old-oss-token');
  const parent = { ...process.env }, cwd = process.cwd();
  const script = `const e=process.env; const expected=${JSON.stringify({ ALIBABA_CLOUD_ACCESS_KEY_ID:'personal-ak', ALIBABA_CLOUD_ACCESS_KEY_SECRET:'personal-sk', ALIBABA_CLOUD_REGION_ID:'cn-hangzhou', ALIBABA_CLOUD_IGNORE_PROFILE:'TRUE', OSS_ACCESS_KEY_ID:'personal-ak', OSS_ACCESS_KEY_SECRET:'personal-sk', OSS_REGION:'cn-hangzhou' })}; if(Object.entries(expected).some(([k,v])=>e[k]!==v)||e.ALIBABA_CLOUD_SECURITY_TOKEN||e.ALIBABA_CLOUD_ROLE_ARN||e.OSS_SESSION_TOKEN) process.exit(91); process.exit(23);`;
  process.chdir(dir);
  try { await aliyunRun(undefined, [process.execPath, '-e', script]); } finally { process.chdir(cwd); }
  expect(process.exitCode).toBe(23);
  expect(process.env).toEqual(parent); expect(process.cwd()).toBe(cwd); expect(readdirSync(dir)).toEqual([]);
});
it('在持久readyAt之前显示等待提示，并且真正等待后才启动子进程', async () => {
  const ready = Date.now() + 150;
  fixture([grant()], { ...credential, readyAt: new Date(ready).toISOString() });
  const seen: number[] = [];
  vi.mocked(console.error).mockImplementation(message => { if (String(message).includes('正在等待新 Key 生效')) seen.push(Date.now()); });
  await aliyunRun(undefined, [process.execPath, '-e', `process.exit(Date.now() >= ${ready} ? 0 : 92)`]);
  expect(process.exitCode).toBe(0); expect(seen).toHaveLength(1); expect(seen[0]).toBeLessThan(ready);
});

it('完全无授权与已撤销授权都不取Key，不启动子进程，并说明申请入口', async () => {
  const request = fixture([{ ...grant(), state: 'revoked' }]);
  await expect(aliyunRun(undefined, [process.execPath, '-e', 'process.exit(77)'])).rejects.toThrow(/没有任何.*申请/);
  expect(request.mock.calls.filter(([m]) => m === 'POST')).toHaveLength(0);
  expect(process.exitCode).not.toBe(77);
});
it('命令树解析credentials/reset的account选项，以及run可省account和带子命令flags', async () => {
  const request = fixture();
  const make = () => { const p = new Command(); registerAliyunCommands(p); return p; };
  await make().parseAsync(['aliyun', 'credentials', '--account', 'account-one'], { from: 'user' });
  await make().parseAsync(['aliyun', 'credentials', '--account', 'cloud-one', 'reset'], { from: 'user' });
  await make().parseAsync(['aliyun', 'credentials', 'reset', '--account', 'cloud-one'], { from: 'user' });
  expect(request.mock.calls.filter(([,u]) => u.endsWith('/reset'))).toHaveLength(2);
  await make().parseAsync(['aliyun', 'run', '--', process.execPath, '-e', 'process.exit(31)'], { from: 'user' });
  expect(process.exitCode).toBe(31);
  await make().parseAsync(['aliyun', 'run', 'account-one', '--', process.execPath, '-e', 'process.exit(32)'], { from: 'user' });
  expect(process.exitCode).toBe(32);
});
it('grants输出个人用途说明，revoke按权限点只放弃本人授权且歧义时不操作', async () => {
  const request = fixture();
  request.mockImplementation(async (method, url) => method === 'GET' ? { grants: [grant()], accounts: [] } : { ...grant(), state: 'revoked' });
  await aliyunGrants();
  expect(console.log).toHaveBeenCalledWith(expect.stringContaining('不要配进线上服务'));
  await aliyunRevoke('eat-perm-read');
  expect(request).toHaveBeenCalledWith('POST', '/api/aliyun/grants/g1/relinquish');
  request.mockClear();
  request.mockImplementation(async () => ({ grants: [grant(), grant('account-two', 'cloud-two', 'c2')], accounts: [] }));
  await expect(aliyunRevoke('eat-perm-read')).rejects.toThrow(/--account/);
  expect(request.mock.calls.filter(([m]) => m === 'POST')).toHaveLength(0);
});
