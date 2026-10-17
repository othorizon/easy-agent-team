process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://dev:dev@127.0.0.1:5433/eat_test';
process.env.EAT_PUBLIC_URL = 'http://eat.test:3000';

import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import * as bcrypt from 'bcryptjs';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { uploadFolioFiles, siteContentType, type FolioUploadFile } from '@eat/shared';
import { AuditService } from '../src/audit/audit.service';
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
import { SitesService } from '../src/sites/sites.service';
import { McpToolsService } from '../src/mcp-server/mcp-tools.service';
import { AuthService } from '../src/auth/auth.service';
import * as schema from '../src/db/schema';
import { and, eq } from 'drizzle-orm';
import { DB, type Db } from '../src/db/db.module';

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
  await pool.query(
    'drop schema public cascade; create schema public; drop schema if exists drizzle cascade;',
  );
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
    .useFactory({
      factory: (store: SiteSettingsStore) => new TestSiteStorage(store, dir),
      inject: [SiteSettingsStore],
    })
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
  await app.get<TestSiteStorage>(SiteStorage).start();
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
  if (app) await app.get<TestSiteStorage>(SiteStorage).close();
  await app?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe('静态发布与不可变历史版本', () => {
  it('普通成员创建页面无需审批，默认仅登录访问，并自动分配域名', async () => {
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
        (
          await api('POST', '/api/sites/demo/releases', owner, {
            files: [...files('bad'), { path, content: 'bad' }],
          })
        ).status,
      ).toBe(400);
    expect(
      (
        await api('POST', '/api/sites/demo/releases', owner, {
          files: [...files('bad'), { path: 'index.html', content: 'duplicate' }],
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await api('POST', '/api/sites/demo/releases', owner, {
          files: [{ path: 'readme.txt', content: 'no index' }],
        })
      ).status,
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
    const original = storage.putStaging.bind(storage);
    let count = 0;
    const spy = vi.spyOn(storage, 'putStaging').mockImplementation(async (...args) => {
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
        expect(r.headers.location).toContain('/folios/authorize?');
        const returnUrl = new URL(String(r.headers.location)).searchParams.get('returnUrl');
        expect(new URL(returnUrl!).host).toBe(`${version ? 'v1--' : ''}demo.sites.test:3000`);
      }
    const r = await content('/api/users', { version: 1, token: owner });
    expect(r.statusCode).toBe(404);
    expect(r.body).not.toContain('owner@site.test');
  });
  it('登录兑换码绑定域名、单次使用，Cookie 不暴露平台 Token', async () => {
    expect(
      (await api('POST', '/api/sites/demo/authorize', other, { returnUrl: 'http://evil.test/' })).status,
    ).toBe(400);
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
      (
        await api('POST', '/api/sites/demo/threads', undefined, {
          versionId: v1,
          page: '/',
          content: 'anonymous',
        })
      ).status,
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
      (
        await api('GET', '/api/sites/demo/threads', other, undefined, {
          'x-eat-site-access': access.body.accessToken,
        })
      ).status,
    ).toBe(200);
    await api('PATCH', '/api/sites/demo', owner, { password: 'new-password' });
    expect((await content('/app.js', { version: 1, cookie })).statusCode).toBe(403);
    expect((await content('/?eat_access=' + token, { version: 1 })).statusCode).toBe(403);
    expect(
      (
        await api('GET', '/api/sites/demo/threads', other, undefined, {
          'x-eat-site-access': access.body.accessToken,
        })
      ).status,
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
  it('拒绝其他页面的版本、讨论与不存在的 @ 用户', async () => {
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
  it('仅发起人、页面所有者和管理员可解决讨论，发布与回滚不改变讨论状态', async () => {
    expect(
      (await api('PATCH', `/api/sites/demo/threads/${threadId}`, owner, { status: 'resolved' })).status,
    ).toBe(200);
    await api('POST', '/api/sites/demo/activate', owner, { versionId: v2 });
    expect((await api('GET', '/api/sites/demo/threads?status=resolved', owner)).body).toHaveLength(1);
  });
  it('评论登录兑换码只能使用一次，受限会话不能调用平台其他 API，吊销原 Token 后立即失效', async () => {
    const ticket = await api('POST', '/api/sites/demo/comment-ticket', other, {});
    const session = await api('POST', '/api/sites/demo/comment-session', undefined, {
      code: ticket.body.code,
    });
    expect(session.status).toBe(201);
    expect(
      (await api('POST', '/api/sites/demo/comment-session', undefined, { code: ticket.body.code })).status,
    ).toBe(401);
    const headers = { 'x-eat-comment-session': session.body.token };
    expect((await api('GET', '/api/sites/demo/mention-users', undefined, undefined, headers)).status).toBe(
      200,
    );
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
    expect(tools.listTools().some((t) => t.name === 'publish_folio')).toBe(true);
    expect(tools.listTools().some((t) => /(?:^|_)sites?(?:_|$)/.test(t.name))).toBe(false);
    const result = (await tools.call(user, 'list_folio_comments', { folio: 'demo' })) as any[];
    expect(result[0].versionId).toBe(v1);
    await expect(
      tools.call(user, 'publish_folio', { folio: 'demo', files: [{ path: '../index.html', content: 'bad' }] }),
    ).rejects.toThrow();
    const created = (await tools.call(user, 'create_folio_comment', {
      folio: 'demo',
      page: '/',
      versionId: v2,
      content: 'from MCP',
    })) as any;
    expect(created.comments[0].versionId).toBe(v2);
  });
});

describe('评论删除权限与占位', () => {
  let member: string;
  const newThread = async (token: string, content = 'to delete') => {
    const result = await api('POST', '/api/sites/demo/threads', token, {
      versionId: v1,
      page: '/deletion',
      content,
    });
    expect(result.status).toBe(201);
    return result.body;
  };
  beforeAll(async () => {
    member = (
      await api('POST', '/api/auth/login', undefined, { email: 'other@site.test', password: 'password123' })
    ).body.token;
  });
  it('仅作者、页面所有者和管理员获得删除能力，访客和其他成员不能删除', async () => {
    await api('PATCH', '/api/sites/demo', owner, { access: 'public' });
    const t = await newThread(owner);
    const id = t.comments[0].id;
    expect(t.comments[0].canDelete).toBe(true);
    const outsider = (await api('GET', '/api/sites/demo/threads?page=/deletion', member)).body.find(
      (x: any) => x.id === t.id,
    );
    expect(outsider.comments[0].canDelete).toBe(false);
    const anonymous = (await api('GET', '/api/sites/demo/threads?page=/deletion')).body.find(
      (x: any) => x.id === t.id,
    );
    expect(anonymous.comments[0].canDelete).toBe(false);
    expect((await api('DELETE', '/api/sites/demo/comments/' + id)).status).toBe(401);
    expect((await api('DELETE', '/api/sites/demo/comments/' + id, member)).status).toBe(403);
    expect(
      (await api('GET', '/api/sites/demo/threads?page=/deletion', owner)).body.find((x: any) => x.id === t.id)
        .comments[0].content,
    ).toBe('to delete');
  });
  it('作者删除正文与提及，保留别人的回复、版本与锚点', async () => {
    const t = await newThread(member, 'private deleted body');
    const id = t.comments[0].id;
    const reply = await api('POST', `/api/sites/demo/threads/${t.id}/replies`, owner, {
      versionId: v2,
      content: 'keep this reply',
      mentions: [otherId],
    });
    const replyId = reply.body.comments[1].id;
    expect((await api('DELETE', '/api/sites/demo/comments/' + id, member)).status).toBe(200);
    const listed = (await api('GET', '/api/sites/demo/threads?page=/deletion', owner)).body.find(
      (x: any) => x.id === t.id,
    );
    expect(listed.comments[0]).toMatchObject({ content: '', mentions: [], canDelete: false, versionId: v1 });
    expect(listed.comments[0].deletedAt).toEqual(expect.any(String));
    expect(listed.comments[1]).toMatchObject({ id: replyId, content: 'keep this reply', versionId: v2 });
    expect(listed.anchor).toEqual(t.anchor);
    expect(JSON.stringify(listed)).not.toContain('private deleted body');
    expect((await api('DELETE', '/api/sites/demo/comments/' + replyId, member)).status).toBe(403);
    expect((await api('DELETE', '/api/sites/demo/comments/' + replyId, owner)).status).toBe(200);
    expect(
      (await api('GET', '/api/sites/demo/threads?page=/deletion', owner)).body.some(
        (x: any) => x.id === t.id,
      ),
    ).toBe(false);
    const db = app.get<Db>(DB);
    const saved = await db.select().from(schema.siteComments).where(eq(schema.siteComments.threadId, t.id));
    expect(saved).toHaveLength(2);
    expect(saved.every((c) => c.content === '' && c.mentions.length === 0 && c.deletedAt)).toBeTruthy();
    const audit = await db
      .select()
      .from(schema.auditLogs)
      .where(and(eq(schema.auditLogs.action, 'site.comment.deleted'), eq(schema.auditLogs.targetId, id)));
    expect(audit).toHaveLength(1);
    expect(audit[0].actorId).toBe(otherId);
    expect(audit[0].meta).toMatchObject({ threadId: t.id });
    expect(JSON.stringify(audit)).not.toContain('private deleted body');
  });
  it('页面所有者与管理员可以删除成员评论，支持受限评论会话', async () => {
    for (const manager of [owner, admin]) {
      const t = await newThread(member);
      const listed = (await api('GET', '/api/sites/demo/threads?page=/deletion', manager)).body.find(
        (x: any) => x.id === t.id,
      );
      expect(listed.comments[0].canDelete).toBe(true);
      expect((await api('DELETE', '/api/sites/demo/comments/' + t.comments[0].id, manager)).status).toBe(200);
    }
    const t = await newThread(member);
    const ticket = await api('POST', '/api/sites/demo/comment-ticket', member, {});
    const session = await api('POST', '/api/sites/demo/comment-session', undefined, {
      code: ticket.body.code,
    });
    expect(
      (
        await api('DELETE', '/api/sites/demo/comments/' + t.comments[0].id, undefined, undefined, {
          'x-eat-comment-session': session.body.token,
        })
      ).status,
    ).toBe(200);
  });
  it('跨页面、不合法 ID、重复和并发删除不会破坏其他评论', async () => {
    const t = await newThread(member);
    const path = '/api/sites/demo/comments/' + t.comments[0].id;
    expect((await api('DELETE', '/api/sites/second/comments/' + t.comments[0].id, owner)).status).toBe(404);
    expect((await api('DELETE', '/api/sites/demo/comments/not-a-uuid', owner)).status).toBe(400);
    const result = await Promise.all([api('DELETE', path, member), api('DELETE', path, member)]);
    expect(result.map((x) => x.status).sort()).toEqual([200, 404]);
    expect((await api('DELETE', path, member)).status).toBe(404);
    const audit = await app
      .get<Db>(DB)
      .select()
      .from(schema.auditLogs)
      .where(
        and(
          eq(schema.auditLogs.action, 'site.comment.deleted'),
          eq(schema.auditLogs.targetId, t.comments[0].id),
        ),
      );
    expect(audit).toHaveLength(1);
  });
  it('密码页面仍需验证访问权限，HTTP MCP 复用相同删除权限', async () => {
    const t = await newThread(member);
    const id = t.comments[0].id;
    await api('PATCH', '/api/sites/demo', owner, { access: 'password', password: 'delete-password' });
    expect((await api('DELETE', '/api/sites/demo/comments/' + id, member)).status).toBe(403);
    const access = await api('POST', '/api/sites/demo/access', undefined, { password: 'delete-password' });
    const tools = app.get(McpToolsService);
    const actor = (await app.get(AuthService).authenticate(member))!;
    expect(tools.listTools().some((t) => t.name === 'delete_folio_comment')).toBe(true);
    await expect(
      tools.call(actor, 'delete_folio_comment', { folio: 'second', commentId: id }),
    ).rejects.toThrow();
    expect(
      await tools.call(actor, 'delete_folio_comment', {
        folio: 'demo',
        commentId: id,
        accessToken: access.body.accessToken,
      }),
    ).toEqual({ ok: true });
    await api('PATCH', '/api/sites/demo', owner, { access: 'public' });
  });
});

describe('Folio 永久删除', () => {
  it('拒绝匿名、非所有者和仅持有分享凭据的用户，不触碰文件', async () => {
    await api('POST', '/api/sites', owner, {
      slug: 'delete-permission', name: 'Permission', access: 'password', password: 'private',
    });
    const member = (
      await api('POST', '/api/auth/login', undefined, { email: 'other@site.test', password: 'password123' })
    ).body.token;
    const proof = (
      await api('POST', '/api/sites/delete-permission/access', undefined, { password: 'private' })
    ).body.accessToken;
    const storage = vi.spyOn(app.get(SiteStorage), 'discardSite');
    try {
      expect((await api('DELETE', '/api/sites/delete-permission')).status).toBe(401);
      expect(
        (await api('DELETE', '/api/sites/delete-permission', member, undefined, { 'x-eat-site-access': proof })).status,
      ).toBe(403);
      const actor = (await app.get(AuthService).authenticate(member))!;
      await expect(
        app.get(McpToolsService).call(actor, 'delete_folio', { folio: 'delete-permission' }),
      ).rejects.toThrow('仅 Folio 所有者或管理员');
      expect(storage).not.toHaveBeenCalled();
      expect((await api('GET', '/api/sites/delete-permission', owner)).status).toBe(200);
    } finally {
      storage.mockRestore();
    }
  });

  it('清理全部历史文件、讨论、回复和会话，使旧链接和凭据失效，不影响其他 Folio', async () => {
    const created = await api('POST', '/api/sites', owner, {
      slug: 'delete-full', name: 'Delete', access: 'password', password: 'private',
    });
    const id = created.body.id;
    const first = (
      await api('POST', '/api/sites/delete-full/releases', owner, { files: files('delete v1') })
    ).body;
    const second = (
      await api('POST', '/api/sites/delete-full/releases', owner, { files: files('delete v2') })
    ).body;
    const thread = (
      await api('POST', '/api/sites/delete-full/threads', owner, {
        versionId: first.id, page: '/', content: 'first',
      })
    ).body;
    await api('POST', `/api/sites/delete-full/threads/${thread.id}/replies`, admin, {
      versionId: second.id, content: 'reply',
    });
    await api('POST', '/api/sites/delete-full/comment-ticket', owner, {});
    const share = (await api('POST', '/api/sites/delete-full/share', owner, {})).body;
    const db = app.get<Db>(DB);
    expect(await db.select().from(schema.siteSessions).where(eq(schema.siteSessions.siteId, id))).toHaveLength(1);
    expect((await api('DELETE', '/api/sites/delete-full', owner)).body).toEqual({ ok: true, cleanupFailed: false });
    expect(await db.select().from(schema.sites).where(eq(schema.sites.id, id))).toHaveLength(0);
    expect(await db.select().from(schema.siteVersions).where(eq(schema.siteVersions.siteId, id))).toHaveLength(0);
    expect(await db.select().from(schema.siteThreads).where(eq(schema.siteThreads.siteId, id))).toHaveLength(0);
    expect(
      await db.select().from(schema.siteComments).where(eq(schema.siteComments.threadId, thread.id)),
    ).toHaveLength(0);
    expect(await db.select().from(schema.siteSessions).where(eq(schema.siteSessions.siteId, id))).toHaveLength(0);
    await expect(access(app.get<TestSiteStorage>(SiteStorage).file(`sites/${id}`))).rejects.toThrow();
    expect(await db.select().from(schema.siteBlobs).where(eq(schema.siteBlobs.siteId, id))).toHaveLength(0);
    expect(await db.select().from(schema.siteUploads).where(eq(schema.siteUploads.siteId, id))).toHaveLength(0);
    for (const version of [first, second]) {
      expect(
        (await content('/', { site: 'delete-full', version: version.number, token: owner })).statusCode,
      ).toBe(404);
    }
    expect((await content('/', { site: 'delete-full', token: owner })).statusCode).toBe(404);
    expect((await api('GET', '/api/sites/delete-full/threads', owner)).status).toBe(404);
    expect((await api('GET', '/api/sites', owner)).body.some((s: any) => s.id === id)).toBe(false);
    expect((await api('DELETE', '/api/sites/delete-full', owner)).status).toBe(404);
    const audit = await db
      .select().from(schema.auditLogs)
      .where(and(eq(schema.auditLogs.action, 'site.deleted'), eq(schema.auditLogs.targetId, id)));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorId: ownerId, meta: { slug: 'delete-full', versionCount: 2 } });
    expect((await content('/', { site: 'demo', token: owner })).statusCode).toBe(200);
    const recreated = await api('POST', '/api/sites', owner, {
      slug: 'delete-full', name: 'New', access: 'password', password: 'private',
    });
    expect(recreated.body.id).not.toBe(id);
    const accessToken = new URL(share.url).searchParams.get('eat_access');
    expect(accessToken).toBeTruthy();
    expect((await api('POST', '/api/sites/delete-full/access', undefined, { accessToken })).status).toBe(403);
  });

  it('管理员可通过 HTTP MCP 删除他人未发布的 Folio', async () => {
    const actor = (await app.get(AuthService).authenticate(admin))!;
    const tools = app.get(McpToolsService);
    expect(tools.listTools().some((t) => t.name === 'delete_folio')).toBe(true);
    expect(await tools.call(actor, 'delete_folio', { folio: 'delete-permission' })).toEqual({
      ok: true, cleanupFailed: false,
    });
    expect((await api('GET', '/api/sites/delete-permission', owner)).status).toBe(404);
    await expect(tools.call(actor, 'delete_folio', { folio: '../invalid' })).rejects.toThrow('工具参数不合法');
  });

  it('整站前缀清理失败仍撤销访问，并保留重试记录和失败审计', async () => {
    const created = (
      await api('POST', '/api/sites', owner, { slug: 'delete-storage-failure', name: 'Failure' })
    ).body;
    await api('POST', '/api/sites/delete-storage-failure/releases', owner, { files: files('first') });
    await api('POST', '/api/sites/delete-storage-failure/releases', owner, { files: files('second') });
    const storage = vi.spyOn(app.get(SiteStorage), 'discardSite')
      .mockRejectedValueOnce(new Error('storage unavailable'));
    try {
      const result = await api('DELETE', '/api/sites/delete-storage-failure', owner);
      expect(result.status).toBe(200);
      expect(result.body).toEqual({ ok: true, cleanupFailed: true });
      expect(storage).toHaveBeenCalledTimes(1);
      expect((await content('/', { site: 'delete-storage-failure', token: owner })).statusCode).toBe(404);
      const logs = await app.get<Db>(DB)
        .select().from(schema.auditLogs)
        .where(and(
          eq(schema.auditLogs.action, 'site.storage_cleanup_failed'),
          eq(schema.auditLogs.targetId, created.id),
        ));
      expect(logs).toHaveLength(1);
      expect(logs[0].meta).toMatchObject({
        slug: 'delete-storage-failure',
      });
    } finally {
      storage.mockRestore();
    }
  });

  it('上传途中删除 Folio 后拒绝激活新版本并清理未完成的文件', async () => {
    const created = (
      await api('POST', '/api/sites', owner, { slug: 'delete-during-publish', name: 'Race' })
    ).body;
    const storage = app.get(SiteStorage);
    const put = storage.putStaging.bind(storage);
    let uploaded!: () => void;
    let resume!: () => void;
    const ready = new Promise<void>((resolve) => {
      uploaded = resolve;
    });
    const paused = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const spy = vi.spyOn(storage, 'putStaging').mockImplementation(async (...args) => {
      await put(...args);
      uploaded();
      await paused;
    });
    const publishing = api('POST', '/api/sites/delete-during-publish/releases', owner, {
      files: [{ path: 'index.html', content: 'in flight' }],
    });
    try {
      await ready;
      expect((await api('DELETE', '/api/sites/delete-during-publish', owner)).status).toBe(200);
      resume();
      const result = await publishing;
      expect(result.status).toBe(404);
      expect(result.body.message).toContain('不存在');
      await expect(access(app.get<TestSiteStorage>(SiteStorage).file(`sites/${created.id}`))).rejects.toThrow();
      expect(
        await app.get<Db>(DB).select().from(schema.siteVersions).where(eq(schema.siteVersions.siteId, created.id)),
      ).toHaveLength(0);
    } finally {
      resume();
      await publishing;
      spy.mockRestore();
    }
  });

  it('并发删除只有一次成功和一条删除审计', async () => {
    const created = (
      await api('POST', '/api/sites', owner, { slug: 'delete-twice', name: 'Twice' })
    ).body;
    const actor = (await app.get(AuthService).authenticate(owner))!;
    const service = app.get(SitesService);
    const result = await Promise.allSettled([
      service.remove(actor, 'delete-twice'), service.remove(actor, 'delete-twice'),
    ]);
    expect(result.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const failed = result.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(failed.reason.getStatus()).toBe(404);
    const audit = await app.get<Db>(DB)
      .select().from(schema.auditLogs)
      .where(and(eq(schema.auditLogs.action, 'site.deleted'), eq(schema.auditLogs.targetId, created.id)));
    expect(audit).toHaveLength(1);
  });
});

function binaryFile(path: string, text: string | Buffer): FolioUploadFile {
  const bytes = Buffer.from(text);
  return { path, bytes, size: bytes.length, type: siteContentType(path), hash: createHash('sha256').update(bytes).digest('hex') };
}
async function uploadPlan(slug: string, files: FolioUploadFile[], requestId = randomUUID()) {
  return api('POST', `/api/sites/${slug}/uploads`, owner,
    { requestId, files: files.map(({ bytes: _, ...f }) => f), message: 'direct' });
}
async function putPlan(plan: any, files: FolioUploadFile[]) {
  for (const target of plan.uploads) {
    const response = await fetch(target.url, { method: 'PUT', headers: target.headers,
      body: files.find((f) => f.hash === target.hash)!.bytes as Buffer });
    expect(response.status).toBe(200);
  }
}
const complete = (slug: string, id: string, token = owner) => api('POST', `/api/sites/${slug}/uploads/${id}/complete`, token, {});

describe('二进制直传、共享内容和持久化会话', () => {
  it('首发、仅增量上传、相同内容的路径 MIME、完整清单删除及固定版本/回滚', async () => {
    await api('POST', '/api/sites', owner, { slug: 'direct', name: 'Direct' });
    const files = [binaryFile('index.html', '<body>one</body>'), binaryFile('logo.png', 'same'), binaryFile('copy.txt', 'same')];
    const requestId = randomUUID();
    const plan = await uploadPlan('direct', files, requestId);
    expect(plan.status).toBe(201);
    expect(plan.body.uploads).toHaveLength(2);
    expect((await uploadPlan('direct', files, requestId)).body.id).toBe(plan.body.id);
    expect((await uploadPlan('direct', [binaryFile('index.html', 'changed')], requestId)).status).toBe(409);
    await putPlan(plan.body, files);
    const first = await complete('direct', plan.body.id);
    expect(first.status).toBe(201);
    expect(first.body.totalBytes).toBe(files.reduce((n, f) => n + f.size, 0));
    const [storedVersion] = await app.get<Db>(DB).select().from(schema.siteVersions).where(eq(schema.siteVersions.id, first.body.id));
    expect(storedVersion.layout).toBe('blobs-v1');
    expect(storedVersion.manifest['index.html'].hash).toBe(files[0].hash);
    const read = (path: string, version?: number) => content(path, { site: 'direct', token: owner, version });
    expect((await read('/logo.png')).headers['content-type']).toBe('image/png');
    expect((await read('/copy.txt')).headers['content-type']).toContain('text/plain');
    const next = [binaryFile('index.html', '<body>two</body>'), files[1]];
    const secondPlan = await uploadPlan('direct', next);
    expect(secondPlan.body.uploads).toHaveLength(1);
    await putPlan(secondPlan.body, next);
    const second = await complete('direct', secondPlan.body.id);
    expect(second.status).toBe(201);
    expect((await read('/copy.txt')).statusCode).toBe(404);
    expect((await read('/copy.txt', 1)).body).toBe('same');
    expect((await read('/', 1)).body).toContain('one');
    const unchanged = await uploadPlan('direct', next);
    expect(unchanged.body.uploads).toHaveLength(0);
    expect((await complete('direct', unchanged.body.id)).body.number).toBe(3);
    expect((await complete('direct', secondPlan.body.id)).body).toEqual(second.body);
    await api('POST', '/api/sites/direct/activate', owner, { versionId: first.body.id });
    expect((await read('/')).body).toContain('one');
    expect((await read('/', 2)).body).toContain('two');
  });

  it('非法清单、逻辑总量/数量限制、对象缺失、大小及 SHA-256 错误均不能激活', async () => {
    await api('POST', '/api/sites', owner, { slug: 'bad-direct', name: 'Bad' });
    const valid = binaryFile('index.html', 'correct');
    const invalid = [
      [{ ...valid, path: '../index.html' }], [{ ...valid, hash: 'BAD' }], [valid, valid],
      [valid, { ...valid, path: 'index.html/file' }], [{ ...valid, path: 'no-index' }],
      [{ ...valid, size: 30 * 1024 * 1024 }, { ...valid, path: 'a', size: 30 * 1024 * 1024 }],
      Array.from({ length: 2001 }, (_, i) => ({ ...valid, path: i ? `${i}.txt` : 'index.html' })),
    ];
    for (const files of invalid) expect((await uploadPlan('bad-direct', files)).status).toBe(400);
    const missing = (await uploadPlan('bad-direct', [valid])).body;
    expect((await complete('bad-direct', missing.id)).status).toBe(400);
    await fetch(missing.uploads[0].url, { method: 'PUT', headers: missing.uploads[0].headers, body: 'wrong!!' });
    expect((await complete('bad-direct', missing.id)).status).toBe(400);
    await fetch(missing.uploads[0].url, { method: 'PUT', headers: missing.uploads[0].headers, body: 'short' });
    expect((await complete('bad-direct', missing.id)).status).toBe(400);
    expect((await api('GET', '/api/sites/bad-direct', owner)).body.currentVersionId).toBeNull();
    await putPlan(missing, [valid]);
    expect((await complete('bad-direct', missing.id)).status).toBe(201);
  });

  it('旧签名重放和验证时改写 staging 无法改变快照或已发布字节', async () => {
    await api('POST', '/api/sites', owner, { slug: 'replay', name: 'Replay' });
    const files = [binaryFile('index.html', '<body>verified</body>')];
    const plan = (await uploadPlan('replay', files)).body;
    await putPlan(plan, files);
    const storage = app.get<TestSiteStorage>(SiteStorage);
    const snapshot = storage.snapshot.bind(storage);
    const hook = vi.spyOn(storage, 'snapshot').mockImplementation(async (...args) => {
      const result = await snapshot(...args);
      await storage.putStaging(args[0], args[1], args[2], Buffer.from('malicious replacement'));
      return result;
    });
    try { expect((await complete('replay', plan.id)).status).toBe(201); }
    finally { hook.mockRestore(); }
    await fetch(plan.uploads[0].url, { method: 'PUT', headers: plan.uploads[0].headers, body: 'later rewrite' });
    expect((await content('/', { site: 'replay', token: owner })).body).toContain('verified');
    expect((await complete('replay', plan.id)).body.number).toBe(1);
  });

  it('跨会话相同内容并发封存、并发完成和响应丢失重试只提交一次', async () => {
    await api('POST', '/api/sites', owner, { slug: 'concurrent-direct', name: 'Concurrent' });
    const files = [binaryFile('index.html', '<body>concurrent</body>')];
    const plans = await Promise.all([uploadPlan('concurrent-direct', files), uploadPlan('concurrent-direct', files)]);
    await Promise.all(plans.map((p) => putPlan(p.body, files)));
    const results = await Promise.all([complete('concurrent-direct', plans[0].body.id), complete('concurrent-direct', plans[0].body.id), complete('concurrent-direct', plans[1].body.id)]);
    expect(results.every((r) => r.status === 201 || r.status === 409)).toBe(true);
    const retries = await Promise.all(plans.map((p) => complete('concurrent-direct', p.body.id)));
    expect(retries.every((r) => r.status === 201)).toBe(true);
    expect(new Set(retries.map((r) => r.body.number)).size).toBe(2);
    expect((await api('GET', '/api/sites/concurrent-direct/versions', owner)).body).toHaveLength(2);
    const site = await app.get(SitesService).get('concurrent-direct');
    expect(await app.get<Db>(DB).select().from(schema.siteBlobs).where(eq(schema.siteBlobs.siteId, site.id))).toHaveLength(1);
  });

  it('中断、续签、租约过期后的进程恢复，以及 DB 提交失败后的恢复', async () => {
    await api('POST', '/api/sites', owner, { slug: 'resume-direct', name: 'Resume' });
    const files = [binaryFile('index.html', '<body>resume</body>')];
    const plan = (await uploadPlan('resume-direct', files)).body;
    const db = app.get<Db>(DB);
    await db.update(schema.siteUploads).set({ state: 'verifying', lease: randomUUID(), leaseUntil: new Date(0) }).where(eq(schema.siteUploads.id, plan.id));
    const renewed = await api('POST', `/api/sites/resume-direct/uploads/${plan.id}/renew`, owner, {});
    expect(renewed.body.uploads).toHaveLength(1);
    const expiredURL = new URL(plan.uploads[0].url); expiredURL.searchParams.set('expires', '0');
    expect((await fetch(expiredURL, { method: 'PUT', headers: plan.uploads[0].headers, body: 'x' })).status).toBe(403);
    await putPlan(renewed.body, files);
    const actor = (await app.get(AuthService).authenticate(owner))!;
    const recreated = new SitesService(db, app.get(SiteStorage), app.get(AuditService), app.get(SiteRuntime));
    const failure = vi.spyOn(db, 'transaction').mockRejectedValueOnce(new Error('simulated DB commit failure'));
    await expect(recreated.completeUpload(actor, 'resume-direct', plan.id)).rejects.toThrow('DB commit failure');
    failure.mockRestore();
    expect((await api('GET', '/api/sites/resume-direct', owner)).body.currentVersionId).toBeNull();
    const result = await recreated.completeUpload(actor, 'resume-direct', plan.id);
    expect(result.number).toBe(1);
    expect((await api('GET', `/api/sites/resume-direct/uploads/${plan.id}`, owner)).body.result).toEqual(result);
    expect((await complete('resume-direct', plan.id)).body).toEqual(result);
  });

  it('上传中停用、撤销权限和删除均不能提交，跨 Folio/用户会话拒绝访问', async () => {
    const db = app.get<Db>(DB);
    const storage = app.get<TestSiteStorage>(SiteStorage);
    const member = (await api('POST', '/api/auth/login', undefined, { email: 'other@site.test', password: 'password123' })).body.token;
    for (const kind of ['disabled', 'revoked', 'deleted']) {
      const slug = 'during-' + kind;
      const site = (await api('POST', '/api/sites', owner, { slug, name: kind })).body;
      const files = [binaryFile('index.html', kind)];
      const plan = (await uploadPlan(slug, files)).body;
      expect((await api('GET', `/api/sites/demo/uploads/${plan.id}`, owner)).status).toBe(404);
      expect((await api('GET', `/api/sites/${slug}/uploads/${plan.id}`, member)).status).toBe(403);
      expect((await complete(slug, plan.id, member)).status).toBe(403);
      await putPlan(plan, files);
      const seal = storage.verifyAndSeal.bind(storage);
      const hook = vi.spyOn(storage, 'verifyAndSeal').mockImplementation(async (...args) => {
        await seal(...args);
        if (kind === 'disabled') await db.update(schema.siteSettings).set({ status: 'disabled' });
        if (kind === 'revoked') await db.update(schema.sites).set({ ownerId: otherId }).where(eq(schema.sites.id, site.id));
        if (kind === 'deleted') await api('DELETE', `/api/sites/${slug}`, owner);
      });
      try { expect((await complete(slug, plan.id)).status).toBe(kind === 'disabled' ? 503 : kind === 'revoked' ? 403 : 404); }
      finally { hook.mockRestore(); await db.update(schema.siteSettings).set({ status: 'enabled' }); }
      expect(await db.select().from(schema.siteVersions).where(eq(schema.siteVersions.siteId, site.id))).toHaveLength(0);
      if (kind === 'deleted') {
        expect((await api('POST', `/api/sites/${slug}/uploads/${plan.id}/renew`, owner, {})).status).toBe(404);
        await fetch(plan.uploads[0].url, { method: 'PUT', headers: plan.uploads[0].headers, body: 'late' });
        await db.update(schema.siteCleanups).set({ notBefore: new Date(0) }).where(eq(schema.siteCleanups.siteId, site.id));
        await app.get(SitesService).cleanupDeletedSites();
        await expect(access(storage.file(`sites/${site.id}`))).rejects.toThrow();
      }
    }
  });

  it('数百个文件通过共用上传器和真实 HTTP PUT；有界并发及退避重试', async () => {
    await api('POST', '/api/sites', owner, { slug: 'many-direct', name: 'Many' });
    const files = [binaryFile('index.html', '<body>many</body>'), ...Array.from({ length: 350 }, (_, i) => binaryFile(`assets/${i}.txt`, `file ${i}`))];
    const storage = app.get<TestSiteStorage>(SiteStorage);
    storage.maxActive = 0; storage.failPuts = 2;
    const before = storage.puts;
    const progress: string[] = [];
    const rssBefore = process.memoryUsage().rss;
    let peakRss = rssBefore;
    const sampling = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 10);
    const result = await uploadFolioFiles(async (method, path, payload) => {
      const response = await api(method as 'POST', path, owner, payload);
      if (response.status >= 400) throw Object.assign(new Error(response.body.message), { status: response.status, code: response.body.error });
      return response.body;
    }, 'many-direct', files, { requestId: randomUUID(), onProgress: (s) => progress.push(s) }).finally(() => clearInterval(sampling));
    expect(result.fileCount).toBe(351);
    expect(storage.puts - before).toBe(351);
    expect(storage.maxActive).toBeLessThanOrEqual(4);
    const rssGrowth = Math.max(0, peakRss - rssBefore);
    expect(rssGrowth).toBeLessThan(128 * 1024 * 1024);
    console.log(`351 文件集成场景：最大 PUT 并发 ${storage.maxActive}，本地同进程 RSS 增长 ${(rssGrowth / 1024 / 1024).toFixed(1)} MiB`);
    expect(progress.some((s) => s.includes('SHA-256'))).toBe(true);
  });

  it('2000 个合法长 Unicode 路径的清单超过默认 JSON 大小仍可准备，重复内容只签一次', async () => {
    await api('POST', '/api/sites', owner, { slug: 'large-manifest', name: 'Large manifest' });
    const empty = binaryFile('index.html', '');
    const files = [empty, ...Array.from({ length: 1999 }, (_, i) => ({ ...empty, path: '层'.repeat(495) + '/' + i + '.txt', type: 'text/plain' }))];
    const result = await uploadPlan('large-manifest', files);
    expect(result.status).toBe(201);
    expect(result.body.uploads).toHaveLength(1);
  });
  it('会话过期/有效租约明确拒绝完成；正式对象丢失时重新上传验证', async () => {
    await api('POST', '/api/sites', owner, { slug: 'expiry-direct', name: 'Expiry' });
    const files = [binaryFile('index.html', 'expiry test')];
    const plan = (await uploadPlan('expiry-direct', files)).body;
    const db = app.get<Db>(DB);
    await db.update(schema.siteUploads).set({ state: 'verifying', lease: randomUUID(), leaseUntil: new Date(Date.now() + 600000) }).where(eq(schema.siteUploads.id, plan.id));
    const busy = await complete('expiry-direct', plan.id);
    expect(busy.status).toBe(409); expect(busy.body.error).toBe('UPLOAD_BUSY');
    await db.update(schema.siteUploads).set({ expiresAt: new Date(0) }).where(eq(schema.siteUploads.id, plan.id));
    expect((await complete('expiry-direct', plan.id)).status).toBe(400);
    expect((await api('GET', `/api/sites/expiry-direct/uploads/${plan.id}`, owner)).body.state).toBe('expired');
    expect((await api('POST', `/api/sites/expiry-direct/uploads/${plan.id}/renew`, owner, {})).body.uploads).toHaveLength(0);
    const fresh = (await uploadPlan('expiry-direct', files)).body;
    await putPlan(fresh, files); expect((await complete('expiry-direct', fresh.id)).status).toBe(201);
    const site = await app.get(SitesService).get('expiry-direct');
    const storage = app.get<TestSiteStorage>(SiteStorage);
    await rm(storage.file(storage.blobKey(site.id, files[0].hash)));
    const repair = (await uploadPlan('expiry-direct', files)).body;
    expect(repair.uploads).toHaveLength(1);
    await putPlan(repair, files); expect((await complete('expiry-direct', repair.id)).status).toBe(201);
    expect((await content('/', { site: 'expiry-direct', token: owner })).body).toContain('expiry test');
  });
  it('MCP 会话与内联输入共用封存及幂等提交；至少 5 MiB Base64 不再栈溢出', async () => {
    await api('POST', '/api/sites', owner, { slug: 'mcp-direct', name: 'MCP' });
    const tools = app.get(McpToolsService);
    const actor = (await app.get(AuthService).authenticate(owner))!;
    const files = [binaryFile('index.html', 'mcp session')];
    const plan = await tools.call(actor, 'prepare_folio_upload', { folio: 'mcp-direct', requestId: randomUUID(), files: files.map(({ bytes: _, ...f }) => f) }) as any;
    await putPlan(plan, files);
    const result = await tools.call(actor, 'complete_folio_upload', { folio: 'mcp-direct', uploadId: plan.id });
    expect(await tools.call(actor, 'complete_folio_upload', { folio: 'mcp-direct', uploadId: plan.id })).toEqual(result);
    const bytes = Buffer.alloc(5 * 1024 * 1024, 0xa5);
    const payload = [{ path: 'index.html', content: '<body>large</body>' }, { path: 'big.bin', encoding: 'base64', content: bytes.toString('base64') }];
    const published = await api('POST', '/api/sites/mcp-direct/releases', owner, { files: payload });
    expect(published.status).toBe(201);
    const [inlineVersion] = await app.get<Db>(DB).select().from(schema.siteVersions).where(eq(schema.siteVersions.id, published.body.id));
    expect(inlineVersion.layout).toBe('blobs-v1');
    expect(inlineVersion.manifest['big.bin'].hash).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect((await content('/big.bin', { site: 'mcp-direct', token: owner })).rawPayload).toEqual(bytes);
    for (const content of ['abc', 'ab==', 'AAAA====', bytes.toString('base64') + '!']) {
      expect((await api('POST', '/api/sites/mcp-direct/releases', owner, { files: [{ path: 'index.html', encoding: 'base64', content }] })).status).toBe(400);
    }
  });
});
