process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://dev@127.0.0.1:5433/eat_test_15';
import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { beforeAll, beforeEach, afterAll, it, expect } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import * as bcrypt from 'bcryptjs';
import { AppModule } from '../src/app.module';
import { DB, type Db } from '../src/db/db.module';
import * as schema from '../src/db/schema';
import { RamCloud } from '../src/ram/ram-cloud';
import { encryptSecret } from '../src/common/crypto';
import { TestRamCloud } from './ram-fixture';
import { eq } from 'drizzle-orm';
import { CloudIdentitiesService } from '../src/cloud-identities/cloud-identities.service';

let app: NestFastifyApplication, db: Db, admin: string, member: string, userId: string;
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
  return { status: r.statusCode, body: JSON.parse(r.body), headers: r.headers };
}
async function boot() {
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
  app.get(CloudIdentitiesService).keyPropagationMs = 100;
}
beforeAll(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await pool.query(
    'drop schema public cascade; create schema public; drop schema if exists drizzle cascade;',
  );
  await migrate(drizzle(pool), { migrationsFolder: resolve('drizzle') });
  await pool.end();
  await boot();
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
  userId = (await db.select().from(schema.users).where(eq(schema.users.email, 'member@aliyun.test')))[0].id;
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
  await db.delete(schema.aliyunGrants);
  await db.delete(schema.ossSpaces);
  await db.delete(schema.ossAccounts);
  await db.delete(schema.approvalRequests);
  await db.delete(schema.cloudIdentities);
  await db.delete(schema.aliyunConnections);
  await db.update(schema.users).set({ name: 'Member', email: 'member@aliyun.test', status: 'active' }).where(eq(schema.users.id, userId));
  await db.delete(schema.userNotifications);
  await db.delete(schema.ossSettings);
  ram.reset();
  await loginMember();
});
async function create(name = 'cloud-one', keys = credentials) {
  const result = await api('POST', '/api/aliyun/connections', admin, {
    name,
    ...keys,
  });
  expect(result.status).toBe(201);
  return result.body;
}

