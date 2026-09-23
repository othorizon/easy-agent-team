/**
 * 平台自身能力的 MCP 端点（决策 55）端到端测试。
 *
 * 覆盖三件事：请求头里的 API Key 鉴权、Streamable HTTP 的协议行为、工具确实接到了业务服务上。
 * 最后一组用**官方 MCP SDK 的客户端**真连一次（平台真 listen，不走 inject）——
 * 「标准的 HTTP MCP」这句话只有让参考实现连上才算数。
 */
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://dev@127.0.0.1:5433/eat_test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
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
let platformUrl: string;
let adminToken: string;
let memberToken: string;
/** 成员生成的 API Key（明文，只在创建响应里出现一次） */
let apiKey: string;
let apiKeyId: string;

async function api(
  method: 'GET' | 'POST' | 'DELETE',
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

/** 以 MCP 客户端的身份打端点；headers 里怎么带 Key 由用例自己决定 */
async function mcp(payload: unknown, opts: { headers?: Record<string, string>; method?: 'POST' | 'GET' | 'DELETE' | 'OPTIONS' } = {}) {
  const res = await app.inject({
    method: opts.method ?? 'POST',
    url: '/mcp',
    payload: payload as never,
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(opts.headers ?? {}),
    },
  });
  // 用例里按 JSON-RPC 的形状取字段，和其他 spec 一样不为响应体单独建类型
  let body: any;
  try {
    body = res.body ? JSON.parse(res.body) : undefined;
  } catch {
    body = res.body; // SSE 等非 JSON 响应原样给用例断言
  }
  return { status: res.statusCode, headers: res.headers, body, raw: res.body };
}

/** 带 Key 的一次 JSON-RPC 调用 */
function rpc(method: string, params?: unknown, id: number | string = 1) {
  return mcp({ jsonrpc: '2.0', id, method, params }, { headers: { authorization: `Bearer ${apiKey}` } });
}

/** tools/call 的结果解回 JSON（工具统一以 text 内容块回结构化 JSON） */
function toolJson(body: { result: { content: Array<{ text: string }>; isError?: boolean } }): any {
  return JSON.parse(body.result.content[0].text);
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

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  await app.listen({ port: 0, host: '127.0.0.1' });
  platformUrl = await app.getUrl();

  adminToken = (await api('POST', '/api/auth/login', { payload: { email: 'admin@test.dev', password: 'password123' } }))
    .body.token;
  memberToken = (
    await api('POST', '/api/auth/login', { payload: { email: 'member@test.dev', password: 'password123' } })
  ).body.token;

  // 管理员建一个环境 + 一个敏感变量：成员无权限，正好用来验证工具里的权限提示
  await api('POST', '/api/envs', { token: adminToken, payload: { slug: 'prod', name: '生产环境' } });
  await api('POST', '/api/envs/prod/variables', {
    token: adminToken,
    payload: { key: 'DB_PASSWORD', value: 'super-secret-value', secret: true, note: '生产库密码' },
  });

  const created = await api('POST', '/api/auth/api-keys', {
    token: memberToken,
    payload: { name: '云端 AI 服务' },
  });
  apiKey = created.body.token;
  apiKeyId = created.body.id;
});

afterAll(async () => {
  await app?.close();
});

