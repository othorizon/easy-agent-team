/** 工单07：外部库登记仅走 HTTP；权限用非超级管理角色与真实 PG 验证。 */
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://dev@127.0.0.1:5433/eat_test_07';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcryptjs';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { Client, Pool } from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import * as schema from '../src/db/schema';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const q = (s: string) => `"${s.replaceAll('"', '""')}"`;
const names = { manager: `ext_mgr_${suffix}`, weak: `ext_weak_${suffix}`, owner: `ext_owner_${suffix}`, inherited: `ext_inherited_${suffix}`, readerGroup: `ext_read_${suffix}`, granter: `ext_grant_${suffix}` };
const password = randomUUID();
const database = `ext_data_${suffix}`;
const catalogIds = new Set<string>();
const tokens: Record<string, string> = {}, ids: Record<string, string> = {};
let app: NestFastifyApplication;
let instanceId: string;
let catalog: any;
async function api(method: 'GET' | 'POST', url: string, who = 'admin', payload?: unknown) {
  const response = await app.inject({ method, url, headers: { authorization: `Bearer ${tokens[who]}` }, payload: payload as never });
  const body = JSON.parse(response.body);
  if (body.source === 'external' && body.id) catalogIds.add(body.id);
  return { status: response.statusCode, body };
}
async function target(user: string, db = database) {
  const c = new Client({ host: '127.0.0.1', port: 5433, database: db, user, password });
  await c.connect();
  return c;
}
async function register(instance = instanceId, extra: Record<string, unknown> = {}) {
  return api('POST', `/api/db/instances/${instance}/access/catalog`, 'admin', { dbName: database, ownerId: ids.owner, schemas: ['public'], creatorRole: names.owner, ...extra });
}
beforeAll(async () => {
  await pool.query('drop schema public cascade; create schema public; drop schema if exists drizzle cascade');
  await migrate(drizzle(pool), { migrationsFolder: path.resolve(process.cwd(), 'drizzle') });
  const db = drizzle(pool, { schema });
  const passwordHash = await bcrypt.hash('password123', 4);
  for (const name of ['admin', 'owner', 'reader', 'other']) {
    const [u] = await db.insert(schema.users).values({ name, email: `${name}@external.test`, role: name === 'admin' ? 'admin' : 'member', passwordHash }).returning();
    ids[name] = u.id;
  }
  await pool.query(`create role ${q(names.manager)} login createrole createdb password '${password}'; create role ${q(names.granter)} login createrole password '${password}'; create role ${q(names.weak)} login password '${password}'; create role ${q(names.owner)} login password '${password}'; create role ${q(names.readerGroup)} nologin; create role ${q(names.inherited)} login password '${password}'; grant ${q(names.readerGroup)} to ${q(names.inherited)}; grant pg_read_all_data to ${q(names.readerGroup)}; grant ${q(names.owner)} to ${q(names.manager)} with set true, inherit false`);
  await pool.query(`create database ${q(database)} owner ${q(names.owner)}`);
  const owner = await target(names.owner);
  try {
    await owner.query(`grant create on schema public to public; create table notes(id serial primary key, body text); insert into notes(body) values ('existing'); grant select on notes to public; grant update on notes to ${q(names.readerGroup)}; create table partial(visible text, hidden text); grant select (visible) on partial to public`);
  } finally { await owner.end(); }
  const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  for (const name of Object.keys(ids)) {
    const response = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: `${name}@external.test`, password: 'password123' } });
    tokens[name] = JSON.parse(response.body).token;
  }
  const result = await api('POST', '/api/db/instances', 'admin', { name: '工单07外部实例', engine: 'postgres', host: '127.0.0.1', port: 5433, adminUser: names.manager, adminPassword: password });
  expect(result.status).toBe(201);
  instanceId = result.body.id;
});
afterAll(async () => {
  await app?.close();
  // 失败响应也可能已持久化目录；仅清理本轮库对应的组角色。
  for (const row of (await pool.query('select id from db_catalog where db_name=$1', [database])).rows) catalogIds.add(row.id);
  await pool.query('select pg_terminate_backend(pid) from pg_stat_activity where datname=$1', [database]);
  await pool.query(`drop database if exists ${q(database)}`);
  for (const role of [...Object.values(ids).map(id => `eat-${id}`), ...[...catalogIds].flatMap(id => [`eat-db-${id}-read`, `eat-db-${id}-write`]), ...Object.values(names)]) await pool.query(`drop role if exists ${q(role)}`);
  await pool.end();
});

