/**
 * P1 求助系统端到端测试：
 * Helper 登记 / 求助状态机 / 可见性 / 频率限制 / 飞书 webhook（mock 机器人 + 加签验签，决策 16）/
 * AI 设置 / 经验沉淀（模板回退 + mock OpenAI）/ 经验搜索与授权
 */
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://dev@127.0.0.1:5433/eat_test';

import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcryptjs';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createHmac } from 'node:crypto';
import * as http from 'node:http';
import * as path from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import * as schema from '../src/db/schema';

let app: NestFastifyApplication;
let helperToken: string;
let requesterToken: string;
let thirdToken: string;
let adminToken: string;
let helperId: string;

// 本地 mock 飞书机器人接收端（HTTP 200 + code:0 表示成功）
const webhookHits: Array<{ body: string }> = [];
let webhookServer: http.Server;
let webhookUrl: string;
const webhookSecret = 'feishu-sign-secret-for-test'; // 用户从飞书「加签」处粘贴的密钥

// 本地 mock OpenAI
const AI_CONTENT = '# AI 整理的经验\n\n## 适用场景\n对账差异排查\n\n## 结论\n先核对流水号再对金额。';
let aiServer: http.Server;
let aiBaseUrl: string;

async function api(
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  opts: { token?: string; payload?: unknown } = {},
) {
  const res = await app.inject({
    method,
    url,
    payload: opts.payload as never,
    headers: opts.token ? { authorization: `Bearer ${opts.token}` } : {},
  });
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : undefined };
}

async function waitFor(cond: () => boolean, ms = 4000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  if (!cond()) throw new Error('等待超时');
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port)));
}

beforeAll(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await pool.query('drop schema public cascade; create schema public; drop schema if exists drizzle cascade;');
  await migrate(drizzle(pool), { migrationsFolder: path.resolve(process.cwd(), 'drizzle') });
  const db = drizzle(pool, { schema });
  const hash = await bcrypt.hash('password123', 4);
  await db.insert(schema.users).values([
    { name: '管理员', email: 'admin@test.dev', role: 'admin', passwordHash: hash },
    { name: '资深同事D', email: 'helper@test.dev', role: 'member', passwordHash: hash },
    { name: '运营B', email: 'requester@test.dev', role: 'member', passwordHash: hash },
    { name: '路人C', email: 'third@test.dev', role: 'member', passwordHash: hash },
  ]);
  await pool.end();

  webhookServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      webhookHits.push({ body });
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"code":0,"msg":"success"}');
    });
  });
  webhookUrl = `http://127.0.0.1:${await listen(webhookServer)}/hook`;

  aiServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [{ message: { content: AI_CONTENT } }],
          usage: { prompt_tokens: 120, completion_tokens: 60 },
        }),
      );
    });
  });
  aiBaseUrl = `http://127.0.0.1:${await listen(aiServer)}/v1`;

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  const login = async (email: string) =>
    (await api('POST', '/api/auth/login', { payload: { email, password: 'password123' } })).body;
  adminToken = (await login('admin@test.dev')).token;
  const h = await login('helper@test.dev');
  helperToken = h.token;
  helperId = h.user.id;
  requesterToken = (await login('requester@test.dev')).token;
  thirdToken = (await login('third@test.dev')).token;
});

afterAll(async () => {
  await app?.close();
  webhookServer?.close();
  aiServer?.close();
});

let requestId: string;
let skillRequestId: string;

describe('Helper 登记', () => {
  it('登记（含飞书 webhook + 用户粘贴的加签密钥）；出现在候选名单', async () => {
    const r = await api('PUT', '/api/helpers/me', {
      token: helperToken,
      payload: { description: '熟悉支付对账、内部 ERP 系统', webhookUrl, webhookSecret, available: true },
    });
    expect(r.status).toBe(200);
    expect(r.body.hasWebhookSecret).toBe(true);
    expect(r.body.webhookSecret).toBeUndefined(); // 密钥不回显

    const targets = await api('GET', '/api/helpers', { token: requesterToken });
    expect(targets.body.helpers.map((h: { name: string }) => h.name)).toContain('资深同事D');
    expect(targets.body.helpers[0].description).toContain('支付对账');
  });

  it('勿扰后从候选名单消失，恢复后回来；更新时留空加签密钥保持不变', async () => {
    await api('PUT', '/api/helpers/me', {
      token: helperToken,
      payload: { description: '熟悉支付对账、内部 ERP 系统', webhookUrl, available: false },
    });
    const off = await api('GET', '/api/helpers', { token: requesterToken });
    expect(off.body.helpers).toEqual([]);
    const back = await api('PUT', '/api/helpers/me', {
      token: helperToken,
      payload: { description: '熟悉支付对账、内部 ERP 系统', webhookUrl, available: true },
    });
    expect(back.body.hasWebhookSecret).toBe(true); // 两次都没带 webhookSecret，仍保留首次配置的值
  });
});

