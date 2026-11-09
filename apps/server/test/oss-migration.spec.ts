process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://dev@127.0.0.1:5433/eat_test_17';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { beforeAll, beforeEach, afterAll, it, expect, vi } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { resolve } from 'node:path';
import { randomUUID, createHash, createCipheriv, randomBytes } from 'node:crypto';
import { encryptSecret } from '../src/common/crypto';
import * as bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { AppModule } from '../src/app.module';
import { DB, PG_POOL, type Db } from '../src/db/db.module';
import * as schema from '../src/db/schema';
import { OssCloud } from '../src/oss/oss-cloud';
import { OssService } from '../src/oss/oss.service';
import { RamCloud, RamCloudError, type RamCredentials } from '../src/ram/ram-cloud';
import { TestRamCloud } from './ram-fixture';
import { TestOssCloud } from './oss-fixture';
import { CloudIdentitiesService } from '../src/cloud-identities/cloud-identities.service';

// Faults are injected only at the RAM transport boundary.
class MigrationRamCloud extends TestRamCloud {
  lostRenameFor?: string;
  beforeRename?: () => Promise<void>;
  beforeGetUser?: (name: string) => Promise<void>;
  protected override async ram(c: RamCredentials, action: string, args: Record<string, any>) {
    if (action === 'GetUser') await this.beforeGetUser?.(args.userName);
    if (action === 'UpdateUser' && args.newUserName) await this.beforeRename?.();
    const response = await super.ram(c, action, args);
    if (action === 'UpdateUser' && args.newUserName === this.lostRenameFor) {
      this.lostRenameFor = undefined;
      throw new RamCloudError(action, 'NETWORK_ERROR');
    }
    return response;
  }
}
const ram = new MigrationRamCloud();
const cloud = new TestOssCloud(ram);
const management = { accessKeyId: 'management-test', accessKeySecret: 'management-test-secret' };
const path = '/api/admin/oss-settings/migration-preview';
let app: NestFastifyApplication, db: Db, service: OssService;
let admin: string, member: string, other: string, disabled: string;
let memberId: string, otherId: string, disabledId: string;
async function api(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, token = admin, payload?: unknown) {
  const r = await app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, payload: payload as never });
  return { status: r.statusCode, body: JSON.parse(r.body), headers: r.headers };
}
async function approve(token: string, name = '测试空间') {
  const r = await api('POST', '/api/oss/spaces', token, { name, purpose: '迁移预演', requestId: randomUUID() });
  expect(r.status).toBe(201);
  expect((await api('POST', `/api/oss/spaces/${r.body.id}/approve`)).status).toBe(201);
  await service.tick();
  return (await api('GET', `/api/oss/spaces/${r.body.id}`)).body;
}
async function boot() {
  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(RamCloud).useValue(ram).overrideProvider(OssCloud).useValue(cloud).compile();
  app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  db = app.get(DB);
  service = app.get(OssService);
  app.get(CloudIdentitiesService).keyPropagationMs = 0;
}
beforeAll(async () => {
  vi.spyOn(OssService.prototype, 'onModuleInit').mockImplementation(() => {});
  vi.spyOn(OssService.prototype, 'wake').mockImplementation(() => {});
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await pool.query('drop schema public cascade; create schema public; drop schema if exists drizzle cascade;');
  await migrate(drizzle(pool), { migrationsFolder: resolve('drizzle') });
  await pool.end();
  await boot();
  const passwordHash = await bcrypt.hash('password123', 4);
  await db.insert(schema.users).values([
    { name: '管理员', email: 'admin@preview.test', passwordHash, role: 'admin' },
    { name: '有效空间', email: 'member@preview.test', passwordHash },
    { name: '已回收空间', email: 'other@preview.test', passwordHash },
    { name: '停用成员', email: 'disabled@preview.test', passwordHash },
  ]);
  const login = async (email: string) => (await api('POST', '/api/auth/login', '', { email, password: 'password123' })).body;
  admin = (await login('admin@preview.test')).token;
  const m = await login('member@preview.test'); member = m.token; memberId = m.user.id;
  const o = await login('other@preview.test'); other = o.token; otherId = o.user.id;
  const d = await login('disabled@preview.test'); disabled = d.token; disabledId = d.user.id;
});
beforeEach(async () => {
  ram.lostRenameFor = undefined; ram.beforeRename = undefined; ram.beforeGetUser = undefined;
  await db.delete(schema.aliyunOperations);
  await db.delete(schema.aliyunGrants);
  await db.delete(schema.aliyunPermissions);
  await db.delete(schema.aliyunConnections);
  await db.delete(schema.ossMigrationResults);
  await db.delete(schema.ossAccounts);
  await db.delete(schema.cloudIdentities);
  await db.delete(schema.ossOperations);
  await db.delete(schema.ossSpaces);
  await db.delete(schema.ossAccounts);
  await db.delete(schema.ossSettings);
  await db.update(schema.users).set({ status: 'active' });
  member = (await api('POST', '/api/auth/login', '', { email: 'member@preview.test', password: 'password123' })).body.token;
  other = (await api('POST', '/api/auth/login', '', { email: 'other@preview.test', password: 'password123' })).body.token;
  disabled = (await api('POST', '/api/auth/login', '', { email: 'disabled@preview.test', password: 'password123' })).body.token;
  cloud.reset(); ram.reset();
  expect((await api('PUT', '/api/admin/oss-settings', admin, { bucket: 'bucket-test', region: 'cn-beijing', ...management })).status).toBe(200);
  await db.update(schema.ossSettings).set({ status: 'enabled', accountId: 'account-test' });
});
afterAll(async () => { await app?.close(); vi.restoreAllMocks(); });