it('仅管理员能登记 PostgreSQL 外部库，登记显示来源、Owner 与有效 PUBLIC / 继承权限且不修改它们', async () => {
  const denied = await api('POST', `/api/db/instances/${instanceId}/access/catalog`, 'owner', { dbName: database, ownerId: ids.owner });
  expect(denied.status).toBe(403);
  const result = await register();
  expect(result.status, JSON.stringify(result.body)).toBe(201);
  expect(result.body).toMatchObject({ source: 'external', assignmentId: null, ownerId: ids.owner, ownerName: 'owner', instanceName: '工单07外部实例', state: 'active', open: false, creatorRole: names.owner });
  catalog = result.body;
  expect(catalog.publicCheck).toMatchObject({ connect: true, publicSchemaCreate: true });
  expect(catalog.publicCheck.tables).toContainEqual({ schema: 'public', table: 'notes', privileges: ['SELECT'] });
  expect(catalog.publicCheck.tables).toContainEqual({ schema: 'public', table: 'partial', privileges: ['SELECT (\"visible\")'] });
  expect(catalog.publicCheck.tighteningSql).toContain(`REVOKE SELECT (\"visible\") ON TABLE \"public\".\"partial\" FROM PUBLIC;`);
  expect(catalog.publicCheck.tighteningSql).toContain(`REVOKE \"pg_read_all_data\" FROM ${q(names.readerGroup)};`);
  expect(catalog.publicCheck.roles).toEqual(expect.arrayContaining([expect.objectContaining({ role: names.inherited, inheritedFrom: expect.arrayContaining([names.readerGroup, 'pg_read_all_data']), tables: expect.arrayContaining([expect.objectContaining({ table: 'notes', privileges: expect.arrayContaining(['UPDATE']) })]) })]));
  expect(catalog.publicCheck.tighteningSql.join('\n')).toContain(`REVOKE CONNECT ON DATABASE ${q(database)} FROM PUBLIC`);
  const owner = await target(names.owner);
  try { expect((await owner.query("select has_schema_privilege('public','CREATE') allowed")).rows[0].allowed).toBe(true); }
  finally { await owner.end(); }
  expect((await api('GET', '/api/db/access/catalog', 'other')).body.some((c: any) => c.id === catalog.id)).toBe(false);
  const opened = await api('POST', `/api/db/access/catalog/${catalog.id}/access`, 'owner', { open: true });
  expect(opened.body.state).toBe('active');
  expect((await api('GET', '/api/db/access/catalog', 'other')).body).toEqual(expect.arrayContaining([expect.objectContaining({ id: catalog.id, source: 'external', canManage: false })]));
  const outsider = await target(names.inherited);
  try { expect((await outsider.query('select body from notes')).rows).toEqual([{ body: 'existing' }]); await outsider.query('create table untouched_public(id int)'); }
  finally { await outsider.end(); }
});

it('MySQL 拒绝登记，普通管理角色缺建组或实际对象 owner 授权能力时明确失败并提供 DBA SQL', async () => {
  const weak = await api('POST', '/api/db/instances', 'admin', { name: '缺权限实例', engine: 'postgres', host: '127.0.0.1', port: 5433, adminUser: names.weak, adminPassword: password });
  const failed = await register(weak.body.id);
  expect(failed.status).toBe(400);
  expect(failed.body.message).toContain(`ALTER ROLE ${q(names.weak)} CREATEROLE;`);
  expect(failed.body.message).toContain(`GRANT ${q(names.owner)} TO ${q(names.weak)}`);
  expect((await api('GET', '/api/db/access/catalog')).body.some((c: any) => c.instanceId === weak.body.id)).toBe(false);
  const mysql = await api('POST', '/api/db/instances', 'admin', { name: 'MySQL', engine: 'mysql', host: '127.0.0.1', port: 3306, adminUser: names.manager, adminPassword: password });
  expect((await register(mysql.body.id)).status).toBe(400);
  expect((await register()).status).toBe(409);
  // 开放后另一个角色建了对象；重新应用必须检测这个实际 owner，不能吞掉 GRANT warning。
  const reapply = await api('POST', `/api/db/access/catalog/${catalog.id}/reapply`, 'owner');
  expect(reapply.body.state).toBe('failed');
  expect(reapply.body.error).toContain(`GRANT ${q(names.inherited)} TO ${q(names.manager)}`);
  await pool.query(`grant ${q(names.inherited)} to ${q(names.manager)} with set true, inherit false`);
  expect((await api('POST', `/api/db/access/catalog/${catalog.id}/reapply`, 'owner')).body.state).toBe('active');
});

