import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { generateKeyPairSync } from 'node:crypto';
import { GithubClient, GithubError, type GithubConfig } from '../src/github/github.client';
import { encryptSecret } from '../src/common/crypto';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const config: GithubConfig = { id: 1, enabled: true, organization: 'eat-org', organizationId: '900', appId: '1', clientId: 'client', installationId: '2', clientSecretEncrypted: encryptSecret('secret-test'), privateKeyEncrypted: encryptSecret(privateKey),
  revision: '00000000-0000-4000-8000-000000000001', appSlug: null, connectionState: 'app_ready', connectionError: '', checkedAt: null };
const hits: Array<{ url: string; init: any }> = [];
function mockFetch(handler: (url: string, init: any) => Response) {
  hits.length = 0;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input); hits.push({ url, init });
    if (url === 'https://api.github.com/app/installations/2/access_tokens') return json({ token: 'installation-test', expires_at: new Date(Date.now() + 3600000).toISOString() }, 201);
    return handler(url, init);
  });
}
const json = (value: any, status = 200, headers = {}) => new Response(status === 204 ? null : JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } });
// Vitest executes source in a VM; route the ESM boundary through its module loader.
beforeEach(() => { vi.spyOn(GithubClient.prototype as any, 'sdk').mockImplementation(() => import('octokit')); });
afterEach(() => vi.restoreAllMocks());
describe('real Octokit transport and redacted errors', () => {
  it('exchanges a manifest code without an installation or user token', async () => {
    mockFetch(() => json({ id: 5, slug: 'new-eat', client_id: 'new-client', client_secret: 'new-secret', pem: privateKey,
      owner: { id: 900, type: 'Organization', login: 'eat-org' } }, 201));
    expect(await new GithubClient().convertManifest('temporary-code')).toMatchObject({ appId: '5', slug: 'new-eat', organizationId: '900', privateKey });
    expect(hits[0].url).toBe('https://api.github.com/app-manifests/temporary-code/conversions');
    expect(hits[0].init.headers.authorization).toBeUndefined();
  });
  it('reads the App identity and discovers its organization installation using App JWT', async () => {
    mockFetch(url => url.endsWith('/app') ? json({ id: 1, slug: 'eat-app', client_id: 'client' }) : json({ id: 99 }));
    const client = new GithubClient();
    expect(await client.appInfo(config)).toEqual({ id: '1', slug: 'eat-app' });
    expect(await client.findInstallation(config)).toBe('99');
    expect(hits.map(h => h.url)).toEqual(['https://api.github.com/app', 'https://api.github.com/orgs/eat-org/installation']);
    for (const h of hits) expect(h.init.headers.authorization).toMatch(/^bearer /i);
  });
  it('does not confuse an uninstalled App, invalid credentials and a provider outage', async () => {
    mockFetch(() => json({ message: 'private detail' }, 404));
    expect(await new GithubClient().findInstallation(config)).toBeNull();
    await expect(new GithubClient().check(config)).rejects.toMatchObject({ connectionState: 'uninstalled', retryable: false });
    vi.restoreAllMocks(); vi.spyOn(GithubClient.prototype as any, 'sdk').mockImplementation(() => import('octokit'));
    mockFetch(() => json({}, 401));
    await expect(new GithubClient().appInfo(config)).rejects.toMatchObject({ connectionState: 'app_unavailable' });
    vi.restoreAllMocks(); vi.spyOn(GithubClient.prototype as any, 'sdk').mockImplementation(() => import('octokit'));
    mockFetch(() => json({}, 503));
    await expect(new GithubClient().appInfo(config)).rejects.toMatchObject({ connectionState: 'error', retryable: true });
  });
  it.each([
    { account: { id: 901, type: 'Organization', login: 'another-org' } },
    { app_id: 99 }, { repository_selection: 'selected' }, { suspended_at: '2026-10-21' }, { permissions: { members: 'read', administration: 'write' } },
  ])('rejects installations with the wrong identity, scope or status: %j', async override => {
    mockFetch(() => json({ app_id: 1, account: { id: 900, type: 'Organization', login: 'eat-org' },
      permissions: { members: 'write', administration: 'write' }, repository_selection: 'all', ...override }));
    await expect(new GithubClient().check(config)).rejects.toBeInstanceOf(GithubError);
  });
  it('redacts failures while exchanging a manifest containing credentials', async () => {
    mockFetch(() => json({ message: 'new-secret private-key temporary-code' }, 422));
    await expect(new GithubClient().convertManifest('temporary-code')).rejects.toThrow('无法完成 App 初始化');
  });
  it('loads Octokit and validates installation org, permissions and repository coverage', async () => {
    mockFetch(() => json({ account: { id: 900, type: 'Organization', login: 'eat-org' }, permissions: { members: 'write', administration: 'write' }, repository_selection: 'all' }));
    expect(await new GithubClient().check(config)).toBe('900');
    expect(hits[0].url).toBe('https://api.github.com/app/installations/2');
    expect(hits[0].init.signal).toBeInstanceOf(AbortSignal);
    expect(hits[0].init.headers.authorization).toMatch(/^bearer /i);
  });
  it('accepts membership with the user token and never requests an installation token for that operation', async () => {
    mockFetch(() => json({}, 202));
    expect(await new GithubClient().accept(config, 'user-test')).toBe(202);
    expect(hits).toHaveLength(1);
    expect(hits[0].url).toBe('https://api.github.com/user/memberships/orgs/eat-org');
    expect(hits[0].init.headers.authorization).toBe('token user-test');
    expect(JSON.parse(hits[0].init.body)).toEqual({ state: 'active' });
  });
  it('uses installation auth to set Write via the push API parameter', async () => {
    mockFetch(() => json(null, 204));
    await new GithubClient().setRole(config, 'eat-org/demo', 'member', 'write');
    const write = hits.find(h => h.url.endsWith('/collaborators/member'))!;
    expect(write.init.headers.authorization).toBe('token installation-test');
    expect(JSON.parse(write.init.body)).toEqual({ permission: 'push' });
  });
  it('honors rate limits and does not expose provider response contents', async () => {
    mockFetch(() => json({ message: 'secret-test user-test' }, 429, { 'retry-after': '120' }));
    try { await new GithubClient().accept(config, 'user-test'); throw new Error('expected rate limit'); }
    catch (e) { expect(e).toBeInstanceOf(GithubError); expect((e as GithubError).retryAfter).toBe(120000); expect((e as Error).message).not.toContain('secret-test'); }
    expect(hits).toHaveLength(1);
  });
  it('uses role_name instead of legacy permission so Maintain is not treated as Write', async () => {
    mockFetch(() => json({ permission: 'write', role_name: 'maintain' }));
    expect(await new GithubClient().permission(config, 'eat-org/demo', 'member')).toBe('maintain');
  });
  it.each([
    [{ role_name: '', permission: 'none' }, 'none'],
    [{ role_name: '  ', permission: 'write' }, 'write'],
    [{ role_name: null, permission: 'read' }, 'read'],
    [{ permission: 'admin' }, 'admin'],
    [{ role_name: 'Maintain', permission: 'write' }, 'maintain'],
    [{ role_name: ' Read ', permission: 'read' }, 'read'],
  ])('interprets standard role responses without mistaking an empty role_name for an unsupported role: %j', async (response, role) => {
    mockFetch(() => json(response));
    expect(await new GithubClient().permission(config, 'eat-org/demo', 'member')).toBe(role);
  });
  it.each([
    { role_name: 'custom-release-manager', permission: 'admin' },
    { role_name: {}, permission: 'write' },
    { role_name: '' }, {}, null,
  ])('does not turn unsupported or malformed role responses into standard privileges or no access: %j', async response => {
    mockFetch(() => json(response));
    await expect(new GithubClient().permission(config, 'eat-org/demo', 'member')).rejects.toBeInstanceOf(GithubError);
  });
  it('rechecks a direct collaborator with an empty role name instead of assuming no existing grant', async () => {
    mockFetch(url => url.endsWith('/permission') ? json({ role_name: 'maintain', permission: 'write' }) : json([{ login: 'member', role_name: '' }]));
    expect(await new GithubClient().directRole(config, 'eat-org/demo', 'member')).toBe('maintain');
    expect(hits.some(h => h.url.endsWith('/collaborators/member/permission'))).toBe(true);
  });
  it('rejects inconsistent direct membership instead of overwriting an unverified grant', async () => {
    mockFetch(url => url.endsWith('/permission') ? json({ role_name: '', permission: 'none' }) : json([{ login: 'member' }]));
    await expect(new GithubClient().directRole(config, 'eat-org/demo', 'member')).rejects.toBeInstanceOf(GithubError);
  });
  it('logs only the role fields and request identifiers for a parsing failure', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    mockFetch(() => json({ role_name: 'custom_deployer', permission: 'write', access_token: 'do-not-log-access',
      nested: { privateKey: 'do-not-log-key' } }, 200, { 'x-github-request-id': 'ABCD:1234:EF56', 'set-cookie': 'do-not-log-cookie' }));
    await expect(new GithubClient().permission(config, 'eat-org/demo', 'member')).rejects.toBeInstanceOf(GithubError);
    expect(JSON.parse(String(warn.mock.calls[0][0]))).toMatchObject({ event: 'github.role_parse_failed', appId: '1', installationId: '2',
      repository: 'eat-org/demo', githubLogin: 'member', httpStatus: 200, githubRequestId: 'ABCD:1234:EF56',
      roleName: { value: 'custom_deployer', type: 'string' }, permission: { value: 'write' } });
    const logs = JSON.stringify(warn.mock.calls);
    for (const secret of ['do-not-log-access', 'do-not-log-key', 'do-not-log-cookie', 'installation-test', 'secret-test', privateKey]) expect(logs).not.toContain(secret);
  });
  it.each(['ghp_do-not-log', 'github_pat_do-not-log', { token: 'do-not-log' }])('redacts credential-like or structured role values: %j', async role_name => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    mockFetch(() => json({ role_name, permission: 'read' }));
    await expect(new GithubClient().permission(config, 'eat-org/demo', 'member')).rejects.toBeInstanceOf(GithubError);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('do-not-log');
  });
  it('identifies an installation-auth write failure without logging the provider body or authorization header', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    mockFetch(() => json({ message: 'secret-test user-test' }, 403, { 'x-github-request-id': 'FAIL:403' }));
    await expect(new GithubClient().setRole(config, 'eat-org/demo', 'member', 'write')).rejects.toBeInstanceOf(GithubError);
    expect(JSON.parse(String(warn.mock.calls[0][0]))).toMatchObject({ event: 'github.request_failed', httpStatus: 403,
      route: 'PUT /repos/{owner}/{repo}/collaborators/{username}', authMode: 'installation', stage: 'github_api', githubRequestId: 'FAIL:403' });
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/secret-test|user-test|installation-test/);
  });
  it('encodes OAuth credentials only in the POST body and disables redirects', async () => {
    mockFetch(() => json({ access_token: 'user-test' }));
    await new GithubClient().oauth(config, { code: 'one-time-code' });
    expect(hits[0].url).toBe('https://github.com/login/oauth/access_token');
    expect(hits[0].init.redirect).toBe('error');
    expect(JSON.parse(hits[0].init.body)).toMatchObject({ client_secret: 'secret-test', code: 'one-time-code' });
  });
});

