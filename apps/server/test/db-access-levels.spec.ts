/** 工单04：完整 HTTP 接口 + 真实 PostgreSQL，管理账号刻意不是超级用户。 */
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://dev@127.0.0.1:5433/eat_test_04';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { Client, Pool } from 'pg';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { AppModule } from '../src/app.module';
import * as schema from '../src/db/schema';

let app: NestFastifyApplication;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const managerPassword = randomUUID();
const manager = `test04_mgr_${suffix}`;
const builder = `test04_builder_${suffix}`;
const dbNames = [`test04_a_${suffix}`, `test04_b_${suffix}`];
const tokens: Record<string, string> = {};
const ids: Record<string, string> = {};
const allocations: any[] = [];
const catalogs: any[] = [];
const createdCatalogIds = new Set<string>();
let instanceId: string;
const q = (s: string) => `"${s.replaceAll('"', '""')}"`;
async function api(method: 'GET'|'POST'|'DELETE', url: string, who = 'owner', payload?: unknown) {
  const res = await app.inject({ method, url, headers: { authorization: `Bearer ${tokens[who]}` }, payload: payload as never });
  const body = JSON.parse(res.body);
  if (body?.source === 'eat' && body.id) createdCatalogIds.add(body.id);
  return { status: res.statusCode, headers: res.headers, body };
}
async function connect(credentials: any) {
  const c = new Client({ connectionString: credentials.url });
  await c.connect();
  return c;
}
async function boot() {
  const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
}
beforeAll(async () => {
  await pool.query('drop schema public cascade; create schema public; drop schema if exists drizzle cascade');
  await migrate(drizzle(pool), { migrationsFolder: path.resolve(process.cwd(), 'drizzle') });
  const db = drizzle(pool, { schema });
  const passwordHash = await bcrypt.hash('password123', 4);
  for (const name of ['admin', 'owner', 'reader', 'other', 'failed']) {
    const [u] = await db.insert(schema.users).values({ name, email: `${name}@test.dev`, role: name === 'admin' ? 'admin' : 'member', passwordHash }).returning();
    ids[name] = u.id;
  }
  await db.insert(schema.userNotifications).values({ userId: ids.reader, webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/db-access-test', verifiedAt: new Date() });
  await pool.query(`create role ${q(manager)} login createrole createdb password '${managerPassword}'`);
  await boot();
  for (const name of Object.keys(ids)) {
    const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: `${name}@test.dev`, password: 'password123' } });
    tokens[name] = JSON.parse(r.body).token;
  }
  const instance = await api('POST', '/api/db/instances', 'admin', { name: '工单04测试', engine: 'postgres', host: '127.0.0.1', port: 5433, adminUser: manager, adminPassword: managerPassword });
  expect(instance.status).toBe(201);
  instanceId = instance.body.id;
  for (const dbName of dbNames) {
    const created = await api('POST', '/api/db/assignments', 'owner', { instanceId, dbName, purpose: '权限测试' });
    allocations.push(created.body);
    const approved = await api('POST', `/api/db/assignments/${created.body.id}/approve`, 'admin');
    expect(approved.body.status, JSON.stringify(approved.body)).toBe('active');
    const credentials = await api('POST', `/api/db/assignments/${created.body.id}/credentials`);
    const owner = await connect(credentials.body);
    try {
      await owner.query('grant create on schema public to public; create schema "odd""schema"; create table "odd""schema".scoped(body text); insert into "odd""schema".scoped values ($$scoped$$); create table notes(id serial primary key, body text); insert into notes(body) values ($$hello$$); create view notes_view as select body from notes');
    } finally { await owner.end(); }
  }
});
afterAll(async () => {
  await app?.close();
  for (const dbName of dbNames) {
    await pool.query('select pg_terminate_backend(pid) from pg_stat_activity where datname=$1', [dbName]);
    await pool.query(`drop database if exists ${q(dbName)}`);
  }
  for (const name of [...dbNames.map(n => `u_${n}`), ...Object.values(ids).map(id => `eat-${id}`), ...[...createdCatalogIds].flatMap(id => [`eat-db-${id}-read`, `eat-db-${id}-write`])]) {
    await pool.query(`drop role if exists ${q(name)}`);
  }
  await pool.query(`drop role if exists ${q(builder)}`);
  await pool.query(`drop role if exists ${q(manager)}`);
  await pool.end();
});