it('requires admin confirmation, renames existing identities and preserves the already-issued OSS Key', async () => {
  const space = await approve(member);
  const key = (await api('POST', '/api/oss/me/credentials', member)).body;
  expect((await api('POST', '/api/admin/oss-settings/migration', member, { confirm: true })).status).toBe(403);
  expect((await api('POST', '/api/admin/oss-settings/migration', admin, {})).status).toBe(400);
  const migration = await api('POST', '/api/admin/oss-settings/migration', admin, { confirm: true });
  expect(migration.status).toBe(201);
  expect(migration.body.state).toBe('complete');
  expect(migration.body.results).toMatchObject([{ userId: memberId, state: 'complete', stage: 'complete' }]);
  const after = await api('POST', '/api/oss/me/credentials', member);
  expect(after.status).toBe(201);
  expect(after.body.accessKeyId).toBe(key.accessKeyId);
  expect(after.body.accessKeySecret).toBe(key.accessKeySecret);
  expect([...ram.users.keys()]).toEqual([`eat-${memberId.replaceAll('-', '')}`]);
  await cloud.put({ ...management, ...key, bucket: 'bucket-test', region: 'cn-beijing' }, `${space.prefix}unchanged.txt`, Buffer.from('same key'));
  expect((await api('GET', '/api/admin/oss-settings/migration')).body.state).toBe('complete');
});

it('persists per-person results across a lost rename response and restart, blocks writes, and skips completed people', async () => {
  await approve(member); await approve(other); await approve(disabled);
  const oldKey = (await api('POST', '/api/oss/me/credentials', member)).body;
  const target = `eat-${otherId.replaceAll('-', '')}`;
  await ram.createUser(management, { name: target, comments: 'human', displayName: 'conflict' });
  ram.lostRenameFor = `eat-${memberId.replaceAll('-', '')}`;
  const first = await api('POST', '/api/admin/oss-settings/migration', admin, { confirm: true });
  expect(first.body.state).toBe('partial');
  expect(first.body.results.find((r: any) => r.userId === memberId)).toMatchObject({ state: 'failed', stage: 'verified' });
  expect(first.body.results.find((r: any) => r.userId === otherId)).toMatchObject({ state: 'failed', stage: 'preflight' });
  const completed = first.body.results.find((r: any) => r.userId === disabledId);
  expect(completed).toMatchObject({ state: 'complete' });
  expect((await api('POST', '/api/oss/spaces', member, { name: 'blocked', purpose: 'migration', requestId: randomUUID() })).status).toBe(409);
  expect((await api('POST', '/api/oss/me/credentials/reset', member)).status).toBe(409);
  expect((await api('POST', '/api/admin/oss-settings/disable')).status).toBe(409);
  expect((await api('GET', '/api/oss/spaces', member)).status).toBe(200);
  // Actual process replacement, retaining only PostgreSQL and the cloud boundary.
  await app.close(); await boot();
  expect((await api('GET', '/api/admin/oss-settings/migration')).body.state).toBe('partial');
  await ram.deleteUser(management, target);
  const retry = await api('POST', '/api/admin/oss-settings/migration', admin, { confirm: true });
  expect(retry.body.state).toBe('complete');
  expect(retry.body.results.find((r: any) => r.userId === disabledId)).toEqual(completed);
  expect((await api('POST', '/api/oss/me/credentials', member)).body.accessKeyId).toBe(oldKey.accessKeyId);
  expect([...ram.users.keys()].filter(n => n.startsWith('eat-oss-'))).toEqual([]);
  expect((await api('POST', '/api/admin/oss-settings/migration', admin, { confirm: true })).body).toEqual(retry.body);
});

