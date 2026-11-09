process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://dev@127.0.0.1:5433/eat_test_11';
import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { beforeAll, beforeEach, afterAll, it, expect } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { resolve } from 'node:path';
import { createServer, type Server } from 'node:http';
import * as bcrypt from 'bcryptjs';
import { AppModule } from '../src/app.module';
import { DB, type Db } from '../src/db/db.module';
import * as schema from '../src/db/schema';
import { RamCloud } from '../src/ram/ram-cloud';
import { TestRamCloud } from './ram-fixture';
import { eq } from 'drizzle-orm';
import {
  aliyunGrantInfoSchema, aliyunGrantsResultSchema,
} from '@eat/shared';

let app: NestFastifyApplication, db: Db, admin: string, member: string, userId: string;
let webhook: Server;
let webhookUrl: string;
const received: string[] = [];
const ram = new TestRamCloud();
const credentials = {
  accessKeyId: 'management-test',
  accessKeySecret: 'management-test-secret',
};
async function api(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  token = admin,
  payload?: unknown,
) {
  const r = await app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}` },
    payload: payload as never,
  });
  return { status: r.statusCode, body: JSON.parse(r.body) };
}
async function boot() {
  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(RamCloud)
    .useValue(ram)
    .compile();
  app = module.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter(),
  );
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  db = app.get(DB);
}
beforeAll(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await pool.query(
    'drop schema public cascade; create schema public; drop schema if exists drizzle cascade;',
  );
  await migrate(drizzle(pool), { migrationsFolder: resolve('drizzle') });
  await pool.end();
  webhook = createServer(async (req, res) => {
    let body = '';
    for await (const part of req) body += part;
    received.push(body);
    res.setHeader('Content-Type', 'application/json'); res.end('{"code":0}');
  });
  await new Promise<void>(r => webhook.listen(0, '127.0.0.1', r));
  webhookUrl = `http://127.0.0.1:${(webhook.address() as { port: number }).port}`;
  await boot();
  const hash = await bcrypt.hash('password123', 4);
  await db.insert(schema.users).values([
    {
      name: 'Admin',
      email: 'admin@aliyun.test',
      role: 'admin',
      passwordHash: hash,
    },
    { name: 'Member', email: 'member@aliyun.test', passwordHash: hash },
  ]);
  userId = (await db.select().from(schema.users).where(eq(schema.users.email, 'member@aliyun.test')))[0].id;
  admin = (
    await api('POST', '/api/auth/login', '', {
      email: 'admin@aliyun.test',
      password: 'password123',
    })
  ).body.token;
  member = (
    await api('POST', '/api/auth/login', '', {
      email: 'member@aliyun.test',
      password: 'password123',
    })
  ).body.token;
});
afterAll(async () => {
  await app?.close();
  await new Promise<void>(r => webhook?.close(() => r()));
});
beforeEach(async () => {
  await db.delete(schema.aliyunGrants);
  await db.delete(schema.cloudIdentities);
  await db.delete(schema.aliyunConnections);
  await db.update(schema.users).set({ name: 'Member', email: 'member@aliyun.test', status: 'active' }).where(eq(schema.users.id, userId));
  await db.delete(schema.userNotifications);
  received.length = 0;
  await db.delete(schema.ossSettings);
  ram.reset();
});
async function create(name = 'cloud-one', keys = credentials) {
  const result = await api('POST', '/api/aliyun/connections', admin, {
    name,
    ...keys,
  });
  expect(result.status).toBe(201);
  return result.body;
}

