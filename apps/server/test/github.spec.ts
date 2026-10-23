process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://dev@127.0.0.1:5433/eat_test';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { cp, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import * as bcrypt from 'bcryptjs';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../src/app.module';
import { GithubClient, GithubError } from '../src/github/github.client';
import { GithubService } from '../src/github/github.service';
import { GithubStore, repositoryIdentity } from '../src/github/github.store';
import { WebhookService } from '../src/notify/webhook.service';
import { encryptSecret, decryptSecret } from '../src/common/crypto';
import * as s from '../src/db/schema';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool, { schema: s });
const ids = { admin: randomUUID(), owner: randomUUID(), member: randomUUID(), outsider: randomUUID() };
const gh: Record<string, string> = { admin: '100', owner: '101', member: '102', outsider: '103' };
const tokens: Record<string, string> = {};
let app: NestFastifyApplication, service: GithubService, store: GithubStore;
let appId: string;
const roles = new Map<string, string>(), direct = new Map<string, string>();
const memberships = new Map<string, any>();
const identity = (id: string) => ({ id, login: Object.keys(gh).find(k => gh[k] === id) ?? 'member' });
const client = {
  check: vi.fn(async () => '900'),
  appInfo: vi.fn(async (c: any) => ({ id: c.appId, slug: 'eat-app' })),
  findInstallation: vi.fn(async () => '2' as string | null),
  isPublic: vi.fn(async () => true as boolean | null),
  convertManifest: vi.fn(async (_code: string) => ({ appId: '10', slug: 'new-eat-app', clientId: 'new-client', clientSecret: 'new-secret', privateKey: 'new-private', organization: 'eat-org', organizationId: '900' })),
  identity: vi.fn(async (_c: any, token?: string, id?: string) => identity(id ?? token ?? '102')),
  oauth: vi.fn(async (_c: any, p: any) => ({ access_token: p.code ?? '102', refresh_token: 'refresh', expires_in: 3600 })),
  membership: vi.fn(async (_c: any, login: string) => memberships.get(login) ?? null),
  invite: vi.fn(async (_c: any, id: string) => { memberships.set(identity(id).login, { state: 'pending', role: 'member' }); }),
  accept: vi.fn(async (_c: any, token: string) => { memberships.set(identity(token).login, { state: 'active', role: 'member' }); return 200; }),
  removeOrganization: vi.fn(async (_c: any, login: string) => { memberships.delete(login); }),
  repository: vi.fn(async (_c: any, name: string) => ({ id: name.endsWith('/second') ? 901 : 9001, full_name: name, owner: { id: 900, login: 'eat-org', type: 'Organization' } })),
  permission: vi.fn(async (_c: any, repo: string, login: string) => roles.get(`${repo}:${login}`) ?? direct.get(`${repo}:${login}`) ?? 'none'),
  collaborators: vi.fn(async (_c: any, repo: string) => [...new Set([...roles.keys(), ...direct.keys()].filter(k => k.startsWith(`${repo}:`)).map(k => k.slice(repo.length + 1)))].map(login => ({ githubId: gh[login], login, role: roles.get(`${repo}:${login}`) ?? direct.get(`${repo}:${login}`), direct: direct.has(`${repo}:${login}`), roleError: '' }))),
  directRole: vi.fn(async (_c: any, repo: string, login: string) => direct.get(`${repo}:${login}`) ?? null),
  setRole: vi.fn(async (_c: any, repo: string, login: string, role: string | null) => { if (role) direct.set(`${repo}:${login}`, role); else direct.delete(`${repo}:${login}`); }),
};
async function api(method: 'GET'|'POST'|'PUT'|'DELETE'|'PATCH', path: string, who = 'admin', payload?: unknown) {
  const r = await app.inject({ method, url: path, headers: tokens[who] ? { authorization: `Bearer ${tokens[who]}` } : {}, payload: payload as never });
  return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null, headers: r.headers };
}
async function task(key = `grant:${appId}:${ids.member}`) { return (await db.select().from(s.githubTasks).where(eq(s.githubTasks.key, key)))[0]; }
async function due() { await db.update(s.githubTasks).set({ retryAt: new Date(0) }); }
async function share(who = 'owner') { return api('POST', '/api/apps/demo/members', who, { userId: ids.member }); }
async function link(who: string) {
  const r = await api('POST', '/api/account/github/authorize', who);
  const state = new URL(r.body.url).searchParams.get('state');
  const cookie = String(r.headers['set-cookie']).split(';')[0];
  return { state, cookie };
}
beforeAll(async () => {
  await pool.query('drop schema public cascade; create schema public; drop schema if exists drizzle cascade;');
  const oldFolder = await mkdtemp(join(tmpdir(), 'eat-github-migration-'));
  await cp(resolve('drizzle'), oldFolder, { recursive: true });
  const journal = JSON.parse(await readFile(join(oldFolder, 'meta/_journal.json'), 'utf8'));
  journal.entries = journal.entries.filter((e: { idx: number }) => e.idx < 29);
  await writeFile(join(oldFolder, 'meta/_journal.json'), JSON.stringify(journal));
  await migrate(drizzle(pool), { migrationsFolder: oldFolder });
  await rm(oldFolder, { recursive: true, force: true });
  const hash = await bcrypt.hash('password123', 4);
  for (const [name, id] of Object.entries(ids)) await db.insert(s.users).values({ id, name, email: `${name}@github.test`, passwordHash: hash, role: name === 'admin' ? 'admin' : 'member' });
  await pool.query('insert into app(slug,name,owner_id,dokploy_application_id,repo_url,deploy_approved) values ($1,$2,$3,$4,$5,true)',
    ['legacy-github', 'legacy', ids.owner, 'old-dok', 'https://github.com/eat-org/legacy']);
  await pool.query('insert into app_member(app_id,user_id) select id,$1 from app where slug=$2', [ids.member, 'legacy-github']);
  await migrate(drizzle(pool), { migrationsFolder: resolve('drizzle') });
  const oldApp = (await pool.query('select * from app where slug=$1', ['legacy-github'])).rows[0];
  expect(oldApp.deploy_approved).toBe(true); expect(oldApp.approved_repo_version).toBe(oldApp.repo_version);
  expect((await pool.query('select * from app_member where app_id=$1', [oldApp.id])).rows).toHaveLength(1);
  const module = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(GithubClient).useValue(client).compile();
  app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  await app.init(); await app.getHttpAdapter().getInstance().ready();
  service = app.get(GithubService); store = app.get(GithubStore);
  vi.spyOn(service, 'wake').mockImplementation(() => undefined);
  for (const name of Object.keys(ids)) tokens[name] = (await api('POST', '/api/auth/login', '', { email: `${name}@github.test`, password: 'password123' })).body.token;
});
afterAll(async () => { await app?.close(); await pool.end(); });
beforeEach(async () => {
  vi.clearAllMocks(); roles.clear(); direct.clear(); memberships.clear();
  await pool.query('TRUNCATE github_setup_state, github_task, github_grant, github_repository, github_oauth_state, github_account, github_setting, user_notification; DELETE FROM app_member; DELETE FROM app;');
  await db.update(s.users).set({ status: 'active' });
  await db.update(s.users).set({ role: 'member' }).where(sql`${s.users.id} <> ${ids.admin}`);
  await db.update(s.users).set({ role: 'admin' }).where(eq(s.users.id, ids.admin));
  await db.update(s.apiTokens).set({ revokedAt: null });
  await db.insert(s.githubSettings).values({ enabled: true, organization: 'eat-org', organizationId: '900', appId: '1', installationId: '2', clientId: 'client', clientSecretEncrypted: encryptSecret('client-secret'), privateKeyEncrypted: encryptSecret('private-key') });
  for (const [name, id] of Object.entries(ids)) {
    await db.insert(s.githubAccounts).values({ userId: id, githubId: gh[name], login: name, accessTokenEncrypted: encryptSecret(gh[name]), orgState: 'active', checkedAt: new Date() });
    memberships.set(name, { state: 'active', role: name === 'admin' ? 'admin' : 'member' });
  }
  roles.set('eat-org/demo:owner', 'maintain'); roles.set('eat-org/demo:admin', 'admin');
  const [a] = await db.insert(s.apps).values({ slug: 'demo', name: 'demo', ownerId: ids.owner, repoUrl: 'git@github.com:eat-org/demo.git',
    dokployApplicationId: 'dok-demo', managed: false, deployApproved: true, approvedRepoVersion: 1 }).returning(); appId = a.id;
});