it('secures every Key and console login before replacing disabled legacy Deny, restores only the managed Key, and detaches empty aggregation', async () => {
  const kept = await approve(disabled);
  const empty = await approve(other);
  expect((await api('POST', `/api/oss/spaces/${empty.id}/revoke`)).status).toBe(201); await service.tick();
  const account = (await db.select().from(schema.ossAccounts).where(eq(schema.ossAccounts.userId, disabledId)))[0];
  const managed = ram.users.get(account.ramName)!.keys[0].id;
  await api('PATCH', `/api/users/${disabledId}`, admin, { status: 'disabled' }); await service.tick();
  const manual = await ram.createKey(management, account.ramName);
  ram.setConsoleLogin(management, account.ramName, true);
  const deny = ram.policies.get(account.policyName)!.document;
  expect(JSON.parse(deny).Statement[0].Effect).toBe('Deny');
  ram.failKeyStatus = true;
  const failed = await api('POST', '/api/admin/oss-settings/migration', admin, { confirm: true });
  expect(failed.body.state).toBe('partial');
  expect(failed.body.results.find((r: any) => r.userId === disabledId).state).toBe('failed');
  expect(ram.policies.get(account.policyName)!.document).toBe(deny);
  expect(ram.users.has(account.ramName)).toBe(true);
  ram.failKeyStatus = false;
  const migrated = await api('POST', '/api/admin/oss-settings/migration', admin, { confirm: true });
  expect(migrated.body.state).toBe('complete');
  const name = `eat-${disabledId.replaceAll('-', '')}`;
  expect(await ram.keys(management, name)).toEqual([{ id: managed, status: 'Inactive' }, { id: manual.id, status: 'Inactive' }]);
  expect(ram.hasConsoleLogin(management, name)).toBe(false);
  const allow = ram.policies.get(account.policyName)!.document;
  expect(allow).toContain(kept.prefix);
  expect(JSON.parse(allow).Statement.every((s: any) => s.Effect === 'Allow')).toBe(true);
  expect((await ram.userPolicies(management, `eat-${otherId.replaceAll('-', '')}`))).toEqual([]);
  await api('PATCH', `/api/users/${disabledId}`, admin, { status: 'active' }); await service.tick();
  expect(await ram.keys(management, name)).toEqual([{ id: managed, status: 'Active' }, { id: manual.id, status: 'Inactive' }]);
  expect(ram.policies.get(account.policyName)!.document).toBe(allow);
  const restored = await api('POST', '/api/auth/login', '', { email: 'disabled@preview.test', password: 'password123' });
  disabled = restored.body.token;
  expect((await api('POST', '/api/oss/me/credentials', disabled)).body.accessKeyId).toBe(managed);
});

it('requires recovery of legacy in-flight operations, then rejects all OSS writers while the migration session is held', async () => {
  const pending = await api('POST', '/api/oss/spaces', member, { name: 'pending', purpose: 'migration', requestId: randomUUID() });
  await api('POST', `/api/oss/spaces/${pending.body.id}/approve`);
  expect((await api('POST', '/api/admin/oss-settings/migration', admin, { confirm: true })).status).toBe(409);
  expect((await api('GET', '/api/admin/oss-settings/migration')).body.state).toBe('pending');
  await service.tick();
  let unlock!: () => void, entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { unlock = resolve; });
  ram.beforeRename = async () => { entered(); await gate; };
  const migration = api('POST', '/api/admin/oss-settings/migration', admin, { confirm: true });
  await ready;
  try {
    for (const [method, url, token, payload] of [
      ['POST', '/api/oss/spaces', member, { name: 'blocked', purpose: 'blocked', requestId: randomUUID() }],
      ['PATCH', `/api/oss/spaces/${pending.body.id}`, member, { name: 'blocked' }],
      ['PUT', `/api/oss/spaces/${pending.body.id}/public-read`, member, { enabled: true }],
      ['POST', `/api/oss/spaces/${pending.body.id}/revoke`, admin, {}],
      ['POST', '/api/oss/me/credentials/reset', member, {}],
      ['PUT', '/api/admin/oss-settings', admin, { bucket: 'bucket-test', region: 'cn-beijing', ...management }],
      ['POST', '/api/admin/oss-settings/enable', admin, {}],
      ['POST', '/api/admin/oss-settings/disable', admin, {}],
    ] as const) expect((await api(method, url, token, payload)).status, url).toBe(409);
    await service.tick(); // Only security recovery may run; ordinary OSS queues stay frozen.
    expect((await api('GET', '/api/oss/spaces', member)).status).toBe(200);
  } finally { unlock(); }
  expect((await migration).body.state).toBe('complete');
});

