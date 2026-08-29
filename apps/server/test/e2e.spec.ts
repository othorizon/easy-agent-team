/**
 * 端到端测试：连真实 PostgreSQL（eat_test），覆盖 P0 全链路。
 * 前置：scripts/dev-db.sh start（端口 5433）
 */
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://dev@127.0.0.1:5433/eat_test';

import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcryptjs';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import * as path from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import * as schema from '../src/db/schema';

let app: NestFastifyApplication;
let adminToken: string;
let memberToken: string;
let memberId: string;
let cliToken: string;

async function api(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  opts: { token?: string; payload?: unknown } = {},
) {
  const res = await app.inject({
    method,
    url,
    payload: opts.payload as never,
    headers: opts.token ? { authorization: `Bearer ${opts.token}` } : {},
  });
  const body = res.body ? JSON.parse(res.body) : undefined;
  return { status: res.statusCode, body };
}

beforeAll(async () => {
  // 重建测试库 schema
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await pool.query('drop schema public cascade; create schema public; drop schema if exists drizzle cascade;');
  // vitest 以 apps/server 为 cwd 运行
  await migrate(drizzle(pool), { migrationsFolder: path.resolve(process.cwd(), 'drizzle') });
  const db = drizzle(pool, { schema });
  const hash = await bcrypt.hash('password123', 4);
  await db.insert(schema.users).values([
    { name: '管理员', email: 'admin@test.dev', role: 'admin', passwordHash: hash },
    { name: '成员小王', email: 'member@test.dev', role: 'member', passwordHash: hash },
  ]);
  await pool.end();

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});

afterAll(async () => {
  await app?.close();
});

describe('认证', () => {
  it('健康检查无需登录', async () => {
    const r = await api('GET', '/api/health');
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
  });

  it('密码错误返回 401', async () => {
    const r = await api('POST', '/api/auth/login', {
      payload: { email: 'admin@test.dev', password: 'wrong' },
    });
    expect(r.status).toBe(401);
    expect(r.body.error).toBe('UNAUTHORIZED');
  });

  it('管理员与成员登录成功', async () => {
    const a = await api('POST', '/api/auth/login', {
      payload: { email: 'admin@test.dev', password: 'password123' },
    });
    expect(a.status).toBe(201);
    adminToken = a.body.token;
    const m = await api('POST', '/api/auth/login', {
      payload: { email: 'member@test.dev', password: 'password123' },
    });
    memberToken = m.body.token;
    memberId = m.body.user.id;
    expect(memberToken).toMatch(/^eat_/);
  });

  it('whoami 返回当前用户；无 Token 返回 401', async () => {
    const r = await api('GET', '/api/auth/whoami', { token: adminToken });
    expect(r.body.role).toBe('admin');
    const noToken = await api('GET', '/api/auth/whoami');
    expect(noToken.status).toBe(401);
  });
});

describe('环境变量：可见性与权限', () => {
  it('管理员创建环境与变量（一个默认可见、一个无权限不可见）', async () => {
    const env = await api('POST', '/api/envs', {
      token: adminToken,
      payload: { slug: 'internal-services', name: '内部服务', description: '公司内部服务的密钥' },
    });
    expect(env.status).toBe(201);
    const v1 = await api('POST', '/api/envs/internal-services/variables', {
      token: adminToken,
      payload: { key: 'API_TOKEN', value: 'tok-123', description: '内部网关的调用令牌' },
    });
    expect(v1.status).toBe(201);
    expect(v1.body.hasAccess).toBe(true);
    const v2 = await api('POST', '/api/envs/internal-services/variables', {
      token: adminToken,
      payload: {
        key: 'SECRET_HIDDEN',
        value: 'shh',
        description: '高敏密钥',
        visibleWithoutPermission: false,
      },
    });
    expect(v2.status).toBe(201);
  });

  it('非 Owner 不能写变量', async () => {
    const r = await api('POST', '/api/envs/internal-services/variables', {
      token: memberToken,
      payload: { key: 'X', value: 'y' },
    });
    expect(r.status).toBe(403);
  });

  it('成员清单：可见 API_TOKEN(hasAccess=false)，看不到 SECRET_HIDDEN', async () => {
    const r = await api('GET', '/api/envs/internal-services/variables', { token: memberToken });
    const keys = r.body.map((v: { key: string }) => v.key);
    expect(keys).toEqual(['API_TOKEN']);
    expect(r.body[0].hasAccess).toBe(false);
    expect(r.body[0].description).toContain('令牌');
  });

  it('管理员清单看到全部且 hasAccess=true', async () => {
    const r = await api('GET', '/api/envs/internal-services/variables', { token: adminToken });
    expect(r.body.map((v: { key: string }) => v.key).sort()).toEqual(['API_TOKEN', 'SECRET_HIDDEN']);
    expect(r.body.every((v: { hasAccess: boolean }) => v.hasAccess)).toBe(true);
  });

  it('成员拉取值：结构化 PERMISSION_REQUIRED', async () => {
    const r = await api('POST', '/api/envs/internal-services/values', {
      token: memberToken,
      payload: { keys: ['API_TOKEN'] },
    });
    expect(r.status).toBe(201);
    expect(r.body.values).toEqual({});
    expect(r.body.denied[0]).toMatchObject({ key: 'API_TOKEN', error: 'PERMISSION_REQUIRED' });
    expect(r.body.denied[0].howToRequest).toContain('request_access');
  });
});

