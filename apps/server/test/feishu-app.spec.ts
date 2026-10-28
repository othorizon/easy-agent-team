process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://dev@127.0.0.1:5433/eat_test';

import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcryptjs';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createCipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi, type MockInstance } from 'vitest';
import { extractFeishuBindCode, feishuScopeApplyUrl } from '@eat/shared';
import { AppModule } from '../src/app.module';
import { RequestNotifications } from '../src/requests/requests.notifications';
import { ApprovalCards } from '../src/requests/approval-cards.service';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
let app: NestFastifyApplication;
const ids = { admin: randomUUID(), owner: randomUUID(), member: randomUUID(), other: randomUUID() };
const openIds: Record<keyof typeof ids, string> = { admin: 'ou_admin', owner: 'ou_owner', member: 'ou_member', other: 'ou_other' };
const tokens: Record<string, string> = {};
const APP = { appId: 'cli_a1b2c3d4e5f6a7b8', appSecret: 'secret-1', verificationToken: 'vtoken-1', encryptKey: 'ekey-1' };

/** 模拟的飞书开放平台：记录每次调用，权限授权状态可调 */
const feishu = {
  calls: [] as { method: string; path: string; body: any }[],
  scopes: [
    { scope_name: 'im:message:send_as_bot', grant_status: 1, scope_type: 'tenant' },
    { scope_name: 'im:message.p2p_msg:readonly', grant_status: 2, scope_type: 'tenant' },
  ] as { scope_name: string; grant_status: number; scope_type: string }[],
  nextMessage: 0,
  failSend: false,
  /** 按官方文档：失败时 HTTP 400 + 业务错误码 */
  applyCode: 0,
  scopesCode: 0,
};
let fetchSpy: MockInstance<typeof fetch>;
const sent = (path: string) => feishu.calls.filter((c) => c.path.startsWith(path));

async function api(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, who = 'admin', payload?: unknown) {
  const r = await app.inject({ method, url, headers: { authorization: `Bearer ${tokens[who]}` }, payload: payload as never });
  return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
}

function encrypt(key: string, plain: unknown): string {
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-cbc', createHash('sha256').update(key).digest(), iv);
  return Buffer.concat([iv, cipher.update(JSON.stringify(plain)), cipher.final()]).toString('base64');
}
/** 按飞书的方式加密并签名后投递到回调地址 */
async function push(plain: unknown, opts: { key?: string; sign?: boolean; badSignature?: boolean } = {}) {
  const body = JSON.stringify({ encrypt: encrypt(opts.key ?? APP.encryptKey, plain) });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = randomUUID();
  const signature = createHash('sha256').update(timestamp + nonce + APP.encryptKey + body).digest('hex');
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.sign !== false) {
    headers['x-lark-request-timestamp'] = timestamp;
    headers['x-lark-request-nonce'] = nonce;
    headers['x-lark-signature'] = opts.badSignature ? signature.replace(/.$/, (c) => (c === '0' ? '1' : '0')) : signature;
  }
  const r = await app.inject({ method: 'POST', url: '/api/feishu/callback', headers, payload: body });
  return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
}
const event = (type: string, ev: unknown, eventId: string = randomUUID()) => ({
  schema: '2.0',
  header: { event_id: eventId, event_type: type, token: APP.verificationToken, app_id: APP.appId, create_time: String(Date.now()) },
  event: ev,
});
const message = (openId: string, text: string, eventId?: string) =>
  push(
    event(
      'im.message.receive_v1',
      {
        sender: { sender_id: { open_id: openId, union_id: `on_${openId}` }, sender_type: 'user' },
        message: { message_id: `om_in_${randomUUID()}`, chat_type: 'p2p', message_type: 'text', content: JSON.stringify({ text }) },
      },
      eventId,
    ),
  );
const cardAction = (openId: string, messageId: string, value: Record<string, unknown>, formValue?: Record<string, unknown>) =>
  push(
    event('card.action.trigger', {
      operator: { open_id: openId },
      action: { tag: 'button', value, ...(formValue ? { form_value: formValue } : {}) },
      context: { open_message_id: messageId, open_chat_id: 'oc_1' },
    }),
  );

