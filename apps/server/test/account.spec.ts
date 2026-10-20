process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://dev@127.0.0.1:5433/eat_test';

import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcryptjs';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi, type MockInstance } from 'vitest';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { UserNotificationsService } from '../src/notify/user-notifications.service';
import { encryptSecret } from '../src/common/crypto';
import * as schema from '../src/db/schema';

let app: NestFastifyApplication;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool, { schema });
const ids = { admin: randomUUID(), member: randomUUID(), other: randomUUID() };
const tokens: Record<string, string> = {};
const url = 'https://open.feishu.cn/open-apis/bot/v2/hook/account-test';
const replacement = `${url}-replacement`;
const hits: { url: string; body: Record<string, any> }[] = [];
let responseMode: 'ok' | 'error' | 'malformed' = 'ok';
let fetchSpy: MockInstance<typeof fetch>;

async function api(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, token?: string, payload?: unknown) {
  const r = await app.inject({ method, url: path, headers: token ? { authorization: `Bearer ${token}` } : {}, payload: payload as never });
  return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
}
const login = (email: string, password = 'password123') => api('POST', '/api/auth/login', undefined, { email, password });
const settings = (requireBio: boolean, requireNotification: boolean) => api('PUT', '/api/admin/registration-settings', tokens.admin, {
  enabled: true, allowedEmailSuffixes: [], requireBio, requireNotification,
});
async function readyToSend(userId = ids.member) {
  await db.update(schema.userNotifications).set({ sentAt: new Date(0) }).where(eq(schema.userNotifications.userId, userId));
}
async function send(token = tokens.member, webhookUrl = url, extra = {}) {
  const r = await api('POST', '/api/account/notification/code', token, { webhookUrl, ...extra });
  expect(r.status).toBe(201);
  const code = JSON.stringify(hits.at(-1)!.body).match(/EAT 验证码：(\d{6})/)![1];
  expect(JSON.stringify(r.body)).not.toContain(code);
  return { challengeId: r.body.challengeId as string, code };
}

beforeAll(async () => {
  await pool.query('drop schema public cascade; create schema public; drop schema if exists drizzle cascade;');
  // 先部署旧结构并写入真实旧资料，再执行新迁移，覆盖升级路径而非只测全新数据库。
  const oldFolder = await mkdtemp(join(tmpdir(), 'eat-account-migration-'));
  try {
    await cp(resolve('drizzle'), oldFolder, { recursive: true });
    const journal = JSON.parse(await readFile(join(oldFolder, 'meta/_journal.json'), 'utf8'));
    journal.entries = journal.entries.filter((e: { idx: number }) => e.idx < 28);
    await writeFile(join(oldFolder, 'meta/_journal.json'), JSON.stringify(journal));
    await migrate(drizzle(pool), { migrationsFolder: oldFolder });
    const hash = await bcrypt.hash('password123', 4);
    for (const [name, id] of Object.entries(ids)) {
      await pool.query('insert into "user" (id,name,email,role,password_hash) values ($1,$2,$3,$4,$5)',
        [id, name, `${name}@account.test`, name === 'admin' ? 'admin' : 'member', hash]);
    }
    await pool.query('insert into helper_profile (user_id,description,webhook_url,webhook_secret_encrypted,available,notify_reply) values ($1,$2,$3,$4,false,false)',
      [ids.member, '旧能力：擅长支付对账', url, encryptSecret('old-signing-secret')]);
    await migrate(drizzle(pool), { migrationsFolder: resolve('drizzle') });
  } finally { await rm(oldFolder, { recursive: true, force: true }); }
  const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  await app.init(); await app.getHttpAdapter().getInstance().ready();
  for (const name of Object.keys(ids)) tokens[name] = (await login(`${name}@account.test`)).body.token;
  const originalFetch = globalThis.fetch;
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    if (!String(input).startsWith('https://open.feishu.cn/')) return originalFetch(input, init);
    hits.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    expect(init?.redirect).toBe('error');
    return new Response(JSON.stringify(responseMode === 'ok' ? { code: 0 } : responseMode === 'error' ? { code: 19021 } : {}), { status: 200 });
  });
});
afterAll(async () => { fetchSpy?.mockRestore(); await app?.close(); await pool.end(); });