async function directory(names = ['read', 'write'], keys = credentials, connectionName = 'cloud-one') {
  for (const name of names) await ram.createPolicy(keys, `eat-perm-${name}`, name, '{}');
  const c = await create(connectionName, keys);
  return { connection: c, permissions: (await api('POST', `/api/aliyun/connections/${c.id}/refresh`)).body };
}
const keyUrl = (id: string) => `/api/aliyun/connections/${id}/credentials`;
const cloudName = () => `eat-${userId.replaceAll('-', '')}`;
async function loginMember() {
  member = (await api('POST', '/api/auth/login', '', { email: 'member@aliyun.test', password: 'password123' })).body.token;
}
it('接入仍有未撤销授权时拒绝删除，明确解释并保留云端身份', async () => {
  const { connection, permissions } = await directory(['read']);
  const grant = (await api('POST', `/api/aliyun/permissions/${permissions[0].id}/grants`, admin, { userId })).body;
  const result = await api('DELETE', `/api/aliyun/connections/${connection.id}`, admin, { confirmName: connection.name });
  expect(result.status).toBe(409);
  expect(result.body.message).toContain('撤销');
  expect(ram.users.size).toBe(1);
  expect((await api('GET', '/api/aliyun/connections')).body).toHaveLength(1);
  expect((await api('GET', '/api/aliyun/grants', member)).body.grants[0].id).toBe(grant.id);
});
it('删除需确认接入名；清理失败保留阶段原因，重启后可重试并完成Key/绑定/用户清理', async () => {
  const { connection, permissions } = await directory(['read']);
  const grant = (await api('POST', `/api/aliyun/permissions/${permissions[0].id}/grants`, admin, { userId })).body;
  await api('POST', keyUrl(connection.id), member);
  await api('POST', `/api/aliyun/grants/${grant.id}/revoke`, admin, {});
  expect((await api('DELETE', `/api/aliyun/connections/${connection.id}`)).status).toBe(400);
  expect((await api('DELETE', `/api/aliyun/connections/${connection.id}`, admin, { confirmName: 'wrong' })).status).toBe(409);
  await ram.createKey(credentials, cloudName());
  ram.setConsoleLogin(credentials, cloudName(), true);
  await ram.createPolicy(credentials, 'eat-perm-extra-manual', '', '{}');
  await ram.attachPolicy(credentials, cloudName(), 'eat-perm-extra-manual');
  ram.failCleanup = true;
  const failed = await api('DELETE', `/api/aliyun/connections/${connection.id}`, admin, { confirmName: connection.name });
  expect(failed.body).toMatchObject({ ok: false, cleanupState: 'failed', cleanupStage: 'users' });
  expect(failed.body.cleanupError).toContain('AccessDenied');
  expect(ram.users.get(cloudName())!.keys).toEqual([]);
  expect(ram.hasConsoleLogin(credentials, cloudName())).toBe(false);
  expect([...ram.users.get(cloudName())!.attached]).toEqual([]);
  expect((await api('GET', '/api/aliyun/connections')).body[0]).toMatchObject({ cleanupState: 'failed', cleanupStage: 'users' });
  expect((await api('POST', `/api/aliyun/permissions/${permissions[0].id}/grants`, admin, { userId })).status).toBe(409);
  await app.close(); await boot();
  ram.failCleanup = false;
  expect((await api('DELETE', `/api/aliyun/connections/${connection.id}`, admin, { confirmName: connection.name })).body).toMatchObject({ ok: true });
  expect(ram.users.size).toBe(0);
  expect((await api('GET', '/api/aliyun/connections')).body).toEqual([]);
  expect(ram.policies.has('eat-perm-read')).toBe(true);
  expect((await api('GET', '/api/audit?action=aliyun.connection.delete')).body.some((a: {targetId: string}) => a.targetId === connection.id)).toBe(true);
});
it('管理核对发现缺失和多余受管绑定但不写云；显式修复恢复记录并保留无关绑定', async () => {
  const { connection, permissions } = await directory(['read', 'write', 'extra']);
  const grants = [];
  for (const p of permissions.filter((p: { policyName: string }) => p.policyName !== 'eat-perm-extra'))
    grants.push((await api('POST', `/api/aliyun/permissions/${p.id}/grants`, admin, { userId })).body);
  const cloud = ram.users.get(cloudName())!;
  await ram.detachPolicy(credentials, cloudName(), 'eat-perm-read');
  await ram.attachPolicy(credentials, cloudName(), 'eat-perm-extra');
  await ram.createPolicy(credentials, 'outside', '', '{}'); await ram.attachPolicy(credentials, cloudName(), 'outside');
  const before = [...cloud.attached].sort();
  const managed = (await api('GET', '/api/aliyun/grants/manage')).body;
  expect(managed.drift).toMatchObject([{ missing: ['eat-perm-read'], extra: ['eat-perm-extra'], error: null }]);
  expect([...cloud.attached].sort()).toEqual(before);
  const identityId = grants[0].identityId;
  expect((await api('POST', `/api/aliyun/connections/${connection.id}/identities/${identityId}/repair`, member)).status).toBe(403);
  const repaired = await api('POST', `/api/aliyun/connections/${connection.id}/identities/${identityId}/repair`);
  expect(repaired.body).toMatchObject({ ok: true, drift: { missing: [], extra: [], error: null } });
  expect([...cloud.attached].sort()).toEqual(['eat-perm-read', 'eat-perm-write', 'outside']);
  expect((await api('GET', '/api/audit?action=aliyun.drift.repair')).body.some((a: {targetId: string}) => a.targetId === identityId)).toBe(true);
});
it('撤销前现核记录额外绑定，撤销只解绑该授权；暂停仍可撤销但拒绝修复', async () => {
  const { connection, permissions } = await directory(['read', 'extra']);
  const p = permissions.find((p: {policyName: string}) => p.policyName === 'eat-perm-read');
  const grant = (await api('POST', `/api/aliyun/permissions/${p.id}/grants`, admin, { userId })).body;
  await ram.attachPolicy(credentials, cloudName(), 'eat-perm-extra');
  await api('POST', `/api/aliyun/connections/${connection.id}/status`, admin, { status: 'paused' });
  const repair = await api('POST', `/api/aliyun/connections/${connection.id}/identities/${grant.identityId}/repair`);
  expect(repair.status).toBe(409); expect(repair.body.message).toContain('暂停');
  const revoked = await api('POST', `/api/aliyun/grants/${grant.id}/revoke`, admin, {});
  expect(revoked.body.state).toBe('revoked');
  expect([...ram.users.get(cloudName())!.attached]).toEqual(['eat-perm-extra']);
  expect((await api('GET', '/api/aliyun/grants/manage')).body.drift).toMatchObject([{ missing: [], extra: ['eat-perm-extra'] }]);
});
it('绑定非受管策略时阻止用户删除且不动Key/绑定；管理员处理后可重试', async () => {
  const { connection, permissions } = await directory(['read']);
  const grant = (await api('POST', `/api/aliyun/permissions/${permissions[0].id}/grants`, admin, { userId })).body;
  await api('POST', keyUrl(connection.id), member);
  await ram.createPolicy(credentials, 'outside', '', '{}'); await ram.attachPolicy(credentials, cloudName(), 'outside');
  await api('POST', `/api/aliyun/grants/${grant.id}/revoke`, admin, {});
  const before = structuredClone(ram.users.get(cloudName()));
  const failed = await api('DELETE', `/api/aliyun/connections/${connection.id}`, admin, { confirmName: connection.name });
  expect(failed.body).toMatchObject({ ok: false, cleanupStage: 'verify' });
  expect(failed.body.cleanupError).toContain('非 EAT');
  expect(ram.users.get(cloudName())).toEqual(before);
  await ram.detachPolicy(credentials, cloudName(), 'outside');
  expect((await api('DELETE', `/api/aliyun/connections/${connection.id}`, admin, { confirmName: connection.name })).body.ok).toBe(true);
  expect(ram.policies.has('outside')).toBe(true);
});
it('来源冲突的同名RAM用户只报告错误，repair与delete均不能修改其Key或绑定', async () => {
  const { connection, permissions } = await directory(['read']);
  const grant = (await api('POST', `/api/aliyun/permissions/${permissions[0].id}/grants`, admin, { userId })).body;
  await api('POST', keyUrl(connection.id), member);
  await api('POST', `/api/aliyun/grants/${grant.id}/revoke`, admin, {});
  const cloud = ram.users.get(cloudName())!;
  cloud.userId = 'human-replacement';
  await ram.attachPolicy(credentials, cloudName(), 'eat-perm-read');
  const before = structuredClone(cloud);
  const management = (await api('GET', '/api/aliyun/grants/manage')).body;
  expect(management.drift[0].error).toContain('拒绝接管');
  const repaired = await api('POST', `/api/aliyun/connections/${connection.id}/identities/${grant.identityId}/repair`);
  expect(repaired.body.ok).toBe(false); expect(repaired.body.drift.error).toContain('拒绝接管');
  const removed = await api('DELETE', `/api/aliyun/connections/${connection.id}`, admin, { confirmName: connection.name });
  expect(removed.body.ok).toBe(false); expect(removed.body.cleanupError).toContain('拒绝接管');
  expect(cloud).toEqual(before);
});
it('删除中拒绝新申请/审批/修复与重新授予，停用仍切断Key且恢复不能重新启用', async () => {
  const { connection, permissions } = await directory(['read']);
  const p = permissions[0];
  await api('PATCH', `/api/aliyun/permissions/${p.id}`, admin, { open: true, purpose: '用途', dataScope: '范围', ownerId: null });
  const grant = (await api('POST', `/api/aliyun/permissions/${p.id}/grants`, admin, { userId })).body;
  await api('POST', keyUrl(connection.id), member);
  await api('POST', `/api/aliyun/grants/${grant.id}/revoke`, admin, {});
  const requested = await api('POST', `/api/aliyun/permissions/${p.id}/requests`, member, { reason: '下一轮' });
  expect(requested.status).toBe(201);
  const requestId = requested.body.requestId;
  ram.failActions.set('DeleteAccessKey', 'AccessDenied');
  const removed = await api('DELETE', `/api/aliyun/connections/${connection.id}`, admin, { confirmName: connection.name });
  expect(removed.body).toMatchObject({ ok: false, cleanupStage: 'keys' });
  expect(ram.users.get(cloudName())!.keys[0].status).toBe('Inactive');
  const blocked = await api('POST', `/api/requests/${requestId}/decision`, admin, { decision: 'approved' });
  expect(blocked.status).toBe(409); expect(blocked.body.message).toContain('清理');
  expect((await api('GET', `/api/requests/${requestId}`)).body.request).toMatchObject({ status: 'pending', presentation: { approvalBlocker: expect.stringContaining('清理') } });
  const newRequest = await api('POST', `/api/aliyun/permissions/${p.id}/requests`, member, { reason: '不应提交' });
  expect(newRequest.status).toBe(409); expect(newRequest.body.message).toContain('清理');
  expect((await api('POST', `/api/aliyun/permissions/${p.id}/grants`, admin, { userId })).status).toBe(409);
  expect((await api('POST', `/api/aliyun/connections/${connection.id}/identities/${grant.identityId}/repair`)).status).toBe(409);
  const manual = await ram.createKey(credentials, cloudName());
  expect((await api('PATCH', `/api/users/${userId}`, admin, { status: 'disabled' })).status).toBe(200);
  expect(ram.users.get(cloudName())!.keys.every(k => k.status === 'Inactive')).toBe(true);
  expect((await api('PATCH', `/api/users/${userId}`, admin, { status: 'active' })).status).toBe(200);
  expect(ram.users.get(cloudName())!.keys.every(k => k.status === 'Inactive')).toBe(true);
  await loginMember();
  expect((await api('POST', keyUrl(connection.id), member)).status).toBe(403);
  expect(manual.id).not.toBe('');
});
it.each(['pending', 'failed', 'revoking'] as const)('授权处于%s时仍拒绝删除且不给云端发清理操作', async state => {
  const { connection, permissions } = await directory(['read']);
  const grant = (await api('POST', `/api/aliyun/permissions/${permissions[0].id}/grants`, admin, { userId })).body;
  await db.update(schema.aliyunGrants).set({ state }).where(eq(schema.aliyunGrants.id, grant.id));
  const before = structuredClone(ram.users.get(cloudName()));
  const removed = await api('DELETE', `/api/aliyun/connections/${connection.id}`, admin, { confirmName: connection.name });
  expect(removed.status).toBe(409); expect(removed.body.message).toContain('待执行、失败和撤销中');
  expect(ram.users.get(cloudName())).toEqual(before);
});
it('先核所有目标来源：另一个用户发生冲突时第一个用户的Key也不被清理', async () => {
  const { connection, permissions } = await directory(['read']);
  const [administrator] = await db.select().from(schema.users).where(eq(schema.users.role, 'admin'));
  for (const target of [userId, administrator.id]) {
    const g = (await api('POST', `/api/aliyun/permissions/${permissions[0].id}/grants`, admin, { userId: target })).body;
    await ram.createKey(credentials, `eat-${target.replaceAll('-', '')}`);
    await api('POST', `/api/aliyun/grants/${g.id}/revoke`, admin, {});
  }
  const [first, second] = (await db.select().from(schema.cloudIdentities)).sort((a,b) => a.id.localeCompare(b.id));
  ram.users.get(second.ramName)!.comments = 'manual replacement';
  const before = structuredClone(ram.users);
  expect((await api('DELETE', `/api/aliyun/connections/${connection.id}`, admin, { confirmName: connection.name })).body.ok).toBe(false);
  expect(ram.users).toEqual(before);
  expect(ram.users.get(first.ramName)!.keys[0].status).toBe('Active');
});
it('超权限导致修复失败时显示可重试原因；非eat-perm和系统策略始终不在差异内', async () => {
  const { connection, permissions } = await directory(['read']);
  const g = (await api('POST', `/api/aliyun/permissions/${permissions[0].id}/grants`, admin, { userId })).body;
  await ram.detachPolicy(credentials, cloudName(), 'eat-perm-read');
  await ram.createPolicy(credentials, 'eat-perm-system', '', '{}');
  ram.policies.get('eat-perm-system')!.policyType = 'System';
  await ram.attachPolicy(credentials, cloudName(), 'eat-perm-system', 'System');
  ram.failActions.set('AttachPolicyToUser', 'AccessDenied');
  const failed = (await api('POST', `/api/aliyun/connections/${connection.id}/identities/${g.identityId}/repair`)).body;
  expect(failed).toMatchObject({ ok: false, drift: { missing: ['eat-perm-read'], extra: [] } });
  expect(failed.drift.repairError).toContain('AccessDenied');
  expect((await api('GET', '/api/aliyun/grants/manage')).body.drift[0].repairError).toContain('AccessDenied');
  ram.failActions.clear();
  const retry = (await api('POST', `/api/aliyun/connections/${connection.id}/identities/${g.identityId}/repair`)).body;
  expect(retry).toMatchObject({ ok: true, drift: { missing: [], extra: [] } });
  expect(ram.users.get(cloudName())!.attached.has('eat-perm-system')).toBe(true);
});
it('清理失败在持久重试时间后由新进程自动恢复，不需要再次创建身份或Key', async () => {
  const { connection, permissions } = await directory(['read']);
  const g = (await api('POST', `/api/aliyun/permissions/${permissions[0].id}/grants`, admin, { userId })).body;
  await ram.createKey(credentials, cloudName());
  await api('POST', `/api/aliyun/grants/${g.id}/revoke`, admin, {});
  ram.failCleanup = true;
  expect((await api('DELETE', `/api/aliyun/connections/${connection.id}`, admin, { confirmName: connection.name })).body.ok).toBe(false);
  await app.close();
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await pool.query("update aliyun_connection set cleanup_retry_at=now() - interval '1 second' where id=$1", [connection.id]);
  await pool.end();
  ram.failCleanup = false;
  await boot();
  await expect.poll(async () => (await api('GET', '/api/aliyun/connections')).body).toEqual([]);
  expect(ram.users.size).toBe(0);
  expect(ram.keySerial).toBe(1);
});
it('OSS仍引用的个人身份及Key保留，删除阿里云接入不改变OSS策略和可用凭证', async () => {
  const { connection, permissions } = await directory(['read']);
  const g = (await api('POST', `/api/aliyun/permissions/${permissions[0].id}/grants`, admin, { userId })).body;
  const key = (await api('POST', keyUrl(connection.id), member)).body;
  await ram.createPolicy(credentials, 'eat-oss-original', 'EAT OSS original', '{}');
  await ram.attachPolicy(credentials, cloudName(), 'eat-oss-original');
  await db.insert(schema.ossSettings).values({ bucket: 'test-bucket', region: 'oss-cn-test', accountId: 'account-test', accessKeyIdEncrypted: encryptSecret(credentials.accessKeyId), accessKeySecretEncrypted: encryptSecret(credentials.accessKeySecret) });
  await db.insert(schema.ossAccounts).values({ userId, ramName: cloudName(), policyName: 'eat-oss-original' });
  await api('POST', `/api/aliyun/grants/${g.id}/revoke`, admin, {});
  const before = structuredClone(ram.users.get(cloudName()));
  await ram.createPolicy(credentials, 'eat-perm-extra-manual', '', '{}');
  await ram.attachPolicy(credentials, cloudName(), 'eat-perm-extra-manual');
  const removed = await api('DELETE', `/api/aliyun/connections/${connection.id}`, admin, { confirmName: connection.name });
  expect(removed.body).toEqual({ ok: true });
  expect(ram.users.get(cloudName())).toEqual(before);
  expect([...ram.users.get(cloudName())!.attached]).toEqual(['eat-oss-original']);
  expect((await api('GET', '/api/audit?action=aliyun.connection.identity.retain')).body.some((a: { targetId: string; meta: { detachedPolicies: string[] } }) => a.targetId === g.identityId && a.meta.detachedPolicies.includes('eat-perm-extra-manual'))).toBe(true);
  expect(await ram.callerAccount({ accessKeyId: key.accessKeyId, accessKeySecret: key.accessKeySecret })).toBe('account-test');
  await api('PATCH', `/api/users/${userId}`, admin, { status: 'disabled' });
  expect(ram.users.get(cloudName())!.keys.every(k => k.status === 'Inactive')).toBe(true);
  await api('PATCH', `/api/users/${userId}`, admin, { status: 'active' });
  expect(await ram.callerAccount({ accessKeyId: key.accessKeyId, accessKeySecret: key.accessKeySecret })).toBe('account-test');
});
it('有效OSS空间缺少对应身份引用时明确拒删，保留云端身份与Key供管理员核对', async () => {
  const { connection, permissions } = await directory(['read']);
  const g = (await api('POST', `/api/aliyun/permissions/${permissions[0].id}/grants`, admin, { userId })).body;
  await api('POST', keyUrl(connection.id), member);
  await api('POST', `/api/aliyun/grants/${g.id}/revoke`, admin, {});
  await db.insert(schema.ossSettings).values({ bucket: 'test-bucket', region: 'oss-cn-test', accountId: 'account-test', accessKeyIdEncrypted: encryptSecret(credentials.accessKeyId), accessKeySecretEncrypted: encryptSecret(credentials.accessKeySecret) });
  await db.insert(schema.ossSpaces).values({ ownerId: userId, requestId: randomUUID(), name: 'still-used', purpose: '测试引用', prefix: 'test-space/', status: 'active' });
  const before = structuredClone(ram.users.get(cloudName()));
  const removed = await api('DELETE', `/api/aliyun/connections/${connection.id}`, admin, { confirmName: connection.name });
  expect(removed.status).toBe(409); expect(removed.body.message).toContain('引用缺失');
  expect(ram.users.get(cloudName())).toEqual(before);
});
it('创建响应丢失后撤销可恢复来源UserId，删除不必重新授予或创建身份', async () => {
  const { connection, permissions } = await directory(['read']);
  ram.lostUserResponse = true;
  const g = (await api('POST', `/api/aliyun/permissions/${permissions[0].id}/grants`, admin, { userId })).body;
  expect(g.state).toBe('failed'); expect(ram.users.size).toBe(1);
  expect((await api('POST', `/api/aliyun/grants/${g.id}/revoke`, admin, {})).body.state).toBe('revoked');
  expect((await api('DELETE', `/api/aliyun/connections/${connection.id}`, admin, { confirmName: connection.name })).body).toEqual({ ok: true });
  expect(ram.users.size).toBe(0);
});
it('云端用户消失的漂移修复显示来源缺失并不创建替代用户', async () => {
  const { connection, permissions } = await directory(['read']);
  const g = (await api('POST', `/api/aliyun/permissions/${permissions[0].id}/grants`, admin, { userId })).body;
  await ram.detachPolicy(credentials, cloudName(), 'eat-perm-read');
  await ram.deleteUser(credentials, cloudName());
  const repaired = (await api('POST', `/api/aliyun/connections/${connection.id}/identities/${g.identityId}/repair`)).body;
  expect(repaired.ok).toBe(false); expect(repaired.drift.repairError).toContain('来源记录不完整');
  expect(ram.users.size).toBe(0);
});
