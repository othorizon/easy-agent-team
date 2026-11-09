/** 工单09：两个独立 PG16 集群，真实 SCRAM 与普通 CREATEROLE 管理身份。 */
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://dev@127.0.0.1:5433/eat_test_09';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcryptjs';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { Client, Pool } from 'pg';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { AppModule } from '../src/app.module';
import { DbAccessService } from '../src/dbs/db-access.service';
import * as schema from '../src/db/schema';

let app: NestFastifyApplication;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const container = `eat-pg09-${suffix}`;
const createdContainers: string[] = [];
const manager = `test09_mgr_${suffix}`;
const managerPassword = randomUUID();
const targets: Array<{ pool: Pool; port: number; instanceId: string; assignment: any; catalog: any; personal: any; owner: any }> = [];
const ids: Record<string, string> = {}, tokens: Record<string, string> = {};
const q = (s: string) => `"${s.replaceAll('"', '""')}"`;
const dbName = `test09_${suffix}`;
async function api(method: 'GET'|'POST'|'PATCH', url: string, who = 'admin', payload?: unknown) {
  const res = await app.inject({ method, url, headers: { authorization: `Bearer ${tokens[who]}` }, payload: payload as never });
  return { status: res.statusCode, body: JSON.parse(res.body) };
}
async function login(who: string) {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: `${who}@test09.dev`, password: 'password123' } });
  tokens[who] = JSON.parse(res.body).token;
}
async function connect(credentials: any) {
  const c = new Client({ connectionString: credentials.url });
  c.on('error', () => undefined);
  try { await c.connect(); return c; } catch (e) { await c.end(); throw e; }
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
  const passwordHash = await bcrypt.hash('password123', 4);
  for (const name of ['admin', 'member', 'race']) {
    const [u] = await drizzle(pool).insert(schema.users).values({ name, email: `${name}@test09.dev`, role: name === 'admin' ? 'admin' : 'member', passwordHash }).returning();
    ids[name] = u.id;
  }
  createdContainers.push(execFileSync('docker', ['run', '-d', '--name', container, '-p', '127.0.0.1::5432', '-e', 'POSTGRES_USER=dev', '-e', `POSTGRES_PASSWORD=${managerPassword}`, '-e', 'POSTGRES_HOST_AUTH_METHOD=scram-sha-256', 'postgres:16-alpine'], { encoding: 'utf8' }).trim());
  const mapped = execFileSync('docker', ['port', container, '5432/tcp'], { encoding: 'utf8' }).trim();
  const secondPort = Number(mapped.split(':').at(-1));
  const second = new Pool({ host: '127.0.0.1', port: secondPort, user: 'dev', password: managerPassword, database: 'postgres' });
  targets.push({ pool, port: 5433 } as any, { pool: second, port: secondPort } as any);
  await vi.waitFor(async () => { await second.query('select 1'); }, { timeout: 15000, interval: 100 });
  for (const target of targets) await target.pool.query(`create role ${q(manager)} login createrole createdb password '${managerPassword}'`);
  await boot();
  await login('admin'); await login('member');
  for (const [n, target] of targets.entries()) {
    const instance = await api('POST', '/api/db/instances', 'admin', { name: `09独立实例${n}`, engine: 'postgres', host: '127.0.0.1', port: target.port, adminUser: manager, adminPassword: managerPassword });
    expect(instance.status, JSON.stringify(instance.body)).toBe(201);
    target.instanceId = instance.body.id;
    const assignment = await api('POST', '/api/db/assignments', 'member', { instanceId: target.instanceId, dbName, purpose: '停用测试' });
    target.assignment = assignment.body;
    expect((await api('POST', `/api/db/assignments/${assignment.body.id}/approve`)).body.status).toBe('active');
    target.owner = (await api('POST', `/api/db/assignments/${assignment.body.id}/credentials`, 'member')).body;
    const owner = await connect(target.owner);
    try { await owner.query('create table notes(body text); insert into notes values ($$original$$)'); } finally { await owner.end(); }
    target.catalog = (await api('POST', `/api/db/assignments/${assignment.body.id}/access`, 'member', { open: true })).body;
    const grant = await api('POST', `/api/db/access/catalog/${target.catalog.id}/grants`, 'admin', { userId: ids.member, level: n === 0 ? 'write' : 'read' });
    expect(grant.body, JSON.stringify(grant.body)).toMatchObject({ state: 'active' });
    target.personal = (await api('POST', `/api/db/access/catalog/${target.catalog.id}/credentials`, 'member')).body;
  }
}, 45000);
afterAll(async () => {
  const errors: unknown[] = [];
  const attempt = async (cleanup: () => unknown | Promise<unknown>) => {
    try { await cleanup(); } catch (error) { errors.push(error); }
  };
  try {
    await attempt(() => app?.close());
    for (const t of targets) {
      await attempt(() => t.pool.query('select pg_terminate_backend(pid) from pg_stat_activity where datname=$1', [dbName]));
      await attempt(() => t.pool.query(`drop database if exists ${q(dbName)}`));
      for (const role of [`u_${dbName}`, ...Object.values(ids).map(id => `eat-${id}`), ...(t.catalog?.id ? [`eat-db-${t.catalog.id}-read`, `eat-db-${t.catalog.id}-write`] : [])]) await attempt(() => t.pool.query(`drop role if exists ${q(role)}`));
      await attempt(() => t.pool.query(`drop role if exists ${q(manager)}`));
      if (t.pool !== pool) await attempt(() => t.pool.end());
    }
  } finally {
    try { await attempt(() => pool.end()); } finally {
      // 仅清理本轮 docker run 返回的容器 ID；应用或连接池清理失败也继续执行。
      for (const id of createdContainers) await attempt(() => execFileSync('docker', ['rm', '-f', id]));
    }
  }
  if (errors.length) throw new AggregateError(errors, '工单09测试资源清理失败');
});

