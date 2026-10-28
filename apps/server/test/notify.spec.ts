process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://dev@127.0.0.1:5433/eat_test';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { DB, type Db } from '../src/db/db.module';
import * as schema from '../src/db/schema';
import { encryptSecret } from '../src/common/crypto';

let app: NestFastifyApplication, db: Db, server: Server;
let admin: { id: string; token: string }, member: { id: string; token: string };
let readyId: string, failedId: string, missingId: string, disabledId: string;
const hits: { path: string; body: any }[] = [];
const markdown = '**验收**\n- 登录成功\n\n[文档](https://example.com)\n```sh\neat users\n```';
async function api(method: 'GET' | 'POST' | 'PATCH', url: string, token?: string, payload?: unknown) {
  const response = await app.inject({ method, url, headers: token ? { authorization: `Bearer ${token}` } : {}, payload: payload as never });
  return { status: response.statusCode, body: response.json() };
}
beforeAll(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await pool.query('drop schema public cascade; create schema public; drop schema if exists drizzle cascade;');
  await migrate(drizzle(pool), { migrationsFolder: resolve('drizzle') });
  const seed = drizzle(pool, { schema });
  const passwordHash = await bcrypt.hash('password123', 4);
  const people = await seed.insert(schema.users).values([
    { name: '管理员', email: 'admin@notify.test', role: 'admin' as const },
    { name: '发送者', email: 'member@notify.test' },
    { name: '已配置', email: 'ready@notify.test' },
    { name: '失败渠道', email: 'failed@notify.test' },
    { name: '未验证', email: 'missing@notify.test' },
    { name: '禁用用户', email: 'disabled@notify.test', status: 'disabled' as const },
  ].map(p => ({ ...p, passwordHash }))).returning();
  server = createServer((req, res) => {
    let body = ''; req.on('data', chunk => body += chunk);
    req.on('end', () => {
      hits.push({ path: req.url!, body: JSON.parse(body) });
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ code: req.url === '/failed' ? 19001 : 0 }));
    });
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  readyId = people[2].id; failedId = people[3].id; missingId = people[4].id; disabledId = people[5].id;
  await seed.insert(schema.userNotifications).values([
    { userId: readyId, webhookUrl: `${base}/ready`, verifiedAt: new Date(), webhookSecretEncrypted: encryptSecret('test-sign') },
    { userId: failedId, webhookUrl: `${base}/failed`, verifiedAt: new Date() },
    { userId: missingId, webhookUrl: `${base}/unverified` },
    { userId: disabledId, webhookUrl: `${base}/disabled`, verifiedAt: new Date() },
  ]);
  await seed.insert(schema.githubAccounts).values({ userId: readyId, githubId: '123', login: 'ready-github',
    accessTokenEncrypted: encryptSecret('test-github-token'), orgState: 'active' });
  await pool.end();
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = mod.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  await app.init(); await app.getHttpAdapter().getInstance().ready(); db = app.get(DB);
  const login = async (email: string) => {
    const r = await api('POST', '/api/auth/login', undefined, { email, password: 'password123' });
    return { id: r.body.user.id, token: r.body.token };
  };
  admin = await login('admin@notify.test'); member = await login('member@notify.test');
});
afterAll(async () => { await app?.close(); server?.close(); });

