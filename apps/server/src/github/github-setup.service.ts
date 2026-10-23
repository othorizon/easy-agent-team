import { BadRequestException, ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import { and, eq, lte, sql } from 'drizzle-orm';
import { randomBytes, randomUUID } from 'node:crypto';
import type { GithubSetupRequest } from '@eat/shared';
import type { AuthUser } from '../auth/auth.decorators';
import { encryptSecret, sha256Hex } from '../common/crypto';
import { loadConfig } from '../config';
import { apiTokens, users, githubAccounts, githubOauthStates, githubRepositories, githubSettings, githubSetupStates, githubTasks } from '../db/schema';
import { GithubClient, GithubConfig, GithubError } from './github.client';
import { GithubStore, GithubTx } from './github.store';

const PRIVATE_APP = 'GitHub App 为私有：GitHub 只允许组织成员授权私有 App，尚未加入组织的用户点「关联 GitHub」会看到 404。' +
  '请组织 Owner 在 GitHub 打开组织 Settings → Developer settings → GitHub Apps → 本 App 的 Edit → Advanced，点击 Make public，然后重新检查连接。' +
  '公开只代表其他账户也能授权或安装该 App，不会获得本组织的任何权限。';

type SetupSession = typeof githubSetupStates.$inferSelect;

@Injectable()
export class GithubSetupService {
  constructor(private readonly store: GithubStore, private readonly client: GithubClient) {}
  private get db() { return this.store.db; }
  private base() { return loadConfig().publicUrl.replace(/\/$/, ''); }
  private async admin(tx: GithubTx | typeof this.db, userId: string, tokenId: string) {
    const [u] = await tx.select().from(users).where(eq(users.id, userId));
    const [t] = await tx.select().from(apiTokens).where(eq(apiTokens.id, tokenId));
    if (u?.status !== 'active' || u.role !== 'admin' || !t || t.userId !== userId || t.revokedAt ||
      (t.expiresAt && t.expiresAt <= new Date())) throw new ForbiddenException('原管理员会话已失效，请重新登录并开始');
  }
  private async start(user: AuthUser, kind: SetupSession['kind'], organization: string, expected: GithubConfig | undefined) {
    const state = randomBytes(32).toString('hex'), browser = randomBytes(32).toString('hex');
    await this.store.edit(async (tx, current) => {
      this.store.assertRevision(current, expected?.revision);
      await this.admin(tx, user.id, user.tokenId);
      await tx.delete(githubSetupStates).where(lte(githubSetupStates.expiresAt, new Date()));
      await tx.delete(githubSetupStates).where(eq(githubSetupStates.userId, user.id));
      await tx.insert(githubSetupStates).values({ stateHash: sha256Hex(state), browserHash: sha256Hex(browser),
        userId: user.id, tokenId: user.tokenId, kind, organization, configRevision: current?.revision ?? null,
        expiresAt: new Date(Date.now() + 30 * 60000) });
    });
    return { state, browser };
  }
  async create(user: AuthUser, input: GithubSetupRequest) {
    const current = await this.store.config(false);
    if (current) {
      if (!input.replaceExisting) throw new ConflictException('已有 GitHub App；卸载后请重新安装，确认 App 已删除后才重新初始化');
      if (input.organization.toLowerCase() !== current.organization.toLowerCase()) throw new ConflictException('重新初始化必须使用原组织，以保留现有身份和仓库授权关系');
    }
    const flow = await this.start(user, 'manifest', input.organization, current);
    const url = new URL(`https://github.com/organizations/${encodeURIComponent(input.organization)}/settings/apps/new`);
    url.searchParams.set('state', flow.state);
    return { browser: flow.browser, url: url.toString(), manifest: {
      name: input.name, url: this.base(), description: 'EAT 组织成员与应用仓库协作',
      redirect_url: `${this.base()}/api/github/setup/manifest`, callback_urls: [`${this.base()}/api/github/callback`],
      setup_url: `${this.base()}/api/github/setup/installation`, setup_on_update: true,
      // Must be public: GitHub only lets members of the owning organization authorize a private App, so
      // users who are not yet in the organization (the people linking is for) get a 404 on the OAuth page.
      request_oauth_on_install: false, public: true,
      hook_attributes: { url: `${this.base()}/api/github/events`, active: false },
      default_permissions: { members: 'write', administration: 'write', metadata: 'read' }, default_events: [],
    } };
  }
  async install(user: AuthUser) {
    const c = await this.store.config(false);
    if (!c) throw new BadRequestException('请先初始化 GitHub App 或在高级设置接入已有 App');
    let app: { slug: string };
    try { app = await this.client.appInfo(c); }
    catch (e) { await this.store.connectionError(c, e); throw e; }
    const flow = await this.start(user, 'installation', c.organization, c);
    const url = new URL(`https://github.com/apps/${encodeURIComponent(app.slug)}/installations/new`);
    url.searchParams.set('state', flow.state);
    if (c.organizationId) url.searchParams.set('target_id', c.organizationId);
    return { url: url.toString(), browser: flow.browser };
  }
  private async consume(kind: SetupSession['kind'], state: string, browser: string) {
    if (!/^[a-f0-9]{64}$/.test(state ?? '') || !/^[a-f0-9]{64}$/.test(browser ?? ''))
      throw new BadRequestException('初始化或安装回调无效，请从 EAT 重新开始');
    const [session] = await this.db.delete(githubSetupStates).where(and(
      eq(githubSetupStates.kind, kind), eq(githubSetupStates.stateHash, sha256Hex(state)),
      eq(githubSetupStates.browserHash, sha256Hex(browser)), sql`${githubSetupStates.expiresAt} > now()`)).returning();
    if (!session) throw new BadRequestException('操作已过期或已使用，请从 EAT 重新开始');
    await this.admin(this.db, session.userId, session.tokenId);
    const c = await this.store.config(false); this.store.assertRevision(c, session.configRevision);
    return { session, config: c };
  }
  async finishCreate(state: string, browser: string, code: string) {
    if (!/^[a-z0-9_-]{1,256}$/i.test(code ?? '')) throw new BadRequestException('GitHub 初始化回调无效');
    const { session } = await this.consume('manifest', state, browser);
    const app = await this.client.convertManifest(code);
    if (app.organization.toLowerCase() !== session.organization.toLowerCase()) throw new BadRequestException('创建的 App 不属于所选组织');
    await this.store.edit(async (tx, current) => {
      this.store.assertRevision(current, session.configRevision);
      await this.admin(tx, session.userId, session.tokenId);
      if (current?.organizationId && current.organizationId !== app.organizationId) throw new ConflictException('GitHub 组织身份发生变化，不能替换原组织');
      if (current?.appId === app.appId) throw new ConflictException('这不是新的 GitHub App，请使用重新安装');
      const values = { enabled: false, organization: app.organization, organizationId: app.organizationId,
        appId: app.appId, clientId: app.clientId, appSlug: app.slug, installationId: '', revision: randomUUID(),
        clientSecretEncrypted: encryptSecret(app.clientSecret), privateKeyEncrypted: encryptSecret(app.privateKey),
        connectionState: 'app_ready' as const, connectionError: '', checkedAt: null };
      await tx.insert(githubSettings).values({ id: 1, ...values }).onConflictDoUpdate({ target: githubSettings.id, set: values });
      // Keep EAT users/apps/members, stable GitHub identities and the managed grant ledger.
      // Old user tokens belong to the replaced App and must never be used with the new one.
      if (current) {
        await tx.update(githubAccounts).set({ accessTokenEncrypted: '', refreshTokenEncrypted: null, expiresAt: null,
          needsAuthorization: true, version: sql`gen_random_uuid()`, checkedAt: null,
          error: '平台 GitHub App 已更换，请重新授权 GitHub' });
        await tx.update(githubTasks).set({ state: 'cancelled', generation: sql`${githubTasks.generation} + 1`,
          error: '平台 GitHub App 已更换，请重新核验后发起操作', updatedAt: new Date() });
      }
      await tx.delete(githubOauthStates);
      await tx.delete(githubRepositories);
    });
  }
  async finishInstall(state: string, browser: string, installationId: string, setupAction: string) {
    const { session, config: c } = await this.consume('installation', state, browser);
    if (!c) throw new BadRequestException('GitHub App 配置已失效');
    if (setupAction === 'request') return 'requested' as const;
    if (!['install', 'update'].includes(setupAction) || !/^[1-9]\d{0,15}$/.test(installationId ?? ''))
      throw new BadRequestException('安装尚未完成，请由组织 Owner 确认安装');
    // Neither the callback ID nor target_id proves ownership: verify with this App's JWT.
    let organizationId: string;
    try { organizationId = await this.client.check({ ...c, installationId }); }
    catch (e) { await this.store.connectionError(c, e); throw e; }
    await this.store.edit(async (tx, current) => {
      this.store.assertRevision(current, session.configRevision);
      await this.admin(tx, session.userId, session.tokenId);
      await tx.update(githubSettings).set({ installationId, organizationId, enabled: true, revision: randomUUID(),
        connectionState: 'connected', connectionError: '', checkedAt: new Date() }).where(eq(githubSettings.id, 1));
      await tx.update(githubRepositories).set({ checkedAt: new Date(0) });
    });
    return 'installed' as const;
  }
  async check() {
    const c = await this.store.config(false);
    if (!c) throw new BadRequestException('请先初始化 GitHub App 或保存高级配置');
    try {
      const app = await this.client.appInfo(c);
      if (await this.client.isPublic(app.slug) === false) throw new GithubError(PRIVATE_APP);
      // Discover the actual installation, including recovery after a lost installation callback.
      const installationId = await this.client.findInstallation(c);
      if (!installationId) throw new GithubError('App 已创建，但尚未安装到组织或已被卸载，请安装到组织', false, 0, 'uninstalled');
      const organizationId = await this.client.check({ ...c, installationId });
      const revision = installationId !== c.installationId ? randomUUID() : c.revision;
      await this.store.edit(async (tx, current) => {
        this.store.assertRevision(current, c.revision);
        await tx.update(githubSettings).set({ installationId, organizationId, appSlug: app.slug,
          connectionState: 'connected', connectionError: '', checkedAt: new Date(),
          revision }).where(eq(githubSettings.id, 1));
      });
      return { ok: true, message: '组织、App 权限及仓库覆盖范围检查通过', revision };
    } catch (e) { if (!(e instanceof ConflictException)) await this.store.connectionError(c, e); throw e; }
  }
  async setEnabled(enabled: boolean) {
    const checked = enabled ? await this.check() : null;
    await this.store.edit(async (tx, current) => {
      if (!current) throw new BadRequestException('请先初始化 GitHub App');
      if (checked) this.store.assertRevision(current, checked.revision);
      if (enabled && current.connectionState !== 'connected') throw new ConflictException('请先检查连接');
      await tx.update(githubSettings).set({ enabled, revision: randomUUID() }).where(eq(githubSettings.id, 1));
    });
    return this.store.settings();
  }
}