describe('求助流程', () => {
  it('创建求助 → 飞书机器人收到卡片消息且加签验签通过', async () => {
    const r = await api('POST', '/api/help-requests', {
      token: requesterToken,
      payload: {
        title: '对账单里的差异字段是什么意思',
        description: 'AI 在处理对账时问我 diff_type 字段的含义，我不懂',
        tried: '已让 AI 搜索过团队经验库，无结果',
        helperUserId: helperId,
      },
    });
    expect(r.status).toBe(201);
    expect(r.body.status).toBe('open');
    requestId = r.body.id;

    await waitFor(() => webhookHits.length >= 1);
    const payload = JSON.parse(webhookHits[0].body);
    // 决策 17：卡片消息，含请求 ID / 标题 / 描述 /「查看请求」按钮 /「发送给 Agent」代码块
    expect(payload.msg_type).toBe('interactive');
    expect(payload.card.header.title.content).toContain('新求助');
    const cardText = JSON.stringify(payload.card);
    expect(cardText).toContain(requestId);
    expect(cardText).toContain('对账单里的差异字段是什么意思');
    expect(cardText).toContain('diff_type 字段的含义');
    expect(cardText).toContain('查看请求');
    expect(cardText).toContain(`/help/${requestId}`);
    expect(cardText).toContain('发送给 Agent');
    expect(cardText).toContain(`eat ask show ${requestId}`);
    // 飞书加签：sign = base64(HmacSHA256(key = `${timestamp}\n${secret}`, data = 空串))
    const expected = createHmac('sha256', `${payload.timestamp}\n${webhookSecret}`).update('').digest('base64');
    expect(payload.sign).toBe(expected);
  });

  it('可见性：第三人 404，管理员可见（决策 #1）', async () => {
    expect((await api('GET', `/api/help-requests/${requestId}`, { token: thirdToken })).status).toBe(404);
    expect((await api('GET', `/api/help-requests/${requestId}`, { token: adminToken })).status).toBe(200);
  });

  it('短 ID：双方与管理员可用，第三人 404（前缀不泄露他人求助）', async () => {
    const short = requestId.slice(0, 8);
    // 管理员既非求助者也非被求助者：前缀若只在「自己能列出来的」范围内匹配，这里会失效
    expect((await api('GET', `/api/help-requests/${short}`, { token: requesterToken })).body.id).toBe(requestId);
    expect((await api('GET', `/api/help-requests/${short}`, { token: adminToken })).body.id).toBe(requestId);
    // 第三人对完整 ID 是 404，短 ID 也必须是 404，否则前缀成了探测求助是否存在的手段
    expect((await api('GET', `/api/help-requests/${short}`, { token: thirdToken })).status).toBe(404);
    expect((await api('GET', `/api/help-requests/${requestId.slice(0, 6)}`, { token: requesterToken })).status).toBe(400);
  });

  it('多轮对话状态机：回复 answered → 追问 open → 回复 → 确认 resolved', async () => {
    const a1 = await api('POST', `/api/help-requests/${requestId}/reply`, {
      token: helperToken,
      payload: { content: 'diff_type 是差异类型：1 金额差异 2 状态差异' },
    });
    expect(a1.body.status).toBe('answered');
    const q2 = await api('POST', `/api/help-requests/${requestId}/reply`, {
      token: requesterToken,
      payload: { content: '那状态差异要怎么处理？' },
    });
    expect(q2.body.status).toBe('open');
    await waitFor(() => webhookHits.length >= 2); // helper 收到追问的 help.replied
    const a2 = await api('POST', `/api/help-requests/${requestId}/reply`, {
      token: helperToken,
      payload: { content: '状态差异先核对流水号，再看是否退款单' },
    });
    expect(a2.body.status).toBe('answered');
    expect(a2.body.messages).toHaveLength(3);
    const done = await api('POST', `/api/help-requests/${requestId}/resolve`, { token: requesterToken });
    expect(done.body.status).toBe('resolved');
  });

  it('短 ID 走写路径：回复挂到正确的求助上', async () => {
    const before = (await api('GET', `/api/help-requests/${requestId}`, { token: requesterToken })).body.messages.length;
    const r = await api('POST', `/api/help-requests/${requestId.slice(0, 8)}/reply`, {
      token: helperToken,
      payload: { content: '补充：退款单要看原单号' },
    });
    expect(r.status).toBe(201);
    expect(r.body.id).toBe(requestId);
    expect(r.body.messages).toHaveLength(before + 1);
  });

  it('skill 作者求助入口：allowHelp 的 skill 可被求助并路由给作者', async () => {
    await api('POST', '/api/skills/push', {
      token: helperToken,
      payload: { slug: 'erp-guide', name: 'ERP 使用指南', description: '内部 ERP 的操作与概念', content: '# ERP 指南' },
    });
    await api('PATCH', '/api/skills/erp-guide', { token: helperToken, payload: { allowHelp: true } });
    const targets = await api('GET', '/api/helpers', { token: requesterToken });
    expect(targets.body.skillAuthors.map((s: { skillSlug: string }) => s.skillSlug)).toContain('erp-guide');

    const r = await api('POST', '/api/help-requests', {
      token: requesterToken,
      payload: {
        title: 'ERP 里的冲销单怎么建',
        description: 'AI 需要知道冲销单的创建入口',
        tried: '看过 erp-guide skill 没找到',
        skillSlug: 'erp-guide',
      },
    });
    expect(r.status).toBe(201);
    expect(r.body.helperName).toBe('资深同事D');
    expect(r.body.skillSlug).toBe('erp-guide');
    skillRequestId = r.body.id;
  });

  it('频率限制生效', async () => {
    let limited = false;
    for (let i = 0; i < 12; i++) {
      const r = await api('POST', '/api/help-requests', {
        token: requesterToken,
        payload: { title: `压测 ${i}`, description: 'x', tried: 'x', helperUserId: helperId },
      });
      if (r.status === 400 && r.body.error === 'RATE_LIMITED') {
        limited = true;
        break;
      }
    }
    expect(limited).toBe(true);
  });
});