it('停用覆盖所有实例与全部个人会话；owner 持续可用；恢复保留密码及读写级别', async () => {
  const personal = await Promise.all(targets.map(t => connect(t.personal)));
  // 同一实例的维护库会话也必须被终止，不能只按授权库筛选。
  const extra = await connect({ url: targets[0].personal.url.replace(`/${dbName}`, '/postgres') });
  personal.push(extra);
  const owners = await Promise.all(targets.map(t => connect(t.owner)));
  const disconnected = personal.map(c => new Promise(resolve => c.once('error', resolve)));
  try {
    const disabled = await api('PATCH', `/api/users/${ids.member}`, 'admin', { status: 'disabled' });
    expect(disabled.body, JSON.stringify(disabled.body)).toMatchObject({ status: 'disabled', dbSyncPending: false });
    await Promise.all(disconnected);
    for (const c of personal) await expect(c.query('select 1')).rejects.toThrow();
    for (const [n, t] of targets.entries()) {
      await expect(connect(t.personal)).rejects.toThrow(/not permitted to log in/);
      expect((await owners[n].query('select body from notes')).rows[0].body).toBe('original');
      const freshOwner = await connect(t.owner); await freshOwner.end();
      expect((await api('POST', `/api/db/access/catalog/${t.catalog.id}/grants`, 'admin', { userId: ids.member, level: 'write' })).status).toBe(400);
      expect((await api('GET', `/api/db/assignments/${t.assignment.id}`)).body.ownerDisabled).toBe(true);
    }
    const catalog = (await api('GET', '/api/db/access/catalog')).body;
    expect(catalog.every((c: any) => c.ownerDisabled)).toBe(true);
    expect((await api('GET', '/api/db/assignments')).body.every((c: any) => c.ownerDisabled)).toBe(true);
    expect((await api('PATCH', `/api/users/${ids.member}`, 'admin', { status: 'active' })).body.dbSyncPending).toBe(false);
    await login('member');
    for (const [n, t] of targets.entries()) {
      const credential = await api('POST', `/api/db/access/catalog/${t.catalog.id}/credentials`, 'member');
      expect(credential.body).toEqual(t.personal);
      const c = await connect(t.personal);
      try {
        expect((await c.query('select body from notes')).rows[0].body).toBe('original');
        if (n === 0) await c.query('insert into notes values ($$restored$$)');
        else await expect(c.query('insert into notes values ($$forbidden$$)')).rejects.toThrow(/permission denied/);
      } finally { await c.end(); }
      expect((await api('GET', `/api/db/assignments/${t.assignment.id}`)).body.ownerDisabled).toBe(false);
    }
    const grants = (await api('GET', '/api/db/access/grants')).body;
    expect(grants.map((g: any) => [g.state, g.level]).sort()).toEqual([['active', 'read'], ['active', 'write']]);
  } finally { await Promise.all([...personal, ...owners].map(c => c.end())); }
}, 20000);

