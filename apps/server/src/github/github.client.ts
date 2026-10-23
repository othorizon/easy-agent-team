import { Injectable, Logger } from '@nestjs/common';
import { createPrivateKey } from 'node:crypto';
import type { GithubRole } from '@eat/shared';
import { decryptSecret } from '../common/crypto';
import { githubSettings } from '../db/schema';

export type GithubConfig = typeof githubSettings.$inferSelect;
export class GithubError extends Error {
  constructor(message: string, readonly retryable = false, readonly retryAfter = 0,
    readonly connectionState: 'uninstalled' | 'app_unavailable' | 'error' = 'error') { super(message); }
}
export class GithubWaiting extends Error {}
export const roleRank = (role: string) => ['none', 'read', 'triage', 'write', 'maintain', 'admin'].indexOf(role);
export const apiRole = (role: string) => ({ read: 'pull', write: 'push' }[role] ?? role);
const missingRoleName = (value: unknown) => value == null || (typeof value === 'string' && !value.trim());
function roleDiagnostic(value: unknown) {
  if (value === undefined) return { type: 'missing' };
  if (value === null) return { type: 'null' };
  if (typeof value !== 'string') return { type: typeof value };
  // Role names are the only response values logged. Never serialize objects or provider errors.
  return { type: 'string', value: value.length <= 80 && !/(?:gh[pousr]_|github_pat_|bearer\s|token|secret|private.key)/i.test(value)
    ? value : '[redacted]', length: value.length };
}
export function normalizeRole(role: unknown): GithubRole | 'none' {
  if (typeof role !== 'string' || !role.trim())
    throw new GithubError('GitHub 未返回有效的仓库角色，请刷新状态后重试');
  const normalized = role.trim().toLowerCase();
  const mapped = ({ pull: 'read', push: 'write' } as Record<string, string>)[normalized] ?? normalized;
  if (!['none', 'read', 'triage', 'write', 'maintain', 'admin'].includes(mapped))
    throw new GithubError('GitHub 返回的仓库角色暂不受 EAT 支持，请在 GitHub 核对角色');
  return mapped as GithubRole | 'none';
}
// Server is CommonJS; Octokit is ESM. Keep a native dynamic import at this boundary.
const octokitModule = new Function('return import("octokit")') as () => Promise<any>;
@Injectable()
export class GithubClient {
  private readonly logger = new Logger(GithubClient.name);
  private diagnostic(event: string, c: GithubConfig, route: string, params: Record<string, unknown>, response: any,
    extra: Record<string, unknown> = {}) {
    const requestId = response?.headers?.['x-github-request-id'];
    this.logger.warn(JSON.stringify({ event, appId: c.appId, installationId: c.installationId, route,
      repository: params.owner && params.repo ? `${params.owner}/${params.repo}` : undefined,
      githubLogin: params.username, httpStatus: typeof response?.status === 'number' ? response.status : null,
      githubRequestId: typeof requestId === 'string' && /^[a-z0-9:-]{1,100}$/i.test(requestId) ? requestId : null, ...extra }));
  }
  private responseRole(c: GithubConfig, route: string, params: Record<string, unknown>, response: any, data: any) {
    try { return normalizeRole(missingRoleName(data?.role_name) ? data?.permission : data.role_name); }
    catch (e) {
      this.diagnostic('github.role_parse_failed', c, route, params, response, {
        roleName: roleDiagnostic(data?.role_name), permission: roleDiagnostic(data?.permission),
      });
      throw e;
    }
  }
  private transport: typeof fetch = (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(15000) });
  private sdk() { return octokitModule(); }
  private cached?: { fingerprint: string; app: any };
  private async app(c: GithubConfig) {
    const fingerprint = `${c.appId}:${c.privateKeyEncrypted}`;
    if (this.cached?.fingerprint !== fingerprint) {
      const { App } = await this.sdk();
      this.cached = { fingerprint, app: new App({ appId: c.appId, privateKey: decryptSecret(c.privateKeyEncrypted),
        Octokit: (await this.sdk()).Octokit.defaults({ retry: { enabled: false }, throttle: { enabled: false },
          request: { fetch: this.transport } }) }) };
    }
    return this.cached.app;
  }
  private async request(c: GithubConfig, route: string, params: Record<string, unknown> = {}, token?: string): Promise<any> {
    let stage = token ? 'user_client' : 'installation_token';
    try {
      const octokit = token ? new (await this.sdk()).Octokit({ auth: token, retry: { enabled: false },
        throttle: { enabled: false }, request: { fetch: this.transport } })
        : await (await this.app(c)).getInstallationOctokit(Number(c.installationId));
      stage = 'github_api';
      return await octokit.request(route, { ...params, headers: { 'X-GitHub-Api-Version': '2022-11-28' } });
    } catch (e: any) {
      if (e?.status === 404) return { status: 404, data: null };
      this.diagnostic('github.request_failed', c, route, params, e?.response ?? { status: e?.status }, {
        stage, authMode: token ? 'user' : 'installation',
      });
      const headers = e?.response?.headers ?? {};
      const retryAt = Number(headers['retry-after']) * 1000 ||
        (headers['x-ratelimit-remaining'] === '0' ? Math.max(1000, Number(headers['x-ratelimit-reset']) * 1000 - Date.now()) : 0);
      if (retryAt || e?.status === 429) throw new GithubError('GitHub 请求受限，将稍后重试', true, retryAt || 60000);
      throw new GithubError(e?.status === 401 ? 'GitHub 授权已失效，请重新授权或检查接入配置' :
        e?.status === 403 ? 'GitHub 拒绝操作，请检查 App 权限及组织安全要求' :
        e?.status === 422 ? 'GitHub 无法完成操作，请检查邀请、组织要求和目标角色' : 'GitHub 请求失败，请稍后重试',
        !e?.status || e.status >= 500);
    }
  }
  async check(c: GithubConfig) {
    try {
      const app = await this.app(c);
      const { data } = await app.octokit.request('GET /app/installations/{installation_id}', { installation_id: Number(c.installationId) });
      if (data.suspended_at) throw new GithubError('GitHub App 安装已暂停，请在 GitHub 恢复安装');
      if (data.app_id && String(data.app_id) !== c.appId) throw new GithubError('安装不属于当前 GitHub App');
      if (data.account?.type !== 'Organization' || data.account?.login.toLowerCase() !== c.organization.toLowerCase() ||
        (c.organizationId && String(data.account.id) !== c.organizationId)) throw new GithubError('安装不属于配置的 GitHub 组织');
      if (data.permissions?.members !== 'write' || data.permissions?.administration !== 'write' || data.repository_selection !== 'all')
        throw new GithubError('App 需要 Members write、Administration write，并覆盖组织全部仓库');
      return String(data.account.id);
    } catch (e: any) { throw this.setupError(e, '无法验证 GitHub App 安装，请检查配置', true); }
  }
  private setupError(e: any, message: string, installation = false): GithubError {
    if (e instanceof GithubError) return e;
    if (e?.status === 401) return new GithubError('App 不可用或私钥已失效。请检查高级设置；确认 App 已删除后再重新初始化', false, 0, 'app_unavailable');
    if (e?.status === 404 && installation) return new GithubError('App 尚未安装或已从组织卸载，请重新安装', false, 0, 'uninstalled');
    const headers = e?.response?.headers ?? {};
    const retryAfter = Number(headers['retry-after']) * 1000 ||
      (headers['x-ratelimit-remaining'] === '0' ? Math.max(1000, Number(headers['x-ratelimit-reset']) * 1000 - Date.now()) : 0);
    return new GithubError(message, !e?.status || e.status >= 500 || e.status === 429 || !!retryAfter, retryAfter);
  }
  async appInfo(c: GithubConfig) {
    try {
      const { data } = await (await this.app(c)).octokit.request('GET /app');
      if (String(data.id) !== c.appId || data.client_id !== c.clientId || !/^[a-z0-9-]+$/i.test(data.slug ?? ''))
        throw new GithubError('App 身份与已保存配置不一致，请检查高级设置');
      return { id: String(data.id), slug: String(data.slug) };
    } catch (e) { throw this.setupError(e, '无法读取 GitHub App，请检查连接和私钥'); }
  }
  /** Unauthenticated `GET /apps/{slug}` answers only for public Apps. `null` = unknown (rate limit, network), never blocks. */
  async isPublic(slug: string): Promise<boolean | null> {
    try {
      const response = await this.transport(`https://api.github.com/apps/${encodeURIComponent(slug)}`, { redirect: 'error',
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'eat-server' } });
      await response.body?.cancel();
      return response.ok ? true : response.status === 404 ? false : null;
    } catch { return null; }
  }
  async findInstallation(c: GithubConfig): Promise<string | null> {
    try {
      const { data } = await (await this.app(c)).octokit.request('GET /orgs/{org}/installation', { org: c.organization });
      return String(data.id);
    } catch (e: any) {
      if (e?.status === 404) return null;
      throw this.setupError(e, '无法查询组织的 GitHub App 安装');
    }
  }
  async convertManifest(code: string) {
    try {
      const octokit = new (await this.sdk()).Octokit({ retry: { enabled: false }, throttle: { enabled: false }, request: { fetch: this.transport } });
      const { data } = await octokit.request('POST /app-manifests/{code}/conversions', { code });
      if (!/^\d+$/.test(String(data.id)) || !/^[a-z0-9-]+$/i.test(data.slug ?? '') ||
        !data.client_id || !data.client_secret || !data.pem || data.owner?.type !== 'Organization' || !data.owner?.id)
        throw new GithubError('GitHub 返回的 App 配置不完整或不是组织创建的 App');
      createPrivateKey(data.pem);
      return { appId: String(data.id), slug: String(data.slug), clientId: String(data.client_id),
        clientSecret: String(data.client_secret), privateKey: String(data.pem),
        organization: String(data.owner.login), organizationId: String(data.owner.id) };
    } catch { throw new GithubError('无法完成 App 初始化；若已在 GitHub 创建，请使用高级设置接入该 App，避免重复创建'); }
  }
  async oauth(c: GithubConfig, values: Record<string, string>): Promise<any> {
    try {
      const response = await fetch('https://github.com/login/oauth/access_token', { method: 'POST', redirect: 'error',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(15000),
        body: JSON.stringify({ client_id: c.clientId, client_secret: decryptSecret(c.clientSecretEncrypted), ...values }) });
      const data = await response.json() as any;
      if (!response.ok || !data.access_token) throw new GithubError('GitHub 用户授权失败，请重新关联账户');
      return data;
    } catch (e) { if (e instanceof GithubError) throw e; throw new GithubError('GitHub 用户授权暂不可用，请重新尝试', true); }
  }
  async identity(c: GithubConfig, token?: string, githubId?: string) {
    const r = await this.request(c, githubId ? 'GET /user/{account_id}' : 'GET /user', githubId ? { account_id: githubId } : {}, token);
    if (!r.data?.id) throw new GithubError('无法确认 GitHub 账户身份');
    return { id: String(r.data.id), login: String(r.data.login) };
  }
  async membership(c: GithubConfig, login: string) {
    return (await this.request(c, 'GET /orgs/{org}/memberships/{username}', { org: c.organization, username: login })).data;
  }
  async invite(c: GithubConfig, githubId: string) {
    const r = await this.request(c, 'POST /orgs/{org}/invitations', { org: c.organization, invitee_id: Number(githubId), role: 'direct_member' });
    if (r.status === 404) throw new GithubError('组织邀请接口不可用');
  }
  async accept(c: GithubConfig, token: string) {
    const r = await this.request(c, 'PATCH /user/memberships/orgs/{org}', { org: c.organization, state: 'active' }, token);
    if (r.status === 404) throw new GithubError('未找到有效邀请，请联系管理员重新发送');
    return r.status;
  }
  async removeOrganization(c: GithubConfig, login: string) {
    await this.request(c, 'DELETE /orgs/{org}/memberships/{username}', { org: c.organization, username: login });
  }
  async repository(c: GithubConfig, fullName: string) {
    const [owner, repo] = fullName.split('/');
    const r = await this.request(c, 'GET /repos/{owner}/{repo}', { owner, repo });
    if (!r.data) throw new GithubError('仓库不存在或 App 无法访问');
    return r.data;
  }
  async permission(c: GithubConfig, fullName: string, login: string) {
    const [owner, repo] = fullName.split('/');
    const route = 'GET /repos/{owner}/{repo}/collaborators/{username}/permission', params = { owner, repo, username: login };
    const r = await this.request(c, route, params);
    if (r.status === 404) return 'none';
    // An empty role_name is not a custom role. Only fall back when it is absent;
    // preserve Maintain/Triage and reject unknown named roles instead of silently changing them.
    return this.responseRole(c, route, params, r, r.data);
  }
  async directRole(c: GithubConfig, fullName: string, login: string): Promise<string | null> {
    const [owner, repo] = fullName.split('/');
    for (let page = 1; ; page++) {
      const r = await this.request(c, 'GET /repos/{owner}/{repo}/collaborators', { owner, repo, affiliation: 'direct', per_page: 100, page });
      if (!Array.isArray(r.data)) throw new GithubError('无法确认仓库直接授权');
      const match = r.data.find((u: any) => u.login.toLowerCase() === login.toLowerCase());
      if (match) {
        const role = missingRoleName(match.role_name)
          ? await this.permission(c, fullName, login)
          : this.responseRole(c, 'GET /repos/{owner}/{repo}/collaborators', { owner, repo, username: login }, r, match);
        if (role === 'none') throw new GithubError('GitHub 仓库成员与角色信息不一致，请刷新状态后重试');
        return role;
      }
      if (r.data.length < 100) return null;
      if (page >= 100) throw new GithubError('仓库成员过多，请在 GitHub 手动处理');
    }
  }
  private async collaboratorPages(c: GithubConfig, fullName: string, affiliation: 'all' | 'direct') {
    const [owner, repo] = fullName.split('/');
    const result = new Map<string, any>();
    for (let page = 1; page <= 100; page++) {
      const r = await this.request(c, 'GET /repos/{owner}/{repo}/collaborators', { owner, repo, affiliation, per_page: 100, page });
      if (!Array.isArray(r.data)) throw new GithubError('无法读取完整仓库用户列表，请刷新后重试');
      for (const user of r.data) {
        if (!/^\d+$/.test(String(user.id)) || typeof user.login !== 'string' || !user.login)
          throw new GithubError('GitHub 返回的仓库用户身份不完整');
        result.set(String(user.id), user);
      }
      if (r.data.length < 100) return result;
    }
    throw new GithubError('仓库用户过多，暂无法展示完整名单，请在 GitHub 查看');
  }
  async collaborators(c: GithubConfig, fullName: string) {
    const [all, direct] = await Promise.all([this.collaboratorPages(c, fullName, 'all'), this.collaboratorPages(c, fullName, 'direct')]);
    if ([...direct.keys()].some(id => !all.has(id))) throw new GithubError('仓库成员在查询期间发生变化，请刷新后重试');
    const result: Array<{ githubId: string; login: string; direct: boolean; role: GithubRole | 'unknown'; roleError: string }> = [];
    for (const [githubId, user] of all) {
      let role: GithubRole | 'unknown' = 'unknown', roleError = '';
      try {
        const observed = missingRoleName(user.role_name) ? await this.permission(c, fullName, user.login) : normalizeRole(user.role_name);
        if (observed === 'none') throw new GithubError('仓库用户权限已变化，请刷新后重试');
        role = observed;
      } catch (e) { roleError = e instanceof GithubError ? e.message : '仓库角色暂不可用'; }
      result.push({ githubId, login: user.login, direct: direct.has(githubId), role, roleError });
    }
    return result;
  }
  async setRole(c: GithubConfig, fullName: string, login: string, role: string | null) {
    const [owner, repo] = fullName.split('/');
    const r = await this.request(c, role ? 'PUT /repos/{owner}/{repo}/collaborators/{username}' :
      'DELETE /repos/{owner}/{repo}/collaborators/{username}', { owner, repo, username: login, ...(role ? { permission: apiRole(role) } : {}) });
    if (role && r.status === 404) throw new GithubError('仓库授权接口不可用');
    if (r.status === 201) throw new GithubError('用户尚未成为组织成员，GitHub 返回仓库邀请，请先完成组织加入');
  }
}