describe('administrator GitHub App setup and recovery', () => {
  async function start(kind: 'initialize' | 'install' = 'initialize', who = 'admin') {
    const r = await api('POST', `/api/settings/github/${kind}`, who, kind === 'initialize'
      ? { organization: 'eat-org', name: 'EAT Test', replaceExisting: true } : undefined);
    expect(r.status).toBe(201);
    return { state: new URL(r.body.url).searchParams.get('state'), cookie: String(r.headers['set-cookie']).split(';')[0], response: r };
  }
  async function finish(flow: Awaited<ReturnType<typeof start>>, kind = 'manifest', extra = 'code=manifest-code') {
    const response = await app.inject({ url: `/api/github/setup/${kind}?state=${flow.state}&${extra}`, headers: { cookie: flow.cookie } });
    expect(response.statusCode).toBe(302);
    return response;
  }
  const settings = async () => (await db.select().from(s.githubSettings))[0];
  it.each([
    ['setup/manifest', '/settings?section=github&github_setup=failed'],
    ['setup/installation', '/settings?section=github&github_setup=failed'],
    ['callback', '/account?github=failed'],
  ])('returns an actual browser redirect for invalid or missing callback state: %s', async (path, target) => {
    const response = await app.inject({ url: `/api/github/${path}` });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toContain(target);
  });
  it('requires an EAT admin for every setup action', async () => {
    for (const endpoint of ['initialize', 'install', 'enabled']) {
      expect((await api('POST', `/api/settings/github/${endpoint}`, 'member', { enabled: true, organization: 'eat-org', name: 'EAT' })).status).toBe(403);
    }
    expect(client.convertManifest).not.toHaveBeenCalled();
  });
  it('builds a browser POST manifest without credentials and does not create or enable anything until callback', async () => {
    await db.delete(s.githubSettings); await db.delete(s.githubAccounts);
    const flow = await start();
    expect(flow.response.body.manifest).toMatchObject({ public: true, request_oauth_on_install: false, setup_on_update: true,
      hook_attributes: { active: false }, default_permissions: { members: 'write', administration: 'write', metadata: 'read' } });
    expect(flow.response.body.manifest.redirect_url).toContain('/api/github/setup/manifest');
    expect(flow.response.body.manifest.setup_url).toContain('/api/github/setup/installation');
    expect(flow.response.body.manifest.callback_urls[0]).toContain('/api/github/callback');
    expect(flow.response.body.url).toContain('https://github.com/organizations/eat-org/settings/apps/new?state=');
    expect(flow.response.headers['set-cookie']).toContain('HttpOnly');
    expect(flow.response.headers['set-cookie']).toContain('SameSite=Lax');
    expect(JSON.stringify(flow.response.body)).not.toContain(tokens.admin);
    expect(await settings()).toBeUndefined(); expect(client.convertManifest).not.toHaveBeenCalled();
    expect((await finish(flow)).headers.location).toContain('github_setup=created');
    const c = await settings(); expect(c.enabled).toBe(false); expect(c.installationId).toBe(''); expect(c.appSlug).toBe('new-eat-app');
    expect(decryptSecret(c.clientSecretEncrypted)).toBe('new-secret'); expect(decryptSecret(c.privateKeyEncrypted)).toBe('new-private');
    const publicSettings = JSON.stringify((await api('GET', '/api/settings/github')).body);
    expect(publicSettings).not.toContain('new-secret'); expect(publicSettings).not.toContain('new-private');
  });
  it('requires explicit replacement and preserves configuration when creation is abandoned', async () => {
    expect((await api('POST', '/api/settings/github/initialize', 'admin', { organization: 'eat-org', name: 'EAT' })).status).toBe(409);
    const old = await settings(); await start(); expect(await settings()).toEqual(old);
    expect((await api('POST', '/api/settings/github/initialize', 'admin', { organization: 'other-org', name: 'EAT', replaceExisting: true })).status).toBe(409);
  });
  it('rejects forged, wrong-kind, replayed and expired setup callbacks before exchanging codes', async () => {
    let flow = await start();
    expect((await app.inject({ url: `/api/github/setup/manifest?state=${flow.state}&code=manifest-code` })).headers.location).toContain('failed');
    expect((await finish(flow, 'installation', 'installation_id=99&setup_action=install')).headers.location).toContain('failed');
    expect(client.convertManifest).not.toHaveBeenCalled();
    expect((await finish(flow)).headers.location).toContain('created');
    expect((await finish(flow)).headers.location).toContain('failed'); expect(client.convertManifest).toHaveBeenCalledTimes(1);
    flow = await start(); await db.update(s.githubSetupStates).set({ expiresAt: new Date(0) });
    expect((await finish(flow)).headers.location).toContain('failed'); expect(client.convertManifest).toHaveBeenCalledTimes(1);
  });
  it.each(['revoked', 'demoted', 'disabled'])('rejects an administrator who was %s after starting setup', async reason => {
    const flow = await start();
    if (reason === 'revoked') await db.update(s.apiTokens).set({ revokedAt: new Date() }).where(eq(s.apiTokens.userId, ids.admin));
    if (reason === 'demoted') await db.update(s.users).set({ role: 'member' }).where(eq(s.users.id, ids.admin));
    if (reason === 'disabled') await db.update(s.users).set({ status: 'disabled' }).where(eq(s.users.id, ids.admin));
    expect((await finish(flow)).headers.location).toContain('failed'); expect(client.convertManifest).not.toHaveBeenCalled();
  });
  it('checks the admin again after the manifest exchange network request', async () => {
    const flow = await start(); const original = await settings();
    client.convertManifest.mockImplementationOnce(async () => {
      await db.update(s.users).set({ role: 'member' }).where(eq(s.users.id, ids.admin));
      return { appId: '10', slug: 'new-eat-app', clientId: 'new-client', clientSecret: 'new-secret', privateKey: 'new-private', organization: 'eat-org', organizationId: '900' };
    });
    expect((await finish(flow)).headers.location).toContain('failed'); expect(await settings()).toEqual(original);
  });
  it('does not overwrite settings changed by another administrator', async () => {
    const flow = await start(); await api('POST', '/api/settings/github/enabled', 'admin', { enabled: false });
    expect((await finish(flow)).headers.location).toContain('failed'); expect(client.convertManifest).not.toHaveBeenCalled();
    expect((await settings()).appId).toBe('1');
  });
  it('rejects a newly created App for another organization', async () => {
    const flow = await start();
    client.convertManifest.mockResolvedValueOnce({ appId: '10', slug: 'new-eat-app', clientId: 'new-client', clientSecret: 'new-secret', privateKey: 'new-private', organization: 'other-org', organizationId: '901' });
    expect((await finish(flow)).headers.location).toContain('failed'); expect((await settings()).appId).toBe('1');
  });
  it('reinitializes without deleting EAT membership, approval, GitHub identities or managed grants', async () => {
    await share(); await service.tick();
    const userFlow = await link('member');
    const accounts = await db.select().from(s.githubAccounts), grants = await db.select().from(s.githubGrants);
    const flow = await start(); expect((await finish(flow)).headers.location).toContain('created');
    const after = await db.select().from(s.githubAccounts);
    expect(after.map(a => a.githubId).sort()).toEqual(accounts.map(a => a.githubId).sort());
    for (const a of after) { expect(a.accessTokenEncrypted).toBe(''); expect(a.refreshTokenEncrypted).toBeNull(); expect(a.needsAuthorization).toBe(true); expect(a.version).not.toBe(accounts.find(old => old.userId === a.userId)!.version); }
    expect((await db.select().from(s.appMembers))).toHaveLength(1);
    expect((await db.select().from(s.apps))[0].deployApproved).toBe(true);
    expect(await db.select().from(s.githubGrants)).toEqual(grants); expect((await task()).state).toBe('cancelled');
    expect((await app.inject({ url: `/api/github/callback?code=102&state=${userFlow.state}`, headers: { cookie: userFlow.cookie } })).headers.location).toContain('failed');
    expect((await settings()).enabled).toBe(false);
  });
  it('reinstalls the same App and updates only installation configuration, preserving account credentials', async () => {
    await share(); const accounts = await db.select().from(s.githubAccounts), before = await settings();
    const flow = await start('install');
    expect(flow.response.body.url).toContain('https://github.com/apps/eat-app/installations/new?state=');
    expect(flow.response.body.url).not.toContain(tokens.admin);
    expect((await finish(flow, 'installation', 'installation_id=99&setup_action=install')).headers.location).toContain('installed');
    expect(client.check).toHaveBeenCalledWith(expect.objectContaining({ appId: '1', organization: 'eat-org', organizationId: '900', installationId: '99' }));
    expect((await settings())).toMatchObject({ appId: before.appId, installationId: '99', enabled: true, connectionState: 'connected', privateKeyEncrypted: before.privateKeyEncrypted });
    expect(await db.select().from(s.githubAccounts)).toEqual(accounts); expect((await task()).state).toBe('pending');
    expect((await finish(flow, 'installation', 'installation_id=88&setup_action=install')).headers.location).toContain('failed');
    expect((await settings()).installationId).toBe('99');
  });
  it('does not bind a wrong-org or insufficient-permission installation', async () => {
    const flow = await start('install'); client.check.mockRejectedValueOnce(new GithubError('安装不属于配置的 GitHub 组织'));
    expect((await finish(flow, 'installation', 'installation_id=99&setup_action=install')).headers.location).toContain('failed');
    expect((await settings()).installationId).toBe('2');
    expect((await settings()).connectionError).toContain('组织');
  });
  it('does not enable a pending installation request', async () => {
    await db.update(s.githubSettings).set({ enabled: false });
    const flow = await start('install');
    expect((await finish(flow, 'installation', 'setup_action=request')).headers.location).toContain('requested');
    expect(client.check).not.toHaveBeenCalled(); expect((await settings()).enabled).toBe(false);
  });
  it('reports uninstall without erasing the App and discovers a new installation after a lost callback', async () => {
    const before = await settings();
    client.findInstallation.mockResolvedValueOnce(null);
    expect((await api('POST', '/api/settings/github/check')).status).toBe(400);
    expect(await settings()).toMatchObject({ appId: before.appId, privateKeyEncrypted: before.privateKeyEncrypted, connectionState: 'uninstalled' });
    client.findInstallation.mockResolvedValueOnce('99');
    expect((await api('POST', '/api/settings/github/check')).status).toBe(201);
    expect(await settings()).toMatchObject({ appId: before.appId, installationId: '99', connectionState: 'connected' });
    expect(client.convertManifest).not.toHaveBeenCalled();
  });
  it('rejects a private App because non-members cannot authorize it, and ignores an unknown visibility', async () => {
    client.isPublic.mockResolvedValueOnce(false);
    const r = await api('POST', '/api/settings/github/check');
    expect(r.status).toBe(400); expect(r.body.message).toContain('Make public');
    expect(client.isPublic).toHaveBeenLastCalledWith('eat-app');
    expect(await settings()).toMatchObject({ appId: '1', connectionState: 'private' });
    client.isPublic.mockResolvedValueOnce(false);
    expect((await api('POST', '/api/settings/github/enabled', 'admin', { enabled: true })).status).toBe(400);
    client.isPublic.mockResolvedValueOnce(null);
    expect((await api('POST', '/api/settings/github/check')).status).toBe(201);
    expect(await settings()).toMatchObject({ connectionState: 'connected', connectionError: '' });
  });
  it('reports App or credential unavailability without assuming deletion or replacing configuration', async () => {
    client.appInfo.mockRejectedValueOnce(new GithubError('App 或私钥失效', false, 0, 'app_unavailable'));
    expect((await api('POST', '/api/settings/github/install')).status).toBe(400);
    expect(await settings()).toMatchObject({ appId: '1', connectionState: 'app_unavailable' });
    expect((await db.select().from(s.githubAccounts)).every(a => !a.needsAuthorization)).toBe(true);
  });
  it('allows advanced settings to bind a verified new installation of the same App', async () => {
    const accounts = await db.select().from(s.githubAccounts);
    expect((await api('PUT', '/api/settings/github', 'admin', { enabled: true, organization: 'eat-org', appId: '1', clientId: 'client', installationId: '99' })).status).toBe(200);
    expect(client.check).toHaveBeenCalledWith(expect.objectContaining({ installationId: '99' }));
    expect(await db.select().from(s.githubAccounts)).toEqual(accounts);
  });
});

