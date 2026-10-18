process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://dev@127.0.0.1:5433/eat_test';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq } from 'drizzle-orm';
import * as bcrypt from 'bcryptjs';
import { AppModule } from '../src/app.module';
import { DB, type Db } from '../src/db/db.module';
import * as schema from '../src/db/schema';
import { LlmGatewayService } from '../src/llm-gateway/llm-gateway.service';
import { loadConfig } from '../src/config';

let app: NestFastifyApplication, backend: Server, db: Db;
let base = '',
  admin = '',
  member = '',
  other = '',
  adminId = '',
  memberId = '',
  otherId = '';
let accountId = 7,
  sequence = 0,
  createCount = 0,
  failAfterCreate = false,
  failBeforeCreate = false,
  failAfterQuota = false,
  offline = false;
const tokens = new Map<number, any>();
let usageFixtures: any[] | undefined;
let lastLogQuery: URLSearchParams | undefined;
let holdTokenRead: { started: () => void; release: Promise<void> } | undefined;
const access = 'dedicated-ordinary-user-access-token';
const saved: Record<string, any> = {};
async function api(method: any, path: string, token: string, body?: unknown) {
  const r = await app.inject({
    method,
    url: path,
    headers: token ? { authorization: 'Bearer ' + token } : {},
    payload: body as never,
  });
  return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : undefined, headers: r.headers };
}
const id = () => ({ requestId: randomUUID() });
const raw = (n: number) => `not-a-prefix-secret-${n}-abcdefghijk`;
const keyOf = (userId: string) =>
  db.select().from(schema.llmGatewayKeys).where(eq(schema.llmGatewayKeys.userId, userId));
const view = (token: string) => api('GET', '/api/llm-gateway', token);
async function create(token: string, body = id()) {
  return api('POST', '/api/llm-gateway/key', token, body);
}