describe('通知开关与卡片（决策 17）', () => {
  const HELPER_PROFILE = { description: '熟悉支付对账、内部 ERP 系统', available: true };
  let switchRequestId: string;

  it('能力描述可留空，通知开关默认开启', async () => {
    const r = await api('PUT', '/api/helpers/me', { token: thirdToken, payload: {} });
    expect(r.status).toBe(200);
    expect(r.body.description).toBe('');
    expect(r.body.notifyHelp).toBe(true);
    expect(r.body.notifyReply).toBe(true);
    await api('DELETE', '/api/helpers/me', { token: thirdToken }); // 不留在候选名单
  });

  it('关闭「接收求助」后创建求助不推送；打开后推送恢复且描述被截断', async () => {
    const baseline = webhookHits.length;
    await api('PUT', '/api/helpers/me', {
      token: helperToken,
      payload: { ...HELPER_PROFILE, webhookUrl, notifyHelp: false },
    });
    const muted = await api('POST', '/api/help-requests', {
      token: thirdToken,
      payload: { title: '开关验证：关闭接收求助', description: '此求助不应产生推送', tried: '无', helperUserId: helperId },
    });
    expect(muted.status).toBe(201);
    await new Promise((r) => setTimeout(r, 600));
    expect(webhookHits.length).toBe(baseline);

    await api('PUT', '/api/helpers/me', {
      token: helperToken,
      payload: { ...HELPER_PROFILE, webhookUrl, notifyReply: false },
    });
    const longDesc = '这是一段用来验证卡片截断效果的很长描述。'.repeat(10);
    const r = await api('POST', '/api/help-requests', {
      token: thirdToken,
      payload: { title: '开关验证：重新打开接收求助', description: longDesc, tried: '无', helperUserId: helperId },
    });
    switchRequestId = r.body.id;
    await waitFor(() => webhookHits.length >= baseline + 1);
    const cardText = JSON.stringify(JSON.parse(webhookHits[baseline].body).card);
    expect(cardText).toContain('…');
    expect(cardText).not.toContain(longDesc);
  });

  it('关闭「接收回复」后追问不推送；打开后收到回复卡片', async () => {
    const baseline = webhookHits.length;
    // 上一用例已把 helper 的 notifyReply 关掉：求助者追问 → helper 不收推送
    await api('POST', `/api/help-requests/${switchRequestId}/reply`, {
      token: thirdToken,
      payload: { content: '这条追问不应产生推送' },
    });
    await new Promise((r) => setTimeout(r, 600));
    expect(webhookHits.length).toBe(baseline);

    await api('PUT', '/api/helpers/me', { token: helperToken, payload: { ...HELPER_PROFILE, webhookUrl } });
    await api('POST', `/api/help-requests/${switchRequestId}/reply`, {
      token: thirdToken,
      payload: { content: '这条追问应收到回复卡片' },
    });
    await waitFor(() => webhookHits.length >= baseline + 1);
    const payload = JSON.parse(webhookHits[baseline].body);
    expect(payload.msg_type).toBe('interactive');
    expect(payload.card.header.title.content).toContain('新回复');
    const cardText = JSON.stringify(payload.card);
    expect(cardText).toContain('这条追问应收到回复卡片');
    expect(cardText).toContain('发送给 Agent');
  });
});

