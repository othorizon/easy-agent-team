/** 工单06：完整 HTTP 接口 + 真实 PostgreSQL，管理账号刻意不是超级用户。 */
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://dev@127.0.0.1:5433/eat_test_06';
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
import { RequestNotifications } from '../src/requests/requests.notifications';
import { createRequestActionToken } from '../src/requests/request-action-link';
import { AppModule } from '../src/app.module';
import * as schema from '../src/db/schema';

let app: NestFastifyApplication;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const managerPassword = randomUUID();
const manager = `test_mgr_${suffix}`;
const dbNames = [`test_a_${suffix}`, `test_b_${suffix}`];
const externalDbName = `test_ext_${suffix}`;
const tokens: Record<string, string> = {};
const ids: Record<string, string> = {};
const allocations: any[] = [];
const catalogs: any[] = [];
const createdCatalogIds = new Set<string>();
let instanceId: string;
const q = (s: string) => `"${s.replaceAll('"', '""')}"`;
async function api(method: 'GET'|'POST'|'DELETE'|'PATCH', url: string, who = 'owner', payload?: unknown) {
  const res = await app.inject({ method, url, headers: { authorization: `Bearer ${tokens[who]}` }, payload: payload as never });
  const body = JSON.parse(res.body);
  if (['eat', 'external'].includes(body?.source) && body.id) createdCatalogIds.add(body.id);
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
  for (const name of ['admin', 'owner', 'reader', 'other', 'failed', 'concurrent']) {
    const [u] = await db.insert(schema.users).values({ name, email: `${name}@test.dev`, role: name === 'admin' ? 'admin' : 'member', passwordHash }).returning();
    ids[name] = u.id;
  }
  await db.insert(schema.userNotifications).values({ userId: ids.reader, webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/db-access-test', verifiedAt: new Date() });
  await pool.query(`create role ${q(manager)} login createrole createdb password '${managerPassword}'`);
  await pool.query(`create database ${q(externalDbName)} owner ${q(manager)}`);
  const external = new Client({ host: '127.0.0.1', port: 5433, user: manager, password: managerPassword, database: externalDbName });
  await external.connect();
  try { await external.query('create table external_notes(body text); insert into external_notes values ($$external$$)'); }
  finally { await external.end(); }
  await boot();
  for (const name of Object.keys(ids)) {
    const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: `${name}@test.dev`, password: 'password123' } });
    tokens[name] = JSON.parse(r.body).token;
  }
  const instance = await api('POST', '/api/db/instances', 'admin', { name: '工单06测试', engine: 'postgres', host: '127.0.0.1', port: 5433, adminUser: manager, adminPassword: managerPassword });
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
  for (const dbName of [...dbNames, externalDbName]) {
    await pool.query('select pg_terminate_backend(pid) from pg_stat_activity where datname=$1', [dbName]);
    await pool.query(`drop database if exists ${q(dbName)}`);
  }
  for (const name of [...dbNames.map(n => `u_${n}`), ...Object.values(ids).map(id => `eat-${id}`), ...[...createdCatalogIds].flatMap(id => [`eat-db-${id}-read`, `eat-db-${id}-write`])]) {
    await pool.query(`drop role if exists ${q(name)}`);
  }
  await pool.query(`drop role if exists ${q(manager)}`);
  await pool.end();
});


