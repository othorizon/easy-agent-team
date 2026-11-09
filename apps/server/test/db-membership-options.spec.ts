/** PG16 membership options, through full HTTP with an ordinary manager. UUID resources only. */
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://dev@127.0.0.1:5433/eat_review_test';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcryptjs';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { Client, Pool } from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import * as schema from '../src/db/schema';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const suffix = randomUUID().replaceAll('-', '').slice(0, 12), password = randomUUID();
const manager = `aopts_mgr_${suffix}`, owner = `opts_owner_${suffix}`, delegate = `opts_delegate_${suffix}`, database = `opts_db_${suffix}`;
const q = (s: string) => `"${s.replaceAll('"', '""')}"`;
const tokens: Record<string, string> = {}, ids: Record<string, string> = {};
const roles = new Set([manager, owner, delegate]), databases = new Set([database]);
let app: NestFastifyApplication, instanceId: string, catalog: any, grant: any;
const personal = () => `eat-${ids.reader}`;
const read = () => `eat-db-${catalog.id}-read`;
async function api(method: 'GET' | 'POST' | 'PATCH', url: string, who = 'admin', payload?: unknown) {
  const r = await app.inject({ method, url, headers: { authorization: `Bearer ${tokens[who]}` }, payload: payload as never });
  return { status: r.statusCode, body: JSON.parse(r.body) };
}
async function asManager(sql: string) {
  const c = new Client({ host: '127.0.0.1', port: 5433, database: 'postgres', user: manager, password });
  await c.connect(); try { return await c.query(sql); } finally { await c.end(); }
}
async function options(group = read(), member = personal()) {
  return (await pool.query(`select g.rolname grantor,a.admin_option admin,a.inherit_option inherit,a.set_option set
    from pg_auth_members a join pg_roles r on r.oid=a.roleid join pg_roles m on m.oid=a.member join pg_roles g on g.oid=a.grantor
    where r.rolname=$1 and m.rolname=$2 order by g.rolname`, [group, member])).rows;
}
async function inspect() {
  const r = await api('GET', '/api/db/access/catalog'); expect(r.status).toBe(200);
  return r.body.find((c: any) => c.id === catalog.id).drift;
}
async function credentials() {
  const r = await api('POST', `/api/db/access/catalog/${catalog.id}/credentials`, 'reader');
  expect(r.status, JSON.stringify(r.body)).toBe(201); return r.body;
}
async function readerWorks() {
  const credential = await credentials(), c = new Client({ connectionString: credential.url });
  await c.connect();
  try {
    expect((await c.query('select body from facts')).rows).toEqual([{ body: 'scoped facts' }]);
    await expect(c.query("insert into facts values ('blocked')")).rejects.toMatchObject({ code: '42501' });
    await expect(c.query(`grant ${q(read())} to ${q(delegate)}`)).rejects.toMatchObject({ code: '42501' });
  } finally { await c.end(); }
}
beforeAll(async () => {
  await pool.query('drop schema public cascade; create schema public; drop schema if exists drizzle cascade');
  await migrate(drizzle(pool), { migrationsFolder: resolve('drizzle') });
  const db = drizzle(pool, { schema }), passwordHash = await bcrypt.hash('password123', 4);
  for (const name of ['admin', 'owner', 'reader', 'other']) {
    const [u] = await db.insert(schema.users).values({ name, email: `${name}@opts.test`, role: name === 'admin' ? 'admin' : 'member', passwordHash }).returning(); ids[name] = u.id;
    roles.add(`eat-${u.id}`);
  }
  await pool.query(`create role ${q(manager)} login createrole createdb password '${password}'; create role ${q(owner)} login password '${password}'; create role ${q(delegate)}; grant ${q(owner)} to ${q(manager)} with set true, inherit false`);
  await pool.query(`create database ${q(database)} owner ${q(owner)}`);
  const c = new Client({ host: '127.0.0.1', port: 5433, database, user: owner, password });
  await c.connect(); try { await c.query(`create table facts(body text); insert into facts values ('scoped facts'); revoke connect on database ${q(database)} from public; grant connect on database ${q(database)} to ${q(manager)}`); } finally { await c.end(); }
  const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter()); await app.init(); await app.getHttpAdapter().getInstance().ready();
  for (const name of Object.keys(ids)) tokens[name] = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: `${name}@opts.test`, password: 'password123' } })).json().token;
  instanceId = (await api('POST', '/api/db/instances', 'admin', { name: 'PG16 options', engine: 'postgres', host: '127.0.0.1', port: 5433, adminUser: manager, adminPassword: password })).body.id;
  const registered = await api('POST', `/api/db/instances/${instanceId}/access/catalog`, 'admin', { dbName: database, ownerId: ids.owner, creatorRole: owner });
  expect(registered.status, JSON.stringify(registered.body)).toBe(201); catalog = registered.body;
  roles.add(read()); roles.add(`eat-db-${catalog.id}-write`);
  grant = (await api('POST', `/api/db/access/catalog/${catalog.id}/grants`, 'owner', { userId: ids.reader, level: 'read' })).body;
  expect(grant.state, JSON.stringify(grant)).toBe('active');
});
afterAll(async () => {
  const manifest = `/tmp/eat-review-pg-${suffix}.json`;
  const resources = { roles: [...roles], databases: [...databases] };
  await writeFile(manifest, JSON.stringify(resources));
  await app?.close();
  for (const db of databases) { await pool.query('select pg_terminate_backend(pid) from pg_stat_activity where datname=$1', [db]); await pool.query(`drop database if exists ${q(db)}`); }
  // Drop the dependent recipient before its grantors; no CASCADE outside this UUID resource list.
  for (const role of [delegate, ...[...roles].filter(r => ![delegate, manager, owner].includes(r)), owner, manager]) await pool.query(`drop role if exists ${q(role)}`);
  expect((await pool.query('select rolname from pg_roles where rolname=any($1::text[])', [[...roles]])).rows).toEqual([]);
  expect((await pool.query('select datname from pg_database where datname=any($1::text[])', [[...databases]])).rows).toEqual([]);
  await writeFile(manifest, JSON.stringify({ ...resources, cleaned: true, remainingRoles: [], remainingDatabases: [] }));
  await pool.end();
});

