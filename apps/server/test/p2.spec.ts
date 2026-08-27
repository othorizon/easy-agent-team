/**
 * P2 端到端测试：角色模板 / MCP 配置分发（引用渲染）/ 数据库账号分配。
 * 数据库部分对本地 PostgreSQL(5433) 做真实建库、连接、禁用、删除验证。
 */
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://dev@127.0.0.1:5433/eat_test';

import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcryptjs';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import * as path from 'node:path';
import { Client, Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import * as schema from '../src/db/schema';

let app: NestFastifyApplication;
let adminToken: string;
let m1Token: string; // 小王
let m2Token: string; // 小张

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

beforeAll(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await pool.query('drop schema public cascade; create schema public; drop schema if exists drizzle cascade;');
  await migrate(drizzle(pool), { migrationsFolder: path.resolve(process.cwd(), 'drizzle') });
  const db = drizzle(pool, { schema });
  const hash = await bcrypt.hash('password123', 4);
  await db.insert(schema.users).values([
    { name: '管理员', email: 'admin@test.dev', role: 'admin', passwordHash: hash },
    { name: '小王', email: 'wang@test.dev', role: 'member', passwordHash: hash },
    { name: '小张', email: 'zhang@test.dev', role: 'member', passwordHash: hash },
  ]);
  // 清理可能残留的真实库/账号（上次测试中断时）
  await pool.query(`drop database if exists proj_wang`).catch(() => undefined);
  await pool.query(`drop database if exists proj_zhang`).catch(() => undefined);
  await pool.query(`drop role if exists u_proj_wang`).catch(() => undefined);
  await pool.query(`drop role if exists u_proj_zhang`).catch(() => undefined);
  await pool.end();

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  const login = async (email: string) =>
    (await api('POST', '/api/auth/login', { payload: { email, password: 'password123' } })).body.token;
  adminToken = await login('admin@test.dev');
  m1Token = await login('wang@test.dev');
  m2Token = await login('zhang@test.dev');
});

afterAll(async () => {
  await app?.close();
});

let templateId: string;
const skillIds: Record<string, string> = {};

describe('角色模板', () => {
  it('仅管理员可创建模板与设置条目', async () => {
    expect((await api('POST', '/api/templates', { token: m1Token, payload: { name: 'x' } })).status).toBe(403);
    const r = await api('POST', '/api/templates', {
      token: adminToken,
      payload: { name: '运营', description: '运营岗的标准能力套餐' },
    });
    expect(r.status).toBe(201);
    templateId = r.body.id;

    for (const s of ['tpl-skill-a', 'tpl-skill-b', 'tpl-skill-c']) {
      const push = await api('POST', '/api/skills/push', {
        token: adminToken,
        payload: { slug: s, name: s, description: `${s} 描述`, content: `# ${s}` },
      });
      skillIds[s] = push.body.id;
    }
    const bad = await api('PUT', `/api/templates/${templateId}/items`, {
      token: adminToken,
      payload: { items: [{ itemType: 'skill', itemId: '00000000-0000-0000-0000-000000000000' }] },
    });
    expect(bad.status).toBe(400);
    const ok = await api('PUT', `/api/templates/${templateId}/items`, {
      token: adminToken,
      payload: {
        items: [
          { itemType: 'skill', itemId: skillIds['tpl-skill-a'] },
          { itemType: 'skill', itemId: skillIds['tpl-skill-b'] },
        ],
      },
    });
    expect(ok.status).toBe(200);
  });

  it('成员选用模板后 sync-bundle 合并模板 skill（relation=template）', async () => {
    await api('POST', `/api/templates/${templateId}/select`, { token: m1Token });
    const list = await api('GET', '/api/templates', { token: m1Token });
    expect(list.body.find((t: { id: string }) => t.id === templateId).selectedByMe).toBe(true);

    const bundle = await api('GET', '/api/skills/sync-bundle', { token: m1Token });
    const slugs = bundle.body.map((s: { slug: string }) => s.slug).sort();
    expect(slugs).toEqual(['tpl-skill-a', 'tpl-skill-b']);
    expect(bundle.body[0].relation).toBe('template');
  });

  it('排除模板条目：退订某项后从 bundle 消失，重新订阅恢复', async () => {
    await api('DELETE', '/api/skills/tpl-skill-b/subscribe', { token: m1Token });
    let bundle = await api('GET', '/api/skills/sync-bundle', { token: m1Token });
    expect(bundle.body.map((s: { slug: string }) => s.slug)).toEqual(['tpl-skill-a']);

    await api('POST', '/api/skills/tpl-skill-b/subscribe', { token: m1Token });
    bundle = await api('GET', '/api/skills/sync-bundle', { token: m1Token });
    expect(bundle.body.map((s: { slug: string }) => s.slug).sort()).toEqual(['tpl-skill-a', 'tpl-skill-b']);
  });

  it('模板更新自动生效；取消选用后仅保留手动订阅', async () => {
    await api('PUT', `/api/templates/${templateId}/items`, {
      token: adminToken,
      payload: {
        items: [
          { itemType: 'skill', itemId: skillIds['tpl-skill-a'] },
          { itemType: 'skill', itemId: skillIds['tpl-skill-b'] },
          { itemType: 'skill', itemId: skillIds['tpl-skill-c'] },
        ],
      },
    });
    let bundle = await api('GET', '/api/skills/sync-bundle', { token: m1Token });
    expect(bundle.body.map((s: { slug: string }) => s.slug).sort()).toEqual(['tpl-skill-a', 'tpl-skill-b', 'tpl-skill-c']);

    await api('POST', '/api/templates/deselect', { token: m1Token });
    bundle = await api('GET', '/api/skills/sync-bundle', { token: m1Token });
    // tpl-skill-b 在上一步被手动重新订阅过（source=manual），保留；模板派生的 a/c 消失
    expect(bundle.body.map((s: { slug: string }) => s.slug)).toEqual(['tpl-skill-b']);
    expect(bundle.body[0].relation).toBe('subscribed');
  });
});

