/** Local-only UI acceptance: EAT_PERMISSIONS_UI_QA=1 BROWSER_CDP_URL=ws://127.0.0.1:... vitest run --config vitest.ui-qa.config.ts */
process.env.DATABASE_URL = 'postgres://dev@127.0.0.1:5433/eat_ui_19';
process.env.EAT_CLOUD_KEY_PROPAGATION_MS = '0';
process.env.EAT_KEK = Buffer.alloc(32, 19).toString('base64');
process.env.EAT_PUBLIC_URL = 'http://127.0.0.1';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { it, expect, vi } from 'vitest';
import { Pool, Client } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import * as bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { AppModule } from '../src/app.module';
import { DB, type Db } from '../src/db/db.module';
import * as schema from '../src/db/schema';
import { RamCloud } from '../src/ram/ram-cloud';
import { OssCloud } from '../src/oss/oss-cloud';
import { TestRamCloud } from '../test/ram-fixture';
import { TestOssCloud } from '../test/oss-fixture';
import { OssService } from '../src/oss/oss.service';
import { DbAccessService } from '../src/dbs/db-access.service';
import { AliyunGrantsService } from '../src/aliyun/aliyun-grants.service';
import { AliyunCredentialsService } from '../src/aliyun/aliyun-credentials.service';
import { AliyunMaintenanceService } from '../src/aliyun/aliyun-maintenance.service';
import { CloudIdentityStatusService } from '../src/cloud-identities/cloud-identity-status.service';

const enabled = process.env.EAT_PERMISSIONS_UI_QA === '1';
const q = (name: string) => `"${name.replaceAll('"', '""')}"`;
const management = { accessKeyId: 'management-test', accessKeySecret: 'management-test-secret' };

