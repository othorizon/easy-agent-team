process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://dev@127.0.0.1:5433/eat_test_12';
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
import * as bcrypt from 'bcryptjs';
import { AppModule } from '../src/app.module';
import { DB, type Db } from '../src/db/db.module';
import * as schema from '../src/db/schema';
import { RamCloud } from '../src/ram/ram-cloud';
import { TestRamCloud } from './ram-fixture';
import { eq } from 'drizzle-orm';
import { CloudIdentitiesService } from '../src/cloud-identities/cloud-identities.service';
import { AliyunCredentialsService } from '../src/aliyun/aliyun-credentials.service';
import { aliyunCredentialsSchema } from '@eat/shared';

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
it('只有本人有效授权可领Key，首次创建后重读相同Key，no-store和审计不含秘密', async () => {
  const { connection, permissions } = await directory();
  expect((await api('POST', `/api/aliyun/connections/${connection.id}/credentials`, member)).status).toBe(403);
  expect(ram.keySerial).toBe(0);
  await api('POST', `/api/aliyun/permissions/${permissions[0].id}/grants`, admin, { userId });
  const first = await api('POST', `/api/aliyun/connections/${connection.id}/credentials`, member);
  expect(first.status).toBe(201);
  aliyunCredentialsSchema.parse(first.body);
  expect(first.headers['cache-control']).toBe('no-store');
  expect(first.body).toMatchObject({ accountId: connection.accountId, accessKeyId: 'test-key-1', accessKeySecret: 'test-secret-1' });
  const next = await api('POST', `/api/aliyun/connections/${connection.id}/credentials`, member);
  expect(next.body).toEqual(first.body);
  expect(ram.keySerial).toBe(1);
  const denied = await api('POST', `/api/aliyun/connections/${connection.id}/credentials`, admin, { userId });
  expect(denied.status).toBe(403);
  const audits = (await api('GET', '/api/audit?action=aliyun_credentials.read')).body;
  expect(audits).toHaveLength(2);
  expect(JSON.stringify(audits)).not.toContain('test-secret');
});

