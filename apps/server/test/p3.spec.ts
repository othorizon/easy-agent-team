/**
 * P3 端到端测试：Dokploy 接入（mock）/ 应用的自助创建与挂载（决策 31）/ 成员 / 部署授权门禁 /
 * 部署记录（决策 30）/ 应用 env 推拉 / 构建与运行日志（决策 28）/ 密钥指纹清单
 */
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

// ---------- mock Dokploy ----------
const DOK_TOKEN = 'dok-token-abcdef123456';
/** Dokploy 收到的 application.deploy 请求体（决策 30 后还要断言认领标记有没有带上） */
const deployCalls: Array<Record<string, string>> = [];
/** Dokploy 收到的建应用 / 配 Git / 配构建 / 写 env / 删应用调用（决策 31） */
const dokCalls: Array<{ op: string; body: Record<string, unknown> }> = [];
/** 让 saveGitProvider 失败一次，验证建应用的回滚 */
let failGitProviderOnce = false;
/** 让 application.delete 失败，验证删应用时 Dokploy 删不掉就不动平台记录 */
let failDelete = false;
/** 让 domain.create 失败一次，验证绑域名失败时整体回滚（决策 32） */
let failDomainOnce = false;
let createdSeq = 0;
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
/** 应用上的 env / buildArgs（application.one 回、saveEnvironment 写） */
let mockEnv = 'PORT=3000\nDATABASE_URL=postgres://x\n';
let mockBuildArgs = 'NODE_VERSION=20\n';
let mockContainers: Array<Record<string, unknown>> = [];
let mockContainerLog = '';
/** 记录 Dokploy 收到的日志读取参数，用来断言 tail / 指定 id 有没有透传下去 */
const logCalls: Array<Record<string, string>> = [];
/** 构建记录归属的应用：crm-tool 在 Dokploy 上的 application id（由 mock 生成，建完才知道） */
let crmAppId = '';
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

const fullSettings = (extra: Record<string, unknown> = {}) => ({
  apiUrl: dokployUrl,
  apiToken: '',
  enabled: true,
  projectId: 'proj-1',
  environmentId: 'env-1',
  sshKeyId: 'key-1',
  ...extra,
});

const readBody = (req: http.IncomingMessage): Promise<Record<string, unknown>> =>
  new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => resolve(body ? (JSON.parse(body) as Record<string, unknown>) : {}));
  });