describe('用户中心与升级迁移', () => {
  it('旧能力、勿扰和通知偏好迁移；旧地址不能直接成为已验证配置', async () => {
    const r = await api('GET', '/api/account', tokens.member);
    expect(r.body).toMatchObject({ bio: '旧能力：擅长支付对账', allowHelp: false,
      notification: { webhookUrl: url, verified: false, hasWebhookSecret: true, notifyReply: false } });
    expect(r.body.passwordHash).toBeUndefined();
    expect(JSON.stringify(r.body)).not.toContain('old-signing-secret');
    expect(await app.get(UserNotificationsService).webhookOf(ids.member, 'help')).toBeNull();
  });
  it('简介和姓名更新立即用于 AI 候选名单；勿扰生效；旧接口无法绕过验证', async () => {
    expect((await api('PATCH', '/api/account', tokens.member, { name: '新姓名', bio: ' 数据分析与财务对账 ', allowHelp: true })).status).toBe(200);
    const targets = await api('GET', '/api/helpers', tokens.other);
    expect(targets.body.helpers).toEqual([expect.objectContaining({ userId: ids.member, name: '新姓名', description: '数据分析与财务对账', hasWebhook: false })]);
    expect((await api('PUT', '/api/helpers/me', tokens.member, { webhookUrl: url })).status).toBe(400);
    expect((await api('PATCH', '/api/account', tokens.member, { name: '   ' })).status).toBe(400);
    await api('PATCH', '/api/account', tokens.member, { allowHelp: false });
    expect((await api('GET', '/api/helpers', tokens.other)).body.helpers).toEqual([]);
    await api('PATCH', '/api/account', tokens.member, { allowHelp: true });
  });
  it('管理员可改本人及其他用户简介；成员无权代改', async () => {
    expect((await api('PATCH', `/api/users/${ids.member}/bio`, tokens.other, { bio: '越权' })).status).toBe(403);
    expect((await api('PATCH', `/api/users/${ids.member}/bio`, tokens.admin, { bio: '管理员更新简介' })).status).toBe(200);
    expect((await api('PATCH', `/api/users/${ids.admin}/bio`, tokens.admin, { bio: '管理员本人简介' })).status).toBe(200);
    expect((await api('GET', '/api/account', tokens.member)).body.bio).toBe('管理员更新简介');
  });
});

