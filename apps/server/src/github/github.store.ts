import { BadRequestException, ConflictException, Inject, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { githubRepoWebUrl, type UpdateGithubSettings, type GithubSettingsInfo } from '@eat/shared';
import { DB, PG_POOL, type Db } from '../db/db.module';
import { githubSettings, githubAccounts, githubTasks, githubGrants, githubRepositories, apps } from '../db/schema';
import { encryptSecret } from '../common/crypto';
import { loadConfig } from '../config';
import { GithubClient, GithubConfig, GithubError } from './github.client';

export type GithubTx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type TaskRow = typeof githubTasks.$inferSelect;
export const repositoryIdentity = (url: string) => githubRepoWebUrl(url)?.toLowerCase() ?? url.trim().replace(/\/$/, '').replace(/\.git$/, '');
export function githubFullName(url: string): string | null {
  const web = githubRepoWebUrl(url);
  return web ? new URL(web).pathname.slice(1) : null;
}
@Injectable()
export class GithubStore {
  constructor(@Inject(DB) readonly db: Db, @Inject(PG_POOL) readonly pool: Pool, private readonly client: GithubClient) {}
  async config(required = true) {
    const [c] = await this.db.select().from(githubSettings).where(eq(githubSettings.id, 1));
    if (required && !c?.enabled) throw new GithubError('GitHub 接入未启用');
    return c;
  }
  async settings(): Promise<GithubSettingsInfo> {
    const c = await this.config(false);
    const base = loadConfig().publicUrl.replace(/\/$/, '');
    return { enabled: c?.enabled ?? false, organization: c?.organization ?? '', appId: c?.appId ?? '',
      clientId: c?.clientId ?? '', installationId: c?.installationId ?? '', hasClientSecret: !!c?.clientSecretEncrypted,
      hasPrivateKey: !!c?.privateKeyEncrypted, callbackUrl: `${base}/api/github/callback`,
      setupCallbackUrl: `${base}/api/github/setup/installation`, manifestCallbackUrl: `${base}/api/github/setup/manifest`,
      appSlug: c?.appSlug ?? null, connectionState: c?.connectionState ?? 'unconfigured',
      connectionError: c?.connectionError ?? '', checkedAt: c?.checkedAt?.toISOString() ?? null };
  }
  async edit<T>(work: (tx: GithubTx, current: GithubConfig | undefined) => Promise<T>): Promise<T> {
    return this.db.transaction(async tx => {
      // Also serializes first-time setup, when no settings row exists to lock.
      await tx.execute(sql`select pg_advisory_xact_lock(1950536523)`);
      const [current] = await tx.select().from(githubSettings).where(eq(githubSettings.id, 1));
      return work(tx, current);
    });
  }
  assertRevision(current: GithubConfig | undefined, revision: string | null | undefined) {
    if ((current?.revision ?? null) !== (revision ?? null)) throw new ConflictException('GitHub 配置已变化，请重新开始');
  }
  async connectionError(c: GithubConfig, error: unknown) {
    await this.db.update(githubSettings).set({ connectionState: error instanceof GithubError ? error.connectionState : 'error',
      connectionError: error instanceof GithubError ? error.message : 'GitHub 连接暂不可用，请稍后重试', checkedAt: new Date() })
      .where(and(eq(githubSettings.id, 1), eq(githubSettings.revision, c.revision)));
  }
  async save(dto: UpdateGithubSettings) {
    const old = await this.config(false);
    const identityChanged = old && (old.organization.toLowerCase() !== dto.organization.toLowerCase() || old.appId !== dto.appId || old.clientId !== dto.clientId);
    if (identityChanged) {
      const bound = await this.db.select().from(githubAccounts).limit(1);
      const grants = await this.db.select().from(githubGrants).limit(1);
      if (bound.length || grants.length) throw new ConflictException('已有账户或仓库授权；更换 App 请使用重新初始化，不能直接更换组织');
    }
    const clientSecretEncrypted = dto.clientSecret ? encryptSecret(dto.clientSecret) : old?.clientSecretEncrypted;
    const privateKeyEncrypted = dto.privateKey ? encryptSecret(dto.privateKey) : old?.privateKeyEncrypted;
    if (!clientSecretEncrypted || !privateKeyEncrypted) throw new BadRequestException('请配置 Client Secret 和 App 私钥');
    const values: GithubConfig = { id: 1, enabled: dto.enabled, organization: dto.organization, appId: dto.appId, clientId: dto.clientId,
      installationId: dto.installationId, clientSecretEncrypted, privateKeyEncrypted,
      organizationId: old?.organization.toLowerCase() === dto.organization.toLowerCase() ? old.organizationId : null,
      revision: randomUUID(), appSlug: identityChanged ? null : old?.appSlug ?? null, connectionState: 'app_ready', connectionError: '', checkedAt: null };
    if (dto.enabled || (old && old.installationId !== dto.installationId)) {
      values.organizationId = await this.client.check(values); values.connectionState = 'connected'; values.checkedAt = new Date();
    }
    await this.edit(async (tx, current) => {
      this.assertRevision(current, old?.revision);
      // A binding may have completed during provider validation.
      if (identityChanged) {
        const bound = await tx.select().from(githubAccounts).limit(1), grants = await tx.select().from(githubGrants).limit(1);
        if (bound.length || grants.length) throw new ConflictException('已有账户或仓库授权，请使用重新初始化');
      }
      await tx.insert(githubSettings).values(values).onConflictDoUpdate({ target: githubSettings.id, set: values });
    });
    return this.settings();
  }
  async enqueue(tx: GithubTx | Db, key: string, kind: string, payload: TaskRow['payload'], replace = true) {
    const values = { key, kind, payload: { ...payload, intentAt: new Date().toISOString() }, state: 'pending', retryAt: new Date(), updatedAt: new Date(), attempts: 0, error: '', notification: '' };
    const insert = tx.insert(githubTasks).values(values);
    if (!replace) await insert.onConflictDoNothing();
    else await insert.onConflictDoUpdate({ target: githubTasks.key, set: { ...values, generation: sql`${githubTasks.generation} + 1` } });
  }
  async memberAdded(tx: GithubTx, app: typeof apps.$inferSelect, userId: string, actorId: string) {
    const [config] = await tx.select().from(githubSettings).where(eq(githubSettings.id, 1));
    if (!config?.enabled) return;
    const [target] = await tx.select().from(githubAccounts).where(eq(githubAccounts.userId, userId));
    const [actor] = await tx.select().from(githubAccounts).where(eq(githubAccounts.userId, actorId));
    await this.enqueue(tx, `grant:${app.id}:${userId}`, 'grant', { appId: app.id, userId, actorId, version: app.repoVersion,
      bindingVersion: target?.version, actorBindingVersion: actor?.version });
  }
  async appChanged(tx: GithubTx, appId: string) {
    await tx.update(githubTasks).set({ state: 'cancelled', generation: sql`${githubTasks.generation} + 1` })
      .where(sql`${githubTasks.payload}->>'appId' = ${appId} AND ${githubTasks.kind} in ('grant','role')`);
    await tx.delete(githubRepositories).where(eq(githubRepositories.appId, appId));
    await this.enqueue(tx, 'cleanup', 'cleanup', {});
  }
  async memberRemoved(tx: GithubTx, appId: string, userId: string) {
    await tx.update(githubTasks).set({ state: 'cancelled', generation: sql`${githubTasks.generation} + 1` })
      .where(sql`${githubTasks.payload}->>'appId' = ${appId} AND ${githubTasks.payload}->>'userId' = ${userId}`);
    await this.enqueue(tx, 'cleanup', 'cleanup', {});
  }
  async userChanged(tx: GithubTx, userId: string) {
    await tx.update(githubTasks).set({ state: 'cancelled', generation: sql`${githubTasks.generation} + 1` })
      .where(sql`(${githubTasks.payload}->>'userId' = ${userId} OR ${githubTasks.payload}->>'actorId' = ${userId}) AND ${githubTasks.kind} in ('grant','role','join','accept')`);
    await this.enqueue(tx, 'cleanup', 'cleanup', {});
  }
  async exclusive(work: (guard: () => void) => Promise<void>) {
    const connection = await this.pool.connect();
    let locked = false, lost = false;
    const onError = () => { lost = true; };
    connection.on('error', onError);
    try {
      locked = (await connection.query('select pg_try_advisory_lock($1) as locked', [1950536522])).rows[0].locked;
      if (!locked) return;
      await work(() => { if (lost) throw new GithubError('后台任务锁已失效', true); });
    } finally {
      if (locked && !lost) await connection.query('select pg_advisory_unlock($1)', [1950536522]).catch(() => { lost = true; });
      connection.off('error', onError); connection.release(lost);
    }
  }
}