async function bind(who: keyof typeof ids) {
  const code = await api('POST', '/api/account/notification/feishu/bind-code', who);
  expect(code.status, JSON.stringify(code.body)).toBe(201);
  const r = await message(openIds[who], `绑定 ${code.body.code.toLowerCase()} 谢谢`);
  expect(r.status).toBe(200);
}
const lastReply = () => JSON.parse(sent('/im/v1/messages/om_in_').at(-1)!.body.content).text as string;
const cardText = (card: unknown) => JSON.stringify(card);

beforeAll(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public; DROP SCHEMA IF EXISTS drizzle CASCADE');
  await migrate(drizzle(pool), { migrationsFolder: resolve('drizzle') });
  const hash = await bcrypt.hash('password123', 4);
  for (const [name, id] of Object.entries(ids)) {
    await pool.query('INSERT INTO "user"(id,name,email,role,password_hash,bio) VALUES($1,$2,$3,$4,$5,$6)', [
      id, name, `${name}@feishu.test`, name === 'admin' ? 'admin' : 'member', hash, `${name} 的简介`,
    ]);
  }
  const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  for (const name of Object.keys(ids)) {
    const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: `${name}@feishu.test`, password: 'password123' } });
    tokens[name] = r.json().token;
  }
  const originalFetch = globalThis.fetch;
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    if (!url.startsWith('https://open.feishu.cn/open-apis/')) return originalFetch(input, init);
    const path = url.slice('https://open.feishu.cn/open-apis'.length);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    const method = init?.method ?? 'GET';
    feishu.calls.push({ method, path, body });
    const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200 });
    if (path === '/auth/v3/tenant_access_token/internal') {
      return body.app_secret === APP.appSecret
        ? json({ code: 0, tenant_access_token: 't-token', expire: 7200 })
        : json({ code: 10014, msg: 'app secret invalid' });
    }
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer t-token');
    if (path === '/bot/v3/info') return json({ code: 0, bot: { activate_status: 2, app_name: 'EAT 助手', avatar_url: 'https://example.com/a.png' } });
    const fail = (code: number, msg: string) => new Response(JSON.stringify({ code, msg }), { status: 400 });
    if (path === '/application/v6/scopes') {
      return feishu.scopesCode ? fail(feishu.scopesCode, 'app not install') : json({ code: 0, data: { scopes: feishu.scopes } });
    }
    if (path === '/application/v6/scopes/apply') {
      return feishu.applyCode ? fail(feishu.applyCode, 'duplicate apply') : json({ code: 0, msg: 'success', data: {} });
    }
    if (path.startsWith('/im/v1/messages?receive_id_type=open_id')) {
      if (feishu.failSend) return json({ code: 230013, msg: 'bot has no availability to this user' });
      return json({ code: 0, data: { message_id: `om_card_${++feishu.nextMessage}` } });
    }
    if (method === 'PATCH' || path.endsWith('/reply')) return json({ code: 0, data: {} });
    return json({ code: 404, msg: 'not mocked' });
  });
});
afterAll(async () => {
  fetchSpy?.mockRestore();
  await app?.close();
  await pool.end();
});

describe('绑定码格式', () => {
  it('固定前缀、去掉易混字符，大小写不敏感且允许前后带字', () => {
    expect(extractFeishuBindCode('EAT-7KQ2MX')).toBe('EAT-7KQ2MX');
    expect(extractFeishuBindCode('我的绑定码：eat-7kq2mx，谢谢')).toBe('EAT-7KQ2MX');
    expect(extractFeishuBindCode('EAT-7KQ2M')).toBeNull();
    expect(extractFeishuBindCode('EAT-7KQ2MXY')).toBeNull();
    expect(extractFeishuBindCode('EAT-7KQ0MX')).toBeNull();
    expect(extractFeishuBindCode('XEAT-7KQ2MX')).toBeNull();
    expect(feishuScopeApplyUrl('cli_x', ['a:b', 'c'])).toBe('https://open.feishu.cn/app/cli_x/auth?q=a%3Ab%2Cc&op_from=eat&token_type=tenant');
  });
});

