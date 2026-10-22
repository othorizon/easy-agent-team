import { createHash } from 'node:crypto';
import { UnauthorizedException } from '@nestjs/common';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthService } from '../src/auth/auth.service';
import type { SiteCommentsService } from '../src/sites/site-comments.service';
import type { SiteRuntime } from '../src/sites/site-config';
import type { SiteCdnCache } from '../src/sites/site-cdn-cache.service';
import { SiteGateway } from '../src/sites/site-gateway.service';
import type { SiteStorage } from '../src/sites/site-storage.service';
import { SitesController } from '../src/sites/sites.controller';
import type { SitesService } from '../src/sites/sites.service';

const domain = 'sites.example.com';
const versionId = (number: number) => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const fileHash = (number: number, path: string) => createHash('sha256').update(`${number}:${path}`).digest('hex');
const versions = [1, 2].map((number) => ({
  id: versionId(number),
  number,
  layout: 'blobs-v1',
  manifest: {
    'index.html': { hash: fileHash(number, 'index.html'), type: 'text/html; charset=utf-8' },
    'app.js': { hash: fileHash(number, 'app.js'), type: 'text/javascript; charset=utf-8' },
    'about/index.html': { hash: fileHash(number, 'about/index.html'), type: 'text/html; charset=utf-8' },
  },
}));
const site = { id: 'site-id', slug: 'demo', name: 'Demo', access: 'public', currentVersionId: versionId(1), spa: false, commentsEnabled: true };
const sites = {
  get: vi.fn(async () => site),
  version: vi.fn(async (_site: unknown, id?: string, number?: number) =>
    versions.find((v) => (number === undefined ? v.id === (id ?? site.currentVersionId) : v.number === number)),
  ),
  session: vi.fn(async () => null),
  assertView: vi.fn(() => {
    if (site.access !== 'public') throw new UnauthorizedException('请先登录 EAT');
  }),
  proof: vi.fn(() => 'site-proof'),
  unlock: vi.fn(),
  newSession: vi.fn(async () => 'site-session'),
};
const storage = {
  getBlob: vi.fn(async (_site: string, hash: string) => {
    for (const version of versions) for (const [path, file] of Object.entries(version.manifest)) {
      if (file.hash === hash)
        return Buffer.from(path.endsWith('.html') ? `<body>page ${version.id}</body>` : `resource ${version.id}`);
    }
    throw new Error('不存在的内容哈希');
  }),
};
const runtime = {
  settings: { row: async () => ({ status: 'enabled', domain }) },
  url: async (slug: string, version?: number) => `https://${version ? `v${version}--` : ''}${slug}.${domain}`,
  platform: async () => 'https://eat.example.com',
};
const auth = { authenticate: vi.fn(async () => null) };
const gateway = new SiteGateway(
  sites as unknown as SitesService,
  storage as unknown as SiteStorage,
  auth as unknown as AuthService,
  runtime as unknown as SiteRuntime,
  {probe:async()=>null, redirect:async()=>null} as unknown as SiteCdnCache,
);
let app: ReturnType<typeof Fastify>;

beforeEach(() => {
  vi.clearAllMocks();
  site.currentVersionId = versionId(1);
  site.access = 'public';
  site.spa = false;
  app = Fastify();
  app.addHook('onRequest', (req: FastifyRequest, reply: FastifyReply) => gateway.handle(req, reply));
});
afterEach(async () => {
  await app.close();
});
function get(path = '/', version?: number, method: 'GET' | 'HEAD' = 'GET') {
  return app.inject({ method, url: path, headers: { host: `${version ? `v${version}--` : ''}demo.${domain}` } });
}