it('读写授权可写表和序列，不包含 CREATE、ALTER 或 TRUNCATE', async () => {
  for (const a of allocations) {
    const c = await api('POST', `/api/db/assignments/${a.id}/access`, 'owner', { open: true });
    expect(c.body.state, JSON.stringify(c.body)).toBe('active');
    catalogs.push(c.body);
  }
  const granted = await api('POST', `/api/db/access/catalog/${catalogs[0].id}/grants`, 'owner', { userId: ids.reader, level: 'write' });
  expect(granted.status, JSON.stringify(granted.body)).toBe(201);
  expect(granted.body).toMatchObject({ state: 'active', level: 'write' });
  const creds = (await api('POST', `/api/db/access/catalog/${catalogs[0].id}/credentials`, 'reader')).body;
  const writer = await connect(creds);
  try {
    expect((await writer.query('insert into notes(body) values ($$write$$) returning id')).rows[0].id).toBe(2);
    expect((await writer.query('update notes set body=$$updated$$ where id=2 returning body')).rows).toEqual([{ body: 'updated' }]);
    expect((await writer.query('delete from notes where id=2 returning id')).rows).toEqual([{ id: 2 }]);
    expect((await writer.query('select last_value from notes_id_seq')).rows[0].last_value).toBe('2');
    for (const sql of ['create table forbidden(id int)', 'alter table notes add column forbidden int', 'truncate notes']) {
      await expect(writer.query(sql)).rejects.toThrow(/permission denied|must be owner/);
    }
    await expect(writer.query('insert into "odd""schema".scoped values ($$forbidden$$)')).rejects.toThrow(/permission denied/);
  } finally { await writer.end(); }
});

it('升级和降级复用同条授权，降级断开该库会话且不影响同实例另一库', async () => {
  const [a, b] = catalogs;
  const read = await api('POST', `/api/db/access/catalog/${a.id}/grants`, 'owner', { userId: ids.other, level: 'read' });
  const upgraded = await api('POST', `/api/db/access/catalog/${a.id}/grants`, 'admin', { userId: ids.other, level: 'write' });
  expect(upgraded.body).toMatchObject({ id: read.body.id, state: 'active', level: 'write' });
  await api('POST', `/api/db/access/catalog/${b.id}/grants`, 'owner', { userId: ids.other, level: 'write' });
  const caCred = (await api('POST', `/api/db/access/catalog/${a.id}/credentials`, 'other')).body;
  const cbCred = (await api('POST', `/api/db/access/catalog/${b.id}/credentials`, 'other')).body;
  expect(cbCred.user).toBe(caCred.user);
  expect(cbCred.password).toBe(caCred.password);
  const ca = await connect(caCred);
  const cb = await connect(cbCred);
  ca.on('error', () => undefined);
  cb.on('error', () => undefined);
  const disconnected = new Promise(resolve => ca.once('error', resolve));
  try {
    await ca.query('insert into notes(body) values ($$upgraded$$)');
    const downgraded = await api('POST', `/api/db/access/catalog/${a.id}/grants`, 'owner', { userId: ids.other, level: 'read' });
    expect(downgraded.body).toMatchObject({ id: read.body.id, state: 'active', level: 'read' });
    await Promise.race([disconnected, new Promise((_, reject) => setTimeout(() => reject(new Error('降级没有断开会话')), 1500))]);
    await expect(ca.query('select 1')).rejects.toThrow();
    const reconnected = await connect(caCred);
    try {
      expect((await reconnected.query('select body from notes limit 1')).rows[0].body).toBe('hello');
      await expect(reconnected.query('insert into notes(body) values ($$denied$$)')).rejects.toThrow(/permission denied/);
      await expect(reconnected.query('select nextval($$notes_id_seq$$)')).rejects.toThrow(/permission denied/);
    } finally { await reconnected.end(); }
    expect((await cb.query('insert into notes(body) values ($$still-write$$) returning body')).rows).toEqual([{ body: 'still-write' }]);
  } finally { await ca.end(); await cb.end(); }
});

