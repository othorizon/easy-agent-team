process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://dev@127.0.0.1:5433/eat_test';
process.env.EAT_PUBLIC_URL = 'https://eat.example.test';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import * as bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { AppModule } from '../src/app.module';
import { AuditService } from '../src/audit/audit.service';
import { DB, PG_POOL, type Db } from '../src/db/db.module';
import * as schema from '../src/db/schema';
import { encryptSecret, decryptSecret } from '../src/common/crypto';
import { SiteCdnClient, CdnApiError } from '../src/sites/site-cdn.client';
import { SiteCdnStore } from '../src/sites/site-cdn.store';
import { SiteCdnService } from '../src/sites/site-cdn.service';
import { SiteCdnInfrastructure, cdnFunctions, cdnSni } from '../src/sites/site-cdn.infrastructure';
import { SiteInfrastructure } from '../src/sites/site-infrastructure.service';
import { SiteSettingsStore } from '../src/sites/site-settings.store';
import { SiteDns, SiteSetupError, type DnsRecord } from '../src/sites/site-dns.service';
import { SiteStorage } from '../src/sites/site-storage.service';

let app: NestFastifyApplication, db: Db, admin: string, member: string, actor: string;
let store: SiteCdnStore, worker: SiteCdnService, settings: SiteSettingsStore;
const key = 'test-cdn-key-id',
  secret = 'test-cdn-secret-value';
let domain: any,
  configs: any[] = [],
  dnsRecords: DnsRecord[] = [],
  calls: { action: string; params: any }[] = [],
  fail = '',
  cert = 'certificate-1',
  failDns = false;
