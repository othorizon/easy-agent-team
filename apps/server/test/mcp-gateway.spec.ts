/**
 * MCP 网关端到端测试（决策 51）。
 *
 * 用一台真的 node:http 假上游 + 平台自己真的 listen，不用 app.inject——
 * 网关的关键行为（hijack 后写 raw、SSE 逐块透传、响应头白名单）在 inject 的模拟响应上验不出来。
 */
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://dev@127.0.0.1:5433/eat_test';
// 假上游跑在 127.0.0.1 上，默认的私网拦截会直接把它挡掉
process.env.EAT_MCP_GATEWAY_ALLOW_PRIVATE = '1';

import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcryptjs';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as path from 'node:path';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { loadConfig } from '../src/config';
import * as schema from '../src/db/schema';
import { assertSafeUpstream, isPrivateAddress } from '../src/mcp-gateway/upstream';

let app: NestFastifyApplication;
let platformUrl: string;
let adminToken: string;
let memberToken: string;
let outsiderToken: string;
let memberId: string;

let upstream: http.Server;
let upstreamUrl: string;

/** 假上游的行为开关：每个用例按需切 */
const upstreamMode = {
  kind: 'json' as 'json' | 'slow-json' | 'sse' | 'legacy-sse' | 'unauthorized' | 'redirect',
  /** slow-json 下等多久才回，用来模拟跑几十秒的 tools/call */
  delayMs: 0,
};
/** 最近一次上游收到的请求头，用来断言凭证注入与头部过滤 */
let lastUpstreamHeaders: http.IncomingHttpHeaders = {};

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

/** 以 MCP 客户端的身份打网关（真 HTTP，不走 inject） */
async function callGateway(url: string, body: unknown = { jsonrpc: '2.0', id: 1, method: 'tools/list' }) {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify(body),
  });
}

function startUpstream(): Promise<void> {
  upstream = http.createServer((req, res) => {
    lastUpstreamHeaders = req.headers;
    // 网关超时后会把连接断掉，这边迟到的写入会报错——没人听就会掀掉测试进程
    res.on('error', () => undefined);
    const finish = () => {
      if (upstreamMode.kind === 'unauthorized') {
        res.writeHead(401, {
          'content-type': 'application/json',
          // 这一条正是必须被网关挡掉的：它会把上游的身份端点暴露出去
          'www-authenticate': 'Bearer resource_metadata="https://upstream.internal/.well-known/oauth"',
        });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      if (upstreamMode.kind === 'redirect') {
        res.writeHead(302, { location: 'https://real-upstream.internal/mcp' });
        res.end();
        return;
      }
      if (upstreamMode.kind === 'legacy-sse') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('event: endpoint\ndata: /messages?sessionId=abc123\n\n');
        return; // 故意挂着，等网关断开
      }
      if (upstreamMode.kind === 'slow-json') {
        const timer = setTimeout(() => {
          if (res.destroyed) return;
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true, slow: true } }));
        }, upstreamMode.delayMs);
        res.on('close', () => clearTimeout(timer));
        return;
      }
      if (upstreamMode.kind === 'sse') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'mcp-session-id': 'sess-1' });
        res.write('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"tools":[]}}\n\n');
        res.write('event: message\ndata: {"jsonrpc":"2.0","method":"notifications/ping"}\n\n');
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'sess-1', 'set-cookie': 'a=b' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } }));
    };
    req.on('data', () => undefined);
    req.on('end', finish);
  });
  return new Promise((resolve) => upstream.listen(0, '127.0.0.1', () => resolve()));
}

