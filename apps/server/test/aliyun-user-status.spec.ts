process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://dev@127.0.0.1:5433/eat_test_14';
import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { beforeAll, beforeEach, afterAll, afterEach, it, expect, vi } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { resolve } from 'node:path';
import * as bcrypt from 'bcryptjs';
import { AppModule } from '../src/app.module';
import { DB, type Db } from '../src/db/db.module';
import * as schema from '../src/db/schema';
import { RamCloud } from '../src/ram/ram-cloud';
import { encryptSecret } from '../src/common/crypto';
import { TestRamCloud } from './ram-fixture';
import { eq } from 'drizzle-orm';
import { CloudIdentitiesService } from '../src/cloud-identities/cloud-identities.service';
import { CloudIdentityStatusService } from '../src/cloud-identities/cloud-identity-status.service';

let app: NestFastifyApplication, db: Db, admin: string, member: string, userId: string;
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
  return { status: r.statusCode, body: JSON.parse(r.body), headers: r.headers };
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
  app.get(CloudIdentitiesService).keyPropagationMs = 100;
}
beforeAll(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await pool.query(
    'drop schema public cascade; create schema public; drop schema if exists drizzle cascade;',
  );
  await migrate(drizzle(pool), { migrationsFolder: resolve('drizzle') });
  await pool.end();
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
});
beforeEach(async () => {
  await db.delete(schema.aliyunGrants);
  await db.delete(schema.cloudIdentities);
  await db.delete(schema.aliyunConnections);
  await db.update(schema.users).set({ name: 'Member', email: 'member@aliyun.test', status: 'active' }).where(eq(schema.users.id, userId));
  await db.delete(schema.userNotifications);
  await db.delete(schema.ossSettings);
  ram.reset();
  await loginMember();
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
const keyUrl = (id: string) => `/api/aliyun/connections/${id}/credentials`;
const cloudName = () => `eat-${userId.replaceAll('-', '')}`;
async function granted(keys = credentials, name = 'cloud-one') {
  const { connection, permissions } = await directory(['read'], keys, name);
  const grant = await api('POST', `/api/aliyun/permissions/${permissions[0].id}/grants`, admin, { userId });
  expect(grant.status).toBe(201);
  const key = (await api('POST', keyUrl(connection.id), member)).body;
  expect(key.accessKeyId).toBeTruthy();
  return { connection, key };
}
async function loginMember() {
  member = (await api('POST', '/api/auth/login', '', { email: 'member@aliyun.test', password: 'password123' })).body.token;
}
it('停用切断全部Key且保留策略授权，暂停接入仍执行，恢复只启用managedKey', async () => {
  const { connection, key } = await granted();
  const manual = await ram.createKey(credentials, cloudName());
  await api('POST', `/api/aliyun/connections/${connection.id}/status`, admin, { status: 'paused' });
  const before = (await api('GET', '/api/aliyun/grants', member)).body;
  const disabled = await api('PATCH', `/api/users/${userId}`, admin, { status: 'disabled' });
  expect(disabled.status).toBe(200);
  expect(disabled.body.aliyunSyncPending).toBe(false);
  expect(await ram.keys(credentials, cloudName())).toEqual([
    { id: key.accessKeyId, status: 'Inactive' }, { id: manual.id, status: 'Inactive' },
  ]);
  expect((await api('POST', keyUrl(connection.id), member)).status).toBe(401);
  const enabled = await api('PATCH', `/api/users/${userId}`, admin, { status: 'active' });
  expect(enabled.body.aliyunSyncPending).toBe(false);
  await loginMember();
  expect((await api('POST', keyUrl(connection.id), member)).body).toEqual(key);
  expect(await ram.keys(credentials, cloudName())).toEqual([
    { id: key.accessKeyId, status: 'Active' }, { id: manual.id, status: 'Inactive' },
  ]);
  expect((await ram.userPolicies(credentials, cloudName())).map(p => p.name)).toEqual(['eat-perm-read']);
  expect((await api('GET', '/api/aliyun/grants', member)).body).toEqual(before);
});

afterEach(() => vi.useRealTimers());
async function userStatus() { return (await api('GET', '/api/users')).body.find((u: { id: string }) => u.id === userId); }
it('删控制台登录配置失败持久显示待完成，重启保留退避，重试后不重建控制台登录', async () => {
  await granted();
  ram.setConsoleLogin(credentials, cloudName(), true);
  ram.failActions.set('DeleteLoginProfile', 'AccessDenied');
  const result = await api('PATCH', `/api/users/${userId}`, admin, { status: 'disabled' });
  expect(result.body.aliyunSyncPending).toBe(true);
  expect((await ram.keys(credentials, cloudName())).every(k => k.status === 'Inactive')).toBe(true);
  expect(ram.hasConsoleLogin(credentials, cloudName())).toBe(true);
  expect(await userStatus()).toMatchObject({ aliyunSyncPending: true, aliyunSyncError: expect.stringContaining('AccessDenied') });
  ram.failActions.clear();
  await app.close(); await boot();
  // Startup resumes durable work, respecting the original failed attempt's deadline.
  await app.get(CloudIdentityStatusService).tick();
  expect(ram.hasConsoleLogin(credentials, cloudName())).toBe(true);
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + 31_000);
  await app.get(CloudIdentityStatusService).tick();
  expect(ram.hasConsoleLogin(credentials, cloudName())).toBe(false);
  expect(await userStatus()).toMatchObject({ aliyunSyncPending: false, aliyunSyncError: null });
  await api('PATCH', `/api/users/${userId}`, admin, { status: 'active' });
  expect(ram.hasConsoleLogin(credentials, cloudName())).toBe(false);
});
it('一个Key停用失败也尝试删除控制台登录，后台恢复后全部Key停用', async () => {
  await granted();
  const manual = await ram.createKey(credentials, cloudName());
  ram.setConsoleLogin(credentials, cloudName(), true);
  ram.failKeyStatus = true;
  expect((await api('PATCH', `/api/users/${userId}`, admin, { status: 'disabled' })).body.aliyunSyncPending).toBe(true);
  expect(ram.hasConsoleLogin(credentials, cloudName())).toBe(false);
  expect((await ram.keys(credentials, cloudName())).find(k => k.id === manual.id)?.status).toBe('Active');
  ram.failKeyStatus = false;
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + 31_000);
  await app.get(CloudIdentityStatusService).tick();
  expect((await ram.keys(credentials, cloudName())).every(k => k.status === 'Inactive')).toBe(true);
  await expect.poll(async () => (await userStatus()).aliyunSyncPending).toBe(false);
});
it('同一人在多个云账号都停用，恢复各自managedKey且不改手工Key和策略', async () => {
  const other = { accessKeyId: 'other-management', accessKeySecret: 'other-secret' };
  ram.registerAccount(other, 'account-other');
  const one = await granted();
  const two = await granted(other, 'cloud-two');
  const manualOne = await ram.createKey(credentials, cloudName());
  const manualTwo = await ram.createKey(other, cloudName());
  ram.setConsoleLogin(other, cloudName(), true);
  expect((await api('PATCH', `/api/users/${userId}`, admin, { status: 'disabled' })).body.aliyunSyncPending).toBe(false);
  for (const keys of [credentials, other]) expect((await ram.keys(keys, cloudName())).every(k => k.status === 'Inactive')).toBe(true);
  expect(ram.hasConsoleLogin(other, cloudName())).toBe(false);
  await api('PATCH', `/api/users/${userId}`, admin, { status: 'active' });
  expect(await ram.keys(credentials, cloudName())).toEqual([{ id: one.key.accessKeyId, status: 'Active' }, { id: manualOne.id, status: 'Inactive' }]);
  expect(await ram.keys(other, cloudName())).toEqual([{ id: two.key.accessKeyId, status: 'Active' }, { id: manualTwo.id, status: 'Inactive' }]);
});
it('身份首次持久化与停用并发时，停用hook即使没看见身份也不会漏建活跃Key', async () => {
  const { connection, permissions } = await directory(['read']);
  const fault = new Pool({ connectionString: process.env.DATABASE_URL });
  const lock = await fault.connect();
  try {
    await lock.query('select pg_advisory_lock(140001)');
    await fault.query(`create function pause_first_identity_14() returns trigger language plpgsql as $$
      begin perform pg_advisory_xact_lock(140001); return new; end $$;
      create trigger pause_first_identity_14 before insert on cloud_identity for each row execute function pause_first_identity_14()`);
    const pending = api('POST', `/api/aliyun/permissions/${permissions[0].id}/grants`, admin, { userId });
    await expect.poll(async () => Number((await fault.query("select count(*) from pg_locks where locktype='advisory' and not granted and objid=140001")).rows[0].count)).toBe(1);
    expect((await api('PATCH', `/api/users/${userId}`, admin, { status: 'disabled' })).status).toBe(200);
    await lock.query('select pg_advisory_unlock(140001)');
    expect((await pending).body.state).toBe('failed');
    await app.get(CloudIdentityStatusService).tick();
    await expect(ram.getUser(credentials, cloudName())).rejects.toMatchObject({ kind: 'missing' });
    expect((await api('POST', keyUrl(connection.id), member)).status).toBe(401);
    expect((await userStatus()).aliyunSyncPending).toBe(false);
  } finally {
    await lock.query('select pg_advisory_unlock(140001)'); lock.release();
    await fault.query('drop trigger if exists pause_first_identity_14 on cloud_identity; drop function if exists pause_first_identity_14()');
    await fault.end();
  }
});
it('停用等待在途建Key释放同一身份锁，建Key不能在停用后回传秘密，恢复保留世代恢复能力', async () => {
  const { connection, permissions } = await directory(['read']);
  await api('POST', `/api/aliyun/permissions/${permissions[0].id}/grants`, admin, { userId });
  let release!: () => void, entered!: () => void;
  const blocked = new Promise<void>(r => { release = r; });
  const reached = new Promise<void>(r => { entered = r; });
  ram.afterCreateKey = async () => { entered(); await blocked; };
  const read = api('POST', keyUrl(connection.id), member);
  try {
    await reached;
    const disable = api('PATCH', `/api/users/${userId}`, admin, { status: 'disabled' });
    await expect.poll(async () => (await userStatus()).status).toBe('disabled');
    release();
    expect((await read).status).toBe(403);
    expect((await disable).body.aliyunSyncPending).toBe(false);
    const orphan = (await ram.keys(credentials, cloudName()))[0];
    expect(orphan.status).toBe('Inactive');
    ram.afterCreateKey = undefined;
    await api('PATCH', `/api/users/${userId}`, admin, { status: 'active' });
    await loginMember();
    const recovered = await api('POST', keyUrl(connection.id), member);
    expect(recovered.status).toBe(201);
    expect(recovered.body.generation).toBe(1);
    expect(recovered.body.accessKeyId).not.toBe(orphan.id);
    expect(await ram.keys(credentials, cloudName())).toEqual([{ id: recovered.body.accessKeyId, status: 'Active' }]);
  } finally { release(); ram.afterCreateKey = undefined; }
});
it('启动扫描applied状态与实际用户状态不一致，缺少hook也能兜底切断Key', async () => {
  await granted();
  ram.setConsoleLogin(credentials, cloudName(), true);
  await db.update(schema.users).set({ status: 'disabled' }).where(eq(schema.users.id, userId));
  await app.close(); await boot();
  await expect.poll(async () => (await ram.keys(credentials, cloudName()))[0].status).toBe('Inactive');
  expect(ram.hasConsoleLogin(credentials, cloudName())).toBe(false);
  await expect.poll(async () => (await userStatus()).aliyunSyncPending).toBe(false);
});
it('只有OSS管理配置、没有阿里云接入时仍切断统一身份，OSS功能关闭也不阻断安全停用', async () => {
  await db.insert(schema.ossSettings).values({ bucket: 'fake-bucket', region: 'oss-cn-test', accountId: 'account-test',
    accessKeyIdEncrypted: encryptSecret(credentials.accessKeyId), accessKeySecretEncrypted: encryptSecret(credentials.accessKeySecret), status: 'disabled' });
  // Seed the future migrated OSS identity through the same public identity boundary used by OSS.
  const key = await app.get(CloudIdentitiesService).run('account-test', userId, credentials, session => session.key());
  const manual = await ram.createKey(credentials, cloudName());
  ram.setConsoleLogin(credentials, cloudName(), true);
  expect((await api('GET', '/api/aliyun/connections')).body).toEqual([]);
  expect((await api('PATCH', `/api/users/${userId}`, admin, { status: 'disabled' })).body.aliyunSyncPending).toBe(false);
  expect(await ram.keys(credentials, cloudName())).toEqual([{ id: key!.accessKeyId, status: 'Inactive' }, { id: manual.id, status: 'Inactive' }]);
  expect(ram.hasConsoleLogin(credentials, cloudName())).toBe(false);
  await api('PATCH', `/api/users/${userId}`, admin, { status: 'active' });
  expect(await ram.keys(credentials, cloudName())).toEqual([{ id: key!.accessKeyId, status: 'Active' }, { id: manual.id, status: 'Inactive' }]);
});
it('停用恢复不重置轮换中的Key世代与生效期限，旧Key恢复后仍Inactive', async () => {
  const { connection, key: original } = await granted();
  await new Promise(r => setTimeout(r, 120));
  app.get(CloudIdentitiesService).keyPropagationMs = 60_000;
  const reset = (await api('POST', keyUrl(connection.id) + '/reset', member)).body;
  expect(reset.generation).toBe(2);
  expect((await api('PATCH', `/api/users/${userId}`, admin, { status: 'disabled' })).body.aliyunSyncPending).toBe(false);
  expect((await ram.keys(credentials, cloudName())).every(k => k.status === 'Inactive')).toBe(true);
  await api('PATCH', `/api/users/${userId}`, admin, { status: 'active' });
  await loginMember();
  expect((await api('POST', keyUrl(connection.id), member)).body).toEqual(reset);
  expect(await ram.keys(credentials, cloudName())).toEqual([{ id: original.accessKeyId, status: 'Inactive' }, { id: reset.accessKeyId, status: 'Active' }]);
});
it('列Key失败仍删除控制台登录，重试退避逐次增长并持久保留待完成状态', async () => {
  await granted();
  ram.setConsoleLogin(credentials, cloudName(), true);
  ram.failActions.set('ListAccessKeys', 'NETWORK_ERROR');
  expect((await api('PATCH', `/api/users/${userId}`, admin, { status: 'disabled' })).body.aliyunSyncPending).toBe(true);
  expect(ram.hasConsoleLogin(credentials, cloudName())).toBe(false);
  const start = Date.now();
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(start + 31_000);
  await app.get(CloudIdentityStatusService).tick(); // Second failure now backs off for 60s from this attempt.
  ram.failActions.clear();
  vi.setSystemTime(start + 45_000);
  await app.get(CloudIdentityStatusService).tick();
  expect((await ram.keys(credentials, cloudName()))[0].status).toBe('Active');
  expect((await userStatus()).aliyunSyncPending).toBe(true);
  vi.setSystemTime(start + 96_000);
  await app.get(CloudIdentityStatusService).tick();
  expect((await ram.keys(credentials, cloudName()))[0].status).toBe('Inactive');
  expect((await userStatus()).aliyunSyncPending).toBe(false);
});
it('一个云账号管理凭证故障不阻断其他云账号切断，修复后自动完成失败账号', async () => {
  const other = { accessKeyId: 'other-management', accessKeySecret: 'other-secret' };
  ram.registerAccount(other, 'account-other');
  const one = await granted();
  await granted(other, 'cloud-two');
  await db.update(schema.aliyunConnections).set({ accessKeySecretEncrypted: encryptSecret('invalid-for-test') }).where(eq(schema.aliyunConnections.id, one.connection.id));
  expect((await api('PATCH', `/api/users/${userId}`, admin, { status: 'disabled' })).body.aliyunSyncPending).toBe(true);
  expect((await ram.keys(credentials, cloudName()))[0].status).toBe('Active');
  expect((await ram.keys(other, cloudName()))[0].status).toBe('Inactive');
  expect(await userStatus()).toMatchObject({ aliyunSyncPending: true, aliyunSyncError: expect.stringContaining('AccessDenied') });
  await db.update(schema.aliyunConnections).set({ accessKeySecretEncrypted: encryptSecret(credentials.accessKeySecret) }).where(eq(schema.aliyunConnections.id, one.connection.id));
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + 31_000);
  await app.get(CloudIdentityStatusService).tick();
  expect((await ram.keys(credentials, cloudName()))[0].status).toBe('Inactive');
  expect((await userStatus()).aliyunSyncPending).toBe(false);
});
