process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://dev:dev@127.0.0.1:5433/eat_test';
process.env.EAT_PUBLIC_URL = 'http://eat.test:3000';

import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import * as bcrypt from 'bcryptjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../src/app.module';
import { WebhookService } from '../src/notify/webhook.service';
import { SiteRuntime } from '../src/sites/site-config';
import { SiteSettingsStore } from '../src/sites/site-settings.store';
import { TestSiteStorage } from './site-fixture';
import { encryptSecret } from '../src/common/crypto';
import { SiteStorage } from '../src/sites/site-storage.service';
import { McpToolsService } from '../src/mcp-server/mcp-tools.service';
import { AuthService } from '../src/auth/auth.service';
import * as schema from '../src/db/schema';

let app: NestFastifyApplication;
let owner: string, other: string, admin: string, otherId: string, ownerId: string;
let v1: string, v2: string, threadId: string, dir: string;
const notify = vi.fn();
const files = (title: string) => [
  {
    path: 'index.html',
    content: `<html><body><h1 data-eat-id="title">${title}</h1><img src="/image.png"><script src="/app.js"></script></body></html>`,
  },
  { path: 'app.js', content: `console.log(${JSON.stringify(title)})` },
  { path: 'image.png', encoding: 'base64', content: Buffer.from([137, 80, 78, 71]).toString('base64') },
  { path: 'about/index.html', content: '<h1>About</h1>' },
];
async function api(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT',
  url: string,
  token?: string,
  payload?: unknown,
  extra: Record<string, string> = {},
) {
  const r = await app.inject({
    method,
    url,
    payload: payload as never,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra },
  });
  return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null, headers: r.headers };
}
function content(
  path = '/',
  opts: {
    version?: number;
    token?: string;
    cookie?: string;
    site?: string;
    method?: 'GET' | 'HEAD' | 'POST';
    payload?: unknown;
    origin?: string;
  } = {},
) {
  const host = `${opts.version ? 'v' + opts.version + '--' : ''}${opts.site ?? 'demo'}.sites.test:3000`;
  return app.inject({
    method: opts.method ?? 'GET',
    url: path,
    payload: opts.payload as never,
    headers: {
      host,
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
      ...(opts.origin ? { origin: opts.origin } : {}),
    },
  });
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'eat-sites-'));
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await pool.query('drop schema public cascade; create schema public; drop schema if exists drizzle cascade;');
  await migrate(drizzle(pool), { migrationsFolder: resolve('drizzle') });
  const db = drizzle(pool, { schema });
  const passwordHash = await bcrypt.hash('password123', 4);
  await db.insert(schema.users).values([
    { name: 'Owner', email: 'owner@site.test', passwordHash },
    { name: 'Other', email: 'other@site.test', passwordHash },
    { name: 'Admin', email: 'admin@site.test', role: 'admin', passwordHash },
  ]);
  await db.insert(schema.siteSettings).values({
    status: 'enabled',
    domain: 'sites.test:3000',
    ossRegion: 'oss-cn-hangzhou',
    ossBucket: 'test-bucket',
    ossAccessKeyIdEncrypted: encryptSecret('test-key'),
    ossAccessKeySecretEncrypted: encryptSecret('test-secret'),
    tlsMode: 'alidns',
    platformApplicationId: 'eat',
    gatewayTarget: '127.0.0.1',
  });
  await pool.end();
  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(SiteStorage)
    .useFactory({ factory: (store: SiteSettingsStore) => new TestSiteStorage(store, dir), inject: [SiteSettingsStore] })
    .overrideProvider(SiteRuntime)
    .useFactory({
      factory: (store: SiteSettingsStore) => {
        const runtime = new SiteRuntime(store);
        runtime.config = async () => ({
          domain: 'sites.test:3000',
          protocol: 'http' as const,
          platform: await runtime.platform(),
        });
        return runtime;
      },
      inject: [SiteSettingsStore],
    })
    .overrideProvider(WebhookService)
    .useValue({ notify })
    .compile();
  app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  const login = async (email: string) =>
    (await api('POST', '/api/auth/login', undefined, { email, password: 'password123' })).body;
  const a = await login('owner@site.test'),
    b = await login('other@site.test');
  owner = a.token;
  ownerId = a.user.id;
  other = b.token;
  otherId = b.user.id;
  admin = (await login('admin@site.test')).token;
});
afterAll(async () => {
  await app?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe('静态发布与不可变历史版本', () => {
  it('普通成员创建网站无需审批，默认仅登录访问，并自动分配域名', async () => {
    const r = await api('POST', '/api/sites', owner, { slug: 'demo', name: 'Demo' });
    expect(r.status).toBe(201);
    expect(r.body.access).toBe('authenticated');
    expect(r.body.url).toBe('http://demo.sites.test:3000');
    expect(r.body.passwordHash).toBeUndefined();
    expect((await api('POST', '/api/sites', owner, { slug: 'demo', name: 'Duplicate' })).status).toBe(409);
    expect((await api('POST', '/api/sites', owner, { slug: 'bad--slug', name: 'Invalid' })).status).toBe(400);
  });
  it('非所有者不能修改或发布，平台管理员可以管理', async () => {
    expect((await api('PATCH', '/api/sites/demo', other, { name: 'Hijack' })).status).toBe(403);
    expect((await api('POST', '/api/sites/demo/releases', other, { files: files('bad') })).status).toBe(403);
    expect((await api('PATCH', '/api/sites/demo', admin, { description: 'admin edit' })).status).toBe(200);
  });
  it('发布保留完整文件，自动注入评论，并支持二进制文件', async () => {
    const r = await api('POST', '/api/sites/demo/releases', owner, { files: files('v1'), message: 'first' });
    expect(r.status).toBe(201);
    v1 = r.body.id;
    expect(r.body.number).toBe(1);
    const page = await content('/', { version: 1, token: other });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('v1');
    expect(page.body).toContain('/__eat/embed.js');
    expect(page.body).not.toContain(other);
    const latest = await content('/', { token: other });
    expect(latest.statusCode).toBe(200);
    expect(latest.headers.location).toBeUndefined();
    expect(latest.headers['x-eat-site-version']).toBe(v1);
    expect(latest.body).toContain('v1');
    const latestConfig = JSON.parse(
      Buffer.from(/data-eat="([^"]+)"/.exec(latest.body)![1], 'base64').toString(),
    );
    expect(latestConfig.versionId).toBe(v1);
    const head = await content('/', { token: other, method: 'HEAD' });
    expect(head.statusCode).toBe(200);
    expect(head.headers.location).toBeUndefined();
    expect(head.headers['x-eat-site-version']).toBe(v1);
    expect(head.body).toBe('');
    const image = await content('/image.png', { version: 1, token: other });
    expect(image.rawPayload).toEqual(Buffer.from([137, 80, 78, 71]));
    expect((await content('/about', { version: 1, token: other })).headers.location).toBe('/about/');
  });
  it('仅发布端点允许大于默认 1 MiB 的合法上传', async () => {
    const r = await api('POST', '/api/sites/demo/releases', owner, {
      files: [{ path: 'index.html', content: '<body>' + '.'.repeat(1100000) + '</body>' }],
    });
    expect(r.status).toBe(201);
  });
  it('拒绝目录穿越、保留路由、重复文件、无首页和错误 Base64', async () => {
    for (const path of ['../secret', '/index.html', 'a/../../b', 'a\\b', '__eat/embed.js', '.env.local'])
      expect(
        (await api('POST', '/api/sites/demo/releases', owner, { files: [...files('bad'), { path, content: 'bad' }] }))
          .status,
      ).toBe(400);
    expect(
      (
        await api('POST', '/api/sites/demo/releases', owner, {
          files: [...files('bad'), { path: 'index.html', content: 'duplicate' }],
        })
      ).status,
    ).toBe(400);
    expect(
      (await api('POST', '/api/sites/demo/releases', owner, { files: [{ path: 'readme.txt', content: 'no index' }] }))
        .status,
    ).toBe(400);
    expect(
      (
        await api('POST', '/api/sites/demo/releases', owner, {
          files: [...files('bad'), { path: 'x.png', encoding: 'base64', content: 'not base64!' }],
        })
      ).status,
    ).toBe(400);
  });
  it('上传中途失败不激活、不留新版本，旧文件保持可用', async () => {
    const storage = app.get(SiteStorage);
    const original = storage.put.bind(storage);
    let count = 0;
    const spy = vi.spyOn(storage, 'put').mockImplementation(async (...args) => {
      if (++count === 2) throw new Error('storage unavailable');
      return original(...args);
    });
    const r = await api('POST', '/api/sites/demo/releases', owner, { files: files('incomplete') });
    expect(r.status).toBe(500);
    spy.mockRestore();
    expect((await api('GET', '/api/sites/demo/versions', owner)).body).toHaveLength(2);
    expect((await content('/', { version: 1, token: owner })).body).toContain('v1');
  });
  it('并发发布版本号唯一，历史版本仍可访问，入口可回滚', async () => {
    const rs = await Promise.all([
      api('POST', '/api/sites/demo/releases', owner, { files: files('new A') }),
      api('POST', '/api/sites/demo/releases', owner, { files: files('new B') }),
    ]);
    expect(rs.every((r) => r.status === 201)).toBe(true);
    expect(new Set(rs.map((r) => r.body.number)).size).toBe(2);
    v2 = rs[0].body.id;
    const latestVersion = rs.map((r) => r.body).sort((a, b) => b.number - a.number)[0];
    const latest = await content('/', { token: owner });
    expect(latest.statusCode).toBe(200);
    expect(latest.headers.location).toBeUndefined();
    expect(latest.headers['x-eat-site-version']).toBe(latestVersion.id);
    expect((await api('POST', '/api/sites/demo/activate', owner, { versionId: v1 })).status).toBe(201);
    const rolledBack = await content('/', { token: owner });
    expect(rolledBack.statusCode).toBe(200);
    expect(rolledBack.headers.location).toBeUndefined();
    expect(rolledBack.headers['x-eat-site-version']).toBe(v1);
    expect((await content('/', { version: latestVersion.number, token: owner })).headers['x-eat-site-version']).toBe(
      latestVersion.id,
    );
  });
});

describe('登录、公开、密码与域名隔离', () => {
  it('登录模式同时保护 HTML、资源和历史版本', async () => {
    for (const version of [undefined, 1])
      for (const path of ['/', '/app.js', '/image.png']) {
        const r = await content(path, { version });
        expect(r.statusCode).toBe(302);
        expect(r.headers.location).toContain('/sites/authorize?');
        const returnUrl = new URL(String(r.headers.location)).searchParams.get('returnUrl');
        expect(new URL(returnUrl!).host).toBe(`${version ? 'v1--' : ''}demo.sites.test:3000`);
      }
    const r = await content('/api/users', { version: 1, token: owner });
    expect(r.statusCode).toBe(404);
    expect(r.body).not.toContain('owner@site.test');
  });
  it('登录兑换码绑定域名、单次使用，Cookie 不暴露平台 Token', async () => {
    expect((await api('POST', '/api/sites/demo/authorize', other, { returnUrl: 'http://evil.test/' })).status).toBe(
      400,
    );
    expect(
      (
        await api('POST', '/api/sites/demo/authorize', other, {
          returnUrl: 'http://v1--demo.sites.test:3000//evil.test/',
        })
      ).status,
    ).toBe(400);
    const r = await api('POST', '/api/sites/demo/authorize', other, {
      returnUrl: 'http://v1--demo.sites.test:3000/about/',
    });
    const callback = new URL(r.body.url);
    expect((await content(callback.pathname + callback.search, { version: 2 })).statusCode).toBe(401);
    const login = await content(callback.pathname + callback.search, { version: 1 });
    expect(login.statusCode).toBe(302);
    expect(login.headers.location).toBe('/about/');
    const cookie = String(login.headers['set-cookie']);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).not.toContain(other);
    expect(cookie).not.toContain('Domain=');
    expect((await content('/', { version: 1, cookie: cookie.split(';')[0] })).statusCode).toBe(200);
    expect((await content(callback.pathname + callback.search, { version: 1 })).statusCode).toBe(401);
  });
  it('公开访问无需登录，但匿名用户不能发表评论', async () => {
    await api('PATCH', '/api/sites/demo', owner, { access: 'public' });
    expect((await content('/', { version: 1 })).statusCode).toBe(200);
    const latest = await content('/');
    expect(latest.statusCode).toBe(200);
    expect(latest.headers.location).toBeUndefined();
    expect(
      (await api('POST', '/api/sites/demo/threads', undefined, { versionId: v1, page: '/', content: 'anonymous' }))
        .status,
    ).toBe(401);
  });
  it('固定域名登录后保持原域名，访问会话不能用于历史域名', async () => {
    await api('PATCH', '/api/sites/demo', owner, { access: 'authenticated' });
    const r = await api('POST', '/api/sites/demo/authorize', other, {
      returnUrl: 'http://demo.sites.test:3000/about/?view=full',
    });
    expect(r.status).toBe(201);
    const callback = new URL(r.body.url);
    expect(callback.host).toBe('demo.sites.test:3000');
    expect((await content(callback.pathname + callback.search, { version: 1 })).statusCode).toBe(401);
    const login = await content(callback.pathname + callback.search);
    expect(login.statusCode).toBe(302);
    expect(login.headers.location).toBe('/about/?view=full');
    const cookie = String(login.headers['set-cookie']).split(';')[0];
    const page = await content('/about/?view=full', { cookie });
    expect(page.statusCode).toBe(200);
    expect(page.headers.location).toBeUndefined();
    expect((await content('/', { version: 1, cookie })).statusCode).toBe(302);
  });
  it('密码限制覆盖历史资源；免输密码链接不包含明文密码', async () => {
    expect((await api('PATCH', '/api/sites/demo', owner, { access: 'password' })).status).toBe(400);
    await api('PATCH', '/api/sites/demo', owner, { access: 'password', password: 'site-password' });
    expect((await content('/', { version: 1 })).statusCode).toBe(403);
    expect((await content('/app.js', { version: 1, token: other })).statusCode).toBe(403);
    expect(
      (
        await content('/__eat/access', {
          version: 1,
          method: 'POST',
          origin: 'http://evil.test',
          payload: { password: 'site-password' },
        })
      ).statusCode,
    ).toBe(403);
    const form = await content('/__eat/access', {
      version: 1,
      method: 'POST',
      origin: 'http://v1--demo.sites.test:3000',
      payload: { password: 'site-password' },
    });
    expect(form.statusCode).toBe(200);
    expect(
      (await content('/image.png', { version: 1, cookie: String(form.headers['set-cookie']).split(';')[0] }))
        .statusCode,
    ).toBe(200);
    const share = await api('POST', '/api/sites/demo/share', owner, {});
    expect(share.body.url).not.toContain('site-password');
    const token = new URL(share.body.url).searchParams.get('eat_access');
    const visit = await content('/?eat_access=' + token, { version: 1 });
    expect(visit.statusCode).toBe(302);
    expect(visit.headers.location).toBe('/');
    const cookie = String(visit.headers['set-cookie']).split(';')[0];
    expect((await content('/app.js', { version: 1, cookie })).statusCode).toBe(200);
    expect((await api('GET', '/api/sites/demo/threads', other)).status).toBe(403);
    const access = await api('POST', '/api/sites/demo/access', undefined, { password: 'site-password' });
    expect(access.status).toBe(201);
    expect(
      (await api('GET', '/api/sites/demo/threads', other, undefined, { 'x-eat-site-access': access.body.accessToken }))
        .status,
    ).toBe(200);
    await api('PATCH', '/api/sites/demo', owner, { password: 'new-password' });
    expect((await content('/app.js', { version: 1, cookie })).statusCode).toBe(403);
    expect((await content('/?eat_access=' + token, { version: 1 })).statusCode).toBe(403);
    expect(
      (await api('GET', '/api/sites/demo/threads', other, undefined, { 'x-eat-site-access': access.body.accessToken }))
        .status,
    ).toBe(403);
  });
});