beforeAll(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await pool.query('drop schema public cascade; create schema public; drop schema if exists drizzle cascade;');
  await migrate(drizzle(pool), { migrationsFolder: path.resolve(process.cwd(), 'drizzle') });
  const db = drizzle(pool, { schema });
  const hash = await bcrypt.hash('password123', 4);
  await db.insert(schema.users).values([
    { name: '管理员', email: 'admin@test.dev', role: 'admin', passwordHash: hash },
    { name: '应用主', email: 'owner@test.dev', role: 'member', passwordHash: hash },
    { name: '组员', email: 'member@test.dev', role: 'member', passwordHash: hash },
    { name: '路人', email: 'outsider@test.dev', role: 'member', passwordHash: hash },
  ]);
  await pool.end();

  dokployServer = http.createServer((req, res) => {
    const json = (status: number, data: unknown) =>
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(data));
    if (req.headers['x-api-key'] !== DOK_TOKEN) {
      json(401, { message: 'invalid token' });
      return;
    }
    const url = new URL(req.url ?? '/', 'http://x');
    if (req.method === 'POST') {
      void readBody(req).then((body) => {
        switch (url.pathname) {
          case '/api/application.deploy':
            deployCalls.push(body as Record<string, string>);
            return json(200, {});
          case '/api/application.create': {
            createdSeq += 1;
            const applicationId = `app-created-${createdSeq}`;
            dokCalls.push({ op: 'create', body });
            return json(200, { applicationId, appName: `${String(body.name).toLowerCase()}-${createdSeq}abc`, name: body.name });
          }
          case '/api/application.saveGitProvider':
            dokCalls.push({ op: 'git', body });
            if (failGitProviderOnce) {
              failGitProviderOnce = false;
              return json(400, { message: 'Invalid branch name' });
            }
            return json(200, true);
          case '/api/application.saveBuildType':
            dokCalls.push({ op: 'build', body });
            return json(200, true);
          case '/api/application.saveEnvironment':
            dokCalls.push({ op: 'env', body });
            mockEnv = String(body.env ?? '');
            mockBuildArgs = String(body.buildArgs ?? '');
            return json(200, true);
          case '/api/application.delete':
            dokCalls.push({ op: 'delete', body });
            return failDelete ? json(500, { message: 'boom' }) : json(200, true);
          case '/api/domain.create':
            dokCalls.push({ op: 'domain', body });
            if (failDomainOnce) {
              failDomainOnce = false;
              return json(400, { message: 'Invalid domain name' });
            }
            // 真实响应是整条域名记录；平台只用 domainId
            return json(200, { domainId: `dom-${createdSeq}`, ...body });
          case '/api/domain.update':
            dokCalls.push({ op: 'domainUpdate', body });
            return json(200, body);
          default:
            return res.writeHead(404).end();
        }
      });
      return;
    }
    switch (url.pathname) {
      case '/api/project.all':
        return json(200, mockProjectAll);
      case '/api/sshKey.allForApps':
        return json(200, [
          { sshKeyId: 'key-1', name: 'deploy-key' },
          { sshKeyId: 'key-2', name: '备用 key' },
          { name: '没有 id 的坏条目' },
        ]);
      case '/api/application.one':
        return json(200, { appName: mockAppName, env: mockEnv, buildArgs: mockBuildArgs, buildSecrets: 'S=1', createEnvFile: false });
      case '/api/deployment.queueList':
        return json(200, mockQueue);
      case '/api/deployment.allByType':
        // 构建记录是按应用查的：mockBuilds 都属于 crm-tool，别的应用一律空清单
        return json(200, url.searchParams.get('id') === crmAppId ? mockBuilds : []);
      case '/api/deployment.readLogs':
        logCalls.push({ kind: 'build', deploymentId: url.searchParams.get('deploymentId') ?? '', tail: url.searchParams.get('tail') ?? '' });
        // Dokploy 的 readLogs 返回的是一个 JSON 字符串，不是对象
        return json(200, mockBuildLogs);
      case '/api/docker.getContainersByAppNameMatch':
        logCalls.push({ kind: 'containers', appName: url.searchParams.get('appName') ?? '' });
        return json(200, mockContainers);
      default:
        return res.writeHead(404).end();
    }
  });

  // 运行日志：Dokploy 只有 WebSocket 这一条路（REST 侧没有对应过程），mock 也得是 WS
  dokployWss = new WebSocketServer({ server: dokployServer, path: '/docker-container-logs' });
  dokployWss.on('connection', (socket, req) => {
    const q = new URL(req.url ?? '', 'http://x').searchParams;
    logCalls.push({ kind: 'run', containerId: q.get('containerId') ?? '', tail: q.get('tail') ?? '' });
    if (req.headers['x-api-key'] !== DOK_TOKEN) {
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
  it('仅管理员可配置，token 打码；未配项目/环境时 provisioningReady=false', async () => {
    expect((await api('GET', '/api/admin/dokploy-settings', { token: ownerToken })).status).toBe(403);
    const put = await api('PUT', '/api/admin/dokploy-settings', {
      token: adminToken,
      payload: { apiUrl: dokployUrl, apiToken: DOK_TOKEN, enabled: true },
    });
    expect(put.status).toBe(200);
    expect(put.body.provisioningReady).toBe(false);
    const get = await api('GET', '/api/admin/dokploy-settings', { token: adminToken });
    expect(get.body.apiTokenMasked).toBe('dok-****3456');
    expect(get.body.apiUrl).toBe(dokployUrl);
    expect(get.body).toMatchObject({ projectId: '', environmentId: '', sshKeyId: '' });
  });

  it('连通性测试：token 留空回落已保存值，错 token/错地址返回 ok=false，仅管理员可用', async () => {
    expect((await api('POST', '/api/admin/dokploy-settings/test', { token: ownerToken, payload: { apiUrl: dokployUrl, apiToken: '' } })).status).toBe(403);

    const ok = await api('POST', '/api/admin/dokploy-settings/test', { token: adminToken, payload: { apiUrl: dokployUrl, apiToken: '' } });
    expect(ok.status).toBe(200);
    expect(ok.body.ok).toBe(true);
    expect(typeof ok.body.latencyMs).toBe('number');

    const badToken = await api('POST', '/api/admin/dokploy-settings/test', { token: adminToken, payload: { apiUrl: dokployUrl, apiToken: 'wrong-token' } });
    expect(badToken.body.ok).toBe(false);
    expect(badToken.body.message).toContain('401');

    const badUrl = await api('POST', '/api/admin/dokploy-settings/test', { token: adminToken, payload: { apiUrl: `${dokployUrl}/nope`, apiToken: '' } });
    expect(badUrl.body.ok).toBe(false);
    expect(badUrl.body.message).toContain('404');
  });

  it('管理员选自助建应用的落点：项目/环境清单与 SSH key 清单，都仅管理员可用（决策 31）', async () => {
    expect((await api('GET', '/api/admin/dokploy/projects', { token: ownerToken })).status).toBe(403);
    expect((await api('GET', '/api/admin/dokploy/ssh-keys', { token: ownerToken })).status).toBe(403);

    const projects = await api('GET', '/api/admin/dokploy/projects', { token: adminToken });
    expect(projects.status).toBe(200);
    expect(projects.body).toEqual([
      {
        projectId: 'proj-1',
        name: '生产环境',
        environments: [
          { environmentId: 'env-1', name: 'production', isDefault: true },
          { environmentId: 'env-2', name: 'staging', isDefault: false },
        ],
      },
      // 老版本没有 environments：空数组，管理员选不到环境，自助建应用随之不可用
      { projectId: 'proj-2', name: '旧版项目', environments: [] },
      { projectId: 'proj-3', name: '空项目', environments: [] },
    ]);

    const keys = await api('GET', '/api/admin/dokploy/ssh-keys', { token: adminToken });
    // 缺 id 的坏条目跳过
    expect(keys.body).toEqual([
      { sshKeyId: 'key-1', name: 'deploy-key' },
      { sshKeyId: 'key-2', name: '备用 key' },
    ]);

    const saved = await api('PUT', '/api/admin/dokploy-settings', { token: adminToken, payload: fullSettings() });
    expect(saved.body).toMatchObject({ projectId: 'proj-1', environmentId: 'env-1', sshKeyId: 'key-1', provisioningReady: true });
  });

  it('自动分配域名的后缀（决策 32）：默认不分配；输入标准化（去协议 / 通配前缀 / 大小写）；非法主机名 400', async () => {
    const before = await api('GET', '/api/admin/dokploy-settings', { token: adminToken });
    expect(before.body).toMatchObject({ domainSuffix: '', domainHttps: false });

    // 管理员多半照着 DNS 通配记录或带协议的地址贴：都认，存成干净的主机名
    const saved = await api('PUT', '/api/admin/dokploy-settings', {
      token: adminToken,
      payload: fullSettings({ domainSuffix: ' https://*.Apps.Example.com/ ', domainHttps: true }),
    });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ domainSuffix: 'apps.example.com', domainHttps: true });

    for (const bad of ['apps_example.com', 'localhost', 'apps.example.com/path', '-apps.example.com']) {
      const r = await api('PUT', '/api/admin/dokploy-settings', { token: adminToken, payload: fullSettings({ domainSuffix: bad }) });
      expect(r.status, bad).toBe(400);
    }
    // 后面的建应用用例默认不分配域名
    const reset = await api('PUT', '/api/admin/dokploy-settings', { token: adminToken, payload: fullSettings() });
    expect(reset.body).toMatchObject({ domainSuffix: '', domainHttps: false });
  });
});

