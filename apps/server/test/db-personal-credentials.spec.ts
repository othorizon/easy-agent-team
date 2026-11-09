/** 工单05：HTTP + 普通管理角色 + SCRAM，包含密码轮换的跨数据库失败与重启恢复。 */
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://dev@127.0.0.1:5433/eat_test_05';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcryptjs';
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
const manager = `test05_mgr_${suffix}`;
const dbNames = [`test05_a_${suffix}`, `test05_b_${suffix}`];
const tokens: Record<string, string> = {};
const ids: Record<string, string> = {};
const allocations: any[] = [];
const catalogs: any[] = [];
let instanceId: string;
const q = (s: string) => `"${s.replaceAll('"', '""')}"`;
async function api(method: 'GET'|'POST', url: string, who = 'reader', payload?: unknown) {
  const res = await app.inject({ method, url, headers: { authorization: `Bearer ${tokens[who]}` }, payload: payload as never });
  return { status: res.statusCode, headers: res.headers, body: JSON.parse(res.body) };
}
async function connect(credentials: any) {
  const c = new Client({ connectionString: credentials.url });
  await c.connect();
  return c;
}
async function canConnect(credentials: any) {
  const c = await connect(credentials);
  try { expect((await c.query('select 1 as ok')).rows[0].ok).toBe(1); }
  finally { await c.end(); }
}
async function rejectsPassword(credentials: any) {
  const c = new Client({ connectionString: credentials.url });
  try { await expect(c.connect()).rejects.toThrow(/password authentication failed/); }
  finally { await c.end(); }
}
async function credentials(index = 0) { return (await api('POST', `/api/db/access/catalog/${catalogs[index].id}/credentials`)).body; }
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
  for (const name of ['admin', 'owner', 'reader', 'lazy', 'writer']) {
    const [u] = await db.insert(schema.users).values({ name, email: `${name}@test05.dev`, role: name === 'admin' ? 'admin' : 'member', passwordHash }).returning();
    ids[name] = u.id;
  }
  await pool.query(`create role ${q(manager)} login createrole createdb password '${managerPassword}'`);
  await boot();
  for (const name of Object.keys(ids)) {
    const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: `${name}@test05.dev`, password: 'password123' } });
    tokens[name] = JSON.parse(r.body).token;
  }
  const instance = await api('POST', '/api/db/instances', 'admin', { name: '工单05测试', engine: 'postgres', host: '127.0.0.1', port: 5433, adminUser: manager, adminPassword: managerPassword });
  expect(instance.status).toBe(201);
  instanceId = instance.body.id;
  for (const dbName of dbNames) {
    const created = await api('POST', '/api/db/assignments', 'owner', { instanceId, dbName, purpose: '个人凭证测试' });
    allocations.push(created.body);
    expect((await api('POST', `/api/db/assignments/${created.body.id}/approve`, 'admin')).body.status).toBe('active');
    const opened = await api('POST', `/api/db/assignments/${created.body.id}/access`, 'owner', { open: true });
    catalogs.push(opened.body);
    const given = await api('POST', `/api/db/access/catalog/${opened.body.id}/grants`, 'owner', { userId: ids.reader, level: 'read' });
    expect(given.body.state).toBe('active');
  }
});
afterAll(async () => {
  await app?.close();
  for (const dbName of dbNames) {
    await pool.query('select pg_terminate_backend(pid) from pg_stat_activity where datname=$1', [dbName]);
    await pool.query(`drop database if exists ${q(dbName)}`);
  }
  for (const name of [...dbNames.map(n => `u_${n}`), ...Object.values(ids).map(id => `eat-${id}`), ...catalogs.flatMap(c => [`eat-db-${c.id}-read`, `eat-db-${c.id}-write`])]) await pool.query(`drop role if exists ${q(name)}`);
  await pool.query(`drop role if exists ${q(manager)}`);
  await pool.end();
});