it('uses unified identities for new spaces, resets the shared Key, detaches the last space and preserves read-only OSS rows', async () => {
  const first = await approve(member);
  const oldKey = (await api('POST', '/api/oss/me/credentials', member)).body;
  expect((await api('POST', '/api/admin/oss-settings/migration', admin, { confirm: true })).body.state).toBe('complete');
  const originalCloudId = (await ram.getUser(management, `eat-${memberId.replaceAll('-', '')}`)).id;
  const second = await approve(member, '第二空间');
  expect((await ram.getUser(management, `eat-${memberId.replaceAll('-', '')}`)).id).toBe(originalCloudId);
  // A person with no legacy OSS account must use the same unified naming/lifecycle.
  const newSpace = await approve(other, '首次开通');
  expect([...ram.users.keys()].sort()).toEqual([`eat-${memberId.replaceAll('-', '')}`, `eat-${otherId.replaceAll('-', '')}`].sort());
  const key = (await api('POST', '/api/oss/me/credentials', other)).body;
  expect(key.accessKeyId).toBeTruthy();
  await cloud.put({ ...management, ...key, bucket: 'bucket-test', region: 'cn-beijing' }, `${newSpace.prefix}works.txt`, Buffer.from('new identity'));
  const conn = await api('POST', '/api/aliyun/connections', admin, { name: 'oss-cloud', defaultRegion: 'cn-beijing', ...management });
  expect(conn.status).toBe(201);
  const my = await api('GET', '/api/aliyun/grants', member);
  expect(my.body.ossSpaces.map((s: any) => s.id).sort()).toEqual([first.id, second.id].sort());
  expect(my.body.grants).toEqual([]);
  expect((await api('GET', '/api/aliyun/permissions', member)).body).toEqual([]);
  const same = await api('POST', `/api/aliyun/connections/${conn.body.id}/credentials`, member);
  expect(same.status).toBe(201); expect(same.body.accessKeyId).toBe(oldKey.accessKeyId);
  const rotation = await api('POST', '/api/oss/me/credentials/reset', member);
  expect(rotation.status).toBe(201); await service.tick();
  expect((await api('GET', `/api/oss/operations/${rotation.body.id}`, member)).body.state).toBe('complete');
  const reset = (await api('POST', '/api/oss/me/credentials', member)).body;
  expect(reset.accessKeyId).not.toBe(oldKey.accessKeyId);
  expect((await api('POST', `/api/aliyun/connections/${conn.body.id}/credentials`, member)).body.accessKeyId).toBe(reset.accessKeyId);
  expect((await ram.keys(management, `eat-${memberId.replaceAll('-', '')}`)).map(k => k.id)).toEqual([reset.accessKeyId]);
  for (const id of [first.id, second.id]) { await api('POST', `/api/oss/spaces/${id}/revoke`); await service.tick(); }
  expect((await ram.userPolicies(management, `eat-${memberId.replaceAll('-', '')}`))).toEqual([]);
  const account = (await db.select().from(schema.ossAccounts).where(eq(schema.ossAccounts.userId, memberId)))[0];
  expect(JSON.parse(ram.policies.get(account.policyName)!.document).Statement.every((s: any) => s.Effect === 'Allow')).toBe(true);
  expect((await api('POST', `/api/aliyun/connections/${conn.body.id}/credentials`, member)).status).toBe(403);
});

it.each(['OSS', 'identity'])('stops after losing the %s session lock and resumes by stable cloud UserId without recreating the old name', async which => {
  await approve(member);
  const oldKey = (await api('POST', '/api/oss/me/credentials', member)).body;
  let unlock!: () => void, entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { unlock = resolve; });
  ram.beforeRename = async () => { entered(); await gate; };
  const migration = api('POST', '/api/admin/oss-settings/migration', admin, { confirm: true });
  await ready;
  const pool = app.get<Pool>(PG_POOL);
  const locks = await pool.query(`select pid from pg_locks where locktype='advisory' and granted and ${which === 'OSS' ? 'classid=0 and objid=1950536511' : 'classid<>0'}`);
  expect(locks.rows).toHaveLength(1);
  await pool.query('select pg_terminate_backend($1)', [locks.rows[0].pid]);
  await new Promise(resolve => setTimeout(resolve, 30));
  unlock();
  expect((await migration).status).toBe(409);
  const interrupted = await api('GET', '/api/admin/oss-settings/migration');
  expect(interrupted.body).toMatchObject({ state: 'running', results: [{ stage: 'verified', state: 'running' }] });
  expect([...ram.users.keys()]).toEqual([`eat-${memberId.replaceAll('-', '')}`]);
  expect((await api('POST', '/api/oss/me/credentials/reset', member)).status).toBe(409);
  ram.beforeRename = undefined;
  expect((await api('POST', '/api/admin/oss-settings/migration', admin, { confirm: true })).body.state).toBe('complete');
  expect((await api('POST', '/api/oss/me/credentials', member)).body.accessKeyId).toBe(oldKey.accessKeyId);
});