it('同组仅选项变化按grantor展示且核对零写；显式修复恢复查询并阻止转授', async () => {
  expect((await asManager('select rolsuper from pg_roles where rolname=current_user')).rows).toEqual([{ rolsuper: false }]);
  await readerWorks();
  await asManager(`grant ${q(read())} to ${q(personal())} with admin true, inherit false, set false`);
  const before = await options(), credential = await credentials(), blocked = new Client({ connectionString: credential.url });
  await expect(blocked.connect()).rejects.toMatchObject({ code: '42501' }); await blocked.end();
  const drift = await inspect();
  expect(drift).toMatchObject({ consistent: false, error: null, members: expect.arrayContaining([expect.objectContaining({
    role: personal(), expected: [read()], actual: [read()], missing: [], extra: [],
    optionDiffs: [{ group: read(), grantor: manager, expected: { admin: false, inherit: true, set: true }, actual: { admin: true, inherit: false, set: false } }],
  })]) });
  expect(await options()).toEqual(before);
  expect((await api('POST', `/api/db/access/catalog/${catalog.id}/repair`, 'owner')).status).toBe(403);
  const repaired = await api('POST', `/api/db/access/catalog/${catalog.id}/repair`);
  expect(repaired.status, JSON.stringify(repaired.body)).toBe(201); expect(repaired.body.consistent).toBe(true);
  await readerWorks();
});

it('ADMIN、INHERIT、SET单独变化均报告真实差异，个人纯ADMIN不能套用管理账号例外', async () => {
  for (const changed of [{ admin: true, inherit: true, set: true }, { admin: false, inherit: false, set: true }, { admin: false, inherit: true, set: false }, { admin: true, inherit: false, set: false }]) {
    await asManager(`grant ${q(read())} to ${q(personal())} with admin ${changed.admin}, inherit ${changed.inherit}, set ${changed.set}`);
    const drift = await inspect();
    expect(drift.consistent).toBe(false);
    expect(drift.members.find((m: any) => m.role === personal())).toMatchObject({ missing: [], extra: [], optionDiffs: [{ group: read(), grantor: manager, expected: { admin: false, inherit: true, set: true }, actual: changed }] });
    const repair = await api('POST', `/api/db/access/catalog/${catalog.id}/repair`);
    expect(repair.status, JSON.stringify(repair.body)).toBe(201); expect(repair.body.consistent).toBe(true);
    await readerWorks();
  }
});

