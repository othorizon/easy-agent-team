import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, OnModuleInit, OnApplicationShutdown } from '@nestjs/common';
import { and, eq, inArray, lte, sql } from 'drizzle-orm';
import { randomBytes, randomUUID } from 'node:crypto';
import type { GithubAccountInfo, GithubAppInfo, GithubRole } from '@eat/shared';
import type { AuthUser } from '../auth/auth.decorators';
import { apps, appMembers, apiTokens, users, githubAccounts, githubOauthStates, githubRepositories, githubSettings, githubTasks, githubGrants, userNotifications } from '../db/schema';
import { encryptSecret, decryptSecret, sha256Hex } from '../common/crypto';
import { loadConfig } from '../config';
import { WebhookService } from '../notify/webhook.service';
import { GithubStore, TaskRow, githubFullName, repositoryIdentity } from './github.store';
import { GithubClient, GithubConfig, GithubError, GithubWaiting, roleRank } from './github.client';
import { GithubSetupService } from './github-setup.service';

@Injectable()
export class GithubService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(GithubService.name);
  private timer?: ReturnType<typeof setInterval>;
  private job?: Promise<void>;
  private stopped = false;
  constructor(readonly store: GithubStore, readonly client: GithubClient, private readonly webhook: WebhookService,
    private readonly setup: GithubSetupService) {}
  onModuleInit() { this.timer = setInterval(() => this.wake(), 30000); this.timer.unref(); }
  async onApplicationShutdown() { this.stopped = true; clearInterval(this.timer); await this.job; }
  wake() { if (!this.stopped && !this.job) this.job = this.tick().catch(() => this.logger.warn('GitHub 后台任务暂未完成'))
    .finally(() => { this.job = undefined; }); }
  private get db() { return this.store.db; }
  private async user(id: string) {
    const [u] = await this.db.select().from(users).where(eq(users.id, id));
    if (!u || u.status !== 'active') throw new GithubError('EAT 用户不存在或已停用');
    return u;
  }
  private async account(id: string) { return (await this.db.select().from(githubAccounts).where(eq(githubAccounts.userId, id)))[0]; }
  async check() {
    return this.setup.check();
  }
  async accountInfo(userId: string): Promise<GithubAccountInfo> {
    const c = await this.store.config(false), a = await this.account(userId);
    const [task] = await this.db.select().from(githubTasks).where(eq(githubTasks.key, `account:${userId}`));
    if (c?.enabled && a && (!a.checkedAt || Date.now() - a.checkedAt.getTime() > 300000)) {
      const key = `refresh-account:${userId}`;
      const [existing] = await this.db.select().from(githubTasks).where(eq(githubTasks.key, key));
      if (!existing || (existing.state !== 'pending' && Date.now() - existing.updatedAt.getTime() > 300000)) {
        await this.store.enqueue(this.db, key, 'refresh', { userId, actorId: userId, bindingVersion: a.version }); this.wake();
      }
    }
    return { enabled: c?.enabled ?? false, organization: c?.organization ?? '', linked: !!a, login: a?.login ?? null,
      needsAuthorization: a?.needsAuthorization ?? false, orgState: a?.orgState ?? 'unknown', orgRole: a?.orgRole ?? null,
      checkedAt: a?.checkedAt?.toISOString() ?? null, error: a?.error ?? '',
      task: task ? { state: task.state, error: task.error, attempts: task.attempts, notification: task.notification } : null };
  }
  async authorize(user: AuthUser) {
    const c = await this.store.config();
    await this.user(user.id);
    const state = randomBytes(32).toString('hex'), browser = randomBytes(32).toString('hex');
    const previous = await this.account(user.id);
    await this.db.transaction(async tx => {
      await tx.delete(githubOauthStates).where(eq(githubOauthStates.userId, user.id));
      await tx.delete(githubOauthStates).where(lte(githubOauthStates.expiresAt, new Date()));
      await tx.insert(githubOauthStates).values({ stateHash: sha256Hex(state), browserHash: sha256Hex(browser),
        userId: user.id, tokenId: user.tokenId, bindingVersion: previous?.version ?? null, configRevision: c.revision,
        expiresAt: new Date(Date.now() + 600000) });
    });
    const url = new URL('https://github.com/login/oauth/authorize');
    url.searchParams.set('client_id', c.clientId); url.searchParams.set('state', state);
    url.searchParams.set('redirect_uri', (await this.store.settings()).callbackUrl);
    return { url: url.toString(), browser };
  }
  private tokenValues(t: any) {
    return { accessTokenEncrypted: encryptSecret(t.access_token),
      refreshTokenEncrypted: t.refresh_token ? encryptSecret(t.refresh_token) : null,
      expiresAt: t.expires_in ? new Date(Date.now() + Number(t.expires_in) * 1000) : null, needsAuthorization: false };
  }
  async callback(state: string, browser: string, code: string) {
    if (!state || !browser || !code) throw new BadRequestException('GitHub 授权回调不完整');
    const [session] = await this.db.delete(githubOauthStates).where(and(eq(githubOauthStates.stateHash, sha256Hex(state)),
      eq(githubOauthStates.browserHash, sha256Hex(browser)), sql`${githubOauthStates.expiresAt} > now()`)).returning();
    if (!session) throw new BadRequestException('GitHub 授权已过期或已使用，请重新关联');
    const c = await this.store.config();
    this.store.assertRevision(c, session.configRevision);
    await this.user(session.userId);
    const token = await this.client.oauth(c, { code, redirect_uri: (await this.store.settings()).callbackUrl });
    const identity = await this.client.identity(c, token.access_token);
    await this.store.edit(async (tx, currentConfig) => {
      this.store.assertRevision(currentConfig, c.revision);
      if (!currentConfig?.enabled) throw new ForbiddenException('GitHub 接入已关闭');
      // Serialize link/unlink and verify the initiating EAT session again after the network call.
      await tx.select().from(users).where(eq(users.id, session.userId)).for('update');
      const [u] = await tx.select().from(users).where(eq(users.id, session.userId));
      const [eatToken] = await tx.select().from(apiTokens).where(eq(apiTokens.id, session.tokenId));
      if (u?.status !== 'active' || !eatToken || eatToken.userId !== u.id || eatToken.revokedAt ||
        (eatToken.expiresAt && eatToken.expiresAt <= new Date())) throw new ForbiddenException('原 EAT 会话已失效');
      const [current] = await tx.select().from(githubAccounts).where(eq(githubAccounts.userId, u.id));
      if ((current?.version ?? null) !== session.bindingVersion) throw new ConflictException('账户绑定已变化，请重新操作');
      if (current && current.githubId !== identity.id) throw new ConflictException('请先解绑当前 GitHub 账户');
      const [duplicate] = await tx.select().from(githubAccounts).where(eq(githubAccounts.githubId, identity.id));
      if (duplicate && duplicate.userId !== u.id) throw new ConflictException('这个 GitHub 账户已关联其他 EAT 用户');
      const version = randomUUID();
      const values = { githubId: identity.id, login: identity.login, version, ...this.tokenValues(token), error: '' };
      await tx.insert(githubAccounts).values({ userId: u.id, ...values })
        .onConflictDoUpdate({ target: githubAccounts.userId, set: values });
      await this.store.enqueue(tx, `account:${u.id}`, 'join', { userId: u.id, actorId: u.id, bindingVersion: version });
    });
    this.wake();
  }
  async unlink(userId: string) {
    await this.db.transaction(async tx => {
      await tx.select().from(users).where(eq(users.id, userId)).for('update');
      await tx.delete(githubOauthStates).where(eq(githubOauthStates.userId, userId));
      await tx.delete(githubAccounts).where(eq(githubAccounts.userId, userId));
      await tx.update(githubTasks).set({ state: 'cancelled', generation: sql`${githubTasks.generation} + 1` })
        .where(sql`${githubTasks.payload}->>'userId' = ${userId} OR ${githubTasks.payload}->>'actorId' = ${userId}`);
    });
    return { ok: true };
  }
  async accountAction(user: AuthUser, userId: string, action: 'refresh' | 'join' | 'accept' | 'remove-org') {
    if (user.id !== userId && user.role !== 'admin') throw new ForbiddenException();
    if (['join', 'remove-org'].includes(action) && user.role !== 'admin') throw new ForbiddenException();
    await this.store.config();
    const a = await this.account(userId);
    if (!a) throw new BadRequestException('用户尚未关联 GitHub');
    const [existing] = await this.db.select().from(githubTasks).where(eq(githubTasks.key, `account:${userId}`));
    if (existing?.state === 'pending' && existing.kind !== 'refresh' && action !== 'remove-org') return { ok: true, githubState: 'pending' };
    await this.store.enqueue(this.db, `account:${userId}`, action, { userId, actorId: user.id, bindingVersion: a.version, manual: true });
    this.wake(); return { ok: true, githubState: 'pending' };
  }
  private async userToken(c: GithubConfig, a: typeof githubAccounts.$inferSelect) {
    if (a.needsAuthorization) throw new GithubError('请用户重新授权 GitHub');
    if (!a.expiresAt || a.expiresAt.getTime() > Date.now() + 60000) return decryptSecret(a.accessTokenEncrypted);
    if (!a.refreshTokenEncrypted) {
      await this.db.update(githubAccounts).set({ needsAuthorization: true }).where(eq(githubAccounts.version, a.version));
      throw new GithubError('GitHub 授权已过期，请重新关联');
    }
    try {
      const t = await this.client.oauth(c, { grant_type: 'refresh_token', refresh_token: decryptSecret(a.refreshTokenEncrypted) });
      await this.db.update(githubAccounts).set(this.tokenValues(t)).where(and(eq(githubAccounts.userId, a.userId), eq(githubAccounts.version, a.version)));
      return t.access_token as string;
    } catch (e) {
      if (!(e instanceof GithubError) || !e.retryable)
        await this.db.update(githubAccounts).set({ needsAuthorization: true }).where(eq(githubAccounts.version, a.version));
      throw e;
    }
  }
  private async updateMembership(c: GithubConfig, a: typeof githubAccounts.$inferSelect) {
    const identity = await this.client.identity(c, undefined, a.githubId);
    const membership = await this.client.membership(c, identity.login);
    const orgState = membership?.state === 'active' ? 'active' : membership?.state === 'pending' ? 'pending' : 'absent';
    await this.db.update(githubAccounts).set({ login: identity.login, orgState, orgRole: membership?.role ?? null,
      checkedAt: new Date(), error: '' }).where(eq(githubAccounts.version, a.version));
    return { state: orgState, login: identity.login };
  }
  private async accountTask(c: GithubConfig, task: TaskRow, guard: () => void) {
    const a = await this.account(task.payload.userId!);
    if (!a || a.version !== task.payload.bindingVersion) return;
    const actor = await this.user(task.payload.actorId!);
    if (!['remove-org', 'refresh'].includes(task.kind)) await this.user(a.userId);
    if ((task.kind === 'remove-org' || (task.kind === 'join' && actor.id !== a.userId)) && actor.role !== 'admin') throw new GithubError('操作者已无管理权限');
    const m = await this.updateMembership(c, a);
    if (task.kind === 'refresh') return;
    await this.ensureCurrent(task, guard, c.revision);
    if (task.kind === 'remove-org') {
      await this.client.removeOrganization(c, m.login);
      await this.updateMembership(c, a);
      await this.db.update(githubTasks).set({ state: 'cancelled', generation: sql`${githubTasks.generation} + 1` })
        .where(sql`${githubTasks.payload}->>'userId' = ${a.userId} AND ${githubTasks.kind} in ('grant','role')`);
      return;
    }
    if (m.state === 'active') return;
    if (task.kind === 'join' && m.state === 'absent') { await this.client.invite(c, a.githubId); await this.updateMembership(c, a); }
    await this.ensureCurrent(task, guard, c.revision);
    const fresh = await this.account(a.userId);
    if (!fresh || fresh.version !== a.version) return;
    const token = await this.userToken(c, fresh);
    let status: number;
    try { status = await this.client.accept(c, token); }
    catch (e) {
      if (e instanceof GithubError && e.message.includes('授权已失效'))
        await this.db.update(githubAccounts).set({ needsAuthorization: true }).where(eq(githubAccounts.version, a.version));
      throw e;
    }
    const after = await this.updateMembership(c, a);
    if (after.state !== 'active') {
      if (status === 202) await this.db.update(githubAccounts).set({ orgState: 'processing' }).where(eq(githubAccounts.version, a.version));
      throw new GithubWaiting('组织加入处理中');
    }
  }
  private async app(id: string) {
    const [app] = await this.db.select().from(apps).where(eq(apps.id, id));
    if (!app) throw new NotFoundException('应用不存在');
    return app;
  }
  private async bySlug(slug: string) {
    const [app] = await this.db.select().from(apps).where(eq(apps.slug, slug));
    if (!app) throw new NotFoundException('应用不存在');
    return app;
  }
  private async memberIds(app: typeof apps.$inferSelect) {
    return [app.ownerId, ...(await this.db.select().from(appMembers).where(eq(appMembers.appId, app.id))).map(m => m.userId)];
  }
  private blankApp(c: GithubConfig | undefined): GithubAppInfo {
    return { enabled: c?.enabled ?? false, organization: c?.organization ?? '', repository: null, repositoryId: null,
      scope: 'unknown', checkedAt: null, error: '', ownerLogin: null, ownerRole: 'unknown', ownerIsOrgOwner: false, members: [] };
  }
  async appInfo(slug: string, viewer: AuthUser): Promise<GithubAppInfo> {
    const app = await this.bySlug(slug), c = await this.store.config(false);
    const [cached] = await this.db.select().from(githubRepositories).where(eq(githubRepositories.appId, app.id));
    const data = cached?.version === app.repoVersion ? { ...cached.data } : this.blankApp(c);
    data.enabled = !!c?.enabled;
    const ids = await this.memberIds(app), members = await this.db.select().from(users).where(inArray(users.id, ids));
    const accounts = await this.db.select().from(githubAccounts).where(inArray(githubAccounts.userId, [...ids, viewer.id]));
    const tasks = await this.db.select().from(githubTasks).where(sql`${githubTasks.payload}->>'appId' = ${app.id} OR (${data.repositoryId}::text IS NOT NULL AND ${githubTasks.payload}->>'repositoryId' = ${data.repositoryId})`);
    const viewerAccount = accounts.find(a => a.userId === viewer.id);
    const viewerTask = tasks.find(t => t.key === `viewer:${app.id}:${viewer.id}`);
    const viewerRole = viewerTask?.state === 'succeeded' && viewerTask.payload.version === app.repoVersion && viewerTask.payload.bindingVersion === viewerAccount?.version
      ? viewerTask.payload.observedRole : data.members.find(m => m.userId === viewer.id && m.login === viewerAccount?.login)?.role;
    if (c?.enabled && viewerAccount && !ids.includes(viewer.id) && (!viewerTask || (viewerTask.state !== 'pending' && Date.now() - viewerTask.updatedAt.getTime() > 300000))) {
      await this.store.enqueue(this.db, `viewer:${app.id}:${viewer.id}`, 'viewer', { appId: app.id, actorId: viewer.id,
        version: app.repoVersion, bindingVersion: viewerAccount.version }); this.wake();
    }
    const cleanupGrants = data.repositoryId ? await this.db.select().from(githubGrants).where(eq(githubGrants.repositoryId, data.repositoryId)) : [];
    const owner = accounts.find(a => a.userId === app.ownerId);
    if (!owner || owner.login !== data.ownerLogin) { data.ownerLogin = owner?.login ?? null; data.ownerRole = 'unknown'; data.ownerIsOrgOwner = false; }
    data.members = members.map(u => {
      const a = accounts.find(a => a.userId === u.id), previous = data.members.find(m => m.userId === u.id && m.login === a?.login);
      const task = tasks.filter(t => t.payload.userId === u.id && ['grant', 'role'].includes(t.kind)).sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0];
      const privileged = viewer.role === 'admin' || viewerRole === 'admin';
      const maintain = viewerRole === 'maintain';
      return { userId: u.id, name: u.name, login: a?.login ?? null, orgState: a?.orgState ?? 'unknown',
        role: previous?.role ?? 'unknown', state: task?.state ?? (a ? 'not_requested' : 'unlinked'),
        error: task?.error || cleanupGrants.find(g => g.userId === u.id)?.error || previous?.error || '', notification: task?.notification ?? '',
        canGrant: !!c?.enabled && data.scope === 'organization' && app.deployApproved && app.approvedRepoVersion === app.repoVersion && (privileged || maintain),
        canChangeRole: !!c?.enabled && data.scope === 'organization' && app.deployApproved && app.approvedRepoVersion === app.repoVersion && privileged };
    });
    if (c?.enabled && (!cached || cached.version !== app.repoVersion || Date.now() - cached.checkedAt.getTime() > 300000)) {
      await this.queueRefresh(app.id, app.repoVersion); this.wake();
    }
    return data;
  }
  private async queueRefresh(appId: string, version: number, force = false) {
    const key = `repo:${appId}`;
    const [t] = await this.db.select().from(githubTasks).where(eq(githubTasks.key, key));
    if (t?.state === 'pending' || (!force && t?.state === 'failed' && Date.now() - t.updatedAt.getTime() < 300000)) return;
    await this.store.enqueue(this.db, key, 'repository', { appId, version });
  }
  async refreshApp(slug: string) {
    const app = await this.bySlug(slug); await this.store.config();
    await this.queueRefresh(app.id, app.repoVersion, true); this.wake(); return { ok: true };
  }
  async grant(slug: string, userId: string, actor: AuthUser, role?: GithubRole) {
    const app = await this.bySlug(slug); const c = await this.store.config();
    if (!app.deployApproved || app.approvedRepoVersion !== app.repoVersion) throw new ForbiddenException('应用尚未获得当前仓库的部署批准');
    if (!(await this.memberIds(app)).includes(userId)) throw new BadRequestException('目标用户不是应用成员');
    const key = `grant:${app.id}:${userId}`;
    const [old] = await this.db.select().from(githubTasks).where(eq(githubTasks.key, key));
    if (!role && old?.kind === 'role' && ['failed', 'waiting', 'pending'].includes(old.state)) role = old.payload.role;
    // Check before replacing a queued operation; an unauthorized caller must not cancel someone else's task.
    const targetAccount = await this.account(userId), actorAccount = await this.account(actor.id);
    if (actor.role !== 'admin') {
      if (!actorAccount) throw new ForbiddenException('请先关联有仓库管理权限的 GitHub 账户');
      c.organizationId = await this.client.check(c);
      const repo = await this.verifiedRepo(c, app);
      const identity = await this.client.identity(c, undefined, actorAccount.githubId);
      const permission = await this.client.permission(c, repo.full_name, identity.login);
      if (roleRank(permission) < (role ? 5 : 4)) throw new ForbiddenException('GitHub 仓库权限不足');
    }
    if (old?.state === 'pending' && old.payload.actorId === actor.id && old.payload.role === role) return { ok: true, githubState: 'pending' };
    await this.store.enqueue(this.db, key, role ? 'role' : 'grant', { appId: app.id, userId, actorId: actor.id, version: app.repoVersion, role, manual: true, bindingVersion: targetAccount?.version, actorBindingVersion: actorAccount?.version });
    this.wake(); return { ok: true, githubState: 'pending' };
  }
  private async verifiedRepo(c: GithubConfig, app: typeof apps.$inferSelect) {
    const fullName = githubFullName(app.repoUrl);
    if (!fullName || fullName.split('/')[0].toLowerCase() !== c.organization.toLowerCase()) throw new GithubError('仅管理指定组织内的仓库');
    const repo = await this.client.repository(c, fullName);
    if (repo.owner?.type !== 'Organization' || String(repo.owner.id) !== c.organizationId ||
      repo.owner.login.toLowerCase() !== c.organization.toLowerCase()) throw new GithubError('仓库不属于指定组织');
    return repo;
  }
  private async repositoryTask(c: GithubConfig, task: TaskRow) {
    const [app] = await this.db.select().from(apps).where(eq(apps.id, task.payload.appId!));
    if (!app || app.repoVersion !== task.payload.version) return;
    const data = this.blankApp(c), fullName = githubFullName(app.repoUrl);
    data.checkedAt = new Date().toISOString();
    data.repository = fullName;
    const owner = await this.account(app.ownerId);
    data.ownerLogin = owner?.login ?? null;
    if (!fullName || fullName.split('/')[0].toLowerCase() !== c.organization.toLowerCase()) data.scope = 'outside';
    else {
      try {
        const repo = await this.verifiedRepo(c, app);
        data.scope = 'organization'; data.repositoryId = String(repo.id); data.repository = repo.full_name;
        for (const id of await this.memberIds(app)) {
          const a = await this.account(id), [u] = await this.db.select().from(users).where(eq(users.id, id));
          let role: GithubAppInfo['ownerRole'] = 'unknown', error = '';
          if (a) {
            try {
              const m = await this.updateMembership(c, a);
              role = await this.client.permission(c, repo.full_name, m.login);
              if (id === app.ownerId) {
                data.ownerLogin = m.login; data.ownerRole = role;
                data.ownerIsOrgOwner = (await this.account(id))?.orgRole === 'admin';
              }
            } catch (e) { error = e instanceof GithubError ? e.message : 'GitHub 状态暂不可用'; }
          }
          const fresh = await this.account(id);
          data.members.push({ userId: id, name: u?.name ?? '', login: fresh?.login ?? null, orgState: fresh?.orgState ?? 'unknown',
            role, state: 'not_requested', error, notification: '', canGrant: false, canChangeRole: false });
        }
      } catch (e) { data.error = e instanceof GithubError ? e.message : 'GitHub 状态暂不可用'; }
    }
    const [current] = await this.db.select().from(apps).where(eq(apps.id, app.id));
    if (!current || current.repoVersion !== app.repoVersion) return;
    await this.db.insert(githubRepositories).values({ appId: app.id, version: app.repoVersion, repositoryId: data.repositoryId,
      fullName: data.repository, data, checkedAt: new Date() }).onConflictDoUpdate({ target: githubRepositories.appId,
      set: { version: app.repoVersion, repositoryId: data.repositoryId, fullName: data.repository, data, checkedAt: new Date() } });
    if (data.error) throw new GithubError(data.error, true);
  }
  private async viewerTask(c: GithubConfig, task: TaskRow) {
    const app = await this.app(task.payload.appId!), a = await this.account(task.payload.actorId!);
    if (!a || a.version !== task.payload.bindingVersion || app.repoVersion !== task.payload.version) return;
    await this.user(a.userId);
    const repo = await this.verifiedRepo(c, app), identity = await this.client.identity(c, undefined, a.githubId);
    const observedRole = await this.client.permission(c, repo.full_name, identity.login);
    await this.db.update(githubTasks).set({ payload: { ...task.payload, observedRole } })
      .where(and(eq(githubTasks.key, task.key), eq(githubTasks.generation, task.generation)));
  }
  private async ensureCurrent(task: TaskRow, guard: () => void, configRevision?: string) {
    guard();
    const config = await this.store.config();
    if (configRevision) this.store.assertRevision(config, configRevision);
    const [current] = await this.db.select().from(githubTasks).where(eq(githubTasks.key, task.key));
    if (!current || current.generation !== task.generation || current.state === 'cancelled') throw new GithubError('操作已被更新或取消');
  }
  private async grantTask(c: GithubConfig, task: TaskRow, guard: () => void) {
    const app = await this.app(task.payload.appId!);
    if (app.repoVersion !== task.payload.version || !app.deployApproved || app.approvedRepoVersion !== app.repoVersion)
      throw new GithubError('仓库关联或部署批准已变化，请重新操作');
    if (!(await this.memberIds(app)).includes(task.payload.userId!)) throw new GithubError('用户已不是应用成员');
    const actor = await this.user(task.payload.actorId!), target = await this.user(task.payload.userId!);
    const actorAccount = await this.account(actor.id), account = await this.account(target.id);
    if (!account) throw new GithubWaiting('等待成员关联 GitHub');
    if ((task.payload.bindingVersion && task.payload.bindingVersion !== account.version) ||
      (task.payload.actorBindingVersion && task.payload.actorBindingVersion !== actorAccount?.version))
      throw new GithubError('GitHub 绑定已变化，请重新发起操作');
    const repo = await this.verifiedRepo(c, app);
    if (actor.role !== 'admin') {
      if (!actorAccount) throw new GithubError('操作者需要关联 GitHub，或由 EAT 管理员处理');
      const identity = await this.client.identity(c, undefined, actorAccount.githubId);
      const permission = await this.client.permission(c, repo.full_name, identity.login);
      if (roleRank(permission) < (task.kind === 'role' ? 5 : 4)) throw new GithubError('操作者的仓库权限不足');
    }
    const m = await this.updateMembership(c, account);
    if (m.state !== 'active') throw new GithubWaiting('等待成员加入组织');
    await this.db.update(githubTasks).set({ payload: { ...task.payload, repositoryId: String(repo.id) } })
      .where(and(eq(githubTasks.key, task.key), eq(githubTasks.generation, task.generation)));
    const key = `${repo.id}:${account.githubId}`;
    let [grant] = await this.db.select().from(githubGrants).where(eq(githubGrants.key, key));
    if (grant?.roleChangedAt && task.kind === 'grant' && grant.roleChangedAt > new Date(task.payload.intentAt ?? task.updatedAt)) return;
    const role = task.payload.role ?? 'write';
    const effective = await this.client.permission(c, repo.full_name, m.login);
    if (task.kind === 'grant' && roleRank(effective) >= roleRank('write')) {
      if (grant?.prepared) {
        const observed = await this.client.directRole(c, repo.full_name, m.login);
        if (observed === grant.appliedRole)
          await this.db.update(githubGrants).set({ prepared: false, error: '' }).where(eq(githubGrants.key, key));
        await this.store.enqueue(this.db, 'cleanup', 'cleanup', {});
      }
      return;
    }
    const direct = await this.client.directRole(c, repo.full_name, m.login);
    if (grant?.prepared && direct === grant.appliedRole && grant.appliedRole === role) {
      await this.db.update(githubGrants).set({ prepared: false, error: '' }).where(eq(githubGrants.key, key));
      await this.store.enqueue(this.db, 'cleanup', 'cleanup', {});
      return;
    }
    if (!grant) {
      // The collaborator API exposes effective roles even for affiliation=direct. Existing grants
      // may inherit higher permissions, so do not promise an unsafe automatic restoration.
      [grant] = await this.db.insert(githubGrants).values({ key, repositoryId: String(repo.id), fullName: repo.full_name,
        githubId: account.githubId, userId: account.userId, login: m.login, previousRole: direct,
        baselineSafe: direct === null, appliedRole: role, managed: true, prepared: true,
        roleChangedAt: task.kind === 'role' ? new Date(task.payload.intentAt ?? task.updatedAt) : null }).returning();
    } else {
      if (!grant.prepared && direct !== grant.appliedRole && direct !== null)
        throw new GithubError('仓库授权在 GitHub 中发生变化，请管理员先核对现有权限');
      await this.db.update(githubGrants).set({ prepared: true, appliedRole: role, fullName: repo.full_name, login: m.login,
        error: '', ...(task.kind === 'role' ? { roleChangedAt: new Date(task.payload.intentAt ?? task.updatedAt) } : {}) }).where(eq(githubGrants.key, key));
    }
    await this.ensureCurrent(task, guard, c.revision);
    const latest = await this.app(app.id), latestAccount = await this.account(target.id), latestActorAccount = await this.account(actor.id);
    await this.user(actor.id); await this.user(target.id);
    if (latest.repoVersion !== app.repoVersion || !latest.deployApproved || latest.approvedRepoVersion !== latest.repoVersion ||
      !(await this.memberIds(latest)).includes(target.id) || latestAccount?.version !== account.version ||
      (actor.role !== 'admin' && latestActorAccount?.version !== actorAccount?.version)) throw new GithubError('成员或账户状态已变化');
    await this.client.setRole(c, repo.full_name, m.login, role);
    guard();
    await this.db.update(githubGrants).set({ prepared: false, error: '' }).where(eq(githubGrants.key, key));
    await this.db.update(githubRepositories).set({ checkedAt: new Date(0) }).where(eq(githubRepositories.repositoryId, String(repo.id)));
    // Always reconcile after a provider mutation, including an EAT change while the request was in flight.
    await this.store.enqueue(this.db, 'cleanup', 'cleanup', {});
    const actual = await this.client.permission(c, repo.full_name, m.login);
    if (actual !== role && task.kind === 'role') throw new GithubError(`已设置直接角色，但实际角色仍为 ${actual}；请检查团队或组织继承权限`);
  }
  private async cleanupTask(c: GithubConfig, guard: () => void) {
    const grants = await this.db.select().from(githubGrants).where(eq(githubGrants.managed, true));
    let failure = '';
    let retryable = false, retryAfter = 0;
    for (const g of grants) {
      try {
        const [u] = await this.db.select().from(users).where(eq(users.id, g.userId));
        // Unlink alone must not revoke existing access. Disabled users are still cleaned up.
        const candidates = u?.status === 'active' ? await this.db.select().from(apps)
          .where(sql`${apps.ownerId} = ${g.userId} OR EXISTS (SELECT 1 FROM app_member WHERE app_id = ${apps.id} AND user_id = ${g.userId})`) : [];
        let needed = false;
        for (const app of candidates) {
          const fullName = githubFullName(app.repoUrl);
          if (fullName?.toLowerCase() === g.fullName.toLowerCase()) { needed = true; break; }
          const [cached] = await this.db.select().from(githubRepositories).where(eq(githubRepositories.appId, app.id));
          if (cached?.version === app.repoVersion && cached.repositoryId === g.repositoryId) { needed = true; break; }
        }
        if (needed) continue;
        const repo = await this.client.repository(c, g.fullName);
        if (String(repo.id) !== g.repositoryId || String(repo.owner?.id) !== c.organizationId) throw new GithubError('仓库身份已变化，未自动撤权');
        const identity = await this.client.identity(c, undefined, g.githubId);
        const direct = await this.client.directRole(c, repo.full_name, identity.login);
        if (direct === null) { await this.db.delete(githubGrants).where(eq(githubGrants.key, g.key)); continue; }
        if (direct !== g.appliedRole || !g.baselineSafe) throw new GithubError('原有或外部授权来源不明确，请管理员在 GitHub 核对后手动撤权');
        guard(); this.store.assertRevision(await this.store.config(), c.revision);
        // Recheck demand after reads; a concurrent re-share will also queue a fresh grant task.
        const needs = await this.db.select().from(apps).where(sql`(${apps.ownerId} = ${g.userId} OR EXISTS (SELECT 1 FROM app_member WHERE app_id = ${apps.id} AND user_id = ${g.userId}))`);
        const [currentUser] = await this.db.select().from(users).where(eq(users.id, g.userId));
        if (currentUser?.status === 'active' && needs.some(a => githubFullName(a.repoUrl)?.toLowerCase() === g.fullName.toLowerCase())) continue;
        await this.client.setRole(c, repo.full_name, identity.login, g.previousRole);
        await this.db.delete(githubGrants).where(eq(githubGrants.key, g.key));
      } catch (e) {
        const error = e instanceof GithubError ? e.message : '仓库撤权失败';
        if (e instanceof GithubError && e.retryable) {
          retryable = true; retryAfter = Math.max(retryAfter, e.retryAfter);
        }
        failure = error; await this.db.update(githubGrants).set({ error }).where(eq(githubGrants.key, g.key));
      }
    }
    if (failure) throw new GithubError(failure, retryable, retryAfter);
  }
  private async notifyFailure(task: TaskRow, message: string): Promise<string> {
    const recipients = await this.db.select({ url: userNotifications.webhookUrl, secret: userNotifications.webhookSecretEncrypted })
      .from(users).innerJoin(userNotifications, eq(users.id, userNotifications.userId))
      .where(and(eq(users.role, 'admin'), eq(users.status, 'active'), sql`${userNotifications.verifiedAt} IS NOT NULL`));
    const valid = recipients.filter(r => !!r.url);
    if (!valid.length) return '没有管理员配置有效的飞书通知';
    let failed = false;
    const link = `${loadConfig().publicUrl.replace(/\/$/, '')}${task.kind === 'cleanup' ? '/settings?section=github' : task.payload.appId ? '/apps' : '/users'}`;
    for (const r of valid) {
      try { await this.webhook.sendCardOnce(r.url!, r.secret ? decryptSecret(r.secret) : null, {
        header: { title: { tag: 'plain_text', content: 'GitHub 操作未完成' } },
        elements: [{ tag: 'div', text: { tag: 'plain_text', content: `${task.kind} · ${task.payload.userId ?? task.payload.appId ?? '仓库撤权'}\n${message}` } },
          { tag: 'action', actions: [{ tag: 'button', text: { tag: 'plain_text', content: '查看并处理' }, url: link }] }],
      }); } catch { failed = true; }
    }
    return failed ? '部分管理员通知投递失败' : '已通知管理员';
  }
  async cleanupState() {
    const grants = await this.db.select({ repository: githubGrants.fullName, login: githubGrants.login, error: githubGrants.error })
      .from(githubGrants).where(sql`${githubGrants.error} <> ''`);
    const [task] = await this.db.select().from(githubTasks).where(eq(githubTasks.key, 'cleanup'));
    return { grants, task: task ? { state: task.state, error: task.error, notification: task.notification } : null };
  }
  async retryCleanup() {
    await this.store.config();
    const [t] = await this.db.select().from(githubTasks).where(eq(githubTasks.key, 'cleanup'));
    if (t?.state !== 'pending') await this.store.enqueue(this.db, 'cleanup', 'cleanup', { manual: true });
    this.wake(); return { ok: true };
  }
  async tick() {
    const c = await this.store.config(false);
    if (!c?.enabled) return;
    await this.store.exclusive(async guard => {
      const jobs = await this.db.select().from(githubTasks).where(and(inArray(githubTasks.state, ['pending', 'waiting']), lte(githubTasks.retryAt, new Date())))
        .orderBy(githubTasks.retryAt).limit(10);
      if (!jobs.length) return;
      let configError: unknown;
      try {
        const organizationId = await this.client.check(c);
        c.organizationId = organizationId;
        await this.db.update(githubSettings).set({ organizationId, connectionState: 'connected', connectionError: '', checkedAt: new Date() })
          .where(and(eq(githubSettings.id, 1), eq(githubSettings.revision, c.revision)));
      } catch (e) { configError = e; await this.store.connectionError(c, e); }
      for (const task of jobs) {
        let state = 'succeeded', error = '', retryAt = new Date(), attempts = task.attempts, notification = task.notification;
        try {
          await this.ensureCurrent(task, guard, c.revision);
          if (configError) throw configError;
          if (task.kind === 'repository') await this.repositoryTask(c, task);
          else if (task.kind === 'viewer') await this.viewerTask(c, task);
          else if (task.kind === 'grant' || task.kind === 'role') await this.grantTask(c, task, guard);
          else if (task.kind === 'cleanup') await this.cleanupTask(c, guard);
          else await this.accountTask(c, task, guard);
        } catch (e) {
          error = e instanceof GithubError || e instanceof GithubWaiting ? e.message : 'GitHub 操作未完成，请刷新后重试';
          if (e instanceof GithubWaiting) { state = 'waiting'; retryAt = new Date(Date.now() + 30000); }
          else {
            attempts++;
            const retry = !task.payload.manual && e instanceof GithubError && e.retryable && attempts < 5;
            state = retry ? 'pending' : 'failed';
            retryAt = new Date(Date.now() + Math.max(e instanceof GithubError ? e.retryAfter : 0, [30000, 120000, 600000, 1800000][Math.min(attempts - 1, 3)]));
          }
          if (task.payload.userId && ['join', 'accept', 'refresh', 'remove-org'].includes(task.kind)) {
            await this.db.update(githubAccounts).set({ error, ...(task.kind === 'refresh' ? { orgState: 'unknown' as const } : {}) })
              .where(and(eq(githubAccounts.userId, task.payload.userId), eq(githubAccounts.version, task.payload.bindingVersion!)));
          }
        }
        guard();
        const updated = await this.db.update(githubTasks).set({ state, error, attempts, retryAt, updatedAt: new Date() })
          .where(and(eq(githubTasks.key, task.key), eq(githubTasks.generation, task.generation))).returning();
        if (updated.length && state === 'failed' && !notification && !['repository', 'refresh', 'viewer'].includes(task.kind)) {
          notification = await this.notifyFailure(task, error).catch(() => '管理员通知投递失败');
          await this.db.update(githubTasks).set({ notification }).where(and(eq(githubTasks.key, task.key), eq(githubTasks.generation, task.generation)));
        }
        if (task.payload.appId && ['grant', 'role'].includes(task.kind)) await this.queueRefresh(task.payload.appId, task.payload.version!);
      }
    });
  }
}