describe('经验沉淀', () => {
  it('仅被求助者可沉淀；未解决不可沉淀', async () => {
    const byRequester = await api('POST', `/api/help-requests/${requestId}/distill`, {
      token: requesterToken,
      payload: { public: false },
    });
    expect(byRequester.status).toBe(403);
    const unresolved = await api('POST', `/api/help-requests/${skillRequestId}/distill`, {
      token: helperToken,
      payload: { public: false },
    });
    expect(unresolved.status).toBe(409);
  });

  it('非公开沉淀（模板回退）：经验即 skill，granted 可见性只对双方生效', async () => {
    const r = await api('POST', `/api/help-requests/${requestId}/distill`, {
      token: helperToken,
      payload: { public: false, grantedToRequester: true, grantedToHelper: true, useAi: false, slug: 'exp-duizhang' },
    });
    expect(r.status).toBe(201);
    expect(r.body.aiUsed).toBe(false);
    expect(r.body.skillSlug).toBe('exp-duizhang');

    // 沉淀给自己（grantedToHelper=true）：helper 侧也建订阅（push 不再代劳）
    const helperBundle = await api('GET', '/api/skills/sync-bundle', { token: helperToken });
    expect(helperBundle.body.map((s: { slug: string }) => s.slug)).toContain('exp-duizhang');
    // 求助者可见、已被授予订阅、进入 sync
    const detail = await api('GET', '/api/skills/exp-duizhang', { token: requesterToken });
    expect(detail.status).toBe(200);
    expect(detail.body.source).toBe('experience');
    // 合成的标准 frontmatter：name=slug，description 用于本地 AI 触发
    expect(detail.body.content.startsWith('---\nname: exp-duizhang\ndescription: 经验沉淀：对账单里的差异字段是什么意思\n---\n\n')).toBe(true);
    expect(detail.body.content).toContain('状态差异先核对流水号');
    const bundle = await api('GET', '/api/skills/sync-bundle', { token: requesterToken });
    expect(bundle.body.map((s: { slug: string }) => s.slug)).toContain('exp-duizhang');
    // 第三人不可见
    expect((await api('GET', '/api/skills/exp-duizhang', { token: thirdToken })).status).toBe(404);
    // 求助者无权修改，被求助者可以
    const editByRequester = await api('POST', '/api/skills/push', {
      token: requesterToken,
      payload: { slug: 'exp-duizhang', name: 'x', description: '', content: '# 篡改' },
    });
    expect(editByRequester.status).toBe(403);
    const editByHelper = await api('PATCH', '/api/skills/exp-duizhang', {
      token: helperToken,
      payload: { description: '对账差异处理经验' },
    });
    expect(editByHelper.status).toBe(200);
    // 重复沉淀报冲突
    const again = await api('POST', `/api/help-requests/${requestId}/distill`, {
      token: helperToken,
      payload: { public: false },
    });
    expect(again.status).toBe(409);
  });

  it('经验搜索：参与者能搜到非公开经验，第三人不能', async () => {
    const mine = await api('GET', '/api/experiences?q=流水号', { token: requesterToken });
    expect(mine.body.map((e: { skillSlug: string }) => e.skillSlug)).toContain('exp-duizhang');
    const third = await api('GET', '/api/experiences?q=流水号', { token: thirdToken });
    expect(third.body).toEqual([]);
  });
});