describe('Dokploy 应用清单（决策 27：管理员挂载既有应用时快速填 application id）', () => {
  const defaultMock = mockProjectAll;

  it('展平 project.all：environments 与项目下的 applications 都取，带回所属项目名，缺字段有兜底', async () => {
    const res = await api('GET', '/api/admin/dokploy/applications', { token: adminToken });
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
    expect(res.body[1]).toEqual({ applicationId: 'app-crm-web', name: 'CRM 前端', appName: 'crm-web-91bd', projectName: '生产环境', description: '' });
    // 非默认环境的应用在分组名上带出环境名，默认环境只显示项目名
    expect(res.body[2]).toMatchObject({ applicationId: 'app-crm-api-staging', name: 'CRM 后端', projectName: '生产环境 · staging' });
    // 老版本形状（applications 直接挂项目下）仍然认
    expect(res.body[3]).toMatchObject({ applicationId: 'app-legacy', projectName: '旧版项目' });
    // postgres / compose 等其他服务不出现在清单里
    expect(JSON.stringify(res.body)).not.toContain('pg-1');
    expect(JSON.stringify(res.body)).not.toContain('c-1');
  });

  it('挂载是管理员的事：普通成员与未登录都不可用（决策 31 收紧了决策 27 的权限）', async () => {
    expect((await api('GET', '/api/admin/dokploy/applications', { token: outsiderToken })).status).toBe(403);
    expect((await api('GET', '/api/admin/dokploy/applications')).status).toBe(401);
  });

  it('防御式解析：跳过缺 applicationId 的条目，响应不是数组时回空清单', async () => {
    mockProjectAll = [
      { name: 'P', applications: [{ name: '没有 id 的条目' }, { applicationId: '', name: '空 id' }, { applicationId: 'ok-1' }] },
      { name: '坏项目', applications: '不是数组', environments: '也不是数组' },
      { name: '坏环境', environments: [{ name: 'production', applications: '不是数组' }, null] },
    ];
    const res = await api('GET', '/api/admin/dokploy/applications', { token: adminToken });
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ applicationId: 'ok-1', name: 'ok-1', appName: '', projectName: 'P', description: '' }]);

    mockProjectAll = { message: 'unexpected' };
    expect((await api('GET', '/api/admin/dokploy/applications', { token: adminToken })).body).toEqual([]);
    mockProjectAll = defaultMock;
  });

  it('Dokploy 停用时回 503 DOKPLOY_UNAVAILABLE', async () => {
    await api('PUT', '/api/admin/dokploy-settings', { token: adminToken, payload: fullSettings({ enabled: false }) });
    const res = await api('GET', '/api/admin/dokploy/applications', { token: adminToken });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('DOKPLOY_UNAVAILABLE');
    // 复原，后续用例依赖 Dokploy 可用
    await api('PUT', '/api/admin/dokploy-settings', { token: adminToken, payload: fullSettings() });
  });
});

