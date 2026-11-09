/** 工单08：HTTP + PostgreSQL16普通管理角色；只操作本轮UUID资源。 */
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://dev@127.0.0.1:5433/eat_test_08';
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
const suffix = randomUUID().replaceAll('-', '').slice(0, 10), password = randomUUID();
const q = (s: string) => `"${s.replaceAll('"', '""')}"`;
const manager = `clean_mgr_${suffix}`, owner = `clean_owner_${suffix}`, outsider = `clean_other_${suffix}`, database = `clean_data_${suffix}`;
const tokens: Record<string, string> = {}, ids: Record<string, string> = {};
const catalogIds = new Set<string>(), databases = new Set([database]), ownerRoles = new Set([owner]);
let app: NestFastifyApplication, instanceId: string, catalog: any, grant: any;
async function api(method: 'GET' | 'POST' | 'DELETE' | 'PATCH', url: string, who = 'admin', payload?: unknown) {
  const r = await app.inject({ method, url, headers: { authorization: `Bearer ${tokens[who]}` }, payload: payload as never });
  const body = JSON.parse(r.body);
  if (body.source === 'external' && body.id) catalogIds.add(body.id);
  return { status: r.statusCode, body };
}
async function target(user = owner, db = database) { const c = new Client({ host: '127.0.0.1', port: 5433, database: db, user, password }); await c.connect(); return c; }
beforeAll(async () => {
  await pool.query('drop schema public cascade; create schema public; drop schema if exists drizzle cascade');
  await migrate(drizzle(pool), { migrationsFolder: path.resolve(process.cwd(), 'drizzle') });
  const db = drizzle(pool, { schema }), passwordHash = await bcrypt.hash('password123', 4);
  for (const name of ['admin', 'owner', 'reader', 'other']) {
    const [u] = await db.insert(schema.users).values({ name, email: `${name}@cleanup.test`, role: name === 'admin' ? 'admin' : 'member', passwordHash }).returning(); ids[name] = u.id;
  }
  await pool.query(`create role ${q(manager)} login createrole createdb password '${password}'; create role ${q(owner)} login password '${password}'; create role ${q(outsider)} login password '${password}'; grant ${q(owner)} to ${q(manager)} with set true, inherit false`);
  await pool.query(`create database ${q(database)} owner ${q(owner)}`);
  const c = await target(); try { await c.query("create table preserved(id serial primary key, body text); insert into preserved(body) values ('preserved')"); } finally { await c.end(); }
  const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter()); await app.init(); await app.getHttpAdapter().getInstance().ready();
  for (const name of Object.keys(ids)) { const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: `${name}@cleanup.test`, password: 'password123' } }); tokens[name] = JSON.parse(r.body).token; }
  instanceId = (await api('POST', '/api/db/instances', 'admin', { name: '08普通管理实例', engine: 'postgres', host: '127.0.0.1', port: 5433, adminUser: manager, adminPassword: password })).body.id;
  const r = await api('POST', `/api/db/instances/${instanceId}/access/catalog`, 'admin', { dbName: database, ownerId: ids.owner, creatorRole: owner });
  expect(r.status, JSON.stringify(r.body)).toBe(201); catalog = r.body;
  grant = (await api('POST', `/api/db/access/catalog/${catalog.id}/grants`, 'owner', { userId: ids.reader, level: 'read' })).body; expect(grant.state).toBe('active');
});
afterAll(async () => {
  await app?.close();
  for (const db of databases) { await pool.query('select pg_terminate_backend(pid) from pg_stat_activity where datname=$1', [db]); await pool.query(`drop database if exists ${q(db)}`); }
  for (const role of [...Object.values(ids).map(id => `eat-${id}`), ...[...catalogIds].flatMap(id => [`eat-db-${id}-read`, `eat-db-${id}-write`]), ...ownerRoles, manager, outsider]) await pool.query(`drop role if exists ${q(role)}`);
  await pool.end();
});
it('未撤销授权阻止删除外部登记与实例；即使授权执行失败也必须先撤销', async () => {
  expect((await api('DELETE', `/api/db/access/catalog/${catalog.id}`)).status).toBe(409);
  expect((await api('DELETE', `/api/db/instances/${instanceId}`)).status).toBe(409);
  await pool.query("update db_access_grant set state='failed' where id=$1", [grant.id]);
  expect((await api('DELETE', `/api/db/access/catalog/${catalog.id}`)).status).toBe(409);
  expect((await api('POST', `/api/db/access/grants/${grant.id}/revoke`, 'owner', { reason: '完成查询' })).body.state).toBe('revoked');
});
it('删除前检查全部组的所有权：报告具体角色与对象，保持数据与权限，排除对象后可重试只删除两组', async () => {
  const group = `eat-db-${catalog.id}-write`;
  const read=`eat-db-${catalog.id}-read`;
  await pool.query(`comment on role ${q(read)} is 'foreign marker'`);
  const unknown=await api('DELETE',`/api/db/access/catalog/${catalog.id}`);
  expect(unknown.status).toBe(409); expect(unknown.body.message).toContain('来源不明');
  expect((await pool.query('select 1 from pg_roles where rolname=$1',[read])).rowCount).toBe(1);
  await pool.query(`comment on role ${q(read)} is 'eat:db-catalog:${catalog.id}:read'`);
  const c = await target('dev');
  try { await c.query(`create table owned_by_group(body text); insert into owned_by_group values ('do not drop'); alter table owned_by_group owner to ${q(group)}`); } finally { await c.end(); }
  const failed = await api('DELETE', `/api/db/access/catalog/${catalog.id}`);
  expect(failed.status, JSON.stringify(failed.body)).toBe(409);
  expect(failed.body.message).toContain(group); expect(failed.body.message).toContain('owned_by_group');
  expect((await api('GET','/api/db/access/catalog')).body.find((r:any)=>r.id===catalog.id)).toMatchObject({ state:'active',error:null });
  const dba = await target('dev');
  try {
    expect((await dba.query('select * from owned_by_group')).rows).toEqual([{ body: 'do not drop' }]);
    expect((await dba.query("select has_table_privilege($1,'preserved','SELECT') ok", [`eat-db-${catalog.id}-read`])).rows[0].ok).toBe(true);
    await dba.query(`alter table owned_by_group owner to ${q(owner)}`);
  } finally { await dba.end(); }
  const removed = await api('DELETE', `/api/db/access/catalog/${catalog.id}`);
  expect(removed.status, JSON.stringify(removed.body)).toBe(200);
  expect((await pool.query('select rolname from pg_roles where rolname=any($1::text[])', [[`eat-db-${catalog.id}-read`,group]])).rows).toEqual([]);
  expect((await pool.query('select 1 from pg_roles where rolname=$1', [`eat-${ids.reader}`])).rowCount).toBe(1);
  const stillOwner = await target(); try { expect((await stillOwner.query('select body from preserved')).rows).toEqual([{ body: 'preserved' }]); await stillOwner.query('create table owner_future(body text)'); } finally { await stillOwner.end(); }
  expect((await api('GET','/api/db/access/catalog')).body.some((r: any) => r.id === catalog.id)).toBe(false);
});
it('管理员只读核对缺失/额外/非EAT成员，不自动覆盖；显式修复保持无关关系并恢复授权，撤销前核对实际状态', async () => {
  catalog = (await api('POST', `/api/db/instances/${instanceId}/access/catalog`, 'admin', { dbName: database, ownerId: ids.owner, creatorRole: owner })).body;
  grant = (await api('POST', `/api/db/access/catalog/${catalog.id}/grants`, 'owner', { userId: ids.reader, level: 'read' })).body;
  const read = `eat-db-${catalog.id}-read`, write = `eat-db-${catalog.id}-write`, personal = `eat-${ids.reader}`;
  const manual = await target(manager,'postgres');
  try { await manual.query(`revoke ${q(read)} from ${q(personal)}; grant ${q(write)} to ${q(personal)},${q(outsider)}`); } finally { await manual.end(); }
  await pool.query(`grant ${q(owner)} to ${q(outsider)}`);
  const listed = (await api('GET','/api/db/access/catalog')).body.find((r: any) => r.id === catalog.id);
  expect(listed.drift).toMatchObject({ consistent: false, error: null, members: expect.arrayContaining([expect.objectContaining({ role: personal, missing: [read], extra: [write] }),expect.objectContaining({ role: outsider, expected: [], actual: [write] })]) });
  expect((await pool.query('select pg_has_role($1,$2,\'MEMBER\') ok',[personal,write])).rows[0].ok).toBe(true);
  expect((await api('POST',`/api/db/access/catalog/${catalog.id}/repair`,'owner')).status).toBe(403);
  const repaired = await api('POST',`/api/db/access/catalog/${catalog.id}/repair`);
  expect(repaired.status,JSON.stringify(repaired.body)).toBe(201); expect(repaired.body.consistent).toBe(true);
  expect((await pool.query('select pg_has_role($1,$2,\'MEMBER\') ok',[outsider,write])).rows[0].ok).toBe(false);
  expect((await pool.query('select pg_has_role($1,$2,\'MEMBER\') ok',[outsider,owner])).rows[0].ok).toBe(true);
  const credential = (await api('POST',`/api/db/access/catalog/${catalog.id}/credentials`,'reader')).body;
  const c = new Client({ connectionString: credential.url }); await c.connect();
  try { expect((await c.query('select body from preserved')).rows).toEqual([{ body:'preserved' }]); await expect(c.query("insert into preserved(body) values ('blocked')")).rejects.toThrow(/permission denied/); } finally { await c.end(); }
  const manual2 = await target(manager,'postgres'); try { await manual2.query(`grant ${q(write)} to ${q(personal)}`); } finally { await manual2.end(); }
  expect((await api('POST',`/api/db/access/grants/${grant.id}/revoke`,'owner',{})).body.state).toBe('revoked');
  const manual3 = await target(manager,'postgres'); try { await manual3.query(`grant ${q(read)} to ${q(personal)}`); } finally { await manual3.end(); }
  expect((await api('GET','/api/db/access/catalog')).body.find((r: any)=>r.id===catalog.id).drift.consistent).toBe(false);
  expect((await api('POST',`/api/db/access/catalog/${catalog.id}/repair`)).body.consistent).toBe(true);
  const audit = await pool.query('select action from audit_log where action in (\'db_access.repaired\',\'db_access.revoke_checked\')');
  expect(audit.rows).toEqual(expect.arrayContaining([{ action:'db_access.repaired' },{ action:'db_access.revoke_checked' }]));
});
it('其他grantor的成员关系不能越权修复或假装撤净，给出DBA精确SQL并保留撤销中状态', async () => {
  grant = (await api('POST', `/api/db/access/catalog/${catalog.id}/grants`, 'owner', { userId: ids.reader, level: 'read' })).body;
  const write=`eat-db-${catalog.id}-write`, personal=`eat-${ids.reader}`;
  await pool.query(`grant ${q(write)} to ${q(personal)}`);
  const repair=await api('POST',`/api/db/access/catalog/${catalog.id}/repair`);
  expect(repair.status).toBe(409); expect(repair.body.message).toContain(`granted by "dev"`);
  const revoke=await api('POST',`/api/db/access/grants/${grant.id}/revoke`,'owner',{});
  expect(revoke.body).toMatchObject({ state:'revoking' }); expect(revoke.body.error).toContain('granted by "dev"');
  expect((await api('DELETE',`/api/db/instances/${instanceId}`)).status).toBe(409);
  await pool.query(`revoke ${q(write)} from ${q(personal)} granted by "dev"`);
  expect((await api('POST',`/api/db/access/grants/${grant.id}/retry`,'owner')).body.state).toBe('revoked');
});
it('远端清理后平台删除失败会保留清楚状态并禁止复活，重试可处理已不存在的角色', async () => {
  expect((await api('POST',`/api/db/access/catalog/${catalog.id}/access`,'owner',{ open:true })).body.open).toBe(true);
  const pending=(await api('POST',`/api/db/access/catalog/${catalog.id}/requests`,'other',{ level:'read',reason:'外部登记删除失效' })).body;
  expect(pending.requestId).toBeTruthy();
  await pool.query(`create function block_cleanup_08() returns trigger language plpgsql as $$ begin raise exception '08 injected local deletion failure'; end $$; create trigger block_cleanup_08 before delete on db_catalog for each row execute function block_cleanup_08()`);
  try {
    const failed=await api('DELETE',`/api/db/access/catalog/${catalog.id}`);
    expect(failed.status,JSON.stringify(failed.body)).toBe(409); expect(failed.body.message).toContain('平台记录保留');
    const listed=(await api('GET','/api/db/access/catalog')).body.find((r:any)=>r.id===catalog.id);
    expect(listed).toMatchObject({ state:'failed',open:false }); expect(listed.error).toContain('删除未完成');
    expect((await pool.query('select rolname from pg_roles where rolname=any($1::text[])',[[`eat-db-${catalog.id}-read`,`eat-db-${catalog.id}-write`]])).rows).toEqual([]);
    expect((await api('POST',`/api/db/access/catalog/${catalog.id}/grants`,'owner',{ userId:ids.reader,level:'read' })).status).toBe(409);
    expect((await api('POST',`/api/db/access/catalog/${catalog.id}/reapply`,'owner')).status).toBe(409);
  } finally { await pool.query('drop trigger block_cleanup_08 on db_catalog; drop function block_cleanup_08()'); }
  expect((await api('DELETE',`/api/db/access/catalog/${catalog.id}`)).status).toBe(200);
  expect((await api('GET',`/api/requests/${pending.requestId}`)).body.request).toMatchObject({ status:'invalid',closedReason:'数据库已删除' });
  catalog=(await api('POST',`/api/db/instances/${instanceId}/access/catalog`,'admin',{ dbName:database,ownerId:ids.owner,creatorRole:owner })).body;
  expect(catalog.state).toBe('active');
});
it('实例删除预检所有个人角色且不改权限；重试仅清本轮角色，owner账号、数据库数据和服务连接保留', async () => {
  const dbName=`clean_alloc_${suffix}`;
  const requested=await api('POST','/api/db/assignments','owner',{ instanceId,dbName,purpose:'08保留owner应用' });
  expect(requested.status,JSON.stringify(requested.body)).toBe(201);
  const assignmentId=requested.body.id;
  const approved=await api('POST',`/api/db/assignments/${assignmentId}/approve`);
  expect(approved.body,JSON.stringify(approved.body)).toMatchObject({ status:'active' });
  databases.add(dbName); ownerRoles.add(approved.body.dbUser);
  const ownerCredential=(await api('POST',`/api/db/assignments/${assignmentId}/credentials`,'owner')).body;
  const ownerConnection=new Client({ connectionString:ownerCredential.url }); await ownerConnection.connect();
  try {
    await ownerConnection.query("create table app_data(body text); insert into app_data values ('app stays online')");
    const opened=await api('POST',`/api/db/assignments/${assignmentId}/access`,'owner',{ open:true });
    expect(opened.body.state,JSON.stringify(opened.body)).toBe('active'); catalogIds.add(opened.body.id);
    const view=(await api('GET','/api/db/access/catalog')).body.find((r:any)=>r.id===opened.body.id);
    expect(view.drift,JSON.stringify(view.drift)).toMatchObject({ consistent:true,error:null });
    const g=(await api('POST',`/api/db/access/catalog/${opened.body.id}/grants`,'owner',{ userId:ids.other,level:'read' })).body;
    expect(g.state).toBe('active');
    expect((await api('POST',`/api/db/access/grants/${g.id}/revoke`,'owner',{})).body.state).toBe('revoked');
    expect((await api('DELETE',`/api/db/assignments/${assignmentId}`)).status).toBe(200);
    const dba=await target('dev');
    try { await dba.query(`create table personal_owned(body text); insert into personal_owned values ('keep me'); alter table personal_owned owner to ${q(`eat-${ids.reader}`)}`); } finally { await dba.end(); }
    const failed=await api('DELETE',`/api/db/instances/${instanceId}`);
    expect(failed.status,JSON.stringify(failed.body)).toBe(409); expect(failed.body.message).toContain(`eat-${ids.reader}`); expect(failed.body.message).toContain('personal_owned');
    expect((await api('GET','/api/db/instances')).body.find((r:any)=>r.id===instanceId).cleanupError).toBeNull();
    const fix=await target('dev'); try { expect((await fix.query('select body from personal_owned')).rows).toEqual([{ body:'keep me' }]); await fix.query(`alter table personal_owned owner to ${q(owner)}`); } finally { await fix.end(); }
    const deleted=await api('DELETE',`/api/db/instances/${instanceId}`);
    expect(deleted.status,JSON.stringify(deleted.body)).toBe(200);
    expect((await pool.query('select rolname from pg_roles where rolname=any($1::text[])',[Object.values(ids).map(id=>`eat-${id}`)])).rows).toEqual([]);
    expect((await ownerConnection.query('select body from app_data')).rows).toEqual([{ body:'app stays online' }]);
    expect((await pool.query('select rolname from pg_roles where rolname=any($1::text[])',[[owner,manager,outsider,approved.body.dbUser]])).rowCount).toBe(4);
    const extOwner=await target(); try { expect((await extOwner.query('select body from preserved')).rows).toEqual([{ body:'preserved' }]); } finally { await extOwner.end(); }
    expect((await api('GET','/api/db/instances')).body.some((r:any)=>r.id===instanceId)).toBe(false);
    const actions=(await pool.query("select action from audit_log where action in ('db_access.external_deleted','db_instance.delete_failed','db_instance.deleted')")).rows;
    expect(actions).toEqual(expect.arrayContaining([{ action:'db_access.external_deleted' },{ action:'db_instance.delete_failed' },{ action:'db_instance.deleted' }]));
  } finally { await ownerConnection.end(); }
});