it('成员申请只读，Owner 审批后统一申请中心和个人授权同时生效', async () => {
  const opened = await api('POST', `/api/db/assignments/${allocations[0].id}/access`, 'owner', { open: true });
  catalogs.push(opened.body);
  const submitted = await api('POST', `/api/db/access/catalog/${opened.body.id}/requests`, 'reader', { level: 'read', reason: '统计报表' });
  expect(submitted.status, JSON.stringify(submitted.body)).toBe(201);
  expect(submitted.body.requestId).toBeTruthy();
  const id = submitted.body.requestId;
  const pending = await api('GET', `/api/requests/${id}`, 'owner');
  expect(pending.body.request).toMatchObject({ type: 'db-access', status: 'pending', canApprove: true, reason: '统计报表', details: { level: 'read', dbName: dbNames[0] } });
  expect((await api('GET', '/api/requests?scope=inbox&type=db-access', 'other')).body.items).toHaveLength(0);
  const result = await api('POST', `/api/requests/${id}/decision`, 'owner', { decision: 'approved' });
  expect(result.body.request, JSON.stringify(result.body)).toMatchObject({ status: 'approved', execution: 'active' });
  const credential = await api('POST', `/api/db/access/catalog/${opened.body.id}/credentials`, 'reader');
  const c = await connect(credential.body);
  try { expect((await c.query('select body from notes')).rows).toEqual([{ body: 'hello' }]); }
  finally { await c.end(); }
});

it('只读申请升级保留旧权限；重复待办冲突，批准后升级同一授权，降级申请拒绝', async () => {
  const c = catalogs[0];
  const grant = (await api('GET', '/api/db/access/grants?scope=mine', 'reader')).body[0];
  const submitted = await api('POST', `/api/db/access/catalog/${c.id}/requests`, 'reader', { level: 'write', reason: '维护报表数据' });
  const id = submitted.body.requestId;
  expect(submitted.status).toBe(201);
  const duplicate = await api('POST', `/api/db/access/catalog/${c.id}/requests`, 'reader', { level: 'write', reason: '重复' });
  expect(duplicate.status).toBe(409);
  expect(duplicate.body.message).toContain('撤回');
  expect((await api('GET', '/api/db/access/grants?scope=mine', 'reader')).body[0]).toMatchObject({ id: grant.id, level: 'read', state: 'active' });
  const credentials = (await api('POST', `/api/db/access/catalog/${c.id}/credentials`, 'reader')).body;
  const pg = await connect(credentials);
  try { await expect(pg.query('insert into notes(body) values ($$upgrade pending$$)')).rejects.toThrow(/permission denied/); }
  finally { await pg.end(); }
  expect((await api('POST', `/api/requests/${id}/decision`, 'other', { decision: 'approved' })).status).toBe(404);
  const approved = await api('POST', `/api/requests/${id}/decision`, 'owner', { decision: 'approved' });
  expect(approved.body.request).toMatchObject({ status: 'approved', execution: 'active' });
  expect((await api('GET', '/api/db/access/grants?scope=mine', 'reader')).body[0]).toMatchObject({ id: grant.id, level: 'write', state: 'active' });
  const writable = await connect(credentials);
  try { expect((await writable.query('insert into notes(body) values ($$upgraded$$)')).rowCount).toBe(1); }
  finally { await writable.end(); }
  const downgrade = await api('POST', `/api/db/access/catalog/${c.id}/requests`, 'reader', { level: 'read', reason: '降级' });
  expect(downgrade.status).toBe(409);
  expect(downgrade.body.message).toContain('降级');
});

it('驳回、重新提交与撤回保留历史轮次，关闭后新申请拒绝但待审批可批准', async () => {
  const c = catalogs[0];
  const first = (await api('POST', `/api/db/access/catalog/${c.id}/requests`, 'other', { level: 'read', reason: '第一次申请' })).body.requestId;
  const rejected = await api('POST', `/api/requests/${first}/decision`, 'owner', { decision: 'rejected', reason: '请说明用途' });
  expect(rejected.body.request).toMatchObject({ status: 'rejected', rejectionReason: '请说明用途' });
  const second = await api('POST', `/api/requests/${first}/resubmit`, 'other', { reason: '每日统计' });
  expect(second.body.request).toMatchObject({ status: 'pending', round: 2, reason: '每日统计' });
  const id = second.body.request.id;
  expect((await api('POST', `/api/requests/${id}/withdraw`, 'other')).body.request.status).toBe('withdrawn');
  const third = await api('POST', `/api/requests/${id}/resubmit`, 'other', { reason: '每日统计确认' });
  expect(third.body.request).toMatchObject({ round: 3, status: 'pending' });
  await api('POST', `/api/db/assignments/${allocations[0].id}/access`, 'owner', { open: false });
  expect((await api('POST', `/api/db/access/catalog/${c.id}/requests`, 'failed', { level: 'read', reason: '已关闭' })).status).toBe(409);
  const approved = await api('POST', `/api/requests/${third.body.request.id}/decision`, 'owner', { decision: 'approved' });
  expect(approved.body.request).toMatchObject({ status: 'approved', execution: 'active' });
  expect((await api('GET', '/api/db/access/grants?scope=mine', 'reader')).body[0]).toMatchObject({ level: 'write', state: 'active' });
  await api('POST', `/api/db/assignments/${allocations[0].id}/access`, 'owner', { open: true });
});

