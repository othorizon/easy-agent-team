process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://dev:dev@127.0.0.1:5433/eat_test';
process.env.EAT_PUBLIC_URL = 'https://eat.test';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { resolve } from 'node:path';
import * as bcrypt from 'bcryptjs';
import { parse, stringify } from 'yaml';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { AppModule } from '../src/app.module';
import * as schema from '../src/db/schema';
import { DB, type Db } from '../src/db/db.module';
import { encryptSecret } from '../src/common/crypto';
import { SiteInfrastructure, siteResource, siteProbeHost } from '../src/sites/site-infrastructure.service';
import { SiteDns, SiteSetupError } from '../src/sites/site-dns.service';
import { SiteSettingsStore } from '../src/sites/site-settings.store';
import { FolioToolsService } from '../src/sites/folio-tools.service';
import { AuthService } from '../src/auth/auth.service';
import { SiteSetupService } from '../src/sites/site-setup.service';

let app: NestFastifyApplication, backend: Server, admin: string, member: string, db: Db;
let env = 'UNRELATED=keep-me';
let writes: string[] = [];
const files = new Map<string, string>();
const main = '/etc/dokploy/traefik/traefik.yml';
const baseConfig = {
  entryPoints: { web: { address: ':80' }, websecure: { address: ':443' } },
  providers: { file: { directory: '/etc/dokploy/traefik/dynamic', watch: true } },
  certificatesResolvers: {
    other: { acme: { email: 'other@example.com', httpChallenge: { entryPoint: 'web' }, storage: '/other/acme.json' } },
  },
};
const oss = vi.fn().mockResolvedValue(undefined),
  dns = vi.fn().mockResolvedValue(undefined);
const permissions = vi.fn().mockResolvedValue(undefined);
let failHttps = false,
  holdVerify: Promise<void> | undefined,
  releaseVerify: (() => void) | undefined;