describe('应用：自助创建与挂载（决策 31）', () => {
  it('管理员没配项目/环境时不能自助建应用，错误指到该改的位置', async () => {
    await api('PUT', '/api/admin/dokploy-settings', { token: adminToken, payload: fullSettings({ projectId: '', environmentId: '' }) });
    const r = await api('POST', '/api/apps', {
      token: ownerToken,
      payload: { slug: 'crm-tool', name: 'CRM 小工具', repoUrl: 'git@git.example.com:team/crm.git', buildType: 'dockerfile' },
    });
    expect(r.status).toBe(503);
    expect(r.body.error).toBe('DOKPLOY_PROVISIONING_UNCONFIGURED');
    expect(r.body.message).toContain('系统设置');
    expect(dokCalls).toHaveLength(0);
    await api('PUT', '/api/admin/dokploy-settings', { token: adminToken, payload: fullSettings() });
  });

  it('自助创建（Dockerfile）：Dokploy 上依次建应用、绑 Git 源 + SSH key、配构建方式；用户自建的默认未授权部署', async () => {
    const r = await api('POST', '/api/apps', {
      token: ownerToken,
      payload: {
        slug: 'crm-tool',
        name: 'CRM 小工具',
        repoUrl: 'git@git.example.com:team/crm.git',
        buildType: 'dockerfile',
        dockerfile: 'docker/Dockerfile',
        dockerContextPath: 'apps/api',
        description: '内部 CRM',
      },
    });
    expect(r.status).toBe(201);
    crmAppId = r.body.dokployApplicationId;
    expect(crmAppId).toBe('app-created-1');
    expect(r.body).toMatchObject({
      slug: 'crm-tool',
      branch: 'main',
      buildType: 'dockerfile',
      dockerfile: 'docker/Dockerfile',
      dockerContextPath: 'apps/api',
      managed: true,
      deployApproved: false,
      approvedByName: null,
      approvalRequestedAt: null,
      isMember: true,
      canDeploy: false,
      ownerName: '应用主',
    });

    expect(dokCalls.map((c) => c.op)).toEqual(['create', 'git', 'build']);
    // 建在管理员配置的环境下；description 带上平台标识，Dokploy 控制台里能认出是谁建的
    expect(dokCalls[0].body).toMatchObject({ name: 'CRM 小工具', environmentId: 'env-1' });
    expect(String(dokCalls[0].body.description)).toContain('crm-tool');
    expect(String(dokCalls[0].body.description)).toContain('内部 CRM');
    // Git 源：字段名照 Dokploy 自己的表单，watchPaths / enableSubmodules 必须带
    expect(dokCalls[1].body).toEqual({
      applicationId: 'app-created-1',
      customGitUrl: 'git@git.example.com:team/crm.git',
      customGitBranch: 'main',
      customGitBuildPath: '/',
      customGitSSHKeyId: 'key-1',
      watchPaths: [],
      enableSubmodules: false,
    });
    // 构建方式：与 dockerfile 无关的字段传 null
    expect(dokCalls[2].body).toEqual({
      applicationId: 'app-created-1',
      buildType: 'dockerfile',
      dockerfile: 'docker/Dockerfile',
      dockerContextPath: 'apps/api',
      dockerBuildStage: null,
      herokuVersion: null,
      railpackVersion: null,
      publishDirectory: null,
      isStaticSpa: null,
    });
    dokCalls.length = 0;
  });

  it('自助创建（静态托管）：发布目录与 SPA 开关写进构建方式；不配 SSH key 时 Git 源不绑 key', async () => {
    await api('PUT', '/api/admin/dokploy-settings', { token: adminToken, payload: fullSettings({ sshKeyId: '' }) });
    const r = await api('POST', '/api/apps', {
      token: memberToken,
      payload: {
        slug: 'docs-site',
        name: '文档站',
        repoUrl: 'https://git.example.com/team/docs.git',
        branch: 'release',
        buildType: 'static',
        publishDirectory: 'dist',
        staticSpa: true,
      },
    });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ buildType: 'static', publishDirectory: 'dist', staticSpa: true, branch: 'release', dockerfile: 'Dockerfile' });
    expect(dokCalls[1].body).toMatchObject({ customGitBranch: 'release', customGitSSHKeyId: null });
    expect(dokCalls[2].body).toEqual({
      applicationId: 'app-created-2',
      buildType: 'static',
      dockerfile: null,
      dockerContextPath: null,
      dockerBuildStage: null,
      herokuVersion: null,
      railpackVersion: null,
      publishDirectory: 'dist',
      isStaticSpa: true,
    });
    dokCalls.length = 0;
    await api('PUT', '/api/admin/dokploy-settings', { token: adminToken, payload: fullSettings() });
  });

  it('参数校验：Git 地址必填、构建方式只认两种、路径不许绝对或往上跳、slug 重名 409', async () => {
    const base = { slug: 'bad', name: 'x', repoUrl: 'https://git.example.com/x.git', buildType: 'dockerfile' };
    expect((await api('POST', '/api/apps', { token: ownerToken, payload: { ...base, repoUrl: '' } })).status).toBe(400);
    expect((await api('POST', '/api/apps', { token: ownerToken, payload: { ...base, buildType: 'nixpacks' } })).status).toBe(400);
    expect((await api('POST', '/api/apps', { token: ownerToken, payload: { ...base, dockerfile: '/etc/Dockerfile' } })).status).toBe(400);
    expect((await api('POST', '/api/apps', { token: ownerToken, payload: { ...base, dockerContextPath: '../other' } })).status).toBe(400);
    const dup = await api('POST', '/api/apps', { token: memberToken, payload: { ...base, slug: 'crm-tool' } });
    expect(dup.status).toBe(409);
    // 校验没过就不该碰 Dokploy
    expect(dokCalls).toHaveLength(0);
  });

  it('Dokploy 侧配置失败时回滚：删掉刚建出来的应用，平台里也不留记录', async () => {
    failGitProviderOnce = true;
    const r = await api('POST', '/api/apps', {
      token: ownerToken,
      payload: { slug: 'broken', name: '坏分支', repoUrl: 'https://git.example.com/b.git', branch: 'bad branch', buildType: 'dockerfile' },
    });
    expect(r.status).toBe(503);
    expect(r.body.error).toBe('DOKPLOY_UNAVAILABLE');
    expect(r.body.message).toContain('Git 源');
    expect(dokCalls.map((c) => c.op)).toEqual(['create', 'git', 'delete']);
    expect(dokCalls[2].body).toEqual({ applicationId: 'app-created-3' });
    const list = await api('GET', '/api/apps', { token: ownerToken });
    expect(list.body.map((a: { slug: string }) => a.slug)).not.toContain('broken');
    dokCalls.length = 0;
  });

  it('管理员自己建的应用创建即已授权', async () => {
    const r = await api('POST', '/api/apps', {
      token: adminToken,
      payload: { slug: 'admin-app', name: '管理员的应用', repoUrl: 'https://git.example.com/a.git', buildType: 'dockerfile' },
    });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ managed: true, deployApproved: true, approvedByName: '管理员', canDeploy: true });
    expect(r.body.approvedAt).not.toBeNull();
    dokCalls.length = 0;
  });

  it('配了域名后缀：建应用时自动绑 <slug>.<后缀>，dockerfile 转发到应用填的端口，结果里带 domain / url（决策 32）', async () => {
    await api('PUT', '/api/admin/dokploy-settings', { token: adminToken, payload: fullSettings({ domainSuffix: 'apps.example.com' }) });
    const r = await api('POST', '/api/apps', {
      token: ownerToken,
      payload: { slug: 'with-domain', name: '带域名', repoUrl: 'https://git.example.com/d.git', buildType: 'dockerfile', port: 8080 },
    });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ port: 8080, domain: 'with-domain.apps.example.com', url: 'http://with-domain.apps.example.com' });
    expect(dokCalls.map((c) => c.op)).toEqual(['create', 'git', 'build', 'domain']);
    // 请求体照 Dokploy 控制台表单的最小集（真机验证过）：path 固定 /，不开 HTTPS 时证书类型 none
    expect(dokCalls[3].body).toEqual({
      host: 'with-domain.apps.example.com',
      path: '/',
      port: 8080,
      https: false,
      certificateType: 'none',
      applicationId: 'app-created-5',
      domainType: 'application',
    });
    // 列表里也带
    const list = await api('GET', '/api/apps', { token: memberToken });
    expect(list.body.find((a: { slug: string }) => a.slug === 'with-domain')).toMatchObject({ domain: 'with-domain.apps.example.com' });
    expect(list.body.find((a: { slug: string }) => a.slug === 'crm-tool')).toMatchObject({ domain: null, url: null, port: 3000 });
    dokCalls.length = 0;
  });

  it('静态托管的域名固定转发到 80（nginx），应用填的端口不生效；开了 HTTPS 用 Let\'s Encrypt、url 带 https', async () => {
    await api('PUT', '/api/admin/dokploy-settings', { token: adminToken, payload: fullSettings({ domainSuffix: 'apps.example.com', domainHttps: true }) });
    const r = await api('POST', '/api/apps', {
      token: ownerToken,
      payload: { slug: 'static-domain', name: '静态带域名', repoUrl: 'https://git.example.com/s.git', buildType: 'static', port: 9999 },
    });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ port: 9999, domain: 'static-domain.apps.example.com', url: 'https://static-domain.apps.example.com' });
    expect(dokCalls.map((c) => c.op)).toEqual(['create', 'git', 'build', 'domain']);
    expect(dokCalls[3].body).toMatchObject({ host: 'static-domain.apps.example.com', port: 80, https: true, certificateType: 'letsencrypt' });
    dokCalls.length = 0;
  });

  it('slug 当不了域名前缀（以连字符结尾）时在建 Dokploy 应用之前就拒绝；端口越界 400', async () => {
    const trailing = await api('POST', '/api/apps', {
      token: ownerToken,
      payload: { slug: 'trailing-', name: 'x', repoUrl: 'https://git.example.com/t.git', buildType: 'dockerfile' },
    });
    expect(trailing.status).toBe(400);
    expect(trailing.body.message).toContain('域名前缀');
    const port = await api('POST', '/api/apps', {
      token: ownerToken,
      payload: { slug: 'bad-port', name: 'x', repoUrl: 'https://git.example.com/t.git', buildType: 'dockerfile', port: 70000 },
    });
    expect(port.status).toBe(400);
    expect(dokCalls).toHaveLength(0);
  });

  it('绑域名失败时整体回滚：删掉刚建的应用（域名随之级联删），平台里不留记录', async () => {
    failDomainOnce = true;
    const r = await api('POST', '/api/apps', {
      token: ownerToken,
      payload: { slug: 'domain-fail', name: '域名失败', repoUrl: 'https://git.example.com/f.git', buildType: 'dockerfile' },
    });
    expect(r.status).toBe(503);
    expect(r.body.message).toContain('域名');
    expect(dokCalls.map((c) => c.op)).toEqual(['create', 'git', 'build', 'domain', 'delete']);
    expect(dokCalls[4].body).toEqual({ applicationId: 'app-created-7' });
    const list = await api('GET', '/api/apps', { token: ownerToken });
    expect(list.body.map((a: { slug: string }) => a.slug)).not.toContain('domain-fail');
    dokCalls.length = 0;
    // 关掉自动域名：后面的用例不分配
    await api('PUT', '/api/admin/dokploy-settings', { token: adminToken, payload: fullSettings() });
  });

  it('域名转发端口跟着配置走：改 port / 改构建方式会回写 Dokploy 的域名记录；静态托管下改 port 与没域名的应用都不碰', async () => {
    const port = await api('PATCH', '/api/apps/with-domain', { token: ownerToken, payload: { port: 3001 } });
    expect(port.status).toBe(200);
    expect(port.body.port).toBe(3001);
    // domain.update 的 host 是必填（真机验证），整组关键字段带上
    expect(dokCalls.map((c) => c.op)).toEqual(['domainUpdate']);
    expect(dokCalls[0].body).toEqual({ domainId: 'dom-5', host: 'with-domain.apps.example.com', path: '/', port: 3001, https: false, certificateType: 'none' });
    dokCalls.length = 0;

    const toStatic = await api('PATCH', '/api/apps/with-domain', { token: ownerToken, payload: { buildType: 'static' } });
    expect(toStatic.status).toBe(200);
    expect(dokCalls.map((c) => c.op)).toEqual(['build', 'domainUpdate']);
    expect(dokCalls[1].body).toMatchObject({ domainId: 'dom-5', port: 80 });
    dokCalls.length = 0;

    const staticPort = await api('PATCH', '/api/apps/with-domain', { token: ownerToken, payload: { port: 4000 } });
    expect(staticPort.body.port).toBe(4000);
    expect(dokCalls).toHaveLength(0);

    const noDomain = await api('PATCH', '/api/apps/crm-tool', { token: ownerToken, payload: { port: 5000 } });
    expect(noDomain.status).toBe(200);
    expect(noDomain.body).toMatchObject({ port: 5000, domain: null });
    expect(dokCalls).toHaveLength(0);
  });

  it('挂载既有 Dokploy 应用：仅管理员；不碰 Dokploy、构建配置为空、创建即已授权', async () => {
    const asMember = await api('POST', '/api/apps/mount', {
      token: ownerToken,
      payload: { slug: 'legacy', name: '遗留应用', dokployApplicationId: 'app-legacy' },
    });
    expect(asMember.status).toBe(403);
    const r = await api('POST', '/api/apps/mount', {
      token: adminToken,
      payload: { slug: 'legacy', name: '遗留应用', dokployApplicationId: 'app-legacy', repoUrl: 'https://git.example.com/legacy' },
    });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ managed: false, buildType: null, deployApproved: true, dokployApplicationId: 'app-legacy', branch: 'main', domain: null, url: null });
    expect(dokCalls).toHaveLength(0);
  });
});

