/**
 * 用户管理（改角色/禁用/重置密码）+ CLI 自托管分发（install.sh / eat.js / AGENT.md）
 * 前置：scripts/dev-db.sh start（端口 5433）
 */
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://dev@127.0.0.1:5433/eat_test';

import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcryptjs';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import * as schema from '../src/db/schema';

let app: NestFastifyApplication;
let adminToken: string;
let memberToken: string;
let adminId: string;
let memberId: string;
let tmpDir: string;

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
  const isJson = (res.headers['content-type'] ?? '').toString().includes('application/json');
  const body = res.body && isJson ? JSON.parse(res.body) : res.body;
  return { status: res.statusCode, body, headers: res.headers };
}

async function loginAs(email: string, password: string) {
  return api('POST', '/api/auth/login', { payload: { email, password } });
}

beforeAll(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await pool.query('drop schema public cascade; create schema public; drop schema if exists drizzle cascade;');
  await migrate(drizzle(pool), { migrationsFolder: path.resolve(process.cwd(), 'drizzle') });
  const db = drizzle(pool, { schema });
  const hash = await bcrypt.hash('password123', 4);
  await db.insert(schema.users).values([
    { name: '管理员', email: 'admin@test.dev', role: 'admin', passwordHash: hash },
    { name: '成员小王', email: 'member@test.dev', role: 'member', passwordHash: hash },
  ]);
  await pool.end();

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eat-install-'));

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  adminToken = (await loginAs('admin@test.dev', 'password123')).body.token;
  const m = await loginAs('member@test.dev', 'password123');
  memberToken = m.body.token;
  memberId = m.body.user.id;
  const me = await api('GET', '/api/auth/whoami', { token: adminToken });
  adminId = me.body.id;
});

afterAll(async () => {
  await app?.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.EAT_CLI_DIST;
});

describe('用户管理', () => {
  it('成员无权创建/修改/重置', async () => {
    const c = await api('POST', '/api/users', {
      token: memberToken,
      payload: { name: 'x', email: 'x@test.dev', password: 'password123', role: 'member' },
    });
    expect(c.status).toBe(403);
    const u = await api('PATCH', `/api/users/${adminId}`, { token: memberToken, payload: { role: 'member' } });
    expect(u.status).toBe(403);
    const p = await api('POST', `/api/users/${adminId}/password`, {
      token: memberToken,
      payload: { password: 'password456' },
    });
    expect(p.status).toBe(403);
  });

  it('管理员建号；重复邮箱 409', async () => {
    const r = await api('POST', '/api/users', {
      token: adminToken,
      payload: { name: '新同事', email: 'new@test.dev', password: 'password123', role: 'member' },
    });
    expect(r.status).toBe(201);
    const dup = await api('POST', '/api/users', {
      token: adminToken,
      payload: { name: '重复', email: 'new@test.dev', password: 'password123', role: 'member' },
    });
    expect(dup.status).toBe(409);
    const login = await loginAs('new@test.dev', 'password123');
    expect(login.status).toBe(201);
  });

  it('改角色生效；不能修改自己；空修改 400', async () => {
    const up = await api('PATCH', `/api/users/${memberId}`, { token: adminToken, payload: { role: 'admin' } });
    expect(up.status).toBe(200);
    expect(up.body.role).toBe('admin');
    const back = await api('PATCH', `/api/users/${memberId}`, { token: adminToken, payload: { role: 'member' } });
    expect(back.body.role).toBe('member');

    const self = await api('PATCH', `/api/users/${adminId}`, { token: adminToken, payload: { role: 'member' } });
    expect(self.status).toBe(400);

    const empty = await api('PATCH', `/api/users/${memberId}`, { token: adminToken, payload: {} });
    expect(empty.status).toBe(400);
  });

  it('禁用即时吊销 Token，登录被拒；启用后恢复', async () => {
    const disable = await api('PATCH', `/api/users/${memberId}`, { token: adminToken, payload: { status: 'disabled' } });
    expect(disable.status).toBe(200);
    // 旧 Token 立即失效
    expect((await api('GET', '/api/auth/whoami', { token: memberToken })).status).toBe(401);
    // 密码登录也被拒
    expect((await loginAs('member@test.dev', 'password123')).status).toBe(401);

    await api('PATCH', `/api/users/${memberId}`, { token: adminToken, payload: { status: 'active' } });
    const again = await loginAs('member@test.dev', 'password123');
    expect(again.status).toBe(201);
    memberToken = again.body.token;
  });

  it('重置密码：旧密码/旧 Token 失效，新密码可登录', async () => {
    const r = await api('POST', `/api/users/${memberId}/password`, {
      token: adminToken,
      payload: { password: 'newpass9999' },
    });
    expect(r.status).toBe(201);
    expect((await api('GET', '/api/auth/whoami', { token: memberToken })).status).toBe(401);
    expect((await loginAs('member@test.dev', 'password123')).status).toBe(401);
    const ok = await loginAs('member@test.dev', 'newpass9999');
    expect(ok.status).toBe(201);
    memberToken = ok.body.token;
  });
});

describe('CLI 自托管分发', () => {
  it('install.sh 免鉴权，内容含下载与登录引导', async () => {
    const r = await api('GET', '/install.sh');
    expect(r.status).toBe(200);
    expect(String(r.headers['content-type'])).toContain('text/x-shellscript');
    expect(r.body).toContain('/install/eat.js');
    expect(r.body).toContain('eat login --server');
  });

  it('AGENT.md 免鉴权，给 Agent 的完整安装指令', async () => {
    const r = await api('GET', '/install/AGENT.md');
    expect(r.status).toBe(200);
    expect(String(r.headers['content-type'])).toContain('markdown');
    expect(r.body).toContain('curl -fsSL');
    expect(r.body).toContain('claude mcp add');
  });

  it('eat.js：产物缺失 404；就绪后按原样下发', async () => {
    process.env.EAT_CLI_DIST = path.join(tmpDir, 'missing.js');
    const missing = await api('GET', '/install/eat.js');
    expect(missing.status).toBe(404);

    const bundle = path.join(tmpDir, 'eat-bundle.js');
    fs.writeFileSync(bundle, '#!/usr/bin/env node\nconsole.log("eat 0.1.0");\n');
    process.env.EAT_CLI_DIST = bundle;
    const r = await api('GET', '/install/eat.js');
    expect(r.status).toBe(200);
    expect(String(r.headers['content-type'])).toContain('javascript');
    expect(r.body).toContain('eat 0.1.0');
  });
});