it('显式同级give恢复选项；已经规范的重复give保留既有只读会话', async () => {
  const credential = await credentials(), c = new Client({ connectionString: credential.url });
  await c.connect();
  try {
    expect((await api('POST', `/api/db/access/catalog/${catalog.id}/grants`, 'owner', { userId: ids.reader, level: 'read' })).body).toMatchObject({ id: grant.id, state: 'active' });
    expect((await c.query('select body from facts')).rows).toEqual([{ body: 'scoped facts' }]);
  } finally { await c.end(); }
  await asManager(`grant ${q(read())} to ${q(personal())} with admin true, inherit false, set false`);
  const given = await api('POST', `/api/db/access/catalog/${catalog.id}/grants`, 'owner', { userId: ids.reader, level: 'read' });
  expect(given.body).toMatchObject({ id: grant.id, state: 'active' });
  expect((await inspect()).consistent).toBe(true);
  await readerWorks();
});

it('每个grantor均核对；无权修改foreign grantor时修复及give不假绿并整笔回滚，DBA处理后retry恢复', async () => {
  await pool.query(`grant ${q(read())} to ${q(personal())} with admin true, inherit false, set false`);
  await asManager(`grant ${q(read())} to ${q(personal())} with admin true, inherit false, set false`);
  const before = await options(), drift = await inspect();
  expect(drift.consistent).toBe(false);
  expect(drift.members.find((m: any) => m.role === personal()).optionDiffs.map((d: any) => d.grantor).sort()).toEqual(['dev', manager].sort());
  expect(await options()).toEqual(before);
  const repair = await api('POST', `/api/db/access/catalog/${catalog.id}/repair`);
  expect(repair.status, JSON.stringify(repair.body)).toBe(409);
  const sql = `grant ${q(read())} to ${q(personal())} with admin false, inherit true, set true granted by "dev"`;
  expect(repair.body.message).toContain(sql); expect(repair.body.message).toContain('回滚');
  expect(await options()).toEqual(before);
  const given = await api('POST', `/api/db/access/catalog/${catalog.id}/grants`, 'owner', { userId: ids.reader, level: 'read' });
  expect(given.body).toMatchObject({ id: grant.id, state: 'failed' }); expect(given.body.error).toContain(sql);
  expect(await options()).toEqual(before);
  await pool.query(`revoke ${q(read())} from ${q(personal())} granted by "dev" restrict`);
  const retried = await api('POST', `/api/db/access/grants/${grant.id}/retry`, 'owner');
  expect(retried.body).toMatchObject({ id: grant.id, state: 'active', error: null });
  expect((await inspect()).consistent).toBe(true); await readerWorks();
});

it('个人已转授时撤ADMIN明确失败并回滚，不级联删除其他成员；DBA精确处理依赖后修复恢复', async () => {
  await asManager(`grant ${q(read())} to ${q(personal())} with admin true, inherit false, set false`);
  const credential = await credentials(), c = new Client({ host: '127.0.0.1', port: 5433, database: 'postgres', user: credential.user, password: credential.password });
  await c.connect();
  try { await c.query(`grant ${q(read())} to ${q(delegate)}`); } finally { await c.end(); }
  const before = await options(), delegated = await options(read(), delegate);
  expect(delegated).toEqual([{ grantor: personal(), admin: false, inherit: true, set: true }]);
  const repair = await api('POST', `/api/db/access/catalog/${catalog.id}/repair`);
  expect(repair.status, JSON.stringify(repair.body)).toBe(409);
  expect(repair.body.message).toContain('依赖授予');
  expect(repair.body.message).toContain(`grant ${q(read())} to ${q(personal())} with admin false, inherit true, set true granted by ${q(manager)}`);
  expect(await options()).toEqual(before); expect(await options(read(), delegate)).toEqual(delegated);
  expect((await inspect()).consistent).toBe(false);
  const given = await api('POST', `/api/db/access/catalog/${catalog.id}/grants`, 'owner', { userId: ids.reader, level: 'read' });
  expect(given.body.state).toBe('failed'); expect(given.body.error).toContain('依赖授予');
  expect(await options()).toEqual(before); expect(await options(read(), delegate)).toEqual(delegated);
  await pool.query(`revoke ${q(read())} from ${q(delegate)} granted by ${q(personal())} restrict`);
  expect((await api('POST', `/api/db/access/grants/${grant.id}/retry`, 'owner')).body.state).toBe('active');
  const repaired = await api('POST', `/api/db/access/catalog/${catalog.id}/repair`);
  expect(repaired.status, JSON.stringify(repaired.body)).toBe(201); expect(repaired.body.consistent).toBe(true);
  await readerWorks();
});