describe('权限申请审批闭环', () => {
  let requestId: string;

  it('申请不存在的变量被拒绝', async () => {
    const r = await api('POST', '/api/access-requests', {
      token: memberToken,
      payload: { environmentSlug: 'internal-services', keys: ['NOPE'], reason: '测试' },
    });
    expect(r.status).toBe(400);
  });

  it('成员发起申请，出现在管理员 inbox', async () => {
    const r = await api('POST', '/api/access-requests', {
      token: memberToken,
      payload: {
        environmentSlug: 'internal-services',
        keys: ['API_TOKEN'],
        reason: 'AI 需要调用内部网关完成周报任务',
      },
    });
    expect(r.status).toBe(201);
    requestId = r.body.id;
    const inbox = await api('GET', '/api/access-requests/inbox', { token: adminToken });
    expect(inbox.body.map((x: { id: string }) => x.id)).toContain(requestId);
    // 申请者自己的 inbox 不该有（不是审批人）
    const memberInbox = await api('GET', '/api/access-requests/inbox', { token: memberToken });
    expect(memberInbox.body).toEqual([]);
  });

  it('非审批人不能决策', async () => {
    const r = await api('POST', `/api/access-requests/${requestId}/decision`, {
      token: memberToken,
      payload: { decision: 'approved' },
    });
    expect(r.status).toBe(403);
  });

  it('管理员批准（带有效期）后成员可拉取值', async () => {
    const expires = new Date(Date.now() + 3600_000).toISOString();
    const d = await api('POST', `/api/access-requests/${requestId}/decision`, {
      token: adminToken,
      payload: { decision: 'approved', grantExpiresAt: expires },
    });
    expect(d.body.status).toBe('approved');
    const pull = await api('POST', '/api/envs/internal-services/values', {
      token: memberToken,
      payload: { keys: ['API_TOKEN'] },
    });
    expect(pull.body.values.API_TOKEN).toBe('tok-123');
    expect(pull.body.denied).toEqual([]);
    // 重复决策报冲突
    const again = await api('POST', `/api/access-requests/${requestId}/decision`, {
      token: adminToken,
      payload: { decision: 'rejected' },
    });
    expect(again.status).toBe(409);
  });

  it('敏感读取已落审计', async () => {
    const r = await api('GET', '/api/audit?action=secret.read', { token: adminToken });
    const mine = r.body.filter((x: { meta: { keys: string[] } }) => x.meta?.keys?.includes('API_TOKEN'));
    expect(mine.length).toBeGreaterThan(0);
    // 审计接口仅管理员可用
    const forbidden = await api('GET', '/api/audit', { token: memberToken });
    expect(forbidden.status).toBe(403);
  });
});

