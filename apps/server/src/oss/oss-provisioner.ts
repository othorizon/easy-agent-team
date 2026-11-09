import { CloudIdentitiesService, cloudIdentityMarker } from '../cloud-identities/cloud-identities.service';
import type { OssCheck } from '@eat/shared';
import { ConflictException, Injectable } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import {
  aliyunConnections,
  cloudIdentities,
  ossAccounts,
  ossMigrationResults,
  ossOperations,
  ossSettings,
  ossSpaces,
  users,
} from '../db/schema';
import { decryptSecret, encryptSecret } from '../common/crypto';
import { OssCloud, OssCloudError, type OssConnection } from './oss-cloud';
import {
  OssStore,
  type OssAccountRow,
  type OssOperationRow,
} from './oss-store';
import { userPolicy } from './oss-policy';
import { RamCloud, RamCloudError, ramMissing } from '../ram/ram-cloud';

export const ossMarker = (instance: string, owner: string) =>
  `EAT OSS ${instance} ${owner}`;
export const ossRamName = (instance: string, owner: string) =>
  `eat-oss-${instance.replaceAll('-', '').slice(0, 12)}-${owner.replaceAll('-', '')}`;
export function ossError(e: unknown): string {
  if (
    e instanceof OssCloudError ||
    e instanceof RamCloudError ||
    e instanceof ConflictException
  )
    return e.message;
  // Policy/ownership errors are locally authored; never forward arbitrary SDK or DB messages.
  if (
    e instanceof Error &&
    /^(RAM 策略容量不足|Bucket Policy 容量不足|EAT 管理的 Bucket Policy|RAM 用户归属|RAM 策略归属|测试用户归属|测试策略归属)/.test(
      e.message,
    )
  )
    return e.message;
  return 'OSS 操作未完成，请检查权限或重试；详细凭证不会进入错误信息';
}