describe('飞书自建应用：安装与检查', () => {
  it('只有管理员能配置；首次必须填全，凭据错误时检查不通过', async () => {
    expect((await api('GET', '/api/settings/feishu', 'member')).status).toBe(403);
    const initial = await api('GET', '/api/settings/feishu');
    expect(initial.body).toMatchObject({ channel: 'webhook', appId: '', ready: false, callbackUrl: expect.stringMatching(/\/api\/feishu\/callback$/) });
    expect(JSON.parse(initial.body.scopesImportJson).scopes.tenant).toEqual(['im:message:send_as_bot', 'im:message.p2p_msg:readonly']);
    expect((await api('PUT', '/api/settings/feishu/app', 'admin', { appId: APP.appId, appSecret: 'x' })).status).toBe(400);
    expect((await api('PUT', '/api/settings/feishu/app', 'admin', { ...APP, appId: 'not-an-app' })).status).toBe(400);
    const bad = await api('PUT', '/api/settings/feishu/app', 'admin', { ...APP, appSecret: 'wrong' });
    expect(bad.status).toBe(200);
    expect(bad.body.check).toMatchObject({ credentialsOk: false });
    expect(bad.body.blockers).toContain('App ID 或 App Secret 无法通过校验');
  });

  it('保存后自动检查：机器人信息、权限状态逐项给出，密钥不回显', async () => {
    const r = await api('PUT', '/api/settings/feishu/app', 'admin', APP);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({
      appId: APP.appId, hasAppSecret: true, hasVerificationToken: true, hasEncryptKey: true,
      botName: 'EAT 助手', ready: false,
      check: { credentialsOk: true, botActive: true, scopes: [
        { scope: 'im:message:send_as_bot', status: 'granted' },
        { scope: 'im:message.p2p_msg:readonly', status: 'pending' },
      ] },
    });
    expect(JSON.stringify(r.body)).not.toContain(APP.appSecret);
    expect(JSON.stringify(r.body)).not.toContain(APP.encryptKey);
    expect(r.body.blockers).toEqual(['权限未开通：读取用户发给机器人的单聊消息', '开发者后台的请求地址还没有通过验证']);
    // 只轮换一项时其余保留
    expect((await api('PUT', '/api/settings/feishu/app', 'admin', { appId: APP.appId })).body.hasAppSecret).toBe(true);
  });

  it('申请权限：已添加未授权的走飞书接口申请，没添加的给出预选好的开通页', async () => {
    feishu.scopes = [{ scope_name: 'im:message:send_as_bot', grant_status: 2, scope_type: 'tenant' }];
    const r = await api('POST', '/api/settings/feishu/scopes/apply');
    expect(r.body).toMatchObject({ applied: true, consoleUrl: feishuScopeApplyUrl(APP.appId, ['im:message.p2p_msg:readonly']) });
    expect(sent('/application/v6/scopes/apply')).toHaveLength(1);
    // 文档里的错误码翻成能照着做的提示
    feishu.applyCode = 212004;
    expect((await api('POST', '/api/settings/feishu/scopes/apply')).body).toMatchObject({ applied: false, message: '已经申请过，正在等待企业管理员审批' });
    feishu.applyCode = 0;
    // 官方文档的响应里不带 scope_type
    feishu.scopes = [{ scope_name: 'im:message:send_as_bot', grant_status: 1 }] as typeof feishu.scopes;
    expect((await api('POST', '/api/settings/feishu/scopes/apply')).body).toMatchObject({ applied: false, consoleUrl: expect.stringContaining('p2p_msg') });
    expect(sent('/application/v6/scopes/apply')).toHaveLength(2);
    feishu.scopesCode = 212100;
    expect((await api('POST', '/api/settings/feishu/check')).body.check.scopesError).toContain('还没有在企业内安装');
    feishu.scopesCode = 0;
  });

  it('回调：未加密、签名错、token 错一律拒绝；地址验证通过后记下', async () => {
    const plain = await app.inject({ method: 'POST', url: '/api/feishu/callback', headers: { 'content-type': 'application/json' },
      payload: { type: 'url_verification', token: APP.verificationToken, challenge: 'c1' } });
    expect(plain.statusCode).toBe(400);
    expect((await push({ type: 'url_verification', token: 'wrong', challenge: 'c1' })).status).toBe(401);
    expect((await push({ type: 'url_verification', token: APP.verificationToken, challenge: 'c1' }, { key: 'other-key' })).status).toBe(401);
    expect((await api('GET', '/api/settings/feishu')).body.callbackVerifiedAt).toBeNull();
    const ok = await push({ type: 'url_verification', token: APP.verificationToken, challenge: 'c1' }, { sign: false });
    expect(ok).toEqual({ status: 200, body: { challenge: 'c1' } });
    expect((await api('GET', '/api/settings/feishu')).body.callbackVerifiedAt).not.toBeNull();
    // 原样重填不作废地址验证
    expect((await api('PUT', '/api/settings/feishu/app', 'admin', APP)).body.callbackVerifiedAt).not.toBeNull();
    expect((await message('ou_x', 'hi')).status).toBe(200);
    expect((await push(event('im.message.receive_v1', {}), { sign: false })).status).toBe(401);
    expect((await push(event('im.message.receive_v1', {}), { badSignature: true })).status).toBe(401);
    expect((await push({ ...event('im.message.receive_v1', {}), header: { ...event('x', {}).header, token: 'bad' } })).status).toBe(401);
  });

  it('权限没开全时不能切换渠道；全部就绪后可以切换，切换由管理员操作', async () => {
    const blocked = await api('PUT', '/api/settings/feishu/channel', 'admin', { channel: 'app' });
    expect(blocked.status).toBe(400);
    expect(blocked.body.message).toContain('读取用户发给机器人的单聊消息');
    feishu.scopes = [
      { scope_name: 'im:message:send_as_bot', grant_status: 1, scope_type: 'tenant' },
      { scope_name: 'im:message.p2p_msg:readonly', grant_status: 1, scope_type: 'tenant' },
    ];
    expect((await api('PUT', '/api/settings/feishu/channel', 'member', { channel: 'app' })).status).toBe(403);
    const r = await api('PUT', '/api/settings/feishu/channel', 'admin', { channel: 'app' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ channel: 'app', ready: true, blockers: [] });
    // 使用中不能直接换应用
    expect((await api('PUT', '/api/settings/feishu/app', 'admin', { ...APP, appId: 'cli_ffffffffffffffff' })).status).toBe(409);
  });
});