it('本人重置整个实例共用的个人密码：旧密码被SCRAM拒绝，新密码两库均可连，owner密码保持可用', async () => {
  const old = await credentials();
  const owner = (await api('POST', `/api/db/assignments/${allocations[0].id}/credentials`, 'owner')).body;
  await canConnect(old);
  const result = await api('POST', `/api/db/access/catalog/${catalogs[0].id}/reset-password`);
  expect(result.status).toBe(201);
  expect(result.headers['cache-control']).toBe('no-store');
  expect(result.body).toEqual({ instanceId, state: 'complete', error: null });
  const fresh = await credentials();
  expect(fresh.password).not.toBe(old.password);
  await rejectsPassword(old);
  await canConnect(fresh);
  const second = await credentials(1);
  expect(second.password).toBe(fresh.password);
  await canConnect(second);
  await canConnect(owner);
});

it('可管理他人授权不等于持有：mine范围不会返回他人授权，管理员和Owner不能替持有人重置', async () => {
  expect((await api('GET', '/api/db/access/grants', 'owner')).body.length).toBeGreaterThan(0);
  expect((await api('GET', '/api/db/access/grants?scope=mine', 'owner')).body).toEqual([]);
  expect((await api('GET', '/api/db/access/grants?scope=mine', 'admin')).body).toEqual([]);
  expect((await api('GET', '/api/db/access/grants?scope=unknown')).status).toBe(400);
  for (const who of ['owner', 'admin']) expect((await api('POST', `/api/db/access/catalog/${catalogs[0].id}/reset-password`, who)).status).toBe(403);
});

it('首次读取自动生成个人密码，目标端创建失败后重试仍能完成并真实登录', async () => {
  await drizzle(pool, { schema }).insert(schema.dbAccessGrants).values({ catalogId: catalogs[0].id, userId: ids.lazy, state: 'active', grantedBy: ids.owner });
  await pool.query(`alter role ${q(manager)} nologin`);
  try { expect((await api('POST', `/api/db/access/catalog/${catalogs[0].id}/credentials`, 'lazy')).status).toBeGreaterThanOrEqual(400); }
  finally { await pool.query(`alter role ${q(manager)} login`); }
  await app.close();
  await boot();
  const result = await api('POST', `/api/db/access/catalog/${catalogs[0].id}/credentials`, 'lazy');
  expect(result.status).toBe(201);
  expect(result.body.password).toBeTruthy();
  await canConnect(result.body);
});

it('目标ALTER失败保留可用旧密码，服务重启后完成持久化的待应用密码', async () => {
  const old = await credentials();
  await pool.query(`alter role ${q(manager)} nologin`);
  try {
    const result = await api('POST', `/api/db/access/catalog/${catalogs[0].id}/reset-password`);
    expect(result.body).toMatchObject({ instanceId, state: 'pending' });
    expect(result.body.error).toBeTruthy();
    await canConnect(old);
    expect((await api('POST', `/api/db/access/catalog/${catalogs[0].id}/credentials`)).status).toBe(409);
  } finally { await pool.query(`alter role ${q(manager)} login`); }
  await app.close();
  await boot();
  let fresh: any;
  await vi.waitFor(async () => { fresh = await credentials(); expect(fresh.password).toBeTruthy(); });
  expect(fresh.password).not.toBe(old.password);
  await rejectsPassword(old);
  await canConnect(fresh);
});

async function failPlatformWrite(stage: 'prepare' | 'complete') {
  await pool.query(`create function test05_fail_password() returns trigger language plpgsql as $$ begin
    if ${stage === 'prepare' ? 'new.pending_password_encrypted is not null and old.pending_password_encrypted is null' : 'new.password_encrypted is distinct from old.password_encrypted'} then
      raise exception 'test05 platform password ${stage} write unavailable';
    end if;
    return new;
  end $$`);
  await pool.query('create trigger test05_fail_password before update on db_personal_role for each row execute function test05_fail_password()');
}
async function restorePlatformWrite() {
  await pool.query('drop trigger if exists test05_fail_password on db_personal_role; drop function if exists test05_fail_password()');
}