const cname = 'cdn.example.net';
const api = {
  call: vi.fn(async (_c: unknown, action: string, params: any = {}) => {
    calls.push({ action, params });
    if (fail === action) throw new CdnApiError(action, 'Forbidden.RAM');
    const base = await settings.required();
    switch (action) {
      case 'DescribeCdnService':
        return { OpeningTime: '2026-01-01' };
      case 'DescribeCdnDomainDetail':
        if (!domain) throw new CdnApiError(action, 'InvalidDomain.NotFound');
        return { GetDomainDetailModel: domain };
      case 'DescribeVerifyContent':
        return { Content: 'verify_testvalue' };
      case 'VerifyDomainOwner':
        return {};
      case 'AddCdnDomain':
        domain = {
          DomainStatus: 'online',
          Scope: params.Scope,
          Cname: cname,
          SourceModels: { SourceModel: [{ Content: base.gatewayTarget, Port: 443 }] },
        };
        return {};
      case 'ListTagResources':
        return { TagResources: { TagResource: [{ TagKey: 'eat-instance', TagValue: base.resourceKey }] } };
      case 'DescribeCdnDomainConfigs':
        return { DomainConfigs: { DomainConfig: configs } };
      case 'BatchSetCdnDomainConfig':
        configs.push(...JSON.parse(params.Functions).map((v: any) => ({ ...v, Status: 'success' })));
        return {};
      case 'SetCdnDomainSSLCertificate':
        return {};
      case 'StopCdnDomain':
        domain.DomainStatus = 'offline';
        return {};
      case 'StartCdnDomain':
        domain.DomainStatus = 'online';
        return {};
      default:
        throw new Error('Unexpected action ' + action);
    }
  }),
};
const cdnInfra = {
  certificate: vi.fn(async () => ({
    pem: 'TEST CERTIFICATE',
    key: 'TEST PRIVATE KEY',
    fingerprint: cert,
    expiresAt: new Date(Date.now() + 60 * 86400000),
  })),
  configurations: async (c: any, d: string) =>
    (await api.call(c, 'DescribeCdnDomainConfigs', { DomainName: d })).DomainConfigs!.DomainConfig,
  verify: vi.fn(async () => {}),
};
const dns = {
  connect: vi.fn(async () => ({
    zone: 'example.com',
    records: async (name: string) => dnsRecords.filter((r) => r.name === name),
    add: async (name: string, type: string, content: string) => {
      const id = randomUUID();
      dnsRecords.push({ id, name, type, content, ttl: 600 });
      return id;
    },
    update: vi.fn(async (record: DnsRecord) => {
      if (failDns) {
        failDns = false;
        throw new Error('injected DNS outage');
      }
      dnsRecords = dnsRecords.map((r) => (r.id === record.id ? { ...record } : r));
    }),
    remove: async (id: string) => {
      dnsRecords = dnsRecords.filter((r) => r.id !== id);
    },
  })),
};
async function request(method: any, path: string, token = admin, payload?: unknown) {
  return app.inject({
    method,
    url: path,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    payload: payload as never,
  });
}
const dto = {
  enabled: true,
  scope: 'overseas',
  credentialSource: 'independent',
  autoDns: true,
  accessKeyId: key,
  accessKeySecret: secret,
};
async function save(values: any = dto) {
  const r = await request('PUT', '/api/admin/site-settings/cdn', admin, values);
  expect(r.statusCode).toBe(200);
  return r.json();
}
async function tick() {
  await store.patch({ retryAt: null });
  await worker.tick();
  return store.info();
}
beforeAll(async () => {
  if (!new URL(process.env.DATABASE_URL!).pathname.endsWith('_test'))
    throw new Error('CDN tests require an isolated _test database');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await pool.query('drop schema public cascade;create schema public;drop schema if exists drizzle cascade');
  await migrate(drizzle(pool), { migrationsFolder: resolve('drizzle') });
  const seed = drizzle(pool, { schema });
  await seed.insert(schema.users).values([
    {
      name: 'Admin',
      email: 'cdn-admin@example.test',
      role: 'admin',
      passwordHash: await bcrypt.hash('password123', 4),
    },
    { name: 'Member', email: 'cdn-member@example.test', passwordHash: await bcrypt.hash('password123', 4) },
  ]);
  await seed.insert(schema.siteSettings).values({
    status: 'enabled',
    domain: 'sites.example.com',
    platformUrl: 'https://eat.example.test',
    ossRegion: 'oss-cn-hangzhou',
    ossBucket: 'test-folio-bucket',
    ossAccessKeyIdEncrypted: encryptSecret('test-oss-key'),
    ossAccessKeySecretEncrypted: encryptSecret('test-oss-secret'),
    tlsMode: 'alidns',
    acmeEmail: 'operator@example.test',
    dnsAccessKeyIdEncrypted: encryptSecret('test-dns-key'),
    dnsAccessKeySecretEncrypted: encryptSecret('test-dns-secret'),
    platformApplicationId: 'test-app',
    gatewayTarget: '203.0.113.10',
  });
  await pool.end();
  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(SiteCdnClient)
    .useValue(api)
    .overrideProvider(SiteCdnInfrastructure)
    .useValue(cdnInfra)
    .overrideProvider(SiteDns)
    .useValue(dns)
    .compile();
  app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  db = app.get(DB);
  store = app.get(SiteCdnStore);
  settings = app.get(SiteSettingsStore);
  worker = app.get(SiteCdnService);
  vi.spyOn(app.get(SiteInfrastructure), 'checkDns').mockResolvedValue();
  vi.spyOn(app.get(SiteStorage), 'getBlob').mockResolvedValue(Buffer.from('body { color: green }'));
  admin = (
    await request('POST', '/api/auth/login', '', { email: 'cdn-admin@example.test', password: 'password123' })
  ).json().token;
  member = (
    await request('POST', '/api/auth/login', '', {
      email: 'cdn-member@example.test',
      password: 'password123',
    })
  ).json().token;
  actor = (await db.select().from(schema.users).where(eq(schema.users.email, 'cdn-admin@example.test')))[0]
    .id;
});
afterAll(async () => {
  await app?.close();
});
beforeEach(async () => {
  await db.delete(schema.siteCdn);
  await db.delete(schema.sites);
  domain = undefined;
  configs = [];
  calls = [];
  fail = '';
  cert = 'certificate-1';
  failDns = false;
  cdnInfra.verify.mockReset();
  cdnInfra.verify.mockResolvedValue();
  dnsRecords = [
    { id: 'wildcard-direct', name: '*.sites.example.com', type: 'A', content: '203.0.113.10', ttl: 600 },
  ];
});