describe('飞书自建应用：成员绑定', () => {
  it('强制通知时未绑定的成员被引导完成绑定；私聊发绑定码即完成，机器人回复结果', async () => {
    await api('PUT', '/api/admin/registration-settings', 'admin', { enabled: false, allowedEmailSuffixes: [], requireBio: false, requireNotification: true });
    const before = await api('GET', '/api/account', 'member');
    expect(before.body.notification).toMatchObject({ channel: 'app', connected: false, feishuApp: { bound: false, botName: 'EAT 助手', openBotUrl: `https://applink.feishu.cn/client/bot/open?appId=${APP.appId}` } });
    expect(before.body.onboarding.required).toBe(true);
    expect((await api('GET', '/api/envs', 'member')).status).toBe(403);

    const code = await api('POST', '/api/account/notification/feishu/bind-code', 'member');
    expect(code.body.code).toMatch(/^EAT-[A-HJ-NP-Z2-9]{6}$/);
    expect(code.body.ttlSeconds).toBe(600);
    // 重新生成后旧码作废
    const fresh = await api('POST', '/api/account/notification/feishu/bind-code', 'member');
    await message(openIds.member, code.body.code);
    expect(lastReply()).toContain('绑定码无效或已过期');
    const eventId = randomUUID();
    await message(openIds.member, fresh.body.code, eventId);
    expect(lastReply()).toContain('绑定成功');
    expect(lastReply()).toContain('member@feishu.test');
    const after = await api('GET', '/api/account', 'member');
    expect(after.body.notification).toMatchObject({ connected: true, feishuApp: { bound: true, stale: false } });
    expect(after.body.onboarding.required).toBe(false);
    // 同一事件重推不会重复处理；用过的码不能再用
    const replies = sent('/im/v1/messages/om_in_').length;
    await message(openIds.member, fresh.body.code, eventId);
    expect(sent('/im/v1/messages/om_in_')).toHaveLength(replies);
    await message(openIds.other, fresh.body.code);
    expect(lastReply()).toContain('绑定码无效或已过期');
    await message(openIds.other, '你好');
    expect(lastReply()).toContain('个人中心 → 通知设置');
  });

  it('过期的码无效；同一飞书账号改绑到另一个 EAT 账号时旧绑定解除', async () => {
    const code = await api('POST', '/api/account/notification/feishu/bind-code', 'other');
    await pool.query(`UPDATE feishu_bind_code SET expires_at=now()-interval '1 second' WHERE user_id=$1`, [ids.other]);
    await message(openIds.other, code.body.code);
    expect(lastReply()).toContain('已过期');
    const again = await api('POST', '/api/account/notification/feishu/bind-code', 'other');
    await message(openIds.member, again.body.code);
    expect(lastReply()).toContain('之前绑定的 EAT 账号已自动解绑');
    expect((await api('GET', '/api/account', 'member')).body.notification.feishuApp.bound).toBe(false);
    expect((await api('GET', '/api/account', 'other')).body.notification.feishuApp.bound).toBe(true);
    expect((await api('DELETE', '/api/account/notification/feishu', 'other')).body.feishuApp.bound).toBe(false);
    for (const who of ['admin', 'owner', 'member', 'other'] as const) await bind(who);
  });

  it('错误次数过多的飞书账号暂时不能再试', async () => {
    for (let i = 0; i < 10; i++) await message('ou_attacker', `EAT-${'ABCDEFGHJK'[i]}AAAAA`);
    await message('ou_attacker', 'EAT-ZZZZZZ');
    expect(lastReply()).toContain('错误次数过多');
  });

  it('用户列表：管理员看到每人的绑定状态，成员看不到', async () => {
    const admin = await api('GET', '/api/users', 'admin');
    expect(admin.body.find((u: any) => u.id === ids.member).notification).toMatchObject({ channel: 'app', connected: true, feishuApp: 'bound' });
    await pool.query(`INSERT INTO "user"(id,name,email,password_hash) VALUES($1,'新人','new@feishu.test','x')`, [randomUUID()]);
    const users = (await api('GET', '/api/users', 'admin')).body;
    expect(users.find((u: any) => u.email === 'new@feishu.test').notification).toMatchObject({ connected: false, feishuApp: 'none' });
    expect((await api('GET', '/api/users', 'member')).body[0].notification).toBeUndefined();
  });

  it('CLI 通知按当前应用渠道投递，dry-run 不发消息，固定署名只出现一行', async () => {
    const request = { to: [ids.member], title: 'CLI 通知测试', body: '**验收通过**' };
    const count = sent('/im/v1/messages?').length;
    const dryRun = await api('POST', '/api/notifications/send', 'member', { ...request, dryRun: true });
    expect(dryRun.status).toBe(201);
    expect(dryRun.body.recipients[0].status).toBe('ready');
    expect(sent('/im/v1/messages?')).toHaveLength(count);
    expect((await api('GET', '/api/users', 'member')).body.find((u: any) => u.id === ids.member).notificationReady).toBe(true);
    const result = await api('POST', '/api/notifications/send', 'member', request);
    expect(result.status).toBe(201);
    expect(result.body.recipients[0].status).toBe('sent');
    const outbound = sent('/im/v1/messages?').at(-1)!.body;
    expect(outbound.receive_id).toBe(openIds.member);
    const card = JSON.parse(outbound.content);
    expect(card.elements).toHaveLength(3);
    expect(card.elements[0].content).toBe(request.body);
    expect(card.elements.at(-1).elements[0].content).toMatch(/^发送人：member · .* · EAT$/);
    const log = (await pool.query("SELECT status,attempts FROM webhook_delivery WHERE event_type='notification.message' ORDER BY created_at DESC LIMIT 1")).rows[0];
    expect(log).toMatchObject({ status: 'success', attempts: 1 });
    feishu.failSend = true;
    try {
      const failed = await api('POST', '/api/notifications/send', 'member', request);
      expect(failed.body.recipients[0].status).toBe('failed');
    } finally { feishu.failSend = false; }
  });

  it('测试通知与求助通知走机器人私聊', async () => {
    const before = sent('/im/v1/messages?receive_id_type=open_id').length;
    expect((await api('POST', '/api/account/notification/test', 'member')).status).toBe(201);
    const test = sent('/im/v1/messages?receive_id_type=open_id').at(-1)!;
    expect(test.body.receive_id).toBe(openIds.member);
    expect(test.body.content).toContain('EAT 测试通知');
    expect((await api('POST', '/api/account/notification/test', 'member')).status).toBe(400);

    const help = await api('POST', '/api/help-requests', 'other', { title: '飞书渠道求助', description: '支付对账失败怎么排查', tried: '看过日志', helperUserId: ids.member });
    expect(help.status, JSON.stringify(help.body)).toBe(201);
    await vi.waitFor(() => expect(sent('/im/v1/messages?receive_id_type=open_id').length).toBe(before + 2));
    const card = sent('/im/v1/messages?receive_id_type=open_id').at(-1)!;
    expect(card.body.receive_id).toBe(openIds.member);
    expect(card.body.content).toContain('飞书渠道求助');
  });
});