it('无目录但仍有个人角色时也持久保存实例清理状态，平台写失败及重启后禁止复活，允许修正管理凭证再重试', async () => {
  const instance=(await api('POST','/api/db/instances','admin',{ name:'08无目录恢复实例',engine:'postgres',host:'127.0.0.1',port:5433,adminUser:manager,adminPassword:password })).body.id;
  const registered=(await api('POST',`/api/db/instances/${instance}/access/catalog`,'admin',{ dbName:database,ownerId:ids.owner,creatorRole:owner })).body;
  const g=(await api('POST',`/api/db/access/catalog/${registered.id}/grants`,'owner',{ userId:ids.reader,level:'read' })).body;
  expect(g.state).toBe('active');
  expect((await api('POST',`/api/db/access/grants/${g.id}/revoke`,'owner',{})).body.state).toBe('revoked');
  expect((await api('DELETE',`/api/db/access/catalog/${registered.id}`)).status).toBe(200);
  await pool.query(`create function block_instance_cleanup_08() returns trigger language plpgsql as $$ begin raise exception '08 injected instance deletion failure'; end $$; create trigger block_instance_cleanup_08 before delete on db_instance for each row execute function block_instance_cleanup_08()`);
  try {
    const failed=await api('DELETE',`/api/db/instances/${instance}`);
    expect(failed.status,JSON.stringify(failed.body)).toBe(409); expect(failed.body.message).toContain('平台记录保留');
    expect((await pool.query('select 1 from pg_roles where rolname=$1',[`eat-${ids.reader}`])).rowCount).toBe(0);
    await app.close();
    const module=await Test.createTestingModule({ imports:[AppModule] }).compile();
    app=module.createNestApplication<NestFastifyApplication>(new FastifyAdapter()); await app.init(); await app.getHttpAdapter().getInstance().ready();
    const row=(await api('GET','/api/db/instances')).body.find((r:any)=>r.id===instance);
    expect(row.cleanupError).toContain('删除未完成');
    expect((await api('POST',`/api/db/instances/${instance}/access/catalog`,'admin',{ dbName:database,ownerId:ids.owner,creatorRole:owner })).status).toBe(409);
    expect((await api('POST','/api/db/assignments','owner',{ instanceId:instance,dbName:`blocked_${suffix}`,purpose:'must not revive' })).status).toBe(409);
    expect((await api('PATCH',`/api/db/instances/${instance}/credentials`,'owner',{ adminUser:manager,adminPassword:password })).status).toBe(403);
    expect((await api('PATCH',`/api/db/instances/${instance}/credentials`,'admin',{ adminUser:manager,adminPassword:password })).status).toBe(200);
  } finally { await pool.query('drop trigger block_instance_cleanup_08 on db_instance; drop function block_instance_cleanup_08()'); }
  const retried=await api('DELETE',`/api/db/instances/${instance}`);
  expect(retried.status,JSON.stringify(retried.body)).toBe(200);
});