it('准备写入失败不触碰目标密码；重启后仍返回原密码', async () => {
  const old = await credentials();
  await failPlatformWrite('prepare');
  try {
    expect((await api('POST', `/api/db/access/catalog/${catalogs[0].id}/reset-password`)).status).toBe(409);
    await canConnect(old);
  } finally { await restorePlatformWrite(); }
  await app.close();
  await boot();
  expect((await credentials()).password).toBe(old.password);
  await canConnect(old);
});

it('目标ALTER已提交但平台完成写入失败：不返回旧凭证，重启幂等恢复同一待应用密码', async () => {
  const old = await credentials();
  await failPlatformWrite('complete');
  try {
    const result = await api('POST', `/api/db/access/catalog/${catalogs[0].id}/reset-password`);
    expect(result.body).toMatchObject({ state: 'pending' });
    expect(result.body.error).toContain('platform password complete');
    await rejectsPassword(old);
    expect((await api('POST', `/api/db/access/catalog/${catalogs[0].id}/credentials`)).status).toBe(409);
  } finally { await restorePlatformWrite(); }
  await app.close();
  await boot();
  const fresh = await credentials();
  expect(fresh.password).not.toBe(old.password);
  await canConnect(fresh);
  await rejectsPassword(old);
  expect((await credentials(1)).password).toBe(fresh.password);
});

it('服务端沿用shared名字匹配，既有MCP仍只取owner分配凭证', async () => {
  const rpc = async (who: string, assignment: string) => {
    const response = await app.inject({ method: 'POST', url: '/mcp', headers: { authorization: `Bearer ${tokens[who]}` }, payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_db_credentials', arguments: { assignment } } } });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    return { failed: body.result.isError === true, value: JSON.parse(body.result.content[0].text) };
  };
  const personal = await rpc('reader', dbNames[0]);
  expect(personal.failed).toBe(true);
  expect(personal.value.error).toBe('DB_ASSIGNMENT_NOT_FOUND');
  const given = await api('POST', `/api/db/access/catalog/${catalogs[0].id}/grants`, 'owner', { userId: ids.owner, level: 'read' });
  expect(given.body.state).toBe('active');
  const owner = await rpc('owner', dbNames[0]);
  expect(owner.failed).toBe(false);
  expect(owner.value.assignmentId).toBe(allocations[0].id);
  expect(owner.value.user).toBe(`u_${dbNames[0]}`);
  const admin = await rpc('admin', dbNames[0]);
  expect(admin.failed).toBe(true);
  expect(admin.value.error).toBe('DB_ASSIGNMENT_NOT_FOUND');
});


it('首次读取读写授权自动创建个人角色时保留读写级别，反复读取不降级也不断开已有连接', async () => {
  const owner = await connect((await api('POST', `/api/db/assignments/${allocations[0].id}/credentials`, 'owner')).body);
  try { await owner.query('create table credential_writes(id int primary key)'); } finally { await owner.end(); }
  await drizzle(pool, { schema }).insert(schema.dbAccessGrants).values({ catalogId: catalogs[0].id, userId: ids.writer, level: 'write', state: 'active', grantedBy: ids.owner });
  const first = await api('POST', `/api/db/access/catalog/${catalogs[0].id}/credentials`, 'writer');
  expect(first.status).toBe(201);
  const connection = await connect(first.body);
  connection.on('error', () => undefined);
  try {
    await connection.query('insert into credential_writes values (1)');
    const again = await api('POST', `/api/db/access/catalog/${catalogs[0].id}/credentials`, 'writer');
    expect(again.body.password).toBe(first.body.password);
    await connection.query('update credential_writes set id=2 where id=1');
    expect((await connection.query('select id from credential_writes')).rows).toEqual([{ id: 2 }]);
  } finally { await connection.end(); }
});