describe('GitHub binding and organization membership', () => {
  it('configuration defaults disabled and secrets never appear in public settings', async () => {
    const settings = await api('GET', '/api/settings/github');
    expect(JSON.stringify(settings.body)).not.toContain('client-secret');
    expect(JSON.stringify(settings.body)).not.toContain('private-key');
    expect(settings.body.hasPrivateKey).toBe(true);
    expect((await api('GET', '/api/settings/github', 'member')).status).toBe(403);
    await db.delete(s.githubSettings);
    expect((await api('GET', '/api/settings/github')).body.enabled).toBe(false);
  });
  it('prevents changing organization with bound accounts', async () => {
    const r = await api('PUT', '/api/settings/github', 'admin', { enabled: true, organization: 'other-org', appId: '1', clientId: 'client', installationId: '2' });
    expect(r.status).toBe(409);
  });
  it('binds with a one-time browser-bound callback and queues joining', async () => {
    await db.delete(s.githubAccounts).where(eq(s.githubAccounts.userId, ids.member)); memberships.delete('member');
    const { state, cookie } = await link('member');
    expect(cookie).toContain('eat_github_browser=');
    expect(state).not.toContain(tokens.member);
    const url = `/api/github/callback?code=102&iss=https%3A%2F%2Fgithub.com%2Flogin%2Foauth&state=${state}`;
    const forged = await app.inject({ url }); expect(forged.headers.location).toContain('failed');
    const good = await app.inject({ url, headers: { cookie } }); expect(good.headers.location).toContain('linked');
    const replay = await app.inject({ url, headers: { cookie } }); expect(replay.headers.location).toContain('failed');
    for (const response of [forged, good, replay]) {
      expect(response.statusCode).toBe(302);
      const destination = new URL(response.headers.location!);
      expect(destination.pathname).toBe('/account');
      expect(destination.search).toBe(`?github=${response === good ? 'linked' : 'failed'}`);
    }
    await service.tick();
    expect(client.invite).toHaveBeenCalledTimes(1); expect(client.accept).toHaveBeenCalledTimes(1);
    expect((await service.accountInfo(ids.member)).orgState).toBe('active');
  });
  it('rejects expired states, duplicate GitHub identity and revoked EAT sessions', async () => {
    await db.delete(s.githubAccounts).where(eq(s.githubAccounts.userId, ids.member));
    let flow = await link('member'); await db.update(s.githubOauthStates).set({ expiresAt: new Date(0) });
    expect((await app.inject({ url: `/api/github/callback?code=102&state=${flow.state}`, headers: { cookie: flow.cookie } })).headers.location).toContain('failed');
    flow = await link('member');
    expect((await app.inject({ url: `/api/github/callback?code=101&state=${flow.state}`, headers: { cookie: flow.cookie } })).headers.location).toContain('failed');
    flow = await link('member'); await db.update(s.apiTokens).set({ revokedAt: new Date() }).where(eq(s.apiTokens.userId, ids.member));
    expect((await app.inject({ url: `/api/github/callback?code=102&state=${flow.state}`, headers: { cookie: flow.cookie } })).headers.location).toContain('failed');
  });
  it('reuses pending invitations and supports asynchronous acceptance', async () => {
    memberships.set('member', { state: 'pending', role: 'member' });
    client.accept.mockImplementationOnce(async () => 202);
    await api('POST', `/api/users/${ids.member}/github`, 'admin', { action: 'join' });
    await service.tick();
    expect(client.invite).not.toHaveBeenCalled();
    expect((await service.accountInfo(ids.member)).orgState).toBe('processing');
    expect((await task(`account:${ids.member}`)).state).toBe('waiting');
    memberships.set('member', { state: 'active', role: 'member' }); await due(); await service.tick();
    expect((await task(`account:${ids.member}`)).state).toBe('succeeded');
  });
  it('unlink cancels queued authorization, preserves organization membership and rejects old callbacks', async () => {
    await share(); const flow = await link('member');
    await api('DELETE', '/api/account/github', 'member'); await service.tick();
    expect((await task()).state).toBe('cancelled'); expect(client.setRole).not.toHaveBeenCalled();
    expect(memberships.get('member').state).toBe('active');
    expect((await app.inject({ url: `/api/github/callback?code=102&state=${flow.state}`, headers: { cookie: flow.cookie } })).headers.location).toContain('failed');
  });
  it('failed membership query is unknown, not absent', async () => {
    client.membership.mockRejectedValueOnce(new GithubError('network', true));
    await api('POST', '/api/account/github/refresh', 'member'); await service.tick();
    expect((await service.accountInfo(ids.member)).orgState).toBe('unknown');
  });
  it('expired token without refresh prompts reauthorization', async () => {
    memberships.set('member', { state: 'pending', role: 'member' });
    await db.update(s.githubAccounts).set({ expiresAt: new Date(0) }).where(eq(s.githubAccounts.userId, ids.member));
    await api('POST', '/api/account/github/accept', 'member'); await service.tick();
    expect((await service.accountInfo(ids.member)).needsAuthorization).toBe(true);
    expect((await task(`account:${ids.member}`)).state).toBe('failed');
  });
  it('an administrator can cancel invitations without changing EAT membership', async () => {
    await share(); memberships.set('member', { state: 'pending' });
    await api('POST', `/api/users/${ids.member}/github`, 'admin', { action: 'remove-org' }); await service.tick();
    expect(client.removeOrganization).toHaveBeenCalled();
    expect((await db.select().from(s.appMembers).where(eq(s.appMembers.userId, ids.member))).length).toBe(1);
  });
});