it('Owner 和管理员自己申请直接授权并审计，不产生审批自己的待办', async () => {
  for (const who of ['owner', 'admin']) {
    const result = await api('POST', `/api/db/access/catalog/${catalogs[0].id}/requests`, who, { level: 'read', reason: '自己查询' });
    expect(result.body, JSON.stringify(result.body)).toMatchObject({ requestId: null, grant: { userId: ids[who], state: 'active' } });
    const mine = await api('GET', '/api/requests?scope=mine&type=db-access', who);
    expect(mine.body.items).toHaveLength(0);
  }
  const audit = await api('GET', '/api/audit?action=db_access.self_granted', 'admin');
  expect(audit.body).toEqual(expect.arrayContaining(['owner', 'admin'].map(who => expect.objectContaining({ actorId: ids[who], action: 'db_access.self_granted', meta: { level: 'read', reason: '自己查询' } }))));
});

it('批准后目标数据库失败保留已批准、执行失败；同一grant重试成功不增加审批轮次', async () => {
  const c = catalogs[0];
  const id = (await api('POST', `/api/db/access/catalog/${c.id}/requests`, 'failed', { level: 'read', reason: '故障恢复测试' })).body.requestId;
  await pool.query(`alter role ${q(manager)} password 'intentionally_wrong_for_ticket06'`);
  let grant: any;
  try {
    const result = await api('POST', `/api/requests/${id}/decision`, 'owner', { decision: 'approved' });
    expect(result.body.request, JSON.stringify(result.body)).toMatchObject({ status: 'approved', execution: 'failed', round: 1 });
    expect(result.body.request.executionError).toContain('password authentication failed');
    grant = (await api('GET', '/api/db/access/grants?scope=mine', 'failed')).body[0];
    expect(grant).toMatchObject({ state: 'failed', level: 'read' });
    expect((await api('POST', `/api/requests/${id}/resubmit`, 'failed', { reason: '错误重提' })).status).toBe(409);
  } finally { await pool.query(`alter role ${q(manager)} password '${managerPassword}'`); }
  const retried = await api('POST', `/api/db/access/grants/${grant.id}/retry`, 'owner');
  expect(retried.body, JSON.stringify(retried.body)).toMatchObject({ id: grant.id, state: 'active' });
  const current = await api('GET', `/api/requests/${id}`, 'failed');
  expect(current.body.request).toMatchObject({ id, status: 'approved', execution: 'active', round: 1, executionError: null });
  expect(current.body.rounds).toHaveLength(1);
});

