/** P3 端到端测试：Dokploy 接入（mock）/ 项目与成员 / 部署门禁与状态刷新 / 构建与运行日志 / 密钥指纹清单 */
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://dev@127.0.0.1:5433/eat_test';

import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcryptjs';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import * as http from 'node:http';
import * as path from 'node:path';
import { Pool } from 'pg';
import { WebSocketServer } from 'ws';
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
/** Dokploy 收到的 application.deploy 请求体（决策 30 后还要断言认领标记有没有带上） */
const deployCalls: Array<Record<string, string>> = [];
/**
 * project.all 的真实形状：新版 Dokploy 把 applications 挂在 environments[] 下（真机实测），
 * 老版本直接挂在项目下；两种都要认。响应里还有 postgres / compose 等其他服务，清单只应取 applications，
 * 且要能扛住缺字段与非法条目。
 */
let mockProjectAll: unknown = [
  {
    projectId: 'proj-1',
    name: '生产环境',
    environments: [
      {
        environmentId: 'env-1',
        name: 'production',
        isDefault: true,
        applications: [
          { applicationId: 'app-crm-api', name: 'CRM 后端', appName: 'crm-api-7f3a', description: '对外 API' },
          { applicationId: 'app-crm-web', name: 'CRM 前端', appName: 'crm-web-91bd' },
        ],
        postgres: [{ postgresId: 'pg-1', name: '主库' }],
      },
      {
        environmentId: 'env-2',
        name: 'staging',
        isDefault: false,
        applications: [{ applicationId: 'app-crm-api-staging', name: 'CRM 后端', appName: 'crm-api-stg-22c1' }],
      },
    ],
  },
  {
    // 老版本形状：applications 直接挂在项目下
    projectId: 'proj-2',
    name: '旧版项目',
    applications: [{ applicationId: 'app-legacy', name: '遗留应用', appName: 'legacy-3f2c' }],
  },
  { projectId: 'proj-3', name: '空项目', compose: [{ composeId: 'c-1' }] },
];
/**
 * 构建记录（决策 28 / 30）：部署记录与状态的唯一事实源。description 里的 `eat:<id>` 标记
 * 是平台认领「这条构建记录属于哪次平台部署」的依据；Dokploy 侧直接触发的没有这个标记。
 */
