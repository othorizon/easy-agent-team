import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { Pool } from 'pg';
import { DB, PG_POOL, type Db } from '../db/db.module';
import { cloudIdentities, users } from '../db/schema';
import { RamCloud, ramMissing, type RamCredentials, type RamPolicy, type RamUser } from '../ram/ram-cloud';

export type CloudIdentity = typeof cloudIdentities.$inferSelect;
export const cloudIdentityMarker = (identityId: string) =>
  `EAT:${Buffer.from(identityId.replaceAll('-', ''), 'hex').toString('base64url')}:`;

/** RAM comments allow 128 characters. The provenance marker is never truncated. */
export function cloudIdentityComments(identityId: string, email: string): string {
  const marker = cloudIdentityMarker(identityId);
  const available = 128 - Array.from(marker).length;
  const characters = Array.from(email);
  return marker + (characters.length > available ? characters.slice(0, available - 1).join('') + '…' : email);
}
export interface IdentitySession {
  /** Guard every local commit after external I/O. Invalid once the lock session closes. */
  guard(): void;
  ensure(): Promise<CloudIdentity>;
  setPolicy(policyName: string, attached: boolean): Promise<CloudIdentity | undefined>;
  inspect(): Promise<{ identity?: CloudIdentity; policies: RamPolicy[] }>;
}

/** One cloud identity per account/user. OSS supplies its own credentials to this same module. */
@Injectable()
export class CloudIdentitiesService {
  private readonly lockPool: Pool;
  constructor(@Inject(DB) private readonly db: Db, @Inject(PG_POOL) pool: Pool, private readonly ram: RamCloud) {
    // Waiters never consume the business pool needed by the lock holder.
    this.lockPool = new Pool({ ...pool.options, max: 4 });
    this.lockPool.on('error', () => undefined);
  }
  async onModuleDestroy() { await this.lockPool.end(); }

  /** The lock namespace must also be used by key lifecycle and OSS migration callers. */
  async run<T>(accountId: string, userId: string, credentials: RamCredentials, work: (session: IdentitySession) => Promise<T>): Promise<T> {
    // PostgreSQL UUIDs are case-insensitive; the advisory-lock key and RAM name must use the same canonical form.
    userId = userId.toLowerCase();
    const c = await this.lockPool.connect();
    const name = `cloud-identity:${accountId}:${userId}`;
    let held = false, lost = false, closed = false;
    const onError = () => { lost = true; };
    const guard = () => {
      if (lost || closed) throw new ConflictException('个人身份操作锁已中断，未完成操作将自动恢复');
    };
    c.on('error', onError);
    try {
      await c.query('select pg_advisory_lock(hashtextextended($1,0))', [name]);
      held = true;
      guard();
      const call = async <R>(fn: () => Promise<R>) => { guard(); const value = await fn(); guard(); return value; };
      const row = async () => (await this.db.select().from(cloudIdentities).where(and(eq(cloudIdentities.accountId, accountId), eq(cloudIdentities.userId, userId))))[0];
      const marker = (identity: CloudIdentity) => cloudIdentityMarker(identity.id);
      const verify = (identity: CloudIdentity, user: RamUser) => {
        if ((identity.cloudUserId && identity.cloudUserId !== user.id) || !user.comments.startsWith(marker(identity)))
          throw new ConflictException('同名 RAM 用户不是 EAT 创建的个人身份，请交管理员处理，拒绝接管');
      };
      const inspect = async () => {
        guard();
        const identity = await row();
        if (!identity) return { policies: [] };
        let user: RamUser;
        try { user = await call(() => this.ram.getUser(credentials, identity.ramName)); }
        catch (e) { if (ramMissing(e)) return { identity, policies: [] }; throw e; }
        verify(identity, user);
        return { identity, policies: await call(() => this.ram.userPolicies(credentials, identity.ramName)) };
      };
      const ensure = async () => {
        guard();
        const [user] = await this.db.select().from(users).where(eq(users.id, userId));
        if (!user) throw new NotFoundException('EAT 用户不存在');
        if (user.status !== 'active') throw new ConflictException('停用的 EAT 用户不能被授予');
        let identity = await row();
        if (!identity) {
          guard();
          [identity] = await this.db.insert(cloudIdentities).values({ accountId, userId, ramName: `eat-${userId.replaceAll('-', '')}` }).returning();
        }
        const comments = cloudIdentityComments(identity.id, user.email);
        let cloud: RamUser;
        try { cloud = await call(() => this.ram.getUser(credentials, identity.ramName)); }
        catch (e) {
          if (!ramMissing(e)) throw e;
          cloud = await call(() => this.ram.createUser(credentials, { name: identity.ramName, displayName: user.name, comments }));
        }
        verify(identity, cloud);
        if (cloud.displayName !== user.name || cloud.comments !== comments)
          cloud = await call(() => this.ram.updateUser(credentials, identity.ramName, { displayName: user.name, comments }));
        guard();
        [identity] = await this.db.update(cloudIdentities).set({ cloudUserId: cloud.id, updatedAt: new Date() }).where(eq(cloudIdentities.id, identity.id)).returning();
        return identity;
      };
      return await work({
        guard, ensure, inspect,
        setPolicy: async (policyName, attached) => {
          const identity = attached ? await ensure() : await row();
          if (!identity) return;
          const actual = await inspect(); // Verify provenance and actual binding before changing exactly this policy.
          const bound = actual.policies.some(p => p.type === 'Custom' && p.name === policyName);
          if (attached && !bound) await call(() => this.ram.attachPolicy(credentials, identity.ramName, policyName));
          if (!attached && bound) await call(() => this.ram.detachPolicy(credentials, identity.ramName, policyName));
          return identity;
        },
      });
    } finally {
      closed = true;
      if (held && !lost) await c.query('select pg_advisory_unlock(hashtextextended($1,0))', [name]).catch(() => { lost = true; });
      c.off('error', onError);
      c.release(lost);
    }
  }
}