describe('MCP 配置分发', () => {
  it('创建配置（含环境变量引用）与可见性', async () => {
    await api('POST', '/api/envs', {
      token: adminToken,
      payload: { slug: 'mcp-env', name: 'MCP 用密钥', description: '' },
    });
    await api('POST', '/api/envs/mcp-env/variables', {
      token: adminToken,
      payload: { key: 'MCP_TOKEN', value: 'tok-999', description: '内部 MCP 服务令牌' },
    });
    const r = await api('POST', '/api/mcp-configs', {
      token: adminToken,
      payload: {
        slug: 'internal-api',
        name: '内部 API MCP',
        description: '访问内部服务',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', 'internal-mcp'],
        env: { API_TOKEN: '${env:mcp-env/MCP_TOKEN}', MODE: 'prod' },
      },
    });
    expect(r.status).toBe(201);
    // 私有配置对他人不可见
    await api('POST', '/api/mcp-configs', {
      token: adminToken,
      payload: { slug: 'secret-mcp', name: '私有', transport: 'stdio', command: 'x', visibility: 'private' },
    });
    const list = await api('GET', '/api/mcp-configs', { token: m2Token });
    const slugs = list.body.map((c: { slug: string }) => c.slug);
    expect(slugs).toContain('internal-api');
    expect(slugs).not.toContain('secret-mcp');
    // 非 Owner 改既有 slug → 403
    const steal = await api('POST', '/api/mcp-configs', {
      token: m2Token,
      payload: { slug: 'internal-api', name: 'x', transport: 'stdio', command: 'y' },
    });
    expect(steal.status).toBe(403);
  });

  it('无权限时引用保留占位符并给出申请指引', async () => {
    await api('POST', '/api/mcp-configs/internal-api/subscribe', { token: m2Token });
    const bundle = await api('GET', '/api/mcp-configs/sync-bundle', { token: m2Token });
    const item = bundle.body.find((c: { slug: string }) => c.slug === 'internal-api');
    expect(item.server.env.MODE).toBe('prod');
    expect(item.server.env.API_TOKEN).toBe('${env:mcp-env/MCP_TOKEN}');
    expect(item.unresolved).toHaveLength(1);
    expect(item.unresolved[0]).toMatchObject({ environment: 'mcp-env', key: 'MCP_TOKEN' });
  });

  it('授权后引用解析为实际值', async () => {
    const envs = await api('GET', '/api/envs', { token: adminToken });
    const env = envs.body.find((e: { slug: string }) => e.slug === 'mcp-env');
    const users = await api('GET', '/api/users', { token: adminToken });
    const zhang = users.body.find((u: { email: string }) => u.email === 'zhang@test.dev');
    await api('POST', '/api/envs/mcp-env/grants', {
      token: adminToken,
      payload: { userId: zhang.id, environmentId: env.id },
    });
    const bundle = await api('GET', '/api/mcp-configs/sync-bundle', { token: m2Token });
    const item = bundle.body.find((c: { slug: string }) => c.slug === 'internal-api');
    expect(item.server.env.API_TOKEN).toBe('tok-999');
    expect(item.unresolved).toEqual([]);
    expect(item.server.command).toBe('npx');
  });
});