describe('Folio CDN control and durable reconciliation (cloud substitutes)', () => {
  it('upgraded Folio stays enabled, CDN defaults off; member access is denied', async () => {
    expect(await store.info()).toMatchObject({
      enabled: false,
      connected: false,
      status: 'disabled',
      hasSecret: false,
    });
    expect(await settings.capability()).toMatchObject({ enabled: true });
    expect((await request('GET', '/api/admin/site-settings/cdn', member)).statusCode).toBe(403);
    expect((await request('PUT', '/api/admin/site-settings/cdn', member, dto)).statusCode).toBe(403);
  });
  it('encrypts and masks credentials, keeps blanks, audits without secrets and validates input', async () => {
    expect((await save()).connected).toBe(false);
    const row = (await store.row())!;
    expect(row.accessKeySecretEncrypted).not.toContain(secret);
    expect(decryptSecret(row.accessKeySecretEncrypted!)).toBe(secret);
    const r = await save({ ...dto, accessKeyId: '', accessKeySecret: '' });
    expect(r.hasSecret).toBe(true);
    expect(JSON.stringify(r)).not.toContain(secret);
    const audit = await db.select().from(schema.auditLogs);
    expect(JSON.stringify(audit)).not.toContain(secret);
    expect(
      (await request('PUT', '/api/admin/site-settings/cdn', admin, { ...dto, scope: 'invalid' })).statusCode,
    ).toBe(400);
  });
  it('checks real API permission failures before any DNS/cloud mutation', async () => {
    await save();
    fail = 'DescribeCdnService';
    expect(await tick()).toMatchObject({
      status: 'failed',
      connected: false,
      lastError: expect.stringContaining('Forbidden.RAM'),
    });
    expect(calls.map((c) => c.action)).toEqual(['DescribeCdnService']);
    expect(dnsRecords).toHaveLength(1);
  });
  it('onboards wildcard once with fail-closed auth, fixed HTTPS SNI and original Host; repeated enable is idempotent', async () => {
    await save();
    expect(await tick()).toMatchObject({
      status: 'enabled',
      connected: true,
      cname,
      certificateSyncError: '',
    });
    expect(dnsRecords.find((r) => r.name.startsWith('*'))).toMatchObject({
      type: 'CNAME',
      content: cname,
      id: 'wildcard-direct',
    });
    const functions = cdnFunctions((await store.row())!, await settings.required());
    const args = (name: string) =>
      Object.fromEntries(
        functions.find((f) => f.functionName === name)!.functionArgs.map((a) => [a.argName, a.argValue]),
      );
    expect(args('cdn_remote_auth')).toMatchObject({
      remote_auth_other_code_act: 'reject',
      remote_auth_timeout_action: 'reject',
      remote_auth_type: 'all',
    });
    expect(args('https_origin_sni').https_origin_sni).toBe(cdnSni(await settings.required()));
    expect(
      functions.find(
        (f) =>
          f.functionName === 'path_based_ttl_set' &&
          f.functionArgs.some((a) => a.argName === 'path' && a.argValue === '/__eat/cdn/'),
      )?.functionArgs,
    ).toContainEqual({ argName: 'ttl', argValue: '2592000' });
    expect(functions.some((f) => f.functionName === 'set_req_host_header')).toBe(false);
    await save({ ...dto, accessKeyId: '', accessKeySecret: '' });
    expect((await tick()).connected).toBe(true);
    expect(calls.filter((c) => c.action === 'AddCdnDomain')).toHaveLength(1);
    expect(calls.filter((c) => c.action === 'SetCdnDomainSSLCertificate')).toHaveLength(1);
  });
  it('resumes the DNS intent journal after interruption and preserves external conflicts', async () => {
    await save();
    failDns = true;
    expect((await tick()).status).toBe('failed');
    expect((await store.row())!.resources.managedDns?.id).toBe('wildcard-direct');
    expect((await tick()).status).toBe('enabled');
    dnsRecords[0] = { ...dnsRecords[0], content: 'external.example.net' };
    expect((await tick()).status).toBe('conflict');
    expect(dnsRecords[0].content).toBe('external.example.net');
  });
  it('does not overwrite a CDN owned by somebody else or external rule edits', async () => {
    await save();
    await tick();
    configs.push({ functionName: 'unexpected', functionArgs: [] });
    expect((await tick()).status).toBe('conflict');
    expect(configs.some((c) => c.functionName === 'unexpected')).toBe(true);
  });
  it('migrates known fixed/version DNS records, restores their TTLs and never touches another application', async () => {
    const id = randomUUID(),
      version = randomUUID();
    await db.insert(schema.sites).values({
      id,
      slug: 'exact-demo',
      name: 'Exact DNS',
      ownerId: actor,
      access: 'public',
      currentVersionId: version,
    });
    await db.insert(schema.siteVersions).values({
      id: version,
      siteId: id,
      number: 1,
      publisherId: actor,
      fileCount: 0,
      totalBytes: 0,
      manifest: {},
    });
    dnsRecords.push(
      {
        id: 'exact-fixed',
        name: 'exact-demo.sites.example.com',
        type: 'A',
        content: '203.0.113.10',
        ttl: 1200,
      },
      {
        id: 'exact-version',
        name: 'v1--exact-demo.sites.example.com',
        type: 'A',
        content: '203.0.113.10',
        ttl: 1800,
      },
      {
        id: 'other-application',
        name: 'other-app.sites.example.com',
        type: 'A',
        content: '203.0.113.10',
        ttl: 600,
      },
    );
    await save();
    expect((await tick()).status).toBe('enabled');
    expect(
      dnsRecords
        .filter((r) => r.id.startsWith('exact-'))
        .every((r) => r.type === 'CNAME' && r.content === cname),
    ).toBe(true);
    expect(dnsRecords.find((r) => r.id === 'other-application')?.type).toBe('A');
    await save({ ...dto, enabled: false, accessKeyId: '', accessKeySecret: '' });
    await tick();
    expect(dnsRecords.find((r) => r.id === 'exact-fixed')).toMatchObject({ type: 'A', ttl: 1200 });
    expect(dnsRecords.find((r) => r.id === 'exact-version')).toMatchObject({ type: 'A', ttl: 1800 });
  });
  it('restores origin before draining, keeps certificates live, then stops only its tagged domain', async () => {
    await save();
    await tick();
    await save({ ...dto, enabled: false, accessKeyId: '', accessKeySecret: '' });
    expect(await tick()).toMatchObject({
      status: 'draining',
      connected: false,
      drainUntil: expect.any(String),
    });
    expect(dnsRecords[0]).toMatchObject({ type: 'A', content: '203.0.113.10' });
    expect(calls.some((c) => c.action === 'StopCdnDomain')).toBe(false);
    await store.patch({ drainUntil: new Date(Date.now() - 1000) });
    expect((await tick()).status).toBe('disabled');
    expect(calls.filter((c) => c.action === 'StopCdnDomain')).toHaveLength(1);
    await tick();
    expect(calls.filter((c) => c.action === 'StopCdnDomain')).toHaveLength(1);
    expect((await settings.capability()).enabled).toBe(true);
  });
  it('records origin renewal separately from a failed CDN sync, then retries', async () => {
    await save();
    await tick();
    const synced = (await store.info()).certificateSyncedAt;
    cert = 'renewed-certificate';
    fail = 'SetCdnDomainSSLCertificate';
    expect(await tick()).toMatchObject({
      status: 'failed',
      certificateSyncedAt: synced,
      certificateSyncError: expect.stringContaining('Forbidden.RAM'),
      originCertificateCheckedAt: expect.any(String),
    });
    fail = '';
    expect(await tick()).toMatchObject({ status: 'enabled', certificateSyncError: '' });
    expect((await store.row())!.resources.certificateFingerprint).toBe(cert);
  });
  it('restores DNS on a failed post-switch check and a fresh worker resumes the journal', async () => {
    await save();
    cdnInfra.verify.mockImplementation(async (...args: any[]) => {
      if (String(args[2]).endsWith('.sites.example.com')) throw new SiteSetupError('测试：切换后访问失败');
    });
    expect((await tick()).status).toBe('failed');
    expect(dnsRecords[0]).toMatchObject({ type: 'A', content: '203.0.113.10' });
    cdnInfra.verify.mockReset();
    cdnInfra.verify.mockResolvedValue();
    await store.patch({ retryAt: null });
    const restarted = new SiteCdnService(
      store,
      api as never,
      cdnInfra as never,
      dns as never,
      app.get(SiteInfrastructure),
      app.get(AuditService),
      app.get(PG_POOL),
    );
    await restarted.tick();
    expect((await store.info()).status).toBe('enabled');
    expect(calls.filter((c) => c.action === 'AddCdnDomain')).toHaveLength(1);
  });
  it('does not stop an unconfigured domain before confirming origin restoration, and never removes other resources', async () => {
    await save();
    fail = 'BatchSetCdnDomainConfig';
    expect((await tick()).status).toBe('failed');
    fail = '';
    await save({ ...dto, enabled: false, accessKeyId: '', accessKeySecret: '' });
    expect((await tick()).status).toBe('disabled');
    expect(calls.some((c) => c.action === 'DeleteCdnDomain')).toBe(false);
  });
  it('validates rotated credentials against the existing tagged resource and preserves old keys on failure', async () => {
    await save();
    await tick();
    fail = 'ListTagResources';
    expect(
      (
        await request('PUT', '/api/admin/site-settings/cdn', admin, {
          ...dto,
          accessKeyId: 'new-test-id',
          accessKeySecret: 'new-test-secret',
        })
      ).statusCode,
    ).toBe(409);
    expect(decryptSecret((await store.row())!.accessKeySecretEncrypted!)).toBe(secret);
    fail = '';
    await save({ ...dto, accessKeyId: 'new-test-id', accessKeySecret: 'new-test-secret' });
    expect(decryptSecret((await store.row())!.accessKeySecretEncrypted!)).toBe('new-test-secret');
    expect((await request('POST', '/api/admin/site-settings/disable')).statusCode).toBe(409);
  });
  it('uses the shared multi-instance PostgreSQL lock', async () => {
    await save();
    const c = await app.get<Pool>(PG_POOL).connect();
    await c.query('select pg_advisory_lock(1950536502)');
    try {
      await worker.tick();
      expect(calls).toHaveLength(0);
    } finally {
      await c.query('select pg_advisory_unlock(1950536502)');
      c.release();
    }
  });
  it('provides manual TXT/CNAME guidance without writing unauthorized DNS', async () => {
    await save({ ...dto, autoDns: false });
    const info = await tick();
    expect(info).toMatchObject({ status: 'awaiting_dns', connected: false });
    expect(info.dnsInstructions).toContainEqual({ name: '*.sites.example.com', type: 'CNAME', value: cname });
    expect(dnsRecords).toHaveLength(1);
  });
});