describe('固定域名直接提供当前版本', () => {
  it('HTML、资源与 HEAD 均直接返回，评论配置保留实际浏览版本', async () => {
    const page = await get('/?preview=1');
    expect(page.statusCode).toBe(200);
    expect(page.headers.location).toBeUndefined();
    expect(page.headers['cache-control']).toBe('private, no-store');
    expect(page.headers['x-eat-site-version']).toBe(versionId(1));
    const config = JSON.parse(Buffer.from(/data-eat="([^"]+)"/.exec(page.body)![1], 'base64').toString());
    expect(config.versionId).toBe(versionId(1));
    expect(config.versionNumber).toBe(1);
    const resource = await get('/app.js');
    expect(resource.statusCode).toBe(200);
    expect(resource.headers.location).toBeUndefined();
    expect(resource.body).toBe(`resource ${versionId(1)}`);
    expect(storage.getBlob).toHaveBeenCalledWith(site.id, fileHash(1, 'app.js'));
    const head = await get('/', undefined, 'HEAD');
    expect(head.statusCode).toBe(200);
    expect(head.headers.location).toBeUndefined();
    expect(head.headers['x-eat-site-version']).toBe(versionId(1));
    expect(head.body).toBe('');
  });

  it('不支持的版本布局直接拒绝，不回退版本目录', async () => {
    sites.version.mockResolvedValueOnce({ ...versions[0], layout: 'legacy-v0' });
    const response = await get('/');
    expect(response.statusCode).toBe(503);
    expect(storage.getBlob).not.toHaveBeenCalled();
  });

  it('新发布和回滚更新固定入口，历史域名保持原快照', async () => {
    site.currentVersionId = versionId(2);
    expect((await get('/')).headers['x-eat-site-version']).toBe(versionId(2));
    expect((await get('/app.js')).body).toBe(`resource ${versionId(2)}`);
    expect((await get('/', 1)).headers['x-eat-site-version']).toBe(versionId(1));
    expect((await get('/app.js', 1)).body).toBe(`resource ${versionId(1)}`);
    site.currentVersionId = versionId(1);
    expect((await get('/')).headers['x-eat-site-version']).toBe(versionId(1));
    expect((await get('/', 2)).headers['x-eat-site-version']).toBe(versionId(2));
  });

  it('目录补斜杠保留路径和查询，SPA 路由仍在固定域名提供', async () => {
    expect((await get('/about?view=full')).headers.location).toBe('/about/?view=full');
    expect((await get('/about/')).statusCode).toBe(200);
    site.spa = true;
    const spa = await get('/projects/42?view=full');
    expect(spa.statusCode).toBe(200);
    expect(spa.headers.location).toBeUndefined();
    expect(spa.body).toContain(`page ${versionId(1)}`);
  });

  it('登录回跳仍指向原固定域名，未登录资源继续受保护', async () => {
    site.access = 'authenticated';
    const page = await get('/about/?view=full');
    const authorize = new URL(String(page.headers.location));
    expect(page.statusCode).toBe(302);
    expect(authorize.origin).toBe('https://eat.example.com');
    expect(authorize.searchParams.get('returnUrl')).toBe('https://demo.sites.example.com/about/?view=full');
    expect((await get('/app.js')).headers.location).toContain('/folios/authorize?');
  });

  it('密码分享凭据清除时保持固定域名，验证密码使用该域名的来源', async () => {
    site.access = 'password';
    const visit = await get('/about/?eat_access=share-proof&view=full');
    expect(visit.statusCode).toBe(302);
    expect(visit.headers.location).toBe('/about/?view=full');
    expect(visit.headers['set-cookie']).toContain('eat_site=site-session;');
    expect(sites.newSession).toHaveBeenCalledWith(site, 'view', null, 'demo.sites.example.com');
    const access = await app.inject({
      method: 'POST',
      url: '/__eat/access',
      headers: { host: 'demo.sites.example.com', origin: 'https://demo.sites.example.com' },
      payload: { password: 'test-password' },
    });
    expect(access.statusCode).toBe(200);
  });
});

describe('评论 iframe 的固定域名与版本域名校验', () => {
  const controller = new SitesController(
    sites as unknown as SitesService,
    {} as SiteCommentsService,
    auth as unknown as AuthService,
    runtime as unknown as SiteRuntime,
  {probe:async()=>null, redirect:async()=>null} as unknown as SiteCdnCache,
  );
  it('固定域名已打开的旧页面，在新版本发布后仍使用原浏览版本', async () => {
    site.currentVersionId = versionId(2);
    const origin = 'https://demo.sites.example.com';
    expect(await controller.embedOrigin('demo', { versionId: versionId(1), origin })).toEqual({ origin });
    expect(await controller.embedOrigin('demo', { versionId: versionId(1) })).toEqual({
      origin: 'https://v1--demo.sites.example.com',
    });
  });
  it('拒绝其他网站、其他版本、错误协议和带路径的来源', async () => {
    for (const origin of [
      'https://evil.example.com',
      'https://other.sites.example.com',
      'https://v2--demo.sites.example.com',
      'http://demo.sites.example.com',
      'https://demo.sites.example.com/path',
    ])
      await expect(controller.embedOrigin('demo', { versionId: versionId(1), origin })).rejects.toThrow('页面来源不合法');
  });
});
