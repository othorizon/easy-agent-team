import { ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import { asc, eq, ne } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { AuthUser } from '../auth/auth.decorators';
import type { ExecuteOssMigration, OssMigrationStatus } from '@eat/shared';
import { AuditService } from '../audit/audit.service';
import { CloudIdentitiesService, cloudIdentityComments, cloudIdentityMarker } from '../cloud-identities/cloud-identities.service';
import { cloudIdentities, ossMigrationResults, ossOperations, ossSettings, users } from '../db/schema';
import { RamCloud } from '../ram/ram-cloud';
import { OssMigrationPreviewService } from './oss-migration-preview.service';
import { OssStore } from './oss-store';
import { ossError, ossMarker } from './oss-provisioner';

type Journal = typeof ossMigrationResults.$inferSelect;
@Injectable()
export class OssMigrationService {
  constructor(private readonly store: OssStore, private readonly preview: OssMigrationPreviewService,
    private readonly identities: CloudIdentitiesService, private readonly ram: RamCloud, private readonly audit: AuditService) {}
  async status(): Promise<OssMigrationStatus> {
    const setting = await this.store.row();
    const results = await this.store.db.select({ result: ossMigrationResults, name: users.name, email: users.email }).from(ossMigrationResults)
      .innerJoin(users, eq(users.id, ossMigrationResults.userId)).orderBy(asc(ossMigrationResults.userId));
    return { state: setting.migrationState, results: results.map(({ result, name, email }) => ({ ...result, name, email, updatedAt: result.updatedAt.toISOString() })) };
  }
  async execute(actor: AuthUser, input: ExecuteOssMigration) {
    if (actor.role !== 'admin') throw new ForbiddenException('仅管理员可迁移 OSS 个人身份');
    if (input.confirm !== true) throw new ConflictException('请明确确认迁移');
    // Lock ordering is always OSS -> cloud-identity:account:user. No cloud call is inside a platform transaction.
    return this.store.exclusive(async globalGuard => {
      const initial = await this.store.row();
      if (initial.migrationState === 'complete') return this.status();
      const report = await this.preview.preview();
      globalGuard();
      const pending = await this.store.db.select({ id: ossOperations.id }).from(ossOperations).where(ne(ossOperations.state, 'complete')).limit(1);
      // The global session lock drains an old in-flight worker first. Unfinished legacy journals must
      // finish before rename: they may otherwise create another legacy user after a restart.
      if (pending.length || report.conflicts.length) throw new ConflictException('请先恢复完成 OSS 启用检查及所有在途操作，再执行迁移');
      if (!report.accountId) throw new ConflictException('请先验证 OSS 云账号');
      await this.store.db.update(ossSettings).set({ migrationState: 'running' }).where(eq(ossSettings.id, 1));
      await this.audit.record({ actorId: actor.id, action: 'oss_migration.started', targetType: 'oss_setting', targetId: '1' });
      for (const item of report.identities) {
        globalGuard();
        const [existing] = await this.store.db.select().from(ossMigrationResults).where(eq(ossMigrationResults.userId, item.userId));
        if (existing?.state === 'complete') continue;
        await this.identities.run(report.accountId, item.userId, this.store.connection(initial), async session => {
          const guard = () => { globalGuard(); session.guard(); };
          let journal = existing;
          if (!journal) {
            [journal] = await this.store.db.insert(ossMigrationResults).values({
              userId: item.userId, accountId: report.accountId!, identityId: item.identityId ?? randomUUID(),
              oldRamName: item.oldRamName, targetRamName: item.targetRamName,
            }).returning();
          }
          const save = async (patch: Partial<Journal>) => {
            guard();
            await this.store.db.transaction(async tx => {
              [journal] = await tx.update(ossMigrationResults).set({ ...patch, updatedAt: new Date() }).where(eq(ossMigrationResults.userId, item.userId)).returning();
              await this.audit.record({ actorId: actor.id, action: 'oss_migration.step', targetType: 'oss_account', targetId: item.userId,
                meta: { stage: journal.stage, state: journal.state, oldRamName: journal.oldRamName, targetRamName: journal.targetRamName,
                  cloudUserId: journal.cloudUserId, identityId: journal.identityId, error: journal.error } }, tx);
            });
          };
          const call = async <T>(work: () => Promise<T>) => { guard(); const value = await work(); guard(); return value; };
          try {
            await save({ state: 'running', error: null, attempts: journal.attempts + 1 });
            // The client plan is never trusted; re-read the cloud after BOTH locks are held.
            const fresh = (await this.preview.preview(item.userId)).identities.find(r => r.userId === item.userId)!;
            guard();
            if (fresh.conflicts.length) throw new ConflictException(fresh.conflicts.map(c => c.message).join('；'));
            if (!fresh.cloudUserId || (journal.cloudUserId && fresh.cloudUserId !== journal.cloudUserId))
              throw new ConflictException('RAM 云端 UserId 与迁移记录不符，拒绝接管');
            if (!journal.cloudUserId) await save({ cloudUserId: fresh.cloudUserId, stage: 'verified' });
            const credentials = this.store.connection(initial);
            const [user] = await this.store.db.select().from(users).where(eq(users.id, item.userId));
            let name = fresh.cloudRamName!;
            if (user.status === 'disabled') {
              // Legacy Deny may be the only barrier for a manual Active Key. Cut ALL authentication
              // paths before replacing Deny; failure leaves this person's policy untouched.
              for (const key of await call(() => this.ram.keys(credentials, name)))
                await call(() => this.ram.keyStatus(credentials, name, key.id, false));
              await call(() => this.ram.deleteLoginProfile(credentials, name));
              await save({ stage: 'secured' });
            }
            const cloud = await call(() => this.ram.getUser(credentials, name));
            if (cloud.id !== journal.cloudUserId) throw new ConflictException('RAM 用户在迁移中被替换，拒绝接管');
            if (name !== journal.targetRamName || !cloud.comments.startsWith(cloudIdentityMarker(journal.identityId))) {
              await call(() => this.ram.updateUser(credentials, name, { name: journal.targetRamName,
                comments: cloudIdentityComments(journal.identityId, user.email), displayName: user.name }));
            }
            name = journal.targetRamName;
            await save({ stage: 'renamed' });
            const account = (await this.store.account(item.userId))!;
            const [identity] = await this.store.db.select().from(cloudIdentities).where(eq(cloudIdentities.id, journal.identityId));
            if (!identity) {
              guard();
              await this.store.db.insert(cloudIdentities).values({ id: journal.identityId, accountId: journal.accountId, userId: item.userId,
                cloudUserId: journal.cloudUserId, ramName: name,
                keyIdEncrypted: account.keyIdEncrypted, keySecretEncrypted: account.keySecretEncrypted,
                keyBaseline: account.keyBaseline, retiringKeyIds: account.retiringKeyIds, keyGeneration: account.keyGeneration,
                keyReadyAt: account.keyReadyAt, userEnabled: user.status === 'active' && account.userEnabled,
                syncPending: user.status === 'active' && account.syncPending, lastError: account.lastError });
            } else if (identity.userId !== item.userId || identity.accountId !== journal.accountId || identity.cloudUserId !== journal.cloudUserId)
              throw new ConflictException('统一个人身份记录不符，拒绝覆盖');
            await save({ stage: 'identity' });
            guard();
            await this.store.updateAccount(item.userId, { identityId: journal.identityId, ramName: name });
            await save({ stage: 'linked' });
            // Recheck current status under the identity lock before relaxing the old Deny.
            const [currentUser] = await this.store.db.select().from(users).where(eq(users.id, item.userId));
            if (currentUser.status === 'disabled') await session.syncUserStatus();
            guard();
            if (fresh.aggregation.proposedPolicyDocument) {
              await call(() => this.ram.applyUserPolicy(credentials, name, account.policyName, ossMarker(initial.instanceId, item.userId), JSON.parse(fresh.aggregation.proposedPolicyDocument!), guard));
            } else if (fresh.aggregation.currentAttached) await call(() => this.ram.detachPolicy(credentials, name, account.policyName));
            await save({ stage: 'policy' });
            await save({ stage: 'complete', state: 'complete', error: null });
          } catch (e) {
            guard(); // A lost session must leave the previous stage intact for its replacement.
            await save({ state: 'failed', error: ossError(e) });
          }
        }, globalGuard);
      }
      globalGuard();
      const results = await this.store.db.select().from(ossMigrationResults);
      const state = results.every(r => r.state === 'complete') ? 'complete' : 'partial';
      await this.store.db.update(ossSettings).set({ migrationState: state }).where(eq(ossSettings.id, 1));
      await this.audit.record({ actorId: actor.id, action: 'oss_migration.finished', targetType: 'oss_setting', targetId: '1', meta: { state } });
      return this.status();
    }, true);
  }
}