describe('authorization before cache hits and revocation races without active invalidation', () => {
  async function fixture() {
    await save();
    await tick();
    const id = randomUUID(),
      v1 = randomUUID(),
      v2 = randomUUID();
    await db.insert(schema.sites).values({
      id,
      slug: 'cache-demo',
      name: 'Cache demo',
      ownerId: actor,
      access: 'public',
      currentVersionId: v1,
    });
    const hash = createHash('sha256').update('body { color: green }').digest('hex');
    for (const [number, version] of [
      [1, v1],
      [2, v2],
    ] as const)
      await db.insert(schema.siteVersions).values({
        id: version,
        siteId: id,
        number,
        publisherId: actor,
        fileCount: 1,
        totalBytes: 21,
        manifest: { 'style.css': { hash, type: 'text/css', size: 21 } },
      });
    const row = (await store.row())!,
      secret = decryptSecret(row.originSecretEncrypted);
    const cached = new Map<string, string>();
    let hits = 0;
    const edge = async (host: string, url: string, headers: Record<string, string> = {}) => {
      const auth = await app.inject({
        url: '/api/sites/cdn-auth',
        headers: {
          ...headers,
          host: 'eat.example.test',
          'x-eat-cdn-auth': secret,
          'x-eat-cdn-host': host,
          'x-eat-cdn-uri': url,
          'x-eat-cdn-method': 'GET',
        },
      });
      if (auth.statusCode !== 200) return { status: 403, body: 'denied' };
      const key = host + url;
      if (cached.has(key)) {
        hits++;
        return { status: 200, body: cached.get(key)! };
      }
      const res = await app.inject({ url, headers: { ...headers, host, 'x-eat-cdn-origin': secret } });
      if (res.statusCode === 200 && res.headers['cache-control'] === 'public, max-age=2592000')
        cached.set(key, res.body);
      return { status: res.statusCode, body: res.body, location: res.headers.location };
    };
    const host = 'cache-demo.sites.example.com';
    const path = (await edge(host, '/style.css')).location!;
    return {
      id,
      v1,
      v2,
      host,
      path,
      edge,
      cached,
      get hits() {
        return hits;
      },
    };
  }
  it('serves public static cache hits but never returns old cached content after public → authenticated/password, session revocation or deletion', async () => {
    const f = await fixture();
    expect((await f.edge(f.host, f.path)).status).toBe(200);
    expect((await f.edge(f.host, f.path)).status).toBe(200);
    expect(f.hits).toBe(1);
    const history = 'v1--cache-demo.sites.example.com';
    const historyPath = (await f.edge(history, '/style.css')).location!;
    expect((await f.edge(history, historyPath)).status).toBe(200);
    expect((await f.edge('other.sites.example.com', f.path)).status).toBe(403);
    expect((await f.edge(f.host, f.path, { cookie: 'eat_site=revoked-session' })).status).toBe(403);
    expect((await f.edge(f.host, f.path + '?eat_access=old-token')).status).toBe(403);
    for (const uri of [
      f.path.replace('/__eat/cdn/', '/safe/../__eat/cdn/'),
      f.path.replace('/__eat/cdn/', '/__eat%2fcdn/'),
      f.path.replace('/__eat/cdn/', '/__eat//cdn/'),
      f.path.replace('/__eat/cdn/', '/safe%23ignored/../__eat/cdn/'),
    ])
      expect((await f.edge(f.host, uri)).status).toBe(403);
    const direct = await app.inject({ url: f.path, headers: { host: f.host } });
    expect(direct.statusCode).toBe(200);
    expect(direct.headers['cache-control']).toBe('private, no-store');

    await db
      .update(schema.sites)
      .set({ access: 'authenticated', accessRevision: 2 })
      .where(eq(schema.sites.id, f.id));
    expect((await f.edge(f.host, f.path)).status).toBe(403);
    expect((await f.edge(history, historyPath)).status).toBe(403);
    expect(f.cached.size).toBe(2);
    await db
      .update(schema.sites)
      .set({ access: 'password', accessRevision: 3 })
      .where(eq(schema.sites.id, f.id));
    expect((await f.edge(f.host, f.path)).status).toBe(403);
    expect((await f.edge(history, historyPath)).status).toBe(403);
    await db.delete(schema.sites).where(eq(schema.sites.id, f.id));
    expect((await f.edge(f.host, f.path)).status).toBe(403);
    expect((await f.edge(history, historyPath)).status).toBe(403);
    await tick();
    expect(f.cached.size).toBe(2);
    expect(calls.some((c) => c.action === 'RefreshObjectCaches')).toBe(false);
  });
  it('isolates new versions, rejects old in-flight fills and retains usable history/rollback cache hits without refreshing', async () => {
    const f = await fixture();
    await f.edge(f.host, f.path);
    const history = 'v1--cache-demo.sites.example.com';
    const p = (await f.edge(history, '/style.css')).location!;
    expect((await f.edge(history, p)).status).toBe(200);
    await db.update(schema.sites).set({ currentVersionId: f.v2 }).where(eq(schema.sites.id, f.id));
    await tick();
    // Simulate completion of an old in-flight cache fill after the database commit.
    f.cached.set(f.host + f.path, 'old bytes');
    expect((await f.edge(f.host, f.path)).status).toBe(403);
    const hits = f.hits;
    expect((await f.edge(history, p)).status).toBe(200);
    expect(f.hits).toBe(hits + 1);
    expect((await f.edge(f.host, p)).status).toBe(403);
    const current = (await f.edge(f.host, '/style.css')).location!;
    expect(current).toContain(f.v2);
    expect(current).not.toBe(f.path);
    expect((await f.edge(f.host, current)).status).toBe(200);
    expect((await f.edge(f.host, current)).status).toBe(200);
    expect(f.hits).toBe(hits + 2);
    await db.update(schema.sites).set({ currentVersionId: f.v1 }).where(eq(schema.sites.id, f.id));
    expect((await request('POST', '/api/admin/site-settings/cdn/retry')).statusCode).toBe(201);
    await tick();
    expect((await f.edge(f.host, f.path)).status).toBe(200);
    expect((await f.edge(history, p)).status).toBe(200);
    expect(f.hits).toBe(hits + 4);
    expect((await f.edge(f.host, current)).status).toBe(403);
    expect(f.cached.size).toBe(3);
    expect(calls.some((c) => c.action === 'RefreshObjectCaches')).toBe(false);
  });
});