describe('数据库账号分配（真实建库）', () => {
  let instanceId: string;
  let assignmentId: string;
  let creds: Record<string, string>;

  it('管理员登记实例；成员发起申请', async () => {
    expect(
      (
        await api('POST', '/api/db/instances', {
          token: m1Token,
          payload: { name: 'x', engine: 'postgres', host: 'h', port: 5432, adminUser: 'a' },
        })
      ).status,
    ).toBe(403);
    const inst = await api('POST', '/api/db/instances', {
      token: adminToken,
      payload: { name: '本地测试 PG', engine: 'postgres', host: '127.0.0.1', port: 5433, adminUser: 'dev', adminPassword: '', note: '团队日常项目用' },
    });
    expect(inst.status).toBe(201);
    instanceId = inst.body.id;

    const req = await api('POST', '/api/db/assignments', {
      token: m1Token,
      payload: { instanceId, dbName: 'proj_wang', purpose: '小王的 CRM 小工具' },
    });
    expect(req.status).toBe(201);
    expect(req.body.status).toBe('pending');
    assignmentId = req.body.id;
    // 重名拒绝
    const dup = await api('POST', '/api/db/assignments', {
      token: m2Token,
      payload: { instanceId, dbName: 'proj_wang', purpose: 'x' },
    });
    expect(dup.status).toBe(409);
    // 非法库名被 zod 拦截
    const evil = await api('POST', '/api/db/assignments', {
      token: m2Token,
      payload: { instanceId, dbName: 'x; drop table', purpose: 'x' },
    });
    expect(evil.status).toBe(400);
  });

  it('批准后真实建库建号，凭证生成为环境（Owner=申请人）', async () => {
    expect((await api('POST', `/api/db/assignments/${assignmentId}/approve`, { token: m1Token })).status).toBe(403);
    const r = await api('POST', `/api/db/assignments/${assignmentId}/approve`, { token: adminToken });
    expect(r.body.status).toBe('active');
    expect(r.body.environmentSlug).toBe('db-proj-wang');

    // 申请人拉取凭证
    const pull = await api('POST', '/api/envs/db-proj-wang/values', { token: m1Token, payload: {} });
    creds = pull.body.values;
    expect(creds.DB_NAME).toBe('proj_wang');
    expect(creds.DB_USER).toBe('u_proj_wang');
    expect(creds.DB_PASSWORD).toBeTruthy();
    // 其他成员无权限
    const other = await api('POST', '/api/envs/db-proj-wang/values', { token: m2Token, payload: { keys: ['DB_PASSWORD'] } });
    expect(other.body.denied[0].error).toBe('PERMISSION_REQUIRED');
  });

  it('新账号可以真实连接自己的库并建表读写', async () => {
    const client = new Client({
      host: creds.DB_HOST,
      port: Number(creds.DB_PORT),
      user: creds.DB_USER,
      password: creds.DB_PASSWORD,
      database: creds.DB_NAME,
    });
    await client.connect();
    await client.query('create table smoke(id serial primary key, note text)');
    await client.query(`insert into smoke(note) values ('hello')`);
    const res = await client.query('select note from smoke');
    expect(res.rows[0].note).toBe('hello');
    await client.end();
  });

  it('禁用后拒绝登录，恢复后可再连', async () => {
    await api('POST', `/api/db/assignments/${assignmentId}/disable`, { token: adminToken });
    const blocked = new Client({ host: creds.DB_HOST, port: Number(creds.DB_PORT), user: creds.DB_USER, database: creds.DB_NAME });
    await expect(blocked.connect()).rejects.toThrow();
    await api('POST', `/api/db/assignments/${assignmentId}/enable`, { token: adminToken });
    const ok = new Client({ host: creds.DB_HOST, port: Number(creds.DB_PORT), user: creds.DB_USER, database: creds.DB_NAME });
    await ok.connect();
    await ok.end();
  });

  it('实例上有 active 分配时不可删除实例', async () => {
    const r = await api('DELETE', `/api/db/instances/${instanceId}`, { token: adminToken });
    expect(r.status).toBe(409);
  });

  it('删除分配：库与账号被真实清除，凭证环境删除', async () => {
    const r = await api('DELETE', `/api/db/assignments/${assignmentId}`, { token: adminToken });
    expect(r.body.status).toBe('deleted');
    const gone = new Client({ host: creds.DB_HOST, port: Number(creds.DB_PORT), user: creds.DB_USER, database: creds.DB_NAME });
    await expect(gone.connect()).rejects.toThrow();
    const env = await api('POST', '/api/envs/db-proj-wang/values', { token: m1Token, payload: {} });
    expect(env.status).toBe(404);
    // 现在可以删除实例了
    expect((await api('DELETE', `/api/db/instances/${instanceId}`, { token: adminToken })).status).toBe(200);
  });
});