async function granted() {
  const { connection, permissions } = await directory();
  await api('POST', `/api/aliyun/permissions/${permissions[0].id}/grants`, admin, { userId });
  return connection;
}
const keyUrl = (id: string) => `/api/aliyun/connections/${id}/credentials`;
const cloud = () => ram.users.get(`eat-${userId.replaceAll('-', '')}`)!;
async function ready() { await new Promise(r => setTimeout(r, 120)); await app.get(AliyunCredentialsService).tick(); }
it('重置保存新Key后等待生效再停删旧Key，重启不丢生效期限且只恢复同一世代', async () => {
  const c = await granted();
  const first = (await api('POST', keyUrl(c.id), member)).body;
  await new Promise(r => setTimeout(r, 120)); // No background tick: reset must finish the prior ready generation itself.
  app.get(CloudIdentitiesService).keyPropagationMs = 1_500;
  const reset = await api('POST', keyUrl(c.id) + '/reset', member);
  expect(reset.status).toBe(201);
  expect(reset.headers['cache-control']).toBe('no-store');
  expect(reset.body.accessKeyId).not.toBe(first.accessKeyId);
  expect(reset.body.generation).toBe(2);
  expect(cloud().keys.map(k => k.status)).toEqual(['Active', 'Active']);
  await app.close(); await boot();
  const reread = await api('POST', keyUrl(c.id), member);
  expect(reread.body).toEqual(reset.body);
  expect(Date.parse(reread.body.readyAt)).toBeGreaterThan(Date.now());
  await new Promise(r => setTimeout(r, Math.max(0, Date.parse(reset.body.readyAt) - Date.now() + 20)));
  await app.get(AliyunCredentialsService).tick();
  expect(cloud().keys.map(k => k.id)).toEqual([reset.body.accessKeyId]);
  expect((await api('GET', '/api/audit?action=aliyun_credentials.reset')).body).toHaveLength(1);
});
it('建Key响应丢失后重启回收孤立Key，基线中的手工Key保持可用', async () => {
  const c = await granted();
  const manual = await ram.createKey(credentials, cloud().userName);
  ram.lostKeyResponse = true;
  expect((await api('POST', keyUrl(c.id), member)).status).toBe(503);
  const orphanId = cloud().keys.find(k => k.id !== manual.id)!.id;
  await app.close(); await boot();
  await expect.poll(async () => (await api('POST', keyUrl(c.id), member)).status).toBe(201);
  const read = (await api('POST', keyUrl(c.id), member)).body;
  expect(cloud().keys).toHaveLength(2);
  expect(cloud().keys.find(k => k.id === manual.id)?.status).toBe('Active');
  expect(cloud().keys.some(k => k.id === orphanId)).toBe(false);
  expect(read.accessKeyId).not.toBe(orphanId);
  expect(read.accessKeyId).not.toBe(manual.id);
});
it('手工Key占满槽位时重置失败保留旧EAT Key与手工Key，释放后可继续同一重置', async () => {
  const c = await granted();
  const first = (await api('POST', keyUrl(c.id), member)).body;
  await ready();
  const manual = await ram.createKey(credentials, cloud().userName);
  const full = await api('POST', keyUrl(c.id) + '/reset', member);
  expect(full.status).toBe(409); expect(full.body.message).toContain('原有 EAT Key 保持可用');
  expect(cloud().keys.map(k => k.id)).toEqual([first.accessKeyId, manual.id]);
  expect(cloud().keys.every(k => k.status === 'Active')).toBe(true);
  expect((await api('POST', keyUrl(c.id), member)).body.accessKeyId).toBe(first.accessKeyId);
  await ram.deleteKey(credentials, cloud().userName, manual.id);
  const retried = await api('POST', keyUrl(c.id) + '/reset', member);
  expect(retried.status).toBe(201); expect(retried.body.generation).toBe(2);
  await ready();
  expect(cloud().keys.map(k => k.id)).toEqual([retried.body.accessKeyId]);
});
it('暂停不能新领或重置、已有Key照常读；停用本人不能读；其他人的连接无授权不能取', async () => {
  const c = await granted();
  await api('POST', `/api/aliyun/connections/${c.id}/status`, admin, { status: 'paused' });
  expect((await api('POST', keyUrl(c.id), member)).status).toBe(409);
  expect(cloud().keys).toEqual([]);
  await api('POST', `/api/aliyun/connections/${c.id}/status`, admin, { status: 'enabled' });
  const first = (await api('POST', keyUrl(c.id), member)).body;
  await api('POST', `/api/aliyun/connections/${c.id}/status`, admin, { status: 'paused' });
  expect((await api('POST', keyUrl(c.id), member)).body).toEqual(first);
  expect((await api('POST', keyUrl(c.id) + '/reset', member)).status).toBe(409);
  await db.update(schema.users).set({ status: 'disabled' }).where(eq(schema.users.id, userId));
  expect((await api('POST', keyUrl(c.id), member)).status).toBe(401);
  expect(cloud().keys).toHaveLength(1);
});
it('重置建Key失响应仍保留旧Key，重启后恢复新世代，停删失败可在暂停时恢复', async () => {
  const c = await granted();
  const first = (await api('POST', keyUrl(c.id), member)).body;
  await ready();
  ram.lostKeyResponse = true;
  expect((await api('POST', keyUrl(c.id) + '/reset', member)).status).toBe(503);
  expect(cloud().keys.find(k => k.id === first.accessKeyId)?.status).toBe('Active');
  await app.close(); await boot();
  await app.get(AliyunCredentialsService).tick();
  const reset = (await api('POST', keyUrl(c.id), member)).body;
  expect(reset.generation).toBe(2);
  expect(reset.accessKeyId).not.toBe(first.accessKeyId);
  ram.failKeyStatus = true;
  await ready();
  expect(cloud().keys).toHaveLength(2);
  await api('POST', `/api/aliyun/connections/${c.id}/status`, admin, { status: 'paused' });
  expect((await api('POST', keyUrl(c.id), member)).body.accessKeyId).toBe(reset.accessKeyId);
  ram.failKeyStatus = false;
  await app.close(); await boot();
  await expect.poll(() => cloud().keys.map(k => k.id)).toEqual([reset.accessKeyId]);
  expect((await api('POST', keyUrl(c.id), member)).body.accessKeyId).toBe(reset.accessKeyId);
});

