process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://dev@127.0.0.1:5433/eat_test_13';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { beforeAll, beforeEach, afterAll, it, expect } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { resolve } from 'node:path';
import * as bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { AppModule } from '../src/app.module';
import { DB, type Db } from '../src/db/db.module';
import * as schema from '../src/db/schema';
import { RamCloud } from '../src/ram/ram-cloud';
import { TestRamCloud } from './ram-fixture';

let app: NestFastifyApplication, db: Db;
const ram = new TestRamCloud();
const keys = { accessKeyId: 'management-test', accessKeySecret: 'management-test-secret' };
const tokens: Record<string, string> = {}, ids: Record<string, string> = {};
async function api(method: 'GET'|'POST'|'PATCH'|'DELETE', url: string, actor = 'admin', payload?: unknown) {
  const r = await app.inject({ method, url, headers: { authorization: `Bearer ${tokens[actor] ?? ''}` }, payload: payload as never });
  return { status: r.statusCode, body: r.json() };
}
async function boot() {
  const module = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(RamCloud).useValue(ram).compile();
  app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  await app.init(); await app.getHttpAdapter().getInstance().ready(); db = app.get(DB);
}
beforeAll(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await pool.query('drop schema public cascade; create schema public; drop schema if exists drizzle cascade;');
  await migrate(drizzle(pool), { migrationsFolder: resolve('drizzle') }); await pool.end(); await boot();
  const hash = await bcrypt.hash('password123', 4);
  for (const actor of ['admin', 'owner', 'member', 'other']) {
    ids[actor] = (await db.insert(schema.users).values({ name: actor, email: `${actor}@requests.test`, role: actor === 'admin' ? 'admin' : 'member', passwordHash: hash }).returning())[0].id;
    tokens[actor] = (await api('POST', '/api/auth/login', '', { email: `${actor}@requests.test`, password: 'password123' })).body.token;
  }
});
afterAll(async () => { await app?.close(); });
beforeEach(async () => {
  await db.delete(schema.approvalRequests); await db.delete(schema.aliyunGrants); await db.delete(schema.cloudIdentities); await db.delete(schema.aliyunConnections);
  await db.update(schema.users).set({ status: 'active' }); ram.reset();
  for (const actor of Object.keys(ids)) tokens[actor] = (await api('POST', '/api/auth/login', '', { email: `${actor}@requests.test`, password: 'password123' })).body.token;
});
async function directory() {
  await ram.createPolicy(keys, 'eat-perm-report', '报表数据查询', '{"Version":"1","Statement":[]}');
  const connection = (await api('POST', '/api/aliyun/connections', 'admin', { name: 'analytics', ...keys })).body;
  const point = (await api('POST', `/api/aliyun/connections/${connection.id}/refresh`)).body[0];
  return { connection, point };
}
async function open(id: string, ownerId: string | null = ids.owner) {
  return api('PATCH', `/api/aliyun/permissions/${id}`, 'admin', { open: true, ownerId, purpose: '分析报表', dataScope: '业务报表数据' });
}
it('成员只见开放权限点，唯一待审批申请交给当前Owner，批准通过统一授权执行并拒绝重复申请', async () => {
  const { point } = await directory();
  expect((await api('GET', '/api/aliyun/permissions', 'member')).body).toEqual([]);
  const configured = await open(point.id);
  expect(configured.status, JSON.stringify(configured.body)).toBe(200);
  const catalog = await api('GET', '/api/aliyun/permissions', 'member');
  expect(catalog.body).toMatchObject([{ id: point.id, description: '报表数据查询', purpose: '分析报表', dataScope: '业务报表数据', ownerName: 'owner', connectionName: 'analytics', accountId: 'account-test' }]);
  const results = await Promise.all(Array.from({ length: 5 }, () => api('POST', `/api/aliyun/permissions/${point.id}/requests`, 'member', { reason: '季度统计' })));
  expect(results.filter(r => r.status === 201)).toHaveLength(1);
  expect(results.filter(r => r.status === 409)).toHaveLength(4);
  const requestId = results.find(r => r.status === 201)!.body.requestId;
  const inbox = await api('GET', '/api/requests?scope=inbox&type=aliyun', 'owner');
  expect(inbox.body.items).toMatchObject([{ id: requestId, canApprove: true, reason: '季度统计' }]);
  const approved = await api('POST', `/api/requests/${requestId}/decision`, 'owner', { decision: 'approved' });
  expect(approved.body.request, JSON.stringify(approved.body)).toMatchObject({ status: 'approved', execution: 'active', round: 1 });
  expect((await api('GET', '/api/aliyun/grants', 'member')).body.grants).toMatchObject([{ state: 'active', source: 'approval' }]);
  expect((await api('POST', `/api/aliyun/permissions/${point.id}/requests`, 'member', { reason: '重复申请' })).status).toBe(409);
});
it('Owner可管理开放、直接授予与撤销；关闭后仅管理员审批和授予，已pending和已有授权保留', async () => {
  const { point } = await directory(); await open(point.id);
  expect((await api('PATCH', `/api/aliyun/permissions/${point.id}`, 'member', { open: true, ownerId: ids.member, purpose: '', dataScope: '' })).status).toBe(403);
  const requestId = (await api('POST', `/api/aliyun/permissions/${point.id}/requests`, 'member', { reason: '现有申请' })).body.requestId;
  const g = (await api('POST', `/api/aliyun/permissions/${point.id}/grants`, 'owner', { userId: ids.other })).body;
  expect(g.state).toBe('active');
  const closed = await api('PATCH', `/api/aliyun/permissions/${point.id}`, 'owner', { open: false, ownerId: ids.owner, purpose: '报表', dataScope: '数据' });
  expect(closed.status).toBe(200);
  expect((await api('POST', `/api/aliyun/permissions/${point.id}/requests`, 'member', { reason: '已关闭' })).status).toBe(409);
  expect((await api('POST', `/api/aliyun/permissions/${point.id}/grants`, 'owner', { userId: ids.member })).status).toBe(403);
  expect((await api('POST', `/api/requests/${requestId}/decision`, 'owner', { decision: 'approved' })).status).toBe(404);
  expect((await api('GET', '/api/aliyun/grants', 'other')).body.grants).toMatchObject([{ id: g.id, state: 'active' }]);
  const approved = await api('POST', `/api/requests/${requestId}/decision`, 'admin', { decision: 'approved' });
  expect(approved.body.request).toMatchObject({ status: 'approved', execution: 'active' });
  expect((await api('PATCH', `/api/aliyun/permissions/${point.id}`, 'owner', { open: true, ownerId: ids.owner, purpose: '报表', dataScope: '数据' })).status).toBe(200);
  expect((await api('POST', `/api/aliyun/grants/${g.id}/revoke`, 'owner', { reason: '完成' })).body.state).toBe('revoked');
});
it('无Owner只由管理员审批；当前Owner变更立即改变审批资格；停用Owner明确提示并由管理员接手', async () => {
  const { point } = await directory(); await open(point.id);
  const requestId = (await api('POST', `/api/aliyun/permissions/${point.id}/requests`, 'member', { reason: '统计' })).body.requestId;
  await open(point.id, ids.other);
  expect((await api('GET', '/api/requests?scope=inbox&type=aliyun', 'owner')).body.items).toEqual([]);
  expect((await api('GET', '/api/requests?scope=inbox&type=aliyun', 'other')).body.items).toMatchObject([{ id: requestId }]);
  await api('PATCH', `/api/users/${ids.other}`, 'admin', { status: 'disabled' });
  const detail = (await api('GET', `/api/requests/${requestId}`)).body.request;
  expect(detail).toMatchObject({ canApprove: true, details: { ownerNotice: 'Owner 已停用，由管理员审批' } });
  expect((await api('POST', `/api/requests/${requestId}/decision`, 'admin', { decision: 'approved' })).body.request.execution).toBe('active');
  await open(point.id, null);
  const r = (await api('POST', `/api/aliyun/permissions/${point.id}/requests`, 'owner', { reason: '无Owner' })).body.requestId;
  expect((await api('GET', '/api/requests?scope=inbox&type=aliyun', 'owner')).body.items).toEqual([]);
  expect((await api('POST', `/api/requests/${r}/decision`, 'admin', { decision: 'rejected', reason: '范围不足' })).body.request.status).toBe('rejected');
});
it('Owner和管理员给自己申请直接grant并审计，不生成自审待办', async () => {
  const { point } = await directory(); await open(point.id);
  for (const actor of ['owner', 'admin']) {
    const self = await api('POST', `/api/aliyun/permissions/${point.id}/requests`, actor, { reason: '本人统计' });
    expect(self.body).toMatchObject({ requestId: null, grant: { source: 'self', state: 'active', userId: ids[actor] } });
    expect((await api('GET', '/api/requests?scope=mine&type=aliyun', actor)).body.items).toEqual([]);
  }
  expect((await api('GET', '/api/audit?action=aliyun.self_granted')).body).toHaveLength(2);
});
it('暂停独立阻断同意、快捷同意、新申请与授予，仍可驳回和撤销，恢复后继续同一申请', async () => {
  const { point, connection } = await directory(); await open(point.id);
  const pending = (await api('POST', `/api/aliyun/permissions/${point.id}/requests`, 'member', { reason: '待批准' })).body.requestId;
  const reject = (await api('POST', `/api/aliyun/permissions/${point.id}/requests`, 'other', { reason: '待驳回' })).body.requestId;
  const grant = (await api('POST', `/api/aliyun/permissions/${point.id}/grants`, 'admin', { userId: ids.admin })).body;
  await api('POST', `/api/aliyun/connections/${connection.id}/status`, 'admin', { status: 'paused' });
  const detail = (await api('GET', `/api/requests/${pending}`, 'owner')).body.request;
  expect(detail.canApprove).toBe(true); expect(detail.presentation.approvalBlocker).toContain('暂停');
  expect((await api('POST', `/api/requests/${pending}/decision`, 'owner', { decision: 'approved' })).status).toBe(409);
  const { createRequestActionToken } = await import('../src/requests/request-action-link');
  const token = createRequestActionToken(pending, ids.owner);
  expect((await api('POST', `/api/requests/${pending}/notification-approve`, 'owner', { token })).status).toBe(409);
  expect((await api('POST', `/api/aliyun/permissions/${point.id}/requests`, 'owner', { reason: '暂停中' })).status).toBe(409);
  expect((await api('POST', `/api/aliyun/permissions/${point.id}/grants`, 'owner', { userId: ids.owner })).status).toBe(409);
  expect((await api('POST', `/api/requests/${reject}/decision`, 'owner', { decision: 'rejected', reason: '稍后申请' })).body.request.status).toBe('rejected');
  expect((await api('POST', `/api/aliyun/grants/${grant.id}/revoke`, 'owner', {})).body.state).toBe('revoked');
  await api('POST', `/api/aliyun/connections/${connection.id}/status`, 'admin', { status: 'enabled' });
  const resumed = await api('POST', `/api/requests/${pending}/decision`, 'owner', { decision: 'approved' });
  expect(resumed.body.request).toMatchObject({ id: pending, status: 'approved', execution: 'active', round: 1 });
});
it('策略原文每次打开从RAM现取、无快照；只有当前Owner和管理员能读，普通申请人可看自身摘要', async () => {
  const { point } = await directory(); await open(point.id);
  const requestId = (await api('POST', `/api/aliyun/permissions/${point.id}/requests`, 'member', { reason: '审计' })).body.requestId;
  const own = (await api('GET', `/api/requests/${requestId}`, 'member')).body.request;
  expect(own.reason).toBe('审计'); expect(own.details.policyDocumentUrl).toBeUndefined();
  expect(JSON.stringify(own)).not.toContain('Statement');
  const detail = (await api('GET', `/api/requests/${requestId}`, 'owner')).body.request;
  expect(detail.details.policyDocumentUrl).toBe(`/api/aliyun/permissions/${point.id}/document`);
  const first = await api('GET', detail.details.policyDocumentUrl, 'owner');
  expect(first.body.document).toContain('Statement');
  ram.policies.get('eat-perm-report')!.document = '{"Version":"2","changed":"live"}';
  expect((await api('GET', detail.details.policyDocumentUrl, 'owner')).body.document).toBe('{"Version":"2","changed":"live"}');
  expect((await api('GET', detail.details.policyDocumentUrl, 'member')).status).toBe(403);
  await open(point.id, ids.other);
  expect((await api('GET', detail.details.policyDocumentUrl, 'owner')).status).toBe(403);
  expect((await api('GET', detail.details.policyDocumentUrl, 'admin')).status).toBe(200);
});
it('RAM删除策略后自动关闭并使待审批申请失效，已有授权展示云端已删除且不误标撤销', async () => {
  const { point, connection } = await directory(); await open(point.id);
  const pending = (await api('POST', `/api/aliyun/permissions/${point.id}/requests`, 'member', { reason: '删除前' })).body.requestId;
  await api('POST', `/api/aliyun/permissions/${point.id}/grants`, 'owner', { userId: ids.other });
  // External RAM deletion input: bindings and the policy disappear together.
  for (const u of ram.users.values()) u.attached.delete('eat-perm-report');
  ram.policies.delete('eat-perm-report');
  await api('POST', `/api/aliyun/connections/${connection.id}/refresh`);
  expect((await api('GET', '/api/aliyun/permissions', 'member')).body).toEqual([]);
  expect((await api('GET', `/api/requests/${pending}`, 'member')).body.request).toMatchObject({ status: 'invalid', closedReason: '权限点在云端已删除' });
  expect((await api('GET', '/api/aliyun/grants', 'other')).body.grants).toMatchObject([{ state: 'active', cloudExists: false }]);
  expect((await open(point.id)).status).toBe(409);
});
it('批准与执行失败分开，失败重试同步同一轮次；进程重启能恢复未完成执行快照', async () => {
  const { point } = await directory(); await open(point.id);
  const pending = (await api('POST', `/api/aliyun/permissions/${point.id}/requests`, 'member', { reason: '恢复测试' })).body.requestId;
  ram.failActions.set('AttachPolicyToUser', 'NETWORK_ERROR');
  const failed = await api('POST', `/api/requests/${pending}/decision`, 'owner', { decision: 'approved' });
  expect(failed.body.request).toMatchObject({ status: 'approved', execution: 'failed', round: 1 });
  const grantId = failed.body.request.details.grantId;
  ram.failActions.clear();
  expect((await api('POST', `/api/aliyun/grants/${grantId}/retry`, 'owner')).body).toMatchObject({ id: grantId, state: 'active' });
  expect((await api('GET', `/api/requests/${pending}`, 'member')).body.request).toMatchObject({ status: 'approved', execution: 'active', round: 1 });
  await db.update(schema.approvalRequests).set({ execution: 'provisioning' }).where(eq(schema.approvalRequests.id, pending));
  await app.close(); await boot();
  await expect.poll(async () => (await api('GET', `/api/requests/${pending}`, 'member')).body.request.execution).toBe('active');
  expect((await api('GET', '/api/requests?scope=mine&type=aliyun', 'member')).body.items).toHaveLength(1);
});
it('驳回与撤回可以重新提交新轮次，停用申请人不能授予且其待审批申请失效', async () => {
  const { point } = await directory(); await open(point.id);
  const pending = (await api('POST', `/api/aliyun/permissions/${point.id}/requests`, 'member', { reason: '第一轮' })).body.requestId;
  await api('POST', `/api/requests/${pending}/decision`, 'owner', { decision: 'rejected', reason: '补充范围' });
  const second = await api('POST', `/api/requests/${pending}/resubmit`, 'member', { reason: '第二轮' });
  expect(second.body.request).toMatchObject({ status: 'pending', round: 2 });
  await api('POST', `/api/requests/${second.body.request.id}/withdraw`, 'member');
  const third = await api('POST', `/api/requests/${second.body.request.id}/resubmit`, 'member', { reason: '第三轮' });
  expect(third.body.request).toMatchObject({ status: 'pending', round: 3 });
  await api('PATCH', `/api/users/${ids.member}`, 'admin', { status: 'disabled' });
  expect((await api('GET', `/api/requests/${third.body.request.id}`, 'admin')).body.request).toMatchObject({ status: 'invalid' });
  expect((await api('POST', `/api/aliyun/permissions/${point.id}/grants`, 'owner', { userId: ids.member })).status).toBe(409);
});
it('重提旧申请时申请人已成为Owner则直接授予，策略读取暂时失败不关闭目录或误判申请失效', async () => {
  const { point } = await directory(); await open(point.id);
  const pending = (await api('POST', `/api/aliyun/permissions/${point.id}/requests`, 'member', { reason: '初次申请' })).body.requestId;
  ram.failActions.set('GetPolicy', 'NETWORK_ERROR');
  const unavailable = await api('GET', `/api/aliyun/permissions/${point.id}/document`, 'owner');
  expect(unavailable.status).toBe(503);
  expect((await api('GET', `/api/requests/${pending}`, 'member')).body.request.status).toBe('pending');
  expect((await api('GET', '/api/aliyun/permissions', 'member')).body).toMatchObject([{ id: point.id, open: true, cloudExists: true }]);
  ram.failActions.clear();
  await api('POST', `/api/requests/${pending}/withdraw`, 'member');
  await open(point.id, ids.member);
  const self = await api('POST', `/api/requests/${pending}/resubmit`, 'member', { reason: '成为Owner后重提' });
  expect(self.body.request, JSON.stringify(self.body)).toMatchObject({ status: 'approved', execution: 'active', round: 2, canApprove: false });
  expect((await api('GET', '/api/requests?scope=mine&type=aliyun', 'member')).body.items.some((r: { status: string }) => r.status === 'pending')).toBe(false);
});