describe('应用：更新、成员与权限', () => {
  it('平台托管的应用：改分支回写 Git 源、改构建字段回写构建方式、只改名字不碰 Dokploy', async () => {
    const branch = await api('PATCH', '/api/apps/crm-tool', { token: ownerToken, payload: { branch: 'develop' } });
    expect(branch.status).toBe(200);
    expect(branch.body.branch).toBe('develop');
    expect(dokCalls.map((c) => c.op)).toEqual(['git']);
    expect(dokCalls[0].body).toMatchObject({ applicationId: crmAppId, customGitBranch: 'develop', customGitUrl: 'git@git.example.com:team/crm.git', customGitSSHKeyId: 'key-1' });
    dokCalls.length = 0;

    const ctx = await api('PATCH', '/api/apps/crm-tool', { token: ownerToken, payload: { dockerContextPath: '', dockerfile: 'Dockerfile' } });
    expect(ctx.body).toMatchObject({ dockerfile: 'Dockerfile', dockerContextPath: '' });
    expect(dokCalls.map((c) => c.op)).toEqual(['build']);
    expect(dokCalls[0].body).toMatchObject({ applicationId: crmAppId, buildType: 'dockerfile', dockerfile: 'Dockerfile', dockerContextPath: '' });
    dokCalls.length = 0;

    const name = await api('PATCH', '/api/apps/crm-tool', { token: ownerToken, payload: { name: 'CRM 工具', description: '改个名' } });
    expect(name.body.name).toBe('CRM 工具');
    expect(dokCalls).toHaveLength(0);

    // 托管应用与 Dokploy 上的应用一一对应，不能改绑
    const rebind = await api('PATCH', '/api/apps/crm-tool', { token: ownerToken, payload: { dokployApplicationId: 'app-other' } });
    expect(rebind.status).toBe(400);
  });

  it('挂载的应用：构建配置在 Dokploy 侧维护，平台拒改；可改名与 application id', async () => {
    const build = await api('PATCH', '/api/apps/legacy', { token: adminToken, payload: { buildType: 'static' } });
    expect(build.status).toBe(400);
    const ok = await api('PATCH', '/api/apps/legacy', { token: adminToken, payload: { name: '遗留应用 2', dokployApplicationId: 'app-legacy-2' } });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ name: '遗留应用 2', dokployApplicationId: 'app-legacy-2' });
    expect(dokCalls).toHaveLength(0);
  });

  it('成员管理：非 Owner 不能改配置 / 加成员；isMember 与 canDeploy 分开算', async () => {
    expect((await api('PATCH', '/api/apps/crm-tool', { token: memberToken, payload: { name: 'x' } })).status).toBe(403);
    expect((await api('POST', '/api/apps/crm-tool/members', { token: memberToken, payload: { userId: memberId } })).status).toBe(403);
    await api('POST', '/api/apps/crm-tool/members', { token: ownerToken, payload: { userId: memberId } });

    const find = (rows: Array<{ slug: string }>) => rows.find((a) => a.slug === 'crm-tool') as Record<string, unknown>;
    const asMember = find((await api('GET', '/api/apps', { token: memberToken })).body);
    // 成员了，但应用还没被授权部署
    expect(asMember).toMatchObject({ isMember: true, canDeploy: false });
    const asOutsider = find((await api('GET', '/api/apps', { token: outsiderToken })).body);
    expect(asOutsider).toMatchObject({ isMember: false, canDeploy: false });
    const asAdmin = find((await api('GET', '/api/apps', { token: adminToken })).body);
    expect(asAdmin).toMatchObject({ isMember: true, canDeploy: false });
  });
});

