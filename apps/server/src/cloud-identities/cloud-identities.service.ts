import { ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { Pool } from 'pg';
import { DB, PG_POOL, type Db } from '../db/db.module';
import { cloudIdentities, users } from '../db/schema';
import { loadConfig } from '../config';
import { encryptSecret, decryptSecret } from '../common/crypto';
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
export interface ManagedCloudKey {
  identityId: string;
  accessKeyId: string;
  accessKeySecret: string;
  generation: number;
  readyAt: string;
}
export interface IdentityKeyOptions {
  reset?: boolean;
  /** Recovery retries a previously requested rotation; ordinary reads preserve an existing Key. */
  resume?: boolean;
  /** False permits reading/retiring keys, but never creates one (paused connections/recovery). */
  allowCreate?: boolean;
}
export interface IdentitySession {
  /** Guard every local commit after external I/O. Invalid once the lock session closes. */
  guard(): void;
  key(options?: IdentityKeyOptions): Promise<ManagedCloudKey | undefined>;
  ensure(): Promise<CloudIdentity>;
  setPolicy(policyName: string, attached: boolean): Promise<CloudIdentity | undefined>;
  inspect(): Promise<{ identity?: CloudIdentity; policies: RamPolicy[] }>;
}

/** One cloud identity per account/user. OSS supplies its own credentials to this same module. */
@Injectable()
export class CloudIdentitiesService {
  private readonly logger = new Logger(CloudIdentitiesService.name);
  private readonly lockPool: Pool;
  /** Propagation delay is persisted per key; changing this does not shorten an existing wait. */
  keyPropagationMs = loadConfig().cloudKeyPropagationMs;
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
        key: async (options = {}) => {
          const identity = options.allowCreate === false ? await row() : await ensure();
          if (!identity) return;
          await inspect(); // Never mutate keys on a foreign/replaced cloud user.
          return this.key(identity, credentials, guard, options);
        },
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

  private async key(initial: CloudIdentity, credentials: RamCredentials, guard: () => void, options: IdentityKeyOptions): Promise<ManagedCloudKey | undefined> {
    let identity = initial;
    const call = async <T>(fn: () => Promise<T>) => { guard(); const value = await fn(); guard(); return value; };
    const save = async (patch: Partial<CloudIdentity>) => {
      guard();
      [identity] = await this.db.update(cloudIdentities).set({ ...patch, updatedAt: new Date() }).where(eq(cloudIdentities.id, identity.id)).returning();
    };
    const remove = async (id: string) => {
      try { await call(() => this.ram.keyStatus(credentials, identity.ramName, id, false)); }
      catch (e) { if (!ramMissing(e)) throw e; }
      await call(() => this.ram.deleteKey(credentials, identity.ramName, id));
    };
    const retireReady = async () => {
      if (identity.keyReadyAt && identity.keyReadyAt.getTime() <= Date.now()) {
        for (const id of identity.retiringKeyIds) {
          try { await remove(id); }
          catch {
            guard();
            this.logger.warn(`旧个人 Key 待回收（${identity.id}）`);
            break; // A retired key cleanup outage must not hide the durably saved personal credential.
          }
          await save({ retiringKeyIds: identity.retiringKeyIds.filter(k => k !== id) });
        }
        if (!identity.retiringKeyIds.length && identity.keyTargetGeneration !== null && identity.keyGeneration >= identity.keyTargetGeneration)
          await save({ keyTargetGeneration: null });
      }
    };
    // A failed create may have succeeded in RAM. Its secret cannot be recovered: retire only keys
    // absent from the durable pre-create baseline. Existing managed/manual keys remain untouched.
    if (identity.keyBaseline !== null) {
      const baseline = identity.keyBaseline;
      for (const k of await call(() => this.ram.keys(credentials, identity.ramName)))
        if (!baseline.includes(k.id)) await remove(k.id);
      await save({ keyBaseline: null });
    }
    await retireReady();
    if (options.reset && identity.keyTargetGeneration === null)
      await save({ keyTargetGeneration: identity.keyGeneration + 1 });
    const needsKey = !identity.keyIdEncrypted || (identity.keyTargetGeneration !== null && identity.keyGeneration < identity.keyTargetGeneration);
    if (needsKey && options.allowCreate !== false && (!identity.keyIdEncrypted || options.reset || options.resume)) {
      const baseline = (await call(() => this.ram.keys(credentials, identity.ramName))).map(k => k.id);
      if (baseline.length >= 2) throw new ConflictException('RAM 用户 Key 配额已满，请管理员处理非 EAT 管理的 Key；原有 EAT Key 保持可用');
      await save({ keyBaseline: baseline, keyTargetGeneration: identity.keyTargetGeneration ?? identity.keyGeneration + 1 });
      const key = await call(() => this.ram.createKey(credentials, identity.ramName));
      const oldId = identity.keyIdEncrypted ? decryptSecret(identity.keyIdEncrypted) : undefined;
      // Both secret and propagation deadline commit before any previous key is disabled/deleted.
      await save({ keyIdEncrypted: encryptSecret(key.id), keySecretEncrypted: encryptSecret(key.secret),
        keyBaseline: null, keyGeneration: identity.keyGeneration + 1,
        keyReadyAt: new Date(Date.now() + this.keyPropagationMs),
        retiringKeyIds: [...new Set([...identity.retiringKeyIds, ...(oldId ? [oldId] : [])])],
      });
    }
    await retireReady();
    if (!identity.keyIdEncrypted || !identity.keySecretEncrypted) return;
    return { identityId: identity.id, accessKeyId: decryptSecret(identity.keyIdEncrypted), accessKeySecret: decryptSecret(identity.keySecretEncrypted),
      generation: identity.keyGeneration, readyAt: (identity.keyReadyAt ?? new Date(0)).toISOString() };
  }
}
