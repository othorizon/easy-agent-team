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
import { SiteCdnPurgeService } from '../src/sites/site-cdn-purge.service';
import { SiteCdnService } from '../src/sites/site-cdn.service';
import { SiteCdnInfrastructure, cdnFunctions, legacyCdnFunctions, configDigest, cdnConfigsToCheck, cdnSni } from '../src/sites/site-cdn.infrastructure';
import { SiteInfrastructure } from '../src/sites/site-infrastructure.service';
import { SiteSettingsStore } from '../src/sites/site-settings.store';
import { SiteDns, SiteSetupError, type DnsRecord } from '../src/sites/site-dns.service';
import { SiteStorage } from '../src/sites/site-storage.service';
import { aliyunCdnContract } from './fixtures/aliyun-cdn-contract';

let app: NestFastifyApplication, db: Db, admin: string, member: string, actor: string;
let store: SiteCdnStore, worker: SiteCdnService, settings: SiteSettingsStore;
const key = 'test-cdn-key-id',
  secret = 'test-cdn-secret-value';
let refreshTasks = new Map<string, { urls: string[]; status: string }>();
let refreshEffect = (_urls: string[]) => {};
let domain: any,
  configs: any[] = [],
  dnsRecords: DnsRecord[] = [],
  calls: { action: string; params: any }[] = [],
  fail = '',
  cert = 'certificate-1',
  certificateVerificationArg: 'enable' | 'enabled' | 'unsupported' = 'enable',
  verificationPending = false,
  failDns = false;
