/** 工单03：完整 HTTP 接口 + 真实 PostgreSQL，管理账号刻意不是超级用户。 */
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://dev@127.0.0.1:5433/eat_test_03';
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
const manager = `test_mgr_${suffix}`;
const dbNames = [`test_a_${suffix}`, `test_b_${suffix}`];
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
  const instance = await api('POST', '/api/db/instances', 'admin', { name: '工单03测试', engine: 'postgres', host: '127.0.0.1', port: 5433, adminUser: manager, adminPassword: managerPassword });
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
  await pool.query(`drop role if exists ${q(manager)}`);
  await pool.end();
});

it('Owner 开放 EAT 建的库：只读凭证能查询表和视图，拒绝写入与建表', async () => {
  const opened = await api('POST', `/api/db/assignments/${allocations[0].id}/access`, 'owner', { open: true });
  expect(opened.status).toBe(201);
  expect(opened.body).toMatchObject({ open: true, schemas: ['public'], state: 'active', canManage: true });
  catalogs.push(opened.body);
  const granted = await api('POST', `/api/db/access/catalog/${opened.body.id}/grants`, 'owner', { userId: ids.reader, level: 'read' });
  expect(granted.status).toBe(201);
  expect(granted.body, JSON.stringify(granted.body)).toMatchObject({ state: 'active', level: 'read', userId: ids.reader });
  const credential = await api('POST', `/api/db/access/catalog/${opened.body.id}/credentials`, 'reader');
  expect(credential.status).toBe(201);
  expect(credential.headers['cache-control']).toBe('no-store');
  expect(credential.body.user).toBe(`eat-${ids.reader}`);
  const c = await connect(credential.body);
  try {
    expect((await c.query('select body from notes')).rows).toEqual([{ body: 'hello' }]);
    expect((await c.query('select body from notes_view')).rows).toEqual([{ body: 'hello' }]);
    await expect(c.query('select * from "odd""schema".scoped')).rejects.toThrow(/permission denied/);
    const ownerCredentials = (await api('POST', `/api/db/assignments/${allocations[0].id}/credentials`)).body;
    const owner = await connect(ownerCredentials);
    try { await owner.query('create table later(body text); insert into later values ($$later$$); create view later_view as select body from later'); }
    finally { await owner.end(); }
    expect((await c.query('select body from later')).rows).toEqual([{ body: 'later' }]);
    expect((await c.query('select body from later_view')).rows).toEqual([{ body: 'later' }]);
    for (const sql of ['insert into notes(body) values ($$x$$)', 'update notes set body=$$x$$', 'delete from notes', 'create table forbidden(id int)']) {
      await expect(c.query(sql)).rejects.toThrow(/permission denied/);
    }
  } finally { await c.end(); }
});

it('双库复用个人角色、隔离 CONNECT；撤销 A 断开会话、发通知且 B 继续可用', async () => {
  const a = catalogs[0];
  const broken = await api('POST', `/api/db/assignments/${allocations[1].id}/access`, 'owner', { open: true, schemas: ['missing_schema'] });
  expect(broken.body.state).toBe('failed');
  expect(broken.body.error).toContain('missing_schema');
  expect((await api('GET', '/api/db/access/catalog', 'reader')).body.find((r: any) => r.id === broken.body.id)).toBeUndefined();
  const opened = await api('POST', `/api/db/assignments/${allocations[1].id}/access`, 'owner', { open: true, schemas: ['public', 'odd"schema'] });
  expect(opened.body.id).toBe(broken.body.id);
  expect(opened.body.state).toBe('active');
  const b = opened.body;
  catalogs.push(b);
  const aCredentials = (await api('POST', `/api/db/access/catalog/${a.id}/credentials`, 'reader')).body;
  const denied = new Client({ connectionString: aCredentials.url.replace(dbNames[0], dbNames[1]) });
  await expect(denied.connect()).rejects.toThrow(/permission denied/);
  await denied.end();
  const grants = await api('GET', '/api/db/access/grants', 'reader');
  const aGrant = grants.body.find((g: any) => g.catalogId === a.id);
  const duplicate = await api('POST', `/api/db/access/catalog/${a.id}/grants`, 'owner', { userId: ids.reader, level: 'read' });
  expect(duplicate.body.id).toBe(aGrant.id);
  const bGrant = await api('POST', `/api/db/access/catalog/${b.id}/grants`, 'admin', { userId: ids.reader, level: 'read' });
  const bCredentials = (await api('POST', `/api/db/access/catalog/${b.id}/credentials`, 'reader')).body;
  expect(bCredentials.user).toBe(aCredentials.user);
  expect(bCredentials.password).toBe(aCredentials.password);
  const ca = await connect(aCredentials);
  ca.on('error', () => undefined);
  const cb = await connect(bCredentials);
  cb.on('error', () => undefined);
  const disconnect = new Promise(resolve => ca.once('error', resolve));
  const cards: any[] = [];
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    cards.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ code: 0 }), { status: 200 });
  });
  try {
    const revoked = await api('POST', `/api/db/access/grants/${aGrant.id}/revoke`, 'owner', { reason: '分析已完成' });
    expect(revoked.status).toBe(201);
    expect(revoked.body.state, JSON.stringify(revoked.body)).toBe('revoked');
    await disconnect;
    await expect(ca.query('select 1')).rejects.toThrow();
    const reconnect = new Client({ connectionString: aCredentials.url });
    await expect(reconnect.connect()).rejects.toThrow(/permission denied/);
    await reconnect.end();
    expect((await cb.query('select body from notes')).rows[0].body).toBe('hello');
    expect((await cb.query('select body from "odd""schema".scoped')).rows[0].body).toBe('scoped');
    await vi.waitFor(() => expect(cards).toHaveLength(1));
    expect(JSON.stringify(cards[0])).toContain('owner');
    expect(JSON.stringify(cards[0])).toContain('分析已完成');
    const relinquished = await api('POST', `/api/db/access/grants/${bGrant.body.id}/relinquish`, 'reader', {});
    expect(relinquished.body.state).toBe('revoked');
    expect(cards).toHaveLength(1);
  } finally {
    fetchSpy.mockRestore();
    await ca.end();
    await cb.end();
  }
});

