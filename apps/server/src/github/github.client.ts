import { Injectable } from '@nestjs/common';
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
export function normalizeRole(role: string): GithubRole | 'none' {
  const mapped = ({ pull: 'read', push: 'write' } as Record<string, string>)[role] ?? role;
  if (!['none', 'read', 'triage', 'write', 'maintain', 'admin'].includes(mapped))
    throw new GithubError('GitHub 返回未知仓库角色，请在 GitHub 检查权限');
  return mapped as GithubRole | 'none';
}
// Server is CommonJS; Octokit is ESM. Keep a native dynamic import at this boundary.
const octokitModule = new Function('return import("octokit")') as () => Promise<any>;
@Injectable()
export class GithubClient {
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
    try {
      const octokit = token ? new (await this.sdk()).Octokit({ auth: token, retry: { enabled: false },
        throttle: { enabled: false }, request: { fetch: this.transport } })
        : await (await this.app(c)).getInstallationOctokit(Number(c.installationId));
      return await octokit.request(route, { ...params, headers: { 'X-GitHub-Api-Version': '2022-11-28' } });
    } catch (e: any) {
      if (e?.status === 404) return { status: 404, data: null };
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
    const r = await this.request(c, 'GET /repos/{owner}/{repo}/collaborators/{username}/permission', { owner, repo, username: login });
    return normalizeRole(r.data?.role_name ?? r.data?.permission ?? 'none');
  }
  async directRole(c: GithubConfig, fullName: string, login: string): Promise<string | null> {
    const [owner, repo] = fullName.split('/');
    for (let page = 1; ; page++) {
      const r = await this.request(c, 'GET /repos/{owner}/{repo}/collaborators', { owner, repo, affiliation: 'direct', per_page: 100, page });
      if (!Array.isArray(r.data)) throw new GithubError('无法确认仓库直接授权');
      const match = r.data.find((u: any) => u.login.toLowerCase() === login.toLowerCase());
      if (match) return normalizeRole(match.role_name ?? 'none');
      if (r.data.length < 100) return null;
      if (page >= 100) throw new GithubError('仓库成员过多，请在 GitHub 手动处理');
    }
  }
  async setRole(c: GithubConfig, fullName: string, login: string, role: string | null) {
    const [owner, repo] = fullName.split('/');
    const r = await this.request(c, role ? 'PUT /repos/{owner}/{repo}/collaborators/{username}' :
      'DELETE /repos/{owner}/{repo}/collaborators/{username}', { owner, repo, username: login, ...(role ? { permission: apiRole(role) } : {}) });
    if (role && r.status === 404) throw new GithubError('仓库授权接口不可用');
    if (r.status === 201) throw new GithubError('用户尚未成为组织成员，GitHub 返回仓库邀请，请先完成组织加入');
  }
}
