process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://dev@127.0.0.1:5433/eat_test_10';
import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { beforeAll, beforeEach, afterAll, describe, it, expect } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { resolve } from 'node:path';
import * as bcrypt from 'bcryptjs';
import { AppModule } from '../src/app.module';
import { DB, type Db } from '../src/db/db.module';
import * as schema from '../src/db/schema';
import { RamCloud } from '../src/ram/ram-cloud';
import { TestRamCloud } from './ram-fixture';
import { decryptSecret, encryptSecret } from '../src/common/crypto';
import { eq } from 'drizzle-orm';
import {
  aliyunConnectionInfoSchema,
  aliyunPermissionsSchema,
} from '@eat/shared';

let app: NestFastifyApplication, db: Db, admin: string, member: string;
const ram = new TestRamCloud();
const credentials = {
  accessKeyId: 'management-test',
  accessKeySecret: 'management-test-secret',
};
async function api(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  token = admin,
  payload?: unknown,
) {
  const r = await app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}` },
    payload: payload as never,
  });
  return { status: r.statusCode, body: JSON.parse(r.body) };
}
beforeAll(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await pool.query(
    'drop schema public cascade; create schema public; drop schema if exists drizzle cascade;',
  );
  await migrate(drizzle(pool), { migrationsFolder: resolve('drizzle') });
  await pool.end();
  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(RamCloud)
    .useValue(ram)
    .compile();
  app = module.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter(),
  );
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  db = app.get(DB);
  const hash = await bcrypt.hash('password123', 4);
  await db.insert(schema.users).values([
    {
      name: 'Admin',
      email: 'admin@aliyun.test',
      role: 'admin',
      passwordHash: hash,
    },
    { name: 'Member', email: 'member@aliyun.test', passwordHash: hash },
  ]);
  admin = (
    await api('POST', '/api/auth/login', '', {
      email: 'admin@aliyun.test',
      password: 'password123',
    })
  ).body.token;
  member = (
    await api('POST', '/api/auth/login', '', {
      email: 'member@aliyun.test',
      password: 'password123',
    })
  ).body.token;
});
afterAll(async () => {
  await app?.close();
});
beforeEach(async () => {
  await db.delete(schema.aliyunConnections);
  await db.delete(schema.ossSettings);
  ram.reset();
});
async function create(name = 'cloud-one', keys = credentials) {
  const result = await api('POST', '/api/aliyun/connections', admin, {
    name,
    ...keys,
  });
  expect(result.status).toBe(201);
  return result.body;
}
describe('阿里云接入与策略发现', () => {
  it('管理员保存经过校验的接入，只返回管理凭证的掩码', async () => {
    expect(
      (
        await api('POST', '/api/aliyun/connections', member, {
          name: 'cloud-one',
          ...credentials,
        })
      ).status,
    ).toBe(403);
    const created = await api('POST', '/api/aliyun/connections', admin, {
      name: 'cloud-one',
      ...credentials,
    });
    expect(created.status).toBe(201);
    aliyunConnectionInfoSchema.parse(created.body);
    expect(created.body).toMatchObject({
      name: 'cloud-one',
      accountId: 'account-test',
      status: 'enabled',
      accessKeyIdMasked: '********',
      accessKeySecretMasked: '********',
    });
    const listed = await api('GET', '/api/aliyun/connections');
    expect(listed.body).toEqual([created.body]);
    expect(JSON.stringify(listed.body)).not.toContain('management-test');
    // Storage verification is deliberately limited to the security contract: both credential fields are envelope encrypted.
    const [stored] = await db.select().from(schema.aliyunConnections);
    expect(stored.accessKeyIdEncrypted).toMatch(/^v1\./);
    expect(stored.accessKeySecretEncrypted).toMatch(/^v1\./);
    expect(decryptSecret(stored.accessKeyIdEncrypted)).toBe('management-test');
    expect(decryptSecret(stored.accessKeySecretEncrypted)).toBe(
      'management-test-secret',
    );
  });
  it('发现全部分页中的 eat-perm- 自定义策略，多账号互不串数据', async () => {
    const second = {
      accessKeyId: 'second-management',
      accessKeySecret: 'second-secret',
    };
    ram.registerAccount(second, 'account-second');
    for (let i = 0; i < 105; i++)
      await ram.createPolicy(
        credentials,
        `eat-perm-${String(i).padStart(3, '0')}`,
        `说明 ${i}`,
        '{}',
      );
    await ram.createPolicy(credentials, 'eat-oss-internal', '不应出现', '{}');
    await ram.createPolicy(credentials, 'eat-perm-system', '系统策略', '{}');
    ram.policies.get('eat-perm-system')!.policyType = 'System';
    await ram.createPolicy(second, 'eat-perm-second', '第二云账号', '{}');
    const one = await create(),
      two = await create('cloud-two', second);
    const refresh = await api(
      'POST',
      `/api/aliyun/connections/${one.id}/refresh`,
    );
    expect(refresh.status).toBe(201);
    expect(refresh.body).toHaveLength(105);
    aliyunPermissionsSchema.parse(refresh.body);
    expect(refresh.body[0]).toMatchObject({
      connectionId: one.id,
      policyName: 'eat-perm-000',
      description: '说明 0',
      cloudExists: true,
      open: false,
    });
    expect(
      (await api('POST', `/api/aliyun/connections/${two.id}/refresh`)).body,
    ).toMatchObject([{ connectionId: two.id, policyName: 'eat-perm-second' }]);
    expect(
      (await api('GET', '/api/aliyun/permissions/manage')).body,
    ).toHaveLength(106);
  });
  it('无效名称、错误凭证及重复云账号被拒绝，失败不会创建接入', async () => {
    for (const name of ['Cloud', 'cloud_1', 'cloud one', ''])
      expect(
        (
          await api('POST', '/api/aliyun/connections', admin, {
            name,
            ...credentials,
          })
        ).status,
      ).toBe(400);
    const invalid = await api('POST', '/api/aliyun/connections', admin, {
      name: 'bad',
      ...credentials,
      accessKeySecret: 'not-the-secret',
    });
    expect(invalid.status).toBe(503);
    expect(JSON.stringify(invalid.body)).not.toContain('not-the-secret');
    expect((await api('GET', '/api/aliyun/status', member)).body).toEqual({
      available: false,
    });
    await create();
    const alternate = {
      accessKeyId: 'alternate-key',
      accessKeySecret: 'alternate-secret',
    };
    ram.registerAccount(alternate, 'account-test');
    expect(
      (
        await api('POST', '/api/aliyun/connections', admin, {
          name: 'other-name',
          ...alternate,
        })
      ).status,
    ).toBe(409);
    expect((await api('GET', '/api/aliyun/connections')).body).toHaveLength(1);
  });
  it('管理员可以编辑和轮换管理凭证，留空保留原值且不允许切换云账号', async () => {
    const c = await create();
    const rotated = {
      accessKeyId: 'rotated-id',
      accessKeySecret: 'rotated-secret',
    };
    ram.registerAccount(rotated, 'account-test');
    const edited = await api(
      'PATCH',
      `/api/aliyun/connections/${c.id}`,
      admin,
      { name: 'renamed-cloud', defaultRegion: 'cn-beijing', ...rotated },
    );
    expect(edited.status).toBe(200);
    expect(edited.body).toMatchObject({
      id: c.id,
      accountId: 'account-test',
      name: 'renamed-cloud',
      defaultRegion: 'cn-beijing',
    });
    expect(
      (
        await api('PATCH', `/api/aliyun/connections/${c.id}`, admin, {
          name: 'renamed-again',
          accessKeyId: '',
          accessKeySecret: '',
        })
      ).status,
    ).toBe(200);
    expect(
      (await api('POST', `/api/aliyun/connections/${c.id}/validate`)).body,
    ).toEqual({ accountId: 'account-test' });
    expect(
      (
        await api('PATCH', `/api/aliyun/connections/${c.id}`, admin, {
          name: 'same',
          accessKeyId: 'id-only',
        })
      ).status,
    ).toBe(400);
    const other = { accessKeyId: 'other-id', accessKeySecret: 'other-secret' };
    ram.registerAccount(other, 'different-account');
    expect(
      (
        await api('PATCH', `/api/aliyun/connections/${c.id}`, admin, {
          name: 'same',
          ...other,
        })
      ).status,
    ).toBe(409);
    const audits = (
      await api('GET', '/api/audit?action=aliyun.connection.update')
    ).body;
    expect(
      audits.filter((a: { targetId: string }) => a.targetId === c.id),
    ).toHaveLength(2);
    expect(JSON.stringify(audits)).not.toContain('rotated-secret');
  });
  it('暂停不阻止管理查询、校验与重复刷新，恢复和删除都有审计', async () => {
    const c = await create();
    await ram.createPolicy(credentials, 'eat-perm-read', '读取', '{}');
    expect(
      (
        await api('POST', `/api/aliyun/connections/${c.id}/status`, admin, {
          status: 'paused',
        })
      ).body.status,
    ).toBe('paused');
    expect((await api('GET', '/api/aliyun/connections')).body[0].status).toBe(
      'paused',
    );
    expect(
      (await api('GET', '/api/aliyun/status', member)).body.available,
    ).toBe(true);
    const first = (await api('POST', `/api/aliyun/connections/${c.id}/refresh`))
      .body;
    const second = (
      await api('POST', `/api/aliyun/connections/${c.id}/refresh`)
    ).body;
    expect(second[0].id).toBe(first[0].id);
    expect(
      (await api('POST', `/api/aliyun/connections/${c.id}/validate`)).status,
    ).toBe(201);
    expect(
      (
        await api('POST', `/api/aliyun/connections/${c.id}/status`, admin, {
          status: 'enabled',
        })
      ).body.status,
    ).toBe('enabled');
    for (const action of ['create', 'pause', 'resume'])
      expect(
        (
          await api('GET', `/api/audit?action=aliyun.connection.${action}`)
        ).body.some((a: { targetId: string }) => a.targetId === c.id),
      ).toBe(true);
    expect(
      (await api('DELETE', `/api/aliyun/connections/${c.id}`)).body,
    ).toEqual({ ok: true });
    expect(
      (await api('GET', '/api/aliyun/status', member)).body.available,
    ).toBe(false);
    expect((await api('GET', '/api/aliyun/permissions/manage')).body).toEqual(
      [],
    );
    expect(
      (
        await api('GET', '/api/audit?action=aliyun.connection.delete')
      ).body.some((a: { targetId: string }) => a.targetId === c.id),
    ).toBe(true);
  });
  it('普通成员的管理目录为空，不能编辑、暂停、恢复、校验、删除或刷新接入', async () => {
    const c = await create();
    expect((await api('GET', '/api/aliyun/permissions/manage', member)).body).toEqual([]);
    for (const [method, path, body] of [
      ['GET', '/connections'],
      ['PATCH', `/connections/${c.id}`, { name: 'nope' }],
      ['POST', `/connections/${c.id}/status`, { status: 'paused' }],
      ['POST', `/connections/${c.id}/status`, { status: 'enabled' }],
      ['POST', `/connections/${c.id}/validate`],
      ['POST', `/connections/${c.id}/refresh`],
      ['DELETE', `/connections/${c.id}`],
    ] as const)
      expect(
        (await api(method, `/api/aliyun${path}`, member, body)).status,
      ).toBe(403);
  });
  it('刷新同步 RAM 说明，云端删除后保留记录、关闭申请，重现后复用同一权限点', async () => {
    await ram.createPolicy(credentials, 'eat-perm-read', '旧说明', '{}');
    const c = await create();
    const original = (
      await api('POST', `/api/aliyun/connections/${c.id}/refresh`)
    ).body[0];
    ram.policies.get('eat-perm-read')!.description = '新说明';
    expect(
      (await api('POST', `/api/aliyun/connections/${c.id}/refresh`)).body[0],
    ).toMatchObject({ id: original.id, description: '新说明' });
    // Seed a previously opened permission; opening itself belongs to ticket 11.
    await db
      .update(schema.aliyunPermissions)
      .set({ open: true })
      .where(eq(schema.aliyunPermissions.id, original.id));
    await ram.deletePolicy(credentials, 'eat-perm-read');
    expect(
      (await api('POST', `/api/aliyun/connections/${c.id}/refresh`)).body[0],
    ).toMatchObject({ id: original.id, cloudExists: false, open: false });
    await ram.createPolicy(credentials, 'eat-perm-read', '重建说明', '{}');
    expect(
      (await api('POST', `/api/aliyun/connections/${c.id}/refresh`)).body[0],
    ).toMatchObject({
      id: original.id,
      description: '重建说明',
      cloudExists: true,
      open: false,
    });
  });
  it('后续分页失败不改变既有目录，重试可完成发现', async () => {
    for (let i = 0; i < 101; i++)
      await ram.createPolicy(
        credentials,
        `eat-perm-${String(i).padStart(3, '0')}`,
        '说明',
        '{}',
      );
    const c = await create();
    expect(
      (await api('POST', `/api/aliyun/connections/${c.id}/refresh`)).body,
    ).toHaveLength(101);
    ram.policies.get('eat-perm-000')!.description = '未完整读取不得同步';
    ram.failListPoliciesMarker = '100';
    expect(
      (await api('POST', `/api/aliyun/connections/${c.id}/refresh`)).status,
    ).toBe(503);
    const unchanged = (await api('GET', '/api/aliyun/permissions/manage')).body;
    expect(unchanged).toHaveLength(101);
    expect(unchanged[0]).toMatchObject({
      description: '说明',
      cloudExists: true,
    });
    ram.failListPoliciesMarker = undefined;
    expect(
      (await api('POST', `/api/aliyun/connections/${c.id}/refresh`)).body[0]
        .description,
    ).toBe('未完整读取不得同步');
  });
  it('OSS 所在的云账号在身份迁移前拒绝接入，即使 OSS 功能已关闭', async () => {
    await db
      .insert(schema.ossSettings)
      .values({
        bucket: 'oss-test',
        region: 'cn-beijing',
        accountId: 'account-test',
        status: 'disabled',
        accessKeyIdEncrypted: encryptSecret(credentials.accessKeyId),
        accessKeySecretEncrypted: encryptSecret(credentials.accessKeySecret),
      });
    const r = await api('POST', '/api/aliyun/connections', admin, {
      name: 'oss-cloud',
      ...credentials,
    });
    expect(r.status).toBe(409);
    expect(r.body.message).toContain('OSS 身份迁移');
    expect((await api('GET', '/api/aliyun/connections')).body).toHaveLength(0);
  });
  it('OSS 尚未首次启用时，也从已保存管理凭证识别云账号并拒绝提前接入', async () => {
    await db
      .insert(schema.ossSettings)
      .values({
        bucket: 'oss-test',
        region: 'cn-beijing',
        accessKeyIdEncrypted: encryptSecret(credentials.accessKeyId),
        accessKeySecretEncrypted: encryptSecret(credentials.accessKeySecret),
      });
    const r = await api('POST', '/api/aliyun/connections', admin, {
      name: 'oss-cloud',
      ...credentials,
    });
    expect(r.status).toBe(409);
    expect(r.body.message).toContain('OSS 身份迁移');
  });
  it('并发刷新超过连接池容量时仍能完成，同一权限点不会重复', async () => {
    await ram.createPolicy(credentials, 'eat-perm-read', '读取', '{}');
    const c = await create();
    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        api('POST', `/api/aliyun/connections/${c.id}/refresh`),
      ),
    );
    expect(results.every((r) => r.status === 201)).toBe(true);
    expect(new Set(results.map((r) => r.body[0].id)).size).toBe(1);
    expect(
      (await api('GET', '/api/aliyun/permissions/manage')).body,
    ).toHaveLength(1);
  });
});