it('外部 Owner 授予只读与读写，建表角色未来表自动授权，撤销会终止会话且不再可连接', async () => {
  // 收紧由测试中的 DBA 主动执行；EAT 从未执行报告里的 SQL。
  const owner = await target(names.owner);
  try {
    await owner.query(`grant connect on database ${q(database)} to ${q(names.manager)}; revoke connect on database ${q(database)} from public; revoke create on schema public from public; revoke select on notes from public`);
  } finally { await owner.end(); }
  const grant = await api('POST', `/api/db/access/catalog/${catalog.id}/grants`, 'owner', { userId: ids.reader, level: 'read' });
  expect(grant.body, JSON.stringify(grant.body)).toMatchObject({ state: 'active', level: 'read' });
  const credential = (await api('POST', `/api/db/access/catalog/${catalog.id}/credentials`, 'reader')).body;
  let c = new Client({ connectionString: credential.url });
  await c.connect();
  try {
    expect((await c.query('select body from notes')).rows[0].body).toBe('existing');
    await expect(c.query("insert into notes(body) values ('denied')")).rejects.toThrow(/permission denied/);
  } finally { await c.end(); }
  const upgraded = await api('POST', `/api/db/access/catalog/${catalog.id}/grants`, 'owner', { userId: ids.reader, level: 'write' });
  expect(upgraded.body).toMatchObject({ id: grant.body.id, state: 'active', level: 'write' });
  const creator = await target(names.owner);
  try { await creator.query('create table future(id serial primary key, body text); create view future_view as select * from future'); }
  finally { await creator.end(); }
  c = new Client({ connectionString: credential.url });
  await c.connect();
  c.on('error', () => undefined);
  try {
    await c.query("insert into future(body) values ('future')");
    expect((await c.query('select body from future_view')).rows).toEqual([{ body: 'future' }]);
    await expect(c.query('alter table future add column forbidden text')).rejects.toThrow(/must be owner|permission denied/);
    const disconnected = new Promise(resolve => c.once('error', resolve));
    const revoked = await api('POST', `/api/db/access/grants/${grant.body.id}/revoke`, 'owner', { reason: '外部数据查询完成' });
    expect(revoked.body, JSON.stringify(revoked.body)).toMatchObject({ state: 'revoked' });
    await disconnected;
    await expect(c.query('select 1')).rejects.toThrow();
    const reconnect = new Client({ connectionString: credential.url });
    try { await expect(reconnect.connect()).rejects.toThrow(/permission denied/); }
    finally { await reconnect.end(); }
  } finally { await c.end(); }
});

it('未填建表角色时支持持有 GRANT OPTION 的管理角色，未来表依赖重新应用授权', async () => {
  // 管理角色没有目标 owner 的 SET 成员关系，只有 DBA 明确授予的 GRANT OPTION。
  await pool.query(`grant connect on database ${q(database)} to ${q(names.granter)} with grant option`);
  const dba = await target('dev');
  try {
    await dba.query(`grant usage on schema public to ${q(names.granter)} with grant option; grant select, insert, update, delete on all tables in schema public to ${q(names.granter)} with grant option; grant usage, select on all sequences in schema public to ${q(names.granter)} with grant option; alter default privileges for role ${q(names.owner)} in schema public grant select, insert, update, delete on tables to ${q(names.granter)} with grant option; alter default privileges for role ${q(names.owner)} in schema public grant usage, select on sequences to ${q(names.granter)} with grant option`);
  } finally { await dba.end(); }
  const instance = await api('POST', '/api/db/instances', 'admin', { name: 'GRANT OPTION 实例', engine: 'postgres', host: '127.0.0.1', port: 5433, adminUser: names.granter, adminPassword: password });
  const registered = await register(instance.body.id, { creatorRole: undefined });
  expect(registered.status, JSON.stringify(registered.body)).toBe(201);
  expect(registered.body).toMatchObject({ creatorRole: null, state: 'active' });
  const id = registered.body.id;
  expect((await api('POST', `/api/db/access/catalog/${id}/grants`, 'owner', { userId: ids.other, level: 'read' })).body.state).toBe('active');
  const credential = (await api('POST', `/api/db/access/catalog/${id}/credentials`, 'other')).body;
  const creator = await target(names.owner);
  try { await creator.query("create table manual_reapply(body text); insert into manual_reapply values ('reapplied')"); }
  finally { await creator.end(); }
  const c = new Client({ connectionString: credential.url });
  await c.connect();
  try {
    await expect(c.query('select * from manual_reapply')).rejects.toThrow(/permission denied/);
    expect((await api('POST', `/api/db/access/catalog/${id}/reapply`, 'owner')).body.state).toBe('active');
    expect((await c.query('select body from manual_reapply')).rows).toEqual([{ body: 'reapplied' }]);
  } finally { await c.end(); }
});


it('外部库修改建表角色会移除旧默认授权，留空后重新应用仍能补上已有对象', async () => {
  const given = await api('POST', `/api/db/access/catalog/${catalog.id}/grants`, 'owner', { userId: ids.reader, level: 'read' });
  expect(given.body.state).toBe('active');
  expect((await api('POST', `/api/db/access/catalog/${catalog.id}/access`, 'other', { open: false })).status).toBe(403);
  const cleared = await api('POST', `/api/db/access/catalog/${catalog.id}/access`, 'owner', { open: false, creatorRole: null });
  expect(cleared.body, JSON.stringify(cleared.body)).toMatchObject({ state: 'active', creatorRole: null, open: false });
  const creator = await target(names.owner);
  try { await creator.query("create table after_clear(body text); insert into after_clear values ('manual')"); }
  finally { await creator.end(); }
  const credential = (await api('POST', `/api/db/access/catalog/${catalog.id}/credentials`, 'reader')).body;
  const c = new Client({ connectionString: credential.url });
  await c.connect();
  try {
    await expect(c.query('select * from after_clear')).rejects.toThrow(/permission denied/);
    expect((await api('POST', `/api/db/access/catalog/${catalog.id}/reapply`, 'owner')).body.state).toBe('active');
    expect((await c.query('select body from after_clear')).rows).toEqual([{ body: 'manual' }]);
  } finally { await c.end(); }
});
