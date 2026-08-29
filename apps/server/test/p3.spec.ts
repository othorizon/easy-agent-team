/** P3 端到端测试：Dokploy 接入（mock）/ 项目与成员 / 部署门禁与状态刷新 / 密钥指纹清单 */
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://dev@127.0.0.1:5433/eat_test';

import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcryptjs';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import * as http from 'node:http';
import * as path from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import * as schema from '../src/db/schema';

let app: NestFastifyApplication;
let adminToken: string;
let ownerToken: string;
let memberToken: string;
let outsiderToken: string;
let memberId: string;

// mock Dokploy
const deployCalls: string[] = [];
let mockAppStatus = 'running';
let dokployServer: http.Server;
let dokployUrl: string;

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

const passingReport = () => ({
  passed: true,
  scannedFiles: 12,
  findings: [],
  cliVersion: '0.1.0',
  ranAt: new Date().toISOString(),
});

beforeAll(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await pool.query('drop schema public cascade; create schema public; drop schema if exists drizzle cascade;');
  await migrate(drizzle(pool), { migrationsFolder: path.resolve(process.cwd(), 'drizzle') });
  const db = drizzle(pool, { schema });
  const hash = await bcrypt.hash('password123', 4);
  await db.insert(schema.users).values([
    { name: '管理员', email: 'admin@test.dev', role: 'admin', passwordHash: hash },
    { name: '项目主', email: 'owner@test.dev', role: 'member', passwordHash: hash },
    { name: '组员', email: 'member@test.dev', role: 'member', passwordHash: hash },
    { name: '路人', email: 'outsider@test.dev', role: 'member', passwordHash: hash },
  ]);
  await pool.end();

  dokployServer = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/api/application.deploy') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        deployCalls.push(JSON.parse(body).applicationId);
        res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
      });
      return;
    }
    if (req.method === 'GET' && req.url === '/api/project.all') {
      if (req.headers['x-api-key'] !== 'dok-token-abcdef123456') {
        res.writeHead(401, { 'content-type': 'application/json' }).end('{"message":"invalid token"}');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end('[]');
      return;
    }
    if (req.method === 'GET' && req.url?.startsWith('/api/application.one')) {
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ applicationStatus: mockAppStatus }));
      return;
    }
    res.writeHead(404).end();
  });
  dokployUrl = await new Promise<string>((resolve) =>
    dokployServer.listen(0, '127.0.0.1', () =>
      resolve(`http://127.0.0.1:${(dokployServer.address() as { port: number }).port}/api`),
    ),
  );

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  const login = async (email: string) =>
    (await api('POST', '/api/auth/login', { payload: { email, password: 'password123' } })).body;
  adminToken = (await login('admin@test.dev')).token;
  ownerToken = (await login('owner@test.dev')).token;
  const m = await login('member@test.dev');
  memberToken = m.token;
  memberId = m.user.id;
  outsiderToken = (await login('outsider@test.dev')).token;
});

afterAll(async () => {
  await app?.close();
  dokployServer?.close();
});

describe('Dokploy 接入配置', () => {
  it('仅管理员可配置，token 打码', async () => {
    expect((await api('GET', '/api/admin/dokploy-settings', { token: ownerToken })).status).toBe(403);
    const put = await api('PUT', '/api/admin/dokploy-settings', {
      token: adminToken,
      payload: { apiUrl: dokployUrl, apiToken: 'dok-token-abcdef123456', enabled: true },
    });
    expect(put.status).toBe(200);
    const get = await api('GET', '/api/admin/dokploy-settings', { token: adminToken });
    expect(get.body.apiTokenMasked).toBe('dok-****3456');
    expect(get.body.apiUrl).toBe(dokployUrl);
  });

  it('连通性测试：token 留空回落已保存值，错 token/错地址返回 ok=false，仅管理员可用', async () => {
    expect((await api('POST', '/api/admin/dokploy-settings/test', { token: ownerToken, payload: { apiUrl: dokployUrl, apiToken: '' } })).status).toBe(403);

    const ok = await api('POST', '/api/admin/dokploy-settings/test', {
      token: adminToken,
      payload: { apiUrl: dokployUrl, apiToken: '' },
    });
    expect(ok.status).toBe(200);
    expect(ok.body.ok).toBe(true);
    expect(typeof ok.body.latencyMs).toBe('number');

    const badToken = await api('POST', '/api/admin/dokploy-settings/test', {
      token: adminToken,
      payload: { apiUrl: dokployUrl, apiToken: 'wrong-token' },
    });
    expect(badToken.status).toBe(200);
    expect(badToken.body.ok).toBe(false);
    expect(badToken.body.message).toContain('401');

    const badUrl = await api('POST', '/api/admin/dokploy-settings/test', {
      token: adminToken,
      payload: { apiUrl: `${dokployUrl}/nope`, apiToken: '' },
    });
    expect(badUrl.status).toBe(200);
    expect(badUrl.body.ok).toBe(false);
    expect(badUrl.body.message).toContain('404');
  });
});