describe('授权有效期与环境级授权', () => {
  it('过期授权不生效', async () => {
    const vars = await api('GET', '/api/envs/internal-services/variables', { token: adminToken });
    const hidden = vars.body.find((v: { key: string }) => v.key === 'SECRET_HIDDEN');
    const r = await api('POST', '/api/envs/internal-services/grants', {
      token: adminToken,
      payload: {
        userId: memberId,
        variableId: hidden.id,
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      },
    });
    expect(r.status).toBe(201);
    const pull = await api('POST', '/api/envs/internal-services/values', {
      token: memberToken,
      payload: { keys: ['SECRET_HIDDEN'] },
    });
    expect(pull.body.denied[0].key).toBe('SECRET_HIDDEN');
  });

  it('环境级授权覆盖全部变量', async () => {
    const envs = await api('GET', '/api/envs', { token: adminToken });
    const env = envs.body.find((e: { slug: string }) => e.slug === 'internal-services');
    await api('POST', '/api/envs/internal-services/grants', {
      token: adminToken,
      payload: { userId: memberId, environmentId: env.id },
    });
    const pull = await api('POST', '/api/envs/internal-services/values', {
      token: memberToken,
      payload: {},
    });
    expect(pull.body.values.SECRET_HIDDEN).toBe('shh');
    expect(pull.body.values.API_TOKEN).toBe('tok-123');
  });
});

describe('设备码授权（CLI 登录）', () => {
  it('完整流程：start → approve → poll 取 Token → whoami', async () => {
    const start = await api('POST', '/api/auth/device/start');
    expect(start.body.userCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);

    const pending = await api('POST', '/api/auth/device/poll', {
      payload: { deviceCode: start.body.deviceCode },
    });
    expect(pending.body.status).toBe('pending');

    const approve = await api('POST', '/api/auth/device/approve', {
      token: memberToken,
      payload: { userCode: start.body.userCode, tokenName: '测试机 CLI' },
    });
    expect(approve.status).toBe(201);

    const poll = await api('POST', '/api/auth/device/poll', {
      payload: { deviceCode: start.body.deviceCode },
    });
    expect(poll.body.status).toBe('approved');
    cliToken = poll.body.token;
    const who = await api('GET', '/api/auth/whoami', { token: cliToken });
    expect(who.body.email).toBe('member@test.dev');

    // Token 只交付一次
    const again = await api('POST', '/api/auth/device/poll', {
      payload: { deviceCode: start.body.deviceCode },
    });
    expect(again.body.status).toBe('expired');
  });

  it('吊销 Token 后立即失效', async () => {
    const tokens = await api('GET', '/api/auth/tokens', { token: memberToken });
    const cli = tokens.body.find((t: { name: string }) => t.name === '测试机 CLI');
    await api('DELETE', `/api/auth/tokens/${cli.id}`, { token: memberToken });
    const who = await api('GET', '/api/auth/whoami', { token: cliToken });
    expect(who.status).toBe(401);
  });
});

describe('变量更新与删除', () => {
  it('更新值 version 递增，拉到新值', async () => {
    const r = await api('POST', '/api/envs/internal-services/variables', {
      token: adminToken,
      payload: { key: 'API_TOKEN', value: 'tok-456', description: '内部网关的调用令牌（已轮换）' },
    });
    expect(r.body.version).toBe(2);
    const pull = await api('POST', '/api/envs/internal-services/values', {
      token: adminToken,
      payload: { keys: ['API_TOKEN'] },
    });
    expect(pull.body.values.API_TOKEN).toBe('tok-456');
  });

  it('删除变量后不可再拉取', async () => {
    await api('DELETE', '/api/envs/internal-services/variables/API_TOKEN', { token: adminToken });
    const pull = await api('POST', '/api/envs/internal-services/values', {
      token: adminToken,
      payload: { keys: ['API_TOKEN'] },
    });
    expect(pull.body.denied[0].key).toBe('API_TOKEN');
  });
});