it('owner 的未来表/序列自动按级别开放，schema 增减会自动重新应用并撤掉移出 schema 的默认权限', async () => {
  const a = catalogs[0];
  const configured = await api('POST', `/api/db/assignments/${allocations[0].id}/access`, 'owner', { open: true, schemas: ['public', 'odd"schema'] });
  expect(configured.body.state, JSON.stringify(configured.body)).toBe('active');
  expect(configured.body.schemas).toEqual(['public', 'odd"schema']);
  const owner = await connect((await api('POST', `/api/db/assignments/${allocations[0].id}/credentials`)).body);
  const writer = await connect((await api('POST', `/api/db/access/catalog/${a.id}/credentials`, 'reader')).body);
  const reader = await connect((await api('POST', `/api/db/access/catalog/${a.id}/credentials`, 'other')).body);
  try {
    await owner.query('create table future(id serial primary key, body text); create view future_view as select body from future; create table "odd""schema".future(id serial primary key, body text)');
    await writer.query('insert into future(body) values ($$future$$); insert into "odd""schema".future(body) values ($$scoped-future$$)');
    expect((await reader.query('select body from future_view')).rows).toEqual([{ body: 'future' }]);
    expect((await reader.query('select body from "odd""schema".future')).rows).toEqual([{ body: 'scoped-future' }]);
    await expect(reader.query('insert into future(body) values ($$denied$$)')).rejects.toThrow(/permission denied/);
    await expect(reader.query('select nextval($$future_id_seq$$)')).rejects.toThrow(/permission denied/);
    const removed = await api('POST', `/api/db/assignments/${allocations[0].id}/access`, 'owner', { open: true, schemas: ['public'] });
    expect(removed.body).toMatchObject({ state: 'active', schemas: ['public'] });
    // PUBLIC USAGE 不可掩盖物件级权限泄露；移出后再加入USAGE也不能读写旧表或未来表。
    await owner.query('create table "odd""schema".after_remove(id serial primary key, body text); grant usage on schema "odd""schema" to public');
    for (const c of [reader, writer]) {
      await expect(c.query('select * from "odd""schema".future')).rejects.toThrow(/permission denied/);
      await expect(c.query('select * from "odd""schema".after_remove')).rejects.toThrow(/permission denied/);
      await expect(c.query('select nextval($$"odd""schema".future_id_seq$$)')).rejects.toThrow(/permission denied/);
      await expect(c.query('select nextval($$"odd""schema".after_remove_id_seq$$)')).rejects.toThrow(/permission denied/);
    }
    expect((await reader.query('select body from future')).rows).toEqual([{ body: 'future' }]);
  } finally { await owner.end(); await writer.end(); await reader.end(); }
});

it('其他建表角色的新表经重新应用开放，关闭申请后的重应用保留关闭状态', async () => {
  const a = catalogs[0];
  const owner = await connect((await api('POST', `/api/db/assignments/${allocations[0].id}/credentials`)).body);
  const writer = await connect((await api('POST', `/api/db/access/catalog/${a.id}/credentials`, 'reader')).body);
  const reader = await connect((await api('POST', `/api/db/access/catalog/${a.id}/credentials`, 'other')).body);
  const mgmt = new Client({ host: '127.0.0.1', port: 5433, database: 'postgres', user: manager, password: managerPassword });
  const builderPassword = randomUUID();
  await mgmt.connect();
  try {
    await mgmt.query(`create role ${q(builder)} login password '${builderPassword}'`);
    await owner.query(`grant connect on database ${q(dbNames[0])} to ${q(builder)}; grant usage, create on schema public to ${q(builder)}`);
    const otherBuilder = new Client({ host: '127.0.0.1', port: 5433, database: dbNames[0], user: builder, password: builderPassword });
    await otherBuilder.connect();
    try { await otherBuilder.query('create table other_created(id serial primary key, body text)'); }
    finally { await otherBuilder.end(); }
    await expect(reader.query('select * from other_created')).rejects.toThrow(/permission denied/);
    await expect(writer.query('insert into other_created(body) values ($$denied$$)')).rejects.toThrow(/permission denied/);
    expect((await api('POST', `/api/db/access/catalog/${a.id}/reapply`, 'reader')).status).toBe(403);
    await api('POST', `/api/db/assignments/${allocations[0].id}/access`, 'owner', { open: false });
    const reapplied = await api('POST', `/api/db/access/catalog/${a.id}/reapply`, 'owner');
    expect(reapplied.status, JSON.stringify(reapplied.body)).toBe(201);
    expect(reapplied.body).toMatchObject({ state: 'active', open: false, schemas: ['public'] });
    await writer.query('insert into other_created(body) values ($$reapplied$$)');
    expect((await reader.query('select body from other_created')).rows).toEqual([{ body: 'reapplied' }]);
    await expect(reader.query('insert into other_created(body) values ($$denied$$)')).rejects.toThrow(/permission denied/);
    await expect(writer.query('truncate other_created')).rejects.toThrow(/permission denied/);
  } finally { await mgmt.end(); await owner.end(); await writer.end(); await reader.end(); }
});