it('管理连接的INHERIT/SET可修复，额外组去掉数据权限时保留纯ADMIN及后续授予和重连能力', async () => {
  const dbName = `opts_eat_${suffix}`;
  const requested = await api('POST', '/api/db/assignments', 'owner', { instanceId, dbName, purpose: 'management reconnect guard' });
  expect(requested.status, JSON.stringify(requested.body)).toBe(201);
  const approved = await api('POST', `/api/db/assignments/${requested.body.id}/approve`);
  expect(approved.body.status, JSON.stringify(approved.body)).toBe('active');
  databases.add(dbName); roles.add(approved.body.dbUser);
  const credential = (await api('POST', `/api/db/assignments/${requested.body.id}/credentials`, 'owner')).body;
  const c = new Client({ connectionString: credential.url });
  await c.connect(); try { await c.query("create table facts(body text); insert into facts values ('management stays connected')"); } finally { await c.end(); }
  const opened = await api('POST', `/api/db/assignments/${requested.body.id}/access`, 'owner', { open: true });
  expect(opened.body.state, JSON.stringify(opened.body)).toBe('active');
  const id = opened.body.id, readGroup = `eat-db-${id}-read`, writeGroup = `eat-db-${id}-write`;
  roles.add(readGroup); roles.add(writeGroup);
  const adminBefore = { read: (await options(readGroup, manager)).filter(m => m.admin && !m.inherit && !m.set), write: (await options(writeGroup, manager)).filter(m => m.admin && !m.inherit && !m.set) };
  expect(adminBefore.read.length).toBeGreaterThan(0); expect(adminBefore.write.length).toBeGreaterThan(0);
  await asManager(`grant ${q(readGroup)} to ${q(manager)} with inherit true, set true; grant ${q(writeGroup)} to ${q(manager)} with inherit true, set true`);
  const view = (await api('GET', '/api/db/access/catalog')).body.find((r: any) => r.id === id);
  expect(view.drift).toMatchObject({ consistent: false, members: expect.arrayContaining([expect.objectContaining({ role: manager, extra: [writeGroup], optionDiffs: [expect.objectContaining({ group: readGroup, grantor: manager, expected: { admin: false, inherit: true, set: false }, actual: { admin: false, inherit: true, set: true } })] })]) });
  const repaired = await api('POST', `/api/db/access/catalog/${id}/repair`);
  expect(repaired.status, JSON.stringify(repaired.body)).toBe(201); expect(repaired.body.consistent).toBe(true);
  expect((await options(readGroup, manager)).filter(m => m.admin && !m.inherit && !m.set)).toEqual(adminBefore.read);
  expect(await options(writeGroup, manager)).toEqual(adminBefore.write);
  expect((await api('POST', `/api/db/access/catalog/${id}/reapply`, 'owner')).body.state).toBe('active');
  expect((await api('POST', `/api/db/access/catalog/${id}/grants`, 'owner', { userId: ids.other, level: 'read' })).body.state).toBe('active');
  const personalCredential = (await api('POST', `/api/db/access/catalog/${id}/credentials`, 'other')).body;
  const reader = new Client({ connectionString: personalCredential.url });
  await reader.connect(); try { expect((await reader.query('select body from facts')).rows).toEqual([{ body: 'management stays connected' }]); } finally { await reader.end(); }
});