describe('部署授权门禁（决策 31）', () => {
  it('未授权的应用：成员部署被拒并留痕，Dokploy 没收到任何调用', async () => {
    const r = await api('POST', '/api/apps/crm-tool/deploy', { token: memberToken, payload: { report: passingReport() } });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('DEPLOY_NOT_APPROVED');
    expect(r.body.message).toContain('管理员');
    expect(deployCalls).toHaveLength(0);
    const info = (await api('GET', '/api/apps', { token: ownerToken })).body.find((a: { slug: string }) => a.slug === 'crm-tool');
    expect(info.approvalRequestedAt).not.toBeNull();
    // 成员资格与报告仍先于授权检查：非成员、坏报告照旧各自的拒绝理由
    expect((await api('POST', '/api/apps/crm-tool/deploy', { token: outsiderToken, payload: { report: passingReport() } })).status).toBe(403);
    expect((await api('POST', '/api/apps/crm-tool/deploy', { token: outsiderToken, payload: { report: passingReport() } })).body.error).toBe('FORBIDDEN');
  });

  it('管理员授权一次即永久有效；可撤销；仅管理员可操作', async () => {
    expect((await api('POST', '/api/apps/crm-tool/approve', { token: ownerToken })).status).toBe(403);
    const ok = await api('POST', '/api/apps/crm-tool/approve', { token: adminToken });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ deployApproved: true, approvedByName: '管理员', approvalRequestedAt: null });
    const asMember = (await api('GET', '/api/apps', { token: memberToken })).body.find((a: { slug: string }) => a.slug === 'crm-tool');
    expect(asMember.canDeploy).toBe(true);

    const revoked = await api('DELETE', '/api/apps/crm-tool/approve', { token: adminToken });
    expect(revoked.body).toMatchObject({ deployApproved: false, approvedByName: null });
    expect((await api('POST', '/api/apps/crm-tool/deploy', { token: memberToken, payload: { report: passingReport() } })).body.error).toBe('DEPLOY_NOT_APPROVED');
    await api('POST', '/api/apps/crm-tool/approve', { token: adminToken });
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
    const noReport = await api('POST', '/api/apps/crm-tool/deploy', { token: memberToken, payload: {} });
    expect(noReport.status).toBe(400);
    expect(noReport.body.message).toContain('检查报告');
    const failing = await api('POST', '/api/apps/crm-tool/deploy', {
      token: memberToken,
      payload: {
        report: { ...passingReport(), passed: false, findings: [{ rule: 'generic', file: 'src/config.ts', line: 3, note: '疑似 AWS Key' }] },
      },
    });
    expect(failing.status).toBe(400);
    expect(failing.body.error).toBe('PRECHECK_FAILED');
    const outsider = await api('POST', '/api/apps/crm-tool/deploy', { token: outsiderToken, payload: { report: passingReport() } });
    expect(outsider.status).toBe(403);
    expect(deployCalls).toHaveLength(0);
  });

  it('触发部署：Dokploy 收到带认领标记的调用，记录先是「排队中」', async () => {
    mockBuilds = [];
    mockQueue = [];
    const r = await api('POST', '/api/apps/crm-tool/deploy', { token: memberToken, payload: { report: passingReport() } });
    expect(r.status).toBe(201);
    // 构建记录要等 Dokploy 的队列执行到才建出来，此刻只可能是排队中
    expect(r.body.status).toBe('queued');
    expect(r.body.deploymentId).toBeNull();
    expect(r.body.origin).toBe('platform');
    expect(r.body.appSlug).toBe('crm-tool');
    expect(r.body.platform.source).toBe('cli');
    metaId = r.body.platform.id;

    expect(deployCalls).toHaveLength(1);
    expect(deployCalls[0].applicationId).toBe(crmAppId);
    // 标记必须原样带给 Dokploy——整条认领链路都挂在它上面（决策 30）
    expect(deployCalls[0].description).toBe(`eat:${metaId}`);
    expect(deployCalls[0].title).toContain('组员');
  });

  it('控制台触发（决策 31）：不带报告但要显式声明 source=console，记录标成未做密钥扫描', async () => {
    const r = await api('POST', '/api/apps/crm-tool/deploy', { token: ownerToken, payload: { source: 'console' } });
    expect(r.status).toBe(201);
    expect(r.body.platform).toMatchObject({ source: 'console', report: null, triggeredByName: '应用主' });
    expect(deployCalls).toHaveLength(2);
    // 控制台触发照样过授权门禁与成员门禁
    expect((await api('POST', '/api/apps/crm-tool/deploy', { token: outsiderToken, payload: { source: 'console' } })).status).toBe(403);
    // 把这条推到时间窗外，别干扰后面按 metaId 的认领用例
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    await pool.query(`update deployment set created_at = now() - interval '5 hours' where id = $1`, [r.body.platform.id]);
    await pool.end();
  });

  it('排队阶段：从 Dokploy 的部署队列里看到自己刚触发的那次，别的应用不串味', async () => {
    mockQueue = [
      { data: { applicationId: crmAppId, titleLog: 'eat · 组员 · crm-tool', descriptionLog: `eat:${metaId}` }, state: 'waiting', timestamp: Date.now() },
      { data: { applicationId: 'app-other', titleLog: '别人的应用', descriptionLog: '' }, state: 'waiting', timestamp: Date.now() },
    ];
    const list = await api('GET', '/api/apps/crm-tool/deployments', { token: memberToken });
    expect(list.body).toHaveLength(1);
    expect(list.body[0].status).toBe('queued');
    expect(list.body[0].platform.id).toBe(metaId);
  });

  it('构建记录出现后靠标记精确认领；同时刻在 Dokploy 侧触发的部署也列出来，且不被张冠李戴', async () => {
    mockQueue = [];
    mockBuilds = [
      // 同一时刻还有一次在 Dokploy 控制台点的部署：按时间猜的老做法正是在这里认错人
      { deploymentId: 'build-console', title: 'Manual deployment', description: '', status: 'running', createdAt: iso() },
      { deploymentId: 'build-mine', title: 'eat · 组员 · crm-tool', description: `eat:${metaId}`, status: 'running', createdAt: iso() },
    ];
    const list = await api('GET', '/api/apps/crm-tool/deployments', { token: memberToken });
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
    const list = await api('GET', '/api/apps/crm-tool/deployments', { token: ownerToken });
    expect(list.body.map((d: Record<string, never>) => d.status).sort()).toEqual(['cancelled', 'done']);
  });

  it('最近一次部署：Dokploy 构建 id 与平台元数据 id 都能查，都支持前 8 位；没部署过回 404', async () => {
    const latest = await api('GET', '/api/apps/crm-tool/deployments/latest', { token: memberToken });
    expect(latest.status).toBe(200);
    expect(latest.body.platform.id).toBe(metaId);

    expect((await api('GET', '/api/apps/crm-tool/deployments/build-mine', { token: memberToken })).body.deploymentId).toBe('build-mine');
    expect((await api('GET', `/api/apps/crm-tool/deployments/${metaId}`, { token: memberToken })).body.deploymentId).toBe('build-mine');
    expect((await api('GET', `/api/apps/crm-tool/deployments/${metaId.slice(0, 8)}`, { token: memberToken })).body.deploymentId).toBe('build-mine');

    const none = await api('GET', '/api/apps/docs-site/deployments/latest', { token: memberToken });
    expect(none.status).toBe(404);
    expect(none.body.message).toContain('eat deploy docs-site');
  });

  it('查单条的边界：过短 400、无匹配 404、命中多条 409', async () => {
    const tooShort = await api('GET', `/api/apps/crm-tool/deployments/${metaId.slice(0, 6)}`, { token: memberToken });
    expect(tooShort.status).toBe(400);
    expect(tooShort.body.error).toBe('VALIDATION_FAILED');
    expect((await api('GET', '/api/apps/crm-tool/deployments/zzzzzzzz', { token: memberToken })).status).toBe(404);

    // UUID 随机，构造不出天然碰撞，这里插一条与 metaId 同前缀的元数据
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const twin = `${metaId.slice(0, 8)}-dead-4bee-8000-000000000001`;
    const src = (await pool.query('select app_id, triggered_by from deployment where id = $1', [metaId])).rows[0];
    await pool.query('insert into deployment (id, app_id, triggered_by) values ($1, $2, $3)', [twin, src.app_id, src.triggered_by]);
    const dup = await api('GET', `/api/apps/crm-tool/deployments/${metaId.slice(0, 8)}`, { token: memberToken });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toBe('AMBIGUOUS_ID');
    await pool.query('delete from deployment where id = $1', [twin]);
    await pool.end();
  });

  it('构建失败：error 带上构建日志末尾的真实报错，但日志只给应用成员看（决策 28）', async () => {
    mockBuilds = [
      { deploymentId: 'build-mine', title: 'eat · 组员 · crm-tool', description: `eat:${metaId}`, status: 'error', errorMessage: 'boom', createdAt: iso() },
    ];
    mockBuildLogs = 'Initializing deployment\nnpm ERR! code E404\nnpm ERR! 404 Not Found - GET https://registry/foo\n\n❌ 构建失败\n';
    const asMember = await api('GET', '/api/apps/crm-tool/deployments/latest', { token: memberToken });
    expect(asMember.body.status).toBe('error');
    // 不再是「详见 Dokploy 控制台」那种打发人的文案
    expect(asMember.body.error).toContain('npm ERR! 404 Not Found');
    expect(asMember.body.error).toContain('eat app build-logs crm-tool');

    // 日志可能带出构建期注入的密钥：非成员只看得到 Dokploy 记录上那句 errorMessage
    const asOutsider = await api('GET', '/api/apps/crm-tool/deployments/latest', { token: outsiderToken });
    expect(asOutsider.body.status).toBe('error');
    expect(asOutsider.body.error).toBe('boom');
  });

  it('老版本 Dokploy 丢掉标记时，回落到按时间推断认领，并标注 inferred', async () => {
    // 把已有元数据推老，让它们落在推断时间窗之外，避免旧记录来抢这条构建
    await ageAllDeployments('2 hours');
    mockBuilds = [];
    mockQueue = [];
    const r = await api('POST', '/api/apps/crm-tool/deploy', { token: ownerToken, payload: { report: passingReport() } });
    // 老版本 Dokploy（< v0.25.0）不认 title/description，建出来的记录没有标记
    mockBuilds = [{ deploymentId: 'build-untagged', title: 'Manual deployment', description: '', status: 'done', createdAt: iso(1000) }];

    const one = await api('GET', `/api/apps/crm-tool/deployments/${r.body.platform.id}`, { token: ownerToken });
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
    const fresh = await api('POST', '/api/apps/crm-tool/deploy', { token: ownerToken, payload: { report: passingReport() } });
    mockBuilds = [
      { deploymentId: 'build-fresh', title: 'eat · 应用主 · crm-tool', description: `eat:${fresh.body.platform.id}`, status: 'done', createdAt: iso() },
    ];
    // 先查一次让它完成认领（dokploy_deployment_id 回写），再模拟 Dokploy 的清理
    await api('GET', '/api/apps/crm-tool/deployments', { token: memberToken });
    // Dokploy 每个应用只留最近 10 条，更早的构建记录连日志一起被删掉
    mockBuilds = [];

    const def = await api('GET', '/api/apps/crm-tool/deployments', { token: memberToken });
    expect(def.body).toHaveLength(0);

    const all = await api('GET', '/api/apps/crm-tool/deployments?all=1', { token: memberToken });
    expect(all.body.length).toBeGreaterThan(0);
    expect(all.body.every((d: Record<string, never>) => d.status === 'archived')).toBe(true);
    // 「谁触发的、带了什么扫描报告」是平台的合规记录，不能跟着 Dokploy 的清理一起消失
    const mine = all.body.find((d: { platform: { id: string } }) => d.platform.id === metaId);
    expect(mine.platform.triggeredByName).toBe('组员');
    expect(mine.platform.report.passed).toBe(true);
    expect(mine.deploymentId).toBe('build-mine');
    // 控制台触发的那次也在，标着 console、没有报告
    const console = all.body.find((d: { platform: { source: string } }) => d.platform.source === 'console');
    expect(console.platform.report).toBeNull();
    // 「最近一次部署」此时要说清是被清理了，而不是「还没部署过」——后者会误导人再部署一次
    const latest = await api('GET', '/api/apps/crm-tool/deployments/latest', { token: memberToken });
    expect(latest.status).toBe(404);
    expect(latest.body.message).toContain('--all');

    // 刚认领完就被清理的那条也归档，而不是退回排队中
    const justCleaned = all.body.find((d: { platform: { id: string } }) => d.platform.id === fresh.body.platform.id);
    expect(justCleaned.status).toBe('archived');
    expect(justCleaned.deploymentId).toBe('build-fresh');
  });

  it('认领过的元数据不再去认领别人的构建：Dokploy 侧的部署不会被冒认成平台部署', async () => {
    // 承上：Dokploy 的构建记录已被清空，平台元数据全是「认领过、构建记录已没了」的状态。
    // 此时有人在 Dokploy 侧点了一次部署——按时间推断的老做法会让上面那条元数据把它认走
    mockBuilds = [{ deploymentId: 'build-console-late', title: 'Manual deployment', description: '', status: 'done', createdAt: iso() }];
    const list = await api('GET', '/api/apps/crm-tool/deployments', { token: memberToken });
    const row = list.body.find((d: Record<string, never>) => d.deploymentId === 'build-console-late');
    expect(row.origin).toBe('dokploy');
    expect(row.platform).toBeNull();
  });
});