it('失败重试不接管同名角色，复用授权与凭证；并发重复授予只有一条授权', async () => {
  const c = catalogs[0];
  const role = `eat-${ids.other}`;
  await pool.query(`create role ${q(role)} login password 'not-managed'`);
  let failed: any;
  try {
    failed = await api('POST', `/api/db/access/catalog/${c.id}/grants`, 'owner', { userId: ids.other, level: 'read' });
    expect(failed.body.state).toBe('failed');
    expect(failed.body.error).toContain('不会接管');
    expect((await api('POST', `/api/db/access/catalog/${c.id}/credentials`, 'other')).status).toBe(403);
    expect((await api('POST', `/api/db/access/grants/${failed.body.id}/retry`, 'reader')).status).toBe(403);
  } finally { await pool.query(`drop role ${q(role)}`); }
  const retry = await api('POST', `/api/db/access/grants/${failed.body.id}/retry`, 'owner');
  expect(retry.body).toMatchObject({ id: failed.body.id, state: 'active' });
  const repeats = await Promise.all(Array.from({ length: 12 }, () => api('POST', `/api/db/access/catalog/${c.id}/grants`, 'owner', { userId: ids.other, level: 'read' })));
  expect(repeats.every(r => r.body.id === failed.body.id && r.body.state === 'active')).toBe(true);
  const cred = await api('POST', `/api/db/access/catalog/${c.id}/credentials`, 'other');
  const repeatCred = await api('POST', `/api/db/access/catalog/${c.id}/credentials`, 'other');
  expect(repeatCred.body).toEqual(cred.body);
  const actual = await connect(cred.body);
  try { expect((await actual.query('select body from notes')).rows[0].body).toBe('hello'); }
  finally { await actual.end(); }
});