const cname = 'cdn.example.net';
const asCloudConfig = (v: any, id = 1) => ({
  ConfigId: String(id),
  ParentId: 0,
  FunctionName: v.functionName,
  FunctionArgs: {
    FunctionArg: v.functionArgs.map((a: any) => ({ ArgName: a.argName, ArgValue: a.argValue })),
  },
  Status: 'success',
});
const providerDefaults = () =>
  Object.entries({
    https_option: { session_timeout: '86400' },
    https_tls_version: { tls13: 'on' },
    domain_status: { domain_status: 'online' },
    dm_coverage: { coverage: 'overseas' },
    p2pqos: { enable: 'on', appid: '1' },
    ipv6: { switch: 'on', region: '*' },
    cc_defense: { enable: 'on' },
    alicdn_v2_architecture: { enabled: 'on' },
    consistent_hash: { enable: 'on' },
    domain_schdm: { schdm_id: '1', schdm_name: 'scheduler.example.net' },
  }).map(([functionName, args], i) =>
    asCloudConfig(
      {
        functionName,
        functionArgs: Object.entries(args).map(([argName, argValue]) => ({ argName, argValue })),
      },
      i,
    ),
  );
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
        return verificationPending ? { Content: 'verify_testvalue' } : {};
      case 'AddCdnDomain':
        domain = {
          DomainStatus: 'online',
          Scope: params.Scope,
          Cname: cname,
          SourceModels: { SourceModel: [{ Content: base.gatewayTarget, Port: 443 }] },
        };
        configs.push(...providerDefaults());
        return {};
      case 'ListTagResources':
        return { TagResources: { TagResource: [{ TagKey: 'eat-instance', TagValue: base.resourceKey }] } };
      case 'DescribeCdnDomainConfigs':
        return { DomainConfigs: { DomainConfig: configs } };
      case 'BatchSetCdnDomainConfig': {
        const rules = JSON.parse(params.Functions);
        for (const rule of rules) {
          if (fail === `config:${rule.functionName}`)
            throw new CdnApiError(action, 'InvalidArgName.ValueNotSupported', {
              functionName: rule.functionName, parameter: rule.functionArgs[0]?.argName,
            });
          const documented = aliyunCdnContract[rule.functionName];
          if (!documented) throw new CdnApiError(action, 'InvalidFunction.NotSupported');
          const required = rule.functionName === 'origin_certificate_verification'
            ? [certificateVerificationArg] : documented.required;
          const allowed = [...required, ...(documented.optional ?? [])];
          const unsupported = rule.functionArgs.find((a: any) => !allowed.includes(a.argName));
          if (unsupported) throw new CdnApiError(action, 'InvalidArgName.ValueNotSupported', {
            functionName: rule.functionName, parameter: unsupported.argName,
          });
          if (required.some((name) => !rule.functionArgs.some((a: any) => a.argName === name)))
            throw new CdnApiError(action, 'MissingParameter');
        }
        configs.push(...rules.map((v: any, i: number) => asCloudConfig(v, 100 + configs.length + i)));
        return {};
      }
      case 'DeleteSpecificConfig':
        configs = configs.filter((v) => v.ConfigId !== params.ConfigId);
        if (fail === 'after-delete') { fail = ''; throw new Error('lost provider response'); }
        return {};
      case 'RefreshObjectCaches': {
        expect(params.ObjectType).toBe('Directory');
        expect(params.Force).toBe('true');
        const urls = params.ObjectPath.split('\n');
        expect(urls).toHaveLength(Math.min(10, urls.length));
        expect(urls.some((u: string) => u.includes('*'))).toBe(false);
        const id = String(refreshTasks.size + 1);
        refreshTasks.set(id, { urls, status: 'Refreshing' });
        return { RefreshTaskId: id };
      }
      case 'DescribeRefreshTasks': {
        const task = refreshTasks.get(params.TaskId)!;
        if (task.status === 'Complete') refreshEffect(task.urls);
        return { TotalCount: 1, Tasks: { CDNTask: [{ TaskId: params.TaskId, Status: task.status }] } };
      }
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
  await db.delete(schema.siteCdnPurges);
  refreshTasks = new Map();
  refreshEffect = () => {};
  domain = undefined;
  configs = [];
  calls = [];
  fail = '';
  cert = 'certificate-1';
  certificateVerificationArg = 'enable';
  verificationPending = false;
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
      cacheRefresh: { pending: 0, lastCompletedAt: null, lastError: '', retryAt: null },
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
  it('onboards wildcard once with origin-controlled caching, fixed HTTPS SNI and original Host; repeated enable is idempotent', async () => {
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
    expect(functions.some((f) => ['cdn_remote_auth', 'origin_request_header', 'set_resp_header'].includes(f.functionName))).toBe(false);
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
  it('migrates only exact legacy rules and resumes after provider response loss', async () => {
    certificateVerificationArg = 'enabled';
    await save(); await tick();
    const row = (await store.row())!, base = await settings.required();
    configs.push(...legacyCdnFunctions(row, base).map((f, i) => asCloudConfig(f, 900 + i)));
    row.resources.cacheModel = undefined;
    row.resources.certificateVerificationArg = undefined;
    row.resources.configDigest = configDigest(cdnConfigsToCheck(configs));
    await store.patch({ resources: row.resources });
    fail = 'after-delete';
    expect((await tick()).status).toBe('failed');
    expect((await store.row())!.resources.legacyConfigRemoval).toHaveLength(3);
    expect((await tick()).status).toBe('enabled');
    expect(configs.some((c) => ['cdn_remote_auth', 'origin_request_header', 'set_resp_header'].includes(c.FunctionName))).toBe(false);
    expect((await store.row())!.resources.cacheModel).toBe('origin-v1');
    expect(calls.filter((c) => c.action === 'DeleteSpecificConfig')).toHaveLength(3);
  });
  it('preserves externally changed legacy rules instead of removing them', async () => {
    await save(); await tick();
    const row = (await store.row())!;
    configs.push(...legacyCdnFunctions(row, await settings.required()).map((f, i) => asCloudConfig(f, 900 + i)));
    row.resources.cacheModel = undefined;
    row.resources.configDigest = configDigest(cdnConfigsToCheck(configs));
    await store.patch({ resources: row.resources });
    configs.find((c) => c.FunctionName === 'origin_request_header').FunctionArgs.FunctionArg[0].ArgValue = 'external';
    expect((await tick()).status).toBe('conflict');
    expect(calls.some((c) => c.action === 'DeleteSpecificConfig')).toBe(false);
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
  it('retains provider defaults and resumes an older conflict with stale TXT guidance without replacing the domain', async () => {
    await save();
    fail = 'BatchSetCdnDomainConfig';
    expect((await tick()).status).toBe('failed');
    expect(await store.info()).toMatchObject({
      dnsInstructions: [],
      certificateUploaded: true,
      certificateSyncedAt: null,
    });
    await store.patch({
      status: 'conflict',
      dnsInstructions: [{ name: 'verification.example.com', type: 'TXT', value: 'verify_testvalue' }],
    });
    const defaults = structuredClone(configs);
    fail = '';
    expect((await request('POST', '/api/admin/site-settings/cdn/retry')).statusCode).toBe(201);
    expect(await tick()).toMatchObject({ status: 'enabled', connected: true, dnsInstructions: [] });
    expect(configs.slice(0, defaults.length)).toEqual(defaults);
    expect(calls.filter((c) => c.action === 'AddCdnDomain')).toHaveLength(1);
    // Certificate APIs may update provider TLS metadata without changing EAT's content rules.
    configs.find((c) => c.FunctionName === 'https_option').FunctionArgs.FunctionArg.push({
      ArgName: 'https',
      ArgValue: 'on',
    });
    expect((await tick()).status).toBe('enabled');
  });
  it('uses the official example flag and negotiates the documented alternative without disabling verification', async () => {
    await save();
    certificateVerificationArg = 'enabled';
    expect((await tick()).status).toBe('enabled');
    expect((await store.row())!.resources.certificateVerificationArg).toBe('enabled');
    const verificationCalls = calls
      .filter((c) => c.action === 'BatchSetCdnDomainConfig')
      .flatMap((c) => JSON.parse(c.params.Functions))
      .filter((c) => c.functionName === 'origin_certificate_verification');
    expect(verificationCalls.map((c) => c.functionArgs)).toEqual([
      [{ argName: 'enable', argValue: 'on' }],
      [{ argName: 'enabled', argValue: 'on' }],
    ]);
    const applied = calls.filter((c) => c.action === 'BatchSetCdnDomainConfig').length;
    expect((await tick()).status).toBe('enabled');
    expect(calls.filter((c) => c.action === 'BatchSetCdnDomainConfig')).toHaveLength(applied);
  });
  it('adopts an already applied legacy certificate flag without rewriting a partial configuration', async () => {
    await save();
    certificateVerificationArg = 'enabled';
    configs.push(asCloudConfig({
      functionName: 'origin_certificate_verification',
      functionArgs: [{ argName: 'enabled', argValue: 'on' }],
    }));
    expect((await tick()).status).toBe('enabled');
    expect((await store.row())!.resources.certificateVerificationArg).toBe('enabled');
    expect(calls.filter((c) => c.action === 'BatchSetCdnDomainConfig')
      .flatMap((c) => JSON.parse(c.params.Functions))
      .some((c) => c.functionName === 'origin_certificate_verification')).toBe(false);
  });
  it('reports the failing function and resumes only missing rules after a partial apply', async () => {
    await save();
    fail = 'config:self_defined_cachekey';
    expect(await tick()).toMatchObject({
      status: 'failed', connected: false,
      lastError: expect.stringContaining('功能：self_defined_cachekey'),
    });
    expect(dnsRecords.find((r) => r.name.startsWith('*'))?.type).toBe('A');
    fail = '';
    expect((await tick()).status).toBe('enabled');
    const rules = calls.filter((c) => c.action === 'BatchSetCdnDomainConfig')
      .flatMap((c) => JSON.parse(c.params.Functions));
    expect(rules.filter((c) => c.functionName === 'forward_scheme')).toHaveLength(1);
    expect(rules.filter((c) => c.functionName === 'self_defined_cachekey')).toHaveLength(2);
  });
  it('keeps direct DNS when neither mandatory certificate verification spelling is supported', async () => {
    await save();
    certificateVerificationArg = 'unsupported';
    expect(await tick()).toMatchObject({
      status: 'failed', connected: false,
      lastError: expect.stringContaining('origin_certificate_verification'),
    });
    expect(dnsRecords.find((r) => r.name.startsWith('*'))?.type).toBe('A');
    expect(cdnInfra.verify).not.toHaveBeenCalled();
  });
  it('keeps waiting for ownership when VerifyDomainOwner returns HTTP 200 with verification Content', async () => {
    await save();
    verificationPending = true;
    expect(await tick()).toMatchObject({ status: 'awaiting_dns', connected: false });
    expect(calls.some((c) => c.action === 'AddCdnDomain')).toBe(false);
    expect(dnsRecords.find((r) => r.name.startsWith('*'))?.type).toBe('A');
    verificationPending = false;
    expect((await tick()).status).toBe('enabled');
  });
  it.each([
    { FunctionName: 'filetype_based_ttl_set', FunctionArgs: { FunctionArg: [] }, ParentId: 0 },
    { FunctionName: 'https_option', FunctionArgs: { FunctionArg: [] }, ParentId: 'external-condition' },
  ])('preserves and rejects an unexpected initial or condition-bound config: $FunctionName', async (config) => {
    await save();
    configs.push({ ...config, Status: 'success' });
    expect((await tick()).status).toBe('conflict');
    expect(configs).toContainEqual({ ...config, Status: 'success' });
    expect(calls.some((c) => c.action === 'BatchSetCdnDomainConfig')).toBe(false);
    expect(dnsRecords.find((r) => r.name.startsWith('*'))?.type).toBe('A');
  });
  it('still detects changed arguments and rule bindings on EAT-managed configurations', async () => {
    await save();
    await tick();
    const auth = configs.find((c) => c.FunctionName === 'self_defined_cachekey');
    auth.ParentId = 'external-condition';
    expect((await tick()).status).toBe('conflict');
    auth.ParentId = 0;
    auth.FunctionArgs.FunctionArg.find((a: any) => a.ArgName === 'headers').ArgValue =
      'external';
    expect((await request('POST', '/api/admin/site-settings/cdn/retry')).statusCode).toBe(201);
    expect((await tick()).status).toBe('conflict');
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
      app.get(SiteCdnPurgeService),
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

describe('origin response caching and durable asynchronous invalidation', () => {
  async function purgeTick() {
    await db.update(schema.siteCdnPurges).set({ retryAt: new Date(0) });
    await worker.tick();
    return store.info();
  }
  async function fixture() {
    await save();
    await tick();
    const id = randomUUID(), v1 = randomUUID(), v2 = randomUUID();
    await db.insert(schema.sites).values({ id, slug: 'cache-demo', name: 'Cache demo',
      ownerId: actor, access: 'public', currentVersionId: v1 });
    const hash = createHash('sha256').update('body { color: green }').digest('hex');
    for (const [number, version] of [[1, v1], [2, v2]] as const)
      await db.insert(schema.siteVersions).values({ id: version, siteId: id, number,
        publisherId: actor, fileCount: 2, totalBytes: 42,
        manifest: { 'style.css': { hash, type: 'text/css', size: 21 }, 'index.html': { hash, type: 'text/html', size: 21 } } });
    const cached = new Map<string, string>();
    refreshEffect = (urls) => {
      for (const prefix of urls) for (const key of cached.keys())
        if (key.startsWith(prefix)) cached.delete(key);
    };
    let hits = 0;
    const edge = async (host: string, url: string, headers: Record<string, string> = {}) => {
      const key = `https://${host}${url}`;
      if (cached.has(key)) { hits++; return { status: 200, body: cached.get(key)!, location: undefined }; }
      const res = await app.inject({ url, headers: { ...headers, host } });
      // A response-header-driven edge substitute. There is no auth callback or origin marker.
      if (res.statusCode === 200 && res.headers['cache-control'] === 'public, max-age=2592000' && !res.headers['set-cookie'])
        cached.set(key, res.body);
      return { status: res.statusCode, body: res.body, location: res.headers.location };
    };
    const host = 'cache-demo.sites.example.com';
    const path = (await edge(host, '/style.css')).location!;
    return { id, v1, v2, host, path, edge, cached, get hits() { return hits; } };
  }
  it.each(['authenticated', 'password'] as const)('allows old public HIT until refresh completes, then denies fixed/history caches for %s and deletion', async (access) => {
    const f = await fixture();
    expect((await f.edge(f.host, f.path)).status).toBe(200);
    expect((await f.edge(f.host, f.path)).status).toBe(200);
    expect(f.hits).toBe(1);
    const history = 'v1--cache-demo.sites.example.com';
    const hp = (await f.edge(history, '/style.css')).location!;
    await f.edge(history, hp);
    expect((await f.edge('other.sites.example.com', f.path)).status).toBe(404);
    await db.update(schema.sites).set({ access, accessRevision: 2 }).where(eq(schema.sites.id, f.id));
    expect((await store.info()).cacheRefresh.pending).toBe(3);
    expect((await f.edge(f.host, f.path)).status).toBe(200); // Explicitly accepted stale window.
    expect((await purgeTick()).cacheRefresh.pending).toBe(3); // Submitted != completed.
    expect((await f.edge(history, hp)).status).toBe(200);
    expect((await purgeTick()).cacheRefresh.pending).toBe(3); // Refreshing != completed.
    for (const task of refreshTasks.values()) task.status = 'Complete';
    const info = await purgeTick();
    expect(info.cacheRefresh).toMatchObject({ pending: 0, lastError: '', lastCompletedAt: expect.any(String) });
    expect((await f.edge(f.host, f.path)).status).toBe(403);
    expect((await f.edge(history, hp)).status).toBe(403);
    // Returning to public uses a fresh revision. Deletion retains the snapshot of all version hosts.
    await db.update(schema.sites).set({ access: 'public', accessRevision: 3 }).where(eq(schema.sites.id, f.id));
    const fresh = (await f.edge(f.host, '/style.css')).location!;
    await f.edge(f.host, fresh);
    await db.delete(schema.sites).where(eq(schema.sites.id, f.id));
    expect((await f.edge(f.host, fresh)).status).toBe(200);
    await purgeTick();
    for (const task of refreshTasks.values()) task.status = 'Complete';
    await purgeTick();
    expect((await f.edge(f.host, fresh)).status).toBe(404);
    expect((await store.info()).cacheRefresh.pending).toBe(0);
  });
  it('caches identical public static files with cookies while query responses stay private and stale fills are refused', async () => {
    const f = await fixture();
    for (const headers of [{ cookie: 'eat_site=revoked' }, { authorization: `Bearer ${member}` }] as Record<string, string>[]) {
      const response = await app.inject({ url: f.path, headers: { host: f.host, ...headers } });
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('public, max-age=2592000');
      expect(response.headers['set-cookie']).toBeUndefined();
      expect((await f.edge(f.host, '/style.css', headers)).location).toBe(f.path);
    }
    expect((await f.edge(f.host, f.path + '?eat_access=old')).status).toBe(403);
    expect((await f.edge(f.host, '/style.css?v=1')).location).toBeUndefined();
    expect(f.cached.size).toBe(0);
    const blob = vi.spyOn(app.get(SiteStorage), 'getBlob').mockImplementationOnce(async () => {
      await db.update(schema.sites).set({ access: 'authenticated', accessRevision: 2 }).where(eq(schema.sites.id, f.id));
      return Buffer.from('old bytes');
    });
    expect((await f.edge(f.host, f.path)).status).toBe(403);
    expect(f.cached.size).toBe(0);
    blob.mockResolvedValue(Buffer.from('body { color: green }'));
  });
  it('isolates versions/hosts and retains usable history and rollback HIT without refreshing', async () => {
    const f = await fixture();
    await f.edge(f.host, f.path);
    const history = 'v1--cache-demo.sites.example.com';
    const hp = (await f.edge(history, '/style.css')).location!;
    await f.edge(history, hp);
    await db.update(schema.sites).set({ currentVersionId: f.v2 }).where(eq(schema.sites.id, f.id));
    const current = (await f.edge(f.host, '/style.css')).location!;
    expect(current).toContain(f.v2);
    expect(current).not.toBe(f.path);
    await f.edge(f.host, current);
    const hits = f.hits;
    expect((await f.edge(history, hp)).status).toBe(200);
    await db.update(schema.sites).set({ currentVersionId: f.v1 }).where(eq(schema.sites.id, f.id));
    expect((await f.edge(f.host, '/style.css')).location).toBe(f.path);
    expect((await f.edge(f.host, f.path)).status).toBe(200);
    expect(f.hits).toBe(hits + 2);
    expect((await store.info()).cacheRefresh.pending).toBe(0);
    expect(calls.some((c) => c.action === 'RefreshObjectCaches')).toBe(false);
  });
  it('caches password assets with a session, keeps HTML/unlock private and purges old revisions after password changes', async () => {
    const f = await fixture();
    // Use the actual REST mutation so hashing, revision changes and outbox insertion are covered.
    expect((await request('PATCH', '/api/sites/cache-demo', admin,
      { access: 'password', password: 'first-password' })).statusCode).toBe(200);
    const unlock = async (password: string) => app.inject({ method: 'POST', url: '/__eat/access',
      headers: { host: f.host, origin: `https://${f.host}`, 'content-type': 'application/json' },
      payload: { password } });
    const denied = await app.inject({ url: '/', headers: { host: f.host } });
    expect(denied.statusCode).toBe(403);
    expect(denied.headers['cache-control']).toBe('private, no-store');
    const session = await unlock('first-password');
    expect(session.statusCode).toBe(200);
    expect(session.headers['cache-control']).toBe('private, no-store');
    const cookie = String(session.headers['set-cookie']).split(';')[0];
    const html = await app.inject({ url: '/', headers: { host: f.host, cookie } });
    expect(html.statusCode).toBe(200);
    expect(html.headers['cache-control']).toBe('private, no-store');
    const asset = (await f.edge(f.host, '/style.css', { cookie })).location!;
    expect((await f.edge(f.host, asset)).status).toBe(403); // Cold anonymous origin fill is rejected.
    expect((await f.edge(f.host, asset, { cookie })).status).toBe(200);
    expect((await f.edge(f.host, asset)).status).toBe(200); // Shared HIT does not authenticate.
    expect(f.hits).toBe(1);
    expect((await request('PATCH', '/api/sites/cache-demo', admin,
      { password: 'second-password' })).statusCode).toBe(200);
    expect((await app.inject({ url: '/', headers: { host: f.host, cookie } })).statusCode).toBe(403);
    expect((await unlock('first-password')).statusCode).toBe(403);
    expect((await f.edge(f.host, asset)).status).toBe(200); // Accepted refresh delay.
    await purgeTick();
    for (const task of refreshTasks.values()) task.status = 'Complete';
    await purgeTick();
    expect((await f.edge(f.host, asset, { cookie })).status).toBe(403);
    const next = await unlock('second-password');
    expect(next.statusCode).toBe(200);
    const freshCookie = String(next.headers['set-cookie']).split(';')[0];
    const fresh = (await f.edge(f.host, '/style.css', { cookie: freshCookie })).location!;
    expect(fresh).not.toBe(asset);
    expect((await f.edge(f.host, fresh, { cookie: freshCookie })).status).toBe(200);
    expect((await f.edge(f.host, fresh)).status).toBe(200);
    // Login-required Folios keep their existing private response semantics.
    await request('PATCH', '/api/sites/cache-demo', admin, { access: 'authenticated' });
    const restricted = await app.inject({ url: '/style.css', headers: { host: f.host, authorization: `Bearer ${admin}` } });
    expect(restricted.statusCode).toBe(200);
    expect(restricted.headers['cache-control']).toBe('private, no-store');
    expect(restricted.headers.location).toBeUndefined();
  });
  it('retains permission invalidations while managed CDN is disabled for a later re-enable', async () => {
    const f = await fixture();
    await f.edge(f.host, f.path);
    await save({ ...dto, enabled: false, accessKeyId: '', accessKeySecret: '' });
    expect((await tick()).status).toBe('draining');
    await store.patch({ drainUntil: new Date(0), retryAt: null });
    expect((await tick()).status).toBe('disabled');
    await db.update(schema.sites).set({ access: 'password', accessRevision: 2 }).where(eq(schema.sites.id, f.id));
    expect((await store.info()).cacheRefresh.pending).toBe(3);
    const submits = calls.filter((c) => c.action === 'RefreshObjectCaches').length;
    await purgeTick();
    expect(calls.filter((c) => c.action === 'RefreshObjectCaches')).toHaveLength(submits);
    await save({ ...dto, accessKeyId: '', accessKeySecret: '' });
    await tick(); // The persisted domain is started again.
    expect((await tick()).status).toBe('enabled');
    for (const task of refreshTasks.values()) task.status = 'Complete';
    expect((await purgeTick()).cacheRefresh.pending).toBe(0);
    expect((await f.edge(f.host, f.path)).status).toBe(403);
  });
  it('persists refresh failures, retries after restart and shares the multi-instance lock', async () => {
    const f = await fixture();
    await db.update(schema.sites).set({ access: 'password', accessRevision: 2 }).where(eq(schema.sites.id, f.id));
    const pool = app.get<Pool>(PG_POOL), connection = await pool.connect();
    await connection.query('select pg_advisory_lock(1950536502)');
    try {
      await purgeTick();
      expect(calls.some((c) => c.action === 'RefreshObjectCaches')).toBe(false);
    } finally { await connection.query('select pg_advisory_unlock(1950536502)'); connection.release(); }
    fail = 'RefreshObjectCaches';
    expect((await purgeTick()).cacheRefresh).toMatchObject({ pending: 3, lastError: expect.stringContaining('Forbidden.RAM') });
    expect((await store.info()).connected).toBe(true);
    fail = '';
    await request('POST', '/api/admin/site-settings/cdn/retry');
    await purgeTick();
    const submitted = calls.filter((c) => c.action === 'RefreshObjectCaches').length;
    // A new reconciler resumes persisted task IDs rather than submitting duplicate work.
    const restarted = new SiteCdnService(store, api as never, cdnInfra as never, dns as never,
      app.get(SiteInfrastructure), app.get(AuditService), app.get(SiteCdnPurgeService), pool);
    await db.update(schema.siteCdnPurges).set({ retryAt: new Date(0) });
    await restarted.tick();
    expect(calls.filter((c) => c.action === 'RefreshObjectCaches')).toHaveLength(submitted);
    fail = 'DescribeRefreshTasks';
    expect((await purgeTick()).cacheRefresh.lastError).toContain('Forbidden.RAM');
    expect(calls.filter((c) => c.action === 'RefreshObjectCaches')).toHaveLength(submitted);
    fail = '';
    for (const task of refreshTasks.values()) task.status = 'Failed';
    expect((await purgeTick()).cacheRefresh.lastError).toContain('刷新失败');
    await purgeTick();
    for (const task of refreshTasks.values()) task.status = 'Complete';
    expect((await purgeTick()).cacheRefresh.pending).toBe(0);
  });
});
