import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { eq, inArray, sql } from 'drizzle-orm';
import type { GithubCollaborator, GithubCollaboratorChange, GithubCollaboratorsInfo } from '@eat/shared';
import type { AuthUser } from '../auth/auth.decorators';
import { apiTokens, appMembers, apps, githubAccounts, githubGrants, githubRepositories, githubTasks, users } from '../db/schema';
import { GithubClient, GithubConfig, GithubError } from './github.client';
import { GithubStore, githubFullName } from './github.store';

@Injectable()
export class GithubCollaboratorsService {
  constructor(private readonly store: GithubStore, private readonly client: GithubClient) {}
  private get db() { return this.store.db; }
  private async app(slug: string) {
    const [app] = await this.db.select().from(apps).where(eq(apps.slug, slug));
    if (!app) throw new NotFoundException('应用不存在');
    return app;
  }
  private async actor(user: AuthUser) {
    const [current] = await this.db.select().from(users).where(eq(users.id, user.id));
    const [token] = await this.db.select().from(apiTokens).where(eq(apiTokens.id, user.tokenId));
    if (current?.status !== 'active' || !token || token.userId !== user.id || token.revokedAt)
      throw new ForbiddenException('登录身份已失效');
    return current;
  }
  private async repository(c: GithubConfig, app: typeof apps.$inferSelect) {
    const fullName = githubFullName(app.repoUrl);
    if (!fullName || fullName.split('/')[0].toLowerCase() !== c.organization.toLowerCase())
      throw new GithubError('仅管理指定组织内的仓库');
    const repo = await this.client.repository(c, fullName);
    if (repo.owner?.type !== 'Organization' || String(repo.owner.id) !== c.organizationId ||
      repo.owner.login.toLowerCase() !== c.organization.toLowerCase()) throw new GithubError('仓库不属于指定组织');
    return repo;
  }
  private async canManage(c: GithubConfig, repository: string, user: AuthUser) {
    const actor = await this.actor(user);
    if (actor.role === 'admin') return true;
    const [account] = await this.db.select().from(githubAccounts).where(eq(githubAccounts.userId, user.id));
    if (!account) return false;
    const identity = await this.client.identity(c, undefined, account.githubId);
    const role = await this.client.permission(c, repository, identity.login);
    const [current] = await this.db.select().from(githubAccounts).where(eq(githubAccounts.userId, user.id));
    if (current?.version !== account.version) throw new ConflictException('GitHub 账户已变化，请刷新后重试');
    return role === 'admin';
  }
  async list(slug: string, user: AuthUser): Promise<GithubCollaboratorsInfo> {
    await this.actor(user);
    const app = await this.app(slug), c = await this.store.config();
    c.organizationId = await this.client.check(c);
    const repo = await this.repository(c, app);
    const [collaborators, canManage, members] = await Promise.all([
      this.client.collaborators(c, repo.full_name), this.canManage(c, repo.full_name, user),
      this.db.select().from(appMembers).where(eq(appMembers.appId, app.id)),
    ]);
    const ids = collaborators.map(m => m.githubId);
    const linked = ids.length ? await this.db.select({ githubId: githubAccounts.githubId, userId: users.id, name: users.name })
      .from(githubAccounts).innerJoin(users, eq(users.id, githubAccounts.userId)).where(inArray(githubAccounts.githubId, ids)) : [];
    const byId = new Map(linked.map(a => [a.githubId, a]));
    const memberIds = new Set(members.map(m => m.userId));
    this.store.assertRevision(await this.store.config(), c.revision);
    if ((await this.app(slug)).repoVersion !== app.repoVersion) throw new ConflictException('仓库已变化，请刷新后重试');
    return { repository: repo.full_name, repositoryId: String(repo.id), repoVersion: app.repoVersion,
      checkedAt: new Date().toISOString(), canManage, collaborators: collaborators.map((m): GithubCollaborator => {
        const linked = byId.get(m.githubId);
        return { ...m, userId: linked?.userId ?? null, name: linked?.name ?? null,
          relation: !linked ? 'external' : linked.userId === app.ownerId ? 'owner' : memberIds.has(linked.userId) ? 'member' : 'eat' };
      }).sort((a, b) => Number(b.relation === 'owner') - Number(a.relation === 'owner') || a.login.localeCompare(b.login)) };
  }
  async change(slug: string, githubId: string, dto: GithubCollaboratorChange, user: AuthUser) {
    let result: { ok: true; role: string; direct: boolean } | undefined;
    // Share the worker lock so cleanup or an older grant cannot race a manual change.
    await this.store.exclusive(async guard => {
      const app = await this.app(slug), c = await this.store.config();
      c.organizationId = await this.client.check(c);
      const repo = await this.repository(c, app);
      if (String(repo.id) !== dto.repositoryId || app.repoVersion !== dto.repoVersion)
        throw new ConflictException('仓库已变化，请刷新后重试');
      if (!await this.canManage(c, repo.full_name, user)) throw new ForbiddenException('需要 GitHub 仓库 Admin 或 EAT 管理员权限');
      const target = await this.client.identity(c, undefined, githubId);
      if (target.id !== githubId) throw new ConflictException('GitHub 用户身份已变化');
      const direct = await this.client.directRole(c, repo.full_name, target.login);
      if (direct === null) throw new ConflictException('该用户已无直接授权，请刷新仓库列表');
      const role = await this.client.permission(c, repo.full_name, target.login);
      if (role !== dto.expectedRole) throw new ConflictException('仓库角色已变化，请刷新后重新确认');
      const membership = await this.client.membership(c, target.login);
      if (membership?.state === 'active' && membership.role === 'admin')
        throw new ForbiddenException('组织 Owner 的仓库访问由组织身份决定，请在 GitHub 管理');

      // Recheck after provider reads; never apply a stale edit to a replaced repo or revoked actor.
      guard(); this.store.assertRevision(await this.store.config(), c.revision);
      const current = await this.app(slug);
      if (current.repoVersion !== app.repoVersion) throw new ConflictException('仓库已变化，请刷新后重试');
      if (!await this.canManage(c, repo.full_name, user)) throw new ForbiddenException('仓库管理权限已变化');
      guard(); this.store.assertRevision(await this.store.config(), c.revision);
      if ((await this.app(slug)).repoVersion !== app.repoVersion) throw new ConflictException('仓库已变化，请刷新后重试');

      const relatedApps = await this.db.select().from(apps);
      const cached = await this.db.select().from(githubRepositories).where(eq(githubRepositories.repositoryId, String(repo.id)));
      const appIds = relatedApps.filter(a => githubFullName(a.repoUrl)?.toLowerCase() === repo.full_name.toLowerCase() ||
        cached.some(r => r.appId === a.id && r.version === a.repoVersion)).map(a => a.id);
      const [account] = await this.db.select().from(githubAccounts).where(eq(githubAccounts.githubId, githubId));
      if (account && appIds.length) {
        await this.db.update(githubTasks).set({ state: 'cancelled', generation: sql`${githubTasks.generation} + 1` })
          .where(sql`${githubTasks.kind} in ('grant','role') AND ${githubTasks.payload}->>'userId' = ${account.userId}
            AND (${githubTasks.payload}->>'repositoryId' = ${String(repo.id)} OR ${inArray(sql`${githubTasks.payload}->>'appId'`, appIds)})`);
      }
      const key = `${repo.id}:${githubId}`;
      const [grant] = await this.db.select().from(githubGrants).where(eq(githubGrants.key, key));
      const memberships = account && appIds.length ? await this.db.select().from(appMembers)
        .where(sql`${appMembers.userId} = ${account.userId} AND ${inArray(appMembers.appId, appIds)}`) : [];
      const stillNeeded = !!account && (memberships.length > 0 || relatedApps.some(a => appIds.includes(a.id) && a.ownerId === account.userId));
      // Preserve automatic cleanup only for access EAT can still prove it owns.
      if (grant && dto.role) await this.db.update(githubGrants).set({ appliedRole: dto.role,
        managed: grant.managed && grant.baselineSafe && direct === grant.appliedRole && stillNeeded,
        prepared: true, error: '', roleChangedAt: new Date() }).where(eq(githubGrants.key, key));
      try {
        guard();
        await this.client.setRole(c, repo.full_name, target.login, dto.role);
        guard();
        const afterDirect = await this.client.directRole(c, repo.full_name, target.login);
        if (dto.role === null && afterDirect !== null) throw new GithubError('直接授权仍存在，请刷新后重新操作');
        if (dto.role !== null && afterDirect === null) throw new GithubError('尚未核验到直接授权，请刷新后确认');
        if (dto.role === null) await this.db.delete(githubGrants).where(eq(githubGrants.key, key));
        else if (grant) await this.db.update(githubGrants).set({ prepared: false }).where(eq(githubGrants.key, key));
        const actual = await this.client.permission(c, repo.full_name, target.login);
        result = { ok: true, role: actual, direct: afterDirect !== null };
      } finally {
        // Includes timeouts after a possibly successful provider write. Never invent success locally.
        await this.db.update(githubRepositories).set({ checkedAt: new Date(0) }).where(eq(githubRepositories.repositoryId, String(repo.id)));
        for (const a of relatedApps.filter(a => appIds.includes(a.id)))
          await this.store.enqueue(this.db, `repo:${a.id}`, 'repository', { appId: a.id, version: a.repoVersion });
      }
    });
    if (!result) throw new ConflictException('GitHub 正在处理其他操作，请稍后重试');
    return result;
  }
}