it('审批通知展示库、实例、级别和用途，飞书快捷同意走相同授权执行路径', async () => {
  const opened = await api('POST', `/api/db/assignments/${allocations[1].id}/access`, 'owner', { open: true });
  catalogs.push(opened.body);
  await pool.query(`INSERT INTO user_notification(user_id,webhook_url,verified_at) VALUES($1,'https://open.feishu.cn/open-apis/bot/v2/hook/owner-ticket06',now())`, [ids.owner]);
  const cards: any[] = [];
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    cards.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ code: 0 }), { status: 200 });
  });
  const id = (await api('POST', `/api/db/access/catalog/${opened.body.id}/requests`, 'other', { level: 'write', reason: '卡片统计用途' })).body.requestId;
  try {
    await app.get(RequestNotifications).tick();
    const card = cards.find(card => JSON.stringify(card).includes('卡片统计用途'));
    expect(card).toBeTruthy();
    const text = JSON.stringify(card);
    for (const expected of [dbNames[1], '工单06测试', '读写', '卡片统计用途']) expect(text).toContain(expected);
    const approved = await api('POST', `/api/requests/${id}/notification-approve`, 'owner', { token: createRequestActionToken(id, ids.owner) });
    expect(approved.body.request, JSON.stringify(approved.body)).toMatchObject({ status: 'approved', execution: 'active' });
    const grant = (await api('GET', '/api/db/access/grants?scope=mine', 'other')).body.find((g: any) => g.catalogId === opened.body.id);
    expect(grant).toMatchObject({ level: 'write', state: 'active' });
  } finally { spy.mockRestore(); }
});

it('Owner 停用时详情明确提示、待办转给管理员，资源关闭仍可审批', async () => {
  const id = (await api('POST', `/api/db/access/catalog/${catalogs[1].id}/requests`, 'reader', { level: 'read', reason: 'Owner离职后的审批' })).body.requestId;
  expect((await api('PATCH', `/api/users/${ids.owner}`, 'admin', { status: 'disabled' })).status).toBe(200);
  try {
    const detail = await api('GET', `/api/requests/${id}`, 'admin');
    expect(detail.body.request).toMatchObject({ canApprove: true, details: { ownerNotice: 'Owner 已停用，由管理员审批' } });
    expect((await api('GET', '/api/requests?scope=inbox&type=db-access', 'admin')).body.items.some((r: any) => r.id === id)).toBe(true);
    expect((await api('POST', `/api/requests/${id}/decision`, 'admin', { decision: 'approved' })).body.request.execution).toBe('active');
  } finally {
    await api('PATCH', `/api/users/${ids.owner}`, 'admin', { status: 'active' });
    tokens.owner = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'owner@test.dev', password: 'password123' } })).json().token;
  }
});

it('申请人停用或库删除会令待审批失效，删除后不能再提交', async () => {
  const id = (await api('POST', `/api/db/access/catalog/${catalogs[1].id}/requests`, 'failed', { level: 'read', reason: '用户将停用' })).body.requestId;
  await api('PATCH', `/api/users/${ids.failed}`, 'admin', { status: 'disabled' });
  const invalid = await api('GET', `/api/requests/${id}`, 'admin');
  expect(invalid.body.request).toMatchObject({ status: 'invalid', closedReason: '申请人已停用或删除' });
  await api('PATCH', `/api/users/${ids.failed}`, 'admin', { status: 'active' });
  tokens.failed = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'failed@test.dev', password: 'password123' } })).json().token;
  const pending = await api('POST', `/api/db/access/catalog/${catalogs[1].id}/requests`, 'failed', { level: 'read', reason: '资源将删除' });
  expect(pending.status).toBe(201);
  expect((await api('DELETE', `/api/db/assignments/${allocations[1].id}`, 'admin')).status).toBe(200);
  const deleted = await api('GET', `/api/requests/${pending.body.requestId}`, 'admin');
  expect(deleted.body.request).toMatchObject({ status: 'invalid', closedReason: '数据库已删除' });
  expect((await api('POST', `/api/db/access/catalog/${catalogs[1].id}/requests`, 'failed', { level: 'read', reason: '已经删除' })).status).toBe(409);
});