const values = {
  domain: 'sites.example.com',
  ossRegion: 'oss-cn-hangzhou',
  ossBucket: 'eat-sites',
  ossAccessKeyId: 'oss-key-id',
  ossAccessKeySecret: 'oss-private-value',
  tlsMode: 'alidns',
  acmeEmail: 'admin@example.com',
  dnsAccessKeyId: 'dns-key-id',
  dnsAccessKeySecret: 'dns-private-value',
  platformApplicationId: 'eat-app',
  upstreamPort: 3000,
  gatewayTarget: '203.0.113.10',
};
async function api(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, token?: string, payload?: unknown) {
  const r = await app.inject({
    method,
    url,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    payload: payload as never,
  });
  return { status: r.statusCode, body: JSON.parse(r.body) };
}
async function settled() {
  for (let i = 0; i < 200; i++) {
    const result = await api('GET', '/api/admin/site-settings', admin);
    if (!['checking', 'provisioning', 'verifying', 'disabling'].includes(result.body.status)) return result.body;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('setup did not settle');
}
beforeAll(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await pool.query('drop schema public cascade; create schema public; drop schema if exists drizzle cascade;');
  await migrate(drizzle(pool), { migrationsFolder: resolve('drizzle') });
  const seed = drizzle(pool, { schema });
  const passwordHash = await bcrypt.hash('password123', 4);
  await seed.insert(schema.users).values([
    { name: 'Admin', email: 'admin@settings.test', passwordHash, role: 'admin' },
    { name: 'Member', email: 'member@settings.test', passwordHash },
  ]);
  files.set(main, stringify(baseConfig));
  backend = createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://localhost');
    let text = '';
    for await (const c of req) text += c;
    const body = text ? JSON.parse(text) : {};
    let result: unknown;
    switch (url.pathname) {
      case '/api/application.one':
        result = { applicationId: 'eat-app', appName: 'eat-platform', serverId: null, environmentId: 'production' };
        break;
      case '/api/settings.readTraefikFile':
        result = files.get(url.searchParams.get('path')!) ?? null;
        break;
      case '/api/settings.updateTraefikFile':
        files.set(body.path, body.traefikConfig);
        writes.push(body.path);
        result = true;
        break;
      case '/api/settings.readTraefikEnv':
        result = env;
        break;
      case '/api/settings.writeTraefikEnv':
        env = body.env;
        result = true;
        break;
      case '/api/settings.reloadTraefik':
        result = true;
        break;
      case '/api/docker.getContainersByAppNameMatch':
        result = [{ name: 'dokploy-traefik', state: 'running', status: 'Up' }];
        break;
      case '/api/certificates.all':
        result = [];
        break;
      default:
        res.statusCode = 404;
        result = { message: 'unknown endpoint' };
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(result));
  });
  await new Promise<void>((r) => backend.listen(0, '127.0.0.1', () => r()));
  await seed.insert(schema.dokploySettings).values({
    apiUrl: `http://127.0.0.1:${(backend.address() as any).port}/api`,
    apiTokenEncrypted: encryptSecret('backend-token'),
    enabled: true,
  });
  await pool.end();
  const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  await app.init();
  db = app.get(DB);
  const infra = app.get(SiteInfrastructure);
  vi.spyOn(infra, 'checkOss').mockImplementation(oss);
  vi.spyOn(infra, 'checkDns').mockImplementation(dns);
  vi.spyOn(infra, 'verify').mockImplementation(async (row, marker) => {
    if (failHttps) throw new SiteSetupError('测试：HTTPS 证书不被信任');
    const blocked = await app.inject({ url: '/', headers: { host: `demo.${row.domain}` } });
    expect(blocked.statusCode).toBe(503);
    const probe = await app.inject({ url: `/__eat/verify/${row.operationId}`, headers: { host: siteProbeHost(row) } });
    expect(probe.statusCode).toBe(200);
    expect(probe.body).toBe(marker);
    if (holdVerify) await holdVerify;
  });
  vi.spyOn(app.get(SiteDns), 'connect').mockResolvedValue({
    zone: 'example.com',
    records: async () => [],
    add: async () => '',
    remove: async () => {},
  });
  vi.spyOn(app.get(SiteDns), 'checkPermissions').mockImplementation(permissions);
  admin = (await api('POST', '/api/auth/login', undefined, { email: 'admin@settings.test', password: 'password123' }))
    .body.token;
  member = (await api('POST', '/api/auth/login', undefined, { email: 'member@settings.test', password: 'password123' }))
    .body.token;
});
afterAll(async () => {
  releaseVerify?.();
  await app?.close();
  await new Promise<void>((r) => backend?.close(() => r()));
});
describe('系统设置启用静态发布', () => {
  it('默认停用，成员可看能力状态但不能管理配置，CLI/MCP 同样无法绕过', async () => {
    expect((await api('GET', '/api/sites/capability', member)).body).toEqual({
      enabled: false,
      status: 'disabled',
      domain: '',
    });
    expect((await api('GET', '/api/admin/site-settings', member)).status).toBe(403);
    expect((await api('PUT', '/api/admin/site-settings', member, values)).status).toBe(403);
    expect((await api('POST', '/api/admin/site-settings/enable', member)).status).toBe(403);
    expect((await api('POST', '/api/sites', member, { slug: 'demo', name: 'Demo' })).status).toBe(503);
    const identity = await app.get(AuthService).authenticate(member);
    await expect(
      app.get(FolioToolsService).call(identity!, 'create_folio', { slug: 'mcp-demo', name: 'MCP demo' }),
    ).rejects.toThrow('系统设置');
  });
  it('控制台保存配置，凭证加密、返回脱敏，旧 env 不参与配置', async () => {
    process.env.EAT_SITES_DOMAIN = 'ignored.example.net';
    const saved = await api('PUT', '/api/admin/site-settings', admin, values);
    expect(saved.status).toBe(200);
    expect(saved.body.status).toBe('disabled');
    expect(JSON.stringify(saved.body)).not.toContain('private-value');
    const [row] = await db.select().from(schema.siteSettings);
    expect(row.ossAccessKeySecretEncrypted).toMatch(/^v1\./);
    expect(row.ossAccessKeySecretEncrypted).not.toContain('oss-private-value');
    const second = await api('PUT', '/api/admin/site-settings', admin, {
      ...values,
      ossAccessKeyId: '',
      ossAccessKeySecret: '',
      dnsAccessKeyId: '',
      dnsAccessKeySecret: '',
    });
    expect(second.body.hasOssSecret).toBe(true);
    expect(second.body.hasDnsSecret).toBe(true);
    expect((await api('PUT', '/api/admin/site-settings', admin, { ...values, domain: 'test' })).status).toBe(400);
    expect((await api('PUT', '/api/admin/site-settings', admin, { ...values, domain: 'eat.test' })).status).toBe(409);
    delete process.env.EAT_SITES_DOMAIN;
  });
  it('OSS 检查失败时不创建可用入口，展示诊断并允许重试', async () => {
    oss.mockRejectedValueOnce(new SiteSetupError('测试：OSS 缺少删除权限'));
    expect((await api('POST', '/api/admin/site-settings/enable', admin)).status).toBe(201);
    const result = await settled();
    expect(result.status).toBe('failed');
    expect(result.lastError).toContain('缺少删除权限');
    expect(result.checks.some((c: any) => c.id === 'oss' && c.status === 'failed')).toBe(true);
    const row = await app.get(SiteSettingsStore).required();
    expect(parse(files.get(`/etc/dokploy/traefik/dynamic/${siteResource(row)}.yml`)!).http.routers).toBeUndefined();
    expect((await api('GET', '/api/sites/capability', member)).body.enabled).toBe(false);
  });
  it('HTTPS 校验前不开放发布，并发启用和修改被拒绝；通过后才启用', async () => {
    holdVerify = new Promise<void>((r) => {
      releaseVerify = r;
    });
    await api('POST', '/api/admin/site-settings/enable', admin);
    for (let i = 0; i < 100; i++) {
      if ((await api('GET', '/api/admin/site-settings', admin)).body.status === 'verifying') break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect((await api('POST', '/api/admin/site-settings/enable', admin)).status).toBe(409);
    expect((await api('PUT', '/api/admin/site-settings', admin, values)).status).toBe(409);
    expect((await api('POST', '/api/sites', member, { slug: 'demo', name: 'Demo' })).status).toBe(503);
    releaseVerify!();
    holdVerify = undefined;
    const result = await settled();
    expect(result.status).toBe('enabled');
    expect(result.checks.every((c: any) => c.status === 'passed')).toBe(true);
    expect(env).toContain('UNRELATED=keep-me');
    expect(env).toContain('ALICLOUD_SECRET_KEY=dns-private-value');
    expect(parse(files.get(main)!).certificatesResolvers.other).toEqual(baseConfig.certificatesResolvers.other);
    const row = await app.get(SiteSettingsStore).required();
    const route = parse(files.get(`/etc/dokploy/traefik/dynamic/${siteResource(row)}.yml`)!);
    expect(route.http.services[siteResource(row)].loadBalancer).toEqual({
      servers: [{ url: 'http://eat-platform:3000' }],
      passHostHeader: true,
    });
    const created = await api('POST', '/api/sites', member, { slug: 'demo', name: 'Demo' });
    expect(created.status).toBe(201);
    expect(created.body.url).toBe('https://demo.sites.example.com');
  });
  it('启用中不能改设置；停用保留页面并撤下入口，配置不能破坏已有域名', async () => {
    expect((await api('PUT', '/api/admin/site-settings', admin, values)).status).toBe(409);
    await api('POST', '/api/admin/site-settings/disable', admin);
    expect((await settled()).status).toBe('disabled');
    expect(await db.select().from(schema.sites)).toHaveLength(1);
    expect((await app.inject({ url: '/', headers: { host: 'demo.sites.example.com' } })).statusCode).toBe(503);
    expect((await api('POST', '/api/sites', member, { slug: 'another', name: 'Another' })).status).toBe(503);
    expect((await api('DELETE', '/api/sites/demo', member)).status).toBe(503);
    expect(
      (await api('PUT', '/api/admin/site-settings', admin, { ...values, domain: 'different.example.com' })).status,
    ).toBe(409);
    expect((await api('PUT', '/api/admin/site-settings', admin, values)).status).toBe(200);
  });
  it('HTTPS 后置检查失败自动回滚，已有共享证书解析器保留以便重试', async () => {
    failHttps = true;
    await api('POST', '/api/admin/site-settings/enable', admin);
    const result = await settled();
    expect(result.status).toBe('failed');
    expect(result.lastError).toContain('证书不被信任');
    expect(result.checks.some((c: any) => c.id === 'rollback' && c.status === 'passed')).toBe(true);
    const row = await app.get(SiteSettingsStore).required();
    expect(row.routeConfigured).toBe(false);
    expect(parse(files.get(main)!).certificatesResolvers[siteResource(row)]).toBeDefined();
    failHttps = false;
  });
  it('Cloudflare 自动证书使用独立 Token；已有 DNS resolver 不会重复改写共享配置', async () => {
    expect(
      (
        await api('PUT', '/api/admin/site-settings', admin, {
          ...values,
          tlsMode: 'cloudflare',
          dnsAccessKeyId: '',
          dnsAccessKeySecret: 'cloudflare-token',
        })
      ).status,
    ).toBe(200);
    await api('POST', '/api/admin/site-settings/enable', admin);
    expect((await settled()).status).toBe('enabled');
    expect(env).toContain('CF_DNS_API_TOKEN=cloudflare-token');
    await api('POST', '/api/admin/site-settings/disable', admin);
    await settled();
    const row = await app.get(SiteSettingsStore).required();
    writes = [];
    expect(
      (
        await api('PUT', '/api/admin/site-settings', admin, {
          ...values,
          tlsMode: 'resolver',
          resolverName: siteResource(row),
          autoDns: false,
        })
      ).status,
    ).toBe(200);
    await api('POST', '/api/admin/site-settings/enable', admin);
    expect((await settled()).status).toBe('enabled');
    expect(writes).not.toContain(main);
    const options = await api('GET', '/api/admin/site-settings/tls-options/eat-app', admin);
    expect(options.body.resolvers).toContain(siteResource(row));
    expect(JSON.stringify(options.body)).not.toContain('private-value');
    await api('POST', '/api/admin/site-settings/disable', admin);
    await settled();
  });
  it('已有 OSS 历史版本时不能切换 Bucket 或地域，原文件记录保留', async () => {
    const [site] = await db.select().from(schema.sites);
    await db.insert(schema.siteVersions).values({
      id: randomUUID(),
      siteId: site.id,
      number: 1,
      publisherId: site.ownerId,
      fileCount: 1,
      totalBytes: 1,
      manifest: { 'index.html': { hash: 'a'.repeat(64), size: 1, type: 'text/html' } },
    });
    expect(
      (await api('PUT', '/api/admin/site-settings', admin, { ...values, ossBucket: 'different-bucket' })).status,
    ).toBe(409);
    expect(
      (await api('PUT', '/api/admin/site-settings', admin, { ...values, ossRegion: 'oss-cn-beijing' })).status,
    ).toBe(409);
    expect(await db.select().from(schema.siteVersions)).toHaveLength(1);
  });
  it('服务重启将中断的启用标为失败，恢复后仍不能绕过开关', async () => {
    await db
      .update(schema.siteSettings)
      .set({ status: 'verifying', operationId: 'f05ef360-b33d-4485-b4a1-e2582831427c', operationStartedAt: new Date() })
      .where(eq(schema.siteSettings.id, 1));
    await app.get(SiteSetupService).onModuleInit();
    expect((await api('GET', '/api/admin/site-settings', admin)).body.status).toBe('failed');
    expect((await api('GET', '/api/sites/capability', member)).body.enabled).toBe(false);
  });
});