it('persists the copied credential lifecycle and readiness deadline across migration and restart without creating a Key', async () => {
  await approve(member);
  const key = (await api('POST', '/api/oss/me/credentials', member)).body;
  const deadline = new Date(Date.now() + 1500);
  const retiring = await ram.createKey(management, [...ram.users.keys()][0]);
  await db.update(schema.ossAccounts).set({ keyReadyAt: deadline, keyGeneration: 7, keyBaseline: [key.accessKeyId, retiring.id], retiringKeyIds: [retiring.id] }).where(eq(schema.ossAccounts.userId, memberId));
  const beforeKeys = await ram.keys(management, [...ram.users.keys()][0]);
  expect((await api('POST', '/api/admin/oss-settings/migration', admin, { confirm: true })).body.state).toBe('complete');
  expect(await ram.keys(management, `eat-${memberId.replaceAll('-', '')}`)).toEqual(beforeKeys);
  const waiting = await api('POST', '/api/oss/me/credentials', member);
  expect(waiting.status).toBe(409);
  await app.close(); await boot(); // boot's propagationMs=0 cannot shorten an already persisted deadline.
  expect((await api('POST', '/api/oss/me/credentials', member)).status).toBe(409);
  await service.tick();
  expect(Date.now()).toBeGreaterThanOrEqual(deadline.getTime());
  expect((await api('POST', '/api/oss/me/credentials', member)).body.accessKeySecret).toBe(key.accessKeySecret);
  expect(await ram.keys(management, `eat-${memberId.replaceAll('-', '')}`)).toEqual([{ id: key.accessKeyId, status: 'Active' }]);
  const account = (await api('GET', '/api/oss/me/account', member)).body;
  expect(account).toMatchObject({ configured: true, syncPending: false });
  const steps = (await api('GET', '/api/audit?action=oss_migration.step&limit=500')).body.filter((r: any) => r.targetId === memberId);
  expect(steps.some((r: any) => r.meta.stage === 'verified')).toBe(true);
  expect(steps.some((r: any) => r.meta.stage === 'renamed')).toBe(true);
  expect(steps.some((r: any) => r.meta.stage === 'identity')).toBe(true);
  expect(steps.some((r: any) => r.meta.stage === 'linked')).toBe(true);
  expect(steps.some((r: any) => r.meta.stage === 'policy')).toBe(true);
  expect(steps.some((r: any) => r.meta.stage === 'complete' && r.meta.state === 'complete')).toBe(true);
  expect(JSON.stringify(steps)).not.toContain(key.accessKeyId);
  expect(JSON.stringify(steps)).not.toContain(key.accessKeySecret);
  expect(JSON.stringify(steps)).not.toContain(management.accessKeySecret);
});

it('continues security-only revocation for an unmigrated person during a partial migration, without recreating or changing policy', async () => {
  await approve(member);
  const source = [...ram.users.keys()][0];
  const policy = ram.policies.get(source)!.document;
  const target = `eat-${memberId.replaceAll('-', '')}`;
  await ram.createUser(management, { name: target, displayName: 'unrelated', comments: 'unrelated' });
  expect((await api('POST', '/api/admin/oss-settings/migration', admin, { confirm: true })).body.state).toBe('partial');
  await api('PATCH', `/api/users/${memberId}`, admin, { status: 'disabled' });
  await service.tick();
  expect((await ram.keys(management, source)).every(k => k.status === 'Inactive')).toBe(true);
  expect(ram.policies.get(source)!.document).toBe(policy);
  expect((await ram.getUser(management, target)).comments).toBe('unrelated');
  expect([...ram.users.keys()].sort()).toEqual([source, target].sort());
  await api('PATCH', `/api/users/${memberId}`, admin, { status: 'active' });
  member = (await api('POST', '/api/auth/login', '', { email: 'member@preview.test', password: 'password123' })).body.token;
  await service.tick();
  expect((await ram.keys(management, source)).every(k => k.status === 'Inactive')).toBe(true);
});