it('一个实例失败仍切断其他实例，显示持久同步待完成；30秒退避与重启后恢复', async () => {
  const first = targets[0];
  await first.pool.query(`alter role ${q(manager)} nologin`);
  try {
    const disabled = await api('PATCH', `/api/users/${ids.member}`, 'admin', { status: 'disabled' });
    expect(disabled.body).toMatchObject({ status: 'disabled', dbSyncPending: true });
    let user = (await api('GET', '/api/users')).body.find((u: any) => u.id === ids.member);
    expect(user.dbSyncPending).toBe(true);
    expect(user.dbSyncError).toContain('not permitted to log in');
    await expect(connect(targets[1].personal)).rejects.toThrow(/not permitted to log in/);
    // 修好目标后立即重启，持久的重试时间防止重启绕过退避。
    await first.pool.query(`alter role ${q(manager)} login`);
    await app.close(); await boot();
    await (app.get(DbAccessService) as any).recovery;
    user = (await api('GET', '/api/users')).body.find((u: any) => u.id === ids.member);
    expect(user.dbSyncPending).toBe(true);
    const notRetried = await connect(first.personal); await notRetried.end();
    await app.close();
    // 仅推进持久调度时间，不修改角色、同步结果或授权。
    await pool.query('update db_personal_role set sync_retry_at=now()-interval \'1 second\' where user_id=$1', [ids.member]);
    await boot();
    await vi.waitFor(async () => {
      expect((await api('GET', '/api/users')).body.find((u: any) => u.id === ids.member)).toMatchObject({ dbSyncPending: false, dbSyncError: null });
    });
    for (const t of targets) await expect(connect(t.personal)).rejects.toThrow(/not permitted to log in/);
    expect((await api('PATCH', `/api/users/${ids.member}`, 'admin', { status: 'active' })).body.dbSyncPending).toBe(false);
    await login('member');
  } finally { await first.pool.query(`alter role ${q(manager)} login`); }
});

it('停用与首次个人身份写入并发，停用响应完成后不会创建 LOGIN 角色', async () => {
  const t = targets[0];
  await pool.query(`create function test09_delay_identity() returns trigger language plpgsql as $$ begin if new.user_id='${ids.race}'::uuid then perform pg_sleep(0.6); end if; return new; end $$; create trigger test09_delay before insert on db_personal_role for each row execute function test09_delay_identity()`);
  try {
    const giving = api('POST', `/api/db/access/catalog/${t.catalog.id}/grants`, 'admin', { userId: ids.race, level: 'write' });
    await vi.waitFor(async () => {
      const sleeping = await pool.query("select 1 from pg_stat_activity where wait_event='PgSleep' and query like '%db_personal_role%'");
      expect(sleeping.rowCount).toBeGreaterThan(0);
    });
    const disabled = await api('PATCH', `/api/users/${ids.race}`, 'admin', { status: 'disabled' });
    expect(disabled.body).toMatchObject({ status: 'disabled', dbSyncPending: false });
    const grant = await giving;
    expect(grant.body).toMatchObject({ state: 'failed' });
    expect(grant.body.error).toContain('已停用');
    // 直接以个人角色连接 postgres，也不能绕过目录 CONNECT 的限制。
    const rejected = new Client({ host: '127.0.0.1', port: t.port, user: `eat-${ids.race}`, password: 'irrelevant', database: 'postgres' });
    try { await expect(rejected.connect()).rejects.toThrow(/password authentication failed|does not exist|not permitted to log in/); } finally { await rejected.end(); }
    // 停用之后的直接授予同样被拒绝。
    expect((await api('POST', `/api/db/access/catalog/${t.catalog.id}/grants`, 'admin', { userId: ids.race, level: 'read' })).status).toBe(400);
  } finally { await pool.query('drop trigger test09_delay on db_personal_role; drop function test09_delay_identity()'); }
});