describe('平台 AI 接入', () => {
  it('AI 设置仅管理员可配置，GET 打码', async () => {
    expect((await api('GET', '/api/admin/ai-settings', { token: helperToken })).status).toBe(403);
    const put = await api('PUT', '/api/admin/ai-settings', {
      token: adminToken,
      payload: { apiBaseUrl: aiBaseUrl, apiKey: 'sk-test-1234567890abcd', model: 'test-model', enabled: true },
    });
    expect(put.status).toBe(200);
    const get = await api('GET', '/api/admin/ai-settings', { token: adminToken });
    expect(get.body.apiKeyMasked).toBe('sk-t****abcd');
    expect(get.body.apiKeyMasked).not.toContain('1234567890');
  });

  it('连通性测试：key 留空回落已保存值，连不上返回 ok=false，仅管理员可用', async () => {
    expect((await api('POST', '/api/admin/ai-settings/test', { token: helperToken, payload: { apiBaseUrl: aiBaseUrl, apiKey: '', model: 'test-model' } })).status).toBe(403);

    const ok = await api('POST', '/api/admin/ai-settings/test', {
      token: adminToken,
      payload: { apiBaseUrl: aiBaseUrl, apiKey: '', model: 'test-model' },
    });
    expect(ok.status).toBe(200);
    expect(ok.body.ok).toBe(true);
    expect(ok.body.message).toContain('test-model');
    expect(typeof ok.body.latencyMs).toBe('number');

    // 指向无服务端口：连接被拒，测试端点仍 200，结果在 ok/message
    const bad = await api('POST', '/api/admin/ai-settings/test', {
      token: adminToken,
      payload: { apiBaseUrl: 'http://127.0.0.1:1/v1', apiKey: 'sk-explicit-key', model: 'test-model' },
    });
    expect(bad.status).toBe(200);
    expect(bad.body.ok).toBe(false);
  });

  it('AI 整理沉淀：内容来自模型，公开经验全员可搜', async () => {
    await api('POST', `/api/help-requests/${skillRequestId}/reply`, {
      token: helperToken,
      payload: { content: '冲销单在财务模块-单据-冲销里创建' },
    });
    await api('POST', `/api/help-requests/${skillRequestId}/resolve`, { token: requesterToken });
    const r = await api('POST', `/api/help-requests/${skillRequestId}/distill`, {
      token: helperToken,
      payload: { public: true, useAi: true, slug: 'exp-chongxiao' },
    });
    expect(r.status).toBe(201);
    expect(r.body.aiUsed).toBe(true);
    // 默认不沉淀给自己（未传 grantedToHelper）：不给 helper 建订阅，不进其本地 sync
    expect(r.body.grantedToHelper).toBe(false);
    const helperBundle = await api('GET', '/api/skills/sync-bundle', { token: helperToken });
    expect(helperBundle.body.map((s: { slug: string }) => s.slug)).not.toContain('exp-chongxiao');
    const skill = await api('GET', '/api/skills/exp-chongxiao', { token: thirdToken });
    expect(skill.status).toBe(200);
    expect(skill.body.content).toBe(
      `---\nname: exp-chongxiao\ndescription: 经验沉淀：ERP 里的冲销单怎么建\n---\n\n${AI_CONTENT}`,
    );
    const search = await api('GET', '/api/experiences?q=对账差异排查', { token: thirdToken });
    expect(search.body.map((e: { skillSlug: string }) => e.skillSlug)).toContain('exp-chongxiao');
  });
});

describe('求助删除', () => {
  it('仅求助者可删（被求助者 403、无关者 404）；删除连带对话记录', async () => {
    const r = await api('POST', '/api/help-requests', {
      token: thirdToken,
      payload: { title: '误发的求助', description: '发错人了', tried: '无', helperUserId: helperId },
    });
    expect(r.status).toBe(201);
    const delId = r.body.id;
    await api('POST', `/api/help-requests/${delId}/reply`, { token: helperToken, payload: { content: '收到' } });

    expect((await api('DELETE', `/api/help-requests/${delId}`, { token: helperToken })).status).toBe(403);
    expect((await api('DELETE', `/api/help-requests/${delId}`, { token: requesterToken })).status).toBe(404);

    expect((await api('DELETE', `/api/help-requests/${delId}`, { token: thirdToken })).status).toBe(200);
    expect((await api('GET', `/api/help-requests/${delId}`, { token: thirdToken })).status).toBe(404);
  });

  it('管理员可删任意求助；已沉淀为经验的求助不可删', async () => {
    const r = await api('POST', '/api/help-requests', {
      token: thirdToken,
      payload: { title: '待管理员清理', description: 'x', tried: 'x', helperUserId: helperId },
    });
    expect((await api('DELETE', `/api/help-requests/${r.body.id}`, { token: adminToken })).status).toBe(200);

    expect((await api('DELETE', `/api/help-requests/${requestId}`, { token: requesterToken })).status).toBe(409);
    expect((await api('DELETE', `/api/help-requests/${requestId}`, { token: adminToken })).status).toBe(409);
  });
});