it('cuts off a disabled legacy person while another person holds the batch OSS lock, through both hook and worker', async () => {
  await approve(member); await approve(other); await approve(disabled);
  const ordered = [memberId, otherId, disabledId].sort();
  const blocked = ordered[0], hookUser = ordered[1], workerUser = ordered[2];
  const legacy = new Map([...ram.users.values()].map(user => [user.comments.split(' ').at(-1)!, user.userName]));
  const oldHookPolicy = ram.policies.get(legacy.get(hookUser)!)!.document;
  const oldWorkerPolicy = ram.policies.get(legacy.get(workerUser)!)!.document;
  let unlock!: () => void, entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { unlock = resolve; });
  ram.beforeRename = async () => { entered(); await gate; };
  const migration = api('POST', '/api/admin/oss-settings/migration', admin, { confirm: true });
  await ready;
  try {
    const hook = api('PATCH', `/api/users/${hookUser}`, admin, { status: 'disabled' });
    const response = await Promise.race([hook, new Promise<'blocked'>(resolve => setTimeout(() => resolve('blocked'), 1000))]);
    expect(response).not.toBe('blocked');
    expect(await ram.keys(management, legacy.get(hookUser)!)).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'Inactive' })]));
    // Simulate a process ending after users.status committed but before the hook; worker still cuts
    // the exact source identity while the unrelated migrate/rename cloud call remains blocked.
    await db.update(schema.users).set({ status: 'disabled' }).where(eq(schema.users.id, workerUser));
    const recovery = service.tick();
    const recovered = await Promise.race([recovery.then(() => 'done'), new Promise<'blocked'>(resolve => setTimeout(() => resolve('blocked'), 1000))]);
    expect(recovered).toBe('done');
    expect((await ram.keys(management, legacy.get(workerUser)!)).every(k => k.status === 'Inactive')).toBe(true);
    expect(ram.policies.get(legacy.get(hookUser)!)!.document).toBe(oldHookPolicy);
    expect(ram.policies.get(legacy.get(workerUser)!)!.document).toBe(oldWorkerPolicy);
    expect([...ram.users.keys()]).toContain(legacy.get(blocked));
  } finally { unlock(); }
  expect((await migration).body.state).toBe('complete');
});

it('deletes an OSS-account Aliyun connection while retaining exact OSS references including empty accounts, and cleans only pure Aliyun identities', async () => {
  const active = await approve(member), empty = await approve(other);
  const memberKey = (await api('POST', '/api/oss/me/credentials', member)).body;
  const emptyKey = (await api('POST', '/api/oss/me/credentials', other)).body;
  await api('POST', '/api/admin/oss-settings/migration', admin, { confirm: true });
  await api('POST', `/api/oss/spaces/${empty.id}/revoke`); await service.tick();
  const connection = (await api('POST', '/api/aliyun/connections', admin, { name: 'oss-cloud', defaultRegion: 'cn-beijing', ...management })).body;
  await ram.createPolicy(management, 'eat-perm-migration', 'manual test', JSON.stringify({ Version: '1', Statement: [] }));
  await api('POST', `/api/aliyun/connections/${connection.id}/refresh`);
  const permission = (await api('GET', '/api/aliyun/permissions/manage')).body.find((p: any) => p.policyName === 'eat-perm-migration');
  for (const userId of [memberId, disabledId]) {
    const grant = await api('POST', `/api/aliyun/permissions/${permission.id}/grants`, admin, { userId });
    expect(grant.body.state).toBe('active');
    if (userId === disabledId) expect((await api('POST', `/api/aliyun/connections/${connection.id}/credentials`, disabled)).status).toBe(201);
    expect((await api('POST', `/api/aliyun/grants/${grant.body.id}/revoke`, admin, { reason: 'cleanup' })).body.state).toBe('revoked');
  }
  expect((await api('POST', `/api/aliyun/connections/${connection.id}/status`, admin, { status: 'paused' })).status).toBe(201);
  expect((await api('POST', '/api/oss/me/credentials', member)).body.accessKeyId).toBe(memberKey.accessKeyId);
  const removed = await api('DELETE', `/api/aliyun/connections/${connection.id}`, admin, { confirmName: connection.name });
  expect(removed.body).toEqual({ ok: true });
  expect([...ram.users.keys()].sort()).toEqual([`eat-${memberId.replaceAll('-', '')}`, `eat-${otherId.replaceAll('-', '')}`].sort());
  expect((await api('POST', '/api/oss/me/credentials', member)).body.accessKeyId).toBe(memberKey.accessKeyId);
  expect((await ram.keys(management, `eat-${otherId.replaceAll('-', '')}`)).map(k => k.id)).toEqual([emptyKey.accessKeyId]);
  await cloud.put({ ...memberKey, bucket: 'bucket-test', region: 'cn-beijing' }, `${active.prefix}retained.txt`, Buffer.from('retained'));
  const mine = (await api('GET', '/api/aliyun/grants', member)).body;
  expect(mine.ossSpaces).toMatchObject([{ id: active.id, connectionId: null }]);
  await approve(other, '删除接入后再次开通');
  expect((await api('POST', '/api/oss/me/credentials', other)).body.accessKeyId).toBe(emptyKey.accessKeyId);
});