describe('版本评论、区域锚点、@ 与工具接入', () => {
  it('批注仅接受本站固定域名或实际浏览版本域名，旧页面发布后仍可连接', async () => {
    const path = '/api/sites/demo/embed-origin?versionId=' + v1;
    for (const origin of ['http://demo.sites.test:3000', 'http://v1--demo.sites.test:3000']) {
      const r = await api('GET', path + '&origin=' + encodeURIComponent(origin));
      expect(r.status).toBe(200);
      expect(r.body.origin).toBe(origin);
    }
    expect((await api('GET', path)).body.origin).toBe('http://v1--demo.sites.test:3000');
    for (const origin of ['http://evil.test', 'http://second.sites.test:3000', 'http://v2--demo.sites.test:3000'])
      expect((await api('GET', path + '&origin=' + encodeURIComponent(origin))).status).toBe(400);
  });
  it('评论创建在 v1，发布后回复记录实际浏览版本', async () => {
    await api('PATCH', '/api/sites/demo', owner, { access: 'authenticated' });
    const r = await api('POST', '/api/sites/demo/threads', other, {
      versionId: v1,
      page: '/',
      content: '元素颜色需调整',
      anchor: {
        type: 'region',
        elementId: 'title',
        selector: 'h1',
        text: 'v1',
        rect: { x: 0, y: 0, width: 0.5, height: 1 },
      },
    });
    expect(r.status).toBe(201);
    threadId = r.body.id;
    expect(r.body.versionId).toBe(v1);
    const reply = await api('POST', `/api/sites/demo/threads/${threadId}/replies`, owner, {
      versionId: v2,
      content: '新版本已调整',
    });
    expect(reply.status).toBe(201);
    expect(reply.body.comments.map((c: any) => c.versionId)).toEqual([v1, v2]);
    expect(reply.body.url).toContain('v1--demo');
    expect((await api('GET', '/api/sites/demo/threads?versionId=' + v2, owner)).body).toHaveLength(0);
    expect((await api('GET', '/api/sites/demo/threads', owner)).body).toHaveLength(1);
  });
  it('拒绝其他网站的版本、讨论与不存在的 @ 用户', async () => {
    await api('POST', '/api/sites', owner, { slug: 'second', name: 'Second' });
    const release = await api('POST', '/api/sites/second/releases', owner, { files: files('second') });
    expect(
      (
        await api('POST', `/api/sites/demo/threads/${threadId}/replies`, owner, {
          versionId: release.body.id,
          content: 'wrong site',
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await api('POST', `/api/sites/second/threads/${threadId}/replies`, owner, {
          versionId: release.body.id,
          content: 'wrong thread',
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await api('POST', '/api/sites/demo/threads', owner, {
          versionId: v1,
          page: '/',
          content: 'invalid mention',
          mentions: ['00000000-0000-4000-8000-000000000000'],
        })
      ).status,
    ).toBe(400);
  });
  it('被 @ 用户有飞书配置时通知一次，正文与密码不进入通知', async () => {
    await api('PUT', '/api/helpers/me', other, {
      description: '',
      webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/test-only',
      webhookSecret: 'test-signature',
    });
    const r = await api('POST', `/api/sites/demo/threads/${threadId}/replies`, owner, {
      versionId: v2,
      content: 'private comment text',
      mentions: [otherId, otherId, ownerId],
    });
    expect(r.status).toBe(201);
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
    const args = notify.mock.calls[0];
    expect(args[0]).toBe('site.comment.mentioned');
    expect(args[2]).toBe('test-signature');
    expect(JSON.stringify(args[3])).not.toContain('private comment text');
    expect(JSON.stringify(args[3])).toContain(threadId);
  });
  it('仅发起人、站点所有者和管理员可解决讨论，发布与回滚不改变讨论状态', async () => {
    expect((await api('PATCH', `/api/sites/demo/threads/${threadId}`, owner, { status: 'resolved' })).status).toBe(200);
    await api('POST', '/api/sites/demo/activate', owner, { versionId: v2 });
    expect((await api('GET', '/api/sites/demo/threads?status=resolved', owner)).body).toHaveLength(1);
  });
  it('评论登录兑换码只能使用一次，受限会话不能调用平台其他 API，吊销原 Token 后立即失效', async () => {
    const ticket = await api('POST', '/api/sites/demo/comment-ticket', other, {});
    const session = await api('POST', '/api/sites/demo/comment-session', undefined, { code: ticket.body.code });
    expect(session.status).toBe(201);
    expect((await api('POST', '/api/sites/demo/comment-session', undefined, { code: ticket.body.code })).status).toBe(
      401,
    );
    const headers = { 'x-eat-comment-session': session.body.token };
    expect((await api('GET', '/api/sites/demo/mention-users', undefined, undefined, headers)).status).toBe(200);
    expect((await api('GET', '/api/users', undefined, undefined, headers)).status).toBe(401);
    expect(
      (
        await api(
          'POST',
          `/api/sites/demo/threads/${threadId}/replies`,
          undefined,
          { versionId: v1, content: 'scoped reply' },
          headers,
        )
      ).status,
    ).toBe(201);
    const auth = await app.get(AuthService).authenticate(other);
    await api('DELETE', '/api/auth/tokens/' + auth!.tokenId, other);
    expect((await api('GET', '/api/sites/demo/threads', undefined, undefined, headers)).status).toBe(401);
  });
  it('HTTP MCP 直接复用服务层，支持发布与版本评论，权限一致', async () => {
    const tools = app.get(McpToolsService);
    const user = (await app.get(AuthService).authenticate(owner))!;
    expect(tools.listTools().some((t) => t.name === 'publish_site')).toBe(true);
    const result = (await tools.call(user, 'list_site_comments', { site: 'demo' })) as any[];
    expect(result[0].versionId).toBe(v1);
    await expect(
      tools.call(user, 'publish_site', { site: 'demo', files: [{ path: '../index.html', content: 'bad' }] }),
    ).rejects.toThrow();
    const created = (await tools.call(user, 'create_site_comment', {
      site: 'demo',
      page: '/',
      versionId: v2,
      content: 'from MCP',
    })) as any;
    expect(created.comments[0].versionId).toBe(v2);
  });
});