describe('应用 env 的拉取与推送（决策 31）', () => {
  it('拉取：运行时与构建时两块原样带回；值可能是密钥，非成员 403', async () => {
    mockEnv = 'PORT=3000\nDATABASE_URL=postgres://x\n';
    mockBuildArgs = 'NODE_VERSION=20\n';
    const r = await api('GET', '/api/apps/crm-tool/env', { token: memberToken });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ appSlug: 'crm-tool', runtime: mockEnv, build: mockBuildArgs });
    expect((await api('GET', '/api/apps/crm-tool/env', { token: outsiderToken })).status).toBe(403);
  });

  it('推送运行时：整体覆盖 env，buildArgs / buildSecrets / createEnvFile 原样回写；只回 key 级差异', async () => {
    dokCalls.length = 0;
    const r = await api('PUT', '/api/apps/crm-tool/env', {
      token: memberToken,
      payload: { target: 'runtime', content: 'PORT=8080\nREDIS_URL="redis://r"\n# 注释\nexport FEATURE_X=1\n' },
    });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ appSlug: 'crm-tool', target: 'runtime', added: ['FEATURE_X', 'REDIS_URL'], removed: ['DATABASE_URL'], changed: ['PORT'], unchanged: 0 });
    expect(JSON.stringify(r.body)).not.toContain('redis://r');
    expect(dokCalls.map((c) => c.op)).toEqual(['env']);
    expect(dokCalls[0].body).toEqual({
      applicationId: crmAppId,
      env: 'PORT=8080\nREDIS_URL="redis://r"\n# 注释\nexport FEATURE_X=1\n',
      buildArgs: 'NODE_VERSION=20\n',
      buildSecrets: 'S=1',
      createEnvFile: false,
    });
  });

  it('推送构建时：只动 buildArgs', async () => {
    dokCalls.length = 0;
    const r = await api('PUT', '/api/apps/crm-tool/env', { token: ownerToken, payload: { target: 'build', content: 'NODE_VERSION=22\nNPM_TOKEN=abc\n' } });
    expect(r.body).toMatchObject({ target: 'build', added: ['NPM_TOKEN'], removed: [], changed: ['NODE_VERSION'], unchanged: 0 });
    expect(dokCalls[0].body).toMatchObject({ env: 'PORT=8080\nREDIS_URL="redis://r"\n# 注释\nexport FEATURE_X=1\n', buildArgs: 'NODE_VERSION=22\nNPM_TOKEN=abc\n' });
    expect((await api('PUT', '/api/apps/crm-tool/env', { token: outsiderToken, payload: { target: 'build', content: '' } })).status).toBe(403);
    expect((await api('PUT', '/api/apps/crm-tool/env', { token: ownerToken, payload: { target: 'nope', content: '' } })).status).toBe(400);
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
    const r = await api('GET', '/api/apps/crm-tool/build-logs?tail=50', { token: memberToken });
    expect(r.status).toBe(200);
    expect(r.body.appSlug).toBe('crm-tool');
    expect(r.body.deployment.deploymentId).toBe('build-2');
    expect(r.body.logs).toContain('Build finished');
    expect(r.body.recent).toHaveLength(2);
    expect(logCalls.at(-1)).toEqual({ kind: 'build', deploymentId: 'build-2', tail: '50' });
  });

  it('构建日志：可回看指定那次，指定不存在的构建回 404', async () => {
    const r = await api('GET', '/api/apps/crm-tool/build-logs?deploymentId=build-1', { token: memberToken });
    expect(r.body.deployment.deploymentId).toBe('build-1');
    expect(logCalls.at(-1)?.tail).toBe('200');
    expect((await api('GET', '/api/apps/crm-tool/build-logs?deploymentId=nope', { token: memberToken })).status).toBe(404);
  });

  it('运行日志：默认取运行中的容器，行尾 \\r\\n 归一', async () => {
    const r = await api('GET', '/api/apps/crm-tool/run-logs?tail=20', { token: memberToken });
    expect(r.status).toBe(200);
    expect(r.body.container.containerId).toBe('c-running');
    expect(r.body.containers).toHaveLength(2);
    expect(r.body.logs).toBe('2026-09-02T07:01:00Z listening on :3000\n');
    expect(logCalls.at(-1)).toEqual({ kind: 'run', containerId: 'c-running', tail: '20' });
  });

  it('运行日志：没有容器时不报错，回 container=null（应用可能还没部署成功）', async () => {
    mockContainers = [];
    const r = await api('GET', '/api/apps/crm-tool/run-logs', { token: memberToken });
    expect(r.status).toBe(200);
    expect(r.body.container).toBeNull();
    expect(r.body.logs).toBe('');
  });

  it('日志可能带出构建期注入的密钥：非应用成员一律 403', async () => {
    expect((await api('GET', '/api/apps/crm-tool/build-logs', { token: outsiderToken })).status).toBe(403);
    expect((await api('GET', '/api/apps/crm-tool/run-logs', { token: outsiderToken })).status).toBe(403);
    expect((await api('GET', '/api/apps/crm-tool/build-logs')).status).toBe(401);
  });

  it('tail 超出范围按 VALIDATION_FAILED 拒绝，不透传给 Dokploy', async () => {
    const r = await api('GET', '/api/apps/crm-tool/build-logs?tail=99999', { token: memberToken });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('VALIDATION_FAILED');
  });
});