let mockBuilds: Array<Record<string, unknown>> = [];
/** Dokploy 的部署队列（决策 30）：构建记录还没建出来的那段时间里唯一能看到这次部署的地方 */
let mockQueue: Array<Record<string, unknown>> = [];
let mockBuildLogs = '';
let mockAppName = 'crm-tool-app-7f3a';
let mockContainers: Array<Record<string, unknown>> = [];
let mockContainerLog = '';
/** 记录 Dokploy 收到的日志读取参数，用来断言 tail / 指定 id 有没有透传下去 */
const logCalls: Array<Record<string, string>> = [];
let dokployServer: http.Server;
let dokployWss: WebSocketServer;
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
        deployCalls.push(JSON.parse(body) as Record<string, string>);
        res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
      });
      return;
    }
    if (req.method === 'GET' && req.url === '/api/project.all') {
      if (req.headers['x-api-key'] !== 'dok-token-abcdef123456') {
        res.writeHead(401, { 'content-type': 'application/json' }).end('{"message":"invalid token"}');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(mockProjectAll));
      return;
    }
    if (req.method === 'GET' && req.url?.startsWith('/api/application.one')) {
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ appName: mockAppName }));
      return;
    }
    if (req.method === 'GET' && req.url?.startsWith('/api/deployment.queueList')) {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(mockQueue));
      return;
    }
    if (req.method === 'GET' && req.url?.startsWith('/api/deployment.allByType')) {
      // 构建记录是按应用查的：mockBuilds 都属于 app-123，别的应用一律空清单
      const id = new URL(req.url, 'http://x').searchParams.get('id');
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(id === 'app-123' ? mockBuilds : []));
      return;
    }
    if (req.method === 'GET' && req.url?.startsWith('/api/deployment.readLogs')) {
      const q = new URL(req.url, 'http://x').searchParams;
      logCalls.push({ kind: 'build', deploymentId: q.get('deploymentId') ?? '', tail: q.get('tail') ?? '' });
      // Dokploy 的 readLogs 返回的是一个 JSON 字符串，不是对象
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(mockBuildLogs));
      return;
    }
    if (req.method === 'GET' && req.url?.startsWith('/api/docker.getContainersByAppNameMatch')) {
      const q = new URL(req.url, 'http://x').searchParams;
      logCalls.push({ kind: 'containers', appName: q.get('appName') ?? '' });
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(mockContainers));
      return;
    }
    res.writeHead(404).end();
  });

  // 运行日志：Dokploy 只有 WebSocket 这一条路（REST 侧没有对应过程），mock 也得是 WS
  dokployWss = new WebSocketServer({ server: dokployServer, path: '/docker-container-logs' });
  dokployWss.on('connection', (socket, req) => {
    const q = new URL(req.url ?? '', 'http://x').searchParams;
    logCalls.push({ kind: 'run', containerId: q.get('containerId') ?? '', tail: q.get('tail') ?? '' });
    if (req.headers['x-api-key'] !== 'dok-token-abcdef123456') {
      socket.close(4003, 'Not authorized');
      return;
    }
    // 真实服务端是 pty 里的 docker logs --follow：发完这批就不再说话，客户端靠静默超时收工
    socket.send(mockContainerLog);
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
  dokployWss?.close();
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

describe('Dokploy 应用清单（决策 27：建项目时快速填 application id）', () => {
  const defaultMock = mockProjectAll;

  it('展平 project.all：environments 与项目下的 applications 都取，带回所属项目名，缺字段有兜底', async () => {
    const res = await api('GET', '/api/dokploy/applications', { token: ownerToken });
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(4);
    expect(res.body[0]).toEqual({
      applicationId: 'app-crm-api',
      name: 'CRM 后端',
      appName: 'crm-api-7f3a',
      projectName: '生产环境',
      description: '对外 API',
    });
    // 缺 description 的条目兜底为空串，不是 undefined
    expect(res.body[1]).toEqual({
      applicationId: 'app-crm-web',
      name: 'CRM 前端',
      appName: 'crm-web-91bd',
      projectName: '生产环境',
      description: '',
    });
    // 同名应用靠 appName + 所属项目区分（前端搜索因此要一并匹配 appName）；
    // 非默认环境的应用在分组名上带出环境名，默认环境只显示项目名
    expect(res.body[2]).toMatchObject({
      applicationId: 'app-crm-api-staging',
      name: 'CRM 后端',
      projectName: '生产环境 · staging',
    });
    // 老版本形状（applications 直接挂项目下）仍然认
    expect(res.body[3]).toMatchObject({ applicationId: 'app-legacy', projectName: '旧版项目' });
    // postgres / compose 等其他服务不出现在清单里
    expect(JSON.stringify(res.body)).not.toContain('pg-1');
    expect(JSON.stringify(res.body)).not.toContain('c-1');
  });

  it('与创建项目同权限：任何登录成员可用，未登录不可用', async () => {
    expect((await api('GET', '/api/dokploy/applications', { token: outsiderToken })).status).toBe(200);
    expect((await api('GET', '/api/dokploy/applications')).status).toBe(401);
  });

  it('防御式解析：跳过缺 applicationId 的条目，响应不是数组时回空清单', async () => {
    mockProjectAll = [
      { name: 'P', applications: [{ name: '没有 id 的条目' }, { applicationId: '', name: '空 id' }, { applicationId: 'ok-1' }] },
      { name: '坏项目', applications: '不是数组', environments: '也不是数组' },
      { name: '坏环境', environments: [{ name: 'production', applications: '不是数组' }, null] },
    ];
    const res = await api('GET', '/api/dokploy/applications', { token: ownerToken });
    expect(res.status).toBe(200);
    // 只剩合法的那条；name 缺失时兜底用 id
    expect(res.body).toEqual([{ applicationId: 'ok-1', name: 'ok-1', appName: '', projectName: 'P', description: '' }]);

    mockProjectAll = { message: 'unexpected' };
    expect((await api('GET', '/api/dokploy/applications', { token: ownerToken })).body).toEqual([]);
    mockProjectAll = defaultMock;
  });

  it('Dokploy 停用时回 503 DOKPLOY_UNAVAILABLE，前端据此提示仍可手填', async () => {
    await api('PUT', '/api/admin/dokploy-settings', {
      token: adminToken,
      payload: { apiUrl: dokployUrl, apiToken: '', enabled: false },
    });
    const res = await api('GET', '/api/dokploy/applications', { token: ownerToken });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('DOKPLOY_UNAVAILABLE');

    // 复原，后续用例依赖 Dokploy 可用
    await api('PUT', '/api/admin/dokploy-settings', {
      token: adminToken,
      payload: { apiUrl: dokployUrl, apiToken: '', enabled: true },
    });
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

describe('部署门禁与部署记录（决策 30）', () => {
  let metaId: string;
  const iso = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();
  const ageAllDeployments = async (interval: string) => {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    await pool.query(`update deployment set created_at = now() - interval '${interval}'`);
    await pool.end();
  };

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

  it('触发部署：Dokploy 收到带认领标记的调用，记录先是「排队中」', async () => {
    mockBuilds = [];
    mockQueue = [];
    const r = await api('POST', '/api/projects/crm-tool/deploy', {
      token: memberToken,
      payload: { report: passingReport() },
    });
    expect(r.status).toBe(201);
    // 构建记录要等 Dokploy 的队列执行到才建出来，此刻只可能是排队中
    expect(r.body.status).toBe('queued');
    expect(r.body.deploymentId).toBeNull();
    expect(r.body.origin).toBe('platform');
    metaId = r.body.platform.id;

    expect(deployCalls).toHaveLength(1);
    expect(deployCalls[0].applicationId).toBe('app-123');
    // 标记必须原样带给 Dokploy——整条认领链路都挂在它上面（决策 30）
    expect(deployCalls[0].description).toBe(`eat:${metaId}`);
    expect(deployCalls[0].title).toContain('组员');
  });

  it('排队阶段：从 Dokploy 的部署队列里看到自己刚触发的那次，别的应用不串味', async () => {
    mockQueue = [
      {
        data: { applicationId: 'app-123', titleLog: 'eat · 组员 · crm-tool', descriptionLog: `eat:${metaId}` },
        state: 'waiting',
        timestamp: Date.now(),
      },
      { data: { applicationId: 'app-other', titleLog: '别人的项目', descriptionLog: '' }, state: 'waiting', timestamp: Date.now() },
    ];
    const list = await api('GET', '/api/projects/crm-tool/deployments', { token: memberToken });
    expect(list.body).toHaveLength(1);
    expect(list.body[0].status).toBe('queued');
    expect(list.body[0].platform.id).toBe(metaId);
  });

  it('构建记录出现后靠标记精确认领；同时刻在 Dokploy 侧触发的部署也列出来，且不被张冠李戴', async () => {
    mockQueue = [];
    mockBuilds = [
      // 同一时刻还有一次在 Dokploy 控制台点的部署：按时间猜的老做法正是在这里认错人
      { deploymentId: 'build-console', title: 'Manual deployment', description: '', status: 'running', createdAt: iso() },
      {
        deploymentId: 'build-mine',
        title: 'eat · 组员 · crm-tool',
        description: `eat:${metaId}`,
        status: 'running',
        createdAt: iso(),
      },
    ];
    const list = await api('GET', '/api/projects/crm-tool/deployments', { token: memberToken });
    expect(list.body).toHaveLength(2);

    const mine = list.body.find((d: Record<string, never>) => d.deploymentId === 'build-mine');
    expect(mine.origin).toBe('platform');
    expect(mine.platform.id).toBe(metaId);
    expect(mine.platform.claim).toBe('tagged');
    expect(mine.platform.triggeredByName).toBe('组员');
    expect(mine.platform.report.passed).toBe(true);

    const fromConsole = list.body.find((d: Record<string, never>) => d.deploymentId === 'build-console');
    expect(fromConsole.origin).toBe('dokploy');
    expect(fromConsole.platform).toBeNull();
  });

  it('状态直接用 Dokploy 的取值，cancelled 不再被显示成「空闲」', async () => {
    mockBuilds = [{ ...mockBuilds[1], status: 'done' }, { ...mockBuilds[0], status: 'cancelled' }];
    const list = await api('GET', '/api/projects/crm-tool/deployments', { token: ownerToken });
    expect(list.body.map((d: Record<string, never>) => d.status).sort()).toEqual(['cancelled', 'done']);
  });

  it('最近一次部署：Dokploy 构建 id 与平台元数据 id 都能查，都支持前 8 位；没部署过回 404', async () => {
    const latest = await api('GET', '/api/projects/crm-tool/deployments/latest', { token: memberToken });
    expect(latest.status).toBe(200);
    expect(latest.body.platform.id).toBe(metaId);

    const byBuildId = await api('GET', '/api/projects/crm-tool/deployments/build-mine', { token: memberToken });
    expect(byBuildId.body.deploymentId).toBe('build-mine');
    const byMetaId = await api('GET', `/api/projects/crm-tool/deployments/${metaId}`, { token: memberToken });
    expect(byMetaId.body.deploymentId).toBe('build-mine');
    const byShortMetaId = await api('GET', `/api/projects/crm-tool/deployments/${metaId.slice(0, 8)}`, { token: memberToken });
    expect(byShortMetaId.body.deploymentId).toBe('build-mine');

    await api('POST', '/api/projects', {
      token: ownerToken,
      payload: { slug: 'never-deployed', name: '没部署过', dokployApplicationId: 'app-none' },
    });
    const none = await api('GET', '/api/projects/never-deployed/deployments/latest', { token: ownerToken });
    expect(none.status).toBe(404);
  });

  it('查单条的边界：过短 400、无匹配 404、命中多条 409', async () => {
    const tooShort = await api('GET', `/api/projects/crm-tool/deployments/${metaId.slice(0, 6)}`, { token: memberToken });
    expect(tooShort.status).toBe(400);
    expect(tooShort.body.error).toBe('VALIDATION_FAILED');
    expect((await api('GET', '/api/projects/crm-tool/deployments/zzzzzzzz', { token: memberToken })).status).toBe(404);

    // UUID 随机，构造不出天然碰撞，这里插一条与 metaId 同前缀的元数据
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const twin = `${metaId.slice(0, 8)}-dead-4bee-8000-000000000001`;
    const src = (await pool.query('select project_id, triggered_by from deployment where id = $1', [metaId])).rows[0];
    await pool.query('insert into deployment (id, project_id, triggered_by) values ($1, $2, $3)', [
      twin,
      src.project_id,
      src.triggered_by,
    ]);
    const dup = await api('GET', `/api/projects/crm-tool/deployments/${metaId.slice(0, 8)}`, { token: memberToken });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toBe('AMBIGUOUS_ID');
    await pool.query('delete from deployment where id = $1', [twin]);
    await pool.end();
  });

  it('构建失败：error 带上构建日志末尾的真实报错，但日志只给项目成员看（决策 28）', async () => {
    mockBuilds = [
      {
        deploymentId: 'build-mine',
        title: 'eat · 组员 · crm-tool',
        description: `eat:${metaId}`,
        status: 'error',
        errorMessage: 'boom',
        createdAt: iso(),
      },
    ];
    mockBuildLogs = 'Initializing deployment\nnpm ERR! code E404\nnpm ERR! 404 Not Found - GET https://registry/foo\n\n❌ 构建失败\n';
    const asMember = await api('GET', '/api/projects/crm-tool/deployments/latest', { token: memberToken });
    expect(asMember.body.status).toBe('error');
    // 不再是「详见 Dokploy 控制台」那种打发人的文案
    expect(asMember.body.error).toContain('npm ERR! 404 Not Found');
    expect(asMember.body.error).toContain('eat project build-logs crm-tool');

    // 日志可能带出构建期注入的密钥：非项目成员只看得到 Dokploy 记录上那句 errorMessage
    const asOutsider = await api('GET', '/api/projects/crm-tool/deployments/latest', { token: outsiderToken });
    expect(asOutsider.body.status).toBe('error');
    expect(asOutsider.body.error).toBe('boom');
  });

  it('老版本 Dokploy 丢掉标记时，回落到按时间推断认领，并标注 inferred', async () => {
    // 把已有元数据推老，让它们落在推断时间窗之外，避免旧记录来抢这条构建
    await ageAllDeployments('2 hours');
    mockBuilds = [];
    mockQueue = [];
    const r = await api('POST', '/api/projects/crm-tool/deploy', { token: ownerToken, payload: { report: passingReport() } });
    // 老版本 Dokploy（< v0.25.0）不认 title/description，建出来的记录没有标记
    mockBuilds = [{ deploymentId: 'build-untagged', title: 'Manual deployment', description: '', status: 'done', createdAt: iso(1000) }];

    const one = await api('GET', `/api/projects/crm-tool/deployments/${r.body.platform.id}`, { token: ownerToken });
    expect(one.body.deploymentId).toBe('build-untagged');
    expect(one.body.status).toBe('done');
    // 归属是猜的，如实标出来，让 CLI / 控制台能提示用户
    expect(one.body.platform.claim).toBe('inferred');
  });

  it('Dokploy 清理掉构建记录后：默认视图看不到，--all 仍能看到平台侧历史', async () => {
    await ageAllDeployments('3 hours');
    // 再补一次「刚部署完就被清理」：认领过的元数据不能因为「刚触发不久」又被退回成排队中
    mockBuilds = [];
    mockQueue = [];
    const fresh = await api('POST', '/api/projects/crm-tool/deploy', { token: ownerToken, payload: { report: passingReport() } });
    mockBuilds = [
      {
        deploymentId: 'build-fresh',
        title: 'eat · 项目主 · crm-tool',
        description: `eat:${fresh.body.platform.id}`,
        status: 'done',
        createdAt: iso(),
      },
    ];
    // 先查一次让它完成认领（dokploy_deployment_id 回写），再模拟 Dokploy 的清理
    await api('GET', '/api/projects/crm-tool/deployments', { token: memberToken });
    // Dokploy 每个应用只留最近 10 条，更早的构建记录连日志一起被删掉
    mockBuilds = [];

    const def = await api('GET', '/api/projects/crm-tool/deployments', { token: memberToken });
    expect(def.body).toHaveLength(0);

    const all = await api('GET', '/api/projects/crm-tool/deployments?all=1', { token: memberToken });
    expect(all.body.length).toBeGreaterThan(0);
    expect(all.body.every((d: Record<string, never>) => d.status === 'archived')).toBe(true);
    // 「谁触发的、带了什么扫描报告」是平台的合规记录，不能跟着 Dokploy 的清理一起消失
    const mine = all.body.find((d: Record<string, never>) => d.platform.id === metaId);
    expect(mine.platform.triggeredByName).toBe('组员');
    expect(mine.platform.report.passed).toBe(true);
    expect(mine.deploymentId).toBe('build-mine');
    // 「最近一次部署」此时要说清是被清理了，而不是「还没部署过」——后者会误导人再部署一次
    const latest = await api('GET', '/api/projects/crm-tool/deployments/latest', { token: memberToken });
    expect(latest.status).toBe(404);
    expect(latest.body.message).toContain('--all');

    // 刚认领完就被清理的那条也归档，而不是退回排队中
    const justCleaned = all.body.find((d: Record<string, never>) => d.platform.id === fresh.body.platform.id);
    expect(justCleaned.status).toBe('archived');
    expect(justCleaned.deploymentId).toBe('build-fresh');
  });

  it('认领过的元数据不再去认领别人的构建：Dokploy 侧的部署不会被冒认成平台部署', async () => {
    // 承上：Dokploy 的构建记录已被清空，平台元数据全是「认领过、构建记录已没了」的状态。
    // 此时有人在 Dokploy 侧点了一次部署——按时间推断的老做法会让上面那条元数据把它认走
    mockBuilds = [
      { deploymentId: 'build-console-late', title: 'Manual deployment', description: '', status: 'done', createdAt: iso() },
    ];
    const list = await api('GET', '/api/projects/crm-tool/deployments', { token: memberToken });
    const row = list.body.find((d: Record<string, never>) => d.deploymentId === 'build-console-late');
    expect(row.origin).toBe('dokploy');
    expect(row.platform).toBeNull();
  });
});

describe('构建日志与运行日志（决策 28）', () => {
  beforeAll(() => {
    mockBuilds = [
      { deploymentId: 'build-2', title: 'Manual deployment', status: 'done', createdAt: '2026-09-02T07:00:00.000Z' },
      { deploymentId: 'build-1', title: '上一次', status: 'error', errorMessage: 'boom', createdAt: '2026-09-02T06:00:00.000Z' },
    ];
    mockBuildLogs = 'Initializing deployment\nBuild finished\n';
    mockContainers = [
      { containerId: 'c-stopped', name: 'crm-tool.0', state: 'exited', status: 'Exited (1)' },
      { containerId: 'c-running', name: 'crm-tool.1', state: 'running', status: 'Up 3 minutes' },
    ];
    mockContainerLog = '2026-09-02T07:01:00Z listening on :3000\r\n';
    logCalls.length = 0;
  });

  it('构建日志：默认最近一次，带回最近构建列表，tail 透传', async () => {
    const r = await api('GET', '/api/projects/crm-tool/build-logs?tail=50', { token: memberToken });
    expect(r.status).toBe(200);
    expect(r.body.deployment.deploymentId).toBe('build-2');
    expect(r.body.logs).toContain('Build finished');
    expect(r.body.recent).toHaveLength(2);
    expect(logCalls.at(-1)).toEqual({ kind: 'build', deploymentId: 'build-2', tail: '50' });
  });

  it('构建日志：可回看指定那次，指定不存在的构建回 404', async () => {
    const r = await api('GET', '/api/projects/crm-tool/build-logs?deploymentId=build-1', { token: memberToken });
    expect(r.body.deployment.deploymentId).toBe('build-1');
    expect(logCalls.at(-1)?.tail).toBe('200');
    const missing = await api('GET', '/api/projects/crm-tool/build-logs?deploymentId=nope', { token: memberToken });
    expect(missing.status).toBe(404);
  });

  it('运行日志：默认取运行中的容器，行尾 \\r\\n 归一', async () => {
    const r = await api('GET', '/api/projects/crm-tool/run-logs?tail=20', { token: memberToken });
    expect(r.status).toBe(200);
    expect(r.body.container.containerId).toBe('c-running');
    expect(r.body.containers).toHaveLength(2);
    expect(r.body.logs).toBe('2026-09-02T07:01:00Z listening on :3000\n');
    expect(logCalls.at(-1)).toEqual({ kind: 'run', containerId: 'c-running', tail: '20' });
  });

  it('运行日志：没有容器时不报错，回 container=null（应用可能还没部署成功）', async () => {
    mockContainers = [];
    const r = await api('GET', '/api/projects/crm-tool/run-logs', { token: memberToken });
    expect(r.status).toBe(200);
    expect(r.body.container).toBeNull();
    expect(r.body.logs).toBe('');
  });

  it('日志可能带出构建期注入的密钥：非项目成员一律 403', async () => {
    expect((await api('GET', '/api/projects/crm-tool/build-logs', { token: outsiderToken })).status).toBe(403);
    expect((await api('GET', '/api/projects/crm-tool/run-logs', { token: outsiderToken })).status).toBe(403);
    expect((await api('GET', '/api/projects/crm-tool/build-logs')).status).toBe(401);
  });

  it('tail 超出范围按 VALIDATION_FAILED 拒绝，不透传给 Dokploy', async () => {
    const r = await api('GET', '/api/projects/crm-tool/build-logs?tail=99999', { token: memberToken });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('VALIDATION_FAILED');
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