it('重启恢复待执行降级及关闭库的 schema 变更，并与撤销串行而不影响别库', async () => {
  const [a, b] = catalogs;
  const changed = await api('POST', `/api/db/access/catalog/${a.id}/grants`, 'owner', { userId: ids.other, level: 'write' });
  const credentialsA = (await api('POST', `/api/db/access/catalog/${a.id}/credentials`, 'other')).body;
  const credentialsB = (await api('POST', `/api/db/access/catalog/${b.id}/credentials`, 'other')).body;
  const ca = await connect(credentialsA);
  const cb = await connect(credentialsB);
  ca.on('error', () => undefined);
  cb.on('error', () => undefined);
  const disconnect = new Promise(resolve => ca.once('error', resolve));
  try {
    await app.close();
    const db = drizzle(pool, { schema });
    // 元数据已提交而目标尚未执行：只读恢复必须把旧写组退出并补断会话。
    await db.update(schema.dbAccessGrants).set({ level: 'read', state: 'pending' }).where(eq(schema.dbAccessGrants.id, changed.body.id));
    await db.update(schema.dbCatalog).set({ schemas: ['public', 'odd"schema'], state: 'pending', open: false }).where(eq(schema.dbCatalog.id, a.id));
    await boot();
    await vi.waitFor(async () => {
      const grant = (await api('GET', '/api/db/access/grants', 'other')).body.find((g: any) => g.id === changed.body.id);
      expect(grant).toMatchObject({ level: 'read', state: 'active' });
      const catalog = (await api('GET', '/api/db/access/catalog')).body.find((c: any) => c.id === a.id);
      expect(catalog).toMatchObject({ state: 'active', open: false, schemas: ['public', 'odd"schema'] });
    });
    await disconnect;
    const reconnected = await connect(credentialsA);
    try {
      expect((await reconnected.query('select body from "odd""schema".after_remove')).rows).toEqual([]);
      await expect(reconnected.query('insert into notes(body) values ($$denied$$)')).rejects.toThrow(/permission denied/);
    } finally { await reconnected.end(); }
    // 降级/重应用/撤销共享实例锁，即使并发调用也不把已撤销授权恢复。
    const operations = await Promise.all([
      api('POST', `/api/db/access/catalog/${a.id}/reapply`, 'owner'),
      api('POST', `/api/db/access/grants/${changed.body.id}/revoke`, 'owner', { reason: '恢复后撤销' }),
    ]);
    expect(operations.every(r => r.status === 201)).toBe(true);
    expect((await api('GET', '/api/db/access/grants', 'other')).body.find((g: any) => g.id === changed.body.id).state).toBe('revoked');
    expect((await cb.query('insert into notes(body) values ($$unaffected$$) returning body')).rows).toEqual([{ body: 'unaffected' }]);
    expect((await api('POST', `/api/db/access/catalog/${a.id}/credentials`, 'other')).status).toBe(403);
  } finally { await ca.end(); await cb.end(); }
});

it('读写执行失败后的重试保留目标级别及同一条授权，重复授予不扩大权限', async () => {
  const a = catalogs[0];
  const role = `eat-${ids.failed}`;
  await pool.query(`create role ${q(role)} login password 'not-managed'`);
  let failed: any;
  try {
    failed = await api('POST', `/api/db/access/catalog/${a.id}/grants`, 'owner', { userId: ids.failed, level: 'write' });
    expect(failed.body).toMatchObject({ level: 'write', state: 'failed' });
    expect(failed.body.error).toContain('不会接管');
  } finally { await pool.query(`drop role ${q(role)}`); }
  const retried = await api('POST', `/api/db/access/grants/${failed.body.id}/retry`, 'owner');
  expect(retried.body).toMatchObject({ id: failed.body.id, level: 'write', state: 'active' });
  const repeats = await Promise.all(Array.from({ length: 6 }, () => api('POST', `/api/db/access/catalog/${a.id}/grants`, 'owner', { userId: ids.failed, level: 'write' })));
  expect(repeats.every(r => r.body.id === failed.body.id && r.body.state === 'active')).toBe(true);
  const actual = await connect((await api('POST', `/api/db/access/catalog/${a.id}/credentials`, 'failed')).body);
  try {
    expect((await actual.query('insert into notes(body) values ($$retried-write$$) returning body')).rows).toEqual([{ body: 'retried-write' }]);
    await expect(actual.query('truncate notes')).rejects.toThrow(/permission denied/);
  } finally { await actual.end(); }
});
