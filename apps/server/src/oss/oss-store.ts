import {
  ConflictException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { and, eq, ne } from 'drizzle-orm';
import type { Pool } from 'pg';
import type { OssSettingsInfo, UpdateOssSettings } from '@eat/shared';
import { DB, PG_POOL, type Db } from '../db/db.module';
import {
  ossSettings,
  ossSpaces,
  ossAccounts,
  ossOperations,
} from '../db/schema';
import { decryptSecret, encryptSecret } from '../common/crypto';
import { OssCloud, type OssConnection } from './oss-cloud';
import { canonical, mergePublicPolicy, publicStatements } from './oss-policy';

export type OssSettingRow = typeof ossSettings.$inferSelect;
export type OssAccountRow = typeof ossAccounts.$inferSelect;
export type OssSpaceRow = typeof ossSpaces.$inferSelect;
export type OssOperationRow = typeof ossOperations.$inferSelect;
export const maskOssKey = (value: string) =>
  value ? `${value.slice(0, 4)}****${value.slice(-4)}` : '';
const OSS_LOCK = 1950536511;

@Injectable()
export class OssStore {
  constructor(
    @Inject(DB) readonly db: Db,
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly cloud: OssCloud,
  ) {}
  /** Session advisory lock spans cloud work, but never holds a SQL transaction across network I/O. */
  async exclusive<T>(work: (guard: () => void) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    let held = false,
      lost = false;
    const onError = () => {
      lost = true;
    };
    c.on('error', onError);
    try {
      held = (
        await c.query('select pg_try_advisory_lock($1) as held', [OSS_LOCK])
      ).rows[0].held;
      if (!held)
        throw new ConflictException('OSS 正在执行其他操作，请稍后重试');
      return await work(() => {
        if (lost) throw new ConflictException('OSS 操作锁已中断，将重新恢复');
      });
    } finally {
      if (held && !lost)
        await c.query('select pg_advisory_unlock($1)', [OSS_LOCK]).catch(() => {
          lost = true;
        });
      c.off('error', onError);
      c.release(lost);
    }
  }
  async row(): Promise<OssSettingRow> {
    const [r] = await this.db
      .select()
      .from(ossSettings)
      .where(eq(ossSettings.id, 1));
    if (!r)
      throw new ServiceUnavailableException(
        '请管理员先在系统设置配置 OSS 存储',
      );
    return r;
  }
  async enabled() {
    const r = await this.row();
    if (r.status !== 'enabled')
      throw new ServiceUnavailableException('OSS 存储尚未启用');
    return r;
  }
  connection(r: OssSettingRow): OssConnection {
    return {
      bucket: r.bucket,
      region: r.region,
      accessKeyId: decryptSecret(r.accessKeyIdEncrypted),
      accessKeySecret: decryptSecret(r.accessKeySecretEncrypted),
    };
  }
  async info(): Promise<OssSettingsInfo> {
    const [r] = await this.db
      .select()
      .from(ossSettings)
      .where(eq(ossSettings.id, 1));
    return {
      configured: !!r,
      status: r?.status ?? 'disabled',
      bucket: r?.bucket ?? '',
      region: r?.region ?? 'cn-beijing',
      accessKeyIdMasked: r
        ? maskOssKey(decryptSecret(r.accessKeyIdEncrypted))
        : '',
      hasSecret: !!r?.accessKeySecretEncrypted,
      customDomainsEnabled: r?.customDomainsEnabled ?? false,
      domains: r?.domains ?? [],
      locationLocked: !!r?.accountId,
      checks: r?.checks ?? [],
      lastError: r?.lastError ?? null,
    };
  }
  async save(dto: UpdateOssSettings) {
    return this.exclusive(async () => {
      const [r] = await this.db
        .select()
        .from(ossSettings)
        .where(eq(ossSettings.id, 1));
      if (r?.status === 'checking')
        throw new ConflictException('请等待 OSS 启用检查完成');
      if (r?.accountId && (r.bucket !== dto.bucket || r.region !== dto.region))
        throw new ConflictException('已有云资源，不能切换 Bucket 或地域');
      const changed =
        r &&
        (r.bucket !== dto.bucket ||
          r.region !== dto.region ||
          (dto.accessKeyId &&
            dto.accessKeyId !== decryptSecret(r.accessKeyIdEncrypted)) ||
          (dto.accessKeySecret &&
            dto.accessKeySecret !== decryptSecret(r.accessKeySecretEncrypted)));
      if (changed && r.status === 'enabled')
        throw new ConflictException(
          '修改 Bucket、地域或管理凭证前请先停用，再检查并启用',
        );
      if (!r && (!dto.accessKeyId || !dto.accessKeySecret))
        throw new ConflictException('请填写管理 AccessKey ID 和 Secret');
      const values = {
        bucket: dto.bucket,
        region: dto.region,
        customDomainsEnabled: dto.customDomainsEnabled,
        domains: dto.domains,
        accessKeyIdEncrypted: dto.accessKeyId
          ? encryptSecret(dto.accessKeyId)
          : r!.accessKeyIdEncrypted,
        accessKeySecretEncrypted: dto.accessKeySecret
          ? encryptSecret(dto.accessKeySecret)
          : r!.accessKeySecretEncrypted,
        updatedAt: new Date(),
      };
      if (changed && r?.accountId) {
        const info = await this.cloud.bucketInfo(
          this.connection({ ...r, ...values }),
        );
        if (
          info.accountId !== r.accountId ||
          (await this.cloud.callerAccount(
            this.connection({ ...r, ...values }),
          )) !== r.accountId
        )
          throw new ConflictException('不允许切换阿里云账号');
      }
      if (dto.customDomainsEnabled) {
        const available = await this.cloud.domains(
          this.connection({ ...r, ...values } as OssSettingRow),
        );
        if (
          dto.domains.some(
            (d) =>
              !available.some(
                (a) => a.domain === d.domain && a.status === 'Enabled',
              ),
          )
        )
          throw new ConflictException('所选域名必须已绑定并启用于当前 Bucket');
      }
      await this.db.transaction(async (tx) => {
        if (r)
          await tx.update(ossSettings).set(values).where(eq(ossSettings.id, 1));
        else await tx.insert(ossSettings).values(values);
        if (changed) {
          // Finish recovery with the repaired credentials, then require a fresh full permission check.
          const interrupted = await tx
            .select()
            .from(ossOperations)
            .where(
              and(
                eq(ossOperations.kind, 'setup'),
                ne(ossOperations.state, 'complete'),
              ),
            );
          for (const op of interrupted)
            await tx
              .update(ossOperations)
              .set({
                context: {
                  ...op.context,
                  cleanup: true,
                  probeError: '管理凭证已变更；清理完成后请重新检查并启用',
                },
              })
              .where(eq(ossOperations.id, op.id));
        }
      });
      return this.info();
    });
  }
  async domains() {
    return this.cloud.domains(this.connection(await this.row()));
  }
  async account(userId: string) {
    return (
      await this.db
        .select()
        .from(ossAccounts)
        .where(eq(ossAccounts.userId, userId))
    )[0];
  }
  async updateAccount(
    userId: string,
    values: Partial<typeof ossAccounts.$inferInsert>,
  ) {
    await this.db
      .update(ossAccounts)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(ossAccounts.userId, userId));
    return this.account(userId);
  }
  async updateOperation(
    id: string,
    values: Partial<typeof ossOperations.$inferInsert>,
  ) {
    await this.db
      .update(ossOperations)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(ossOperations.id, id));
  }
  /** Must run under exclusive(). The pending rule is journaled before PutBucketPolicy. */
  async syncPublic(extraPrefixes: string[] = [], omitSpace?: string) {
    const r = await this.row(),
      c = this.connection(r);
    const spaces = await this.db
      .select()
      .from(ossSpaces)
      .where(
        and(
          eq(ossSpaces.status, 'active'),
          eq(ossSpaces.requestedPublicRead, true),
        ),
      );
    const next = publicStatements(r.bucket, [
      ...spaces.filter((s) => s.id !== omitSpace).map((s) => s.prefix),
      ...extraPrefixes,
    ]);
    const current = await this.cloud.bucketPolicy(c);
    const merged = mergePublicPolicy(
      current,
      r.managedPolicy,
      r.pendingPolicy,
      next,
    );
    await this.db
      .update(ossSettings)
      .set({ pendingPolicy: next })
      .where(eq(ossSettings.id, 1));
    if (
      canonical(current ?? { Version: '1', Statement: [] }) !==
      canonical(merged)
    )
      await this.cloud.writeBucketPolicy(c, merged);
    const verified = await this.cloud.bucketPolicy(c);
    if (
      canonical(verified ?? { Version: '1', Statement: [] }) !==
      canonical(merged)
    )
      throw new ConflictException(
        'Bucket Policy 回读不一致，请检查外部并发修改后重试',
      );
    await this.db
      .update(ossSettings)
      .set({ managedPolicy: next, pendingPolicy: null })
      .where(eq(ossSettings.id, 1));
  }
}