it('does not clean a pure-Aliyun identity while its first OSS space is publishing; retry deletion retains the new exact OSS reference', async () => {
  await api('POST', '/api/admin/oss-settings/migration', admin, { confirm: true });
  const connection = (await api('POST', '/api/aliyun/connections', admin, { name: 'oss-cloud', defaultRegion: 'cn-beijing', ...management })).body;
  await ram.createPolicy(management, 'eat-perm-migration', 'manual test', JSON.stringify({ Version: '1', Statement: [] }));
  await api('POST', `/api/aliyun/connections/${connection.id}/refresh`);
  const permission = (await api('GET', '/api/aliyun/permissions/manage')).body.find((p: any) => p.policyName === 'eat-perm-migration');
  const grant = (await api('POST', `/api/aliyun/permissions/${permission.id}/grants`, admin, { userId: memberId })).body;
  const key = (await api('POST', `/api/aliyun/connections/${connection.id}/credentials`, member)).body;
  await api('POST', `/api/aliyun/grants/${grant.id}/revoke`, admin, { reason: 'only OSS will remain' });
  const pending = (await api('POST', '/api/oss/spaces', member, { name: 'first OSS', purpose: 'same identity', requestId: randomUUID() })).body;
  await api('POST', `/api/oss/spaces/${pending.id}/approve`);
  let unlock!: () => void, entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { unlock = resolve; });
  ram.beforeGetUser = async name => { if (name === `eat-${memberId.replaceAll('-', '')}`) { entered(); await gate; } };
  const opening = service.tick(); await ready;
  try {
    const removed = await api('DELETE', `/api/aliyun/connections/${connection.id}`, admin, { confirmName: connection.name });
    expect(removed.status).toBe(409);
    expect(removed.body.message).toContain('OSS');
    expect((await ram.keys(management, `eat-${memberId.replaceAll('-', '')}`)).map(k => k.id)).toEqual([key.accessKeyId]);
  } finally { ram.beforeGetUser = undefined; unlock(); }
  await opening;
  expect((await api('GET', `/api/oss/spaces/${pending.id}`, member)).body.status).toBe('active');
  expect((await api('DELETE', `/api/aliyun/connections/${connection.id}`, admin, { confirmName: connection.name })).body).toEqual({ ok: true });
  expect((await api('POST', '/api/oss/me/credentials', member)).body.accessKeyId).toBe(key.accessKeyId);
});

