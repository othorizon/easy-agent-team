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
import { decryptSecret, encryptSecret } from '../src/common/crypto';
import { moveDbCredentialsOutOfEnvs } from '../src/db/repair-db-credentials';
import * as schema from '../src/db/schema';
import { eq, inArray } from 'drizzle-orm';

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
  // 清理上次运行残留的真实库/账号（平台删除是记录级软删除，物理清理只能在实例上手动执行——测试里在此代劳）
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
    // 内置平台指南始终在 bundle 首位（skills.spec 单独覆盖），此处只关心模板部分
    const slugs = bundle.body.map((s: { slug: string }) => s.slug).filter((s: string) => s !== 'eat-platform-guide').sort();
    expect(slugs).toEqual(['tpl-skill-a', 'tpl-skill-b']);
    expect(bundle.body.find((s: { slug: string }) => s.slug === 'tpl-skill-a').relation).toBe('template');
  });

  it('排除模板条目：退订某项后从 bundle 消失，重新订阅恢复', async () => {
    const skillSlugs = (bundle: { body: Array<{ slug: string }> }) =>
      bundle.body.map((s) => s.slug).filter((s) => s !== 'eat-platform-guide');
    await api('DELETE', '/api/skills/tpl-skill-b/subscribe', { token: m1Token });
    let bundle = await api('GET', '/api/skills/sync-bundle', { token: m1Token });
    expect(skillSlugs(bundle)).toEqual(['tpl-skill-a']);

    await api('POST', '/api/skills/tpl-skill-b/subscribe', { token: m1Token });
    bundle = await api('GET', '/api/skills/sync-bundle', { token: m1Token });
    expect(skillSlugs(bundle).sort()).toEqual(['tpl-skill-a', 'tpl-skill-b']);
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
    const skillSlugs = (bundle: { body: Array<{ slug: string }> }) =>
      bundle.body.map((s) => s.slug).filter((s) => s !== 'eat-platform-guide');
    let bundle = await api('GET', '/api/skills/sync-bundle', { token: m1Token });
    expect(skillSlugs(bundle).sort()).toEqual(['tpl-skill-a', 'tpl-skill-b', 'tpl-skill-c']);

    await api('POST', '/api/templates/deselect', { token: m1Token });
    bundle = await api('GET', '/api/skills/sync-bundle', { token: m1Token });
    // tpl-skill-b 在上一步被手动重新订阅过（source=manual），保留；模板派生的 a/c 消失
    expect(skillSlugs(bundle)).toEqual(['tpl-skill-b']);
    expect(bundle.body.find((s: { slug: string }) => s.slug === 'tpl-skill-b').relation).toBe('subscribed');
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
    // 创建者自己的订阅即时生效，不用等自己批自己
    expect(r.body.subscriptionStatus).toBe('approved');
    // 不公开的配置对他人不可见
    await api('POST', '/api/mcp-configs', {
      token: adminToken,
      payload: { slug: 'secret-mcp', name: '不公开', transport: 'stdio', command: 'x', visibility: 'private' },
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
    // 不可见的配置也订阅不到（连存在都不该知道）
    const blind = await api('POST', '/api/mcp-configs/secret-mcp/subscribe', { token: m2Token });
    expect(blind.status).toBe(404);
  });

  it('成员订阅需审批：批准前不进 sync 范围（决策 50）', async () => {
    const sub = await api('POST', '/api/mcp-configs/internal-api/subscribe', {
      token: m2Token,
      payload: { reason: '要连内部服务' },
    });
    expect(sub.body.status).toBe('pending');
    let list = await api('GET', '/api/mcp-configs', { token: m2Token });
    let item = list.body.find((c: { slug: string }) => c.slug === 'internal-api');
    expect(item.subscriptionStatus).toBe('pending');
    expect(item.subscribed).toBe(false);
    // 待审批期间不下发
    let bundle = await api('GET', '/api/mcp-configs/sync-bundle', { token: m2Token });
    expect(bundle.body).toHaveLength(0);

    // 既不是 Owner 也不是管理员 → 看不到别人的申请、也批不了
    const requests = await api('GET', '/api/mcp-configs/subscription-requests', { token: adminToken });
    expect(requests.body).toHaveLength(1);
    expect(requests.body[0]).toMatchObject({ configSlug: 'internal-api', userEmail: 'zhang@test.dev', reason: '要连内部服务' });
    const requestId = requests.body[0].id;
    expect((await api('GET', '/api/mcp-configs/subscription-requests', { token: m1Token })).body).toHaveLength(0);
    const usurp = await api('POST', `/api/mcp-configs/subscription-requests/${requestId}/decision`, {
      token: m1Token,
      payload: { decision: 'approved' },
    });
    expect(usurp.status).toBe(403);

    // 管理员批准 → 立刻进入 sync 范围
    const decided = await api('POST', `/api/mcp-configs/subscription-requests/${requestId}/decision`, {
      token: adminToken,
      payload: { decision: 'approved' },
    });
    expect(decided.status).toBe(201);
    // 重复审批 → 409
    expect(
      (
        await api('POST', `/api/mcp-configs/subscription-requests/${requestId}/decision`, {
          token: adminToken,
          payload: { decision: 'rejected', reason: '请补充用途说明' },
        })
      ).status,
    ).toBe(409);

    list = await api('GET', '/api/mcp-configs', { token: m2Token });
    item = list.body.find((c: { slug: string }) => c.slug === 'internal-api');
    expect(item.subscriptionStatus).toBe('approved');
    expect(item.subscribed).toBe(true);
    bundle = await api('GET', '/api/mcp-configs/sync-bundle', { token: m2Token });
    expect(bundle.body).toHaveLength(1);
    // 批准后重复点订阅不会把自己打回待审批
    expect((await api('POST', '/api/mcp-configs/internal-api/subscribe', { token: m2Token })).body.status).toBe('approved');
  });

  it('驳回的申请不下发，可以重新申请', async () => {
    await api('POST', '/api/mcp-configs', {
      token: m1Token,
      payload: { slug: 'wang-mcp', name: '小王的 MCP', transport: 'stdio', command: 'node' },
    });
    await api('POST', '/api/mcp-configs/wang-mcp/subscribe', { token: m2Token, payload: { reason: '想用' } });
    // Owner（非管理员）也能审批自己的配置
    const inbox = await api('GET', '/api/mcp-configs/subscription-requests', { token: m1Token });
    expect(inbox.body).toHaveLength(1);
    await api('POST', `/api/mcp-configs/subscription-requests/${inbox.body[0].id}/decision`, {
      token: m1Token,
      payload: { decision: 'rejected', reason: '请补充用途说明' },
    });
    const list = await api('GET', '/api/mcp-configs', { token: m2Token });
    expect(list.body.find((c: { slug: string }) => c.slug === 'wang-mcp').subscriptionStatus).toBe('rejected');
    const bundle = await api('GET', '/api/mcp-configs/sync-bundle', { token: m2Token });
    expect(bundle.body.map((c: { slug: string }) => c.slug)).not.toContain('wang-mcp');
    // 已处理的申请在 status=all 里还看得到，pending 清单则空了
    expect((await api('GET', '/api/mcp-configs/subscription-requests', { token: m1Token })).body).toHaveLength(0);
    const all = await api('GET', '/api/mcp-configs/subscription-requests?status=all', { token: m1Token });
    expect(all.body).toHaveLength(1);
    expect(all.body[0]).toMatchObject({ status: 'rejected', decidedByName: '小王' });
    // 重新申请 → 回到待审批
    await api('POST', '/api/mcp-configs/wang-mcp/subscribe', { token: m2Token, payload: { reason: '再申请一次' } });
    expect((await api('GET', '/api/mcp-configs/subscription-requests', { token: m1Token })).body).toHaveLength(1);
    // 撤回申请
    await api('DELETE', '/api/mcp-configs/wang-mcp/subscribe', { token: m2Token });
    expect((await api('GET', '/api/mcp-configs/subscription-requests', { token: m1Token })).body).toHaveLength(0);
  });

  it('不公开的配置靠管理员主动分配', async () => {
    const users = await api('GET', '/api/users', { token: adminToken });
    const zhang = users.body.find((u: { email: string }) => u.email === 'zhang@test.dev');
    expect((await api('GET', '/api/mcp-configs/secret-mcp/subscribers', { token: m2Token })).status).toBe(403);
    const added = await api('POST', '/api/mcp-configs/secret-mcp/subscribers', {
      token: adminToken,
      payload: { userId: zhang.id },
    });
    expect(added.status).toBe(201);
    // 分配后：清单里看得到（哪怕配置不公开）、直接生效、也能同步下来
    const list = await api('GET', '/api/mcp-configs', { token: m2Token });
    const item = list.body.find((c: { slug: string }) => c.slug === 'secret-mcp');
    expect(item).toMatchObject({ subscribed: true, subscriptionStatus: 'approved' });
    const bundle = await api('GET', '/api/mcp-configs/sync-bundle', { token: m2Token });
    expect(bundle.body.map((c: { slug: string }) => c.slug)).toContain('secret-mcp');
    const subscribers = await api('GET', '/api/mcp-configs/secret-mcp/subscribers', { token: adminToken });
    expect(subscribers.body.find((s: { email: string }) => s.email === 'zhang@test.dev')).toMatchObject({
      source: 'admin',
      removable: true,
    });
    // 收回分配
    await api('DELETE', `/api/mcp-configs/secret-mcp/subscribers/${zhang.id}`, { token: adminToken });
    const after = await api('GET', '/api/mcp-configs', { token: m2Token });
    expect(after.body.map((c: { slug: string }) => c.slug)).not.toContain('secret-mcp');
  });

  it('无权限时引用保留占位符并给出申请指引', async () => {
    const bundle = await api('GET', '/api/mcp-configs/sync-bundle', { token: m2Token });
    const item = bundle.body.find((c: { slug: string }) => c.slug === 'internal-api');
    expect(item.server.env.MODE).toBe('prod');
    expect(item.server.env.API_TOKEN).toBe('${env:mcp-env/MCP_TOKEN}');
    expect(item.unresolved).toHaveLength(1);
    expect(item.unresolved[0]).toMatchObject({ environment: 'mcp-env', key: 'MCP_TOKEN' });
  });

  it('授权后引用解析为实际值', async () => {
    const envs = await api('GET', '/api/envs', { token: adminToken });
    const env = envs.body.items.find((e: { slug: string }) => e.slug === 'mcp-env');
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

  it('批准后真实建库建号，密码存在分配记录上，不生成环境变量（决策 91）', async () => {
    expect((await api('POST', `/api/db/assignments/${assignmentId}/approve`, { token: m1Token })).status).toBe(403);
    const r = await api('POST', `/api/db/assignments/${assignmentId}/approve`, { token: adminToken });
    expect(r.body.status).toBe('active');
    expect(r.body.hasCredentials).toBe(true);
    expect(r.body).not.toHaveProperty('environmentSlug');
    // 不再生成凭证环境：环境清单里搜不到，按旧 slug 访问 404
    expect((await api('GET', '/api/envs?q=proj_wang', { token: m1Token })).body.total).toBe(0);
    expect((await api('GET', '/api/envs/db-proj-wang', { token: m1Token })).status).toBe(404);
  });

  it('连接凭证只在数据库这里取：申请人与管理员可读、no-store、每次读取落审计', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/db/assignments/${assignmentId}/credentials`,
      headers: { authorization: `Bearer ${m1Token}` },
    });
    expect(res.statusCode).toBe(201);
    expect(res.headers['cache-control']).toBe('no-store');
    const cred = JSON.parse(res.body);
    expect(cred).toMatchObject({
      assignmentId,
      engine: 'postgres',
      host: '127.0.0.1',
      port: 5433,
      database: 'proj_wang',
      user: 'u_proj_wang',
    });
    expect(cred.password).toMatch(/^[0-9a-f]{36}$/);
    expect(cred.url).toBe(`postgres://u_proj_wang:${cred.password}@127.0.0.1:5433/proj_wang`);
    creds = {
      DB_HOST: cred.host,
      DB_PORT: String(cred.port),
      DB_NAME: cred.database,
      DB_USER: cred.user,
      DB_PASSWORD: cred.password,
    };
    // 其他成员读不到，也没有「授权给别人」这条路
    expect((await api('POST', `/api/db/assignments/${assignmentId}/credentials`, { token: m2Token })).status).toBe(403);
    const byAdmin = await api('POST', `/api/db/assignments/${assignmentId}/credentials`, { token: adminToken });
    expect(byAdmin.status).toBe(201);
    expect(byAdmin.body.password).toBe(cred.password);
    // 乱写的 id 是 404，不是 uuid 类型错误冒出来的 500
    expect((await api('POST', '/api/db/assignments/proj_wang/credentials', { token: m1Token })).status).toBe(404);
    const audit = await api('GET', '/api/audit?action=db_credentials.read', { token: adminToken });
    expect(audit.body).toHaveLength(2);
    expect(audit.body.every((a: { targetId: string }) => a.targetId === assignmentId)).toBe(true);
  });

  it('分配详情：申请人与管理员可看，其他成员 403', async () => {
    const detail = await api('GET', `/api/db/assignments/${assignmentId}`, { token: m1Token });
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({
      status: 'active',
      dbUser: 'u_proj_wang',
      instanceHost: '127.0.0.1',
      instancePort: 5433,
      hasCredentials: true,
      decidedByName: '管理员',
      requesterName: '小王',
    });
    expect((await api('GET', `/api/db/assignments/${assignmentId}`, { token: m2Token })).status).toBe(403);
    expect((await api('GET', `/api/db/assignments/${assignmentId}`, { token: adminToken })).status).toBe(200);
    expect((await api('GET', '/api/db/assignments/00000000-0000-0000-0000-000000000000', { token: adminToken })).status).toBe(404);
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

  it('public schema 归到分配账号名下：账号能自己删建 schema（迁移工具常做），不是只靠 pg_database_owner 兜底', async () => {
    const client = new Client({
      host: creds.DB_HOST,
      port: Number(creds.DB_PORT),
      user: creds.DB_USER,
      password: creds.DB_PASSWORD,
      database: creds.DB_NAME,
    });
    await client.connect();
    // CREATE DATABASE ... OWNER 不改 public 的归属（它是从 template1 复制来的），建库后必须显式摆正
    const owner = await client.query(
      `select pg_get_userbyid(nspowner) as owner from pg_namespace where nspname = 'public'`,
    );
    expect(owner.rows[0].owner).toBe(creds.DB_USER);
    // 只有 owner 才做得了这几件事：加固过的集群（PUBLIC 无 CREATE）上第一条就会失败
    await client.query('comment on schema public is $$mine$$');
    await client.query('drop schema public cascade');
    await client.query('create schema public');
    await client.query('create table after_reset(id int)');
    await client.end();
  });

  it('禁用后拒绝登录，恢复后可再连', async () => {
    await api('POST', `/api/db/assignments/${assignmentId}/disable`, { token: adminToken });
    const blocked = new Client({ host: creds.DB_HOST, port: Number(creds.DB_PORT), user: creds.DB_USER, database: creds.DB_NAME });
    await expect(blocked.connect()).rejects.toThrow();
    // 禁用期间不给凭证（账号登不上，给了也没用，还平白多一次密码外泄）
    const disabled = await api('POST', `/api/db/assignments/${assignmentId}/credentials`, { token: m1Token });
    expect(disabled.status).toBe(409);
    await api('POST', `/api/db/assignments/${assignmentId}/enable`, { token: adminToken });
    expect((await api('POST', `/api/db/assignments/${assignmentId}/credentials`, { token: m1Token })).status).toBe(201);
    const ok = new Client({ host: creds.DB_HOST, port: Number(creds.DB_PORT), user: creds.DB_USER, database: creds.DB_NAME });
    await ok.connect();
    await ok.end();
  });

  it('实例上有 active 分配时不可删除实例', async () => {
    const r = await api('DELETE', `/api/db/instances/${instanceId}`, { token: adminToken });
    expect(r.status).toBe(409);
  });

  it('删除分配：仅记录级软删除，平台上的密码清掉，实例上的库与账号保留（决策 13）', async () => {
    const r = await api('DELETE', `/api/db/assignments/${assignmentId}`, { token: adminToken });
    expect(r.body.status).toBe('deleted');
    expect(r.body.hasCredentials).toBe(false);
    expect((await api('POST', `/api/db/assignments/${assignmentId}/credentials`, { token: adminToken })).status).toBe(409);
    // 不做物理 DROP：实例上的库与账号仍然存在、可连接（物理清理由管理员手动执行）
    const still = new Client({
      host: creds.DB_HOST,
      port: Number(creds.DB_PORT),
      user: creds.DB_USER,
      password: creds.DB_PASSWORD,
      database: creds.DB_NAME,
    });
    await still.connect();
    expect((await still.query('select 1 as ok')).rows[0].ok).toBe(1);
    await still.end();
    // 已删除的记录不再出现在列表里
    const mineList = await api('GET', '/api/db/assignments/mine', { token: m1Token });
    expect(mineList.body.map((a: { id: string }) => a.id)).not.toContain(assignmentId);
    const allList = await api('GET', '/api/db/assignments', { token: adminToken });
    expect(allList.body.map((a: { id: string }) => a.id)).not.toContain(assignmentId);
    // 记录已删除（非 active），可以删除实例登记了
    expect((await api('DELETE', `/api/db/instances/${instanceId}`, { token: adminToken })).status).toBe(200);
  });
});

describe('存量凭证环境搬迁（决策 91）', () => {
  it('密码搬回分配记录；只有生成变量的环境删掉，加过别的变量的环境保留；幂等', async () => {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const db = drizzle(pool, { schema });
    try {
      const people = await db.select().from(schema.users);
      const id = (email: string) => people.find((u) => u.email === email)!.id;
      const [admin, wang, zhang] = [id('admin@test.dev'), id('wang@test.dev'), id('zhang@test.dev')];
      const [inst] = await db
        .insert(schema.dbInstances)
        .values({ name: '旧实例', engine: 'postgres', host: '10.0.0.5', port: 5432, adminUser: 'a', adminPasswordEncrypted: encryptSecret(''), createdBy: admin })
        .returning();

      // 旧版本批准时生成的样子：四个明文 + 加密的 DB_PASSWORD
      const legacyEnv = async (dbName: string, password: { secret: boolean; value: string } | null, extra: Record<string, string> = {}) => {
        const [env] = await db
          .insert(schema.environments)
          .values({ slug: `db-${dbName.replace(/_/g, '-')}`, name: `数据库 ${dbName}`, description: '连接凭证见变量', ownerId: wang })
          .returning();
        const plain = { DB_HOST: '10.0.0.5', DB_PORT: '5432', DB_NAME: dbName, DB_USER: `u_${dbName}`, ...extra };
        for (const [key, value] of Object.entries(plain)) {
          await db.insert(schema.envVariables).values({ environmentId: env.id, key, valuePlain: value, secret: false });
        }
        if (password) {
          await db.insert(schema.envVariables).values({
            environmentId: env.id,
            key: 'DB_PASSWORD',
            secret: password.secret,
            valueEncrypted: password.secret ? encryptSecret(password.value) : null,
            valuePlain: password.secret ? null : password.value,
          });
        }
        await db.insert(schema.variableGrants).values({ userId: zhang, environmentId: env.id, grantedBy: wang });
        const [a] = await db
          .insert(schema.dbAssignments)
          .values({ instanceId: inst.id, requesterId: wang, dbName, dbUser: `u_${dbName}`, purpose: '旧数据', status: 'active', environmentId: env.id })
          .returning();
        return { env, assignment: a };
      };
      const plainOnly = await legacyEnv('legacy_a', { secret: true, value: 'pw-a' });
      const withExtra = await legacyEnv('legacy_b', { secret: false, value: 'pw-b' }, { MY_EXTRA: 'keep-me' });
      const noPassword = await legacyEnv('legacy_c', null);
      const [tpl] = await db.insert(schema.roleTemplates).values({ name: '旧模板', createdBy: admin }).returning();
      await db.insert(schema.templateItems).values({ templateId: tpl.id, itemType: 'environment', itemId: plainOnly.env.id });

      const moved = await moveDbCredentialsOutOfEnvs(db);
      expect(moved.map((m) => m.dbName).sort()).toEqual(['legacy_a', 'legacy_b', 'legacy_c']);
      expect(moved.find((m) => m.dbName === 'legacy_b')).toMatchObject({ environment: 'db-legacy-b', keptKeys: ['MY_EXTRA'], passwordMissing: false });
      expect(moved.find((m) => m.dbName === 'legacy_c')?.passwordMissing).toBe(true);

      const rows = await db
        .select()
        .from(schema.dbAssignments)
        .where(inArray(schema.dbAssignments.dbName, ['legacy_a', 'legacy_b', 'legacy_c']));
      const by = Object.fromEntries(rows.map((r) => [r.dbName, r]));
      expect(rows.every((r) => r.environmentId === null)).toBe(true);
      expect(decryptSecret(by.legacy_a.passwordEncrypted!)).toBe('pw-a');
      // Owner 改成非敏感的密码也照样加密存进来
      expect(decryptSecret(by.legacy_b.passwordEncrypted!)).toBe('pw-b');
      expect(by.legacy_c.passwordEncrypted).toBeNull();

      // 只有生成变量的环境整个删掉：授权随外键级联，角色模板里的引用一并清掉
      const envs = await db
        .select()
        .from(schema.environments)
        .where(inArray(schema.environments.id, [plainOnly.env.id, withExtra.env.id, noPassword.env.id]));
      expect(envs.map((e) => e.slug)).toEqual(['db-legacy-b']);
      expect(await db.select().from(schema.templateItems).where(eq(schema.templateItems.templateId, tpl.id))).toEqual([]);
      // 加过别的变量的环境保留：生成的五个删掉、别人加的留着、环境级授权留着、备注说清凭证去哪了
      const kept = await db.select().from(schema.envVariables).where(eq(schema.envVariables.environmentId, withExtra.env.id));
      expect(kept.map((v) => v.key)).toEqual(['MY_EXTRA']);
      expect(envs[0].description).toContain('eat db pull legacy_b');
      const grants = await db.select().from(schema.variableGrants).where(eq(schema.variableGrants.environmentId, withExtra.env.id));
      expect(grants).toHaveLength(1);

      const audit = await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.action, 'db_assignment.credentials_moved'));
      expect(audit).toHaveLength(3);
      expect(await moveDbCredentialsOutOfEnvs(db)).toEqual([]);

      // 搬完照常从数据库这里取；环境里早没了密码的那条明确告诉用户找管理员重置
      const cred = await api('POST', `/api/db/assignments/${plainOnly.assignment.id}/credentials`, { token: m1Token });
      expect(cred.body).toMatchObject({ host: '10.0.0.5', port: 5432, database: 'legacy_a', user: 'u_legacy_a', password: 'pw-a' });
      const missing = await api('POST', `/api/db/assignments/${noPassword.assignment.id}/credentials`, { token: m1Token });
      expect(missing.status).toBe(409);
      expect(missing.body.error).toBe('DB_CREDENTIALS_MISSING');
      expect((await api('GET', `/api/db/assignments/${noPassword.assignment.id}`, { token: m1Token })).body.hasCredentials).toBe(false);
    } finally {
      await pool.end();
    }
  });
});