describe('approval, authority and isolated failure', () => {
  it('blocks sharing unapproved apps even for EAT administrators', async () => {
    await db.update(s.apps).set({ deployApproved: false, approvedRepoVersion: null });
    expect((await share()).status).toBe(403); expect((await share('admin')).status).toBe(403);
    expect(await db.select().from(s.appMembers)).toHaveLength(0);
  });
  it('preserves EAT sharing when GitHub is unavailable', async () => {
    client.setRole.mockRejectedValueOnce(new GithubError('network', true));
    expect((await share()).status).toBe(201); await service.tick();
    expect(await db.select().from(s.appMembers)).toHaveLength(1);
    expect((await task()).state).toBe('pending'); expect((await task()).attempts).toBe(1);
  });
  it('Maintain can grant Write but cannot modify roles', async () => {
    await share(); await service.tick();
    expect(direct.get('eat-org/demo:member')).toBe('write');
    expect((await api('PUT', `/api/apps/demo/github/members/${ids.member}/role`, 'owner', { role: 'admin' })).status).toBe(403);
  });
  it('Write cannot grant, but the EAT membership remains; unauthorized retries do not replace work', async () => {
    roles.set('eat-org/demo:owner', 'write'); await share();
    const original = await task();
    expect((await api('POST', `/api/apps/demo/github/members/${ids.member}/retry`, 'outsider')).status).toBe(403);
    expect((await task()).generation).toBe(original.generation);
    await service.tick(); expect((await task()).state).toBe('failed'); expect(client.setRole).not.toHaveBeenCalled();
    expect(await db.select().from(s.appMembers)).toHaveLength(1);
  });
  it('EAT admin can grant without linking their own GitHub account', async () => {
    await db.delete(s.githubAccounts).where(eq(s.githubAccounts.userId, ids.admin));
    await share('admin'); await service.tick(); expect(direct.get('eat-org/demo:member')).toBe('write');
  });
  it('waits for an unlinked target and later for organization acceptance', async () => {
    await db.delete(s.githubAccounts).where(eq(s.githubAccounts.userId, ids.member));
    await share(); await service.tick(); expect((await task()).state).toBe('waiting');
    expect(client.setRole).not.toHaveBeenCalled();
  });
  it('never downgrades higher roles on automatic sharing', async () => {
    roles.set('eat-org/demo:member', 'maintain'); await share(); await service.tick();
    expect(client.setRole).not.toHaveBeenCalled(); expect((await task()).state).toBe('succeeded');
  });
  it('supports explicit role changes and reports inherited effective permissions', async () => {
    await share('admin'); await service.tick();
    roles.set('eat-org/demo:member', 'maintain');
    await api('PUT', `/api/apps/demo/github/members/${ids.member}/role`, 'admin', { role: 'read' }); await due(); await service.tick();
    expect(direct.get('eat-org/demo:member')).toBe('read');
    expect((await task()).error).toContain('实际角色仍为 maintain');
  });
  it('requires approval again on repository changes, normalizes equivalent GitHub URLs', async () => {
    expect(repositoryIdentity('git@github.com:eat-org/demo.git')).toBe(repositoryIdentity('https://github.com/eat-org/demo'));
    expect((await api('PATCH', '/api/apps/demo', 'owner', { repoUrl: 'https://github.com/eat-org/demo' })).body.deployApproved).toBe(true);
    const r = await api('PATCH', '/api/apps/demo', 'owner', { repoUrl: 'https://github.com/eat-org/second' });
    expect(r.status).toBe(200); expect(r.body.deployApproved).toBe(false); expect((await share()).status).toBe(403);
    expect((await api('POST', '/api/apps/demo/approve')).body.deployApproved).toBe(true);
  });
  it('never grants on personal or other organization repositories', async () => {
    await db.update(s.apps).set({ repoUrl: 'https://github.com/personal/demo' });
    await share(); await service.tick(); expect(client.setRole).not.toHaveBeenCalled(); expect((await task()).error).toContain('指定组织');
  });
  it('checks user and repository again after queueing', async () => {
    await share(); await db.update(s.users).set({ status: 'disabled' }).where(eq(s.users.id, ids.owner));
    await service.tick(); expect(client.setRole).not.toHaveBeenCalled();
  });
});