beforeAll(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await pool.query(
    'drop schema public cascade; create schema public; drop schema if exists drizzle cascade;',
  );
  await migrate(drizzle(pool), { migrationsFolder: resolve('drizzle') });
  const seed = drizzle(pool, { schema });
  const passwordHash = await bcrypt.hash('password123', 4);
  await seed.insert(schema.users).values([
    { name: '管理员', email: 'admin@llm.test', role: 'admin', passwordHash },
    { name: '成员', email: 'member@llm.test', passwordHash },
    { name: '另一成员', email: 'other@llm.test', passwordHash },
  ]);
  await pool.end();
  backend = createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://localhost');
    let text = '';
    for await (const c of req) text += c;
    const body = text ? JSON.parse(text) : {};
    const auth = String(req.headers.authorization ?? '').replace('Bearer ', '');
    let data: any = {},
      success = true,
      message = '';
    res.setHeader('content-type', 'application/json');
    if (offline) {
      res.statusCode = 503;
      res.end(JSON.stringify({ success: false, message: 'offline' }));
      return;
    }
    if (url.pathname === '/api/status')
      data = { quota_per_unit: 1000, quota_display_type: 'CNY', usd_exchange_rate: 2.5 };
    else if (url.pathname === '/v1/models') {
      const token = [...tokens.values()].find((t) => 'sk-' + t.key === auth);
      if (!token || token.status !== 1 || token.remain_quota <= 0) {
        res.statusCode = 403;
        success = false;
      }
      data = [{ id: 'model-a' }, { id: 'model-b' }];
    } else if (auth !== access && auth !== 'rotated-access-token') {
      res.statusCode = 401;
      success = false;
      message = 'unauthorized';
    } else if (url.pathname === '/api/user/self')
      data = { id: accountId, username: 'eat-service', role: 1, quota: 1000000, used_quota: 42 };
    else if (url.pathname === '/api/user/models') data = ['model-a', 'model-b'];
    else if (url.pathname === '/api/token/search')
      data = {
        items: [...tokens.values()].filter((t) => t.name.includes(url.searchParams.get('keyword')!)),
        total: tokens.size,
      };
    else if (url.pathname === '/api/token/' && req.method === 'POST') {
      if (failBeforeCreate) {
        failBeforeCreate = false;
        res.statusCode = 502;
        res.end(JSON.stringify({ success: false, message: 'uncertain create' }));
        return;
      }
      const n = ++sequence;
      createCount++;
      tokens.set(n, { id: n, user_id: accountId, ...body, status: 1, used_quota: 0, key: raw(n) });
      if (failAfterCreate) {
        failAfterCreate = false;
        res.statusCode = 502;
        success = false;
        message = 'lost create response';
      }
    } else if (url.pathname === '/api/token/' && req.method === 'PUT') {
      const token = tokens.get(body.id);
      if (!token) {
        success = false;
        message = 'record not found';
      } else if (url.searchParams.has('status_only')) token.status = body.status;
      else {
        expect(body.name).toBe(token.name);
        expect(body.expired_time).toBe(-1);
        Object.assign(token, body);
        if (failAfterQuota) {
          failAfterQuota = false;
          token.remain_quota -= 5;
          token.used_quota += 5;
          res.statusCode = 502;
          success = false;
          message = 'lost quota response';
        }
      }
    } else if (url.pathname === '/api/token/')
      data = {
        items: [...tokens.values()].slice(
          (Number(url.searchParams.get('p') ?? 1) - 1) * 100,
          Number(url.searchParams.get('p') ?? 1) * 100,
        ),
        total: tokens.size,
      };
    else if (/^\/api\/token\/\d+\/key$/.test(url.pathname))
      data = { key: tokens.get(Number(url.pathname.split('/')[3]))?.key };
    else if (/^\/api\/token\/\d+$/.test(url.pathname)) {
      data = structuredClone(tokens.get(Number(url.pathname.split('/')[3])));
      if (!data) {
        success = false;
        message = 'record not found';
      }
      if (holdTokenRead) {
        const hold = holdTokenRead;
        holdTokenRead = undefined;
        hold.started();
        await hold.release;
      }
    } else if (url.pathname === '/api/log/self') {
      lastLogQuery = url.searchParams;
      const name = url.searchParams.get('token_name');
      const own = [...tokens.values()].find((t) => t.name === name);
      const records =
        usageFixtures ??
        (own?.used_quota
          ? [
              {
                id: own.id,
                created_at: Math.floor(Date.now() / 1000),
                model_name: 'model-a',
                quota: own.used_quota,
                prompt_tokens: 2,
                completion_tokens: 3,
                type: 2,
                content: 'sensitive-upstream-content',
                token_name: name,
                user_id: 999,
                channel: 5,
              },
            ]
          : []);
      const start = Number(url.searchParams.get('start_timestamp') ?? 0);
      const end = Number(url.searchParams.get('end_timestamp') ?? Number.MAX_SAFE_INTEGER);
      const page = Number(url.searchParams.get('p') ?? 1);
      const pageSize = Number(url.searchParams.get('page_size') ?? 20);
      const matching = records
        .filter(
          (record) => record.token_name === name && record.created_at >= start && record.created_at <= end,
        )
        .sort((a, b) => b.created_at - a.created_at);
      data = {
        items: matching.slice((page - 1) * pageSize, page * pageSize),
        total: matching.length,
      };
    } else {
      res.statusCode = 404;
      success = false;
      message = 'missing endpoint';
    }
    res.end(JSON.stringify({ success, message, data }));
  });
  await new Promise<void>((r) => backend.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(backend.address() as any).port}`;
  app = (await Test.createTestingModule({ imports: [AppModule] }).compile()).createNestApplication(
    new FastifyAdapter(),
  );
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  db = app.get(DB);
  for (const [email, tokenName, idName] of [
    ['admin@llm.test', 'admin', 'adminId'],
    ['member@llm.test', 'member', 'memberId'],
    ['other@llm.test', 'other', 'otherId'],
  ]) {
    const login = await api('POST', '/api/auth/login', '', { email, password: 'password123' });
    saved[tokenName] = login.body.token;
    saved[idName] = login.body.user.id;
  }
  ({ admin, member, other, adminId, memberId, otherId } = saved);
});
afterAll(async () => {
  await app?.close();
  await new Promise<void>((r) => backend?.close(() => r()));
});

describe('LLM API 网关公共账户与个人 Key', () => {
  it('未配置可见，管理员与成员权限隔离，连接测试不落库', async () => {
    expect((await view(member)).body.configured).toBe(false);
    expect((await api('GET', '/api/admin/llm-gateway-settings', member)).status).toBe(403);
    const r = await api('POST', '/api/admin/llm-gateway-settings/test', admin, {
      apiUrl: base,
      accessToken: access,
    });
    expect(r.body.ok).toBe(true);
    expect((await view(member)).body.configured).toBe(false);
    expect(
      (await api('PUT', '/api/admin/llm-gateway-settings', admin, { apiUrl: base, accessToken: '' })).status,
    ).toBe(400);
  });
  it('保存加密令牌，自动发现普通账户，使用上游额度单位', async () => {
    const r = await api('PUT', '/api/admin/llm-gateway-settings', admin, {
      apiUrl: base + '/',
      accessToken: access,
      defaultQuota: 100,
    });
    expect(r.status).toBe(200);
    expect(r.body.accountId).toBe(7);
    expect(r.body.currency.quotaPerUnit).toBe(1000);
    expect(JSON.stringify(r.body)).not.toContain(access);
    const [row] = await db.select().from(schema.llmGatewaySettings);
    expect(row.accessTokenEncrypted).toMatch(/^v1\./);
    expect(row.accessTokenEncrypted).not.toContain(access);
    const wallet = await api('GET', '/api/admin/llm-gateway-settings/account', admin);
    expect(wallet.body.remainingQuota).toBe(1000000);
    expect((await api('GET', '/api/admin/llm-gateway-settings/account', member)).status).toBe(403);
  });
  it('显式 0 与继承区分；管理员自己也可以申请 Key', async () => {
    expect((await api('PUT', '/api/llm-gateway/key/status', admin, { ...id(), enabled: false })).status).toBe(
      400,
    );
    await api('PUT', `/api/admin/llm-gateway/users/${adminId}/policy`, admin, { ...id(), initialQuota: 0 });
    const a = await create(admin);
    expect(a.body.giftClaimed).toBe(true);
    expect(a.body.totalQuota).toBe(0);
    expect(a.body.key).toBeTruthy();
    expect((await view(member)).body.initialQuotaEffective).toBe(100);
    expect((await api('GET', '/api/llm-gateway/models', member)).body).toEqual([
      { id: 'model-a' },
      { id: 'model-b' },
    ]);
  });
  it('并发申请最多一把，重试不重复赠送；个人读取不能指定其他用户', async () => {
    const request = id();
    const result = await Promise.all([create(member, request), create(member, request)]);
    expect(result.some((r) => r.status === 200)).toBe(true);
    expect((await create(member, request)).body.remainingQuota).toBe(100);
    expect((await keyOf(memberId)).length).toBe(1);
    const response = await view(member);
    expect(response.body.key.maskedKey).toContain('*');
    expect(JSON.stringify(response.body)).not.toContain(raw(2));
    expect((await api('GET', `/api/llm-gateway?userId=${adminId}`, member)).body.userId).toBe(memberId);
    expect(
      (
        await api('POST', `/api/admin/llm-gateway/users/${memberId}/quota`, member, {
          ...id(),
          mode: 'add',
          quota: 100,
        })
      ).status,
    ).toBe(403);
  });
  it('创建已成功但响应丢失时按稳定标识恢复，不再次创建或发赠送', async () => {
    failAfterCreate = true;
    const request = id();
    const count = createCount;
    const r = await create(other, request);
    expect(r.body.pending).toBe(true);
    const recovered = await create(other, request);
    expect(recovered.body.pending).toBe(false);
    expect(recovered.body.remainingQuota).toBe(100);
    expect(createCount).toBe(count + 1);
  });
  it('Key 明文只通过本人专用接口返回，不缓存，读取审计', async () => {
    const r = await api('POST', '/api/llm-gateway/key/reveal', member, {});
    const [key] = await keyOf(memberId);
    expect(r.body.key).toBe('sk-' + raw(key.upstreamId!));
    expect(r.headers['cache-control']).toBe('no-store');
    const audit = await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.action, 'llm.key.read'));
    expect(audit.some((r) => r.actorId === memberId)).toBe(true);
    const all = await api('GET', '/api/admin/llm-gateway/users', admin);
    expect(JSON.stringify(all.body)).not.toContain(raw(key.upstreamId!));
  });
  it('消费权威来自上游；仅返回个人日志必要字段，不泄露公共账户数据', async () => {
    const [key] = await keyOf(memberId);
    const t = tokens.get(key.upstreamId!);
    t.remain_quota -= 20;
    t.used_quota += 20;
    const r = await view(member);
    expect(r.body.totalQuota).toBe(100);
    expect(r.body.usedQuota).toBe(20);
    expect(r.body.remainingQuota).toBe(80);
    const logs = await api('GET', '/api/llm-gateway/usage', member);
    expect(logs.body.items[0].quota).toBe(20);
    expect(JSON.stringify(logs.body)).not.toContain('sensitive-upstream-content');
    const [otherKey] = await keyOf(otherId);
    expect((await api('GET', `/api/llm-gateway/usage?keyId=${otherKey.id}`, member)).status).toBe(404);
    expect((await api('GET', '/api/llm-gateway/usage?page=-1', member)).status).toBe(400);
  });
  it('消耗查询在上游按最近 30 天过滤并分页，不能通过额外参数扩大范围', async () => {
    const [key] = await keyOf(memberId);
    const end = Math.floor(Date.now() / 1000);
    const start = end - 30 * 24 * 60 * 60;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(end * 1000);
    const entry = {
      token_name: key.upstreamName,
      model_name: 'model-a',
      quota: 1,
      prompt_tokens: 2,
      completion_tokens: 3,
      type: 2,
    };
    usageFixtures = [
      { ...entry, id: 101, created_at: start - 1 },
      { ...entry, id: 102, created_at: start },
      { ...entry, id: 103, created_at: end },
      { ...entry, id: 104, created_at: end + 1 },
      { ...entry, id: 105, created_at: end, token_name: 'another-users-key' },
    ];
    try {
      const first = await api('GET', '/api/llm-gateway/usage?page=1&pageSize=1&start_timestamp=0', member);
      expect(first.status).toBe(200);
      expect(first.body.total).toBe(2);
      expect(first.body.items.map((item: any) => item.id)).toEqual(['103']);
      expect(lastLogQuery?.get('start_timestamp')).toBe(String(start));
      expect(lastLogQuery?.get('end_timestamp')).toBe(String(end));
      expect(lastLogQuery?.get('token_name')).toBe(key.upstreamName);
      const second = await api('GET', '/api/llm-gateway/usage?page=2&pageSize=1', member);
      expect(second.body.page).toBe(2);
      expect(second.body.pageSize).toBe(1);
      expect(second.body.total).toBe(2);
      expect(second.body.items.map((item: any) => item.id)).toEqual(['102']);
      expect(lastLogQuery?.get('p')).toBe('2');
      expect(lastLogQuery?.get('page_size')).toBe('1');
    } finally {
      usageFixtures = undefined;
      clock.mockRestore();
    }
  });
  it('原生额度配置支持加、减、设置；幂等重试与期间消费不重复加款', async () => {
    const request = { ...id(), mode: 'add', quota: 50 };
    const path = `/api/admin/llm-gateway/users/${memberId}/quota`;
    failAfterQuota = true;
    const first = await api('POST', path, admin, request);
    expect(first.body.pending).toBe(true);
    const retry = await api('POST', path, admin, request);
    expect(retry.body.pending).toBe(false);
    expect(retry.body.usedQuota).toBe(25);
    expect(retry.body.remainingQuota).toBe(125);
    expect(retry.body.totalQuota).toBe(150);
    expect((await api('POST', path, admin, request)).body.totalQuota).toBe(150);
    expect((await api('POST', path, admin, { ...request, quota: 500 })).status).toBe(409);
    expect(
      (await api('POST', path, admin, { ...id(), mode: 'subtract', quota: 25 })).body.remainingQuota,
    ).toBe(100);
    expect((await api('POST', path, admin, { ...id(), mode: 'set', quota: 70 })).body.totalQuota).toBe(95);
    expect((await api('POST', path, admin, { ...id(), mode: 'subtract', quota: 71 })).status).toBe(400);
    expect(
      (await api('POST', path, admin, { ...id(), mode: 'add', quota: Number.MAX_SAFE_INTEGER })).status,
    ).toBe(400);
  });
  it('个人启停与管理员禁用独立，恢复权限不覆盖个人停用', async () => {
    await api('PUT', '/api/llm-gateway/key/status', member, { ...id(), enabled: false });
    await api('PUT', `/api/admin/llm-gateway/users/${memberId}/policy`, admin, { ...id(), disabled: true });
    expect((await create(member)).status).toBe(403);
    expect((await api('POST', '/api/llm-gateway/key/reveal', member, {})).status).toBe(403);
    await api('PUT', `/api/admin/llm-gateway/users/${memberId}/policy`, admin, { ...id(), disabled: false });
    expect((await view(member)).body.key.status).toBe('disabled');
    expect(
      (await api('PUT', '/api/llm-gateway/key/status', member, { ...id(), enabled: true })).body.key.status,
    ).toBe('active');
  });
  it('删除重建保留消耗和余额、只赠送一次，旧 Key 不再可用', async () => {
    const [old] = await keyOf(memberId);
    let release!: () => void;
    let started!: () => void;
    const didStart = new Promise<void>((r) => {
      started = r;
    });
    holdTokenRead = {
      started,
      release: new Promise<void>((r) => {
        release = r;
      }),
    };
    const delayedRead = view(member);
    await didStart;
    const removal = await api('DELETE', '/api/llm-gateway/key', member, id());
    release();
    await delayedRead;
    expect(removal.body.key).toBeNull();
    expect((await view(member)).body.key).toBeNull();
    expect(removal.body.usedQuota).toBe(25);
    expect(removal.body.remainingQuota).toBe(70);
    expect(tokens.get(old.upstreamId!).status).toBe(2);
    await api('PUT', '/api/admin/llm-gateway-settings', admin, {
      apiUrl: base,
      accessToken: '',
      defaultQuota: 999,
    });
    const r = await create(member);
    expect(r.body.remainingQuota).toBe(70);
    expect(r.body.usedQuota).toBe(25);
    expect(r.body.totalQuota).toBe(95);
    expect((await keyOf(memberId)).filter((k) => k.state !== 'retired')).toHaveLength(1);
    const history = await api('GET', '/api/llm-gateway/keys/history', member);
    expect(history.body).toHaveLength(2);
    const oldLog = await api('GET', `/api/llm-gateway/usage?keyId=${old.id}`, member);
    expect(oldLog.body.items[0].quota).toBe(25);
  });
  it('保留停用上游记录追踪迟到扣费和退款，补偿当前 Key 余额', async () => {
    const list = await keyOf(memberId);
    const old = list.find((r) => r.state === 'retired')!;
    tokens.get(old.upstreamId!).used_quota += 3;
    tokens.get(old.upstreamId!).remain_quota -= 3;
    await app.get(LlmGatewayService).sweep();
    expect((await view(member)).body.remainingQuota).toBe(67);
    expect((await view(member)).body.usedQuota).toBe(28);
  });
  it('绑定同账户令牌可轮换，已有 Key 禁止切换实例或账户', async () => {
    expect(
      (
        await api('PUT', '/api/admin/llm-gateway-settings', admin, {
          apiUrl: base,
          accessToken: 'rotated-access-token',
          defaultQuota: 999,
        })
      ).status,
    ).toBe(200);
    accountId = 8;
    expect(
      (
        await api('PUT', '/api/admin/llm-gateway-settings', admin, {
          apiUrl: base,
          accessToken: access,
          defaultQuota: 0,
        })
      ).status,
    ).toBe(409);
    accountId = 7;
    expect(
      (
        await api('PUT', '/api/admin/llm-gateway-settings', admin, {
          apiUrl: base,
          accessToken: '',
          defaultQuota: 999,
        })
      ).status,
    ).toBe(200);
  });
  it('EAT 账户禁用同步停 Key，失败会持久化，模块重启后可恢复', async () => {
    offline = true;
    const blocked = await api('PUT', `/api/admin/llm-gateway/users/${otherId}/policy`, admin, {
      ...id(),
      disabled: true,
    });
    expect(blocked.body.disabled).toBe(true);
    expect(blocked.body.pending).toBe(true);
    const disable = await api('PATCH', `/api/users/${otherId}`, admin, { status: 'disabled' });
    expect(disable.status).toBe(200);
    expect(disable.body.llmGatewaySyncPending).toBe(true);
    const cached = await api('GET', '/api/admin/llm-gateway/users', admin);
    expect(cached.status).toBe(200);
    expect(cached.body.find((u: any) => u.userId === otherId).pending).toBe(true);
    expect(cached.body.find((u: any) => u.userId === memberId).error).toBeTruthy();
    const op = (
      await db
        .select()
        .from(schema.llmGatewayOperations)
        .where(eq(schema.llmGatewayOperations.userId, otherId))
    ).find((o) => o.state === 'pending');
    expect(op).toBeTruthy();
    offline = false;
    await app.close();
    app = (await Test.createTestingModule({ imports: [AppModule] }).compile()).createNestApplication(
      new FastifyAdapter(),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    db = app.get(DB);
    await app.get(LlmGatewayService).sweep();
    const [key] = await keyOf(otherId);
    expect(tokens.get(key.upstreamId!).status).toBe(2);
    expect((await view(other)).status).toBe(401);
  });
  it('结果不确定且暂未查询到 Key 时不盲目重发；延迟出现后可以恢复', async () => {
    const created = await api('POST', '/api/users', admin, {
      name: '延迟创建成员',
      email: 'late@llm.test',
      password: 'password123',
      role: 'member',
    });
    const login = await api('POST', '/api/auth/login', '', {
      email: 'late@llm.test',
      password: 'password123',
    });
    failBeforeCreate = true;
    const count = createCount;
    const request = id();
    expect((await create(login.body.token, request)).body.pending).toBe(true);
    expect((await create(login.body.token, request)).body.pending).toBe(true);
    expect(createCount).toBe(count);
    const [pendingKey] = await keyOf(created.body.id);
    const n = ++sequence;
    tokens.set(n, {
      id: n,
      user_id: 7,
      name: pendingKey.upstreamName,
      key: raw(n),
      status: 1,
      remain_quota: 999,
      used_quota: 0,
      expired_time: -1,
      unlimited_quota: false,
      group: '',
      model_limits: '',
      model_limits_enabled: false,
    });
    const recovered = await api('POST', '/api/llm-gateway/retry', login.body.token, {});
    expect(recovered.body.pending).toBe(false);
    expect(recovered.body.remainingQuota).toBe(999);
  });
  it('新的成功操作清除旧失败提示，余额为零加额后可恢复使用', async () => {
    const path = `/api/admin/llm-gateway/users/${adminId}/quota`;
    expect((await api('POST', path, admin, { ...id(), mode: 'subtract', quota: 10 })).status).toBe(400);
    const result = await api('POST', path, admin, { ...id(), mode: 'add', quota: 10 });
    expect(result.body.error).toBeNull();
    expect(result.body.key.status).toBe('active');
  });
  it('不同用户同时申请不会耗尽数据库连接造成锁与查询互相等待', async () => {
    const hash = await bcrypt.hash('parallel-password', 4);
    const people = await db
      .insert(schema.users)
      .values(
        Array.from({ length: 12 }, (_, n) => ({
          name: `并发成员${n}`,
          email: `parallel${n}@llm.test`,
          passwordHash: hash,
        })),
      )
      .returning();
    const result = await Promise.all(
      people.map((u) => app.get(LlmGatewayService).operate(u.id, adminId, 'create', randomUUID())),
    );
    expect(result.every((r) => r.key && !r.pending && !r.error)).toBe(true);
    for (const user of people) expect(await keyOf(user.id)).toHaveLength(1);
  });
  it('生产环境直接使用 New API 原生接口申请、调额和启停，无需额外开关', async () => {
    try {
      vi.stubEnv('EAT_KEK', loadConfig().kek);
      vi.stubEnv('NODE_ENV', 'production');
      const created = await api('POST', '/api/users', admin, {
        name: '生产环境成员',
        email: 'production@llm.test',
        password: 'password123',
        role: 'member',
      });
      expect(created.status).toBe(201);
      const login = await api('POST', '/api/auth/login', '', {
        email: 'production@llm.test',
        password: 'password123',
      });
      const token = login.body.token;
      const count = createCount;
      const applied = await create(token);
      expect(applied.status).toBe(200);
      expect(applied.body.pending).toBe(false);
      expect(applied.body.key.status).toBe('active');
      expect(createCount).toBe(count + 1);
      const adjusted = await api('POST', `/api/admin/llm-gateway/users/${created.body.id}/quota`, admin, {
        ...id(),
        mode: 'add',
        quota: 100,
      });
      expect(adjusted.status).toBe(200);
      expect(adjusted.body.pending).toBe(false);
      expect(adjusted.body.remainingQuota).toBe(applied.body.remainingQuota + 100);
      const stopped = await api('PUT', '/api/llm-gateway/key/status', token, { ...id(), enabled: false });
      expect(stopped.status).toBe(200);
      expect(stopped.body.key.status).toBe('disabled');
      const enabled = await api('PUT', '/api/llm-gateway/key/status', token, { ...id(), enabled: true });
      expect(enabled.status).toBe(200);
      expect(enabled.body.pending).toBe(false);
      expect(enabled.body.key.status).toBe('active');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
