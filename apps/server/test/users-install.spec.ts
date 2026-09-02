/**
 * 用户管理（改角色/禁用/重置密码）+ 开放注册（开关/邮箱后缀限制）+ CLI 自托管分发（install.sh / eat.js / AGENT.md）
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
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
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

describe('开放注册', () => {
  it('默认关闭：探测 enabled=false，注册 403；设置仅管理员可改', async () => {
    const probe = await api('GET', '/api/auth/registration');
    expect(probe.status).toBe(200);
    expect(probe.body.enabled).toBe(false);

    const r = await api('POST', '/api/auth/register', {
      payload: { name: '游客', email: 'guest@corp.com', password: 'password123' },
    });
    expect(r.status).toBe(403);

    expect((await api('GET', '/api/admin/registration-settings', { token: memberToken })).status).toBe(403);
    const memberPut = await api('PUT', '/api/admin/registration-settings', {
      token: memberToken,
      payload: { enabled: true, allowedEmailSuffixes: [] },
    });
    expect(memberPut.status).toBe(403);
  });

  it('后缀限制：不匹配 400；匹配则注册为 member 并直接登录；重复邮箱 409', async () => {
    const put = await api('PUT', '/api/admin/registration-settings', {
      token: adminToken,
      payload: { enabled: true, allowedEmailSuffixes: ['corp.com', '@Sub.Example.COM'] },
    });
    expect(put.status).toBe(200);
    // 后缀规整：补 @ 前缀、统一小写
    expect(put.body.allowedEmailSuffixes).toEqual(['@corp.com', '@sub.example.com']);
    // 探测对未登录用户公开同一形状（登录页据此展示注册入口与后缀提示）
    const probe = await api('GET', '/api/auth/registration');
    expect(probe.body).toEqual({ enabled: true, allowedEmailSuffixes: ['@corp.com', '@sub.example.com'] });

    const bad = await api('POST', '/api/auth/register', {
      payload: { name: '外人', email: 'evil@other.com', password: 'password123' },
    });
    expect(bad.status).toBe(400);

    const ok = await api('POST', '/api/auth/register', {
      payload: { name: '新同事', email: 'Newbie@Corp.com', password: 'password123' },
    });
    expect(ok.status).toBe(201);
    expect(ok.body.user.role).toBe('member');
    expect(ok.body.user.email).toBe('newbie@corp.com'); // 落库前统一小写
    expect((await api('GET', '/api/auth/whoami', { token: ok.body.token })).status).toBe(200);

    const dup = await api('POST', '/api/auth/register', {
      payload: { name: '重复', email: 'newbie@corp.com', password: 'password123' },
    });
    expect(dup.status).toBe(409);
  });

  it('清空后缀 = 任意邮箱可注册；关闭后立即失效', async () => {
    await api('PUT', '/api/admin/registration-settings', {
      token: adminToken,
      payload: { enabled: true, allowedEmailSuffixes: [] },
    });
    const anyMail = await api('POST', '/api/auth/register', {
      payload: { name: '任意邮箱', email: 'whoever@anywhere.io', password: 'password123' },
    });
    expect(anyMail.status).toBe(201);

    await api('PUT', '/api/admin/registration-settings', {
      token: adminToken,
      payload: { enabled: false, allowedEmailSuffixes: [] },
    });
    const off = await api('POST', '/api/auth/register', {
      payload: { name: '晚到', email: 'late@anywhere.io', password: 'password123' },
    });
    expect(off.status).toBe(403);
  });
});

describe('CLI 自托管分发', () => {
  it('install.sh 免鉴权，内容含下载与登录引导', async () => {
    const r = await api('GET', '/install.sh');
    expect(r.status).toBe(200);
    expect(String(r.headers['content-type'])).toContain('text/x-shellscript');
    expect(r.body).toContain('/install/eat.js');
    expect(r.body).toContain('eat login --server');
    // 决策 15：PATH 三层叠加落地（~/.local/bin 软链 + /usr/local/bin + 幂等写 shell 配置）
    expect(r.body).toContain('$HOME/.local/bin');
    expect(r.body).toContain('/usr/local/bin');
    expect(r.body).toContain('.zshenv');
    expect(r.body).toContain('grep -qF "$MARKER"');
    // 决策 24：全部逻辑包进 main()、末行才调用——管道被截断时不会执行半截脚本
    expect(r.body).toContain('main() {');
    expect(r.body.trimEnd().endsWith('main "$@"')).toBe(true);
    expect(r.body).toContain('/install.ps1'); // 指到 Windows 入口
  });

  it('install.ps1 免鉴权：Windows 安装脚本含 shim 两件套与用户级 PATH（决策 24、29）', async () => {
    const r = await api('GET', '/install.ps1');
    expect(r.status).toBe(200);
    expect(String(r.headers['content-type'])).toContain('text/plain');
    expect(r.body).toContain('/install/eat.js');
    expect(r.body).toContain('eat login --server');
    // shim 两件套：eat.cmd（cmd / PowerShell / 子进程）+ eat（Git Bash）
    expect(r.body).toContain("'@node \"%~dp0eat.js\" %*'");
    expect(r.body).toContain("Join-Path $binDir 'eat.cmd'");
    expect(r.body).toContain("Join-Path $binDir 'eat'");
    // 决策 29：绝不能落 eat.ps1——它会抢在 eat.cmd 前面被 PowerShell 选中，撞上 Restricted 执行策略
    expect(r.body).not.toMatch(/Join-Path \$binDir 'eat\.ps1'/);
    // PATH 写用户级环境变量，绝不能用 setx（超过 1024 字符会被截断）
    expect(r.body).toContain("[Environment]::SetEnvironmentVariable('Path'");
    expect(r.body).not.toMatch(/^\s*setx\b/m); // 注释里可以提它，但不能真的调用
    // 与 sh 脚本同样的截断保护：包成函数、末行才调用
    expect(r.body).toContain('function Install-EatCli');
    expect(r.body.trimEnd().endsWith('Install-EatCli')).toBe(true);
  });

  it('AGENT.md 免鉴权：只含 CLI 安装流程，不提及 MCP（决策 20）', async () => {
    const r = await api('GET', '/install/AGENT.md');
    expect(r.status).toBe(200);
    expect(String(r.headers['content-type'])).toContain('markdown');
    expect(r.body).toContain('curl -fsSL');
    expect(r.body).toContain('eat login --server');
    expect(r.body).toContain('eat sync');
    expect(String(r.body).toLowerCase()).not.toContain('mcp');
    // 决策 24：两套命令都给出，并要求 Agent 先判断平台
    expect(r.body).toContain('/install.sh | sh');
    expect(r.body).toContain('/install.ps1 | iex');
    expect(r.body).toContain("process.platform === 'win32'");
  });

  it('MCP.md 独立板块：面向无 shell 环境的客户端，含注册命令', async () => {
    const r = await api('GET', '/install/MCP.md');
    expect(r.status).toBe(200);
    expect(String(r.headers['content-type'])).toContain('markdown');
    expect(r.body).toContain('claude mcp add --scope user eat -- eat mcp');
    expect(r.body).toContain('stdio');
    expect(r.body).toContain('无需配置 MCP'); // 有 shell 装 CLI 即可的定位写进指引本身
    // 决策 24：Windows 上 eat 是 eat.cmd，Node 不允许不经 shell 直接拉起
    expect(r.body).toContain('claude mcp add --scope user eat -- cmd /c eat mcp');
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