describe('durability, revocation and notification', () => {
  it('removal cancels stale grants and only revokes EAT-created direct access', async () => {
    await share(); await service.tick(); expect(direct.get('eat-org/demo:member')).toBe('write');
    await api('DELETE', `/api/apps/demo/members/${ids.member}`, 'owner'); await service.tick();
    expect(direct.has('eat-org/demo:member')).toBe(false); expect((await task()).state).toBe('cancelled');
  });
  it('preserves access while another app still requires it', async () => {
    await share(); await service.tick();
    const [other] = await db.insert(s.apps).values({ slug: 'other', name: 'other', repoUrl: 'https://github.com/eat-org/demo', ownerId: ids.owner, dokployApplicationId: 'other', deployApproved: true, approvedRepoVersion: 1 }).returning();
    await db.insert(s.appMembers).values({ appId: other.id, userId: ids.member });
    await api('DELETE', `/api/apps/demo/members/${ids.member}`, 'owner'); await service.tick();
    expect(direct.get('eat-org/demo:member')).toBe('write');
  });
  it('retries transient revocation failures and respects the provider waiting time', async () => {
    await share(); await service.tick();
    await api('DELETE', `/api/apps/demo/members/${ids.member}`, 'owner');
    client.setRole.mockRejectedValueOnce(new GithubError('rate limited', true, 180000));
    const started = Date.now();
    await service.tick();
    const pending = await task('cleanup');
    expect(pending.state).toBe('pending'); expect(pending.attempts).toBe(1);
    expect(pending.retryAt.getTime()).toBeGreaterThanOrEqual(started + 180000);
    expect(pending.notification).toBe('');
    expect(direct.get('eat-org/demo:member')).toBe('write');
    await due(); await service.tick();
    expect((await task('cleanup')).state).toBe('succeeded');
    expect(direct.has('eat-org/demo:member')).toBe(false);
  });
  it('does not remove external grants changed after EAT wrote them', async () => {
    await share(); await service.tick(); direct.set('eat-org/demo:member', 'admin');
    await api('DELETE', `/api/apps/demo/members/${ids.member}`, 'owner'); await service.tick();
    expect(direct.get('eat-org/demo:member')).toBe('admin'); expect((await service.cleanupState()).grants[0].error).toContain('手动撤权');
  });
  it('does not silently restore an uncertain pre-existing direct grant', async () => {
    direct.set('eat-org/demo:member', 'read'); await share(); await service.tick();
    await api('DELETE', `/api/apps/demo/members/${ids.member}`, 'owner'); await service.tick();
    expect(direct.get('eat-org/demo:member')).toBe('write'); expect((await service.cleanupState()).grants[0].error).toContain('来源不明确');
  });
  it('disabled integration does not execute queued tasks', async () => {
    await share(); await db.update(s.githubSettings).set({ enabled: false }); await service.tick();
    expect(client.check).not.toHaveBeenCalled(); expect(client.setRole).not.toHaveBeenCalled();
  });
  it('serializes worker instances with a PostgreSQL advisory lock', async () => {
    await share(); let release!: () => void;
    client.setRole.mockImplementationOnce(async () => { await new Promise<void>(r => { release = r; }); });
    const first = service.tick();
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    await service.tick(); expect(client.setRole).toHaveBeenCalledTimes(1);
    release(); await first;
  });
  it('records a failed notification and does not notify repeatedly', async () => {
    await db.insert(s.userNotifications).values({ userId: ids.admin, webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/test', verifiedAt: new Date() });
    const send = vi.spyOn(app.get(WebhookService), 'sendCardOnce').mockRejectedValue(new Error('down'));
    roles.set('eat-org/demo:owner', 'write'); await share(); await service.tick(); await service.tick();
    expect((await task()).notification).toContain('投递失败'); expect(send).toHaveBeenCalledTimes(1); send.mockRestore();
  });
  it('observes a timed-out but successful provider mutation before retrying', async () => {
    client.setRole.mockImplementationOnce(async (_c, repo, login, role) => { direct.set(`${repo}:${login}`, role!); throw new GithubError('timeout', true); });
    await share(); await service.tick(); await due(); await service.tick();
    expect((await task()).state).toBe('succeeded'); expect(direct.get('eat-org/demo:member')).toBe('write');
    expect(client.setRole).toHaveBeenCalledTimes(1);
  });
});


describe('recovery edge cases and read-only views', () => {
  it('identifies a pre-write role read failure and does not send an authorization write', async () => {
    client.permission.mockRejectedValueOnce(new GithubError('角色解析失败'));
    await share('admin'); await service.tick();
    expect((await task()).error).toBe('读取目标当前仓库角色：角色解析失败');
    expect(client.setRole).not.toHaveBeenCalled();
  });
  it('distinguishes a failed post-write verification from a failure to grant access', async () => {
    client.permission.mockResolvedValueOnce('none').mockRejectedValueOnce(new GithubError('角色解析失败'));
    await share('admin'); await service.tick();
    expect((await task()).error).toBe('授权后核验（已提交角色变更）：角色解析失败');
    expect(direct.get('eat-org/demo:member')).toBe('write');
    expect(client.setRole).toHaveBeenCalledTimes(1);
  });
  it('lists the application owner once, distinguishes no access from unlinked, and exposes viewer capabilities', async () => {
    await db.insert(s.appMembers).values([{ appId, userId: ids.owner }, { appId, userId: ids.member }, { appId, userId: ids.outsider }]);
    await service.unlink(ids.outsider);
    await api('POST', '/api/apps/demo/github/refresh'); await service.tick();
    const r = await api('GET', '/api/apps/demo/github', 'owner');
    expect(r.body.members.filter((m: any) => m.userId === ids.owner)).toHaveLength(1);
    expect(r.body.members[0]).toMatchObject({ userId: ids.owner, isOwner: true, role: 'maintain', canGrant: true, canChangeRole: false });
    expect(r.body.members.find((m: any) => m.userId === ids.member)).toMatchObject({ role: 'none', login: 'member', isOwner: false });
    expect(r.body.members.find((m: any) => m.userId === ids.outsider)).toMatchObject({ role: 'unknown', login: null, state: 'unlinked' });
  });
  it('keeps the last observed role on query failure without calling it current or absent', async () => {
    await api('POST', '/api/apps/demo/github/refresh'); await service.tick();
    client.permission.mockRejectedValueOnce(new GithubError('角色查询失败'));
    await api('POST', '/api/apps/demo/github/refresh'); await service.tick();
    let r = await api('GET', '/api/apps/demo/github');
    expect(r.body.members[0]).toMatchObject({ role: 'maintain', roleError: '角色查询失败' });
    expect(r.body.members[0].roleCheckedAt).toBeTruthy();
    expect(r.body.ownerRole).toBe('maintain');
    const repository = client.repository.getMockImplementation()!;
    client.repository.mockRejectedValue(new GithubError('仓库查询失败', true));
    try {
      await api('POST', '/api/apps/demo/github/refresh'); await service.tick();
      r = await api('GET', '/api/apps/demo/github');
      expect(r.body.scope).toBe('unknown');
      expect(r.body.members[0]).toMatchObject({ role: 'maintain', canGrant: false, canChangeRole: false });
      expect(r.body.error).toBe('仓库查询失败');
    } finally { client.repository.mockImplementation(repository); }
  });
  it('drops cached roles and task errors after unlink and requires rechecking even a same-login rebind', async () => {
    await share('admin'); await service.tick(); await service.tick();
    await service.unlink(ids.member);
    let member = (await api('GET', '/api/apps/demo/github')).body.members.find((m: any) => m.userId === ids.member);
    expect(member).toMatchObject({ login: null, role: 'unknown', state: 'unlinked', error: '', roleCheckedAt: null });
    expect(direct.get('eat-org/demo:member')).toBe('write');
    expect(await db.select().from(s.appMembers).where(eq(s.appMembers.userId, ids.member))).toHaveLength(1);
    const flow = await link('member');
    await app.inject({ url: `/api/github/callback?code=102&state=${flow.state}`, headers: { cookie: flow.cookie } });
    member = (await api('GET', '/api/apps/demo/github')).body.members.find((m: any) => m.userId === ids.member);
    expect(member).toMatchObject({ login: 'member', role: 'unknown', error: '' });
    await service.tick(); await service.tick();
    member = (await api('GET', '/api/apps/demo/github')).body.members.find((m: any) => m.userId === ids.member);
    expect(member.role).toBe('write');
  });
  it('reports a failed connection check while retaining the previous role for display', async () => {
    await api('POST', '/api/apps/demo/github/refresh'); await service.tick();
    client.check.mockRejectedValueOnce(new GithubError('安装连接暂不可用'));
    await api('POST', '/api/apps/demo/github/refresh'); await service.tick();
    const r = await api('GET', '/api/apps/demo/github');
    expect(r.body.members[0]).toMatchObject({ role: 'maintain', roleError: '安装连接暂不可用' });
  });
  it('rechecks a shared repository after a role operation in another app without inventing the new role', async () => {
    await db.insert(s.appMembers).values({ appId, userId: ids.member });
    await db.insert(s.apps).values({ slug: 'shared-repo', name: 'shared', ownerId: ids.member, repoUrl: 'https://github.com/eat-org/demo',
      dokployApplicationId: 'shared-dok', deployApproved: true, approvedRepoVersion: 1 });
    await api('POST', '/api/apps/demo/github/refresh');
    await api('POST', '/api/apps/shared-repo/github/refresh'); await service.tick();
    await api('PUT', `/api/apps/demo/github/members/${ids.member}/role`, 'admin', { role: 'write' }); await service.tick();
    let r = await api('GET', '/api/apps/shared-repo/github');
    expect(r.body.members[0]).toMatchObject({ role: 'none', state: 'verifying' });
    await service.tick();
    r = await api('GET', '/api/apps/shared-repo/github');
    expect(r.body.members[0]).toMatchObject({ role: 'write', state: 'succeeded' });
  });
  it('explicit add selects Write for Maintain without retrying an earlier failed Admin request', async () => {
    await db.insert(s.appMembers).values({ appId, userId: ids.member });
    client.setRole.mockRejectedValueOnce(new GithubError('暂时不可用'));
    await api('PUT', `/api/apps/demo/github/members/${ids.member}/role`, 'admin', { role: 'admin' });
    await service.tick(); expect((await task()).state).toBe('failed');
    expect((await api('POST', `/api/apps/demo/github/members/${ids.member}/add`, 'owner', { role: 'write' })).status).toBe(201);
    expect((await task()).kind).toBe('grant'); expect((await task()).payload.role).toBeUndefined();
    await service.tick(); expect(direct.get('eat-org/demo:member')).toBe('write');
    expect((await api('POST', `/api/apps/demo/github/members/${ids.member}/add`, 'owner', { role: 'admin' })).status).toBe(403);
    expect((await api('POST', `/api/apps/demo/github/members/${ids.member}/add`, 'member', { role: 'write' })).status).toBe(403);
    expect((await api('POST', `/api/apps/demo/github/members/${ids.member}/add`, 'admin', { role: 'invalid' })).status).toBe(400);
    expect((await api('POST', `/api/apps/demo/github/members/${ids.member}/add`, 'admin', { role: 'read' })).status).toBe(201);
    await service.tick(); expect(direct.get('eat-org/demo:member')).toBe('read');
  });
  it('shows repository and owner roles to reviewers without changing provider permissions', async () => {
    await api('GET', '/api/apps/demo/github'); await service.tick();
    const r = await api('GET', '/api/apps/demo/github');
    expect(r.body).toMatchObject({ scope: 'organization', ownerLogin: 'owner', ownerRole: 'maintain', repositoryId: '9001' });
    expect(r.body.members.find((m: any) => m.userId === ids.owner)).toMatchObject({ role: 'maintain', canChangeRole: true });
    expect(client.setRole).not.toHaveBeenCalled();
  });
  it('repository Admin outside EAT membership gets role-management controls after verification', async () => {
    roles.set('eat-org/demo:outsider', 'admin');
    await api('GET', '/api/apps/demo/github', 'outsider'); await service.tick();
    const r = await api('GET', '/api/apps/demo/github', 'outsider');
    expect(r.body.members[0].canChangeRole).toBe(true);
    expect(r.body.members.some((m: any) => m.userId === ids.outsider)).toBe(false);
  });
  it('retries transient automatic work at most five times, with one terminal notification', async () => {
    client.setRole.mockRejectedValue(new GithubError('network', true, 90000));
    try {
      await share();
      for (let i = 0; i < 5; i++) { await due(); await service.tick(); }
      expect((await task()).attempts).toBe(5); expect((await task()).state).toBe('failed');
      expect((await task()).notification).toContain('没有管理员');
    } finally {
      client.setRole.mockImplementation(async (_c, repo, login, role) => { if (role) direct.set(`${repo}:${login}`, role); else direct.delete(`${repo}:${login}`); });
    }
  });
  it('manual retries make one attempt, duplicate clicks are merged', async () => {
    await share(); await service.tick(); direct.delete('eat-org/demo:member');
    client.setRole.mockRejectedValueOnce(new GithubError('network', true));
    await api('POST', `/api/apps/demo/github/members/${ids.member}/retry`);
    const before = await task(); await api('POST', `/api/apps/demo/github/members/${ids.member}/retry`);
    expect((await task()).generation).toBe(before.generation);
    await due(); await service.tick(); expect((await task()).state).toBe('failed'); expect((await task()).attempts).toBe(1);
  });
  it('retains the requested role when manually retrying a role change', async () => {
    await share(); await service.tick();
    client.setRole.mockRejectedValueOnce(new GithubError('network', true));
    await api('PUT', `/api/apps/demo/github/members/${ids.member}/role`, 'admin', { role: 'read' });
    await due(); await service.tick(); expect((await task()).state).toBe('failed');
    await api('POST', `/api/apps/demo/github/members/${ids.member}/retry`);
    expect((await task()).payload.role).toBe('read');
    await service.tick(); expect(direct.get('eat-org/demo:member')).toBe('read');
  });
  it('reconciles removal during an in-flight grant and does not restore a cancelled task', async () => {
    await share(); let release!: () => void;
    client.setRole.mockImplementationOnce(async (_c, repo, login, role) => {
      await new Promise<void>(r => { release = r; }); direct.set(`${repo}:${login}`, role!);
    });
    const running = service.tick(); await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    await api('DELETE', `/api/apps/demo/members/${ids.member}`, 'owner'); release(); await running;
    await service.tick(); expect(direct.has('eat-org/demo:member')).toBe(false); expect((await task()).state).toBe('cancelled');
  });
  it('user disable invalidates grants and schedules durable cleanup', async () => {
    await share(); await service.tick();
    await api('PATCH', `/api/users/${ids.member}`, 'admin', { status: 'disabled' });
    await service.tick(); expect(direct.has('eat-org/demo:member')).toBe(false);
    expect((await task()).state).toBe('cancelled');
  });
  it('application deletion keeps cleanup identifiers after the app disappears', async () => {
    await share(); await service.tick();
    await api('DELETE', '/api/apps/demo', 'owner'); await service.tick();
    expect(direct.has('eat-org/demo:member')).toBe(false);
  });
  it('refresh-token failure requests reauthorization without losing EAT membership', async () => {
    memberships.set('member', { state: 'pending' });
    await db.update(s.githubAccounts).set({ expiresAt: new Date(0), refreshTokenEncrypted: encryptSecret('expired') }).where(eq(s.githubAccounts.userId, ids.member));
    client.oauth.mockRejectedValueOnce(new GithubError('expired'));
    await api('POST', '/api/account/github/accept', 'member'); await service.tick();
    expect((await service.accountInfo(ids.member)).needsAuthorization).toBe(true);
  });
});

describe('complete repository user list and direct access changes', () => {
  const endpoint = '/api/apps/demo/github/collaborators';
  const change = (who = 'admin', githubId = gh.member, role: string | null = null, extra = {}) =>
    api('PUT', `${endpoint}/${githubId}`, who, { repositoryId: '9001', repoVersion: 1, expectedRole: 'write', role, ...extra });
  it('includes application members, other EAT users and unlinked GitHub users, matched by immutable id', async () => {
    await db.insert(s.appMembers).values({ appId, userId: ids.member });
    direct.set('eat-org/demo:member', 'write'); direct.set('eat-org/demo:outsider', 'read');
    await db.update(s.githubAccounts).set({ login: 'old-member-name' }).where(eq(s.githubAccounts.userId, ids.member));
    await db.delete(s.githubAccounts).where(eq(s.githubAccounts.userId, ids.outsider));
    const r = await api('GET', endpoint);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ repositoryId: '9001', repoVersion: 1, canManage: true });
    expect(r.body.collaborators).toEqual(expect.arrayContaining([
      expect.objectContaining({ githubId: gh.owner, relation: 'owner' }),
      expect.objectContaining({ githubId: gh.member, userId: ids.member, relation: 'member', direct: true }),
      expect.objectContaining({ githubId: gh.admin, relation: 'eat' }),
      expect.objectContaining({ githubId: gh.outsider, userId: null, relation: 'external' }),
    ]));
  });
  it('keeps a removed EAT member with remaining direct access in the normal repository list', async () => {
    await share(); direct.set('eat-org/demo:member', 'write');
    await api('DELETE', `/api/apps/demo/members/${ids.member}`);
    const r = await api('GET', endpoint);
    expect(r.body.collaborators.find((m: any) => m.githubId === gh.member)).toMatchObject({ relation: 'eat', role: 'write', direct: true });
    expect(r.body.collaborators.find((m: any) => m.githubId === gh.member)).not.toHaveProperty('state');
  });
  it('allows an unlinked EAT admin to remove direct access while preserving app membership and inherited access', async () => {
    await share(); direct.set('eat-org/demo:member', 'write'); roles.set('eat-org/demo:member', 'write');
    await db.delete(s.githubAccounts).where(eq(s.githubAccounts.userId, ids.admin));
    const r = await change();
    expect(r.status).toBe(200); expect(r.body).toMatchObject({ direct: false, role: 'write' });
    expect((await db.select().from(s.appMembers).where(eq(s.appMembers.userId, ids.member)))).toHaveLength(1);
    expect((await task()).state).toBe('cancelled');
    await due(); await service.tick();
    expect(direct.has('eat-org/demo:member')).toBe(false);
  });
  it('edits a direct collaborator without an EAT account', async () => {
    await db.delete(s.githubAccounts).where(eq(s.githubAccounts.userId, ids.outsider));
    direct.set('eat-org/demo:outsider', 'write');
    const r = await change('admin', gh.outsider, 'maintain');
    expect(r.status).toBe(200); expect(direct.get('eat-org/demo:outsider')).toBe('maintain');
  });
  it('does not let an application owner with Maintain modify or remove repository users', async () => {
    direct.set('eat-org/demo:member', 'write');
    expect((await change('owner')).status).toBe(403);
    expect((await change('owner', gh.member, 'admin')).status).toBe(403);
    expect(client.setRole).not.toHaveBeenCalled();
  });
  it('allows a linked GitHub Admin even when they are not an application member', async () => {
    roles.set('eat-org/demo:outsider', 'admin'); direct.set('eat-org/demo:member', 'write');
    expect((await change('outsider')).status).toBe(200);
  });
  it.each([
    { repositoryId: '999' }, { repoVersion: 2 }, { expectedRole: 'admin' },
  ])('rejects a stale confirmation before writing: %j', async extra => {
    direct.set('eat-org/demo:member', 'write');
    expect((await change('admin', gh.member, null, extra)).status).toBe(409);
    expect(client.setRole).not.toHaveBeenCalled();
  });
  it('rejects inherited-only users and organization owners', async () => {
    roles.set('eat-org/demo:member', 'write');
    expect((await change()).status).toBe(409);
    direct.set('eat-org/demo:member', 'write'); memberships.set('member', { state: 'active', role: 'admin' });
    expect((await change()).status).toBe(403); expect(client.setRole).not.toHaveBeenCalled();
  });
  it('keeps actual access visible after a failed provider write and permits a fresh manual retry', async () => {
    direct.set('eat-org/demo:member', 'write');
    client.setRole.mockRejectedValueOnce(new GithubError('GitHub 请求失败'));
    expect((await change()).status).toBe(400);
    expect((await api('GET', endpoint)).body.collaborators.find((m: any) => m.githubId === gh.member)).toMatchObject({ direct: true, role: 'write' });
    expect((await change()).status).toBe(200);
    expect(direct.has('eat-org/demo:member')).toBe(false);
  });
  it('rejects a concurrent repo change and a demoted admin after provider reads', async () => {
    direct.set('eat-org/demo:member', 'write');
    client.directRole.mockImplementationOnce(async () => { await db.update(s.apps).set({ repoVersion: 2 }).where(eq(s.apps.id, appId)); return 'write'; });
    expect((await change()).status).toBe(409);
    await db.update(s.apps).set({ repoVersion: 1 }).where(eq(s.apps.id, appId));
    client.directRole.mockImplementationOnce(async () => { await db.update(s.users).set({ role: 'member' }).where(eq(s.users.id, ids.admin)); roles.set('eat-org/demo:admin', 'read'); return 'write'; });
    expect((await change()).status).toBe(403); expect(client.setRole).not.toHaveBeenCalled();
  });
  it('does not let stale automatic cleanup override a newly chosen role for a former member', async () => {
    direct.set('eat-org/demo:member', 'write');
    await db.insert(s.githubGrants).values({ key: '9001:102', repositoryId: '9001', fullName: 'eat-org/demo', githubId: gh.member, login: 'member', userId: ids.member, previousRole: null, baselineSafe: true, appliedRole: 'write', managed: true, prepared: false });
    expect((await change('admin', gh.member, 'read')).status).toBe(200);
    expect((await db.select().from(s.githubGrants))[0]).toMatchObject({ managed: false, appliedRole: 'read' });
    await store.enqueue(db, 'cleanup', 'cleanup', {}); await service.tick();
    expect(direct.get('eat-org/demo:member')).toBe('read');
  });
  it('continues automatic cleanup for a current member after a manual role change', async () => {
    await share(); await service.tick();
    expect((await change('admin', gh.member, 'read')).status).toBe(200);
    expect((await db.select().from(s.githubGrants))[0]).toMatchObject({ managed: true, appliedRole: 'read' });
    await api('DELETE', `/api/apps/demo/members/${ids.member}`); await due(); await service.tick();
    expect(direct.has('eat-org/demo:member')).toBe(false);
  });
  it('returns a conflict instead of reporting success when the worker holds the mutation lock', async () => {
    direct.set('eat-org/demo:member', 'write');
    const connection = await pool.connect();
    try {
      await connection.query('select pg_advisory_lock(1950536522)');
      expect((await change()).status).toBe(409); expect(client.setRole).not.toHaveBeenCalled();
    } finally { await connection.query('select pg_advisory_unlock(1950536522)'); connection.release(); }
  });
  it('invalidates all apps sharing the repository and cancels queued grants before manual removal', async () => {
    const [other] = await db.insert(s.apps).values({ slug: 'shared-repo', name: 'shared', ownerId: ids.owner, repoUrl: 'https://github.com/eat-org/demo', dokployApplicationId: 'shared', deployApproved: true, approvedRepoVersion: 1 }).returning();
    await share(); await db.insert(s.appMembers).values({ appId: other.id, userId: ids.member });
    await store.enqueue(db, `grant:${other.id}:${ids.member}`, 'grant', { appId: other.id, userId: ids.member, actorId: ids.admin, version: 1 });
    direct.set('eat-org/demo:member', 'write');
    expect((await change()).status).toBe(200);
    expect((await task(`grant:${other.id}:${ids.member}`)).state).toBe('cancelled');
    expect((await task(`repo:${other.id}`)).state).toBe('pending');
  });
});