it('Owner 和管理员管理目录，成员只看开放库；关闭不影响授权、个人凭证仅本人可读并记审计', async () => {
  const c = catalogs[0];
  expect((await api('POST', `/api/db/assignments/${allocations[0].id}/access`, 'reader', { open: false })).status).toBe(403);
  expect((await api('POST', `/api/db/access/catalog/${c.id}/grants`, 'reader', { userId: ids.reader, level: 'read' })).status).toBe(403);
  expect((await api('POST', `/api/db/access/catalog/${c.id}/grants`, 'owner', { userId: ids.reader, level: 'owner' })).status).toBe(400);
  const closed = await api('POST', `/api/db/assignments/${allocations[0].id}/access`, 'owner', { open: false });
  expect(closed.body).toMatchObject({ id: c.id, open: false, state: 'active' });
  const memberCatalog = await api('GET', '/api/db/access/catalog', 'reader');
  expect(memberCatalog.body.map((r: any) => r.id)).not.toContain(c.id);
  expect((await api('GET', '/api/db/access/catalog', 'owner')).body.find((r: any) => r.id === c.id).canManage).toBe(true);
  expect((await api('GET', '/api/db/access/catalog', 'admin')).body).toHaveLength(2);
  // 管理员没有借「查看其他人的授权」读取对方个人凭证的接口。
  expect((await api('POST', `/api/db/access/catalog/${c.id}/credentials`, 'admin')).status).toBe(403);
  expect((await api('POST', `/api/db/access/catalog/${c.id}/credentials`, 'owner')).status).toBe(403);
  const own = await api('POST', `/api/db/access/catalog/${c.id}/credentials`, 'other');
  expect(own.headers['cache-control']).toBe('no-store');
  const connection = await connect(own.body);
  try { expect((await connection.query('select body from notes_view')).rows[0].body).toBe('hello'); }
  finally { await connection.end(); }
  const audits = await api('GET', '/api/audit?action=db_access.credentials.read', 'admin');
  expect(audits.body.some((a: any) => a.actorId === ids.other)).toBe(true);
  for (const action of ['opened', 'closed', 'granted', 'revoked', 'relinquished']) {
    expect((await api('GET', `/api/audit?action=db_access.${action}`, 'admin')).body.length).toBeGreaterThan(0);
  }
  const mysql = await api('POST', '/api/db/instances', 'admin', { name: '仅检查MySQL', engine: 'mysql', host: 'localhost', port: 3306, adminUser: 'unused' });
  const mysqlAssignment = await api('POST', '/api/db/assignments', 'owner', { instanceId: mysql.body.id, dbName: 'mysql_test', purpose: '不应被开放' });
  expect((await api('POST', `/api/db/assignments/${mysqlAssignment.body.id}/access`, 'owner', { open: true })).status).toBe(400);
});

it('尚未在实例创建个人角色的失败授权也能放弃', async () => {
  const c = catalogs[0];
  const role = `eat-${ids.failed}`;
  await pool.query(`create role ${q(role)}`);
  const failed = await api('POST', `/api/db/access/catalog/${c.id}/grants`, 'owner', { userId: ids.failed, level: 'read' });
  expect(failed.body.state).toBe('failed');
  await pool.query(`drop role ${q(role)}`);
  const relinquished = await api('POST', `/api/db/access/grants/${failed.body.id}/relinquish`, 'failed');
  expect(relinquished.body.state, JSON.stringify(relinquished.body)).toBe('revoked');
});

it('重启恢复持久化的开放与授权操作，撤销失败也会在重启后完成', async () => {
  // 模拟目标事务已提交、进程尚未来得及写回完成状态的崩溃点。
  // 只将测试起始状态布置为未完成；断言仍全部经 HTTP 与真实连接观察。
  const c = catalogs[0];
  const g = (await api('GET', '/api/db/access/grants', 'other')).body.find((g: any) => g.catalogId === c.id);
  await app.close();
  const db = drizzle(pool, { schema });
  await db.update(schema.dbCatalog).set({ state: 'pending', open: false }).where(eq(schema.dbCatalog.id, c.id));
  await db.update(schema.dbAccessGrants).set({ state: 'pending' }).where(eq(schema.dbAccessGrants.id, g.id));
  await boot();
  await vi.waitFor(async () => {
    const catalog = await api('GET', '/api/db/access/catalog');
    expect(catalog.body.find((r: any) => r.id === c.id)?.state).toBe('active');
    expect((await api('GET', '/api/db/access/grants', 'other')).body.find((r: any) => r.id === g.id)?.state).toBe('active');
  });
  const creds = (await api('POST', `/api/db/access/catalog/${c.id}/credentials`, 'other')).body;
  const actual = await connect(creds);
  actual.on('error', () => undefined);
  try {
    await pool.query(`alter role ${q(manager)} nologin`);
    const revoked = await api('POST', `/api/db/access/grants/${g.id}/revoke`, 'owner', { reason: '恢复测试' });
    expect(revoked.body.state).toBe('revoking');
    expect(revoked.body.error).toBeTruthy();
  } finally { await pool.query(`alter role ${q(manager)} login`); }
  await app.close();
  await boot();
  await vi.waitFor(async () => expect((await api('GET', '/api/db/access/grants', 'other')).body.find((r: any) => r.id === g.id)?.state).toBe('revoked'));
  await expect(actual.query('select 1')).rejects.toThrow();
  await actual.end();
  expect((await api('POST', `/api/db/access/catalog/${c.id}/credentials`, 'other')).status).toBe(403);
});