describe('飞书自建应用：审批卡片', () => {
  let request: { id: string };
  const worker = () => app.get(RequestNotifications);
  const approverCards = () => sent('/im/v1/messages?receive_id_type=open_id').filter((c) => c.body.content.includes('待审批提醒'));

  it('审批人收到带同意 / 驳回回调的卡片，并被记下来', async () => {
    await pool.query(`UPDATE approval_notification SET state='skipped' WHERE state='pending'`);
    expect((await api('POST', '/api/envs', 'owner', { slug: 'card-env', name: '卡片环境', description: '测试' })).status).toBe(201);
    await api('POST', '/api/envs/card-env/variables', 'owner', { key: 'CARD_KEY', value: 'never-in-card', description: '卡片测试变量' });
    const r = await api('POST', '/api/access-requests', 'member', { environmentSlug: 'card-env', keys: ['CARD_KEY'], reason: '[点我](https://evil.example) 排查' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    request = (await pool.query(`SELECT id FROM approval_request WHERE type='env' AND source_id=$1`, [r.body.id])).rows[0];
    const before = approverCards().length;
    await worker().tick();
    const cards = approverCards().slice(before);
    expect(cards.map((c) => c.body.receive_id).sort()).toEqual([openIds.admin, openIds.owner].sort());
    const card = JSON.parse(cards[0].body.content);
    expect(card.schema).toBe('2.0');
    expect(card.config.update_multi).toBe(true);
    expect(cardText(card)).toContain('CARD_KEY');
    expect(cardText(card)).not.toContain('never-in-card');
    expect(cardText(card)).toContain('"tag":"plain_text","content":"申请类型');
    expect(cardText(card)).toContain('"value":{"eat":"approval","requestId":"' + request.id + '","action":"approve"}');
    expect((await pool.query('SELECT count(*)::int n FROM feishu_card WHERE request_id=$1', [request.id])).rows[0].n).toBe(2);
  });

  it('卡片动作校验身份：未绑定、不是发给自己的卡片都不执行', async () => {
    const { rows } = await pool.query('SELECT message_id,user_id FROM feishu_card WHERE request_id=$1', [request.id]);
    const ownerCard = rows.find((c) => c.user_id === ids.owner).message_id;
    const unbound = await cardAction('ou_nobody', ownerCard, { eat: 'approval', requestId: request.id, action: 'approve' });
    expect(unbound.body.toast).toMatchObject({ type: 'error', content: expect.stringContaining('还没有绑定') });
    const notMine = await cardAction(openIds.admin, ownerCard, { eat: 'approval', requestId: request.id, action: 'approve' });
    expect(notMine.body.toast.content).toContain('不是发给你的');
    const unknown = await cardAction(openIds.owner, ownerCard, { eat: 'nothing' });
    expect(unknown.body.toast.type).toBe('warning');
    expect((await pool.query('SELECT status FROM approval_request WHERE id=$1', [request.id])).rows[0].status).toBe('pending');
  });

  it('驳回先展开原因表单，空原因不提交；同意后卡片原地变为已批准，其他审批人的卡片随之更新', async () => {
    const { rows } = await pool.query('SELECT message_id,user_id FROM feishu_card WHERE request_id=$1', [request.id]);
    const ownerCard = rows.find((c) => c.user_id === ids.owner).message_id;
    const adminCard = rows.find((c) => c.user_id === ids.admin).message_id;
    const value = (action: string) => ({ eat: 'approval', requestId: request.id, action });
    const rejecting = await cardAction(openIds.owner, ownerCard, value('reject_start'));
    expect(cardText(rejecting.body.card.data)).toContain('"tag":"form"');
    expect(cardText(rejecting.body.card.data)).toContain('"form_action_type":"submit"');
    const empty = await cardAction(openIds.owner, ownerCard, value('reject'), { reason: '  ' });
    expect(empty.body.toast).toMatchObject({ type: 'error', content: '请填写驳回原因' });
    const back = await cardAction(openIds.owner, ownerCard, value('reject_cancel'));
    expect(cardText(back.body.card.data)).toContain('"action":"approve"');

    const approved = await cardAction(openIds.owner, ownerCard, value('approve'));
    expect(approved.body.toast).toMatchObject({ type: 'success', content: '已同意' });
    expect(approved.body.card.data.header.title.content).toBe('EAT 已批准');
    expect(cardText(approved.body.card.data)).toContain('审批人：owner');
    expect(cardText(approved.body.card.data)).not.toContain('"action":"approve"');
    expect((await pool.query('SELECT status,decided_by FROM approval_request WHERE id=$1', [request.id])).rows[0])
      .toEqual({ status: 'approved', decided_by: ids.owner });
    // 授权真的生效了：成员能读到变量
    const pulled = await api('POST', '/api/envs/card-env/values', 'member', {});
    expect(JSON.stringify(pulled.body)).toContain('never-in-card');

    await app.get(ApprovalCards).sync(request.id);
    const patch = feishu.calls.filter((c) => c.method === 'PATCH' && c.path.includes(adminCard));
    expect(patch).toHaveLength(1);
    expect(JSON.parse(patch[0].body.content).header.title.content).toBe('EAT 已批准');
    // 已处理的申请再点卡片只回最新状态
    const again = await cardAction(openIds.admin, adminCard, value('approve'));
    expect(again.body.toast).toMatchObject({ type: 'info', content: '该申请已处理' });
    // 申请人收到结果卡片
    await worker().tick();
    const result = sent('/im/v1/messages?receive_id_type=open_id').at(-1)!;
    expect(result.body.receive_id).toBe(openIds.member);
    expect(JSON.parse(result.body.content).header.title.content).toBe('你的申请已批准');
  });

  it('在网页上处理后，卡片也被回写成最新状态', async () => {
    const r = await api('POST', '/api/access-requests', 'other', { environmentSlug: 'card-env', keys: ['CARD_KEY'], reason: '网页审批' });
    const req = (await pool.query(`SELECT id FROM approval_request WHERE type='env' AND source_id=$1`, [r.body.id])).rows[0];
    await worker().tick();
    await api('POST', `/api/requests/${req.id}/decision`, 'admin', { decision: 'rejected', reason: '请走工单' });
    const patches = () => feishu.calls.filter((c) => c.method === 'PATCH' && c.body.content.includes('请走工单'));
    await worker().tick();
    expect(patches()).toHaveLength(2);
    expect(JSON.parse(patches()[0].body.content).header.title.content).toBe('EAT 已驳回');
    await worker().tick();
    expect(patches()).toHaveLength(2);
  });

  it('投递失败记在申请上，切回 Webhook 渠道后不再走机器人', async () => {
    feishu.failSend = true;
    const r = await api('POST', '/api/access-requests', 'other', { environmentSlug: 'card-env', keys: ['CARD_KEY'], reason: '投递失败' });
    const req = (await pool.query(`SELECT id FROM approval_request WHERE type='env' AND source_id=$1`, [r.body.id])).rows[0];
    await worker().tick();
    expect((await api('GET', `/api/requests/${req.id}`, 'other')).body.request.notificationError).toContain('投递失败');
    feishu.failSend = false;
    expect((await api('PUT', '/api/settings/feishu/channel', 'admin', { channel: 'webhook' })).body.channel).toBe('webhook');
    const account = await api('GET', '/api/account', 'member');
    expect(account.body.notification).toMatchObject({ channel: 'webhook', connected: false, feishuApp: { bound: true } });
    expect(account.body.onboarding.required).toBe(true);
  });
});