describe('飞书验证码', () => {
  it('拒绝非飞书地址、重定向型地址与非法协议，不发出请求', async () => {
    const count = hits.length;
    for (const webhookUrl of ['http://127.0.0.1/hook', 'https://open.feishu.cn.evil.test/open-apis/bot/v2/hook/x',
      `${url}?redirect=http://localhost`, 'http://open.feishu.cn/open-apis/bot/v2/hook/x', 'https://open.feishu.cn@localhost/hook']) {
      expect((await api('POST', '/api/account/notification/code', tokens.member, { webhookUrl })).status).toBe(400);
    }
    expect(hits).toHaveLength(count);
  });
  it('验证绑定用户；错误次数持久化；成功后单次使用且恢复旧加签密钥', async () => {
    const challenge = await send();
    expect(hits.at(-1)!.body.sign).toBeTruthy();
    expect((await api('POST', '/api/account/notification/verify', tokens.other, challenge)).status).toBe(400);
    const wrong = challenge.code === '000000' ? '111111' : '000000';
    expect((await api('POST', '/api/account/notification/verify', tokens.member, { ...challenge, code: wrong })).status).toBe(400);
    expect((await db.select().from(schema.userNotifications).where(eq(schema.userNotifications.userId, ids.member)))[0].attempts).toBe(1);
    const verified = await api('POST', '/api/account/notification/verify', tokens.member, challenge);
    expect(verified.body.verified).toBe(true);
    expect((await api('POST', '/api/account/notification/verify', tokens.member, challenge)).status).toBe(400);
    expect(await app.get(UserNotificationsService).webhookOf(ids.member, 'help')).toEqual({ url, secret: 'old-signing-secret' });
  });
  it('更换配置期间保留旧配置；五次错误后失效；重新发送会使旧验证码失效', async () => {
    await readyToSend();
    const old = await send(tokens.member, replacement, { webhookSecret: 'replacement-secret' });
    expect((await api('POST', '/api/account/notification/code', tokens.member, { webhookUrl: replacement })).status).toBe(400);
    for (let i = 0; i < 5; i++) {
      expect((await api('POST', '/api/account/notification/verify', tokens.member, { ...old, code: '000000' })).status).toBe(400);
    }
    expect((await api('POST', '/api/account/notification/verify', tokens.member, old)).status).toBe(400);
    expect((await api('GET', '/api/account', tokens.member)).body.notification.webhookUrl).toBe(url);
    await readyToSend();
    const fresh = await send(tokens.member, replacement, { webhookSecret: 'replacement-secret' });
    expect((await api('POST', '/api/account/notification/verify', tokens.member, old)).status).toBe(400);
    expect((await api('POST', '/api/account/notification/verify', tokens.member, fresh)).body.verified).toBe(true);
    expect(await app.get(UserNotificationsService).webhookOf(ids.member, 'help')).toEqual({ url: replacement, secret: 'replacement-secret' });
    await readyToSend();
    const unsigned = await send(tokens.member, replacement, { webhookSecret: '' });
    expect(hits.at(-1)!.body.sign).toBeUndefined();
    expect(await app.get(UserNotificationsService).webhookOf(ids.member, 'help')).toEqual({ url: replacement, secret: 'replacement-secret' });
    await api('POST', '/api/account/notification/verify', tokens.member, unsigned);
    expect(await app.get(UserNotificationsService).webhookOf(ids.member, 'help')).toEqual({ url: replacement, secret: null });
  });
  it('过期、发送失败和无效飞书响应不能通过；并发发送只允许一次', async () => {
    await readyToSend();
    const challenge = await send(tokens.member, replacement);
    await db.update(schema.userNotifications).set({ expiresAt: new Date(0) }).where(eq(schema.userNotifications.userId, ids.member));
    expect((await api('POST', '/api/account/notification/verify', tokens.member, challenge)).status).toBe(400);
    for (const mode of ['error', 'malformed'] as const) {
      responseMode = mode; await readyToSend();
      expect((await api('POST', '/api/account/notification/code', tokens.member, { webhookUrl: url })).status).toBe(400);
      expect((await api('GET', '/api/account', tokens.member)).body.notification).toMatchObject({ webhookUrl: replacement, verified: true });
    }
    responseMode = 'ok'; await readyToSend();
    const results = await Promise.all([1, 2].map(() => api('POST', '/api/account/notification/code', tokens.member, { webhookUrl: url })));
    expect(results.map((r) => r.status).sort()).toEqual([201, 400]);
  });
  it('通知偏好控制对应事件，移除会废弃待验证验证码', async () => {
    await api('PUT', '/api/account/notification/preferences', tokens.member, { notifyHelp: false, notifyReply: true, notifyMention: false });
    const notifications = app.get(UserNotificationsService);
    expect(await notifications.webhookOf(ids.member, 'help')).toBeNull();
    expect(await notifications.webhookOf(ids.member, 'mention')).toBeNull();
    expect(await notifications.webhookOf(ids.member, 'reply')).not.toBeNull();
    await readyToSend(); const challenge = await send();
    await api('DELETE', '/api/account/notification', tokens.member);
    expect((await api('POST', '/api/account/notification/verify', tokens.member, challenge)).status).toBe(400);
    expect(await notifications.webhookOf(ids.member, 'reply')).toBeNull();
  });
});