describe('CLI 通知与用户目录', () => {
  it('目录登录即可查询，只返回安全摘要，GitHub 管理摘要限管理员可见', async () => {
    expect((await api('GET', '/api/users')).status).toBe(401);
    const result = await api('GET', '/api/users', member.token);
    expect(result.status).toBe(200);
    expect(result.body.every((u: any) => u.canNotifyAll === false)).toBe(true);
    expect(result.body.find((u: any) => u.id === readyId).notificationReady).toBe(true);
    expect(result.body.find((u: any) => u.id === missingId).notificationReady).toBe(false);
    expect(result.body.find((u: any) => u.id === disabledId).notificationReady).toBe(false);
    const fields = ['id', 'name', 'email', 'role', 'status', 'bio', 'canNotifyAll', 'notificationReady'];
    expect(Object.keys(result.body[0]).sort()).toEqual(fields.sort());
    expect(JSON.stringify(result.body)).not.toMatch(/webhook|passwordHash|accessToken|github/i);
    const management = await api('GET', '/api/users', admin.token);
    expect(management.body.find((u: any) => u.id === readyId).github).toEqual({ login: 'ready-github', orgState: 'active', needsAuthorization: false });
    expect(management.body.find((u: any) => u.id === member.id).github).toBeNull();
    expect(Object.keys(management.body[0]).sort()).toEqual([...fields, 'github', 'notification'].sort());
    expect(management.body.find((u: any) => u.id === disabledId).notification.connected).toBe(false);
  });
  it('发送与预检查都要求登录；全员权限默认关闭，包括管理员', async () => {
    const body = { all: true, title: '通知', body: markdown };
    expect((await api('POST', '/api/notifications/send', undefined, body)).status).toBe(401);
    for (const user of [admin, member]) for (const dryRun of [false, true]) {
      expect((await api('POST', '/api/notifications/send', user.token, { ...body, dryRun })).status).toBe(403);
    }
    expect(hits).toHaveLength(0);
  });
  it('仅管理员可授予权限，可以为自己开通，但仍禁止修改自己的角色或状态', async () => {
    expect((await api('PATCH', `/api/users/${member.id}`, member.token, { canNotifyAll: true })).status).toBe(403);
    const grant = await api('PATCH', `/api/users/${admin.id}`, admin.token, { canNotifyAll: true });
    expect(grant.status).toBe(200); expect(grant.body.canNotifyAll).toBe(true);
    expect((await api('PATCH', `/api/users/${admin.id}`, admin.token, { role: 'member', canNotifyAll: false })).status).toBe(400);
    expect((await api('PATCH', `/api/users/${admin.id}`, admin.token, { status: 'disabled' })).status).toBe(400);
    expect((await api('PATCH', `/api/users/${member.id}`, admin.token, { canNotifyAll: true })).status).toBe(200);
  });
  it('管理员自身角色/状态限制不能用 UUID 的不同写法绕过', async () => {
    for (const id of [admin.id.toUpperCase(), admin.id.replaceAll('-', ''), `{${admin.id}}`]) {
      expect((await api('PATCH', `/api/users/${encodeURIComponent(id)}`, admin.token, { role: 'admin' })).status).toBe(400);
      expect((await api('PATCH', `/api/users/${encodeURIComponent(id)}`, admin.token, { status: 'active' })).status).toBe(400);
    }
  });
  it('dry-run 校验全员范围、排除禁用用户，且不投递和不落投递记录', async () => {
    const result = await api('POST', '/api/notifications/send', member.token, { all: true, title: '检查', body: markdown, dryRun: true });
    expect(result.status).toBe(201);
    expect(result.body.recipients).toHaveLength(5);
    expect(result.body.recipients.find((r: any) => r.id === readyId).status).toBe('ready');
    expect(result.body.recipients.some((r: any) => r.id === disabledId)).toBe(false);
    expect(hits).toHaveLength(0);
    expect(await db.select().from(schema.webhookDeliveries)).toHaveLength(0);
  });
  it('按 ID/邮箱发送，去重，Markdown 原样保留；底部只有一行真实发送人并正确加签', async () => {
    const result = await api('POST', '/api/notifications/send', member.token, {
      to: [readyId, 'READY@notify.test'], title: '验收 <标题>', body: markdown, senderName: '伪造管理员',
    });
    expect(result.status).toBe(201); expect(result.body.recipients).toHaveLength(1);
    expect(result.body.recipients[0].status).toBe('sent'); expect(hits).toHaveLength(1);
    const sent = hits[0].body;
    expect(sent.card.header.title.tag).toBe('plain_text');
    expect(sent.card.elements).toHaveLength(3);
    expect(sent.card.elements[0]).toEqual({ tag: 'markdown', content: markdown });
    expect(sent.card.elements.at(-1).elements[0].content).toMatch(/^发送人：发送者 · \d\d-\d\d \d\d:\d\d · EAT$/);
    expect(JSON.stringify(sent)).not.toContain('伪造管理员');
    expect(sent.sign).toBe(createHmac('sha256', `${sent.timestamp}\ntest-sign`).update('').digest('base64'));
  });
  it('混合投递准确报告成功、失败和无法投递，不向未验证或禁用渠道发消息', async () => {
    const result = await api('POST', '/api/notifications/send', member.token, {
      to: [readyId, failedId, missingId, disabledId], title: '混合结果', body: markdown,
    });
    expect(result.body.recipients.map((r: any) => r.status)).toEqual(['sent', 'failed', 'unavailable', 'unavailable']);
    // 通知并发投递，HTTP 到达顺序不保证；仍严格核对目标与每个目标的次数。
    expect(hits.map(h => h.path).sort()).toEqual(['/failed', '/ready', '/ready']);
    const deliveries = await db.select().from(schema.webhookDeliveries);
    expect(deliveries.filter(r => r.status === 'success')).toHaveLength(2);
    expect(deliveries.find(r => r.status === 'failed')?.attempts).toBe(1);
    expect(JSON.stringify(result.body)).not.toMatch(/127\.0\.0\.1|test-sign/);
  });
  it('全员广播实际投递，权限撤销立即生效', async () => {
    const sent = await api('POST', '/api/notifications/send', member.token, { all: true, title: '广播', body: markdown });
    expect(sent.body.recipients).toHaveLength(5);
    expect(hits.at(-1)?.body.card.header.template).toBe('orange');
    await api('PATCH', `/api/users/${member.id}`, admin.token, { canNotifyAll: false });
    const count = hits.length;
    expect((await api('POST', '/api/notifications/send', member.token, { all: true, title: '广播', body: markdown })).status).toBe(403);
    expect(hits).toHaveLength(count);
  });
  it('无效参数或任何不存在的接收人导致整批拒绝，不先发一部分', async () => {
    const before = hits.length;
    for (const fields of [
      { to: [readyId, 'not-a-user'] }, { to: [readyId], all: true }, {},
      { to: [readyId], body: ' ' }, { to: [readyId], title: 'a\nb' },
      { to: [readyId], body: '中'.repeat(7000) }, { to: [readyId], body: '<at id=all></at>' },
    ]) expect((await api('POST', '/api/notifications/send', member.token, { title: '通知', body: markdown, ...fields })).status).toBe(400);
    expect(hits).toHaveLength(before);
  });
});