describe('非敏感变量（明文存储、全员明文可读）', () => {
  it('创建非敏感变量：清单直接带明文值，成员免授权可读', async () => {
    await api('POST', '/api/envs', {
      token: adminToken,
      payload: { slug: 'plain-env', name: '公共配置', description: '非敏感的服务地址等' },
    });
    const created = await api('POST', '/api/envs/plain-env/variables', {
      token: adminToken,
      payload: { key: 'SERVICE_URL', value: 'https://svc.internal:8080', description: '内部服务地址', secret: false },
    });
    expect(created.status).toBe(201);
    expect(created.body.secret).toBe(false);
    expect(created.body.value).toBe('https://svc.internal:8080');
    // 对照：敏感变量清单不含值
    await api('POST', '/api/envs/plain-env/variables', {
      token: adminToken,
      payload: { key: 'PLAIN_ENV_TOKEN', value: 'sec-token-value-12345', description: '敏感令牌' },
    });

    // 成员无任何授权：清单里非敏感变量带明文值且 hasAccess=true
    const list = await api('GET', '/api/envs/plain-env/variables', { token: memberToken });
    const plain = list.body.find((v: { key: string }) => v.key === 'SERVICE_URL');
    expect(plain.hasAccess).toBe(true);
    expect(plain.value).toBe('https://svc.internal:8080');
    const secretVar = list.body.find((v: { key: string }) => v.key === 'PLAIN_ENV_TOKEN');
    expect(secretVar.hasAccess).toBe(false);
    expect(secretVar.value).toBeNull();

    // 成员直接拉取非敏感值成功；缺省拉取也包含非敏感值、敏感值不在其中
    const pull = await api('POST', '/api/envs/plain-env/values', { token: memberToken, payload: {} });
    expect(pull.body.values).toEqual({ SERVICE_URL: 'https://svc.internal:8080' });
    expect(pull.body.denied).toEqual([]);
  });

  it('非敏感值读取不落 secret.read 审计', async () => {
    const r = await api('GET', '/api/audit?action=secret.read', { token: adminToken });
    const hits = r.body.filter((x: { meta: { keys?: string[] } }) => x.meta?.keys?.includes('SERVICE_URL'));
    expect(hits).toEqual([]);
  });

  it('敏感性可切换：改敏感后需授权，改回后恢复明文', async () => {
    const toSecret = await api('POST', '/api/envs/plain-env/variables', {
      token: adminToken,
      payload: { key: 'SERVICE_URL', value: 'https://svc.internal:9090', description: '', secret: true },
    });
    expect(toSecret.body.secret).toBe(true);
    expect(toSecret.body.value).toBeNull();
    const denied = await api('POST', '/api/envs/plain-env/values', {
      token: memberToken,
      payload: { keys: ['SERVICE_URL'] },
    });
    expect(denied.body.denied[0].error).toBe('PERMISSION_REQUIRED');

    const back = await api('POST', '/api/envs/plain-env/variables', {
      token: adminToken,
      payload: { key: 'SERVICE_URL', value: 'https://svc.internal:8080', description: '', secret: false },
    });
    expect(back.body.value).toBe('https://svc.internal:8080');
    const pull = await api('POST', '/api/envs/plain-env/values', {
      token: memberToken,
      payload: { keys: ['SERVICE_URL'] },
    });
    expect(pull.body.values.SERVICE_URL).toBe('https://svc.internal:8080');
  });

  it('非敏感变量不进入密钥指纹清单', async () => {
    await api('POST', '/api/envs/plain-env/variables', {
      token: adminToken,
      payload: { key: 'PLAIN_LONG', value: 'plain-but-long-value-1234567890', description: '', secret: false },
    });
    const r = await api('GET', '/api/secret-fingerprints', { token: adminToken });
    const keys = r.body.map((f: { key: string }) => f.key);
    expect(keys).not.toContain('PLAIN_LONG');
    expect(keys).toContain('PLAIN_ENV_TOKEN');
  });
});

describe('环境编辑与删除', () => {
  it('非 Owner 不能编辑/删除环境', async () => {
    expect((await api('PATCH', '/api/envs/plain-env', { token: memberToken, payload: { name: 'x' } })).status).toBe(403);
    expect((await api('DELETE', '/api/envs/plain-env', { token: memberToken })).status).toBe(403);
  });

  it('Owner 更新名称与备注', async () => {
    const r = await api('PATCH', '/api/envs/plain-env', {
      token: adminToken,
      payload: { name: '公共配置（新）', description: '改过的备注' },
    });
    expect(r.status).toBe(200);
    const envs = await api('GET', '/api/envs', { token: memberToken });
    const env = envs.body.find((e: { slug: string }) => e.slug === 'plain-env');
    expect(env.name).toBe('公共配置（新）');
    expect(env.description).toBe('改过的备注');
  });

  it('删除环境后从列表消失，变量一并删除', async () => {
    expect((await api('DELETE', '/api/envs/plain-env', { token: adminToken })).status).toBe(200);
    const envs = await api('GET', '/api/envs', { token: adminToken });
    expect(envs.body.map((e: { slug: string }) => e.slug)).not.toContain('plain-env');
    expect((await api('GET', '/api/envs/plain-env/variables', { token: adminToken })).status).toBe(404);
  });
});