describe('删除应用（决策 31）', () => {
  it('平台托管的应用连 Dokploy 上的一起删；Dokploy 删不掉时不动平台记录', async () => {
    dokCalls.length = 0;
    failDelete = true;
    const blocked = await api('DELETE', '/api/apps/docs-site', { token: memberToken });
    expect(blocked.status).toBe(503);
    expect((await api('GET', '/api/apps', { token: memberToken })).body.map((a: { slug: string }) => a.slug)).toContain('docs-site');
    failDelete = false;

    expect((await api('DELETE', '/api/apps/docs-site', { token: outsiderToken })).status).toBe(403);
    const ok = await api('DELETE', '/api/apps/docs-site', { token: memberToken });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ ok: true, dokployDeleted: true });
    expect(dokCalls.map((c) => c.op)).toEqual(['delete', 'delete']);
    expect(dokCalls[1].body).toEqual({ applicationId: 'app-created-2' });
    expect((await api('GET', '/api/apps', { token: memberToken })).body.map((a: { slug: string }) => a.slug)).not.toContain('docs-site');
  });

  it('挂载的应用只解绑，不碰 Dokploy', async () => {
    dokCalls.length = 0;
    const ok = await api('DELETE', '/api/apps/legacy', { token: adminToken });
    expect(ok.body).toEqual({ ok: true, dokployDeleted: false });
    expect(dokCalls).toHaveLength(0);
  });
});

describe('密钥指纹清单', () => {
  it('长值有指纹、短值排除、受限变量不泄露名称', async () => {
    await api('POST', '/api/envs', { token: adminToken, payload: { slug: 'fp-env', name: '指纹测试', description: '' } });
    await api('POST', '/api/envs/fp-env/variables', { token: adminToken, payload: { key: 'LONG_TOKEN', value: 'super-secret-token-value-123', description: '' } });
    await api('POST', '/api/envs/fp-env/variables', { token: adminToken, payload: { key: 'SHORT', value: 'abc', description: '' } });
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
