import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { and, asc, eq, notInArray } from 'drizzle-orm';
import type {
  AliyunConnectionInfo,
  AliyunPermissionInfo,
  CreateAliyunConnectionRequest,
  UpdateAliyunConnectionRequest,
} from '@eat/shared';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '../db/schema';
import { DB, PG_POOL, type Db } from '../db/db.module';
import {
  aliyunConnections,
  aliyunPermissions,
  ossSettings,
} from '../db/schema';
import { encryptSecret, decryptSecret } from '../common/crypto';
import { RamCloud, type RamCredentials } from '../ram/ram-cloud';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/auth.decorators';

type Connection = typeof aliyunConnections.$inferSelect;
@Injectable()
export class AliyunService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly ram: RamCloud,
    private readonly audit: AuditService,
  ) {}
  private info(c: Connection): AliyunConnectionInfo {
    return {
      id: c.id,
      name: c.name,
      accountId: c.accountId,
      defaultRegion: c.defaultRegion,
      status: c.status,
      accessKeyIdMasked: '********',
      accessKeySecretMasked: '********',
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
    };
  }
  async availability() {
    return {
      available:
        (
          await this.db
            .select({ id: aliyunConnections.id })
            .from(aliyunConnections)
            .limit(1)
        ).length > 0,
    };
  }
  async listConnections() {
    return (
      await this.db
        .select()
        .from(aliyunConnections)
        .orderBy(asc(aliyunConnections.name))
    ).map((c) => this.info(c));
  }
  async listPermissions(
    connectionId?: string,
    db: Pick<Db, 'select'> = this.db,
  ): Promise<AliyunPermissionInfo[]> {
    return (
      await db
        .select()
        .from(aliyunPermissions)
        .where(
          connectionId
            ? eq(aliyunPermissions.connectionId, connectionId)
            : undefined,
        )
        .orderBy(asc(aliyunPermissions.policyName))
    ).map((p) => ({
      ...p,
      discoveredAt: p.discoveredAt.toISOString(),
      updatedAt: p.updatedAt.toISOString(),
    }));
  }
  async refresh(id: string) {
    const lock = await this.pool.connect();
    const lockName = `aliyun-discovery:${id}`;
    let held = false,
      lost = false;
    const onError = () => {
      lost = true;
    };
    lock.on('error', onError);
    try {
      await lock.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [
        lockName,
      ]);
      held = true;
      // Reuse the lock session for SQL work: queued refreshes cannot exhaust a second pool checkout.
      const db = drizzle(lock, { schema });
      const connection = await this.connection(id, db),
        credentials = this.credentials(connection);
      const found = new Map<string, string>(),
        markers = new Set<string>();
      let marker: string | undefined;
      do {
        // Collect every page before changing local records, so a failed page never marks policies deleted.
        const page = await this.ram.listPolicies(credentials, {
          marker,
          maxItems: 100,
        });
        for (const p of page.policies)
          if (p.type === 'Custom' && p.name.startsWith('eat-perm-'))
            found.set(p.name, p.description);
        marker = page.nextMarker;
        if (marker && markers.has(marker))
          throw new ServiceUnavailableException(
            'RAM 策略分页未前进，请重试刷新',
          );
        if (marker) markers.add(marker);
      } while (marker);
      if (lost) throw new ConflictException('目录刷新锁已中断，请重试');
      const now = new Date();
      await db.transaction(async (tx) => {
        for (const [policyName, description] of found)
          await tx
            .insert(aliyunPermissions)
            .values({
              connectionId: id,
              policyName,
              description,
              discoveredAt: now,
              updatedAt: now,
            })
            .onConflictDoUpdate({
              target: [
                aliyunPermissions.connectionId,
                aliyunPermissions.policyName,
              ],
              set: {
                description,
                cloudExists: true,
                discoveredAt: now,
                updatedAt: now,
              },
            });
        await tx
          .update(aliyunPermissions)
          .set({ cloudExists: false, open: false, updatedAt: now })
          .where(
            and(
              eq(aliyunPermissions.connectionId, id),
              found.size
                ? notInArray(aliyunPermissions.policyName, [...found.keys()])
                : undefined,
            ),
          );
      });
      return await this.listPermissions(id, db);
    } finally {
      if (held && !lost)
        await lock
          .query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [
            lockName,
          ])
          .catch(() => {
            lost = true;
          });
      lock.off('error', onError);
      lock.release(lost);
    }
  }
  async connection(id: string, db: Pick<Db, 'select'> = this.db) {
    const [c] = await db
      .select()
      .from(aliyunConnections)
      .where(eq(aliyunConnections.id, id));
    if (!c) throw new NotFoundException('接入不存在');
    return c;
  }
  credentials(c: Connection): RamCredentials {
    return {
      accessKeyId: decryptSecret(c.accessKeyIdEncrypted),
      accessKeySecret: decryptSecret(c.accessKeySecretEncrypted),
    };
  }
  private async check(c: RamCredentials) {
    const accountId = await this.ram.callerAccount(c);
    // STS identifies the account; the read-only RAM check also rejects keys unable to discover policies.
    await this.ram.listPolicies(c, { maxItems: 1 });
    return accountId;
  }
  private async checkOss(accountId: string) {
    const [oss] = await this.db.select().from(ossSettings).limit(1);
    if (!oss) return;
    // Newly saved OSS settings have no persisted account ID until their first enable check.
    const ossAccountId =
      oss.accountId ??
      (await this.ram.callerAccount({
        accessKeyId: decryptSecret(oss.accessKeyIdEncrypted),
        accessKeySecret: decryptSecret(oss.accessKeySecretEncrypted),
      }));
    if (ossAccountId === accountId)
      throw new ConflictException(
        '请先在 OSS 设置完成 OSS 身份迁移，再接入此云账号',
      );
  }
  private uniqueError(e: unknown): never {
    const cause = e as { code?: string; cause?: { code?: string } };
    if ((cause.code ?? cause.cause?.code) === '23505')
      throw new ConflictException(
        '接入名称或云账号 ID 已存在，同一个云账号只能接入一次',
      );
    throw e;
  }
  async createConnection(user: AuthUser, dto: CreateAliyunConnectionRequest) {
    const accountId = await this.check(dto);
    await this.checkOss(accountId);
    try {
      return await this.db.transaction(async (tx) => {
        const [c] = await tx
          .insert(aliyunConnections)
          .values({
            name: dto.name,
            accountId,
            defaultRegion: dto.defaultRegion,
            accessKeyIdEncrypted: encryptSecret(dto.accessKeyId),
            accessKeySecretEncrypted: encryptSecret(dto.accessKeySecret),
          })
          .returning();
        await this.audit.record(
          {
            actorId: user.id,
            actorTokenId: user.tokenId,
            action: 'aliyun.connection.create',
            targetType: 'aliyun_connection',
            targetId: c.id,
            meta: { name: c.name, accountId },
          },
          tx,
        );
        return this.info(c);
      });
    } catch (e) {
      this.uniqueError(e);
    }
  }
  async updateConnection(
    user: AuthUser,
    id: string,
    dto: UpdateAliyunConnectionRequest,
  ) {
    const old = await this.connection(id);
    const credentials = dto.accessKeyId
      ? (dto as RamCredentials)
      : this.credentials(old);
    const accountId = await this.check(credentials);
    if (old.accountId !== accountId)
      throw new ConflictException('管理凭证属于不同云账号，请新建接入');
    await this.checkOss(accountId);
    try {
      return await this.db.transaction(async (tx) => {
        const [c] = await tx
          .update(aliyunConnections)
          .set({
            name: dto.name,
            defaultRegion: dto.defaultRegion,
            accessKeyIdEncrypted: encryptSecret(credentials.accessKeyId),
            accessKeySecretEncrypted: encryptSecret(
              credentials.accessKeySecret,
            ),
            updatedAt: new Date(),
          })
          .where(eq(aliyunConnections.id, id))
          .returning();
        if (!c) throw new NotFoundException('接入不存在');
        await this.audit.record(
          {
            actorId: user.id,
            actorTokenId: user.tokenId,
            action: 'aliyun.connection.update',
            targetType: 'aliyun_connection',
            targetId: id,
          },
          tx,
        );
        return this.info(c);
      });
    } catch (e) {
      this.uniqueError(e);
    }
  }
  async validateConnection(id: string) {
    const c = await this.connection(id);
    const accountId = await this.check(this.credentials(c));
    if (accountId !== c.accountId)
      throw new ConflictException('管理凭证所属云账号不匹配');
    return { accountId };
  }
  async setConnectionStatus(
    user: AuthUser,
    id: string,
    status: 'enabled' | 'paused',
  ) {
    return this.db.transaction(async (tx) => {
      const [c] = await tx
        .update(aliyunConnections)
        .set({ status, updatedAt: new Date() })
        .where(eq(aliyunConnections.id, id))
        .returning();
      if (!c) throw new NotFoundException('接入不存在');
      await this.audit.record(
        {
          actorId: user.id,
          actorTokenId: user.tokenId,
          action:
            status === 'paused'
              ? 'aliyun.connection.pause'
              : 'aliyun.connection.resume',
          targetType: 'aliyun_connection',
          targetId: id,
        },
        tx,
      );
      return this.info(c);
    });
  }
  async removeConnection(user: AuthUser, id: string) {
    await this.connection(id);
    await this.db.transaction(async (tx) => {
      await tx.delete(aliyunConnections).where(eq(aliyunConnections.id, id));
      await this.audit.record(
        {
          actorId: user.id,
          actorTokenId: user.tokenId,
          action: 'aliyun.connection.delete',
          targetType: 'aliyun_connection',
          targetId: id,
        },
        tx,
      );
    });
    return { ok: true as const };
  }
}
