import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import { DB, type Db } from '../db/db.module';
import { ossAccounts, ossSettings, ossSpaces } from '../db/schema';
import type { CloudIdentity } from './cloud-identities.service';

/** Exact OSS references own the shared identity lifecycle, including fully reclaimed accounts. */
@Injectable()
export class CloudIdentityUsageService {
  constructor(@Inject(DB) private readonly db: Db) {}
  async isUsedByOss(identity: CloudIdentity): Promise<boolean> {
    const [account] = await this.db.select().from(ossAccounts).where(eq(ossAccounts.userId, identity.userId));
    // A persisted account reference remains a use even when all spaces were reclaimed: never
    // strand OSS's key/status lifecycle. Effective spaces cover an interrupted link migration.
    if (account?.identityId === identity.id) return true;
    const [settings] = await this.db.select().from(ossSettings).where(eq(ossSettings.accountId, identity.accountId));
    if (!settings) return false;
    // Keep the unmigrated legacy path conservative until its exact reference is published.
    if (account && !account.identityId && account.ramName === identity.ramName) return true;
    const [space] = await this.db.select({ id: ossSpaces.id }).from(ossSpaces)
      .where(and(eq(ossSpaces.ownerId, identity.userId), inArray(ossSpaces.status, ['pending', 'provisioning', 'active', 'failed', 'revoking']))).limit(1);
    if (space) throw new ConflictException('此用户仍有有效或执行中的 OSS 空间，但个人身份引用缺失，请先在 OSS 设置核对并修复引用后重试；未清理身份或 Key');
    return false;
  }
}
