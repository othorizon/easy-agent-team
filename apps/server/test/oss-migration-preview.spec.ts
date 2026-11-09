process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://dev@127.0.0.1:5433/eat_test_16';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { beforeAll, beforeEach, afterAll, it, expect, vi } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import * as bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { AppModule } from '../src/app.module';
import { DB, PG_POOL, type Db } from '../src/db/db.module';
import * as schema from '../src/db/schema';
import { OssCloud } from '../src/oss/oss-cloud';
import { OssService } from '../src/oss/oss.service';
import { RamCloud, type RamCredentials } from '../src/ram/ram-cloud';
import { TestRamCloud } from './ram-fixture';
import { TestOssCloud } from './oss-fixture';
import { cloudIdentityComments } from '../src/cloud-identities/cloud-identities.service';

// Observe the cloud boundary, including attempted writes that leave no state change.
class PreviewRamCloud extends TestRamCloud {
  readOnly = false;
  writes: string[] = [];
  protected override async ram(c: RamCredentials, action: string, args: Record<string, any>) {
    if (!['GetUser', 'GetPolicy', 'ListPoliciesForUser', 'ListAccessKeys'].includes(action)) {
      this.writes.push(action);
      if (this.readOnly) throw new Error(`Preview attempted RAM write: ${action}`);
    }
    return super.ram(c, action, args);
  }
}
const ram = new PreviewRamCloud();
const cloud = new TestOssCloud(ram);
const management = { accessKeyId: 'management-test', accessKeySecret: 'management-test-secret' };
const path = '/api/admin/oss-settings/migration-preview';
let app: NestFastifyApplication, db: Db, service: OssService;
let admin: string, member: string, other: string, disabled: string;
let memberId: string, otherId: string, disabledId: string;
async function api(method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, token = admin, payload?: unknown) {
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
async function snapshot() {
  const pool = app.get<Pool>(PG_POOL);
  const { rows: tables } = await pool.query<{ table_name: string }>("select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name");
  const business = await Promise.all(tables.map(async ({ table_name: table }) => {
    // Authentication itself updates only this usage timestamp; it is telemetry, not migration state.
    const value = table === 'api_token' ? "to_jsonb(t) - 'last_used_at'" : 'to_jsonb(t)';
    const quoted = '"' + table.replaceAll('"', '""') + '"';
    return [table, (await pool.query(`select ${value} as row from ${quoted} t order by (${value})::text`)).rows];
  }));
  return structuredClone({ business, users: [...ram.users], policies: [...ram.policies], writes: ram.writes, objects: [...cloud.objects], bucketPolicy: cloud.policy, objectWrites: cloud.writes });
}
beforeAll(async () => {
  vi.spyOn(OssService.prototype, 'onModuleInit').mockImplementation(() => {});
  vi.spyOn(OssService.prototype, 'wake').mockImplementation(() => {});
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await pool.query('drop schema public cascade; create schema public; drop schema if exists drizzle cascade;');
  await migrate(drizzle(pool), { migrationsFolder: resolve('drizzle') });
  await pool.end();
  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(RamCloud).useValue(ram).overrideProvider(OssCloud).useValue(cloud).compile();
  app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  db = app.get(DB);
  service = app.get(OssService);
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
  ram.readOnly = false;
  await db.delete(schema.cloudIdentities);
  await db.delete(schema.ossOperations);
  await db.delete(schema.ossSpaces);
  await db.delete(schema.ossAccounts);
  await db.delete(schema.ossSettings);
  await db.update(schema.users).set({ status: 'active' });
  cloud.reset(); ram.reset(); ram.writes = [];
  expect((await api('PUT', '/api/admin/oss-settings', admin, { bucket: 'bucket-test', region: 'cn-beijing', ...management })).status).toBe(200);
  await db.update(schema.ossSettings).set({ status: 'enabled', accountId: 'account-test' });
});
afterAll(async () => { await app?.close(); vi.restoreAllMocks(); });

it('previews every legacy identity, actual Key status and future Allow/detach without any business or cloud writes', async () => {
  const a = await approve(member);
  const revoked = await approve(other);
  expect((await api('POST', `/api/oss/spaces/${revoked.id}/revoke`)).status).toBe(201);
  await service.tick();
  const retained = await approve(disabled);
  expect((await api('PATCH', `/api/users/${disabledId}`, admin, { status: 'disabled' })).status).toBe(200);
  await service.tick();
  const accounts = await db.select().from(schema.ossAccounts);
  const disabledAccount = accounts.find(a => a.userId === disabledId)!;
  // A manual Key created after legacy status sync is genuinely Active behind the old Deny.
  const manual = await ram.createKey(management, disabledAccount.ramName);
  const before = await snapshot(); ram.readOnly = true;
  const r = await api('GET', path);
  expect(r.status).toBe(200);
  expect(r.headers['cache-control']).toBe('no-store');
  expect(r.body).toMatchObject({ accountId: 'account-test', readOnly: true, canMigrate: true });
  expect(r.body.identities).toHaveLength(3);
  expect(JSON.stringify(r.body)).not.toContain('test-secret-');
  expect(JSON.stringify(r.body)).not.toContain(management.accessKeySecret);
  const active = r.body.identities.find((v: any) => v.userId === memberId);
  expect(active).toMatchObject({ oldRamName: accounts.find(a => a.userId === memberId)!.ramName, targetRamName: `eat-${memberId.replaceAll('-', '')}`, activeSpaces: [{ id: a.id, prefix: a.prefix }], aggregation: { action: 'reapply' }, conflicts: [] });
  expect(active.activeSpaces[0].actions).toContain('oss:PutObject');
  const empty = r.body.identities.find((v: any) => v.userId === otherId);
  expect(empty).toMatchObject({ activeSpaces: [], aggregation: { action: 'detach', currentAttached: true, proposedPolicyDocument: null } });
  expect(JSON.parse(empty.aggregation.currentPolicyDocument).Statement[0].Effect).toBe('Deny');
  const stopped = r.body.identities.find((v: any) => v.userId === disabledId);
  expect(stopped).toMatchObject({ userStatus: 'disabled', activeSpaces: [{ id: retained.id, prefix: retained.prefix }], securityActions: ['disable-all-keys', 'delete-login-profile'], aggregation: { action: 'reapply' } });
  expect(stopped.keys).toContainEqual({ id: manual.id, status: 'Active', managed: false });
  expect(stopped.keys).toContainEqual(expect.objectContaining({ status: 'Inactive', managed: true }));
  expect(stopped.warnings.join(' ')).toContain('Active');
  expect(JSON.parse(stopped.aggregation.currentPolicyDocument).Statement[0].Effect).toBe('Deny');
  expect(JSON.parse(stopped.aggregation.proposedPolicyDocument).Statement.every((s: any) => s.Effect === 'Allow')).toBe(true);
  expect(await snapshot()).toEqual(before);
  expect((await api('GET', path, member)).status).toBe(403);
  expect(await snapshot()).toEqual(before);
});

it.each(['控制台手建', 'EAT:another-token:member@preview.test'])('rejects an occupied target regardless of its apparent EAT prefix: %s', async (comments) => {
  await approve(member);
  await ram.createUser(management, { name: `eat-${memberId.replaceAll('-', '')}`, displayName: '占用者', comments });
  const before = await snapshot(); ram.readOnly = true;
  const r = await api('GET', path);
  expect(r.status).toBe(200);
  expect(r.body.canMigrate).toBe(false);
  expect(r.body.identities[0].conflicts).toContainEqual(expect.objectContaining({ code: 'target-user-occupied' }));
  expect(await snapshot()).toEqual(before);
});

it('rejects a replaced legacy user whose OSS ownership marker no longer matches', async () => {
  await approve(member);
  const [account] = await db.select().from(schema.ossAccounts);
  await ram.updateUser(management, account.ramName, { comments: 'EAT OSS foreign-instance foreign-user' });
  const before = await snapshot(); ram.readOnly = true;
  const r = await api('GET', path);
  expect(r.body.identities[0].conflicts).toContainEqual(expect.objectContaining({ code: 'old-user-provenance' }));
  expect(await snapshot()).toEqual(before);
});

it('checks saved cloud UserId as well as the exact identity marker, without refreshing stale display metadata', async () => {
  await approve(member);
  const [account] = await db.select().from(schema.ossAccounts);
  const identityId = randomUUID();
  const cloudUser = await ram.updateUser(management, account.ramName, { name: `eat-${memberId.replaceAll('-', '')}`, comments: cloudIdentityComments(identityId, 'old-email@example.com'), displayName: '旧姓名' });
  await db.insert(schema.cloudIdentities).values({ id: identityId, userId: memberId, accountId: 'account-test', ramName: cloudUser.name, cloudUserId: cloudUser.id });
  const before = await snapshot(); ram.readOnly = true;
  const good = await api('GET', path);
  expect(good.body.canMigrate).toBe(true);
  expect(good.body.identities[0]).toMatchObject({ identityId, cloudUserId: cloudUser.id, renameRequired: false, conflicts: [] });
  expect(await snapshot()).toEqual(before);
  ram.readOnly = false;
  await db.update(schema.cloudIdentities).set({ cloudUserId: 'replaced-cloud-user' }).where(eq(schema.cloudIdentities.id, identityId));
  const mismatch = await snapshot(); ram.readOnly = true;
  const bad = await api('GET', path);
  expect(bad.body.canMigrate).toBe(false);
  expect(bad.body.identities[0].conflicts).toContainEqual(expect.objectContaining({ code: 'identity-provenance' }));
  expect(await snapshot()).toEqual(mismatch);
});

it('reports a missing cloud identity and read errors per user without creating a replacement', async () => {
  await approve(member); await approve(other);
  const [account] = await db.select().from(schema.ossAccounts).where(eq(schema.ossAccounts.userId, memberId));
  ram.users.delete(account.ramName);
  ram.failActions.set('ListAccessKeys', 'AccessDenied');
  const before = await snapshot(); ram.readOnly = true;
  const r = await api('GET', path);
  expect(r.status).toBe(200);
  expect(r.body.identities.find((v: any) => v.userId === memberId).conflicts).toContainEqual(expect.objectContaining({ code: 'old-user-missing' }));
  expect(r.body.identities.find((v: any) => v.userId === otherId).conflicts).toContainEqual(expect.objectContaining({ code: 'cloud-read-failed' }));
  expect(await snapshot()).toEqual(before);
});

it('does not merge two real RAM identities even when the target belongs to this EAT user', async () => {
  await approve(member);
  const identityId = randomUUID();
  const target = await ram.createUser(management, { name: `eat-${memberId.replaceAll('-', '')}`, displayName: '有效空间', comments: cloudIdentityComments(identityId, 'member@preview.test') });
  await db.insert(schema.cloudIdentities).values({ id: identityId, userId: memberId, accountId: 'account-test', ramName: target.name, cloudUserId: target.id });
  const before = await snapshot(); ram.readOnly = true;
  const r = await api('GET', path);
  expect(r.body.canMigrate).toBe(false);
  expect(r.body.identities[0].targetCloudUserId).toBe(target.id);
  expect(r.body.identities[0].conflicts).toContainEqual(expect.objectContaining({ code: 'target-identity-exists' }));
  expect(await snapshot()).toEqual(before);
});

it('rejects a forged identity marker even when the persisted cloud UserId matches', async () => {
  await approve(member);
  const [account] = await db.select().from(schema.ossAccounts);
  const target = await ram.updateUser(management, account.ramName, { name: `eat-${memberId.replaceAll('-', '')}`, comments: cloudIdentityComments(randomUUID(), 'member@preview.test') });
  await db.insert(schema.cloudIdentities).values({ userId: memberId, accountId: 'account-test', ramName: target.name, cloudUserId: target.id });
  const before = await snapshot(); ram.readOnly = true;
  const r = await api('GET', path);
  expect(r.body.canMigrate).toBe(false);
  expect(r.body.identities[0].conflicts).toContainEqual(expect.objectContaining({ code: 'identity-provenance' }));
  expect(await snapshot()).toEqual(before);
});

it('reports unfinished OSS operations without resuming them; preview remains available with OSS disabled', async () => {
  const active = await approve(member);
  expect((await api('POST', '/api/oss/me/credentials/reset', member)).status).toBe(201);
  await db.update(schema.ossSettings).set({ status: 'disabled' });
  const before = await snapshot(); ram.readOnly = true;
  const r = await api('GET', path);
  expect(r.status).toBe(200);
  expect(r.body.canMigrate).toBe(false);
  expect(r.body.identities[0].activeSpaces[0].id).toBe(active.id);
  expect(r.body.identities[0].pendingOperationIds).toHaveLength(1);
  expect(r.body.identities[0].conflicts).toContainEqual(expect.objectContaining({ code: 'operations-pending' }));
  expect(await snapshot()).toEqual(before);
});
