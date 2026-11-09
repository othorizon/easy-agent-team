import { ConflictException, ForbiddenException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { and, asc, eq, inArray, isNotNull, lte, ne, or } from 'drizzle-orm';
import { Pool } from 'pg';
import type { AliyunDeleteResult, AliyunDriftSnapshot, AliyunIdentityDrift } from '@eat/shared';
import { DB, PG_POOL, type Db } from '../db/db.module';
import { aliyunConnections, aliyunGrants, aliyunOperations, aliyunPermissions, cloudIdentities, users } from '../db/schema';
import { CloudIdentitiesService, type CloudIdentity, type IdentitySession } from '../cloud-identities/cloud-identities.service';
import { CloudIdentityUsageService } from '../cloud-identities/cloud-identity-usage.service';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/auth.decorators';
import { RamCloudError } from '../ram/ram-cloud';
import { AliyunService } from './aliyun.service';

type Connection = typeof aliyunConnections.$inferSelect;
@Injectable()
export class AliyunMaintenanceService {
  private readonly logger = new Logger(AliyunMaintenanceService.name);
  private readonly locks: Pool;
  private timer?: ReturnType<typeof setInterval>;
  private recovery?: Promise<void>;
  private stopped = false;
  constructor(@Inject(DB) private readonly db: Db, @Inject(PG_POOL) pool: Pool,
    private readonly aliyun: AliyunService, private readonly identities: CloudIdentitiesService,
    private readonly usage: CloudIdentityUsageService, private readonly audit: AuditService) {
    this.locks = new Pool({ ...pool.options, max: 2 });
    this.locks.on('error', () => undefined);
  }
  onModuleInit() { this.timer = setInterval(() => this.wake(), 30_000); this.timer.unref(); this.wake(); }
  private wake() {
    if (this.stopped || this.recovery) return;
    this.recovery = this.tick().catch(() => this.logger.warn('阿里云接入清理待重试')).finally(() => { this.recovery = undefined; });
  }
  async onModuleDestroy() { this.stopped = true; clearInterval(this.timer); await this.recovery; await this.locks.end(); }
  private error(e: unknown) {
    return e instanceof RamCloudError || e instanceof ConflictException || e instanceof NotFoundException ? e.message : '阿里云清理或核对失败，请检查管理凭证与权限后重试';
  }
  /** A read-only cloud inspection. Only the local observation is persisted. */
  async checkDrift(session: IdentitySession, accountId: string, userId: string): Promise<AliyunDriftSnapshot> {
    let snapshot: AliyunDriftSnapshot;
    try {
      const actual = await session.inspect();
      const records = await this.db.select({ g: aliyunGrants, op: aliyunOperations }).from(aliyunGrants)
        .innerJoin(aliyunPermissions, eq(aliyunPermissions.id, aliyunGrants.permissionId))
        .innerJoin(aliyunConnections, eq(aliyunConnections.id, aliyunPermissions.connectionId))
        .leftJoin(aliyunOperations, eq(aliyunOperations.grantId, aliyunGrants.id))
        .where(and(eq(aliyunConnections.accountId, accountId), eq(aliyunGrants.userId, userId)));
      const desiredIds = records.filter(({ g, op }) => g.state === 'active' || (['pending', 'failed'].includes(g.state) && op?.kind === 'grant')).map(({ g }) => g.permissionId);
      const expected = new Set(desiredIds.length ? (await this.db.select().from(aliyunPermissions).where(inArray(aliyunPermissions.id, desiredIds))).map(p => p.policyName) : []);
      const bound = new Set(actual.policies.filter(p => p.type === 'Custom' && p.name.startsWith('eat-perm-')).map(p => p.name));
      snapshot = { missing: [...expected].filter(p => !bound.has(p)).sort(), extra: [...bound].filter(p => !expected.has(p)).sort(), checkedAt: new Date().toISOString(), error: null };
      snapshot.repairError = snapshot.missing.length || snapshot.extra.length ? actual.identity?.drift?.repairError ?? null : null;
    } catch (e) {
      snapshot = { missing: [], extra: [], checkedAt: new Date().toISOString(), error: this.error(e) };
    }
    session.guard();
    await this.db.update(cloudIdentities).set({ drift: snapshot, updatedAt: new Date() }).where(and(eq(cloudIdentities.accountId, accountId), eq(cloudIdentities.userId, userId)));
    return snapshot;
  }
  private async driftInfo(identity: CloudIdentity, c: Connection, snapshot: AliyunDriftSnapshot): Promise<AliyunIdentityDrift> {
    const [user] = await this.db.select().from(users).where(eq(users.id, identity.userId));
    return { ...snapshot, identityId: identity.id, userId: identity.userId, userName: user?.name ?? '', ramName: identity.ramName,
      connectionId: c.id, connectionName: c.name, canRepair: !c.cleanupState && !identity.cleanupPending && c.status === 'enabled' };
  }
  async inspectAll(actor: AuthUser): Promise<AliyunIdentityDrift[]> {
    if (actor.role !== 'admin') return [];
    const rows = await this.db.select({ identity: cloudIdentities, c: aliyunConnections }).from(cloudIdentities)
      .innerJoin(aliyunConnections, eq(aliyunConnections.accountId, cloudIdentities.accountId));
    const results: AliyunIdentityDrift[] = [];
    for (const { identity, c } of rows) {
      const snapshot = await this.identities.run(c.accountId, identity.userId, this.aliyun.credentials(c), s => this.checkDrift(s, c.accountId, identity.userId));
      results.push(await this.driftInfo(identity, c, snapshot));
    }
    return results;
  }
  async repair(actor: AuthUser, connectionId: string, identityId: string) {
    if (actor.role !== 'admin') throw new ForbiddenException('仅管理员可修复云端不一致');
    const c = await this.aliyun.connection(connectionId);
    const [identity] = await this.db.select().from(cloudIdentities).where(and(eq(cloudIdentities.id, identityId), eq(cloudIdentities.accountId, c.accountId)));
    if (!identity) throw new NotFoundException('个人身份不存在');
    return this.identities.run(c.accountId, identity.userId, this.aliyun.credentials(c), async session => {
      const current = await this.aliyun.connection(c.id);
      this.aliyun.assertWritable(current);
      if (current.status === 'paused') throw new ConflictException('接入已暂停，不能修复绑定；撤销与安全停用仍可执行');
      const before = await this.checkDrift(session, c.accountId, identity.userId);
      let failure: string | undefined;
      try {
        if (before.error) throw new ConflictException(before.error);
        // User provenance was verified by checkDrift before any binding mutation.
        for (const policy of before.extra) await session.repairPolicy(policy, false);
        for (const policy of before.missing) await session.repairPolicy(policy, true);
      } catch (e) { failure = this.error(e); }
      const after = await this.checkDrift(session, c.accountId, identity.userId);
      if (failure) {
        after.repairError = failure;
        session.guard();
        await this.db.update(cloudIdentities).set({ drift: after }).where(eq(cloudIdentities.id, identityId));
      }
      session.guard();
      await this.audit.record({ actorId: actor.id, actorTokenId: actor.tokenId, action: 'aliyun.drift.repair', targetType: 'cloud_identity', targetId: identityId,
        meta: { connectionId, missing: before.missing, extra: before.extra, error: after.error ?? after.repairError } });
      return { ok: !after.error && !after.repairError && !after.missing.length && !after.extra.length, drift: await this.driftInfo(identity, current, after) };
    });
  }
  private async locked<T>(id: string, work: (guard: () => void) => Promise<T>) {
    const lock = await this.locks.connect();
    let held = false, lost = false;
    const onError = () => { lost = true; };
    const guard = () => { if (lost) throw new ConflictException('接入删除锁已中断，请重试清理'); };
    lock.on('error', onError);
    try {
      await lock.query('select pg_advisory_lock(hashtextextended($1,0))', [`aliyun-cleanup:${id}`]); held = true; guard();
      return await work(guard);
    } finally {
      if (held && !lost) await lock.query('select pg_advisory_unlock(hashtextextended($1,0))', [`aliyun-cleanup:${id}`]).catch(() => { lost = true; });
      lock.off('error', onError); lock.release(lost);
    }
  }
  async remove(actor: AuthUser, id: string, confirmName: string): Promise<AliyunDeleteResult> {
    if (actor.role !== 'admin') throw new ForbiddenException('仅管理员可删除接入');
    return this.locked(id, async guard => {
      const c = await this.aliyun.connection(id);
      if (confirmName !== c.name) throw new ConflictException('请确认要删除的接入名称');
      // Lock the same connection row as grant/request publication. The barrier and all target
      // identity barriers commit before cloud I/O; neither cleanup failure nor restart clears them.
      await this.db.transaction(async tx => {
        const [current] = await tx.select().from(aliyunConnections).where(eq(aliyunConnections.id, id)).for('update');
        if (!current) throw new NotFoundException('接入不存在');
        const [remaining] = await tx.select({ id: aliyunGrants.id }).from(aliyunGrants)
          .innerJoin(aliyunPermissions, eq(aliyunPermissions.id, aliyunGrants.permissionId))
          .where(and(eq(aliyunPermissions.connectionId, id), ne(aliyunGrants.state, 'revoked'))).limit(1);
        if (remaining) throw new ConflictException('请先撤销此接入下全部授权（含待执行、失败和撤销中），再删除接入');
        guard();
        await tx.update(aliyunConnections).set({ cleanupState: 'pending', cleanupStage: current.cleanupStage ?? 'verify', cleanupError: null,
          cleanupActorId: actor.id, cleanupRetryAt: new Date(), updatedAt: new Date() }).where(eq(aliyunConnections.id, id));
        for (const identity of await tx.select().from(cloudIdentities).where(eq(cloudIdentities.accountId, c.accountId)))
          if (!(await this.usage.isUsedByOss(identity))) await tx.update(cloudIdentities).set({ cleanupPending: true }).where(eq(cloudIdentities.id, identity.id));
        await this.audit.record({ actorId: actor.id, actorTokenId: actor.tokenId, action: 'aliyun.connection.delete.start', targetType: 'aliyun_connection', targetId: id }, tx);
      });
      return this.executeCleanup(id, guard);
    });
  }
  private async executeCleanup(id: string, guard: () => void): Promise<AliyunDeleteResult> {
    const c = await this.aliyun.connection(id), credentials = this.aliyun.credentials(c);
    guard();
    await this.db.update(aliyunConnections).set({ cleanupAttempts: c.cleanupAttempts + 1 }).where(eq(aliyunConnections.id, id));
    const stage = async (cleanupStage: NonNullable<Connection['cleanupStage']>) => {
      guard(); await this.db.update(aliyunConnections).set({ cleanupState: 'running', cleanupStage, updatedAt: new Date() }).where(eq(aliyunConnections.id, id));
    };
    try {
      await stage('verify');
      const candidates = await this.db.select().from(cloudIdentities).where(eq(cloudIdentities.accountId, c.accountId)).orderBy(asc(cloudIdentities.id));
      const targets: CloudIdentity[] = [], retained: CloudIdentity[] = [];
      for (const identity of candidates) {
        guard();
        const usedByOss = await this.usage.isUsedByOss(identity);
        if (usedByOss && identity.cleanupPending) throw new ConflictException('正在清理的身份新增了 OSS 引用，请先核对修复引用后重试，避免恢复已删除的 Key');
        (usedByOss ? retained : targets).push(identity);
        await this.identities.run(c.accountId, identity.userId, credentials, async session => {
          const actual = await session.inspect();
          guard(); session.guard();
          if (actual.cloudUser && (!identity.cloudUserId || identity.cloudUserId !== actual.cloudUser.id))
            throw new ConflictException('个人身份缺少已核实的云端 UserId，请管理员恢复来源记录后重试');
          if (!usedByOss && actual.policies.some(p => p.type !== 'Custom' || !p.name.startsWith('eat-perm-')))
            throw new ConflictException('个人身份仍有非 EAT 权限点的策略绑定，请管理员在 RAM 控制台确认并处理后重试；EAT 不会解绑无关策略');
        }, guard);
      }
      // Verify every target before the first external mutation, then verify again under each
      // identity lock so replacement users and concurrent manual bindings cannot be adopted.
      for (const identity of retained) {
        await this.identities.run(c.accountId, identity.userId, credentials, async session => {
          if (!(await this.usage.isUsedByOss(identity))) throw new ConflictException('OSS 引用发生变化，请重新检查后重试清理');
          const actual = await session.inspect();
          await stage('bindings');
          const policies = actual.policies.filter(p => p.type === 'Custom' && p.name.startsWith('eat-perm-'));
          for (const policy of policies) await session.repairPolicy(policy.name, false);
          session.guard();
          await this.audit.record({ actorId: c.cleanupActorId, action: 'aliyun.connection.identity.retain', targetType: 'cloud_identity', targetId: identity.id,
            meta: { connectionId: c.id, accountId: c.accountId, retainedFor: 'oss', detachedPolicies: policies.map(p => p.name) } });
        }, guard);
      }
      for (const identity of targets) {
        await this.identities.run(c.accountId, identity.userId, credentials, async session => {
          guard();
          if (await this.usage.isUsedByOss(identity)) throw new ConflictException('OSS 引用发生变化，请重新检查后重试清理');
          await session.cleanup(async value => { session.guard(); await stage(value); });
          guard(); session.guard();
          await this.db.transaction(async tx => {
            await tx.update(aliyunGrants).set({ identityId: null }).where(eq(aliyunGrants.identityId, identity.id));
            await tx.delete(cloudIdentities).where(eq(cloudIdentities.id, identity.id));
          });
        }, guard);
      }
      await stage('local');
      guard();
      await this.db.transaction(async tx => {
        const permissions = await tx.select({ id: aliyunPermissions.id }).from(aliyunPermissions).where(eq(aliyunPermissions.connectionId, id));
        if (permissions.length) await tx.delete(aliyunGrants).where(inArray(aliyunGrants.permissionId, permissions.map(p => p.id)));
        await tx.delete(aliyunConnections).where(eq(aliyunConnections.id, id));
        await this.audit.record({ actorId: c.cleanupActorId, action: 'aliyun.connection.delete', targetType: 'aliyun_connection', targetId: id, meta: { accountId: c.accountId } }, tx);
      });
      return { ok: true };
    } catch (e) {
      guard();
      const cleanupError = this.error(e);
      const [failed] = await this.db.update(aliyunConnections).set({ cleanupState: 'failed', cleanupError,
        cleanupRetryAt: new Date(Date.now() + Math.min(300_000, 30_000 * 2 ** Math.min(c.cleanupAttempts, 4))), updatedAt: new Date() }).where(eq(aliyunConnections.id, id)).returning();
      await this.audit.record({ actorId: c.cleanupActorId, action: 'aliyun.connection.delete.failed', targetType: 'aliyun_connection', targetId: id,
        meta: { stage: failed.cleanupStage, error: cleanupError } });
      return { ok: false, cleanupState: 'failed', cleanupStage: failed.cleanupStage, cleanupError };
    }
  }
  async tick() {
    const rows = await this.db.select().from(aliyunConnections).where(and(isNotNull(aliyunConnections.cleanupState),
      or(eq(aliyunConnections.cleanupState, 'running'), eq(aliyunConnections.cleanupState, 'pending'), lte(aliyunConnections.cleanupRetryAt, new Date()))));
    for (const row of rows) {
      if (this.stopped) return;
      await this.locked(row.id, async guard => {
        const [current] = await this.db.select().from(aliyunConnections).where(eq(aliyunConnections.id, row.id));
        if (current?.cleanupState && (current.cleanupState !== 'failed' || !current.cleanupRetryAt || current.cleanupRetryAt <= new Date()))
          await this.executeCleanup(current.id, guard);
      });
    }
  }
}