async function directory(names = ['read', 'write'], keys = credentials, connectionName = 'cloud-one') {
  for (const name of names) await ram.createPolicy(keys, `eat-perm-${name}`, name, '{}');
  const c = await create(connectionName, keys);
  return { connection: c, permissions: (await api('POST', `/api/aliyun/connections/${c.id}/refresh`)).body };
}
async function memberId() {
  return userId;
}
it('同一人在同一云账号的多项授权共用个人身份；我的权限显示实际策略数且不创建Key', async () => {
  const { permissions } = await directory();
  const userId = await memberId();
  const first = await api('POST', `/api/aliyun/permissions/${permissions[0].id}/grants`, admin, { userId });
  expect(first.status).toBe(201);
  aliyunGrantInfoSchema.parse(first.body);
  expect(first.body).toMatchObject({ userId, permissionId: permissions[0].id, state: 'active', source: 'direct' });
  const second = await api('POST', `/api/aliyun/permissions/${permissions[1].id}/grants`, admin, { userId });
  expect(second.body).toMatchObject({ state: 'active', identityId: first.body.identityId });
  const mine = await api('GET', '/api/aliyun/grants', member);
  aliyunGrantsResultSchema.parse(mine.body);
  expect(mine.body.grants).toHaveLength(2);
  expect(mine.body.accounts).toMatchObject([{ accountId: 'account-test', customPolicyCount: 2 }]);
  const cloud = ram.users.get(`eat-${userId.replaceAll('-', '')}`)!;
  expect(cloud.displayName).toBe('Member');
  expect(cloud.comments).toContain(userId);
  expect(cloud.comments).toContain('member@aliyun.test');
  expect(cloud.keys).toEqual([]);
});