it('并发同库同人提交只产生一条待审批，非法入参拒绝', async () => {
  const path = `/api/db/access/catalog/${catalogs[0].id}/requests`;
  const attempts = await Promise.all([api('POST', path, 'concurrent', { level: 'read', reason: '并发一' }), api('POST', path, 'concurrent', { level: 'write', reason: '并发二' })]);
  expect(attempts.map(r => r.status).sort()).toEqual([201, 409]);
  const mine = await api('GET', '/api/requests?scope=mine&type=db-access', 'concurrent');
  expect(mine.body.items).toHaveLength(1);
  expect(mine.body.items[0].status).toBe('pending');
  expect((await api('POST', path, 'concurrent', { level: 'owner', reason: '无效' })).status).toBe(400);
  expect((await api('POST', path, 'concurrent', { level: 'read', reason: ' ' })).status).toBe(400);
  expect((await api('POST', '/api/db/access/catalog/not-a-uuid/requests', 'concurrent', { level: 'read', reason: '无效' })).status).toBe(400);
});

it('外部库按catalog Owner审批，不依赖分配记录，关闭后的原待办仍可执行', async () => {
  const registered = await api('POST', `/api/db/instances/${instanceId}/access/catalog`, 'admin', { dbName: externalDbName, ownerId: ids.owner, creatorRole: manager });
  expect(registered.body, JSON.stringify(registered.body)).toMatchObject({ source: 'external', assignmentId: null, state: 'active' });
  const catalogId = registered.body.id;
  await api('POST', `/api/db/access/catalog/${catalogId}/access`, 'owner', { open: true });
  const submitted = await api('POST', `/api/db/access/catalog/${catalogId}/requests`, 'reader', { level: 'read', reason: '外部数据统计' });
  expect(submitted.status, JSON.stringify(submitted.body)).toBe(201);
  await api('POST', `/api/db/access/catalog/${catalogId}/access`, 'owner', { open: false });
  const approved = await api('POST', `/api/requests/${submitted.body.requestId}/decision`, 'owner', { decision: 'approved' });
  expect(approved.body.request, JSON.stringify(approved.body)).toMatchObject({ status: 'approved', execution: 'active' });
  const credentials = (await api('POST', `/api/db/access/catalog/${catalogId}/credentials`, 'reader')).body;
  const pg = await connect(credentials);
  try { expect((await pg.query('select body from external_notes')).rows).toEqual([{ body: 'external' }]); }
  finally { await pg.end(); }
});

it('授权已完成但申请执行快照未落盘的中断，重启后自动恢复正确执行状态', async () => {
  // 模拟目标PG已成功、grant已持久化，但快照写入前进程退出的恢复输入。
  await pool.query(`UPDATE approval_request SET execution='provisioning' WHERE type='db-access' AND resource_id=$1 AND requester_id=$2 AND latest`, [catalogs[0].id, ids.reader]);
  await app.close();
  await boot();
  let current: any;
  for (let i=0; i<50; i++) {
    const mine = await api('GET', '/api/requests?scope=mine&type=db-access', 'reader');
    current = mine.body.items.find((r: any) => r.resourceId === catalogs[0].id);
    if (current.execution === 'active') break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  expect(current).toMatchObject({ status: 'approved', execution: 'active', round: 2 });
});

it('申请人后来成为管理员，重新提交旧撤回申请直接执行且不生成待审批自己的记录', async () => {
  const first = (await api('GET', '/api/requests?scope=mine&type=db-access', 'concurrent')).body.items[0];
  await api('POST', `/api/requests/${first.id}/withdraw`, 'concurrent');
  await api('PATCH', `/api/users/${ids.concurrent}`, 'admin', { role: 'admin' });
  tokens.concurrent = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'concurrent@test.dev', password: 'password123' } })).json().token;
  const result = await api('POST', `/api/requests/${first.id}/resubmit`, 'concurrent', { reason: '成为管理员后自行使用' });
  expect(result.body.request, JSON.stringify(result.body)).toMatchObject({ round: 2, status: 'approved', execution: 'active', canApprove: false });
  const mine = await api('GET', '/api/requests?scope=mine&type=db-access', 'concurrent');
  expect(mine.body.items.some((r: any) => r.status === 'pending')).toBe(false);
});