it('建Key期间丢锁不写成功，重启通过基线回收该Key后恢复，不保留不可读秘密', async () => {
  const c = await granted();
  let proceed!: () => void, entered!: () => void;
  const waiting = new Promise<void>(r => { proceed = r; });
  const reached = new Promise<void>(r => { entered = r; });
  ram.afterCreateKey = async () => { entered(); await waiting; };
  const request = api('POST', keyUrl(c.id), member);
  const fault = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await reached;
    const terminated = await fault.query(`select pg_terminate_backend(a.pid) from pg_stat_activity a
      where a.datname = current_database() and a.pid <> pg_backend_pid() and a.query like 'select pg_advisory_lock%'
      and exists(select 1 from pg_locks l where l.pid = a.pid and l.locktype = 'advisory' and l.granted)`);
    expect(terminated.rowCount).toBe(1);
    await new Promise(r => setTimeout(r, 20));
    proceed();
    expect((await request).status).toBe(409);
    const orphan = cloud().keys[0].id;
    ram.afterCreateKey = undefined;
    await app.close(); await boot();
    const recovered = await api('POST', keyUrl(c.id), member);
    expect(recovered.status).toBe(201);
    expect(recovered.body.accessKeyId).not.toBe(orphan);
    expect(cloud().keys.map(k => k.id)).toEqual([recovered.body.accessKeyId]);
  } finally { proceed(); ram.afterCreateKey = undefined; await fault.end(); }
});
it('授权撤销后不能再读或重置个人Key，所有拒绝不建新Key', async () => {
  const c = await granted();
  const first = (await api('POST', keyUrl(c.id), member)).body;
  const g = (await api('GET', '/api/aliyun/grants', member)).body.grants[0];
  await api('POST', `/api/aliyun/grants/${g.id}/relinquish`, member);
  expect((await api('POST', keyUrl(c.id), member)).status).toBe(403);
  expect((await api('POST', keyUrl(c.id) + '/reset', member)).status).toBe(403);
  expect(cloud().keys.map(k => k.id)).toEqual([first.accessKeyId]);
});

it('管理员有自己的授权也只能领自己的Key，指定他人userId不能读他人SK', async () => {
  const { connection, permissions } = await directory();
  await api('POST', `/api/aliyun/permissions/${permissions[0].id}/grants`, admin, { userId });
  const own = (await api('POST', keyUrl(connection.id), member)).body;
  const [administrator] = await db.select().from(schema.users).where(eq(schema.users.role, 'admin'));
  await api('POST', `/api/aliyun/permissions/${permissions[0].id}/grants`, admin, { userId: administrator.id });
  const other = await api('POST', keyUrl(connection.id), admin, { userId });
  expect(other.status).toBe(201);
  expect(other.body.accessKeySecret).not.toBe(own.accessKeySecret);
  expect((await api('POST', keyUrl(connection.id), member)).body.accessKeySecret).toBe(own.accessKeySecret);
});
it('并发首次领取只创建一把Key，重复读保持同一Key与生效时间', async () => {
  const c = await granted();
  const results = await Promise.all(Array.from({ length: 12 }, () => api('POST', keyUrl(c.id), member)));
  expect(results.every(r => r.status === 201)).toBe(true);
  expect(new Set(results.map(r => r.body.accessKeyId)).size).toBe(1);
  expect(new Set(results.map(r => r.body.readyAt)).size).toBe(1);
  expect(cloud().keys).toHaveLength(1);
});