describe('强制补全只约束普通用户网站访问', () => {
  it('两个开关独立；新老用户均受限制，注册和补全接口保持可用', async () => {
    await settings(true, false);
    expect((await api('GET', '/api/users', tokens.other)).body.error).toBe('PROFILE_INCOMPLETE');
    expect((await api('GET', '/api/users', tokens.member)).status).toBe(200);
    const registered = await api('POST', '/api/auth/register', undefined, { name: '新用户', email: 'new@account.test', password: 'password123' });
    expect(registered.status).toBe(201);
    expect((await api('GET', '/api/users', registered.body.token)).body.error).toBe('PROFILE_INCOMPLETE');
    expect((await api('PATCH', '/api/account', registered.body.token, { bio: '新用户简介' })).status).toBe(200);
    expect((await api('GET', '/api/users', registered.body.token)).status).toBe(200);
    await settings(false, true);
    expect((await api('GET', '/api/account/onboarding', tokens.other)).body).toMatchObject({ requireBio: false, requireNotification: true, required: true });
    expect((await api('GET', '/api/users', tokens.member)).status).toBe(403);
    await readyToSend(); const challenge = await send();
    await api('POST', '/api/account/notification/verify', tokens.member, challenge);
    expect((await api('GET', '/api/users', tokens.member)).status).toBe(200);
    await settings(true, true);
    await api('PATCH', '/api/account', tokens.member, { bio: '   ' });
    expect((await api('GET', '/api/users', tokens.member)).status).toBe(403);
    await api('PATCH', `/api/users/${ids.member}/bio`, tokens.admin, { bio: '补齐简介' });
    expect((await api('GET', '/api/users', tokens.member)).status).toBe(200);
    await api('DELETE', '/api/account/notification', tokens.member);
    expect((await api('GET', '/api/users', tokens.member)).status).toBe(403);
  });
  it('管理员、CLI、API Key 和直接 MCP 认证不受限制，设备授权可继续', async () => {
    expect((await api('GET', '/api/users', tokens.admin)).status).toBe(200);
    expect((await api('GET', '/api/account/onboarding', tokens.admin)).body.required).toBe(false);
    const auth = app.get(AuthService);
    for (const kind of ['cli', 'apikey'] as const) {
      const { token } = await auth.issueToken(ids.other, 'test exempt', kind);
      expect((await api('GET', '/api/users', token)).status).toBe(200);
      expect(await auth.authenticate(token)).not.toBeNull();
      const mcp = await app.inject({
        method: 'POST', url: '/mcp',
        headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream' },
        payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_helpers', arguments: {} } },
      });
      expect(mcp.statusCode).toBe(200);
      expect(mcp.json().result.isError).not.toBe(true);
    }
    const start = await api('POST', '/api/auth/device/start');
    expect((await api('POST', '/api/auth/device/approve', tokens.other, { userCode: start.body.userCode })).status).toBe(201);
    const who = await api('GET', '/api/auth/whoami', tokens.other);
    expect(who.status).toBe(200);
    expect(who.body.tokenKind).toBeUndefined();
    await settings(false, false);
    expect((await api('GET', '/api/users', tokens.other)).status).toBe(200);
  });
});

describe('修改密码', () => {
  it('校验原密码和长度；成功后全部旧凭证失效，新密码可登录', async () => {
    const auth = app.get(AuthService);
    const { token: cli } = await auth.issueToken(ids.other, 'password test', 'cli');
    expect((await api('POST', '/api/account/password', tokens.other, { oldPassword: 'wrong', password: 'newpassword123' })).status).toBe(400);
    expect((await api('POST', '/api/account/password', tokens.other, { oldPassword: 'password123', password: 'short' })).status).toBe(400);
    expect((await api('POST', '/api/account/password', tokens.other, { oldPassword: 'password123', password: 'newpassword123' })).status).toBe(201);
    expect((await api('GET', '/api/users', tokens.other)).status).toBe(401);
    expect((await api('GET', '/api/users', cli)).status).toBe(401);
    expect((await login('other@account.test')).status).toBe(401);
    expect((await login('other@account.test', 'newpassword123')).status).toBe(201);
  });
});