@Injectable()
export class OssProvisioner {
  constructor(
    private readonly store: OssStore,
    private readonly cloud: OssCloud,
    private readonly ram: RamCloud,
    private readonly identities: CloudIdentitiesService,
  ) {}
  async syncUser(
    userId: string,
    guard: () => void,
    create = true,
  ): Promise<OssAccountRow | undefined> {
    const r = await this.store.row(),
      c = this.store.connection(r);
    let account = await this.store.account(userId);
    if (!account && !create) return;
    if (account?.identityId || r.migrationState === 'complete') {
      if (!r.accountId) throw new ConflictException('OSS 云账号尚未验证');
      return this.identities.run(r.accountId, userId, c, async session => {
        const safe = () => { guard(); session.guard(); };
        const [user] = await this.store.db.select().from(users).where(eq(users.id, userId));
        const identity = account?.identityId ? (await session.inspect()).identity : await session.ensure();
        if (!identity || account?.identityId && identity.id !== account.identityId) throw new ConflictException('OSS 个人身份引用不符');
        safe();
        if (!account) {
          [account] = await this.store.db.transaction(async tx => {
            // Publish OSS usage against the same account barrier as Aliyun deletion. The identity
            // session prevents cleanup work from running while we establish this reference.
            const [connection] = await tx.select().from(aliyunConnections).where(eq(aliyunConnections.accountId, r.accountId!)).for('update');
            const [current] = await tx.select().from(cloudIdentities).where(eq(cloudIdentities.id, identity.id));
            if (!current || connection?.cleanupState || current.cleanupPending) throw new ConflictException('此云账号的个人身份正在清理，请完成接入清理后重试空间开通');
            safe();
            return tx.insert(ossAccounts).values({ userId, identityId: identity.id,
              ramName: identity.ramName, policyName: ossRamName(r.instanceId, userId) }).returning();
          });
        }
        const spaces = await this.store.db.select().from(ossSpaces).where(and(eq(ossSpaces.ownerId, userId), inArray(ossSpaces.status, ['active', 'provisioning', 'failed'])));
        // Disabled users may retain valid spaces: only credentials are disabled, policies stay Allow.
        if (user.status === 'disabled') await session.syncUserStatus();
        safe();
        if (spaces.length) await this.ram.applyUserPolicy(c, identity.ramName, account!.policyName,
          ossMarker(r.instanceId, userId), userPolicy(r.bucket, spaces.map(space => space.prefix)), safe);
        else await session.setPolicy(account!.policyName, false);
        safe();
        return account;
      }, guard);
    }
    const [u] = await this.store.db
      .select()
      .from(users)
      .where(eq(users.id, userId));
    if (!u) throw new ConflictException('空间所有者不存在');
    if (!account) {
      const name = ossRamName(r.instanceId, userId);
      [account] = await this.store.db
        .insert(ossAccounts)
        .values({ userId, ramName: name, policyName: name })
        .returning();
    }
    guard();
    await this.ram.ensureUser(
      c,
      account.ramName,
      ossMarker(r.instanceId, userId),
      guard,
    );
    const spaces = await this.store.db
      .select()
      .from(ossSpaces)
      .where(
        and(
          eq(ossSpaces.ownerId, userId),
          inArray(ossSpaces.status, ['active', 'provisioning', 'failed']),
        ),
      );
    guard();
    await this.ram.applyUserPolicy(
      c,
      account.ramName,
      account.policyName,
      ossMarker(r.instanceId, userId),
      userPolicy(
        r.bucket,
        u.status === 'active' ? spaces.map((s) => s.prefix) : [],
      ),
      guard,
    );
    return account;
  }
  async ensureKey(userId: string, guard: () => void, generation?: number, allowCreate = true) {
    const setting = await this.store.row();
    const c = this.store.connection(setting);
    const account = await this.store.account(userId);
    if (account?.identityId) {
      if (!setting.accountId) throw new ConflictException('OSS 云账号尚未验证');
      return this.identities.run(setting.accountId, userId, c, async session => {
        const [identity] = await this.store.db.select().from(cloudIdentities).where(eq(cloudIdentities.id, account.identityId!));
        const safe = () => { guard(); session.guard(); };
        const key = await session.key({ reset: generation !== undefined && generation === identity.keyGeneration, resume: true, allowCreate });
        safe();
        if (!key) throw new ConflictException('个人凭证尚未就绪');
        const wait = new Date(key.readyAt).getTime() - Date.now();
        if (wait > 0) { await delay(wait); safe(); }
        await session.key({ resume: true, allowCreate });
        await session.syncUserStatus();
        safe();
        await this.store.updateAccount(userId, { syncPending: false, lastError: null });
      }, guard);
    }
    let a = await this.store.account(userId);
    if (!a) throw new ConflictException('RAM 账号尚未创建');
    if (a.keyBaseline !== null) {
      for (const k of await this.ram.keys(c, a.ramName))
        if (!a.keyBaseline.includes(k.id)) {
          guard();
          await this.ram.deleteKey(c, a.ramName, k.id);
        }
      a = await this.store.updateAccount(userId, { keyBaseline: null });
    }
    const reset = generation !== undefined && a.keyGeneration === generation;
    if (!a.keyIdEncrypted || reset) {
      const baseline = (await this.ram.keys(c, a.ramName)).map((k) => k.id);
      if (baseline.length >= 2)
        throw new ConflictException(
          'RAM 用户密钥配额已满，请先处理非 EAT 管理的密钥',
        );
      await this.store.updateAccount(userId, { keyBaseline: baseline });
      guard();
      const key = await this.ram.createKey(c, a.ramName);
      const retiring = a.keyIdEncrypted
        ? [...a.retiringKeyIds, decryptSecret(a.keyIdEncrypted)]
        : a.retiringKeyIds;
      a = await this.store.updateAccount(userId, {
        keyIdEncrypted: encryptSecret(key.id),
        keySecretEncrypted: encryptSecret(key.secret),
        keyBaseline: null,
        retiringKeyIds: retiring,
        keyGeneration: a.keyGeneration + 1,
        keyReadyAt: new Date(Date.now() + this.identities.keyPropagationMs),
      });
      await this.cloud.waitForNewKey();
    }
    for (const id of a.retiringKeyIds) {
      guard();
      try {
        await this.ram.keyStatus(c, a.ramName, id, false);
      } catch (e) {
        if (!ramMissing(e)) throw e;
      }
      await this.ram.deleteKey(c, a.ramName, id);
      a = await this.store.updateAccount(userId, {
        retiringKeyIds: a.retiringKeyIds.filter((v) => v !== id),
      });
    }
    await this.syncUserStatus(userId, guard);
  }
  async syncUserStatus(userId: string, guard: () => void) {
    const a = await this.store.account(userId);
    if (!a) return;
    if (a.identityId) {
      const setting = await this.store.row();
      if (!setting.accountId) throw new ConflictException('OSS 云账号尚未验证');
      await this.identities.run(setting.accountId, userId, this.store.connection(setting), async session => {
        await session.syncUserStatus(); guard(); session.guard();
        const [identity] = await this.store.db.select().from(cloudIdentities).where(eq(cloudIdentities.id, a.identityId!));
        await this.store.updateAccount(userId, { userEnabled: identity.userEnabled, syncPending: identity.syncPending, lastError: identity.lastError });
      }, guard);
      return;
    }
    const [u] = await this.store.db
      .select()
      .from(users)
      .where(eq(users.id, userId));
    const enabled = u?.status === 'active';
    const c = this.store.connection(await this.store.row());
    if (a.keyIdEncrypted) {
      guard();
      await this.ram.keyStatus(
        c,
        a.ramName,
        decryptSecret(a.keyIdEncrypted),
        enabled,
      );
    }
    if (!enabled) {
      // A response-lost key creation may have produced a key not yet stored locally.
      for (const key of await this.ram.keys(c, a.ramName)) {
        guard();
        await this.ram.keyStatus(c, a.ramName, key.id, false);
      }
    }
    // Also revoke the path policy while disabled; OSS may still cache an otherwise valid V4 key.
    await this.syncUser(userId, guard, false);
    // The join in the worker also checks the current user status, covering changes during cloud I/O.
    await this.store.updateAccount(userId, {
      userEnabled: enabled,
      syncPending: false,
      lastError: null,
    });
  }
  /** Migration freezes ordinary work, but disabling a person must still cut authentication.
   * Never ensure users or rewrite policies here: the source may already have been renamed. */
  async secureDuringMigration(userId: string, guard: () => void) {
    const setting = await this.store.row(), account = await this.store.account(userId);
    if (!account || !setting.accountId) return;
    await this.identities.run(setting.accountId, userId, this.store.connection(setting), async session => {
      const safe = () => { guard(); session.guard(); };
      const [user] = await this.store.db.select().from(users).where(eq(users.id, userId));
      if (user.status !== 'disabled') return; // Restores wait for ordinary migration recovery.
      if (account.identityId) await session.syncUserStatus();
      else {
        const [journal] = await this.store.db.select().from(ossMigrationResults).where(eq(ossMigrationResults.userId, userId));
        const c = this.store.connection(setting);
        let cloud;
        for (const name of new Set([account.ramName, journal?.targetRamName].filter((n): n is string => !!n))) {
          safe();
          try { cloud = await this.ram.getUser(c, name); break; }
          catch (e) { if (!ramMissing(e)) throw e; }
        }
        safe();
        if (!cloud || journal?.cloudUserId && journal.cloudUserId !== cloud.id ||
          cloud.comments !== ossMarker(setting.instanceId, userId) && !(journal && cloud.comments.startsWith(cloudIdentityMarker(journal.identityId))))
          throw new ConflictException('迁移中的 RAM 用户归属不符，安全同步需管理员处理');
        for (const key of await this.ram.keys(c, cloud.name)) { safe(); await this.ram.keyStatus(c, cloud.name, key.id, false); }
        safe(); await this.ram.deleteLoginProfile(c, cloud.name);
      }
      safe(); await this.store.updateAccount(userId, { userEnabled: false, syncPending: false, lastError: null });
    }, guard);
  }
  private async eventually(work: () => Promise<void>) {
    for (let n = 0; ; n++) {
      try {
        return await work();
      } catch (e) {
        if (n >= 59) throw e;
        await delay(2000);
      }
    }
  }
  private async deny(work: () => Promise<unknown>) {
    try {
      await work();
    } catch (e) {
      if (
        e instanceof OssCloudError &&
        /^(AccessDenied|Forbidden|403|InvalidAccessKeyId|SecurityTokenExpired)/.test(
          e.code,
        )
      )
        return;
      throw e;
    }
    throw new ConflictException(
      '预期的权限拒绝未生效，请检查现有 Bucket Policy 授权',
    );
  }
  /** The probe journal is written before each side effect; all deletes are exact keys or owned RAM resources. */
  async setup(op: OssOperationRow, guard: () => void) {
    let context = {
      ...op.context,
      probeId: op.context.probeId ?? randomUUID(),
    };
    await this.store.updateOperation(op.id, { context });
    const r = await this.store.row(),
      c = this.store.connection(r);
    const probeId = context.probeId!;
    const name = ossRamName(r.instanceId, probeId),
      marker = ossMarker(r.instanceId, probeId);
    const prefix = `eat-storage/${r.instanceId}/_checks/${probeId}/`;
    const own = `${prefix}allowed/`,
      other = `${prefix}denied/`;
    const object = `${own}probe.txt`,
      forbidden = `${other}probe.txt`;
    const check = async (title: string, fn: () => Promise<void>) => {
      guard();
      const current = await this.store.row();
      const checks: OssCheck[] = [
        ...current.checks.filter((v) => v.name !== title),
        { name: title, status: 'running' as const },
      ];
      await this.store.db
        .update(ossSettings)
        .set({ checks })
        .where(eq(ossSettings.id, 1));
      try {
        await fn();
        checks[checks.length - 1] = { name: title, status: 'passed' };
      } catch (e) {
        checks[checks.length - 1] = { name: title, status: 'failed' };
        throw e;
      } finally {
        await this.store.db
          .update(ossSettings)
          .set({ checks })
          .where(eq(ossSettings.id, 1));
      }
    };
    if (!context.cleanup) {
      try {
        await check('Bucket 信息、私有 ACL 与域名', async () => {
          const info = await this.cloud.bucketInfo(c);
          if ((await this.ram.callerAccount(c)) !== info.accountId)
            throw new ConflictException(
              '管理凭证必须属于 Bucket 所属阿里云账号',
            );
          if (info.acl !== 'private')
            throw new ConflictException(
              'Bucket ACL 必须为 private；请在阿里云控制台处理',
            );
          if (info.region !== r.region)
            throw new ConflictException('Bucket 地域与配置不一致');
          if (r.accountId && r.accountId !== info.accountId)
            throw new ConflictException('不允许切换 Bucket 所属阿里云账号');
          await this.store.db
            .update(ossSettings)
            .set({ accountId: info.accountId })
            .where(eq(ossSettings.id, 1));
          const bound = await this.cloud.domains(c);
          if (
            r.customDomainsEnabled &&
            r.domains.some(
              (d) =>
                !bound.some(
                  (b) => b.domain === d.domain && b.status === 'Enabled',
                ),
            )
          )
            throw new ConflictException('所选自定义域名已解绑或停用');
        });
        await check('管理凭证对象读写、列举与删除', async () => {
          context.objectsStarted = true;
          await this.store.updateOperation(op.id, { context });
          await this.cloud.put(c, object, Buffer.from(probeId));
          await this.cloud.put(c, forbidden, Buffer.from(probeId));
          if (
            (await this.cloud.get(c, object)).toString() !== probeId ||
            !(await this.cloud.list(c, own)).includes(object)
          )
            throw new ConflictException('OSS 测试对象校验失败');
          await this.cloud.remove(c, object);
          await this.cloud.put(c, object, Buffer.from(probeId));
        });
        await check('RAM 用户、密钥及策略创建与更新', async () => {
          context.ramStarted = true;
          await this.store.updateOperation(op.id, { context });
          await this.ram.ensureUser(c, name, marker);
          await this.ram.applyUserPolicy(
            c,
            name,
            name,
            marker,
            userPolicy(c.bucket, []),
          );
          await this.ram.applyUserPolicy(
            c,
            name,
            name,
            marker,
            userPolicy(c.bucket, [own]),
          );
          if (!context.keyId) {
            if (context.keyBaseline) {
              for (const key of await this.ram.keys(c, name))
                if (!context.keyBaseline.includes(key.id))
                  await this.ram.deleteKey(c, name, key.id);
            }
            context.keyBaseline = (await this.ram.keys(c, name)).map(
              (k) => k.id,
            );
            await this.store.updateOperation(op.id, { context });
            const key = await this.ram.createKey(c, name);
            context = {
              ...context,
              keyId: key.id,
              keySecretEncrypted: encryptSecret(key.secret),
              keyBaseline: undefined,
            };
            await this.store.updateOperation(op.id, { context });
            await this.cloud.waitForNewKey();
          }
        });
        const user: OssConnection = {
          ...c,
          accessKeyId: context.keyId!,
          accessKeySecret: decryptSecret(context.keySecretEncrypted!),
        };
        await check('用户目录权限、分片与越权拒绝', async () => {
          await this.eventually(async () => {
            await this.cloud.put(user, object, Buffer.from(probeId));
          });
          await this.eventually(async () => {
            await this.cloud.get(user, object);
            await this.cloud.list(user, own);
          });
          await this.eventually(async () => {
            await this.cloud.objectAcl(user, object, 'private');
            await this.cloud.objectAcl(user, object, 'default');
          });
          context.multipartStarted = true;
          await this.store.updateOperation(op.id, { context });
          await this.cloud.cleanMultipartProbe(c, `${own}multipart`);
          await this.eventually(() =>
            this.cloud.multipartProbe(user, `${own}multipart`),
          );
          await this.eventually(async () => {
            await this.cloud.remove(user, object);
            await this.cloud.put(user, object, Buffer.from(probeId));
          });
          await this.deny(() => this.cloud.get(user, forbidden));
          await this.deny(() =>
            this.cloud.put(user, forbidden, Buffer.from('denied')),
          );
          await this.deny(() => this.cloud.list(user, other));
          await this.deny(() => this.cloud.list(user, ''));
        });
        await check('目录公开读开启与关闭', async () => {
          if ((await this.cloud.anonymousStatus(c, object)) !== 403)
            throw new ConflictException(
              '测试目录在公开授权前可匿名访问，请检查已有授权',
            );
          context.publicTouched = true;
          await this.store.updateOperation(op.id, { context });
          await this.store.syncPublic([own], undefined, guard);
          await this.eventually(async () => {
            if ((await this.cloud.anonymousStatus(c, object)) !== 200)
              throw new ConflictException(
                '公开读未生效，请检查账号或 Bucket 的阻止公共访问配置',
              );
          });
          await this.store.syncPublic([], undefined, guard);
          await this.eventually(async () => {
            if ((await this.cloud.anonymousStatus(c, object)) !== 403)
              throw new ConflictException('撤销公开授权后匿名读取未被拒绝');
          });
        });
        await check('RAM 密钥停用与恢复（状态回读）', async () => {
          for (const active of [false, true]) {
            await this.ram.keyStatus(c, name, context.keyId!, active);
            await this.eventually(async () => {
              const key = (await this.ram.keys(c, name)).find(
                (k) => k.id === context.keyId,
              );
              if (key?.status !== (active ? 'Active' : 'Inactive'))
                throw new ConflictException('RAM 密钥状态尚未同步');
            });
          }
          // RAM acceptance and OSS data-plane propagation are separate; do not promise instant invalidation.
        });
      } catch (e) {
        context.probeError = ossError(e);
      }
      context.cleanup = true;
      await this.store.updateOperation(op.id, { context });
    }
    await check('清理本次测试资源', async () => {
      guard();
      if (context.publicTouched) await this.store.syncPublic([], undefined, guard);
      if (context.multipartStarted)
        await this.cloud.cleanMultipartProbe(c, `${own}multipart`);
      if (context.objectsStarted) {
        await this.cloud.cleanProbeObjects(c, prefix, [object, forbidden]);
      }
      if (context.ramStarted)
        await this.ram.deleteProbeUser(c, name, name, marker);
    });
    await this.store.updateOperation(op.id, {
      context: { probeId, cleanup: true, probeError: context.probeError },
    });
    await this.store.db
      .update(ossSettings)
      .set({
        status: context.probeError ? 'failed' : 'enabled',
        lastError: context.probeError ?? null,
      })
      .where(eq(ossSettings.id, 1));
    // Failed checks with successful cleanup are terminal; checking again creates a fresh operation.
  }
}