describe('complete repository collaborator snapshots', () => {
  it('paginates all users and direct grants independently using installation auth', async () => {
    mockFetch(url => {
      const u = new URL(url), direct = u.searchParams.get('affiliation') === 'direct';
      if (direct) return json([{ id: 101, login: 'last', role_name: 'write' }]);
      return json(u.searchParams.get('page') === '1'
        ? Array.from({ length: 100 }, (_, i) => ({ id: i + 1, login: `user-${i}`, role_name: 'read' }))
        : [{ id: 101, login: 'last', role_name: 'write' }]);
    });
    const rows = await new GithubClient().collaborators(config, 'eat-org/demo');
    expect(rows).toHaveLength(101);
    expect(rows[0]).toMatchObject({ direct: false, role: 'read' });
    expect(rows[100]).toMatchObject({ githubId: '101', direct: true, role: 'write' });
    for (const hit of hits.filter(h => h.url.includes('/collaborators')))
      expect(hit.init.headers.authorization).toBe('token installation-test');
  });
  it('never treats a failed later page as a complete or empty list', async () => {
    mockFetch(url => {
      const u = new URL(url);
      if (u.searchParams.get('affiliation') === 'direct') return json([]);
      return u.searchParams.get('page') === '1' ? json(Array.from({ length: 100 }, (_, i) => ({ id: i + 1, login: `user-${i}`, role_name: 'read' }))) : json({}, 403);
    });
    await expect(new GithubClient().collaborators(config, 'eat-org/demo')).rejects.toThrow('GitHub 拒绝操作');
  });
  it('keeps unsupported roles visible without granting standard-role privileges', async () => {
    mockFetch(() => json([{ id: 1, login: 'custom', role_name: 'custom-admin' }]));
    expect(await new GithubClient().collaborators(config, 'eat-org/demo')).toEqual([
      expect.objectContaining({ githubId: '1', role: 'unknown', direct: true, roleError: expect.any(String) }),
    ]);
  });
  it('rejects inconsistent all/direct snapshots instead of hiding a directly authorized user', async () => {
    mockFetch(url => json(new URL(url).searchParams.get('affiliation') === 'direct' ? [{ id: 1, login: 'new' }] : []));
    await expect(new GithubClient().collaborators(config, 'eat-org/demo')).rejects.toThrow('查询期间发生变化');
  });
});