it('暂停拒绝新授予，撤销精确解绑单一策略、通知含撤销人及原因，放弃不通知且均记审计', async () => {
  const { connection, permissions } = await directory();
  const one = (await api('POST', `/api/aliyun/permissions/${permissions[0].id}/grants`, admin, { userId })).body;
  const two = (await api('POST', `/api/aliyun/permissions/${permissions[1].id}/grants`, admin, { userId })).body;
  await db.insert(schema.userNotifications).values({ userId, webhookUrl, verifiedAt: new Date() });
  await api('POST', `/api/aliyun/connections/${connection.id}/status`, admin, { status: 'paused' });
  const rejected = await api('POST', `/api/aliyun/permissions/${permissions[0].id}/grants`, admin, { userId });
  expect(rejected.status).toBe(409); expect(rejected.body.message).toContain('暂停');
  const cloud = ram.users.get(`eat-${userId.replaceAll('-', '')}`)!;
  await ram.createPolicy(credentials, 'unrelated', '', '{}');
  await ram.attachPolicy(credentials, cloud.userName, 'unrelated');
  const revoked = await api('POST', `/api/aliyun/grants/${one.id}/revoke`, admin, { reason: '项目结束' });
  expect(revoked.body).toMatchObject({ state: 'revoked', revocationReason: '项目结束', relinquished: false });
  expect([...cloud.attached].sort()).toEqual(['eat-perm-write', 'unrelated']);
  await expect.poll(() => received.length).toBe(1);
  expect(received[0]).toContain('Admin'); expect(received[0]).toContain('项目结束');
  const relinquished = await api('POST', `/api/aliyun/grants/${two.id}/relinquish`, member);
  expect(relinquished.body).toMatchObject({ state: 'revoked', relinquished: true });
  expect([...cloud.attached]).toEqual(['unrelated']);
  expect((await api('GET', '/api/aliyun/grants', member)).body.accounts[0].customPolicyCount).toBe(1);
  for (const action of ['grant', 'revoke', 'relinquish']) {
    const audits = (await api('GET', `/api/audit?action=aliyun.${action}`)).body;
    expect(audits.some((a: { targetId: string }) => a.targetId === (action === 'relinquish' ? two.id : one.id))).toBe(true);
  }
  await new Promise(r => setTimeout(r, 30)); expect(received).toHaveLength(1);
});
it('云端失败显示执行失败，可重试并复用同一授权，创建响应丢失仍复用同一身份', async () => {
  const { permissions } = await directory();
  ram.lostUserResponse = true;
  const failed = await api('POST', `/api/aliyun/permissions/${permissions[0].id}/grants`, admin, { userId });
  expect(failed.body.state).toBe('failed');
  expect(ram.users.size).toBe(1);
  const original = [...ram.users.values()][0].userId;
  const retried = await api('POST', `/api/aliyun/grants/${failed.body.id}/retry`);
  expect(retried.body).toMatchObject({ id: failed.body.id, state: 'active', error: null });
  expect([...ram.users.values()][0].userId).toBe(original);
  const repeated = await Promise.all(Array.from({ length: 12 }, () => api('POST', `/api/aliyun/permissions/${permissions[0].id}/grants`, admin, { userId })));
  expect(repeated.every(r => r.body.state === 'active')).toBe(true);
  expect(new Set(repeated.map(r => r.body.id)).size).toBe(1);
  expect((await api('GET', '/api/aliyun/grants', member)).body.grants).toHaveLength(1);
});
it('自定义策略配额失败使用明确中文，释放配额后重试生效', async () => {
  const { permissions } = await directory();
  const first = (await api('POST', `/api/aliyun/permissions/${permissions[0].id}/grants`, admin, { userId })).body;
  const cloud = ram.users.get(`eat-${userId.replaceAll('-', '')}`)!;
  for (let i = 0; i < 9; i++) {
    await ram.createPolicy(credentials, `outside-${i}`, '', '{}');
    await ram.attachPolicy(credentials, cloud.userName, `outside-${i}`);
  }
  const full = await api('POST', `/api/aliyun/permissions/${permissions[1].id}/grants`, admin, { userId });
  expect(full.body).toMatchObject({ state: 'failed', error: '已达到该 RAM 用户可绑定的自定义策略上限，请在阿里云配额中心调高' });
  expect((await api('GET', '/api/aliyun/grants', member)).body.accounts[0].customPolicyCount).toBe(10);
  await api('POST', `/api/aliyun/grants/${first.id}/revoke`, admin, {});
  expect((await api('POST', `/api/aliyun/grants/${full.body.id}/retry`)).body.state).toBe('active');
  expect(cloud.attached.has('outside-0')).toBe(true);
});
it('同名非EAT身份以及UserId被替换均拒绝接管', async () => {
  const { permissions } = await directory();
  const name = `eat-${userId.replaceAll('-', '')}`;
  await ram.createUser(credentials, { name, displayName: 'Human', comments: 'outside EAT' });
  const conflict = (await api('POST', `/api/aliyun/permissions/${permissions[0].id}/grants`, admin, { userId })).body;
  expect(conflict.state).toBe('failed'); expect(conflict.error).toContain('交管理员处理');
  expect(ram.users.get(name)?.attached.size).toBe(0);
  await ram.deleteUser(credentials, name);
  const granted = (await api('POST', `/api/aliyun/grants/${conflict.id}/retry`)).body;
  expect(granted.state).toBe('active');
  const cloud = ram.users.get(name)!;
  cloud.userId = 'replacement-user';
  const replaced = (await api('POST', `/api/aliyun/permissions/${permissions[1].id}/grants`, admin, { userId })).body;
  expect(replaced.state).toBe('failed'); expect(replaced.error).toContain('拒绝接管');
  expect([...cloud.attached]).toEqual(['eat-perm-read']);
});
it('改名与邮箱更新在下次授予同步，跨云账号各有一个身份', async () => {
  const { permissions } = await directory();
  const first = (await api('POST', `/api/aliyun/permissions/${permissions[0].id}/grants`, admin, { userId })).body;
  const originalId = ram.users.get(`eat-${userId.replaceAll('-', '')}`)!.userId;
  await db.update(schema.users).set({ name: 'New name', email: 'renamed@aliyun.test' }).where(eq(schema.users.id, userId));
  const second = (await api('POST', `/api/aliyun/permissions/${permissions[1].id}/grants`, admin, { userId })).body;
  expect(second.identityId).toBe(first.identityId);
  const cloud = ram.users.get(`eat-${userId.replaceAll('-', '')}`)!;
  expect(cloud).toMatchObject({ userId: originalId, displayName: 'New name' }); expect(cloud.comments).toContain('renamed@aliyun.test');
  const keys = { accessKeyId: 'two-id', accessKeySecret: 'two-secret' };
  ram.registerAccount(keys, 'second-account');
  const secondDirectory = await directory(['other'], keys, 'cloud-two');
  const other = (await api('POST', `/api/aliyun/permissions/${secondDirectory.permissions[0].id}/grants`, admin, { userId })).body;
  expect(other.state).toBe('active'); expect(other.identityId).not.toBe(first.identityId);
  const mine = (await api('GET', '/api/aliyun/grants', member)).body;
  expect(mine.accounts.map((a: { customPolicyCount: number }) => a.customPolicyCount).sort()).toEqual([1, 2]);
});
it('停用用户与普通成员不能授予，Owner只管理已开放权限点，成员不能撤销他人授权', async () => {
  const { permissions } = await directory();
  expect((await api('POST', `/api/aliyun/permissions/${permissions[0].id}/grants`, member, { userId })).status).toBe(403);
  await db.update(schema.users).set({ status: 'disabled' }).where(eq(schema.users.id, userId));
  const disabled = await api('POST', `/api/aliyun/permissions/${permissions[0].id}/grants`, admin, { userId });
  expect(disabled.status).toBe(409); expect(disabled.body.message).toContain('停用');
  await db.update(schema.users).set({ status: 'active' }).where(eq(schema.users.id, userId));
  // Configure an existing Owner/open permission; public configuration is ticket 13.
  await db.update(schema.aliyunPermissions).set({ ownerId: userId, open: true }).where(eq(schema.aliyunPermissions.id, permissions[0].id));
  const [administrator] = await db.select().from(schema.users).where(eq(schema.users.role, 'admin'));
  const granted = await api('POST', `/api/aliyun/permissions/${permissions[0].id}/grants`, member, { userId: administrator.id });
  expect(granted.body.state).toBe('active');
  expect((await api('POST', `/api/aliyun/grants/${granted.body.id}/relinquish`, member)).status).toBe(403);
  expect((await api('POST', `/api/aliyun/grants/${granted.body.id}/revoke`, member, {})).body.state).toBe('revoked');
  await db.update(schema.aliyunPermissions).set({ open: false }).where(eq(schema.aliyunPermissions.id, permissions[0].id));
  expect((await api('POST', `/api/aliyun/permissions/${permissions[0].id}/grants`, member, { userId: administrator.id })).status).toBe(403);
});