it('停用与恢复保留未完成的密码重置，凭证读取恢复原操作且不改变读写级别', async () => {
  const t = targets[0];
  await t.pool.query(`alter role ${q(manager)} nologin`);
  try {
    const resetting = await api('POST', `/api/db/access/catalog/${t.catalog.id}/reset-password`, 'member');
    expect(resetting.body).toMatchObject({ state: 'pending' });
    expect((await api('PATCH', `/api/users/${ids.member}`, 'admin', { status: 'disabled' })).body.dbSyncPending).toBe(true);
    await t.pool.query(`alter role ${q(manager)} login`);
    expect((await api('PATCH', `/api/users/${ids.member}`, 'admin', { status: 'active' })).body.dbSyncPending).toBe(false);
    // 恢复 LOGIN 本身不会提前执行密码操作，也不会重放只读授权覆盖读写。
    const old = await connect(t.personal);
    try { await old.query('insert into notes values ($$still-write$$)'); } finally { await old.end(); }
    await login('member');
    const fresh = await api('POST', `/api/db/access/catalog/${t.catalog.id}/credentials`, 'member');
    expect(fresh.status).toBe(201);
    expect(fresh.body.password).not.toBe(t.personal.password);
    await expect(connect(t.personal)).rejects.toThrow(/password authentication failed/);
    const c = await connect(fresh.body);
    try { await c.query('insert into notes values ($$new-password-write$$)'); } finally { await c.end(); }
    t.personal = fresh.body;
    expect((await api('GET', '/api/db/access/grants')).body.find((g: any) => g.catalogId === t.catalog.id)).toMatchObject({ state: 'active', level: 'write' });
  } finally { await t.pool.query(`alter role ${q(manager)} login`); }
});

it('实例删除未完成的屏障阻止新增授权，但不阻止个人身份的安全停用', async () => {
  const t = targets[0];
  await pool.query('update db_instance set cleanup_error=$2 where id=$1', [t.instanceId, '删除未完成：测试安全同步']);
  const active = await connect(t.personal);
  const disconnected = new Promise(resolve => active.once('error', resolve));
  try {
    const disabled = await api('PATCH', `/api/users/${ids.member}`, 'admin', { status: 'disabled' });
    expect(disabled.body).toMatchObject({ dbSyncPending: false });
    await disconnected;
    await expect(connect(t.personal)).rejects.toThrow(/not permitted to log in/);
    expect((await api('PATCH', `/api/users/${ids.member}`, 'admin', { status: 'active' })).body.dbSyncPending).toBe(false);
    expect((await api('POST', `/api/db/access/catalog/${t.catalog.id}/grants`, 'admin', { userId: ids.member, level: 'write' })).status).toBe(409);
  } finally { await active.end(); await pool.query('update db_instance set cleanup_error=null where id=$1', [t.instanceId]); await login('member'); }
});

it('启动时补齐升级前已停用用户的个人身份，即使没有显式 pending 标记', async () => {
  await app.close();
  // 模拟迁移前已停用的用户：新字段默认值代表原有 LOGIN，尚无待同步标记。
  await pool.query('update "user" set status=\'disabled\' where id=$1', [ids.member]);
  await pool.query('update db_personal_role set login_enabled=true,sync_pending=false,sync_retry_at=null where user_id=$1', [ids.member]);
  await boot();
  await vi.waitFor(async () => {
    for (const t of targets) await expect(connect(t.personal)).rejects.toThrow(/not permitted to log in/);
    expect((await api('GET', '/api/users')).body.find((u: any) => u.id === ids.member)).toMatchObject({ dbSyncPending: false });
  });
  expect((await api('PATCH', `/api/users/${ids.member}`, 'admin', { status: 'active' })).body.dbSyncPending).toBe(false);
  await login('member');
});

it('授权全部撤销后保留的个人身份仍会被停用，恢复不会重新加入任何组', async () => {
  const t = targets[1];
  const grants = (await api('GET', '/api/db/access/grants')).body;
  const g = grants.find((r: any) => r.catalogId === t.catalog.id && r.userId === ids.member);
  expect((await api('POST', `/api/db/access/grants/${g.id}/relinquish`, 'member', {})).body.state).toBe('revoked');
  const maintenance = { url: t.personal.url.replace(`/${dbName}`, '/postgres') };
  const c = await connect(maintenance);
  const disconnected = new Promise(resolve => c.once('error', resolve));
  try {
    expect((await api('PATCH', `/api/users/${ids.member}`, 'admin', { status: 'disabled' })).body.dbSyncPending).toBe(false);
    await disconnected;
    await expect(connect(maintenance)).rejects.toThrow(/not permitted to log in/);
    expect((await api('PATCH', `/api/users/${ids.member}`, 'admin', { status: 'active' })).body.dbSyncPending).toBe(false);
    const restored = await connect(maintenance); await restored.end();
    await expect(connect(t.personal)).rejects.toThrow(/permission denied/);
    expect((await api('GET', '/api/db/access/grants')).body.find((r: any) => r.id === g.id)).toMatchObject({ state: 'revoked', level: 'read' });
  } finally { await c.end(); await login('member'); }
});