describe('项目与成员', () => {
  it('创建项目、重名拒绝、成员管理与 canDeploy', async () => {
    const r = await api('POST', '/api/projects', {
      token: ownerToken,
      payload: { slug: 'crm-tool', name: 'CRM 小工具', dokployApplicationId: 'app-123', repoUrl: 'https://git.example.com/crm' },
    });
    expect(r.status).toBe(201);
    expect(r.body.canDeploy).toBe(true);
    expect((await api('POST', '/api/projects', { token: memberToken, payload: { slug: 'crm-tool', name: 'x', dokployApplicationId: 'y' } })).status).toBe(409);

    // 非 Owner 不能加成员
    expect((await api('POST', '/api/projects/crm-tool/members', { token: memberToken, payload: { userId: memberId } })).status).toBe(403);
    await api('POST', '/api/projects/crm-tool/members', { token: ownerToken, payload: { userId: memberId } });

    const listAsMember = await api('GET', '/api/projects', { token: memberToken });
    expect(listAsMember.body[0].canDeploy).toBe(true);
    const listAsOutsider = await api('GET', '/api/projects', { token: outsiderToken });
    expect(listAsOutsider.body[0].canDeploy).toBe(false);
  });
});

describe('部署门禁与状态', () => {
  let deployId: string;

  it('无报告 / 报告未通过 / 非成员，三种拒绝', async () => {
    const noReport = await api('POST', '/api/projects/crm-tool/deploy', { token: memberToken, payload: {} });
    expect(noReport.status).toBe(400);
    const failing = await api('POST', '/api/projects/crm-tool/deploy', {
      token: memberToken,
      payload: {
        report: {
          ...passingReport(),
          passed: false,
          findings: [{ rule: 'generic', file: 'src/config.ts', line: 3, note: '疑似 AWS Key' }],
        },
      },
    });
    expect(failing.status).toBe(400);
    expect(failing.body.error).toBe('PRECHECK_FAILED');
    const outsider = await api('POST', '/api/projects/crm-tool/deploy', {
      token: outsiderToken,
      payload: { report: passingReport() },
    });
    expect(outsider.status).toBe(403);
    expect(deployCalls).toHaveLength(0);
  });

  it('成员携带通过报告部署成功，Dokploy 收到调用', async () => {
    const r = await api('POST', '/api/projects/crm-tool/deploy', {
      token: memberToken,
      payload: { report: passingReport() },
    });
    expect(r.status).toBe(201);
    expect(r.body.status).toBe('deploying');
    deployId = r.body.id;
    expect(deployCalls).toEqual(['app-123']);
  });

  it('状态刷新：running 保持 deploying，done 变 success', async () => {
    mockAppStatus = 'running';
    let d = await api('GET', `/api/deployments/${deployId}`, { token: memberToken });
    expect(d.body.status).toBe('deploying');
    mockAppStatus = 'done';
    d = await api('GET', `/api/deployments/${deployId}`, { token: memberToken });
    expect(d.body.status).toBe('success');
    const list = await api('GET', '/api/projects/crm-tool/deployments', { token: ownerToken });
    expect(list.body[0].status).toBe('success');
    expect(list.body[0].report.passed).toBe(true);
  });

  it('Dokploy 构建失败 → failed 并附提示', async () => {
    const r = await api('POST', '/api/projects/crm-tool/deploy', { token: ownerToken, payload: { report: passingReport() } });
    mockAppStatus = 'error';
    const d = await api('GET', `/api/deployments/${r.body.id}`, { token: ownerToken });
    expect(d.body.status).toBe('failed');
    expect(d.body.error).toContain('Dokploy');
  });
});

describe('密钥指纹清单', () => {
  it('长值有指纹、短值排除、受限变量不泄露名称', async () => {
    await api('POST', '/api/envs', { token: adminToken, payload: { slug: 'fp-env', name: '指纹测试', description: '' } });
    await api('POST', '/api/envs/fp-env/variables', {
      token: adminToken,
      payload: { key: 'LONG_TOKEN', value: 'super-secret-token-value-123', description: '' },
    });
    await api('POST', '/api/envs/fp-env/variables', {
      token: adminToken,
      payload: { key: 'SHORT', value: 'abc', description: '' },
    });
    await api('POST', '/api/envs/fp-env/variables', {
      token: adminToken,
      payload: { key: 'HIDDEN_LONG', value: 'hidden-secret-value-456', description: '', visibleWithoutPermission: false },
    });
    // 非敏感变量明文存储，不是密钥，不进指纹清单
    await api('POST', '/api/envs/fp-env/variables', {
      token: adminToken,
      payload: { key: 'PLAIN_LONG', value: 'plain-service-url-very-long', description: '', secret: false },
    });
    const r = await api('GET', '/api/secret-fingerprints', { token: outsiderToken });
    expect(r.status).toBe(200);
    const keys = r.body.map((f: { key: string }) => f.key);
    expect(keys).toContain('LONG_TOKEN');
    expect(keys).not.toContain('SHORT');
    expect(keys).not.toContain('HIDDEN_LONG');
    expect(keys).not.toContain('PLAIN_LONG');
    expect(keys).toContain('(受限变量)');
    const long = r.body.find((f: { key: string }) => f.key === 'LONG_TOKEN');
    expect(long.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(long.length).toBe('super-secret-token-value-123'.length);
  });
});