it('授予、撤销、修复与删除在同实例并发时不会让删除后的组或授权复活', async () => {
  const instance=(await api('POST','/api/db/instances','admin',{ name:'08并发清理实例',engine:'postgres',host:'127.0.0.1',port:5433,adminUser:manager,adminPassword:password })).body.id;
  const c=(await api('POST',`/api/db/instances/${instance}/access/catalog`,'admin',{ dbName:database,ownerId:ids.owner,creatorRole:owner })).body;
  const g=(await api('POST',`/api/db/access/catalog/${c.id}/grants`,'owner',{ userId:ids.reader,level:'read' })).body;
  const results=await Promise.all([
    api('POST',`/api/db/access/catalog/${c.id}/grants`,'owner',{ userId:ids.reader,level:'write' }),
    api('POST',`/api/db/access/grants/${g.id}/revoke`,'owner',{}),
    api('POST',`/api/db/access/catalog/${c.id}/repair`),
    api('DELETE',`/api/db/access/catalog/${c.id}`),
  ]);
  expect(results.every(r=>[200,201,404,409].includes(r.status)),JSON.stringify(results)).toBe(true);
  if ((await api('GET','/api/db/access/catalog')).body.some((r:any)=>r.id===c.id)) {
    expect((await api('POST',`/api/db/access/grants/${g.id}/revoke`,'owner',{})).body.state).toBe('revoked');
    expect((await api('DELETE',`/api/db/access/catalog/${c.id}`)).status).toBe(200);
  }
  expect((await pool.query('select rolname from pg_roles where rolname=any($1::text[])',[[`eat-db-${c.id}-read`,`eat-db-${c.id}-write`]])).rows).toEqual([]);
  expect((await api('GET','/api/db/access/grants')).body.some((r:any)=>r.catalogId===c.id)).toBe(false);
  expect((await api('DELETE',`/api/db/instances/${instance}`)).status).toBe(200);
});