beforeAll(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await pool.query('drop schema public cascade; create schema public; drop schema if exists drizzle cascade;');
  await migrate(drizzle(pool), { migrationsFolder: path.resolve(process.cwd(), 'drizzle') });
  const db = drizzle(pool, { schema });
  const hash = await bcrypt.hash('password123', 4);
  await db.insert(schema.users).values([
    { name: '管理员', email: 'admin@test.dev', role: 'admin', passwordHash: hash },
    { name: '成员', email: 'member@test.dev', role: 'member', passwordHash: hash },
    { name: '路人', email: 'outsider@test.dev', role: 'member', passwordHash: hash },
  ]);
  await pool.end();

  await startUpstream();
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/mcp`;

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  await app.listen(0, '127.0.0.1');
  platformUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  // 网关地址是拿 publicUrl 拼的，指到刚起的这台上，下发的 URL 才能直接用
  process.env.EAT_PUBLIC_URL = platformUrl;

  const login = async (email: string) =>
    (await api('POST', '/api/auth/login', { payload: { email, password: 'password123' } })).body.token;
  adminToken = await login('admin@test.dev');
  memberToken = await login('member@test.dev');
  outsiderToken = await login('outsider@test.dev');
  memberId = (await api('GET', '/api/auth/whoami', { token: memberToken })).body.id;

  // 上游凭证放在环境变量里，配置按 ${env:...} 引用——网关要在服务端把它解出来
  await api('POST', '/api/envs', {
    token: adminToken,
    payload: { slug: 'mcp-upstream', name: 'MCP 上游凭证', description: '' },
  });
  await api('POST', '/api/envs/mcp-upstream/variables', {
    token: adminToken,
    payload: { key: 'UPSTREAM_TOKEN', value: 'super-secret-upstream-token', secret: true, visibleWithoutPermission: false },
  });
}, 60_000);

afterAll(async () => {
  await app?.close();
  await new Promise<void>((resolve) => upstream?.close(() => resolve()));
});

/** 建一个走网关的 http 配置，并让成员拿到有效订阅，返回成员的专属地址 */
async function setupSubscribedConfig(slug: string, url = upstreamUrl): Promise<string> {
  await api('POST', '/api/mcp-configs', {
    token: adminToken,
    payload: {
      slug,
      name: `测试服务 ${slug}`,
      transport: 'http',
      url,
      headers: { Authorization: 'Bearer ${env:mcp-upstream/UPSTREAM_TOKEN}' },
      visibility: 'team',
    },
  });
  await api('POST', `/api/mcp-configs/${slug}/subscribe`, { token: memberToken, payload: { reason: '测试' } });
  const requests = (await api('GET', '/api/mcp-configs/subscription-requests', { token: adminToken })).body;
  const req = requests.find((r: { configSlug: string }) => r.configSlug === slug);
  await api('POST', `/api/mcp-configs/subscription-requests/${req.id}/decision`, {
    token: adminToken,
    payload: { decision: 'approved' },
  });
  const configs = (await api('GET', '/api/mcp-configs', { token: memberToken })).body;
  return configs.find((c: { slug: string }) => c.slug === slug).gatewayUrl;
}

describe('MCP 网关：分发与鉴权', () => {
  it('订阅批准后拿到专属地址，且上游信息不下发给成员', async () => {
    const url = await setupSubscribedConfig('svc-basic');
    expect(url).toMatch(new RegExp(`^${platformUrl}/mcp/svc-basic/eatg_[0-9a-f]{48}$`));

    const asMember = (await api('GET', '/api/mcp-configs', { token: memberToken })).body.find(
      (c: { slug: string }) => c.slug === 'svc-basic',
    );
    expect(asMember.url).toBeNull();
    expect(asMember.headers).toEqual({});
    expect(asMember.gatewayEnabled).toBe(true);

    // Owner（这里是管理员）仍然看得到上游，否则没法维护
    const asAdmin = (await api('GET', '/api/mcp-configs', { token: adminToken })).body.find(
      (c: { slug: string }) => c.slug === 'svc-basic',
    );
    expect(asAdmin.url).toBe(upstreamUrl);
    expect(asAdmin.headers.Authorization).toContain('${env:');
  });

  it('sync-bundle 对网关配置只给 URL，不含上游地址与占位符', async () => {
    const bundle = (await api('GET', '/api/mcp-configs/sync-bundle', { token: memberToken })).body;
    const entry = bundle.find((e: { slug: string }) => e.slug === 'svc-basic');
    expect(entry.viaGateway).toBe(true);
    expect(entry.unresolved).toEqual([]);
    expect(entry.server).toEqual({ type: 'http', url: expect.stringContaining('/mcp/svc-basic/eatg_') });
    expect(JSON.stringify(entry)).not.toContain(upstreamUrl);
  });

  it('转发时注入真实凭证，并丢掉客户端自带的 Authorization', async () => {
    upstreamMode.kind = 'json';
    const url = await setupSubscribedConfig('svc-inject');
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // 客户端瞎塞的凭证必须被丢掉，不能透传给上游
        authorization: 'Bearer client-supplied-garbage',
        cookie: 'session=leak',
        'mcp-session-id': 'sess-from-client',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(200);
    expect(lastUpstreamHeaders.authorization).toBe('Bearer super-secret-upstream-token');
    expect(lastUpstreamHeaders.cookie).toBeUndefined();
    // 会话 id 属于协议必需，要透传
    expect(lastUpstreamHeaders['mcp-session-id']).toBe('sess-from-client');
  });

  it('成员没有该环境变量的读取权限也能用——订阅批准本身就是授权', async () => {
    // 确认成员确实读不到这个变量
    const pull = await api('POST', '/api/envs/mcp-upstream/values', {
      token: memberToken,
      payload: { keys: ['UPSTREAM_TOKEN'] },
    });
    expect(pull.body.values.UPSTREAM_TOKEN).toBeUndefined();
    expect(pull.body.denied).toHaveLength(1);

    const url = await setupSubscribedConfig('svc-noperm');
    const res = await callGateway(url);
    expect(res.status).toBe(200);
    expect(lastUpstreamHeaders.authorization).toBe('Bearer super-secret-upstream-token');
  });

  it('响应头白名单：www-authenticate 与 set-cookie 不回传', async () => {
    const url = await setupSubscribedConfig('svc-headers');
    upstreamMode.kind = 'json';
    const ok = await callGateway(url);
    expect(ok.headers.get('mcp-session-id')).toBe('sess-1');
    expect(ok.headers.get('set-cookie')).toBeNull();

    upstreamMode.kind = 'unauthorized';
    const denied = await callGateway(url);
    expect(denied.status).toBe(401);
    // 这条头会带上游的 resource metadata 地址，必须挡掉
    expect(denied.headers.get('www-authenticate')).toBeNull();
    upstreamMode.kind = 'json';
  });

  it('上游重定向不透传，换成脱敏的 502', async () => {
    const url = await setupSubscribedConfig('svc-redirect');
    upstreamMode.kind = 'redirect';
    const res = await callGateway(url);
    expect(res.status).toBe(502);
    expect(res.headers.get('location')).toBeNull();
    expect(await res.text()).not.toContain('real-upstream.internal');
    upstreamMode.kind = 'json';
  });

  it('SSE 响应逐块透传', async () => {
    const url = await setupSubscribedConfig('svc-sse');
    upstreamMode.kind = 'sse';
    const res = await callGateway(url);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const text = await res.text();
    expect(text).toContain('notifications/ping');
    expect(text.split('event: message').length - 1).toBe(2);
    upstreamMode.kind = 'json';
  });

  it('结束会话的 DELETE（带 content-type、空 body）能打到上游', async () => {
    // MCP 客户端就是这么关会话的，而 Fastify 默认会对「声明了 json 却没 body」直接回 400，
    // 请求根本进不了网关。回归用例钉住这条。
    const url = await setupSubscribedConfig('svc-delete');
    upstreamMode.kind = 'json';
    const res = await fetch(url, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json', 'mcp-session-id': 'sess-1' },
    });
    expect(res.status).toBe(200);
    expect(lastUpstreamHeaders['mcp-session-id']).toBe('sess-1');
  });

  it('GET 通知流也走同一条鉴权与转发', async () => {
    const url = await setupSubscribedConfig('svc-get');
    upstreamMode.kind = 'sse';
    const res = await fetch(url, { method: 'GET', headers: { accept: 'text/event-stream' } });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('notifications/ping');
    upstreamMode.kind = 'json';
  });

  it('已弃用的 SSE 传输被明确拒绝，而不是把上游地址漏回去', async () => {
    const url = await setupSubscribedConfig('svc-legacy');
    upstreamMode.kind = 'legacy-sse';
    const res = await fetch(url, {
      method: 'GET',
      headers: { accept: 'text/event-stream' },
    });
    expect(res.status).toBe(502);
    const body = await res.text();
    expect(body).toContain('MCP_GATEWAY_UPSTREAM_UNSUPPORTED');
    expect(body).not.toContain('sessionId');
    upstreamMode.kind = 'json';
  });
});

describe('MCP 网关：地址的失效与重建', () => {
  it('退订即失效；重新授权换成新地址，旧地址永久作废', async () => {
    const first = await setupSubscribedConfig('svc-cycle');
    expect((await callGateway(first)).status).toBe(200);

    await api('DELETE', '/api/mcp-configs/svc-cycle/subscribe', { token: memberToken });
    const afterUnsub = await callGateway(first);
    expect(afterUnsub.status).toBe(403);
    expect(await afterUnsub.text()).toContain('MCP_GATEWAY_URL_INVALID');

    // 重新申请 + 批准
    await api('POST', '/api/mcp-configs/svc-cycle/subscribe', { token: memberToken, payload: { reason: '再来' } });
    const reqs = (await api('GET', '/api/mcp-configs/subscription-requests', { token: adminToken })).body;
    const req = reqs.find((r: { configSlug: string; status: string }) => r.configSlug === 'svc-cycle' && r.status === 'pending');
    await api('POST', `/api/mcp-configs/subscription-requests/${req.id}/decision`, {
      token: adminToken,
      payload: { decision: 'approved' },
    });

    const second = (await api('GET', '/api/mcp-configs', { token: memberToken })).body.find(
      (c: { slug: string }) => c.slug === 'svc-cycle',
    ).gatewayUrl;
    expect(second).not.toBe(first);
    expect((await callGateway(second)).status).toBe(200);
    // 旧的不会因为重新授权而复活
    expect((await callGateway(first)).status).toBe(403);
  });

  it('主动重新生成后旧地址立即失效', async () => {
    const first = await setupSubscribedConfig('svc-regen');
    const regen = await api('POST', '/api/mcp-configs/svc-regen/gateway-url/regenerate', { token: memberToken });
    expect(regen.status).toBe(201);
    expect(regen.body.url).not.toBe(first);
    expect((await callGateway(first)).status).toBe(403);
    expect((await callGateway(regen.body.url)).status).toBe(200);
  });

  it('模板派生的订阅也有地址；管理员把配置移出模板后立即失效（实时复算兜底）', async () => {
    await api('POST', '/api/mcp-configs', {
      token: adminToken,
      payload: {
        slug: 'svc-template',
        name: '模板里的服务',
        transport: 'http',
        url: upstreamUrl,
        headers: { Authorization: 'Bearer ${env:mcp-upstream/UPSTREAM_TOKEN}' },
        visibility: 'team',
      },
    });
    const configId = (await api('GET', '/api/mcp-configs', { token: adminToken })).body.find(
      (c: { slug: string }) => c.slug === 'svc-template',
    ).id;
    const tpl = await api('POST', '/api/templates', {
      token: adminToken,
      payload: { name: '网关模板', description: '' },
    });
    const tplId = tpl.body.id;
    await api('PUT', `/api/templates/${tplId}/items`, {
      token: adminToken,
      payload: { items: [{ itemType: 'mcp_config', itemId: configId }] },
    });
    await api('POST', `/api/templates/${tplId}/select`, { token: memberToken });

    // 模板派生的订阅在 mcp_subscription 里根本没有行，地址靠懒签发拿到
    const url = (await api('GET', '/api/mcp-configs', { token: memberToken })).body.find(
      (c: { slug: string }) => c.slug === 'svc-template',
    ).gatewayUrl;
    expect(url).toBeTruthy();
    expect((await callGateway(url)).status).toBe(200);

    // 把配置从模板里移除。这条路径**没有**任何吊销代码，全靠每次请求实时复算授权
    await api('PUT', `/api/templates/${tplId}/items`, { token: adminToken, payload: { items: [] } });
    expect((await callGateway(url)).status).toBe(403);
  });

  it('关掉网关开关后旧地址失效，sync 回落到直连渲染', async () => {
    const url = await setupSubscribedConfig('svc-off');
    expect((await callGateway(url)).status).toBe(200);

    await api('POST', '/api/mcp-configs', {
      token: adminToken,
      payload: {
        slug: 'svc-off',
        name: '测试服务 svc-off',
        transport: 'http',
        url: upstreamUrl,
        headers: { Authorization: 'Bearer ${env:mcp-upstream/UPSTREAM_TOKEN}' },
        visibility: 'team',
        gatewayEnabled: false,
      },
    });
    expect((await callGateway(url)).status).toBe(403);

    const entry = (await api('GET', '/api/mcp-configs/sync-bundle', { token: memberToken })).body.find(
      (e: { slug: string }) => e.slug === 'svc-off',
    );
    expect(entry.viaGateway).toBe(false);
    // 直连模式下成员没有变量权限，占位符原样保留并给出申请指引
    expect(entry.unresolved).toHaveLength(1);
    expect(entry.server.headers.Authorization).toContain('${env:');
  });

  it('stdio 配置强制不走网关', async () => {
    await api('POST', '/api/mcp-configs', {
      token: adminToken,
      payload: {
        slug: 'svc-stdio',
        name: '本地进程',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', 'some-server'],
        visibility: 'team',
        gatewayEnabled: true,
      },
    });
    const info = (await api('GET', '/api/mcp-configs', { token: adminToken })).body.find(
      (c: { slug: string }) => c.slug === 'svc-stdio',
    );
    expect(info.gatewayEnabled).toBe(false);
    expect(info.gatewayAvailable).toBe(false);
    expect(info.gatewayUrl).toBeNull();
  });

  it('token 只服务它被签发的那个配置', async () => {
    const a = await setupSubscribedConfig('svc-a');
    const b = await setupSubscribedConfig('svc-b');
    const tokenOfA = a.split('/').pop()!;
    const crossed = b.replace(/eatg_[0-9a-f]+$/, tokenOfA);
    expect((await callGateway(crossed)).status).toBe(403);
  });

  it('乱编的地址一律 403，不区分「不存在」与「已失效」', async () => {
    const res = await callGateway(`${platformUrl}/mcp/svc-basic/eatg_${'0'.repeat(48)}`);
    expect(res.status).toBe(403);
  });
});

describe('凭证归属按传输方式收敛（决策 52）', () => {
  it('http 配置传进来的 env 被丢弃，不入库也不进 sync 输出', async () => {
    await api('POST', '/api/mcp-configs', {
      token: adminToken,
      payload: {
        slug: 'svc-http-env',
        name: '把凭证填错地方的 http 配置',
        transport: 'http',
        url: upstreamUrl,
        headers: { Authorization: 'Bearer ${env:mcp-upstream/UPSTREAM_TOKEN}' },
        // HTTP MCP 客户端不看配置里的 env，填在这里等于静默失效——服务端直接丢掉
        env: { UPSTREAM_TOKEN: '${env:mcp-upstream/UPSTREAM_TOKEN}' },
        visibility: 'team',
        gatewayEnabled: false,
      },
    });
    const info = (await api('GET', '/api/mcp-configs', { token: adminToken })).body.find(
      (c: { slug: string }) => c.slug === 'svc-http-env',
    );
    expect(info.env).toEqual({});
    expect(info.headers.Authorization).toContain('${env:');

    const entry = (await api('GET', '/api/mcp-configs/sync-bundle', { token: adminToken })).body.find(
      (e: { slug: string }) => e.slug === 'svc-http-env',
    );
    expect(entry.server).not.toHaveProperty('env');
    expect(entry.server.headers.Authorization).toBe('Bearer super-secret-upstream-token');
  });

  it('stdio 配置传进来的 headers 被丢弃；env 照常渲染', async () => {
    await api('POST', '/api/mcp-configs', {
      token: adminToken,
      payload: {
        slug: 'svc-stdio-headers',
        name: '本地进程',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', 'some-server'],
        // stdio 根本不发 HTTP 请求，请求头无处可用
        headers: { Authorization: 'Bearer nonsense' },
        env: { API_TOKEN: '${env:mcp-upstream/UPSTREAM_TOKEN}' },
        visibility: 'team',
      },
    });
    const info = (await api('GET', '/api/mcp-configs', { token: adminToken })).body.find(
      (c: { slug: string }) => c.slug === 'svc-stdio-headers',
    );
    expect(info.headers).toEqual({});
    expect(info.env.API_TOKEN).toContain('${env:');

    const entry = (await api('GET', '/api/mcp-configs/sync-bundle', { token: adminToken })).body.find(
      (e: { slug: string }) => e.slug === 'svc-stdio-headers',
    );
    expect(entry.viaGateway).toBe(false);
    expect(entry.server).not.toHaveProperty('headers');
    expect(entry.server.env.API_TOKEN).toBe('super-secret-upstream-token');
  });

  it('把配置从 stdio 改成 http 时，原来的 env 一并清掉', async () => {
    await api('POST', '/api/mcp-configs', {
      token: adminToken,
      payload: {
        slug: 'svc-switch',
        name: '换传输方式',
        transport: 'stdio',
        command: 'npx',
        args: [],
        env: { API_TOKEN: '${env:mcp-upstream/UPSTREAM_TOKEN}' },
        visibility: 'team',
      },
    });
    await api('POST', '/api/mcp-configs', {
      token: adminToken,
      payload: {
        slug: 'svc-switch',
        name: '换传输方式',
        transport: 'http',
        url: upstreamUrl,
        headers: { Authorization: 'Bearer ${env:mcp-upstream/UPSTREAM_TOKEN}' },
        visibility: 'team',
        gatewayEnabled: false,
      },
    });
    const info = (await api('GET', '/api/mcp-configs', { token: adminToken })).body.find(
      (c: { slug: string }) => c.slug === 'svc-switch',
    );
    expect(info.env).toEqual({});
  });
});

describe('MCP 网关：长耗时调用（决策 58）', () => {
  afterEach(() => {
    delete process.env.EAT_MCP_GATEWAY_UPSTREAM_TIMEOUT_MS;
    upstreamMode.kind = 'json';
    upstreamMode.delayMs = 0;
  });

  it('上游慢慢回也照样把结果完整带回来', async () => {
    const url = await setupSubscribedConfig('svc-slow');
    process.env.EAT_MCP_GATEWAY_UPSTREAM_TIMEOUT_MS = '5000';
    upstreamMode.kind = 'slow-json';
    upstreamMode.delayMs = 1200;

    const res = await callGateway(url, {
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/call',
      params: { name: 'slow_tool', arguments: {} },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ result: { ok: true, slow: true } });
  });

  it('真超时时给明确的 504 并留痕，而不是一个空的 200', async () => {
    // 回归点：旧实现拿 `req.raw.destroyed` 当「客户端断开」的判据，而 Node 16 起
    // 请求体读完就会把它置真，于是**每一次上游超时都被当成客户端自己走了**，
    // 走 `reply.raw.end()` 发出一个没有 body 的 200——客户端拿不到任何 JSON-RPC
    // 响应（表现就是「调用了但什么都没回来」），平台侧还连条记录都不留。
    const url = await setupSubscribedConfig('svc-timeout');
    process.env.EAT_MCP_GATEWAY_UPSTREAM_TIMEOUT_MS = '600';
    upstreamMode.kind = 'slow-json';
    upstreamMode.delayMs = 5000;

    const res = await callGateway(url, {
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/call',
      params: { name: 'too_slow', arguments: {} },
    });
    expect(res.status).toBe(504);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe('MCP_GATEWAY_UPSTREAM_TIMEOUT');
    expect(body.message).toContain('没有响应');

    // 记录里留的是**技术原因**而不是回给调用方的那句安慰话：排查时要知道是超时还是连不上，
    // 以及该去调哪个开关（决策 60）
    const list = (await api('GET', '/api/mcp-gateway/calls?slug=svc-timeout', { token: adminToken })).body;
    expect(list.items[0].toolName).toBe('too_slow');
    expect(list.items[0].error).toContain('等上游响应头超过');
    expect(list.items[0].error).toContain('EAT_MCP_GATEWAY_UPSTREAM_TIMEOUT_MS');
  });

  it('上游连不上时，调用记录里留的是技术原因而不是那句安慰话（决策 60）', async () => {
    // 回给调用方的仍然是「这个服务暂时连不上」（不泄漏上游），但运维要能看出是
    // ECONNREFUSED 还是 DNS 解析不了——原先两者在记录里长得一模一样，等于每次都靠猜。
    const url = await setupSubscribedConfig('svc-down', 'http://127.0.0.1:1/mcp');

    const res = await callGateway(url, { jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'nope' } });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe('MCP_GATEWAY_UPSTREAM_UNAVAILABLE');
    expect(body.message).toContain('连不上');
    expect(body.message).not.toContain('127.0.0.1');

    const list = (await api('GET', '/api/mcp-gateway/calls?slug=svc-down', { token: adminToken })).body;
    expect(list.items[0].toolName).toBe('nope');
    expect(list.items[0].error).toContain('ECONNREFUSED');
  });

  it('默认上限远宽于客户端自己的超时，网关不该是先放弃的那个', () => {
    // 常见 MCP 客户端的单次调用超时是 60 秒，网关的默认值要明显宽于它
    delete process.env.EAT_MCP_GATEWAY_UPSTREAM_TIMEOUT_MS;
    expect(loadConfig().mcpGatewayUpstreamTimeoutMs).toBeGreaterThanOrEqual(180_000);
    // 写歪的值不能变成「立刻超时」：NaN 交给 setTimeout 等于 0 毫秒
    process.env.EAT_MCP_GATEWAY_UPSTREAM_TIMEOUT_MS = '不是数字';
    expect(loadConfig().mcpGatewayUpstreamTimeoutMs).toBeGreaterThanOrEqual(180_000);
  });

  it('空闲连接活得比前置代理的回收时间久（决策 61）', () => {
    // Fastify 默认 72 秒、Traefik 默认留 90 秒：错位出来的那个窗口里，
    // 代理复用一条平台刚关掉的连接，带 body 的 POST 不会被重试，调用方直接拿到 502，
    // 而平台连请求都没收到（调用记录里一行都没有）。默认值必须高于 90 秒。
    delete process.env.EAT_KEEP_ALIVE_TIMEOUT_MS;
    expect(loadConfig().keepAliveTimeoutMs).toBeGreaterThan(90_000);
    process.env.EAT_KEEP_ALIVE_TIMEOUT_MS = '不是数字';
    expect(loadConfig().keepAliveTimeoutMs).toBeGreaterThan(90_000);
    process.env.EAT_KEEP_ALIVE_TIMEOUT_MS = '200000';
    expect(loadConfig().keepAliveTimeoutMs).toBe(200_000);
    delete process.env.EAT_KEEP_ALIVE_TIMEOUT_MS;
  });
});

describe('MCP 网关：调用记录', () => {
  it('记下 method 与工具名，但不记 arguments', async () => {
    const url = await setupSubscribedConfig('svc-audit');
    await callGateway(url, {
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'search_issues', arguments: { query: '机密关键词' } },
    });

    const list = (await api('GET', '/api/mcp-gateway/calls?slug=svc-audit', { token: adminToken })).body;
    expect(list.total).toBeGreaterThanOrEqual(1);
    const call = list.items[0];
    expect(call.method).toBe('tools/call');
    expect(call.toolName).toBe('search_issues');
    expect(call.userId).toBe(memberId);
    expect(call.status).toBe(200);
    expect(JSON.stringify(list)).not.toContain('机密关键词');
  });

  it('路人看不到别人配置的调用记录', async () => {
    const list = (await api('GET', '/api/mcp-gateway/calls?slug=svc-audit', { token: outsiderToken })).body;
    expect(list.items).toEqual([]);
    expect(list.total).toBe(0);
  });

  it('被拒的请求也留痕', async () => {
    const before = (await api('GET', '/api/mcp-gateway/calls?slug=svc-audit', { token: adminToken })).body.total;
    await callGateway(`${platformUrl}/mcp/svc-audit/eatg_${'f'.repeat(48)}`);
    const after = (await api('GET', '/api/mcp-gateway/calls?slug=svc-audit', { token: adminToken })).body.total;
    // token 认不出来时归不到具体配置上，所以这里不该增加——避免任何人用乱猜的地址往别人的记录里灌垃圾
    expect(after).toBe(before);
  });
});

describe('MCP 网关：SSRF 防护', () => {
  it('识别各类内网与保留地址', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0']) {
      expect(isPrivateAddress(ip)).toBe(true);
    }
    for (const ip of ['::1', 'fe80::1', 'fd00::1', '::ffff:10.0.0.1']) {
      expect(isPrivateAddress(ip)).toBe(true);
    }
    expect(isPrivateAddress('8.8.8.8')).toBe(false);
    expect(isPrivateAddress('2001:4860:4860::8888')).toBe(false);
  });

  it('默认配置下拒绝内网上游，也拒绝非 http(s) 协议', async () => {
    process.env.EAT_MCP_GATEWAY_ALLOW_PRIVATE = '0';
    try {
      await expect(assertSafeUpstream('http://169.254.169.254/latest/meta-data/')).rejects.toThrow(/内网或保留地址/);
      await expect(assertSafeUpstream('http://127.0.0.1:9999/mcp')).rejects.toThrow(/内网或保留地址/);
      await expect(assertSafeUpstream('file:///etc/passwd')).rejects.toThrow(/配置有误/);
      await expect(assertSafeUpstream('not-a-url')).rejects.toThrow(/配置有误/);
    } finally {
      process.env.EAT_MCP_GATEWAY_ALLOW_PRIVATE = '1';
    }
  });
});
