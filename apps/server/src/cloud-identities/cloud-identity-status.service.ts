import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, or, sql, isNull, lte } from 'drizzle-orm';
import { DB, type Db } from '../db/db.module';
import { cloudIdentities, users } from '../db/schema';
import { CloudIdentitiesService } from './cloud-identities.service';
import { CloudIdentityCredentialsService } from './cloud-identity-credentials.service';

@Injectable()
export class CloudIdentityStatusService {
  private readonly logger = new Logger(CloudIdentityStatusService.name);
  private timer?: ReturnType<typeof setInterval>;
  private recovery?: Promise<void>;
  private stopped = false;
  constructor(@Inject(DB) private readonly db: Db, private readonly identities: CloudIdentitiesService,
    private readonly credentials: CloudIdentityCredentialsService) {}
  onModuleInit() { this.timer = setInterval(() => this.wake(), 30_000); this.timer.unref(); this.wake(); }
  private wake() {
    if (this.stopped || this.recovery) return;
    this.recovery = this.tick().catch(() => this.logger.warn('个人凭证状态同步待完成'))
      .finally(() => { this.recovery = undefined; });
  }
  async onModuleDestroy() { this.stopped = true; clearInterval(this.timer); await this.recovery; }
  /** Called in the same transaction as users.status, before any external I/O. */
  async markPending(tx: Pick<Db, 'update'>, userId: string) {
    await tx.update(cloudIdentities).set({ syncPending: true, syncAttempts: 0, nextSyncAt: null, lastError: null, updatedAt: new Date() })
      .where(eq(cloudIdentities.userId, userId));
  }
  async summaries() {
    const rows = await this.db.select({ userId: cloudIdentities.userId, pending: cloudIdentities.syncPending,
      error: cloudIdentities.lastError, applied: cloudIdentities.userEnabled, status: users.status }).from(cloudIdentities)
      .innerJoin(users, eq(users.id, cloudIdentities.userId));
    const summaries = new Map<string, { aliyunSyncPending: boolean; aliyunSyncError: string | null }>();
    for (const row of rows) {
      const previous = summaries.get(row.userId);
      summaries.set(row.userId, { aliyunSyncPending: !!previous?.aliyunSyncPending || row.pending || row.applied !== (row.status === 'active'),
        aliyunSyncError: previous?.aliyunSyncError ?? row.error });
    }
    return summaries;
  }
  async onUserStatusChanged(userId: string) {
    // Scan after the transaction and wait for any in-flight key/identity operation on each identity lock.
    for (const row of await this.db.select().from(cloudIdentities).where(eq(cloudIdentities.userId, userId))) await this.sync(row.id, true);
    return (await this.summaries()).get(userId)?.aliyunSyncPending ?? false;
  }
  async tick() {
    const rows = await this.db.select({ id: cloudIdentities.id }).from(cloudIdentities)
      .innerJoin(users, eq(users.id, cloudIdentities.userId))
      .where(and(or(eq(cloudIdentities.cleanupPending, false), eq(users.status, 'disabled')), or(eq(cloudIdentities.syncPending, true), sql`${cloudIdentities.userEnabled} <> (${users.status} = 'active')`),
        or(isNull(cloudIdentities.nextSyncAt), lte(cloudIdentities.nextSyncAt, new Date()))));
    for (const row of rows) { if (this.stopped) return; await this.sync(row.id); }
  }
  private async sync(id: string, force = false) {
    const [identity] = await this.db.select().from(cloudIdentities).where(eq(cloudIdentities.id, id));
    if (!identity) return;
    try {
      const credentials = await this.credentials.forAccount(identity.accountId);
      await this.identities.run(identity.accountId, identity.userId, credentials, async session => {
        // Another process may have completed or backed off while this worker waited for the lock.
        const [current] = await this.db.select({ identity: cloudIdentities, status: users.status }).from(cloudIdentities)
          .innerJoin(users, eq(users.id, cloudIdentities.userId)).where(eq(cloudIdentities.id, id));
        if (!current || (current.identity.cleanupPending && current.status === 'active')) return;
        const complete = !current.identity.syncPending && current.identity.userEnabled === (current.status === 'active');
        const backedOff = current.identity.nextSyncAt && current.identity.nextSyncAt.getTime() > Date.now();
        if (!force && (complete || backedOff)) return;
        try { await session.syncUserStatus(); }
        catch (e) { session.guard(); await this.failed(id, e); }
      });
    } catch (e) { await this.failed(id, e); }
  }
  private async failed(id: string, error: unknown) {
    // Provider errors are sanitized by RamCloud. Never persist arbitrary transport messages/credentials.
    const message = error instanceof Error && ('kind' in error || 'getStatus' in error)
      ? error.message : '个人凭证状态同步失败，请检查云账号管理凭证与权限';
    await this.db.update(cloudIdentities).set({ syncPending: true, lastError: message,
      syncAttempts: sql`${cloudIdentities.syncAttempts} + 1`,
      nextSyncAt: sql`now() + least(300, 30 * power(2, least(${cloudIdentities.syncAttempts}, 4))) * interval '1 second'`,
      updatedAt: new Date() }).where(eq(cloudIdentities.id, id));
  }
}