it.skipIf(!enabled)('desktop and mobile permissions through real loopback Nest HTTP and shared fake cloud', async () => {
  expect(process.env.BROWSER_CDP_URL).toMatch(/^ws:\/\/127\.0\.0\.1:/);
  // Drive workers explicitly so fault/retry screenshots have deterministic states.
  for (const service of [OssService, DbAccessService, AliyunGrantsService, AliyunCredentialsService, AliyunMaintenanceService, CloudIdentityStatusService])
    vi.spyOn(service.prototype, 'onModuleInit').mockImplementation(() => {});
  vi.spyOn(OssService.prototype, 'wake').mockImplementation(() => {});
  const { runPermissionsUi } = await import(pathToFileURL(resolve('../../scripts/test-permissions-ui.mjs')).href);
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const adminPool = new Pool({ connectionString: 'postgres://dev@127.0.0.1:5433/postgres' });
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
    const manager = `qa19_mgr_${suffix}`, externalOwner = `qa19_owner_${suffix}`;
    const extDb = `qa19_ext_${suffix}`, eatDb = `qa19_eat_${suffix}`;
    const dbNames = new Set([extDb, eatDb]);
    const roles = new Set([manager, externalOwner]);
    const password = randomUUID();
    const ram = new TestRamCloud(), oss = new TestOssCloud(ram);
    await mkdir('/tmp/eat-ticket19-ui', { recursive: true });
    const manifest = `/tmp/eat-ticket19-ui/pg-${suffix}.json`;
    await writeFile(manifest, JSON.stringify({ suffix, dbNames: [...dbNames], roles: [...roles] }));
    let app: NestFastifyApplication | undefined;
    try {
      await pool.query('drop schema public cascade; create schema public; drop schema if exists drizzle cascade');
      await migrate(drizzle(pool), { migrationsFolder: resolve('drizzle') });
      const module = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(RamCloud).useValue(ram).overrideProvider(OssCloud).useValue(oss).compile();
      app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
      const fastify = app.getHttpAdapter().getInstance();
      const html = await readFile(resolve('../web/dist/index.html'), 'utf8');
      fastify.addHook('onRequest', async (request: any, reply: any) => {
        if (request.method === 'GET' && !request.url.startsWith('/api') && !request.url.startsWith('/assets/'))
          return reply.type('text/html').send(html);
      });
      await app.register(import('@fastify/static') as never, { root: resolve('../web/dist/assets'), prefix: '/assets/', decorateReply: false });
      await app.listen(0, '127.0.0.1');
      const address = fastify.server.address();
      if (!address || typeof address === 'string') throw new Error('Expected a loopback TCP listener');
      expect(address.address).toBe('127.0.0.1');
      const origin = `http://127.0.0.1:${address.port}`;
      const db = app.get<Db>(DB);
      const actors: Record<string, any> = {};
      const hash = await bcrypt.hash('qa-password-19', 4);
      for (const [who, name] of Object.entries({ admin: 'QA 管理员', owner: 'QA Owner', member: 'QA 成员', other: 'QA 其他成员' })) {
        const [user] = await db.insert(schema.users).values({ name, email: `${who}@qa19.test`, role: who === 'admin' ? 'admin' : 'member', passwordHash: hash }).returning();
        actors[who] = { user };
      }
      const api = async (method: string, path: string, who = 'admin', body?: unknown, expected?: number) => {
        const response = await fetch(`${origin}${path}`, { method, headers: { ...(actors[who]?.token ? { Authorization: `Bearer ${actors[who].token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
        const result = { status: response.status, body: await response.json() as any, headers: Object.fromEntries(response.headers) };
        if (expected !== undefined) expect(result.status, `${method} ${path}: ${JSON.stringify(result.body)}`).toBe(expected);
        else expect(result.status, `${method} ${path}: ${JSON.stringify(result.body)}`).toBeLessThan(300);
        return result;
      };
      for (const who of Object.keys(actors)) Object.assign(actors[who], (await api('POST', '/api/auth/login', who, { email: `${who}@qa19.test`, password: 'qa-password-19' })).body);
      await adminPool.query(`create role ${q(manager)} login createrole createdb password '${password}'; create role ${q(externalOwner)} login password '${password}'; grant ${q(externalOwner)} to ${q(manager)} with set true, inherit false`);
      await adminPool.query(`create database ${q(extDb)} owner ${q(externalOwner)}`);
      const external = new Client({ host: '127.0.0.1', port: 5433, database: extDb, user: externalOwner, password });
      await external.connect();
      await external.query('create table reports(id serial primary key, body text); grant select on reports to public; grant create on schema public to public');
      await external.end();
      const instance = (await api('POST', '/api/db/instances', 'admin', { name: 'qa19-postgres', engine: 'postgres', host: '127.0.0.1', port: 5433, adminUser: manager, adminPassword: password })).body;
      const mysql = (await api('POST', '/api/db/instances', 'admin', { name: 'qa19-mysql', engine: 'mysql', host: '127.0.0.1', port: 3306, adminUser: manager, adminPassword: password })).body;
      const assignment = (await api('POST', '/api/db/assignments', 'owner', { instanceId: instance.id, dbName: eatDb, purpose: 'QA 应用数据' })).body;
      await api('POST', `/api/db/assignments/${assignment.id}/approve`);
      const ownerCred = (await api('POST', `/api/db/assignments/${assignment.id}/credentials`, 'owner')).body;
      roles.add(ownerCred.user);
      const owned = new Client({ host: '127.0.0.1', port: 5433, database: eatDb, user: ownerCred.user, password: ownerCred.password });
      await owned.connect();
      await owned.query('create table metrics(id serial primary key, body text); create schema analytics');
      await owned.end();
      // Keep EAT catalog unopened to exercise the Owner's first-open dialog.
      await api('PUT', '/api/admin/oss-settings', 'admin', { bucket: 'qa19-bucket', region: 'cn-beijing', ...management });
      await db.update(schema.ossSettings).set({ status: 'enabled', accountId: 'account-test' });
      const ossService = app.get(OssService);
      const spaces: Record<string, any> = {};
      for (const who of ['member', 'other']) {
        const space = (await api('POST', '/api/oss/spaces', who, { name: `QA ${who} 空间`, purpose: 'QA 迁移', requestId: randomUUID() })).body;
        await api('POST', `/api/oss/spaces/${space.id}/approve`);
        await ossService.tick();
        spaces[who] = (await api('GET', `/api/oss/spaces/${space.id}`, who)).body;
        await api('POST', '/api/oss/me/credentials', who);
      }
      // Conflict introduced at the fake RAM boundary; migration must preserve the other person's success.
      const conflictName = `eat-${actors.other.user.id.replaceAll('-', '')}`;
      await ram.createUser(management, { name: conflictName, comments: 'QA human conflict', displayName: '冲突身份' });
      await ram.createPolicy(management, 'eat-perm-' + 'x'.repeat(110), '长策略名与范围说明用于手机换行检查。'.repeat(12), '{}');
      const cloudCredentials2 = { accessKeyId: 'qa19-second', accessKeySecret: 'qa19-second-secret' };
      ram.registerAccount(cloudCredentials2, 'qa19-second-account');
      for (const c of [management, cloudCredentials2]) {
        await ram.createPolicy(c, 'eat-perm-report', '读取季度报表，权限范围仅限指定对象', JSON.stringify({ Version: '1', Statement: [{ Effect: 'Allow', Action: ['oss:GetObject'], Resource: ['acs:oss:*:*:qa19-bucket/report/*'] }] }));
        await ram.createPolicy(c, 'eat-perm-extra', '用于重试和漂移核对', '{}');
      }
      const callbacks = {
        deleteSecondExtra: () => ram.deletePolicy(cloudCredentials2, 'eat-perm-extra'),
        conflict: async (present: boolean) => { if (!present) await ram.deleteUser(management, conflictName); },
        fault: (action: string, code?: string) => code ? ram.failActions.set(action, code) : ram.failActions.delete(action),
        failCleanup: (value: boolean) => { ram.failCleanup = value; },
        driftCloud: async (userId: string, missing = true) => {
          const user = ram.users.get(`eat-${userId.replaceAll('-', '')}`)!;
          if (missing) user.attached.delete('eat-perm-report');
          else user.attached.add('eat-perm-extra');
        },
        driftDb: async (catalogId: string, userId: string) => { await adminPool.query(`revoke ${q(`eat-db-${catalogId}-read`)} from ${q(`eat-${userId}`)} granted by ${q(manager)}`); },
        blockExternalDelete: async (catalogId: string, block: boolean) => {
          const target = new Client({ connectionString: `postgres://dev@127.0.0.1:5433/${extDb}` });
          await target.connect();
          try { if (block) await target.query(`create table qa19_blocker(id int); alter table qa19_blocker owner to ${q(`eat-db-${catalogId}-read`)}`); else await target.query('drop table qa19_blocker'); }
          finally { await target.end(); }
        },
        tick: () => ossService.tick(),
        dbStatusFailure: async (fail: boolean) => { await adminPool.query(`alter role ${q(manager)} ${fail ? 'nocreaterole' : 'createrole'}`); },
        cloudState: () => [...ram.users.values()].map(u => ({ name: u.userName, keys: u.keys.map(k => ({ id: k.id, status: k.status })), attached: [...u.attached] })),
      };
      await runPermissionsUi({ origin, viewport, actors, api, callbacks, seed: { instance, mysql, assignment, extDb, eatDb, externalOwner, spaces, management, cloudCredentials2 } });
    } finally {
      // Only these per-run catalogs and personal roles belong to this harness.
      for (const row of (await pool.query('select read_role,write_role from db_catalog')).rows) { roles.add(row.read_role); roles.add(row.write_role); }
      for (const row of (await pool.query('select role_name from db_personal_role')).rows) roles.add(row.role_name);
      await writeFile(manifest, JSON.stringify({ suffix, dbNames: [...dbNames], roles: [...roles] }));
      await app?.close();
      for (const name of dbNames) await adminPool.query(`drop database if exists ${q(name)} with (force)`);
      for (const role of [...roles].reverse()) await adminPool.query(`drop role if exists ${q(role)}`);
      await writeFile(manifest, JSON.stringify({ suffix, dbNames: [...dbNames], roles: [...roles], cleaned: true }));
      await adminPool.end(); await pool.end();
    }
  }
  vi.restoreAllMocks();
});