describe('API Key', () => {
  it('创建时返回明文，之后清单里只有元信息', async () => {
    expect(apiKey).toMatch(/^eat_/);
    const list = await api('GET', '/api/auth/tokens', { token: memberToken });
    const row = list.body.find((t: { id: string }) => t.id === apiKeyId);
    expect(row.kind).toBe('apikey');
    expect(JSON.stringify(row)).not.toContain(apiKey);
  });

  it('缺少 Key 返回 401 并带 WWW-Authenticate', async () => {
    const r = await mcp({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(r.status).toBe(401);
    expect(r.headers['www-authenticate']).toContain('Bearer');
    expect(r.body.error).toBe('UNAUTHORIZED');
  });

  it('伪造的 Key 返回 401', async () => {
    const r = await mcp({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { headers: { authorization: 'Bearer eat_nope' } });
    expect(r.status).toBe(401);
  });

  it('Authorization: Bearer 与 X-API-Key 两种写法都认', async () => {
    const bearer = await rpc('ping');
    expect(bearer.status).toBe(200);
    const xkey = await mcp({ jsonrpc: '2.0', id: 1, method: 'ping' }, { headers: { 'x-api-key': apiKey } });
    expect(xkey.body.result).toEqual({});
  });

  it('网页会话的 Token 同样能用（同一套鉴权）', async () => {
    const r = await mcp({ jsonrpc: '2.0', id: 1, method: 'ping' }, { headers: { authorization: `Bearer ${memberToken}` } });
    expect(r.status).toBe(200);
  });
});

describe('Streamable HTTP 协议', () => {
  it('initialize 回协商后的版本、能力与 instructions', async () => {
    const r = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    expect(r.status).toBe(200);
    expect(r.body.result.protocolVersion).toBe('2025-06-18');
    expect(r.body.result.capabilities.tools).toBeTruthy();
    expect(r.body.result.serverInfo.name).toBe('easy-agent-team');
    expect(r.body.result.instructions).toContain('get_platform_guide');
  });

  it('客户端报旧版本就回旧版本，报不认识的版本回最新', async () => {
    expect((await rpc('initialize', { protocolVersion: '2024-11-05' })).body.result.protocolVersion).toBe('2024-11-05');
    expect((await rpc('initialize', { protocolVersion: '1999-01-01' })).body.result.protocolVersion).toBe('2025-06-18');
  });

  it('通知不回响应，只回 202', async () => {
    const r = await mcp(
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { headers: { authorization: `Bearer ${apiKey}` } },
    );
    expect(r.status).toBe(202);
    expect(r.raw).toBe('');
  });

  it('批量请求回批量响应', async () => {
    const r = await mcp(
      [
        { jsonrpc: '2.0', id: 1, method: 'ping' },
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      ],
      { headers: { authorization: `Bearer ${apiKey}` } },
    );
    expect(Array.isArray(r.body)).toBe(true);
    expect(r.body).toHaveLength(2);
  });

  it('只接受 SSE 的客户端拿到 SSE 事件', async () => {
    const r = await mcp(
      { jsonrpc: '2.0', id: 9, method: 'ping' },
      { headers: { authorization: `Bearer ${apiKey}`, accept: 'text/event-stream' } },
    );
    expect(r.headers['content-type']).toContain('text/event-stream');
    expect(r.raw).toContain('event: message');
    expect(r.raw).toContain('"id":9');
  });

  it('不支持的方法回 -32601，不是 HTTP 错误', async () => {
    const r = await rpc('resources/list');
    expect(r.status).toBe(200);
    expect(r.body.error.code).toBe(-32601);
  });

  it('GET 回 405（本端点没有服务端推送流），DELETE 回 204，OPTIONS 回 CORS 头', async () => {
    const get = await mcp(undefined, { method: 'GET', headers: { authorization: `Bearer ${apiKey}` } });
    expect(get.status).toBe(405);
    expect(get.headers.allow).toContain('POST');

    const del = await mcp(undefined, { method: 'DELETE', headers: { authorization: `Bearer ${apiKey}` } });
    expect(del.status).toBe(204);

    const options = await mcp(undefined, { method: 'OPTIONS' });
    expect(options.status).toBe(204);
    expect(options.headers['access-control-allow-origin']).toBe('*');
  });
});

describe('工具', () => {
  it('tools/list 给出全部工具，且只有远程接入才有 get_platform_guide', async () => {
    const names = (await rpc('tools/list')).body.result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain('get_platform_guide');
    expect(names).toContain('list_env_variables');
    expect(names).toContain('trigger_deploy');
    expect(new Set(names).size).toBe(names.length);
    // 部署工具只收 app：构建源是应用绑定的 Git 仓库，与调用方本地的代码无关（决策 64 起两种接入一致）
    const trigger = (await rpc('tools/list')).body.result.tools.find((t: { name: string }) => t.name === 'trigger_deploy');
    expect(trigger.inputSchema.required).toEqual(['app']);
    expect(Object.keys(trigger.inputSchema.properties)).toEqual(['app']);
    expect(trigger.description).not.toContain('扫描');
  });

  it('get_platform_guide 返回内置指南正文', async () => {
    const r = await rpc('tools/call', { name: 'get_platform_guide', arguments: {} });
    const data = toolJson(r.body);
    expect(data.slug).toBe('eat-platform-guide');
    expect(data.content).toContain('easy-agent-team');
  });

  it('list_env_variables 走的是调用者自己的权限', async () => {
    const r = await rpc('tools/call', { name: 'list_env_variables', arguments: {} });
    const catalog = toolJson(r.body);
    expect(catalog[0].environment.slug).toBe('prod');
    const variable = catalog[0].variables.find((v: { key: string }) => v.key === 'DB_PASSWORD');
    expect(variable.hasAccess).toBe(false);
    expect(JSON.stringify(catalog)).not.toContain('super-secret-value');
  });

  it('无权限读取时回 PERMISSION_REQUIRED，AI 据此走申请流程', async () => {
    const r = await rpc('tools/call', { name: 'get_env_values', arguments: { environment: 'prod', keys: ['DB_PASSWORD'] } });
    const data = toolJson(r.body);
    expect(data.denied[0].error).toBe('PERMISSION_REQUIRED');
    expect(data.values).toEqual({});
  });

  it('申请权限 → 管理员批准 → 再取值就拿得到（整条链路都在 MCP 里走通）', async () => {
    const created = toolJson(
      (await rpc('tools/call', {
        name: 'request_access',
        arguments: { environment: 'prod', keys: ['DB_PASSWORD'], reason: '排查线上对账问题' },
      })).body,
    );
    expect(created.status).toBe('pending');

    const decided = await api('POST', `/api/access-requests/${created.id}/decision`, {
      token: adminToken,
      payload: { decision: 'approved' },
    });
    expect(decided.status).toBe(201);

    const values = toolJson((await rpc('tools/call', { name: 'get_env_values', arguments: { environment: 'prod' } })).body);
    expect(values.values.DB_PASSWORD).toBe('super-secret-value');

    const status = toolJson((await rpc('tools/call', { name: 'get_access_request_status', arguments: { requestId: created.id } })).body);
    expect(status.status).toBe('approved');
  });

  it('数据库：列实例 → 按名字申请 → 清单里看到 pending（决策 57）', async () => {
    const instance = await api('POST', '/api/db/instances', {
      token: adminToken,
      payload: {
        name: '业务 PostgreSQL',
        engine: 'postgres',
        host: '127.0.0.1',
        port: 5433,
        adminUser: 'dev',
        adminPassword: '',
        note: '',
      },
    });
    expect(instance.status).toBe(201);

    const instances = toolJson((await rpc('tools/call', { name: 'list_db_instances', arguments: {} })).body);
    expect(instances.map((i: { name: string }) => i.name)).toContain('业务 PostgreSQL');
    // 实例的管理凭证不能随清单下发
    expect(JSON.stringify(instances)).not.toContain('adminPassword');

    // 用**名字**而不是 uuid 申请：AI 手上拿到的就是刚读回来的名字（resolveDbInstance）
    const created = toolJson(
      (await rpc('tools/call', {
        name: 'request_db',
        arguments: { instance: '业务 PostgreSQL', dbName: 'usage_anomaly', purpose: '存用量异常跑批结果' },
      })).body,
    );
    expect(created.status).toBe('pending');
    expect(created.dbName).toBe('usage_anomaly');

    const mine = toolJson((await rpc('tools/call', { name: 'list_db_assignments', arguments: {} })).body);
    expect(mine.find((a: { dbName: string }) => a.dbName === 'usage_anomaly').status).toBe('pending');
  });

  it('实例名打错时把候选清单一起回过去，省掉一轮往返', async () => {
    const r = await rpc('tools/call', {
      name: 'request_db',
      arguments: { instance: '不存在的实例', dbName: 'whatever_db', purpose: '随便' },
    });
    expect(r.body.result.isError).toBe(true);
    const err = toolJson(r.body);
    expect(err.error).toBe('DB_INSTANCE_NOT_FOUND');
    expect(err.instances.map((i: { name: string }) => i.name)).toContain('业务 PostgreSQL');
  });

  it('敏感读取记进审计，且认得出是哪把 Key 干的', async () => {
    const audits = await api('GET', '/api/audit?action=secret.read', { token: adminToken });
    const row = audits.body.find((a: { actorTokenId: string | null }) => a.actorTokenId === apiKeyId);
    expect(row).toBeTruthy();
  });

  it('参数不合法回结构化错误而不是 500', async () => {
    const r = await rpc('tools/call', { name: 'get_env_values', arguments: {} });
    expect(r.body.result.isError).toBe(true);
    expect(toolJson(r.body).error).toBe('VALIDATION_FAILED');
  });

  it('未知工具回 isError 而不是协议错误', async () => {
    const r = await rpc('tools/call', { name: 'rm_rf_everything', arguments: {} });
    expect(r.body.result.isError).toBe(true);
    expect(toolJson(r.body).message).toContain('未知工具');
  });

  it('工具里的权限判定与 REST 一致：非成员读不到别人的应用日志', async () => {
    const r = await rpc('tools/call', { name: 'get_build_logs', arguments: { app: 'not-exists' } });
    expect(r.body.result.isError).toBe(true);
    expect(toolJson(r.body).error).toBe('NOT_FOUND');
  });
});

describe('官方 MCP SDK 客户端', () => {
  it('能连上、列工具、调工具、正常关闭', async () => {
    const transport = new StreamableHTTPClientTransport(new URL(`${platformUrl}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${apiKey}` } },
    });
    const client = new Client({ name: 'e2e-probe', version: '1.0.0' });
    await client.connect(transport);

    expect(client.getServerVersion()?.name).toBe('easy-agent-team');
    expect(client.getInstructions()).toContain('easy-agent-team');
    const tools = await client.listTools();
    expect(tools.tools.length).toBeGreaterThan(10);

    const result = (await client.callTool({ name: 'list_helpers', arguments: {} })) as {
      content: Array<{ text: string }>;
    };
    expect(JSON.parse(result.content[0].text)).toHaveProperty('helpers');

    await client.close();
  });

  it('Key 被吊销后立即连不上（鉴权每次请求实时判定）', async () => {
    const created = await api('POST', '/api/auth/api-keys', { token: memberToken, payload: { name: '临时 Key' } });
    const tempKey = created.body.token;
    const before = await mcp({ jsonrpc: '2.0', id: 1, method: 'ping' }, { headers: { authorization: `Bearer ${tempKey}` } });
    expect(before.status).toBe(200);

    await api('DELETE', `/api/auth/tokens/${created.body.id}`, { token: memberToken });
    const after = await mcp({ jsonrpc: '2.0', id: 1, method: 'ping' }, { headers: { authorization: `Bearer ${tempKey}` } });
    expect(after.status).toBe(401);
  });
});