it('重启后按持久操作恢复，暂停延后新授予但不阻止撤销恢复', async () => {
  const { connection, permissions } = await directory();
  ram.failActions.set('AttachPolicyToUser', 'NETWORK_ERROR');
  const failed = (await api('POST', `/api/aliyun/permissions/${permissions[0].id}/grants`, admin, { userId })).body;
  expect(failed.state).toBe('failed');
  ram.failActions.clear();
  await api('POST', `/api/aliyun/connections/${connection.id}/status`, admin, { status: 'paused' });
  // Simulate elapsed backoff in persisted storage, then recreate the process with the same RAM adapter.
  await db.update(schema.aliyunOperations).set({ retryAt: new Date(0) });
  await app.close(); await boot();
  expect((await api('GET', '/api/aliyun/grants', member)).body.grants[0].state).toBe('failed');
  expect((await api('POST', `/api/aliyun/grants/${failed.id}/retry`)).status).toBe(409);
  await api('POST', `/api/aliyun/connections/${connection.id}/status`, admin, { status: 'enabled' });
  await app.close(); await boot();
  await expect.poll(async () => (await api('GET', '/api/aliyun/grants', member)).body.grants[0].state).toBe('active');
  const cloud = ram.users.get(`eat-${userId.replaceAll('-', '')}`)!;
  expect([...cloud.attached]).toEqual(['eat-perm-read']);
  ram.failActions.set('DetachPolicyFromUser', 'NETWORK_ERROR');
  expect((await api('POST', `/api/aliyun/grants/${failed.id}/revoke`, admin, { reason: '结束' })).body.state).toBe('failed');
  await api('POST', `/api/aliyun/connections/${connection.id}/status`, admin, { status: 'paused' });
  await db.update(schema.aliyunOperations).set({ retryAt: new Date(0) });
  ram.failActions.clear();
  await app.close(); await boot();
  await expect.poll(async () => (await api('GET', '/api/aliyun/grants', member)).body.grants[0].state).toBe('revoked');
  expect(cloud.attached.size).toBe(0);
});
it('会话锁丢失后不发布已生效，重启核对云端后恢复同一授权', async () => {
  const { permissions } = await directory(['read']);
  let proceed!: () => void, reached!: () => void;
  const waiting = new Promise<void>(r => { proceed = r; });
  const entered = new Promise<void>(r => { reached = r; });
  ram.afterAttach = async () => { reached(); await waiting; };
  const request = api('POST', `/api/aliyun/permissions/${permissions[0].id}/grants`, admin, { userId });
  const fault = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await entered;
    // Fault injection terminates only this test database's granted cloud-identity advisory-lock session.
    const result = await fault.query(`select pg_terminate_backend(a.pid) from pg_stat_activity a
      where a.datname = current_database() and a.pid <> pg_backend_pid() and a.query like 'select pg_advisory_lock%'
        and exists (select 1 from pg_locks l where l.pid = a.pid and l.locktype = 'advisory' and l.granted)`);
    expect(result.rowCount).toBe(1);
    await new Promise(r => setTimeout(r, 20));
    proceed();
    const response = await request;
    expect(response.status).toBe(409);
    const before = (await api('GET', '/api/aliyun/grants', member)).body.grants[0];
    expect(before.state).toBe('pending');
    expect(ram.users.get(`eat-${userId.replaceAll('-', '')}`)!.attached.size).toBe(1);
    ram.afterAttach = undefined;
    await app.close(); await boot();
    await expect.poll(async () => (await api('GET', '/api/aliyun/grants', member)).body.grants[0].state).toBe('active');
    expect((await api('GET', '/api/aliyun/grants', member)).body.grants[0].id).toBe(before.id);
  } finally { proceed(); ram.afterAttach = undefined; await fault.end(); }
});
it('长邮箱只在RAM备注中截断加省略号，完整用户ID、归属和平台邮箱保留，更新仍可授权', async () => {
  const { permissions } = await directory();
  const email = `${'a'.repeat(40)}@${'b'.repeat(60)}.test`;
  await db.update(schema.users).set({ email }).where(eq(schema.users.id, userId));
  const first = (await api('POST', `/api/aliyun/permissions/${permissions[0].id}/grants`, admin, { userId })).body;
  expect(first.state).toBe('active');
  const cloud = ram.users.get(`eat-${userId.replaceAll('-', '')}`)!;
  expect(Array.from(cloud.comments)).toHaveLength(128);
  expect(cloud.comments).toContain(userId); expect(cloud.comments).toMatch(/^EAT:/); expect(cloud.comments.endsWith('…')).toBe(true);
  expect(cloud.comments).toContain(email.slice(0, 63));
  const complete = (await api('GET', '/api/users')).body.find((u: { id: string }) => u.id === userId);
  expect(complete.email).toBe(email);
  await db.update(schema.users).set({ email: 'changed@example.test', name: '新名字' }).where(eq(schema.users.id, userId));
  const second = (await api('POST', `/api/aliyun/permissions/${permissions[1].id}/grants`, admin, { userId })).body;
  expect(second).toMatchObject({ state: 'active', identityId: first.identityId });
  expect(cloud.comments).toContain('changed@example.test'); expect(cloud.comments.endsWith('…')).toBe(false);
  cloud.comments = cloud.comments.replace(userId, 'foreign-user');
  const wrong = (await api('POST', `/api/aliyun/permissions/${permissions[0].id}/grants`, admin, { userId })).body;
  expect(wrong.state).toBe('failed'); expect(wrong.error).toContain('拒绝接管');
});
it('同一个用户UUID的大小写写法复用同一身份和授权', async () => {
  const { permissions } = await directory(['read']);
  const first = (await api('POST', `/api/aliyun/permissions/${permissions[0].id}/grants`, admin, { userId })).body;
  const repeated = (await api('POST', `/api/aliyun/permissions/${permissions[0].id}/grants`, admin, { userId: userId.toUpperCase() })).body;
  expect(repeated).toMatchObject({ id: first.id, identityId: first.identityId, state: 'active', userId });
  expect(ram.users.size).toBe(1);
});
