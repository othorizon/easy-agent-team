process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://dev:dev@127.0.0.1:5433/eat_test';
import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import {
  beforeAll,
  beforeEach,
  afterAll,
  describe,
  it,
  expect,
  vi,
} from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import * as bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { AppModule } from '../src/app.module';
import * as schema from '../src/db/schema';
import { DB, type Db } from '../src/db/db.module';
import { OssCloud } from '../src/oss/oss-cloud';
import { OssService } from '../src/oss/oss.service';
import { OssToolsService } from '../src/oss/oss-tools.service';
import { TestOssCloud } from './oss-fixture';
import { decryptSecret, encryptSecret } from '../src/common/crypto';

let app: NestFastifyApplication,
  db: Db,
  service: OssService,
  admin: string,
  member: string,
  other: string,
  memberId: string;
const cloud = new TestOssCloud();
const settings = {
  bucket: 'bucket-test',
  region: 'cn-beijing',
  accessKeyId: 'management-test',
  accessKeySecret: 'management-test-secret',
  customDomainsEnabled: true,
  domains: [
    { domain: 'assets.example.com', cdn: false },
    { domain: 'cdn.example.com', cdn: true },
  ],
};
async function api(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH',
  url: string,
  token = member,
  payload?: unknown,
) {
  const r = await app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}` },
    payload: payload as never,
  });
  return { status: r.statusCode, body: JSON.parse(r.body), headers: r.headers };
}
async function space(name = '测试空间') {
  const r = await api('POST', '/api/oss/spaces', member, {
    name,
    purpose: '独立测试',
    requestId: randomUUID(),
  });
  expect(r.status).toBe(201);
  return r.body;
}
async function approve(id: string) {
  expect(
    (await api('POST', `/api/oss/spaces/${id}/approve`, admin)).status,
  ).toBe(201);
  await service.tick();
  return (await api('GET', `/api/oss/spaces/${id}`)).body;
}
async function retryNow() {
  await db.update(schema.ossOperations).set({ retryAt: null });
  await service.tick();
}
beforeAll(async () => {
  vi.spyOn(OssService.prototype, 'onModuleInit').mockImplementation(() => {});
  vi.spyOn(OssService.prototype, 'wake').mockImplementation(() => {});
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await pool.query(
    'drop schema public cascade; create schema public; drop schema if exists drizzle cascade;',
  );
  await migrate(drizzle(pool), { migrationsFolder: resolve('drizzle') });
  await pool.end();
  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(OssCloud)
    .useValue(cloud)
    .compile();
  app = module.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter(),
  );
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  db = app.get(DB);
  service = app.get(OssService);
});
beforeEach(async () => {
  await db.delete(schema.ossOperations);
  await db.delete(schema.ossSpaces);
  await db.delete(schema.ossAccounts);
  await db.delete(schema.ossSettings);
  cloud.reset();
  if (!admin) {
    const hash = await bcrypt.hash('password123', 4);
    await db.insert(schema.users).values([
      {
        name: 'Admin',
        email: 'admin@oss.test',
        passwordHash: hash,
        role: 'admin',
      },
      { name: 'Member', email: 'member@oss.test', passwordHash: hash },
      { name: 'Other', email: 'other@oss.test', passwordHash: hash },
    ]);
    const login = async (email: string) =>
      (
        await api('POST', '/api/auth/login', '', {
          email,
          password: 'password123',
        })
      ).body;
    admin = (await login('admin@oss.test')).token;
    const m = await login('member@oss.test');
    member = m.token;
    memberId = m.user.id;
    other = (await login('other@oss.test')).token;
  }
  await db
    .update(schema.users)
    .set({ status: 'active' })
    .where(eq(schema.users.id, memberId));
  expect(
    (await api('PUT', '/api/admin/oss-settings', admin, settings)).status,
  ).toBe(200);
  await db
    .update(schema.ossSettings)
    .set({ status: 'enabled', accountId: 'account-test' });
});
afterAll(async () => {
  await app?.close();
  vi.restoreAllMocks();
});

describe('OSS resources', () => {
  it('requires admin approval; scopes one account to multiple spaces and protects credentials', async () => {
    const dto = { name: '幂等申请', purpose: '说明', requestId: randomUUID() };
    const a = (await api('POST', '/api/oss/spaces', member, dto)).body;
    expect((await api('POST', '/api/oss/spaces', member, dto)).body.id).toBe(
      a.id,
    );
    expect(cloud.ramUsers.size).toBe(0);
    expect(
      (await api('POST', `/api/oss/spaces/${a.id}/approve`, member)).status,
    ).toBe(403);
    expect((await api('GET', `/api/oss/spaces/${a.id}`, other)).status).toBe(
      403,
    );
    expect((await api('POST', '/api/oss/me/credentials')).status).toBe(409);
    const ready = await approve(a.id);
    expect(ready.status).toBe('active');
    expect(ready.publicRead).toBe(false);
    const b = await space('第二空间');
    await approve(b.id);
    expect(cloud.ramUsers.size).toBe(1);
    const credentials = await api('POST', '/api/oss/me/credentials');
    expect(credentials.status).toBe(201);
    expect(credentials.headers['cache-control']).toBe('no-store');
    expect(credentials.body.prefixes).toHaveLength(2);
    const c = { ...credentials.body };
    await cloud.put(c, `${a.prefix}mine.txt`, Buffer.from('a'));
    await cloud.put(c, `${b.prefix}mine.txt`, Buffer.from('b'));
    await expect(
      cloud.put(c, 'existing/foreign.txt', Buffer.from('bad')),
    ).rejects.toThrow('AccessDenied');
    await expect(cloud.list(c, '')).rejects.toThrow('AccessDenied');
    expect((await api('POST', '/api/oss/me/credentials', admin)).status).toBe(
      409,
    );
    expect(ready.addresses).toHaveLength(3);
    expect(ready.addresses[2].cdn).toBe(true);
    const rows = await db.select().from(schema.ossAccounts);
    expect(rows[0].keySecretEncrypted).not.toContain(
      credentials.body.accessKeySecret,
    );
    const list = await api('GET', '/api/oss/spaces');
    expect(JSON.stringify(list.body)).not.toContain(
      credentials.body.accessKeySecret,
    );
    const mcp = app.get(OssToolsService);
    expect(
      await mcp.call(
        {
          id: memberId,
          name: 'Member',
          email: 'member@oss.test',
          role: 'member',
          tokenId: 'test',
        },
        'get_oss_space',
        { space: a.id },
      ),
    ).toMatchObject({ id: a.id });
  });
  it('recovers a lost key creation response without accumulating keys', async () => {
    const a = await space();
    cloud.lostKeyResponse = true;
    expect((await approve(a.id)).status).toBe('failed');
    expect([...cloud.ramUsers.values()][0].keys).toHaveLength(1);
    await retryNow();
    expect((await api('GET', `/api/oss/spaces/${a.id}`)).body.status).toBe(
      'active',
    );
    expect([...cloud.ramUsers.values()][0].keys).toHaveLength(1);
    expect(cloud.keySerial).toBe(2);
  });
  it('preserves foreign policy and object ACL; recovers policy response loss and reclaims without deleting data', async () => {
    const a = await space();
    await approve(a.id);
    const b = await space();
    await approve(b.id);
    const c = (await api('POST', '/api/oss/me/credentials')).body;
    cloud.objects.set('existing/keep.txt', Buffer.from('untouched'));
    await cloud.put(c, `${a.prefix}keep.txt`, Buffer.from('keep'));
    await cloud.objectAcl(c, `${a.prefix}keep.txt`, 'public-read');
    const foreign = {
      Effect: 'Allow',
      Principal: ['other'],
      Action: ['oss:GetObject'],
      Resource: ['acs:oss:*:*:bucket-test/existing/*'],
    };
    cloud.policy = { Version: '1', Statement: [foreign] };
    cloud.lostPolicyResponse = true;
    expect(
      (
        await api('PUT', `/api/oss/spaces/${a.id}/public-read`, member, {
          enabled: true,
        })
      ).status,
    ).toBe(200);
    await service.tick();
    await retryNow();
    expect(
      (await api('GET', `/api/oss/spaces/${a.id}`)).body.publicPrefixes,
    ).toEqual([a.prefix]);
    await api('PUT', `/api/oss/spaces/${a.id}/public-read`, member, {
      enabled: false,
    });
    await service.tick();
    expect(cloud.policy!.Statement).toEqual([foreign]);
    expect(cloud.acls.get(`${a.prefix}keep.txt`)).toBe('public-read');
    await api('POST', `/api/oss/spaces/${a.id}/revoke`, admin);
    await service.tick();
    expect((await api('GET', `/api/oss/spaces/${a.id}`)).body.status).toBe(
      'revoked',
    );
    expect(cloud.objects.get(`${a.prefix}keep.txt`)?.toString()).toBe('keep');
    expect(cloud.objects.get('existing/keep.txt')?.toString()).toBe(
      'untouched',
    );
    await expect(
      cloud.put(c, `${a.prefix}new.txt`, Buffer.from('bad')),
    ).rejects.toThrow('AccessDenied');
    await cloud.put(c, `${b.prefix}still.txt`, Buffer.from('ok'));
  });
  it('blocks credential reads during rotation, retires old keys and syncs disabled users even when feature is disabled', async () => {
    const a = await space();
    await approve(a.id);
    const old = (await api('POST', '/api/oss/me/credentials')).body;
    const op = await api('POST', '/api/oss/me/credentials/reset');
    expect((await api('POST', '/api/oss/me/credentials')).status).toBe(409);
    cloud.failKeyStatus = true;
    await service.tick();
    expect((await api('POST', '/api/oss/me/credentials')).status).toBe(409);
    cloud.failKeyStatus = false;
    await retryNow();
    const current = (await api('POST', '/api/oss/me/credentials')).body;
    expect(current.accessKeyId).not.toBe(old.accessKeyId);
    expect(
      (await api('GET', `/api/oss/operations/${op.body.id}`, other)).status,
    ).toBe(403);
    expect([...cloud.ramUsers.values()][0].keys).toHaveLength(1);
    await api('POST', '/api/admin/oss-settings/disable', admin);
    await db
      .update(schema.users)
      .set({ status: 'disabled' })
      .where(eq(schema.users.id, memberId));
    await service.onUserStatusChanged(memberId);
    await service.tick();
    expect([...cloud.ramUsers.values()][0].keys[0].status).toBe('Inactive');
    expect([...cloud.ramUsers.values()][0].policy?.Statement[0].Effect).toBe(
      'Deny',
    );
    await db
      .update(schema.users)
      .set({ status: 'active' })
      .where(eq(schema.users.id, memberId));
    await service.onUserStatusChanged(memberId);
    await service.tick();
    expect([...cloud.ramUsers.values()][0].keys[0].status).toBe('Active');
    expect((await api('POST', '/api/oss/me/credentials')).status).toBe(503);
    await api('POST', `/api/oss/spaces/${a.id}/revoke`, admin);
    await service.tick();
    expect((await api('GET', `/api/oss/spaces/${a.id}`)).body.status).toBe(
      'revoked',
    );
  });
  it('does not issue a new key when its owner is disabled after queueing a reset', async () => {
    const a = await space();
    await approve(a.id);
    await api('POST', '/api/oss/me/credentials/reset');
    const created = cloud.keySerial;
    await db
      .update(schema.users)
      .set({ status: 'disabled' })
      .where(eq(schema.users.id, memberId));
    await service.onUserStatusChanged(memberId);
    await service.tick();
    expect(cloud.keySerial).toBe(created);
    expect(
      [...cloud.ramUsers.values()][0].keys.every(
        (k) => k.status === 'Inactive',
      ),
    ).toBe(true);
    expect([...cloud.ramUsers.values()][0].policy?.Statement[0].Effect).toBe(
      'Deny',
    );
  });
  it('does not let paused or backed-off jobs starve a revocation while disabled', async () => {
    const a = await space();
    await approve(a.id);
    await db.insert(schema.ossOperations).values(
      Array.from({ length: 35 }, () => ({
        kind: 'public' as const,
        actorId: memberId,
        userId: memberId,
        state: 'failed' as const,
        retryAt: new Date(Date.now() + 3600_000),
      })),
    );
    await api('POST', '/api/admin/oss-settings/disable', admin);
    await api('POST', `/api/oss/spaces/${a.id}/revoke`, admin);
    await service.tick();
    expect((await api('GET', `/api/oss/spaces/${a.id}`)).body.status).toBe(
      'revoked',
    );
  });
  it('checks real operations before enabling and cleans only its own probe resources', async () => {
    await api('POST', '/api/admin/oss-settings/disable', admin);
    cloud.objects.set('existing/important.txt', Buffer.from('safe'));
    await api('POST', '/api/admin/oss-settings/enable', admin);
    await service.tick();
    const info = (await api('GET', '/api/admin/oss-settings', admin)).body;
    expect(info.lastError).toBeNull();
    expect(info.status).toBe('enabled');
    expect(
      info.checks.every((c: { status: string }) => c.status === 'passed'),
    ).toBe(true);
    expect([...cloud.objects.keys()]).toEqual(['existing/important.txt']);
    expect(cloud.ramUsers.size).toBe(0);
    expect(cloud.policy).toBeNull();
  });
  it('keeps failed cleanup recoverable and never silently enables', async () => {
    await api('POST', '/api/admin/oss-settings/disable', admin);
    cloud.failCleanup = true;
    await api('POST', '/api/admin/oss-settings/enable', admin);
    await service.tick();
    expect(
      (await api('GET', '/api/admin/oss-settings', admin)).body.status,
    ).toBe('failed');
    expect(
      (
        await api('PUT', '/api/admin/oss-settings', admin, {
          ...settings,
          accessKeySecret: 'repaired-secret',
        })
      ).status,
    ).toBe(200);
    cloud.failCleanup = false;
    await api('POST', '/api/admin/oss-settings/enable', admin);
    await service.tick();
    expect(cloud.ramUsers.size).toBe(0);
    expect(
      (await api('GET', '/api/admin/oss-settings', admin)).body.status,
    ).toBe('failed');
    await api('POST', '/api/admin/oss-settings/enable', admin);
    await service.tick();
    expect(
      (await api('GET', '/api/admin/oss-settings', admin)).body.status,
    ).toBe('enabled');
  });
});