it('guards unified OSS decisions, withdrawal, resubmission and reminders, including signed Feishu card rejection', async () => {
  await approve(other);
  const pending = (await api('POST', '/api/oss/spaces', member, { name: 'pending', purpose: 'request center', requestId: randomUUID() })).body;
  const rejected = (await api('POST', '/api/oss/spaces', member, { name: 'rejected', purpose: 'resubmit', requestId: randomUUID() })).body;
  expect((await api('POST', `/api/oss/spaces/${rejected.id}/reject`, admin, { reason: '先驳回' })).status).toBe(201);
  const requests = (await api('GET', '/api/requests?scope=mine&type=oss', member)).body.items;
  const request = requests.find((r: any) => r.sourceId === pending.id);
  const previous = requests.find((r: any) => r.sourceId === rejected.id);
  const adminId = (await db.select().from(schema.users).where(eq(schema.users.email, 'admin@preview.test')))[0].id;
  const appId = 'cli_test_17', encryptKey = 'test-encrypt-key', token = 'test-verification';
  await db.insert(schema.feishuSettings).values({ appId, appSecretEncrypted: encryptSecret('fake-secret'), verificationTokenEncrypted: encryptSecret(token), encryptKeyEncrypted: encryptSecret(encryptKey) })
    .onConflictDoUpdate({ target: schema.feishuSettings.id, set: { appId, appSecretEncrypted: encryptSecret('fake-secret'), verificationTokenEncrypted: encryptSecret(token), encryptKeyEncrypted: encryptSecret(encryptKey) } });
  await db.insert(schema.feishuBindings).values({ userId: adminId, appId, openId: 'ou_test_admin' });
  await db.insert(schema.feishuCards).values({ appId, messageId: 'om_test_17', userId: adminId, requestId: request.id, state: 'pending:' });
  let unlock!: () => void, entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { unlock = resolve; });
  ram.beforeRename = async () => { entered(); await gate; };
  const migration = api('POST', '/api/admin/oss-settings/migration', admin, { confirm: true }); await ready;
  try {
    for (const [url, actor, payload] of [
      [`/api/requests/${request.id}/decision`, admin, { decision: 'approved' }],
      [`/api/requests/${request.id}/decision`, admin, { decision: 'rejected', reason: 'migration blocked' }],
      [`/api/requests/${request.id}/withdraw`, member, {}],
      [`/api/requests/${request.id}/remind`, member, {}],
      [`/api/requests/${previous.id}/resubmit`, member, { reason: 'retry migration blocked' }],
    ] as const) expect((await api('POST', url, actor, payload)).status, url).toBe(409);
    const plain = { schema: '2.0', header: { event_id: randomUUID(), event_type: 'card.action.trigger', token, app_id: appId }, event: {
      operator: { open_id: 'ou_test_admin' }, context: { open_message_id: 'om_test_17' },
      action: { tag: 'button', value: { eat: 'approval', requestId: request.id, action: 'reject' }, form_value: { reason: 'migration blocked' } },
    } };
    const iv = randomBytes(16), cipher = createCipheriv('aes-256-cbc', createHash('sha256').update(encryptKey).digest(), iv);
    const encrypted = Buffer.concat([iv, cipher.update(JSON.stringify(plain)), cipher.final()]).toString('base64');
    const body = JSON.stringify({ encrypt: encrypted }), timestamp = String(Math.floor(Date.now() / 1000)), nonce = randomUUID();
    const signature = createHash('sha256').update(timestamp + nonce + encryptKey + body).digest('hex');
    const response = await app.inject({ method: 'POST', url: '/api/feishu/callback', headers: { 'content-type': 'application/json', 'x-lark-request-timestamp': timestamp, 'x-lark-request-nonce': nonce, 'x-lark-signature': signature }, payload: body });
    expect(JSON.parse(response.body).toast).toMatchObject({ type: 'error', content: expect.stringContaining('迁移') });
    expect((await api('GET', `/api/requests/${request.id}`, member)).body.request.status).toBe('pending');
    expect((await api('GET', `/api/oss/spaces/${pending.id}`, member)).body.status).toBe('pending');
  } finally { unlock(); }
  expect((await migration).body.state).toBe('complete');
});

it('rolls back a unified OSS mutation if its global lock is lost before the source transaction commits', async () => {
  const space = (await api('POST', '/api/oss/spaces', member, { name: 'source lock', purpose: 'commit barrier', requestId: randomUUID() })).body;
  const request = (await api('GET', '/api/requests?scope=mine&type=oss', member)).body.items.find((r: any) => r.sourceId === space.id);
  const pool = app.get<Pool>(PG_POOL), blocker = await pool.connect();
  await blocker.query('BEGIN');
  await blocker.query('select id from oss_space where id=$1 for update', [space.id]);
  const withdrawing = api('POST', `/api/requests/${request.id}/withdraw`, member);
  try {
    let lockPid: number | undefined;
    await vi.waitFor(async () => {
      const locks = await pool.query("select pid from pg_locks where locktype='advisory' and granted and classid=0 and objid=1950536511");
      expect(locks.rows).toHaveLength(1); lockPid = locks.rows[0].pid;
      const waiting = await pool.query("select pid from pg_stat_activity where wait_event_type='Lock' and query like 'UPDATE oss_space%'");
      expect(waiting.rows.length).toBeGreaterThan(0);
    });
    await pool.query('select pg_terminate_backend($1)', [lockPid]);
    await new Promise(resolve => setTimeout(resolve, 30));
  } finally { await blocker.query('COMMIT'); blocker.release(); }
  expect((await withdrawing).status).toBe(409);
  expect((await api('GET', `/api/requests/${request.id}`, member)).body.request.status).toBe('pending');
  expect((await api('GET', `/api/oss/spaces/${space.id}`, member)).body.status).toBe('pending');
});
